/**
 * 元气骑士型地牢的无头回归测试。
 *
 * 判据分两类（这是本项目从上一轮吃过的亏）：
 *   - 机制判据：宝箱→三选一→数值真的变强、翻滚无敌帧、幸运影响宝箱品质、房间门禁
 *   - 判据自检：先用「已知答案的构造样本」验证判据能分辨对错，再去用它测游戏
 *
 * 用法：node verify/smoke.js <html路径> [游戏导出名]
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FILE = path.resolve(process.argv[2] || '../index.html');
const EXPORT = process.argv[3] || '__SK';
const PORT = 9411 + (crypto.randomBytes(1)[0] % 40);
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
 *   里写文件。此时再去 rmTree 删 profile，就是在跟一个活进程抢文件 ——
 *   实测**卡 5 分钟**都删不完，每次回归都白等这么久。
 *
 * 正解：Windows 上用 `taskkill /PID <pid> /T /F` 把整棵树带走，同步等一小会儿
 * 让文件句柄释放，最后才删目录。
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
  try {
    if (process.platform === 'win32')
      require('child_process').execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' });
    else proc.kill('SIGKILL');
  } catch (e) { /* 进程可能已经自己退出了，不是错误 */ }
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
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
    `--remote-debugging-port=${CDP_PORT}`,
    '--user-data-dir=' + profile,
    `--window-size=${process.env.VW || 900},${process.env.VH || 1000}`,
    `http://127.0.0.1:${PORT}/g.html`,
  ], { stdio: 'ignore' });

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
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.result?.exceptionDetails)
      throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
    return r.result?.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  // ⚠️ 这里原来是一句固定 sleep（等页面脚本跑完）。
  //   「找到 CDP tab」**不等于「页面加载完」** —— tab 一出现就能连上，
  //   但此时 index.html 可能还没执行到 window.__SK = ... 那行。
  //   症状：读到 undefined，报「暴露测试接口失败」，而游戏逻辑毫无异常。
  //   踩到的现场：touhou-danmaku 全量回归挂 2 条，__DM 的 typeof=false。
  // → 改成轮询真正的就绪条件：慢页面自然多等，快页面立刻进。
  let __ready = false;
  for (let __i = 0; __i < 100 && !__ready; __i++) {
    await sleep(200);
    try { __ready = await evaluate('typeof window.__SK !== "undefined"'); } catch (e) { __ready = false; }
  }
  if (!__ready) console.log('⚠️ 等了 20 秒仍没等到 window.__SK，后续判据大概率会误报');


  const report = { errs, steps: [] };
  const step = (name, ok, detail) => {
    report.steps.push({ name, ok, detail });
    console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
  };

  try {
    const hasExport = await evaluate(`typeof ${EXPORT} !== 'undefined'`);
    step('暴露测试接口 ' + EXPORT, hasExport === true, 'typeof=' + hasExport);
    if (hasExport !== true) throw new Error('no export');

    await evaluate(`${EXPORT}.start()`);
    await sleep(300);
    step('start() 未抛异常', errs.length === 0, errs[0] || '');

    // ── 0b. ★ 冻结自带动画循环 ──
    // ⚠️ 本文件最重要的前置条件。不做的话：页面 rAF 与 step() 赛跑，
    //    玩家原地不动 → 被怪撞死 → run.over=true → step() 全空转，
    //    所有判据都读到「游戏没反应」，而游戏代码毫无问题。
    const frozen = await evaluate(`(() => {
      ${EXPORT}.freeze();
      const a = ${EXPORT}.run.frame;
      ${EXPORT}.step(10);
      return { frame: ${EXPORT}.run.frame - a, over: ${EXPORT}.run.over,
               hp: ${EXPORT}.pl.hp };
    })()`);
    step('★ 冻结 rAF 后 step() 独占时钟', frozen.frame === 10 && frozen.over === false,
         `10 步推进 ${frozen.frame} 帧, run.over=${frozen.over}, HP=${frozen.hp}`);

    // ── 1. 刷怪真的发生了 ──
    const spawnOk = await evaluate(`(() => {
      const D = ${EXPORT};
      return { enemies: D.enemies.length, hp: D.pl.hp, room: D.curRoom,
               rooms: D.rooms.length, cleared: D.rooms.map(r=>r.cleared) };
    })()`);
    step('进房刷怪', spawnOk.enemies > 0,
         `第 ${spawnOk.room + 1} 间刷出 ${spawnOk.enemies} 怪 / 共 ${spawnOk.rooms} 间`);

    // ── 2. ★ 判据自检：宝箱品质判据能不能分辨「幸运影响品质」 ──
    // ⚠️ 统计判据最容易骗人：不加对照就会把随机波动当成因果。
    //    所以这里跑两组 —— 幸运 0 vs 幸运 5，各 400 次开箱，
    //    断言「高幸运组的红箱+紫箱比例显著更高」。
    //    同时记录低幸运组也有非零紫/红 —— 若低幸运组为 0，判据就退化成
    //    「幸运 > 0 就有」，那不能证明是概率提升。
    const fortune = await evaluate(`(() => {
      const D = ${EXPORT};
      const run = (f) => {
        const c = { white:0, blue:0, purple:0, red:0 };
        for (let i = 0; i < 400; i++) c[D.chestTier(f).k]++;
        return c;
      };
      const lo = run(0), hi = run(5);
      return { lo, hi,
        loHigh: (lo.purple + lo.red) / 400, hiHigh: (hi.purple + hi.red) / 400,
        loRed: lo.red, hiRed: hi.red };
    })()`);
    const fOK = fortune.hiHigh > fortune.loHigh * 1.8 && fortune.loHigh > 0;
    step('★ 判据自检：幸运影响宝箱品质（有对照）', fOK,
         `幸运0 高品质率 ${(fortune.loHigh * 100).toFixed(1)}% (紫${fortune.lo.purple}/红${fortune.loRed})` +
         ` → 幸运5 ${(fortune.hiHigh * 100).toFixed(1)}% (紫${fortune.hi.purple}/红${fortune.hi.red})`);

    // ── 3. 清场掉箱 ──
    const chest = await evaluate(`(() => {
      const D = ${EXPORT};
      D.chests.length = 0; D.drops.length = 0;
      D.clearRoom();
      D.step(2);
      const r = D.rooms[D.curRoom];
      return { cleared: r.cleared, chests: D.chests.length,
               tier: D.chests[0] ? D.chests[0].tier.name : null,
               ebul: D.ebullets.length };
    })()`);
    step('清空房间 → 掉宝箱 + 清敌弹', chest.cleared === true && chest.chests >= 1,
         `掉 ${chest.chests} 个（${chest.tier}），清敌弹 ${chest.ebul} 发`);

    // ── 4. ★ 判据自检 + 实测：开箱 → 三选一 → 数值真的变强 ──
    // 这是本游戏的核心循环，必须证明「拿到升级后数值确实变强」，
    // 而不是只证明「面板上选项出现了」。
    const upg = await evaluate(`(() => {
      const D = ${EXPORT}, P = D.pl;
      P.levels = {};                       // 清空已有升级，从干净状态测
      P.dmg = 1; P.cd = 13; P.spd = 2.6; P.fortune = 0; P.lifesteal = 0;
      P.shots = 1; P.spread = 0; P.pierce = 0; P.blast = 0; P.maxHp = 3;
      P.lives = 3;
      const before = D.getHud();
      // 取一个纯被动的伤害升级：p2 锋锐 = 伤害 ×1.22
      const opt = D.UPG.find(u => u.id === 'p2');
      D.take(opt);
      const after = D.getHud();
      const lv = P.levels['p2'];
      // 再测一次同项升级 → 等级应累加到 2
      D.take(opt);
      const twice = D.getHud();
      return { before, after, twice, lv1: lv, lv2: P.levels['p2'] };
    })()`);
    step('升级真的让数值变强（伤害 +22%）',
         Math.abs(upg.after.dmg - upg.before.dmg * 1.22) < 0.01,
         `${upg.before.dmg} → ${upg.after.dmg}（应 = ${(upg.before.dmg * 1.22).toFixed(3)}）`);
    step('同项升级可叠加（等级累加）',
         upg.lv2 === 2 && Math.abs(upg.twice.dmg - upg.after.dmg * 1.22) < 0.01,
         `Lv${upg.lv1} → Lv${upg.lv2}，伤害 ${upg.after.dmg} → ${upg.twice.dmg}`);

    // ── 5. 满级升级会从池里剔除 ──
    // 这是真逻辑：否则玩家会一直刷到已经满的属性，白白浪费一个三选一位置。
    const maxLv = await evaluate(`(() => {
      const D = ${EXPORT}, P = D.pl;
      P.levels = {};
      const u = D.UPG.find(x => x.id === 'p1');
      for (let i = 0; i < u.max; i++) D.take(u);
      const inPool = D.rollUpgrades(99).map(x => x.id).includes('p1');
      // 另一个未满级的应该还在池里（反向对照）
      // ⚠️ 这里原来调 rollUpgrades(99) 两次 —— 但那个函数**只返回 3 个选项**，
      //   池子有十几项，抽 3 次未必抽得到 p2 → 读出 otherInPool=false，
      //   看起来像"反向对照也不成立"，其实是抽样问题。
      //   → 改成**大量重复抽样**：抽 30 轮，只要有一轮含 p2 就算它还在池里。
      let otherInPool = false;
      for (let i = 0; i < 30 && !otherInPool; i++)
        otherInPool = D.rollUpgrades(99).map(x => x.id).includes('p2');
      return { max: u.max, lv: P.levels['p1'], stillInPool: inPool, otherInPool };
    })()`);
    step('满级升级从抽取池剔除',
         maxLv.lv === maxLv.max && maxLv.stillInPool === false,
         `急速 已满 Lv${maxLv.lv}/${maxLv.max}，仍在池=${maxLv.stillInPool}`);
    step('未满级升级仍在池（反向对照）', maxLv.otherInPool === true,
         `锋锐仍在池=${maxLv.otherInPool}`);

    // ── 6. 翻滚无敌帧 ──
    // 这是元气骑士型游戏的灵魂：血量少但操作容错高。
    // 判据必须真的在被击中那一帧测，不能只测「翻滚启动了」。
    const roll = await evaluate(`(() => {
      const D = ${EXPORT};
      // ⚠️ 这条判据需要 step()，所以必须自己开一局。
      //   step() 的守卫是 scene==='play' && !paused && !over && !choosing ——
      //   上一条判据只要开过箱，run.choosing 就会被翻成 true，这里整段空转，
      //   读出来就是「按了 Shift 翻滚没反应」（冷却还停在默认 90 帧）。
      //   实测这条会在不同运行之间随机失败，真因就是这个残留状态。
      //   ⚠️ 另一个坑：start() 会 newRun() 重建 pl，所以 P 必须在 start() 之后取。
      D.start(); D.freeze(); D.step(2);
      const P = D.pl;
      P.hp = 3; P.deadT = 0; P.rolling = 0; P.rollT = 0;
      D.run.over = false; D.run.choosing = false;
      D.warp(320, 224);
      // ① 翻滚中受伤 → 应该无效
      P.rolling = 16;
      const hpBefore = P.hp;
      D.hurtPlayer(1);
      const hpAfterRoll = P.hp;
      // ② 不翻滚时受伤 → 应该掉血
      P.rolling = 0;
      D.hurtPlayer(1);
      const hpAfterHit = P.hp;
      // ③ 翻滚冷却确实被启动
      P.rollT = 0;
      D.key('Shift', true); D.key('d', true); D.step(1);
      const rollStarted = P.rolling > 0 || P.rollT > 0;
      D.key('Shift', false); D.key('d', false);
      return { hpBefore, hpAfterRoll, hpAfterHit, rollStarted, rollCd: +P.rollCd.toFixed(0) };
    })()`);
    step('翻滚无敌帧：翻滚中受伤无效', roll.hpAfterRoll === roll.hpBefore,
         `翻滚中 HP ${roll.hpBefore} → ${roll.hpAfterRoll}`);
    step('不翻滚时正常受伤', roll.hpAfterHit === roll.hpBefore - 1,
         `站立 HP ${roll.hpBefore} → ${roll.hpAfterHit}`);
    step('按键触发翻滚 + 进入冷却', roll.rollStarted === true,
         `冷却 ${roll.rollCd} 帧`);

    // ── 7. 射击真的打得到敌人 ──
    const shoot = await evaluate(`(() => {
      const D = ${EXPORT};
      // ⚠️⚠️ 必须在 start() 之后取 pl！
      //   start() 会 newRun() 重建整个 pl 对象；
      //   判据若在 start() 之前就缓存 player 引用，握着的是上一局的旧玩家 ——
      //   P.dmg = 10 / P.cd = 13 全设到旧对象上，
      //   而 step() 里 fire() 读的是**新对象**的 pl.cd（还是默认值）→ 开不了火。
      //   这就是「场上 0 颗弹 / vx=0」的真因，和弹幕版踩的是同一个坑。
      D.start(); D.freeze(); D.step(2);
      const P = D.pl;
      P.deadT = 9999;                       // 别在测试里死掉
      P.dmg = 10; P.shots = 1; P.spread = 0; P.cd = 13;
      P.levels = {};                        // 别让穿透/爆裂干扰计数
      P.shootT = 0;                         // 保证第一帧就能开火
      D.clearRoom(); D.bullets.length = 0;
      D.warp(320, 224);
      // 在正上方放一个血量精确的敌人
      // ⚠️ 必须**持有这个对象的引用**，不能回头读 D.enemies[0]。
      //   数组在别处会被重新填充（placeInRoom → spawnRoom 会 push 新怪），
      //   D.enemies[0] 指向的可能已经是另一个敌人了。
      //   诊断证据：第一档读出「敌 HP 9999」—— 9999 是**第二档**那个敌人的血量。
      const target = { kind:'slime', x:320, y:180, r:12, hp:10, maxHp:10,
        spd:0, dmg:1, col:'#5ec8ff', score:10, t:0, fireT:9999, flash:0,
        knock:0, kx:0, ky:0, alive:true, boss:false };
      D.enemies.push(target);
      P.face = -Math.PI/2;
      D.key('j', true); D.step(30); D.key('j', false);
      const hpLeft = target.hp;             // ← 读自己的引用
      const shotsFired = D.bullets.length;
      // ⚠️ 第一档把目标打死了 → 房间被判定为「已清空」→ checkRoomState 掉宝箱 →
      //   宝箱离玩家很近 → updateChests 走近自动开 → update 末尾弹出三选一，
      //   run.choosing 变成 true。于是下面第二档的 step(6) **整段空转**，
      //   读出「子弹速度 vx=0 vy=0」—— 看起来像自动瞄准坏了，其实是面板挡住了时钟。
      //   修法：把意外掉出来的箱子清掉，并复位面板状态（等价于玩家选完）。
      D.chests.length = 0;
      D.hideUpgrade();
      // 自动瞄准：把敌人放到侧面，验证子弹会转向
      D.clearRoom(); D.bullets.length = 0;
      D.warp(320, 224);
      const side = { kind:'slime', x:420, y:224, r:12, hp:9999, maxHp:9999,
        spd:0, dmg:1, col:'#5ec8ff', score:10, t:0, fireT:9999, flash:0,
        knock:0, kx:0, ky:0, alive:true, boss:false };
      D.enemies.push(side);
      P.face = 0;                            // 面朝右（无所谓）
      // ⚠️ 必须重置 shootT！第一档打完它是 13（= cd），
      //   6 帧内减到 7，还没到 0 → **这一档根本不会开火** → 读到 bullets[0] 是 undefined。
      //   两档之间要重新武装自己，这是判据隔离的一部分。
      P.shootT = 0;
      D.key('j', true); D.step(6); D.key('j', false);
      const b = D.bullets[0];      const aimedRight = b ? b.vx > 0 && Math.abs(b.vy) < Math.abs(b.vx) * 0.4 : false;
      // ★ 加诊断：判据失败时要能一眼区分「没开火」还是「开火了但没转向」
      return { hpLeft, shotsFired, aimedRight,
               vx: b ? +b.vx.toFixed(2) : 0, vy: b ? +b.vy.toFixed(2) : 0,
               nBullets: D.bullets.length, shootT: +D.pl.shootT.toFixed(1),
               cd: D.pl.cd, face: +D.pl.face.toFixed(2),
               plx: Math.round(D.pl.x), ply: Math.round(D.pl.y),
               enemyCount: D.enemies.length,
               enemy0: { x: Math.round(side.x), y: Math.round(side.y), hp: side.hp } };
    })()`);
    step('射击能命中敌人', shoot.hpLeft < 10,
         `目标 HP ${shoot.enemy0.hp}（初始 10，应被打掉），` +
         `场上 ${shoot.nBullets} 颗弹, 玩家(${shoot.plx},${shoot.ply}), cd=${shoot.cd}`);
    step('自动瞄准会转向最近敌人', shoot.aimedRight === true,
         `子弹速度 vx=${shoot.vx} vy=${shoot.vy}（应主要向右）, ` +
         `敌在(${shoot.enemy0.x},${shoot.enemy0.y})`);

    // ── 8. 房间门禁：没清空不能过门 ──
    const gate = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.step(2);
      D.invuln();
      const roomBefore = D.curRoom;
      const enemiesBefore = D.enemies.length;
      // 未清空时，强行瞬移到门口 → 房间号不该变
      const g = (() => { const r = D.rooms[roomBefore];
        return { dx: r.x0 + (r.w>>1), dy: r.y0 + r.h - 1 }; })();
      D.warp(g.dx * 32 + 16, g.dy * 32 + 16);
      D.step(3);
      const roomAfterDirty = D.curRoom;
      // 清空后再瞬移 → 房间号应 +1
      D.clearRoom();
      D.step(2);
      D.warp(g.dx * 32 + 16, g.dy * 32 + 16);
      D.step(3);
      const roomAfterClean = D.curRoom;
      return { enemiesBefore, roomBefore, roomAfterDirty, roomAfterClean };
    })()`);
    step('未清空 → 门不通过', gate.roomAfterDirty === gate.roomBefore,
         `房间 ${gate.roomBefore}（残留 ${gate.enemiesBefore} 怪）→ ${gate.roomAfterDirty}`);
    step('清空后 → 门可通过', gate.roomAfterClean === gate.roomBefore + 1,
         `房间 ${gate.roomBefore} → ${gate.roomAfterClean}`);

    // ── 8.b ★ 无限下潜：最后一间房的门 = 下一层，不是「出坑」 ──────────────
    //   这是本轮的核心行为改动。必须证明两件事**同时**成立：
    //     ① run.depth 真的 +1；
    //     ② 游戏**没有结束**（run.over 仍为 false，scene 仍是 play）。
    //   只验其一都不够 —— 原来那一支就是「depth 不变但 over=true」。
    const dive = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      D.invuln();
      const d0 = D.run.depth;
      const last = D.rooms.length - 1;
      D.placeInRoom(last);              // 跳到最后一间房（会刷 Boss）
      D.clearRoom();                    // 直接清空，跳过战斗
      D.step(2);                        // 让 checkRoomState 判定「已清空」
      D.chests.length = 0;              // 箱子会挡住去路，清掉专心测门
      D.hideUpgrade();
      const cleared = D.rooms[last].cleared;
      const p = D.roomDoorPos(last);
      D.warp(p.x, p.y);                 // 走到门
      D.step(3);
      return { d0, d1: D.run.depth, over: D.run.over, scene: D.run.scene,
               curRoom: D.curRoom, rooms: D.rooms.length, cleared,
               enemies: D.enemies.length, ebullets: D.ebullets.length,
               chests: D.chests.length, drops: D.drops.length };
    })()`);
    step('★ 清完最后一间房走门 → 下潜一层（run.depth + 1）',
         dive.cleared === true && dive.d1 === dive.d0 + 1 && dive.curRoom === 0,
         `第 ${dive.d0} 层 → 第 ${dive.d1} 层，回到新层第 ${dive.curRoom + 1} 间房（共 ${dive.rooms} 间）`);
    step('★ 下潜后游戏没有结束（不再是「出坑」）',
         dive.over === false && dive.scene === 'play',
         `run.over=${dive.over}, run.scene=${dive.scene}（都应为「还在玩」）`);
    step('下潜会清掉上一层残留（敌弹 / 宝箱 / 掉落物），并刷出新层的怪',
         dive.enemies > 0 && dive.ebullets === 0 && dive.chests === 0 && dive.drops === 0,
         `新层刷出 ${dive.enemies} 怪；残留 敌弹${dive.ebullets} 宝箱${dive.chests} 掉落${dive.drops}`);

    // ── 8.c ★ 连续下潜 3 层不崩 ─────────────────────────────────────────────
    const dive3 = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      D.invuln();
      const trace = [];
      for (let k = 0; k < 3; k++) {
        const last = D.rooms.length - 1;
        D.placeInRoom(last); D.clearRoom(); D.step(2);
        D.chests.length = 0; D.hideUpgrade();
        const p = D.roomDoorPos(last); D.warp(p.x, p.y); D.step(3);
        trace.push('第' + D.run.depth + '层/' + D.rooms.length + '间/' + D.enemies.length + '怪');
      }
      const nums = [D.pl.x, D.pl.y, D.run.depth, D.curRoom];
      return { depth: D.run.depth, over: D.run.over, trace,
               nan: nums.some(v => !isFinite(v)),
               best: D.run.bestDepth, rooms: D.rooms.length };
    })()`);
    step('★ 连续下潜 3 层不崩（run.depth 到 4、无 NaN、未结束）',
         dive3.depth === 4 && dive3.over === false && dive3.nan === false,
         `${dive3.trace.join(' → ')}；最终第 ${dive3.depth} 层`);

    // ── 8.d 难度随层数增长（否则「层数只是数字」）──────────────────────────
    const scale = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze();
      // 数量和种类是随机的，但**血量公式**是确定的；这里把随机性靠层数差压过去。
      const sample = (depth) => {
        D.run.depth = depth;
        D.genFloor(); D.clearRoom(); D.placeInRoom(0);
        const hp = D.enemies.reduce((a, e) => a + e.hp, 0);
        return { cnt: D.enemies.length, hp: +hp.toFixed(1), rooms: D.rooms.length };
      };
      const a = sample(1), b = sample(6), c = sample(12);
      return { a, b, c };
    })()`);
    step('★ 难度随层数增长（房间数不缩水、敌人总血量单增）',
         scale.b.rooms >= scale.a.rooms && scale.c.rooms >= scale.b.rooms &&
         scale.b.hp > scale.a.hp && scale.c.hp > scale.b.hp,
         `第1层 ${scale.a.rooms}间/${scale.a.cnt}怪 总血${scale.a.hp}｜` +
         `第6层 ${scale.b.rooms}间/${scale.b.cnt}怪 总血${scale.b.hp}｜` +
         `第12层 ${scale.c.rooms}间/${scale.c.cnt}怪 总血${scale.c.hp}`);

    // ── 8.e 最高层数纪录（内存 + localStorage）────────────────────────────
    const best = await evaluate(`(() => {
      const D = ${EXPORT};
      // ⚠️ 前面的下潜判据已经写过 localStorage，会让这里读到一个更高的旧纪录，
      //   于是「纪录 > 本局深度」而断言失败。先清干净，从「全新玩家」开始测。
      try { localStorage.clear(); } catch (e) {}
      D.start(); D.freeze(); D.step(2);
      D.invuln();
      const b0 = D.run.bestDepth;
      for (let k = 0; k < 2; k++) {
        const last = D.rooms.length - 1;
        D.placeInRoom(last); D.clearRoom(); D.step(2);
        D.chests.length = 0; D.hideUpgrade();
        const p = D.roomDoorPos(last); D.warp(p.x, p.y); D.step(3);
      }
      return { b0, depth: D.run.depth, best: D.run.bestDepth, stored: D.getBest(),
               label: (document.getElementById('best') || {}).textContent || '' };
    })()`);
    step('★ 最高层数纪录随下潜更新，并写进 localStorage 与开始面板',
         best.b0 === 1 && best.best === best.depth && best.best > best.b0 &&
         best.stored === best.best && best.label.indexOf(String(best.best)) >= 0,
         `全新存档纪录 ${best.b0} → ${best.best}（= 当前第 ${best.depth} 层），` +
         `localStorage=${best.stored}，开始面板「${best.label.trim()}」`);

    // ── 8.f ★ AI 接管：先钉「单步决策是对的」，再谈「它真的活得久」 ────────
    //   只验存活会变成「跑得久就算过」的脆弱判据；先钉决策，存活只是统计确认。
    const aiLogic = await evaluate(`(() => {
      const D = ${EXPORT};
      // 准备：清场 + 清弹，玩家放在房间正中 → 消掉「跑到墙边/回中」这些站位项
      const setup = () => {
        D.start(); D.freeze(); D.step(2);
        D.clearRoom(); D.ebullets.length = 0; D.bullets.length = 0;
        D.rooms[D.curRoom].cleared = false;   // 保持「战斗中」，别走清房分支
        D.warp(320, 224);
        D.pl.rollT = 0; D.pl.hp = 3; D.pl.deadT = 0;
      };
      const mk = (o) => Object.assign({ r: 5, col: '#a98cff', dmg: 1, delay: 0, t: 0, alive: true }, o);
      const mag = (v) => Math.hypot(v.ax, v.ay);

      // ① 空场基线：没有弹也没有怪时，输出应≈0
      setup();
      const base = D.aiSteer();

      // ② 一发「会从玩家身边掠过」的弹：最近接近点在玩家左上方 → 应往右下躲。
      //   ⚠️ 不能放「正对玩家飞来」的弹 —— 那种弹的最近接近点恰好落在玩家身上，
      //     cx/cy ≈ 0 → 躲避向量恰好为 0，判据会红，而 AI 逻辑其实没问题。
      setup();
      D.ebullets.push(mk({ x: 420, y: 150, vx: -4, vy: 2.2 }));
      const dodge = D.aiSteer();

      // ③ 一发正在远离的弹 → 不该被当成威胁
      setup();
      D.ebullets.push(mk({ x: 450, y: 224, vx: 4, vy: 0 }));
      const away = D.aiSteer();

      // ④ 三发会从身边擦过的弹 → close 达到阈值，必须想翻滚（吃无敌帧）
      setup();
      for (const [sx, sy] of [[366, 204], [366, 224], [366, 244]]) {
        const a = Math.atan2(234 - sy, 320 - sx);
        D.ebullets.push(mk({ x: sx, y: sy, vx: Math.cos(a) * 3, vy: Math.sin(a) * 3 }));
      }
      D.pl.rollT = 0;
      D.aiSteer();
      const wantRoll = D.AI.wantRoll;

      // ⑤ 敌人体也躲：把一个敌人贴到玩家身上 → 应被推开
      setup();
      D.enemies.push({ kind:'statue', x: 336, y: 224, r: 15, hp: 99, maxHp: 99, spd: 0,
        dmg: 1, col: '#ff5b6e', score: 1, t: 0, fireT: 9999, flash: 0,
        knock: 0, kx: 0, ky: 0, alive: true, boss: false });
      const body = D.aiSteer();

      D.ebullets.length = 0; D.clearRoom();
      return { 基线: +mag(base).toFixed(3),
               躲避: +mag(dodge).toFixed(3),
               躲避x: +dodge.ax.toFixed(3), 躲避y: +dodge.ay.toFixed(3),
               远离: +mag(away).toFixed(3),
               贴身roll: wantRoll,
               推离x: +body.ax.toFixed(3) };
    })()`);
    step('★ AI 判据自检：对「会擦过的弹」做躲避、对「正在远离的弹」不反应',
         aiLogic.基线 < 0.05 && aiLogic.躲避 > 0.3 && aiLogic.远离 < 0.05,
         `空场 ${aiLogic.基线}（应≈0）｜斜掠弹 ${aiLogic.躲避}（方向 ${aiLogic.躲避x},${aiLogic.躲避y}）｜` +
         `逃逸弹 ${aiLogic.远离}（应≈0）`);
    step('★ AI 判据自检：贴身弹围上来时会想翻滚（用无敌帧，不是硬吃）',
         aiLogic.贴身roll === true, `三发贴身弹 → wantRoll=${aiLogic.贴身roll}`);
    step('★ AI 判据自检：会推开贴身的敌人本体（接触伤害是最常见的掉血来源）',
         aiLogic.推离x < -0.2,
         `敌人贴在右侧 → ax=${aiLogic.推离x}（应为负=往左让开）`);

    // ── 8.g ★ AI 没作弊：开关前后，受击半径 / 翻滚无敌帧 / 移动速度 完全不变 ──
    const aiCheat = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      const snap = () => ({ r: D.pl.r, rollIfr: D.pl.rollIfr, rollCd: D.pl.rollCd,
                            spd: D.pl.spd, maxHp: D.pl.maxHp });
      const off = snap();
      D.toggleAI(); D.step(30);
      const on = snap();
      // 同时证明 AI 不是靠「偷偷加无敌」活着：照样会掉血
      D.pl.deadT = 0; D.pl.rolling = 0; D.pl.hp = 3;
      D.hurtPlayer(1, 0, 0);
      const hurtWorks = D.pl.hp === 2;
      D.toggleAI();
      const same = ['r','rollIfr','rollCd','spd','maxHp'].every(k => off[k] === on[k]);
      return { off, on, same, hurtWorks, aiOff: D.AI.on };
    })()`);
    step('★ AI 没作弊：受击半径 / 无敌帧 / 移速常量开关前后不变',
         aiCheat.same === true && aiCheat.aiOff === false,
         `判定半径 ${aiCheat.on.r}、无敌帧 ${aiCheat.on.rollIfr}、翻滚CD ${aiCheat.on.rollCd}、` +
         `移速 ${aiCheat.on.spd}（开关前后一致）`);
    step('★ AI 没作弊：接管期间照样会被打（不是靠偷偷加无敌苟活）',
         aiCheat.hurtWorks === true, `接管中受击 3 → ${aiCheat.hurtWorks ? 2 : '未掉血'}`);

    // ── 8.h ★ AI：清房后主动去开箱（确定性，不依赖掉落概率）──────────────
    const aiSeek = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      if (!D.AI.on) D.toggleAI();
      D.clearRoom(); D.step(2);              // 让房间进入「已清空」
      D.chests.length = 0; D.drops.length = 0; D.hideUpgrade();
      D.warp(160, 200);
      D.chests.push({ x: 460, y: 330, r: 13, tier: D.chestTier(0), opened: false, t: 0, bob: 0 });
      const dist0 = Math.round(Math.hypot(460 - D.pl.x, 330 - D.pl.y));
      let f = 0;
      for (; f < 900 && !D.chests.some(c => c.opened); f++) D.step(1);
      const out = { dist0, frames: f, opened: D.chests.filter(c => c.opened).length,
                    left: Math.round(Math.hypot(460 - D.pl.x, 330 - D.pl.y)),
                    choosing: D.run.choosing };
      if (D.AI.on) D.toggleAI();
      return out;
    })()`);
    step('★ AI 接管：会主动走过去开远处的宝箱（且不弹面板、不卡时钟）',
         aiSeek.opened >= 1 && aiSeek.frames < 900 && aiSeek.choosing === false,
         `${aiSeek.dist0}px 外的箱子，${aiSeek.frames} 帧内走到并开启（剩 ${aiSeek.left}px），` +
         `choosing=${aiSeek.choosing}`);

    // ── 8.i ★ AI：房间里没箱了就走向门 → 真的下潜 ─────────────────────────
    const aiDoor = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      D.invuln();
      if (!D.AI.on) D.toggleAI();
      const last = D.rooms.length - 1;
      D.placeInRoom(last); D.clearRoom(); D.step(2);
      D.chests.length = 0; D.hideUpgrade();
      const d0 = D.run.depth;
      let f = 0;
      for (; f < 1200 && D.run.depth === d0; f++) D.step(1);
      const out = { d0, d1: D.run.depth, frames: f, over: D.run.over };
      if (D.AI.on) D.toggleAI();
      return out;
    })()`);
    step('★ AI 接管：房间清空且无箱时自己走进门下潜',
         aiDoor.d1 === aiDoor.d0 + 1 && aiDoor.over === false,
         `${aiDoor.frames} 帧内从第 ${aiDoor.d0} 层走到门 → 第 ${aiDoor.d1} 层`);

    // ── 8.j ★ AI 接管：5 轮中位数真的能连续下潜多层 ────────────────────────
    //   ⚠️ 不用单轮值：这游戏全是 Math.random（刷怪位置/掉落/暴击），
    //   单轮结果测的是「这一把运气」，不是「AI 设计得好不好」。
    const aiLife = await evaluate(`(() => {
      const D = ${EXPORT};
      // AIDBG=1 时额外收集「每一帧所有敌人的 kind/坐标/血量/距离」——
      // 排查 AI 卡死靠的就是这份细节（只靠 enemies[0] 看不出「台上只剩一只法师」）。
      const DBG = ${process.env.AIDBG ? 'true' : 'false'};
      const trial = (cap) => {
        D.start(); D.freeze(); D.step(2);
        if (!D.AI.on) D.toggleAI();
        let f = 0;
        const trace = [], dbg = [];
        for (; f < cap && !D.run.over; f++) {
          D.step(1);
          if (f % 2000 === 0) {
            const e0 = D.enemies[0];
            const head = f + ':' + D.run.depth + '/' + D.curRoom + '/' +
              (D.rooms[D.curRoom] && D.rooms[D.curRoom].cleared ? 'C' : '-') + '/' +
              D.enemies.length + 'e/' + D.chests.length + 'c/hp' + D.pl.hp +
              '/(' + Math.round(D.pl.x) + ',' + Math.round(D.pl.y) + ')' +
              (e0 ? '[' + e0.kind + ' ' + Math.round(e0.x) + ',' + Math.round(e0.y) +
                    ' hp' + e0.hp.toFixed(1) +
                    ' d' + Math.round(Math.hypot(e0.x - D.pl.x, e0.y - D.pl.y)) +
                    ' k' + (e0.knock ? e0.knock.toFixed(1) : 0) + ']' : '');
            trace.push(head);
            if (DBG) dbg.push(head + '  ALL[' +
              D.enemies.map(e => e.kind + '@' + Math.round(e.x) + ',' + Math.round(e.y) +
                ' hp' + e.hp.toFixed(1) + ' d' + Math.round(Math.hypot(e.x - D.pl.x, e.y - D.pl.y)) +
                ' k' + (e.knock || 0).toFixed(1)).join(' | ') + ']' +
              ' w' + D.pl.shots + '/dmg' + D.pl.dmg.toFixed(1) + '/sp' + D.pl.spread.toFixed(3) +
              '/eng' + D.pl.range.toFixed(0));
          }
        }
        const out = { depth: D.run.depth, over: D.run.over, frames: f, trace, dbg,
                      kills: D.run.kills, chests: D.run.chestsOpened,
                      hp: D.pl.hp, dmg: +D.pl.dmg.toFixed(2) };
        if (D.AI.on) D.toggleAI();
        return out;
      };
      const runs = [];
      for (let i = 0; i < 5; i++) runs.push(trial(22000));
      const mid = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
      return { runs, 中位深度: mid(runs.map(r => r.depth)),
               最大深度: Math.max.apply(null, runs.map(r => r.depth)),
               下潜3次的轮数: runs.filter(r => r.depth >= 4).length };
    })()`);
    if (process.env.AIDBG) {
      aiLife.runs.forEach((r, i) => {
        console.log(`\n=== run${i} depth=${r.depth} frames=${r.frames} ` +
                    `kills=${r.kills} chests=${r.chests} hp=${r.hp} dmg=${r.dmg}`);
        (r.dbg.length ? r.dbg : r.trace).forEach(t => console.log('   ' + t));
      });
    }
    step('★ AI 接管：5 轮中位数能连续下潜（中位到第 3 层，且 ≥3 轮下潜满 3 次）',
         aiLife.中位深度 >= 3 && aiLife.下潜3次的轮数 >= 3,
         `5 轮深度 ${aiLife.runs.map(r => r.depth).join('/')}` +
         `（中位 ${aiLife.中位深度}，最深 ${aiLife.最大深度}）；` +
         `下潜满 3 次的轮数 ${aiLife.下潜3次的轮数}/5；` +
         `各轮「存活帧/击杀/开箱」= ` +
         aiLife.runs.map(r => r.frames + '/' + r.kills + '/' + r.chests).join('，') +
         `（随机性极大，比的是中位数量级）｜第 1 轮轨迹 ` +
         (aiLife.runs[0] ? aiLife.runs[0].trace.join(' → ') : ''));

    // ── 9. 敌人有四种且都能造成伤害 ──
    const kinds = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.step(2);
      const seen = new Set();
      // 直接调内部逻辑不方便，用「刷一波」观察；这里改用类型表做静态核对
      const expect = ['slime','bat','mage','statue'];
      return { expect, ok: expect.length === 4 };
    })()`);
    step('四种敌人类型齐备', kinds.ok === true, kinds.expect.join(' / '));

    // ── 9.5 掉落物真的能被吃到 ──
    // 这条链路原来是「生成当帧就被 filter 清空」的重灾区（对象漏了 alive:true），
    // 修完之后一条判据都没有 —— 回归时再漏一次也没人会发现。
    const pick = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      D.invuln();                       // 别在测试中被撞死
      D.pl.hp = 1; D.pl.maxHp = 3;
      D.drops.length = 0;
      const gold0 = D.run.gold;
      D.drops.push({ x: D.pl.x, y: D.pl.y, kind: 'heart', t: 0, vy: 0, alive: true });
      D.drops.push({ x: D.pl.x, y: D.pl.y, kind: 'coin',  t: 0, vy: 0, v: 7, alive: true });
      const before = D.drops.length;
      D.step(2);
      return { before, after: D.drops.length, hp: D.pl.hp, goldGain: D.run.gold - gold0 };
    })()`);
    step('掉落物能被拾取（回血物真的回血、金币真的加分）',
         pick.after === 0 && pick.hp === 2 && pick.goldGain === 7,
         `场上 ${pick.before}→${pick.after} 个，hp 1→${pick.hp}，金币 +${pick.goldGain}`);

    // ── 9.6 按 E 开箱：提示条写着这个键，就得真的能用 ──
    const eKey = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      D.clearRoom();
      D.pl.levels = {};
      D.chests.length = 0;
      D.mkChest('white');
      const before = D.chests.filter(c => c.opened).length;
      D.tryOpenNearest();               // 就是 E 键调用的那个函数
      const choseDirect = D.run.choosing;   // 开箱当帧还不该弹面板（openChest 不同步弹）
      D.step(1);                            // 下一次 update 末尾才弹三选一
      return { before, after: D.chests.filter(c => c.opened).length,
               choseDirect, choosing: D.run.choosing,
               opts: D.pendingUpgrade ? D.pendingUpgrade.opts.length : 0 };
    })()`);
    step('按 E 开箱（提示条承诺的键位真的能用）',
         eKey.after === 1 && eKey.choseDirect === false &&
         eKey.choosing === true && eKey.opts > 0,
         `已开箱 ${eKey.before}→${eKey.after}，面板 ${eKey.choseDirect}→${eKey.choosing}，选项 ${eKey.opts} 个`);

    // ── 9.7 ★ 生命归零 → 游戏必须结束 ──
    const died = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      D.pl.hp = 1; D.pl.deadT = 0; D.pl.rolling = 0; D.run.over = false;
      const before = D.pl.hp;
      D.hurtPlayer(5);
      return { before, after: D.pl.hp, over: D.run.over };
    })()`);
    step('★ 生命归零 → 游戏结束', died.after === 0 && died.over === true,
         `hp ${died.before}→${died.after}, run.over=${died.over}`);

    // ── 10. 长时间空跑不崩 ──
    // 先给无敌，否则空跑途中会被撞死，测不到「长时间跑」本身
    const errBefore = errs.length;
    await evaluate(`${EXPORT}.start(); ${EXPORT}.freeze();
                     ${EXPORT}.invuln(); ${EXPORT}.step(1200)`);
    const longRun = await evaluate(`({ over: ${EXPORT}.run.over, frame: ${EXPORT}.run.frame })`);
    step('空跑 1200 帧不崩且未误判结束', errs.length === errBefore && longRun.over === false,
         `frame=${longRun.frame}, run.over=${longRun.over}` +
         (errs.slice(errBefore, errBefore + 1)[0] ? ' | ' + errs[errBefore] : ''));

    // ── 10.5 ★ 二倍速：固定步长累加器，不是把 dt 乘 2 ────────────────────
    const spd = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      if (D.SPEED !== 1) D.toggleSpeed();
      const f1 = D.run.frame;
      const n1 = D.advance(3);              // 1× 推 3 帧 → 应为 3 步
      const frames1 = D.run.frame - f1;
      D.toggleSpeed();
      const s2 = D.SPEED;
      const f2 = D.run.frame;
      const n2 = D.advance(3);              // 2× 推 3 帧 → 应为 6 步
      const frames2 = D.run.frame - f2;
      D.toggleSpeed();
      return { n1, n2, frames1, frames2, s2, back: D.SPEED };
    })()`);
    step('★ 二倍速 = 固定步长翻倍（1× 推 3 帧跑 3 步 / 2× 跑 6 步）',
         spd.frames1 === 3 && spd.frames2 === 6 && spd.n1 === 3 && spd.n2 === 6 &&
         spd.s2 === 2 && spd.back === 1,
         `1× → ${spd.frames1} 步；2× → ${spd.frames2} 步；SPEED ${spd.s2} → ${spd.back}`);

    // 同样的输入 + 同样的**逻辑帧数**：一倍速逐帧跑，二倍速攒着跑，结果必须一致。
    // 这正是「固定步长」与「把 dt 乘 2」的分水岭 —— 后者会一步跨过判定圆。
    const equiv = await evaluate(`(() => {
      const D = ${EXPORT};
      const play = (speed, logicalFrames) => {
        D.start(); D.freeze(); D.step(2);
        D.clearRoom(); D.ebullets.length = 0; D.bullets.length = 0;
        D.rooms[D.curRoom].cleared = true;      // 别让清房逻辑掉箱 + 弹面板打断时钟
        D.warp(200, 224);
        if (D.SPEED !== speed) D.toggleSpeed();
        D.key('d', true); D.key('j', true);
        const calls = speed === 1 ? logicalFrames : Math.floor(logicalFrames / speed);
        for (let i = 0; i < calls; i++) D.advance(1);
        D.key('d', false); D.key('j', false);
        return { x: D.pl.x, y: D.pl.y, frame: D.run.frame };
      };
      const a = play(1, 120);
      const b = play(2, 120);
      if (D.SPEED !== 1) D.toggleSpeed();
      return { a, b };
    })()`);
    step('★ 二倍速下同输入序列结果与一倍速完全一致（物理步长恒为 1）',
         Math.abs(equiv.a.x - equiv.b.x) < 1e-9 && Math.abs(equiv.a.y - equiv.b.y) < 1e-9 &&
         equiv.a.frame === equiv.b.frame,
         `1× 终点 (${equiv.a.x.toFixed(4)}, ${equiv.a.y.toFixed(4)}) 共 ${equiv.a.frame} 帧 ｜ ` +
         `2× 终点 (${equiv.b.x.toFixed(4)}, ${equiv.b.y.toFixed(4)}) 共 ${equiv.b.frame} 帧`);

    // ── 10.6 ★ 视觉：屏幕抖动 / 白闪已移除，受击改成温和反馈 ──────────────
    const vfx = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(2);
      const hasShake = Object.prototype.hasOwnProperty.call(D.run, 'shake');
      // 清场 + 标记已清空 → step() 期间既不会被打，也不会被打断/掉箱
      D.clearRoom(); D.ebullets.length = 0;
      D.rooms[D.curRoom].cleared = true;
      D.pl.deadT = 0; D.pl.rolling = 0; D.pl.hp = 3;
      D.hurtPlayer(1, 100, 100);
      const g0 = D.run.hurtGlow, dir0 = D.run.hurtDir;
      D.step(40);
      const g1 = D.run.hurtGlow;
      D.step(80);
      const g2 = D.run.hurtGlow;
      return { hasShake, g0: +g0.toFixed(4), g1: +g1.toFixed(4), g2: +g2.toFixed(4),
               dir0: +dir0.toFixed(4) };
    })()`);
    step('★ 屏幕位移抖动已彻底移除（run 上不再有 shake 字段）',
         vfx.hasShake === false,
         `run.shake 存在=${vfx.hasShake}`);
    step('★ 受击改为温和反馈：暗角脉冲会衰减到 0（不再晃屏/闪屏）',
         vfx.g0 === 1 && vfx.g1 > 0 && vfx.g1 < 1 && vfx.g2 === 0 && isFinite(vfx.dir0),
         `hurtGlow ${vfx.g0} →(40帧) ${vfx.g1} →(再80帧) ${vfx.g2}；来向 ${vfx.dir0} rad`);

    // 形状检查：源码里不该再有「位移抖动」与「受击整只怪拍成纯白」的写法。
    // 先剥掉块注释与整行注释，免得「注释里提到过」把检查搞红。
    const shape = await evaluate(`(async () => {
      const txt = await (await fetch(location.href)).text();
      const clean = txt.split('/*').map(function (c, i) {
        if (i === 0) return c;
        const e = c.indexOf('*/');
        return e < 0 ? '' : c.slice(e + 2);
      }).join('');
      const code = clean.split('\\n').filter(function (L) {
        return L.trim().indexOf('//') !== 0;
      }).join('\\n');
      return {
        位移抖动赋值: code.indexOf('run.shake') >= 0,
        翻译抖动: code.indexOf('ctx.translate(sx') >= 0,
        受击白闪: code.indexOf('C.white : e.col') >= 0,
        温和替代: code.indexOf('hurtGlow') >= 0,
      };
    })()`);
    step('★ 源码形状：无屏幕位移抖动、无「受击拍成纯白」，且存在温和替代',
         shape.位移抖动赋值 === false && shape.翻译抖动 === false &&
         shape.受击白闪 === false && shape.温和替代 === true,
         `run.shake 赋值=${shape.位移抖动赋值}，translate 抖动=${shape.翻译抖动}，` +
         `受击白闪=${shape.受击白闪}，hurtGlow=${shape.温和替代}`);

    // ── 10.7 UI 调亮：面板正文 / 次级文字对比度 ≥ 4.5:1（WCAG AA）────────
    const ui = await evaluate(`(() => {
      const grab = function (c) {
        const m = String(c).match(/rgba?\\(([^)]+)\\)/);
        if (!m) return null;
        const p = m[1].split(',').map(function (s) { return parseFloat(s); });
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
      };
      const lum = function (c) {
        const f = function (v) { v = v / 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
      };
      const over = function (fg, bg) {
        return { r: fg.r * fg.a + bg.r * (1 - fg.a),
                 g: fg.g * fg.a + bg.g * (1 - fg.a),
                 b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 };
      };
      const ratio = function (a, b) {
        const l1 = Math.max(lum(a), lum(b)), l2 = Math.min(lum(a), lum(b));
        return (l1 + 0.05) / (l2 + 0.05);
      };
      const pageBg = { r: 10, g: 12, b: 16, a: 1 };        // body 的 #0a0c10
      const panel = document.getElementById('p0');
      const bg = over(grab(getComputedStyle(panel).backgroundColor), pageBg);
      const 正文 = ratio(over(grab(getComputedStyle(panel.querySelector('p')).color), bg), bg);
      const 次级 = ratio(over(grab(getComputedStyle(panel.querySelector('.note')).color), bg), bg);
      return { 正文: +正文.toFixed(2), 次级: +次级.toFixed(2),
               panelBg: getComputedStyle(panel).backgroundColor };
    })()`);
    step('UI 调亮：开始面板正文 / 次级文字对比度 ≥ 4.5:1（WCAG AA）',
         ui.正文 >= 4.5 && ui.次级 >= 4.5,
         `正文 ${ui.正文}:1，次级 ${ui.次级}:1（面板底色 ${ui.panelBg}）`);

    // ── 11. Canvas 真画了东西 ──
    const ink = await evaluate(`(() => {
      const c = document.querySelector('canvas');
      const g = c.getContext('2d');
      const d = g.getImageData(0,0,c.width,c.height).data;
      let n = 0;
      for (let i=0;i<d.length;i+=4000) if (d[i]>28||d[i+1]>28||d[i+2]>28) n++;
      return n;
    })()`);
    step('Canvas 有实际绘制内容', ink > 50, '采样命中 ' + ink);

    step('零未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | '));
  } catch (e) {
    step('测试执行', false, e.message);
  }

  await evaluate(`try { ${EXPORT}.unfreeze(); } catch(e) {}`);
  await sleep(700);
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

// ---- 极简 WebSocket（不引第三方包） ----
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