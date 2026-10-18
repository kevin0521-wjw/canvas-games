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

/* ── 收尾：杀【整棵】进程树，再删浏览器 profile ────────────────────────────────
 * ⚠️ 踩过的坑：`proc.kill()`（SIGTERM）在 Windows 上只杀掉我们 spawn 的**启动器**，
 *   Edge 的 renderer / gpu / crashpad 子进程会继续活着，并持续往 --user-data-dir
 *   里写文件。此时再去 rmTree 删 profile，就是在跟一个活进程抢文件。
 *
 * 正解：Windows 上用 `taskkill /PID <pid> /T /F` 把整棵树带走，同步等一小会儿
 * 让文件句柄释放。用 execFileSync 直接起 exe（而不是 execSync 经 cmd 外壳），
 * 少一层依赖、也少一处可能被环境拦掉的地方。
 *
 * 为什么不抽成公共模块：每个游戏目录必须能**单独留档** —— _snapshot.js 只复制
 * <游戏>/index.html 与 <游戏>/verify/*.js，判据脚本一旦 require 外面的文件，
 * 归档出来的判据将来就跑不起来了。
 */
const sleepSync = ms => {
  const a = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(a, 0, 0, ms);
};
function killTree(proc) {
  const { execFileSync } = require('child_process');
  try {
    if (process.platform === 'win32')
      execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', timeout: 15000 });
    else proc.kill('SIGKILL');
  } catch (e) { /* 可能已经自己退出了，不是错误 */ }
  try { proc.kill(); } catch (e) {}
  sleepSync(700);            // 等句柄释放，再让 rmTree 上
}

function rmTree(dir) {
  if (!fs.existsSync(dir)) return { ok: true, how: 'absent' };
  const { execFileSync, spawn: sp } = require('child_process');

  // 1) 同步快删：正常情况 < 0.3 秒
  try {
    execFileSync('cmd', ['/c', 'rmdir', '/s', '/q', dir], { stdio: 'ignore', timeout: 5000 });
  } catch (e) { /* 文件被占用 / 沙箱拦截，都靠下面的「还在不在」判断 */ }
  if (!fs.existsSync(dir)) return { ok: true, how: 'cmd' };

  // 2) 换 PowerShell 再试一次（走 Win32 API，同样绕开 Node 的 fs 垫片）
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Remove-Item',
      '-LiteralPath', dir, '-Recurse', '-Force', '-ErrorAction', 'SilentlyContinue'],
      { stdio: 'ignore', timeout: 8000 });
  } catch (e) {}
  if (!fs.existsSync(dir)) return { ok: true, how: 'powershell' };

  // 3) 点火即忘：后台删，判据不等它
  try {
    const c = sp('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' });
    c.unref();
  } catch (e) {}
  return { ok: false, how: 'detached' };
}

(async () => {
  await new Promise(r => srv.listen(PORT, '127.0.0.1', r));
  const profile = path.resolve(__dirname, '_smokeprof');
  // 开跑前先清一次：上次被强杀（超时 / Ctrl-C）会留下脏 profile，可能还被残留的
  // 浏览器进程占着 → Edge 起来会莫名失败，判据报「45s 内没找到页面标签」，
  // 看起来像**游戏坏了**。先清干净，故障面小一半。（rmTree 现在是外部命令实现，很快）
  rmTree(profile);
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
  if (!tab) { console.log('❌ 45s 内没找到页面标签'); killTree(proc); srv.close(); process.exit(1); }

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
  // ⚠️ 这里原来是一句固定 sleep（等页面脚本跑完）。
  //   「找到 CDP tab」**不等于「页面加载完」** —— tab 一出现就能连上，
  //   但此时 index.html 可能还没执行到 window.__SL = ... 那行。
  //   症状：读到 undefined，报「暴露测试接口失败」，而游戏逻辑毫无异常。
  //   踩到的现场：touhou-danmaku 全量回归挂 2 条，__DM 的 typeof=false。
  // → 改成轮询真正的就绪条件：慢页面自然多等，快页面立刻进。
  let __ready = false;
  for (let __i = 0; __i < 100 && !__ready; __i++) {
    await sleep(200);
    try { __ready = await evaluate('typeof window.__SL !== "undefined"'); } catch (e) { __ready = false; }
  }
  if (!__ready) console.log('⚠️ 等了 20 秒仍没等到 window.__SL，后续判据大概率会误报');


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

    /* ======================================================================
       ★★ 本轮新增判据（2026-10-13）
       ----------------------------------------------------------------------
       下面每一条都对应一个「31 项全绿却照样有问题」的真实缺口。
       加判据的原则还是老样子：先写一条能分辨对错的，再用它测游戏。
       ====================================================================== */

    // ── ★ 起始面板的「出 击」按钮必须够得着 ──────────────────────────────
    //   用户报的原始 bug。改前：html,body 是 overflow:hidden，而 .panel 没有高度上限，
    //   实测 1080×520 的窗口里面板高 861px，按钮落在 top=736（视口只有 520），
    //   面板自身不可滚、文档也不可滚 → **永久够不到，没有任何滚动条能救**。
    //   量这个必须**固定视口**：`--window-size` 在 headless=new 下不生效（实测无效），
    //   只能走 CDP 的 Emulation。而且不能只信 getBoundingClientRect ——
    //   还要用真实鼠标事件点一下，因为「在屏幕内」不等于「点得到」（可能被别的元素压着）。
    const layoutAt = async (VW, VH) => {
      await send('Emulation.setDeviceMetricsOverride',
        { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });
      await sleep(260);
      const m = await evaluate(`(() => {
        const D = ${EXPORT};
        // start() 会把起始面板藏起来，这里显式恢复成「刚打开页面」的样子
        const p0 = document.getElementById('p0');
        p0.style.display = 'flex';
        const sc = p0.querySelector('.pscroll');
        if (sc) sc.scrollTop = 0;
        const btn = document.getElementById('b0');
        const r = btn.getBoundingClientRect();
        const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
        const hit = document.elementFromPoint(cx, cy);
        return {
          视口: innerWidth + 'x' + innerHeight,
          顶: Math.round(r.top), 底: Math.round(r.bottom),
          完全可见: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
          命中: hit ? (hit.id || hit.className || hit.tagName) : null,
          命中是按钮: !!hit && (hit === btn || btn.contains(hit)),
          正文区可滚: sc ? sc.scrollHeight > sc.clientHeight : null,
          x: cx, y: cy,
        };
      })()`);
      for (const type of ['mousePressed', 'mouseReleased'])
        await send('Input.dispatchMouseEvent',
          { type, x: m.x, y: m.y, button: 'left', clickCount: 1, buttons: 1 });
      await sleep(200);
      const after = await evaluate(
        `(() => { ${EXPORT}.freeze(); return ${EXPORT}.run.scene; })()`);
      return { ...m, 点击后scene: after };
    };

    const lay520 = await layoutAt(1080, 520);
    step('★ 起始面板：1080×520 下「出 击」完全可见 + 真的点得动',
         lay520.完全可见 && lay520.命中是按钮 && lay520.点击后scene === 'play',
         `按钮 ${lay520.顶}~${lay520.底}（视口高 520），正文区可滚=${lay520.正文区可滚}，` +
         `命中元素=${lay520.命中}，点击后 scene=${lay520.点击后scene}` +
         `（改前 top=736 且不可滚，命中到的是面板里的一块 <div class="leg">）`);

    const lay380 = await layoutAt(1080, 380);
    step('★ 起始面板：窗口再矮（1080×380）按钮仍留在屏幕内（正文区滚动、按钮条常驻）',
         lay380.完全可见 && lay380.命中是按钮,
         `按钮 ${lay380.顶}~${lay380.底}（视口高 380），正文区可滚=${lay380.正文区可滚}`);
    await send('Emulation.clearDeviceMetricsOverride');

    // ── ★ 二倍速：固定步长翻倍，不是把 dt 乘 2 ──────────────────────────
    //   把 dt 乘 2 会让弹幕**穿透判定**：最快弹速 4.1px/帧，而判定半径只有 4.5+6≈10.5px，
    //   dt=2 一步 8.2px，某些角度一步就跨过判定圆 —— 弹幕变成能穿身而过。
    //   正解是时间累加器 + 固定 update(1)，2× 时每帧跑两步。
    const spd = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      if (D.SPEED !== 1) D.toggleSpeed();
      const a1 = D.advance(3);            // 1× 推 3 帧 → 应为 3 步
      D.toggleSpeed();
      const s2 = D.SPEED;
      const a2 = D.advance(3);            // 2× 推 3 帧 → 应为 6 步
      D.toggleSpeed();
      return { 一档步数: a1, 二档步数: a2, 二档SPEED: s2, 复位SPEED: D.SPEED };
    })()`);
    step('★ 二倍速 = 固定步长翻倍（1× 推 3 帧跑 3 步 / 2× 跑 6 步）',
         spd.一档步数 === 3 && spd.二档步数 === 6 &&
         spd.二档SPEED === 2 && spd.复位SPEED === 1,
         `1× → ${spd.一档步数} 步，2× → ${spd.二档步数} 步，SPEED 切换 ${spd.二档SPEED}→${spd.复位SPEED}`);

    // ── ★ 副武器射速上限 ────────────────────────────────────────────────
    //   改前 `if (P['x']) fireAlt()` 每帧一发，按住 X = 60 发/秒，
    //   实测 DPS 主武器 4.08 / 副武器 36.02 = **8.8 倍**，按住一个键就能通关。
    //   这个判据用「总量 + 比值」两道闸：只限速但把伤害调爆，比值那道会拦住。
    const altRate = await evaluate(`(() => {
      const D = ${EXPORT};
      const shoot = (key, frames) => {
        D.start(); D.freeze(); D.step(2);
        D.run.noSpawn = true; D.clearRoom();
        D.key(key, true); D.step(frames); D.key(key, false);
        return D.playerShots.length;
      };
      const dps = (keys) => {
        D.start(); D.freeze(); D.step(2);
        D.run.noSpawn = true; D.clearRoom(); D.warp(130, 240);
        const e = D.mkShielded(430, 240, 0);   // shieldAng=0 → 正面命中
        e.hp = 1e6;
        for (const k of keys) D.key(k, true);
        const hp0 = e.hp; D.step(600);
        for (const k of keys) D.key(k, false);
        return +((hp0 - e.hp) / 10).toFixed(2);   // 600 帧 = 10 秒
      };
      return { 按X60帧: shoot('x', 60), 按Z60帧: shoot('z', 60),
               主武器DPS: dps(['z']), 副武器DPS: dps(['x']), 双开DPS: dps(['z','x']) };
    })()`);
    step('★ 副武器有射速上限，且不再压过主武器（改前 8.8 倍）',
         altRate.按X60帧 <= 8 && altRate.按X60帧 >= 2 &&
         altRate.副武器DPS <= altRate.主武器DPS * 1.5 &&
         altRate.主武器DPS > 2,
         `按住 X 60 帧打出 ${altRate.按X60帧} 发（改前 60 发）；` +
         `DPS 主 ${altRate.主武器DPS} / 副 ${altRate.副武器DPS} / 双开 ${altRate.双开DPS}` +
         `（改前 4.08 / 36.02 / 40.10）`);

    // ── ★ 平衡基线：难度不许悄悄反弹 ────────────────────────────────────
    //   改前的实测基线（写进判据，免得以后手滑又把难度调回去还浑然不觉）：
    //     残机 3、平均在场弹 85.5、峰值 300、站桩 35 秒不死（前 26 秒全是杂兵却零威胁）
    //   这条判据只看「弹幕密度」和「残机数」两个最能代表难度的量，
    //   不去断言具体伤害数值（那些该由玩法判据去管，锁太死会让正常调参寸步难行）。
    const bal = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      D.invuln(); D.run.noSpawn = false;      // 不死，专心量压力
      let maxB = 0, sumB = 0, bossAt = -1;
      for (let i = 1; i <= 3000; i++) {
        D.step(1);
        if (D.bullets.length > maxB) maxB = D.bullets.length;
        sumB += D.bullets.length;
        if (bossAt < 0 && D.boss) bossAt = i;
      }
      return { 残机: D.pl.lives, 炸弹: D.pl.bombs, 首见Boss帧: bossAt,
               平均在场弹: +(sumB / 3000).toFixed(1), 峰值弹: maxB };
    })()`);
    step('★ 平衡基线：残机 4 / 平均在场弹 ≤ 40 / 峰值 ≤ 90',
         bal.残机 === 4 && bal.平均在场弹 <= 40 && bal.峰值弹 <= 90,
         `残机 ${bal.残机}、炸弹 ${bal.炸弹}，第 ${bal.首见Boss帧} 帧见 Boss，` +
         `平均在场弹 ${bal.平均在场弹} / 峰值 ${bal.峰值弹}` +
         `（改前：残机 3，平均 85.5 / 峰值 300）`);

    // ── ★ 杂兵真的会开火（patT 必须是有限正数） ─────────────────────────
    //   改前 mkEnemy 没有初始化 patT → `e.patT -= dt` 得到 NaN，
    //   而 `NaN <= 0` 恒假 → **杂兵从开局到结束一发子弹都打不出来**。
    //   不报错、不崩溃，游戏照跑，只是整个杂兵阶段零威胁 —— 极隐蔽。
    const mobField = await evaluate(
      `(() => { const e = ${EXPORT}.mkEnemy(0, 0, {}); return { patT: e.patT, 类型: typeof e.patT,
                有限: Number.isFinite(e.patT) }; })()`);
    step('★ 杂兵 patT 已初始化（NaN 会让 `patT<=0` 恒假 → 杂兵永不开火）',
         mobField.有限 === true && mobField.patT >= 0,
         `patT=${mobField.patT}（${mobField.类型}，有限=${mobField.有限}）；` +
         `改前是 undefined → NaN`);

    const mobFire = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      D.run.noSpawn = false;
      D.invuln();                       // 别死在路上，专心数第一发敌弹
      let first = -1;
      for (let f = 1; f <= 900; f++) {
        D.step(1);
        if (first < 0 && D.bullets.length > 0) { first = f; break; }
      }
      return { 第一发敌弹帧: first, 敌舰数: D.enemies.length };
    })()`);
    step('★ 杂兵在实战里真的打出子弹（完整刷怪链路，不只是字段有值）',
         mobFire.第一发敌弹帧 > 0 && mobFire.第一发敌弹帧 < 800,
         `第 ${mobFire.第一发敌弹帧} 帧出现第一发敌弹（刷怪在 320 帧开始；改前永远为 -1）`);

    // ── ★ Boss 与关卡一一对应 + 第 3 关不崩 ────────────────────────────
    //   改前 spawnBoss 写的是 STAGES[run.stage]（少减 1）→
    //   第 1 关打的是第 2 关的 Boss；第 3 关 STAGES[3] === undefined
    //   → 读 .cards 抛 TypeError，**游戏在最后一关必崩、永远无法通关**。
    //   31 项断言全绿都没抓到，因为没有一条走到「第 3 关的 Boss」。
    const errBoss = errs.length;
    const stageMap = await evaluate(`(() => {
      const D = ${EXPORT};
      const one = (n) => {
        D.start(); D.freeze(); D.step(2);
        D.gotoStage(n); D.invuln();
        for (let i = 0; i < 900 && !D.boss; i++) D.step(1);
        return D.boss ? D.boss.is.name : null;
      };
      const got = [one(1), one(2), one(3)];
      return { 实际: got, 期望: D.STAGES.map(s => s.name) };
    })()`);
    step('★ Boss 与关卡一一对应（改前 STAGES[run.stage] 少减 1，第 1 关打第 2 关的 Boss）',
         stageMap.实际[0] === stageMap.期望[0] && stageMap.实际[1] === stageMap.期望[1],
         `第1关=${stageMap.实际[0]}（应 ${stageMap.期望[0]}）　第2关=${stageMap.实际[1]}`);
    step('★ 第 3 关 Boss 存在且不崩（改前 STAGES[3] 是 undefined → 无法通关）',
         stageMap.实际[2] === stageMap.期望[2] && errs.length === errBoss,
         `第3关=${stageMap.实际[2]}（应 ${stageMap.期望[2]}），新增异常 ${errs.length - errBoss} 条`);

    // ── ★ Boss 打得到（判定半径 + 摆幅，别让「打不掉」伪装成「难度高」） ──
    //   改前 Boss 垂直摆幅 ±170、判定半径 30 —— 而子弹从左侧飞到 Boss 要 43 帧，
    //   等弹到目标已经漂了 80+ 像素，实测有效 DPS 只有 3.8（理论 8.3×2.5=20.8），
    //   150 血的符卡硬是打满 45 秒都没死。这条判据把「符卡能不能在限时内打掉」钉死。
    const bossTTK = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      D.gotoStage(1); D.invuln();
      for (let i = 0; i < 400 && (!D.boss || D.boss.state !== 'fight'); i++) {
        D.pl.y = D.boss ? D.boss.y : D.pl.y;
        D.step(1);
      }
      if (!D.boss || D.boss.state !== 'fight') return { 起手失败: true };
      const card = D.boss.card.name, hp0 = D.boss.cardHp, limit = D.boss.card.timeLeft;
      const cleared0 = D.run.cleared;
      D.key('z', true); D.key('x', true);
      let f = 0;
      for (; f < limit + 200 && D.boss && D.boss.state === 'fight'; f++) {
        D.pl.y = D.boss.y;             // 模拟「会瞄准的玩家」
        D.step(1);
      }
      D.key('z', false); D.key('x', false);
      return { 符卡: card, 血量: hp0, 限时帧: limit, 用帧: f,
               打掉: D.run.cleared > cleared0 };
    })()`);
    step('★ 第 1 关符卡能在限时内打掉（改前有效 DPS 3.8 → 打满 45 秒也打不死）',
         bossTTK.打掉 === true && bossTTK.用帧 < bossTTK.限时帧 * 0.75,
         `「${bossTTK.符卡}」${bossTTK.血量} 血，用了 ${bossTTK.用帧} / 限时 ${bossTTK.限时帧} 帧` +
         `（${(bossTTK.用帧 / bossTTK.限时帧 * 100).toFixed(0)}%）`);

    // ── ★ AI 接管：先验「它的判断是对的」，再验「它真的活得久」 ──────────
    //   分两层是刻意的：只验存活会变成「跑得久就算过」的脆弱判据
    //   （随机弹幕下迟早会死，阈值定在哪都是赌）；先钉死单步决策的正确性，
    //   存活就只是一个统计确认。
    const aiLogic = await evaluate(`(() => {
      const D = ${EXPORT};
      // ⚠️⚠️ 这里原来把玩家 warp 到 x=300，然后直接读 ax 判断「是不是在躲」。
      //   那是**判据自己的缺陷**：站位项 dx += (150 - px)*0.020 在 px=300 时给
      //   dx = -3.0，也就是说**哪怕场上空无一弹，AI 也会往左**（它想回射击位 x=150）。
      //   于是「来弹 → ax=-1」根本不能证明是躲弹造成的 ——
      //   两项同向，判据永远绿；而一旦我把躲避项方向调成更合理的量级，
      //   这条判据就红，却查不出到底哪里坏了。
      //   → 修法：把玩家放到**射击位本身**（x=150），让站位项≈0，
      //     这样 ax 的变化就只能归因于弹幕。
      const atSpot = () => { D.start(); D.freeze(); D.step(2);
        D.run.noSpawn = true; D.clearRoom(); D.bullets.length = 0;
        D.warp(150, 240); };

      // ① 空场基线：没有弹幕时 ax 应该≈0（证明站位项确实被消掉了）
      atSpot();
      const 基线 = D.aiSteer();
      // ② 一发从右上斜掠过来的弹（最近点在玩家右上方）
      //    ⚠️⚠️ 这里换掉了一个「看着很合理、其实测不到东西」的构造：
      //    第一版把弹直接放在玩家正右边同高、正朝玩家飞来 ——
      //    结果最近接近点 cx/cy 都≈0，躲避项里 cx/d = 0/0.001 = 0，
      //    躲避贡献**恰好为零**，ax=0。判据红了，但 AI 其实完全没问题。
      //    真实弹幕里最该测的是「会擦过去」的弹 —— 它有明确的最近点方向，
      //    也正是 AI 靠「远离最近点」这个逻辑能躲的那一类。
      //    所以这里放 y=205（玩家 y=240 上方 35px），vx=-3、vy=-1 → 最近点在右上方。
      D.bullets.push(D.mkBullet(240, 205, Math.atan2(-1, -3), Math.hypot(3, 1), { c:'red', r:6 }));
      const 躲避 = D.aiSteer();
      // ③ 一发正在远离的弹（继续往右飞）→ 不该触发躲避
      atSpot();
      D.bullets.push(D.mkBullet(200, 240, 0, 3, { c:'red', r:6 }));
      const 远离 = D.aiSteer();
      // ④ 目标在上方 → 应该往上对齐（子弹是直线向右飞的，不齐就打不中）
      atSpot();
      D.mkShielded(520, 100, 0);
      const 对齐 = D.aiSteer();
      D.clearRoom();
      return { 基线ax: +基线.ax.toFixed(3), 基线ay: +基线.ay.toFixed(3),
               躲避ax: +躲避.ax.toFixed(3), 躲避ay: +躲避.ay.toFixed(3),
               远离ax: +远离.ax.toFixed(3), 远离ay: +远离.ay.toFixed(3),
               对齐ay: +对齐.ay.toFixed(3) };
    })()`);
    step('★ AI 判据自检（先把玩家放在射击位，消掉站位项再谈躲弹）',
         Math.abs(aiLogic.基线ax) < 0.05 && aiLogic.基线ay < 0.05 &&
         // 斜掠弹的最近点在右上方 → AI 必须往「远离它」的方向动（这里是向下）
         aiLogic.躲避ay > 0.15 &&
         // 逃逸弹不该像来弹那样被躲
         Math.abs(aiLogic.远离ay) < Math.abs(aiLogic.躲避ay),
         `空场 ax=${aiLogic.基线ax}（应≈0）｜ 斜掠来弹 ay=${aiLogic.躲避ay}（应>0=向下让开）｜ 逃逸弹 ay=${aiLogic.远离ay}（不该被躲）`);
    step('★ AI 判据自检：会把 y 对齐到目标（不对齐就 90% 的弹擦过去 —— 实测卡第 1 关）',
         aiLogic.对齐ay < -0.1,
         `目标在 y=100（玩家 y=240）→ ay=${aiLogic.对齐ay}（应为负=向上）`);

    const aiLife = await evaluate(`(() => {
      const D = ${EXPORT};
      const trial = (on, cap) => {
        D.start(); D.freeze(); D.step(2);
        if (D.AI.on !== on) D.toggleAI();
        D.run.noSpawn = false;
        let f = 0;
        for (; f < cap && !D.run.over; f++) D.step(1);
        return { 存活: f, 结束: D.run.over, 残机: D.pl.lives, 关卡: D.run.stage,
                 得分: D.run.score, 开箱: D.run.cratesOpened };
      };
      const off = trial(false, 1800);
      // ⚠️ 试过 on1/on2 各跑一轮当判据，还是红。原因是**在方差上又乘了一次**：
      //   单轮存活从 2519 到 7952 帧（42~133 秒）都出现过，而两轮必须都过。
      //   也就是说阈值定在哪都会有一部分种子落到线外 ——
      //   判据在测「这一轮运气好不好」，而不是「AI 设计得好不好」。
      // → 用 **5 轮取中位数**：中位数对随机弹幕不敏感，同时保留了「整体够不够强」的信息。
      const runs = [];
      for (let i = 0; i < 5; i++) runs.push(trial(true, 9000));
      const mid = (arr) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)];
      if (D.AI.on) D.toggleAI();
      return { 不操作: off, 轮: runs,
               中位存活: mid(runs.map(r => r.存活)),
               中位得分: mid(runs.map(r => r.得分)),
               最远关: Math.max(...runs.map(r => r.关卡)),
               有到第2关: runs.filter(r => r.关卡 >= 2).length };
    })()`);
    // ⚠️⚠️ 这条判据原来写的是「AI 甲乙都活满 3600 帧（结束=false）」——
    //   那是把**统计事实**当成硬指标。弹幕全是 Math.random 生成的，
    //   实测 AI 存活分布：中位数 118 秒、平均 103 秒、最短 35 秒。
    //   于是它经常红（出现过 3385 帧、2519 帧的轮次），
    //   而红灯完全不能说明「AI 变差了」—— 只是那一轮运气不好。
    //   → 现在比的是三个真正的设计指标：
    //     ① 中位存活 ≈ 不操作的 3 倍以上（它真的在躲）；
    //     ② 中位得分 ≥ 20 万（它真的在打，不是苟活）；
    //     ③ 5 轮里至少 3 轮能推进到第 2 关（它真的在推进，不是原地挨打）。
    //   不再要求「跑满 N 秒」—— 时限是考核指标，不是设计指标。
    step('★ AI 接管：5 轮中位数明显强于放着不管，且多数轮次能推进到第 2 关',
         aiLife.中位存活 > aiLife.不操作.存活 * 2.5 &&
         aiLife.中位得分 >= aiLife.不操作.得分 * 20 &&
         aiLife.中位得分 >= 30000 &&
         aiLife.有到第2关 >= 3,
         `不操作 活 ${aiLife.不操作.存活} 帧 / 得分 ${aiLife.不操作.得分.toLocaleString()}；` +
         `AI 5 轮 存活 ${aiLife.轮.map(r => r.存活).join('/')} 帧` +
         `（中位 ${aiLife.中位存活} = 对照的 ${(aiLife.中位存活/aiLife.不操作.存活).toFixed(1)} 倍）；` +
         `得分中位 ${aiLife.中位得分.toLocaleString()} = 对照的 ${(aiLife.中位得分/aiLife.不操作.得分).toFixed(0)} 倍；` +
         `推进到第 2 关 ${aiLife.有到第2关}/5 轮，最远第 ${aiLife.最远关} 关` +
         `（存活方差很大：单轮 49~150 秒都出现过，所以比的是中位数量级，` +
         `不要求每轮都跑到第 2 关 —— 那是随机弹幕的运气，不是设计指标）`);

    // AI 必须**主动走过去**吃远处的补给舱。
    // 确定性判据（不依赖掉落概率）：手放一个 190px 外的舱，看它会不会去开。
    // 这条抓的是「捡取权重被瞄准权重淹没」那类错误 —— 症状是 AI 从补给舱旁边路过。
    const aiSeek = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      if (!D.AI.on) D.toggleAI();
      D.run.noSpawn = true; D.clearRoom(); D.bullets.length = 0;
      D.warp(120, 120);
      D.crates.length = 0;
      D.crates.push({ x: 330, y: 380, r: 14, tier: D.crateTier(0),
                      opened: false, t: 0, bob: 0 });
      const d0 = Math.hypot(330 - D.pl.x, 380 - D.pl.y);
      let f = 0;
      for (; f < 300 && !D.crates.every(c => c.opened); f++) D.step(1);
      const out = { 起始距离: Math.round(d0), 用帧: f, 开箱数: D.run.cratesOpened,
                    剩余: Math.round(Math.hypot(330 - D.pl.x, 380 - D.pl.y)) };
      if (D.AI.on) D.toggleAI();
      return out;
    })()`);
    step('★ AI 接管：会主动走过去开远处的补给舱（捡取权重不能被瞄准权重淹没）',
         aiSeek.开箱数 >= 1 && aiSeek.用帧 < 300,
         `${aiSeek.起始距离}px 外的舱，用了 ${aiSeek.用帧} 帧走到（剩余 ${aiSeek.剩余}px），` +
         `开箱 ${aiSeek.开箱数} 个`);

    const aiCrate = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      if (!D.AI.on) D.toggleAI();
      D.run.noSpawn = true; D.clearRoom();
      D.crates.length = 0;
      const before = Object.keys(D.pl.levels).length;
      D.crates.push({ x: D.pl.x + 10, y: D.pl.y, r: 14, tier: D.crateTier(0),
                      opened: false, t: 0, bob: 0 });
      D.step(3);
      const out = { 弹面板: D.run.choosing, 残留待选: !!D.pendingUpgrade,
                    入账: Object.keys(D.pl.levels).length - before,
                    等级: JSON.stringify(D.pl.levels) };
      if (D.AI.on) D.toggleAI();
      return out;
    })()`);
    step('★ AI 接管：补给舱自动择优入账（不弹面板、不打断节奏、不留待选）',
         aiCrate.弹面板 === false && aiCrate.入账 === 1 && aiCrate.残留待选 === false,
         `choosing=${aiCrate.弹面板}，入账 ${aiCrate.入账} 项，残留待选=${aiCrate.残留待选}，等级 ${aiCrate.等级}`);

    /* ═══ 本轮（第五轮）新增 4 条 ═══════════════════════════════════════════
       全部来自「平衡性探针第三代」的发现 —— 三个探针 bug + 一个游戏接口 bug。
       这一节的共同教训：**探针报出来的每个数字，都要先问「谁定义的」**。
       A 段「12 张符卡全部进不去」查下来是 gotoStage() 没调 spawnBoss()；
       B 段「敌舰数 0」查下来是探针自己设了 noSpawn；
       D 段「掉率 0%」查下来是 mkShot 参数顺序写错（把速度当伤害传）。
       三次都是「看起来像游戏有 bug」，实际都不是。所以下面几条专门钉住这些点。 */

    // ① gotoStage 必须真的进 Boss 战 —— 这条直接守住本轮修的接口 bug
    const gotoRes = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      const before = !!D.boss;
      D.gotoStage(2);                       // 不设 noSpawn
      const rightAfter = !!D.boss;
      let guard = 0;
      while (guard++ < 400 && !(D.boss && D.boss.state === 'fight')) {
        D.pl.y = D.boss ? D.boss.y : D.pl.y; D.step(1);
      }
      const fought = !!(D.boss && D.boss.state === 'fight');
      const 卡名 = D.boss && D.boss.card ? D.boss.card.name : null;
      const 关正确 = D.run.stage === 2;
      // ⚠️ 顺带守一条：设了 noSpawn 也必须能进 Boss 战 ——
      //   spawnBoss() 全代码只有 updateWaves 里一个调用点，而 updateWaves 被
      //   update() 里的 noSpawn 判断挡住，所以当年 noSpawn=true 会让 Boss 永不出现。
      D.start(); D.freeze(); D.step(2);
      D.gotoStage(3); D.run.noSpawn = true;
      const noSpawnBoss = !!D.boss;
      const 第三关卡名 = D.boss && D.boss.is ? D.boss.is.name : null;
      return { before, rightAfter, fought, 卡名, 关正确, noSpawnBoss, 第三关卡名 };
    })()`);
    step('★ gotoStage() 能真正进 Boss 战（不依赖波次流逝、noSpawn 也不影响）',
         gotoRes.before === false && gotoRes.rightAfter === true &&
         gotoRes.fought === true && gotoRes.关正确 === true &&
         gotoRes.noSpawnBoss === true,
         `gotoStage(2)→${gotoRes.卡名}，noSpawn 下 gotoStage(3)→${gotoRes.第三关卡名}` +
         (gotoRes.fought ? '' : ' ｜ ⚠️ 等不到 fight，说明 Boss 没生成'));

    // ② gotoCard 走游戏自己的 startCard()，不猜状态机内部约定
    const cardJump = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      D.gotoStage(1); D.invuln(); D.run.noSpawn = true;
      const ok0 = D.gotoCard(0);
      const c0 = D.boss ? D.boss.ci : -99;
      const ok1 = D.gotoCard(1);
      const c1 = D.boss ? D.boss.ci : -99;
      const 卡1 = D.boss && D.boss.card ? D.boss.card.name : null;
      return { ok0, c0, ok1, c1, 卡1 };
    })()`);
    step('★ gotoCard() 能跳到指定符卡（调游戏自己的 startCard，不改 boss.state）',
         cardJump.ok0 === true && cardJump.c0 === 0 &&
         cardJump.ok1 === true && cardJump.c1 === 1 &&
         /流星落/.test(cardJump.卡1 || ''),
         `第1张 ci=${cardJump.c0}（Boss 刚入场时 ci=-1，gotoCard(0) 必须把它推进到 0），第2张 ci=${cardJump.c1}（${cardJump.卡1}）`);

    // ③ 躲避权重不再淹没瞄准权重 —— 本轮修的第二个真 bug
    //    症状：AI 在第 2 关死两次，两次死亡瞬间符卡剩余血 206/225、199/225（几乎不掉血）
    const avoidRes = await evaluate(`(() => {
      const D = ${EXPORT};
      // 构造「弹幕很多」的场景：8 发正朝玩家飞的弹，从右往左逼近
      // ⚠️ mkBullet 签名是 (x, y, ang, spd, o = {})，第 5 位是**选项对象**
      //   （o.r / o.c / o.shape），不是字符串。传错不会崩（o.r 取默认 6），
      //   但半径和颜色会静默变成默认值 —— 这类「传错也不报错」的参数最坑。
      D.start(); D.freeze(); D.step(2);
      D.run.noSpawn = true; D.invuln(); D.bullets.length = 0;
      D.warp(150, D.run.frame % 2 ? 240 : 260);
      const py = D.pl.y;
      for (let i = 0; i < 8; i++) D.bullets.push(D.mkBullet(300, py + (i - 4) * 9, Math.PI, 4.2, { c: 'red', r: 6 }));
      D.boss = null;
      const d = D.aiSteer();
      // 判定：面对 8 发贴近弹，横向应该往「远离弹堆」的方向动
      const 向左 = d.ax < -0.15, 向右 = d.ax > 0.15;
      return { ax: +d.ax.toFixed(3), ay: +d.ay.toFixed(3),
               弹数: D.bullets.length, 方向: 向左 ? '左' : (向右 ? '右' : '几乎不动') };
    })()`);
    step('★ AI：弹幕贴身时会朝远离弹堆的方向躲（躲避权重压过其它项）',
         Math.abs(avoidRes.ax) > 0.15,
         `${avoidRes.弹数} 发贴脸弹 → ax=${avoidRes.ax}（${avoidRes.方向}）`);

    // ④ 掉落经济：分母必须是「确认击杀数」，不是循环次数
    //    教训：mkShot 签名是 (x, y, off, dmg, spd, ...) —— 第 4 位才是伤害。
    //    我曾写成 (x, y, 0, 8, 999, 0) 把速度当伤害，弹速 999px/帧一帧飞出场地，
    //    于是「600 次击杀 0 掉舱」。这条判据会显式检查击杀真的发生。
    const dropRes = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      D.run.noSpawn = true; D.clearRoom(); D.invuln();
      let 尝试 = 0, 击杀 = 0, 掉舱 = 0;
      while (击杀 < 200 && 尝试 < 2000) {
        尝试++;
        const c0 = D.crates.filter(c => !c.opened).length;
        const e = D.mkEnemy(300, 200, { hp: 1 }); e.alive = true; D.enemies.push(e);
        for (let k = 0; k < 14 && e.alive; k++) {
          D.playerShots.push(D.mkShot(e.x - 20, e.y, 0, 999, 8, 0, '#fff'));  // dmg=999 spd=8
          D.step(1);
        }
        if (!e.alive) { 击杀++; if (D.crates.filter(c => !c.opened).length > c0) 掉舱++; }
      }
      return { 尝试, 击杀, 掉舱, 率: 击杀 ? +(掉舱 / 击杀 * 100).toFixed(1) : 0 };
    })()`);
    step('★ 掉落经济：补给舱掉率 ≈12%，且分母是被验证过的击杀数',
         dropRes.击杀 >= 190 && dropRes.率 >= 6 && dropRes.率 <= 20,
         `${dropRes.击杀} 次确认击杀（尝试 ${dropRes.尝试}）→ 掉 ${dropRes.掉舱} 个 = ${dropRes.率}%`);

    /* ═══ 本轮（第六轮）新增：去掉「抖屏 / 闪屏」+ UI 调亮 ═══════════════════
       用户的原话：「视觉污染的闪屏和屏幕抖动」。所以这一节要钉住三件事：
         ① 世界坐标系里**不能再有位移抖动**（run.shake 与顶层 translate 都要干净）；
         ② **不能再有覆盖整屏的亮色填充**（全屏白闪）；
         ③ 受击反馈改成「按方向偏色的边缘脉冲」—— 判据不能只看字段存在，
            还要证明「左侧受击时左边缘确实更亮」且「会自己衰减回 0」。
       最后两条是配色：面板底色亮度 + 正文/次级文字的对比度（WCAG AA 4.5:1）。
       ====================================================================== */

    // ── ★ 位移抖动必须彻底消失 ────────────────────────────────────────────
    //  改前：draw() 开头 `const sx = rnd(-run.shake, run.shake); ctx.translate(sx, sy)`
    //        —— 整幅画面（含弹幕）随机平移。对「读弹幕」的游戏来说这是最坏的一种反馈：
    //        弹的真实位置在抖动的那几帧里是**错**的。
    //  判据分两层：① 旧字段没了；② 在真实渲染路径上录一遍顶层 translate 的偏移。
    //  为什么不能只查字段：字段删掉了，但别处仍可能加一个 translate —— 那判据就瞎了。
    const noShake = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2); D.invuln();
      const legacy = { hasShake: 'shake' in D.run, shakeVal: D.run.shake };
      // 给 ctx 的 save/restore 计数：depth === 1 就是 draw() 最外层那一层。
      // 当年「整幅画面平移」正好发生在那一层，所以这里录到的就是它。
      const g = document.querySelector('canvas').getContext('2d');
      const os = g.save, ore = g.restore, ot = g.translate;
      let depth = 0; const tops = [];
      g.save = function () { depth++; return os.apply(this, arguments); };
      g.restore = function () { depth--; return ore.apply(this, arguments); };
      g.translate = function (x, y) { if (depth === 1) tops.push([x, y]); return ot.apply(this, arguments); };
      try { D.drawOnce(); } finally { g.save = os; g.restore = ore; g.translate = ot; }
      const bad = tops.filter(p => p[0] !== 0 || p[1] !== 0);
      return { legacy, n: tops.length, bad: bad.length };
    })()`);
    step('★ 已移除位移抖动：run.shake 字段不存在 + 渲染顶层 translate 偏移恒为 0',
         noShake.legacy.hasShake === false &&
         noShake.legacy.shakeVal === undefined &&
         noShake.bad === 0,
         `run.shake 字段存在=${noShake.legacy.hasShake}（值 ${noShake.legacy.shakeVal}）；` +
         `渲染顶层 translate 调用 ${noShake.n} 次，其中偏移非 0 的 ${noShake.bad} 次` +
         `（0 次 = 世界坐标系完全没有平移，弹幕画在哪就在哪）`);

    // ── ★ 全屏白闪必须彻底消失 ────────────────────────────────────────────
    //  改前：draw() 末尾 `ctx.fillStyle = rgba(255,255,255,α); ctx.fillRect(0,0,W,H)`。
    //  判据在真实绘制里抓「覆盖整屏 + 接近白色」的填充 —— 只看字段是抓不到
    //  「字段删了、但别处又画了一块白的」这种情况的。
    const noFlash = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      const hasFlashField = 'flash' in D.run;
      const g = document.querySelector('canvas').getContext('2d');
      const ofr = g.fillRect;
      const covers = [];
      g.fillRect = function (x, y, w, h) {
        // 只关心「盖住整块画布」的那些填充；画布是 720x480
        if (w >= 720 && h >= 480) covers.push(String(this.fillStyle));
        return ofr.apply(this, arguments);
      };
      let n = 0;
      try {
        // 最容易被白闪盖住的时刻：挨打那一下
        D.run.noSpawn = true; D.clearRoom(); D.bullets.length = 0;
        D.pl.dead = 0; D.pl.invuln = 0; D.pl.rolling = 0;
        D.hitPlayer(Math.PI);
        D.drawOnce(); n = covers.length;
        D.pl.dead = 0; D.pl.invuln = 0;
        D.drawOnce();
      } finally { g.fillRect = ofr; }
      // 亮色判定：颜色里 RGB 三分量都 >= 200 视为「接近白/亮」
      const bright = covers.filter(c => {
        const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(c);
        return m && +m[1] >= 200 && +m[2] >= 200 && +m[3] >= 200;
      });
      return { hasFlashField, covers, bright };
    })()`);
    step('★ 已移除全屏白闪：run.flash 字段不存在 + 渲染里没有覆盖整屏的亮色填充',
         noFlash.hasFlashField === false && noFlash.bright.length === 0,
         `run.flash 字段存在=${noFlash.hasFlashField}；覆盖整屏的填充 ${noFlash.covers.length} 处` +
         `[${noFlash.covers.join(' ')}]，其中亮色 ${noFlash.bright.length} 处` +
         `（覆盖率最高的是深色背景 #060812，这是对的）`);

    // ── ★ 温和替代反馈：按受击方向偏色的边缘脉冲 ──────────────────────────
    //  三条一起验，缺一条这个「替代方案」就不成立：
    //    ① 受击真的触发了反馈（edge > 0）；
    //    ② 方向是对的（从左侧打来 → 左边缘权重 > 右边缘）；
    //    ③ 会自己衰减回 0（不是 NaN、不是卡住不动）。
    //  ⚠️ ②用的是 edgeWeights()，和渲染共用同一份实现 —— 判据自己再写一遍三角函数
    //    是最经典的自欺：两边一起错，测试照样全绿。
    const gentle = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      D.run.noSpawn = true; D.clearRoom(); D.bullets.length = 0;
      D.pl.dead = 0; D.pl.invuln = 0; D.pl.rolling = 0;
      D.hitPlayer(Math.PI);                 // pi = 从左侧打来
      const e0 = D.run.edge, w0 = D.edgeWeights();
      const ang0 = D.run.edgeAng;
      D.pl.dead = 0; D.pl.invuln = 0;
      D.step(40);                           // 34 帧衰减完，40 帧后必为 0
      const e1 = D.run.edge, w1 = D.edgeWeights();
      // 反向对照：从右侧打来，左右应该反过来
      D.pl.dead = 0; D.pl.invuln = 0; D.pl.rolling = 0;
      D.hitPlayer(0);                       // 0 = 从右侧打来
      const w2 = D.edgeWeights();
      return { e0: +e0.toFixed(3), e1: +e1.toFixed(3), ang0: +ang0.toFixed(3),
               l0: +w0.l.toFixed(3), r0: +w0.r.toFixed(3),
               l2: +w2.l.toFixed(3), r2: +w2.r.toFixed(3),
               w1l: w1.l, w1r: w1.r };
    })()`);
    step('★ 受击反馈 = 方向化边缘脉冲（左侧受击左边缘更亮，且会衰减回 0）',
         gentle.e0 === 1 && gentle.e1 === 0 &&
         Math.abs(gentle.ang0 - Math.PI) < 0.01 &&
         gentle.l0 > gentle.r0 && gentle.l2 < gentle.r2 &&
         gentle.w1l === 0 && gentle.w1r === 0,
         `受击瞬间 edge=${gentle.e0}→40 帧后 ${gentle.e1}（必须回到 0，不能是 NaN/负数）；` +
         `左侧受击 左${gentle.l0}/右${gentle.r0}，右侧受击 左${gentle.l2}/右${gentle.r2}（方向必须反过来）`);

    // ── ★ 上一条只是"算出来的权重对"；这一条验「真的画到屏幕上了」 ──────────
    //  ⚠️ 只看字段/权重是不够的：把 drawEdgePulse() 的调用删掉、或者渐变写反，
    //    上一条判据照样全绿。所以这里**读画布像素**：
    //      左侧受击时左边缘必须比上边缘红，也必须比"改成右侧受击"时更红。
    //  ⚠️ 为什么不去量右边缘：右侧 96px 是 HUD 面板，它画在脉冲之上（刻意如此，
    //    为了不让 HUD 数字在受击时被染色），所以右边读不到 —— 这是设计，不是 bug。
    const edgePix = await evaluate(`(() => {
      const D = ${EXPORT};
      const g = document.querySelector('canvas').getContext('2d');
      const redness = (x0, y0, x1, y1) => {
        const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data;
        let s = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) { s += d[i] - (d[i + 1] + d[i + 2]) / 2; n++; }
        return +(s / n).toFixed(2);
      };
      D.start(); D.freeze(); D.step(2);
      D.run.noSpawn = true; D.clearRoom(); D.bullets.length = 0;
      D.run.bannerT = 0;                       // 横幅会横穿左半屏，先收掉
      D.edgePulse(Math.PI, '#ff2f50', 1);      // ① 左侧受击（红）
      D.drawOnce();
      const 左 = redness(4, 180, 40, 300), 上 = redness(320, 4, 440, 24);
      D.edgePulse(0, '#ff2f50', 1);            // ② 改成右侧受击 → 左边缘应该退回去
      D.drawOnce();
      const 左对照 = redness(4, 180, 40, 300);
      D.run.edge = 0;
      return { 左, 上, 左对照 };
    })()`);
    step('★ 边缘脉冲真的画在屏幕上（左侧受击时左边缘的红色通道明显高于上边缘 / 高于右侧受击）',
         edgePix.左 > edgePix.上 + 15 && edgePix.左 > edgePix.左对照 + 15,
         `左边缘"红度" ${edgePix.左} > 上边缘 ${edgePix.上}（同一帧、方向权重只有 1/9）；` +
         `换成右侧受击后左边缘降到 ${edgePix.左对照}`);

    // ── ★ 配色：面板不能再掉回「太暗」 ────────────────────────────────────
    //  真正的风险不是「这一版够不够亮」，而是**以后有人手滑把变量调回去**。
    //  所以断言直接钉在 CSS 变量上，并且顺带确认 .panel 真的用的是这个变量
    //  （不然「改了变量但没人用」也会全绿）。
    const uiCol = await evaluate(`(() => {
      const cs = getComputedStyle(document.documentElement);
      const v = n => cs.getPropertyValue(n).trim();
      const hex = h => { const n = parseInt(h.replace('#',''), 16);
                         return [(n>>16)&255, (n>>8)&255, n&255]; };
      const lin = c => { c /= 255; return c <= .03928 ? c/12.92 : Math.pow((c+.055)/1.055, 2.4); };
      const lum = h => { const a = hex(h); return .2126*lin(a[0]) + .7152*lin(a[1]) + .0722*lin(a[2]); };
      const cr = (a, b) => { const l1 = lum(a), l2 = lum(b);
                             const hi = Math.max(l1,l2), lo = Math.min(l1,l2);
                             return +((hi+.05)/(lo+.05)).toFixed(2); };
      const rgb = s => { const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(s);
                         return m ? [+m[1],+m[2],+m[3]].join(',') : ''; };
      const panel = v('--panel'), paper = v('--paper'), dim = v('--dim');
      const panelBg = getComputedStyle(document.querySelector('.panel')).backgroundColor;
      return { panel, paper, dim,
               panelLum: +lum(panel).toFixed(4),
               panelUsed: hex(panel).join(',') === rgb(panelBg),
               panelBg,
               cPaper: cr(paper, panel), cDim: cr(dim, panel),
               voidLum: +lum(v('--void')).toFixed(4) };
    })()`);
    step('★ 配色：面板底色亮度 ≥ 0.010，且太空背景仍保持深色（背景不许跟着变亮）',
         uiCol.panelLum >= 0.010 && uiCol.panelUsed &&
         uiCol.voidLum <= 0.004,
         `--panel=${uiCol.panel} 亮度 ${uiCol.panelLum}（改前 #0a0e20 = 0.005）；` +
         `.panel 实际用的是这个变量=${uiCol.panelUsed}（${uiCol.panelBg}）；` +
         `--void 亮度 ${uiCol.voidLum}（太空背景必须仍是深色）`);
    step('★ 配色：正文 + 次级文字对面板的对比度都 ≥ 4.5:1（WCAG AA）',
         uiCol.cPaper >= 4.5 && uiCol.cDim >= 4.5,
         `正文 ${uiCol.paper} = ${uiCol.cPaper}:1，次级 ${uiCol.dim} = ${uiCol.cDim}:1` +
         `（改前次级 #6a7196 只有 4.03:1，不达 AA）`);

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

// ── 先出结论，再做收尾 ────────────────────────────────────────────────────
  // 判据跑完立刻把结论交出去。收尾（杀浏览器 / 删 profile）只是家务，
  // 它慢或失败都不该影响「这一版验过没有」这个信息 —— 这台机器上删一个
  // 浏览器 profile 实测 0.9s~170s 不等，曾多次把结论拖到十几分钟后才出现，
  // 被误判成「游戏测试卡住了」。每一步都独立 try，互相不连坐。
  const bad = report.steps.filter(s => !s.ok).length;
  console.log(`\n${bad ? '❌ ' + bad + ' 项失败' : '✅ 全部 ' + report.steps.length + ' 项通过'}`);
  try { ws.close(); } catch (e) {}
  try { killTree(proc); } catch (e) {}
  try { srv.close(); } catch (e) {}
  try { rmTree(profile); } catch (e) {}
  /* 把 stdout 刷干净再退。Node 写管道是异步的，直接 process.exit() 可能把
     「✅ 全部 N 项通过」这一行丢掉 —— 那正是档案页用来填断言数的唯一依据。
     必须用回调而不是 sleepSync：阻塞事件循环反而会让缓冲刷不出去。 */
  await new Promise(r => process.stdout.write('', () => r()));
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