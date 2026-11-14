'use strict';
/**
 * Authentication primitives for the web dashboard and remote management.
 *  - Passwords: scrypt (N=2^15, r=8, p=1) with per-user salt, constant-time compare.
 *  - Sessions: 256-bit random IDs; only the SHA-256 of the ID is kept in memory.
 *    Idle and absolute timeouts; each session carries its own CSRF token.
 *  - Remote device tokens: "ssmr_<deviceId>.<secret>"; only SHA-256(secret) stored.
 *  - Login/pairing attempts are rate limited per client address.
 */
const crypto = require('node:crypto');

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const safeEqual = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(pw, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(expected, actual);
}

function passwordProblems(pw) {
  const out = [];
  if (typeof pw !== 'string' || pw.length < 12) out.push('at least 12 characters');
  if (pw && pw.length > 256) out.push('at most 256 characters');
  if (pw && /^(.)\1+$/.test(pw)) out.push('not a single repeated character');
  return out;
}

class SessionStore {
  constructor({ idleMs = 30 * 60000, absoluteMs = 12 * 3600000 } = {}) { this.idleMs = idleMs; this.absoluteMs = absoluteMs; this.sessions = new Map(); }
  create(user, ip) {
    const id = crypto.randomBytes(32).toString('base64url');
    const csrf = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.sessions.set(sha256(id), { userId: user.id, username: user.username, role: user.role, csrf, created: now, lastSeen: now, ip });
    this._gc();
    return { id, csrf };
  }
  get(id) {
    if (!id || typeof id !== 'string' || id.length > 100) return null;
    const key = sha256(id);
    const s = this.sessions.get(key);
    if (!s) return null;
    const now = Date.now();
    if (now - s.lastSeen > this.idleMs || now - s.created > this.absoluteMs) { this.sessions.delete(key); return null; }
    s.lastSeen = now;
    return s;
  }
  destroy(id) { if (id) this.sessions.delete(sha256(id)); }
  destroyUser(userId) { for (const [k, s] of this.sessions) if (s.userId === userId) this.sessions.delete(k); }
  list() { return [...this.sessions.values()].map(({ csrf, ...rest }) => rest); }
  _gc() { const now = Date.now(); for (const [k, s] of this.sessions) if (now - s.lastSeen > this.idleMs || now - s.created > this.absoluteMs) this.sessions.delete(k); }
}

class RateLimiter {
  constructor({ max = 5, windowMs = 15 * 60000 } = {}) { this.max = max; this.windowMs = windowMs; this.hits = new Map(); }
  blocked(key) { const h = (this.hits.get(key) || []).filter((t) => Date.now() - t < this.windowMs); this.hits.set(key, h); return h.length >= this.max; }
  fail(key) { const h = this.hits.get(key) || []; h.push(Date.now()); this.hits.set(key, h); }
  reset(key) { this.hits.delete(key); }
}

function newDeviceToken(deviceId) {
  const secret = crypto.randomBytes(32).toString('base64url');
  return { token: `ssmr_${deviceId}.${secret}`, hash: sha256(secret) };
}
function parseDeviceToken(token) {
  const m = /^ssmr_([A-Za-z0-9_-]{4,64})\.([A-Za-z0-9_-]{40,64})$/.exec(String(token || ''));
  return m ? { deviceId: m[1], secretHash: sha256(m[2]) } : null;
}

const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function pairingCode() { let s = ''; const b = crypto.randomBytes(10); for (const x of b) s += PAIR_ALPHABET[x % 32]; return `${s.slice(0, 5)}-${s.slice(5)}`; }

/** RFC1918 / loopback / link-local / ULA check for "local network only" exposure. */
function isPrivateAddress(addr) {
  let a = String(addr || '');
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (a === '::1' || a.startsWith('127.')) return true;
  if (/^10\./.test(a) || /^192\.168\./.test(a) || /^169\.254\./.test(a)) return true;
  const m = /^172\.(\d+)\./.exec(a); if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(a) || /^fe[89ab][0-9a-f]:/i.test(a)) return true;
  return false;
}
const isLoopback = (addr) => { const a = String(addr || '').replace(/^::ffff:/, ''); return a === '::1' || a.startsWith('127.'); };

module.exports = { hashPassword, verifyPassword, passwordProblems, SessionStore, RateLimiter, newDeviceToken, parseDeviceToken, pairingCode, isPrivateAddress, isLoopback, sha256, safeEqual };
