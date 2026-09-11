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
  themeInfo: [],
  valuation: [],   // 我的持股估值（本益比等）
  themeVal: [],    // 各族群本益比中位數
  riskStats: [],   // 報酬/波動計分
  usStats: [], usThemeTrend: [], usThemeMembers: [],
  themeMeta: [], themeLinks: [],   // 產業樹與供應鏈關係
  themeDay: [],    // 今天哪個族群在動
  alerts: [],      // 處置股與注意股
  screen: null,    // 選股條件
  screenRows: [], screenBusy: false,   // 選股結果（伺服器端篩，一次回 60 檔）
  etfBoard: null, etfBusy: false,     // 主動型 ETF：成績與族群傾向，進到那一頁才抓
  etfScope: 'tw', etfOpen: '',        // 看哪一組、展開哪一檔
  screenOpen: false,                  // 選股條件面板要不要展開
  mapPick: null, mapGroup: '',        // 產業地圖：選中的族群、大類篩選
  mapBound: false, mapResizeT: null,  // 桌機版重畫連線用
  mapLit: null,                       // 選中時整條路徑上的族群
  mapOutside: null, mapEsc: null,     // 點外面／Esc 關閉浮出框
  guest: false,    // 沒登入也可以看族群與產業地圖，但看不到任何個人資料
  themeMarket: 'tw',   // 族群頁看台股還是美股
  themeView: 'list',   // 族群頁：清單還是產業鏈
  histFilter: 'all',   // 紀錄頁：全部 / 當沖 / 波段 / 轉倉
  rules: [],       // 自己定的紀律
  journalDays: [], // 每日心得＋戰績
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

// 一筆交易屬於哪一類。轉倉要獨立出來，因為它的「已實現損益」
// 只是把原本就存在的未實現損益入帳，不是今天做出來的績效。
// 實例：2026-09-10 台玻轉倉一筆就 -130,020，跟當天當沖 +34,500 混在一起看，
// 會誤以為當沖在虧錢，其實剛好相反。
const tradeCategory = (t) =>
  String(t.note || '').startsWith('轉倉') ? 'roll'
    : t.is_day_trade ? 'day' : 'swing';

const CAT_LABEL = { day: '當沖', swing: '波段', roll: '轉倉' };

// 一筆交易的淨損益（已扣手續費與交易稅）
function tradeNet(t, rs) {
  const c = costTwd(t, !!t.is_day_trade);
  const m = t.is_day_trade ? rs.perTrade.get(t.id) : null;
  const r = m ? m.pl * (m.ccy === 'USD' ? num(state.settings.usd_twd) : 1) : realizedTwd(t);
  return { net: (r ?? 0) - c, cost: c, matched: m };
}

function realizedSummary() {
  const { perTrade, openLeft } = matchDayTrades(state.trades);
  const byDate = new Map();
  const add = (d, v) => byDate.set(d, (byDate.get(d) || 0) + v);
  const twd = (v, ccy) => v * (ccy === 'USD' ? num(state.settings.usd_twd) : 1);
  let gross = 0, dayNet = 0, swingNet = 0, rollNet = 0, closes = 0, cost = 0;

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
      const cat = tradeCategory(t);
      if (cat === 'day') dayNet += v; else if (cat === 'roll') rollNet += v; else swingNet += v;
      add(t.trade_date, v);
    }
    // 成本：每一筆都算，買進也有手續費
    const c = costTwd(t, !!t.is_day_trade);
    cost += c;
    add(t.trade_date, -c);
    const cc = tradeCategory(t);
    if (cc === 'day') dayNet -= c; else if (cc === 'roll') rollNet -= c; else swingNet -= c;
  }

  const dates = [...byDate.keys()].sort();
  let cum = 0;
  const series = dates.map((d) => { cum += byDate.get(d); return { date: d, daily: byDate.get(d), cum }; });
  return { gross, cost, total: gross - cost, day: dayNet, swing: swingNet, roll: rollNet, closes, series,
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

  // 破戒前先讓你停一秒。不阻止，只是要你自己按下去。
  const breaks = checkRules(v);
  if (breaks.length) {
    const NL = String.fromCharCode(10);
    const msg = breaks.map((x, i) => `${i + 1}. ${x.text}${NL}   ${x.why}`).join(NL + NL);
    if (!confirm(`這筆會違反你自己定的規則：${NL}${NL}${msg}${NL}${NL}還是要記錄嗎？`)) return;
  }

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
    if (breaks.length) {
      // 留下證據，心得頁才算得出守規天數
      await sb.from('rule_breaks').insert(breaks.map((x) => ({
        user_id: state.user.id, break_date: v.trade_date, kind: x.kind, detail: x.text,
      })));
    }
    await refresh(breaks.length ? '已記錄，但違反了 ' + breaks.length + ' 條規則' : '交易已記錄，部位已更新');
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
// 訪客模式：只有市場資料那幾張表對匿名開放（見 supabase/public_read.sql），
// 個人資料表連查都不用查，查了也只會拿到空陣列。
async function loadMarketOnly() {
  const results = await Promise.all([
    sb.rpc('theme_trend', { p_months: 1 }),
    sb.rpc('theme_members', {}),
    sb.from('theme_info').select('*'),
    sb.rpc('theme_valuation', {}),
    sb.rpc('app_risk', {}),
    sb.rpc('us_theme_trend', {}),
    sb.rpc('us_theme_members', {}),
    sb.from('theme_meta').select('*'),
    sb.from('theme_links').select('*'),
    sb.rpc('theme_day', {}),
    sb.rpc('active_alerts', { p_days: 10 }),
  ]);
  for (const r of results) if (r.error && r.error.code !== '42P01') throw r.error;
  const [trend, members, tinfo, tval, arisk, utrend, umem, tmeta, tlinks, tday, alerts] = results;
  const risk = { data: (arisk.data ?? []).filter((r) => r.market === 'tw') };
  const ustat = { data: (arisk.data ?? []).filter((r) => r.market === 'us') };
  state.settings = { ...DEFAULT_SETTINGS };
  state.themeTrend = trend.data ?? [];
  state.themeMembers = members.data ?? [];
  state.themeInfo = tinfo.data ?? [];
  state.themeVal = tval.data ?? [];
  state.riskStats = risk.data ?? [];
  state.usStats = ustat.data ?? [];
  state.usThemeTrend = utrend.data ?? [];
  state.usThemeMembers = umem.data ?? [];
  state.themeMeta = tmeta.data ?? [];
  state.themeLinks = tlinks.data ?? [];
  state.themeDay = tday.data ?? [];
  state.alerts = alerts.data ?? [];
}

async function loadAll() {
  if (state.guest) return loadMarketOnly();
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
    sb.from('theme_info').select('*'),
    sb.rpc('my_valuation', {}),
    sb.rpc('theme_valuation', {}),
    // **不要整批 select risk_stats/us_stats**：它們現在各有兩千列，
    // PostgREST 預設只回前 1,000 列，會安靜地截斷，
    // 症狀是有些股票的報酬/波動莫名變成「–」。app_risk() 只回真的用得到的那幾百檔。
    sb.rpc('app_risk', {}),
    sb.rpc('us_theme_trend', {}),
    sb.rpc('us_theme_members', {}),
    sb.from('theme_meta').select('*'),
    sb.from('theme_links').select('*'),
    sb.rpc('theme_day', {}),
    sb.rpc('active_alerts', { p_days: 10 }),
    sb.from('rules').select('*').eq('active', true).order('sort'),
    sb.rpc('journal_days', { p_limit: 120 }),
    sb.from('price_status').select('market,as_of,updated_at,symbols'),
  ]);
  for (const r of results) if (r.error && r.error.code !== '42P01') throw r.error;
  const [st, stocks, futures, us, balances, snaps, trades, opts, wars, ivh, fwds, trend, members, tinfo, val, tval, arisk, utrend, umem, tmeta, tlinks, tday, alerts, rules, jdays, prices] = results;
  const risk = { data: (arisk.data ?? []).filter((r) => r.market === 'tw') };
  const ustat = { data: (arisk.data ?? []).filter((r) => r.market === 'us') };
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
  state.themeInfo = tinfo.data ?? [];
  state.valuation = val.data ?? [];
  state.themeVal = tval.data ?? [];
  state.riskStats = risk.data ?? [];
  state.usStats = ustat.data ?? [];
  state.usThemeTrend = utrend.data ?? [];
  state.usThemeMembers = umem.data ?? [];
  state.themeMeta = tmeta.data ?? [];
  state.themeLinks = tlinks.data ?? [];
  state.themeDay = tday.data ?? [];
  state.alerts = alerts.data ?? [];
  state.rules = rules.data ?? [];
  state.journalDays = jdays.data ?? [];
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
  ['war', '權證認購'], ['warp', '權證認售'], ['fx', '匯率'], ['us', '美股'],
  ['val', '估值'], ['rev', '月營收'], ['fin', '季報'], ['est', '分析師預估'],
  ['risk', '報酬/波動'], ['usx', '美股產業'], ['sync', '套用到持倉'],
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
    <div class="seg side-seg">
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
    <div class="seg side-seg">
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
    <div class="seg side-seg">
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

      const updatePreviewRaw = () => {
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

      // 規則檢查放在最上面，因為手癢是在按下確定那一刻發生的。
      // 不擋存檔，但要讓你看見自己正在破自己定的戒。
      const updatePreview = () => {
        updatePreviewRaw();
        const v = readTradeForm(new FormData(form));
        const rb = checkRules(v);
        if (!rb.length) return;
        preview.hidden = false;
        preview.insertAdjacentHTML('afterbegin', rb.map((x) =>
          `<div class="break-item"><b>違反自己的規則：</b>${esc(x.text)}<br><span class="muted">${esc(x.why)}</span></div>`
        ).join(''));
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
const TITLES = { overview: '總覽', holdings: '持倉', funds: '資金', themes: '族群', journal: '心得', history: '紀錄', settings: '設定' };

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
// info 是 "tw:2330" 這種字串，有填就在標題後面掛一顆 ⓘ 開個股速覽。
// 不能用 <button> 包 <button>，所以那顆是 span，點下去要自己擋住冒泡免得變成編輯。
const itemRow = (kind, id, title, sub, right, right2 = '', info = '') =>
  `<button type="button" class="item" data-edit="${kind}" data-id="${id}">
    <span class="item-main"><span class="item-title">${title}${
      info ? `<span class="info-dot" role="button" tabindex="0" data-info="${esc(info)}" title="看這一檔的狀態">ⓘ</span>` : ''
    }</span><span class="item-sub">${sub}</span></span>
    <span class="item-right"><span>${right}</span><span class="item-sub">${right2}</span></span>
  </button>`;
const tradeButton = () =>
  `<button type="button" class="primary block" data-trade>＋ 記一筆交易（買 / 賣）</button>` +
  // 轉倉本來只放在期貨卡片右下角，又小又暗還要往下捲，實測找不到。
  // 它在使用者心裡是「一種交易」，就該放在記一筆交易旁邊。
  (state.futures.length
    ? `<button type="button" class="block roll-btn" data-roll>⇄ 期貨轉倉（先平近月，再建遠月）</button>`
    : '');

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
  $$('[data-info]', el).forEach((b) => (b.onclick = (e) => {
    e.preventDefault(); e.stopPropagation();
    const [mk, sym] = b.dataset.info.split(':');
    openStock(mk, sym);
  }));
  $$('[data-trade]', el).forEach((b) => (b.onclick = () => logTrade()));
  $$('[data-roll]', el).forEach((b) => (b.onclick = () => rollFutures(b.dataset.roll || null)));
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
    ${(() => {
      // 持倉裡有被交易所盯上的就要先講。等他自己去點開個股才發現就太晚了。
      const as = heldAlerts();
      if (!as.length) return '';
      return `<div class="card alert-card">
        <div class="list-title">交易所警示　<span class="sub muted">${fmt(as.length)} 檔</span></div>
        ${as.map((a) => `<div class="row-between alert-row" role="button" tabindex="0"
            data-stock="tw:${esc(norm(a.symbol))}">
          <span>${alertBadge(a)}<b>${esc(a.symbol)}</b> ${esc(a.name || '')}</span>
          <span class="sub muted">${esc(a.kind === 'punish'
            ? `${a.start_d || ''}～${a.end_d || ''}`
            : num(a.notices) > 0 ? `近 30 天 ${fmt(a.notices)} 次注意` : ALERT_LABEL[a.kind])}</span>
        </div>`).join('')}
        <p class="hint">處置期間改成<b>人工撮合</b>，間隔從 2 分鐘到 45 分鐘都有；
          達到門檻的委託還要<b>圈存</b>——買進先付全部價金、賣出先有券，
          <b>當沖等於做不成</b>。門檻與間隔每一檔不一樣，點一列看那一檔的公告原文。</p>
      </div>`;
    })()}
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
  bindStockOpen(el);
}

// ------------------------------------------------------------
// 估值
//   近四季本益比：證交所與櫃買中心每天公告，是用「已經發生」的獲利算的，是事實。
//   26/27/28 年本益比：現價 ÷ 預估 EPS。台灣沒有免費的分析師共識 API，
//     所以預估 EPS 是存在資料庫裡人工維護的，而股價每天自動更新，
//     因此比值每天都會變，但分母的品質取決於那個預估準不準。
//   虧損的公司沒有本益比，顯示「虧損」而不是 0，因為 0 會讓人誤以為很便宜。
// ------------------------------------------------------------
const valOf = (symbol) => state.valuation.find((v) => norm(v.symbol) === norm(symbol)) || null;
const peLabel = (pe) => (isNum(pe) ? `${fmtMax(pe, 1)}x` : '虧損');
const themePe = (theme) => state.themeVal.find((t) => t.theme === theme) || null;

// ------------------------------------------------------------
// 報酬 ÷ 波動
//   「這檔漲很多」最會騙人。實測 2022-2026，金居買進持有 7.79 倍看起來很猛，
//   但波動 52% 讓風險等價槓桿只能開 0.81 倍，套上同一條規則後只有 4.03 倍，
//   反而輸給加權指數的 7.75 倍。**漲得多不等於賺得多。**
//   所以用加權指數的比值當及格線：低於它的個股，不如直接開槓桿買指數。
// ------------------------------------------------------------
const riskOf = (symbol) => state.riskStats.find((r) => norm(r.symbol) === norm(symbol)) || null;
const idxRatio = () => num(state.riskStats.find((r) => r.symbol === 'TAIEX')?.ratio);
const beatsIdx = (ratio) => isNum(ratio) && isNum(idxRatio()) && num(ratio) > idxRatio();

const FWD_YEARS = [
  [2026, 'fy2026', 'eps2026', 'conf2026', 'an2026'],
  [2027, 'fy2027', 'eps2027', 'conf2027', 'an2027'],
  [2028, 'fy2028', 'eps2028', 'conf2028', 'an2028'],
];

function valuationRow(v) {
  const usd = v.ccy === 'USD';
  const cur = usd ? 'US$ ' : '';
  // 可信度逐年標。同一檔的 2026 可能有 9 位分析師、2028 只剩 1 位，
  // 標同一個等級會讓人以為那三個數字一樣可靠。
  const fwd = FWD_YEARS.map(([y, pk, ek, ck, ak]) => {
    const pe = v[pk], eps = v[ek], conf = v[ck], an = v[ak];
    if (!isNum(pe)) return `<span class="fwd-pe muted"><b>${String(y).slice(2)}F</b> –</span>`;
    const weak = conf === 'low';
    return `<span class="fwd-pe${weak ? ' weak' : ''}"><b>${String(y).slice(2)}F</b> ${fmtMax(pe, 1)}x`
      + ` <span class="muted">(EPS ${cur}${fmtMax(eps, 2)}${isNum(an) ? `・${fmt(an)}人` : ''})</span>`
      + `${weak ? '<span class="warn-mark" title="樣本太少或無具名機構">⚠</span>' : ''}</span>`;
  }).join('');
  const anyFwd = FWD_YEARS.some(([, pk]) => isNum(v[pk]));
  return `<button type="button" class="item" data-eps="${esc(v.symbol)}" data-nm="${esc(v.name || '')}">
    <span class="item-main">
      <span class="item-title">${esc(v.symbol)} ${esc(v.name || '')}<span class="badge">${esc(v.held || '')}</span>${
        v.mine ? '<span class="badge day-badge">自填預估</span>' : ''}${
        v.confidence === 'low' ? '<span class="badge warn-badge">無分析師覆蓋</span>'
        : v.confidence === 'medium' ? '<span class="badge">覆蓋薄</span>' : ''}</span>
      <span class="item-sub">現價 ${cur}${fmtMax(v.price, 2)}　${isNum(v.pb) ? `PB ${fmtMax(v.pb, 2)}　` : ''}${
        isNum(v.dy) ? `殖利率 ${fmtMax(v.dy, 2)}%` : ''}${
        usd ? '<span class="muted">近四季本益比無免費來源</span>' : ''}</span>
      <span class="item-sub fwd-row">${fwd}</span>
      ${(() => { const k = riskOf(v.symbol); return k && isNum(k.ratio)
        ? `<span class="item-sub">報酬/波動 <b class="${beatsIdx(k.ratio) ? 'gain' : ''}">${fmtMax(k.ratio, 2)}</b>${
            beatsIdx(k.ratio) ? '<span class="badge day-badge">贏指數</span>'
            : `<span class="muted">（指數 ${fmtMax(idxRatio(), 2)}）</span>`}　波動 ${
            (num(k.vol) * 100).toFixed(0)}%　三年 ${signed(num(k.cagr) * 100, 0)}%/年</span>`
        : ''; })()}
      ${isNum(v.ytd_eps) ? `<span class="item-sub">${esc(String(v.ytd_fy))} 前 ${esc(String(v.ytd_q))} 季已實現 EPS ${
        fmtMax(v.ytd_eps, 2)}${isNum(v.ytd_pct)
          ? `　<b class="${num(v.ytd_pct) < 40 ? 'loss' : ''}">達成率 ${fmtMax(v.ytd_pct, 0)}%</b>` : ''}</span>` : ''}
      ${anyFwd && v.eps_src ? `<span class="item-sub muted">預估來源：${esc(v.eps_src)}${
        isNum(v.analysts) ? `　${fmt(v.analysts)} 位分析師` : ''}${
        v.eps_checked ? `　${esc(v.eps_checked)}` : ''}</span>` : ''}
    </span>
    <span class="item-right"><span>${usd ? '–' : peLabel(v.pe)}</span><span class="item-sub">近四季</span></span>
  </button>`;
}

function valuationCard() {
  if (!state.valuation.length) return '';
  const asOf = state.valuation.map((v) => v.as_of).filter(Boolean).sort().pop();
  const missing = state.valuation.filter((v) => !FWD_YEARS.some(([, pk]) => isNum(v[pk])));
  return `<div class="card">
    <div class="row-between">
      <span class="list-title">估值</span>
      <span class="sub muted">${asOf ? esc(asOf) : ''}</span>
    </div>
    ${state.valuation.map(valuationRow).join('')}
    <p class="hint"><b>近四季本益比</b>由證交所與櫃買中心每日公告，是已經發生的獲利算出來的，自動更新。
      <b>26/27/28 是用預估 EPS 算的</b>：股價每天更新所以比值每天變，但預估 EPS 沒有免費 API，要自己維護。
      點任一列可以填入你自己的預估，填了就以你的為準。
      複委託的美股沒有免費的近四季本益比來源（Yahoo 的估值端點已經要驗證），但股價一樣每天更新，
      所以自己填了預估 EPS，預估本益比照樣會每天重算。
      ${missing.length ? `目前 ${missing.map((v) => esc(v.symbol)).join('、')} 還沒有預估值。` : ''}
      <b>覆蓋度差很多，而且同一檔的不同年度也差很多。</b>台積電有 42 位分析師在報，台玻是 0 位；
      和碩 2026 與 2027 有 9 位，2028 只剩 1 位。所以人數逐年標在括號裡，
      標 ⚠ 的代表樣本太少或沒有具名機構，那格請當它是傳聞不是預估。
      <b>達成率</b>是年初至今已實現 EPS ÷ 當年度預估：半年報時應該在 50% 上下，
      明顯偏低就代表那個預估在賭下半年大爆發，這件事光看本益比是看不出來的。
      預估本益比的分母是別人的猜測，不同券商的 2028 年 EPS 可以差一倍，別當成事實看。
      <b>報酬/波動</b>是三年年化報酬除以年化波動，及格線是加權指數。低於指數代表你承受的波動
      換不到相稱的報酬，那不如直接開槓桿買指數，還省下選錯的風險。</p>
  </div>`;
}

async function editEps(symbol, name) {
  const v = valOf(symbol) || {};
  const unit = v.ccy === 'USD' ? '美元' : '元';
  const res = await openForm({
    title: `${symbol} ${name || ''} 預估 EPS`,
    fields: [
      { key: 'eps2026', label: `2026 預估 EPS（${unit}，留空就用內建參考值）`, type: 'number' },
      { key: 'eps2027', label: `2027 預估 EPS（${unit}）`, type: 'number' },
      { key: 'eps2028', label: `2028 預估 EPS（${unit}）`, type: 'number' },
      { key: 'note', label: '備註：哪一家券商、什麼時候看到的', type: 'text' },
    ],
    values: { eps2026: v.mine ? v.eps2026 : null, eps2027: v.mine ? v.eps2027 : null,
              eps2028: v.mine ? v.eps2028 : null, note: '' },
  });
  if (!res || res.action !== 'save') return;
  try {
    const rows = FWD_YEARS.map(([fy]) => ({
      user_id: state.user.id, symbol: norm(symbol), fy,
      eps: res.values['eps' + fy], note: res.values.note,
      updated_at: new Date().toISOString(),
    }));
    const { error } = await sb.from('eps_override').upsert(rows, { onConflict: 'user_id,symbol,fy' });
    if (error) throw error;
    await refresh('已儲存預估 EPS');
  } catch (e) {
    fail(e);
  }
}

// ------------------------------------------------------------
// 紀律規則
//   規則存在資料庫（rules 表），是使用者資料，程式更新不會動它。
//   這裡只負責「在記錄交易的當下」把違規算出來並顯示。
//   **刻意不阻止存檔**——那是他的錢、他的帳；但違規會被記下來，
//   而且每天在心得頁攤開來。手癢發生在下單那一刻，不是寫日誌的時候。
// ------------------------------------------------------------
const activeRule = (kind) => state.rules.find((r) => r.kind === kind && r.active) || null;

// 今天各標的的當沖淨部位。歸零才算「沖完」。
function dayNet(dateISO, market, extra) {
  const net = new Map();
  const feed = extra ? [...state.trades, extra] : state.trades;
  for (const t of feed) {
    if (!t.is_day_trade || t.trade_date !== dateISO || t.market !== market) continue;
    const k = market === 'tw' ? resolveTwSymbol(t.symbol) : tradeKey(t);
    net.set(k, num(net.get(k)) + (t.side === 'buy' ? 1 : -1) * num(t.quantity));
  }
  for (const [k, v] of [...net]) if (Math.abs(v) < 1e-9) net.delete(k);
  return net;
}

// 一筆交易（可以是還沒存檔的）違反了哪些規則
function checkRules(t) {
  const out = [];
  if (!t || !state.rules.length) return out;

  const hedge = activeRule('opt_only_hedge');
  if (hedge && t.market === 'option') {
    const banned = (t.side === 'buy' && t.opt_cp === 'call') || (t.side === 'sell' && t.opt_cp === 'put');
    if (banned) {
      out.push({
        kind: 'opt_only_hedge',
        text: `${t.side === 'buy' ? '買進' : '賣出'}${cpLabel(t.opt_cp)}違反「只做 buy put 與 sell call」`,
        why: '結算日手癢的 buy call 是這三個月最大的破口，這條沒有例外。',
      });
    }
  }

  const cap = activeRule('day_max_amount');
  if (cap && t.is_day_trade && t.market === 'tw' && isNum(cap.amount)) {
    const amt = num(t.quantity) * num(t.price);
    if (amt > num(cap.amount)) {
      out.push({
        kind: 'day_max_amount',
        text: `這筆 ${fmt(amt)} 元，超過單檔當沖上限 ${fmt(cap.amount)} 元（${(amt / num(cap.amount)).toFixed(1)} 倍）`,
        why: '上限是「完全做錯也還在」的金額，不是「這檔我很有把握」的金額。',
      });
    }
  }

  const one = activeRule('day_one_at_a_time');
  if (one && t.is_day_trade && t.market === 'tw') {
    const me = resolveTwSymbol(t.symbol);
    const open = [...dayNet(t.trade_date, 'tw').keys()].filter((k) => k !== me);
    if (open.length) {
      out.push({
        kind: 'day_one_at_a_time',
        text: `${open.map((k) => `${k} ${TW_STOCKS[k] || ''}`).join('、')} 還沒沖完就開新的一檔`,
        why: '同時開兩檔就是注意力不夠，而注意力不夠正是當沖唯一會致命的地方。',
      });
    }
  }
  return out;
}

// 掃某一天已經記錄的交易，回報違規。用於心得頁的每日檢討。
function breaksOn(dateISO) {
  const out = [];
  const day = state.trades.filter((t) => t.trade_date === dateISO);
  const hedge = activeRule('opt_only_hedge');
  const cap = activeRule('day_max_amount');
  const one = activeRule('day_one_at_a_time');

  if (hedge && dateISO >= hedge.started_on) {
    const bad = day.filter((t) => t.market === 'option'
      && ((t.side === 'buy' && t.opt_cp === 'call') || (t.side === 'sell' && t.opt_cp === 'put')));
    if (bad.length) {
      const prem = bad.reduce((a, t) => a + num(t.quantity) * num(t.price) * OPT_SIZE, 0);
      out.push({ kind: 'opt_only_hedge',
        text: `選擇權違規 ${bad.length} 筆，權利金合計 ${fmt(prem)} 元`,
        detail: bad.map((t) => `${t.side === 'buy' ? '買進' : '賣出'}${cpLabel(t.opt_cp)} ${fmt(t.quantity)} 口 @ ${fmtMax(t.price, 2)}`).join('、') });
    }
  }
  if (cap && isNum(cap.amount) && dateISO >= cap.started_on) {
    const bad = day.filter((t) => t.is_day_trade && t.market === 'tw'
      && num(t.quantity) * num(t.price) > num(cap.amount));
    if (bad.length) {
      out.push({ kind: 'day_max_amount',
        text: `當沖單檔超過 ${fmt(cap.amount)} 元共 ${bad.length} 筆`,
        detail: bad.map((t) => `${resolveTwSymbol(t.symbol)} ${TW_STOCKS[resolveTwSymbol(t.symbol)] || ''} ${fmt(num(t.quantity) * num(t.price))}`).join('、') });
    }
  }
  if (one && dateISO >= one.started_on) {
    // 依時間重播，只要在還有未沖完部位時開了另一檔就算違規
    const list = day.filter((t) => t.is_day_trade && t.market === 'tw')
      .sort((a, b) => (String(a.created_at) < String(b.created_at) ? -1 : 1));
    const net = new Map(); const hit = new Set();
    for (const t of list) {
      const k = resolveTwSymbol(t.symbol);
      const others = [...net].filter(([kk, v]) => kk !== k && Math.abs(v) > 1e-9).map(([kk]) => kk);
      if (!net.has(k) && others.length) others.forEach((o) => hit.add(`${o} → ${k}`));
      net.set(k, num(net.get(k)) + (t.side === 'buy' ? 1 : -1) * num(t.quantity));
    }
    if (hit.size) {
      out.push({ kind: 'day_one_at_a_time',
        text: `同時開了不只一檔當沖 ${hit.size} 次`, detail: [...hit].join('、') });
    }
  }
  return out;
}

// ------------------------------------------------------------
// 期貨轉倉
//   轉倉的本質：**部位沒有變，但成本基礎重設，而且近月的損益要實現。**
//   多單轉倉 = 賣掉近月 + 買進遠月，口數一樣；空單反過來。
//   順序有差，要先平倉再建倉，否則均價會算錯。
//
//   要分清楚兩件常被混為一談的事：
//     平倉實現損益  這筆虧損早就存在了（未實現），轉倉只是讓它變成已實現。
//     轉倉真正的成本  只有「遠月與近月的價差」加上兩邊的手續費與交易稅。
//   把 8 萬的實現虧損說成「轉倉成本」會嚇到自己，而且是錯的。
// ------------------------------------------------------------
function rollPreview(v) {
  const dir = v.isLong ? 1 : -1;
  const notionalNear = v.lots * v.nearPx * v.size;
  const notionalFar = v.lots * v.farPx * v.size;
  // 平倉那筆的實現損益：多單是（賣價 − 成本），空單相反
  const realized = isNum(v.cost) ? (v.nearPx - v.cost) * dir * v.lots * v.size : null;
  // 轉倉價差：多單要賣近月買遠月，遠月比近月貴就是成本
  const spread = (v.farPx - v.nearPx) * dir * v.lots * v.size;
  const legClose = tradeCost({ market: 'futures', quantity: v.lots, price: v.nearPx,
                               fut_size: v.size, side: v.isLong ? 'sell' : 'buy' }, false);
  const legOpen = tradeCost({ market: 'futures', quantity: v.lots, price: v.farPx,
                              fut_size: v.size, side: v.isLong ? 'buy' : 'sell' }, false);
  const fee = legClose.fee + legOpen.fee;
  const tax = legClose.tax + legOpen.tax;
  return { realized, spread, fee, tax, cost: spread + fee + tax, notionalNear, notionalFar };
}

async function rollFutures(preId) {
  const list = state.futures;
  if (!list.length) return toast('沒有期貨部位可以轉倉', 3000);

  const opt = (f) => {
    const nm = f.contract || futDisplayName(f.kind, f.symbol, f.size);
    return `<option value="${esc(f.id)}">${esc(nm)}　${f.side === 'short' ? '空' : '多'} ${
      fmtMax(f.lots, 2)} 口</option>`;
  };
  const html = `
    <label>要轉倉的部位<select name="pid">${list.map(opt).join('')}</select></label>
    <label>口數（可以只轉一部分）<input name="lots" type="number" step="any" inputmode="decimal" required min="0"></label>
    <label>近月成交價（平倉這一邊）<input name="near" type="number" step="any" inputmode="decimal" required></label>
    <label>遠月成交價（建倉這一邊）<input name="far" type="number" step="any" inputmode="decimal" required></label>
    <label>日期<input name="trade_date" type="date" value="${todayISO()}" required></label>
    <label>備註<input name="note" type="text" placeholder="例如 9 月轉 10 月" autocomplete="off"></label>
    <div class="preview" data-preview hidden></div>`;

  const res = await openDialog({
    title: '期貨轉倉',
    html,
    onMount: (form) => {
      const preview = $('[data-preview]', form);
      const cur = () => list.find((x) => String(x.id) === String(form.pid.value)) || list[0];
      const syncLots = () => { form.lots.value = num(cur().lots); };
      const draw = () => {
        const f = cur();
        const lots = num(form.lots.value), near = num(form.near.value), far = num(form.far.value);
        if (!(lots > 0) || !(near > 0) || !(far > 0)) { preview.hidden = true; return; }
        const v = { isLong: f.side !== 'short', lots, size: num(f.size),
                    cost: isNum(f.cost) ? num(f.cost) : null, nearPx: near, farPx: far };
        const p = rollPreview(v);
        const over = lots > num(f.lots) + 1e-9;
        preview.hidden = false;
        preview.classList.toggle('err', over);
        preview.innerHTML = over
          ? `口數超過持有的 ${fmtMax(f.lots, 2)} 口`
          : `${v.isLong ? '賣出' : '買回'}近月 ${fmtMax(lots, 2)} 口 @ ${fmtMax(near, 2)}，` +
            `再${v.isLong ? '買進' : '賣出'}遠月 @ ${fmtMax(far, 2)}<br>` +
            `<b>轉倉成本 ${fmt(p.cost)} 元</b>` +
            `<span class="muted">（價差 ${signed(p.spread)}　手續費 ${fmt(p.fee)}　交易稅 ${fmt(p.tax)}）</span><br>` +
            (p.realized === null
              ? '<span class="muted">原部位沒填成本，不會產生實現損益</span>'
              : `同時實現原本的未實現損益 <span class="${plClass(p.realized)}">${signed(p.realized)}</span>` +
                `<span class="muted">（均價 ${fmtMax(v.cost, 2)} → ${fmtMax(far, 2)}）</span>`) +
            `<br><span class="muted">部位不變，仍是 ${f.side === 'short' ? '空' : '多'} ${
              fmtMax(f.lots, 2)} 口。實現損益早就存在，轉倉只是讓它入帳；真正的成本只有上面那一行。</span>`;
      };
      form.pid.onchange = () => { syncLots(); draw(); };
      $$('input', form).forEach((i) => (i.oninput = draw));
      syncLots();
      if (preId) { form.pid.value = String(preId); syncLots(); }
      draw();
    },
    collect: (fd) => {
      const f = list.find((x) => String(x.id) === String(fd.get('pid')));
      const lots = num(fd.get('lots'));
      if (!f || !(lots > 0)) return undefined;
      if (lots > num(f.lots) + 1e-9) { toast('口數超過持有量', 3000); return undefined; }
      return { f, lots, near: num(fd.get('near')), far: num(fd.get('far')),
               trade_date: fd.get('trade_date') || todayISO(),
               note: String(fd.get('note') || '').trim() || null };
    },
  });
  if (!res || res.action !== 'save') return;

  const { f, lots, near, far, trade_date, note } = res.values;
  const isLong = f.side !== 'short';
  const base = {
    kindKey: f.kind === 'stock' ? 'fut_stock' : 'fut_index',
    market: 'futures', fut_kind: f.kind, fut_size: num(f.size),
    is_day_trade: false, trade_date,
    symbol: f.symbol, name: f.name || TW_STOCKS[norm(f.symbol)] || null, quantity: lots,
  };
  try {
    // **順序不能反。**先平倉才會用舊均價算出實現損益，
    // 先建倉的話均價會先被拉走，實現損益就錯了。
    await saveTrade({ ...base, side: isLong ? 'sell' : 'buy', price: near,
                      note: note ? `轉倉平倉・${note}` : '轉倉平倉' });
    await saveTrade({ ...base, side: isLong ? 'buy' : 'sell', price: far,
                      note: note ? `轉倉建倉・${note}` : '轉倉建倉' });
    toast('轉倉完成，已記錄兩筆', 3000);
  } catch (e) {
    fail(e);
  }
}

function renderHoldings(el) {
  const c = compute();
  const stockRows = state.stocks.map((s) => {
    const v = num(s.shares) * num(s.price);
    const pl = isNum(s.cost) ? v - num(s.shares) * num(s.cost) : null;
    return itemRow('stock', s.id,
      `${esc(s.symbol)} ${esc(s.name || '')}${alertBadge(alertOf(s.symbol))}${
        twKnown(s.symbol) ? '' : '<span class="badge warn-badge">價格不會自動更新</span>'}`,
      `${fmtQty('tw', s.shares)} × ${fmtMax(s.price, 2)}${isNum(s.cost) ? `　均價 ${fmtMax(s.cost, 2)}` : ''}`,
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
      `${fmtMax(f.lots, 2)} 口 × ${fmtMax(f.price, 2)} × ${fmt(f.size)}${isStock ? ' 股' : ' 元/點'}${
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
      <div class="grid4">
        <div class="mini"><div class="label">淨損益</div><div class="value ${plClass(rs.total)}">${signed(rs.total)}</div></div>
        <div class="mini"><div class="label">當沖</div><div class="value ${plClass(rs.day)}">${signed(rs.day)}</div></div>
        <div class="mini"><div class="label">波段</div><div class="value ${plClass(rs.swing)}">${signed(rs.swing)}</div></div>
        <div class="mini"><div class="label">轉倉</div><div class="value ${plClass(rs.roll)}">${signed(rs.roll)}</div></div>
      </div>
      <p class="sub muted" style="margin-top:6px">轉倉單獨一格，因為它的已實現損益只是把
        <b>原本就存在的未實現損益入帳</b>，不是那天做出來的績效。混在波段裡會看錯。</p>
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
      <div class="row-between">
        <span class="list-title">歷史交易紀錄</span>
        <span class="sub muted">${(() => {
          const f = state.histFilter || 'all';
          const n = trades.filter((t) => f === 'all' || tradeCategory(t) === f).length;
          return `${fmt(n)} 筆`;
        })()}</span>
      </div>
      <div class="seg nav-seg hist-seg">${[['all', '全部'], ['day', '當沖'], ['swing', '波段'], ['roll', '轉倉']]
        .map(([v, l]) => {
          const n = trades.filter((t) => v === 'all' || tradeCategory(t) === v).length;
          return `<label><input type="radio" name="histf" value="${v}" ${
            (state.histFilter || 'all') === v ? 'checked' : ''}><span>${l} ${fmt(n)}</span></label>`;
        }).join('')}</div>
      ${(() => {
        const f = state.histFilter || 'all';
        const shown = trades.filter((t) => f === 'all' || tradeCategory(t) === f);
        if (!shown.length) return '<p class="muted">這個分類沒有紀錄。</p>';
        // 依日期分組，每天給小計。原本全部混在一起，
        // 台玻轉倉的 -130,020 跟當天當沖 +34,500 疊在一起完全看不出發生什麼事。
        const days = [];
        for (const t of shown) {
          if (!days.length || days[days.length - 1].d !== t.trade_date) days.push({ d: t.trade_date, list: [] });
          days[days.length - 1].list.push(t);
        }
        return days.map((g) => {
          const sub = g.list.reduce((a, t) => a + tradeNet(t, rs).net, 0);
          return `<div class="day-group">
            <div class="row-between day-head">
              <span><b>${esc(g.d)}</b><span class="muted">　${fmt(g.list.length)} 筆</span></span>
              <span class="${plClass(sub)}">${signed(sub)}</span>
            </div>
            ${g.list.map((t) => {
              const { net, cost, matched } = tradeNet(t, rs);
              const cat = tradeCategory(t);
              return `<button type="button" class="item" data-del-trade="${t.id}">
                <span class="item-main">
                  <span class="item-title"><span class="trade-side ${t.side}">${t.side === 'buy' ? '買' : '賣'}</span>${
                    t.market === 'option'
                      ? `TXO ${esc(t.opt_expiry)} ${strikeText(t.opt_strike)} ${cpLabel(t.opt_cp)}`
                      : `${esc(t.symbol)} ${esc(t.name || TW_STOCKS[norm(t.symbol)] || '')}`}${
                    cat === 'day' ? '<span class="badge day-badge">當沖</span>'
                    : cat === 'roll' ? '<span class="badge">轉倉</span>' : ''}${
                    t.market !== 'option' && t.symbol
                      ? `<span class="info-dot" role="button" tabindex="0" data-info="${
                          t.market === 'us' ? 'us' : 'tw'}:${esc(norm(t.symbol))}" title="看這一檔的狀態">ⓘ</span>` : ''}</span>
                  <span class="item-sub">${matched
                    ? `沖銷 ${fmtQty(t.market, matched.qty)} @ ${fmtMax(matched.openAvg, 2)} → ${fmtMax(t.price, 2)}・` : ''
                  }${TRADE_KINDS[tradeKindOf(t)]?.label || MARKET_LABEL[t.market] || ''}${
                    t.market === 'futures' && t.fut_kind === 'stock' ? `（${stockFutLabel(t.fut_size)}型）` : ''}${
                    t.note ? '・' + esc(t.note) : ''}</span>
                </span>
                <span class="item-right"><span>${fmtQty(t.market, t.quantity)}</span>
                  <span class="item-sub">@ ${fmtMax(t.price, 2)}</span>
                  <span class="item-sub"><span class="${plClass(net)}">${signed(net)}</span>
                    <span class="muted"> 　成本 ${fmt(cost)}</span></span></span>
              </button>`;
            }).join('')}
          </div>`;
        }).join('');
      })()}
      <p class="hint">上面四個分類可以切換。<b>轉倉</b>的損益是把原本的未實現入帳，不是那天的績效；
        <b>波段</b>是用當時的平均成本結算；<b>當沖</b>是同一組買賣直接配對，不碰長期部位。
        每天右邊是<b>當日該分類的小計</b>。點一筆可刪除並還原部位，要修改請刪除後重新記錄。</p>
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
  $$('input[name=histf]', el).forEach((r) => (r.onchange = () => {
    state.histFilter = r.value;
    renderHistory(el);
  }));
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

// 民國年月往前一個月，用來在速覽裡分辨「上月」與「去年同月」
const rocPrevYm = (ym) => {
  const y = Number(String(ym).slice(0, 3)), m = Number(String(ym).slice(3));
  return m > 1 ? `${y}${String(m - 1).padStart(2, '0')}` : `${y - 1}12`;
};

function renderTwThemes(el) {
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
      const info = state.themeInfo.find((i) => i.theme === t.theme);
      const tv = themePe(t.theme);
      // 整體與小眾差一倍以上，代表頭條數字會嚴重誤導
      const partial = info && isNum(info.cagr) && isNum(info.niche_cagr)
        && num(info.niche_cagr) > num(info.cagr) * 2;
      return `<div class="card theme-card${mine ? ' mine' : ''}" data-theme="${esc(t.theme)}">
        <div class="row-between">
          <span class="list-title">${esc(t.theme)}${mine ? '<span class="badge day-badge">持有</span>' : ''}${
            partial ? '<span class="badge warn-badge">看小眾</span>' : ''}</span>
          <span class="theme-yoy ${plClass(num(t.yoy))}">${signed(num(t.yoy) * 100, 1)}%</span>
        </div>
        <div class="row-between sub muted">
          <span>月營收 ${fmt(num(t.amount) / 100000, 1)} 億</span>
          <span>${fmt(t.members)} 檔・實際營收年增</span>
        </div>
        <div class="row-between sub muted">
          <span>報酬/波動 ${tv && isNum(tv.ratio_median)
            ? `<b class="${num(tv.ratio_median) > idxRatio() ? 'gain' : ''}">${fmtMax(tv.ratio_median, 2)}</b>` : '–'}${
            tv && isNum(tv.vol_median) ? `　波動 ${(num(tv.vol_median) * 100).toFixed(0)}%` : ''}</span>
          <span>${tv ? `${fmt(tv.beat_idx)}/${fmt(tv.total)} 檔贏過指數` : ''}</span>
        </div>
        <div class="row-between sub muted">
          <span>本益比 近四季 ${tv && isNum(tv.pe_median) ? `<b>${fmtMax(tv.pe_median, 1)}x</b>` : '–'}${
            tv && isNum(tv.pe1_median) ? `　${String(tv.fy1).slice(2)}F <b>${fmtMax(tv.pe1_median, 1)}x</b>` : ''}${
            tv && isNum(tv.pe2_median) ? `　${String(tv.fy2).slice(2)}F <b>${fmtMax(tv.pe2_median, 1)}x</b>` : ''}</span>
          <span>${tv ? `${fmt(tv.covered)}/${fmt(tv.total)} 檔有預估` : ''}${
            tv && num(tv.loss) > 0 ? `　<span class="loss">${fmt(tv.loss)} 檔虧損</span>` : ''}</span>
        </div>
        <div class="forecast">
          <div class="row-between sub">
            <span class="muted">整體市場預測</span>
            <span>${info && isNum(info.cagr)
              ? `${(num(info.cagr) * 100).toFixed(1)}%${isNum(info.cagr_low) && num(info.cagr_low) !== num(info.cagr_high)
                  ? ` <span class="muted">(${(num(info.cagr_low) * 100).toFixed(0)}–${(num(info.cagr_high) * 100).toFixed(0)}%)</span>` : ''}`
              : '<span class="muted">未查證</span>'}</span>
          </div>
          ${info?.niche ? `<div class="row-between sub niche">
            <span>${esc(info.niche)}</span>
            <span class="${isNum(info.niche_cagr) ? 'niche-cagr' : 'muted'}">${isNum(info.niche_cagr)
              ? `<b>${(num(info.niche_cagr) * 100).toFixed(1)}%</b>${isNum(info.niche_low) && num(info.niche_low) !== num(info.niche_high)
                  ? ` <span class="muted">(${(num(info.niche_low) * 100).toFixed(0)}–${(num(info.niche_high) * 100).toFixed(0)}%)</span>` : ''}`
              : '未查證'}</span>
          </div>` : ''}
        </div>
        <div class="theme-body" hidden></div>
      </div>`;
    }).join('')}
    <p class="hint">實際年增來自證交所與櫃買中心的每月營收公告，每月 10 日前後更新。
      預測值是各研究機構的市場預測，沒有免費 API，由人工整理，查證日期 2026-09-08。
      <b>整體市場的 CAGR 幾乎都不是你要的那個數字</b>，因為它含大量與 AI 無關的成熟需求。
      真正的成長在小眾領域，標「看小眾」的代表兩者差一倍以上，只看整體會嚴重低估。
      本益比取<b>中位數</b>不取平均，因為一檔異常高就會把平均拉爛；虧損的公司不計入中位數，
      但會另外標出有幾檔在虧損，那本身就是訊息。近四季本益比由證交所與櫃買中心每日公告。
      <b>預估本益比 = 現價 ÷ 分析師預估 EPS</b>，預估值自動抓自 stockanalysis.com 的共識，
      股價每天更新所以比值每天變。台股只有大約六成的公司有人在報，「無人覆蓋」是常態不是錯誤，
      分析師兩位以下會標 ⚠。族群的「N/M 檔有預估」如果分母遠大於分子，那個中位數就別太當真。
      <b>報酬/波動</b>是三年年化報酬除以年化波動，及格線是加權指數的
      ${isNum(idxRatio()) ? fmtMax(idxRatio(), 2) : '–'}。低於這條線的個股，
      承受的波動換不到相稱的報酬，<b>不如直接開槓桿買指數</b>。
      回測實例：金居三年漲 7.79 倍看起來很猛，但波動 52% 讓風險等價槓桿只能開 0.81 倍，
      套上同一條交易規則後只有 4.03 倍，反而輸給指數的 7.75 倍。漲得多不等於賺得多。
      營收成長不等於股價會漲，這頁看的是產業景氣的轉折。</p>`;

  $$('.theme-card', el).forEach((card) => {
    card.onclick = () => {
      const body = $('.theme-body', card);
      if (!body.hidden) { body.hidden = true; return; }
      $$('.theme-body', el).forEach((b) => (b.hidden = true));
      const rows = state.themeMembers.filter((m) => m.theme === card.dataset.theme);
      const info = state.themeInfo.find((i) => i.theme === card.dataset.theme);
      const head = info
        ? `<div class="forecast-note">
             ${info.note ? `<div><b>整體市場：</b>${esc(info.note)}</div>` : ''}
             ${info.niche_note ? `<div class="niche-note"><b>${esc(info.niche || '小眾領域')}：</b>${esc(info.niche_note)}</div>` : ''}
             <div class="muted">預測來源：${esc(info.source || '未註明')}${info.checked_on ? `　查證於 ${esc(info.checked_on)}` : ''}</div>
           </div>` : '';
      body.innerHTML = head + (rows.length
        ? rows.map((m) => `<div class="line member" role="button" tabindex="0" data-stock="tw:${esc(norm(m.symbol))}">
            <div class="row-between">
              <span>${esc(m.symbol)} ${esc(m.name || '')}${held.has(norm(m.symbol)) ? '<span class="badge day-badge">持有</span>' : ''}</span>
              <span>${fmt(num(m.amount) / 100000, 1)} 億　<span class="${plClass(num(m.yoy))}">${
                isNum(m.yoy) ? signed(num(m.yoy) * 100, 1) + '%' : '–'}</span></span>
            </div>
            <div class="row-between sub muted">
              <span>近四季 ${isNum(m.pe) ? fmtMax(m.pe, 1) + 'x' : '虧損'}${
                isNum(m.pe1) ? `　${String(m.fy1).slice(2)}F <b>${fmtMax(m.pe1, 1)}x</b>` : ''}${
                isNum(m.pe2) ? `　${String(m.fy2).slice(2)}F <b>${fmtMax(m.pe2, 1)}x</b>` : ''}</span>
              <span>${isNum(m.an1)
                ? `${fmt(m.an1)} 位分析師${num(m.an1) <= 2 ? '<span class="warn-mark">⚠</span>' : ''}`
                : '<span class="muted">無人覆蓋</span>'}</span>
            </div>
            <div class="row-between sub muted">
              <span>${isNum(m.ratio)
                ? `報酬/波動 <b class="${beatsIdx(m.ratio) ? 'gain' : ''}">${fmtMax(m.ratio, 2)}</b>${
                    beatsIdx(m.ratio) ? '<span class="badge day-badge">贏指數</span>' : ''}`
                : '報酬/波動 –'}</span>
              <span>${isNum(m.vol) ? `波動 ${(num(m.vol) * 100).toFixed(0)}%` : ''}${
                isNum(m.cagr) ? `　年化 ${signed(num(m.cagr) * 100, 0)}%` : ''}</span>
            </div>
          </div>`).join('')
        : '<p class="muted">沒有成分股資料。</p>');
      body.hidden = false;
      bindStockOpen(body);
    };
  });
}

// ------------------------------------------------------------
// 心得 / 交易日誌
//   這頁的重點不是損益，是「有沒有照著自己的規則做」。
//   損益是結果，紀律是原因。只看損益的話，會在賺錢的月份把壞習慣放大。
// ------------------------------------------------------------
const MOODS = [[5, '很好'], [4, '還行'], [3, '普通'], [2, '不佳'], [1, '很差']];

// 從今天往回數，連續幾個交易日沒有違規（沒交易的日子不中斷也不計入）
function cleanStreak() {
  let n = 0;
  for (const d of state.journalDays) {
    if (num(d.trades) === 0) continue;
    if (breaksOn(d.d).length) break;
    n += 1;
  }
  return n;
}

async function editJournal(dateISO) {
  const row = state.journalDays.find((d) => d.d === dateISO);
  const b = breaksOn(dateISO);
  const hint = b.length
    ? `<div class="break-item">這天有 ${b.length} 項違規：${esc(b.map((x) => x.text).join('；'))}</div>`
    : '<div class="sub muted">這天沒有偵測到違規。</div>';
  const html = `
    <p class="sub muted">${esc(dateISO)}　已實現 ${signed(num(row?.realized))}　${
      fmt(num(row?.trades))} 筆交易</p>
    ${hint}
    <label>心得
      <textarea name="body" class="journal-input" placeholder="今天做了什麼、為什麼做、哪裡做對、哪裡手癢了。寫給三個月後的自己看。">${esc(row?.body || '')}</textarea>
    </label>
    <label>紀律自評（評的是有沒有照規則做，不是賺賠）
      <select name="mood">${MOODS.map(([v, l]) =>
        `<option value="${v}" ${num(row?.mood) === v ? 'selected' : ''}>${v} ${l}</option>`).join('')}</select>
    </label>
    <label class="chk"><input type="checkbox" name="followed" ${row?.followed ? 'checked' : ''}>
      <span>今天守住了所有規則</span></label>`;
  const res = await openDialog({
    title: `${dateISO} 心得`,
    html,
    collect: (fd) => ({
      body: (fd.get('body') || '').toString().trim() || null,
      mood: Number(fd.get('mood')) || null,
      followed: fd.get('followed') === 'on',
    }),
  });
  if (!res || res.action !== 'save') return;
  try {
    const { error } = await sb.from('journal').upsert({
      user_id: state.user.id, entry_date: dateISO,
      body: res.values.body, mood: res.values.mood, followed: res.values.followed,
      pl_snapshot: num(row?.realized), updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,entry_date' });
    if (error) throw error;
    await refresh('心得已儲存');
  } catch (e) { fail(e); }
}

async function editRule(existing) {
  const v = existing || { kind: 'free', scope: 'all', title: '', detail: '', amount: null };
  const res = await openForm({
    title: existing ? '編輯規則' : '新增規則',
    fields: [
      { key: 'title', label: '規則', type: 'text', required: true },
      { key: 'detail', label: '為什麼要有這條（寫給以後想破戒的自己）', type: 'text' },
      { key: 'kind', label: '檢查方式', type: 'select', options: [
        ['free', '只提醒，不自動檢查'],
        ['opt_only_hedge', '選擇權只准 buy put / sell call'],
        ['day_one_at_a_time', '個股當沖一次一檔'],
        ['day_max_amount', '個股當沖單檔金額上限'],
        ['scale_in', '一律分批（提醒）'],
      ] },
      { key: 'amount', label: '金額上限（只有「單檔金額上限」用得到）', type: 'number' },
    ],
    values: v,
    allowDelete: !!existing,
  });
  if (!res) return;
  try {
    if (res.action === 'delete') {
      const { error } = await sb.from('rules').delete().eq('id', existing.id);
      if (error) throw error;
      return refresh('規則已刪除');
    }
    const payload = { ...res.values, user_id: state.user.id, scope: v.scope || 'all',
                      updated_at: new Date().toISOString() };
    if (existing) payload.id = existing.id;
    const { error } = await sb.from('rules').upsert(payload);
    if (error) throw error;
    await refresh('規則已儲存');
  } catch (e) { fail(e); }
}

function renderJournal(el) {
  const today = todayISO();
  const days = state.journalDays;
  const todayRow = days.find((d) => d.d === today);
  const tb = breaksOn(today);
  const streak = cleanStreak();
  const brokenKinds = new Set(tb.map((x) => x.kind));
  const past = days.filter((d) => d.d !== today);

  el.innerHTML = `
    <div class="card">
      <div class="row-between">
        <span class="list-title">${esc(today)}</span>
        <span class="${plClass(num(todayRow?.realized))}">${signed(num(todayRow?.realized))}</span>
      </div>
      <div class="row-between sub muted">
        <span>${fmt(num(todayRow?.trades))} 筆交易・當沖 ${fmt(num(todayRow?.day_trades))} 筆</span>
        <span class="streak">${streak > 0 ? `連續 ${fmt(streak)} 個交易日沒違規` : '今天重新開始'}</span>
      </div>
      ${tb.length
        ? `<div class="breaks">${tb.map((x) => `<div class="break-item"><b>${esc(x.text)}</b>${
            x.detail ? `<br><span class="muted">${esc(x.detail)}</span>` : ''}</div>`).join('')}</div>`
        : '<p class="sub" style="margin-top:8px">今天沒有偵測到違規。</p>'}
      ${todayRow?.body ? `<div class="journal-body">${esc(todayRow.body)}</div>` : ''}
      <button type="button" class="primary block" data-journal="${esc(today)}">${
        todayRow?.body ? '編輯今天的心得' : '寫今天的心得'}</button>
    </div>

    <div class="card">
      <div class="row-between">
        <span class="list-title">我的規則</span>
        <button type="button" class="link" data-add-rule>＋ 新增</button>
      </div>
      ${state.rules.length
        ? state.rules.map((r) => `<div class="rule${brokenKinds.has(r.kind) ? ' broken' : ''}" data-rule="${esc(r.id)}">
            <div class="rule-title">${esc(r.title)}${
              brokenKinds.has(r.kind) ? '<span class="badge warn-badge">今天違反</span>' : ''}</div>
            ${r.detail ? `<div class="rule-detail">${esc(r.detail)}</div>` : ''}
            <div class="rule-since">自 ${esc(r.started_on)}　已經 ${
              fmt(Math.max(0, Math.round((Date.parse(today) - Date.parse(r.started_on)) / 86400000)))} 天</div>
          </div>`).join('')
        : '<p class="muted">還沒有規則。</p>'}
      <p class="hint">規則不會擋住你存檔，那是你的錢、你的帳。
        <b>系統跟券商的下單 App 沒有連線</b>，所以擋不到你下單，只能在你回來記錄時算給你看。
        像「選擇權只做避險」「當沖一次一檔」「單檔上限」這種，
        從記錄下來的資料就算得出來，會標「今天違反」並累計；
        而「不放空當天強勢股」這種要看盤中強弱的，事後無從判斷，只能當提醒靠自己記得。</p>
    </div>

    <div class="card">
      <div class="list-title">過去的日子</div>
      ${past.length
        ? past.map((d) => {
            const b = breaksOn(d.d);
            return `<div class="journal-day" data-journal="${esc(d.d)}">
              <div class="row-between">
                <span>${esc(d.d)}${b.length ? `<span class="badge warn-badge">${fmt(b.length)} 項違規</span>` : ''}${
                  d.followed ? '<span class="badge day-badge">守住</span>' : ''}</span>
                <span class="${plClass(num(d.realized))}">${signed(num(d.realized))}</span>
              </div>
              <div class="row-between sub muted">
                <span>${fmt(num(d.trades))} 筆・當沖 ${fmt(num(d.day_trades))}${
                  num(d.opt_pl) !== 0 ? `・選擇權 ${signed(num(d.opt_pl))}` : ''}</span>
                <span>${isNum(d.mood) ? `紀律 ${fmt(d.mood)}/5` : ''}</span>
              </div>
              ${d.body ? `<div class="journal-body">${esc(d.body)}</div>` : '<div class="sub muted">（沒寫）</div>'}
            </div>`;
          }).join('')
        : '<p class="muted">還沒有紀錄。每天寫一則，三個月後回頭看會很有用。</p>'}
    </div>`;

  $$('[data-journal]', el).forEach((b) => (b.onclick = () => editJournal(b.dataset.journal)));
  $$('[data-rule]', el).forEach((b) => (b.onclick = () =>
    editRule(state.rules.find((r) => r.id === b.dataset.rule))));
  const add = $('[data-add-rule]', el);
  if (add) add.onclick = (e) => { e.stopPropagation(); editRule(null); };
}

// ------------------------------------------------------------
// 美股 AI 產業地圖
//   跟台股那頁的訊號方向相反：台股用已公告的月營收（落後），
//   美股用分析師的營收預估（前瞻）。後者更接近「產業趨勢」本身，
//   但分母是別人的猜測，看的時候要連分析師人數一起看。
//   基準線用那斯達克 100，不是加權指數，因為比較對象要同一個市場。
// ------------------------------------------------------------
const usIdxRatio = () => num(state.usStats.find((r) => r.symbol === 'NDX')?.ratio);
const usBeats = (r) => isNum(r) && isNum(usIdxRatio()) && num(r) > usIdxRatio();
const usdB = (v) => (isNum(v) ? `${fmt(num(v) / 100000000, 0)} 億` : '–');

function renderUsThemes(host) {
  const trend = [...state.usThemeTrend].sort((a, b) => num(b.growth_next) - num(a.growth_next));
  const held = new Set(state.us.map((s) => norm(s.symbol)));
  if (!trend.length) {
    host.innerHTML = '<div class="card"><p class="muted">還沒有美股資料。按右上角 ↻ 更新。</p></div>';
    return;
  }
  const myThemes = new Set(state.usThemeMembers.filter((m) => held.has(norm(m.symbol))).map((m) => m.theme));
  const ndx = usIdxRatio();

  host.innerHTML = `
    <div class="card">
      <div class="list-title">美股 AI 產業地圖</div>
      <p class="sub muted">用<b>分析師的營收預估</b>加總，看整個產業被預期要長多快。
        這是前瞻指標，跟台股那頁用已公告的月營收（落後指標）方向相反。
        基準線是那斯達克 100，報酬/波動 ${isNum(ndx) ? fmtMax(ndx, 2) : '–'}。</p>
    </div>
    ${trend.map((t) => {
      const mine = myThemes.has(t.theme);
      return `<div class="card theme-card${mine ? ' mine' : ''}" data-ustheme="${esc(t.theme)}">
        <div class="row-between">
          <span class="list-title">${esc(t.theme)}${mine ? '<span class="badge day-badge">持有</span>' : ''}</span>
          <span class="theme-yoy ${plClass(num(t.growth_next))}">${
            isNum(t.growth_next) ? signed(num(t.growth_next) * 100, 1) + '%' : '–'}</span>
        </div>
        <div class="row-between sub muted">
          <span>營收預估 ${usdB(t.rev_this)}美元・${fmt(t.covered)}/${fmt(t.members)} 檔</span>
          <span>明年營收年增</span>
        </div>
        <div class="row-between sub muted">
          <span>本年營收年增 <b class="${plClass(num(t.growth))}">${
            isNum(t.growth) ? signed(num(t.growth) * 100, 1) + '%' : '–'}</b></span>
          <span>本益比 本年 ${isNum(t.pe_median) ? fmtMax(t.pe_median, 1) + 'x' : '–'}　明年 ${
            isNum(t.pe_next_median) ? fmtMax(t.pe_next_median, 1) + 'x' : '–'}</span>
        </div>
        <div class="row-between sub muted">
          <span>報酬/波動 ${isNum(t.ratio_median)
            ? `<b class="${num(t.ratio_median) > ndx ? 'gain' : ''}">${fmtMax(t.ratio_median, 2)}</b>` : '–'}${
            isNum(t.vol_median) ? `　波動 ${(num(t.vol_median) * 100).toFixed(0)}%` : ''}</span>
          <span>${fmt(t.beat_idx)}/${fmt(t.members)} 檔贏過 NDX</span>
        </div>
        <div class="theme-body" hidden></div>
      </div>`;
    }).join('')}
    <p class="hint">營收與 EPS 預估來自 stockanalysis.com 匯總的分析師共識（S&amp;P Global、TipRanks），
      每天自動更新，只有本年度與次年度免費。<b>各公司會計年度不一致</b>，
      例如 NVDA 的 FY2027 其實是 2026 曆年，所以這裡只講「本年／明年」不寫死年份。
      報酬/波動是三年年化報酬除以年化波動，及格線是那斯達克 100 的
      ${isNum(ndx) ? fmtMax(ndx, 2) : '–'}；低於它代表承受的波動換不到相稱的報酬。
      <b>預估是別人的猜測</b>，分析師少的那幾檔請當參考不要當事實。</p>`;

  $$('.theme-card', host).forEach((card) => {
    card.onclick = () => {
      const body = $('.theme-body', card);
      if (!body.hidden) { body.hidden = true; return; }
      $$('.theme-body', host).forEach((b) => (b.hidden = true));
      const rows = state.usThemeMembers.filter((m) => m.theme === card.dataset.ustheme);
      body.innerHTML = rows.length
        ? rows.map((m) => `<div class="line member" role="button" tabindex="0" data-stock="us:${esc(norm(m.symbol))}">
            <div class="row-between">
              <span>${esc(m.symbol)} ${esc(m.name || '')}${
                held.has(norm(m.symbol)) ? '<span class="badge day-badge">持有</span>' : ''}</span>
              <span>${usdB(m.rev_this)}美元　<span class="${plClass(num(m.rev_g))}">${
                isNum(m.rev_g) ? signed(num(m.rev_g) * 100, 1) + '%' : '–'}</span></span>
            </div>
            <div class="row-between sub muted">
              <span>本益比 本年 ${isNum(m.pe_this) ? fmtMax(m.pe_this, 1) + 'x' : '–'}　明年 ${
                isNum(m.pe_next) ? fmtMax(m.pe_next, 1) + 'x' : '–'}</span>
              <span>${isNum(m.analysts)
                ? `${fmt(m.analysts)} 位分析師${num(m.analysts) <= 5 ? '<span class="warn-mark">⚠</span>' : ''}`
                : '<span class="muted">無人覆蓋</span>'}</span>
            </div>
            <div class="row-between sub muted">
              <span>${isNum(m.ratio)
                ? `報酬/波動 <b class="${usBeats(m.ratio) ? 'gain' : ''}">${fmtMax(m.ratio, 2)}</b>${
                    usBeats(m.ratio) ? '<span class="badge day-badge">贏 NDX</span>' : ''}`
                : (num(m.days) > 0
                    ? `<span class="muted">上市未滿兩年（${fmt(m.days)} 天），不給比值</span>`
                    : '報酬/波動 –')}</span>
              <span>${isNum(m.vol) ? `波動 ${(num(m.vol) * 100).toFixed(0)}%` : ''}${
                isNum(m.rev_g_next) ? `　明年營收 ${signed(num(m.rev_g_next) * 100, 0)}%` : ''}</span>
            </div>
          </div>`).join('')
        : '<p class="muted">沒有成分股資料。</p>';
      body.hidden = false;
      bindStockOpen(body);
    };
  });
}


// ------------------------------------------------------------
// 處置股與注意股
//   為什麼要擺在顯眼的地方：他一次只沖一檔、每檔上限 100 萬。
//   **第二次處置是全額圈存**——買進要先付全部價金、賣出要先有券，
//   當沖等於做不成；撮合又變成人工約每兩分鐘一次，想跑的時候排不進去。
//   這是進場前就該知道的事。
// ------------------------------------------------------------
const ALERT_LABEL = { punish: '處置中', near: '快達處置標準', notice: '注意股' };

const alertOf = (sym) => {
  const k = resolveTwSymbol(sym);
  return k ? state.alerts.find((a) => norm(a.symbol) === k) || null : null;
};

// 「所以我會被限制什麼」。
// **數字一律照抄公告，不要自己歸納。** 撮合間隔實測有 2/5/20/45 分鐘四種，
// 圈存門檻有的是全部委託、有的要單筆 10 張以上才算，寫死任何一種都會錯。
function alertLine(a) {
  if (a.kind === 'punish') {
    const days = a.end_d
      ? Math.round((new Date(a.end_d + 'T00:00:00') - new Date(todayISO() + 'T00:00:00')) / 86400000)
      : null;
    const left = days === null ? ''
      : days < 0 ? '（已結束）' : days === 0 ? '（今天最後一天）' : `（還有 ${fmt(days)} 天）`;
    const bits = [`${a.start_d || ''} ～ ${a.end_d || ''}${left}`];
    if (isNum(a.match_min)) bits.push(`人工撮合，約每 ${fmt(a.match_min)} 分鐘一次`);
    else bits.push('人工撮合');
    bits.push(num(a.prepay_lots) > 0
      ? `單筆 ${fmt(a.prepay_lots)} 張以上要圈存（先付全部價金／先有券）`
      : '所有委託都要圈存（先付全部價金／先有券）');
    return bits.join('　');
  }
  if (a.kind === 'near') return a.reason || '注意次數已經逼近處置門檻，隨時可能被處置';
  return num(a.notices) > 0
    ? `最近 30 天上過 ${fmt(a.notices)} 次注意${num(a.notices) >= 4 ? '，再一次就可能處置' : ''}`
    : (a.reason || '最近上過注意交易資訊');
}

const alertBadge = (a) => (a
  ? `<span class="badge alert-${esc(a.kind)}">${ALERT_LABEL[a.kind] || '警示'}</span>` : '');

// 持倉裡有沒有被盯上的，總覽要先講這個，不能等他自己去點
function heldAlerts() {
  const out = [];
  for (const sym of heldSymbols()) {
    const a = alertOf(sym);
    if (a) out.push(a);
  }
  return out.sort((x, y) => (y.kind === 'punish') - (x.kind === 'punish'));
}

// ------------------------------------------------------------
// 個股速覽
//   在任何地方看到一檔股票，點下去就要能知道它「現在大概是什麼狀態」。
//   絕大部分數字登入時就整批載好了，所以先用記憶體畫出來、立刻看得到，
//   再把需要往返一次的深度資料（股價淨值比、季報、每一年的預估、月營收明細）補上。
//
//   最上面那條區間帶是刻意放的：使用者的策略是「在下跌中買好公司」，
//   那就需要一個「現在站在哪裡」的數字，而不是只有報酬與波動。
//   金居就是例子——三年最低 38.6、最高 700、現在 521，
//   光看「三年漲 13 倍」跟光看「離高點還有 26%」是兩種完全不同的判斷。
// ------------------------------------------------------------

// 我在這一檔上的實際成績。看族群數字之前先看這個，
// 因為「這檔好不好」跟「我在這檔上做得好不好」常常是相反的。
function symbolRecord(mk, sym) {
  const rs = realizedSummary();
  const key = mk === 'us' ? norm(sym) : resolveTwSymbol(sym);
  let net = 0, cost = 0, n = 0, last = null;
  const byCat = { day: 0, swing: 0, roll: 0 };
  for (const t of state.trades) {
    if (t.market === 'option') continue;
    const s = t.market === 'us' ? norm(t.symbol) : resolveTwSymbol(t.symbol);
    if (s !== key) continue;
    const r = tradeNet(t, rs);
    net += r.net; cost += r.cost; n += 1;
    byCat[tradeCategory(t)] += r.net;
    if (!last || t.trade_date > last) last = t.trade_date;
  }
  return { net, cost, n, last, byCat };
}

// 我現在手上有多少。現股、個股期、權證標的、複委託分開講，
// 因為同一檔用三種方式持有的風險完全不同。
function symbolHoldings(mk, sym) {
  const key = mk === 'us' ? norm(sym) : resolveTwSymbol(sym);
  const out = [];
  if (mk === 'us') {
    for (const u of state.us) {
      if (norm(u.symbol) !== key) continue;
      out.push({ how: '複委託', qty: `${fmt(u.shares)} 股`,
                 cost: u.cost_usd, price: u.price_usd,
                 expo: num(u.shares) * num(u.price_usd), ccy: 'USD' });
    }
    return out;
  }
  for (const s of state.stocks) {
    if (norm(s.symbol) !== key) continue;
    out.push({ how: '現股', qty: `${fmt(s.shares)} 股`,
               cost: s.cost, price: s.price, expo: num(s.shares) * num(s.price), ccy: 'TWD' });
  }
  for (const f of state.futures) {
    if (f.kind !== 'stock' || norm(f.symbol) !== key) continue;
    out.push({ how: `個股期（${stockFutLabel(f.size)}型・${f.side === 'short' ? '空' : '多'}）`,
               qty: `${fmt(f.lots)} 口`, cost: f.cost, price: f.price,
               expo: num(f.lots) * num(f.price) * num(f.size || 2000), ccy: 'TWD' });
  }
  for (const w of state.warrants) {
    if (norm(w.underlying) !== key) continue;
    // 權證的曝險不是它的市值，是 delta 換算後的標的曝險，所以這裡只列不加總
    out.push({ how: `權證 ${esc(w.code || '')}（標的）`, qty: `${fmt(w.lots)} 張`,
               cost: w.cost, price: w.price, expo: null, ccy: 'TWD' });
  }
  return out;
}

// 現價在區間裡的位置，0 = 貼著最低，1 = 貼著最高
function rangeBar(lo, hi, px, label) {
  if (!isNum(lo) || !isNum(hi) || !isNum(px) || num(hi) <= num(lo)) return '';
  const p = Math.min(1, Math.max(0, (num(px) - num(lo)) / (num(hi) - num(lo))));
  return `<div class="range">
    <div class="row-between sub muted"><span>${label}</span>
      <span>${fmtMax(lo, 2)} – ${fmtMax(hi, 2)}　位置 <b>${(p * 100).toFixed(0)}%</b></span></div>
    <div class="range-bar"><div class="range-dot" style="left:${(p * 100).toFixed(1)}%"></div></div>
  </div>`;
}

const CONF_LABEL = { high: '可信度高', mid: '可信度中', low: '可信度低' };

// 轉型故事的文字裡用 **…** 標重點。先 esc 再轉標記，順序不能反，
// 否則使用者資料裡的角括號會變成可執行的 HTML。
const mdBold = (t) => esc(String(t ?? '')).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

// 區間帶與風險這兩塊拆出來，因為記憶體裡只有幾百檔的風險數字
// （全市場四千檔不可能整批載，見 app_risk()），其餘的要等 stock_detail 回來才有。
function rangeHtml(k, price) {
  if (!k) return '';
  return rangeBar(k.lo52, k.hi52, price, '近一年區間')
    + rangeBar(k.lo3y, k.hi3y, price, '三年區間')
    + (isNum(k.hi3y) && isNum(price) && num(k.hi3y) > 0
      ? `<p class="sub muted sc-off">距三年高點 <b class="${
          num(price) / num(k.hi3y) - 1 < -0.3 ? 'gain' : ''}">${
          signed((num(price) / num(k.hi3y) - 1) * 100, 0)}%</b>${
          isNum(k.lo3y) && num(k.lo3y) > 0
            ? `　距三年低點 ${signed((num(price) / num(k.lo3y) - 1) * 100, 0)}%` : ''}</p>`
      : '');
}

function riskHtml(k, bench, beats) {
  if (!k) return '';
  const kv = (a, b) => `<div class="row-between sub"><span class="muted">${a}</span><span>${b}</span></div>`;
  return `<div class="sc-sec"><div class="sc-title">風險</div>
    ${kv('報酬 / 波動', isNum(k.ratio)
      ? `<b class="${beats(k.ratio) ? 'gain' : 'loss'}">${fmtMax(k.ratio, 2)}</b>　及格線 ${
          isNum(bench) ? fmtMax(bench, 2) : '–'}`
      : (num(k.days) > 0 ? `上市未滿兩年（${fmt(k.days)} 天）` : '–'))}
    ${kv('三年年化報酬', isNum(k.cagr) ? signed(num(k.cagr) * 100, 0) + '%' : '–')}
    ${kv('年化波動', isNum(k.vol) ? (num(k.vol) * 100).toFixed(0) + '%' : '–')}
    ${kv('三年最大回撤', isNum(k.mdd) ? `<span class="loss">${(num(k.mdd) * 100).toFixed(0)}%</span>` : '–')}
    ${isNum(k.vol) && num(k.vol) > 0 && isNum(bench)
      ? `<p class="sub muted">用它的波動換到相稱的報酬，年化要有 <b>${
          (num(k.vol) * bench * 100).toFixed(0)}%</b> 以上。</p>` : ''}</div>`;
}

function stockCardHtml(mk, sym) {
  const key = mk === 'us' ? norm(sym) : resolveTwSymbol(sym);
  const mem = (mk === 'us' ? state.usThemeMembers : state.themeMembers)
    .filter((m) => norm(m.symbol) === key);
  const m0 = mem[0] || null;
  const risk = mk === 'us'
    ? state.usStats.find((r) => norm(r.symbol) === key)
    : state.riskStats.find((r) => norm(r.symbol) === key);
  const name = m0?.name || (mk === 'tw' ? TW_STOCKS[key] : '') || '';
  const price = mk === 'us'
    ? num(risk?.price) || num(state.us.find((u) => norm(u.symbol) === key)?.price_usd)
    : num(state.stocks.find((s) => norm(s.symbol) === key)?.price)
      || num(state.futures.find((f) => norm(f.symbol) === key)?.price)
      || num(risk?.last);
  const cur = mk === 'us' ? '$' : '';
  const bench = mk === 'us' ? usIdxRatio() : idxRatio();
  const beats = mk === 'us' ? usBeats : beatsIdx;
  const holds = symbolHoldings(mk, key);
  const rec = symbolRecord(mk, key);
  const themes = mem.map((m) => {
    const meta = state.themeMeta.find((x) => x.market === mk && x.theme === m.theme);
    const c = { up: state.themeLinks.filter((l) => l.market === mk && l.dst === m.theme),
                down: state.themeLinks.filter((l) => l.market === mk && l.src === m.theme) };
    return { theme: m.theme, meta, c };
  });

  const sec = (title, body) => body
    ? `<div class="sc-sec"><div class="sc-title">${title}</div>${body}</div>` : '';
  const kv = (k, v) => `<div class="row-between sub"><span class="muted">${k}</span><span>${v}</span></div>`;

  return `
    <div class="sc-head">
      <div class="row-between">
        <span class="sc-name" data-sc-nm="${esc(name)}"><b>${esc(key)}</b> ${esc(name)}</span>
        <span class="sc-px" data-px="${isNum(price) && num(price) > 0 ? 1 : 0}">${
          isNum(price) && num(price) > 0 ? cur + fmtMax(price, 2) : '…'}</span>
      </div>
      <div class="row-between sub muted">
        <span>${mk === 'us' ? '複委託 / 美股' : '台股'}${
          m0?.industry ? '・' + esc(m0.industry) : ''}<span data-sc-industry></span></span>
        <span>${state.guest ? '' : (holds.length ? '持有中' : '未持有')}</span>
      </div>
    </div>

    <div data-sc-biz></div>
    <div data-sc-range>${rangeHtml(risk, price)}</div>

    ${mk === 'tw' && alertOf(key) ? (() => {
      const a = alertOf(key);
      return `<div class="alert-box alert-${esc(a.kind)}">
        <div class="row-between"><b>${ALERT_LABEL[a.kind] || '警示'}</b>
          <span class="sub">${esc(a.name || '')}</span></div>
        <div class="sub">${esc(alertLine(a))}</div>
        ${a.reason ? `<div class="sub muted">${esc(a.reason)}</div>` : ''}
        ${a.detail ? `<details class="sc-note"><summary>交易所公告原文</summary><p>${
          esc(a.detail)}</p></details>` : ''}
      </div>`;
    })() : ''}

    <div data-sc-day></div>

    ${state.guest ? '' : sec('我的部位', holds.length
      ? holds.map((h) => `${kv(h.how, `${h.qty}${
          isNum(h.expo) && num(h.expo) > 0
            ? `　曝險 ${h.ccy === 'USD' ? 'US$ ' : ''}${fmt(h.expo)}` : ''}`)}${
          isNum(h.cost) ? kv('　成本 / 現價', `${fmtMax(h.cost, 2)} → ${fmtMax(h.price, 2)}　<span class="${
            plClass(num(h.price) - num(h.cost))}">${signed((num(h.price) / num(h.cost) - 1) * 100, 1)}%</span>`) : ''}`).join('')
      : '<p class="sub muted">現在沒有部位。</p>')}
    ${state.guest ? '<p class="sub muted">登入之後這裡會顯示你在這一檔的部位與歷史成績。</p>' : ''}

    ${state.guest ? '' : sec('我在這一檔的成績', rec.n
      ? `${kv('已實現（扣成本後）', `<b class="${plClass(rec.net)}">${signed(rec.net)}</b>`)}
         ${kv('交易筆數', `${fmt(rec.n)} 筆　最後一筆 ${esc(rec.last || '')}`)}
         ${kv('手續費與稅', fmt(rec.cost))}
         ${['day', 'swing', 'roll'].filter((c) => rec.byCat[c]).map((c) =>
            kv('　' + CAT_LABEL[c], `<span class="${plClass(rec.byCat[c])}">${signed(rec.byCat[c])}</span>`)).join('')}`
      : '<p class="sub muted">還沒有在這一檔交易過。</p>')}

    ${sec('估值', mk === 'us'
      ? `${kv('本年本益比', isNum(m0?.pe_this) ? fmtMax(m0.pe_this, 1) + 'x' : '–')}
         ${kv('明年本益比', isNum(m0?.pe_next) ? fmtMax(m0.pe_next, 1) + 'x' : '–')}
         ${kv('分析師', num(m0?.analysts) > 0
            ? `${fmt(m0.analysts)} 位${num(m0.analysts) <= 5 ? ' ⚠ 樣本少' : ''}` : '無人覆蓋')}`
      : `${kv('近四季本益比', isNum(m0?.pe) ? fmtMax(m0.pe, 1) + 'x' : '虧損或無資料')}
         ${isNum(m0?.pe1) ? kv(`${String(m0.fy1).slice(2)} 年預估`,
            `<b>${fmtMax(m0.pe1, 1)}x</b>　EPS ${fmtMax(m0.eps1, 2)}`) : ''}
         ${isNum(m0?.pe2) ? kv(`${String(m0.fy2).slice(2)} 年預估`,
            `<b>${fmtMax(m0.pe2, 1)}x</b>　EPS ${fmtMax(m0.eps2, 2)}`) : ''}
         ${kv('分析師', num(m0?.an1) > 0
            ? `${fmt(m0.an1)} 位${num(m0.an1) <= 2 ? ' ⚠ 樣本少' : ''}` : '無人覆蓋')}`)
      + '<div data-sc-val></div>'}

    <div data-sc-risk>${riskHtml(risk, bench, beats)}</div>

    ${sec(mk === 'us' ? '營收預估' : '月營收', mk === 'us'
      ? `${kv('本年營收', `${usdB(m0?.rev_this)}美元　<span class="${plClass(num(m0?.rev_g))}">${
            isNum(m0?.rev_g) ? signed(num(m0.rev_g) * 100, 1) + '%' : '–'}</span>`)}
         ${kv('明年營收', `<span data-sc-revnext></span><span class="${plClass(num(m0?.rev_g_next))}">${
            isNum(m0?.rev_g_next) ? signed(num(m0.rev_g_next) * 100, 1) + '%' : '–'}</span>`)}`
      : (m0 ? kv(rocYm(m0.ym), `${fmt(num(m0.amount) / 100000, 1)} 億　<span class="${plClass(num(m0.yoy))}">${
            isNum(m0.yoy) ? signed(num(m0.yoy) * 100, 1) + '%' : '–'}</span>`) : '')
        + '<div data-sc-rev></div>')}

    <div data-sc-fin></div>

    ${sec('族群與供應鏈', themes.length
      ? themes.map((t) => `<div class="sc-theme">
          <div class="row-between">
            <span>${t.meta?.stage ? `<span class="stage stage-${esc(t.meta.stage)}">${esc(t.meta.stage)}</span>` : ''}
              <b>${esc(t.theme)}</b></span>
            <span class="sub muted">${esc(t.meta?.parent || '')}</span>
          </div>
          ${t.c.up.length ? `<div class="sub muted">↑ 上游　${t.c.up.map((l) => esc(l.src)).join('、')}</div>` : ''}
          ${t.c.down.length ? `<div class="sub muted">↓ 下游　${t.c.down.map((l) => esc(l.dst)).join('、')}</div>` : ''}
        </div>`).join('')
      : '<p class="sub muted">沒有登記在任何族群裡。</p>')}

    <p class="hint" data-sc-hint>價格與估值每天自動更新，區間與波動取自 Yahoo 三年日線。${
      state.guest ? '' : '「我在這一檔的成績」是這個帳號所有相關交易扣掉手續費與稅之後的淨額。'}</p>`;
}

// 任何列了股票的地方都可以掛這個：元素上寫 data-stock="tw:2330" 就能點開速覽
function bindStockOpen(host) {
  $$('[data-stock]', host).forEach((b) => (b.onclick = (e) => {
    e.preventDefault(); e.stopPropagation();
    const [mk, sym] = b.dataset.stock.split(':');
    openStock(mk, sym);
  }));
}

// 開啟速覽。先用記憶體裡的資料立刻畫出來，再把需要往返的深度資料補進去。
async function openStock(mk, sym) {
  const market = mk === 'us' ? 'us' : 'tw';
  const key = market === 'us' ? norm(sym) : resolveTwSymbol(sym);
  if (!key) return;
  const dlg = $('#info-dialog');
  $('.info-body', dlg).innerHTML = stockCardHtml(market, key);
  $('#info-close').onclick = () => dlg.close();
  dlg.showModal();

  let d = null;
  try {
    const { data, error } = await sb.rpc('stock_detail', { p_market: market, p_symbol: key });
    if (!error) d = data;
  } catch { /* 補充資料拿不到就算了，上面該有的都已經畫出來 */ }
  if (!d || !dlg.open) return;
  const body = $('.info-body', dlg);
  const kv = (k, v) => `<div class="row-between sub"><span class="muted">${k}</span><span>${v}</span></div>`;

  const ind = $('[data-sc-industry]', body);
  if (ind && d.industry) ind.textContent = '・' + d.industry;

  // 名稱以 RPC 回來的為準。前端的 tw-stocks.json 是靜態檔，改名不會跟著動——
  // 1721 已經是國慶科技了，那份還寫三晃，而改名本身就是那一檔的重點。
  const nm = $('[data-sc-nm]', body);
  if (nm && d.name && d.name !== nm.dataset.scNm) {
    nm.innerHTML = `<b>${esc(key)}</b> ${esc(d.name)}`;
  }

  // 記憶體裡只有幾百檔的風險數字，全市場其他四千檔要靠這裡補。
  // 價格也一樣：沒持有、又不在族群裡的股票，前端沒有它的收盤價。
  const k = market === 'us' ? d.usrisk : d.risk;
  if (k) {
    const px = num(d.day?.price) || num(k.price) || num(k.last);
    const bench2 = market === 'us' ? usIdxRatio() : idxRatio();
    const beats2 = market === 'us' ? usBeats : beatsIdx;
    const rg = $('[data-sc-range]', body);
    if (rg && !rg.innerHTML.trim()) rg.innerHTML = rangeHtml(k, px);
    const rk = $('[data-sc-risk]', body);
    if (rk && !rk.innerHTML.trim()) rk.innerHTML = riskHtml(k, bench2, beats2);
    const pxEl = $('.sc-px', body);
    if (pxEl && isNum(px) && num(px) > 0 && !num(pxEl.dataset.px)) {
      pxEl.textContent = (market === 'us' ? '$' : '') + fmtMax(px, 2);
    }
  }
  // 公司自己申報的主要經營業務。證交所的「產業別」把金居、國巨、台光電
  // 全叫做電子零組件業，這一行才分得出誰在做什麼。
  const bz = $('[data-sc-biz]', body);
  if (bz) {
    // 轉型故事放在業務描述前面。**stage 要比標題顯眼**——
    //「已成主業」跟「試做送樣」在股價上可能一樣激動，在現實上差很遠。
    const st = d.story;
    bz.innerHTML = (st ? `<div class="sc-story stage-${esc(String(st.stage || '').slice(0, 4))}">
        <div class="row-between">
          <span class="sc-story-tag">轉型故事</span>
          <span class="sc-stage">${esc(st.stage || '')}</span>
        </div>
        <p class="sc-story-title">${mdBold(st.title)}</p>
        ${st.detail ? `<p class="sub">${mdBold(st.detail)}</p>` : ''}
        ${st.caution ? `<p class="sub sc-caution"><b>但書</b>　${mdBold(st.caution)}</p>` : ''}
        ${st.relates ? `<p class="sub muted">實質上屬於：${esc(st.relates)}</p>` : ''}
        <p class="sub muted">${esc(st.source || '')}${
          st.checked_on ? `　查證於 ${esc(st.checked_on)}` : ''}</p>
      </div>` : '')
      + (d.business ? `<p class="sc-biz">${esc(d.business)}</p>` : '');
  }

  const rn = $('[data-sc-revnext]', body);
  if (rn && isNum(d.us?.rev_next)) rn.textContent = usdB(d.us.rev_next) + '美元　';

  // 今天的表現。**「從當日低點拉起多少」才是強弱**，不是對昨收的漲跌幅。
  // 華新科 2026-09-10 對昨收 +4.5% 看起來還好，但它從低點 303 拉到 334 是 +10.2%。
  const dh = $('[data-sc-day]', body);
  if (dh && d.day && isNum(d.day.chg)) {
    const strong = num(d.day.off_low) > 0.05;
    dh.innerHTML = `<div class="sc-sec"><div class="sc-title">今日（${esc(d.day.as_of || '')} 收盤）</div>
      ${kv('對昨收', `<b class="${plClass(num(d.day.chg_pct))}">${
        signed(num(d.day.chg_pct) * 100, 2)}%</b>　${signed(num(d.day.chg), 2)}`)}
      ${kv('從當日低點拉起', `<b class="${strong ? 'gain' : ''}">${
        signed(num(d.day.off_low) * 100, 1)}%</b>${strong ? '　⚠ 今天是強勢股' : ''}`)}
      ${kv('開 / 高 / 低', `${fmtMax(d.day.open, 2)} / ${fmtMax(d.day.high, 2)} / ${fmtMax(d.day.low, 2)}`)}
      ${strong ? '<p class="sub warn-text">今天從低點拉起超過 5%。你的紀律是<b>不放空當天強勢的股票</b>，'
        + '尤其族群一起漲的時候。</p>' : ''}</div>`;
  }

  const vh = $('[data-sc-val]', body);
  if (vh && d.val) {
    vh.innerHTML = (isNum(d.val.pb) ? kv('股價淨值比', fmtMax(d.val.pb, 2) + 'x') : '')
      + (isNum(d.val.dy) && num(d.val.dy) > 0 ? kv('現金殖利率', fmtMax(d.val.dy, 2) + '%') : '');
  }
  // 每一年的預估：theme_members 只給兩年，這裡把 2028 與註解補齊。
  // 註解常常比數字重要——台玻那筆寫的是「這不是分析師共識，是新聞引述的無名法人」。
  if (Array.isArray(d.fc) && d.fc.length && vh) {
    // 上面已經用記憶體畫過 fy1 與 fy2 了，這裡只補沒畫到的年份（通常是 2028）
    const mem0 = (market === 'us' ? state.usThemeMembers : state.themeMembers)
      .find((m) => norm(m.symbol) === key);
    const shown = new Set([Number(mem0?.fy1), Number(mem0?.fy2)].filter(Number.isFinite));
    const rest = d.fc.filter((f) => !shown.has(Number(f.fy)));
    vh.insertAdjacentHTML('beforeend', rest.map((f) => kv(
      `${f.fy} 年 EPS`,
      `${fmtMax(f.eps, 2)}${isNum(f.analysts) && num(f.analysts) > 0 ? `　${fmt(f.analysts)} 位` : ''}${
        f.confidence ? `　<span class="muted">${CONF_LABEL[f.confidence] || esc(f.confidence)}</span>` : ''}`
    )).join('')
      + (d.fc.some((f) => f.note)
        ? `<details class="sc-note"><summary>預估的來源與但書</summary>${
            d.fc.filter((f) => f.note).map((f) =>
              `<p><b>${f.fy}：</b>${esc(f.note)}</p>`).join('')}</details>` : ''));
  }

  // 月營收表只留三個月：當月、上個月、去年同月。並排列出來會像資料斷掉，
  // 所以標成「上月」與「去年同月」，順便看得到月增率。
  const rh = $('[data-sc-rev]', body);
  if (rh && Array.isArray(d.rev) && d.rev.length > 1) {
    const cur = d.rev[0];
    const prev = d.rev.find((r) => r !== cur && r.ym === rocPrevYm(cur.ym));
    const ly = d.rev.find((r) => r !== cur && r !== prev);
    rh.innerHTML = (prev ? kv(`上月 ${rocYm(prev.ym)}`,
        `${fmt(num(prev.amount) / 100000, 1)} 億　<span class="${plClass(num(cur.amount) - num(prev.amount))}">月增 ${
          signed((num(cur.amount) / num(prev.amount) - 1) * 100, 1)}%</span>`) : '')
      + (ly ? kv(`去年同月 ${rocYm(ly.ym)}`, `${fmt(num(ly.amount) / 100000, 1)} 億`) : '');
  }

  // 季報累計 EPS。這是「已經賺到的」，拿來對照上面的預估合不合理。
  const fh = $('[data-sc-fin]', body);
  if (fh && Array.isArray(d.fin) && d.fin.length) {
    fh.innerHTML = `<div class="sc-sec"><div class="sc-title">財報（累計）</div>${
      d.fin.slice(0, 4).map((f) => kv(`${f.fy} 年 Q1–Q${f.q}`,
        `EPS ${fmtMax(f.eps_cum, 2)}${isNum(f.revenue) ? `　營收 ${fmt(num(f.revenue) / 100000, 1)} 億` : ''}`)).join('')}
      <p class="sub muted">累計是年初到該季的合計，不是單季。用來檢查上面的預估合不合理——
        已經賺到的如果比整年預估還多，那個預估就有問題。</p></div>`;
  }
}


// 族群頁：台股看落後的月營收，美股看前瞻的營收預估，兩邊分開看
// ------------------------------------------------------------
// 產業地圖
//
//   **第一版是分組的卡片列表，不是地圖。** 39 個族群疊成 3,300px，
//   上中下游只是一個小標籤而不是位置，關係只有「下游 1」這種文字，
//   而且要點開才看得到。名字叫產業鏈，看起來卻跟清單沒兩樣。
//
//   實際算過之後發現：台股 39 個族群裡有 35 個是互相連通的，
//   而且全部匯流到伺服器組裝。所以這根本不是「很多條鏈」，是**一條大鏈**。
//   那就該照它本來的樣子畫——上游、中游、下游三條帶子，由上往下流。
//
//   位置本身要帶資訊：在哪一條帶子上＝在供應鏈的哪一段，
//   不用再讀標籤。點一個族群時不是展開一塊面板，而是**把整張圖變暗、
//   只留它的上下游**，關係直接顯示在圖上。
// ------------------------------------------------------------
// ------------------------------------------------------------
// 產業地圖：桌機版
//
//   手機上只能靠「點一格、其餘變暗」來表達關係，因為 390px 畫不下連線。
//   螢幕夠寬的時候沒有這個限制，**線可以真的畫出來**。
//
//   為什麼不用拓撲分層（每個節點放在「最長上游路徑」那一層）：
//   實際算過是 27 / 7 / 2 / 1 / 1 / 1，第一層塞 27 個、後面幾層各一個，
//   比三欄還難看。上中下游是 8 / 21 / 10，平均得多，而且本來就有意義。
//
//   代價是同一欄內部有連線（中游→中游 10 條、下游→下游 4 條）。
//   處理方式是欄內先做拓撲排序讓它們一律往下流，線畫成欄右側的弧，
//   而且**平常畫得很淡、選中才亮**——這是密集網路圖的通用做法，
//   全部畫滿一樣粗只會變成一團毛線。
// ------------------------------------------------------------
const DESK_Q = typeof matchMedia === 'function' ? matchMedia('(min-width: 900px)') : null;
const isDesk = () => !!(DESK_Q && DESK_Q.matches);

// 欄內排序：只看同一欄的邊，讓來源排在目標前面
function orderColumn(list, links) {
  const inCol = new Set(list.map((m) => m.theme));
  const depth = new Map(list.map((m) => [m.theme, 0]));
  const edges = links.filter((l) => inCol.has(l.src) && inCol.has(l.dst));
  // 邊數很少（最多十幾條），跑幾輪鬆弛就會收斂，不值得寫正式的拓撲排序
  for (let i = 0; i < list.length; i += 1) {
    let moved = false;
    for (const l of edges) {
      const want = depth.get(l.src) + 1;
      if (depth.get(l.dst) < want) { depth.set(l.dst, want); moved = true; }
    }
    if (!moved) break;
  }
  return [...list].sort((a, b) => (depth.get(a.theme) - depth.get(b.theme))
    || a.parent.localeCompare(b.parent) || num(a.sort) - num(b.sort));
}

// 三段的顏色。用 dataviz 的驗證腳本跑過：明暗兩種模式都在亮度帶內、
// 彩度足夠、色盲相鄰分離 ΔE 19.3（deutan），一般視覺 23.3。
// tritan 是 6.3 落在下限帶，規則是「只有搭配次要編碼才算數」——
// 這裡每一格都有文字標籤、每一欄都有標題，符合。
const STAGE_HUE = ['#0d9488', '#6366f1', '#d97706'];

// ------------------------------------------------------------
// 產業地圖：天賦樹版（桌機）
//
//   前一版被說「像簡單的心智圖搭配說明」，而且電腦版空間利用率很低。
//   兩個原因：節點是方形文字框（看起來就是清單），資訊只能點出來（要多一步）。
//
//   網遊天賦樹的特徵其實很具體：
//     1. 節點是**圓形圖示**，名字在圖示下面而不是裡面
//     2. **滑過去就出資訊**，點擊是「鎖定」不是「查看」
//     3. 連線粗、是畫面的一部分，不是附註
//     4. 已點亮的節點有光暈
//   這一版照這四點做。
//
//   **hover 不能整個重畫。** 39 個節點每次滑過都重建 innerHTML 會閃，
//   所以聚焦是直接改 class（applyFocus），只有換市場／換篩選才重畫。
// ------------------------------------------------------------

// 圖示用族群名的第一個字。比硬湊一套符號好——每個都不一樣、
// 而且看到「玻」就知道是玻纖布，不用解碼。
function glyphOf(theme) {
  const t = String(theme || '').trim();
  const m = t.match(/^[A-Za-z0-9]+/);
  if (m) return m[0].slice(0, 3).toUpperCase();
  return t.slice(0, 1);
}

// 選一個族群時，誰要亮、亮多強
function computeFocus(mk, sel) {
  if (!sel) return { near: new Map(), path: new Map(), lit: null };
  const links = state.themeLinks.filter((l) => l.market === mk);
  const walk = (dir) => {
    const seen = new Set();
    const queue = [sel];
    while (queue.length) {
      const cur = queue.shift();
      for (const l of links) {
        const [a, b] = dir === 'up' ? [l.dst, l.src] : [l.src, l.dst];
        if (a !== cur || seen.has(b) || b === sel) continue;
        seen.add(b); queue.push(b);
      }
    }
    return seen;
  };
  const near = new Map();
  const path = new Map();
  walk('up').forEach((t) => path.set(t, 'up'));
  walk('down').forEach((t) => path.set(t, 'down'));
  links.filter((l) => l.dst === sel).forEach((l) => near.set(l.src, 'up'));
  links.filter((l) => l.src === sel).forEach((l) => near.set(l.dst, 'down'));
  near.set(sel, 'self');
  return { near, path, lit: new Set([sel, ...near.keys(), ...path.keys()]) };
}

// 只改 class，不重建 DOM——hover 才不會閃
function applyFocus(host, mk, sel) {
  const { near, path, lit } = computeFocus(mk, sel);
  $$('.mnode', host).forEach((n) => {
    const t = n.dataset.node;
    const rel = near.get(t) || '';
    const far = !rel && (path.get(t) || '');
    n.classList.toggle('rel-self', rel === 'self');
    n.classList.toggle('rel-up', rel === 'up');
    n.classList.toggle('rel-down', rel === 'down');
    n.classList.toggle('far', !!far);
    n.classList.toggle('far-up', far === 'up');
    n.classList.toggle('far-down', far === 'down');
    n.classList.toggle('dim', !!sel && !rel && !far);
  });
  $$('.medges path', host).forEach((p) => {
    const a = p.dataset.src, b = p.dataset.dst;
    let cls = 'e';
    if (sel) {
      if (a === sel) cls = 'e down';
      else if (b === sel) cls = 'e up';
      else if (lit && lit.has(a) && lit.has(b)) cls = 'e path';
      else cls = 'e off';
    }
    p.setAttribute('class', cls);
    const strong = cls === 'e up' || cls === 'e down';
    p.setAttribute('marker-end', `url(#ar${p.dataset.col}${strong ? 'h' : ''})`);
  });
}

// 把浮出框擺到被點的那一格旁邊，並且夾在地圖範圍內。
// **地圖本身不會因為它出現而改變**，這是跟原本那張插入式卡片最大的差別。
function placePop(wrap, sel, target) {
  const pop = target || $('.mpop.anchored.pinned', wrap) || $('.mpop.anchored', wrap);
  if (!pop || !sel) return;
  const node = $$('.mnode', wrap).find((n) => n.dataset.node === sel);
  if (!node) return;
  const box = wrap.getBoundingClientRect();
  const r = node.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  const GAP = 14;
  // 垂直對齊格子中線，再夾回範圍內
  let y = r.top - box.top + r.height / 2 - ph / 2;
  y = Math.max(0, Math.min(y, Math.max(0, box.height - ph)));

  // **選遮住最少「亮著的格子」的那一側。** 不管放哪邊都會蓋到東西，
  // 但蓋到變暗的格子沒差，蓋到同一條路徑上的就等於把剛點亮的東西藏起來。
  const lit = $$('.mnode', wrap).filter((n) => !n.classList.contains('dim'));
  const covers = (x) => lit.filter((n) => {
    const q = n.getBoundingClientRect();
    const nx = q.left - box.left, ny = q.top - box.top;
    return nx < x + pw && nx + q.width > x && ny < y + ph && ny + q.height > y;
  }).length;
  const right = Math.min(Math.max(0, r.right - box.left + GAP), Math.max(0, box.width - pw));
  const left = Math.min(Math.max(0, r.left - box.left - pw - GAP), Math.max(0, box.width - pw));
  const x = covers(left) <= covers(right) ? left : right;
  pop.style.left = `${Math.round(x)}px`;
  pop.style.top = `${Math.round(y)}px`;
  pop.classList.add('ready');
}

// 量完位置才畫得出線，所以一定要在 DOM 上去之後做
// 邊的三種狀態：選中的直接關係（強）、同一條路徑上的（中）、其餘（幾乎看不見）。
// 這樣看到的是「一整條分支」，不是「一個點加兩根鬚」。
function edgeState(mk, sel, l) {
  if (!sel) return 'e';
  if (l.src === sel) return 'e down';
  if (l.dst === sel) return 'e up';
  const lit = state.mapLit;
  if (lit && lit.has(l.src) && lit.has(l.dst)) return 'e path';
  return 'e off';
}

function drawEdges(wrap, mk, sel) {
  const svg = $('.medges', wrap);
  if (!svg) return;
  const box = wrap.getBoundingClientRect();
  const pos = new Map();
  $$('.mnode', wrap).forEach((n) => {
    // 接在圓盤上，不是整顆按鈕（按鈕還包含下面的名字，接在那裡線會歪）
    const r = ($('.mdisc', n) || n).getBoundingClientRect();
    pos.set(n.dataset.node, {
      l: r.left - box.left, r: r.right - box.left,
      cy: r.top - box.top + r.height / 2,
      col: Number(n.dataset.col),
    });
  });
  const W = Math.round(box.width), H = Math.round(box.height);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);

  const defs = [];
  const dim = [];
  const lit = [];
  let gi = 0;

  for (const l of state.themeLinks.filter((x) => x.market === mk)) {
    const a = pos.get(l.src), b = pos.get(l.dst);
    if (!a || !b) continue;
    const on = sel && (l.src === sel || l.dst === sel);
    let x1, y1, x2, y2, d;
    // **判斷依據是實際座標，不是欄位編號。** 中游排成兩個子欄，
    // CCL（左子欄）→ PCB（右子欄）其實是左到右，照同欄處理會繞一大圈。
    if (a.r + 10 <= b.l) {
      x1 = a.r; y1 = a.cy; x2 = b.l; y2 = b.cy;
      const mid = (x1 + x2) / 2;
      d = `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
    } else {
      // 真的重疊了才繞。最後一欄往右繞會跑出畫面，所以那一欄往左繞。
      const left = b.col === 2;
      const x = left ? Math.min(a.l, b.l) - 26 : Math.max(a.r, b.r) + 26;
      x1 = left ? a.l : a.r; y1 = a.cy;
      x2 = left ? b.l : b.r; y2 = b.cy;
      d = `M ${x1} ${y1} C ${x} ${y1}, ${x} ${y2}, ${x2} ${y2}`;
    }
    // 漸層由來源段的顏色走到目標段的顏色，方向感就出來了，
    // 不用靠箭頭也看得出誰餵誰。userSpaceOnUse 是因為同欄的弧線
    // bbox 寬度接近 0，用 objectBoundingBox 會算不出漸層。
    const id = `eg${gi++}`;
    defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse"
      x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">
      <stop offset="0" stop-color="${STAGE_HUE[a.col]}"/>
      <stop offset="1" stop-color="${STAGE_HUE[b.col]}"/></linearGradient>`);
    const cls = edgeState(mk, sel, l);
    const strong = cls === 'e up' || cls === 'e down';
    // 端點記在 data 上，applyFocus 才能只改 class 而不用重畫整張圖
    const path = `<path class="${cls}" d="${d}" stroke="url(#${id})"
      data-src="${esc(l.src)}" data-dst="${esc(l.dst)}" data-col="${b.col}"
      marker-end="url(#ar${b.col}${strong ? 'h' : ''})"/>`;
    // 亮的畫在後面才不會被淡的蓋住
    (strong || cls === 'e path' ? lit : dim).push(path);
  }

  const marker = (i, hi) => `<marker id="ar${i}${hi ? 'h' : ''}" viewBox="0 0 8 8"
    refX="7" refY="4" markerWidth="${hi ? 6 : 5}" markerHeight="${hi ? 6 : 5}"
    orient="auto-start-reverse" markerUnits="userSpaceOnUse">
    <path d="M 0 1 L 7 4 L 0 7 z" fill="${STAGE_HUE[i]}" opacity="${hi ? 1 : 0.55}"/></marker>`;
  svg.innerHTML = `<defs>${[0, 1, 2].map((i) => marker(i) + marker(i, true)).join('')}
    ${defs.join('')}</defs>${dim.join('')}${lit.join('')}`;
}

const STAGES = [
  ['上游', '原料與設備', '誰供貨給這條鏈'],
  ['中游', '製造與零組件', '把材料變成零件'],
  ['下游', '成品與服務', '賣給終端客戶'],
];

function themeStats(mk, theme) {
  if (mk === 'tw') {
    const t = state.themeTrend.find((x) => x.theme === theme);
    const v = state.themeVal.find((x) => x.theme === theme);
    return { members: t ? num(t.members) : (v ? num(v.total) : null),
             growth: t ? num(t.yoy) : null,
             ratio: v ? v.ratio_median : null, pe: v ? v.pe1_median : null };
  }
  const u = state.usThemeTrend.find((x) => x.theme === theme);
  return { members: u ? num(u.members) : null, growth: u ? num(u.growth_next) : null,
           ratio: u ? u.ratio_median : null, pe: u ? u.pe_next_median : null };
}

const linksOf = (mk, theme) => ({
  up: state.themeLinks.filter((l) => l.market === mk && l.dst === theme),
  down: state.themeLinks.filter((l) => l.market === mk && l.src === theme),
});

function renderThemeMap(host, mk) {
  const metas = state.themeMeta.filter((m) => m.market === mk);
  if (!metas.length) {
    host.innerHTML = '<div class="card"><p class="muted">還沒有產業分類資料。</p></div>';
    return;
  }
  const sel = state.mapPick && metas.some((m) => m.theme === state.mapPick) ? state.mapPick : null;
  const desk = isDesk();
  const grp = state.mapGroup || '';
  const held = mk === 'tw' ? heldSymbols() : new Set(state.us.map((s) => norm(s.symbol)));
  const memberRows = mk === 'tw' ? state.themeMembers : state.usThemeMembers;
  const mine = new Set(memberRows.filter((m) => held.has(norm(m.symbol))).map((m) => m.theme));
  const bench = mk === 'tw' ? idxRatio() : usIdxRatio();
  const parents = [...new Set(metas.map((m) => m.parent))];

  // 聚焦狀態不在這裡算——那是 applyFocus 的事，因為 hover 時只能改 class，
  // 重建 innerHTML 會閃。這裡只負責把靜態的樹畫出來。

  // 桌機是圓形圖示節點（名字在下面），手機維持方塊（390px 放不下圖示 + 名字）
  const tile = (m, col) => {
    const s = themeStats(mk, m.theme);
    const owned = mine.has(m.theme);
    if (!desk) {
      return `<button type="button" class="mnode${owned ? ' mine' : ''}"
        data-node="${esc(m.theme)}" data-col="${col}">
        <span class="mname">${esc(m.theme)}</span>
        <span class="mrow"><span class="${plClass(num(s.growth))}">${
          isNum(s.growth) ? signed(num(s.growth) * 100, 0) + '%' : '–'}</span>
          <span class="muted">${fmt(s.members)} 檔</span></span>
      </button>`;
    }
    return `<button type="button" class="mnode talent${owned ? ' mine' : ''}"
      data-node="${esc(m.theme)}" data-col="${col}">
      <span class="mdisc"><span class="mglyph">${esc(glyphOf(m.theme))}</span>
        <span class="mcount">${fmt(s.members)}</span></span>
      <span class="mname">${esc(m.theme)}</span>
      <span class="mstat ${plClass(num(s.growth))}">${
        isNum(s.growth) ? signed(num(s.growth) * 100, 0) + '%' : '–'}</span>
    </button>`;
  };

  // 大類篩選在這裡就過濾掉，不要留給 CSS——用 display:none 藏格子的話，
  // 整條帶子會變成「只有標題、裡面空無一物」的空殼。
  const byStage = (st) => metas
    .filter((m) => (m.stage || '中游') === st && (!grp || m.parent === grp))
    .sort((a, b) => (a.parent === b.parent ? num(a.sort) - num(b.sort) : a.parent.localeCompare(b.parent)));

  const detailOf = (theme, pinned) => (() => {
    const sel = theme;
    const c = linksOf(mk, sel);
    const meta = metas.find((m) => m.theme === sel);
    const s = themeStats(mk, sel);
    const rows = memberRows.filter((m) => m.theme === sel);
    const line = (l, dir) => `<div class="mlink">
      <span class="marrow">${dir === 'up' ? '↑' : '↓'}</span>
      <button type="button" class="link" data-node="${esc(dir === 'up' ? l.src : l.dst)}">${
        esc(dir === 'up' ? l.src : l.dst)}</button>
      ${l.note ? `<span class="sub muted">${esc(l.note)}</span>` : ''}</div>`;
    // **不能是一張插在版面裡的卡。** 它一出現整張圖就往下推，
    // 點下一格又推一次，位置一直跳——使用者的說法是「不穩定」。
    // 改成浮在地圖上、貼著被點的那一格（桌機）或釘在底部（手機），
    // 就像天賦樹的 tooltip：出現與消失都不會動到樹本身。
    return `<div class="mpop${desk ? ' anchored' : ' sheet'}${pinned ? ' pinned' : ''}">
      <div class="row-between">
        <span class="list-title">${esc(sel)}</span>
        ${pinned ? '<button type="button" class="small" data-node-clear>關閉</button>'
          : '<span class="sub muted">點一下鎖定</span>'}
      </div>
      <p class="sub muted">${esc(meta?.parent || '')}・${esc(meta?.stage || '')}　${
        fmt(s.members)} 檔${isNum(s.ratio) ? `　報酬/波動 <b class="${
          num(s.ratio) > bench ? 'gain' : ''}">${fmtMax(s.ratio, 2)}</b>` : ''}${
        isNum(s.pe) ? `　本益比 ${fmtMax(s.pe, 1)}x` : ''}</p>
      ${c.up.length ? `<div class="mgroup"><div class="mlabel">誰供貨給它</div>${
        c.up.map((l) => line(l, 'up')).join('')}</div>` : ''}
      ${c.down.length ? `<div class="mgroup"><div class="mlabel">它供貨給誰</div>${
        c.down.map((l) => line(l, 'down')).join('')}</div>` : ''}
      ${!c.up.length && !c.down.length
        ? '<p class="sub muted">這個族群沒有登記上下游關係。</p>' : ''}
      ${rows.length ? `<div class="mgroup"><div class="mlabel">成分股</div>
        <div class="chain-row members">${rows.map((m) =>
          `<button type="button" class="chip plain" data-stock="${mk}:${esc(norm(m.symbol))}">${
            esc(m.symbol)} ${esc(m.name || TW_STOCKS[norm(m.symbol)] || '')}${
            held.has(norm(m.symbol)) ? '<span class="badge day-badge">持有</span>' : ''}</button>`).join('')}</div>
      </div>` : ''}
    </div>`;
  })();
  const detail = sel ? detailOf(sel, true) : '';

  host.innerHTML = `
    <div class="card mhead">
      <div class="list-title">產業地圖</div>
      <p class="sub muted">由上往下是供應鏈的流向。${mk === 'tw'
        ? '台股 39 個族群裡有 35 個互相連通，而且<b>全部匯流到伺服器組裝</b>——這不是很多條鏈，是一條大鏈。'
        : '美股這張圖同樣由上往下流，終點是雲端與 AI 應用。'}
        ${desk ? '線就是供應關係，點一格會把它的線亮起來。' : '點任何一格，圖上只會留下它的上下游。'}</p>
      <div class="mchips">
        <button type="button" class="chip${grp ? '' : ' on'}" data-group="">全部</button>
        ${parents.map((p) => `<button type="button" class="chip${
          grp === p ? ' on' : ''}" data-group="${esc(p)}">${esc(p)}</button>`).join('')}
      </div>
    </div>
    <div class="mapwrap${desk ? ' desk' : ''}">
      ${desk ? '<svg class="medges" aria-hidden="true"></svg>' : ''}
      ${desk ? detail : ''}
      ${desk ? `<div class="mcols">${STAGES.map(([st, title, sub], i) => {
        const list = orderColumn(byStage(st), state.themeLinks.filter((l) => l.market === mk));
        if (!list.length) return '';
        // 中游有 21 個、上下游各 8 與 10，單欄排下去高度會差三倍。
        // 超過 12 個就排成兩欄，三欄的高度才接近。
        // 欄內再依大類分群。天賦樹的分支感就是這樣來的——
        // 一欄裡不是 21 個並排，是三四個有名字的小群。
        const clus = [];
        for (const m of list) {
          let g = clus.find((x) => x.name === m.parent);
          if (!g) { g = { name: m.parent, list: [] }; clus.push(g); }
          g.list.push(m);
        }
        return `<div class="mcol band-${i}">
          <div class="mband-head"><b>${st}</b><span class="muted">${title}</span>
            <span class="sub muted">${sub}</span></div>
          ${clus.map((g) => `<div class="mclus">
            <div class="mclus-label">${esc(g.name)}</div>
            <div class="mclus-nodes">${g.list.map((m) => tile(m, i)).join('')}</div>
          </div>`).join('')}
        </div>`;
      }).join('')}</div>`
      : STAGES.map(([st, title, sub], i) => {
        const list = byStage(st);
        if (!list.length) return '';
        return `<div class="mband band-${i}">
          <div class="mband-head"><b>${st}</b><span class="muted">${title}</span>
            <span class="sub muted">${sub}</span></div>
          <div class="mgrid">${list.map((m) => tile(m, i)).join('')}</div>
        </div>
        ${i < STAGES.length - 1 ? '<div class="mflow">↓</div>' : ''}`;
      }).join('')}
    </div>
    ${desk ? '' : detail}
    <p class="hint">格子的位置就是它在供應鏈的位置，不用再讀標籤。
      數字是${mk === 'tw' ? '月營收年增（已發生）' : '明年營收預估（前瞻）'}。
      左邊有藍線的是你有持股的族群。
      <b>攤開來看最大的用處是檢查自己有沒有把同一條鏈買了很多次</b>——
      玻纖布 → CCL → PCB → 伺服器組裝是同一條，分開看像四個標的，實際上是一個賭注。</p>`;

  const pick = (t) => { state.mapPick = state.mapPick === t ? null : t; renderThemeMap(host, mk); };
  $$('[data-node]', host).forEach((b) => (b.onclick = (e) => { e.stopPropagation(); pick(b.dataset.node); }));

  // **滑過去就出資訊，點擊才是鎖定。** 天賦樹就是這樣：
  // 看一個天賦不用點，點是為了「選它」。原本什麼都要點一下才看得到，
  // 39 個節點要逐一點過去才知道是什麼，那才是不直覺的來源。
  if (desk) {
    const wrap = $('.mapwrap', host);
    let hoverPop = null;
    const clearHover = () => {
      if (hoverPop) { hoverPop.remove(); hoverPop = null; }
      applyFocus(host, mk, state.mapPick);
    };
    $$('.mnode', host).forEach((n) => {
      n.onmouseenter = () => {
        const t = n.dataset.node;
        if (state.mapPick === t) return;         // 已經鎖定它了就不用再浮一個
        applyFocus(host, mk, t);
        if (hoverPop) hoverPop.remove();
        wrap.insertAdjacentHTML('beforeend', detailOf(t, false));
        hoverPop = wrap.lastElementChild;
        hoverPop.classList.add('hover');
        placePop(wrap, t, hoverPop);
        bindStockOpen(hoverPop);
        $$('[data-node]', hoverPop).forEach((b) => (b.onclick = (e) => {
          e.stopPropagation(); pick(b.dataset.node);
        }));
      };
      n.onmouseleave = clearHover;
    });
  }
  $$('[data-node-clear]', host).forEach((b) => (b.onclick = () => { state.mapPick = null; renderThemeMap(host, mk); }));

  // **點空白處就關掉。** 原本一定要按到那顆「關閉」，
  // 在手機上那是個很小的目標，在桌機上也不合直覺——
  // 浮出視窗的通用行為就是點外面關掉、Esc 關掉。
  if (state.mapPick && !state.mapOutside) {
    state.mapOutside = (e) => {
      if (!state.mapPick) return;
      if (e.target.closest && (e.target.closest('.mpop') || e.target.closest('[data-node]')
          || e.target.closest('#info-dialog'))) return;
      state.mapPick = null;
      const h = $('[data-themebody]');
      if (h && $('.mapwrap', h)) renderThemeMap(h, state.themeMarket === 'us' ? 'us' : 'tw');
    };
    state.mapEsc = (e) => { if (e.key === 'Escape' && state.mapPick) state.mapOutside({ target: document.body }); };
    // 用 capture 會在按鈕自己的 onclick 之前跑，那樣點節點會先被關掉，所以不加
    addEventListener('pointerdown', state.mapOutside);
    addEventListener('keydown', state.mapEsc);
  }
  if (!state.mapPick && state.mapOutside) {
    removeEventListener('pointerdown', state.mapOutside);
    removeEventListener('keydown', state.mapEsc);
    state.mapOutside = null; state.mapEsc = null;
  }
  $$('[data-group]', host).forEach((b) => (b.onclick = () => {
    state.mapGroup = b.dataset.group === state.mapGroup ? '' : b.dataset.group;
    renderThemeMap(host, mk);
  }));
  bindStockOpen(host);

  // **手機也要套聚焦。** 狀態 class 現在由 applyFocus 統一上，
  // 如果只在桌機分支呼叫，手機點下去就什麼都不會亮。
  applyFocus(host, mk, sel);

  if (desk) {
    const wrap = $('.mapwrap', host);
    // 量位置一定要等版面排完，所以排進下一幀
    requestAnimationFrame(() => {
      drawEdges(wrap, mk, sel);
      applyFocus(host, mk, sel);
      placePop(wrap, sel);
    });
    // 視窗寬度變了，線的位置就不對了
    clearTimeout(state.mapResizeT);
    if (!state.mapBound) {
      state.mapBound = true;
      addEventListener('resize', () => {
        clearTimeout(state.mapResizeT);
        state.mapResizeT = setTimeout(() => {
          const h = $('[data-themebody]');
          if (h && $('.mapwrap', h)) renderThemeMap(h, state.themeMarket === 'us' ? 'us' : 'tw');
        }, 150);
      });
    }
  }

  // 手機：把選中的格子捲到畫面中間。底部面板佔 38vh，中間剛好在它上面，
  // 所以點完之後看得到那一格與它亮起來的鄰居。
  if (sel && !desk) {
    const n = $$('.mnode', host).find((x) => x.dataset.node === sel);
    if (n) n.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}
// ------------------------------------------------------------
// 今日：哪個族群在動
//   這頁是為了「永遠不要放空當天強勢的股票」那條紀律做的。
//   要能執行那條規則，得先看得到「今天是不是整群在漲」，
//   以及每一檔「從當日低點拉了多少」——那才是判斷強弱的數字。
//
//   華新科 2026-09-10 是活教材：對昨收 +4.5% 看起來還好，
//   但它從低點 303 拉到 334，是 +10.2%，而且 MLCC 電容是當天最強的族群。
//   使用者在 317.5 空 2 口、328 回補，賠了 42,000。
//
//   這是收盤資料，用途是隔天回頭看自己做了什麼，不是盤中攔截。
// ------------------------------------------------------------
function renderThemeDay(host) {
  const rows = state.themeDay.filter((t) => isNum(t.chg_med));
  if (!rows.length) {
    host.innerHTML = '<div class="card"><p class="muted">還沒有當日漲跌資料，按右上角 ↻ 更新。</p></div>';
    return;
  }
  const held = heldSymbols();
  const mineThemes = new Set(state.themeMembers.filter((m) => held.has(norm(m.symbol))).map((m) => m.theme));
  const asOf = rows.map((t) => t.as_of).filter(Boolean).sort().pop();
  // 整群在漲才叫族群性大漲：中位數為正、而且上漲家數佔多數
  const hot = (t) => num(t.chg_med) > 0.02 && num(t.up) > num(t.members) / 2;

  host.innerHTML = `
    <div class="card">
      <div class="list-title">今日族群漲跌</div>
      <p class="sub muted">${esc(asOf || '')} 收盤。取<b>中位數</b>不取平均，一檔漲停就會把平均拉爛。
        <b>整群在漲</b>（中位數 &gt;2% 且過半上漲）的會標紅框——
        <b>那是不能去空的族群。</b></p>
    </div>
    <div class="card list">
      ${rows.map((t) => `<div class="day-theme${hot(t) ? ' hot' : ''}${
        mineThemes.has(t.theme) ? ' mine' : ''}">
        <div class="row-between">
          <span class="list-title">${esc(t.theme)}${
            mineThemes.has(t.theme) ? '<span class="badge day-badge">持有</span>' : ''}${
            hot(t) ? '<span class="badge warn-badge">整群在漲</span>' : ''}</span>
          <span class="theme-yoy ${plClass(num(t.chg_med))}">${signed(num(t.chg_med) * 100, 2)}%</span>
        </div>
        <div class="row-between sub muted">
          <span>${fmt(t.members)} 檔　<span class="gain">漲 ${fmt(t.up)}</span>　<span class="loss">跌 ${fmt(t.down)}</span></span>
          <span>從低點拉起 <b class="${num(t.off_low_med) > 0.03 ? 'gain' : ''}">${
            isNum(t.off_low_med) ? signed(num(t.off_low_med) * 100, 1) + '%' : '–'}</b></span>
        </div>
        ${t.top_symbol ? `<div class="row-between sub muted">
          <span>最強 <span class="link" role="button" tabindex="0" data-stock="tw:${esc(norm(t.top_symbol))}">${
            esc(t.top_symbol)} ${esc(t.top_name || '')}</span></span>
          <span class="${plClass(num(t.top_chg))}">${signed(num(t.top_chg) * 100, 2)}%</span>
        </div>` : ''}
      </div>`).join('')}
    </div>
    <p class="hint"><b>「從低點拉起」比「對昨收漲跌」重要。</b>
      一檔今天對昨收還是跌的，不代表它弱——華新科 2026-09-10 對昨收看起來只有 +4.5%，
      但它從當日低點 303 拉到 334，是 +10.2%，而且 MLCC 電容是當天中位數最高的族群。
      在那種位置放空，等於站在整群買盤的對面。
      這裡是<b>收盤</b>資料，不是即時報價，用途是隔天回頭檢查自己昨天做了什麼。</p>`;
  bindStockOpen(host);
}

// ------------------------------------------------------------
// 選股
//   他自己講過策略：「不能做動能，現在適合反市場，在下跌中買入好公司，
//   拉起來回檔後加碼」。那句話拆開就是三個條件：
//     好公司  = 報酬/波動贏得過大盤（不然不如直接開槓桿買指數）
//     在下跌 = 離三年高點夠遠
//     不是地雷 = 有人在報、而且沒被交易所盯上
//   這頁就是把那三件事變成可以按的東西。
//
//   **池子是全市場**：台股約 1,970 檔（所有有公告月營收的普通股），
//   美股約 2,000 檔（日成交額 2,000 萬美元以上，進得去也出得來的）。
//   四千列不可能每次登入都載下來，所以篩選與排序都在資料庫做，
//   一次只回前 60 檔。代價是拉桿要等一次往返，所以要防連點。
// ------------------------------------------------------------

const SCREEN_DEFAULT = {
  beat: true,        // 報酬/波動要贏過大盤
  covered: false,    // 至少三位分析師
  clean: true,       // 排除處置與注意股
  drop: 20,          // 至少從三年高點跌下來幾 %
  peMax: 0,          // 本益比上限，0 = 不限
  growth: null,      // 營收年增下限
  q: '',             // 關鍵字（代號／名稱／族群／產業別／主要經營業務）
  sort: 'drop',
};
const SCREEN_SORT = [
  ['drop', '跌最多'],
  ['ratio', '報酬/波動'],
  ['pe', '本益比'],
  ['growth', '營收成長'],
];

let screenSeq = 0;   // 連點時只認最後一次的結果

async function runScreen(mk, f) {
  const { data, error } = await sb.rpc('screen_stocks', {
    p_market: mk,
    p_beat: !!f.beat,
    p_covered: !!f.covered,
    p_clean: !!f.clean,
    p_drop: num(f.drop),
    p_pe_max: num(f.peMax),
    p_growth: isNum(f.growth) && f.growth !== '' ? num(f.growth) : null,
    p_q: (f.q || '').trim() || null,
    p_sort: f.sort,
    p_limit: 60,
  });
  if (error) throw error;
  return data ?? [];
}

function renderScreener(host, mk) {
  const f = { ...SCREEN_DEFAULT, ...(state.screen || {}) };
  state.screen = f;
  const held = mk === 'us' ? new Set(state.us.map((s) => norm(s.symbol))) : heldSymbols();
  const bench = mk === 'us' ? usIdxRatio() : idxRatio();
  const rows = state.screenRows || [];
  const total = rows.length ? num(rows[0].total) : 0;

  const chk = (k, label, hint) => `<label class="screen-chk">
    <input type="checkbox" data-sc="${k}" ${f[k] ? 'checked' : ''}>
    <span>${label}${hint ? `<span class="sub muted">　${hint}</span>` : ''}</span></label>`;

  // 條件面板預設收起來。**原本展開時第一筆結果落在 969px、手機視窗只有 844px**，
  // 等於每次進來都要先捲過整個表單才看得到任何一檔。收起來之後條件變成一行摘要，
  // 要改再點開。搜尋框留在外面，因為那是最常用的。
  const open = !!state.screenOpen;
  const summary = [
    f.beat ? `贏過${mk === 'us' ? 'NDX' : '大盤'}` : null,
    num(f.drop) > 0 ? `跌${fmt(f.drop)}%以上` : null,
    f.covered ? '有分析師' : null,
    mk === 'tw' && f.clean ? '排除警示' : null,
    num(f.peMax) > 0 ? `本益比≤${fmt(f.peMax)}` : null,
    isNum(f.growth) && f.growth !== null && f.growth !== '' ? `成長≥${fmt(f.growth)}%` : null,
  ].filter(Boolean);

  host.innerHTML = `
    <div class="card">
      <div class="row-between">
        <span class="list-title">選股<span class="muted sub">　${mk === 'us' ? '美股' : '台股'}全市場</span></span>
        <span class="sub muted" data-screen-count>${state.screenBusy ? '篩選中…'
          : `${fmt(total)} 檔符合${total > rows.length ? `，顯示前 ${fmt(rows.length)} 檔` : ''}`}</span>
      </div>
      <label class="screen-q">
        <input type="search" data-sc-q value="${esc(f.q || '')}" enterkeyhint="search"
          placeholder="${mk === 'us' ? '搜尋代號、名稱、族群、產業、業務' : '搜尋代號、名稱、族群、主要經營業務'}">
      </label>
      <button type="button" class="screen-toggle" data-sc-open aria-expanded="${open}">
        <span>${summary.length ? esc(summary.join('・')) : '沒有設任何條件'}</span>
        <span class="chev">${open ? '收起' : '改條件'}</span>
      </button>
      <div class="screen-form" ${open ? '' : 'hidden'}>
        ${chk('beat', `報酬/波動贏過${mk === 'us' ? '那斯達克 100' : '加權指數'}`,
              isNum(bench) ? `>${fmtMax(bench, 2)}` : '')}
        ${chk('covered', '至少三位分析師', '避開沒人看的')}
        ${mk === 'tw' ? chk('clean', '排除處置與注意股', '進去會卡住') : ''}
        <div class="screen-nums">
          <label>離高點跌<input type="number" data-sc-n="drop" value="${esc(f.drop)}"
            min="0" max="90" step="5" inputmode="decimal"><span>%</span></label>
          <label>本益比≤<input type="number" data-sc-n="peMax" value="${esc(f.peMax)}"
            min="0" step="5" inputmode="decimal" placeholder="不限"><span>x</span></label>
          <label>成長≥<input type="number" data-sc-n="growth"
            value="${f.growth === null ? '' : esc(f.growth)}" step="10" inputmode="decimal"
            placeholder="不限"><span>%</span></label>
        </div>
        <p class="sub muted">你說過的策略是<b>在下跌中買好公司</b>——贏得過大盤、離高點夠遠、
          有人在報而且沒被盯上，就是這三格。
          ${mk === 'us'
            ? '池子是日成交額 <b>2,000 萬美元</b>以上的股票，成長率是<b>明年營收預估</b>（前瞻）。'
            : '池子是<b>全市場</b>有公告月營收的普通股，成長率是<b>月營收年增</b>（已發生）。'}
          ${mk === 'tw' ? '搜尋吃的是公司申報的業務，所以想找「小金居」就搜<b>銅箔</b>。' : ''}</p>
      </div>
      <div class="seg nav-seg sort-seg">${SCREEN_SORT.map(([v, l]) =>
        `<label><input type="radio" name="scsort" value="${v}" ${
          f.sort === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
    </div>
    ${rows.length ? `<div class="card list">${rows.map((r) => `
      <div class="line member" role="button" tabindex="0" data-stock="${mk}:${esc(norm(r.symbol))}">
        <div class="row-between">
          <span>${esc(r.symbol)} ${esc(r.name || '')}${
            held.has(norm(r.symbol)) ? '<span class="badge day-badge">持有</span>' : ''}${
            r.story ? `<span class="badge story-badge">${
              esc(String(r.story).split(' ')[0])}</span>` : ''}${
            r.alert_kind ? `<span class="badge alert-${esc(r.alert_kind)}">${
              ALERT_LABEL[r.alert_kind] || ''}</span>` : ''}</span>
          <span class="${plClass(num(r.drop_pct))}">${
            isNum(r.drop_pct) ? signed(num(r.drop_pct) * 100, 0) + '%' : '–'}<span class="sub muted"> 距高點</span></span>
        </div>
        <div class="row-between sub muted">
          <span>${mk === 'us' ? '$' : ''}${fmtMax(r.price, 2)}　三年區間 ${
            fmtMax(r.lo3y, 1)}–${fmtMax(r.hi3y, 1)}</span>
          <span>報酬/波動 <b class="${isNum(r.ratio) && isNum(bench) && num(r.ratio) > bench ? 'gain' : ''}">${
            fmtMax(r.ratio, 2)}</b></span>
        </div>
        <div class="row-between sub muted">
          <span>${isNum(r.pe)
            ? `本益比 ${fmtMax(r.pe, 1)}x<span class="muted">（${esc(r.pe_src || '')}${
                r.fy ? ' ' + String(r.fy).slice(2) : ''}）</span>`
            : '無本益比'}${num(r.analysts) > 0 ? `　${fmt(r.analysts)} 位` : ''}</span>
          <span>${mk === 'us' ? '明年營收' : '營收年增'} <span class="${plClass(num(r.growth))}">${
            isNum(r.growth) ? signed(num(r.growth) * 100, 0) + '%' : '–'}</span></span>
        </div>
        <div class="sub muted ellip">${(() => {
          // 族群與業務原本會黏在一起（「玻纖布電子零組件業」），
          // 是因為分隔符只在 business 有值時才插，但實際顯示的是 business ?? industry。
          const desc = (r.business || r.industry || '').trim();
          const parts = [r.themes, desc.length > 30 ? desc.slice(0, 30) + '…' : desc].filter(Boolean);
          return esc(parts.join('　'));
        })()}</div>
      </div>`).join('')}</div>`
      : `<div class="card"><p class="muted">${state.screenBusy ? '篩選中…'
        : '沒有符合的。條件放寬一點——通常是「跌幅」設太深了。'}</p></div>`}
    <p class="hint"><b>這頁挑出來的是候選，不是買進訊號。</b>
      跌得深有兩種原因：被錯殺，或是基本面真的壞了，這頁分不出來，要自己點進去看營收與預估。
      「距高點」用的是三年最高收盤，跟波動、報酬取自同一份 Yahoo 日線，所以一定一致。
      ${mk === 'tw'
        ? '本益比優先用分析師預估，沒有預估的退回官方每日公告的近四季，括號裡會標是哪一種。'
          + '台股只有大約六成有人覆蓋，勾「至少三位分析師」會少掉很多檔，那是正常的。'
        : '本益比是明年預估。池子已經先用流動性篩過，太冷門的不會出現在這裡。'}
      報酬/波動需要三年日線，<b>上市未滿兩年的算不出來，會被「贏過大盤」這個條件濾掉</b>。</p>`;

  const refire = () => renderScreener(host, mk);
  $$('[data-sc]', host).forEach((c) => (c.onchange = () => {
    state.screen = { ...state.screen, [c.dataset.sc]: c.checked };
    loadScreen(host, mk);
  }));
  $$('[data-sc-n]', host).forEach((i) => (i.onchange = () => {
    const v = i.value === '' ? null : num(i.value);
    state.screen = { ...state.screen, [i.dataset.scN]: v };
    loadScreen(host, mk);
  }));
  $$('input[name=scsort]', host).forEach((r) => (r.onchange = () => {
    state.screen = { ...state.screen, sort: r.value };
    loadScreen(host, mk);
  }));
  const tg = $('[data-sc-open]', host);
  if (tg) tg.onclick = () => { state.screenOpen = !state.screenOpen; refire(); };
  const q = $('[data-sc-q]', host);
  if (q) {
    // 打字每一個字都送會打爆資料庫，停 400ms 才送；Enter 立刻送
    let timer = null;
    const fire = () => {
      clearTimeout(timer);
      state.screen = { ...state.screen, q: q.value };
      loadScreen(host, mk, () => {
        const el = $('[data-sc-q]', host);
        if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
      });
    };
    q.oninput = () => { clearTimeout(timer); timer = setTimeout(fire, 400); };
    q.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); fire(); } };
  }
  bindStockOpen(host);
  return refire;
}

// 打一次 RPC 再重畫。連點時只認最後一次的結果，免得舊的蓋掉新的。
async function loadScreen(host, mk, after) {
  const seq = ++screenSeq;
  state.screenBusy = true;
  const count = $('[data-screen-count]', host);
  if (count) count.textContent = '篩選中…';
  try {
    const rows = await runScreen(mk, state.screen || SCREEN_DEFAULT);
    if (seq !== screenSeq) return;
    state.screenRows = rows;
  } catch (e) {
    if (seq !== screenSeq) return;
    state.screenRows = [];
    toast(e.message || '篩選失敗');
  } finally {
    if (seq === screenSeq) {
      state.screenBusy = false;
      renderScreener(host, mk);
      if (after) after();
    }
  }
}

// ------------------------------------------------------------
// 主動型 ETF
//
//   這一頁回答兩件事：
//     1. 這些公開宣稱要打敗指數的人，**到底有沒有打敗**
//     2. 他們的錢**押在哪些產業**
//
//   第二件事沒有持股資料。每日申購買回清單只在各家投信自己的網站上，
//   十三家格式都不一樣，國泰那個網域還整站擋自動存取。
//   所以改用報酬式風格分析推估——基金的日報酬跟哪個族群一起動，
//   就是押在哪裡。**是相關性不是權重**，畫面上要講清楚，不能讓人誤會成持股。
// ------------------------------------------------------------
const ETF_SCOPES = [['tw', '台股', '0050'], ['us', '美股', '00662'], ['global', '全球', '00646']];

async function loadEtf(host) {
  if (state.etfBusy) return;
  state.etfBusy = true;
  try {
    const { data, error } = await sb.rpc('etf_board');
    if (error) throw error;
    state.etfBoard = data || null;
  } catch (e) {
    toast(e.message || '主動型 ETF 資料讀取失敗');
  } finally {
    state.etfBusy = false;
    renderEtf(host);
  }
}

function renderEtf(host) {
  const b = state.etfBoard;
  if (!b) {
    host.innerHTML = `<div class="card"><p class="muted">${
      state.etfBusy ? '讀取中…' : '還沒有主動型 ETF 資料。'}</p></div>`;
    return;
  }
  const all = (b.funds || []).filter((f) => isNum(f.days));
  const scope = ETF_SCOPES.some((x) => x[0] === state.etfScope) ? state.etfScope : 'tw';
  const meta = ETF_SCOPES.find((x) => x[0] === scope);
  const rows = all.filter((f) => f.scope === scope);
  const win = rows.filter((f) => num(f.excess) > 0).length;
  const young = (b.funds || []).length - all.length;
  // 只有一檔押的族群列出來沒有意義——那是單一基金的選擇不是共識，
  // 而且尾巴一長串「1」會把真正集中的那幾個擠到看不見。
  const crowdAll = (b.crowd || []).filter((c) => num(c.top5) > 0);
  const crowd = crowdAll.filter((c) => num(c.top5) >= 2);
  const crowdTail = crowdAll.length - crowd.length;
  const rated = num(b.rated) || 1;

  host.innerHTML = `
    <div class="card">
      <div class="list-title">主動型 ETF</div>
      <p class="sub muted">${esc(b.as_of || '')}。代號 <b>A 結尾</b>的就是主動型，
        這是主管機關的編碼規則。比較的對象不是指數而是<b>同期的被動 ETF</b>——
        指數不能買，${esc(meta[2])} 可以，而且同樣台幣計價、同樣的交易時間。
        報酬<b>含息</b>（還原除息與分割），不然高息型的會被當成在虧錢。</p>
    </div>

    <div class="seg nav-seg etf-seg">
      ${ETF_SCOPES.map(([k, label]) => `<label><input type="radio" name="etfsc" value="${k}" ${
        scope === k ? 'checked' : ''}><span>${label} ${
        all.filter((f) => f.scope === k).length}</span></label>`).join('')}
    </div>

    <div class="card">
      <div class="row-between">
        <span class="list-title">贏過 ${esc(meta[2])} 的</span>
        <span class="etf-score ${win * 2 >= rows.length ? 'gain' : 'loss'}">${win} / ${rows.length}</span>
      </div>
      <p class="sub muted">用<b>掛牌以來</b>的報酬比，而且對照組取同一段期間——
        2025 年 4 月掛牌的跟 2026 年 8 月掛牌的，比絕對報酬等於在比誰運氣好。${
        young ? `另有 ${young} 檔掛牌未滿 20 個交易日，先不列。` : ''}</p>
    </div>

    ${scope === 'tw' && crowd.length ? `<div class="card">
      <div class="list-title">這些錢押在哪裡</div>
      <p class="sub muted"><b>這是推估，不是持股。</b>每日持股各家投信只放在自己網站、
        沒有集中來源，所以改看日報酬——一檔基金重押哪個族群，它就會跟那個族群一起動。
        兩邊都先扣掉大盤，不然台股什麼跟什麼都相關 0.8。
        下面是 ${rated} 檔台股主動型 ETF 裡，有幾檔把這個族群排進<b>前五名</b>。</p>
      <div class="etf-crowd">
        ${crowd.map((c) => `<div class="etf-crow" role="button" tabindex="0" data-tilt="${esc(c.theme)}">
          <span class="etf-cname">${esc(c.theme)}</span>
          <span class="etf-bar"><i style="width:${Math.round(num(c.top5) / rated * 100)}%"></i></span>
          <span class="etf-cnum">${fmt(c.top5)}</span>
        </div>`).join('')}
      </div>
      ${crowdTail ? `<p class="sub muted">另有 ${crowdTail} 個族群只有 1 檔基金押，沒列出來。</p>` : ''}
    </div>` : ''}

    <div class="card list">
      ${rows.length ? rows.map((f) => {
        const open = state.etfOpen === f.symbol;
        const ex = num(f.excess);
        return `<div class="etf-row${open ? ' open' : ''}" data-etf="${esc(f.symbol)}" role="button" tabindex="0">
          <div class="row-between">
            <span class="list-title">${esc(f.name || f.symbol)}</span>
            <span class="theme-yoy ${plClass(ex)}">${signed(ex * 100, 1)}%</span>
          </div>
          <div class="row-between sub muted">
            <span>${esc(f.symbol)}　${fmt(f.days)} 天</span>
            <span>${signed(num(f.ret) * 100, 1)}% <span class="muted">vs ${
              esc(f.bench)} ${signed(num(f.bench_ret) * 100, 1)}%</span></span>
          </div>
          ${(f.tilts || []).length ? `<div class="etf-tilts">${
            (f.tilts || []).slice(0, open ? 6 : 3).map((t) => `<span class="etf-chip" role="button"
              tabindex="0" data-tilt="${esc(t.theme)}">${esc(t.theme)}
              <b>${Number(t.corr).toFixed(2)}</b></span>`).join('')}</div>` : ''}
          ${open ? `<div class="sub muted etf-more">
            ${esc(f.issuer || '')}${f.issuer ? '　' : ''}${esc(f.listed_on || '')} 掛牌　
            年化波動 ${isNum(f.vol) ? pct(f.vol) : '–'}　
            對照組 ${esc(f.bench)}（相關 ${isNum(f.bench_corr) ? Number(f.bench_corr).toFixed(2) : '–'}）
          </div>` : ''}
        </div>`;
      }).join('') : '<p class="muted">這一組還沒有滿 20 個交易日的基金。</p>'}
    </div>`;

  $$('input[name=etfsc]', host).forEach((r) => (r.onchange = () => {
    state.etfScope = r.value; state.etfOpen = '';
    renderEtf(host);
  }));
  // 點族群就跳到產業鏈那一頁並且鎖定它，不用自己再找一次
  $$('[data-tilt]', host).forEach((n) => (n.onclick = (e) => {
    e.stopPropagation();
    state.mapPick = n.dataset.tilt;
    state.themeMarket = 'tw';
    state.themeView = 'tree';
    render();
  }));
  $$('[data-etf]', host).forEach((n) => (n.onclick = () => {
    state.etfOpen = state.etfOpen === n.dataset.etf ? '' : n.dataset.etf;
    renderEtf(host);
  }));
}

function renderThemes(el) {
  const mk = state.themeMarket === 'us' ? 'us' : 'tw';
  const vw = ['tree', 'day', 'screen', 'etf'].includes(state.themeView) ? state.themeView : 'list';
  el.innerHTML = `<div class="seg nav-seg market-seg">
      <label><input type="radio" name="mkt" value="tw" ${mk === 'tw' ? 'checked' : ''}><span>台股</span></label>
      <label><input type="radio" name="mkt" value="us" ${mk === 'us' ? 'checked' : ''}><span>美股</span></label>
    </div>
    <div class="seg nav-seg view-seg">
      <label><input type="radio" name="tvw" value="list" ${vw === 'list' ? 'checked' : ''}><span>清單</span></label>
      <label><input type="radio" name="tvw" value="tree" ${vw === 'tree' ? 'checked' : ''}><span>產業鏈</span></label>
      ${mk === 'tw'
        ? `<label><input type="radio" name="tvw" value="day" ${vw === 'day' ? 'checked' : ''}><span>今日</span></label>` : ''}
      <label><input type="radio" name="tvw" value="screen" ${vw === 'screen' ? 'checked' : ''}><span>選股</span></label>
      ${mk === 'tw'
        ? `<label><input type="radio" name="tvw" value="etf" ${vw === 'etf' ? 'checked' : ''}><span>主動ETF</span></label>` : ''}
    </div><div data-themebody></div>`;
  const host = $('[data-themebody]', el);
  // 今日只有台股有，證交所與櫃買的收盤檔本來就帶開高低，美股那邊沒有同一份資料
  if (vw === 'etf' && mk === 'tw') { renderEtf(host); if (!state.etfBoard) loadEtf(host); }
  else if (vw === 'day' && mk === 'tw') renderThemeDay(host);
  else if (vw === 'screen') { renderScreener(host, mk); loadScreen(host, mk); }
  else if (vw === 'tree') renderThemeMap(host, mk);
  else (mk === 'us' ? renderUsThemes : renderTwThemes)(host);
  $$('input[name=mkt]', el).forEach((r) => (r.onchange = () => {
    state.themeMarket = r.value;
    // 「今日」只有台股有；選股兩邊都有，但換市場要重篩
    // 「今日」與「主動ETF」只有台股有
    if (r.value === 'us' && ['day', 'etf'].includes(state.themeView)) state.themeView = 'list';
    state.screenRows = [];
    renderThemes(el);
  }));
  $$('input[name=tvw]', el).forEach((r) => (r.onchange = () => {
    state.themeView = r.value;
    renderThemes(el);
  }));
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

const RENDERERS = { overview: renderOverview, holdings: renderHoldings, funds: renderFunds, themes: renderThemes, journal: renderJournal, history: renderHistory, settings: renderSettings };

// 訪客看得到的分頁。其餘六頁全部跟他的錢有關，一律不給。
const GUEST_TABS = ['themes'];

function render() {
  if (!state.user && !state.guest) return;
  const allowed = (t) => !state.guest || GUEST_TABS.includes(t);
  if (!allowed(state.tab)) state.tab = GUEST_TABS[0];
  $$('.bottom-nav button').forEach((b) => {
    b.hidden = !allowed(b.dataset.tab);
    b.classList.toggle('active', b.dataset.tab === state.tab);
  });
  $$('.tab-panel').forEach((p) => (p.hidden = p.dataset.tab !== state.tab));
  $('#topbar-title').textContent = TITLES[state.tab];
  $('#refresh-btn').hidden = !!state.guest;   // 抓資料的 RPC 沒有開給匿名
  $('#login-btn').hidden = !state.guest;
  RENDERERS[state.tab]($(`.tab-panel[data-tab="${state.tab}"]`));
}

function bindNav() {
  $$('.bottom-nav button').forEach((b) => {
    b.onclick = () => { state.tab = b.dataset.tab; render(); window.scrollTo({ top: 0 }); };
  });
  $('#refresh-btn').onclick = refreshPrices;
  $('#login-btn').onclick = () => {
    state.guest = false;
    $('#app-view').hidden = true;
    $('#auth-view').hidden = false;
  };
}

// ============================================================
// 登入 / 註冊
// ============================================================
// Supabase 的錯誤訊息是英文而且很技術，直接丟給使用者看沒有幫助。
// **「Signups not allowed」要特別處理**：那不是使用者做錯什麼，
// 是專案後台把註冊關掉了，訊息要講清楚不然只會一直重試。
const AUTH_ERRORS = [
  [/invalid login credentials/i, 'Email 或密碼錯誤'],
  [/signups? not allowed|signup is disabled/i,
   '這個站台目前沒有開放註冊。若這是你自己的專案，到 Supabase 後台的 Authentication → Sign In / Providers 打開 Allow new users to sign up。'],
  [/user already registered|already been registered/i, '這個 Email 已經註冊過了，直接登入即可。'],
  [/password should be at least (\d+)/i, '密碼至少要 $1 碼'],
  [/email address .* is invalid|unable to validate email/i, 'Email 格式不正確'],
  [/email rate limit exceeded|over_email_send_rate_limit/i,
   '寄信次數達到上限（內建信箱一小時只有兩封），請稍後再試。'],
  [/for security purposes.*(\d+) seconds/i, '動作太頻繁，請等 $1 秒再試。'],
  [/email not confirmed/i, '這個帳號還沒有完成 Email 確認。'],
  [/network|failed to fetch/i, '連不上伺服器，檢查一下網路。'],
];

function authError(err) {
  const m = String(err?.message || err || '');
  for (const [re, out] of AUTH_ERRORS) {
    const hit = m.match(re);
    if (hit) return out.replace('$1', hit[1] ?? '');
  }
  return m;
}

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
        if (!data.session) {
          // 沒有直接拿到 session 代表後台要求 Email 確認。
          // 但這個專案沒有設定 SMTP，內建信箱一小時只寄得出兩封，
          // 所以與其叫使用者去收信，不如講清楚實際狀況。
          msg.textContent = '註冊成功，但這個站台要求 Email 確認。'
            + '若沒收到信，請站台管理者到 Supabase 後台把 Confirm email 關掉。';
        }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      msg.textContent = authError(err);
    } finally {
      submit.disabled = false;
    }
  };

  $('#auth-forgot').onclick = async () => {
    if (!sb) return;
    const email = form.email.value.trim();
    if (!email) return (msg.textContent = '請先輸入 Email');
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.href.split('#')[0] });
    msg.textContent = error ? authError(error)
      : '已寄出重設密碼信。（提醒：內建信箱一小時只寄得出兩封，沒收到就是被限流了。）';
  };
}

async function setUser(user) {
  const changedUser = (user?.id ?? null) !== (state.user?.id ?? null);
  state.user = user;
  if (user) state.guest = false;
  $('#auth-view').hidden = !!user || state.guest;
  $('#app-view').hidden = !user && !state.guest;
  if (user && changedUser) {
    state.tab = 'overview';
    await refresh();
    // 新帳號一條規則都沒有，「心得」頁的自動檢查會完全沒作用。
    // bootstrap_me() 本身會擋重複，所以這裡放心叫。
    if (!state.rules.length) {
      try {
        const { error } = await sb.rpc('bootstrap_me', {});
        if (!error) await refresh();
      } catch { /* 補不起來也不該擋住使用 */ }
    }
  }
}

// 不登入也能看族群與產業地圖。個人資料一筆都不會載。
async function enterGuest() {
  state.guest = true;
  state.user = null;
  state.tab = GUEST_TABS[0];
  $('#auth-view').hidden = true;
  $('#app-view').hidden = false;
  await refresh();
}

async function init() {
  bindAuth();
  bindNav();
  $('#guest-btn').onclick = () => enterGuest().catch(fail);
  await loadTwStocks();

  if (!sb) {
    $('#config-warning').hidden = false;
    $('#auth-view').hidden = false;
    return;
  }

  const { data: { session } } = await sb.auth.getSession();
  await setUser(session?.user ?? null);
  if (!session?.user) $('#auth-view').hidden = false;

  sb.auth.onAuthStateChange((event, session) => {
    setTimeout(async () => {
      if (event === 'PASSWORD_RECOVERY') {
        const pw = prompt('請輸入新密碼（至少 6 碼）');
        if (pw) {
          const { error } = await sb.auth.updateUser({ password: pw });
          toast(error ? error.message : '密碼已更新');
        }
      }
      if (!session?.user) state.guest = false;
      setUser(session?.user ?? null);
      if (!session?.user) $('#auth-view').hidden = false;
    }, 0);
  });
}

init();
