/**
 * C 段 AI 长跑的归因探针：AI 到底死在哪一帧、那一帧发生了什么。
 *
 * 第三代探针给出「AI 只到第 2 关、残机全灭」，但没说是被弹幕打死、
 * 还是被杂兵撞死、还是卡在某张符卡前耗光残机。三种原因对应完全不同的修法：
 *   · 弹幕太密 → 调弹幕参数
 *   · 数值不够 → 残机/回复
 *   · AI 决策不到位 → 这是 AI 的问题，不是游戏的
 * 所以先归因，再决定动不动数值。
 */
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FILE = path.resolve(__dirname, '../starlane-v2/index.html');
const PORT = 9681, CDP_PORT = 9781;
const LOGF = path.resolve(__dirname, 'aidianose.log');
try { fs.unlinkSync(LOGF); } catch (e) {}
const out = s => { fs.appendFileSync(LOGF, s + '\n'); process.stdout.write(s + '\n'); };

const srv = http.createServer((q, s) => { s.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}); s.end(fs.readFileSync(FILE)); });
const get = p => new Promise((res, rej) => {
  http.get({ host:'127.0.0.1', port:CDP_PORT, path:p }, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(JSON.parse(d))); }).on('error', rej);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
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
    const req = http.request({ host:u.hostname, port:u.port, path:u.pathname,
      headers:{ Connection:'Upgrade', Upgrade:'websocket',
        'Sec-WebSocket-Key':crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version':'13' } });
    req.on('upgrade', (rs, socket) => {
      let buf = Buffer.alloc(0);
      const api = { onMessage:null,
        send(str){ const p=Buffer.from(str),L=p.length; let h;
          if(L<126) h=Buffer.from([0x81,0x80|L]);
          else if(L<65536){h=Buffer.alloc(4);h[0]=0x81;h[1]=0x80|126;h.writeUInt16BE(L,2);}
          else{h=Buffer.alloc(10);h[0]=0x81;h[1]=0x80|127;h.writeBigUInt64BE(BigInt(L),2);}
          const m=crypto.randomBytes(4), mk=Buffer.from(p);
          for(let i=0;i<L;i++) mk[i]^=m[i&3];
          socket.write(Buffer.concat([h,m,mk])); },
        close(){ try{socket.destroy();}catch(e){} } };
      socket.on('data', chunk => { buf=Buffer.concat([buf,chunk]);
        while(buf.length>=2){ const op=buf[0]&0x0f, l0=buf[1]&0x7f; let off=2,pl=l0;
          if(l0===126){ if(buf.length<4)return; pl=buf.readUInt16BE(2); off=4; }
          else if(l0===127){ if(buf.length<10)return; pl=Number(buf.readBigUInt64BE(2)); off=10; }
          if(buf.length<off+pl)return;
          const pay=buf.slice(off,off+pl); buf=buf.slice(off+pl);
          if(op===8){ try{socket.destroy();}catch(e){} return; }
          if(op===1&&api.onMessage) api.onMessage(pay); } });
      socket.on('error', reject);
      resolve(api);
    });
    req.on('error', reject); req.end();
  });
}

(async () => {
  await new Promise(r => srv.listen(PORT, '127.0.0.1', r));
  const profile = path.resolve(__dirname, '_aidprof');
  if (fs.existsSync(profile)) { dropProfile(profile); }
  const proc = spawn(EDGE, ['--headless=new','--disable-gpu','--no-sandbox','--mute-audio',
    `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir='+profile,
    `http://127.0.0.1:${PORT}/g.html`], { stdio:'ignore' });
  let tab=null; const dl=Date.now()+45000;
  while(Date.now()<dl){ try{ const t=await get('/json/list'); tab=t.find(x=>x.type==='page'&&x.url.includes('/g.html')); if(tab&&tab.webSocketDebuggerUrl)break; }catch(e){} await sleep(400); }
  if(!tab){ out('❌ 无页面'); process.exit(1); }
  const ws = await connect(tab.webSocketDebuggerUrl);
  let id=0; const pending=new Map(); const errs=[];
  ws.onMessage = raw => { const m=JSON.parse(raw.toString());
    if(m.id&&pending.has(m.id)){ pending.get(m.id)(m); pending.delete(m.id); }
    else if(m.method==='Runtime.exceptionThrown'){ const d=m.params.exceptionDetails;
      errs.push((d.exception&&(d.exception.description||d.exception.value))||d.text); } };
  const send=(method,params)=>new Promise(r=>{ const i=++id; pending.set(i,r); ws.send(JSON.stringify({id:i,method,params:params||{}})); });
  const evaluate=async expr=>{ const r=await send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true});
    if(r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description||'eval failed');
    return r.result?.result?.value; };
  await send('Runtime.enable'); await send('Page.enable');
  await sleep(1500);

  out('【归因】AI 每一次失机的现场快照');

  const r = await evaluate(`(() => {
    const D = __SL;
    D.start(); D.freeze(); D.step(2);
    if (!D.AI.on) D.toggleAI();
    const snaps = [];
    let prevLives = D.pl.lives, f = 0;
    let lastBoss = null, lastCard = null;
    for (; f < 30000 && !D.run.over; f++) {
      const before = { stage: D.run.stage, lives: D.pl.lives, bullets: D.bullets.length,
                       lasers: D.lasers.length, enemies: D.enemies.length, bombs: D.pl.bombs,
                       bossCard: D.boss && D.boss.card ? D.boss.card.name : null,
                       bossHp: D.boss ? Math.round(D.boss.cardHp) : null,
                       bossCards: D.boss ? D.boss.ci + 1 : null,
                       bx: D.boss ? Math.round(D.boss.x) : null,
                       by: D.boss ? Math.round(D.boss.y) : null,
                       plx: Math.round(D.pl.x), ply: Math.round(D.pl.y),
                       crates: D.crates.filter(c => !c.opened).length,
                       upgrades: D.WS.dmg1 ? +D.WS.dmg1.toFixed(2) : null };
      D.step(1);
      if (D.pl.lives < prevLives) {
        snaps.push(Object.assign({ 失机于帧: f, 死时关卡: before.stage,
                                   失机后残机: D.pl.lives, 死前30帧在场弹: before.bullets,
                                   死前30帧激光: before.lasers, 死前30帧杂兵: before.enemies,
                                   死前炸弹: before.bombs,
                                   死时在打: before.bossCard, 该卡剩余血: before.bossHp,
                                   这是第几张: before.bossCards,
                                   场上补给舱: before.crates }));
        prevLives = D.pl.lives;
      }
    }
    if (D.AI.on) D.toggleAI();
    return { 存活帧: f, 存活秒: +(f/60).toFixed(1), 最远关: D.run.stage,
             失机次数: snaps.length, 快照: snaps };
  })()`);
  out(`  AI 存活 ${r.存活秒} 秒，到第 ${r.最远关} 关，失机 ${r.失机次数} 次`);
  out('  帧    关  残机  弹  激光 杂兵 炸弹  在打的符卡            卡血  第几张  舱');
  for (const s of r.快照) {
    out(`  ${String(s.失机于帧).padStart(6)}${String(s.死时关卡).padStart(4)}` +
        `${String(s.失机后残机).padStart(6)}${String(s.死前30帧在场弹).padStart(5)}` +
        `${String(s.死前30帧激光).padStart(6)}${String(s.死前30帧杂兵).padStart(6)}` +
        `${String(s.死前炸弹).padStart(6)}  ${String(s.死时在打 || '—').padEnd(20)}` +
        `${String(s.该卡剩余血 != null ? s.该卡剩余血 : '—').padStart(6)}` +
        `${String(s.这是第几张 != null ? s.这是第几张 : '—').padStart(8)}` +
        `${String(s.场上补给舱).padStart(5)}`);
  }

  out('');
  out('【对照】同一个种子，AI 关 vs 人完全不操作，各跑一遍比存活');
  const cmp = await evaluate(`(() => {
    const D = __SL;
    const run = (useAI) => {
      D.start(); D.freeze(); D.step(2);
      if (useAI && !D.AI.on) D.toggleAI();
      if (!useAI && D.AI.on) D.toggleAI();
      let f = 0;
      for (; f < 30000 && !D.run.over; f++) D.step(1);
      return { 存活帧: f, 存活秒: +(f/60).toFixed(1), 关: D.run.stage,
               得分: D.run.score, 击破: D.run.cleared };
    };
    const a = run(true), b = run(false);
    if (D.AI.on) D.toggleAI();
    return { AI: a, 不操作: b };
  })()`);
  out('  ' + JSON.stringify(cmp));

  out('');
  out('【残机上限 & 补给舱能不能续命】');
  out('  ' + await evaluate(`(() => {
    const D = __SL;
    D.start(); D.freeze(); D.step(2);
    return { 初始残机: D.pl.lives, 初始炸弹: D.pl.bombs,
             残机是否可超上限: '见 newRun()' };
  })()`));

  out('\n未捕获异常：' + (errs.length ? errs.slice(0,3).join(' | ') : '（无）'));
  try { ws.close(); } catch(e){}
  killTree(proc.pid); sleepSync(700);
  try { srv.close(); } catch(e){}
  dropProfile(profile);
  try { process.stdout.write(""); } catch (e) {}   // 冲刷，别丢掉刚写的结论
})().catch(e => { out('崩溃: ' + e.stack); process.exit(2); });