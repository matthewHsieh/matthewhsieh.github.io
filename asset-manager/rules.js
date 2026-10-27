import { fmt, fmtMax, isNum, norm, num, state } from './core.js';
import { OPT_SIZE, cpLabel, optForwardInfo, optSettleISO, usLeverage } from './instruments.js';
import { compute } from './portfolio.js';
import { exposureRows, marginState } from './risk.js';
import { TW_STOCKS, indexProduct, resolveTwSymbol, tradeKey } from './symbols.js';

// ------------------------------------------------------------
// 紀律規則
//   規則存在資料庫（rules 表），是使用者資料，程式更新不會動它。
//   這裡只負責「在記錄交易的當下」把違規算出來並顯示。
//   **刻意不阻止存檔**——那是他的錢、他的帳；但違規會被記下來，
//   而且每天在心得頁攤開來。手癢發生在下單那一刻，不是寫日誌的時候。
// ------------------------------------------------------------
export const activeRule = (kind) => state.rules.find((r) => r.kind === kind && r.active) || null;

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

// ------------------------------------------------------------
// 時間閘門：做錯決定之後，不要讓它影響下一個決定
//
//   2026-09-29 用他 208 筆交易（9/08–9/29、15 個交易日）量出來的：
//     78% 的交易發生在前一筆的 5 分鐘內，只有 6% 間隔超過一小時；
//     前一筆實現虧損之後，下一筆的間隔**中位數是 0 分鐘**（35 次裡 29 次在 5 分鐘內）；
//     叢聚（前一筆在 30 分鐘內）的 79 筆合計 −120 萬，孤立的 15 筆 −14 萬；
//     當天交易 ≥8 筆的 11 天合計 −140 萬。
//   **「當天交易筆數」是他最強的單一虧損預測因子**，比任何選股指標都強。
//   所以「下一個決定」根本不是新決定，是同一個情緒事件的延長。
//   文獻：Thaler & Johnson 1990 的 break-even effect（虧損後更願意冒險求回本）、
//   Coval & Shumway 2005（早盤虧損的期貨自營商下午加大風險，而那些交易賠錢）。
//
//   **兩條都只擋開新倉與加碼，減碼與平倉永遠放行。**
//   虧損之後「賣出」是該鼓勵的動作，擋它等於懲罰他做對的事。
//   時間差用 created_at（記錄的時間）算，所以**要先在 App 記、再去券商下單**，
//   事後補記的話這條只會變成統計，不會在決定的當下擋人。
// ------------------------------------------------------------

// 手上這一檔的方向：1 多、−1 空、0 沒有部位
function heldDirection(t) {
  if (t.market === 'futures') {
    const key = t.fut_kind === 'stock' ? resolveTwSymbol(t.symbol) : norm(t.symbol);
    const f = (state.futures || []).find((x) => (x.kind === 'stock' ? resolveTwSymbol(x.symbol) : norm(x.symbol)) === key);
    if (!f) return 0;
    return f.side === 'short' ? -1 : 1;
  }
  if (t.market === 'us') return (state.us || []).some((u) => norm(u.symbol) === norm(t.symbol)) ? 1 : 0;
  if (t.market === 'warrant') return (state.warrants || []).some((w) => norm(w.code) === norm(t.symbol)) ? 1 : 0;
  return (state.stocks || []).some((s) => resolveTwSymbol(s.symbol) === resolveTwSymbol(t.symbol)) ? 1 : 0;
}

// 這筆是不是在增加曝險。**減碼、平倉、回補一律回 false。**
function isOpening(t) {
  if (t.market === 'option') return openingLots(t) > 1e-9;
  if (isRoll(t)) return false;                      // 轉倉是換合約不是新賭注
  const held = heldDirection(t);
  if (held > 0) return t.side === 'buy';
  if (held < 0) return t.side === 'sell';
  return true;                                      // 沒部位，任何一邊都是開新倉
}

// 當天最後一筆有實現損益的交易是什麼時候
function lastRealizedAt(dateISO) {
  let at = null;
  for (const x of state.trades) {
    if (x.trade_date !== dateISO || !isNum(x.realized_pl) || !x.created_at) continue;
    if (!at || String(x.created_at) > String(at)) at = x.created_at;
  }
  return at;
}

// 當天的「痛」有多大。**不能只看已實現，也不能對未實現太敏感。**
//   2026-09-29 是反例：當天已實現 +30,000（早上賣掉 2 口華新科），
//   但含未實現是 −42 萬，而他下午想加碼金居時 no_open_after_loss 完全不會跳。
//   規則要擋的是「痛到會亂下單」的狀態，那個狀態跟著總損益走，不跟著會計科目走。
//
//   兩個訊號分開判斷，因為性質不同：
//     1. **已實現虧損**：他主動平在虧損的價位，這是刻意的痛，任何金額都算。
//     2. **淨資產相對最近快照的變化**：每天都在跳動，只差 20 元也會是負的，
//        所以要有門檻，否則每個小跌日都跳，警告就變成雜訊。
//        門檻用規則列的 amount，沒填就用總資產的 1%。
//   不把兩者相加：期貨的實現損益要等他手動更新權益數才會進總資產，相加會重複計算。
function dayPain(dateISO) {
  const realized = realizedBefore(dateISO, null);
  let drop = null;
  const snap = (state.snapshots || [])[0];
  if (snap && isNum(snap.net_assets)) {
    const now = num(compute().netAssets);
    if (Number.isFinite(now)) drop = now - num(snap.net_assets);
  }
  return { realized, drop };
}

// ------------------------------------------------------------
// 當週停損（2026-10-27）
//   一天的停損擋得住一天，擋不住「隔天想贏回來」：連續幾天、一天比一天大。
//   當週（台北時間週一起算）已實現累計虧到門檻的那一筆，從它的時間起算 48 小時
//   不開新倉。**週末不算進 48 小時**——週五下午觸發，要停到下週二下午。
//   只看已實現，理由跟 breaksOn 的時間閘門一樣：事後算不出當時的帳面損益。
//   規則開始日之前的交易不算，不然一啟用就被上週的虧損鎖住。
// ------------------------------------------------------------
const TPE = 8 * 3600e3;

function weekStartISO(dateISO) {
  const d = new Date(`${dateISO}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;            // 週一 = 0
  return new Date(d.getTime() - dow * 864e5).toISOString().slice(0, 10);
}

// 從 ms 起算加 h 個平日小時（台北時間的週六、週日跳過）
function addWeekdayHours(ms, h) {
  let t = ms, left = h * 3600e3;
  while (left > 0) {
    const local = new Date(t + TPE);
    const nextDay = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1) - TPE;
    const dow = local.getUTCDay();
    if (dow === 0 || dow === 6) { t = nextDay; continue; }
    const step = Math.min(left, nextDay - t);
    t += step; left -= step;
  }
  return t;
}

const fmtTpe = (ms) => {
  const d = new Date(ms + TPE);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

// atMs 那一刻有沒有在停止期裡。有的話回傳 { from, until, week, acc }
function weekPause(atMs) {
  const rule = activeRule('week_loss_pause');
  if (!rule || !(num(rule.amount) > 0)) return null;
  const floor = -Math.abs(num(rule.amount));
  const rate = num(state.settings.usd_twd);
  const byWeek = new Map();
  for (const x of state.trades) {
    if (!isNum(x.realized_pl) || !x.created_at) continue;
    if (rule.started_on && x.trade_date < rule.started_on) continue;
    const w = weekStartISO(x.trade_date);
    if (!byWeek.has(w)) byWeek.set(w, []);
    byWeek.get(w).push(x);
  }
  let hit = null;
  for (const [week, list] of byWeek) {
    list.sort((a, b) => (String(a.created_at) < String(b.created_at) ? -1 : 1));
    let acc = 0;
    for (const x of list) {
      acc += num(x.realized_pl) * (x.realized_ccy === 'USD' ? rate : 1);
      if (acc > floor + 1e-6) continue;
      const from = Date.parse(x.created_at);
      const until = addWeekdayHours(from, 48);
      if (atMs >= from && atMs < until && (!hit || from > hit.from)) hit = { from, until, week, acc };
      break;                                      // 一週只從第一次觸及門檻起算
    }
  }
  return hit;
}

function weekPauseBreak(t, atMs) {
  if (!isOpening(t)) return null;
  const p = weekPause(atMs);
  if (!p) return null;
  return {
    kind: 'week_loss_pause',
    text: `這週（${p.week} 起）已實現 ${fmt(p.acc)}，停止期到 ${fmtTpe(p.until)}，這筆是開新倉或加碼`,
    why: '一天的停損擋得住一天，擋不住隔天想贏回來。停止期只能減碼、平倉，週末不算進 48 小時。',
  };
}

// ------------------------------------------------------------
// 選擇權只准買 put（2026-10-27）
//   opt_only_hedge 還留著 sell call 與兩種買 call 的例外，這條把它們全部關掉。
//   兩個月的選擇權紀錄裡，一天的結算就能抵掉其他所有交易的獲利；唯一用對的一次
//   是保護既有部位的保險 put。平倉（買回賣出的、賣掉買進的）一樣不擋。
// ------------------------------------------------------------
const isBuyPut = (t) => t.market === 'option' && t.side === 'buy' && t.opt_cp === 'put';
const optAction = (t) => `${t.side === 'buy' ? '買進' : '賣出'}${cpLabel(t.opt_cp)}`;

function putOnlyBreak(t) {
  if (!activeRule('opt_put_only') || t.market !== 'option') return null;
  const opening = openingLots(t);
  if (opening <= 1e-9 || isBuyPut(t)) return null;
  const part = opening < num(t.quantity) ? `（${fmtMax(num(t.quantity) - opening, 2)} 口是平倉，不算）` : '';
  return {
    kind: 'opt_put_only',
    text: `${optAction(t)}違反「選擇權只能買 put 當保險」${part}`,
    reason: `${optAction(t)}沒有例外`,
    why: '買 put 是保險：保護手上的部位，最多就賠權利金。其他的選擇權都是賭注，一天的結算就能抵掉其他所有交易的獲利。',
  };
}

function gateBreaks(t) {
  const out = [];
  const lossDay = activeRule('no_open_after_loss');
  const cool = activeRule('cooldown_after_close');
  if ((!lossDay && !cool) || !isOpening(t)) return out;

  if (lossDay) {
    const { realized, drop } = dayPain(t.trade_date);
    // 未實現的門檻：amount 有填就用它，沒填用總資產的 1%
    const floor = isNum(lossDay.amount) && num(lossDay.amount) > 0
      ? Math.abs(num(lossDay.amount))
      : Math.abs(num(compute().totalAssets)) * 0.01;
    const byRealized = realized < -1e-6;
    const byDrop = drop !== null && drop < -floor;
    if (byRealized || byDrop) {
      const parts = [];
      if (byRealized) parts.push(`已實現 ${fmt(realized)}`);
      if (drop !== null) parts.push(`含未實現 ${fmt(drop)}`);
      out.push({
        kind: 'no_open_after_loss',
        text: `今天${parts.join('、')}，這筆是開新倉或加碼`,
        why: byRealized
          ? '虧損之後的下一筆，中位數在 0 分鐘內發生，而那些交易合計輸掉 120 萬。今天結束，明天再看。減碼不受這條限制。'
          : `今天的未實現跌幅超過門檻 ${fmt(floor)} 元。帳面在痛的時候開新倉，跟實現虧損之後開新倉是同一個狀態。減碼不受這條限制。`,
      });
    }
  }

  if (cool) {
    const mins = isNum(cool.amount) && num(cool.amount) > 0 ? num(cool.amount) : 60;
    const at = lastRealizedAt(t.trade_date);
    if (at) {
      const gap = (Date.now() - Date.parse(at)) / 60000;
      if (gap >= 0 && gap < mins) {
        out.push({
          kind: 'cooldown_after_close',
          text: `上一筆平倉是 ${fmt(gap)} 分鐘前，還沒滿 ${fmt(mins)} 分鐘`,
          why: `你 94% 的交易間隔在一小時以內，而那些正是虧損集中的地方。等滿 ${fmt(mins)} 分鐘再決定，通常就不會想做了。`,
        });
      }
    }
  }
  return out;
}

// ------------------------------------------------------------
// 期貨名目上限
//
// 2026-10-13 回測出來的分界線。資料：16 檔（他的持股＋CCL／半導體同族群）、
// 2024-11～2026-10、6,975 個交易日，其中 36 天是「全市場恐慌日」
// （當天半數以上個股跳空 ≤−2%，平均每 2.9 週一次）。
// 把每個恐慌日當天所有個股的等權組合報酬當成他的組合，看各槓桿水準會不會被追繳：
//
//   名目/權益   追繳距離   單一恐慌日觸及   三個月內
//     2.50x      21.9%          0%            0%
//     3.00x      13.2%          0%            0%
//     3.25x       9.9%        2.8%         11.4%
//     3.50x       7.0%       27.8%         75.3%     ← 懸崖
//     4.00x       2.3%      100.0%        100.0%     ← 36 個恐慌日 36 次全中
//
// **他 2026-10-12 在 4.06 倍，恐慌日在隔一個交易日到。那不是運氣。**
// 懸崖在 3.0 → 3.5 倍之間：半倍的差距把三個月的追繳機率從 0% 推到 75%。
// 而 0/36 不等於 0%——三倍法則的上界約 8%／恐慌日（三個月約 30%），
// 所以上限訂在 **2.5 倍**才有真正的餘裕。
//
// 【為什麼要同時查絕對金額】倍數是比率，賺錢的時候分母會長，所以同一個倍數
// 對應的名目一直在變大——而「正在賺錢」剛好是他最容易加倉的時候。實測：
// 他 2026-09-23 到 10-05 把名目從 506 萬加到 1,055 萬（兩倍），
// 倍數只從 2.15x 走到 3.01x，因為獲利把權益養大了 57%。
// **倍數在最需要警告他的那一刻，最不會警告他。** 他自己的歷史也指到同一條線：
// 名目 >1,000 萬的 11 個樣本，之後 5 天淨資產 **0/11 為正**，平均 −51 萬；
// <600 萬的 5 個樣本 **5/5 為正**，平均 +52 萬。
//
// 平倉不擋——這條管的是加倉。
// ------------------------------------------------------------
function futNotionalBreaks(t) {
  const out = [];
  if (t.market !== 'futures') return out;
  const levRule = activeRule('fut_lev_cap');
  const absRule = activeRule('fut_notional_cap');
  if (!levRule && !absRule) return out;
  const add = tradeNotional(t) * (t.side === 'buy' ? 1 : -1);
  if (!(add > 0)) return out;
  const st = marginState();
  const after = num(st.notional) + add;
  const caps = [];
  if (levRule && isNum(levRule.amount) && num(st.equity) > 0)
    caps.push({ v: num(st.equity) * num(levRule.amount), kind: 'fut_lev_cap',
                why: `期貨權益 ${fmt(st.equity)} × ${fmtMax(levRule.amount, 2)} 倍` });
  if (absRule && isNum(absRule.amount))
    caps.push({ v: num(absRule.amount), kind: 'fut_notional_cap', why: '絕對上限' });
  if (!caps.length) return out;
  const tight = caps.reduce((a, b) => (b.v < a.v ? b : a));
  if (after > tight.v + 1e-9) {
    out.push({
      kind: tight.kind,
      // **不要只寫倍數。** 1,010 萬 / 1,000 萬四捨五入是「1.0 倍」，看起來像沒超過。
      text: `這筆之後期貨名目 ${fmt(after)} 元，超過上限 ${fmt(tight.v)} 元（${tight.why}），超出 ${fmt(after - tight.v)} 元`,
      why: '回測 36 個全市場恐慌日：名目/權益 3.0 倍時 36 次都沒被追繳，3.5 倍是 27.8%（三個月 75%），'
         + '4.0 倍是 36/36 全部被追繳。你 10/12 在 4.06 倍，恐慌日隔一個交易日就到——在那個位置沒有「剛好」這回事。'
         + '恐慌日平均每 2.9 週一次，所以這不是看得準不準的問題，是時間問題。',
    });
  }
  return out;
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
  // 期貨名目上限：2026-10-13 的恐慌日回測，懸崖在 3.0 → 3.5 倍
  out.push(...futNotionalBreaks(t));
  // 時間閘門：2026-09-29 之後，這兩條攔的是「連環決定」
  out.push(...gateBreaks(t));
  const wp = weekPauseBreak(t, Date.now());
  if (wp) out.push(wp);

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
  const po = putOnlyBreak(t);
  if (po) out.push(po);

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
  const lossDay = activeRule('no_open_after_loss');
  const cool = activeRule('cooldown_after_close');

  // 時間閘門的每日檢討：依時間重播，累加到那一筆之前的已實現損益。
  // **檢討只看得到已實現**：事後回頭算不出當時的帳面損益（沒有逐筆的盤中報價），
  // 所以這裡的門檻固定是「任何已實現虧損」，不用規則列的 amount
  //（amount 在即時檢查裡是未實現的門檻，用在這裡會變成兩種意思）。
  if ((lossDay || cool) && day.length) {
    const list = [...day].sort((a, b) => (String(a.created_at) < String(b.created_at) ? -1 : 1));
    let acc = 0, lastAt = null;
    const lossHits = [], coolHits = [];
    const mins = cool ? (isNum(cool.amount) && num(cool.amount) > 0 ? num(cool.amount) : 60) : 60;
    for (const t of list) {
      const open = isOpening(t);
      if (open && lossDay && dateISO >= lossDay.started_on && acc < -1e-6) lossHits.push({ t, acc });
      if (open && cool && dateISO >= cool.started_on && lastAt) {
        const gap = (Date.parse(t.created_at) - Date.parse(lastAt)) / 60000;
        if (gap >= 0 && gap < mins) coolHits.push({ t, gap });
      }
      if (isNum(t.realized_pl)) {
        acc += num(t.realized_pl) * (t.realized_ccy === 'USD' ? num(state.settings.usd_twd) : 1);
        lastAt = t.created_at;
      }
    }
    if (lossHits.length) {
      out.push({ kind: 'no_open_after_loss',
        text: `虧損之後又開新倉 ${lossHits.length} 筆`,
        detail: lossHits.map(({ t, acc: a }) => `${tradeLabel(t)}（當時已實現 ${fmt(a)}）`).join('、') });
    }
    if (coolHits.length) {
      out.push({ kind: 'cooldown_after_close',
        text: `平倉後不滿 ${fmt(mins)} 分鐘就開新倉 ${coolHits.length} 筆`,
        detail: coolHits.map(({ t, gap }) => `${tradeLabel(t)}（隔 ${fmt(gap)} 分鐘）`).join('、') });
    }
  }

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
  const putOnly = activeRule('opt_put_only');
  if (putOnly && dateISO >= putOnly.started_on) {
    const bad = day.filter((t) => t.market === 'option' && openingLots(t) > 1e-9 && !isBuyPut(t));
    if (bad.length) {
      out.push({ kind: 'opt_put_only',
        text: `不是買 put 的選擇權 ${bad.length} 筆，權利金合計 ${fmt(bad.reduce((a, t) => a + optPremium(t), 0))} 元`,
        detail: bad.map((t) => `${optAction(t)} ${fmt(t.quantity)} 口 @ ${fmtMax(t.price, 2)}`).join('、') });
    }
  }
  if (activeRule('week_loss_pause')) {
    // 用每一筆自己的時間去問「那一刻是不是在停止期」。
    // **有實現損益的就是平倉**：事後回頭看，部位已經不在了，isOpening 會把平倉誤認成開新倉
    //（觸發停損的那一筆本身就會被抓進來）。
    const bad = day.filter((t) => t.created_at && !isNum(t.realized_pl) && isOpening(t)
      && weekPause(Date.parse(t.created_at)));
    if (bad.length) {
      out.push({ kind: 'week_loss_pause',
        text: `當週停損的停止期內開新倉 ${bad.length} 筆`,
        detail: bad.map(tradeLabel).join('、') });
    }
  }
  return out;
}
