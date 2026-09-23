import { num, sb, state } from './core.js';
import { usExposureUsd, usLeverage } from './instruments.js';

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
  // **TAIEX 住在 risk_stats，不是 us_stats。** 只用「開頭是不是數字」分流的話
  // 它會被丟去美股那張表，而且只有在同時挑了台股時才會因為附帶查詢而僥倖抓到。
  const isTw = (s) => /^[0-9]/.test(s) || s === 'TAIEX';
  const tw = [...new Set(symbols.filter(isTw))];
  const us = [...new Set(symbols.filter((s) => !isTw(s)))];
  const out = new Map();
  const take = (rows) => {
    for (const r of rows || []) {
      if (!r.rets || !r.ret_days || !r.rets.length) continue;
      out.set(String(r.symbol), { days: r.ret_days, rets: r.rets,
        vol: num(r.vol1y ?? r.vol), ratio: num(r.ratio), cagr: num(r.cagr) });
    }
  };
  const jobs = [];
  if (tw.length) {
    jobs.push(sb.from('risk_stats').select('symbol,vol,vol1y,ratio,cagr,ret_days,rets')
      .in('symbol', [...new Set([...tw, 'TAIEX'])]).then(({ data }) => take(data)));
  }
  if (us.length) {
    jobs.push(sb.from('us_stats').select('symbol,vol,ratio,cagr,ret_days,rets')
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

// ------------------------------------------------------------
// 對大盤的 beta：把一檔「換算成等值的指數部位」
//
//   beta = cov(個股, 指數) / var(指數)。意思是指數動 1%，這一檔平均動幾 %。
//   所以 曝險 × beta 就是「這個部位相當於持有多少大盤」。
//
//   **跟波動倍率是兩件事，不能混用。**
//     beta 倍率  = Σ(曝險 × beta) ÷ 總資產 → 大盤跌 10% 你大概跌多少
//     波動倍率   = 組合波動 ÷ 指數波動     → 你的總風險相當於開幾倍指數
//   兩者的差距就是**選股帶來的個別風險**：押三檔同族群的話，波動倍率會遠高於
//   beta 倍率，那個差額不會因為大盤沒跌就不存在。
//
//   **成對對齊，不跟主矩陣共用樣本期。** beta 是兩兩關係，用各自最長的
//   共同期間估比較準；主矩陣那邊要取所有標的的交集，會浪費掉很多資料。
// ------------------------------------------------------------
export function betaVs(series, keys, ref = 'TAIEX') {
  const r = series?.get?.(ref);
  const out = new Map();
  if (!r?.days?.length) return out;
  const rm = new Map(r.days.map((d, i) => [d, r.rets[i]]));
  for (const k of keys) {
    if (k === ref) { out.set(k, 1); continue; }
    const s = series.get(k);
    if (!s?.days?.length) continue;
    const xs = [], ys = [];
    for (let i = 0; i < s.days.length; i += 1) {
      const y = rm.get(s.days[i]);
      if (y === undefined) continue;
      xs.push(num(s.rets[i])); ys.push(num(y));
    }
    // 樣本太少的不要給數字。**回 null 比回一個亂估的 beta 好**，
    // 因為 beta 會直接乘上曝險，估歪的影響是放大的。
    if (xs.length < 60) continue;
    const mx = mean(xs), my = mean(ys);
    let cov = 0, vy = 0;
    for (let i = 0; i < xs.length; i += 1) { cov += (xs[i] - mx) * (ys[i] - my); vy += (ys[i] - my) ** 2; }
    if (!(vy > 0)) continue;
    out.set(k, cov / vy);
  }
  return out;
}

// 一組權重換算成大盤曝險倍率。weights 是佔總資產的比例。
// **算不出 beta 的要講出來，不能當 0。** 當 0 等於說「這個部位跟大盤無關」，
// 那會讓倍率安靜地變小，而變小的風險數字最危險。
export function indexLeverage(keys, weights, betas) {
  let lev = 0;
  const missing = [];
  keys.forEach((k, i) => {
    const b = betas.get(k);
    if (b === undefined) { if (Math.abs(num(weights[i])) > 1e-9) missing.push(k); return; }
    lev += num(weights[i]) * b;
  });
  return { lev, missing };
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

// ------------------------------------------------------------
// 最大報酬/波動（tangency portfolio）
//
//   風險平價只回答「同樣的風險怎麼分」，不看預期報酬。要「組合的報酬/波動
//   最好」就得把預期報酬放進去，也就是做 mean-variance 最佳化。
//
//   **最危險的一步是預期報酬怎麼來的。** 用過去三年的年化報酬直接當預期，
//   旺矽是 208%／年、永豐金 43%——最佳化會把幾乎全部的錢壓到前一兩檔，
//   而那是對估計誤差的過度反應，不是真的洞見。兩個護欄：
//     1. **往橫斷面平均收縮**（預設收一半）。收縮在報酬/波動這個尺度上做，
//        因為比值 1.8~3.3 的離散度遠小於報酬 43%~208%，數值穩定得多。
//     2. **單檔權重上限**，預設 35%。沒有上限的 MVO 幾乎一定會出角解。
//   即使如此，這一欄要標成「假設」，不能標成「預測」。
// ------------------------------------------------------------

// 投影到 {w ≥ 0, Σw = 1}（Duchi et al. 2008）
function projSimplex(v) {
  const n = v.length;
  const u = [...v].sort((a, b) => b - a);
  let css = 0, theta = 0;
  for (let i = 0; i < n; i += 1) {
    css += u[i];
    const t = (css - 1) / (i + 1);
    if (u[i] - t > 0) theta = t;
  }
  return v.map((x) => Math.max(0, x - theta));
}

// 再加上單檔上限：超過的釘在上限，剩下的按比例重分配
function projCapped(v, cap) {
  let w = projSimplex(v);
  const n = w.length;
  if (cap >= 1 || n * cap < 1) return w;
  for (let it = 0; it < 60; it += 1) {
    const over = w.map((x, i) => (x > cap + 1e-12 ? i : -1)).filter((i) => i >= 0);
    if (!over.length) return w;
    const set = new Set(over);
    const rest = w.reduce((a, x, i) => a + (set.has(i) ? 0 : x), 0);
    const room = 1 - over.length * cap;
    const k = rest > 1e-12 ? room / rest : 0;
    w = w.map((x, i) => (set.has(i) ? cap : x * k));
  }
  return w;
}

// 把比值往平均收縮，再乘回各自的波動，得到「假設的預期年化報酬」
export function assumedMu(st, ratios, shrink = 0.5) {
  const avg = ratios.reduce((a, b) => a + b, 0) / (ratios.length || 1);
  return ratios.map((r, i) => (shrink * r + (1 - shrink) * avg) * st.vol[i]);
}

export function maxSharpe(st, mu, { cap = 0.35, iters = 900, step = 0.08 } = {}) {
  const n = st.keys.length;
  if (!n) return [];
  if (n === 1) return [1];
  let w = new Array(n).fill(1 / n);
  for (let t = 0; t < iters; t += 1) {
    const sd = portVol(w, st);
    if (!sd) break;
    const mr = w.reduce((a, x, i) => a + x * mu[i], 0);
    const g = w.map((_, i) => {
      let sw = 0;
      for (let j = 0; j < n; j += 1) sw += w[j] * st.vol[i] * st.vol[j] * st.corr[i][j];
      return mu[i] / sd - (mr * sw) / (sd ** 3);
    });
    const gn = Math.sqrt(g.reduce((a, x) => a + x * x, 0)) || 1;
    w = projCapped(w.map((x, i) => x + (step / gn) * g[i]), Math.min(1, Math.max(1 / n, cap)));
  }
  return w;
}

// 這組權重在「假設的預期報酬」下的報酬/波動
export const sharpeOf = (w, st, mu) => {
  const sd = portVol(w, st);
  return sd ? w.reduce((a, x, i) => a + x * mu[i], 0) / sd : 0;
};

// ------------------------------------------------------------
// 離 60 日高點幾個標準差
//
//   「跌 20%」在不同波動的標的上意義完全不同：
//   月波動 10% 的股票跌 20% 是 −1.15 個標準差；
//   月波動 4% 的指數只跌 10%，卻是 −1.44 個標準差，其實更極端。
//   要比較不同標的的「位階」，一定要換成標準差。
//
//   窗口 63 個交易日 ≈ 三個月。（60 個交易日其實也差不多是三個月，
//   容易被當成 60 個日曆日＝兩個月，所以寫 63。）
// ------------------------------------------------------------
export function dropZ(series, key, win = 63) {
  const s = series?.get?.(key);
  if (!s || !s.rets || s.rets.length < win + 5) return null;
  const r = s.rets.slice(-win);
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length);
  if (!(sd > 0)) return null;
  // 從高點算起的累積報酬：往回累加，最小值就是「離期間高點多遠」
  let cum = 0, best = 0;
  for (let i = r.length - 1; i >= 0; i -= 1) {
    cum += r[i];
    if (cum > best) best = cum;
  }
  const dd = -best;                       // ≤ 0，對數報酬
  return { dd, sd, z: dd / (sd * Math.sqrt(win)) };
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

// ------------------------------------------------------------
// 指數該開幾倍：MA200 趨勢 ＋ 回撤加碼
//
//   2026-09-17 用 25 年加權指數（2002-07~2026-09、5,557 個 18 個月滾動窗口）測的：
//     固定 1.86 倍        終值 15.08x、最大回撤 −82.7%
//     只用 MA200 濾網     終值 14.87x、最大回撤 −60.9%、平均槓桿只有 1.40 倍
//   **報酬一樣，但濾網用少了四分之一的槓桿、少掉 22 個百分點的回撤。**
//   原因不是它會躲下跌——均線之下平均起來還是漲的——而是報酬/波動從
//   0.76 掉到 0.32，槓桿的價值完全取決於這個比值。
//
//   回撤加碼那一段要當心：2008 年「只用濾網」是 0.82x，加了回撤加碼變成 0.50x。
//   它在大多頭貢獻最多報酬，在真正的崩盤裡是加速器。所以兩個數字都給。
//
//   **這是指數的倍率，不能套到個股上。** 同一條規則套金居是 −95.7% 且被追繳。
// ------------------------------------------------------------
const toPrices = (rets) => {
  const out = [1];
  for (const r of rets) out.push(out[out.length - 1] * Math.exp(num(r)));
  return out;
};

export function indexSignal(series, riskRow, win = 200) {
  const s = series?.get?.('TAIEX');
  if (!s || !s.rets || s.rets.length < win) return null;
  // 還原成價格指數。**比例是多少不重要**，價格與均線的比值是尺度不變的。
  const p = toPrices(s.rets);
  const last = p[p.length - 1];
  const seg = p.slice(-win);
  const ma = seg.reduce((a, b) => a + b, 0) / seg.length;
  const above = last >= ma;

  // 回撤用 risk_stats 的 52 週高點，跟畫面其它地方同一個來源。
  // （回測用的是歷史最高點，指數在高檔時兩者幾乎一樣。）
  const hi = num(riskRow?.hi52);
  const px = num(riskRow?.last);
  const dd = hi > 0 && px > 0 ? Math.max(0, (hi - px) / hi) : 0;
  const add = Math.min(1, 4 * dd);
  return {
    above, maRatio: last / ma, dd, hi, px,
    base: above ? 2 : 0,
    add,
    lev: (above ? 2 : 0) + add,      // 完整規則
    levFilter: above ? 2 : 0,        // 只用濾網（2008 年表現比較好的那個）
  };
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
    // 倍數走 usLeverage()：沒填倍數時從名稱推，跟總覽、持倉頁用同一套規則。
    // 之前這裡只看欄位，名稱推得出 2X 的部位在總覽是兩倍、在配置頁卻是一倍。
    const v = usExposureUsd(u) * rate;
    if (v > 0) rows.push({ key: String(u.symbol), label: `${u.symbol}`, exposure: v,
                           kind: 'us', side: usLeverage(u) < 0 ? -1 : 1 });
  }
  return rows;
}
