/**
 * v2 诊断：定位 rollUpgrades 崩溃 + 三个判据失败的原因。
 * 直接读运行时状态，不猜。
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.resolve(process.argv[2] || '../index.html');
const EXPORT = process.argv[3] || '__SL';
const PORT = 9600 + (crypto.randomBytes(1)[0] % 30);
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
  const profile = path.resolve(__dirname, '_v2diagprof');
  const proc = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ['--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
     `--remote-debugging-port=${CDP}`, '--user-data-dir=' + profile,
     '--window-size=1000,900', `http://127.0.0.1:${PORT}/g.html`],
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
  ws.onMessage = raw => {
    const m = JSON.parse(raw.toString());
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  };
  const send = (method, params) => new Promise(r => {
    const i = ++id; pend.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  const ev = async e => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true });
    if (r.result?.exceptionDetails)
      return { __err: r.result.exceptionDetails.exception?.description?.split('\n').slice(0,3).join(' | ') };
    return r.result?.result?.value;
  };
  await send('Runtime.enable');
  await sleep(1500);

  console.log('=== 1. rollUpgrades 直接调用 ===');
  console.log(await ev(`(() => {
    const D = ${EXPORT};
    D.start(); D.freeze(); D.step(2);
    const out = {};
    for (const [n, k] of [[3,'white'],[3,'blue'],[3,'purple'],[3,'red'],[1,'red']]) {
      try {
        const o = D.rollUpgrades(n, k);
        out[n + '/' + k] = o.map(x => x ? x.id : 'UNDEFINED');
      } catch (e) { out[n + '/' + k] = 'ERR: ' + e.message; }
    }
    return out;
  })()`));

  console.log('=== 2. 升级池与等级状态 ===');
  console.log(await ev(`(() => {
    const D = ${EXPORT};
    return { UPGlen: D.UPG ? D.UPG.length : 'n/a',
             levels: JSON.stringify(D.pl.levels),
             hasUndefinedInPool: D.UPG ? D.UPG.filter(x => !x).length : 'n/a' };
  })()`));

  console.log('=== 3. 符卡时限单位（v2 是否也修过）===');
  console.log(await ev(`(() => {
    const D = ${EXPORT};
    D.start(); D.freeze(); D.step(2);
    D.gotoStage(1);
    for (let i = 0; i < 200 && !D.boss; i++) D.step(1);
    for (let i = 0; i < 300 && D.boss && D.boss.state !== 'fight'; i++) D.step(1);
    const b = D.boss;
    return b ? { state: b.state, timeLeft: b.card.timeLeft, timeSec: b.card.timeSec,
                 time: b.card.time, hp: b.cardHp, cardHpMax: b.card.hp,
                 ci: b.ci, move: b.card.move, isx: Math.round(b.is.x), sy: Math.round(b.sy) }
             : 'no boss';
  })()`));

  console.log('=== 4. 小判定点：弹的轨迹与距离 ===');
  console.log(await ev(`(() => {
    const D = ${EXPORT}, P = D.pl;
    D.start(); D.freeze(); D.step(2);
    P.deadT = 9999; P.hp = 3;
    D.run.noSpawn = true; D.enemies.length = 0;
    P.lives = 3; P.dead = 0; P.invuln = 0;
    D.run.deaths = 0; D.run.over = false;
    D.warp(200, 400);
    const C0 = 200 - 16 * Math.SQRT2;
    const b = D.mkBullet(140, 140 + C0, 0, 0.5, { c:'blue', r:6 });
    b.age = 99; b.vx = 0.5; b.vy = 0.5;
    D.bullets.push(b);
    let minDist = 999, n0 = D.bullets.length;
    const trace = [];
    for (let i = 0; i < 200; i++) {
      D.step(1);
      const cur = D.bullets[0];
      if (!cur) { trace.push({ f: i, gone: true }); break; }
      const d = Math.hypot(cur.x - D.pl.x, cur.y - D.pl.y);
      minDist = Math.min(minDist, d);
      if (i % 40 === 0) trace.push({ f: i, x: Math.round(cur.x), y: Math.round(cur.y),
                                      d: +d.toFixed(1), alive: cur.alive });
    }
    return { pushed: n0, minDist: +minDist.toFixed(1),
             hitR: P.hitR, grazeR: P.grazeR,
             deaths: D.run.deaths, lives: D.pl.lives, trace };
  })()`));

  console.log('=== 5. 注入伤害能不能打掉符卡 ===');
  console.log(await ev(`(() => {
    const D = ${EXPORT};
    D.start(); D.freeze(); D.step(2);
    D.gotoStage(1);
    for (let i = 0; i < 200 && !D.boss; i++) D.step(1);
    for (let i = 0; i < 300 && D.boss && D.boss.state !== 'fight'; i++) D.step(1);
    if (!D.boss) return 'no boss';
    const b = D.boss;
    D.invuln(); D.enemies.length = 0; D.run.score = 0;
    const trace = [];
    let guard = 0;
    while (D.boss && D.boss.state === 'fight' && guard++ < 300) {
      D.enemies.length = 0;
      D.step(1);
      if (D.boss && D.boss.state === 'fight') {
        const bs = D.boss;
        D.damageBoss({ x: bs.x, y: bs.y + 10, vx: 0, vy: -12, dmg: 20 }, bs);
      }
      if (guard % 5 === 0 && D.boss) trace.push({ f: guard, hp: Math.round(D.boss.cardHp),
        st: D.boss.state, sc: D.run.score });
    }
    return { guard, score: D.run.score, state: D.boss ? D.boss.state : 'gone',
             trace };
  })()`));

  console.log('=== 6. 翻滚链路 ===');
  console.log(await ev(`(() => {
    const D = ${EXPORT};
    D.start(); D.freeze(); D.step(2);
    const P = D.pl;          // ← 必须在 start() 之后取（又一次过期引用）
    D.run.choosing = false; D.run.over = false; D.run.paused = false;
    P.hp = 3; P.dead = 0; P.rolling = 0; P.rollT = 0; P.invuln = 0; P.lives = 3;
    D.warp(300, 240);
    const before = { scene: D.run.scene, over: D.run.over, choosing: D.run.choosing };
    P.rollT = 0; P.rolling = 0;
    D.key('Shift', true); D.key('ArrowRight', true);
    const keys = { shift: true };
    D.step(1);
    const afterStep = { rolling: P.rolling, rollT: P.rollT,
                        rx: P.rx, ry: P.ry, x: Math.round(P.x), y: Math.round(P.y),
                        over: D.run.over, scene: D.run.scene };
    D.key('Shift', false); D.key('ArrowRight', false);
    return { before, afterStep, keys };
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