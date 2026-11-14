// Configuration profiles and server templates.
import { h, mount, fmt } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { badge, table, callout, actionButton, confirmDialog, formDialog, toast, tabs, modal, empty, effectLabel } from '../ui.js';

export async function render(page, [tab = 'profiles'], { setTitle, navigate }) {
  setTitle('Profiles & Templates');
  const body = h('div');
  mount(page, h('div', { class: 'page-head' }, h('div', { class: 'titles' }, h('h1', null, 'Profiles & templates'), h('p', null, 'Reuse real server configurations: save, compare, apply, import and export.'))),
    tabs([{ key: 'profiles', label: 'Configuration profiles', icon: 'layers' }, { key: 'templates', label: 'Server templates', icon: 'template' }], tab, (k) => navigate(`profiles/${k}`)), body);
  const servers = await api.call('servers.list');
  if (tab === 'templates') await templates(body, servers); else await profiles(body, servers);
}

const serverSelect = (servers) => h('select', { class: 'input' }, servers.map((s) => h('option', { value: s.id }, s.name)));
const diffTable = (changes) => table([{ key: 'key', label: 'Setting', render: (c) => h('span', { class: 'mono small' }, c.key) }, { key: 'before', label: 'Current', render: (c) => h('span', { class: 'small' }, JSON.stringify(c.before)) }, { key: 'after', label: 'Profile', render: (c) => h('span', { class: 'small' }, JSON.stringify(c.after)) }, { key: 'effect', label: 'Takes effect', render: (c) => h('span', { class: `effect ${c.effect}` }, effectLabel(c.effect)) }], changes, { empty: 'Identical configuration.' });

/** Port inputs prefilled with free ports (validated again by the main process). */
async function portFields() {
  const sug = await api.call('servers.suggestPorts');
  const port = h('input', { class: 'input', type: 'number', min: 1024, max: 65535, value: sug.port });
  const reliablePort = h('input', { class: 'input', type: 'number', min: 1024, max: 65535, value: sug.reliablePort });
  return { el: h('div', { class: 'grid g2' }, h('label', { class: 'field' }, 'Game port (UDP + TCP)', port), h('label', { class: 'field' }, 'Reliable port (TCP)', reliablePort)), values: () => ({ port: Number(port.value), reliablePort: Number(reliablePort.value) }) };
}

async function importDoc(kind) {
  if (!api.desktop) throw new Error('Importing files is only available in the desktop app.');
  const f = await api.pickFile({ title: `Import ${kind}`, filters: [{ name: 'SSM configuration', extensions: ['json'] }] });
  if (!f) return null;
  return api.call('files.readJson', { file: f });
}

async function profiles(body, servers) {
  const list = await api.call('profiles.list');
  const out = h('div');
  mount(body, h('div', { class: 'row mb' }, h('span', { class: 'grow muted' }, 'Profiles contain launch, INI, live, recovery, shutdown and update settings — never credentials.'),
    servers.length ? actionButton('Save server as profile', async () => {
      const sel = serverSelect(servers); const name = h('input', { class: 'input' }); const desc = h('input', { class: 'input' });
      modal({ title: 'Save configuration profile', content: h('div', { class: 'col' }, h('label', { class: 'field' }, 'Server', sel), h('label', { class: 'field' }, 'Profile name', name), h('label', { class: 'field' }, 'Description', desc)), actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: async (close) => { if (!name.value.trim()) return; await api.call('profiles.save', { serverId: sel.value, name: name.value.trim(), description: desc.value }); close(); toast('Profile saved', '', 'success'); profiles(body, servers); } }] });
    }, { kind: 'primary', iconName: 'plus' }) : null,
    actionButton('Import', async () => { const doc = await importDoc('profile'); if (doc) { await api.call('profiles.import', { document: doc }); toast('Profile imported', '', 'success'); profiles(body, servers); } }, { iconName: 'upload' })),
  h('div', { class: 'card flush' }, table([
    { key: 'name', label: 'Profile', render: (p) => h('div', null, h('b', null, p.name), p.description ? h('div', { class: 'small muted' }, p.description) : null), sort: (p) => p.name },
    { key: 'updated_at', label: 'Updated', render: (p) => fmt.date(p.updated_at), sort: (p) => p.updated_at },
    { key: 'act', label: '', render: (p) => h('div', { class: 'row wrap' },
      servers.length ? actionButton('Compare / apply', async () => {
        const sel = serverSelect(servers); const box = h('div');
        const show = async () => mount(box, diffTable(await api.call('profiles.compare', { profileId: p.id, serverId: sel.value })));
        sel.addEventListener('change', show);
        modal({ title: `Apply “${p.name}”`, wide: true, content: h('div', { class: 'col' }, h('label', { class: 'field' }, 'Target server', sel), box, callout('info', 'info', 'The previous configuration is saved to the server’s history, so applying a profile can be undone.')), actions: [{ label: 'Close' }, { label: 'Apply profile', kind: 'primary', onClick: async (close) => { const r = await api.call('profiles.apply', { serverId: sel.value, profileId: p.id }); close(); toast('Profile applied', `${r.changes.length} change(s)${r.restartRequired ? ' · restart the server to apply restart-required settings' : ''}${r.liveResult ? ` · live options ${r.liveResult}` : ''}`, 'success'); } }] });
        show();
      }, { size: 'sm', kind: 'primary', iconName: 'compare' }) : null,
      actionButton('Duplicate', async () => { await api.call('profiles.duplicate', { id: p.id }); profiles(body, servers); }, { size: 'sm', iconName: 'copy' }),
      actionButton('Export', async () => api.saveText(`${p.name.replace(/[^\w-]+/g, '_')}.ssm-profile.json`, JSON.stringify(await api.call('profiles.export', { id: p.id }), null, 2), [{ name: 'JSON', extensions: ['json'] }]), { size: 'sm', iconName: 'download' }),
      actionButton('', async () => { if (await confirmDialog({ title: 'Delete profile?', message: p.name, danger: true, confirmLabel: 'Delete' })) { await api.call('profiles.remove', { id: p.id }); profiles(body, servers); } }, { size: 'sm', iconName: 'trash' })) },
  ], list, { empty: 'No profiles yet. Save a server’s configuration to reuse it.' })), out);
}

async function templates(body, servers) {
  const list = await api.call('templates.list');
  mount(body, h('div', { class: 'row mb' }, h('span', { class: 'grow muted' }, 'Templates capture a server’s configuration and mod list so new servers can be created from it.'),
    servers.length ? actionButton('Save server as template', async () => {
      const sel = serverSelect(servers); const name = h('input', { class: 'input' }); const desc = h('input', { class: 'input' }); const mods = h('input', { type: 'checkbox', checked: true });
      modal({ title: 'Save server template', content: h('div', { class: 'col' }, h('label', { class: 'field' }, 'Server', sel), h('label', { class: 'field' }, 'Template name', name), h('label', { class: 'field' }, 'Description', desc), h('label', { class: 'check' }, mods, h('span', null, 'Include installed mods (references and versions)'))), actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: async (close) => { if (!name.value.trim()) return; await api.call('templates.save', { serverId: sel.value, name: name.value.trim(), description: desc.value, includeMods: mods.checked }); close(); toast('Template saved', '', 'success'); templates(body, servers); } }] });
    }, { kind: 'primary', iconName: 'plus' }) : null,
    api.desktop && servers.length ? actionButton('Duplicate a server', async () => {
      const sel = serverSelect(servers); const name = h('input', { class: 'input' }); const dir = h('input', { class: 'input mono' }); const pf = await portFields();
      modal({ title: 'Duplicate server configuration', content: h('div', { class: 'col' }, h('label', { class: 'field' }, 'Copy configuration from', sel), h('label', { class: 'field' }, 'New server name', name), h('label', { class: 'field' }, 'New installation folder', h('div', { class: 'input-group' }, dir, h('button', { class: 'btn', onclick: async () => { const d = await api.pickDirectory({ title: 'Folder for the new server' }); if (d) dir.value = d; } }, 'Browse…'))), pf.el, callout('info', 'info', 'The server files are installed on the new server’s page (Repair/Install).')),
        actions: [{ label: 'Cancel' }, { label: 'Create', kind: 'primary', onClick: async (close) => { const r = await api.call('templates.duplicateServer', { serverId: sel.value, name: name.value.trim(), installDir: dir.value.trim(), ...pf.values() }); close(); toast('Server created', 'Install its files next.', 'success'); location.hash = `#/server/${r.id}`; } }] });
    }, { iconName: 'copy' }) : null,
    actionButton('Import', async () => { const doc = await importDoc('template'); if (doc) { await api.call('templates.import', { document: doc }); toast('Template imported', '', 'success'); templates(body, servers); } }, { iconName: 'upload' })),
  list.length ? h('div', { class: 'grid cards' }, list.map((t) => h('div', { class: 'card col' },
    h('div', { class: 'row' }, h('div', { class: 'avatar' }, icon('template')), h('div', { class: 'grow' }, h('b', null, t.name), h('div', { class: 'small muted' }, t.description || `From ${t.data.source ? t.data.source.name : 'a server'}`))),
    h('div', { class: 'facts' }, h('div', null, h('span', null, 'Branch'), h('span', null, t.data.config.branch)), h('div', null, h('span', null, 'Max players'), h('span', null, String(t.data.config.ini.maxPlayers))), h('div', null, h('span', null, 'Mods'), h('span', null, String(t.data.mods.length))), h('div', null, h('span', null, 'Updated'), h('span', null, fmt.ago(t.updated_at)))),
    h('div', { class: 'row wrap' },
      api.desktop ? actionButton('Create server', async () => {
        const name = h('input', { class: 'input', value: `${t.name} server` }); const dir = h('input', { class: 'input mono' }); const pf = await portFields();
        modal({ title: `Create server from “${t.name}”`, content: h('div', { class: 'col' }, h('label', { class: 'field' }, 'Server name', name), h('label', { class: 'field' }, 'Installation folder (must be empty or new)', h('div', { class: 'input-group' }, dir, h('button', { class: 'btn', onclick: async () => { const d = await api.pickDirectory({ title: 'Folder for the new server' }); if (d) dir.value = d; } }, 'Browse…'))), pf.el, t.data.mods.length ? callout('info', 'puzzle', `After installing the server, install the template’s ${t.data.mods.length} mod(s) on the Mods page: ${t.data.mods.map((m) => m.reference).join(', ')}.`) : null),
          actions: [{ label: 'Cancel' }, { label: 'Create', kind: 'primary', onClick: async (close) => { const r = await api.call('templates.createServer', { id: t.id, name: name.value.trim(), installDir: dir.value.trim(), ...pf.values() }); close(); toast('Server created from template', 'Install its files next.', 'success'); location.hash = `#/server/${r.server.id}`; } }] });
      }, { size: 'sm', kind: 'primary', iconName: 'plus' }) : null,
      actionButton('Defaults', async () => {
        const c = t.data.config;
        const v = await formDialog({ title: 'Template defaults', fields: [{ key: 'name', label: 'Name', value: t.name }, { key: 'description', label: 'Description', value: t.description }, { key: 'maxPlayers', label: 'Max players', type: 'number', value: c.ini.maxPlayers }, { key: 'autosaveCount', label: 'Rotating autosaves', type: 'number', value: c.ini.autosaveCount }, { key: 'branch', label: 'Branch', type: 'select', value: c.branch, options: [{ value: 'public', label: 'public' }, { value: 'experimental', label: 'experimental' }] }] });
        if (v) { await api.call('templates.update', { id: t.id, name: v.name, description: v.description, config: { ...c, branch: v.branch, ini: { maxPlayers: v.maxPlayers, autosaveCount: v.autosaveCount } } }); templates(body, servers); }
      }, { size: 'sm', iconName: 'settings' }),
      actionButton('Export', async () => api.saveText(`${t.name.replace(/[^\w-]+/g, '_')}.ssm-template.json`, JSON.stringify(await api.call('templates.export', { id: t.id }), null, 2), [{ name: 'JSON', extensions: ['json'] }]), { size: 'sm', iconName: 'download' }),
      actionButton('', async () => { if (await confirmDialog({ title: 'Delete template?', message: t.name, danger: true, confirmLabel: 'Delete' })) { await api.call('templates.remove', { id: t.id }); templates(body, servers); } }, { size: 'sm', iconName: 'trash' }))))) : h('div', { class: 'card' }, empty({ title: 'No templates', text: 'Save a configured server as a template to create identical servers quickly.', illustration: 'review' })));
}
