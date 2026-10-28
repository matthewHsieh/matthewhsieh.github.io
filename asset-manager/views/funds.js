import { esc, fmt, isNum, num, plClass, signed, state, todayISO } from '../core.js';
import { compute } from '../portfolio.js';
import { bindListActions, itemRow, section, stat } from '../widgets.js';

// ------------------------------------------------------------
// 金流（2026-10-28）
//   淨資產回到 0 靠的是薪水加時間，不是交易。所以這一頁最上面放的是
//   「照現在的收支，哪一天回到 0」，而不是今天賺賠多少。
//
//   算法是逐月模擬，不是一條公式，因為獎金集中在 1 月、端午、中秋，
//   旅遊目標在某個月一次花掉，平均攤提會把「什麼時候」算錯：
//     投資 ← 投資 ×（1 + 年報酬/12）＋ 定期定額
//     現金 ← 現金 ＋ 收入 − 支出 − 還款 − 定期定額 ＋ 當月獎金 − 當月到期的目標
//     信貸餘額 ← 餘額 −（月付 − 利息）
//     淨資產 = 投資 ＋ 現金 − 負債
//   **報酬只算在投資部位上**（現股、複委託、期貨權益、選擇權、權證），現金不生報酬。
//   第一版把報酬乘在全部資產上、旅遊只扣一次，算出 2.3 年——太樂觀，使用者一眼就看出來。
//   目標（旅遊）是消費，到期那個月整筆扣掉；per = 'year' 的目標從到期日起每年同一個月再扣一次。
// ------------------------------------------------------------
const toTwd = (it, rate) => num(it.amount) * (it.currency === 'USD' ? rate : 1);
const monthly = (it, rate) => toTwd(it, rate) / (it.per === 'year' ? 12 : 1);
const ym = (d) => d.toISOString().slice(0, 7);

// 固定還款連到同名的負債（「信貸」對「信貸」），才知道餘額與利息
function debtState(it) {
  const bal = state.balances.find((b) => b.kind === 'liability' && b.name === it.name);
  const balance = bal ? num(bal.amount) : null;
  const interest = isNum(it.rate) && balance !== null ? balance * num(it.rate) / 100 / 12 : null;
  return { balance, interest };
}

// 目標在這個月要不要扣：到期那個月；per = 'year' 的之後每年同一個月再扣
function goalHits(g, d) {
  const due = String(g.due_date).slice(0, 7);
  const cur = ym(d);
  if (g.per === 'year') return cur >= due && cur.slice(5) === due.slice(5);
  return cur === due;
}

function project(c, items, annual) {
  const rate = c.rate;
  const by = (k) => items.filter((i) => i.kind === k);
  const income = by('income').reduce((a, i) => a + monthly(i, rate), 0);
  const spend = by('expense').reduce((a, i) => a + monthly(i, rate), 0);
  const debts = by('debt').map((i) => ({ pay: monthly(i, rate), ...debtState(i) }));
  const bonus = by('bonus');
  const goals = by('goal').filter((g) => g.due_date);

  const invest = by('invest').reduce((a, i) => a + monthly(i, rate), 0);
  let inv = num(c.stockValue) + num(c.usValue) + num(c.futEquity) + num(c.optMarket) + num(c.warMarket);
  let cash = num(c.cash);
  let other = num(c.liabilities) - debts.reduce((a, d) => a + num(d.balance), 0);   // 不會動的負債（家人借款）
  const bal = debts.map((d) => num(d.balance));
  const start = new Date(`${todayISO().slice(0, 7)}-01T00:00:00Z`);
  for (let m = 1; m <= 360; m++) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + m, 1));
    inv = inv * (1 + annual / 12) + invest;
    cash += income - spend - invest;
    debts.forEach((x, k) => {
      if (bal[k] <= 0) return;
      const intr = isNum(x.interest) && x.balance > 0 ? bal[k] * (x.interest / x.balance) : 0;
      const pay = Math.min(x.pay, bal[k] + intr);
      cash -= pay; bal[k] -= pay - intr;
    });
    for (const b of bonus) if (num(b.month) === d.getUTCMonth() + 1) cash += toTwd(b, rate);
    for (const g of goals) if (goalHits(g, d)) cash -= toTwd(g, rate);
    if (inv + cash - other - bal.reduce((a, x) => a + Math.max(0, x), 0) >= 0) return { months: m, at: ym(d) };
  }
  return null;
}

function flowCard(c) {
  const rate = c.rate;
  const items = state.cashItems;
  const by = (k) => items.filter((i) => i.kind === k);
  const row = (it, right2 = '') => itemRow('cashitem', it.id, esc(it.name),
    esc([it.per === 'year' ? `每年 ${fmt(it.amount, it.currency === 'USD' ? 2 : 0)} ${it.currency}` : '',
         it.currency === 'USD' && it.per !== 'year' ? `${fmt(it.amount, 2)} USD` : '', it.note || ''].filter(Boolean).join('・')),
    fmt(monthly(it, rate)), right2);

  const income = by('income').reduce((a, i) => a + monthly(i, rate), 0);
  const spend = by('expense').reduce((a, i) => a + monthly(i, rate), 0);
  const debt = by('debt').reduce((a, i) => a + monthly(i, rate), 0);
  const invest = by('invest').reduce((a, i) => a + monthly(i, rate), 0);
  const left = income - spend - debt - invest;

  const rows = [
    ...by('income').map((i) => row(i)),
    ...by('expense').map((i) => row(i)),
    ...by('debt').map((i) => {
      const { balance, interest } = debtState(i);
      return row(i, balance === null ? '' : `餘額 ${fmt(balance)}${isNum(interest) ? `・利息約 ${fmt(interest)}` : ''}`);
    }),
    ...by('invest').map((i) => row(i)),
  ];
  const footer = `收入 ${fmt(income)} − 支出 ${fmt(spend)} − 還款 ${fmt(debt)} − 投入 ${fmt(invest)} = <b class="${plClass(left)}">結餘 ${signed(left)}</b>`;
  return section('每月金流（5 號發薪）', 'cashitem', rows, footer, { kind: 'expense' });
}

function bonusCard(c) {
  const list = state.cashItems.filter((i) => i.kind === 'bonus').sort((a, b) => num(a.month) - num(b.month));
  const rows = list.map((b) => itemRow('cashitem', b.id, esc(b.name), esc(b.note || ''),
    fmt(toTwd(b, c.rate)), isNum(b.month) ? `${fmt(b.month)} 月` : ''));
  const total = list.reduce((a, b) => a + toTwd(b, c.rate), 0);
  return section('獎金', 'cashitem', rows, `一年合計約 ${fmt(total)}`, { kind: 'bonus' });
}

function goalCard(c) {
  const today = todayISO();
  const rows = state.cashItems.filter((i) => i.kind === 'goal').map((g) => {
    const target = toTwd(g, c.rate), saved = num(g.saved);
    const left = Math.max(0, target - saved);
    const due = g.due_date ? String(g.due_date) : null;
    const months = due ? Math.max(1, Math.round((Date.parse(due) - Date.parse(today)) / (30.44 * 864e5))) : null;
    const p = target > 0 ? Math.min(1, saved / target) : 0;
    return itemRow('cashitem', g.id, esc(g.name),
      `${due ? `${esc(due)}${g.per === 'year' ? '起每年' : ''}・還有 ${fmt(months)} 個月` : '沒有日期'}${left > 0 && months ? `・每月要存 ${fmt(left / months)}` : ''}
       <div class="bar" style="margin-top:6px"><div class="bar-fill" style="width:${(p * 100).toFixed(1)}%"></div></div>`,
      `${fmt(saved)} / ${fmt(target)}`, `${(p * 100).toFixed(0)}%`);
  });
  return section('存錢目標（不放股市）', 'cashitem', rows,
    '一年內要花的錢不放股市：碰到下跌時才不會被逼著在最低點賣。', { kind: 'goal' });
}

function zeroCard(c) {
  const nw = num(c.netAssets);
  if (nw >= 0) return `<div class="card"><div class="list-title">淨資產</div><div class="stat"><div class="value gain">${fmt(nw)}</div></div></div>`;
  const items = state.cashItems;
  if (!items.some((i) => i.kind === 'income')) {
    return `<div class="card"><div class="list-title">淨資產回到 0</div><p class="muted">先在下面「每月金流」登記收入與支出，這裡才算得出來。</p></div>`;
  }
  const cases = [[0, '不算投資報酬'], [0.08, '投資年報酬 8%'], [0.15, '投資年報酬 15%']].map(([r, label]) => {
    const p = project(c, items, r);
    return `<div class="row-between line"><span>${label}</span><span>${
      p ? `<b>${esc(p.at)}</b>　<span class="muted">約 ${(p.months / 12).toFixed(1)} 年</span>` : '30 年內到不了'}</span></div>`;
  }).join('');

  // 上一次記帳以來的變化
  const last = state.cashMonths.find((m) => isNum(m.net_assets));
  const since = last ? nw - num(last.net_assets) : null;
  return `<div class="card">
    <div class="list-title" role="heading" aria-level="2">淨資產回到 0</div>
    <div class="row-between"><span class="value loss" style="font-size:var(--fs-xl, 1.6em);font-weight:700">${fmt(nw)}</span>
      ${since !== null ? `<span class="${plClass(since)}">比 ${esc(String(last.month).slice(0, 7))} ${signed(since)}</span>` : ''}</div>
    ${cases}
    <p class="hint">逐月模擬：薪水、獎金在發放的月份入帳，旅遊目標在到期那個月整筆花掉（設成每年的會每年扣），
      信貸照月付還本金（填了年利率才扣利息）。報酬只算在投資部位，現金不生報酬。
      家人借款不計利息、也不假設會還（還了只是資產負債一起減，淨資產不變）。
      沒有列進「每月金流」的花費（紅包、保險、稅、醫療）都不在裡面，所以這是偏樂觀的上限。</p>
  </div>`;
}

function monthCard(c) {
  const thisMonth = `${todayISO().slice(0, 7)}-01`;
  const cur = state.cashMonths.find((m) => String(m.month) === thisMonth);
  const list = state.cashMonths;
  const rows = list.map((m, i) => {
    const prev = list[i + 1];
    const d = prev && isNum(m.net_assets) && isNum(prev.net_assets) ? num(m.net_assets) - num(prev.net_assets) : null;
    return itemRow('cashmonth', m.id, esc(String(m.month).slice(0, 7)),
      esc([num(m.overspend) > 0 ? `超支 ${fmt(m.overspend)}` : '沒超支', m.note || ''].filter(Boolean).join('・')),
      isNum(m.net_assets) ? fmt(m.net_assets) : '–', d !== null ? `<span class="${plClass(d)}">${signed(d)}</span>` : '');
  });
  const defaults = { month: thisMonth, net_assets: Math.round(num(c.netAssets)), overspend: 0 };
  return `<div class="card list">
    <div class="row-between">
      <span class="list-title" role="heading" aria-level="2">每月記帳</span>
      ${cur ? '<span class="badge day-badge">這個月記過了</span>'
            : `<button type="button" class="small" data-add="cashmonth" data-defaults="${esc(JSON.stringify(defaults))}">＋ 記這個月</button>`}
    </div>
    ${rows.length ? rows.join('') : '<p class="muted">每月 5 號發薪日記一次：淨資產、有沒有超支、一句話。15 分鐘就好。</p>'}
  </div>`;
}

export function renderFunds(el) {
  const c = compute();
  const money = (b) => {
    const usd = b.currency === 'USD';
    return itemRow('balance', b.id, esc(b.name), esc(b.note || ''),
      `${fmt(b.amount, usd ? 2 : 0)} ${b.currency}`, usd ? `≈ ${fmt(num(b.amount) * c.rate)}` : '');
  };
  const cashRows = state.balances.filter((b) => b.kind === 'cash').map(money);
  const equityRows = state.balances.filter((b) => b.kind === 'futures_equity').map(money);
  const debtRows = state.balances.filter((b) => b.kind === 'liability').map(money);

  el.innerHTML =
    zeroCard(c) + flowCard(c) + bonusCard(c) + goalCard(c) + monthCard(c) +
    section('現金 / 存款', 'balance', cashRows, `合計 ${fmt(c.cash)}`, { kind: 'cash' }) +
    section('期貨帳戶權益數', 'balance', equityRows, `合計 ${fmt(c.futEquity)}`, { kind: 'futures_equity', name: '期貨帳戶' }) +
    section('負債', 'balance', debtRows, `合計 ${fmt(c.liabilities)}`, { kind: 'liability' }) +
    `<div class="grid2">${stat('總資產', fmt(c.totalAssets))}${stat('淨資產', fmt(c.netAssets))}</div>
    <p class="hint">負債例如：信貸、股票質押借款、融資。美金項目以匯率 ${fmt(c.rate, 3)} 換算（每日自動更新）。</p>`;
  bindListActions(el);
}
