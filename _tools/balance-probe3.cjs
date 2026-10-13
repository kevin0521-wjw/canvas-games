/**
 * 星轨防线 v2 —— 平衡性探针（第三代，修正版）
 *
 * 第二代（balance-probe2.cjs）报出来的三段「数据」全部不能信，逐条查清如下：
 *
 *   【A】六张符卡全报「没能进到第 1 张」
 *        → 这次是**游戏的测试接口有 bug**，不是游戏 bug：
 *          spawnBoss() 全代码只有 `updateWaves` 里 `waveN > 5` 一个调用点，
 *          而 updateWaves 被 `if (!boss && !run.noSpawn)` 挡住 ⇒ 探针一设
 *          noSpawn=true，Boss 就永不出现。已在 index.html 修 gotoStage()。
 *          另外探针原来靠 `boss.state = 'next'` 跳卡，那是在**猜**状态机内部约定，
 *          已改成调游戏自己的 startCard()（新接口 gotoCard）。
 *
 *   【B】三关难度曲线全是 敌舰数 0 / 平均在场敌 0
 *        → 探针 bug：它设了 noSpawn=true，而那正是「关掉刷怪」的开关，
 *          于是敌舰永远为 0，只剩弹幕（平均 23/105/30）是真的。已改成不设 noSpawn。
 *
 *   【D】补给舱掉率 0.0%（600 次击杀 0 个舱）
 *        → 探针 bug：它造敌人后只 `step(1)` 一帧，而子弹生成在 e.x-20、速度 8px/帧，
 *          1 帧后仍在敌人 r=14 的判定圈外 —— **击杀压根没发生**，
 *          却把循环次数当成击杀数来算掉率。已改成「先确认真打死再计数」。
 *
 *   所以第三代的原则：**任何比率型指标，分母必须是被验证过的事件数，不是循环次数。**
 *
 * 用法：node _tmp/balance-probe3.cjs
 */
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FILE = path.resolve(__dirname, '../starlane-v2/index.html');
const PORT = 9661, CDP_PORT = 9761;
const LOGF = path.resolve(__dirname, 'balance-probe3.log');
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
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13' } });
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
          for (let i = 0; i < len; i++) masked[i] ^= mask[i & 3];
          socket.write(Buffer.concat([head, mask, masked]));
        },
        close() { try { socket.destroy(); } catch (e) {} },
      };
      socket.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
          const op = buf[0] & 0x0f;
          const len0 = buf[1] & 0x7f;
          let off = 2, plen = len0;
          if (len0 === 126) { if (buf.length < 4) return; plen = buf.readUInt16BE(2); off = 4; }
          else if (len0 === 127) { if (buf.length < 10) return; plen = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + plen) return;
          const payload = buf.slice(off, off + plen);
          buf = buf.slice(off + plen);
          if (op === 8) { try { socket.destroy(); } catch (e) {} return; }
          if (op === 1 && api.onMessage) api.onMessage(payload);
        }
      });
      socket.on('error', reject);
      resolve(api);
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  await new Promise(r => srv.listen(PORT, '127.0.0.1', r));
  const profile = path.resolve(__dirname, '_bal3prof');
  if (fs.existsSync(profile)) {
    try { execFileSync('cmd', ['/c', 'rmdir', '/s', '/q', profile], { stdio: 'ignore' }); } catch (e) {}
  }
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
    `--remote-debugging-port=${CDP_PORT}`, '--user-data-dir=' + profile,
    `http://127.0.0.1:${PORT}/g.html`], { stdio: 'ignore' });

  let tab = null; const dl = Date.now() + 45000;
  while (Date.now() < dl) {
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

  const result = {};

  /* ═══ A. 六张符卡逐张验「限时内打不打得掉」 ═══════════════════════════════
     前置：gotoStage() 现在会直接 spawnBoss()（本轮修的接口 bug）。
     跳卡：走新接口 gotoCard(ci)，不猜 boss.state。                        */
  result.A_符卡可达性 = await evaluate(`(() => {
    const D = __SL;
    const runCard = (stage, ci, mode) => {
      D.start(); D.freeze(); D.step(2);
      D.gotoStage(stage);            // 现在直接进 Boss 战
      D.invuln(); D.run.noSpawn = true;
      if (!D.gotoCard(ci)) return { 关: stage, 模式: mode, err: 'gotoCard 失败' };
      // 等 declare(88帧) → fight
      let guard = 0;
      while (guard++ < 400 && !(D.boss && D.boss.state === 'fight')) {
        D.pl.y = D.boss ? D.boss.y : D.pl.y;
        D.step(1);
      }
      if (!D.boss || D.boss.state !== 'fight') return { 关: stage, 模式: mode, err: '等不到 fight' };
      const name = D.boss.card.name, hp0 = D.boss.cardHp, totalF = D.boss.card.timeLeft;
      D.key('z', true); if (mode === 'both') D.key('x', true);
      let f = 0;
      for (; f < totalF + 900 && D.boss && D.boss.state === 'fight'; f++) {
        D.pl.y = D.boss.y;            // 瞄准跟随（第一代探针漏了这条，得出过假结论）
        D.step(1);
      }
      D.key('z', false); D.key('x', false);
      const left = D.boss ? D.boss.card.timeLeft : 0;
      return { 关: stage, 第几张: ci + 1, 模式: mode === 'z' ? '仅Z' : '双开',
               符卡: name, 血量: hp0, 限时帧: totalF, 用帧: f,
               用掉限时: Math.round(f / totalF * 100) + '%',
               结果: left > 0 ? '✅击破' : '❌超时', 剩余帧: left > 0 ? left : 0 };
    };
    const rows = [];
    for (let st = 1; st <= 3; st++)
      for (let ci = 0; ci < 2; ci++) {
        rows.push(runCard(st, ci, 'z'));
        rows.push(runCard(st, ci, 'both'));
      }
    return rows;
  })()`);
  out('\n【A】六张符卡：限时内能否击破（无敌 + 瞄准跟随 + 逐帧固定步长）');
  out('  关 张  模式  血量  限时帧   用帧   用掉   结果  符卡');
  for (const r of result.A_符卡可达性) {
    if (r.err) { out(`  ⚠️ 第${r.关}关 ${r.模式}：${r.err}`); continue; }
    out(`  ${String(r.关).padEnd(3)}${String(r.第几张).padEnd(4)}${String(r.模式).padEnd(5)}` +
        `${String(r.血量).padStart(5)}${String(r.限时帧).padStart(7)}` +
        `${String(r.用帧).padStart(7)}${String(r.用掉限时).padStart(7)}   ${r.结果}  ${r.符卡}`);
  }

  /* ═══ B. 三关难度曲线（**自然推进**，不能用 gotoStage） ═══════════════════
     ⚠️ 第二代在这里拿到「敌舰数 0」，两重原因叠加：
       ① 它设了 noSpawn = true —— 而那正是关掉刷怪的开关；
       ② 更隐蔽：gotoStage() 修好后是「直接 spawnBoss()」，连刷怪阶段都跳过了，
          于是整场测量里根本不存在杂兵，只有 Boss 的弹幕。
       正确做法：从头自然打，靠 waveN 自然推进到 Boss。
       为了在有限帧数内覆盖到杂兵阶段，把每关的测量窗口放到 Boss 出现为止。 */
  result.B_难度曲线 = await evaluate(`(() => {
    const D = __SL;
    const one = (stage, frames) => {
      D.start(); D.freeze(); D.step(2);
      D.run.stage = stage - 1;      // 只挪关卡编号，**不调 gotoStage**（否则跳过刷怪）
      D.run.noSpawn = false;        // ← 刷怪必须开
      D.invuln(); D.key('z', true);
      let sumEn = 0, maxEn = 0, maxBul = 0, sumBul = 0, hpSum = 0, seen = 0, n = 0;
      const ids = new Set();
      for (let i = 1; i <= frames; i++) {
        // 只刷前 2 波杂兵就测（waveN 到 3 为止），保证窗口里测的是杂兵阶段
        if (D.run.waveN > 3) break;
        D.step(1);
        n++;
        D.pl.y = D.boss ? D.boss.y : D.pl.y;
        sumEn += D.enemies.length;
        if (D.enemies.length > maxEn) maxEn = D.enemies.length;
        sumBul += D.bullets.length;
        if (D.bullets.length > maxBul) maxBul = D.bullets.length;
        for (const e of D.enemies) if (!ids.has(e)) { ids.add(e); hpSum += e.hp; }
        if (D.boss) seen = 1;
      }
      D.key('z', false);
      return { 关: stage, 测帧数: n, 秒: +(n/60).toFixed(1), 波次: D.run.waveN,
               出现过敌舰: ids.size, 敌舰总血: Math.round(hpSum),
               平均在场敌: +(sumEn/n).toFixed(2), 峰值在场敌: maxEn,
               平均在场弹: +(sumBul/n).toFixed(1), 峰值敌弹: maxBul,
               进Boss战: seen ? '是' : '否' };
    };
    return [one(1, 1800), one(2, 1800), one(3, 1800)];
  })()`);
  out('\n【B】三关难度曲线（只测杂兵阶段，waveN 到 3 为止；无敌 + 持续开火）');
  out('  关  测帧数   秒  波次   敌舰数  敌舰总血  平均在场敌  峰值敌  平均在场弹  峰值敌弹');
  for (const r of result.B_难度曲线) {
    out(`  ${String(r.关).padEnd(3)}${String(r.测帧数).padStart(6)}${String(r.秒).padStart(6)}` +
        `${String(r.波次).padStart(6)}${String(r.出现过敌舰).padStart(9)}${String(r.敌舰总血).padStart(10)}` +
        `${String(r.平均在场敌).padStart(12)}${String(r.峰值在场敌).padStart(8)}` +
        `${String(r.平均在场弹).padStart(12)}${String(r.峰值敌弹).padStart(10)}`);
  }

  /* ═══ C. AI 长跑（不作弊，AI 走到哪 = 数值把人推到哪） ═══════════════════ */
  result.C_AI长跑 = await evaluate(`(() => {
    const D = __SL;
    const trial = (i) => {
      D.start(); D.freeze(); D.step(2);
      if (!D.AI.on) D.toggleAI();
      let f = 0, maxStage = 0, seenBoss = 0;
      const deathFrames = [];
      for (; f < 30000 && !D.run.over; f++) {
        D.step(1);
        if (D.run.stage > maxStage) maxStage = D.run.stage;
        if (D.boss && D.boss.state === 'fight') seenBoss = 1;
      }
      return { 轮: i, 存活帧: f, 存活秒: +(f/60).toFixed(1), 结束: D.run.over,
               最远关: maxStage, 打到Boss: seenBoss ? '是' : '否',
               剩余残机: D.pl.lives, 失机: D.run.deaths, 击破符卡: D.run.cleared,
               开箱: D.run.cratesOpened, 得分: D.run.score };
    };
    const rows = [trial(1), trial(2)];
    if (D.AI.on) D.toggleAI();
    return rows;
  })()`);
  out('\n【C】AI 接管长跑（上限 30000 帧 = 500 秒/轮，不作弊）');
  out('  轮   存活帧  存活秒  最远关  打Boss  残机  失机  击破符卡  开箱      得分');
  for (const r of result.C_AI长跑) {
    out(`  ${String(r.轮).padEnd(4)}${String(r.存活帧).padStart(7)}${String(r.存活秒).padStart(7)}` +
        `${String(r.最远关).padStart(7)}${String(r.打到Boss).padStart(8)}` +
        `${String(r.剩余残机).padStart(6)}${String(r.失机).padStart(6)}` +
        `${String(r.击破符卡).padStart(9)}${String(r.开箱).padStart(6)}${String(r.得分).padStart(9)}`);
  }

  /* ═══ D. 补给舱掉落经济（**先验证击杀真的发生**，再算掉率） ═══════════════
     ⚠️ 这里踩过一个参数错位的坑：`mkShot` 的签名是
        mkShot(x, y, off, dmg, spd, pierce, col)   ← **第 4 位是伤害、第 5 位是速度**
     我一开始写成 mkShot(x, y, 0, 8, 999, 0)（把速度当伤害传），结果弹速 999px/帧
     一帧就飞出场地被出界判定吃掉 —— 敌人一枪没中，分母却是 600，看起来像「掉率 0%」。
     现在改成「正常弹速 + 高伤害」，并逐帧确认 e.alive 变 false 才计一次击杀。 */
  result.D_掉落经济 = await evaluate(`(() => {
    const D = __SL;
    D.start(); D.freeze(); D.step(2);
    D.run.noSpawn = true; D.clearRoom();
    D.invuln();
    let 尝试 = 0, 确认击杀 = 0, 掉舱 = 0;
    while (确认击杀 < 600 && 尝试 < 4000) {
      尝试++;
      const before = D.crates.filter(c => !c.opened).length;
      const n0 = D.run.score;
      const e = D.mkEnemy(300, 200, { hp: 1 });
      e.alive = true; D.enemies.push(e);
      // 正常弹速 8px/帧、伤害 999 —— 顺序是 (off, dmg, spd)
      for (let k = 0; k < 14 && e.alive; k++) {
        const s = D.mkShot(e.x - 20, e.y, 0, 999, 8, 0, '#fff');
        D.playerShots.push(s);
        D.step(1);
      }
      if (!e.alive && D.run.score > n0) {
        确认击杀++;
        if (D.crates.filter(c => !c.opened).length > before) 掉舱++;
      }
    }
    return { 尝试次数: 尝试, 确认击杀, 掉出的未开箱补给舱: 掉舱,
             实测算掉率: 确认击杀 ? (掉舱 / 确认击杀 * 100).toFixed(1) + '%' : 'N/A',
             理论掉率: '12.0%（本轮从 8% 上调）' };
  })()`);
  out('\n【D】补给舱掉落经济（分母 = 确认击杀数，不是循环次数）');
  out('  ' + JSON.stringify(result.D_掉落经济));

  out('\n未捕获异常：' + (errs.length ? errs.slice(0, 3).join(' | ') : '（无）'));
  fs.writeFileSync(path.resolve(__dirname, 'balance-probe3.json'),
                   JSON.stringify(result, null, 2));

  // 收尾：先出结论（已落盘），再杀浏览器 + 等句柄 + 删 profile + 冲刷 → 退出
  try { ws.close(); } catch (e) {}
  killTree(proc.pid); sleepSync(700);   // 等句柄释放再删，否则 rmdir 会删到一半失败
  try { srv.close(); } catch (e) {}
  dropProfile(profile);
  try { process.stdout.write(""); } catch (e) {}   // 冲刷，别丢掉刚写的结论
  process.exit(0);
})().catch(e => { out('崩溃: ' + e.stack); process.exit(2); });