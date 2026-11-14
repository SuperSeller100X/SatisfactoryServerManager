'use strict';
/**
 * Narrow preload bridge (sandboxed). The renderer gets exactly these functions;
 * no Node.js or Electron objects are exposed. Every RPC is validated and
 * authorised again in the main process.
 */
const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Map();
ipcRenderer.on('event', (_e, evt) => {
  if (!evt || typeof evt.topic !== 'string') return;
  for (const cb of listeners.get(evt.topic) || []) { try { cb(evt.payload); } catch { /* listener error */ } }
  for (const cb of listeners.get('*') || []) { try { cb(evt); } catch { /* listener error */ } }
});

const unwrap = (res) => {
  if (res && res.ok) return res.result;
  const err = new Error(res && res.error ? res.error.message : 'Request failed');
  err.code = res && res.error ? res.error.code : 'E_INTERNAL';
  err.details = res && res.error ? res.error.details : undefined;
  throw err;
};

contextBridge.exposeInMainWorld('ssm', Object.freeze({
  transport: 'desktop',
  platform: process.platform,
  invoke: (channel, payload) => ipcRenderer.invoke('rpc', { channel: String(channel), payload }).then(unwrap),
  on: (topic, cb) => {
    if (typeof cb !== 'function') return () => {};
    const key = String(topic);
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(cb);
    return () => listeners.get(key).delete(cb);
  },
  pickDirectory: (opts = {}) => ipcRenderer.invoke('dialog', { kind: 'directory', title: opts.title, defaultPath: opts.defaultPath }).then(unwrap),
  pickFile: (opts = {}) => ipcRenderer.invoke('dialog', { kind: 'file', title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters }).then(unwrap),
  pickSaveFile: (opts = {}) => ipcRenderer.invoke('dialog', { kind: 'save', title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters }).then(unwrap),
  saveText: (suggestedName, text, filters) => ipcRenderer.invoke('saveText', { suggestedName, text, filters }).then(unwrap),
  openExternal: (url) => ipcRenderer.invoke('openExternal', String(url)).then(unwrap),
  showInFolder: (p) => ipcRenderer.invoke('openPath', String(p)).then(unwrap),
}));
