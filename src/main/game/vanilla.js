import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MinecraftFolder, Version } from '@xmcl/core';
import { downloadAll, downloadFile, fetchJson, fileMatches } from '../net/download.js';

const VERSION_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const ASSETS_HOST = 'https://resources.download.minecraft.net';

/**
 * Télécharge le version.json et le jar client d'une version vanilla si nécessaire.
 * Le jar client est requis par l'installateur Forge.
 */
export async function ensureVanillaBase({ gameDir, mcVersion, repair, signal }) {
  const mc = MinecraftFolder.from(gameDir);
  const jsonPath = mc.getVersionJson(mcVersion);
  if (repair || !existsSync(jsonPath)) {
    const manifest = await fetchJson(VERSION_MANIFEST, {
      cacheFile: path.join(gameDir, 'versions', 'version_manifest_v2.json'),
    });
    const meta = manifest.versions.find((v) => v.id === mcVersion);
    if (!meta) throw new Error(`Version de Minecraft inconnue : ${mcVersion}`);
    if (!(await fileMatches(jsonPath, { sha1: meta.sha1 }))) {
      await downloadFile({ url: meta.url, sha1: meta.sha1, dest: jsonPath }, { signal });
    }
  }
  const json = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
  const client = json.downloads.client;
  const jar = mc.getVersionJar(mcVersion);
  if (!(await fileMatches(jar, client, repair ? 'sha1' : 'size'))) {
    await downloadFile({ url: client.url, sha1: client.sha1, size: client.size, dest: jar }, { signal });
  }
  return { javaVersion: json.javaVersion ?? { component: 'java-runtime-gamma', majorVersion: 17 } };
}

/**
 * Télécharge tout ce dont une version (vanilla ou Forge) a besoin pour démarrer :
 * jar client, bibliothèques, index d'assets, assets et configuration des logs.
 */
export async function ensureVersionFiles({ gameDir, versionId, repair, onProgress, signal }) {
  const mc = MinecraftFolder.from(gameDir);
  const version = await Version.parse(gameDir, versionId);
  const verify = repair ? 'sha1' : 'size';

  const items = [];
  const client = version.downloads?.client;
  if (client) {
    items.push({ url: client.url, sha1: client.sha1, size: client.size, dest: mc.getVersionJar(version.minecraftVersion) });
  }
  for (const lib of version.libraries) {
    const d = lib.download;
    // Les bibliothèques sans URL sont produites localement par l'installateur Forge.
    if (!d?.url) continue;
    items.push({ url: d.url, sha1: d.sha1 || undefined, size: d.size > 0 ? d.size : undefined, dest: mc.getLibraryByPath(d.path) });
  }
  const logFile = version.logging?.client?.file;
  if (logFile) items.push({ url: logFile.url, sha1: logFile.sha1, size: logFile.size, dest: mc.getLogConfig(logFile.id) });

  const ai = version.assetIndex;
  const indexPath = mc.getAssetsIndex(version.assets);
  if (ai) items.push({ url: ai.url, sha1: ai.sha1, size: ai.size, dest: indexPath });

  await downloadAll(items, { verify, concurrency: 10, signal, onProgress: (p) => onProgress?.('libraries', p) });

  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  const seen = new Set();
  const assets = [];
  for (const { hash, size } of Object.values(index.objects)) {
    if (seen.has(hash)) continue;
    seen.add(hash);
    assets.push({ url: `${ASSETS_HOST}/${hash.slice(0, 2)}/${hash}`, sha1: hash, size, dest: mc.getAsset(hash) });
  }
  await downloadAll(assets, { verify, concurrency: 16, signal, onProgress: (p) => onProgress?.('assets', p) });

  // Bibliothèques locales (générées par Forge) : on vérifie juste leur présence.
  const missing = version.libraries.filter((l) => !l.download?.url && !existsSync(mc.getLibraryByPath(l.download.path))).map((l) => l.name);
  return { version, missing };
}
