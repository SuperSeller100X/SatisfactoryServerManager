// Application shell: routing, navigation, notification drawer and first-run gate.
import { h, mount, fmt } from './dom.js';
import { api } from './api.js';
import { icon, brandMark } from './icons.js';
import { toast, toastError, badge } from './ui.js';
import { renderWizard } from './pages/wizard.js';

const root = document.getElementById('root');
const NAV = [
  { section: 'Overview' },
  { key: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { key: 'notifications', label: 'Notifications', icon: 'bell', count: true },
  { section: 'Operations' },
  { key: 'updates', label: 'Update Center', icon: 'update' },
  { key: 'scheduler', label: 'Scheduler', icon: 'calendar' },
  { key: 'backups', label: 'Backups', icon: 'backup' },
  { key: 'mods', label: 'Mods', icon: 'puzzle' },
  { section: 'Insights' },
  { key: 'diagnostics', label: 'Diagnostics', icon: 'stethoscope' },
  { key: 'performance', label: 'Performance', icon: 'benchmark' },
  { key: 'storage', label: 'Storage', icon: 'storage' },
  { key: 'audit', label: 'Activity', icon: 'history' },
  { section: 'Configuration' },
  { key: 'profiles', label: 'Profiles & Templates', icon: 'layers' },
  { key: 'migration', label: 'Migration', icon: 'truck', desktop: true },
  { key: 'remote', label: 'Remote & Web', icon: 'remote', desktop: true },
  { key: 'settings', label: 'Settings', icon: 'settings' },
  { key: 'about', label: 'About & License', icon: 'info' },
];

const PAGES = {
  dashboard: () => import('./pages/dashboard.js'), server: () => import('./pages/server.js'), notifications: () => import('./pages/notifications.js'),
  updates: () => import('./pages/updates.js'), scheduler: () => import('./pages/scheduler.js'), backups: () => import('./pages/backups.js'),
  mods: () => import('./pages/mods.js'), diagnostics: () => import('./pages/diagnostics.js'), performance: () => import('./pages/performance.js'),
  storage: () => import('./pages/storage.js'), audit: () => import('./pages/audit.js'), profiles: () => import('./pages/profiles.js'),
  migration: () => import('./pages/migration.js'), remote: () => import('./pages/remote.js'), settings: () => import('./pages/settings.js'), about: () => import('./pages/about.js'),
};

export const app = { info: null, settings: null, unread: 0, servers: [], role: 'admin', user: null };
export function navigate(path) { location.hash = `#/${path}`; }

function applyAppearance(a) {
  const r = document.documentElement;
  r.dataset.theme = a.theme === 'system' ? 'dark' : a.theme;
  r.dataset.accent = a.accent;
  r.dataset.density = a.density;
  r.dataset.motion = a.reduceMotion ? 'reduce' : '';
}

let navEl; let contentEl; let crumbsEl; let bellCount; let dispose = null; let drawer;

function buildShell() {
  navEl = h('nav', { class: 'nav', 'aria-label': 'Main' });
  contentEl = h('div', { class: 'content', id: 'content' });
  crumbsEl = h('div', { class: 'crumbs' });
  bellCount = h('span', { class: 'n hidden' });
  drawer = h('aside', { class: 'drawer', 'aria-label': 'Notifications' });
  mount(root, h('div', { class: 'shell' },
    h('aside', { class: 'sidebar' },
      h('div', { class: 'brand' }, brandMark(), h('div', { class: 'brand-name' }, 'Satisfactory', h('br'), 'Server Manager', h('small', null, api.web ? 'Web dashboard' : 'Control center'))),
      navEl,
      h('div', { class: 'sidebar-foot' }, h('span', null, `v${app.info ? app.info.version : ''}`), api.web ? h('a', { onclick: async () => { await api.logout(); location.reload(); } }, 'Sign out') : h('span', null, app.info && app.info.platform === 'win32' ? 'Windows' : app.info ? app.info.platform : ''))),
    h('div', { class: 'main' },
      h('header', { class: 'topbar' }, crumbsEl, h('div', { class: 'spacer' }),
        api.desktop ? h('button', { class: 'btn sm', onclick: addServer }, icon('plus'), 'Add server') : null,
        h('button', { class: 'btn ghost icon bell', 'aria-label': 'Notifications', onclick: toggleDrawer }, icon('bell'), bellCount)),
      contentEl)),
  drawer);
  drawNav();
}

async function addServer() {
  const ok = await import('./ui.js').then((m) => m.confirmDialog({ title: 'Add another server', message: 'The setup assistant will guide you through installing or attaching another dedicated server. Existing servers keep running.', confirmLabel: 'Open setup assistant' }));
  if (!ok) return;
  try { await api.call('setup.reset'); startWizard(); } catch (err) { toastError(err); }
}

function drawNav() {
  const cur = (location.hash.replace(/^#\//, '') || 'dashboard').split('/')[0];
  mount(navEl, NAV.filter((n) => !(n.desktop && api.web)).map((n) => n.section ? h('div', { class: 'nav-section' }, n.section)
    : h('a', { class: cur === n.key || (cur === 'server' && n.key === 'dashboard') ? 'active' : '', href: `#/${n.key}` }, icon(n.icon), n.label, n.count && app.unread ? h('span', { class: 'count' }, String(app.unread)) : null)));
  bellCount.textContent = String(app.unread);
  bellCount.classList.toggle('hidden', !app.unread);
}

async function route() {
  const parts = (location.hash.replace(/^#\//, '') || 'dashboard').split('/').map(decodeURIComponent);
  const key = PAGES[parts[0]] ? parts[0] : 'dashboard';
  drawNav();
  if (dispose) { try { dispose(); } catch { /* ignore */ } dispose = null; }
  mount(contentEl, h('div', { class: 'page' }, h('div', { class: 'muted' }, 'Loading…')));
  try {
    const mod = await PAGES[key]();
    const page = h('div', { class: 'page' });
    mount(contentEl, page);
    contentEl.scrollTop = 0;
    const res = await mod.render(page, parts.slice(1), { setTitle, navigate });
    if (typeof res === 'function') dispose = res;
  } catch (err) {
    mount(contentEl, h('div', { class: 'page' }, h('div', { class: 'callout err' }, icon('alertCircle'), h('div', null, h('b', null, 'This page could not be loaded. '), err.message))));
  }
}

function setTitle(...parts) {
  mount(crumbsEl, ...parts.flatMap((p, i) => (i ? [h('span', null, '/'), p] : [p])));
  document.title = `${parts.map((p) => (typeof p === 'string' ? p : p.textContent)).join(' · ')} — Satisfactory Server Manager`;
}

async function toggleDrawer() {
  if (drawer.classList.contains('open')) { drawer.classList.remove('open'); return; }
  drawer.classList.add('open');
  const { renderDrawer } = await import('./pages/notifications.js');
  renderDrawer(drawer, () => drawer.classList.remove('open'));
}

async function refreshUnread() {
  try { const r = await api.call('notifications.list', { unreadOnly: true }); app.unread = r.unread; drawNav(); } catch { /* ignore */ }
}

function startWizard() {
  if (dispose) { try { dispose(); } catch { /* ignore */ } dispose = null; }
  renderWizard(root, { onDone: () => { toast('Setup complete', 'Welcome to your control center.', 'success'); location.hash = '#/dashboard'; startShell(); } });
}

let shellStarted = false;
function startShell() {
  buildShell();
  route();
  refreshUnread();
  if (!shellStarted) {
    shellStarted = true;
    window.addEventListener('hashchange', route);
    api.on('notification.new', (n) => { app.unread++; drawNav(); if (n.severity === 'error' || n.severity === 'warning') toast(n.title, n.body, n.severity === 'error' ? 'error' : 'warning'); });
    api.on('notification.changed', (x) => { app.unread = x.unread; drawNav(); });
    api.on('settings.changed', async (x) => { if (x.section === 'appearance') { app.settings = await api.call('settings.get'); applyAppearance(app.settings.appearance); } });
    api.on('operation.progress', (p) => { if (p && p.kind === 'shutdown') toast('Closing', p.message, 'warning', 60000); });
    api.on('auth.expired', () => location.reload());
    api.connectEvents();
  }
}

async function webLogin(state) {
  const user = h('input', { class: 'input', autocomplete: 'username' });
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const err = h('div');
  const form = h('form', { class: 'col', onsubmit: async (e) => {
    e.preventDefault();
    mount(err);
    try { await api.login(user.value, pw.value); location.reload(); } catch (ex) { mount(err, h('div', { class: 'callout err' }, icon('alertCircle'), h('div', null, ex.message))); }
  } }, h('label', { class: 'field' }, 'Username', user), h('label', { class: 'field' }, 'Password', pw), err, h('button', { class: 'btn primary lg', type: 'submit' }, icon('lock'), 'Sign in'));
  mount(root, h('div', { class: 'login' }, h('div', { class: 'card col' },
    h('div', { class: 'row' }, brandMark(), h('div', null, h('h2', null, 'Server Manager'), h('div', { class: 'muted small' }, 'Web dashboard'))),
    state.configured ? form : h('div', { class: 'callout info' }, icon('info'), h('div', null, 'No web dashboard accounts exist yet. Create one in the desktop app under Remote & Web.')))));
  if (state.configured) user.focus();
}

async function boot() {
  try {
    if (api.web) {
      const s = await api.session();
      if (!s.authenticated) { await webLogin(s); return; }
      app.role = s.role; app.user = s.user;
    }
    app.info = await api.call('app.info');
    app.settings = await api.call('settings.get');
    applyAppearance(app.settings.appearance);
    if (api.desktop && !app.info.firstRunComplete) { startWizard(); return; }
    startShell();
  } catch (err) {
    mount(root, h('div', { class: 'login' }, h('div', { class: 'card col' }, h('h2', null, 'Could not start'), h('p', null, err.message), h('button', { class: 'btn', onclick: () => location.reload() }, 'Retry'))));
  }
}

export { badge, fmt };
boot();
