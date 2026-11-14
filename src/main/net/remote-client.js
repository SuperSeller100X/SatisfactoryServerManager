'use strict';
/**
 * Controller side of remote management: pairs with another manager, pins its
 * certificate fingerprint and stores the device token encrypted (Secrets).
 * Every call goes over TLS to a pinned certificate; nothing is sent until
 * the fingerprint matched.
 */
const https = require('node:https');
const { connectAndInspect } = require('../server/api-client');
const { AppError, newId } = require('../core/util');

class RemoteClient {
  constructor(ctx) { this.ctx = ctx; this.health = new Map(); }

  list() {
    return this.ctx.db.all('SELECT id, name, host, port, fingerprint, device_id, created_at, last_seen, last_error FROM remote_machines ORDER BY name').map((m) => ({ ...m, health: this.health.get(m.id) || null }));
  }

  /** Step 1: read the remote certificate fingerprint so the user can compare it with the one shown on the other PC. */
  async probe(host, port) {
    const { socket, fingerprint } = await connectAndInspect(host, port, 8000);
    socket.destroy();
    return { fingerprint };
  }

  _request(host, port, fingerprint, method, urlPath, body, token) {
    return new Promise((resolve, reject) => {
      connectAndInspect(host, port, 10000).then(({ socket, fingerprint: fp }) => {
        if (fp !== fingerprint) { socket.destroy(); return reject(new AppError('E_REMOTE_CERT', 'The remote computer presented a different certificate than the one you trusted. The connection was refused.')); }
        const data = body ? JSON.stringify(body) : '';
        const started = Date.now();
        const req = https.request({ host, port, method, path: urlPath, agent: false, createConnection: () => socket, timeout: 30000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (c) => { size += c.length; if (size > 16 * 1024 * 1024) req.destroy(new Error('Response too large')); chunks.push(c); });
          res.on('end', () => {
            let json = null;
            try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* non-json */ }
            if (res.statusCode >= 400) return reject(new AppError(json && json.code ? json.code : 'E_REMOTE_HTTP', json && json.error ? json.error : `Remote returned HTTP ${res.statusCode}`, { status: res.statusCode }));
            resolve({ data: json, latency: Date.now() - started });
          });
        });
        req.on('timeout', () => req.destroy(new AppError('E_REMOTE_TIMEOUT', 'The remote computer did not answer in time.')));
        req.on('error', (e) => reject(e instanceof AppError ? e : new AppError('E_REMOTE', e.message)));
        req.end(data);
      }).catch(reject);
    });
  }

  /** Step 2: pair using the one-time code shown on the remote computer. */
  async pair({ host, port, fingerprint, code, name }, actor = 'local') {
    const res = await this._request(host, port, fingerprint, 'POST', '/remote/v1/pair', { code, deviceName: require('node:os').hostname().slice(0, 60) });
    const { deviceId, token, machineName } = res.data || {};
    if (!deviceId || !token) throw new AppError('E_REMOTE_PAIR', 'The remote computer did not return credentials.');
    const id = newId('rm_');
    this.ctx.secrets.set(`remote:${id}:token`, token);
    this.ctx.db.run('INSERT INTO remote_machines (id, name, host, port, fingerprint, device_id, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, name || machineName || host, host, port, fingerprint, deviceId, Date.now(), Date.now());
    this.ctx.audit.record({ actor, action: 'remote.machine.add', target: name || host, details: { host, port, fingerprint } });
    this.ctx.bus.publish('remote.changed', {});
    return this.list().find((m) => m.id === id);
  }

  _machine(id) { const m = this.ctx.db.get('SELECT * FROM remote_machines WHERE id = ?', id); if (!m) throw new AppError('E_NOT_FOUND', 'Remote machine not found'); return m; }

  async call(id, channel, payload = {}, actor = 'local') {
    const m = this._machine(id);
    const token = this.ctx.secrets.get(`remote:${id}:token`);
    if (!token) throw new AppError('E_REMOTE_TOKEN', 'No credentials stored for this machine. Pair it again.');
    try {
      const res = await this._request(m.host, m.port, m.fingerprint, 'POST', '/remote/v1/rpc', { channel, payload }, token);
      this.ctx.db.run('UPDATE remote_machines SET last_seen = ?, last_error = NULL WHERE id = ?', Date.now(), id);
      if (!/\.(list|get|status|history|recent|snapshot|indicators|ping)$|^(dashboard|diagnostics\.run)/.test(channel)) this.ctx.audit.record({ actor, action: 'remote.action', target: `${m.name}: ${channel}`, details: { machine: m.name, channel } });
      return res.data.result;
    } catch (err) {
      this.ctx.db.run('UPDATE remote_machines SET last_error = ? WHERE id = ?', err.message, id);
      throw err;
    }
  }

  async ping(id) {
    const m = this._machine(id);
    const token = this.ctx.secrets.get(`remote:${id}:token`);
    try {
      const r = await this._request(m.host, m.port, m.fingerprint, 'GET', '/remote/v1/ping', null, token);
      const h = { ok: true, latency: r.latency, version: r.data.version, name: r.data.name, at: Date.now() };
      this.health.set(id, h);
      this.ctx.db.run('UPDATE remote_machines SET last_seen = ?, last_error = NULL WHERE id = ?', Date.now(), id);
      return h;
    } catch (err) {
      const h = { ok: false, error: err.message, at: Date.now() };
      this.health.set(id, h);
      this.ctx.db.run('UPDATE remote_machines SET last_error = ? WHERE id = ?', err.message, id);
      return h;
    }
  }

  async remove(id, actor = 'local') {
    const m = this._machine(id);
    try { await this.call(id, 'remote.revokeSelf', {}, actor); } catch { /* remote may be offline; local credentials are removed regardless */ }
    this.ctx.secrets.delete(`remote:${id}:token`);
    this.ctx.db.run('DELETE FROM remote_machines WHERE id = ?', id);
    this.ctx.audit.record({ actor, action: 'remote.machine.remove', target: m.name });
    this.ctx.bus.publish('remote.changed', {});
  }
}

module.exports = { RemoteClient };
