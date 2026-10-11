/**
 * 无头冒烟测试：把某个单文件 HTML 游戏塞进真实浏览器（headless Edge + CDP）跑 N 帧，
 * 检查有没有未捕获异常、状态有没有推进、关键机制有没有真的触发。
 *
 * 为什么不用 Node vm + canvas stub：Canvas 的实际绘制路径（渐变、shadowBlur、
 * ellipse 兼容）只有真浏览器能暴露。stub 跑通了不代表浏览器里画得出来。
 *
 * 用法：node verify/smoke.mjs <html路径> [游戏导出名]
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FILE = path.resolve(process.argv[2] || '../index.html');
const EXPORT = process.argv[3] || '__TP';
const PORT = 9311 + (crypto.randomBytes(1)[0] % 40);
const CDP_PORT = PORT + 100;

const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(FILE));
});

function get(pathname) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: CDP_PORT, path: pathname }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * 逐文件删除目录。
 * ⚠️ 这台机器上 fs.rmSync / rm -rf 会失败：
 *    - rmSync 走 WorkBuddy 的 safe-delete 垫片 → 转回收站 → 报
 *      "Error during a `trash` operation: Unknown"
 *    - 整目录 rm 在项目目录内会静默失败、0 文件被删
 * 逐文件删是实测可行的路径。详见 skill: single-file-canvas-game-verify
 */
function rmTree(dir) {
  if (!fs.existsSync(dir)) return { ok: true, n: 0 };
  let n = 0, fail = 0;
  const walk = d => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { fs.unlinkSync(p); n++; } catch (err) { fail++; } }
    }
    try { fs.rmdirSync(d); } catch (e) {}
  };
  walk(dir);
  return { ok: fs.existsSync(dir) === false, n, fail };
}

(async () => {
  await new Promise(r => srv.listen(PORT, '127.0.0.1', r));
  const profile = path.resolve(__dirname, '_smokeprof');
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
    `--remote-debugging-port=${CDP_PORT}`,
    '--user-data-dir=' + profile,
    `--window-size=${process.env.VW || 900},${process.env.VH || 1000}`,
    `http://127.0.0.1:${PORT}/g.html`,
  ], { stdio: 'ignore' });

  const errs = [];
  let ws = null;
  const deadline = Date.now() + 45000;      // 冷启动容忍上限：exe 大、语言包要初始化
  let tab = null;
  while (Date.now() < deadline) {
    try {
      const tabs = await get('/json/list');
      tab = tabs.find(t => t.type === 'page' && t.url.includes('/g.html'));
      if (tab && tab.webSocketDebuggerUrl) break;
    } catch (e) { /* 端口还没起来 */ }
    await sleep(400);
  }
  if (!tab) { console.log('❌ 45s 内没找到页面标签'); proc.kill(); srv.close(); process.exit(1); }

  // 最小 WebSocket 客户端（不引第三方依赖）
  ws = await connect(tab.webSocketDebuggerUrl);
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
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.result?.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
    }
    return r.result?.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await sleep(1400);   // 等首屏脚本跑完

  const report = { errs, steps: [] };
  const step = (name, ok, detail) => {
    report.steps.push({ name, ok, detail });
    console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
  };

  try {
    // 1. 启动
    const hasExport = await evaluate(`typeof ${EXPORT} !== 'undefined'`);
    step('暴露测试接口 ' + EXPORT, hasExport === true, 'typeof=' + hasExport);
    if (hasExport !== true) throw new Error('no export');

    await evaluate(`${EXPORT}.start()`);
    await sleep(300);
    step('start() 未抛异常', errs.length === 0, errs[0] || '');

    // 1b. ★★ 冻结自带动画循环 —— 本项目踩过最贵的坑，四款游戏全中
    //
    // ⚠️ 症状：step(600) 之后 wave 纹丝不动（1->1）、score 全 0，
    //    看起来像「游戏状态机坏了」。
    //    真因：页面自己的 rAF 和测试的 step() 在赛跑 → 玩家在原地挨打
    //    → 掉光残机 → run.over = true → step() 里的 `if (!run.over)` 全不成立
    //    → 600 帧全空转。**游戏代码一点问题都没有，是测试侧有两个时钟。**
    //
    // 我一开始的处理是「把判据放宽」—— 那是在掩盖真因。正确做法是先排除它。
    const frozen = await evaluate(`(() => {
      ${EXPORT}.freeze();
      const hp0 = ${EXPORT}.run.hp, t0 = ${EXPORT}.run.t;
      ${EXPORT}.step(20);
      return { hp0, hp1: ${EXPORT}.run.hp,
               dt: +(${EXPORT}.run.t - t0).toFixed(2),
               over: ${EXPORT}.run.over };
    })()`);
    // ⚠️ 字段名别照抄别的游戏：符箓版是 run.hp（不是 lives）、也没有 run.frame。
    //    第一版写成 run.frame / run.lives → 读出 null / undefined，
    //    输出「20 步推进 null 帧」——判据连被测对象是什么都没搞清，
    //    报出的错最没意义。
    step('★★ 冻结 rAF 后 step() 独占时钟（且玩家不会在测试里被打死）',
         frozen.dt >= 20 && frozen.over === false && frozen.hp1 > 0,
         `20 步推进游戏时间 ${frozen.dt}s, HP ${frozen.hp0}→${frozen.hp1}, run.over=${frozen.over}`);

    // 2. 状态推进 —— ⚠️ 这条判据改过三次，结论值得记：
    //   第 1 版：sleep(2600) 后看 wave 有没有涨。
    //     结果 wave 1->1 判失败。去看代码才发现 waveTimer = max(5.0, 9.5 - wave*0.22)
    //     → 第 1 波要 **9.28 秒**才换波，2.6 秒当然换不了。**是判据等太短。**
    //   第 2 版：改用 step() 推进 600 帧（= 10 秒游戏内时间）。仍然 1->1 失败。
    //     但 10 秒 > 9.28 秒，应该够啊？—— 因为**判据之间没隔离状态**，
    //     上一条判据残留的 run.over / paused 让这 600 帧全空转。
    //   第 4 版：★ 发现了真 bug。第 3 版改成 900 帧后仍然 wave 1->1，
    //     而冻结判据已证明 step 确实在推进 → 不是测试环境问题，是游戏真问题。
    //     读代码找到根因：408 行 `if (waveTimer <= 0 && enemies.length === 0) spawnWave()`，
    //     而重置 waveTimer 的那行**只在 BOSS 被打死时执行**（原 615 行）。
    //     → 普通波次的敌人死光后没人重置计时器 → 波次永远推不进去。
    //     已修：任何敌人被清空都给 1.2 秒喘息再进下一波。
    //
    //   判据也必须跟着改：**玩家站着不动打不掉敌人**，
    //   却要求"900 帧内自动换波" = 要求游戏替玩家通关。
    //   正确做法：模拟玩家清场（主动 kill 敌人），再观察波次是否推进。
    const before = await evaluate(`({wave:${EXPORT}.run.wave, score:${EXPORT}.run.score})`);
    const waveOK = await evaluate(`(() => {
      const R = ${EXPORT}.run;
      R.over = false; R.paused = false;
      // 模拟玩家把当前敌人清掉，重复若干轮，看 wave 是否推进。
      // ⚠️ 顺便把计时器一起输出出来：只报「wave 没动」没法区分
      //   「边沿标志没初始化」/「重置条件恒假」/「每帧重置到死锁」这三种 bug。
      //   上一轮就是只报了 wave 不动，导致我在错误的方向上改了两版。
      const trace = [];
      for (let round = 0; round < 40; round++) {
        R.enemies.forEach(e => { e.hp = 0; e.dead = true; });
        ${EXPORT}.step(80);
        trace.push({ wave: R.wave, enemies: R.enemies.length,
                     timer: +R.waveTimer.toFixed(2), ready: !!R.waveReady });
        if (R.wave > ${before.wave}) break;
      }
      return { wave: R.wave, score: R.score, enemies: R.enemies.length,
               kills: R.kills, over: R.over,
               timer: +R.waveTimer.toFixed(2), ready: !!R.waveReady,
               trace: trace.slice(0, 6) };
    })()`);
    step('状态推进（清场后波次能进下一波）', waveOK.wave > before.wave,
         `wave ${before.wave}→${waveOK.wave}, 击杀 ${waveOK.kills}, ` +
         `场上剩 ${waveOK.enemies} 敌, score ${before.score}→${waveOK.score}` +
         ` | 计时器 ${waveOK.timer} waveReady=${waveOK.ready}` +
         ` | 前几轮: ${JSON.stringify(waveOK.trace)}`);

    // 2b. 开局不该是 BOSS 波。
    //     ⚠️ 这条是被截图抓出来的真 bug：spawnWave 里先 waveDefn(run.wave) 再 run.wave++，
    //        而初始 wave=0 → 0%5===0 → 第一波直接出 BOSS。
    //     「状态推进」那条判据太松，抓不到它，所以这里单独立一条硬判据。
    const firstWave = await evaluate(`(() => {
      ${EXPORT}.run.wave = 0; ${EXPORT}.run.enemies.length = 0; ${EXPORT}.run.waveTimer = 0;
      ${EXPORT}.step(2);
      return { wave: ${EXPORT}.run.wave, boss: ${EXPORT}.run.enemies.some(e => e.boss) };
    })()`);
    step('第 1 波不是 BOSS 波', firstWave.wave === 1 && firstWave.boss === false,
         `wave=${firstWave.wave} boss=${firstWave.boss}`);

    // 2c. 第 5 波必须是 BOSS 波（判据的正向一侧，别只测反例）
    const fifth = await evaluate(`(() => {
      ${EXPORT}.run.wave = 4; ${EXPORT}.run.enemies.length = 0; ${EXPORT}.run.waveTimer = 0;
      ${EXPORT}.step(2);
      return { wave: ${EXPORT}.run.wave, boss: ${EXPORT}.run.enemies.some(e => e.boss) };
    })()`);
    step('第 5 波是 BOSS 波', fifth.wave === 5 && fifth.boss === true,
         `wave=${fifth.wave} boss=${fifth.boss}`);

    // 3. Canvas 真的画了东西（非全黑）
    const ink = await evaluate(`(() => {
      const c = document.querySelector('canvas');
      const g = c.getContext('2d');
      const d = g.getImageData(0,0,c.width,c.height).data;
      let n = 0;
      for (let i=0;i<d.length;i+=4000) if (d[i]>28||d[i+1]>28||d[i+2]>28) n++;
      return n;
    })()`);
    step('Canvas 有实际绘制内容', ink > 50, '采样命中 ' + ink);

    // 4. 玩家输入能改状态
    const mv = await evaluate(`(() => {
      const x0 = ${EXPORT}.run.walkerX;
      ${EXPORT}.key('left', true);  ${EXPORT}.step(30);
      ${EXPORT}.key('left', false); ${EXPORT}.step(5);
      return ${EXPORT}.run.walkerX - x0;
    })()`);
    step('移动输入生效（行者）', mv < -20, 'Δx=' + mv.toFixed(1));

    // 5. 长时间空跑不崩
    await evaluate(`${EXPORT}.step(600)`);
    step('长时间空跑 600 帧', errs.length === 0, errs[0] || '');

    // 5b. 核心机制必须真的发生，而不只是「没崩」。
    //     ⚠️ 这里的判据改过两轮，值得记一下：
    //       第 1 版假设「球一直朝发射方向飞」→ 测出 bounce=0，以为游戏有 bug。
    //       逐帧打印才发现：游戏有个「角度自动回正」机制在把球拽回炮台方向，
    //       所以球根本撞不到墙。**是测试的假设错了，不是游戏错了。**
    //       但顺着这条线查出「回正无时限」确实压掉了多次反弹的战术价值，
    //       于是给回正加了 0.5 秒窗口 —— 那一条是真改进。
    const mech = await evaluate(`(() => {
      const R = ${EXPORT}.run;

      // (1) 反弹：把炮台放到球正上方（wantAng 稳定为正下方），球竖直下��，
      //     会撞到底线被回收；改成朝侧下方，靠左右墙反弹。
      //     简单可靠的做法：直接给球一个朝右的速度，并让炮台在球右边远处，
      //     回正在 0.5s 后几乎不干预，球能飞到右墙。
      R.turretX = 30;
      R.balls.length = 0;
      const b = ${EXPORT}.mkBall(30, 300, 0);
      b.age = 999;                        // 跳过回正窗口，测纯弹道
      R.balls.push(b);
      let bounced = 0, minX = 999, maxX = -1;
      for (let i = 0; i < 200; i++) {
        ${EXPORT}.step(1);
        if (!b.dead) { bounced = Math.max(bounced, b.bounce); minX = Math.min(minX,b.x); maxX = Math.max(maxX,b.x); }
      }
      const bouncedOK = bounced > 0;

      // (2) 落底自动回收：朝下的球应该消失、场上重新出现一颗新球（位置在炮台带）
      //     ⚠️ 这里改过两轮，结论值得记：
      //       第 1 版把球放在 x=260、炮台在 x=200，靠「等 300 帧」判定 ——
      //         结果测出「没回收」。逐帧打印才发现：球在 y≈420 就被顶带反弹了
      //         （bounce=2，vy 已变负），它**根本没走到 784 的底线**，
      //         因为「角度回正」一直在把球往炮台方向拽。
      //       所以那是**测试假设错了**，不是游戏错了。
      //       现在改成：炮台与球同轴、垂直下落的球 —— 回正对垂直方向没有横向牵引，
      //         它一定能在 400 帧内落到底线被回收。
      R.turretX = 260;                       // 与球同轴 → 消除回正的横向牵引
      R.balls.length = 0;
      R.over = false; R.paused = false;      // 隔离：不让上一条判据的状态污染这里
      const d = ${EXPORT}.mkBall(260, 300, Math.PI/2);
      d.age = 999;
      R.balls.push(d);
      ${EXPORT}.step(2);
      const goingDown = d.vy > 0;
      let minY = 999, recycled = false;
      for (let i = 0; i < 400; i++) {
        ${EXPORT}.step(1);
        const live = R.balls[0];
        if (live) {
          minY = Math.min(minY, live.y);
          // 回收后场上是新球（从炮台带顶部 CANVAS_TOP+16 ≈ 124 重新出发）
          if (live !== d && live.y < 200) { recycled = true; break; }
        }
      }

      // (3) 盾向：背面命中伤害应显著高于正面
      //     ⚠️ 这里也踩了坑：球和敌人同坐标 (260,300)，球第一步就移开了，
      //     能不能命中取决于当帧的 run.over/paused 状态。
      //     读出「正面 0 / 背面 0」时第一反应是"背击判定坏了"，
      //     实际上只是**这一步没跑成**。所以先断言一步确实推进了。
      const dmgOf = (vx, vy, dir) => {
        R.enemies.length = 0;
        R.enemies.push({ x:260, y:300, vx:0, vy:0, r:16, hp:9000, maxHp:9000,
          shieldDir:dir, baseDir:dir, shieldRot:0, spin:0, flash:0,
          dead:false, col:'#4a7c6f', fireCd:9999, boss:false });
        R.balls.length = 0;
        const ball = ${EXPORT}.mkBall(260, 300, 0);
        ball.age = 999; ball.vx = vx; ball.vy = vy;
        R.balls.push(ball);
        const hp0 = R.enemies[0].hp;
        R.over = false; R.paused = false;   // 隔离测试环境，别依赖上一条判据的状态
        ${EXPORT}.step(1);
        return hp0 - R.enemies[0].hp;
      };
      // 盾牌法线朝 +x（dir=0）：正面 = 弹丸也朝 +x；背面 = 弹丸朝 -x
      const front = dmgOf( 6, 0, 0);
      const back  = dmgOf(-6, 0, 0);

      return { bouncedOK, bounced, minX:+minX.toFixed(0), maxX:+maxX.toFixed(0),
               goingDown, recycled, minY:+minY.toFixed(0),
               front:+front.toFixed(1), back:+back.toFixed(1) };
    })()`);
    step('金符撞墙反弹', mech.bouncedOK === true,
         `bounce=${mech.bounced}, x ${mech.minX}..${mech.maxX}`);
    step('落底自动回收（球不丢）', mech.goingDown === true && mech.recycled === true,
         `朝下=${mech.goingDown} 已回收=${mech.recycled}（最低到 y=${mech.minY}，底线 784）`);
    step('盾向影响伤害（背 > 正）', mech.back > mech.front * 1.8,
         `正面 ${mech.front} vs 背面 ${mech.back}（应 ≈2.5 倍）`);

    // ── 掉落物：菜单承诺「落到底线会停住，可以先躲完再绕回来捡」──
    //    那就得真的能捡到、且真的加东西。这条链路原来没有任何判据，
    //    而它是这个游戏「路线规划 + 风险回收」的核心循环。
    const loot = await evaluate(`(() => {
      const D = ${EXPORT};
      // ⚠️ run 必须在 start() **之后**取。start() 内部会重建整个 run 对象，
      //   在它之前缓存的引用指向上一局 —— 往旧对象里 push 掉落物，
      //   新局那边当然什么都没有（读出「场上剩余 1 个、上限 6→6」的假失败）。
      //   这和 pl / bullets 的过期引用是同一类坑。
      D.start(); D.freeze(); D.step(2);
      const R = D.run;
      const b0 = { bounce: R.maxBounce, shield: R.shield };
      // 把一枚战符直接摆到行者脚下（就是「已落底停住」的形态），走一步就该被拾取
      R.drops.length = 0;
      R.drops.push({ x: R.walkerX, y: R.walkerY, vy: 0, kind: 'talisman',
                     landed: true, spin: 0, life: 0 });
      D.step(1);
      return { b0, b1: { bounce: R.maxBounce, shield: R.shield },
               leftOnField: R.drops.length };
    })()`);
    step('掉落物靠近即拾取（战符真的加了反弹上限）',
         loot.b1.bounce === loot.b0.bounce + 2 && loot.leftOnField === 0,
         `反弹上限 ${loot.b0.bounce}→${loot.b1.bounce}，场上剩余 ${loot.leftOnField} 个`);

    // ── ★ 掉光残机 → 游戏必须结束 ──
    //    注意 hurt() 只扣血，结束判定在 update() 末尾，所以要再走一帧。
    const died = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      const R = D.run;              // ← 同上：必须在 start() 之后取
      R.hp = 1; R.shield = 0; R.hurtCd = 0; R.over = false;
      const before = R.hp;
      D.hurt(5, 0, 0);
      const midOver = R.over;      // 扣血当帧还不该结束
      D.step(1);
      return { before, after: R.hp, midOver, over: R.over };
    })()`);
    step('★ 掉光残机 → 游戏结束',
         died.after <= 0 && died.midOver === false && died.over === true,
         `hp ${died.before}→${died.after}，run.over ${died.midOver}→${died.over}`);

    // 6. 无未捕获异常
    step('零未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | '));
  } catch (e) {
    step('测试执行', false, e.message);
  }

  await evaluate(`try { ${EXPORT}.unfreeze(); } catch(e) {}`);
  await sleep(700);
  await send('Page.captureScreenshot', {}).then(r => {
    if (r.result?.data) {
      fs.writeFileSync(path.resolve(__dirname, '_smoke.png'), Buffer.from(r.result.data, 'base64'));
      console.log('  📷 截图 _smoke.png');
    }
  });

  ws.close(); proc.kill(); srv.close();
  rmTree(profile);
  const bad = report.steps.filter(s => !s.ok).length;
  console.log(`\n${bad ? '❌ ' + bad + ' 项失败' : '✅ 全部 ' + report.steps.length + ' 项通过'}`);
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('崩溃:', e); process.exit(2); });

// ---- 极简 WebSocket（够用即可，不引第三方包） ----
function connect(url) {
  const http = require('http');
  const u = new (require('url').URL)(url);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13',
      },
    });
    req.on('upgrade', (rs, socket) => {
      let buf = Buffer.alloc(0);
      const handlers = { message: null, close: null };
      const api = {
        onMessage: null, onEvent: null,
        send(str) {
          const payload = Buffer.from(str);
          const len = payload.length;
          let head;
          if (len < 126) head = Buffer.from([0x81, 0x80 | len]);
          else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
          else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
          const mask = crypto.randomBytes(4);
          const masked = Buffer.from(payload);
          for (let i = 0; i < len; i++) masked[i] ^= mask[i & 3];
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
          const data = buf.slice(off, off + len);
          buf = buf.slice(off + len);
          if (op === 1 && api.onMessage) api.onMessage(data);
          else if (op === 8) { api.close(); return; }
        }
      });
      socket.on('error', () => {});
      resolve(api);
    });
    req.on('error', reject);
    req.end();
  });
}
