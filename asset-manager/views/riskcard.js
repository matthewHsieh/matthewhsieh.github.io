import { $, $$, esc, fail, fmt, fmtMax, isNum, norm, num, sb, state, toast } from '../core.js';
import {
  IM_RATE, assumedMu, dropZ, exposureRows, indexSignal, loadSeries, marginRoom, maxSharpe,
  moveOdds, portVol, riskContrib, riskParity, scaleTo, sharpeOf, statsOf, usableKeys,
} from '../risk.js';
import { compute } from '../portfolio.js';
import { TW_STOCKS, attachLookup, resolveTwSymbol } from '../symbols.js';

// ============================================================
// 組合風險 ＋ 配置試算
//
//   上半：現在的部位有多少風險、誰在製造它、離追繳多遠。
//   下半：挑幾檔進來，算出「同樣的風險該怎麼分」。
//
//   **兩邊用同一套數學**，不然試算出來的數字跟實際持倉的數字對不起來，
//   使用者會不知道該信哪一個。
// ============================================================

const PICK_KEY = 'allocPicks';

// **目標用「指數的幾倍」，不要用固定的波動百分比。**
//   30% 這個數字在指數波動 24% 的年份是 1.25 倍，在 32% 的年份只有 0.94 倍——
//   同一個標籤在不同時期代表不同的風險。講「等同於現在的大盤開幾倍」
//   才是一個穩定的、他腦子裡真的在用的單位。
const TARGETS = [0.75, 1, 1.5, 2];
const MODE_KEY = 'allocMode';
const NOFIN_KEY = 'allocNoFin';

// 排除產業。目前只有「金融保險業」一個選項——他明講不想持有金融股。
// **傳 null 而不是空陣列**：空陣列在 SQL 那邊 `<> all ('{}')` 永遠為真，
// 等於沒有排除，但看起來像有在過濾。
const EXCL = () => (localStorage.getItem(NOFIN_KEY) === '1' ? ['金融保險業'] : null);

const DDK_KEY = 'allocDdK';

// 位階加權：ratio_adj = (年化報酬 ＋ 從三個月高點的跌幅) ÷ 波動
//
//   回測（48 個不重疊換股點、配對檢定）：每期 +0.27%、t = +1.28，**不顯著**；
//   換持股檔數也沒有一致性。但它有統計以外的理由——比值的分子是過去 250 日的
//   報酬，一檔剛跌 20% 的股票，分子正是因為這段跌幅而變低的；加回去約等於問
//   「不算這一段回檔，它的報酬是多少」，那是在拿掉回頭看才有的偏誤。
//   所以做成選項、預設關閉，開了會在畫面上把兩個比值都列出來。
const ddK = () => (localStorage.getItem(DDK_KEY) === '1' ? 1 : 0);
const DEF_IDX_VOL = 0.27;   // 抓不到指數序列時的退路

const picks = () => {
  try {
    const v = JSON.parse(localStorage.getItem(PICK_KEY) || '[]');
    return Array.isArray(v) ? v.map(String) : [];
  } catch { return []; }
};
const setPicks = (v) => localStorage.setItem(PICK_KEY, JSON.stringify([...new Set(v)]));

// 快取已經載到的日報酬，換頁回來不用重抓
const cache = () => (state.retSeries ||= new Map());

async function ensure(symbols) {
  const want = symbols.filter((s) => s && !cache().has(s));
  if (!want.length) return false;
  const got = await loadSeries([...want, 'TAIEX']);
  for (const s of [...want, 'TAIEX']) cache().set(s, got.get(s) || null);
  return true;
}

const labelOf = (sym) => {
  const s = String(sym);
  if (s === 'TAIEX') return '加權指數（台指期）';
  if (s.startsWith('IDX:')) return s.slice(4);
  return TW_STOCKS[s] ? `${s} ${TW_STOCKS[s]}` : s;
};

// 指數期貨每點價值：大台 200、小台 50、微台 10
const IDX_SIZES = [['大台 TX', 200], ['小台 MTX', 50], ['微台 TMF', 10]];

// 指數的「一口」要用台指期算，不是個股期貨。
//   **顆粒度差很多**：微台一口約 46 萬，小台 229 萬。
//   風險等價下指數常常配到很大的權重，用小台會調不準。
function idxLots(exposure) {
  const lvl = num((state.riskStats || []).find((x) => String(x.symbol) === 'TAIEX')?.last);
  if (!(lvl > 0)) return '–';
  const micro = exposure / (lvl * 10);
  const mini = exposure / (lvl * 50);
  return `${fmtMax(micro, 1)} 口<span class="sub muted">微台／小台 ${fmtMax(mini, 2)} 口</span>`;
}

// 個股期貨一口的名目（大型 2,000 股）。沒有現價就回 null，寧可不給數字。
function lotValue(sym) {
  const f = (state.futures || []).find((x) => norm(x.symbol) === norm(sym) && x.kind === 'stock');
  if (f && num(f.price) > 0) return num(f.price) * num(f.size || 2000);
  const r = (state.riskStats || []).find((x) => String(x.symbol) === String(sym));
  if (r && num(r.last) > 0) return num(r.last) * 2000;
  const s = (state.stocks || []).find((x) => norm(x.symbol) === norm(sym));
  if (s && num(s.price) > 0) return num(s.price) * 2000;
  return null;
}

// 美股沒有個股期貨，給股數。**曝險要除以槓桿倍數**——
// 2 倍 ETF 買 100 股承受的是 200 股的波動，照曝險直接除股價會買成兩倍。
function usShares(sym, exposure) {
  const u = (state.us || []).find((x) => norm(x.symbol) === norm(sym));
  const rate = num(state.settings?.usd_twd) || 32;
  const lev = u && isNum(u.leverage) ? Math.abs(num(u.leverage)) : 1;
  const px = u && num(u.price_usd) > 0 ? num(u.price_usd)
    : num((state.usStats || []).find((x) => String(x.symbol) === String(sym))?.price);
  if (!(px > 0)) return '–';
  return `${fmt(exposure / (px * rate * lev))} 股`;
}

const bar = (pct) => `<span class="rc-bar"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></span>`;

// ---------- 上半：現在的風險 ----------
function currentBlock(c) {
  const rows = exposureRows().filter((r) => !r.key.startsWith('IDX:'));
  const idx = exposureRows().filter((r) => r.key.startsWith('IDX:'));
  const keys = rows.map((r) => r.key);
  const loaded = keys.filter((k) => cache().get(k));
  const pickable = usableKeys(cache(), loaded);
  const have = pickable.kept;
  const st = statsOf(cache(), have);
  const miss = [...keys.filter((k) => !cache().get(k)), ...pickable.dropped];

  if (!st) {
    return `<p class="muted">還沒有足夠的日報酬資料可以算組合波動${
      miss.length ? `（缺 ${miss.map(esc).join('、')}）` : ''}。每小時的排程會自動補上。</p>`;
  }
  const assets = num(c.totalAssets);
  const w = have.map((k) => num(rows.find((r) => r.key === k).exposure) / assets);
  const pv = portVol(w, st);
  const rc = riskContrib(w, st);
  const twii = cache().get('TAIEX');
  const ivol = twii ? statsOf(cache(), ['TAIEX'])?.vol[0] : null;
  const daily = pv / Math.sqrt(252);

  // 個股期貨的追繳距離
  const notional = (state.futures || []).reduce(
    (a, f) => a + num(f.lots) * num(f.price) * num(f.size), 0);
  const eq = num(c.futEquity);
  const mr = notional > 0 ? marginRoom(notional, eq) : null;
  const worstVol = Math.max(...have.map((k, i) => st.vol[i]), 0);
  const odds = mr && mr.pct > 0 ? moveOdds(mr.pct, worstVol) : null;

  const totExp = have.reduce((a, k) => a + num(rows.find((r) => r.key === k).exposure), 0);
  const list = have.map((k, i) => {
    const r = rows.find((x) => x.key === k);
    return { k, label: labelOf(k), exp: num(r.exposure), vol: st.vol[i], rc: rc[i] / pv };
  }).sort((a, b) => b.rc - a.rc);

  return `
    <div class="rc-kpis">
      <div><span class="rc-k">組合年化波動</span><b class="${pv > 1 ? 'loss' : ''}">${fmt(pv * 100)}%</b>
        ${ivol ? `<span class="sub muted">≈ 指數開 ${fmtMax(pv / ivol, 1)} 倍</span>` : ''}</div>
      <div><span class="rc-k">一天的標準差</span><b>${fmtMax(daily * 100, 1)}%</b>
        <span class="sub muted">${fmt(assets * daily)} 元／天</span></div>
      ${mr ? `<div><span class="rc-k">離追繳</span><b class="${
        mr.pct < 0.25 ? 'loss' : ''}">${mr.pct === null ? '–' : fmtMax(mr.pct * 100, 1) + '%'}</b>
        <span class="sub muted">${odds ? `一個月內走到約 ${fmt(odds.p * 100)}%` : ''}</span></div>` : ''}
    </div>
    <div class="rc-scroll"><table class="rc-tab"><thead><tr><th>標的</th><th>波動</th><th>曝險佔比</th><th>風險佔比</th></tr></thead><tbody>
    ${list.map((x) => `<tr>
      <td>${esc(x.label)}</td>
      <td>${fmt(x.vol * 100)}%</td>
      <td>${fmt(totExp ? (x.exp / totExp) * 100 : 0)}%</td>
      <td>${fmt(x.rc * 100)}% ${bar(x.rc * 100)}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="sub muted">樣本 ${st.days} 個交易日${
      miss.length ? `　未納入：${miss.map(esc).join('、')}（資料太短或還沒抓到）` : ''}</p>
    ${idx.length ? `<p class="sub muted">指數期貨未納入個股相關係數計算：${
      idx.map((r) => esc(r.label)).join('、')}</p>` : ''}
    <p class="hint">風險佔比是「這一檔對組合波動的貢獻」，加起來等於 100%。
      <b>它跟曝險佔比常常差很多</b>——高波動的標的用少少的錢就能佔掉大部分風險。
      追繳距離假設原始保證金 ${fmtMax(IM_RATE * 100, 1)}%、維持保證金為它的 75%，實際依標的與期貨商而定。</p>`;
}

// ---------- 下半：配置試算 ----------
function allocBlock(c) {
  const sel = picks();
  const loaded = sel.filter((s) => cache().get(s));
  const pickable = usableKeys(cache(), loaded);
  const have = pickable.kept;
  const assets = num(c.totalAssets);
  const sig = indexSignal(cache(), (state.riskStats || []).find((x) => String(x.symbol) === 'TAIEX'));
  // 預設就跟規則走；他手動選過才用他選的
  const mult = state.allocTarget === undefined
    ? (sig ? Math.round(sig.lev * 100) / 100 : 1)
    : num(state.allocTarget);

  // **指數波動要跟組合用同一段樣本。** 分開算的話，標籤上寫「指數 1 倍」
  // 用的是指數自己 260 天的 26%，表格裡卻顯示 31%（150 天交集），
  // 兩個數字打架，使用者不知道該信哪個。把 TAIEX 一起丟進去算就一致了。
  const withIdx = have.includes('TAIEX') ? have : [...have, 'TAIEX'];
  const stIdx = cache().get('TAIEX') && have.length ? statsOf(cache(), withIdx) : null;
  const ivol = stIdx ? stIdx.vol[withIdx.indexOf('TAIEX')]
    : (cache().get('TAIEX') ? statsOf(cache(), ['TAIEX'])?.vol[0] ?? DEF_IDX_VOL : DEF_IDX_VOL);
  const target = mult * ivol;

  const head = `
    <div class="rc-add">
      <label>加入標的<input type="text" id="rc-sym" autocomplete="off"
        autocapitalize="characters" placeholder="台股代號／名稱、美股代號，或「台指」"></label>
      <button type="button" class="small" id="rc-add">＋ 加入</button>
      <button type="button" class="small" id="rc-top">★ 推薦 20 檔</button>
      <button type="button" class="small" id="rc-clear">清空</button>
    </div>
    <label class="chk rc-chk"><input type="checkbox" id="rc-nofin" ${
      localStorage.getItem(NOFIN_KEY) === '1' ? 'checked' : ''}>
      <span>排除金融股（推薦與位階警示都套用）</span></label>
    <label class="chk rc-chk"><input type="checkbox" id="rc-ddk" ${
      localStorage.getItem(DDK_KEY) === '1' ? 'checked' : ''}>
      <span>位階加權：比值改用（報酬 ＋ 三個月跌幅）÷ 波動</span></label>
    <div class="seg rc-seg">${[['sharpe', '最佳報酬/波動'], ['aggr', '潛在報酬最大'],
      ['parity', '風險平價']].map(([v, lab]) => `<label><input type="radio" name="rcmode"
      value="${v}" ${(localStorage.getItem(MODE_KEY) || 'sharpe') === v ? 'checked' : ''
      }><span>${lab}</span></label>`).join('')}</div>
    <div class="seg rc-seg">${[...(sig ? [Math.round(sig.lev * 100) / 100] : []), ...TARGETS]
      .filter((v, i, a) => a.indexOf(v) === i)
      .map((tv, i) => `<label><input type="radio" name="rctgt"
      value="${tv}" ${Math.abs(tv - mult) < 1e-9 ? 'checked' : ''}><span>${
      sig && i === 0 ? '規則 ' : ''}指數 ${fmtMax(tv, 2)} 倍</span></label>`).join('')}</div>
    ${sig ? `<p class="sub rc-sig">規則算出來是 <b>${fmtMax(sig.lev, 2)} 倍</b>
      ＝ 趨勢 ${fmtMax(sig.base, 1)}（指數${sig.above ? '在' : '跌破'} MA200，
      現在是均線的 ${fmtMax(sig.maRatio, 2)} 倍）
      ＋ 回撤加碼 ${fmtMax(sig.add, 2)}（距 52 週高點 ${fmt(sig.dd * 100)}%）<br>
      <span class="muted">只用趨勢濾網的話是 ${fmtMax(sig.levFilter, 1)} 倍。
      2008 年完整規則 0.50x、只用濾網 0.82x——回撤加碼在真正的崩盤裡是加速器。</span></p>` : ''}
    <p class="sub muted">指數年化波動 ${fmt(ivol * 100)}%　→　目標組合波動 ${fmt(target * 100)}%</p>`;

  if (!sel.length) {
    return head + `<p class="muted">還沒選標的。加幾檔進來，我算「同樣的風險該怎麼分」。</p>`;
  }
  const st = have.length ? statsOf(cache(), have) : null;
  if (!st) {
    return head + `<div class="rc-picks">${sel.map((s) => `<span class="rc-chip">${
      esc(labelOf(s))}<button type="button" data-rm="${esc(s)}">×</button></span>`).join('')}</div>
      <p class="muted">資料載入中，或這幾檔還沒有日報酬序列。</p>`;
  }

  const mode = localStorage.getItem(MODE_KEY) || 'sharpe';

  // 比值缺漏的（例如上市太短還沒算出來）用橫斷面平均頂替，
  // **不要當成 0**——當成 0 等於直接判它出局，那不是「沒資料」該有的待遇。
  // 位階加權開著的話，最佳化用的預期報酬也要一起調，
  // 否則推薦名單是一套邏輯、配置權重是另一套，兩邊會打架。
  const kk = ddK();
  const rawRatios = have.map((s2, i2) => {
    const base = cache().get(s2)?.ratio;
    if (!kk || !isNum(base)) return base;
    const d = dropZ(cache(), s2);
    const v = st.vol[i2];
    return d && v > 0 ? num(base) + (kk * Math.abs(d.dd)) / v : base;
  });
  const known = rawRatios.filter((r) => isNum(r) && r !== 0);
  const avgR = known.length ? known.reduce((a, b) => a + num(b), 0) / known.length : 1;
  const ratios = rawRatios.map((r) => (isNum(r) && r !== 0 ? num(r) : avgR));
  const guessed = have.filter((_, i) => !(isNum(rawRatios[i]) && rawRatios[i] !== 0));
  const mu = assumedMu(st, ratios);
  // **在固定的波動目標下，最大報酬/波動的組合本來就是報酬最大的組合**
  //   （報酬 = 比值 × 目標波動，同樣波動下比值最高的報酬就最高）。
  //   所以「潛在報酬最大」真正在調的不是目標，而是**你有多相信那組預期報酬**：
  //   少收縮＋放寬單檔上限 = 往比值高的那幾檔壓得更重。
  const raw = mode === 'parity' ? riskParity(st)
    : mode === 'aggr' ? maxSharpe(st, assumedMu(st, ratios, 0.85), { cap: 0.6 })
      : maxSharpe(st, mu);
  const w = scaleTo(raw, st, target);
  const pv = portVol(w, st);
  const rc = riskContrib(w, st);
  const totExp = w.reduce((a, x) => a + x * assets, 0);
  const shOpt = sharpeOf(raw, st, mu);
  const shPar = sharpeOf(riskParity(st), st, mu);

  const order = have.map((s, i) => i).sort((a, b) => w[b] - w[a]);
  const rows = order.map((i) => {
    const s = have[i];
    const exp = w[i] * assets;
    const lv = lotValue(s);
    const held = (state.futures || []).find((f) => norm(f.symbol) === norm(s) && f.kind === 'stock');
    const dz = dropZ(cache(), s);
    return `<tr class="${w[i] < 1e-4 ? 'rc-zero' : ''}">
      <td>${esc(labelOf(s))}</td>
      <td>${fmtMax(ratios[i], 2)}${guessed.includes(s) ? '<span class="sub muted">估</span>'
        : kk ? `<span class="sub muted">原 ${fmtMax(num(cache().get(s)?.ratio), 2)}</span>` : ''}</td>
      <td>${fmt(st.vol[i] * 100)}%</td>
      <td class="${dz && dz.z <= -1.5 ? 'gain' : ''}">${dz ? `${fmtMax(dz.z, 1)}σ` : '–'}</td>
      <td>${fmt(exp)}</td>
      <td><b>${s === 'TAIEX' ? idxLots(exp) : lv ? `${fmtMax(exp / lv, 2)} 口` : usShares(s, exp)}</b>${
        lv && s !== 'TAIEX' ? `<span class="sub muted">小型 ${fmtMax((exp / lv) * 20, 1)} 口</span>` : ''}</td>
      <td>${fmt((rc[i] / pv) * 100)}%</td>
      <td class="${held ? '' : 'muted'}">${held ? `${fmtMax(held.lots, 2)} 口` : '－'}</td>
    </tr>`;
  }).join('');

  // 相關係數：只有兩檔以上才有意義
  const cor = have.length > 1 ? `
    <div class="rc-scroll"><table class="rc-tab rc-corr"><thead><tr><th></th>${
      have.map((s) => `<th>${esc(String(s))}</th>`).join('')}</tr></thead><tbody>
    ${have.map((a, i) => `<tr><th>${esc(String(a))}</th>${
      have.map((b, j) => `<td class="${st.corr[i][j] >= 0.7 && i !== j ? 'loss' : ''}">${
        fmtMax(st.corr[i][j], 2)}</td>`).join('')}</tr>`).join('')}
    </tbody></table></div>` : '';

  return head + `
    <div class="rc-picks">${sel.map((s) => `<span class="rc-chip${
      cache().get(s) ? '' : ' rc-chip-off'}">${esc(labelOf(s))}<button type="button"
      data-rm="${esc(s)}">×</button></span>`).join('')}</div>
    <div class="rc-scroll"><table class="rc-tab"><thead><tr><th>標的</th><th title="過去三年 報酬÷波動">比值</th>
      <th>波動</th><th title="離 60 日高點幾個標準差">位階</th><th>建議曝險</th>
      <th>大型個股期</th><th>風險佔比</th><th>目前</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="rc-sum">合計曝險 <b>${fmt(totExp)}</b> 元　＝ 總資產的 ${
      fmtMax(totExp / assets, 2)} 倍　組合波動 ${fmt(target * 100)}%
      ${order.filter((i) => w[i] < 1e-4).length
        ? `<br><span class="sub muted">有 ${order.filter((i) => w[i] < 1e-4).length
          } 檔配到 0——不是壞掉，是它的風險已經被其他檔涵蓋（看相關係數）</span>` : ''}
      <br>組合報酬/波動 <b>${fmtMax(shOpt, 2)}</b>${
        mode === 'sharpe' ? `（風險平價會是 ${fmtMax(shPar, 2)}）` : `（最佳化可到 ${fmtMax(shOpt > shPar ? shOpt : shPar, 2)}）`}
      <span class="sub muted">（樣本 ${st.days} 天${
        pickable.dropped.length ? `；${pickable.dropped.map(esc).join('、')} 資料太短，未納入` : ''}）</span></p>
    ${cor}
    <p class="hint"><b>在固定的波動目標下，「最佳報酬/波動」本來就是報酬最大的組合</b>
      ——報酬 ＝ 比值 × 目標波動，同樣波動下比值最高的報酬就最高。
      所以<b>潛在報酬最大</b>調的不是目標，是「你有多相信那組預期報酬」：
      收縮從一半降到 15%、單檔上限從 35% 放寬到 60%，往比值高的那幾檔壓得更重。
      押對賺更多，押錯也錯更多。<b>風險平價</b>則完全不看報酬。<br>
      <b>預期報酬是「假設」不是「預測」</b>：用過去三年的比值往橫斷面平均收縮一半，
      再乘回各自的波動。單檔上限 35%——沒有上限的最佳化幾乎一定會把錢全壓在一檔，
      那是對估計誤差的過度反應。<br>
      <b>位階加權</b>把三個月跌幅加進報酬再除波動，等於問「不算這段回檔，它的報酬是多少」。
      回測每期 +0.27% 但 <b>t 只有 1.28，不顯著</b>，換持股檔數也沒有一致性——
      當成「讓排序符合你看位階的直覺」，不要當成已經證實的優勢。
      開著的時候會強制要求原始比值不低於加權指數，否則它會變成「誰跌最慘買誰」。<br>
      <b>位階</b>是「離三個月高點幾個標準差」。跌 20% 在月波動 10% 的股票上是 −1.2σ，
      但指數只跌 10%、月波動 4%，卻是 −1.4σ，其實更極端——**用百分比比不同標的會比錯**。<br>
      單檔要獨立抓就用這條：<b>曝險 ＝ 總資產 × 風險預算 ÷ 年化波動</b>。</p>`;
}

// 追蹤清單：手上的部位 ＋ 試算裡挑的，全部看一次位階
export const watchList = () => [
  ...new Set([...exposureRows().filter((r) => !r.key.startsWith('IDX:')).map((r) => r.key),
              ...picks(), 'TAIEX']),
];

const Z_HIT = -2;

// 位階掃描。**在資料庫算**：全市場兩千檔、每檔 260 個日報酬，
// 全部送到瀏覽器要好幾 MB，而他只需要命中的那幾檔。
export async function loadDropHits() {
  try {
    const { data, error } = await sb.rpc('drop_hits',
      { p_z: Z_HIT, p_scope: 'fut', p_limit: 12, p_exclude_ind: EXCL() });
    if (error) throw error;
    return data || [];
  } catch { return []; }
}

// 總覽頁用：沒有命中就整張卡不畫
export function renderDropWatch(el) {
  if (!el) return;
  loadDropHits().then((hits) => {
    if (!hits.length) { el.innerHTML = ''; return; }
    const held = new Set(watchList());
    el.innerHTML = `
      <div class="card list">
        <div class="list-title" role="heading" aria-level="2">位階警示（≤ ${Z_HIT}σ）</div>
        <div class="rc-scroll"><table class="rc-tab"><thead><tr>
          <th>標的</th><th>位階</th><th>近三個月跌幅</th><th>年波動</th>
          <th title="近 21 日年化波動 ÷ 近一年">近期波動</th><th>比值</th>
        </tr></thead><tbody>
        ${hits.map((h) => {
          const shift = num(h.vol_shift);
          const moved = shift >= 1.2;
          return `<tr>
          <td>${esc(h.symbol)} ${esc(h.name || '')}${
            held.has(String(h.symbol)) ? '<span class="badge">持有</span>' : ''}${
            moved ? '<span class="badge warn-badge">波動變了</span>' : ''}</td>
          <td class="${moved ? 'muted' : 'gain'}">${fmtMax(num(h.z), 2)}σ</td>
          <td>${fmt(num(h.dd) * 100)}%</td>
          <td>${fmt(num(h.vol1y) * 100)}%</td>
          <td class="${moved ? 'loss' : ''}">${fmt(num(h.vol_recent) * 100)}%${
            shift ? `<span class="sub muted">${fmtMax(shift, 2)}x</span>` : ''}</td>
          <td>${fmtMax(num(h.ratio), 2)}</td></tr>`;
        }).join('')}
        </tbody></table></div>
        <p class="hint">離<b>近三個月高點</b>超過 ${-Z_HIT} 個標準差，而且實際跌幅 ≥ 12%、
          報酬/波動不低於加權指數。<br>
          <b>兩個條件缺一不可。</b>只看標準差會掃出一堆金融股——波動 20% 的金控跌一點點
          就是好幾個標準差，但那個跌幅小到沒有交易價值；只看跌幅則會一直掃到高波動股，
          因為它們本來就天天在跌。<br>
          <b>標了「波動變了」的那幾檔，位階數字不能當真。</b>z 分數的分母是歷史波動，
          一檔年化 18% 的股票跌 27%，代表那個波動估計已經不適用——分母是舊的，z 會被高估。
          近 21 日波動超過近一年 1.2 倍就標出來。<br>
          實測 2022-2026：−2σ 以下的樣本未來 20 個交易日平均 <b>+2.93%</b>、勝率 64%
          （全市場 347 個樣本，t ≈ 2.3）。<b>但那是全市場的數字</b>——在報酬/波動前段的
          好標的裡，回檔與未來報酬其實是 U 型（貼近高點最好、−1σ 附近最差），
          所以這張表只拿來看極端值，不是「回檔就買」的理由。</p>
      </div>`;
  });
}

export function renderRiskCard(el) {
  if (!el) return;
  const c = compute();
  el.innerHTML = `
    <div class="card list rc-card">
      <div class="list-title" role="heading" aria-level="2">組合風險</div>
      <div data-rc-now>${currentBlock(c)}</div>
      <div class="rc-div"></div>
      <div class="list-title" role="heading" aria-level="2">配置試算</div>
      <div data-rc-alloc>${allocBlock(c)}</div>
    </div>`;

  const input = $('#rc-sym', el);
  const add = () => {
    const raw = norm(input.value);
    if (!raw) return;
    // 數字開頭走台股（可以用中文名反查），字母開頭直接當美股代號。
    // **美股一定要收**——他的 SNXX 佔了一半的風險，而且跨市場的相關係數
    //（SNXX 對台股只有 0.12）正是分散配置真正的來源。
    // 台指用一個固定代號 TAIEX，中文與常見縮寫都認
    const IDX_ALIAS = ['台指', '台指期', '加權', '加權指數', 'TAIEX', 'TX', 'MTX', 'TMF', '大盤'];
    const sym = IDX_ALIAS.includes(raw) ? 'TAIEX'
      : /^[0-9]/.test(raw) ? resolveTwSymbol(raw) : raw;
    if (sym !== 'TAIEX' && !/^[0-9]{4,6}[A-Z]?$/.test(sym) && !/^[A-Z][A-Z.]{0,5}$/.test(sym)) return;
    setPicks([...picks(), sym]);
    input.value = '';
    refresh(el);
  };
  if (input) {
    attachLookup(input, 'tw', (m, picked) => { if (picked) { input.value = m.code; add(); } });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); add(); }
    });
  }
  const btn = $('#rc-add', el);
  if (btn) btn.onclick = add;
  const top = $('#rc-top', el);
  if (top) {
    top.onclick = async () => {
      top.disabled = true;
      top.textContent = '載入中…';
      try {
        const { data, error } = await sb.rpc('top_ratio',
          { p_limit: 20, p_scope: 'fut', p_exclude_ind: EXCL(), p_dd_k: ddK() });
        if (error) throw error;
        if (!data || !data.length) { toast('目前沒有符合條件的標的', 2500); return; }
        // **台指一定要放進候選。** 它的波動只有個股的三分之一，
        // 在風險等價下常常是最有效率的一塊，不放進去等於先排除了正確答案。
        setPicks(['TAIEX', ...data.map((r) => String(r.symbol))]);
        await ensure(picks());
        renderRiskCard(el);
      } catch (e) { fail(e); } finally { top.disabled = false; }
    };
  }
  const clr = $('#rc-clear', el);
  if (clr) clr.onclick = () => { setPicks([]); renderRiskCard(el); };
  const dk = $('#rc-ddk', el);
  if (dk) {
    dk.onchange = () => {
      localStorage.setItem(DDK_KEY, dk.checked ? '1' : '0');
      renderRiskCard(el);
    };
  }
  const nf = $('#rc-nofin', el);
  if (nf) {
    nf.onchange = () => {
      localStorage.setItem(NOFIN_KEY, nf.checked ? '1' : '0');
      // 已經挑進來的金融股一併拿掉，否則勾了還留在表上很奇怪
      if (nf.checked) setPicks(picks().filter((s) => !/^28[0-9]{2}$/.test(s)));
      renderRiskCard(el);
    };
  }
  $$('input[name=rcmode]', el).forEach((r) => (r.onchange = () => {
    localStorage.setItem(MODE_KEY, r.value);
    renderRiskCard(el);
  }));
  $$('[data-rm]', el).forEach((b) => (b.onclick = () => {
    setPicks(picks().filter((s) => s !== b.dataset.rm));
    refresh(el);
  }));
  $$('input[name=rctgt]', el).forEach((r) => (r.onchange = () => {
    state.allocTarget = num(r.value);
    refresh(el);
  }));

  // 缺的序列補抓完再畫一次
  const need = [...exposureRows().filter((r) => !r.key.startsWith('IDX:')).map((r) => r.key),
                ...picks()];
  ensure(need).then((changed) => { if (changed) renderRiskCard(el); });
}

function refresh(el) {
  const need = picks();
  ensure(need).then(() => renderRiskCard(el));
  renderRiskCard(el);
}
