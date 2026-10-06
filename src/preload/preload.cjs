const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Map();
ipcRenderer.on('pdlv:event', (_e, type, payload) => {
  for (const cb of listeners.get(type) ?? []) cb(payload);
});

// Les erreurs ne traversent pas fidèlement le contextBridge : on renvoie { ok, result | error }
// et c'est l'interface (renderer/js/api.js) qui transforme en exception.
contextBridge.exposeInMainWorld('pdlv', {
  invoke: (method, ...args) => ipcRenderer.invoke('pdlv', method, ...args),
  on(type, cb) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(cb);
    return () => listeners.get(type).delete(cb);
  },
});
