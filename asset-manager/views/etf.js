import { $$, esc, fmt, isNum, num, pct, plClass, sb, shortName, signed, state, toast } from '../core.js';
import { render } from '../render.js';
import { bindStockOpen } from './stock.js';

// ------------------------------------------------------------
// 主動型 ETF
//
//   這一頁回答兩件事：
//     1. 這些公開宣稱要打敗指數的人，**到底有沒有打敗**
//     2. 他們的錢**押在哪些產業**
//
//   第二件事沒有持股資料。每日申購買回清單只在各家投信自己的網站上，
//   十三家格式都不一樣，國泰那個網域還整站擋自動存取。
//   所以改用報酬式風格分析推估——基金的日報酬跟哪個族群一起動，
//   就是押在哪裡。**是相關性不是權重**，畫面上要講清楚，不能讓人誤會成持股。
// ------------------------------------------------------------
const ETF_SCOPES = [['tw', '台股', '0050'], ['us', '美股', '00662'], ['global', '全球', '00646']];

export async function loadEtf(host) {
  if (state.etfBusy) return;
  state.etfBusy = true;
  try {
    const { data, error } = await sb.rpc('etf_board');
    if (error) throw error;
    state.etfBoard = data || null;
  } catch (e) {
    toast(e.message || '主動型 ETF 資料讀取失敗');
  } finally {
    state.etfBusy = false;
    renderEtf(host);
  }
}

export function renderEtf(host) {
  const b = state.etfBoard;
  if (!b) {
    host.innerHTML = `<div class="card"><p class="muted">${
      state.etfBusy ? '讀取中…' : '還沒有主動型 ETF 資料。'}</p></div>`;
    return;
  }
  const all = (b.funds || []).filter((f) => isNum(f.days));
  const scope = ETF_SCOPES.some((x) => x[0] === state.etfScope) ? state.etfScope : 'tw';
  const meta = ETF_SCOPES.find((x) => x[0] === scope);
  const rows = all.filter((f) => f.scope === scope);
  const win = rows.filter((f) => num(f.excess) > 0).length;
  const young = (b.funds || []).length - all.length;
  // 族群擁擠度現在用**實際持股**算，不是相關性推估了。
  // 長條的長度用 top_own（族群內被吃最兇的那一檔佔股本幾 %），
  // 不用基金檔數——每檔基金都放台積電不代表台積電是題材，
  // 但是被十四檔合計吃掉 6.9% 股本就是實打實的浮額減少。
  // 0.2% 以下的不列。那個量級對籌碼沒有任何影響，
  // 一長串 0.0% 只會把真正集中的那幾個擠到看不見。
  const crowdAll = (b.crowd || []).filter((c) => isNum(c.top_own));
  const crowd = crowdAll.filter((c) => num(c.top_own) >= 0.2);
  const crowdTail = crowdAll.length - crowd.length;
  const ownMax = Math.max(...crowd.map((c) => num(c.top_own)), 0.001);

  host.innerHTML = `
    <div class="card">
      <div class="list-title">主動型 ETF</div>
      <p class="sub muted">${esc(b.as_of || '')}。代號 <b>A 結尾</b>的就是主動型，
        這是主管機關的編碼規則。比較的對象不是指數而是<b>同期的被動 ETF</b>——
        指數不能買，${esc(meta[2])} 可以，而且同樣台幣計價、同樣的交易時間。
        報酬<b>含息</b>（還原除息與分割），不然高息型的會被當成在虧錢。</p>
    </div>

    <div class="seg nav-seg etf-seg">
      ${ETF_SCOPES.map(([k, label]) => `<label><input type="radio" name="etfsc" value="${k}" ${
        scope === k ? 'checked' : ''}><span>${label} ${
        all.filter((f) => f.scope === k).length}</span></label>`).join('')}
    </div>

    <div class="card">
      <div class="row-between">
        <span class="list-title">贏過 ${esc(meta[2])} 的</span>
        <span class="etf-score ${win * 2 >= rows.length ? 'gain' : 'loss'}">${win} / ${rows.length}</span>
      </div>
      <p class="sub muted">用<b>掛牌以來</b>的報酬比，而且對照組取同一段期間——
        2025 年 4 月掛牌的跟 2026 年 8 月掛牌的，比絕對報酬等於在比誰運氣好。${
        young ? `另有 ${young} 檔掛牌未滿 20 個交易日，先不列。` : ''}</p>
    </div>

    ${scope === 'tw' && crowd.length ? `<div class="card">
      <div class="list-title">這些錢押在哪裡</div>
      <p class="sub muted">${esc(b.hold_as_of || '')}的<b>實際持股</b>。長條是族群裡
        被吃最兇的那一檔<b>佔它股本的幾 %</b>——不是基金檔數，因為每檔基金都放台積電
        不代表台積電是題材，但被二十檔合計吃掉 7% 股本就是浮額真的變少了。</p>
      <div class="etf-crowd">
        ${crowd.map((c) => `<div class="etf-citem">
          <div class="etf-crow" role="button" tabindex="0" data-tilt="${esc(c.theme)}">
            <span class="etf-cname">${esc(c.theme)}</span>
            <span class="etf-bar"><i style="width:${Math.round(num(c.top_own) / ownMax * 100)}%"></i></span>
            <span class="etf-cnum">${fmt(c.top_own, 1)}%</span>
          </div>
          <div class="etf-cfoot sub muted">${fmt(c.funds)} 檔持有 ${fmt(c.names)} 家　
            最重 <span class="link" role="button" tabindex="0" data-stock="tw:${esc(c.top_symbol)}">${
              esc(c.top_symbol)} ${esc(shortName(c.top_name))}</span>　${fmt(c.val_yi, 1)} 億</div>
        </div>`).join('')}
      </div>
      ${crowdTail ? `<p class="sub muted">另有 ${crowdTail} 個族群被吃掉的股本不到 0.2%，沒列出來。</p>` : ''}
    </div>` : ''}

    <div class="card list">
      ${rows.length ? rows.map((f) => {
        const open = state.etfOpen === f.symbol;
        const ex = num(f.excess);
        return `<div class="etf-row${open ? ' open' : ''}" data-etf="${esc(f.symbol)}" role="button" tabindex="0">
          <div class="row-between">
            <span class="list-title">${esc(f.name || f.symbol)}</span>
            <span class="theme-yoy ${plClass(ex)}">${signed(ex * 100, 1)}%</span>
          </div>
          <div class="row-between sub muted">
            <span>${esc(f.symbol)}　${fmt(f.days)} 天</span>
            <span>${signed(num(f.ret) * 100, 1)}% <span class="muted">vs ${
              esc(f.bench)} ${signed(num(f.bench_ret) * 100, 1)}%</span></span>
          </div>
          ${(f.holds || []).length ? `<div class="etf-chips">${
            (f.holds || []).slice(0, open ? 12 : 4).map((h) => `<span class="etf-chip hold"
              role="button" tabindex="0" ${h.mkt === 'TW' ? `data-stock="tw:${esc(h.symbol)}"` : ''}>${
              esc(shortName(h.name) || h.symbol)} <b>${fmt(h.weight, 1)}%</b></span>`).join('')}${
            num(f.holds_n) > (open ? 12 : 4)
              ? `<span class="etf-chip">還有 ${fmt(num(f.holds_n) - (open ? 12 : 4))} 檔</span>` : ''}</div>` : ''}
          ${open ? `<div class="sub muted etf-more">
            ${esc(f.issuer || '')}${f.issuer ? '　' : ''}${esc(f.listed_on || '')} 掛牌　
            年化波動 ${isNum(f.vol) ? pct(f.vol) : '–'}　
            對照組 ${esc(f.bench)}（相關 ${isNum(f.bench_corr) ? Number(f.bench_corr).toFixed(2) : '–'}）
          </div>` : ''}
        </div>`;
      }).join('') : '<p class="muted">這一組還沒有滿 20 個交易日的基金。</p>'}
    </div>`;

  $$('input[name=etfsc]', host).forEach((r) => (r.onchange = () => {
    state.etfScope = r.value; state.etfOpen = '';
    renderEtf(host);
  }));
  // 點族群就跳到產業鏈那一頁並且鎖定它，不用自己再找一次
  $$('[data-tilt]', host).forEach((n) => (n.onclick = (e) => {
    e.stopPropagation();
    state.mapPick = n.dataset.tilt;
    state.themeMarket = 'tw';
    state.themeView = 'tree';
    render();
  }));
  $$('[data-etf]', host).forEach((n) => (n.onclick = () => {
    state.etfOpen = state.etfOpen === n.dataset.etf ? '' : n.dataset.etf;
    renderEtf(host);
  }));
  bindStockOpen(host);
}
