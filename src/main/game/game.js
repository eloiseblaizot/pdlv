import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { launch } from '@xmcl/core';
import { ensureForge } from './forge.js';
import { ensureJava } from './java.js';
import { fetchManifest, syncModpack } from './modpack.js';
import { ensureDefaultOptions, ensureServerEntry } from './options.js';
import { ensureVanillaBase, ensureVersionFiles } from './vanilla.js';

export const STEP_LABELS = {
  manifest: 'Récupération du modpack',
  minecraft: 'Téléchargement de Minecraft',
  java: 'Installation de Java',
  forge: 'Installation de Forge',
  libraries: 'Téléchargement des bibliothèques',
  assets: 'Téléchargement des ressources du jeu',
  mods: 'Synchronisation des mods',
  launch: 'Lancement du jeu',
};

// Réglages du garbage collector recommandés par Mojang pour le client.
const DEFAULT_JVM_FLAGS = [
  '-XX:+UnlockExperimentalVMOptions',
  '-XX:+UseG1GC',
  '-XX:G1NewSizePercent=20',
  '-XX:G1ReservePercent=20',
  '-XX:MaxGCPauseMillis=50',
  '-XX:G1HeapRegionSize=32M',
];

const MAX_LOG_LINES = 3000;

/**
 * Orchestration : préparation de l'instance (Java, Minecraft, Forge, mods) puis lancement.
 * Événements : 'progress', 'log', 'state'.
 */
export class GameManager extends EventEmitter {
  /**
   * @param {{ dirs: {game:string, runtime:string, cache:string}, getConfig: () => any, getSettings: () => any, launcherVersion: string }} opts
   */
  constructor({ dirs, getConfig, getSettings, launcherVersion }) {
    super();
    this.dirs = dirs;
    this.getConfig = getConfig;
    this.getSettings = getSettings;
    this.launcherVersion = launcherVersion;
    this.child = null;
    this.busy = false;
    this.abort = null;
    this.logs = [];
  }

  get state() {
    if (this.child) return 'running';
    if (this.busy) return 'preparing';
    return 'idle';
  }

  emitState(extra = {}) {
    this.emit('state', { state: this.state, ...extra });
  }

  step(step) {
    this.currentStep = step;
    this.emit('progress', { step, label: STEP_LABELS[step], phase: 'start', done: 0, total: 0 });
  }

  progress(step, p) {
    this.emit('progress', { step, label: STEP_LABELS[step], ...p });
  }

  pushLog(text) {
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      this.logs.push(line);
      this.emit('log', line);
    }
    if (this.logs.length > MAX_LOG_LINES) this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
  }

  cancel() {
    this.abort?.abort(new Error('Opération annulée'));
  }

  /** Exécute une opération longue (installation, lancement) en exclusivité, annulable. */
  async exclusive(fn) {
    if (this.busy) throw new Error('Une opération est déjà en cours.');
    if (this.child) throw new Error('Le jeu est déjà lancé.');
    this.busy = true;
    this.abort = new AbortController();
    this.emitState();
    const signal = this.abort.signal;
    try {
      return await fn(signal);
    } catch (e) {
      // Quelle que soit l'étape interrompue (téléchargement, Java…), l'interface reçoit la même erreur.
      if (signal.aborted) {
        const err = new Error('Opération annulée');
        err.cancelled = true;
        throw err;
      }
      throw e;
    } finally {
      this.busy = false;
      this.abort = null;
      this.emitState();
    }
  }

  /** Installe / vérifie tout ce qu'il faut pour jouer. `repair` force une vérification complète. */
  prepare({ repair = false } = {}) {
    return this.exclusive((signal) => this.install({ repair, signal }));
  }

  async install({ repair, signal }) {
    const config = this.getConfig();
    const settings = this.getSettings();
    const gameDir = this.dirs.game;
    this.step('manifest');
    const manifestUrl = config.modpack.manifestUrl;
    let manifest;
    try {
      manifest = await fetchManifest({ manifestUrl, cacheDir: this.dirs.cache });
    } catch (e) {
      throw new Error(`Impossible de récupérer la liste des mods du serveur (${e.message}). Vérifie ta connexion internet.`);
    }

    this.step('minecraft');
    const { javaVersion } = await ensureVanillaBase({ gameDir, mcVersion: manifest.minecraft, repair, signal });

    this.step('java');
    const javaPath = await ensureJava({
      runtimeRoot: this.dirs.runtime,
      component: javaVersion.component,
      majorVersion: javaVersion.majorVersion,
      customPath: settings.javaPath || null,
      repair,
      signal,
      onProgress: (p) => this.progress('java', p),
    });

    this.step('forge');
    const forgeArgs = {
      gameDir,
      cacheDir: this.dirs.cache,
      mcVersion: manifest.minecraft,
      forgeVersion: manifest.forge,
      javaPath,
      signal,
      onProgress: (p) => this.progress('forge', p),
      onLog: (s) => this.pushLog(s),
    };
    let versionId = await ensureForge({ ...forgeArgs, repair });

    this.step('libraries');
    let files = await ensureVersionFiles({
      gameDir,
      versionId,
      repair,
      signal,
      onProgress: (step, p) => this.progress(step, p),
    });
    if (files.missing.length) {
      // Fichiers générés par Forge absents (installation interrompue…) : on réinstalle Forge.
      this.step('forge');
      versionId = await ensureForge({ ...forgeArgs, repair: true });
      files = await ensureVersionFiles({ gameDir, versionId, signal });
      if (files.missing.length) throw new Error(`Bibliothèques manquantes : ${files.missing.join(', ')}`);
    }

    this.step('mods');
    await syncModpack({
      gameDir,
      manifest,
      manifestUrl,
      repair,
      signal,
      onProgress: (p) => this.progress('mods', p),
    });

    await ensureDefaultOptions(gameDir);
    await ensureServerEntry(gameDir, { name: config.serverName, host: config.server.host, port: config.server.port });
    return { manifest, javaPath, versionId };
  }

  /**
   * Prépare puis lance le jeu avec connexion directe au serveur.
   * @param {() => Promise<{ uuid: string, name: string, accessToken: string, xuid?: string }>} getCredentials
   *   appelé juste avant le lancement, pour ne pas partir avec un jeton vieilli pendant l'installation
   */
  async play(getCredentials) {
    // L'état reste « en préparation » jusqu'au démarrage effectif du processus Java.
    const child = await this.exclusive(async (signal) => {
      const { versionId, javaPath } = await this.install({ repair: false, signal });
      const account = await getCredentials();
      const { child, startedAt } = await this.spawnGame({ account, versionId, javaPath });
      this.attach(child, startedAt);
      return child;
    });
    return { pid: child.pid };
  }

  async spawnGame({ account, versionId, javaPath }) {
    const config = this.getConfig();
    const settings = this.getSettings();
    this.step('launch');

    const userJvm = (settings.jvmArgs || '').split(/\s+/).filter(Boolean);
    const { host, port } = config.server;
    const placeholders = { '${clientid}': config.auth.microsoftClientId || '', '${auth_xuid}': account.xuid || '' };

    this.logs = [];
    const startedAt = Date.now();
    let started;
    const child = await launch({
      gamePath: this.dirs.game,
      javaPath,
      version: versionId,
      gameProfile: { id: account.uuid, name: account.name },
      accessToken: account.accessToken,
      userType: 'msa',
      launcherName: 'pdlv-launcher',
      launcherBrand: this.launcherVersion,
      gameName: config.serverName,
      minMemory: 1024,
      maxMemory: settings.memoryMb,
      quickPlayMultiplayer: settings.autoConnect === false ? undefined : `${host}:${port}`,
      resolution: settings.fullscreen ? { fullscreen: true } : undefined,
      extraJVMArgs: [...DEFAULT_JVM_FLAGS, ...userJvm],
      extraExecOption: { windowsHide: false },
      // Remplace les variables que @xmcl/core ne connaît pas (identifiants Xbox).
      spawn: (cmd, args, opts) => {
        const proc = spawn(
          cmd,
          args.map((a) => placeholders[a] ?? a),
          opts,
        );
        // Écouté immédiatement : 'spawn' / 'error' sont émis avant le retour de launch().
        started = new Promise((resolve, reject) => {
          proc.once('spawn', resolve);
          proc.once('error', reject);
        });
        return proc;
      },
    });
    try {
      await started;
    } catch (e) {
      throw new Error(
        `Impossible de démarrer Java (${e.code ?? e.message}). Un antivirus l'a peut-être bloqué ; essaie « Réparer l'installation ».`,
      );
    }
    return { child, startedAt };
  }

  attach(child, startedAt) {
    this.child = child;
    this.emitState();
    child.stdout?.on('data', (d) => this.pushLog(d.toString()));
    child.stderr?.on('data', (d) => this.pushLog(d.toString()));
    child.on('error', (e) => this.pushLog(`[launcher] ${e.message}`));
    // 'close' (et non 'exit') : les dernières lignes du journal sont alors bien reçues.
    child.on('close', async (code, sig) => {
      this.child = null;
      const crashed = !this.killedByUser && code !== 0;
      this.killedByUser = false;
      const crashReport = crashed ? await this.findCrashReport(startedAt) : null;
      this.emitState({ exitCode: code, signal: sig, crashed, crashReport, lastLines: crashed ? this.logs.slice(-60) : [] });
    });
  }

  kill() {
    if (!this.child) return;
    this.killedByUser = true;
    this.child.kill();
  }

  async findCrashReport(since) {
    const dir = path.join(this.dirs.game, 'crash-reports');
    try {
      const files = await fs.readdir(dir);
      let best = null;
      for (const f of files) {
        const st = await fs.stat(path.join(dir, f));
        if (st.mtimeMs >= since && (!best || st.mtimeMs > best.mtimeMs)) best = { file: path.join(dir, f), mtimeMs: st.mtimeMs };
      }
      return best?.file ?? null;
    } catch {
      return null;
    }
  }
}
