/**
 * 档案页配色对比度自检（WCAG 2.1 AA）
 *
 * 为什么需要这个脚本：
 *   把深色主题换成浅色时，最容易犯的错**不是**忘记改背景，而是
 *   「背景改成白的，强调色还是原来那套亮色」。深色主题的强调色是
 *   按「亮色配暗底」挑的 —— #ffc94a 在白底上对比度只有约 1.58:1，
 *   肉眼几乎看不见，而页面看起来「没报错、只是有点淡」，很难发现。
 *
 *   所以这里不靠眼睛，直接从**生成产物**里把颜色读回来算对比度：
 *   颜色值只有一处来源（_build_site.js 生成的 index.html），
 *   以后谁改了配色，跑一遍就知道有没有掉到 AA 线以下。
 *
 * 阈值：正文 ≥4.5:1；大号文字（≥24px，或 ≥18.66px 粗体）≥3:1。
 *
 * 用法：node _contrastcheck.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
if (!css) {
  console.error('❌ index.html 里没找到 <style> 块');
  process.exit(1);
}

// ---------- 从 CSS 里把颜色读回来（不做任何硬编码假设） ----------
const tokens = {};
for (const m of css.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
  tokens[m[1]] = m[2];
}

const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 取某个选择器块里的某个属性原始值（例如 '.card p' 的 color）
 *  ⚠️ 必须锚定「行首」——否则找 `a` 会命中 `.meta{` 里的那个 a，
 *     于是「普通链接」这一条读到的是 --dim（实测就这么错过一次：
 *     报告显示 #5f6a83，看着像通过了，其实根本没读到 `a{color:var(--cyan)}`）。 */
function decl(sel, prop) {
  const block = css.match(new RegExp('(?:^|\\n)[ \\t]*' + reEsc(sel) + '\\s*\\{([^}]*)\\}'));
  if (!block) return null;
  const hit = block[1].match(new RegExp('(?:^|;)\\s*' + reEsc(prop) + '\\s*:\\s*([^;}]+)', 'i'));
  return hit ? hit[1].trim() : null;
}

/** 把 var(--x) / #hex / rgb() 解析成一个具体颜色 */
function resolve(v) {
  if (!v) return null;
  const vm = v.match(/var\(\s*--([\w-]+)/);
  if (vm) return tokens[vm[1]] || null;
  const hm = v.match(/#[0-9a-fA-F]{3,8}/);
  return hm ? hm[0] : null;
}

// ---------- 颜色换算 ----------
function toRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (h.length === 8) h = h.slice(0, 6);           // 忽略 alpha：本页未使用半透明文字
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}
function lum(hex) {
  const [r, g, b] = toRgb(hex).map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(fgHex, bgHex) {
  const a = lum(fgHex), b = lum(bgHex);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// ---------- 要检查的「文字 / 背景」组合 ----------
// 每条都指向真实存在的 CSS 选择器，颜色从文件里现读。
const checks = [
  ['页面正文',        'body',         'color', () => tokens.bg,              false],
  ['小标题 h2',       'h2',           'color', () => tokens.bg,              false],
  ['统计标签',        '.stats',       'color', () => tokens.bg,              false],
  ['统计数字',        '.stats b',     'color', () => tokens.bg,              true ],
  ['卡片标题',        '.card h3',     'color', () => tokens.panel,           false],
  ['卡片正文',        '.card p',      'color', () => tokens.panel,           false],
  ['卡片编号',        '.card .no',    'color', () => tokens.panel,           false],
  ['断言通过',        '.meta .ok',    'color', () => tokens.panel,           false],
  ['断言失败',        '.meta .bad',   'color', () => tokens.panel,           false],
  ['存档说明',        '.card .prov',  'color', () => '#fbfaff',              false],
  ['存档徽标',        '.card.legacy .no', 'color', () => '#fbfaff',          false],
  ['普通链接',        'a',            'color', () => tokens.panel,           false],
  ['行内代码',        'code',         'color', () => resolve(decl('code', 'background')), false],
  ['时间线版本号',    '.tl .v',       'color', () => tokens.bg,              false],
  ['时间线正文',      '.tl .s',       'color', () => tokens.bg,              false],
  ['时间线列表',      '.tl ul',       'color', () => tokens.bg,              false],
  ['警告框',          '.warn',        'color', () => resolve(decl('.warn', 'background')), false],
  ['粗体强调',        'strong',       'color', () => tokens.panel,           false],
  ['页脚',            'footer',       'color', () => tokens.bg,              false],
];

let fail = 0, ran = 0;
console.log('配色对比度自检（WCAG 2.1 AA）\n');
console.log('  ' + '位置'.padEnd(14, '　') + '对比度   阈值   结果');
console.log('  ' + '─'.repeat(42));

for (const [label, sel, prop, bgFn, large] of checks) {
  const fg = resolve(decl(sel, prop));
  const bg = bgFn();
  if (!fg || !bg) {
    console.log(`  ${label.padEnd(14, '　')} ⚠️ 读不到颜色（${sel} / ${prop}）`);
    fail++; ran++;
    continue;
  }
  const ratio = contrast(fg, bg);
  const need = large ? 3.0 : 4.5;
  const ok = ratio >= need;
  if (!ok) fail++;
  ran++;
  console.log(`  ${label.padEnd(14, '　')} ${ratio.toFixed(2).padStart(5)}:1  ${need.toFixed(1).padStart(4)}   ${ok ? '✅' : '❌ 偏浅'}` +
    `   ${fg} on ${bg}`);
}

console.log('');
if (fail) {
  console.log(`❌ ${fail} / ${ran} 项未达 AA —— 浅色主题下这些颜色太淡，需要调深`);
  process.exit(1);
} else {
  console.log(`✅ 全部 ${ran} 项配色达标（正文 ≥4.5:1，大号字 ≥3:1）`);
}
