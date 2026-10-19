/**
 * 诊断脚本：直接查运行时状态，不猜。
 *
 * 元气骑士开局崩在 `map[g.y0+g.gh-1][dx] = DOOR`（"Cannot set properties of undefined"），
 * 静态读代码看不出问题（索引算下来明明在范围内）。
 * → 只能把真实运行时的 map / rooms / ROWS 打出来看。
 *
 * 用法：node verify/diag.js ../index.html __SK
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.resolve(process.argv[2] || '../index.html');
const EXPORT = process.argv[3] || '__SK';
const PORT = 9500 + (crypto.randomBytes(1)[0] % 40);
const CDP = PORT + 100;

const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(FILE));
});
const get = p => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: CDP, path: p }, r => {
    let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
  }).on('error', rej);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await new Promise(r => srv.listen(PORT, '127.0.0.1', r));
  const profile = path.resolve(__dirname, '_diagprof');
  const proc = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ['--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
     `--remote-debugging-port=${CDP}`, '--user-data-dir=' + profile,
     `--window-size=1000,900`, `http://127.0.0.1:${PORT}/g.html`],
    { stdio: 'ignore' });

  let tab = null;
  const dl = Date.now() + 45000;
  while (Date.now() < dl) {
    try {
      const tabs = await get('/json/list');
      tab = tabs.find(t => t.type === 'page' && t.url.includes('/g.html'));
      if (tab?.webSocketDebuggerUrl) break;
    } catch (e) {}
    await sleep(400);
  }
  if (!tab) { console.log('❌ 没找到页面'); proc.kill(); srv.close(); process.exit(1); }

  const ws = await connect(tab.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  const errs = [];
  ws.onMessage = raw => {
    const m = JSON.parse(raw.toString());
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errs.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
    }
  };
  const send = (method, params) => new Promise(r => {
    const i = ++id; pend.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  const ev = async e => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true });
    if (r.result?.exceptionDetails) {
      return { __err: r.result.exceptionDetails.exception?.description?.split('\n')[0] };
    }
    return r.result?.result?.value;
  };
  await send('Runtime.enable');
  await sleep(1500);

  console.log('=== 1. 关键常量 ===');
  console.log(await ev(`({ export: typeof ${EXPORT}, T: window.T, COLS: window.COLS, ROWS: window.ROWS,
    FLOOR: window.FLOOR, WALL: window.WALL, DOOR: window.DOOR })`));

  console.log('=== 2. 尝试 start（抓真实报错）===');
  const st = await ev(`(() => { try { ${EXPORT}.start(); return { ok: true }; }
    catch (e) { return { ok: false, msg: e.message, stack: (e.stack||'').split('\\n').slice(0,4) }; } })()`);
  console.log(st);
  console.log('未捕获异常:', errs.slice(0, 3));

  console.log('=== 3. 运行时真实状态 ===');
  console.log(await ev(`(() => {
    try {
      const D = ${EXPORT};
      return {
        mapIsArray: Array.isArray(D.run.map || (typeof map !== 'undefined' ? map : null)),
        curRoom: D.run.curRoom,
        roomsLen: (D.run.rooms || []).length,
        room0: (D.run.rooms || [])[0],
      };
    } catch (e) { return { err: e.message }; }
  })()`));

  // 直接查模块级变量（它们不在导出对象里）
  console.log('=== 4. 模块级变量探测 ===');
  for (const name of ['map', 'rooms', 'ROWS', 'COLS', 'curRoom', 'pl']) {
    console.log(name, '=', await ev(`(() => { try {
      const v = eval('${name}');
      if (Array.isArray(v)) return { type: 'array', len: v.length,
        firstRowLen: v[0] ? v[0].length : null };
      if (v && typeof v === 'object') return { type: 'object', keys: Object.keys(v).slice(0, 12) };
      return { type: typeof v, value: v };
    } catch (e) { return { err: e.message }; } })()`));
  }

  // ═══ 5. 射击链路逐步探查 ═══
  // 判据报「场上 0 颗弹 / vx=0」，逐帧推演代码太低效，直接看每一步的实际值。
  console.log('=== 5. 射击链路 ===');
  console.log(await ev(`(() => {
    const D = ${EXPORT};
    D.start(); D.freeze(); D.step(2);
    const P = D.pl;
    P.deadT = 9999; P.dmg = 10; P.shots = 1; P.spread = 0; P.cd = 13;
    P.shootT = 0;
    D.clearRoom(); D.bullets.length = 0;
    D.warp(320, 224);
    const tgt = { kind:'slime', x:320, y:180, r:12, hp:10, maxHp:10,
      spd:0, dmg:1, col:'#5ec8ff', score:10, t:0, fireT:9999, flash:0,
      knock:0, kx:0, ky:0, alive:true, boss:false };
    D.enemies.push(tgt);
    const before = { scene: D.run.scene, over: D.run.over, paused: D.run.paused,
                     choosing: D.run.choosing, nEnemies: D.enemies.length };
    D.key('j', true);
    const keyState = { j: eval('P')['j'] };
    D.step(1);
    const after1 = { nBullets: D.bullets.length, shootT: P.shootT,
                     plx: Math.round(P.x), ply: Math.round(P.y),
                     bulletSpd: P.bulletSpd, cd: P.cd };
    // ★ 逐帧采样：看子弹到底是"没生成"、"生成即消"还是"飞过头"
    const trace = [];
    for (let i = 0; i < 8; i++) {
      D.step(1);
      const b0 = D.bullets[0];
      trace.push({ f: i + 2, n: D.bullets.length,
                   b: b0 ? { x: Math.round(b0.x), y: Math.round(b0.y),
                             vy: +b0.vy.toFixed(2), age: b0.age,
                             maxAge: +b0.maxAge.toFixed(1),
                             alive: b0.alive } : null,
                   tHp: tgt.hp });
    }
    D.step(22);
    const after30 = { nBullets: D.bullets.length, tgtHp: tgt.hp,
                      tgtAlive: tgt.alive, enemiesLeft: D.enemies.length };
    D.key('j', false);
    return { before, keyState, after1, trace, after30, tgtMaxHp: tgt.maxHp,
             range: P.range, pierce: P.pierce, blast: P.blast };
  })()`));

  // 玩家到底站在哪、敌人被推到哪了
  console.log('=== 6. 对手位置 ===');
  console.log(await ev(`(() => {
    const D = ${EXPORT};
    return { pl: { x: Math.round(D.pl.x), y: Math.round(D.pl.y), r: D.pl.r },
             enemies: D.enemies.map(e => ({ x: Math.round(e.x), y: Math.round(e.y),
               r: e.r, alive: e.alive, kind: e.kind })),
             bullets: D.bullets.slice(0, 3).map(b => ({ x: Math.round(b.x),
               y: Math.round(b.y), vx: +b.vx.toFixed(2), vy: +b.vy.toFixed(2) })) };
  })()`));

  ws.close(); proc.kill(); srv.close();
  setTimeout(() => process.exit(0), 300);
})();

function connect(url) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname,
      headers: { Connection:'Upgrade', Upgrade:'websocket',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version':'13' } });
    req.on('upgrade', (rs, socket) => {
      let buf = Buffer.alloc(0);
      const api = {
        onMessage: null,
        send(str) {
          const p = Buffer.from(str); const n = p.length; let h;
          if (n < 126) h = Buffer.from([0x81, 0x80 | n]);
          else if (n < 65536) { h = Buffer.alloc(4); h[0]=0x81; h[1]=0x80|126; h.writeUInt16BE(n,2); }
          else { h = Buffer.alloc(10); h[0]=0x81; h[1]=0x80|127; h.writeBigUInt64BE(BigInt(n),2); }
          const m = crypto.randomBytes(4); const d = Buffer.from(p);
          for (let i=0;i<n;i++) d[i] ^= m[i&3];
          socket.write(Buffer.concat([h, m, d]));
        },
        close() { try { socket.destroy(); } catch (e) {} },
      };
      socket.on('data', ch => {
        buf = Buffer.concat([buf, ch]);
        while (buf.length >= 2) {
          const op = buf[0] & 0x0f;
          let len = buf[1] & 0x7f, off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) return;
          const data = buf.slice(off, off+len); buf = buf.slice(off+len);
          if (op === 1 && api.onMessage) api.onMessage(data);
        }
      });
      socket.on('error', reject);
      resolve(api);
    });
    req.on('error', reject); req.end();
  });
}