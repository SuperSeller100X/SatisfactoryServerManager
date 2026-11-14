'use strict';
const { EventEmitter } = require('node:events');

/**
 * Process-wide event bus. Main-process services publish here; the IPC layer
 * forwards a whitelisted set of topics to the renderer and the web dashboard
 * forwards the same topics over Server-Sent Events.
 */
class Bus extends EventEmitter {
  constructor() { super(); this.setMaxListeners(200); }
  publish(topic, payload) { this.emit('event', { topic, payload, ts: Date.now() }); this.emit(topic, payload); }
}

const FORWARDED_TOPICS = new Set([
  'server.status', 'server.console', 'server.metrics', 'server.changed',
  'notification.new', 'notification.changed', 'task.progress', 'operation.progress',
  'backup.changed', 'scheduler.changed', 'update.changed', 'mods.changed', 'remote.changed', 'settings.changed',
]);

module.exports = { Bus, FORWARDED_TOPICS };
