'use strict';
/**
 * Server registry: CRUD for configured server installations and the schema of
 * a server's configuration. Settings are categorised by how they take effect:
 *   - launch / ini     → written to command line / INI files, need a restart
 *   - serverOptions    → applied live through the HTTPS API (no restart)
 *   - manager          → manager behaviour (recovery, maintenance), immediate
 */
const path = require('node:path');
const { v } = require('../core/validate');
const { newId, AppError } = require('../core/util');
const { isInside } = require('../core/fsutil');

const EXTRA_ARG_RE = /^-[A-Za-z][A-Za-z0-9_.]*(=[^\s"'`;&|<>]{0,200})?$/;

const DEFAULT_CONFIG = () => ({
  branch: 'public',
  launch: { port: 7777, reliablePort: 8888, multihome: '', disableSeasonalEvents: false, extraArgs: [] },
  ini: { maxPlayers: 4, autosaveCount: 5 },
  serverOptions: {},
  api: { host: '127.0.0.1', pin: null, hasToken: false, tokenKind: null },
  saveRoot: '',
  recovery: { enabled: true, maxAttempts: 3, windowMinutes: 30, cooldownSeconds: 30, backoffMultiplier: 2, collectDiagnostics: true },
  shutdown: { saveBeforeStop: true, graceSeconds: 90 },
  maintenance: { enabled: false, reason: '', since: null },
  updates: { policy: 'inherit', keepRollbackCopy: null },
  mods: { updatePolicy: 'inherit' },
  connection: { publicAddress: '' },
  notes: '',
  cache: { netCL: null, netCLBuildId: null },
});

/** Server options supported by ApplyServerOptions (applied immediately). */
const SERVER_OPTION_KEYS = {
  'FG.DSAutoPause': { label: 'Pause when no players are connected', type: 'bool' },
  'FG.DSAutoSaveOnDisconnect': { label: 'Autosave when a player disconnects', type: 'bool' },
  'FG.AutosaveInterval': { label: 'Autosave interval (seconds)', type: 'int', min: 60, max: 86400 },
  'FG.ServerRestartTimeSlot': { label: 'Daily in-game restart time slot (minutes after midnight, server time)', type: 'int', min: 0, max: 1440 },
  'FG.SendGameplayData': { label: 'Send gameplay data to Coffee Stain', type: 'bool' },
  'FG.NetworkQuality': { label: 'Network quality (0 low – 3 ultra)', type: 'int', min: 0, max: 3 },
};

const SETTING_EFFECT = {
  'launch.port': 'restart', 'launch.reliablePort': 'restart', 'launch.multihome': 'restart', 'launch.disableSeasonalEvents': 'restart', 'launch.extraArgs': 'restart',
  'ini.maxPlayers': 'restart', 'ini.autosaveCount': 'restart', branch: 'update', saveRoot: 'restart',
  recovery: 'immediate', shutdown: 'immediate', maintenance: 'immediate', updates: 'immediate', mods: 'immediate', connection: 'immediate', notes: 'immediate', serverOptions: 'live',
};

const configSchema = v.object({
  branch: v.optional(v.string({ min: 1, max: 64, pattern: /^[A-Za-z0-9_.-]+$/ })),
  launch: v.optional(v.object({
    port: v.optional(v.port()), reliablePort: v.optional(v.port()),
    multihome: v.optional(v.oneOf(v.enum(['']), v.hostname())),
    disableSeasonalEvents: v.optional(v.bool()),
    extraArgs: v.optional(v.array(v.string({ max: 220, pattern: EXTRA_ARG_RE }), { max: 30 })),
  })),
  ini: v.optional(v.object({ maxPlayers: v.optional(v.int({ min: 1, max: 127 })), autosaveCount: v.optional(v.int({ min: 1, max: 100 })) })),
  serverOptions: v.optional(v.record(v.oneOf(v.bool(), v.number(), v.string({ max: 64 })), { maxKeys: 20, keyPattern: /^FG\.[A-Za-z]+$/ })),
  saveRoot: v.optional(v.oneOf(v.enum(['']), v.absPath())),
  recovery: v.optional(v.object({ enabled: v.optional(v.bool()), maxAttempts: v.optional(v.int({ min: 0, max: 20 })), windowMinutes: v.optional(v.int({ min: 1, max: 1440 })), cooldownSeconds: v.optional(v.int({ min: 5, max: 3600 })), backoffMultiplier: v.optional(v.number({ min: 1, max: 10 })), collectDiagnostics: v.optional(v.bool()) })),
  shutdown: v.optional(v.object({ saveBeforeStop: v.optional(v.bool()), graceSeconds: v.optional(v.int({ min: 10, max: 900 })) })),
  maintenance: v.optional(v.object({ enabled: v.optional(v.bool()), reason: v.optional(v.string({ max: 300 })) })),
  updates: v.optional(v.object({ policy: v.optional(v.enum(['inherit', 'off', 'notify', 'window', 'scheduled'])), keepRollbackCopy: v.optional(v.nullable(v.bool())) })),
  mods: v.optional(v.object({ updatePolicy: v.optional(v.enum(['inherit', 'off', 'notify', 'window', 'scheduled'])) })),
  connection: v.optional(v.object({ publicAddress: v.optional(v.oneOf(v.enum(['']), v.hostname())) })),
  notes: v.optional(v.string({ max: 4000 })),
});

function validateServerOptions(opts) {
  const out = {};
  for (const [k, val] of Object.entries(opts || {})) {
    const def = SERVER_OPTION_KEYS[k];
    if (!def) throw new AppError('E_VALIDATION', `Unsupported server option ${k}`);
    if (def.type === 'bool') { if (typeof val !== 'boolean') throw new AppError('E_VALIDATION', `${k} must be true/false`); out[k] = val; }
    if (def.type === 'int') { const n = Number(val); if (!Number.isInteger(n) || n < def.min || n > def.max) throw new AppError('E_VALIDATION', `${k} must be an integer between ${def.min} and ${def.max}`); out[k] = n; }
  }
  return out;
}

function deepMerge(base, patch) {
  const out = structuredClone(base);
  for (const [k, val] of Object.entries(patch || {})) {
    if (val && typeof val === 'object' && !Array.isArray(val) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = deepMerge(out[k], val);
    else out[k] = structuredClone(val);
  }
  return out;
}

/** Flattened diff of two configs: [{ key, before, after, effect }] */
function diffConfigs(a, b, prefix = '') {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  const out = [];
  for (const k of keys) {
    if (['api', 'cache'].includes(k) && !prefix) continue;
    const key = prefix ? `${prefix}.${k}` : k;
    const x = a ? a[k] : undefined; const y = b ? b[k] : undefined;
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) out.push(...diffConfigs(x, y, key));
    else if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ key, before: x === undefined ? null : x, after: y === undefined ? null : y, effect: effectOf(key) });
  }
  return out;
}
function effectOf(key) {
  if (SETTING_EFFECT[key]) return SETTING_EFFECT[key];
  const top = key.split('.')[0];
  return SETTING_EFFECT[top] || 'restart';
}

/** Configuration that can be reused by profiles/templates (no identity, secrets, or caches). */
function portableConfig(cfg) {
  const c = structuredClone(cfg);
  delete c.api; delete c.cache; delete c.maintenance;
  return c;
}

class ServerRegistry {
  constructor({ db, bus, audit }) { this.db = db; this.bus = bus; this.audit = audit; }

  _row(r) {
    if (!r) return null;
    return { id: r.id, name: r.name, group: r.group_name, installDir: r.install_dir, sortOrder: r.sort_order, createdAt: r.created_at, updatedAt: r.updated_at, config: deepMerge(DEFAULT_CONFIG(), JSON.parse(r.config)) };
  }
  list() { return this.db.all('SELECT * FROM servers ORDER BY sort_order, name').map((r) => this._row(r)); }
  get(id) {
    const s = this._row(this.db.get('SELECT * FROM servers WHERE id = ?', id));
    if (!s) throw new AppError('E_NOT_FOUND', 'Server not found');
    return s;
  }
  find(id) { return this._row(this.db.get('SELECT * FROM servers WHERE id = ?', id)); }

  create({ name, group = '', installDir, config = {} }, actor = 'local') {
    const dir = path.resolve(installDir);
    for (const s of this.list()) {
      if (isInside(s.installDir, dir) || isInside(dir, s.installDir)) throw new AppError('E_DIR_IN_USE', `That folder overlaps the installation of "${s.name}".`);
    }
    const id = newId('srv_');
    const clean = configSchema(config, 'config');
    if (clean.serverOptions) clean.serverOptions = validateServerOptions(clean.serverOptions);
    const merged = deepMerge(DEFAULT_CONFIG(), clean);
    this._checkPorts(id, merged);
    const now = Date.now();
    const order = (this.db.get('SELECT MAX(sort_order) AS m FROM servers').m || 0) + 1;
    this.db.run('INSERT INTO servers (id, name, group_name, install_dir, config, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, name, group, dir, JSON.stringify(merged), order, now, now);
    this.audit.record({ actor, action: 'server.create', serverId: id, target: name, details: { installDir: dir } });
    this.bus.publish('server.changed', { id });
    return this.get(id);
  }

  /** Update identity fields (name/group) and/or config. Snapshots the previous config. */
  update(id, { name, group, config }, { actor = 'local', reason = 'edit', skipHistory = false } = {}) {
    const cur = this.get(id);
    let next = cur.config;
    if (config) {
      const clean = configSchema(config, 'config');
      if (clean.serverOptions) clean.serverOptions = validateServerOptions(clean.serverOptions);
      if (clean.maintenance && clean.maintenance.enabled !== undefined && clean.maintenance.enabled !== cur.config.maintenance.enabled) clean.maintenance.since = clean.maintenance.enabled ? Date.now() : null;
      next = deepMerge(cur.config, clean);
      if (clean.launch && clean.launch.extraArgs) next.launch.extraArgs = clean.launch.extraArgs;
      if (clean.serverOptions) next.serverOptions = { ...cur.config.serverOptions, ...clean.serverOptions };
      this._checkPorts(id, next);
    }
    const changes = diffConfigs(cur.config, next);
    if (!skipHistory && changes.length) this.db.run('INSERT INTO config_history (server_id, ts, reason, data) VALUES (?, ?, ?, ?)', id, Date.now(), reason, JSON.stringify(portableConfig(cur.config)));
    this.db.run('UPDATE servers SET name = ?, group_name = ?, config = ?, updated_at = ? WHERE id = ?', name ?? cur.name, group ?? cur.group, JSON.stringify(next), Date.now(), id);
    if (changes.length || name !== undefined || group !== undefined) {
      this.audit.record({ actor, action: 'server.config.update', serverId: id, target: name ?? cur.name, details: { reason, changes: changes.map((c) => ({ key: c.key, effect: c.effect, before: c.before, after: c.after })), name, group } });
    }
    this.bus.publish('server.changed', { id });
    return { server: this.get(id), changes };
  }

  /** Internal updates (API pin, caches) that are not user configuration changes. */
  patchInternal(id, patch) {
    const cur = this.get(id);
    const next = deepMerge(cur.config, patch);
    this.db.run('UPDATE servers SET config = ?, updated_at = ? WHERE id = ?', JSON.stringify(next), Date.now(), id);
    return next;
  }

  setInstallDir(id, dir, actor = 'local') {
    const cur = this.get(id);
    this.db.run('UPDATE servers SET install_dir = ?, updated_at = ? WHERE id = ?', path.resolve(dir), Date.now(), id);
    this.audit.record({ actor, action: 'server.move', serverId: id, target: cur.name, details: { from: cur.installDir, to: dir } });
    this.bus.publish('server.changed', { id });
  }

  reorder(ids) {
    this.db.transaction(() => ids.forEach((id, i) => this.db.run('UPDATE servers SET sort_order = ? WHERE id = ?', i + 1, id)));
    this.bus.publish('server.changed', {});
  }

  remove(id, actor = 'local') {
    const cur = this.get(id);
    this.db.transaction(() => {
      this.db.run('DELETE FROM servers WHERE id = ?', id);
      this.db.run('DELETE FROM tasks WHERE server_id = ?', id);
      this.db.run('DELETE FROM mod_files WHERE server_id = ?', id);
    });
    this.audit.record({ actor, action: 'server.remove', serverId: id, target: cur.name, details: { installDir: cur.installDir, filesKept: true } });
    this.bus.publish('server.changed', { id, removed: true });
  }

  history(id, limit = 50) {
    return this.db.all('SELECT id, ts, reason, data FROM config_history WHERE server_id = ? ORDER BY id DESC LIMIT ?', id, limit).map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }

  _checkPorts(id, cfg) {
    const mine = [cfg.launch.port, cfg.launch.reliablePort];
    if (mine[0] === mine[1]) throw new AppError('E_PORT_CONFLICT', 'Game port and reliable port must differ.');
    for (const s of this.list()) {
      if (s.id === id) continue;
      const other = [s.config.launch.port, s.config.launch.reliablePort];
      const clash = mine.find((p) => other.includes(p));
      if (clash) throw new AppError('E_PORT_CONFLICT', `Port ${clash} is already used by "${s.name}". Each server needs its own game and reliable ports.`);
    }
  }

  /** Suggest the next free port pair. */
  suggestPorts() {
    const used = new Set(this.list().flatMap((s) => [s.config.launch.port, s.config.launch.reliablePort]));
    let port = 7777; let reliable = 8888;
    while (used.has(port)) port++;
    while (used.has(reliable) || reliable === port) reliable++;
    return { port, reliablePort: reliable };
  }
}

module.exports = { ServerRegistry, DEFAULT_CONFIG, SERVER_OPTION_KEYS, configSchema, diffConfigs, deepMerge, portableConfig, validateServerOptions, effectOf, EXTRA_ARG_RE };
