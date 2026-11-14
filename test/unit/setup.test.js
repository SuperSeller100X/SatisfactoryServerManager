'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeCtx, tmpDir } = require('./helpers');
const { Setup, MARKER } = require('../../src/main/features/setup');
const { Supervisor } = require('../../src/main/server/supervisor');
const { createProbe } = require('../../src/main/server/procstats');
const layout = require('../../src/main/server/layout');

/**
 * Stand-in for SteamCMD (test double): writes the same artefacts a real
 * `app_update 1690800 validate` produces (executable + appmanifest) and
 * reports progress, or fails/blocks on demand. The real SteamCmd class is
 * exercised separately for its parsing logic.
 */
class StubSteamCmd {
  constructor(dir) { this.dir = dir; this.installed = false; this.calls = []; this.mode = 'ok'; this.cancelled = false; }
  async status() { return { installed: this.installed, dir: this.dir, exe: path.join(this.dir, 'steamcmd.sh'), busy: false, lastRun: null, packageVersion: null }; }
  async ensureInstalled() { this.calls.push('ensureInstalled'); this.installed = true; return { downloaded: true }; }
  async selfUpdate() { this.calls.push('selfUpdate'); return this.offline ? { code: 8, offline: true, ok: false } : { code: 0, updated: true, offline: false, ok: true }; }
  cancel() { this.cancelled = true; if (this.release) this.release(); }
  async installApp(dir, { branch, onProgress, signal }) {
    this.calls.push(`installApp:${branch}`);
    fs.mkdirSync(path.join(dir, 'steamapps', 'downloading'), { recursive: true });
    onProgress({ state: 'downloading', percent: 42.5, done: 425, total: 1000 });
    if (this.mode === 'block') {
      await new Promise((r) => { this.release = r; if (signal) signal.addEventListener('abort', r, { once: true }); });
      throw new Error('SteamCMD terminated');
    }
    if (this.mode === 'fail') throw Object.assign(new Error('ERROR! Failed to install app (Disk write failure)'), { code: 'E_STEAM_INSTALL' });
    fs.rmSync(path.join(dir, 'steamapps', 'downloading'), { recursive: true, force: true });
    const exe = layout.serverExecutable(dir);
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, 'binary');
    const beta = branch && branch !== 'public' ? `\t"UserConfig"\n\t{\n\t\t"BetaKey"\t\t"${branch}"\n\t}\n` : '';
    fs.writeFileSync(layout.appManifest(dir), `"AppState"\n{\n\t"appid"\t\t"1690800"\n\t"buildid"\t\t"20491125"\n\t"StateFlags"\t\t"4"\n${beta}}\n`);
    return { code: 0, success: true, output: '', errors: [] };
  }
}

function build() {
  const ctx = makeCtx();
  ctx.steamcmd = new StubSteamCmd(ctx.paths.steamcmd);
  ctx.probe = createProbe();
  ctx.supervisor = new Supervisor(ctx);
  ctx.updates = { publishedBuilds: async () => ({ branches: { public: { buildId: '20491125' }, experimental: { buildId: '20500000' } } }) };
  ctx.access = { status: async () => null };
  ctx.setup = new Setup(ctx);
  return ctx;
}

test('fresh state starts at welcome and nothing is verified', async () => {
  const ctx = build();
  const st = await ctx.setup.state();
  assert.equal(st.step, 'welcome');
  assert.equal(st.verification.verified.install, false);
  assert.equal(st.verification.install.state, 'not-started');
  ctx.supervisor.dispose();
});

test('cannot skip ahead past incomplete steps', async () => {
  const ctx = build();
  await assert.rejects(ctx.setup.goTo('install'), (e) => e.code === 'E_STEP_INCOMPLETE');
  ctx.supervisor.dispose();
});

test('scan reports real system checks and a suggested folder', async () => {
  const ctx = build();
  const r = await ctx.setup.scan();
  assert.ok(r.checks.find((c) => c.key === 'os'));
  assert.ok(r.checks.find((c) => c.key === 'disk'));
  assert.ok(path.isAbsolute(r.suggested));
  ctx.supervisor.dispose();
});

test('location validation rejects unsafe folders and non-empty folders', async () => {
  const ctx = build();
  const inApp = await ctx.setup.validateLocation(path.join(ctx.paths.appInstallDir, 'srv'));
  assert.equal(inApp.ok, false);
  assert.match(inApp.errors.join(' '), /program folder/);
  const rel = await ctx.setup.validateLocation('relative/dir');
  assert.equal(rel.ok, false);
  const busy = tmpDir();
  fs.writeFileSync(path.join(busy, 'something.txt'), 'x');
  const r = await ctx.setup.validateLocation(busy);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /already contains other files/);
  const fresh = path.join(tmpDir(), 'new-server');
  assert.equal((await ctx.setup.validateLocation(fresh)).ok, true);
  ctx.supervisor.dispose();
});

test('confirmation is required, then server is registered and marker written', async () => {
  const ctx = build();
  const dir = path.join(tmpDir(), 'srv');
  await assert.rejects(ctx.setup.confirmLocation({ dir, name: 'A', branch: 'public', confirmed: false }), (e) => e.code === 'E_CONFIRM_REQUIRED');
  const st = await ctx.setup.confirmLocation({ dir, name: 'My Server', branch: 'experimental', confirmed: true });
  assert.ok(st.serverId);
  assert.ok(fs.existsSync(path.join(dir, MARKER)));
  const srv = ctx.registry.get(st.serverId);
  assert.equal(srv.config.branch, 'experimental');
  assert.equal(srv.installDir, path.resolve(dir));
  ctx.supervisor.dispose();
});

test('full install path, then re-running install does not download again', async () => {
  const ctx = build();
  const dir = path.join(tmpDir(), 'srv');
  await ctx.setup.scan();
  await ctx.setup.confirmLocation({ dir, name: 'S', branch: 'public', confirmed: true });
  await ctx.setup.installDependencies({});
  assert.deepEqual(ctx.steamcmd.calls, ['ensureInstalled', 'selfUpdate']);
  const r = await ctx.setup.installServer({});
  assert.equal(r.buildId, '20491125');
  assert.equal(fs.existsSync(path.join(dir, MARKER)), false, 'marker removed once a real installation exists');
  const again = await ctx.setup.installServer({});
  assert.equal(again.skipped, true);
  assert.equal(ctx.steamcmd.calls.filter((c) => c.startsWith('installApp')).length, 1);
  const v = await ctx.setup.verify();
  assert.equal(v.verified.install, true);
  // A reloaded engine (app restart) still verifies the completed install from disk.
  const reloaded = new Setup(ctx);
  assert.equal((await reloaded.verify()).verified.install, true);
  ctx.supervisor.dispose();
});

test('offline SteamCMD self-update is a clear failure, not a silent success', async () => {
  const ctx = build();
  ctx.steamcmd.offline = true;
  await assert.rejects(ctx.setup.installDependencies({}), (e) => e.code === 'E_STEAMCMD_OFFLINE');
  const st = await ctx.setup.state();
  assert.equal(st.verification.verified.dependencies, false);
  assert.match(st.lastError.message, /internet connection/);
  ctx.steamcmd.offline = false;
  await ctx.setup.installDependencies({});
  assert.equal((await ctx.setup.verify()).verified.dependencies, true);
  ctx.supervisor.dispose();
});

test('partial installation is detected and resumed', async () => {
  const ctx = build();
  const dir = path.join(tmpDir(), 'srv');
  await ctx.setup.confirmLocation({ dir, name: 'S', branch: 'public', confirmed: true });
  fs.mkdirSync(path.join(dir, 'steamapps', 'downloading'), { recursive: true });
  fs.writeFileSync(layout.appManifest(dir), '"AppState"\n{\n\t"appid"\t\t"1690800"\n\t"buildid"\t\t"1"\n\t"StateFlags"\t\t"1026"\n}\n');
  const v = await ctx.setup.verify();
  assert.equal(v.install.state, 'partial');
  await ctx.setup.installServer({});
  assert.equal((await ctx.setup.verify()).install.state, 'complete');
  ctx.supervisor.dispose();
});

test('failed install records a plain-language error and stays resumable', async () => {
  const ctx = build();
  const dir = path.join(tmpDir(), 'srv');
  await ctx.setup.confirmLocation({ dir, name: 'S', branch: 'public', confirmed: true });
  ctx.steamcmd.mode = 'fail';
  await assert.rejects(ctx.setup.installServer({}));
  const st = await ctx.setup.state();
  assert.match(st.lastError.message, /ran out of free space/);
  assert.equal(st.activeOperation, null);
  assert.equal(st.verification.install.state, 'partial');
  ctx.steamcmd.mode = 'ok';
  await ctx.setup.installServer({});
  assert.equal((await ctx.setup.verify()).install.state, 'complete');
  ctx.supervisor.dispose();
});

test('cancel stops a running install safely', async () => {
  const ctx = build();
  const dir = path.join(tmpDir(), 'srv');
  await ctx.setup.confirmLocation({ dir, name: 'S', branch: 'public', confirmed: true });
  ctx.steamcmd.mode = 'block';
  const p = ctx.setup.installServer({});
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await ctx.setup.state()).running, true);
  await assert.rejects(ctx.setup.goTo('location'), (e) => e.code === 'E_BUSY');
  ctx.setup.cancel();
  await assert.rejects(p, (e) => e.code === 'E_CANCELLED');
  const st = await ctx.setup.state();
  assert.equal(st.running, false);
  assert.equal(st.lastError.code, 'E_CANCELLED');
  ctx.supervisor.dispose();
});

test('interrupted operation (app closed mid-install) is detected after restart', async () => {
  const ctx = build();
  const dir = path.join(tmpDir(), 'srv');
  await ctx.setup.confirmLocation({ dir, name: 'S', branch: 'public', confirmed: true });
  ctx.steamcmd.mode = 'block';
  ctx.setup.installServer({}).catch(() => {});
  await new Promise((r) => setTimeout(r, 50));
  // Simulate the process dying: a new engine instance loads the persisted state.
  const after = new Setup(ctx);
  const st = await after.state();
  assert.equal(st.interrupted.kind, 'install');
  assert.equal(st.activeOperation, null);
  assert.equal(st.verification.install.state, 'partial');
  assert.equal(st.serverId, ctx.setup.s.serverId, 'server choice survives the restart');
  ctx.setup.cancel();
  ctx.steamcmd.mode = 'ok';
  await after.installServer({});
  assert.equal((await after.state()).interrupted, undefined);
  ctx.supervisor.dispose();
});

test('cleanup removes only folders created by the wizard and never a complete install', async () => {
  const ctx = build();
  const dir = path.join(tmpDir(), 'srv');
  await ctx.setup.confirmLocation({ dir, name: 'S', branch: 'public', confirmed: true });
  ctx.steamcmd.mode = 'fail';
  await assert.rejects(ctx.setup.installServer({}));
  await assert.rejects(ctx.setup.cleanup({ confirm: false }), (e) => e.code === 'E_CONFIRM_REQUIRED');
  await ctx.setup.cleanup({ confirm: true });
  assert.equal(fs.existsSync(dir), false);
  assert.equal(ctx.registry.list().length, 0);

  // Attached (pre-existing) folder: never deleted.
  const ctx2 = build();
  const dir2 = tmpDir();
  fs.mkdirSync(path.dirname(layout.serverExecutable(dir2)), { recursive: true });
  fs.writeFileSync(layout.serverExecutable(dir2), 'x');
  await ctx2.setup.confirmLocation({ dir: dir2, name: 'Existing', branch: 'public', mode: 'attach', confirmed: true });
  await assert.rejects(ctx2.setup.cleanup({ confirm: true }), (e) => e.code === 'E_NOT_OWNED');
  assert.ok(fs.existsSync(layout.serverExecutable(dir2)));
  ctx.supervisor.dispose(); ctx2.supervisor.dispose();
});

test('existing installation is attached instead of downloaded', async () => {
  const ctx = build();
  const dir = tmpDir();
  await ctx.steamcmd.installApp(dir, { branch: 'public', onProgress: () => {} });
  ctx.steamcmd.calls = [];
  const st = await ctx.setup.confirmLocation({ dir, name: 'Existing', branch: 'public', mode: 'new', confirmed: true });
  assert.equal(st.location.mode, 'attach');
  const r = await ctx.setup.installServer({});
  assert.equal(r.skipped, true);
  assert.equal(ctx.steamcmd.calls.length, 0);
  ctx.supervisor.dispose();
});

test('branch mismatch is reported as partial so files get switched', async () => {
  const ctx = build();
  const dir = path.join(tmpDir(), 'srv');
  await ctx.setup.confirmLocation({ dir, name: 'S', branch: 'public', confirmed: true });
  await ctx.setup.installServer({});
  await ctx.setup.confirmLocation({ dir, name: 'S', branch: 'experimental', confirmed: true });
  const v = await ctx.setup.verify();
  assert.equal(v.install.state, 'partial');
  assert.match(v.install.reason, /branch/);
  ctx.supervisor.dispose();
});

test('finish requires a verified installation and marks first run complete', async () => {
  const ctx = build();
  const dir = path.join(tmpDir(), 'srv');
  await ctx.setup.confirmLocation({ dir, name: 'S', branch: 'public', confirmed: true });
  await assert.rejects(ctx.setup.finish({}), (e) => e.code === 'E_STEP_INCOMPLETE');
  await ctx.setup.installServer({});
  await ctx.setup.finish({ autoStart: true });
  assert.equal(ctx.settings.get('general').firstRunComplete, true);
  assert.deepEqual(ctx.settings.get('startup').autoStartServers, [ctx.setup.s.serverId]);
  ctx.supervisor.dispose();
});
