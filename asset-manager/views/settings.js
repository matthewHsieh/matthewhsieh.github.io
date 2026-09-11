import { $, esc, fail, fmt, num, sb, state, toast } from '../core.js';
import { MARKET_NAME, loadAll, newestAsOf, refreshSummary, runStagedRefresh, statusOf } from '../data.js';
import { render } from '../render.js';
import { TW_ENTRIES } from '../symbols.js';
import { DEFAULT_FEES, feeCfg } from '../trades.js';
import { priceStamp } from '../widgets.js';

export function renderSettings(el) {
  const st = state.settings;
  el.innerHTML = `
    <form id="settings-form" class="card">
      <div class="list-title">目標與匯率</div>
      <label>目標金額（淨資產, TWD）<input name="target_amount" type="number" step="any" inputmode="numeric" value="${esc(num(st.target_amount))}"></label>
      <label>美金匯率（1 USD = ? TWD，每日自動更新）<input name="usd_twd" type="number" step="any" inputmode="decimal" value="${esc(num(st.usd_twd))}"></label>
      <button type="submit" class="primary block">儲存設定</button>
    </form>
    <form id="fee-form" class="card">
      <div class="list-title">交易成本</div>
      <p class="sub muted">稅率是法定的、不能改。手續費因券商與折數而異，填你實際的。</p>
      <label>台股手續費率（標準 0.001425）
        <input name="fee_stock_rate" type="number" step="any" inputmode="decimal" value="${esc(feeCfg('fee_stock_rate'))}"></label>
      <label>券商手續費折數（1 = 不打折，0.3 = 三折）
        <input name="fee_stock_disc" type="number" step="any" inputmode="decimal" value="${esc(feeCfg('fee_stock_disc'))}"></label>
      <label>每筆最低手續費（元）
        <input name="fee_min" type="number" step="any" inputmode="decimal" value="${esc(feeCfg('fee_min'))}"></label>
      <label>權證手續費折數
        <input name="fee_warrant_disc" type="number" step="any" inputmode="decimal" value="${esc(feeCfg('fee_warrant_disc'))}"></label>
      <label>期貨手續費（元／口，<b>買賣各收一次</b>）
        <input name="fee_fut_per_lot" type="number" step="any" inputmode="decimal" value="${esc(feeCfg('fee_fut_per_lot'))}"></label>
      <label>選擇權手續費（元／口，<b>買賣各收一次</b>）
        <input name="fee_opt_per_lot" type="number" step="any" inputmode="decimal" value="${esc(feeCfg('fee_opt_per_lot'))}"></label>
      <label>複委託手續費率（買賣各一次，0.001 = 0.1%）
        <input name="fee_us_rate" type="number" step="any" inputmode="decimal" value="${esc(feeCfg('fee_us_rate'))}"></label>
      <label>複委託每筆最低（USD）
        <input name="fee_us_min" type="number" step="any" inputmode="decimal" value="${esc(feeCfg('fee_us_min'))}"></label>
      <button type="submit" class="primary block">儲存費率</button>
      <p class="hint">折數是跟券商談的，<b>當沖和波段都一樣</b>；當沖影響的只有政府的證交稅（減半）。
        期貨與選擇權是每口固定金額，<b>買進收一次、賣出再收一次</b>，所以一口來回是填的兩倍。複委託也是買賣各收一次。
        ${feeCfg('fee_us_min') > 0 ? '' : '若複委託有每筆最低收費，記得填。'}
        ${feeCfg('fee_us_rate') > 0 ? '' : '<br>⚠ 複委託費率還沒設定，美股交易的成本目前不計入。'}</p>
    </form>
    <div class="card">
      <div class="list-title">法定稅率（不可改）</div>
      <div class="row-between line"><span>台股賣出</span><span>0.300%</span></div>
      <div class="row-between line"><span>台股當沖賣出</span><span>0.150%（政府減半）</span></div>
      <div class="row-between line"><span>權證賣出</span><span>0.100%</span></div>
      <div class="row-between line"><span>期貨（買賣各一次）</span><span>0.002%</span></div>
      <div class="row-between line"><span>選擇權（買賣各一次）</span><span>0.100%</span></div>
      <p class="hint">當沖降稅 0.15% 已延長至 2027-12-31，查證日期 2026-09-08。
        <b>只有台股現股當沖有減半優惠</b>；期貨、選擇權、權證都沒有，買賣各課一次全額。</p>
    </div>
    <div class="card">
      <div class="list-title">行情更新</div>
      <p class="muted sub">${priceStamp()}</p>
      <div class="table-wrap"><table>
        <thead><tr><th>市場</th><th>資料日期</th><th>檔數</th></tr></thead>
        <tbody>${['tw', 'fut', 'us', 'fx'].map((m) => {
          const p = statusOf(m);
          const stale = p?.as_of && newestAsOf() && p.as_of < newestAsOf();
          return `<tr><td>${MARKET_NAME[m]}</td>
            <td class="${stale ? 'loss' : ''}">${p?.as_of ?? '–'}${stale ? ' ⚠' : ''}</td>
            <td>${p ? fmt(p.symbols) : '–'}</td></tr>`;
        }).join('')}</tbody>
      </table></div>
      <button type="button" class="block" id="force-price">立即重新抓取報價</button>
      <p class="hint">每個交易日 14:30、16:00、18:00、21:00（台股／期貨／選擇權／權證／匯率）與隔日 06:00（美股）自動更新，
        並自動存一筆快照。手機沒開也會跑，平常不需要按這個按鈕。
        按下去會一項一項抓，大約 6 秒；某一項失敗不影響其他項。</p>
    </div>
    <div class="card">
      <div class="list-title">帳號</div>
      <p class="muted">${esc(state.user.email || '')}</p>
      <button type="button" class="block" id="logout-btn">登出</button>
    </div>
    <div class="card">
      <div class="list-title">數字怎麼算</div>
      <dl class="defs">
        <dt>總資產</dt><dd>台股市值 ＋ 複委託市值（換算 TWD）＋ 期貨帳戶權益數 ＋ 現金/存款</dd>
        <dt>淨資產</dt><dd>總資產 － 負債</dd>
        <dt>槓桿①（資產槓桿）</dt><dd>總資產 ÷ 淨資產</dd>
        <dt>槓桿②（曝險槓桿）</dt><dd>（台股 ＋ 複委託 ＋ 期貨名目）÷ <b>總資產</b>，指數期貨與個股期貨都算</dd>
        <dt>指數期貨名目</dt><dd>口數 × 結算價 × 每點價值（大台 200、小台 50、微台 10）</dd>
        <dt>個股期貨名目</dt><dd>口數 × 標的股價 × 等同股數（大型 2,000 股 ＝ 2 張、小型 100 股）</dd>
        <dt>權證（1 張 = 1000 單位）</dt>
        <dd>市值 = 張數 × 1000 × 權證價，計入總資產。<br>
            delta 曝險 = 張數 × 1000 × 行使比例 × delta × 標的股價，計入槓桿②。<br>
            最大損失 = 付出的權利金，買方不會賠更多。<br>
            隱波、delta、theta、實質槓桿由每日收盤價自動反推。約半數權證當天沒成交，
            這時用造市商的委買賣中價評價。<br>
            <b>隱波是發行券商唯一能事後操縱的參數</b>，調降會讓權證價格下跌而 delta 看不出來，
            所以系統每天留存隱波，被調降時會標示。界限型與重設型模型不適用，delta 請手動填。</dd>
        <dt>選擇權（TXO，每點 50 元）</dt>
        <dd>權利金市值 = 口數 × 權利金 × 50，買方為正、賣方為負，計入總資產。<br>
            delta 曝險 = 口數 × delta × 隱含遠期指數 × 50，計入槓桿②。<br>
            最大風險：買方 = 權利金；賣方賣權 =（履約價 − 權利金）× 口數 × 50；賣方買權無上限。<br>
            delta 由期交所每日結算價用 Black-76 反推，每天自動更新。</dd>
        <dt>期貨損益</dt><dd>多單（現價 − 平均成本）、空單（平均成本 − 現價），再乘口數與規格。沒填平均成本就不顯示損益。</dd>
      </dl>
      <p class="hint">台股名稱清單 ${TW_ENTRIES.length} 檔。價格來源：證交所、櫃買中心、期交所、Yahoo Finance。</p>
    </div>`;
  $('#settings-form', el).onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = { user_id: state.user.id, target_amount: num(fd.get('target_amount')), usd_twd: num(fd.get('usd_twd')) };
    const { error } = await sb.from('settings').upsert(payload);
    if (error) return fail(error);
    state.settings = { ...state.settings, ...payload };
    toast('設定已儲存');
  };
  $('#fee-form', el).onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = { user_id: state.user.id };
    for (const k of Object.keys(DEFAULT_FEES)) payload[k] = num(fd.get(k));
    const { error } = await sb.from('settings').upsert(payload);
    if (error) return fail(error);
    state.settings = { ...state.settings, ...payload };
    render();
    toast('費率已儲存');
  };
  $('#force-price', el).onclick = async () => {
    const b = $('#force-price', el);
    b.disabled = true;
    try {
      const done = await runStagedRefresh((label) => { b.textContent = `更新中：${label}…`; });
      await loadAll(); render();
      const bad = refreshSummary(done);
      toast(bad ? bad + '，其餘已更新' : `報價已更新（${statusOf('tw')?.as_of ?? ''}）`, bad ? 5000 : 2500);
    } catch (e) {
      fail(e);
      b.disabled = false; b.textContent = '立即重新抓取報價';
    }
  };
  $('#logout-btn', el).onclick = async () => {
    const { error } = await sb.auth.signOut();
    if (error) fail(error);
  };
}
