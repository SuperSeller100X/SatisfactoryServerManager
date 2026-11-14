'use strict';
// Test helpers: build the real main-process services against a temporary data
// folder, without Electron. Only OS integrations that need Electron (safeStorage,
// native notifications) are replaced with in-memory test doubles.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Database } = require('../../src/main/core/db');
const { Bus } = require('../../src/main/core/events');
const { Settings } = require('../../src/main/core/settings');
const { Secrets } = require('../../src/main/core/secrets');
const { Audit } = require('../../src/main/core/audit');
const { Notifications } = require('../../src/main/core/notifications');
const { KeyedLock } = require('../../src/main/core/util');
const { ServerRegistry } = require('../../src/main/server/registry');

function tmpDir(prefix = 'ssm-test-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

/** Reversible test double for Electron safeStorage (NOT encryption; tests only). */
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`),
  decryptString: (b) => Buffer.from(String(b).slice(4), 'base64').toString(),
};

function makeCtx({ root = tmpDir() } = {}) {
  const paths = {
    userData: path.join(root, 'data'), local: path.join(root, 'local'), steamcmd: path.join(root, 'local', 'steamcmd'),
    backups: path.join(root, 'local', 'backups'), runs: path.join(root, 'local', 'runs'), diagnostics: path.join(root, 'local', 'diag'),
    modSnapshots: path.join(root, 'local', 'snap'), rollback: path.join(root, 'local', 'rollback'), temp: path.join(root, 'local', 'temp'),
    renderer: path.resolve(__dirname, '../../src/renderer'), appInstallDir: path.join(root, 'app'),
  };
  for (const p of Object.values(paths)) fs.mkdirSync(p, { recursive: true });
  const db = new Database(path.join(paths.userData, 'manager.db'));
  const bus = new Bus();
  const settings = new Settings(db, bus);
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  const ctx = { root, paths, db, bus, settings, log, logger: { tail: () => [], scope: () => log }, locks: new KeyedLock() };
  ctx.secrets = new Secrets(db, fakeSafeStorage, settings);
  ctx.audit = new Audit(db);
  ctx.notifications = new Notifications({ db, bus, settings, NativeNotification: null, log });
  ctx.registry = new ServerRegistry(ctx);
  return ctx;
}

module.exports = { makeCtx, tmpDir, fakeSafeStorage };
