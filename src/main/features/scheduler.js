'use strict';
/**
 * Scheduler for recurring operations. Schedules are 5-field cron expressions
 * evaluated in an IANA time zone (DST-aware via Intl). Next-run times are
 * persisted, so after an application restart missed runs are detected and
 * handled according to each task's policy ('run-once' within the grace window,
 * or 'skip'). Tasks only run while the manager is running.
 */
const { v } = require('../core/validate');
const { newId, AppError } = require('../core/util');

// ---------------------------------------------------------------- cron parsing
const FIELD_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
const NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12, sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function parseField(src, [lo, hi], idx) {
  const set = new Set();
  for (const part of src.toLowerCase().split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid step "${part}"`);
    let a; let b;
    const num = (x) => {
      const n = NAMES[x] !== undefined ? NAMES[x] : Number(x);
      if (!Number.isInteger(n)) throw new Error(`Invalid value "${x}"`);
      return idx === 4 && n === 7 ? 0 : n;
    };
    if (rangePart === '*') { a = lo; b = hi; } else if (rangePart.includes('-')) { const [x, y] = rangePart.split('-'); a = num(x); b = num(y); } else { a = num(rangePart); b = stepPart === undefined ? a : hi; }
    if (a < lo || b > hi || a > b) throw new Error(`Value out of range in "${part}" (allowed ${lo}-${hi})`);
    for (let i = a; i <= b; i += step) set.add(i);
  }
  return set;
}

function parseCron(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) throw new AppError('E_CRON', 'A schedule needs 5 fields: minute hour day-of-month month day-of-week');
  try {
    const f = parts.map((p, i) => parseField(p, FIELD_RANGES[i], i));
    return { minute: f[0], hour: f[1], dom: f[2], month: f[3], dow: f[4], domStar: parts[2] === '*', dowStar: parts[4] === '*' };
  } catch (err) { throw new AppError('E_CRON', `Invalid schedule: ${err.message}`); }
}

const fmtCache = new Map();
function zonedParts(ts, tz) {
  let fmt = fmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
    fmtCache.set(tz, fmt);
  }
  const o = {};
  for (const p of fmt.formatToParts(new Date(ts))) o[p.type] = p.value;
  return { year: +o.year, month: +o.month, day: +o.day, hour: +o.hour % 24, minute: +o.minute, dow: NAMES[o.weekday.toLowerCase().slice(0, 3)] };
}

function matchesDay(c, p) {
  const domOk = c.dom.has(p.day); const dowOk = c.dow.has(p.dow);
  if (c.domStar && c.dowStar) return true;
  if (c.domStar) return dowOk;
  if (c.dowStar) return domOk;
  return domOk || dowOk; // standard cron semantics: either matches
}

/** Next UTC timestamp (ms) strictly after `after` that matches the cron in tz. */
function nextRun(expr, tz, after = Date.now()) {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  let t = Math.floor(after / 60000) * 60000 + 60000;
  const limit = after + 366 * 86400000 * 2;
  while (t < limit) {
    const p = zonedParts(t, tz);
    if (!c.month.has(p.month) || !matchesDay(c, p)) { t += (60 - p.minute) * 60000; continue; } // jump to next local hour
    if (!c.hour.has(p.hour)) { t += (60 - p.minute) * 60000; continue; }
    if (!c.minute.has(p.minute)) { t += 60000; continue; }
    return t;
  }
  return null;
}

/** Human-readable description for common schedules. */
function describeCron(expr) {
  const [mi, h, dom, mon, dow] = String(expr).trim().split(/\s+/);
  const pad = (x) => String(x).padStart(2, '0');
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (/^\*\/\d+$/.test(mi) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `Every ${mi.slice(2)} minutes`;
  if (/^\d+$/.test(mi) && /^\*\/\d+$/.test(h) && dom === '*' && mon === '*' && dow === '*') return `Every ${h.slice(2)} hours at :${pad(mi)}`;
  if (/^\d+$/.test(mi) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `Hourly at :${pad(mi)}`;
  if (/^\d+$/.test(mi) && /^\d+$/.test(h) && dom === '*' && mon === '*') {
    if (dow === '*') return `Daily at ${pad(h)}:${pad(mi)}`;
    try { return `${[...parseField(dow, [0, 6], 4)].map((d) => days[d]).join(', ')} at ${pad(h)}:${pad(mi)}`; } catch { /* fallthrough */ }
  }
  if (/^\d+$/.test(mi) && /^\d+$/.test(h) && /^\d+$/.test(dom) && mon === '*' && dow === '*') return `Monthly on day ${dom} at ${pad(h)}:${pad(mi)}`;
  return `Cron: ${expr}`;
}

// ---------------------------------------------------------------- scheduler
const TASK_TYPES = {
  restart: { label: 'Restart server', needsServer: true },
  backup: { label: 'Create backup', needsServer: true },
  'server-update': { label: 'Update dedicated server', needsServer: true },
  'mod-update': { label: 'Update mods', needsServer: true },
  maintenance: { label: 'Maintenance (backup → update → mods → restart)', needsServer: true },
  'start': { label: 'Start server', needsServer: true },
  'stop': { label: 'Stop server', needsServer: true },
  cleanup: { label: 'Cleanup (retention policies)', needsServer: false },
  'update-check': { label: 'Check for updates', needsServer: false },
  'validate-backups': { label: 'Validate backups', needsServer: false },
};

const taskSchema = v.object({
  name: v.string({ min: 1, max: 80, trim: true }),
  type: v.enum(Object.keys(TASK_TYPES)),
  serverId: v.optional(v.nullable(v.id())),
  cron: v.string({ min: 9, max: 100 }),
  timezone: v.timezone(),
  enabled: v.optional(v.bool()),
  missedPolicy: v.optional(v.enum(['run-once', 'skip'])),
  params: v.optional(v.object({
    warnMinutes: v.optional(v.int({ min: 0, max: 60 })),
    onlyIfEmpty: v.optional(v.bool()),
    skipInMaintenance: v.optional(v.bool()),
    restartAfter: v.optional(v.bool()),
  })),
});

class Scheduler {
  constructor(ctx) {
    this.ctx = ctx;
    this.timer = null;
    this.running = new Set();
    this.handlers = {};
  }

  register(type, fn) { this.handlers[type] = fn; }

  _row(r) { return r && { id: r.id, name: r.name, type: r.type, serverId: r.server_id, cron: r.cron, timezone: r.timezone, enabled: !!r.enabled, params: JSON.parse(r.params), missedPolicy: r.missed_policy, nextRun: r.next_run, lastRun: r.last_run, lastStatus: r.last_status, createdAt: r.created_at, description: describeCron(r.cron), running: this.running.has(r.id) }; }
  list() { return this.ctx.db.all('SELECT * FROM tasks ORDER BY next_run IS NULL, next_run').map((r) => this._row(r)); }
  get(id) { const t = this._row(this.ctx.db.get('SELECT * FROM tasks WHERE id = ?', id)); if (!t) throw new AppError('E_NOT_FOUND', 'Task not found'); return t; }

  create(input, actor = 'local') {
    const t = taskSchema(input);
    parseCron(t.cron);
    if (TASK_TYPES[t.type].needsServer) { if (!t.serverId) throw new AppError('E_VALIDATION', 'This task type needs a server.'); this.ctx.registry.get(t.serverId); }
    const id = newId('task_');
    const next = nextRun(t.cron, t.timezone);
    this.ctx.db.run('INSERT INTO tasks (id, name, type, server_id, cron, timezone, enabled, params, missed_policy, next_run, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, t.name, t.type, t.serverId || null, t.cron, t.timezone, t.enabled === false ? 0 : 1, JSON.stringify(t.params || {}), t.missedPolicy || 'run-once', next, Date.now());
    this.ctx.audit.record({ actor, action: 'scheduler.create', serverId: t.serverId || null, target: t.name, details: t });
    this._changed();
    return this.get(id);
  }

  update(id, input, actor = 'local') {
    const cur = this.get(id);
    const t = taskSchema({ name: cur.name, type: cur.type, serverId: cur.serverId, cron: cur.cron, timezone: cur.timezone, enabled: cur.enabled, missedPolicy: cur.missedPolicy, params: cur.params, ...input });
    parseCron(t.cron);
    const next = t.enabled === false ? null : nextRun(t.cron, t.timezone);
    this.ctx.db.run('UPDATE tasks SET name = ?, type = ?, server_id = ?, cron = ?, timezone = ?, enabled = ?, params = ?, missed_policy = ?, next_run = ? WHERE id = ?',
      t.name, t.type, t.serverId || null, t.cron, t.timezone, t.enabled === false ? 0 : 1, JSON.stringify(t.params || {}), t.missedPolicy || 'run-once', next, id);
    this.ctx.audit.record({ actor, action: 'scheduler.update', serverId: t.serverId || null, target: t.name, details: input });
    this._changed();
    return this.get(id);
  }

  remove(id, actor = 'local') {
    const t = this.get(id);
    this.ctx.db.run('DELETE FROM tasks WHERE id = ?', id);
    this.ctx.audit.record({ actor, action: 'scheduler.delete', serverId: t.serverId, target: t.name });
    this._changed();
  }

  history(taskId, limit = 100) {
    if (taskId) return this.ctx.db.all('SELECT * FROM task_runs WHERE task_id = ? ORDER BY id DESC LIMIT ?', taskId, limit);
    return this.ctx.db.all('SELECT r.*, t.name AS task_name, t.type AS task_type, t.server_id FROM task_runs r LEFT JOIN tasks t ON t.id = r.task_id ORDER BY r.id DESC LIMIT ?', limit);
  }

  preview(cron, timezone, count = 5) {
    const c = parseCron(cron);
    const out = []; let t = Date.now();
    for (let i = 0; i < count; i++) { t = nextRun(c, timezone, t); if (!t) break; out.push(t); }
    return { runs: out, description: describeCron(cron) };
  }

  /** Called at start-up: handle runs missed while the app was closed, then arm the timer. */
  start() {
    const grace = this.ctx.settings.get('scheduler').missedRunGraceMinutes * 60000;
    const now = Date.now();
    for (const r of this.ctx.db.all('SELECT * FROM tasks WHERE enabled = 1')) {
      if (r.next_run && r.next_run < now) {
        const t = this._row(r);
        if (t.missedPolicy === 'run-once' && now - r.next_run <= grace) {
          this.ctx.log.info(`Running missed task ${t.name} (was due ${new Date(r.next_run).toISOString()})`);
          this._execute(t, r.next_run, 'missed');
        } else {
          this.ctx.db.run('INSERT INTO task_runs (task_id, scheduled_for, started_at, ended_at, status, message) VALUES (?, ?, ?, ?, ?, ?)', r.id, r.next_run, now, now, 'missed', 'The application was not running at the scheduled time.');
        }
        this.ctx.db.run('UPDATE tasks SET next_run = ? WHERE id = ?', nextRun(r.cron, r.timezone, now), r.id);
      } else if (!r.next_run) {
        this.ctx.db.run('UPDATE tasks SET next_run = ? WHERE id = ?', nextRun(r.cron, r.timezone, now), r.id);
      }
    }
    this._arm();
  }

  /** Recompute all next-run times (e.g. after system resume or clock change). */
  recompute() {
    for (const r of this.ctx.db.all('SELECT * FROM tasks WHERE enabled = 1')) {
      if (!r.next_run || r.next_run > Date.now()) this.ctx.db.run('UPDATE tasks SET next_run = ? WHERE id = ?', nextRun(r.cron, r.timezone), r.id);
    }
    this._arm();
  }

  _arm() {
    clearTimeout(this.timer);
    const row = this.ctx.db.get('SELECT MIN(next_run) AS n FROM tasks WHERE enabled = 1 AND next_run IS NOT NULL');
    const wait = row && row.n ? Math.max(500, Math.min(row.n - Date.now(), 30000)) : 30000;
    this.timer = setTimeout(() => this._tick(), wait);
    if (this.timer.unref) this.timer.unref();
  }

  _tick() {
    const now = Date.now();
    for (const r of this.ctx.db.all('SELECT * FROM tasks WHERE enabled = 1 AND next_run IS NOT NULL AND next_run <= ?', now + 250)) {
      this.ctx.db.run('UPDATE tasks SET next_run = ? WHERE id = ?', nextRun(r.cron, r.timezone, Math.max(now, r.next_run)), r.id);
      this._execute(this._row(r), r.next_run, 'schedule');
    }
    this._arm();
  }

  async runNow(id, actor = 'local') {
    const t = this.get(id);
    this.ctx.audit.record({ actor, action: 'scheduler.run-now', serverId: t.serverId, target: t.name });
    return this._execute(t, Date.now(), 'manual');
  }

  async _execute(task, scheduledFor, cause) {
    if (this.running.has(task.id)) {
      this.ctx.db.run('INSERT INTO task_runs (task_id, scheduled_for, started_at, ended_at, status, message) VALUES (?, ?, ?, ?, ?, ?)', task.id, scheduledFor, Date.now(), Date.now(), 'skipped', 'Previous run still in progress');
      return { status: 'skipped' };
    }
    const handler = this.handlers[task.type];
    const runInfo = this.ctx.db.run('INSERT INTO task_runs (task_id, scheduled_for, started_at, status) VALUES (?, ?, ?, ?)', task.id, scheduledFor, Date.now(), 'running');
    const runId = Number(runInfo.lastInsertRowid);
    this.running.add(task.id);
    this._changed();
    let status = 'ok'; let message = '';
    try {
      if (!handler) throw new Error(`No handler for task type ${task.type}`);
      if (task.serverId) {
        const srv = this.ctx.registry.find(task.serverId);
        if (!srv) throw new Error('The server for this task no longer exists.');
        if (srv.config.maintenance.enabled && task.type !== 'maintenance' && task.params.skipInMaintenance !== false) { status = 'skipped'; message = 'Server is in maintenance mode'; }
      }
      if (status === 'ok') {
        const res = await handler(task, { cause });
        if (res && res.skipped) { status = 'skipped'; message = res.message || 'Skipped'; } else message = (res && res.message) || 'Completed';
      }
    } catch (err) {
      status = 'failed'; message = err.message;
      this.ctx.notifications.notify({ category: 'scheduler', severity: 'error', title: `Scheduled task failed: ${task.name}`, body: err.message, serverId: task.serverId });
    } finally {
      this.running.delete(task.id);
      this.ctx.db.run('UPDATE task_runs SET ended_at = ?, status = ?, message = ? WHERE id = ?', Date.now(), status, String(message).slice(0, 2000), runId);
      this.ctx.db.run('UPDATE tasks SET last_run = ?, last_status = ? WHERE id = ?', Date.now(), status, task.id);
      this.ctx.audit.record({ actor: 'scheduler', action: `task.${task.type}`, serverId: task.serverId, target: task.name, result: status === 'failed' ? 'failed' : 'ok', details: { cause, status, message } });
      this._changed();
    }
    return { status, message };
  }

  _changed() { this.ctx.bus.publish('scheduler.changed', {}); }
  stop() { clearTimeout(this.timer); }
}

module.exports = { Scheduler, parseCron, nextRun, describeCron, TASK_TYPES, zonedParts };
