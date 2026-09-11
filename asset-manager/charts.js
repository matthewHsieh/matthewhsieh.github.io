// ============================================================
// 圖表：甜甜圈圖（資產組成）＋ 折線圖（淨資產 / 槓桿走勢）
// 純 SVG，不依賴任何函式庫。顏色走 CSS 變數，深淺色模式自動切換。
//
// 配色說明（已用色盲模擬驗證過）：
//   固定槽位 藍 → 橘 → 紫 → 綠松，顏色跟著「項目」走，不跟著大小排名走。
//   甜甜圈的相鄰順序就是這個槽位順序，任兩個相鄰色塊在一般視覺與
//   紅綠色盲模擬下都可清楚分辨；再加上每項都有文字標籤與數值表格。
// ============================================================

const NS = 'http://www.w3.org/2000/svg';
const TAU = Math.PI * 2;

const el = (tag, attrs = {}, text) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) n.setAttribute(k, String(v));
  if (text !== undefined) n.textContent = text;
  return n;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ------------------------------------------------------------
// 甜甜圈圖
//   slices: [{ label, value, color }]  color 用 CSS 變數名，例如 'var(--series-1)'
// ------------------------------------------------------------
export function donutChart({ slices, total, centerLabel, centerValue, format }) {
  const data = slices.filter((s) => s.value > 0);
  const wrap = document.createElement('div');
  wrap.className = 'chart donut-chart';

  if (!data.length || !(total > 0)) {
    wrap.innerHTML = '<p class="muted chart-empty">還沒有資產資料，先到「持倉」或「資金」登記。</p>';
    return wrap;
  }

  const size = 220, cx = size / 2, cy = size / 2, rOuter = 96, rInner = 62;
  const svg = el('svg', {
    viewBox: `0 0 ${size} ${size}`, class: 'donut', role: 'img',
    'aria-label': `${centerLabel} ${format(total)}，共 ${data.length} 個項目`,
  });

  const gapPx = 2;
  const single = data.length === 1;
  let a = -Math.PI / 2; // 從十二點鐘方向開始

  const segs = [];
  data.forEach((s, i) => {
    const frac = s.value / total;
    const sweep = frac * TAU;
    const gap = single ? 0 : Math.min(gapPx / rOuter, sweep * 0.3);
    const a0 = a + gap / 2, a1 = a + sweep - gap / 2;

    const path = el('path', {
      d: single ? ringPath(cx, cy, rOuter, rInner) : arcPath(cx, cy, rOuter, rInner, a0, a1),
      fill: s.color, class: 'donut-seg', tabindex: '0', role: 'listitem',
      'aria-label': `${s.label} ${format(s.value)}，佔 ${(frac * 100).toFixed(1)}%`,
    });
    segs.push({ path, slice: s, frac });
    svg.appendChild(path);
    a += sweep;
  });

  svg.appendChild(el('text', { x: cx, y: cy - 6, class: 'donut-center-label', 'text-anchor': 'middle' }, centerLabel));
  const centerVal = el('text', { x: cx, y: cy + 20, class: 'donut-center-value', 'text-anchor': 'middle' }, centerValue);
  svg.appendChild(centerVal);

  wrap.appendChild(svg);

  // 圖例＝同時當數值表格用（每項都有文字標籤與數字，不靠顏色辨識）
  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.innerHTML = data
    .map((s, i) => `<div class="legend-row" data-i="${i}">
        <span class="swatch" style="background:${s.color}"></span>
        <span class="legend-label">${s.label}${s.sub ? `<span class="legend-sub">${s.sub}</span>` : ''}</span>
        <span class="legend-value">${format(s.value)}</span>
        <span class="legend-pct">${((s.value / total) * 100).toFixed(1)}%</span>
      </div>`)
    .join('');
  wrap.appendChild(legend);

  const rows = [...legend.querySelectorAll('.legend-row')];
  const focus = (i) => {
    segs.forEach((g, j) => g.path.classList.toggle('dim', i !== null && i !== j));
    rows.forEach((r, j) => r.classList.toggle('active', i === j));
    if (i === null) {
      centerVal.textContent = centerValue;
    } else {
      centerVal.textContent = format(data[i].value);
    }
  };
  segs.forEach((g, i) => {
    g.path.addEventListener('pointerenter', () => focus(i));
    g.path.addEventListener('focus', () => focus(i));
    g.path.addEventListener('blur', () => focus(null));
  });
  rows.forEach((r, i) => {
    r.addEventListener('pointerenter', () => focus(i));
    r.addEventListener('click', () => focus(i));
  });
  wrap.addEventListener('pointerleave', () => focus(null));

  return wrap;
}

function arcPath(cx, cy, ro, ri, a0, a1) {
  const P = (r, ang) => [cx + r * Math.cos(ang), cy + r * Math.sin(ang)];
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = P(ro, a0), [x1, y1] = P(ro, a1);
  const [x2, y2] = P(ri, a1), [x3, y3] = P(ri, a0);
  return `M${x0} ${y0}A${ro} ${ro} 0 ${large} 1 ${x1} ${y1}L${x2} ${y2}A${ri} ${ri} 0 ${large} 0 ${x3} ${y3}Z`;
}
function ringPath(cx, cy, ro, ri) {
  return `M${cx} ${cy - ro}A${ro} ${ro} 0 1 1 ${cx - 0.01} ${cy - ro}Z` +
         `M${cx} ${cy - ri}A${ri} ${ri} 0 1 0 ${cx - 0.01} ${cy - ri}Z`;
}

// ------------------------------------------------------------
// 折線圖
//   series: [{ label, color, values: [num|null] }]
//   labels: x 軸文字（日期字串）
//   x 依實際日期比例排列；只在最後一點直接標數值
// ------------------------------------------------------------
// width：實際要畫多寬（px）。
// **一定要傳。** viewBox 固定 340 再用 width:100% 撐滿的話，
// 容器多寬字就被放大幾倍——桌機 690px 容器等於 2 倍，
// 10px 的軸標籤會渲染成 20px，比內文還大；手機 390px 只有 1.08 倍，
// 所以這個問題只在桌機看得到。把 viewBox 對齊實際寬度就不會縮放。
export function lineChart({ labels, dates, series, format, yZero = false, title, width }) {
  const wrap = document.createElement('div');
  wrap.className = 'chart line-chart';

  const n = labels.length;
  if (n === 0) {
    wrap.innerHTML = '<p class="muted chart-empty">還沒有紀錄。系統每個交易日會自動存一筆，明天就會開始出現走勢。</p>';
    return wrap;
  }
  if (n === 1) {
    // 只有一天：畫出目前的數值，並說明走勢還要再等一天
    wrap.innerHTML = `<div class="single-point">
      ${series.map((s) => `<div class="sp-row"><span class="swatch" style="background:${s.color}"></span>
        <span class="sp-label">${s.label}</span>
        <span class="sp-value">${s.values[0] === null || !Number.isFinite(s.values[0]) ? '–' : format(s.values[0])}</span></div>`).join('')}
      <p class="muted sp-note">${labels[0]}　目前只有一天的紀錄，明天起就會畫出走勢。</p>
    </div>`;
    return wrap;
  }

  const W = Math.max(320, Math.round(width || 340)), H = 190, padL = 8, padR = 54, padT = 14, padB = 24;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  const all = series.flatMap((s) => s.values).filter((v) => v !== null && Number.isFinite(v));
  if (!all.length) {
    wrap.innerHTML = '<p class="muted chart-empty">尚無可繪製的數值。</p>';
    return wrap;
  }
  let min = Math.min(...all), max = Math.max(...all);
  if (yZero) min = Math.min(0, min);
  if (min === max) { min -= Math.abs(min || 1) * 0.1; max += Math.abs(max || 1) * 0.1; }
  const pad = (max - min) * 0.12;
  min -= pad; max += pad;

  const t0 = dates[0].getTime(), t1 = dates[n - 1].getTime();
  const span = t1 - t0 || 1;
  const X = (i) => padL + ((dates[i].getTime() - t0) / span) * plotW;
  const Y = (v) => padT + plotH - ((v - min) / (max - min)) * plotH;

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`, class: 'line', role: 'img',
    'aria-label': `${title || ''} 折線圖，${labels[0]} 至 ${labels[n - 1]}`,
  });

  // 底線與格線（刻意低調）
  const ticks = niceTicks(min, max, 3);
  for (const t of ticks) {
    const y = Y(t);
    if (y < padT - 1 || y > padT + plotH + 1) continue;
    svg.appendChild(el('line', { x1: padL, y1: y, x2: padL + plotW, y2: y, class: 'grid' }));
    svg.appendChild(el('text', { x: padL + plotW + 6, y: y + 4, class: 'axis-text' }, format(t, true)));
  }

  // 資料線
  const shapes = [];
  series.forEach((s) => {
    const pts = s.values.map((v, i) => (v === null || !Number.isFinite(v) ? null : [X(i), Y(v)]));
    const d = pts.reduce((acc, p, i) => (p ? acc + (acc ? 'L' : 'M') + p[0].toFixed(2) + ' ' + p[1].toFixed(2) : acc), '');
    if (d) svg.appendChild(el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    shapes.push(pts);
  });

  // 最後一點直接標示（不是每點都標）
  series.forEach((s, si) => {
    const pts = shapes[si];
    for (let i = pts.length - 1; i >= 0; i--) {
      if (pts[i]) {
        svg.appendChild(el('circle', { cx: pts[i][0], cy: pts[i][1], r: 3.5, fill: s.color, stroke: 'var(--card)', 'stroke-width': 2 }));
        break;
      }
    }
  });

  // x 軸首尾日期
  svg.appendChild(el('text', { x: padL, y: H - 6, class: 'axis-text', 'text-anchor': 'start' }, labels[0]));
  svg.appendChild(el('text', { x: padL + plotW, y: H - 6, class: 'axis-text', 'text-anchor': 'end' }, labels[n - 1]));

  // 互動：十字線 + 提示
  const cross = el('line', { x1: 0, y1: padT, x2: 0, y2: padT + plotH, class: 'crosshair', opacity: 0 });
  svg.appendChild(cross);
  const dots = series.map((s) => {
    const c = el('circle', { r: 4.5, fill: s.color, stroke: 'var(--card)', 'stroke-width': 2, opacity: 0 });
    svg.appendChild(c);
    return c;
  });
  const hit = el('rect', { x: 0, y: 0, width: W, height: H, fill: 'transparent', style: 'touch-action:none' });
  svg.appendChild(hit);

  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;

  const show = (evt) => {
    const box = svg.getBoundingClientRect();
    const px = ((evt.clientX - box.left) / box.width) * W;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < n; i++) { const d = Math.abs(X(i) - px); if (d < bd) { bd = d; bi = i; } }
    cross.setAttribute('x1', X(bi)); cross.setAttribute('x2', X(bi)); cross.setAttribute('opacity', 1);
    series.forEach((s, si) => {
      const p = shapes[si][bi];
      if (p) { dots[si].setAttribute('cx', p[0]); dots[si].setAttribute('cy', p[1]); dots[si].setAttribute('opacity', 1); }
      else dots[si].setAttribute('opacity', 0);
    });
    tip.hidden = false;
    tip.innerHTML = `<div class="tip-date">${labels[bi]}</div>` + series
      .map((s) => `<div class="tip-row"><span class="swatch" style="background:${s.color}"></span>${s.label}<b>${
        s.values[bi] === null || !Number.isFinite(s.values[bi]) ? '–' : format(s.values[bi])}</b></div>`)
      .join('');
    const wb = wrap.getBoundingClientRect();
    const left = clamp((X(bi) / W) * wb.width - 60, 4, Math.max(4, wb.width - 128));
    tip.style.left = left + 'px';
  };
  const hide = () => {
    cross.setAttribute('opacity', 0);
    dots.forEach((d) => d.setAttribute('opacity', 0));
    tip.hidden = true;
  };
  hit.addEventListener('pointermove', show);
  hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointerleave', hide);
  hit.addEventListener('pointercancel', hide);

  // 兩條以上一定有圖例
  if (series.length > 1) {
    const lg = document.createElement('div');
    lg.className = 'legend legend-inline';
    lg.innerHTML = series
      .map((s) => `<span class="legend-row"><span class="swatch" style="background:${s.color}"></span><span class="legend-label">${s.label}</span></span>`)
      .join('');
    wrap.appendChild(lg);
  }
  wrap.appendChild(svg);
  wrap.appendChild(tip);
  return wrap;
}

function niceTicks(min, max, count) {
  const span = max - min;
  if (!(span > 0)) return [min];
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
  const out = [];
  for (let t = Math.ceil(min / step) * step; t <= max; t += step) out.push(Number(t.toFixed(10)));
  return out;
}

// ------------------------------------------------------------
// 長條圖：適合「單日」這種有正有負的數值
//   顏色用漲跌語意（台灣慣例紅漲綠跌），不是分類色
//   每根都可點，會顯示日期與金額
// ------------------------------------------------------------
export function barChart({ labels, values, format, title, width }) {
  const wrap = document.createElement('div');
  wrap.className = 'chart bar-chart';
  const pts = values.map((v) => (Number.isFinite(v) ? v : 0));
  if (!pts.length) {
    wrap.innerHTML = '<p class="muted chart-empty">還沒有已實現損益。賣出（或平倉）後就會出現。</p>';
    return wrap;
  }

  const W = Math.max(320, Math.round(width || 340)), H = 170, padL = 8, padR = 54, padT = 12, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  let max = Math.max(0, ...pts), min = Math.min(0, ...pts);
  if (max === min) { max += 1; min -= 1; }
  const pad = (max - min) * 0.12; max += pad; min -= pad;
  const Y = (v) => padT + plotH - ((v - min) / (max - min)) * plotH;
  const zeroY = Y(0);
  const slot = plotW / pts.length;
  const bw = Math.max(2, Math.min(26, slot * 0.62));

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'bars', role: 'img',
    'aria-label': `${title || ''}，${labels[0]} 至 ${labels[labels.length - 1]}` });

  for (const t of niceTicks(min, max, 3)) {
    const y = Y(t);
    if (y < padT - 1 || y > padT + plotH + 1) continue;
    svg.appendChild(el('line', { x1: padL, y1: y, x2: padL + plotW, y2: y, class: 'grid' }));
    svg.appendChild(el('text', { x: padL + plotW + 6, y: y + 4, class: 'axis-text' }, format(t, true)));
  }
  svg.appendChild(el('line', { x1: padL, y1: zeroY, x2: padL + plotW, y2: zeroY, class: 'zero-line' }));

  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;

  pts.forEach((v, i) => {
    const x = padL + slot * i + (slot - bw) / 2;
    const y = v >= 0 ? Y(v) : zeroY;
    const h = Math.max(1.5, Math.abs(Y(v) - zeroY));
    const r = el('rect', { x, y, width: bw, height: h, rx: Math.min(3, bw / 2),
      class: v >= 0 ? 'bar gain' : 'bar loss', tabindex: '0',
      'aria-label': `${labels[i]} ${format(v)}` });
    const show = () => {
      tip.hidden = false;
      tip.innerHTML = `<div class="tip-date">${labels[i]}</div><div class="tip-row"><b class="${v > 0 ? 'gain' : v < 0 ? 'loss' : ''}">${format(v)}</b></div>`;
      const wb = wrap.getBoundingClientRect();
      tip.style.left = clamp(((x + bw / 2) / W) * wb.width - 55, 4, Math.max(4, wb.width - 118)) + 'px';
    };
    r.addEventListener('pointerenter', show);
    r.addEventListener('pointerdown', show);
    r.addEventListener('focus', show);
    svg.appendChild(r);
  });

  svg.appendChild(el('text', { x: padL, y: H - 6, class: 'axis-text', 'text-anchor': 'start' }, labels[0]));
  if (labels.length > 1) {
    svg.appendChild(el('text', { x: padL + plotW, y: H - 6, class: 'axis-text', 'text-anchor': 'end' }, labels[labels.length - 1]));
  }
  wrap.addEventListener('pointerleave', () => (tip.hidden = true));
  wrap.appendChild(svg);
  wrap.appendChild(tip);
  return wrap;
}
