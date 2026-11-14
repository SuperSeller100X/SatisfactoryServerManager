'use strict';
/**
 * Application settings: typed defaults, persisted in the `settings` table as
 * JSON per top-level section. Every section has a validator so that updates
 * from the UI, web dashboard or remote clients are checked before saving.
 */
const { v } = require('./validate');

const localTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

const DEFAULTS = () => ({
  general: { firstRunComplete: false, closeToTray: true, confirmDangerous: true, language: 'en' },
  appearance: { theme: 'dark', accent: 'amber', density: 'comfortable', reduceMotion: false },
  startup: { launchAtLogin: false, startMinimized: true, autoStartServers: [], startDelaySeconds: 20, shutdownServersOnExit: true, shutdownGraceSeconds: 60 },
  notifications: {
    desktop: true,
    categories: {
      crash: true, startFailure: true, shutdown: false, backupOk: false, backupFailed: true,
      updateAvailable: true, updateOk: true, updateFailed: true, modIssue: true, installError: true,
      lowDisk: true, maintenance: true, recovery: true, scheduler: true, security: true,
    },
    keepDays: 90,
  },
  backups: { root: '', beforeUpdate: true, beforeRestore: true, beforeModChange: true, retentionEnabled: false, keepScheduled: 30, keepAutomatic: 20, maxAgeDays: 0, compressLevel: 6 },
  updates: { checkIntervalHours: 6, checkApp: true, autoServerUpdate: 'notify', autoModUpdate: 'notify', validateAfterUpdate: true, keepRollbackCopy: false, windowStart: '04:00', windowEnd: '06:00', windowDays: [0, 1, 2, 3, 4, 5, 6] },
  monitoring: { sampleSeconds: 5, apiPollSeconds: 15, keepRawHours: 48, keepHourlyDays: 90, cpuWarn: 85, memWarnPercent: 85, diskWarnGb: 15, unresponsiveSeconds: 60 },
  storage: { logRetentionDays: 0, diagnosticsRetentionDays: 0 },
  security: { allowWeakSecretStorage: false },
  web: { enabled: false, port: 8765, bind: 'localhost', sessionIdleMinutes: 30, allowRemoteControl: true },
  remote: { enabled: false, controllerEnabled: true },
  scheduler: { timezone: localTz(), missedRunGraceMinutes: 60 },
  diagnostics: { autoCollectOnCrash: true, includeServerLogLines: 400 },
  steam: { steamcmdDir: '' },
});

const bool = v.optional(v.bool());
const SCHEMAS = {
  general: v.object({ firstRunComplete: bool, closeToTray: bool, confirmDangerous: bool, language: v.optional(v.enum(['en'])) }),
  appearance: v.object({ theme: v.optional(v.enum(['dark', 'darker', 'system'])), accent: v.optional(v.enum(['amber', 'orange', 'cyan', 'violet', 'green'])), density: v.optional(v.enum(['comfortable', 'compact'])), reduceMotion: bool }),
  startup: v.object({ launchAtLogin: bool, startMinimized: bool, autoStartServers: v.optional(v.array(v.id(), { max: 100 })), startDelaySeconds: v.optional(v.int({ min: 0, max: 600 })), shutdownServersOnExit: bool, shutdownGraceSeconds: v.optional(v.int({ min: 5, max: 600 })) }),
  notifications: v.object({ desktop: bool, categories: v.optional(v.record(v.bool(), { maxKeys: 40 })), keepDays: v.optional(v.int({ min: 1, max: 3650 })) }),
  backups: v.object({ root: v.optional(v.oneOf(v.enum(['']), v.absPath())), beforeUpdate: bool, beforeRestore: bool, beforeModChange: bool, retentionEnabled: bool, keepScheduled: v.optional(v.int({ min: 1, max: 10000 })), keepAutomatic: v.optional(v.int({ min: 1, max: 10000 })), maxAgeDays: v.optional(v.int({ min: 0, max: 36500 })), compressLevel: v.optional(v.int({ min: 0, max: 9 })) }),
  updates: v.object({ checkIntervalHours: v.optional(v.int({ min: 1, max: 168 })), checkApp: bool, autoServerUpdate: v.optional(v.enum(['off', 'notify', 'window', 'scheduled'])), autoModUpdate: v.optional(v.enum(['off', 'notify', 'window', 'scheduled'])), validateAfterUpdate: bool, keepRollbackCopy: bool, windowStart: v.optional(v.string({ pattern: /^\d{2}:\d{2}$/ })), windowEnd: v.optional(v.string({ pattern: /^\d{2}:\d{2}$/ })), windowDays: v.optional(v.array(v.int({ min: 0, max: 6 }), { max: 7 })) }),
  monitoring: v.object({ sampleSeconds: v.optional(v.int({ min: 2, max: 300 })), apiPollSeconds: v.optional(v.int({ min: 5, max: 600 })), keepRawHours: v.optional(v.int({ min: 1, max: 720 })), keepHourlyDays: v.optional(v.int({ min: 1, max: 3650 })), cpuWarn: v.optional(v.int({ min: 1, max: 100 })), memWarnPercent: v.optional(v.int({ min: 1, max: 100 })), diskWarnGb: v.optional(v.int({ min: 1, max: 10000 })), unresponsiveSeconds: v.optional(v.int({ min: 10, max: 3600 })) }),
  storage: v.object({ logRetentionDays: v.optional(v.int({ min: 0, max: 3650 })), diagnosticsRetentionDays: v.optional(v.int({ min: 0, max: 3650 })) }),
  security: v.object({ allowWeakSecretStorage: bool }),
  web: v.object({ enabled: bool, port: v.optional(v.port()), bind: v.optional(v.enum(['localhost', 'lan'])), sessionIdleMinutes: v.optional(v.int({ min: 5, max: 1440 })), allowRemoteControl: bool }),
  remote: v.object({ enabled: bool, controllerEnabled: bool }),
  scheduler: v.object({ timezone: v.optional(v.timezone()), missedRunGraceMinutes: v.optional(v.int({ min: 0, max: 1440 })) }),
  diagnostics: v.object({ autoCollectOnCrash: bool, includeServerLogLines: v.optional(v.int({ min: 50, max: 5000 })) }),
  steam: v.object({ steamcmdDir: v.optional(v.oneOf(v.enum(['']), v.absPath())) }),
};

class Settings {
  constructor(db, bus) {
    this.db = db;
    this.bus = bus;
    this.cache = DEFAULTS();
    for (const row of db.all('SELECT key, value FROM settings')) {
      if (!this.cache[row.key]) continue;
      try { Object.assign(this.cache[row.key], JSON.parse(row.value)); } catch { /* ignore corrupt row; defaults remain */ }
    }
    // Merge nested category defaults for notifications so new categories appear.
    this.cache.notifications.categories = { ...DEFAULTS().notifications.categories, ...this.cache.notifications.categories };
  }
  get(section) { return section ? structuredClone(this.cache[section]) : structuredClone(this.cache); }
  update(section, patch) {
    if (!SCHEMAS[section]) throw new Error(`Unknown settings section: ${section}`);
    const clean = SCHEMAS[section](patch, section);
    const next = { ...this.cache[section], ...clean };
    if (clean.categories) next.categories = { ...this.cache[section].categories, ...clean.categories };
    this.cache[section] = next;
    this.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', section, JSON.stringify(next));
    if (this.bus) this.bus.publish('settings.changed', { section });
    return structuredClone(next);
  }
}

module.exports = { Settings, DEFAULTS, SCHEMAS };
