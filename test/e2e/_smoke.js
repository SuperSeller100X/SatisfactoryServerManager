const { _electron } = require('playwright');
const path = require('path'); const fs = require('fs'); const os = require('os');
(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ssm-smoke-'));
  const app = await _electron.launch({ executablePath: require(path.resolve('node_modules/electron')), args: ['.', '--no-sandbox'], cwd: process.cwd(), env: { ...process.env, SSM_USER_DATA: data } });
  const win = await app.firstWindow();
  const errors = [];
  win.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
  win.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  await win.setViewportSize({ width: 1440, height: 900 });
  await win.waitForTimeout(3000);
  await win.screenshot({ path: process.argv[2] + '/smoke-welcome.png' });
  console.log('title', await win.title());
  console.log('errors', JSON.stringify(errors, null, 1));
  await app.close();
})().catch((e) => { console.error(e); process.exit(1); });
