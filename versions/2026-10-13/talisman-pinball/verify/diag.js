/**
 * 逐帧诊断：落底回收 + 盾向伤害方向。
 * 不猜 —— 把每帧的球位置/速度打出来，看到底发生了什么。
 *
 * ⚠️ 末尾删除用逐文件 rmTree 而不是 fs.rmSync：
 *    这台机器上 fs.rmSync 会走 WorkBuddy 的 safe-delete 垫片 → 转回收站 → 报
 *    "Error during a `trash` operation: Unknown"。详见 skill: single-file-canvas-game-verify
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FILE = path.resolve(__dirname, '../index.html');
const EXPORT = '__TP';
const PORT = 9391 + (crypto.randomBytes(1)[0] % 30);
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
  const walk = d => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else { try { fs.unlinkSync(p); } catch (x) {} }
    }
    try { fs.rmdirSync(d); } catch (e) {}
  };
  walk(dir);
}

(async () => {
  await new Promise(r => srv.listen(PORT, '127.0.0.1', r));
  const profile = path.resolve(__dirname, '_dp');
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
    `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
    '--window-size=900,1000', `http://127.0.0.1:${PORT}/g.html`], { stdio: 'ignore' });

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
  if (!tab) { console.log('❌ 没找到标签'); proc.kill(); srv.close(); process.exit(1); }

  const ws = await connect(tab.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.onMessage = raw => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params) => new Promise(r => {
    const i = ++id; pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails)
      throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
    return r.result?.result?.value;
  };
  await send('Runtime.enable'); await send('Page.enable');
  await sleep(1500);
  await ev(`${EXPORT}.start()`); await sleep(300);

  // ── 诊断 1：回收链路 ──
  const d1 = await ev(`(() => {
    const D = ${EXPORT}, R = D.run;
    R.turretX = 200;
    R.balls.length = 0;
    const log = [];
    const b = D.mkBall(260, 300, Math.PI/2);
    b.age = 999;
    R.balls.push(b);
    for (let i = 0; i < 240; i++) {
      D.step(1);
      log.push({ i, y:+R.balls[0].y.toFixed(0), vy:+R.balls[0].vy.toFixed(2),
                 n: R.balls.length, bnc: R.balls[0].bounce });
      if (R.balls.length !== 1) break;
    }
    return { GROUND_Y: D.GROUND_Y, CANVAS_TOP: D.CANVAS_TOP,
             n: R.balls.length,
             final: R.balls[0] ? { x:+R.balls[0].x.toFixed(0), y:+R.balls[0].y.toFixed(0),
                                   vy:+R.balls[0].vy.toFixed(2) } : null,
             first10: log.slice(0, 10), last6: log.slice(-6) };
  })()`);
  console.log('=== 诊断1：落底回收 ===');
  console.log('GROUND_Y =', d1.GROUND_Y, ' CANVAS_TOP =', d1.CANVAS_TOP);
  console.log('球数 =', d1.n, ' 末位置 =', JSON.stringify(d1.final));
  console.log('前10帧:'); (d1.first10 || []).forEach(l => console.log('  ', JSON.stringify(l)));
  console.log('末6帧:'); (d1.last6 || []).forEach(l => console.log('  ', JSON.stringify(l)));

  // ── 诊断 2：盾向伤害方向 ──
  const d2 = await ev(`(() => {
    const D = ${EXPORT}, R = D.run;
    const probe = (vx, vy, dir, label) => {
      R.enemies.length = 0;
      R.enemies.push({ x:260, y:300, vx:0, vy:0, r:16, hp:9000, maxHp:9000,
        shieldDir:dir, baseDir:dir, shieldRot:0, spin:0, flash:0,
        dead:false, col:'#4a7c6f', fireCd:9999, boss:false });
      R.balls.length = 0;
      const ball = D.mkBall(260, 300, 0);
      ball.age = 999; ball.vx = vx; ball.vy = vy;
      R.balls.push(ball);
      const hp0 = R.enemies[0].hp;
      D.step(1);
      return { label, vx, shieldDir: dir, dmg: +(hp0 - R.enemies[0].hp).toFixed(1) };
    };
    return { list: [
      probe( 6, 0, 0, '盾朝+x / 弹朝+x'),
      probe(-6, 0, 0, '盾朝+x / 弹朝-x'),
      probe( 6, 0, Math.PI, '盾朝-x / 弹朝+x'),
      probe(-6, 0, Math.PI, '盾朝-x / 弹朝-x'),
    ]};
  })()`);
  console.log('\n=== 诊断2：盾向伤害（期望：同向=正面低，反向=背面高）===');
  d2.list.forEach(r => console.log('  ', JSON.stringify(r)));

  ws.close(); proc.kill(); srv.close(); rmTree(profile);
  console.log('\n诊断完成');
  process.exit(0);
})().catch(e => { console.error('崩溃:', e); process.exit(2); });

function connect(url) {
  const u = new (require('url').URL)(url);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13' },
    });
    req.on('upgrade', (rs, socket) => {
      let buf = Buffer.alloc(0);
      const api = {
        onMessage: null,
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
          const data = buf.slice(off, off + len); buf = buf.slice(off + len);
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