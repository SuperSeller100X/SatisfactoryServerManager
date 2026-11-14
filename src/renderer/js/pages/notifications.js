// Notification center: history, read/unread, filters, preferences link.
import { h, mount, fmt } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { seg, empty, toastError, actionButton } from '../ui.js';

const ICON = { error: 'alertCircle', warning: 'alert', success: 'check', info: 'info' };
const item = (n, onRead) => h('div', { class: ['notif', n.severity, n.read ? '' : 'unread'] },
  h('div', { class: 'ico' }, icon(ICON[n.severity] || 'info')),
  h('div', { class: 'b' }, h('b', null, n.title), n.body ? h('p', null, n.body) : null, h('small', null, `${fmt.ago(n.ts)} · ${n.category}`)),
  !n.read ? h('button', { class: 'btn ghost icon sm', title: 'Mark as read', onclick: () => onRead(n) }, icon('check')) : null);

export async function renderDrawer(el, close) {
  const body = h('div', { class: 'drawer-body' });
  mount(el, h('div', { class: 'drawer-head' }, h('h2', null, 'Notifications'), h('button', { class: 'btn ghost sm', onclick: async () => { await api.call('notifications.markRead', { ids: 'all' }); load(); } }, 'Mark all read'), h('button', { class: 'btn ghost icon sm', 'aria-label': 'Close', onclick: close }, icon('x'))), body,
    h('div', { style: { padding: '12px 20px', borderTop: '1px solid var(--line)' } }, h('a', { href: '#/notifications', onclick: close }, 'Open notification center →')));
  const load = async () => {
    const r = await api.call('notifications.list', {}).catch(() => ({ items: [] }));
    mount(body, r.items.length ? r.items.slice(0, 40).map((n) => item(n, async (x) => { await api.call('notifications.markRead', { ids: [x.id] }); load(); })) : empty({ title: 'All caught up', text: 'New events appear here.' }));
  };
  load();
}

export async function render(page, _p, { setTitle, navigate }) {
  setTitle('Notifications');
  let state = 'all'; let category = '';
  const list = h('div', { class: 'card flush' });
  const stateSeg = h('span');
  const catSel = h('select', { class: 'input', style: { width: '220px' } });
  const drawSeg = () => mount(stateSeg, seg([{ value: 'all', label: 'All' }, { value: 'unread', label: 'Unread' }], state, (v) => { state = v; drawSeg(); load(); }));
  drawSeg();
  catSel.addEventListener('change', () => { category = catSel.value; load(); });
  mount(page, h('div', { class: 'page-head' }, h('div', { class: 'titles' }, h('h1', null, 'Notification center'), h('p', null, 'Crashes, backups, updates, maintenance and security events.')),
    h('div', { class: 'actions' }, stateSeg, catSel,
      actionButton('Mark all read', async () => { await api.call('notifications.markRead', { ids: 'all' }); load(); }, { iconName: 'check' }),
      actionButton('Clear history', async () => { await api.call('notifications.remove', { ids: 'all' }); load(); }, { iconName: 'trash' }),
      h('button', { class: 'btn', onclick: () => navigate('settings/notifications') }, icon('settings'), 'Preferences'))), list);
  async function load() {
    try {
      const r = await api.call('notifications.list', { unreadOnly: state === 'unread', ...(category ? { category } : {}) });
      if (!catSel.options.length) mount(catSel, h('option', { value: '' }, 'All categories'), Object.entries(r.categories).map(([k, l]) => h('option', { value: k }, l)));
      mount(list, r.items.length ? r.items.map((n) => item(n, async (x) => { await api.call('notifications.markRead', { ids: [x.id] }); load(); })) : empty({ title: 'No notifications', text: 'Nothing matches the current filter.' }));
    } catch (err) { toastError(err); }
  }
  load();
  const off = api.on('notification.new', load);
  return off;
}
