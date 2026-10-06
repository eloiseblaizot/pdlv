import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { app } from 'electron';
import electronUpdater from 'electron-updater';
import { log } from './util/log.js';

const { autoUpdater } = electronUpdater;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Vrai si l'application macOS est signée avec un certificat Developer ID (lu sur le bundle lui-même). */
function isDeveloperIdSigned() {
  const bundle = path.resolve(process.execPath, '..', '..', '..');
  const r = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=2', bundle], { encoding: 'utf8' });
  return /^Authority=Developer ID Application:/m.test(r.stderr ?? '');
}

/**
 * Mise à jour automatique du launcher depuis le dossier configuré dans package.json (build.publish).
 * Sur macOS, l'installation automatique exige une application signée Developer ID : sans elle,
 * on se contente de prévenir le joueur qu'une nouvelle version est disponible.
 */
export function initUpdater(send) {
  if (!app.isPackaged) return { install: () => {} };

  const canAutoInstall = process.platform !== 'darwin' || isDeveloperIdSigned();
  log.info(`[maj] installation automatique : ${canAutoInstall ? 'oui' : 'non (app macOS non signée)'}`);
  autoUpdater.logger = null;
  autoUpdater.autoDownload = canAutoInstall;
  autoUpdater.autoInstallOnAppQuit = canAutoInstall;

  autoUpdater.on('update-available', (info) =>
    send('update', { state: canAutoInstall ? 'downloading' : 'available', version: info.version }),
  );
  autoUpdater.on('download-progress', (p) => send('update', { state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => send('update', { state: 'ready', version: info.version }));
  // Une seule ligne de log par échec (404 tant qu'aucune version n'a été publiée sur le serveur).
  const report = (e) => log.warn('[maj] vérification impossible :', String(e?.message ?? e).split('\n')[0]);
  autoUpdater.on('error', () => {});
  const check = () => autoUpdater.checkForUpdates().catch(report);
  check();
  setInterval(check, CHECK_INTERVAL_MS);

  return { install: () => autoUpdater.quitAndInstall() };
}
