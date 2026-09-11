import { esc, fmt, isNum, norm, num, state, stripTags, todayISO } from './core.js';
import { heldSymbols } from './portfolio.js';
import { resolveTwSymbol } from './symbols.js';

// ------------------------------------------------------------
// 處置股與注意股
//   為什麼要擺在顯眼的地方：他一次只沖一檔、每檔上限 100 萬。
//   **第二次處置是全額圈存**——買進要先付全部價金、賣出要先有券，
//   當沖等於做不成；撮合又變成人工約每兩分鐘一次，想跑的時候排不進去。
//   這是進場前就該知道的事。
// ------------------------------------------------------------
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
    return bits.join('　');
  }
  if (a.kind === 'near') return stripTags(a.reason) || '注意次數已經逼近處置門檻，隨時可能被處置';
  return num(a.notices) > 0
    ? `最近 30 天上過 ${fmt(a.notices)} 次注意${num(a.notices) >= 4 ? '，再一次就可能處置' : ''}`
    : (stripTags(a.reason) || '最近上過注意交易資訊');
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
