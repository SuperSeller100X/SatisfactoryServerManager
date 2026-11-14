'use strict';
/**
 * Server API access, set up automatically using only the documented
 * authentication flows of the Satisfactory Dedicated Server HTTPS API:
 *   - unclaimed server: PasswordlessLogin(InitialAdmin) → ClaimServer(name, admin password)
 *   - claimed server:   PasswordLogin(Administrator, admin password)
 * then RunCommand("server.GenerateAPIToken") for a long-lived API token. The
 * token is also captured when the server prints it to its console.
 *
 * Credentials are stored only through Secrets (Windows DPAPI):
 *   server:<id>:apiToken       bearer token used by the manager
 *   server:<id>:adminPassword  admin password, so the manager can sign in again
 *                              by itself if a token is ever invalidated
 * Secret values never appear in logs, audit entries or the console.
 */
const crypto = require('node:crypto');
const { parseGeneratedToken } = require('../server/api-client');
const { AppError, sleep } = require('../core/util');

const AUTH_ERROR = /invalid_token|insufficient_scope|unauthori[sz]ed|401|E_API_HTTP/i;
const isAuthError = (err) => !!err && (AUTH_ERROR.test(String(err.code)) || AUTH_ERROR.test(String(err.message)) || (err.details && err.details.status === 401));
const isConnectionError = (err) => !!err && /E_API_UNREACHABLE|E_API_TIMEOUT|E_API_CERT_CHANGED|E_API_UNPINNED/.test(String(err.code));

/** Readable but strong password: 4 groups of 5 characters from an unambiguous alphabet (~100 bits). */
function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(20);
  let out = '';
  for (let i = 0; i < 20; i++) { out += alphabet[bytes[i] % alphabet.length]; if (i % 5 === 4 && i < 19) out += '-'; }
  return out;
}

/**
 * Accepts what users realistically paste: the bare token, the whole console
 * line ("API Token: …"), quotes, "Bearer …", line breaks. Returns the token or null.
 */
function sanitizeToken(input) {
  if (typeof input !== 'string') return null;
  let t = input.replace(/[\r\n\t]/g, ' ').trim();
  const fromLine = parseGeneratedToken(t);
  if (fromLine) t = fromLine;
  t = t.replace(/^Bearer\s+/i, '').replace(/^["'`]+|["'`]+$/g, '').trim();
  if (t.includes('[redacted')) return null;
  return /^[A-Za-z0-9._~+/=-]{20,4096}$/.test(t) ? t : null;
}

class Access {
  constructor(ctx) {
    this.ctx = ctx;
    this.pendingCapture = new Map(); // serverId -> { until, resolve }
    this.repairing = new Map();      // serverId -> timestamp of last automatic repair
  }

  _api(id) { return this.ctx.supervisor.api(id); }
  pwKey(id) { return `server:${id}:adminPassword`; }
  hasAdminPassword(id) { return this.ctx.secrets.has(this.pwKey(id)); }

  async status(id) {
    const srv = this.ctx.registry.get(id);
    const hasToken = this.ctx.supervisor.hasToken(id);
    const running = this.ctx.supervisor.isActive(id);
    const out = { running, hasToken, tokenKind: srv.config.api.tokenKind, pinned: !!srv.config.api.pin, fingerprint: srv.config.api.pin, claimed: null, tokenValid: null, error: null, adminPasswordStored: this.hasAdminPassword(id) };
    if (!running) return out;
    try { await this._api(id).healthCheck(); } catch (err) { out.error = err.message; return out; }
    if (hasToken) {
      try { await this._api(id).verifyToken(this.ctx.secrets.get(this.ctx.supervisor.tokenKey(id))); out.tokenValid = true; out.claimed = true; } catch (err) { out.tokenValid = false; out.error = isAuthError(err) ? 'The server no longer accepts the stored token.' : err.message; }
    }
    if (out.claimed === null) {
      try { await this._api(id).passwordlessLogin('InitialAdmin'); out.claimed = false; } catch { out.claimed = true; }
    }
    return out;
  }

  // ------------------------------------------------------------------ token capture
  /** Expect a token in the server console for a short window (after GenerateAPIToken). */
  expectToken(id, ms = 20000) {
    const prev = this.pendingCapture.get(id);
    if (prev) prev.resolve(null);
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    this.pendingCapture.set(id, { until: Date.now() + ms, resolve });
    setTimeout(() => { const p = this.pendingCapture.get(id); if (p && p.resolve === resolve) { this.pendingCapture.delete(id); resolve(null); } }, ms).unref?.();
    return promise;
  }

  isExpectingToken(id) { const p = this.pendingCapture.get(id); return !!p && Date.now() < p.until; }

  /** Called by the supervisor (before console redaction) when a line contains a token. */
  async captureToken(id, raw) {
    const p = this.pendingCapture.get(id);
    if (!p || Date.now() > p.until) return false;
    const token = sanitizeToken(raw);
    if (!token) return false;
    try {
      await this._api(id).verifyToken(token);
    } catch (err) { this.ctx.log.warn(`Captured API token was not accepted: ${err.message}`); return false; }
    this._store(id, token, 'api');
    this.pendingCapture.delete(id);
    p.resolve(token);
    this.ctx.audit.record({ actor: 'system', action: 'credentials.token.capture', serverId: id, target: this.ctx.registry.get(id).name });
    this.ctx.supervisor.sys(id, 'API token generated by the server was verified and stored securely (it is not shown here).');
    return true;
  }

  _store(id, token, kind) {
    this.ctx.secrets.set(this.ctx.supervisor.tokenKey(id), token);
    this.ctx.registry.patchInternal(id, { api: { hasToken: true, tokenKind: kind } });
    this.ctx.bus.publish('server.changed', { id });
  }

  /** Obtain a long-lived API token using an administrator token; fall back to the admin token. */
  async _storeBestToken(id, adminToken) {
    let token = null; let kind = 'admin';
    const captured = this.expectToken(id, 15000);
    try {
      const res = await this._api(id).runCommand('server.GenerateAPIToken', adminToken);
      token = sanitizeToken(res.data && res.data.commandResult !== undefined ? String(res.data.commandResult) : '');
    } catch (err) { this.ctx.log.info(`RunCommand server.GenerateAPIToken failed: ${err.message}`); }
    if (!token) token = await Promise.race([captured, sleep(5000).then(() => null)]);
    else { const p = this.pendingCapture.get(id); if (p) { this.pendingCapture.delete(id); p.resolve(null); } }
    if (token) {
      try { await this._api(id).verifyToken(token); kind = 'api'; } catch { token = null; }
    }
    if (!token) token = adminToken;
    await this._api(id).verifyToken(token);
    this._store(id, token, kind);
    return kind;
  }

  // ------------------------------------------------------------------ automatic setup
  /**
   * Configure API access without manual steps where the server allows it.
   * Unclaimed server → claimed with `serverName` and the given (or a generated)
   * admin password. Claimed server → signs in with the stored admin password,
   * or the one supplied. Returns { tokenKind, claimed, generatedPassword? }.
   */
  async autoSetup(id, { serverName, adminPassword, clientPassword, actor = 'local' } = {}) {
    const srv = this.ctx.registry.get(id);
    if (!this.ctx.supervisor.isActive(id)) throw new AppError('E_NOT_RUNNING', 'The server must be running to set up API access.');
    if (this.ctx.supervisor.hasToken(id)) {
      try { await this._api(id).verifyToken(this.ctx.secrets.get(this.ctx.supervisor.tokenKey(id))); return { tokenKind: srv.config.api.tokenKind || 'api', claimed: true, alreadyConfigured: true }; } catch (err) { if (!isAuthError(err)) throw err; }
    }
    return this.ctx.audit.wrap({ actor, action: 'credentials.auto-setup', serverId: id, target: srv.name }, async () => {
      let initial = null;
      try { initial = (await this._api(id).passwordlessLogin('InitialAdmin')).data.authenticationToken; } catch { initial = null; }
      if (initial) {
        const generated = !adminPassword;
        const password = adminPassword || generatePassword();
        if (password.length < 8) throw new AppError('E_VALIDATION', 'The administrator password must be at least 8 characters long.');
        const res = await this._api(id).claim(serverName || srv.name, password, initial);
        const adminToken = res.data && res.data.authenticationToken;
        if (!adminToken) throw new AppError('E_CLAIM', 'The server did not return an administrator token after claiming.');
        this.ctx.secrets.set(this.pwKey(id), password);
        const kind = await this._storeBestToken(id, adminToken);
        if (clientPassword) await this._api(id).setClientPassword(clientPassword).catch((e) => this.ctx.log.warn(`Setting the player password failed: ${e.message}`));
        return { tokenKind: kind, claimed: true, generatedPassword: generated ? password : undefined };
      }
      const password = adminPassword || this.ctx.secrets.get(this.pwKey(id));
      if (!password) throw new AppError('E_ADMIN_PASSWORD_REQUIRED', 'This server was already claimed before. Enter its administrator password once — the manager stores it encrypted and handles access automatically from then on.');
      let token;
      try { token = (await this._api(id).passwordLogin(password, 'Administrator')).data.authenticationToken; } catch (err) {
        throw new AppError('E_LOGIN', isAuthError(err) || /wrong_password|password/i.test(err.message) ? 'The administrator password is incorrect.' : `Sign-in failed: ${err.message}`);
      }
      this.ctx.secrets.set(this.pwKey(id), password);
      return { tokenKind: await this._storeBestToken(id, token), claimed: true };
    });
  }

  claim(id, { serverName, adminPassword, actor = 'local' }) {
    if (!adminPassword || adminPassword.length < 8) throw new AppError('E_VALIDATION', 'The administrator password must be at least 8 characters long.');
    return this.autoSetup(id, { serverName, adminPassword, actor });
  }

  login(id, { adminPassword, actor = 'local' }) { return this.autoSetup(id, { adminPassword, actor }); }

  /**
   * Re-establish access when the stored token was invalidated (e.g. by
   * server.InvalidateAPITokens or a server reset), using the stored admin
   * password. Throttled to once per 5 minutes per server.
   */
  async repair(id) {
    if (!this.hasAdminPassword(id) || !this.ctx.supervisor.isActive(id)) return false;
    const last = this.repairing.get(id) || 0;
    if (Date.now() - last < 5 * 60000) return false;
    this.repairing.set(id, Date.now());
    try {
      const token = (await this._api(id).passwordLogin(this.ctx.secrets.get(this.pwKey(id)), 'Administrator')).data.authenticationToken;
      const kind = await this._storeBestToken(id, token);
      this.ctx.audit.record({ actor: 'system', action: 'credentials.token.renew', serverId: id, details: { kind } });
      return true;
    } catch (err) {
      this.ctx.audit.record({ actor: 'system', action: 'credentials.token.renew', serverId: id, result: 'failed', error: err });
      return false;
    }
  }

  /** Store an API token entered by the user. Accepts the whole console line. */
  async setToken(id, { token: input, actor = 'local' }) {
    const srv = this.ctx.registry.get(id);
    const token = sanitizeToken(input);
    if (!token) throw new AppError('E_TOKEN_FORMAT', 'That does not look like an API token. Paste the text after “API Token:” from the server console — or simply use “Set up automatically”.');
    return this.ctx.audit.wrap({ actor, action: 'credentials.token.set', serverId: id, target: srv.name }, async () => {
      let verified = false;
      if (this.ctx.supervisor.isActive(id)) {
        try { await this._api(id).verifyToken(token); verified = true; } catch (err) {
          if (isConnectionError(err)) throw new AppError('E_API_UNREACHABLE', `The token could not be checked because the server API is not reachable: ${err.message}`);
          throw new AppError('E_TOKEN_INVALID', 'The server rejected this token. Tokens are only valid for the server that generated them and stop working after server.InvalidateAPITokens.');
        }
      }
      this._store(id, token, 'api');
      return { stored: true, verified };
    });
  }

  async setClientPassword(id, { password, actor = 'local' }) {
    const srv = this.ctx.registry.get(id);
    return this.ctx.audit.wrap({ actor, action: 'credentials.client-password', serverId: id, target: srv.name, details: { cleared: !password } }, () => this._api(id).setClientPassword(password || ''));
  }

  /** Desktop-only: show the stored admin password so the user can manage the server in-game. */
  revealAdminPassword(id, actor = 'local') {
    const pw = this.ctx.secrets.get(this.pwKey(id));
    if (!pw) throw new AppError('E_NOT_FOUND', 'No administrator password is stored for this server.');
    this.ctx.audit.record({ actor, action: 'credentials.admin-password.reveal', serverId: id });
    return { password: pw };
  }

  forget(id, actor = 'local') {
    this.ctx.secrets.delete(this.ctx.supervisor.tokenKey(id));
    this.ctx.secrets.delete(this.pwKey(id));
    this.ctx.registry.patchInternal(id, { api: { hasToken: false, tokenKind: null } });
    this.ctx.audit.record({ actor, action: 'credentials.token.remove', serverId: id });
  }

  resetPin(id, actor = 'local') {
    this.ctx.registry.patchInternal(id, { api: { pin: null } });
    this.ctx.audit.record({ actor, action: 'credentials.pin.reset', serverId: id });
  }
}

module.exports = { Access, sanitizeToken, generatePassword, isAuthError };
