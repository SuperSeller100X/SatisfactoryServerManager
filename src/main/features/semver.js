'use strict';
/** Small semver implementation sufficient for FICSIT dependency conditions (^, ~, comparators, x-ranges, ||). */

function parse(ver) {
  const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(String(ver));
  if (!m) return null;
  return { major: +m[1], minor: m[2] === undefined ? 0 : +m[2], patch: m[3] === undefined ? 0 : +m[3], pre: m[4] ? m[4].split('.') : [] };
}

function compare(a, b) {
  const x = typeof a === 'string' ? parse(a) : a; const y = typeof b === 'string' ? parse(b) : b;
  if (!x || !y) return 0;
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (!x.pre.length && y.pre.length) return 1;
  if (x.pre.length && !y.pre.length) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]; const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const np = /^\d+$/.test(p); const nq = /^\d+$/.test(q);
    if (np && nq && +p !== +q) return +p < +q ? -1 : 1;
    if (np !== nq) return np ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

function expandPartial(op, raw) {
  const parts = raw.replace(/^v/, '').split('.');
  const isX = (s) => s === undefined || s === '*' || s.toLowerCase() === 'x';
  if (isX(parts[0])) return [['>=', '0.0.0']];
  const M = +parts[0];
  if (isX(parts[1])) return op === '' || op === '=' ? [['>=', `${M}.0.0`], ['<', `${M + 1}.0.0`]] : [[op, `${M}.0.0`]];
  const m = +parts[1];
  if (isX(parts[2])) return op === '' || op === '=' ? [['>=', `${M}.${m}.0`], ['<', `${M}.${m + 1}.0`]] : [[op, `${M}.${m}.0`]];
  return [[op || '=', raw.replace(/^v/, '')]];
}

function parseRange(range) {
  return String(range).split('||').map((alt) => {
    const comps = [];
    const tokens = alt.trim().replace(/([<>=~^]+)\s+/g, '$1').split(/\s+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (tokens[i + 1] === '-' && tokens[i + 2]) { comps.push(['>=', tokens[i]], ['<=', tokens[i + 2]]); i += 2; continue; }
      const m = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(t);
      const op = m[1] || ''; const v = m[2];
      const p = parse(v.replace(/\.(x|\*)/gi, '.0'));
      if (op === '^') {
        if (!p) continue;
        const upper = p.major > 0 ? `${p.major + 1}.0.0` : p.minor > 0 ? `0.${p.minor + 1}.0` : `0.0.${p.patch + 1}`;
        comps.push(['>=', v], ['<', upper]);
      } else if (op === '~') {
        if (!p) continue;
        comps.push(['>=', v], ['<', `${p.major}.${p.minor + 1}.0`]);
      } else comps.push(...expandPartial(op, v));
    }
    return comps;
  });
}

function satisfies(version, range) {
  if (range === undefined || range === null || String(range).trim() === '' || String(range).trim() === '*') return !!parse(version);
  const v = parse(version);
  if (!v) return false;
  return parseRange(range).some((comps) => comps.every(([op, target]) => {
    const c = compare(v, parse(target));
    switch (op) {
      case '>=': return c >= 0;
      case '<=': return c <= 0;
      case '>': return c > 0;
      case '<': return c < 0;
      default: return c === 0;
    }
  }));
}

/** Satisfactory changelist (integer) check against FICSIT game_version like ">=491125". */
function gameVersionOk(gameVersion, netCL) {
  if (!gameVersion || netCL == null) return null; // unknown
  return satisfies(`${netCL}.0.0`, String(gameVersion).replace(/(\d+)(?![\d.])/g, '$1.0.0'));
}

module.exports = { parse, compare, satisfies, gameVersionOk };
