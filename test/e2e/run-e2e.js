'use strict';
/**
 * End-to-end test of the first-launch experience in the real Electron app.
 *
 *   node test/e2e/run-e2e.js [screenshotDir]
 *
 * Uses Playwright's Electron driver (pre-installed in CI images; not a project
 * dependency). A fresh, temporary data folder is used via SSM_USER_DATA.
 * Steps: first launch → welcome → environment scan → folder validation and
 * confirmation → dependency setup (real SteamCMD download from Valve) →
 * server installation attempt → app closed mid-operation → relaunch →
 * interrupted-setup recovery is shown and the chosen folder is retained.
 *
 * Note: Linux containers running as root cannot use Chromium's OS sandbox, so
 * the harness passes --no-sandbox there. The renderer's own `sandbox: true`,
 * contextIsolation and CSP are unchanged.
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');

let playwright;
try { playwright = require('playwright'); } catch { console.error('Playwright is required for the e2e test (npm i -g playwright).'); process.exit(2); }
const { _electron } = playwright;

const ROOT = path.resolve(__dirname, '..', '..');
const SHOTS = process.argv[2] || path.join(ROOT, 'test-results');
fs.mkdirSync(SHOTS, { recursive: true });
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ssm-e2e-'));
const SERVERS = fs.mkdtempSync(path.join(os.tmpdir(), 'ssm-e2e-servers-'));
const extraArgs = process.platform === 'linux' && process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : [];

async function launch() {
  const app = await _electron.launch({ executablePath: require(path.join(ROOT, 'node_modules', 'electron')), args: [ROOT, ...extraArgs], cwd: ROOT, env: { ...process.env, SSM_USER_DATA: DATA } });
  const win = await app.firstWindow();
  const problems = [];
  win.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  win.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await win.setViewportSize({ width: 1440, height: 900 });
  return { app, win, problems };
}
const shot = (win, name) => win.screenshot({ path: path.join(SHOTS, `${name}.png`) });
const step = (name) => console.log(`• ${name}`);

(async () => {
  let { app, win, problems } = await launch();
  try {
    step('first launch shows the setup wizard');
    await win.getByText('Let’s set up your dedicated server').waitFor({ timeout: 20000 });
    await shot(win, 'wizard-1-welcome');
    await win.getByRole('button', { name: /Start setup/ }).click();

    step('environment scan lists real checks');
    await win.getByText('Checking this PC').waitFor();
    await win.locator('.check-item:not(.pending)').first().waitFor({ timeout: 30000 });
    const checks = await win.locator('.check-item b').allTextContents();
    for (const c of ['Operating system', 'Memory', 'Free disk space', 'SteamCMD']) assert.ok(checks.includes(c), `scan shows ${c}`);
    await shot(win, 'wizard-2-scan');
    await win.getByRole('button', { name: /^Continue/ }).click();

    step('folder validation rejects a non-empty folder');
    await win.getByText('Where should the server live?').waitFor();
    const busy = path.join(SERVERS, 'busy'); fs.mkdirSync(busy); fs.writeFileSync(path.join(busy, 'notes.txt'), 'user data');
    const dirInput = win.locator('input.mono').first();
    await dirInput.fill(busy);
    await win.getByText(/already contains other files/).waitFor();
    assert.equal(await win.getByRole('button', { name: /^Continue/ }).isDisabled(), true, 'cannot continue with an unsafe folder');

    step('a new folder is accepted only after explicit confirmation');
    const target = path.join(SERVERS, 'Server');
    await dirInput.fill(target);
    await win.getByText('This folder can be used.').waitFor();
    step('ports can be set directly; conflicts are explained');
    const portInputs = win.locator('input[type=number]');
    assert.equal(await portInputs.count(), 2, 'game and reliable port fields');
    await portInputs.nth(1).fill(await portInputs.nth(0).inputValue());
    await win.getByText('Game port and reliable port must be different.').waitFor();
    await win.getByRole('button', { name: /Use free ports/ }).click();
    await win.getByText('Ports are free.').waitFor();
    assert.equal(await win.getByRole('button', { name: /^Continue/ }).isDisabled(), true, 'confirmation checkbox required');
    await win.locator('label.check input[type=checkbox]').last().check();
    await shot(win, 'wizard-3-location');
    await win.getByRole('button', { name: /^Continue/ }).click();

    step('dependency setup downloads SteamCMD from Valve; app is closed mid-operation');
    await win.getByText('Preparing the tools').waitFor();
    await shot(win, 'wizard-4-dependencies');
    await win.getByRole('button', { name: /Install & continue|Continue/ }).click();
    const steamcmdExe = path.join(DATA, 'steamcmd', process.platform === 'win32' ? 'steamcmd.exe' : 'steamcmd.sh');
    for (let i = 0; i < 600 && !fs.existsSync(steamcmdExe); i++) await win.waitForTimeout(250);
    assert.ok(fs.existsSync(steamcmdExe), 'SteamCMD was downloaded from Valve and extracted');
    await shot(win, 'wizard-4b-dependencies-running');
    await app.close(); // SteamCMD self-update is still running: simulate the user closing the app / a crash

    step('relaunch: wizard resumes at the same step with recovery information');
    ({ app, win, problems } = await launch());
    await win.getByText('Preparing the tools').waitFor({ timeout: 20000 });
    await win.locator('.callout').filter({ hasText: /Setup was interrupted/ }).first().waitFor({ timeout: 10000 });
    await shot(win, 'wizard-6-recovery');

    step('earlier steps can be revisited; the chosen folder is retained');
    await win.locator('.wz-step', { hasText: 'Server folder' }).click();
    await win.getByText('Where should the server live?').waitFor();
    assert.equal(await win.locator('input.mono').first().inputValue(), target, 'chosen folder retained');
    assert.equal(await win.locator('.wz-step.done', { hasText: 'Check this PC' }).count(), 1, 'completed steps stay verified');
    await win.locator('.wz-step', { hasText: 'Prerequisites' }).click();
    await win.getByText('Preparing the tools').waitFor();
    assert.ok(await win.getByText('Installed in', { exact: false }).count() > 0, 'already-downloaded SteamCMD is not downloaded again');

    step('resume: either Steam is reachable (continue to install) or a clear offline error is shown');
    await win.getByRole('button', { name: /Install & continue|Continue/ }).click();
    const outcome = await Promise.race([
      win.getByText('Installing the dedicated server').waitFor({ timeout: 300000 }).then(() => 'online'),
      win.locator('.callout.err').filter({ hasText: /could not connect to Steam/ }).first().waitFor({ timeout: 300000 }).then(() => 'offline'),
    ]);
    console.log(`  Steam connectivity in this environment: ${outcome}`);
    await shot(win, outcome === 'online' ? 'wizard-5-install' : 'wizard-4c-offline-error');
    if (outcome === 'online') {
      step('server installation runs with real progress (cancelled after a few seconds)');
      await win.getByRole('button', { name: /Install server|Resume installation/ }).click();
      await win.locator('.big-progress').waitFor({ timeout: 60000 });
      await shot(win, 'wizard-5b-installing');
      await win.getByRole('button', { name: /Cancel/ }).click();
      await win.locator('.callout').filter({ hasText: /did not complete|cancelled/ }).first().waitFor({ timeout: 120000 });
    }

    assert.deepEqual(problems.filter((p) => !/Failed to load resource/.test(p)), [], 'no renderer errors');
    console.log(`\nE2E passed. Screenshots: ${SHOTS}`);
  } finally {
    await app.close().catch(() => {});
  }
})().catch((err) => { console.error(err); process.exit(1); });
