// Advanced mod management on top of the official FICSIT repository.
import { h, s, mount, fmt, debounce } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { badge, table, callout, actionButton, confirmDialog, toast, tabs, modal, empty, formDialog } from '../ui.js';
import { serverPicker } from './common.js';

export async function render(page, [sid, tab = 'installed'], { setTitle, navigate }) {
  setTitle('Mods');
  const servers = await api.call('servers.list');
  if (!servers.length) { mount(page, empty({ title: 'No servers', text: 'Add a server first.' })); return undefined; }
  const id = sid && servers.find((x) => x.id === sid) ? sid : servers[0].id;
  const body = h('div');
  mount(page, h('div', { class: 'page-head' }, h('div', { class: 'titles' }, h('h1', null, 'Mod manager'), h('p', null, 'Dedicated-server builds from ficsit.app only, verified by SHA-256.')),
    h('div', { class: 'actions' }, serverPicker(servers, id, (v) => navigate(`mods/${v}/${tab}`)))),
  tabs([{ key: 'installed', label: 'Installed', icon: 'puzzle' }, { key: 'browse', label: 'Browse FICSIT', icon: 'search' }, { key: 'graph', label: 'Dependencies', icon: 'graph' }, { key: 'history', label: 'History & rollback', icon: 'history' }, { key: 'profiles', label: 'Mod profiles', icon: 'layers' }], tab, (k) => navigate(`mods/${id}/${k}`)), body);
  const views = { installed, browse, graph, history, profiles };
  await (views[tab] || installed)(body, id, navigate);
  return api.on('mods.changed', (p) => { if (p.serverId === id) (views[tab] || installed)(body, id, navigate); });
}

async function installPlan(id, requests) {
  const plan = await api.call('mods.resolve', { serverId: id, requests });
  if (plan.conflicts.length) { modal({ title: 'Cannot install', iconName: 'alert', content: h('div', { class: 'col' }, plan.conflicts.map((c) => callout('err', 'alertCircle', c.message))), actions: [{ label: 'Close' }] }); return; }
  if (!plan.actions.length) { toast('Nothing to do', 'Everything is already installed.', 'info'); return; }
  const ok = await confirmDialog({ title: 'Review installation', confirmLabel: 'Install', message: h('div', { class: 'col' },
    table([{ key: 'name', label: 'Mod' }, { key: 'current', label: 'Installed', render: (a) => a.current || '—' }, { key: 'version', label: 'Will install' }, { key: 'c', label: 'Client', render: (a) => (a.requiredOnClient ? badge('players need it too', 'warn') : badge('server only', 'ok')) }], plan.actions),
    ...plan.warnings.map((w) => callout('warn', 'alert', w)),
    plan.clientNotice.length ? callout('info', 'users', `Players must also install: ${plan.clientNotice.join(', ')} (e.g. with Satisfactory Mod Manager).`) : null,
    h('p', { class: 'small muted' }, 'Affected mod folders are snapshotted first so the change can be rolled back.')) });
  if (!ok) return;
  const r = await api.call('mods.apply', { serverId: id, requests });
  toast('Mods installed', r.changed.map((c) => `${c.reference} ${c.to}`).join(', '), 'success');
}

async function installed(body, id) {
  mount(body, h('div', { class: 'muted' }, 'Loading installed mods…'));
  const a = await api.call('mods.installed', { serverId: id });
  const compat = h('div');
  mount(body,
    a.issues.length ? h('div', { class: 'col mb' }, a.issues.map((i) => callout(i.severity === 'error' ? 'err' : 'warn', 'alert', i.message))) : null,
    h('div', { class: 'row mb' }, h('span', { class: 'grow muted' }, `${a.mods.length} mod(s) installed. The server must be stopped to change mods.`),
      actionButton('Check compatibility', async () => drawCompat(await api.call('mods.compatibility', { serverId: id })), { iconName: 'check' }),
      actionButton('Verify integrity', async () => { const r = await api.call('mods.integrity', { serverId: id }); const bad = r.results.filter((x) => !x.ok); toast(bad.length ? `${bad.length} mod(s) changed on disk` : 'All managed mod files match their checksums', bad.map((b) => b.reference).join(', ') + (r.unmanaged.length ? ` · not installed by manager: ${r.unmanaged.join(', ')}` : ''), bad.length ? 'warning' : 'success'); }, { iconName: 'shieldCheck' }),
      actionButton('Update all', async () => { const u = await api.call('mods.checkUpdates', { serverId: id }); if (!u.updates.length) { toast('All mods are up to date', '', 'success'); return; } await installPlan(id, u.updates.map((x) => ({ reference: x.reference, version: x.latest }))); }, { kind: 'primary', iconName: 'update' })),
    h('div', { class: 'card flush' }, table([
      { key: 'name', label: 'Mod', render: (m) => h('div', null, h('b', null, m.name), h('div', { class: 'small muted mono' }, m.reference)), sort: (m) => m.name },
      { key: 'version', label: 'Version', render: (m) => m.version || badge('unknown', 'warn') },
      { key: 'managed', label: 'Source', render: (m) => (m.managed ? badge('installed by manager', 'ok') : badge('manual', '')) },
      { key: 'deps', label: 'Requires', render: (m) => h('span', { class: 'small' }, m.dependencies.filter((d) => !d.optional).map((d) => `${d.reference} ${d.condition}`).join(', ') || '—') },
      { key: 'act', label: '', render: (m) => actionButton('Remove', async () => {
        if (!(await confirmDialog({ title: `Remove ${m.name}?`, message: 'The mod folder is snapshotted first so it can be restored from History.', danger: true, confirmLabel: 'Remove' }))) return;
        try { await api.call('mods.remove', { serverId: id, reference: m.reference }); } catch (e) { if (e.code === 'E_MOD_DEPENDENTS' && await confirmDialog({ title: 'Other mods depend on it', message: e.message, danger: true, confirmLabel: 'Remove anyway' })) await api.call('mods.remove', { serverId: id, reference: m.reference, force: true }); else if (e.code !== 'E_MOD_DEPENDENTS') throw e; }
      }, { size: 'sm', kind: 'danger', iconName: 'trash' }) },
    ], a.mods, { empty: 'No mods installed. Browse FICSIT to add dedicated-server mods.' })), compat);
  function drawCompat(c) {
    mount(compat, h('div', { class: 'card mt' }, h('div', { class: 'card-head' }, h('h3', null, icon('check'), `Compatibility with server changelist ${c.netCL || 'unknown'}`)), !c.netCL ? callout('warn', 'alert', 'Start the server once so its game changelist is known; until then game-version compatibility cannot be evaluated.') : null,
      table([{ key: 'name', label: 'Mod' }, { key: 'installed', label: 'Installed' }, { key: 'latestCompatible', label: 'Latest compatible', render: (m) => m.latestCompatible || '—' },
        { key: 'srv', label: 'Server build', render: (m) => (m.error ? badge(m.error, 'warn') : !m.compat ? badge('not in repository', '') : m.compat.serverBuild ? badge('yes', 'ok') : badge('no', 'err')) },
        { key: 'game', label: 'Game version', render: (m) => (!m.compat ? '—' : m.compat.gameCompatible === null ? badge('unknown', '') : m.compat.gameCompatible ? badge('compatible', 'ok') : badge('incompatible', 'err')) },
        { key: 'cl', label: 'Client', render: (m) => (!m.compat ? '—' : m.compat.requiredOnClient ? badge('required on clients', 'warn') : badge('server only', 'ok')) }], c.mods)));
  }
}

async function browse(body, id) {
  let q = ''; let offset = 0; let order = 'popularity';
  const searchIn = h('input', { class: 'input', placeholder: 'Search mods on ficsit.app…', style: { maxWidth: '420px' } });
  const orderSel = h('select', { class: 'input', style: { width: '180px' } }, [['popularity', 'Popular'], ['downloads', 'Most downloaded'], ['last_version_date', 'Recently updated'], ['hotness', 'Trending'], ['name', 'Name']].map(([v, l]) => h('option', { value: v }, l)));
  const grid = h('div', { class: 'grid cards' });
  const more = h('div', { class: 'center mt' });
  mount(body, h('div', { class: 'row mb' }, searchIn, orderSel, h('span', { class: 'small muted grow' }, 'Data from api.ficsit.app')), grid, more);
  const load = async (append) => {
    if (!append) { offset = 0; mount(grid, h('div', { class: 'muted' }, 'Searching…')); }
    try {
      const r = await api.call('mods.search', { search: q, offset, orderBy: order });
      const cards = r.mods.map((m) => h('div', { class: 'card col', style: { cursor: 'pointer' }, onclick: () => details(m.mod_reference) },
        h('div', { class: 'row' }, m.logo && /^https:\/\/storage\.ficsit\.app\//.test(m.logo) ? h('img', { src: m.logo, alt: '', width: 44, height: 44, style: { borderRadius: '10px', objectFit: 'cover' } }) : h('div', { class: 'avatar' }, icon('puzzle')), h('div', { class: 'grow' }, h('b', null, m.name), h('div', { class: 'small muted' }, `${m.mod_reference} · ${fmt.num(m.downloads)} downloads`))),
        h('p', { class: 'small' }, m.short_description),
        h('div', { class: 'row wrap' }, m.latest ? badge(`v${m.latest}`, '') : null, m.serverSupport ? badge('Dedicated server', 'ok', 'server') : badge('No server build', 'err'), m.clientSupport ? badge('Client', 'info') : null)));
      if (append) cards.forEach((c) => grid.appendChild(c)); else mount(grid, cards.length ? cards : empty({ title: 'No mods found', text: 'Try another search.' }));
      offset += r.mods.length;
      mount(more, offset < r.count ? h('button', { class: 'btn', onclick: () => load(true) }, 'Load more') : null);
    } catch (e) { mount(grid, callout('err', 'alertCircle', `The FICSIT repository could not be reached: ${e.message}`)); }
  };
  searchIn.addEventListener('input', debounce(() => { q = searchIn.value.trim(); load(false); }, 400));
  orderSel.addEventListener('change', () => { order = orderSel.value; load(false); });
  load(false);
  async function details(ref) {
    const m = await api.call('mods.get', { reference: ref, serverId: id });
    modal({ title: m.name, wide: true, content: h('div', { class: 'col' },
      h('p', null, m.short_description),
      h('div', { class: 'row wrap' }, h('span', { class: 'small muted' }, `By ${(m.authors || []).map((a) => a.user.username).join(', ') || 'unknown'}`), m.source_url ? h('a', { class: 'small', onclick: () => api.openExternal(m.source_url) }, 'Source') : null, h('a', { class: 'small', onclick: () => api.openExternal(`https://ficsit.app/mod/${m.mod_reference}`) }, 'ficsit.app page')),
      !m.netCL ? callout('warn', 'alert', 'The server changelist is unknown (start the server once); compatibility with the game version cannot be checked yet.') : null,
      table([{ key: 'version', label: 'Version' }, { key: 'game_version', label: 'Game', render: (v) => h('span', { class: 'mono small' }, v.game_version) }, { key: 'created_at', label: 'Released', render: (v) => fmt.date(Date.parse(v.created_at)) },
        { key: 'c', label: 'Compatibility', render: (v) => h('div', { class: 'row wrap' }, v.compat.serverBuild ? badge(m.target, 'ok') : badge('no server build', 'err'), v.compat.gameCompatible === false ? badge('incompatible game version', 'err') : v.compat.gameCompatible ? badge('game ok', 'ok') : null, v.compat.requiredOnClient ? badge('clients need it', 'warn') : null) },
        { key: 'i', label: '', render: (v) => actionButton('Install', () => installPlan(id, [{ reference: m.mod_reference, version: v.version }]), { size: 'sm', kind: 'primary', disabled: !v.compat.installable }) }], m.versions.slice(0, 25))),
    actions: [{ label: 'Close' }] });
  }
}

async function graph(body, id) {
  const a = await api.call('mods.installed', { serverId: id });
  if (!a.mods.length) { mount(body, empty({ title: 'No mods installed', text: 'Dependencies appear here once mods are installed.', illustration: 'empty' })); return; }
  // Layered layout: depth = longest dependency chain to the node.
  const deps = new Map(a.graph.nodes.map((n) => [n.id, a.graph.edges.filter((e) => e.from === n.id).map((e) => e.to)]));
  const depth = new Map();
  const d = (nId, seen = new Set()) => { if (depth.has(nId)) return depth.get(nId); if (seen.has(nId)) return 0; seen.add(nId); const v = (deps.get(nId) || []).reduce((mx, x) => Math.max(mx, d(x, seen) + 1), 0); depth.set(nId, v); return v; };
  a.graph.nodes.forEach((n) => d(n.id));
  const layers = new Map();
  for (const n of a.graph.nodes) { const l = depth.get(n.id); if (!layers.has(l)) layers.set(l, []); layers.get(l).push(n); }
  const W = 180; const H = 34; const gx = 70; const gy = 18;
  const maxRows = Math.max(...[...layers.values()].map((x) => x.length));
  const width = layers.size * (W + gx) + 40; const height = maxRows * (H + gy) + 40;
  const pos = new Map();
  [...layers.keys()].sort((x, y) => x - y).forEach((l) => layers.get(l).forEach((n, i) => pos.set(n.id, { x: 20 + l * (W + gx), y: 20 + i * (H + gy) })));
  const bad = new Set(a.issues.filter((i) => i.kind === 'version-conflict').map((i) => `${i.mod}>${i.dependency}`));
  const svg = s('svg', { class: 'graph', viewBox: `0 0 ${width} ${height}` });
  svg.style.height = `${Math.max(260, height)}px`;
  for (const e of a.graph.edges) { const p = pos.get(e.from); const q = pos.get(e.to); if (!p || !q) continue; svg.appendChild(s('path', { class: `edge ${bad.has(`${e.from}>${e.to}`) ? 'bad' : ''}`, d: `M${p.x},${p.y + H / 2} C${p.x - gx / 2},${p.y + H / 2} ${q.x + W + gx / 2},${q.y + H / 2} ${q.x + W},${q.y + H / 2}`, 'stroke-dasharray': e.optional ? '4 4' : '' }, s('title', null, `${e.from} requires ${e.to} ${e.condition}`))); }
  for (const n of a.graph.nodes) { const p = pos.get(n.id); svg.appendChild(s('g', { class: `node ${n.id === 'SML' ? 'sml' : ''}`, transform: `translate(${p.x},${p.y})` }, s('rect', { width: W, height: H, rx: 8 }), s('text', { x: 10, y: 21 }, `${n.label.slice(0, 20)} ${n.version || ''}`))); }
  mount(body, h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, icon('graph'), 'Dependency graph'), h('span', { class: 'small muted' }, 'Arrows point from a mod to what it requires. Red = version conflict, dashed = optional.')), h('div', { style: { overflow: 'auto' } }, svg)),
    a.issues.length ? h('div', { class: 'col mt' }, a.issues.map((i) => callout('err', 'alert', i.message))) : callout('ok', 'check', 'No dependency conflicts detected.'));
}

async function history(body, id) {
  const rows = await api.call('mods.history', { serverId: id });
  mount(body, h('div', { class: 'card flush' }, table([
    { key: 'ts', label: 'When', render: (r) => fmt.date(r.ts), sort: (r) => r.ts },
    { key: 'action', label: 'Action', render: (r) => badge(r.action, r.action === 'remove' ? 'warn' : r.action === 'rollback' ? 'info' : 'accent') },
    { key: 'mod_reference', label: 'Mod(s)' },
    { key: 'v', label: 'Version', render: (r) => `${r.from_version || '—'} → ${r.to_version || '—'}` },
    { key: 'status', label: 'Result', render: (r) => badge(r.status, r.status === 'completed' ? 'ok' : 'err') },
    { key: 'act', label: '', render: (r) => (r.snapshot_path ? actionButton('Restore previous state', async () => { if (!(await confirmDialog({ title: 'Roll back this change?', message: 'Mod folders are restored to the state before this change.', confirmLabel: 'Roll back' }))) return; const res = await api.call('mods.rollback', { historyId: r.id }); toast('Rolled back', res.restored.join(', '), 'success'); }, { size: 'sm', iconName: 'history' }) : null) },
  ], rows, { empty: 'No mod changes recorded yet.' })));
}

async function profiles(body, id) {
  const list = await api.call('mods.profiles');
  const cmp = h('div');
  mount(body, h('div', { class: 'row mb' }, h('span', { class: 'grow muted' }, 'A mod profile is a named list of mods and exact versions.'), actionButton('Save current mods as profile', async () => { const v = await formDialog({ title: 'Save mod profile', fields: [{ key: 'name', label: 'Profile name', required: true }] }); if (v) { await api.call('mods.saveProfile', { serverId: id, name: v.name }); profiles(body, id); } }, { kind: 'primary', iconName: 'plus' })),
    h('div', { class: 'card flush' }, table([
      { key: 'name', label: 'Profile', render: (p) => h('b', null, p.name) }, { key: 'n', label: 'Mods', render: (p) => String(p.mods.length) }, { key: 'created_at', label: 'Created', render: (p) => fmt.date(p.created_at) },
      { key: 'act', label: '', render: (p) => h('div', { class: 'row' },
        actionButton('Compare with server', async () => { const r = await api.call('mods.compareProfiles', { a: p.id, serverId: id }); mount(cmp, h('div', { class: 'card mt' }, h('h3', { class: 'mb' }, `${p.name} → current server`), table([{ key: 'name', label: 'Mod' }, { key: 'a', label: p.name, render: (x) => x.a || '—' }, { key: 'b', label: 'Server', render: (x) => x.b || '—' }, { key: 'state', label: 'Difference', render: (x) => badge(x.state, x.state === 'same' ? 'ok' : x.state === 'removed' ? 'err' : 'warn') }], r))); }, { size: 'sm', iconName: 'compare' }),
        actionButton('Apply', async () => { if (await confirmDialog({ title: `Apply profile ${p.name}?`, message: 'Missing or different mods are installed in the profile versions (a snapshot is taken first). Mods not in the profile are not removed.', confirmLabel: 'Apply' })) { await api.call('mods.applyProfile', { serverId: id, profileId: p.id }); toast('Profile applied', '', 'success'); } }, { size: 'sm', kind: 'primary' }),
        actionButton('', async () => { await api.call('mods.deleteProfile', { id: p.id }); profiles(body, id); }, { size: 'sm', iconName: 'trash', title: 'Delete' })) },
    ], list, { empty: 'No mod profiles yet.' })), cmp);
}
