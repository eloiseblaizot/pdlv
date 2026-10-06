import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { downloadFile } from '../net/download.js';
import { getEnabledResourcePacks, setResourcePackEnabled } from '../game/options.js';
import { listDirectory } from './listing.js';

function safeName(name) {
  if (name !== path.basename(name) || name.startsWith('.') || !name.toLowerCase().endsWith('.zip')) {
    throw new Error(`Nom de pack invalide : ${name}`);
  }
  return name;
}

const RECORD_FILE = '.pdlv-packs.json';

async function readRecords(dir) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, RECORD_FILE), 'utf8'));
  } catch {
    return {};
  }
}

async function writeRecords(dir, records) {
  await fs.writeFile(path.join(dir, RECORD_FILE), JSON.stringify(records, null, 2));
}

// Les écritures de options.txt et du registre local sont sérialisées (installations en parallèle).
let queue = Promise.resolve();
const exclusive = (fn) => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

const isJunk = (name) => name.startsWith('__MACOSX/') || /(^|\/)\._/.test(name) || name.endsWith('.DS_Store');

/**
 * Minecraft exige pack.mcmeta à la racine du zip. Les archives créées avec « Compresser »
 * sur macOS contiennent un dossier racine et des fichiers __MACOSX : on les réorganise.
 */
function normalizePack(file) {
  const zip = new AdmZip(file);
  const all = zip.getEntries();
  const entries = all.filter((e) => !isJunk(e.entryName));
  let prefix = '';
  if (!entries.some((e) => e.entryName === 'pack.mcmeta')) {
    const meta = entries.find((e) => /^[^/]+\/pack\.mcmeta$/.test(e.entryName));
    if (!meta) throw new Error("Ce pack ne contient pas de pack.mcmeta : Minecraft ne pourra pas l'utiliser.");
    prefix = meta.entryName.slice(0, -'pack.mcmeta'.length);
  } else if (entries.length === all.length) {
    return;
  }
  const out = new AdmZip();
  for (const e of entries) {
    if (e.isDirectory || !e.entryName.startsWith(prefix)) continue;
    out.addFile(e.entryName.slice(prefix.length), e.getData());
  }
  out.writeZip(file);
}

function readPackMeta(file) {
  try {
    const zip = new AdmZip(file);
    const icon = zip.getEntry('pack.png');
    let description = '';
    try {
      const meta = JSON.parse(zip.readAsText('pack.mcmeta').replace(/^﻿/, ''));
      const d = meta.pack?.description;
      description = typeof d === 'string' ? d : Array.isArray(d) ? d.map((x) => x.text ?? x).join('') : (d?.text ?? '');
    } catch {
      /* pack.mcmeta absent ou invalide */
    }
    return { icon: icon ? `data:image/png;base64,${icon.getData().toString('base64')}` : null, description };
  } catch {
    return { icon: null, description: '' };
  }
}

/** Packs disponibles sur le serveur de fichiers, avec leur état local. */
export async function listResourcePacks({ listingUrl, gameDir }) {
  const dir = path.join(gameDir, 'resourcepacks');
  const remote = (await listDirectory(listingUrl)).filter((e) => !e.isDir && e.name.toLowerCase().endsWith('.zip'));
  const enabled = new Set(await getEnabledResourcePacks(gameDir));
  const records = await readRecords(dir);
  return Promise.all(
    remote.map(async (r) => {
      const file = path.join(dir, r.name);
      const st = await fs.stat(file).catch(() => null);
      const installed = !!st;
      const rec = records[r.name];
      // Le zip local peut avoir été réorganisé : on compare avec ce qui avait été téléchargé.
      const updateAvailable =
        installed && (rec ? rec.size !== r.size || rec.modified !== r.modified : r.size != null && st.size !== r.size);
      return {
        name: r.name,
        title: r.name.replace(/\.zip$/i, '').replace(/_/g, ' '),
        size: r.size,
        modified: r.modified,
        installed,
        updateAvailable,
        enabled: enabled.has(`file/${r.name}`),
        ...(installed ? readPackMeta(file) : { icon: null, description: '' }),
      };
    }),
  );
}

export async function installResourcePack({ listingUrl, gameDir, name, enable = true, onProgress }) {
  safeName(name);
  const base = listingUrl.endsWith('/') ? listingUrl : `${listingUrl}/`;
  const remote = (await listDirectory(base)).find((e) => e.name === name);
  if (!remote) throw new Error(`Pack introuvable sur le serveur : ${name}`);
  const dir = path.join(gameDir, 'resourcepacks');
  const dest = path.join(dir, name);
  const tmp = path.join(dir, `.${name}.download`);
  let done = 0;
  await downloadFile(
    { url: remote.url, dest: tmp, size: remote.size ?? undefined },
    {
      onBytes: (n) => {
        done += n;
        onProgress?.({ name, done, total: remote.size ?? 0 });
      },
    },
  );
  try {
    normalizePack(tmp);
    await fs.rename(tmp, dest);
  } finally {
    await fs.rm(tmp, { force: true });
  }
  await exclusive(async () => {
    const records = await readRecords(dir);
    records[name] = { size: remote.size, modified: remote.modified };
    await writeRecords(dir, records);
    if (enable) await setResourcePackEnabled(gameDir, name, true);
  });
}

export async function removeResourcePack({ gameDir, name }) {
  safeName(name);
  const dir = path.join(gameDir, 'resourcepacks');
  await exclusive(async () => {
    await setResourcePackEnabled(gameDir, name, false);
    await fs.rm(path.join(dir, name), { force: true });
    const records = await readRecords(dir);
    delete records[name];
    await writeRecords(dir, records);
  });
}

export async function toggleResourcePack({ gameDir, name, enabled }) {
  safeName(name);
  await exclusive(() => setResourcePackEnabled(gameDir, name, enabled));
}
