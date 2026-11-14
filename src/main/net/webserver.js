'use strict';
/**
 * Optional HTTPS server hosted by the manager. Disabled by default.
 *
 *  /                 browser dashboard (same UI code as the desktop app)
 *  /api/*            dashboard API: cookie session + per-session CSRF token
 *  /remote/v1/*      manager-to-manager API: bearer device token (paired)
 *
 * Exposure: bound to 127.0.0.1 unless the user selects "local network", in
 * which case it listens on all interfaces but rejects any client whose address
 * is not loopback/private (RFC1918, link-local, ULA). Public exposure is not
 * offered. All requests are authorised per RPC channel by role/scope.
 */
const https = require('node:https');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { generateCertificate } = require('./certs');
const auth = require('./auth');
const sys = require('../features/system');
const { AppError, newId } = require('../core/util');
const { FORWARDED_TOPICS } = require('../core/events');
const { isInside } = require('../core/fsutil');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json' };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https://storage.ficsit.app; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const COOKIE = '__Host-ssm_session';

class WebServer {
  constructor(ctx) {
    this.ctx = ctx;
    this.server = null;
    this.sessions = new auth.SessionStore();
    this.loginLimiter = new auth.RateLimiter({ max: 5, windowMs: 15 * 60000 });
    this.pairLimiter = new auth.RateLimiter({ max: 5, windowMs: 15 * 60000 });
    this.pairing = null; // { code, expires, attempts }
    this.sse = new Set();
    this.info = { running: false };
    ctx.bus.on('event', (e) => {
      if (!FORWARDED_TOPICS.has(e.topic)) return;
      const data = `event: ${e.topic}\ndata: ${JSON.stringify(e.payload)}\n\n`;
      for (const c of this.sse) {
        if (e.topic === 'settings.changed' && c.role !== 'admin') continue;
        c.res.write(data);
      }
    });
  }

  // ------------------------------------------------------------ lifecycle
  async _tls() {
    const hosts = ['localhost', '127.0.0.1', '::1', ...sys.lanAddresses().map((a) => a.address)];
    let stored = null;
    try { stored = JSON.parse(this.ctx.secrets.get('web:tls') || 'null'); } catch { stored = null; }
    const expired = stored && new Date(stored.validTo).getTime() < Date.now() + 14 * 86400000;
    const missingHost = stored && hosts.some((h) => !stored.hosts.includes(h));
    if (!stored || expired || missingHost) {
      stored = generateCertificate({ hosts });
      this.ctx.secrets.set('web:tls', JSON.stringify(stored));
      this.ctx.audit.record({ actor: 'system', action: 'web.certificate.generate', details: { fingerprint: stored.fingerprint, hosts } });
    }
    return stored;
  }

  async apply() {
    const web = this.ctx.settings.get('web');
    const remote = this.ctx.settings.get('remote');
    const want = web.enabled || remote.enabled;
    if (this.server) await this.stop();
    if (!want) { this.info = { running: false }; return this.info; }
    this.sessions.idleMs = web.sessionIdleMinutes * 60000;
    const tls = await this._tls();
    const host = web.bind === 'lan' ? '0.0.0.0' : '127.0.0.1';
    this.server = https.createServer({ cert: tls.certPem, key: tls.keyPem, minVersion: 'TLSv1.2' }, (req, res) => this._handle(req, res).catch((err) => this._error(res, err)));
    this.server.headersTimeout = 15000;
    this.server.requestTimeout = 60000;
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(web.port, host, resolve); });
    this.server.on('error', (e) => this.ctx.log.error('Web server error', e));
    this.info = { running: true, host, port: web.port, bind: web.bind, fingerprint: tls.fingerprint, urls: host === '127.0.0.1' ? [`https://localhost:${web.port}/`] : [`https://localhost:${web.port}/`, ...sys.lanAddresses().map((a) => `https://${a.address}:${web.port}/`)], webEnabled: web.enabled, remoteEnabled: remote.enabled };
    this.ctx.log.info(`Web server listening on ${host}:${web.port}`);
    return this.info;
  }

  async stop() {
    for (const c of this.sse) c.res.end();
    this.sse.clear();
    if (this.server) await new Promise((r) => { this.server.close(() => r()); setTimeout(r, 2000); });
    if (this.server && this.server.closeAllConnections) this.server.closeAllConnections();
    this.server = null;
    this.info = { running: false };
  }

  // ------------------------------------------------------------ helpers
  _headers(res, extra = {}) {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  }
  _json(res, status, body, extra = {}) {
    this._headers(res, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.writeHead(status);
    res.end(JSON.stringify(body));
  }
  _error(res, err) {
    if (res.headersSent) { res.end(); return; }
    const status = err.status || (err.code === 'E_VALIDATION' ? 400 : err.code === 'E_FORBIDDEN' ? 403 : err.code === 'E_AUTH' ? 401 : err.code === 'E_NOT_FOUND' ? 404 : err.code === 'E_RATE' ? 429 : 500);
    if (status === 500) this.ctx.log.warn('Web request failed', err);
    this._json(res, status, { error: status === 500 && !err.code ? 'Internal error' : err.message, code: err.code || 'E_INTERNAL' });
  }
  async _body(req, max = 1024 * 1024) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw Object.assign(new AppError('E_VALIDATION', 'Content-Type must be application/json'), { status: 415 });
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > max) throw Object.assign(new AppError('E_VALIDATION', 'Request too large'), { status: 413 }); chunks.push(c); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new AppError('E_VALIDATION', 'Invalid JSON'); }
  }
  _cookie(req) {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || '');
    return m ? m[1] : null;
  }
  _sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return req.headers['sec-fetch-site'] ? req.headers['sec-fetch-site'] === 'same-origin' : true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }
  _ip(req) { return req.socket.remoteAddress || ''; }

  // ------------------------------------------------------------ routing
  async _handle(req, res) {
    const ip = this._ip(req);
    if (!auth.isPrivateAddress(ip)) { this.ctx.log.warn(`Rejected request from non-local address ${ip}`); return this._json(res, 403, { error: 'Access is limited to the local network.', code: 'E_FORBIDDEN' }); }
    const url = new URL(req.url, 'https://local');
    const web = this.ctx.settings.get('web');
    const remote = this.ctx.settings.get('remote');
    if (url.pathname.startsWith('/remote/')) {
      if (!remote.enabled) return this._json(res, 404, { error: 'Remote management is disabled', code: 'E_NOT_FOUND' });
      return this._remote(req, res, url);
    }
    if (!web.enabled) return this._json(res, 404, { error: 'Web dashboard is disabled', code: 'E_NOT_FOUND' });
    if (url.pathname.startsWith('/api/')) return this._api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return this._json(res, 405, { error: 'Method not allowed' });
    return this._static(res, url.pathname);
  }

  async _static(res, pathname) {
    const root = this.ctx.paths.renderer;
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = path.resolve(root, rel);
    if (!isInside(root, file) || !MIME[path.extname(file)]) return this._json(res, 404, { error: 'Not found' });
    let data;
    try { data = await fsp.readFile(file); } catch { return this._json(res, 404, { error: 'Not found' }); }
    this._headers(res, { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'no-cache' });
    res.writeHead(200);
    res.end(data);
  }

  async _api(req, res, url) {
    const ip = this._ip(req);
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /api/session') {
      const s = this.sessions.get(this._cookie(req));
      const hasUsers = this.ctx.db.get('SELECT COUNT(*) AS c FROM web_users').c > 0;
      return this._json(res, 200, s ? { authenticated: true, user: s.username, role: s.role, csrf: s.csrf } : { authenticated: false, configured: hasUsers });
    }
    if (route === 'POST /api/login') {
      if (!this._sameOrigin(req)) throw new AppError('E_FORBIDDEN', 'Cross-origin request refused');
      if (this.loginLimiter.blocked(ip)) throw new AppError('E_RATE', 'Too many failed sign-in attempts. Try again in 15 minutes.');
      const body = await this._body(req, 4096);
      const user = typeof body.username === 'string' ? this.ctx.db.get('SELECT * FROM web_users WHERE username = ?', body.username.slice(0, 64)) : null;
      // Verify against a dummy hash when the user does not exist to keep timing uniform.
      const ok = auth.verifyPassword(typeof body.password === 'string' ? body.password.slice(0, 256) : '', user ? user.password_hash : this._dummyHash());
      if (!user || !ok) {
        this.loginLimiter.fail(ip);
        this.ctx.audit.record({ actor: `web:${ip}`, action: 'web.login', result: 'failed', target: String(body.username || '').slice(0, 64) });
        throw new AppError('E_AUTH', 'Incorrect username or password.');
      }
      this.loginLimiter.reset(ip);
      const sess = this.sessions.create({ id: user.id, username: user.username, role: user.role }, ip);
      this.ctx.db.run('UPDATE web_users SET last_login = ? WHERE id = ?', Date.now(), user.id);
      this.ctx.audit.record({ actor: `web:${user.username}`, action: 'web.login', target: user.username, details: { ip } });
      return this._json(res, 200, { authenticated: true, user: user.username, role: user.role, csrf: sess.csrf }, { 'Set-Cookie': `${COOKIE}=${sess.id}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${12 * 3600}` });
    }
    const s = this.sessions.get(this._cookie(req));
    if (!s) throw new AppError('E_AUTH', 'Please sign in.');
    if (route === 'GET /api/events') return this._events(req, res, s);
    if (req.method !== 'POST') throw Object.assign(new AppError('E_NOT_FOUND', 'Not found'), { status: 404 });
    if (!this._sameOrigin(req) || !auth.safeEqual(req.headers['x-csrf-token'] || '', s.csrf)) throw new AppError('E_FORBIDDEN', 'Invalid or missing CSRF token.');
    if (route === 'POST /api/logout') {
      this.sessions.destroy(this._cookie(req));
      return this._json(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0` });
    }
    if (route === 'POST /api/rpc') {
      const body = await this._body(req);
      if (!this.ctx.settings.get('web').allowRemoteControl && s.role === 'admin' && !this.ctx.rpc.isReadOnly(body.channel)) throw new AppError('E_FORBIDDEN', 'Control actions are disabled for the web dashboard in Settings → Web dashboard.');
      const result = await this.ctx.rpc.dispatch(body.channel, body.payload, { transport: 'web', role: s.role, actor: `web:${s.username}` });
      return this._json(res, 200, { result });
    }
    throw Object.assign(new AppError('E_NOT_FOUND', 'Not found'), { status: 404 });
  }

  _dummyHash() { if (!this.dummy) this.dummy = auth.hashPassword(newId()); return this.dummy; }

  _events(req, res, s) {
    this._headers(res, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.writeHead(200);
    res.write(': connected\n\n');
    const client = { res, role: s.role };
    this.sse.add(client);
    const ka = setInterval(() => { if (!this.sessions.get(this._cookie(req))) { res.end(); return; } res.write(': keep-alive\n\n'); }, 25000);
    req.on('close', () => { clearInterval(ka); this.sse.delete(client); });
  }

  // ------------------------------------------------------------ remote management (agent side)
  createPairingCode(actor = 'local') {
    if (!this.ctx.settings.get('remote').enabled) throw new AppError('E_DISABLED', 'Enable remote management first.');
    this.pairing = { code: auth.pairingCode(), expires: Date.now() + 10 * 60000, attempts: 0 };
    this.ctx.audit.record({ actor, action: 'remote.pairing.create' });
    return { code: this.pairing.code, expires: this.pairing.expires, fingerprint: this.info.fingerprint };
  }

  async _remote(req, res, url) {
    const ip = this._ip(req);
    if (req.method === 'POST' && url.pathname === '/remote/v1/pair') {
      if (this.pairLimiter.blocked(ip)) throw new AppError('E_RATE', 'Too many pairing attempts. Try again later.');
      const body = await this._body(req, 4096);
      const p = this.pairing;
      if (!p || Date.now() > p.expires || ++p.attempts > 5 || typeof body.code !== 'string' || !auth.safeEqual(body.code.toUpperCase().trim(), p.code)) {
        this.pairLimiter.fail(ip);
        if (p && p.attempts > 5) this.pairing = null;
        this.ctx.audit.record({ actor: `remote:${ip}`, action: 'remote.pair', result: 'failed' });
        throw new AppError('E_AUTH', 'Invalid or expired pairing code.');
      }
      this.pairing = null;
      const deviceId = newId('dev_');
      const { token, hash } = auth.newDeviceToken(deviceId);
      const name = String(body.deviceName || 'Remote manager').replace(/[^\w .-]/g, '').slice(0, 60) || 'Remote manager';
      this.ctx.db.run('INSERT INTO remote_devices (id, name, token_hash, scopes, created_at, last_ip) VALUES (?, ?, ?, ?, ?, ?)', deviceId, name, hash, JSON.stringify(['read', 'control', 'configure']), Date.now(), ip);
      this.ctx.audit.record({ actor: `remote:${name}`, action: 'remote.pair', target: name, details: { ip, deviceId } });
      this.ctx.notifications.notify({ category: 'security', severity: 'warning', title: 'New remote manager paired', body: `"${name}" (${ip}) can now manage this computer's servers. Revoke it under Remote if this was not you.` });
      this.ctx.bus.publish('remote.changed', {});
      return this._json(res, 200, { deviceId, token, machineName: require('node:os').hostname() });
    }
    const parsed = auth.parseDeviceToken((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    const dev = parsed && this.ctx.db.get('SELECT * FROM remote_devices WHERE id = ? AND revoked_at IS NULL', parsed.deviceId);
    if (!dev || !auth.safeEqual(dev.token_hash, parsed.secretHash)) {
      this.pairLimiter.fail(ip);
      throw new AppError('E_AUTH', 'Remote credentials are invalid or have been revoked.');
    }
    this.ctx.db.run('UPDATE remote_devices SET last_seen = ?, last_ip = ? WHERE id = ?', Date.now(), ip, dev.id);
    if (req.method === 'GET' && url.pathname === '/remote/v1/ping') return this._json(res, 200, { name: require('node:os').hostname(), version: require('../../../package.json').version, time: Date.now() });
    if (req.method === 'POST' && url.pathname === '/remote/v1/rpc') {
      const body = await this._body(req);
      if (body.channel === 'remote.revokeSelf') {
        this.ctx.db.run('UPDATE remote_devices SET revoked_at = ? WHERE id = ?', Date.now(), dev.id);
        this.ctx.audit.record({ actor: `remote:${dev.name}`, action: 'remote.device.revoke', target: dev.name, details: { self: true } });
        return this._json(res, 200, { result: { revoked: true } });
      }
      const result = await this.ctx.rpc.dispatch(body.channel, body.payload, { transport: 'remote', scopes: JSON.parse(dev.scopes), actor: `remote:${dev.name}` });
      return this._json(res, 200, { result });
    }
    throw Object.assign(new AppError('E_NOT_FOUND', 'Not found'), { status: 404 });
  }

  devices() { return this.ctx.db.all('SELECT id, name, scopes, created_at, last_seen, last_ip, revoked_at FROM remote_devices ORDER BY created_at DESC').map((d) => ({ ...d, scopes: JSON.parse(d.scopes) })); }
  revokeDevice(id, actor = 'local') {
    const d = this.ctx.db.get('SELECT * FROM remote_devices WHERE id = ?', id);
    if (!d) throw new AppError('E_NOT_FOUND', 'Device not found');
    this.ctx.db.run('UPDATE remote_devices SET revoked_at = ? WHERE id = ?', Date.now(), id);
    this.ctx.audit.record({ actor, action: 'remote.device.revoke', target: d.name });
    this.ctx.bus.publish('remote.changed', {});
  }

  // ------------------------------------------------------------ web users
  users() { return this.ctx.db.all('SELECT id, username, role, created_at, last_login FROM web_users ORDER BY username'); }
  addUser({ username, password, role }, actor = 'local') {
    const problems = auth.passwordProblems(password);
    if (problems.length) throw new AppError('E_VALIDATION', `The password needs ${problems.join(', ')}.`);
    if (this.ctx.db.get('SELECT 1 AS x FROM web_users WHERE username = ?', username)) throw new AppError('E_EXISTS', 'That username already exists.');
    const id = newId('wu_');
    this.ctx.db.run('INSERT INTO web_users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)', id, username, auth.hashPassword(password), role, Date.now());
    this.ctx.audit.record({ actor, action: 'web.user.add', target: username, details: { role } });
    return this.users();
  }
  setPassword(id, password, actor = 'local') {
    const problems = auth.passwordProblems(password);
    if (problems.length) throw new AppError('E_VALIDATION', `The password needs ${problems.join(', ')}.`);
    this.ctx.db.run('UPDATE web_users SET password_hash = ? WHERE id = ?', auth.hashPassword(password), id);
    this.sessions.destroyUser(id);
    this.ctx.audit.record({ actor, action: 'web.user.password', target: id });
  }
  removeUser(id, actor = 'local') {
    this.ctx.db.run('DELETE FROM web_users WHERE id = ?', id);
    this.sessions.destroyUser(id);
    this.ctx.audit.record({ actor, action: 'web.user.remove', target: id });
    return this.users();
  }
}

module.exports = { WebServer, CSP };
