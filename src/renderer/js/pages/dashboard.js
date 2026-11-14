// Multi-server dashboard: live status cards with real telemetry.
import { h, mount, fmt } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { statusPill, badge, empty, seg } from '../ui.js';
import { sparkline } from '../charts.js';
import { controls } from './common.js';

const STATE_COLOR = { running: 'var(--ok)', attached: 'var(--info)', starting: 'var(--warn)', stopping: 'var(--warn)', crashed: 'var(--err)', stopped: 'var(--line-2)' };

export async function render(page, _p, { setTitle, navigate }) {
  setTitle('Dashboard');
  let data = { servers: [] };
  let filter = ''; let sort = 'order'; let group = true; let stateFilter = 'all';
  const spark = new Map(); // id -> cpu samples (live, measured)
  const head = h('div', { class: 'page-head' });
  const stats = h('div', { class: 'grid g4 mb' });
  const list = h('div');
  mount(page, head, stats, list);

  const search = h('input', { class: 'input', placeholder: 'Filter servers…', style: { width: '220px' }, oninput: () => { filter = search.value.toLowerCase(); draw(); } });
  const sortSel = h('select', { class: 'input', style: { width: '170px' }, onchange: () => { sort = sortSel.value; draw(); } }, [['order', 'Custom order'], ['name', 'Name'], ['status', 'Status'], ['cpu', 'CPU usage'], ['mem', 'Memory usage'], ['players', 'Players']].map(([v, l]) => h('option', { value: v }, l)));
  const groupBtn = h('button', { class: 'btn', onclick: () => { group = !group; groupBtn.classList.toggle('primary', group); draw(); } }, icon('layers'), 'Group');
  groupBtn.classList.add('primary');
  const stateSeg = h('span');
  const drawSeg = () => mount(stateSeg, seg([{ value: 'all', label: 'All' }, { value: 'online', label: 'Online' }, { value: 'offline', label: 'Offline' }, { value: 'problem', label: 'Problems' }], stateFilter, (v) => { stateFilter = v; drawSeg(); draw(); }));
  drawSeg();
  mount(head, h('div', { class: 'titles' }, h('h1', null, 'Servers'), h('p', null, 'Live status of every configured Satisfactory dedicated server.')), h('div', { class: 'actions' }, stateSeg, search, sortSel, groupBtn));

  const online = (s) => ['running', 'attached', 'starting', 'stopping'].includes(s.status.status);
  function drawStats() {
    const S = data.servers;
    const on = S.filter(online).length;
    const players = S.map((s) => s.telemetry.players).filter((x) => x !== null && x !== undefined);
    const cpu = S.map((s) => s.telemetry.cpu).filter((x) => x !== null && x !== undefined);
    const mem = S.map((s) => s.telemetry.memBytes).filter((x) => x !== null && x !== undefined);
    const tile = (label, ic, value, sub) => h('div', { class: 'card glow' }, h('div', { class: 'stat' }, h('div', { class: 'label' }, icon(ic), label), h('div', { class: 'value' }, value), h('div', { class: 'sub' }, sub)));
    mount(stats,
      tile('Online servers', 'server', h('span', null, String(on), h('small', null, `/ ${S.length}`)), S.some((s) => s.status.status === 'crashed') ? `${S.filter((s) => s.status.status === 'crashed').length} crashed` : 'all healthy states'),
      tile('Players connected', 'users', players.length ? String(players.reduce((a, b) => a + b, 0)) : h('span', { class: 'unavailable' }, 'Not available'), players.length ? `reported by ${players.length} server API(s)` : 'requires API access on a running server'),
      tile('CPU (all servers)', 'cpu', cpu.length ? fmt.pct(cpu.reduce((a, b) => a + b, 0)) : h('span', { class: 'unavailable' }, '—'), 'share of total machine CPU'),
      tile('Memory (all servers)', 'memory', mem.length ? fmt.bytes(mem.reduce((a, b) => a + b, 0)) : h('span', { class: 'unavailable' }, '—'), 'working set of server processes'));
  }

  function kpi(k, v) { return h('div', { class: 'kpi' }, h('div', { class: 'k' }, k), v === null || v === undefined ? h('div', { class: 'v na' }, 'n/a') : h('div', { class: 'v' }, v)); }

  function serverCard(s) {
    const t = s.telemetry; const st = s.status;
    const on = online(s);
    const issues = [];
    if (st.status === 'crashed') issues.push(badge('Crashed', 'err', 'alert'));
    if (s.updateAvailable) issues.push(badge('Update available', 'accent', 'update'));
    if (s.maintenance.enabled) issues.push(badge('Maintenance', 'warn', 'wrench'));
    if (!s.build) issues.push(badge('Not installed', 'err'));
    if (!s.apiAccess) issues.push(badge('No API access', '', 'key'));
    if (st.recovery.pending) issues.push(badge('Recovery scheduled', 'warn', 'restart'));
    if (st.busy) issues.push(badge(st.busy, 'warn'));
    const samples = spark.get(s.id) || [];
    const card = h('div', { class: 'card server-card', onclick: () => navigate(`server/${s.id}`), style: { cursor: 'pointer' } },
      h('div', { class: 'stripe', style: { background: STATE_COLOR[st.status] || 'var(--line-2)' } }),
      h('div', { class: 'top' },
        h('div', { class: 'avatar' }, icon('server')),
        h('div', { class: 'grow' }, h('div', { class: 'row' }, h('h3', { class: 'ellipsis grow' }, s.name), statusPill(st.busy ? st.busy : st.status)),
          h('div', { class: 'meta', style: { marginTop: '4px' } },
            h('span', null, icon('network'), `:${s.ports.game}`),
            h('span', null, icon('package'), s.build ? `Build ${s.build.buildId}` : 'not installed'),
            h('span', null, icon('globe'), s.branch),
            on ? h('span', null, icon('clock'), fmt.dur(st.uptimeMs)) : null))),
      h('div', { class: 'kpis' },
        kpi('CPU', on && t.cpu !== null ? fmt.pct(t.cpu) : null),
        kpi('Memory', on && t.memBytes !== null ? fmt.bytes(t.memBytes) : null),
        kpi('Players', on && t.players !== null ? `${t.players}${t.playerLimit ? ` / ${t.playerLimit}` : ''}` : null),
        kpi('Tick rate', on && t.tickRate !== null && t.tickRate !== undefined ? `${t.tickRate.toFixed(1)}/s` : null)),
      samples.length > 2 ? h('div', { class: 'row small muted' }, h('span', null, 'CPU (live)'), sparkline(samples, { width: 160, height: 26 })) : null,
      h('div', { class: 'facts' },
        h('div', null, h('span', null, 'Mods'), h('span', null, s.mods.count ? `${s.mods.count}${s.mods.sml ? ` · SML ${s.mods.sml}` : ' · SML missing'}` : 'none')),
        h('div', null, h('span', null, 'Last backup'), h('span', null, s.lastBackup ? fmt.ago(s.lastBackup.created_at) : 'never')),
        h('div', null, h('span', null, 'Last update'), h('span', null, s.lastUpdate ? `${fmt.ago(s.lastUpdate.ts)}${s.lastUpdate.status === 'failed' ? ' (failed)' : ''}` : s.build && s.build.lastUpdated ? fmt.ago(s.build.lastUpdated) : '—')),
        h('div', null, h('span', null, 'Responsive'), h('span', null, !on ? '—' : t.responsive === null ? 'checking…' : t.responsive ? `yes (${t.latencyMs} ms)` : 'no response'))),
      issues.length ? h('div', { class: 'row wrap' }, issues) : null,
      h('div', { class: 'foot' }, ...controls(s), h('span', { class: 'grow' }),
        h('button', { class: 'btn ghost sm', title: 'Console', onclick: (e) => { e.stopPropagation(); navigate(`server/${s.id}/console`); } }, icon('console')),
        h('button', { class: 'btn ghost sm', title: 'Settings', onclick: (e) => { e.stopPropagation(); navigate(`server/${s.id}/config`); } }, icon('settings'))));
    return card;
  }

  function draw() {
    drawStats();
    let S = data.servers.filter((s) => !filter || s.name.toLowerCase().includes(filter) || (s.group || '').toLowerCase().includes(filter));
    if (stateFilter === 'online') S = S.filter(online);
    if (stateFilter === 'offline') S = S.filter((s) => !online(s));
    if (stateFilter === 'problem') S = S.filter((s) => s.status.status === 'crashed' || !s.build || s.updateAvailable || s.status.recovery.pending);
    const order = { running: 0, attached: 0, starting: 1, stopping: 1, crashed: 2, stopped: 3 };
    const by = { name: (s) => s.name.toLowerCase(), status: (s) => order[s.status.status] ?? 4, cpu: (s) => -(s.telemetry.cpu ?? -1), mem: (s) => -(s.telemetry.memBytes ?? -1), players: (s) => -(s.telemetry.players ?? -1) };
    if (by[sort]) S = [...S].sort((a, b) => (by[sort](a) > by[sort](b) ? 1 : by[sort](a) < by[sort](b) ? -1 : 0));
    if (!data.servers.length) { mount(list, h('div', { class: 'card' }, empty({ title: 'No servers yet', text: 'Use “Add server” to install or attach a Satisfactory dedicated server.', illustration: 'empty' }))); return; }
    if (!S.length) { mount(list, h('div', { class: 'card' }, empty({ title: 'No servers match', text: 'Change the filter to see more servers.' }))); return; }
    if (!group) { mount(list, h('div', { class: 'grid cards' }, S.map(serverCard))); return; }
    const groups = new Map();
    for (const s of S) { const g = s.group || 'Ungrouped'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(s); }
    mount(list, [...groups.entries()].map(([g, items]) => h('div', { class: 'mb' }, groups.size > 1 || g !== 'Ungrouped' ? h('h4', { class: 'mb', style: { marginBottom: '10px' } }, `${g} · ${items.length}`) : null, h('div', { class: 'grid cards' }, items.map(serverCard)))));
  }

  async function load() { try { data = await api.call('dashboard.overview'); draw(); } catch (err) { mount(list, h('div', { class: 'callout err' }, icon('alertCircle'), h('div', null, err.message))); } }
  await load();
  const offs = [
    api.on('server.status', (p) => { const s = data.servers.find((x) => x.id === p.id); if (s) { s.status = { ...s.status, ...p }; draw(); } }),
    api.on('server.metrics', (p) => { const s = data.servers.find((x) => x.id === p.id); if (s) { s.telemetry = { ...s.telemetry, ...p }; const arr = spark.get(p.id) || []; arr.push(p.cpu); if (arr.length > 60) arr.shift(); spark.set(p.id, arr); draw(); } }),
    api.on('server.changed', load), api.on('backup.changed', load), api.on('update.changed', debounceLoad()),
  ];
  const timer = setInterval(load, 30000);
  function debounceLoad() { let t; return () => { clearTimeout(t); t = setTimeout(load, 800); }; }
  return () => { offs.forEach((o) => o()); clearInterval(timer); };
}
