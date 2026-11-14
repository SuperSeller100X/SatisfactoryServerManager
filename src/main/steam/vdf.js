'use strict';
/**
 * Parser for Valve KeyValues text (.acf / .vdf / app_info_print output).
 * Keys are kept as written; lookups use getCI for case-insensitive access.
 */
function parseVdf(text) {
  let i = 0;
  const n = text.length;
  const skipWs = () => {
    while (i < n) {
      const c = text[i];
      if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
      break;
    }
  };
  const readToken = () => {
    skipWs();
    if (i >= n) return null;
    if (text[i] === '{' || text[i] === '}') return { brace: text[i++] };
    if (text[i] === '"') {
      i++;
      let s = '';
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) {
          const nx = text[i + 1];
          s += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx;
          i += 2;
        } else s += text[i++];
      }
      i++;
      return { str: s };
    }
    let s = '';
    while (i < n && !/[\s{}"]/.test(text[i])) s += text[i++];
    return { str: s };
  };
  const parseObject = (top) => {
    const obj = {};
    for (;;) {
      const key = readToken();
      if (key === null) { if (top) return obj; throw new Error('Unexpected end of VDF data'); }
      if (key.brace === '}') { if (top) throw new Error('Unexpected } in VDF data'); return obj; }
      if (key.brace) throw new Error('Unexpected { in VDF data');
      const val = readToken();
      if (val === null) throw new Error('Missing VDF value');
      if (val.brace === '{') obj[key.str] = parseObject(false);
      else if (val.brace) throw new Error('Unexpected } in VDF data');
      else obj[key.str] = val.str;
    }
  };
  return parseObject(true);
}

function getCI(obj, ...keys) {
  let cur = obj;
  for (const k of keys) {
    if (!cur || typeof cur !== 'object') return undefined;
    const found = Object.keys(cur).find((x) => x.toLowerCase() === String(k).toLowerCase());
    cur = found === undefined ? undefined : cur[found];
  }
  return cur;
}

/**
 * Extract the KeyValues block for an app from `app_info_print` output, which
 * is wrapped in SteamCMD console noise.
 */
function extractAppInfo(output, appId) {
  const marker = `"${appId}"`;
  const start = output.indexOf(marker);
  if (start < 0) return null;
  let depth = 0; let began = false; let end = -1;
  for (let i = start + marker.length; i < output.length; i++) {
    const c = output[i];
    if (c === '"') { // skip quoted strings so braces inside values do not count
      i++;
      while (i < output.length && output[i] !== '"') { if (output[i] === '\\') i++; i++; }
      continue;
    }
    if (c === '{') { depth++; began = true; } else if (c === '}') { depth--; if (began && depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) return null;
  const parsed = parseVdf(output.slice(start, end));
  return getCI(parsed, String(appId)) || null;
}

module.exports = { parseVdf, getCI, extractAppInfo };
