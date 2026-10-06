#!/usr/bin/env node
/**
 * Génère le dossier à publier sur le serveur de fichiers pour le modpack :
 *
 *   <sortie>/manifest.json
 *   <sortie>/mods/*.jar
 *
 * Usage :
 *   npm run modpack -- --mods ~/Downloads/Modspack --version 1.0.0 --changelog "Ajout de X"
 *
 * Options :
 *   --mods <dossier>      dossier contenant les .jar (obligatoire)
 *   --out <dossier>       dossier de sortie (défaut : ./modpack-dist)
 *   --version <x.y.z>     version du modpack (défaut : version précédente + 1 patch)
 *   --changelog <texte>   notes de version (répétable)
 *   --forge <version>     version de Forge (défaut : celle du manifest précédent, sinon 47.4.26)
 *   --previous <url|fichier>  manifest précédent (pour reprendre version, côtés, notes)
 *
 * Le fichier optionnel modpack.overrides.json (à côté de ce script ou dans --mods) permet
 * de forcer le côté d'un mod : { "chunky": { "side": "server" } }
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const optAll = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));

const modsDir = opt('mods');
if (!modsDir) {
  console.error('Usage : npm run modpack -- --mods <dossier> [--version x.y.z] [--changelog "..."]');
  process.exit(1);
}
const outDir = path.resolve(opt('out', 'modpack-dist'));

async function loadPrevious(src) {
  if (!src) return null;
  try {
    if (/^https?:/.test(src)) {
      const res = await fetch(`${src}?t=${Date.now()}`);
      return res.ok ? await res.json() : null;
    }
    return JSON.parse(fs.readFileSync(src, 'utf8'));
  } catch {
    return null;
  }
}

function bumpPatch(v) {
  const p = (v || '0.0.0').split('.').map((n) => parseInt(n, 10) || 0);
  while (p.length < 3) p.push(0);
  p[2]++;
  return p.join('.');
}

/** Lit l'identité d'un mod depuis META-INF/mods.toml (sans dépendance TOML). */
function readModInfo(jarPath) {
  const zip = new AdmZip(jarPath);
  const toml = zip.readAsText('META-INF/mods.toml') || '';
  const block = toml.split(/^\s*\[\[mods\]\]/m)[1] ?? '';
  const field = (k) => {
    const m = block.match(new RegExp(`^\\s*${k}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'm'));
    return m ? (m[1] ?? m[2]) : undefined;
  };
  let version = field('version');
  if (!version || version.includes('${')) {
    const mf = zip.readAsText('META-INF/MANIFEST.MF') || '';
    version = mf.match(/^Implementation-Version:\s*(.+)$/m)?.[1]?.trim() ?? version;
  }
  return { id: field('modId'), name: field('displayName'), version };
}

const sha1 = (file) => createHash('sha1').update(fs.readFileSync(file)).digest('hex');

const previous = await loadPrevious(opt('previous'));
const overridesFile = [path.join(modsDir, 'modpack.overrides.json'), path.join(import.meta.dirname, 'modpack.overrides.json')].find((f) =>
  fs.existsSync(f),
);
const overrides = overridesFile ? JSON.parse(fs.readFileSync(overridesFile, 'utf8')) : {};
const previousSides = Object.fromEntries((previous?.mods ?? []).map((m) => [m.id, m.side]));

const jars = fs
  .readdirSync(modsDir)
  .filter((f) => f.endsWith('.jar') && !f.startsWith('.'))
  .sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
if (jars.length === 0) {
  console.error(`Aucun .jar trouvé dans ${modsDir}`);
  process.exit(1);
}

fs.rmSync(path.join(outDir, 'mods'), { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, 'mods'), { recursive: true });

const mods = jars.map((file) => {
  const src = path.join(modsDir, file);
  const info = readModInfo(src);
  const id = info.id ?? path.basename(file, '.jar');
  fs.copyFileSync(src, path.join(outDir, 'mods', file));
  return {
    id,
    name: info.name ?? id,
    version: info.version ?? '?',
    file,
    path: `mods/${encodeURIComponent(file)}`,
    sha1: sha1(src),
    size: fs.statSync(src).size,
    side: overrides[id]?.side ?? previousSides[id] ?? 'both',
  };
});

const changelog = optAll('changelog');
const manifest = {
  formatVersion: 1,
  name: previous?.name ?? 'Pays de la Valière',
  version: opt('version') ?? bumpPatch(previous?.version),
  minecraft: '1.20.1',
  forge: opt('forge') ?? previous?.forge ?? '47.4.26',
  releasedAt: new Date().toISOString(),
  changelog: changelog.length ? changelog : [],
  mods,
  files: previous?.files ?? [],
  launcher: previous?.launcher ?? { announcement: '', suggestionsWebhook: '' },
};

fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const total = mods.reduce((s, m) => s + m.size, 0);
console.log(`Modpack ${manifest.version} — ${mods.length} mods (${(total / 1024 / 1024).toFixed(1)} Mo), Forge ${manifest.forge}`);
for (const m of mods) console.log(`  ${m.side.padEnd(6)} ${m.name} ${m.version}`);
console.log(`\nÀ publier : le contenu de ${outDir} dans le dossier Modspack/ du serveur de fichiers.`);
