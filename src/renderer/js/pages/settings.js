// Application settings. Each control saves immediately and is validated in the main process.
import { h, mount } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { settingRow, switchInput, toast, toastError, callout, confirmDialog, card, kv } from '../ui.js';
import { app as appState } from '../app.js';

const SECTIONS = [
  ['general', 'General', 'settings'], ['appearance', 'Appearance', 'sparkles'], ['startup', 'Startup & shutdown', 'power'], ['notifications', 'Notifications', 'bell'],
  ['backups', 'Backups', 'backup'], ['updates', 'Updates', 'update'], ['monitoring', 'Monitoring', 'activity'], ['storage', 'Storage', 'storage'],
  ['scheduler', 'Scheduler', 'calendar'], ['security', 'Security', 'shield'], ['remote', 'Remote & web', 'globe'], ['diagnostics', 'Diagnostics', 'stethoscope'], ['about', 'Application', 'info'],
];

export async function render(page, [section = 'general'], { setTitle, navigate }) {
  setTitle('Settings');
  const all = await api.call('settings.get');
  const cur = all[section] || {};
  const save = async (patch) => { try { await api.call('settings.update', { section, patch }); Object.assign(cur, patch); toast('Saved', '', 'success'); } catch (err) { toastError(err, 'Not saved'); render(page, [section], { setTitle, navigate }); } };
  const sw = (key) => switchInput(!!cur[key], (v) => save({ [key]: v }));
  const num = (key, min, max, width = 110) => { const i = h('input', { class: 'input', type: 'number', min, max, value: cur[key], style: { width: `${width}px` } }); i.addEventListener('change', () => save({ [key]: Number(i.value) })); return i; };
  const sel = (key, opts) => { const x = h('select', { class: 'input' }, opts.map(([v, l]) => h('option', { value: v, selected: String(cur[key]) === String(v) }, l))); x.addEventListener('change', () => save({ [key]: x.value })); return x; };
  const txt = (key, ph) => { const i = h('input', { class: 'input', value: cur[key] || '', placeholder: ph || '' }); i.addEventListener('change', () => save({ [key]: i.value })); return i; };
  const pick = (key, title) => h('div', { class: 'input-group' }, txt(key, 'Default location'), api.desktop ? h('button', { class: 'btn', onclick: async () => { const d = await api.pickDirectory({ title }); if (d) { await save({ [key]: d }); render(page, [section], { setTitle, navigate }); } } }, 'Browse…') : null);
  const servers = await api.call('servers.list');
  const body = h('div', { class: 'card' });
  const S = {
    general: () => [settingRow('Close to tray', 'Keep running in the notification area when the window is closed, so servers, monitoring and schedules continue.', sw('closeToTray')), settingRow('Confirm dangerous actions', 'Ask before deleting, restoring or force-stopping.', sw('confirmDangerous')), settingRow('Run setup assistant again', 'Install or attach another server with the guided setup.', h('button', { class: 'btn', onclick: async () => { await api.call('setup.reset'); location.reload(); } }, 'Open assistant'))],
    appearance: () => [settingRow('Theme', null, sel('theme', [['dark', 'Dark'], ['darker', 'Darker (OLED)'], ['system', 'Follow system']])), settingRow('Accent color', null, sel('accent', [['amber', 'FICSIT amber'], ['orange', 'Orange'], ['cyan', 'Cyan'], ['violet', 'Violet'], ['green', 'Green']])), settingRow('Density', null, sel('density', [['comfortable', 'Comfortable'], ['compact', 'Compact']])), settingRow('Reduce motion', 'Turns off animations and transitions.', sw('reduceMotion'))],
    startup: () => {
      const order = [...cur.autoStartServers];
      const list = h('div', { class: 'col' });
      const draw = () => mount(list, servers.map((s) => { const idx = order.indexOf(s.id); return h('div', { class: 'row' }, switchInput(idx >= 0, (v) => { if (v) order.push(s.id); else order.splice(order.indexOf(s.id), 1); save({ autoStartServers: [...order] }); draw(); }), h('span', { class: 'grow' }, s.name), idx >= 0 ? h('span', { class: 'badge accent' }, `#${idx + 1}`) : null, idx > 0 ? h('button', { class: 'btn ghost sm', onclick: () => { order.splice(idx, 1); order.splice(idx - 1, 0, s.id); save({ autoStartServers: [...order] }); draw(); } }, '↑') : null); }));
      draw();
      return [
        settingRow('Start Satisfactory Server Manager when I sign in to Windows', 'Adds a per-user startup entry (no administrator rights). Requires your explicit choice.', switchInput(!!cur.launchAtLogin, async (v, el) => { if (v && !(await confirmDialog({ title: 'Start with Windows?', message: 'Satisfactory Server Manager will be added to your Windows sign-in startup programs. You can remove it here or in Task Manager → Startup apps.', confirmLabel: 'Enable' }))) { el.checked = false; return; } save({ launchAtLogin: v }); })),
        settingRow('Start minimized to tray', 'When launched at sign-in.', sw('startMinimized')),
        settingRow('Delay between server starts (s)', 'Servers start one after another in the order below.', num('startDelaySeconds', 0, 600)),
        h('div', { class: 'setting' }, h('div', { class: 'txt' }, h('b', null, 'Servers to start automatically'), h('span', null, 'Started when the manager launches at Windows sign-in, in this order.')), h('div', { style: { minWidth: '300px' } }, list)),
        settingRow('Stop servers safely when exiting or when Windows shuts down', 'Saves via the API and shuts down gracefully within the grace period. Windows only allows a limited delay during shutdown.', sw('shutdownServersOnExit')),
        settingRow('Shutdown grace period (s)', null, num('shutdownGraceSeconds', 5, 600)),
        callout('info', 'info', 'Scheduled tasks run only while the manager is running. Enable start at sign-in so they keep working after reboots.')];
    },
    notifications: async () => {
      const r = await api.call('notifications.list', { unreadOnly: true });
      return [settingRow('Windows desktop notifications', 'Show toast notifications in addition to the in-app notification center.', sw('desktop')), settingRow('Keep history (days)', null, num('keepDays', 1, 3650)),
        h('h4', { style: { margin: '16px 0 4px' } }, 'Desktop notifications per category'),
        ...Object.entries(r.categories).map(([k, l]) => settingRow(l, null, switchInput(cur.categories[k] !== false, (v) => save({ categories: { [k]: v } }))))];
    },
    backups: () => [settingRow('Backup folder', 'Where backup archives are stored. Choose another drive to protect against disk failure.', pick('root', 'Choose backup folder')), settingRow('Back up before updates', 'Strongly recommended. Server updates are never run without a backup.', sw('beforeUpdate')), settingRow('Back up before mod changes', null, sw('beforeModChange')), settingRow('Compression level', '0 = store only (fastest), 9 = smallest.', num('compressLevel', 0, 9)),
      h('h4', { style: { margin: '16px 0 4px' } }, 'Rotation (retention policy)'), callout('warn', 'alert', 'Old scheduled backups and automatic restore points are only deleted when you enable rotation. Manual backups are never deleted automatically.'),
      settingRow('Enable rotation', null, sw('retentionEnabled')), settingRow('Keep scheduled backups', 'Newest N per server.', num('keepScheduled', 1, 10000)), settingRow('Keep automatic restore points', 'Before update/restore/mod changes.', num('keepAutomatic', 1, 10000)), settingRow('Maximum age (days)', '0 = no age limit.', num('maxAgeDays', 0, 36500))],
    updates: () => [settingRow('Check interval (hours)', null, num('checkIntervalHours', 1, 168)), settingRow('Check for application updates', 'Queries this project’s GitHub releases.', sw('checkApp')),
      settingRow('Dedicated server updates', 'Notify only, or install automatically inside the update window (only when no players are online).', sel('autoServerUpdate', [['off', 'Off'], ['notify', 'Notify only'], ['window', 'Install automatically in the update window'], ['scheduled', 'Only via scheduled tasks']])),
      settingRow('Mod updates', null, sel('autoModUpdate', [['off', 'Off'], ['notify', 'Notify only'], ['window', 'Install automatically in the update window'], ['scheduled', 'Only via scheduled tasks']])),
      settingRow('Update window start', 'Local time (HH:MM).', txt('windowStart', '04:00')), settingRow('Update window end', null, txt('windowEnd', '06:00')),
      settingRow('Verify after updating', 'Start the server after an update and wait until it responds.', sw('validateAfterUpdate')),
      settingRow('Keep a rollback copy of server files', 'Copies the current build (≈8 GB) before updating so it can be restored if the new build fails. Steam does not offer older builds for download.', sw('keepRollbackCopy'))],
    monitoring: () => [settingRow('Process sample interval (s)', 'CPU and memory measurement frequency.', num('sampleSeconds', 2, 300)), settingRow('Server query interval (s)', 'UDP state query and API telemetry.', num('apiPollSeconds', 5, 600)),
      settingRow('Keep raw samples (hours)', null, num('keepRawHours', 1, 720)), settingRow('Keep hourly history (days)', null, num('keepHourlyDays', 1, 3650)),
      settingRow('CPU warning threshold (%)', 'Warns after 5 minutes above this value.', num('cpuWarn', 1, 100)), settingRow('Memory warning (% of RAM)', null, num('memWarnPercent', 1, 100)), settingRow('Low disk warning (GB)', null, num('diskWarnGb', 1, 10000)), settingRow('Unresponsive after (s)', 'Warn when the server stops answering queries for this long.', num('unresponsiveSeconds', 10, 3600))],
    storage: () => [callout('info', 'info', 'Retention for logs and diagnostics is off (0) by default — nothing is deleted unless you set a value here. Cleanup runs with scheduled “Cleanup” tasks.'), settingRow('Delete console logs older than (days)', '0 = keep forever.', num('logRetentionDays', 0, 3650)), settingRow('Delete diagnostics packages older than (days)', '0 = keep forever.', num('diagnosticsRetentionDays', 0, 3650))],
    scheduler: async () => { const zones = await api.call('tasks.timezones'); return [settingRow('Default time zone', 'New tasks use this zone; each task can have its own.', sel('timezone', zones.map((z) => [z, z]))), settingRow('Missed-run grace window (minutes)', 'After the manager restarts, tasks missed within this window run once.', num('missedRunGraceMinutes', 0, 1440))]; },
    security: () => [kv([['Credential storage', appState.info.secrets.backend], ['Encryption available', appState.info.secrets.available ? 'yes' : 'no'], ['Strong encryption', appState.info.secrets.weak ? 'no' : 'yes']]), appState.info.secrets.weak ? settingRow('Allow weak credential storage', 'Only for systems without OS key storage. Not recommended.', sw('allowWeakSecretStorage')) : callout('ok', 'shieldCheck', 'Tokens and keys are encrypted with Windows Data Protection (DPAPI) for your user account. Passwords are never stored.')],
    remote: () => [callout('info', 'globe', 'Remote management and the web dashboard have their own page with pairing, accounts and security details.'), h('button', { class: 'btn primary', onclick: () => navigate('remote/web') }, icon('globe'), 'Open Remote & Web')],
    diagnostics: () => [settingRow('Collect diagnostics after crashes', 'Packages logs and crash reports automatically.', sw('autoCollectOnCrash')), settingRow('Server log lines in packages', null, num('includeServerLogLines', 50, 5000))],
    about: () => [kv([['Version', appState.info.version], ['Electron', appState.info.electron], ['Platform', `${appState.info.platform} ${appState.info.arch}`], ['Data folder', appState.info.paths.userData], ['Program folder', appState.info.paths.appInstallDir], ['License', appState.info.license.name]]), h('button', { class: 'btn mt', onclick: () => navigate('about') }, 'License & third-party notices')],
  };
  const items = await (S[section] || S.general)();
  mount(body, ...items);
  mount(page, h('div', { class: 'page-head' }, h('div', { class: 'titles' }, h('h1', null, 'Settings'), h('p', null, 'Changes are saved immediately.'))),
    h('div', { class: 'grid', style: { gridTemplateColumns: '220px 1fr' } },
      h('div', { class: 'card', style: { padding: '8px' } }, h('nav', { class: 'nav', style: { padding: 0 } }, SECTIONS.map(([k, l, i]) => h('a', { class: k === section ? 'active' : '', href: `#/settings/${k}` }, icon(i), l)))),
      h('div', null, h('h2', { class: 'mb' }, (SECTIONS.find((x) => x[0] === section) || SECTIONS[0])[1]), body)));
}
