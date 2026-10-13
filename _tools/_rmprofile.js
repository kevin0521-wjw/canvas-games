/**
 * 异步删除 headless 浏览器的 profile 目录 —— `dropProfile()` 的第二层兜底。
 *
 * 为什么需要它（都是实测踩出来的）：
 *   ① `cmd /c rmdir /s /q` 在这台机器上耗时**极不可预测**：
 *      235~461 个文件，有时 229ms 就完事，有时**跑满 30 秒被 SIGTERM 杀掉**
 *      （stderr 全空 —— 不是权限、不是路径，纯粹是慢）。
 *      而 `execFileSync` 那次只抛 ETIMEDOUT，看不到 signal，于是我一度去查
 *      「是不是 Edge 没退干净」，结果 Edge 早就退了。**用 spawnSync 才能看到 signal。**
 *   ② Node 的 fs 逐文件删同样飘：一次 169,680ms（safe-delete 垫片），另一次 14ms/文件。
 *   → 结论：别在主进程里等删除。这个脚本是**独立的 detached 进程**，
 *     主进程 spawn 它之后就 exit 走人，它自己删到删干净为止。
 *
 * 三层递进（都不阻塞调用方）：
 *   1. 等 800ms 让 Edge 的文件句柄彻底释放；
 *   2. 先试一次 cmd rmdir（给 20 秒）；
 *   3. 还剩就逐文件删 + 删空目录。
 *
 * 用法：node _rmprofile.js <目录>   （一般由 dropProfile 自动 spawn，不必手敲）
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) process.exit(0);

const nap = ms => { const t = Date.now() + ms; while (Date.now() < t); };

nap(800);   // 等句柄释放

// 第 2 层：cmd rmdir，给 20 秒
const r = spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', dir],
                    { stdio: 'ignore', timeout: 20000 });
if (!fs.existsSync(dir)) process.exit(0);

// 第 3 层：逐文件删（自底向上，先文件后目录）
let removed = 0, failed = 0;
function sweep(d) {
  let entries;
  try { entries = fs.readdirSync(d, { withFileTypes: true }); }
  catch (e) { failed++; return; }
  for (const e of entries) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) sweep(p);
    else { try { fs.unlinkSync(p); removed++; } catch (x) { failed++; } }
  }
  try { fs.rmdirSync(d); } catch (x) { failed++; }
}
sweep(dir);

if (fs.existsSync(dir)) {
  // 最后再试一次 rmdir（此时只剩空目录，成功率很高）
  try { spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', dir], { stdio: 'ignore', timeout: 15000 }); } catch (e) {}
}

if (fs.existsSync(dir)) {
  const out = path.join(__dirname, '_rmprofile.failed.log');
  try {
    fs.appendFileSync(out,
      `[${new Date().toISOString()}] 删不掉: ${dir}（已删 ${removed} 个，仍失败 ${failed} 个）\n`);
  } catch (e) { /* 记录都写不进去就算了 */ }
}
process.exit(0);