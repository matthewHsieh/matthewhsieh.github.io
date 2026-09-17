import { $, $$, esc, fmt, fmtMax, isNum, norm, num, state } from '../core.js';
import {
  IM_RATE, exposureRows, loadSeries, marginRoom, moveOdds, portVol,
  riskContrib, riskParity, scaleTo, statsOf, usableKeys,
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
const TARGETS = [0.20, 0.30, 0.43, 0.54];

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
  if (s.startsWith('IDX:')) return s.slice(4);
  return TW_STOCKS[s] ? `${s} ${TW_STOCKS[s]}` : s;
};

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
    <table class="rc-tab"><thead><tr><th>標的</th><th>波動</th><th>曝險佔比</th><th>風險佔比</th></tr></thead><tbody>
    ${list.map((x) => `<tr>
      <td>${esc(x.label)}</td>
      <td>${fmt(x.vol * 100)}%</td>
      <td>${fmt(totExp ? (x.exp / totExp) * 100 : 0)}%</td>
      <td>${fmt(x.rc * 100)}% ${bar(x.rc * 100)}</td></tr>`).join('')}
    </tbody></table>
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
  const target = num(state.allocTarget ?? 0.30);

  const head = `
    <div class="rc-add">
      <label>加入標的<input type="text" id="rc-sym" autocomplete="off"
        autocapitalize="characters" placeholder="輸入代號或名稱"></label>
      <button type="button" class="small" id="rc-add">＋ 加入</button>
    </div>
    <div class="seg rc-seg">${TARGETS.map((t) => `<label><input type="radio" name="rctgt"
      value="${t}" ${Math.abs(t - target) < 1e-9 ? 'checked' : ''}><span>組合波動 ${fmt(t * 100)}%</span></label>`).join('')}</div>`;

  if (!sel.length) {
    return head + `<p class="muted">還沒選標的。加幾檔進來，我算「同樣的風險該怎麼分」。</p>`;
  }
  const st = have.length ? statsOf(cache(), have) : null;
  if (!st) {
    return head + `<div class="rc-picks">${sel.map((s) => `<span class="rc-chip">${
      esc(labelOf(s))}<button type="button" data-rm="${esc(s)}">×</button></span>`).join('')}</div>
      <p class="muted">資料載入中，或這幾檔還沒有日報酬序列。</p>`;
  }

  const w = scaleTo(riskParity(st), st, target);
  const pv = portVol(w, st);
  const rc = riskContrib(w, st);
  const twii = statsOf(cache(), ['TAIEX']);
  const ivol = twii ? twii.vol[0] : null;
  const totExp = w.reduce((a, x) => a + x * assets, 0);

  const rows = have.map((s, i) => {
    const exp = w[i] * assets;
    const lv = lotValue(s);
    const held = (state.futures || []).find((f) => norm(f.symbol) === norm(s) && f.kind === 'stock');
    return `<tr>
      <td>${esc(labelOf(s))}</td>
      <td>${fmt(st.vol[i] * 100)}%</td>
      <td>${fmt(exp)}</td>
      <td><b>${lv ? `${fmtMax(exp / lv, 2)} 口` : '–'}</b>${
        lv ? `<span class="sub muted">小型 ${fmtMax((exp / lv) * 20, 1)} 口</span>` : ''}</td>
      <td>${fmt((rc[i] / pv) * 100)}%</td>
      <td class="${held ? '' : 'muted'}">${held ? `${fmtMax(held.lots, 2)} 口` : '－'}</td>
    </tr>`;
  }).join('');

  // 相關係數：只有兩檔以上才有意義
  const cor = have.length > 1 ? `
    <table class="rc-tab rc-corr"><thead><tr><th></th>${
      have.map((s) => `<th>${esc(String(s))}</th>`).join('')}</tr></thead><tbody>
    ${have.map((a, i) => `<tr><th>${esc(String(a))}</th>${
      have.map((b, j) => `<td class="${st.corr[i][j] >= 0.7 && i !== j ? 'loss' : ''}">${
        fmtMax(st.corr[i][j], 2)}</td>`).join('')}</tr>`).join('')}
    </tbody></table>` : '';

  return head + `
    <div class="rc-picks">${sel.map((s) => `<span class="rc-chip${
      cache().get(s) ? '' : ' rc-chip-off'}">${esc(labelOf(s))}<button type="button"
      data-rm="${esc(s)}">×</button></span>`).join('')}</div>
    <table class="rc-tab"><thead><tr><th>標的</th><th>波動</th><th>建議曝險</th>
      <th>大型個股期</th><th>風險佔比</th><th>目前</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="rc-sum">合計曝險 <b>${fmt(totExp)}</b> 元　＝ 總資產的 ${
      fmtMax(totExp / assets, 2)} 倍${ivol ? `　≈ 指數開 ${fmtMax(target / ivol, 2)} 倍` : ''}
      <span class="sub muted">（樣本 ${st.days} 天${
        pickable.dropped.length ? `；${pickable.dropped.map(esc).join('、')} 資料太短，未納入` : ''}）</span></p>
    ${cor}
    <p class="hint">用的是<b>風險平價</b>：每一檔貢獻一樣多的波動，波動大的就配少一點。
      它<b>完全不看預期報酬</b>——只回答「同樣的風險怎麼分」，不回答「該不該買」。
      選股是你的判斷，大小交給這張表。<br>
      單檔要獨立抓的話用這條：<b>曝險 ＝ 總資產 × 風險預算 ÷ 年化波動</b>。</p>`;
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
    const sym = resolveTwSymbol(raw);
    if (!/^[0-9]{4,6}[A-Z]?$/.test(sym)) return;
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
