import { $, $$, esc, fail, fmt, fmtMax, isNum, norm, num, plClass, sb, signed, state, toast, todayISO } from './core.js';
import { applyCachedPrices, refresh } from './data.js';
import { openDialog, openForm } from './dialog.js';
import { OPT_SIZE, STOCK_FUT_SIZES, cpLabel, fmtNet, fmtQty, futDaysLeft, futDisplayName, futMonthLabel, futMonths, futSettleISO, optDeltaExp, optExpired, optExpiryLabel, optForwardInfo, optPl, optStrategy, optValue, strikeText, warDelta, warExposure, warMaxRisk, warPl, warValue, ymAdd } from './instruments.js';
import { futPl } from './live.js';
import { FWD_YEARS, valOf } from './portfolio.js';
import { breaksOn, checkRules, optCallNote } from './rules.js';
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
    <label>交割月份${monthSelect(v.month)}</label>
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
      month: String(fd.get('month') || '') || null,
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

// 到期別下拉。**已經過最後交易日的合約一定要拿掉。**
//   state.optExpiries 其實是「market_prices 裡所有 FWD| 列」，到期的合約不會被刪，
//   只是報價停在最後交易日。2026-09-16 打開選單，裡面還排著 9/11 就結算的
//   202609F2——選下去記錄起來一切正常，但那口合約早就不存在了，
//   而且它的遠期價停在 41200，後面判斷價內價外會整整差 10%。
//   **正在編輯的那一筆要例外**：它本來就選著舊的到期別，
//   把選項抽掉會讓 select 自己跳到別的月份，等於默默改掉使用者的資料。
function expiryOptions(sel) {
  const cur = String(sel || '');
  const keep = state.optExpiries.filter((e) => !optExpired(e.expiry) || e.expiry === cur);
  if (cur && !keep.some((e) => e.expiry === cur)) keep.unshift({ expiry: cur, forward: null });
  if (!keep.length) return '<option value="">尚未載入到期別，按右上角 ↻</option>';
  return keep.map((e) => {
    const tail = optExpiryLabel(e.expiry);
    return `<option value="${esc(e.expiry)}" ${e.expiry === cur ? 'selected' : ''}>${esc(e.expiry)}${
      tail ? `　${esc(tail)}` : ''}${isNum(e.forward) ? `　遠期 ${fmt(e.forward)}` : ''}</option>`;
  }).join('');
}

function openOptionsForm(existing) {
  const live = state.optExpiries.filter((e) => !optExpired(e.expiry));
  const v = existing || { expiry: live[0]?.expiry ?? '', strike: '', cp: 'call', side: 'long', lots: 1, cost: '' };
  const expOpts = expiryOptions(v.expiry);

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
        // **最大損益要連同一個到期別的其他腳一起算。**
        //   只看這一腳的話，賣出買權永遠是「無上限」，可是只要上面有一口
        //   買進買權接住就封頂了。他現在正在建的往往就是第二腳，
        //   那一刻正是最需要看到「組起來之後最壞是多少」的時候。
        const others = state.options.filter((x) => x.id !== existing?.id && String(x.expiry) === val.expiry);
        // 這一腳的成本基準。新增的時候成本欄可以空著、權利金也還沒抓進來，
        // **那就是算不出金額，不是 0**。原本寫 `price: cur ?? 0`，
        // 結果新增一口買進買權會顯示「到期最大虧損 0 元」——
        // 正好是作者自己註解說「最需要看到最壞是多少」的那一刻，卻給了最好看的數字。
        //
        // 形狀（是不是無上限）跟權利金無關，只看右尾買權的淨口數，所以照樣算得出來，
        // 金額則等成本填了再說。
        const basisKnown = isNum(val.cost) || cur !== null;
        const plan = optStrategy([...others, { ...val, price: cur ?? 0 }]);
        if (plan) {
          const un = plan.maxLoss === null;
          lines.push(`${others.length ? `${val.expiry} 整組（${others.length + 1} 腳）` : ''}${plan.name}`);
          lines.push(un ? '⚠ 到期最大虧損無上限'
            : !basisKnown ? '到期最大虧損：填了平均成本才算得出金額'
              : `到期最大虧損 ${fmt(-plan.maxLoss)} 元`
                + `　最大獲利 ${plan.maxGain === null ? '無上限' : fmt(plan.maxGain) + ' 元'}`);
          if (basisKnown && plan.breakEvens.length) {
            lines.push(`損益兩平 ${plan.breakEvens.map((x) => fmt(x)).join(' / ')}`);
          }
          preview.classList.toggle('err', un);
        }
        preview.innerHTML = lines.join('<br>');
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
        // 新增的那一刻成本還沒填、權證價也還沒抓進來，算不出最大損失。
        // **這時候不能印 0。**「最大損失 0 元」看起來像一個好消息，
        // 實際上是「我不知道」，而那正是他最需要看清楚的一個數字。
        const wMax = warMaxRisk(w);
        lines.push(wMax === null
          ? '最大損失：填了成本才算得出來（權證買方最多賠光權利金）'
          : `最大損失 ${fmt(wMax)} 元（權證買方最多賠光權利金）`);
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
      opt_fwd: fd.get('opt_fwd') === '' || fd.get('opt_fwd') === null ? null : num(fd.get('opt_fwd')),
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
      <span>當沖（買賣自成一組，不動長期部位，證交稅減半）</span></label>
    <p class="sub muted style-note">隔日衝不用勾——買賣差一個交易日系統自己認得出來。</p>
    <label>日期<input name="trade_date" type="date" value="${todayISO()}" required></label>
    <label data-row="symbol"><span data-l="symbol">代號</span><input name="symbol" type="text" autocomplete="off" autocapitalize="characters" value="${esc(defaults.symbol || '')}"></label>
    <div class="resolved muted" data-resolved></div>
    <input type="hidden" name="name">
    <div data-row="opt" hidden>
      <label>到期<select name="opt_expiry">${expiryOptions('')}</select></label>
      <label>履約價<input name="opt_strike" type="number" step="any" inputmode="decimal" placeholder="47000"></label>
      <label>買權 / 賣權<select name="opt_cp">
        <option value="call">買權 Call</option><option value="put">賣權 Put</option>
      </select></label>
      <label>當時的指數（判斷價內用，<b>夜盤下的單一定要填</b>）
        <input name="opt_fwd" type="number" step="any" inputmode="decimal" placeholder="不填就用最近一次日盤結算的遠期價"></label>
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
        // 這一筆的手續費與交易稅。
        //
        //   **費率一定要照「當沖」那個勾選算，不能推斷。** 這裡原本寫的是
        //   「同一天同標的有反向成交就當成當沖」，但那正是 trades.js 開頭
        //   明文放棄的推論法：當沖 1 口的同一天又賣掉 5 口長期部位，
        //   那 5 口會被誤判成當沖。後果是預覽顯示減半的證交稅、
        //   存進去之後紀錄頁用 is_day_trade 算出全額，**兩個數字對不起來**，
        //   而使用者是看著預覽按下確定的。
        //
        //   推斷本身還是有用，只是用途不同：它該拿來提醒「你是不是忘了勾」，
        //   不是拿來改費率。
        const cc = tradeCost(v, false);
        const sameDay = state.trades.some((x) => tradeKey(x) === tradeKey(v) && x.side !== v.side);
        if (cc.total > 0) {
          preview.innerHTML = preview.innerHTML +
            `<br><span class="muted">手續費 ${fmtMax(cc.fee, 0)}${cc.tax > 0 ? `　交易稅 ${fmtMax(cc.tax, 0)}` : ''}` +
            `　成本合計 ${fmtMax(cc.total, 0)} ${cc.ccy}</span>` +
            (sameDay && v.market === 'tw' && v.side === 'sell'
              ? '<br><span class="note-warn">今天這一檔已經有反向成交。'
                + '如果這一筆是當沖，記得勾「當沖」，證交稅才會減半；沒勾就是照全額算。</span>'
              : '');
        }
      };

      // 規則檢查放在最上面，因為手癢是在按下確定那一刻發生的。
      // 不擋存檔，但要讓你看見自己正在破自己定的戒。
      const updatePreview = () => {
        updatePreviewRaw();
        const v = readTradeForm(new FormData(form));
        const rb = checkRules(v);
        // 沒違規的買 call 也要講一句話，否則畫面全白，看不出規則有沒有在跑
        const pass = rb.length ? null : optCallNote(v);
        if (!rb.length && !pass) return;
        preview.hidden = false;
        if (pass) {
          preview.insertAdjacentHTML('afterbegin',
            `<div class="break-item pass-item"><b>買 call 解 ban：</b>${esc(pass)}</div>`);
        }
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
          // 把自動抓到的指數與它的日期寫進 placeholder，
          // 使用者才知道「不填的話會拿哪一天的數字去判斷價內」
          const f = optForwardInfo(form.opt_expiry.value);
          form.opt_fwd.placeholder = f
            ? `不填就用 ${fmt(f.value)}（${f.as_of} 日盤結算）`
            : '不填就用最近一次日盤結算的遠期價';
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
// 交割月份下拉。掛牌中的五個月份由 futMonths() 算出來
// （當月起連續兩個月 ＋ 三個接續季月，臺灣期交所的規格）。
// 舊部位可能還沒填，所以保留一個空選項，而且如果存的月份已經不在掛牌清單裡
// （例如已經過期的），也要把它列出來，否則一打開表單就被默默改掉。
function monthSelect(cur, name = 'month') {
  const cv = String(cur || '');
  const months = futMonths();
  if (cv && !months.includes(cv)) months.unshift(cv);
  return `<select name="${name}">
    <option value="">（未設定）</option>
    ${months.map((m) => {
      const d = futDaysLeft(m);
      const tail = d === null ? '' : d < 0 ? '・已到期' : d <= 7 ? `・剩 ${d} 天` : `・${futSettleISO(m)}`;
      return `<option value="${m}" ${cv === m ? 'selected' : ''}>${futMonthLabel(m)}${tail}</option>`;
    }).join('')}
  </select>`;
}

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
    <div class="mon-row">
      <span class="mon-from" data-from>—</span>
      <span class="mon-arrow">→</span>
      <label class="mon-to">轉到${monthSelect('', 'to')}</label>
    </div>
    <label>口數（可以只轉一部分）<input name="lots" type="number" step="any" inputmode="decimal" required min="0"></label>
    <label>近月成交價（平倉這一邊）<input name="near" type="number" step="any" inputmode="decimal" required></label>
    <label>遠月成交價（建倉這一邊）<input name="far" type="number" step="any" inputmode="decimal" required></label>
    <label>日期<input name="trade_date" type="date" value="${todayISO()}" required></label>
    <label>備註（選填）<input name="note" type="text" autocomplete="off"></label>
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
      // 選了部位就把它現在的月份顯示出來，並把「轉到」預設成下一個月。
      // **備註欄原本要自己打「9 月轉 10 月」**，打字容易錯又不會影響任何計算；
      // 現在月份是真的欄位，轉完會寫回部位。
      const syncMonth = () => {
        const f = list.find((x) => String(x.id) === String(form.pid.value));
        const from = $('[data-from]', form);
        const cur = String(f?.month || '');
        from.textContent = cur ? futMonthLabel(cur) : '未設定月份';
        from.classList.toggle('muted', !cur);
        // **要挑「下一個掛牌的月份」，不是「下個月」。**
        // 掛牌的是連續兩個月加三個季月，所以十月倉的下一個是十二月倉，
        // 十一月根本沒掛牌。原本用 ymAdd(cur,1) 找不到就退回清單第二個，
        // 結果十月倉的「轉到」預設也是十月倉，等於轉了個寂寞。
        const next = futMonths().find((m) => m > cur);
        form.to.value = next || '';
      };
      form.pid.onchange = () => { syncLots(); syncMonth(); draw(); };
      $$('input', form).forEach((i) => (i.oninput = draw));
      syncLots(); syncMonth();
      if (preId) { form.pid.value = String(preId); syncLots(); syncMonth(); }
      draw();
    },
    collect: (fd) => {
      const f = list.find((x) => String(x.id) === String(fd.get('pid')));
      const lots = num(fd.get('lots'));
      if (!f || !(lots > 0)) return undefined;
      if (lots > num(f.lots) + 1e-9) { toast('口數超過持有量', 3000); return undefined; }
      const to = String(fd.get('to') || '');
      if (to && f.month && to === f.month) {
        toast('轉到的月份跟現在同一個月，那不是轉倉', 3500);
        return undefined;
      }
      return { f, lots, near: num(fd.get('near')), far: num(fd.get('far')),
               to: to || null,
               trade_date: fd.get('trade_date') || todayISO(),
               note: String(fd.get('note') || '').trim() || null };
    },
  });
  if (!res || res.action !== 'save') return;

  const { f, lots, near, far, to, trade_date, note } = res.values;
  const isLong = f.side !== 'short';
  // 備註自動帶上「9 月倉 → 10 月倉」，交易紀錄裡看得出來這是哪一次轉倉
  const monTag = f.month && to ? `${futMonthLabel(f.month)} → ${futMonthLabel(to)}` : '';
  const noteText = [monTag, note].filter(Boolean).join('・');
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
                      note: noteText ? `轉倉平倉・${noteText}` : '轉倉平倉' });
    await saveTrade({ ...base, side: isLong ? 'buy' : 'sell', price: far,
                      note: noteText ? `轉倉建倉・${noteText}` : '轉倉建倉' });

    // **部位的月份要跟著換，不然轉完了畫面上還是舊月份。**
    // 只在「整筆都轉掉」時才改：只轉一部分的話那一筆部位同時存在兩個月份，
    // 這個資料結構表達不了，硬改會讓剩下沒轉的那幾口月份也變錯。
    //
    // **不能用 f.id 去更新。** 平倉那一筆讓部位歸零時，writePosition 會把
    // 整列刪掉；建倉那一筆再新增一列，**id 是全新的**。拿舊 id 去 update
    // 會更新到 0 列，而且 Supabase 不會回報錯誤——結果就是轉倉看起來成功、
    // 月份卻永遠停在舊的那個月，完全沒有跡象。
    // 所以要先 refresh 拿到新的部位列，再用「商品」而不是 id 去找。
    await refresh();
    if (to && lots >= num(f.lots) - 1e-9) {
      const kind = f.kind || 'index';
      const pos = state.futures.find((x) => (x.kind || 'index') === kind
        && norm(x.symbol) === norm(f.symbol)
        && (kind === 'index' || num(x.size) === num(f.size)));
      if (pos) {
        const { error } = await sb.from('futures').update({ month: to }).eq('id', pos.id);
        if (error) console.warn('更新交割月份失敗', error);
        else await refresh();
      } else {
        console.warn('轉倉後找不到新的部位列，月份沒更新');
      }
    }
    toast(to && lots < num(f.lots) - 1e-9
      ? '轉倉完成，已記錄兩筆。只轉了一部分，月份請自己到部位裡確認'
      : `轉倉完成，已記錄兩筆${monTag ? `（${monTag}）` : ''}`, 4000);
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
        ['max_position_pct', '單檔曝險上限（金額填總資產的 %，指數不算）'],
        ['max_exposure', '總曝險上限（金額填總資產的倍數，例如 1）'],
        ['no_day_trade', '不當沖：勾了當沖，或同一天同一檔一買一賣'],
        ['opt_only_hedge', '選擇權只准 buy put / sell call'],
        ['day_one_at_a_time', '個股當沖一次一檔'],
        ['day_max_amount', '個股當沖單檔金額上限'],
        ['scale_in', '一律分批（提醒）'],
      ] },
      { key: 'amount', label: '金額上限（當沖：單檔上限；選擇權：買 call 每日權利金額度；單檔曝險：總資產的 %；總曝險：倍數）', type: 'number' },
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
