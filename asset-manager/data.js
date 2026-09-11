import { $, DEFAULT_SETTINGS, fail, num, round2, sb, state, toast, todayISO } from './core.js';
import { ivSince } from './instruments.js';
import { compute } from './portfolio.js';
import { render } from './render.js';

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
    sb.rpc('theme_etf', {}),
    sb.from('market_live').select('*'),
  ]);
  for (const r of results) if (r.error && r.error.code !== '42P01') throw r.error;
  const [trend, members, tinfo, tval, arisk, utrend, umem, tmeta, tlinks, tday, alerts,
         tetf, mlive] = results;
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
  state.themeEtf = tetf.data ?? [];
  state.marketLive = mlive.data ?? [];
}

export async function loadAll() {
  // 主動ETF 那一包是進到那一頁才抓的（etf_board 一次回四十幾 KB），
  // 但重新整理之後一定要讓它失效——否則按了 ↻ 那一頁還是舊資料，
  // 要整頁重載才會更新。
  state.etfBoard = null;
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
    sb.rpc('theme_etf', {}),
    sb.from('market_live').select('*'),
    sb.from('rules').select('*').eq('active', true).order('sort'),
    sb.rpc('journal_days', { p_limit: 120 }),
    sb.from('price_status').select('market,as_of,updated_at,symbols'),
  ]);
  for (const r of results) if (r.error && r.error.code !== '42P01') throw r.error;
  const [st, stocks, futures, us, balances, snaps, trades, opts, wars, ivh, fwds, trend, members, tinfo, val, tval, arisk, utrend, umem, tmeta, tlinks, tday, alerts, tetf, mlive, rules, jdays, prices] = results;
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
  state.themeEtf = tetf.data ?? [];
  state.marketLive = mlive.data ?? [];
  state.rules = rules.data ?? [];
  state.journalDays = jdays.data ?? [];
  state.optExpiries = (fwds.data ?? [])
    .map((r) => ({ expiry: String(r.symbol).split('|')[1], forward: num(r.price), as_of: r.as_of }))
    .sort((a, b) => a.expiry.localeCompare(b.expiry));
  state.priceStatus = prices.data ?? [];
  state.priceInfo = [...state.priceStatus].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0] ?? null;
}

export async function refresh(msg) {
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

export async function runStagedRefresh(onStage) {
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

export function refreshSummary(done) {
  const bad = done.filter((d) => !d.ok);
  if (!bad.length) return null;
  return bad.map((d) => d.label).join('、') + ' 更新失敗';
}

export async function refreshPrices() {
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
export async function applyCachedPrices() {
  try { await sb.rpc('sync_my_positions'); } catch (e) { console.warn('sync_my_positions 失敗', e); }
}

export async function saveSnapshot() {
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

export async function deleteSnapshot(id) {
  if (!confirm('刪除這筆快照？')) return;
  const { error } = await sb.from('snapshots').delete().eq('id', id);
  if (error) return fail(error);
  await refresh('已刪除');
}

export const MARKET_NAME = { tw: '台股', fut: '指數期貨', us: '美股', fx: '匯率' };

export const statusOf = (m) => state.priceStatus.find((p) => p.market === m);

// 各市場最新的資料日期；台股是主要基準
export const newestAsOf = () => state.priceStatus.map((p) => p.as_of).filter(Boolean).sort().pop() || null;
