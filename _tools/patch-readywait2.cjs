/**
 * 批量把「固定 sleep 赌页面加载完」换成「轮询等导出对象真的出现」。
 *（第一批：space-line-v1 / starlane-v2 已改；这一版覆盖剩下 3 款分两行写法的）
 *
 * 症状：touhou-danmaku 本轮全量回归挂了 2 条，__DM 的 typeof 是 false ——
 *   但日志里没有任何游戏逻辑异常，因为页面**根本没执行到脚本末尾**。
 * 根因：找到 CDP tab ≠ 页面加载完。各 smoke.js 找到 tab 后一律
 *   `await sleep(1400~1600)` 然后直接查 window.__XX，页面慢一点就读到 undefined。
 *   这是「睡够就行」式的脆弱等待 —— 5 款都有，只是只有它慢到触发了。
 *
 * ⚠️ 踩到的第二个坑：合写一个正则去匹配「Runtime.enable + Page.enable 同一行」，
 *   结果只改到 2 款、另外 3 款**静默跳过**，看起来像修好了。
 *   原因：5 款的写法不一致（有的把两条 send 合在一行，有的是分两行）。
 *   → 这批改成按「Page.enable 那一行」锚定，两种写法都能命中；
 *     并且打「没找到就报错」，不让任何一款被静默放过。
 */
const fs = require('fs');
const path = require('path');

const TARGETS = [
  ['space-line-v1',    '__SpaceLine'],
  ['talisman-pinball', '__TP'],
  ['touhou-danmaku',   '__DM'],
  ['soul-knight',      '__SK'],
  ['starlane-v2',      '__SL'],
];

const MISS = [];
for (const [dir, exp] of TARGETS) {
  const p = path.resolve(__dirname, '../', dir, 'verify/smoke.js');
  let src = fs.readFileSync(p, 'utf8');
  if (src.includes('等页面脚本跑完')) { console.log(`- ${dir}: 已是新写法，跳过`); continue; }

  // 锚定 Page.enable 行，后面（隔 0~1 行）紧跟一条固定 sleep(NNNN)
  const re = /([ \t]*)await send\('Page\.enable'\);[ \t]*\r?\n(?:[ \t]*\r?\n)?\1await sleep\(\d+\);[^\n]*/;
  const m = src.match(re);
  if (!m) { MISS.push(dir); console.log(`❌ ${dir}: 没找到目标行`); continue; }
  const ind = m[1];

  const replacement =
    `${ind}await send('Page.enable');\n` +
    `${ind}// ⚠️ 这里原来是一句固定 sleep（等页面脚本跑完）。\n` +
    `${ind}//   「找到 CDP tab」**不等于「页面加载完」** —— tab 一出现就能连上，\n` +
    `${ind}//   但此时 index.html 可能还没执行到 window.${exp} = ... 那行。\n` +
    `${ind}//   症状：读到 undefined，报「暴露测试接口失败」，而游戏逻辑毫无异常。\n` +
    `${ind}//   踩到的现场：touhou-danmaku 全量回归挂 2 条，__DM 的 typeof=false。\n` +
    `${ind}// → 改成轮询真正的就绪条件：慢页面自然多等，快页面立刻进。\n` +
    `${ind}let __ready = false;\n` +
    `${ind}for (let __i = 0; __i < 100 && !__ready; __i++) {\n` +
    `${ind}  await sleep(200);\n` +
    `${ind}  try { __ready = await evaluate('typeof window.${exp} !== "undefined"'); } catch (e) { __ready = false; }\n` +
    `${ind}}\n` +
    `${ind}if (!__ready) console.log('⚠️ 等了 20 秒仍没等到 window.${exp}，后续判据大概率会误报');\n`;

  src = src.replace(re, replacement);
  fs.writeFileSync(p, src, 'utf8');
  console.log(`✅ ${dir}: 固定 sleep → 轮询 window.${exp}`);
}
if (MISS.length) {
  console.log(`\n❌ ${MISS.length} 款未改动，必须手工处理：${MISS.join(', ')}`);
  process.exit(1);
}
console.log('\n全部 5 款已改为轮询就绪');
