/**
 * 一键回归：并行跑四款游戏的冒烟测试，把输出落到 _logs/<游戏>.log。
 *
 * 为什么要有这一层：
 *   ① 日志放项目内（_logs/）而不是 /tmp —— Node 在 Windows 上把 '/tmp' 解析成
 *      C:\tmp，和 Git Bash 的 /tmp 不是同一个地方，_build_site.js 会读不到结果，
 *      于是档案页上所有断言数都变成「未通过」（踩过）。
 *   ② 日志留在仓库里 = 档案页上的数字有据可查，不是手填的。
 *   ③ 一条命令跑完并给出总览，省得每次手打四个 for 循环。
 *
 * 用法：node _run_all.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const NODE = process.execPath;
const LOGDIR = path.join(ROOT, '_logs');
fs.mkdirSync(LOGDIR, { recursive: true });

const games = manifest.games.slice().sort((a, b) => a.order - b.order);

function runOne(g) {
  return new Promise(resolve => {
    const out = [];
    const p = spawn(NODE, ['verify/smoke.js', 'index.html', g.export],
      { cwd: path.join(ROOT, g.dir) });
    p.stdout.on('data', d => out.push(d));
    p.stderr.on('data', d => out.push(d));
    p.on('close', code => {
      const text = Buffer.concat(out).toString('utf8');
      fs.writeFileSync(path.join(LOGDIR, g.id + '.log'), text + `\nEXIT=${code}\n`);
      resolve({ id: g.id, name: g.name, code, text });
    });
  });
}

/** 静态检查（毫秒级，不需要浏览器）：语法 + 配色对比度。
 *  放在无头回归**之前**跑 —— 它们快得多，能让「脚本写错了」这类问题
 *  在启动 5 个浏览器进程之前就暴露出来。 */
function runStatic(script, label) {
  return new Promise(resolve => {
    const out = [];
    const p = spawn(NODE, [script], { cwd: ROOT });
    p.stdout.on('data', d => out.push(d));
    p.stderr.on('data', d => out.push(d));
    p.on('close', code => resolve({ label, code, text: Buffer.concat(out).toString('utf8') }));
  });
}

(async () => {
  console.log('静态检查（语法 / 配色对比度）…\n');
  const statics = await Promise.all([
    runStatic('_syntaxcheck.js', '语法自检'),
    runStatic('_contrastcheck.js', '配色对比度'),
  ]);
  let staticFailed = 0;
  for (const s of statics) {
    const bad = s.text.split('\n').filter(l => l.includes('❌'));
    if (s.code !== 0) staticFailed++;
    console.log(`  ${s.code === 0 ? '✅' : '❌'} ${s.label}` +
      (s.code === 0 ? '' : ` —— ${bad[0] ? bad[0].trim() : '见下方输出'}`));
  }
  if (staticFailed) {
    for (const s of statics) if (s.code !== 0) console.log('\n' + s.text.trim());
    console.log('\n❌ 静态检查未通过，已跳过无头回归（先修上面这些）');
    process.exit(1);
  }
  console.log('');

  console.log(`并行跑 ${games.length} 款游戏的冒烟测试…\n`);
  const results = await Promise.all(games.map(runOne));

  let total = 0, failed = 0;
  console.log('  游戏                    判据         结果');
  console.log('  ' + '─'.repeat(52));
  for (const r of results) {
    const m = r.text.match(/全部\s+(\d+)\s+项通过/);
    const bad = (r.text.match(/^  ❌/gm) || []).length;
    const n = m ? +m[1] : null;
    if (n) total += n;
    const ok = r.code === 0;
    if (!ok) failed++;
    console.log('  ' + r.name.padEnd(22, ' ') +
      (n === null ? '—' : String(n)).padStart(6, ' ') + ' 项      ' +
      (ok ? '✅ 全绿' : `❌ ${bad} 项失败`));
  }
  console.log('  ' + '─'.repeat(52));
  console.log(`  合计 ${total} 项断言，${results.length - failed}/${results.length} 款全绿\n`);
  console.log('  下一步：node _build_site.js（断言数会从 _logs/ 自动填进档案页）');
  process.exit(failed ? 1 : 0);
})();
