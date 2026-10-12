import { isNum, num, sb, state } from './core.js';
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
  // 用對數報酬：往回累加才會等於「從那一天到現在的報酬」，簡單報酬相加不會
  const r = s.rets.slice(-win).map((x) => Math.log(1 + num(x)));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length);
  if (!(sd > 0)) return null;
  // 從最後一天往回累加，cum 就是「從第 i 天收盤到現在漲了多少」。
  // 期間高點是讓 cum **最小**的那一天（從高點到現在是最負的），
  // 所以要取最小值。2026-09-23 之前這裡取的是最大值，那是離期間**最低點**多遠再加負號，
  // 結果漲越多的股票 σ 越負：健策漲停創歷史新高那天被標成 −1.8σ，
  // 聯發科貼在高點是 −1.5σ，真的回檔中的台光電反而只有 −0.4σ。
  // 位階加權因此一直在加碼漲最多的，跟「在下跌中買入」完全相反。
  let cum = 0, worst = 0;
  for (let i = r.length - 1; i >= 0; i -= 1) {
    cum += r[i];
    if (cum < worst) worst = cum;
  }
  const dd = worst;                       // ≤ 0，對數報酬；0 = 今天就是高點
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
//
// 2026-10-09 修了兩個錯，兩個都會讓人在該減倉的時候覺得還有空間：
//
// 【一】保證金率不是一個固定數字。期交所分三個級距，處置股票還會個別調高：
//         級距1 維持 10.35%、級距2 12.42%、級距3 15.53%、個別調整最高到 35.19%（金居，2026-10-12 盤後）。
//       原本的 `MM_RATE = 13.5% × 0.75 = 10.125%` 是級距 1 的數字，
//       用他 2026-10-09 的部位實測：真實加權維持率 15.82%，少算 80 萬的維持保證金。
//       現在改成查 `public.fut_margin`（見 supabase/fut_margin.sql），查不到才退回保守值。
//
// 【二】公式漏了分母。原本寫 `pct = (equity − mm) / notional`，
//       但名目下跌時維持保證金會跟著下降，所以追繳條件是
//           E − V·x < V(1−x)·m   →   x > (E/V − m) / (1 − m)
//       少了 (1−m) 這個分母，距離會被低估約 15%。
//       兩個錯方向相反，但第一個大得多：實測會顯示 14.2% 而真實是 10.2%，**高估安全度 39%**。
//
// 查不到費率時的退路用級距 3（15.53%）而不是級距 1。
// **風險數字猜錯的方向要選「看起來更危險」那一邊**，否則這個欄位的存在反而有害。
// ------------------------------------------------------------
export const IM_RATE = 0.2025;              // 級距 3 原始，保守預設
export const MM_RATE = 0.1553;              // 級距 3 維持，保守預設

// 某檔的維持保證金率。個股期貨查 fut_margin；指數期貨是固定金額不是比例，
// 這裡先用保守預設並在回傳值裡標出來（他目前沒有指數期貨部位）。
export function mmRateOf(symbol, kind = 'stock') {
  if (kind !== 'stock') return { rate: MM_RATE, known: false };
  const row = (state.futMargin || []).find((m) => String(m.symbol) === String(symbol));
  if (row && num(row.mm_rate) > 0) return { rate: num(row.mm_rate), known: true, tier: row.tier };
  return { rate: MM_RATE, known: false };
}

// 某檔的原始保證金率。風險指標＝權益 ÷ 原始保證金，是券商的通知線，
// 跟維持保證金（追繳線）是兩條不同的線，不要混用。
export function imRateOf(symbol, kind = 'stock') {
  if (kind !== 'stock') return { rate: IM_RATE, known: false };
  const row = (state.futMargin || []).find((m) => String(m.symbol) === String(symbol));
  if (row && num(row.im_rate) > 0) return { rate: num(row.im_rate), known: true, tier: row.tier };
  return { rate: IM_RATE, known: false };
}

// ------------------------------------------------------------
// 處置造成的保證金調整，以及它的上限
//
// 2026-10-12 的教訓：他沒有被價格打到，是被**盤後公告**打到。
// 金居 10/07 公告處置（10/08～10/15，五週內第三次），他 10/08 在處置第一天
// 加買兩口，10/12 盤後期交所把費率調到 45.90%，風險指標一夜從 118% 掉到 81%。
// 要靠價格做出同樣的傷害，名目得虧 7.7%（約 1.9σ）——**而價格一毛沒動。**
//
// 【階梯不是乘 2】原始的壓力情境我用「費率 ×2」，那是從金居這一次反推的，錯了。
// 期交所的費率是一組公布的格子，結構是「結算 × 1.35 = 原始」：
//     結算  10 / 12 / 15 / 16 / 17 / 22.5 / 34
//     原始  13.50 / 16.20 / 20.25 / 21.60 / 22.95 / 30.38 / 45.90
// 實際的處置調整走這個階梯，但**倍數不固定**。兩個同期觀測值：
//     聯茂 20.25% → 30.38%（×1.50）
//     金居 22.95% → 45.90%（×2.00）← 結算 17% → 34%，整整一倍
// 預設用 ×2（金居那個先例），因為這個欄位的用途是「我撐不撐得住」，
// 猜小了會讓人以為還有空間。×1.5 當溫和情境另外給。
// 註：金居的 22.95% 本身就已經是調整過的值（級距3 的 20.25% 不在階梯的那一格），
// 所以它實際走過 20.25% → 22.95% → 45.90% 至少兩段。
//
// 【45.90% 是上限】全頁 270 檔裡 45.90% 是最高，第二名只有 30.38%。
// 風險上也站得住：維持 35.19% 蓋得住連續 4.1 根跌停、原始 45.90% 蓋得住 5.8 根，
// 結算所沒有理由要更多。所以**已經在頂格的部位不再加壓**——
// 重複收費會讓最該留意的那幾檔（還有調升空間的）被淹沒在雜訊裡。
// ------------------------------------------------------------
export const IM_LADDER = [0.135, 0.162, 0.2025, 0.216, 0.2295, 0.3038, 0.459];
export const IM_TOP = IM_LADDER[IM_LADDER.length - 1];
export const DISP_MULT = 2.0;        // 保守：金居 22.95% → 45.90% 實測
export const DISP_MULT_MILD = 1.5;   // 溫和：聯茂 20.25% → 30.38% 實測

// 若這檔被處置，費率會調到哪一格。已在頂格回 null（＝沒有進一步空間）。
export function imShockRate(rate, mult = DISP_MULT) {
  const r = num(rate);
  if (!(r > 0) || r >= IM_TOP - 1e-9) return null;
  return IM_LADDER.find((x) => x >= r * mult - 1e-9) ?? IM_TOP;
}

// 整個期貨帳戶的保證金狀態。equity 預設取 balances 裡 kind='futures_equity' 的合計。
export function marginState(equity) {
  const eq = isNum(equity) ? num(equity)
    : (state.balances || []).filter((b) => b.kind === 'futures_equity')
        .reduce((a, b) => a + num(b.amount) * (b.currency === 'USD' ? (num(state.settings?.usd_twd) || 32) : 1), 0);
  const legs = [];
  let notional = 0, maint = 0, init = 0, unknown = 0;
  for (const f of state.futures || []) {
    const v = Math.abs(num(f.lots) * num(f.price) * num(f.size));
    if (!(v > 0)) continue;
    const { rate, known, tier } = mmRateOf(f.symbol, f.kind);
    const im = imRateOf(f.symbol, f.kind);
    if (!known) unknown += v;
    notional += v; maint += v * rate; init += v * im.rate;
    legs.push({ symbol: f.symbol, label: f.contract || f.symbol, side: f.side === 'short' ? -1 : 1,
                notional: v, rate, known, tier, weight: 0,
                imRate: im.rate, imKnown: im.known, imAmt: v * im.rate,
                shockRate: imShockRate(im.rate),
                shockRateMild: imShockRate(im.rate, DISP_MULT_MILD) });
  }
  for (const l of legs) l.weight = notional > 0 ? l.notional / notional : 0;
  const m = notional > 0 ? maint / notional : 0;
  // x > (E/V − m) / (1 − m)：名目再跌幾 % 就會被追繳
  const pct = notional > 0 && m < 1 ? (eq / notional - m) / (1 - m) : null;
  return { equity: eq, notional, maint, mmBlended: m, pct,
           amount: pct == null ? null : notional * pct,       // 換成金額
           init,                                             // 原始保證金
           imBlended: notional > 0 ? init / notional : 0,
           riskPct: init > 0 ? eq / init : null,              // 風險指標（<100% 會收到通知）
           unknownShare: notional > 0 ? unknown / notional : 0, legs };
}

// 每一檔「如果它被處置」的保證金衝擊。
// 同一代號可能有多列（大型＋小型），所以先按代號合併再算。
export function marginShocks(st = marginState(), mult = DISP_MULT) {
  const by = new Map();
  for (const l of st.legs) {
    const k = String(l.symbol);
    const p = by.get(k) || { symbol: k, label: l.label, notional: 0, imAmt: 0, imRate: l.imRate };
    p.notional += l.notional; p.imAmt += l.imAmt;
    by.set(k, p);
  }
  const out = [];
  for (const p of by.values()) {
    const to = imShockRate(p.imRate, mult);
    const delta = to == null ? 0 : p.notional * (to - p.imRate);
    const toMild = imShockRate(p.imRate, DISP_MULT_MILD);
    const deltaMild = toMild == null ? 0 : p.notional * (toMild - p.imRate);
    const init2 = st.init + delta;
    out.push({ ...p,
      share: st.init > 0 ? p.imAmt / st.init : 0,
      toRate: to,                                            // null = 已在頂格
      capped: to == null,
      delta,
      toRateMild: toMild,
      riskPctMild: st.init + deltaMild > 0 ? st.equity / (st.init + deltaMild) : null,
      riskPct: init2 > 0 ? st.equity / init2 : null,
      // 把制度風險換成價格刻度：要靠價格造成同樣的風險指標下降，名目得跌幾 %。
      // 不能只寫 Δ·E/(M·V)——價格下跌時**保證金需求也跟著下降**（M = V × 費率），
      // 所以價格造成的傷害比較輕，要跌更多才等效。解 (E−Vf)/(M(1−f)) = E/(M+Δ)：
      //     f = E·Δ / (V·(M+Δ) − E·M)
      // 漏掉那一項會低估約兩成（金居那次：7.7% vs 真值 9.3%），而低估是錯的方向。
      equivDrop: (() => {
        const den = st.notional * (st.init + delta) - st.equity * st.init;
        return delta > 0 && den > 0 ? (st.equity * delta) / den : null;
      })(),
    });
  }
  return out.sort((a, b) => (a.riskPct ?? 9) - (b.riskPct ?? 9));
}

// 必要風險指標 = 1 + 最大「還有調升空間」部位佔原始保證金的比重。
//
// 推導：部位 i 的保證金 m、總額 M，費率調升後新總額 M + Δ。
// 要讓調升後風險指標仍 ≥ 100%，需要 E ≥ M + Δ，即 E/M ≥ 1 + Δ/M。這是恆等式不是估計。
// **已經在頂格的部位要排除**，否則會對已經發生過的事件重複收費。
export function requiredRiskPct(st = marginState(), shocks = null) {
  const sh = shocks || marginShocks(st);   // 預設保守（×2）
  const live = sh.filter((x) => !x.capped);
  if (!live.length || !(st.init > 0)) return { pct: 1, worst: null };
  const worst = live.reduce((a, b) => (b.delta > a.delta ? b : a));
  return { pct: 1 + worst.delta / st.init, worst };
}

// 舊簽章保留（沒有呼叫端，但留著比較不會有人誤用舊語意）。
export function marginRoom(notional, equity, mm = MM_RATE) {
  const im = num(notional) * IM_RATE;
  const mmAmt = num(notional) * mm;
  const room = num(equity) - mmAmt;
  return { im, mm: mmAmt, room,
           pct: num(notional) > 0 && mm < 1 ? (num(equity) / num(notional) - mm) / (1 - mm) : null };
}

// ------------------------------------------------------------
// N 個交易日內「被追繳至少一次」的機率
//
// 為什麼不能用常態近似：追繳是**首次穿越**（first passage），不是期末分布。
// 用期末分布算會嚴重低估——路徑中途碰到就結束了，不會等到最後一天。
// 而且他的部位波動有肥尾與相關性，常態近似在左尾最不準。
//
// 做法：**聯合重抽**同一個歷史日的所有持股報酬（保留相關係數），
// 逐日累積、碰到門檻就記一次。預設抽最近 250 個交易日。
//
// `drift` 選項很重要：樣本期（2025-10~2026-10）的日平均報酬是 +0.48%
// ＝年化 +237%，那是過去一年的大多頭。照抄等於假設多頭重演。
// 預設 'none'（去掉漂移、只保留波動結構），要看樂觀版才傳 'sample'。
// ------------------------------------------------------------
export async function callOdds({ horizons = [3, 20, 60], sims = 20000, drift = 'none', window = 250 } = {}) {
  const st = marginState();
  if (!(st.notional > 0) || st.pct == null) return null;
  const legs = st.legs;
  // 同一檔可能有兩個 leg（大型與小型各一口），所以代號要去重再對齊，
  // 然後把欄位對回每個 leg —— 直接 `keys.map()` 會在有重複代號時錯位。
  const symbols = legs.map((l) => String(l.symbol));
  const uniq = [...new Set(symbols)];
  const series = await loadSeries(uniq);
  const missing = uniq.filter((s) => !series.has(s));
  if (missing.length) {
    return { ...st, odds: null, missing: legs.filter((l) => missing.includes(String(l.symbol))).map((l) => l.label) };
  }
  // 用日期交集對齊，避免停牌把相關係數稀釋掉
  const aligned = align(series, uniq);
  if (!aligned || aligned.days.length < 60) return { ...st, odds: null, missing: [] };
  const colOf = new Map(uniq.map((s, i) => [s, aligned.cols[i]]));
  const legCols = legs.map((l) => colOf.get(String(l.symbol)));
  const n = aligned.days.length;
  const from = Math.max(0, n - window);
  const w = legs.map((l) => l.side * l.weight);
  const port = [];
  for (let t = from; t < n; t++) {
    let r = 0;
    for (let i = 0; i < legs.length; i++) r += w[i] * num(legCols[i][t]);
    port.push(r);
  }
  const mu = port.reduce((a, b) => a + b, 0) / port.length;
  const draw = drift === 'sample' ? port : port.map((v) => v - mu);
  const x = st.pct;
  const odds = {};
  for (const T of horizons) {
    let hit = 0;
    for (let s = 0; s < sims; s++) {
      let lvl = 1;
      for (let t = 0; t < T; t++) {
        lvl *= 1 + draw[(Math.random() * draw.length) | 0];
        if (1 - lvl >= x) { hit++; break; }
      }
    }
    odds[T] = hit / sims;
  }
  return { ...st, odds, sampleMu: mu, sampleDays: draw.length, drift, missing: [] };
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
