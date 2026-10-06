import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const USER_AGENT = 'PDLV-Launcher/1.0 (+https://paysdelavaliere.fr)';

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} sur ${url}`);
    this.status = status;
    this.url = url;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new Error('Opération annulée');
}

/** Exécute `fn` sur chaque élément avec au plus `limit` appels simultanés. */
export async function pool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

export async function sha1File(file) {
  const hash = createHash('sha1');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/**
 * Vérifie qu'un fichier local correspond à ce qui est attendu.
 * mode 'size' : rapide (taille seule), mode 'sha1' : vérification complète.
 */
export async function fileMatches(file, { sha1, size }, mode = 'sha1') {
  let st;
  try {
    st = await fs.stat(file);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  if (size != null && st.size !== size) return false;
  if (mode === 'size' || !sha1) return true;
  return (await sha1File(file)) === sha1.toLowerCase();
}

/** Récupère un JSON. Si `cacheFile` est fourni, il sert de copie hors-ligne. */
export async function fetchJson(url, { cacheFile, timeout = 20000, retries = 2, noCache = false } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const target = noCache ? `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}` : url;
      const res = await fetch(target, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new HttpError(res.status, url);
      const text = await res.text();
      const data = JSON.parse(text);
      if (cacheFile) {
        await fs.mkdir(path.dirname(cacheFile), { recursive: true });
        await fs.writeFile(cacheFile, text);
      }
      return data;
    } catch (e) {
      lastErr = e;
      if (e instanceof HttpError && e.status === 404) break;
      if (attempt < retries) await sleep(600 * 2 ** attempt);
    }
  }
  if (cacheFile) {
    try {
      return JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    } catch {
      /* pas de cache utilisable */
    }
  }
  throw lastErr;
}

export async function fetchText(url, { timeout = 20000 } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new HttpError(res.status, url);
  return res.text();
}

/**
 * Télécharge un fichier vers `dest` en passant par un fichier `.part`,
 * avec contrôle SHA-1, relances et détection de blocage.
 */
export async function downloadFile(item, { onBytes, signal, retries = 3, stallTimeout = 30000 } = {}) {
  const { url, dest, sha1, sha256, size } = item;
  const algo = sha256 ? 'sha256' : 'sha1';
  const expected = (sha256 || sha1)?.toLowerCase();
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw abortError(signal);
    let received = 0;
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort(abortError(signal));
    signal?.addEventListener('abort', onAbort, { once: true });
    let timer;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => ctrl.abort(new Error(`Téléchargement bloqué : ${path.basename(dest)}`)), stallTimeout);
    };

    try {
      arm();
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok || !res.body) throw new HttpError(res.status, url);
      const hash = createHash(algo);
      const meter = new Transform({
        transform(chunk, _enc, cb) {
          arm();
          hash.update(chunk);
          received += chunk.length;
          onBytes?.(chunk.length);
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body), meter, createWriteStream(part), { signal: ctrl.signal });
      clearTimeout(timer);

      const digest = hash.digest('hex');
      if (expected && digest !== expected) {
        throw new Error(`Fichier corrompu (somme de contrôle invalide) : ${path.basename(dest)}`);
      }
      if (!expected && size != null && received !== size) {
        throw new Error(`Taille inattendue pour ${path.basename(dest)}`);
      }
      await fs.rename(part, dest);
      return;
    } catch (e) {
      clearTimeout(timer);
      onBytes?.(-received);
      await fs.rm(part, { force: true }).catch(() => {});
      if (signal?.aborted) throw abortError(signal);
      lastErr = e;
      if (e instanceof HttpError && (e.status === 404 || e.status === 403)) break;
      if (attempt < retries) await sleep(800 * 2 ** attempt);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastErr;
}

/**
 * Vérifie puis télécharge un lot de fichiers.
 * items: [{ url, dest, sha1?, size? }]
 * onProgress({ phase: 'check'|'download', done, total, files, totalFiles })
 */
export async function downloadAll(items, { concurrency = 12, verify = 'sha1', onProgress, signal } = {}) {
  const missing = [];
  let checked = 0;
  await pool(items, 24, async (item) => {
    if (signal?.aborted) throw abortError(signal);
    if (!(await fileMatches(item.dest, item, verify))) missing.push(item);
    checked++;
    onProgress?.({ phase: 'check', done: checked, total: items.length, files: checked, totalFiles: items.length });
  });
  if (missing.length === 0) return { downloaded: 0 };

  const totalBytes = missing.reduce((s, i) => s + (i.size || 0), 0);
  let doneBytes = 0;
  let files = 0;
  const report = () => onProgress?.({ phase: 'download', done: doneBytes, total: totalBytes, files, totalFiles: missing.length });

  // Un échec définitif interrompt les autres téléchargements en cours.
  const batch = new AbortController();
  const stop = () => batch.abort(abortError(signal));
  signal?.addEventListener('abort', stop, { once: true });
  try {
    await pool(missing, concurrency, async (item) => {
      if (batch.signal.aborted) return;
      try {
        await downloadFile(item, {
          signal: batch.signal,
          onBytes: (n) => {
            doneBytes += n;
            report();
          },
        });
      } catch (e) {
        if (!batch.signal.aborted) batch.abort(e);
        throw e;
      }
      files++;
      report();
    });
  } finally {
    signal?.removeEventListener('abort', stop);
  }
  return { downloaded: missing.length };
}
