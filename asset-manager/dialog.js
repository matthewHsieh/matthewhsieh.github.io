import { $, $$, esc, norm } from './core.js';
import { TW_STOCKS, attachLookup, resolveTwSymbol } from './symbols.js';

// ============================================================
// 對話框
// ============================================================
export function openDialog({ title, html, allowDelete = false, onMount, collect }) {
  return new Promise((resolve) => {
    const dlg = $('#form-dialog');
    const form = $('#form-dialog-form');
    $('h2', dlg).textContent = title;
    $('.fields', dlg).innerHTML = html;
    $('#form-delete').hidden = !allowDelete;

    const finish = (result) => { resolve(result); if (dlg.open) dlg.close(); };
    form.onsubmit = (e) => {
      e.preventDefault();
      if (!form.reportValidity()) return;
      const values = collect(new FormData(form), form);
      if (values === undefined) return;
      finish({ action: 'save', values });
    };
    $('#form-delete').onclick = () => { if (confirm('確定要刪除嗎？')) finish({ action: 'delete' }); };
    $('#form-cancel').onclick = () => finish(null);
    dlg.addEventListener('close', () => resolve(null), { once: true });

    if (onMount) onMount(form);
    dlg.showModal();
    const first = $('input:not([type=hidden]):not([type=radio]), select', form);
    if (first) first.focus();
  });
}

function fieldHtml(f, v) {
  const val = v === null || v === undefined ? '' : v;
  const req = f.required ? 'required' : '';
  const ph = `placeholder="${esc(f.placeholder || '')}"`;
  const lookup = f.lookup ? `data-lookup="${f.lookup}"` : '';
  if (f.type === 'select') {
    return `<label>${esc(f.label)}<select name="${f.key}">${f.options
      .map(([k, l]) => `<option value="${esc(k)}" ${String(val) === k ? 'selected' : ''}>${esc(l)}</option>`)
      .join('')}</select></label>`;
  }
  if (f.type === 'number') {
    return `<label>${esc(f.label)}<input name="${f.key}" type="number" step="any" inputmode="decimal" value="${esc(val)}" ${req} ${ph}></label>`;
  }
  return `<label>${esc(f.label)}<input name="${f.key}" type="text" value="${esc(val)}" ${req} ${ph} ${lookup} autocomplete="off"></label>`;
}

export function openForm({ title, fields, values = {}, allowDelete = false }) {
  return openDialog({
    title, allowDelete,
    html: fields.map((f) => fieldHtml(f, values[f.key])).join(''),
    onMount: (form) => {
      $$('input[data-lookup]', form).forEach((input) => {
        attachLookup(input, input.dataset.lookup, (m) => { if (form.name) form.name.value = m.name; });
      });
    },
    collect: (fd) => {
      const out = {};
      for (const f of fields) {
        const raw = fd.get(f.key);
        if (f.type === 'number') out[f.key] = raw === '' || raw === null ? null : Number(raw);
        else out[f.key] = typeof raw === 'string' ? raw.trim() || null : raw;
      }
      if (out.symbol) {
        out.symbol = fields.some((f) => f.key === 'symbol' && f.lookup === 'tw')
          ? resolveTwSymbol(out.symbol) : norm(out.symbol);
      }
      if (fields.some((f) => f.key === 'symbol' && f.lookup === 'tw') && !out.name && TW_STOCKS[out.symbol]) {
        out.name = TW_STOCKS[out.symbol];
      }
      return out;
    },
  });
}
