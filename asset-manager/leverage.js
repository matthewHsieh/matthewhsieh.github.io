import { isNum, norm, num, state } from './core.js';
import { usExposureUsd, warExposure, warValue } from './instruments.js';
import { futPx, pxOf } from './live.js';
import { compute } from './portfolio.js';
import { indexSignal, loadSeries } from './risk.js';
import { resolveTwSymbol } from './symbols.js';

// ============================================================
// 大盤等效槓桿（2026-10-30）
//
//   總覽原本只有「曝險槓桿 = 名目 ÷ 總資產」。一次大跌日收盤後實測：
//   App 顯示 2.16 倍，換算成大盤等效是 4.0 倍——差在三件事：
//     1. 名目沒乘 beta。他持有的個股 beta 多在 1.3～1.9，名目 1 元等於 1.5 元的大盤。
//     2. 家人委託的現股（stocks.sleeve）被算進分母，把倍數稀釋了。
//     3. 權證缺 delta 時曝險被當成 0。
//   而換股法的槓桿公式（MA200 之上 2 倍＋回撤加碼，上限 2.5 倍）講的就是大盤等效。
//   用名目去比公式的目標，等於拿兩把不同的尺比長短。
//
//   **還要看下跌 beta。** 10/30 回測：這類中型股在大盤跌超過 2% 的日子，
//   實際跌幅是一般 beta 預期的 1.32 倍；改用「只用大盤下跌日估的 beta」降到 1.08 倍。
//   所以畫面同時給兩個數字：平常的、大跌時的。
//
//   beta 用 risk_stats 的日報酬（收盤對數報酬），最近 250 個共同交易日。
//   算不出來的不當 0（那會讓倍數安靜地變小），用 1.5 代替並標「估計」。
// ============================================================
export const BETA_WIN = 250;
export const BETA_FALLBACK = 1.5;
export const LEV_BAND = 0.3;          // 公式：差距超過 0.3 倍才調整
export const LEV_CAP = 2.5;           // 公式的天花板

const cache = () => (state.retSeries ||= new Map());

function heldSymbols() {
  const s = new Set();
  for (const f of state.futures || []) if (f.kind === 'stock' && f.symbol) s.add(resolveTwSymbol(f.symbol));
  for (const x of state.stocks || []) if (x.symbol) s.add(resolveTwSymbol(x.symbol));
  for (const w of state.warrants || []) if (w.underlying) s.add(resolveTwSymbol(w.underlying));
  return [...s];
}

// 載入持有標的與加權指數的日報酬（跟配置頁共用快取），然後算 beta。
// 失敗不丟錯：總覽照樣畫，只是大盤等效那一格會說算不出來。
export async function ensureLevSeries(extra = []) {
  try {
    const want = [...new Set([...heldSymbols(), ...extra.map(resolveTwSymbol), 'TAIEX'])].filter((k) => !cache().has(k));
    if (want.length) {
      const got = await loadSeries(want);
      for (const k of want) cache().set(k, got.get(k) || null);
    }
  } catch (e) { console.warn('leverage series', e); }
}

// 一檔對加權的 beta 與下跌 beta（最近 BETA_WIN 個共同交易日）
const betaMemo = new Map();
export function betaOf(sym) {
  const k = resolveTwSymbol(sym);
  const s = cache().get(k), ix = cache().get('TAIEX');
  if (!s?.days?.length || !ix?.days?.length) return null;
  const memoKey = `${k}|${s.days.length}|${ix.days.length}`;
  if (betaMemo.has(memoKey)) return betaMemo.get(memoKey);
  const im = new Map(ix.days.map((d, i) => [d, ix.rets[i]]));
  const xs = [], ys = [];
  for (let i = s.days.length - 1; i >= 0 && xs.length < BETA_WIN; i -= 1) {
    const m = im.get(s.days[i]);
    if (m === undefined || m === null) continue;
    xs.push(num(m)); ys.push(num(s.rets[i]));
  }
  let out = null;
  if (xs.length >= 120) {
    const fit = (idx) => {
      const mx = idx.reduce((a, i) => a + xs[i], 0) / idx.length, my = idx.reduce((a, i) => a + ys[i], 0) / idx.length;
      let cv = 0, vx = 0;
      for (const i of idx) { cv += (xs[i] - mx) * (ys[i] - my); vx += (xs[i] - mx) ** 2; }
      return vx > 0 ? cv / vx : null;
    };
    const all = xs.map((_, i) => i), dn = all.filter((i) => xs[i] < 0);
    const beta = fit(all);
    if (beta !== null) out = { beta, down: dn.length >= 40 ? (fit(dn) ?? beta) : beta };
  }
  betaMemo.set(memoKey, out);
  return out;
}

// 個股的 beta，算不出來就用 BETA_FALLBACK 並標估計
function stockBeta(sym) {
  const b = betaOf(sym);
  return b ? { ...b, est: false } : { beta: BETA_FALLBACK, down: BETA_FALLBACK, est: true };
}

// 現在的大盤等效槓桿。extra：還沒存檔的那一筆，{ exposure, sym | null（指數／美股 beta 1） }
export function idxLevNow(extra = null) {
  const c = compute();
  const rows = [];
  const add = (label, v, b, kind) => rows.push({ label, v, exp: v * b.beta, down: v * b.down, est: !!b.est, kind });
  const one = { beta: 1, down: 1, est: false };
  for (const f of state.futures || []) {
    const v = num(f.lots) * futPx(f) * num(f.size) * (f.side === 'short' ? -1 : 1);
    if (!v) continue;
    if (f.kind === 'stock') add(f.contract || f.symbol, v, stockBeta(f.symbol), 'fut');
    else add(f.contract || f.symbol, v, one, 'idx');
  }
  let sleeve = 0;
  for (const s of state.stocks || []) {
    const v = num(s.shares) * pxOf(s, s.symbol);
    if (!(v > 0)) continue;
    if (s.sleeve) { sleeve += v; continue; }            // 家人委託：分子分母都不算
    add(`${s.symbol} ${s.name || ''}`.trim(), v, stockBeta(s.symbol), 'tw');
  }
  const rate = num(state.settings?.usd_twd) || 32;
  // 美股對加權的 beta 沒有意義（不同市場），照公式的作法當 1 倍
  for (const u of state.us || []) { const v = usExposureUsd(u) * rate; if (v > 0) add(norm(u.symbol), v, one, 'us'); }
  for (const w of state.warrants || []) {
    const e = warExposure(w);
    const v = e !== null ? Math.abs(e) : warValue(w) * (isNum(w.gearing) && num(w.gearing) > 0 ? num(w.gearing) : 1);
    if (!(v > 0)) continue;
    const b = w.underlying ? stockBeta(w.underlying) : { beta: BETA_FALLBACK, down: BETA_FALLBACK, est: true };
    add(`${w.code} 權證`, v, { ...b, est: b.est || e === null }, 'war');
  }
  if (num(c.optExposure)) add('選擇權 delta', num(c.optExposure), one, 'opt');
  if (extra && extra.exposure) add('這一筆', extra.exposure, extra.sym ? stockBeta(extra.sym) : one, 'new');

  const equity = num(c.totalAssets) - sleeve;
  const exp = rows.reduce((a, r) => a + r.exp, 0);
  const down = rows.reduce((a, r) => a + r.down, 0);
  const riskRow = (state.riskStats || []).find((x) => String(x.symbol) === 'TAIEX');
  const sig = indexSignal(cache(), riskRow);
  const target = sig ? Math.min(LEV_CAP, sig.lev) : null;
  return {
    equity, sleeve, exp, down, rows,
    lev: equity > 0 ? exp / equity : NaN,
    levDown: equity > 0 ? down / equity : NaN,
    est: rows.some((r) => r.est),
    sig, target,
  };
}
