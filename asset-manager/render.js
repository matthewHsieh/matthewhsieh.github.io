import { $, $$, state } from './core.js';
import { liveMap } from './live.js';
import { renderFunds } from './views/funds.js';
import { renderHistory } from './views/history.js';
import { renderHoldings } from './views/holdings.js';
import { renderJournal } from './views/journal.js';
import { renderOverview } from './views/overview.js';
import { renderSettings } from './views/settings.js';
import { renderThemes } from './views/themes.js';

// ============================================================
// 畫面
// ============================================================
export const TITLES = { overview: '總覽', holdings: '持倉', funds: '資金', themes: '族群', journal: '心得', history: '紀錄', settings: '設定' };

export const RENDERERS = { overview: renderOverview, holdings: renderHoldings, funds: renderFunds, themes: renderThemes, journal: renderJournal, history: renderHistory, settings: renderSettings };

// 訪客看得到的分頁。其餘六頁全部跟他的錢有關，一律不給。
export const GUEST_TABS = ['themes'];

export function render() {
  // 新鮮度會隨時間過期，所以每次畫面重繪都要重算一次
  state._live = liveMap();
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
