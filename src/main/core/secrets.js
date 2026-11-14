'use strict';
/**
 * Secret storage backed by Electron safeStorage (DPAPI on Windows). Values are
 * never written in plaintext: if OS-level encryption is unavailable the store
 * refuses to save unless the user explicitly opts in to weak storage (Linux
 * without a keyring), and even then the UI shows a warning.
 */
const { AppError } = require('./util');

class Secrets {
  constructor(db, safeStorage, settings) {
    this.db = db;
    this.safeStorage = safeStorage;
    this.settings = settings;
  }
  status() {
    const available = !!(this.safeStorage && this.safeStorage.isEncryptionAvailable());
    let backend = process.platform === 'win32' ? 'dpapi' : process.platform === 'darwin' ? 'keychain' : 'unknown';
    if (available && process.platform === 'linux' && this.safeStorage.getSelectedStorageBackend) backend = this.safeStorage.getSelectedStorageBackend();
    const weak = !available || backend === 'basic_text';
    return { available, backend, weak, allowed: !weak || this.settings.get('security').allowWeakSecretStorage };
  }
  set(key, value) {
    const st = this.status();
    if (!st.available) throw new AppError('E_NO_SECURE_STORAGE', 'Secure credential storage is not available on this system.');
    if (st.weak && !st.allowed) throw new AppError('E_WEAK_SECURE_STORAGE', 'Only weak credential storage is available. Enable it explicitly under Settings → Security to continue.');
    const enc = this.safeStorage.encryptString(String(value));
    this.db.run('INSERT INTO secrets (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', key, enc, Date.now());
  }
  get(key) {
    const row = this.db.get('SELECT value FROM secrets WHERE key = ?', key);
    if (!row) return null;
    try { return this.safeStorage.decryptString(Buffer.from(row.value)); } catch { return null; }
  }
  has(key) { return !!this.db.get('SELECT 1 AS x FROM secrets WHERE key = ?', key); }
  delete(key) { this.db.run('DELETE FROM secrets WHERE key = ?', key); }
  deletePrefix(prefix) { this.db.run('DELETE FROM secrets WHERE key LIKE ?', `${prefix}%`); }
}

module.exports = { Secrets };
