/**
 * 无头冒烟测试：符箓灵弹 · 元素阵（talisman-array）
 *
 * ⚠️ 这份判据是**后补的**。这款游戏在 2026-10-20 由另一次并行实现推到线上时
 *    只推了 index.html —— 自称的 26 项判据没有随仓库留档，也就是说任何人都无法
 *    重跑它来证明「这版当时是好的」。本仓库的规矩是「判据和源码一起走」，
 *    所以这里补一套最小但可复现的断言。
 *
 *    补判据时顺手抓到一个回归：draw() 里还留着 g.translate(rnd(-sh,sh)…) 式震屏，
 *    而 v1.3.0 已按用户要求把全站屏幕抖动移除。已在本次合并中删掉
 *    （run.shake 只保留计数，不再平移画布）。
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

    await evaluate(`${EXPORT}.startRun()`);
    await sleep(300);
    step('startRun() 未抛异常', errs.length === 0, errs[0] || '');

    // ★ 必须先 startRun 再 freeze：startRun 会新建 run，先取引用等于在跟上局的尸体说话
    const frozen = await evaluate(`(() => {
      const D = ${EXPORT};
      D.freeze();
      const R = D.run;
      const t0 = R.t;
      D.step(20);
      return { dt: +(R.t - t0).toFixed(1), scene: R.scene, over: R.over };
    })()`);
    step('★★ 冻结 rAF 后 step() 独占时钟',
      frozen.dt >= 18 && !frozen.over,
      '20 步推进 ' + frozen.dt + ' 单位，scene=' + frozen.scene);

    /* ---------- 1. 符阵墙 ---------- */
    const wall0 = await evaluate(`(() => {
      const D = ${EXPORT};
      D.startRun(); D.freeze();
      const R = D.run;
      D.step(30);
      const alive0 = R.blocks.filter(b => b.alive).length;
      const y0 = R.wallY;
      D.step(600);
      return {
        stage: R.stage, wave: R.wave, alive0,
        dy: +(R.wallY - y0).toFixed(1), speed: R.wallSpeed,
      };
    })()`);
    step('开局生成第 1 阵符墙', wall0.stage === 1 && wall0.wave === 1 && wall0.alive0 > 0,
      '第 ' + wall0.stage + ' 关 / 第 ' + wall0.wave + ' 阵 · ' + wall0.alive0 + ' 块');
    step('★ 符墙随时间下压（10 秒）',
      wall0.dy > 60 && wall0.dy < 320,
      '下移 ' + wall0.dy + 'px（配置速度 ' + wall0.speed + '）');

    /* ---------- 1.5 平衡数值：射速 / 墙速 / 血量（2026-10-22 用户实测反馈后调的） ---------- */
    const bal = await evaluate(`(() => {
      const D = ${EXPORT}, C = D.CFG;
      D.startRun(); D.freeze();
      const R = D.run;
      D.fireBall();
      return {
        cd: C.fireCd, bounce: C.fireCdBounce, net: C.fireCd - C.fireCdBounce,
        cdAfterFire: R.fireCd,
        wallBase: C.wallBaseSpeed, wallGain: C.wallSpeedGain,
        slowMax: C.wallSlowMax,
        hpBase: C.blockHpBase, hpGain: C.blockHpGain, dmg: C.dmgBase,
      };
    })()`);
    step('★ 射速：冷却 40 帧，命中只返还 5（净 35 帧 ≈0.58s，不再约等于连发）',
      bal.cd === 40 && bal.bounce === 5 && bal.net === 35 && bal.cdAfterFire === 40,
      'fireCd=' + bal.cd + ' 返还=' + bal.bounce + ' 净冷却=' + bal.net + ' 帧');
    step('★ 墙速：21+0.55×波 px/s（10 秒约走 210px，减速余量放到 9.5）',
      bal.wallBase === 21 && bal.wallGain === 0.55 && bal.slowMax === 9.5,
      'base=' + bal.wallBase + ' gain=' + bal.wallGain + ' slowMax=' + bal.slowMax);
    step('★ 符块血量 14+2.2×波 > 直接伤害 12（≥1.3 倍反应才能一发破）',
      bal.hpBase === 14 && bal.hpGain === 2.2 && bal.hpBase > bal.dmg,
      'hp=' + bal.hpBase + '+' + bal.hpGain + '×波 vs 直接伤害 ' + bal.dmg);

    /* ---------- 2. 元素反应表 ---------- */
    const table = await evaluate(`(() => {
      const D = ${EXPORT}, r = D.reactionOf;
      const g = (a, b) => { const x = r(a, b); return x ? x.name + ':' + x.mul : 'none'; };
      return {
        vapor: g('hydro', 'pyro'), vapor2: g('pyro', 'hydro'),
        overload: g('pyro', 'electro'), chain: g('hydro', 'electro'),
        swirl: g('anemo', 'pyro'), burn: g('pyro', 'pyro'),
        anemoSelf: g('anemo', 'anemo'),
      };
    })()`);
    step('★ 反应表：蒸发 2.0/1.6 · 超载 1.5 · 感电 1.3 · 风→扩散 1.1 · 同元素→燃烧',
      table.vapor === '蒸发:2' && table.vapor2 === '蒸发:1.6' &&
      table.overload === '超载:1.5' && table.chain === '感电:1.3' &&
      table.swirl === '扩散:1.1' && table.burn === '燃烧:1' &&
      table.anemoSelf === '燃烧:1',
      JSON.stringify(table));

    /* ---------- 2.5 冰系反应（2026-10-22 新增第五元素） ---------- */
    const ice = await evaluate(`(() => {
      const D = ${EXPORT}, r = D.reactionOf;
      const g = (a, b) => { const x = r(a, b); return x ? x.name + ':' + x.mul + ':' + x.kind : 'none'; };
      return {
        meltA: g('cryo', 'pyro'), meltB: g('pyro', 'cryo'),
        frzA: g('cryo', 'hydro'), frzB: g('hydro', 'cryo'),
        scA: g('cryo', 'electro'), scB: g('electro', 'cryo'),
        iceSelf: g('cryo', 'cryo'), anemoCryo: g('anemo', 'cryo'),
        cryoAnemo: g('cryo', 'anemo'),
        n: D.EL_ORDER.length, names: D.EL_ORDER.map(k => D.EL[k].name).join(''),
      };
    })()`);
    step('★ 冰系：融化 2.0/1.6 · 冻结（冰水/冰冰）· 超导 1.4/1.3 · 风冰→扩散',
      ice.meltA === '融化:2:melt' && ice.meltB === '融化:1.6:melt' &&
      ice.frzA === '冻结:1:freeze' && ice.frzB === '冻结:1.2:freeze' &&
      ice.scA === '超导:1.4:superconduct' && ice.scB === '超导:1.3:superconduct' &&
      ice.iceSelf === '冻结:1:freeze' &&
      ice.anemoCryo === '扩散:1.1:swirl' && ice.cryoAnemo === '扩散:1.1:swirl',
      JSON.stringify(ice));
    step('五元素入列：火水雷风冰，setEl(cryo) 生效',
      ice.n === 5 && ice.names === '火水雷风冰',
      'EL_ORDER=' + ice.names);

    /* ---------- 2.6 冻结 → 破冰 / 冰甲 ---------- */
    const frz = await evaluate(`(() => {
      const D = ${EXPORT};
      D.startRun(); D.freeze();
      const R = D.run;
      const mk = (el, hp, extra) => ({ col:0, row:0, w:58, h:34, el, hp, maxHp:hp,
        flash:0, alive:true, boss:false, burn:0, burnTick:0, wet:0, frozen:0,
        reactCd:0, armor:0, shift:0 });
      R.wallY = 200;
      // 冰打水 → 冻结
      const a = mk('hydro', 300); R.blocks = [a];
      D.hitBlock(a, 'cryo', 10);
      const frozen = a.frozen;
      // 火打冻结块 → 破冰 ×1.8（10 × 蒸发1.6 × 1.8 = 28.8）
      const b = mk('hydro', 300); b.frozen = 100; R.blocks = [b];
      const hp1 = b.hp;
      D.hitBlock(b, 'pyro', 10);
      const dmgBreak = +(hp1 - b.hp).toFixed(2);
      // 风打冻结块 → 冰甲未破 ×0.6（10 × 扩散1.1 × 0.6 = 6.6）
      const c = mk('hydro', 300); c.frozen = 100; R.blocks = [c];
      const hp2 = c.hp;
      D.hitBlock(c, 'anemo', 10);
      const dmgSoft = +(hp2 - c.hp).toFixed(2);
      return { frozen, dmgBreak, dmgSoft, burnCleared: a.burn };
    })()`);
    step('★ 冻结：冰水反应挂冻；火/雷破冰 1.8 倍，其他元素 ×0.6',
      frz.frozen > 0 && frz.dmgBreak === 28.8 && frz.dmgSoft === 6.6,
      '冻结 ' + frz.frozen + ' 帧；破冰掉 ' + frz.dmgBreak + '（期望 28.8）；冰甲掉 ' + frz.dmgSoft + '（期望 6.6）');

    /* ---------- 2.7 超导：范围削甲 ---------- */
    const sc = await evaluate(`(() => {
      const D = ${EXPORT};
      D.startRun(); D.freeze();
      const R = D.run;
      const mk = (col, el, hp) => ({ col, row:0, w:58, h:34, el, hp, maxHp:hp,
        flash:0, alive:true, boss:false, burn:0, burnTick:0, wet:0, frozen:0,
        reactCd:0, armor:0, shift:0 });
      R.wallY = 200;
      const t = mk(1, 'electro', 300), n = mk(2, 'electro', 300);
      t.armor = 4; n.armor = 4;
      R.blocks = [t, n];
      D.hitBlock(t, 'cryo', 10);          // 冰打雷 → 超导，范围削甲
      return { armorSrc: t.armor, armorNear: n.armor, rx: R.reactions['超导'] || 0 };
    })()`);
    step('★ 超导：范围内每块削 3 点护甲（源块不动）',
      sc.armorSrc === 4 && sc.armorNear === 1 && sc.rx === 1,
      '源块甲 ' + sc.armorSrc + ' → 邻块甲 ' + sc.armorNear + '，触发 ' + sc.rx + ' 次');

    /* ---------- 3. 反应是真伤害，不是弹个字 ---------- */
    const dmg = await evaluate(`(() => {
      const D = ${EXPORT};
      D.startRun(); D.freeze();
      const R = D.run;
      const mk = el => ({ col:0, row:0, w:58, h:34, el, hp:200, maxHp:200,
        flash:0, alive:true, boss:false, burn:0, burnTick:0, wet:0, frozen:0, reactCd:0, armor:0 });
      const a = mk('pyro'); R.blocks = [a];
      const ra = D.hitBlock(a, 'pyro', 10);          // 同元素 → 燃烧 ×1.0
      const b = mk('pyro'); R.blocks = [b];
      const rb = D.hitBlock(b, 'hydro', 10);         // 水打火 → 蒸发 ×2.0
      const c = mk('electro'); R.blocks = [c];
      const rc = D.hitBlock(c, 'pyro', 10);          // 火打雷 → 超载 ×1.5
      return {
        burn: +(200 - a.hp).toFixed(1), vapor: +(200 - b.hp).toFixed(1),
        overload: +(200 - c.hp).toFixed(1),
        names: [ra && ra.rx && ra.rx.name, rb && rb.rx && rb.rx.name, rc && rc.rx && rc.rx.name],
      };
    })()`);
    step('★ 反应真改变伤害（燃烧 10 / 蒸发 20 / 超载 15）',
      dmg.burn === 10 && dmg.vapor === 20 && dmg.overload === 15,
      JSON.stringify(dmg));

    /* ---------- 4. 燃烧：持续 + 蔓延 ---------- */
    const burn = await evaluate(`(() => {
      const D = ${EXPORT};
      D.startRun(); D.freeze();
      const R = D.run;
      const mk = (col, el, hp) => ({ col, row:0, w:58, h:34, el, hp, maxHp:hp,
        flash:0, alive:true, boss:false, burn:0, burnTick:0, wet:0, frozen:0, reactCd:0, armor:0, shift:0 });
      const a = mk(0, 'pyro', 300), b = mk(1, 'pyro', 300), c = mk(2, 'pyro', 300);
      R.blocks = [a, b, c];
      R.wallY = 200;
      D.hitBlock(a, 'pyro', 5);          // 点燃 a
      const hp0 = a.hp;
      D.step(60);
      const hp1 = a.hp;
      D.step(120);
      return {
        dot: +(hp0 - hp1).toFixed(1),
        spread: [b.burn > 0, c.burn > 0],
        anyBurning: R.blocks.filter(x => x.alive && x.burn > 0).length,
      };
    })()`);
    step('★ 燃烧持续掉血（1 秒 DoT）', burn.dot > 20,
      '点燃后 60 帧内再掉 ' + burn.dot + ' 血');
    step('★ 燃烧会向邻块蔓延', burn.anyBurning >= 2,
      '仍在燃烧的块数 ' + burn.anyBurning + '（邻块点燃=' + JSON.stringify(burn.spread) + '）');

    /* ---------- 5. 感电：同排连锁 ---------- */
    const chain = await evaluate(`(() => {
      const D = ${EXPORT};
      D.startRun(); D.freeze();
      const R = D.run;
      const mk = (col, el, hp) => ({ col, row:0, w:58, h:34, el, hp, maxHp:hp,
        flash:0, alive:true, boss:false, burn:0, burnTick:0, wet:0, frozen:0, reactCd:0, armor:0, shift:0 });
      const t = mk(1, 'hydro', 300), l = mk(0, 'pyro', 300), r = mk(2, 'pyro', 300);
      R.blocks = [t, l, r];
      R.wallY = 200;
      const hl = l.hp, hr = r.hp;
      D.hitBlock(t, 'electro', 10);      // 雷打水 → 感电，同排连锁
      return {
        left: +(hl - l.hp).toFixed(1), right: +(hr - r.hp).toFixed(1),
        arcs: R.arcs.length,
      };
    })()`);
    step('★ 感电同排连锁（左右邻块一起掉血）',
      chain.left > 0 && chain.right > 0 && chain.arcs > 0,
      '邻块掉血 ' + chain.left + ' / ' + chain.right + '，电弧 ' + chain.arcs + ' 条');

    /* ---------- 6. 蒸发范围打湿 / 扩散染色 ---------- */
    const aoe = await evaluate(`(() => {
      const D = ${EXPORT};
      D.startRun(); D.freeze();
      const R = D.run;
      const mk = (col, row, el, hp) => ({ col, row, w:58, h:34, el, hp, maxHp:hp,
        flash:0, alive:true, boss:false, burn:0, burnTick:0, wet:0, frozen:0, reactCd:0, armor:0, shift:0 });
      const t = mk(1, 0, 'pyro', 300), n = mk(2, 0, 'pyro', 300);
      R.blocks = [t, n];
      R.wallY = 200;
      D.hitBlock(t, 'hydro', 10);        // 蒸发：范围内邻块被"打湿"
      const wet = n.wet > 0;

      // 扩散：风打「火块」，把周围的水块吹成火（染色概率 55%，7 个候选里至少一块）
      D.startRun(); D.freeze();
      const R2 = D.run;
      const blk = [];
      for (let i = 0; i < 8; i++) blk.push(mk(i, 0, 'hydro', 300));
      blk[0].el = 'pyro';
      R2.blocks = blk;
      R2.wallY = 200;
      D.hitBlock(blk[0], 'anemo', 5);
      const tinted = blk.filter(b => b.el === 'pyro').length - 1;
      return { wet, tinted, swirl: (R2.reactions['扩散'] || 0) };
    })()`);
    step('★ 蒸发把范围内邻块打湿（后续火/雷可二次反应）', aoe.wet === true, 'wet=' + aoe.wet);
    step('★ 扩散把周围块染成同一元素（为成片反应铺路）',
      aoe.swirl > 0 && aoe.tinted >= 1,
      '扩散 ' + aoe.swirl + ' 次，染色 ' + aoe.tinted + ' 块');

    /* ---------- 7. 三关 × 8 阵 + Boss ---------- */
    const boss = await evaluate(`(() => {
      const D = ${EXPORT};
      D.startRun(); D.freeze();
      const R = D.run;
      R.stage = 2;
      D.spawnWave(8);                    // 第 8 阵必须是 Boss
      const core = R.blocks.find(b => b.boss);
      const before = { stage: R.stage, next: R.nextWave };
      const hp = core ? core.hp : -1;
      // ⚠️ run.boss 必须在 destroyBlock **之前**取值：击破时 destroyBlock 会把它置空，
      //    第一版就是在 return 里读，于是永远得到 false（判据自己错）。
      const hasBoss = !!R.boss;
      if (core) D.destroyBlock(core);
      return {
        stages: D.STAGES.length, has: !!core, hp, boss: hasBoss,
        before, stage: R.stage, next: R.nextWave,
      };
    })()`);
    step('共 3 关，每关 8 阵', boss.stages === 3, 'STAGES=' + boss.stages);
    step('第 8 阵生成 Boss 符核（血量随关卡 360+170×关）',
      boss.has === true && boss.hp === 700 && boss.boss === true,
      '第 2 关符核 HP=' + boss.hp);
    step('击破符核推进关卡', boss.stage === 3 && boss.next === 1,
      '关 ' + boss.before.stage + ' → ' + boss.stage + '，nextWave=' + boss.next);

    /* ---------- 8. 护甲块（逼玩家用反应） ---------- */
    const armor = await evaluate(`(() => {
      const D = ${EXPORT};
      D.startRun(); D.freeze();
      const R = D.run;
      R.stage = 2;
      D.spawnWave(1);
      const n = R.blocks.filter(b => b.armor > 0).length;
      return { n, total: R.blocks.length };
    })()`);
    step('第 2 关起出现护甲块（直接伤害被减免）', armor.n > 0,
      armor.n + ' / ' + armor.total + ' 块带护甲');

    /* ---------- 9. 破防扣血 ---------- */
    const breach = await evaluate(`(() => {
      const D = ${EXPORT};
      D.startRun(); D.freeze();
      const R = D.run;
      D.step(30);
      const hp0 = R.hp, wave0 = R.wave;
      R.wallY = 800;                     // 直接压到危险线以下
      D.step(4);
      return { hp0, hp1: R.hp, wave0, wave1: R.wave, y: +R.wallY.toFixed(1) };
    })()`);
    step('★ 符阵越过危险线 → 扣心 + 墙面回到顶部',
      breach.hp1 <= breach.hp0 - 2 && breach.y <= 120,
      'HP ' + breach.hp0 + '→' + breach.hp1 + '，墙 y=' + breach.y);

    /* ---------- 11. 环境弹幕「天象」（2026-10-22 新增） ---------- */
    const env = await evaluate(`(() => {
      const D = ${EXPORT};
      D.startRun(); D.freeze();
      const R = D.run;
      const mk = (el, hp) => ({ col:0, row:0, w:58, h:34, el, hp, maxHp:hp,
        flash:0, alive:true, boss:false, burn:0, burnTick:0, wet:0, frozen:0,
        reactCd:0, armor:0, shift:0 });

      // ① spawnEnv 直接落弹：结构 + 元素性格（水弹半径最大）
      R.shots.length = 0;
      D.spawnEnv('hydro');
      const s = R.shots[0] || {};

      // ② 自动调度：timer 归零 → 预警线（元素合法）→ 预警结束落弹
      R.shots.length = 0;
      R.env.timer = 1;
      D.step(5);
      const warn = R.env.warn;
      const warnElOk = warn ? D.EL_ORDER.includes(warn.el) : false;
      D.step(D.CFG.envWarn + 10);
      const autoShots = R.shots.filter(x => x.env).length;

      // ③ 环境弹打在符块上 = 完整反应，但**不计分**
      const a = mk('pyro', 300);
      R.blocks = [a]; R.wallY = 200;
      const score0 = R.score;
      D.hitBlock(a, 'hydro', D.CFG.envDmg, true);
      const rxN = R.reactions['蒸发'] || 0;

      // ④ 水弹命中后溅成两滴小的（斜向上溅 + 轻重力，出生点在命中点上方）
      //    ⚠️ 必须在命中【当帧】就抓：小水滴带重力会落、横漂会出界，
      //    step 一大段时间再查只会看到"被回收剩下的"，那是判据自己错。
      R.blocks = [a]; R.shots.length = 0;
      D.spawnEnv('hydro');
      R.shots[0].x = D.blockCX(a);
      R.shots[0].y = 100;
      let small = 0, smallVy = [], guard = 0;
      while (guard++ < 200) {
        D.step(1);
        const sp = R.shots.filter(x => x.split);
        if (sp.length) { small = sp.length; smallVy = sp.map(x => +x.vy.toFixed(2)); break; }
      }

      // ⑤ 冰弹命中玩家 → 扣一心 + 符盘被冻（移速 ×0.55 由 updatePlayer 实现）
      D.startRun(); D.freeze();
      const R2 = D.run;
      const hp0 = R2.hp;
      D.spawnEnv('cryo');
      R2.shots[0].x = D.paddle.x;
      R2.shots[0].y = 780;                 // PADDLE_Y=792，贴符盘
      D.step(2);
      return {
        env: s.env === true, el: s.el, r: s.r,
        warned: !!warn, warnElOk, autoShots,
        rxN, scoreGain: R.score - score0,
        small, smallVy,
        hpLost: hp0 - R2.hp, frozenPaddle: R2.paddleFreeze,
      };
    })()`);
    step('★ 天象弹结构：env 标记 + 元素字段（水弹半径最大 = 封走位）',
      env.env === true && env.el === 'hydro' && env.r === 8,
      'env=' + env.env + ' el=' + env.el + ' r=' + env.r);
    step('★ 天象自动调度：倒计时 → 预警线（0.75s）→ 落弹',
      env.warned === true && env.warnElOk === true && env.autoShots >= 1,
      '预警元素合法=' + env.warnElOk + '，预警后落了 ' + env.autoShots + ' 发');
    step('★ 天象弹打符块触发完整反应，但不计分（不能站着白刷）',
      env.rxN === 1 && env.scoreGain === 0,
      '蒸发 ' + env.rxN + ' 次，得分变化 ' + env.scoreGain);
    step('★ 水弹命中后溅成两滴小的（命中当帧溅出，斜向上）',
      env.small === 2 && env.smallVy.length === 2 && env.smallVy.every(v => v < 0),
      '水花 ' + env.small + ' 滴，vy=' + env.smallVy.join('/'));
    step('★ 冰弹命中玩家：扣心 + 符盘冻结 1.5 秒',
      env.hpLost === 1 && env.frozenPaddle > 0,
      'HP -' + env.hpLost + '，冻结 ' + env.frozenPaddle + ' 帧');

    /* ---------- 13. Q 键循环覆盖五元素 ---------- */
    const q = await evaluate(`(() => {
      const D = ${EXPORT};
      D.startRun(); D.freeze();
      const seq = [];
      for (let i = 0; i < 6; i++) {
        dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ' }));
        seq.push(D.run.el);
      }
      return seq.join(',');
    })()`);
    step('Q 循环覆盖全部五元素（火→水→雷→风→冰→火）',
      q === 'hydro,electro,anemo,cryo,pyro,hydro', q);

    /* ---------- 12. 稳定性 ---------- */
    const stable = await evaluate(`(() => {
      const D = ${EXPORT};
      D.startRun(); D.freeze();
      const R = D.run;
      D.step(600);
      const bad = [];
      const chk = (v, n) => { if (!Number.isFinite(v)) bad.push(n); };
      chk(R.hp, 'hp'); chk(R.wallY, 'wallY'); chk(R.score, 'score');
      chk(D.paddle.x, 'paddle.x'); chk(D.paddle.aim, 'paddle.aim');
      for (const b of R.blocks) { chk(b.hp, 'block.hp'); chk(b.wallY || 0, 'block.wallY'); }
      return { bad: bad.slice(0, 4), blocks: R.blocks.length, over: R.over };
    })()`);
    step('600 帧后关键状态无 NaN / Infinity', stable.bad.length === 0,
      stable.bad.length ? '异常字段：' + stable.bad.join(',') : '场上 ' + stable.blocks + ' 块，状态正常');
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
