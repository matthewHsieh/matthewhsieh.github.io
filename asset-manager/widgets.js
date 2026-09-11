import { $$, esc, fmt, fmtMax, isNum, num, pct, signed, state } from './core.js';
import { MARKET_NAME, newestAsOf, statusOf } from './data.js';
import { editFutures, editItem, editOption, editWarrant, logTrade, rollFutures } from './forms.js';
import { FWD_YEARS, beatsIdx, idxRatio, peLabel, riskOf } from './portfolio.js';
import { openStock } from './views/stock.js';

export const stat = (label, value, extra = '') =>
  `<div class="card stat"><div class="label">${label}</div><div class="value">${value}</div>${extra ? `<div class="sub muted">${extra}</div>` : ''}</div>`;

export const line = (label, value, total) => {
  const share = total > 0 && isNum(value) ? ` <span class="muted">(${pct(value / total)})</span>` : '';
  return `<div class="row-between line"><span>${label}</span><span>${fmt(value)}${share}</span></div>`;
};

export const section = (title, kind, rows, footer, addDefaults = {}) =>
  `<div class="card list">
    <div class="row-between">
      <span class="list-title">${esc(title)}</span>
      <button type="button" class="small" data-add="${kind}" data-defaults="${esc(JSON.stringify(addDefaults))}">＋ 新增</button>
    </div>
    ${rows.length ? rows.join('') : '<p class="muted">尚無資料，按「＋ 新增」登記，或用上方「記一筆交易」。</p>'}
    ${footer ? `<div class="list-footer">${footer}</div>` : ''}
  </div>`;

// info 是 "tw:2330" 這種字串，有填就在標題後面掛一顆 ⓘ 開個股速覽。
// 不能用 <button> 包 <button>，所以那顆是 span，點下去要自己擋住冒泡免得變成編輯。
export const itemRow = (kind, id, title, sub, right, right2 = '', info = '') =>
  `<button type="button" class="item" data-edit="${kind}" data-id="${id}">
    <span class="item-main"><span class="item-title">${title}${
      info ? `<span class="info-dot" role="button" tabindex="0" data-info="${esc(info)}" title="看這一檔的狀態">ⓘ</span>` : ''
    }</span><span class="item-sub">${sub}</span></span>
    <span class="item-right"><span>${right}</span><span class="item-sub">${right2}</span></span>
  </button>`;

export const tradeButton = () =>
  `<button type="button" class="primary block" data-trade>＋ 記一筆交易（買 / 賣）</button>` +
  // 轉倉本來只放在期貨卡片右下角，又小又暗還要往下捲，實測找不到。
  // 它在使用者心裡是「一種交易」，就該放在記一筆交易旁邊。
  (state.futures.length
    ? `<button type="button" class="block roll-btn" data-roll>⇄ 期貨轉倉（先平近月，再建遠月）</button>`
    : '');

export function bindListActions(el) {
  $$('[data-add]', el).forEach((b) => (b.onclick = () => {
    const d = JSON.parse(b.dataset.defaults || '{}');
    if (b.dataset.add === 'future') editFutures(null);
    else if (b.dataset.add === 'option') editOption(null);
    else if (b.dataset.add === 'warrant') editWarrant(null);
    else editItem(b.dataset.add, null, d);
  }));
  $$('[data-edit]', el).forEach((b) => (b.onclick = () =>
    b.dataset.edit === 'future' ? editFutures(b.dataset.id)
    : b.dataset.edit === 'option' ? editOption(b.dataset.id)
    : b.dataset.edit === 'warrant' ? editWarrant(b.dataset.id)
    : editItem(b.dataset.edit, b.dataset.id)));
  $$('[data-info]', el).forEach((b) => (b.onclick = (e) => {
    e.preventDefault(); e.stopPropagation();
    const [mk, sym] = b.dataset.info.split(':');
    openStock(mk, sym);
  }));
  $$('[data-trade]', el).forEach((b) => (b.onclick = () => logTrade()));
  $$('[data-roll]', el).forEach((b) => (b.onclick = () => rollFutures(b.dataset.roll || null)));
}

export function priceStamp() {
  const p = state.priceInfo;
  if (!p) return '報價尚未更新，按右上角 ↻ 抓一次';
  const d = new Date(p.updated_at);
  const tw = statusOf('tw');
  return `報價抓取於 ${d.toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` +
         (tw?.as_of ? `，台股收盤價為 ${tw.as_of}` : '');
}

// 資料日期比最新的還舊 → 提醒使用者
export function stalenessNote() {
  const newest = newestAsOf();
  if (!newest) return '';
  const lagging = state.priceStatus.filter((p) => p.as_of && p.as_of < newest);
  if (!lagging.length) return '';
  const list = lagging.map((p) => `${MARKET_NAME[p.market] || p.market}停在 ${p.as_of}`).join('、');
  return `<p class="hint warn-hint">⚠ ${list}（來源尚未發布，不是設定錯誤）。目前最新資料日為 ${newest}。</p>`;
}

function valuationRow(v) {
  const usd = v.ccy === 'USD';
  const cur = usd ? 'US$ ' : '';
  // 可信度逐年標。同一檔的 2026 可能有 9 位分析師、2028 只剩 1 位，
  // 標同一個等級會讓人以為那三個數字一樣可靠。
  const fwd = FWD_YEARS.map(([y, pk, ek, ck, ak]) => {
    const pe = v[pk], eps = v[ek], conf = v[ck], an = v[ak];
    if (!isNum(pe)) return `<span class="fwd-pe muted"><b>${String(y).slice(2)}F</b> –</span>`;
    const weak = conf === 'low';
    return `<span class="fwd-pe${weak ? ' weak' : ''}"><b>${String(y).slice(2)}F</b> ${fmtMax(pe, 1)}x`
      + ` <span class="muted">(EPS ${cur}${fmtMax(eps, 2)}${isNum(an) ? `・${fmt(an)}人` : ''})</span>`
      + `${weak ? '<span class="warn-mark" title="樣本太少或無具名機構">⚠</span>' : ''}</span>`;
  }).join('');
  const anyFwd = FWD_YEARS.some(([, pk]) => isNum(v[pk]));
  return `<button type="button" class="item" data-eps="${esc(v.symbol)}" data-nm="${esc(v.name || '')}">
    <span class="item-main">
      <span class="item-title">${esc(v.symbol)} ${esc(v.name || '')}<span class="badge">${esc(v.held || '')}</span>${
        v.mine ? '<span class="badge day-badge">自填預估</span>' : ''}${
        v.confidence === 'low' ? '<span class="badge warn-badge">無分析師覆蓋</span>'
        : v.confidence === 'medium' ? '<span class="badge">覆蓋薄</span>' : ''}</span>
      <span class="item-sub">現價 ${cur}${fmtMax(v.price, 2)}　${isNum(v.pb) ? `PB ${fmtMax(v.pb, 2)}　` : ''}${
        isNum(v.dy) ? `殖利率 ${fmtMax(v.dy, 2)}%` : ''}${
        usd ? '<span class="muted">近四季本益比無免費來源</span>' : ''}</span>
      <span class="item-sub fwd-row">${fwd}</span>
      ${(() => { const k = riskOf(v.symbol); return k && isNum(k.ratio)
        ? `<span class="item-sub">報酬/波動 <b class="${beatsIdx(k.ratio) ? 'gain' : ''}">${fmtMax(k.ratio, 2)}</b>${
            beatsIdx(k.ratio) ? '<span class="badge day-badge">贏指數</span>'
            : `<span class="muted">（指數 ${fmtMax(idxRatio(), 2)}）</span>`}　波動 ${
            (num(k.vol) * 100).toFixed(0)}%　三年 ${signed(num(k.cagr) * 100, 0)}%/年</span>`
        : ''; })()}
      ${isNum(v.ytd_eps) ? `<span class="item-sub">${esc(String(v.ytd_fy))} 前 ${esc(String(v.ytd_q))} 季已實現 EPS ${
        fmtMax(v.ytd_eps, 2)}${isNum(v.ytd_pct)
          ? `　<b class="${num(v.ytd_pct) < 40 ? 'loss' : ''}">達成率 ${fmtMax(v.ytd_pct, 0)}%</b>` : ''}</span>` : ''}
      ${anyFwd && v.eps_src ? `<span class="item-sub muted">預估來源：${esc(v.eps_src)}${
        isNum(v.analysts) ? `　${fmt(v.analysts)} 位分析師` : ''}${
        v.eps_checked ? `　${esc(v.eps_checked)}` : ''}</span>` : ''}
    </span>
    <span class="item-right"><span>${usd ? '–' : peLabel(v.pe)}</span><span class="item-sub">近四季</span></span>
  </button>`;
}

export function valuationCard() {
  if (!state.valuation.length) return '';
  const asOf = state.valuation.map((v) => v.as_of).filter(Boolean).sort().pop();
  const missing = state.valuation.filter((v) => !FWD_YEARS.some(([, pk]) => isNum(v[pk])));
  return `<div class="card">
    <div class="row-between">
      <span class="list-title">估值</span>
      <span class="sub muted">${asOf ? esc(asOf) : ''}</span>
    </div>
    ${state.valuation.map(valuationRow).join('')}
    <p class="hint"><b>近四季本益比</b>由證交所與櫃買中心每日公告，是已經發生的獲利算出來的，自動更新。
      <b>26/27/28 是用預估 EPS 算的</b>：股價每天更新所以比值每天變，但預估 EPS 沒有免費 API，要自己維護。
      點任一列可以填入你自己的預估，填了就以你的為準。
      複委託的美股沒有免費的近四季本益比來源（Yahoo 的估值端點已經要驗證），但股價一樣每天更新，
      所以自己填了預估 EPS，預估本益比照樣會每天重算。
      ${missing.length ? `目前 ${missing.map((v) => esc(v.symbol)).join('、')} 還沒有預估值。` : ''}
      <b>覆蓋度差很多，而且同一檔的不同年度也差很多。</b>台積電有 42 位分析師在報，台玻是 0 位；
      和碩 2026 與 2027 有 9 位，2028 只剩 1 位。所以人數逐年標在括號裡，
      標 ⚠ 的代表樣本太少或沒有具名機構，那格請當它是傳聞不是預估。
      <b>達成率</b>是年初至今已實現 EPS ÷ 當年度預估：半年報時應該在 50% 上下，
      明顯偏低就代表那個預估在賭下半年大爆發，這件事光看本益比是看不出來的。
      預估本益比的分母是別人的猜測，不同券商的 2028 年 EPS 可以差一倍，別當成事實看。
      <b>報酬/波動</b>是三年年化報酬除以年化波動，及格線是加權指數。低於指數代表你承受的波動
      換不到相稱的報酬，那不如直接開槓桿買指數，還省下選錯的風險。</p>
  </div>`;
}

// 現價在區間裡的位置，0 = 貼著最低，1 = 貼著最高
function rangeBar(lo, hi, px, label) {
  if (!isNum(lo) || !isNum(hi) || !isNum(px) || num(hi) <= num(lo)) return '';
  const p = Math.min(1, Math.max(0, (num(px) - num(lo)) / (num(hi) - num(lo))));
  return `<div class="range">
    <div class="row-between sub muted"><span>${label}</span>
      <span>${fmtMax(lo, 2)} – ${fmtMax(hi, 2)}　位置 <b>${(p * 100).toFixed(0)}%</b></span></div>
    <div class="range-bar"><div class="range-dot" style="left:${(p * 100).toFixed(1)}%"></div></div>
  </div>`;
}

export const CONF_LABEL = { high: '可信度高', mid: '可信度中', low: '可信度低' };

// 轉型故事的文字裡用 **…** 標重點。先 esc 再轉標記，順序不能反，
// 否則使用者資料裡的角括號會變成可執行的 HTML。
export const mdBold = (t) => esc(String(t ?? '')).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

// 區間帶與風險這兩塊拆出來，因為記憶體裡只有幾百檔的風險數字
// （全市場四千檔不可能整批載，見 app_risk()），其餘的要等 stock_detail 回來才有。
export function rangeHtml(k, price) {
  if (!k) return '';
  return rangeBar(k.lo52, k.hi52, price, '近一年區間')
    + rangeBar(k.lo3y, k.hi3y, price, '三年區間')
    + (isNum(k.hi3y) && isNum(price) && num(k.hi3y) > 0
      ? `<p class="sub muted sc-off">距三年高點 <b class="${
          num(price) / num(k.hi3y) - 1 < -0.3 ? 'gain' : ''}">${
          signed((num(price) / num(k.hi3y) - 1) * 100, 0)}%</b>${
          isNum(k.lo3y) && num(k.lo3y) > 0
            ? `　距三年低點 ${signed((num(price) / num(k.lo3y) - 1) * 100, 0)}%` : ''}</p>`
      : '');
}

export function riskHtml(k, bench, beats) {
  if (!k) return '';
  const kv = (a, b) => `<div class="row-between sub"><span class="muted">${a}</span><span>${b}</span></div>`;
  return `<div class="sc-sec"><div class="sc-title">風險</div>
    ${kv('報酬 / 波動', isNum(k.ratio)
      ? `<b class="${beats(k.ratio) ? 'gain' : 'loss'}">${fmtMax(k.ratio, 2)}</b>　及格線 ${
          isNum(bench) ? fmtMax(bench, 2) : '–'}`
      : (num(k.days) > 0 ? `上市未滿兩年（${fmt(k.days)} 天）` : '–'))}
    ${kv('三年年化報酬', isNum(k.cagr) ? signed(num(k.cagr) * 100, 0) + '%' : '–')}
    ${kv('年化波動', isNum(k.vol) ? (num(k.vol) * 100).toFixed(0) + '%' : '–')}
    ${kv('三年最大回撤', isNum(k.mdd) ? `<span class="loss">${(num(k.mdd) * 100).toFixed(0)}%</span>` : '–')}
    ${isNum(k.vol) && num(k.vol) > 0 && isNum(bench)
      ? `<p class="sub muted">用它的波動換到相稱的報酬，年化要有 <b>${
          (num(k.vol) * bench * 100).toFixed(0)}%</b> 以上。</p>` : ''}</div>`;
}
