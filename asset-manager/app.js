import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// ============================================================
// 初始化
// ============================================================
const configured =
  /^https:\/\/.+\.supabase\.co$/.test(SUPABASE_URL) && !SUPABASE_ANON_KEY.startsWith('YOUR-');
const sb = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const DEFAULT_SETTINGS = { target_amount: 0, usd_twd: 32 };

const state = {
  user: null,
  tab: 'overview',
  authMode: 'login',
  settings: { ...DEFAULT_SETTINGS },
  stocks: [],
  futures: [],
  us: [],
  balances: [],
  snapshots: [], // 依日期由新到舊
};

// ============================================================
// 小工具
// ============================================================
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? 0 : Number(v));
const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const fmt = (v, d = 0) =>
  isNum(v) ? Number(v).toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–';
const fmtX = (v) => (isNum(v) ? Number(v).toFixed(2) + 'x' : '–');
const pct = (v) => (isNum(v) ? (Number(v) * 100).toFixed(1) + '%' : '–');
const signed = (v, d = 0) => (isNum(v) ? (v > 0 ? '+' : '') + fmt(v, d) : '–');
const plClass = (v) => (v > 0 ? 'gain' : v < 0 ? 'loss' : '');
const sum = (arr, f) => arr.reduce((acc, x) => acc + num(f(x)), 0);
const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

let toastTimer;
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}
function fail(err) {
  console.error(err);
  toast('錯誤：' + (err?.message || err), 4000);
}

// ============================================================
// 計算：資產、淨資產、兩種槓桿
//   槓桿①（資產槓桿）= 總資產 / 淨資產        → 借錢造成的財務槓桿
//   槓桿②（曝險槓桿）= 總曝險 / 淨資產        → 部位名目金額相對淨值
//   總曝險 = 台股市值 + 複委託市值 + 期貨名目（多單 + 空單）
// 想改定義就改這個函式。
// ============================================================
function compute() {
  const { settings, stocks, futures, us, balances } = state;
  const rate = num(settings.usd_twd);

  const stockValue = sum(stocks, (s) => num(s.shares) * num(s.price));
  const stockCost = sum(stocks, (s) => num(s.shares) * (isNum(s.cost) ? num(s.cost) : num(s.price)));

  const usValueUsd = sum(us, (s) => num(s.shares) * num(s.price_usd));
  const usCostUsd = sum(us, (s) => num(s.shares) * (isNum(s.cost_usd) ? num(s.cost_usd) : num(s.price_usd)));
  const usValue = usValueUsd * rate;

  const notional = (f) => num(f.lots) * num(f.price) * num(f.multiplier);
  const futMargin = sum(futures, (f) => f.margin);
  const futLong = sum(futures.filter((f) => f.side !== 'short'), notional);
  const futShort = sum(futures.filter((f) => f.side === 'short'), notional);
  const futGross = futLong + futShort;
  const futNet = futLong - futShort;

  const toTwd = (b) => num(b.amount) * (b.currency === 'USD' ? rate : 1);
  const cash = sum(balances.filter((b) => b.kind === 'cash'), toTwd);
  const liabilities = sum(balances.filter((b) => b.kind === 'liability'), toTwd);

  const totalAssets = stockValue + usValue + futMargin + cash;
  const netAssets = totalAssets - liabilities;
  const exposure = stockValue + usValue + futGross;

  const leverageAsset = netAssets > 0 ? totalAssets / netAssets : NaN;
  const leverageExposure = netAssets > 0 ? exposure / netAssets : NaN;

  const target = num(settings.target_amount);
  const progress = target > 0 ? netAssets / target : NaN;

  return {
    rate, stockValue, stockCost, usValueUsd, usCostUsd, usValue,
    futMargin, futLong, futShort, futGross, futNet,
    cash, liabilities, totalAssets, netAssets, exposure,
    leverageAsset, leverageExposure, target, progress,
  };
}

// ============================================================
// 資料表定義（新增 / 編輯 表單欄位）
// ============================================================
const ENTITIES = {
  stock: {
    table: 'stocks', key: 'stocks', title: '台股',
    fields: [
      { key: 'symbol', label: '代號', required: true, placeholder: '2330' },
      { key: 'name', label: '名稱', placeholder: '台積電' },
      { key: 'shares', label: '股數', type: 'number', required: true, placeholder: '1000' },
      { key: 'price', label: '現價', type: 'number', required: true },
      { key: 'cost', label: '平均成本（選填）', type: 'number' },
    ],
  },
  future: {
    table: 'futures', key: 'futures', title: '期貨',
    fields: [
      { key: 'contract', label: '商品', required: true, placeholder: '台指期 / 小台 / 微台' },
      { key: 'side', label: '方向', type: 'select', options: [['long', '多單'], ['short', '空單']] },
      { key: 'lots', label: '口數', type: 'number', required: true },
      { key: 'price', label: '目前價格（指數）', type: 'number', required: true },
      { key: 'multiplier', label: '每點價值（大台 200 / 小台 50 / 微台 10）', type: 'number', required: true },
      { key: 'margin', label: '帳戶權益 / 保證金 (TWD)', type: 'number', required: true },
    ],
    defaults: { side: 'long', lots: 1, multiplier: 200 },
  },
  us: {
    table: 'us_stocks', key: 'us', title: '複委託',
    fields: [
      { key: 'symbol', label: '代號', required: true, placeholder: 'VOO' },
      { key: 'name', label: '名稱' },
      { key: 'shares', label: '股數', type: 'number', required: true },
      { key: 'price_usd', label: '現價 (USD)', type: 'number', required: true },
      { key: 'cost_usd', label: '平均成本 (USD，選填)', type: 'number' },
    ],
  },
  balance: {
    table: 'balances', key: 'balances', title: '現金 / 負債',
    fields: [
      { key: 'kind', label: '類型', type: 'select', options: [['cash', '現金 / 存款'], ['liability', '負債']] },
      { key: 'name', label: '名稱', required: true, placeholder: '銀行活存 / 信貸 / 股票質押' },
      { key: 'currency', label: '幣別', type: 'select', options: [['TWD', 'TWD'], ['USD', 'USD']] },
      { key: 'amount', label: '金額', type: 'number', required: true },
      { key: 'note', label: '備註' },
    ],
    defaults: { kind: 'cash', currency: 'TWD' },
  },
};

// ============================================================
// 資料存取
// ============================================================
async function loadAll() {
  const uid = state.user.id;
  const results = await Promise.all([
    sb.from('settings').select('*').eq('user_id', uid).maybeSingle(),
    sb.from('stocks').select('*').order('created_at'),
    sb.from('futures').select('*').order('created_at'),
    sb.from('us_stocks').select('*').order('created_at'),
    sb.from('balances').select('*').order('kind').order('created_at'),
    sb.from('snapshots').select('*').order('snap_date', { ascending: false }).limit(730),
  ]);
  for (const r of results) if (r.error) throw r.error;
  const [st, stocks, futures, us, balances, snaps] = results;
  state.settings = st.data ? { ...DEFAULT_SETTINGS, ...st.data } : { ...DEFAULT_SETTINGS };
  state.stocks = stocks.data ?? [];
  state.futures = futures.data ?? [];
  state.us = us.data ?? [];
  state.balances = balances.data ?? [];
  state.snapshots = snaps.data ?? [];
}

async function refresh(msg) {
  try {
    await loadAll();
    render();
    if (msg) toast(msg);
  } catch (e) {
    fail(e);
  }
}

async function editItem(kind, id, extraDefaults = {}) {
  const ent = ENTITIES[kind];
  const existing = id ? state[ent.key].find((x) => x.id === id) : null;
  const res = await openForm({
    title: (existing ? '編輯' : '新增') + ent.title,
    fields: ent.fields,
    values: existing || { ...(ent.defaults || {}), ...extraDefaults },
    allowDelete: !!existing,
  });
  if (!res) return;
  try {
    if (res.action === 'delete') {
      const { error } = await sb.from(ent.table).delete().eq('id', id);
      if (error) throw error;
      await refresh('已刪除');
    } else {
      const payload = { ...res.values, user_id: state.user.id };
      if (id) payload.id = id;
      const { error } = await sb.from(ent.table).upsert(payload);
      if (error) throw error;
      await refresh('已儲存');
    }
  } catch (e) {
    fail(e);
  }
}

async function saveSnapshot() {
  const c = compute();
  const date = todayISO();
  if (state.snapshots.some((s) => s.snap_date === date) && !confirm(`今天（${date}）已有快照，要覆蓋嗎？`)) return;
  const payload = {
    user_id: state.user.id,
    snap_date: date,
    total_assets: round2(c.totalAssets),
    liabilities: round2(c.liabilities),
    net_assets: round2(c.netAssets),
    stock_value: round2(c.stockValue),
    us_value: round2(c.usValue),
    futures_margin: round2(c.futMargin),
    futures_notional: round2(c.futGross),
    cash: round2(c.cash),
    leverage_asset: round2(c.leverageAsset),
    leverage_exposure: round2(c.leverageExposure),
    target_amount: round2(c.target),
  };
  const { error } = await sb.from('snapshots').upsert(payload, { onConflict: 'user_id,snap_date' });
  if (error) return fail(error);
  await refresh('快照已儲存');
}

async function deleteSnapshot(id) {
  if (!confirm('刪除這筆快照？')) return;
  const { error } = await sb.from('snapshots').delete().eq('id', id);
  if (error) return fail(error);
  await refresh('已刪除');
}

// ============================================================
// 表單對話框
// ============================================================
function fieldHtml(f, v) {
  const val = v === null || v === undefined ? '' : v;
  const req = f.required ? 'required' : '';
  const ph = `placeholder="${esc(f.placeholder || '')}"`;
  if (f.type === 'select') {
    return `<label>${esc(f.label)}<select name="${f.key}">${f.options
      .map(([k, l]) => `<option value="${esc(k)}" ${String(val) === k ? 'selected' : ''}>${esc(l)}</option>`)
      .join('')}</select></label>`;
  }
  if (f.type === 'number') {
    return `<label>${esc(f.label)}<input name="${f.key}" type="number" step="any" inputmode="decimal" value="${esc(val)}" ${req} ${ph}></label>`;
  }
  return `<label>${esc(f.label)}<input name="${f.key}" type="text" value="${esc(val)}" ${req} ${ph} autocomplete="off"></label>`;
}

function openForm({ title, fields, values = {}, allowDelete = false }) {
  return new Promise((resolve) => {
    const dlg = $('#form-dialog');
    const form = $('#form-dialog-form');
    $('h2', dlg).textContent = title;
    $('.fields', dlg).innerHTML = fields.map((f) => fieldHtml(f, values[f.key])).join('');
    $('#form-delete').hidden = !allowDelete;

    const finish = (result) => {
      resolve(result);
      if (dlg.open) dlg.close();
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      if (!form.reportValidity()) return;
      const fd = new FormData(form);
      const out = {};
      for (const f of fields) {
        const raw = fd.get(f.key);
        if (f.type === 'number') out[f.key] = raw === '' || raw === null ? null : Number(raw);
        else out[f.key] = typeof raw === 'string' ? raw.trim() || null : raw;
      }
      finish({ action: 'save', values: out });
    };
    $('#form-delete').onclick = () => {
      if (confirm('確定要刪除嗎？')) finish({ action: 'delete' });
    };
    $('#form-cancel').onclick = () => finish(null);
    dlg.addEventListener('close', () => resolve(null), { once: true });

    dlg.showModal();
    const first = $('input, select', dlg);
    if (first) first.focus();
  });
}

// ============================================================
// 畫面
// ============================================================
const TITLES = { overview: '總覽', holdings: '持倉', funds: '資金', history: '紀錄', settings: '設定' };

function stat(label, value, extra = '') {
  return `<div class="card stat"><div class="label">${label}</div><div class="value">${value}</div>${extra ? `<div class="sub muted">${extra}</div>` : ''}</div>`;
}
function line(label, value, total) {
  const share = total > 0 && isNum(value) ? ` <span class="muted">(${pct(value / total)})</span>` : '';
  return `<div class="row-between line"><span>${label}</span><span>${fmt(value)}${share}</span></div>`;
}
function section(title, kind, rows, footer, addDefaults = {}) {
  return `<div class="card list">
    <div class="row-between">
      <span class="list-title">${esc(title)}</span>
      <button type="button" class="small" data-add="${kind}" data-defaults="${esc(JSON.stringify(addDefaults))}">＋ 新增</button>
    </div>
    ${rows.length ? rows.join('') : '<p class="muted">尚無資料，按「＋ 新增」登記。</p>'}
    ${footer ? `<div class="list-footer">${footer}</div>` : ''}
  </div>`;
}
function itemRow(kind, id, title, sub, right, right2 = '') {
  return `<button type="button" class="item" data-edit="${kind}" data-id="${id}">
    <span class="item-main"><span class="item-title">${title}</span><span class="item-sub">${sub}</span></span>
    <span class="item-right"><span>${right}</span><span class="item-sub">${right2}</span></span>
  </button>`;
}
function bindListActions(el) {
  $$('[data-add]', el).forEach((b) => (b.onclick = () => editItem(b.dataset.add, null, JSON.parse(b.dataset.defaults || '{}'))));
  $$('[data-edit]', el).forEach((b) => (b.onclick = () => editItem(b.dataset.edit, b.dataset.id)));
}

function renderOverview(el) {
  const c = compute();
  const last = state.snapshots[0];
  const diff = last ? c.netAssets - num(last.net_assets) : null;
  const progressWidth = Math.min(100, Math.max(0, (isNum(c.progress) ? c.progress : 0) * 100)).toFixed(1);

  el.innerHTML = `
    <div class="card hero">
      <div class="label">淨資產 (TWD)</div>
      <div class="big">${fmt(c.netAssets)}</div>
      ${last
        ? `<div class="sub ${plClass(diff)}">${signed(diff)} <span class="muted">相較 ${esc(last.snap_date)} 快照</span></div>`
        : '<div class="sub muted">尚無快照，按下方按鈕記錄第一筆</div>'}
    </div>
    <div class="grid2">
      ${stat('總資產', fmt(c.totalAssets))}
      ${stat('負債', fmt(c.liabilities))}
      ${stat('槓桿① 資產槓桿', fmtX(c.leverageAsset), '總資產 ÷ 淨資產')}
      ${stat('槓桿② 曝險槓桿', fmtX(c.leverageExposure), '總曝險 ÷ 淨資產')}
    </div>
    <div class="card">
      <div class="row-between"><span class="list-title">目標金額</span><span>${c.target > 0 ? fmt(c.target) : '<span class="muted">未設定</span>'}</span></div>
      <div class="bar"><div class="bar-fill" style="width:${progressWidth}%"></div></div>
      <div class="row-between sub">
        <span>${pct(c.progress)}</span>
        <span class="muted">${c.target > 0 ? (c.netAssets >= c.target ? '已達標 🎉' : '還差 ' + fmt(c.target - c.netAssets)) : '到「設定」輸入目標'}</span>
      </div>
    </div>
    <div class="card list">
      <div class="list-title">資產組成</div>
      ${line('台股市值', c.stockValue, c.totalAssets)}
      ${line(`複委託市值 <span class="muted">(USD ${fmt(c.usValueUsd, 2)})</span>`, c.usValue, c.totalAssets)}
      ${line('期貨帳戶權益', c.futMargin, c.totalAssets)}
      ${line('現金 / 存款', c.cash, c.totalAssets)}
    </div>
    <div class="card list">
      <div class="list-title">曝險</div>
      ${line('期貨名目・多單', c.futLong)}
      ${line('期貨名目・空單', c.futShort)}
      ${line('期貨淨曝險（多 − 空）', c.futNet)}
      ${line('總曝險（台股＋複委託＋期貨名目）', c.exposure)}
    </div>
    <button type="button" class="primary block" id="snap-btn">📌 記錄今日快照</button>
    <p class="hint">快照會把上面的數字存進「紀錄」，用來追蹤淨資產與槓桿變化。匯率 ${fmt(c.rate, 3)} 可在「設定」調整。</p>`;
  $('#snap-btn', el).onclick = saveSnapshot;
}

function renderHoldings(el) {
  const c = compute();
  const stockRows = state.stocks.map((s) => {
    const v = num(s.shares) * num(s.price);
    const pl = isNum(s.cost) ? v - num(s.shares) * num(s.cost) : null;
    return itemRow('stock', s.id,
      `${esc(s.symbol)} ${esc(s.name || '')}`,
      `${fmt(s.shares)} 股 × ${fmt(s.price, 2)}${isNum(s.cost) ? `　成本 ${fmt(s.cost, 2)}` : ''}`,
      fmt(v),
      pl === null ? '' : `<span class="${plClass(pl)}">${signed(pl)}</span>`);
  });
  const futRows = state.futures.map((f) => {
    const notional = num(f.lots) * num(f.price) * num(f.multiplier);
    return itemRow('future', f.id,
      `${esc(f.contract)}<span class="badge">${f.side === 'short' ? '空' : '多'}</span>`,
      `${fmt(f.lots)} 口 × ${fmt(f.price, 2)} × ${fmt(f.multiplier)}`,
      `名目 ${fmt(notional)}`,
      `權益 ${fmt(f.margin)}`);
  });
  const usRows = state.us.map((s) => {
    const v = num(s.shares) * num(s.price_usd);
    const pl = isNum(s.cost_usd) ? v - num(s.shares) * num(s.cost_usd) : null;
    return itemRow('us', s.id,
      `${esc(s.symbol)} ${esc(s.name || '')}`,
      `${fmt(s.shares, 4)} 股 × ${fmt(s.price_usd, 2)}${isNum(s.cost_usd) ? `　成本 ${fmt(s.cost_usd, 2)}` : ''}`,
      `US$ ${fmt(v, 2)}`,
      pl === null ? `≈ ${fmt(v * c.rate)}` : `<span class="${plClass(pl)}">${signed(pl, 2)}</span> ≈ ${fmt(v * c.rate)}`);
  });
  const stockPl = c.stockValue - c.stockCost;
  const usPl = c.usValueUsd - c.usCostUsd;

  el.innerHTML =
    section('台股', 'stock', stockRows,
      `市值 ${fmt(c.stockValue)}　<span class="${plClass(stockPl)}">${signed(stockPl)}</span>`) +
    section('期貨', 'future', futRows,
      `權益 ${fmt(c.futMargin)}　名目 ${fmt(c.futGross)}`) +
    section('複委託 (USD)', 'us', usRows,
      `US$ ${fmt(c.usValueUsd, 2)} <span class="${plClass(usPl)}">${signed(usPl, 2)}</span>　≈ ${fmt(c.usValue)}`) +
    `<p class="hint">點任一筆可編輯或刪除。期貨的「帳戶權益」算進總資產，名目金額只算進曝險槓桿。</p>`;
  bindListActions(el);
}

function renderFunds(el) {
  const c = compute();
  const money = (b) => {
    const usd = b.currency === 'USD';
    return itemRow('balance', b.id, esc(b.name), esc(b.note || ''),
      `${fmt(b.amount, usd ? 2 : 0)} ${b.currency}`,
      usd ? `≈ ${fmt(num(b.amount) * c.rate)}` : '');
  };
  const cashRows = state.balances.filter((b) => b.kind === 'cash').map(money);
  const debtRows = state.balances.filter((b) => b.kind === 'liability').map(money);

  el.innerHTML =
    section('現金 / 存款', 'balance', cashRows, `合計 ${fmt(c.cash)}`, { kind: 'cash' }) +
    section('負債', 'balance', debtRows, `合計 ${fmt(c.liabilities)}`, { kind: 'liability' }) +
    `<div class="grid2">
      ${stat('總資產', fmt(c.totalAssets))}
      ${stat('淨資產', fmt(c.netAssets))}
    </div>
    <p class="hint">負債例如：信貸、股票質押借款、期貨帳戶以外的融資。美金項目以匯率 ${fmt(c.rate, 3)} 換算。</p>`;
  bindListActions(el);
}

function renderHistory(el) {
  const rows = state.snapshots;
  el.innerHTML = `<div class="card">
    <div class="row-between">
      <span class="list-title">快照紀錄</span>
      <button type="button" class="small" id="snap-btn2">📌 記錄今日</button>
    </div>
    ${rows.length
      ? `<div class="table-wrap"><table>
          <thead><tr><th>日期</th><th>淨資產</th><th>變化</th><th>總資產</th><th>負債</th><th>槓桿①</th><th>槓桿②</th><th>目標%</th><th></th></tr></thead>
          <tbody>${rows.map((r, i) => {
            const prev = rows[i + 1];
            const d = prev ? num(r.net_assets) - num(prev.net_assets) : null;
            const prog = num(r.target_amount) > 0 ? num(r.net_assets) / num(r.target_amount) : null;
            return `<tr>
              <td>${esc(r.snap_date)}</td>
              <td>${fmt(r.net_assets)}</td>
              <td class="${plClass(d)}">${signed(d)}</td>
              <td>${fmt(r.total_assets)}</td>
              <td>${fmt(r.liabilities)}</td>
              <td>${fmtX(r.leverage_asset)}</td>
              <td>${fmtX(r.leverage_exposure)}</td>
              <td>${pct(prog)}</td>
              <td><button type="button" class="link danger" data-del-snap="${r.id}">刪除</button></td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>`
      : '<p class="muted">尚無快照。回到「總覽」按「記錄今日快照」。</p>'}
  </div>
  <p class="hint">每天最多一筆，同一天再記錄會覆蓋。表格可左右滑動查看更多欄位。</p>`;
  $('#snap-btn2', el).onclick = saveSnapshot;
  $$('[data-del-snap]', el).forEach((b) => (b.onclick = () => deleteSnapshot(b.dataset.delSnap)));
}

function renderSettings(el) {
  const st = state.settings;
  el.innerHTML = `
    <form id="settings-form" class="card">
      <div class="list-title">目標與匯率</div>
      <label>目標金額（淨資產, TWD）
        <input name="target_amount" type="number" step="any" inputmode="numeric" value="${esc(num(st.target_amount))}">
      </label>
      <label>美金匯率（1 USD = ? TWD）
        <input name="usd_twd" type="number" step="any" inputmode="decimal" value="${esc(num(st.usd_twd))}">
      </label>
      <button type="submit" class="primary block">儲存設定</button>
    </form>
    <div class="card">
      <div class="list-title">帳號</div>
      <p class="muted">${esc(state.user.email || '')}</p>
      <button type="button" class="block" id="logout-btn">登出</button>
    </div>
    <div class="card">
      <div class="list-title">數字怎麼算</div>
      <dl class="defs">
        <dt>總資產</dt><dd>台股市值 ＋ 複委託市值（換算 TWD）＋ 期貨帳戶權益 ＋ 現金/存款</dd>
        <dt>淨資產</dt><dd>總資產 － 負債</dd>
        <dt>槓桿①（資產槓桿）</dt><dd>總資產 ÷ 淨資產。沒有負債時 = 1.00x；借錢投資會讓它 &gt; 1。</dd>
        <dt>槓桿②（曝險槓桿）</dt><dd>（台股市值 ＋ 複委託市值 ＋ 期貨名目多單 ＋ 期貨名目空單）÷ 淨資產。反映部位總規模相對淨值。</dd>
        <dt>期貨名目</dt><dd>口數 × 價格 × 每點價值（大台 200、小台 50、微台 10）</dd>
      </dl>
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
  $('#logout-btn', el).onclick = async () => {
    const { error } = await sb.auth.signOut();
    if (error) fail(error);
  };
}

const RENDERERS = { overview: renderOverview, holdings: renderHoldings, funds: renderFunds, history: renderHistory, settings: renderSettings };

function render() {
  if (!state.user) return;
  $$('.bottom-nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  $$('.tab-panel').forEach((p) => (p.hidden = p.dataset.tab !== state.tab));
  $('#topbar-title').textContent = TITLES[state.tab];
  RENDERERS[state.tab]($(`.tab-panel[data-tab="${state.tab}"]`));
}

function bindNav() {
  $$('.bottom-nav button').forEach((b) => {
    b.onclick = () => {
      state.tab = b.dataset.tab;
      render();
      window.scrollTo({ top: 0 });
    };
  });
  $('#refresh-btn').onclick = () => refresh('已更新');
}

// ============================================================
// 登入 / 註冊
// ============================================================
function bindAuth() {
  const form = $('#auth-form');
  const submit = $('#auth-submit');
  const toggle = $('#auth-toggle');
  const switchText = $('#auth-switch-text');
  const msg = $('#auth-msg');

  toggle.onclick = () => {
    state.authMode = state.authMode === 'login' ? 'signup' : 'login';
    const login = state.authMode === 'login';
    submit.textContent = login ? '登入' : '註冊';
    toggle.textContent = login ? '註冊' : '登入';
    switchText.textContent = login ? '還沒有帳號？' : '已經有帳號？';
    form.password.autocomplete = login ? 'current-password' : 'new-password';
    msg.textContent = '';
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!sb) return;
    const email = form.email.value.trim();
    const password = form.password.value;
    submit.disabled = true;
    msg.textContent = '';
    try {
      if (state.authMode === 'signup') {
        const { data, error } = await sb.auth.signUp({ email, password });
        if (error) throw error;
        if (!data.session) msg.textContent = '註冊成功！請到信箱點確認連結，再回來登入。';
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      msg.textContent = err.message === 'Invalid login credentials' ? 'Email 或密碼錯誤' : err.message;
    } finally {
      submit.disabled = false;
    }
  };

  $('#auth-forgot').onclick = async () => {
    if (!sb) return;
    const email = form.email.value.trim();
    if (!email) return (msg.textContent = '請先輸入 Email');
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.href.split('#')[0] });
    msg.textContent = error ? error.message : '已寄出重設密碼信，點信裡的連結回到這裡後會請你輸入新密碼。';
  };
}

async function setUser(user) {
  const changed = (user?.id ?? null) !== (state.user?.id ?? null);
  state.user = user;
  $('#auth-view').hidden = !!user;
  $('#app-view').hidden = !user;
  if (user && changed) {
    state.tab = 'overview';
    await refresh();
  }
}

async function init() {
  bindAuth();
  bindNav();

  if (!sb) {
    $('#config-warning').hidden = false;
    $('#auth-view').hidden = false;
    return;
  }

  const { data: { session } } = await sb.auth.getSession();
  await setUser(session?.user ?? null);

  sb.auth.onAuthStateChange((event, session) => {
    // 依 supabase-js 建議，callback 內不要直接 await supabase 呼叫
    setTimeout(async () => {
      if (event === 'PASSWORD_RECOVERY') {
        const pw = prompt('請輸入新密碼（至少 6 碼）');
        if (pw) {
          const { error } = await sb.auth.updateUser({ password: pw });
          toast(error ? error.message : '密碼已更新');
        }
      }
      setUser(session?.user ?? null);
    }, 0);
  });
}

init();
