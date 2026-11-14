'use strict';
/**
 * Windows Defender Firewall integration. Rules are inbound port rules named
 * "Satisfactory Server Manager - <server> (<proto> <port>)". Reading uses
 * PowerShell Get-NetFirewallRule (no elevation needed); creating requires
 * administrator rights, so a single elevated PowerShell is launched through
 * UAC after the user has confirmed. Results are always re-verified.
 */
const { execFile } = require('node:child_process');
const { AppError } = require('../core/util');

const RULE_PREFIX = 'Satisfactory Server Manager';

function requiredRules(srv) {
  const { port, reliablePort } = srv.config.launch;
  return [
    { protocol: 'UDP', port, purpose: 'Game traffic and server query' },
    { protocol: 'TCP', port, purpose: 'Server HTTPS API' },
    { protocol: 'TCP', port: reliablePort, purpose: 'Reliable messaging' },
  ].map((r) => ({ ...r, name: `${RULE_PREFIX} - ${srv.id} (${r.protocol} ${r.port})` }));
}

const ps = (script, timeout = 30000) => new Promise((resolve) => {
  execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
});

/** Report which required rules exist, plus whether any enabled rule allows the ports. */
async function inspect(srv) {
  const rules = requiredRules(srv);
  if (process.platform !== 'win32') return { supported: false, rules: rules.map((r) => ({ ...r, present: null })), note: 'Firewall inspection is only available on Windows.' };
  const script = `$ErrorActionPreference='SilentlyContinue'; $p = (Get-NetFirewallProfile | Where-Object { $_.Enabled } | Measure-Object).Count; Write-Output "PROFILES|$p"; Get-NetFirewallRule -Direction Inbound -Enabled True -Action Allow | Where-Object { $_.DisplayName -like '${RULE_PREFIX}*' } | ForEach-Object { $f = $_ | Get-NetFirewallPortFilter; Write-Output ('RULE|' + $_.DisplayName + '|' + $f.Protocol + '|' + $f.LocalPort) }`;
  const r = await ps(script);
  if (r.code !== 0) return { supported: true, error: `Could not read firewall rules: ${r.stderr.trim() || 'PowerShell failed'}`, rules: rules.map((x) => ({ ...x, present: null })) };
  const lines = r.stdout.split(/\r?\n/);
  const enabledProfiles = Number((lines.find((l) => l.startsWith('PROFILES|')) || 'PROFILES|0').split('|')[1]);
  const present = lines.filter((l) => l.startsWith('RULE|')).map((l) => l.split('|'));
  const out = rules.map((x) => ({ ...x, present: present.some(([, , proto, port]) => proto.toUpperCase() === x.protocol && String(port) === String(x.port)) }));
  return { supported: true, firewallEnabled: enabledProfiles > 0, rules: out, allPresent: out.every((x) => x.present) };
}

/**
 * Create the missing rules with one UAC prompt. Arguments are integers and
 * fixed strings built here (no user text reaches the elevated command line).
 */
async function createRules(srv) {
  if (process.platform !== 'win32') throw new AppError('E_UNSUPPORTED', 'Firewall configuration is only available on Windows.');
  const current = await inspect(srv);
  const missing = current.rules.filter((r) => !r.present);
  if (!missing.length) return { created: [], verified: current };
  for (const r of missing) if (!Number.isInteger(r.port) || !['TCP', 'UDP'].includes(r.protocol) || !/^[A-Za-z0-9_ ()-]+$/.test(r.name)) throw new AppError('E_VALIDATION', 'Invalid firewall rule');
  const inner = missing.map((r) => `New-NetFirewallRule -DisplayName '${r.name}' -Group '${RULE_PREFIX}' -Direction Inbound -Action Allow -Protocol ${r.protocol} -LocalPort ${r.port} -Profile Any | Out-Null`).join('; ');
  const encoded = Buffer.from(inner, 'utf16le').toString('base64');
  const outer = `$p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}'; exit $p.ExitCode`;
  const r = await ps(outer, 120000);
  const verified = await inspect(srv);
  if (!verified.allPresent) {
    const cancelled = /canceled|cancelled|1223/i.test(r.stderr);
    throw new AppError(cancelled ? 'E_UAC_CANCELLED' : 'E_FIREWALL', cancelled ? 'The Windows permission prompt was cancelled, so no firewall rules were created.' : `Firewall rules could not be verified after creation. ${r.stderr.trim()}`);
  }
  return { created: missing.map((m) => m.name), verified };
}

async function removeRules(srv) {
  if (process.platform !== 'win32') return { removed: 0 };
  const encoded = Buffer.from(`Get-NetFirewallRule -DisplayName '${RULE_PREFIX} - ${srv.id} *' -ErrorAction SilentlyContinue | Remove-NetFirewallRule`, 'utf16le').toString('base64');
  await ps(`$p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${encoded}'; exit $p.ExitCode`, 120000);
  return inspect(srv);
}

module.exports = { inspect, createRules, removeRules, requiredRules, RULE_PREFIX };
