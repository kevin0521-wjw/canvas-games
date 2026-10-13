/**
 * D 段探针的最小诊断：为什么「999 伤害的子弹打不死 hp=1 的敌人」。
 * 分母错了算出来的掉率就是假的，必须先钉死「到底能不能打死」。
 */
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FILE = path.resolve(__dirname, '../starlane-v2/index.html');
const PORT = 9671, CDP_PORT = 9771;
const LOGF = path.resolve(__dirname, 'ddiag.log');
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
  const profile = path.resolve(__dirname, '_ddiagprof');
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

  out('【诊断】hp=1 敌人 + 999 伤害子弹，逐帧看它到底发生什么');
  const d = await evaluate(`(() => {
    const D = __SL, rows = [];
    D.start(); D.freeze(); D.step(2);
    rows.push({帧:0, scene:D.run.scene, over:D.run.over, choosing:D.run.choosing,
               note:'step() 只在 scene==play && !over && !choosing 时推进'});
    D.run.noSpawn = true; D.clearRoom(); D.invuln();
    const e = D.mkEnemy(300, 200, { hp: 1 });
    e.alive = true; D.enemies.push(e);
    rows.push({帧:0, 敌hp:e.hp, maxHp:e.maxHp, 敌r:e.r, alive:e.alive,
               enemies数组:D.enemies.length, 分数:D.run.score});
    for (let k = 1; k <= 14; k++) {
      const s = D.mkShot(e.x - 20, e.y, 0, 8, 999, 0, '#fff');
      D.playerShots.push(s);
      const beforeShots = D.playerShots.length;
      D.step(1);
      rows.push({帧:k, 敌hp:+(e.hp||0).toFixed(1), alive:e.alive,
                 弹数:D.playerShots.length, 新弹初速:'—',
                 分数:D.run.score, 未开箱舱:D.crates.filter(c=>!c.opened).length});
    }
    return rows;
  })()`);
  for (const r of d) out('  ' + JSON.stringify(r));

  out('');
  out('【对照】直接调 __SL.damageEnemy 能不能打死');
  const d2 = await evaluate(`(() => {
    const D = __SL;
    D.start(); D.freeze(); D.step(2);
    D.run.noSpawn = true; D.clearRoom();
    const e = D.mkEnemy(300, 200, { hp: 1 }); D.enemies.push(e);
    const n0 = D.run.score, c0 = D.crates.length;
    const s = { x: e.x - 10, y: e.y, vx: 8, vy: 0, dmg: 999, pierce: 0 };
    D.damageEnemy(e, s);
    return { 打死:e.hp<=0, alive:e.alive, 分数变化:D.run.score-n0,
             新增crates:D.crates.length-c0,
             未开箱舱:D.crates.filter(c=>!c.opened).length };
  })()`);
  out('  ' + JSON.stringify(d2));

  out('');
  out('【查 mkShot 签名】');
  out('  ' + await evaluate(`__SL.mkShot.toString().slice(0, 420)`));

  out('');
  out('【查 updateShots 命中判定的守卫】');
  out('  ' + await evaluate(`__SL.hitWith.toString().slice(0, 200)`));

  out('\n未捕获异常：' + (errs.length ? errs.slice(0,3).join(' | ') : '（无）'));
  try { ws.close(); } catch(e){}
  killTree(proc.pid); sleepSync(700);
  try { srv.close(); } catch(e){}
  dropProfile(profile);
  try { process.stdout.write(""); } catch (e) {}   // 冲刷，别丢掉刚写的结论
})().catch(e => { out('崩溃: ' + e.stack); process.exit(2); });