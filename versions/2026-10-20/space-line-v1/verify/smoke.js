/**
 * 星际防线 · 初版（Space Line v1）的归档自检。
 *
 * 为什么这一版也要有判据：
 *   它是整个档案的**起点** —— 会话里第一次交付、也是第一次发布出去的那一版
 *   （原地址 https://2d2b38409ac04c8c8c1d1f9c80d424db.app.workbuddy.host ）。
 *   归档一份「死文件」没有意义，能证明「这份存档现在仍然跑得起来」才有意义 ——
 *   所以这份判据验的不是四层缝合（那是 v2 的事），而是三件事：
 *     ① 存档文件完整、能被浏览器真正执行（不是把 HTML 存坏了）
 *     ② 初版就有的两个招牌功能还在：**AI 自动接管** 与 **二倍速**
 *     ③ 输入、主循环、绘制这条最基本的链路是通的
 *
 * 判据跑在真实浏览器里（headless Edge + CDP，WebSocket 直连、不依赖 puppeteer）。
 * 注意这一版**没有** freeze()/step() 之类的测试钩子，所以判据只能靠真实 rAF 推进 ——
 * 涉及时间的地方一律「等一会儿再读」，不去赌精确帧数。
 *
 * 用法：node verify/smoke.js index.html __SpaceLine
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FILE = path.resolve(process.argv[2] || '../index.html');
const EXPORT = process.argv[3] || '__SpaceLine';
const PORT = 9481 + (crypto.randomBytes(1)[0] % 30);
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
    '--window-size=1100,900',
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
  const key = async (k, down, code, vk) => send('Input.dispatchKeyEvent', {
    type: down ? 'keyDown' : 'keyUp', key: k, code: code || k,
    windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  });

  await send('Runtime.enable'); await send('Page.enable');
  // ⚠️ 这里原来是一句固定 sleep（等页面脚本跑完）。
  //   「找到 CDP tab」**不等于「页面加载完」** —— tab 一出现就能连上，
  //   但此时 index.html 可能还没执行到 window.__SpaceLine = ... 那行。
  //   症状：读到 undefined，报「暴露测试接口失败」，而游戏逻辑毫无异常。
  //   踩到的现场：touhou-danmaku 全量回归挂 2 条，__DM 的 typeof=false。
  // → 改成轮询真正的就绪条件：慢页面自然多等，快页面立刻进。
  let __ready = false;
  for (let __i = 0; __i < 100 && !__ready; __i++) {
    await sleep(200);
    try { __ready = await evaluate('typeof window.__SpaceLine !== "undefined"'); } catch (e) { __ready = false; }
  }
  if (!__ready) console.log('⚠️ 等了 20 秒仍没等到 window.__SpaceLine，后续判据大概率会误报');


  const report = { steps: [] };
  const step = (name, ok, detail) => {
    report.steps.push({ name, ok });
    console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
  };

  try {
    // ── 1. 存档能被执行，并且真的暴露了那一版就有的测试接口 ──
    const api = await evaluate(`(() => {
      const S = window.${EXPORT};
      if (!S) return null;
      return { 键: Object.keys(S), 有游戏: !!S.game, 状态: S.game && S.game.state,
               有AI: !!S.AutoPilot, 有CFG: !!S.CFG };
    })()`);
    step('存档可执行且暴露测试接口 ' + EXPORT, !!api,
         api ? `字段 [${api.键.join(', ')}]` : '（undefined —— 文件可能存坏了）');
    if (!api) throw new Error('no export');

    step('初版招牌功能：AI 自动接管模块存在',
         api.有AI === true, `AutoPilot ${api.有AI ? '在' : '缺失'}`);
    step('初版招牌功能：二倍速档位在配置里（CFG.SPEED.FAST = 2）',
         (await evaluate(`${EXPORT}.CFG.SPEED.FAST`)) === 2,
         `NORMAL=${await evaluate(`${EXPORT}.CFG.SPEED.NORMAL`)} / ` +
         `FAST=${await evaluate(`${EXPORT}.CFG.SPEED.FAST`)}`);

    // ── 2. 点「开始游戏」能真的进对局 ──
    const ready = await evaluate(`${EXPORT}.game.state`);
    const btn = await evaluate(`(() => {
      const b = document.getElementById('ov-btn');
      const r = b.getBoundingClientRect();
      return { 文案: b.textContent.trim(), x: Math.round(r.left + r.width/2),
               y: Math.round(r.top + r.height/2),
               可见: r.width > 0 && r.height > 0 };
    })()`);
    for (const type of ['mousePressed', 'mouseReleased'])
      await send('Input.dispatchMouseEvent',
        { type, x: btn.x, y: btn.y, button: 'left', clickCount: 1, buttons: 1 });
    await sleep(900);
    const playing = await evaluate(`${EXPORT}.game.state`);
    step('初始 state=ready → 点「' + btn.文案 + '」→ state=playing',
         ready === 'ready' && playing === 'playing',
         `${ready} → ${playing}`);

    // ── 3. 键盘输入真的接上了（按左键，飞船要往左走）──
    const mv = await evaluate(`(() => ({ x: ${EXPORT}.game.player.x,
      y: ${EXPORT}.game.player.y }))()`);
    await key('ArrowLeft', true, 'ArrowLeft', 37);
    await sleep(700);
    await key('ArrowLeft', false, 'ArrowLeft', 37);
    const mv2 = await evaluate(`(() => ({ x: ${EXPORT}.game.player.x,
      y: ${EXPORT}.game.player.y }))()`);
    step('键盘输入链路通（按住 ← 0.7 秒，飞船 x 要变小）',
         mv2.x < mv.x - 20, `x ${mv.x.toFixed(0)} → ${mv2.x.toFixed(0)}`);

    // ── 4. 二倍速开关（这就是「加一个二倍速」的原始实现）──
    const spd = await evaluate(`(() => {
      const D = ${EXPORT};
      const a = D.game.toggleSpeed();       // 1 → 2
      const b = D.game.toggleSpeed();       // 2 → 1
      return { 切到: a, 切回: b };
    })()`);
    step('二倍速可切换（game.toggleSpeed 1↔2）',
         spd.切到 === 2 && spd.切回 === 1, `1 → ${spd.切到} → ${spd.切回}`);

    // ── 5. AI 接管：真的能自己打（分数要涨、状态不能崩）──
    const aiOn = await evaluate(`(() => { const D = ${EXPORT};
      D.AutoPilot.toggle(D.game); return { on: D.AutoPilot.on, state: D.game.state }; })()`);
    const s0 = await evaluate(`${EXPORT}.game.score`);
    await sleep(2500);
    const after = await evaluate(
      `(() => { const D = ${EXPORT}; return { on: D.AutoPilot.on, state: D.game.state,
        score: D.game.score, 敌: D.game.enemies.length, 已接管: +(D.AutoPilot.engaged||0).toFixed(1) }; })()`);
    await evaluate(`${EXPORT}.AutoPilot.toggle(${EXPORT}.game)`);   // 收尾关掉
    step('AI 自动接管：开关生效、接管期间分数在涨、对局不崩',
         aiOn.on === true && after.on === true && after.state === 'playing' &&
         after.score > s0,
         `on=${after.on}，state=${after.state}，得分 ${s0} → ${after.score}，` +
         `在场敌人 ${after.敌}，已接管 ${after.已接管}s`);

    // ── 6. Canvas 真的在画东西 ──
    const ink = await evaluate(`(() => {
      const c = document.getElementById('game');
      const g = c.getContext('2d');
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let n = 0, total = 0;
      for (let i = 0; i < d.length; i += 4000) {
        total++;
        if (d[i] > 28 || d[i + 1] > 28 || d[i + 2] > 28) n++;
      }
      return { n, total, pct: +(n / total * 100).toFixed(1), w: c.width, h: c.height };
    })()`);
    step('Canvas 有实际绘制内容（不是一片纯黑）', ink.pct > 3,
         `画布 ${ink.w}x${ink.h}，采样命中 ${ink.n}/${ink.total}（${ink.pct}%）`);

    /* ═══ 本轮（第六轮）新增：去掉「抖屏 / 闪屏」+ UI 调亮 ═══════════════════
       用户的原话：「视觉污染的闪屏和屏幕抖动」。这一节要钉住三件事：
         ① 世界坐标系里不能再有位移抖动（旧字段 + 真实渲染时的变换矩阵都要干净）；
         ② 不能再有覆盖整屏的亮色填充（全屏白闪 / 泛红）；
         ③ 受击反馈换成「按方向偏色的边缘脉冲」，且方向必须真的对、会自己衰减。
       最后两条是配色：面板底色亮度 + 正文/次级文字对比度（WCAG AA 4.5:1）。
       ⚠️ 这一版没有 freeze()/step() 钩子，所以判据只能直接调 game.render() /
          game.update() —— 它们都是同步的，不会被 rAF 插进来，结论依然确定。
       ====================================================================== */

    // ── ★ 位移抖动必须彻底消失 ────────────────────────────────────────────
    //  改前：render() 开头 `ctx.translate(Math.cos(a)*m, Math.sin(a)*m)` —— 整幅场景随机平移。
    //  判据分两层：① 旧字段没了；② 真跑一次 render()，在**第一笔填充**那一刻读
    //  ctx.getTransform() —— 它返回的就是"世界 → 屏幕"的当前变换矩阵，
    //  e/f 就是平移量。抖动只要发生过，这两个值一定非 0。
    //  为什么不用「数 translate 调用次数」：场景里每个实体都有自己的合法 translate，
    //  分不清哪一次是抖动；而矩阵读数不存在这个问题。
    const noShake = await evaluate(`(() => {
      const G = ${EXPORT}.game;
      const legacy = { hasShakeTime: 'shakeTime' in G, hasShakeMag: 'shakeMag' in G,
                       hasFlash: 'flash' in G };
      const g = G.ctx;
      const ofr = g.fillRect;
      let first = null; const covers = [];
      g.fillRect = function (x, y, w, h) {
        if (first === null) { const t = this.getTransform(); first = [+t.e.toFixed(3), +t.f.toFixed(3)]; }
        if (w >= 800 && h >= 600) covers.push(String(this.fillStyle));
        return ofr.apply(this, arguments);
      };
      let ok = true;
      try { G.render(); } catch (e) { ok = false; }
      finally { g.fillRect = ofr; }
      const bright = covers.filter(c => {
        const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(c);
        return m && +m[1] >= 200 && +m[2] >= 200 && +m[3] >= 200;
      });
      return { legacy, first, ok, covers, bright };
    })()`);
    step('★ 已移除位移抖动：shakeTime/shakeMag 字段不存在 + 渲染时变换矩阵平移量恒为 0',
         noShake.ok === true && noShake.first !== null &&
         noShake.first[0] === 0 && noShake.first[1] === 0 &&
         noShake.legacy.hasShakeTime === false && noShake.legacy.hasShakeMag === false,
         `旧字段 shakeTime=${noShake.legacy.hasShakeTime} shakeMag=${noShake.legacy.hasShakeMag}；` +
         `render() 第一笔填充时 ctx.getTransform() 平移量 = (${noShake.first})（必须是 0,0）`);

    // ── ★ 全屏闪（白闪 / 泛红）必须彻底消失 ────────────────────────────────
    const noFlash = await evaluate(`(() => {
      const G = ${EXPORT}.game;
      const g = G.ctx;
      const ofr = g.fillRect;
      const covers = [];
      g.fillRect = function (x, y, w, h) {
        if (w >= 800 && h >= 600) covers.push(String(this.fillStyle));
        return ofr.apply(this, arguments);
      };
      try {
        G.addImpact(1, null, '#ff2f50');   // 拉满脉冲，再渲染一次
        G.render();
      } finally { g.fillRect = ofr; G.impactT = 0; }
      const bright = covers.filter(c => {
        const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(c);
        return m && +m[1] >= 200 && +m[2] >= 200 && +m[3] >= 200;
      });
      return { hasFlash: 'flash' in G, covers, bright };
    })()`);
    step('★ 已移除全屏闪：flash 字段不存在 + 渲染里没有覆盖整屏的亮色填充',
         noFlash.hasFlash === false && noFlash.bright.length === 0,
         `flash 字段存在=${noFlash.hasFlash}；覆盖整屏的填充 ${noFlash.covers.length} 处` +
         `[${noFlash.covers.join(' ')}]，其中亮色 ${noFlash.bright.length} 处` +
         `（背景 #02030a 与暗角/星云都是渐变，都不算亮色）`);

    // ── ★ 温和替代反馈：按受击方向偏色的边缘脉冲 ──────────────────────────
    //  三条一起验，缺一条这个"替代方案"就不成立：
    //    ① 事件真的触发了反馈（impactT > 0）；
    //    ② 方向是对的（从左侧来 → 左边缘权重 > 右边缘，反向对照必须反过来）；
    //    ③ 会自己衰减回 0（不是 NaN、不是卡住）。
    //  ⚠️ ②用的是 game.impactWeights()，和渲染共用同一份实现 —— 判据自己再写一遍
    //    三角函数是最经典的自欺：两边一起错，测试照样全绿。
    const gentle = await evaluate(`(() => {
      const G = ${EXPORT}.game;
      G.addImpact(1, Math.PI, '#ff2f50');        // pi = 从左侧来
      const t0 = G.impactT, w0 = G.impactWeights();
      for (let i = 0; i < 20; i++) G.update(0.05);   // 推进 1 秒（衰减只需 0.59 秒）
      const t1 = G.impactT, w1 = G.impactWeights();
      G.addImpact(1, 0, '#ff2f50');              // 0 = 从右侧来
      const w2 = G.impactWeights();
      G.impactT = 0;
      return { t0: +t0.toFixed(3), t1: +t1.toFixed(3),
               l0: +w0.l.toFixed(3), r0: +w0.r.toFixed(3),
               l2: +w2.l.toFixed(3), r2: +w2.r.toFixed(3),
               l1: w1.l, r1: w1.r };
    })()`);
    step('★ 受击反馈 = 方向化边缘脉冲（左侧受击左边缘更亮，且会衰减回 0）',
         gentle.t0 === 1 && gentle.t1 === 0 &&
         gentle.l0 > gentle.r0 && gentle.l2 < gentle.r2 &&
         gentle.l1 === 0 && gentle.r1 === 0,
         `受击瞬间 impactT=${gentle.t0} → 1 秒后 ${gentle.t1}（必须回到 0，不能是 NaN/负数）；` +
         `左侧受击 左${gentle.l0}/右${gentle.r0}，右侧受击 左${gentle.l2}/右${gentle.r2}（方向必须反过来）`);

    // ── ★ 配色：面板不能再掉回「太暗」 ────────────────────────────────────
    //  真正的风险不是"这一版够不够亮"，而是以后有人手滑把变量调回去。
    //  所以断言钉在 CSS 变量上，并且顺带确认 #ov-board 真的在用 --panel
    //  （不然"改了变量但没人用"也会全绿）。
    const uiCol = await evaluate(`(() => {
      const cs = getComputedStyle(document.documentElement);
      const v = n => cs.getPropertyValue(n).trim();
      const hex = h => { const n = parseInt(h.replace('#',''), 16);
                         return [(n>>16)&255, (n>>8)&255, n&255]; };
      const lin = c => { c /= 255; return c <= 0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); };
      const lumArr = c => 0.2126*lin(c[0]) + 0.7152*lin(c[1]) + 0.0722*lin(c[2]);
      const lumHex = h => lumArr(hex(h));
      const ratio = (a, b) => { const hi = Math.max(a,b), lo = Math.min(a,b);
                                return +((hi+0.05)/(lo+0.05)).toFixed(2); };
      const parse = s => {
        const m = /rgba?\\(([^)]+)\\)/.exec(s);
        if (m) { const p = m[1].split(',').map(x => parseFloat(x));
                 return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
        // 背景色是 #rrggbb 这种写法，也得认 —— 只认 rgba() 会让合成直接返回 null（踩过）
        if (/^#([0-9a-f]{6})$/i.test(s)) { const c = hex(s); return { r: c[0], g: c[1], b: c[2], a: 1 }; }
        return null;
      };
      // 覆盖层是半透明的 rgba，必须先在 sRGB 空间里跟画布底色合成出"实际看到的颜色"
      const over = (f, b) => { const F = parse(f), B = parse(b); if (!F || !B) return null;
                               const a = F.a;
                               return [Math.round(F.r*a + B.r*(1-a)), Math.round(F.g*a + B.g*(1-a)),
                                       Math.round(F.b*a + B.b*(1-a))]; };
      const rgbStr = s => { const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(s);
                            return m ? [+m[1],+m[2],+m[3]].join(',') : ''; };
      const panel = v('--panel'), text = v('--text'), dim = v('--text-dim'), mute = v('--text-mute');
      const Lp = lumHex(panel);
      const veil = over(v('--veil-a'), v('--bg-deep'));
      const boardBg = getComputedStyle(document.getElementById('ov-board')).backgroundColor;
      return { panel, text, dim, mute, boardBg,
               panelLum: +Lp.toFixed(4),
               boardUses: hex(panel).join(',') === rgbStr(boardBg),
               veilLum: veil ? +lumArr(veil).toFixed(4) : -1,
               cText: ratio(lumHex(text), Lp),
               cDim: ratio(lumHex(dim), Lp),
               cMute: ratio(lumHex(mute), Lp) };
    })()`);
    step('★ 配色：面板底色亮度 ≥ 0.010（#ov-board 真的在用这个变量）',
         uiCol.panelLum >= 0.010 && uiCol.boardUses === true && uiCol.veilLum >= 0.008,
         `--panel=${uiCol.panel} 亮度 ${uiCol.panelLum}（改前 rgba(3,6,16,.82~.94) ≈ 0.004）；` +
         `#ov-board 实际背景 ${uiCol.boardBg}（用的是这个变量=${uiCol.boardUses}）；` +
         `覆盖层合成后的实际底色亮度 ${uiCol.veilLum}`);
    step('★ 配色：正文 + 次级 + 最弱一档文字对面板的对比度都 ≥ 4.5:1（WCAG AA）',
         uiCol.cText >= 4.5 && uiCol.cDim >= 4.5 && uiCol.cMute >= 4.5,
         `正文 ${uiCol.text} = ${uiCol.cText}:1，次级 ${uiCol.dim} = ${uiCol.cDim}:1，` +
         `最弱 ${uiCol.mute} = ${uiCol.cMute}:1（改前脚注 #3d5b78 只有 1.8:1）`);

    /* ---------- v1.4.0 新增：四阶段 BOSS / 难度曲线 / 敌弹描边 ---------- */
    const bossPhase = await evaluate(`(() => {
      const D = ${EXPORT};
      const B = D.classes.Boss;
      const b = new B(1);
      // 用血量比例反推阶段，再同步到 this.phase（spreadCount 读的是 this.phase）
      const at = (ratio) => {
        b.hp = b.maxHp * ratio;
        b.phase = b.phaseByHp;
        return {
          p: b.phase, spread: b.spreadCount, ring: b.hasRing,
          interval: +b.fireInterval.toFixed(2),
        };
      };
      return { a: at(0.90), b: at(0.60), c: at(0.30), d: at(0.10) };
    })()`);
    step('★ v1.4.0 BOSS 四阶段：14% 以下进入濒死形态，扇形 7 发 + 环弹更快',
      bossPhase.a.p === 1 && bossPhase.b.p === 2 && bossPhase.c.p === 3 && bossPhase.d.p === 4
      && bossPhase.d.spread === 7 && bossPhase.c.spread === 5
      && bossPhase.d.ring === true
      && bossPhase.d.interval < bossPhase.c.interval,
      `1/2/3/4 阶段 = ${bossPhase.a.p}/${bossPhase.b.p}/${bossPhase.c.p}/${bossPhase.d.p}，`
      + `扇形发数 ${bossPhase.a.spread}→${bossPhase.b.spread}→${bossPhase.c.spread}→${bossPhase.d.spread}，`
      + `开火间隔 ${bossPhase.c.interval}s→${bossPhase.d.interval}s`);

    const diffCfg = await evaluate(`(() => {
      const D = ${EXPORT};
      return { spl: D.CFG.DIFFICULTY.SECONDS_PER_LEVEL, max: D.CFG.DIFFICULTY.MAX_LEVEL };
    })()`);
    step('★ v1.4.0 降难度：升级间隔 16→22 秒、等级上限 12→10',
      diffCfg.spl === 22 && diffCfg.max === 10,
      `每 ${diffCfg.spl} 秒升一级，上限 ${diffCfg.max} 级（旧 16 / 12）`);

    // 敌弹描边：只扫 EnemyBullet 这一段 —— 全文件还有别的 shadowBlur（玩家子弹/道具），
    // 用全文正则会把它们误判成"敌弹没改"。
    const srcText = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const ebStart = srcText.indexOf('class EnemyBullet');
    const ebEnd = srcText.indexOf('class Boss', ebStart);
    const ebSeg = ebStart >= 0 && ebEnd > ebStart ? srcText.slice(ebStart, ebEnd) : '';
    const hasEdge = ebSeg.includes("rgba(6,8,18,.78)");
    const oldBlur = /ctx\.shadowBlur/.test(ebSeg);   // 只认真正的调用，不认注释里提到的名字
    step('★ v1.4.0 敌弹描边（去掉 shadowBlur，改实心深色外圈 + 速度分级）',
      hasEdge && !oldBlur && ebSeg.length > 500,
      `深色外圈=${hasEdge}，敌弹段残留 shadowBlur=${oldBlur}，段落 ${ebSeg.length} 字符`);

    step('零未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | '));
  } catch (e) {
    step('测试执行', false, e.message);
  }

  await sleep(400);
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
