import { $, $$, esc, fmt, fmtMax, isNum, norm, num, plClass, rocYm, signed, state } from '../core.js';
import { beatsIdx, heldSymbols, idxRatio, themePe, usBeats, usIdxRatio, usdB } from '../portfolio.js';
import { loadEtf, renderEtf } from './etf.js';
import { renderThemeMap } from './map.js';
import { loadScreen, renderScreener } from './screener.js';
import { bindStockOpen } from './stock.js';

function renderTwThemes(el) {
  const trend = [...state.themeTrend].filter((t) => isNum(t.yoy)).sort((a, b) => num(b.yoy) - num(a.yoy));
  const held = heldSymbols();
  // 各族群現在可能落在不同月份（見 theme_trend 的註解），
  // 標題要用「最新的那個月」，不能拿陣列第一筆——那是按族群名排序的，等於隨機。
  const ym = state.themeTrend.reduce((mx, t) => (t.ym && t.ym > mx ? t.ym : mx), '');

  if (!trend.length) {
    el.innerHTML = `<div class="card"><p class="muted">還沒有營收資料。按右上角 ↻ 更新，或等下次自動更新。</p></div>`;
    return;
  }

  const myThemes = new Set(state.themeMembers.filter((m) => held.has(norm(m.symbol))).map((m) => m.theme));

  el.innerHTML = `
    <div class="card">
      <div class="list-title">產業營收年增率</div>
      <p class="sub muted">${ym ? rocYm(ym) + ' 月營收' : ''}，同族群成分股加總後比去年同月。
        這是產業本身的成長，不是股價漲跌。${
        trend.some((t) => t.ym !== ym)
          ? '<br><b>各族群取它自己最新的月份</b>——櫃買的月營收比證交所早出幾天，'
            + '成員全是上市的族群會晚一個月，那幾族後面標了月份。' : ''}</p>
    </div>
    ${trend.map((t) => {
      const mine = myThemes.has(t.theme);
      const info = state.themeInfo.find((i) => i.theme === t.theme);
      const tv = themePe(t.theme);
      // 整體與小眾差一倍以上，代表頭條數字會嚴重誤導
      const partial = info && isNum(info.cagr) && isNum(info.niche_cagr)
        && num(info.niche_cagr) > num(info.cagr) * 2;
      return `<div class="card theme-card${mine ? ' mine' : ''}" data-theme="${esc(t.theme)}">
        <div class="row-between">
          <span class="list-title">${esc(t.theme)}${mine ? '<span class="badge day-badge">持有</span>' : ''}${
            partial ? '<span class="badge warn-badge">看小眾</span>' : ''}</span>
          <span class="theme-yoy ${plClass(num(t.yoy))}">${signed(num(t.yoy) * 100, 1)}%</span>
        </div>
        <div class="row-between sub muted">
          <span>月營收 ${fmt(num(t.amount) / 100000, 1)} 億${
            t.ym && t.ym !== ym ? `<span class="badge">${esc(rocYm(t.ym))}</span>` : ''}</span>
          <span>${fmt(t.members)} 檔・實際營收年增</span>
        </div>
        <div class="row-between sub muted">
          <span>報酬/波動 ${tv && isNum(tv.ratio_median)
            ? `<b class="${num(tv.ratio_median) > idxRatio() ? 'gain' : ''}">${fmtMax(tv.ratio_median, 2)}</b>` : '–'}${
            tv && isNum(tv.vol_median) ? `　波動 ${(num(tv.vol_median) * 100).toFixed(0)}%` : ''}</span>
          <span>${tv ? `${fmt(tv.beat_idx)}/${fmt(tv.total)} 檔贏過指數` : ''}</span>
        </div>
        <div class="row-between sub muted">
          <span>本益比 近四季 ${tv && isNum(tv.pe_median) ? `<b>${fmtMax(tv.pe_median, 1)}x</b>` : '–'}${
            tv && isNum(tv.pe1_median) ? `　${String(tv.fy1).slice(2)}F <b>${fmtMax(tv.pe1_median, 1)}x</b>` : ''}${
            tv && isNum(tv.pe2_median) ? `　${String(tv.fy2).slice(2)}F <b>${fmtMax(tv.pe2_median, 1)}x</b>` : ''}</span>
          <span>${tv ? `${fmt(tv.covered)}/${fmt(tv.total)} 檔有預估` : ''}${
            tv && num(tv.loss) > 0 ? `　<span class="loss">${fmt(tv.loss)} 檔虧損</span>` : ''}</span>
        </div>
        <div class="forecast">
          <div class="row-between sub">
            <span class="muted">整體市場預測</span>
            <span>${info && isNum(info.cagr)
              ? `${(num(info.cagr) * 100).toFixed(1)}%${isNum(info.cagr_low) && num(info.cagr_low) !== num(info.cagr_high)
                  ? ` <span class="muted">(${(num(info.cagr_low) * 100).toFixed(0)}–${(num(info.cagr_high) * 100).toFixed(0)}%)</span>` : ''}`
              : '<span class="muted">未查證</span>'}</span>
          </div>
          ${info?.niche ? `<div class="row-between sub niche">
            <span>${esc(info.niche)}</span>
            <span class="${isNum(info.niche_cagr) ? 'niche-cagr' : 'muted'}">${isNum(info.niche_cagr)
              ? `<b>${(num(info.niche_cagr) * 100).toFixed(1)}%</b>${isNum(info.niche_low) && num(info.niche_low) !== num(info.niche_high)
                  ? ` <span class="muted">(${(num(info.niche_low) * 100).toFixed(0)}–${(num(info.niche_high) * 100).toFixed(0)}%)</span>` : ''}`
              : '未查證'}</span>
          </div>` : ''}
        </div>
        <div class="theme-body" hidden></div>
      </div>`;
    }).join('')}
    <p class="hint">實際年增來自證交所與櫃買中心的每月營收公告，每月 10 日前後更新。
      預測值是各研究機構的市場預測，沒有免費 API，由人工整理，查證日期 2026-09-08。
      <b>整體市場的 CAGR 幾乎都不是你要的那個數字</b>，因為它含大量與 AI 無關的成熟需求。
      真正的成長在小眾領域，標「看小眾」的代表兩者差一倍以上，只看整體會嚴重低估。
      本益比取<b>中位數</b>不取平均，因為一檔異常高就會把平均拉爛；虧損的公司不計入中位數，
      但會另外標出有幾檔在虧損，那本身就是訊息。近四季本益比由證交所與櫃買中心每日公告。
      <b>預估本益比 = 現價 ÷ 分析師預估 EPS</b>，預估值自動抓自 stockanalysis.com 的共識，
      股價每天更新所以比值每天變。台股只有大約六成的公司有人在報，「無人覆蓋」是常態不是錯誤，
      分析師兩位以下會標 ⚠。族群的「N/M 檔有預估」如果分母遠大於分子，那個中位數就別太當真。
      <b>報酬/波動</b>是三年年化報酬除以年化波動，及格線是加權指數的
      ${isNum(idxRatio()) ? fmtMax(idxRatio(), 2) : '–'}。低於這條線的個股，
      承受的波動換不到相稱的報酬，<b>不如直接開槓桿買指數</b>。
      回測實例：金居三年漲 7.79 倍看起來很猛，但波動 52% 讓風險等價槓桿只能開 0.81 倍，
      套上同一條交易規則後只有 4.03 倍，反而輸給指數的 7.75 倍。漲得多不等於賺得多。
      營收成長不等於股價會漲，這頁看的是產業景氣的轉折。</p>`;

  $$('.theme-card', el).forEach((card) => {
    card.onclick = () => {
      const body = $('.theme-body', card);
      if (!body.hidden) { body.hidden = true; return; }
      $$('.theme-body', el).forEach((b) => (b.hidden = true));
      const rows = state.themeMembers.filter((m) => m.theme === card.dataset.theme);
      const info = state.themeInfo.find((i) => i.theme === card.dataset.theme);
      const head = info
        ? `<div class="forecast-note">
             ${info.note ? `<div><b>整體市場：</b>${esc(info.note)}</div>` : ''}
             ${info.niche_note ? `<div class="niche-note"><b>${esc(info.niche || '小眾領域')}：</b>${esc(info.niche_note)}</div>` : ''}
             <div class="muted">預測來源：${esc(info.source || '未註明')}${info.checked_on ? `　查證於 ${esc(info.checked_on)}` : ''}</div>
           </div>` : '';
      body.innerHTML = head + (rows.length
        ? rows.map((m) => `<div class="line member" role="button" tabindex="0" data-stock="tw:${esc(norm(m.symbol))}">
            <div class="row-between">
              <span>${esc(m.symbol)} ${esc(m.name || '')}${held.has(norm(m.symbol)) ? '<span class="badge day-badge">持有</span>' : ''}</span>
              <span>${fmt(num(m.amount) / 100000, 1)} 億　<span class="${plClass(num(m.yoy))}">${
                isNum(m.yoy) ? signed(num(m.yoy) * 100, 1) + '%' : '–'}</span></span>
            </div>
            <div class="row-between sub muted">
              <span>近四季 ${isNum(m.pe) ? fmtMax(m.pe, 1) + 'x' : '虧損'}${
                isNum(m.pe1) ? `　${String(m.fy1).slice(2)}F <b>${fmtMax(m.pe1, 1)}x</b>` : ''}${
                isNum(m.pe2) ? `　${String(m.fy2).slice(2)}F <b>${fmtMax(m.pe2, 1)}x</b>` : ''}</span>
              <span>${isNum(m.an1)
                ? `${fmt(m.an1)} 位分析師${num(m.an1) <= 2 ? '<span class="warn-mark">⚠</span>' : ''}`
                : '<span class="muted">無人覆蓋</span>'}</span>
            </div>
            <div class="row-between sub muted">
              <span>${isNum(m.ratio)
                ? `報酬/波動 <b class="${beatsIdx(m.ratio) ? 'gain' : ''}">${fmtMax(m.ratio, 2)}</b>${
                    beatsIdx(m.ratio) ? '<span class="badge day-badge">贏指數</span>' : ''}`
                : '報酬/波動 –'}</span>
              <span>${isNum(m.vol) ? `波動 ${(num(m.vol) * 100).toFixed(0)}%` : ''}${
                isNum(m.cagr) ? `　年化 ${signed(num(m.cagr) * 100, 0)}%` : ''}</span>
            </div>
          </div>`).join('')
        : '<p class="muted">沒有成分股資料。</p>');
      body.hidden = false;
      bindStockOpen(body);
    };
  });
}

function renderUsThemes(host) {
  const trend = [...state.usThemeTrend].sort((a, b) => num(b.growth_next) - num(a.growth_next));
  const held = new Set(state.us.map((s) => norm(s.symbol)));
  if (!trend.length) {
    host.innerHTML = '<div class="card"><p class="muted">還沒有美股資料。按右上角 ↻ 更新。</p></div>';
    return;
  }
  const myThemes = new Set(state.usThemeMembers.filter((m) => held.has(norm(m.symbol))).map((m) => m.theme));
  const ndx = usIdxRatio();

  host.innerHTML = `
    <div class="card">
      <div class="list-title">美股 AI 產業地圖</div>
      <p class="sub muted">用<b>分析師的營收預估</b>加總，看整個產業被預期要長多快。
        這是前瞻指標，跟台股那頁用已公告的月營收（落後指標）方向相反。
        基準線是那斯達克 100，報酬/波動 ${isNum(ndx) ? fmtMax(ndx, 2) : '–'}。</p>
    </div>
    ${trend.map((t) => {
      const mine = myThemes.has(t.theme);
      return `<div class="card theme-card${mine ? ' mine' : ''}" data-ustheme="${esc(t.theme)}">
        <div class="row-between">
          <span class="list-title">${esc(t.theme)}${mine ? '<span class="badge day-badge">持有</span>' : ''}</span>
          <span class="theme-yoy ${plClass(num(t.growth_next))}">${
            isNum(t.growth_next) ? signed(num(t.growth_next) * 100, 1) + '%' : '–'}</span>
        </div>
        <div class="row-between sub muted">
          <span>營收預估 ${usdB(t.rev_this)}美元・${fmt(t.covered)}/${fmt(t.members)} 檔</span>
          <span>明年營收年增</span>
        </div>
        <div class="row-between sub muted">
          <span>本年營收年增 <b class="${plClass(num(t.growth))}">${
            isNum(t.growth) ? signed(num(t.growth) * 100, 1) + '%' : '–'}</b></span>
          <span>本益比 本年 ${isNum(t.pe_median) ? fmtMax(t.pe_median, 1) + 'x' : '–'}　明年 ${
            isNum(t.pe_next_median) ? fmtMax(t.pe_next_median, 1) + 'x' : '–'}</span>
        </div>
        <div class="row-between sub muted">
          <span>報酬/波動 ${isNum(t.ratio_median)
            ? `<b class="${num(t.ratio_median) > ndx ? 'gain' : ''}">${fmtMax(t.ratio_median, 2)}</b>` : '–'}${
            isNum(t.vol_median) ? `　波動 ${(num(t.vol_median) * 100).toFixed(0)}%` : ''}</span>
          <span>${fmt(t.beat_idx)}/${fmt(t.members)} 檔贏過 NDX</span>
        </div>
        <div class="theme-body" hidden></div>
      </div>`;
    }).join('')}
    <p class="hint">營收與 EPS 預估來自 stockanalysis.com 匯總的分析師共識（S&amp;P Global、TipRanks），
      每天自動更新，只有本年度與次年度免費。<b>各公司會計年度不一致</b>，
      例如 NVDA 的 FY2027 其實是 2026 曆年，所以這裡只講「本年／明年」不寫死年份。
      報酬/波動是三年年化報酬除以年化波動，及格線是那斯達克 100 的
      ${isNum(ndx) ? fmtMax(ndx, 2) : '–'}；低於它代表承受的波動換不到相稱的報酬。
      <b>預估是別人的猜測</b>，分析師少的那幾檔請當參考不要當事實。</p>`;

  $$('.theme-card', host).forEach((card) => {
    card.onclick = () => {
      const body = $('.theme-body', card);
      if (!body.hidden) { body.hidden = true; return; }
      $$('.theme-body', host).forEach((b) => (b.hidden = true));
      const rows = state.usThemeMembers.filter((m) => m.theme === card.dataset.ustheme);
      body.innerHTML = rows.length
        ? rows.map((m) => `<div class="line member" role="button" tabindex="0" data-stock="us:${esc(norm(m.symbol))}">
            <div class="row-between">
              <span>${esc(m.symbol)} ${esc(m.name || '')}${
                held.has(norm(m.symbol)) ? '<span class="badge day-badge">持有</span>' : ''}</span>
              <span>${usdB(m.rev_this)}美元　<span class="${plClass(num(m.rev_g))}">${
                isNum(m.rev_g) ? signed(num(m.rev_g) * 100, 1) + '%' : '–'}</span></span>
            </div>
            <div class="row-between sub muted">
              <span>本益比 本年 ${isNum(m.pe_this) ? fmtMax(m.pe_this, 1) + 'x' : '–'}　明年 ${
                isNum(m.pe_next) ? fmtMax(m.pe_next, 1) + 'x' : '–'}</span>
              <span>${isNum(m.analysts)
                ? `${fmt(m.analysts)} 位分析師${num(m.analysts) <= 5 ? '<span class="warn-mark">⚠</span>' : ''}`
                : '<span class="muted">無人覆蓋</span>'}</span>
            </div>
            <div class="row-between sub muted">
              <span>${isNum(m.ratio)
                ? `報酬/波動 <b class="${usBeats(m.ratio) ? 'gain' : ''}">${fmtMax(m.ratio, 2)}</b>${
                    usBeats(m.ratio) ? '<span class="badge day-badge">贏 NDX</span>' : ''}`
                : (num(m.days) > 0
                    ? `<span class="muted">上市未滿兩年（${fmt(m.days)} 天），不給比值</span>`
                    : '報酬/波動 –')}</span>
              <span>${isNum(m.vol) ? `波動 ${(num(m.vol) * 100).toFixed(0)}%` : ''}${
                isNum(m.rev_g_next) ? `　明年營收 ${signed(num(m.rev_g_next) * 100, 0)}%` : ''}</span>
            </div>
          </div>`).join('')
        : '<p class="muted">沒有成分股資料。</p>';
      body.hidden = false;
      bindStockOpen(body);
    };
  });
}

// ------------------------------------------------------------
// 今日：哪個族群在動
//   這頁是為了「永遠不要放空當天強勢的股票」那條紀律做的。
//   要能執行那條規則，得先看得到「今天是不是整群在漲」，
//   以及每一檔「從當日低點拉了多少」——那才是判斷強弱的數字。
//
//   華新科 2026-09-10 是活教材：對昨收 +4.5% 看起來還好，
//   但它從低點 303 拉到 334，是 +10.2%，而且 MLCC 電容是當天最強的族群。
//   使用者在 317.5 空 2 口、328 回補，賠了 42,000。
//
//   這是收盤資料，用途是隔天回頭看自己做了什麼，不是盤中攔截。
// ------------------------------------------------------------
function renderThemeDay(host) {
  const rows = state.themeDay.filter((t) => isNum(t.chg_med));
  if (!rows.length) {
    host.innerHTML = '<div class="card"><p class="muted">還沒有當日漲跌資料，按右上角 ↻ 更新。</p></div>';
    return;
  }
  const held = heldSymbols();
  const mineThemes = new Set(state.themeMembers.filter((m) => held.has(norm(m.symbol))).map((m) => m.theme));
  const asOf = rows.map((t) => t.as_of).filter(Boolean).sort().pop();
  // 整群在漲才叫族群性大漲：中位數為正、而且上漲家數佔多數
  const hot = (t) => num(t.chg_med) > 0.02 && num(t.up) > num(t.members) / 2;

  host.innerHTML = `
    <div class="card">
      <div class="list-title">今日族群漲跌</div>
      <p class="sub muted">${esc(asOf || '')} 收盤。取<b>中位數</b>不取平均，一檔漲停就會把平均拉爛。
        <b>整群在漲</b>（中位數 &gt;2% 且過半上漲）的會標紅框——
        <b>那是不能去空的族群。</b></p>
    </div>
    <div class="card list">
      ${rows.map((t) => `<div class="day-theme${hot(t) ? ' hot' : ''}${
        mineThemes.has(t.theme) ? ' mine' : ''}">
        <div class="row-between">
          <span class="list-title">${esc(t.theme)}${
            mineThemes.has(t.theme) ? '<span class="badge day-badge">持有</span>' : ''}${
            hot(t) ? '<span class="badge warn-badge">整群在漲</span>' : ''}</span>
          <span class="theme-yoy ${plClass(num(t.chg_med))}">${signed(num(t.chg_med) * 100, 2)}%</span>
        </div>
        <div class="row-between sub muted">
          <span>${fmt(t.members)} 檔　<span class="gain">漲 ${fmt(t.up)}</span>　<span class="loss">跌 ${fmt(t.down)}</span></span>
          <span>從低點拉起 <b class="${num(t.off_low_med) > 0.03 ? 'gain' : ''}">${
            isNum(t.off_low_med) ? signed(num(t.off_low_med) * 100, 1) + '%' : '–'}</b></span>
        </div>
        ${t.top_symbol ? `<div class="row-between sub muted">
          <span>最強 <span class="link" role="button" tabindex="0" data-stock="tw:${esc(norm(t.top_symbol))}">${
            esc(t.top_symbol)} ${esc(t.top_name || '')}</span></span>
          <span class="${plClass(num(t.top_chg))}">${signed(num(t.top_chg) * 100, 2)}%</span>
        </div>` : ''}
      </div>`).join('')}
    </div>
    <p class="hint"><b>「從低點拉起」比「對昨收漲跌」重要。</b>
      一檔今天對昨收還是跌的，不代表它弱——華新科 2026-09-10 對昨收看起來只有 +4.5%，
      但它從當日低點 303 拉到 334，是 +10.2%，而且 MLCC 電容是當天中位數最高的族群。
      在那種位置放空，等於站在整群買盤的對面。
      這裡是<b>收盤</b>資料，不是即時報價，用途是隔天回頭檢查自己昨天做了什麼。</p>`;
  bindStockOpen(host);
}

export function renderThemes(el) {
  const mk = state.themeMarket === 'us' ? 'us' : 'tw';
  const vw = ['tree', 'day', 'screen', 'etf'].includes(state.themeView) ? state.themeView : 'list';
  el.innerHTML = `<div class="seg nav-seg market-seg">
      <label><input type="radio" name="mkt" value="tw" ${mk === 'tw' ? 'checked' : ''}><span>台股</span></label>
      <label><input type="radio" name="mkt" value="us" ${mk === 'us' ? 'checked' : ''}><span>美股</span></label>
    </div>
    <div class="seg nav-seg view-seg">
      <label><input type="radio" name="tvw" value="list" ${vw === 'list' ? 'checked' : ''}><span>清單</span></label>
      <label><input type="radio" name="tvw" value="tree" ${vw === 'tree' ? 'checked' : ''}><span>產業鏈</span></label>
      ${mk === 'tw'
        ? `<label><input type="radio" name="tvw" value="day" ${vw === 'day' ? 'checked' : ''}><span>今日</span></label>` : ''}
      <label><input type="radio" name="tvw" value="screen" ${vw === 'screen' ? 'checked' : ''}><span>選股</span></label>
      ${mk === 'tw'
        ? `<label><input type="radio" name="tvw" value="etf" ${vw === 'etf' ? 'checked' : ''}><span>主動ETF</span></label>` : ''}
    </div><div data-themebody></div>`;
  const host = $('[data-themebody]', el);
  // 讓 CSS 知道現在是哪個子視圖。桌機的兩欄排版只能套在「一堆同質卡片」
  // 的清單與今日上；產業鏈、選股、主動ETF 都有自己的版面，被切成兩欄會壞。
  host.dataset.view = vw;
  // 今日只有台股有，證交所與櫃買的收盤檔本來就帶開高低，美股那邊沒有同一份資料
  if (vw === 'etf' && mk === 'tw') {
    // 先叫 loadEtf——它在第一個 await 之前就會把 etfBusy 設起來，
    // 這樣接著的 renderEtf 才會顯示「讀取中」而不是閃一下「還沒有資料」。
    if (!state.etfBoard) loadEtf(host);
    renderEtf(host);
  }
  else if (vw === 'day' && mk === 'tw') renderThemeDay(host);
  else if (vw === 'screen') { renderScreener(host, mk); loadScreen(host, mk); }
  else if (vw === 'tree') renderThemeMap(host, mk);
  else (mk === 'us' ? renderUsThemes : renderTwThemes)(host);
  $$('input[name=mkt]', el).forEach((r) => (r.onchange = () => {
    state.themeMarket = r.value;
    // 「今日」只有台股有；選股兩邊都有，但換市場要重篩
    // 「今日」與「主動ETF」只有台股有
    if (r.value === 'us' && ['day', 'etf'].includes(state.themeView)) state.themeView = 'list';
    state.screenRows = [];
    renderThemes(el);
  }));
  $$('input[name=tvw]', el).forEach((r) => (r.onchange = () => {
    state.themeView = r.value;
    renderThemes(el);
  }));
}
