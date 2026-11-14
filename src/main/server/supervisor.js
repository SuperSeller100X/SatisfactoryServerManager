'use strict';
/**
 * Process supervisor for dedicated servers.
 *
 * Ownership rules (crash recovery safety):
 *  - A server is "owned" when this manager spawned it and holds the child handle.
 *    Only owned processes are restarted automatically after a crash.
 *  - A server found running at manager start-up whose executable lives inside the
 *    configured install folder is "attached": it is monitored and can be stopped
 *    via the API (or, after explicit confirmation, terminated by PID once the PID
 *    and executable path have been re-verified). It is never auto-restarted.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const dgram = require('node:dgram');
const { spawn } = require('node:child_process');
const layout = require('./layout');
const { IniDocument } = require('./ini');
const { ServerApiClient, parseGeneratedToken } = require('./api-client');
const { pollServerState } = require('./query');
const { AppError, sleep, redactText } = require('../core/util');
const { exists, isInside } = require('../core/fsutil');

const CONSOLE_LIMIT = 5000;
const UE_LINE_RE = /^\[(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}):(\d{3})\]\[\s*\d+\]([A-Za-z0-9_]+):\s*(?:(Fatal|Error|Warning|Display|Verbose|VeryVerbose|Log):\s*)?(.*)$/;
const CRASH_PATTERNS = [
  { re: /Fatal error!?/i, reason: 'Fatal engine error' },
  { re: /Unhandled Exception: (\S+)/i, reason: (m) => `Unhandled exception (${m[1]})` },
  { re: /EXCEPTION_ACCESS_VIOLATION/i, reason: 'Memory access violation (EXCEPTION_ACCESS_VIOLATION)' },
  { re: /Assertion failed: (.{0,160})/i, reason: (m) => `Assertion failed: ${m[1]}` },
  { re: /LowLevelFatalError.{0,200}/i, reason: (m) => `Low-level fatal error: ${m[0].slice(0, 160)}` },
  { re: /Ran out of memory|Out of memory|OOM/i, reason: 'Out of memory' },
  { re: /Failed to load map|LoadMap failed/i, reason: 'Failed to load the map/save' },
  { re: /Failed to bind|Address already in use|Could not create socket/i, reason: 'Network port could not be bound (port in use?)' },
  { re: /Mod .{0,80} (failed|incompatible)|SML.{0,40}(failed|error)/i, reason: 'Mod loading failure' },
  { re: /Signal 11|SIGSEGV/i, reason: 'Segmentation fault' },
];

function parseLine(text) {
  const m = UE_LINE_RE.exec(text);
  if (!m) {
    const lvl = /\berror\b/i.test(text) ? 'error' : /\bwarning\b/i.test(text) ? 'warning' : 'log';
    return { level: lvl, category: null, serverTs: null, message: text };
  }
  const serverTs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
  const verb = (m[9] || 'Log').toLowerCase();
  const level = verb === 'fatal' || verb === 'error' ? 'error' : verb === 'warning' ? 'warning' : verb === 'display' ? 'info' : verb.includes('verbose') ? 'verbose' : 'log';
  return { level, category: m[8], serverTs, message: m[10] };
}

function detectCrashReason(lines, exitCode) {
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 400); i--) {
    for (const p of CRASH_PATTERNS) {
      const m = p.re.exec(lines[i]);
      if (m) return { reason: typeof p.reason === 'function' ? p.reason(m) : p.reason, evidence: lines.slice(Math.max(0, i - 5), i + 6) };
    }
  }
  if (exitCode === 3221225477 || exitCode === -1073741819) return { reason: 'Access violation (0xC0000005)', evidence: [] };
  if (exitCode === 3221225725 || exitCode === -1073741571) return { reason: 'Stack overflow (0xC00000FD)', evidence: [] };
  if (exitCode === 3221226505 || exitCode === -1073740791) return { reason: 'Fatal stack buffer overrun (0xC0000409)', evidence: [] };
  if (exitCode === 137) return { reason: 'Killed (SIGKILL, possibly out of memory)', evidence: [] };
  return { reason: exitCode == null ? 'Process ended unexpectedly' : `Process exited with code ${exitCode}`, evidence: lines.slice(-10) };
}

/** Check whether TCP/UDP port is free on this machine (used before start). */
function checkPortFree(port, proto) {
  return new Promise((resolve) => {
    if (proto === 'udp') {
      const s = dgram.createSocket('udp4');
      s.once('error', () => resolve(false));
      s.bind(port, '0.0.0.0', () => s.close(() => resolve(true)));
    } else {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(port, '0.0.0.0', () => s.close(() => resolve(true)));
    }
  });
}

class Supervisor {
  constructor(ctx) {
    this.ctx = ctx; // { registry, db, bus, audit, notifications, secrets, settings, log, paths, probe, diagnosticsCollector }
    this.state = new Map();
    this.pendingConsole = new Map();
    this.flushTimer = setInterval(() => this._flushConsole(), 120);
    this.flushTimer.unref && this.flushTimer.unref();
    this.shuttingDown = false;
  }

  // ---- state ---------------------------------------------------------------
  _st(id) {
    if (!this.state.has(id)) {
      this.state.set(id, {
        status: 'stopped', pid: null, child: null, owned: false, runId: null, startedAt: null, readyAt: null,
        stopRequested: false, stopRequestedAt: null, console: [], seq: 0, logStream: null, recoveryAttempts: [], recoveryTimer: null,
        lastExit: null, query: null, busy: null, lastError: null, readyTimer: null,
      });
    }
    return this.state.get(id);
  }
  status(id) {
    const s = this._st(id);
    return {
      status: s.status, pid: s.pid, owned: s.owned, runId: s.runId, startedAt: s.startedAt, readyAt: s.readyAt,
      uptimeMs: s.startedAt && ['running', 'starting', 'attached', 'stopping'].includes(s.status) ? Date.now() - s.startedAt : 0,
      lastExit: s.lastExit, query: s.query, busy: s.busy, lastError: s.lastError,
      recovery: { attemptsInWindow: s.recoveryAttempts.length, pending: !!s.recoveryTimer },
    };
  }
  isActive(id) { return ['starting', 'running', 'stopping', 'attached'].includes(this._st(id).status); }
  runningPids() {
    const out = {};
    for (const [id, s] of this.state) if (s.pid && this.isActive(id)) out[id] = s.pid;
    return out;
  }
  _setStatus(id, status, extra = {}) {
    const s = this._st(id);
    s.status = status;
    Object.assign(s, extra);
    this.ctx.bus.publish('server.status', { id, ...this.status(id) });
  }
  setBusy(id, label) { this._st(id).busy = label; this.ctx.bus.publish('server.status', { id, ...this.status(id) }); }

  // ---- console -------------------------------------------------------------
  _push(id, src, text, runId) {
    const s = this._st(id);
    const clean = redactText(text.replace(/\u001b\[[0-9;]*m/g, ''));
    const parsed = src === 'sys' ? { level: 'system', category: 'Manager', serverTs: null, message: clean } : parseLine(clean);
    const line = { seq: ++s.seq, ts: Date.now(), src, runId: runId ?? s.runId, text: clean, ...parsed };
    s.console.push(line);
    if (s.console.length > CONSOLE_LIMIT) s.console.splice(0, s.console.length - CONSOLE_LIMIT);
    if (s.logStream) s.logStream.write(`${new Date(line.ts).toISOString()} [${src}] ${clean}\n`);
    if (!this.pendingConsole.has(id)) this.pendingConsole.set(id, []);
    this.pendingConsole.get(id).push(line);
    if (src !== 'sys') this._inspectLine(id, clean);
    return line;
  }
  sys(id, text) { return this._push(id, 'sys', text); }
  _flushConsole() {
    for (const [id, lines] of this.pendingConsole) if (lines.length) this.ctx.bus.publish('server.console', { id, lines });
    this.pendingConsole.clear();
  }
  consoleSnapshot(id, { sinceSeq = 0, limit = 2000 } = {}) {
    return this._st(id).console.filter((l) => l.seq > sinceSeq).slice(-limit);
  }
  /** Per-run console history from the persisted run log file. */
  async runLog(runId) {
    const run = this.ctx.db.get('SELECT * FROM runs WHERE id = ?', runId);
    if (!run || !run.log_path) throw new AppError('E_NOT_FOUND', 'No log stored for that run');
    if (!isInside(this.ctx.paths.runs, run.log_path)) throw new AppError('E_UNSAFE_PATH', 'Run log path outside the manager data folder');
    const text = await fsp.readFile(run.log_path, 'utf8').catch(() => '');
    return { run, text };
  }

  _inspectLine(id, text) {
    // Player join events as written by the engine to the server log.
    const join = /Join succeeded:\s*(.{1,64})$/.exec(text);
    if (join) {
      const s = this._st(id);
      this.ctx.db.run('INSERT INTO player_events (server_id, run_id, ts, kind, player, source) VALUES (?, ?, ?, ?, ?, ?)', id, s.runId, Date.now(), 'join', join[1].trim(), 'server-log');
    }
  }

  // ---- API helpers -----------------------------------------------------------
  tokenKey(id) { return `server:${id}:apiToken`; }
  api(id) {
    const srv = this.ctx.registry.get(id);
    return new ServerApiClient({
      host: srv.config.api.host || '127.0.0.1',
      port: srv.config.launch.port,
      getPin: () => this.ctx.registry.get(id).config.api.pin,
      onFirstUse: (fp) => {
        // Trust on first use is limited to the loopback API of a server this
        // manager launched or attached to; the fingerprint is recorded and audited.
        this.ctx.registry.patchInternal(id, { api: { pin: fp } });
        this.ctx.audit.record({ actor: 'system', action: 'server.api.pin', serverId: id, target: srv.name, details: { fingerprint: fp } });
        this.sys(id, `Trusted server API certificate ${fp.slice(0, 23)}… (trust on first use)`);
      },
      getToken: () => this.ctx.secrets.get(this.tokenKey(id)),
    });
  }
  hasToken(id) { return this.ctx.secrets.has(this.tokenKey(id)); }

  // ---- start -----------------------------------------------------------------
  async _applyIni(srv) {
    const dir = layout.configDir(srv.installDir);
    await fsp.mkdir(dir, { recursive: true });
    const edit = async (file, fn) => {
      const p = path.join(dir, file);
      const text = await fsp.readFile(p, 'utf8').catch(() => '');
      const doc = new IniDocument(text);
      fn(doc);
      const out = doc.toString();
      if (out !== text) {
        if (text) await fsp.copyFile(p, `${p}.ssm-bak`);
        await fsp.writeFile(p, out);
      }
    };
    await edit('Game.ini', (d) => d.set('/Script/Engine.GameSession', 'MaxPlayers', String(srv.config.ini.maxPlayers)));
    await edit('Engine.ini', (d) => d.set('/Script/FactoryGame.FGSaveSession', 'mNumRotatingAutosaves', String(srv.config.ini.autosaveCount)));
  }

  buildArgs(srv) {
    const l = srv.config.launch;
    const args = ['FactoryGame', '-log', '-unattended', `-Port=${l.port}`, `-ReliablePort=${l.reliablePort}`];
    if (l.multihome) args.push(`-multihome=${l.multihome}`);
    if (l.disableSeasonalEvents) args.push('-DisableSeasonalEvents');
    for (const a of l.extraArgs || []) args.push(a);
    return args;
  }

  async preflight(srv) {
    const problems = [];
    const exe = layout.serverExecutable(srv.installDir);
    if (!(await exists(exe))) problems.push(`Server executable not found: ${exe}. Install or validate the server first.`);
    for (const [port, proto] of [[srv.config.launch.port, 'udp'], [srv.config.launch.port, 'tcp'], [srv.config.launch.reliablePort, 'tcp']]) {
      if (!(await checkPortFree(port, proto))) problems.push(`${proto.toUpperCase()} port ${port} is already in use by another program.`);
    }
    return { ok: problems.length === 0, problems, exe };
  }

  async start(id, { trigger = 'manual', actor = 'local' } = {}) {
    const srv = this.ctx.registry.get(id);
    const s = this._st(id);
    if (this.isActive(id)) throw new AppError('E_ALREADY_RUNNING', `${srv.name} is already ${s.status}.`);
    if (s.busy) throw new AppError('E_BUSY', `${srv.name} is busy (${s.busy}).`);
    if (s.recoveryTimer && trigger !== 'recovery') { clearTimeout(s.recoveryTimer); s.recoveryTimer = null; }
    const pre = await this.preflight(srv);
    if (!pre.ok) {
      const err = new AppError('E_PREFLIGHT', pre.problems.join(' '));
      this.ctx.audit.record({ actor, action: 'server.start', serverId: id, target: srv.name, result: 'failed', error: err, details: { trigger } });
      this.ctx.notifications.notify({ category: 'startFailure', severity: 'error', title: `${srv.name} could not start`, body: pre.problems.join(' '), serverId: id });
      s.lastError = err.message;
      throw err;
    }
    await this._applyIni(srv);

    const args = this.buildArgs(srv);
    const runDir = path.join(this.ctx.paths.runs, id);
    await fsp.mkdir(runDir, { recursive: true });
    const now = Date.now();
    const manifestBuild = await require('../steam/steamcmd').readAppManifest(srv.installDir).catch(() => null);
    const info = this.ctx.db.run('INSERT INTO runs (server_id, started_at, outcome, trigger, build_id) VALUES (?, ?, ?, ?, ?)', id, now, 'running', trigger, manifestBuild ? manifestBuild.buildId : null);
    const runId = Number(info.lastInsertRowid);
    const logPath = path.join(runDir, `run-${runId}.log`);
    this.ctx.db.run('UPDATE runs SET log_path = ? WHERE id = ?', logPath, runId);

    s.logStream = fs.createWriteStream(logPath, { flags: 'a' });
    s.stopRequested = false; s.stopRequestedAt = null; s.readyAt = null; s.lastError = null; s.query = null;
    this._setStatus(id, 'starting', { runId, startedAt: now, owned: true });
    this.sys(id, `Starting ${srv.name} (run #${runId}, trigger: ${trigger})`);
    this.sys(id, `${path.basename(pre.exe)} ${args.join(' ')}`);

    let child;
    try {
      child = spawn(pre.exe, args, { cwd: path.dirname(pre.exe), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: false });
    } catch (err) {
      this._finishRun(id, runId, { exitCode: null, outcome: 'start-failed', reason: err.message });
      throw new AppError('E_SPAWN', `Failed to launch the server: ${err.message}`);
    }
    s.child = child; s.pid = child.pid;
    this.ctx.db.run('UPDATE runs SET pid = ? WHERE id = ?', child.pid, runId);

    const lineSplitter = (src) => {
      let buf = '';
      return (chunk) => {
        buf += chunk.toString('utf8');
        const parts = buf.split(/\r?\n/);
        buf = parts.pop();
        for (const p of parts) if (p.length) this._push(id, src, p, runId);
        if (buf.length > 16384) { this._push(id, src, buf, runId); buf = ''; }
      };
    };
    child.stdout.on('data', lineSplitter('out'));
    child.stderr.on('data', lineSplitter('err'));
    child.stdin.on('error', () => { /* stdin closed by server */ });
    child.on('error', (err) => { this.sys(id, `Process error: ${err.message}`); });
    child.on('exit', (code, signal) => this._onExit(id, runId, code, signal));

    this.ctx.audit.record({ actor, action: 'server.start', serverId: id, target: srv.name, details: { trigger, runId, pid: child.pid, args } });
    this._watchReady(id, runId, srv);
    return this.status(id);
  }

  _watchReady(id, runId, srv) {
    const s = this._st(id);
    const started = Date.now();
    const tick = async () => {
      if (s.runId !== runId || !['starting'].includes(s.status)) return;
      try {
        const q = await pollServerState('127.0.0.1', srv.config.launch.port, { timeoutMs: 1500 });
        s.query = q;
        if (q.stateCode >= 1) {
          const readyAt = Date.now();
          this.ctx.db.run('UPDATE runs SET ready_at = ? WHERE id = ?', readyAt, runId);
          if (q.netCL) this._cacheNetCL(id, q.netCL);
          this._setStatus(id, 'running', { readyAt });
          this.sys(id, `Server is responding (${q.state}, changelist ${q.netCL}) after ${((readyAt - started) / 1000).toFixed(1)} s`);
          // A healthy start clears consecutive recovery attempts older than this run.
          return;
        }
      } catch { /* not up yet */ }
      if (Date.now() - started > 15 * 60 * 1000) {
        this.sys(id, 'Server has not answered the UDP query for 15 minutes; it may be stuck loading. Check the console output.');
        this.ctx.notifications.notify({ category: 'startFailure', severity: 'warning', title: `${srv.name} is slow to start`, body: 'No response to the server query after 15 minutes.', serverId: id });
        this._setStatus(id, 'running');
        return;
      }
      s.readyTimer = setTimeout(tick, 2000);
    };
    s.readyTimer = setTimeout(tick, 3000);
  }

  async _cacheNetCL(id, netCL) {
    const srv = this.ctx.registry.find(id);
    if (!srv) return;
    const m = await require('../steam/steamcmd').readAppManifest(srv.installDir).catch(() => null);
    if (srv.config.cache.netCL !== netCL || (m && srv.config.cache.netCLBuildId !== m.buildId)) this.ctx.registry.patchInternal(id, { cache: { netCL, netCLBuildId: m ? m.buildId : null } });
  }

  _finishRun(id, runId, { exitCode, signal = null, outcome, reason }) {
    this.ctx.db.run('UPDATE runs SET ended_at = ?, exit_code = ?, signal = ?, outcome = ?, reason = ? WHERE id = ?', Date.now(), exitCode, signal, outcome, reason, runId);
  }

  async _onExit(id, runId, code, signal) {
    const s = this._st(id);
    if (s.runId !== runId) return;
    clearTimeout(s.readyTimer);
    const srv = this.ctx.registry.find(id);
    const name = srv ? srv.name : id;
    const run = this.ctx.db.get('SELECT * FROM runs WHERE id = ?', runId);
    const lines = s.console.filter((l) => l.runId === runId).map((l) => l.text);
    const expected = s.stopRequested;
    const neverReady = !run.ready_at;
    let outcome; let reason;
    if (expected) { outcome = 'stopped'; reason = s.stopReason || 'Stopped by request'; } else if (neverReady && Date.now() - run.started_at < 120000) { outcome = 'start-failed'; ({ reason } = detectCrashReason(lines, code)); } else { outcome = 'crashed'; ({ reason } = detectCrashReason(lines, code)); }

    this.sys(id, `Process exited (code ${code ?? 'n/a'}${signal ? `, signal ${signal}` : ''}) — ${outcome}: ${reason}`);
    this._finishRun(id, runId, { exitCode: code, signal, outcome, reason });
    if (s.logStream) { s.logStream.end(); s.logStream = null; }
    s.child = null; s.pid = null;
    s.lastExit = { code, signal, outcome, reason, at: Date.now(), runId };
    this.ctx.audit.record({ actor: 'system', action: 'server.exit', serverId: id, target: name, result: outcome === 'stopped' ? 'ok' : 'failed', details: { runId, exitCode: code, signal, outcome, reason } });

    if (outcome === 'stopped') {
      this._setStatus(id, 'stopped', { startedAt: null, owned: false });
      if (s.onStopped) { s.onStopped(); s.onStopped = null; }
      return;
    }
    this._setStatus(id, 'crashed', { startedAt: null, owned: false });
    const detected = detectCrashReason(lines, code);
    const crash = this.ctx.db.run('INSERT INTO crashes (server_id, run_id, at, exit_code, reason, evidence) VALUES (?, ?, ?, ?, ?, ?)', id, runId, Date.now(), code, reason, JSON.stringify(detected.evidence.map(redactText)));
    const crashId = Number(crash.lastInsertRowid);
    this.ctx.notifications.notify({ category: outcome === 'start-failed' ? 'startFailure' : 'crash', severity: 'error', title: outcome === 'start-failed' ? `${name} failed to start` : `${name} crashed`, body: reason, serverId: id });
    if (srv && srv.config.recovery.collectDiagnostics && this.ctx.collectCrashDiagnostics) {
      this.ctx.collectCrashDiagnostics(id, runId, crashId).then((p) => this.ctx.db.run('UPDATE crashes SET diagnostics_path = ? WHERE id = ?', p, crashId)).catch((e) => this.ctx.log.warn('Crash diagnostics failed', e));
    }
    if (srv && !this.shuttingDown) this._planRecovery(id, srv, crashId);
  }

  /** Decide whether to restart automatically, with loop prevention. */
  _planRecovery(id, srv, crashId) {
    const s = this._st(id);
    const r = srv.config.recovery;
    const record = (text) => this.ctx.db.run('UPDATE crashes SET recovery = ? WHERE id = ?', text, crashId);
    if (!r.enabled) { record('Automatic recovery disabled'); return; }
    if (srv.config.maintenance.enabled) { record('Not restarted: maintenance mode'); return; }
    const windowMs = r.windowMinutes * 60000;
    s.recoveryAttempts = s.recoveryAttempts.filter((t) => Date.now() - t < windowMs);
    if (s.recoveryAttempts.length >= r.maxAttempts) {
      record(`Restart loop prevented after ${s.recoveryAttempts.length} attempts in ${r.windowMinutes} min`);
      this.sys(id, `Automatic recovery stopped: ${s.recoveryAttempts.length} restarts within ${r.windowMinutes} minutes. Manual action required.`);
      this.ctx.notifications.notify({ category: 'recovery', severity: 'error', title: `${srv.name}: automatic recovery halted`, body: `The server crashed ${s.recoveryAttempts.length + 1} times within ${r.windowMinutes} minutes. Restarts were paused to prevent a crash loop. Open Diagnostics for details.`, serverId: id });
      this.ctx.audit.record({ actor: 'system', action: 'recovery.halted', serverId: id, target: srv.name, result: 'failed', details: { attempts: s.recoveryAttempts.length } });
      return;
    }
    const delay = Math.round(r.cooldownSeconds * 1000 * r.backoffMultiplier ** s.recoveryAttempts.length);
    record(`Restart scheduled in ${Math.round(delay / 1000)} s (attempt ${s.recoveryAttempts.length + 1}/${r.maxAttempts})`);
    this.sys(id, `Automatic restart in ${Math.round(delay / 1000)} s (attempt ${s.recoveryAttempts.length + 1} of ${r.maxAttempts}).`);
    s.recoveryTimer = setTimeout(async () => {
      s.recoveryTimer = null;
      s.recoveryAttempts.push(Date.now());
      try {
        await this.start(id, { trigger: 'recovery', actor: 'system' });
        this.ctx.audit.record({ actor: 'system', action: 'recovery.restart', serverId: id, target: srv.name, details: { attempt: s.recoveryAttempts.length } });
        this.ctx.notifications.notify({ category: 'recovery', severity: 'info', title: `${srv.name} restarted automatically`, body: `Recovery attempt ${s.recoveryAttempts.length} of ${r.maxAttempts}.`, serverId: id });
      } catch (err) {
        this.ctx.audit.record({ actor: 'system', action: 'recovery.restart', serverId: id, target: srv.name, result: 'failed', error: err });
        this.ctx.notifications.notify({ category: 'recovery', severity: 'error', title: `${srv.name}: automatic restart failed`, body: err.message, serverId: id });
      }
    }, delay);
    this.ctx.bus.publish('server.status', { id, ...this.status(id) });
  }

  cancelRecovery(id, actor = 'local') {
    const s = this._st(id);
    if (s.recoveryTimer) { clearTimeout(s.recoveryTimer); s.recoveryTimer = null; }
    s.recoveryAttempts = [];
    this.ctx.audit.record({ actor, action: 'recovery.reset', serverId: id });
    this.ctx.bus.publish('server.status', { id, ...this.status(id) });
  }

  // ---- stop ------------------------------------------------------------------
  /**
   * Graceful stop: save through the API (if configured) then API Shutdown; on
   * Linux SIGINT is also graceful. Force-termination happens only when `force`
   * is set explicitly by the caller (UI confirmation) or after the grace period
   * when `forceAfterGrace` is set.
   */
  async stop(id, { reason = 'Stopped by user', force = false, forceAfterGrace = false, actor = 'local', graceSeconds } = {}) {
    const srv = this.ctx.registry.get(id);
    const s = this._st(id);
    if (s.recoveryTimer) { clearTimeout(s.recoveryTimer); s.recoveryTimer = null; }
    if (!this.isActive(id)) { if (s.status === 'crashed') this._setStatus(id, 'stopped'); return this.status(id); }
    if (s.status === 'stopping' && !force) return this.status(id);
    const grace = (graceSeconds || srv.config.shutdown.graceSeconds) * 1000;
    s.stopRequested = true; s.stopReason = reason; s.stopRequestedAt = Date.now();
    if (s.runId) this.ctx.db.run('UPDATE runs SET stop_requested_at = ? WHERE id = ?', s.stopRequestedAt, s.runId);
    const wasAttached = s.status === 'attached';
    this._setStatus(id, 'stopping');
    this.sys(id, `Stopping: ${reason}`);
    const exited = new Promise((resolve) => { s.onStopped = resolve; });

    let graceful = false;
    if (!force && this.hasToken(id)) {
      const api = this.api(id);
      try {
        if (srv.config.shutdown.saveBeforeStop) {
          const st = await api.queryState().catch(() => null);
          const session = st && st.data && st.data.serverGameState ? st.data.serverGameState.activeSessionName : '';
          if (session) {
            const saveName = `${session}_ssm_shutdown`.replace(/[^A-Za-z0-9_ -]/g, '_');
            await api.saveGame(saveName);
            this.sys(id, `Saved game as "${saveName}" before shutdown.`);
          }
        }
        await api.shutdown();
        graceful = true;
        this.sys(id, 'Shutdown requested through the server API.');
      } catch (err) {
        this.sys(id, `API shutdown failed: ${err.message}`);
      }
    }
    if (!graceful && !force && process.platform !== 'win32' && s.child) {
      s.child.kill('SIGINT');
      graceful = true;
      this.sys(id, 'Sent SIGINT for a graceful engine shutdown.');
    }
    if (!graceful && !force) {
      s.stopRequested = false;
      this._setStatus(id, wasAttached ? 'attached' : 'running');
      throw new AppError('E_NO_GRACEFUL_STOP', 'A graceful stop needs access to the server API (claim the server or add an API token under Server → Access). You can force-stop instead, but unsaved progress since the last autosave will be lost.');
    }
    if (force) await this._terminate(id, srv);

    const timeout = sleep(grace).then(() => 'timeout');
    const result = await Promise.race([exited.then(() => 'exited'), timeout, wasAttached ? this._waitPidGone(id, s.pid, grace) : new Promise(() => {})]);
    if (result === 'timeout') {
      if (forceAfterGrace || force) {
        this.sys(id, `Server did not exit within ${grace / 1000} s; terminating.`);
        await this._terminate(id, srv);
        await Promise.race([exited, sleep(15000)]);
      } else {
        this.sys(id, `Server did not exit within ${grace / 1000} s. It is still running.`);
        throw new AppError('E_STOP_TIMEOUT', 'The server did not shut down within the grace period.');
      }
    }
    if (wasAttached && result !== 'exited') {
      this._finishAttached(id, 'stopped', reason);
    }
    const run = s.lastExit && s.lastExit.runId ? this.ctx.db.get('SELECT stop_requested_at, ended_at FROM runs WHERE id = ?', s.lastExit.runId) : null;
    this.ctx.audit.record({ actor, action: 'server.stop', serverId: id, target: srv.name, details: { reason, force, graceful, shutdownMs: run && run.ended_at && run.stop_requested_at ? run.ended_at - run.stop_requested_at : null } });
    return this.status(id);
  }

  async _waitPidGone(id, pid, maxMs) {
    const end = Date.now() + maxMs;
    while (Date.now() < end) {
      const r = await this.ctx.probe.sample([pid]).catch(() => ({}));
      if (!r[pid]) return 'exited';
      await sleep(1000);
    }
    return 'timeout';
  }

  async _terminate(id, srv) {
    const s = this._st(id);
    if (s.child) { s.child.kill('SIGKILL'); return; }
    if (s.pid && s.status !== 'stopped') {
      // Attached process: re-verify identity before killing by PID.
      const info = (await this.ctx.probe.sample([s.pid]))[s.pid];
      const exe = layout.serverExecutable(srv.installDir);
      if (!info || !info.exe || path.resolve(info.exe).toLowerCase() !== path.resolve(exe).toLowerCase()) {
        throw new AppError('E_PROCESS_IDENTITY', 'Refusing to terminate: the process no longer matches this server installation.');
      }
      process.kill(s.pid, 'SIGKILL');
    }
  }

  _finishAttached(id, outcome, reason) {
    const s = this._st(id);
    if (s.runId) this._finishRun(id, s.runId, { exitCode: null, outcome, reason });
    s.lastExit = { code: null, signal: null, outcome, reason, at: Date.now(), runId: s.runId };
    s.pid = null;
    this._setStatus(id, 'stopped', { startedAt: null, owned: false });
    if (s.onStopped) { s.onStopped(); s.onStopped = null; }
  }

  async restart(id, opts = {}) {
    if (this.isActive(id)) await this.stop(id, { ...opts, reason: opts.reason || 'Restart requested' });
    return this.start(id, { trigger: opts.trigger || 'restart', actor: opts.actor });
  }

  // ---- commands ----------------------------------------------------------------
  /**
   * Send a console command. With API access the documented RunCommand function
   * is used and its result is shown; otherwise the command is written to the
   * server's standard input.
   */
  async sendCommand(id, command, { actor = 'local' } = {}) {
    const srv = this.ctx.registry.get(id);
    const s = this._st(id);
    if (!this.isActive(id)) throw new AppError('E_NOT_RUNNING', 'The server is not running.');
    this._push(id, 'cmd', `> ${command}`);
    let via = 'stdin';
    if (this.hasToken(id)) {
      via = 'api';
      try {
        const res = await this.api(id).runCommand(command);
        const out = res.data && res.data.commandResult !== undefined ? String(res.data.commandResult) : '';
        for (const l of (out || '(no output)').split(/\r?\n/)) this._push(id, 'sys', `[RunCommand] ${l}`);
        if (/GenerateAPIToken/i.test(command)) {
          const tok = parseGeneratedToken(out);
          if (tok) this.sys(id, 'An API token was generated. Use Server → Access to store a token securely.');
        }
      } catch (err) {
        this._push(id, 'sys', `[RunCommand] failed: ${err.message}`);
        throw err;
      } finally {
        this.ctx.audit.record({ actor, action: 'server.command', serverId: id, target: srv.name, details: { command: redactText(command).slice(0, 200), via } });
      }
      return { via };
    }
    if (!s.child || !s.child.stdin.writable) throw new AppError('E_NO_CONSOLE', 'This server was not started by the manager, so its console input is not available. Configure API access to send commands.');
    s.child.stdin.write(`${command}\n`);
    this.ctx.audit.record({ actor, action: 'server.command', serverId: id, target: srv.name, details: { command: redactText(command).slice(0, 200), via } });
    return { via };
  }

  // ---- adoption ----------------------------------------------------------------
  /** Detect server processes running from configured install folders (e.g. after a manager restart). */
  async adoptRunning() {
    const servers = this.ctx.registry.list();
    for (const srv of servers) {
      if (this.isActive(srv.id)) continue;
      try {
        const exe = layout.serverExecutable(srv.installDir);
        const found = (await this.ctx.probe.findByPathPrefix(path.dirname(exe)))
          .filter((p) => p.exe && path.resolve(p.exe).toLowerCase() === path.resolve(exe).toLowerCase());
        if (found.length !== 1) continue;
        const { pid } = found[0];
        const info = (await this.ctx.probe.sample([pid]))[pid] || {};
        const now = Date.now();
        const r = this.ctx.db.run('INSERT INTO runs (server_id, started_at, pid, outcome, trigger, reason) VALUES (?, ?, ?, ?, ?, ?)', srv.id, info.startTime || now, pid, 'running', 'attached', 'Detected running process');
        this._setStatus(srv.id, 'attached', { pid, runId: Number(r.lastInsertRowid), startedAt: info.startTime || now, owned: false, readyAt: now });
        this.sys(srv.id, `Attached to running server process (PID ${pid}). Console output is not available for processes started outside this session.`);
        this.ctx.audit.record({ actor: 'system', action: 'server.attach', serverId: srv.id, target: srv.name, details: { pid } });
      } catch (err) { this.ctx.log.warn(`Process adoption failed for ${srv.name}`, err); }
    }
  }

  /** Called by the health monitor when an attached PID disappears. */
  attachedGone(id) {
    const s = this._st(id);
    if (s.status !== 'attached' && !(s.status === 'stopping' && !s.child)) return;
    if (s.status === 'stopping') { this._finishAttached(id, 'stopped', s.stopReason || 'Stopped'); return; }
    this.sys(id, 'Attached server process is no longer running (exit code unavailable for processes not started by this manager).');
    this._finishAttached(id, 'ended-unmonitored', 'Process ended (not started by this manager; exit code unavailable)');
    const srv = this.ctx.registry.find(id);
    this.ctx.notifications.notify({ category: 'shutdown', severity: 'warning', title: `${srv ? srv.name : id} stopped`, body: 'A server process that was not started by this manager has ended. It was not restarted automatically.', serverId: id });
  }

  /** Stop all active servers gracefully (application exit / Windows shutdown). */
  async stopAll({ graceSeconds = 60, reason = 'Manager shutting down', forceAfterGrace = true } = {}) {
    this.shuttingDown = true;
    const ids = [...this.state.keys()].filter((id) => this.isActive(id));
    await Promise.allSettled(ids.map((id) => this.stop(id, { reason, graceSeconds, forceAfterGrace: forceAfterGrace && this._st(id).owned, actor: 'system' }).catch((e) => {
      if (e.code === 'E_NO_GRACEFUL_STOP' && forceAfterGrace && this._st(id).owned && process.platform === 'win32') {
        // Without API access Windows offers no graceful signal; the process will be ended with the manager.
        this.sys(id, 'No API access for a graceful shutdown; the server process will be terminated.');
        return this.stop(id, { reason, force: true, actor: 'system' });
      }
      throw e;
    })));
  }

  dispose() {
    clearInterval(this.flushTimer);
    for (const s of this.state.values()) { clearTimeout(s.recoveryTimer); clearTimeout(s.readyTimer); }
  }
}

module.exports = { Supervisor, parseLine, detectCrashReason, checkPortFree, UE_LINE_RE };
