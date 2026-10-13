/**
 * 符卡可达性探针的**前置诊断**：不测平衡，只测「探针自己能不能走到符卡」。
 *
 * 背景：balance-probe2 的 A 段 12 行全是「没能进到第 N 张」。
 * 这既可能是游戏 bug（进不了 Boss 战），也可能是探针把状态机用错了。
 * 第一代探针就误报过一次（把玩家钉在 y=240 → 得出「每张符卡都打满时限」，
 * 其实是探针没瞄准），差点照着假数据改数值。所以先分清是谁的错。
 *
 * 用法：node _tmp/statediag.cjs
 */
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FILE = path.resolve(__dirname, '../starlane-v2/index.html');
const PORT = 9651, CDP_PORT = 9751;
const LOGF = path.resolve(__dirname, 'statediag.log');
try { fs.unlinkSync(LOGF); } catch (e) {}
const out = s => { fs.appendFileSync(LOGF, s + '\n'); process.stdout.write(s + '\n'); };

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

/* 手写最小 WebSocket 客户端（不依赖任何三方包） */
const crypto = require('crypto');
const net = require('net');
/* ---- 收尾工具（由 probe-selfcheck.cjs 插入到各探针里）----
 *
 * 结论在前面已经落盘（写 log + 写 json），所以收尾**必须**异步、不阻塞退出。
 *
 * ⚠️⚠️ 删除到底有多慢，实测结果**完全不可预测**（同一台机器、235~461 个文件）：
 *   · cmd rmdir /s /q —— 一次 229ms；另一次**跑满 30 秒被 SIGTERM 杀掉**
 *     （spawnSync: status=null signal=SIGTERM、stderr 全空 —— 不是权限问题也不是路径
 *      问题，纯粹是慢。而 execFileSync 那次只报 ETIMEDOUT，看不到这个真因，
 *      害我先怀疑了「Edge 没退干净」—— 查进程发现 Edge 其实早退了。）
 *   · Node fs 逐文件删 —— 一次 169,680ms；另一次只要 14ms/文件。
 *   → 所以「找最快的删法」这条路根本走不通。唯一稳定的做法是**别让收尾拖住结果**。
 */
function killTree(pid) {
  try {
    if (process.platform === 'win32')
      require('child_process').execFileSync('taskkill',
        ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 10000 });
  } catch (e) { /* 可能已自己退出，不算错误 */ }
}

/** 同步空转等待。收尾时用（事件循环已经没有活要干了）。
 *  ⚠️ 这个函数必须存在 —— 收尾第一行就是 killTree + sleepSync，
 *     缺了会在 try 之外抛 ReferenceError，**后面的 dropProfile 永远执行不到**。
 *     我就是这么丢了一晚上 profile：结论照打（结论在那之前），
 *     但清理那几行全是死代码。 */
function sleepSync(ms) { const t = Date.now() + ms; while (Date.now() < t); }

/** 同步删 profile（带超时上限，不无限等）。开跑前用 —— 那时还没启动 Edge，
 *  而且反正正要开始跑，多等几秒不影响交付。删不完就交给 detach 版本。 */
function purgeProfileSync(dir, budgetMs) {
  const { execFileSync } = require('child_process');
  if (!fs.existsSync(dir)) return true;
  try {
    execFileSync('cmd', ['/c', 'rmdir', '/s', '/q', dir],
                 { stdio: 'ignore', timeout: budgetMs || 6000 });
  } catch (e) { /* 超时或占用 → 交给异步兜底 */ }
  return !fs.existsSync(dir);
}

/** 异步删 profile（点火即忘）。收尾用 —— 此时 Edge 刚被 kill、文件仍可能被锁，
 *  同步删必然超时，而退出前没时间等。
 *  两层并行、各不阻塞：① 直接 rmdir；② 接力脚本（含逐文件兜底）再删一遍。 */
function dropProfile(dir) {
  const { spawn } = require('child_process');
  if (!fs.existsSync(dir)) return;
  const helper = path.join(__dirname, '_rmprofile.js');
  try {
    const p = spawn('cmd', ['/c', 'rmdir', '/s', '/q', dir],
                    { stdio: 'ignore', detached: true, windowsHide: true });
    p.unref();
    const q = spawn(process.execPath, [helper, dir],
                    { stdio: 'ignore', detached: true, windowsHide: true });
    q.unref();
  } catch (e) {
    console.log('⚠️ profile 清理没启动成功，下次跑之前手动清：' + dir);
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(Number(u.port), u.hostname, () => {
      sock.write(`GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`);
    });
    let handshook = false, buf = Buffer.alloc(0);
    const api = { send, close: () => sock.destroy(), onMessage: null };
    sock.on('error', reject);
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      if (!handshook) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        handshook = true;
        buf = buf.slice(i + 4);
        resolve(api);
      }
      // 解帧：只处理文本帧（本场景用不到分片/掩码之外的复杂情况）
      while (buf.length >= 2) {
        const len0 = buf[1] & 127;
        let off = 2, plen = len0;
        if (len0 === 126) { if (buf.length < 4) return; plen = buf.readUInt16BE(2); off = 4; }
        else if (len0 === 127) { if (buf.length < 10) return; plen = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + plen) return;
        const payload = buf.slice(off, off + plen).toString('utf8');
        buf = buf.slice(off + plen);
        if (api.onMessage) api.onMessage(Buffer.from(payload));
      }
    });
    function send(str) {
      const data = Buffer.from(str, 'utf8');
      const mask = crypto.randomBytes(4);
      const masked = Buffer.from(data); for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
      let head;
      if (data.length < 126) { head = Buffer.from([0x81, 0x80 | data.length]); }
      else if (data.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(data.length, 2); }
      else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(data.length), 2); }
      sock.write(Buffer.concat([head, mask, masked]));
    }
  });
}

(async () => {
  await new Promise(r => srv.listen(PORT, '127.0.0.1', r));
  const profile = path.resolve(__dirname, '_statediagprof');
  if (fs.existsSync(profile)) {
    try { execFileSync('cmd', ['/c', 'rmdir', '/s', '/q', profile], { stdio: 'ignore' }); } catch (e) {}
  }
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
    `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
    `http://127.0.0.1:${PORT}/g.html`], { stdio: 'ignore' });

  let tab = null; const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const tabs = await get('/json/list');
      tab = tabs.find(t => t.type === 'page' && t.url.includes('/g.html'));
      if (tab && tab.webSocketDebuggerUrl) break;
    } catch (e) {}
    await sleep(400);
  }
  if (!tab) { out('❌ 找不到页面'); process.exit(1); }

  const ws = await connect(tab.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const errs = [];
  ws.onMessage = raw => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errs.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
    }
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
  await sleep(1500);

  /* 逐步打印状态机，看 boss.state 到底怎么走 */
  out('【逐步】start → gotoStage(1) → 每 30 帧采样一次 boss 状态');
  const trace = await evaluate(`(() => {
    const D = __SL, rows = [];
    D.start(); D.freeze(); D.step(2);
    rows.push({ 时刻: 'start 后', scene: D.run.scene, paused: D.run.paused,
                over: D.run.over, choosing: D.run.choosing, stage: D.run.stage,
                boss: !!D.boss, note: 'step() 只在 scene==play 时推进' });
    D.gotoStage(1); D.invuln(); D.run.noSpawn = true;
    rows.push({ 时刻: 'gotoStage(1) 后', scene: D.run.scene, stage: D.run.stage,
                boss: !!D.boss, bstate: D.boss ? D.boss.state : null,
                bci: D.boss ? D.boss.ci : null, by: D.boss ? Math.round(D.boss.y) : null });
    for (let f = 1; f <= 600; f++) {
      D.pl.y = D.boss ? D.boss.y : D.pl.y;
      D.step(1);
      if (f % 30 === 0) rows.push({ 时刻: '第' + f + '帧', scene: D.run.scene,
                over: D.run.over, choosing: D.run.choosing,
                boss: !!D.boss, bstate: D.boss ? D.boss.state : null,
                bci: D.boss ? D.boss.ci : null, bcardHp: D.boss ? D.boss.cardHp : null,
                timeLeft: D.boss && D.boss.card ? D.boss.card.timeLeft : null,
                cards: D.boss ? D.boss.cards.length : null });
      if (D.boss && D.boss.ci === 0 && D.boss.state === 'fight') break;
    }
    return rows;
  })()`);
  for (const r of trace) out('  ' + JSON.stringify(r));

  out('');
  out('【卡结构】STAGES 各有多少张符卡 + 每张的 hp/time');
  const cards = await evaluate(`__SL.STAGES.map((s, i) => ({
    关: i + 1, 名: s.name, 张数: s.cards.length,
    卡: s.cards.map(c => c.name + ' hp=' + c.hp + ' time=' + c.time)
  }))`);
  for (const s of cards) { out(`  第${s.关}关 ${s.名}（${s.张数} 张）`); for (const c of s.卡) out('    · ' + c); }

  out('');
  out('【run 字段实测】探针用到的那些名字真的存在吗');
  const fields = await evaluate(`(() => {
    const D = __SL, r = D.run, names = ['cleared','cratesOpened','grazed','deaths','noSpawn','score','stage'];
    const o = {}; for (const n of names) o[n] = (n in r) ? r[n] : '(不存在)';
    o.bossKeys = D.boss ? Object.keys(D.boss).join(',') : '(无 boss)';
    return o;
  })()`);
  out('  ' + JSON.stringify(fields, null, 0));

  out('');
  out('未捕获异常：' + (errs.length ? errs.join(' | ') : '（无）'));

  killTree(proc.pid); sleepSync(700);   // 等句柄释放再删
  srv.close();
  dropProfile(profile);
  // ⚠️ 这里原来没有冲刷 stdout。setTimeout 延时退出（等 srv.close）本身是对的，
  //   但 Node 对管道是异步写，不显式冲刷的话最后那行结论可能丢 ——
  //   而上层脚本正是靠这行读结论的。
  setTimeout(() => {
    try { process.stdout.write(""); } catch (e) {}
    process.exit(0);
  }, 300);
})();