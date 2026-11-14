// Activity timeline (audit history). Secret values are never recorded.
import { h, mount, fmt, debounce } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { seg, badge, empty } from '../ui.js';

export async function render(page, _p, { setTitle }) {
  setTitle('Activity');
  let result = ''; let search = ''; let action = '';
  const list = h('div', { class: 'card' });
  const resSeg = h('span');
  const drawSeg = () => mount(resSeg, seg([{ value: '', label: 'All' }, { value: 'ok', label: 'Succeeded' }, { value: 'failed', label: 'Failed' }], result, (v) => { result = v; drawSeg(); load(); }));
  drawSeg();
  const actSel = h('select', { class: 'input', style: { width: '200px' }, onchange: () => { action = actSel.value; load(); } }, [['', 'All operations'], ['server.', 'Server lifecycle'], ['backup', 'Backups'], ['mods.', 'Mods'], ['server.update', 'Updates'], ['credentials', 'Credentials'], ['firewall', 'Firewall'], ['migration', 'Migration'], ['recovery', 'Recovery'], ['remote', 'Remote management'], ['web.', 'Web dashboard'], ['settings', 'Settings'], ['setup', 'Setup'], ['task.', 'Scheduled tasks'], ['diagnostics', 'Diagnostics']].map(([v, l]) => h('option', { value: v }, l)));
  const searchIn = h('input', { class: 'input', placeholder: 'Search…', style: { width: '200px' }, oninput: debounce(() => { search = searchIn.value; load(); }, 300) });
  mount(page, h('div', { class: 'page-head' }, h('div', { class: 'titles' }, h('h1', null, 'Activity timeline'), h('p', null, 'Every important change with time, actor, result and details. Secret values are never recorded.')), h('div', { class: 'actions' }, resSeg, actSel, searchIn)), list);
  async function load() {
    const rows = await api.call('audit.list', { limit: 300, ...(result ? { result } : {}), ...(search ? { search } : {}), ...(action ? { action } : {}) });
    if (!rows.length) { mount(list, empty({ title: 'No activity', text: 'Nothing matches the current filter.' })); return; }
    let lastDay = '';
    mount(list, h('div', { class: 'timeline' }, rows.flatMap((r) => {
      const day = new Date(r.ts).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      const out = [];
      if (day !== lastDay) { lastDay = day; out.push(h('h4', { style: { margin: '10px 0 10px -26px' } }, day)); }
      out.push(h('div', { class: `tl-item ${r.result === 'ok' ? 'ok' : 'failed'}` },
        h('div', { class: 't' }, `${new Date(r.ts).toLocaleTimeString()} · ${r.actor}`),
        h('div', { class: 'h row' }, h('span', { class: 'mono' }, r.action), r.target ? h('span', { class: 'muted' }, r.target) : null, badge(r.result, r.result === 'ok' ? 'ok' : 'err')),
        r.error ? h('div', { class: 'd', style: { color: 'var(--err)' } }, r.error) : null,
        r.details ? h('details', null, h('summary', { class: 'small muted', style: { cursor: 'pointer' } }, 'Details'), h('pre', { class: 'pathbox', style: { whiteSpace: 'pre-wrap' } }, JSON.stringify(r.details, null, 2))) : null));
      return out;
    })));
  }
  load();
}
