'use strict';
/**
 * RPC channel registry. Every operation the UI can trigger is declared here
 * once, with:
 *   - an input schema (validated before the handler runs, unknown keys rejected)
 *   - a permission level:
 *       read      viewers, web dashboard, paired remote managers (scope "read")
 *       control   start/stop/restart/backup/diagnostics (web admin, remote "control")
 *       configure configuration changes (web admin, remote "configure")
 *       local     desktop app only (file paths, dialogs, credentials, OS integration)
 * Desktop IPC, the web dashboard and remote management all go through
 * dispatch(), so authorisation and validation are identical everywhere.
 */
const { v } = require('./core/validate');
const { AppError } = require('./core/util');
const layout = require('./server/layout');
const { SERVER_OPTION_KEYS } = require('./server/registry');
const { CATEGORIES } = require('./core/notifications');
const { TASK_TYPES } = require('./features/scheduler');
const firewall = require('./features/firewall');
const sys = require('./features/system');

const sid = v.object({ serverId: v.id() });
const none = v.optional(v.object({}));
const name = () => v.string({ min: 1, max: 80, trim: true });
const ref = () => v.string({ min: 1, max: 64, pattern: /^[A-Za-z0-9_]+$/ });
const confirm = v.optional(v.bool());

function buildChannels(ctx) {
  const C = {};
  const def = (channel, level, schema, handler) => { C[channel] = { level, schema, handler }; };
  const S = ctx;

  // ---------------------------------------------------------------- app / dashboard
  def('app.info', 'read', none, () => ({ version: require('../../package.json').version, platform: process.platform, arch: process.arch, electron: process.versions.electron, node: process.versions.node, paths: { userData: S.paths.userData, appInstallDir: S.paths.appInstallDir }, firstRunComplete: S.settings.get('general').firstRunComplete, secrets: S.secrets.status(), license: S.license }));
  def('app.license', 'read', none, async () => {
    const fsp = require('node:fs/promises');
    const path = require('node:path');
    const read = (f) => fsp.readFile(f, 'utf8').catch(() => null);
    const base = S.paths.appInstallDir;
    const resources = process.resourcesPath || base;
    return { ...S.license, text: await read(S.license.file), thirdParty: (await read(path.join(resources, 'THIRD_PARTY_NOTICES.md'))) || (await read(path.join(base, 'THIRD_PARTY_NOTICES.md'))) };
  });
  def('dashboard.overview', 'read', none, async () => {
    const out = [];
    for (const srv of S.registry.list()) out.push(await S.serverSummary(srv));
    return { servers: out, unread: S.notifications.unreadCount(), updates: S.updates.lastCheck ? S.updates.lastCheck.at : null };
  });

  // ---------------------------------------------------------------- servers
  def('servers.list', 'read', none, () => S.registry.list().map((s) => ({ id: s.id, name: s.name, group: s.group, installDir: s.installDir, config: { ...s.config, api: { hasToken: s.config.api.hasToken, tokenKind: s.config.api.tokenKind, pinned: !!s.config.api.pin } } })));
  def('servers.get', 'read', sid, async ({ serverId }) => S.serverSummary(S.registry.get(serverId), { full: true }));
  def('servers.create', 'local', v.object({ name: name(), group: v.optional(v.string({ max: 60 })), installDir: v.absPath(), config: v.optional(v.json()) }), (p, c) => S.registry.create(p, c.actor));
  def('servers.update', 'configure', v.object({ serverId: v.id(), name: v.optional(name()), group: v.optional(v.string({ max: 60 })), config: v.optional(v.json()) }), async ({ serverId, ...rest }, c) => {
    const res = S.registry.update(serverId, rest, { actor: c.actor });
    return { changes: res.changes, restartRequired: res.changes.some((x) => x.effect === 'restart') && S.supervisor.isActive(serverId) };
  });
  def('servers.applyLiveOptions', 'configure', v.object({ serverId: v.id(), options: v.record(v.oneOf(v.bool(), v.int({ min: 0, max: 86400 })), { maxKeys: 10, keyPattern: /^FG\.[A-Za-z]+$/ }) }), async ({ serverId, options }, c) => {
    S.registry.update(serverId, { config: { serverOptions: options } }, { actor: c.actor, reason: 'live options' });
    const opts = Object.fromEntries(Object.entries(options).map(([k, x]) => [k, typeof x === 'boolean' ? String(x) : String(x)]));
    await S.supervisor.api(serverId).applyOptions(opts);
    return { applied: Object.keys(opts) };
  });
  def('servers.liveOptions', 'read', sid, async ({ serverId }) => {
    const r = await S.supervisor.api(serverId).getOptions();
    return { known: SERVER_OPTION_KEYS, current: r.data ? r.data.serverOptions : null, pending: r.data ? r.data.pendingServerOptions : null };
  });
  def('servers.remove', 'local', v.object({ serverId: v.id(), confirm: v.bool() }), ({ serverId, confirm: ok }, c) => {
    if (!ok) throw new AppError('E_CONFIRM_REQUIRED', 'Confirmation required');
    if (S.supervisor.isActive(serverId)) throw new AppError('E_SERVER_RUNNING', 'Stop the server first.');
    S.registry.remove(serverId, c.actor);
    S.secrets.delete(S.supervisor.tokenKey(serverId));
    return { removed: true, filesKept: true };
  });
  def('servers.reorder', 'configure', v.object({ ids: v.array(v.id(), { max: 200 }) }), ({ ids }) => S.registry.reorder(ids));
  def('servers.start', 'control', sid, ({ serverId }, c) => S.supervisor.start(serverId, { trigger: 'manual', actor: c.actor }));
  def('servers.stop', 'control', v.object({ serverId: v.id(), force: v.optional(v.bool()) }), ({ serverId, force }, c) => S.supervisor.stop(serverId, { force: !!force, actor: c.actor }));
  def('servers.restart', 'control', sid, ({ serverId }, c) => S.supervisor.restart(serverId, { actor: c.actor }));
  def('servers.status', 'read', sid, ({ serverId }) => S.supervisor.status(serverId));
  def('servers.history', 'read', sid, ({ serverId }) => S.registry.history(serverId));
  def('servers.restoreHistory', 'configure', v.object({ serverId: v.id(), historyId: v.int({ min: 1 }) }), ({ serverId, historyId }, c) => S.profiles.restoreHistory(serverId, historyId, c.actor).changes);
  def('servers.runs', 'read', sid, ({ serverId }) => S.benchmarks.runs(serverId));
  def('servers.connectionInfo', 'read', sid, ({ serverId }) => S.connectionInfo(serverId));
  def('servers.exportInfo', 'read', sid, async ({ serverId }) => S.exportServerInfo(serverId));
  def('servers.setMaintenance', 'configure', v.object({ serverId: v.id(), enabled: v.bool(), reason: v.optional(v.string({ max: 300 })) }), ({ serverId, enabled, reason }, c) => {
    S.registry.update(serverId, { config: { maintenance: { enabled, reason: reason || '' } } }, { actor: c.actor, reason: 'maintenance' });
    const srv = S.registry.get(serverId);
    S.notifications.notify({ category: 'maintenance', severity: 'info', title: `${srv.name}: maintenance ${enabled ? 'enabled' : 'ended'}`, body: enabled ? (reason || 'Automatic restarts, updates and scheduled tasks are paused.') : 'Automation resumed.', serverId });
    return srv.config.maintenance;
  });
  def('servers.cancelRecovery', 'control', sid, ({ serverId }, c) => { S.supervisor.cancelRecovery(serverId, c.actor); return S.supervisor.status(serverId); });
  def('servers.crashes', 'read', sid, ({ serverId }) => S.db.all('SELECT * FROM crashes WHERE server_id = ? ORDER BY at DESC LIMIT 100', serverId).map((r) => ({ ...r, evidence: r.evidence ? JSON.parse(r.evidence) : [] })));
  def('servers.players', 'read', sid, ({ serverId }) => S.playerInfo(serverId));
  def('servers.suggestPorts', 'read', none, () => S.registry.suggestPorts());
  def('servers.saves', 'read', sid, ({ serverId }) => S.backups.listSaves(serverId));
  def('servers.sessions', 'read', sid, async ({ serverId }) => (await S.supervisor.api(serverId).enumerateSessions()).data);
  def('servers.validateConfig', 'read', sid, async ({ serverId }) => S.diagnostics.run(serverId, { only: ['config', 'ports', 'files'] }));
  def('servers.repairInstall', 'control', sid, ({ serverId }, c) => S.updates.updateServer(serverId, { actor: c.actor, trigger: 'repair', validateOnly: true }));
  def('servers.installFiles', 'local', sid, ({ serverId }, c) => S.updates.updateServer(serverId, { actor: c.actor, trigger: 'install', validateOnly: true }));

  // ---------------------------------------------------------------- console
  def('console.snapshot', 'read', v.object({ serverId: v.id(), sinceSeq: v.optional(v.int({ min: 0 })) }), ({ serverId, sinceSeq }) => S.supervisor.consoleSnapshot(serverId, { sinceSeq }));
  def('console.send', 'control', v.object({ serverId: v.id(), command: v.string({ min: 1, max: 500 }) }), ({ serverId, command }, c) => S.supervisor.sendCommand(serverId, command, { actor: c.actor }));
  def('console.runLog', 'read', v.object({ runId: v.int({ min: 1 }) }), ({ runId }) => S.supervisor.runLog(runId));
  def('console.suggestions', 'read', none, () => ({ documented: [{ command: 'server.GenerateAPIToken', help: 'Generates a new API token (shown in the output).' }, { command: 'server.InvalidateAPITokens', help: 'Invalidates all previously generated API tokens.' }], note: 'Commands are passed to the server unchanged. With API access they are sent through the documented RunCommand function.' }));

  // ---------------------------------------------------------------- access / credentials
  def('access.status', 'read', sid, ({ serverId }) => S.access.status(serverId));
  def('access.claim', 'local', v.object({ serverId: v.id(), serverName: name(), adminPassword: v.string({ min: 8, max: 128 }) }), (p, c) => S.access.claim(p.serverId, { ...p, actor: c.actor }));
  def('access.login', 'local', v.object({ serverId: v.id(), adminPassword: v.string({ min: 1, max: 128 }) }), (p, c) => S.access.login(p.serverId, { ...p, actor: c.actor }));
  def('access.setToken', 'local', v.object({ serverId: v.id(), token: v.string({ min: 20, max: 4096, pattern: /^[A-Za-z0-9._~+/=-]+$/ }) }), (p, c) => S.access.setToken(p.serverId, { ...p, actor: c.actor }));
  def('access.setClientPassword', 'local', v.object({ serverId: v.id(), password: v.string({ max: 128 }) }), (p, c) => S.access.setClientPassword(p.serverId, { ...p, actor: c.actor }));
  def('access.forget', 'local', sid, ({ serverId }, c) => S.access.forget(serverId, c.actor));
  def('access.resetPin', 'local', v.object({ serverId: v.id(), confirm: v.bool() }), ({ serverId, confirm: ok }, c) => { if (!ok) throw new AppError('E_CONFIRM_REQUIRED', 'Confirm'); return S.access.resetPin(serverId, c.actor); });

  // ---------------------------------------------------------------- health / performance
  def('health.indicators', 'read', sid, ({ serverId }) => S.health.indicators(serverId));
  def('health.history', 'read', v.object({ serverId: v.id(), rangeMs: v.int({ min: 60000, max: 3650 * 86400000 }), points: v.optional(v.int({ min: 10, max: 2000 })) }), ({ serverId, ...o }) => S.health.history(serverId, o));
  def('bench.list', 'read', sid, ({ serverId }) => S.benchmarks.list(serverId));
  def('bench.start', 'control', v.object({ serverId: v.id(), name: name(), durationMinutes: v.int({ min: 1, max: 1440 }) }), ({ serverId, ...o }, c) => S.benchmarks.start(serverId, o, c.actor));
  def('bench.finish', 'control', v.object({ id: v.id() }), ({ id }) => S.benchmarks.finish(id));
  def('bench.remove', 'configure', v.object({ id: v.id() }), ({ id }) => S.benchmarks.remove(id));
  def('bench.timings', 'read', sid, ({ serverId }) => S.benchmarks.timings(serverId));
  def('bench.csv', 'read', v.object({ id: v.id() }), ({ id }) => S.benchmarks.toCsv(id));

  // ---------------------------------------------------------------- backups
  def('backups.list', 'read', v.optional(v.object({ serverId: v.optional(v.id()) })), (p = {}) => S.backups.list(p));
  def('backups.create', 'control', v.object({ serverId: v.id(), note: v.optional(v.string({ max: 300 })) }), ({ serverId, note }, c) => S.backups.create(serverId, { type: 'manual', note, actor: c.actor }));
  def('backups.validate', 'control', v.object({ id: v.id() }), ({ id }, c) => S.backups.validate(id, c.actor));
  def('backups.contents', 'read', v.object({ id: v.id() }), ({ id }) => S.backups.contents(id));
  def('backups.restore', 'control', v.object({ id: v.id(), confirm: v.bool(), includeConfig: v.optional(v.bool()), includeSaves: v.optional(v.bool()) }), ({ id, ...o }, c) => S.backups.restore(id, { ...o, actor: c.actor }));
  def('backups.remove', 'configure', v.object({ id: v.id(), confirm: v.bool() }), ({ id, confirm: ok }, c) => S.backups.remove(id, { confirm: ok, actor: c.actor }));
  def('backups.export', 'local', v.object({ id: v.id(), dest: v.absPath() }), ({ id, dest }, c) => S.backups.exportTo(id, dest, c.actor));
  def('backups.importSave', 'local', v.object({ serverId: v.id(), file: v.absPath(), overwrite: v.optional(v.bool()) }), ({ serverId, file, overwrite }, c) => S.backups.importSave(serverId, file, { overwrite, actor: c.actor }));
  def('backups.rescan', 'control', sid, ({ serverId }) => S.backups.rescan(serverId));

  // ---------------------------------------------------------------- scheduler
  const taskInput = v.json();
  def('tasks.list', 'read', none, () => ({ tasks: S.scheduler.list(), types: TASK_TYPES, timezone: S.settings.get('scheduler').timezone }));
  def('tasks.create', 'configure', taskInput, (p, c) => S.scheduler.create(p, c.actor));
  def('tasks.update', 'configure', v.object({ id: v.id(), patch: v.json() }), ({ id, patch }, c) => S.scheduler.update(id, patch, c.actor));
  def('tasks.remove', 'configure', v.object({ id: v.id() }), ({ id }, c) => S.scheduler.remove(id, c.actor));
  def('tasks.runNow', 'control', v.object({ id: v.id() }), ({ id }, c) => S.scheduler.runNow(id, c.actor));
  def('tasks.history', 'read', v.object({ id: v.optional(v.id()) }), ({ id }) => S.scheduler.history(id));
  def('tasks.preview', 'read', v.object({ cron: v.string({ max: 100 }), timezone: v.timezone() }), ({ cron, timezone }) => S.scheduler.preview(cron, timezone));
  def('tasks.timezones', 'read', none, () => (Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [S.settings.get('scheduler').timezone]));

  // ---------------------------------------------------------------- updates
  def('updates.overview', 'read', none, async () => ({ servers: await Promise.all(S.registry.list().map(async (s) => ({ ...(await S.updates.serverStatus(s.id)), name: s.name, policy: S.updates.policyFor(s) }))), lastCheck: S.updates.lastCheck, app: S.updates.appRelease, steamcmd: await S.steamcmd.status(), policies: S.settings.get('updates') }));
  def('updates.check', 'control', none, () => S.updates.checkAll({ notify: true }));
  def('updates.updateServer', 'control', v.object({ serverId: v.id(), onlyIfEmpty: v.optional(v.bool()) }), ({ serverId, onlyIfEmpty }, c) => S.updates.updateServer(serverId, { actor: c.actor, onlyIfEmpty }));
  def('updates.rollback', 'control', v.object({ serverId: v.id(), confirm: v.bool() }), ({ serverId, confirm: ok }, c) => S.updates.rollback(serverId, { actor: c.actor, confirm: ok }));
  def('updates.history', 'read', v.object({ serverId: v.optional(v.id()) }), ({ serverId }) => S.updates.history(serverId));
  def('updates.steamcmdSelfUpdate', 'control', none, () => S.steamcmd.selfUpdate());

  // ---------------------------------------------------------------- mods
  def('mods.search', 'read', v.object({ search: v.optional(v.string({ max: 100 })), offset: v.optional(v.int({ min: 0, max: 10000 })), orderBy: v.optional(v.enum(['popularity', 'downloads', 'last_version_date', 'name', 'hotness'])) }), (p) => S.mods.search(p));
  def('mods.get', 'read', v.object({ reference: ref(), serverId: v.optional(v.id()) }), async ({ reference, serverId }) => {
    const mod = await S.mods.getMod(reference);
    const netCL = serverId ? S.registry.get(serverId).config.cache.netCL : null;
    return { ...mod, versions: mod.versions.map((x) => ({ ...x, compat: S.mods.versionCompat(x, netCL) })), target: layout.MOD_TARGET, netCL };
  });
  def('mods.installed', 'read', sid, ({ serverId }) => S.mods.analyze(serverId));
  def('mods.compatibility', 'read', sid, ({ serverId }) => S.mods.compatibility(serverId));
  def('mods.resolve', 'read', v.object({ serverId: v.id(), requests: v.array(v.object({ reference: ref(), version: v.optional(v.string({ max: 40 })) }), { min: 1, max: 100 }) }), ({ serverId, requests }) => S.mods.resolve(serverId, requests));
  def('mods.apply', 'configure', v.object({ serverId: v.id(), requests: v.array(v.object({ reference: ref(), version: v.optional(v.string({ max: 40 })) }), { min: 1, max: 100 }) }), ({ serverId, requests }, c) => S.mods.apply(serverId, requests, { actor: c.actor }));
  def('mods.remove', 'configure', v.object({ serverId: v.id(), reference: ref(), force: v.optional(v.bool()) }), ({ serverId, reference, force }, c) => S.mods.remove(serverId, reference, { actor: c.actor, force }));
  def('mods.history', 'read', sid, ({ serverId }) => S.mods.history(serverId));
  def('mods.rollback', 'configure', v.object({ historyId: v.int({ min: 1 }) }), ({ historyId }, c) => S.mods.rollback(historyId, { actor: c.actor }));
  def('mods.integrity', 'read', sid, ({ serverId }) => S.mods.integrity(serverId));
  def('mods.checkUpdates', 'read', sid, ({ serverId }) => S.mods.checkUpdates(serverId));
  def('mods.updateAll', 'configure', sid, ({ serverId }, c) => S.mods.updateAll(serverId, { actor: c.actor }));
  def('mods.profiles', 'read', none, () => S.mods.listProfiles());
  def('mods.saveProfile', 'configure', v.object({ serverId: v.id(), name: name() }), ({ serverId, name: n }) => S.mods.saveProfile(serverId, n));
  def('mods.deleteProfile', 'configure', v.object({ id: v.id() }), ({ id }) => S.mods.deleteProfile(id));
  def('mods.compareProfiles', 'read', v.object({ a: v.id(), b: v.optional(v.id()), serverId: v.optional(v.id()) }), async ({ a, b, serverId }) => S.mods.compareProfiles(a, b || (await S.mods.profileFromServer(serverId))));
  def('mods.applyProfile', 'configure', v.object({ serverId: v.id(), profileId: v.id() }), ({ serverId, profileId }, c) => S.mods.applyProfile(serverId, profileId, { actor: c.actor }));

  // ---------------------------------------------------------------- profiles & templates
  def('profiles.list', 'read', none, () => S.profiles.list());
  def('profiles.save', 'configure', v.object({ serverId: v.id(), name: name(), description: v.optional(v.string({ max: 500 })) }), ({ serverId, ...o }, c) => S.profiles.saveFromServer(serverId, o, c.actor));
  def('profiles.duplicate', 'configure', v.object({ id: v.id(), name: v.optional(name()) }), ({ id, name: n }, c) => S.profiles.duplicate(id, n, c.actor));
  def('profiles.rename', 'configure', v.object({ id: v.id(), name: v.optional(name()), description: v.optional(v.string({ max: 500 })) }), ({ id, ...o }) => S.profiles.rename(id, o));
  def('profiles.remove', 'configure', v.object({ id: v.id() }), ({ id }, c) => S.profiles.remove(id, c.actor));
  def('profiles.compare', 'read', v.object({ profileId: v.id(), serverId: v.optional(v.id()), otherProfileId: v.optional(v.id()) }), (p) => S.profiles.compare(p));
  def('profiles.apply', 'configure', v.object({ serverId: v.id(), profileId: v.id() }), ({ serverId, profileId }, c) => S.profiles.apply(serverId, profileId, { actor: c.actor }));
  def('profiles.export', 'read', v.object({ id: v.id() }), ({ id }) => S.profiles.exportProfile(id));
  def('profiles.import', 'configure', v.object({ document: v.json() }), ({ document }, c) => S.profiles.importProfile(document, c.actor));
  def('templates.list', 'read', none, () => S.profiles.listTemplates());
  def('templates.save', 'configure', v.object({ serverId: v.id(), name: name(), description: v.optional(v.string({ max: 500 })), includeMods: v.optional(v.bool()) }), ({ serverId, ...o }, c) => S.profiles.saveTemplate(serverId, o, c.actor));
  def('templates.update', 'configure', v.object({ id: v.id(), name: v.optional(name()), description: v.optional(v.string({ max: 500 })), config: v.optional(v.json()) }), ({ id, ...o }, c) => S.profiles.updateTemplateDefaults(id, o, c.actor));
  def('templates.remove', 'configure', v.object({ id: v.id() }), ({ id }, c) => S.profiles.removeTemplate(id, c.actor));
  def('templates.createServer', 'local', v.object({ id: v.id(), name: name(), installDir: v.absPath() }), ({ id, ...o }, c) => S.profiles.createServerFromTemplate(id, o, c.actor));
  def('templates.duplicateServer', 'local', v.object({ serverId: v.id(), name: name(), installDir: v.absPath() }), ({ serverId, ...o }, c) => S.profiles.duplicateServer(serverId, o, c.actor));
  def('templates.export', 'read', v.object({ id: v.id() }), ({ id }) => S.profiles.exportTemplate(id));
  def('templates.import', 'configure', v.object({ document: v.json() }), ({ document }, c) => S.profiles.importTemplate(document, c.actor));

  // ---------------------------------------------------------------- diagnostics / storage / audit / notifications
  def('diagnostics.run', 'control', v.object({ serverId: v.optional(v.id()) }), ({ serverId }) => S.diagnostics.run(serverId));
  def('diagnostics.repair', 'local', v.object({ serverId: v.optional(v.id()), finding: v.json(), confirm: confirm }), ({ serverId, finding, confirm: ok }, c) => S.diagnostics.repair(serverId, finding, { confirm: ok, actor: c.actor }));
  def('diagnostics.export', 'local', v.object({ serverId: v.id(), dest: v.absPath() }), ({ serverId, dest }) => S.diagnostics.exportReport(serverId, dest));
  def('storage.analyze', 'read', none, () => S.storage.analyze());
  def('storage.cleanup', 'configure', v.object({ id: v.string({ max: 100 }), confirm: v.bool() }), ({ id, confirm: ok }, c) => S.storage.cleanup(id, { confirm: ok, actor: c.actor }));
  def('audit.list', 'read', v.object({ limit: v.optional(v.int({ min: 1, max: 1000 })), before: v.optional(v.int({ min: 1 })), serverId: v.optional(v.id()), action: v.optional(v.string({ max: 60 })), result: v.optional(v.enum(['ok', 'failed'])), search: v.optional(v.string({ max: 100 })) }), (p) => S.audit.list(p));
  def('notifications.list', 'read', v.object({ unreadOnly: v.optional(v.bool()), category: v.optional(v.string({ max: 40 })), severity: v.optional(v.string({ max: 20 })), serverId: v.optional(v.id()) }), (p) => ({ items: S.notifications.list(p), unread: S.notifications.unreadCount(), categories: CATEGORIES }));
  def('notifications.markRead', 'read', v.object({ ids: v.oneOf(v.enum(['all']), v.array(v.int({ min: 1 }), { max: 1000 })), read: v.optional(v.bool()) }), ({ ids, read }) => S.notifications.markRead(ids, read !== false));
  def('notifications.remove', 'configure', v.object({ ids: v.oneOf(v.enum(['all']), v.array(v.int({ min: 1 }), { max: 1000 })) }), ({ ids }) => S.notifications.remove(ids));

  // ---------------------------------------------------------------- settings / startup / firewall
  def('settings.get', 'read', none, () => { const s = S.settings.get(); return s; });
  def('settings.update', 'local', v.object({ section: v.string({ max: 40 }), patch: v.json() }), async ({ section, patch }, c) => {
    const res = S.settings.update(section, patch);
    S.audit.record({ actor: c.actor, action: 'settings.update', target: section, details: patch });
    if (section === 'web' || section === 'remote') await S.web.apply().catch((e) => { throw new AppError('E_WEB', `Saved, but the web server could not start: ${e.message}`); });
    if (section === 'scheduler') S.scheduler.recompute();
    if (section === 'startup' && patch.launchAtLogin !== undefined) S.startup.setLaunchAtLogin(patch.launchAtLogin, c.actor);
    return res;
  });
  def('startup.status', 'read', none, () => S.startup.status());
  def('firewall.inspect', 'read', sid, ({ serverId }) => firewall.inspect(S.registry.get(serverId)));
  def('firewall.create', 'local', v.object({ serverId: v.id(), confirm: v.bool() }), async ({ serverId, confirm: ok }, c) => {
    if (!ok) throw new AppError('E_CONFIRM_REQUIRED', 'Confirm');
    const srv = S.registry.get(serverId);
    return S.audit.wrap({ actor: c.actor, action: 'firewall.create', serverId, target: srv.name }, () => firewall.createRules(srv));
  });
  def('firewall.remove', 'local', v.object({ serverId: v.id(), confirm: v.bool() }), async ({ serverId, confirm: ok }, c) => {
    if (!ok) throw new AppError('E_CONFIRM_REQUIRED', 'Confirm');
    const srv = S.registry.get(serverId);
    return S.audit.wrap({ actor: c.actor, action: 'firewall.remove', serverId, target: srv.name }, () => firewall.removeRules(srv));
  });
  def('files.readJson', 'local', v.object({ file: v.absPath() }), async ({ file }) => {
    if (!/\.json$/i.test(file)) throw new AppError('E_VALIDATION', 'Only .json files can be imported.');
    const st = await require('node:fs/promises').stat(file);
    if (st.size > 2 * 1024 * 1024) throw new AppError('E_VALIDATION', 'The file is too large (max 2 MB).');
    try { return JSON.parse(await require('node:fs/promises').readFile(file, 'utf8')); } catch { throw new AppError('E_VALIDATION', 'The file is not valid JSON.'); }
  });
  def('system.info', 'read', none, async () => ({ os: sys.windowsInfo(), hardware: sys.hardware(), lan: sys.lanAddresses(), vcRuntime: await sys.vcRuntime() }));

  // ---------------------------------------------------------------- migration (desktop only: file paths)
  def('migration.export', 'local', v.object({ serverId: v.id(), dest: v.absPath(), includeServerFiles: v.optional(v.bool()), includeBackups: v.optional(v.bool()), passphrase: v.optional(v.string({ max: 256 })) }), ({ serverId, dest, ...o }, c) => S.migration.exportServer(serverId, dest, { ...o, actor: c.actor }));
  def('migration.inspect', 'local', v.object({ file: v.absPath(), passphrase: v.optional(v.string({ max: 256 })) }), ({ file, passphrase }) => S.migration.inspect(file, { passphrase }));
  def('migration.import', 'local', v.object({ file: v.absPath(), targetDir: v.absPath(), name: v.optional(name()), passphrase: v.optional(v.string({ max: 256 })), overwriteSaves: v.optional(v.bool()) }), ({ file, ...o }, c) => S.migration.importServer(file, { ...o, actor: c.actor }));
  def('migration.move', 'local', v.object({ serverId: v.id(), newDir: v.absPath(), deleteOld: v.optional(v.bool()) }), ({ serverId, newDir, deleteOld }, c) => S.migration.moveServer(serverId, newDir, { deleteOld, actor: c.actor }));
  def('migration.notMigrated', 'read', none, () => S.migration.notMigrated());

  // ---------------------------------------------------------------- web dashboard / remote management (desktop only)
  def('web.status', 'local', none, () => ({ ...S.web.info, users: S.web.users(), sessions: S.web.sessions.list() }));
  def('web.addUser', 'local', v.object({ username: v.string({ min: 3, max: 32, pattern: /^[A-Za-z0-9_.-]+$/ }), password: v.string({ max: 256 }), role: v.enum(['admin', 'viewer']) }), (p, c) => S.web.addUser(p, c.actor));
  def('web.setPassword', 'local', v.object({ id: v.id(), password: v.string({ max: 256 }) }), ({ id, password }, c) => S.web.setPassword(id, password, c.actor));
  def('web.removeUser', 'local', v.object({ id: v.id() }), ({ id }, c) => S.web.removeUser(id, c.actor));
  def('remote.agentStatus', 'local', none, () => ({ ...S.web.info, devices: S.web.devices(), pairing: S.web.pairing ? { expires: S.web.pairing.expires } : null }));
  def('remote.createPairingCode', 'local', none, (p, c) => S.web.createPairingCode(c.actor));
  def('remote.revokeDevice', 'local', v.object({ id: v.id() }), ({ id }, c) => S.web.revokeDevice(id, c.actor));
  def('remote.machines', 'local', none, () => S.remote.list());
  def('remote.probe', 'local', v.object({ host: v.hostname(), port: v.port() }), ({ host, port }) => S.remote.probe(host, port));
  def('remote.pair', 'local', v.object({ host: v.hostname(), port: v.port(), fingerprint: v.string({ min: 95, max: 95, pattern: /^[0-9A-F:]+$/ }), code: v.string({ min: 11, max: 11 }), name: v.optional(name()) }), (p, c) => S.remote.pair(p, c.actor));
  def('remote.ping', 'local', v.object({ id: v.id() }), ({ id }) => S.remote.ping(id));
  def('remote.call', 'local', v.object({ id: v.id(), channel: v.string({ max: 60 }), payload: v.optional(v.json()) }), ({ id, channel, payload }, c) => S.remote.call(id, channel, payload || {}, c.actor));
  def('remote.remove', 'local', v.object({ id: v.id() }), ({ id }, c) => S.remote.remove(id, c.actor));

  // ---------------------------------------------------------------- setup wizard (desktop only)
  def('setup.state', 'local', none, () => S.setup.state());
  def('setup.goTo', 'local', v.object({ step: v.string({ max: 20 }) }), ({ step }) => S.setup.goTo(step));
  def('setup.scan', 'local', none, () => S.setup.scan());
  def('setup.validateLocation', 'local', v.object({ dir: v.string({ min: 1, max: 1024 }), mode: v.optional(v.enum(['new', 'attach'])) }), ({ dir, mode }) => S.setup.validateLocation(dir, mode));
  def('setup.confirmLocation', 'local', v.object({ dir: v.absPath(), name: name(), branch: v.string({ min: 1, max: 64, pattern: /^[A-Za-z0-9_.-]+$/ }), mode: v.optional(v.enum(['new', 'attach'])), confirmed: v.bool() }), (p) => S.setup.confirmLocation(p));
  def('setup.branches', 'local', none, () => S.setup.branches());
  def('setup.installDependencies', 'local', v.object({ installVcRedist: v.optional(v.bool()) }), (p) => S.setup.installDependencies(p));
  def('setup.installServer', 'local', v.object({ repair: v.optional(v.bool()) }), (p) => S.setup.installServer(p));
  def('setup.cancel', 'local', none, () => S.setup.cancel());
  def('setup.cleanup', 'local', v.object({ confirm: v.bool(), removeServer: v.optional(v.bool()) }), (p) => S.setup.cleanup(p));
  def('setup.network', 'local', none, () => S.setup.network());
  def('setup.changePorts', 'local', v.object({ port: v.port(), reliablePort: v.port() }), (p) => S.setup.changePorts(p));
  def('setup.configureFirewall', 'local', v.object({ confirm: v.bool() }), (p) => S.setup.configureFirewall(p));
  def('setup.completeNetwork', 'local', v.object({ skipReason: v.optional(v.string({ max: 200 })) }), (p) => S.setup.completeNetwork(p));
  def('setup.startForSecurity', 'local', none, () => S.setup.startForSecurity());
  def('setup.accessStatus', 'local', none, () => S.setup.accessStatus());
  def('setup.claim', 'local', v.object({ serverName: name(), adminPassword: v.string({ min: 8, max: 128 }), clientPassword: v.optional(v.string({ max: 128 })) }), (p) => S.setup.claim(p));
  def('setup.login', 'local', v.object({ adminPassword: v.string({ min: 1, max: 128 }) }), (p) => S.setup.login(p));
  def('setup.skipSecurity', 'local', v.object({ reason: v.optional(v.string({ max: 200 })) }), ({ reason }) => S.setup.skipSecurity(reason));
  def('setup.review', 'local', none, () => S.setup.review());
  def('setup.finish', 'local', v.object({ startServer: v.optional(v.bool()), autoStart: v.optional(v.bool()) }), (p) => S.setup.finish(p));
  def('setup.reset', 'local', none, () => S.setup.reset());
  def('setup.existing', 'local', none, () => sys.findExistingInstalls(S.registry));

  return C;
}

const LEVEL_FOR = {
  web: { viewer: new Set(['read']), admin: new Set(['read', 'control', 'configure']) },
};

class Rpc {
  constructor(ctx) { this.ctx = ctx; this.channels = buildChannels(ctx); }

  isReadOnly(channel) { const c = this.channels[channel]; return !!c && c.level === 'read'; }

  /** Validate, authorise and run a channel. caller = { transport: 'ipc'|'web'|'remote', role?, scopes?, actor } */
  async dispatch(channel, payload, caller) {
    const c = typeof channel === 'string' && Object.prototype.hasOwnProperty.call(this.channels, channel) ? this.channels[channel] : null;
    if (!c) throw new AppError('E_NOT_FOUND', `Unknown operation: ${String(channel).slice(0, 60)}`);
    if (caller.transport === 'web') {
      const allowed = LEVEL_FOR.web[caller.role] || new Set();
      if (!allowed.has(c.level)) throw new AppError('E_FORBIDDEN', c.level === 'local' ? 'This action is only available in the desktop application.' : 'Your account is not allowed to perform this action.');
    } else if (caller.transport === 'remote') {
      if (c.level === 'local' || !(caller.scopes || []).includes(c.level)) throw new AppError('E_FORBIDDEN', 'This action is not available to remote managers.');
    } else if (caller.transport !== 'ipc') throw new AppError('E_FORBIDDEN', 'Unknown caller');
    const input = c.schema(payload === undefined || payload === null ? (c.schema.optionalMarker ? undefined : {}) : payload, 'payload');
    return c.handler(input === undefined ? {} : input, caller);
  }
}

module.exports = { Rpc, buildChannels };
