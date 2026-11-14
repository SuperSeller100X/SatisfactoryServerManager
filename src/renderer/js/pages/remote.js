// Remote management (agent + controller) and the web dashboard.
import { h, mount, fmt } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { badge, table, callout, actionButton, confirmDialog, formDialog, toast, card, kv, tabs, modal, statusPill } from '../ui.js';

export async function render(page, [tab = 'machines'], { setTitle, navigate }) {
  setTitle('Remote & Web');
  const body = h('div');
  mount(page, h('div', { class: 'page-head' }, h('div', { class: 'titles' }, h('h1', null, 'Remote management & web dashboard'), h('p', null, 'Everything here is off by default and limited to your local network.'))),
    tabs([{ key: 'machines', label: 'Manage other PCs', icon: 'remote' }, { key: 'agent', label: 'Allow this PC to be managed', icon: 'shield' }, { key: 'web', label: 'Web dashboard', icon: 'globe' }], tab, (k) => navigate(`remote/${k}`)), body);
  if (tab === 'agent') return agent(body);
  if (tab === 'web') return web(body);
  return machines(body);
}

async function machines(body) {
  const list = await api.call('remote.machines');
  const detail = h('div');
  mount(body, h('div', { class: 'row mb' }, h('span', { class: 'grow muted' }, 'Pair another computer running Satisfactory Server Manager to see and control its servers from here.'),
    actionButton('Add computer', async () => {
      const v = await formDialog({ title: 'Add a remote computer', intro: 'On the other PC, open Remote & Web → “Allow this PC to be managed”, enable it and create a pairing code.', fields: [{ key: 'host', label: 'Address (IP or hostname)', required: true }, { key: 'port', label: 'Port', type: 'number', value: 8765 }, { key: 'name', label: 'Display name (optional)' }] });
      if (!v) return;
      const { fingerprint } = await api.call('remote.probe', { host: v.host.trim(), port: v.port });
      const code = await formDialog({ title: 'Verify the remote computer', intro: h('div', { class: 'col' }, h('p', null, 'Compare this certificate fingerprint with the one shown on the other PC. Only continue if they are identical.'), h('div', { class: 'pathbox' }, fingerprint)), fields: [{ key: 'code', label: 'Pairing code from the other PC', required: true, placeholder: 'XXXXX-XXXXX' }], submitLabel: 'Fingerprints match — pair' });
      if (!code) return;
      await api.call('remote.pair', { host: v.host.trim(), port: v.port, fingerprint, code: code.code.trim().toUpperCase(), ...(v.name ? { name: v.name } : {}) });
      toast('Computer paired', 'Credentials are stored encrypted.', 'success'); machines(body);
    }, { kind: 'primary', iconName: 'plus' })),
  list.length ? h('div', { class: 'grid cards' }, list.map((m) => h('div', { class: 'card col' },
    h('div', { class: 'row' }, h('div', { class: 'avatar' }, icon('monitor')), h('div', { class: 'grow' }, h('b', null, m.name), h('div', { class: 'small muted mono' }, `${m.host}:${m.port}`)), m.last_error ? badge('error', 'err') : badge('paired', 'ok')),
    kv([['Last contact', fmt.ago(m.last_seen)], ['Fingerprint', `${m.fingerprint.slice(0, 23)}…`], ['Last error', m.last_error || '—']]),
    h('div', { class: 'row wrap' },
      actionButton('Open', () => openMachine(m, detail), { size: 'sm', kind: 'primary', iconName: 'eye' }),
      actionButton('Test connection', async () => { const r = await api.call('remote.ping', { id: m.id }); toast(r.ok ? `Connected (${r.latency} ms)` : 'Connection failed', r.ok ? `${r.name} · v${r.version}` : r.error, r.ok ? 'success' : 'error'); }, { size: 'sm', iconName: 'wifi' }),
      actionButton('Remove', async () => { if (await confirmDialog({ title: 'Remove computer?', message: 'Local credentials are deleted and the remote PC is asked to revoke them.', danger: true, confirmLabel: 'Remove' })) { await api.call('remote.remove', { id: m.id }); machines(body); } }, { size: 'sm', kind: 'danger', iconName: 'trash' }))))) : callout('info', 'info', 'No remote computers paired yet.'), detail);
}

async function openMachine(m, detail) {
  mount(detail, h('div', { class: 'card mt' }, h('div', { class: 'muted' }, `Connecting to ${m.name}…`)));
  const call = (channel, payload) => api.call('remote.call', { id: m.id, channel, payload });
  const draw = async () => {
    const d = await call('dashboard.overview', {});
    mount(detail, h('div', { class: 'card mt flush' }, h('div', { class: 'card-head', style: { padding: '16px 20px 0' } }, h('h3', null, icon('remote'), `${m.name} — servers`), actionButton('Refresh', draw, { size: 'sm', iconName: 'restart' })), table([
      { key: 'name', label: 'Server', render: (s) => h('b', null, s.name) },
      { key: 'st', label: 'Status', render: (s) => statusPill(s.status.busy || s.status.status) },
      { key: 'cpu', label: 'CPU', render: (s) => (s.telemetry.cpu !== null && s.telemetry.cpu !== undefined ? `${s.telemetry.cpu.toFixed(1)}%` : 'n/a') },
      { key: 'mem', label: 'Memory', render: (s) => fmt.bytes(s.telemetry.memBytes) },
      { key: 'pl', label: 'Players', render: (s) => (s.telemetry.players ?? 'n/a') },
      { key: 'up', label: 'Uptime', render: (s) => fmt.dur(s.status.uptimeMs) },
      { key: 'bk', label: 'Last backup', render: (s) => (s.lastBackup ? fmt.ago(s.lastBackup.created_at) : 'never') },
      { key: 'act', label: '', render: (s) => h('div', { class: 'row wrap' },
        actionButton('Start', async () => { await call('servers.start', { serverId: s.id }); draw(); }, { size: 'sm', iconName: 'play' }),
        actionButton('Stop', async () => { await call('servers.stop', { serverId: s.id }); draw(); }, { size: 'sm', iconName: 'stop' }),
        actionButton('Backup', async () => { await call('backups.create', { serverId: s.id, note: 'Remote backup' }); toast('Remote backup created', '', 'success'); draw(); }, { size: 'sm', iconName: 'backup' }),
        actionButton('Logs', async () => { const lines = await call('console.snapshot', { serverId: s.id }); modal({ title: `${s.name} — console`, wide: true, content: h('div', { class: 'console', style: { height: '420px' } }, lines.slice(-500).map((l) => h('div', { class: `ln ${l.level}` }, h('span', { class: 'ts' }, fmt.time(l.ts)), h('span', { class: 'lv' }, l.src), h('span', null, l.text)))), actions: [{ label: 'Close' }] }); }, { size: 'sm', iconName: 'console' }),
        actionButton('Diagnose', async () => { const r = await call('diagnostics.run', { serverId: s.id }); modal({ title: `${s.name} — diagnostics`, wide: true, content: h('div', { class: 'col' }, r.findings.filter((f) => f.severity !== 'ok').map((f) => callout(f.severity === 'info' ? 'info' : f.severity === 'warning' ? 'warn' : 'err', 'alert', h('b', null, f.title), ' ', f.solution || '')).concat(r.findings.every((f) => f.severity === 'ok') ? [callout('ok', 'check', 'No problems found.')] : [])), actions: [{ label: 'Close' }] }); }, { size: 'sm', iconName: 'stethoscope' }),
        actionButton('Config', async () => { const c = (await call('servers.get', { serverId: s.id })).config; const v = await formDialog({ title: `${s.name} — configuration`, fields: [{ key: 'maxPlayers', label: 'Max players (restart required)', type: 'number', value: c.ini.maxPlayers }, { key: 'recovery', label: 'Automatic crash recovery', type: 'checkbox', value: c.recovery.enabled }] }); if (v) { await call('servers.update', { serverId: s.id, config: { ini: { maxPlayers: v.maxPlayers }, recovery: { enabled: v.recovery } } }); toast('Remote configuration saved', '', 'success'); } }, { size: 'sm', iconName: 'settings' })) },
    ], d.servers, { empty: 'No servers on that computer.' })));
  };
  draw().catch((e) => mount(detail, callout('err', 'alertCircle', e.message)));
}

async function agent(body) {
  const st = await api.call('remote.agentStatus');
  const settings = await api.call('settings.get');
  const code = h('div');
  mount(body, h('div', { class: 'grid g2' },
    card('Remote management of this PC', 'shield', h('div', { class: 'col' },
      callout('warn', 'alert', 'When enabled, paired computers on your local network can start/stop servers, change settings and create backups on this PC. Requests from public internet addresses are always refused.'),
      h('label', { class: 'check' }, (() => { const c = h('input', { type: 'checkbox', checked: settings.remote.enabled }); c.addEventListener('change', async () => { if (c.checked && !(await confirmDialog({ title: 'Enable remote management?', message: 'This starts an HTTPS endpoint. Unless you also choose “Local network” under Web dashboard → Network access, only this PC can connect.', confirmLabel: 'Enable' }))) { c.checked = false; return; } try { await api.call('settings.update', { section: 'remote', patch: { enabled: c.checked } }); agent(body); } catch (e) { c.checked = !c.checked; toast('Failed', e.message, 'error'); } }); return c; })(), h('span', null, 'Allow paired computers to manage this PC')),
      kv([['Endpoint', st.running && st.remoteEnabled ? `https://${st.host === '0.0.0.0' ? '<this PC>' : st.host}:${st.port}` : 'not running'], ['Network access', settings.web.bind === 'lan' ? 'local network' : 'this PC only'], ['Certificate fingerprint', st.fingerprint || '—']]),
      st.running && st.remoteEnabled ? actionButton('Create pairing code', async () => { const r = await api.call('remote.createPairingCode'); mount(code, h('div', { class: 'card col center' }, h('div', { class: 'muted small' }, 'Enter this code on the other PC within 10 minutes'), h('div', { style: { fontSize: '30px', fontWeight: 800, letterSpacing: '.12em', fontFamily: 'var(--mono)' } }, r.code), h('div', { class: 'small muted' }, 'Certificate fingerprint to compare:'), h('div', { class: 'pathbox small' }, r.fingerprint))); }, { kind: 'primary', iconName: 'key' }) : null, code)),
    card('Paired computers', 'remote', table([
      { key: 'name', label: 'Computer' }, { key: 'created_at', label: 'Paired', render: (d) => fmt.date(d.created_at) }, { key: 'last_seen', label: 'Last access', render: (d) => `${fmt.ago(d.last_seen)}${d.last_ip ? ` from ${d.last_ip}` : ''}` },
      { key: 'st', label: 'Access', render: (d) => (d.revoked_at ? badge('revoked', 'err') : badge('active', 'ok')) },
      { key: 'act', label: '', render: (d) => (d.revoked_at ? null : actionButton('Revoke', async () => { if (await confirmDialog({ title: `Revoke ${d.name}?`, message: 'That computer immediately loses access.', danger: true, confirmLabel: 'Revoke' })) { await api.call('remote.revokeDevice', { id: d.id }); agent(body); } }, { size: 'sm', kind: 'danger' })) },
    ], st.devices, { empty: 'No computers have been paired.' }))));
}

async function web(body) {
  const st = await api.call('web.status');
  const settings = await api.call('settings.get');
  const w = settings.web;
  const save = async (patch) => { try { await api.call('settings.update', { section: 'web', patch }); toast('Saved', '', 'success'); web(body); } catch (e) { toast('Failed', e.message, 'error'); web(body); } };
  const bind = h('select', { class: 'input' }, h('option', { value: 'localhost' }, 'This PC only (127.0.0.1)'), h('option', { value: 'lan' }, 'Local network (private addresses only)'));
  bind.value = w.bind;
  bind.addEventListener('change', async () => { if (bind.value === 'lan' && !(await confirmDialog({ title: 'Allow access from your local network?', message: 'Devices on your home network will be able to reach the sign-in page. Public internet addresses are still refused. Use strong passwords.', confirmLabel: 'Allow local network' }))) { bind.value = w.bind; return; } save({ bind: bind.value }); });
  const port = h('input', { class: 'input', type: 'number', value: w.port, style: { width: '120px' } }); port.addEventListener('change', () => save({ port: Number(port.value) }));
  const enabled = h('input', { type: 'checkbox', checked: w.enabled }); enabled.addEventListener('change', () => save({ enabled: enabled.checked }));
  const control = h('input', { type: 'checkbox', checked: w.allowRemoteControl }); control.addEventListener('change', () => save({ allowRemoteControl: control.checked }));
  mount(body, h('div', { class: 'grid g2' },
    card('Web dashboard', 'globe', h('div', { class: 'col' },
      h('label', { class: 'check' }, enabled, h('span', null, 'Enable the browser dashboard', h('span', { class: 'hint' }, 'HTTPS with a certificate generated on this PC; your browser will ask you to trust it the first time.'))),
      h('div', { class: 'grid g2' }, h('label', { class: 'field' }, 'Network access', bind), h('label', { class: 'field' }, 'Port', port)),
      h('label', { class: 'check' }, control, h('span', null, 'Allow control actions (start/stop/backup/config) for admin accounts')),
      st.running && st.webEnabled ? h('div', { class: 'col' }, h('b', null, 'Open in a browser:'), ...st.urls.map((u) => h('div', { class: 'pathbox' }, u)), h('div', { class: 'small muted' }, `Certificate SHA-256: ${st.fingerprint}`)) : callout('info', 'info', 'The dashboard is not running.'))),
    card('Accounts', 'users', h('div', { class: 'col' },
      table([{ key: 'username', label: 'User' }, { key: 'role', label: 'Role', render: (u) => badge(u.role, u.role === 'admin' ? 'accent' : '') }, { key: 'last_login', label: 'Last sign-in', render: (u) => fmt.ago(u.last_login) },
        { key: 'act', label: '', render: (u) => h('div', { class: 'row' }, actionButton('Password', async () => { const v = await formDialog({ title: `New password for ${u.username}`, fields: [{ key: 'password', label: 'Password', type: 'password', hint: 'At least 12 characters' }] }); if (v) { await api.call('web.setPassword', { id: u.id, password: v.password }); toast('Password changed', 'Existing sessions were signed out.', 'success'); } }, { size: 'sm' }), actionButton('', async () => { if (await confirmDialog({ title: `Delete ${u.username}?`, message: 'Active sessions end immediately.', danger: true, confirmLabel: 'Delete' })) { await api.call('web.removeUser', { id: u.id }); web(body); } }, { size: 'sm', iconName: 'trash' })) }], st.users, { empty: 'No accounts yet.' }),
      actionButton('Add account', async () => { const v = await formDialog({ title: 'Add web dashboard account', fields: [{ key: 'username', label: 'Username', required: true }, { key: 'password', label: 'Password', type: 'password', required: true, hint: 'At least 12 characters' }, { key: 'role', label: 'Role', type: 'select', value: 'viewer', options: [{ value: 'viewer', label: 'Viewer — read-only' }, { value: 'admin', label: 'Administrator — can control servers' }] }] }); if (v) { await api.call('web.addUser', v); toast('Account created', '', 'success'); web(body); } }, { kind: 'primary', iconName: 'plus' }),
      st.sessions.length ? h('div', null, h('h4', { class: 'mb' }, 'Active sessions'), table([{ key: 'username', label: 'User' }, { key: 'ip', label: 'Address' }, { key: 'lastSeen', label: 'Last activity', render: (x) => fmt.ago(x.lastSeen) }], st.sessions)) : null)),
    card('Security measures', 'shieldCheck', h('ul', { class: 'muted small' }, ['TLS 1.2+ only, certificate generated locally', 'Passwords hashed with scrypt; never stored in plain text', 'HttpOnly, Secure, SameSite=Strict session cookies with idle and absolute timeouts', 'Per-session CSRF tokens and Origin checks on every change', 'Strict Content-Security-Policy, no inline scripts', 'Sign-in rate limiting (5 attempts per 15 minutes)', 'Requests from non-private (internet) addresses are refused', 'Credentials, file paths and OS integration are never exposed to the browser'].map((x) => h('li', null, x))))));
}
