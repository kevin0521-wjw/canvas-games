/**
 * 留档快照：把当前四款游戏的版本复制到 versions/<日期>/<游戏>/。
 *
 * 为什么快照只增不改：`index.html` 是唯一源文件，改一次就覆盖一次，
 * 没有版本控制的话「昨天那版还能跑、今天这版反而崩了」就只能靠记忆复现。
 * 快照留一份当时可运行的完整版本，随时能回滚或对比。
 *
 * 只复制「源码 + 判据 + 当次回归日志」，不复制截图与浏览器 profile 缓存
 * （那些是可再生的垃圾）。
 *
 * 为什么要连当次回归日志一起留档：只留源码的话，半年后看到 versions/2026-10-12/
 * 只知道「当时长这样」，不知道「当时到底验过没有、验过几项」。日志是判据真的跑过
 * 的证据，和源码一样属于这个版本的属性，所以跟着版本一起走。
 *
 * 用法：node _snapshot.js [日期 YYYY-MM-DD]   ← 默认今天（**本地**日期）
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

/** ⚠️ 必须用**本地**日期，不能用 toISOString()：
 *  toISOString() 给的是 UTC 日期，在东八区凌晨 0:00–8:00 之间会串回前一天 ——
 *  实测凌晨 4 点跑出来的是 versions/2026-10-11/，而 manifest 里记的是 2026-10-12，
 *  于是档案页上凭空多出一个对不上版本号的快照目录。 */
function localDate() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const date = process.argv[2] || localDate();
const dest = path.join(ROOT, 'versions', date);

const games = manifest.games.slice().sort((a, b) => a.order - b.order);
let n = 0;

for (const g of games) {
  const src = path.join(ROOT, g.dir);
  const out = path.join(dest, g.dir);
  fs.mkdirSync(path.join(out, 'verify'), { recursive: true });

  const html = path.join(src, 'index.html');
  if (!fs.existsSync(html)) { console.log(`⚠️ 跳过 ${g.dir}：没有 index.html`); continue; }
  fs.copyFileSync(html, path.join(out, 'index.html'));

  // 判据脚本（.js）一并留档 —— 这样未来能对着这一版重跑同一套断言
  const vdir = path.join(src, 'verify');
  if (fs.existsSync(vdir)) {
    for (const f of fs.readdirSync(vdir)) {
      if (!f.endsWith('.js')) continue;          // 排除 _smoke.png / profile 目录
      fs.copyFileSync(path.join(vdir, f), path.join(out, 'verify', f));
    }
  }
  // 出处说明也一起走。对补录进来的存档（legacy）尤其重要：
  // 半年后看到 versions/<日期>/space-line-v1/ 只有源码的话，
  // 根本看不出「这份文件是从哪抓的、md5 对不对、是不是原样」。
  const prov = path.join(src, 'PROVENANCE.md');
  if (fs.existsSync(prov)) fs.copyFileSync(prov, path.join(out, 'PROVENANCE.md'));
  const kb = (fs.statSync(html).size / 1024).toFixed(0);
  console.log(`  📦 ${g.name.padEnd(18, '　')} ${kb} KB`);
  n++;
}

// 当次回归日志一并留档（有则复制，没有就留空——不编造）
let logN = 0;
const logSrc = path.join(ROOT, '_logs');
if (fs.existsSync(logSrc)) {
  const logDest = path.join(dest, '_logs');
  fs.mkdirSync(logDest, { recursive: true });
  for (const g of games) {
    const f = path.join(logSrc, g.id + '.log');
    if (!fs.existsSync(f)) continue;
    fs.copyFileSync(f, path.join(logDest, g.id + '.log'));
    logN++;
  }
}

console.log(`✅ 已快照 ${n} 款游戏${logN ? ` + ${logN} 份回归日志` : ''} → versions/${date}/`);
console.log('   下一步：node _build_site.js 重新生成档案页（快照会自动出现在「历史快照」区）');
