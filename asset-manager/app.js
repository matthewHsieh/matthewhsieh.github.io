import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { donutChart, lineChart } from './charts.js';

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
  snapshots: [], // 依日期由新到舊
  trades: [],    // 依日期、建立時間由新到舊
  priceInfo: null,
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
//   槓桿② 曝險槓桿 = 總曝險 / 淨資產
//   總曝險 = 台股市值 + 複委託市值 + 期貨名目（指數期貨 ＋ 個股期貨，多空都算）
//   期貨名目 = 口數 × 價格 × size
//     指數期貨 size = 每點價值；個股期貨 size = 等同股數（大 2000 / 小 100）
// ============================================================
function futNotional(f) {
  return num(f.lots) * num(f.price) * num(f.size);
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

  const toTwd = (b) => num(b.amount) * (b.currency === 'USD' ? rate : 1);
  const cash = sum(balances.filter((b) => b.kind === 'cash'), toTwd);
  const futEquity = sum(balances.filter((b) => b.kind === 'futures_equity'), toTwd);
  const liabilities = sum(balances.filter((b) => b.kind === 'liability'), toTwd);

  const totalAssets = stockValue + usValue + futEquity + cash;
  const netAssets = totalAssets - liabilities;
  const exposure = stockValue + usValue + futGross;

  const leverageAsset = netAssets > 0 ? totalAssets / netAssets : NaN;
  const leverageExposure = netAssets > 0 ? exposure / netAssets : NaN;

  const target = num(settings.target_amount);
  const progress = target > 0 ? netAssets / target : NaN;

  return {
    rate, stockValue, stockCost, usValueUsd, usCostUsd, usValue,
    futEquity, futLong, futShort, futGross, futNet, futIndex, futStock,
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
  us:        { label: '複委託',   market: 'us' },
};
const tradeKindOf = (t) =>
  t.market === 'futures' ? (t.fut_kind === 'stock' ? 'fut_stock' : 'fut_index') : t.market;

function findPosition(t) {
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
  if (market === 'futures') return `${fmtMax(q, 2)} 口`;
  if (market === 'tw') return q !== 0 && q % 1000 === 0 ? `${fmt(q / 1000)} 張` : `${fmt(q)} 股`;
  return `${fmtMax(q, 4)} 股`;
}
const fmtNet = (net) => (net === 0 ? '無部位' : `${net > 0 ? '多' : '空'} ${fmtMax(Math.abs(net), 2)} 口`);

// opts.reverse：刪除交易時反向調整，不動均價與現價
function projectTrade(t, opts = {}) {
  const qty = num(t.quantity);
  if (!(qty > 0)) return { error: '數量必須大於 0' };
  if (!String(t.symbol ?? '').trim()) return { error: '請輸入代號或商品' };
  const dir = t.side === 'buy' ? 1 : -1;
  const pos = findPosition(t);

  if (t.market === 'futures') {
    const prevNet = pos ? (pos.side === 'short' ? -num(pos.lots) : num(pos.lots)) : 0;
    const net = prevNet + dir * qty;
    const base = pos || newPositionRow(t);
    const after = net === 0
      ? null
      : { ...base, side: net > 0 ? 'long' : 'short', lots: Math.abs(net),
          price: opts.reverse ? num(base.price) : num(t.price) };
    return { table: 'futures', pos, prevShares: prevNet, prevCost: null, after, prevNet, net };
  }

  const isUs = t.market === 'us';
  const priceKey = isUs ? 'price_usd' : 'price';
  const costKey = isUs ? 'cost_usd' : 'cost';
  const prevShares = pos ? num(pos.shares) : 0;
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
    : { ...base, shares: newShares, [priceKey]: opts.reverse ? num(base[priceKey]) : num(t.price), [costKey]: newCost };
  if (after && !after.name && t.name) after.name = t.name;
  return { table: isUs ? 'us_stocks' : 'stocks', pos, prevShares, prevCost, after, newShares, newCost: gone ? null : newCost };
}

function restoreProjection(t) {
  const pos = findPosition(t);
  const prev = num(t.prev_shares);
  if (t.market === 'futures') {
    const after = prev === 0 ? null : { ...(pos || newPositionRow(t)), side: prev > 0 ? 'long' : 'short', lots: Math.abs(prev) };
    return { table: 'futures', pos, after };
  }
  const isUs = t.market === 'us';
  const costKey = isUs ? 'cost_usd' : 'cost';
  const after = prev <= 1e-9
    ? null
    : { ...(pos || newPositionRow(t)), shares: prev, [costKey]: isNum(t.prev_cost) ? num(t.prev_cost) : null };
  return { table: isUs ? 'us_stocks' : 'stocks', pos, after };
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
      side: v.side, trade_date: v.trade_date, symbol: v.symbol, name: v.name,
      quantity: v.quantity, price: v.price, note: v.note,
      prev_shares: proj.prevShares, prev_cost: proj.prevCost,
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
  const latest = state.trades.find(
    (x) => x.market === t.market && sameSymbol(x.symbol, t.symbol) &&
           (t.market !== 'futures' || (x.fut_kind === t.fut_kind && num(x.fut_size) === num(t.fut_size))));
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
    sb.from('market_prices').select('market,as_of,updated_at').order('updated_at', { ascending: false }).limit(1),
  ]);
  for (const r of results) if (r.error && r.error.code !== '42P01') throw r.error;
  const [st, stocks, futures, us, balances, snaps, trades, prices] = results;
  state.settings = st.data ? { ...DEFAULT_SETTINGS, ...st.data } : { ...DEFAULT_SETTINGS };
  state.stocks = stocks.data ?? [];
  state.futures = futures.data ?? [];
  state.us = us.data ?? [];
  state.balances = balances.data ?? [];
  state.snapshots = snaps.data ?? [];
  state.trades = trades.data ?? [];
  state.priceInfo = prices.data?.[0] ?? null;
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
async function refreshPrices() {
  const btn = $('#refresh-btn');
  btn.classList.add('spin');
  try {
    const { data, error } = await sb.rpc('refresh_prices', { p_force: false });
    if (error) throw error;
    await loadAll();
    render();
    toast(data?.fetched ? `報價已更新（${data.as_of ?? ''}）` : '報價是最新的');
  } catch (e) {
    fail(e);
  } finally {
    btn.classList.remove('spin');
  }
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
      if (out.symbol) out.symbol = norm(out.symbol);
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
    <label>價格（每日自動更新）<input name="price" type="number" step="any" inputmode="decimal" required value="${esc(num(v.price))}"></label>
    <div class="preview" data-preview></div>`;

  const read = (fd, form) => {
    const kind = fd.get('kind');
    const symbol = norm(fd.get('symbol'));
    const size = kind === 'stock' ? num(fd.get('size')) : (indexProduct(symbol)?.size ?? num(fd.get('mult')) ?? 200);
    return {
      kind, symbol, size,
      contract: futDisplayName(kind, symbol, size),
      side: fd.get('side') || 'long',
      lots: num(fd.get('lots')),
      price: num(fd.get('price')),
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
        preview.textContent = val.lots > 0 && val.price > 0
          ? `名目 / 曝險 ＝ ${fmtMax(val.lots, 2)} 口 × ${fmtMax(val.price, 2)} × ${fmt(val.size)} ＝ ${fmt(val.lots * val.price * val.size)} 元`
          : '填好口數與價格後會顯示名目金額';
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
  const symbol = norm(fd.get('symbol'));
  let name = String(fd.get('name') || '').trim() || null;
  if ((tk === 'tw' || tk === 'fut_stock') && !name && TW_STOCKS[symbol]) name = TW_STOCKS[symbol];
  if (tk === 'fut_index' && !name) name = indexProduct(symbol)?.name || null;
  return {
    kindKey: tk,
    market: meta.market,
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
    <label>日期<input name="trade_date" type="date" value="${todayISO()}" required></label>
    <label><span data-l="symbol">代號</span><input name="symbol" type="text" required autocomplete="off" autocapitalize="characters" value="${esc(defaults.symbol || '')}"></label>
    <div class="resolved muted" data-resolved></div>
    <input type="hidden" name="name">
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
        const label = `${v.symbol}${v.name ? ' ' + v.name : ''}`;
        if (v.market === 'futures') {
          const notional = v.quantity * v.price * num(v.fut_size);
          preview.textContent =
            `${label}：${fmtNet(p.prevNet)} → ${fmtNet(p.net)}　本筆名目 ${fmt(notional)}` +
            (p.after ? '' : '（部位歸零，將移除）');
        } else {
          preview.textContent =
            `${label}：持有 ${fmtQty(v.market, p.prevShares)} → ${fmtQty(v.market, p.newShares)}，` +
            `均價 ${fmtMax(p.prevCost, 2)} → ${fmtMax(p.newCost, 2)}` +
            (p.after ? '' : '（全部出清，部位將移除）');
        }
      };

      const setKind = () => {
        const k = form.kind.value;
        const isStockFut = k === 'fut_stock', isIdxFut = k === 'fut_index';
        rowFutSize.hidden = !isStockFut;
        $('[data-l=symbol]', form).textContent =
          isIdxFut ? '商品' : isStockFut ? '標的股票代號' : '代號';
        $('[data-l=price]', form).textContent =
          k === 'us' ? '價格 (USD)' : isIdxFut ? '成交價（指數）' : '價格 (TWD)';
        form.symbol.placeholder =
          k === 'tw' || isStockFut ? '2330 或 台積' : isIdxFut ? 'TX / 小台 / 微台' : 'VOO';
        form.unit.innerHTML = k === 'tw'
          ? '<option value="lot">張</option><option value="share">股</option>'
          : k === 'us' ? '<option value="share">股</option>' : '<option value="share">口</option>';
        form.unit.disabled = k !== 'tw';
        form.name.value = '';
        resolved.textContent = k === 'us' ? '美股不會自動帶名稱' : '輸入代號或名稱會自動帶出';
        updatePreview();
      };

      attachLookup(form.symbol,
        () => (form.kind.value === 'fut_index' ? 'index' : form.kind.value === 'us' ? 'none' : 'tw'),
        (m, picked) => {
          form.name.value = m.name || '';
          resolved.textContent = `${m.code}　${m.name || ''}`;
          updatePreview();
          if (picked) form.quantity.focus();
        });
      form.symbol.addEventListener('input', () => {
        const k = form.kind.value;
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
const TITLES = { overview: '總覽', holdings: '持倉', funds: '資金', history: '紀錄', settings: '設定' };

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
    else editItem(b.dataset.add, null, d);
  }));
  $$('[data-edit]', el).forEach((b) => (b.onclick = () =>
    (b.dataset.edit === 'future' ? editFutures(b.dataset.id) : editItem(b.dataset.edit, b.dataset.id))));
  $$('[data-trade]', el).forEach((b) => (b.onclick = () => logTrade()));
}

function priceStamp() {
  const p = state.priceInfo;
  if (!p) return '報價尚未更新，按右上角 ↻ 抓一次';
  const d = new Date(p.updated_at);
  return `報價更新於 ${d.toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
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
      ${stat('槓桿① 資產槓桿', fmtX(c.leverageAsset), '總資產 ÷ 淨資產')}
      ${stat('槓桿② 曝險槓桿', fmtX(c.leverageExposure), '總曝險 ÷ 淨資產')}
    </div>
    <div class="card">
      <div class="row-between"><span class="list-title">目標金額</span><span>${c.target > 0 ? fmt(c.target) : '<span class="muted">未設定</span>'}</span></div>
      <div class="bar"><div class="bar-fill" style="width:${progressWidth}%"></div></div>
      <div class="row-between sub">
        <span>${pct(c.progress)}</span>
        <span class="muted">${c.target > 0 ? (c.netAssets >= c.target ? '已達標 🎉' : '還差 ' + fmt(c.target - c.netAssets)) : '到「設定」輸入目標'}</span>
      </div>
    </div>
    <div class="card" id="donut-card"><div class="list-title">資產組成</div></div>
    <div class="card list">
      <div class="list-title">曝險</div>
      ${line('台股市值', c.stockValue)}
      ${line('複委託市值', c.usValue)}
      ${line('指數期貨名目', c.futIndex)}
      ${line('個股期貨名目', c.futStock)}
      ${line('期貨名目・多單', c.futLong)}
      ${line('期貨名目・空單', c.futShort)}
      ${line('總曝險', c.exposure)}
    </div>
    ${tradeButton()}
    <button type="button" class="block" id="snap-btn">📌 記錄今日快照</button>
    <p class="hint">${priceStamp()}。收盤價、結算價與匯率每天自動更新，不用手動改。匯率 ${fmt(c.rate, 3)}。</p>`;

  $('#donut-card', el).appendChild(donutChart({
    slices: [
      { label: '台股', value: c.stockValue, color: 'var(--series-1)' },
      { label: '複委託', value: c.usValue, color: 'var(--series-2)' },
      { label: '期貨權益', value: c.futEquity, color: 'var(--series-3)' },
      { label: '現金', value: c.cash, color: 'var(--series-4)' },
    ],
    total: c.totalAssets,
    centerLabel: '總資產',
    centerValue: fmtCompact(c.totalAssets),
    format: fmt,
  }));
  $('#snap-btn', el).onclick = saveSnapshot;
  bindListActions(el);
}

function renderHoldings(el) {
  const c = compute();
  const stockRows = state.stocks.map((s) => {
    const v = num(s.shares) * num(s.price);
    const pl = isNum(s.cost) ? v - num(s.shares) * num(s.cost) : null;
    return itemRow('stock', s.id,
      `${esc(s.symbol)} ${esc(s.name || '')}`,
      `${fmtQty('tw', s.shares)} × ${fmtMax(s.price, 2)}${isNum(s.cost) ? `　均價 ${fmtMax(s.cost, 2)}` : ''}`,
      fmt(v),
      pl === null ? '' : `<span class="${plClass(pl)}">${signed(pl)}</span>`);
  });
  const futRows = state.futures.map((f) => {
    const isStock = f.kind === 'stock';
    return itemRow('future', f.id,
      `${esc(f.contract || futDisplayName(f.kind, f.symbol, f.size))}<span class="badge">${f.side === 'short' ? '空' : '多'}</span>`,
      `${fmtMax(f.lots, 2)} 口 × ${fmtMax(f.price, 2)} × ${fmt(f.size)}${isStock ? ' 股' : ' 元/點'}`,
      `名目 ${fmt(futNotional(f))}`,
      isStock ? `個股期・${stockFutLabel(f.size)}型` : '指數期');
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
  const equityRows = state.balances.filter((b) => b.kind === 'futures_equity').map((b) =>
    itemRow('balance', b.id, esc(b.name), esc(b.note || ''),
      `${fmt(b.amount, b.currency === 'USD' ? 2 : 0)} ${b.currency}`, '計入總資產'));
  const stockPl = c.stockValue - c.stockCost;
  const usPl = c.usValueUsd - c.usCostUsd;

  el.innerHTML =
    tradeButton() +
    section('台股', 'stock', stockRows, `市值 ${fmt(c.stockValue)}　<span class="${plClass(stockPl)}">${signed(stockPl)}</span>`) +
    section('期貨部位（指數 + 個股）', 'future', futRows,
      `名目合計 ${fmt(c.futGross)}　<span class="muted">多 ${fmt(c.futLong)} / 空 ${fmt(c.futShort)}</span>`) +
    section('期貨帳戶權益數', 'balance', equityRows, `合計 ${fmt(c.futEquity)}`, { kind: 'futures_equity', name: '期貨帳戶' }) +
    section('複委託 (USD)', 'us', usRows,
      `US$ ${fmt(c.usValueUsd, 2)} <span class="${plClass(usPl)}">${signed(usPl, 2)}</span>　≈ ${fmt(c.usValue)}`) +
    `<p class="hint">「記一筆交易」會自動加減部位、重算均價；部位沒變動就不會動資料，賣光才移除。
      期貨的<b>權益數</b>計入總資產，<b>名目金額</b>計入曝險。個股期貨以標的股價計價：大型 = 2 張（2,000 股）、小型 = 100 股。</p>`;
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
  const asc = [...snaps].reverse(); // 折線圖由舊到新

  el.innerHTML = `
    <div class="card" id="chart-assets"><div class="list-title">資產走勢</div></div>
    <div class="card" id="chart-lev"><div class="list-title">槓桿走勢</div></div>
    ${tradeButton()}
    <div class="card list">
      <div class="list-title">歷史交易紀錄</div>
      ${trades.length
        ? trades.map((t) => `<button type="button" class="item" data-del-trade="${t.id}">
            <span class="item-main">
              <span class="item-title"><span class="trade-side ${t.side}">${t.side === 'buy' ? '買' : '賣'}</span>${esc(t.symbol)} ${esc(t.name || '')}</span>
              <span class="item-sub">${esc(t.trade_date)}・${TRADE_KINDS[tradeKindOf(t)]?.label || MARKET_LABEL[t.market] || ''}${
                t.market === 'futures' && t.fut_kind === 'stock' ? `（${stockFutLabel(t.fut_size)}型）` : ''}${t.note ? '・' + esc(t.note) : ''}</span>
            </span>
            <span class="item-right"><span>${fmtQty(t.market, t.quantity)}</span><span class="item-sub">@ ${fmtMax(t.price, 2)}</span></span>
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
            <thead><tr><th>日期</th><th>淨資產</th><th>變化</th><th>總資產</th><th>負債</th><th>槓桿①</th><th>槓桿②</th><th>目標%</th><th></th></tr></thead>
            <tbody>${snaps.map((r, i) => {
              const prev = snaps[i + 1];
              const d = prev ? num(r.net_assets) - num(prev.net_assets) : null;
              const prog = num(r.target_amount) > 0 ? num(r.net_assets) / num(r.target_amount) : null;
              return `<tr>
                <td>${esc(r.snap_date)}${r.note === 'auto' ? '<span class="badge">自動</span>' : ''}</td>
                <td>${fmt(r.net_assets)}</td><td class="${plClass(d)}">${signed(d)}</td>
                <td>${fmt(r.total_assets)}</td><td>${fmt(r.liabilities)}</td>
                <td>${fmtX(r.leverage_asset)}</td><td>${fmtX(r.leverage_exposure)}</td>
                <td>${pct(prog)}</td>
                <td><button type="button" class="link danger" data-del-snap="${r.id}">刪除</button></td>
              </tr>`;
            }).join('')}</tbody>
          </table></div>`
        : '<p class="muted">尚無快照。系統每個交易日會自動存一筆，也可以按「記錄今日」手動存。</p>'}
      <p class="hint">每天一筆，表格可左右滑動。</p>
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

  $('#snap-btn2', el).onclick = saveSnapshot;
  $$('[data-del-snap]', el).forEach((b) => (b.onclick = () => deleteSnapshot(b.dataset.delSnap)));
  $$('[data-del-trade]', el).forEach((b) => (b.onclick = () => deleteTrade(b.dataset.delTrade)));
  bindListActions(el);
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
    <div class="card">
      <div class="list-title">行情更新</div>
      <p class="muted sub">${priceStamp()}</p>
      <button type="button" class="block" id="force-price">立即重新抓取報價</button>
      <p class="hint">每個交易日 16:00（台股 / 期貨 / 匯率）與隔日 06:00（美股）自動更新，並自動存一筆快照。手機沒開也會跑。</p>
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
        <dt>槓桿②（曝險槓桿）</dt><dd>（台股 ＋ 複委託 ＋ 期貨名目）÷ 淨資產，指數期貨與個股期貨都算</dd>
        <dt>指數期貨名目</dt><dd>口數 × 結算價 × 每點價值（大台 200、小台 50、微台 10）</dd>
        <dt>個股期貨名目</dt><dd>口數 × 標的股價 × 等同股數（大型 2,000 股 ＝ 2 張、小型 100 股）</dd>
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
  $('#force-price', el).onclick = async () => {
    const b = $('#force-price', el);
    b.disabled = true; b.textContent = '抓取中…';
    try {
      const { data, error } = await sb.rpc('refresh_prices', { p_force: true });
      if (error) throw error;
      await loadAll(); render();
      toast(`報價已更新（${data?.as_of ?? ''}）`);
    } catch (e) { fail(e); b.disabled = false; b.textContent = '立即重新抓取報價'; }
  };
  $('#logout-btn', el).onclick = async () => {
    const { error } = await sb.auth.signOut();
    if (error) fail(error);
  };
}

const RENDERERS = { overview: renderOverview, holdings: renderHoldings, funds: renderFunds, history: renderHistory, settings: renderSettings };

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
