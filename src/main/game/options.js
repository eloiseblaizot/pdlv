import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Lit options.txt sous forme de liste ordonnée [clé, valeur]. */
export async function readOptions(gameDir) {
  try {
    const text = await fs.readFile(path.join(gameDir, 'options.txt'), 'utf8');
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const i = line.indexOf(':');
        return i < 0 ? [line, ''] : [line.slice(0, i), line.slice(i + 1)];
      });
  } catch {
    return null;
  }
}

async function writeOptions(gameDir, entries) {
  await fs.mkdir(gameDir, { recursive: true });
  await fs.writeFile(path.join(gameDir, 'options.txt'), entries.map(([k, v]) => `${k}:${v}`).join('\n') + '\n');
}

/** Premier lancement : jeu en français. */
export async function ensureDefaultOptions(gameDir) {
  if (existsSync(path.join(gameDir, 'options.txt'))) return;
  await writeOptions(gameDir, [['lang', 'fr_fr']]);
}

function parseList(value) {
  try {
    const v = JSON.parse(value);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Liste des packs de ressources actifs (identifiants "file/xxx.zip"). */
export async function getEnabledResourcePacks(gameDir) {
  const entries = (await readOptions(gameDir)) ?? [];
  const found = entries.find(([k]) => k === 'resourcePacks');
  return found ? parseList(found[1]) : [];
}

/** Active/désactive un pack de ressources dans options.txt (pris en compte au prochain lancement). */
export async function setResourcePackEnabled(gameDir, fileName, enabled) {
  const entries = (await readOptions(gameDir)) ?? [['lang', 'fr_fr']];
  const id = `file/${fileName}`;
  let row = entries.find(([k]) => k === 'resourcePacks');
  if (!row) {
    row = ['resourcePacks', JSON.stringify(['vanilla', 'mod_resources'])];
    entries.push(row);
  }
  let list = parseList(row[1]).filter((p) => p !== id);
  // Dernier de la liste = priorité la plus haute dans Minecraft.
  if (enabled) list.push(id);
  if (!list.includes('vanilla')) list.unshift('vanilla');
  row[1] = JSON.stringify(list);

  // Minecraft retire au démarrage un pack d'un ancien format s'il n'est pas aussi listé ici ;
  // pour un pack compatible, l'entrée est simplement ignorée puis nettoyée par le jeu.
  let inc = entries.find(([k]) => k === 'incompatibleResourcePacks');
  if (!inc && enabled) {
    inc = ['incompatibleResourcePacks', '[]'];
    entries.push(inc);
  }
  if (inc) {
    const incList = parseList(inc[1]).filter((p) => p !== id);
    if (enabled) incList.push(id);
    inc[1] = JSON.stringify(incList);
  }

  await writeOptions(gameDir, entries);
}

// --- servers.dat (NBT non compressé) -----------------------------------------

function nbtString(s) {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
}
const named = (type, name, payload) => Buffer.concat([Buffer.from([type]), nbtString(name), payload]);

/** Ajoute le serveur à la liste « Multijoueur » lors de la première installation. */
export async function ensureServerEntry(gameDir, { name, host, port }) {
  const file = path.join(gameDir, 'servers.dat');
  if (existsSync(file)) return;
  const address = port && port !== 25565 ? `${host}:${port}` : host;
  const server = Buffer.concat([named(8, 'name', nbtString(name)), named(8, 'ip', nbtString(address)), Buffer.from([0])]);
  const count = Buffer.alloc(4);
  count.writeInt32BE(1);
  const list = Buffer.concat([Buffer.from([10]), count, server]);
  const root = named(10, '', Buffer.concat([named(9, 'servers', list), Buffer.from([0])]));
  await fs.mkdir(gameDir, { recursive: true });
  await fs.writeFile(file, root);
}
