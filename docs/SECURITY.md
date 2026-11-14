# Security

## Electron hardening

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`.
- UI served from the privileged `app://ssm/` scheme with a strict CSP
  (`default-src 'none'; script-src 'self'; style-src 'self'; …`); no inline
  scripts or styles, no `eval`, dynamic text rendered via `textContent` only.
- Single narrow preload bridge; IPC handlers verify the sender is `app://ssm`.
- Every operation validated by a schema that rejects unknown keys and
  prototype-pollution keys; file paths must be absolute; destructive
  operations require `confirm: true`.
- Navigation, new windows and `<webview>` blocked; external links only to an
  allow-list of HTTPS hosts; all permission requests denied except notifications.
- TLS verification is never disabled globally. The Satisfactory server API
  uses a self-signed certificate; it is pinned by SHA-256 fingerprint (trust on
  first use for the local server, refusal on change). The TLS socket is opened
  and checked first, and the HTTP request (with credentials) is written only on
  that verified socket.

## Secrets

- Server API tokens, remote device tokens and the web TLS key are encrypted
  with Electron `safeStorage` (Windows DPAPI). If only weak storage is
  available (Linux without keyring) storing is refused unless explicitly allowed.
- The server administrator password (generated or user-chosen) is stored encrypted with DPAPI so the manager can renew API access by itself; it can be revealed only in the desktop app (audited). Player passwords are never stored.
- Pasted tokens are sanitised (whole `API Token: …` console lines accepted) and verified with the server before storing. Tokens printed by `server.GenerateAPIToken` are captured from the console before display masking, verified and stored; they never appear in the console or logs.
- Audit entries and logs are redacted (keys matching password/token/secret/…,
  bearer tokens, `API Token:` output).

## Web dashboard and remote management

- Off by default; bound to `127.0.0.1` unless the user selects
  *Local network*, in which case requests from non-private addresses are refused.
- HTTPS (TLS ≥ 1.2) with a locally generated ECDSA certificate.
- Web users: scrypt password hashes, minimum 12 characters, login rate limit,
  `__Host-` session cookie (`Secure; HttpOnly; SameSite=Strict`), idle and
  absolute timeouts, per-session CSRF token plus Origin check, roles
  (viewer/admin), security headers (CSP, HSTS, X-Frame-Options, nosniff, …).
- Remote managers pair with a single-use 10-character code (10 minutes,
  5 attempts) after comparing the certificate fingerprint; device tokens are
  stored only as SHA-256 hashes and can be revoked; every remote action is audited.

## Filesystem safety

- Archive extraction rejects absolute paths and `..` traversal and verifies CRC32.
- Deletions are restricted to folders managed by the application (`safeRemove`).
- The setup assistant only deletes a partially installed folder it created
  itself (marker file) and never a complete installation.
- Restores and save uploads always create a restore point first.
