import { fmt, fmtMax, isNum, num, state } from './core.js';
import { OPT_SIZE, cpLabel } from './instruments.js';
import { TW_STOCKS, resolveTwSymbol, tradeKey } from './symbols.js';

// ------------------------------------------------------------
// 紀律規則
//   規則存在資料庫（rules 表），是使用者資料，程式更新不會動它。
//   這裡只負責「在記錄交易的當下」把違規算出來並顯示。
//   **刻意不阻止存檔**——那是他的錢、他的帳；但違規會被記下來，
//   而且每天在心得頁攤開來。手癢發生在下單那一刻，不是寫日誌的時候。
// ------------------------------------------------------------
const activeRule = (kind) => state.rules.find((r) => r.kind === kind && r.active) || null;

// 今天各標的的當沖淨部位。歸零才算「沖完」。
export function dayNet(dateISO, market, extra) {
  const net = new Map();
  const feed = extra ? [...state.trades, extra] : state.trades;
  for (const t of feed) {
    if (!t.is_day_trade || t.trade_date !== dateISO || t.market !== market) continue;
    const k = market === 'tw' ? resolveTwSymbol(t.symbol) : tradeKey(t);
    net.set(k, num(net.get(k)) + (t.side === 'buy' ? 1 : -1) * num(t.quantity));
  }
  for (const [k, v] of [...net]) if (Math.abs(v) < 1e-9) net.delete(k);
  return net;
}

// 一筆交易（可以是還沒存檔的）違反了哪些規則
export function checkRules(t) {
  const out = [];
  if (!t || !state.rules.length) return out;

  const hedge = activeRule('opt_only_hedge');
  if (hedge && t.market === 'option') {
    const banned = (t.side === 'buy' && t.opt_cp === 'call') || (t.side === 'sell' && t.opt_cp === 'put');
    if (banned) {
      out.push({
        kind: 'opt_only_hedge',
        text: `${t.side === 'buy' ? '買進' : '賣出'}${cpLabel(t.opt_cp)}違反「只做 buy put 與 sell call」`,
        why: '結算日手癢的 buy call 是這三個月最大的破口，這條沒有例外。',
      });
    }
  }

  const cap = activeRule('day_max_amount');
  if (cap && t.is_day_trade && t.market === 'tw' && isNum(cap.amount)) {
    const amt = num(t.quantity) * num(t.price);
    if (amt > num(cap.amount)) {
      out.push({
        kind: 'day_max_amount',
        text: `這筆 ${fmt(amt)} 元，超過單檔當沖上限 ${fmt(cap.amount)} 元（${(amt / num(cap.amount)).toFixed(1)} 倍）`,
        why: '上限是「完全做錯也還在」的金額，不是「這檔我很有把握」的金額。',
      });
    }
  }

  const one = activeRule('day_one_at_a_time');
  if (one && t.is_day_trade && t.market === 'tw') {
    const me = resolveTwSymbol(t.symbol);
    const open = [...dayNet(t.trade_date, 'tw').keys()].filter((k) => k !== me);
    if (open.length) {
      out.push({
        kind: 'day_one_at_a_time',
        text: `${open.map((k) => `${k} ${TW_STOCKS[k] || ''}`).join('、')} 還沒沖完就開新的一檔`,
        why: '同時開兩檔就是注意力不夠，而注意力不夠正是當沖唯一會致命的地方。',
      });
    }
  }
  return out;
}

// 掃某一天已經記錄的交易，回報違規。用於心得頁的每日檢討。
export function breaksOn(dateISO) {
  const out = [];
  const day = state.trades.filter((t) => t.trade_date === dateISO);
  const hedge = activeRule('opt_only_hedge');
  const cap = activeRule('day_max_amount');
  const one = activeRule('day_one_at_a_time');

  if (hedge && dateISO >= hedge.started_on) {
    const bad = day.filter((t) => t.market === 'option'
      && ((t.side === 'buy' && t.opt_cp === 'call') || (t.side === 'sell' && t.opt_cp === 'put')));
    if (bad.length) {
      const prem = bad.reduce((a, t) => a + num(t.quantity) * num(t.price) * OPT_SIZE, 0);
      out.push({ kind: 'opt_only_hedge',
        text: `選擇權違規 ${bad.length} 筆，權利金合計 ${fmt(prem)} 元`,
        detail: bad.map((t) => `${t.side === 'buy' ? '買進' : '賣出'}${cpLabel(t.opt_cp)} ${fmt(t.quantity)} 口 @ ${fmtMax(t.price, 2)}`).join('、') });
    }
  }
  if (cap && isNum(cap.amount) && dateISO >= cap.started_on) {
    const bad = day.filter((t) => t.is_day_trade && t.market === 'tw'
      && num(t.quantity) * num(t.price) > num(cap.amount));
    if (bad.length) {
      out.push({ kind: 'day_max_amount',
        text: `當沖單檔超過 ${fmt(cap.amount)} 元共 ${bad.length} 筆`,
        detail: bad.map((t) => `${resolveTwSymbol(t.symbol)} ${TW_STOCKS[resolveTwSymbol(t.symbol)] || ''} ${fmt(num(t.quantity) * num(t.price))}`).join('、') });
    }
  }
  if (one && dateISO >= one.started_on) {
    // 依時間重播，只要在還有未沖完部位時開了另一檔就算違規
    const list = day.filter((t) => t.is_day_trade && t.market === 'tw')
      .sort((a, b) => (String(a.created_at) < String(b.created_at) ? -1 : 1));
    const net = new Map(); const hit = new Set();
    for (const t of list) {
      const k = resolveTwSymbol(t.symbol);
      const others = [...net].filter(([kk, v]) => kk !== k && Math.abs(v) > 1e-9).map(([kk]) => kk);
      if (!net.has(k) && others.length) others.forEach((o) => hit.add(`${o} → ${k}`));
      net.set(k, num(net.get(k)) + (t.side === 'buy' ? 1 : -1) * num(t.quantity));
    }
    if (hit.size) {
      out.push({ kind: 'day_one_at_a_time',
        text: `同時開了不只一檔當沖 ${hit.size} 次`, detail: [...hit].join('、') });
    }
  }
  return out;
}
