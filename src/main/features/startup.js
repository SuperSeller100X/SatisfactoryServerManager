'use strict';
/**
 * Windows startup / shutdown integration.
 *  - Launch at login via Electron login items (per-user Run key), opt-in only.
 *  - Auto-start selected servers in a configured order with a delay between them.
 *  - On Windows session end (shutdown/log-off) or app quit, stop servers
 *    gracefully within the configured grace period.
 */
class Startup {
  constructor(ctx, app) { this.ctx = ctx; this.app = app; }

  status() {
    const s = this.ctx.settings.get('startup');
    let login = { openAtLogin: false };
    try { login = this.app.getLoginItemSettings({ args: ['--startup'] }); } catch { /* unsupported platform */ }
    return { ...s, loginItem: { openAtLogin: !!login.openAtLogin, supported: process.platform === 'win32' || process.platform === 'darwin' } };
  }

  /** Apply launch-at-login. Called only after the user enabled it in the UI. */
  setLaunchAtLogin(enabled, actor = 'local') {
    if (process.platform === 'win32' || process.platform === 'darwin') this.app.setLoginItemSettings({ openAtLogin: enabled, args: ['--startup'] });
    this.ctx.settings.update('startup', { launchAtLogin: enabled });
    this.ctx.audit.record({ actor, action: 'startup.login-item', details: { enabled } });
    return this.status();
  }

  async autoStart() {
    const s = this.ctx.settings.get('startup');
    const order = s.autoStartServers.filter((id) => this.ctx.registry.find(id));
    for (let i = 0; i < order.length; i++) {
      const id = order[i];
      const srv = this.ctx.registry.find(id);
      if (!srv || this.ctx.supervisor.isActive(id) || srv.config.maintenance.enabled) continue;
      try { await this.ctx.supervisor.start(id, { trigger: 'autostart', actor: 'system' }); } catch (err) {
        this.ctx.notifications.notify({ category: 'startFailure', severity: 'error', title: `Automatic start failed: ${srv.name}`, body: err.message, serverId: id });
      }
      if (i < order.length - 1) await new Promise((r) => setTimeout(r, s.startDelaySeconds * 1000));
    }
  }
}

module.exports = { Startup };
