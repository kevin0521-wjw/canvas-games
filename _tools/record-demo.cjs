/**
 * 实机演示录制器 —— 用 headless Edge + CDP 逐帧抓画布，交给 ffmpeg 压成 H.264。
 *
 * 为什么不用「实时录屏」：
 *   实时录屏（ffmpeg gdigrab 之类）抓的是窗口，画面里会有浏览器边框，
 *   而且帧率随机器负载浮动。CDP 抓 canvas 像素是确定性的：
 *   每帧先 advance 固定步数、再 draw、最后 toDataURL，输出严格 20fps / 180 帧。
 *
 * 为什么要「冻结 rAF + 手动 step」：
 *   freeze() 会停掉游戏自己的 rAF，于是测试成为唯一时钟 —— 同一份代码每次
 *   录出来的画面完全一致，返工时只要重跑脚本，不用重录。
 *
 * 输出尺寸 = 逻辑分辨率（520×880），与既有五段演示完全一致：
 *   resize() 里 s = min(innerW/W, innerH/H) × 0.99，要让 s 恰好 = 1，
 *   视口得开到 (W/0.99, H/0.99) ≈ 526×889，取整后再 verify 一次 cv.width。
 *
 * 用法：
 *   node _tools/record-demo.cjs --game talisman-array --out 06_符箓灵弹-元素阵.mp4
 */
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FFMPEG = 'ffmpeg';
const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------- 参数
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const GAME = arg('game', 'talisman-array');
const OUT = arg('out', GAME + '.mp4');
const FRAMES = parseInt(arg('frames', '180'), 10);
const FPS = parseInt(arg('fps', '20'), 10);
const STEP = parseInt(arg('step', '3'), 10);      // 每个视频帧推进几个游戏帧（60fps 游戏 → 3 帧 = 20fps）
const PORT = 9600 + (crypto.randomBytes(1)[0] % 60);
const CDP_PORT = PORT + 100;

/* ---------------------------------------------------------------- 场景脚本
 * 每条 { at: 视频帧号, code: 在页面里执行的 JS（可用 D = window.__TP） }
 * at 到达时执行一次。目的都是把「本来要靠运气出现」的新机制摆到画面里。
 */
const SCENARIOS = {
  'talisman-array': {
    w: 520, h: 880,
    script: [
      // ① 开局 + AI 接管；把底排刷成水 —— 冰的「冻结成片 → 破冰 1.8 倍 + 溅射」
      //    是两发才兑现的组合，按组合价值算比单发的蒸发 1.6 更划算，
      //    所以 AI 会选中「冰」；下一帧它看到目标被冻住，又改用火去破冰。
      //    这一来一回（冰 → 冻结 → 火 → 破冰溅射）就是 v1.5.0 的招牌动作。
      { at: 0, code: `
        D.startRun();
        D.run.aiOn = true; D.AI.on = true;
        const blks = D.run.blocks.filter(b => b.alive);
        const low = blks.reduce((a, b) => D.blockY(a) > D.blockY(b) ? a : b);
        D.run.blocks.forEach(b => { if (b.alive) b.el = (b === low) ? 'hydro' : 'pyro'; });
      ` },
      // ② 再手动给最下面那块挂一层冻结：冰晶裂纹先露个脸
      { at: 34, code: `
        const blks = D.run.blocks.filter(b => b.alive);
        const low = blks.reduce((a, b) => D.blockY(a) > D.blockY(b) ? a : b);
        if (low) D.hitBlock(low, 'cryo', 12);
      ` },
      // ③ 天象 · 水：慢、大半径、命中溅成两滴 —— 走预警线那一套（0.75s 后才落弹）
      { at: 72, code: `D.run.env.warn = { x: 150, el: 'hydro', t: 45 };` },
      // ④ 天象 · 雷：Z 字横摆，不好预判
      { at: 108, code: `D.run.env.warn = { x: 330, el: 'electro', t: 45 };` },
      // ⑤ 天象 · 风：从屏幕侧面斜进来，逼人离开舒适位
      { at: 142, code: `D.run.env.warn = { x: 40, el: 'anemo', t: 45 };` },
    ],
  },
};

/* ---------------------------------------------------------------- 静态服务
 * 只服务 games/ 目录：演示要录的是「站点上的真实页面」，不是单文件。
 */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
               '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };
const srv = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
  const file = path.join(ROOT, rel || 'index.html');
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sleepSync = ms => { const a = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(a, 0, 0, ms); };

function killTree(proc) {
  try {
    if (process.platform === 'win32')
      execFileSync('cmd', ['/c', 'taskkill', '/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    else proc.kill('SIGKILL');
  } catch (e) {}
  try { proc.kill(); } catch (e) {}
  sleepSync(700);
}
function rmTree(dir) {
  if (!fs.existsSync(dir)) return;
  try { execFileSync('cmd', ['/c', 'rmdir', '/s', '/q', dir], { stdio: 'ignore', timeout: 8000 }); } catch (e) {}
  if (fs.existsSync(dir)) {
    try {
      execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Remove-Item',
        '-LiteralPath', dir, '-Recurse', '-Force', '-ErrorAction', 'SilentlyContinue'],
        { stdio: 'ignore', timeout: 10000 });
    } catch (e) {}
  }
}

/* ---------------------------------------------------------------- 主流程 */
(async () => {
  const sc = SCENARIOS[GAME];
  if (!sc) { console.error('❌ 没有这个游戏的场景脚本：' + GAME); process.exit(1); }

  await new Promise(r => srv.listen(PORT, '127.0.0.1', r));

  const profile = path.resolve(__dirname, '_recprof');
  rmTree(profile);
  const frameDir = path.resolve(__dirname, '_frames');
  rmTree(frameDir);
  fs.mkdirSync(frameDir, { recursive: true });

  // 视口开成 (W/0.99, H/0.99) 取整 → resize() 里 s ≈ 1 → backing 正好 W×H
  const vw = Math.ceil(sc.w / 0.99), vh = Math.ceil(sc.h / 0.99);
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
    `--remote-debugging-port=${CDP_PORT}`,
    '--user-data-dir=' + profile,
    `--window-size=${vw},${vh}`,
    `http://127.0.0.1:${PORT}/${GAME}/index.html`,
  ], { stdio: 'ignore' });

  const get = pathname => new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: CDP_PORT, path: pathname }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });

  let ws = null, tab = null;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const tabs = await get('/json/list');
      tab = tabs.find(t => t.type === 'page' && t.url.includes('/' + GAME + '/'));
      if (tab && tab.webSocketDebuggerUrl) break;
    } catch (e) {}
    await sleep(400);
  }
  if (!tab) { console.error('❌ 45s 内没找到页面标签'); killTree(proc); srv.close(); process.exit(1); }

  ws = await connect(tab.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onMessage = raw => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params) => new Promise(r => {
    const i = ++id; pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
    }
    return r.result?.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: vw, height: vh, deviceScaleFactor: 1, mobile: false,
  });

  // 等导出就绪
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    await sleep(200);
    try { ready = await evaluate(`typeof window.__TP !== "undefined"`); } catch (e) { ready = false; }
  }
  if (!ready) { console.error('❌ 页面没暴露 __TP'); killTree(proc); srv.close(); process.exit(1); }

  // 重新布局并核对 backing 尺寸
  await evaluate(`dispatchEvent(new Event('resize'))`);
  await sleep(300);
  const size = await evaluate(`(() => { const c = document.getElementById('cv');
    return { w: c.width, h: c.height, iw: innerWidth, ih: innerHeight }; })()`);
  console.log(`  视口 ${size.iw}×${size.ih} → canvas backing ${size.w}×${size.h}`);
  if (size.w !== sc.w || size.h !== sc.h) {
    console.error(`❌ backing 尺寸不对（要 ${sc.w}×${sc.h}），改视口尺寸再试`);
    killTree(proc); srv.close(); process.exit(1);
  }

  // 冻结 rAF：之后测试成为唯一时钟
  await evaluate(`window.__TP.freeze()`);

  const pending2 = sc.script.slice().sort((a, b) => a.at - b.at);
  let shot = 0;
  for (let f = 0; f < FRAMES; f++) {
    while (pending2.length && pending2[0].at <= f) {
      const act = pending2.shift();
      try {
        await evaluate(`(() => { const D = window.__TP; ${act.code} })()`);
        console.log(`  ▸ 第 ${f} 帧执行场景脚本`);
      } catch (e) { console.log(`  ⚠ 第 ${f} 帧场景脚本失败：${e.message}`); }
    }
    const url = await evaluate(
      `(() => { const D = window.__TP; D.step(${STEP}); D.draw();
        return document.getElementById('cv').toDataURL('image/jpeg', 0.93); })()`);
    if (!url || !url.startsWith('data:image/jpeg')) {
      console.error(`❌ 第 ${f} 帧取不到画面`); break;
    }
    const buf = Buffer.from(url.split(',')[1], 'base64');
    fs.writeFileSync(path.join(frameDir, `f${String(shot++).padStart(4, '0')}.jpg`), buf);
    if ((f + 1) % 30 === 0) console.log(`  … ${f + 1}/${FRAMES} 帧`);
  }

  const outPath = path.resolve(ROOT, 'demo', OUT);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  execFileSync(FFMPEG, [
    '-y', '-framerate', String(FPS), '-i', path.join(frameDir, 'f%04d.jpg'),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '23',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    outPath,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const sizeOut = fs.statSync(outPath).size;
  console.log(`\n✅ 录制完成：${path.relative(ROOT, outPath)}  ${shot} 帧 / ${FPS}fps  ${(sizeOut / 1024).toFixed(0)} KB`);

  try { ws.close(); } catch (e) {}
  killTree(proc);
  srv.close();
  rmTree(profile);
  process.exit(0);
})().catch(e => { console.error('崩溃:', e); process.exit(2); });

/* ---------------------------------------------------------------- 极简 WebSocket */
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
