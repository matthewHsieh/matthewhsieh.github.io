import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { donutChart, lineChart, barChart } from './charts.js';

// ============================================================
// 初始化
// ============================================================
const configured =
  /^https:\/\/.+\.supabase\.co$/.test(SUPABASE_URL) && !SUPABASE_ANON_KEY.startsWith('YOUR-');
const sb = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const DEFAULT_SETTINGS = { target_amount: 0, usd_twd: 32 };

const state = {
  user: null,
  tab: 'overview',
  authMode: 'login',
  settings: { ...DEFAULT_SETTINGS },
  stocks: [],
  futures: [],
  us: [],
  balances: [],
  options: [],
  optExpiries: [],
  warrants: [],
  ivHistory: [],
  themeTrend: [],
  themeMembers: [],
  openTheme: null,
  snapshots: [], // 依日期由新到舊
  trades: [],    // 依日期、建立時間由新到舊
  priceInfo: null,
  priceStatus: [],
  donutMode: (() => { try { return localStorage.getItem('donutMode') || 'assets'; } catch { return 'assets'; } })(),
};

// ============================================================
// 小工具
// ============================================================
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? 0 : Number(v));
const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const fmt = (v, d = 0) =>
  isNum(v) ? Number(v).toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–';
const fmtMax = (v, d = 2) => (isNum(v) ? Number(v).toLocaleString('zh-TW', { maximumFractionDigits: d }) : '–');
const fmtX = (v) => (isNum(v) ? Number(v).toFixed(2) + 'x' : '–');
const pct = (v) => (isNum(v) ? (Number(v) * 100).toFixed(1) + '%' : '–');
const signed = (v, d = 0) => (isNum(v) ? (v > 0 ? '+' : '') + fmt(v, d) : '–');
const plClass = (v) => (v > 0 ? 'gain' : v < 0 ? 'loss' : '');
const sum = (arr, f) => arr.reduce((acc, x) => acc + num(f(x)), 0);
const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const norm = (s) => String(s ?? '').trim().toUpperCase();
const sameSymbol = (a, b) => norm(a) === norm(b);
const btrimEq = (a, b) => String(a ?? '').trim() === String(b ?? '').trim();
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
// 圖表座標軸用的精簡數字：1,234,567 → 123.5萬
const fmtCompact = (v) => {
  if (!isNum(v)) return '–';
  const a = Math.abs(v);
  if (a >= 1e8) return (v / 1e8).toFixed(1) + '億';
  if (a >= 1e4) return (v / 1e4).toFixed(a >= 1e6 ? 0 : 1) + '萬';
  return fmt(v);
};

let toastTimer;
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}
function fail(err) {
  console.error(err);
  toast('錯誤：' + (err?.message || err), 4000);
}

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
const indexProduct = (sym) => INDEX_FUTURES.find((p) => p.symbol === norm(sym));

// 台指選擇權：每點 50 元
const OPT_SIZE = 50;
const cpLabel = (cp) => (cp === 'put' ? '賣權' : '買權');
const strikeText = (k) => String(num(k));
const optLabel = (o) =>
  `TXO ${esc(o.expiry)} ${strikeText(o.strike)} ${cpLabel(o.cp)}`;

// 權利金市值：買方為正（資產），賣方為負（負債）
const optValue = (o) => num(o.lots) * num(o.price) * num(o.size ?? OPT_SIZE) * (o.side === 'short' ? -1 : 1);
// delta 曝險（帶方向）：賣方要反號
const optDeltaExp = (o) =>
  isNum(o.delta) && isNum(o.forward)
    ? num(o.lots) * num(o.delta) * num(o.forward) * num(o.size ?? OPT_SIZE) * (o.side === 'short' ? -1 : 1)
    : null;
// 未實現損益
const optPl = (o) =>
  isNum(o.cost)
    ? (num(o.price) - num(o.cost)) * num(o.lots) * num(o.size ?? OPT_SIZE) * (o.side === 'short' ? -1 : 1)
    : null;
// 最大風險：買方最多賠光權利金；賣方賣權賠到履約價歸零；賣方買權沒有上限
function optMaxRisk(o) {
  const size = num(o.size ?? OPT_SIZE), lots = num(o.lots);
  const basis = isNum(o.cost) ? num(o.cost) : num(o.price);
  if (o.side !== 'short') return { value: lots * basis * size, unlimited: false };
  if (o.cp === 'put') return { value: Math.max(0, num(o.strike) - basis) * lots * size, unlimited: false };
  return { value: null, unlimited: true };
}

// 權證：1 張 = 1000 單位；每單位可換 ratio 股標的
const WAR_UNITS = 1000;
const ivSince = () => {
  const d = new Date(Date.now() - 60 * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
// 發行券商調降隱波是權證買方最大的隱形損失，delta 抓不到，只能靠逐日比對
function ivChange(code) {
  const rows = state.ivHistory.filter((r) => norm(r.code) === norm(code) && isNum(r.iv));
  if (rows.length < 2) return null;
  const first = num(rows[0].iv), last = num(rows[rows.length - 1].iv);
  return { first, last, diff: last - first, days: rows.length };
}
const warLabel = (w) => `${esc(w.code)} ${esc(w.name || '')}`.trim();
const warDelta = (w) => (isNum(w.delta_override) ? num(w.delta_override) : isNum(w.delta) ? num(w.delta) : null);
// 市值：權證只能做買方，一定是正的
const warValue = (w) => num(w.lots) * WAR_UNITS * num(w.price);
// delta 曝險 = 張數 × 1000 × 行使比例 × delta × 標的股價
const warExposure = (w) => {
  const d = warDelta(w);
  return d === null || !isNum(w.ratio) || !isNum(w.underlying_price)
    ? null : num(w.lots) * WAR_UNITS * num(w.ratio) * d * num(w.underlying_price);
};
const warPl = (w) => (isNum(w.cost) ? (num(w.price) - num(w.cost)) * num(w.lots) * WAR_UNITS : null);
// 買方最大損失就是付出的權利金
const warMaxRisk = (w) => (isNum(w.cost) ? num(w.cost) : num(w.price)) * num(w.lots) * WAR_UNITS;
// 剩餘交易日（粗估）
const warDaysLeft = (w) => {
  if (!w.last_trade_date) return null;
  const d = Math.round((new Date(w.last_trade_date + 'T00:00:00') - new Date(todayISO() + 'T00:00:00')) / 86400000);
  return Number.isFinite(d) ? d : null;
};
// 模型只對一般型成立；界限型、重設型要靠手動填 delta
const warModelOk = (w) => !w.category || w.category.includes('一般型');

// 個股期貨規格：曝險等同的現股股數
const STOCK_FUT_SIZES = [
  { size: 2000, label: '大型（2 張 ＝ 2,000 股）' },
  { size: 100,  label: '小型（100 股）' },
];
const stockFutLabel = (size) => (num(size) === 100 ? '小' : '大');

// 台股代號 → 名稱
let TW_STOCKS = {};
let TW_ENTRIES = [];
async function loadTwStocks() {
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
function resolveTwSymbol(input) {
  const q = norm(input);
  if (!q) return q;
  if (TW_STOCKS[q]) return q;                       // 本來就是代號
  const exact = TW_ENTRIES.filter(([, n]) => n === String(input).trim());
  if (exact.length === 1) return exact[0][0];
  const partial = TW_ENTRIES.filter(([, n]) => n.includes(String(input).trim()));
  if (partial.length === 1) return partial[0][0];
  return q;                                         // 解析不出來就原樣保留
}

const LOOKUPS = {
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
function attachLookup(input, kind, onPick) {
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
function futNotional(f) {
  return num(f.lots) * num(f.price) * num(f.size);
}
// 期貨損益：多單 (現價 − 成本)、空單 (成本 − 現價)，再乘口數與規格
// 沒填成本就回 null（跟股票一樣不顯示損益）
function futPl(f) {
  if (!isNum(f.cost)) return null;
  const diff = f.side === 'short' ? num(f.cost) - num(f.price) : num(f.price) - num(f.cost);
  return diff * num(f.lots) * num(f.size);
}

// 代號對得上行情來源，價格才會每天自動更新
const twKnown = (sym) => !!TW_STOCKS[norm(sym)];
const autoPriceOk = (f) => (f.kind === 'stock' ? twKnown(f.symbol) : !!indexProduct(f.symbol));

// ------------------------------------------------------------
// 當沖：同一天、同一標的既有買也有賣
// 直接用交易紀錄判斷，不另外存欄位，刪掉交易後判定也會跟著正確
// ------------------------------------------------------------
const tradeKey = (t) =>
  t.market === 'option'
    ? `${t.trade_date}|option|${String(t.opt_expiry ?? '').trim()}|${num(t.opt_strike)}|${t.opt_cp ?? ''}`
    // 台股與個股期貨都用解析後的代號，中文名稱與代號才不會被當成兩個標的
    : `${t.trade_date}|${t.market}|${
        t.market === 'tw' || t.fut_kind === 'stock' ? resolveTwSymbol(t.symbol) : norm(t.symbol)
      }|${t.fut_kind ?? ''}|${num(t.fut_size)}`;

// 只認明確勾選的當沖。
// 早期用「同一天同標的有買有賣」推斷，但那會把同一天的一般平倉也誤判成當沖，
// 例如當沖 1 口的同時又賣掉 5 口長期部位。
function dayTradeKeys(trades) {
  return new Set(trades.filter((t) => t.is_day_trade).map(tradeKey));
}

// ------------------------------------------------------------
// 交易成本
//   稅率是法定的，寫死在這裡（查證日期 2026-09-08）：
//     台股賣出 0.3%；當沖賣出 0.15%（已延長至 2027-12-31）
//     權證賣出 0.1%
//     股價類期貨（含台指期、個股期貨）契約金額 0.002%，買賣各一次
//     選擇權 權利金 0.1%，買賣各一次
//   手續費因人而異，放在「設定」可以改。
// ------------------------------------------------------------
const TAX = {
  stock: 0.003,
  stockDay: 0.0015,
  warrant: 0.001,
  futures: 0.00002,
  option: 0.001,
};
const DEFAULT_FEES = {
  fee_stock_rate: 0.001425, fee_stock_disc: 0.3, fee_min: 20,
  fee_warrant_disc: 1,
  fee_fut_per_lot: 30,   // 期貨每口，買賣各收一次
  fee_opt_per_lot: 25,   // 選擇權每口，買賣各收一次
  fee_us_rate: 0.001, fee_us_min: 0,   // 複委託買賣各 0.1%
};
const feeCfg = (k) => {
  const v = state.settings[k];
  return isNum(v) ? num(v) : DEFAULT_FEES[k];
};

// 回傳這一筆交易的手續費與交易稅（台幣；美股回傳美金，另有 ccy 標示）
function tradeCost(t, isDay) {
  const qty = num(t.quantity), px = num(t.price);
  if (!(qty > 0) || !(px > 0)) return { fee: 0, tax: 0, total: 0, ccy: 'TWD' };

  if (t.market === 'tw') {
    const amount = qty * px;
    // 手續費折數是跟券商談的，不分當沖或波段
    const fee = Math.max(feeCfg('fee_min'), amount * feeCfg('fee_stock_rate') * feeCfg('fee_stock_disc'));
    // 當沖影響的只有政府的證交稅：減半
    const tax = t.side === 'sell' ? amount * (isDay ? TAX.stockDay : TAX.stock) : 0;
    return { fee, tax, total: fee + tax, ccy: 'TWD' };
  }
  if (t.market === 'warrant') {
    const amount = qty * WAR_UNITS * px;
    const fee = Math.max(feeCfg('fee_min'), amount * feeCfg('fee_stock_rate') * feeCfg('fee_warrant_disc'));
    const tax = t.side === 'sell' ? amount * TAX.warrant : 0;
    return { fee, tax, total: fee + tax, ccy: 'TWD' };
  }
  if (t.market === 'futures') {
    const notional = qty * px * num(t.fut_size);
    const fee = qty * feeCfg('fee_fut_per_lot');   // 每口每邊，買賣各收一次
    const tax = notional * TAX.futures;          // 買賣各課一次
    return { fee, tax, total: fee + tax, ccy: 'TWD' };
  }
  if (t.market === 'option') {
    const premium = qty * px * OPT_SIZE;
    const fee = qty * feeCfg('fee_opt_per_lot');   // 每口每邊，買賣各收一次
    const tax = premium * TAX.option;            // 買賣各課一次
    return { fee, tax, total: fee + tax, ccy: 'TWD' };
  }
  if (t.market === 'us') {
    const amount = qty * px;
    const rate = feeCfg('fee_us_rate');
    const fee = rate > 0 ? Math.max(feeCfg('fee_us_min'), amount * rate) : 0;
    return { fee, tax: 0, total: fee, ccy: 'USD' };
  }
  return { fee: 0, tax: 0, total: 0, ccy: 'TWD' };
}

// 成本換算成台幣
const costTwd = (t, isDay) => {
  const c = tradeCost(t, isDay);
  return c.total * (c.ccy === 'USD' ? num(state.settings.usd_twd) : 1);
};

// 已實現損益：美股用目前匯率換算成台幣
const realizedTwd = (t) =>
  isNum(t.realized_pl) ? num(t.realized_pl) * (t.realized_ccy === 'USD' ? num(state.settings.usd_twd) : 1) : null;

// 當沖用「先進先出」配對，一趟來回算一組。
// 不能把整天的買賣平均在一起：同一檔一天來回兩趟，一趟賺一趟賠，
// 平均後只看得到淨數，看不出哪一趟做錯。
// 每一組的損益掛在「平倉的那一筆」上。
const dayMult = (t) =>
  t.market === 'futures' ? num(t.fut_size)
  : t.market === 'option' ? OPT_SIZE
  : t.market === 'warrant' ? WAR_UNITS : 1;

function matchDayTrades(trades, extra) {
  const byKey = new Map();
  const push = (t) => {
    const k = tradeKey(t);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(t);
  };
  for (const t of trades) if (t.is_day_trade) push(t);
  if (extra) push(extra);

  const perTrade = new Map();   // trade.id -> 這一筆平掉的那一組
  const openLeft = new Map();   // key -> 還沒沖銷掉的數量
  for (const [k, list] of byKey) {
    // 用純字串比較，不要用 localeCompare：它會把符號排在數字前面
    list.sort((a, b) => {
      const x = String(a.created_at ?? '￿'), y = String(b.created_at ?? '￿');
      return x < y ? -1 : x > y ? 1 : 0;
    });
    const queue = [];           // 尚未沖銷的開倉腿，先進先出
    for (const t of list) {
      let left = num(t.quantity);
      const mult = dayMult(t);
      let pl = 0, matched = 0, basis = 0;
      while (left > 1e-9 && queue.length && queue[0].side !== t.side) {
        const head = queue[0];
        const take = Math.min(left, head.qty);
        const per = t.side === 'sell' ? num(t.price) - head.price : head.price - num(t.price);
        pl += per * take * mult;
        basis += head.price * take;
        matched += take;
        head.qty -= take;
        left -= take;
        if (head.qty <= 1e-9) queue.shift();
      }
      if (matched > 0) {
        perTrade.set(t.id ?? '__new__', {
          pl, qty: matched, openAvg: basis / matched,
          ccy: t.market === 'us' ? 'USD' : 'TWD',
        });
      }
      if (left > 1e-9) queue.push({ side: t.side, qty: left, price: num(t.price) });
    }
    openLeft.set(k, sum(queue, (x) => x.qty));
  }
  return { perTrade, openLeft };
}

function realizedSummary() {
  const { perTrade, openLeft } = matchDayTrades(state.trades);
  const byDate = new Map();
  const add = (d, v) => byDate.set(d, (byDate.get(d) || 0) + v);
  const twd = (v, ccy) => v * (ccy === 'USD' ? num(state.settings.usd_twd) : 1);
  let gross = 0, dayNet = 0, swingNet = 0, closes = 0, cost = 0;

  for (const t of state.trades) {
    // 損益：當沖看 FIFO 配對結果，其餘看當初存下來的值
    let v = null;
    if (t.is_day_trade) {
      const m = perTrade.get(t.id);
      if (m) v = twd(m.pl, m.ccy);
    } else {
      v = realizedTwd(t);
    }
    if (v !== null) {
      closes += 1; gross += v;
      if (t.is_day_trade) dayNet += v; else swingNet += v;
      add(t.trade_date, v);
    }
    // 成本：每一筆都算，買進也有手續費
    const c = costTwd(t, !!t.is_day_trade);
    cost += c;
    add(t.trade_date, -c);
    if (t.is_day_trade) dayNet -= c; else swingNet -= c;
  }

  const dates = [...byDate.keys()].sort();
  let cum = 0;
  const series = dates.map((d) => { cum += byDate.get(d); return { date: d, daily: byDate.get(d), cum }; });
  return { gross, cost, total: gross - cost, day: dayNet, swing: swingNet, closes, series,
           dayKeys: dayTradeKeys(state.trades), perTrade, openLeft };
}

// 曝險明細：每一檔股票、每一筆期貨、每一檔美股各算一塊
// 依金額由大到小排，前 7 名各給一個顏色，其餘合併成「其他」
const POS_COLORS = ['var(--pos-1)', 'var(--pos-2)', 'var(--pos-3)', 'var(--pos-4)', 'var(--pos-5)', 'var(--pos-6)', 'var(--pos-7)'];
const POS_MAX = POS_COLORS.length;

function exposureSlices() {
  const rate = num(state.settings.usd_twd);
  const items = [];
  for (const s of state.stocks) {
    const v = num(s.shares) * num(s.price);
    if (v > 0) items.push({ label: `${norm(s.symbol)} ${s.name || ''}`.trim(), sub: '台股', value: v });
  }
  for (const f of state.futures) {
    const v = futNotional(f);
    if (v > 0) items.push({
      label: f.contract || futDisplayName(f.kind, f.symbol, f.size),
      sub: (f.kind === 'stock' ? `個股期・${stockFutLabel(f.size)}型` : '指數期') + (f.side === 'short' ? '・空單' : ''),
      value: v,
    });
  }
  for (const u of state.us) {
    const v = num(u.shares) * num(u.price_usd) * rate;
    if (v > 0) items.push({ label: `${norm(u.symbol)} ${u.name || ''}`.trim(), sub: '複委託', value: v });
  }
  for (const w of state.warrants) {
    const v = Math.abs(warExposure(w) ?? 0);
    if (v > 0) items.push({
      label: warLabel(w),
      sub: `權證・${w.cp === 'put' ? '認售' : '認購'}（delta 曝險）`,
      value: v,
    });
  }
  for (const o of state.options) {
    const v = Math.abs(optDeltaExp(o) ?? 0);
    if (v > 0) items.push({
      label: optLabel(o),
      sub: `選擇權・${o.side === 'short' ? '賣方' : '買方'}（delta 曝險）`,
      value: v,
    });
  }
  items.sort((a, b) => b.value - a.value);
  const out = items.slice(0, POS_MAX).map((it, i) => ({ ...it, color: POS_COLORS[i] }));
  const rest = items.slice(POS_MAX);
  if (rest.length) {
    out.push({ label: `其他 ${rest.length} 筆`, sub: '', value: sum(rest, (r) => r.value), color: 'var(--pos-other)' });
  }
  return out;
}

function compute() {
  const { settings, stocks, futures, us, balances } = state;
  const rate = num(settings.usd_twd);

  const stockValue = sum(stocks, (s) => num(s.shares) * num(s.price));
  const stockCost = sum(stocks, (s) => num(s.shares) * (isNum(s.cost) ? num(s.cost) : num(s.price)));

  const usValueUsd = sum(us, (s) => num(s.shares) * num(s.price_usd));
  const usCostUsd = sum(us, (s) => num(s.shares) * (isNum(s.cost_usd) ? num(s.cost_usd) : num(s.price_usd)));
  const usValue = usValueUsd * rate;

  const longs = futures.filter((f) => f.side !== 'short');
  const shorts = futures.filter((f) => f.side === 'short');
  const futLong = sum(longs, futNotional);
  const futShort = sum(shorts, futNotional);
  const futGross = futLong + futShort;
  const futNet = futLong - futShort;
  const futIndex = sum(futures.filter((f) => f.kind !== 'stock'), futNotional);
  const futStock = sum(futures.filter((f) => f.kind === 'stock'), futNotional);
  const withCost = futures.filter((f) => isNum(f.cost));
  const futProfit = withCost.length ? sum(withCost, futPl) : null;

  // 選擇權
  const opts = state.options;
  const optMarket = sum(opts, optValue);                       // 權利金市值（買方正、賣方負）
  const optExposure = opts.reduce((a, o) => a + Math.abs(optDeltaExp(o) ?? 0), 0);  // 曝險取絕對值加總
  const optNetDelta = opts.reduce((a, o) => a + (optDeltaExp(o) ?? 0), 0);          // 淨方向部位
  const optWithPl = opts.filter((o) => isNum(o.cost));
  const optProfit = optWithPl.length ? sum(optWithPl, optPl) : null;
  const optRisks = opts.map(optMaxRisk);
  const optRiskUnlimited = optRisks.some((r) => r.unlimited);
  const optMaxLoss = optRisks.reduce((a, r) => a + (r.value ?? 0), 0);
  const optNoDelta = opts.some((o) => !isNum(o.delta));

  // 權證
  const wars = state.warrants;
  const warMarket = sum(wars, warValue);
  const warExp = wars.reduce((a, w) => a + Math.abs(warExposure(w) ?? 0), 0);
  const warWithPl = wars.filter((w) => isNum(w.cost));
  const warProfit = warWithPl.length ? sum(warWithPl, warPl) : null;
  const warMaxLoss = sum(wars, warMaxRisk);
  const warTheta = sum(wars.filter((w) => isNum(w.theta_day)), (w) => num(w.theta_day) * num(w.lots) * WAR_UNITS);
  const warNoDelta = wars.some((w) => warDelta(w) === null);

  const toTwd = (b) => num(b.amount) * (b.currency === 'USD' ? rate : 1);
  const cash = sum(balances.filter((b) => b.kind === 'cash'), toTwd);
  const futEquity = sum(balances.filter((b) => b.kind === 'futures_equity'), toTwd);
  const liabilities = sum(balances.filter((b) => b.kind === 'liability'), toTwd);

  const totalAssets = stockValue + usValue + futEquity + cash + optMarket + warMarket;
  const netAssets = totalAssets - liabilities;
  const exposure = stockValue + usValue + futGross + optExposure + warExp;

  const leverageAsset = netAssets > 0 ? totalAssets / netAssets : NaN;
  // 曝險槓桿以「總資產」為分母：淨資產為負時仍算得出來
  const leverageExposure = totalAssets > 0 ? exposure / totalAssets : NaN;

  const target = num(settings.target_amount);
  const progress = target > 0 ? netAssets / target : NaN;

  return {
    rate, stockValue, stockCost, usValueUsd, usCostUsd, usValue,
    futEquity, futLong, futShort, futGross, futNet, futIndex, futStock, futProfit,
    optMarket, optExposure, optNetDelta, optProfit, optMaxLoss, optRiskUnlimited, optNoDelta,
    warMarket, warExp, warProfit, warMaxLoss, warTheta, warNoDelta,
    cash, liabilities, totalAssets, netAssets, exposure,
    leverageAsset, leverageExposure, target, progress,
  };
}

// ============================================================
// 交易 → 部位
// ============================================================
const MARKET_LABEL = { tw: '台股', futures: '期貨', us: '複委託' };
// 表單上的四個選項 → 資料庫欄位
const TRADE_KINDS = {
  tw:        { label: '台股',     market: 'tw' },
  fut_index: { label: '指數期貨', market: 'futures', fut_kind: 'index' },
  fut_stock: { label: '個股期貨', market: 'futures', fut_kind: 'stock' },
  option:    { label: '台指選擇權', market: 'option' },
  warrant:   { label: '權證',       market: 'warrant' },
  us:        { label: '複委託',   market: 'us' },
};
const tradeKindOf = (t) =>
  t.market === 'futures' ? (t.fut_kind === 'stock' ? 'fut_stock' : 'fut_index') : t.market;

function findPosition(t) {
  if (t.market === 'warrant') return state.warrants.find((w) => norm(w.code) === norm(t.symbol));
  if (t.market === 'option') {
    return state.options.find((o) =>
      btrimEq(o.expiry, t.opt_expiry) && num(o.strike) === num(t.opt_strike) && o.cp === t.opt_cp);
  }
  if (t.market === 'tw') return state.stocks.find((s) => sameSymbol(s.symbol, t.symbol));
  if (t.market === 'us') return state.us.find((s) => sameSymbol(s.symbol, t.symbol));
  const kind = t.fut_kind || 'index';
  return state.futures.find(
    (f) => (f.kind || 'index') === kind && sameSymbol(f.symbol, t.symbol) &&
           (kind === 'index' || num(f.size) === num(t.fut_size)));
}

function futDisplayName(kind, symbol, size) {
  if (kind === 'stock') {
    const nm = TW_STOCKS[norm(symbol)] || '';
    return `${norm(symbol)}${nm ? ' ' + nm : ''} ${stockFutLabel(size)}型個股期`;
  }
  return indexProduct(symbol)?.name || norm(symbol);
}

function newPositionRow(t) {
  if (t.market === 'warrant') return { code: norm(t.symbol), name: t.name || null, price: num(t.price) };
  if (t.market === 'option') {
    return { contract: 'TXO', expiry: String(t.opt_expiry).trim(), strike: num(t.opt_strike),
             cp: t.opt_cp, size: OPT_SIZE, price: num(t.price) };
  }
  if (t.market === 'futures') {
    const kind = t.fut_kind || 'index';
    const size = kind === 'stock' ? num(t.fut_size) || 2000 : indexProduct(t.symbol)?.size ?? 200;
    return { kind, symbol: kind === 'stock' ? norm(t.symbol) : norm(t.symbol), size,
             contract: futDisplayName(kind, t.symbol, size), price: num(t.price) };
  }
  if (t.market === 'us') return { symbol: norm(t.symbol), name: t.name || null, price_usd: num(t.price), cost_usd: null };
  return { symbol: norm(t.symbol), name: t.name || TW_STOCKS[norm(t.symbol)] || null, price: num(t.price), cost: null };
}

function fmtQty(market, q) {
  q = num(q);
  if (market === 'futures' || market === 'option') return `${fmtMax(q, 2)} 口`;
  if (market === 'warrant') return `${fmtMax(q, 2)} 張`;
  if (market === 'tw') return q !== 0 && q % 1000 === 0 ? `${fmt(q / 1000)} 張` : `${fmt(q)} 股`;
  return `${fmtMax(q, 4)} 股`;
}
const fmtNet = (net) => (net === 0 ? '無部位' : `${net > 0 ? '多' : '空'} ${fmtMax(Math.abs(net), 2)} 口`);

// 當沖：同一天的買與賣自己配對結算，完全不碰長期部位的股數與均價。
// 這是必要的，否則當沖一檔你本來就持有的股票，會把長期部位的均價拉歪，
// 已實現損益也會變成「賣價 − 混合後均價」而不是「賣價 − 當沖買價」。
function projectDayTrade(t) {
  const qty = num(t.quantity);
  if (!(qty > 0)) return { error: '數量必須大於 0' };
  // 把這一筆接在既有的當沖腿後面，用同一套先進先出邏輯試算
  const hypothetical = { ...t, id: '__new__', created_at: '￿' };   // 一定排在最後
  const { perTrade, openLeft } = matchDayTrades(state.trades, hypothetical);
  const m = perTrade.get('__new__');
  return {
    table: null, pos: null, after: null,          // 不動任何部位
    prevShares: null, prevCost: null,
    dayTrade: true,
    matched: m ? m.qty : 0,
    openAvg: m ? m.openAvg : null,
    openQty: openLeft.get(tradeKey(t)) ?? 0,
    realized: m ? m.pl : null,
    realizedCcy: t.market === 'us' ? 'USD' : 'TWD',
  };
}

// opts.reverse：刪除交易時反向調整，不動均價與現價
function projectTrade(t, opts = {}) {
  if (t.is_day_trade && !opts.reverse) return projectDayTrade(t);
  const qty = num(t.quantity);
  if (!(qty > 0)) return { error: '數量必須大於 0' };
  if (t.market === 'option') {
    if (!String(t.opt_expiry ?? '').trim() || !(num(t.opt_strike) > 0)) {
      return { error: '請選擇到期與履約價' };
    }
  } else if (!String(t.symbol ?? '').trim()) {
    return { error: '請輸入代號或商品' };
  }
  const dir = t.side === 'buy' ? 1 : -1;
  const pos = findPosition(t);

  if (t.market === 'option') {
    const prevNet = pos ? (pos.side === 'short' ? -num(pos.lots) : num(pos.lots)) : 0;
    const net = prevNet + dir * qty;
    const base = pos || newPositionRow(t);
    const prevCost = pos && isNum(pos.cost) ? num(pos.cost) : null;

    let newCost = prevCost;
    if (!opts.reverse && net !== 0) {
      if (prevNet === 0 || Math.sign(net) !== Math.sign(prevNet)) newCost = num(t.price);
      else if (Math.abs(net) > Math.abs(prevNet)) {
        const basis = prevCost ?? num(base.price);
        newCost = (Math.abs(prevNet) * basis + qty * num(t.price)) / Math.abs(net);
      }
    }
    const after = net === 0
      ? null
      : { ...base, side: net > 0 ? 'long' : 'short', lots: Math.abs(net),
          price: opts.reverse ? num(base.price) : num(t.price),
          cost: opts.reverse ? prevCost : newCost };

    // 已實現：平掉的口數 ×（權利金價差）× 50，賣方方向相反
    let realized = null;
    if (!opts.reverse && prevNet !== 0 && Math.sign(dir) !== Math.sign(prevNet) && isNum(prevCost)) {
      const closed = Math.min(qty, Math.abs(prevNet));
      const perUnit = prevNet > 0 ? num(t.price) - prevCost : prevCost - num(t.price);
      realized = perUnit * closed * OPT_SIZE;
    }
    return { table: 'options', pos, prevShares: prevNet, prevCost, after, prevNet, net,
             newCost: net === 0 ? null : newCost, realized, realizedCcy: 'TWD' };
  }

  if (t.market === 'futures') {
    const prevNet = pos ? (pos.side === 'short' ? -num(pos.lots) : num(pos.lots)) : 0;
    const net = prevNet + dir * qty;
    const base = pos || newPositionRow(t);
    const prevCost = pos && isNum(pos.cost) ? num(pos.cost) : null;

    // 平均成本：開新倉或翻多空 → 用本次成交價；同方向加碼 → 加權平均；減碼 → 不變
    let newCost = prevCost;
    if (!opts.reverse && net !== 0) {
      if (prevNet === 0 || Math.sign(net) !== Math.sign(prevNet)) {
        newCost = num(t.price);
      } else if (Math.abs(net) > Math.abs(prevNet)) {
        const basis = prevCost ?? num(base.price);
        newCost = (Math.abs(prevNet) * basis + qty * num(t.price)) / Math.abs(net);
      }
    }
    const after = net === 0
      ? null
      : { ...base, side: net > 0 ? 'long' : 'short', lots: Math.abs(net),
          price: opts.reverse ? num(base.price) : num(t.price),
          cost: opts.reverse ? prevCost : newCost };

    // 已實現損益：這一筆平掉了多少口，就用平掉的部分乘上與成本的價差
    let realized = null;
    if (!opts.reverse && prevNet !== 0 && Math.sign(dir) !== Math.sign(prevNet) && isNum(prevCost)) {
      const closed = Math.min(qty, Math.abs(prevNet));
      const perUnit = prevNet > 0 ? num(t.price) - prevCost : prevCost - num(t.price);
      realized = perUnit * closed * num(base.size);
    }
    return { table: 'futures', pos, prevShares: prevNet, prevCost, after, prevNet, net,
             newCost: net === 0 ? null : newCost, realized, realizedCcy: 'TWD' };
  }

  const isWar = t.market === 'warrant';
  const isUs = t.market === 'us';
  const priceKey = isUs ? 'price_usd' : 'price';
  const costKey = isUs ? 'cost_usd' : 'cost';
  const sharesKey = isWar ? 'lots' : 'shares';
  const prevShares = pos ? num(pos[sharesKey]) : 0;
  const prevCost = pos && isNum(pos[costKey]) ? num(pos[costKey]) : null;
  const newShares = prevShares + dir * qty;
  if (newShares < -1e-9) return { error: `賣出 ${fmtQty(t.market, qty)} 超過目前持有 ${fmtQty(t.market, prevShares)}` };

  let newCost = prevCost;
  if (dir > 0 && !opts.reverse) {
    const basis = prevCost ?? (pos ? num(pos[priceKey]) : num(t.price));
    newCost = (prevShares * basis + qty * num(t.price)) / newShares;
  }
  const gone = newShares <= 1e-9;
  const base = pos || newPositionRow(t);
  const after = gone
    ? null
    : { ...base, [sharesKey]: newShares, [priceKey]: opts.reverse ? num(base[priceKey]) : num(t.price), [costKey]: newCost };
  if (after && !after.name && t.name) after.name = t.name;

  // 已實現損益：賣出的部分 ×（成交價 − 平均成本）
  let realized = null;
  if (!opts.reverse && dir < 0 && prevShares > 0 && isNum(prevCost)) {
    realized = (num(t.price) - prevCost) * Math.min(qty, prevShares);
  }
  if (isWar && isNum(realized)) realized *= WAR_UNITS;   // 權證以「張」記，一張 1000 單位
  return { table: isWar ? 'warrants' : isUs ? 'us_stocks' : 'stocks',
           pos, prevShares, prevCost, after, newShares,
           newCost: gone ? null : newCost, realized, realizedCcy: isUs ? 'USD' : 'TWD' };
}

function restoreProjection(t) {
  const pos = findPosition(t);
  const prev = num(t.prev_shares);
  if (t.market === 'option') {
    const after = prev === 0
      ? null
      : { ...(pos || newPositionRow(t)), side: prev > 0 ? 'long' : 'short', lots: Math.abs(prev),
          cost: isNum(t.prev_cost) ? num(t.prev_cost) : null };
    return { table: 'options', pos, after };
  }
  if (t.market === 'futures') {
    const after = prev === 0
      ? null
      : { ...(pos || newPositionRow(t)), side: prev > 0 ? 'long' : 'short', lots: Math.abs(prev),
          cost: isNum(t.prev_cost) ? num(t.prev_cost) : null };
    return { table: 'futures', pos, after };
  }
  const isWar = t.market === 'warrant';
  const isUs = t.market === 'us';
  const costKey = isUs ? 'cost_usd' : 'cost';
  const sharesKey = isWar ? 'lots' : 'shares';
  const after = prev <= 1e-9
    ? null
    : { ...(pos || newPositionRow(t)), [sharesKey]: prev, [costKey]: isNum(t.prev_cost) ? num(t.prev_cost) : null };
  return { table: isWar ? 'warrants' : isUs ? 'us_stocks' : 'stocks', pos, after };
}

// 只有真的有變動才寫入；賣光才刪除
function changed(pos, after) {
  if (!pos) return true;
  return Object.keys(after).some((k) => {
    if (['id', 'user_id', 'created_at', 'updated_at'].includes(k)) return false;
    const a = after[k], b = pos[k];
    if (a === null || a === undefined) return !(b === null || b === undefined);
    if (typeof a === 'number' || (isNum(a) && isNum(b))) return Math.abs(num(a) - num(b)) > 1e-9;
    return String(a) !== String(b ?? '');
  });
}

async function writePosition({ table, pos, after }) {
  if (!table) return false;          // 當沖不動任何部位
  if (after) {
    if (!changed(pos, after)) return false;
    const payload = { ...after, user_id: state.user.id };
    if (pos) payload.id = pos.id;
    delete payload.created_at;
    delete payload.updated_at;
    const { error } = await sb.from(table).upsert(payload);
    if (error) throw error;
    return true;
  }
  if (pos) {
    const { error } = await sb.from(table).delete().eq('id', pos.id);
    if (error) throw error;
    return true;
  }
  return false;
}

async function saveTrade(v) {
  const proj = projectTrade(v);
  if (proj.error) return toast(proj.error, 3500);
  try {
    await writePosition(proj);
    const { error } = await sb.from('trades').insert({
      user_id: state.user.id,
      market: v.market, fut_kind: v.fut_kind ?? null, fut_size: v.fut_size ?? null,
      opt_expiry: v.opt_expiry ?? null, opt_strike: v.opt_strike ?? null, opt_cp: v.opt_cp ?? null,
      war_code: v.market === 'warrant' ? v.symbol : null,
      is_day_trade: !!v.is_day_trade,
      side: v.side, trade_date: v.trade_date, symbol: v.symbol, name: v.name,
      quantity: v.quantity, price: v.price, note: v.note,
      prev_shares: proj.prevShares, prev_cost: proj.prevCost,
      realized_pl: isNum(proj.realized) ? round2(proj.realized) : null,
      realized_ccy: isNum(proj.realized) ? proj.realizedCcy : null,
    });
    if (error) throw error;
    await refresh('交易已記錄，部位已更新');
  } catch (e) {
    fail(e);
  }
}

const tradeLabel = (t) =>
  `${t.trade_date} ${t.side === 'buy' ? '買' : '賣'} ${t.symbol} ${t.name || ''} ${fmtQty(t.market, t.quantity)} @ ${fmtMax(t.price, 2)}`;

async function deleteTrade(id) {
  const t = state.trades.find((x) => x.id === id);
  if (!t) return;
  if (!confirm(`刪除這筆交易並還原部位？\n${tradeLabel(t)}`)) return;
  if (t.is_day_trade) {
    const { error } = await sb.from('trades').delete().eq('id', id);
    if (error) return fail(error);
    return refresh('已刪除當沖紀錄');
  }
  const latest = state.trades.find((x) => {
    if (x.market !== t.market) return false;
    if (t.market === 'option') {
      return btrimEq(x.opt_expiry, t.opt_expiry) && num(x.opt_strike) === num(t.opt_strike) && x.opt_cp === t.opt_cp;
    }
    if (!sameSymbol(x.symbol, t.symbol)) return false;
    return t.market !== 'futures' || (x.fut_kind === t.fut_kind && num(x.fut_size) === num(t.fut_size));
  });
  const proj = latest?.id === t.id
    ? restoreProjection(t)
    : projectTrade({ ...t, side: t.side === 'buy' ? 'sell' : 'buy' }, { reverse: true });
  if (proj.error) return toast('無法還原：' + proj.error, 3500);
  try {
    await writePosition(proj);
    const { error } = await sb.from('trades').delete().eq('id', id);
    if (error) throw error;
    await refresh('已刪除交易並還原部位');
  } catch (e) {
    fail(e);
  }
}

// ============================================================
// 表單定義
// ============================================================
const BALANCE_KINDS = [['cash', '現金 / 存款'], ['futures_equity', '期貨帳戶權益數'], ['liability', '負債']];
const BALANCE_KIND_LABEL = Object.fromEntries(BALANCE_KINDS);

const ENTITIES = {
  stock: {
    table: 'stocks', key: 'stocks', title: '台股',
    fields: [
      { key: 'symbol', label: '代號', required: true, placeholder: '2330 或 台積', lookup: 'tw' },
      { key: 'name', label: '名稱', placeholder: '輸入代號會自動帶出' },
      { key: 'shares', label: '股數（1 張 = 1000 股）', type: 'number', required: true, placeholder: '1000' },
      { key: 'price', label: '現價（每日自動更新）', type: 'number', required: true },
      { key: 'cost', label: '平均成本（選填）', type: 'number' },
    ],
  },
  us: {
    table: 'us_stocks', key: 'us', title: '複委託',
    fields: [
      { key: 'symbol', label: '代號', required: true, placeholder: 'VOO' },
      { key: 'name', label: '名稱' },
      { key: 'shares', label: '股數', type: 'number', required: true },
      { key: 'price_usd', label: '現價 (USD，每日自動更新)', type: 'number', required: true },
      { key: 'cost_usd', label: '平均成本 (USD，選填)', type: 'number' },
    ],
  },
  balance: {
    table: 'balances', key: 'balances', title: '資金項目',
    fields: [
      { key: 'kind', label: '類型', type: 'select', options: BALANCE_KINDS },
      { key: 'name', label: '名稱', required: true, placeholder: '銀行活存 / 元大期貨 / 信貸' },
      { key: 'currency', label: '幣別', type: 'select', options: [['TWD', 'TWD'], ['USD', 'USD']] },
      { key: 'amount', label: '金額', type: 'number', required: true },
      { key: 'note', label: '備註' },
    ],
    defaults: { kind: 'cash', currency: 'TWD' },
  },
};

// ============================================================
// 資料存取
// ============================================================
async function loadAll() {
  const uid = state.user.id;
  const results = await Promise.all([
    sb.from('settings').select('*').eq('user_id', uid).maybeSingle(),
    sb.from('stocks').select('*').order('created_at'),
    sb.from('futures').select('*').order('created_at'),
    sb.from('us_stocks').select('*').order('created_at'),
    sb.from('balances').select('*').order('kind').order('created_at'),
    sb.from('snapshots').select('*').order('snap_date', { ascending: false }).limit(730),
    sb.from('trades').select('*').order('trade_date', { ascending: false }).order('created_at', { ascending: false }).limit(500),
    sb.from('options').select('*').order('expiry').order('strike'),
    sb.from('warrants').select('*').order('created_at'),
    sb.from('warrant_iv_history').select('code,as_of,iv').gte('as_of', ivSince()).order('as_of'),
    sb.from('market_prices').select('symbol,price,as_of').eq('market', 'opt').like('symbol', 'FWD|%'),
    sb.rpc('theme_trend', { p_months: 1 }),
    sb.rpc('theme_members', {}),
    sb.from('price_status').select('market,as_of,updated_at,symbols'),
  ]);
  for (const r of results) if (r.error && r.error.code !== '42P01') throw r.error;
  const [st, stocks, futures, us, balances, snaps, trades, opts, wars, ivh, fwds, trend, members, prices] = results;
  state.settings = st.data ? { ...DEFAULT_SETTINGS, ...st.data } : { ...DEFAULT_SETTINGS };
  state.stocks = stocks.data ?? [];
  state.futures = futures.data ?? [];
  state.us = us.data ?? [];
  state.balances = balances.data ?? [];
  state.snapshots = snaps.data ?? [];
  state.trades = trades.data ?? [];
  state.options = opts.data ?? [];
  state.warrants = wars.data ?? [];
  state.ivHistory = ivh.data ?? [];
  state.themeTrend = trend.data ?? [];
  state.themeMembers = members.data ?? [];
  state.optExpiries = (fwds.data ?? [])
    .map((r) => ({ expiry: String(r.symbol).split('|')[1], forward: num(r.price), as_of: r.as_of }))
    .sort((a, b) => a.expiry.localeCompare(b.expiry));
  state.priceStatus = prices.data ?? [];
  state.priceInfo = [...state.priceStatus].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0] ?? null;
}

async function refresh(msg) {
  try {
    await loadAll();
    render();
    if (msg) toast(msg);
  } catch (e) {
    fail(e);
  }
}

// 手動抓最新報價（平常不用按，每天會自動更新）
// 資料庫給前端呼叫的時間上限是 8 秒，七個來源一次跑完會超過，
// 所以一次只抓一項；某一項失敗也不影響其他項。
const REFRESH_STAGES = [
  ['tw', '台股'], ['fut', '指數期貨'], ['opt', '選擇權'],
  ['war', '權證'], ['fx', '匯率'], ['us', '美股'], ['sync', '套用到持倉'],
];

async function runStagedRefresh(onStage) {
  const done = [];
  for (const [kind, label] of REFRESH_STAGES) {
    if (onStage) onStage(label);
    try {
      const { data, error } = await sb.rpc('refresh_market', { p_kind: kind });
      if (error) throw error;
      done.push({ kind, label, ok: true, rows: data?.rows ?? 0 });
    } catch (e) {
      console.warn('refresh ' + kind, e);
      done.push({ kind, label, ok: false, msg: e?.message || String(e) });
    }
  }
  return done;
}

function refreshSummary(done) {
  const bad = done.filter((d) => !d.ok);
  if (!bad.length) return null;
  return bad.map((d) => d.label).join('、') + ' 更新失敗';
}

async function refreshPrices() {
  const btn = $('#refresh-btn');
  btn.classList.add('spin');
  try {
    const done = await runStagedRefresh((label) => toast('更新中：' + label, 8000));
    await loadAll();
    render();
    const bad = refreshSummary(done);
    toast(bad ? bad + '，其餘已更新' : `報價已更新（${statusOf('tw')?.as_of ?? ''}）`, bad ? 5000 : 2500);
  } catch (e) {
    fail(e);
  } finally {
    btn.classList.remove('spin');
  }
}

// 改完部位（尤其是改代號）就把已快取的行情套上去，不用等隔天排程
async function applyCachedPrices() {
  try { await sb.rpc('sync_my_positions'); } catch (e) { console.warn('sync_my_positions 失敗', e); }
}

async function editItem(kind, id, extraDefaults = {}) {
  const ent = ENTITIES[kind];
  const existing = id ? state[ent.key].find((x) => x.id === id) : null;
  const res = await openForm({
    title: (existing ? '編輯' : '新增') + ent.title,
    fields: ent.fields,
    values: existing || { ...(ent.defaults || {}), ...extraDefaults },
    allowDelete: !!existing,
  });
  if (!res) return;
  try {
    if (res.action === 'delete') {
      const { error } = await sb.from(ent.table).delete().eq('id', id);
      if (error) throw error;
      await refresh('已刪除');
    } else {
      const payload = { ...res.values, user_id: state.user.id };
      if (id) payload.id = id;
      const { error } = await sb.from(ent.table).upsert(payload);
      if (error) throw error;
      if (ent.table !== 'balances') await applyCachedPrices();
      await refresh('已儲存');
    }
  } catch (e) {
    fail(e);
  }
}

async function saveSnapshot() {
  const c = compute();
  const date = todayISO();
  const existing = state.snapshots.find((s) => s.snap_date === date);
  if (existing && existing.note !== 'auto' && !confirm(`今天（${date}）已有快照，要覆蓋嗎？`)) return;
  const payload = {
    user_id: state.user.id, snap_date: date,
    price_as_of: statusOf('tw')?.as_of ?? null,
    total_assets: round2(c.totalAssets), liabilities: round2(c.liabilities), net_assets: round2(c.netAssets),
    stock_value: round2(c.stockValue), us_value: round2(c.usValue),
    futures_margin: round2(c.futEquity), futures_notional: round2(c.futGross), cash: round2(c.cash),
    leverage_asset: round2(c.leverageAsset), leverage_exposure: round2(c.leverageExposure),
    target_amount: round2(c.target), note: null,
  };
  const { error } = await sb.from('snapshots').upsert(payload, { onConflict: 'user_id,snap_date' });
  if (error) return fail(error);
  await refresh('快照已儲存');
}

async function deleteSnapshot(id) {
  if (!confirm('刪除這筆快照？')) return;
  const { error } = await sb.from('snapshots').delete().eq('id', id);
  if (error) return fail(error);
  await refresh('已刪除');
}

// ============================================================
// 對話框
// ============================================================
function openDialog({ title, html, allowDelete = false, onMount, collect }) {
  return new Promise((resolve) => {
    const dlg = $('#form-dialog');
    const form = $('#form-dialog-form');
    $('h2', dlg).textContent = title;
    $('.fields', dlg).innerHTML = html;
    $('#form-delete').hidden = !allowDelete;

    const finish = (result) => { resolve(result); if (dlg.open) dlg.close(); };
    form.onsubmit = (e) => {
      e.preventDefault();
      if (!form.reportValidity()) return;
      const values = collect(new FormData(form), form);
      if (values === undefined) return;
      finish({ action: 'save', values });
    };
    $('#form-delete').onclick = () => { if (confirm('確定要刪除嗎？')) finish({ action: 'delete' }); };
    $('#form-cancel').onclick = () => finish(null);
    dlg.addEventListener('close', () => resolve(null), { once: true });

    if (onMount) onMount(form);
    dlg.showModal();
    const first = $('input:not([type=hidden]):not([type=radio]), select', form);
    if (first) first.focus();
  });
}

function fieldHtml(f, v) {
  const val = v === null || v === undefined ? '' : v;
  const req = f.required ? 'required' : '';
  const ph = `placeholder="${esc(f.placeholder || '')}"`;
  const lookup = f.lookup ? `data-lookup="${f.lookup}"` : '';
  if (f.type === 'select') {
    return `<label>${esc(f.label)}<select name="${f.key}">${f.options
      .map(([k, l]) => `<option value="${esc(k)}" ${String(val) === k ? 'selected' : ''}>${esc(l)}</option>`)
      .join('')}</select></label>`;
  }
  if (f.type === 'number') {
    return `<label>${esc(f.label)}<input name="${f.key}" type="number" step="any" inputmode="decimal" value="${esc(val)}" ${req} ${ph}></label>`;
  }
  return `<label>${esc(f.label)}<input name="${f.key}" type="text" value="${esc(val)}" ${req} ${ph} ${lookup} autocomplete="off"></label>`;
}

function openForm({ title, fields, values = {}, allowDelete = false }) {
  return openDialog({
    title, allowDelete,
    html: fields.map((f) => fieldHtml(f, values[f.key])).join(''),
    onMount: (form) => {
      $$('input[data-lookup]', form).forEach((input) => {
        attachLookup(input, input.dataset.lookup, (m) => { if (form.name) form.name.value = m.name; });
      });
    },
    collect: (fd) => {
      const out = {};
      for (const f of fields) {
        const raw = fd.get(f.key);
        if (f.type === 'number') out[f.key] = raw === '' || raw === null ? null : Number(raw);
        else out[f.key] = typeof raw === 'string' ? raw.trim() || null : raw;
      }
      if (out.symbol) {
        out.symbol = fields.some((f) => f.key === 'symbol' && f.lookup === 'tw')
          ? resolveTwSymbol(out.symbol) : norm(out.symbol);
      }
      if (fields.some((f) => f.key === 'symbol' && f.lookup === 'tw') && !out.name && TW_STOCKS[out.symbol]) {
        out.name = TW_STOCKS[out.symbol];
      }
      return out;
    },
  });
}

// ---------- 期貨部位（欄位會隨指數/個股切換） ----------
function openFuturesForm(existing) {
  const v = existing || { kind: 'index', side: 'long', lots: 1, symbol: '', size: 200, price: 0 };
  const html = `
    <label>類型<select name="kind">
      <option value="index" ${v.kind !== 'stock' ? 'selected' : ''}>指數期貨</option>
      <option value="stock" ${v.kind === 'stock' ? 'selected' : ''}>個股期貨</option>
    </select></label>
    <label><span data-l="symbol">商品</span><input name="symbol" type="text" required autocomplete="off" value="${esc(v.symbol || '')}"></label>
    <div class="resolved muted" data-resolved></div>
    <label data-row="size">規格<select name="size">${STOCK_FUT_SIZES
      .map((s) => `<option value="${s.size}" ${num(v.size) === s.size ? 'selected' : ''}>${s.label}</option>`).join('')}</select></label>
    <label data-row="mult">每點價值<input name="mult" type="number" step="any" inputmode="decimal" value="${esc(num(v.size))}" readonly></label>
    <div class="seg">
      <label><input type="radio" name="side" value="long" ${v.side !== 'short' ? 'checked' : ''}><span>多單</span></label>
      <label><input type="radio" name="side" value="short" ${v.side === 'short' ? 'checked' : ''}><span>空單</span></label>
    </div>
    <label>口數<input name="lots" type="number" step="any" inputmode="decimal" required min="0" value="${esc(num(v.lots))}"></label>
    <label>目前價格（每日自動更新）<input name="price" type="number" step="any" inputmode="decimal" required value="${esc(num(v.price))}"></label>
    <label>平均成本（選填，填了就會算損益）<input name="cost" type="number" step="any" inputmode="decimal" value="${isNum(v.cost) ? esc(num(v.cost)) : ''}"></label>
    <div class="preview" data-preview></div>`;

  const read = (fd, form) => {
    const kind = fd.get('kind');
    const symbol = norm(fd.get('symbol'));
    const size = kind === 'stock' ? num(fd.get('size')) : (indexProduct(symbol)?.size ?? num(fd.get('mult')) ?? 200);
    const rawCost = fd.get('cost');
    return {
      kind, symbol, size,
      contract: futDisplayName(kind, symbol, size),
      side: fd.get('side') || 'long',
      lots: num(fd.get('lots')),
      price: num(fd.get('price')),
      cost: rawCost === '' || rawCost === null ? null : Number(rawCost),
    };
  };

  return openDialog({
    title: existing ? '編輯期貨部位' : '新增期貨部位',
    html, allowDelete: !!existing,
    onMount: (form) => {
      const resolved = $('[data-resolved]', form);
      const preview = $('[data-preview]', form);
      const rowSize = $('[data-row=size]', form);
      const rowMult = $('[data-row=mult]', form);

      const update = () => {
        const val = read(new FormData(form), form);
        rowSize.hidden = val.kind !== 'stock';
        rowMult.hidden = val.kind === 'stock';
        $('[data-l=symbol]', form).textContent = val.kind === 'stock' ? '標的股票代號' : '商品';
        form.symbol.placeholder = val.kind === 'stock' ? '2330 或 台積' : 'TX / 小台 / 微台';
        if (val.kind !== 'stock') {
          const p = indexProduct(val.symbol);
          if (p) form.mult.value = p.size;
          resolved.textContent = p ? `${p.symbol}　${p.name}　每點 ${p.size} 元` : '（輸入 TX、MTX、TMF 或中文名稱）';
        } else {
          const nm = TW_STOCKS[val.symbol];
          resolved.textContent = nm ? `${val.symbol}　${nm}` : '（輸入股票代號）';
        }
        if (val.lots > 0 && val.price > 0) {
          const pl = futPl({ ...val });
          preview.innerHTML =
            `名目 / 曝險 ＝ ${fmtMax(val.lots, 2)} 口 × ${fmtMax(val.price, 2)} × ${fmt(val.size)} ＝ ${fmt(val.lots * val.price * val.size)} 元` +
            (pl === null ? '<br>填平均成本就會算損益' : `<br>損益 ＝ <span class="${plClass(pl)}">${signed(pl)}</span> 元`);
        } else {
          preview.textContent = '填好口數與價格後會顯示名目金額';
        }
      };
      attachLookup(form.symbol, () => (form.kind.value === 'stock' ? 'stockfut' : 'index'), (m) => {
        if (m.size) form.mult.value = m.size;
        update();
      });
      form.addEventListener('input', update);
      form.addEventListener('change', update);
      update();
    },
    collect: (fd, form) => {
      const val = read(fd, form);
      if (!val.symbol) { toast('請輸入商品或股票代號', 2500); return undefined; }
      if (!(val.lots > 0)) { toast('口數必須大於 0', 2500); return undefined; }
      if (!(val.size > 0)) { toast('規格不正確', 2500); return undefined; }
      return val;
    },
  });
}

function openOptionsForm(existing) {
  const v = existing || { expiry: state.optExpiries[0]?.expiry ?? '', strike: '', cp: 'call', side: 'long', lots: 1, cost: '' };
  const expOpts = state.optExpiries.length
    ? state.optExpiries.map((e) =>
        `<option value="${esc(e.expiry)}" ${String(v.expiry) === e.expiry ? 'selected' : ''}>${esc(e.expiry)}（遠期 ${fmt(e.forward)}）</option>`).join('')
    : `<option value="${esc(v.expiry)}">${esc(v.expiry || '尚未載入到期別')}</option>`;

  const html = `
    <label>到期<select name="expiry">${expOpts}</select></label>
    <label>履約價<input name="strike" type="number" step="any" inputmode="decimal" required value="${esc(v.strike)}" placeholder="47000"></label>
    <label>買權 / 賣權<select name="cp">
      <option value="call" ${v.cp !== 'put' ? 'selected' : ''}>買權 Call</option>
      <option value="put" ${v.cp === 'put' ? 'selected' : ''}>賣權 Put</option>
    </select></label>
    <div class="seg">
      <label><input type="radio" name="side" value="long" ${v.side !== 'short' ? 'checked' : ''}><span>買方</span></label>
      <label><input type="radio" name="side" value="short" ${v.side === 'short' ? 'checked' : ''}><span>賣方</span></label>
    </div>
    <label>口數<input name="lots" type="number" step="any" inputmode="decimal" required min="0" value="${esc(num(v.lots))}"></label>
    <label>平均成本（點，選填）<input name="cost" type="number" step="any" inputmode="decimal" value="${isNum(v.cost) ? esc(num(v.cost)) : ''}"></label>
    <div class="preview" data-preview></div>`;

  const read = (fd) => ({
    contract: 'TXO',
    expiry: String(fd.get('expiry') || '').trim(),
    strike: num(fd.get('strike')),
    cp: fd.get('cp') === 'put' ? 'put' : 'call',
    side: fd.get('side') || 'long',
    lots: num(fd.get('lots')),
    size: OPT_SIZE,
    cost: fd.get('cost') === '' || fd.get('cost') === null ? null : Number(fd.get('cost')),
  });

  return openDialog({
    title: existing ? '編輯選擇權部位' : '新增選擇權部位',
    html, allowDelete: !!existing,
    onMount: (form) => {
      const preview = $('[data-preview]', form);
      const update = () => {
        const val = read(new FormData(form));
        const fwd = state.optExpiries.find((e) => e.expiry === val.expiry)?.forward;
        const cur = existing && existing.expiry === val.expiry && num(existing.strike) === val.strike && existing.cp === val.cp
          ? num(existing.price) : null;
        const lines = [];
        if (fwd) lines.push(`${val.expiry} 隱含遠期指數 ${fmt(fwd)}`);
        if (cur !== null) {
          const o = { ...val, price: cur, delta: existing.delta, forward: existing.forward };
          lines.push(`權利金 ${fmtMax(cur, 2)} 點 → 市值 ${fmt(optValue(o))} 元`);
          const de = optDeltaExp(o);
          if (de !== null) lines.push(`delta ${fmtMax(existing.delta, 3)}　delta 曝險 ${fmt(Math.abs(de))} 元`);
          const pl = optPl(o);
          if (pl !== null) lines.push(`未實現損益 ${signed(pl)} 元`);
        } else {
          lines.push('權利金與 delta 存檔後會自動帶入');
        }
        const risk = optMaxRisk({ ...val, price: cur ?? 0 });
        lines.push(risk.unlimited ? '⚠ 賣出買權：最大風險無上限' : `最大風險 ${fmt(risk.value)} 元`);
        preview.innerHTML = lines.join('<br>');
        preview.classList.toggle('err', risk.unlimited);
      };
      form.addEventListener('input', update);
      form.addEventListener('change', update);
      update();
    },
    collect: (fd) => {
      const val = read(fd);
      if (!val.expiry) { toast('請選擇到期', 2500); return undefined; }
      if (!(val.strike > 0)) { toast('請輸入履約價', 2500); return undefined; }
      if (!(val.lots > 0)) { toast('口數必須大於 0', 2500); return undefined; }
      return val;
    },
  });
}

// 依代號查權證基本資料（37,000 筆放在資料庫，不下載到手機）
async function lookupWarrant(code) {
  const c = norm(code);
  if (!/^[0-9A-Z]{6}$/.test(c)) return null;
  const { data, error } = await sb.from('warrant_info').select('*').eq('code', c).maybeSingle();
  if (error) { console.warn(error); return null; }
  return data;
}

function openWarrantForm(existing, info) {
  const v = existing || { code: '', lots: 1, cost: '' };
  const meta = info || existing || {};
  const modelOk = !meta.category || String(meta.category).includes('一般型');
  const html = `
    <label>權證代號<input name="code" type="text" required autocomplete="off" autocapitalize="characters"
      maxlength="6" value="${esc(v.code || '')}" placeholder="030573" ${existing ? 'readonly' : ''}></label>
    <div class="resolved muted" data-resolved></div>
    <label>張數（1 張 = 1000 單位）<input name="lots" type="number" step="any" inputmode="decimal" required min="0" value="${esc(num(v.lots))}"></label>
    <label>成本（元／單位，選填）<input name="cost" type="number" step="any" inputmode="decimal" value="${isNum(v.cost) ? esc(num(v.cost)) : ''}"></label>
    <label data-row="ovr" ${modelOk ? 'hidden' : ''}>delta 手動填（界限型／重設型模型不適用）
      <input name="delta_override" type="number" step="any" inputmode="decimal" value="${isNum(v.delta_override) ? esc(num(v.delta_override)) : ''}" placeholder="0.5"></label>
    <div class="preview" data-preview></div>`;

  const read = (fd) => ({
    code: norm(fd.get('code')),
    lots: num(fd.get('lots')),
    cost: fd.get('cost') === '' || fd.get('cost') === null ? null : Number(fd.get('cost')),
    delta_override: fd.get('delta_override') === '' || fd.get('delta_override') === null ? null : Number(fd.get('delta_override')),
  });

  return openDialog({
    title: existing ? '編輯權證部位' : '新增權證',
    html, allowDelete: !!existing,
    onMount: (form) => {
      const resolved = $('[data-resolved]', form);
      const preview = $('[data-preview]', form);
      const rowOvr = $('[data-row=ovr]', form);
      let found = info || (existing ? existing : null);
      form.__found = found;

      const draw = () => {
        const val = read(new FormData(form));
        if (!found) {
          resolved.textContent = val.code.length === 6 ? '查詢中…' : '輸入 6 碼權證代號';
          preview.textContent = '';
          return;
        }
        const ok = !found.category || String(found.category).includes('一般型');
        rowOvr.hidden = ok;
        resolved.innerHTML = `${esc(found.name || '')}　${found.cp === 'put' ? '認售' : '認購'}<br>` +
          `標的 ${esc(found.underlying || '')} ${esc(found.underlying_name || '')}　履約價 ${fmtMax(found.strike, 2)}<br>` +
          `行使比例 ${fmtMax(found.ratio, 4)}　最後交易日 ${esc(found.last_trade_date || '')}　${esc(found.category || '')}`;

        const w = { ...found, ...val, price: existing ? num(existing.price) : 0,
                    underlying_price: existing ? num(existing.underlying_price) : 0,
                    delta: existing ? existing.delta : null };
        const lines = [];
        if (existing && num(existing.price) > 0) {
          lines.push(`權證價 ${fmtMax(existing.price, 2)}　標的 ${fmtMax(existing.underlying_price, 2)}`);
          lines.push(`市值 ${fmt(warValue(w))} 元`);
          const de = warExposure(w);
          if (de !== null) lines.push(`delta ${fmtMax(warDelta(w), 3)}　delta 曝險 ${fmt(Math.abs(de))} 元`);
          if (isNum(existing.iv)) lines.push(`隱含波動率 ${(num(existing.iv) * 100).toFixed(1)}%`);
          if (isNum(existing.gearing)) lines.push(`實質槓桿 ${fmtMax(existing.gearing, 2)} 倍`);
          const pl = warPl(w);
          if (pl !== null) lines.push(`未實現損益 ${signed(pl)} 元`);
        } else {
          lines.push('權證價、隱波、delta 存檔後會自動帶入');
        }
        lines.push(`最大損失 ${fmt(warMaxRisk(w))} 元（權證買方最多賠光權利金）`);
        if (!ok) lines.push('⚠ 這是界限型／重設型，Black-Scholes 不適用，delta 請手動填');
        preview.innerHTML = lines.join('<br>');
      };

      let timer;
      form.code.addEventListener('input', () => {
        found = null;
        form.__found = null;
        clearTimeout(timer);
        timer = setTimeout(async () => {
          const c = norm(form.code.value);
          if (!/^[0-9A-Z]{6}$/.test(c)) { draw(); return; }
          found = await lookupWarrant(c);
          form.__found = found;
          if (!found) resolved.textContent = '查不到這個代號，確認一下是不是上櫃權證或已下市';
          else draw();
        }, 350);
        draw();
      });
      form.addEventListener('input', draw);
      form.addEventListener('change', draw);
      draw();
    },
    collect: (fd, form) => {
      const val = read(fd);
      if (!/^[0-9A-Z]{6}$/.test(val.code)) { toast('權證代號要 6 碼', 2500); return undefined; }
      if (!(val.lots > 0)) { toast('張數必須大於 0', 2500); return undefined; }
      // 把查到的基本資料一起存起來，不要等排程同步才有行使比例與標的
      const f = form.__found;
      if (f) {
        Object.assign(val, {
          name: f.name ?? null, cp: f.cp ?? null,
          underlying: f.underlying ?? null, underlying_name: f.underlying_name ?? null,
          strike: isNum(f.strike) ? num(f.strike) : null,
          ratio: isNum(f.ratio) ? num(f.ratio) : null,
          last_trade_date: f.last_trade_date ?? null,
          category: f.category ?? null,
        });
      }
      return val;
    },
  });
}

async function editWarrant(id) {
  const existing = id ? state.warrants.find((w) => w.id === id) : null;
  const res = await openWarrantForm(existing);
  if (!res) return;
  try {
    if (res.action === 'delete') {
      const { error } = await sb.from('warrants').delete().eq('id', id);
      if (error) throw error;
      await refresh('已刪除');
    } else {
      const payload = { ...res.values, user_id: state.user.id };
      if (id) payload.id = id;
      const { error } = await sb.from('warrants').upsert(payload);
      if (error) throw error;
      await applyCachedPrices();
      await refresh('已儲存');
    }
  } catch (e) {
    fail(e);
  }
}

async function editOption(id) {
  const existing = id ? state.options.find((o) => o.id === id) : null;
  const res = await openOptionsForm(existing);
  if (!res) return;
  try {
    if (res.action === 'delete') {
      const { error } = await sb.from('options').delete().eq('id', id);
      if (error) throw error;
      await refresh('已刪除');
    } else {
      const payload = { ...res.values, user_id: state.user.id };
      if (id) payload.id = id;
      const { error } = await sb.from('options').upsert(payload);
      if (error) throw error;
      await applyCachedPrices();
      await refresh('已儲存');
    }
  } catch (e) {
    fail(e);
  }
}

async function editFutures(id) {
  const existing = id ? state.futures.find((f) => f.id === id) : null;
  const res = await openFuturesForm(existing);
  if (!res) return;
  try {
    if (res.action === 'delete') {
      const { error } = await sb.from('futures').delete().eq('id', id);
      if (error) throw error;
      await refresh('已刪除');
    } else {
      const payload = { ...res.values, user_id: state.user.id };
      if (id) payload.id = id;
      const { error } = await sb.from('futures').upsert(payload);
      if (error) throw error;
      await applyCachedPrices();
      await refresh('已儲存');
    }
  } catch (e) {
    fail(e);
  }
}

// ---------- 記一筆交易 ----------
function readTradeForm(fd) {
  const tk = fd.get('kind') || 'tw';
  const meta = TRADE_KINDS[tk] || TRADE_KINDS.tw;
  let quantity = num(fd.get('quantity'));
  if (tk === 'tw' && fd.get('unit') === 'lot') quantity *= 1000;

  const isDayTrade = fd.get('is_day_trade') === 'on';
  if (tk === 'option') {
    const expiry = String(fd.get('opt_expiry') || '').trim();
    const strike = num(fd.get('opt_strike'));
    const cp = fd.get('opt_cp') === 'put' ? 'put' : 'call';
    return {
      kindKey: tk, market: 'option', fut_kind: null, fut_size: null, is_day_trade: isDayTrade,
      opt_expiry: expiry, opt_strike: strike, opt_cp: cp,
      side: fd.get('side') || 'buy',
      trade_date: fd.get('trade_date') || todayISO(),
      symbol: 'TXO',
      name: `${expiry} ${strikeText(strike)} ${cpLabel(cp)}`,
      quantity,
      price: num(fd.get('price')),
      note: String(fd.get('note') || '').trim() || null,
    };
  }

  const symbol = (tk === 'tw' || tk === 'fut_stock') ? resolveTwSymbol(fd.get('symbol')) : norm(fd.get('symbol'));
  let name = String(fd.get('name') || '').trim() || null;
  if ((tk === 'tw' || tk === 'fut_stock') && !name && TW_STOCKS[symbol]) name = TW_STOCKS[symbol];
  if (tk === 'fut_index' && !name) name = indexProduct(symbol)?.name || null;
  return {
    kindKey: tk,
    market: meta.market,
    is_day_trade: isDayTrade,
    fut_kind: meta.fut_kind ?? null,
    fut_size: tk === 'fut_stock' ? num(fd.get('fut_size')) || 2000
            : tk === 'fut_index' ? (indexProduct(symbol)?.size ?? 200) : null,
    side: fd.get('side') || 'buy',
    trade_date: fd.get('trade_date') || todayISO(),
    symbol, name,
    quantity,
    price: num(fd.get('price')),
    note: String(fd.get('note') || '').trim() || null,
  };
}

function openTradeForm(defaults = {}) {
  const html = `
    <label>市場<select name="kind">${Object.entries(TRADE_KINDS)
      .map(([k, m]) => `<option value="${k}" ${defaults.kindKey === k ? 'selected' : ''}>${m.label}</option>`).join('')}</select></label>
    <div class="seg">
      <label><input type="radio" name="side" value="buy" checked><span>買進</span></label>
      <label><input type="radio" name="side" value="sell"><span>賣出</span></label>
    </div>
    <label class="check"><input type="checkbox" name="is_day_trade" ${defaults.is_day_trade ? 'checked' : ''}>
      <span>當沖（買賣自成一組，不動長期部位）</span></label>
    <label>日期<input name="trade_date" type="date" value="${todayISO()}" required></label>
    <label data-row="symbol"><span data-l="symbol">代號</span><input name="symbol" type="text" autocomplete="off" autocapitalize="characters" value="${esc(defaults.symbol || '')}"></label>
    <div class="resolved muted" data-resolved></div>
    <input type="hidden" name="name">
    <div data-row="opt" hidden>
      <label>到期<select name="opt_expiry">${state.optExpiries.length
        ? state.optExpiries.map((e) => `<option value="${esc(e.expiry)}">${esc(e.expiry)}（遠期 ${fmt(e.forward)}）</option>`).join('')
        : '<option value="">尚未載入到期別，按右上角 ↻</option>'}</select></label>
      <label>履約價<input name="opt_strike" type="number" step="any" inputmode="decimal" placeholder="47000"></label>
      <label>買權 / 賣權<select name="opt_cp">
        <option value="call">買權 Call</option><option value="put">賣權 Put</option>
      </select></label>
    </div>
    <label data-row="futsize">個股期貨規格<select name="fut_size">${STOCK_FUT_SIZES
      .map((s) => `<option value="${s.size}" ${num(defaults.fut_size) === s.size ? 'selected' : ''}>${s.label}</option>`).join('')}</select></label>
    <div class="qty-row">
      <label>數量<input name="quantity" type="number" step="any" inputmode="decimal" required min="0"></label>
      <label>單位<select name="unit"></select></label>
    </div>
    <label><span data-l="price">價格 (TWD)</span><input name="price" type="number" step="any" inputmode="decimal" required min="0"></label>
    <label>備註<input name="note" type="text" autocomplete="off"></label>
    <div class="preview" data-preview hidden></div>`;

  return openDialog({
    title: '記一筆交易',
    html,
    onMount: (form) => {
      const resolved = $('[data-resolved]', form);
      const preview = $('[data-preview]', form);
      const rowFutSize = $('[data-row=futsize]', form);

      const updatePreview = () => {
        const v = readTradeForm(new FormData(form));
        if (!v.symbol || !(v.quantity > 0)) { preview.hidden = true; return; }
        const p = projectTrade(v);
        preview.hidden = false;
        preview.classList.toggle('err', !!p.error);
        if (p.error) { preview.textContent = p.error; return; }
        if (p.dayTrade) {
          const cc = tradeCost(v, true);
          preview.innerHTML =
            (p.matched > 0
              ? `沖銷 ${fmtQty(v.market, p.matched)}，配到 ${fmtMax(p.openAvg, 2)} → ${fmtMax(v.price, 2)}，` +
                `這一趟 <span class="${plClass(p.realized)}">${signed(p.realized)}</span> 元`
              : `建立當沖部位 ${fmtQty(v.market, v.quantity)}，等反向那一筆再結算`) +
            `<br><span class="muted">不影響長期持倉的股數與均價</span>` +
            `<br><span class="muted">手續費 ${fmtMax(cc.fee, 0)}${cc.tax > 0
              ? `　交易稅 ${fmtMax(cc.tax, 0)}${v.market === 'tw' ? '（當沖減半）' : ''}` : ''}</span>`;
          return;
        }
        const label = v.market === 'option'
          ? `TXO ${v.opt_expiry} ${strikeText(v.opt_strike)} ${cpLabel(v.opt_cp)}`
          : `${v.symbol}${v.name ? ' ' + v.name : ''}`;
        if (v.market === 'option') {
          const notional = v.quantity * v.price * OPT_SIZE;
          preview.textContent =
            `${label}：${fmtNet(p.prevNet)} → ${fmtNet(p.net)}　權利金 ${fmt(notional)} 元` +
            (p.after ? `　均價 ${fmtMax(p.prevCost, 2)} → ${fmtMax(p.newCost, 2)} 點` : '（部位歸零，將移除）');
        } else if (v.market === 'futures') {
          const notional = v.quantity * v.price * num(v.fut_size);
          preview.textContent =
            `${label}：${fmtNet(p.prevNet)} → ${fmtNet(p.net)}　本筆名目 ${fmt(notional)}` +
            (p.after ? `　均價 ${fmtMax(p.prevCost, 2)} → ${fmtMax(p.newCost, 2)}` : '（部位歸零，將移除）');
        } else {
          preview.textContent =
            `${label}：持有 ${fmtQty(v.market, p.prevShares)} → ${fmtQty(v.market, p.newShares)}，` +
            `均價 ${fmtMax(p.prevCost, 2)} → ${fmtMax(p.newCost, 2)}` +
            (p.after ? '' : '（全部出清，部位將移除）');
        }
        // 這一筆的手續費與交易稅
        const sameDay = state.trades.some((x) => tradeKey(x) === tradeKey(v) && x.side !== v.side);
        const cc = tradeCost(v, sameDay);
        if (cc.total > 0) {
          preview.innerHTML = preview.innerHTML +
            `<br><span class="muted">手續費 ${fmtMax(cc.fee, 0)}${cc.tax > 0 ? `　交易稅 ${fmtMax(cc.tax, 0)}` : ''}` +
            `　成本合計 ${fmtMax(cc.total, 0)} ${cc.ccy}${sameDay ? '（當沖費率）' : ''}</span>`;
        }
      };

      const rowSymbol = $('[data-row=symbol]', form);
      const rowOpt = $('[data-row=opt]', form);

      const setKind = () => {
        const k = form.kind.value;
        const isOpt = k === 'option';
        const isWarrant = k === 'warrant';
        const isStockFut = k === 'fut_stock', isIdxFut = k === 'fut_index';
        rowOpt.hidden = !isOpt;
        rowSymbol.hidden = isOpt;
        resolved.hidden = isOpt;
        form.symbol.required = !isOpt;
        if (isOpt) {
          $('[data-l=price]', form).textContent = '權利金（點）';
          form.unit.innerHTML = '<option value="share">口</option>';
          form.unit.disabled = true;
          form.name.value = '';
          updatePreview();
          return;
        }
        rowFutSize.hidden = !isStockFut;
        $('[data-l=symbol]', form).textContent =
          isIdxFut ? '商品' : isStockFut ? '標的股票代號' : isWarrant ? '權證代號' : '代號';
        $('[data-l=price]', form).textContent =
          k === 'us' ? '價格 (USD)' : isIdxFut ? '成交價（指數）' : isWarrant ? '權證價（元／單位）' : '價格 (TWD)';
        form.symbol.placeholder =
          k === 'tw' || isStockFut ? '2330 或 台積' : isIdxFut ? 'TX / 小台 / 微台' : isWarrant ? '030573' : 'VOO';
        form.unit.innerHTML = k === 'tw'
          ? '<option value="lot">張</option><option value="share">股</option>'
          : k === 'us' ? '<option value="share">股</option>'
          : isWarrant ? '<option value="share">張</option>' : '<option value="share">口</option>';
        form.unit.disabled = k !== 'tw';
        form.name.value = '';
        resolved.textContent = k === 'us' ? '美股不會自動帶名稱' : '輸入代號或名稱會自動帶出';
        updatePreview();
      };

      attachLookup(form.symbol,
        () => (form.kind.value === 'fut_index' ? 'index'
             : form.kind.value === 'us' || form.kind.value === 'warrant' ? 'none' : 'tw'),
        (m, picked) => {
          form.name.value = m.name || '';
          resolved.textContent = `${m.code}　${m.name || ''}`;
          updatePreview();
          if (picked) form.quantity.focus();
        });
      form.symbol.addEventListener('input', () => {
        const k = form.kind.value;
        if (k === 'option') return;
        if (k === 'warrant') {
          const c = norm(form.symbol.value);
          if (/^[0-9A-Z]{6}$/.test(c)) {
            lookupWarrant(c).then((w) => {
              if (w && norm(form.symbol.value) === c) {
                form.name.value = w.name || '';
                resolved.textContent = `${w.name || ''}　標的 ${w.underlying || ''} ${w.underlying_name || ''}　履約 ${fmtMax(w.strike, 2)}`;
              }
            });
          } else { resolved.textContent = '輸入 6 碼權證代號'; }
          return;
        }
        const lk = k === 'fut_index' ? LOOKUPS.index : k === 'us' ? null : LOOKUPS.tw;
        if (lk && !lk.exact(norm(form.symbol.value))) {
          form.name.value = '';
          resolved.textContent = form.symbol.value.trim() ? '（找不到，會以你輸入的代號建立）' : '';
        }
      });
      form.kind.addEventListener('change', setKind);
      form.addEventListener('input', updatePreview);
      form.addEventListener('change', updatePreview);
      setKind();
    },
    collect: (fd) => {
      const values = readTradeForm(fd);
      if (values.market === 'option') {
        if (!values.opt_expiry) { toast('請選擇到期', 2500); return undefined; }
        if (!(values.opt_strike > 0)) { toast('請輸入履約價', 2500); return undefined; }
      }
      const p = projectTrade(values);
      if (p.error) { toast(p.error, 3500); return undefined; }
      if (!(values.price > 0)) { toast('請輸入價格', 2500); return undefined; }
      return values;
    },
  });
}

async function logTrade(defaults) {
  const res = await openTradeForm(defaults);
  if (res?.action === 'save') await saveTrade(res.values);
}

// ============================================================
// 畫面
// ============================================================
const TITLES = { overview: '總覽', holdings: '持倉', funds: '資金', themes: '族群', history: '紀錄', settings: '設定' };

const stat = (label, value, extra = '') =>
  `<div class="card stat"><div class="label">${label}</div><div class="value">${value}</div>${extra ? `<div class="sub muted">${extra}</div>` : ''}</div>`;
const line = (label, value, total) => {
  const share = total > 0 && isNum(value) ? ` <span class="muted">(${pct(value / total)})</span>` : '';
  return `<div class="row-between line"><span>${label}</span><span>${fmt(value)}${share}</span></div>`;
};
const section = (title, kind, rows, footer, addDefaults = {}) =>
  `<div class="card list">
    <div class="row-between">
      <span class="list-title">${esc(title)}</span>
      <button type="button" class="small" data-add="${kind}" data-defaults="${esc(JSON.stringify(addDefaults))}">＋ 新增</button>
    </div>
    ${rows.length ? rows.join('') : '<p class="muted">尚無資料，按「＋ 新增」登記，或用上方「記一筆交易」。</p>'}
    ${footer ? `<div class="list-footer">${footer}</div>` : ''}
  </div>`;
const itemRow = (kind, id, title, sub, right, right2 = '') =>
  `<button type="button" class="item" data-edit="${kind}" data-id="${id}">
    <span class="item-main"><span class="item-title">${title}</span><span class="item-sub">${sub}</span></span>
    <span class="item-right"><span>${right}</span><span class="item-sub">${right2}</span></span>
  </button>`;
const tradeButton = () => `<button type="button" class="primary block" data-trade>＋ 記一筆交易（買 / 賣）</button>`;

function bindListActions(el) {
  $$('[data-add]', el).forEach((b) => (b.onclick = () => {
    const d = JSON.parse(b.dataset.defaults || '{}');
    if (b.dataset.add === 'future') editFutures(null);
    else if (b.dataset.add === 'option') editOption(null);
    else if (b.dataset.add === 'warrant') editWarrant(null);
    else editItem(b.dataset.add, null, d);
  }));
  $$('[data-edit]', el).forEach((b) => (b.onclick = () =>
    b.dataset.edit === 'future' ? editFutures(b.dataset.id)
    : b.dataset.edit === 'option' ? editOption(b.dataset.id)
    : b.dataset.edit === 'warrant' ? editWarrant(b.dataset.id)
    : editItem(b.dataset.edit, b.dataset.id)));
  $$('[data-trade]', el).forEach((b) => (b.onclick = () => logTrade()));
}

const MARKET_NAME = { tw: '台股', fut: '指數期貨', us: '美股', fx: '匯率' };
const statusOf = (m) => state.priceStatus.find((p) => p.market === m);
// 各市場最新的資料日期；台股是主要基準
const newestAsOf = () => state.priceStatus.map((p) => p.as_of).filter(Boolean).sort().pop() || null;

function priceStamp() {
  const p = state.priceInfo;
  if (!p) return '報價尚未更新，按右上角 ↻ 抓一次';
  const d = new Date(p.updated_at);
  const tw = statusOf('tw');
  return `報價抓取於 ${d.toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` +
         (tw?.as_of ? `，台股收盤價為 ${tw.as_of}` : '');
}

// 資料日期比最新的還舊 → 提醒使用者
function stalenessNote() {
  const newest = newestAsOf();
  if (!newest) return '';
  const lagging = state.priceStatus.filter((p) => p.as_of && p.as_of < newest);
  if (!lagging.length) return '';
  const list = lagging.map((p) => `${MARKET_NAME[p.market] || p.market}停在 ${p.as_of}`).join('、');
  return `<p class="hint warn-hint">⚠ ${list}（來源尚未發布，不是設定錯誤）。目前最新資料日為 ${newest}。</p>`;
}

function renderOverview(el) {
  const c = compute();
  const last = state.snapshots[0];
  const diff = last ? c.netAssets - num(last.net_assets) : null;
  const progressWidth = Math.min(100, Math.max(0, (isNum(c.progress) ? c.progress : 0) * 100)).toFixed(1);

  el.innerHTML = `
    <div class="card hero">
      <div class="label">淨資產 (TWD)</div>
      <div class="big">${fmt(c.netAssets)}</div>
      ${last
        ? `<div class="sub ${plClass(diff)}">${signed(diff)} <span class="muted">相較 ${esc(last.snap_date)}</span></div>`
        : '<div class="sub muted">尚無快照紀錄</div>'}
    </div>
    <div class="grid2">
      ${stat('總資產', fmt(c.totalAssets))}
      ${stat('負債', fmt(c.liabilities))}
      ${stat('槓桿① 資產槓桿', fmtX(c.leverageAsset), c.netAssets > 0 ? '總資產 ÷ 淨資產' : '淨資產不為正，無法計算')}
      ${stat('槓桿② 曝險槓桿', fmtX(c.leverageExposure), '總曝險 ÷ 總資產')}
    </div>
    <div class="card">
      <div class="row-between"><span class="list-title">目標金額</span><span>${c.target > 0 ? fmt(c.target) : '<span class="muted">未設定</span>'}</span></div>
      <div class="bar"><div class="bar-fill" style="width:${progressWidth}%"></div></div>
      <div class="row-between sub">
        <span>${pct(c.progress)}</span>
        <span class="muted">${c.target > 0 ? (c.netAssets >= c.target ? '已達標 🎉' : '還差 ' + fmt(c.target - c.netAssets)) : '到「設定」輸入目標'}</span>
      </div>
    </div>
    <div class="card" id="donut-card">
      <div class="row-between">
        <span class="list-title">組成</span>
        <div class="seg-toggle" id="donut-toggle">
          <button type="button" data-donut="assets">資產組成</button>
          <button type="button" data-donut="exposure">曝險明細</button>
        </div>
      </div>
      <div id="donut-slot"></div>
    </div>
    <div class="card list">
      <div class="list-title">曝險</div>
      ${line('台股市值', c.stockValue)}
      ${line('複委託市值', c.usValue)}
      ${line('指數期貨名目', c.futIndex)}
      ${line('個股期貨名目', c.futStock)}
      ${line('選擇權 delta 曝險', c.optExposure)}
      ${line('權證 delta 曝險', c.warExp)}
      ${line('期貨名目・多單', c.futLong)}
      ${line('期貨名目・空單', c.futShort)}
      ${line('總曝險', c.exposure)}
      ${c.warNoDelta || c.optNoDelta ? `<p class="hint warn-hint">⚠ 有${
        [c.warNoDelta ? '權證' : '', c.optNoDelta ? '選擇權' : ''].filter(Boolean).join('、')
        }部位還沒算出 delta，<b>這些部位目前沒有計入上面的總曝險</b>，實際曝險比顯示的高。
        按右上角 ↻ 重新整理，或等下次自動更新。</p>` : ''}
    </div>
    ${state.warrants.length ? `<div class="card list">
      <div class="list-title">權證風險</div>
      ${line('權證市值', c.warMarket)}
      ${line('delta 曝險', c.warExp)}
      ${line('最大損失（買方賠光權利金）', c.warMaxLoss)}
      <div class="row-between line"><span>每日時間價值流失</span><span class="loss">${fmt(c.warTheta)}</span></div>
      <p class="hint">權證的隱含波動率由發行券商決定，可以在發行後調降，這會讓權證價格下跌但 delta 完全反映不出來。
        系統每天記錄各檔隱波，被調降時會在「持倉」標示。${c.warNoDelta ? '<br>⚠ 有部位還沒算出 delta。' : ''}</p>
    </div>` : ''}
    ${state.options.length ? `<div class="card list">
      <div class="list-title">選擇權風險</div>
      ${line('權利金市值（買方正、賣方負）', c.optMarket)}
      ${line('delta 曝險（絕對值加總）', c.optExposure)}
      ${line('淨方向部位（多為正）', c.optNetDelta)}
      <div class="row-between line"><span>最大風險</span><span class="${c.optRiskUnlimited ? 'loss' : ''}">${
        c.optRiskUnlimited ? '無上限（有賣出買權）' : fmt(c.optMaxLoss)}</span></div>
      <p class="hint">delta 曝險是線性近似，大幅波動時實際曝險會比這個數字放大（gamma），賣方尤其明顯。
        所以最大風險另外列出，不併進槓桿。${c.optNoDelta ? '<br>⚠ 有部位還沒算出 delta，按右上角 ↻ 或等下次自動更新。' : ''}</p>
    </div>` : ''}
    ${tradeButton()}
    <button type="button" class="block" id="snap-btn">📌 記錄今日快照</button>
    <p class="hint">${priceStamp()}。收盤價、結算價與匯率每天自動更新，不用手動改。匯率 ${fmt(c.rate, 3)}。</p>
    ${stalenessNote()}`;

  const slot = $('#donut-slot', el);
  const drawDonut = () => {
    $$('#donut-toggle button', el).forEach((b) => b.classList.toggle('active', b.dataset.donut === state.donutMode));
    slot.innerHTML = '';
    if (state.donutMode === 'exposure') {
      const slices = exposureSlices();
      const total = sum(slices, (s) => s.value);
      slot.appendChild(donutChart({
        slices, total, centerLabel: '總曝險', centerValue: fmtCompact(total), format: fmt,
      }));
    } else {
      slot.appendChild(donutChart({
        slices: [
          { label: '台股', value: c.stockValue, color: 'var(--series-1)' },
          { label: '複委託', value: c.usValue, color: 'var(--series-2)' },
          { label: '期貨權益', value: c.futEquity, color: 'var(--series-3)' },
          { label: '現金', value: c.cash, color: 'var(--series-4)' },
        ],
        total: c.totalAssets, centerLabel: '總資產', centerValue: fmtCompact(c.totalAssets), format: fmt,
      }));
    }
  };
  $$('#donut-toggle button', el).forEach((b) => (b.onclick = () => {
    state.donutMode = b.dataset.donut;
    try { localStorage.setItem('donutMode', state.donutMode); } catch {}
    drawDonut();
  }));
  drawDonut();

  $('#snap-btn', el).onclick = saveSnapshot;
  bindListActions(el);
}

function renderHoldings(el) {
  const c = compute();
  const stockRows = state.stocks.map((s) => {
    const v = num(s.shares) * num(s.price);
    const pl = isNum(s.cost) ? v - num(s.shares) * num(s.cost) : null;
    return itemRow('stock', s.id,
      `${esc(s.symbol)} ${esc(s.name || '')}${twKnown(s.symbol) ? '' : '<span class="badge warn-badge">價格不會自動更新</span>'}`,
      `${fmtQty('tw', s.shares)} × ${fmtMax(s.price, 2)}${isNum(s.cost) ? `　均價 ${fmtMax(s.cost, 2)}` : ''}`,
      fmt(v),
      pl === null ? '' : `<span class="${plClass(pl)}">${signed(pl)}</span>`);
  });
  const futRows = state.futures.map((f) => {
    const isStock = f.kind === 'stock';
    const pl = futPl(f);
    return itemRow('future', f.id,
      `${esc(f.contract || futDisplayName(f.kind, f.symbol, f.size))}<span class="badge">${f.side === 'short' ? '空' : '多'}</span>${
        autoPriceOk(f) ? '' : '<span class="badge warn-badge">價格不會自動更新</span>'}`,
      `${fmtMax(f.lots, 2)} 口 × ${fmtMax(f.price, 2)} × ${fmt(f.size)}${isStock ? ' 股' : ' 元/點'}${
        isNum(f.cost) ? `　均價 ${fmtMax(f.cost, 2)}` : ''}`,
      `名目 ${fmt(futNotional(f))}`,
      pl === null
        ? `${isStock ? `個股期・${stockFutLabel(f.size)}型` : '指數期'}<span class="muted">・未填成本</span>`
        : `<span class="${plClass(pl)}">${signed(pl)}</span>`);
  });
  const usRows = state.us.map((s) => {
    const v = num(s.shares) * num(s.price_usd);
    const pl = isNum(s.cost_usd) ? v - num(s.shares) * num(s.cost_usd) : null;
    return itemRow('us', s.id,
      `${esc(s.symbol)} ${esc(s.name || '')}`,
      `${fmtMax(s.shares, 4)} 股 × ${fmtMax(s.price_usd, 2)}${isNum(s.cost_usd) ? `　均價 ${fmtMax(s.cost_usd, 2)}` : ''}`,
      `US$ ${fmt(v, 2)}`,
      pl === null ? `≈ ${fmt(v * c.rate)}` : `<span class="${plClass(pl)}">${signed(pl, 2)}</span> ≈ ${fmt(v * c.rate)}`);
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
        : `<span class="${plClass(pl)}">${signed(pl)}</span>`);
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
        : `<span class="${plClass(c.futProfit)}">${signed(c.futProfit)}</span>`}`) +
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
    `<p class="hint">「記一筆交易」會自動加減部位、重算均價；部位沒變動就不會動資料，賣光才移除。
      期貨的<b>權益數</b>計入總資產，<b>名目金額</b>計入曝險。個股期貨以標的股價計價：大型 = 2 張（2,000 股）、小型 = 100 股。
      選擇權的<b>權利金市值</b>計入總資產（買方為正、賣方為負），<b>delta 曝險</b>計入槓桿；
      delta 由期交所結算價每天自動反推，不用手動填。</p>`;
  bindListActions(el);
}

function renderFunds(el) {
  const c = compute();
  const money = (b) => {
    const usd = b.currency === 'USD';
    return itemRow('balance', b.id, esc(b.name), esc(b.note || ''),
      `${fmt(b.amount, usd ? 2 : 0)} ${b.currency}`, usd ? `≈ ${fmt(num(b.amount) * c.rate)}` : '');
  };
  const cashRows = state.balances.filter((b) => b.kind === 'cash').map(money);
  const equityRows = state.balances.filter((b) => b.kind === 'futures_equity').map(money);
  const debtRows = state.balances.filter((b) => b.kind === 'liability').map(money);

  el.innerHTML =
    section('現金 / 存款', 'balance', cashRows, `合計 ${fmt(c.cash)}`, { kind: 'cash' }) +
    section('期貨帳戶權益數', 'balance', equityRows, `合計 ${fmt(c.futEquity)}`, { kind: 'futures_equity', name: '期貨帳戶' }) +
    section('負債', 'balance', debtRows, `合計 ${fmt(c.liabilities)}`, { kind: 'liability' }) +
    `<div class="grid2">${stat('總資產', fmt(c.totalAssets))}${stat('淨資產', fmt(c.netAssets))}</div>
    <p class="hint">負債例如：信貸、股票質押借款、融資。美金項目以匯率 ${fmt(c.rate, 3)} 換算（每日自動更新）。</p>`;
  bindListActions(el);
}

function renderHistory(el) {
  const snaps = state.snapshots;
  const trades = state.trades.slice(0, 200);
  const rs = realizedSummary();
  const asc = [...snaps].reverse(); // 折線圖由舊到新

  el.innerHTML = `
    <div class="card" id="chart-assets"><div class="list-title">資產走勢</div></div>
    <div class="card" id="chart-lev"><div class="list-title">槓桿走勢</div></div>
    <div class="card">
      <div class="list-title">買賣收益（已實現）</div>
      <div class="grid3">
        <div class="mini"><div class="label">淨損益</div><div class="value ${plClass(rs.total)}">${signed(rs.total)}</div></div>
        <div class="mini"><div class="label">當沖（淨）</div><div class="value ${plClass(rs.day)}">${signed(rs.day)}</div></div>
        <div class="mini"><div class="label">波段（淨）</div><div class="value ${plClass(rs.swing)}">${signed(rs.swing)}</div></div>
      </div>
      <div class="row-between line"><span>已實現損益（未扣成本）</span><span class="${plClass(rs.gross)}">${signed(rs.gross)}</span></div>
      <div class="row-between line"><span>手續費 ＋ 交易稅</span><span class="loss">${signed(-rs.cost)}</span></div>
      <div class="row-between line"><span><b>淨損益</b></span><span class="${plClass(rs.total)}"><b>${signed(rs.total)}</b></span></div>
      <div id="chart-cum"></div>
      <div class="sub muted chart-sub">單日已實現損益</div>
      <div id="chart-daily"></div>
      <p class="hint">波段賣出用當時的平均成本結算；當沖則是同一組買賣直接配對，不碰長期部位。
        <b>所有數字都是扣掉手續費與交易稅之後的淨額</b>，買進那一筆的手續費也算在內。
        當沖以你記錄時勾選的為準，不做推斷。
        未實現損益請看「持倉」頁。這裡不會自動調整你的現金餘額，現金請在「資金」頁自行維護。</p>
    </div>
    ${tradeButton()}
    <div class="card list">
      <div class="list-title">歷史交易紀錄</div>
      ${trades.length
        ? trades.map((t) => `<button type="button" class="item" data-del-trade="${t.id}">
            <span class="item-main">
              <span class="item-title"><span class="trade-side ${t.side}">${t.side === 'buy' ? '買' : '賣'}</span>${
                t.market === 'option' ? `TXO ${esc(t.opt_expiry)} ${strikeText(t.opt_strike)} ${cpLabel(t.opt_cp)}` : `${esc(t.symbol)} ${esc(t.name || '')}`}${
                t.is_day_trade ? '<span class="badge day-badge">當沖</span>' : ''}</span>
              <span class="item-sub">${(() => {
                const m = t.is_day_trade ? rs.perTrade.get(t.id) : null;
                return m ? `沖銷 ${fmtQty(t.market, m.qty)} @ ${fmtMax(m.openAvg, 2)} → ${fmtMax(t.price, 2)}・` : '';
              })()}${esc(t.trade_date)}・${TRADE_KINDS[tradeKindOf(t)]?.label || MARKET_LABEL[t.market] || ''}${
                t.market === 'futures' && t.fut_kind === 'stock' ? `（${stockFutLabel(t.fut_size)}型）` : ''}${t.note ? '・' + esc(t.note) : ''}</span>
            </span>
            <span class="item-right"><span>${fmtQty(t.market, t.quantity)}</span>
              <span class="item-sub">@ ${fmtMax(t.price, 2)}</span>
              <span class="item-sub">${(() => {
                const c = costTwd(t, !!t.is_day_trade);
                const m = t.is_day_trade ? rs.perTrade.get(t.id) : null;
                const r = m ? m.pl * (m.ccy === 'USD' ? num(state.settings.usd_twd) : 1) : realizedTwd(t);
                const net = (r ?? 0) - c;
                return `<span class="${plClass(net)}">${signed(net)}</span>` +
                       `<span class="muted"> 　成本 ${fmt(c)}</span>`;
              })()}</span></span>
          </button>`).join('')
        : '<p class="muted">尚無交易。按上方「記一筆交易」開始。</p>'}
      ${trades.length ? '<p class="hint">點一筆可刪除並還原部位。要修改請刪除後重新記錄。</p>' : ''}
    </div>
    <div class="card">
      <div class="row-between">
        <span class="list-title">每日快照</span>
        <button type="button" class="small" id="snap-btn2">📌 記錄今日</button>
      </div>
      ${snaps.length
        ? `<div class="table-wrap"><table>
            <thead><tr><th>日期</th><th>行情日</th><th>淨資產</th><th>變化</th><th>總資產</th><th>負債</th><th>槓桿①</th><th>槓桿②</th><th>目標%</th><th></th></tr></thead>
            <tbody>${snaps.map((r, i) => {
              const prev = snaps[i + 1];
              const d = prev ? num(r.net_assets) - num(prev.net_assets) : null;
              const prog = num(r.target_amount) > 0 ? num(r.net_assets) / num(r.target_amount) : null;
              return `<tr>
                <td>${esc(r.snap_date)}${r.note === 'auto' ? '<span class="badge">自動</span>' : ''}</td>
                <td class="${r.price_as_of && r.price_as_of < r.snap_date ? 'loss' : 'muted'}">${
                  r.price_as_of ? esc(r.price_as_of).slice(5) : '–'}</td>
                <td>${fmt(r.net_assets)}</td><td class="${plClass(d)}">${signed(d)}</td>
                <td>${fmt(r.total_assets)}</td><td>${fmt(r.liabilities)}</td>
                <td>${fmtX(r.leverage_asset)}</td><td>${fmtX(r.leverage_exposure)}</td>
                <td>${pct(prog)}</td>
                <td><button type="button" class="link danger" data-del-snap="${r.id}">刪除</button></td>
              </tr>`;
            }).join('')}</tbody>
          </table></div>`
        : '<p class="muted">尚無快照。系統每個交易日會自動存一筆，也可以按「記錄今日」手動存。</p>'}
      <p class="hint">每天一筆，表格可左右滑動。「行情日」是這筆快照用到的收盤價日期；
    若比左邊的日期早（標紅），表示當時來源還沒發布最新收盤價。</p>
    </div>`;

  const labels = asc.map((s) => s.snap_date);
  const dates = asc.map((s) => new Date(s.snap_date + 'T00:00:00'));
  // 總資產與淨資產量級相近，放同一張圖；曝險量級差很多，
  // 改由下面的「槓桿② 曝險」呈現（同一件事的標準化版本），避免壓扁資產線
  $('#chart-assets', el).appendChild(lineChart({
    labels, dates, title: '資產走勢', format: (v, axis) => (axis ? fmtCompact(v) : fmt(v)),
    series: [
      { label: '總資產', color: 'var(--series-1)', values: asc.map((s) => (isNum(s.total_assets) ? Number(s.total_assets) : null)) },
      { label: '淨資產', color: 'var(--series-2)', values: asc.map((s) => (isNum(s.net_assets) ? Number(s.net_assets) : null)) },
    ],
  }));
  $('#chart-lev', el).appendChild(lineChart({
    labels, dates, title: '槓桿走勢', format: (v) => Number(v).toFixed(2) + 'x',
    series: [
      { label: '槓桿① 資產', color: 'var(--series-1)', values: asc.map((s) => (isNum(s.leverage_asset) ? Number(s.leverage_asset) : null)) },
      { label: '槓桿② 曝險', color: 'var(--series-2)', values: asc.map((s) => (isNum(s.leverage_exposure) ? Number(s.leverage_exposure) : null)) },
    ],
  }));

  $('#chart-cum', el).appendChild(lineChart({
    labels: rs.series.map((r) => r.date),
    dates: rs.series.map((r) => new Date(r.date + 'T00:00:00')),
    title: '累計已實現損益', format: (v, axis) => (axis ? fmtCompact(v) : fmt(v)),
    yZero: true,
    series: [{ label: '累計已實現損益', color: 'var(--series-1)', values: rs.series.map((r) => r.cum) }],
  }));
  $('#chart-daily', el).appendChild(barChart({
    labels: rs.series.map((r) => r.date.slice(5)),
    values: rs.series.map((r) => r.daily),
    title: '單日已實現損益', format: (v, axis) => (axis ? fmtCompact(v) : fmt(v)),
  }));

  $('#snap-btn2', el).onclick = saveSnapshot;
  $$('[data-del-snap]', el).forEach((b) => (b.onclick = () => deleteSnapshot(b.dataset.delSnap)));
  $$('[data-del-trade]', el).forEach((b) => (b.onclick = () => deleteTrade(b.dataset.delTrade)));
  bindListActions(el);
}

// ------------------------------------------------------------
// 族群趨勢
//   用月營收年增率衡量產業景氣，不是看股價漲跌。
//   台灣強制上市櫃每月公告營收，這是全球少見的高頻基本面資料。
// ------------------------------------------------------------
const heldSymbols = () => new Set([
  ...state.stocks.map((x) => norm(x.symbol)),
  ...state.futures.filter((f) => f.kind === 'stock').map((f) => norm(f.symbol)),
  ...state.warrants.map((w) => norm(w.underlying)),
]);

const rocYm = (ym) => {
  const y = Number(String(ym).slice(0, 3)) + 1911;
  return `${y}/${String(ym).slice(3)}`;
};

function renderThemes(el) {
  const trend = [...state.themeTrend].filter((t) => isNum(t.yoy)).sort((a, b) => num(b.yoy) - num(a.yoy));
  const held = heldSymbols();
  const ym = state.themeTrend[0]?.ym;

  if (!trend.length) {
    el.innerHTML = `<div class="card"><p class="muted">還沒有營收資料。按右上角 ↻ 更新，或等下次自動更新。</p></div>`;
    return;
  }

  const myThemes = new Set(state.themeMembers.filter((m) => held.has(norm(m.symbol))).map((m) => m.theme));

  el.innerHTML = `
    <div class="card">
      <div class="list-title">產業營收年增率</div>
      <p class="sub muted">${ym ? rocYm(ym) + ' 月營收' : ''}，同族群成分股加總後比去年同月。
        這是產業本身的成長，不是股價漲跌。</p>
    </div>
    ${trend.map((t) => {
      const mine = myThemes.has(t.theme);
      return `<div class="card theme-card${mine ? ' mine' : ''}" data-theme="${esc(t.theme)}">
        <div class="row-between">
          <span class="list-title">${esc(t.theme)}${mine ? '<span class="badge day-badge">持有</span>' : ''}</span>
          <span class="theme-yoy ${plClass(num(t.yoy))}">${signed(num(t.yoy) * 100, 1)}%</span>
        </div>
        <div class="row-between sub muted">
          <span>月營收 ${fmt(num(t.amount) / 100000, 1)} 億</span>
          <span>${fmt(t.members)} 檔・點開看成分股</span>
        </div>
        <div class="theme-body" hidden></div>
      </div>`;
    }).join('')}
    <p class="hint">資料來源：證交所與櫃買中心的每月營收公告，每月 10 日前後更新。
      族群分類是人工維護的，要增減成分股跟我說。
      營收成長不等於股價會漲，但產業景氣轉折通常先反映在營收。</p>`;

  $$('.theme-card', el).forEach((card) => {
    card.onclick = () => {
      const body = $('.theme-body', card);
      if (!body.hidden) { body.hidden = true; return; }
      $$('.theme-body', el).forEach((b) => (b.hidden = true));
      const rows = state.themeMembers.filter((m) => m.theme === card.dataset.theme);
      body.innerHTML = rows.length
        ? rows.map((m) => `<div class="row-between line">
            <span>${esc(m.symbol)} ${esc(m.name || '')}${held.has(norm(m.symbol)) ? '<span class="badge day-badge">持有</span>' : ''}</span>
            <span>${fmt(num(m.amount) / 100000, 1)} 億　<span class="${plClass(num(m.yoy))}">${
              isNum(m.yoy) ? signed(num(m.yoy) * 100, 1) + '%' : '–'}</span></span>
          </div>`).join('')
        : '<p class="muted">沒有成分股資料。</p>';
      body.hidden = false;
    };
  });
}

function renderSettings(el) {
  const st = state.settings;
  el.innerHTML = `
    <form id="settings-form" class="card">
      <div class="list-title">目標與匯率</div>
      <label>目標金額（淨資產, TWD）<input name="target_amount" type="number" step="any" inputmode="numeric" value="${esc(num(st.target_amount))}"></label>
      <label>美金匯率（1 USD = ? TWD，每日自動更新）<input name="usd_twd" type="number" step="any" inputmode="decimal" value="${esc(num(st.usd_twd))}"></label>
      <button type="submit" class="primary block">儲存設定</button>
    </form>
    <form id="fee-form" class="card">
      <div class="list-title">交易成本</div>
      <p class="sub muted">稅率是法定的、不能改。手續費因券商與折數而異，填你實際的。</p>
      <label>台股手續費率（標準 0.001425）
        <input name="fee_stock_rate" type="number" step="any" inputmode="decimal" value="${esc(feeCfg('fee_stock_rate'))}"></label>
      <label>券商手續費折數（1 = 不打折，0.3 = 三折）
        <input name="fee_stock_disc" type="number" step="any" inputmode="decimal" value="${esc(feeCfg('fee_stock_disc'))}"></label>
      <label>每筆最低手續費（元）
        <input name="fee_min" type="number" step="any" inputmode="decimal" value="${esc(feeCfg('fee_min'))}"></label>
      <label>權證手續費折數
        <input name="fee_warrant_disc" type="number" step="any" inputmode="decimal" value="${esc(feeCfg('fee_warrant_disc'))}"></label>
      <label>期貨手續費（元／口，<b>買賣各收一次</b>）
        <input name="fee_fut_per_lot" type="number" step="any" inputmode="decimal" value="${esc(feeCfg('fee_fut_per_lot'))}"></label>
      <label>選擇權手續費（元／口，<b>買賣各收一次</b>）
        <input name="fee_opt_per_lot" type="number" step="any" inputmode="decimal" value="${esc(feeCfg('fee_opt_per_lot'))}"></label>
      <label>複委託手續費率（買賣各一次，0.001 = 0.1%）
        <input name="fee_us_rate" type="number" step="any" inputmode="decimal" value="${esc(feeCfg('fee_us_rate'))}"></label>
      <label>複委託每筆最低（USD）
        <input name="fee_us_min" type="number" step="any" inputmode="decimal" value="${esc(feeCfg('fee_us_min'))}"></label>
      <button type="submit" class="primary block">儲存費率</button>
      <p class="hint">折數是跟券商談的，<b>當沖和波段都一樣</b>；當沖影響的只有政府的證交稅（減半）。
        期貨與選擇權是每口固定金額，<b>買進收一次、賣出再收一次</b>，所以一口來回是填的兩倍。複委託也是買賣各收一次。
        ${feeCfg('fee_us_min') > 0 ? '' : '若複委託有每筆最低收費，記得填。'}
        ${feeCfg('fee_us_rate') > 0 ? '' : '<br>⚠ 複委託費率還沒設定，美股交易的成本目前不計入。'}</p>
    </form>
    <div class="card">
      <div class="list-title">法定稅率（不可改）</div>
      <div class="row-between line"><span>台股賣出</span><span>0.300%</span></div>
      <div class="row-between line"><span>台股當沖賣出</span><span>0.150%（政府減半）</span></div>
      <div class="row-between line"><span>權證賣出</span><span>0.100%</span></div>
      <div class="row-between line"><span>期貨（買賣各一次）</span><span>0.002%</span></div>
      <div class="row-between line"><span>選擇權（買賣各一次）</span><span>0.100%</span></div>
      <p class="hint">當沖降稅 0.15% 已延長至 2027-12-31，查證日期 2026-09-08。
        <b>只有台股現股當沖有減半優惠</b>；期貨、選擇權、權證都沒有，買賣各課一次全額。</p>
    </div>
    <div class="card">
      <div class="list-title">行情更新</div>
      <p class="muted sub">${priceStamp()}</p>
      <div class="table-wrap"><table>
        <thead><tr><th>市場</th><th>資料日期</th><th>檔數</th></tr></thead>
        <tbody>${['tw', 'fut', 'us', 'fx'].map((m) => {
          const p = statusOf(m);
          const stale = p?.as_of && newestAsOf() && p.as_of < newestAsOf();
          return `<tr><td>${MARKET_NAME[m]}</td>
            <td class="${stale ? 'loss' : ''}">${p?.as_of ?? '–'}${stale ? ' ⚠' : ''}</td>
            <td>${p ? fmt(p.symbols) : '–'}</td></tr>`;
        }).join('')}</tbody>
      </table></div>
      <button type="button" class="block" id="force-price">立即重新抓取報價</button>
      <p class="hint">每個交易日 14:30、16:00、18:00、21:00（台股／期貨／選擇權／權證／匯率）與隔日 06:00（美股）自動更新，
        並自動存一筆快照。手機沒開也會跑，平常不需要按這個按鈕。
        按下去會一項一項抓，大約 6 秒；某一項失敗不影響其他項。</p>
    </div>
    <div class="card">
      <div class="list-title">帳號</div>
      <p class="muted">${esc(state.user.email || '')}</p>
      <button type="button" class="block" id="logout-btn">登出</button>
    </div>
    <div class="card">
      <div class="list-title">數字怎麼算</div>
      <dl class="defs">
        <dt>總資產</dt><dd>台股市值 ＋ 複委託市值（換算 TWD）＋ 期貨帳戶權益數 ＋ 現金/存款</dd>
        <dt>淨資產</dt><dd>總資產 － 負債</dd>
        <dt>槓桿①（資產槓桿）</dt><dd>總資產 ÷ 淨資產</dd>
        <dt>槓桿②（曝險槓桿）</dt><dd>（台股 ＋ 複委託 ＋ 期貨名目）÷ <b>總資產</b>，指數期貨與個股期貨都算</dd>
        <dt>指數期貨名目</dt><dd>口數 × 結算價 × 每點價值（大台 200、小台 50、微台 10）</dd>
        <dt>個股期貨名目</dt><dd>口數 × 標的股價 × 等同股數（大型 2,000 股 ＝ 2 張、小型 100 股）</dd>
        <dt>權證（1 張 = 1000 單位）</dt>
        <dd>市值 = 張數 × 1000 × 權證價，計入總資產。<br>
            delta 曝險 = 張數 × 1000 × 行使比例 × delta × 標的股價，計入槓桿②。<br>
            最大損失 = 付出的權利金，買方不會賠更多。<br>
            隱波、delta、theta、實質槓桿由每日收盤價自動反推。約半數權證當天沒成交，
            這時用造市商的委買賣中價評價。<br>
            <b>隱波是發行券商唯一能事後操縱的參數</b>，調降會讓權證價格下跌而 delta 看不出來，
            所以系統每天留存隱波，被調降時會標示。界限型與重設型模型不適用，delta 請手動填。</dd>
        <dt>選擇權（TXO，每點 50 元）</dt>
        <dd>權利金市值 = 口數 × 權利金 × 50，買方為正、賣方為負，計入總資產。<br>
            delta 曝險 = 口數 × delta × 隱含遠期指數 × 50，計入槓桿②。<br>
            最大風險：買方 = 權利金；賣方賣權 =（履約價 − 權利金）× 口數 × 50；賣方買權無上限。<br>
            delta 由期交所每日結算價用 Black-76 反推，每天自動更新。</dd>
        <dt>期貨損益</dt><dd>多單（現價 − 平均成本）、空單（平均成本 − 現價），再乘口數與規格。沒填平均成本就不顯示損益。</dd>
      </dl>
      <p class="hint">台股名稱清單 ${TW_ENTRIES.length} 檔。價格來源：證交所、櫃買中心、期交所、Yahoo Finance。</p>
    </div>`;
  $('#settings-form', el).onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = { user_id: state.user.id, target_amount: num(fd.get('target_amount')), usd_twd: num(fd.get('usd_twd')) };
    const { error } = await sb.from('settings').upsert(payload);
    if (error) return fail(error);
    state.settings = { ...state.settings, ...payload };
    toast('設定已儲存');
  };
  $('#fee-form', el).onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = { user_id: state.user.id };
    for (const k of Object.keys(DEFAULT_FEES)) payload[k] = num(fd.get(k));
    const { error } = await sb.from('settings').upsert(payload);
    if (error) return fail(error);
    state.settings = { ...state.settings, ...payload };
    render();
    toast('費率已儲存');
  };
  $('#force-price', el).onclick = async () => {
    const b = $('#force-price', el);
    b.disabled = true;
    try {
      const done = await runStagedRefresh((label) => { b.textContent = `更新中：${label}…`; });
      await loadAll(); render();
      const bad = refreshSummary(done);
      toast(bad ? bad + '，其餘已更新' : `報價已更新（${statusOf('tw')?.as_of ?? ''}）`, bad ? 5000 : 2500);
    } catch (e) {
      fail(e);
      b.disabled = false; b.textContent = '立即重新抓取報價';
    }
  };
  $('#logout-btn', el).onclick = async () => {
    const { error } = await sb.auth.signOut();
    if (error) fail(error);
  };
}

const RENDERERS = { overview: renderOverview, holdings: renderHoldings, funds: renderFunds, themes: renderThemes, history: renderHistory, settings: renderSettings };

function render() {
  if (!state.user) return;
  $$('.bottom-nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  $$('.tab-panel').forEach((p) => (p.hidden = p.dataset.tab !== state.tab));
  $('#topbar-title').textContent = TITLES[state.tab];
  RENDERERS[state.tab]($(`.tab-panel[data-tab="${state.tab}"]`));
}

function bindNav() {
  $$('.bottom-nav button').forEach((b) => {
    b.onclick = () => { state.tab = b.dataset.tab; render(); window.scrollTo({ top: 0 }); };
  });
  $('#refresh-btn').onclick = refreshPrices;
}

// ============================================================
// 登入 / 註冊
// ============================================================
function bindAuth() {
  const form = $('#auth-form');
  const submit = $('#auth-submit');
  const toggle = $('#auth-toggle');
  const switchText = $('#auth-switch-text');
  const msg = $('#auth-msg');

  toggle.onclick = () => {
    state.authMode = state.authMode === 'login' ? 'signup' : 'login';
    const login = state.authMode === 'login';
    submit.textContent = login ? '登入' : '註冊';
    toggle.textContent = login ? '註冊' : '登入';
    switchText.textContent = login ? '還沒有帳號？' : '已經有帳號？';
    form.password.autocomplete = login ? 'current-password' : 'new-password';
    msg.textContent = '';
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!sb) return;
    const email = form.email.value.trim();
    const password = form.password.value;
    submit.disabled = true;
    msg.textContent = '';
    try {
      if (state.authMode === 'signup') {
        const { data, error } = await sb.auth.signUp({ email, password });
        if (error) throw error;
        if (!data.session) msg.textContent = '註冊成功！請到信箱點確認連結，再回來登入。';
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      msg.textContent = err.message === 'Invalid login credentials' ? 'Email 或密碼錯誤' : err.message;
    } finally {
      submit.disabled = false;
    }
  };

  $('#auth-forgot').onclick = async () => {
    if (!sb) return;
    const email = form.email.value.trim();
    if (!email) return (msg.textContent = '請先輸入 Email');
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.href.split('#')[0] });
    msg.textContent = error ? error.message : '已寄出重設密碼信，點信裡的連結回到這裡後會請你輸入新密碼。';
  };
}

async function setUser(user) {
  const changedUser = (user?.id ?? null) !== (state.user?.id ?? null);
  state.user = user;
  $('#auth-view').hidden = !!user;
  $('#app-view').hidden = !user;
  if (user && changedUser) {
    state.tab = 'overview';
    await refresh();
  }
}

async function init() {
  bindAuth();
  bindNav();
  await loadTwStocks();

  if (!sb) {
    $('#config-warning').hidden = false;
    $('#auth-view').hidden = false;
    return;
  }

  const { data: { session } } = await sb.auth.getSession();
  await setUser(session?.user ?? null);

  sb.auth.onAuthStateChange((event, session) => {
    setTimeout(async () => {
      if (event === 'PASSWORD_RECOVERY') {
        const pw = prompt('請輸入新密碼（至少 6 碼）');
        if (pw) {
          const { error } = await sb.auth.updateUser({ password: pw });
          toast(error ? error.message : '密碼已更新');
        }
      }
      setUser(session?.user ?? null);
    }, 0);
  });
}

init();
