import { esc, norm, num } from './core.js';

// ============================================================
// 商品資料
// ============================================================
// 指數期貨：symbol 為期交所商品代碼，size 為每點價值
const INDEX_FUTURES = [
  { symbol: 'TX',  name: '臺股期貨（大台）', size: 200 },
  { symbol: 'MTX', name: '小型臺指期貨（小台）', size: 50 },
  { symbol: 'TMF', name: '微型臺指期貨（微台）', size: 10 },
  { symbol: 'TE',  name: '電子期貨', size: 4000 },
  { symbol: 'ZEF', name: '小型電子期貨', size: 500 },
  { symbol: 'TF',  name: '金融期貨', size: 1000 },
  { symbol: 'ZFF', name: '小型金融期貨', size: 250 },
];

export const indexProduct = (sym) => INDEX_FUTURES.find((p) => p.symbol === norm(sym));

// 台股代號 → 名稱
export let TW_STOCKS = {};

export let TW_ENTRIES = [];

export async function loadTwStocks() {
  try {
    const r = await fetch('./tw-stocks.json');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    TW_STOCKS = await r.json();
    TW_ENTRIES = Object.entries(TW_STOCKS);
  } catch (e) {
    console.warn('tw-stocks.json 載入失敗，代號將不會自動帶名稱', e);
  }
}

// 使用者可能打中文名稱而不是代號。名稱唯一對得上就換成代號，
// 否則同一檔會因為「台玻」與「1802」被當成兩個標的，當沖配不成對、損益就消失了。
export function resolveTwSymbol(input) {
  const q = norm(input);
  if (!q) return q;
  if (TW_STOCKS[q]) return q;                       // 本來就是代號
  const exact = TW_ENTRIES.filter(([, n]) => n === String(input).trim());
  if (exact.length === 1) return exact[0][0];
  const partial = TW_ENTRIES.filter(([, n]) => n.includes(String(input).trim()));
  if (partial.length === 1) return partial[0][0];
  return q;                                         // 解析不出來就原樣保留
}

export const LOOKUPS = {
  tw: {
    exact: (q) => (TW_STOCKS[q] ? { code: q, name: TW_STOCKS[q] } : null),
    search: (q) =>
      TW_ENTRIES.filter(([c, n]) => c.startsWith(q) || n.includes(q)).slice(0, 8).map(([c, n]) => ({ code: c, name: n })),
  },
  index: {
    exact: (q) => {
      const p = INDEX_FUTURES.find((x) => x.symbol === q || x.name === q);
      return p ? { code: p.symbol, name: p.name, size: p.size } : null;
    },
    search: (q) =>
      INDEX_FUTURES.filter((p) => p.symbol.includes(q) || p.name.includes(q))
        .map((p) => ({ code: p.symbol, name: `${p.name}・每點 ${p.size}`, size: p.size })),
  },
};
LOOKUPS.stockfut = LOOKUPS.tw; // 個股期貨用股票代號查

// 在輸入框下方掛建議清單；kind 可為字串或函式
export function attachLookup(input, kind, onPick) {
  const kindOf = typeof kind === 'function' ? kind : () => kind;
  const box = document.createElement('div');
  box.className = 'suggest';
  box.hidden = true;
  (input.closest('label') || input).insertAdjacentElement('afterend', box);

  const run = () => {
    const lk = LOOKUPS[kindOf()];
    const q = norm(input.value);
    if (!lk || !q) { box.hidden = true; return; }
    const exact = lk.exact(q);
    if (exact) onPick(exact, false);
    const list = lk.search(q).filter((m) => !exact || m.code !== exact.code);
    box.innerHTML = list
      .map((m) => `<button type="button" data-code="${esc(m.code)}"><b>${esc(m.code)}</b>${esc(m.name)}</button>`)
      .join('');
    box.hidden = list.length === 0;
  };
  input.addEventListener('input', run);
  input.addEventListener('focus', run);
  input.addEventListener('blur', () => setTimeout(() => (box.hidden = true), 200));
  box.addEventListener('mousedown', (e) => e.preventDefault());
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-code]');
    if (!b) return;
    const lk = LOOKUPS[kindOf()];
    input.value = b.dataset.code;
    onPick(lk?.exact(norm(b.dataset.code)) || { code: b.dataset.code, name: '' }, true);
    box.hidden = true;
  });
  return { refresh: run };
}

// 代號對得上行情來源，價格才會每天自動更新
export const twKnown = (sym) => !!TW_STOCKS[norm(sym)];

export const autoPriceOk = (f) => (f.kind === 'stock' ? twKnown(f.symbol) : !!indexProduct(f.symbol));

// ------------------------------------------------------------
// 當沖：同一天、同一標的既有買也有賣
// 直接用交易紀錄判斷，不另外存欄位，刪掉交易後判定也會跟著正確
// ------------------------------------------------------------
export const tradeKey = (t) =>
  t.market === 'option'
    ? `${t.trade_date}|option|${String(t.opt_expiry ?? '').trim()}|${num(t.opt_strike)}|${t.opt_cp ?? ''}`
    // 台股與個股期貨都用解析後的代號，中文名稱與代號才不會被當成兩個標的
    : `${t.trade_date}|${t.market}|${
        t.market === 'tw' || t.fut_kind === 'stock' ? resolveTwSymbol(t.symbol) : norm(t.symbol)
      }|${t.fut_kind ?? ''}|${num(t.fut_size)}`;
