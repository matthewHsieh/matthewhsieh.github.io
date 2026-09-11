import { $, $$, esc, fmt, isNum, num, plClass, signed, state, todayISO } from '../core.js';
import { editJournal, editRule } from '../forms.js';
import { breaksOn } from '../rules.js';

// 從今天往回數，連續幾個交易日沒有違規（沒交易的日子不中斷也不計入）
function cleanStreak() {
  let n = 0;
  for (const d of state.journalDays) {
    if (num(d.trades) === 0) continue;
    if (breaksOn(d.d).length) break;
    n += 1;
  }
  return n;
}

export function renderJournal(el) {
  const today = todayISO();
  const days = state.journalDays;
  const todayRow = days.find((d) => d.d === today);
  const tb = breaksOn(today);
  const streak = cleanStreak();
  const brokenKinds = new Set(tb.map((x) => x.kind));
  const past = days.filter((d) => d.d !== today);

  el.innerHTML = `
    <div class="card">
      <div class="row-between">
        <span class="list-title">${esc(today)}</span>
        <span class="${plClass(num(todayRow?.realized))}">${signed(num(todayRow?.realized))}</span>
      </div>
      <div class="row-between sub muted">
        <span>${fmt(num(todayRow?.trades))} 筆交易・當沖 ${fmt(num(todayRow?.day_trades))} 筆</span>
        <span class="streak">${streak > 0 ? `連續 ${fmt(streak)} 個交易日沒違規` : '今天重新開始'}</span>
      </div>
      ${tb.length
        ? `<div class="breaks">${tb.map((x) => `<div class="break-item"><b>${esc(x.text)}</b>${
            x.detail ? `<br><span class="muted">${esc(x.detail)}</span>` : ''}</div>`).join('')}</div>`
        : '<p class="sub" style="margin-top:8px">今天沒有偵測到違規。</p>'}
      ${todayRow?.body ? `<div class="journal-body">${esc(todayRow.body)}</div>` : ''}
      <button type="button" class="primary block" data-journal="${esc(today)}">${
        todayRow?.body ? '編輯今天的心得' : '寫今天的心得'}</button>
    </div>

    <div class="card">
      <div class="row-between">
        <span class="list-title">我的規則</span>
        <button type="button" class="link" data-add-rule>＋ 新增</button>
      </div>
      ${state.rules.length
        ? state.rules.map((r) => `<div class="rule${brokenKinds.has(r.kind) ? ' broken' : ''}" data-rule="${esc(r.id)}">
            <div class="rule-title">${esc(r.title)}${
              brokenKinds.has(r.kind) ? '<span class="badge warn-badge">今天違反</span>' : ''}</div>
            ${r.detail ? `<div class="rule-detail">${esc(r.detail)}</div>` : ''}
            <div class="rule-since">自 ${esc(r.started_on)}　已經 ${
              fmt(Math.max(0, Math.round((Date.parse(today) - Date.parse(r.started_on)) / 86400000)))} 天</div>
          </div>`).join('')
        : '<p class="muted">還沒有規則。</p>'}
      <p class="hint">規則不會擋住你存檔，那是你的錢、你的帳。
        <b>系統跟券商的下單 App 沒有連線</b>，所以擋不到你下單，只能在你回來記錄時算給你看。
        像「選擇權只做避險」「當沖一次一檔」「單檔上限」這種，
        從記錄下來的資料就算得出來，會標「今天違反」並累計；
        而「不放空當天強勢股」這種要看盤中強弱的，事後無從判斷，只能當提醒靠自己記得。</p>
    </div>

    <div class="card">
      <div class="list-title">過去的日子</div>
      ${past.length
        ? past.map((d) => {
            const b = breaksOn(d.d);
            return `<div class="journal-day" data-journal="${esc(d.d)}">
              <div class="row-between">
                <span>${esc(d.d)}${b.length ? `<span class="badge warn-badge">${fmt(b.length)} 項違規</span>` : ''}${
                  d.followed ? '<span class="badge day-badge">守住</span>' : ''}</span>
                <span class="${plClass(num(d.realized))}">${signed(num(d.realized))}</span>
              </div>
              <div class="row-between sub muted">
                <span>${fmt(num(d.trades))} 筆・當沖 ${fmt(num(d.day_trades))}${
                  num(d.opt_pl) !== 0 ? `・選擇權 ${signed(num(d.opt_pl))}` : ''}</span>
                <span>${isNum(d.mood) ? `紀律 ${fmt(d.mood)}/5` : ''}</span>
              </div>
              ${d.body ? `<div class="journal-body">${esc(d.body)}</div>` : '<div class="sub muted">（沒寫）</div>'}
            </div>`;
          }).join('')
        : '<p class="muted">還沒有紀錄。每天寫一則，三個月後回頭看會很有用。</p>'}
    </div>`;

  $$('[data-journal]', el).forEach((b) => (b.onclick = () => editJournal(b.dataset.journal)));
  $$('[data-rule]', el).forEach((b) => (b.onclick = () =>
    editRule(state.rules.find((r) => r.id === b.dataset.rule))));
  const add = $('[data-add-rule]', el);
  if (add) add.onclick = (e) => { e.stopPropagation(); editRule(null); };
}
