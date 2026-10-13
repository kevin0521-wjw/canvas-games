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
  :root{
    --bg:#0a0c14; --panel:#131829; --line:#243049; --ink:#e6ebf7; --dim:#8892ad;
    --gold:#ffc94a; --cyan:#5ec8ff; --jade:#3ddc97; --rose:#ff5b6e; --violet:#a98cff;
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
    box-shadow:0 10px 26px rgba(0,0,0,.5)}
  .card .no{position:absolute;right:14px;top:12px;font-family:Consolas,monospace;
    font-size:11.5px;color:var(--dim)}
  /* 初版存档卡：视觉上要和「本仓库开发的四款」区分开 ——
     它是补录的历史文件，不是这一轮的新作品。 */
  .card.legacy{border-style:dashed;background:#171b2e}
  .card.legacy .no{color:var(--violet);border:1px solid rgba(169,140,255,.4);
    border-radius:2px;padding:0 5px}
  .card .prov{margin-top:9px;padding-top:8px;border-top:1px dashed var(--line);
    font-size:11px;color:#7c86a3;font-family:Consolas,monospace;line-height:1.75;
    word-break:break-all}
  .card .prov .u{color:var(--cyan)}
  .card h3{margin:0 0 3px;font-size:17px;color:var(--gold);font-weight:600}
  .card h3 em{font-style:normal;font-size:11px;letter-spacing:1.5px;color:var(--dim);
    margin-left:7px;font-family:Consolas,monospace}
  .card p{margin:7px 0 0;font-size:13px;color:#b9c1d4}
  .meta{margin-top:11px;display:flex;gap:14px;flex-wrap:wrap;font-size:11.5px;
    color:var(--dim);font-family:Consolas,monospace}
  .meta .ok{color:var(--jade)}
  .meta .bad{color:var(--rose)}
  .tl{list-style:none;padding:0;margin:0}
  .tl li{position:relative;padding:0 0 20px 24px;border-left:1px solid var(--line);
    margin-left:5px}
  .tl li:last-child{border-left-color:transparent;padding-bottom:0}
  .tl li::before{content:"";position:absolute;left:-5px;top:6px;width:9px;height:9px;
    border-radius:50%;background:var(--line)}
  .tl li.now::before{background:var(--gold);box-shadow:0 0 10px var(--gold)}
  .tl .v{font-family:Consolas,monospace;color:var(--gold);font-size:13.5px}
  .tl .d{color:var(--dim);font-size:12px;margin-left:9px;
    font-family:Consolas,monospace}
  .tl .cur{display:inline-block;margin-left:9px;font-size:10.5px;padding:1px 7px;
    border:1px solid var(--gold);border-radius:2px;color:var(--gold)}
  .tl .s{font-size:13.5px;color:#c3cadb;margin-top:5px}
  .tl ul{margin:8px 0 0;padding-left:20px;font-size:13px;color:#aab3c8}
  .tl ul li{border:0;padding:2px 0;margin:0}
  .tl ul li::before{display:none}
  .snap{font-size:12.5px;color:var(--dim);font-family:Consolas,monospace;
    margin-top:10px;line-height:2}
  .snap a{color:var(--cyan);text-decoration:none}
  .snap a:hover{text-decoration:underline}
  /* manifest 的内联标记渲染出来的行内样式 */
  code{font-family:Consolas,"Cascadia Mono",monospace;font-size:12.5px;
    background:rgba(94,200,255,.1);border:1px solid rgba(94,200,255,.22);
    border-radius:3px;padding:.5px 5px;color:#9fdcff}
  .ok{color:var(--jade)} .bad{color:var(--rose)}
  strong{color:#fff;font-weight:600}
  .warn{background:rgba(255,91,110,.08);border:1px solid rgba(255,91,110,.4);
    border-radius:6px;padding:11px 14px;font-size:12.5px;color:#ffd4d9;margin-top:14px}
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
    ${esc(manifest.footer || '')}
  </footer>
</div>
</body>
</html>
`;

fs.writeFileSync(path.join(ROOT, 'index.html'), html);
console.log(`✅ 生成 index.html —— ${games.length} 款游戏 / ${totalAssert} 项断言 / ${snaps.length} 个快照`);
for (const g of games) {
  console.log(`   #${g.order} ${g.name.padEnd(16, '　')} 断言 ${g.asserts === null ? '未通过' : g.asserts}`);
}
if (missing.length) console.log(`⚠️ 判据未通过：${missing.join('、')}`);
