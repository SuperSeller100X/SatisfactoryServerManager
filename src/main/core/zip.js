'use strict';
/**
 * ZIP helpers on top of yazl/yauzl (ZIP64-capable). Extraction validates every
 * entry path (no traversal, no absolute paths); sizes are checked by yauzl
 * and CRC32 is verified here while streaming.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const yazl = require('yazl');
const yauzl = require('yauzl');
const zlib = require('node:zlib');
const { safeJoin } = require('./fsutil');

/** Wraps an entry stream and rejects when the computed CRC32 differs from the header. */
async function* crcChecked(stream, entry) {
  let crc = 0;
  for await (const c of stream) { crc = zlib.crc32(c, crc); yield c; }
  if ((crc >>> 0) !== (entry.crc32 >>> 0)) throw new Error(`CRC32 mismatch in archive entry ${entry.fileName}`);
}

/** entries: [{ abs, name }] or [{ buffer, name }]. Returns { bytes, files }. */
function createZip(dest, entries, { level = 6, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const out = fs.createWriteStream(dest);
    let done = 0;
    out.on('error', reject);
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(out).on('close', async () => {
      try { resolve({ bytes: (await fsp.stat(dest)).size, files: entries.length }); } catch (e) { reject(e); }
    });
    for (const e of entries) {
      const name = e.name.replace(/\\/g, '/');
      const opts = { compress: level > 0, compressionLevel: level, forceZip64Format: false };
      if (e.buffer) zip.addBuffer(e.buffer, name, opts);
      else {
        zip.addReadStream(fs.createReadStream(e.abs).on('end', () => { done++; if (onProgress) onProgress({ done, total: entries.length }); }), name, { ...opts, mtime: e.mtime || new Date() });
      }
    }
    zip.end();
  });
}

function openZip(file) {
  return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, autoClose: false, strictFileNames: false, validateEntrySizes: true }, (err, z) => (err ? reject(err) : resolve(z))));
}

/** Iterate entries; handler(entry, openStream) may return a promise. */
async function forEachEntry(file, handler) {
  const z = await openZip(file);
  try {
    await new Promise((resolve, reject) => {
      z.on('error', reject);
      z.on('end', resolve);
      z.on('entry', async (entry) => {
        try {
          const openStream = () => new Promise((res, rej) => z.openReadStream(entry, (e, s) => (e ? rej(e) : res(s))));
          await handler(entry, openStream);
          z.readEntry();
        } catch (e) { reject(e); }
      });
      z.readEntry();
    });
  } finally { z.close(); }
}

async function listZip(file) {
  const out = [];
  await forEachEntry(file, (e) => { out.push({ name: e.fileName, size: e.uncompressedSize, compressed: e.compressedSize, dir: /\/$/.test(e.fileName) }); });
  return out;
}

async function readEntry(file, name) {
  let data = null;
  await forEachEntry(file, async (e, open) => {
    if (e.fileName === name) {
      const s = await open();
      const chunks = [];
      for await (const c of crcChecked(s, e)) chunks.push(c);
      data = Buffer.concat(chunks);
    }
  });
  return data;
}

/**
 * Extract into destDir. `map(entryName)` may return a relative path to use
 * (or null to skip). Every entry is checked with safeJoin.
 */
async function extractZip(file, destDir, { map, onProgress, overwrite = false } = {}) {
  let files = 0;
  await forEachEntry(file, async (entry, open) => {
    const target = map ? map(entry.fileName) : entry.fileName;
    if (target == null) return;
    const full = safeJoin(destDir, target);
    if (/\/$/.test(entry.fileName)) { await fsp.mkdir(full, { recursive: true }); return; }
    await fsp.mkdir(path.dirname(full), { recursive: true });
    const s = await open();
    const { pipeline } = require('node:stream/promises');
    const { Readable } = require('node:stream');
    try {
      await pipeline(Readable.from(crcChecked(s, entry)), fs.createWriteStream(full, { flags: overwrite ? 'w' : 'wx' }));
    } catch (err) { await fsp.rm(full, { force: true }); throw err; }
    files++;
    if (onProgress) onProgress({ files });
  });
  return { files };
}

/** Read every entry fully so yauzl verifies CRC32 and sizes. */
async function verifyZip(file) {
  let files = 0; let bytes = 0;
  await forEachEntry(file, async (entry, open) => {
    if (/\/$/.test(entry.fileName)) return;
    const s = await open();
    for await (const c of crcChecked(s, entry)) bytes += c.length;
    files++;
  });
  return { files, bytes };
}

module.exports = { createZip, listZip, readEntry, extractZip, verifyZip, forEachEntry };
