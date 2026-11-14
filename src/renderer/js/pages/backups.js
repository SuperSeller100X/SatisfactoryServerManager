// Backup browser: timeline, validation, restore points, export, deletion.
import { h, mount, fmt } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { badge, table, callout, actionButton, confirmDialog, formDialog, toast, empty, card, seg } from '../ui.js';
import { serverPicker } from './common.js';

const TYPE_LABEL = { manual: 'Manual', scheduled: 'Scheduled', 'pre-update': 'Before update', 'pre-restore': 'Restore point', 'pre-mod': 'Before mod change', 'restore-point': 'Restore point', 'pre-migration': 'Before migration' };

export async function render(page, [sid], { setTitle, navigate }) {
  setTitle('Backups');
  const servers = await api.call('servers.list');
  if (!servers.length) { mount(page, empty({ title: 'No servers', text: 'Add a server first.' })); return undefined; }
  let id = sid && servers.find((s) => s.id === sid) ? sid : servers[0].id;
  let type = '';
  const body = h('div');
  const typeSeg = h('span');
  const drawSeg = () => mount(typeSeg, seg([{ value: '', label: 'All' }, { value: 'manual', label: 'Manual' }, { value: 'scheduled', label: 'Scheduled' }, { value: 'auto', label: 'Restore points' }], type, (v) => { type = v; drawSeg(); load(); }));
  drawSeg();
  mount(page, h('div', { class: 'page-head' }, h('div', { class: 'titles' }, h('h1', null, 'Backup browser'), h('p', null, 'Saves and server configuration, verified with SHA-256 and CRC32.')),
    h('div', { class: 'actions' }, serverPicker(servers, id, (v) => { id = v; navigate(`backups/${v}`); }), typeSeg,
      actionButton('Create backup', async () => { const v = await formDialog({ title: 'Create backup', fields: [{ key: 'note', label: 'Note (optional)', placeholder: 'e.g. Before building the space elevator' }], submitLabel: 'Create' }); if (v) { const b = await api.call('backups.create', { serverId: id, note: v.note }); toast('Backup created', `${b.files} files · ${fmt.bytes(b.size)}`, 'success'); load(); } }, { kind: 'primary', iconName: 'plus' }),
      api.desktop ? actionButton('Upload save', async () => {
        const f = await api.pickFile({ title: 'Choose a Satisfactory save (.sav)', filters: [{ name: 'Satisfactory save', extensions: ['sav'] }] });
        if (!f) return;
        try { await api.call('backups.importSave', { serverId: id, file: f }); toast('Save uploaded', f, 'success'); } catch (e) {
          if (e.code === 'E_EXISTS' && await confirmDialog({ title: 'Overwrite existing save?', message: e.message, confirmLabel: 'Overwrite (restore point first)', danger: true })) { await api.call('backups.importSave', { serverId: id, file: f, overwrite: true }); toast('Save replaced', 'A restore point was created first.', 'success'); } else if (e.code !== 'E_EXISTS') throw e;
        }
      }, { iconName: 'upload' }) : null)), body);
  async function load() {
    const all = await api.call('backups.list', { serverId: id });
    const list = type === '' ? all : type === 'auto' ? all.filter((b) => !['manual', 'scheduled'].includes(b.type)) : all.filter((b) => b.type === type);
    const saves = await api.call('servers.saves', { serverId: id }).catch(() => ({ saves: [], sharedWith: [] }));
    const total = all.reduce((a, b) => a + b.size, 0);
    const settings = await api.call('settings.get');
    const pol = settings.backups;
    mount(body,
      h('div', { class: 'grid g4' },
        card(null, null, h('div', { class: 'stat' }, h('div', { class: 'label' }, icon('archive'), 'Backups'), h('div', { class: 'value' }, String(all.length)), h('div', { class: 'sub' }, fmt.bytes(total)))),
        card(null, null, h('div', { class: 'stat' }, h('div', { class: 'label' }, icon('clock'), 'Latest'), h('div', { class: 'value', style: { fontSize: '18px' } }, all[0] ? fmt.ago(all[0].created_at) : 'never'), h('div', { class: 'sub' }, all[0] ? TYPE_LABEL[all[0].type] : ''))),
        card(null, null, h('div', { class: 'stat' }, h('div', { class: 'label' }, icon('shieldCheck'), 'Validated'), h('div', { class: 'value' }, `${all.filter((b) => b.status === 'valid').length}/${all.length}`), h('div', { class: 'sub' }, all.some((b) => b.status === 'invalid') ? 'some failed validation' : 'integrity verified'))),
        card(null, null, h('div', { class: 'stat' }, h('div', { class: 'label' }, icon('settings'), 'Rotation'), h('div', { class: 'value', style: { fontSize: '18px' } }, pol.retentionEnabled ? `keep ${pol.keepScheduled}` : 'off'), h('div', { class: 'sub' }, pol.retentionEnabled ? `scheduled · ${pol.keepAutomatic} restore points` : h('a', { onclick: () => navigate('settings/backups') }, 'configure retention'))))),
      saves.sharedWith.length ? callout('info', 'info', `Saves are stored in a folder shared with: ${saves.sharedWith.join(', ')}. Backups include all saves in that folder.`) : null,
      h('div', { class: 'grid g2 mt', style: { gridTemplateColumns: '2fr 1fr' } },
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, icon('history'), 'Timeline')), list.length ? h('div', { class: 'timeline' }, list.map((b) => h('div', { class: `tl-item ${b.status === 'valid' ? 'ok' : b.status === 'invalid' ? 'failed' : ''}` },
          h('div', { class: 't' }, `${fmt.date(b.created_at)} · ${fmt.ago(b.created_at)}`),
          h('div', { class: 'h row wrap' }, h('span', null, TYPE_LABEL[b.type] || b.type), badge(b.status, b.status === 'valid' ? 'ok' : b.status === 'invalid' ? 'err' : 'warn'), h('span', { class: 'muted small' }, `${fmt.bytes(b.size)} · ${b.files} files`)),
          b.note ? h('div', { class: 'd' }, b.note) : null,
          h('div', { class: 'row wrap', style: { marginTop: '6px' } },
            actionButton('Restore', async () => {
              const ok = await confirmDialog({ title: 'Restore this backup?', message: `Saves and configuration from ${fmt.date(b.created_at)} will replace the current ones.`, details: 'A restore point of the current state is created automatically first, so this can be undone. The server must be stopped.', confirmLabel: 'Restore', danger: true });
              if (!ok) return;
              const r = await api.call('backups.restore', { id: b.id, confirm: true });
              toast('Backup restored', r.restorePointId ? 'A restore point of the previous state was created.' : '', 'success'); load();
            }, { size: 'sm', kind: 'primary', iconName: 'restart' }),
            actionButton('Validate', async () => { const r = await api.call('backups.validate', { id: b.id }); toast(r.ok ? 'Backup is valid' : 'Validation failed', r.ok ? r.checks.join(' · ') : r.error, r.ok ? 'success' : 'error'); load(); }, { size: 'sm', iconName: 'shieldCheck' }),
            actionButton('Contents', async () => { const c = await api.call('backups.contents', { id: b.id }); const { modal } = await import('../ui.js'); modal({ title: 'Backup contents', wide: true, content: table([{ key: 'name', label: 'File', render: (e) => h('span', { class: 'mono small' }, e.name) }, { key: 'size', label: 'Size', num: true, render: (e) => fmt.bytes(e.size) }], c.entries.filter((e) => !e.dir)) }); }, { size: 'sm', iconName: 'eye' }),
            api.desktop ? actionButton('Export', async () => { const dest = await api.pickSaveFile({ title: 'Export backup', defaultPath: `backup-${new Date(b.created_at).toISOString().slice(0, 10)}.zip`, filters: [{ name: 'ZIP', extensions: ['zip'] }] }); if (dest) { await api.call('backups.export', { id: b.id, dest }); toast('Backup exported and verified', dest, 'success'); } }, { size: 'sm', iconName: 'download' }) : null,
            actionButton('Delete', async () => { if (await confirmDialog({ title: 'Delete backup?', message: `The backup from ${fmt.date(b.created_at)} will be permanently deleted.`, danger: true, confirmLabel: 'Delete permanently' })) { await api.call('backups.remove', { id: b.id, confirm: true }); load(); } }, { size: 'sm', kind: 'danger', iconName: 'trash' }))))) : empty({ title: 'No backups yet', text: 'Create a manual backup or schedule one in the Scheduler.' })),
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, icon('file'), 'Current save files')), h('div', { class: 'small muted mb pathbox' }, saves.dir || ''), table([{ key: 'name', label: 'Save', render: (x) => h('span', { class: 'small' }, x.name) }, { key: 'modified', label: 'Modified', render: (x) => fmt.ago(x.modified), sort: (x) => x.modified }, { key: 'size', label: 'Size', num: true, render: (x) => fmt.bytes(x.size) }], saves.saves, { empty: 'No save files found.' }))));
  }
  await load();
  const off = api.on('backup.changed', (p) => { if (!p || p.serverId === id) load(); });
  return off;
}
