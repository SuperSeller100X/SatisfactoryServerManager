// Shared UI components.
import { h, mount, fmt } from './dom.js';
import { icon } from './icons.js';
import { ill } from './illustrations.js';

let toastHost = null;
export function toast(title, body = '', kind = 'info', ms = 5000) {
  if (!toastHost) { toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.appendChild(toastHost); }
  const el = h('div', { class: `toast ${kind}` }, h('b', null, title), body ? h('div', { class: 'muted' }, body) : null);
  toastHost.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, ms);
}
export const toastError = (err, title = 'Something went wrong') => toast(title, err && err.message ? err.message : String(err), 'error', 8000);

/** Modal dialog. Returns { close, el }. content may be a node or function(close). */
export function modal({ title, content, actions = [], wide = false, onClose, iconName }) {
  const back = h('div', { class: 'modal-back' });
  const close = (v) => { back.remove(); document.removeEventListener('keydown', onKey); if (onClose) onClose(v); };
  const onKey = (e) => { if (e.key === 'Escape') close(null); };
  document.addEventListener('keydown', onKey);
  const body = h('div', { class: 'modal-body' }, typeof content === 'function' ? content(close) : content);
  const foot = h('div', { class: 'modal-foot' }, actions.map((a) => h('button', { class: `btn ${a.kind || ''}`, onclick: () => a.onClick ? a.onClick(close) : close(a.value) }, a.label)));
  const m = h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' }, iconName ? icon(iconName) : null, h('h2', null, title), h('button', { class: 'btn ghost icon sm', 'aria-label': 'Close', onclick: () => close(null) }, icon('x'))),
    body, actions.length ? foot : null);
  back.appendChild(m);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(null); });
  document.body.appendChild(back);
  const first = m.querySelector('input, select, textarea, button.primary');
  if (first) setTimeout(() => first.focus(), 30);
  return { close, el: m };
}

/** Confirmation dialog; resolves true/false. danger=true styles the confirm button red. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, details, requireText }) {
  return new Promise((resolve) => {
    let input = null;
    const btnRef = {};
    const content = h('div', { class: 'col' },
      typeof message === 'string' ? h('p', null, message) : message,
      details ? h('div', { class: 'callout warn' }, icon('alert'), h('div', null, details)) : null,
      requireText ? h('label', { class: 'field' }, `Type "${requireText}" to confirm`, input = h('input', { class: 'input', oninput: () => { btnRef.b.disabled = input.value !== requireText; } })) : null);
    const m = modal({ title, content, iconName: danger ? 'alert' : 'info', onClose: (v) => resolve(v === true), actions: [{ label: 'Cancel', value: false }, { label: confirmLabel, kind: danger ? 'danger' : 'primary', value: true }] });
    btnRef.b = m.el.querySelector('.modal-foot .btn:last-child');
    if (requireText) btnRef.b.disabled = true;
  });
}

/** Simple form dialog: fields [{ key, label, type, value, hint, options, required, placeholder }]. Resolves values or null. */
export function formDialog({ title, fields, submitLabel = 'Save', intro, validate, wide }) {
  return new Promise((resolve) => {
    const inputs = {};
    const err = h('div', { class: 'callout err hidden' });
    const content = h('div', { class: 'col' }, intro ? h('p', null, intro) : null, ...fields.map((f) => {
      let el;
      if (f.type === 'select') el = h('select', { class: 'input' }, f.options.map((o) => h('option', { value: o.value, selected: o.value === f.value }, o.label)));
      else if (f.type === 'checkbox') { el = h('input', { type: 'checkbox', checked: !!f.value }); inputs[f.key] = el; return h('label', { class: 'check' }, el, h('span', null, f.label, f.hint ? h('span', { class: 'hint' }, f.hint) : null)); }
      else if (f.type === 'textarea') el = h('textarea', { class: 'input', placeholder: f.placeholder || '' }, f.value || '');
      else el = h('input', { class: 'input', type: f.type || 'text', value: f.value ?? '', placeholder: f.placeholder || '', autocomplete: f.type === 'password' ? 'new-password' : 'off' });
      inputs[f.key] = el;
      return h('label', { class: 'field' }, f.label, el, f.hint ? h('span', { class: 'hint' }, f.hint) : null);
    }), err);
    const read = () => Object.fromEntries(fields.map((f) => [f.key, f.type === 'checkbox' ? inputs[f.key].checked : f.type === 'number' ? Number(inputs[f.key].value) : inputs[f.key].value]));
    modal({
      title, content, wide, onClose: (v) => resolve(v || null),
      actions: [{ label: 'Cancel', value: null }, {
        label: submitLabel, kind: 'primary', onClick: (close) => {
          const vals = read();
          const missing = fields.find((f) => f.required && !String(vals[f.key] ?? '').trim());
          const problem = missing ? `${missing.label} is required.` : validate ? validate(vals) : null;
          if (problem) { err.classList.remove('hidden'); mount(err, icon('alertCircle'), h('div', null, problem)); return; }
          close(vals);
        },
      }],
    });
  });
}

export function statusPill(status) {
  const labels = { running: 'Online', attached: 'Online (attached)', starting: 'Starting', stopping: 'Stopping', stopped: 'Offline', crashed: 'Crashed', updating: 'Updating', installing: 'Installing', validating: 'Validating' };
  return h('span', { class: `status ${status}` }, h('i'), labels[status] || status);
}

export const badge = (text, kind = '', iconName) => h('span', { class: `badge ${kind}` }, iconName ? icon(iconName) : null, text);

export function empty({ title, text, action, illustration = 'empty' }) {
  return h('div', { class: 'empty' }, ill[illustration] ? ill[illustration]() : null, h('h3', null, title), text ? h('p', null, text) : null, action || null);
}

export function callout(kind, iconName, ...children) { return h('div', { class: `callout ${kind}` }, icon(iconName), h('div', null, ...children)); }

export function progress(pct) {
  const indet = pct === null || pct === undefined;
  const bar = h('div', { style: { width: `${indet ? 35 : Math.max(0, Math.min(100, pct))}%` } });
  return h('div', { class: `progress ${indet ? 'indeterminate' : ''}`, role: 'progressbar', 'aria-valuenow': indet ? undefined : Math.round(pct), 'aria-valuemin': 0, 'aria-valuemax': 100 }, bar);
}

/** Button that runs an async action with a spinner and shows errors as toasts. */
export function actionButton(label, fn, { kind = '', iconName, size = '', title, disabled, successMessage } = {}) {
  const b = h('button', { class: `btn ${kind} ${size}`, title: title || undefined, disabled }, iconName ? icon(iconName) : null, label ? h('span', null, label) : null);
  b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (b.disabled) return;
    b.disabled = true;
    const ic = b.querySelector('svg');
    if (ic) ic.classList.add('spin');
    try {
      const r = await fn();
      if (successMessage) toast(typeof successMessage === 'function' ? successMessage(r) : successMessage, '', 'success');
    } catch (err) { if (err && err.code !== 'E_CANCELLED_UI') toastError(err); } finally { b.disabled = false; if (ic) ic.classList.remove('spin'); }
  });
  return b;
}

export function switchInput(checked, onChange, { label } = {}) {
  const input = h('input', { type: 'checkbox', checked, 'aria-label': label || 'toggle' });
  input.addEventListener('change', () => onChange(input.checked, input));
  return h('label', { class: 'switch' }, input, h('span'));
}

export function tabs(items, active, onSelect) {
  return h('div', { class: 'tabs', role: 'tablist' }, items.map((t) => h('button', { class: t.key === active ? 'active' : '', role: 'tab', 'aria-selected': String(t.key === active), onclick: () => onSelect(t.key) }, t.icon ? icon(t.icon) : null, t.label, t.count ? h('span', { class: 'badge accent' }, t.count) : null)));
}

export function seg(items, active, onSelect) {
  return h('div', { class: 'seg' }, items.map((t) => h('button', { class: t.value === active ? 'active' : '', onclick: () => onSelect(t.value) }, t.label)));
}

/** Sortable table. columns: [{ key, label, render(row), sort(row) -> value, num }] */
export function table(columns, rows, { empty: emptyText = 'Nothing to show yet', sortKey, sortDir = -1, onRow } = {}) {
  let key = sortKey; let dir = sortDir;
  const wrap = h('div', { class: 'table-wrap' });
  const draw = () => {
    const col = columns.find((c) => c.key === key);
    const sorted = col && col.sort ? [...rows].sort((a, b) => { const x = col.sort(a); const y = col.sort(b); return (x > y ? 1 : x < y ? -1 : 0) * dir; }) : rows;
    mount(wrap, h('table', { class: 'table' },
      h('thead', null, h('tr', null, columns.map((c) => h('th', { class: [c.sort ? 'sortable' : '', c.num ? 'num' : ''], onclick: c.sort ? () => { if (key === c.key) dir = -dir; else { key = c.key; dir = -1; } draw(); } : undefined }, c.label, key === c.key && c.sort ? (dir > 0 ? ' ▲' : ' ▼') : '')))),
      h('tbody', null, sorted.length ? sorted.map((r) => h('tr', { onclick: onRow ? () => onRow(r) : undefined, style: onRow ? { cursor: 'pointer' } : undefined }, columns.map((c) => h('td', { class: c.num ? 'num' : '' }, c.render ? c.render(r) : r[c.key] ?? '—')))) : h('tr', null, h('td', { colspan: columns.length, class: 'muted center' }, emptyText)))));
  };
  draw();
  return wrap;
}

export function card(title, iconName, body, headExtra) {
  return h('div', { class: 'card' }, title ? h('div', { class: 'card-head' }, h('h3', null, iconName ? icon(iconName) : null, title), headExtra || null) : null, body);
}

export function kv(pairs) { return h('div', { class: 'facts' }, pairs.filter(Boolean).map(([k, v]) => h('div', null, h('span', null, k), h('span', { title: typeof v === 'string' ? v : undefined }, v ?? '—')))); }

export function settingRow(title, desc, control, effect) {
  return h('div', { class: 'setting' }, h('div', { class: 'txt' }, h('b', null, title, effect ? ' ' : '', effect ? h('span', { class: `effect ${effect}` }, effectLabel(effect)) : null), desc ? h('span', null, desc) : null), h('div', { class: 'ctl' }, control));
}
export const effectLabel = (e) => ({ restart: 'Restart required', live: 'Applies live', immediate: 'Immediate', update: 'Needs update' }[e] || e);

export const na = (text = 'Not available') => h('span', { class: 'unavailable' }, text);
export { fmt };
