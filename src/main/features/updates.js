'use strict';
/**
 * Update center.
 *  - Dedicated server: installed build (appmanifest) vs. published build of the
 *    configured branch (SteamCMD app_info_print).
 *  - Mods: installed versions vs. newest compatible FICSIT release (mods.js).
 *  - SteamCMD: self-updates on every run; status and last run are reported.
 *  - Application: latest GitHub release of this repository.
 *
 * Server update pipeline: lock → (graceful stop) → pre-update backup →
 * optional rollback copy → SteamCMD app_update validate → verify manifest &
 * executable → restart if it was running and wait for it to respond. Any
 * failure restores the rollback copy when one was taken.
 */
const fsp = require('node:fs/promises');
const path = require('node:path');
const layout = require('../server/layout');
const { readAppManifest } = require('../steam/steamcmd');
const { fetchJson } = require('../core/http');
const { exists, listFiles, safeRemove, diskSpace, dirSize } = require('../core/fsutil');
const { AppError, sleep } = require('../core/util');
const { zonedParts } = require('./scheduler');

const APP_RELEASES_URL = 'https://api.github.com/repos/SuperSeller100X/SatisfactoryServerManager/releases/latest';

function compareSemver(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = String(b).replace(/^v/, '').split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0; const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

/** True when `now` falls inside the configured maintenance window (local time zone of scheduler). */
function inUpdateWindow(pol, tz, now = Date.now()) {
  const p = zonedParts(now, tz);
  if (!pol.windowDays.includes(p.dow)) return false;
  const mins = p.hour * 60 + p.minute;
  const [sh, sm] = pol.windowStart.split(':').map(Number);
  const [eh, em] = pol.windowEnd.split(':').map(Number);
  const s = sh * 60 + sm; const e = eh * 60 + em;
  return s <= e ? mins >= s && mins < e : mins >= s || mins < e;
}

class Updates {
  constructor(ctx) {
    this.ctx = ctx;
    this.appInfo = null;
    this.appRelease = null;
    this.lastCheck = null;
    this.progress = new Map();
    this.timer = null;
  }

  _progress(serverId, data) {
    this.progress.set(serverId, { ...data, ts: Date.now() });
    this.ctx.bus.publish('update.changed', { serverId, progress: this.progress.get(serverId) });
  }

  async publishedBuilds({ force = false } = {}) {
    if (!force && this.appInfo && Date.now() - this.appInfo.fetchedAt < 30 * 60000) return this.appInfo;
    this.appInfo = await this.ctx.steamcmd.fetchAppInfo();
    return this.appInfo;
  }

  async serverStatus(serverId) {
    const srv = this.ctx.registry.get(serverId);
    const manifest = await readAppManifest(srv.installDir);
    const branch = srv.config.branch || 'public';
    const pub = this.appInfo && this.appInfo.branches[branch];
    const rollback = await this.rollbackInfo(serverId);
    return {
      serverId, branch,
      installed: manifest ? { buildId: manifest.buildId, branch: manifest.branch, fullyInstalled: manifest.fullyInstalled, lastUpdated: manifest.lastUpdated } : null,
      available: pub ? { buildId: pub.buildId, timeUpdated: pub.timeUpdated } : null,
      updateAvailable: !!(manifest && pub && pub.buildId && manifest.buildId !== pub.buildId),
      branchMismatch: !!(manifest && manifest.branch !== branch),
      checkedAt: this.appInfo ? this.appInfo.fetchedAt : null,
      progress: this.progress.get(serverId) || null,
      rollback,
      netCL: srv.config.cache.netCL,
    };
  }

  async checkApp() {
    const { version } = require('../../../package.json');
    try {
      const rel = await fetchJson(APP_RELEASES_URL, { headers: { accept: 'application/vnd.github+json' } });
      const latest = rel && rel.tag_name ? rel.tag_name.replace(/^v/, '') : null;
      this.appRelease = { current: version, latest, url: rel ? rel.html_url : null, publishedAt: rel ? rel.published_at : null, updateAvailable: !!(latest && compareSemver(version, latest) < 0), checkedAt: Date.now() };
    } catch (err) {
      this.appRelease = { current: version, latest: null, updateAvailable: false, checkedAt: Date.now(), error: err.details && err.details.status === 404 ? 'No releases have been published for this application yet.' : err.message };
    }
    return this.appRelease;
  }

  /** Full check across servers, mods, SteamCMD and the app. Sends notifications for new findings. */
  async checkAll({ notify = true, actor = 'system' } = {}) {
    const result = { servers: [], mods: [], steamcmd: await this.ctx.steamcmd.status(), app: null, errors: [] };
    if (this.ctx.registry.list().length) {
      try { await this.publishedBuilds({ force: true }); } catch (err) { result.errors.push(`Steam: ${err.message}`); }
    }
    for (const srv of this.ctx.registry.list()) {
      try {
        const st = await this.serverStatus(srv.id);
        result.servers.push({ ...st, name: srv.name });
        if (notify && st.updateAvailable) {
          const prev = this.ctx.db.get("SELECT to_version FROM updates WHERE server_id = ? AND kind = 'server' AND status = 'available' ORDER BY id DESC LIMIT 1", srv.id);
          if (!prev || prev.to_version !== st.available.buildId) {
            this.ctx.db.run('INSERT INTO updates (ts, server_id, kind, from_version, to_version, status) VALUES (?, ?, ?, ?, ?, ?)', Date.now(), srv.id, 'server', st.installed.buildId, st.available.buildId, 'available');
            this.ctx.notifications.notify({ category: 'updateAvailable', severity: 'info', title: `Server update available: ${srv.name}`, body: `Build ${st.installed.buildId} → ${st.available.buildId} (${st.branch} branch).`, serverId: srv.id });
          }
        }
      } catch (err) { result.errors.push(`${srv.name}: ${err.message}`); }
      try {
        const m = await this.ctx.mods.checkUpdates(srv.id);
        if (m.updates.length) {
          result.mods.push({ serverId: srv.id, name: srv.name, updates: m.updates });
          if (notify) this.ctx.notifications.notify({ category: 'updateAvailable', severity: 'info', title: `Mod updates available: ${srv.name}`, body: m.updates.map((u) => `${u.name} ${u.installed} → ${u.latest}`).slice(0, 5).join(', '), serverId: srv.id });
        }
      } catch (err) { if (err.code !== 'E_NO_MODS') result.errors.push(`${srv.name} mods: ${err.message}`); }
    }
    if (this.ctx.settings.get('updates').checkApp) result.app = await this.checkApp();
    this.lastCheck = { at: Date.now(), result };
    this.ctx.bus.publish('update.changed', {});
    return result;
  }

  history(serverId, limit = 100) {
    const rows = serverId ? this.ctx.db.all('SELECT * FROM updates WHERE server_id = ? ORDER BY id DESC LIMIT ?', serverId, limit) : this.ctx.db.all('SELECT * FROM updates ORDER BY id DESC LIMIT ?', limit);
    return rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
  }

  policyFor(srv) {
    const p = srv.config.updates.policy;
    return p === 'inherit' ? this.ctx.settings.get('updates').autoServerUpdate : p;
  }
  keepRollback(srv) {
    const v = srv.config.updates.keepRollbackCopy;
    return v === null || v === undefined ? this.ctx.settings.get('updates').keepRollbackCopy : v;
  }

  rollbackDir(serverId) { return path.join(this.ctx.paths.rollback, serverId); }
  async rollbackInfo(serverId) {
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(this.rollbackDir(serverId), 'rollback.json'), 'utf8'));
      return { available: true, ...meta };
    } catch { return { available: false }; }
  }

  /** Copy server binaries (not saves, mods or Steam temp data) so an update can be rolled back. */
  async _takeRollbackCopy(srv, manifest) {
    const dest = this.rollbackDir(srv.id);
    await safeRemove(dest, [this.ctx.paths.rollback]).catch(() => {});
    const size = await dirSize(srv.installDir);
    const space = await diskSpace(this.ctx.paths.rollback);
    if (space.free < size.bytes * 1.1) throw new AppError('E_DISK_SPACE', 'Not enough disk space to keep a rollback copy of the server files.');
    const files = await listFiles(srv.installDir, { filter: (rel) => !/^FactoryGame\/Saved(\/|$)|^steamapps\/(downloading|temp|shadercache)(\/|$)/i.test(rel) });
    const tree = path.join(dest, 'files');
    for (const rel of files) {
      await fsp.mkdir(path.dirname(path.join(tree, rel)), { recursive: true });
      await fsp.copyFile(path.join(srv.installDir, rel), path.join(tree, rel));
    }
    await fsp.writeFile(path.join(dest, 'rollback.json'), JSON.stringify({ buildId: manifest ? manifest.buildId : null, branch: manifest ? manifest.branch : null, createdAt: Date.now(), files: files.length }));
    return { files: files.length };
  }

  async _restoreRollback(srv) {
    const dir = this.rollbackDir(srv.id);
    const tree = path.join(dir, 'files');
    if (!(await exists(tree))) throw new AppError('E_NO_ROLLBACK', 'No rollback copy is available for this server.');
    const keep = new Set(await listFiles(tree));
    const skip = (rel) => /^FactoryGame\/(Saved|Mods)(\/|$)/i.test(rel);
    for (const rel of keep) {
      await fsp.mkdir(path.dirname(path.join(srv.installDir, rel)), { recursive: true });
      await fsp.copyFile(path.join(tree, rel), path.join(srv.installDir, rel));
    }
    for (const rel of await listFiles(srv.installDir)) {
      if (!keep.has(rel) && !skip(rel) && !/^steamapps\//i.test(rel)) await fsp.rm(path.join(srv.installDir, rel), { force: true });
    }
    return JSON.parse(await fsp.readFile(path.join(dir, 'rollback.json'), 'utf8'));
  }

  async rollback(serverId, { actor = 'local', confirm = false } = {}) {
    if (!confirm) throw new AppError('E_CONFIRM_REQUIRED', 'Rolling back replaces the server files. Confirmation is required.');
    const srv = this.ctx.registry.get(serverId);
    if (this.ctx.supervisor.isActive(serverId)) throw new AppError('E_SERVER_RUNNING', 'Stop the server before rolling back.');
    return this.ctx.locks.run(serverId, 'rollback', () => this.ctx.audit.wrap({ actor, action: 'update.rollback', serverId, target: srv.name }, async () => {
      const before = await readAppManifest(srv.installDir);
      const meta = await this._restoreRollback(srv);
      const after = await readAppManifest(srv.installDir);
      const ok = await exists(layout.serverExecutable(srv.installDir));
      this.ctx.db.run('INSERT INTO updates (ts, server_id, kind, from_version, to_version, status, details) VALUES (?, ?, ?, ?, ?, ?, ?)', Date.now(), serverId, 'rollback', before && before.buildId, after && after.buildId, ok ? 'completed' : 'failed', JSON.stringify(meta));
      if (!ok) throw new AppError('E_ROLLBACK_VERIFY', 'Server executable missing after rollback.');
      this.ctx.bus.publish('update.changed', { serverId });
      return { buildId: after && after.buildId, note: 'Steam will report an update as available again; disable automatic updates for this server if you want to stay on this build.' };
    }));
  }

  /**
   * Update a server. Never runs without a pre-update backup (unless no save
   * data exists yet) and verifies the result.
   */
  async updateServer(serverId, { actor = 'local', trigger = 'manual', onlyIfEmpty = false, validateOnly = false } = {}) {
    const srv = this.ctx.registry.get(serverId);
    const sup = this.ctx.supervisor;
    return this.ctx.locks.run(serverId, validateOnly ? 'validate' : 'update', async () => {
      const before = await readAppManifest(srv.installDir);
      const wasRunning = sup.isActive(serverId);
      const rec = this.ctx.db.run('INSERT INTO updates (ts, server_id, kind, from_version, status, details) VALUES (?, ?, ?, ?, ?, ?)', Date.now(), serverId, validateOnly ? 'validate' : 'server', before && before.buildId, 'running', JSON.stringify({ trigger }));
      const updId = Number(rec.lastInsertRowid);
      const steps = [];
      const step = (s) => { steps.push({ at: Date.now(), step: s }); this._progress(serverId, { phase: s, percent: null }); sup.sys(serverId, `[Update] ${s}`); };
      let backupId = null; let rolledBack = false;
      try {
        if (wasRunning && onlyIfEmpty && sup.hasToken(serverId)) {
          const st = await sup.api(serverId).queryState().catch(() => null);
          const players = st && st.data ? st.data.serverGameState.numConnectedPlayers : null;
          if (players > 0) { this.ctx.db.run('UPDATE updates SET status = ?, details = ? WHERE id = ?', 'skipped', JSON.stringify({ reason: `${players} players online` }), updId); this._progress(serverId, null); return { skipped: true, message: `${players} player(s) online` }; }
        }
        if (wasRunning) { step('Stopping server gracefully'); sup.setBusy(serverId, null); await sup.stop(serverId, { reason: validateOnly ? 'Installation validation' : 'Server update', actor }); }
        sup.setBusy(serverId, validateOnly ? 'validating' : 'updating');
        step('Creating pre-update backup');
        try { backupId = (await this.ctx.backups.create(serverId, { type: 'pre-update', note: `Before ${validateOnly ? 'validation' : 'update'} from build ${before ? before.buildId : 'unknown'}`, actor: 'system' })).id; } catch (err) {
          if (err.code !== 'E_NOTHING_TO_BACKUP') throw new AppError('E_BACKUP_REQUIRED', `Update aborted because the pre-update backup failed: ${err.message}`);
          steps.push({ at: Date.now(), step: 'No save data yet — nothing to back up' });
        }
        if (!validateOnly && this.keepRollback(srv) && before) { step('Keeping a rollback copy of the current server files'); await this._takeRollbackCopy(srv, before); }
        step(validateOnly ? 'Validating files with SteamCMD' : 'Downloading update with SteamCMD');
        await this.ctx.steamcmd.installApp(srv.installDir, {
          branch: srv.config.branch, validate: true, label: `${validateOnly ? 'validate' : 'update'}:${srv.name}`,
          onProgress: (p) => this._progress(serverId, { phase: `SteamCMD: ${p.state}`, percent: p.percent, done: p.done, total: p.total }),
          onLine: (l) => sup.sys(serverId, `[SteamCMD] ${l}`),
        });
        step('Verifying installation');
        const after = await readAppManifest(srv.installDir);
        const exeOk = await exists(layout.serverExecutable(srv.installDir));
        if (!after || !after.fullyInstalled || !exeOk) throw new AppError('E_UPDATE_VERIFY', 'Verification failed: Steam does not report the app as fully installed or the server executable is missing.');
        const target = this.appInfo && this.appInfo.branches[srv.config.branch];
        if (!validateOnly && target && target.buildId && after.buildId !== target.buildId) steps.push({ at: Date.now(), step: `Installed build ${after.buildId} differs from published ${target.buildId} (Steam may have published a newer build meanwhile)` });
        if (this.ctx.settings.get('updates').validateAfterUpdate || wasRunning) {
          step('Starting server to verify it responds');
          sup.setBusy(serverId, null);
          await sup.start(serverId, { trigger: 'update', actor: 'system' });
          const ok = await this._waitResponsive(serverId, 10 * 60000);
          if (!ok) throw new AppError('E_UPDATE_START', 'The updated server did not respond within 10 minutes.');
          if (!wasRunning) { step('Verification complete, stopping again'); await sup.stop(serverId, { reason: 'Post-update verification finished', actor: 'system', forceAfterGrace: false }).catch((e) => steps.push({ at: Date.now(), step: `Could not stop after verification: ${e.message}` })); }
        }
        this.ctx.db.run('UPDATE updates SET to_version = ?, status = ?, backup_id = ?, details = ? WHERE id = ?', after.buildId, 'completed', backupId, JSON.stringify({ trigger, steps }), updId);
        this.ctx.audit.record({ actor, action: validateOnly ? 'server.validate' : 'server.update', serverId, target: srv.name, details: { from: before && before.buildId, to: after.buildId, backupId, trigger } });
        if (!validateOnly) this.ctx.notifications.notify({ category: 'updateOk', severity: 'success', title: `${srv.name} updated`, body: `Build ${before ? before.buildId : '?'} → ${after.buildId}.`, serverId });
        return { from: before && before.buildId, to: after.buildId, backupId, steps };
      } catch (err) {
        steps.push({ at: Date.now(), step: `Failed: ${err.message}` });
        if (!validateOnly && (await this.rollbackInfo(serverId)).available && this.keepRollback(srv)) {
          try { if (sup.isActive(serverId)) await sup.stop(serverId, { reason: 'Rollback after failed update', force: true, actor: 'system' }); await this._restoreRollback(srv); rolledBack = true; steps.push({ at: Date.now(), step: 'Server files restored from the rollback copy' }); } catch (e) { steps.push({ at: Date.now(), step: `Rollback failed: ${e.message}` }); }
        }
        this.ctx.db.run('UPDATE updates SET status = ?, backup_id = ?, details = ? WHERE id = ?', 'failed', backupId, JSON.stringify({ trigger, steps, error: err.message, rolledBack }), updId);
        this.ctx.audit.record({ actor, action: validateOnly ? 'server.validate' : 'server.update', serverId, target: srv.name, result: 'failed', error: err, details: { backupId, rolledBack } });
        this.ctx.notifications.notify({ category: 'updateFailed', severity: 'error', title: `${validateOnly ? 'Validation' : 'Update'} failed: ${srv.name}`, body: `${err.message}${rolledBack ? ' The previous build was restored.' : ''}${backupId ? ' A pre-update backup is available.' : ''}`, serverId });
        throw err;
      } finally {
        sup.setBusy(serverId, null);
        this._progress(serverId, null);
        this.ctx.bus.publish('update.changed', { serverId });
      }
    });
  }

  async _waitResponsive(serverId, timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const st = this.ctx.supervisor.status(serverId);
      if (st.status === 'running' && st.readyAt) return true;
      if (['crashed', 'stopped'].includes(st.status)) return false;
      await sleep(2000);
    }
    return false;
  }

  /** Periodic check + policy-driven automatic updates inside the update window. */
  startAuto() {
    const run = async () => {
      try {
        const res = await this.checkAll({ notify: true });
        const pol = this.ctx.settings.get('updates');
        const tz = this.ctx.settings.get('scheduler').timezone;
        for (const st of res.servers) {
          const srv = this.ctx.registry.find(st.serverId);
          if (!srv || !st.updateAvailable || srv.config.maintenance.enabled) continue;
          if (this.policyFor(srv) === 'window' && inUpdateWindow(pol, tz)) {
            await this.updateServer(srv.id, { actor: 'system', trigger: 'auto-window', onlyIfEmpty: true }).catch((e) => this.ctx.log.warn(`Automatic update of ${srv.name} failed`, e));
          }
        }
        for (const m of res.mods) {
          const srv = this.ctx.registry.find(m.serverId);
          if (!srv || srv.config.maintenance.enabled) continue;
          if (this.ctx.mods.policyFor(srv) === 'window' && inUpdateWindow(pol, tz)) await this.ctx.mods.updateAll(srv.id, { actor: 'system' }).catch((e) => this.ctx.log.warn(`Automatic mod update of ${srv.name} failed`, e));
        }
      } catch (err) { this.ctx.log.warn('Update check failed', err); }
      this.timer = setTimeout(run, this.ctx.settings.get('updates').checkIntervalHours * 3600000);
      if (this.timer.unref) this.timer.unref();
    };
    this.timer = setTimeout(run, 60000);
    if (this.timer.unref) this.timer.unref();
  }
  stop() { clearTimeout(this.timer); }
}

module.exports = { Updates, compareSemver, inUpdateWindow };
