import { $, DEFAULT_SETTINGS, esc, fail, num, round2, sb, state, toast, todayISO } from './core.js';
import { ivSince } from './instruments.js';
import { compute } from './portfolio.js';
import { render } from './render.js';

// ============================================================
// 資料存取
// ============================================================
// **要抓什麼、放到 state 的哪個欄位，寫成一張表。**
// 原本 loadMarketOnly 與 loadAll 各自列了一遍同樣的十三個查詢與解構，
// 每加一個資料來源就要改兩處、順序還要對得剛好——一次改錯順序就是整批
// 錯位。表格化之後 key 就是 state 的欄位名，順序不再重要。
//
// 訪客模式只有市場資料那幾張表對匿名開放（見 supabase/public_read.sql），
// 個人資料表連查都不用查，查了也只會拿到空陣列。
const MARKET_QUERIES = {
  themeTrend:     () => sb.rpc('theme_trend', { p_months: 1 }),
  themeMembers:   () => sb.rpc('theme_members', {}),
  themeInfo:      () => sb.from('theme_info').select('*'),
  themeVal:       () => sb.rpc('theme_valuation', {}),
  // **不要整批 select risk_stats/us_stats**：它們現在各有兩千列，
  // PostgREST 預設只回前 1,000 列，會安靜地截斷，
  // 症狀是有些股票的報酬/波動莫名變成「–」。app_risk() 只回真的用得到的那幾百檔。
  _risk:          () => sb.rpc('app_risk', {}),
  usThemeTrend:   () => sb.rpc('us_theme_trend', {}),
  usThemeMembers: () => sb.rpc('us_theme_members', {}),
  themeMeta:      () => sb.from('theme_meta').select('*'),
  themeLinks:     () => sb.from('theme_links').select('*'),
  themeDay:       () => sb.rpc('theme_day', {}),
  alerts:         () => sb.rpc('active_alerts', { p_days: 10 }),
  themeEtf:       () => sb.rpc('theme_etf', {}),
  marketLive:     () => sb.from('market_live').select('*'),
};

const personalQueries = (uid) => ({
  _settings:   () => sb.from('settings').select('*').eq('user_id', uid).maybeSingle(),
  stocks:      () => sb.from('stocks').select('*').order('created_at'),
  futures:     () => sb.from('futures').select('*').order('created_at'),
  us:          () => sb.from('us_stocks').select('*').order('created_at'),
  balances:    () => sb.from('balances').select('*').order('kind').order('created_at'),
  snapshots:   () => sb.from('snapshots').select('*').order('snap_date', { ascending: false }).limit(730),
  trades:      () => sb.from('trades').select('*').order('trade_date', { ascending: false }).order('created_at', { ascending: false }).limit(500),
  options:     () => sb.from('options').select('*').order('expiry').order('strike'),
  warrants:    () => sb.from('warrants').select('*').order('created_at'),
  ivHistory:   () => sb.from('warrant_iv_history').select('code,as_of,iv').gte('as_of', ivSince()).order('as_of'),
  _fwds:       () => sb.from('market_prices').select('symbol,price,as_of').eq('market', 'opt').like('symbol', 'FWD|%'),
  valuation:   () => sb.rpc('my_valuation', {}),
  rules:       () => sb.from('rules').select('*').eq('active', true).order('sort'),
  journalDays: () => sb.rpc('journal_days', { p_limit: 120 }),
  priceStatus: () => sb.from('price_status').select('market,as_of,updated_at,symbols'),
});

// 平行送出、回 { key: data }。42P01 是「表還不存在」，新版程式碰到舊資料庫時
// 不該因此整頁掛掉，其餘錯誤照常丟出去。
async function runQueries(queries) {
  const keys = Object.keys(queries);
  const results = await Promise.all(keys.map((k) => queries[k]()));
  for (const r of results) if (r.error && r.error.code !== '42P01') throw r.error;
  return Object.fromEntries(keys.map((k, i) => [k, results[i].data]));
}

// 沒有底線的 key 直接對應 state 欄位；底線開頭的要再加工，寫在下面
function assignState(d) {
  for (const [k, v] of Object.entries(d)) {
    if (!k.startsWith('_')) state[k] = v ?? [];
  }
  if ('_risk' in d) {
    const risk = d._risk ?? [];
    state.riskStats = risk.filter((r) => r.market === 'tw');
    state.usStats = risk.filter((r) => r.market === 'us');
  }
}

export async function loadAll() {
  // 主動ETF 那一包是進到那一頁才抓的（etf_board 一次回四十幾 KB），
  // 但重新整理之後一定要讓它失效——否則按了 ↻ 那一頁還是舊資料，
  // 要整頁重載才會更新。
  state.etfBoard = null;

  if (state.guest) {
    assignState(await runQueries(MARKET_QUERIES));
    state.settings = { ...DEFAULT_SETTINGS };
    return;
  }

  const d = await runQueries({ ...MARKET_QUERIES, ...personalQueries(state.user.id) });
  assignState(d);
  state.settings = d._settings ? { ...DEFAULT_SETTINGS, ...d._settings } : { ...DEFAULT_SETTINGS };
  state.optExpiries = (d._fwds ?? [])
    .map((r) => ({ expiry: String(r.symbol).split('|')[1], forward: num(r.price), as_of: r.as_of }))
    .sort((a, b) => a.expiry.localeCompare(b.expiry));
  state.priceInfo = [...state.priceStatus].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0] ?? null;
}

// 載入失敗時畫這一張，**不要去畫正常的分頁**。
//   state 的預設值全是空陣列，硬畫下去 compute() 會算出「淨資產 0」，
//   而那是一個看起來完全正常、實際上完全錯誤的數字。
//   離線時寧可什麼都不顯示，也不能顯示假的錢。
function renderLoadFailure(err) {
  const el = $(`.tab-panel[data-tab="${state.tab}"]`);
  if (!el) return;
  // 已經有畫面就留著——那是上一次成功載入的真實資料，比清空有用
  if (el.innerHTML.trim()) return toast('更新失敗，畫面上是上次載入的資料', 4000);

  const off = typeof navigator !== 'undefined' && navigator.onLine === false;
  el.innerHTML = `
    <div class="card">
      <div class="list-title">${off ? '目前離線' : '連不上伺服器'}</div>
      <p class="sub">${off
        ? '沒有網路，讀不到你的部位與行情。'
        : '連得上網路，但伺服器沒有回應。'}
        <b>你的資料沒有任何變動</b>，連上線之後按下面重新載入就會回來。</p>
      <p class="sub muted">這裡刻意不顯示任何數字。抓不到資料時把欄位填 0，
        看起來會像「淨資產歸零」，那比空白危險得多。</p>
      <button type="button" class="primary block" id="retry-load">重新載入</button>
      <p class="hint">${esc(String(err?.message || err || '').slice(0, 160))}</p>
    </div>`;
  const b = $('#retry-load', el);
  if (b) b.onclick = () => { b.disabled = true; b.textContent = '載入中…'; refresh(); };
}

export async function refresh(msg) {
  try {
    await loadAll();
    render();
    if (msg) toast(msg);
  } catch (e) {
    console.error(e);
    renderLoadFailure(e);
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
      done.push({ kind, label, ok: true, rows: data?.rows ?? 0, cached: !!data?.cached });
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

// 全部都是伺服器回的快取 = 剛剛才有人抓過，資料庫裡就是最新的。
// 要講出來，不然使用者看到一秒就跑完會以為沒動作。
export const allCached = (done) => done.length > 0 && done.every((d) => d.ok && d.cached);

// 前端的冷卻。伺服器那邊 refresh_market() 已經有一份全站共用的冷卻，
// 這裡再擋一層純粹是為了**立刻給回應**——
// 連點的時候與其跑 14 輪 RPC 再收到 14 個「cached」，
// 不如馬上說「剛剛才更新過」。真正的保護在伺服器，這裡只是禮貌。
const MANUAL_COOLDOWN_MS = 60_000;
let lastManualRefresh = 0;

export async function refreshPrices() {
  const waited = Date.now() - lastManualRefresh;
  if (waited < MANUAL_COOLDOWN_MS) {
    return toast(`剛剛才更新過，${Math.ceil((MANUAL_COOLDOWN_MS - waited) / 1000)} 秒後可以再按`);
  }
  lastManualRefresh = Date.now();

  const btn = $('#refresh-btn');
  btn.classList.add('spin');
  try {
    const done = await runStagedRefresh((label) => toast('更新中：' + label, 8000));
    await loadAll();
    render();
    const bad = refreshSummary(done);
    toast(
      bad ? bad + '，其餘已更新'
        : allCached(done) ? '已是最新（剛剛更新過，直接用快取）'
          : `報價已更新（${statusOf('tw')?.as_of ?? ''}）`,
      bad ? 5000 : 2500);
  } catch (e) {
    // 整批失敗就把冷卻放掉，不要讓使用者被鎖著不能重試
    lastManualRefresh = 0;
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
