'use strict';
/**
 * Environment inspection used by the setup wizard and diagnostics:
 * OS details, hardware, Microsoft Visual C++ runtime presence (required by
 * Unreal Engine 5 servers), disk space and existing installations.
 */
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { diskSpace, exists } = require('../core/fsutil');
const layout = require('../server/layout');
const { readAppManifest, discoverSteamInstalls, hasPendingDownload } = require('../steam/steamcmd');

const VCREDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';
const VCREDIST_HOSTS = ['aka.ms', 'download.visualstudio.microsoft.com'];
const MIN_FREE_BYTES = 15 * 1024 ** 3; // server ~9 GB + updates + saves/backups headroom
const MIN_WINDOWS_BUILD = 17763; // Windows 10 1809 / Server 2019

const run = (file, args, timeout = 15000) => new Promise((resolve) => {
  execFile(file, args, { windowsHide: true, timeout }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
});

/** Query a registry value via reg.exe; returns string or null. */
async function regQuery(key, value) {
  if (process.platform !== 'win32') return null;
  const r = await run('reg.exe', ['query', key, '/v', value]);
  if (r.code !== 0) return null;
  const m = new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`, 'i').exec(r.stdout);
  return m ? m[1].trim() : null;
}

async function vcRuntime() {
  if (process.platform !== 'win32') return { applicable: false, installed: null, version: null };
  const key = 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64';
  const installed = await regQuery(key, 'Installed');
  const version = await regQuery(key, 'Version');
  return { applicable: true, installed: installed === '0x1', version };
}

function windowsInfo() {
  const release = os.release();
  const build = Number(release.split('.')[2]) || null;
  return {
    platform: process.platform, arch: process.arch, release, build,
    version: typeof os.version === 'function' ? os.version() : release,
    supported: process.platform === 'win32' ? process.arch === 'x64' && build >= MIN_WINDOWS_BUILD : process.platform === 'linux' && process.arch === 'x64',
    hostname: os.hostname(),
  };
}

function hardware() {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  return {
    cpuModel: cpus[0] ? cpus[0].model.trim() : 'unknown', cores: cpus.length, totalMem, freeMem: os.freemem(),
    // Coffee Stain recommends 12–16 GB RAM for a dedicated server; 8 GB is the practical minimum.
    memOk: totalMem >= 8 * 1024 ** 3, memRecommended: totalMem >= 12 * 1024 ** 3,
  };
}

/** Local IPv4 addresses for connection instructions. */
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
  }
  return out;
}

/** Look for existing dedicated server installations that are not yet managed. */
async function findExistingInstalls(registry, extraDirs = []) {
  const managed = new Set(registry.list().map((s) => path.resolve(s.installDir).toLowerCase()));
  const candidates = new Set([...(await discoverSteamInstalls(layout.steamLibraryCandidates())), ...extraDirs]);
  const out = [];
  for (const dir of candidates) {
    if (managed.has(path.resolve(dir).toLowerCase())) continue;
    const exe = await exists(layout.serverExecutable(dir));
    const manifest = await readAppManifest(dir).catch(() => null);
    if (exe || manifest) out.push({ dir, exe, buildId: manifest ? manifest.buildId : null, branch: manifest ? manifest.branch : null, fullyInstalled: manifest ? manifest.fullyInstalled : false });
  }
  return out;
}

/** Inspect a folder chosen as installation target. */
async function inspectInstallDir(dir) {
  const res = { dir, exists: false, empty: true, hasServer: false, manifest: null, partial: false, writable: false, free: null, entries: 0 };
  try {
    const entries = await fsp.readdir(dir);
    res.exists = true; res.entries = entries.length; res.empty = entries.length === 0 || (entries.length === 1 && entries[0] === '.ssm-install');
  } catch { /* does not exist */ }
  res.hasServer = await exists(layout.serverExecutable(dir));
  res.manifest = await readAppManifest(dir).catch(() => null);
  res.partial = !!(res.manifest && !res.manifest.fullyInstalled) || (await hasPendingDownload(dir)) || (!!res.manifest && !res.hasServer);
  try {
    let probe = dir;
    while (!(await exists(probe))) probe = path.dirname(probe);
    const f = path.join(probe, `.ssm-write-test-${process.pid}`);
    await fsp.writeFile(f, 'x');
    await fsp.rm(f, { force: true });
    res.writable = true;
  } catch { res.writable = false; }
  try { res.free = (await diskSpace(dir)).free; } catch { /* unknown */ }
  return res;
}

module.exports = { windowsInfo, hardware, vcRuntime, lanAddresses, findExistingInstalls, inspectInstallDir, regQuery, run, VCREDIST_URL, VCREDIST_HOSTS, MIN_FREE_BYTES, MIN_WINDOWS_BUILD };
