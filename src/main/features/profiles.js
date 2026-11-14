'use strict';
/**
 * Configuration profiles (reusable snapshots of a server's portable
 * configuration) and server templates (profile + mod list + metadata used to
 * create new servers). Both contain only real configuration captured from a
 * server or edited by the user — never identity, secrets, or caches.
 */
const { v } = require('../core/validate');
const { newId, AppError } = require('../core/util');
const { portableConfig, diffConfigs, configSchema } = require('../server/registry');

const FORMAT = 'ssm-config';

class Profiles {
  constructor(ctx) { this.ctx = ctx; }

  _row(r) { return r && { ...r, data: JSON.parse(r.data) }; }
  list() { return this.ctx.db.all('SELECT * FROM profiles ORDER BY updated_at DESC').map((r) => this._row(r)); }
  get(id) { const p = this._row(this.ctx.db.get('SELECT * FROM profiles WHERE id = ?', id)); if (!p) throw new AppError('E_NOT_FOUND', 'Profile not found'); return p; }

  saveFromServer(serverId, { name, description = '' }, actor = 'local') {
    const srv = this.ctx.registry.get(serverId);
    const id = newId('prof_');
    const now = Date.now();
    this.ctx.db.run('INSERT INTO profiles (id, name, description, source_server_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, name, description, serverId, JSON.stringify(portableConfig(srv.config)), now, now);
    this.ctx.audit.record({ actor, action: 'profile.save', serverId, target: name });
    return this.get(id);
  }

  duplicate(id, name, actor = 'local') {
    const p = this.get(id);
    const nid = newId('prof_');
    const now = Date.now();
    this.ctx.db.run('INSERT INTO profiles (id, name, description, source_server_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', nid, name || `${p.name} (copy)`, p.description, p.source_server_id, JSON.stringify(p.data), now, now);
    this.ctx.audit.record({ actor, action: 'profile.duplicate', target: name || p.name });
    return this.get(nid);
  }

  rename(id, { name, description }) { this.ctx.db.run('UPDATE profiles SET name = COALESCE(?, name), description = COALESCE(?, description), updated_at = ? WHERE id = ?', name ?? null, description ?? null, Date.now(), id); return this.get(id); }
  remove(id, actor = 'local') { const p = this.get(id); this.ctx.db.run('DELETE FROM profiles WHERE id = ?', id); this.ctx.audit.record({ actor, action: 'profile.delete', target: p.name }); }

  /** Diff between a server's current configuration and a profile (or two profiles). */
  compare({ serverId, profileId, otherProfileId }) {
    const a = serverId ? portableConfig(this.ctx.registry.get(serverId).config) : this.get(otherProfileId).data;
    const b = this.get(profileId).data;
    return diffConfigs(a, b);
  }

  /**
   * Apply a profile. Returns which changes are live (applied through the API),
   * immediate (manager), or need a restart. Previous config goes to history.
   */
  async apply(serverId, profileId, { actor = 'local', applyLive = true } = {}) {
    const p = this.get(profileId);
    const before = this.ctx.registry.get(serverId);
    const data = configSchema(structuredClone(p.data), 'profile');
    const { changes } = this.ctx.registry.update(serverId, { config: data }, { actor, reason: `profile: ${p.name}` });
    const live = changes.filter((c) => c.effect === 'live');
    let liveResult = null;
    if (live.length && applyLive && this.ctx.supervisor.isActive(serverId) && this.ctx.supervisor.hasToken(serverId)) {
      const opts = Object.fromEntries(live.map((c) => [c.key.replace(/^serverOptions\./, ''), String(c.after)]));
      try { await this.ctx.supervisor.api(serverId).applyOptions(opts); liveResult = 'applied'; } catch (err) { liveResult = `failed: ${err.message}`; }
    }
    this.ctx.audit.record({ actor, action: 'profile.apply', serverId, target: p.name, details: { changes: changes.length } });
    return {
      changes,
      restartRequired: changes.some((c) => c.effect === 'restart') && this.ctx.supervisor.isActive(serverId),
      liveResult, previousName: before.name,
    };
  }

  /** Restore a previous configuration from history. */
  restoreHistory(serverId, historyId, actor = 'local') {
    const row = this.ctx.db.get('SELECT * FROM config_history WHERE id = ? AND server_id = ?', historyId, serverId);
    if (!row) throw new AppError('E_NOT_FOUND', 'History entry not found');
    const data = configSchema(JSON.parse(row.data), 'history');
    return this.ctx.registry.update(serverId, { config: data }, { actor, reason: `restore history #${historyId}` });
  }

  exportProfile(id) {
    const p = this.get(id);
    return { format: FORMAT, formatVersion: 1, kind: 'profile', exportedAt: new Date().toISOString(), name: p.name, description: p.description, config: p.data };
  }

  importProfile(doc, actor = 'local') {
    const parsed = v.object({ format: v.enum([FORMAT]), formatVersion: v.int({ min: 1, max: 1 }), kind: v.enum(['profile']), exportedAt: v.optional(v.string({ max: 64 })), name: v.string({ min: 1, max: 80 }), description: v.optional(v.string({ max: 1000 })), config: v.json() })(doc);
    const config = configSchema(parsed.config, 'config');
    const id = newId('prof_');
    const now = Date.now();
    this.ctx.db.run('INSERT INTO profiles (id, name, description, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, parsed.name, parsed.description || '', JSON.stringify(config), now, now);
    this.ctx.audit.record({ actor, action: 'profile.import', target: parsed.name });
    return this.get(id);
  }

  // ------------------------------------------------------------ templates
  listTemplates() { return this.ctx.db.all('SELECT * FROM templates ORDER BY updated_at DESC').map((r) => this._row(r)); }
  getTemplate(id) { const t = this._row(this.ctx.db.get('SELECT * FROM templates WHERE id = ?', id)); if (!t) throw new AppError('E_NOT_FOUND', 'Template not found'); return t; }

  async saveTemplate(serverId, { name, description = '', includeMods = true }, actor = 'local') {
    const srv = this.ctx.registry.get(serverId);
    const cfg = portableConfig(srv.config);
    delete cfg.notes;
    const mods = includeMods ? (await this.ctx.mods.installed(serverId)).filter((m) => m.version).map((m) => ({ reference: m.reference, version: m.version, name: m.name })) : [];
    const data = { config: cfg, mods, group: srv.group, source: { name: srv.name, netCL: srv.config.cache.netCL } };
    const id = newId('tpl_');
    const now = Date.now();
    this.ctx.db.run('INSERT INTO templates (id, name, description, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, name, description, JSON.stringify(data), now, now);
    this.ctx.audit.record({ actor, action: 'template.save', serverId, target: name, details: { mods: mods.length } });
    return this.getTemplate(id);
  }

  updateTemplateDefaults(id, { name, description, config }, actor = 'local') {
    const t = this.getTemplate(id);
    const data = { ...t.data };
    if (config) data.config = configSchema(config, 'config');
    this.ctx.db.run('UPDATE templates SET name = ?, description = ?, data = ?, updated_at = ? WHERE id = ?', name ?? t.name, description ?? t.description, JSON.stringify(data), Date.now(), id);
    this.ctx.audit.record({ actor, action: 'template.update', target: name ?? t.name });
    return this.getTemplate(id);
  }

  removeTemplate(id, actor = 'local') { const t = this.getTemplate(id); this.ctx.db.run('DELETE FROM templates WHERE id = ?', id); this.ctx.audit.record({ actor, action: 'template.delete', target: t.name }); }

  /** Register a new server from a template. Files are installed afterwards (Install action). */
  createServerFromTemplate(id, { name, installDir }, actor = 'local') {
    const t = this.getTemplate(id);
    const ports = this.ctx.registry.suggestPorts();
    const config = structuredClone(t.data.config);
    config.launch = { ...config.launch, ...ports };
    const srv = this.ctx.registry.create({ name, group: t.data.group || '', installDir, config }, actor);
    this.ctx.audit.record({ actor, action: 'template.create-server', serverId: srv.id, target: name, details: { template: t.name } });
    return { server: srv, pendingMods: t.data.mods };
  }

  /** Duplicate a server's configuration into a new (not yet installed) server. */
  duplicateServer(serverId, { name, installDir }, actor = 'local') {
    const srv = this.ctx.registry.get(serverId);
    const config = portableConfig(srv.config);
    config.launch = { ...config.launch, ...this.ctx.registry.suggestPorts() };
    const created = this.ctx.registry.create({ name, group: srv.group, installDir, config }, actor);
    this.ctx.audit.record({ actor, action: 'server.duplicate', serverId: created.id, target: name, details: { from: srv.name } });
    return created;
  }

  exportTemplate(id) { const t = this.getTemplate(id); return { format: FORMAT, formatVersion: 1, kind: 'template', exportedAt: new Date().toISOString(), name: t.name, description: t.description, template: t.data }; }

  importTemplate(doc, actor = 'local') {
    const p = v.object({ format: v.enum([FORMAT]), formatVersion: v.int({ min: 1, max: 1 }), kind: v.enum(['template']), exportedAt: v.optional(v.string({ max: 64 })), name: v.string({ min: 1, max: 80 }), description: v.optional(v.string({ max: 1000 })), template: v.json() })(doc);
    const data = v.object({ config: v.json(), mods: v.array(v.object({ reference: v.string({ min: 1, max: 64, pattern: /^[A-Za-z0-9_]+$/ }), version: v.string({ max: 40 }), name: v.optional(v.string({ max: 120 })) }), { max: 500 }), group: v.optional(v.string({ max: 60 })), source: v.optional(v.json()) })(p.template);
    data.config = configSchema(data.config, 'config');
    const id = newId('tpl_');
    const now = Date.now();
    this.ctx.db.run('INSERT INTO templates (id, name, description, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, p.name, p.description || '', JSON.stringify(data), now, now);
    this.ctx.audit.record({ actor, action: 'template.import', target: p.name });
    return this.getTemplate(id);
  }
}

module.exports = { Profiles, FORMAT };
