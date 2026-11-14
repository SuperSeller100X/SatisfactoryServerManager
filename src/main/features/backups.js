'use strict';
/**
 * Backups of save games and server configuration.
 *  - Archive: ZIP with manifest.json, saves/ and config/ folders.
 *  - Integrity: SHA-256 of the archive + CRC32 verification of every entry.
 *  - Restore: always creates a restore point first; requires the server to be
 *    stopped and an explicit confirmation flag.
 *  - Rotation: only when the user enabled a retention policy; manual backups
 *    are never deleted automatically.
 */
const fsp = require('node:fs/promises');
const path = require('node:path');
const layout = require('../server/layout');
const { createZip, verifyZip, extractZip, readEntry, listZip } = require('../core/zip');
const { sha256File, listFiles, exists, safeRemove, diskSpace, isInside } = require('../core/fsutil');
const { newId, AppError, KeyedLock } = require('../core/util');
const { readAppManifest } = require('../steam/steamcmd');

const TYPES = ['manual', 'scheduled', 'pre-update', 'pre-restore', 'pre-mod', 'restore-point', 'pre-migration'];
const AUTOMATIC = new Set(['pre-update', 'pre-restore', 'pre-mod', 'restore-point', 'pre-migration']);

class Backups {
  constructor(ctx) { this.ctx = ctx; this.lock = new KeyedLock(); }

  root() { return this.ctx.settings.get('backups').root || this.ctx.paths.backups; }
  saveRoot(srv) { return srv.config.saveRoot || layout.defaultSaveRoot(); }

  /** Files that make up a server's persistent state. */
  async collectSources(srv) {
    const entries = [];
    const saveRoot = this.saveRoot(srv);
    const sessionDir = layout.sessionSaveDir(saveRoot);
    if (await exists(sessionDir)) {
      for (const rel of await listFiles(sessionDir)) entries.push({ abs: path.join(sessionDir, rel), name: `saves/server/${rel}` });
    }
    // Per-port server settings (server name, passwords hashes, options) live next to the session folder.
    try {
      for (const f of await fsp.readdir(saveRoot)) {
        if (/^ServerSettings\.\d+\.sav$/i.test(f)) entries.push({ abs: path.join(saveRoot, f), name: `saves/${f}` });
      }
    } catch { /* no save root yet */ }
    const cfg = layout.configDir(srv.installDir);
    if (await exists(cfg)) for (const rel of await listFiles(cfg)) entries.push({ abs: path.join(cfg, rel), name: `config/${rel}` });
    return { entries, saveRoot, sessionDir };
  }

  async listSaves(serverId) {
    const srv = this.ctx.registry.get(serverId);
    const dir = layout.sessionSaveDir(this.saveRoot(srv));
    const out = [];
    for (const rel of await listFiles(dir).catch(() => [])) {
      if (!/\.sav$/i.test(rel)) continue;
      const st = await fsp.stat(path.join(dir, rel)).catch(() => null);
      if (st) out.push({ name: rel, size: st.size, modified: st.mtimeMs });
    }
    const shared = this.ctx.registry.list().filter((s) => s.id !== serverId && this.saveRoot(s) === this.saveRoot(srv)).map((s) => s.name);
    return { dir, saves: out.sort((a, b) => b.modified - a.modified), sharedWith: shared };
  }

  async create(serverId, { type = 'manual', note = '', actor = 'local' } = {}) {
    if (!TYPES.includes(type)) throw new AppError('E_VALIDATION', 'Unknown backup type');
    const srv = this.ctx.registry.get(serverId);
    return this.lock.run(serverId, 'backup', () => this.ctx.audit.wrap({ actor, action: 'backup.create', serverId, target: srv.name, details: { type, note } }, async () => {
      const { entries, saveRoot } = await this.collectSources(srv);
      if (!entries.length) throw new AppError('E_NOTHING_TO_BACKUP', 'No save files or configuration were found for this server yet.');
      const dir = path.join(this.root(), serverId);
      await fsp.mkdir(dir, { recursive: true });
      const totalSize = (await Promise.all(entries.map((e) => fsp.stat(e.abs).then((s) => s.size).catch(() => 0)))).reduce((a, b) => a + b, 0);
      const space = await diskSpace(dir);
      if (space.free < totalSize * 1.2 + 200 * 1024 * 1024) throw new AppError('E_DISK_SPACE', `Not enough free disk space for the backup (${Math.round(space.free / 1048576)} MB free).`);
      const id = newId('bk_');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(dir, `${stamp}_${type}_${id}.zip`);
      const manifestBuild = await readAppManifest(srv.installDir).catch(() => null);
      const sharedWith = this.ctx.registry.list().filter((s) => s.id !== serverId && this.saveRoot(s) === saveRoot).map((s) => s.name);

      // Capture file stats so files modified mid-backup (autosave) are detected.
      const before = await Promise.all(entries.map((e) => fsp.stat(e.abs).then((s) => `${s.size}:${s.mtimeMs}`).catch(() => 'missing')));
      const manifest = {
        format: 'ssm-backup', formatVersion: 1, id, type, note, createdAt: Date.now(),
        server: { id: srv.id, name: srv.name, installDir: srv.installDir, port: srv.config.launch.port },
        build: manifestBuild ? { buildId: manifestBuild.buildId, branch: manifestBuild.branch } : null,
        netCL: srv.config.cache.netCL, saveRoot, sharedSaveRootWith: sharedWith,
        files: entries.map((e) => e.name),
      };
      const zipEntries = [{ name: 'manifest.json', buffer: Buffer.from(JSON.stringify(manifest, null, 2)) }, ...entries];
      let attempt = 0;
      for (;;) {
        await createZip(file, zipEntries, { level: this.ctx.settings.get('backups').compressLevel });
        const after = await Promise.all(entries.map((e) => fsp.stat(e.abs).then((s) => `${s.size}:${s.mtimeMs}`).catch(() => 'missing')));
        if (after.every((x, i) => x === before[i])) break;
        if (++attempt >= 3) { await fsp.rm(file, { force: true }); throw new AppError('E_BACKUP_UNSTABLE', 'Save files kept changing during the backup (autosave in progress). Try again in a moment.'); }
        before.splice(0, before.length, ...after);
      }
      const verify = await verifyZip(file);
      const sha = await sha256File(file);
      const st = await fsp.stat(file);
      this.ctx.db.run('INSERT INTO backups (id, server_id, created_at, type, path, size, sha256, files, status, validated_at, validation, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, serverId, manifest.createdAt, type, file, st.size, sha, verify.files, 'valid', Date.now(), JSON.stringify({ ok: true, entries: verify.files, bytes: verify.bytes }), note);
      this.ctx.bus.publish('backup.changed', { serverId });
      this.ctx.notifications.notify({ category: 'backupOk', severity: 'success', title: `Backup completed: ${srv.name}`, body: `${type} backup, ${verify.files} files.`, serverId });
      await this.applyRetention(serverId).catch((e) => this.ctx.log.warn('Retention failed', e));
      return this.get(id);
    }).catch((err) => {
      this.ctx.notifications.notify({ category: 'backupFailed', severity: 'error', title: `Backup failed: ${srv.name}`, body: err.message, serverId });
      throw err;
    }));
  }

  _row(r) { return r && { ...r, validation: r.validation ? JSON.parse(r.validation) : null }; }
  get(id) {
    const r = this._row(this.ctx.db.get('SELECT * FROM backups WHERE id = ?', id));
    if (!r) throw new AppError('E_NOT_FOUND', 'Backup not found');
    return r;
  }
  list({ serverId, type } = {}) {
    const where = []; const args = [];
    if (serverId) { where.push('server_id = ?'); args.push(serverId); }
    if (type) { where.push('type = ?'); args.push(type); }
    return this.ctx.db.all(`SELECT * FROM backups ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC`, ...args).map((r) => this._row(r));
  }

  async validate(id, actor = 'local') {
    const b = this.get(id);
    const result = { ok: false, checks: [] };
    try {
      if (!(await exists(b.path))) throw new Error('Archive file is missing');
      result.checks.push('archive present');
      const sha = await sha256File(b.path);
      if (b.sha256 && sha !== b.sha256) throw new Error('SHA-256 checksum does not match the value recorded at creation');
      result.checks.push('sha256 matches');
      const v = await verifyZip(b.path);
      result.checks.push(`${v.files} entries CRC-verified`);
      const manifest = JSON.parse((await readEntry(b.path, 'manifest.json')).toString('utf8'));
      if (manifest.format !== 'ssm-backup') throw new Error('Manifest is not an SSM backup manifest');
      result.checks.push('manifest valid');
      result.ok = true;
    } catch (err) { result.error = err.message; }
    this.ctx.db.run('UPDATE backups SET status = ?, validated_at = ?, validation = ? WHERE id = ?', result.ok ? 'valid' : 'invalid', Date.now(), JSON.stringify(result), id);
    this.ctx.audit.record({ actor, action: 'backup.validate', serverId: b.server_id, target: id, result: result.ok ? 'ok' : 'failed', details: result });
    this.ctx.bus.publish('backup.changed', { serverId: b.server_id });
    return result;
  }

  async contents(id) {
    const b = this.get(id);
    const entries = await listZip(b.path);
    const manifestBuf = await readEntry(b.path, 'manifest.json');
    return { entries: entries.filter((e) => e.name !== 'manifest.json'), manifest: manifestBuf ? JSON.parse(manifestBuf.toString('utf8')) : null };
  }

  /**
   * Restore a backup. Requires the server stopped and `confirm: true`.
   * Creates a restore point of the current state first; if restoring fails the
   * restore point is restored back.
   */
  async restore(id, { confirm = false, includeConfig = true, includeSaves = true, actor = 'local' } = {}) {
    if (!confirm) throw new AppError('E_CONFIRM_REQUIRED', 'Restoring overwrites current saves. Confirmation is required.');
    const b = this.get(id);
    const srv = this.ctx.registry.get(b.server_id);
    if (this.ctx.supervisor.isActive(srv.id)) throw new AppError('E_SERVER_RUNNING', 'Stop the server before restoring a backup.');
    const check = await this.validate(id, actor);
    if (!check.ok) throw new AppError('E_BACKUP_INVALID', `The backup failed validation: ${check.error}`);
    return this.ctx.audit.wrap({ actor, action: 'backup.restore', serverId: srv.id, target: id, details: { includeConfig, includeSaves } }, async () => {
      let restorePoint = null;
      try { restorePoint = await this.create(srv.id, { type: 'pre-restore', note: `Before restoring ${id}`, actor: 'system' }); } catch (err) {
        if (err.code !== 'E_NOTHING_TO_BACKUP') throw new AppError('E_RESTORE_POINT', `Could not create a restore point, restore aborted: ${err.message}`);
      }
      const saveRoot = this.saveRoot(srv);
      const cfgDir = layout.configDir(srv.installDir);
      try {
        await this._extractParts(b.path, saveRoot, cfgDir, { saves: includeSaves, config: includeConfig });
      } catch (err) {
        if (restorePoint) {
          await this._extractParts(restorePoint.path, saveRoot, cfgDir, { saves: true, config: true }).catch((e) => this.ctx.log.error('Rollback of failed restore failed', e));
        }
        throw new AppError('E_RESTORE_FAILED', `Restore failed and the previous state was put back: ${err.message}`);
      }
      return { restored: true, restorePointId: restorePoint ? restorePoint.id : null };
    });
  }

  /** Extract saves/ into the save root and config/ into the server config folder (each path-checked). */
  async _extractParts(file, saveRoot, cfgDir, { saves, config }) {
    if (saves) await extractZip(file, saveRoot, { overwrite: true, map: (n) => (n.startsWith('saves/') && n.length > 6 ? n.slice(6) : null) });
    if (config) await extractZip(file, cfgDir, { overwrite: true, map: (n) => (n.startsWith('config/') && n.length > 7 ? n.slice(7) : null) });
  }

  async remove(id, { confirm = false, actor = 'local' } = {}) {
    if (!confirm) throw new AppError('E_CONFIRM_REQUIRED', 'Deleting a backup requires confirmation.');
    const b = this.get(id);
    await safeRemove(b.path, [this.root(), this.ctx.paths.backups]);
    this.ctx.db.run('DELETE FROM backups WHERE id = ?', id);
    this.ctx.audit.record({ actor, action: 'backup.delete', serverId: b.server_id, target: id, details: { type: b.type, created: b.created_at } });
    this.ctx.bus.publish('backup.changed', { serverId: b.server_id });
    return { deleted: true };
  }

  async exportTo(id, destFile, actor = 'local') {
    const b = this.get(id);
    if (await exists(destFile)) throw new AppError('E_EXISTS', 'The destination file already exists.');
    await fsp.copyFile(b.path, destFile);
    if ((await sha256File(destFile)) !== b.sha256) { await fsp.rm(destFile, { force: true }); throw new AppError('E_COPY_VERIFY', 'Exported copy failed checksum verification.'); }
    this.ctx.audit.record({ actor, action: 'backup.export', serverId: b.server_id, target: id, details: { dest: destFile } });
    return { path: destFile };
  }

  /** Upload (import) a .sav file into the server's session folder. Never overwrites silently. */
  async importSave(serverId, file, { overwrite = false, actor = 'local' } = {}) {
    if (!/\.sav$/i.test(file)) throw new AppError('E_VALIDATION', 'Only .sav files can be imported.');
    const srv = this.ctx.registry.get(serverId);
    const st = await fsp.stat(file);
    if (!st.isFile() || st.size < 64) throw new AppError('E_VALIDATION', 'The selected file is not a valid save file.');
    const dir = layout.sessionSaveDir(this.saveRoot(srv));
    await fsp.mkdir(dir, { recursive: true });
    const dest = path.join(dir, path.basename(file));
    if (await exists(dest)) {
      if (!overwrite) throw new AppError('E_EXISTS', `A save named ${path.basename(file)} already exists. Confirm overwriting to continue (a restore point is created first).`);
      await this.create(serverId, { type: 'restore-point', note: `Before overwriting ${path.basename(file)}`, actor: 'system' });
    }
    await fsp.copyFile(file, dest);
    this.ctx.audit.record({ actor, action: 'save.upload', serverId, target: path.basename(file), details: { size: st.size, overwrite } });
    return { path: dest };
  }

  /** Delete old scheduled/automatic backups according to the configured retention policy. */
  async applyRetention(serverId) {
    const pol = this.ctx.settings.get('backups');
    if (!pol.retentionEnabled) return { deleted: 0 };
    let deleted = 0;
    const all = this.list({ serverId });
    const groups = { scheduled: all.filter((b) => b.type === 'scheduled'), automatic: all.filter((b) => AUTOMATIC.has(b.type)) };
    const limits = { scheduled: pol.keepScheduled, automatic: pol.keepAutomatic };
    for (const [g, items] of Object.entries(groups)) {
      const victims = items.slice(limits[g]);
      if (pol.maxAgeDays > 0) for (const b of items.slice(0, limits[g])) if (Date.now() - b.created_at > pol.maxAgeDays * 86400000) victims.push(b);
      for (const b of victims) {
        await safeRemove(b.path, [this.root(), this.ctx.paths.backups]).catch(() => {});
        this.ctx.db.run('DELETE FROM backups WHERE id = ?', b.id);
        this.ctx.audit.record({ actor: 'system', action: 'backup.rotate', serverId, target: b.id, details: { type: b.type, policy: g } });
        deleted++;
      }
    }
    if (deleted) this.ctx.bus.publish('backup.changed', { serverId });
    return { deleted };
  }

  /** Re-register archives found on disk that are missing from the database (e.g. after migration). */
  async rescan(serverId) {
    const dir = path.join(this.root(), serverId);
    let added = 0;
    for (const f of await fsp.readdir(dir).catch(() => [])) {
      if (!f.endsWith('.zip')) continue;
      const full = path.join(dir, f);
      if (this.ctx.db.get('SELECT 1 AS x FROM backups WHERE path = ?', full)) continue;
      try {
        const m = JSON.parse((await readEntry(full, 'manifest.json')).toString('utf8'));
        if (m.format !== 'ssm-backup' || !isInside(this.root(), full)) continue;
        const st = await fsp.stat(full);
        this.ctx.db.run('INSERT OR IGNORE INTO backups (id, server_id, created_at, type, path, size, sha256, files, status, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', m.id, serverId, m.createdAt, m.type, full, st.size, await sha256File(full), m.files.length, 'unverified', m.note || '');
        added++;
      } catch { /* not a backup */ }
    }
    if (added) this.ctx.bus.publish('backup.changed', { serverId });
    return { added };
  }
}

module.exports = { Backups, TYPES };
