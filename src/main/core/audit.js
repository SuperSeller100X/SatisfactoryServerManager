'use strict';
const { redact, redactText } = require('./util');

/**
 * Append-only activity timeline of mutating operations. Details are redacted
 * so that secret values are never persisted.
 */
class Audit {
  constructor(db) { this.db = db; }
  record({ actor = 'local', action, serverId = null, target = null, result = 'ok', details = null, error = null }) {
    const info = this.db.run(
      'INSERT INTO audit (ts, actor, action, server_id, target, result, details, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      Date.now(), actor, action, serverId, target, result,
      details ? JSON.stringify(redact(details)) : null,
      error ? redactText(String(error.message || error)).slice(0, 2000) : null,
    );
    return Number(info.lastInsertRowid);
  }
  /** Run an operation and record its result automatically. */
  async wrap(entry, fn) {
    try {
      const res = await fn();
      this.record({ ...entry, result: 'ok' });
      return res;
    } catch (err) {
      this.record({ ...entry, result: 'failed', error: err });
      throw err;
    }
  }
  list({ limit = 200, before, serverId, action, result, search } = {}) {
    const where = []; const args = [];
    if (before) { where.push('id < ?'); args.push(before); }
    if (serverId) { where.push('server_id = ?'); args.push(serverId); }
    if (action) { where.push('action LIKE ?'); args.push(`${action}%`); }
    if (result) { where.push('result = ?'); args.push(result); }
    if (search) { where.push('(action LIKE ? OR target LIKE ? OR details LIKE ? OR error LIKE ?)'); const s = `%${search}%`; args.push(s, s, s, s); }
    const sql = `SELECT * FROM audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    return this.db.all(sql, ...args, limit).map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
  }
}

module.exports = { Audit };
