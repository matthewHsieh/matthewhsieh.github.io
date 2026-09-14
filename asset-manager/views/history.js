import { lineChart, barChart } from '../charts.js';
import { $, $$, esc, fmt, fmtCompact, fmtMax, fmtX, isNum, norm, num, pct, plClass, signed, state } from '../core.js';
import { deleteSnapshot, saveSnapshot } from '../data.js';
import { cpLabel, fmtQty, stockFutLabel, strikeText } from '../instruments.js';
import { TW_STOCKS } from '../symbols.js';
import { CAT_LABEL, CAT_ORDER, GRP_LABEL, GRP_ORDER, MARKET_LABEL, RANGE_LABEL, RANGE_ORDER, TRADE_KINDS, deleteTrade, groupOf, inRange, rangePreset, realizedSummary, tradeCategory, tradeKindOf, tradeNet } from '../trades.js';
import { bindListActions, tradeButton } from '../widgets.js';

// ------------------------------------------------------------
// 分類 × 市場 的交叉表
//   一個數字回答不了「我當沖到底賺不賺」——當沖的期貨與現貨是兩回事，
//   而波段裡混著抱兩個月的部位。列是做法、欄是市場，兩邊都給合計。
//   **沒有資料的分類與市場不會出現**，不然一開始就是一片 0。
// ------------------------------------------------------------
// 區間選擇。預設幾個常用的，再加自訂起迄；改了輸入框就等於自訂。
function rangeBar() {
  const cur = state.histRange || 'all';
  return `<div class="seg nav-seg hist-seg">${RANGE_ORDER.map((k) => `<label>
      <input type="radio" name="histr" value="${k}" ${cur === k ? 'checked' : ''}>
      <span>${RANGE_LABEL[k]}</span></label>`).join('')}
    <label><input type="radio" name="histr" value="custom" ${cur === 'custom' ? 'checked' : ''}>
      <span>自訂</span></label>
  </div>
  <div class="range-row">
    <input type="date" name="rfrom" value="${esc(state.histFrom || '')}" aria-label="起日">
    <span class="muted">→</span>
    <input type="date" name="rto" value="${esc(state.histTo || '')}" aria-label="迄日">
  </div>`;
}

const rangeText = () => {
  const f = state.histFrom, t = state.histTo;
  if (!f && !t) return '（全部）';
  if (f && t) return `（${f} ～ ${t}）`;
  return f ? `（${f} 起）` : `（${t} 止）`;
};

function crossTable(rs) {
  // **「篩出來是空的」跟「從來沒有資料」要分開講。**
  // 前者該提示怎麼放寬條件，後者才是「還沒開始記」。
  if (!rs.cats.length) {
    return state.trades.length
      ? '<p class="sub muted">這個期間沒有交易。換一個區間或按「全部」。</p>'
      : '<p class="sub muted">還沒有交易紀錄。用上面的「＋ 記一筆交易」開始記。</p>';
  }
  const cell = (v, n) => `<td class="${plClass(v)}">${signed(v)}${
    n ? `<span class="xs muted"> ${fmt(n)} 筆</span>` : ''}</td>`;
  const showGrpTotal = rs.grps.length > 1;
  return `<div class="table-wrap"><table class="xtab">
    <thead><tr><th></th>${rs.grps.map((g) => `<th>${GRP_LABEL[g]}</th>`).join('')}${
      showGrpTotal ? '<th>合計</th>' : ''}</tr></thead>
    <tbody>
      ${rs.cats.map((c) => {
        const row = rs.rowOf(c);
        return `<tr><th>${CAT_LABEL[c]}</th>${rs.grps.map((g) => {
          const x = rs.at(c, g);
          return x ? cell(x.net, x.trades) : '<td class="muted">–</td>';
        }).join('')}${showGrpTotal ? cell(row.net, row.trades) : ''}</tr>`;
      }).join('')}
    </tbody>
    ${rs.grps.length > 1 || rs.cats.length > 1 ? `<tfoot><tr><th>合計</th>${
      rs.grps.map((g) => cell(rs.colOf(g).net, rs.colOf(g).trades)).join('')}${
      showGrpTotal ? cell(rs.total, null) : ''}</tr></tfoot>` : ''}
  </table></div>`;
}

export function renderHistory(el) {
  const snaps = state.snapshots;
  const trades = state.trades.slice(0, 200);
  const range = { from: state.histFrom || null, to: state.histTo || null };
  const rs = realizedSummary(range);
  // 三個篩選是「且」的關係：可以只看「十月的、期貨的、當沖」。
  const keep = (t) => {
    const f = state.histFilter || 'all', g = state.histGroup || 'all';
    return inRange(t, range)
      && (f === 'all' || tradeCategory(t, rs.held) === f)
      && (g === 'all' || groupOf(t) === g);
  };
  const asc = [...snaps].reverse(); // 折線圖由舊到新

  el.innerHTML = `
    <div class="card" id="chart-assets"><div class="list-title" role="heading" aria-level="2">資產走勢</div></div>
    <div class="card" id="chart-lev"><div class="list-title" role="heading" aria-level="2">槓桿走勢</div></div>
    <div class="card">
      <div class="list-title" role="heading" aria-level="2">買賣收益（已實現）</div>
      ${rangeBar()}
      <div class="mini solo"><div class="label">淨損益${rangeText()}</div>
        <div class="value ${plClass(rs.total)}">${signed(rs.total)}</div></div>
      ${crossTable(rs)}
      <p class="sub muted" style="margin-top:8px">轉倉單獨一列，因為它的已實現損益只是把
        <b>原本就存在的未實現損益入帳</b>，不是那天做出來的績效。混在波段裡會看錯。<br>
        <b>隔日衝的稅是全額</b>（0.30%），不是當沖的減半價——它只是另外標起來方便統計，
        損益一樣用平均成本結算。</p>
      <div class="row-between line"><span>已實現損益（未扣成本）</span><span class="${plClass(rs.gross)}">${signed(rs.gross)}</span></div>
      <div class="row-between line"><span>手續費 ＋ 交易稅</span><span class="loss">${signed(-rs.cost)}</span></div>
      <div class="row-between line"><span><b>淨損益</b></span><span class="${plClass(rs.total)}"><b>${signed(rs.total)}</b></span></div>
      <div id="chart-cum"></div>
      <div class="sub muted chart-sub">單日已實現損益</div>
      <div id="chart-daily"></div>
      <p class="hint">波段賣出用當時的平均成本結算；當沖則是同一組買賣直接配對，不碰長期部位。
        <b>所有數字都是扣掉手續費與交易稅之後的淨額</b>，買進那一筆的手續費也算在內。
        當沖以你記錄時勾選的為準，不做推斷。
        未實現損益請看「持倉」頁。這裡不會自動調整你的現金餘額，現金請在「資金」頁自行維護。</p>
    </div>
    ${tradeButton()}
    <div class="card list">
      <div class="row-between">
        <span class="list-title" role="heading" aria-level="2">歷史交易紀錄</span>
        <span class="sub muted">${(() => {
          return `${fmt(trades.filter(keep).length)} 筆`;
        })()}</span>
      </div>
      <div class="seg nav-seg hist-seg">${[['all', '全部'], ...CAT_ORDER.map((c) => [c, CAT_LABEL[c]])]
        .map(([v, l]) => {
          const n = trades.filter((t) => inRange(t, range) && (v === 'all' || tradeCategory(t, rs.held) === v)).length;
          if (!n && v !== 'all') return '';   // 沒有的分類不要占位置
          return `<label><input type="radio" name="histf" value="${v}" ${
            (state.histFilter || 'all') === v ? 'checked' : ''}><span>${l} ${fmt(n)}</span></label>`;
        }).join('')}</div>
      <div class="seg nav-seg hist-seg">${[['all', '全部市場'], ...GRP_ORDER.map((g) => [g, GRP_LABEL[g]])]
        .map(([v, l]) => {
          const n = trades.filter((t) => inRange(t, range) && (v === 'all' || groupOf(t) === v)).length;
          if (!n && v !== 'all') return '';
          return `<label><input type="radio" name="histg" value="${v}" ${
            (state.histGroup || 'all') === v ? 'checked' : ''}><span>${l} ${fmt(n)}</span></label>`;
        }).join('')}</div>
      ${(() => {
        const shown = trades.filter(keep);
        if (!shown.length) {
          return state.trades.length
            ? '<p class="muted">這個條件沒有紀錄。放寬期間、分類或市場再看看。</p>'
            : '<p class="muted">還沒有交易紀錄。</p>';
        }
        // 依日期分組，每天給小計。原本全部混在一起，
        // 台玻轉倉的 -130,020 跟當天當沖 +34,500 疊在一起完全看不出發生什麼事。
        const days = [];
        for (const t of shown) {
          if (!days.length || days[days.length - 1].d !== t.trade_date) days.push({ d: t.trade_date, list: [] });
          days[days.length - 1].list.push(t);
        }
        return days.map((g) => {
          const sub = g.list.reduce((a, t) => a + tradeNet(t, rs).net, 0);
          return `<div class="day-group">
            <div class="row-between day-head">
              <span><b>${esc(g.d)}</b><span class="muted">　${fmt(g.list.length)} 筆</span></span>
              <span class="${plClass(sub)}">${signed(sub)}</span>
            </div>
            ${g.list.map((t) => {
              const { net, cost, matched } = tradeNet(t, rs);
              const cat = tradeCategory(t, rs.held);
              return `<button type="button" class="item" data-del-trade="${t.id}">
                <span class="item-main">
                  <span class="item-title"><span class="trade-side ${t.side}">${t.side === 'buy' ? '買' : '賣'}</span>${
                    t.market === 'option'
                      ? `TXO ${esc(t.opt_expiry)} ${strikeText(t.opt_strike)} ${cpLabel(t.opt_cp)}`
                      : `${esc(t.symbol)} ${esc(t.name || TW_STOCKS[norm(t.symbol)] || '')}`}${
                    cat === 'day' ? '<span class="badge day-badge">當沖</span>'
                    : cat === 'roll' ? '<span class="badge">轉倉</span>' : ''}${
                    t.market !== 'option' && t.symbol
                      ? `<span class="info-dot" role="button" tabindex="0" data-info="${
                          t.market === 'us' ? 'us' : 'tw'}:${esc(norm(t.symbol))}" title="看這一檔的狀態">ⓘ</span>` : ''}</span>
                  <span class="item-sub">${matched
                    ? `沖銷 ${fmtQty(t.market, matched.qty)} @ ${fmtMax(matched.openAvg, 2)} → ${fmtMax(t.price, 2)}・` : ''
                  }${TRADE_KINDS[tradeKindOf(t)]?.label || MARKET_LABEL[t.market] || ''}${
                    t.market === 'futures' && t.fut_kind === 'stock' ? `（${stockFutLabel(t.fut_size)}型）` : ''}${
                    t.note ? '・' + esc(t.note) : ''}</span>
                </span>
                <span class="item-right"><span>${fmtQty(t.market, t.quantity)}</span>
                  <span class="item-sub">@ ${fmtMax(t.price, 2)}</span>
                  <span class="item-sub"><span class="${plClass(net)}">${signed(net)}</span>
                    <span class="muted"> 　成本 ${fmt(cost)}</span></span></span>
              </button>`;
            }).join('')}
          </div>`;
        }).join('');
      })()}
      <p class="hint">上面四個分類可以切換。<b>轉倉</b>的損益是把原本的未實現入帳，不是那天的績效；
        <b>波段</b>是用當時的平均成本結算；<b>當沖</b>是同一組買賣直接配對，不碰長期部位。
        每天右邊是<b>當日該分類的小計</b>。點一筆可刪除並還原部位，要修改請刪除後重新記錄。</p>
    </div>
    <div class="card">
      <div class="row-between">
        <span class="list-title" role="heading" aria-level="2">每日快照</span>
        <button type="button" class="small" id="snap-btn2">📌 記錄今日</button>
      </div>
      ${snaps.length
        ? `<div class="table-wrap"><table>
            <thead><tr><th>日期</th><th>行情日</th><th>淨資產</th><th>變化</th><th>總資產</th><th>負債</th><th>槓桿①</th><th>槓桿②</th><th>目標%</th><th></th></tr></thead>
            <tbody>${snaps.map((r, i) => {
              const prev = snaps[i + 1];
              const d = prev ? num(r.net_assets) - num(prev.net_assets) : null;
              const prog = num(r.target_amount) > 0 ? num(r.net_assets) / num(r.target_amount) : null;
              return `<tr>
                <td>${esc(r.snap_date)}${r.note === 'auto' ? '<span class="badge">自動</span>' : ''}</td>
                <td class="${r.price_as_of && r.price_as_of < r.snap_date ? 'loss' : 'muted'}">${
                  r.price_as_of ? esc(r.price_as_of).slice(5) : '–'}</td>
                <td>${fmt(r.net_assets)}</td><td class="${plClass(d)}">${signed(d)}</td>
                <td>${fmt(r.total_assets)}</td><td>${fmt(r.liabilities)}</td>
                <td>${fmtX(r.leverage_asset)}</td><td>${fmtX(r.leverage_exposure)}</td>
                <td>${pct(prog)}</td>
                <td><button type="button" class="link danger" data-del-snap="${r.id}">刪除</button></td>
              </tr>`;
            }).join('')}</tbody>
          </table></div>`
        : '<p class="muted">尚無快照。系統每個交易日會自動存一筆，也可以按「記錄今日」手動存。</p>'}
      <p class="hint">每天一筆，表格可左右滑動。「行情日」是這筆快照用到的收盤價日期；
    若比左邊的日期早（標紅），表示當時來源還沒發布最新收盤價。</p>
    </div>`;

  const labels = asc.map((s) => s.snap_date);
  const dates = asc.map((s) => new Date(s.snap_date + 'T00:00:00'));
  // 圖表的 viewBox 要對齊實際寬度，否則字級會被等比放大（見 charts.js）。
  // 容器這時已經在 DOM 上，量得到寬度；量不到就退回 340。
  const cw = (sel) => Math.max(320, ($(sel, el)?.clientWidth || 364) - 24);
  // 總資產與淨資產量級相近，放同一張圖；曝險量級差很多，
  // 改由下面的「槓桿② 曝險」呈現（同一件事的標準化版本），避免壓扁資產線
  $('#chart-assets', el).appendChild(lineChart({
    labels, dates, title: '資產走勢', width: cw('#chart-assets'), format: (v, axis) => (axis ? fmtCompact(v) : fmt(v)),
    series: [
      { label: '總資產', color: 'var(--series-1)', values: asc.map((s) => (isNum(s.total_assets) ? Number(s.total_assets) : null)) },
      { label: '淨資產', color: 'var(--series-2)', values: asc.map((s) => (isNum(s.net_assets) ? Number(s.net_assets) : null)) },
    ],
  }));
  $('#chart-lev', el).appendChild(lineChart({
    labels, dates, title: '槓桿走勢', width: cw('#chart-lev'), format: (v) => Number(v).toFixed(2) + 'x',
    series: [
      { label: '槓桿① 資產', color: 'var(--series-1)', values: asc.map((s) => (isNum(s.leverage_asset) ? Number(s.leverage_asset) : null)) },
      { label: '槓桿② 曝險', color: 'var(--series-2)', values: asc.map((s) => (isNum(s.leverage_exposure) ? Number(s.leverage_exposure) : null)) },
    ],
  }));

  $('#chart-cum', el).appendChild(lineChart({
    labels: rs.series.map((r) => r.date),
    dates: rs.series.map((r) => new Date(r.date + 'T00:00:00')),
    title: '累計已實現損益', format: (v, axis) => (axis ? fmtCompact(v) : fmt(v)),
    width: cw('#chart-cum'), yZero: true,
    series: [{ label: '累計已實現損益', color: 'var(--series-1)', values: rs.series.map((r) => r.cum) }],
  }));
  $('#chart-daily', el).appendChild(barChart({
    labels: rs.series.map((r) => r.date.slice(5)),
    values: rs.series.map((r) => r.daily),
    title: '單日已實現損益', format: (v, axis) => (axis ? fmtCompact(v) : fmt(v)),
    width: cw('#chart-daily'),
  }));

  $('#snap-btn2', el).onclick = saveSnapshot;
  $$('[data-del-snap]', el).forEach((b) => (b.onclick = () => deleteSnapshot(b.dataset.delSnap)));
  $$('[data-del-trade]', el).forEach((b) => (b.onclick = () => deleteTrade(b.dataset.delTrade)));
  $$('input[name=histf]', el).forEach((r) => (r.onchange = () => {
    state.histFilter = r.value;
    renderHistory(el);
  }));
  $$('input[name=histg]', el).forEach((r) => (r.onchange = () => {
    state.histGroup = r.value;
    renderHistory(el);
  }));
  $$('input[name=histr]', el).forEach((r) => (r.onchange = () => {
    state.histRange = r.value;
    if (r.value !== 'custom') {
      const p = rangePreset(r.value);
      state.histFrom = p.from; state.histTo = p.to;
    }
    renderHistory(el);
  }));
  // 手動改日期就等於自訂，預設鈕的選取跟著移過去
  $$('input[name=rfrom], input[name=rto]', el).forEach((i) => (i.onchange = () => {
    state.histFrom = $('input[name=rfrom]', el).value || null;
    state.histTo = $('input[name=rto]', el).value || null;
    state.histRange = 'custom';
    renderHistory(el);
  }));
  bindListActions(el);
}
