'use strict';
/**
 * SteamCMD management: download (official Valve CDN), self-update, install /
 * update / validate App 1690800 and query published build IDs. Only one
 * SteamCMD process runs at a time (SteamCMD does not support concurrent use of
 * the same installation).
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { download } = require('../core/http');
const { extractZip } = require('../core/zip');
const { exists } = require('../core/fsutil');
const { AppError, KeyedLock } = require('../core/util');
const { parseVdf, getCI, extractAppInfo } = require('./vdf');
const { APP_ID, appManifest, IS_WIN } = require('../server/layout');

const STEAMCMD_URL = IS_WIN
  ? 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip'
  : 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz';

const PROGRESS_RE = /Update state \(0x([0-9a-f]+)\) ([\w ]+?), progress: ([\d.]+) \((\d+) \/ (\d+)\)/i;
const SUCCESS_RE = new RegExp(`Success! App '${APP_ID}' (fully installed|already up to date)`, 'i');
const ERROR_RE = /ERROR! (.+)/;

class SteamCmd {
  constructor({ dir, log, onOutput }) {
    this.dir = dir;
    this.log = log;
    this.onOutput = onOutput;
    this.lock = new KeyedLock();
    this.current = null;
  }

  get exe() { return path.join(this.dir, IS_WIN ? 'steamcmd.exe' : 'steamcmd.sh'); }
  get busy() { return this.lock.isLocked('steamcmd'); }

  async status() {
    const installed = await exists(this.exe);
    let lastRun = null;
    try { lastRun = (await fsp.stat(path.join(this.dir, 'logs', 'bootstrap_log.txt'))).mtimeMs; } catch { /* not run yet */ }
    let packageVersion = null;
    try {
      // steam_cmd package manifest written by the bootstrapper after self-update
      const text = await fsp.readFile(path.join(this.dir, 'package', `steam_cmd_${IS_WIN ? 'win32' : 'linux32'}.manifest`), 'utf8');
      const m = /"version"\s+"(\d+)"/.exec(text);
      if (m) packageVersion = m[1];
    } catch { /* manifest not present until first self-update */ }
    return { installed, dir: this.dir, exe: this.exe, busy: this.busy, operation: this.lock.holder('steamcmd') || null, lastRun, packageVersion };
  }

  /** Download and extract SteamCMD from Valve's CDN if missing. */
  async ensureInstalled({ onProgress } = {}) {
    if (await exists(this.exe)) return { downloaded: false };
    await fsp.mkdir(this.dir, { recursive: true });
    const archive = path.join(this.dir, path.basename(new URL(STEAMCMD_URL).pathname));
    this.log.info(`Downloading SteamCMD from ${STEAMCMD_URL}`);
    await download(STEAMCMD_URL, archive, { maxBytes: 50 * 1024 * 1024, onProgress: (p) => onProgress && onProgress({ phase: 'download', ...p }) });
    if (archive.endsWith('.zip')) await extractZip(archive, this.dir, { overwrite: true });
    else await new Promise((res, rej) => execFile('tar', ['-xzf', archive, '-C', this.dir], (e) => (e ? rej(e) : res())));
    await fsp.rm(archive, { force: true });
    if (!(await exists(this.exe))) throw new AppError('E_STEAMCMD_MISSING', 'SteamCMD archive did not contain the expected executable.');
    return { downloaded: true };
  }

  /**
   * Run SteamCMD with arguments. Returns { code, output, success, errors }.
   * Lines are streamed to onLine and the global onOutput hook.
   */
  run(args, { label = 'steamcmd', onLine, onProgress, timeoutMs = 3 * 60 * 60 * 1000, signal } = {}) {
    return this.lock.run('steamcmd', label, async () => {
      await this.ensureInstalled();
      return new Promise((resolve, reject) => {
        const child = spawn(this.exe, args, { cwd: this.dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        this.current = child;
        let output = '';
        const errors = [];
        let buf = '';
        const handle = (chunk) => {
          const text = chunk.toString('utf8');
          output += text;
          if (output.length > 4 * 1024 * 1024) output = output.slice(-2 * 1024 * 1024);
          buf += text;
          const parts = buf.split(/\r?\n|\r/);
          buf = parts.pop();
          for (const line of parts) {
            if (!line.trim()) continue;
            const pm = PROGRESS_RE.exec(line);
            if (pm && onProgress) onProgress({ state: pm[2].trim(), percent: Number(pm[3]), done: Number(pm[4]), total: Number(pm[5]) });
            const em = ERROR_RE.exec(line);
            if (em) errors.push(em[1].trim());
            if (onLine) onLine(line);
            if (this.onOutput) this.onOutput(label, line);
          }
        };
        child.stdout.on('data', handle);
        child.stderr.on('data', handle);
        const timer = setTimeout(() => { errors.push('SteamCMD timed out'); child.kill(); }, timeoutMs);
        const onAbort = () => { errors.push('Cancelled by user'); child.kill(); };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        child.on('error', (err) => { clearTimeout(timer); this.current = null; reject(err); });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onAbort);
          this.current = null;
          if (buf.trim()) handle('\n');
          resolve({ code, output, errors, success: SUCCESS_RE.test(output) });
        });
      });
    });
  }

  /** Install, update or validate the dedicated server into installDir. */
  async installApp(installDir, { branch = 'public', validate = true, onProgress, onLine, signal, label = 'install' } = {}) {
    const args = ['+force_install_dir', installDir, '+login', 'anonymous', '+app_update', String(APP_ID)];
    if (branch && branch !== 'public') args.push('-beta', branch);
    if (validate) args.push('validate');
    args.push('+quit');
    let res = await this.run(args, { label, onProgress, onLine, signal });
    // A fresh SteamCMD self-updates on first run and may exit before doing work; retry once.
    if (!res.success && !res.errors.length && /Steam Console Client|Update complete/i.test(res.output)) {
      res = await this.run(args, { label, onProgress, onLine, signal });
    }
    if (!res.success) {
      throw new AppError('E_STEAM_INSTALL', `SteamCMD did not report success (exit code ${res.code}). ${res.errors.join(' ') || 'See the SteamCMD output for details.'}`, { code: res.code, errors: res.errors });
    }
    return res;
  }

  /** Self-update SteamCMD only. */
  async selfUpdate() {
    const res = await this.run(['+quit'], { label: 'self-update' });
    return { code: res.code, updated: /Update complete|Downloading update/i.test(res.output) };
  }

  /** Query Steam for published branches and their build IDs. */
  async fetchAppInfo() {
    const res = await this.run(['+login', 'anonymous', '+app_info_update', '1', '+app_info_print', String(APP_ID), '+quit'], { label: 'app-info', timeoutMs: 5 * 60 * 1000 });
    const info = extractAppInfo(res.output, APP_ID);
    if (!info) throw new AppError('E_APPINFO', 'SteamCMD did not return app information for the dedicated server.');
    const branchesRaw = getCI(info, 'depots', 'branches') || {};
    const branches = {};
    for (const [name, b] of Object.entries(branchesRaw)) {
      branches[name] = { buildId: getCI(b, 'buildid') || null, timeUpdated: Number(getCI(b, 'timeupdated')) * 1000 || null, passwordRequired: getCI(b, 'pwdrequired') === '1', description: getCI(b, 'description') || '' };
    }
    return { branches, fetchedAt: Date.now() };
  }

  cancel() { if (this.current) this.current.kill(); }
}

/** Read installed build information from steamapps/appmanifest_1690800.acf. */
async function readAppManifest(installDir) {
  // SteamCMD (+force_install_dir) keeps the manifest inside the install folder;
  // the Steam client keeps it in the library's steamapps folder two levels up.
  const candidates = [appManifest(installDir), path.join(installDir, '..', '..', `appmanifest_${APP_ID}.acf`)];
  let text = null;
  let file = null;
  for (const c of candidates) {
    try { text = await fsp.readFile(c, 'utf8'); file = c; break; } catch { /* try next */ }
  }
  if (text === null) return null;
  const root = parseVdf(text);
  const st = getCI(root, 'AppState');
  if (!st) return null;
  const flags = Number(getCI(st, 'StateFlags') || 0);
  const branch = getCI(st, 'UserConfig', 'BetaKey') || getCI(st, 'MountedConfig', 'BetaKey') || 'public';
  return {
    appId: Number(getCI(st, 'appid')),
    buildId: getCI(st, 'buildid') || null,
    branch: branch || 'public',
    stateFlags: flags,
    fullyInstalled: (flags & 4) === 4 && (flags & ~4 & 0xFFFF) === 0,
    updateRequired: (flags & 2) === 2,
    sizeOnDisk: Number(getCI(st, 'SizeOnDisk') || 0),
    lastUpdated: Number(getCI(st, 'LastUpdated') || 0) * 1000 || null,
    installDir: getCI(st, 'installdir') || null,
    manifestPath: file,
  };
}

/** Find existing installs in Steam libraries (libraryfolders.vdf). */
async function discoverSteamInstalls(libraryRoots) {
  const found = [];
  for (const root of libraryRoots) {
    const libs = new Set([root]);
    try {
      const text = await fsp.readFile(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      const lf = getCI(parseVdf(text), 'libraryfolders') || {};
      for (const entry of Object.values(lf)) {
        const p = typeof entry === 'object' ? getCI(entry, 'path') : null;
        if (p) libs.add(p);
      }
    } catch { /* no library file */ }
    for (const lib of libs) {
      const dir = path.join(lib, 'steamapps', 'common', 'SatisfactoryDedicatedServer');
      if (fs.existsSync(dir)) found.push(dir);
    }
  }
  return [...new Set(found)];
}

module.exports = { SteamCmd, readAppManifest, discoverSteamInstalls, STEAMCMD_URL, PROGRESS_RE };
