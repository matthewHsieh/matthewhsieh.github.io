import { $, esc, fail, fmt, num, sb, state, toast } from '../core.js';
import { MARKET_NAME, newestAsOf, refreshPrices, statusOf } from '../data.js';
import { disclaimerCardHtml } from '../legal.js';
import { render } from '../render.js';
import { TW_ENTRIES } from '../symbols.js';
import { DEFAULT_FEES, feeCfg } from '../trades.js';
import { priceStamp } from '../widgets.js';

export function renderSettings(el) {
  const st = state.settings;
  el.innerHTML = `
    <form id="settings-form" class="card">
      <div class="list-title" role="heading" aria-level="2">目標與匯率</div>
      <label>目標金額（淨資產, TWD）<input name="target_amount" type="number" step="any" inputmode="numeric" value="${esc(num(st.target_amount))}"></label>
      <label>美金匯率（1 USD = ? TWD，每日自動更新）<input name="usd_twd" type="number" step="any" inputmode="decimal" value="${esc(num(st.usd_twd))}"></label>
      <button type="submit" class="primary block">儲存設定</button>
    </form>
    <form id="fee-form" class="card">
      <div class="list-title" role="heading" aria-level="2">交易成本</div>
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
      <div class="list-title" role="heading" aria-level="2">法定稅率（不可改）</div>
      <div class="row-between line"><span>台股賣出</span><span>0.300%</span></div>
      <div class="row-between line"><span>台股當沖賣出</span><span>0.150%（政府減半）</span></div>
      <div class="row-between line"><span>權證賣出</span><span>0.100%</span></div>
      <div class="row-between line"><span>期貨（買賣各一次）</span><span>0.002%</span></div>
      <div class="row-between line"><span>選擇權（買賣各一次）</span><span>0.100%</span></div>
      <p class="hint">當沖降稅 0.15% 已延長至 2027-12-31，查證日期 2026-09-08。
        <b>只有台股現股當沖有減半優惠</b>；期貨、選擇權、權證都沒有，買賣各課一次全額。</p>
    </div>
    <div class="card">
      <div class="list-title" role="heading" aria-level="2">行情更新</div>
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
        按下去會一項一項抓，大約 6 秒；某一項失敗不影響其他項。
        報價是<b>全站共用的一份</b>，剛剛已經有人抓過的話會直接給你那一份，不會再去打來源一次
        （報價 60 秒內、營收與分析師預估 10 分鐘內）。</p>
    </div>
    <div class="card">
      <div class="list-title" role="heading" aria-level="2">帳號</div>
      <p class="muted">${esc(state.user.email || '')}</p>
      <button type="button" class="block" id="logout-btn">登出</button>
      <div class="danger-zone">
        <div class="row-between">
          <span><b>刪除帳號</b></span>
          <button type="button" class="small danger" id="del-acct">刪除帳號</button>
        </div>
        <p class="sub muted">把部位、交易紀錄、快照、心得、紀律規則與設定全部刪掉，並註銷登入帳號。
          <b>刪掉就救不回來</b>，這裡沒有備份也沒有垃圾桶。要留底的話先到「紀錄」頁自己抄一份。</p>
      </div>
    </div>
    ${disclaimerCardHtml()}
    <div class="card">
      <div class="list-title" role="heading" aria-level="2">數字怎麼算</div>
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
            最大損益<b>按到期別整組算</b>：把同一個到期的每一腳到期價值加起來，再減掉淨權利金。
            歐式選擇權組合的到期損益是分段線性的，轉折只在履約價上，所以極值只可能落在
            「0、每一個履約價、右邊無限遠」。右端看買權的淨口數：為正 = 獲利無上限、
            為負 = 虧損無上限、為 0 = 兩邊都封死。<br>
            所以「賣出買權無上限」只在它沒有被接住的時候成立——買低履約 ＋ 賣高履約
            （買權多頭價差）的最大虧損就是淨支出。<b>不同到期別不能合併算</b>，各算各的。<br>
            delta 由期交所每日結算價用 Black-76 反推，每天自動更新。</dd>
        <dt>期貨損益</dt><dd>多單（現價 − 平均成本）、空單（平均成本 − 現價），再乘口數與規格。沒填平均成本就不顯示損益。</dd>
      </dl>
      <p class="hint">台股名稱清單 ${TW_ENTRIES.length} 檔。價格來源：證交所、櫃買中心、期交所、Yahoo Finance。</p>
    </div>

    <div class="card">
      <div class="list-title" role="heading" aria-level="2">配置最佳化到底做到了什麼</div>
      <p class="hint" style="margin-top:6px">「配置」頁那個<b>組合報酬/波動</b>是用估出來的預期報酬與共變異數算的，
        <b>不是保證，也不是實測績效</b>。下面這張表是同樣的選股（比值前 15 檔）、
        只換權重方法，跑 2022-2026、36 個不重疊的 20 日換股點的<b>樣本外</b>結果。</p>
      <div class="rc-scroll"><table class="rc-tab"><thead><tr>
        <th>權重方法</th><th>報酬/波動</th><th>年化</th><th>波動</th><th>最差一期</th>
      </tr></thead><tbody>
        <tr><td>等權</td><td>1.74</td><td>48.4%</td><td>27.8%</td><td>-11.1%</td></tr>
        <tr><td>反波動（1/σ）</td><td>1.73</td><td>44.6%</td><td>25.8%</td><td>-11.1%</td></tr>
        <tr><td>最小變異數</td><td>1.72</td><td>41.9%</td><td>24.4%</td><td>-10.1%</td></tr>
        <tr><td><b>本 App（收縮 0.5、上限 35%）</b></td><td><b>1.86</b></td>
            <td>57.4%</td><td>30.8%</td><td>-10.1%</td></tr>
        <tr><td>積極（收縮 0.85、上限 60%）</td><td>1.79</td><td>63.0%</td><td>35.3%</td><td>-9.6%</td></tr>
        <tr><td>教科書 MVO（不收縮、無上限）</td><td>1.73</td><td>64.7%</td><td>37.3%</td><td>-10.2%</td></tr>
      </tbody></table></div>
      <dl class="defs">
        <dt>四種方法的報酬/波動幾乎一樣（1.72~1.86）</dt>
        <dd>36 期的估計誤差遠大於這個差距。最佳化真正做到的不是「更有效率」，是
            <b>承擔更多風險</b>（波動 30.8% vs 等權 27.8%）——而那件事你自己調曝險倍率就做得到。</dd>
        <dt>拿掉護欄會變差</dt>
        <dd>教科書 MVO（不收縮、不設上限）是所有最佳化版本裡<b>最差的 1.73</b>，跟等權一樣。
            Michaud 稱之為 "error maximizer"：它會專挑估計誤差最大的方向壓下去。
            那個 50% 收縮與 35% 單檔上限不是保守，是它們把差距買回來的。</dd>
        <dt>真正決定結果的是選股與總曝險，不是權重</dt>
        <dd>這是整張表最有用的一句話。花時間在「買哪些、總共開多大」，不要花在「權重要不要再調一點」。</dd>
        <dt>為什麼不可能是真的最佳解</dt>
        <dd>預期報酬是過去三年的比值，而 MVO 對它極度敏感；共變異數是估出來的
            （20 檔要估 210 個參數，樣本只有 250 天）；<b>波動不等於風險</b>——跳空、
            流動性、尾部這個模型一個都看不到；而且它是單期最佳化，沒有交易成本與換股動態。</dd>
        <dt>但書：回測期間本身是大多頭</dt>
        <dd>2022-09~2026-09 指數 3.40 倍、年化 36%，任何做多的東西都好看。
            宇宙是「今天」有掛個股期貨的 251 檔，有倖存者偏差。
            照 McLean &amp; Pontiff (JF 2016)，論文發表後報酬平均低 58%——自己跑的回測先打對折。</dd>
      </dl>
      <p class="hint">結論：它給你一個<b>有紀律、可複製、不會亂來</b>的配置，
        而不是一個更會賺的配置。價值在「每次都用同一把尺」，不在「這把尺特別準」。</p>
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
  // 跟右上角 ↻ 走同一條路，進度也顯示在同一條進度條上，
  // 不要一個用按鈕文字、一個用 toast 各講各的
  $('#force-price', el).onclick = async () => {
    const b = $('#force-price', el);
    b.disabled = true; b.textContent = '更新中…';
    try {
      await refreshPrices({ force: true });
    } finally {
      // render() 可能已經把整頁重畫過，這個按鈕可能不在了
      const again = $('#force-price');
      if (again) { again.disabled = false; again.textContent = '立即重新抓取報價'; }
    }
  };
  $('#logout-btn', el).onclick = async () => {
    const { error } = await sb.auth.signOut();
    if (error) fail(error);
  };

  // 刪帳號要打字確認，不能只按一次 OK。
  // **一個 confirm() 太便宜了**——這是全 app 唯一不可逆的動作，
  // 手滑按到跟真心想刪的代價差太多，所以要求把 email 打出來。
  $('#del-acct', el).onclick = async () => {
    const email = String(state.user.email || '');
    const typed = prompt(
      `這會刪掉你所有的資料，而且救不回來。\n\n確定的話，請輸入你的 email：\n${email}`);
    if (typed === null) return;                       // 按取消
    if (typed.trim().toLowerCase() !== email.toLowerCase()) return toast('email 不符，已取消');

    const b = $('#del-acct', el);
    b.disabled = true; b.textContent = '刪除中…';
    const { data, error } = await sb.rpc('delete_me', {});
    if (error) {
      b.disabled = false; b.textContent = '刪除帳號';
      return fail(error);
    }
    // 回報刪了什麼。使用者按下去之後看到「刪了 82 筆交易紀錄」，
    // 比只看到一句「已刪除」更確定事情真的發生了。
    const n = Object.values(data || {}).reduce((a, v) => a + num(v), 0);
    toast(`已刪除 ${fmt(n)} 筆資料，帳號已註銷`, 5000);
    await sb.auth.signOut();
    location.reload();
  };
}
