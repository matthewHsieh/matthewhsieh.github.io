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

// ------------------------------------------------------------
// 到期損益：同一個到期別的幾腳要一起算
//
//   一腳一腳分開看，「賣出買權」永遠是無上限；但只要同時有一口履約價
//   更高的買進買權，上面那一段就被接住了——那是買權多頭價差，最大虧損
//   等於淨支出，一塊錢都不會多賠。把它報成「風險無上限」不只是講得太重，
//   **而是把一個他真的會拿來決定要不要減碼的數字講反了**。
//
//   不必去認「這是什麼策略」再查表。歐式選擇權組合的到期損益是
//   **分段線性的，轉折點只在履約價上**，所以極值只可能落在
//   ｛0、每一個履約價、右邊無限遠｝。右端看斜率就好：
//   買權的淨口數為正 → 獲利無上限，為負 → 虧損無上限，為 0 → 兩邊都封死。
//   左端不必管無限遠，指數最低就是 0。
//
//   **只能同一個到期別一起算。** 不同到期的組合（時間價差）在近月結算時
//   遠月還活著，不是一條到期損益線，硬算會得到看起來很安心的假數字。
//
//   還有兩件事這條線看不到，畫面上要講：保證金不等於最大虧損；
//   而且拆掉其中一腳，封頂就沒了。
// ------------------------------------------------------------
const optSign = (o) => (o.side === 'short' ? -1 : 1);
const optBasis = (o) => (isNum(o.cost) ? num(o.cost) : num(o.price));
const optQty = (o) => optSign(o) * num(o.lots) * num(o.size ?? OPT_SIZE);
const legValue = (o, s) => Math.max(0, o.cp === 'put' ? num(o.strike) - s : s - num(o.strike));

// 指數收在 s 的話，這一組的到期損益（元）
export const optPnlAt = (legs, s) =>
  legs.reduce((a, o) => a + optQty(o) * (legValue(o, s) - optBasis(o)), 0);

function breakEvens(legs, strikes, slopeUp) {
  const pts = [0, ...strikes];
  // 最後一段還有斜率的話，要再往右探一點才抓得到穿越點
  if (Math.abs(slopeUp) > 1e-9) pts.push(strikes[strikes.length - 1] + 5000);
  const out = [];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i], b = pts[i + 1];
    const fa = optPnlAt(legs, a), fb = optPnlAt(legs, b);
    if (Math.abs(fa) < 1e-6) out.push(a);
    else if ((fa < 0) !== (fb < 0)) out.push(a + (b - a) * (-fa / (fb - fa)));
  }
  return [...new Set(out.map((x) => Math.round(x)))].sort((a, b) => a - b);
}

// 只認得出來的才講名字。認不出來就老實說幾腳，**不要猜**。
function strategyName(legs, strikes) {
  if (legs.length === 1) {
    const o = legs[0];
    return `${o.side === 'short' ? '賣出' : '買進'}${cpLabel(o.cp)}`;
  }
  if (legs.length !== 2) return `${legs.length} 腳組合`;
  const [a, b] = legs;
  if (num(a.lots) !== num(b.lots)) return '2 腳組合（口數不同）';
  if (a.side === b.side) {
    if (a.cp === b.cp) return '2 腳組合（同方向同類型）';
    const w = a.side === 'short' ? '賣出' : '買進';
    return strikes.length === 1 ? `${w}跨式` : `${w}勒式`;
  }
  if (a.cp !== b.cp) return '2 腳組合（一買權一賣權）';
  const long = a.side !== 'short' ? a : b;
  const short = a.side !== 'short' ? b : a;
  if (a.cp === 'call') return num(long.strike) < num(short.strike) ? '買權多頭價差' : '買權空頭價差';
  return num(long.strike) > num(short.strike) ? '賣權空頭價差' : '賣權多頭價差';
}

export function optStrategy(legs) {
  const list = (legs || []).filter((o) => num(o.lots) > 0 && num(o.strike) > 0);
  if (!list.length) return null;
  const strikes = [...new Set(list.map((o) => num(o.strike)))].sort((a, b) => a - b);
  // 右端斜率：賣權在無限遠一定歸零，所以只看買權
  const slopeUp = list.reduce((a, o) => a + (o.cp === 'put' ? 0 : optQty(o)), 0);

  let best = -Infinity, worst = Infinity, bestAt = null, worstAt = null;
  for (const s of [0, ...strikes]) {
    const v = optPnlAt(list, s);
    if (v > best) { best = v; bestAt = s; }
    if (v < worst) { worst = v; worstAt = s; }
  }

  const upUnlimited = slopeUp > 1e-9;
  const downUnlimited = slopeUp < -1e-9;
  return {
    legs: list.length,
    strikes,
    // null 代表沒有上限
    maxGain: upUnlimited ? null : best,
    maxLoss: downUnlimited ? null : worst,          // 負數
    gainAt: upUnlimited ? null : bestAt,
    lossAt: downUnlimited ? null : worstAt,
    // 正數 = 淨支出（付出去的權利金），負數 = 淨收取
    debit: list.reduce((a, o) => a + optQty(o) * optBasis(o), 0),
    breakEvens: breakEvens(list, strikes, slopeUp),
    name: strategyName(list, strikes),
  };
}

// 按到期別分組，每組各算一條到期損益線
export function optStrategies(legs) {
  const by = new Map();
  for (const o of legs || []) {
    const k = String(o.expiry || '');
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(o);
  }
  return [...by.entries()]
    .map(([expiry, list]) => ({ expiry, ...optStrategy(list) }))
    .filter((x) => x.legs)
    .sort((a, b) => a.expiry.localeCompare(b.expiry));
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

// ------------------------------------------------------------
// 期貨的交割月份
//
//   **最後交易日 = 交割月份的第三個星期三**，最後結算日與它同一天
//   （臺灣期交所股票期貨與臺股期貨契約規格皆同）。
//   遇國定假日順延到次一營業日——**台灣的假日表這裡沒有**，
//   所以算出來的日期在極少數情況下會早一天，畫面上要講清楚是「約」。
//
//   掛牌月份：交易當月起連續 2 個月，再加上 3、6、9、12 月中
//   3 個接續季月，共 5 個。下拉選單就照這個給。
// ------------------------------------------------------------
export const ymOf = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;

export const ymAdd = (ym, n) => {
  const y = Number(String(ym).slice(0, 4)), m = Number(String(ym).slice(4, 6));
  const d = new Date(y, m - 1 + n, 1);
  return ymOf(d);
};

// 該月第三個星期三
export function futSettleDate(ym) {
  const y = Number(String(ym).slice(0, 4)), m = Number(String(ym).slice(4, 6));
  if (!y || !m) return null;
  const first = new Date(y, m - 1, 1);
  // 0=日 1=一 2=二 3=三…，往後推到第一個星期三，再加兩週
  const firstWed = 1 + ((3 - first.getDay() + 7) % 7);
  return new Date(y, m - 1, firstWed + 14);
}

const dateISO = (d) => (d
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  : null);

export const futSettleISO = (ym) => dateISO(futSettleDate(ym));

// 剩幾天（含今天算 0）。負數代表已經過了最後交易日。
export function futDaysLeft(ym) {
  const d = futSettleDate(ym);
  if (!d) return null;
  const t = new Date(todayISO() + 'T00:00:00');
  return Math.round((d - t) / 86400000);
}

// 「10月倉」。跨年的話要把年份講出來，不然 1 月倉分不出是明年還是去年。
export function futMonthLabel(ym) {
  const v = String(ym || '');
  if (!/^\d{6}$/.test(v)) return '';
  const y = Number(v.slice(0, 4)), m = Number(v.slice(4, 6));
  return y === new Date().getFullYear() ? `${m}月倉` : `${y}/${m}月倉`;
}

// 目前的近月：今天過了第三個星期三就換下一個月
export function frontMonth() {
  const now = new Date(todayISO() + 'T00:00:00');
  const cur = ymOf(now);
  const d = futSettleDate(cur);
  return d && now > d ? ymAdd(cur, 1) : cur;
}

// 掛牌中的 5 個月份：連續兩個月 ＋ 之後 3 個季月
export function futMonths() {
  const a = frontMonth();
  const out = [a, ymAdd(a, 1)];
  let probe = a;
  while (out.length < 5) {
    probe = ymAdd(probe, 1);
    const m = Number(probe.slice(4, 6));
    if (m % 3 === 0 && !out.includes(probe)) out.push(probe);
  }
  return out;
}

// ------------------------------------------------------------
// 選擇權的到期別
//
//   代碼直接沿用期交所「契約月份(週別)」欄位，三種寫法：
//     202609      月選 —— 該月的第三個星期三
//     202609W2    週三到期 —— 該月的第 2 個星期三
//     202609F3    週五到期 —— 該月的第 3 個星期五
//
//   **沒有 W3。** 第三個星期三是月選自己，週三型的週選就跳過那一週，
//   所以 2026 年 9 月只掛得出 W1 W2 W4 W5。
//   算得出最後交易日才知道哪一張「今天就結算」，
//   也才擋得掉下拉選單裡早就到期的合約。
// ------------------------------------------------------------
function nthDow(y, m, dow, n) {
  if (!y || !m || !n) return null;
  const first = new Date(y, m - 1, 1);
  const day1 = 1 + ((dow - first.getDay() + 7) % 7);
  const d = new Date(y, m - 1, day1 + (n - 1) * 7);
  // 第 5 個星期五不見得存在，跨出去就不是這個月了
  return d.getMonth() === m - 1 ? d : null;
}

export function optSettleISO(expiry) {
  const m = String(expiry || '').trim().toUpperCase().match(/^(\d{4})(\d{2})(?:([WF])(\d))?$/);
  if (!m) return null;
  if (!m[3]) return futSettleISO(m[1] + m[2]);   // 月選跟期貨同一天結算
  return dateISO(nthDow(Number(m[1]), Number(m[2]), m[3] === 'F' ? 5 : 3, Number(m[4])));
}

// 剩幾個日曆天（今天到期回 0，負數代表已經過了最後交易日）
export function optDaysLeft(expiry, onISO) {
  const s = optSettleISO(expiry);
  if (!s) return null;
  return Math.round((Date.parse(s + 'T00:00:00') - Date.parse((onISO || todayISO()) + 'T00:00:00')) / 86400000);
}

export const optExpired = (expiry, onISO) => {
  const d = optDaysLeft(expiry, onISO);
  return d === null ? false : d < 0;
};

// 「9/18 到期」。算不出來就不要瞎掰，回空字串。
export function optExpiryLabel(expiry, onISO) {
  const s = optSettleISO(expiry);
  if (!s) return '';
  const left = optDaysLeft(expiry, onISO);
  const md = `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;
  if (left < 0) return `${md} 已到期`;
  return left === 0 ? `${md} 今天結算` : `${md} 到期`;
}

// 遠期指數（判斷價內價外的基準）
//
//   **不能直接拿該到期別自己的 forward 就用。** optExpiries 裡混著已經
//   到期的合約，它的報價停在最後交易日那天——FWD|202609F2 停在 9/11 的
//   41200，拿來跟 45500 的履約價比，會算出「價外 10%」，
//   而正確答案是價內 1%。判斷剛好會反過來。
//
//   所以先看最新那一批報價，取中位數當「現在的指數」；
//   只有這個到期別自己也在最新那一批裡，才用它自己的遠期價。
export function optForwardInfo(expiry) {
  const list = (state.optExpiries || []).filter((e) => isNum(e.forward) && num(e.forward) > 0);
  if (!list.length) return null;
  const newest = list.reduce((a, e) => (String(e.as_of) > a ? String(e.as_of) : a), '');
  const fresh = list.filter((e) => String(e.as_of) === newest);
  const mine = fresh.find((e) => String(e.expiry) === String(expiry));
  if (mine) return { value: num(mine.forward), as_of: newest };
  const xs = fresh.map((e) => num(e.forward)).sort((a, b) => a - b);
  return xs.length ? { value: xs[Math.floor(xs.length / 2)], as_of: newest } : null;
}

export const optForward = (expiry) => optForwardInfo(expiry)?.value ?? null;

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

// ------------------------------------------------------------
// 槓桿型美股 ETF
//
//   MUU 是「Direxion Daily MU Bull 2X」——買 US$3,143 承受的是 MU 的
//   US$6,286 波動。**曝險要乘倍數，資產價值不能乘**：賣掉只拿得回市值。
//   跟期貨「名目 vs 權益」是同一回事。
//
//   倍數優先用使用者自己填的（us_stocks.leverage），沒填就從名稱推。
//   發行商的命名其實很固定，兩種寫法都要認：
//     數字      Bull 2X / 2X Long / Bear 1X / 3X Shares
//     ProShares Ultra = 2、UltraPro = 3，不寫數字
//   **推不出來就回 1，而且畫面上要把推出來的倍數標出來**——
//   標出來使用者才看得到推錯了，默默算錯是最糟的。
// ------------------------------------------------------------
export function usLeverage(u) {
  if (isNum(u?.leverage)) return num(u.leverage);
  const nm = String(u?.name || '');
  if (!nm) return 1;

  // ProShares 把倍數寫成字，而且 Short 是黏在一起的（UltraShort、UltraPro Short）。
  // 這幾個不能靠詞邊界去切——"UltraShort" 裡的 ultra 與 short 中間沒有邊界。
  if (/ultra\s*pro\s*short/i.test(nm)) return -3;
  if (/ultra\s*short/i.test(nm)) return -2;
  if (/ultra\s*pro/i.test(nm)) return 3;

  // 其餘看數字：Bull 2X / 2X Long / Bear 1X / 3X Shares
  const digit = nm.match(/(?:^|[\s(-])(\d(?:\.\d)?)\s*[xX]\b/);
  if (digit) {
    const x = Number(digit[1]);
    if (!Number.isFinite(x) || x <= 0) return 1;
    // **方向只在真的找到倍數時才判斷。**
    // 不然 iShares Short Treasury Bond 這種名字裡有 short 的債券 ETF
    // 會被當成反向，倍數標成 -1X。
    return /\b(bear|short|inverse)\b/i.test(nm) ? -x : x;
  }
  if (/\bultra\b/i.test(nm)) return 2;
  return 1;
}

// 曝險取絕對值：反向 ETF 一樣有部位風險，跟期貨空單的算法一致
export const usExposureUsd = (u) => num(u.shares) * num(u.price_usd) * Math.abs(usLeverage(u));

// 1 倍的不用標，標了只是雜訊
export const usLevLabel = (u) => {
  const x = usLeverage(u);
  return Math.abs(x) === 1 && x > 0 ? '' : `${x < 0 ? '-' : ''}${Math.abs(x)}X`;
};
