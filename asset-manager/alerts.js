import { esc, fmt, fmtMax, isNum, norm, num, state, stripTags, todayISO } from './core.js';
import { heldSymbols } from './portfolio.js';
import { resolveTwSymbol } from './symbols.js';

// 全角空白，欄位之間的分隔。寫成常數是為了讓原始碼裡的字串比對不會踩到非 ASCII。
const SEP = '　';

// ------------------------------------------------------------
// 處置股與注意股
//   為什麼要擺在顯眼的地方：他一次只沖一檔、每檔上限 100 萬。
//   **第二次處置是全額圈存**——買進要先付全部價金、賣出要先有券，
//   當沖等於做不成；撮合又變成人工約每兩分鐘一次，想跑的時候排不進去。
//   這是進場前就該知道的事。
// ------------------------------------------------------------
// 2026-10-12 補上第二個理由，而它比「不好當沖」貴得多。
// 這個模組原本只警告**執行**——撮合慢、要圈存、沖不掉。它從來沒提**保證金**。
// 而處置會讓期交所調高股票期貨的費率：金居 10/07 公告處置（10/08～10/15，
// 五週內第三次），10/12 盤後費率 22.95% → 45.90%，風險指標一夜從 103% 掉到 81%，
// 而**股價完全平盤**（收 525、成本 525.74）。等效於名目虧 6.5%（約 1.6σ），
// 卻沒有任何價格跡象、沒有反應時間。
// 當時畫面上有「處置中」的紅標，但那句話讀起來是「不好當沖」，
// 不是「你的保證金要翻倍了」——**處置與保證金在系統裡是兩個互不相識的東西，
// 而那正好是打倒他的那條線。**
//
// 處置門檻（照 2026-10 的公告原文，兩個交易所不一樣）：
//   證交所：連續三次 → 第一次處置；連續五次 → 第二次處置；十個營業日內六次 → 處置
//   櫃買　：連續5個營業日 → 處置（金居 09/01、09/17、10/07 三次都是這個理由）
// 數字由 active_alerts() 算（streak / win10 / last_rn）。
const STREAK_LIMIT = { twse: [3, 5], tpex: [5, 5] };

// 「還差幾次就處置」。streak 只有在 last_rn = 1（最近一次注意就在上一個營業日）
// 才算活的——連續是**數到現在**，中間斷掉時鐘就重設。拿歷史上的連續次數當警告
// 會一直亮紅燈，然後他就不看了。
export function dispCountdown(al) {
  const [first, second] = STREAK_LIMIT[String(al?.src || '').toLowerCase()] || [3, 5];
  const streak = num(al?.streak), win10 = num(al?.win10), lastRn = num(al?.last_rn);
  const bits = [];
  if (streak > 0) {
    if (lastRn === 1) {
      const left = (streak >= first ? second : first) - streak;
      bits.push(`連續 ${fmt(streak)} 次` + (left > 0 ? `，再 ${fmt(left)} 次就處置` : '，已達門檻'));
    } else {
      bits.push(`連續 ${fmt(streak)} 次（已中斷 ${fmt(lastRn - 1)} 個營業日，時鐘重設）`);
    }
  }
  if (win10 > 0) bits.push(`十個營業日內 ${fmt(win10)}／6 次` + (win10 >= 6 ? '（已達門檻）' : ''));
  return bits.join(SEP);
}

// 這一檔的保證金費率現在是多少、還有沒有調升空間。
// 擺進警示列，因為「處置中」這三個字本身不會讓人想到保證金。
function marginNote(sym) {
  const row = (state.futMargin || []).find((m) => String(m.symbol) === String(sym));
  const im = num(row?.im_rate);
  if (!(im > 0)) return '';
  const held = (state.futures || []).some((f) => String(f.symbol) === String(sym) && num(f.lots) > 0);
  const top = im >= 0.459 - 1e-9;
  return `原始保證金費率 <b>${fmtMax(im * 100, 2)}%</b>`
    + (top ? '（已是全市場最高的那一格，沒有進一步調升空間）'
           : `，被處置可能調到 <b>${fmtMax(Math.min(im * 2, 0.459) * 100, 2)}%</b>`)
    + (held ? SEP + '<b>你持有這一檔的期貨</b>' : '');
}


export const ALERT_LABEL = { punish: '處置中', near: '快達處置標準', notice: '注意股' };

export const alertOf = (sym) => {
  const k = resolveTwSymbol(sym);
  return k ? state.alerts.find((a) => norm(a.symbol) === k) || null : null;
};

// 「所以我會被限制什麼」。
// **數字一律照抄公告，不要自己歸納。** 撮合間隔實測有 2/5/20/45 分鐘四種，
// 圈存門檻有的是全部委託、有的要單筆 10 張以上才算，寫死任何一種都會錯。
export function alertLine(a) {
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
    const mn = marginNote(a.symbol);
    if (mn) bits.push(mn);
    return bits.join('　');
  }
  // 倒數擺在最前面：它是「還剩幾次」，比公告原文那一大段更能決定要不要動手。
  const cd = dispCountdown(a);
  const why = stripTags(a.reason) || (num(a.notices) > 0 ? `最近 30 天上過 ${fmt(a.notices)} 次注意` : '');
  const tail = [cd, why].filter(Boolean).join(SEP);
  if (tail) return tail;
  return a.kind === 'near' ? '注意次數已經逼近處置門檻，隨時可能被處置' : '最近上過注意交易資訊';
}

export const alertBadge = (a) => (a
  ? `<span class="badge alert-${esc(a.kind)}">${ALERT_LABEL[a.kind] || '警示'}</span>` : '');

// 持倉裡有沒有被盯上的，總覽要先講這個，不能等他自己去點
export function heldAlerts() {
  const out = [];
  for (const sym of heldSymbols()) {
    const a = alertOf(sym);
    if (a) out.push(a);
  }
  return out.sort((x, y) => (y.kind === 'punish') - (x.kind === 'punish'));
}
