/**
 * 探针收尾的规范化 + 自检。
 *
 * 存在的理由：给 _tools/ 里的探针批量补「杀进程树 → 等句柄 → 删 profile → 冲刷 stdout」时，
 * 我踩了三个坑，每一个都写进了下面对应的注释：
 *   ① 插入锚定与内容替换**共用一个正则** → connect 的函数体开头被吃掉（node --check 报 Unexpected token '}'）
 *   ② 替换**没有幂等守卫** → 连跑两次出现 4 条冲刷语句，括号数从 137 涨到 139，脚本自己在造垃圾
 *   ③ 同步删 profile → 235 个文件实测 15 秒仍超时，而退出前没时间等 → 每次跑都留残骸
 *
 * 现在这个脚本做的是「幂等规范化 + 语法/括号/路径三重自检」，
 * 出问题直接报、绝不静默写出坏文件。辅助函数原文在 _cleanup-helper.js
 * （单独一个文件，避免把带反引号和花括号的大段代码塞进模板字符串 —— 那是坑 ① 的源头）。
 *
 * 用法：
 *   node _tools/probe-selfcheck.cjs           规范化（缺什么补什么）+ 自检
 *   node _tools/probe-selfcheck.cjs --check   只自检不写盘（适合收尾时随手跑）
 */
const fs = require('fs');
const path = require('path');

const CHECK_ONLY = process.argv.includes('--check');
const HELPER = fs.readFileSync(path.join(__dirname, '_cleanup-helper.js'), 'utf8');

/** 收尾规范化：全部幂等（每条都先问「已经改过了吗」） */
function normalizeTail(src) {
  // 1) 收尾处（最后一次出现）的 rmdir → dropProfile。
  //    ⚠️ 只能改**最后一次** —— 开跑前那次要保留成 purgeProfileSync（那时能同步删干净）。
  const rmdirRe = /try \{ execFileSync\('cmd',\s*\['\/c','rmdir','\/s','\/q',profile\],\s*\{stdio:'ignore'\}\); \} catch\(e\)\{\}/g;
  const m = [...src.matchAll(rmdirRe)];
  if (m.length >= 2) {
    const last = m[m.length - 1];
    src = src.slice(0, last.index) + 'dropProfile(profile);'
         + src.slice(last.index + last[0].length);
  }
  // 2) 开跑前那次 → purgeProfileSync
  const m2 = [...src.matchAll(rmdirRe)];
  if (m2.length >= 1) {
    const first = m2[0];
    src = src.slice(0, first.index) + 'if (!purgeProfileSync(profile)) console.log("⚠️ 上次留下的 profile 没清干净，可能会慢：", profile);'
         + src.slice(first.index + first[0].length);
  }
  // 3) 退出前冲刷 stdout（否则管道里最后那行结论会丢）
  const FLUSH = 'try { process.stdout.write(""); } catch (e) {}';
  if ((src.split(FLUSH).length - 1) === 0) {
    src = src.replace(/(\n[ \t]*)process\.exit\(0\);/,
      '$1' + FLUSH + '   // 冲刷，别丢掉刚写的结论\n$1process.exit(0);');
  }
  return src;
}

const JOBS = ['balance-probe3.cjs', 'ai-diag.cjs', 'ai-many.cjs', 'statediag.cjs', 'ddiag.cjs'];
let bad = 0;

for (const file of JOBS) {
  const p = path.join(__dirname, file);
  if (!fs.existsSync(p)) { console.log(`❌ ${file}: 不在 _tools/ 里`); bad++; continue; }

  const orig = fs.readFileSync(p, 'utf8');
  let src = orig;

  // ① 路径规范化（幂等）：从 _tmp/ 搬到 _tools/ 后 '../games/x' 少了一层
  src = src.split("'../games/").join("'../").split("'../games', ").join("'../', ");
  // ② 收尾规范化（幂等）
  src = normalizeTail(src);
  // ③ 辅助函数：幂等保护，缺了才插。锚点用 search（不是 replace）——
  //    第一版用 replace 把 connect 的函数体开头吃掉了。
  if (!src.includes('function purgeProfileSync')) {
    const anchor = src.search(/^(?:async )?function connect\(/m);
    if (anchor < 0) { console.log(`❌ ${file}: 找不到 connect 定义，无法插辅助函数`); bad++; continue; }
    src = src.slice(0, anchor) + HELPER + '\n\n' + src.slice(anchor);
    console.log(`  ${file}: 已插入收尾辅助函数`);
  }

  // 三重自检：括号平衡 + 语法 + 关键路径可解析 + **收尾里调到的函数都得存在**。
  // 最后这条是补的：之前 sleepSync 没定义，收尾第一行就抛 ReferenceError，
  // 后面的 dropProfile 全是死代码 —— 而结论在那之前就打了，所以**看起来一切正常**，
  // 只是 profile 一次没删掉过。「语法通过」和「收尾真的会跑」是两件事。
  const o = (src.match(/\{/g) || []).length, c = (src.match(/\}/g) || []).length;
  try {
    if (o !== c) throw new Error(`括号不平衡 o=${o} c=${c}`);
    new Function(src);
    const fm = src.match(/const FILE = path\.resolve\(__dirname, '([^']+)'/);
    if (fm && !fs.existsSync(path.resolve(__dirname, fm[1])))
      throw new Error(`路径解析不到文件：${fm[1]}`);
    if (!src.includes('dropProfile(profile)')) throw new Error('收尾没调 dropProfile');
    // 收尾段调到的每个本文件自定义函数，都必须有定义
    const tailStart = src.search(/\/\/ 收尾|try \{ ws\.close\(\)/m);
    if (tailStart > 0) {
      const tailSrc = src.slice(tailStart);
      for (const fn of ['killTree', 'dropProfile', 'purgeProfileSync', 'sleepSync']) {
        if (new RegExp('\\b' + fn + '\\s*\\(').test(tailSrc) && !src.includes('function ' + fn + '('))
          throw new Error(`收尾调了 ${fn}() 但它没有定义（这一行会抛 ReferenceError，后面的清理全成死代码）`);
      }
    }
    if (src === orig) console.log(`✅ ${file}  已规范（无改动）括号 ${o}/${c}`);
    else {
      if (!CHECK_ONLY) fs.writeFileSync(p, src, 'utf8');
      console.log(`✅ ${file}  已规范 括号 ${o}/${c}${CHECK_ONLY ? '（--check 未写盘）' : ''}`);
    }
  } catch (e) {
    console.log(`❌ ${file}: ${e.message.slice(0, 110)}`);
    bad++;
  }
}
process.exit(bad ? 1 : 0);