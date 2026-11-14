// Server detail: overview, console, configuration, players, health, crashes,
// access (API credentials) and connection information.
import { h, mount, fmt, debounce } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { statusPill, badge, tabs, card, kv, callout, toast, toastError, confirmDialog, formDialog, actionButton, settingRow, switchInput, table, na, seg, effectLabel, modal } from '../ui.js';
import { lineChart } from '../charts.js';
import { controls } from './common.js';

const TABS = [
  { key: 'overview', label: 'Overview', icon: 'dashboard' }, { key: 'console', label: 'Console', icon: 'console' },
  { key: 'config', label: 'Configuration', icon: 'settings' }, { key: 'players', label: 'Players', icon: 'users' },
  { key: 'health', label: 'Health', icon: 'activity' }, { key: 'crashes', label: 'Crashes & Recovery', icon: 'alert' },
  { key: 'access', label: 'Access', icon: 'key' }, { key: 'connection', label: 'Connection', icon: 'link' },
];

export async function render(page, [id, tab = 'overview'], { setTitle, navigate }) {
  let s;
  try { s = await api.call('servers.get', { serverId: id }); } catch (err) { mount(page, callout('err', 'alertCircle', err.message)); return undefined; }
  setTitle(h('a', { href: '#/dashboard' }, 'Dashboard'), s.name);
  const headStatus = h('span');
  const headCtl = h('div', { class: 'actions' });
  const drawHead = () => {
    mount(headStatus, statusPill(s.status.busy || s.status.status));
    mount(headCtl, ...controls(s, { size: '' }),
      h('button', { class: 'btn', onclick: () => navigate(`mods/${id}`) }, icon('puzzle'), 'Mods'),
      h('button', { class: 'btn', onclick: () => navigate(`backups/${id}`) }, icon('backup'), 'Backups'),
      h('button', { class: 'btn', onclick: () => navigate(`performance/${id}`) }, icon('benchmark'), 'Performance'));
  };
  drawHead();
  const body = h('div');
  mount(page,
    h('div', { class: 'page-head' }, h('div', { class: 'titles' }, h('div', { class: 'row' }, h('h1', null, s.name), headStatus, s.maintenance.enabled ? badge('Maintenance mode', 'warn', 'wrench') : null),
      h('p', { class: 'mono small' }, s.installDir)), headCtl),
    tabs(TABS, tab, (k) => navigate(`server/${id}/${k}`)), body);
  const offs = [api.on('server.status', (p) => { if (p.id === id) { s.status = { ...s.status, ...p }; drawHead(); } })];
  const views = { overview, console: consoleTab, config, players, health, crashes, access, connection };
  const d = await (views[tab] || overview)(body, s, id, navigate);
  return () => { offs.forEach((o) => o()); if (typeof d === 'function') d(); };
}

// ------------------------------------------------------------------ overview
async function overview(body, s, id) {
  const ind = s.indicators;
  const t = s.telemetry;
  const live = h('div', { class: 'grid g4' });
  const drawLive = () => mount(live, ...[
    ['CPU', 'cpu', t.cpu !== null && t.cpu !== undefined ? fmt.pct(t.cpu) : null, 'of total machine'],
    ['Memory', 'memory', t.memBytes !== null && t.memBytes !== undefined ? fmt.bytes(t.memBytes) : null, t.memPercent ? `${t.memPercent.toFixed(1)}% of RAM` : ''],
    ['Players', 'users', t.players !== null && t.players !== undefined ? `${t.players}${t.playerLimit ? ` / ${t.playerLimit}` : ''}` : null, s.apiAccess ? 'from server API' : 'needs API access'],
    ['Uptime', 'clock', ['running', 'attached', 'starting', 'stopping'].includes(s.status.status) ? fmt.dur(s.status.uptimeMs) : null, s.status.startedAt ? `since ${fmt.date(s.status.startedAt)}` : 'not running'],
  ].map(([l, ic, v, sub]) => h('div', { class: 'card glow' }, h('div', { class: 'stat' }, h('div', { class: 'label' }, icon(ic), l), h('div', { class: 'value' }, v ?? na()), h('div', { class: 'sub' }, sub)))));
  drawLive();
  const hist = h('div');
  mount(body, live,
    h('div', { class: 'grid g2 mt' },
      card('Health indicators', 'activity', h('div', { class: 'col' }, ind.items.map((i) => h('div', { class: 'row' }, h('span', { class: `sev-dot ${i.state}` }), h('b', { style: { minWidth: '120px' } }, i.label), h('span', { class: 'muted small grow' }, i.detail)))), badge(ind.overall === 'ok' ? 'Healthy' : ind.overall, ind.overall === 'ok' ? 'ok' : ind.overall === 'unknown' ? '' : ind.overall)),
      card('Server information', 'info', kv([
        ['Build', s.build ? s.build.buildId : 'not installed'], ['Branch', s.branch], ['Installed branch', s.build ? s.build.branch : '—'],
        ['Game changelist', s.netCL ? String(s.netCL) : 'detected after first start'], ['Update available', s.updateAvailable ? 'yes' : s.updates && s.updates.checkedAt ? 'no' : 'not checked yet'],
        ['Game port', `${s.ports.game} (UDP+TCP)`], ['Reliable port', `${s.ports.reliable} (TCP)`],
        ['Session', t.session || '—'], ['Tech tier', t.techTier ?? '—'], ['Game phase', t.gamePhase ? String(t.gamePhase).split('.').pop() : '—'],
        ['Tick rate', t.tickRate ? `${t.tickRate.toFixed(1)} /s` : '—'], ['API access', s.apiAccess ? `yes (${s.config.api.tokenKind} token)` : 'not configured'],
        ['Mods', `${s.mods.count}${s.mods.sml ? ` (SML ${s.mods.sml})` : ''}`], ['Last backup', s.lastBackup ? fmt.date(s.lastBackup.created_at) : 'never'],
        ['Auto-start', s.autoStart ? 'yes' : 'no'], ['Crash recovery', s.recoveryEnabled ? 'enabled' : 'disabled'],
      ]))),
    h('div', { class: 'card mt' }, h('div', { class: 'card-head' }, h('h3', null, icon('cpu'), 'CPU usage — last hour')), hist));
  try {
    const r = await api.call('health.history', { serverId: id, rangeMs: 3600000, points: 180 });
    mount(hist, lineChart(r.rows.map((x) => ({ t: x.t, v: x.cpu })), { format: (v) => `${v.toFixed(0)}%`, height: 180, unavailableText: 'No CPU samples recorded in the last hour (the server was not running).' }));
  } catch (err) { mount(hist, callout('err', 'alertCircle', err.message)); }
  const off = api.on('server.metrics', (p) => { if (p.id === id) { Object.assign(t, p); drawLive(); } });
  return off;
}

// ------------------------------------------------------------------ console
async function consoleTab(body, s, id) {
  let lines = []; let lastSeq = 0; let follow = true; let level = 'all'; let query = ''; let source = 'all';
  const hist = []; let hi = -1;
  const out = h('div', { class: 'console', tabindex: '0', role: 'log', 'aria-live': 'off' });
  const input = h('input', { class: 'input', placeholder: s.apiAccess ? 'Enter a server console command (sent via the server API RunCommand)…' : 'Enter a console command (sent to the server process input)…', spellcheck: 'false', list: 'ssm-cmds' });
  const datalist = h('datalist', { id: 'ssm-cmds' });
  const searchIn = h('input', { class: 'input', placeholder: 'Search output…', style: { width: '220px' } });
  const levelSeg = h('span'); const srcSeg = h('span');
  const runSel = h('select', { class: 'input', style: { width: '240px' } }, h('option', { value: 'live' }, 'Live (current session)'));
  const drawSegs = () => {
    mount(levelSeg, seg([{ value: 'all', label: 'All' }, { value: 'error', label: 'Errors' }, { value: 'warning', label: 'Warnings' }, { value: 'system', label: 'Manager' }], level, (v) => { level = v; drawSegs(); redraw(); }));
    mount(srcSeg, seg([{ value: 'all', label: 'All sources' }, { value: 'server', label: 'Server output' }, { value: 'sys', label: 'System messages' }], source, (v) => { source = v; drawSegs(); redraw(); }));
  };
  drawSegs();
  searchIn.addEventListener('input', debounce(() => { query = searchIn.value.toLowerCase(); redraw(); }, 200));
  const lineEl = (l) => {
    const cls = l.src === 'cmd' ? 'cmd' : l.level;
    const msg = h('span');
    const text = l.category && l.src !== 'sys' ? l.message : l.text;
    if (query && text.toLowerCase().includes(query)) {
      let i = 0; const low = text.toLowerCase();
      while (i < text.length) { const j = low.indexOf(query, i); if (j < 0) { msg.append(text.slice(i)); break; } msg.append(text.slice(i, j), h('mark', null, text.slice(j, j + query.length))); i = j + query.length; }
    } else msg.textContent = text;
    return h('div', { class: `ln ${cls}` }, h('span', { class: 'ts' }, fmt.time(l.ts)), h('span', { class: 'lv' }, l.src === 'sys' ? 'SSM' : l.src === 'cmd' ? 'CMD' : l.level), h('span', null, l.category && l.src !== 'sys' ? h('span', { class: 'cat' }, `${l.category}: `) : null, msg));
  };
  const pass = (l) => (level === 'all' || (level === 'system' ? l.src === 'sys' : l.level === level)) && (source === 'all' || (source === 'sys' ? (l.src === 'sys' || l.src === 'cmd') : (l.src === 'out' || l.src === 'err'))) && (!query || l.text.toLowerCase().includes(query));
  const redraw = () => { mount(out, lines.filter(pass).slice(-3000).map(lineEl)); if (follow) out.scrollTop = out.scrollHeight; };
  out.addEventListener('scroll', () => { follow = out.scrollTop + out.clientHeight >= out.scrollHeight - 30; });
  const send = async () => {
    const cmd = input.value.trim();
    if (!cmd) return;
    hist.unshift(cmd); hi = -1; input.value = '';
    try { await api.call('console.send', { serverId: id, command: cmd }); } catch (err) { toastError(err, 'Command failed'); }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
    else if (e.key === 'ArrowUp') { if (hi < hist.length - 1) { hi++; input.value = hist[hi]; } e.preventDefault(); }
    else if (e.key === 'ArrowDown') { if (hi > 0) { hi--; input.value = hist[hi]; } else { hi = -1; input.value = ''; } e.preventDefault(); }
  });
  const copySel = () => { const t = window.getSelection().toString() || lines.filter(pass).map((l) => `${new Date(l.ts).toISOString()} ${l.text}`).join('\n'); navigator.clipboard.writeText(t).then(() => toast('Copied to clipboard', '', 'success')); };
  const download = () => api.saveText(`${s.name.replace(/[^\w-]+/g, '_')}-console-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.log`, lines.map((l) => `${new Date(l.ts).toISOString()} [${l.src}] ${l.text}`).join('\r\n'), [{ name: 'Log', extensions: ['log', 'txt'] }]).then((p) => p && toast('Log saved', p, 'success'));
  const runInfo = h('div', { class: 'small muted' });
  mount(body,
    h('div', { class: 'row wrap mb' }, runSel, levelSeg, srcSeg, searchIn, h('span', { class: 'grow' }),
      h('button', { class: 'btn sm', onclick: copySel, title: 'Copy selection (or all visible lines)' }, icon('copy'), 'Copy'),
      h('button', { class: 'btn sm', onclick: download }, icon('download'), 'Download')),
    runInfo, out,
    h('div', { class: 'console-input' }, input, datalist, h('button', { class: 'btn primary', onclick: send }, icon('chevronRight'), 'Send')),
    h('p', { class: 'small muted', style: { marginTop: '8px' } }, s.apiAccess ? 'Commands are sent through the documented RunCommand API function and their result is shown as a manager line.' : 'Without API access, commands are written to the standard input of a server started by this manager. Configure API access on the Access tab for reliable command results.'));
  api.call('console.suggestions').then((r) => mount(datalist, r.documented.map((c) => h('option', { value: c.command }, c.help)))).catch(() => {});
  const runs = await api.call('servers.runs', { serverId: id }).catch(() => []);
  for (const r of runs) runSel.appendChild(h('option', { value: String(r.id) }, `Run #${r.id} · ${fmt.date(r.started_at)} · ${r.outcome || 'running'}`));
  runSel.addEventListener('change', async () => {
    if (runSel.value === 'live') { mount(runInfo); lines = await api.call('console.snapshot', { serverId: id }); redraw(); input.disabled = false; return; }
    input.disabled = true;
    const r = await api.call('console.runLog', { runId: Number(runSel.value) }).catch((e) => { toastError(e); return null; });
    if (!r) return;
    const run = r.run;
    mount(runInfo, h('div', { class: 'callout info mb' }, icon('history'), h('div', null, h('b', null, `Run #${run.id}: `), `${run.outcome || 'running'} · started ${fmt.date(run.started_at)}${run.ended_at ? ` · ended ${fmt.date(run.ended_at)}` : ''}${run.exit_code !== null && run.exit_code !== undefined ? ` · exit code ${run.exit_code}` : ''}${run.reason ? ` · ${run.reason}` : ''}`)));
    lines = r.text.split(/\r?\n/).filter(Boolean).map((t, i) => { const m = /^(\S+) \[(\w+)\] (.*)$/.exec(t); const src = m ? m[2] : 'out'; const text = m ? m[3] : t; return { seq: i, ts: m ? Date.parse(m[1]) : null, src, text, message: text, level: src === 'sys' ? 'system' : /error|fatal/i.test(text) ? 'error' : /warning/i.test(text) ? 'warning' : 'log' }; });
    redraw();
  });
  lines = await api.call('console.snapshot', { serverId: id }).catch(() => []);
  lastSeq = lines.length ? lines[lines.length - 1].seq : 0;
  redraw();
  const off = api.on('server.console', (p) => {
    if (p.id !== id || runSel.value !== 'live') return;
    const fresh = p.lines.filter((l) => l.seq > lastSeq);
    if (!fresh.length) return;
    lastSeq = fresh[fresh.length - 1].seq;
    lines.push(...fresh);
    if (lines.length > 5000) lines.splice(0, lines.length - 5000);
    const vis = fresh.filter(pass);
    for (const l of vis) out.appendChild(lineEl(l));
    while (out.childNodes.length > 3000) out.removeChild(out.firstChild);
    if (follow) out.scrollTop = out.scrollHeight;
  });
  input.focus();
  return off;
}

// ------------------------------------------------------------------ configuration
async function config(body, s, id) {
  const c = s.config;
  const draft = structuredClone(c);
  const changed = new Set();
  const set = (path, value) => { const parts = path.split('.'); let o = draft; for (const p of parts.slice(0, -1)) o = o[p]; o[parts.at(-1)] = value; changed.add(path); saveBar(); };
  const num = (path, v, min, max) => { const i = h('input', { class: 'input', type: 'number', min, max, value: v, style: { width: '120px' } }); i.addEventListener('change', () => set(path, Number(i.value))); return i; };
  const txt = (path, v, ph) => { const i = h('input', { class: 'input', value: v || '', placeholder: ph || '' }); i.addEventListener('change', () => set(path, i.value.trim())); return i; };
  const sw = (path, v) => switchInput(v, (x) => set(path, x));
  const bar = h('div', { class: 'callout info hidden', style: { position: 'sticky', top: '0', zIndex: 5 } });
  const saveBar = () => {
    bar.classList.toggle('hidden', !changed.size);
    const restart = [...changed].some((p) => /^(launch|ini|saveRoot)/.test(p));
    mount(bar, icon('info'), h('div', { class: 'grow' }, h('b', null, `${changed.size} unsaved change(s). `), restart ? 'Some changes take effect after the next server restart.' : 'Changes apply immediately.'),
      h('button', { class: 'btn sm', onclick: () => location.reload() }, 'Discard'),
      actionButton('Save changes', async () => {
        const patch = {};
        for (const p of changed) { const top = p.split('.')[0]; if (top !== 'name' && top !== 'group') patch[top] = draft[top]; }
        const { name, group } = draft.__identity || {};
        const r = await api.call('servers.update', { serverId: id, ...(Object.keys(patch).length ? { config: patch } : {}), ...(name ? { name } : {}), ...(group !== undefined ? { group } : {}) });
        changed.clear(); saveBar();
        toast('Configuration saved', r.restartRequired ? 'Restart the server to apply restart-required settings.' : `${r.changes.length} setting(s) updated.`, 'success');
      }, { kind: 'primary', size: 'sm', iconName: 'check' }));
  };
  draft.__identity = { name: s.name, group: s.group };
  const nameIn = h('input', { class: 'input', value: s.name }); nameIn.addEventListener('change', () => { draft.__identity.name = nameIn.value.trim(); changed.add('name'); saveBar(); });
  const groupIn = h('input', { class: 'input', value: s.group || '', placeholder: 'e.g. Production' }); groupIn.addEventListener('change', () => { draft.__identity.group = groupIn.value.trim(); changed.add('group'); saveBar(); });
  const branchSel = h('select', { class: 'input' }, ['public', 'experimental'].map((b) => h('option', { value: b, selected: c.branch === b }, b)));
  branchSel.addEventListener('change', () => set('branch', branchSel.value));
  const argsIn = h('input', { class: 'input mono', value: (c.launch.extraArgs || []).join(' '), placeholder: '-DisablePacketRouting' });
  argsIn.addEventListener('change', () => set('launch.extraArgs', argsIn.value.split(/\s+/).filter(Boolean)));
  const live = h('div');
  mount(body, bar,
    h('div', { class: 'grid g2' },
      card('General', 'server', h('div', null,
        settingRow('Display name', 'Name in this manager.', nameIn, 'immediate'),
        settingRow('Group', 'Used to group servers on the dashboard.', groupIn, 'immediate'),
        settingRow('Game branch', 'Changing the branch downloads different server files at the next update.', branchSel, 'update'),
        settingRow('Notes', null, txt('notes', c.notes, 'Internal notes'), 'immediate'))),
      card('Network & launch', 'network', h('div', null,
        settingRow('Game port', 'UDP + TCP (game traffic and HTTPS API).', num('launch.port', c.launch.port, 1024, 65535), 'restart'),
        settingRow('Reliable port', 'TCP, for reliable messaging.', num('launch.reliablePort', c.launch.reliablePort, 1024, 65535), 'restart'),
        settingRow('Bind address (multihome)', 'Leave empty to listen on all addresses.', txt('launch.multihome', c.launch.multihome, 'all addresses'), 'restart'),
        settingRow('Disable seasonal events', '-DisableSeasonalEvents', sw('launch.disableSeasonalEvents', c.launch.disableSeasonalEvents), 'restart'),
        settingRow('Additional launch arguments', 'Advanced: documented engine/server arguments only, e.g. -DisablePacketRouting.', argsIn, 'restart'))),
      card('Game settings (INI)', 'file', h('div', null,
        settingRow('Max players', 'Game.ini → [/Script/Engine.GameSession] MaxPlayers', num('ini.maxPlayers', c.ini.maxPlayers, 1, 127), 'restart'),
        settingRow('Rotating autosaves', 'Engine.ini → mNumRotatingAutosaves', num('ini.autosaveCount', c.ini.autosaveCount, 1, 100), 'restart'))),
      card('Crash recovery', 'restart', h('div', null,
        settingRow('Restart automatically after a crash', 'Only processes started by this manager are restarted.', sw('recovery.enabled', c.recovery.enabled), 'immediate'),
        settingRow('Maximum attempts', 'Within the time window below; then recovery stops to prevent a crash loop.', num('recovery.maxAttempts', c.recovery.maxAttempts, 0, 20), 'immediate'),
        settingRow('Time window (minutes)', null, num('recovery.windowMinutes', c.recovery.windowMinutes, 1, 1440), 'immediate'),
        settingRow('Cooldown (seconds)', 'Wait before the first restart; grows by the backoff factor.', num('recovery.cooldownSeconds', c.recovery.cooldownSeconds, 5, 3600), 'immediate'),
        settingRow('Backoff factor', null, num('recovery.backoffMultiplier', c.recovery.backoffMultiplier, 1, 10), 'immediate'),
        settingRow('Collect diagnostics after crashes', 'Saves logs and crash reports into a diagnostics package.', sw('recovery.collectDiagnostics', c.recovery.collectDiagnostics), 'immediate'))),
      card('Shutdown & updates', 'power', h('div', null,
        settingRow('Save before stopping', 'Uses the SaveGame API function (needs API access).', sw('shutdown.saveBeforeStop', c.shutdown.saveBeforeStop), 'immediate'),
        settingRow('Shutdown grace period (s)', null, num('shutdown.graceSeconds', c.shutdown.graceSeconds, 10, 900), 'immediate'),
        settingRow('Server update policy', 'Inherit uses Settings → Updates.', (() => { const x = h('select', { class: 'input' }, [['inherit', 'Inherit'], ['off', 'Off'], ['notify', 'Notify only'], ['window', 'Install in update window'], ['scheduled', 'Only via scheduled task']].map(([v, l]) => h('option', { value: v, selected: c.updates.policy === v }, l))); x.addEventListener('change', () => set('updates.policy', x.value)); return x; })(), 'immediate'),
        settingRow('Mod update policy', null, (() => { const x = h('select', { class: 'input' }, [['inherit', 'Inherit'], ['off', 'Off'], ['notify', 'Notify only'], ['window', 'Install in update window'], ['scheduled', 'Only via scheduled task']].map(([v, l]) => h('option', { value: v, selected: c.mods.updatePolicy === v }, l))); x.addEventListener('change', () => set('mods.updatePolicy', x.value)); return x; })(), 'immediate'))),
      card('Maintenance mode', 'wrench', h('div', null,
        h('p', null, 'While enabled, automatic restarts, automatic updates and scheduled tasks for this server are paused.'),
        settingRow('Maintenance mode', c.maintenance.enabled ? `Since ${fmt.date(c.maintenance.since)}${c.maintenance.reason ? ` — ${c.maintenance.reason}` : ''}` : 'Off', switchInput(c.maintenance.enabled, async (v, el) => {
          try { const reason = v ? (await formDialog({ title: 'Enable maintenance mode', fields: [{ key: 'reason', label: 'Reason (optional)' }], submitLabel: 'Enable' })) : {}; if (v && !reason) { el.checked = false; return; } await api.call('servers.setMaintenance', { serverId: id, enabled: v, reason: reason.reason || '' }); toast(`Maintenance ${v ? 'enabled' : 'disabled'}`, '', 'success'); } catch (err) { el.checked = !v; toastError(err); }
        }), 'immediate')))),
    h('div', { class: 'card mt' }, h('div', { class: 'card-head' }, h('h3', null, icon('zap'), 'Live server options'), h('span', { class: 'effect live' }, effectLabel('live'))), live),
    h('div', { class: 'card mt' }, h('div', { class: 'card-head' }, h('h3', null, icon('history'), 'Configuration history'), actionButton('Validate configuration', async () => { const r = await api.call('servers.validateConfig', { serverId: id }); const bad = r.findings.filter((f) => f.severity !== 'ok'); toast(bad.length ? `${bad.length} issue(s) found` : 'Configuration is valid', bad.map((b) => b.title).slice(0, 3).join(' · '), bad.length ? 'warning' : 'success'); }, { size: 'sm', iconName: 'check' })), await historyTable(id)));
  // Live options (ApplyServerOptions)
  if (!s.apiAccess || !['running', 'attached'].includes(s.status.status)) mount(live, callout('info', 'info', 'Live options are read from and applied through the server API while the server runs with API access configured.'));
  else {
    try {
      const r = await api.call('servers.liveOptions', { serverId: id });
      const vals = {};
      mount(live, h('div', null, Object.entries(r.known).map(([k, def]) => {
        const cur = r.current ? r.current[k] : undefined;
        let ctl;
        if (def.type === 'bool') ctl = switchInput(String(cur) === 'True' || String(cur) === 'true', (v) => { vals[k] = v; });
        else { ctl = h('input', { class: 'input', type: 'number', min: def.min, max: def.max, value: cur ?? '', style: { width: '120px' } }); ctl.addEventListener('change', () => { vals[k] = Number(ctl.value); }); }
        return settingRow(def.label, `${k}${cur === undefined ? ' · not reported by server' : ` · current: ${cur}`}`, ctl, 'live');
      }), h('div', { class: 'row mt' }, actionButton('Apply live', async () => { if (!Object.keys(vals).length) return; const res = await api.call('servers.applyLiveOptions', { serverId: id, options: vals }); toast('Applied without restart', res.applied.join(', '), 'success'); }, { kind: 'primary', iconName: 'zap' }))));
    } catch (err) { mount(live, callout('warn', 'alert', `Could not read live options: ${err.message}`)); }
  }
  saveBar();
}

async function historyTable(id) {
  const hist = await api.call('servers.history', { serverId: id }).catch(() => []);
  return table([
    { key: 'ts', label: 'Saved', render: (r) => fmt.date(r.ts), sort: (r) => r.ts },
    { key: 'reason', label: 'Reason' },
    { key: 'a', label: '', render: (r) => actionButton('Restore', async () => { if (!(await confirmDialog({ title: 'Restore this configuration?', message: 'The current configuration is saved to history first, so this can be undone.', confirmLabel: 'Restore' }))) return; const ch = await api.call('servers.restoreHistory', { serverId: id, historyId: r.id }); toast('Configuration restored', `${ch.length} setting(s) changed`, 'success'); }, { size: 'sm', iconName: 'restart' }) },
  ], hist, { empty: 'No earlier configurations yet — every change is recorded here.' });
}

// ------------------------------------------------------------------ players
async function players(body, s, id) {
  const r = await api.call('servers.players', { serverId: id });
  mount(body,
    h('div', { class: 'grid g3' },
      h('div', { class: 'card glow' }, h('div', { class: 'stat' }, h('div', { class: 'label' }, icon('users'), 'Connected now'), h('div', { class: 'value' }, r.connected !== null && r.connected !== undefined ? `${r.connected}${r.limit ? ` / ${r.limit}` : ''}` : na()), h('div', { class: 'sub' }, r.apiAccess ? 'reported by QueryServerState' : 'configure API access to see the player count'))),
      h('div', { class: 'card' }, h('div', { class: 'stat' }, h('div', { class: 'label' }, icon('history'), 'Recorded sessions'), h('div', { class: 'value' }, String(r.sessions.length)), h('div', { class: 'sub' }, 'periods with players online'))),
      h('div', { class: 'card' }, h('div', { class: 'stat' }, h('div', { class: 'label' }, icon('file'), 'Joins in server log'), h('div', { class: 'value' }, String(r.recentJoins.length)), h('div', { class: 'sub' }, 'from runs started by this manager')))),
    callout('info', 'info', r.note),
    h('div', { class: 'grid g2 mt' },
      card('Player activity sessions', 'clock', table([
        { key: 'start', label: 'Start', render: (x) => fmt.date(x.start), sort: (x) => x.start },
        { key: 'end', label: 'End', render: (x) => (x.end ? fmt.date(x.end) : badge('ongoing', 'ok')) },
        { key: 'dur', label: 'Duration', render: (x) => fmt.dur((x.end || Date.now()) - x.start) },
        { key: 'peak', label: 'Peak players', num: true },
      ], r.sessions, { empty: 'No player activity recorded yet.' })),
      card('Recent joins (server log)', 'users', table([
        { key: 'ts', label: 'Time', render: (x) => fmt.date(x.ts), sort: (x) => x.ts }, { key: 'player', label: 'Player' }, { key: 'run_id', label: 'Run', render: (x) => (x.run_id ? `#${x.run_id}` : '—') },
      ], r.recentJoins, { empty: 'No “Join succeeded” entries have been logged yet.' }))));
}

// ------------------------------------------------------------------ health
async function health(body, s, id) {
  let range = 3600000;
  const charts = h('div', { class: 'grid g2' });
  const rangeSeg = h('span');
  const drawSeg = () => mount(rangeSeg, seg([{ value: 3600000, label: '1 h' }, { value: 6 * 3600000, label: '6 h' }, { value: 86400000, label: '24 h' }, { value: 7 * 86400000, label: '7 d' }, { value: 30 * 86400000, label: '30 d' }], range, (v) => { range = v; drawSeg(); load(); }));
  drawSeg();
  const ind = h('div');
  mount(body, h('div', { class: 'row mb' }, h('h3', { class: 'grow' }, 'Measured history'), rangeSeg), charts, h('div', { class: 'card mt' }, h('div', { class: 'card-head' }, h('h3', null, icon('activity'), 'Indicators & thresholds')), ind));
  const chartCard = (title, ic, rows, key, opts) => h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, icon(ic), title)), lineChart(rows.map((r) => ({ t: r.t, v: r[key] === null || r[key] === undefined ? null : opts.map ? opts.map(r[key]) : r[key] })), opts));
  async function load() {
    try {
      const r = await api.call('health.history', { serverId: id, rangeMs: range, points: 240 });
      const tf = range > 86400000 ? (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : undefined;
      mount(charts,
        chartCard('CPU usage', 'cpu', r.rows, 'cpu', { format: (v) => `${v.toFixed(0)}%`, timeFormat: tf }),
        chartCard('Memory (working set)', 'memory', r.rows, 'mem', { format: (v) => fmt.bytes(v), timeFormat: tf, color: '#3987e5' }),
        chartCard('Players', 'users', r.rows, 'players', { format: (v) => v.toFixed(0), timeFormat: tf, color: '#199e70', unavailableText: 'Player counts need API access while the server runs.' }),
        chartCard('Average tick rate', 'gauge', r.rows, 'tick', { format: (v) => v.toFixed(1), timeFormat: tf, color: '#9085e9', unavailableText: 'Tick rate is reported by the server API (QueryServerState).' }),
        chartCard('Query latency', 'wifi', r.rows, 'latency', { format: (v) => `${v.toFixed(0)} ms`, timeFormat: tf, color: '#c98500', unavailableText: r.resolution === 'hourly' ? 'Latency is kept at raw resolution only.' : 'No UDP query responses recorded.' }),
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, icon('info'), 'About these charts')), h('p', null, `Resolution: ${r.resolution === 'raw' ? `${Math.round(r.bucketMs / 1000)} s buckets of raw samples` : 'hourly aggregates'}. Gaps mean the server was not running or the value could not be measured — nothing is estimated.`)));
    } catch (err) { mount(charts, callout('err', 'alertCircle', err.message)); }
    const i = await api.call('health.indicators', { serverId: id }).catch(() => null);
    if (i) mount(ind, h('div', { class: 'col' }, i.items.map((x) => h('div', { class: 'row' }, h('span', { class: `sev-dot ${x.state}` }), h('b', { style: { minWidth: '140px' } }, x.label), h('span', { class: 'muted' }, x.detail))), h('p', { class: 'small muted mt' }, 'Warning thresholds are configured in Settings → Monitoring.')));
  }
  load();
}

// ------------------------------------------------------------------ crashes
async function crashes(body, s, id) {
  const list = await api.call('servers.crashes', { serverId: id });
  const st = s.status;
  mount(body,
    h('div', { class: 'grid g3' },
      h('div', { class: 'card' }, h('div', { class: 'stat' }, h('div', { class: 'label' }, icon('alert'), 'Crashes (7 days)'), h('div', { class: 'value' }, String(list.filter((c) => Date.now() - c.at < 7 * 86400000).length)))),
      h('div', { class: 'card' }, h('div', { class: 'stat' }, h('div', { class: 'label' }, icon('restart'), 'Recovery attempts in window'), h('div', { class: 'value' }, String(st.recovery.attemptsInWindow)), h('div', { class: 'sub' }, st.recovery.pending ? 'a restart is scheduled' : s.recoveryEnabled ? 'automatic recovery enabled' : 'automatic recovery disabled'))),
      h('div', { class: 'card col' }, h('b', null, 'Manual recovery'), h('div', { class: 'row wrap' },
        actionButton('Cancel pending restart / reset counter', () => api.call('servers.cancelRecovery', { serverId: id }), { size: 'sm', iconName: 'x', successMessage: 'Recovery reset' }),
        actionButton('Repair installation', async () => { if (await confirmDialog({ title: 'Repair installation?', message: 'A backup is made, then SteamCMD validates and re-downloads damaged files. Saves are not touched.', confirmLabel: 'Repair' })) await api.call('servers.repairInstall', { serverId: id }); }, { size: 'sm', iconName: 'wrench', successMessage: 'Installation validated' })))),
    h('div', { class: 'card mt' }, h('div', { class: 'card-head' }, h('h3', null, icon('history'), 'Crash history')),
      list.length ? h('div', { class: 'timeline' }, list.map((c) => h('div', { class: 'tl-item error' },
        h('div', { class: 't' }, `${fmt.date(c.at)} · run #${c.run_id} · exit code ${c.exit_code ?? 'n/a'}`),
        h('div', { class: 'h' }, c.reason),
        c.recovery ? h('div', { class: 'd' }, `Recovery: ${c.recovery}`) : null,
        c.evidence && c.evidence.length ? h('details', null, h('summary', { class: 'small muted', style: { cursor: 'pointer' } }, 'Evidence from the log'), h('pre', { class: 'console', style: { height: 'auto', minHeight: 0, padding: '10px 14px', whiteSpace: 'pre-wrap' } }, c.evidence.join('\n'))) : null,
        c.diagnostics_path ? h('a', { class: 'small', onclick: () => api.showInFolder(c.diagnostics_path) }, 'Show diagnostics package') : null))) : h('p', { class: 'muted' }, 'No crashes recorded. 🎉')));
}

// ------------------------------------------------------------------ access
async function access(body, s, id) {
  const box = h('div');
  mount(body, box);
  const load = async () => {
    const a = await api.call('access.status', { serverId: id }).catch((e) => ({ error: e.message }));
    const acts = [];
    if (api.desktop && (!a.hasToken || a.tokenValid === false)) acts.push(actionButton('Set up automatically', async () => {
      if (!a.running) { toast('Starting the server…', 'API access can only be set up while the server runs. Try again once it shows Online.', 'info'); await api.call('servers.start', { serverId: id }).catch(() => {}); return; }
      let res;
      try { res = await api.call('access.autoSetup', { serverId: id }); } catch (e) {
        if (e.code !== 'E_ADMIN_PASSWORD_REQUIRED') throw e;
        const v = await formDialog({ title: 'Administrator password needed', intro: e.message, fields: [{ key: 'adminPassword', label: 'Administrator password', type: 'password', required: true }], submitLabel: 'Continue' });
        if (!v) return;
        res = await api.call('access.autoSetup', { serverId: id, adminPassword: v.adminPassword });
      }
      toast('API access set up', res.tokenKind === 'api' ? 'API token created, verified and stored encrypted.' : 'Access token stored encrypted.', 'success');
      if (res.generatedPassword) modal({ title: 'Administrator password', iconName: 'key', content: h('div', { class: 'col' }, h('p', null, 'The server was claimed with this generated administrator password. You need it to manage the server in-game. It is stored encrypted and can be shown again here.'), h('div', { class: 'pathbox' }, res.generatedPassword)), actions: [{ label: 'Copy', onClick: (close) => { navigator.clipboard.writeText(res.generatedPassword); toast('Copied', '', 'success'); close(); } }, { label: 'Done', kind: 'primary' }] });
      load();
    }, { kind: 'primary', iconName: 'zap' }));
    if (api.desktop && a.adminPasswordStored) acts.push(actionButton('Show admin password', async () => {
      const r = await api.call('access.revealAdminPassword', { serverId: id });
      modal({ title: 'Administrator password', iconName: 'key', content: h('div', { class: 'col' }, h('p', null, 'Use this password to manage the server from inside Satisfactory.'), h('div', { class: 'pathbox' }, r.password)), actions: [{ label: 'Copy', onClick: (close) => { navigator.clipboard.writeText(r.password); toast('Copied', '', 'success'); close(); } }, { label: 'Close', kind: 'primary' }] });
    }, { iconName: 'eye' }));
    if (api.desktop) acts.push(actionButton('Enter API token', async () => {
      const v = await formDialog({ title: 'Store an API token', intro: 'Usually not needed — “Set up automatically” creates a token for you. To use your own, paste the token (or the whole “API Token: …” line). It is verified with the server and stored encrypted.', fields: [{ key: 'token', label: 'API token', type: 'password', required: true }], submitLabel: 'Store token' });
      if (v) { await api.call('access.setToken', { serverId: id, token: v.token.trim() }); toast('Token stored', '', 'success'); load(); }
    }, { iconName: 'key' }));
    if (api.desktop && a.hasToken) acts.push(actionButton('Set player password', async () => {
      const v = await formDialog({ title: 'Player password', intro: 'Players must enter this password to join. Leave empty to remove the password.', fields: [{ key: 'password', label: 'Player password', type: 'password' }], submitLabel: 'Apply' });
      if (v) { await api.call('access.setClientPassword', { serverId: id, password: v.password }); toast('Player password updated', '', 'success'); }
    }, { iconName: 'lock' }));
    if (api.desktop && a.hasToken) acts.push(actionButton('Remove stored token', async () => { if (await confirmDialog({ title: 'Remove token?', message: 'The manager will lose API access until you sign in again.', danger: true, confirmLabel: 'Remove' })) { await api.call('access.forget', { serverId: id }); load(); } }, { kind: 'danger', iconName: 'trash' }));
    if (api.desktop && a.pinned) acts.push(actionButton('Re-trust certificate', async () => { if (await confirmDialog({ title: 'Trust a new certificate?', message: 'Only do this if you reinstalled or reset the server. The next connection will be trusted on first use.', danger: true, confirmLabel: 'Reset trust' })) { await api.call('access.resetPin', { serverId: id, confirm: true }); load(); } }, { iconName: 'shield' }));
    mount(box, h('div', { class: 'grid g2' },
      card('Server API access', 'key', h('div', { class: 'col' }, kv([
        ['Server running', a.running ? 'yes' : 'no'], ['Claimed', a.claimed === null || a.claimed === undefined ? 'unknown (server must run)' : a.claimed ? 'yes' : 'no — unclaimed'],
        ['Stored token', a.hasToken ? `${a.tokenKind || 'api'} token (encrypted)` : 'none'], ['Admin password', a.adminPasswordStored ? 'stored encrypted (automatic renewal on)' : 'not stored'], ['Token valid', a.tokenValid === null || a.tokenValid === undefined ? 'not checked' : a.tokenValid ? 'yes' : 'rejected by server'],
        ['Certificate', a.pinned ? 'pinned' : 'not yet trusted'],
      ]), a.fingerprint ? h('div', { class: 'pathbox small' }, `SHA-256 ${a.fingerprint}`) : null, a.error ? callout('warn', 'alert', a.error) : null, h('div', { class: 'row wrap' }, acts))),
      card('Why API access matters', 'info', h('div', null, h('p', null, 'With API access the manager can:'), h('ul', { class: 'muted' }, ['save the game and shut down gracefully', 'show player counts, tick rate and session info', 'apply live server options without restart', 'send console commands with results']. map((x) => h('li', null, x))),
        h('p', { class: 'small muted' }, 'Tokens are encrypted with Windows Data Protection (DPAPI). Passwords are only sent to the server and never stored.')))));
  };
  load();
}

// ------------------------------------------------------------------ connection
async function connection(body, s, id) {
  const c = await api.call('servers.connectionInfo', { serverId: id });
  const text = h('textarea', { class: 'input', style: { minHeight: '180px' }, readonly: true }, c.shareText);
  mount(body, h('div', { class: 'grid g2' },
    card('Connection details', 'link', h('div', { class: 'col' }, kv([
      ['Game port', `${c.port} (UDP + TCP)`], ['Reliable port', `${c.reliablePort} (TCP)`],
      ...c.lan.map((a) => [`LAN address (${a.name})`, a.address]),
      ['Public address', c.publicAddress || 'not set — enter it under Configuration'],
    ]), callout('info', 'globe', 'For players outside your network, forward the ports above on your router to this PC.'))),
    card('Share with players', 'users', h('div', { class: 'col' }, text, h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => navigator.clipboard.writeText(c.shareText).then(() => toast('Instructions copied', '', 'success')) }, icon('copy'), 'Copy instructions'),
      actionButton('Export server info', async () => { const info = await api.call('servers.exportInfo', { serverId: id }); await api.saveText(`${s.name.replace(/[^\w-]+/g, '_')}-server-info.json`, JSON.stringify(info, null, 2), [{ name: 'JSON', extensions: ['json'] }]); }, { iconName: 'download' }))))));
}
