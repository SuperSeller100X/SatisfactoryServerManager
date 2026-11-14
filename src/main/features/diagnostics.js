'use strict';
/**
 * Diagnostic assistant. Each check inspects real state and returns findings:
 *   { id, check, severity, title, explanation, evidence[], solution,
 *     repair?: { action, label, safe, needsConfirm, description } }
 * Repairs are only offered for understood operations; after a repair the
 * originating check is re-run and the result reported — a problem is never
 * reported as fixed without that verification.
 */
const fsp = require('node:fs/promises');
const path = require('node:path');
const layout = require('../server/layout');
const firewall = require('./firewall');
const sys = require('./system');
const { readAppManifest, hasPendingDownload } = require('../steam/steamcmd');
const { checkPortFree } = require('../server/supervisor');
const { exists, diskSpace, listFiles, writeFileAtomic } = require('../core/fsutil');
const { createZip } = require('../core/zip');
const { IniDocument } = require('../server/ini');
const { AppError, redactText } = require('../core/util');

const SEV_ORDER = { critical: 0, error: 1, warning: 2, info: 3, ok: 4 };

class Diagnostics {
  constructor(ctx) {
    this.ctx = ctx;
    this.checks = {
      steamcmd: { label: 'SteamCMD installation', fn: (s) => this.checkSteamCmd(s) },
      files: { label: 'Dedicated server files', fn: (s) => this.checkFiles(s) },
      process: { label: 'Server process', fn: (s) => this.checkProcess(s) },
      api: { label: 'Server API connectivity', fn: (s) => this.checkApi(s) },
      ports: { label: 'Port configuration & conflicts', fn: (s) => this.checkPorts(s) },
      firewall: { label: 'Firewall rules', fn: (s) => this.checkFirewall(s) },
      disk: { label: 'Disk space', fn: (s) => this.checkDisk(s) },
      saves: { label: 'Save files', fn: (s) => this.checkSaves(s) },
      mods: { label: 'Mod compatibility & dependencies', fn: (s) => this.checkMods(s) },
      crashes: { label: 'Recent crashes', fn: (s) => this.checkCrashes(s) },
      config: { label: 'Configuration', fn: (s) => this.checkConfig(s) },
      logs: { label: 'Application log', fn: () => this.checkAppLog() },
      runtime: { label: 'System runtime', fn: () => this.checkRuntime() },
    };
  }

  f(check, severity, title, explanation, evidence = [], solution = '', repair = null) {
    return { id: `${check}:${title}`.replace(/\s+/g, '-').toLowerCase(), check, severity, title, explanation, evidence: evidence.map((e) => redactText(String(e))), solution, repair };
  }

  async run(serverId, { only } = {}) {
    const srv = serverId ? this.ctx.registry.get(serverId) : null;
    const started = Date.now();
    const results = [];
    for (const [key, c] of Object.entries(this.checks)) {
      if (only && !only.includes(key)) continue;
      if (!srv && !['steamcmd', 'logs', 'runtime'].includes(key)) continue;
      try {
        const findings = await c.fn(srv);
        results.push({ check: key, label: c.label, findings: findings.length ? findings : [this.f(key, 'ok', `${c.label}: no problems found`, '')] });
      } catch (err) {
        results.push({ check: key, label: c.label, findings: [this.f(key, 'warning', `${c.label} could not be checked`, 'The check itself failed, so this area could not be verified.', [err.message])] });
      }
    }
    const all = results.flatMap((r) => r.findings).sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
    const summary = { critical: 0, error: 0, warning: 0, info: 0, ok: 0 };
    for (const x of all) summary[x.severity]++;
    return { serverId, ranAt: started, durationMs: Date.now() - started, summary, results, findings: all };
  }

  // ------------------------------------------------------------ checks
  async checkSteamCmd() {
    const st = await this.ctx.steamcmd.status();
    if (!st.installed) return [this.f('steamcmd', 'error', 'SteamCMD is not installed', 'SteamCMD is Valve\'s command-line tool that downloads and updates the dedicated server. Without it the server cannot be installed or updated.', [`Expected at ${st.exe}`], 'Install SteamCMD (downloaded from Valve\'s official CDN).', { action: 'install-steamcmd', label: 'Install SteamCMD', safe: true, needsConfirm: false, description: 'Downloads steamcmd from steamcdn-a.akamaihd.net and runs its self-update.' })];
    return [];
  }

  async checkFiles(srv) {
    const out = [];
    const exe = layout.serverExecutable(srv.installDir);
    const manifest = await readAppManifest(srv.installDir);
    if (!(await exists(srv.installDir))) return [this.f('files', 'critical', 'Server folder is missing', 'The folder configured for this server does not exist. It may have been moved, renamed or deleted.', [srv.installDir], 'If you moved the server, use Migration → Move to point the manager at the new folder. Otherwise reinstall.', { action: 'validate', label: 'Reinstall server files', safe: true, needsConfirm: true, description: 'Downloads the dedicated server into the configured folder with SteamCMD.' })];
    if (!(await exists(exe))) out.push(this.f('files', 'critical', 'Server executable is missing', 'The main server program file was not found, so the server cannot start.', [exe], 'Validate the installation with SteamCMD; it re-downloads missing files without touching saves.', { action: 'validate', label: 'Repair installation', safe: true, needsConfirm: true, description: 'Stops the server if needed, backs up saves, then runs SteamCMD app_update 1690800 validate.' }));
    if (!manifest) out.push(this.f('files', 'warning', 'Steam installation record not found', 'The Steam app manifest (appmanifest_1690800.acf) is missing, so the installed version cannot be determined and updates cannot be detected.', [layout.appManifest(srv.installDir)], 'Validate the installation with SteamCMD to recreate it.', { action: 'validate', label: 'Validate installation', safe: true, needsConfirm: true, description: 'Runs SteamCMD app_update 1690800 validate.' }));
    else {
      if (!manifest.fullyInstalled) out.push(this.f('files', 'error', 'Installation is incomplete', 'Steam reports that the installation is not fully completed (for example an interrupted download or update).', [`StateFlags=${manifest.stateFlags}`], 'Validate the installation to finish it.', { action: 'validate', label: 'Complete installation', safe: true, needsConfirm: true, description: 'Runs SteamCMD app_update 1690800 validate.' }));
      if (manifest.branch !== (srv.config.branch || 'public')) out.push(this.f('files', 'warning', 'Installed branch differs from the configured branch', `The installed files are from the "${manifest.branch}" branch but this server is configured for "${srv.config.branch}".`, [`manifest BetaKey=${manifest.branch}`], 'Run an update to switch the files to the configured branch, or change the branch setting.'));
    }
    if (await hasPendingDownload(srv.installDir)) out.push(this.f('files', 'info', 'Leftover download data found', 'Temporary files from an interrupted download are present. They are reused by the next update or can be removed in Storage.', [path.join(srv.installDir, 'steamapps', 'downloading')], 'Run an update or validation; SteamCMD resumes and clears them.'));
    return out;
  }

  async checkProcess(srv) {
    const out = [];
    const st = this.ctx.supervisor.status(srv.id);
    const exe = layout.serverExecutable(srv.installDir);
    const procs = (await this.ctx.probe.findByPathPrefix(path.dirname(exe)).catch(() => [])).filter((p) => p.exe && path.resolve(p.exe).toLowerCase() === path.resolve(exe).toLowerCase());
    if (!this.ctx.supervisor.isActive(srv.id) && procs.length) out.push(this.f('process', 'warning', 'Server is running outside the manager', 'A server process from this installation is running, but the manager is not tracking it (it was started elsewhere or before the manager).', procs.map((p) => `PID ${p.pid}: ${p.exe}`), 'Attach it so the manager can monitor and stop it safely.', { action: 'attach', label: 'Attach to process', safe: true, needsConfirm: false, description: 'Starts monitoring the existing process. Nothing is restarted.' }));
    if (procs.length > 1) out.push(this.f('process', 'error', 'Multiple server processes from the same folder', 'More than one server process uses this installation. They will fight over ports and save files.', procs.map((p) => `PID ${p.pid}`), 'Stop the extra processes using Task Manager, then start the server from the manager.'));
    if (st.status === 'crashed') out.push(this.f('process', 'error', 'Server crashed and is not running', st.lastExit ? `Last exit: ${st.lastExit.reason}` : 'The server is not running after an unexpected exit.', st.lastExit ? [`exit code ${st.lastExit.code}`] : [], 'Review the crash history below, then start the server again.'));
    return out;
  }

  async checkApi(srv) {
    if (!this.ctx.supervisor.isActive(srv.id)) return [this.f('api', 'info', 'API not checked (server stopped)', 'The server API is only reachable while the server runs.')];
    const out = [];
    try {
      const r = await this.ctx.supervisor.api(srv.id).healthCheck();
      if (r.data && r.data.health !== 'healthy') out.push(this.f('api', 'warning', 'Server reports degraded health', 'The server answered the health check but reports it is running slowly.', [`health=${r.data.health}`], 'Check CPU usage and the console for warnings. Large factories may need a faster CPU.'));
    } catch (err) {
      if (err.code === 'E_API_CERT_CHANGED') out.push(this.f('api', 'error', 'Server certificate changed', 'The server presented a different TLS certificate than before. This happens after reinstalling the server, but could also indicate interception.', [`expected ${err.details.expected}`, `received ${err.details.actual}`], 'If you reinstalled or reset the server, trust the new certificate.', { action: 'reset-pin', label: 'Trust new certificate', safe: false, needsConfirm: true, description: 'Forgets the old fingerprint; the next connection is trusted on first use.' }));
      else out.push(this.f('api', 'error', 'Server API is not reachable', 'The HTTPS API on the game port did not respond. The server may still be loading, or another program uses the port.', [err.message], 'Wait until the server finished loading; check the port configuration.'));
      return out;
    }
    if (!this.ctx.supervisor.hasToken(srv.id)) out.push(this.f('api', 'warning', 'No API access configured', 'Without API access the manager cannot read player counts, save before stopping, or apply live settings.', [], 'Open the server\'s Access tab and claim the server or sign in with the administrator password.'));
    else {
      try { await this.ctx.supervisor.api(srv.id).verifyToken(this.ctx.secrets.get(this.ctx.supervisor.tokenKey(srv.id))); } catch (err) { out.push(this.f('api', 'error', 'Stored API token was rejected', 'The server no longer accepts the stored token (it may have been invalidated with server.InvalidateAPITokens or the server was reset).', [err.message], 'Sign in again on the server\'s Access tab.')); }
    }
    return out;
  }

  async checkPorts(srv) {
    const out = [];
    const { port, reliablePort } = srv.config.launch;
    const others = this.ctx.registry.list().filter((s) => s.id !== srv.id);
    for (const o of others) for (const p of [port, reliablePort]) if ([o.config.launch.port, o.config.launch.reliablePort].includes(p)) out.push(this.f('ports', 'error', `Port ${p} is shared with ${o.name}`, 'Two servers cannot use the same ports.', [`${srv.name}: ${port}/${reliablePort}`, `${o.name}: ${o.config.launch.port}/${o.config.launch.reliablePort}`], 'Change the ports of one server in Settings → Network.'));
    if (!this.ctx.supervisor.isActive(srv.id)) {
      for (const [p, proto] of [[port, 'udp'], [port, 'tcp'], [reliablePort, 'tcp']]) {
        if (!(await checkPortFree(p, proto))) out.push(this.f('ports', 'error', `${proto.toUpperCase()} port ${p} is already in use`, 'Another program is using a port this server needs, so the server would fail to start.', [`bind ${proto} 0.0.0.0:${p} failed`], `Close the other program or change this server's port. A free pair is ${JSON.stringify(this.ctx.registry.suggestPorts())}.`));
      }
    }
    return out;
  }

  async checkFirewall(srv) {
    const fw = await firewall.inspect(srv);
    if (!fw.supported) return [this.f('firewall', 'info', 'Firewall check not available', fw.note)];
    if (fw.error) return [this.f('firewall', 'warning', 'Firewall rules could not be read', fw.error)];
    if (fw.firewallEnabled && !fw.allPresent) {
      const missing = fw.rules.filter((r) => !r.present);
      return [this.f('firewall', 'warning', 'Firewall may block players', 'Windows Defender Firewall is enabled and the inbound rules for this server\'s ports are missing, so players on other computers may not be able to connect.', missing.map((m) => `${m.protocol} ${m.port} (${m.purpose})`), 'Create the inbound firewall rules (requires administrator permission). Router port forwarding is separate and must be set on your router.', { action: 'firewall', label: 'Create firewall rules', safe: false, needsConfirm: true, description: 'Opens a Windows administrator prompt and creates inbound allow rules for exactly these ports.' })];
    }
    return [];
  }

  async checkDisk(srv) {
    const d = await diskSpace(srv.installDir);
    const warn = this.ctx.settings.get('monitoring').diskWarnGb * 1024 ** 3;
    if (d.free < 2 * 1024 ** 3) return [this.f('disk', 'critical', 'Disk almost full', 'Saving, updating or backing up can fail and corrupt data when the drive is full.', [`${(d.free / 1024 ** 3).toFixed(2)} GB free on ${d.path}`], 'Free up disk space now. Open Storage to see what uses space.')];
    if (d.free < warn) return [this.f('disk', 'warning', 'Low disk space', 'Updates need several GB of temporary space.', [`${(d.free / 1024 ** 3).toFixed(1)} GB free on ${d.path}`], 'Open Storage for cleanup recommendations.')];
    return [];
  }

  async checkSaves(srv) {
    const out = [];
    const saves = await this.ctx.backups.listSaves(srv.id);
    if (!saves.saves.length) out.push(this.f('saves', 'info', 'No save files yet', 'No game has been created or saved on this server yet.', [saves.dir], 'Create a game from the in-game Server Manager, or upload an existing save under Backups.'));
    for (const s of saves.saves.slice(0, 50)) if (s.size < 1024) out.push(this.f('saves', 'error', `Save file looks damaged: ${s.name}`, 'This save file is unusually small and is probably incomplete.', [`${s.size} bytes`], 'Restore an earlier backup of this save.'));
    if (saves.sharedWith.length) out.push(this.f('saves', 'info', 'Save folder shared with other servers', 'Dedicated servers running under the same Windows user store saves in the same folder. Backups of this server include those saves too.', [saves.dir, `shared with: ${saves.sharedWith.join(', ')}`], 'Use different session names on each server to keep saves apart.'));
    if (!(await exists(saves.dir)) && srv.config.saveRoot) out.push(this.f('saves', 'warning', 'Configured save folder does not exist', 'The custom save folder was not found.', [saves.dir], 'Check the save folder setting.', { action: 'create-save-dir', label: 'Create folder', safe: true, needsConfirm: false, description: 'Creates the empty folder.' }));
    return out;
  }

  async checkMods(srv) {
    const out = [];
    const a = await this.ctx.mods.analyze(srv.id);
    for (const i of a.issues) {
      const repair = i.kind === 'missing-dependency' || i.kind === 'no-sml' ? { action: 'install-mod', ref: i.dependency || 'SML', label: `Install ${i.dependency || 'SML'}`, safe: true, needsConfirm: true, description: 'Resolves a compatible dedicated-server build from FICSIT and installs it (server must be stopped).' } : null;
      out.push(this.f('mods', i.severity, i.message, i.kind === 'version-conflict' ? 'Two mods expect different versions of the same dependency.' : i.kind === 'invalid' ? 'The mod folder is incomplete or damaged.' : 'A required mod is missing, so dependent mods will fail to load.', [i.mod ? `mod: ${i.mod}` : '', i.dependency ? `dependency: ${i.dependency}` : ''].filter(Boolean), 'Install the missing dependency or remove the mod that requires it.', repair));
    }
    const integ = await this.ctx.mods.integrity(srv.id);
    for (const r of integ.results) if (!r.ok) out.push(this.f('mods', 'error', `Mod files changed or missing: ${r.reference}`, 'Files installed by the manager no longer match their recorded checksums.', [...r.missing.slice(0, 5).map((m) => `missing ${m}`), ...r.modified.slice(0, 5).map((m) => `modified ${m}`)], 'Reinstall the mod.', { action: 'install-mod', ref: r.reference, version: r.version, label: `Reinstall ${r.reference}`, safe: true, needsConfirm: true, description: 'Downloads and reinstalls the same version.' }));
    if (a.mods.length && srv.config.cache.netCL) {
      try {
        const c = await this.ctx.mods.compatibility(srv.id);
        for (const m of c.mods) if (m.compat && m.compat.gameCompatible === false) out.push(this.f('mods', 'error', `${m.name} ${m.installed} is not compatible with this server version`, 'FICSIT lists this version as incompatible with the server\'s game changelist.', [`server changelist ${c.netCL}`], m.latestCompatible ? `Update to ${m.latestCompatible}.` : 'Remove it until a compatible version is published.'));
        else if (m.compat && !m.compat.serverBuild) out.push(this.f('mods', 'error', `${m.name} has no dedicated-server build`, 'The installed version only targets the game client.', [], 'Remove it from the server.'));
      } catch (err) { out.push(this.f('mods', 'info', 'Mod compatibility could not be checked online', 'The FICSIT repository was not reachable.', [err.message])); }
    }
    return out;
  }

  async checkCrashes(srv) {
    const rows = this.ctx.db.all('SELECT * FROM crashes WHERE server_id = ? AND at > ? ORDER BY at DESC', srv.id, Date.now() - 7 * 86400000);
    if (!rows.length) return [];
    const reasons = {};
    for (const r of rows) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
    const sev = rows.length >= 3 ? 'error' : 'warning';
    const hint = /memory/i.test(top[0][0]) ? 'The server ran out of memory. Close other programs or add RAM.' : /port/i.test(top[0][0]) ? 'Change the server ports or close the program using them.' : /Mod/i.test(top[0][0]) ? 'Update or remove recently changed mods.' : 'Open the crash details and diagnostics package for the full log.';
    return [this.f('crashes', sev, `${rows.length} crash(es) in the last 7 days`, `Most common cause: ${top[0][0]}.`, top.map(([r, n]) => `${n}× ${r}`), hint)];
  }

  async checkConfig(srv) {
    const out = [];
    const dir = layout.configDir(srv.installDir);
    for (const f of ['Game.ini', 'Engine.ini', 'GameUserSettings.ini']) {
      const p = path.join(dir, f);
      const text = await fsp.readFile(p, 'utf8').catch(() => null);
      if (text === null) continue;
      if (text.includes('\u0000')) out.push(this.f('config', 'error', `${f} is corrupted`, 'The file contains binary data, which usually happens after a crash during writing.', [p], 'Restore it from the manager\'s automatic copy (.ssm-bak) or a backup.', (await exists(`${p}.ssm-bak`)) ? { action: 'restore-ini', file: f, label: 'Restore previous copy', safe: true, needsConfirm: true, description: `Replaces ${f} with ${f}.ssm-bak (current file kept as ${f}.corrupt).` } : null));
      else {
        const doc = IniDocument.parseSections(text);
        if (f === 'Game.ini') {
          const mp = doc['/Script/Engine.GameSession'] && doc['/Script/Engine.GameSession'].MaxPlayers;
          if (mp && String(mp) !== String(srv.config.ini.maxPlayers)) out.push(this.f('config', 'info', 'Max players differs from the manager setting', 'It will be overwritten with the manager value at the next start.', [`Game.ini: ${mp}`, `manager: ${srv.config.ini.maxPlayers}`]));
        }
      }
    }
    if (srv.config.launch.multihome && !sys.lanAddresses().some((a) => a.address === srv.config.launch.multihome) && !['0.0.0.0', '::'].includes(srv.config.launch.multihome)) out.push(this.f('config', 'error', 'Multihome address is not assigned to this PC', 'The server is told to bind an IP address this computer does not have, so it will not be reachable.', [`multihome=${srv.config.launch.multihome}`, `local addresses: ${sys.lanAddresses().map((a) => a.address).join(', ')}`], 'Clear the multihome setting or set it to one of the local addresses.'));
    return out;
  }

  async checkAppLog() {
    const lines = this.ctx.logger.tail(500).filter((l) => /\[ERROR\]/.test(l));
    if (!lines.length) return [];
    return [this.f('logs', lines.length > 20 ? 'warning' : 'info', `${lines.length} error(s) in the manager log`, 'The manager recorded internal errors recently. Usually these relate to temporary problems (network, locked files).', lines.slice(-8), 'If problems persist, export a diagnostics package and review it.')];
  }

  async checkRuntime() {
    const out = [];
    const vc = await sys.vcRuntime();
    if (vc.applicable && !vc.installed) out.push(this.f('runtime', 'warning', 'Visual C++ runtime not found', 'Unreal Engine servers need the Microsoft Visual C++ 2015–2022 (x64) runtime. Without it the server may fail to start.', ['HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64 not present'], 'Install it from Microsoft: https://aka.ms/vs/17/release/vc_redist.x64.exe (the setup wizard can do this for you).'));
    const sec = this.ctx.secrets.status();
    if (sec.weak) out.push(this.f('runtime', 'warning', 'Weak credential storage', 'The operating system does not provide strong encryption for stored tokens.', [`backend: ${sec.backend}`], 'On Linux, install and unlock a keyring (GNOME Keyring / KWallet).'));
    return out;
  }

  // ------------------------------------------------------------ repairs
  async repair(serverId, finding, { confirm = false, actor = 'local' } = {}) {
    const r = finding && finding.repair;
    if (!r) throw new AppError('E_NO_REPAIR', 'No automatic repair is available for this problem.');
    if (r.needsConfirm && !confirm) throw new AppError('E_CONFIRM_REQUIRED', 'This repair needs your confirmation.');
    const srv = serverId ? this.ctx.registry.get(serverId) : null;
    const log = { actor, action: `diagnostics.repair.${r.action}`, serverId, target: finding.title };
    await this.ctx.audit.wrap(log, async () => {
      switch (r.action) {
        case 'install-steamcmd': await this.ctx.steamcmd.ensureInstalled(); await this.ctx.steamcmd.selfUpdate(); break;
        case 'validate': await this.ctx.updates.updateServer(serverId, { actor, trigger: 'repair', validateOnly: true }); break;
        case 'attach': await this.ctx.supervisor.adoptRunning(); break;
        case 'reset-pin': this.ctx.access.resetPin(serverId, actor); break;
        case 'firewall': await firewall.createRules(srv); break;
        case 'create-save-dir': await fsp.mkdir(srv.config.saveRoot, { recursive: true }); break;
        case 'install-mod': await this.ctx.mods.apply(serverId, [{ reference: r.ref, version: r.version }], { actor }); break;
        case 'restore-ini': {
          const p = path.join(layout.configDir(srv.installDir), r.file);
          await fsp.rename(p, `${p}.corrupt`);
          await fsp.copyFile(`${p}.ssm-bak`, p);
          break;
        }
        default: throw new AppError('E_NO_REPAIR', 'Unknown repair action');
      }
    });
    const verify = await this.run(serverId, { only: [finding.check] });
    const still = verify.findings.find((x) => x.title === finding.title && x.severity !== 'ok');
    return { repaired: !still, verification: verify, message: still ? 'The repair ran, but the problem is still detected. See the details for what remains.' : 'Repair verified: the problem is no longer detected.' };
  }

  /** Bundle diagnostics for a crash: console tail, run log, crash dumps metadata, system info. */
  async collectCrashPackage(serverId, runId, crashId) {
    const srv = this.ctx.registry.get(serverId);
    const dir = path.join(this.ctx.paths.diagnostics, serverId);
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `crash-${crashId}-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`);
    const entries = [];
    const run = this.ctx.db.get('SELECT * FROM runs WHERE id = ?', runId);
    const lines = this.ctx.settings.get('diagnostics').includeServerLogLines;
    if (run && run.log_path && (await exists(run.log_path))) {
      const text = await fsp.readFile(run.log_path, 'utf8');
      entries.push({ name: 'console.log', buffer: Buffer.from(redactText(text.split('\n').slice(-lines).join('\n'))) });
    }
    const gameLog = layout.logFile(srv.installDir);
    if (await exists(gameLog)) entries.push({ name: 'FactoryGame.log', buffer: Buffer.from(redactText((await fsp.readFile(gameLog, 'utf8')).split('\n').slice(-lines).join('\n'))) });
    const crashRoot = layout.crashesDir(srv.installDir);
    const recent = [];
    for (const d of await fsp.readdir(crashRoot).catch(() => [])) {
      const st = await fsp.stat(path.join(crashRoot, d)).catch(() => null);
      if (st && Date.now() - st.mtimeMs < 30 * 60000) recent.push(d);
    }
    for (const d of recent.slice(0, 2)) for (const rel of (await listFiles(path.join(crashRoot, d))).filter((r) => /\.(log|xml|txt|runtime-xml)$/i.test(r))) entries.push({ abs: path.join(crashRoot, d, rel), name: `crashes/${d}/${rel}` });
    const info = { generatedAt: new Date().toISOString(), server: { name: srv.name, branch: srv.config.branch, ports: srv.config.launch }, run, crash: this.ctx.db.get('SELECT * FROM crashes WHERE id = ?', crashId), os: sys.windowsInfo(), hardware: sys.hardware(), mods: await this.ctx.mods.installed(serverId).catch(() => []) };
    entries.push({ name: 'info.json', buffer: Buffer.from(JSON.stringify(info, null, 2)) });
    await createZip(file, entries);
    return file;
  }

  /** Full diagnostics export (user-triggered). */
  async exportReport(serverId, dest) {
    const report = await this.run(serverId);
    await writeFileAtomic(dest, JSON.stringify({ ...report, os: sys.windowsInfo(), hardware: sys.hardware(), managerLog: this.ctx.logger.tail(300) }, null, 2));
    return { path: dest };
  }
}

module.exports = { Diagnostics };
