/** Appels au processus principal (voir src/main/main.js, objet `api`). */
export async function call(method, ...args) {
  const res = await window.pdlv.invoke(method, ...args);
  if (!res.ok) {
    const err = new Error(res.error);
    err.cancelled = res.cancelled;
    err.sessionExpired = res.sessionExpired;
    throw err;
  }
  return res.result;
}

export const on = (type, cb) => window.pdlv.on(type, cb);

/** État partagé entre les vues. */
export const store = {
  info: null,
  account: null,
  status: null,
  modpack: null,
  game: { state: 'idle' },
  listeners: new Set(),
  set(patch) {
    Object.assign(this, patch);
    for (const cb of this.listeners) cb(patch);
  },
  subscribe(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  },
};
