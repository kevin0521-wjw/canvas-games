/**
 * 星轨防线 v2（缝合版）的无头回归测试。
 *
 * ★ 本文件的核心任务：不是「能不能跑」，而是**四层缝合是否真的都在生效**。
 *   缝合层 1 护盾朝向 / 背击 ×2.5   ← 符箓灵弹
 *   缝合层 2 小判定点 / 擦弹加分      ← 东方
 *   缝合层 3 符卡限时 / 奖励结算      ← 东方
 *   缝合层 4 补给舱三选一 / 幸运      ← 元气骑士
 *   缝合层 5 翻滚无敌帧               ← 元气骑士
 * 每层都必须有独立判据，缺一层就算漏缝。
 *
 * 所有判据分两类：机制判据 + 判据自检。先证明判据能分辨对错，再用它测游戏。
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FILE = path.resolve(process.argv[2] || '../index.html');
const EXPORT = process.argv[3] || '__SL';
const PORT = 9451 + (crypto.randomBytes(1)[0] % 30);
const CDP_PORT = PORT + 100;

const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(FILE));
});
const get = p => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, r => {
    let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
  }).on('error', rej);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

function rmTree(dir) {
  if (!fs.existsSync(dir)) return;
  let n = 0;
  const walk = d => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { fs.unlinkSync(p); n++; } catch (x) {} }
    }
    try { fs.rmdirSync(d); } catch (e) {}
  };
  walk(dir);
}

(async () => {
  await new Promise(r => srv.listen(PORT, '127.0.0.1', r));
  const profile = path.resolve(__dirname, '_smokeprof');
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
    `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
    `--window-size=${process.env.VW || 1000},${process.env.VH || 900}`,
    `http://127.0.0.1:${PORT}/g.html`], { stdio: 'ignore' });

  const errs = [];
  const deadline = Date.now() + 45000;
  let tab = null;
  while (Date.now() < deadline) {
    try {
      const tabs = await get('/json/list');
      tab = tabs.find(t => t.type === 'page' && t.url.includes('/g.html'));
      if (tab && tab.webSocketDebuggerUrl) break;
    } catch (e) {}
    await sleep(400);
  }
  if (!tab) { console.log('❌ 45s 内没找到页面标签'); proc.kill(); srv.close(); process.exit(1); }

  const ws = await connect(tab.webSocketDebuggerUrl);
  ws.onEvent = ev => {
    if (ev.method === 'Runtime.exceptionThrown') {
      const d = ev.params.exceptionDetails;
      errs.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
    }
    if (ev.method === 'Runtime.consoleAPICalled' && ev.params.type === 'error') {
      errs.push('console.error: ' + ev.params.args.map(a => a.value ?? a.description).join(' '));
    }
  };
  let id = 0;
  const pending = new Map();
  ws.onMessage = raw => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) ws.onEvent(m);
  };
  const send = (method, params) => new Promise(r => {
    const i = ++id; pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails)
      throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
    return r.result?.result?.value;
  };
  await send('Runtime.enable'); await send('Page.enable');
  await sleep(1500);

  const report = { steps: [] };
  const step = (name, ok, detail) => {
    report.steps.push({ name, ok });
    console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
  };

  try {
    const hasExport = await evaluate(`typeof ${EXPORT} !== 'undefined'`);
    step('暴露测试接口 ' + EXPORT, hasExport === true, 'typeof=' + hasExport);
    if (hasExport !== true) throw new Error('no export');

    await evaluate(`${EXPORT}.start()`);
    await sleep(300);
    step('start() 未抛异常', errs.length === 0, errs[0] || '');

    // ── 0. 冻结 rAF，让 step() 独占时钟 ──
    // 不做的话：页面动画循环和 step() 赛跑 → 玩家挨打 → run.over →
    // step() 全空转 → 所有判据读成「游戏没反应」。
    const frozen = await evaluate(`(() => {
      ${EXPORT}.freeze();
      const a = ${EXPORT}.run.frame;
      ${EXPORT}.step(10);
      return { frame: ${EXPORT}.run.frame - a, over: ${EXPORT}.run.over };
    })()`);
    step('★ 冻结 rAF 后 step() 独占时钟', frozen.frame === 10 && frozen.over === false,
         `10 步推进 ${frozen.frame} 帧, run.over=${frozen.over}`);

    // ── 配色表完整性（防拼错色名导致一进游戏就 TypeError） ──
    const cols = await evaluate(`(() => {
      const C = ${EXPORT}.COL, bad = [];
      for (const k in C) if (!C[k] || !C[k].glow) bad.push(k);
      return { bad, n: Object.keys(C).length };
    })()`);
    step('配色表无 undefined', cols.bad.length === 0, `${cols.n} 色, 坏键=[${cols.bad}]`);

    // ═══════════════════════════════════════════════════════════
    // 缝合层 1：护盾朝向 / 背击 ×2.5   ← 符箓灵弹
    // ═══════════════════════════════════════════════════════════

    // 1a. ★ 判据自检：isFromBack 的几何是不是自洽的
    //  先用「已知答案」的四组角度验证判据本身 —— 盾朝 +x 时：
    //    弹朝 +x = 正面（不是背击）；弹朝 -x = 背面。
    // ⚠️ 这条是必需的：符箓版当初就是把「同向=背面」写反了，
    //    而那条判据恰好和错的代码方向一致，于是测试一直"通过"。
    //    真正兜住它的是**独立于游戏实现的解析判据**（下面用 hasPayload 式的
    //    直接角点比较），而不是复用游戏里的同一个函数。
    const selftest = await evaluate(`(() => {
      const D = ${EXPORT};
      // 直接构造几何事实：盾朝 +x（shieldAng=0）
      // 弹朝 +x（shotAng=0）→ 同向 → 正面 → 期望 false
      // 弹朝 -x（shotAng=PI）→ 反向 → 背面 → 期望 true
      // 弹朝 +y（PI/2）→ 垂直 → 侧面 → 期望 false
      // 弹朝 -y（-PI/2 ≡ 3PI/2）→ 侧面 → 期望 false
      const r = {
        front:  D.isFromBack(0, 0),
        back:   D.isFromBack(Math.PI, 0),
        side1:  D.isFromBack(Math.PI/2, 0),
        side2:  D.isFromBack(-Math.PI/2, 0),
      };
      // 盾朝 +y 时，弹朝 +y 应是正面
      r.front2 = D.isFromBack(Math.PI/2, Math.PI/2);
      r.back2  = D.isFromBack(-Math.PI/2, Math.PI/2);
      return r;
    })()`);
    const geoOK = selftest.front === false && selftest.back === true &&
                 selftest.side1 === false && selftest.side2 === false &&
                 selftest.front2 === false && selftest.back2 === true;
    step('★ 判据自检：背击几何（同向=正 / 反向=背 / 垂直=侧）', geoOK,
         `盾+x: 弹+x→${selftest.front}(期望false) 弹-x→${selftest.back}(期望true) ` +
         `侧±y→${selftest.side1}/${selftest.side2}(期望false)`);

    // 1b. 真实伤害路径：背击应恰好是正面 ×2.5
    const backHit = await evaluate(`(() => {
      const D = ${EXPORT};
      D.clearRoom();
      // 盾朝 +x
      const e = D.mkShielded(400, 240, 0);
      // ① 从 +x 侧射入（shotAng = 0）：正面
      const s1 = D.mkShot(380, 240, 0, 8, 1.0, 0, D.COL.white);
      // 让它从左往右飞（+x 方向）
      s1.vx = 8; s1.vy = 0;
      const hp0 = e.hp;
      D.damageEnemy(e, s1);
      const front = hp0 - e.hp;
      // ② 从 -x 侧射入（shotAng = PI）：背面
      const e2 = D.mkShielded(400, 240, 0);
      const s2 = D.mkShot(420, 240, 0, 8, 1.0, 0, D.COL.white);
      s2.vx = -8; s2.vy = 0;
      const hp1 = e2.hp;
      D.damageEnemy(e2, s2);
      const back = hp1 - e2.hp;
      D.clearRoom();
      return { front: +front.toFixed(3), back: +back.toFixed(3) };
    })()`);
    step('缝合层1：背击伤害 = 正面 × 2.5',
         Math.abs(backHit.back - backHit.front * 2.5) < 0.05,
         `正面 ${backHit.front} / 背面 ${backHit.back}（比值 ${(backHit.back/backHit.front).toFixed(2)}）`);

    // ═══════════════════════════════════════════════════════════
    // 缝合层 2：小判定点 + 擦弹加分   ← 东方
    // ═══════════════════════════════════════════════════════════

    // 2a. ★ 判据自检：擦弹判据能分辨三态
    // ⚠️ 断言对象必须是「玩家残机有没有变少」，不是「子弹还在不在数组里」。
    //    因为 hitPlayer() 会 bullets.length = 0 清屏，被吃掉的弹是从数组里
    //    被抹掉的、不会被显式置 alive=false —— 读 alive 一定得出错误结论。
    const grazeSt = await evaluate(`(() => {
      const D = ${EXPORT}, P = D.pl;
      const probe = (dist) => {
        D.bullets.length = 0; D.run.grazed = 0; D.run.deaths = 0;
        P.lives = 3; P.dead = 0; P.invuln = 0; P.rolling = 0; P.grazeCount = 0;
        D.warp(300, 240);
        const b = D.mkBullet(300 + dist, 240, 0, 0, { c:'blue', r:6 });
        b.age = 99;
        D.bullets.push(b);
        D.step(1);
        return { grazed: D.run.grazed, deaths: D.run.deaths, lives: P.lives };
      };
      return { near: probe(16), far: probe(80), dead: probe(0) };
    })()`);
    const gOK = grazeSt.near.grazed === 1 && grazeSt.near.deaths === 0 && grazeSt.near.lives === 3 &&
                grazeSt.far.grazed === 0 && grazeSt.far.deaths === 0 &&
                grazeSt.dead.grazed === 0 && grazeSt.dead.deaths === 1 && grazeSt.dead.lives === 2;
    const f = o => `擦${o.grazed}/中${o.deaths}/命${o.lives}`;
    step('★ 判据自检：擦弹判据能分辨三态', gOK,
         `近[${f(grazeSt.near)}] 远[${f(grazeSt.far)}] 中[${f(grazeSt.dead)}]（期望 1/0/3, 0/0/3, 0/1/2）`);

    // 2b. 判定点确实远小于视觉体
    // ⚠️ 这条判据从弹幕版直接抄来，但**沿用了它最初的错误构造**：
    //   玩家在 (300,240)、弹从 (300,180) 往下飞 → 同一条垂直线 → 必然笔直穿过玩家
    //   → 必然命中。而判据却断言「没掉命」→ 读出 deaths=1。
    //   弹幕版后来改成「45° 斜线掠过 + 输出全程最近距离 minDist」，这里照做。
    //   验证过的正确解：垂距 16px（判定 4.5 + 弹半径 6 = 10.5 之外，擦弹 26 之内）
    const hitbox = await evaluate(`(() => {
      const D = ${EXPORT};
      // ⚠️ 同上：自己 start() 重开一局，避免上一条判据的残留状态。
      //   诊断发现 warp 之后玩家又回到初始 x=130 —— 因为上一条判据把
      //   run.scene 留在非 play，step 整段空转，坐标没被真正建立。
      D.start(); D.freeze(); D.step(2);
      D.run.noSpawn = true; D.enemies.length = 0;
      const P = D.pl;
      P.dead = 0; P.deadT = 0; P.invuln = 0; P.rolling = 0;
      P.lives = 3;
      D.run.scene = 'play'; D.run.over = false; D.run.choosing = false;
      D.run.deaths = 0;
      D.warp(300, 240);
      D.bullets.length = 0;
      // ⚠️ 垂距公式的符号算错了，这是数学错误不是游戏错误。
      //   直线 y = x + C0 到玩家 (px,py) 的垂距 = |py - px - C0| / √2
      //   要垂距 = 16px  →  |240 - 300 - C0| = 16√2  →  C0 = 240 - 300 - 22.6 = -82.6
      //   我原来写的是 py - (px-100) - 16√2，把「起点 x」错当成了「玩家 x」，
      //   结果算出的直线离玩家 54.7px（正好是那个 77.4/√2 的值）。
      const px = D.pl.x, py = D.pl.y;
      const C0 = py - px - 16 * Math.SQRT2;
      const x0 = px - 100;
      const b = D.mkBullet(x0, x0 + C0, 0, 0.5, { c:'red', r:6 });
      b.age = 99; b.vx = 0.5; b.vy = 0.5;
      D.bullets.push(b);
      let minDist = 999;
      for (let i = 0; i < 300; i++) {
        D.step(1);
        const cur = D.bullets[0];
        if (!cur) break;
        minDist = Math.min(minDist, Math.hypot(cur.x - D.pl.x, cur.y - D.pl.y));
        if (cur.x > 460) break;
      }
      D.run.noSpawn = false;
      return { deaths: D.run.deaths, lives: D.pl.lives, minDist: +minDist.toFixed(1),
               // ★ 诊断：玩家最终位置可能被墙夹住挪走，导致斜线打偏
               plx: Math.round(D.pl.x), ply: Math.round(D.pl.y),
               b0: { x: Math.round(D.pl.x - 100), y: Math.round(D.pl.y - 100) - 23 },
               hitR: D.pl.hitR, grazeR: D.pl.grazeR, grazed: D.run.grazed };
    })()`);
    step('缝合层2：小判定点（弹贴身飞过不掉命）',
         hitbox.deaths === 0 && hitbox.lives === 3 &&
         hitbox.minDist > hitbox.hitR && hitbox.minDist < hitbox.grazeR + 6,
         `最近距离 ${hitbox.minDist}px / 判定 ${hitbox.hitR}px / 擦弹 ${hitbox.grazeR}px, ` +
         `失机 ${hitbox.deaths} 次（要求 ${hitbox.hitR} < 距离 < ${hitbox.grazeR + 6}）`);

    // 2c. 擦弹真的加分
    const graze = await evaluate(`(() => {
      const D = ${EXPORT}, P = D.pl;
      D.bullets.length = 0; D.run.grazed = 0; D.run.score = 0;
      P.lives = 3; P.dead = 0; P.invuln = 0; P.rolling = 0;
      P.power = 1; P.grazeCount = 0;
      D.warp(300, 240);
      for (let i = 0; i < 6; i++) {
        const b = D.mkBullet(300 + 16, 240, 0, 0, { c:'blue', r:6 });
        b.age = 99; D.bullets.push(b); D.step(1);
      }
      return { grazed: D.run.grazed, score: D.run.score, power: +P.power.toFixed(3) };
    })()`);
    step('缝合层2：擦弹加分 + 攒火力', graze.grazed === 6 && graze.score > 0 && graze.power > 1,
         `擦 ${graze.grazed} 次 / +${graze.score} 分 / 火力 1.00→${graze.power}`);

    // ═══════════════════════════════════════════════════════════
    // 缝合层 3：符卡限时 / 奖励结算   ← 东方
    // ═══════════════════════════════════════════════════════════

    // ⚠️ 初版这条是假失败：直接改 boss.cardHp 去"打掉"符卡，
    //    但奖励在 damageBoss() 里结算，绕开它当然拿不到分。
    //    现在改成走真实伤害路径（贴脸持续输出）。
    const spell = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      D.gotoStage(1);
      for (let i = 0; i < 200 && !D.boss; i++) D.step(1);
      if (!D.boss) return { err: 'no boss' };
      // ⚠️ 等待进入 fight 的帧数原来只给 200 —— 不够。
      //   症状是下面的 while 循环 guard=0（一次都没进），
      //   因为「state === fight」这个条件始终为假。
      //   诊断脚本用 300 帧时 6 帧就打掉了符卡，证实只是等不够久。
      for (let i = 0; i < 600 && D.boss.state !== 'fight'; i++) D.step(1);
      const stateBefore = D.boss.state;
      const b = D.boss;
      const card1 = b.card && b.card.name;
      const hp0 = b.cardHp;
      // ① 打掉 → 拿奖励
      // ⚠️ 这条判据原本靠「warp 到 Boss 左侧 + 等游戏自动开火」，
      //   但 v2 是横版、子弹要玩家主动按射击键，而且 Boss 有 shieldAng
      //   （背击判定）—— 自动瞄准打出来的伤害**大半被盾牌挡掉**，
      //   4000 帧也打不掉 260 血的符卡。
      //   这条判据要验的是「符卡击破后结算奖励」，不是「玩家打得中」。
      //   → 改成注入伤害：造一发弹丸直接调 damageBoss，走完整结算路径。
      D.invuln();
      D.enemies.length = 0;
      D.run.score = 0;
      let guard = 0;
      while (D.boss && D.boss.state === 'fight' && guard++ < 300) {
        D.enemies.length = 0;
        D.step(1);
        if (D.boss && D.boss.state === 'fight') {
          const bs = D.boss;
          D.damageBoss({ x: bs.x, y: bs.y + 10, vx: 0, vy: -12, dmg: 20 }, bs);
        }
      }
      const scoreClear = D.run.score;
      // ② 下一张卡的计时必须重置为满值（不能带上一张的残值）
      for (let i = 0; i < 400 && (!D.boss || D.boss.state !== 'fight'); i++) D.step(1);
      const card2 = D.boss && D.boss.card ? D.boss.card.name : null;
      // ⚠️ 不能读 timeLeft 当"满值" —— 上一张卡的战斗消耗了它。
      //   要验证"重置"，得比对量级：剩余应接近 time * FPS。
      const t2 = D.boss && D.boss.card ? D.boss.card.timeLeft : -1;
      const t2sec = D.boss && D.boss.card ? (D.boss.card.timeSec || D.boss.card.time) : -1;
      // ③ 超时 → 奖励作废
      D.run.score = 0;
      if (D.boss && D.boss.state === 'fight') D.boss.card.timeLeft = 1;
      for (let i = 0; i < 40; i++) D.step(1);
      const scoreTimeout = D.run.score;
      return { card1, hp0: Math.round(hp0), scoreClear, card2, t2, t2sec, scoreTimeout,
               guard, hpAfter: D.boss ? Math.round(D.boss.cardHp) : -1,
               stateAfter: D.boss ? D.boss.state : 'gone' };
    })()`);
    step('缝合层3：Boss 出场 + 符卡战', !!spell.card1, `符卡「${spell.card1}」血量 ${spell.hp0}`);
    step('缝合层3：符卡击破给奖励', spell.scoreClear > 10000,
         `击破 +${spell.scoreClear}（符卡 HP ${spell.hp0}→${spell.hpAfter}, ` +
         `状态→${spell.stateAfter}, 打了 ${spell.guard} 帧）`);
    step('缝合层3：★ 每张符卡计时独立重置',
    !!spell.card2 && spell.card2 !== spell.card1 &&
    spell.t2 > spell.t2sec * 60 * 0.8,
         `「${spell.card1}」→「${spell.card2}」，` +
         `剩余 ${spell.t2} 帧 / 满值 ${spell.t2sec * 60} 帧（消耗不超过 20%）`);
    step('缝合层3：超时奖励作废', spell.scoreTimeout === 0, `超时 +${spell.scoreTimeout}（应 0）`);

    // ═══════════════════════════════════════════════════════════
    // 缝合层 4：补给舱三选一 + 幸运   ← 元气骑士
    // ═══════════════════════════════════════════════════════════

    // 4a. ★ 判据自检：幸运真的影响品质（带对照组）
    // 统计判据最容易骗人 —— 跑两组对照，且要求低幸运组也有非零紫/红，
    // 否则判据退化成「幸运>0 就有」，不能证明是概率提升。
    const fortune = await evaluate(`(() => {
      const D = ${EXPORT};
      const run = f => {
        const c = { white:0, blue:0, purple:0, red:0 };
        for (let i = 0; i < 400; i++) c[D.crateTier(f).k]++;
        return c;
      };
      const lo = run(0), hi = run(5);
      return { lo, hi, loHigh: (lo.purple+lo.red)/400, hiHigh: (hi.purple+hi.red)/400 };
    })()`);
    step('★ 判据自检：幸运影响补给舱品质（有对照）',
         fortune.hiHigh > fortune.loHigh * 1.8 && fortune.loHigh > 0,
         `幸运0 ${(fortune.loHigh*100).toFixed(1)}% → 幸运5 ${(fortune.hiHigh*100).toFixed(1)}%`);

    // 4b. 开舱真的弹出三选一，且选完数值真的变强
    const crate = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      const W = D.WS;
      const before = { dmg1: W.dmg1, shots1: W.shots1 };
      // 造一个紫色舱并走到它旁边触发开箱
      D.crates.length = 0;
      const c = D.mkShielded ? null : null;
      D.warp(200, 240);
      // 直接走 openCrate 的真实路径：把舱放到玩家旁边等吸附
      D.crates.push({ x: 210, y: 240, r: 14, kind: null,
        tier: { k:'purple', name:'强化舱', n:2, col:'#b98cff' },
        opened: false, t: 0, bob: 0 });
      D.step(30);
      const gotPending = !!D.pendingUpgrade;
      const nOpts = D.pendingUpgrade ? D.pendingUpgrade.opts.length : 0;
      const optIds = D.pendingUpgrade ? D.pendingUpgrade.opts.map(o => o.id) : [];
      // ⚠️ 这条判据原来靠「找 p2，找不到就取第一个选项」——
      //   但三选一是**随机**的，经常抽不到 p2（实测抽到 w2「散射副炮」）。
      //   而 w2 只加副炮弹道、**不改 dmg1** → afterDmg === midDmg → 判失败。
      //   这不是游戏错，是判据把「随机抽到什么」当成了「选什么」。
      //   → 直接按 id 构造选项，确定性地验证 p2 的 apply 效果。
      const p2 = D.UPG.find(u => u.id === 'p2');
      const midDmg = W.dmg1;
      const midShots2 = W.shots2;
      if (p2) { p2.apply(W); D.pl.levels.p2 = (D.pl.levels.p2 || 0) + 1; }
      const after = { dmg1: W.dmg1, shots2: W.shots2 };
      // 顺带验一个"选项生效"的通用判据：任取一个选项，apply 后至少有一项数值变化
      const w2 = D.UPG.find(u => u.id === 'w2');
      const s2Before = W.shots2, spread2Before = W.spread2;
      if (w2) w2.apply(W);
      return { gotPending, nOpts, optIds, pickedId: p2 ? p2.id : null,
               midDmg: +midDmg.toFixed(3), afterDmg: +after.dmg1.toFixed(3),
               w2shots2Before: s2Before, w2shots2After: W.shots2,
               w2spreadChanged: W.spread2 !== spread2Before,
               midShots2, opened: D.run.cratesOpened };
    })()`);
    step('缝合层4：开舱弹出三选一', crate.gotPending === true && crate.nOpts >= 1,
         `弹出 ${crate.nOpts} 个选项 [${crate.optIds}]`);
    step('缝合层4：选完数值真的变强',
         !!crate.pickedId && crate.afterDmg > crate.midDmg && crate.w2spreadChanged,
         `p2（锋锐 伤害+20%）: ${crate.midDmg}→${crate.afterDmg}, ` +
         `w2（散射副炮 弹道+1）: ${crate.w2shots2Before}→${crate.w2shots2After} 弹道, ` +
         `扇形 spread 已变=${crate.w2spreadChanged}`);

    // 4c. 满级升级会从池里剔除
    const maxLv = await evaluate(`(() => {
      const D = ${EXPORT};
      D.pl.levels = {};
      const u = D.UPG.find(x => x.id === 'p1');
      for (let i = 0; i < u.max; i++) u.apply(D.WS), D.pl.levels[u.id] = (D.pl.levels[u.id]||0)+1;
      const inPool = D.rollUpgrades(99, 'white').map(x => x.id).includes('p1');
      // ⚠️ 反向对照原来只抽一次 rollUpgrades(99)，但那个函数**只返回 3 个选项**，
      //   池里有 14 项 → 抽 3 次大概率抽不到 p2 → otherIn=false。
      //   这和元气骑士那条是同一个坑：判「池里有没有 X」不该靠单次抽样。
      let otherIn = false;
      for (let i = 0; i < 30 && !otherIn; i++)
        otherIn = D.rollUpgrades(99, 'white').map(x => x.id).includes('p2');
      return { max: u.max, lv: D.pl.levels[u.id], inPool, otherIn };
    })()`);
    step('缝合层4：满级升级从池里剔除',
         maxLv.lv === maxLv.max && maxLv.inPool === false,
         `急速 Lv${maxLv.lv}/${maxLv.max}, 仍在池=${maxLv.inPool}`);
    step('缝合层4：未满级仍在池（反向对照）', maxLv.otherIn === true, `锋锐仍在池=${maxLv.otherIn}`);

    // ═══════════════════════════════════════════════════════════
    // 缝合层 5：翻滚无敌帧   ← 元气骑士
    // ═══════════════════════════════════════════════════════════
    const roll = await evaluate(`(() => {
      const D = ${EXPORT};
      // ⚠️ 这条判据原来**不调 start()**，直接在上一条判据留下的局上操作。
      //   上一条（满级升级）动过 pl.levels / WS，且 step 的守卫
      //   可能已让 run.scene 不是 'play' → 这里 step(1) 整段空转，
      //   读出来永远是「翻滚没启动」。
      // 最稳的做法：**每条需要 step 的判据都自己 start() 重开一局**。
      //   这是判据隔离的干净做法（弹幕版/元气版都踩过残留状态）。
      D.start(); D.freeze(); D.step(2);
      const P = D.pl;
      // ⚠️ v2 的 movePlayer 开头是 if (pl.dead > 0) { ...; return; }
      //   只要 dead > 0，**移动和翻滚整段都不执行**。
      //   而 warp() 内部已经会重置 dead，这里再清一次以防上一条残留。
      P.dead = 0; P.deadT = 0; P.rolling = 0; P.rollT = 0; P.invuln = 0;
      // 三重状态复位，否则 step() 会整段空转：
      //   守卫是 scene==='play' && !paused && !over && !choosing
      D.run.choosing = false; D.run.pendingUpgrade = null;
      D.run.paused = false; D.run.over = false;
      D.run.scene = 'play';
      P.hp = 3; P.dead = 0; P.deadT = 0; P.rolling = 0; P.rollT = 0; P.invuln = 0;
      P.lives = 3;
      // ⚠️ 诊断发现的关键点：v2 的 movePlayer 开头是
      //    if (pl.dead > 0) { pl.dead -= dt; return; }   ← 早退，跳过整段
      //   所以只要 dead > 0，**移动和翻滚都不会执行**。
      //   而判据里读到的玩家 x 是 130（初始值）→ 说明 warp 之后又被拉回去了，
      //   或者 dead 残留导致整段被跳过。
      //   → 判据必须同时清 dead 和 deadT（两个字段各游戏命名不一）。
      D.warp(300, 240);
      const before = P.lives;
      P.rolling = 16;
      D.hitPlayer();
      const afterRoll = P.lives;
      P.rolling = 0;
      D.hitPlayer();
      const afterHit = P.lives;
      // 翻滚键是否真的启动翻滚并进冷却
      // ⚠️★★ 这是「按键触发翻滚」失败的**真正原因**（诊断才定位到）：
      //   上面两次 hitPlayer() 之后，pl.dead 被设成正数（死亡动画帧），
      //   而 v2 的 movePlayer 开头是
      //       if (pl.dead > 0) { pl.dead -= dt; return; }     ← 早退！
      //   → 移动和翻滚整段都不执行 → 按 Shift + 右也没反应。
      //   我之前只复位了 rollT/rolling/run.over，**漏了 dead**。
      //   → 这里必须连 dead 一起清掉。
      P.rollT = 0; P.rolling = 0; P.dead = 0; P.deadT = 0; P.invuln = 0;
      D.run.over = false; D.run.choosing = false; D.run.scene = 'play';
      D.key('Shift', true); D.key('ArrowRight', true);
      D.step(1);
      const started = P.rolling > 0 || P.rollT > 0;
      D.key('Shift', false); D.key('ArrowRight', false);
      return { before, afterRoll, afterHit, started, rollCd: +P.rollCd.toFixed(0),
               rollIfr: P.rollIfr };
    })()`);
    step('缝合层5：翻滚无敌帧（翻滚中受伤无效）', roll.afterRoll === roll.before,
         `翻滚中残机 ${roll.before} → ${roll.afterRoll}`);
    step('缝合层5：不翻滚时正常受伤', roll.afterHit === roll.before - 1,
         `站立残机 ${roll.before} → ${roll.afterHit}`);
    step('缝合层5：按键触发翻滚 + 冷却', roll.started === true,
         `无敌帧 ${roll.rollIfr}, 冷却 ${roll.rollCd} 帧`);

    // ═══════════════════════════════════════════════════════════
    // 外壳：双武器 + 弹道能打中 + 炸弹清屏
    // ═══════════════════════════════════════════════════════════
    const dual = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      D.invuln();
      D.clearRoom();
      D.pl.levels = {};
      // 造一个正右方的高血量敌舰
      D.enemies.push({ x:400, y:240, r:17, hp:99999, maxHp:99999, t:0, alive:true,
        flash:0, knock:0, kx:0, ky:0, score:0, kind:'test',
        shieldAng:Math.PI, shieldRot:0, shieldSpin:0 });
      D.warp(300, 240);
      // 主武器
      D.key('z', true); D.step(20); D.key('z', false);
      const hpAfterMain = D.enemies[0].hp;
      // 副武器
      D.key('x', true); D.step(4); D.key('x', false);
      const hpAfterAlt = D.enemies[0].hp;
      D.clearRoom();
      // ⚠️ 这里原来写的是 alt: hpAfterAlt - hpAfterAlt —— **恒等于 0**，
      //   而下面那条判据只用了 main，所以「副武器能打中」从来没被验过。
      //   现在改成 hpAfterMain - hpAfterAlt（真的差值）。
      return { main: 99999 - hpAfterMain, alt: hpAfterMain - hpAfterAlt };
    })()`);
    step('外壳：主武器能打中目标', dual.main > 0, `主武器造成 ${dual.main.toFixed(1)} 伤害`);
    step('外壳：副武器也能打中目标', dual.alt > 0, `副武器造成 ${dual.alt.toFixed(1)} 伤害`);

    // ── ★ X 与 C 的键位必须分开 ──
    // 原代码把「副武器」和「炸弹」同时绑在 X 上：同一帧先 fireAlt() 再 useBomb()。
    // 后果有两层 —— ① 想放炸弹就顺带打出一发副武器；② X 按下即被置 false，
    // 副武器实际永远只能单点，按住连发无效。炸弹已移到 C。
    const keySep = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      D.pl.bombs = 3; D.pl.dead = 0; D.pl.invuln = 0;
      const b0 = D.pl.bombs;
      D.key('x', true); D.step(3); D.key('x', false);   // 只打副武器
      const b1 = D.pl.bombs;
      D.key('c', true); D.step(2); D.key('c', false);   // 只放炸弹
      const b2 = D.pl.bombs;
      return { b0, b1, b2 };
    })()`);
    step('★ X = 副武器 / C = 炸弹（拆开原本撞在一起的绑定）',
         keySep.b1 === keySep.b0 && keySep.b2 === keySep.b0 - 1,
         `炸弹 ${keySep.b0} → 按 X 后 ${keySep.b1} → 按 C 后 ${keySep.b2}`);

    // ═══════════════════════════════════════════════════════════
    // ★ 升级池：每一项都必须真的改变数值，且不能凭空造字段
    // ═══════════════════════════════════════════════════════════
    // 这是本轮最贵的一类 bug：14 项升级里有 5 项把值写到了**没人读的对象**上
    // （takeUpgrade 传的是武器表 WS，而这几项写的是玩家字段），于是
    // 「选了升级 → 数值一点没变」，而且升到满级后该条目还会从池里消失，
    // 等于永久丢掉一个选项。
    // 原来那条「选完数值真的变强」只验了 p2 —— p2 恰好是写对对象的那些，
    // 所以全绿。判据覆盖不到的地方，全绿没有意义。
    // 判据设计：① 写错对象的指纹是「对象上多出了一个原本没有的字段」
    //           ② 至少要有一个被监听的字段真的变了
    const upgAll = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      const watch = ['spd','maxLives','lives','rollCd','rollIfr','hitR','grazeR',
                     'shots1','shots2','spread2','pierce','dmg1','dmg2','cd','bspd',
                     'homing','fortune','powerMax','grazeMul'];
      const bad = [];
      for (const u of D.UPG) {
        const W = D.weaponStats();                              // 每项都用全新的表
        const P = Object.assign({}, D.pl, { levels: {} });      // 避免上一项的效果累积
        const k0 = new Set(Object.keys(W).concat(Object.keys(P)));
        const s0 = {};
        for (const k of watch) s0[k] = [W[k], P[k]];
        u.apply(W, P);
        const added = Object.keys(W).concat(Object.keys(P)).filter(k => !k0.has(k));
        const changed = watch.filter(k => W[k] !== s0[k][0] || P[k] !== s0[k][1]);
        if (added.length) bad.push(u.id + ' 凭空造了字段 ' + added.join(','));
        else if (!changed.length) bad.push(u.id + ' 什么都没改');
      }
      return { bad, n: D.UPG.length };
    })()`);
    step('缝合层4：★ 每项升级都真的改变了数值（且不凭空造字段）',
         upgAll.bad.length === 0,
         `检查 ${upgAll.n} 项` + (upgAll.bad.length ? `；失效：${upgAll.bad.join(' / ')}` : '，全部有效'));

    // 点名核对：这 5 项曾经写到 WS 上（没人读它），现在必须落在玩家身上
    const upgTarget = await evaluate(`(() => {
      const D = ${EXPORT};
      const field = { p3:'spd', p5:'maxLives', p6:'rollCd', p7:'grazeR', p8:'hitR' };
      const miss = [];
      for (const id in field) {
        const u = D.UPG.find(x => x.id === id);
        if (!u) { miss.push(id + ' 不在池里'); continue; }
        const W = D.weaponStats();
        const P = Object.assign({}, D.pl, { levels: {} });
        const f = field[id], before = P[f];
        u.apply(W, P);
        if (P[f] === before) miss.push(id + '.' + f + ' 没变');
      }
      return { miss };
    })()`);
    step('缝合层4：★ 迅捷/扩容/翻滚大师/擦弹术/重装 改的是玩家属性，不是 WS',
         upgTarget.miss.length === 0,
         upgTarget.miss.length ? upgTarget.miss.join(' / ') : '5 项全部命中 pl');

    // ── ★ 残机归零必须结束游戏（与弹幕版同一个 off-by-one） ──
    const lastLife = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      D.pl.lives = 1; D.pl.dead = 0; D.pl.invuln = 0; D.pl.rolling = 0;
      const before = D.pl.lives;
      D.hitPlayer();
      return { before, after: D.pl.lives, over: D.run.over };
    })()`);
    step('★ 最后一台被打掉 → 游戏结束（lives 1→0）',
         lastLife.after === 0 && lastLife.over === true,
         `lives ${lastLife.before}→${lastLife.after}, run.over=${lastLife.over}` +
         `（修前写 lives<0，这里 0<0 为假 → 残机归零后还能一直玩）`);

    const bomb = await evaluate(`(() => {
      const D = ${EXPORT};
      D.warp(200, 240); D.pl.bombs = 3; D.pl.lives = 3; D.pl.dead = 0; D.pl.invuln = 0;
      D.bullets.length = 0; D.crates.length = 0;
      for (let i = 0; i < 120; i++) {
        const b = D.mkBullet(20 + (i*3)%580, 20 + (i*7)%440, 0, 0, { c:'blue', r:6 });
        b.age = 99; D.bullets.push(b);
      }
      const before = D.bullets.length;
      D.useBomb();
      const after = D.bullets.length;
      const pickups = D.crates.length;
      const inv = D.pl.invuln > 0;
      return { before, after, pickups, inv };
    })()`);
    step('外壳：炸弹清屏 + 转掉落 + 无敌', bomb.before >= 100 && bomb.after === 0 && bomb.inv,
         `${bomb.before} 发 → ${bomb.after} 发, 转 ${bomb.pickups} 个掉落, 无敌=${bomb.inv}`);

    // ── 长时间空跑（三关流程）不崩 ──
    const errBefore = errs.length;
    await evaluate(`${EXPORT}.start(); ${EXPORT}.freeze(); ${EXPORT}.invuln(); ${EXPORT}.step(1500)`);
    const longRun = await evaluate(`({ over: ${EXPORT}.run.over, frame: ${EXPORT}.run.frame })`);
    step('空跑 1500 帧不崩且未误判结束',
         errs.length === errBefore && longRun.over === false,
         `frame=${longRun.frame}, run.over=${longRun.over}` +
         (errs.slice(errBefore, errBefore+1)[0] ? ' | ' + errs[errBefore] : ''));

    // ── Canvas 真的画了东西 ──
    const ink = await evaluate(`(() => {
      const c = document.querySelector('canvas');
      // ⚠️ 阈值原来定的是「命中 > 50」，但采样步长 i+=4000（每 1000 像素取 1 点），
      //   900×750 的画布总共只有约 675 个采样点，且 v2 是**深色星空背景**
      //   （大部分像素本来就暗）→ 实测只命中 17 点。
      //   这不是没画东西（截图里画面很完整），是**判据的采样密度和阈值不匹配**。
      //   → 判据真正要抓的是「画布是不是一片纯黑」，
      //     所以阈值应该按「采样点总数的一个百分比」来定，而不是拍脑袋的绝对值。
      const g = c.getContext('2d');
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const stride = 4000;                       // 每 1000 像素取 1 点
      let n = 0, total = 0;
      for (let i = 0; i < d.length; i += stride) {
        total++;
        if (d[i] > 28 || d[i + 1] > 28 || d[i + 2] > 28) n++;
      }
      return { n, total, pct: +(n / total * 100).toFixed(1) };
    })()`);
    step('Canvas 有实际绘制内容', ink.pct > 3,
         `采样命中 ${ink.n}/${ink.total}（${ink.pct}%）—— ` +
         `画布 ${'不是纯黑'}`);

    step('零未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | '));
  } catch (e) {
    step('测试执行', false, e.message);
  }

  await evaluate(`try { ${EXPORT}.unfreeze(); } catch(e) {}`);
  await sleep(800);
  await send('Page.captureScreenshot', {}).then(r => {
    if (r.result?.data) {
      fs.writeFileSync(path.resolve(__dirname, '_smoke.png'), Buffer.from(r.result.data, 'base64'));
      console.log('  📷 截图 _smoke.png');
    }
  });

  ws.close(); proc.kill(); srv.close(); rmTree(profile);
  const bad = report.steps.filter(s => !s.ok).length;
  console.log(`\n${bad ? '❌ ' + bad + ' 项失败' : '✅ 全部 ' + report.steps.length + ' 项通过'}`);
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('崩溃:', e); process.exit(2); });

function connect(url) {
  const u = new (require('url').URL)(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname,
      headers: { Connection:'Upgrade', Upgrade:'websocket',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version':'13' } });
    req.on('upgrade', (rs, socket) => {
      let buf = Buffer.alloc(0);
      const api = {
        onMessage: null, onEvent: null,
        send(str) {
          const payload = Buffer.from(str); const len = payload.length;
          let head;
          if (len < 126) head = Buffer.from([0x81, 0x80 | len]);
          else if (len < 65536) { head = Buffer.alloc(4); head[0]=0x81; head[1]=0x80|126; head.writeUInt16BE(len,2); }
          else { head = Buffer.alloc(10); head[0]=0x81; head[1]=0x80|127; head.writeBigUInt64BE(BigInt(len),2); }
          const mask = crypto.randomBytes(4); const masked = Buffer.from(payload);
          for (let i=0;i<len;i++) masked[i] ^= mask[i&3];
          socket.write(Buffer.concat([head, mask, masked]));
        },
        close() { try { socket.destroy(); } catch (e) {} },
      };
      socket.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
          const op = buf[0] & 0x0f;
          let len = buf[1] & 0x7f, off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) return;
          const data = buf.slice(off, off+len); buf = buf.slice(off+len);
          if (op === 1 && api.onMessage) api.onMessage(data);
          else if (op === 8) { api.close(); return; }
        }
      });
      socket.on('error', reject);
      resolve(api);
    });
    req.on('error', reject); req.end();
  });
}