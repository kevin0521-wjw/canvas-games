/**
 * 生成「单文件 Canvas 游戏档案」首页。
 *
 * 设计要点：
 *  1. **数值不手填** —— 断言数从测试日志（/tmp/gt/*.log 里的「全部 N 项通过」）
 *     反解，避免文档写着 13 项、实际早就是 15 项这种「文案写死、数据动态」的
 *     自相矛盾（本轮在游戏 UI 里已经抓过两次同类问题，自己别犯）。
 *  2. **顺序来自 manifest** —— 按 order 字段排，不依赖目录名或 mtime。
 *  3. 生成的页面是纯静态单文件，可直接丢进 GitHub Pages。
 *
 * 用法：node _build_site.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

/** 从回归日志里读回真实断言数；读不到就标成「未通过」而不是猜一个。
 *  ⚠️ 日志必须放在**项目内**的 _logs/ —— 之前放在 /tmp，
 *     而 Node 在 Windows 上把 '/tmp' 解析成 C:\tmp，和 Git Bash 的 /tmp 不是一处，
 *     结果档案页上四款游戏的断言数全变成「未通过」（数字读不到 ≠ 测试没通过，
 *     但页面上分不出来，这种误导比没有数字更糟）。 */
function readLog(dir, id) {
  try { return fs.readFileSync(path.join(dir, id + '.log'), 'utf8'); }
  catch (e) { return null; }
}
function parseCount(text) {
  if (text === null) return null;
  const m = text.match(/全部\s+(\d+)\s+项通过/);
  if (m) return +m[1];
  if (/^\s*❌/m.test(text)) return null;   // 日志在、但有失败项 → 明确算未通过
  return null;
}
function assertCount(id) {
  const cands = [
    path.join(ROOT, '_logs'),   // 首选：_run_all.js 的产物
    '/tmp/gt',                  // 兜底：早期手写循环留下的
  ];
  for (const d of cands) {
    const t = readLog(d, id);
    if (t !== null) return parseCount(t);
  }
  return null;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** manifest 里允许两类轻量内联标记：**粗体** 与 `代码`。
 *  ⚠️ 之前 summary 用 esc() 直接输出，于是 manifest 里写的 `**第一个留档版本**`
 *     在页面上原样显示成星号（写的人和读的人会以为是排版崩了）。
 *     这里「先转义、再套标记」，既让标记生效，又不会让数据里的 HTML 注入页面。 */
function inline(s) {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** 页脚单独一条通道：manifest 里写的换行是 <br>，而 esc() 会把它转成
 *  &lt;br&gt; —— 结果页面上**原样显示成 "<br>" 六个字符**（实测线上就是这样，
 *  不是排版崩了，是转义转错了）。这里先整体转义、再只放行 <br> 与 **粗体**，
 *  其余标签照旧被吃掉，不给注入留口子。 */
function footerHtml(s) {
  return esc(s || '')
    .replace(/&lt;br\s*\/?&gt;/gi, '<br>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

const games = manifest.games.slice().sort((a, b) => a.order - b.order);
for (const g of games) {
  g.asserts = assertCount(g.id);
  g.exists = fs.existsSync(path.join(ROOT, g.dir, 'index.html'));
}

// 初版存档（legacy）单独计数：它是「起点」，不是第 5 款新游戏。
// 混在一起报「5 款游戏」会让人以为这轮又做了新作品，而实际是补录了一份历史存档。
const legacyGames = games.filter(g => g.legacy);
const ownGames = games.filter(g => !g.legacy);

// 版本按时间正序（「按序排列」）；最新一版标记为当前
const versions = (manifest.versions || []).slice()
  .sort((a, b) => String(a.date).localeCompare(String(b.date)));

const totalAssert = games.reduce((a, g) => a + (g.asserts || 0), 0);
const missing = games.filter(g => g.asserts === null).map(g => g.name);

// 目录里真实存在的快照（versions/<日期>/<游戏>/index.html）
const snapRoot = path.join(ROOT, 'versions');
const snaps = fs.existsSync(snapRoot)
  ? fs.readdirSync(snapRoot, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name).sort()
  : [];

const css = `
  /* 浅色主题。原先是一套深蓝底：这一页的时间线文本很长，深底 + 低对比灰字
     读久了累眼。浅底 + 深色语义色反而对比度更高，也更像「档案」该有的样子。
     ⚠️ 强调色**不能**沿用深色主题那一套 —— #ffc94a 在白底上对比度只有约
     1.6:1（≈ 看不见），#5ec8ff 约 1.9:1。下面每个色都按白底重挑过，
     并用 WCAG 对比度公式逐个复核，最低 4.9:1。 */
  :root{
    color-scheme:light;
    --bg:#f4f6fa; --panel:#ffffff; --line:#e3e7f0; --ink:#1a2333; --dim:#5f6a83;
    --gold:#96650a; --cyan:#0b6a9e; --jade:#0d7a52; --rose:#c12f47; --violet:#6247d0;
    --shade:rgba(23,37,74,.10);
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;line-height:1.7}
  .wrap{max-width:960px;margin:0 auto;padding:40px 22px 80px}
  h1{font-size:30px;margin:0 0 6px;letter-spacing:2px;font-weight:600}
  h1 small{display:block;font-size:12.5px;letter-spacing:3px;color:var(--dim);
    font-weight:400;margin-top:8px}
  h2{font-size:15px;letter-spacing:2px;color:var(--dim);font-weight:500;
    margin:44px 0 14px;padding-bottom:8px;border-bottom:1px solid var(--line)}
  .stats{display:flex;gap:26px;flex-wrap:wrap;margin:20px 0 0;font-size:13px;color:var(--dim)}
  .stats b{display:block;font-size:22px;color:var(--gold);font-weight:600;
    font-family:Consolas,monospace}
  .grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(290px,1fr))}
  .card{display:block;text-decoration:none;color:inherit;background:var(--panel);
    border:1px solid var(--line);border-radius:8px;padding:16px 17px;
    transition:.16s;position:relative}
  .card:hover{transform:translateY(-3px);border-color:var(--gold);
    box-shadow:0 10px 24px var(--shade)}
  .card .no{position:absolute;right:14px;top:12px;font-family:Consolas,monospace;
    font-size:11.5px;color:var(--dim)}
  /* 初版存档卡：视觉上要和「本仓库开发的四款」区分开 ——
     它是补录的历史文件，不是这一轮的新作品。 */
  .card.legacy{border-style:dashed;background:#fbfaff}
  .card.legacy .no{color:var(--violet);border:1px solid rgba(98,71,208,.35);
    border-radius:2px;padding:0 5px}
  .card .prov{margin-top:9px;padding-top:8px;border-top:1px dashed var(--line);
    font-size:11px;color:var(--dim);font-family:Consolas,monospace;line-height:1.75;
    word-break:break-all}
  .card .prov .u{color:var(--cyan)}
  .card h3{margin:0 0 3px;font-size:17px;color:var(--gold);font-weight:600}
  .card h3 em{font-style:normal;font-size:11px;letter-spacing:1.5px;color:var(--dim);
    margin-left:7px;font-family:Consolas,monospace}
  .card p{margin:7px 0 0;font-size:13px;color:#465268}
  .meta{margin-top:11px;display:flex;gap:14px;flex-wrap:wrap;font-size:11.5px;
    color:var(--dim);font-family:Consolas,monospace}
  .meta .ok{color:var(--jade)}
  .meta .bad{color:var(--rose)}
  .tl{list-style:none;padding:0;margin:0}
  .tl li{position:relative;padding:0 0 20px 24px;border-left:1px solid var(--line);
    margin-left:5px}
  .tl li:last-child{border-left-color:transparent;padding-bottom:0}
  .tl li::before{content:"";position:absolute;left:-5px;top:6px;width:9px;height:9px;
    border-radius:50%;background:#c6cddd}
  /* 深色主题里这圈光晕（box-shadow 0 0 10px）在白底上会糊成一团脏黄，
     改成实心环 —— 浅底上「扩散光」这个隐喻本身就不成立。 */
  .tl li.now::before{background:var(--gold);box-shadow:0 0 0 4px rgba(150,101,10,.14)}
  .tl .v{font-family:Consolas,monospace;color:var(--gold);font-size:13.5px}
  .tl .d{color:var(--dim);font-size:12px;margin-left:9px;
    font-family:Consolas,monospace}
  .tl .cur{display:inline-block;margin-left:9px;font-size:10.5px;padding:1px 7px;
    border:1px solid var(--gold);border-radius:2px;color:var(--gold)}
  .tl .s{font-size:13.5px;color:#38425a;margin-top:5px}
  .tl ul{margin:8px 0 0;padding-left:20px;font-size:13px;color:#525d75}
  .tl ul li{border:0;padding:2px 0;margin:0}
  .tl ul li::before{display:none}
  .snap{font-size:12.5px;color:var(--dim);font-family:Consolas,monospace;
    margin-top:10px;line-height:2}
  .snap a{color:var(--cyan);text-decoration:none}
  .snap a:hover{text-decoration:underline}
  /* manifest 的内联标记渲染出来的行内样式 */
  code{font-family:Consolas,"Cascadia Mono",monospace;font-size:12.5px;
    background:#eaf3fa;border:1px solid #cde1f0;
    border-radius:3px;padding:.5px 5px;color:#0b5a86}
  .ok{color:var(--jade)} .bad{color:var(--rose)}
  strong{color:#0f172a;font-weight:600}
  .warn{background:#fdf2f3;border:1px solid #f0c6cd;
    border-radius:6px;padding:11px 14px;font-size:12.5px;color:#8d2436;margin-top:14px}
  footer{margin-top:52px;padding-top:18px;border-top:1px solid var(--line);
    font-size:12px;color:var(--dim)}
  a{color:var(--cyan)}
`;

const cardHtml = games.map(g => `
      <a class="card${g.legacy ? ' legacy' : ''}" href="${esc(g.dir)}/index.html">
        <span class="no">${g.legacy ? '初版' : '#' + g.order}</span>
        <h3>${esc(g.name)}<em>${esc(g.en || '')}</em></h3>
        <p>${inline(g.tagline || '')}</p>
        <div class="meta">
          <span>${esc(g.genre || '')}</span>
          <span class="${g.asserts === null ? 'bad' : 'ok'}">${g.asserts === null ? '判据未通过' : g.asserts + ' / ' + g.asserts + ' 断言'}</span>
        </div>${g.legacy ? `
        <div class="prov">存档补录 · ${(g.originBytes || 0).toLocaleString()} 字节 · md5 ${esc(g.originMd5 || '')}<br>
          原始发布地址：<span class="u">${esc(g.origin || '')}</span><br>
          出处说明：${esc(g.dir)}/PROVENANCE.md</div>` : ''}
      </a>`).join('');

const tlHtml = versions.map((v, i) => {
  const isLast = i === versions.length - 1;
  return `
      <li class="${isLast ? 'now' : ''}">
        <span class="v">${esc(v.label)}</span><span class="d">${esc(v.date)}</span>${isLast ? '<span class="cur">当前</span>' : ''}
        <div class="s">${inline(v.summary || '')}</div>
        ${(v.notes && v.notes.length)
          ? '<ul>' + v.notes.map(n => `<li>${inline(n)}</li>`).join('') + '</ul>' : ''}
      </li>`;
}).join('');

// 每个快照带上**它自己那一版**的断言数（来自 versions/<日期>/_logs/），
// 而不是当前值 —— 否则历史快照区会跟着最新一次回归一起变，就不叫历史了。
const verByDate = {};
for (const v of versions) verByDate[v.date] = v;

const snapHtml = snaps.length
  ? snaps.map(d => {
      const v = verByDate[d];
      const links = games
        .filter(g => fs.existsSync(path.join(snapRoot, d, g.dir, 'index.html')))
        .map(g => {
          const c = parseCount(readLog(path.join(snapRoot, d, '_logs'), g.id));
          const badge = c === null ? '<span class="bad">未验</span>'
                                   : `<span class="ok">${c} 项</span>`;
          return `<a href="versions/${esc(d)}/${esc(g.dir)}/index.html">${esc(g.name)}</a> ${badge}`;
        }).join('　·　');
      const label = v ? `<span style="color:var(--gold)">${esc(v.label)}</span>　` : '';
      return `<div style="margin-bottom:15px">📦 <b>${esc(d)}</b>　${label}<div style="margin-top:3px">${links}</div></div>`;
    }).join('')
  : '<div>（还没有快照）</div>';

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(manifest.title)}</title>
<style>${css}</style>
</head>
<body>
<div class="wrap">
  <h1>${esc(manifest.title)}
    <small>${esc(manifest.subtitle || '')}</small></h1>

  <div class="stats">
    <div><b>${ownGames.length}</b>款游戏</div>
    ${legacyGames.length ? `<div><b>${legacyGames.length}</b>份初版存档</div>` : ''}
    <div><b>${totalAssert}</b>项断言</div>
    <div><b>${games.filter(g => g.asserts !== null).length}/${games.length}</b>判据全绿</div>
    <div><b>${snaps.length}</b>个历史快照</div>
    <div><b style="font-size:15px;padding-top:6px">${esc(manifest.updated || '')}</b>最后更新</div>
  </div>

  ${missing.length ? `<div class="warn">⚠️ 以下游戏的判据最近一次运行未全绿，卡片上标为「判据未通过」，
    不要当成已完成：${esc(missing.join('、'))}</div>` : ''}

  <h2>游戏（按交付顺序）</h2>
  <div class="grid">${cardHtml}
  </div>

  <h2>版本时间线（按时间正序）</h2>
  <ul class="tl">${tlHtml}
  </ul>

  <h2>历史快照</h2>
  <p style="font-size:13px;color:var(--dim);margin-top:0">
    每次改动完成后会把当时的完整版本复制一份到 <code>versions/&lt;日期&gt;/</code>，
    所以旧版随时可回滚、可对比。快照只增不改。</p>
  <div class="snap">${snapHtml}</div>

  <footer>
    ${footerHtml(manifest.footer)}
  </footer>
</div>
</body>
</html>
`;

fs.writeFileSync(path.join(ROOT, 'index.html'), html);

/** 产物自检：模板里漏写调用括号时，`${someFn}` 插进来的是**函数源码**，
 *  构建照样「成功」、控制台照样打 ✅，只有肉眼看页面才会发现页脚变成一段 JS。
 *  实测就这么错过一次，所以这里直接对产物做一次扫描。
 *
 *  ⚠️ 判据必须精确到「源码形态」，不能按关键字扫。第一版列了
 *     `function ` / `=>` / `const ` 这些裸词，结果**把记录这个 bug 的正文
 *     自己判成了错误** —— 因为那段文案里天然就要写这些词。
 *     第二版改成带跟随符号的形态，仍然拦住了一次：文案里写了 `require(`。
 *     最终只保留**两条中文句子绝不可能长成**的形态：
 *     带名字和左括号的 `function` 定义、以及后跟 `(`/`{` 的箭头函数。
 *     教训：判据的词表只能取「正文里不可能出现的形态」，不能取「词」。 */
const leakPats = [
  [/function\s+[A-Za-z_$][\w$]*\s*\(/, 'function 定义'],
  [/=>\s*[{(]/, '箭头函数'],
];
const leaked = leakPats.filter(([re]) => re.test(html)).map(([, name]) => name);
if (leaked.length) {
  console.error(`❌ index.html 里出现疑似源码残留：${leaked.join('、')}`);
  console.error('   多半是模板占位符写成了函数名本身、漏了调用括号。');
  process.exit(1);
}
console.log(`✅ 生成 index.html —— ${games.length} 款游戏 / ${totalAssert} 项断言 / ${snaps.length} 个快照`);
for (const g of games) {
  console.log(`   #${g.order} ${g.name.padEnd(16, '　')} 断言 ${g.asserts === null ? '未通过' : g.asserts}`);
}
if (missing.length) console.log(`⚠️ 判据未通过：${missing.join('、')}`);
