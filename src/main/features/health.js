'use strict';
/**
 * Health monitoring. Every value stored here is a real measurement:
 *  - CPU / memory from the OS process table (procstats)
 *  - responsiveness + latency from the UDP Lightweight Query
 *  - players / tick rate / session from QueryServerState (requires API access)
 *  - disk free from the volume holding the installation
 * Values that could not be measured are stored as NULL and shown as
 * "unavailable" in the UI — never estimated.
 */
const os = require('node:os');
const layout = require('../server/layout');
const { pollServerState } = require('../server/query');
const { CpuTracker } = require('../server/procstats');
const { diskSpace, exists } = require('../core/fsutil');
const { readAppManifest } = require('../steam/steamcmd');

class Health {
  constructor(ctx) {
    this.ctx = ctx;
    this.cpu = new CpuTracker();
    this.latest = new Map(); // serverId -> telemetry snapshot
    this.timers = [];
    this.lastRollupHour = null;
    this.alerts = new Map(); // `${id}:${kind}` -> since
    this.sampling = false;
  }

  snapshot(id) {
    return this.latest.get(id) || { cpu: null, memBytes: null, players: null, playerLimit: null, tickRate: null, responsive: null, latencyMs: null, session: null, gamePhase: null, techTier: null, totalGameDuration: null, isPaused: null, query: null, disk: null, install: null, sampledAt: null, apiAt: null, queryAt: null, apiError: null };
  }
  _patch(id, patch) { const s = { ...this.snapshot(id), ...patch }; this.latest.set(id, s); return s; }

  start() {
    const mon = () => this.ctx.settings.get('monitoring');
    const loop = (fn, getMs) => {
      const run = async () => {
        try { await fn(); } catch (err) { this.ctx.log.warn('Health loop error', err); }
        const t = setTimeout(run, getMs());
        if (t.unref) t.unref();
        this.timers.push(t);
        if (this.timers.length > 20) this.timers.splice(0, this.timers.length - 10);
      };
      const t = setTimeout(run, 1500);
      if (t.unref) t.unref();
      this.timers.push(t);
    };
    loop(() => this.sampleProcesses(), () => mon().sampleSeconds * 1000);
    loop(() => this.pollServers(), () => mon().apiPollSeconds * 1000);
    loop(() => this.checkDisksAndInstalls(), () => 5 * 60000);
    loop(() => this.rollup(), () => 10 * 60000);
  }

  stop() { for (const t of this.timers) clearTimeout(t); this.timers = []; }

  async sampleProcesses() {
    if (this.sampling) return;
    this.sampling = true;
    try {
      const pids = this.ctx.supervisor.runningPids();
      const ids = Object.keys(pids);
      if (!ids.length) return;
      const stats = await this.ctx.probe.sample(Object.values(pids));
      const now = Date.now();
      const totalMem = os.totalmem();
      for (const id of ids) {
        const pid = pids[id];
        const st = stats[pid];
        if (!st) {
          this.cpu.forget(pid);
          if (!this.ctx.supervisor.status(id).owned) this.ctx.supervisor.attachedGone(id);
          continue;
        }
        const cpu = this.cpu.percent(pid, st.cpuMs, now);
        const snap = this._patch(id, { cpu, memBytes: st.rss, memPercent: totalMem ? (st.rss / totalMem) * 100 : null, sampledAt: now, pid });
        const fresh = (t) => t && now - t < this.ctx.settings.get('monitoring').apiPollSeconds * 2500;
        this.ctx.db.run('INSERT INTO metrics (server_id, ts, cpu, mem_bytes, players, tick_rate, responsive, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          id, now, cpu, st.rss, fresh(snap.apiAt) ? snap.players : null, fresh(snap.apiAt) ? snap.tickRate : null,
          fresh(snap.queryAt) || snap.responsive === false ? (snap.responsive ? 1 : 0) : null, fresh(snap.queryAt) ? snap.latencyMs : null);
        this.ctx.bus.publish('server.metrics', { id, ...snap });
        this._thresholds(id, snap);
      }
    } finally { this.sampling = false; }
  }

  async pollServers() {
    for (const srv of this.ctx.registry.list()) {
      const st = this.ctx.supervisor.status(srv.id);
      if (!['running', 'attached', 'starting'].includes(st.status)) {
        if (this.latest.has(srv.id)) this._patch(srv.id, { cpu: null, memBytes: null, players: null, tickRate: null, responsive: null, latencyMs: null });
        continue;
      }
      const now = Date.now();
      try {
        const q = await pollServerState('127.0.0.1', srv.config.launch.port, { timeoutMs: 3000 });
        this._patch(srv.id, { responsive: true, latencyMs: q.latencyMs, query: { state: q.state, netCL: q.netCL, name: q.name }, queryAt: now });
        this.alerts.delete(`${srv.id}:unresponsive`);
        if (q.netCL && q.netCL !== srv.config.cache.netCL) this.ctx.supervisor._cacheNetCL(srv.id, q.netCL);
      } catch {
        if (st.status !== 'starting') {
          this._patch(srv.id, { responsive: false, latencyMs: null, queryAt: now });
          this._alert(srv, 'unresponsive', this.ctx.settings.get('monitoring').unresponsiveSeconds * 1000, () => ({ category: 'crash', severity: 'warning', title: `${srv.name} is not responding`, body: 'The server has not answered the UDP query. It may be frozen or overloaded.' }));
        }
      }
      if (this.ctx.supervisor.hasToken(srv.id) && st.status !== 'starting') {
        try {
          const res = await this.ctx.supervisor.api(srv.id).queryState();
          const g = res.data && res.data.serverGameState;
          if (g) {
            const prev = this.snapshot(srv.id).players;
            this._patch(srv.id, { players: g.numConnectedPlayers, playerLimit: g.playerLimit, tickRate: g.averageTickRate, session: g.activeSessionName, techTier: g.techTier, gamePhase: g.gamePhase, isPaused: g.isGamePaused, isGameRunning: g.isGameRunning, totalGameDuration: g.totalGameDuration, autoLoadSessionName: g.autoLoadSessionName, apiAt: now, apiError: null, apiLatencyMs: res.latency });
            if (prev !== null && prev !== g.numConnectedPlayers) this.ctx.db.run('INSERT INTO player_events (server_id, run_id, ts, kind, player, source) VALUES (?, ?, ?, ?, ?, ?)', srv.id, st.runId, now, 'count', String(g.numConnectedPlayers), 'api');
          }
        } catch (err) { this._patch(srv.id, { apiError: err.message }); }
      }
    }
  }

  _alert(srv, kind, afterMs, build) {
    const key = `${srv.id}:${kind}`;
    if (!this.alerts.has(key)) { this.alerts.set(key, { since: Date.now(), sent: false }); return; }
    const a = this.alerts.get(key);
    if (!a.sent && Date.now() - a.since >= afterMs) { a.sent = true; this.ctx.notifications.notify({ ...build(), serverId: srv.id }); }
  }

  _thresholds(id, snap) {
    const m = this.ctx.settings.get('monitoring');
    const srv = this.ctx.registry.find(id);
    if (!srv) return;
    if (snap.cpu !== null && snap.cpu >= m.cpuWarn) this._alert(srv, 'cpu', 5 * 60000, () => ({ category: 'maintenance', severity: 'warning', title: `${srv.name}: high CPU usage`, body: `CPU usage has been above ${m.cpuWarn}% for 5 minutes.` }));
    else this.alerts.delete(`${id}:cpu`);
    if (snap.memPercent !== null && snap.memPercent >= m.memWarnPercent) this._alert(srv, 'mem', 2 * 60000, () => ({ category: 'maintenance', severity: 'warning', title: `${srv.name}: high memory usage`, body: `The server uses ${snap.memPercent.toFixed(0)}% of system memory.` }));
    else this.alerts.delete(`${id}:mem`);
  }

  async checkDisksAndInstalls() {
    const m = this.ctx.settings.get('monitoring');
    for (const srv of this.ctx.registry.list()) {
      try {
        const d = await diskSpace(srv.installDir);
        const manifest = await readAppManifest(srv.installDir).catch(() => null);
        const exe = await exists(layout.serverExecutable(srv.installDir));
        const install = { exe, manifest: !!manifest, fullyInstalled: !!(manifest && manifest.fullyInstalled), buildId: manifest ? manifest.buildId : null, checkedAt: Date.now() };
        this._patch(srv.id, { disk: { free: d.free, total: d.total }, install });
        if (d.free < m.diskWarnGb * 1024 ** 3) this._alert(srv, 'disk', 0, () => ({ category: 'lowDisk', severity: 'warning', title: 'Low disk space', body: `Only ${(d.free / 1024 ** 3).toFixed(1)} GB free on the drive of ${srv.name}.` }));
        else this.alerts.delete(`${srv.id}:disk`);
        if (!exe && !this.ctx.supervisor.status(srv.id).busy) this._alert(srv, 'install', 0, () => ({ category: 'installError', severity: 'error', title: `${srv.name}: server files missing`, body: 'The server executable was not found. Install or repair the server.' }));
      } catch (err) { this.ctx.log.warn(`Disk check failed for ${srv.name}`, err); }
    }
    this.alerts.forEach((a, k) => { if (k.endsWith(':disk') && a.sent) a.sent = Date.now() - a.since < 6 * 3600000; });
  }

  /** Aggregate completed hours into metrics_hourly and prune old samples. */
  rollup() {
    const m = this.ctx.settings.get('monitoring');
    const hour = Math.floor(Date.now() / 3600000) * 3600000;
    const from = (this.ctx.db.get('SELECT MAX(hour) AS h FROM metrics_hourly').h || (hour - 72 * 3600000)) + 3600000;
    for (let h = Math.max(from, hour - 72 * 3600000); h < hour; h += 3600000) {
      this.ctx.db.run(`INSERT OR REPLACE INTO metrics_hourly (server_id, hour, samples, cpu_avg, cpu_max, mem_avg, mem_max, players_avg, players_max, tick_avg, responsive_ratio)
        SELECT server_id, ?, COUNT(*), AVG(cpu), MAX(cpu), AVG(mem_bytes), MAX(mem_bytes), AVG(players), MAX(players), AVG(tick_rate), AVG(responsive)
        FROM metrics WHERE ts >= ? AND ts < ? GROUP BY server_id`, h, h, h + 3600000);
    }
    this.ctx.db.run('DELETE FROM metrics WHERE ts < ?', Date.now() - m.keepRawHours * 3600000);
    this.ctx.db.run('DELETE FROM metrics_hourly WHERE hour < ?', Date.now() - m.keepHourlyDays * 86400000);
  }

  /**
   * History for charts. Uses raw samples (bucketed to <= points) when inside
   * the raw retention window, otherwise hourly aggregates.
   */
  history(serverId, { rangeMs = 3600000, points = 240 } = {}) {
    const since = Date.now() - rangeMs;
    const m = this.ctx.settings.get('monitoring');
    if (rangeMs <= m.keepRawHours * 3600000) {
      const bucket = Math.max(1000, Math.floor(rangeMs / points));
      const rows = this.ctx.db.all(`SELECT (ts / ?) * ? AS t, AVG(cpu) AS cpu, AVG(mem_bytes) AS mem, MAX(players) AS players, AVG(tick_rate) AS tick, AVG(responsive) AS responsive, AVG(latency_ms) AS latency, COUNT(*) AS n
        FROM metrics WHERE server_id = ? AND ts >= ? GROUP BY t ORDER BY t`, bucket, bucket, serverId, since);
      return { resolution: 'raw', bucketMs: bucket, rows };
    }
    const rows = this.ctx.db.all('SELECT hour AS t, cpu_avg AS cpu, cpu_max, mem_avg AS mem, mem_max, players_max AS players, tick_avg AS tick, responsive_ratio AS responsive, samples AS n FROM metrics_hourly WHERE server_id = ? AND hour >= ? ORDER BY hour', serverId, since);
    return { resolution: 'hourly', bucketMs: 3600000, rows };
  }

  /** Health indicators for the dashboard. */
  indicators(serverId) {
    const snap = this.snapshot(serverId);
    const st = this.ctx.supervisor.status(serverId);
    const m = this.ctx.settings.get('monitoring');
    const active = ['running', 'attached', 'starting', 'stopping'].includes(st.status);
    const items = [];
    const add = (key, label, state, detail) => items.push({ key, label, state, detail });
    add('process', 'Process', active ? 'ok' : st.status === 'crashed' ? 'error' : 'idle', active ? `PID ${st.pid ?? '?'}${st.owned ? '' : ' (attached)'}` : st.status);
    add('responsive', 'Responsiveness', !active ? 'idle' : snap.responsive === null ? 'unknown' : snap.responsive ? 'ok' : 'error', snap.latencyMs != null ? `${snap.latencyMs} ms query latency` : 'no query response yet');
    add('cpu', 'CPU', !active || snap.cpu === null ? 'unknown' : snap.cpu >= m.cpuWarn ? 'warning' : 'ok', snap.cpu === null ? 'unavailable' : `${snap.cpu.toFixed(1)}%`);
    add('memory', 'Memory', !active || snap.memBytes === null ? 'unknown' : snap.memPercent >= m.memWarnPercent ? 'warning' : 'ok', snap.memBytes === null ? 'unavailable' : `${(snap.memBytes / 1024 ** 3).toFixed(2)} GB`);
    add('disk', 'Disk', !snap.disk ? 'unknown' : snap.disk.free < m.diskWarnGb * 1024 ** 3 ? 'warning' : 'ok', snap.disk ? `${(snap.disk.free / 1024 ** 3).toFixed(1)} GB free` : 'not checked yet');
    add('install', 'Installation', !snap.install ? 'unknown' : snap.install.exe && snap.install.fullyInstalled ? 'ok' : 'error', !snap.install ? 'not checked yet' : snap.install.exe ? (snap.install.fullyInstalled ? `build ${snap.install.buildId}` : 'Steam reports the install as incomplete') : 'executable missing');
    add('api', 'Server API', !this.ctx.supervisor.hasToken(serverId) ? 'unknown' : snap.apiError ? 'warning' : snap.apiAt ? 'ok' : 'unknown', !this.ctx.supervisor.hasToken(serverId) ? 'not configured (player count & tick rate unavailable)' : snap.apiError || (snap.apiAt ? 'connected' : 'waiting'));
    const score = items.filter((i) => i.state !== 'unknown' && i.state !== 'idle');
    const overall = items.some((i) => i.state === 'error') ? 'error' : items.some((i) => i.state === 'warning') ? 'warning' : score.length ? 'ok' : 'unknown';
    return { overall, items, snapshot: snap };
  }
}

module.exports = { Health };
