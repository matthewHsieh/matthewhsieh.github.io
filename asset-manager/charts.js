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
export function lineChart({ labels, dates, series, format, yZero = false, title }) {
  const wrap = document.createElement('div');
  wrap.className = 'chart line-chart';

  const n = labels.length;
  if (n < 2) {
    wrap.innerHTML = `<p class="muted chart-empty">${n === 1 ? '只有一筆紀錄，再多幾天就會出現走勢。' : '還沒有紀錄，走勢圖會在有兩天以上的快照後出現。'}</p>`;
    return wrap;
  }

  const W = 340, H = 190, padL = 8, padR = 54, padT = 14, padB = 24;
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
