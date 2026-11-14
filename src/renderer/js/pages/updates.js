// Update center: dedicated server builds, mods, SteamCMD, application.
import { h, mount, fmt } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { badge, card, table, callout, actionButton, confirmDialog, toast, progress, kv } from '../ui.js';

export async function render(page, _p, { setTitle, navigate }) {
  setTitle('Update Center');
  const body = h('div');
  mount(page, h('div', { class: 'page-head' }, h('div', { class: 'titles' }, h('h1', null, 'Update center'), h('p', null, 'Every update is protected by a backup first and verified afterwards.')),
    h('div', { class: 'actions' }, actionButton('Check for updates', async () => { const r = await api.call('updates.check'); toast('Update check complete', r.errors.length ? r.errors.join(' · ') : `${r.servers.filter((s) => s.updateAvailable).length} server and ${r.mods.length} mod update(s) found`, r.errors.length ? 'warning' : 'success'); load(); }, { kind: 'primary', iconName: 'update' }), h('button', { class: 'btn', onclick: () => navigate('settings/updates') }, icon('settings'), 'Policies'))), body);
  async function load() {
    const o = await api.call('updates.overview');
    const hist = await api.call('updates.history', {});
    const app = o.app;
    mount(body,
      h('div', { class: 'grid g3' },
        card('Application', 'monitor', kv([['Installed', app ? `v${app.current}` : '—'], ['Latest release', app ? (app.latest ? `v${app.latest}` : app.error || '—') : 'not checked yet'], ['Checked', app ? fmt.ago(app.checkedAt) : 'never']]), app && app.updateAvailable ? badge('Update available', 'accent') : null),
        card('SteamCMD', 'steam', kv([['Installed', o.steamcmd.installed ? 'yes' : 'no'], ['Package version', o.steamcmd.packageVersion || '—'], ['Last run', fmt.ago(o.steamcmd.lastRun)], ['Busy', o.steamcmd.busy ? o.steamcmd.operation : 'no']]), actionButton('Self-update', () => api.call('updates.steamcmdSelfUpdate'), { size: 'sm', iconName: 'update', successMessage: 'SteamCMD updated' })),
        card('Automation', 'calendar', kv([['Server updates', o.policies.autoServerUpdate], ['Mod updates', o.policies.autoModUpdate], ['Update window', `${o.policies.windowStart}–${o.policies.windowEnd}`], ['Check interval', `${o.policies.checkIntervalHours} h`], ['Rollback copy', o.policies.keepRollbackCopy ? 'kept before updates' : 'off']]))),
      app && app.updateAvailable && app.url ? callout('info', 'download', h('b', null, `Version ${app.latest} is available. `), 'Download it from the release page: ', h('a', { onclick: () => api.openExternal(app.url) }, app.url)) : null,
      h('div', { class: 'card mt flush' }, h('div', { class: 'card-head', style: { padding: '16px 20px 0' } }, h('h3', null, icon('server'), 'Dedicated servers')), table([
        { key: 'name', label: 'Server', render: (s) => h('a', { href: `#/server/${s.serverId}` }, s.name), sort: (s) => s.name },
        { key: 'branch', label: 'Branch' },
        { key: 'inst', label: 'Installed build', render: (s) => (s.installed ? s.installed.buildId : badge('not installed', 'err')) },
        { key: 'avail', label: 'Available build', render: (s) => (s.available ? s.available.buildId : 'not checked') },
        { key: 'state', label: 'Status', render: (s) => (s.progress ? h('div', { style: { minWidth: '180px' } }, h('div', { class: 'small' }, s.progress.phase), progress(s.progress.percent)) : s.updateAvailable ? badge('Update available', 'accent', 'update') : s.installed && s.available ? badge('Up to date', 'ok', 'check') : badge('Unknown', '')) },
        { key: 'policy', label: 'Policy' },
        { key: 'act', label: '', render: (s) => h('div', { class: 'row' },
          actionButton(s.updateAvailable ? 'Update now' : 'Validate', async () => { if (!(await confirmDialog({ title: `${s.updateAvailable ? 'Update' : 'Validate'} ${s.name}?`, message: 'The server is stopped gracefully if running, a backup is created, SteamCMD downloads/verifies files and the server is started again to verify it works.', confirmLabel: s.updateAvailable ? 'Update' : 'Validate' }))) return; await api.call(s.updateAvailable ? 'updates.updateServer' : 'servers.repairInstall', { serverId: s.serverId }); toast('Done', '', 'success'); load(); }, { size: 'sm', kind: s.updateAvailable ? 'primary' : '', iconName: 'download' }),
          s.rollback && s.rollback.available ? actionButton('Roll back', async () => { if (!(await confirmDialog({ title: 'Roll back server files?', message: `Restores build ${s.rollback.buildId} from the copy taken on ${fmt.date(s.rollback.createdAt)}. Saves and mods are not changed.`, danger: true, confirmLabel: 'Roll back' }))) return; const r = await api.call('updates.rollback', { serverId: s.serverId, confirm: true }); toast('Rolled back', r.note, 'success'); load(); }, { size: 'sm', iconName: 'history' }) : null) },
      ], o.servers, { empty: 'No servers configured.' })),
      o.lastCheck && o.lastCheck.result.mods.length ? h('div', { class: 'card mt' }, h('div', { class: 'card-head' }, h('h3', null, icon('puzzle'), 'Mod updates')), o.lastCheck.result.mods.map((m) => h('div', { class: 'mb' }, h('div', { class: 'row' }, h('b', { class: 'grow' }, m.name), actionButton('Update all', () => api.call('mods.updateAll', { serverId: m.serverId }), { size: 'sm', kind: 'primary', successMessage: 'Mods updated' })), h('div', { class: 'small muted' }, m.updates.map((u) => `${u.name} ${u.installed} → ${u.latest}`).join(' · '))))) : null,
      h('div', { class: 'card mt' }, h('div', { class: 'card-head' }, h('h3', null, icon('history'), 'Update history')), h('div', { class: 'timeline' }, hist.length ? hist.slice(0, 50).map((u) => h('div', { class: `tl-item ${u.status === 'completed' ? 'ok' : u.status === 'failed' ? 'failed' : u.status === 'available' ? 'accent' : ''}` },
        h('div', { class: 't' }, `${fmt.date(u.ts)} · ${u.kind}`), h('div', { class: 'h' }, `${u.from_version || '—'} → ${u.to_version || '—'}`, ' ', badge(u.status, u.status === 'completed' ? 'ok' : u.status === 'failed' ? 'err' : 'info')),
        u.details && u.details.steps ? h('details', null, h('summary', { class: 'small muted', style: { cursor: 'pointer' } }, 'Steps'), h('ol', { class: 'small muted' }, u.details.steps.map((x) => h('li', null, `${fmt.time(x.at)} ${x.step}`)))) : null,
        u.details && u.details.error ? h('div', { class: 'd', style: { color: 'var(--err)' } }, u.details.error) : null)) : h('p', { class: 'muted' }, 'No updates recorded yet.'))));
  }
  await load();
  const off = api.on('update.changed', (p) => { if (p && p.progress !== undefined) load(); });
  return off;
}
