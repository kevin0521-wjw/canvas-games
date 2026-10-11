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

const games = ['talisman-pinball', 'touhou-danmaku', 'soul-knight', 'starlane-v2'];
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
    catch (e) { bad++; console.log(`❌ ${g}/verify/${f}: ${e.message}`); }
  }
  console.log(`✅ ${g}: ${blocks.length} 个 script 块 + ${files.length} 个判据文件`);
}

console.log(bad === 0 ? '\n✅ 语法全部通过' : `\n❌ ${bad} 处语法错误`);
process.exit(bad === 0 ? 0 : 1);
