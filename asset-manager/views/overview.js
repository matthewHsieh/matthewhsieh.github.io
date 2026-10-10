import { donutChart } from '../charts.js';
import { ALERT_LABEL, alertBadge, heldAlerts } from '../alerts.js';
import { $, $$, esc, fmt, fmtCompact, fmtMax, fmtX, isNum, norm, num, pct, plClass, signed, state, sum } from '../core.js';
import { saveSnapshot } from '../data.js';
import { ackBannerHtml, ackDisclaimer, disclaimerAcked } from '../legal.js';
import { renderDropWatch } from './riskcard.js';
import { compute, exposureSlices } from '../portfolio.js';
import { callOdds, marginState } from '../risk.js';
import { bindStockOpen } from './stock.js';
import { bindListActions, line, priceStamp, stalenessNote, stat, tradeButton } from '../widgets.js';

export function renderOverview(el) {
  const c = compute();
  const last = state.snapshots[0];
  const diff = last ? c.netAssets - num(last.net_assets) : null;
  const progressWidth = Math.min(100, Math.max(0, (isNum(c.progress) ? c.progress : 0) * 100)).toFixed(1);

  el.innerHTML = `
    ${disclaimerAcked() ? '' : ackBannerHtml()}
    <div class="card hero">
      <div class="label">淨資產 (TWD)</div>
      <div class="big">${fmt(c.netAssets)}</div>
      ${last
        ? `<div class="sub ${plClass(diff)}">${signed(diff)} <span class="muted">相較 ${esc(last.snap_date)}</span></div>`
        : '<div class="sub muted">尚無快照紀錄</div>'}
    </div>
    <div class="grid2">
      ${stat('總資產', fmt(c.totalAssets))}
      ${stat('負債', fmt(c.liabilities))}
      ${stat('槓桿① 資產槓桿', fmtX(c.leverageAsset), c.netAssets > 0 ? '總資產 ÷ 淨資產' : '淨資產不為正，無法計算')}
      ${stat('槓桿② 曝險槓桿', fmtX(c.leverageExposure), '總曝險 ÷ 總資產')}
    </div>
    ${marginCard()}
    ${(() => {
      // 持倉裡有被交易所盯上的就要先講。等他自己去點開個股才發現就太晚了。
      const as = heldAlerts();
      if (!as.length) return '';
      return `<div class="card alert-card">
        <div class="list-title" role="heading" aria-level="2">交易所警示　<span class="sub muted">${fmt(as.length)} 檔</span></div>
        ${as.map((a) => `<div class="row-between alert-row" role="button" tabindex="0"
            data-stock="tw:${esc(norm(a.symbol))}">
          <span>${alertBadge(a)}<b>${esc(a.symbol)}</b> ${esc(a.name || '')}</span>
          <span class="sub muted">${esc(a.kind === 'punish'
            ? `${a.start_d || ''}～${a.end_d || ''}`
            : num(a.notices) > 0 ? `近 30 天 ${fmt(a.notices)} 次注意` : ALERT_LABEL[a.kind])}</span>
        </div>`).join('')}
        <p class="hint">處置期間改成<b>人工撮合</b>，間隔從 2 分鐘到 45 分鐘都有；
          達到門檻的委託還要<b>圈存</b>——買進先付全部價金、賣出先有券，
          <b>當沖等於做不成</b>。門檻與間隔每一檔不一樣，點一列看那一檔的公告原文。</p>
      </div>`;
    })()}
    <div class="card">
      <div class="row-between"><span class="list-title" role="heading" aria-level="2">目標金額</span><span>${c.target > 0 ? fmt(c.target) : '<span class="muted">未設定</span>'}</span></div>
      <div class="bar"><div class="bar-fill" style="width:${progressWidth}%"></div></div>
      <div class="row-between sub">
        <span>${pct(c.progress)}</span>
        <span class="muted">${c.target > 0 ? (c.netAssets >= c.target ? '已達標 🎉' : '還差 ' + fmt(c.target - c.netAssets)) : '到「設定」輸入目標'}</span>
      </div>
    </div>
    <div class="card" id="donut-card">
      <div class="row-between">
        <span class="list-title" role="heading" aria-level="2">組成</span>
        <div class="seg-toggle" id="donut-toggle">
          <button type="button" data-donut="assets">資產組成</button>
          <button type="button" data-donut="exposure">曝險明細</button>
        </div>
      </div>
      <div id="donut-slot"></div>
    </div>
    <div class="card list">
      <div class="list-title" role="heading" aria-level="2">曝險</div>
      ${line('台股市值', c.stockValue)}
      ${line('複委託市值', c.usValue)}
      ${c.usLevExtra > 0 ? line('　└ 槓桿型多出來的曝險', c.usLevExtra, 0, 'sub') : ''}
      ${line('指數期貨名目', c.futIndex)}
      ${line('個股期貨名目', c.futStock)}
      ${line('選擇權 delta 曝險', c.optExposure)}
      ${line('權證 delta 曝險', c.warExp)}
      ${line('期貨名目・多單', c.futLong)}
      ${line('期貨名目・空單', c.futShort)}
      ${line('總曝險', c.exposure, 0, 'total')}
      ${c.warNoDelta || c.optNoDelta ? `<p class="hint warn-hint">⚠ 有${
        [c.warNoDelta ? '權證' : '', c.optNoDelta ? '選擇權' : ''].filter(Boolean).join('、')
        }部位還沒算出 delta，<b>這些部位目前沒有計入上面的總曝險</b>，實際曝險比顯示的高。
        按右上角 ↻ 重新整理，或等下次自動更新。</p>` : ''}
    </div>
    ${state.warrants.length ? `<div class="card list">
      <div class="list-title" role="heading" aria-level="2">權證風險</div>
      ${line('權證市值', c.warMarket)}
      ${line('delta 曝險', c.warExp)}
      ${line('最大損失（買方賠光權利金）', c.warMaxLoss)}
      <div class="row-between line"><span>每日時間價值流失</span><span class="loss">${fmt(c.warTheta)}</span></div>
      <p class="hint">權證的隱含波動率由發行券商決定，可以在發行後調降，這會讓權證價格下跌但 delta 完全反映不出來。
        系統每天記錄各檔隱波，被調降時會在「持倉」標示。${c.warNoDelta ? '<br>⚠ 有部位還沒算出 delta。' : ''}${
        c.warNoBasis ? `<br>⚠ 有 ${fmt(c.warNoBasis)} 檔沒填成本、權證價也還沒抓到，
        <b>沒有計入上面的最大損失</b>，實際數字比顯示的大。` : ''}</p>
    </div>` : ''}
    ${state.options.length ? `<div class="card list">
      <div class="list-title" role="heading" aria-level="2">選擇權風險</div>
      ${line('權利金市值（買方正、賣方負）', c.optMarket)}
      ${line('delta 曝險（絕對值加總）', c.optExposure)}
      ${line('淨方向部位（多為正）', c.optNetDelta)}
      <div class="row-between line"><span>到期最大虧損</span><span class="${c.optRiskUnlimited ? 'loss' : ''}">${
        c.optRiskUnlimited ? '無上限（賣出買權沒有被接住）' : fmt(c.optMaxLoss)}</span></div>
      ${c.optMaxGain === null ? '' : line('到期最大獲利', c.optMaxGain)}
      <p class="hint">最大損益是<b>按到期別整組算的</b>，不是一腳一腳加起來——賣出買權只要有一口
        履約價更高的買進買權接住，上方就封頂了，那是買權多頭價差。<br>
        delta 曝險是線性近似，大幅波動時實際曝險會比這個數字放大（gamma），賣方尤其明顯。
        所以最大損益另外列出，不併進槓桿。${c.optNoDelta ? '<br>⚠ 有部位還沒算出 delta，按右上角 ↻ 或等下次自動更新。' : ''}</p>
    </div>` : ''}
    <div data-drop-watch></div>
    ${tradeButton()}
    <button type="button" class="block" id="snap-btn">📌 記錄今日快照</button>
    <p class="hint">${priceStamp()}。收盤價、結算價與匯率每天自動更新，不用手動改。匯率 ${fmt(c.rate, 3)}。</p>
    ${stalenessNote()}`;

  const slot = $('#donut-slot', el);
  const drawDonut = () => {
    $$('#donut-toggle button', el).forEach((b) => b.classList.toggle('active', b.dataset.donut === state.donutMode));
    slot.innerHTML = '';
    if (state.donutMode === 'exposure') {
      const slices = exposureSlices();
      const total = sum(slices, (s) => s.value);
      slot.appendChild(donutChart({
        slices, total, centerLabel: '總曝險', centerValue: fmtCompact(total), format: fmt,
      }));
    } else {
      slot.appendChild(donutChart({
        slices: [
          { label: '台股', value: c.stockValue, color: 'var(--series-1)' },
          { label: '複委託', value: c.usValue, color: 'var(--series-2)' },
          { label: '期貨權益', value: c.futEquity, color: 'var(--series-3)' },
          { label: '現金', value: c.cash, color: 'var(--series-4)' },
        ],
        total: c.totalAssets, centerLabel: '總資產', centerValue: fmtCompact(c.totalAssets), format: fmt,
      }));
    }
  };
  $$('#donut-toggle button', el).forEach((b) => (b.onclick = () => {
    state.donutMode = b.dataset.donut;
    try { localStorage.setItem('donutMode', state.donutMode); } catch {}
    drawDonut();
  }));
  drawDonut();

  $('#snap-btn', el).onclick = saveSnapshot;
  // 按掉之後只重畫這一張卡，不要整頁 render()——
  // 整頁重畫會把甜甜圈與捲動位置一起重置，按個確認鈕不該有那種副作用。
  const ackBtn = $('#ack-btn', el);
  if (ackBtn) ackBtn.onclick = () => { ackDisclaimer(); ackBtn.closest('.ack-card').remove(); };
  renderDropWatch($('[data-drop-watch]', el));
  fillMarginOdds(el);
  bindListActions(el);
  bindStockOpen(el);
}

// ------------------------------------------------------------
// 追繳距離
//
// 這是做部位決定時最該看、而原本畫面上完全沒有的數字。2026-10-09 之前
// risk.js 裡的 marginRoom() / moveOdds() 寫好了但沒有任何地方呼叫，
// 整張卡等於不存在；而那段程式用的費率（10.125%，級距 1）
// 對持有處置股的帳戶會把安全度高估三成以上。
//
// 距離是同步算的（marginState），機率要抓日報酬所以非同步補上。
// **先把距離畫出來再補機率**：距離是結論，機率是輔助，
// 不該因為要等一個網路請求而讓最重要的數字延後出現。
// ------------------------------------------------------------
function marginCard() {
  const st = marginState();
  if (!(st.notional > 0) || st.pct == null) return '';
  const warn = st.pct < 0.10 ? ' alert-card' : '';
  const tiers = [...st.legs].sort((a, b) => b.notional - a.notional);
  return `<div class="card${warn}" data-margin>
    <div class="row-between">
      <span class="list-title" role="heading" aria-level="2">追繳距離</span>
      <span class="sub muted">期貨權益 ${fmt(st.equity)} ／ 名目 ${fmt(st.notional)}</span>
    </div>
    <div class="big ${st.pct < 0.10 ? 'loss' : ''}">${fmtMax(st.pct * 100, 1)}%</div>
    <div class="sub muted">名目再跌這麼多就會被追繳，金額 ${fmt(st.amount)}
      加權維持保證金率 ${fmtMax(st.mmBlended * 100, 2)}%</div>
    <div class="rc-scroll"><table class="rc-tab"><thead><tr>
      <th>標的</th><th>名目</th><th>權重</th><th>維持率</th><th>級距</th></tr></thead><tbody>
      ${tiers.map((l) => `<tr><td>${esc(l.label)}</td><td>${fmt(l.notional)}</td>
        <td>${fmt(l.weight * 100)}%</td>
        <td${l.known ? '' : ' class="loss"'}>${fmtMax(l.rate * 100, 2)}%</td>
        <td>${esc(l.tier || (l.known ? '個別調整' : '未知，用級距3 估'))}</td></tr>`).join('')}
    </tbody></table></div>
    <div data-margin-odds class="sub muted">追繳機率計算中…</div>
    <p class="hint">維持保證金率逐檔查自期交所（<code>fut_margin</code>，一週重抓一次就夠，
      只在級距調整或進出處置時會變）。公式是
      <b>x &gt; (權益／名目 − 維持率) ÷ (1 − 維持率)</b>——
      名目下跌時維持保證金會跟著降，所以分母不能省，省掉會低估距離約 15%。
      ${st.unknownShare > 0 ? `<b>⚠ 有 ${fmt(st.unknownShare * 100)}% 的名目查不到費率，用級距 3 估</b>，
        實際可能更緊。` : ''}</p>
  </div>`;
}

async function fillMarginOdds(el) {
  const box = $('[data-margin-odds]', el);
  if (!box) return;
  try {
    const r = await callOdds({ horizons: [3, 20, 60] });
    if (!r) { box.remove(); return; }
    if (!r.odds) {
      box.innerHTML = r.missing?.length
        ? `追繳機率算不出來：${r.missing.map(esc).join('、')} 還沒有日報酬資料。`
        : '追繳機率算不出來：共同交易日不足 60 天。';
      return;
    }
    const f = (p) => `<b class="${p > 0.2 ? 'loss' : ''}">${fmtMax(p * 100, 1)}%</b>`;
    // 樣本期的漂移要講出來。這一年是大多頭，照抄漂移等於假設它重演，
    // 所以預設用去漂移版，但把原始漂移印在旁邊讓人知道差多少。
    const ann = (Math.pow(1 + r.sampleMu, 252) - 1) * 100;
    box.innerHTML = `<b>追繳機率</b>（拔靴法、聯合重抽 ${r.sampleDays} 個交易日、已去除漂移）：
      3 日 ${f(r.odds[3])}　20 日 ${f(r.odds[20])}　60 日 ${f(r.odds[60])}
      <br>樣本期日均報酬 ${fmtMax(r.sampleMu * 100, 3)}%（年化 ${fmtMax(ann, 0)}%），
      已從模擬中扣除——照抄它等於假設這一年的行情重演。`;
  } catch {
    box.textContent = '追繳機率計算失敗。';
  }
}
