'use strict';
/**
 * Knowledge about the on-disk layout of a Satisfactory Dedicated Server
 * (Steam App ID 1690800). Centralised so every feature agrees on paths.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const APP_ID = 1690800;
const IS_WIN = process.platform === 'win32';
const PLATFORM_DIR = IS_WIN ? 'WindowsServer' : 'LinuxServer';
const MOD_TARGET = IS_WIN ? 'WindowsServer' : 'LinuxServer';

function serverExecutable(installDir) {
  return IS_WIN
    ? path.join(installDir, 'Engine', 'Binaries', 'Win64', 'FactoryServer-Win64-Shipping-Cmd.exe')
    : path.join(installDir, 'Engine', 'Binaries', 'Linux', 'FactoryServer-Linux-Shipping');
}
const launcherScript = (installDir) => path.join(installDir, IS_WIN ? 'FactoryServer.exe' : 'FactoryServer.sh');
const appManifest = (installDir) => path.join(installDir, 'steamapps', `appmanifest_${APP_ID}.acf`);
const configDir = (installDir) => path.join(installDir, 'FactoryGame', 'Saved', 'Config', PLATFORM_DIR);
const logFile = (installDir) => path.join(installDir, 'FactoryGame', 'Saved', 'Logs', 'FactoryGame.log');
const logsDir = (installDir) => path.join(installDir, 'FactoryGame', 'Saved', 'Logs');
const crashesDir = (installDir) => path.join(installDir, 'FactoryGame', 'Saved', 'Crashes');
const modsDir = (installDir) => path.join(installDir, 'FactoryGame', 'Mods');
const steamTempDirs = (installDir) => [path.join(installDir, 'steamapps', 'downloading'), path.join(installDir, 'steamapps', 'temp'), path.join(installDir, 'steamapps', 'shadercache')];

/**
 * Default save directory used by the dedicated server for the current Windows
 * user. All dedicated servers running as the same user share this folder; the
 * manager warns about that in diagnostics.
 */
function defaultSaveRoot() {
  if (IS_WIN) return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'FactoryGame', 'Saved', 'SaveGames');
  return path.join(os.homedir(), '.config', 'Epic', 'FactoryGame', 'Saved', 'SaveGames');
}
const sessionSaveDir = (saveRoot) => path.join(saveRoot, 'server');

/** Candidate Steam library folders where an existing installation may live. */
function steamLibraryCandidates() {
  const out = new Set();
  if (IS_WIN) {
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    out.add(path.join(pf86, 'Steam'));
    out.add(path.join(pf, 'Steam'));
  } else {
    out.add(path.join(os.homedir(), '.steam', 'steam'));
    out.add(path.join(os.homedir(), '.local', 'share', 'Steam'));
  }
  return [...out].filter((p) => fs.existsSync(p));
}

module.exports = {
  APP_ID, IS_WIN, PLATFORM_DIR, MOD_TARGET,
  serverExecutable, launcherScript, appManifest, configDir, logFile, logsDir, crashesDir, modsDir, steamTempDirs,
  defaultSaveRoot, sessionSaveDir, steamLibraryCandidates,
};
