/**
 * 语法自检：把每个 index.html 里的 <script> 抽出来，用 new Function 编译一遍。
 * new Function 只编译不执行 —— 正好当语法检查用，不需要 DOM。
 *
 * 为什么需要这一步：判据文件里全是 evaluate(`...`) 模板字符串，
 * 一旦在被测代码的**注释**里敲了一个反引号，模板会提前闭合，
 * 报错行号却指向文件开头（"missing ) after argument list"），极难定位。
 * 先跑这个能省一整轮 4~5 分钟的回归。
 *
 * 用法：node _syntaxcheck.js
 */
const fs = require('fs');
const path = require('path');

/* ⚠️ 游戏清单**从 manifest.json 读**，不要再硬编码。
 * 踩过：这里原本写死 `['talisman-pinball', ...]` 四款。补录 space-line-v1 之后，
 * 自检照跑照报「语法全部通过」，但初版根本没被编译过 —— 一个「新建了文件、
 * 检查器却默默不认」的静默缺口。清单只有一个来源（manifest），才不会再漂。 */
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
const games = manifest.games.slice().sort((a, b) => a.order - b.order).map(g => g.dir);
let bad = 0;

for (const g of games) {
  const dir = path.resolve(__dirname, g);
  // 1) 游戏本体：抽出 <script> 块编译
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const blocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  blocks.forEach((src, i) => {
    try { new Function(src); }
    catch (e) { bad++; console.log(`❌ ${g}/index.html script#${i}: ${e.message}`); }
  });
  if (blocks.length === 0) { bad++; console.log(`❌ ${g}/index.html: 没找到 <script> 块`); }

  // 2) 判据：直接交给 node 编译
  const files = fs.readdirSync(path.join(dir, 'verify')).filter(f => f.endsWith('.js'));
  for (const f of files) {
    const p = path.join(dir, 'verify', f);
    const src = fs.readFileSync(p, 'utf8');
    try { new Function(src); }
    catch (e) {
      bad++; console.log(`❌ ${g}/verify/${f}: ${e.message}`);
      // ⚠️ "missing ) after argument list" 几乎总是「模板字符串被提前闭合」，
      //   而报错行号指向的是 evaluate( 那一行，不是真正出问题的那行。
      //   这里直接把可疑行打出来，省掉一次「加日志→重跑 90 秒」的往返。
      if (/missing \) after argument list|Unexpected end of input/.test(e.message)) {
        const lines = src.split('\n');
        const suspect = [];
        lines.forEach((L, i) => {
          if (L.includes('evaluate(`') && L.includes('`') && !/\)\s*;?\s*$/.test(L.trim()) && !L.trim().endsWith('`')) suspect.push(i + 1);
        });
        console.log(`   ↳ 提示：这通常是 evaluate 模板内部（注释里）又写了反引号，导致模板提前闭合。`);
        if (suspect.length) console.log(`   ↳ evaluate 起始行：${suspect.join(', ')}（从这些行往后找第一个含反引号的注释）`);
      }
    }
    // 2b) 静态扫：evaluate 模板内部的注释行里含反引号 —— 提前闭合的直接元凶。
    //   主动报出来比等 new Function 报错更快，因为报错行号会指错地方。
    const ls = src.split('\n');
    ls.forEach((L, i) => {
      const t = L.trim();
      if ((t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) && L.includes('`')) {
        // 只在「这一行确实位于某个 evaluate 模板尚未闭合」的范围内报警
        const before = ls.slice(0, i).join('\n');
        const openCount = (before.match(/evaluate\(`/g) || []).length;
        const closeCount = (before.match(/\)\s*;?\s*$/gm) || []).length;
        if (openCount > closeCount) {
          bad++;
          console.log(`❌ ${g}/verify/${f}:${i + 1}  evaluate 模板内的注释含反引号 → 会提前闭合模板`);
          console.log(`   ↳ ${t.slice(0, 90)}`);
        }
      }
    });
  }
  console.log(`✅ ${g}: ${blocks.length} 个 script 块 + ${files.length} 个判据文件`);
}

console.log(bad === 0 ? '\n✅ 语法全部通过' : `\n❌ ${bad} 处语法错误`);
process.exit(bad === 0 ? 0 : 1);
