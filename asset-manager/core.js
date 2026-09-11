import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// ============================================================
// 初始化
// ============================================================
const configured =
  /^https:\/\/.+\.supabase\.co$/.test(SUPABASE_URL) && !SUPABASE_ANON_KEY.startsWith('YOUR-');

export const sb = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

export const $ = (sel, root = document) => root.querySelector(sel);

export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const DEFAULT_SETTINGS = { target_amount: 0, usd_twd: 32 };

export const state = {
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
  marketLive: [], _live: null,        // 盤中報價（證交所 MIS），只在夠新時才蓋過收盤價
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
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? 0 : Number(v));

export const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

export const fmt = (v, d = 0) =>
  isNum(v) ? Number(v).toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–';

export const fmtMax = (v, d = 2) => (isNum(v) ? Number(v).toLocaleString('zh-TW', { maximumFractionDigits: d }) : '–');

export const fmtX = (v) => (isNum(v) ? Number(v).toFixed(2) + 'x' : '–');

export const pct = (v) => (isNum(v) ? (Number(v) * 100).toFixed(1) + '%' : '–');

export const signed = (v, d = 0) => (isNum(v) ? (v > 0 ? '+' : '') + fmt(v, d) : '–');

export const plClass = (v) => (v > 0 ? 'gain' : v < 0 ? 'loss' : '');

export const sum = (arr, f) => arr.reduce((acc, x) => acc + num(f(x)), 0);

export const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

export const norm = (s) => String(s ?? '').trim().toUpperCase();

export const sameSymbol = (a, b) => norm(a) === norm(b);

export const btrimEq = (a, b) => String(a ?? '').trim() === String(b ?? '').trim();

export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// 圖表座標軸用的精簡數字：1,234,567 → 123.5萬
export const fmtCompact = (v) => {
  if (!isNum(v)) return '–';
  const a = Math.abs(v);
  if (a >= 1e8) return (v / 1e8).toFixed(1) + '億';
  if (a >= 1e4) return (v / 1e4).toFixed(a >= 1e6 ? 0 : 1) + '萬';
  return fmt(v);
};

let toastTimer;

export function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

export function fail(err) {
  console.error(err);
  toast('錯誤：' + (err?.message || err), 4000);
}

// 盤中價一定要標出來。使用者看到的數字跟收盤價是兩件事，不標就會看錯。
// CMoney 的公司名是全名（緯穎科技服務、貿聯控股（BizLink…）），
// 晶片上放不下，截短到看得懂就好。
// **只給個股名用。** ETF 名稱不能截——「主動中信台灣卓越」砍成
// 「主動中信台灣」會變成另一檔基金。
export const shortName = (v) => {
  const t = String(v || '').replace(/（.*$/, '').replace(/\(.*$/, '').trim();
  return t.length > 6 ? t.slice(0, 6) : t;
};

export const rocYm = (ym) => {
  const y = Number(String(ym).slice(0, 3)) + 1911;
  return `${y}/${String(ym).slice(3)}`;
};

// 民國年月往前一個月，用來在速覽裡分辨「上月」與「去年同月」
export const rocPrevYm = (ym) => {
  const y = Number(String(ym).slice(0, 3)), m = Number(String(ym).slice(3));
  return m > 1 ? `${y}${String(m - 1).padStart(2, '0')}` : `${y - 1}12`;
};

// 證交所的公告原文裡夾著 <font color='#FF0000'> 這種標籤。esc() 會把它
// 原封不動印在畫面上，看起來像壞掉，所以顯示前先拔乾淨。
export const stripTags = (v) => String(v || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
