import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, session, shell } from 'electron';
import { AccountManager } from './auth/account.js';
import { getDirs, loadConfig, Settings } from './config.js';
import { GameManager } from './game/game.js';
import { clientMods, fetchManifest, readState } from './game/modpack.js';
import { probeJava } from './game/java.js';
import { listDirectory } from './services/listing.js';
import { installResourcePack, listResourcePacks, removeResourcePack, toggleResourcePack } from './services/resourcepacks.js';
import { getServerStatus } from './services/status.js';
import { searchMods, sendSuggestion } from './services/suggestions.js';
import { initUpdater } from './updater.js';
import { initLog, log } from './util/log.js';

const ROOT = path.join(import.meta.dirname, '..');
const INDEX_HTML = path.join(ROOT, 'renderer', 'index.html');
const STATUS_INTERVAL_MS = 30 * 1000;

// Une seule instance : un second lancement remet simplement la fenêtre existante au premier plan.
if (!app.requestSingleInstanceLock()) process.exit(0);

const config = loadConfig();
const dirs = getDirs();
initLog(dirs.logs);
const settings = new Settings(path.join(dirs.root, 'settings.json'));
const accounts = new AccountManager({ file: path.join(dirs.root, 'account.dat'), getClientId: () => config.auth.microsoftClientId });
const game = new GameManager({ dirs, getConfig: () => config, getSettings: () => settings.get(), launcherVersion: app.getVersion() });

let win = null;
let driveWin = null;
let lastStatus = null;
let lastManifest = null;
let updater = { install: () => {} };

function send(type, payload) {
  if (win && !win.isDestroyed()) win.webContents.send('pdlv:event', type, payload);
}

// --- Fenêtre principale ------------------------------------------------------

function createWindow() {
  nativeTheme.themeSource = 'light';
  win = new BrowserWindow({
    width: 1240,
    height: 780,
    minWidth: 1020,
    minHeight: 660,
    show: false,
    title: config.serverName,
    backgroundColor: '#f4ede4',
    icon: path.join(ROOT, 'renderer', 'assets', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? false : { color: '#00000000', symbolColor: '#1b2238', height: 36 },
    trafficLightPosition: { x: 16, y: 12 },
    webPreferences: {
      preload: path.join(ROOT, 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(INDEX_HTML);
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => (win = null));

  // Le launcher ne navigue jamais (ni vers un site, ni vers un fichier glissé sur la fenêtre) :
  // les liens web s'ouvrent dans le navigateur du système.
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    openExternal(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
}

function openExternal(url) {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
}

/** Vrai si l'appel IPC provient de la page du launcher dans la fenêtre principale. */
function isLauncherFrame(event) {
  const url = event.senderFrame?.url;
  if (!win || event.sender !== win.webContents || !url?.startsWith('file:')) return false;
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  try {
    return norm(fileURLToPath(url.split(/[?#]/)[0])) === norm(INDEX_HTML);
  } catch {
    return false;
  }
}

/** Autorise l'intégration des cartes (BlueMap, plan des transports) dans le launcher. */
function allowMapFraming() {
  const origins = Object.values(config.maps).map((u) => new URL(u).origin);
  const urls = origins.map((o) => `${o}/*`);
  session.defaultSession.webRequest.onHeadersReceived({ urls }, (details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const k of Object.keys(headers)) {
      const lk = k.toLowerCase();
      if (lk === 'x-frame-options') delete headers[k];
      if (lk === 'content-security-policy') {
        headers[k] = headers[k].map((v) => v.replace(/frame-ancestors[^;]*;?/gi, ''));
      }
    }
    callback({ responseHeaders: headers });
  });
}

function openDriveWindow() {
  if (driveWin && !driveWin.isDestroyed()) {
    driveWin.focus();
    return;
  }
  driveWin = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Images du serveur — Drive',
    autoHideMenuBar: true,
    webPreferences: { partition: 'persist:drive', sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  // La fenêtre n'a pas de barre d'adresse : elle reste cantonnée au Drive du serveur.
  const driveOrigin = new URL(config.images.uploadUrl).origin;
  const isDrive = (url) => {
    try {
      return new URL(url).origin === driveOrigin;
    } catch {
      return false;
    }
  };
  driveWin.webContents.setWindowOpenHandler(({ url }) => {
    if (isDrive(url)) return { action: 'allow' };
    openExternal(url);
    return { action: 'deny' };
  });
  driveWin.webContents.on('will-navigate', (e, url) => {
    if (isDrive(url)) return;
    e.preventDefault();
    openExternal(url);
  });
  driveWin.loadURL(config.images.uploadUrl);
  driveWin.on('closed', () => (driveWin = null));
}

// --- Statut du serveur -------------------------------------------------------

async function refreshStatus() {
  lastStatus = await getServerStatus(config.server);
  send('status', lastStatus);
  return lastStatus;
}

// --- Modpack -----------------------------------------------------------------

async function modpackInfo() {
  let offline = false;
  try {
    const r = await fetchManifest({ manifestUrl: config.modpack.manifestUrl, cacheDir: dirs.cache });
    lastManifest = r.manifest;
    offline = r.offline;
    if (r.offline) log.warn('Manifest injoignable, copie locale utilisée :', r.error);
  } catch (e) {
    log.warn('Manifest indisponible :', e.message);
    offline = true;
  }
  const state = await readState(dirs.game);
  const m = lastManifest;
  return {
    offline,
    error: m ? null : 'Impossible de récupérer la liste des mods.',
    installedVersion: state?.version ?? null,
    upToDate: !!m && state?.version === m.version,
    remote: m && {
      name: m.name,
      version: m.version,
      minecraft: m.minecraft,
      forge: m.forge,
      releasedAt: m.releasedAt,
      changelog: Array.isArray(m.changelog) ? m.changelog : m.changelog ? [m.changelog] : [],
      announcement: m.launcher?.announcement || '',
      totalSize: clientMods(m).reduce((s, x) => s + (x.size || 0), 0),
      mods: m.mods.map(({ id, name, version, side, size }) => ({ id, name, version, side, size })),
    },
  };
}

/** Le webhook peut être défini dans le manifest distant (modifiable sans republier le launcher). */
const suggestionsWebhook = () => lastManifest?.launcher?.suggestionsWebhook || config.suggestions.discordWebhook;

// --- Progression (limitée à ~10 messages/s vers l'interface) -------------------

let pendingProgress = null;
let progressTimer = null;
game.on('progress', (p) => {
  pendingProgress = p;
  if (p.phase === 'start') flushProgress();
  else if (!progressTimer) progressTimer = setTimeout(flushProgress, 100);
});
function flushProgress() {
  clearTimeout(progressTimer);
  progressTimer = null;
  if (pendingProgress) send('progress', pendingProgress);
  pendingProgress = null;
}
game.on('log', (line) => send('log', line));
game.on('state', (s) => {
  send('game', s);
  if (!win) {
    // Fenêtre fermée pendant la partie : on quitte à la fermeture du jeu.
    if (s.state === 'idle' && 'exitCode' in s && process.platform !== 'darwin') app.quit();
    return;
  }
  if (s.state === 'running' && settings.get().hideOnLaunch) win.hide();
  if (s.state === 'idle' && 'exitCode' in s) {
    win.show();
    if (s.crashed) win.focus();
  }
});

// --- API exposée à l'interface -------------------------------------------------

/**
 * Le jeu réécrit options.txt avec ses propres valeurs et verrouille les zips sous Windows :
 * les packs de textures ne se modifient que jeu fermé.
 */
function ensureGameClosed() {
  if (game.state !== 'idle') throw new Error('Ferme le jeu avant de modifier les packs de textures.');
}

const imagesRoot = () => (config.images.listingUrl.endsWith('/') ? config.images.listingUrl : `${config.images.listingUrl}/`);

const api = {
  'app:info': () => ({
    version: app.getVersion(),
    platform: process.platform,
    totalMemMb: Math.floor(os.totalmem() / 1024 / 1024),
    serverName: config.serverName,
    server: config.server,
    maps: config.maps,
    updatesUrl: config.updates?.downloadUrl ?? null,
    suggestionsEnabled: !!suggestionsWebhook(),
  }),

  'auth:get': () => accounts.summary(),
  'auth:login': () => accounts.login(win),
  'auth:logout': () => accounts.logout(),

  'status:get': () => lastStatus ?? refreshStatus(),
  'status:refresh': () => refreshStatus(),

  'modpack:info': () => modpackInfo(),
  'modpack:update': async () => {
    await game.prepare();
    return modpackInfo();
  },

  'game:play': async () => {
    // Vérifie la session avant une éventuelle longue installation, puis de nouveau au lancement.
    await accounts.getLaunchCredentials();
    send('account', accounts.summary());
    return game.play(() => accounts.getLaunchCredentials());
  },
  'game:repair': async () => {
    await game.prepare({ repair: true });
    return modpackInfo();
  },
  'game:cancel': () => game.cancel(),
  'game:kill': () => game.kill(),
  'game:state': () => ({ state: game.state }),
  'game:logs': () => game.logs,

  'packs:list': () => listResourcePacks({ listingUrl: config.resourcePacks.listingUrl, gameDir: dirs.game }),
  'packs:install': (name) => {
    ensureGameClosed();
    return installResourcePack({
      listingUrl: config.resourcePacks.listingUrl,
      gameDir: dirs.game,
      name,
      onProgress: (p) => send('pack-progress', p),
    });
  },
  'packs:remove': (name) => {
    ensureGameClosed();
    return removeResourcePack({ gameDir: dirs.game, name });
  },
  'packs:toggle': (name, enabled) => {
    ensureGameClosed();
    return toggleResourcePack({ gameDir: dirs.game, name, enabled });
  },

  'images:list': async (sub = '') => {
    const root = imagesRoot();
    const url = new URL(sub, root).href;
    if (!url.startsWith(root)) throw new Error('Dossier invalide.');
    return listDirectory(url);
  },
  'images:openUpload': () => openDriveWindow(),

  'mods:search': (q) => searchMods(String(q || '').slice(0, 100)),
  'mods:suggest': (s) => sendSuggestion(suggestionsWebhook(), { ...s, player: accounts.summary()?.name ?? 'Inconnu' }),

  'settings:get': () => settings.get(),
  'settings:set': (patch) => {
    // Le chemin de Java ne peut être choisi que via la boîte de dialogue (qui le vérifie).
    if (patch?.javaPath) throw new Error('Utilise le bouton « Choisir… » pour sélectionner Java.');
    return settings.set(patch ?? {});
  },
  'settings:pickJava': async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choisir l’exécutable Java 17+',
      properties: ['openFile', 'showHiddenFiles'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const probe = await probeJava(r.filePaths[0]);
    if (!probe) throw new Error("Ce fichier n'est pas un exécutable Java valide.");
    if (probe.major < 17) throw new Error(`Java ${probe.major} détecté : Java 17 ou plus récent est requis.`);
    return settings.set({ javaPath: r.filePaths[0] });
  },

  'open:folder': async (which) => {
    const map = {
      game: dirs.game,
      mods: path.join(dirs.game, 'mods'),
      resourcepacks: path.join(dirs.game, 'resourcepacks'),
      screenshots: path.join(dirs.game, 'screenshots'),
      logs: path.join(dirs.game, 'logs'),
      crash: path.join(dirs.game, 'crash-reports'),
      launcherLogs: dirs.logs,
    };
    if (!map[which]) throw new Error('Dossier inconnu.');
    // Les dossiers (captures, crashs…) n'existent qu'après la première partie.
    await fs.mkdir(map[which], { recursive: true });
    const err = await shell.openPath(map[which]);
    if (err) throw new Error(err);
  },
  'open:crashReport': async (file) => {
    // Seuls les rapports de crash du jeu peuvent être ouverts depuis l'interface.
    const crashDir = path.join(dirs.game, 'crash-reports');
    const resolved = path.resolve(String(file));
    if (path.dirname(resolved) !== crashDir || !resolved.endsWith('.txt')) throw new Error('Fichier non autorisé.');
    const err = await shell.openPath(resolved);
    if (err) throw new Error(err);
  },
  'open:url': (url) => openExternal(String(url)),
  'clipboard:write': (text) => clipboard.writeText(String(text)),
  'update:install': () => updater.install(),
};

ipcMain.handle('pdlv', async (event, method, ...args) => {
  if (!isLauncherFrame(event)) return { ok: false, error: 'Origine refusée' };
  const fn = api[method];
  if (!fn) return { ok: false, error: `Méthode inconnue : ${method}` };
  try {
    return { ok: true, result: await fn(...args) };
  } catch (e) {
    if (!e?.cancelled) log.error(`[${method}]`, e);
    return { ok: false, error: e?.message ?? String(e), cancelled: !!e?.cancelled, sessionExpired: !!e?.sessionExpired };
  }
});

// --- Cycle de vie -------------------------------------------------------------

app.on('second-instance', () => {
  // Fenêtre fermée pendant une partie : on la recrée.
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.whenReady().then(async () => {
  log.info(`Launcher ${app.getVersion()} — ${process.platform}/${process.arch} — données : ${dirs.root}`);
  // En développement, le Dock afficherait l'icône d'Electron (l'app packagée a la sienne).
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(path.join(ROOT, '..', 'build', 'icon.png'));
  // Barre de titre personnalisée : pas de menu natif hors macOS (où il porte les raccourcis Cmd+C/V/Q).
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  allowMapFraming();
  await accounts.load();
  createWindow();
  updater = initUpdater(send);

  refreshStatus();
  setInterval(() => {
    if (win?.isVisible()) refreshStatus();
  }, STATUS_INTERVAL_MS);

  // Renouvelle la session en arrière-plan pour détecter tôt un compte expiré.
  if (accounts.summary()) {
    accounts.getLaunchCredentials().catch((e) => {
      if (e.sessionExpired) send('account', null);
    });
  }

  app.on('activate', () => {
    if (!win) createWindow();
    else win.show();
  });
});

app.on('window-all-closed', () => {
  // Le jeu continue de tourner même si la fenêtre est fermée ; on quitte quand il n'y a plus rien.
  if (process.platform !== 'darwin' && !game.child) app.quit();
});
