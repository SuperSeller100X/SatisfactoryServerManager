// Storage analyzer with measured sizes and safe cleanup actions.
import { h, mount, fmt } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { table, callout, actionButton, confirmDialog, toast, card } from '../ui.js';
import { donut, SERIES } from '../charts.js';

export async function render(page, _p, { setTitle, navigate }) {
  setTitle('Storage');
  const body = h('div', null, h('div', { class: 'card' }, h('div', { class: 'muted' }, 'Measuring folders… this can take a moment for large installations.')));
  mount(page, h('div', { class: 'page-head' }, h('div', { class: 'titles' }, h('h1', null, 'Storage analyzer'), h('p', null, 'Actual disk usage of servers, saves, backups, logs and temporary files.')), h('div', { class: 'actions' }, actionButton('Analyze again', () => load(), { iconName: 'restart' }))), body);
  async function load() {
    const r = await api.call('storage.analyze');
    mount(body,
      r.recommendations.length ? h('div', { class: 'card mb' }, h('div', { class: 'card-head' }, h('h3', null, icon('sparkles'), 'Cleanup recommendations')), h('div', { class: 'col' }, r.recommendations.map((x) => h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', null, x.label), h('div', { class: 'small muted' }, x.detail)), x.bytes ? h('span', { class: 'badge accent' }, fmt.bytes(x.bytes)) : null,
        x.action === 'configure-retention' ? h('button', { class: 'btn sm', onclick: () => navigate('settings/backups') }, 'Configure') : actionButton('Clean up', async () => { if (!(await confirmDialog({ title: 'Clean up?', message: x.label, details: x.detail, confirmLabel: 'Clean up' }))) return; const res = await api.call('storage.cleanup', { id: x.id, confirm: true }); toast('Cleanup complete', `${fmt.bytes(res.freed)} freed`, 'success'); load(); }, { size: 'sm', iconName: 'trash' }))))) : callout('ok', 'check', 'No cleanup needed right now. Saves are never cleaned automatically.'),
      h('div', { class: 'grid g2 mt' }, r.servers.map((s) => {
        const total = s.categories.reduce((a, b) => a + Math.max(0, b.bytes), 0);
        return card(s.name, 'server', h('div', { class: 'col' },
          donut(s.categories.map((c, i) => ({ label: c.label, value: Math.max(0, c.bytes), color: SERIES[i] })), { format: fmt.bytes, centerValue: fmt.bytes(total), centerLabel: 'total' }),
          s.disk ? h('div', null, h('div', { class: 'row small' }, h('span', { class: 'grow muted' }, `Drive ${s.disk.path}`), h('span', null, `${fmt.bytes(s.disk.free)} free of ${fmt.bytes(s.disk.total)}`)), h('div', { class: 'meter mt' }, h('div', { style: { width: `${((s.disk.total - s.disk.free) / s.disk.total) * 100}%` } }))) : null));
      })),
      h('div', { class: 'card mt flush' }, table([{ key: 'k', label: 'Location' }, { key: 'v', label: 'Size', num: true, render: (x) => fmt.bytes(x.v), sort: (x) => x.v }], [{ k: 'SteamCMD', v: r.steamcmd }, { k: 'Manager data (database, logs, backups, runs)', v: r.managerData }, ...r.servers.flatMap((s) => s.categories.map((c) => ({ k: `${s.name} · ${c.label}`, v: c.bytes })))], { sortKey: 'v' })),
      h('p', { class: 'small muted mt' }, `Measured ${fmt.date(r.at)}.`));
  }
  load().catch((e) => mount(body, callout('err', 'alertCircle', e.message)));
}
