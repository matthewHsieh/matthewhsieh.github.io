import { esc, isNum, norm, num, state } from './core.js';

// ============================================================
// 計算
//   總資產 = 台股市值 + 複委託市值 + 期貨帳戶權益數 + 現金
//   淨資產 = 總資產 − 負債
//   槓桿① 資產槓桿 = 總資產 / 淨資產
//   槓桿② 曝險槓桿 = 總曝險 / 總資產
//   總曝險 = 台股市值 + 複委託市值 + 期貨名目（指數期貨 ＋ 個股期貨，多空都算）
//   期貨名目 = 口數 × 價格 × size
//     指數期貨 size = 每點價值；個股期貨 size = 等同股數（大 2000 / 小 100）
// ============================================================
// ------------------------------------------------------------
// 盤中報價
//
//   market_prices 存的是收盤價，盤中價在 market_live（來源是證交所 MIS）。
//   這裡把它疊上去，讓持倉、總覽、曝險三邊用的是同一個價，不會互相對不上。
//
//   **只蓋 price 一個欄位。** 股數與成本是他自己輸入的，永遠不動。
//   而且只在報價夠新的時候才算數——收盤後 cron 就不再寫 market_live，
//   資料自然變舊，會自己退回收盤價，不必在前端判斷交易時段與假日。
// ------------------------------------------------------------
const LIVE_FRESH_MS = 15 * 60 * 1000;

export function liveMap() {
  const m = new Map();
  const now = Date.now();
  for (const r of state.marketLive || []) {
    const t = Date.parse(r.at);
    if (!Number.isFinite(t) || now - t > LIVE_FRESH_MS) continue;
    if (!(num(r.price) > 0)) continue;
    m.set(norm(r.symbol), { price: num(r.price), chg: num(r.chg), at: t });
  }
  return m;
}

// 有新鮮的盤中報價就用它，否則用存下來的收盤價
export const livePx = (sym) => (state._live || new Map()).get(norm(sym)) || null;

export const liveTag = (sym) => {
  const l = livePx(sym);
  if (!l) return '';
  const hm = new Date(l.at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `<span class="badge live-badge">盤中 ${esc(hm)}</span>`;
};

export const pxOf = (row, sym) => {
  const l = livePx(sym === undefined ? row.symbol : sym);
  return l ? l.price : num(row.price);
};

export function futNotional(f) {
  return num(f.lots) * futPx(f) * num(f.size);
}

// 個股期用標的的盤中價；指數期沒有 MIS 來源，維持原本的價
export const futPx = (f) => (f.kind === 'stock' && f.symbol ? pxOf(f, f.symbol) : num(f.price));

// 期貨損益：多單 (現價 − 成本)、空單 (成本 − 現價)，再乘口數與規格
// 沒填成本就回 null（跟股票一樣不顯示損益）
export function futPl(f) {
  if (!isNum(f.cost)) return null;
  const px = futPx(f);
  const diff = f.side === 'short' ? num(f.cost) - px : px - num(f.cost);
  return diff * num(f.lots) * num(f.size);
}
