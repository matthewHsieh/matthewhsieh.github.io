import { donutChart } from '../charts.js';
import { ALERT_LABEL, alertBadge, heldAlerts } from '../alerts.js';
import { $, $$, esc, fmt, fmtCompact, fmtMax, fmtX, isNum, norm, num, pct, plClass, signed, state, sum } from '../core.js';
import { saveSnapshot } from '../data.js';
import { ackBannerHtml, ackDisclaimer, disclaimerAcked } from '../legal.js';
import { renderDropWatch } from './riskcard.js';
import { compute, exposureSlices } from '../portfolio.js';
import { optPnlAt } from '../instruments.js';
import { alertOf } from '../alerts.js';
import { callOdds, marginShocks, marginState, requiredRiskPct } from '../risk.js';
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
      ${line('選擇權 delta 曝險（買方淨、賣方毛）', c.optExposure)}
      ${c.optGrossExp !== c.optExposure
        ? line('　└ 絕對值加總（不分買賣）', c.optGrossExp, 0, 'sub') : ''}
      ${line('權證 delta 曝險', c.warExp)}
      ${line('期貨名目・多單', c.futLong)}
      ${line('期貨名目・空單', c.futShort)}
      ${line('總曝險', c.exposure, 0, 'total')}
      ${c.optExposure < 0 ? `<p class="hint">選擇權那一列是負的，因為手上的買方部位（買進賣權）
        是在<b>抵銷</b>方向曝險，不是增加。2026-10-09 改過這個算法：原本一律取絕對值，
        結果買 20 口價外賣權讓曝險倍數從 3.36x「漲」到 4.61x——
        <b>避險讓風險數字變大</b>，而那個數字還餵給總曝險規則，等於罰你做對的事。
        賣方仍然取絕對值（虧損無上限，淨掉會讓人用賣出買權把數字壓低）。</p>` : ''}
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
      ${line('delta 曝險（買方淨、賣方毛）', c.optExposure)}
      ${line('淨方向部位（多為正）', c.optNetDelta)}
      ${c.optBandOk ? `
      <div class="row-between line"><span><b>到期最大虧損</b>（漲跌幅限制下）</span><span class="${
        c.optBandLoss < 0 ? 'loss' : ''}">${fmt(Math.min(0, c.optBandLoss))}</span></div>
      <div class="row-between line"><span><b>到期最大獲利</b>（漲跌幅限制下）</span><span>${
        fmt(Math.max(0, c.optBandGain))}</span></div>
      <div class="row-between line sub-line"><span>　└ 理論界線（指數歸零／無限遠）</span><span class="muted">${
        c.optRiskUnlimited ? '虧損無上限' : `虧損 ${fmt(c.optMaxLoss)}`}　${
        c.optMaxGain === null ? '獲利無上限' : `獲利 ${fmt(c.optMaxGain)}`}</span></div>
      ${optPayoffTable(c)}
      ` : `
      <div class="row-between line"><span>到期最大虧損</span><span class="${c.optRiskUnlimited ? 'loss' : ''}">${
        c.optRiskUnlimited ? '無上限（賣出買權沒有被接住）' : fmt(c.optMaxLoss)}</span></div>
      ${c.optMaxGain === null ? '' : line('到期最大獲利', c.optMaxGain)}`}
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
      // 圓餅圖畫不出負的切片，所以避險的買方（買進賣權）沒有畫進去。
      // 差額要講出來，否則圖中央的「總曝險」會比上面的曝險倍數大一截，
      // 而兩個同名數字不一致比少一塊更糟。
      const offset = c.exposure - total;
      if (Math.abs(offset) > 1) {
        const p = document.createElement('p');
        p.className = 'hint';
        p.innerHTML = `圖上是 ${fmt(total)}，而曝險倍數用的是 <b>${fmt(c.exposure)}</b>——
          差額 ${fmt(offset)} 是<b>買方選擇權在抵銷方向曝險</b>（圓餅圖畫不出負的切片）。`;
        slot.appendChild(p);
      }
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
// 選擇權到期損益表
//
// 為什麼需要它：最大損益只給兩個端點，而中間長什麼樣常常跟直覺相反。
// 實測 2026-10-09 的 20 口 48000 賣權：delta 曝險是 −552 萬，
// 線性外推「指數跌 6.6%」應該值 36 萬，實際到期值 194 萬——**差 5.3 倍**。
// 那個差額就是凸性，也正是買價外賣權的理由。**delta 看不到它，這張表看得到。**
//
// 反過來小跌的時候 delta 會高估：跌 1~2% 時線性說賺 5~11 萬，
// 實際到期是歸零（還在價外）。所以 delta 只在很窄的一段有效，
// 兩頭都錯而且方向相反——這是最該讓人看到的一件事。
// ------------------------------------------------------------
function optPayoffTable(c) {
  const plans = c.optPlans || [];
  const ref = num(plans.find((p) => p.band)?.band?.ref);
  if (!(ref > 0)) return '';
  const moves = [0.02, 0, -0.02, -0.03, -0.05, -0.07, -0.10];
  const delta = num(c.optNetDelta);
  return `<div class="rc-scroll"><table class="rc-tab"><thead><tr>
      <th>到期指數</th><th>相對現在</th><th>整組到期損益</th><th>delta 線性預測</th><th>實際÷線性</th>
    </tr></thead><tbody>
    ${moves.map((m) => {
      const s = ref * (1 + m);
      const pnl = plans.reduce((a, p) => a + optPnlAt(state.options.filter((o) => String(o.expiry) === p.expiry), s), 0);
      const lin = delta * m;                       // delta 曝險 × 指數變動率
      // **只在兩者同號且實際為正時給倍數。** 反號的時候（例如指數小跌，
      // delta 線性說賺但實際到期歸零）算出來是 −0.5x 這種讀不出意思的數字，
      // 而那一格真正該傳達的是「delta 說會賺，實際不會」，用文字講比用倍數講清楚。
      const ratio = pnl > 0 && lin > 0 ? pnl / lin : null;
      return `<tr>
        <td>${fmt(s)}</td>
        <td>${m === 0 ? '不動' : `${m > 0 ? '+' : ''}${fmtMax(m * 100, 1)}%`}</td>
        <td class="${plClass(pnl)}">${signed(pnl)}</td>
        <td class="muted">${signed(lin)}</td>
        <td>${ratio === null ? '–' : `${fmtMax(ratio, 1)}x`}</td></tr>`;
    }).join('')}
    </tbody></table></div>
    <p class="hint"><b>「delta 線性預測」那一欄是用 delta 曝險 ${fmt(delta)} 乘上指數變動率算的，
      拿來跟實際對照。</b>兩者差很多的地方就是凸性——買價外賣權買的正是那一段，
      而 delta 完全看不到它。小跌時 delta 反而高估（還在價外，到期歸零），
      所以 <b>delta 只在很窄的一段有效，兩頭都錯而且方向相反</b>。<br>
      這也是 SEC 2020 年 Rule 18f-4 把 notional／delta 測試換成 VaR 的理由：
      notional 與 delta 都不是風險測度。</p>`;
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
  const sh = marginShocks(st);
  const req = requiredRiskPct(st, sh);
  const short = req.pct - (st.riskPct ?? 0);                 // 差幾個百分點
  const warn = st.pct < 0.10 || short > 0 ? ' alert-card' : '';
  return `<div class="card${warn}" data-margin>
    <div class="row-between">
      <span class="list-title" role="heading" aria-level="2">保證金</span>
      <span class="sub muted">期貨權益 ${fmt(st.equity)} ／ 名目 ${fmt(st.notional)}</span>
    </div>
    <div class="margin-kpi">
      <div><div class="sub muted">風險指標</div>
        <div class="big ${(st.riskPct ?? 1) < 1 ? 'loss' : ''}">${fmtMax((st.riskPct ?? 0) * 100, 1)}%</div>
        <div class="sub muted">權益 ÷ 原始保證金 ${fmt(st.init)}<br>低於 100% 會收到保證金不足通知</div></div>
      <div><div class="sub muted">必要風險指標</div>
        <div class="big ${short > 0 ? 'loss' : ''}">${fmtMax(req.pct * 100, 1)}%</div>
        <div class="sub muted">${req.worst
          ? `撐過「${esc(req.worst.label)}被處置」所需${short > 0
              ? `<br><b class="loss">差 ${fmtMax(short * 100, 1)} 個百分點</b>`
              : `<br>目前多 ${fmtMax(-short * 100, 1)} 個百分點`}`
          : '所有部位費率都已到頂，沒有進一步調升空間'}</div></div>
      <div><div class="sub muted">追繳距離</div>
        <div class="big ${st.pct < 0.10 ? 'loss' : ''}">${fmtMax(st.pct * 100, 1)}%</div>
        <div class="sub muted">名目再跌這麼多會被追繳<br>金額 ${fmt(st.amount)}
          ／加權維持率 ${fmtMax(st.mmBlended * 100, 2)}%</div></div>
    </div>
    <div class="sub" style="margin-top:.6rem"><b>如果這一檔被處置</b>
      <span class="muted">（費率調到階梯上的 ×2 那一格；×1.5 是較溫和的先例）</span></div>
    <div class="rc-scroll"><table class="rc-tab"><thead><tr>
      <th>標的</th><th>名目</th><th>佔保證金</th><th>原始率</th>
      <th>處置後</th><th>風險指標</th><th>等效跌幅</th></tr></thead><tbody>
      ${sh.map((x) => {
        const a = alertOf(x.symbol);
        const badge = a ? ' ' + alertBadge(a) : '';
        if (x.capped) return `<tr><td>${esc(x.label)}${badge}</td><td>${fmt(x.notional)}</td>
          <td>${fmt(x.share * 100)}%</td><td>${fmtMax(x.imRate * 100, 2)}%</td>
          <td colspan="3" class="muted">已達頂格（45.90%），沒有進一步調升空間</td></tr>`;
        return `<tr><td>${esc(x.label)}${badge}</td><td>${fmt(x.notional)}</td>
          <td>${fmt(x.share * 100)}%</td><td>${fmtMax(x.imRate * 100, 2)}%</td>
          <td>${fmtMax(x.toRate * 100, 2)}%<span class="muted"> ／${fmtMax(x.toRateMild * 100, 2)}%</span></td>
          <td class="${(x.riskPct ?? 1) < 1 ? 'loss' : ''}">${fmtMax((x.riskPct ?? 0) * 100, 1)}%<span class="muted"> ／${fmtMax((x.riskPctMild ?? 0) * 100, 1)}%</span></td>
          <td>${x.equivDrop == null ? '—' : fmtMax(x.equivDrop * 100, 1) + '%'}</td></tr>`;
      }).join('')}
    </tbody></table></div>
    <div data-margin-odds class="sub muted">追繳機率計算中…</div>
    <p class="hint">費率逐檔查自期交所（<code>fut_margin</code>）。保證金 =
      <b>標的證券收盤價 × 2,000 × 適用比例</b>（<b>沒有</b>乘漲停的 1.1——下單程式顯示的是
      券商預收，比規定數高一成，拿它當釋出額會高估減倉效果）。追繳距離
      <b>x &gt; (權益／名目 − 維持率) ÷ (1 − 維持率)</b>，
      名目下跌時維持保證金會跟著降，分母省掉會低估距離約 15%。
      <br><b>必要風險指標 = 1 + 最大「還有調升空間」部位佔原始保證金比</b>，是恆等式：
      費率調升後總額變 M+Δ，要維持 100% 就需要 E ≥ M+Δ。已在頂格的部位要排除，
      否則會對已經發生的事重複收費。
      <br><b>為什麼要有這張表</b>：2026-10-12 他沒有被價格打到——金居收 525、成本 525.74，
      完全平盤——是被<b>盤後公告</b>打到的，費率 22.95% → 45.90% 讓風險指標一夜從 103% 掉到 81%，
      等效於名目虧 6.5%（約 1.6σ）。而處置是<b>規則觸發</b>不是隨機事件：
      連續 5 次或十日內 6 次達注意標準就處置，<code>trade_alerts</code> 裡數得出來。
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
