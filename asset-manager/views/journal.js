import { $, $$, esc, fmt, isNum, num, plClass, signed, state, todayISO } from '../core.js';
import { editJournal, editRule } from '../forms.js';
import { loadSeries } from '../risk.js';
import { breaksOn, listExposure, offListCap, offListPicks } from '../rules.js';

// ------------------------------------------------------------
// 名單外自選記分板（2026-10-30）
//   換股法的名單是回測過的；名單外的是他自己的判斷。判斷能不能放大，
//   要看它 20 個交易日後有沒有贏大盤，而不是看當下的感覺。
//   用他過去的交易分析過：他「挑什麼」在兩個獨立樣本裡都是正的，
//   但用時間聚類的信賴區間就不顯著。這張表就是要把那個「可能有」變成「有」或「沒有」。
//   報酬從**買進當天收盤**算起（risk_stats 是收盤的對數報酬），減掉同一段的加權指數。
// ------------------------------------------------------------
const SCORE_DAYS = 20;
const SCORE_MIN_N = 30;

function scorePick(p, series) {
  const s = series.get(p.key), ix = series.get('TAIEX');
  if (!s?.days?.length || !ix?.days?.length) return null;
  const d0 = Math.round(Date.parse(`${p.date}T00:00:00Z`) / 864e5);
  const im = new Map(ix.days.map((d, i) => [d, ix.rets[i]]));
  let rs = 0, ri = 0, n = 0;
  for (let i = 0; i < s.days.length && n < SCORE_DAYS; i += 1) {
    if (s.days[i] <= d0) continue;
    rs += num(s.rets[i]); ri += num(im.get(s.days[i])); n += 1;
  }
  return { n, stock: Math.exp(rs) - 1, idx: Math.exp(ri) - 1, excess: Math.exp(rs) - Math.exp(ri) };
}

// 純計算，跟畫面分開（測試直接呼叫這一支）
export function scoreSummary(picks, series) {
  const rows = picks.map((p) => ({ p, s: scorePick(p, series) }));
  const done = rows.filter((r) => r.s && r.s.n >= SCORE_DAYS);
  const avg = done.length ? done.reduce((a, r) => a + r.s.excess, 0) / done.length : null;
  const hit = done.length ? done.filter((r) => r.s.excess > 0).length / done.length : null;
  return { rows, done, avg, hit };
}

async function fillScores(el) {
  const box = $('#offlist-scores', el);
  if (!box) return;
  const picks = offListPicks();
  if (!picks.length) {
    box.innerHTML = '<p class="muted">還沒有名單外的買進。每一筆名單外、留過夜的買進都會記在這裡。</p>';
    return;
  }
  let series;
  try { series = await loadSeries([...new Set(picks.map((p) => p.key))]); }
  catch { box.innerHTML = '<p class="muted">報酬資料載入失敗，重新整理再試一次。</p>'; return; }
  const { rows, done, avg, hit } = scoreSummary(picks, series);
  const pc = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
  box.innerHTML = `
    <div class="grid3">
      <div class="stat"><div class="label">滿 ${SCORE_DAYS} 天的筆數</div><div class="value">${fmt(done.length)} / ${SCORE_MIN_N}</div></div>
      <div class="stat"><div class="label">平均贏大盤</div><div class="value ${avg === null ? '' : plClass(avg)}">${avg === null ? '–' : pc(avg)}</div></div>
      <div class="stat"><div class="label">贏的比例</div><div class="value">${hit === null ? '–' : `${fmt(hit * 100)}%`}</div></div>
    </div>
    ${rows.map(({ p, s }) => `<div class="row-between line">
      <span>${esc(p.date)} ${esc(p.label)}<br><span class="sub muted">${
        s ? (s.n >= SCORE_DAYS ? `${SCORE_DAYS} 天：股票 ${pc(s.stock)}、加權 ${pc(s.idx)}` : `第 ${fmt(s.n)}/${SCORE_DAYS} 天：股票 ${pc(s.stock)}、加權 ${pc(s.idx)}`)
          : '這一檔沒有報酬資料'}</span></span>
      <span class="${s ? plClass(s.excess) : ''}">${s ? pc(s.excess) : '–'}</span></div>`).join('')}
    <p class="hint">報酬從買進當天的收盤算起，減掉同一段時間的加權指數。滿 ${SCORE_MIN_N} 筆、平均是正的，
      才算證明你的判斷有用，那時候再談放大名單外的額度。當天就賣掉的、家人委託的、美股不算。</p>`;
}

function offListLine() {
  const le = listExposure();
  const cap = offListCap();
  if (!le || cap === null) return '';
  const offs = le.rows.filter((r) => r.where === 'off').sort((a, b) => b.v - a.v);
  const over = le.share > cap + 1e-9;
  return `<div class="row-between line"><span>名單外部位（${esc(le.rot.period)} 那一期）<br><span class="sub muted">${
    offs.length ? offs.map((r) => `${esc(r.label)}${r.est ? '（估計）' : ''}`).join('、') : '沒有'}</span></span>
    <span class="${over ? 'loss' : ''}"><b>${(le.share * 100).toFixed(1)}%</b> / ${(cap * 100).toFixed(0)}%</span></div>`;
}

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
        <span class="list-title" role="heading" aria-level="2">${esc(today)}</span>
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
        <span class="list-title" role="heading" aria-level="2">我的規則</span>
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
      ${offListLine()}
      <p class="hint">規則不會擋住你存檔，那是你的錢、你的帳。
        <b>系統跟券商的下單 App 沒有連線</b>，所以擋不到你下單，只能在你回來記錄時算給你看。
        像「選擇權只做避險」「當沖一次一檔」「單檔上限」這種，
        從記錄下來的資料就算得出來，會標「今天違反」並累計；
        而「不放空當天強勢股」這種要看盤中強弱的，事後無從判斷，只能當提醒靠自己記得。</p>
    </div>

    ${offListCap() !== null ? `<div class="card">
      <div class="list-title" role="heading" aria-level="2">名單外自選記分板</div>
      <div id="offlist-scores"><p class="muted">計算中…</p></div>
    </div>` : ''}

    <div class="card">
      <div class="list-title" role="heading" aria-level="2">過去的日子</div>
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
  fillScores(el);
}
