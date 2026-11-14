'use strict';
/**
 * Notification center: persisted history, read/unread state, per-category
 * preferences and native desktop notifications (Windows toast via Electron).
 */
const CATEGORIES = {
  crash: 'Server crashes', startFailure: 'Startup failures', shutdown: 'Server shutdowns',
  backupOk: 'Completed backups', backupFailed: 'Failed backups', updateAvailable: 'Available updates',
  updateOk: 'Completed updates', updateFailed: 'Failed updates', modIssue: 'Mod incompatibilities',
  installError: 'Installation errors', lowDisk: 'Low disk space', maintenance: 'Maintenance events',
  recovery: 'Recovery operations', scheduler: 'Scheduled task failures', security: 'Security events',
};

class Notifications {
  constructor({ db, bus, settings, NativeNotification, log }) {
    this.db = db; this.bus = bus; this.settings = settings; this.Native = NativeNotification; this.log = log;
    this.onClick = null;
    this.recent = new Map(); // de-duplication of identical notifications within a short window
  }
  notify({ category, severity = 'info', title, body = '', serverId = null }) {
    if (!CATEGORIES[category]) category = 'maintenance';
    const key = `${category}|${serverId}|${title}|${body}`;
    const now = Date.now();
    if (this.recent.has(key) && now - this.recent.get(key) < 30000) return null;
    this.recent.set(key, now);
    if (this.recent.size > 200) for (const [k, t] of this.recent) if (now - t > 60000) this.recent.delete(k);

    const prefs = this.settings.get('notifications');
    const info = this.db.run('INSERT INTO notifications (ts, category, severity, title, body, server_id) VALUES (?, ?, ?, ?, ?, ?)', now, category, severity, title, body, serverId);
    const item = { id: Number(info.lastInsertRowid), ts: now, category, severity, title, body, server_id: serverId, read: 0 };
    this.bus.publish('notification.new', item);
    if (prefs.desktop && prefs.categories[category] !== false && this.Native && this.Native.isSupported()) {
      try {
        const n = new this.Native({ title, body: body.slice(0, 250), silent: severity === 'info' });
        n.on('click', () => this.onClick && this.onClick(item));
        n.show();
      } catch (err) { this.log && this.log.warn('Desktop notification failed', err); }
    }
    return item;
  }
  list({ limit = 200, unreadOnly = false, category, severity, serverId } = {}) {
    const where = []; const args = [];
    if (unreadOnly) where.push('read = 0');
    if (category) { where.push('category = ?'); args.push(category); }
    if (severity) { where.push('severity = ?'); args.push(severity); }
    if (serverId) { where.push('server_id = ?'); args.push(serverId); }
    return this.db.all(`SELECT * FROM notifications ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`, ...args, limit);
  }
  unreadCount() { return this.db.get('SELECT COUNT(*) AS c FROM notifications WHERE read = 0').c; }
  markRead(ids, read = true) {
    if (ids === 'all') this.db.run('UPDATE notifications SET read = ?', read ? 1 : 0);
    else for (const id of ids) this.db.run('UPDATE notifications SET read = ? WHERE id = ?', read ? 1 : 0, id);
    this.bus.publish('notification.changed', { unread: this.unreadCount() });
  }
  remove(ids) {
    if (ids === 'all') this.db.run('DELETE FROM notifications');
    else for (const id of ids) this.db.run('DELETE FROM notifications WHERE id = ?', id);
    this.bus.publish('notification.changed', { unread: this.unreadCount() });
  }
  prune() {
    const days = this.settings.get('notifications').keepDays;
    this.db.run('DELETE FROM notifications WHERE ts < ?', Date.now() - days * 86400000);
  }
}

module.exports = { Notifications, CATEGORIES };
