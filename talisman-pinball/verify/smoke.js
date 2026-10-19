/**
 * 无头冒烟测试：把单文件 HTML 游戏塞进真实浏览器（headless Edge + CDP）跑 N 帧，
 * 检查有没有未捕获异常、状态有没有推进、关键机制有没有真的触发。
 *
 * 为什么不用 Node vm + canvas stub：Canvas 的实际绘制路径（渐变、shadowBlur、
 * 合成模式）只有真浏览器能暴露。stub 跑通了不代表浏览器里画得出来。
 *
 * ⚠️ 本文件里所有判据都必须遵守一条顺序：
 *      D.start() → D.freeze() → const R = D.run
 *    start() 会**新建** run 对象。先取 R 再 start()，拿到的是上一局的尸体 ——
 *    症状是「改了 hp / 摆了符块，但游戏毫无反应」，16 条判据一起红，
 *    看起来像游戏崩了，其实判据在跟一个已经作废的对象说话。
 *    这一版就是因为这个顺序写反，白跑了一整轮。
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
const EXPORT = process.argv[3] || '__TP';
const PORT = 9311 + (crypto.randomBytes(1)[0] % 40);
const CDP_PORT = PORT + 100;

const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(FILE));
});

function get(pathname) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: CDP_PORT, path: pathname }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── 收尾：杀【整棵】进程树，再删浏览器 profile ────────────────────────────────
 * ⚠️ 踩过的坑：`proc.kill()`（SIGTERM）在 Windows 上只杀掉 spawn 的启动器，
 *    Edge 的 renderer / gpu 子进程会继续活着并写 --user-data-dir，此时删 profile
 *    就是在跟活进程抢文件 —— 实测卡 5 分钟。正解 taskkill /T /F。
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
  } catch (e) {}
  try { proc.kill(); } catch (e) {}
  sleepSync(700);
}

function rmTree(dir) {
  if (!fs.existsSync(dir)) return { ok: true, how: 'absent' };
  const { execFileSync, spawn: sp } = require('child_process');
  try {
    execFileSync('cmd', ['/c', 'rmdir', '/s', '/q', dir], { stdio: 'ignore', timeout: 5000 });
  } catch (e) {}
  if (!fs.existsSync(dir)) return { ok: true, how: 'cmd' };
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Remove-Item',
      '-LiteralPath', dir, '-Recurse', '-Force', '-ErrorAction', 'SilentlyContinue'],
      { stdio: 'ignore', timeout: 8000 });
  } catch (e) {}
  if (!fs.existsSync(dir)) return { ok: true, how: 'powershell' };
  try {
    const c = sp('cmd', ['/c', 'rmdir', '/s', '/q', dir], { detached: true, stdio: 'ignore' });
    c.unref();
  } catch (e) {}
  return { ok: false, how: 'detached' };
}

(async () => {
  await new Promise(r => srv.listen(PORT, '127.0.0.1', r));
  const profile = path.resolve(__dirname, '_smokeprof');
  rmTree(profile);
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
    `--remote-debugging-port=${CDP_PORT}`,
    '--user-data-dir=' + profile,
    `--window-size=${process.env.VW || 900},${process.env.VH || 1000}`,
    `http://127.0.0.1:${PORT}/g.html`,
  ], { stdio: 'ignore' });

  const errs = [];
  let ws = null;
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

  ws = await connect(tab.webSocketDebuggerUrl);
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
    if (r.result?.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
    }
    return r.result?.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');

  // ⚠️「找到 CDP tab」不等于「页面加载完」—— 必须轮询真正的就绪条件。
  let __ready = false;
  for (let __i = 0; __i < 100 && !__ready; __i++) {
    await sleep(200);
    try { __ready = await evaluate(`typeof window["${EXPORT}"] !== "undefined"`); }
    catch (e) { __ready = false; }
  }
  if (!__ready) console.log('⚠️ 等了 20 秒仍没等到导出，后续判据大概率会误报');

  const report = { errs, steps: [] };
  const step = (name, ok, detail) => {
    report.steps.push({ name, ok, detail });
    console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
  };

  try {
    /* ---------- 0. 启动与时钟 ---------- */
    const hasExport = await evaluate(`typeof ${EXPORT} !== 'undefined'`);
    step('暴露测试接口 ' + EXPORT, hasExport === true, 'typeof=' + hasExport);
    if (hasExport !== true) throw new Error('no export');

    await evaluate(`${EXPORT}.start()`);
    await sleep(250);
    step('start() 未抛异常', errs.length === 0, errs[0] || '');

    // ★★ 冻结自带动画循环。
    // ⚠️ 全项目最贵的坑：页面自己的 rAF 和测试的 step() 赛跑 → 玩家原地挨打
    //    → run.over=true → step() 里的判断全不成立 → 看起来像「状态机坏了」。
    const frozen = await evaluate(`(() => {
      const D = ${EXPORT};
      D.freeze();
      const R = D.run;
      const t0 = R.t, hp0 = R.hp;
      D.step(20);
      return { dt: +(R.t - t0).toFixed(2), hp0, hp1: R.hp, over: R.over };
    })()`);
    step('★★ 冻结 rAF 后 step() 独占时钟',
      frozen.dt >= 19 && frozen.over === false,
      '20 步推进 ' + frozen.dt + 's，HP ' + frozen.hp0 + '→' + frozen.hp1);

    /* ---------- 1. 符阵（墙）机制 ---------- */
    const wall0 = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze();
      const R = D.run;
      D.step(150);                      // v1.4.0：开局喘息 1.1 → 2.0 秒（约 120 帧）
      return { wave: R.wave, n: R.blocks.length, wallY: +R.wallY.toFixed(1),
               speed: +R.wallSpeed.toFixed(1) };
    })()`);
    step('开局生成第 1 阵符墙', wall0.wave === 1 && wall0.n > 0,
      '第 ' + wall0.wave + ' 阵，' + wall0.n + ' 块，墙顶 y=' + wall0.wallY);

    // 墙必须真的在「缓慢向下平移」，而不是生成一次就当背景板
    const descend = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze();
      const R = D.run;
      D.step(150);
      const y0 = R.wallY;
      D.step(600);                      // 10 秒
      return { dy: +(R.wallY - y0).toFixed(1), speed: R.wallSpeed };
    })()`);
    step('★ 符墙随时间缓慢下压',
      descend.dy > 60 && descend.dy < 320,
      '10 秒下移 ' + descend.dy + 'px（≈' + (descend.dy / 10).toFixed(1) + 'px/s，配置 ' + descend.speed + '）');

    // ★ 用户核心诉求：不再是满屏弹幕
    const noBullets = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze();
      const R = D.run;
      D.step(150);
      let peak = 0;
      for (let i = 0; i < 900; i++) { D.step(1); peak = Math.max(peak, R.projs.length); }
      return { peak, blocks: R.blocks.length, wave: R.wave };
    })()`);
    step('★ 普通阵不放弹幕（同时在场敌弹峰值）', noBullets.peak === 0,
      '15 秒内敌弹峰值 ' + noBullets.peak + ' 发（第 ' + noBullets.wave + ' 阵，场上 ' + noBullets.blocks + ' 块）');

    /* ---------- 2. 元素与反应 ---------- */
    const table = await evaluate(`(() => {
      const D = ${EXPORT}, r = D.reactionOf;
      const g = (a, b) => { const x = r(a, b); return x ? x.name + ':' + x.mul : 'none'; };
      return {
        vapor: g('hydro', 'pyro'), vapor2: g('pyro', 'hydro'),
        overload: g('pyro', 'electro'), chain: g('hydro', 'electro'),
        burn: g('anemo', 'pyro'), soak: g('anemo', 'hydro'), storm: g('anemo', 'electro'),
        same: g('pyro', 'pyro'), sameAnemo: g('anemo', 'anemo'),
      };
    })()`);
    step('★ 元素反应表（蒸发/超载/感电 + 风的三条分支）',
      table.vapor === '蒸发:2' && table.vapor2 === '蒸发:1.6' &&
      table.overload === '超载:1.5' && table.chain === '感电:1.3' &&
      table.burn === '燎原:1.45' && table.soak === '浸润:1.2' && table.storm === '雷暴:1.4' &&
      table.same === 'none' && table.sameAnemo === 'none',
      JSON.stringify(table));

    // 反应真的改变了伤害，而不只是弹个字
    const dmg = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze();
      const R = D.run;
      R.wallY = 300; R.blocks.length = 0;
      const mk = (col, row, el) => ({ col, row, w: 60, h: 34, el, hp: 100, maxHp: 100,
        flash: 0, reactCd: 0, alive: true, boss: false });
      const a = mk(0, 0, 'pyro'), b = mk(2, 0, 'pyro'), c = mk(4, 0, 'hydro');
      R.blocks.push(a, b, c);
      D.hitBlock(a, 'pyro', 10);     // 同元素：×1
      D.hitBlock(b, 'hydro', 10);    // 蒸发（水打火）：×2
      D.hitBlock(c, 'pyro', 10);     // 蒸发（火打水）：×1.6
      return { same: a.hp, vapor: b.hp, vapor2: c.hp };
    })()`);
    step('★ 蒸发真的改变伤害（×1 / ×2.0 / ×1.6）',
      dmg.same === 90 && dmg.vapor === 80 && dmg.vapor2 === 84,
      '同元素 ' + dmg.same + '，水打火 ' + dmg.vapor + '，火打水 ' + dmg.vapor2);

    const aoe = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze();
      const R = D.run;
      R.wallY = 300; R.blocks.length = 0;
      const mk = (col, row, el) => ({ col, row, w: 60, h: 34, el, hp: 200, maxHp: 200,
        flash: 0, reactCd: 0, alive: true, boss: false });
      const src = mk(3, 1, 'electro'), near = mk(4, 1, 'electro'), far = mk(7, 4, 'electro');
      R.blocks.push(src, near, far);
      D.hitBlock(src, 'pyro', 10);   // 超载
      return { near: near.hp, far: far.hp, ring: !!R.ring };
    })()`);
    step('★ 超载：范围爆炸伤到相邻符块', aoe.near < 200 && aoe.far === 200,
      '邻块 200→' + aoe.near + '，远处 ' + aoe.far);

    const chain = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze();
      const R = D.run;
      R.wallY = 300; R.blocks.length = 0;
      const mk = (col, row, el) => ({ col, row, w: 60, h: 34, el, hp: 200, maxHp: 200,
        flash: 0, reactCd: 0, alive: true, boss: false });
      const src = mk(2, 0, 'hydro'), sameRow = mk(4, 0, 'hydro'), other = mk(2, 3, 'hydro');
      R.blocks.push(src, sameRow, other);
      D.hitBlock(src, 'electro', 10);   // 感电：同排连锁
      return { sameRow: sameRow.hp, other: other.hp, arcs: (R.arcs || []).length };
    })()`);
    step('★ 感电：同排连锁', chain.sameRow < 200 && chain.other === 200,
      '同排 200→' + chain.sameRow + '，异排 ' + chain.other + '，电弧 ' + chain.arcs + ' 条');

    // v1.4.0：风不再是「一种扩散 ×1.25」，而是按被吹元素分三条分支
    const wind = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze();
      const R = D.run;
      R.wallY = 300; R.blocks.length = 0;
      const mk = (col, row, el) => ({ col, row, w: 60, h: 34, el, hp: 200, maxHp: 200,
        flash: 0, reactCd: 0, alive: true, boss: false });
      const b1 = mk(2, 0, 'pyro'), b2 = mk(5, 0, 'pyro'),
            b3 = mk(2, 3, 'hydro'), b4 = mk(5, 3, 'electro');
      R.blocks.push(b1, b2, b3, b4);

      b1.reactCd = 0; D.hitBlock(b1, 'anemo', 10);   // 燎原：同排点燃
      const burnT = R.burnT, burnNb = b2.hp;
      b3.reactCd = 0; D.hitBlock(b3, 'anemo', 10);   // 浸润：符阵减速
      const soakT = R.soakT;
      b4.reactCd = 0; D.hitBlock(b4, 'anemo', 10);   // 雷暴：麻痹
      const stunT = R.stunT;
      return { burnT: +(+burnT).toFixed(2), burnNb,
               soakT: +soakT.toFixed(2), stunT: +stunT.toFixed(2) };
    })()`);
    step('★ 风的三条分支各有独立副作用（点燃 / 减速 / 麻痹）',
      wind.burnT > 0 && wind.burnNb < 200 && wind.soakT > 0 && wind.stunT > 0,
      '燎原 burnT=' + wind.burnT + '，同排 200→' + wind.burnNb
      + '　｜　浸润 soakT=' + wind.soakT + '　｜　雷暴 stunT=' + wind.stunT);

    // 反应链：反应后符块被「染成」攻击元素，换一种元素就能接着反应
    const link = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze();
      const R = D.run;
      R.wallY = 300; R.blocks.length = 0;
      const a = { col: 3, row: 0, w: 60, h: 34, el: 'pyro', hp: 200, maxHp: 200,
        flash: 0, reactCd: 0, alive: true, boss: false };
      R.blocks.push(a);
      D.hitBlock(a, 'hydro', 10);      // 蒸发 → 火块变水块
      const el1 = a.el, hp1 = a.hp;
      a.reactCd = 0;
      D.hitBlock(a, 'electro', 10);    // 水 × 雷 = 感电
      return { el1, hp1, el2: a.el, hp2: a.hp, rx: Object.keys(R.reactions) };
    })()`);
    step('★ 反应链：反应后符块被染成攻击元素，换元素可继续反应',
      link.el1 === 'hydro' && link.el2 === 'electro' && link.hp2 < link.hp1 - 10,
      '火块 → ' + link.el1 + '（HP ' + link.hp1 + '）→ ' + link.el2 + '（HP ' + link.hp2 + '）'
      + '，已记录 ' + link.rx.join('/'));

    const sw = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze();
      D.setEl(0); const a = D.run.el;
      D.setEl(1); const b = D.run.el;
      D.setEl(2); const c = D.run.el;
      D.setEl(3); const d = D.run.el;
      D.cycleEl(); const e = D.run.el;
      return { a, b, c, d, e };
    })()`);
    step('元素切换（1/2/3/4 与 Q 循环）',
      sw.a === 'pyro' && sw.b === 'hydro' && sw.c === 'electro' && sw.d === 'anemo' && sw.e === 'pyro',
      [sw.a, sw.b, sw.c, sw.d, '→' + sw.e].join('/'));

    /* ---------- 3. 灵弹物理 ---------- */
    const bounce = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze();
      const R = D.run;
      R.blocks.length = 0;
      const b = R.ball; b.stuck = false; b.stuckT = 0;
      b.x = 3; b.y = 400; b.vx = -7; b.vy = 2;
      D.step(2);
      return { x: +b.x.toFixed(1), vx: +b.vx.toFixed(2) };
    })()`);
    step('灵弹撞侧墙反弹', bounce.vx > 0 && bounce.x >= 8,
      'x=' + bounce.x + '，vx 由 -7 转正为 ' + bounce.vx);

    const catchBall = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze();
      const R = D.run;
      R.blocks.length = 0;
      const b = R.ball; b.stuck = false; b.stuckT = 0;
      b.x = D.paddle.x; b.y = D.PADDLE_Y - 30; b.vx = 0; b.vy = 7.4;
      D.step(6);
      return { vy: +b.vy.toFixed(2), y: +b.y.toFixed(1), stuck: b.stuck };
    })()`);
    step('★ 灵弹被符盘接住并反弹向上', catchBall.stuck === false && catchBall.vy < 0,
      'vy ' + catchBall.vy + '，y=' + catchBall.y);

    const drop = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze();
      const R = D.run;
      R.blocks.length = 0; R.hp = 3; R.hurtCd = 0;
      const b = R.ball; b.stuck = false; b.stuckT = 0;
      b.x = 200; b.y = D.H + 20; b.vx = 0; b.vy = 7;
      D.step(2);
      return { hp: R.hp, stuck: R.ball.stuck, edge: +R.edge.v.toFixed(2) };
    })()`);
    step('★ 灵弹坠底 → 损一命 + 回到符盘',
      drop.hp === 2 && drop.stuck === true,
      'HP 3→' + drop.hp + '，重生吸附=' + drop.stuck);

    /* ---------- 4. 关卡递进 ---------- */
    const nextWave = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze();
      const R = D.run;
      R.wave = 1; D.spawnWall(1); R.wallY = 100;
      const n0 = R.blocks.length;
      R.blocks.forEach(b => { b.alive = false; });   // 模拟玩家把墙敲光
      D.step(1);
      const afterClear = R.blocks.length;
      D.step(160);                                   // v1.4.0：阵间喘息 1.9 秒
      return { n0, afterClear, wave: R.wave, n1: R.blocks.length, cleared: R.wallsCleared };
    })()`);
    step('★ 敲光一面墙 → 进入下一阵（不结束）',
      nextWave.afterClear === 0 && nextWave.wave === 2 && nextWave.n1 > 0 && nextWave.cleared >= 1,
      '第 1 阵 ' + nextWave.n0 + ' 块 → 敲光 → 第 ' + nextWave.wave + ' 阵 ' + nextWave.n1 + ' 块');

    const bossWave = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze();
      D.spawnWall(8);
      const R = D.run;
      const boss = R.blocks.filter(b => b.boss);
      return { boss: boss.length, hp: boss[0] ? Math.round(boss[0].hp) : 0,
               el: boss[0] ? boss[0].el : '',
               meta: R.boss ? R.boss.name : '', fire: R.boss ? R.boss.fire : '' };
    })()`);
    step('v1.4.0 第 8 阵是 BOSS 阵（符核 + 名字 + 弹型）',
      bossWave.boss === 1 && bossWave.hp > 100 && !!bossWave.meta && bossWave.fire === 'fan',
      '符核 HP ' + bossWave.hp + '，' + bossWave.meta + '，弹型 ' + bossWave.fire);

    const bossKinds = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze();
      const out = [];
      for (const n of [8, 16, 24]) {
        D.spawnWall(n);
        const b = D.run.blocks.filter(x => x.boss)[0];
        out.push({ n, kind: D.run.boss ? D.run.boss.kind : '',
                   fire: D.run.boss ? D.run.boss.fire : '',
                   hp: b ? Math.round(b.hp) : 0 });
      }
      return out;
    })()`);
    step('★ 三种 BOSS 按章轮换（焰狱扇形 / 潮汐环形 / 雷罚雷击）',
      bossKinds[0].kind === 'pyro' && bossKinds[0].fire === 'fan' &&
      bossKinds[1].kind === 'hydro' && bossKinds[1].fire === 'ring' &&
      bossKinds[2].kind === 'electro' && bossKinds[2].fire === 'bolt' &&
      bossKinds[2].hp > bossKinds[0].hp,
      bossKinds.map(x => '#' + x.n + ' ' + x.kind + '/' + x.fire + ' HP' + x.hp).join('　'));

    const phase = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze();
      D.spawnWall(8);
      const R = D.run;
      const core = R.blocks.filter(b => b.boss)[0];
      const p0 = R.phase;
      core.hp = core.maxHp * 0.49;
      D.step(2);
      return { p0, p1: R.phase };
    })()`);
    step('★ BOSS 半血进入第二阶段（换弹型 + 预备时间）',
      phase.p0 === 1 && phase.p1 === 2, '阶段 ' + phase.p0 + ' → ' + phase.p1);

    const chapter = await evaluate(`(() => {
      const D = ${EXPORT};
      return { c1: D.chapterOf(1), c8: D.chapterOf(8), c9: D.chapterOf(9), c17: D.chapterOf(17),
               n1: D.chapterData(1).name, n9: D.chapterData(9).name,
               boss8: D.isBossWave(8), boss7: D.isBossWave(7) };
    })()`);
    step('章节：每 8 阵一章，章末才是 BOSS',
      chapter.c1 === 0 && chapter.c8 === 0 && chapter.c9 === 1 && chapter.c17 === 2 &&
      chapter.boss8 === true && chapter.boss7 === false && chapter.n1 !== chapter.n9,
      chapter.n1 + ' → ' + chapter.n9 + '（第 8 阵 BOSS=' + chapter.boss8 + '，第 7 阵=' + chapter.boss7 + '）');

    const rotate = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze();
      const R = D.run;
      R.blocks.length = 0; R.wallY = -260;
      R.blocks.push({ col: 3, row: 0, w: 124, h: 34, el: 'pyro', hp: 400, maxHp: 400,
        flash: 0, reactCd: 0, alive: true, boss: true });
      const e0 = R.blocks[0].el;
      D.step(260);          // ≈4.3 秒
      return { e0, e1: R.blocks[0] && R.blocks[0].el };
    })()`);
    step('★ BOSS 元素 4 秒轮转（迫使玩家换元素）',
      rotate.e0 === 'pyro' && rotate.e1 === 'hydro',
      rotate.e0 + ' → ' + rotate.e1);

    const bossFire = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze();
      const R = D.run;
      R.blocks.length = 0; R.projs.length = 0; R.wallY = 120;
      R.blocks.push({ col: 3, row: 0, w: 124, h: 34, el: 'pyro', hp: 400, maxHp: 400,
        flash: 0, reactCd: 0, alive: true, boss: true });
      let peak = 0;
      for (let i = 0; i < 900; i++) { D.step(1); peak = Math.max(peak, R.projs.length); }
      return { peak, cap: D.PROJ_CAP };
    })()`);
    step('★ BOSS 符矢同时在场 ≤ PROJ_CAP（不是弹幕）',
      bossFire.peak > 0 && bossFire.peak <= bossFire.cap,
      '15 秒内峰值 ' + bossFire.peak + ' 发（上限 ' + bossFire.cap + '）');

    /* ---------- 4.5 v1.4.0 新增：元素能量 / 元素爆发 / 降难度 ---------- */
    const energy = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze();
      const R = D.run;
      R.wallY = 300; R.blocks.length = 0;
      R.blocks.push({ col: 3, row: 0, w: 60, h: 34, el: 'pyro', hp: 999, maxHp: 999,
        flash: 0, reactCd: 0, alive: true, boss: false });
      const e0 = R.energy;
      D.hitBlock(R.blocks[0], 'hydro', 10);      // 命中 + 反应
      const e1 = R.energy;
      return { e0: +e0.toFixed(1), e1: +e1.toFixed(1) };
    })()`);
    step('能量随命中与反应积攒',
      energy.e1 >= energy.e0 + 15,
      '能量 ' + energy.e0 + ' → ' + energy.e1 + '（命中 + 反应）');

    const burst = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze();
      const R = D.run;
      D.spawnWall(6);
      R.energy = 0;
      const denied = D.elementalBurst();          // 能量不足必须失败
      const hp0 = R.blocks.reduce((a, b) => a + Math.max(0, b.hp), 0);
      R.energy = D.ENERGY_MAX;
      R.projs.push({ x: 100, y: 200, r: 6, vx: 0, vy: 0, spin: 0, dead: false, el: 'pyro' });
      const y0 = R.wallY;
      const ok = D.elementalBurst();
      const alive = R.blocks.filter(b => b.alive);
      const hp1 = alive.reduce((a, b) => a + Math.max(0, b.hp), 0);
      return { denied, ok, projs: R.projs.length, energy: R.energy,
               dy: +(R.wallY - y0).toFixed(1),
               before: Math.round(hp0), after: Math.round(hp1),
               broken: R.blocksBroken, bursts: R.bursts };
    })()`);
    step('★ 元素爆发：满能量才可放，清符矢 + 全屏反应 + 推回符阵',
      burst.denied === false && burst.ok === true && burst.projs === 0 &&
      burst.energy === 0 && burst.dy < 0 && burst.after < burst.before && burst.bursts === 1,
      '能量不足时=' + burst.denied + '｜放完 projs=' + burst.projs + ' energy=' + burst.energy
      + '｜墙 ' + burst.dy + 'px｜符块总血 ' + burst.before + '→' + burst.after
      + '｜碎块 ' + burst.broken);

    const balance = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze();
      const R = D.run;
      const hp0 = R.maxHp;
      D.spawnWall(1); const s1 = R.wallSpeed, b1 = R.blocks[0].maxHp;
      D.spawnWall(6); const s6 = R.wallSpeed, b6 = R.blocks[0].maxHp;
      D.spawnWall(40); const s40 = R.wallSpeed;
      return { hp0, s1: +s1.toFixed(2), s6: +s6.toFixed(2), s40: +s40.toFixed(2),
               b1: +b1.toFixed(1), b6: +b6.toFixed(1) };
    })()`);
    step('★ 降难度生效：5 条命 · 墙速封顶 13 · 符块血量下调',
      balance.hp0 === 5 && balance.s40 <= 13 && balance.s1 < 8.5 && balance.s6 < 10
      && balance.b1 < 12 && balance.b6 < 22,
      '命 ' + balance.hp0 + '｜墙速 1阵 ' + balance.s1 + ' / 6阵 ' + balance.s6
      + ' / 40阵 ' + balance.s40 + '｜符块血 ' + balance.b1 + ' / ' + balance.b6
      + '（旧公式 12 / 22）');

    /* ---------- 5. 无抖屏 / 无闪屏 ---------- */
    const visuals = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze();
      const R = D.run;
      const src = document.documentElement.innerHTML;
      const hasShakeField = Object.prototype.hasOwnProperty.call(R, 'shake');
      // 老实现的两个特征串：全屏闪烁的交替 alpha、位移抖动
      const oldFlash = src.indexOf('Math.floor(run.t * 20) % 2') >= 0;
      const oldShake = src.indexOf('ctx.translate(rnd(') >= 0;
      R.hurtCd = 0; R.hp = 3;
      D.hurt(1);
      return { hasShakeField, oldFlash, oldShake, edge: +R.edge.v.toFixed(2), hp: R.hp };
    })()`);
    step('★ 不存在屏幕位移抖动', visuals.hasShakeField === false && visuals.oldShake === false,
      'run.shake 字段=' + visuals.hasShakeField + '，位移抖动特征串=' + visuals.oldShake);
    step('★ 不存在全屏闪烁（改为边缘脉冲）',
      visuals.oldFlash === false && visuals.edge > 0.5 && visuals.hp === 2,
      '全屏闪烁特征串=' + visuals.oldFlash + '，受击边缘脉冲 v=' + visuals.edge);

    const decay = await evaluate(`(() => {
      const D = ${EXPORT};
      const R = D.run;
      const v0 = R.edge.v;
      D.step(40);
      const v1 = R.edge.v;
      D.step(60);
      return { v0: +v0.toFixed(2), v1: +v1.toFixed(2), v2: +R.edge.v.toFixed(2) };
    })()`);
    step('边缘脉冲会自行衰减（不残留）',
      decay.v1 < decay.v0 && decay.v2 === 0,
      decay.v0 + ' → ' + decay.v1 + ' → ' + decay.v2);

    /* ---------- 6. AI 接管 ---------- */
    const aiCheat = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze();
      const R = D.run;
      R.blocks.length = 0;
      const c0 = { hw: D.PADDLE_HW, r: D.BALL_R, spd: D.PADDLE_SPD, bspd: D.BALL_SPD };
      if (!D.AI.on) D.toggleAI();
      // 造一个「球在左边下落」的场面，逼 AI 必须移动
      const b = R.ball; b.stuck = false; b.stuckT = 0;
      b.x = 100; b.y = 600; b.vx = 0; b.vy = 7.4;
      let maxStep = 0;
      for (let i = 0; i < 30; i++) {
        const x0 = D.paddle.x;
        D.step(1);
        maxStep = Math.max(maxStep, Math.abs(D.paddle.x - x0));
      }
      const c1 = { hw: D.PADDLE_HW, r: D.BALL_R, spd: D.PADDLE_SPD, bspd: D.BALL_SPD };
      return { same: JSON.stringify(c0) === JSON.stringify(c1),
               maxStep: +maxStep.toFixed(2), spd: c0.spd,
               moved: +(D.paddle.x - 260).toFixed(1) };
    })()`);
    step('★ AI 不作弊（常量不变 + 单帧位移不超玩家移速）',
      aiCheat.same === true && aiCheat.maxStep <= aiCheat.spd + 0.01 && aiCheat.maxStep > 1,
      '玩家移速 ' + aiCheat.spd + 'px/帧，AI 单帧最大位移 ' + aiCheat.maxStep
      + '，30 帧内移动 ' + aiCheat.moved + 'px');

    // AI 真的能打：3 轮各 90 秒，看破阵数（单轮随机性太大，用多轮）
    const aiRuns = await evaluate(`(() => {
      const D = ${EXPORT};
      const out = [];
      for (let r = 0; r < 3; r++) {
        D.start(); D.freeze();
        if (!D.AI.on) D.toggleAI();
        D.step(5400);          // 90 秒游戏内时间
        out.push({ wave: D.run.wave, cleared: D.run.wallsCleared,
                   hp: D.run.hp, over: D.run.over,
                   blocks: D.run.blocks.length, score: D.run.score });
      }
      return out;
    })()`);
    const clearedList = aiRuns.map(r => r.cleared);
    step('★★ AI 接管能连续破阵',
      clearedList.every(n => n >= 2),
      aiRuns.map((r, i) => '#' + (i + 1) + ' 破阵' + r.cleared + '/第' + r.wave + '阵/HP' + r.hp).join('　'));

    /* ---------- 7. 二倍速 ---------- */
    const speedTest = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze();
      const R = D.run;
      if (D.speed === 2) D.toggleSpeed();
      const t0 = R.t; D.tick(10); const d1 = +(R.t - t0).toFixed(2);
      D.toggleSpeed();
      const t1 = R.t; D.tick(10); const d2 = +(R.t - t1).toFixed(2);
      const b = R.ball;
      const v = b.stuck ? 0 : Math.hypot(b.vx, b.vy);
      D.toggleSpeed();   // 还原成常速
      return { d1, d2, spd: D.BALL_SPD, v: +v.toFixed(2), speed: D.speed };
    })()`);
    step('★ 二倍速＝固定步长累加器（不是把 dt 乘 2）',
      Math.abs(speedTest.d1 - 10) < 1.01 && Math.abs(speedTest.d2 - 20) < 1.01,
      '同为 10 个显示帧：1x 推进 ' + speedTest.d1 + ' 步 / 2x 推进 ' + speedTest.d2 + ' 步');
    step('二倍速下灵弹速度常量不变（不会穿透）',
      speedTest.v === 0 || Math.abs(speedTest.v - speedTest.spd) < 0.01,
      '球速 ' + speedTest.v + ' / 常量 ' + speedTest.spd);

    /* ---------- 8. 渲染 ---------- */
    const ink = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze(); D.step(60);
      const c = document.querySelector('canvas');
      const g = c.getContext('2d');
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4000) if (d[i] > 20 || d[i+1] > 20 || d[i+2] > 20) n++;
      return n;
    })()`);
    step('Canvas 有实际绘制内容', ink > 100, '采样命中 ' + ink);

    /* ---------- 9. 死亡 ---------- */
    const died = await evaluate(`(() => {
      const D = ${EXPORT};
      D.start(); D.freeze();
      const R = D.run;
      R.hp = 1; R.hurtCd = 0; R.over = false;
      const before = R.hp;
      D.hurt(5);
      const mid = R.over;
      D.step(1);
      return { before, after: R.hp, mid, over: R.over };
    })()`);
    step('★ 掉光残机 → 游戏结束',
      died.after <= 0 && died.mid === false && died.over === true,
      'HP ' + died.before + '→' + died.after + '，over ' + died.mid + '→' + died.over);

    step('零未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | '));
  } catch (e) {
    // ⚠️ 导出不存在时，真正的病因几乎总是「页面脚本启动就抛错了」。
    //    只报 'no export' 等于把最关键的异常信息扔掉 —— 这里一并打出来。
    step('测试执行', false, e.message + (errs.length ? '　｜页面异常：' + errs.slice(0, 2).join(' ⏎ ') : ''));
  }

  await evaluate(`try { ${EXPORT}.unfreeze(); } catch(e) {}`);
  await sleep(500);
  await send('Page.captureScreenshot', {}).then(r => {
    if (r.result?.data) {
      fs.writeFileSync(path.resolve(__dirname, '_smoke.png'), Buffer.from(r.result.data, 'base64'));
      console.log('  📷 截图 _smoke.png');
    }
  });

  // ── 先出结论，再做收尾 ──
  const bad = report.steps.filter(s => !s.ok).length;
  console.log(`\n${bad ? '❌ ' + bad + ' 项失败' : '✅ 全部 ' + report.steps.length + ' 项通过'}`);
  try { ws.close(); } catch (e) {}
  try { killTree(proc); } catch (e) {}
  try { srv.close(); } catch (e) {}
  try { rmTree(profile); } catch (e) {}
  await new Promise(r => process.stdout.write('', () => r()));
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('崩溃:', e); process.exit(2); });

// ---- 极简 WebSocket（够用即可，不引第三方包） ----
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
