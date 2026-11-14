'use strict';
/**
 * Outbound HTTP helpers. In the packaged app the fetch implementation is
 * Electron's net.fetch (Chromium network stack: system proxy, OS certificate
 * store, full TLS verification). Only HTTPS to an allowlist of hosts is
 * permitted for downloads.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { AppError } = require('./util');

let fetchImpl = globalThis.fetch;
const setFetch = (fn) => { fetchImpl = fn; };
const USER_AGENT = 'SatisfactoryServerManager/1.0 (+https://github.com/SuperSeller100X/SatisfactoryServerManager)';

const TRUSTED_DOWNLOAD_HOSTS = [
  'steamcdn-a.akamaihd.net',
  'api.ficsit.app', 'storage.ficsit.app',
  'api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com',
];

function assertTrustedUrl(url, hosts = TRUSTED_DOWNLOAD_HOSTS) {
  let u;
  try { u = new URL(url); } catch { throw new AppError('E_BAD_URL', `Invalid URL: ${url}`); }
  if (u.protocol !== 'https:') throw new AppError('E_INSECURE_URL', `Refusing non-HTTPS download: ${url}`);
  if (!hosts.includes(u.hostname)) throw new AppError('E_UNTRUSTED_HOST', `Refusing download from untrusted host: ${u.hostname}`);
  return u;
}

async function fetchJson(url, { method = 'GET', body, headers = {}, timeoutMs = 20000 } = {}) {
  assertTrustedUrl(url);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method, signal: ctrl.signal,
      headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new AppError('E_HTTP', `HTTP ${res.status} from ${new URL(url).hostname}`, { status: res.status, body: text.slice(0, 500) });
    return text ? JSON.parse(text) : null;
  } catch (err) {
    if (err.name === 'AbortError') throw new AppError('E_TIMEOUT', `Request to ${new URL(url).hostname} timed out`);
    throw err;
  } finally { clearTimeout(t); }
}

/**
 * Stream a download to disk. Redirects are followed manually so each hop is
 * checked against the host allowlist. Optionally verifies SHA-256 and size.
 */
async function download(url, dest, { sha256, maxBytes = 4 * 1024 ** 3, onProgress, signal, hosts } = {}) {
  let current = url;
  let res;
  for (let hop = 0; hop < 5; hop++) {
    assertTrustedUrl(current, hosts);
    res = await fetchImpl(current, { redirect: 'manual', signal, headers: { 'user-agent': USER_AGENT } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).toString();
      continue;
    }
    break;
  }
  if (!res || !res.ok || !res.body) throw new AppError('E_DOWNLOAD', `Download failed (HTTP ${res ? res.status : '?'}) from ${new URL(current).hostname}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (total > maxBytes) throw new AppError('E_DOWNLOAD_TOO_LARGE', 'Download exceeds the allowed size');
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(tmp);
  let received = 0;
  try {
    for await (const chunk of res.body) {
      received += chunk.length;
      if (received > maxBytes) throw new AppError('E_DOWNLOAD_TOO_LARGE', 'Download exceeds the allowed size');
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      if (onProgress) onProgress({ received, total });
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    const digest = hash.digest('hex');
    if (sha256 && digest.toLowerCase() !== sha256.toLowerCase()) throw new AppError('E_HASH_MISMATCH', 'Downloaded file failed SHA-256 verification', { expected: sha256, actual: digest });
    await fsp.rename(tmp, dest);
    return { bytes: received, sha256: digest, finalUrl: current };
  } catch (err) {
    out.destroy();
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

module.exports = { setFetch, fetchJson, download, assertTrustedUrl, TRUSTED_DOWNLOAD_HOSTS, USER_AGENT, getFetch: () => fetchImpl };
