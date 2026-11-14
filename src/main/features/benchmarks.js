'use strict';
/**
 * Performance analysis from recorded measurements only: process samples
 * (metrics table) and run timings (runs table). A benchmark is a named time
 * window; its report is computed from the samples captured during it.
 */
const { newId, AppError } = require('../core/util');

const stats = (vals) => {
  const xs = vals.filter((x) => x !== null && x !== undefined && Number.isFinite(x)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const p = (q) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))];
  return { n: xs.length, min: xs[0], max: xs[xs.length - 1], avg: xs.reduce((a, b) => a + b, 0) / xs.length, p50: p(0.5), p95: p(0.95) };
};

class Benchmarks {
  constructor(ctx) { this.ctx = ctx; this.timers = new Map(); }

  start(serverId, { name, durationMinutes = 30 }, actor = 'local') {
    const srv = this.ctx.registry.get(serverId);
    if (!this.ctx.supervisor.isActive(serverId)) throw new AppError('E_NOT_RUNNING', 'Start the server before recording a benchmark.');
    if (this.ctx.db.get("SELECT 1 AS x FROM benchmarks WHERE server_id = ? AND status = 'running'", serverId)) throw new AppError('E_BUSY', 'A benchmark is already recording for this server.');
    const id = newId('bm_');
    const build = this.ctx.db.get('SELECT build_id FROM runs WHERE server_id = ? ORDER BY id DESC LIMIT 1', serverId);
    this.ctx.db.run('INSERT INTO benchmarks (id, server_id, name, started_at, status, build_id) VALUES (?, ?, ?, ?, ?, ?)', id, serverId, name, Date.now(), 'running', build ? build.build_id : null);
    this.ctx.audit.record({ actor, action: 'benchmark.start', serverId, target: name, details: { durationMinutes } });
    this._arm(id, durationMinutes * 60000);
    return this.get(id);
  }

  _arm(id, ms) { const t = setTimeout(() => this.finish(id).catch((e) => this.ctx.log.warn('Benchmark finish failed', e)), ms); if (t.unref) t.unref(); this.timers.set(id, t); }

  /** On start-up: finish benchmarks interrupted by an app restart with the data captured so far. */
  resume() { for (const b of this.ctx.db.all("SELECT id FROM benchmarks WHERE status = 'running'")) this.finish(b.id, 'interrupted').catch(() => {}); }

  async finish(id, status = 'completed') {
    clearTimeout(this.timers.get(id)); this.timers.delete(id);
    const b = this.ctx.db.get('SELECT * FROM benchmarks WHERE id = ?', id);
    if (!b || b.status !== 'running') return this.get(id);
    const end = Date.now();
    const report = this.report(b.server_id, b.started_at, end);
    this.ctx.db.run('UPDATE benchmarks SET ended_at = ?, status = ?, report = ? WHERE id = ?', end, report.samples ? status : 'no-data', JSON.stringify(report), id);
    return this.get(id);
  }

  report(serverId, from, to) {
    const rows = this.ctx.db.all('SELECT * FROM metrics WHERE server_id = ? AND ts >= ? AND ts <= ? ORDER BY ts', serverId, from, to);
    const runs = this.ctx.db.all('SELECT * FROM runs WHERE server_id = ? AND started_at >= ? AND started_at <= ?', serverId, from - 86400000, to);
    return {
      from, to, samples: rows.length,
      cpu: stats(rows.map((r) => r.cpu)), memBytes: stats(rows.map((r) => r.mem_bytes)), players: stats(rows.map((r) => r.players)),
      tickRate: stats(rows.map((r) => r.tick_rate)), latencyMs: stats(rows.map((r) => r.latency_ms)),
      responsiveRatio: rows.filter((r) => r.responsive !== null).length ? rows.filter((r) => r.responsive === 1).length / rows.filter((r) => r.responsive !== null).length : null,
      unavailable: ['players', 'tick_rate'].filter((k) => rows.every((r) => r[k] === null)),
      timings: this.timings(serverId, runs),
    };
  }

  /** Startup/shutdown timings from real run records. */
  timings(serverId, runs = this.ctx.db.all('SELECT * FROM runs WHERE server_id = ? ORDER BY id DESC LIMIT 50', serverId)) {
    return {
      startupMs: stats(runs.filter((r) => r.ready_at && r.trigger !== 'attached').map((r) => r.ready_at - r.started_at)),
      shutdownMs: stats(runs.filter((r) => r.stop_requested_at && r.ended_at).map((r) => r.ended_at - r.stop_requested_at)),
      uptimeMs: stats(runs.filter((r) => r.ended_at).map((r) => r.ended_at - r.started_at)),
      runs: runs.length,
    };
  }

  get(id) { const r = this.ctx.db.get('SELECT * FROM benchmarks WHERE id = ?', id); if (!r) throw new AppError('E_NOT_FOUND', 'Benchmark not found'); return { ...r, report: r.report ? JSON.parse(r.report) : null }; }
  list(serverId) { return this.ctx.db.all('SELECT * FROM benchmarks WHERE server_id = ? ORDER BY started_at DESC', serverId).map((r) => ({ ...r, report: r.report ? JSON.parse(r.report) : null })); }
  remove(id) { this.ctx.db.run('DELETE FROM benchmarks WHERE id = ?', id); }

  /** Runs (process lifetimes) with per-run resource summaries. */
  runs(serverId, limit = 30) {
    return this.ctx.db.all('SELECT * FROM runs WHERE server_id = ? ORDER BY id DESC LIMIT ?', serverId, limit).map((r) => {
      const agg = this.ctx.db.get('SELECT COUNT(*) AS n, AVG(cpu) AS cpu_avg, MAX(cpu) AS cpu_max, AVG(mem_bytes) AS mem_avg, MAX(mem_bytes) AS mem_max, MAX(players) AS players_max, AVG(tick_rate) AS tick_avg FROM metrics WHERE server_id = ? AND ts >= ? AND ts <= ?', serverId, r.started_at, r.ended_at || Date.now());
      return { ...r, startupMs: r.ready_at ? r.ready_at - r.started_at : null, shutdownMs: r.stop_requested_at && r.ended_at ? r.ended_at - r.stop_requested_at : null, metrics: agg };
    });
  }

  toCsv(id) {
    const b = this.get(id);
    const rows = this.ctx.db.all('SELECT * FROM metrics WHERE server_id = ? AND ts >= ? AND ts <= ? ORDER BY ts', b.server_id, b.started_at, b.ended_at || Date.now());
    const head = 'timestamp,cpu_percent,memory_bytes,players,tick_rate,responsive,query_latency_ms';
    return [head, ...rows.map((r) => [new Date(r.ts).toISOString(), r.cpu ?? '', r.mem_bytes ?? '', r.players ?? '', r.tick_rate ?? '', r.responsive ?? '', r.latency_ms ?? ''].join(','))].join('\r\n');
  }
}

module.exports = { Benchmarks, stats };
