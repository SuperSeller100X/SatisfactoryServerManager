'use strict';
/**
 * Server migration (other folder or other PC).
 *
 * Package (.ssmpkg): a ZIP with manifest.json listing every file with its
 * SHA-256, plus install/, saves/, backups/ and metadata. With a passphrase the
 * whole ZIP is wrapped in an authenticated encryption container:
 *   magic "SSMPKG1\n" | u32 header length | header JSON (scrypt params, salt)
 *   | chunks: u32 length | 12-byte nonce | ciphertext | 16-byte GCM tag
 * Each chunk's AAD binds its index and a final-chunk flag, so reordering or
 * truncation is detected. Credentials (API tokens) are never exported.
 *
 * Import never overwrites: the target folder must be empty/new, existing save
 * files are kept unless the user chooses overwrite (a restore point is taken).
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const layout = require('../server/layout');
const { createZip, forEachEntry, readEntry, verifyZip } = require('../core/zip');
const { listFiles, sha256File, exists, isEmptyDir, safeJoin, copyTreeVerified, safeRemove, diskSpace, dirSize } = require('../core/fsutil');
const { AppError, newId } = require('../core/util');
const { portableConfig } = require('../server/registry');

const MAGIC = Buffer.from('SSMPKG1\n');
const CHUNK = 4 * 1024 * 1024;
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 512 * 1024 * 1024 };

const NOT_MIGRATED = [
  'Server API tokens and passwords (sign in again on the new PC; the admin password itself is stored inside the save data/ServerSettings and moves with it).',
  'Windows firewall rules and router port forwarding (re-create them on the new PC: Diagnostics → Firewall).',
  'Windows login-item / auto-start settings of the manager.',
  'The trusted TLS certificate fingerprint of the server API (re-trusted automatically on first connection).',
  'Scheduled tasks (recreate them on the new PC; they reference local server IDs).',
];

function deriveKey(passphrase, salt, params = SCRYPT) {
  return new Promise((resolve, reject) => crypto.scrypt(passphrase, salt, 32, params, (e, k) => (e ? reject(e) : resolve(k))));
}

async function encryptFile(src, dest, passphrase) {
  const salt = crypto.randomBytes(16);
  const key = await deriveKey(passphrase, salt);
  const header = Buffer.from(JSON.stringify({ kdf: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64'), cipher: 'aes-256-gcm', chunk: CHUNK }));
  const out = await fsp.open(dest, 'wx');
  try {
    const len = Buffer.alloc(4); len.writeUInt32LE(header.length);
    await out.write(Buffer.concat([MAGIC, len, header]));
    const prefix = crypto.randomBytes(4);
    const size = (await fsp.stat(src)).size;
    const inp = await fsp.open(src, 'r');
    try {
      let index = 0; let pos = 0;
      do {
        const buf = Buffer.alloc(Math.min(CHUNK, size - pos));
        if (buf.length) await inp.read(buf, 0, buf.length, pos);
        pos += buf.length;
        const final = pos >= size;
        const nonce = Buffer.concat([prefix, Buffer.alloc(8)]); nonce.writeBigUInt64LE(BigInt(index), 4);
        const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
        c.setAAD(Buffer.from(`${index}:${final ? 1 : 0}`));
        const ct = Buffer.concat([c.update(buf), c.final()]);
        const l = Buffer.alloc(4); l.writeUInt32LE(ct.length);
        await out.write(Buffer.concat([l, nonce, ct, c.getAuthTag()]));
        index++;
        if (final) break;
      } while (true); // eslint-disable-line no-constant-condition
    } finally { await inp.close(); }
  } finally { await out.close(); }
}

async function isEncrypted(file) {
  const fh = await fsp.open(file, 'r');
  try { const b = Buffer.alloc(8); await fh.read(b, 0, 8, 0); return b.equals(MAGIC); } finally { await fh.close(); }
}

async function decryptFile(src, dest, passphrase) {
  const inp = await fsp.open(src, 'r');
  const out = await fsp.open(dest, 'wx');
  try {
    const size = (await inp.stat()).size;
    const head = Buffer.alloc(12); await inp.read(head, 0, 12, 0);
    if (!head.subarray(0, 8).equals(MAGIC)) throw new AppError('E_PACKAGE', 'Not an encrypted migration package.');
    const hlen = head.readUInt32LE(8);
    if (hlen > 4096) throw new AppError('E_PACKAGE', 'Corrupted package header.');
    const hb = Buffer.alloc(hlen); await inp.read(hb, 0, hlen, 12);
    const h = JSON.parse(hb.toString('utf8'));
    if (h.kdf !== 'scrypt' || h.cipher !== 'aes-256-gcm' || h.N > 2 ** 20) throw new AppError('E_PACKAGE', 'Unsupported package encryption parameters.');
    const key = await deriveKey(passphrase, Buffer.from(h.salt, 'base64'), { N: h.N, r: h.r, p: h.p, maxmem: 1024 * 1024 * 1024 });
    let pos = 12 + hlen; let index = 0; let sawFinal = false;
    while (pos < size) {
      const lb = Buffer.alloc(4); await inp.read(lb, 0, 4, pos); pos += 4;
      const clen = lb.readUInt32LE(0);
      if (clen > h.chunk + 64) throw new AppError('E_PACKAGE', 'Corrupted package chunk.');
      const nonce = Buffer.alloc(12); await inp.read(nonce, 0, 12, pos); pos += 12;
      const ct = Buffer.alloc(clen); await inp.read(ct, 0, clen, pos); pos += clen;
      const tag = Buffer.alloc(16); await inp.read(tag, 0, 16, pos); pos += 16;
      const final = pos >= size;
      const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
      d.setAAD(Buffer.from(`${index}:${final ? 1 : 0}`));
      d.setAuthTag(tag);
      let pt;
      try { pt = Buffer.concat([d.update(ct), d.final()]); } catch { throw new AppError('E_DECRYPT', index === 0 ? 'Wrong passphrase, or the package is damaged.' : 'The package is damaged or was modified (authentication failed).'); }
      await out.write(pt);
      index++;
      if (final) sawFinal = true;
    }
    if (!sawFinal) throw new AppError('E_DECRYPT', 'The package is truncated.');
  } catch (err) { await out.close(); await fsp.rm(dest, { force: true }); await inp.close(); throw err; }
  await out.close(); await inp.close();
}

class Migration {
  constructor(ctx) { this.ctx = ctx; }

  _progress(message, extra = {}) { this.ctx.bus.publish('operation.progress', { kind: 'migration', message, ...extra }); }

  notMigrated() { return NOT_MIGRATED; }

  async exportServer(serverId, dest, { includeServerFiles = true, includeBackups = false, passphrase = '', actor = 'local' } = {}) {
    const srv = this.ctx.registry.get(serverId);
    if (this.ctx.supervisor.isActive(serverId)) throw new AppError('E_SERVER_RUNNING', 'Stop the server before exporting so saves are consistent.');
    if (await exists(dest)) throw new AppError('E_EXISTS', 'The destination file already exists.');
    if (passphrase && passphrase.length < 10) throw new AppError('E_VALIDATION', 'Use a passphrase of at least 10 characters.');
    return this.ctx.locks.run(serverId, 'export', () => this.ctx.audit.wrap({ actor, action: 'migration.export', serverId, target: srv.name, details: { includeServerFiles, includeBackups, encrypted: !!passphrase } }, async () => {
      const entries = [];
      const files = [];
      const add = async (abs, name) => { this._progress(`Hashing ${name}`); const st = await fsp.stat(abs); files.push({ name, size: st.size, sha256: await sha256File(abs) }); entries.push({ abs, name }); };
      const skipInstall = (rel) => /^FactoryGame\/Saved\/(Logs|Crashes)(\/|$)|^steamapps\/(downloading|temp|shadercache)(\/|$)/i.test(rel);
      if (includeServerFiles) {
        for (const rel of await listFiles(srv.installDir, { filter: (r) => !skipInstall(r) })) {
          if (rel !== '.ssm-install') await add(path.join(srv.installDir, rel), `install/${rel}`);
        }
      } else {
        for (const sub of ['FactoryGame/Saved/Config', 'FactoryGame/Mods']) {
          const base = path.join(srv.installDir, sub);
          for (const rel of await listFiles(base).catch(() => [])) await add(path.join(base, rel), `install/${sub}/${rel}`);
        }
      }
      const { entries: saveEntries } = await this.ctx.backups.collectSources(srv);
      for (const e of saveEntries.filter((x) => x.name.startsWith('saves/'))) await add(e.abs, e.name);
      const backups = includeBackups ? this.ctx.backups.list({ serverId }) : [];
      for (const b of backups) if (await exists(b.path)) await add(b.path, `backups/${path.basename(b.path)}`);

      const manifest = {
        format: 'ssm-migration', formatVersion: 1, createdAt: new Date().toISOString(),
        source: { platform: process.platform, hostname: require('node:os').hostname(), installDir: srv.installDir, appVersion: require('../../../package.json').version },
        server: { name: srv.name, group: srv.group, config: portableConfig(srv.config), branch: srv.config.branch },
        installedFromSteam: !includeServerFiles,
        build: await require('../steam/steamcmd').readAppManifest(srv.installDir).catch(() => null),
        mods: this.ctx.db.all('SELECT mod_reference, version, manifest, installed_at FROM mod_files WHERE server_id = ?', serverId),
        modHistory: this.ctx.db.all('SELECT ts, action, mod_reference, from_version, to_version, status FROM mod_history WHERE server_id = ?', serverId),
        configHistory: this.ctx.db.all('SELECT ts, reason, data FROM config_history WHERE server_id = ? ORDER BY id DESC LIMIT 50', serverId),
        backups: backups.map((b) => ({ id: b.id, created_at: b.created_at, type: b.type, file: path.basename(b.path), sha256: b.sha256, note: b.note })),
        files, notMigrated: NOT_MIGRATED,
      };
      const totalBytes = files.reduce((a, f) => a + f.size, 0);
      const space = await diskSpace(path.dirname(dest));
      if (space.free < totalBytes * (passphrase ? 2.1 : 1.1)) throw new AppError('E_DISK_SPACE', `Not enough free disk space at the destination (${(totalBytes / 1024 ** 3).toFixed(1)} GB needed).`);
      const zipPath = passphrase ? path.join(this.ctx.paths.temp, `export-${newId()}.zip`) : dest;
      await fsp.mkdir(path.dirname(zipPath), { recursive: true });
      this._progress('Writing package', { total: entries.length });
      try {
        await createZip(zipPath, [{ name: 'manifest.json', buffer: Buffer.from(JSON.stringify(manifest, null, 2)) }, ...entries], { level: 6, onProgress: (p) => this._progress(`Packing files (${p.done}/${p.total})`, p) });
        await verifyZip(zipPath);
        if (passphrase) { this._progress('Encrypting package'); await encryptFile(zipPath, dest, passphrase); }
      } finally { if (passphrase) await fsp.rm(zipPath, { force: true }); }
      const sha = await sha256File(dest);
      await fsp.writeFile(`${dest}.sha256`, `${sha}  ${path.basename(dest)}\n`);
      this._progress(null);
      return { path: dest, sha256: sha, files: files.length, bytes: (await fsp.stat(dest)).size, encrypted: !!passphrase, notMigrated: NOT_MIGRATED };
    }));
  }

  /** Read and verify a package's manifest without extracting (shows what will be imported). */
  async inspect(file, { passphrase = '' } = {}) {
    const { zip, cleanup } = await this._openZip(file, passphrase);
    try {
      const m = JSON.parse((await readEntry(zip, 'manifest.json')).toString('utf8'));
      if (m.format !== 'ssm-migration') throw new AppError('E_PACKAGE', 'This is not a Satisfactory Server Manager migration package.');
      const side = await fsp.readFile(`${file}.sha256`, 'utf8').catch(() => null);
      const sha = side ? await sha256File(file) : null;
      return { manifest: { ...m, files: undefined, configHistory: undefined }, fileCount: m.files.length, totalBytes: m.files.reduce((a, f) => a + f.size, 0), checksumFile: side ? sha === side.split(/\s+/)[0] : null, encrypted: await isEncrypted(file) };
    } finally { await cleanup(); }
  }

  async _openZip(file, passphrase) {
    if (await isEncrypted(file)) {
      if (!passphrase) throw new AppError('E_PASSPHRASE_REQUIRED', 'This package is encrypted. Enter its passphrase.');
      const tmp = path.join(this.ctx.paths.temp, `import-${newId()}.zip`);
      await fsp.mkdir(path.dirname(tmp), { recursive: true });
      this._progress('Decrypting package');
      await decryptFile(file, tmp, passphrase);
      return { zip: tmp, cleanup: () => fsp.rm(tmp, { force: true }) };
    }
    return { zip: file, cleanup: async () => {} };
  }

  async importServer(file, { targetDir, name, passphrase = '', overwriteSaves = false, actor = 'local' } = {}) {
    if (!(await isEmptyDir(targetDir))) throw new AppError('E_DEST_NOT_EMPTY', 'The target folder must be empty or not exist yet, so no existing installation is overwritten.');
    for (const s of this.ctx.registry.list()) if (require('../core/fsutil').isInside(s.installDir, targetDir) || require('../core/fsutil').isInside(targetDir, s.installDir)) throw new AppError('E_DIR_IN_USE', `The target folder overlaps "${s.name}".`);
    const { zip, cleanup } = await this._openZip(file, passphrase);
    const createdDir = !(await exists(targetDir));
    try {
      const m = JSON.parse((await readEntry(zip, 'manifest.json')).toString('utf8'));
      if (m.format !== 'ssm-migration' || m.formatVersion !== 1) throw new AppError('E_PACKAGE', 'Unsupported package format.');
      const expected = new Map(m.files.map((f) => [f.name, f]));
      const saveRoot = layout.defaultSaveRoot();
      const backupsStage = path.join(this.ctx.paths.temp, `import-backups-${newId()}`);
      const skippedSaves = [];
      const written = [];
      await fsp.mkdir(targetDir, { recursive: true });
      // Pass 1: extract with hash verification. Saves go to a staging folder first.
      const savesStage = path.join(this.ctx.paths.temp, `import-saves-${newId()}`);
      let n = 0;
      await forEachEntry(zip, async (entry, open) => {
        const nameIn = entry.fileName;
        if (nameIn === 'manifest.json' || nameIn.endsWith('/')) return;
        const meta = expected.get(nameIn);
        if (!meta) throw new AppError('E_PACKAGE', `Unexpected file in package: ${nameIn}`);
        let dest;
        if (nameIn.startsWith('install/')) dest = safeJoin(targetDir, nameIn.slice(8));
        else if (nameIn.startsWith('saves/')) dest = safeJoin(savesStage, nameIn.slice(6));
        else if (nameIn.startsWith('backups/')) dest = safeJoin(backupsStage, nameIn.slice(8));
        else throw new AppError('E_PACKAGE', `Unexpected file in package: ${nameIn}`);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        const h = crypto.createHash('sha256');
        const s = await open();
        await new Promise((resolve, reject) => {
          const w = fs.createWriteStream(dest, { flags: 'wx' });
          s.on('data', (c) => h.update(c));
          s.on('error', reject); w.on('error', reject); w.on('close', resolve);
          s.pipe(w);
        });
        if (h.digest('hex') !== meta.sha256) throw new AppError('E_CHECKSUM', `Checksum mismatch for ${nameIn}. The package is damaged.`);
        expected.delete(nameIn);
        written.push(dest);
        if (++n % 200 === 0) this._progress(`Extracting (${n}/${m.files.length})`);
      });
      if (expected.size) throw new AppError('E_CHECKSUM', `${expected.size} file(s) listed in the manifest are missing from the package.`);

      if (m.installedFromSteam) this._progress('Server binaries were not included; they will be installed from Steam after import.');
      const srv = this.ctx.registry.create({ name: name || m.server.name, group: m.server.group || '', installDir: targetDir, config: { ...m.server.config, launch: { ...m.server.config.launch, ...this.ctx.registry.suggestPorts() } } }, actor);

      // Saves: copy into the save root without overwriting unless explicitly allowed.
      const stagedSaves = await listFiles(savesStage).catch(() => []);
      if (overwriteSaves && stagedSaves.length) await this.ctx.backups.create(srv.id, { type: 'pre-migration', note: 'Before importing migrated saves', actor: 'system' }).catch((e) => { if (e.code !== 'E_NOTHING_TO_BACKUP') throw e; });
      for (const rel of stagedSaves) {
        const to = safeJoin(saveRoot, rel);
        if ((await exists(to)) && !overwriteSaves) { skippedSaves.push(rel); continue; }
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await fsp.copyFile(path.join(savesStage, rel), to);
      }
      // Backups: move into the backup root and register.
      const bdir = path.join(this.ctx.backups.root(), srv.id);
      for (const b of m.backups || []) {
        const from = path.join(backupsStage, b.file);
        if (!(await exists(from))) continue;
        await fsp.mkdir(bdir, { recursive: true });
        const to = path.join(bdir, b.file);
        await fsp.copyFile(from, to);
        this.ctx.db.run('INSERT OR IGNORE INTO backups (id, server_id, created_at, type, path, size, sha256, files, status, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', newId('bk_'), srv.id, b.created_at, b.type, to, (await fsp.stat(to)).size, b.sha256, 0, 'unverified', `${b.note || ''} (migrated)`.trim());
      }
      for (const mf of m.mods || []) this.ctx.db.run('INSERT OR REPLACE INTO mod_files (server_id, mod_reference, version, manifest, installed_at) VALUES (?, ?, ?, ?, ?)', srv.id, mf.mod_reference, mf.version, mf.manifest, mf.installed_at);
      for (const h of m.modHistory || []) this.ctx.db.run('INSERT INTO mod_history (server_id, ts, action, mod_reference, from_version, to_version, status) VALUES (?, ?, ?, ?, ?, ?, ?)', srv.id, h.ts, h.action, h.mod_reference, h.from_version, h.to_version, h.status);
      await fsp.rm(savesStage, { recursive: true, force: true });
      await fsp.rm(backupsStage, { recursive: true, force: true });
      this.ctx.audit.record({ actor, action: 'migration.import', serverId: srv.id, target: srv.name, details: { from: m.source, files: m.files.length, skippedSaves: skippedSaves.length } });
      this._progress(null);
      return { server: srv, files: m.files.length, skippedSaves, needsSteamInstall: !!m.installedFromSteam, notMigrated: m.notMigrated || NOT_MIGRATED, crossPlatform: m.source.platform !== process.platform };
    } catch (err) {
      // Remove only what this import created.
      if (createdDir) await fsp.rm(targetDir, { recursive: true, force: true }).catch(() => {});
      else for (const e of await fsp.readdir(targetDir).catch(() => [])) await fsp.rm(path.join(targetDir, e), { recursive: true, force: true }).catch(() => {});
      this.ctx.audit.record({ actor, action: 'migration.import', target: path.basename(file), result: 'failed', error: err });
      throw err;
    } finally { await cleanup(); }
  }

  /** Move an installation to another folder on this PC. The old folder is kept unless deleteOld is set (only after verification). */
  async moveServer(serverId, newDir, { deleteOld = false, actor = 'local' } = {}) {
    const srv = this.ctx.registry.get(serverId);
    if (this.ctx.supervisor.isActive(serverId)) throw new AppError('E_SERVER_RUNNING', 'Stop the server before moving it.');
    for (const s of this.ctx.registry.list()) if (s.id !== serverId && (require('../core/fsutil').isInside(s.installDir, newDir) || require('../core/fsutil').isInside(newDir, s.installDir))) throw new AppError('E_DIR_IN_USE', `The target overlaps "${s.name}".`);
    return this.ctx.locks.run(serverId, 'move', () => this.ctx.audit.wrap({ actor, action: 'migration.move', serverId, target: srv.name, details: { from: srv.installDir, to: newDir, deleteOld } }, async () => {
      const size = await dirSize(srv.installDir);
      const space = await diskSpace(newDir);
      if (space.free < size.bytes * 1.05) throw new AppError('E_DISK_SPACE', 'Not enough free space at the destination.');
      const res = await copyTreeVerified(srv.installDir, newDir, { onProgress: (p) => this._progress(`Copying (${p.done}/${p.total})`, p) });
      const old = srv.installDir;
      this.ctx.registry.setInstallDir(serverId, newDir, actor);
      if (deleteOld) await safeRemove(old, [path.dirname(old)]);
      this._progress(null);
      return { ...res, oldDir: old, oldDeleted: deleteOld };
    }));
  }
}

module.exports = { Migration, encryptFile, decryptFile, isEncrypted, NOT_MIGRATED };
