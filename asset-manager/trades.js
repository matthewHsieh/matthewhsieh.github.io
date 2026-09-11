import { btrimEq, fail, fmtMax, isNum, norm, num, round2, sameSymbol, sb, state, sum, toast } from './core.js';
import { refresh } from './data.js';
import { OPT_SIZE, WAR_UNITS, fmtQty, futDisplayName } from './instruments.js';
import { checkRules, dayNet } from './rules.js';
import { TW_STOCKS, indexProduct, tradeKey } from './symbols.js';

// 只認明確勾選的當沖。
// 早期用「同一天同標的有買有賣」推斷，但那會把同一天的一般平倉也誤判成當沖，
// 例如當沖 1 口的同時又賣掉 5 口長期部位。
function dayTradeKeys(trades) {
  return new Set(trades.filter((t) => t.is_day_trade).map(tradeKey));
}

// ------------------------------------------------------------
// 交易成本
//   稅率是法定的，寫死在這裡（查證日期 2026-09-08）：
//     台股賣出 0.3%；當沖賣出 0.15%（已延長至 2027-12-31）
//     權證賣出 0.1%
//     股價類期貨（含台指期、個股期貨）契約金額 0.002%，買賣各一次
//     選擇權 權利金 0.1%，買賣各一次
//   手續費因人而異，放在「設定」可以改。
// ------------------------------------------------------------
const TAX = {
  stock: 0.003,
  stockDay: 0.0015,
  warrant: 0.001,
  futures: 0.00002,
  option: 0.001,
};

export const DEFAULT_FEES = {
  fee_stock_rate: 0.001425, fee_stock_disc: 0.3, fee_min: 20,
  fee_warrant_disc: 1,
  fee_fut_per_lot: 30,   // 期貨每口，買賣各收一次
  fee_opt_per_lot: 25,   // 選擇權每口，買賣各收一次
  fee_us_rate: 0.001, fee_us_min: 0,   // 複委託買賣各 0.1%
};

export const feeCfg = (k) => {
  const v = state.settings[k];
  return isNum(v) ? num(v) : DEFAULT_FEES[k];
};

// 回傳這一筆交易的手續費與交易稅（台幣；美股回傳美金，另有 ccy 標示）
export function tradeCost(t, isDay) {
  const qty = num(t.quantity), px = num(t.price);
  if (!(qty > 0) || !(px > 0)) return { fee: 0, tax: 0, total: 0, ccy: 'TWD' };

  if (t.market === 'tw') {
    const amount = qty * px;
    // 手續費折數是跟券商談的，不分當沖或波段
    const fee = Math.max(feeCfg('fee_min'), amount * feeCfg('fee_stock_rate') * feeCfg('fee_stock_disc'));
    // 當沖影響的只有政府的證交稅：減半
    const tax = t.side === 'sell' ? amount * (isDay ? TAX.stockDay : TAX.stock) : 0;
    return { fee, tax, total: fee + tax, ccy: 'TWD' };
  }
  if (t.market === 'warrant') {
    const amount = qty * WAR_UNITS * px;
    const fee = Math.max(feeCfg('fee_min'), amount * feeCfg('fee_stock_rate') * feeCfg('fee_warrant_disc'));
    const tax = t.side === 'sell' ? amount * TAX.warrant : 0;
    return { fee, tax, total: fee + tax, ccy: 'TWD' };
  }
  if (t.market === 'futures') {
    const notional = qty * px * num(t.fut_size);
    const fee = qty * feeCfg('fee_fut_per_lot');   // 每口每邊，買賣各收一次
    const tax = notional * TAX.futures;          // 買賣各課一次
    return { fee, tax, total: fee + tax, ccy: 'TWD' };
  }
  if (t.market === 'option') {
    const premium = qty * px * OPT_SIZE;
    const fee = qty * feeCfg('fee_opt_per_lot');   // 每口每邊，買賣各收一次
    const tax = premium * TAX.option;            // 買賣各課一次
    return { fee, tax, total: fee + tax, ccy: 'TWD' };
  }
  if (t.market === 'us') {
    const amount = qty * px;
    const rate = feeCfg('fee_us_rate');
    const fee = rate > 0 ? Math.max(feeCfg('fee_us_min'), amount * rate) : 0;
    return { fee, tax: 0, total: fee, ccy: 'USD' };
  }
  return { fee: 0, tax: 0, total: 0, ccy: 'TWD' };
}

// 成本換算成台幣
const costTwd = (t, isDay) => {
  const c = tradeCost(t, isDay);
  return c.total * (c.ccy === 'USD' ? num(state.settings.usd_twd) : 1);
};

// 已實現損益：美股用目前匯率換算成台幣
const realizedTwd = (t) =>
  isNum(t.realized_pl) ? num(t.realized_pl) * (t.realized_ccy === 'USD' ? num(state.settings.usd_twd) : 1) : null;

// 當沖用「先進先出」配對，一趟來回算一組。
// 不能把整天的買賣平均在一起：同一檔一天來回兩趟，一趟賺一趟賠，
// 平均後只看得到淨數，看不出哪一趟做錯。
// 每一組的損益掛在「平倉的那一筆」上。
const dayMult = (t) =>
  t.market === 'futures' ? num(t.fut_size)
  : t.market === 'option' ? OPT_SIZE
  : t.market === 'warrant' ? WAR_UNITS : 1;

function matchDayTrades(trades, extra) {
  const byKey = new Map();
  const push = (t) => {
    const k = tradeKey(t);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(t);
  };
  for (const t of trades) if (t.is_day_trade) push(t);
  if (extra) push(extra);

  const perTrade = new Map();   // trade.id -> 這一筆平掉的那一組
  const openLeft = new Map();   // key -> 還沒沖銷掉的數量
  for (const [k, list] of byKey) {
    // 用純字串比較，不要用 localeCompare：它會把符號排在數字前面
    list.sort((a, b) => {
      const x = String(a.created_at ?? '￿'), y = String(b.created_at ?? '￿');
      return x < y ? -1 : x > y ? 1 : 0;
    });
    const queue = [];           // 尚未沖銷的開倉腿，先進先出
    for (const t of list) {
      let left = num(t.quantity);
      const mult = dayMult(t);
      let pl = 0, matched = 0, basis = 0;
      while (left > 1e-9 && queue.length && queue[0].side !== t.side) {
        const head = queue[0];
        const take = Math.min(left, head.qty);
        const per = t.side === 'sell' ? num(t.price) - head.price : head.price - num(t.price);
        pl += per * take * mult;
        basis += head.price * take;
        matched += take;
        head.qty -= take;
        left -= take;
        if (head.qty <= 1e-9) queue.shift();
      }
      if (matched > 0) {
        perTrade.set(t.id ?? '__new__', {
          pl, qty: matched, openAvg: basis / matched,
          ccy: t.market === 'us' ? 'USD' : 'TWD',
        });
      }
      if (left > 1e-9) queue.push({ side: t.side, qty: left, price: num(t.price) });
    }
    openLeft.set(k, sum(queue, (x) => x.qty));
  }
  return { perTrade, openLeft };
}

// 一筆交易屬於哪一類。轉倉要獨立出來，因為它的「已實現損益」
// 只是把原本就存在的未實現損益入帳，不是今天做出來的績效。
// 實例：2026-09-10 台玻轉倉一筆就 -130,020，跟當天當沖 +34,500 混在一起看，
// 會誤以為當沖在虧錢，其實剛好相反。
export const tradeCategory = (t) =>
  String(t.note || '').startsWith('轉倉') ? 'roll'
    : t.is_day_trade ? 'day' : 'swing';

export const CAT_LABEL = { day: '當沖', swing: '波段', roll: '轉倉' };

// 一筆交易的淨損益（已扣手續費與交易稅）
export function tradeNet(t, rs) {
  const c = costTwd(t, !!t.is_day_trade);
  const m = t.is_day_trade ? rs.perTrade.get(t.id) : null;
  const r = m ? m.pl * (m.ccy === 'USD' ? num(state.settings.usd_twd) : 1) : realizedTwd(t);
  return { net: (r ?? 0) - c, cost: c, matched: m };
}

export function realizedSummary() {
  const { perTrade, openLeft } = matchDayTrades(state.trades);
  const byDate = new Map();
  const add = (d, v) => byDate.set(d, (byDate.get(d) || 0) + v);
  const twd = (v, ccy) => v * (ccy === 'USD' ? num(state.settings.usd_twd) : 1);
  let gross = 0, dayNet = 0, swingNet = 0, rollNet = 0, closes = 0, cost = 0;

  for (const t of state.trades) {
    // 損益：當沖看 FIFO 配對結果，其餘看當初存下來的值
    let v = null;
    if (t.is_day_trade) {
      const m = perTrade.get(t.id);
      if (m) v = twd(m.pl, m.ccy);
    } else {
      v = realizedTwd(t);
    }
    if (v !== null) {
      closes += 1; gross += v;
      const cat = tradeCategory(t);
      if (cat === 'day') dayNet += v; else if (cat === 'roll') rollNet += v; else swingNet += v;
      add(t.trade_date, v);
    }
    // 成本：每一筆都算，買進也有手續費
    const c = costTwd(t, !!t.is_day_trade);
    cost += c;
    add(t.trade_date, -c);
    const cc = tradeCategory(t);
    if (cc === 'day') dayNet -= c; else if (cc === 'roll') rollNet -= c; else swingNet -= c;
  }

  const dates = [...byDate.keys()].sort();
  let cum = 0;
  const series = dates.map((d) => { cum += byDate.get(d); return { date: d, daily: byDate.get(d), cum }; });
  return { gross, cost, total: gross - cost, day: dayNet, swing: swingNet, roll: rollNet, closes, series,
           dayKeys: dayTradeKeys(state.trades), perTrade, openLeft };
}

// ============================================================
// 交易 → 部位
// ============================================================
export const MARKET_LABEL = { tw: '台股', futures: '期貨', us: '複委託' };

// 表單上的四個選項 → 資料庫欄位
export const TRADE_KINDS = {
  tw:        { label: '台股',     market: 'tw' },
  fut_index: { label: '指數期貨', market: 'futures', fut_kind: 'index' },
  fut_stock: { label: '個股期貨', market: 'futures', fut_kind: 'stock' },
  option:    { label: '台指選擇權', market: 'option' },
  warrant:   { label: '權證',       market: 'warrant' },
  us:        { label: '複委託',   market: 'us' },
};

export const tradeKindOf = (t) =>
  t.market === 'futures' ? (t.fut_kind === 'stock' ? 'fut_stock' : 'fut_index') : t.market;

function findPosition(t) {
  if (t.market === 'warrant') return state.warrants.find((w) => norm(w.code) === norm(t.symbol));
  if (t.market === 'option') {
    return state.options.find((o) =>
      btrimEq(o.expiry, t.opt_expiry) && num(o.strike) === num(t.opt_strike) && o.cp === t.opt_cp);
  }
  if (t.market === 'tw') return state.stocks.find((s) => sameSymbol(s.symbol, t.symbol));
  if (t.market === 'us') return state.us.find((s) => sameSymbol(s.symbol, t.symbol));
  const kind = t.fut_kind || 'index';
  return state.futures.find(
    (f) => (f.kind || 'index') === kind && sameSymbol(f.symbol, t.symbol) &&
           (kind === 'index' || num(f.size) === num(t.fut_size)));
}

function newPositionRow(t) {
  if (t.market === 'warrant') return { code: norm(t.symbol), name: t.name || null, price: num(t.price) };
  if (t.market === 'option') {
    return { contract: 'TXO', expiry: String(t.opt_expiry).trim(), strike: num(t.opt_strike),
             cp: t.opt_cp, size: OPT_SIZE, price: num(t.price) };
  }
  if (t.market === 'futures') {
    const kind = t.fut_kind || 'index';
    const size = kind === 'stock' ? num(t.fut_size) || 2000 : indexProduct(t.symbol)?.size ?? 200;
    return { kind, symbol: kind === 'stock' ? norm(t.symbol) : norm(t.symbol), size,
             contract: futDisplayName(kind, t.symbol, size), price: num(t.price) };
  }
  if (t.market === 'us') return { symbol: norm(t.symbol), name: t.name || null, price_usd: num(t.price), cost_usd: null };
  return { symbol: norm(t.symbol), name: t.name || TW_STOCKS[norm(t.symbol)] || null, price: num(t.price), cost: null };
}

// 當沖：同一天的買與賣自己配對結算，完全不碰長期部位的股數與均價。
// 這是必要的，否則當沖一檔你本來就持有的股票，會把長期部位的均價拉歪，
// 已實現損益也會變成「賣價 − 混合後均價」而不是「賣價 − 當沖買價」。
function projectDayTrade(t) {
  const qty = num(t.quantity);
  if (!(qty > 0)) return { error: '數量必須大於 0' };
  // 把這一筆接在既有的當沖腿後面，用同一套先進先出邏輯試算
  const hypothetical = { ...t, id: '__new__', created_at: '￿' };   // 一定排在最後
  const { perTrade, openLeft } = matchDayTrades(state.trades, hypothetical);
  const m = perTrade.get('__new__');
  return {
    table: null, pos: null, after: null,          // 不動任何部位
    prevShares: null, prevCost: null,
    dayTrade: true,
    matched: m ? m.qty : 0,
    openAvg: m ? m.openAvg : null,
    openQty: openLeft.get(tradeKey(t)) ?? 0,
    realized: m ? m.pl : null,
    realizedCcy: t.market === 'us' ? 'USD' : 'TWD',
  };
}

// opts.reverse：刪除交易時反向調整，不動均價與現價
export function projectTrade(t, opts = {}) {
  if (t.is_day_trade && !opts.reverse) return projectDayTrade(t);
  const qty = num(t.quantity);
  if (!(qty > 0)) return { error: '數量必須大於 0' };
  if (t.market === 'option') {
    if (!String(t.opt_expiry ?? '').trim() || !(num(t.opt_strike) > 0)) {
      return { error: '請選擇到期與履約價' };
    }
  } else if (!String(t.symbol ?? '').trim()) {
    return { error: '請輸入代號或商品' };
  }
  const dir = t.side === 'buy' ? 1 : -1;
  const pos = findPosition(t);

  if (t.market === 'option') {
    const prevNet = pos ? (pos.side === 'short' ? -num(pos.lots) : num(pos.lots)) : 0;
    const net = prevNet + dir * qty;
    const base = pos || newPositionRow(t);
    const prevCost = pos && isNum(pos.cost) ? num(pos.cost) : null;

    let newCost = prevCost;
    if (!opts.reverse && net !== 0) {
      if (prevNet === 0 || Math.sign(net) !== Math.sign(prevNet)) newCost = num(t.price);
      else if (Math.abs(net) > Math.abs(prevNet)) {
        const basis = prevCost ?? num(base.price);
        newCost = (Math.abs(prevNet) * basis + qty * num(t.price)) / Math.abs(net);
      }
    }
    const after = net === 0
      ? null
      : { ...base, side: net > 0 ? 'long' : 'short', lots: Math.abs(net),
          price: opts.reverse ? num(base.price) : num(t.price),
          cost: opts.reverse ? prevCost : newCost };

    // 已實現：平掉的口數 ×（權利金價差）× 50，賣方方向相反
    let realized = null;
    if (!opts.reverse && prevNet !== 0 && Math.sign(dir) !== Math.sign(prevNet) && isNum(prevCost)) {
      const closed = Math.min(qty, Math.abs(prevNet));
      const perUnit = prevNet > 0 ? num(t.price) - prevCost : prevCost - num(t.price);
      realized = perUnit * closed * OPT_SIZE;
    }
    return { table: 'options', pos, prevShares: prevNet, prevCost, after, prevNet, net,
             newCost: net === 0 ? null : newCost, realized, realizedCcy: 'TWD' };
  }

  if (t.market === 'futures') {
    const prevNet = pos ? (pos.side === 'short' ? -num(pos.lots) : num(pos.lots)) : 0;
    const net = prevNet + dir * qty;
    const base = pos || newPositionRow(t);
    const prevCost = pos && isNum(pos.cost) ? num(pos.cost) : null;

    // 平均成本：開新倉或翻多空 → 用本次成交價；同方向加碼 → 加權平均；減碼 → 不變
    let newCost = prevCost;
    if (!opts.reverse && net !== 0) {
      if (prevNet === 0 || Math.sign(net) !== Math.sign(prevNet)) {
        newCost = num(t.price);
      } else if (Math.abs(net) > Math.abs(prevNet)) {
        const basis = prevCost ?? num(base.price);
        newCost = (Math.abs(prevNet) * basis + qty * num(t.price)) / Math.abs(net);
      }
    }
    const after = net === 0
      ? null
      : { ...base, side: net > 0 ? 'long' : 'short', lots: Math.abs(net),
          price: opts.reverse ? num(base.price) : num(t.price),
          cost: opts.reverse ? prevCost : newCost };

    // 已實現損益：這一筆平掉了多少口，就用平掉的部分乘上與成本的價差
    let realized = null;
    if (!opts.reverse && prevNet !== 0 && Math.sign(dir) !== Math.sign(prevNet) && isNum(prevCost)) {
      const closed = Math.min(qty, Math.abs(prevNet));
      const perUnit = prevNet > 0 ? num(t.price) - prevCost : prevCost - num(t.price);
      realized = perUnit * closed * num(base.size);
    }
    return { table: 'futures', pos, prevShares: prevNet, prevCost, after, prevNet, net,
             newCost: net === 0 ? null : newCost, realized, realizedCcy: 'TWD' };
  }

  const isWar = t.market === 'warrant';
  const isUs = t.market === 'us';
  const priceKey = isUs ? 'price_usd' : 'price';
  const costKey = isUs ? 'cost_usd' : 'cost';
  const sharesKey = isWar ? 'lots' : 'shares';
  const prevShares = pos ? num(pos[sharesKey]) : 0;
  const prevCost = pos && isNum(pos[costKey]) ? num(pos[costKey]) : null;
  const newShares = prevShares + dir * qty;
  if (newShares < -1e-9) return { error: `賣出 ${fmtQty(t.market, qty)} 超過目前持有 ${fmtQty(t.market, prevShares)}` };

  let newCost = prevCost;
  if (dir > 0 && !opts.reverse) {
    const basis = prevCost ?? (pos ? num(pos[priceKey]) : num(t.price));
    newCost = (prevShares * basis + qty * num(t.price)) / newShares;
  }
  const gone = newShares <= 1e-9;
  const base = pos || newPositionRow(t);
  const after = gone
    ? null
    : { ...base, [sharesKey]: newShares, [priceKey]: opts.reverse ? num(base[priceKey]) : num(t.price), [costKey]: newCost };
  if (after && !after.name && t.name) after.name = t.name;

  // 已實現損益：賣出的部分 ×（成交價 − 平均成本）
  let realized = null;
  if (!opts.reverse && dir < 0 && prevShares > 0 && isNum(prevCost)) {
    realized = (num(t.price) - prevCost) * Math.min(qty, prevShares);
  }
  if (isWar && isNum(realized)) realized *= WAR_UNITS;   // 權證以「張」記，一張 1000 單位
  return { table: isWar ? 'warrants' : isUs ? 'us_stocks' : 'stocks',
           pos, prevShares, prevCost, after, newShares,
           newCost: gone ? null : newCost, realized, realizedCcy: isUs ? 'USD' : 'TWD' };
}

function restoreProjection(t) {
  const pos = findPosition(t);
  const prev = num(t.prev_shares);
  if (t.market === 'option') {
    const after = prev === 0
      ? null
      : { ...(pos || newPositionRow(t)), side: prev > 0 ? 'long' : 'short', lots: Math.abs(prev),
          cost: isNum(t.prev_cost) ? num(t.prev_cost) : null };
    return { table: 'options', pos, after };
  }
  if (t.market === 'futures') {
    const after = prev === 0
      ? null
      : { ...(pos || newPositionRow(t)), side: prev > 0 ? 'long' : 'short', lots: Math.abs(prev),
          cost: isNum(t.prev_cost) ? num(t.prev_cost) : null };
    return { table: 'futures', pos, after };
  }
  const isWar = t.market === 'warrant';
  const isUs = t.market === 'us';
  const costKey = isUs ? 'cost_usd' : 'cost';
  const sharesKey = isWar ? 'lots' : 'shares';
  const after = prev <= 1e-9
    ? null
    : { ...(pos || newPositionRow(t)), [sharesKey]: prev, [costKey]: isNum(t.prev_cost) ? num(t.prev_cost) : null };
  return { table: isWar ? 'warrants' : isUs ? 'us_stocks' : 'stocks', pos, after };
}

// 只有真的有變動才寫入；賣光才刪除
function changed(pos, after) {
  if (!pos) return true;
  return Object.keys(after).some((k) => {
    if (['id', 'user_id', 'created_at', 'updated_at'].includes(k)) return false;
    const a = after[k], b = pos[k];
    if (a === null || a === undefined) return !(b === null || b === undefined);
    if (typeof a === 'number' || (isNum(a) && isNum(b))) return Math.abs(num(a) - num(b)) > 1e-9;
    return String(a) !== String(b ?? '');
  });
}

async function writePosition({ table, pos, after }) {
  if (!table) return false;          // 當沖不動任何部位
  if (after) {
    if (!changed(pos, after)) return false;
    const payload = { ...after, user_id: state.user.id };
    if (pos) payload.id = pos.id;
    delete payload.created_at;
    delete payload.updated_at;
    const { error } = await sb.from(table).upsert(payload);
    if (error) throw error;
    return true;
  }
  if (pos) {
    const { error } = await sb.from(table).delete().eq('id', pos.id);
    if (error) throw error;
    return true;
  }
  return false;
}

export async function saveTrade(v) {
  const proj = projectTrade(v);
  if (proj.error) return toast(proj.error, 3500);

  // 破戒前先讓你停一秒。不阻止，只是要你自己按下去。
  const breaks = checkRules(v);
  if (breaks.length) {
    const NL = String.fromCharCode(10);
    const msg = breaks.map((x, i) => `${i + 1}. ${x.text}${NL}   ${x.why}`).join(NL + NL);
    if (!confirm(`這筆會違反你自己定的規則：${NL}${NL}${msg}${NL}${NL}還是要記錄嗎？`)) return;
  }

  try {
    await writePosition(proj);
    const { error } = await sb.from('trades').insert({
      user_id: state.user.id,
      market: v.market, fut_kind: v.fut_kind ?? null, fut_size: v.fut_size ?? null,
      opt_expiry: v.opt_expiry ?? null, opt_strike: v.opt_strike ?? null, opt_cp: v.opt_cp ?? null,
      war_code: v.market === 'warrant' ? v.symbol : null,
      is_day_trade: !!v.is_day_trade,
      side: v.side, trade_date: v.trade_date, symbol: v.symbol, name: v.name,
      quantity: v.quantity, price: v.price, note: v.note,
      prev_shares: proj.prevShares, prev_cost: proj.prevCost,
      realized_pl: isNum(proj.realized) ? round2(proj.realized) : null,
      realized_ccy: isNum(proj.realized) ? proj.realizedCcy : null,
    });
    if (error) throw error;
    if (breaks.length) {
      // 留下證據，心得頁才算得出守規天數
      await sb.from('rule_breaks').insert(breaks.map((x) => ({
        user_id: state.user.id, break_date: v.trade_date, kind: x.kind, detail: x.text,
      })));
    }
    await refresh(breaks.length ? '已記錄，但違反了 ' + breaks.length + ' 條規則' : '交易已記錄，部位已更新');
  } catch (e) {
    fail(e);
  }
}

const tradeLabel = (t) =>
  `${t.trade_date} ${t.side === 'buy' ? '買' : '賣'} ${t.symbol} ${t.name || ''} ${fmtQty(t.market, t.quantity)} @ ${fmtMax(t.price, 2)}`;

export async function deleteTrade(id) {
  const t = state.trades.find((x) => x.id === id);
  if (!t) return;
  if (!confirm(`刪除這筆交易並還原部位？\n${tradeLabel(t)}`)) return;
  if (t.is_day_trade) {
    const { error } = await sb.from('trades').delete().eq('id', id);
    if (error) return fail(error);
    return refresh('已刪除當沖紀錄');
  }
  const latest = state.trades.find((x) => {
    if (x.market !== t.market) return false;
    if (t.market === 'option') {
      return btrimEq(x.opt_expiry, t.opt_expiry) && num(x.opt_strike) === num(t.opt_strike) && x.opt_cp === t.opt_cp;
    }
    if (!sameSymbol(x.symbol, t.symbol)) return false;
    return t.market !== 'futures' || (x.fut_kind === t.fut_kind && num(x.fut_size) === num(t.fut_size));
  });
  const proj = latest?.id === t.id
    ? restoreProjection(t)
    : projectTrade({ ...t, side: t.side === 'buy' ? 'sell' : 'buy' }, { reverse: true });
  if (proj.error) return toast('無法還原：' + proj.error, 3500);
  try {
    await writePosition(proj);
    const { error } = await sb.from('trades').delete().eq('id', id);
    if (error) throw error;
    await refresh('已刪除交易並還原部位');
  } catch (e) {
    fail(e);
  }
}
