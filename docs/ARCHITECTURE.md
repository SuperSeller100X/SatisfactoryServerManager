# Architecture

```
src/
  main/                  Electron main process (Node.js, CommonJS)
    main.js              bootstrap, secure window, app:// protocol, tray, lifecycle, IPC
    rpc.js               single registry of every operation: schema + permission level
    core/                db (SQLite + migrations), settings, secrets (DPAPI), audit,
                         notifications, logger, validation, zip, http, fs utilities
    server/              registry (config schema), supervisor (process lifecycle,
                         console, crash recovery), HTTPS API client (cert pinning),
                         UDP query client, process stats, INI editor, on-disk layout
    steam/               SteamCMD wrapper, VDF/appmanifest parser
    features/            setup wizard engine, backups, scheduler, updates, mods,
                         health, diagnostics, storage, profiles/templates,
                         migration, benchmarks, startup, firewall, access, system scan
    net/                 web dashboard + remote API server, auth, certificates,
                         remote client
  preload/preload.js     narrow contextBridge API (invoke / on / dialogs)
  renderer/              UI (vanilla ES modules, no framework), served via app://ssm/
    js/pages/            dashboard, server, wizard, … (also served to the web dashboard)
build/                   installer script + branding assets
scripts/                 asset generator, syntax check
test/unit, test/e2e      node:test suites, Playwright Electron tests
```

## Request flow

Renderer → `window.ssm.invoke(channel, payload)` → IPC `rpc` (sender origin
checked) → `Rpc.dispatch` (schema validation, permission level) → service.
The web dashboard and paired remote managers call the **same** `Rpc.dispatch`
with their own caller identity; desktop-only (`local`) operations such as file
paths, dialogs, credentials and OS integration are refused for them.

Events (status, console, metrics, notifications) flow through an in-process
bus to the renderer (IPC) and to web clients (Server-Sent Events).

## Persistence and migrations

SQLite via `node:sqlite` (bundled with Electron's Node 24). `core/db.js`
contains ordered migrations recorded in `schema_migrations`; each runs in a
transaction, and a copy of the database is kept before upgrading an existing
file. **Migration 1** creates: settings, secrets, servers, runs, crashes,
metrics, metrics_hourly, notifications, audit, backups, tasks, task_runs,
updates, profiles, config_history, templates, mod_history, mod_files,
mod_profiles, player_events, benchmarks, remote_devices, remote_machines,
web_users. Setup-wizard progress is stored in the `settings` row `setup`.

Data locations (Windows):

- `%APPDATA%\Satisfactory Server Manager\` — database, logs
- `%LOCALAPPDATA%\SatisfactoryServerManager\` — SteamCMD, backups, run logs,
  diagnostics, mod snapshots, rollback copies, temp
- Server folders — chosen by the user
- Saves — `%LOCALAPPDATA%\FactoryGame\Saved\SaveGames` (written by the server)

## Process ownership

Servers are launched directly
(`Engine\Binaries\Win64\FactoryServer-Win64-Shipping-Cmd.exe FactoryGame -log
-unattended -Port= -ReliablePort=`) so the manager owns the PID and console.
Processes found running from a configured folder at start-up are *attached*
(monitored, stoppable after identity re-verification) but never auto-restarted.

## Data sources (no fabricated values)

| Value | Source |
| --- | --- |
| CPU / memory | OS process table (PowerShell `Get-Process`, `/proc` on Linux) |
| Responsiveness, game changelist | UDP Lightweight Query API |
| Players, tick rate, session | HTTPS API `QueryServerState` (needs a token) |
| Installed build / branch | `steamapps\appmanifest_1690800.acf` |
| Published builds | `steamcmd +app_info_print 1690800` |
| Mods | `.uplugin` files + api.ficsit.app |
| Startup / shutdown time | timestamps of launch, first query response, stop request, exit |
