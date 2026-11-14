'use strict';
const crypto = require('node:crypto');

/** Random URL-safe identifier. */
const newId = (prefix = '') => prefix + crypto.randomBytes(9).toString('base64url');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SECRET_KEY_RE = /pass(word)?|token|secret|credential|authorization|cookie|api[_-]?key|private/i;

/**
 * Deep copy with secret-looking keys replaced. Used for audit details, logs,
 * exports and anything sent to remote clients.
 */
function redact(value, depth = 0) {
  if (depth > 10) return '[depth]';
  if (Array.isArray(value)) return value.map((x) => redact(x, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) ? (val ? '[redacted]' : val) : redact(val, depth + 1);
    }
    return out;
  }
  return value;
}

/** Mask bearer-like tokens inside free text (console output, error messages). */
function redactText(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[redacted]')
    .replace(/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}/g, '[redacted-token]')
    .replace(/(API Token:?\s*)\S+/gi, '$1[redacted]')
    .replace(/(-?(?:password|pass)=)\S+/gi, '$1[redacted]');
}

function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return 'unknown';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let x = n;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(i ? 1 : 0)} ${u[i]}`;
}

/** Simple async mutex keyed by name; serializes operations on a server. */
class KeyedLock {
  constructor() { this.tails = new Map(); this.holders = new Map(); }
  isLocked(key) { return this.holders.has(key); }
  holder(key) { return this.holders.get(key); }
  async run(key, label, fn) {
    const prev = this.tails.get(key) || Promise.resolve();
    let release;
    const next = new Promise((r) => { release = r; });
    const tail = prev.then(() => next);
    this.tails.set(key, tail);
    await prev;
    this.holders.set(key, label);
    try {
      return await fn();
    } finally {
      this.holders.delete(key);
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

class AppError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

module.exports = { newId, sleep, redact, redactText, formatBytes, KeyedLock, AppError };
