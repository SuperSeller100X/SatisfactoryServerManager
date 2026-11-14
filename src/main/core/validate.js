'use strict';
/**
 * Minimal, dependency-free schema validation used for every IPC / RPC payload.
 * Each validator is a function (value, path) => sanitizedValue that throws a
 * ValidationError on invalid input. Unknown object keys are rejected so that
 * renderer or remote callers cannot smuggle unexpected options into handlers.
 */

class ValidationError extends Error {
  constructor(message, path) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'ValidationError';
    this.code = 'E_VALIDATION';
  }
}

const fail = (msg, path) => { throw new ValidationError(msg, path); };

const v = {
  any: () => (x) => x,

  string: ({ min = 0, max = 4096, pattern, trim = false, oneOf } = {}) => (x, p) => {
    if (typeof x !== 'string') fail('expected string', p);
    const s = trim ? x.trim() : x;
    if (s.length < min) fail(`must be at least ${min} characters`, p);
    if (s.length > max) fail(`must be at most ${max} characters`, p);
    if (pattern && !pattern.test(s)) fail('has an invalid format', p);
    if (oneOf && !oneOf.includes(s)) fail(`must be one of ${oneOf.join(', ')}`, p);
    if (s.includes('\u0000')) fail('must not contain NUL characters', p);
    return s;
  },

  enum: (values) => (x, p) => {
    if (!values.includes(x)) fail(`must be one of ${values.join(', ')}`, p);
    return x;
  },

  int: ({ min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) => (x, p) => {
    if (typeof x !== 'number' || !Number.isInteger(x)) fail('expected integer', p);
    if (x < min || x > max) fail(`must be between ${min} and ${max}`, p);
    return x;
  },

  number: ({ min = -Infinity, max = Infinity } = {}) => (x, p) => {
    if (typeof x !== 'number' || !Number.isFinite(x)) fail('expected number', p);
    if (x < min || x > max) fail(`must be between ${min} and ${max}`, p);
    return x;
  },

  bool: () => (x, p) => {
    if (typeof x !== 'boolean') fail('expected boolean', p);
    return x;
  },

  /** Identifier used for database rows: short, URL-safe. */
  id: () => v.string({ min: 1, max: 64, pattern: /^[A-Za-z0-9_-]+$/ }),

  /** Absolute filesystem path. Containment checks are done by fsutil at use time. */
  absPath: () => (x, p) => {
    const s = v.string({ min: 1, max: 1024 })(x, p);
    const path = require('node:path');
    if (!path.isAbsolute(s)) fail('must be an absolute path', p);
    return path.normalize(s);
  },

  array: (item, { min = 0, max = 10000 } = {}) => (x, p) => {
    if (!Array.isArray(x)) fail('expected array', p);
    if (x.length < min || x.length > max) fail(`must contain between ${min} and ${max} items`, p);
    return x.map((el, i) => item(el, `${p || ''}[${i}]`));
  },

  object: (shape, { allowUnknown = false } = {}) => (x, p) => {
    if (x === null || typeof x !== 'object' || Array.isArray(x)) fail('expected object', p);
    const out = {};
    for (const key of Object.keys(x)) {
      if (!Object.prototype.hasOwnProperty.call(shape, key)) {
        if (allowUnknown) { out[key] = x[key]; continue; }
        fail(`unexpected property "${key}"`, p);
      }
    }
    for (const [key, validator] of Object.entries(shape)) {
      const val = x[key];
      const childPath = p ? `${p}.${key}` : key;
      if (val === undefined) {
        if (validator.optionalMarker) continue;
        fail('is required', childPath);
      }
      const res = (validator.optionalMarker ? validator.inner : validator)(val, childPath);
      if (res !== undefined) out[key] = res;
    }
    return out;
  },

  /** Record of string keys to validated values. */
  record: (valueValidator, { maxKeys = 500, keyPattern = /^[A-Za-z0-9_.:\-/ ]{1,128}$/ } = {}) => (x, p) => {
    if (x === null || typeof x !== 'object' || Array.isArray(x)) fail('expected object', p);
    const keys = Object.keys(x);
    if (keys.length > maxKeys) fail(`too many keys (max ${maxKeys})`, p);
    const out = {};
    for (const k of keys) {
      if (!keyPattern.test(k) || k === '__proto__' || k === 'constructor' || k === 'prototype') fail(`invalid key "${k}"`, p);
      out[k] = valueValidator(x[k], `${p || ''}.${k}`);
    }
    return out;
  },

  optional: (inner) => {
    const fn = (x, p) => (x === undefined ? undefined : inner(x, p));
    fn.optionalMarker = true;
    fn.inner = inner;
    return fn;
  },

  nullable: (inner) => (x, p) => (x === null ? null : inner(x, p)),

  oneOf: (...validators) => (x, p) => {
    const errors = [];
    for (const val of validators) {
      try { return val(x, p); } catch (e) { errors.push(e.message); }
    }
    fail(`did not match any allowed shape (${errors.join('; ')})`, p);
  },

  /** Plain JSON value with bounded depth/size: used for opaque config blobs. */
  json: ({ maxDepth = 8, maxBytes = 512 * 1024 } = {}) => (x, p) => {
    const walk = (val, depth) => {
      if (depth > maxDepth) fail('is nested too deeply', p);
      if (val === null || ['string', 'number', 'boolean'].includes(typeof val)) {
        if (typeof val === 'number' && !Number.isFinite(val)) fail('contains a non-finite number', p);
        return;
      }
      if (Array.isArray(val)) { val.forEach((el) => walk(el, depth + 1)); return; }
      if (typeof val === 'object') {
        for (const k of Object.keys(val)) {
          if (k === '__proto__' || k === 'constructor' || k === 'prototype') fail('contains a forbidden key', p);
          walk(val[k], depth + 1);
        }
        return;
      }
      fail('contains a non-JSON value', p);
    };
    walk(x, 0);
    if (Buffer.byteLength(JSON.stringify(x)) > maxBytes) fail('is too large', p);
    return JSON.parse(JSON.stringify(x));
  },
};

/** Common building blocks. */
v.port = () => v.int({ min: 1024, max: 65535 });
v.hostname = () => v.string({ min: 1, max: 253, pattern: /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$|^\d{1,3}(?:\.\d{1,3}){3}$|^\[?[0-9a-fA-F:]+\]?$/ });
v.serverId = () => v.id();
v.timezone = () => (x, p) => {
  const s = v.string({ min: 1, max: 64 })(x, p);
  try { new Intl.DateTimeFormat('en-US', { timeZone: s }); } catch { fail('is not a valid IANA time zone', p); }
  return s;
};

module.exports = { v, ValidationError };
