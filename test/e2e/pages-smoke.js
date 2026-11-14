'use strict';
/**
 * Smoke test of every page of the main application (after first-run setup) in
 * the real Electron app: each route must render without load errors, uncaught
 * exceptions or console errors. Starts from a fresh data folder in which the
 * first-run flag is set (no servers configured — the honest empty state).
 *   node test/e2e/pages-smoke.js [screenshotDir]
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const { _electron } = require('playwright');
const { Database } = require('../../src/main/core/db');
const { Settings } = require('../../src/main/core/settings');

const ROOT = path.resolve(__dirname, '..', '..');
const SHOTS = process.argv[2] || path.join(ROOT, 'test-results');
fs.mkdirSync(SHOTS, { recursive: true });
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ssm-pages-'));
const db = new Database(path.join(DATA, 'manager.db'));
new Settings(db, null).update('general', { firstRunComplete: true });
db.close();

const ROUTES = ['dashboard', 'notifications', 'updates', 'scheduler', 'backups', 'mods', 'diagnostics', 'performance', 'storage', 'audit', 'profiles', 'profiles/templates', 'migration', 'remote', 'remote/agent', 'remote/web', 'settings', 'settings/startup', 'settings/backups', 'settings/updates', 'settings/monitoring', 'settings/security', 'settings/scheduler', 'settings/notifications', 'about'];

(async () => {
  const app = await _electron.launch({ executablePath: require(path.join(ROOT, 'node_modules', 'electron')), args: [ROOT, ...(process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : [])], env: { ...process.env, SSM_USER_DATA: DATA } });
  const win = await app.firstWindow();
  const problems = [];
  win.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  win.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await win.setViewportSize({ width: 1440, height: 900 });
  await win.locator('.sidebar').waitFor({ timeout: 20000 });
  try {
    for (const r of ROUTES) {
      await win.evaluate((h) => { location.hash = h; }, `#/${r}`);
      await win.waitForTimeout(900);
      const failed = await win.getByText('This page could not be loaded').count();
      const loading = await win.locator('.page > .muted', { hasText: 'Loading…' }).count();
      assert.equal(failed, 0, `route ${r} failed to load`);
      assert.equal(loading, 0, `route ${r} stuck loading`);
      console.log(`✔ ${r}`);
      if (['dashboard', 'settings/startup', 'remote/web', 'about', 'scheduler'].includes(r)) await win.screenshot({ path: path.join(SHOTS, `page-${r.replace(/\//g, '-')}.png`) });
    }
    // Notification drawer
    await win.locator('button.bell').click();
    await win.locator('.drawer.open').waitFor();
    console.log('✔ notification drawer');
    const relevant = problems.filter((p) => !/Failed to load resource/.test(p));
    assert.deepEqual(relevant, [], 'no renderer errors');
    console.log('Pages smoke test passed.');
  } finally { await app.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
