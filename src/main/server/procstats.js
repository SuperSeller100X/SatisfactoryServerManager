'use strict';
/**
 * Process resource sampling from the operating system.
 *  - Windows: one long-lived PowerShell host answers Get-Process queries
 *    (TotalProcessorTime, WorkingSet64, StartTime, Path) to avoid spawning a
 *    new process per sample.
 *  - Linux: /proc/<pid>/stat and /proc/<pid>/status.
 * CPU% is derived from the delta of consumed CPU time between samples and is
 * normalised to the whole machine (100% = all logical cores busy).
 */
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const CORES = os.cpus().length || 1;

class WindowsProcessProbe {
  constructor() { this.ps = null; this.queue = []; this.buf = ''; }
  _ensure() {
    if (this.ps && !this.ps.killed && this.ps.exitCode === null) return;
    this.ps = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.buf = '';
    this.ps.stdout.on('data', (d) => {
      this.buf += d.toString('utf8');
      let idx;
      while ((idx = this.buf.indexOf('<<SSM-END>>')) >= 0) {
        const out = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 11);
        const job = this.queue.shift();
        if (job) { clearTimeout(job.timer); job.resolve(out); }
      }
    });
    this.ps.on('exit', () => { for (const j of this.queue.splice(0)) { clearTimeout(j.timer); j.reject(new Error('PowerShell probe exited')); } this.ps = null; });
  }
  _exec(script) {
    this._ensure();
    return new Promise((resolve, reject) => {
      const job = { resolve, reject, timer: setTimeout(() => { reject(new Error('PowerShell probe timed out')); try { this.ps.kill(); } catch { /* gone */ } }, 15000) };
      this.queue.push(job);
      this.ps.stdin.write(`${script.replace(/\r?\n/g, ' ')}; Write-Output '<<SSM-END>>'\n`);
    });
  }
  async sample(pids) {
    const list = pids.filter((p) => Number.isInteger(p) && p > 0);
    if (!list.length) return {};
    const out = await this._exec(`Get-Process -Id ${list.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { '{0}|{1}|{2}|{3}|{4}' -f $_.Id, [int64]$_.TotalProcessorTime.TotalMilliseconds, $_.WorkingSet64, $(if ($_.StartTime) { [int64](($_.StartTime.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds) } else { 0 }), $_.Path }`);
    const res = {};
    for (const line of out.split(/\r?\n/)) {
      const [pid, cpuMs, rss, start, ...p] = line.trim().split('|');
      if (!pid || !/^\d+$/.test(pid)) continue;
      res[Number(pid)] = { cpuMs: Number(cpuMs), rss: Number(rss), startTime: Number(start) || null, exe: p.join('|') || null };
    }
    return res;
  }
  /** Processes whose executable lives in a folder (used to find orphaned servers). */
  async findByPathPrefix(prefix) {
    const safe = prefix.replace(/'/g, "''");
    const out = await this._exec(`Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${safe}', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { '{0}|{1}' -f $_.ProcessId, $_.ExecutablePath }`);
    return out.split(/\r?\n/).map((l) => l.trim().split('|')).filter((x) => /^\d+$/.test(x[0])).map(([pid, exe]) => ({ pid: Number(pid), exe }));
  }
  /** Run an arbitrary short PowerShell script (used by diagnostics); output text. */
  run(script) { return this._exec(script); }
  dispose() { if (this.ps) { try { this.ps.stdin.end('exit\n'); this.ps.kill(); } catch { /* gone */ } } }
}

class LinuxProcessProbe {
  constructor() {
    this.clk = 100; // USER_HZ is 100 on all mainstream Linux kernels
    this.bootMs = (() => {
      try { const m = /btime (\d+)/.exec(fs.readFileSync('/proc/stat', 'utf8')); return m ? Number(m[1]) * 1000 : 0; } catch { return 0; }
    })();
  }
  async sample(pids) {
    const res = {};
    for (const pid of pids) {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const utime = Number(rest[11]); const stime = Number(rest[12]); const startTicks = Number(rest[19]);
        const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
        const rssKb = Number((/VmRSS:\s+(\d+)/.exec(status) || [0, 0])[1]);
        let exe = null;
        try { exe = fs.readlinkSync(`/proc/${pid}/exe`); } catch { /* permission */ }
        res[pid] = { cpuMs: ((utime + stime) / this.clk) * 1000, rss: rssKb * 1024, startTime: this.bootMs + (startTicks / this.clk) * 1000, exe };
      } catch { /* process gone */ }
    }
    return res;
  }
  async findByPathPrefix(prefix) {
    const out = [];
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try { const exe = fs.readlinkSync(`/proc/${d}/exe`); if (exe.startsWith(prefix)) out.push({ pid: Number(d), exe }); } catch { /* skip */ }
    }
    return out;
  }
  async run() { throw new Error('PowerShell is only available on Windows'); }
  dispose() {}
}

/** Keeps the previous CPU-time reading per PID to turn totals into percentages. */
class CpuTracker {
  constructor() { this.prev = new Map(); }
  percent(pid, cpuMs, now = Date.now()) {
    const p = this.prev.get(pid);
    this.prev.set(pid, { cpuMs, t: now });
    if (!p || now <= p.t || cpuMs < p.cpuMs) return null;
    return Math.max(0, Math.min(100, ((cpuMs - p.cpuMs) / (now - p.t) / CORES) * 100));
  }
  forget(pid) { this.prev.delete(pid); }
}

const createProbe = () => (process.platform === 'win32' ? new WindowsProcessProbe() : new LinuxProcessProbe());

module.exports = { createProbe, CpuTracker, CORES, WindowsProcessProbe, LinuxProcessProbe };
