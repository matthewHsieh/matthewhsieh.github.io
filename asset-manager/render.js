import { $, $$, state } from './core.js';
import { liveMap } from './live.js';
import { renderFunds } from './views/funds.js';
import { renderHistory } from './views/history.js';
import { renderHoldings } from './views/holdings.js';
import { renderAlloc } from './views/riskcard.js';
import { renderJournal } from './views/journal.js';
import { renderOverview } from './views/overview.js';
import { renderSettings } from './views/settings.js';
import { renderThemes } from './views/themes.js';

// ============================================================
// 畫面
// ============================================================
export const TITLES = { overview: '總覽', holdings: '持倉', alloc: '推薦配置', funds: '資金', themes: '族群', journal: '心得', history: '紀錄', settings: '設定' };

export const RENDERERS = { overview: renderOverview, holdings: renderHoldings, alloc: renderAlloc, funds: renderFunds, themes: renderThemes, journal: renderJournal, history: renderHistory, settings: renderSettings };

// 訪客看得到的分頁。
//   族群與配置都只用公開市場資料的衍生值（報酬/波動、相關係數、位階），
//   不含任何個人部位，所以開放。**其餘六頁全部跟他的錢有關，一律不給。**
//   配置頁在訪客模式下會自己切換：沒有部位可以分析，改成讓他填一個試算金額，
//   而「主觀看法」要存資料庫，所以鎖住。
export const GUEST_TABS = ['themes', 'alloc'];

// 只更新外框（導覽、標題、哪一個分頁可見）。很便宜，一定同步做完。
function renderChrome() {
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
  return $(`.tab-panel[data-tab="${state.tab}"]`);
}

export function render() {
  // 新鮮度會隨時間過期，所以每次畫面重繪都要重算一次
  state._live = liveMap();
  if (!state.user && !state.guest) return;
  RENDERERS[state.tab](renderChrome());
}

// 骨架：**高度要跟真正的內容差不多**，否則資料進來時整頁會跳一下。
// 三張卡片的比例大致對得上總覽與持倉的開頭。
const SKELETON = `
  <div class="card"><div class="skel skel-line w60"></div><div class="skel skel-big"></div></div>
  <div class="card"><div class="skel skel-line w40"></div><div class="skel skel-row"></div><div class="skel skel-row"></div><div class="skel skel-row w80"></div></div>
  <div class="card"><div class="skel skel-line w40"></div><div class="skel skel-row"></div><div class="skel skel-row w80"></div></div>`;

// ------------------------------------------------------------
// 切換分頁
//
//   **重畫分頁是同步的，而且很慢。** 實測在中階手機（CPU 降速四倍）
//   持倉要 850ms、族群 816ms，這段期間瀏覽器畫到的幀數是 0——
//   也就是說使用者按下去之後，整整快一秒鐘畫面完全沒有任何變化，
//   連按鈕的 :active 都來不及畫出來。看起來就像沒按到。
//
//   修法不是把 render 變快（那是另一件事），而是**先讓瀏覽器畫一幀**：
//   同步把導覽的選取狀態、標題、可見分頁換掉，讓出一幀讓它畫出來，
//   下一幀才做重的那一段。使用者立刻看到「我按的那一頁亮了」。
//
//   第一次進到某一頁時該頁是空的，讓一幀只會看到空白，所以補一張骨架。
//   已經有內容的頁面就**不要蓋骨架**——那是上次載入的真資料，
//   拿閃爍的灰條去換掉它是退步。
// ------------------------------------------------------------
export function switchTab(tab) {
  if (!state.user && !state.guest) return;
  state.tab = tab;
  state._live = liveMap();
  const el = renderChrome();
  const wasEmpty = !el.innerHTML.trim();
  if (wasEmpty) el.innerHTML = SKELETON;

  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (state.tab !== tab) return;   // 這一幀之間又被切走了就別畫了
    RENDERERS[state.tab](el);
  }));
}
