'use strict';
/**
 * Advanced mod management backed by the official FICSIT mod repository
 * (api.ficsit.app GraphQL). Only versions that publish a dedicated-server
 * target for this platform (WindowsServer / LinuxServer) and whose
 * game_version accepts the server's changelist are installable. Downloads come
 * only from api.ficsit.app / storage.ficsit.app and are SHA-256 verified.
 */
const fsp = require('node:fs/promises');
const path = require('node:path');
const layout = require('../server/layout');
const { fetchJson, download } = require('../core/http');
const { extractZip, createZip } = require('../core/zip');
const { listFiles, sha256File, exists, safeRemove } = require('../core/fsutil');
const { AppError, newId } = require('../core/util');
const semver = require('./semver');

const API = 'https://api.ficsit.app';
const GQL = `${API}/v2/query`;
const MOD_HOSTS = ['api.ficsit.app', 'storage.ficsit.app'];

const VERSION_FIELDS = 'id version game_version required_on_remote created_at stability changelog targets { targetName link hash size } dependencies { mod_reference condition optional }';

class Mods {
  constructor(ctx) { this.ctx = ctx; this.cache = new Map(); }

  async gql(query, variables) {
    const res = await fetchJson(GQL, { method: 'POST', body: { query, variables }, timeoutMs: 30000 });
    if (res.errors && res.errors.length) throw new AppError('E_FICSIT', `FICSIT API error: ${res.errors.map((e) => e.message).join('; ')}`);
    return res.data;
  }

  async search({ search = '', offset = 0, limit = 30, orderBy = 'popularity' } = {}) {
    const data = await this.gql(`query($f: ModFilter){ getMods(filter: $f){ count mods { id mod_reference name short_description logo downloads updated_at last_version_date compatibility { EA { state note } EXP { state note } } latestVersions { release { version game_version targets { targetName } } } } } }`,
      { f: { search: search || undefined, offset, limit, order_by: orderBy, order: 'desc' } });
    return {
      count: data.getMods.count,
      mods: data.getMods.mods.map((m) => {
        const rel = m.latestVersions && m.latestVersions.release;
        const targets = rel ? rel.targets.map((t) => t.targetName) : [];
        return { ...m, latest: rel ? rel.version : null, gameVersion: rel ? rel.game_version : null, serverSupport: targets.includes(layout.MOD_TARGET), clientSupport: targets.includes('Windows'), targets };
      }),
    };
  }

  /** Mod details including all versions (cached for 10 minutes). */
  async getMod(ref) {
    const c = this.cache.get(ref);
    if (c && Date.now() - c.at < 600000) return c.mod;
    const data = await this.gql(`query($r: ModReference!){ getModByReference(modReference: $r){ id mod_reference name short_description logo source_url downloads updated_at compatibility { EA { state note } EXP { state note } } authors { role user { username } } versions(filter: { limit: 100, order_by: created_at, order: desc }) { ${VERSION_FIELDS} } } }`, { r: ref });
    const mod = data.getModByReference;
    if (!mod) throw new AppError('E_MOD_NOT_FOUND', `Mod "${ref}" was not found in the FICSIT repository.`);
    this.cache.set(ref, { at: Date.now(), mod });
    return mod;
  }

  _serverTarget(ver) { return ver.targets.find((t) => t.targetName === layout.MOD_TARGET) || null; }

  /** Classify a version against a server. */
  versionCompat(ver, netCL) {
    const target = this._serverTarget(ver);
    const game = semver.gameVersionOk(ver.game_version, netCL);
    return {
      serverBuild: !!target,
      clientBuild: ver.targets.some((t) => t.targetName === 'Windows'),
      requiredOnClient: !!ver.required_on_remote,
      gameCompatible: game, // null = server changelist unknown (start the server once)
      installable: !!target && game !== false,
    };
  }

  // ---------------------------------------------------------- installed mods
  async installed(serverId) {
    const srv = this.ctx.registry.get(serverId);
    const dir = layout.modsDir(srv.installDir);
    const out = [];
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { /* no mods folder */ }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const up = path.join(dir, e.name, `${e.name}.uplugin`);
      let meta = null;
      try { meta = JSON.parse((await fsp.readFile(up, 'utf8')).replace(/^﻿/, '')); } catch { /* missing or invalid */ }
      const rec = this.ctx.db.get('SELECT version, installed_at FROM mod_files WHERE server_id = ? AND mod_reference = ?', serverId, e.name);
      out.push({
        reference: e.name,
        name: meta ? meta.FriendlyName || e.name : e.name,
        version: meta ? meta.SemVersion || meta.VersionName || null : null,
        managed: !!rec, installedAt: rec ? rec.installed_at : null,
        valid: !!meta,
        dependencies: meta && Array.isArray(meta.Plugins) ? meta.Plugins.filter((p) => p && p.Name).map((p) => ({ reference: p.Name, condition: p.SemVersion || '*', optional: !!p.Optional })) : [],
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Local dependency/consistency analysis of installed mods. */
  async analyze(serverId) {
    const mods = await this.installed(serverId);
    const byRef = new Map(mods.map((m) => [m.reference, m]));
    const issues = [];
    const engineRefs = new Set(); // engine/game plugins referenced in .uplugin files are not FICSIT mods
    for (const m of mods) {
      if (!m.valid) issues.push({ severity: 'error', mod: m.reference, kind: 'invalid', message: `${m.reference} has no readable .uplugin file; the mod folder looks incomplete.` });
      for (const d of m.dependencies) {
        const dep = byRef.get(d.reference);
        if (!dep) {
          if (d.reference === 'SML' || /^[A-Z][A-Za-z0-9_]+$/.test(d.reference)) {
            if (!d.optional && (d.reference === 'SML' || d.condition !== '*')) issues.push({ severity: 'error', mod: m.reference, kind: 'missing-dependency', dependency: d.reference, message: `${m.name} requires ${d.reference} ${d.condition}, which is not installed.` });
            else engineRefs.add(d.reference);
          }
          continue;
        }
        if (dep.version && d.condition && d.condition !== '*' && !semver.satisfies(dep.version, d.condition)) {
          issues.push({ severity: 'error', mod: m.reference, kind: 'version-conflict', dependency: d.reference, message: `${m.name} requires ${d.reference} ${d.condition}, but ${dep.version} is installed.` });
        }
      }
    }
    if (mods.length && !byRef.has('SML')) issues.push({ severity: 'error', mod: null, kind: 'no-sml', message: 'Mods are installed but the Satisfactory Mod Loader (SML) is missing, so no mod will load.' });
    const graph = { nodes: mods.map((m) => ({ id: m.reference, label: m.name, version: m.version })), edges: mods.flatMap((m) => m.dependencies.filter((d) => byRef.has(d.reference)).map((d) => ({ from: m.reference, to: d.reference, condition: d.condition, optional: d.optional }))) };
    return { mods, issues, graph };
  }

  /** Remote compatibility check for each installed mod against the server changelist. */
  async compatibility(serverId) {
    const srv = this.ctx.registry.get(serverId);
    const netCL = srv.config.cache.netCL;
    const mods = await this.installed(serverId);
    const out = [];
    for (const m of mods) {
      try {
        const mod = await this.getMod(m.reference);
        const ver = mod.versions.find((x) => x.version === m.version);
        const latest = this._pickVersion(mod, '*', netCL);
        out.push({ reference: m.reference, name: mod.name, installed: m.version, compat: ver ? this.versionCompat(ver, netCL) : null, latestCompatible: latest ? latest.version : null, known: !!ver, repoCompatibility: mod.compatibility });
      } catch (err) { out.push({ reference: m.reference, name: m.name, installed: m.version, error: err.message }); }
    }
    return { netCL, mods: out };
  }

  _pickVersion(mod, condition, netCL) {
    const candidates = mod.versions
      .filter((v) => v.stability !== 'alpha' || condition !== '*')
      .filter((v) => semver.satisfies(v.version, condition))
      .filter((v) => this.versionCompat(v, netCL).installable)
      .sort((a, b) => semver.compare(b.version, a.version));
    return candidates[0] || null;
  }

  /**
   * Resolve an install plan for the requested mods including transitive
   * required dependencies. Detects conflicting constraints.
   */
  async resolve(serverId, requests) {
    const srv = this.ctx.registry.get(serverId);
    const netCL = srv.config.cache.netCL;
    const installed = new Map((await this.installed(serverId)).map((m) => [m.reference, m]));
    const constraints = new Map(); // ref -> [{ condition, by }]
    const add = (ref, condition, by) => { if (!constraints.has(ref)) constraints.set(ref, []); constraints.get(ref).push({ condition, by }); };
    for (const r of requests) add(r.reference, r.version ? `=${r.version}` : '*', 'you');
    // Constraints imposed by installed mods that remain installed.
    for (const m of installed.values()) for (const d of m.dependencies) if (!d.optional && installed.has(d.reference)) add(d.reference, d.condition, m.reference);

    const plan = new Map(); const conflicts = []; const warnings = [];
    const queue = requests.map((r) => r.reference);
    const seen = new Set();
    while (queue.length) {
      const ref = queue.shift();
      if (seen.has(ref) && plan.has(ref)) {
        const chosen = plan.get(ref);
        if (!constraints.get(ref).every((c) => semver.satisfies(chosen.version, c.condition))) seen.delete(ref); else continue;
      }
      seen.add(ref);
      let mod;
      try { mod = await this.getMod(ref); } catch (err) { conflicts.push({ reference: ref, message: err.message }); continue; }
      const conds = constraints.get(ref) || [{ condition: '*', by: 'you' }];
      const combined = conds.map((c) => c.condition).join(' ');
      const ver = this._pickVersion(mod, combined, netCL);
      if (!ver) {
        const anyServer = mod.versions.some((v) => this._serverTarget(v));
        conflicts.push({ reference: ref, name: mod.name, message: !anyServer ? `${mod.name} has no dedicated server build for ${layout.MOD_TARGET}.` : `No ${mod.name} version satisfies ${conds.map((c) => `${c.condition} (required by ${c.by})`).join(' and ')} and is compatible with the server${netCL ? ` (changelist ${netCL})` : ''}.` });
        continue;
      }
      const cur = installed.get(ref);
      plan.set(ref, { reference: ref, name: mod.name, version: ver.version, versionId: ver.id, target: this._serverTarget(ver), current: cur ? cur.version : null, requiredOnClient: !!ver.required_on_remote, clientBuild: ver.targets.some((t) => t.targetName === 'Windows'), dependencies: ver.dependencies, gameVersion: ver.game_version });
      if (netCL == null) warnings.push(`The server's game changelist is unknown, so game-version compatibility of ${mod.name} could not be checked. Start the server once to detect it.`);
      for (const d of ver.dependencies) {
        if (d.optional) continue;
        add(d.mod_reference, d.condition, ref);
        const inst = installed.get(d.mod_reference);
        if (inst && inst.version && semver.satisfies(inst.version, constraints.get(d.mod_reference).map((c) => c.condition).join(' ')) && !requests.some((r) => r.reference === d.mod_reference)) continue;
        queue.push(d.mod_reference);
      }
    }
    const actions = [...plan.values()].filter((p) => p.current !== p.version);
    return { netCL, actions, conflicts, warnings: [...new Set(warnings)], clientNotice: actions.filter((a) => a.requiredOnClient).map((a) => a.name) };
  }

  async _snapshot(serverId, refs, label) {
    const srv = this.ctx.registry.get(serverId);
    const dir = layout.modsDir(srv.installDir);
    const entries = [];
    for (const ref of refs) {
      const p = path.join(dir, ref);
      if (await exists(p)) for (const rel of await listFiles(p)) entries.push({ abs: path.join(p, rel), name: `${ref}/${rel}` });
    }
    const file = path.join(this.ctx.paths.modSnapshots, serverId, `${Date.now()}_${label}_${newId()}.zip`);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const meta = { refs, label, createdAt: Date.now(), versions: Object.fromEntries((await this.installed(serverId)).filter((m) => refs.includes(m.reference)).map((m) => [m.reference, m.version])) };
    await createZip(file, [{ name: '__snapshot.json', buffer: Buffer.from(JSON.stringify(meta)) }, ...entries]);
    return file;
  }

  async _manifest(serverId, ref) {
    const srv = this.ctx.registry.get(serverId);
    const root = path.join(layout.modsDir(srv.installDir), ref);
    const files = {};
    for (const rel of await listFiles(root)) files[rel] = await sha256File(path.join(root, rel));
    return files;
  }

  _requireStopped(serverId) {
    if (this.ctx.supervisor.isActive(serverId)) throw new AppError('E_SERVER_RUNNING', 'Stop the server before changing mods. Mods are loaded at server start.');
  }

  /** Execute a resolved plan. Snapshots affected mods first; rolls back on any failure. */
  async apply(serverId, requests, { actor = 'local' } = {}) {
    this._requireStopped(serverId);
    const srv = this.ctx.registry.get(serverId);
    return this.ctx.locks.run(serverId, 'mods', async () => {
      const plan = await this.resolve(serverId, requests);
      if (plan.conflicts.length) throw new AppError('E_MOD_CONFLICT', plan.conflicts.map((c) => c.message).join(' '), { conflicts: plan.conflicts });
      if (!plan.actions.length) return { changed: [], message: 'Everything is already installed and up to date.' };
      if (this.ctx.settings.get('backups').beforeModChange) await this.ctx.backups.create(serverId, { type: 'pre-mod', note: `Before mod changes: ${plan.actions.map((a) => a.reference).join(', ')}`, actor: 'system' }).catch((e) => { if (e.code !== 'E_NOTHING_TO_BACKUP') throw e; });
      const snapshot = await this._snapshot(serverId, plan.actions.map((a) => a.reference), 'install');
      const modsDir = layout.modsDir(srv.installDir);
      const staging = path.join(this.ctx.paths.temp, `mods-${newId()}`);
      const done = [];
      try {
        for (const a of plan.actions) {
          this.ctx.bus.publish('operation.progress', { serverId, kind: 'mods', message: `Downloading ${a.name} ${a.version}` });
          const archive = path.join(staging, `${a.reference}.zip`);
          await download(`${API}${a.target.link}`, archive, { sha256: a.target.hash, maxBytes: 2 * 1024 ** 3, hosts: MOD_HOSTS });
          const out = path.join(staging, a.reference);
          await extractZip(archive, out);
          if (!(await exists(path.join(out, `${a.reference}.uplugin`)))) throw new AppError('E_MOD_ARCHIVE', `The ${a.name} archive does not contain ${a.reference}.uplugin.`);
          const dest = path.join(modsDir, a.reference);
          await fsp.mkdir(modsDir, { recursive: true });
          if (await exists(dest)) await safeRemove(dest, [modsDir]);
          await fsp.rename(out, dest).catch(async () => { await fsp.cp(out, dest, { recursive: true }); });
          const manifest = await this._manifest(serverId, a.reference);
          this.ctx.db.run('INSERT INTO mod_files (server_id, mod_reference, version, manifest, installed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(server_id, mod_reference) DO UPDATE SET version = excluded.version, manifest = excluded.manifest, installed_at = excluded.installed_at', serverId, a.reference, a.version, JSON.stringify(manifest), Date.now());
          this.ctx.db.run('INSERT INTO mod_history (server_id, ts, action, mod_reference, from_version, to_version, status, snapshot_path, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', serverId, Date.now(), a.current ? 'update' : 'install', a.reference, a.current, a.version, 'completed', snapshot, JSON.stringify({ sha256: a.target.hash }));
          done.push(a);
        }
      } catch (err) {
        await this._restoreSnapshot(serverId, snapshot).catch((e) => this.ctx.log.error('Mod rollback failed', e));
        for (const a of plan.actions) if (!a.current) { await safeRemove(path.join(modsDir, a.reference), [modsDir]).catch(() => {}); this.ctx.db.run('DELETE FROM mod_files WHERE server_id = ? AND mod_reference = ?', serverId, a.reference); }
        this.ctx.db.run('INSERT INTO mod_history (server_id, ts, action, mod_reference, status, snapshot_path, details) VALUES (?, ?, ?, ?, ?, ?, ?)', serverId, Date.now(), 'install', plan.actions.map((a) => a.reference).join(','), 'rolled-back', snapshot, JSON.stringify({ error: err.message }));
        this.ctx.audit.record({ actor, action: 'mods.install', serverId, target: plan.actions.map((a) => a.reference).join(', '), result: 'failed', error: err });
        this.ctx.notifications.notify({ category: 'modIssue', severity: 'error', title: `Mod installation failed: ${srv.name}`, body: `${err.message} Previous mod files were restored.`, serverId });
        throw err;
      } finally {
        await fsp.rm(staging, { recursive: true, force: true });
        this.ctx.bus.publish('mods.changed', { serverId });
      }
      this.ctx.audit.record({ actor, action: 'mods.install', serverId, target: done.map((a) => `${a.reference}@${a.version}`).join(', '), details: { actions: done.map((a) => ({ ref: a.reference, from: a.current, to: a.version })) } });
      return { changed: done.map((a) => ({ reference: a.reference, from: a.current, to: a.version })), clientNotice: plan.clientNotice };
    });
  }

  async remove(serverId, ref, { actor = 'local', force = false } = {}) {
    this._requireStopped(serverId);
    const srv = this.ctx.registry.get(serverId);
    const modsDir = layout.modsDir(srv.installDir);
    const dependents = (await this.installed(serverId)).filter((m) => m.reference !== ref && m.dependencies.some((d) => d.reference === ref && !d.optional));
    if (dependents.length && !force) throw new AppError('E_MOD_DEPENDENTS', `${dependents.map((d) => d.name).join(', ')} depend(s) on ${ref}. Remove them first or confirm removal anyway.`, { dependents: dependents.map((d) => d.reference) });
    return this.ctx.locks.run(serverId, 'mods', async () => {
      const snapshot = await this._snapshot(serverId, [ref], 'remove');
      const cur = (await this.installed(serverId)).find((m) => m.reference === ref);
      await safeRemove(path.join(modsDir, ref), [modsDir]);
      this.ctx.db.run('DELETE FROM mod_files WHERE server_id = ? AND mod_reference = ?', serverId, ref);
      this.ctx.db.run('INSERT INTO mod_history (server_id, ts, action, mod_reference, from_version, status, snapshot_path) VALUES (?, ?, ?, ?, ?, ?, ?)', serverId, Date.now(), 'remove', ref, cur ? cur.version : null, 'completed', snapshot);
      this.ctx.audit.record({ actor, action: 'mods.remove', serverId, target: ref, details: { version: cur && cur.version, force } });
      this.ctx.bus.publish('mods.changed', { serverId });
      return { removed: ref };
    });
  }

  async _restoreSnapshot(serverId, file) {
    const srv = this.ctx.registry.get(serverId);
    const modsDir = layout.modsDir(srv.installDir);
    const { readEntry } = require('../core/zip');
    const meta = JSON.parse((await readEntry(file, '__snapshot.json')).toString('utf8'));
    for (const ref of meta.refs) await safeRemove(path.join(modsDir, ref), [modsDir]).catch(() => {});
    await extractZip(file, modsDir, { overwrite: true, map: (n) => (n === '__snapshot.json' ? null : n) });
    for (const ref of meta.refs) {
      if (await exists(path.join(modsDir, ref))) {
        const manifest = await this._manifest(serverId, ref);
        this.ctx.db.run('INSERT INTO mod_files (server_id, mod_reference, version, manifest, installed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(server_id, mod_reference) DO UPDATE SET version = excluded.version, manifest = excluded.manifest', serverId, ref, meta.versions[ref] || 'unknown', JSON.stringify(manifest), Date.now());
      } else this.ctx.db.run('DELETE FROM mod_files WHERE server_id = ? AND mod_reference = ?', serverId, ref);
    }
    return meta;
  }

  /** Roll back a history entry by restoring the snapshot taken before it. */
  async rollback(historyId, { actor = 'local' } = {}) {
    const h = this.ctx.db.get('SELECT * FROM mod_history WHERE id = ?', historyId);
    if (!h || !h.snapshot_path) throw new AppError('E_NOT_FOUND', 'No snapshot is available for that change.');
    this._requireStopped(h.server_id);
    if (!(await exists(h.snapshot_path))) throw new AppError('E_NOT_FOUND', 'The snapshot file no longer exists.');
    return this.ctx.locks.run(h.server_id, 'mods', async () => {
      const meta = await this._restoreSnapshot(h.server_id, h.snapshot_path);
      this.ctx.db.run('INSERT INTO mod_history (server_id, ts, action, mod_reference, status, details) VALUES (?, ?, ?, ?, ?, ?)', h.server_id, Date.now(), 'rollback', meta.refs.join(','), 'completed', JSON.stringify({ historyId }));
      this.ctx.audit.record({ actor, action: 'mods.rollback', serverId: h.server_id, target: meta.refs.join(', '), details: { historyId } });
      this.ctx.bus.publish('mods.changed', { serverId: h.server_id });
      return { restored: meta.refs, versions: meta.versions };
    });
  }

  history(serverId, limit = 200) { return this.ctx.db.all('SELECT * FROM mod_history WHERE server_id = ? ORDER BY id DESC LIMIT ?', serverId, limit); }

  /** Verify installed mod files against the SHA-256 manifest recorded at install time. */
  async integrity(serverId) {
    const rows = this.ctx.db.all('SELECT * FROM mod_files WHERE server_id = ?', serverId);
    const srv = this.ctx.registry.get(serverId);
    const results = [];
    for (const r of rows) {
      const manifest = JSON.parse(r.manifest);
      const root = path.join(layout.modsDir(srv.installDir), r.mod_reference);
      const missing = []; const modified = [];
      for (const [rel, hash] of Object.entries(manifest)) {
        const p = path.join(root, rel);
        if (!(await exists(p))) missing.push(rel);
        else if ((await sha256File(p)) !== hash) modified.push(rel);
      }
      const current = await listFiles(root).catch(() => []);
      const extra = current.filter((f) => !(f in manifest));
      results.push({ reference: r.mod_reference, version: r.version, ok: !missing.length && !modified.length, missing, modified, extra });
    }
    const unmanaged = (await this.installed(serverId)).filter((m) => !m.managed).map((m) => m.reference);
    return { results, unmanaged };
  }

  policyFor(srv) {
    const p = srv.config.mods.updatePolicy;
    return p === 'inherit' ? this.ctx.settings.get('updates').autoModUpdate : p;
  }

  async checkUpdates(serverId) {
    const srv = this.ctx.registry.get(serverId);
    const mods = await this.installed(serverId);
    if (!mods.length) return { updates: [] };
    const updates = [];
    for (const m of mods) {
      if (!m.version) continue;
      try {
        const mod = await this.getMod(m.reference);
        const latest = this._pickVersion(mod, '*', srv.config.cache.netCL);
        if (latest && semver.compare(latest.version, m.version) > 0) updates.push({ reference: m.reference, name: mod.name, installed: m.version, latest: latest.version, changelog: latest.changelog });
      } catch { /* not in repository (local mod) */ }
    }
    return { updates };
  }

  async updateAll(serverId, { actor = 'local', restartAfter = true } = {}) {
    const { updates } = await this.checkUpdates(serverId);
    if (!updates.length) return { skipped: true, message: 'All mods are up to date.' };
    const wasRunning = this.ctx.supervisor.isActive(serverId);
    if (wasRunning) await this.ctx.supervisor.stop(serverId, { reason: 'Mod update', actor });
    try {
      const res = await this.apply(serverId, updates.map((u) => ({ reference: u.reference, version: u.latest })), { actor });
      return { ...res, message: `Updated ${res.changed.length} mod(s)` };
    } finally {
      if (wasRunning && restartAfter) await this.ctx.supervisor.start(serverId, { trigger: 'mod-update', actor: 'system' }).catch((e) => this.ctx.log.warn('Restart after mod update failed', e));
    }
  }

  // ------------------------------------------------------------ mod profiles
  async saveProfile(serverId, name) {
    const mods = (await this.installed(serverId)).filter((m) => m.version).map((m) => ({ reference: m.reference, version: m.version, name: m.name }));
    const id = newId('mp_');
    this.ctx.db.run('INSERT INTO mod_profiles (id, name, mods, created_at) VALUES (?, ?, ?, ?)', id, name, JSON.stringify(mods), Date.now());
    this.ctx.audit.record({ action: 'mods.profile.save', serverId, target: name, details: { count: mods.length } });
    return { id, name, mods };
  }
  listProfiles() { return this.ctx.db.all('SELECT * FROM mod_profiles ORDER BY created_at DESC').map((r) => ({ ...r, mods: JSON.parse(r.mods) })); }
  deleteProfile(id) { this.ctx.db.run('DELETE FROM mod_profiles WHERE id = ?', id); }
  compareProfiles(a, b) {
    const pa = a.mods ? a : this.listProfiles().find((p) => p.id === a);
    const pb = b.mods ? b : this.listProfiles().find((p) => p.id === b);
    if (!pa || !pb) throw new AppError('E_NOT_FOUND', 'Profile not found');
    const ma = new Map(pa.mods.map((m) => [m.reference, m])); const mb = new Map(pb.mods.map((m) => [m.reference, m]));
    const refs = [...new Set([...ma.keys(), ...mb.keys()])].sort();
    return refs.map((r) => {
      const x = ma.get(r); const y = mb.get(r);
      const state = !x ? 'added' : !y ? 'removed' : x.version === y.version ? 'same' : semver.compare(y.version, x.version) > 0 ? 'upgraded' : 'downgraded';
      return { reference: r, name: (x || y).name, a: x ? x.version : null, b: y ? y.version : null, state };
    });
  }
  async profileFromServer(serverId) { return { mods: (await this.installed(serverId)).filter((m) => m.version).map((m) => ({ reference: m.reference, version: m.version, name: m.name })) }; }
  async applyProfile(serverId, profileId, { actor = 'local' } = {}) {
    const p = this.listProfiles().find((x) => x.id === profileId);
    if (!p) throw new AppError('E_NOT_FOUND', 'Profile not found');
    return this.apply(serverId, p.mods.map((m) => ({ reference: m.reference, version: m.version })), { actor });
  }
}

module.exports = { Mods, MOD_HOSTS };
