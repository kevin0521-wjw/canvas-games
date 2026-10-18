/**
 * 弹幕射击游戏的无头回归测试。
 *
 * 复用 talisman-pinball 那套 headless Edge + CDP 框架（_base.js 的复制件），
 * 换成本游戏特有的判据。
 *
 * ⚠️ 本文件的判据分两类，请注意区别：
 *   - 「机制判据」测游戏行为（擦弹加分、小判定点、符卡时限、Bomb 清弹）
 *   - 「判据自检」测判据本身 —— 上一轮教训：判据自己有 bug 时，
 *     报出的错比不报更糟，会让人去修本来没坏的代码。
 *     所以这里先用「已知答案的构造样本」验证判据能分辨对错，再去用它测游戏。
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FILE = path.resolve(process.argv[2] || '../index.html');
const EXPORT = process.argv[3] || '__DM';
const PORT = 9341 + (crypto.randomBytes(1)[0] % 40);
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

/* ── 收尾：杀【整棵】进程树，再删浏览器 profile ────────────────────────────────
 * ⚠️ 踩过的坑：`proc.kill()`（SIGTERM）在 Windows 上只杀掉我们 spawn 的**启动器**，
 *   Edge 的 renderer / gpu / crashpad 子进程会继续活着，并持续往 --user-data-dir
 *   里写文件。此时再去 rmTree 删 profile，就是在跟一个活进程抢文件 ——
 *   实测**卡 5 分钟**都删不完，每次回归都白等这么久。
 *
 * 正解：Windows 上用 `taskkill /PID <pid> /T /F` 把整棵树带走，同步等一小会儿
 * 让文件句柄释放，最后才删目录。
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
  try {
    if (process.platform === 'win32')
      require('child_process').execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' });
    else proc.kill('SIGKILL');
  } catch (e) { /* 进程可能已经自己退出了，不是错误 */ }
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
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
    `--remote-debugging-port=${CDP_PORT}`,
    '--user-data-dir=' + profile,
    `--window-size=${process.env.VW || 900},${process.env.VH || 1000}`,
    `http://127.0.0.1:${PORT}/g.html`,
  ], { stdio: 'ignore' });

  const errs = [];
  const deadline = Date.now() + 45000;
  let tab = null;
  while (Date.now() < deadline) {
    try {
      const tabs = await get('/json/list');
      tab = tabs.find(t => t.type === 'page' && t.url.includes('/g.html'));
      if (tab && tab.webSocketDebuggerUrl) break;
    } catch (e) { /* 端口还没起来 */ }
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
  // ⚠️ 这里原来是一句固定 sleep（等页面脚本跑完）。
  //   「找到 CDP tab」**不等于「页面加载完」** —— tab 一出现就能连上，
  //   但此时 index.html 可能还没执行到 window.__DM = ... 那行。
  //   症状：读到 undefined，报「暴露测试接口失败」，而游戏逻辑毫无异常。
  //   踩到的现场：touhou-danmaku 全量回归挂 2 条，__DM 的 typeof=false。
  // → 改成轮询真正的就绪条件：慢页面自然多等，快页面立刻进。
  let __ready = false;
  for (let __i = 0; __i < 100 && !__ready; __i++) {
    await sleep(200);
    try { __ready = await evaluate('typeof window.__DM !== "undefined"'); } catch (e) { __ready = false; }
  }
  if (!__ready) console.log('⚠️ 等了 20 秒仍没等到 window.__DM，后续判据大概率会误报');


  const report = { errs, steps: [] };
  const step = (name, ok, detail) => {
    report.steps.push({ name, ok, detail });
    console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
  };

  try {
    // ── 0. 暴露接口 ──
    const hasExport = await evaluate(`typeof ${EXPORT} !== 'undefined'`);
    step('暴露测试接口 ' + EXPORT, hasExport === true, 'typeof=' + hasExport);
    if (hasExport !== true) throw new Error('no export');

    await evaluate(`${EXPORT}.start()`);
    await sleep(300);
    step('start() 未抛异常', errs.length === 0, errs[0] || '');

    // ── 0b. ★ 冻结自带动画循环 ──
    // ⚠️ 这条是本文件最重要的前置条件，不做后面全都不准。
    //    页面自己的 rAF 会和 step() 赛跑：玩家原地不动 → 挨打 → 掉光残机
    //    → run.over=true → step() 全空转 → 所有判据都读到「游戏没反应」。
    //    症状极像「游戏有 bug」，但游戏代码毫无问题 —— 是测试侧有两个时钟。
    const frozen = await evaluate(`(() => {
      ${EXPORT}.freeze();
      const a = ${EXPORT}.run.frame;
      ${EXPORT}.step(10);
      return { frame: ${EXPORT}.run.frame - a, scene: ${EXPORT}.run.scene,
               over: ${EXPORT}.run.over, lives: ${EXPORT}.player.lives };
    })()`);
    step('★ 冻结 rAF 后 step() 独占时钟', frozen.frame === 10 && frozen.over === false,
         `10 步推进了 ${frozen.frame} 帧, run.over=${frozen.over}, 残机=${frozen.lives}`);

    // ── 1. 配色表完整性 ──
    // 这条不是走过场：我第一版把 COL 写成 6 个语义色，却在 UI 里用了
    // COL.gold / COL.azure / COL.jade / COL.rose / COL.violet —— 全是 undefined，
    // 一进游戏就 TypeError。判据必须能抓住这类"看起来像颜色其实是拼错名"的错。
    const cols = await evaluate(`(() => {
      const C = ${EXPORT}.COL, bad = [];
      for (const k in C) if (!C[k] || !C[k].glow) bad.push(k);
      // 反向检查：UI 层实际用到的名字
      const need = ['red','blue','green','yellow','purple','white','gold','azure','jade','rose','violet'];
      const missing = need.filter(k => !C[k] || !C[k].glow);
      return { bad, missing, n: Object.keys(C).length };
    })()`);
    step('配色表无 undefined（防拼错色名）',
         cols.bad.length === 0 && cols.missing.length === 0,
         `${cols.n} 色, 坏键=[${cols.bad}], 缺键=[${cols.missing}]`);

    // ── 2. 判据自检：擦弹判据本身能不能分辨"擦到"和"没擦到" ──
    // ⚠️ 关键：如果这条过了，后面的擦弹判据结果才可信；
    //    如果这条挂了，说明是我的判据坏了，不能拿它去指控游戏。
    //
    // ⚠️ 第二版才想明白的读法问题：
    //    初版用「子弹是否 alive」判断有没有被碰到 —— 错的。
    //    hitPlayer() 里第一件事就是 bullets.length = 0（清屏），
    //    被吃掉的弹是从数组里被抹掉的，从没被显式置 alive=false，
    //    所以「中弹」这一档读出来照样是 alive=true。
    //    这不是游戏 bug，是判据读错了对象。
    //    正确的断言对象是「玩家的残机有没有变少」—— 那才是玩家真正关心的事实。
    const selftest = await evaluate(`(() => {
      const D = ${EXPORT}, P = D.player;
      // ⚠️⚠️ 这里绝对不能缓存 Bs = D.bullets！
      //    游戏里每帧都写 bullets = bullets.filter(b => b.alive)
      //    → 每一帧 bullets 都换成一个**新数组对象**。
      //    判据若在闭包里缓存一次引用，后续 push 进的都是孤儿数组，
      //    游戏里的 bullets 压根收不到 → 读出「弹在正中心却没反应」。
      //    实测：第一档 probe 正常（还没 filter 过），第二三档全假失败。
      //    → 每次都重新取 getter，绝不缓存。
      const probe = (dist) => {
        const Bs = D.bullets;              // ← 每次重新取
        Bs.length = 0; D.run.grazed = 0; D.run.deaths = 0;
        // 隔离三件事，否则测出来的"命中"可能根本不是弹幕造成的：
        //   ① 关刷怪 ② 清敌人 ③ 重置 invuln/dead
        D.run.noSpawn = true;
        D.enemies.length = 0;
        P.lives = 3; P.power = 1; P.grazeCount = 0; P.bombs = 3;
        D.warp(200, 400);
        P.invuln = 0; P.dead = 0;
        const b = D.mkBullet(200 + dist, 400, 0, 0, { c:'blue', r:6 });
        b.delay = 0; b.age = 99;
        D.bullets.push(b);                  // ← 用最新引用
        const before = D.bullets.length;
        D.step(1);
        return { grazed: D.run.grazed, hit: D.run.deaths, lives: P.lives,
                 pushed: before, px: +P.x.toFixed(0), py: +P.y.toFixed(0) };
      };
      const near = probe(16);   // 判定圈内 16px → 应擦到、且不扣命
      const far  = probe(80);   // 80px 外 → 完全无交互
      const dead = probe(0);    // 正中心 → 应被命中、且不计擦弹
      D.run.noSpawn = false;
      return { near, far, dead };
    })()`);
    // 三条都验，且互斥：擦到(1/0/3)、无关(0/0/3)、中弹(0/1/2)
    const stOK = selftest.near.grazed === 1 && selftest.near.hit === 0 && selftest.near.lives === 3 &&
                 selftest.far.grazed === 0 && selftest.far.hit === 0 && selftest.far.lives === 3 &&
                 selftest.dead.grazed === 0 && selftest.dead.hit === 1 && selftest.dead.lives === 2;
    const fmt = o => `擦${o.grazed}/中${o.hit}/命${o.lives}`;
    step('★ 判据自检：擦弹判据能分辨三态', stOK,
         `近[${fmt(selftest.near)}] 远[${fmt(selftest.far)}] 中[${fmt(selftest.dead)}]（期望 近[1/0/3] 远[0/0/3] 中[0/1/2]）`);
    if (!stOK) {
      console.log('  ⛔ 判据自检未过 —— 下面的擦弹结论一律不作数，先怀疑判据');
    }

    // ── 3. 小判定点 ──
    // 东方的灵魂：判定点 3.5px，视觉体 ~20px。
    // ⚠️ 这条初版写错了：只断言「弹飞过去了」不够 —— 玩家被打中也照样"飞过去"，
    //    于是它测出 lives=2 却在报告里显得像游戏有问题。
    //    正确判据必须同时断言「飞过去了」AND「没掉命」，两个都要。
    const hitbox = await evaluate(`(() => {
      const D = ${EXPORT}, P = D.player;
      // 同样要隔离刷怪与残留敌人，否则掉命可能不是这颗弹造成的
      D.run.noSpawn = true; D.enemies.length = 0;
      P.lives = 3; P.dead = 0; P.invuln = 0;
      D.run.deaths = 0; D.run.over = false;
      D.warp(200, 400);
      D.bullets.length = 0;
      // ⚠️ 这条判据改了四版才写对。前三版都犯了「构造的轨迹其实没避开判定点」：
      //   第 1-3 版：弹放在玩家**正上方同一条垂直线上** → 必然笔直穿过 → 必然命中，
      //              却断言「没掉命」→ 读出 lives=2，像是小判定点没生效。
      //   第 4 版：改成 45° 斜线，但起点 (140,384) 算错了，
      //              实测最近距离 31.1px —— 比擦弹半径 24 还远，**根本不算擦过**。
      // 现在用解析式算出「刚好在擦弹圈内、判定圈外」的起点：
      //   玩家 (200,400)，弹沿 45° 向右下（vx=vy=0.5）
      //   要让直线 y = x + c 到 (200,400) 的垂距 = 16px（判定 3.5 + 弹半径 6 = 9.5 之外）
      //   |400 - 200 - c| / √2 = 16  →  c = 200 - 16√2 = 177.4
      const C0 = 200 - 16 * Math.SQRT2;
      const b = D.mkBullet(140, 140 + C0, 0, 0.5, { c:'red', r:6 });
      b.age = 99; b.vx = 0.5; b.vy = 0.5;
      D.bullets.push(b);
      let minDist = 999, passed = false;
      // ⚠️ 终点判据也算错过一次：斜线是 y = x + 177.4，
      //   起点 (140, 317)，要让它从玩家右侧掠出去，x 到 300 时 y = 477，
      //   已经在场地内（H=640）但弹会被场地边界回收。
      //   实测 passed=false、minDist=16（擦得刚刚好）——
      //   说明弹确实擦过去了，只是没走到 x=300 就出界。
      //   → 判据改成「弹死了**并且**擦到了」就算过，不强求飞到某个 x。
      for (let i = 0; i < 300; i++) {
        D.step(1);
        if (!b.alive) break;
        minDist = Math.min(minDist, Math.hypot(b.x - D.player.x, b.y - D.player.y));
        if (b.x > 320) { passed = true; break; }
      }
      // 弹自然出界也算"飞过了"—— 关键证据是 minDist 落在擦弹圈内
      passed = minDist < 1000;
      D.run.noSpawn = false;
      return { lives: D.player.lives, deaths: D.run.deaths, passed,
               minDist: +minDist.toFixed(1),
               hitR: D.player.hitR, grazeR: D.player.grazeR,
               grazed: D.run.grazed };
    })()`);
    // 判据三件事：① 弹掠过了 ② 全程没掉命 ③ **确实擦到了**（minDist 落在擦弹圈内）
    step('小判定点：弹贴身飞过不掉命',
         hitbox.passed === true && hitbox.lives === 3 && hitbox.deaths === 0 &&
         hitbox.minDist > hitbox.hitR && hitbox.minDist < hitbox.grazeR + 6,
         `弹掠过=${hitbox.passed} 最近距离=${hitbox.minDist}px ` +
         `残机=${hitbox.lives} 失机=${hitbox.deaths} 擦弹=${hitbox.grazed}次` +
         `（判定 ${hitbox.hitR}px / 擦弹 ${hitbox.grazeR}px，要求 3.5<距离<30）`);

    // ── 4. 擦弹加分并积攒力量 ──
    const graze = await evaluate(`(() => {
      const D = ${EXPORT}, P = D.player;
      D.run.noSpawn = true; D.enemies.length = 0;
      D.bullets.length = 0; D.run.grazed = 0; D.run.score = 0;
      D.run.deaths = 0; D.run.over = false;
      D.warp(200, 400); P.power = 1.0; P.grazeCount = 0;
      P.lives = 3; P.dead = 0; P.invuln = 0;
      for (let i=0;i<6;i++){
        const b = D.mkBullet(200+16, 400, 0, 0, { c:'blue', r:6 });
        b.age = 99; D.bullets.push(b); D.step(1);
      }
      D.run.noSpawn = false;
      return { grazed: D.run.grazed, score: D.run.score, power: +P.power.toFixed(3),
               deaths: D.run.deaths };
    })()`);
    step('擦弹加分 + 积攒力量', graze.grazed === 6 && graze.score > 0 && graze.power > 1.0,
         `擦 ${graze.grazed} 次 / 加 ${graze.score} 分 / 火力 1.00→${graze.power}`);

    // ── 5. 炸弹清弹 + 弹转封币 ──
    const bomb = await evaluate(`(() => {
      const D = ${EXPORT}, P = D.player;
      D.warp(200, 400); P.bombs = 3; P.lives = 3;
      D.run.deaths = 0;
      D.bullets.length = 0; D.items.length = 0;
      const rnd = (a,b) => a + Math.random()*(b-a);
      for (let i=0;i<120;i++) D.bullets.push(D.mkBullet(rnd(0,400), rnd(0,640), 0, 0, {c:'blue',r:6}));
      const before = D.bullets.length;
      D.useBomb();
      const afterClear = D.bullets.length;
      const items = D.items.length;
      D.step(120);   // 让封币飘一会儿
      return { before, afterClear, items, invuln: P.invuln > 0 };
    })()`);
    step('炸弹清屏', bomb.before >= 100 && bomb.afterClear === 0,
         `${bomb.before} 发 → ${bomb.afterClear} 发`);
    step('炸弹清弹后转封币（可回血）', bomb.items > 0,
         `转出 ${bomb.items} 个封币`);
    step('炸弹后有无敌时间', bomb.invuln === true, `invuln=${bomb.invuln}`);

    // ── 6. 受伤扣残机 + 降火力 ──
    const hurt = await evaluate(`(() => {
      const D = ${EXPORT}, P = D.player;
      D.warp(200, 400); P.lives = 3; P.power = 3.0; P.invuln = 0; P.dead = 0;
      D.run.deaths = 0;
      const before = { lives: P.lives, power: P.power };
      D.hitPlayer();
      return { before, after: { lives: P.lives, power: P.power }, deaths: D.run.deaths };
    })()`);
    step('受伤：扣残机 + 火力归零',
         hurt.after.lives === 2 && hurt.after.power === 0 && hurt.deaths === 1,
         `残机 ${hurt.before.lives}→${hurt.after.lives}, 火力 ${hurt.before.power}→${hurt.after.power}`);

    // 6b. ★ 打到「最后一台」也必须结束游戏
    // ⚠️ 这条是被**截图肉眼**抓出来的：HUD 显示「残 0」但游戏还在跑。
    //   真因：hitPlayer() 里写的是 `if (player.lives < 0)`，
    //   而 lives 从 3 减到 0 时 `0 < 0` 为假 → 结束判定不触发。
    //   上面那条「受伤」判据测的是 3→2，所以一直是绿的。
    //   → **只测中间状态、不测边界状态，是这类 bug 的标准藏身处。**
    const last = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      // ⚠️⚠️ 必须在 start() 之后再取 player！
      //    start() 会 newRun() 重建整个 player 对象，
      //    判据若在 start() 之前缓存 player 引用，
      //    握着的就是**上一个局的旧玩家**——
      //    P.lives = 1 设到旧对象，hitPlayer() 改的是新对象 → 读出「1→1」。
      //    这和「数组每帧被 filter 换成新对象」是同一族错误：
      //    **测试侧任何缓存的引用都可能过期。**
      const P = D.player;
      P.lives = 1; P.dead = 0; P.invuln = 0;
      D.run.over = false;
      const before = P.lives;
      D.hitPlayer();                       // 1 → 0，应该立刻结束
      return { before, after: D.player.lives, over: D.run.over };
    })()`);
    step('★ 最后一台被打掉 → 游戏结束（lives 1→0）',
         last.after === 0 && last.over === true,
         `残机 ${last.before}→${last.after}, run.over=${last.over}` +
         `（修前写 lives<0，这里 0<0 为假 → 游戏不结束）`);

    // ── 7. 符卡推进 / 限时 / 奖励 ──
    // ⚠️ 第二版修掉一个假失败：初版是直接改 boss.cardHp 来"打掉"符卡，
    //    但奖励是在 damageBoss() 里结算的，绕开它当然拿不到分 —— 报 +0 是判据错，
    //    不是游戏错。改成真的把伤害打进去，走完整结算路径。
    const spell = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      D.gotoStage(1);
      for (let i=0;i<200 && !D.boss;i++) D.step(1);
      if (!D.boss) return { err: 'no boss' };
      for (let i=0;i<200 && D.boss.state!=='fight';i++) D.step(1);
      const b = D.boss;
      const cardName = b.card && b.card.name;
      const hp0 = b.cardHp;
      // ① 打掉 → 拿奖励
      // ⚠️ 这条判据改了三次，每次踩的坑都不一样，值得都记下来：
      //   第 1 版：直接 boss.cardHp -= 40 → 绕开了 damageBoss()，奖励当然拿不到
      //   第 2 版：warp 到 Boss 下面等它自动打 → **没按 z 键，一发都不发**
      //   第 3 版：按了 z，但 while 条件是 state==='fight'，
      //            而 gotoStage 后可能还停在 declare → **循环一次都不进**（实测 guard=0）
      //   第 4 版：显式先推进到 fight 态，再开打，并把 stateBefore 打出来便于诊断
      //    第 5 版：★ 清场。gotoStage 会生成杂兵，判据 warp 到 Boss 左侧后，
      //            子弹先打中路过的杂兵 → 拿到的是杂兵分（360）而不是符卡奖励。
      //            证据：奖励 +360、符卡剩余 HP 240（一点没掉）、状态已 next。
      //            → 打 Boss 之前必须让场上只剩 Boss。
      //   第 6 版：★ 挖出一个真游戏 bug —— **符卡时限的单位错了**。
      //            timeLeft 每帧减 dt（dt=1 → 每帧减1），而 time:40 是按「秒」写的
      //            → 真实时限只有 40 帧 ≈ 0.67 秒，玩家根本来不及打掉任何符卡。
      //            而 HUD 照着 timeLeft 显示「T 40s」，**数字对得上、真实时长错**。
      //            证据：打了 40 帧 cardHp 还是满的（240），循环被超时打断。
      //            修：startCard() 里把 timeLeft 换算成帧，显示时除回秒。
      D.player.invuln = 99999;
      D.run.score = 0;
      for (let i = 0; i < 300 && D.boss && D.boss.state !== 'fight'; i++) D.step(1);
      const stateBefore = D.boss ? D.boss.state : 'none';
      // ★ 顺带把「时限是不是按秒算」一起取出来
      // ⚠️ 注意：断言本身必须写在模板**外面**。
      //    之前我把 step(...) 写在了 evaluate 的模板字符串里，
      //    而它带反引号的模板字面量 → 提前闭合了外层模板 → 语法炸掉，
      //    而且报错行号指向文件开头，定位极其困难。
      const fullFrames = D.boss ? D.boss.card.timeLeft : -1;
      const fullSec = D.boss ? (D.boss.card.timeSec || D.boss.card.time) : -1;
      D.enemies.length = 0;          // ← 清掉杂兵
      D.shots.length = 0;
      D.run.score = 0;               // ← 清场后再归零
      // ★ 第 7 版：warp 必须放在 step() **之前**。
      //   原来写成「先 step(1) 再 warp(...)」，于是每一帧玩家都是先按旧位置开火、
      //   再被挪走 —— 位置每次都差一帧，6000 帧打出 0 发。
      //   证据：打了 6001 帧、符卡 HP 仍是满的 240。
      //   同时把火力拉满，缩短所需帧数。
      // ★ 第 8 版：站位方向错了。**这是纵版弹幕射击 —— 玩家子弹朝上飞**
      //   （firePlayerShot 里 vy = -cos(a)*sp，a≈0 时 vy≈-13）。
      //   我第 7 版把玩家挪到 Boss **左边** 90px，以为"横向射击"，
      //   结果玩家和 Boss 不在同一条弹道上 → 打了 6001 帧伤害恒为 0，
      //   而 +3120 分全是擦弹分（26 次 ×120）。
      //   → 判据里的站位必须符合**这个游戏的射击方向**，否则测了个寂寞。
      // ★ 第 9 版：还得**预判**。Boss 在 sway 模式下摆幅 ±108px，
      //   而符卡碰撞半径只有 is.r + s.r = 26+4 = 30px；
      //   子弹 13px/帧要飞 8~9 帧才到 —— 玩家每帧跟着 warp 也只是「追着屁股打」，
      //   大量子弹落空。6000 帧只打出 150 伤害（需要 240）就是证据。
      //   修：把玩家放在 Boss **将要到达**的位置（按摆动方程外推 LEAD 帧）。
      // ★ 第 10 版：**放弃模拟真实射击**，改用注入伤害。
      //   预判版反而更差（150 → 116 伤害）。原因很实在：
      //   Boss 摆幅 ±108px、碰撞半径 30px，子弹 13px/帧要飞 7 帧 ——
      //   即便算准了预判量，玩家自己的**摇摆站位**和 Boss 的**加减速**
      //   仍然对不齐。这条判据的目的从来不是"证明玩家打得中"，
      //   而是"证明**打掉符卡后会结算奖励**"。
      //   → 直接调 damageBoss(伤害, x, y)，走真实结算路径。
      //   这样才测的是被测对象（结算逻辑），不是操作精度。
      //   ⚠️ 参数签名要看代码：damageBoss(d, x, y)，不是 damageBoss(s, boss)。
      D.player.invuln = 99999;
      D.enemies.length = 0;
      D.run.score = 0;
      let guard = 0;
      while (D.boss && D.boss.state === 'fight' && guard++ < 200) {
        D.enemies.length = 0;
        D.step(1);
        if (D.boss && D.boss.state === 'fight') D.damageBoss(20, D.boss.x, D.boss.y);
      }
      const scoreAfterClear = D.run.score;
      const hpAfter = D.boss ? +D.boss.cardHp.toFixed(0) : -1;
      const ciAfter = D.boss ? D.boss.ci : -1;
      const stateAfter = D.boss ? D.boss.state : 'gone';

      // ② 下一张卡：计时必须重置为满值
      // ⚠️ 不能读 timeLeft 当"满值"—— 上一张卡的战斗消耗了它。
      //    要验证"重置"，得比对 timeLeft 是否回到 time*FPS 的量级。
      for (let i=0;i<400 && (!D.boss || D.boss.state!=='fight');i++) D.step(1);
      const gotFight = !!(D.boss && D.boss.state==='fight');
      D.run.score = 0;
      const cardName2 = D.boss && D.boss.card ? D.boss.card.name : null;
      const timeLeft2 = D.boss && D.boss.card ? D.boss.card.timeLeft : -1;
      const timeSec2 = D.boss && D.boss.card ? (D.boss.card.timeSec || D.boss.card.time) : -1;
      if (gotFight) D.boss.card.timeLeft = 1;
      for (let i=0;i<40;i++) D.step(1);
      const scoreAfterTimeout = D.run.score;
      return { cardName, hp0: Math.round(hp0), scoreAfterClear, ciAfter, stateAfter,
               gotFight, scoreAfterTimeout, cardName2,
               timeLeft2, timeSec2, hpAfter, guard,
               fullFrames, fullSec, stateBefore };
    })()`);
    // ★ 时限单位断言放在模板外面（见上面注释里的教训）
    step('★ 符卡时限按「秒」换算成帧（不是 40 帧 = 0.67 秒）',
         spell.fullFrames === spell.fullSec * 60,
         `time=${spell.fullSec}s → timeLeft=${spell.fullFrames} 帧` +
         `（= ${(spell.fullFrames / 60).toFixed(1)} 秒）`);
    step('Boss 出场 + 进入符卡战', !!spell.cardName && spell.gotFight === true,
         `符卡「${spell.cardName}」血量 ${spell.hp0}`);
    step('符卡击破给奖励', spell.scoreAfterClear > 10000,
         `击破 +${spell.scoreAfterClear}（剩余 HP ${spell.hpAfter}, 状态→${spell.stateAfter}, ` +
         `打了 ${spell.guard} 帧）`);
    step('★ 每张符卡计时独立重置（不共用残值）',
         !!spell.cardName2 && spell.cardName2 !== spell.cardName &&
         spell.timeLeft2 > spell.timeSec2 * 60 * 0.8,
         `「${spell.cardName}」→「${spell.cardName2}」，` +
         `剩余 ${spell.timeLeft2} 帧 / 满值 ${spell.timeSec2 * 60} 帧` +
         `（消耗不超过 20% 才算真重置）`);
    step('符卡超时奖励作废', spell.scoreAfterTimeout === 0,
         `超时 +${spell.scoreAfterTimeout}（应为 0）`);

    // ── 7.5 四方向移动都生效 ──
    // 提示条原来只写了「← → 移动」，但代码里上下键一直在 KEYS 表里。
    // 这条判据同时守住两件事：① 上下真的能走；② 以后别有人把手写提示
    // 当成规格，把上下键顺手删掉（竖向弹幕游戏不能上下走是致命的）。
    const move = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      D.player.invuln = 99999;          // 空跑期间别掉命
      D.run.noSpawn = true;             // 关掉刷怪：隔离掉「被敌人推着走」
      D.player.x = 240; D.player.y = 460;
      const p0 = { x: D.player.x, y: D.player.y };
      D.key('ArrowRight', true); D.step(20); D.key('ArrowRight', false);
      const p1 = { x: D.player.x, y: D.player.y };
      D.key('ArrowUp', true); D.step(20); D.key('ArrowUp', false);
      const p2 = { x: D.player.x, y: D.player.y };
      D.key('ArrowLeft', true); D.step(20); D.key('ArrowLeft', false);
      const p3 = { x: D.player.x, y: D.player.y };
      D.key('ArrowDown', true); D.step(20); D.key('ArrowDown', false);
      const p4 = { x: D.player.x, y: D.player.y };
      return { right: +(p1.x - p0.x).toFixed(1), up: +(p2.y - p1.y).toFixed(1),
               left: +(p3.x - p2.x).toFixed(1), down: +(p4.y - p3.y).toFixed(1) };
    })()`);
    step('四方向移动都生效（提示条曾只写左右）',
         move.right > 20 && move.up < -20 && move.left < -20 && move.down > 20,
         `→${move.right} ↑${move.up} ←${move.left} ↓${move.down}`);

    // ── 8. 三关都存在且符卡总数对 ──
    const meta = await evaluate(`(() => {
      const S = ${EXPORT}.STAGES;
      return { stages: S.length, cards: S.reduce((a,s)=>a+s.cards.length,0),
               names: S.map(s => s.name + '×' + s.cards.length).join(' / ') };
    })()`);
    step('3 关 / 7 张符卡', meta.stages === 3 && meta.cards === 7,
         `${meta.stages} 关 ${meta.cards} 张：${meta.names}`);

    // ── 9. 长时间空跑（3 关全流程）不崩 ──
    // ⚠️ 先给玩家一个无敌护身：空跑 900 帧期间玩家会挨打，
    //    掉光残机后 run.over=true，后续 step() 全空转 ——
    //    那就测不到「长时间跑」本身了。
    const errBefore = errs.length;
    await evaluate(`${EXPORT}.start(); ${EXPORT}.freeze();
                     ${EXPORT}.player.invuln = 99999; ${EXPORT}.step(900)`);
    const longRun = await evaluate(`({ over: ${EXPORT}.run.over, frame: ${EXPORT}.run.frame })`);
    step('空跑 900 帧不崩且未误判结束', errs.length === errBefore && longRun.over === false,
         `frame=${longRun.frame}, run.over=${longRun.over}` +
         (errs.slice(errBefore, errBefore + 1)[0] ? ' | ' + errs[errBefore] : ''));

    // ── 9.5 ★ 温和反馈：屏幕抖动与全屏白闪已彻底移除 ──
    // ⚠️ 这条不是「锦上添花」。用户的原话是「视觉污染的闪屏和屏幕抖动」——
    //    也就是说这两件事是**需求上要删掉**的。判据必须钉住它们不再回来：
    //    ① run 上不能再有 shake / flash 两个字段（有字段就说明还在用）；
    //    ② 受击必须仍然有可感知的反馈，而且是**分方向**的（左受击→左边缘）。
    const fb = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      if (D.AI.on) D.toggleAI();
      D.run.noSpawn = true; D.enemies.length = 0; D.bullets.length = 0;
      D.player.lives = 3; D.player.invuln = 0; D.player.dead = 0;
      D.warp(200, 400);
      const hasShake = Object.prototype.hasOwnProperty.call(D.run, 'shake');
      const hasFlash = Object.prototype.hasOwnProperty.call(D.run, 'flash');
      // 造一发来自**正左方**的弹打中玩家 → 左边缘该泛红
      const b = D.mkBullet(200 - 6, 400, 0, 0, { c: 'red', r: 6 });
      b.age = 99; b.vx = 0; b.vy = 0;
      D.bullets.push(b);
      D.step(1);
      const e = D.run.edge;
      const out = { hasShake, hasFlash, dir: e ? e.dir : null,
                    amp: e ? +e.amp.toFixed(2) : -1, life: e ? e.life : -1,
                    breath: !!D.run.breath,
                    api: typeof D.edgePulse === 'function' && typeof D.softBreath === 'function',
                    deaths: D.run.deaths, lives: D.player.lives };
      D.run.noSpawn = false;
      return out;
    })()`);
    step('★ 已移除屏幕抖动与全屏白闪（run.shake / run.flash 不复存在）',
         fb.hasShake === false && fb.hasFlash === false && fb.api === true,
         'run.shake=' + fb.hasShake + ' run.flash=' + fb.hasFlash +
         ' 反馈接口=' + fb.api);
    step('受击改为「按方向偏色的边缘脉冲」反馈（不晃不闪）',
         fb.deaths === 1 && fb.dir === 'left' && fb.amp > 0 &&
         fb.life > 0 && fb.life <= 60 && fb.breath === true,
         '左侧受击 → 边缘方向=' + fb.dir + '（期望 left）幅度=' + fb.amp +
         ' 时长=' + fb.life + '帧 色彩呼吸=' + fb.breath);

    // ── 9.6 ★ 弹幕预算：量化「可读、可躲、有通道」 ──
    // 用与 _measure.js 相同的量法：每张符卡跑 10 秒，逐帧记录在场弹数、
    // 生成率，并在活动区网格上做 20 帧前瞻，算「安全格子比例」。
    // 安全率 = 0 的帧等于「玩家无解」—— 弹幕互相把路全封死了。
    const budget = await evaluate(`(() => {
      const D = ${EXPORT};
      const H = D.H, FIELD_W = D.FIELD_W;
      const cardOf = (st, ci) => {
        D.start(); D.freeze(); D.step(2);
        D.gotoStage(st);
        for (let i = 0; i < 900 && !D.boss; i++) D.step(1);
        if (!D.boss) return null;
        for (let i = 0; i < 900 && D.boss && D.boss.state !== 'fight'; i++) D.step(1);
        let g = 0;
        while (D.boss && D.boss.ci < ci && g++ < 30) {
          D.boss.state = 'next'; D.boss.stateT = 999; D.step(1);
          for (let i = 0; i < 900 && D.boss && D.boss.state !== 'fight'; i++) D.step(1);
        }
        return (D.boss && D.boss.state === 'fight') ? D.boss : null;
      };
      const cards = [];
      for (let st = 1; st <= D.STAGES.length; st++) {
        for (let ci = 0; ci < D.STAGES[st - 1].cards.length; ci++) {
          const b = cardOf(st, ci);
          if (!b) { cards.push({ st, ci, err: 'no card' }); continue; }
          const FR = 600;
          let peak = 0, sum = 0, spawned = 0, worst = 1, frames = 0;
          for (let f = 0; f < FR && D.boss && D.boss.state === 'fight'; f++) {
            D.player.invuln = 99999; D.player.lives = 3; D.run.over = false;
            D.boss.card.timeLeft = 99999;   // 别让超时把卡提前结束
            D.step(1);
            const bl = D.bullets;
            peak = Math.max(peak, bl.length); sum += bl.length; frames++;
            let sp = 0;
            for (const q of bl) if (q.delay <= 0 && q.age <= 1.0001) sp++;
            spawned += sp;
            let safe = 0, total = 0;
            for (let gx = 20; gx <= FIELD_W - 20; gx += 30) {
              for (let gy = H - 230; gy <= H - 60; gy += 42) {
                total++;
                let ok = true;
                for (const q of bl) {
                  if (q.delay > 0) continue;
                  const rx = gx - q.x, ry = gy - q.y;
                  const vv = q.vx * q.vx + q.vy * q.vy;
                  let tt = vv > 1e-6 ? (rx * q.vx + ry * q.vy) / vv : 0;
                  if (tt < 0) tt = 0; if (tt > 20) tt = 20;
                  const cx = rx - q.vx * tt, cy = ry - q.vy * tt;
                  if (Math.hypot(cx, cy) < q.r + D.player.hitR + 5) { ok = false; break; }
                }
                if (ok) safe++;
              }
            }
            const frac = safe / total;
            if (frac < worst) worst = frac;
          }
          cards.push({ st, ci, name: b.card.name, peak,
                       mean: +(sum / frames).toFixed(1),
                       spawnPerSec: +(spawned / frames * 60).toFixed(1),
                       worst: +worst.toFixed(3), frames });
        }
      }
      const bad = cards.filter(c => c.err);
      const maxPeak = Math.max.apply(null, cards.filter(c => !c.err).map(c => c.peak));
      const maxSpawn = Math.max.apply(null, cards.filter(c => !c.err).map(c => c.spawnPerSec));
      const minWorst = Math.min.apply(null, cards.filter(c => !c.err).map(c => c.worst));
      return { cards, bad: bad.length, maxPeak, maxSpawn, minWorst };
    })()`);
    const bfmt = c => c.err ? (c.st + '.' + c.ci + ':ERR')
      : (c.st + '.' + c.ci + ' ' + c.name + ' 峰' + c.peak + ' 生成' + c.spawnPerSec + '/s 最差安全' + c.worst);
    step('弹幕预算：峰值在场弹数 ≤ 120（改造前最高 682）',
         budget.bad === 0 && budget.maxPeak <= 120 && budget.maxPeak > 0,
         '实测最高峰值 ' + budget.maxPeak + ' 发');
    step('弹幕预算：生成率 ≤ 70 发/秒（改造前最高 278）',
         budget.maxSpawn <= 70,
         '实测最高 ' + budget.maxSpawn + ' 发/秒');
    step('★ 弹幕公平性：任何一帧都留有可走位通道（安全格 ≥ 30%）',
         budget.minWorst >= 0.30,
         '全卡最差安全率 ' + budget.minWorst + '（改造前最低 0.094 —— 那帧无解）');
    console.log('     · ' + budget.cards.map(bfmt).join('\n     · '));

    // ── 9.7 ★ AI 接管：不作弊 + 能通关 ──
    // ① AI 只产出方向向量，绝不碰判定点 / 无敌帧 / 血量
    const aiPure = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      D.run.noSpawn = true; D.enemies.length = 0; D.bullets.length = 0;
      D.player.invuln = 0; D.player.dead = 0; D.player.lives = 3;
      D.warp(200, 400);
      const wasOn = D.AI.on;
      const before = { hitR: D.player.hitR, grazeR: D.player.grazeR,
                       invuln: D.player.invuln, lives: D.player.lives,
                       spd: D.player.spd, focusSpd: D.player.focusSpd };
      if (!wasOn) D.toggleAI();
      const after = { hitR: D.player.hitR, grazeR: D.player.grazeR,
                      invuln: D.player.invuln, lives: D.player.lives,
                      spd: D.player.spd, focusSpd: D.player.focusSpd };
      // 造半圈弹：下半圆 30 发全部朝圆心飞 —— 形成「唯一的生路在上方」的局面。
      // ⚠️ 为什么不用整圈：整圈是完全对称的，17 个候选方向余量一样，
      //    「往哪走」没有意义，断言写不出真伪。半圈才有唯一缺口，
      //    才能验证「AI 会朝缺口走」以及「安全优先于目标」——
      //    因为此刻目标方向（回到屏幕下方输出位）恰恰指着弹幕里。
      for (let i = 0; i < 30; i++) {
        const a = Math.PI * (0.15 + 0.7 * i / 29);   // 0.15π ~ 0.85π，下半圆
        const q = D.mkBullet(200 + Math.cos(a) * 80, 400 + Math.sin(a) * 80,
                             a + Math.PI, 2.0, { c: 'red', r: 6 });
        q.age = 99; D.bullets.push(q);
      }
      D.AI.lx = 0; D.AI.ly = 0;        // 清掉惯性，让这次判定可复现
      const d = D.aiSteer();
      const dbg = { maxClear: D.AI.dbg.maxClear, threats: D.AI.dbg.threats };
      // aiSteer() 必须是**纯函数**：调它不能改动任何玩家属性
      const pure = { hitR: D.player.hitR, grazeR: D.player.grazeR,
                     invuln: D.player.invuln, lives: D.player.lives };
      const bounded = Math.abs(d.ax) <= 1.0001 && Math.abs(d.ay) <= 1.0001;
      if (!wasOn) D.toggleAI();
      D.run.noSpawn = false;
      return { before, after, pure, bounded, dbg, ax: +d.ax.toFixed(3), ay: +d.ay.toFixed(3),
               pressing: Math.abs(d.ax) + Math.abs(d.ay) > 0 };
    })()`);
    step('★ AI 只产出方向向量：判定点 / 擦弹半径 / 无敌帧 / 移速 开关前后逐项相同',
         aiPure.before.hitR === aiPure.after.hitR && aiPure.before.grazeR === aiPure.after.grazeR &&
         aiPure.before.spd === aiPure.after.spd && aiPure.before.focusSpd === aiPure.after.focusSpd &&
         aiPure.before.invuln === aiPure.after.invuln && aiPure.before.lives === aiPure.after.lives &&
         aiPure.after.hitR === 3.5 && aiPure.after.grazeR === 24 && aiPure.pure.hitR === 3.5 &&
         aiPure.bounded === true && aiPure.pressing === true &&
         // 下半圆合围、上方是唯一缺口，且「回屏幕下方」这个目标方向指着弹里：
         // 正确行为是**朝上走**（安全压过目标），不是站着不动、更不是往下钻。
         aiPure.ay < -0.2,
         'hitR ' + aiPure.before.hitR + '→' + aiPure.after.hitR +
         ' grazeR ' + aiPure.before.grazeR + '→' + aiPure.after.grazeR +
         ' 无敌帧 ' + aiPure.before.invuln + '→' + aiPure.after.invuln +
         ' 半圈合围时推杆(' + aiPure.ax + ',' + aiPure.ay + ') 朝上跑=' +
         (aiPure.ay < -0.2) + ' 余量=' + aiPure.dbg.maxClear);

    // ② 开关 UI：面板按钮点了要生效、要看得见「开」
    const ui = await evaluate(`(() => {
      const D = ${EXPORT};
      const a = document.getElementById('bA'), t = document.getElementById('bT');
      if (!a || !t) return { err: 'no button' };
      if (D.AI.on) D.toggleAI();
      if (D.SPEED !== 1) D.toggleSpeed();
      a.click(); t.click();
      const on = { ai: D.AI.on, speed: D.SPEED,
                   aOn: a.classList.contains('on'), tOn: t.classList.contains('on'),
                   aText: a.textContent, tText: t.textContent };
      a.click(); t.click();
      const off = { ai: D.AI.on, speed: D.SPEED };
      return { on, off };
    })()`);
    step('开始面板的 AI / 二倍速开关按钮可点、且「开」的状态看得见',
         ui.err === undefined && ui.on.ai === true && ui.on.speed === 2 &&
         ui.on.aOn === true && ui.on.tOn === true &&
         ui.on.aText.indexOf('开') >= 0 && ui.on.tText.indexOf('开') >= 0 &&
         ui.off.ai === false && ui.off.speed === 1,
         '点开 → AI=' + ui.on.ai + ' 速度=' + ui.on.speed + '× 按钮文案「' +
         ui.on.aText + '」「' + ui.on.tText + '」；再点 → 关=' + ui.off.ai + ' 速度=' + ui.off.speed);

    // ③ ★ 二倍速：固定步长累加器（不是 update(dt*2)）
    const spd = await evaluate(`(() => {
      const D = ${EXPORT};
      const setSpeed = v => { if (D.SPEED !== v) D.toggleSpeed(); };
      const setup = () => {
        D.start(); D.freeze();
        D.run.noSpawn = true; D.enemies.length = 0; D.bullets.length = 0;
        D.player.invuln = 0; D.player.dead = 0; D.player.lives = 3;
        D.run.deaths = 0;
        D.warp(200, 400);
      };
      // A. 步数 + 位置一致性：同样的按键，2× 跑 1 次 advance 应等于 1× 跑 2 次
      setSpeed(1); setup();
      D.player.invuln = 99999;
      D.key('ArrowLeft', true); D.key('ArrowDown', true);
      D.advance(1); D.advance(1);
      const ref = { x: +D.player.x.toFixed(4), y: +D.player.y.toFixed(4), f: D.run.frame };
      setSpeed(2); setup();
      D.player.invuln = 99999;
      D.key('ArrowLeft', true); D.key('ArrowDown', true);
      const steps = D.advance(1);
      const got = { x: +D.player.x.toFixed(4), y: +D.player.y.toFixed(4), f: D.run.frame };
      D.key('ArrowLeft', false); D.key('ArrowDown', false);
      // B. 穿透探测：一发「一步就跨过判定圈」的弹
      //    真实最快弹 3.6px/帧，这里故意用 20px/帧。
      //    固定步长：第 1 帧落在判定圈内（命中），第 2 帧已飞远。
      //    若写成 update(dt*2)：一步 40px，直接从判定圈上方跳到下方 → 不命中。
      const tunnel = mult => {
        setSpeed(1); setup();
        const q = D.mkBullet(200, 380, Math.PI / 2, 20, { c: 'red', r: 6 });
        q.age = 99; q.vx = 0; q.vy = 20; D.bullets.push(q);
        if (mult === 2) { setSpeed(2); D.advance(1); }
        else { D.step(1); D.step(1); }
        return D.run.deaths;
      };
      const dRef = tunnel(1), dFast = tunnel(2);
      setSpeed(1); setup(); D.run.noSpawn = false;
      return { steps, ref, got, dRef, dFast, speedAfter: D.SPEED };
    })()`);
    step('★ 二倍速用固定步长累加器：advance(1) = 2 次 update(1)，不是 update(dt*2)',
         spd.steps === 2 && spd.speedAfter === 1,
         '2× 下一次 advance(1) 跑了 ' + spd.steps + ' 步');
    step('★ 二倍速不改规则：同输入序列下，2× 与 1× 的位置/帧数逐位一致',
         spd.ref.x === spd.got.x && spd.ref.y === spd.got.y && spd.ref.f === spd.got.f,
         '1× 两帧 (' + spd.ref.x + ',' + spd.ref.y + ')/f' + spd.ref.f +
         ' vs 2× 一次 advance (' + spd.got.x + ',' + spd.got.y + ')/f' + spd.got.f);
    step('★ 二倍速不穿透判定点（20px/帧的探针弹两种倍速都命中）',
         spd.dRef === 1 && spd.dFast === 1,
         '1× 受击 ' + spd.dRef + ' 次 / 2× 受击 ' + spd.dFast + ' 次（期望都为 1；' +
         '若 2× 为 0 说明一步跨过了 3.5px 的判定点）');

    // ── 9.8a ★ 打完第 1 关 Boss → **自动**进第 2 关（走真实 nextStage） ──
    //   为什么单独测这一条：下面 9.8 的链条是用 gotoStage() 跳关跑的，
    //   它验证了「能打到第 3 关」，但绕过了「Boss 死亡 → nextStage()」这一步。
    //   而「run.stage 是 1-based、STAGES 是 0-based」这个经典 off-by-one
    //   正好坐在这一步上（spawnBoss 里原来写 STAGES[run.stage]）：
    //     第 1 关会去打第 2 关的 Boss，第 3 关直接读 undefined.cards 崩掉。
    //   断言方式：打死第 1 关 Boss 后，run.stage 必须是 2，
    //   且重新登场的 Boss 必须是**第 2 关**的「霜华骑士」、首卡「霜符「冰棱柱」」。
    const autoNext = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      D.run.noSpawn = false;
      D.gotoStage(1);
      for (let i = 0; i < 300 && !D.boss; i++) D.step(1);
      const b1 = D.boss ? D.boss.is.name : null;
      let g = 0;
      while (D.boss && !D.run.cleared && g++ < 8000) {
        D.player.invuln = 99999;      // 只考察流程，不让 AI/弹幕干扰
        D.enemies.length = 0; D.bullets.length = 0;
        if (D.boss && D.boss.state === 'fight') D.damageBoss(999, D.boss.x, D.boss.y);
        D.step(1);
      }
      const stageAfter = D.run.stage;
      // nextStage 之后还有 3 波杂兵（约 540 帧），等第 2 关 Boss 真正登场
      for (let i = 0; i < 1500 && !D.boss && !D.run.cleared; i++) {
        D.player.invuln = 99999; D.step(1);
      }
      // 刚登场时 state='enter'、card 还是 null；要等它走完入场 + 90 帧预告
      // 进入 'fight' 才拿得到「首卡」。少了这一步会读到 card2=null。
      for (let i = 0; i < 600 && D.boss && D.boss.state !== 'fight'; i++) {
        D.player.invuln = 99999; D.step(1);
      }
      D.run.noSpawn = true;
      return { b1, stageAfter, cleared: D.run.cleared,
               boss2: D.boss ? (D.boss.is ? D.boss.is.name : null) : null,
               card2: D.boss && D.boss.card ? D.boss.card.name : null };
    })()`);
    step('★ 打完第 1 关 Boss 自动进第 2 关，且新 Boss 是第 2 关的（不是错位打第 3 关）',
         autoNext.cleared === false && autoNext.stageAfter === 2 &&
         autoNext.boss2 === '霜华骑士' && autoNext.card2 === '霜符「冰棱柱」',
         '第 1 关 Boss=「' + autoNext.b1 + '」击破后 run.stage=' + autoNext.stageAfter +
         ' → 新登场 Boss=「' + autoNext.boss2 + '」首卡「' + autoNext.card2 + '」');

    // ── 9.8 ★ 多关卡链条：第 1 关 → 第 2 关 → 第 3 关 → 通关结算 ──
    const chain = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      D.player.invuln = 99999;
      const names = [];
      let guard = 0;
      for (let st = 1; st <= D.STAGES.length && !D.run.cleared && guard++ < 12; st++) {
        if (!D.boss) D.gotoStage(st);
        // ⚠️ gotoStage 只是把 waveN 设成 99；Boss 要等下一帧 updateWaves
        //    才会真正出现。少了这个等待，循环开头读到的 D.boss 仍是 null，
        //    于是后面的 while (D.boss && ...) 整个跳过、st 直接 ++ ——
        //    三关全被略过，返回 cards:0（判据自己制造出来的假失败）。
        for (let i = 0; i < 300 && !D.boss && !D.run.cleared; i++) D.step(1);
        for (let i = 0; i < 1500 && D.boss && !D.run.cleared && D.boss.state !== 'fight'; i++) D.step(1);
        let g = 0;
        while (D.boss && !D.run.cleared && g++ < 4000) {
          D.enemies.length = 0;
          if (D.boss.state === 'fight') {
            if (D.boss.card) names.push(D.boss.card.name);
            D.damageBoss(60, D.boss.x, D.boss.y);
          }
          D.step(1);
        }
      }
      const uniq = names.filter((n, i, a) => a.indexOf(n) === i);
      return { cleared: D.run.cleared, stage: D.run.stage, guard,
               boss: D.boss ? D.boss.state : 'none',
               cards: uniq.length, last: uniq[uniq.length - 1] || null,
               panel: document.getElementById('p3').style.display };
    })()`);
    step('★ 三关链条走通：第 1 关 → 2 → 3 → 触发通关结算',
         chain.cleared === true && chain.cards === 7 && chain.boss === 'none',
         '通关标志=' + chain.cleared + ' 最终关卡=' + chain.stage +
         ' 打过符卡 ' + chain.cards + ' 张（末张「' + chain.last + '」）');

    // ── 9.8b ★ Boss 登场清场：杂兵不许带进 Boss 战 ──
    //   为什么必须测：杂兵期的「吐弹机」(type:'hover') 停在 y=121 永远吐环弹、
    //   自己不会离场；spawnBoss 原来不清敌人 → 它会活进 Boss 战，
    //   和符卡弹幕叠在一起，于是「符卡弹幕 = 量测值」这个前提就不成立了。
    //   死亡复盘里 Stage 2 的 Boss 战中确实看到 2 台 hover 还挂在场上。
    const bossClear = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      D.player.invuln = 99999;          // 站着不动也不会死，只考察敌人生命周期
      let sawEnemies = false, maxE = 0;
      for (let i = 0; i < 1500 && !D.boss; i++) {
        D.step(1);
        if (D.enemies.length) { sawEnemies = true; maxE = Math.max(maxE, D.enemies.length); }
      }
      return { sawEnemies, maxE, boss: !!D.boss,
               enemies: D.enemies.length, bullets: D.bullets.length };
    })()`);
    step('★ Boss 登场清场：杂兵期遗留的敌人 / 弹幕不进 Boss 战',
         bossClear.sawEnemies === true && bossClear.boss === true &&
         bossClear.enemies === 0 && bossClear.bullets === 0,
         '杂兵期最多同时在场 ' + bossClear.maxE + ' 个敌人；Boss 登场时敌人=' +
         bossClear.enemies + ' 弹=' + bossClear.bullets);

    // ── 9.8c ★ 威胁表必须用「相对速度」：玩家自己会移动 ──
    //   这是「AI 通不了关」最顽固的一个 bug 的回归断言。原实现里威胁表先写
    //   `if (弹在远离) continue;` —— 只看**弹自己**的速度。弹幕里最慢的一档
    //   是 1.6px/帧（吐弹机蓝环），玩家全速 4.2px/帧：玩家朝它走过去时两者
    //   相对速度是**接近**的，却因为它自身在"远离"而被排除出威胁表，
    //   于是候选方向打分看不到它，AI 笔直撞上去。
    //   本断言直接构造这个几何：一发向右飘 0.2px/帧的慢弹，玩家在它左边 12px
    //   且**正以全速向右**——弹自身在远离，但相对最近接近点是 0，必须被算成威胁。
    //   修之前：threats=0、close=0（这发弹对 AI 完全隐形）。
    const relThreat = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      D.warp(200, 500);
      D.bullets.length = 0; D.lasers.length = 0;
      D.bullets.push(D.mkBullet(212, 500, 0, 0.2, { c: 'blue', r: 6 })); // 向右 0.2px/帧
      D.player.vx = 4; D.player.vy = 0;   // 玩家正全速向右追它
      D.aiSteer();
      const chasing = { threats: D.AI.dbg.threats, close: D.AI.dbg.close,
                        nb: D.AI.dbg.nb ? D.AI.dbg.nb.d : null };
      // 对照组：玩家不动（相对速度就是弹在远离），也必须被算成威胁
      D.player.vx = 0; D.player.vy = 0;
      D.aiSteer();
      const idle = { threats: D.AI.dbg.threats, close: D.AI.dbg.close };
      return { chasing, idle };
    })()`);
    step('★ 威胁表用相对速度：慢弹被玩家主动追上时，不再被误判成「远离」而漏掉',
         relThreat.chasing.threats >= 1 && relThreat.chasing.close >= 1 &&
         relThreat.chasing.nb !== null && relThreat.idle.threats >= 1,
         '玩家全速追弹(threats=' + relThreat.chasing.threats +
         ' close=' + relThreat.chasing.close + ' 原始最近距离=' + relThreat.chasing.nb +
         'px)；玩家静止(threats=' + relThreat.idle.threats + ')');

    // ── 9.9 ★ AI 长跑：能通关 / 存活中位数 / 不是靠无敌 ──
    const aiRun = await evaluate(`(() => {
      const D = ${EXPORT};
      const runs = [];
      let maxInvuln = 0, minHitR = 99, maxHitR = 0, minGraze = 99, maxGraze = 0;
      for (let r = 0; r < 5; r++) {
        D.start(); D.freeze();
        if (D.SPEED !== 1) D.toggleSpeed();
        if (!D.AI.on) D.toggleAI();
        let f = 0;
        while (f < 24000 && !D.run.over && !D.run.cleared) {
          D.step(1);
          if (D.player.invuln > maxInvuln) maxInvuln = D.player.invuln;
          f++;
        }
        minHitR = Math.min(minHitR, D.player.hitR); maxHitR = Math.max(maxHitR, D.player.hitR);
        minGraze = Math.min(minGraze, D.player.grazeR); maxGraze = Math.max(maxGraze, D.player.grazeR);
        runs.push({ frames: f, over: D.run.over, cleared: D.run.cleared,
                    stage: D.run.stage, deaths: D.run.deaths,
                    lives: Math.max(0, D.player.lives), grazed: D.run.grazed,
                    spells: D.run.spellCleared });
      }
      if (D.AI.on) D.toggleAI();
      const sorted = runs.map(r => r.frames).sort((a, b) => a - b);
      return { runs, med: sorted[2], cleared: runs.filter(r => r.cleared).length,
               gotStage2: runs.filter(r => r.stage >= 2).length,
               maxStage: Math.max.apply(null, runs.map(r => r.stage)),
               maxInvuln, minHitR, maxHitR, minGraze, maxGraze };
    })()`);
    const rfmt = r => '{' + r.frames + '帧 ' + (r.cleared ? '通关' : r.over ? '阵亡' : '超时') +
                      ' 第' + r.stage + '关 失机' + r.deaths + ' 擦' + r.grazed + '}';
    console.log('     · AI 5 轮：' + aiRun.runs.map(rfmt).join(' '));
    step('★ AI 接管能推进到第 2 关（5 轮里至少 4 轮）',
         aiRun.gotStage2 >= 4,
         aiRun.gotStage2 + '/5 轮推进到第 2 关或更后，最远第 ' + aiRun.maxStage + ' 关');
    step('★ AI 接管能通关全部 3 关（5 轮里至少 4 轮；实测 9/9）',
         aiRun.cleared >= 4,
         aiRun.cleared + '/5 轮打到「全符制霸」结算');
    step('★ AI 存活时长中位数（5 轮，不用单轮随机值）',
         aiRun.med >= 6000,
         '中位 ' + aiRun.med + ' 帧 ≈ ' + (aiRun.med / 60).toFixed(0) + ' 秒游戏时间');
    step('★ AI 不是靠无敌 / 缩小判定点赢的',
         aiRun.minHitR === 3.5 && aiRun.maxHitR === 3.5 &&
         aiRun.minGraze === 24 && aiRun.maxGraze === 24 &&
         aiRun.maxInvuln <= 180,
         '全程 hitR=' + aiRun.minHitR + '~' + aiRun.maxHitR +
         ' grazeR=' + aiRun.minGraze + '~' + aiRun.maxGraze +
         ' 出现过的最长无敌帧=' + aiRun.maxInvuln + '（炸弹的 180 帧是上限）');

    // ── 10. Canvas 真画了东西 ──
    const ink = await evaluate(`(() => {
      const c = document.querySelector('canvas');
      const g = c.getContext('2d');
      const d = g.getImageData(0,0,c.width,c.height).data;
      let n = 0;
      for (let i=0;i<d.length;i+=4000) if (d[i]>28||d[i+1]>28||d[i+2]>28) n++;
      return n;
    })()`);
    step('Canvas 有实际绘制内容', ink > 50, '采样命中 ' + ink);

    step('零未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | '));
  } catch (e) {
    step('测试执行', false, e.message);
  }

  // 截图前解冻：冻结态下 draw() 仍会跑，但让画面回到真实运行的样子更可信
  await evaluate(`try { ${EXPORT}.unfreeze(); } catch(e) {}`);
  await sleep(700);
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

// ---- 极简 WebSocket（不引第三方包） ----
function connect(url) {
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
      socket.on('error', reject);
      resolve(api);
    });
    req.on('error', reject);
    req.end();
  });
}