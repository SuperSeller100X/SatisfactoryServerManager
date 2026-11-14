// Native SVG charts. One measure per chart (no dual axes). Missing samples are
// drawn as gaps — never interpolated — and a chart with no data says so.
import { h, s, clear } from './dom.js';

// Categorical palette (dark mode), validated against the card surface #131823:
// lightness band, chroma floor, CVD ΔE ≥ 8.4, normal-vision ΔE ≥ 19.3, contrast ≥ 3:1.
export const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767'];

let gid = 0;
const niceMax = (v) => {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
};

/**
 * Area/line chart. points: [{ t, v }] (v may be null for "not measured").
 * opts: { color, format(v), yMax, yMin, height, timeFormat(t), unavailableText }
 */
export function lineChart(points, opts = {}) {
  const wrap = h('div', { class: 'chart', style: { height: `${opts.height || 200}px` } });
  const color = opts.color || 'var(--accent)';
  const fmtV = opts.format || ((x) => String(Math.round(x)));
  const fmtT = opts.timeFormat || ((t) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
  const valid = points.filter((p) => p.v !== null && p.v !== undefined && Number.isFinite(p.v));
  if (!valid.length) {
    wrap.appendChild(h('div', { class: 'na' }, opts.unavailableText || 'No measurements recorded for this period'));
    return wrap;
  }
  const render = () => {
    clear(wrap);
    const W = Math.max(wrap.clientWidth || 600, 200); const H = opts.height || 200;
    const pad = { l: 46, r: 12, t: 12, b: 24 };
    const t0 = points[0].t; const t1 = points[points.length - 1].t;
    const yMax = opts.yMax ?? niceMax(Math.max(...valid.map((p) => p.v)) * 1.1);
    const yMin = opts.yMin ?? 0;
    const x = (t) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - pad.l - pad.r);
    const y = (v) => pad.t + (1 - (v - yMin) / Math.max(1e-9, yMax - yMin)) * (H - pad.t - pad.b);
    const id = `lc${++gid}`;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': opts.label || 'chart' },
      s('defs', null, s('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 }, s('stop', { offset: 0, 'stop-color': color, 'stop-opacity': 0.32 }), s('stop', { offset: 1, 'stop-color': color, 'stop-opacity': 0 }))));
    for (let i = 0; i <= 4; i++) {
      const v = yMin + ((yMax - yMin) * i) / 4;
      svg.appendChild(s('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: 'grid-line', 'stroke-dasharray': i === 0 ? '' : '2 4' }));
      svg.appendChild(s('text', { x: pad.l - 8, y: y(v) + 3.5, 'text-anchor': 'end', class: 'axis' }, fmtV(v)));
    }
    const ticks = Math.min(6, Math.floor((W - pad.l) / 90));
    for (let i = 0; i <= ticks; i++) {
      const t = t0 + ((t1 - t0) * i) / Math.max(1, ticks);
      svg.appendChild(s('text', { x: x(t), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === ticks ? 'end' : 'middle', class: 'axis' }, fmtT(t)));
    }
    // Split into contiguous segments so gaps stay visible.
    const segs = []; let cur = [];
    for (const p of points) { if (p.v === null || p.v === undefined || !Number.isFinite(p.v)) { if (cur.length) segs.push(cur); cur = []; } else cur.push(p); }
    if (cur.length) segs.push(cur);
    for (const seg of segs) {
      const line = seg.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
      if (seg.length > 1) svg.appendChild(s('path', { d: `${line}L${x(seg[seg.length - 1].t).toFixed(1)},${y(yMin)}L${x(seg[0].t).toFixed(1)},${y(yMin)}Z`, fill: `url(#${id})` }));
      svg.appendChild(s('path', { d: seg.length > 1 ? line : `M${x(seg[0].t)},${y(seg[0].v)}h0.1`, stroke: color, 'stroke-width': 2, fill: 'none', 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' }));
    }
    const cross = s('line', { y1: pad.t, y2: H - pad.b, stroke: 'var(--text-3)', 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0 });
    const dot = s('circle', { r: 4.5, fill: color, stroke: 'var(--surface)', 'stroke-width': 2, opacity: 0 });
    svg.append(cross, dot);
    const tip = h('div', { class: 'tip hidden' });
    const hit = s('rect', { x: pad.l, y: 0, width: W - pad.l - pad.r, height: H, fill: 'transparent' });
    svg.appendChild(hit);
    hit.addEventListener('mousemove', (e) => {
      const r = svg.getBoundingClientRect();
      const mx = ((e.clientX - r.left) / r.width) * W;
      let best = points[0];
      for (const p of points) if (Math.abs(x(p.t) - mx) < Math.abs(x(best.t) - mx)) best = p;
      cross.setAttribute('x1', x(best.t)); cross.setAttribute('x2', x(best.t)); cross.setAttribute('opacity', 1);
      const has = best.v !== null && best.v !== undefined && Number.isFinite(best.v);
      if (has) { dot.setAttribute('cx', x(best.t)); dot.setAttribute('cy', y(best.v)); dot.setAttribute('opacity', 1); } else dot.setAttribute('opacity', 0);
      tip.textContent = `${new Date(best.t).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })} · ${has ? fmtV(best.v) : 'not measured'}`;
      tip.classList.remove('hidden');
      tip.style.left = `${(x(best.t) / W) * r.width}px`;
      tip.style.top = `${has ? (y(best.v) / H) * r.height : 20}px`;
    });
    hit.addEventListener('mouseleave', () => { cross.setAttribute('opacity', 0); dot.setAttribute('opacity', 0); tip.classList.add('hidden'); });
    wrap.append(svg, tip);
  };
  requestAnimationFrame(render);
  if (window.ResizeObserver) { let w0 = 0; new ResizeObserver(() => { if (Math.abs(wrap.clientWidth - w0) > 4) { w0 = wrap.clientWidth; render(); } }).observe(wrap); }
  return wrap;
}

/** Donut with 2px surface gaps, hover tooltip and a legend (identity never by color alone). */
export function donut(items, { size = 180, format = String, centerLabel = '', centerValue = '' } = {}) {
  const total = items.reduce((a, b) => a + Math.max(0, b.value), 0);
  const R = size / 2; const r = R * 0.64;
  const svg = s('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: 'img', 'aria-label': centerLabel });
  const tip = h('div', { class: 'tip hidden' });
  const box = h('div', { style: { position: 'relative', width: `${size}px`, height: `${size}px`, flex: 'none' } }, svg, tip);
  let a0 = -Math.PI / 2;
  const arc = (a, b, rr) => [Math.cos(a) * rr + R, Math.sin(a) * rr + R, Math.cos(b) * rr + R, Math.sin(b) * rr + R];
  if (!total) svg.appendChild(s('circle', { cx: R, cy: R, r: (R + r) / 2, fill: 'none', stroke: 'var(--surface-3)', 'stroke-width': R - r }));
  items.forEach((it, i) => {
    if (!(it.value > 0) || !total) return;
    const frac = it.value / total;
    const a1 = a0 + frac * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const [x0, y0, x1, y1] = arc(a0, a1, R - 1); const [x2, y2, x3, y3] = arc(a1, a0, r);
    const d = frac >= 0.9999 ? `M${R},1A${R - 1},${R - 1} 0 1 1 ${R - 0.01},1ZM${R},${R - r}A${r},${r} 0 1 0 ${R + 0.01},${R - r}Z` : `M${x0},${y0}A${R - 1},${R - 1} 0 ${large} 1 ${x1},${y1}L${x2},${y2}A${r},${r} 0 ${large} 0 ${x3},${y3}Z`;
    const p = s('path', { d, fill: it.color || SERIES[i % SERIES.length], stroke: 'var(--surface)', 'stroke-width': 2, 'fill-rule': 'evenodd' });
    p.addEventListener('mousemove', (e) => { const rc = box.getBoundingClientRect(); tip.textContent = `${it.label}: ${format(it.value)} (${(frac * 100).toFixed(1)}%)`; tip.classList.remove('hidden'); tip.style.left = `${e.clientX - rc.left}px`; tip.style.top = `${e.clientY - rc.top}px`; p.setAttribute('opacity', 0.85); });
    p.addEventListener('mouseleave', () => { tip.classList.add('hidden'); p.setAttribute('opacity', 1); });
    svg.appendChild(p);
    a0 = a1;
  });
  svg.appendChild(s('text', { x: R, y: R - 2, 'text-anchor': 'middle', fill: 'var(--text)', 'font-size': 17, 'font-weight': 700 }, centerValue));
  svg.appendChild(s('text', { x: R, y: R + 15, 'text-anchor': 'middle', fill: 'var(--text-3)', 'font-size': 10.5 }, centerLabel));
  const legend = h('div', { class: 'legend-list' }, items.map((it, i) => h('div', null, h('i', { style: { background: it.color || SERIES[i % SERIES.length] } }), h('span', null, it.label), h('span', null, format(it.value)))));
  return h('div', { class: 'donut-wrap' }, box, legend);
}

export function sparkline(values, { color = 'var(--accent)', width = 120, height = 32 } = {}) {
  const v = values.filter((x) => Number.isFinite(x));
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, width, height, 'aria-hidden': 'true' });
  if (v.length < 2) return svg;
  const max = Math.max(...v, 1e-9); const min = Math.min(...v, 0);
  const pts = values.map((x, i) => (Number.isFinite(x) ? `${(i / (values.length - 1)) * width},${height - 2 - ((x - min) / (max - min || 1)) * (height - 4)}` : null));
  let d = ''; let pen = false;
  for (const p of pts) { if (!p) { pen = false; continue; } d += `${pen ? 'L' : 'M'}${p}`; pen = true; }
  svg.appendChild(s('path', { d, stroke: color, 'stroke-width': 1.8, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  return svg;
}

/** Ring gauge for a single percentage; null renders as "n/a". */
export function ring(value, { size = 64, color = 'var(--accent)', label = '' } = {}) {
  const r = size / 2 - 5; const c = 2 * Math.PI * r;
  const has = value !== null && value !== undefined && Number.isFinite(value);
  const frac = has ? Math.max(0, Math.min(1, value / 100)) : 0;
  return s('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: 'img', 'aria-label': `${label} ${has ? `${value.toFixed(0)}%` : 'not available'}` },
    s('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', stroke: 'var(--surface-3)', 'stroke-width': 6 }),
    s('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', stroke: color, 'stroke-width': 6, 'stroke-linecap': 'round', 'stroke-dasharray': `${c * frac} ${c}`, transform: `rotate(-90 ${size / 2} ${size / 2})` }),
    s('text', { x: size / 2, y: size / 2 + 4, 'text-anchor': 'middle', fill: has ? 'var(--text)' : 'var(--text-3)', 'font-size': 12, 'font-weight': 700 }, has ? `${value.toFixed(0)}%` : 'n/a'));
}
