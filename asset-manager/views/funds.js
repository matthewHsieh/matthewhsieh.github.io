import { esc, fmt, num, state } from '../core.js';
import { compute } from '../portfolio.js';
import { bindListActions, itemRow, section, stat } from '../widgets.js';

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
    section('現金 / 存款', 'balance', cashRows, `合計 ${fmt(c.cash)}`, { kind: 'cash' }) +
    section('期貨帳戶權益數', 'balance', equityRows, `合計 ${fmt(c.futEquity)}`, { kind: 'futures_equity', name: '期貨帳戶' }) +
    section('負債', 'balance', debtRows, `合計 ${fmt(c.liabilities)}`, { kind: 'liability' }) +
    `<div class="grid2">${stat('總資產', fmt(c.totalAssets))}${stat('淨資產', fmt(c.netAssets))}</div>
    <p class="hint">負債例如：信貸、股票質押借款、融資。美金項目以匯率 ${fmt(c.rate, 3)} 換算（每日自動更新）。</p>`;
  bindListActions(el);
}
