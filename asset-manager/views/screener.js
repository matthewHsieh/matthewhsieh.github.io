import { ALERT_LABEL } from '../alerts.js';
import { $, $$, esc, fmt, fmtMax, isNum, norm, num, plClass, sb, signed, state, toast } from '../core.js';
import { heldSymbols, idxRatio, usIdxRatio } from '../portfolio.js';
import { bindStockOpen } from './stock.js';

// ------------------------------------------------------------
// 選股
//   他自己講過策略：「不能做動能，現在適合反市場，在下跌中買入好公司，
//   拉起來回檔後加碼」。那句話拆開就是三個條件：
//     好公司  = 報酬/波動贏得過大盤（不然不如直接開槓桿買指數）
//     在下跌 = 離三年高點夠遠
//     不是地雷 = 有人在報、而且沒被交易所盯上
//   這頁就是把那三件事變成可以按的東西。
//
//   **池子是全市場**：台股約 1,970 檔（所有有公告月營收的普通股），
//   美股約 2,000 檔（日成交額 2,000 萬美元以上，進得去也出得來的）。
//   四千列不可能每次登入都載下來，所以篩選與排序都在資料庫做，
//   一次只回前 60 檔。代價是拉桿要等一次往返，所以要防連點。
// ------------------------------------------------------------

const SCREEN_DEFAULT = {
  beat: true,        // 報酬/波動要贏過大盤
  covered: false,    // 至少三位分析師
  clean: true,       // 排除處置與注意股
  drop: 20,          // 至少從三年高點跌下來幾 %
  peMax: 0,          // 本益比上限，0 = 不限
  growth: null,      // 營收年增下限
  q: '',             // 關鍵字（代號／名稱／族群／產業別／主要經營業務）
  sort: 'drop',
};

const SCREEN_SORT = [
  ['drop', '跌最多'],
  ['ratio', '報酬/波動'],
  ['pe', '本益比'],
  ['growth', '營收成長'],
];

let screenSeq = 0;   // 連點時只認最後一次的結果

async function runScreen(mk, f) {
  const { data, error } = await sb.rpc('screen_stocks', {
    p_market: mk,
    p_beat: !!f.beat,
    p_covered: !!f.covered,
    p_clean: !!f.clean,
    p_drop: num(f.drop),
    p_pe_max: num(f.peMax),
    p_growth: isNum(f.growth) && f.growth !== '' ? num(f.growth) : null,
    p_q: (f.q || '').trim() || null,
    p_sort: f.sort,
    p_limit: 60,
  });
  if (error) throw error;
  return data ?? [];
}

export function renderScreener(host, mk) {
  const f = { ...SCREEN_DEFAULT, ...(state.screen || {}) };
  state.screen = f;
  const held = mk === 'us' ? new Set(state.us.map((s) => norm(s.symbol))) : heldSymbols();
  const bench = mk === 'us' ? usIdxRatio() : idxRatio();
  const rows = state.screenRows || [];
  const total = rows.length ? num(rows[0].total) : 0;

  const chk = (k, label, hint) => `<label class="screen-chk">
    <input type="checkbox" data-sc="${k}" ${f[k] ? 'checked' : ''}>
    <span>${label}${hint ? `<span class="sub muted">　${hint}</span>` : ''}</span></label>`;

  // 條件面板預設收起來。**原本展開時第一筆結果落在 969px、手機視窗只有 844px**，
  // 等於每次進來都要先捲過整個表單才看得到任何一檔。收起來之後條件變成一行摘要，
  // 要改再點開。搜尋框留在外面，因為那是最常用的。
  const open = !!state.screenOpen;
  const summary = [
    f.beat ? `贏過${mk === 'us' ? 'NDX' : '大盤'}` : null,
    num(f.drop) > 0 ? `跌${fmt(f.drop)}%以上` : null,
    f.covered ? '有分析師' : null,
    mk === 'tw' && f.clean ? '排除警示' : null,
    num(f.peMax) > 0 ? `本益比≤${fmt(f.peMax)}` : null,
    isNum(f.growth) && f.growth !== null && f.growth !== '' ? `成長≥${fmt(f.growth)}%` : null,
  ].filter(Boolean);

  host.innerHTML = `
    <div class="card">
      <div class="row-between">
        <span class="list-title">選股<span class="muted sub">　${mk === 'us' ? '美股' : '台股'}全市場</span></span>
        <span class="sub muted" data-screen-count>${state.screenBusy ? '篩選中…'
          : `${fmt(total)} 檔符合${total > rows.length ? `，顯示前 ${fmt(rows.length)} 檔` : ''}`}</span>
      </div>
      <label class="screen-q">
        <input type="search" data-sc-q value="${esc(f.q || '')}" enterkeyhint="search"
          placeholder="${mk === 'us' ? '搜尋代號、名稱、族群、產業、業務' : '搜尋代號、名稱、族群、主要經營業務'}">
      </label>
      <button type="button" class="screen-toggle" data-sc-open aria-expanded="${open}">
        <span>${summary.length ? esc(summary.join('・')) : '沒有設任何條件'}</span>
        <span class="chev">${open ? '收起' : '改條件'}</span>
      </button>
      <div class="screen-form" ${open ? '' : 'hidden'}>
        ${chk('beat', `報酬/波動贏過${mk === 'us' ? '那斯達克 100' : '加權指數'}`,
              isNum(bench) ? `>${fmtMax(bench, 2)}` : '')}
        ${chk('covered', '至少三位分析師', '避開沒人看的')}
        ${mk === 'tw' ? chk('clean', '排除處置與注意股', '進去會卡住') : ''}
        <div class="screen-nums">
          <label>離高點跌<input type="number" data-sc-n="drop" value="${esc(f.drop)}"
            min="0" max="90" step="5" inputmode="decimal"><span>%</span></label>
          <label>本益比≤<input type="number" data-sc-n="peMax" value="${esc(f.peMax)}"
            min="0" step="5" inputmode="decimal" placeholder="不限"><span>x</span></label>
          <label>成長≥<input type="number" data-sc-n="growth"
            value="${f.growth === null ? '' : esc(f.growth)}" step="10" inputmode="decimal"
            placeholder="不限"><span>%</span></label>
        </div>
        <p class="sub muted">你說過的策略是<b>在下跌中買好公司</b>——贏得過大盤、離高點夠遠、
          有人在報而且沒被盯上，就是這三格。
          ${mk === 'us'
            ? '池子是日成交額 <b>2,000 萬美元</b>以上的股票，成長率是<b>明年營收預估</b>（前瞻）。'
            : '池子是<b>全市場</b>有公告月營收的普通股，成長率是<b>月營收年增</b>（已發生）。'}
          ${mk === 'tw' ? '搜尋吃的是公司申報的業務，所以想找「小金居」就搜<b>銅箔</b>。' : ''}</p>
      </div>
      <div class="seg nav-seg sort-seg">${SCREEN_SORT.map(([v, l]) =>
        `<label><input type="radio" name="scsort" value="${v}" ${
          f.sort === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
    </div>
    ${rows.length ? `<div class="card list">${rows.map((r) => `
      <div class="line member" role="button" tabindex="0" data-stock="${mk}:${esc(norm(r.symbol))}">
        <div class="row-between">
          <span>${esc(r.symbol)} ${esc(r.name || '')}${
            held.has(norm(r.symbol)) ? '<span class="badge day-badge">持有</span>' : ''}${
            r.story ? `<span class="badge story-badge">${
              esc(String(r.story).split(' ')[0])}</span>` : ''}${
            r.alert_kind ? `<span class="badge alert-${esc(r.alert_kind)}">${
              ALERT_LABEL[r.alert_kind] || ''}</span>` : ''}</span>
          <span class="${plClass(num(r.drop_pct))}">${
            isNum(r.drop_pct) ? signed(num(r.drop_pct) * 100, 0) + '%' : '–'}<span class="sub muted"> 距高點</span></span>
        </div>
        <div class="row-between sub muted">
          <span>${mk === 'us' ? '$' : ''}${fmtMax(r.price, 2)}　三年區間 ${
            fmtMax(r.lo3y, 1)}–${fmtMax(r.hi3y, 1)}</span>
          <span>報酬/波動 <b class="${isNum(r.ratio) && isNum(bench) && num(r.ratio) > bench ? 'gain' : ''}">${
            fmtMax(r.ratio, 2)}</b></span>
        </div>
        <div class="row-between sub muted">
          <span>${isNum(r.pe)
            ? `本益比 ${fmtMax(r.pe, 1)}x<span class="muted">（${esc(r.pe_src || '')}${
                r.fy ? ' ' + String(r.fy).slice(2) : ''}）</span>`
            : '無本益比'}${num(r.analysts) > 0 ? `　${fmt(r.analysts)} 位` : ''}</span>
          <span>${mk === 'us' ? '明年營收' : '營收年增'} <span class="${plClass(num(r.growth))}">${
            isNum(r.growth) ? signed(num(r.growth) * 100, 0) + '%' : '–'}</span></span>
        </div>
        <div class="sub muted ellip">${(() => {
          // 族群與業務原本會黏在一起（「玻纖布電子零組件業」），
          // 是因為分隔符只在 business 有值時才插，但實際顯示的是 business ?? industry。
          const desc = (r.business || r.industry || '').trim();
          const parts = [r.themes, desc.length > 30 ? desc.slice(0, 30) + '…' : desc].filter(Boolean);
          return esc(parts.join('　'));
        })()}</div>
      </div>`).join('')}</div>`
      : `<div class="card"><p class="muted">${state.screenBusy ? '篩選中…'
        : '沒有符合的。條件放寬一點——通常是「跌幅」設太深了。'}</p></div>`}
    <p class="hint"><b>這頁挑出來的是候選，不是買進訊號。</b>
      跌得深有兩種原因：被錯殺，或是基本面真的壞了，這頁分不出來，要自己點進去看營收與預估。
      「距高點」用的是三年最高收盤，跟波動、報酬取自同一份 Yahoo 日線，所以一定一致。
      ${mk === 'tw'
        ? '本益比優先用分析師預估，沒有預估的退回官方每日公告的近四季，括號裡會標是哪一種。'
          + '台股只有大約六成有人覆蓋，勾「至少三位分析師」會少掉很多檔，那是正常的。'
        : '本益比是明年預估。池子已經先用流動性篩過，太冷門的不會出現在這裡。'}
      報酬/波動需要三年日線，<b>上市未滿兩年的算不出來，會被「贏過大盤」這個條件濾掉</b>。</p>`;

  const refire = () => renderScreener(host, mk);
  $$('[data-sc]', host).forEach((c) => (c.onchange = () => {
    state.screen = { ...state.screen, [c.dataset.sc]: c.checked };
    loadScreen(host, mk);
  }));
  $$('[data-sc-n]', host).forEach((i) => (i.onchange = () => {
    const v = i.value === '' ? null : num(i.value);
    state.screen = { ...state.screen, [i.dataset.scN]: v };
    loadScreen(host, mk);
  }));
  $$('input[name=scsort]', host).forEach((r) => (r.onchange = () => {
    state.screen = { ...state.screen, sort: r.value };
    loadScreen(host, mk);
  }));
  const tg = $('[data-sc-open]', host);
  if (tg) tg.onclick = () => { state.screenOpen = !state.screenOpen; refire(); };
  const q = $('[data-sc-q]', host);
  if (q) {
    // 打字每一個字都送會打爆資料庫，停 400ms 才送；Enter 立刻送
    let timer = null;
    const fire = () => {
      clearTimeout(timer);
      state.screen = { ...state.screen, q: q.value };
      loadScreen(host, mk, () => {
        const el = $('[data-sc-q]', host);
        if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
      });
    };
    q.oninput = () => { clearTimeout(timer); timer = setTimeout(fire, 400); };
    q.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); fire(); } };
  }
  bindStockOpen(host);
  return refire;
}

// 打一次 RPC 再重畫。連點時只認最後一次的結果，免得舊的蓋掉新的。
export async function loadScreen(host, mk, after) {
  const seq = ++screenSeq;
  state.screenBusy = true;
  const count = $('[data-screen-count]', host);
  if (count) count.textContent = '篩選中…';
  try {
    const rows = await runScreen(mk, state.screen || SCREEN_DEFAULT);
    if (seq !== screenSeq) return;
    state.screenRows = rows;
  } catch (e) {
    if (seq !== screenSeq) return;
    state.screenRows = [];
    toast(e.message || '篩選失敗');
  } finally {
    if (seq === screenSeq) {
      state.screenBusy = false;
      renderScreener(host, mk);
      if (after) after();
    }
  }
}
