// Scheduler: recurring, timezone-aware tasks with history and failure reporting.
import { h, mount, fmt } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { badge, table, callout, actionButton, confirmDialog, toast, toastError, modal, switchInput } from '../ui.js';

const PRESETS = [['Every day at 04:00', '0 4 * * *'], ['Every 6 hours', '0 */6 * * *'], ['Every hour', '0 * * * *'], ['Every 30 minutes', '*/30 * * * *'], ['Mondays at 05:00', '0 5 * * 1'], ['First day of month 03:00', '0 3 1 * *']];

export async function render(page, _p, { setTitle }) {
  setTitle('Scheduler');
  const body = h('div');
  mount(page, h('div', { class: 'page-head' }, h('div', { class: 'titles' }, h('h1', null, 'Scheduler'), h('p', null, 'Restarts, backups, updates and maintenance on a schedule.')), h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => edit() }, icon('plus'), 'New task'))),
    callout('info', 'info', h('b', null, 'Tasks run while Satisfactory Server Manager is running '), '(including minimized to the tray). Runs missed while the app was closed are detected at the next start and run once if they are within the grace window (Settings → Scheduler). Enable “Start with Windows” for unattended operation.'), h('div', { class: 'mt' }, body));
  let data; let servers = [];
  async function load() {
    [data, servers] = await Promise.all([api.call('tasks.list'), api.call('servers.list')]);
    const hist = await api.call('tasks.history', {});
    const sname = (id) => (servers.find((s) => s.id === id) || {}).name || '—';
    mount(body,
      h('div', { class: 'card flush' }, table([
        { key: 'en', label: '', render: (t) => switchInput(t.enabled, async (v, el) => { try { await api.call('tasks.update', { id: t.id, patch: { enabled: v } }); load(); } catch (e) { el.checked = !v; toastError(e); } }) },
        { key: 'name', label: 'Task', render: (t) => h('div', null, h('b', null, t.name), h('div', { class: 'small muted' }, data.types[t.type] ? data.types[t.type].label : t.type)), sort: (t) => t.name },
        { key: 'server', label: 'Server', render: (t) => sname(t.serverId) },
        { key: 'when', label: 'Schedule', render: (t) => h('div', null, t.description, h('div', { class: 'small muted mono' }, `${t.cron} · ${t.timezone}`)) },
        { key: 'next', label: 'Next run', render: (t) => (t.enabled && t.nextRun ? h('div', null, fmt.date(t.nextRun), h('div', { class: 'small muted' }, fmt.ago(t.nextRun))) : '—'), sort: (t) => t.nextRun || Infinity },
        { key: 'last', label: 'Last run', render: (t) => (t.running ? badge('running', 'warn') : t.lastRun ? h('div', null, badge(t.lastStatus, t.lastStatus === 'ok' ? 'ok' : t.lastStatus === 'failed' ? 'err' : ''), h('div', { class: 'small muted' }, fmt.ago(t.lastRun))) : 'never') },
        { key: 'act', label: '', render: (t) => h('div', { class: 'row' }, actionButton('', async () => { const r = await api.call('tasks.runNow', { id: t.id }); toast(`Task ${r.status}`, r.message, r.status === 'failed' ? 'error' : 'success'); load(); }, { size: 'sm', iconName: 'play', title: 'Run now' }), h('button', { class: 'btn sm icon', title: 'Edit', onclick: () => edit(t) }, icon('settings')), actionButton('', async () => { if (await confirmDialog({ title: 'Delete task?', message: t.name, danger: true, confirmLabel: 'Delete' })) { await api.call('tasks.remove', { id: t.id }); load(); } }, { size: 'sm', iconName: 'trash', title: 'Delete' })) },
      ], data.tasks, { empty: 'No scheduled tasks yet. Create one to automate backups or restarts.' })),
      h('div', { class: 'card mt' }, h('div', { class: 'card-head' }, h('h3', null, icon('history'), 'Task history')), table([
        { key: 'started_at', label: 'Started', render: (r) => fmt.date(r.started_at), sort: (r) => r.started_at },
        { key: 'task_name', label: 'Task', render: (r) => r.task_name || r.task_id },
        { key: 'status', label: 'Result', render: (r) => badge(r.status, r.status === 'ok' ? 'ok' : r.status === 'failed' ? 'err' : r.status === 'missed' ? 'warn' : '') },
        { key: 'dur', label: 'Duration', render: (r) => (r.ended_at ? fmt.dur(r.ended_at - r.started_at) : '…') },
        { key: 'message', label: 'Message', render: (r) => h('span', { class: 'small' }, r.message || '') },
      ], hist, { empty: 'No runs yet.' })));
  }
  async function edit(t) {
    const types = data.types;
    const name = h('input', { class: 'input', value: t ? t.name : '' });
    const type = h('select', { class: 'input' }, Object.entries(types).map(([k, v]) => h('option', { value: k, selected: t && t.type === k }, v.label)));
    const server = h('select', { class: 'input' }, servers.map((s) => h('option', { value: s.id, selected: t && t.serverId === s.id }, s.name)));
    const cron = h('input', { class: 'input mono', value: t ? t.cron : '0 4 * * *' });
    const tz = h('select', { class: 'input' });
    const preview = h('div', { class: 'small muted' });
    const onlyEmpty = h('input', { type: 'checkbox', checked: t ? !!t.params.onlyIfEmpty : false });
    const missed = h('select', { class: 'input' }, h('option', { value: 'run-once' }, 'Run once if missed (within grace window)'), h('option', { value: 'skip' }, 'Skip missed runs'));
    missed.value = t ? t.missedPolicy : 'run-once';
    const zones = await api.call('tasks.timezones');
    mount(tz, zones.map((z) => h('option', { value: z, selected: z === (t ? t.timezone : data.timezone) }, z)));
    const upd = async () => { try { const p = await api.call('tasks.preview', { cron: cron.value.trim(), timezone: tz.value }); mount(preview, h('b', null, p.description), h('br'), 'Next: ', p.runs.map((r) => new Date(r).toLocaleString()).join(' · ')); cron.classList.remove('invalid'); } catch (e) { mount(preview, h('span', { style: { color: 'var(--err)' } }, e.message)); cron.classList.add('invalid'); } };
    const serverRow = h('label', { class: 'field' }, 'Server', server);
    const syncType = () => serverRow.classList.toggle('hidden', !types[type.value].needsServer);
    cron.addEventListener('input', upd); tz.addEventListener('change', upd); type.addEventListener('change', syncType);
    syncType(); upd();
    modal({ title: t ? 'Edit task' : 'New scheduled task', wide: true, content: h('div', { class: 'col' },
      h('div', { class: 'grid g2' }, h('label', { class: 'field' }, 'Name', name), h('label', { class: 'field' }, 'Action', type)), serverRow,
      h('label', { class: 'field' }, 'Schedule (cron: minute hour day month weekday)', cron, h('div', { class: 'row wrap' }, PRESETS.map(([l, c]) => h('button', { class: 'btn sm', onclick: () => { cron.value = c; upd(); } }, l)))), preview,
      h('div', { class: 'grid g2' }, h('label', { class: 'field' }, 'Time zone', tz), h('label', { class: 'field' }, 'If a run was missed', missed)),
      h('label', { class: 'check' }, onlyEmpty, h('span', null, 'Skip when players are online', h('span', { class: 'hint' }, 'For restarts and updates; needs API access to read the player count.')))),
    actions: [{ label: 'Cancel', value: null }, { label: 'Save task', kind: 'primary', onClick: async (close) => {
      const input = { name: name.value.trim() || types[type.value].label, type: type.value, cron: cron.value.trim(), timezone: tz.value, missedPolicy: missed.value, params: { onlyIfEmpty: onlyEmpty.checked }, ...(types[type.value].needsServer ? { serverId: server.value } : { serverId: null }) };
      try { if (t) await api.call('tasks.update', { id: t.id, patch: input }); else await api.call('tasks.create', input); close(); toast('Task saved', '', 'success'); load(); } catch (e) { toastError(e); }
    } }] });
  }
  await load();
  const off = api.on('scheduler.changed', load);
  return off;
}
