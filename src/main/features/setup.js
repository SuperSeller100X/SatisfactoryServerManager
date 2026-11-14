'use strict';
/**
 * First-launch setup wizard engine.
 *
 * Progress is persisted (settings row "setup") after every change, so the
 * wizard resumes where it stopped. Completion of a step is never taken on
 * trust from the stored flags alone: the real system state (SteamCMD binary,
 * Steam app manifest, server executable, firewall rules, stored token) is
 * re-checked on every load, which is how interrupted or partial installs are
 * detected and why finished steps are not repeated.
 *
 * Long operations record `activeOperation` before starting. If the app is
 * closed or crashes mid-way, the next load reports the interruption and offers
 * resume (SteamCMD continues partial downloads) or cleanup.
 */
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const layout = require('../server/layout');
const sys = require('./system');
const firewall = require('./firewall');
const { readAppManifest, hasPendingDownload } = require('../steam/steamcmd');
const { checkPortFree } = require('../server/supervisor');
const { download } = require('../core/http');
const { exists, isInside, diskSpace } = require('../core/fsutil');
const { AppError, sleep } = require('../core/util');

const STEPS = ['welcome', 'scan', 'location', 'dependencies', 'install', 'network', 'security', 'review', 'finish'];
const MARKER = '.ssm-install';

const blank = () => ({
  version: 1, step: 'welcome', startedAt: Date.now(), updatedAt: Date.now(),
  scan: null,
  location: null,          // { dir, name, branch, mode, createdByWizard, confirmedAt }
  serverId: null,
  completed: {},           // step -> timestamp (informational; verified separately)
  skipped: {},             // step -> reason
  vcRedist: null,          // { installedAt } | { declinedAt }
  activeOperation: null,   // { kind, startedAt }
  lastError: null,
  log: [],                 // [{ ts, step, ok, message }]
});

class Setup {
  constructor(ctx) {
    this.ctx = ctx;
    this.abort = null;
    this.progress = null;
    const row = ctx.db.get("SELECT value FROM settings WHERE key = 'setup'");
    this.s = row ? { ...blank(), ...JSON.parse(row.value) } : blank();
    // An operation recorded as active at load time cannot still be running: the process restarted.
    if (this.s.activeOperation) {
      this.s.interrupted = { ...this.s.activeOperation, detectedAt: Date.now() };
      this.s.activeOperation = null;
      this._save();
    }
  }

  _save() {
    this.s.updatedAt = Date.now();
    this.ctx.db.run("INSERT INTO settings (key, value) VALUES ('setup', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(this.s));
    this.ctx.bus.publish('operation.progress', { kind: 'setup', state: this.publicState() });
  }
  _log(step, ok, message) {
    this.s.log.push({ ts: Date.now(), step, ok, message });
    if (this.s.log.length > 200) this.s.log.splice(0, this.s.log.length - 200);
  }
  _progress(p) {
    this.progress = p ? { ...p, ts: Date.now() } : null;
    this.ctx.bus.publish('operation.progress', { kind: 'setup', progress: this.progress });
  }

  publicState() {
    const { log, ...rest } = this.s;
    return { ...rest, log: log.slice(-50), steps: STEPS, running: !!this.abort, progress: this.progress };
  }

  get server() { return this.s.serverId ? this.ctx.registry.find(this.s.serverId) : null; }

  /** Verified state of every step, computed from the real system. */
  async verify() {
    const steamcmd = await this.ctx.steamcmd.status();
    const srv = this.server;
    let install = { state: 'not-started' };
    if (srv) {
      const manifest = await readAppManifest(srv.installDir).catch(() => null);
      const exe = await exists(layout.serverExecutable(srv.installDir));
      const downloading = await hasPendingDownload(srv.installDir);
      const branchOk = !manifest || (manifest.branch || 'public') === (srv.config.branch || 'public');
      if (manifest && manifest.fullyInstalled && exe && branchOk && !downloading) install = { state: 'complete', buildId: manifest.buildId, branch: manifest.branch };
      else if (manifest || exe || downloading) install = { state: 'partial', buildId: manifest ? manifest.buildId : null, reason: !exe ? 'Server executable missing' : !branchOk ? `Installed branch "${manifest.branch}" differs from the selected "${srv.config.branch}"` : downloading ? 'An interrupted download was found' : 'Steam reports the installation as incomplete' };
    }
    const hasToken = srv ? this.ctx.supervisor.hasToken(srv.id) : false;
    const verified = {
      scan: !!this.s.scan,
      location: !!(this.s.location && this.s.location.confirmedAt && srv),
      dependencies: steamcmd.installed && !!this.s.completed.dependencies,
      install: install.state === 'complete',
      network: !!(this.s.completed.network || this.s.skipped.network),
      security: hasToken || !!this.s.skipped.security,
    };
    return { steamcmd, install, hasToken, verified };
  }

  async state() {
    return { ...this.publicState(), verification: await this.verify() };
  }

  /** Move between steps; forward moves require the previous steps to be verified. */
  async goTo(step) {
    if (!STEPS.includes(step)) throw new AppError('E_VALIDATION', 'Unknown step');
    if (this.abort) throw new AppError('E_BUSY', 'Please wait for the current operation to finish or cancel it first.');
    const target = STEPS.indexOf(step);
    const { verified } = await this.verify();
    const required = ['scan', 'location', 'dependencies', 'install', 'network', 'security'];
    for (const r of required) {
      if (STEPS.indexOf(r) < target && !verified[r]) throw new AppError('E_STEP_INCOMPLETE', `Please complete the "${r}" step first.`, { step: r });
    }
    this.s.step = step;
    this._save();
    return this.state();
  }

  // ------------------------------------------------------------ 2. scan
  async scan() {
    const steamcmd = await this.ctx.steamcmd.status();
    const suggested = this.suggestLocation();
    let disk = null;
    try { disk = await diskSpace(suggested); } catch { /* unknown */ }
    const result = {
      at: Date.now(),
      os: sys.windowsInfo(), hardware: sys.hardware(), vcRuntime: await sys.vcRuntime(),
      steamcmd, existing: await sys.findExistingInstalls(this.ctx.registry),
      managed: this.ctx.registry.list().map((s) => ({ id: s.id, name: s.name, dir: s.installDir })),
      suggested, disk, minFree: sys.MIN_FREE_BYTES,
      secureStorage: this.ctx.secrets.status(),
      network: sys.lanAddresses(),
    };
    result.checks = [
      { key: 'os', label: 'Operating system', state: result.os.supported ? 'ok' : 'error', detail: `${result.os.version} (${result.os.arch})`, help: result.os.supported ? null : 'The Satisfactory dedicated server needs 64-bit Windows 10 (1809) / Windows Server 2019 or newer.' },
      { key: 'memory', label: 'Memory', state: result.hardware.memRecommended ? 'ok' : result.hardware.memOk ? 'warning' : 'error', detail: `${(result.hardware.totalMem / 1024 ** 3).toFixed(1)} GB installed`, help: result.hardware.memRecommended ? null : 'Coffee Stain recommends 12–16 GB of RAM for a dedicated server. Large factories may run out of memory.' },
      { key: 'cpu', label: 'Processor', state: result.hardware.cores >= 4 ? 'ok' : 'warning', detail: `${result.hardware.cpuModel} · ${result.hardware.cores} threads`, help: result.hardware.cores >= 4 ? null : 'At least 4 CPU threads are recommended.' },
      { key: 'disk', label: 'Free disk space', state: !disk ? 'warning' : disk.free >= sys.MIN_FREE_BYTES ? 'ok' : 'error', detail: disk ? `${(disk.free / 1024 ** 3).toFixed(1)} GB free on ${disk.path}` : 'Could not be measured', help: disk && disk.free < sys.MIN_FREE_BYTES ? 'At least 15 GB of free space is needed for the server, updates and backups. You can pick another drive in the next step.' : null },
      { key: 'steamcmd', label: 'SteamCMD', state: steamcmd.installed ? 'ok' : 'info', detail: steamcmd.installed ? `Installed in ${steamcmd.dir}` : 'Not installed yet — it will be downloaded from Valve automatically.' },
      { key: 'vcredist', label: 'Microsoft Visual C++ runtime', state: !result.vcRuntime.applicable ? 'info' : result.vcRuntime.installed ? 'ok' : 'warning', detail: !result.vcRuntime.applicable ? 'Not needed on this platform' : result.vcRuntime.installed ? `Version ${result.vcRuntime.version}` : 'Not found — can be installed in the next steps.', help: result.vcRuntime.applicable && !result.vcRuntime.installed ? 'Unreal Engine servers need the Visual C++ 2015–2022 (x64) runtime from Microsoft.' : null },
      { key: 'existing', label: 'Existing server installations', state: 'info', detail: result.existing.length ? `${result.existing.length} found` : 'None found' },
      { key: 'secrets', label: 'Secure credential storage', state: result.secureStorage.weak ? 'warning' : 'ok', detail: result.secureStorage.backend, help: result.secureStorage.weak ? 'The operating system does not provide strong encryption for stored credentials.' : null },
    ];
    this.s.scan = result;
    this.s.completed.scan = Date.now();
    this._log('scan', true, 'Environment scan completed');
    this._save();
    return result;
  }

  suggestLocation() {
    const base = process.platform === 'win32' ? path.join(os.homedir(), 'SatisfactoryServers') : path.join(os.homedir(), 'SatisfactoryServers');
    let n = this.ctx.registry.list().length + 1;
    let dir = path.join(base, n === 1 ? 'Server' : `Server${n}`);
    const taken = new Set(this.ctx.registry.list().map((s) => s.installDir.toLowerCase()));
    while (taken.has(dir.toLowerCase())) { n++; dir = path.join(base, `Server${n}`); }
    return dir;
  }

  // ------------------------------------------------------------ 3. location
  /** Validate a candidate install folder; returns { ok, errors, warnings, info }. */
  async validateLocation(dir, mode = 'new') {
    const errors = []; const warnings = [];
    if (!path.isAbsolute(dir)) errors.push('Please choose a complete folder path (for example C:\\SatisfactoryServers\\Server).');
    const resolved = path.resolve(dir);
    const appDir = this.ctx.paths.appInstallDir;
    const forbidden = [
      { root: appDir, msg: 'The server must not be installed inside the Satisfactory Server Manager program folder. Updating or uninstalling the manager would delete it.' },
      { root: this.ctx.paths.userData, msg: 'Please choose a folder outside the manager\'s own data folder.' },
      { root: this.ctx.paths.steamcmd, msg: 'Please choose a folder outside the SteamCMD folder.' },
    ];
    for (const f of forbidden) if (f.root && (isInside(f.root, resolved) || isInside(resolved, f.root))) errors.push(f.msg);
    if (process.platform === 'win32') {
      const sysRoots = [process.env.SystemRoot || 'C:\\Windows', process.env.ProgramFiles || 'C:\\Program Files', process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', process.env.ProgramData || 'C:\\ProgramData'];
      if (sysRoots.some((r) => isInside(r, resolved))) errors.push('Windows system and program folders need administrator rights and are protected. Please pick a folder such as C:\\SatisfactoryServers.');
      if (/^[A-Za-z]:\\?$/.test(resolved)) errors.push('Please choose a sub-folder instead of the root of a drive.');
      if (resolved.length > 120) errors.push('The path is too long. Unreal Engine servers can fail with long paths — please use a shorter folder path (under 120 characters).');
      if (/[^\x20-\x7E]/.test(resolved)) warnings.push('The path contains special characters. If installation fails, use a folder with plain letters and numbers.');
    } else if (resolved === '/' || resolved === os.homedir()) errors.push('Please choose a dedicated sub-folder.');
    for (const s of this.ctx.registry.list()) {
      if (this.s.serverId && s.id === this.s.serverId) continue;
      if (isInside(s.installDir, resolved) || isInside(resolved, s.installDir)) errors.push(`This folder overlaps the existing server "${s.name}".`);
    }
    const info = errors.length ? null : await sys.inspectInstallDir(resolved);
    if (info) {
      if (!info.writable) errors.push('The manager cannot write to this folder. Choose a folder in your user profile or on another drive.');
      if (mode === 'new' && info.exists && !info.empty && !info.hasServer && !info.manifest && !(await exists(path.join(resolved, MARKER)))) errors.push('This folder already contains other files. Please choose an empty folder or a new folder name so nothing gets overwritten.');
      if (mode === 'attach' && !info.hasServer && !info.manifest) errors.push('No Satisfactory dedicated server was found in this folder.');
      if (info.hasServer && mode === 'new') warnings.push('A dedicated server is already installed here. It will be attached and verified instead of downloaded again.');
      if (info.partial) warnings.push('A partially completed installation was found here. Setup will resume and repair it.');
      if (info.free !== null && info.free < sys.MIN_FREE_BYTES && !info.hasServer) errors.push(`Only ${(info.free / 1024 ** 3).toFixed(1)} GB is free on this drive; at least 15 GB is required.`);
    }
    return { ok: errors.length === 0, errors, warnings, info, dir: resolved };
  }

  async confirmLocation({ dir, name, branch = 'public', mode = 'new', confirmed }) {
    if (!confirmed) throw new AppError('E_CONFIRM_REQUIRED', 'Please confirm the installation folder.');
    if (this.abort) throw new AppError('E_BUSY', 'An operation is in progress.');
    const check = await this.validateLocation(dir, mode);
    if (!check.ok) throw new AppError('E_LOCATION', check.errors.join(' '));
    const resolved = check.dir;
    const effectiveMode = check.info.hasServer || check.info.manifest ? 'attach' : 'new';
    const existing = this.server;
    let createdByWizard = false;
    if (effectiveMode === 'new') {
      createdByWizard = !check.info.exists || check.info.empty;
      await fsp.mkdir(resolved, { recursive: true });
      if (createdByWizard || (await exists(path.join(resolved, MARKER)))) {
        await fsp.writeFile(path.join(resolved, MARKER), JSON.stringify({ createdBy: 'Satisfactory Server Manager setup', at: Date.now() }));
        createdByWizard = true;
      }
    }
    let srv;
    if (existing) {
      if (path.resolve(existing.installDir) !== resolved) {
        if (this.ctx.supervisor.isActive(existing.id)) throw new AppError('E_SERVER_RUNNING', 'Stop the server before changing its folder.');
        this.ctx.registry.setInstallDir(existing.id, resolved, 'setup');
      }
      srv = this.ctx.registry.update(existing.id, { name, config: { branch } }, { actor: 'setup', reason: 'setup' }).server;
    } else {
      const ports = this.ctx.registry.suggestPorts();
      srv = this.ctx.registry.create({ name, installDir: resolved, config: { branch, launch: ports } }, 'setup');
    }
    this.s.serverId = srv.id;
    this.s.location = { dir: resolved, name, branch, mode: effectiveMode, createdByWizard, confirmedAt: Date.now() };
    this.s.completed.location = Date.now();
    delete this.s.completed.install;
    this._log('location', true, `Server folder set to ${resolved} (${effectiveMode === 'attach' ? 'existing installation' : 'new installation'})`);
    this._save();
    return this.state();
  }

  // ------------------------------------------------------------ helpers for long operations
  async _operation(kind, fn) {
    if (this.abort) throw new AppError('E_BUSY', 'Another setup operation is already running.');
    this.abort = new AbortController();
    this.s.activeOperation = { kind, startedAt: Date.now() };
    this.s.lastError = null;
    delete this.s.interrupted;
    this._save();
    try {
      const res = await fn(this.abort.signal);
      this._log(kind, true, res && res.message ? res.message : `${kind} completed`);
      return res;
    } catch (err) {
      const cancelled = this.abort && this.abort.signal.aborted;
      this.s.lastError = { kind, code: cancelled ? 'E_CANCELLED' : err.code || 'E_FAILED', message: cancelled ? 'The operation was cancelled.' : friendly(err), at: Date.now() };
      this._log(kind, false, this.s.lastError.message);
      throw cancelled ? new AppError('E_CANCELLED', 'The operation was cancelled. You can resume it at any time.') : err;
    } finally {
      this.abort = null;
      this.s.activeOperation = null;
      this._progress(null);
      this._save();
    }
  }

  cancel() {
    if (!this.abort) return { cancelled: false };
    this.abort.abort();
    this.ctx.steamcmd.cancel();
    return { cancelled: true };
  }

  // ------------------------------------------------------------ 4. dependencies
  async installDependencies({ installVcRedist = false } = {}) {
    return this._operation('dependencies', async (signal) => {
      const st = await this.ctx.steamcmd.status();
      if (signal.aborted) throw new Error('cancelled');
      if (!st.installed) {
        this._progress({ phase: 'Downloading SteamCMD from Valve', percent: 0 });
        await this.ctx.steamcmd.ensureInstalled({ onProgress: (p) => this._progress({ phase: 'Downloading SteamCMD from Valve', percent: p.total ? (p.received / p.total) * 100 : null, done: p.received, total: p.total }) });
      }
      if (signal.aborted) throw new Error('cancelled');
      if (!this.s.completed.dependencies || !st.installed) {
        this._progress({ phase: 'Updating SteamCMD (first run can take a few minutes)', percent: null });
        const r = await this.ctx.steamcmd.selfUpdate();
        if (r.offline) throw new AppError('E_STEAMCMD_OFFLINE', 'SteamCMD was downloaded, but it could not connect to Steam to finish setting itself up. Check your internet connection (and that a firewall or proxy is not blocking Steam), then select “Install & continue” again.');
        if (r.ok === false) this._log('dependencies', false, `SteamCMD self-update exited with code ${r.code}`);
      }
      if (installVcRedist) await this._installVcRedist(signal);
      this.ctx.audit.record({ actor: 'setup', action: 'setup.dependencies', details: { steamcmdDownloaded: !st.installed, vcRedist: installVcRedist } });
      this.s.completed.dependencies = Date.now();
      return { message: 'SteamCMD is installed and up to date' };
    });
  }

  async _installVcRedist(signal) {
    if (process.platform !== 'win32') return;
    const before = await sys.vcRuntime();
    if (before.installed) return;
    const file = path.join(this.ctx.paths.temp, 'vc_redist.x64.exe');
    this._progress({ phase: 'Downloading Microsoft Visual C++ runtime', percent: 0 });
    await download(sys.VCREDIST_URL, file, { hosts: sys.VCREDIST_HOSTS, maxBytes: 100 * 1024 * 1024, signal, onProgress: (p) => this._progress({ phase: 'Downloading Microsoft Visual C++ runtime', percent: p.total ? (p.received / p.total) * 100 : null }) });
    // Verify Microsoft's Authenticode signature before running the installer.
    const sig = await sys.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$s = Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; Write-Output ($s.Status.ToString() + '|' + $s.SignerCertificate.Subject)`]);
    const [status, subject = ''] = sig.stdout.trim().split('|');
    if (status !== 'Valid' || !/O=Microsoft Corporation/i.test(subject)) { await fsp.rm(file, { force: true }); throw new AppError('E_SIGNATURE', 'The downloaded Visual C++ installer is not validly signed by Microsoft and was deleted.'); }
    this._progress({ phase: 'Installing Microsoft Visual C++ runtime (confirm the Windows prompt)', percent: null });
    const r = await sys.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = Start-Process -FilePath '${file.replace(/'/g, "''")}' -ArgumentList '/install','/passive','/norestart' -Verb RunAs -Wait -PassThru; exit $p.ExitCode`], 15 * 60000);
    await fsp.rm(file, { force: true });
    const after = await sys.vcRuntime();
    // 3010 = success, reboot required; 1638 = newer version already installed
    if (!after.installed && ![0, 3010, 1638].includes(r.code)) throw new AppError('E_VCREDIST', r.code === 1223 || /cancel/i.test(r.stderr) ? 'The Windows permission prompt was cancelled; the Visual C++ runtime was not installed.' : `The Visual C++ runtime installer failed (exit code ${r.code}).`);
    this.s.vcRedist = { installedAt: Date.now(), version: after.version, rebootRequired: r.code === 3010 };
    this.ctx.audit.record({ actor: 'setup', action: 'setup.vcredist', details: { exitCode: r.code, version: after.version } });
  }

  // ------------------------------------------------------------ 5. server installation
  async installServer({ repair = false } = {}) {
    const srv = this.server;
    if (!srv) throw new AppError('E_STEP_INCOMPLETE', 'Choose the server folder first.');
    const { install } = await this.verify();
    if (install.state === 'complete' && !repair) {
      this.s.completed.install = Date.now();
      this._log('install', true, `Server already installed (build ${install.buildId}); nothing to download.`);
      this._save();
      return { skipped: true, buildId: install.buildId };
    }
    return this._operation('install', async (signal) => {
      const space = await diskSpace(srv.installDir);
      if (install.state === 'not-started' && space.free < sys.MIN_FREE_BYTES) throw new AppError('E_DISK_SPACE', `Not enough free disk space (${(space.free / 1024 ** 3).toFixed(1)} GB free, 15 GB needed).`);
      this._progress({ phase: install.state === 'partial' ? 'Resuming the interrupted installation' : 'Connecting to Steam', percent: null });
      const res = await this.ctx.steamcmd.installApp(srv.installDir, {
        branch: srv.config.branch, validate: true, signal, label: `setup:${srv.name}`,
        onProgress: (p) => this._progress({ phase: phaseLabel(p.state), percent: p.percent, done: p.done, total: p.total }),
      });
      const manifest = await readAppManifest(srv.installDir);
      const exe = await exists(layout.serverExecutable(srv.installDir));
      if (!manifest || !manifest.fullyInstalled || !exe) throw new AppError('E_INSTALL_VERIFY', 'SteamCMD finished, but the installation could not be verified (server files are missing). Use "Repair installation" to try again.');
      await fsp.rm(path.join(srv.installDir, MARKER), { force: true });
      if (this.s.location) this.s.location.createdByWizard = false; // contains a real installation now: never auto-clean
      this.s.completed.install = Date.now();
      this.ctx.db.run('INSERT INTO updates (ts, server_id, kind, to_version, status, details) VALUES (?, ?, ?, ?, ?, ?)', Date.now(), srv.id, 'install', manifest.buildId, 'completed', JSON.stringify({ branch: manifest.branch, repair }));
      this.ctx.audit.record({ actor: 'setup', action: repair ? 'server.repair' : 'server.install', serverId: srv.id, target: srv.name, details: { buildId: manifest.buildId, branch: manifest.branch, steamcmdExit: res.code } });
      return { message: `Satisfactory Dedicated Server build ${manifest.buildId} installed and verified`, buildId: manifest.buildId };
    });
  }

  /** Branches published on Steam (public / experimental), for the branch picker. */
  async branches() {
    try {
      const info = await this.ctx.updates.publishedBuilds();
      return Object.entries(info.branches).filter(([, b]) => !b.passwordRequired).map(([name, b]) => ({ name, buildId: b.buildId, timeUpdated: b.timeUpdated }));
    } catch (err) {
      return [{ name: 'public', buildId: null }, { name: 'experimental', buildId: null, note: 'Availability will be verified during installation.' }].map((b) => ({ ...b, error: err.message }));
    }
  }

  /**
   * Safe cleanup of an interrupted *new* installation: only removes a folder
   * this wizard created (marker file present) that does not hold a completed
   * installation. Never touches attached or completed installations.
   */
  async cleanup({ confirm = false, removeServer = true } = {}) {
    if (!confirm) throw new AppError('E_CONFIRM_REQUIRED', 'Cleanup removes the partially downloaded server files. Please confirm.');
    if (this.abort) throw new AppError('E_BUSY', 'Cancel the running operation first.');
    const srv = this.server;
    const loc = this.s.location;
    if (!srv || !loc) return this.state();
    const { install } = await this.verify();
    if (install.state === 'complete') throw new AppError('E_INSTALLED', 'This folder contains a complete installation and will not be removed.');
    if (!loc.createdByWizard || !(await exists(path.join(srv.installDir, MARKER)))) throw new AppError('E_NOT_OWNED', 'This folder was not created by the setup wizard, so it will not be deleted automatically.');
    if (this.ctx.supervisor.isActive(srv.id)) throw new AppError('E_SERVER_RUNNING', 'Stop the server first.');
    for (const e of await fsp.readdir(srv.installDir)) await fsp.rm(path.join(srv.installDir, e), { recursive: true, force: true });
    await fsp.rmdir(srv.installDir).catch(() => {});
    this.ctx.audit.record({ actor: 'setup', action: 'setup.cleanup', serverId: srv.id, target: srv.installDir });
    if (removeServer) { this.ctx.registry.remove(srv.id, 'setup'); this.s.serverId = null; this.s.location = null; }
    delete this.s.completed.install; delete this.s.completed.location; delete this.s.interrupted;
    this.s.step = 'location';
    this._log('install', true, 'Partial installation removed');
    this._save();
    return this.state();
  }

  // ------------------------------------------------------------ 6. network
  async network() {
    const srv = this.server;
    if (!srv) throw new AppError('E_STEP_INCOMPLETE', 'Choose the server folder first.');
    const running = this.ctx.supervisor.isActive(srv.id);
    const { port, reliablePort } = srv.config.launch;
    const ports = [];
    for (const [p, proto, purpose] of [[port, 'udp', 'Game'], [port, 'tcp', 'HTTPS API'], [reliablePort, 'tcp', 'Reliable messaging']]) {
      ports.push({ port: p, protocol: proto.toUpperCase(), purpose, free: running ? null : await checkPortFree(p, proto), note: running ? 'In use by this server (it is running)' : null });
    }
    const fw = await firewall.inspect(srv);
    return { ports, conflicts: ports.filter((p) => p.free === false), firewall: fw, suggestion: this.ctx.registry.suggestPorts(), lan: sys.lanAddresses() };
  }

  async changePorts({ port, reliablePort }) {
    const srv = this.server;
    if (!srv) throw new AppError('E_STEP_INCOMPLETE', 'Choose the server folder first.');
    this.ctx.registry.update(srv.id, { config: { launch: { port, reliablePort } } }, { actor: 'setup', reason: 'setup: port change' });
    this._log('network', true, `Ports changed to ${port}/${reliablePort}`);
    this._save();
    return this.network();
  }

  async configureFirewall({ confirm = false } = {}) {
    if (!confirm) throw new AppError('E_CONFIRM_REQUIRED', 'Creating firewall rules requires your permission.');
    const srv = this.server;
    const res = await firewall.createRules(srv);
    this.ctx.audit.record({ actor: 'setup', action: 'firewall.create', serverId: srv.id, target: srv.name, details: { created: res.created } });
    this._log('network', true, res.created.length ? `Created ${res.created.length} firewall rule(s)` : 'Firewall rules already present');
    this._save();
    return this.network();
  }

  async completeNetwork({ skipReason } = {}) {
    const n = await this.network();
    if (n.conflicts.length && !skipReason) throw new AppError('E_PORT_CONFLICT', `Port ${n.conflicts.map((c) => `${c.protocol} ${c.port}`).join(', ')} is in use by another program. Choose different ports first.`);
    if (skipReason) this.s.skipped.network = skipReason; else this.s.completed.network = Date.now();
    this._save();
    return this.state();
  }

  // ------------------------------------------------------------ 7. security
  /** Start the server so it can be claimed; waits until it answers. */
  async startForSecurity() {
    const srv = this.server;
    return this._operation('security-start', async (signal) => {
      if (!this.ctx.supervisor.isActive(srv.id)) await this.ctx.supervisor.start(srv.id, { trigger: 'setup', actor: 'setup' });
      const end = Date.now() + 10 * 60000;
      while (Date.now() < end) {
        if (signal.aborted) { await this.ctx.supervisor.stop(srv.id, { reason: 'Setup cancelled', force: true, actor: 'setup' }).catch(() => {}); throw new Error('cancelled'); }
        const st = this.ctx.supervisor.status(srv.id);
        this._progress({ phase: st.status === 'running' ? 'Server is up' : 'Starting the server for the first time (this can take a few minutes)', percent: null });
        if (st.status === 'running' && st.readyAt) return { message: 'Server started' };
        if (['crashed', 'stopped'].includes(st.status)) throw new AppError('E_START', `The server stopped during start-up: ${st.lastExit ? st.lastExit.reason : 'unknown reason'}. Open the console after setup for details.`);
        await sleep(1500);
      }
      throw new AppError('E_START_TIMEOUT', 'The server did not respond within 10 minutes.');
    });
  }

  async accessStatus() { return this.server ? this.ctx.access.status(this.s.serverId) : null; }

  async claim({ serverName, adminPassword, clientPassword }) {
    validatePassword(adminPassword, 'administrator');
    const r = await this.ctx.access.claim(this.s.serverId, { serverName, adminPassword, actor: 'setup' });
    if (clientPassword) await this.ctx.access.setClientPassword(this.s.serverId, { password: clientPassword, actor: 'setup' });
    this.s.completed.security = Date.now();
    delete this.s.skipped.security;
    this._log('security', true, `Server claimed; ${r.tokenKind === 'api' ? 'API token' : 'administrator token'} stored securely`);
    this._save();
    return this.state();
  }

  async login({ adminPassword }) {
    const r = await this.ctx.access.login(this.s.serverId, { adminPassword, actor: 'setup' });
    this.s.completed.security = Date.now();
    delete this.s.skipped.security;
    this._log('security', true, `Signed in; ${r.tokenKind} token stored securely`);
    this._save();
    return this.state();
  }

  skipSecurity(reason = 'Skipped by user') {
    this.s.skipped.security = reason;
    this._log('security', true, 'Security setup skipped — graceful stop, player count and live settings will be unavailable until configured.');
    this._save();
    return this.state();
  }

  // ------------------------------------------------------------ 8/9. review & finish
  async review() {
    const srv = this.server;
    const v = await this.verify();
    return {
      server: srv ? { id: srv.id, name: srv.name, dir: srv.installDir, branch: srv.config.branch, port: srv.config.launch.port, reliablePort: srv.config.launch.reliablePort } : null,
      steamcmd: v.steamcmd, install: v.install, apiAccess: v.hasToken, skipped: this.s.skipped, vcRedist: this.s.vcRedist,
      appDataDir: this.ctx.paths.userData, appInstallDir: this.ctx.paths.appInstallDir,
      operations: this.s.log, running: srv ? this.ctx.supervisor.status(srv.id).status : null, lan: sys.lanAddresses(),
    };
  }

  async finish({ startServer = false, autoStart = false } = {}) {
    const v = await this.verify();
    if (!v.verified.install) throw new AppError('E_STEP_INCOMPLETE', 'The server installation has not been completed.');
    const srv = this.server;
    if (autoStart) {
      const st = this.ctx.settings.get('startup');
      if (!st.autoStartServers.includes(srv.id)) this.ctx.settings.update('startup', { autoStartServers: [...st.autoStartServers, srv.id] });
    }
    if (startServer && !this.ctx.supervisor.isActive(srv.id)) await this.ctx.supervisor.start(srv.id, { trigger: 'setup', actor: 'setup' });
    this.s.completed.finish = Date.now();
    this.s.step = 'finish';
    this._save();
    this.ctx.settings.update('general', { firstRunComplete: true });
    this.ctx.audit.record({ actor: 'setup', action: 'setup.complete', serverId: srv.id, target: srv.name, details: { startServer, autoStart } });
    return { done: true, serverId: srv.id };
  }

  /** Start a fresh wizard run (e.g. "Add another server" or after completion). */
  reset() {
    if (this.abort) throw new AppError('E_BUSY', 'An operation is running.');
    this.s = blank();
    this._save();
    return this.publicState();
  }
}

function phaseLabel(state) {
  const s = String(state).toLowerCase();
  if (s.includes('download')) return 'Downloading server files';
  if (s.includes('verif') || s.includes('validat')) return 'Verifying server files';
  if (s.includes('commit')) return 'Writing files to disk';
  if (s.includes('prealloc')) return 'Reserving disk space';
  if (s.includes('reconfig')) return 'Preparing installation';
  return `Steam: ${state}`;
}

function validatePassword(pw, label) {
  if (typeof pw !== 'string' || pw.length < 8) throw new AppError('E_VALIDATION', `The ${label} password must be at least 8 characters long.`);
}

/** Translate low-level failures into plain-language explanations. */
function friendly(err) {
  const m = String(err && err.message ? err.message : err);
  // Application errors already carry a plain-language message; only translate
  // raw system errors and SteamCMD failures.
  if (err && typeof err.code === 'string' && /^E_/.test(err.code) && err.code !== 'E_STEAM_INSTALL') return m;
  if (/ENOSPC|Disk write failure|not enough free/i.test(m)) return 'The drive ran out of free space. Free up space or choose another drive, then resume.';
  if (/EACCES|EPERM|permission/i.test(m)) return 'Windows denied access to the folder. Choose a folder in your user profile, or check that no antivirus program is blocking it.';
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|No Connection|timed out|needs to be online|Login Failure|connection/i.test(m)) return 'The download was interrupted by a network problem. Check your internet connection and select "Resume" — finished parts are kept.';
  if (/Invalid platform|No subscription/i.test(m)) return 'Steam refused the download for this branch. Choose the "public" branch and try again.';
  return m;
}

module.exports = { Setup, STEPS, MARKER, friendly, phaseLabel };
