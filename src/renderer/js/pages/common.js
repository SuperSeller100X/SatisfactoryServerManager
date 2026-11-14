// Shared server actions with the confirmation flows the backend requires.
import { h } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { toast, toastError, confirmDialog } from '../ui.js';

export async function startServer(id) {
  try { await api.call('servers.start', { serverId: id }); toast('Server starting', 'It will show “Online” once it responds.', 'success'); } catch (err) { toastError(err, 'Could not start'); }
}

export async function stopServer(id, name) {
  try { await api.call('servers.stop', { serverId: id }); toast(`${name || 'Server'} stopped`, '', 'success'); } catch (err) {
    if (err.code === 'E_NO_GRACEFUL_STOP') {
      const ok = await confirmDialog({ title: 'Force stop?', message: err.message, confirmLabel: 'Force stop', danger: true, details: 'The process will be terminated immediately. Progress since the last autosave may be lost.' });
      if (ok) { try { await api.call('servers.stop', { serverId: id, force: true }); toast('Server terminated', '', 'warning'); } catch (e) { toastError(e); } }
    } else toastError(err, 'Could not stop');
  }
}

export async function restartServer(id) {
  try { await api.call('servers.restart', { serverId: id }); toast('Restarting', '', 'success'); } catch (err) { toastError(err, 'Restart failed'); }
}

export function controls(s, { size = 'sm' } = {}) {
  const st = s.status.status;
  const active = ['running', 'starting', 'stopping', 'attached'].includes(st);
  const btn = (label, ic, fn, kind = '', disabled = false) => {
    const b = h('button', { class: `btn ${kind} ${size}`, disabled: disabled || !!s.status.busy, title: label }, icon(ic), label);
    b.addEventListener('click', async (e) => { e.stopPropagation(); b.disabled = true; await fn(); b.disabled = false; });
    return b;
  };
  return [
    !active ? btn('Start', 'play', () => startServer(s.id), 'success', !s.build) : btn('Stop', 'stop', () => stopServer(s.id, s.name), 'danger', st === 'stopping'),
    btn('Restart', 'restart', () => restartServer(s.id), '', !active || st === 'stopping'),
  ];
}

export function serverPicker(servers, value, onChange) {
  const sel = h('select', { class: 'input', style: { width: '240px' } }, servers.map((s) => h('option', { value: s.id, selected: s.id === value }, s.name)));
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

export async function loadServers() { return api.call('servers.list'); }
