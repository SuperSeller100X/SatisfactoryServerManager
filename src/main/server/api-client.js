'use strict';
/**
 * Client for the Satisfactory Dedicated Server HTTPS API (POST /api/v1).
 *
 * The server presents a self-signed certificate by default, so standard CA
 * validation cannot succeed. Instead of disabling TLS verification, this client
 * pins the certificate's SHA-256 fingerprint: a TLS socket is opened, the peer
 * certificate is checked against the stored pin, and only then is the HTTP
 * request written on that verified socket. A changed certificate is refused.
 */
const tls = require('node:tls');
const https = require('node:https');
const { AppError } = require('../core/util');

/** Functions documented in the server's DedicatedServerAPIDocs (1.0+). */
const API_FUNCTIONS = new Set([
  'HealthCheck', 'VerifyAuthenticationToken', 'PasswordlessLogin', 'PasswordLogin', 'QueryServerState',
  'GetServerOptions', 'GetAdvancedGameSettings', 'ApplyAdvancedGameSettings', 'ClaimServer', 'RenameServer',
  'SetClientPassword', 'SetAdminPassword', 'SetAutoLoadSessionName', 'RunCommand', 'Shutdown',
  'ApplyServerOptions', 'CreateNewGame', 'SaveGame', 'DeleteSaveFile', 'DeleteSaveSession', 'EnumerateSessions', 'LoadGame',
]);

function fingerprintOf(cert) {
  return cert && cert.fingerprint256 ? cert.fingerprint256.toUpperCase() : null;
}

/** Open a TLS connection and return { socket, fingerprint } without sending data. */
function connectAndInspect(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: undefined, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] });
    const timer = setTimeout(() => { socket.destroy(); reject(new AppError('E_API_TIMEOUT', `No TLS response from ${host}:${port}`)); }, timeoutMs);
    socket.once('secureConnect', () => { clearTimeout(timer); resolve({ socket, fingerprint: fingerprintOf(socket.getPeerCertificate()) }); });
    socket.once('error', (err) => { clearTimeout(timer); reject(new AppError('E_API_UNREACHABLE', `Cannot connect to the server API at ${host}:${port}: ${err.code || err.message}`)); });
  });
}

class ServerApiClient {
  /**
   * @param {object} o
   * @param {string} o.host
   * @param {number} o.port
   * @param {() => string|null} o.getPin   returns pinned fingerprint
   * @param {(fp:string) => void} o.onFirstUse  called when no pin exists (TOFU)
   * @param {() => string|null} o.getToken returns bearer token
   */
  constructor({ host = '127.0.0.1', port = 7777, getPin, onFirstUse, getToken, timeoutMs = 8000 }) {
    Object.assign(this, { host, port, getPin, onFirstUse, getToken, timeoutMs });
  }

  async call(fn, data = {}, { token, timeoutMs } = {}) {
    if (!API_FUNCTIONS.has(fn)) throw new AppError('E_API_FUNCTION', `Unsupported API function: ${fn}`);
    const started = Date.now();
    const { socket, fingerprint } = await connectAndInspect(this.host, this.port, timeoutMs || this.timeoutMs);
    const pin = this.getPin ? this.getPin() : null;
    if (!pin) {
      if (!this.onFirstUse) { socket.destroy(); throw new AppError('E_API_UNPINNED', 'The server certificate has not been trusted yet.', { fingerprint }); }
      this.onFirstUse(fingerprint);
    } else if (pin !== fingerprint) {
      socket.destroy();
      throw new AppError('E_API_CERT_CHANGED', 'The server presented a different TLS certificate than the trusted one. The connection was refused.', { expected: pin, actual: fingerprint });
    }
    const bearer = token !== undefined ? token : (this.getToken ? this.getToken() : null);
    const body = JSON.stringify({ function: fn, data });
    return new Promise((resolve, reject) => {
      const req = https.request({
        host: this.host, port: this.port, path: '/api/v1', method: 'POST', agent: false,
        createConnection: () => socket,
        headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
        timeout: timeoutMs || this.timeoutMs,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => { chunks.push(c); if (chunks.length > 4096) req.destroy(new Error('Response too large')); });
        res.on('end', () => {
          const latency = Date.now() - started;
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          if (text) { try { json = JSON.parse(text); } catch { /* non-JSON */ } }
          if (res.statusCode === 204) return resolve({ data: null, latency });
          if (json && json.errorCode) return reject(new AppError(`E_API_${json.errorCode}`, json.errorMessage || json.errorCode, { status: res.statusCode, errorCode: json.errorCode, errorData: json.errorData }));
          if (res.statusCode >= 400) return reject(new AppError('E_API_HTTP', `Server API returned HTTP ${res.statusCode}`, { status: res.statusCode }));
          resolve({ data: json ? json.data : null, latency });
        });
      });
      req.on('timeout', () => req.destroy(new AppError('E_API_TIMEOUT', 'Server API request timed out')));
      req.on('error', (err) => reject(err instanceof AppError ? err : new AppError('E_API_ERROR', err.message)));
      req.end(body);
    });
  }

  // Convenience wrappers ---------------------------------------------------
  healthCheck() { return this.call('HealthCheck', { ClientCustomData: '' }, { token: null }); }
  queryState() { return this.call('QueryServerState'); }
  getOptions() { return this.call('GetServerOptions'); }
  getAdvancedSettings() { return this.call('GetAdvancedGameSettings'); }
  verifyToken(token) { return this.call('VerifyAuthenticationToken', {}, { token }); }
  passwordlessLogin(level = 'InitialAdmin') { return this.call('PasswordlessLogin', { MinimumPrivilegeLevel: level }, { token: null }); }
  passwordLogin(password, level = 'Administrator') { return this.call('PasswordLogin', { MinimumPrivilegeLevel: level, Password: password }, { token: null }); }
  claim(serverName, adminPassword, token) { return this.call('ClaimServer', { ServerName: serverName, AdminPassword: adminPassword }, { token }); }
  runCommand(command, token) { return this.call('RunCommand', { Command: command }, token !== undefined ? { token } : {}); }
  applyOptions(options) { return this.call('ApplyServerOptions', { UpdatedServerOptions: options }); }
  applyAdvanced(settings) { return this.call('ApplyAdvancedGameSettings', { AppliedAdvancedGameSettings: settings }); }
  rename(name) { return this.call('RenameServer', { ServerName: name }); }
  setClientPassword(password) { return this.call('SetClientPassword', { Password: password }); }
  setAutoLoad(sessionName) { return this.call('SetAutoLoadSessionName', { SessionName: sessionName }); }
  saveGame(saveName) { return this.call('SaveGame', { SaveName: saveName }, { timeoutMs: 120000 }); }
  enumerateSessions() { return this.call('EnumerateSessions'); }
  loadGame(saveName, enableAdvancedGameSettings = false) { return this.call('LoadGame', { SaveName: saveName, EnableAdvancedGameSettings: enableAdvancedGameSettings }); }
  shutdown() { return this.call('Shutdown'); }
}

/** Extract an API token from `server.GenerateAPIToken` console/RunCommand output. */
function parseGeneratedToken(text) {
  if (!text) return null;
  const m = /(?:API Token|Token)\s*[:=]\s*([A-Za-z0-9._~+/=-]{20,})/i.exec(text) || /\b(ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,})\b/.exec(text);
  return m ? m[1] : null;
}

module.exports = { ServerApiClient, API_FUNCTIONS, parseGeneratedToken, connectAndInspect };
