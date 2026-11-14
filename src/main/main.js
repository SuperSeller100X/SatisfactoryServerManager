'use strict';
/**
 * Satisfactory Server Manager — Electron main process.
 *
 * Security posture:
 *  - contextIsolation: true, sandbox: true, nodeIntegration: false
 *  - UI served from a privileged custom protocol (app://ssm/) with a strict CSP
 *  - single narrow preload bridge; every call is validated in rpc.js
 *  - navigation and new windows are blocked; only allow-listed https links
 *    open in the system browser
 *  - all permission requests (camera, geolocation, …) are denied
 *  - TLS verification is never disabled globally
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow, ipcMain, protocol, net, dialog, shell, Tray, Menu, Notification, nativeImage, safeStorage, session, powerMonitor } = require('electron');

const { Database } = require('./core/db');
const { Bus, FORWARDED_TOPICS } = require('./core/events');
const { Logger } = require('./core/logger');
const { Settings } = require('./core/settings');
const { Secrets } = require('./core/secrets');
const { Audit } = require('./core/audit');
const { Notifications } = require('./core/notifications');
const { KeyedLock } = require('./core/util');
const http = require('./core/http');
const { isInside } = require('./core/fsutil');
const layout = require('./server/layout');
const { ServerRegistry } = require('./server/registry');
const { Supervisor } = require('./server/supervisor');
const { createProbe } = require('./server/procstats');
const { SteamCmd, readAppManifest } = require('./steam/steamcmd');
const { Backups } = require('./features/backups');
const { Scheduler } = require('./features/scheduler');
const { Updates } = require('./features/updates');
const { Mods } = require('./features/mods');
const { Health } = require('./features/health');
const { Diagnostics } = require('./features/diagnostics');
const { Storage } = require('./features/storage');
const { Profiles } = require('./features/profiles');
const { Migration } = require('./features/migration');
const { Benchmarks } = require('./features/benchmarks');
const { Startup } = require('./features/startup');
const { Access } = require('./features/access');
const { Setup } = require('./features/setup');
const sys = require('./features/system');
const { WebServer, CSP } = require('./net/webserver');
const { RemoteClient } = require('./net/remote-client');
const { Rpc } = require('./rpc');

const APP_ORIGIN = 'app://ssm';
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const EXTERNAL_ALLOW = ['satisfactory.wiki.gg', 'ficsit.app', 'github.com', 'store.steampowered.com', 'developer.valvesoftware.com', 'learn.microsoft.com', 'support.microsoft.com', 'www.satisfactorygame.com', 'satisfactory.fandom.com', 'docs.ficsit.app', 'localhost'];

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win = null;
let tray = null;
let quitting = false;
let ctx = null;

function paths() {
  const userData = process.env.SSM_USER_DATA || app.getPath('userData');
  const local = process.env.SSM_USER_DATA ? userData : (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'SatisfactoryServerManager') : path.join(userData, 'local'));
  const P = {
    userData, local,
    db: path.join(userData, 'manager.db'), logs: path.join(userData, 'logs'),
    steamcmd: path.join(local, 'steamcmd'), backups: path.join(local, 'backups'), runs: path.join(local, 'runs'),
    diagnostics: path.join(local, 'diagnostics'), modSnapshots: path.join(local, 'mod-snapshots'), rollback: path.join(local, 'rollback'), temp: path.join(local, 'temp'),
    renderer: RENDERER_DIR,
    appInstallDir: app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '..', '..'),
  };
  for (const k of ['logs', 'backups', 'runs', 'diagnostics', 'modSnapshots', 'rollback', 'temp']) fs.mkdirSync(P[k], { recursive: true });
  return P;
}

function buildContext() {
  const P = paths();
  const logger = new Logger(P.logs, { echo: !app.isPackaged && !!process.env.SSM_LOG_ECHO });
  const log = logger.scope('main');
  const db = new Database(P.db);
  const bus = new Bus();
  const settings = new Settings(db, bus);
  if (settings.get('steam').steamcmdDir) P.steamcmd = settings.get('steam').steamcmdDir;
  const c = { paths: P, logger, log, db, bus, settings, locks: new KeyedLock() };
  c.secrets = new Secrets(db, safeStorage, settings);
  c.audit = new Audit(db);
  c.notifications = new Notifications({ db, bus, settings, NativeNotification: Notification, log: logger.scope('notify') });
  c.registry = new ServerRegistry(c);
  c.probe = createProbe();
  c.steamcmd = new SteamCmd({ dir: P.steamcmd, log: logger.scope('steamcmd') });
  c.supervisor = new Supervisor(c);
  c.backups = new Backups(c);
  c.scheduler = new Scheduler(c);
  c.updates = new Updates(c);
  c.mods = new Mods(c);
  c.health = new Health(c);
  c.diagnostics = new Diagnostics(c);
  c.storage = new Storage(c);
  c.profiles = new Profiles(c);
  c.migration = new Migration(c);
  c.benchmarks = new Benchmarks(c);
  c.startup = new Startup(c, app);
  c.access = new Access(c);
  c.setup = new Setup(c);
  c.web = new WebServer(c);
  c.remote = new RemoteClient(c);
  c.license = { name: 'Satisfactory Server Manager Proprietary Non-Commercial License', holder: 'SuperSeller100X', file: app.isPackaged ? path.join(process.resourcesPath, 'LICENSE.txt') : path.resolve(__dirname, '..', '..', 'LICENSE') };
  c.collectCrashDiagnostics = (id, runId, crashId) => c.diagnostics.collectCrashPackage(id, runId, crashId);
  c.serverSummary = (srv, o) => serverSummary(c, srv, o);
  c.connectionInfo = (id) => connectionInfo(c, id);
  c.exportServerInfo = (id) => exportServerInfo(c, id);
  c.playerInfo = (id) => playerInfo(c, id);
  c.rpc = new Rpc(c);
  registerTaskHandlers(c);
  return c;
}

// ------------------------------------------------------------------ aggregates used by RPC
async function serverSummary(c, srv, { full = false } = {}) {
  const st = c.supervisor.status(srv.id);
  const snap = c.health.snapshot(srv.id);
  const manifest = await readAppManifest(srv.installDir).catch(() => null);
  const lastBackup = c.db.get('SELECT id, created_at, type, status, size FROM backups WHERE server_id = ? ORDER BY created_at DESC LIMIT 1', srv.id) || null;
  const lastUpdate = c.db.get("SELECT ts, kind, to_version, status FROM updates WHERE server_id = ? AND status IN ('completed','failed') ORDER BY id DESC LIMIT 1", srv.id) || null;
  const mods = await c.mods.installed(srv.id).catch(() => []);
  const upd = c.updates.appInfo && c.updates.appInfo.branches[srv.config.branch];
  const out = {
    id: srv.id, name: srv.name, group: srv.group, installDir: srv.installDir, branch: srv.config.branch,
    ports: { game: srv.config.launch.port, reliable: srv.config.launch.reliablePort },
    status: st, telemetry: snap,
    build: manifest ? { buildId: manifest.buildId, branch: manifest.branch, fullyInstalled: manifest.fullyInstalled, lastUpdated: manifest.lastUpdated } : null,
    netCL: srv.config.cache.netCL,
    updateAvailable: !!(manifest && upd && upd.buildId && upd.buildId !== manifest.buildId),
    mods: { count: mods.length, managed: mods.filter((m) => m.managed).length, sml: mods.find((m) => m.reference === 'SML') ? mods.find((m) => m.reference === 'SML').version : null },
    lastBackup, lastUpdate,
    maintenance: srv.config.maintenance, apiAccess: c.supervisor.hasToken(srv.id), recoveryEnabled: srv.config.recovery.enabled,
    autoStart: c.settings.get('startup').autoStartServers.includes(srv.id),
  };
  if (full) {
    out.config = { ...srv.config, api: { hasToken: c.supervisor.hasToken(srv.id), tokenKind: srv.config.api.tokenKind, pinned: !!srv.config.api.pin, fingerprint: srv.config.api.pin } };
    out.indicators = c.health.indicators(srv.id);
    out.updates = await c.updates.serverStatus(srv.id).catch(() => null);
  }
  return out;
}

function connectionInfo(c, id) {
  const srv = c.registry.get(id);
  const lan = sys.lanAddresses();
  const port = srv.config.launch.port;
  const pub = srv.config.connection.publicAddress;
  const lines = [
    `How to join "${srv.name}" in Satisfactory:`,
    '1. Start Satisfactory and open the Server Manager from the main menu.',
    '2. Click "Add Server".',
    `3. Enter the address ${pub || (lan[0] ? lan[0].address : '<server address>')} and port ${port}.`,
    '4. Click "Confirm"; enter the server password if the host gave you one.',
    pub ? '' : 'Players outside your home network need your public IP address and port forwarding of the ports below on your router.',
    `Ports: UDP ${port}, TCP ${port}, TCP ${srv.config.launch.reliablePort}.`,
  ].filter(Boolean);
  return { name: srv.name, port, reliablePort: srv.config.launch.reliablePort, lan, publicAddress: pub || null, shareText: lines.join('\n') };
}

async function exportServerInfo(c, id) {
  const s = await serverSummary(c, c.registry.get(id), { full: true });
  delete s.telemetry; delete s.indicators;
  return { format: 'ssm-server-info', exportedAt: new Date().toISOString(), server: s, connection: connectionInfo(c, id), mods: await c.mods.installed(id).catch(() => []) };
}

function playerInfo(c, id) {
  const snap = c.health.snapshot(id);
  const joins = c.db.all("SELECT ts, player, run_id FROM player_events WHERE server_id = ? AND kind = 'join' ORDER BY ts DESC LIMIT 200", id);
  const counts = c.db.all("SELECT ts, player AS count FROM player_events WHERE server_id = ? AND kind = 'count' ORDER BY ts DESC LIMIT 500", id);
  // Sessions: periods where the API-reported player count was above zero.
  const sessions = [];
  let open = null;
  for (const e of [...counts].reverse()) {
    const n = Number(e.count);
    if (n > 0 && !open) open = { start: e.ts, peak: n };
    else if (n > 0 && open) open.peak = Math.max(open.peak, n);
    else if (n === 0 && open) { sessions.push({ ...open, end: e.ts }); open = null; }
  }
  if (open) sessions.push({ ...open, end: null });
  return {
    connected: snap.players, limit: snap.playerLimit, apiAccess: c.supervisor.hasToken(id),
    note: 'The dedicated server API reports the number of connected players but not their names. Names below come from "Join succeeded" lines in the server log of runs started by this manager.',
    recentJoins: joins, sessions: sessions.reverse().slice(0, 50),
  };
}

function registerTaskHandlers(c) {
  const S = c.scheduler;
  S.register('restart', async (t) => {
    if (!c.supervisor.isActive(t.serverId)) return { skipped: true, message: 'Server not running' };
    if (t.params.onlyIfEmpty && c.health.snapshot(t.serverId).players > 0) return { skipped: true, message: 'Players online' };
    await c.supervisor.restart(t.serverId, { actor: 'scheduler', trigger: 'scheduled', reason: 'Scheduled restart' });
    return { message: 'Restarted' };
  });
  S.register('start', async (t) => { if (c.supervisor.isActive(t.serverId)) return { skipped: true, message: 'Already running' }; await c.supervisor.start(t.serverId, { trigger: 'scheduled', actor: 'scheduler' }); return { message: 'Started' }; });
  S.register('stop', async (t) => { if (!c.supervisor.isActive(t.serverId)) return { skipped: true, message: 'Not running' }; await c.supervisor.stop(t.serverId, { reason: 'Scheduled stop', actor: 'scheduler' }); return { message: 'Stopped' }; });
  S.register('backup', async (t) => { const b = await c.backups.create(t.serverId, { type: 'scheduled', actor: 'scheduler' }); return { message: `Backup ${b.id} created` }; });
  S.register('server-update', async (t) => {
    const st = await c.updates.serverStatus(t.serverId);
    await c.updates.publishedBuilds({ force: true });
    const fresh = await c.updates.serverStatus(t.serverId);
    if (!fresh.updateAvailable && st.installed) return { skipped: true, message: 'Already up to date' };
    const r = await c.updates.updateServer(t.serverId, { actor: 'scheduler', trigger: 'scheduled', onlyIfEmpty: !!t.params.onlyIfEmpty });
    return r.skipped ? r : { message: `Updated to build ${r.to}` };
  });
  S.register('mod-update', (t) => c.mods.updateAll(t.serverId, { actor: 'scheduler', restartAfter: t.params.restartAfter !== false }));
  S.register('maintenance', async (t) => {
    const steps = [];
    const was = c.supervisor.isActive(t.serverId);
    if (was) { await c.supervisor.stop(t.serverId, { reason: 'Scheduled maintenance', actor: 'scheduler' }); steps.push('stopped'); }
    try {
      await c.backups.create(t.serverId, { type: 'scheduled', note: 'Scheduled maintenance', actor: 'scheduler' }).then(() => steps.push('backup')).catch((e) => { if (e.code !== 'E_NOTHING_TO_BACKUP') throw e; });
      await c.updates.publishedBuilds({ force: true });
      if ((await c.updates.serverStatus(t.serverId)).updateAvailable) { await c.updates.updateServer(t.serverId, { actor: 'scheduler', trigger: 'maintenance' }); steps.push('server updated'); }
      const m = await c.mods.checkUpdates(t.serverId);
      if (m.updates.length) { await c.mods.apply(t.serverId, m.updates.map((u) => ({ reference: u.reference, version: u.latest })), { actor: 'scheduler' }); steps.push(`${m.updates.length} mod(s) updated`); }
      await c.storage.applyPolicies(); steps.push('cleanup');
    } finally {
      if (was && !c.supervisor.isActive(t.serverId)) { await c.supervisor.start(t.serverId, { trigger: 'maintenance', actor: 'scheduler' }); steps.push('started'); }
    }
    return { message: steps.join(', ') };
  });
  S.register('cleanup', () => c.storage.applyPolicies());
  S.register('update-check', async () => { const r = await c.updates.checkAll({ notify: true }); return { message: `${r.servers.filter((s) => s.updateAvailable).length} server and ${r.mods.length} mod update(s) found` }; });
  S.register('validate-backups', async () => {
    let bad = 0; let n = 0;
    for (const b of c.backups.list()) { n++; const r = await c.backups.validate(b.id, 'scheduler'); if (!r.ok) bad++; }
    if (bad) c.notifications.notify({ category: 'backupFailed', severity: 'error', title: `${bad} backup(s) failed validation`, body: 'Open the backup browser for details.' });
    return { message: `${n} backups validated, ${bad} invalid` };
  });
}

// ------------------------------------------------------------------ protocol & window
function registerProtocol() {
  protocol.handle('app', async (req) => {
    const url = new URL(req.url);
    if (url.host !== 'ssm') return new Response('Not found', { status: 404 });
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^\/+/, '');
    const file = path.resolve(RENDERER_DIR, rel);
    if (!isInside(RENDERER_DIR, file)) return new Response('Forbidden', { status: 403 });
    try {
      const res = await net.fetch(require('node:url').pathToFileURL(file).toString());
      const headers = new Headers(res.headers);
      headers.set('Content-Security-Policy', CSP);
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(res.body, { status: res.status, headers });
    } catch { return new Response('Not found', { status: 404 }); }
  });
}

function iconPath() { return path.join(RENDERER_DIR, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'); }

function createWindow({ hidden = false } = {}) {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 700, show: false, backgroundColor: '#0b0e14',
    title: 'Satisfactory Server Manager', icon: iconPath(), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false, devTools: !app.isPackaged || !!process.env.SSM_DEVTOOLS },
  });
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`${APP_ORIGIN}/`)) { e.preventDefault(); openExternal(url); } });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  win.once('ready-to-show', () => { if (!hidden) win.show(); });
  win.on('close', (e) => {
    if (!quitting && ctx.settings.get('general').closeToTray && tray) { e.preventDefault(); win.hide(); }
  });
  // Windows shutdown / log-off: stop servers gracefully within the grace period.
  win.on('query-session-end', (e) => {
    if (Object.keys(ctx.supervisor.runningPids()).length && ctx.settings.get('startup').shutdownServersOnExit) { e.preventDefault(); shutdownServers('Windows is shutting down'); }
  });
  win.on('session-end', () => { shutdownServers('Windows session ended'); });
  win.loadURL(`${APP_ORIGIN}/index.html`);
}

function openExternal(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && EXTERNAL_ALLOW.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) shell.openExternal(u.toString());
  } catch { /* ignore invalid URLs */ }
}

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(RENDERER_DIR, 'assets', 'icon.png')).resize({ width: 16, height: 16 }));
    tray.setToolTip('Satisfactory Server Manager');
    const rebuild = () => {
      const items = ctx.registry.list().map((s) => {
        const active = ctx.supervisor.isActive(s.id);
        return { label: `${s.name} — ${ctx.supervisor.status(s.id).status}`, submenu: [{ label: 'Start', enabled: !active, click: () => ctx.supervisor.start(s.id, { actor: 'tray' }).catch((e) => ctx.notifications.notify({ category: 'startFailure', severity: 'error', title: `${s.name} could not start`, body: e.message, serverId: s.id })) }, { label: 'Stop', enabled: active, click: () => ctx.supervisor.stop(s.id, { actor: 'tray' }).catch((e) => dialog.showErrorBox('Stop failed', e.message)) }] };
      });
      tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open Satisfactory Server Manager', click: showWindow }, { type: 'separator' }, ...items, { type: 'separator' }, { label: 'Quit', click: () => { quitting = true; app.quit(); } }]));
    };
    rebuild();
    ctx.bus.on('server.status', rebuild);
    ctx.bus.on('server.changed', rebuild);
    tray.on('click', showWindow);
  } catch (err) { ctx.log.warn('Tray unavailable', err); tray = null; }
}

function showWindow() { if (!win) createWindow(); else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } }

let shuttingDown = null;
function shutdownServers(reason) {
  if (!shuttingDown) {
    const grace = ctx.settings.get('startup').shutdownGraceSeconds;
    shuttingDown = ctx.supervisor.stopAll({ graceSeconds: grace, reason }).catch((e) => ctx.log.error('Stopping servers failed', e));
  }
  return shuttingDown;
}

// ------------------------------------------------------------------ IPC
function registerIpc() {
  const fromApp = (e) => { try { return new URL(e.senderFrame.url).origin === APP_ORIGIN; } catch { return false; } };
  const wrap = (fn) => async (e, ...args) => {
    if (!fromApp(e)) return { ok: false, error: { code: 'E_FORBIDDEN', message: 'Untrusted sender' } };
    try { return { ok: true, result: await fn(...args) }; } catch (err) {
      if (!['E_VALIDATION', 'E_CONFIRM_REQUIRED'].includes(err.code)) ctx.log.warn(`IPC call failed: ${err.message}`);
      return { ok: false, error: { code: err.code || 'E_INTERNAL', message: err.message, details: err.details && typeof err.details === 'object' ? JSON.parse(JSON.stringify(err.details)) : undefined } };
    }
  };
  ipcMain.handle('rpc', wrap((msg) => {
    if (!msg || typeof msg !== 'object' || typeof msg.channel !== 'string') throw Object.assign(new Error('Invalid request'), { code: 'E_VALIDATION' });
    return ctx.rpc.dispatch(msg.channel, msg.payload, { transport: 'ipc', actor: 'local' });
  }));
  ipcMain.handle('dialog', wrap(async (opts) => {
    const kind = opts && opts.kind;
    const title = typeof opts.title === 'string' ? opts.title.slice(0, 120) : undefined;
    const defaultPath = typeof opts.defaultPath === 'string' && path.isAbsolute(opts.defaultPath) ? opts.defaultPath : undefined;
    const filters = Array.isArray(opts.filters) ? opts.filters.slice(0, 5).map((f) => ({ name: String(f.name).slice(0, 60), extensions: (f.extensions || []).slice(0, 10).map((x) => String(x).replace(/[^a-z0-9*]/gi, '').slice(0, 10)) })) : undefined;
    if (kind === 'directory') { const r = await dialog.showOpenDialog(win, { title, defaultPath, properties: ['openDirectory', 'createDirectory', 'promptToCreate'] }); return r.canceled ? null : r.filePaths[0]; }
    if (kind === 'file') { const r = await dialog.showOpenDialog(win, { title, defaultPath, filters, properties: ['openFile'] }); return r.canceled ? null : r.filePaths[0]; }
    if (kind === 'save') { const r = await dialog.showSaveDialog(win, { title, defaultPath, filters }); return r.canceled ? null : r.filePath; }
    throw Object.assign(new Error('Unknown dialog'), { code: 'E_VALIDATION' });
  }));
  ipcMain.handle('saveText', wrap(async ({ suggestedName, text, filters }) => {
    if (typeof text !== 'string' || text.length > 50 * 1024 * 1024) throw Object.assign(new Error('Invalid content'), { code: 'E_VALIDATION' });
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), String(suggestedName || 'export.txt').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120)), filters });
    if (r.canceled) return null;
    await require('./core/fsutil').writeFileAtomic(r.filePath, text);
    return r.filePath;
  }));
  ipcMain.handle('openExternal', wrap((url) => { openExternal(String(url)); return true; }));
  ipcMain.handle('openPath', wrap(async (p) => {
    // Only folders managed by the application can be revealed in Explorer.
    const target = path.resolve(String(p));
    const roots = [ctx.paths.userData, ctx.paths.local, ...ctx.registry.list().map((s) => s.installDir), ctx.backups.root(), layout.defaultSaveRoot()];
    if (!roots.some((r) => isInside(r, target))) throw Object.assign(new Error('Only manager-related folders can be opened.'), { code: 'E_FORBIDDEN' });
    shell.showItemInFolder(target);
    return true;
  }));
  ctx.bus.on('event', (e) => { if (FORWARDED_TOPICS.has(e.topic) && win && !win.isDestroyed()) win.webContents.send('event', e); });
}

// ------------------------------------------------------------------ lifecycle
app.on('second-instance', showWindow);
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (ev, url) => { if (!url.startsWith(`${APP_ORIGIN}/`)) ev.preventDefault(); });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

app.whenReady().then(async () => {
  http.setFetch((url, opts) => net.fetch(url, opts));
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'notifications' || permission === 'clipboard-sanitized-write'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'notifications' || permission === 'clipboard-sanitized-write');
  ctx = buildContext();
  ctx.log.info(`Starting v${require('../../package.json').version} on ${process.platform} ${os.release()}`);
  registerProtocol();
  registerIpc();
  ctx.notifications.onClick = () => showWindow();
  const fromStartup = process.argv.includes('--startup');
  createWindow({ hidden: fromStartup && ctx.settings.get('startup').startMinimized });
  createTray();
  await ctx.supervisor.adoptRunning().catch((e) => ctx.log.warn('Adoption failed', e));
  ctx.health.start();
  ctx.scheduler.start();
  ctx.updates.startAuto();
  ctx.benchmarks.resume();
  ctx.web.apply().catch((e) => { ctx.log.error('Web server failed to start', e); ctx.notifications.notify({ category: 'security', severity: 'error', title: 'Web dashboard could not start', body: e.message }); });
  powerMonitor.on('resume', () => ctx.scheduler.recompute());
  if (fromStartup && ctx.settings.get('general').firstRunComplete) {
    setTimeout(() => ctx.startup.autoStart().catch((e) => ctx.log.warn('Autostart failed', e)), Math.min(ctx.settings.get('startup').startDelaySeconds, 60) * 1000);
  }
});

app.on('before-quit', (e) => {
  quitting = true;
  if (!ctx || shuttingDown === 'done') return;
  const active = Object.keys(ctx.supervisor.runningPids()).length;
  if (active && ctx.settings.get('startup').shutdownServersOnExit) {
    e.preventDefault();
    if (win && !win.isDestroyed()) win.webContents.send('event', { topic: 'operation.progress', payload: { kind: 'shutdown', message: 'Stopping servers safely before exit…' } });
    shutdownServers('Manager is closing').finally(() => { finalize(); shuttingDown = 'done'; app.quit(); });
    return;
  }
  finalize();
  shuttingDown = 'done';
});

function finalize() {
  try { ctx.health.stop(); ctx.scheduler.stop(); ctx.updates.stop(); ctx.supervisor.dispose(); ctx.probe.dispose(); ctx.web.stop(); ctx.db.close(); } catch { /* best effort */ }
}

app.on('window-all-closed', () => { if (!tray) { quitting = true; app.quit(); } });

module.exports = { serverSummary, connectionInfo, playerInfo };
