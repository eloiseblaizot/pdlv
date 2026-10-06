import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';

/** Dossiers de données (jeu, Java, cache), séparés d'un éventuel .minecraft existant. */
export function getDirs() {
  let root = process.env.PDLV_HOME;
  if (!root) {
    if (process.platform === 'win32') root = path.join(app.getPath('appData'), '.paysdelavaliere');
    else if (process.platform === 'darwin') root = path.join(app.getPath('appData'), 'paysdelavaliere');
    else root = path.join(os.homedir(), '.paysdelavaliere');
  }
  const dirs = {
    root,
    game: path.join(root, 'game'),
    runtime: path.join(root, 'runtime'),
    cache: path.join(root, 'cache'),
    logs: path.join(root, 'logs'),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  return dirs;
}

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object' ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** Configuration embarquée (launcher.config.json), surchargeable en dev via PDLV_CONFIG. */
export function loadConfig() {
  const bundled = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'launcher.config.json'), 'utf8'));
  if (process.env.PDLV_CONFIG) {
    return deepMerge(bundled, JSON.parse(fs.readFileSync(process.env.PDLV_CONFIG, 'utf8')));
  }
  return bundled;
}

/** Mémoire allouée par défaut selon la RAM de la machine (le pack MTR est gourmand). */
export function defaultMemoryMb() {
  const totalMb = Math.floor(os.totalmem() / 1024 / 1024);
  if (totalMb >= 15000) return 6144;
  if (totalMb >= 7500) return 4096;
  return 3072;
}

const DEFAULT_SETTINGS = {
  memoryMb: null,
  javaPath: '',
  jvmArgs: '',
  fullscreen: false,
  autoConnect: true,
  hideOnLaunch: true,
};

export class Settings {
  constructor(file) {
    this.file = file;
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* premier lancement */
    }
    this.values = { ...DEFAULT_SETTINGS, ...saved };
    if (!this.values.memoryMb) this.values.memoryMb = defaultMemoryMb();
  }

  get() {
    return { ...this.values };
  }

  set(patch) {
    const v = { ...this.values };
    if ('memoryMb' in patch) {
      const totalMb = Math.floor(os.totalmem() / 1024 / 1024);
      v.memoryMb = Math.max(2048, Math.min(Number(patch.memoryMb) || v.memoryMb, totalMb - 1024));
    }
    if ('javaPath' in patch) v.javaPath = String(patch.javaPath || '');
    if ('jvmArgs' in patch) v.jvmArgs = String(patch.jvmArgs || '').slice(0, 2000);
    for (const k of ['fullscreen', 'autoConnect', 'hideOnLaunch']) if (k in patch) v[k] = !!patch[k];
    this.values = v;
    fs.writeFileSync(this.file, JSON.stringify(v, null, 2));
    return this.get();
  }
}
