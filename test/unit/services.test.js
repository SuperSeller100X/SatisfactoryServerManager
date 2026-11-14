'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { makeCtx, tmpDir } = require('./helpers');
const layout = require('../../src/main/server/layout');
const { Supervisor } = require('../../src/main/server/supervisor');
const { createProbe } = require('../../src/main/server/procstats');
const { Backups } = require('../../src/main/features/backups');
const { Scheduler } = require('../../src/main/features/scheduler');
const { Rpc } = require('../../src/main/rpc');
const { WebServer } = require('../../src/main/net/webserver');
const { sleep } = require('../../src/main/core/util');

const linuxOnly = { skip: process.platform === 'win32' ? 'uses a POSIX shell script as the server executable' : false };

/** Install a shell script at the server executable path (test stand-in for FactoryServer). */
function fakeServerBinary(dir, body) {
  const exe = layout.serverExecutable(dir);
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return exe;
}

function supervisorCtx() {
  const ctx = makeCtx();
  ctx.probe = createProbe();
  ctx.supervisor = new Supervisor(ctx);
  return ctx;
}

test('supervisor runs a process, captures console, detects crash and prevents restart loops', linuxOnly, async () => {
  const ctx = supervisorCtx();
  const dir = path.join(ctx.root, 'srv');
  fakeServerBinary(dir, 'echo "[2026.01.15-10.00.00:000][  0]LogInit: Display: starting"\necho "[2026.01.15-10.00.00:001][  0]LogCore: Error: Assertion failed: something broke"\nexit 3');
  const srv = ctx.registry.create({ name: 'Crashy', installDir: dir, config: { launch: { port: 47777, reliablePort: 48888 }, recovery: { enabled: true, maxAttempts: 2, windowMinutes: 5, cooldownSeconds: 5, backoffMultiplier: 1 } } });
  // Shorten the cooldown for the test by patching the stored config directly.
  ctx.registry.patchInternal(srv.id, { recovery: { cooldownSeconds: 0.05 } });
  await ctx.supervisor.start(srv.id);
  for (let i = 0; i < 100 && ctx.db.all('SELECT * FROM crashes').length < 3; i++) await sleep(100);
  const crashes = ctx.db.all('SELECT * FROM crashes ORDER BY id');
  assert.equal(crashes.length, 3, 'initial crash + 2 automatic restarts');
  assert.match(crashes[0].reason, /Assertion failed/);
  assert.match(crashes.at(-1).recovery, /Restart loop prevented/);
  const runs = ctx.db.all('SELECT * FROM runs ORDER BY id');
  assert.equal(runs[0].exit_code, 3);
  assert.deepEqual(runs.map((r) => r.trigger), ['manual', 'recovery', 'recovery']);
  assert.ok(fs.readFileSync(runs[0].log_path, 'utf8').includes('Assertion failed'), 'per-run console history persisted');
  assert.ok(ctx.notifications.list().some((n) => /automatic recovery halted/.test(n.title)));
  assert.equal(ctx.supervisor.status(srv.id).status, 'crashed');
  ctx.supervisor.dispose(); ctx.probe.dispose();
});

test('supervisor stops a running process gracefully (SIGINT) and records shutdown', linuxOnly, async () => {
  const ctx = supervisorCtx();
  const dir = path.join(ctx.root, 'srv');
  fakeServerBinary(dir, 'trap "echo bye; exit 0" INT\necho running\nwhile true; do sleep 0.1; done');
  const srv = ctx.registry.create({ name: 'Stable', installDir: dir, config: { launch: { port: 47779, reliablePort: 48889 } } });
  await ctx.supervisor.start(srv.id);
  await sleep(500);
  assert.ok(ctx.supervisor.isActive(srv.id));
  const lines = ctx.supervisor.consoleSnapshot(srv.id);
  assert.ok(lines.some((l) => l.text === 'running'));
  assert.ok(lines.some((l) => l.src === 'sys'), 'system messages are separated from server output');
  await ctx.supervisor.stop(srv.id, { reason: 'test' });
  assert.equal(ctx.supervisor.status(srv.id).status, 'stopped');
  const run = ctx.db.get('SELECT * FROM runs');
  assert.equal(run.outcome, 'stopped');
  assert.ok(run.stop_requested_at && run.ended_at);
  assert.equal(ctx.db.all('SELECT * FROM crashes').length, 0);
  ctx.supervisor.dispose(); ctx.probe.dispose();
});

test('backups: create, validate, detect tampering, restore with restore point', async () => {
  const ctx = makeCtx();
  ctx.supervisor = { isActive: () => false };
  ctx.backups = new Backups(ctx);
  const dir = path.join(ctx.root, 'srv');
  const saveRoot = path.join(ctx.root, 'saves');
  fs.mkdirSync(path.join(saveRoot, 'server', 'MySession'), { recursive: true });
  fs.writeFileSync(path.join(saveRoot, 'server', 'MySession', 'world.sav'), 'ORIGINAL'.repeat(100));
  fs.writeFileSync(path.join(saveRoot, 'ServerSettings.7777.sav'), 'settings');
  const srv = ctx.registry.create({ name: 'S', installDir: dir, config: { saveRoot } });
  const b = await ctx.backups.create(srv.id, { note: 'test' });
  assert.equal(b.status, 'valid'); assert.equal(b.files, 3);
  assert.equal((await ctx.backups.validate(b.id)).ok, true);
  fs.writeFileSync(path.join(saveRoot, 'server', 'MySession', 'world.sav'), 'CHANGED');
  await assert.rejects(ctx.backups.restore(b.id, {}), (e) => e.code === 'E_CONFIRM_REQUIRED');
  const r = await ctx.backups.restore(b.id, { confirm: true });
  assert.ok(r.restorePointId);
  assert.equal(fs.readFileSync(path.join(saveRoot, 'server', 'MySession', 'world.sav'), 'utf8'), 'ORIGINAL'.repeat(100));
  const rp = ctx.backups.get(r.restorePointId);
  assert.equal(rp.type, 'pre-restore');
  // Tamper with the archive: validation must fail and restore must refuse it.
  const buf = fs.readFileSync(b.path); buf[Math.floor(buf.length / 2)] ^= 0xff; fs.writeFileSync(b.path, buf);
  const v = await ctx.backups.validate(b.id);
  assert.equal(v.ok, false);
  await assert.rejects(ctx.backups.restore(b.id, { confirm: true }), (e) => e.code === 'E_BACKUP_INVALID');
  // Rotation only with an explicit policy; manual backups are never rotated.
  ctx.settings.update('backups', { retentionEnabled: true, keepAutomatic: 1, keepScheduled: 1 });
  assert.equal((await ctx.backups.applyRetention(srv.id)).deleted, 0);
  assert.ok(ctx.backups.list({ serverId: srv.id }).some((x) => x.type === 'manual'));
});

test('scheduler runs due tasks, records history and handles missed runs after restart', async () => {
  const ctx = makeCtx();
  const sch = new Scheduler(ctx);
  let ran = 0;
  sch.register('cleanup', async () => { ran++; return { message: 'done' }; });
  const t = sch.create({ name: 'Cleanup', type: 'cleanup', cron: '*/5 * * * *', timezone: 'UTC' });
  assert.ok(t.nextRun > Date.now());
  const r = await sch.runNow(t.id);
  assert.equal(r.status, 'ok'); assert.equal(ran, 1);
  // Simulate the app having been closed while a run was due 10 minutes ago.
  ctx.db.run('UPDATE tasks SET next_run = ? WHERE id = ?', Date.now() - 10 * 60000, t.id);
  const sch2 = new Scheduler(ctx);
  sch2.register('cleanup', async () => { ran++; return { message: 'missed run executed' }; });
  sch2.start();
  await sleep(100);
  assert.equal(ran, 2, 'missed run within grace window executes once');
  // Outside the grace window it is recorded as missed instead.
  ctx.db.run('UPDATE tasks SET next_run = ? WHERE id = ?', Date.now() - 5 * 3600000, t.id);
  const sch3 = new Scheduler(ctx); sch3.register('cleanup', async () => { ran++; }); sch3.start();
  await sleep(50);
  assert.equal(ran, 2);
  assert.ok(sch3.history(t.id).some((h) => h.status === 'missed'));
  sch.stop(); sch2.stop(); sch3.stop();
  assert.throws(() => sch.create({ name: 'x', type: 'restart', cron: '0 4 * * *', timezone: 'UTC' }), /needs a server/);
});

test('RPC authorisation: desktop vs web roles vs remote scopes, and input validation', async () => {
  const ctx = makeCtx();
  const rpc = new Rpc(ctx);
  await assert.rejects(rpc.dispatch('nope', {}, { transport: 'ipc' }), (e) => e.code === 'E_NOT_FOUND');
  await assert.rejects(rpc.dispatch('setup.state', {}, { transport: 'web', role: 'admin' }), (e) => e.code === 'E_FORBIDDEN');
  await assert.rejects(rpc.dispatch('servers.start', { serverId: 'x' }, { transport: 'web', role: 'viewer' }), (e) => e.code === 'E_FORBIDDEN');
  await assert.rejects(rpc.dispatch('access.setToken', { serverId: 'x', token: 'a'.repeat(30) }, { transport: 'remote', scopes: ['read', 'control', 'configure'] }), (e) => e.code === 'E_FORBIDDEN');
  await assert.rejects(rpc.dispatch('servers.start', { serverId: '../../etc' }, { transport: 'ipc' }), (e) => e.code === 'E_VALIDATION');
  await assert.rejects(rpc.dispatch('servers.list', {}, { transport: 'unknown' }), (e) => e.code === 'E_FORBIDDEN');
  const list = await rpc.dispatch('servers.list', undefined, { transport: 'web', role: 'viewer' });
  assert.deepEqual(list, []);
});

/**
 * HTTPS request that authenticates the server by its pinned SHA-256 certificate
 * fingerprint — the same method the remote-management client uses (works on
 * both OpenSSL and Electron's BoringSSL, which rejects self-signed leaf certs as CA).
 */
function request(port, method, p, { body, headers = {}, ca: pin } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = https.request({ host: '127.0.0.1', port, method, path: p, agent: false, rejectUnauthorized: false, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      if (res.socket.getPeerCertificate().fingerprint256 !== pin) { reject(new Error('certificate pin mismatch')); req.destroy(); return; }
      let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: t ? JSON.parse(t) : null }));
    });
    req.on('error', reject); req.end(data);
  });
}

test('web dashboard: TLS, login, session cookie, CSRF, roles; remote pairing and revocation', async () => {
  const ctx = makeCtx();
  ctx.rpc = new Rpc(ctx);
  ctx.web = new WebServer(ctx);
  const port = 40000 + Math.floor(Math.random() * 20000);
  ctx.settings.update('web', { enabled: true, port, bind: 'localhost' });
  ctx.settings.update('remote', { enabled: true });
  const info = await ctx.web.apply();
  try {
    const ca = info.fingerprint; // server authenticated by certificate pin
    assert.ok(info.running);
    const page = await request(port, 'GET', '/api/session', { ca });
    assert.equal(page.json.authenticated, false);
    assert.match(page.headers['content-security-policy'], /script-src 'self'/);
    assert.throws(() => ctx.web.addUser({ username: 'admin', password: 'short', role: 'admin' }), /12 characters/);
    ctx.web.addUser({ username: 'admin', password: 'a-very-long-password', role: 'admin' });
    ctx.web.addUser({ username: 'viewer', password: 'another-long-password', role: 'viewer' });
    const bad = await request(port, 'POST', '/api/login', { ca, body: { username: 'admin', password: 'wrong' } });
    assert.equal(bad.status, 401);
    const ok = await request(port, 'POST', '/api/login', { ca, body: { username: 'admin', password: 'a-very-long-password' } });
    assert.equal(ok.status, 200);
    const cookie = ok.headers['set-cookie'][0].split(';')[0];
    assert.match(ok.headers['set-cookie'][0], /HttpOnly/); assert.match(ok.headers['set-cookie'][0], /SameSite=Strict/); assert.match(ok.headers['set-cookie'][0], /Secure/);
    const noCsrf = await request(port, 'POST', '/api/rpc', { ca, headers: { cookie }, body: { channel: 'servers.list' } });
    assert.equal(noCsrf.status, 403);
    const crossOrigin = await request(port, 'POST', '/api/rpc', { ca, headers: { cookie, 'x-csrf-token': ok.json.csrf, origin: 'https://evil.example' }, body: { channel: 'servers.list' } });
    assert.equal(crossOrigin.status, 403);
    const good = await request(port, 'POST', '/api/rpc', { ca, headers: { cookie, 'x-csrf-token': ok.json.csrf }, body: { channel: 'servers.list' } });
    assert.equal(good.status, 200); assert.deepEqual(good.json.result, []);
    const local = await request(port, 'POST', '/api/rpc', { ca, headers: { cookie, 'x-csrf-token': ok.json.csrf }, body: { channel: 'web.status' } });
    assert.equal(local.status, 403, 'desktop-only channels are not reachable from the browser');
    const static_ = await request(port, 'GET', '/../../package.json', { ca });
    assert.equal(static_.status, 404);
    // Remote management pairing.
    const noCode = await request(port, 'POST', '/remote/v1/pair', { ca, body: { code: 'AAAAA-BBBBB' } });
    assert.equal(noCode.status, 401);
    const { code } = ctx.web.createPairingCode();
    const paired = await request(port, 'POST', '/remote/v1/pair', { ca, body: { code, deviceName: 'Laptop' } });
    assert.equal(paired.status, 200);
    const again = await request(port, 'POST', '/remote/v1/pair', { ca, body: { code } });
    assert.equal(again.status, 401, 'pairing codes are single-use');
    const auth = { authorization: `Bearer ${paired.json.token}` };
    const ping = await request(port, 'GET', '/remote/v1/ping', { ca, headers: auth });
    assert.equal(ping.status, 200);
    const rpcRes = await request(port, 'POST', '/remote/v1/rpc', { ca, headers: auth, body: { channel: 'servers.list', payload: {} } });
    assert.deepEqual(rpcRes.json.result, []);
    const forbidden = await request(port, 'POST', '/remote/v1/rpc', { ca, headers: auth, body: { channel: 'web.addUser', payload: { username: 'x', password: 'y', role: 'admin' } } });
    assert.equal(forbidden.status, 403);
    assert.ok(!JSON.stringify(ctx.db.all('SELECT * FROM remote_devices')).includes(paired.json.token.split('.')[1]), 'device token stored only as a hash');
    ctx.web.revokeDevice(paired.json.deviceId);
    const revoked = await request(port, 'GET', '/remote/v1/ping', { ca, headers: auth });
    assert.equal(revoked.status, 401);
    assert.ok(ctx.audit.list({ action: 'remote' }).length >= 2);
  } finally { await ctx.web.stop(); }
});
