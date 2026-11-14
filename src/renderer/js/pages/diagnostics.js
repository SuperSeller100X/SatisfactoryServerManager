// Smart diagnostic assistant: evidence, severity, solution, safe repair + verification.
import { h, mount, fmt } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { badge, callout, actionButton, confirmDialog, toast, empty } from '../ui.js';
import { serverPicker } from './common.js';

const SEV = { critical: 'Critical', error: 'Problem', warning: 'Warning', info: 'Note', ok: 'OK' };

export async function render(page, [sid], { setTitle, navigate }) {
  setTitle('Diagnostics');
  const servers = await api.call('servers.list');
  let id = sid && servers.find((s) => s.id === sid) ? sid : servers[0] ? servers[0].id : null;
  const body = h('div');
  mount(page, h('div', { class: 'page-head' }, h('div', { class: 'titles' }, h('h1', null, 'Diagnostic assistant'), h('p', null, 'Finds common problems, explains them in plain language and fixes what can be fixed safely.')),
    h('div', { class: 'actions' }, servers.length ? serverPicker(servers, id, (v) => { id = v; navigate(`diagnostics/${v}`); }) : null, actionButton('Run diagnostics', () => run(), { kind: 'primary', iconName: 'stethoscope' }),
      api.desktop && id ? actionButton('Export report', async () => { const dest = await api.pickSaveFile({ title: 'Save diagnostics report', defaultPath: 'ssm-diagnostics.json', filters: [{ name: 'JSON', extensions: ['json'] }] }); if (dest) { await api.call('diagnostics.export', { serverId: id, dest }); toast('Report saved', dest, 'success'); } }, { iconName: 'download' }) : null)), body);
  async function run() {
    mount(body, h('div', { class: 'card' }, h('div', { class: 'muted' }, 'Inspecting SteamCMD, server files, processes, API, ports, firewall, disk, saves, mods, crashes, logs and configuration…')));
    const r = await api.call('diagnostics.run', id ? { serverId: id } : {});
    const problems = r.findings.filter((f) => f.severity !== 'ok');
    mount(body,
      h('div', { class: 'grid g4 mb' }, ['critical', 'error', 'warning', 'info'].map((k) => h('div', { class: 'card' }, h('div', { class: 'stat' }, h('div', { class: 'label' }, h('span', { class: `sev-dot ${k}` }), SEV[k]), h('div', { class: 'value' }, String(r.summary[k] || 0)))))),
      problems.length ? null : h('div', { class: 'card mb' }, empty({ title: 'No problems found', text: `All ${r.results.length} checks passed in ${(r.durationMs / 1000).toFixed(1)} s.`, illustration: 'review' })),
      h('div', { class: 'col' }, problems.map((f) => finding(f))),
      h('div', { class: 'card mt' }, h('div', { class: 'card-head' }, h('h3', null, icon('check'), 'Checks performed')), h('div', { class: 'facts' }, r.results.map((c) => { const worst = c.findings.reduce((a, b) => (['critical', 'error', 'warning', 'info', 'ok'].indexOf(b.severity) < ['critical', 'error', 'warning', 'info', 'ok'].indexOf(a) ? b.severity : a), 'ok'); return h('div', null, h('span', null, c.label), h('span', null, h('span', { class: `sev-dot ${worst}` }), ' ', SEV[worst])); }))),
      h('p', { class: 'small muted mt' }, `Ran ${fmt.date(r.ranAt)}.`));
  }
  function finding(f) {
    const res = h('div');
    return h('div', { class: 'card' },
      h('div', { class: 'row' }, h('span', { class: `sev-dot ${f.severity}` }), h('h3', { class: 'grow' }, f.title), badge(SEV[f.severity], f.severity)),
      h('p', { style: { marginTop: '8px' } }, f.explanation),
      f.evidence.length ? h('details', { open: f.severity === 'critical' }, h('summary', { class: 'small muted', style: { cursor: 'pointer' } }, 'Evidence'), h('pre', { class: 'pathbox', style: { whiteSpace: 'pre-wrap', marginTop: '6px' } }, f.evidence.join('\n'))) : null,
      f.solution ? h('div', { class: 'callout info mt' }, icon('wrench'), h('div', null, h('b', null, 'Recommended: '), f.solution)) : null,
      f.repair && api.desktop ? h('div', { class: 'row mt' }, actionButton(f.repair.label, async () => {
        if (f.repair.needsConfirm && !(await confirmDialog({ title: f.repair.label, message: f.repair.description, confirmLabel: 'Run repair', danger: !f.repair.safe }))) return;
        const r = await api.call('diagnostics.repair', { serverId: id, finding: f, confirm: true });
        mount(res, callout(r.repaired ? 'ok' : 'warn', r.repaired ? 'check' : 'alert', r.message));
        toast(r.repaired ? 'Repair verified' : 'Problem still present', r.message, r.repaired ? 'success' : 'warning');
      }, { kind: 'primary', size: 'sm', iconName: 'wrench' }), h('span', { class: 'small muted' }, f.repair.description)) : null, res);
  }
  run().catch((e) => mount(body, callout('err', 'alertCircle', e.message)));
}
