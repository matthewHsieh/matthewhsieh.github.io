import { esc, fmt, fmtMax, isNum, norm, num, state, todayISO } from './core.js';
import { TW_STOCKS, indexProduct } from './symbols.js';

// 台指選擇權：每點 50 元
export const OPT_SIZE = 50;

export const cpLabel = (cp) => (cp === 'put' ? '賣權' : '買權');

export const strikeText = (k) => String(num(k));

export const optLabel = (o) =>
  `TXO ${esc(o.expiry)} ${strikeText(o.strike)} ${cpLabel(o.cp)}`;

// 權利金市值：買方為正（資產），賣方為負（負債）
export const optValue = (o) => num(o.lots) * num(o.price) * num(o.size ?? OPT_SIZE) * (o.side === 'short' ? -1 : 1);

// delta 曝險（帶方向）：賣方要反號
export const optDeltaExp = (o) =>
  isNum(o.delta) && isNum(o.forward)
    ? num(o.lots) * num(o.delta) * num(o.forward) * num(o.size ?? OPT_SIZE) * (o.side === 'short' ? -1 : 1)
    : null;

// 未實現損益
export const optPl = (o) =>
  isNum(o.cost)
    ? (num(o.price) - num(o.cost)) * num(o.lots) * num(o.size ?? OPT_SIZE) * (o.side === 'short' ? -1 : 1)
    : null;

// 最大風險：買方最多賠光權利金；賣方賣權賠到履約價歸零；賣方買權沒有上限
export function optMaxRisk(o) {
  const size = num(o.size ?? OPT_SIZE), lots = num(o.lots);
  const basis = isNum(o.cost) ? num(o.cost) : num(o.price);
  if (o.side !== 'short') return { value: lots * basis * size, unlimited: false };
  if (o.cp === 'put') return { value: Math.max(0, num(o.strike) - basis) * lots * size, unlimited: false };
  return { value: null, unlimited: true };
}

// 權證：1 張 = 1000 單位；每單位可換 ratio 股標的
export const WAR_UNITS = 1000;

export const ivSince = () => {
  const d = new Date(Date.now() - 60 * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// 發行券商調降隱波是權證買方最大的隱形損失，delta 抓不到，只能靠逐日比對
export function ivChange(code) {
  const rows = state.ivHistory.filter((r) => norm(r.code) === norm(code) && isNum(r.iv));
  if (rows.length < 2) return null;
  const first = num(rows[0].iv), last = num(rows[rows.length - 1].iv);
  return { first, last, diff: last - first, days: rows.length };
}

export const warLabel = (w) => `${esc(w.code)} ${esc(w.name || '')}`.trim();

export const warDelta = (w) => (isNum(w.delta_override) ? num(w.delta_override) : isNum(w.delta) ? num(w.delta) : null);

// 市值：權證只能做買方，一定是正的
export const warValue = (w) => num(w.lots) * WAR_UNITS * num(w.price);

// delta 曝險 = 張數 × 1000 × 行使比例 × delta × 標的股價
export const warExposure = (w) => {
  const d = warDelta(w);
  return d === null || !isNum(w.ratio) || !isNum(w.underlying_price)
    ? null : num(w.lots) * WAR_UNITS * num(w.ratio) * d * num(w.underlying_price);
};

export const warPl = (w) => (isNum(w.cost) ? (num(w.price) - num(w.cost)) * num(w.lots) * WAR_UNITS : null);

// 買方最大損失就是付出的權利金
export const warMaxRisk = (w) => (isNum(w.cost) ? num(w.cost) : num(w.price)) * num(w.lots) * WAR_UNITS;

// 剩餘交易日（粗估）
export const warDaysLeft = (w) => {
  if (!w.last_trade_date) return null;
  const d = Math.round((new Date(w.last_trade_date + 'T00:00:00') - new Date(todayISO() + 'T00:00:00')) / 86400000);
  return Number.isFinite(d) ? d : null;
};

// 模型只對一般型成立；界限型、重設型要靠手動填 delta
export const warModelOk = (w) => !w.category || w.category.includes('一般型');

// 個股期貨規格：曝險等同的現股股數
export const STOCK_FUT_SIZES = [
  { size: 2000, label: '大型（2 張 ＝ 2,000 股）' },
  { size: 100,  label: '小型（100 股）' },
];

export const stockFutLabel = (size) => (num(size) === 100 ? '小' : '大');

export function futDisplayName(kind, symbol, size) {
  if (kind === 'stock') {
    const nm = TW_STOCKS[norm(symbol)] || '';
    return `${norm(symbol)}${nm ? ' ' + nm : ''} ${stockFutLabel(size)}型個股期`;
  }
  return indexProduct(symbol)?.name || norm(symbol);
}

export function fmtQty(market, q) {
  q = num(q);
  if (market === 'futures' || market === 'option') return `${fmtMax(q, 2)} 口`;
  if (market === 'warrant') return `${fmtMax(q, 2)} 張`;
  if (market === 'tw') return q !== 0 && q % 1000 === 0 ? `${fmt(q / 1000)} 張` : `${fmt(q)} 股`;
  return `${fmtMax(q, 4)} 股`;
}

export const fmtNet = (net) => (net === 0 ? '無部位' : `${net > 0 ? '多' : '空'} ${fmtMax(Math.abs(net), 2)} 口`);
