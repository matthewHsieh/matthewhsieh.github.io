import { $, $$, esc, fmt, fmtMax, isNum, norm, num, plClass, signed, state } from '../core.js';
import { heldSymbols, idxRatio, usIdxRatio } from '../portfolio.js';
import { TW_STOCKS } from '../symbols.js';
import { bindStockOpen } from './stock.js';
import { line } from '../widgets.js';

// 族群頁：台股看落後的月營收，美股看前瞻的營收預估，兩邊分開看
// ------------------------------------------------------------
// 產業地圖
//
//   **第一版是分組的卡片列表，不是地圖。** 39 個族群疊成 3,300px，
//   上中下游只是一個小標籤而不是位置，關係只有「下游 1」這種文字，
//   而且要點開才看得到。名字叫產業鏈，看起來卻跟清單沒兩樣。
//
//   實際算過之後發現：台股 39 個族群裡有 35 個是互相連通的，
//   而且全部匯流到伺服器組裝。所以這根本不是「很多條鏈」，是**一條大鏈**。
//   那就該照它本來的樣子畫——上游、中游、下游三條帶子，由上往下流。
//
//   位置本身要帶資訊：在哪一條帶子上＝在供應鏈的哪一段，
//   不用再讀標籤。點一個族群時不是展開一塊面板，而是**把整張圖變暗、
//   只留它的上下游**，關係直接顯示在圖上。
// ------------------------------------------------------------
// ------------------------------------------------------------
// 產業地圖：桌機版
//
//   手機上只能靠「點一格、其餘變暗」來表達關係，因為 390px 畫不下連線。
//   螢幕夠寬的時候沒有這個限制，**線可以真的畫出來**。
//
//   為什麼不用拓撲分層（每個節點放在「最長上游路徑」那一層）：
//   實際算過是 27 / 7 / 2 / 1 / 1 / 1，第一層塞 27 個、後面幾層各一個，
//   比三欄還難看。上中下游是 8 / 21 / 10，平均得多，而且本來就有意義。
//
//   代價是同一欄內部有連線（中游→中游 10 條、下游→下游 4 條）。
//   處理方式是欄內先做拓撲排序讓它們一律往下流，線畫成欄右側的弧，
//   而且**平常畫得很淡、選中才亮**——這是密集網路圖的通用做法，
//   全部畫滿一樣粗只會變成一團毛線。
// ------------------------------------------------------------
const DESK_Q = typeof matchMedia === 'function' ? matchMedia('(min-width: 900px)') : null;

const isDesk = () => !!(DESK_Q && DESK_Q.matches);

// 欄內排序：只看同一欄的邊，讓來源排在目標前面
function orderColumn(list, links) {
  const inCol = new Set(list.map((m) => m.theme));
  const depth = new Map(list.map((m) => [m.theme, 0]));
  const edges = links.filter((l) => inCol.has(l.src) && inCol.has(l.dst));
  // 邊數很少（最多十幾條），跑幾輪鬆弛就會收斂，不值得寫正式的拓撲排序
  for (let i = 0; i < list.length; i += 1) {
    let moved = false;
    for (const l of edges) {
      const want = depth.get(l.src) + 1;
      if (depth.get(l.dst) < want) { depth.set(l.dst, want); moved = true; }
    }
    if (!moved) break;
  }
  return [...list].sort((a, b) => (depth.get(a.theme) - depth.get(b.theme))
    || a.parent.localeCompare(b.parent) || num(a.sort) - num(b.sort));
}

// 三段的顏色。用 dataviz 的驗證腳本跑過：明暗兩種模式都在亮度帶內、
// 彩度足夠、色盲相鄰分離 ΔE 19.3（deutan），一般視覺 23.3。
// tritan 是 6.3 落在下限帶，規則是「只有搭配次要編碼才算數」——
// 這裡每一格都有文字標籤、每一欄都有標題，符合。
const STAGE_HUE = ['#0d9488', '#6366f1', '#d97706'];

// ------------------------------------------------------------
// 產業地圖：天賦樹版（桌機）
//
//   前一版被說「像簡單的心智圖搭配說明」，而且電腦版空間利用率很低。
//   兩個原因：節點是方形文字框（看起來就是清單），資訊只能點出來（要多一步）。
//
//   網遊天賦樹的特徵其實很具體：
//     1. 節點是**圓形圖示**，名字在圖示下面而不是裡面
//     2. **滑過去就出資訊**，點擊是「鎖定」不是「查看」
//     3. 連線粗、是畫面的一部分，不是附註
//     4. 已點亮的節點有光暈
//   這一版照這四點做。
//
//   **hover 不能整個重畫。** 39 個節點每次滑過都重建 innerHTML 會閃，
//   所以聚焦是直接改 class（applyFocus），只有換市場／換篩選才重畫。
// ------------------------------------------------------------

// 圖示用族群名的第一個字。比硬湊一套符號好——每個都不一樣、
// 而且看到「玻」就知道是玻纖布，不用解碼。
function glyphOf(theme) {
  const t = String(theme || '').trim();
  const m = t.match(/^[A-Za-z0-9]+/);
  if (m) return m[0].slice(0, 3).toUpperCase();
  return t.slice(0, 1);
}

// 選一個族群時，誰要亮、亮多強
function computeFocus(mk, sel) {
  if (!sel) return { near: new Map(), path: new Map(), lit: null };
  const links = state.themeLinks.filter((l) => l.market === mk);
  const walk = (dir) => {
    const seen = new Set();
    const queue = [sel];
    while (queue.length) {
      const cur = queue.shift();
      for (const l of links) {
        const [a, b] = dir === 'up' ? [l.dst, l.src] : [l.src, l.dst];
        if (a !== cur || seen.has(b) || b === sel) continue;
        seen.add(b); queue.push(b);
      }
    }
    return seen;
  };
  const near = new Map();
  const path = new Map();
  walk('up').forEach((t) => path.set(t, 'up'));
  walk('down').forEach((t) => path.set(t, 'down'));
  links.filter((l) => l.dst === sel).forEach((l) => near.set(l.src, 'up'));
  links.filter((l) => l.src === sel).forEach((l) => near.set(l.dst, 'down'));
  near.set(sel, 'self');
  return { near, path, lit: new Set([sel, ...near.keys(), ...path.keys()]) };
}

// 只改 class，不重建 DOM——hover 才不會閃
function applyFocus(host, mk, sel) {
  const { near, path, lit } = computeFocus(mk, sel);
  $$('.mnode', host).forEach((n) => {
    const t = n.dataset.node;
    const rel = near.get(t) || '';
    const far = !rel && (path.get(t) || '');
    n.classList.toggle('rel-self', rel === 'self');
    n.classList.toggle('rel-up', rel === 'up');
    n.classList.toggle('rel-down', rel === 'down');
    n.classList.toggle('far', !!far);
    n.classList.toggle('far-up', far === 'up');
    n.classList.toggle('far-down', far === 'down');
    n.classList.toggle('dim', !!sel && !rel && !far);
  });
  $$('.medges path', host).forEach((p) => {
    const a = p.dataset.src, b = p.dataset.dst;
    let cls = 'e';
    if (sel) {
      if (a === sel) cls = 'e down';
      else if (b === sel) cls = 'e up';
      else if (lit && lit.has(a) && lit.has(b)) cls = 'e path';
      else cls = 'e off';
    }
    p.setAttribute('class', cls);
    const strong = cls === 'e up' || cls === 'e down';
    p.setAttribute('marker-end', `url(#ar${p.dataset.col}${strong ? 'h' : ''})`);
  });
}

// 把浮出框擺到被點的那一格旁邊，並且夾在地圖範圍內。
// **地圖本身不會因為它出現而改變**，這是跟原本那張插入式卡片最大的差別。
function placePop(wrap, sel, target) {
  const pop = target || $('.mpop.anchored.pinned', wrap) || $('.mpop.anchored', wrap);
  if (!pop || !sel) return;
  const node = $$('.mnode', wrap).find((n) => n.dataset.node === sel);
  if (!node) return;
  const box = wrap.getBoundingClientRect();
  const r = node.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  const GAP = 14;
  // 垂直對齊格子中線，再夾回範圍內
  let y = r.top - box.top + r.height / 2 - ph / 2;
  y = Math.max(0, Math.min(y, Math.max(0, box.height - ph)));

  // **選遮住最少「亮著的格子」的那一側。** 不管放哪邊都會蓋到東西，
  // 但蓋到變暗的格子沒差，蓋到同一條路徑上的就等於把剛點亮的東西藏起來。
  const lit = $$('.mnode', wrap).filter((n) => !n.classList.contains('dim'));
  const covers = (x) => lit.filter((n) => {
    const q = n.getBoundingClientRect();
    const nx = q.left - box.left, ny = q.top - box.top;
    return nx < x + pw && nx + q.width > x && ny < y + ph && ny + q.height > y;
  }).length;
  const right = Math.min(Math.max(0, r.right - box.left + GAP), Math.max(0, box.width - pw));
  const left = Math.min(Math.max(0, r.left - box.left - pw - GAP), Math.max(0, box.width - pw));
  const x = covers(left) <= covers(right) ? left : right;
  pop.style.left = `${Math.round(x)}px`;
  pop.style.top = `${Math.round(y)}px`;
  pop.classList.add('ready');
}

// 量完位置才畫得出線，所以一定要在 DOM 上去之後做
// 邊的三種狀態：選中的直接關係（強）、同一條路徑上的（中）、其餘（幾乎看不見）。
// 這樣看到的是「一整條分支」，不是「一個點加兩根鬚」。
function edgeState(mk, sel, l) {
  if (!sel) return 'e';
  if (l.src === sel) return 'e down';
  if (l.dst === sel) return 'e up';
  const lit = state.mapLit;
  if (lit && lit.has(l.src) && lit.has(l.dst)) return 'e path';
  return 'e off';
}

function drawEdges(wrap, mk, sel) {
  const svg = $('.medges', wrap);
  if (!svg) return;
  const box = wrap.getBoundingClientRect();
  const pos = new Map();
  $$('.mnode', wrap).forEach((n) => {
    // 接在圓盤上，不是整顆按鈕（按鈕還包含下面的名字，接在那裡線會歪）
    const r = ($('.mdisc', n) || n).getBoundingClientRect();
    pos.set(n.dataset.node, {
      l: r.left - box.left, r: r.right - box.left,
      cy: r.top - box.top + r.height / 2,
      col: Number(n.dataset.col),
    });
  });
  const W = Math.round(box.width), H = Math.round(box.height);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);

  const defs = [];
  const dim = [];
  const lit = [];
  let gi = 0;

  for (const l of state.themeLinks.filter((x) => x.market === mk)) {
    const a = pos.get(l.src), b = pos.get(l.dst);
    if (!a || !b) continue;
    const on = sel && (l.src === sel || l.dst === sel);
    let x1, y1, x2, y2, d;
    // **判斷依據是實際座標，不是欄位編號。** 中游排成兩個子欄，
    // CCL（左子欄）→ PCB（右子欄）其實是左到右，照同欄處理會繞一大圈。
    if (a.r + 10 <= b.l) {
      x1 = a.r; y1 = a.cy; x2 = b.l; y2 = b.cy;
      const mid = (x1 + x2) / 2;
      d = `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
    } else {
      // 真的重疊了才繞。最後一欄往右繞會跑出畫面，所以那一欄往左繞。
      const left = b.col === 2;
      const x = left ? Math.min(a.l, b.l) - 26 : Math.max(a.r, b.r) + 26;
      x1 = left ? a.l : a.r; y1 = a.cy;
      x2 = left ? b.l : b.r; y2 = b.cy;
      d = `M ${x1} ${y1} C ${x} ${y1}, ${x} ${y2}, ${x2} ${y2}`;
    }
    // 漸層由來源段的顏色走到目標段的顏色，方向感就出來了，
    // 不用靠箭頭也看得出誰餵誰。userSpaceOnUse 是因為同欄的弧線
    // bbox 寬度接近 0，用 objectBoundingBox 會算不出漸層。
    const id = `eg${gi++}`;
    defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse"
      x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">
      <stop offset="0" stop-color="${STAGE_HUE[a.col]}"/>
      <stop offset="1" stop-color="${STAGE_HUE[b.col]}"/></linearGradient>`);
    const cls = edgeState(mk, sel, l);
    const strong = cls === 'e up' || cls === 'e down';
    // 端點記在 data 上，applyFocus 才能只改 class 而不用重畫整張圖
    const path = `<path class="${cls}" d="${d}" stroke="url(#${id})"
      data-src="${esc(l.src)}" data-dst="${esc(l.dst)}" data-col="${b.col}"
      marker-end="url(#ar${b.col}${strong ? 'h' : ''})"/>`;
    // 亮的畫在後面才不會被淡的蓋住
    (strong || cls === 'e path' ? lit : dim).push(path);
  }

  const marker = (i, hi) => `<marker id="ar${i}${hi ? 'h' : ''}" viewBox="0 0 8 8"
    refX="7" refY="4" markerWidth="${hi ? 6 : 5}" markerHeight="${hi ? 6 : 5}"
    orient="auto-start-reverse" markerUnits="userSpaceOnUse">
    <path d="M 0 1 L 7 4 L 0 7 z" fill="${STAGE_HUE[i]}" opacity="${hi ? 1 : 0.55}"/></marker>`;
  svg.innerHTML = `<defs>${[0, 1, 2].map((i) => marker(i) + marker(i, true)).join('')}
    ${defs.join('')}</defs>${dim.join('')}${lit.join('')}`;
}

const STAGES = [
  ['上游', '原料與設備', '誰供貨給這條鏈'],
  ['中游', '製造與零組件', '把材料變成零件'],
  ['下游', '成品與服務', '賣給終端客戶'],
];

function themeStats(mk, theme) {
  if (mk === 'tw') {
    const t = state.themeTrend.find((x) => x.theme === theme);
    const v = state.themeVal.find((x) => x.theme === theme);
    return { members: t ? num(t.members) : (v ? num(v.total) : null),
             growth: t ? num(t.yoy) : null,
             ratio: v ? v.ratio_median : null, pe: v ? v.pe1_median : null };
  }
  const u = state.usThemeTrend.find((x) => x.theme === theme);
  return { members: u ? num(u.members) : null, growth: u ? num(u.growth_next) : null,
           ratio: u ? u.ratio_median : null, pe: u ? u.pe_next_median : null };
}

const linksOf = (mk, theme) => ({
  up: state.themeLinks.filter((l) => l.market === mk && l.dst === theme),
  down: state.themeLinks.filter((l) => l.market === mk && l.src === theme),
});

export function renderThemeMap(host, mk) {
  const metas = state.themeMeta.filter((m) => m.market === mk);
  if (!metas.length) {
    host.innerHTML = '<div class="card"><p class="muted">還沒有產業分類資料。</p></div>';
    return;
  }
  const sel = state.mapPick && metas.some((m) => m.theme === state.mapPick) ? state.mapPick : null;
  const desk = isDesk();
  const grp = state.mapGroup || '';
  const held = mk === 'tw' ? heldSymbols() : new Set(state.us.map((s) => norm(s.symbol)));
  const memberRows = mk === 'tw' ? state.themeMembers : state.usThemeMembers;
  const mine = new Set(memberRows.filter((m) => held.has(norm(m.symbol))).map((m) => m.theme));
  const bench = mk === 'tw' ? idxRatio() : usIdxRatio();
  const parents = [...new Set(metas.map((m) => m.parent))];

  // 聚焦狀態不在這裡算——那是 applyFocus 的事，因為 hover 時只能改 class，
  // 重建 innerHTML 會閃。這裡只負責把靜態的樹畫出來。

  // 主動型 ETF 重壓的族群要看得出來。標的是**族群裡被吃最兇的那一檔
  // 佔它股本的幾 %**，不是基金檔數——每檔基金都放台積電不代表台積電是題材。
  // 只有台股有，美股那邊沒有對應的持股來源。
  const etfBy = new Map(mk === 'tw'
    ? (state.themeEtf || []).map((r) => [r.theme, r]) : []);
  const etfMark = (theme) => {
    const e = etfBy.get(theme);
    const own = num(e && e.top_own);
    if (!e || own < 0.5) return '';
    return `<span class="metf${own >= 3 ? ' hot' : ''}">${fmt(own, 1)}%</span>`;
  };

  // 桌機是圓形圖示節點（名字在下面），手機維持方塊（390px 放不下圖示 + 名字）
  const tile = (m, col) => {
    const s = themeStats(mk, m.theme);
    const owned = mine.has(m.theme);
    if (!desk) {
      return `<button type="button" class="mnode${owned ? ' mine' : ''}"
        data-node="${esc(m.theme)}" data-col="${col}">
        <span class="mname">${esc(m.theme)}${etfMark(m.theme)}</span>
        <span class="mrow"><span class="${plClass(num(s.growth))}">${
          isNum(s.growth) ? signed(num(s.growth) * 100, 0) + '%' : '–'}</span>
          <span class="muted">${fmt(s.members)} 檔</span></span>
      </button>`;
    }
    return `<button type="button" class="mnode talent${owned ? ' mine' : ''}"
      data-node="${esc(m.theme)}" data-col="${col}">
      <span class="mdisc"><span class="mglyph">${esc(glyphOf(m.theme))}</span>
        <span class="mcount">${fmt(s.members)}</span>${etfMark(m.theme)}</span>
      <span class="mname">${esc(m.theme)}</span>
      <span class="mstat ${plClass(num(s.growth))}">${
        isNum(s.growth) ? signed(num(s.growth) * 100, 0) + '%' : '–'}</span>
    </button>`;
  };

  // 大類篩選在這裡就過濾掉，不要留給 CSS——用 display:none 藏格子的話，
  // 整條帶子會變成「只有標題、裡面空無一物」的空殼。
  const byStage = (st) => metas
    .filter((m) => (m.stage || '中游') === st && (!grp || m.parent === grp))
    .sort((a, b) => (a.parent === b.parent ? num(a.sort) - num(b.sort) : a.parent.localeCompare(b.parent)));

  const detailOf = (theme, pinned) => (() => {
    const sel = theme;
    const c = linksOf(mk, sel);
    const meta = metas.find((m) => m.theme === sel);
    const s = themeStats(mk, sel);
    const rows = memberRows.filter((m) => m.theme === sel);
    const line = (l, dir) => `<div class="mlink">
      <span class="marrow">${dir === 'up' ? '↑' : '↓'}</span>
      <button type="button" class="link" data-node="${esc(dir === 'up' ? l.src : l.dst)}">${
        esc(dir === 'up' ? l.src : l.dst)}</button>
      ${l.note ? `<span class="sub muted">${esc(l.note)}</span>` : ''}</div>`;
    // **不能是一張插在版面裡的卡。** 它一出現整張圖就往下推，
    // 點下一格又推一次，位置一直跳——使用者的說法是「不穩定」。
    // 改成浮在地圖上、貼著被點的那一格（桌機）或釘在底部（手機），
    // 就像天賦樹的 tooltip：出現與消失都不會動到樹本身。
    return `<div class="mpop${desk ? ' anchored' : ' sheet'}${pinned ? ' pinned' : ''}">
      <div class="row-between">
        <span class="list-title">${esc(sel)}</span>
        ${pinned ? '<button type="button" class="small" data-node-clear>關閉</button>'
          : '<span class="sub muted">點一下鎖定</span>'}
      </div>
      <p class="sub muted">${esc(meta?.parent || '')}・${esc(meta?.stage || '')}　${
        fmt(s.members)} 檔${isNum(s.ratio) ? `　報酬/波動 <b class="${
          num(s.ratio) > bench ? 'gain' : ''}">${fmtMax(s.ratio, 2)}</b>` : ''}${
        isNum(s.pe) ? `　本益比 ${fmtMax(s.pe, 1)}x` : ''}</p>
      ${c.up.length ? `<div class="mgroup"><div class="mlabel">誰供貨給它</div>${
        c.up.map((l) => line(l, 'up')).join('')}</div>` : ''}
      ${c.down.length ? `<div class="mgroup"><div class="mlabel">它供貨給誰</div>${
        c.down.map((l) => line(l, 'down')).join('')}</div>` : ''}
      ${!c.up.length && !c.down.length
        ? '<p class="sub muted">這個族群沒有登記上下游關係。</p>' : ''}
      ${rows.length ? `<div class="mgroup"><div class="mlabel">成分股</div>
        <div class="chain-row members">${rows.map((m) =>
          `<button type="button" class="chip plain" data-stock="${mk}:${esc(norm(m.symbol))}">${
            esc(m.symbol)} ${esc(m.name || TW_STOCKS[norm(m.symbol)] || '')}${
            held.has(norm(m.symbol)) ? '<span class="badge day-badge">持有</span>' : ''}</button>`).join('')}</div>
      </div>` : ''}
    </div>`;
  })();
  const detail = sel ? detailOf(sel, true) : '';

  host.innerHTML = `
    <div class="card mhead">
      <div class="list-title">產業地圖</div>
      <p class="sub muted">由上往下是供應鏈的流向。${mk === 'tw'
        ? '台股 39 個族群裡有 35 個互相連通，而且<b>全部匯流到伺服器組裝</b>——這不是很多條鏈，是一條大鏈。'
        : '美股這張圖同樣由上往下流，終點是雲端與 AI 應用。'}
        ${desk ? '線就是供應關係，點一格會把它的線亮起來。' : '點任何一格，圖上只會留下它的上下游。'}</p>
      <div class="mchips">
        <button type="button" class="chip${grp ? '' : ' on'}" data-group="">全部</button>
        ${parents.map((p) => `<button type="button" class="chip${
          grp === p ? ' on' : ''}" data-group="${esc(p)}">${esc(p)}</button>`).join('')}
      </div>
    </div>
    <div class="mapwrap${desk ? ' desk' : ''}">
      ${desk ? '<svg class="medges" aria-hidden="true"></svg>' : ''}
      ${desk ? detail : ''}
      ${desk ? `<div class="mcols">${STAGES.map(([st, title, sub], i) => {
        const list = orderColumn(byStage(st), state.themeLinks.filter((l) => l.market === mk));
        if (!list.length) return '';
        // 中游有 21 個、上下游各 8 與 10，單欄排下去高度會差三倍。
        // 超過 12 個就排成兩欄，三欄的高度才接近。
        // 欄內再依大類分群。天賦樹的分支感就是這樣來的——
        // 一欄裡不是 21 個並排，是三四個有名字的小群。
        const clus = [];
        for (const m of list) {
          let g = clus.find((x) => x.name === m.parent);
          if (!g) { g = { name: m.parent, list: [] }; clus.push(g); }
          g.list.push(m);
        }
        return `<div class="mcol band-${i}">
          <div class="mband-head"><b>${st}</b><span class="muted">${title}</span>
            <span class="sub muted">${sub}</span></div>
          ${clus.map((g) => `<div class="mclus">
            <div class="mclus-label">${esc(g.name)}</div>
            <div class="mclus-nodes">${g.list.map((m) => tile(m, i)).join('')}</div>
          </div>`).join('')}
        </div>`;
      }).join('')}</div>`
      : STAGES.map(([st, title, sub], i) => {
        const list = byStage(st);
        if (!list.length) return '';
        return `<div class="mband band-${i}">
          <div class="mband-head"><b>${st}</b><span class="muted">${title}</span>
            <span class="sub muted">${sub}</span></div>
          <div class="mgrid">${list.map((m) => tile(m, i)).join('')}</div>
        </div>
        ${i < STAGES.length - 1 ? '<div class="mflow">↓</div>' : ''}`;
      }).join('')}
    </div>
    ${desk ? '' : detail}
    <p class="hint">格子的位置就是它在供應鏈的位置，不用再讀標籤。
      數字是${mk === 'tw' ? '月營收年增（已發生）' : '明年營收預估（前瞻）'}。
      左邊有藍線的是你有持股的族群。${mk === 'tw' ? `
      圈上的小數字是<b>主動型 ETF 吃掉的股本比例</b>（族群裡被吃最兇的那一檔），
      <span class="metf hot">3%</span> 以上轉紅——到那個量級浮額是真的變少了。` : ''}
      <b>攤開來看最大的用處是檢查自己有沒有把同一條鏈買了很多次</b>——
      玻纖布 → CCL → PCB → 伺服器組裝是同一條，分開看像四個標的，實際上是一個賭注。</p>`;

  const pick = (t) => { state.mapPick = state.mapPick === t ? null : t; renderThemeMap(host, mk); };
  $$('[data-node]', host).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); pick(b.dataset.node); }));

  // **滑過去就出資訊，點擊才是鎖定。** 天賦樹就是這樣：
  // 看一個天賦不用點，點是為了「選它」。原本什麼都要點一下才看得到，
  // 39 個節點要逐一點過去才知道是什麼，那才是不直覺的來源。
  if (desk) {
    const wrap = $('.mapwrap', host);
    let hoverPop = null;
    const clearHover = () => {
      if (hoverPop) { hoverPop.remove(); hoverPop = null; }
      applyFocus(host, mk, state.mapPick);
    };
    $$('.mnode', host).forEach((n) => {
      n.onmouseenter = () => {
        const t = n.dataset.node;
        if (state.mapPick === t) return;         // 已經鎖定它了就不用再浮一個
        applyFocus(host, mk, t);
        if (hoverPop) hoverPop.remove();
        wrap.insertAdjacentHTML('beforeend', detailOf(t, false));
        hoverPop = wrap.lastElementChild;
        hoverPop.classList.add('hover');
        placePop(wrap, t, hoverPop);
        bindStockOpen(hoverPop);
        $$('[data-node]', hoverPop).forEach((b) => (b.onclick = (e) => {
          e.stopPropagation(); pick(b.dataset.node);
        }));
      };
      n.onmouseleave = clearHover;
    });
  }
  $$('[data-node-clear]', host).forEach((b) => (b.onclick = () => { state.mapPick = null; renderThemeMap(host, mk); }));

  // **點空白處就關掉。** 原本一定要按到那顆「關閉」，
  // 在手機上那是個很小的目標，在桌機上也不合直覺——
  // 浮出視窗的通用行為就是點外面關掉、Esc 關掉。
  if (state.mapPick && !state.mapOutside) {
    state.mapOutside = (e) => {
      if (!state.mapPick) return;
      if (e.target.closest && (e.target.closest('.mpop') || e.target.closest('[data-node]')
          || e.target.closest('#info-dialog'))) return;
      state.mapPick = null;
      const h = $('[data-themebody]');
      if (h && $('.mapwrap', h)) renderThemeMap(h, state.themeMarket === 'us' ? 'us' : 'tw');
    };
    state.mapEsc = (e) => { if (e.key === 'Escape' && state.mapPick) state.mapOutside({ target: document.body }); };
    // 用 capture 會在按鈕自己的 onclick 之前跑，那樣點節點會先被關掉，所以不加
    addEventListener('pointerdown', state.mapOutside);
    addEventListener('keydown', state.mapEsc);
  }
  if (!state.mapPick && state.mapOutside) {
    removeEventListener('pointerdown', state.mapOutside);
    removeEventListener('keydown', state.mapEsc);
    state.mapOutside = null; state.mapEsc = null;
  }
  $$('[data-group]', host).forEach((b) => (b.onclick = () => {
    state.mapGroup = b.dataset.group === state.mapGroup ? '' : b.dataset.group;
    renderThemeMap(host, mk);
  }));
  bindStockOpen(host);

  // **手機也要套聚焦。** 狀態 class 現在由 applyFocus 統一上，
  // 如果只在桌機分支呼叫，手機點下去就什麼都不會亮。
  applyFocus(host, mk, sel);

  if (desk) {
    const wrap = $('.mapwrap', host);
    // 量位置一定要等版面排完，所以排進下一幀
    requestAnimationFrame(() => {
      drawEdges(wrap, mk, sel);
      applyFocus(host, mk, sel);
      placePop(wrap, sel);
    });
    // 視窗寬度變了，線的位置就不對了
    clearTimeout(state.mapResizeT);
    if (!state.mapBound) {
      state.mapBound = true;
      addEventListener('resize', () => {
        clearTimeout(state.mapResizeT);
        state.mapResizeT = setTimeout(() => {
          const h = $('[data-themebody]');
          if (h && $('.mapwrap', h)) renderThemeMap(h, state.themeMarket === 'us' ? 'us' : 'tw');
        }, 150);
      });
    }
  }

  // 手機：把選中的格子捲到畫面中間。底部面板佔 38vh，中間剛好在它上面，
  // 所以點完之後看得到那一格與它亮起來的鄰居。
  if (sel && !desk) {
    const n = $$('.mnode', host).find((x) => x.dataset.node === sel);
    if (n) n.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}
