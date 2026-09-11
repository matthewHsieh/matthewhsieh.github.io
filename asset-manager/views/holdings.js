import { alertBadge, alertOf } from '../alerts.js';
import { $$, esc, fmt, fmtMax, isNum, norm, num, plClass, signed, state } from '../core.js';
import { editEps } from '../forms.js';
import { fmtQty, futDisplayName, ivChange, optDeltaExp, optLabel, optMaxRisk, optPl, optValue, stockFutLabel, warDaysLeft, warExposure, warLabel, warModelOk, warPl, warValue } from '../instruments.js';
import { futNotional, futPl, futPx, livePx, liveTag, pxOf } from '../live.js';
import { compute } from '../portfolio.js';
import { autoPriceOk, twKnown } from '../symbols.js';
import { bindListActions, itemRow, section, tradeButton, valuationCard } from '../widgets.js';

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
      `${esc(f.contract || futDisplayName(f.kind, f.symbol, f.size))}<span class="badge">${f.side === 'short' ? '空' : '多'}</span>${
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
  const usRows = state.us.map((s) => {
    const v = num(s.shares) * num(s.price_usd);
    const pl = isNum(s.cost_usd) ? v - num(s.shares) * num(s.cost_usd) : null;
    return itemRow('us', s.id,
      `${esc(s.symbol)} ${esc(s.name || '')}`,
      `${fmtMax(s.shares, 4)} 股 × ${fmtMax(s.price_usd, 2)}${isNum(s.cost_usd) ? `　均價 ${fmtMax(s.cost_usd, 2)}` : ''}`,
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

  const optRows = state.options.map((o) => {
    const de = optDeltaExp(o);
    const pl = optPl(o);
    const risk = optMaxRisk(o);
    return itemRow('option', o.id,
      `${optLabel(o)}<span class="badge">${o.side === 'short' ? '賣方' : '買方'}</span>${
        risk.unlimited ? '<span class="badge warn-badge">風險無上限</span>' : ''}`,
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
    section('權證', 'warrant', warRows,
      `市值 ${fmt(c.warMarket)}　delta 曝險 ${fmt(c.warExp)}　最大損失 ${fmt(c.warMaxLoss)}${
        c.warProfit === null ? '' : `　<span class="${plClass(c.warProfit)}">${signed(c.warProfit)}</span>`}${
        c.warTheta ? `　<span class="loss">每日時間價值 ${fmt(c.warTheta)}</span>` : ''}`) +
    section('台指選擇權', 'option', optRows,
      `權利金市值 ${fmt(c.optMarket)}　delta 曝險 ${fmt(c.optExposure)}　${
        c.optRiskUnlimited ? '<span class="loss">最大風險無上限</span>'
        : `最大風險 ${fmt(c.optMaxLoss)}`}${
        c.optProfit === null ? '' : `　<span class="${plClass(c.optProfit)}">${signed(c.optProfit)}</span>`}`) +
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
