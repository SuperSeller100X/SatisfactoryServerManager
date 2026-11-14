'use strict';
/**
 * Unreal Engine INI editor that preserves unrelated content, comments and
 * ordering. Only the keys the manager explicitly sets are touched.
 */
class IniDocument {
  constructor(text = '') {
    this.lines = text.replace(/\r\n/g, '\n').split('\n');
    if (this.lines.length && this.lines[this.lines.length - 1] === '') this.lines.pop();
  }
  static parseSections(text) {
    const out = {};
    let section = null;
    for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith(';') || line.startsWith('#')) continue;
      const m = /^\[(.+)\]$/.exec(line);
      if (m) { section = m[1]; out[section] = out[section] || {}; continue; }
      if (!section) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      out[section][key] = line.slice(eq + 1).trim();
    }
    return out;
  }
  _findSection(name) {
    return this.lines.findIndex((l) => l.trim().toLowerCase() === `[${name.toLowerCase()}]`);
  }
  _sectionEnd(start) {
    let i = start + 1;
    while (i < this.lines.length && !/^\s*\[.+\]\s*$/.test(this.lines[i])) i++;
    return i;
  }
  get(section, key) {
    const s = this._findSection(section);
    if (s < 0) return undefined;
    const end = this._sectionEnd(s);
    for (let i = s + 1; i < end; i++) {
      const l = this.lines[i];
      const eq = l.indexOf('=');
      if (eq > 0 && l.slice(0, eq).trim().toLowerCase() === key.toLowerCase()) return l.slice(eq + 1).trim();
    }
    return undefined;
  }
  set(section, key, value) {
    if (/[\r\n]/.test(String(value)) || /[\r\n[\]=]/.test(key)) throw new Error('Invalid INI key or value');
    let s = this._findSection(section);
    if (s < 0) {
      if (this.lines.length && this.lines[this.lines.length - 1].trim() !== '') this.lines.push('');
      this.lines.push(`[${section}]`, `${key}=${value}`);
      return;
    }
    const end = this._sectionEnd(s);
    for (let i = s + 1; i < end; i++) {
      const l = this.lines[i];
      const eq = l.indexOf('=');
      if (eq > 0 && l.slice(0, eq).trim().toLowerCase() === key.toLowerCase()) { this.lines[i] = `${key}=${value}`; return; }
    }
    let insertAt = end;
    while (insertAt > s + 1 && this.lines[insertAt - 1].trim() === '') insertAt--;
    this.lines.splice(insertAt, 0, `${key}=${value}`);
  }
  remove(section, key) {
    const s = this._findSection(section);
    if (s < 0) return;
    const end = this._sectionEnd(s);
    for (let i = s + 1; i < end; i++) {
      const l = this.lines[i];
      const eq = l.indexOf('=');
      if (eq > 0 && l.slice(0, eq).trim().toLowerCase() === key.toLowerCase()) { this.lines.splice(i, 1); return; }
    }
  }
  toString() { return `${this.lines.join('\r\n')}\r\n`; }
}

module.exports = { IniDocument };
