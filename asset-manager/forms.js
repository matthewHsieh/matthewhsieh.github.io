import { $, $$, esc, fail, fmt, fmtMax, isNum, norm, num, plClass, sb, signed, state, toast, todayISO } from './core.js';
import { applyCachedPrices, refresh } from './data.js';
import { openDialog, openForm } from './dialog.js';
import { OPT_SIZE, STOCK_FUT_SIZES, cpLabel, fmtNet, fmtQty, futDisplayName, optDeltaExp, optMaxRisk, optPl, optValue, strikeText, warDelta, warExposure, warMaxRisk, warPl, warValue } from './instruments.js';
import { futPl } from './live.js';
import { FWD_YEARS, valOf } from './portfolio.js';
import { breaksOn, checkRules } from './rules.js';
import { LOOKUPS, TW_STOCKS, attachLookup, indexProduct, resolveTwSymbol, tradeKey } from './symbols.js';
import { TRADE_KINDS, projectTrade, saveTrade, tradeCost } from './trades.js';

// ============================================================
// 表單定義
// ============================================================
const BALANCE_KINDS = [['cash', '現金 / 存款'], ['futures_equity', '期貨帳戶權益數'], ['liability', '負債']];


const ENTITIES = {
  stock: {
    table: 'stocks', key: 'stocks', title: '台股',
    fields: [
      { key: 'symbol', label: '代號', required: true, placeholder: '2330 或 台積', lookup: 'tw' },
      { key: 'name', label: '名稱', placeholder: '輸入代號會自動帶出' },
      { key: 'shares', label: '股數（1 張 = 1000 股）', type: 'number', required: true, placeholder: '1000' },
      { key: 'price', label: '現價（每日自動更新）', type: 'number', required: true },
      { key: 'cost', label: '平均成本（選填）', type: 'number' },
    ],
  },
  us: {
    table: 'us_stocks', key: 'us', title: '複委託',
    fields: [
      { key: 'symbol', label: '代號', required: true, placeholder: 'VOO' },
      { key: 'name', label: '名稱' },
      { key: 'shares', label: '股數', type: 'number', required: true },
      { key: 'price_usd', label: '現價 (USD，每日自動更新)', type: 'number', required: true },
      { key: 'cost_usd', label: '平均成本 (USD，選填)', type: 'number' },
      { key: 'leverage', label: '槓桿倍數（選填，留空會從名稱判斷；反向填負數）', type: 'number' },
    ],
  },
  balance: {
    table: 'balances', key: 'balances', title: '資金項目',
    fields: [
      { key: 'kind', label: '類型', type: 'select', options: BALANCE_KINDS },
      { key: 'name', label: '名稱', required: true, placeholder: '銀行活存 / 元大期貨 / 信貸' },
      { key: 'currency', label: '幣別', type: 'select', options: [['TWD', 'TWD'], ['USD', 'USD']] },
      { key: 'amount', label: '金額', type: 'number', required: true },
      { key: 'note', label: '備註' },
    ],
    defaults: { kind: 'cash', currency: 'TWD' },
  },
};

export async function editItem(kind, id, extraDefaults = {}) {
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
      if (ent.table !== 'balances') await applyCachedPrices();
      await refresh('已儲存');
    }
  } catch (e) {
    fail(e);
  }
}

// ---------- 期貨部位（欄位會隨指數/個股切換） ----------
function openFuturesForm(existing) {
  const v = existing || { kind: 'index', side: 'long', lots: 1, symbol: '', size: 200, price: 0 };
  const html = `
    <label>類型<select name="kind">
      <option value="index" ${v.kind !== 'stock' ? 'selected' : ''}>指數期貨</option>
      <option value="stock" ${v.kind === 'stock' ? 'selected' : ''}>個股期貨</option>
    </select></label>
    <label><span data-l="symbol">商品</span><input name="symbol" type="text" required autocomplete="off" value="${esc(v.symbol || '')}"></label>
    <div class="resolved muted" data-resolved></div>
    <label data-row="size">規格<select name="size">${STOCK_FUT_SIZES
      .map((s) => `<option value="${s.size}" ${num(v.size) === s.size ? 'selected' : ''}>${s.label}</option>`).join('')}</select></label>
    <label data-row="mult">每點價值<input name="mult" type="number" step="any" inputmode="decimal" value="${esc(num(v.size))}" readonly></label>
    <div class="seg side-seg">
      <label><input type="radio" name="side" value="long" ${v.side !== 'short' ? 'checked' : ''}><span>多單</span></label>
      <label><input type="radio" name="side" value="short" ${v.side === 'short' ? 'checked' : ''}><span>空單</span></label>
    </div>
    <label>口數<input name="lots" type="number" step="any" inputmode="decimal" required min="0" value="${esc(num(v.lots))}"></label>
    <label>目前價格（每日自動更新）<input name="price" type="number" step="any" inputmode="decimal" required value="${esc(num(v.price))}"></label>
    <label>平均成本（選填，填了就會算損益）<input name="cost" type="number" step="any" inputmode="decimal" value="${isNum(v.cost) ? esc(num(v.cost)) : ''}"></label>
    <div class="preview" data-preview></div>`;

  const read = (fd, form) => {
    const kind = fd.get('kind');
    const symbol = norm(fd.get('symbol'));
    const size = kind === 'stock' ? num(fd.get('size')) : (indexProduct(symbol)?.size ?? num(fd.get('mult')) ?? 200);
    const rawCost = fd.get('cost');
    return {
      kind, symbol, size,
      contract: futDisplayName(kind, symbol, size),
      side: fd.get('side') || 'long',
      lots: num(fd.get('lots')),
      price: num(fd.get('price')),
      cost: rawCost === '' || rawCost === null ? null : Number(rawCost),
    };
  };

  return openDialog({
    title: existing ? '編輯期貨部位' : '新增期貨部位',
    html, allowDelete: !!existing,
    onMount: (form) => {
      const resolved = $('[data-resolved]', form);
      const preview = $('[data-preview]', form);
      const rowSize = $('[data-row=size]', form);
      const rowMult = $('[data-row=mult]', form);

      const update = () => {
        const val = read(new FormData(form), form);
        rowSize.hidden = val.kind !== 'stock';
        rowMult.hidden = val.kind === 'stock';
        $('[data-l=symbol]', form).textContent = val.kind === 'stock' ? '標的股票代號' : '商品';
        form.symbol.placeholder = val.kind === 'stock' ? '2330 或 台積' : 'TX / 小台 / 微台';
        if (val.kind !== 'stock') {
          const p = indexProduct(val.symbol);
          if (p) form.mult.value = p.size;
          resolved.textContent = p ? `${p.symbol}　${p.name}　每點 ${p.size} 元` : '（輸入 TX、MTX、TMF 或中文名稱）';
        } else {
          const nm = TW_STOCKS[val.symbol];
          resolved.textContent = nm ? `${val.symbol}　${nm}` : '（輸入股票代號）';
        }
        if (val.lots > 0 && val.price > 0) {
          const pl = futPl({ ...val });
          preview.innerHTML =
            `名目 / 曝險 ＝ ${fmtMax(val.lots, 2)} 口 × ${fmtMax(val.price, 2)} × ${fmt(val.size)} ＝ ${fmt(val.lots * val.price * val.size)} 元` +
            (pl === null ? '<br>填平均成本就會算損益' : `<br>損益 ＝ <span class="${plClass(pl)}">${signed(pl)}</span> 元`);
        } else {
          preview.textContent = '填好口數與價格後會顯示名目金額';
        }
      };
      attachLookup(form.symbol, () => (form.kind.value === 'stock' ? 'stockfut' : 'index'), (m) => {
        if (m.size) form.mult.value = m.size;
        update();
      });
      form.addEventListener('input', update);
      form.addEventListener('change', update);
      update();
    },
    collect: (fd, form) => {
      const val = read(fd, form);
      if (!val.symbol) { toast('請輸入商品或股票代號', 2500); return undefined; }
      if (!(val.lots > 0)) { toast('口數必須大於 0', 2500); return undefined; }
      if (!(val.size > 0)) { toast('規格不正確', 2500); return undefined; }
      return val;
    },
  });
}

function openOptionsForm(existing) {
  const v = existing || { expiry: state.optExpiries[0]?.expiry ?? '', strike: '', cp: 'call', side: 'long', lots: 1, cost: '' };
  const expOpts = state.optExpiries.length
    ? state.optExpiries.map((e) =>
        `<option value="${esc(e.expiry)}" ${String(v.expiry) === e.expiry ? 'selected' : ''}>${esc(e.expiry)}（遠期 ${fmt(e.forward)}）</option>`).join('')
    : `<option value="${esc(v.expiry)}">${esc(v.expiry || '尚未載入到期別')}</option>`;

  const html = `
    <label>到期<select name="expiry">${expOpts}</select></label>
    <label>履約價<input name="strike" type="number" step="any" inputmode="decimal" required value="${esc(v.strike)}" placeholder="47000"></label>
    <label>買權 / 賣權<select name="cp">
      <option value="call" ${v.cp !== 'put' ? 'selected' : ''}>買權 Call</option>
      <option value="put" ${v.cp === 'put' ? 'selected' : ''}>賣權 Put</option>
    </select></label>
    <div class="seg side-seg">
      <label><input type="radio" name="side" value="long" ${v.side !== 'short' ? 'checked' : ''}><span>買方</span></label>
      <label><input type="radio" name="side" value="short" ${v.side === 'short' ? 'checked' : ''}><span>賣方</span></label>
    </div>
    <label>口數<input name="lots" type="number" step="any" inputmode="decimal" required min="0" value="${esc(num(v.lots))}"></label>
    <label>平均成本（點，選填）<input name="cost" type="number" step="any" inputmode="decimal" value="${isNum(v.cost) ? esc(num(v.cost)) : ''}"></label>
    <div class="preview" data-preview></div>`;

  const read = (fd) => ({
    contract: 'TXO',
    expiry: String(fd.get('expiry') || '').trim(),
    strike: num(fd.get('strike')),
    cp: fd.get('cp') === 'put' ? 'put' : 'call',
    side: fd.get('side') || 'long',
    lots: num(fd.get('lots')),
    size: OPT_SIZE,
    cost: fd.get('cost') === '' || fd.get('cost') === null ? null : Number(fd.get('cost')),
  });

  return openDialog({
    title: existing ? '編輯選擇權部位' : '新增選擇權部位',
    html, allowDelete: !!existing,
    onMount: (form) => {
      const preview = $('[data-preview]', form);
      const update = () => {
        const val = read(new FormData(form));
        const fwd = state.optExpiries.find((e) => e.expiry === val.expiry)?.forward;
        const cur = existing && existing.expiry === val.expiry && num(existing.strike) === val.strike && existing.cp === val.cp
          ? num(existing.price) : null;
        const lines = [];
        if (fwd) lines.push(`${val.expiry} 隱含遠期指數 ${fmt(fwd)}`);
        if (cur !== null) {
          const o = { ...val, price: cur, delta: existing.delta, forward: existing.forward };
          lines.push(`權利金 ${fmtMax(cur, 2)} 點 → 市值 ${fmt(optValue(o))} 元`);
          const de = optDeltaExp(o);
          if (de !== null) lines.push(`delta ${fmtMax(existing.delta, 3)}　delta 曝險 ${fmt(Math.abs(de))} 元`);
          const pl = optPl(o);
          if (pl !== null) lines.push(`未實現損益 ${signed(pl)} 元`);
        } else {
          lines.push('權利金與 delta 存檔後會自動帶入');
        }
        const risk = optMaxRisk({ ...val, price: cur ?? 0 });
        lines.push(risk.unlimited ? '⚠ 賣出買權：最大風險無上限' : `最大風險 ${fmt(risk.value)} 元`);
        preview.innerHTML = lines.join('<br>');
        preview.classList.toggle('err', risk.unlimited);
      };
      form.addEventListener('input', update);
      form.addEventListener('change', update);
      update();
    },
    collect: (fd) => {
      const val = read(fd);
      if (!val.expiry) { toast('請選擇到期', 2500); return undefined; }
      if (!(val.strike > 0)) { toast('請輸入履約價', 2500); return undefined; }
      if (!(val.lots > 0)) { toast('口數必須大於 0', 2500); return undefined; }
      return val;
    },
  });
}

// 依代號查權證基本資料（37,000 筆放在資料庫，不下載到手機）
async function lookupWarrant(code) {
  const c = norm(code);
  if (!/^[0-9A-Z]{6}$/.test(c)) return null;
  const { data, error } = await sb.from('warrant_info').select('*').eq('code', c).maybeSingle();
  if (error) { console.warn(error); return null; }
  return data;
}

function openWarrantForm(existing, info) {
  const v = existing || { code: '', lots: 1, cost: '' };
  const meta = info || existing || {};
  const modelOk = !meta.category || String(meta.category).includes('一般型');
  const html = `
    <label>權證代號<input name="code" type="text" required autocomplete="off" autocapitalize="characters"
      maxlength="6" value="${esc(v.code || '')}" placeholder="030573" ${existing ? 'readonly' : ''}></label>
    <div class="resolved muted" data-resolved></div>
    <label>張數（1 張 = 1000 單位）<input name="lots" type="number" step="any" inputmode="decimal" required min="0" value="${esc(num(v.lots))}"></label>
    <label>成本（元／單位，選填）<input name="cost" type="number" step="any" inputmode="decimal" value="${isNum(v.cost) ? esc(num(v.cost)) : ''}"></label>
    <label data-row="ovr" ${modelOk ? 'hidden' : ''}>delta 手動填（界限型／重設型模型不適用）
      <input name="delta_override" type="number" step="any" inputmode="decimal" value="${isNum(v.delta_override) ? esc(num(v.delta_override)) : ''}" placeholder="0.5"></label>
    <div class="preview" data-preview></div>`;

  const read = (fd) => ({
    code: norm(fd.get('code')),
    lots: num(fd.get('lots')),
    cost: fd.get('cost') === '' || fd.get('cost') === null ? null : Number(fd.get('cost')),
    delta_override: fd.get('delta_override') === '' || fd.get('delta_override') === null ? null : Number(fd.get('delta_override')),
  });

  return openDialog({
    title: existing ? '編輯權證部位' : '新增權證',
    html, allowDelete: !!existing,
    onMount: (form) => {
      const resolved = $('[data-resolved]', form);
      const preview = $('[data-preview]', form);
      const rowOvr = $('[data-row=ovr]', form);
      let found = info || (existing ? existing : null);
      form.__found = found;

      const draw = () => {
        const val = read(new FormData(form));
        if (!found) {
          resolved.textContent = val.code.length === 6 ? '查詢中…' : '輸入 6 碼權證代號';
          preview.textContent = '';
          return;
        }
        const ok = !found.category || String(found.category).includes('一般型');
        rowOvr.hidden = ok;
        resolved.innerHTML = `${esc(found.name || '')}　${found.cp === 'put' ? '認售' : '認購'}<br>` +
          `標的 ${esc(found.underlying || '')} ${esc(found.underlying_name || '')}　履約價 ${fmtMax(found.strike, 2)}<br>` +
          `行使比例 ${fmtMax(found.ratio, 4)}　最後交易日 ${esc(found.last_trade_date || '')}　${esc(found.category || '')}`;

        const w = { ...found, ...val, price: existing ? num(existing.price) : 0,
                    underlying_price: existing ? num(existing.underlying_price) : 0,
                    delta: existing ? existing.delta : null };
        const lines = [];
        if (existing && num(existing.price) > 0) {
          lines.push(`權證價 ${fmtMax(existing.price, 2)}　標的 ${fmtMax(existing.underlying_price, 2)}`);
          lines.push(`市值 ${fmt(warValue(w))} 元`);
          const de = warExposure(w);
          if (de !== null) lines.push(`delta ${fmtMax(warDelta(w), 3)}　delta 曝險 ${fmt(Math.abs(de))} 元`);
          if (isNum(existing.iv)) lines.push(`隱含波動率 ${(num(existing.iv) * 100).toFixed(1)}%`);
          if (isNum(existing.gearing)) lines.push(`實質槓桿 ${fmtMax(existing.gearing, 2)} 倍`);
          const pl = warPl(w);
          if (pl !== null) lines.push(`未實現損益 ${signed(pl)} 元`);
        } else {
          lines.push('權證價、隱波、delta 存檔後會自動帶入');
        }
        lines.push(`最大損失 ${fmt(warMaxRisk(w))} 元（權證買方最多賠光權利金）`);
        if (!ok) lines.push('⚠ 這是界限型／重設型，Black-Scholes 不適用，delta 請手動填');
        preview.innerHTML = lines.join('<br>');
      };

      let timer;
      form.code.addEventListener('input', () => {
        found = null;
        form.__found = null;
        clearTimeout(timer);
        timer = setTimeout(async () => {
          const c = norm(form.code.value);
          if (!/^[0-9A-Z]{6}$/.test(c)) { draw(); return; }
          found = await lookupWarrant(c);
          form.__found = found;
          if (!found) resolved.textContent = '查不到這個代號，確認一下是不是上櫃權證或已下市';
          else draw();
        }, 350);
        draw();
      });
      form.addEventListener('input', draw);
      form.addEventListener('change', draw);
      draw();
    },
    collect: (fd, form) => {
      const val = read(fd);
      if (!/^[0-9A-Z]{6}$/.test(val.code)) { toast('權證代號要 6 碼', 2500); return undefined; }
      if (!(val.lots > 0)) { toast('張數必須大於 0', 2500); return undefined; }
      // 把查到的基本資料一起存起來，不要等排程同步才有行使比例與標的
      const f = form.__found;
      if (f) {
        Object.assign(val, {
          name: f.name ?? null, cp: f.cp ?? null,
          underlying: f.underlying ?? null, underlying_name: f.underlying_name ?? null,
          strike: isNum(f.strike) ? num(f.strike) : null,
          ratio: isNum(f.ratio) ? num(f.ratio) : null,
          last_trade_date: f.last_trade_date ?? null,
          category: f.category ?? null,
        });
      }
      return val;
    },
  });
}

export async function editWarrant(id) {
  const existing = id ? state.warrants.find((w) => w.id === id) : null;
  const res = await openWarrantForm(existing);
  if (!res) return;
  try {
    if (res.action === 'delete') {
      const { error } = await sb.from('warrants').delete().eq('id', id);
      if (error) throw error;
      await refresh('已刪除');
    } else {
      const payload = { ...res.values, user_id: state.user.id };
      if (id) payload.id = id;
      const { error } = await sb.from('warrants').upsert(payload);
      if (error) throw error;
      await applyCachedPrices();
      await refresh('已儲存');
    }
  } catch (e) {
    fail(e);
  }
}

export async function editOption(id) {
  const existing = id ? state.options.find((o) => o.id === id) : null;
  const res = await openOptionsForm(existing);
  if (!res) return;
  try {
    if (res.action === 'delete') {
      const { error } = await sb.from('options').delete().eq('id', id);
      if (error) throw error;
      await refresh('已刪除');
    } else {
      const payload = { ...res.values, user_id: state.user.id };
      if (id) payload.id = id;
      const { error } = await sb.from('options').upsert(payload);
      if (error) throw error;
      await applyCachedPrices();
      await refresh('已儲存');
    }
  } catch (e) {
    fail(e);
  }
}

export async function editFutures(id) {
  const existing = id ? state.futures.find((f) => f.id === id) : null;
  const res = await openFuturesForm(existing);
  if (!res) return;
  try {
    if (res.action === 'delete') {
      const { error } = await sb.from('futures').delete().eq('id', id);
      if (error) throw error;
      await refresh('已刪除');
    } else {
      const payload = { ...res.values, user_id: state.user.id };
      if (id) payload.id = id;
      const { error } = await sb.from('futures').upsert(payload);
      if (error) throw error;
      await applyCachedPrices();
      await refresh('已儲存');
    }
  } catch (e) {
    fail(e);
  }
}

// ---------- 記一筆交易 ----------
function readTradeForm(fd) {
  const tk = fd.get('kind') || 'tw';
  const meta = TRADE_KINDS[tk] || TRADE_KINDS.tw;
  let quantity = num(fd.get('quantity'));
  if (tk === 'tw' && fd.get('unit') === 'lot') quantity *= 1000;

  const isDayTrade = fd.get('is_day_trade') === 'on';
  if (tk === 'option') {
    const expiry = String(fd.get('opt_expiry') || '').trim();
    const strike = num(fd.get('opt_strike'));
    const cp = fd.get('opt_cp') === 'put' ? 'put' : 'call';
    return {
      kindKey: tk, market: 'option', fut_kind: null, fut_size: null, is_day_trade: isDayTrade,
      opt_expiry: expiry, opt_strike: strike, opt_cp: cp,
      side: fd.get('side') || 'buy',
      trade_date: fd.get('trade_date') || todayISO(),
      symbol: 'TXO',
      name: `${expiry} ${strikeText(strike)} ${cpLabel(cp)}`,
      quantity,
      price: num(fd.get('price')),
      note: String(fd.get('note') || '').trim() || null,
    };
  }

  const symbol = (tk === 'tw' || tk === 'fut_stock') ? resolveTwSymbol(fd.get('symbol')) : norm(fd.get('symbol'));
  let name = String(fd.get('name') || '').trim() || null;
  if ((tk === 'tw' || tk === 'fut_stock') && !name && TW_STOCKS[symbol]) name = TW_STOCKS[symbol];
  if (tk === 'fut_index' && !name) name = indexProduct(symbol)?.name || null;
  return {
    kindKey: tk,
    market: meta.market,
    is_day_trade: isDayTrade,
    fut_kind: meta.fut_kind ?? null,
    fut_size: tk === 'fut_stock' ? num(fd.get('fut_size')) || 2000
            : tk === 'fut_index' ? (indexProduct(symbol)?.size ?? 200) : null,
    side: fd.get('side') || 'buy',
    trade_date: fd.get('trade_date') || todayISO(),
    symbol, name,
    quantity,
    price: num(fd.get('price')),
    note: String(fd.get('note') || '').trim() || null,
  };
}

function openTradeForm(defaults = {}) {
  const html = `
    <label>市場<select name="kind">${Object.entries(TRADE_KINDS)
      .map(([k, m]) => `<option value="${k}" ${defaults.kindKey === k ? 'selected' : ''}>${m.label}</option>`).join('')}</select></label>
    <div class="seg side-seg">
      <label><input type="radio" name="side" value="buy" checked><span>買進</span></label>
      <label><input type="radio" name="side" value="sell"><span>賣出</span></label>
    </div>
    <label class="check"><input type="checkbox" name="is_day_trade" ${defaults.is_day_trade ? 'checked' : ''}>
      <span>當沖（買賣自成一組，不動長期部位）</span></label>
    <label>日期<input name="trade_date" type="date" value="${todayISO()}" required></label>
    <label data-row="symbol"><span data-l="symbol">代號</span><input name="symbol" type="text" autocomplete="off" autocapitalize="characters" value="${esc(defaults.symbol || '')}"></label>
    <div class="resolved muted" data-resolved></div>
    <input type="hidden" name="name">
    <div data-row="opt" hidden>
      <label>到期<select name="opt_expiry">${state.optExpiries.length
        ? state.optExpiries.map((e) => `<option value="${esc(e.expiry)}">${esc(e.expiry)}（遠期 ${fmt(e.forward)}）</option>`).join('')
        : '<option value="">尚未載入到期別，按右上角 ↻</option>'}</select></label>
      <label>履約價<input name="opt_strike" type="number" step="any" inputmode="decimal" placeholder="47000"></label>
      <label>買權 / 賣權<select name="opt_cp">
        <option value="call">買權 Call</option><option value="put">賣權 Put</option>
      </select></label>
    </div>
    <label data-row="futsize">個股期貨規格<select name="fut_size">${STOCK_FUT_SIZES
      .map((s) => `<option value="${s.size}" ${num(defaults.fut_size) === s.size ? 'selected' : ''}>${s.label}</option>`).join('')}</select></label>
    <div class="qty-row">
      <label>數量<input name="quantity" type="number" step="any" inputmode="decimal" required min="0"></label>
      <label>單位<select name="unit"></select></label>
    </div>
    <label><span data-l="price">價格 (TWD)</span><input name="price" type="number" step="any" inputmode="decimal" required min="0"></label>
    <label>備註<input name="note" type="text" autocomplete="off"></label>
    <div class="preview" data-preview hidden></div>`;

  return openDialog({
    title: '記一筆交易',
    html,
    onMount: (form) => {
      const resolved = $('[data-resolved]', form);
      const preview = $('[data-preview]', form);
      const rowFutSize = $('[data-row=futsize]', form);

      const updatePreviewRaw = () => {
        const v = readTradeForm(new FormData(form));
        if (!v.symbol || !(v.quantity > 0)) { preview.hidden = true; return; }
        const p = projectTrade(v);
        preview.hidden = false;
        preview.classList.toggle('err', !!p.error);
        if (p.error) { preview.textContent = p.error; return; }
        if (p.dayTrade) {
          const cc = tradeCost(v, true);
          preview.innerHTML =
            (p.matched > 0
              ? `沖銷 ${fmtQty(v.market, p.matched)}，配到 ${fmtMax(p.openAvg, 2)} → ${fmtMax(v.price, 2)}，` +
                `這一趟 <span class="${plClass(p.realized)}">${signed(p.realized)}</span> 元`
              : `建立當沖部位 ${fmtQty(v.market, v.quantity)}，等反向那一筆再結算`) +
            `<br><span class="muted">不影響長期持倉的股數與均價</span>` +
            `<br><span class="muted">手續費 ${fmtMax(cc.fee, 0)}${cc.tax > 0
              ? `　交易稅 ${fmtMax(cc.tax, 0)}${v.market === 'tw' ? '（當沖減半）' : ''}` : ''}</span>`;
          return;
        }
        const label = v.market === 'option'
          ? `TXO ${v.opt_expiry} ${strikeText(v.opt_strike)} ${cpLabel(v.opt_cp)}`
          : `${v.symbol}${v.name ? ' ' + v.name : ''}`;
        if (v.market === 'option') {
          const notional = v.quantity * v.price * OPT_SIZE;
          preview.textContent =
            `${label}：${fmtNet(p.prevNet)} → ${fmtNet(p.net)}　權利金 ${fmt(notional)} 元` +
            (p.after ? `　均價 ${fmtMax(p.prevCost, 2)} → ${fmtMax(p.newCost, 2)} 點` : '（部位歸零，將移除）');
        } else if (v.market === 'futures') {
          const notional = v.quantity * v.price * num(v.fut_size);
          preview.textContent =
            `${label}：${fmtNet(p.prevNet)} → ${fmtNet(p.net)}　本筆名目 ${fmt(notional)}` +
            (p.after ? `　均價 ${fmtMax(p.prevCost, 2)} → ${fmtMax(p.newCost, 2)}` : '（部位歸零，將移除）');
        } else {
          preview.textContent =
            `${label}：持有 ${fmtQty(v.market, p.prevShares)} → ${fmtQty(v.market, p.newShares)}，` +
            `均價 ${fmtMax(p.prevCost, 2)} → ${fmtMax(p.newCost, 2)}` +
            (p.after ? '' : '（全部出清，部位將移除）');
        }
        // 這一筆的手續費與交易稅
        const sameDay = state.trades.some((x) => tradeKey(x) === tradeKey(v) && x.side !== v.side);
        const cc = tradeCost(v, sameDay);
        if (cc.total > 0) {
          preview.innerHTML = preview.innerHTML +
            `<br><span class="muted">手續費 ${fmtMax(cc.fee, 0)}${cc.tax > 0 ? `　交易稅 ${fmtMax(cc.tax, 0)}` : ''}` +
            `　成本合計 ${fmtMax(cc.total, 0)} ${cc.ccy}${sameDay ? '（當沖費率）' : ''}</span>`;
        }
      };

      // 規則檢查放在最上面，因為手癢是在按下確定那一刻發生的。
      // 不擋存檔，但要讓你看見自己正在破自己定的戒。
      const updatePreview = () => {
        updatePreviewRaw();
        const v = readTradeForm(new FormData(form));
        const rb = checkRules(v);
        if (!rb.length) return;
        preview.hidden = false;
        preview.insertAdjacentHTML('afterbegin', rb.map((x) =>
          `<div class="break-item"><b>違反自己的規則：</b>${esc(x.text)}<br><span class="muted">${esc(x.why)}</span></div>`
        ).join(''));
      };

      const rowSymbol = $('[data-row=symbol]', form);
      const rowOpt = $('[data-row=opt]', form);

      const setKind = () => {
        const k = form.kind.value;
        const isOpt = k === 'option';
        const isWarrant = k === 'warrant';
        const isStockFut = k === 'fut_stock', isIdxFut = k === 'fut_index';
        rowOpt.hidden = !isOpt;
        rowSymbol.hidden = isOpt;
        resolved.hidden = isOpt;
        form.symbol.required = !isOpt;
        if (isOpt) {
          $('[data-l=price]', form).textContent = '權利金（點）';
          form.unit.innerHTML = '<option value="share">口</option>';
          form.unit.disabled = true;
          form.name.value = '';
          updatePreview();
          return;
        }
        rowFutSize.hidden = !isStockFut;
        $('[data-l=symbol]', form).textContent =
          isIdxFut ? '商品' : isStockFut ? '標的股票代號' : isWarrant ? '權證代號' : '代號';
        $('[data-l=price]', form).textContent =
          k === 'us' ? '價格 (USD)' : isIdxFut ? '成交價（指數）' : isWarrant ? '權證價（元／單位）' : '價格 (TWD)';
        form.symbol.placeholder =
          k === 'tw' || isStockFut ? '2330 或 台積' : isIdxFut ? 'TX / 小台 / 微台' : isWarrant ? '030573' : 'VOO';
        form.unit.innerHTML = k === 'tw'
          ? '<option value="lot">張</option><option value="share">股</option>'
          : k === 'us' ? '<option value="share">股</option>'
          : isWarrant ? '<option value="share">張</option>' : '<option value="share">口</option>';
        form.unit.disabled = k !== 'tw';
        form.name.value = '';
        resolved.textContent = k === 'us' ? '美股不會自動帶名稱' : '輸入代號或名稱會自動帶出';
        updatePreview();
      };

      attachLookup(form.symbol,
        () => (form.kind.value === 'fut_index' ? 'index'
             : form.kind.value === 'us' || form.kind.value === 'warrant' ? 'none' : 'tw'),
        (m, picked) => {
          form.name.value = m.name || '';
          resolved.textContent = `${m.code}　${m.name || ''}`;
          updatePreview();
          if (picked) form.quantity.focus();
        });
      form.symbol.addEventListener('input', () => {
        const k = form.kind.value;
        if (k === 'option') return;
        if (k === 'warrant') {
          const c = norm(form.symbol.value);
          if (/^[0-9A-Z]{6}$/.test(c)) {
            lookupWarrant(c).then((w) => {
              if (w && norm(form.symbol.value) === c) {
                form.name.value = w.name || '';
                resolved.textContent = `${w.name || ''}　標的 ${w.underlying || ''} ${w.underlying_name || ''}　履約 ${fmtMax(w.strike, 2)}`;
              }
            });
          } else { resolved.textContent = '輸入 6 碼權證代號'; }
          return;
        }
        const lk = k === 'fut_index' ? LOOKUPS.index : k === 'us' ? null : LOOKUPS.tw;
        if (lk && !lk.exact(norm(form.symbol.value))) {
          form.name.value = '';
          resolved.textContent = form.symbol.value.trim() ? '（找不到，會以你輸入的代號建立）' : '';
        }
      });
      form.kind.addEventListener('change', setKind);
      form.addEventListener('input', updatePreview);
      form.addEventListener('change', updatePreview);
      setKind();
    },
    collect: (fd) => {
      const values = readTradeForm(fd);
      if (values.market === 'option') {
        if (!values.opt_expiry) { toast('請選擇到期', 2500); return undefined; }
        if (!(values.opt_strike > 0)) { toast('請輸入履約價', 2500); return undefined; }
      }
      const p = projectTrade(values);
      if (p.error) { toast(p.error, 3500); return undefined; }
      if (!(values.price > 0)) { toast('請輸入價格', 2500); return undefined; }
      return values;
    },
  });
}

export async function logTrade(defaults) {
  const res = await openTradeForm(defaults);
  if (res?.action === 'save') await saveTrade(res.values);
}

export async function editEps(symbol, name) {
  const v = valOf(symbol) || {};
  const unit = v.ccy === 'USD' ? '美元' : '元';
  const res = await openForm({
    title: `${symbol} ${name || ''} 預估 EPS`,
    fields: [
      { key: 'eps2026', label: `2026 預估 EPS（${unit}，留空就用內建參考值）`, type: 'number' },
      { key: 'eps2027', label: `2027 預估 EPS（${unit}）`, type: 'number' },
      { key: 'eps2028', label: `2028 預估 EPS（${unit}）`, type: 'number' },
      { key: 'note', label: '備註：哪一家券商、什麼時候看到的', type: 'text' },
    ],
    values: { eps2026: v.mine ? v.eps2026 : null, eps2027: v.mine ? v.eps2027 : null,
              eps2028: v.mine ? v.eps2028 : null, note: '' },
  });
  if (!res || res.action !== 'save') return;
  try {
    const rows = FWD_YEARS.map(([fy]) => ({
      user_id: state.user.id, symbol: norm(symbol), fy,
      eps: res.values['eps' + fy], note: res.values.note,
      updated_at: new Date().toISOString(),
    }));
    const { error } = await sb.from('eps_override').upsert(rows, { onConflict: 'user_id,symbol,fy' });
    if (error) throw error;
    await refresh('已儲存預估 EPS');
  } catch (e) {
    fail(e);
  }
}

// ------------------------------------------------------------
// 期貨轉倉
//   轉倉的本質：**部位沒有變，但成本基礎重設，而且近月的損益要實現。**
//   多單轉倉 = 賣掉近月 + 買進遠月，口數一樣；空單反過來。
//   順序有差，要先平倉再建倉，否則均價會算錯。
//
//   要分清楚兩件常被混為一談的事：
//     平倉實現損益  這筆虧損早就存在了（未實現），轉倉只是讓它變成已實現。
//     轉倉真正的成本  只有「遠月與近月的價差」加上兩邊的手續費與交易稅。
//   把 8 萬的實現虧損說成「轉倉成本」會嚇到自己，而且是錯的。
// ------------------------------------------------------------
function rollPreview(v) {
  const dir = v.isLong ? 1 : -1;
  const notionalNear = v.lots * v.nearPx * v.size;
  const notionalFar = v.lots * v.farPx * v.size;
  // 平倉那筆的實現損益：多單是（賣價 − 成本），空單相反
  const realized = isNum(v.cost) ? (v.nearPx - v.cost) * dir * v.lots * v.size : null;
  // 轉倉價差：多單要賣近月買遠月，遠月比近月貴就是成本
  const spread = (v.farPx - v.nearPx) * dir * v.lots * v.size;
  const legClose = tradeCost({ market: 'futures', quantity: v.lots, price: v.nearPx,
                               fut_size: v.size, side: v.isLong ? 'sell' : 'buy' }, false);
  const legOpen = tradeCost({ market: 'futures', quantity: v.lots, price: v.farPx,
                              fut_size: v.size, side: v.isLong ? 'buy' : 'sell' }, false);
  const fee = legClose.fee + legOpen.fee;
  const tax = legClose.tax + legOpen.tax;
  return { realized, spread, fee, tax, cost: spread + fee + tax, notionalNear, notionalFar };
}

export async function rollFutures(preId) {
  const list = state.futures;
  if (!list.length) return toast('沒有期貨部位可以轉倉', 3000);

  const opt = (f) => {
    const nm = f.contract || futDisplayName(f.kind, f.symbol, f.size);
    return `<option value="${esc(f.id)}">${esc(nm)}　${f.side === 'short' ? '空' : '多'} ${
      fmtMax(f.lots, 2)} 口</option>`;
  };
  const html = `
    <label>要轉倉的部位<select name="pid">${list.map(opt).join('')}</select></label>
    <label>口數（可以只轉一部分）<input name="lots" type="number" step="any" inputmode="decimal" required min="0"></label>
    <label>近月成交價（平倉這一邊）<input name="near" type="number" step="any" inputmode="decimal" required></label>
    <label>遠月成交價（建倉這一邊）<input name="far" type="number" step="any" inputmode="decimal" required></label>
    <label>日期<input name="trade_date" type="date" value="${todayISO()}" required></label>
    <label>備註<input name="note" type="text" placeholder="例如 9 月轉 10 月" autocomplete="off"></label>
    <div class="preview" data-preview hidden></div>`;

  const res = await openDialog({
    title: '期貨轉倉',
    html,
    onMount: (form) => {
      const preview = $('[data-preview]', form);
      const cur = () => list.find((x) => String(x.id) === String(form.pid.value)) || list[0];
      const syncLots = () => { form.lots.value = num(cur().lots); };
      const draw = () => {
        const f = cur();
        const lots = num(form.lots.value), near = num(form.near.value), far = num(form.far.value);
        if (!(lots > 0) || !(near > 0) || !(far > 0)) { preview.hidden = true; return; }
        const v = { isLong: f.side !== 'short', lots, size: num(f.size),
                    cost: isNum(f.cost) ? num(f.cost) : null, nearPx: near, farPx: far };
        const p = rollPreview(v);
        const over = lots > num(f.lots) + 1e-9;
        preview.hidden = false;
        preview.classList.toggle('err', over);
        preview.innerHTML = over
          ? `口數超過持有的 ${fmtMax(f.lots, 2)} 口`
          : `${v.isLong ? '賣出' : '買回'}近月 ${fmtMax(lots, 2)} 口 @ ${fmtMax(near, 2)}，` +
            `再${v.isLong ? '買進' : '賣出'}遠月 @ ${fmtMax(far, 2)}<br>` +
            `<b>轉倉成本 ${fmt(p.cost)} 元</b>` +
            `<span class="muted">（價差 ${signed(p.spread)}　手續費 ${fmt(p.fee)}　交易稅 ${fmt(p.tax)}）</span><br>` +
            (p.realized === null
              ? '<span class="muted">原部位沒填成本，不會產生實現損益</span>'
              : `同時實現原本的未實現損益 <span class="${plClass(p.realized)}">${signed(p.realized)}</span>` +
                `<span class="muted">（均價 ${fmtMax(v.cost, 2)} → ${fmtMax(far, 2)}）</span>`) +
            `<br><span class="muted">部位不變，仍是 ${f.side === 'short' ? '空' : '多'} ${
              fmtMax(f.lots, 2)} 口。實現損益早就存在，轉倉只是讓它入帳；真正的成本只有上面那一行。</span>`;
      };
      form.pid.onchange = () => { syncLots(); draw(); };
      $$('input', form).forEach((i) => (i.oninput = draw));
      syncLots();
      if (preId) { form.pid.value = String(preId); syncLots(); }
      draw();
    },
    collect: (fd) => {
      const f = list.find((x) => String(x.id) === String(fd.get('pid')));
      const lots = num(fd.get('lots'));
      if (!f || !(lots > 0)) return undefined;
      if (lots > num(f.lots) + 1e-9) { toast('口數超過持有量', 3000); return undefined; }
      return { f, lots, near: num(fd.get('near')), far: num(fd.get('far')),
               trade_date: fd.get('trade_date') || todayISO(),
               note: String(fd.get('note') || '').trim() || null };
    },
  });
  if (!res || res.action !== 'save') return;

  const { f, lots, near, far, trade_date, note } = res.values;
  const isLong = f.side !== 'short';
  const base = {
    kindKey: f.kind === 'stock' ? 'fut_stock' : 'fut_index',
    market: 'futures', fut_kind: f.kind, fut_size: num(f.size),
    is_day_trade: false, trade_date,
    symbol: f.symbol, name: f.name || TW_STOCKS[norm(f.symbol)] || null, quantity: lots,
  };
  try {
    // **順序不能反。**先平倉才會用舊均價算出實現損益，
    // 先建倉的話均價會先被拉走，實現損益就錯了。
    await saveTrade({ ...base, side: isLong ? 'sell' : 'buy', price: near,
                      note: note ? `轉倉平倉・${note}` : '轉倉平倉' });
    await saveTrade({ ...base, side: isLong ? 'buy' : 'sell', price: far,
                      note: note ? `轉倉建倉・${note}` : '轉倉建倉' });
    toast('轉倉完成，已記錄兩筆', 3000);
  } catch (e) {
    fail(e);
  }
}

// ------------------------------------------------------------
// 心得 / 交易日誌
//   這頁的重點不是損益，是「有沒有照著自己的規則做」。
//   損益是結果，紀律是原因。只看損益的話，會在賺錢的月份把壞習慣放大。
// ------------------------------------------------------------
const MOODS = [[5, '很好'], [4, '還行'], [3, '普通'], [2, '不佳'], [1, '很差']];

export async function editJournal(dateISO) {
  const row = state.journalDays.find((d) => d.d === dateISO);
  const b = breaksOn(dateISO);
  const hint = b.length
    ? `<div class="break-item">這天有 ${b.length} 項違規：${esc(b.map((x) => x.text).join('；'))}</div>`
    : '<div class="sub muted">這天沒有偵測到違規。</div>';
  const html = `
    <p class="sub muted">${esc(dateISO)}　已實現 ${signed(num(row?.realized))}　${
      fmt(num(row?.trades))} 筆交易</p>
    ${hint}
    <label>心得
      <textarea name="body" class="journal-input" placeholder="今天做了什麼、為什麼做、哪裡做對、哪裡手癢了。寫給三個月後的自己看。">${esc(row?.body || '')}</textarea>
    </label>
    <label>紀律自評（評的是有沒有照規則做，不是賺賠）
      <select name="mood">${MOODS.map(([v, l]) =>
        `<option value="${v}" ${num(row?.mood) === v ? 'selected' : ''}>${v} ${l}</option>`).join('')}</select>
    </label>
    <label class="chk"><input type="checkbox" name="followed" ${row?.followed ? 'checked' : ''}>
      <span>今天守住了所有規則</span></label>`;
  const res = await openDialog({
    title: `${dateISO} 心得`,
    html,
    collect: (fd) => ({
      body: (fd.get('body') || '').toString().trim() || null,
      mood: Number(fd.get('mood')) || null,
      followed: fd.get('followed') === 'on',
    }),
  });
  if (!res || res.action !== 'save') return;
  try {
    const { error } = await sb.from('journal').upsert({
      user_id: state.user.id, entry_date: dateISO,
      body: res.values.body, mood: res.values.mood, followed: res.values.followed,
      pl_snapshot: num(row?.realized), updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,entry_date' });
    if (error) throw error;
    await refresh('心得已儲存');
  } catch (e) { fail(e); }
}

export async function editRule(existing) {
  const v = existing || { kind: 'free', scope: 'all', title: '', detail: '', amount: null };
  const res = await openForm({
    title: existing ? '編輯規則' : '新增規則',
    fields: [
      { key: 'title', label: '規則', type: 'text', required: true },
      { key: 'detail', label: '為什麼要有這條（寫給以後想破戒的自己）', type: 'text' },
      { key: 'kind', label: '檢查方式', type: 'select', options: [
        ['free', '只提醒，不自動檢查'],
        ['opt_only_hedge', '選擇權只准 buy put / sell call'],
        ['day_one_at_a_time', '個股當沖一次一檔'],
        ['day_max_amount', '個股當沖單檔金額上限'],
        ['scale_in', '一律分批（提醒）'],
      ] },
      { key: 'amount', label: '金額上限（只有「單檔金額上限」用得到）', type: 'number' },
    ],
    values: v,
    allowDelete: !!existing,
  });
  if (!res) return;
  try {
    if (res.action === 'delete') {
      const { error } = await sb.from('rules').delete().eq('id', existing.id);
      if (error) throw error;
      return refresh('規則已刪除');
    }
    const payload = { ...res.values, user_id: state.user.id, scope: v.scope || 'all',
                      updated_at: new Date().toISOString() };
    if (existing) payload.id = existing.id;
    const { error } = await sb.from('rules').upsert(payload);
    if (error) throw error;
    await refresh('規則已儲存');
  } catch (e) { fail(e); }
}
