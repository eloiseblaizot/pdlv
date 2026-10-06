import fs from 'node:fs/promises';
import { safeStorage } from 'electron';
import { log } from '../util/log.js';
import { exchangeCode, interactiveLogin, minecraftLogin, refreshToken } from './microsoft.js';

// Les jetons Minecraft durent 24 h : on les renouvelle tôt pour qu'une reconnexion en cours de
// partie (redémarrage du serveur, déconnexion) ne tombe pas sur un jeton expiré.
const REFRESH_MARGIN_MS = 12 * 60 * 60 * 1000;

/**
 * Gère le compte connecté : stockage chiffré (trousseau du système via safeStorage),
 * renouvellement automatique des jetons.
 */
export class AccountManager {
  constructor({ file, getClientId }) {
    this.file = file;
    this.getClientId = getClientId;
    this.data = null;
  }

  async load() {
    try {
      const raw = await fs.readFile(this.file);
      const text = raw.subarray(0, 4).toString() === 'enc:' ? safeStorage.decryptString(raw.subarray(4)) : raw.toString('utf8');
      this.data = JSON.parse(text);
      if (this.data.clientId !== this.getClientId()) this.data = null;
    } catch {
      this.data = null;
    }
    return this.summary();
  }

  async save() {
    const text = JSON.stringify(this.data);
    const payload = safeStorage.isEncryptionAvailable()
      ? Buffer.concat([Buffer.from('enc:'), safeStorage.encryptString(text)])
      : Buffer.from(text, 'utf8');
    await fs.writeFile(this.file, payload, { mode: 0o600 });
  }

  summary() {
    if (!this.data) return null;
    const { id, name, skin } = this.data.profile;
    return { uuid: id, name, skin };
  }

  async login(parentWindow) {
    const clientId = this.getClientId();
    const code = await interactiveLogin(parentWindow, clientId);
    const ms = await exchangeCode(clientId, code);
    const mc = await minecraftLogin(clientId, ms.access_token);
    this.data = {
      clientId,
      msRefreshToken: ms.refresh_token,
      mc: { accessToken: mc.accessToken, expiresAt: mc.expiresAt },
      xuid: mc.xuid,
      profile: mc.profile,
    };
    await this.save();
    log.info(`Connecté en tant que ${mc.profile.name}`);
    return this.summary();
  }

  async logout() {
    this.data = null;
    await fs.rm(this.file, { force: true });
  }

  /** Renvoie des identifiants valides pour lancer le jeu, en renouvelant les jetons si besoin. */
  async getLaunchCredentials() {
    if (!this.data) throw new Error('Aucun compte connecté.');
    if (Date.now() > this.data.mc.expiresAt - REFRESH_MARGIN_MS) await this.refresh();
    if (!this.data) throw sessionExpiredError();
    const { profile, mc, xuid } = this.data;
    return { uuid: profile.id, name: profile.name, accessToken: mc.accessToken, xuid };
  }

  /** Un seul renouvellement à la fois (démarrage du launcher, clic sur Jouer…). */
  refresh() {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async doRefresh() {
    const current = this.data;
    const clientId = this.getClientId();
    let ms;
    try {
      ms = await refreshToken(clientId, current.msRefreshToken);
    } catch (e) {
      if (e.status === 400 || e.status === 401) {
        log.warn('Jeton Microsoft expiré, reconnexion nécessaire');
        if (this.data === current) await this.logout();
        throw sessionExpiredError();
      }
      throw e;
    }
    const mc = await minecraftLogin(clientId, ms.access_token);
    // Déconnexion ou changement de compte pendant le renouvellement : on n'écrase rien.
    if (this.data !== current) throw sessionExpiredError();
    this.data = {
      ...current,
      msRefreshToken: ms.refresh_token || current.msRefreshToken,
      mc: { accessToken: mc.accessToken, expiresAt: mc.expiresAt },
      xuid: mc.xuid,
      profile: mc.profile,
    };
    await this.save();
    return this.summary();
  }
}

function sessionExpiredError() {
  const err = new Error('Ta session a expiré, reconnecte-toi.');
  err.sessionExpired = true;
  return err;
}
