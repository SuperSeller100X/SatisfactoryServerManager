// Transport-agnostic API: Electron preload bridge in the desktop app, HTTPS +
// CSRF-protected JSON RPC and Server-Sent Events in the browser dashboard.
const desktop = typeof window.ssm === 'object' && window.ssm && window.ssm.transport === 'desktop';
let csrf = null;
const listeners = new Map();
let es = null;

function emit(topic, payload) {
  for (const cb of listeners.get(topic) || []) { try { cb(payload); } catch (e) { console.error(e); } }
}

export const api = {
  desktop,
  web: !desktop,
  async call(channel, payload) {
    if (desktop) return window.ssm.invoke(channel, payload);
    const res = await fetch('/api/rpc', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf || '' }, body: JSON.stringify({ channel, payload }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(body.error || `HTTP ${res.status}`); e.code = body.code; if (res.status === 401) emit('auth.expired', {}); throw e; }
    return body.result;
  },
  on(topic, cb) {
    if (desktop) return window.ssm.on(topic, cb);
    if (!listeners.has(topic)) listeners.set(topic, new Set());
    listeners.get(topic).add(cb);
    if (es && !es.__topics.has(topic) && topic !== 'auth.expired') { es.__topics.add(topic); es.addEventListener(topic, (m) => { try { emit(topic, JSON.parse(m.data)); } catch { /* bad event */ } }); }
    return () => listeners.get(topic).delete(cb);
  },
  // ----- web session helpers
  async session() { const r = await fetch('/api/session', { credentials: 'same-origin' }); const b = await r.json(); if (b.csrf) csrf = b.csrf; return b; },
  async login(username, password) {
    const r = await fetch('/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b.error || 'Sign-in failed');
    csrf = b.csrf;
    return b;
  },
  async logout() { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf || '' }, body: '{}' }); csrf = null; },
  connectEvents() {
    if (desktop || es) return;
    es = new EventSource('/api/events', { withCredentials: true });
    es.__topics = new Set();
    for (const topic of listeners.keys()) { if (topic === 'auth.expired') continue; es.__topics.add(topic); es.addEventListener(topic, (m) => { try { emit(topic, JSON.parse(m.data)); } catch { /* bad event */ } }); }
  },
  // ----- desktop-only helpers
  pickDirectory: (o) => (desktop ? window.ssm.pickDirectory(o) : Promise.reject(new Error('Only available in the desktop app'))),
  pickFile: (o) => (desktop ? window.ssm.pickFile(o) : Promise.reject(new Error('Only available in the desktop app'))),
  pickSaveFile: (o) => (desktop ? window.ssm.pickSaveFile(o) : Promise.reject(new Error('Only available in the desktop app'))),
  async saveText(name, text, filters) {
    if (desktop) return window.ssm.saveText(name, text, filters);
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return name;
  },
  openExternal: (url) => (desktop ? window.ssm.openExternal(url) : window.open(url, '_blank', 'noopener,noreferrer')),
  showInFolder: (p) => (desktop ? window.ssm.showInFolder(p) : Promise.resolve()),
};
