// ============================================================
// 入口。原本是 5,000 行的單一檔案，2026-09 拆成模組，切法照「誰依賴誰」：
//
//   core.js         state、supabase client、$ / $$、格式化與小工具。**葉節點，不 import 任何自家模組。**
//   symbols.js      台股代號表、名稱→代號解析、輸入框的建議清單、指數期貨規格
//   instruments.js  選擇權／權證／個股期貨的算式（delta、曝險、損益）
//   live.js         盤中報價疊在收盤價上（只蓋 price，股數與成本不動）
//   trades.js       當沖配對、交易成本、已實現損益、記一筆交易時的部位推算
//   portfolio.js    compute()：總資產、曝險、槓桿；報酬÷波動的比較
//   rules.js        紀律規則的檢查
//   alerts.js       處置股與注意股
//   data.js         loadAll / refresh：所有跟 Supabase 的讀取與更新流程
//   render.js       分頁切換與 RENDERERS 表；views/* 透過它重繪
//   dialog.js       通用對話框與表單產生器
//   forms.js        所有新增／編輯表單、期貨轉倉
//   widgets.js      卡片、列、按鈕這類共用的 HTML 片段
//   views/*.js      七個分頁各一支；族群頁再拆成 themes / map / screener / etf / stock
//
// 兩組互相引用是刻意留著的，都只在函式內用到，ES module 的 hoisting 撐得住：
//   render ↔ views/settings（設定頁存完要重繪整頁）
//   views/stock ↔ widgets（個股卡用共用片段；共用的列點了要開個股卡）
// 要動它們的話，改成事件或 registry 就能解開，目前不值得。
// ============================================================
import { $, $$, fail, sb, state, toast } from './core.js';
import { refresh, refreshPrices } from './data.js';
import { GUEST_TABS, render } from './render.js';
import { loadTwStocks } from './symbols.js';

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
