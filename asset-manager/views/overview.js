import { donutChart } from '../charts.js';
import { ALERT_LABEL, alertBadge, heldAlerts } from '../alerts.js';
import { $, $$, esc, fmt, fmtCompact, fmtX, isNum, norm, num, pct, plClass, signed, state, sum } from '../core.js';
import { saveSnapshot } from '../data.js';
import { compute, exposureSlices } from '../portfolio.js';
import { bindStockOpen } from './stock.js';
import { bindListActions, line, priceStamp, stalenessNote, stat, tradeButton } from '../widgets.js';

export function renderOverview(el) {
  const c = compute();
  const last = state.snapshots[0];
  const diff = last ? c.netAssets - num(last.net_assets) : null;
  const progressWidth = Math.min(100, Math.max(0, (isNum(c.progress) ? c.progress : 0) * 100)).toFixed(1);

  el.innerHTML = `
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
    ${(() => {
      // 持倉裡有被交易所盯上的就要先講。等他自己去點開個股才發現就太晚了。
      const as = heldAlerts();
      if (!as.length) return '';
      return `<div class="card alert-card">
        <div class="list-title">交易所警示　<span class="sub muted">${fmt(as.length)} 檔</span></div>
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
      <div class="row-between"><span class="list-title">目標金額</span><span>${c.target > 0 ? fmt(c.target) : '<span class="muted">未設定</span>'}</span></div>
      <div class="bar"><div class="bar-fill" style="width:${progressWidth}%"></div></div>
      <div class="row-between sub">
        <span>${pct(c.progress)}</span>
        <span class="muted">${c.target > 0 ? (c.netAssets >= c.target ? '已達標 🎉' : '還差 ' + fmt(c.target - c.netAssets)) : '到「設定」輸入目標'}</span>
      </div>
    </div>
    <div class="card" id="donut-card">
      <div class="row-between">
        <span class="list-title">組成</span>
        <div class="seg-toggle" id="donut-toggle">
          <button type="button" data-donut="assets">資產組成</button>
          <button type="button" data-donut="exposure">曝險明細</button>
        </div>
      </div>
      <div id="donut-slot"></div>
    </div>
    <div class="card list">
      <div class="list-title">曝險</div>
      ${line('台股市值', c.stockValue)}
      ${line('複委託市值', c.usValue)}
      ${line('指數期貨名目', c.futIndex)}
      ${line('個股期貨名目', c.futStock)}
      ${line('選擇權 delta 曝險', c.optExposure)}
      ${line('權證 delta 曝險', c.warExp)}
      ${line('期貨名目・多單', c.futLong)}
      ${line('期貨名目・空單', c.futShort)}
      ${line('總曝險', c.exposure)}
      ${c.warNoDelta || c.optNoDelta ? `<p class="hint warn-hint">⚠ 有${
        [c.warNoDelta ? '權證' : '', c.optNoDelta ? '選擇權' : ''].filter(Boolean).join('、')
        }部位還沒算出 delta，<b>這些部位目前沒有計入上面的總曝險</b>，實際曝險比顯示的高。
        按右上角 ↻ 重新整理，或等下次自動更新。</p>` : ''}
    </div>
    ${state.warrants.length ? `<div class="card list">
      <div class="list-title">權證風險</div>
      ${line('權證市值', c.warMarket)}
      ${line('delta 曝險', c.warExp)}
      ${line('最大損失（買方賠光權利金）', c.warMaxLoss)}
      <div class="row-between line"><span>每日時間價值流失</span><span class="loss">${fmt(c.warTheta)}</span></div>
      <p class="hint">權證的隱含波動率由發行券商決定，可以在發行後調降，這會讓權證價格下跌但 delta 完全反映不出來。
        系統每天記錄各檔隱波，被調降時會在「持倉」標示。${c.warNoDelta ? '<br>⚠ 有部位還沒算出 delta。' : ''}</p>
    </div>` : ''}
    ${state.options.length ? `<div class="card list">
      <div class="list-title">選擇權風險</div>
      ${line('權利金市值（買方正、賣方負）', c.optMarket)}
      ${line('delta 曝險（絕對值加總）', c.optExposure)}
      ${line('淨方向部位（多為正）', c.optNetDelta)}
      <div class="row-between line"><span>最大風險</span><span class="${c.optRiskUnlimited ? 'loss' : ''}">${
        c.optRiskUnlimited ? '無上限（有賣出買權）' : fmt(c.optMaxLoss)}</span></div>
      <p class="hint">delta 曝險是線性近似，大幅波動時實際曝險會比這個數字放大（gamma），賣方尤其明顯。
        所以最大風險另外列出，不併進槓桿。${c.optNoDelta ? '<br>⚠ 有部位還沒算出 delta，按右上角 ↻ 或等下次自動更新。' : ''}</p>
    </div>` : ''}
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
  bindListActions(el);
  bindStockOpen(el);
}
