// DOM helpers. All dynamic text goes through textContent — never innerHTML — so
// server output, mod descriptions or file names cannot inject markup (XSS).
const SVG_NS = 'http://www.w3.org/2000/svg';

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  applyAttrs(el, attrs);
  append(el, children);
  return el;
}

export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null && v !== false) el.setAttribute(k, String(v));
  append(el, children);
  return el;
}

function applyAttrs(el, attrs) {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'disabled') el.disabled = !!v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export function mount(el, ...children) { clear(el); append(el, children); return el; }

export const fmt = {
  bytes(n) {
    if (n === null || n === undefined || !Number.isFinite(n)) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let x = n;
    while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
    return `${x.toFixed(i === 0 ? 0 : x < 10 ? 2 : 1)} ${u[i]}`;
  },
  pct(n, d = 1) { return n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n.toFixed(d)}%`; },
  num(n, d = 0) { return n === null || n === undefined || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }); },
  date(ts) { return ts ? new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'; },
  time(ts) { return ts ? new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'; },
  ago(ts) {
    if (!ts) return 'never';
    const d = Date.now() - ts; const a = Math.abs(d); const fut = d < 0;
    const m = 60000; const hr = 60 * m; const day = 24 * hr;
    const t = a < m ? 'moments' : a < hr ? `${Math.round(a / m)} min` : a < day ? `${Math.round(a / hr)} h` : `${Math.round(a / day)} d`;
    return t === 'moments' ? (fut ? 'in a moment' : 'just now') : fut ? `in ${t}` : `${t} ago`;
  },
  dur(ms) {
    if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
    const sec = Math.floor(ms / 1000); const d = Math.floor(sec / 86400); const hh = Math.floor((sec % 86400) / 3600); const mm = Math.floor((sec % 3600) / 60); const ss = sec % 60;
    if (d) return `${d}d ${hh}h`; if (hh) return `${hh}h ${mm}m`; if (mm) return `${mm}m ${ss}s`; return `${ss}s`;
  },
};

export const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
