'use strict';
/**
 * Server API access using only the documented authentication flows of the
 * Satisfactory Dedicated Server HTTPS API:
 *   - unclaimed server: PasswordlessLogin(InitialAdmin) → ClaimServer(name, admin password)
 *   - claimed server:   PasswordLogin(Administrator, admin password)
 * then RunCommand("server.GenerateAPIToken") for a long-lived API token when
 * the server returns one; otherwise the administrator token is kept.
 * Tokens are stored only through Secrets (DPAPI). Passwords are never stored.
 */
const { parseGeneratedToken } = require('../server/api-client');
const { AppError } = require('../core/util');

class Access {
  constructor(ctx) { this.ctx = ctx; }

  _api(id) { return this.ctx.supervisor.api(id); }

  async status(id) {
    const srv = this.ctx.registry.get(id);
    const hasToken = this.ctx.supervisor.hasToken(id);
    const running = this.ctx.supervisor.isActive(id);
    const out = { running, hasToken, tokenKind: srv.config.api.tokenKind, pinned: !!srv.config.api.pin, fingerprint: srv.config.api.pin, claimed: null, tokenValid: null, error: null };
    if (!running) return out;
    try {
      await this._api(id).healthCheck();
    } catch (err) { out.error = err.message; return out; }
    if (hasToken) {
      try { await this._api(id).verifyToken(this.ctx.secrets.get(this.ctx.supervisor.tokenKey(id))); out.tokenValid = true; out.claimed = true; } catch (err) { out.tokenValid = false; out.error = err.message; }
    }
    if (out.claimed === null) {
      try { await this._api(id).passwordlessLogin('InitialAdmin'); out.claimed = false; } catch { out.claimed = true; }
    }
    return out;
  }

  async _storeBestToken(id, adminToken) {
    let token = adminToken; let kind = 'admin';
    try {
      const res = await this._api(id).runCommand('server.GenerateAPIToken', adminToken);
      const generated = parseGeneratedToken(res.data && res.data.commandResult);
      if (generated) {
        await this._api(id).verifyToken(generated);
        token = generated; kind = 'api';
      }
    } catch (err) { this.ctx.log.info(`API token generation not available, keeping administrator token: ${err.message}`); }
    this.ctx.secrets.set(this.ctx.supervisor.tokenKey(id), token);
    this.ctx.registry.patchInternal(id, { api: { hasToken: true, tokenKind: kind } });
    await this._api(id).verifyToken(token);
    return kind;
  }

  async claim(id, { serverName, adminPassword, actor = 'local' }) {
    const srv = this.ctx.registry.get(id);
    if (!this.ctx.supervisor.isActive(id)) throw new AppError('E_NOT_RUNNING', 'The server must be running to claim it.');
    return this.ctx.audit.wrap({ actor, action: 'credentials.claim', serverId: id, target: srv.name, details: { serverName } }, async () => {
      let initial;
      try { initial = (await this._api(id).passwordlessLogin('InitialAdmin')).data.authenticationToken; } catch (err) {
        throw new AppError('E_ALREADY_CLAIMED', 'This server has already been claimed. Sign in with its administrator password instead.', { cause: err.message });
      }
      const res = await this._api(id).claim(serverName, adminPassword, initial);
      const adminToken = res.data && res.data.authenticationToken;
      if (!adminToken) throw new AppError('E_CLAIM', 'The server did not return an administrator token after claiming.');
      const kind = await this._storeBestToken(id, adminToken);
      return { claimed: true, tokenKind: kind };
    });
  }

  async login(id, { adminPassword, actor = 'local' }) {
    const srv = this.ctx.registry.get(id);
    if (!this.ctx.supervisor.isActive(id)) throw new AppError('E_NOT_RUNNING', 'The server must be running to sign in.');
    return this.ctx.audit.wrap({ actor, action: 'credentials.login', serverId: id, target: srv.name }, async () => {
      let token;
      try { token = (await this._api(id).passwordLogin(adminPassword, 'Administrator')).data.authenticationToken; } catch (err) {
        throw new AppError('E_LOGIN', /wrong_password|password/i.test(err.message) ? 'The administrator password is incorrect.' : `Sign-in failed: ${err.message}`);
      }
      return { tokenKind: await this._storeBestToken(id, token) };
    });
  }

  /** Store an API token the user generated themselves (server.GenerateAPIToken in the server console). */
  async setToken(id, { token, actor = 'local' }) {
    const srv = this.ctx.registry.get(id);
    return this.ctx.audit.wrap({ actor, action: 'credentials.token.set', serverId: id, target: srv.name }, async () => {
      if (this.ctx.supervisor.isActive(id)) await this._api(id).verifyToken(token).catch((e) => { throw new AppError('E_TOKEN_INVALID', `The server rejected this token: ${e.message}`); });
      this.ctx.secrets.set(this.ctx.supervisor.tokenKey(id), token);
      this.ctx.registry.patchInternal(id, { api: { hasToken: true, tokenKind: 'api' } });
      return { stored: true, verified: this.ctx.supervisor.isActive(id) };
    });
  }

  async setClientPassword(id, { password, actor = 'local' }) {
    const srv = this.ctx.registry.get(id);
    return this.ctx.audit.wrap({ actor, action: 'credentials.client-password', serverId: id, target: srv.name, details: { cleared: !password } }, () => this._api(id).setClientPassword(password || ''));
  }

  forget(id, actor = 'local') {
    this.ctx.secrets.delete(this.ctx.supervisor.tokenKey(id));
    this.ctx.registry.patchInternal(id, { api: { hasToken: false, tokenKind: null } });
    this.ctx.audit.record({ actor, action: 'credentials.token.remove', serverId: id });
  }

  /** Re-trust the server certificate (after the user confirmed a changed certificate is legitimate). */
  resetPin(id, actor = 'local') {
    this.ctx.registry.patchInternal(id, { api: { pin: null } });
    this.ctx.audit.record({ actor, action: 'credentials.pin.reset', serverId: id });
  }
}

module.exports = { Access };
