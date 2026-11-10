/** AI 压力测试 / 参数扫描工具（不是判据；判据是同目录的 smoke.js）。
 *
 *  用途：
 *    · 跑 N 轮「纯 AI 操作」到通关/阵亡，统计通关率、存活帧数中位数；
 *    · 打印每次阵亡的复盘：死前 16 帧的玩家坐标 + 最近弹距离，
 *      以及那一帧 aiSteer() 自己以为的最近威胁（AI.dbg）。
 *      「AI 以为 100px 安全、实际弹已到 11px」这个 bug 就是这么抓出来的。
 *    · 用环境变量做参数扫描，不用改游戏代码：
 *        CONFIGS='[{"n":"x","t":{"objDot":30}}]' RUNS=9 TUNE='{"hor":26}' \
 *          node verify/diag.js index.html
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FILE = path.resolve(process.argv[2] || '../index.html');
const PORT = 9541 + (crypto.randomBytes(1)[0] % 30);
const CDP_PORT = PORT + 100;
const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(FILE));
});
function get(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sleepSync = ms => { const a = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(a, 0, 0, ms); };
function killTree(proc) {
  try { require('child_process').execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); } catch (e) {}
  try { proc.kill(); } catch (e) {}
  sleepSync(500);
}
(async () => {
  await new Promise(r => srv.listen(PORT, '127.0.0.1', r));
  const profile = path.resolve(__dirname, '_aiprof');
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
    `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
    '--window-size=900,1000', `http://127.0.0.1:${PORT}/g.html`], { stdio: 'ignore' });
  let tab = null; const dl = Date.now() + 45000;
  while (Date.now() < dl) {
    try { const ts = await get('/json/list'); tab = ts.find(t => t.type === 'page' && t.url.includes('/g.html')); if (tab && tab.webSocketDebuggerUrl) break; } catch (e) {}
    await sleep(400);
  }
  if (!tab) { console.log('no tab'); killTree(proc); srv.close(); process.exit(1); }
  const ws = await connect(tab.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.onMessage = raw => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
    return r.result?.result?.value;
  };
  await send('Runtime.enable'); await send('Page.enable');
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) { await sleep(200); try { ready = await evaluate('typeof window.__DM !== "undefined"'); } catch (e) {} }
  if (!ready) { console.log('not ready'); killTree(proc); srv.close(); process.exit(1); }

  const tune = process.env.TUNE || '';
  if (tune) {
    const r = await evaluate('(() => { const t = window.__DM.AI.tune; Object.assign(t, ' + tune + '); return t; })()');
    console.log('tune =', JSON.stringify(r));
  }

  // ── A. 关卡链条（带轨迹） ──
  const chain = await evaluate(`(() => {
    const D = window.__DM;
    D.start(); D.freeze(); D.step(2);
    D.player.invuln = 99999;
    const trace = []; const names = [];
    let guard = 0;
    for (let st = 1; st <= D.STAGES.length && !D.run.cleared && guard++ < 12; st++) {
      const hadBoss = !!D.boss;
      if (!D.boss) D.gotoStage(st);
      // gotoStage 只是把 waveN 设成 99，Boss 要等下一帧 updateWaves 才真正出现
      for (let i = 0; i < 300 && !D.boss; i++) D.step(1);
      let waited = 0;
      while (waited < 1500 && D.boss && !D.run.cleared && D.boss.state !== 'fight') { D.step(1); waited++; }
      trace.push({ st, hadBoss, afterGoto: D.boss ? D.boss.state : 'none', waited,
                   boss: D.boss ? D.boss.state : 'none', ci: D.boss ? D.boss.ci : -9,
                   card: D.boss && D.boss.card ? D.boss.card.name : null });
      let g = 0;
      while (D.boss && !D.run.cleared && g++ < 4000) {
        D.enemies.length = 0;
        if (D.boss.state === 'fight') {
          if (D.boss.card) names.push(D.boss.card.name);
          D.damageBoss(60, D.boss.x, D.boss.y);
        }
        D.step(1);
      }
      trace.push({ st, endBoss: D.boss ? D.boss.state : 'none', stage: D.run.stage, loop: g });
    }
    const uniq = names.filter((n, i, a) => a.indexOf(n) === i);
    return { cleared: D.run.cleared, stage: D.run.stage, cards: uniq.length,
             last: uniq[uniq.length - 1] || null, trace: JSON.stringify(trace).slice(0, 900) };
  })()`);
  console.log('【链条】', JSON.stringify(chain));

  // ── B. AI 长跑（可多组参数扫） ──
  const configs = JSON.parse(process.env.CONFIGS ||
    '[{"n":"base"}]');
  for (const cfg of configs) {
    const ai = await evaluate(`(() => {
      const D = window.__DM;
      ${cfg.t ? 'Object.assign(D.AI.tune, ' + JSON.stringify(cfg.t) + ');' : ''}
      const runs = [];
      const RN = ${process.env.RUNS || 5};
      for (let r = 0; r < RN; r++) {
        D.start(); D.freeze();
        if (D.SPEED !== 1) D.toggleSpeed();
        if (!D.AI.on) D.toggleAI();
        let f = 0, bombsUsed = 0, lastBombs = 3, maxB = 0;
        const marks = [];
        const buf = [];
        const deathsAt = [];
        let lastDeaths = 0;
        // 帧前/帧后的「最近一发弹」快照：用来判断杀死 AI 的那发弹是
        // 「本帧 movePlayer 之后才新建出来的」（AI 前瞻里根本不存在）
        // 还是「一直在场上、AI 却算错了」。
        const hist = [];
        const nearOf = () => {
          let b = null, d = 1e9;
          for (const q of D.bullets) {
            if (q.delay > 0) continue;
            const dd = Math.hypot(q.x - D.player.x, q.y - D.player.y) - q.r - 3.5;
            if (dd < d) { d = dd; b = q; }
          }
          return b ? { d: Math.round(d), x: Math.round(b.x), y: Math.round(b.y),
                       dx: Math.round(b.x - D.player.x), dy: Math.round(b.y - D.player.y),
                       vx: +b.vx.toFixed(2), vy: +b.vy.toFixed(2), r: b.r,
                       shape: b.shape, split: !!b.split } : { d: null };
        };
        while (f < 30000 && !D.run.over && !D.run.cleared) {
          // 帧前给所有已存在的弹打上时间戳 —— 用来判断杀死 AI 的那发弹
          // 到底是「上一帧就在场上」（AI 应该看得到）还是「本帧 movePlayer 之后
          // 才被 updateEnemies/updateBullets 新建出来的」（AI 前瞻里根本不存在）。
          for (const q of D.bullets) q.__seen = f;
          const pre = { f, px: Math.round(D.player.x), py: Math.round(D.player.y), nb: nearOf() };
          D.step(1);
          if (D.player.bombs < lastBombs) bombsUsed++;
          lastBombs = D.player.bombs;
          let near = 999;
          for (const q of D.bullets) {
            if (q.delay > 0) continue;
            const dd = Math.hypot(q.x - D.player.x, q.y - D.player.y) - q.r - 3.5;
            if (dd < near) near = dd;
          }
          buf.push({ f, x: Math.round(D.player.x), y: Math.round(D.player.y),
                     near: Math.round(near), n: D.bullets.length });
          if (buf.length > 16) buf.shift();
          hist.push(pre); if (hist.length > 14) hist.shift();
          if (D.run.deaths > lastDeaths) {
            lastDeaths = D.run.deaths;
            const g = D.AI.dbg || {};
            // 找出「杀死 AI 的那发弹」：离玩家最近的一发，连同它的来源信息
            let kb = null, kd = 1e9;
            for (const q of D.bullets) {
              const dd = Math.hypot(q.x - D.player.x, q.y - D.player.y) - q.r - 3.5;
              if (dd < kd) { kd = dd; kb = q; }
            }
            const kinfo = kb ? {
              d: Math.round(kd), fresh: kb.__seen === undefined, // true = 本帧才生成
              dx: Math.round(kb.x - D.player.x), dy: Math.round(kb.y - D.player.y),
              vx: +kb.vx.toFixed(2), vy: +kb.vy.toFixed(2), r: kb.r,
              shape: kb.shape || null, col: kb.c ? (kb.c.glow || kb.c) : null,
              delay: kb.delay } : null;
            deathsAt.push('[死' + f + ' 关' + D.run.stage + '] ' +
              buf.filter((_, i) => i % 2 === 0)
              .map(b => b.f + '@' + b.x + ',' + b.y + ' n' + b.near + '/' + b.n).join(' ') +
              ' || pre=' + JSON.stringify(hist.slice(-5)) +
              ' || kb=' + JSON.stringify(kinfo) +
              ' || enemies=' + JSON.stringify(D.enemies.map(e => ({ t: e.type, x: Math.round(e.x), y: Math.round(e.y) }))) +
              ' || dbg=' + JSON.stringify(g));
          }
          if (f % 1500 === 0) marks.push((D.boss ? (D.boss.card ? D.boss.card.name.slice(0,2) : D.boss.state.slice(0,4)) : '波') + ':命' + D.player.lives + ':弹' + D.player.bombs);
          f++;
        }
        runs.push({ f, over: D.run.over, cleared: D.run.cleared, stage: D.run.stage,
                    deaths: D.run.deaths, lives: Math.max(0, D.player.lives),
                    grazed: D.run.grazed, spells: D.run.spellCleared, bombsUsed,
                    marks: marks.join(' '), deathsAt: deathsAt.slice(0, 2) });
      }
      if (D.AI.on) D.toggleAI();
      const s = runs.map(r => r.f).sort((a,b)=>a-b);
      return { runs, med: s[2], cleared: runs.filter(r => r.cleared).length,
               s2: runs.filter(r => r.stage >= 2).length, s3: runs.filter(r => r.stage >= 3).length };
    })()`);
    console.log('【AI ' + cfg.n + '】中位 ' + ai.med + ' 帧；到2关 ' + ai.s2 + '/5；到3关 ' + ai.s3 + '/5；通关 ' + ai.cleared + '/5');
    for (const r of ai.runs) console.log('   ' + r.f + '帧 ' + (r.cleared?'通关':r.over?'阵亡':'超时') + ' 第' + r.stage + '关 失机' + r.deaths + ' 炸' + r.bombsUsed + ' 擦' + r.grazed + ' | ' + r.marks);
    for (const r of ai.runs.slice(0, 2)) for (const d of r.deathsAt) console.log('      💀 ' + d);
  }

  try { ws.close(); } catch (e) {}
  killTree(proc); srv.close();
  try { require('child_process').execFileSync('cmd', ['/c', 'rmdir', '/s', '/q', profile], { stdio: 'ignore' }); } catch (e) {}
  await new Promise(r => process.stdout.write('', () => r()));
  process.exit(0);
})().catch(e => { console.error('崩溃:', e); process.exit(2); });

function connect(url) {
  const u = new (require('url').URL)(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' } });
    req.on('upgrade', (rs, socket) => {
      let buf = Buffer.alloc(0);
      const api = { onMessage: null,
        send(str) {
          const payload = Buffer.from(str); const len = payload.length; let head;
          if (len < 126) head = Buffer.from([0x81, 0x80 | len]);
          else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
          else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
          const mask = crypto.randomBytes(4); const masked = Buffer.from(payload);
          for (let i = 0; i < len; i++) masked[i] ^= mask[i & 3];
          socket.write(Buffer.concat([head, mask, masked]));
        },
        close() { try { socket.destroy(); } catch (e) {} } };
      socket.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
          const op = buf[0] & 0x0f; let len = buf[1] & 0x7f, off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) return;
          const data = buf.slice(off, off + len); buf = buf.slice(off + len);
          if (op === 1 && api.onMessage) api.onMessage(data);
          else if (op === 8) { api.close(); return; }
        }
      });
      socket.on('error', reject); resolve(api);
    });
    req.on('error', reject); req.end();
  });
}
