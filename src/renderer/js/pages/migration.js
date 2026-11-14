// Server migration: move to another folder or export/import to another PC.
import { h, mount, fmt } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { callout, actionButton, confirmDialog, toast, card, kv, empty } from '../ui.js';

export async function render(page, _p, { setTitle }) {
  setTitle('Migration');
  const servers = await api.call('servers.list');
  const notMigrated = await api.call('migration.notMigrated');
  const progressBox = h('div', { class: 'small muted' });
  const off = api.on('operation.progress', (p) => { if (p && p.kind === 'migration') progressBox.textContent = p.message || ''; });
  const sel = () => h('select', { class: 'input' }, servers.map((s) => h('option', { value: s.id }, s.name)));
  const exSel = sel(); const mvSel = sel();
  const incFiles = h('input', { type: 'checkbox', checked: true }); const incBackups = h('input', { type: 'checkbox' });
  const pass = h('input', { class: 'input', type: 'password', placeholder: 'Optional — at least 10 characters', autocomplete: 'new-password' });
  const mvDir = h('input', { class: 'input mono', placeholder: 'New, empty folder' }); const delOld = h('input', { type: 'checkbox' });
  const imFile = h('input', { class: 'input mono', placeholder: 'Package file (.ssmpkg)' }); const imDir = h('input', { class: 'input mono', placeholder: 'Empty target folder' }); const imPass = h('input', { class: 'input', type: 'password', autocomplete: 'off' }); const imName = h('input', { class: 'input', placeholder: 'Keep original name' }); const imOverwrite = h('input', { type: 'checkbox' });
  const inspectBox = h('div');
  const browse = (input, kind, opts) => h('button', { class: 'btn', onclick: async () => { const p = kind === 'dir' ? await api.pickDirectory(opts) : await api.pickFile(opts); if (p) input.value = p; } }, 'Browse…');
  mount(page, h('div', { class: 'page-head' }, h('div', { class: 'titles' }, h('h1', null, 'Server migration'), h('p', null, 'Move a server to another folder, or package it for another PC with checksums and optional encryption.'))),
    progressBox,
    !servers.length ? empty({ title: 'No servers to migrate', text: 'You can still import a package below.' }) : null,
    h('div', { class: 'grid g2' },
      servers.length ? card('Export to another PC', 'upload', h('div', { class: 'col' },
        h('label', { class: 'field' }, 'Server', exSel),
        h('label', { class: 'check' }, incFiles, h('span', null, 'Include server files', h('span', { class: 'hint' }, 'Large (~8 GB). If unchecked, the server is re-installed from Steam on the new PC; config and mods are still included.'))),
        h('label', { class: 'check' }, incBackups, h('span', null, 'Include backup history')),
        h('label', { class: 'field' }, 'Encryption passphrase', pass, h('span', { class: 'hint' }, 'Encrypts the package with AES-256-GCM. Without it, anyone with the file can read your saves.')),
        actionButton('Export package…', async () => {
          const dest = await api.pickSaveFile({ title: 'Save migration package', defaultPath: 'server-migration.ssmpkg', filters: [{ name: 'SSM migration package', extensions: ['ssmpkg'] }] });
          if (!dest) return;
          const r = await api.call('migration.export', { serverId: exSel.value, dest, includeServerFiles: incFiles.checked, includeBackups: incBackups.checked, ...(pass.value ? { passphrase: pass.value } : {}) });
          toast('Package created', `${r.files} files · ${fmt.bytes(r.bytes)} · SHA-256 ${r.sha256.slice(0, 16)}…`, 'success');
        }, { kind: 'primary', iconName: 'upload' }))) : null,
      card('Import a package', 'download', h('div', { class: 'col' },
        h('label', { class: 'field' }, 'Package', h('div', { class: 'input-group' }, imFile, browse(imFile, 'file', { title: 'Choose a migration package', filters: [{ name: 'SSM migration package', extensions: ['ssmpkg'] }] }))),
        h('label', { class: 'field' }, 'Passphrase (if encrypted)', imPass),
        actionButton('Inspect package', async () => { const r = await api.call('migration.inspect', { file: imFile.value.trim(), ...(imPass.value ? { passphrase: imPass.value } : {}) }); mount(inspectBox, h('div', { class: 'card' }, kv([['Server', r.manifest.server.name], ['Created', fmt.date(Date.parse(r.manifest.createdAt))], ['From', `${r.manifest.source.hostname} (${r.manifest.source.platform})`], ['Files', `${r.fileCount} · ${fmt.bytes(r.totalBytes)}`], ['Server files included', r.manifest.installedFromSteam ? 'no — will install from Steam' : 'yes'], ['Encrypted', r.encrypted ? 'yes' : 'no'], ['Checksum file', r.checksumFile === null ? 'not found' : r.checksumFile ? 'matches' : 'MISMATCH']]))); }, { iconName: 'eye' }),
        inspectBox,
        h('label', { class: 'field' }, 'Target folder (must be empty or new)', h('div', { class: 'input-group' }, imDir, browse(imDir, 'dir', { title: 'Choose an empty folder for the imported server' }))),
        h('label', { class: 'field' }, 'Name', imName),
        h('label', { class: 'check' }, imOverwrite, h('span', null, 'Overwrite save files with the same name', h('span', { class: 'hint' }, 'Off by default: existing saves are kept. When on, a restore point is created first.'))),
        actionButton('Import', async () => {
          const r = await api.call('migration.import', { file: imFile.value.trim(), targetDir: imDir.value.trim(), ...(imName.value.trim() ? { name: imName.value.trim() } : {}), ...(imPass.value ? { passphrase: imPass.value } : {}), overwriteSaves: imOverwrite.checked });
          toast('Server imported', `${r.files} files verified${r.skippedSaves.length ? ` · ${r.skippedSaves.length} existing save(s) kept` : ''}${r.needsSteamInstall ? ' · install server files from Steam next' : ''}`, 'success');
          location.hash = `#/server/${r.server.id}`;
        }, { kind: 'primary', iconName: 'download' }))),
      servers.length ? card('Move to another folder', 'folder', h('div', { class: 'col' },
        h('label', { class: 'field' }, 'Server', mvSel),
        h('label', { class: 'field' }, 'New folder', h('div', { class: 'input-group' }, mvDir, browse(mvDir, 'dir', { title: 'Choose the new, empty folder' }))),
        h('label', { class: 'check' }, delOld, h('span', null, 'Delete the old folder after a verified copy')),
        actionButton('Move server', async () => { if (!(await confirmDialog({ title: 'Move server?', message: 'All files are copied and verified. The server must be stopped.', confirmLabel: 'Move' }))) return; const r = await api.call('migration.move', { serverId: mvSel.value, newDir: mvDir.value.trim(), deleteOld: delOld.checked }); toast('Server moved', `${r.files} files · ${fmt.bytes(r.bytes)}${r.oldDeleted ? '' : ` · old folder kept at ${r.oldDir}`}`, 'success'); }, { kind: 'primary', iconName: 'truck' }))) : null,
      card('What cannot be migrated automatically', 'info', h('ul', { class: 'muted small' }, notMigrated.map((x) => h('li', null, x))))));
  return off;
}
