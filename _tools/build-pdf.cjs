/**
 * HTML → PDF 打印器 —— 用 headless Edge 的 CDP `Page.printToPDF`。
 *
 * 为什么不用 `--print-to-pdf` 命令行开关：
 *   命令行开关没法传 `footerTemplate`（页码就丢了），也拿不到
 *   `preferCSSPageSize` 的可靠行为。而 CDP 这三个参数都能精确控制，
 *   并且和判据脚本共用同一套 CDP 连接代码 —— 一份基础设施，六款游戏 + 两份文档共用。
 *
 * 为什么源文件必须留在仓库里：
 *   2026-10-19 那版 PDF 是用命令行开关打的，源 HTML 没留档，
 *   于是半年后想改一个字都无从下手（只能整篇重写）。
 *   这版把源文件一起入库（docs/开发过程与借鉴分析.html），
 *   改文字 → 重跑本脚本 → 覆盖 PDF，全程可复现。
 *
 * 用法：
 *   node _tools/build-pdf.cjs --in "docs/开发过程与借鉴分析.html" \
 *                             --out "docs/开发过程与借鉴分析.pdf"
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const IN = path.resolve(ROOT, arg('in', 'docs/开发过程与借鉴分析.html'));
const OUT = path.resolve(ROOT, arg('out', 'docs/开发过程与借鉴分析.pdf'));
const PAGES = arg('pages', '');          // 形如 "1-8"：只打这一段页（分块打印用）
const CDP_PORT = 9800 + (crypto.randomBytes(1)[0] % 60);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sleepSync = ms => { const a = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(a, 0, 0, ms); };

function killTree(proc) {
  try {
    if (process.platform === 'win32')
      execFileSync('cmd', ['/c', 'taskkill', '/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    else proc.kill('SIGKILL');
  } catch (e) {}
  try { proc.kill(); } catch (e) {}
  sleepSync(700);
}
function rmTree(dir) {
  if (!fs.existsSync(dir)) return;
  try { execFileSync('cmd', ['/c', 'rmdir', '/s', '/q', dir], { stdio: 'ignore', timeout: 8000 }); } catch (e) {}
}

(async () => {
  if (!fs.existsSync(IN)) { console.error('❌ 源文件不存在：' + IN); process.exit(1); }

  const profile = path.resolve(__dirname, '_pdfprof');
  rmTree(profile);
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
    `--remote-debugging-port=${CDP_PORT}`,
    '--user-data-dir=' + profile,
    '--window-size=1100,1500',
    'about:blank',
  ], { stdio: 'ignore' });

  const get = pathname => new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: CDP_PORT, path: pathname }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });

  let tab = null;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const tabs = await get('/json/list');
      tab = tabs.find(t => t.type === 'page');
      if (tab && tab.webSocketDebuggerUrl) break;
    } catch (e) {}
    await sleep(400);
  }
  if (!tab) { console.error('❌ 45s 内没找到页面标签'); killTree(proc); process.exit(1); }

  const ws = await connect(tab.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onMessage = raw => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params) => new Promise(r => {
    const i = ++id; pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });

  await send('Page.enable');
  await send('Runtime.enable');

  // 用 file:// 打开本地源文件（中文路径要转 file:/// + encodeURI）
  const url = 'file:///' + IN.split(path.sep).map(encodeURIComponent).join('/');
  await send('Page.navigate', { url });

  // ⚠️ 必须等「布局完成」，不能只看 DOM 就绪。
  //   printToPDF 打的是**已排版**的页面：字体没度量完、表格还没算高时按下打印，
  //   Chrome 会只打出当前已布局的那部分（实测 9 页 / 正文只落了三分之一）。
  //   判据：body.scrollHeight 连续两次采样不再变化。
  await sleep(900);
  let h = 0, stable = 0;
  for (let i = 0; i < 40; i++) {
    const r = await send('Runtime.evaluate', {
      expression: 'document.body.scrollHeight + "|" + document.title + "|" + document.body.innerText.length',
      returnByValue: true,
    });
    const v = r.result?.result?.value || '';
    const parts = v.split('|');
    const cur = parseInt(parts[0], 10) || 0;
    if (cur === h && cur > 0) { if (++stable >= 2) break; }
    else { stable = 0; h = cur; }
    await sleep(250);
  }
  const probe = (await send('Runtime.evaluate', {
    expression: 'document.title + "|" + document.body.innerText.length',
    returnByValue: true,
  })).result?.result?.value || '';
  console.log('  源文档：' + probe.split('|')[0]);
  console.log('  正文 ' + (probe.split('|')[1] || '?') + ' 字符 / 布局高度 ' + h + 'px（连续稳定后）');

  /* ---- 护栏 ①：标签配平（**读源文件**，不是读 DOM）----
   * ⚠️ 必须读文件、不能读 DOM：HTML 解析器遇到未闭合的 <div> 会**自动补齐**，
   *   所以浏览器里的 DOM 永远是配平的，querySelectorAll 永远查不出问题。
   *   要抓漏写的标签，只能数源文件里的开合次数。
   *
   * 2026-11-10 那版 PDF 只印出 9 页 / 正文三分之一，根因就是 1.2.4 那张时间线的
   * 5 行各少写一个 </div>：后面所有内容都被塞进第一行的 .txt（flex 子项，
   * min-content 只有 47px），表格全被压成 260px 竖条，文档撑到上百页，
   * Chrome 的 print-to-PDF 只吐了 9 页就停 —— 且没有半个字的报错。 */
  const raw = fs.readFileSync(IN, 'utf8');
  const bodyRaw = raw.slice(raw.indexOf('<body') >= 0 ? raw.indexOf('<body') : 0);
  const unbalanced = [];
  for (const tag of ['div', 'table', 'tr', 'td', 'th', 'ul', 'ol', 'li', 'p', 'pre']) {
    const o = (bodyRaw.match(new RegExp(`<${tag}(\\s|>)`, 'g')) || []).length;
    const c = (bodyRaw.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    if (o !== c) unbalanced.push(`${tag}（${o} 开 / ${c} 闭）`);
  }
  if (unbalanced.length) {
    console.error('❌ 源文件标签不配平：' + unbalanced.join('，'));
    console.error('   ↳ 出 PDF 之前必须先修好 —— 内容会被塞进前一个容器，印出来的是残件。');
    killTree(proc); process.exit(1);
  }

  const footer = `<div style="font-family:'Segoe UI','Microsoft YaHei',sans-serif;font-size:7pt;color:#938a78;
      width:100%;padding:0 16mm;display:flex;justify-content:space-between;">
      <span>从街机厅到浏览器 · 六款单文件 Canvas 游戏的设计笔记与心路历程</span>
      <span>canvas-games v1.5.1 · 2026-11-10 · 第 <span class="pageNumber"></span> / <span class="totalPages"></span> 页</span>
    </div>`;

  const res = await send('Page.printToPDF', {
    printBackground: true,
    preferCSSPageSize: true,          // 让 @page { size: A4; margin: ... } 生效
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: footer,
    marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
    ...(PAGES ? { pageRanges: PAGES } : {}),
    transferMode: 'ReturnAsBase64',
  });

  const data = res.result?.data;
  if (!data) {
    console.error('❌ printToPDF 没返回数据：' + JSON.stringify(res).slice(0, 300));
    killTree(proc); process.exit(1);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const buf = Buffer.from(data, 'base64');
  fs.writeFileSync(OUT, buf);

  /* ---- 护栏 ②：页数 vs 布局估算 ----
   * 2026-11-10 那次翻车的真正机制：HTML 少写 5 个 </div> → 后面所有内容被塞进
   * 一个 flex 子项 → 文档实际撑到上百页 → Chrome 的 print-to-PDF 只吐了 9 页就停，
   * **没有半个字的报错**（命令行 --print-to-pdf 与 CDP 两条路一模一样）。
   *
   * 「2.26MB 上限」是个假结论：修好布局后完整 PDF 有 4.58MB、25 页，照样正常。
   * 真正稳定的信号是**页数与布局估算严重不符**。
   * 估算 = 内容高度 / A4 可用高度 + 强制分页数；实测低于估算的 60% 即判为被截断。 */
  const est = (await send('Runtime.evaluate', {
    expression: `(() => {
      const h = document.body.scrollHeight;
      const PAGE_PX = 997;           // A4 297mm − 页边距 33mm = 264mm @96dpi
      let forced = 0;
      for (const el of document.querySelectorAll('*')) {
        const c = getComputedStyle(el);
        if (c.pageBreakBefore === 'always' || c.pageBreakAfter === 'always') forced++;
      }
      return Math.ceil(h / PAGE_PX) + forced;
    })()`,
    returnByValue: true,
  })).result?.result?.value || 0;

  const kb = (buf.length / 1024).toFixed(0);
  const cnt = [...buf.toString('latin1').matchAll(/\/Count\s+(\d+)/g)].map(m => +m[1]);
  const pages = cnt.length ? Math.max(...cnt) : 0;
  if (pages && est && pages < est * 0.6) {
    console.error(`\n❌ 只印出 ${pages} 页，但布局估算 ${est} 页 —— 内容被 Chrome 截断了`);
    console.error('   ↳ 这是残件，不能交付。先查 HTML 布局是否塌掉（标签配平已过的话，看表格宽度 / flex 容器）。');
    killTree(proc); process.exit(1);
  }
  console.log(`\n✅ 已生成 ${path.relative(ROOT, OUT)}  ${kb} KB / ${pages} 页（布局估算 ${est} 页）`);
  console.log('   源文件：' + path.relative(ROOT, IN) + '（已入库，改完重跑本脚本即可覆盖 PDF）');

  try { ws.close(); } catch (e) {}
  killTree(proc);
  rmTree(profile);
  process.exit(0);
})().catch(e => { console.error('崩溃:', e); process.exit(2); });

/* ---- 极简 WebSocket（与判据脚本同构） ---- */
const http = require('http');
function connect(url) {
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
