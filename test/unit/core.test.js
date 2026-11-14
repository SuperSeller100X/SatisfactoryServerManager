'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { makeCtx, tmpDir } = require('./helpers');
const { v } = require('../../src/main/core/validate');
const { Database, MIGRATIONS } = require('../../src/main/core/db');
const { parseVdf, getCI, extractAppInfo } = require('../../src/main/steam/vdf');
const { readAppManifest, PROGRESS_RE } = require('../../src/main/steam/steamcmd');
const { IniDocument } = require('../../src/main/server/ini');
const semver = require('../../src/main/features/semver');
const { parseCron, nextRun, describeCron } = require('../../src/main/features/scheduler');
const { buildPollRequest, parseStateResponse, MAGIC } = require('../../src/main/server/query');
const { createZip, extractZip, verifyZip, listZip } = require('../../src/main/core/zip');
const { safeJoin, isInside } = require('../../src/main/core/fsutil');
const { generateCertificate } = require('../../src/main/net/certs');
const auth = require('../../src/main/net/auth');
const { encryptFile, decryptFile } = require('../../src/main/features/migration');
const { parseLine, detectCrashReason } = require('../../src/main/server/supervisor');
const { diffConfigs, effectOf } = require('../../src/main/server/registry');
const { redact, redactText } = require('../../src/main/core/util');
const { inUpdateWindow, compareSemver } = require('../../src/main/features/updates');
const { parseGeneratedToken } = require('../../src/main/server/api-client');

test('validation rejects unknown keys, prototype pollution and bad types', () => {
  const s = v.object({ name: v.string({ max: 5 }), n: v.optional(v.int({ min: 1 })) });
  assert.deepEqual(s({ name: 'abc' }), { name: 'abc' });
  assert.throws(() => s({ name: 'abc', extra: 1 }), /unexpected property/);
  assert.throws(() => s({ name: 'toolong' }), /at most 5/);
  assert.throws(() => s({ name: 'a', n: 0 }), /between/);
  assert.throws(() => v.json()(JSON.parse('{"__proto__":{"x":1}}')), /forbidden key/);
  assert.throws(() => v.absPath()('relative/x'), /absolute/);
  assert.throws(() => v.timezone()('Not/AZone'), /time zone/);
});

test('database migrations apply once and are recorded', () => {
  const db = new Database(':memory:');
  assert.equal(db.currentVersion, MIGRATIONS.at(-1).version);
  assert.deepEqual(db.migrate(), []);
  const applied = db.migrate([...MIGRATIONS, { version: 99, name: 'test', sql: 'CREATE TABLE t99 (x)' }]);
  assert.deepEqual(applied, [99]);
  assert.throws(() => db.migrate([{ version: 100, name: 'broken', sql: 'CREATE TABL nope' }]), /migration 100/);
  assert.equal(db.currentVersion, 99, 'failed migration is rolled back');
});

test('VDF parsing of appmanifest and app_info_print output', async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'steamapps'));
  fs.writeFileSync(path.join(dir, 'steamapps', 'appmanifest_1690800.acf'), '"AppState"\n{\n\t"appid"\t\t"1690800"\n\t"buildid"\t\t"16994612"\n\t"StateFlags"\t\t"4"\n\t"LastUpdated"\t\t"1730000000"\n\t"MountedConfig"\n\t{\n\t\t"BetaKey"\t\t"experimental"\n\t}\n}\n');
  const m = await readAppManifest(dir);
  assert.equal(m.buildId, '16994612');
  assert.equal(m.branch, 'experimental');
  assert.equal(m.fullyInstalled, true);
  const out = 'Steam Console Client\nAppID : 1690800, change number : 1\n"1690800"\n{\n\t"common"\n\t{\n\t\t"name"\t\t"Satisfactory Dedicated Server"\n\t}\n\t"depots"\n\t{\n\t\t"branches"\n\t\t{\n\t\t\t"public"\n\t\t\t{\n\t\t\t\t"buildid"\t\t"16994612"\n\t\t\t\t"timeupdated"\t\t"1730000000"\n\t\t\t}\n\t\t\t"experimental"\n\t\t\t{\n\t\t\t\t"buildid"\t\t"17000001"\n\t\t\t}\n\t\t}\n\t}\n}\nUnloading Steam API...OK\n';
  const info = extractAppInfo(out, 1690800);
  assert.equal(getCI(info, 'depots', 'branches', 'experimental', 'buildid'), '17000001');
  assert.equal(parseVdf('"a" { "b" "c" }').a.b, 'c');
  const pm = PROGRESS_RE.exec(' Update state (0x61) downloading, progress: 12.34 (1234 / 10000)');
  assert.equal(pm[2], 'downloading'); assert.equal(pm[3], '12.34');
});

test('INI editor preserves unrelated content', () => {
  const doc = new IniDocument('; comment\n[/Script/Engine.GameSession]\nMaxPlayers=4\nOther=1\n\n[Other]\nX=2\n');
  doc.set('/Script/Engine.GameSession', 'MaxPlayers', '8');
  doc.set('/Script/FactoryGame.FGSaveSession', 'mNumRotatingAutosaves', '5');
  const out = doc.toString();
  assert.match(out, /MaxPlayers=8/); assert.match(out, /Other=1/); assert.match(out, /; comment/); assert.match(out, /\[Other\]\r\nX=2/);
  assert.match(out, /mNumRotatingAutosaves=5/);
  assert.throws(() => doc.set('S', 'k', 'a\nb'));
});

test('semver ranges and game-version compatibility', () => {
  assert.ok(semver.satisfies('3.12.0', '^3.10.0'));
  assert.ok(!semver.satisfies('4.0.0', '^3.10.0'));
  assert.ok(semver.satisfies('1.2.5', '~1.2.0'));
  assert.ok(semver.satisfies('2.0.0', '>=1.0.0 <3.0.0'));
  assert.ok(semver.satisfies('1.0.0-beta.2', '=1.0.0-beta.2'));
  assert.ok(semver.compare('1.0.0', '1.0.0-rc.1') > 0);
  assert.equal(semver.gameVersionOk('>=491125', 491125), true);
  assert.equal(semver.gameVersionOk('>=491125', 400000), false);
  assert.equal(semver.gameVersionOk('>=491125', null), null);
  assert.equal(compareSemver('1.0.0', '1.0.1'), -1);
});

test('cron schedules respect time zones and DST', () => {
  assert.throws(() => parseCron('* * *'), /5 fields/);
  assert.throws(() => parseCron('61 * * * *'), /out of range/);
  const base = Date.UTC(2026, 0, 15, 10, 30);
  assert.equal(new Date(nextRun('0 4 * * *', 'UTC', base)).toISOString(), '2026-01-16T04:00:00.000Z');
  assert.equal(new Date(nextRun('0 4 * * *', 'Europe/Berlin', base)).toISOString(), '2026-01-16T03:00:00.000Z');
  // Across the 2026-03-29 DST change Berlin moves to UTC+2.
  assert.equal(new Date(nextRun('0 4 * * *', 'Europe/Berlin', Date.UTC(2026, 2, 29, 0, 0))).toISOString(), '2026-03-29T02:00:00.000Z');
  assert.equal(new Date(nextRun('*/15 * * * *', 'UTC', base)).toISOString(), '2026-01-15T10:45:00.000Z');
  assert.equal(new Date(nextRun('0 5 * * mon', 'UTC', base)).toISOString(), '2026-01-19T05:00:00.000Z');
  assert.equal(describeCron('0 4 * * *'), 'Daily at 04:00');
  assert.equal(inUpdateWindow({ windowDays: [0, 1, 2, 3, 4, 5, 6], windowStart: '23:00', windowEnd: '02:00' }, 'UTC', Date.UTC(2026, 0, 15, 1, 0)), true);
  assert.equal(inUpdateWindow({ windowDays: [0, 1, 2, 3, 4, 5, 6], windowStart: '23:00', windowEnd: '02:00' }, 'UTC', Date.UTC(2026, 0, 15, 12, 0)), false);
});

test('lightweight query protocol encoding/decoding', () => {
  const req = buildPollRequest(0x0102030405060708n);
  assert.equal(req.readUInt16LE(0), MAGIC); assert.equal(req[2], 0); assert.equal(req[3], 1); assert.equal(req[12], 1);
  const name = Buffer.from('My Server');
  const res = Buffer.alloc(4 + 8 + 1 + 4 + 8 + 1 + 3 + 2 + name.length + 1);
  let o = 0; res.writeUInt16LE(MAGIC, o); o += 2; res[o++] = 1; res[o++] = 1; res.writeBigUInt64LE(42n, o); o += 8; res[o++] = 3; res.writeUInt32LE(491125, o); o += 4; res.writeBigUInt64LE(0n, o); o += 8; res[o++] = 1; res[o++] = 0; res.writeUInt16LE(7, o); o += 2; res.writeUInt16LE(name.length, o); o += 2; name.copy(res, o);
  const p = parseStateResponse(res);
  assert.equal(p.state, 'Playing'); assert.equal(p.netCL, 491125); assert.equal(p.name, 'My Server'); assert.equal(p.cookie, 42n);
});

test('zip round trip, CRC tamper detection and path traversal protection', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello world '.repeat(500));
  const zip = path.join(dir, 'x.zip');
  await createZip(zip, [{ abs: path.join(dir, 'a.txt'), name: 'saves/a.txt' }, { name: 'm.json', buffer: Buffer.from('{}') }]);
  assert.equal((await verifyZip(zip)).files, 2);
  const out = path.join(dir, 'out');
  await extractZip(zip, out);
  assert.equal(fs.readFileSync(path.join(out, 'saves', 'a.txt'), 'utf8').length, 6000);
  // Corrupt stored data: verification must fail.
  const stored = path.join(dir, 's.zip');
  await createZip(stored, [{ name: 'p.txt', buffer: Buffer.from('ABCDEFGHIJ'.repeat(10)) }], { level: 0 });
  const buf = fs.readFileSync(stored); const at = buf.indexOf('ABCDEFGHIJ'); buf[at] = 0x5a; fs.writeFileSync(stored, buf);
  await assert.rejects(verifyZip(stored), /CRC32 mismatch/);
  assert.throws(() => safeJoin(dir, '../evil.txt'), /unsafe/);
  assert.throws(() => safeJoin(dir, 'C:/Windows/x'), /unsafe/);
  assert.throws(() => safeJoin(dir, '/etc/passwd'), /unsafe/);
  assert.ok(isInside(dir, path.join(dir, 'a', 'b'))); assert.ok(!isInside(dir, path.join(dir, '..')));
  assert.equal((await listZip(zip)).length, 2);
});

test('self-signed certificate and authentication primitives', () => {
  const c = generateCertificate({ hosts: ['localhost', '127.0.0.1', '192.168.1.20'] });
  const x = new crypto.X509Certificate(c.certPem);
  assert.ok(x.verify(x.publicKey)); assert.match(x.subjectAltName, /192\.168\.1\.20/);
  const h = auth.hashPassword('correct horse battery');
  assert.ok(auth.verifyPassword('correct horse battery', h)); assert.ok(!auth.verifyPassword('wrong', h)); assert.ok(!h.includes('correct'));
  assert.deepEqual(auth.passwordProblems('short'), ['at least 12 characters']);
  const store = new auth.SessionStore({ idleMs: 50, absoluteMs: 1000 });
  const s = store.create({ id: 'u', username: 'a', role: 'viewer' }, '127.0.0.1');
  assert.equal(store.get(s.id).role, 'viewer'); assert.equal(store.get('forged'), null);
  const t = auth.newDeviceToken('dev_abc1');
  const parsed = auth.parseDeviceToken(t.token);
  assert.equal(parsed.secretHash, t.hash); assert.equal(auth.parseDeviceToken('ssmr_x.short'), null);
  for (const ip of ['127.0.0.1', '::1', '10.1.2.3', '192.168.0.4', '172.20.1.1', '::ffff:192.168.1.2', 'fd00::1']) assert.ok(auth.isPrivateAddress(ip), ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '2001:db8::1', '100.64.0.1']) assert.ok(!auth.isPrivateAddress(ip), ip);
  const rl = new auth.RateLimiter({ max: 2, windowMs: 1000 }); rl.fail('x'); rl.fail('x'); assert.ok(rl.blocked('x'));
  assert.match(auth.pairingCode(), /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
});

test('migration package encryption detects wrong passphrase and tampering', async () => {
  const dir = tmpDir();
  const src = path.join(dir, 'p.zip'); const enc = path.join(dir, 'p.ssmpkg'); const dec = path.join(dir, 'd.zip');
  const data = crypto.randomBytes(9 * 1024 * 1024 + 123);
  fs.writeFileSync(src, data);
  await encryptFile(src, enc, 'a strong passphrase');
  assert.ok(!fs.readFileSync(enc).includes(data.subarray(0, 64)));
  await assert.rejects(decryptFile(enc, dec, 'wrong passphrase'), /Wrong passphrase|damaged/);
  await decryptFile(enc, dec, 'a strong passphrase');
  assert.ok(fs.readFileSync(dec).equals(data));
  fs.rmSync(dec);
  const b = fs.readFileSync(enc); b[b.length - 100] ^= 1; fs.writeFileSync(enc, b);
  await assert.rejects(decryptFile(enc, dec, 'a strong passphrase'), /damaged|modified/);
  const t = fs.readFileSync(enc); fs.writeFileSync(enc, t.subarray(0, t.length - 5000));
  await assert.rejects(decryptFile(enc, dec, 'a strong passphrase'));
});

test('server log parsing and crash reason detection', () => {
  const l = parseLine('[2026.01.15-10.00.00:123][  0]LogNet: Warning: Something odd');
  assert.equal(l.level, 'warning'); assert.equal(l.category, 'LogNet'); assert.equal(l.message, 'Something odd');
  assert.equal(parseLine('[2026.01.15-10.00.00:123][  0]LogInit: Display: ready').level, 'info');
  assert.equal(detectCrashReason(['x', 'LowLevelFatalError [File:x] boom'], 1).reason.startsWith('Low-level fatal error'), true);
  assert.equal(detectCrashReason([], 3221225477).reason, 'Access violation (0xC0000005)');
  assert.match(detectCrashReason(['nothing'], 5).reason, /exited with code 5/);
});

test('configuration diff classifies restart / live / immediate effects', () => {
  const d = diffConfigs({ launch: { port: 7777 }, serverOptions: { 'FG.DSAutoPause': true }, recovery: { enabled: true }, api: { pin: 'a' } }, { launch: { port: 7778 }, serverOptions: { 'FG.DSAutoPause': false }, recovery: { enabled: false }, api: { pin: 'b' } });
  const byKey = Object.fromEntries(d.map((x) => [x.key, x.effect]));
  assert.equal(byKey['launch.port'], 'restart'); assert.equal(byKey['serverOptions.FG.DSAutoPause'], 'live'); assert.equal(byKey['recovery.enabled'], 'immediate');
  assert.equal(byKey['api.pin'], undefined, 'credentials/pins are never part of profiles or diffs');
  assert.equal(effectOf('ini.maxPlayers'), 'restart');
});

test('secret redaction in audit details and free text', () => {
  const r = redact({ adminPassword: 'x', nested: { token: 'y', name: 'ok' } });
  assert.equal(r.adminPassword, '[redacted]'); assert.equal(r.nested.token, '[redacted]'); assert.equal(r.nested.name, 'ok');
  assert.match(redactText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz'), /\[redacted\]/);
  assert.match(redactText('API Token: ey123.abc'), /\[redacted\]/);
  assert.equal(parseGeneratedToken('API Token: abcdefghijklmnopqrstuvwxyz0123'), 'abcdefghijklmnopqrstuvwxyz0123');
  const ctx = makeCtx();
  ctx.audit.record({ action: 'credentials.claim', details: { adminPassword: 'hunter22', serverName: 'S' } });
  const row = ctx.db.get('SELECT details FROM audit');
  assert.ok(!row.details.includes('hunter22'));
});

test('registry: port conflicts, overlapping folders, config history', () => {
  const ctx = makeCtx();
  const a = ctx.registry.create({ name: 'A', installDir: path.join(ctx.root, 'a') });
  assert.throws(() => ctx.registry.create({ name: 'B', installDir: path.join(ctx.root, 'b') }), /already used/);
  const b = ctx.registry.create({ name: 'B', installDir: path.join(ctx.root, 'b'), config: { launch: ctx.registry.suggestPorts() } });
  assert.notEqual(b.config.launch.port, a.config.launch.port);
  assert.throws(() => ctx.registry.create({ name: 'C', installDir: path.join(ctx.root, 'a', 'sub'), config: { launch: { port: 9000, reliablePort: 9001 } } }), /overlaps/);
  assert.throws(() => ctx.registry.update(a.id, { config: { launch: { extraArgs: ['-x; rm -rf /'] } } }), /invalid format/);
  const r = ctx.registry.update(a.id, { config: { ini: { maxPlayers: 8 } } });
  assert.equal(r.changes[0].effect, 'restart');
  assert.equal(ctx.registry.history(a.id).length, 1);
});

test('notifications respect de-duplication and read state', () => {
  const ctx = makeCtx();
  ctx.notifications.notify({ category: 'crash', severity: 'error', title: 'X crashed', body: 'b' });
  ctx.notifications.notify({ category: 'crash', severity: 'error', title: 'X crashed', body: 'b' });
  assert.equal(ctx.notifications.list().length, 1);
  assert.equal(ctx.notifications.unreadCount(), 1);
  ctx.notifications.markRead('all');
  assert.equal(ctx.notifications.unreadCount(), 0);
});
