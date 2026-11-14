'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { AppError } = require('./util');

/** True when `child` resolves inside `parent` (or equals it). Case-insensitive on Windows. */
function isInside(parent, child) {
  const norm = (p) => {
    const r = path.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Resolve an archive entry name safely under `root`; rejects traversal and absolute names. */
function safeJoin(root, entryName) {
  const cleaned = entryName.replace(/\\/g, '/');
  if (cleaned.startsWith('/') || /^[A-Za-z]:/.test(cleaned) || cleaned.split('/').includes('..')) {
    throw new AppError('E_UNSAFE_PATH', `Refusing unsafe archive path: ${entryName}`);
  }
  const full = path.resolve(root, cleaned);
  if (!isInside(root, full)) throw new AppError('E_UNSAFE_PATH', `Refusing path outside target: ${entryName}`);
  return full;
}

/** Write JSON/text atomically: temp file + fsync + rename. */
async function writeFileAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, file);
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * Recursively compute size/file count. Symlinks/junctions are not followed so
 * analysis never escapes the measured tree. Returns { bytes, files, errors }.
 */
async function dirSize(root, { onProgress, signal } = {}) {
  let bytes = 0; let files = 0; let errors = 0;
  const stack = [root];
  while (stack.length) {
    if (signal && signal.aborted) break;
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { errors++; continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { stack.push(full); continue; }
      if (e.isFile()) {
        try { const st = await fsp.stat(full); bytes += st.size; files++; } catch { errors++; }
      }
    }
    if (onProgress && files % 500 === 0) onProgress({ bytes, files });
  }
  return { bytes, files, errors };
}

/** List files (relative paths) under root, optionally filtered. */
async function listFiles(root, { filter } = {}) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try { entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!filter || filter(r, true)) stack.push(r); continue; }
      if (e.isFile() && (!filter || filter(r, false))) out.push(r);
    }
  }
  return out.sort();
}

/** Free/total bytes of the volume containing `p`. */
async function diskSpace(p) {
  let probe = path.resolve(p);
  while (!(await exists(probe))) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const st = await fsp.statfs(probe);
  return { free: st.bavail * st.bsize, total: st.blocks * st.bsize, path: probe };
}

/**
 * Delete a path only if it is inside one of the allowed roots managed by the
 * application. Prevents a bug or malicious payload from deleting arbitrary data.
 */
async function safeRemove(target, allowedRoots) {
  const ok = allowedRoots.some((root) => root && isInside(root, target) && path.resolve(root) !== path.resolve(target));
  if (!ok) throw new AppError('E_UNSAFE_DELETE', `Refusing to delete a path outside managed folders: ${target}`);
  await fsp.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

/** True when the directory does not exist or contains no entries. */
async function isEmptyDir(dir) {
  try { return (await fsp.readdir(dir)).length === 0; } catch (e) { return e.code === 'ENOENT'; }
}

/**
 * Copy a tree and verify every file's size afterwards. Used by migration/move.
 * Refuses to copy into a non-empty destination.
 */
async function copyTreeVerified(src, dest, { onProgress, filter } = {}) {
  if (!(await isEmptyDir(dest))) throw new AppError('E_DEST_NOT_EMPTY', `Destination is not empty: ${dest}`);
  if (isInside(src, dest)) throw new AppError('E_DEST_INSIDE_SOURCE', 'Destination must not be inside the source folder.');
  const files = await listFiles(src, { filter });
  let done = 0; let bytes = 0;
  for (const rel of files) {
    const from = path.join(src, rel);
    const to = path.join(dest, rel);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
    const [a, b] = await Promise.all([fsp.stat(from), fsp.stat(to)]);
    if (a.size !== b.size) throw new AppError('E_COPY_VERIFY', `Size mismatch after copying ${rel}`);
    done++; bytes += a.size;
    if (onProgress && (done % 50 === 0 || done === files.length)) onProgress({ done, total: files.length, bytes });
  }
  return { files: files.length, bytes };
}

module.exports = { isInside, safeJoin, writeFileAtomic, exists, sha256File, dirSize, listFiles, diskSpace, safeRemove, isEmptyDir, copyTreeVerified };
