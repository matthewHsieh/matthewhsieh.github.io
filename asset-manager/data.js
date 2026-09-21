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
  stockViews:  () => sb.from('stock_views').select('symbol,score,note'),
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
      <div class="list-title" role="heading" aria-level="2">${off ? '目前離線' : '連不上伺服器'}</div>
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
// **權證只剩一個階段。** 原本拆成認購／認售是因為要分兩次抓 5.2 MB 的
// 全市場行情檔；現在前端這條路改抓 MIS、只抓有人持有的那幾檔，
// 一次問完就好，不用分兩趟（見 supabase/warrant_live.sql）。
const REFRESH_STAGES = [
  ['tw', '台股'], ['fut', '指數期貨'], ['opt', '選擇權'],
  ['war', '權證'], ['fx', '匯率'], ['us', '美股'],
  ['val', '估值'], ['rev', '月營收'], ['fin', '季報'], ['est', '分析師預估'],
  ['risk', '報酬/波動'], ['usx', '美股產業'], ['sync', '套用到持倉'],
];

// 資料庫的語句上限是 8 秒（authenticated 角色設的）。來源太慢時 PostgREST
// 回的是 57014 / "canceling statement due to statement timeout"。
// **這跟「壞掉」不是同一件事**：排程那條路沒有 8 秒上限，晚一點會自己補上。
const isTimeout = (e) =>
  e?.code === '57014' || /statement timeout|canceling statement/i.test(String(e?.message || ''));

export async function runStagedRefresh(onStage) {
  const done = [];
  for (const [kind, label] of REFRESH_STAGES) {
    if (onStage) onStage(label, done.length, REFRESH_STAGES.length);
    try {
      const { data, error } = await sb.rpc('refresh_market', { p_kind: kind });
      if (error) throw error;
      done.push({ kind, label, ok: true, rows: data?.rows ?? 0, cached: !!data?.cached });
    } catch (e) {
      console.warn('refresh ' + kind, e);
      done.push({ kind, label, ok: false, msg: e?.message || String(e), slow: isTimeout(e) });
    }
  }
  return done;
}

export function refreshSummary(done) {
  const bad = done.filter((d) => !d.ok);
  if (!bad.length) return null;
  const slow = bad.filter((d) => d.slow), broke = bad.filter((d) => !d.slow);
  const parts = [];
  // 講清楚哪一種。使用者看到「更新失敗」會想重按，但如果原因是來源太慢，
  // 重按只會再失敗一次；真正會把它補起來的是排程。
  if (slow.length) parts.push(slow.map((d) => d.label).join('、') + ' 來源太慢，排程會自動補');
  if (broke.length) parts.push(broke.map((d) => d.label).join('、') + ' 更新失敗');
  return parts.join('；');
}

// 全部都是伺服器回的快取 = 剛剛才有人抓過，資料庫裡就是最新的。
// 要講出來，不然使用者看到一秒就跑完會以為沒動作。
export const allCached = (done) => done.length > 0 && done.every((d) => d.ok && d.cached);

// ------------------------------------------------------------
// 更新進度條
//
//   抓報價要跑 14 個來源、大約 6 秒。原本是每一項換一個 toast，
//   互相蓋掉，使用者既看不出「還剩幾項」，也不知道可不可以先去做別的事。
//   改成底部一條進度條，寫清楚第幾項／共幾項與正在抓什麼，
//   而且**可以收起來**——收起之後更新照樣跑完，只是不再佔著畫面。
//   （Monarch 的 "Syncing 3 of 29…" 就是這個形狀。）
// ------------------------------------------------------------
let syncHideTimer;
// **收起之後就不能再自己跳回來。** 每一個階段都會呼叫 syncShow()，
// 少了這個旗標，使用者按下收起、下一項一抓好它就又冒出來，
// 等於那顆鈕沒有作用（實測 7 秒後就自己回來了）。
let syncDismissed = false;

function syncBar() {
  return { bar: $('#sync-bar'), fill: $('#sync-bar .sync-fill'), text: $('#sync-bar .sync-text') };
}

function syncStart() {
  syncDismissed = false;
}

function syncShow(label, i, total) {
  if (syncDismissed) return;
  const { bar, fill, text } = syncBar();
  if (!bar) return;
  clearTimeout(syncHideTimer);
  bar.classList.remove('failed');
  bar.hidden = false;
  fill.style.width = `${Math.round((i / total) * 100)}%`;
  text.textContent = `更新中 ${i + 1}/${total}・${label}`;
}

function syncFinish(msg, bad) {
  const { bar, fill, text } = syncBar();
  // 被收起來的就不要自己跳回來，使用者已經表示不想看了
  if (!bar || syncDismissed || bar.hidden) return;
  fill.style.width = '100%';
  bar.classList.toggle('failed', !!bad);
  text.textContent = msg;
  clearTimeout(syncHideTimer);
  syncHideTimer = setTimeout(syncHide, bad ? 6000 : 2500);
}

function syncHide(byUser) {
  const { bar, fill } = syncBar();
  if (!bar) return;
  if (byUser) syncDismissed = true;
  clearTimeout(syncHideTimer);
  bar.hidden = true;
  bar.classList.remove('failed');
  fill.style.width = '0';
}

// 收起只是收起，不取消更新。**一定要在這裡綁一次**，
// 因為 #sync-bar 是 index.html 裡的固定元素，不會被 render() 重畫。
export function bindSyncBar() {
  const b = $('#sync-dismiss');
  if (b) b.onclick = () => syncHide(true);
}

// 前端的冷卻。伺服器那邊 refresh_market() 已經有一份全站共用的冷卻，
// 這裡再擋一層純粹是為了**立刻給回應**——
// 連點的時候與其跑 14 輪 RPC 再收到 14 個「cached」，
// 不如馬上說「剛剛才更新過」。真正的保護在伺服器，這裡只是禮貌。
const MANUAL_COOLDOWN_MS = 60_000;
let lastManualRefresh = 0;

// force：設定頁那顆「立即重新抓取報價」用的。那是使用者專程走進設定頁按的，
// 擋他等六十秒只會讓他以為壞了。**來源仍然受保護**——伺服器端的全站冷卻還在，
// 真的太頻繁的話 refresh_market() 會直接回快取。
export async function refreshPrices({ force = false } = {}) {
  const waited = Date.now() - lastManualRefresh;
  if (!force && waited < MANUAL_COOLDOWN_MS) {
    return toast(`剛剛才更新過，${Math.ceil((MANUAL_COOLDOWN_MS - waited) / 1000)} 秒後可以再按`);
  }
  lastManualRefresh = Date.now();

  const btn = $('#refresh-btn');
  btn.classList.add('spin');
  syncStart();
  try {
    const done = await runStagedRefresh(syncShow);
    // risk 階段剛把 risk_stats 重算過，配置頁的日報酬序列快取就過期了。
    // **不清掉的話按 ↻ 完全沒作用**：組合波動、相關係數、位階全是舊的，
    // 而畫面上看不出來。跟上面的 etfBoard 是同一個坑。
    // 放在這裡而不是 loadAll()，是因為存一筆交易也會呼叫 loadAll()，
    // 那時候序列並沒有變，清掉只是白抓一次幾百 KB。
    state.retSeries = null;
    await loadAll();
    render();
    const bad = refreshSummary(done);
    syncFinish(
      bad ? bad + '，其餘已更新'
        : allCached(done) ? '已是最新（剛剛更新過，直接用快取）'
          : `報價已更新（${statusOf('tw')?.as_of ?? ''}）`,
      bad);
  } catch (e) {
    // 整批失敗就把冷卻放掉，不要讓使用者被鎖著不能重試
    lastManualRefresh = 0;
    syncHide();
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
