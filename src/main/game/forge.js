import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { MinecraftFolder } from '@xmcl/core';
import { downloadAll, downloadFile, fetchText, fileMatches, sha1File } from '../net/download.js';

const FORGE_MAVEN = 'https://maven.minecraftforge.net';

export const forgeVersionId = (mcVersion, forgeVersion) => `${mcVersion}-forge-${forgeVersion}`;

/** "group:artifact:version[:classifier][@ext]" -> chemin relatif dans libraries/ */
export function mavenPath(coord) {
  const [main, ext = 'jar'] = coord.split('@');
  const [group, artifact, version, classifier] = main.split(':');
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${ext}`;
  return path.join(...group.split('.'), artifact, version, file);
}

function readMainClass(jarPath) {
  const manifest = new AdmZip(jarPath).readAsText('META-INF/MANIFEST.MF');
  const m = manifest.match(/^Main-Class:\s*(.+)$/m);
  if (!m) throw new Error(`Main-Class introuvable dans ${path.basename(jarPath)}`);
  return m[1].trim();
}

function runJava(javaPath, args, { cwd, onLog, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(javaPath, args, { cwd, windowsHide: true, signal });
    let tail = '';
    const collect = (d) => {
      const s = d.toString();
      tail = (tail + s).slice(-4000);
      onLog?.(s);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`Étape d'installation de Forge échouée (code ${code}).\n${tail}`)),
    );
  });
}

/**
 * Installe Forge (client) dans `gameDir`, sans passer par l'interface de l'installateur officiel :
 * extraction des bibliothèques embarquées, téléchargement des dépendances, puis exécution
 * des « processors » (déobfuscation + patch du jar Minecraft).
 * Renvoie l'identifiant de version (ex. "1.20.1-forge-47.4.26").
 */
export async function ensureForge({ gameDir, cacheDir, mcVersion, forgeVersion, javaPath, repair, onProgress, onLog, signal }) {
  const id = forgeVersionId(mcVersion, forgeVersion);
  const mc = MinecraftFolder.from(gameDir);
  const libDir = mc.getPath('libraries');
  const lib = (coord) => path.join(libDir, mavenPath(coord));
  const marker = path.join(mc.getVersionRoot(id), '.pdlv-forge.json');
  const patched = lib(`net.minecraftforge:forge:${mcVersion}-${forgeVersion}:client`);

  if (!repair && existsSync(marker) && existsSync(mc.getVersionJson(id)) && existsSync(patched)) return id;

  // 1. Installateur officiel (vérifié par SHA-1 publié sur le maven Forge).
  const full = `${mcVersion}-${forgeVersion}`;
  const installerUrl = `${FORGE_MAVEN}/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`;
  const installer = path.join(cacheDir, `forge-${full}-installer.jar`);
  const sha1 = (await fetchText(`${installerUrl}.sha1`)).trim().slice(0, 40);
  if (!(await fileMatches(installer, { sha1 }))) {
    onProgress?.({ phase: 'download', done: 0, total: 0, files: 0, totalFiles: 1 });
    await downloadFile({ url: installerUrl, dest: installer, sha1 }, { signal });
  }

  const zip = new AdmZip(installer);
  const profile = JSON.parse(zip.readAsText('install_profile.json'));
  const versionJson = JSON.parse(zip.readAsText(profile.json.replace(/^\//, '')));
  if (versionJson.id !== id) throw new Error(`Installateur Forge inattendu (${versionJson.id})`);

  // 2. Bibliothèques Forge embarquées dans l'installateur (maven/...).
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || !entry.entryName.startsWith('maven/')) continue;
    const dest = path.join(libDir, ...entry.entryName.slice('maven/'.length).split('/'));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, entry.getData());
  }

  // 3. Dépendances de l'installation et du jeu.
  const items = [];
  const seen = new Set();
  for (const l of [...profile.libraries, ...versionJson.libraries]) {
    const a = l.downloads?.artifact;
    if (!a?.url || seen.has(a.path)) continue;
    seen.add(a.path);
    items.push({ url: a.url, sha1: a.sha1, size: a.size, dest: path.join(libDir, a.path) });
  }
  await downloadAll(items, { verify: 'sha1', concurrency: 8, onProgress, signal });

  // 4. version.json Forge.
  await fs.mkdir(mc.getVersionRoot(id), { recursive: true });
  await fs.writeFile(mc.getVersionJson(id), JSON.stringify(versionJson, null, 2));

  // 5. Processors (côté client uniquement).
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pdlv-forge-'));
  try {
    const data = {
      SIDE: 'client',
      MINECRAFT_JAR: mc.getVersionJar(mcVersion),
      MINECRAFT_VERSION: mcVersion,
      ROOT: gameDir,
      INSTALLER: installer,
      LIBRARY_DIR: libDir,
    };
    for (const [key, sides] of Object.entries(profile.data)) {
      const v = sides.client;
      if (v.startsWith('[') && v.endsWith(']')) data[key] = lib(v.slice(1, -1));
      else if (v.startsWith("'") && v.endsWith("'")) data[key] = v.slice(1, -1);
      else if (v.startsWith('/')) {
        const out = path.join(tmp, ...v.slice(1).split('/'));
        await fs.mkdir(path.dirname(out), { recursive: true });
        await fs.writeFile(out, zip.readFile(v.slice(1)));
        data[key] = out;
      } else data[key] = v;
    }
    const resolve = (arg) => {
      if (arg.startsWith('[') && arg.endsWith(']')) return lib(arg.slice(1, -1));
      return arg.replace(/\{(\w+)\}/g, (m, k) => (k in data ? data[k] : m));
    };

    const processors = profile.processors.filter((p) => !p.sides || p.sides.includes('client'));
    let step = 0;
    for (const proc of processors) {
      if (signal?.aborted) throw new Error('Opération annulée');
      onProgress?.({ phase: 'process', done: step, total: processors.length, files: step, totalFiles: processors.length });

      const outputs = Object.entries(proc.outputs || {}).map(([f, h]) => [resolve(f), resolve(h)]);
      if (outputs.length) {
        const ok = await Promise.all(outputs.map(([f, h]) => fileMatches(f, { sha1: h })));
        if (ok.every(Boolean)) {
          step++;
          continue;
        }
      }

      const jar = lib(proc.jar);
      const classpath = [jar, ...(proc.classpath || []).map(lib)].join(path.delimiter);
      const args = ['-cp', classpath, readMainClass(jar), ...proc.args.map(resolve)];
      onLog?.(`[forge] ${proc.jar} ${proc.args.join(' ')}\n`);
      await runJava(javaPath, args, { cwd: gameDir, onLog, signal });

      for (const [f, h] of outputs) {
        const actual = await sha1File(f).catch(() => null);
        if (actual !== h) throw new Error(`Sortie Forge invalide : ${path.basename(f)}`);
      }
      step++;
    }
    onProgress?.({ phase: 'process', done: step, total: processors.length, files: step, totalFiles: processors.length });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }

  if (!existsSync(patched)) throw new Error("L'installation de Forge n'a pas produit le jar client.");
  await fs.writeFile(marker, JSON.stringify({ id, installedAt: new Date().toISOString() }));
  return id;
}
