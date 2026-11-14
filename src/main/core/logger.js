'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { redactText } = require('./util');

/** Application log with size-based rotation. Secrets are masked before writing. */
class Logger {
  constructor(dir, { maxBytes = 5 * 1024 * 1024, keep = 5, echo = false } = {}) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.keep = keep;
    this.echo = echo;
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'manager.log');
    this.size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
  }
  rotate() {
    for (let i = this.keep - 1; i >= 1; i--) {
      const from = `${this.file}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${this.file}.${i + 1}`);
    }
    if (fs.existsSync(this.file)) fs.renameSync(this.file, `${this.file}.1`);
    this.size = 0;
  }
  write(level, scope, msg, extra) {
    let line = `${new Date().toISOString()} [${level.toUpperCase()}] [${scope}] ${redactText(String(msg))}`;
    if (extra) {
      const e = extra instanceof Error ? (extra.stack || extra.message) : JSON.stringify(extra);
      line += ` ${redactText(e)}`;
    }
    line += '\n';
    try {
      if (this.size + line.length > this.maxBytes) this.rotate();
      fs.appendFileSync(this.file, line);
      this.size += Buffer.byteLength(line);
    } catch { /* logging must never crash the app */ }
    if (this.echo) process.stdout.write(line);
  }
  scope(name) {
    return {
      info: (m, x) => this.write('info', name, m, x),
      warn: (m, x) => this.write('warn', name, m, x),
      error: (m, x) => this.write('error', name, m, x),
      debug: (m, x) => this.write('debug', name, m, x),
    };
  }
  /** Last N lines of the current log (used by diagnostics). */
  tail(lines = 200) {
    try {
      const data = fs.readFileSync(this.file, 'utf8');
      return data.split('\n').filter(Boolean).slice(-lines);
    } catch { return []; }
  }
}

module.exports = { Logger };
