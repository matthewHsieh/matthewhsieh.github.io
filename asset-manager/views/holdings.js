import { alertBadge, alertOf } from '../alerts.js';
import { $$, esc, fmt, fmtMax, isNum, norm, num, plClass, signed, state } from '../core.js';
import { editEps } from '../forms.js';
import { fmtQty, futDaysLeft, futDisplayName, futMonthLabel, futSettleISO, ivChange, optDeltaExp, optExpiryLabel, optLabel, optPl, optValue, stockFutLabel, usExposureUsd, usLevLabel, warDaysLeft, warExposure, warLabel, warModelOk, warPl, warValue } from '../instruments.js';
import { futNotional, futPl, futPx, livePx, liveTag, pxOf } from '../live.js';
import { compute } from '../portfolio.js';
import { autoPriceOk, twKnown } from '../symbols.js';
import { bindListActions, itemRow, section, tradeButton, valuationCard } from '../widgets.js';

// 到期損益。**這是整組的數字，不是一腳一腳加起來的。**
//   買權多頭價差（買低履約 ＋ 賣高履約）最大虧損就是淨支出，
//   上面那一口賣出買權看起來無上限，但它被下面那一口接住了。
//   要看出這件事只要算到期損益：它是分段線性的，極值只在履約價上。
// 極值落在哪。到期損益在最外側的履約價之外是平的（不平的話那一端就是
// 「無上限」，根本不會走到這裡），所以寫「≥ 46,800」比寫一個點精確。
const payoffAt = (v, strikes) => {
  if (v === null) return '';
  const lo = strikes[0], hi = strikes[strikes.length - 1];
  if (v >= hi) return `（指數 ≥ ${fmt(hi)}）`;
  if (v <= lo) return `（指數 ≤ ${fmt(lo)}）`;
  return `（指數 ${fmt(v)}）`;
};

const payoffLines = (plans) => (plans || []).map((p) => {
  const parts = [
    p.maxGain === null ? '<span class="gain">最大獲利無上限</span>'
      : `最大獲利 <span class="gain">${signed(p.maxGain)}</span>${payoffAt(p.gainAt, p.strikes)}`,
    p.maxLoss === null ? '<span class="loss">最大虧損無上限</span>'
      : `最大虧損 <span class="loss">${signed(p.maxLoss)}</span>${payoffAt(p.lossAt, p.strikes)}`,
  ];
  if (p.breakEvens.length) parts.push(`損益兩平 ${p.breakEvens.map((x) => fmt(x)).join(' / ')}`);
  const head = `<b>${esc(p.expiry)}</b>　${esc(optExpiryLabel(p.expiry))}　${esc(p.name)}`;
  return `<div class="sub muted payoff-line">${[head, ...parts]
    .map((x) => `<span>${x}</span>`).join('　')}</div>`;
}).join('');

// 月份標籤。**快到期的要變色**——「10月倉」跟「9月倉」在灰色小標籤裡
// 差一個字，掃過去根本分不出來，而那一個字的差別是「還有 37 天」跟「剩 2 天」。
const monthBadge = (ym) => {
  const label = futMonthLabel(ym);
  if (!label) return '';
  const d = futDaysLeft(ym);
  const cls = d === null ? '' : d < 0 ? ' alert-punish' : d <= 7 ? ' warn-badge' : '';
  const tip = d === null ? '' : d < 0 ? `已過最後交易日 ${futSettleISO(ym)}`
    : `最後交易日 ${futSettleISO(ym)}，剩 ${d} 天`;
  return `<span class="badge${cls}" title="${tip}">${label}</span>`;
};

export function renderHoldings(el) {
  const c = compute();
  const stockRows = state.stocks.map((s) => {
    const v = num(s.shares) * pxOf(s);
    const pl = isNum(s.cost) ? v - num(s.shares) * num(s.cost) : null;
    return itemRow('stock', s.id,
      `${esc(s.symbol)} ${esc(s.name || '')}${alertBadge(alertOf(s.symbol))}${
        twKnown(s.symbol) ? '' : '<span class="badge warn-badge">價格不會自動更新</span>'}`,
      `${fmtQty('tw', s.shares)} × ${fmtMax(pxOf(s), 2)}${livePx(s.symbol) ? liveTag(s.symbol) : ''}${
        isNum(s.cost) ? `　均價 ${fmtMax(s.cost, 2)}` : ''}`,
      fmt(v),
      pl === null ? '' : `<span class="${plClass(pl)}">${signed(pl)}</span>`,
      `tw:${norm(s.symbol)}`);
  });
  const futRows = state.futures.map((f) => {
    const isStock = f.kind === 'stock';
    const pl = futPl(f);
    return itemRow('future', f.id,
      `${esc(f.contract || futDisplayName(f.kind, f.symbol, f.size))}${monthBadge(f.month)}<span class="badge">${
        f.side === 'short' ? '空' : '多'}</span>${
        isStock ? alertBadge(alertOf(f.symbol)) : ''}${
        autoPriceOk(f) ? '' : '<span class="badge warn-badge">價格不會自動更新</span>'}`,
      `${fmtMax(f.lots, 2)} 口 × ${fmtMax(futPx(f), 2)}${
        isStock && livePx(f.symbol) ? liveTag(f.symbol) : ''} × ${fmt(f.size)}${isStock ? ' 股' : ' 元/點'}${
        isNum(f.cost) ? `　均價 ${fmtMax(f.cost, 2)}` : ''}`,
      `名目 ${fmt(futNotional(f))}`,
      pl === null
        ? `${isStock ? `個股期・${stockFutLabel(f.size)}型` : '指數期'}<span class="muted">・未填成本</span>`
        : `<span class="${plClass(pl)}">${signed(pl)}</span>`,
      isStock && f.symbol ? `tw:${norm(f.symbol)}` : '');
  });
  // 快到期的要單獨講一次。**混在列表裡看不到**——五口部位長得幾乎一樣，
  // 而「還有兩天就最後交易日」跟「還有 37 天」是完全不同的處境。
  const settleNote = (() => {
    const rows = state.futures.filter((f) => /^\d{6}$/.test(String(f.month || '')));
    const soon = rows.map((f) => ({ f, d: futDaysLeft(f.month) }))
      .filter((x) => x.d !== null && x.d <= 7)
      .sort((a, b) => a.d - b.d);
    const noMonth = state.futures.length - rows.length;
    const parts = [];
    if (soon.length) {
      parts.push(`<p class="hint warn-hint">⚠ ${soon.map(({ f, d }) => `${
        esc(f.contract || futDisplayName(f.kind, f.symbol, f.size))} ${futMonthLabel(f.month)}${
        d < 0 ? `<b>已過最後交易日</b>（${futSettleISO(f.month)}）`
          : d === 0 ? '<b>今天就是最後交易日</b>'
            : `<b>剩 ${d} 天</b>到最後交易日（${futSettleISO(f.month)}）`}`).join('；')
        }。要留倉就先轉倉，不轉會被結算。</p>`);
    }
    if (noMonth) {
      parts.push(`<p class="hint">有 ${noMonth} 筆還沒填交割月份，點進去補上就會顯示剩幾天。</p>`);
    }
    return parts.join('');
  })();

  const usRows = state.us.map((s) => {
    const v = num(s.shares) * num(s.price_usd);
    const pl = isNum(s.cost_usd) ? v - num(s.shares) * num(s.cost_usd) : null;
    // 槓桿型要把倍數標出來，而且把曝險寫清楚——
    // 市值跟曝險是兩個數字，不寫出來使用者會以為只承受市值的風險
    const lv = usLevLabel(s);
    return itemRow('us', s.id,
      `${esc(s.symbol)} ${esc(s.name || '')}${lv ? `<span class="badge lev-badge">${esc(lv)}</span>` : ''}`,
      `${fmtMax(s.shares, 4)} 股 × ${fmtMax(s.price_usd, 2)}${isNum(s.cost_usd) ? `　均價 ${fmtMax(s.cost_usd, 2)}` : ''}${
        lv ? `　曝險 US$ ${fmt(usExposureUsd(s), 2)}` : ''}`,
      `US$ ${fmt(v, 2)}`,
      pl === null ? `≈ ${fmt(v * c.rate)}` : `<span class="${plClass(pl)}">${signed(pl, 2)}</span> ≈ ${fmt(v * c.rate)}`,
      `us:${norm(s.symbol)}`);
  });
  const warRows = state.warrants.map((w) => {
    const de = warExposure(w);
    const pl = warPl(w);
    const days = warDaysLeft(w);
    const ivc = ivChange(w.code);
    const ivCut = ivc && ivc.diff < -0.005;
    return itemRow('warrant', w.id,
      `${warLabel(w)}<span class="badge">${w.cp === 'put' ? '認售' : '認購'}</span>${
        warModelOk(w) ? '' : '<span class="badge warn-badge">模型不適用</span>'}${
        ivCut ? '<span class="badge warn-badge">隱波被調降</span>' : ''}`,
      `${fmtMax(w.lots, 2)} 張 × ${fmtMax(w.price, 2)} 元${isNum(w.cost) ? `　成本 ${fmtMax(w.cost, 2)}` : ''}` +
      `${isNum(w.iv) ? `　隱波 ${(num(w.iv) * 100).toFixed(1)}%` : ''}` +
      `${isNum(w.gearing) ? `　槓桿 ${fmtMax(w.gearing, 1)}x` : ''}` +
      `${days !== null ? `　剩 ${fmt(days)} 天` : ''}`,
      `市值 ${fmt(warValue(w))}`,
      pl === null
        ? (de === null ? '曝險待算' : `曝險 ${fmt(Math.abs(de))}`)
        : `<span class="${plClass(pl)}">${signed(pl)}</span>`,
      // 權證看的是標的的狀態，不是權證自己的
      w.underlying ? `tw:${norm(w.underlying)}` : '');
  });

  // **「風險無上限」的標記要看整組，不能看單腳。** 同一個到期別裡有一口
  // 履約價更高的買進買權，賣出買權的上方風險就被接住了。
  const openEnded = new Set(c.optPlans.filter((p) => p.maxLoss === null).map((p) => p.expiry));
  const optRows = state.options.map((o) => {
    const de = optDeltaExp(o);
    const pl = optPl(o);
    return itemRow('option', o.id,
      `${optLabel(o)}<span class="badge">${o.side === 'short' ? '賣方' : '買方'}</span>${
        openEnded.has(String(o.expiry)) && o.side === 'short' && o.cp === 'call'
          ? '<span class="badge warn-badge">風險無上限</span>' : ''}`,
      `${fmtMax(o.lots, 2)} 口 × ${fmtMax(o.price, 2)} 點 × 50${isNum(o.cost) ? `　成本 ${fmtMax(o.cost, 2)}` : ''}${
        isNum(o.delta) ? `　delta ${fmtMax(o.delta, 3)}` : '　<span class="muted">delta 計算中</span>'}`,
      `市值 ${fmt(optValue(o))}`,
      pl === null
        ? (de === null ? '曝險待算' : `曝險 ${fmt(Math.abs(de))}`)
        : `<span class="${plClass(pl)}">${signed(pl)}</span>`);
  });

  const equityRows = state.balances.filter((b) => b.kind === 'futures_equity').map((b) =>
    itemRow('balance', b.id, esc(b.name), esc(b.note || ''),
      `${fmt(b.amount, b.currency === 'USD' ? 2 : 0)} ${b.currency}`, '計入總資產'));
  const stockPl = c.stockValue - c.stockCost;
  const usPl = c.usValueUsd - c.usCostUsd;

  el.innerHTML =
    tradeButton() +
    section('台股', 'stock', stockRows, `市值 ${fmt(c.stockValue)}　<span class="${plClass(stockPl)}">${signed(stockPl)}</span>`) +
    section('期貨部位（指數 + 個股）', 'future', futRows,
      `名目合計 ${fmt(c.futGross)}　${c.futProfit === null
        ? '<span class="muted">填了平均成本才會顯示損益</span>'
        : `<span class="${plClass(c.futProfit)}">${signed(c.futProfit)}</span>`}` +
      (state.futures.length ? '<br><button type="button" class="small" data-roll>⇄ 轉倉</button>' : '')) +
    settleNote +
    section('權證', 'warrant', warRows,
      `市值 ${fmt(c.warMarket)}　delta 曝險 ${fmt(c.warExp)}　最大損失 ${fmt(c.warMaxLoss)}${
        c.warProfit === null ? '' : `　<span class="${plClass(c.warProfit)}">${signed(c.warProfit)}</span>`}${
        c.warTheta ? `　<span class="loss">每日時間價值 ${fmt(c.warTheta)}</span>` : ''}`) +
    section('台指選擇權', 'option', optRows,
      `權利金市值 ${fmt(c.optMarket)}　delta 曝險 ${fmt(c.optExposure)}　${
        c.optRiskUnlimited ? '<span class="loss">最大虧損無上限</span>'
        : `到期最大虧損 ${fmt(c.optMaxLoss)}`}${
        c.optProfit === null ? '' : `　<span class="${plClass(c.optProfit)}">${signed(c.optProfit)}</span>`}`
      + payoffLines(c.optPlans)) +
    section('期貨帳戶權益數', 'balance', equityRows, `合計 ${fmt(c.futEquity)}`, { kind: 'futures_equity', name: '期貨帳戶' }) +
    section('複委託 (USD)', 'us', usRows,
      `US$ ${fmt(c.usValueUsd, 2)} <span class="${plClass(usPl)}">${signed(usPl, 2)}</span>　≈ ${fmt(c.usValue)}`) +
    valuationCard() +
    `<p class="hint">「記一筆交易」會自動加減部位、重算均價；部位沒變動就不會動資料，賣光才移除。
      期貨的<b>權益數</b>計入總資產，<b>名目金額</b>計入曝險。個股期貨以標的股價計價：大型 = 2 張（2,000 股）、小型 = 100 股。
      選擇權的<b>權利金市值</b>計入總資產（買方為正、賣方為負），<b>delta 曝險</b>計入槓桿；
      delta 由期交所結算價每天自動反推，不用手動填。</p>`;
  bindListActions(el);
  $$('[data-eps]', el).forEach((b) => (b.onclick = () => editEps(b.dataset.eps, b.dataset.nm)));
}
