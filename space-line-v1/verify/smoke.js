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
         `画布 ${ink.w}×${ink.h}，采样命中 ${ink.n}/${ink.total}（${ink.pct}%）`);

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
