'use strict';
/**
 * SQLite persistence (node:sqlite, bundled with Electron's Node runtime) with
 * ordered, transactional schema migrations. Each migration runs exactly once and
 * the applied version is tracked in `schema_migrations`. A pre-migration copy of
 * the database file is kept so a failed upgrade can be recovered manually.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE secrets (key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL);

      CREATE TABLE servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        group_name TEXT NOT NULL DEFAULT '',
        install_dir TEXT NOT NULL UNIQUE,
        config TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ready_at INTEGER,
        stop_requested_at INTEGER,
        ended_at INTEGER,
        pid INTEGER,
        exit_code INTEGER,
        signal TEXT,
        outcome TEXT,
        reason TEXT,
        log_path TEXT,
        build_id TEXT,
        trigger TEXT
      );
      CREATE INDEX runs_server ON runs(server_id, started_at);

      CREATE TABLE crashes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id TEXT NOT NULL,
        run_id INTEGER,
        at INTEGER NOT NULL,
        exit_code INTEGER,
        reason TEXT,
        evidence TEXT,
        diagnostics_path TEXT,
        recovery TEXT
      );
      CREATE INDEX crashes_server ON crashes(server_id, at);

      CREATE TABLE metrics (
        server_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        cpu REAL,
        mem_bytes INTEGER,
        players INTEGER,
        tick_rate REAL,
        responsive INTEGER,
        latency_ms INTEGER
      );
      CREATE INDEX metrics_server_ts ON metrics(server_id, ts);

      CREATE TABLE metrics_hourly (
        server_id TEXT NOT NULL,
        hour INTEGER NOT NULL,
        samples INTEGER NOT NULL,
        cpu_avg REAL, cpu_max REAL,
        mem_avg REAL, mem_max REAL,
        players_avg REAL, players_max INTEGER,
        tick_avg REAL,
        responsive_ratio REAL,
        PRIMARY KEY (server_id, hour)
      );

      CREATE TABLE notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        category TEXT NOT NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        server_id TEXT,
        read INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX notifications_ts ON notifications(ts);

      CREATE TABLE audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        server_id TEXT,
        target TEXT,
        result TEXT NOT NULL,
        details TEXT,
        error TEXT
      );
      CREATE INDEX audit_ts ON audit(ts);

      CREATE TABLE backups (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        type TEXT NOT NULL,
        path TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT,
        files INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        validated_at INTEGER,
        validation TEXT,
        note TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX backups_server ON backups(server_id, created_at);

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        server_id TEXT,
        cron TEXT NOT NULL,
        timezone TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        params TEXT NOT NULL DEFAULT '{}',
        missed_policy TEXT NOT NULL DEFAULT 'run-once',
        next_run INTEGER,
        last_run INTEGER,
        last_status TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE task_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        scheduled_for INTEGER,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        status TEXT NOT NULL,
        message TEXT
      );
      CREATE INDEX task_runs_task ON task_runs(task_id, started_at);

      CREATE TABLE updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        server_id TEXT,
        kind TEXT NOT NULL,
        from_version TEXT,
        to_version TEXT,
        status TEXT NOT NULL,
        backup_id TEXT,
        details TEXT
      );

      CREATE TABLE profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        source_server_id TEXT,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE config_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        reason TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX config_history_server ON config_history(server_id, ts);

      CREATE TABLE templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE mod_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        action TEXT NOT NULL,
        mod_reference TEXT NOT NULL,
        from_version TEXT,
        to_version TEXT,
        status TEXT NOT NULL,
        snapshot_path TEXT,
        details TEXT
      );

      CREATE TABLE mod_files (
        server_id TEXT NOT NULL,
        mod_reference TEXT NOT NULL,
        version TEXT NOT NULL,
        manifest TEXT NOT NULL,
        installed_at INTEGER NOT NULL,
        PRIMARY KEY (server_id, mod_reference)
      );

      CREATE TABLE mod_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mods TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE player_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id TEXT NOT NULL,
        run_id INTEGER,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        player TEXT,
        source TEXT NOT NULL
      );
      CREATE INDEX player_events_server ON player_events(server_id, ts);

      CREATE TABLE benchmarks (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        name TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        status TEXT NOT NULL,
        build_id TEXT,
        report TEXT
      );

      CREATE TABLE remote_devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        scopes TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen INTEGER,
        last_ip TEXT,
        revoked_at INTEGER
      );

      CREATE TABLE remote_machines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        device_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen INTEGER,
        last_error TEXT
      );

      CREATE TABLE web_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_login INTEGER
      );
    `,
  },
];

class Database {
  constructor(file) {
    this.file = file;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  get currentVersion() {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
    const row = this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
    return row && row.v ? row.v : 0;
  }

  migrate(migrations = MIGRATIONS) {
    const current = this.currentVersion;
    const pending = migrations.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
    if (!pending.length) return [];
    if (current > 0 && this.file !== ':memory:' && fs.existsSync(this.file)) {
      // Keep a copy of the pre-upgrade database. WAL is checkpointed first.
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      fs.copyFileSync(this.file, `${this.file}.pre-v${pending[0].version}.bak`);
    }
    const applied = [];
    for (const m of pending) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (m.sql) this.db.exec(m.sql);
        if (m.up) m.up(this.db);
        this.db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, Date.now());
        this.db.exec('COMMIT');
        applied.push(m.version);
      } catch (err) {
        this.db.exec('ROLLBACK');
        err.message = `Database migration ${m.version} (${m.name}) failed: ${err.message}`;
        throw err;
      }
    }
    return applied;
  }

  run(sql, ...params) { return this.db.prepare(sql).run(...params); }
  get(sql, ...params) { return this.db.prepare(sql).get(...params); }
  all(sql, ...params) { return this.db.prepare(sql).all(...params); }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close() { try { this.db.close(); } catch { /* already closed */ } }
}

module.exports = { Database, MIGRATIONS };
