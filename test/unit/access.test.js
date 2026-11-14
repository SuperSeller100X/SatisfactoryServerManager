'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const crypto = require('node:crypto');
const path = require('node:path');
const { makeCtx, tmpDir } = require('./helpers');
const { generateCertificate } = require('../../src/main/net/certs');
const { Supervisor } = require('../../src/main/server/supervisor');
const { createProbe } = require('../../src/main/server/procstats');
const { Access, sanitizeToken, generatePassword } = require('../../src/main/features/access');
const { Setup } = require('../../src/main/features/setup');

/**
 * Test double of the Satisfactory Dedicated Server HTTPS API (POST /api/v1,
 * self-signed TLS), implementing the documented functions used by the manager
 * with the documented request/response shapes and error codes.
 */
function fakeServerApi({ claimed = false, adminPassword = null, tokenInRunCommand = true, onGenerate } = {}) {
  const tls = generateCertificate({ hosts: ['127.0.0.1'] });
  const state = { claimed, adminPassword, serverName: '', tokens: new Map(), apiTokens: new Set(), calls: [] };
  const issue = (level) => { const t = `${Buffer.from(JSON.stringify({ pl: level })).toString('base64url')}.${crypto.randomBytes(32).toString('hex')}`; state.tokens.set(t, level); return t; };
  const server = https.createServer({ cert: tls.certPem, key: tls.keyPem }, (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { function: fn, data = {} } = JSON.parse(body || '{}');
      state.calls.push(fn);
      const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
      const level = state.tokens.get(bearer);
      const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(obj ? JSON.stringify(obj) : ''); };
      const err = (code, status = 400) => send(status, { errorCode: code, errorMessage: code });
      switch (fn) {
        case 'HealthCheck': return send(200, { data: { health: 'healthy', serverCustomData: '' } });
        case 'PasswordlessLogin':
          if (state.claimed) return err('passwordless_login_not_possible');
          return send(200, { data: { authenticationToken: issue('InitialAdmin') } });
        case 'ClaimServer':
          if (level !== 'InitialAdmin' || state.claimed) return err('insufficient_scope', 403);
          state.claimed = true; state.adminPassword = data.AdminPassword; state.serverName = data.ServerName;
          for (const [t, l] of state.tokens) if (l === 'InitialAdmin') state.tokens.delete(t);
          return send(200, { data: { authenticationToken: issue('Administrator') } });
        case 'PasswordLogin':
          if (!state.claimed || data.Password !== state.adminPassword) return err('wrong_password', 401);
          return send(200, { data: { authenticationToken: issue('Administrator') } });
        case 'VerifyAuthenticationToken':
          return level ? send(204) : err('invalid_token', 401);
        case 'RunCommand': {
          if (level !== 'Administrator' && level !== 'APIToken') return err('insufficient_scope', 403);
          if (data.Command === 'server.GenerateAPIToken') {
            const t = issue('APIToken'); state.apiTokens.add(t);
            if (onGenerate) onGenerate(t);
            return send(200, { data: { commandResult: tokenInRunCommand ? `API Token: ${t}` : '', returnValue: true } });
          }
          if (data.Command === 'server.InvalidateAPITokens') { for (const t of state.apiTokens) state.tokens.delete(t); state.apiTokens.clear(); return send(200, { data: { commandResult: '', returnValue: true } }); }
          return send(200, { data: { commandResult: '', returnValue: false } });
        }
        case 'SetClientPassword': return level ? send(204) : err('invalid_token', 401);
        case 'QueryServerState': return level ? send(200, { data: { serverGameState: { numConnectedPlayers: 0, playerLimit: 4 } } }) : err('invalid_token', 401);
        default: return err('unknown_function');
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port, fingerprint: new crypto.X509Certificate(tls.certPem).fingerprint256 })));
}

function build(port) {
  const ctx = makeCtx();
  ctx.probe = createProbe();
  ctx.supervisor = new Supervisor(ctx);
  ctx.access = new Access(ctx);
  const srv = ctx.registry.create({ name: 'Factory One', installDir: path.join(tmpDir(), 'srv'), config: { launch: { port, reliablePort: port === 8888 ? 8889 : 8888 } } });
  // The process itself is not under test: mark the server as running and ready.
  ctx.supervisor._setStatus(srv.id, 'running', { readyAt: Date.now(), startedAt: Date.now(), pid: process.pid });
  return { ctx, srv };
}
const done = (ctx, fake) => { ctx.supervisor.dispose(); ctx.probe.dispose(); fake.server.close(); };

test('token sanitizing accepts whole console lines and rejects masked text', () => {
  const t = 'ewoJInBsIjogIkFQSVRva2VuIgp9.0123456789abcdef0123456789abcdef';
  assert.equal(sanitizeToken(t), t);
  assert.equal(sanitizeToken(`API Token: ${t}`), t);
  assert.equal(sanitizeToken(`  "${t}"\r\n`), t);
  assert.equal(sanitizeToken(`Bearer ${t}`), t);
  assert.equal(sanitizeToken('API Token: [redacted]'), null);
  assert.equal(sanitizeToken('short'), null);
  assert.match(generatePassword(), /^[A-Za-z2-9]{5}(-[A-Za-z2-9]{5}){3}$/);
});

test('automatic setup claims an unclaimed server, generates and verifies an API token', async () => {
  const fake = await fakeServerApi();
  const { ctx, srv } = build(fake.port);
  try {
    const r = await ctx.access.autoSetup(srv.id, { serverName: 'Factory One' });
    assert.equal(r.tokenKind, 'api');
    assert.ok(r.generatedPassword, 'generated admin password returned once for display');
    assert.equal(fake.state.claimed, true);
    assert.equal(fake.state.serverName, 'Factory One');
    assert.equal(fake.state.adminPassword, r.generatedPassword);
    const stored = ctx.secrets.get(ctx.supervisor.tokenKey(srv.id));
    assert.ok(fake.state.apiTokens.has(stored), 'stored token is the generated API token');
    assert.equal(ctx.registry.get(srv.id).config.api.pin, fake.fingerprint, 'server certificate pinned');
    assert.equal(ctx.access.revealAdminPassword(srv.id).password, r.generatedPassword);
    const audit = JSON.stringify(ctx.db.all('SELECT * FROM audit'));
    assert.ok(!audit.includes(r.generatedPassword) && !audit.includes(stored), 'no secrets in the audit trail');
    // Running again is a no-op.
    assert.equal((await ctx.access.autoSetup(srv.id, {})).alreadyConfigured, true);
  } finally { done(ctx, fake); }
});

test('token printed to the server console (not returned by RunCommand) is captured automatically', async () => {
  let ctxRef; let idRef;
  const fake = await fakeServerApi({ tokenInRunCommand: false, onGenerate: (t) => setTimeout(() => ctxRef.supervisor._push(idRef, 'out', `[2026.01.15-10.00.00:000][  0]LogServer: API Token: ${t}`), 50) });
  const { ctx, srv } = build(fake.port);
  ctxRef = ctx; idRef = srv.id;
  try {
    const r = await ctx.access.autoSetup(srv.id, {});
    assert.equal(r.tokenKind, 'api');
    assert.ok(fake.state.apiTokens.has(ctx.secrets.get(ctx.supervisor.tokenKey(srv.id))));
    const lines = ctx.supervisor.consoleSnapshot(srv.id).map((l) => l.text).join('\n');
    assert.ok(!lines.includes([...fake.state.apiTokens][0]), 'token never shown in the console');
    assert.match(lines, /verified and stored securely/);
  } finally { done(ctx, fake); }
});

test('already claimed server: asks for the password once, then signs in automatically', async () => {
  const fake = await fakeServerApi({ claimed: true, adminPassword: 'existing-password' });
  const { ctx, srv } = build(fake.port);
  try {
    await assert.rejects(ctx.access.autoSetup(srv.id, {}), (e) => e.code === 'E_ADMIN_PASSWORD_REQUIRED');
    await assert.rejects(ctx.access.autoSetup(srv.id, { adminPassword: 'wrong-password' }), (e) => e.code === 'E_LOGIN' && /incorrect/.test(e.message));
    const r = await ctx.access.autoSetup(srv.id, { adminPassword: 'existing-password' });
    assert.equal(r.tokenKind, 'api');
    assert.equal(r.generatedPassword, undefined);
  } finally { done(ctx, fake); }
});

test('invalidated token is renewed automatically with the stored admin password', async () => {
  const fake = await fakeServerApi();
  const { ctx, srv } = build(fake.port);
  try {
    await ctx.access.autoSetup(srv.id, {});
    const old = ctx.secrets.get(ctx.supervisor.tokenKey(srv.id));
    for (const t of fake.state.apiTokens) fake.state.tokens.delete(t); // server.InvalidateAPITokens
    assert.equal((await ctx.access.status(srv.id)).tokenValid, false);
    assert.equal(await ctx.access.repair(srv.id), true);
    const fresh = ctx.secrets.get(ctx.supervisor.tokenKey(srv.id));
    assert.notEqual(fresh, old);
    assert.equal((await ctx.access.status(srv.id)).tokenValid, true);
    assert.equal(await ctx.access.repair(srv.id), false, 'renewal is throttled');
  } finally { done(ctx, fake); }
});

test('manually entered tokens: whole console line accepted, wrong or masked tokens explained', async () => {
  const fake = await fakeServerApi({ claimed: true, adminPassword: 'pw-123456' });
  const { ctx, srv } = build(fake.port);
  try {
    const admin = await new Promise((resolve) => {
      const r = https.request({ host: '127.0.0.1', port: fake.port, method: 'POST', path: '/api/v1', rejectUnauthorized: false, headers: { 'content-type': 'application/json' } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(JSON.parse(b).data.authenticationToken)); });
      r.end(JSON.stringify({ function: 'PasswordLogin', data: { MinimumPrivilegeLevel: 'Administrator', Password: 'pw-123456' } }));
    });
    await assert.rejects(ctx.access.setToken(srv.id, { token: 'API Token: [redacted]' }), (e) => e.code === 'E_TOKEN_FORMAT');
    await assert.rejects(ctx.access.setToken(srv.id, { token: 'ewoJInBsIjogIkFQSVRva2VuIgp9.ffffffffffffffffffffffffffffffff' }), (e) => e.code === 'E_TOKEN_INVALID');
    const r = await ctx.access.setToken(srv.id, { token: `API Token: ${admin}\r\n` });
    assert.deepEqual(r, { stored: true, verified: true });
  } finally { done(ctx, fake); }
});

test('setup assistant: ports chosen at creation are validated and applied; one-click security', async () => {
  const fake = await fakeServerApi();
  const ctx = makeCtx();
  ctx.probe = createProbe();
  ctx.supervisor = new Supervisor(ctx);
  ctx.access = new Access(ctx);
  ctx.steamcmd = { status: async () => ({ installed: true }), cancel() {} };
  ctx.setup = new Setup(ctx);
  try {
    ctx.registry.create({ name: 'Other', installDir: path.join(tmpDir(), 'other'), config: { launch: { port: 15000, reliablePort: 15001 } } });
    const clash = await ctx.setup.checkPorts({ port: 15000, reliablePort: 15002 });
    assert.equal(clash.ok, false);
    assert.match(clash.errors.join(' '), /already used by the server "Other"/);
    assert.equal((await ctx.setup.checkPorts({ port: 15005, reliablePort: 15005 })).ok, false);
    const dir = path.join(tmpDir(), 'srv');
    await assert.rejects(ctx.setup.confirmLocation({ dir, name: 'New', branch: 'public', confirmed: true, port: 15000, reliablePort: 15010 }), (e) => e.code === 'E_PORT_CONFLICT');
    // The stand-in API occupies its port, so the assistant correctly refuses it as "in use".
    assert.equal((await ctx.setup.checkPorts({ port: fake.port, reliablePort: 15020 })).ok, false);
    await ctx.setup.confirmLocation({ dir, name: 'New', branch: 'public', confirmed: true, port: 15030, reliablePort: 15031 });
    let srv = ctx.setup.server;
    assert.equal(srv.config.launch.port, 15030);
    assert.equal(srv.config.launch.reliablePort, 15031);
    ctx.registry.patchInternal(srv.id, { launch: { port: fake.port } }); // point at the stand-in API
    srv = ctx.setup.server;
    ctx.supervisor._setStatus(srv.id, 'running', { readyAt: Date.now(), startedAt: Date.now(), pid: process.pid });
    const st = await ctx.setup.autoSecurity({});
    assert.ok(st.generatedPassword);
    assert.equal(st.verification.verified.security, true);
    assert.equal(st.verification.hasToken, true);
    assert.equal(fake.state.serverName, 'New');
  } finally { ctx.supervisor.dispose(); ctx.probe.dispose(); fake.server.close(); }
});

test('a different server certificate is refused before any credentials are sent', async () => {
  const fake = await fakeServerApi();
  const { ctx, srv } = build(fake.port);
  try {
    ctx.registry.patchInternal(srv.id, { api: { pin: 'AA:BB:CC' } });
    await assert.rejects(ctx.supervisor.api(srv.id).passwordlessLogin(), (e) => e.code === 'E_API_CERT_CHANGED');
    assert.equal(fake.state.calls.length, 0, 'nothing reached the server');
  } finally { done(ctx, fake); }
});
