import { isNum, num, sb, state } from './core.js';

// ============================================================
// 組合風險
//
//   一檔要買多少，看它自己的波動就夠：
//       曝險 = 總資產 × 風險預算 ÷ 年化波動
//   但「這幾檔加起來的風險」**不能把波動相加**。2026-09-17 實測他的部位：
//   金居與聯茂相關 0.50、MUU 與 SNXX 0.78，而 SNXX 對台股只有 0.12。
//   直接相加會高估、用單因子近似會低估（金居-聯茂會被算成 0.29），
//   而低估風險是最糟的方向。所以老實用日報酬算相關係數矩陣。
//
//   **對齊一定要用日期，不能用「從最後一天往回數」。**
//   遇到停牌就整條錯開，而錯開的效果是相關係數被稀釋成 0——又是低估。
// ============================================================

// 年化係數：一年 252 個交易日
const ANN = Math.sqrt(252);

// 從 risk_stats / us_stats 抓日報酬序列
export async function loadSeries(symbols) {
  const tw = [...new Set(symbols.filter((s) => /^[0-9]/.test(s)))];
  const us = [...new Set(symbols.filter((s) => !/^[0-9]/.test(s)))];
  const out = new Map();
  const take = (rows) => {
    for (const r of rows || []) {
      if (!r.rets || !r.ret_days || !r.rets.length) continue;
      out.set(String(r.symbol), { days: r.ret_days, rets: r.rets, vol: num(r.vol1y ?? r.vol) });
    }
  };
  const jobs = [];
  if (tw.length) {
    jobs.push(sb.from('risk_stats').select('symbol,vol,vol1y,ret_days,rets')
      .in('symbol', [...tw, 'TAIEX']).then(({ data }) => take(data)));
  }
  if (us.length) {
    jobs.push(sb.from('us_stats').select('symbol,vol,ret_days,rets')
      .in('symbol', us).then(({ data }) => take(data)));
  }
  await Promise.all(jobs);
  return out;
}

// 只留大家都有交易的日子。**交集，不是補零**——補零會把相關係數往下拉。
function align(series, keys) {
  if (!keys.length) return { days: [], cols: [] };
  let common = null;
  for (const k of keys) {
    const s = series.get(k);
    if (!s) return { days: [], cols: [] };
    const set = new Set(s.days);
    common = common === null ? set : new Set([...common].filter((d) => set.has(d)));
  }
  const days = [...common].sort((a, b) => a - b);
  const cols = keys.map((k) => {
    const s = series.get(k);
    const m = new Map(s.days.map((d, i) => [d, s.rets[i]]));
    return days.map((d) => num(m.get(d)));
  });
  return { days, cols };
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);

function stdev(a) {
  const m = mean(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length || 1));
}

// 挑出「彼此重疊天數還夠」的最大子集。
//
//   交集會被最短的那一條拉到最低：加進一檔上市兩個月的新股，
//   **整個矩陣就只剩兩個月的樣本**，其它十檔兩年的資料全部浪費掉，
//   而且算出來的相關係數毫無意義。與其整張卡片掛掉，
//   不如把太短的那幾檔挑出來單獨標示。
//   作法：按序列長度由長到短依序加入，加了會讓交集掉到 minDays 以下就不加。
export function usableKeys(series, keys, minDays = 120) {
  const ok = keys.filter((k) => series.get(k)?.days?.length);
  ok.sort((a, b) => series.get(b).days.length - series.get(a).days.length);
  const kept = [];
  let common = null;
  const dropped = [];
  for (const k of ok) {
    const set = new Set(series.get(k).days);
    const next = common === null ? set : new Set([...common].filter((d) => set.has(d)));
    if (kept.length && next.size < minDays) { dropped.push(k); continue; }
    kept.push(k);
    common = next;
  }
  return { kept, dropped, days: common ? common.size : 0 };
}

// 波動與相關係數。**用實際對齊到的天數算，不要用 risk_stats 存的 vol**，
// 否則波動與相關係數來自不同的樣本期，矩陣可能不是正定的。
export function statsOf(series, keys) {
  const { days, cols } = align(series, keys);
  if (days.length < 60) return null;
  const vol = cols.map((c) => stdev(c) * ANN);
  const corr = keys.map((_, i) => keys.map((__, j) => {
    const a = cols[i], b = cols[j];
    const ma = mean(a), mb = mean(b);
    const sa = stdev(a), sb2 = stdev(b);
    if (!sa || !sb2) return i === j ? 1 : 0;
    let cov = 0;
    for (let k = 0; k < a.length; k += 1) cov += (a[k] - ma) * (b[k] - mb);
    return cov / a.length / (sa * sb2);
  }));
  return { keys, vol, corr, days: days.length };
}

// 組合年化波動。weights 是「佔總資產的比例」，可以大於 1（有槓桿）。
export function portVol(w, st) {
  let v = 0;
  for (let i = 0; i < w.length; i += 1) {
    for (let j = 0; j < w.length; j += 1) {
      v += w[i] * w[j] * st.vol[i] * st.vol[j] * st.corr[i][j];
    }
  }
  return Math.sqrt(Math.max(0, v));
}

// 每一檔對組合波動的貢獻（加總會等於組合波動）
export function riskContrib(w, st) {
  const pv = portVol(w, st);
  if (!pv) return w.map(() => 0);
  return w.map((wi, i) => {
    let m = 0;
    for (let j = 0; j < w.length; j += 1) m += w[j] * st.vol[i] * st.vol[j] * st.corr[i][j];
    return (wi * m) / pv;
  });
}

// 風險平價：每一檔貢獻一樣多的波動。
// 迭代法，從 1/波動 出發，通常 200 輪內就收斂。
export function riskParity(st, iters = 600) {
  const n = st.keys.length;
  if (!n) return [];
  let w = st.vol.map((v) => (v > 0 ? 1 / v : 0));
  const norm = (x) => {
    const s = x.reduce((a, b) => a + b, 0) || 1;
    return x.map((v) => v / s);
  };
  w = norm(w);
  for (let t = 0; t < iters; t += 1) {
    const rc = riskContrib(w, st);
    const pv = portVol(w, st);
    if (!pv) break;
    const target = pv / n;
    w = norm(w.map((wi, i) => Math.max(1e-9, wi * (1 + 0.08 * (target / (rc[i] || 1e-9) - 1)))));
  }
  return w;
}

// 把一組權重整體縮放到指定的組合波動
export function scaleTo(w, st, targetVol) {
  const pv = portVol(w, st);
  if (!pv) return w.map(() => 0);
  const k = targetVol / pv;
  return w.map((x) => x * k);
}

// 單檔風險預算法：不需要相關係數，最好解釋也最好用
export const sizeByBudget = (assets, budget, vol) =>
  (vol > 0 ? (num(assets) * num(budget)) / vol : 0);

// 個股期貨一口的名目金額（大型 2,000 股 / 小型 100 股）
export const futLotValue = (price, size) => num(price) * num(size || 2000);

// ------------------------------------------------------------
// 保證金距離：離追繳還有多遠
//   原始保證金依標的風險係數而定，這裡用 13.5% 當預設，
//   維持保證金約為原始的 75%。**畫面上要標成「約」**，
//   實際數字每家期貨商、每檔標的都不同。
// ------------------------------------------------------------
export const IM_RATE = 0.135;
export const MM_RATE = IM_RATE * 0.75;

export function marginRoom(notional, equity) {
  const im = num(notional) * IM_RATE;
  const mm = num(notional) * MM_RATE;
  const room = num(equity) - mm;
  return {
    im, mm, room,
    pct: num(notional) > 0 ? room / num(notional) : null,   // 標的跌幾 % 會被追繳
  };
}

// 這個跌幅在該波動下是幾個標準差、一個月內走到的機率大約多少
export function moveOdds(pct, vol, days = 21) {
  if (!(pct > 0) || !(vol > 0)) return null;
  const sd = vol * Math.sqrt(days / 252);
  const zScore = pct / sd;
  // 常態近似的單尾機率
  const p = 0.5 * erfc(zScore / Math.SQRT2);
  return { sd, z: zScore, p };
}

// Abramowitz & Stegun 7.1.26 的 erfc，精度對這個用途綽綽有餘
function erfc(x) {
  const zz = Math.abs(x);
  const t = 1 / (1 + zz / 2);
  const r = t * Math.exp(-zz * zz - 1.26551223 + t * (1.00002368 + t * (0.37409196
    + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398
    + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

// 目前持倉的曝險明細（台股現股、個股期貨、指數期貨、複委託）
export function exposureRows() {
  const rows = [];
  const px = (v) => num(v);
  for (const f of state.futures || []) {
    const notional = num(f.lots) * px(f.price) * num(f.size);
    if (notional > 0) {
      rows.push({ key: f.kind === 'stock' ? String(f.symbol) : `IDX:${f.symbol}`,
                  label: f.contract || f.symbol, exposure: notional,
                  kind: 'futures', side: f.side === 'short' ? -1 : 1 });
    }
  }
  for (const s of state.stocks || []) {
    const v = num(s.shares) * px(s.price);
    if (v > 0) rows.push({ key: String(s.symbol), label: `${s.symbol} ${s.name || ''}`.trim(),
                           exposure: v, kind: 'tw', side: 1 });
  }
  const rate = num(state.settings?.usd_twd) || 32;
  for (const u of state.us || []) {
    const lev = isNum(u.leverage) ? Math.abs(num(u.leverage)) : 1;
    const v = num(u.shares) * num(u.price_usd) * rate * lev;
    if (v > 0) rows.push({ key: String(u.symbol), label: `${u.symbol}`, exposure: v,
                           kind: 'us', side: num(u.leverage) < 0 ? -1 : 1 });
  }
  return rows;
}
