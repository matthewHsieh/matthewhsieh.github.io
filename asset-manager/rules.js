import { fmt, fmtMax, isNum, norm, num, state } from './core.js';
import { OPT_SIZE, cpLabel, optForwardInfo, optSettleISO, usLeverage } from './instruments.js';
import { compute } from './portfolio.js';
import { exposureRows } from './risk.js';
import { TW_STOCKS, indexProduct, resolveTwSymbol, tradeKey } from './symbols.js';

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

// ------------------------------------------------------------
// 買 call 的兩個例外
//
//   原本這條是一刀切的「只准 buy put 與 sell call」。但被它擋掉的買 call
//   其實是兩種完全不同的東西：
//     1. 結算日那張價外彩券——這個才是真正要戒的破口；
//     2. 深度價內的 call——delta 接近 1，付出去的錢幾乎全是內含價值，
//        功能上等於一口有最大損失上限的期貨多單，時間價值幾乎不吃。
//   第 2 種跟他要戒的毛病無關，所以解開。第 1 種也解開，但**用錢包關住**。
//
//   兩種都吃同一個當日額度：OPT_CALL_BUDGET，加上當天已經實現的獲利。
//   **賠錢的日子額度不會變大**——「先賺錢才能加碼」才是這條的重點，
//   不然解 ban 就只是把破口改成有上限的破口。
// ------------------------------------------------------------
export const OPT_ITM_DEEP = 0.01;       // 履約價要比遠期指數低 1% 以上才算深度價內
export const OPT_CALL_BUDGET = 40000;   // 預設當日額度，規則列的 amount 可以蓋掉

const optPremium = (t, q) => num(q === undefined ? t.quantity : q) * num(t.price) * OPT_SIZE;

// ------------------------------------------------------------
// 平倉不是新的賭注
//
//   買權價差要退出的時候，賣出的那一腳得「買回來」。可是那筆在資料上
//   就是一筆「買進買權」，於是被這條規則當成破戒擋下來——
//   **他做的是減少風險的動作，卻被記成違規。**
//   2026-09-17 收掉 45500/46800 價差時就發生了。
//
//   判斷方式不用他自己選，資料本來就知道：
//     已存檔的交易有 prev_shares（平倉前的淨口數，空方是負的）；
//     還沒存檔的就去看 state.options 裡同一個到期別、同履約價、同買賣權的部位。
//   方向相反才算平倉，而且只算平掉的那幾口——
//   買 10 口去平 5 口的空單，剩下的 5 口是真的新倉，照樣要檢查。
// ------------------------------------------------------------
function closingLots(t) {
  const dir = t.side === 'buy' ? 1 : -1;
  let prev = null;
  if (isNum(t.prev_shares)) prev = num(t.prev_shares);
  else {
    const pos = (state.options || []).find((o) => String(o.expiry) === String(t.opt_expiry)
      && num(o.strike) === num(t.opt_strike) && o.cp === t.opt_cp);
    if (pos) prev = pos.side === 'short' ? -num(pos.lots) : num(pos.lots);
  }
  if (prev === null || Math.sign(prev) !== -dir) return 0;
  return Math.min(num(t.quantity), Math.abs(prev));
}

// 真正屬於「新開倉」的口數
const openingLots = (t) => Math.max(0, num(t.quantity) - closingLots(t));

const isBuyCall = (t) => t.market === 'option' && t.side === 'buy' && t.opt_cp === 'call';
const isSellPut = (t) => t.market === 'option' && t.side === 'sell' && t.opt_cp === 'put';

// before 是 created_at 的界線：回頭檢討時只算排在它前面的，
// 記錄新交易時傳 null（今天已經存檔的全部都算在它前面）。
const earlier = (t, before) => !before || String(t.created_at) < String(before);

// ------------------------------------------------------------
// 不當沖：買進的至少隔天才能賣
//
//   2026-09-23 立的。九月現股當沖 −17 萬、個股期貨＋選擇權 −127 萬，
//   六、七月各爆倉一次之後變成下殺不敢放、上漲急著跑。他自己的結論是
//   「心態恢復之前沒有資格玩短線」。
//
//   兩種情況算違規，資料本來就分得出來：
//     1. 交易勾了「當沖」——最直接；
//     2. 沒勾，但同一天同一檔已經有反向的交易（先買後賣，或先空後補）。
//        拆成兩筆波段來繞過勾選框，一樣會被抓到。
//   **同一檔**用 tradeKey 判斷：代號與中文名稱解析成同一個，
//   個股期貨看標的與規格，選擇權看到期別／履約價／買賣權。
//   **轉倉不算**：賣近月、買遠月在資料上就是同一天同一檔一買一賣，
//   但那是換合約不是進出，跟紀錄頁的分類用同一個判斷（note 開頭是「轉倉」）。
//
//   手上本來就有的部位、今天又買又賣的，也算。系統分不出賣掉的是哪一批，
//   而「今天買、今天賣」正是這條要戒的動作，寧可多問一次。
// ------------------------------------------------------------
const isRoll = (t) => String(t.note || '').startsWith('轉倉');

// 給違規訊息用的標的名稱
function tradeLabel(t) {
  if (t.market === 'option') return `${t.opt_expiry ?? ''} ${fmt(t.opt_strike)} ${cpLabel(t.opt_cp)}`.trim();
  if (t.market === 'tw' || t.fut_kind === 'stock') {
    const k = resolveTwSymbol(t.symbol);
    return `${k} ${TW_STOCKS[k] || ''}${t.market === 'futures' ? ' 個股期' : ''}`.trim();
  }
  return String(t.symbol || '').trim();
}

// 同一天、同一檔、方向相反、排在這筆之前的交易
function sameDayReverse(t, before) {
  if (isRoll(t)) return [];
  const key = tradeKey(t);
  return state.trades.filter((x) => x !== t && x.trade_date === t.trade_date && x.side !== t.side
    && !isRoll(x) && earlier(x, before) && tradeKey(x) === key);
}

// 回傳 null 代表這筆沒問題
function dayTradeBreak(t, before) {
  if (t.is_day_trade) {
    return {
      kind: 'no_day_trade',
      text: `${tradeLabel(t)} 勾了當沖`,
      why: '2026-09-23 發過誓：再也不當沖。短線能力在心態恢復之前沒有資格用，會死，有多少錢都沒用。',
    };
  }
  const rev = sameDayReverse(t, before);
  if (!rev.length) return null;
  const qty = rev.reduce((a, x) => a + num(x.quantity), 0);
  const first = t.side === 'sell' ? '買進' : '賣出';
  const now = t.side === 'sell' ? '賣出' : '回補';
  return {
    kind: 'no_day_trade',
    text: `${tradeLabel(t)} 今天才${first} ${fmtMax(qty, 2)}，當天就${now}`,
    why: '買進的至少要隔天才能賣。沒勾當沖也一樣：同一天同一檔一買一賣就是當沖，只是記成兩筆波段。',
  };
}

// 當天在這筆之前已經實現的損益。
//   **定義要跟心得頁上那個數字一樣**（journal_days 也是直接加 realized_pl），
//   不然畫面說今天賺了兩萬、規則卻說沒賺，使用者無從判斷誰對。
function realizedBefore(dateISO, before) {
  let s = 0;
  for (const t of state.trades) {
    if (t.trade_date !== dateISO || !isNum(t.realized_pl) || !earlier(t, before)) continue;
    s += num(t.realized_pl) * (t.realized_ccy === 'USD' ? num(state.settings.usd_twd) : 1);
  }
  return s;
}

// 當天在這筆之前已經花掉的買 call 權利金（違規的那幾筆也算，額度是總量管制）
function callSpentBefore(dateISO, before) {
  let s = 0;
  for (const t of state.trades) {
    if (t.trade_date !== dateISO || !isBuyCall(t) || !earlier(t, before)) continue;
    s += optPremium(t, openingLots(t));      // 回補的那幾口不吃額度
  }
  return s;
}

// 判斷價內程度要用的指數。
//   **優先用交易上記下來的那一個。** 自動抓的那個有兩層問題，而且都往同一邊錯：
//     1. 期交所的每日行情要隔一天才進得來，所以拿到的通常是昨天的；
//     2. **它只有日盤。** 期交所的結算價是日盤收盤價，夜盤（15:00–05:00）
//        的行情完全不在裡面。2026-09-16 日盤收 45,849，夜盤一開盤就 46,250，
//        差 400 點——而「價內 1%」的門檻是 460 點，同一個量級。
//   他常常是夜盤下單、收盤後才回來補紀錄，所以自動值在門檻附近等於擲硬幣。
function fwdFor(t) {
  if (isNum(t.opt_fwd) && num(t.opt_fwd) > 0) return { value: num(t.opt_fwd), as_of: null };
  return optForwardInfo(t.opt_expiry);
}

// 用的是自動值就要講出它是哪一天、哪一盤，不然誤判看起來就只是「系統壞了」
const autoNote = (f) => (f && f.as_of ? `${f.as_of} 日盤結算的` : '');

// 這口買 call 符合哪一種豁免
function callExempt(t) {
  const f = fwdFor(t);
  const fwd = f ? f.value : null;
  const k = num(t.opt_strike);
  const settle = optSettleISO(t.opt_expiry);
  if (isNum(fwd) && k > 0 && k <= num(fwd) * (1 - OPT_ITM_DEEP)) {
    return { how: 'deep', note: `深度價內（履約 ${fmt(k)}、指數 ${fmt(fwd)}，價內 ${fmt(num(fwd) - k)} 點）` };
  }
  if (settle && settle === t.trade_date) return { how: 'settle', note: `${settle} 今天結算` };
  return { how: null, fwd, auto: autoNote(f), strike: k, settle };
}

// 買 call 的判定。回傳 null 代表這筆沒問題。
function buyCallBreak(t, rule, before, open) {
  const ex = callExempt(t);
  if (!ex.how) {
    // 價內是負的就要講成「價外」。寫成「只價內 -1,070 點」沒有人看得懂。
    const into = num(ex.fwd) - ex.strike;
    const gap = isNum(ex.fwd) && ex.strike > 0
      ? `履約 ${fmt(ex.strike)}、${ex.auto}指數 ${fmt(ex.fwd)}，${
        into >= 0 ? `只價內 ${fmt(into)} 點` : `還價外 ${fmt(-into)} 點`}`
      : '抓不到指數，一律當成不符合';
    return {
      kind: 'opt_only_hedge',
      text: '買進買權違反「只做 buy put 與 sell call」',
      reason: '既不是深度價內，也不是今天結算',
      why: `只有兩種買 call 解 ban：深度價內（比指數低 ${fmt(OPT_ITM_DEEP * 100)}% 以上）`
        + `，或今天就結算的合約。這口 ${gap}${ex.settle ? `、最後交易日 ${ex.settle}` : ''}。`
        + `${ex.auto ? '　期交所的結算價只有日盤，夜盤的行情它看不到；夜盤下的單請在表單上把「當時的指數」填進去。' : ''}`,
    };
  }

  const base = isNum(rule?.amount) ? num(rule.amount) : OPT_CALL_BUDGET;
  const earned = Math.max(0, realizedBefore(t.trade_date, before));
  const budget = base + earned;
  const spent = callSpentBefore(t.trade_date, before) + optPremium(t, open);
  if (spent > budget + 1e-6) {
    return {
      kind: 'opt_only_hedge',
      text: `今天買 call 的權利金 ${fmt(spent)} 元，超過額度 ${fmt(budget)} 元`,
      reason: `${ex.note}，但超出額度 ${fmt(spent - budget)} 元`,
      why: `額度是 ${fmt(base)} 元${earned > 0
        ? `，加上今天已經實現的 ${fmt(earned)} 元`
        : '；今天還沒有已實現獲利，額度就不會變大'}。賺到的才能打進去，賠錢的日子不行。`,
    };
  }
  return null;
}

// 給表單預覽用：解 ban 的那幾口也要看得到理由與剩餘額度，
// 不然畫面上什麼都沒出現，會以為規則根本沒在跑。
export function optCallNote(t) {
  const rule = activeRule('opt_only_hedge');
  if (!rule || !isBuyCall(t) || !(num(t.quantity) > 0) || !(num(t.price) > 0)) return null;
  const open = openingLots(t);
  if (open <= 1e-9) return `買回自己賣出的買權＝平倉，不算新的買 call，也不吃額度`;
  const ex = callExempt(t);
  if (!ex.how) return null;
  const base = isNum(rule.amount) ? num(rule.amount) : OPT_CALL_BUDGET;
  const earned = Math.max(0, realizedBefore(t.trade_date, null));
  const budget = base + earned;
  const spent = callSpentBefore(t.trade_date, null) + optPremium(t, open);
  if (spent > budget + 1e-6) return null;   // 超額的話由 checkRules 出面講
  return `${ex.note}　權利金 ${fmt(spent)} ／ 額度 ${fmt(budget)} 元`
    + `${earned > 0 ? `（含今天已實現的 ${fmt(earned)}）` : ''}`;
}

// ------------------------------------------------------------
// 部位大小：單檔上限與總曝險上限
//
//   2026-09-24 立的。前一天南亞個股期 20 口 = 900 萬名目 = 總資產 2.6 倍，
//   跌到 223 那天帳面 −63.6 萬、總資產的 18%，在低點停損；隔天反彈。
//   同一個判斷放 1 口，那天帳面只有 −3.2 萬，根本不會看它。
//   判斷對不對從來不是問題，**部位大到超出心理範圍，出場一定發生在低點。**
//
//   基準用**總資產**不用淨資產：他的淨資產是負的，百分比算不出來，
//   而且桌上的錢就是總資產，虧掉的每一塊都是要還家人的。
//   指數不受單檔上限（0050 / 006208 / 指數期貨），那是設計裡唯一准開槓桿的東西。
//   規則列的 amount：單檔上限填「總資產的百分比」（15 = 15%），
//   總曝險上限填「總資產的倍數」（1 = 100%）。
// ------------------------------------------------------------
const INDEX_ETFS = new Set(['0050', '006208', '00631L', '00675L']);

const isIndexTrade = (t) => (t.market === 'futures' && t.fut_kind !== 'stock')
  || (t.market === 'tw' && INDEX_ETFS.has(norm(t.symbol)));

// 這筆交易的名目金額（台幣）
function tradeNotional(t) {
  const q = num(t.quantity), p = num(t.price);
  if (t.market === 'futures') return q * p * num(t.fut_size || (t.fut_kind === 'stock' ? 2000 : indexProduct(t.symbol)?.size || 0));
  if (t.market === 'us') {
    // **槓桿型 ETF 要乘倍數。** 交易表單上沒有倍數欄，先看手上同一檔部位填的倍數，
    // 沒有就從名稱推（MUU、MRVU 這種 Bull 2X）。不乘的話 2X 的部位在這條規則裡只算一半，
    // 而他 2026-09-24 假期裡想做的正是 MRVU 換 MUU。
    const held = (state.us || []).find((u) => norm(u.symbol) === norm(t.symbol));
    const lev = Math.abs(usLeverage({ leverage: isNum(t.leverage) ? t.leverage : held?.leverage, name: t.name || held?.name }));
    return q * p * (num(state.settings?.usd_twd) || 32) * (lev || 1);
  }
  if (t.market === 'option') return 0;          // 選擇權用 delta 曝險，不在這條的範圍
  return q * p;                                 // 台股、權證
}

// 同一檔現在的曝險。個股期貨跟現股算同一檔（key 都是代號）。
function symbolExposure(t) {
  const key = t.market === 'us' ? norm(t.symbol) : resolveTwSymbol(t.symbol);
  return exposureRows().filter((r) => r.key === key).reduce((a, r) => a + r.exposure, 0);
}

function sizeBreaks(t) {
  const out = [];
  const cap = activeRule('max_position_pct');
  const tot = activeRule('max_exposure');
  if (!cap && !tot) return out;
  if (t.market === 'option' || t.market === 'warrant') return out;
  const c = compute();
  const assets = num(c.totalAssets);
  if (!(assets > 0)) return out;
  const add = tradeNotional(t) * (t.side === 'buy' ? 1 : -1);
  if (cap && isNum(cap.amount) && !isIndexTrade(t) && add > 0) {
    // 單檔上限的分母是「總曝險上限」，不是總資產：他要的是「這檔佔整個部位的幾 %」。
    // 冷靜期上限 1 倍，兩者相同；上限放到 1.3 倍時單檔跟著變 19.5% 的總資產。
    // **用上限不用實際曝險**：用實際曝險的話，曝險開越大單檔上限跟著越寬，規則會自己失效。
    const base = assets * (tot && isNum(tot.amount) && num(tot.amount) > 0 ? num(tot.amount) : 1);
    const after = symbolExposure(t) + add;
    const pct = after / base;
    if (pct > num(cap.amount) / 100 + 1e-9) {
      const label = t.market === 'us' ? norm(t.symbol) : `${resolveTwSymbol(t.symbol)} ${TW_STOCKS[resolveTwSymbol(t.symbol)] || ''}`.trim();
      out.push({
        kind: 'max_position_pct',
        text: `${label} 這筆之後曝險 ${fmt(after)} 元，佔總曝險上限的 ${fmt(pct * 100)}%，超過單檔上限 ${fmt(cap.amount)}%（上限約 ${fmt(base * num(cap.amount) / 100)} 元）`,
        why: `一檔一天動 3% 的金額要是你看了不會想動的數字。南亞 20 口那天是 −63.6 萬、總資產的 18%，在低點停損；照上限只會是 −3 萬。判斷對不對從來不是問題，大小才是。`,
      });
    }
  }
  if (tot && isNum(tot.amount) && add > 0) {
    const after = num(c.exposure) + add;
    const lev = after / assets;
    if (lev > num(tot.amount) + 1e-9) {
      out.push({
        kind: 'max_exposure',
        text: `這筆之後總曝險 ${fmt(after)} 元，是總資產的 ${fmtMax(lev, 2)} 倍，超過上限 ${fmtMax(tot.amount, 2)} 倍`,
        why: '冷靜期總曝險不超過一倍：現貨買多少就是多少，沒有借來的部位。要開槓桿只能開在指數上，而且要等冷靜期結束。',
      });
    }
  }
  return out;
}

// 一筆交易（可以是還沒存檔的）違反了哪些規則
export function checkRules(t) {
  const out = [];
  if (!t || !state.rules.length) return out;

  // 部位大小排最前面：這是 2026-09-24 之後最要緊的一條
  out.push(...sizeBreaks(t));

  // 排第一個：這是 2026-09-23 之後最要緊的一條
  const hold = activeRule('no_day_trade');
  if (hold) {
    const v = dayTradeBreak(t, null);
    if (v) out.push(v);
  }

  const hedge = activeRule('opt_only_hedge');
  // **平倉先扣掉。** 買回自己賣出的買權、賣掉自己買進的賣權，都是在收部位，
  // 不是在開新的賭注，擋它等於懲罰他做對的事。
  const opening = hedge && t.market === 'option' ? openingLots(t) : 0;
  if (hedge && t.market === 'option' && opening > 1e-9) {
    const part = opening < num(t.quantity)
      ? `（${fmtMax(num(t.quantity) - opening, 2)} 口是平倉，不算）` : '';
    if (isSellPut(t)) {
      out.push({
        kind: 'opt_only_hedge',
        text: `賣出賣權違反「只做 buy put 與 sell call」${part}`,
        reason: '賣方賣權沒有解 ban',
        why: '賣 put 是把所有下跌一次承接下來，跟避險的方向相反，這條沒有例外。',
      });
    } else if (isBuyCall(t)) {
      const v = buyCallBreak(t, hedge, null, opening);
      if (v) { v.text += part; out.push(v); }
    }
  }

  const cap = activeRule('day_max_amount');
  if (cap && t.is_day_trade && t.market === 'tw' && isNum(cap.amount)) {
    const amt = num(t.quantity) * num(t.price);
    if (amt > num(cap.amount)) {
      out.push({
        kind: 'day_max_amount',
        // **不要寫倍數。** 1,240,000 / 1,200,000 四捨五入是「1.0 倍」，
        // 看起來像剛好沒超過，可是它超過了。講超出多少錢不會有歧義。
        text: `這筆 ${fmt(amt)} 元，超過單檔當沖上限 ${fmt(cap.amount)} 元（超出 ${fmt(amt - num(cap.amount))} 元）`,
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
  const hold = activeRule('no_day_trade');
  const hedge = activeRule('opt_only_hedge');
  const cap = activeRule('day_max_amount');
  const one = activeRule('day_one_at_a_time');

  if (hold && dateISO >= hold.started_on) {
    // 勾了當沖的直接算；沒勾的看同一檔當天有沒有一買一賣（轉倉不算）
    const flagged = day.filter((t) => t.is_day_trade);
    const byKey = new Map();
    for (const t of day) {
      if (t.is_day_trade || isRoll(t)) continue;
      const k = tradeKey(t);
      const e = byKey.get(k) || { t, buy: 0, sell: 0 };
      if (t.side === 'buy') e.buy += num(t.quantity); else e.sell += num(t.quantity);
      byKey.set(k, e);
    }
    const pairs = [...byKey.values()].filter((e) => e.buy > 0 && e.sell > 0);
    if (flagged.length || pairs.length) {
      const names = new Set([...flagged.map(tradeLabel), ...pairs.map((e) => tradeLabel(e.t))]);
      const how = [
        flagged.length ? `勾了當沖 ${flagged.length} 筆` : '',
        pairs.length ? `同一天一買一賣 ${pairs.length} 檔` : '',
      ].filter(Boolean).join('、');
      out.push({ kind: 'no_day_trade',
        text: `當沖 ${names.size} 檔（${how}）`,
        detail: [...names].join('、') });
    }
  }

  if (hedge && dateISO >= hedge.started_on) {
    // 額度是「當天累計」，所以要照時間重播，不能各看各的。
    const opts = day.filter((t) => t.market === 'option')
      .sort((a, b) => (String(a.created_at) < String(b.created_at) ? -1 : 1));
    const bad = [];
    for (const t of opts) {
      const open = openingLots(t);
      if (open <= 1e-9) continue;                  // 純平倉，不是新的賭注
      if (isSellPut(t)) bad.push({ t, reason: '賣方賣權沒有解 ban' });
      else if (isBuyCall(t)) {
        const v = buyCallBreak(t, hedge, t.created_at, open);
        if (v) bad.push({ t, reason: v.reason });
      }
    }
    if (bad.length) {
      const prem = bad.reduce((a, x) => a + optPremium(x.t), 0);
      out.push({ kind: 'opt_only_hedge',
        text: `選擇權違規 ${bad.length} 筆，權利金合計 ${fmt(prem)} 元`,
        detail: bad.map(({ t, reason }) => `${t.side === 'buy' ? '買進' : '賣出'}${cpLabel(t.opt_cp)} ${
          fmt(t.quantity)} 口 @ ${fmtMax(t.price, 2)}（${reason}）`).join('、') });
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
