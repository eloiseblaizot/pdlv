import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { downloadAll, fetchJson, sha1File } from '../net/download.js';

const STATE_FILE = '.pdlv-modpack.json';
const DISABLED_DIR = 'mods_desactives';

/** Récupère le manifest distant ; en cas d'échec, utilise la dernière copie connue. */
export async function fetchManifest({ manifestUrl, cacheDir }) {
  const manifest = await fetchJson(manifestUrl, {
    cacheFile: path.join(cacheDir, 'modpack-manifest.json'),
    noCache: true,
  });
  validateManifest(manifest);
  return manifest;
}

function validateManifest(m) {
  if (!m || typeof m !== 'object' || !Array.isArray(m.mods)) throw new Error('Manifest du modpack invalide.');
  if (!m.minecraft || !m.forge || !m.version) throw new Error('Manifest du modpack incomplet (minecraft/forge/version).');
  for (const mod of m.mods) {
    // Un nom de fichier ne doit jamais permettre d'écrire hors du dossier mods.
    if (!mod.file || mod.file !== path.basename(mod.file) || !mod.file.endsWith('.jar') || mod.file.startsWith('.')) {
      throw new Error(`Nom de fichier de mod invalide dans le manifest : ${mod.file}`);
    }
    if (!/^[0-9a-f]{40}$/i.test(mod.sha1 || '')) throw new Error(`SHA-1 manquant pour ${mod.file}`);
  }
}

/** Chemin cible d'un fichier additionnel (config…), confiné au dossier du jeu. */
function safeGamePath(gameDir, rel) {
  const dest = path.resolve(gameDir, rel);
  if (!dest.startsWith(path.resolve(gameDir) + path.sep)) throw new Error(`Chemin interdit dans le manifest : ${rel}`);
  return dest;
}

export async function readState(gameDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(gameDir, STATE_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Vérifie un fichier avec un cache (taille + date) pour éviter de re-hacher
 * plusieurs centaines de Mo de mods à chaque lancement.
 */
async function matchesWithCache(file, expectedSha1, cache, key, repair) {
  let st;
  try {
    st = await fs.stat(file);
  } catch {
    return false;
  }
  const c = cache[key];
  if (!repair && c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.sha1 === expectedSha1;
  const sha1 = await sha1File(file);
  cache[key] = { size: st.size, mtimeMs: st.mtimeMs, sha1 };
  return sha1 === expectedSha1;
}

/** Mods requis côté client (les mods marqués "server" ne sont pas installés chez les joueurs). */
export const clientMods = (manifest) => manifest.mods.filter((m) => (m.side ?? 'both') !== 'server');

/**
 * Synchronise le dossier mods/ (et les éventuels fichiers de config) avec le manifest.
 * Les mods qui ne font pas partie du pack sont déplacés dans mods_desactives/ (jamais supprimés).
 */
export async function syncModpack({ gameDir, manifest, manifestUrl, repair, onProgress, signal }) {
  const modsDir = path.join(gameDir, 'mods');
  await fs.mkdir(modsDir, { recursive: true });
  const keyOf = (file) => path.relative(gameDir, file).split(path.sep).join('/');
  const state = (await readState(gameDir)) ?? {};
  const cache = state.cache ?? {};

  const mods = clientMods(manifest);
  const toDownload = [];
  let checked = 0;
  for (const mod of mods) {
    const dest = path.join(modsDir, mod.file);
    if (!(await matchesWithCache(dest, mod.sha1.toLowerCase(), cache, keyOf(dest), repair))) {
      toDownload.push({
        url: new URL(mod.path ?? `mods/${encodeURIComponent(mod.file)}`, manifestUrl).href,
        dest,
        sha1: mod.sha1,
        size: mod.size,
      });
    }
    onProgress?.({ phase: 'check', done: ++checked, total: mods.length, files: checked, totalFiles: mods.length });
  }

  for (const f of manifest.files ?? []) {
    const dest = safeGamePath(gameDir, f.path);
    if (f.overwrite === false && existsSync(dest)) continue;
    if (!(await matchesWithCache(dest, f.sha1.toLowerCase(), cache, keyOf(dest), repair))) {
      toDownload.push({ url: new URL(f.url, manifestUrl).href, dest, sha1: f.sha1, size: f.size });
    }
  }

  await downloadAll(toDownload, { verify: 'sha1', concurrency: 4, onProgress, signal });

  // Mise de côté des mods étrangers au pack (anciennes versions, ajouts manuels).
  const wanted = new Set(mods.map((m) => m.file));
  const moved = [];
  for (const name of await fs.readdir(modsDir)) {
    if (!name.endsWith('.jar') || wanted.has(name)) continue;
    const disabledDir = path.join(gameDir, DISABLED_DIR);
    await fs.mkdir(disabledDir, { recursive: true });
    await fs.rename(path.join(modsDir, name), path.join(disabledDir, name));
    delete cache[`mods/${name}`];
    moved.push(name);
  }

  // Rafraîchit le cache pour les fichiers fraîchement téléchargés.
  for (const item of toDownload) {
    const st = await fs.stat(item.dest);
    cache[keyOf(item.dest)] = { size: st.size, mtimeMs: st.mtimeMs, sha1: item.sha1.toLowerCase() };
  }

  const newState = { version: manifest.version, installedAt: new Date().toISOString(), cache };
  await fs.writeFile(path.join(gameDir, STATE_FILE), JSON.stringify(newState, null, 2));
  return { downloaded: toDownload.length, moved };
}
