// Performance analysis: run timings, per-run resource use, benchmarks & reports.
import { h, mount, fmt } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { badge, table, callout, actionButton, formDialog, toast, empty, card, kv } from '../ui.js';
import { serverPicker } from './common.js';

const st = (x, f = (v) => v.toFixed(1)) => (x ? `${f(x.avg)} avg · ${f(x.max)} max` : 'not measured');

export async function render(page, [sid], { setTitle, navigate }) {
  setTitle('Performance');
  const servers = await api.call('servers.list');
  if (!servers.length) { mount(page, empty({ title: 'No servers', text: 'Add a server first.' })); return undefined; }
  const id = sid && servers.find((x) => x.id === sid) ? sid : servers[0].id;
  const body = h('div');
  mount(page, h('div', { class: 'page-head' }, h('div', { class: 'titles' }, h('h1', null, 'Performance analysis'), h('p', null, 'Reports are built only from samples this manager actually recorded.')),
    h('div', { class: 'actions' }, serverPicker(servers, id, (v) => navigate(`performance/${v}`)),
      actionButton('Record benchmark', async () => { const v = await formDialog({ title: 'Record a benchmark', intro: 'Measurements of the running server are collected for the chosen duration and summarised into a report.', fields: [{ key: 'name', label: 'Name', required: true, value: `Benchmark ${new Date().toLocaleDateString()}` }, { key: 'durationMinutes', label: 'Duration (minutes)', type: 'number', value: 30 }] }); if (v) { await api.call('bench.start', { serverId: id, name: v.name, durationMinutes: Math.max(1, Math.round(v.durationMinutes)) }); toast('Recording started', '', 'success'); load(); } }, { kind: 'primary', iconName: 'benchmark' }))), body);
  async function load() {
    const [timings, runs, benches] = await Promise.all([api.call('bench.timings', { serverId: id }), api.call('servers.runs', { serverId: id }), api.call('bench.list', { serverId: id })]);
    mount(body,
      h('div', { class: 'grid g3' },
        card('Startup time', 'rocket', h('div', { class: 'stat' }, h('div', { class: 'value' }, timings.startupMs ? fmt.dur(timings.startupMs.avg) : '—'), h('div', { class: 'sub' }, timings.startupMs ? `fastest ${fmt.dur(timings.startupMs.min)} · slowest ${fmt.dur(timings.startupMs.max)} · ${timings.startupMs.n} runs` : 'from launch to first query response'))),
        card('Shutdown time', 'power', h('div', { class: 'stat' }, h('div', { class: 'value' }, timings.shutdownMs ? fmt.dur(timings.shutdownMs.avg) : '—'), h('div', { class: 'sub' }, timings.shutdownMs ? `${timings.shutdownMs.n} graceful stops measured` : 'from stop request to process exit'))),
        card('Process uptime', 'clock', h('div', { class: 'stat' }, h('div', { class: 'value' }, timings.uptimeMs ? fmt.dur(timings.uptimeMs.avg) : '—'), h('div', { class: 'sub' }, timings.uptimeMs ? `longest ${fmt.dur(timings.uptimeMs.max)}` : 'average completed run')))),
      h('div', { class: 'card mt flush' }, h('div', { class: 'card-head', style: { padding: '16px 20px 0' } }, h('h3', null, icon('benchmark'), 'Benchmarks')), table([
        { key: 'name', label: 'Name', render: (b) => h('b', null, b.name) }, { key: 'started_at', label: 'Recorded', render: (b) => fmt.date(b.started_at), sort: (b) => b.started_at },
        { key: 'build_id', label: 'Build', render: (b) => b.build_id || '—' }, { key: 'status', label: 'Status', render: (b) => badge(b.status, b.status === 'completed' ? 'ok' : b.status === 'running' ? 'warn' : '') },
        { key: 'cpu', label: 'CPU %', render: (b) => (b.report ? st(b.report.cpu) : '…') }, { key: 'mem', label: 'Memory', render: (b) => (b.report ? st(b.report.memBytes, fmt.bytes) : '…') },
        { key: 'players', label: 'Players', render: (b) => (b.report && b.report.players ? `${b.report.players.max} max` : 'n/a') }, { key: 'tick', label: 'Tick rate', render: (b) => (b.report ? st(b.report.tickRate) : '…') },
        { key: 'act', label: '', render: (b) => h('div', { class: 'row' }, b.status === 'running' ? actionButton('Stop', async () => { await api.call('bench.finish', { id: b.id }); load(); }, { size: 'sm' }) : null,
          b.report ? actionButton('CSV', async () => api.saveText(`${b.name}.csv`, await api.call('bench.csv', { id: b.id }), [{ name: 'CSV', extensions: ['csv'] }]), { size: 'sm', iconName: 'download' }) : null,
          b.report ? actionButton('JSON', async () => api.saveText(`${b.name}.json`, JSON.stringify(b, null, 2), [{ name: 'JSON', extensions: ['json'] }]), { size: 'sm', iconName: 'download' }) : null,
          actionButton('', async () => { await api.call('bench.remove', { id: b.id }); load(); }, { size: 'sm', iconName: 'trash', title: 'Delete' })) },
      ], benches, { empty: 'No benchmarks yet. Record one while the server runs to compare builds, mods or settings.' })),
      benches.filter((b) => b.report && b.report.samples).length >= 2 ? h('div', { class: 'card mt' }, h('div', { class: 'card-head' }, h('h3', null, icon('compare'), 'Comparison')), table([{ key: 'name', label: 'Benchmark' }, { key: 'build', label: 'Build', render: (b) => b.build_id || '—' }, ...['cpu', 'memBytes', 'tickRate', 'latencyMs'].map((k) => ({ key: k, label: { cpu: 'CPU avg %', memBytes: 'Memory avg', tickRate: 'Tick avg', latencyMs: 'Latency avg' }[k], num: true, render: (b) => (b.report[k] ? (k === 'memBytes' ? fmt.bytes(b.report[k].avg) : b.report[k].avg.toFixed(1)) : 'n/a') }))], benches.filter((b) => b.report && b.report.samples))) : null,
      h('div', { class: 'card mt flush' }, h('div', { class: 'card-head', style: { padding: '16px 20px 0' } }, h('h3', null, icon('history'), 'Runs')), table([
        { key: 'id', label: 'Run', render: (r) => `#${r.id}` }, { key: 'started_at', label: 'Started', render: (r) => fmt.date(r.started_at), sort: (r) => r.started_at },
        { key: 'trigger', label: 'Trigger' }, { key: 'outcome', label: 'Outcome', render: (r) => badge(r.outcome || 'running', r.outcome === 'stopped' ? 'ok' : r.outcome === 'running' ? 'info' : 'err') },
        { key: 'up', label: 'Startup', render: (r) => fmt.dur(r.startupMs) }, { key: 'down', label: 'Shutdown', render: (r) => fmt.dur(r.shutdownMs) },
        { key: 'cpu', label: 'CPU avg/max', render: (r) => (r.metrics.n ? `${(r.metrics.cpu_avg ?? 0).toFixed(1)} / ${(r.metrics.cpu_max ?? 0).toFixed(1)}%` : 'n/a') },
        { key: 'mem', label: 'Memory max', render: (r) => (r.metrics.mem_max ? fmt.bytes(r.metrics.mem_max) : 'n/a') },
        { key: 'exit', label: 'Exit', render: (r) => (r.exit_code === null || r.exit_code === undefined ? '—' : String(r.exit_code)) },
      ], runs, { empty: 'No runs recorded yet.' })),
      api.desktop ? h('div', { class: 'row mt' }, actionButton('Export runs report (CSV)', async () => { const csv = ['run,started,trigger,outcome,startup_ms,shutdown_ms,cpu_avg,cpu_max,mem_max_bytes,exit_code', ...runs.map((r) => [r.id, new Date(r.started_at).toISOString(), r.trigger, r.outcome, r.startupMs ?? '', r.shutdownMs ?? '', r.metrics.cpu_avg ?? '', r.metrics.cpu_max ?? '', r.metrics.mem_max ?? '', r.exit_code ?? ''].join(','))].join('\r\n'); await api.saveText('server-runs.csv', csv, [{ name: 'CSV', extensions: ['csv'] }]); }, { iconName: 'download' })) : null);
  }
  load().catch((e) => mount(body, callout('err', 'alertCircle', e.message)));
}
