import { BrowserWindow } from 'electron';
import { USER_AGENT } from '../net/download.js';

// Flux OAuth « bureau » de Microsoft : la page de connexion redirige vers cette URL avec ?code=...
const AUTHORIZE_URL = 'https://login.live.com/oauth20_authorize.srf';
const TOKEN_URL = 'https://login.live.com/oauth20_token.srf';
const REDIRECT_URI = 'https://login.live.com/oauth20_desktop.srf';

/** Les applications Azure (GUID) et l'ancien identifiant Live n'utilisent pas le même scope. */
const isAzureClient = (clientId) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId);
const scopeFor = (clientId) => (isAzureClient(clientId) ? 'XboxLive.signin offline_access' : 'service::user.auth.xboxlive.com::MBI_SSL');

export class AuthCancelledError extends Error {
  constructor() {
    super('Connexion annulée.');
    this.cancelled = true;
  }
}

const XBOX_ERRORS = {
  2148916233: "Ce compte Microsoft n'a pas encore de profil Xbox. Connecte-toi une fois sur xbox.com pour le créer, puis réessaie.",
  2148916235: "Xbox Live n'est pas disponible dans le pays de ce compte.",
  2148916236: 'Ce compte doit être vérifié (vérification d’âge) sur xbox.com.',
  2148916237: 'Ce compte doit être vérifié (vérification d’âge) sur xbox.com.',
  2148916238: "Compte enfant : un adulte doit l'ajouter à une famille Microsoft avant de pouvoir jouer.",
};

/** Ouvre la fenêtre de connexion Microsoft et renvoie le code d'autorisation. */
export function interactiveLogin(parent, clientId) {
  const win = new BrowserWindow({
    parent,
    modal: process.platform !== 'darwin',
    width: 500,
    height: 660,
    title: 'Connexion à ton compte Microsoft',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      // Session en mémoire : permet de choisir un autre compte à chaque connexion.
      partition: `msauth-${Date.now()}`,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const url = `${AUTHORIZE_URL}?${new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: scopeFor(clientId),
    prompt: 'select_account',
  })}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const handle = (target) => {
      if (settled || !target.startsWith(REDIRECT_URI)) return;
      settled = true;
      const q = new URL(target).searchParams;
      const code = q.get('code');
      if (code) resolve(code);
      else if (q.get('error') === 'access_denied') reject(new AuthCancelledError());
      else reject(new Error(q.get('error_description') || q.get('error') || 'Connexion refusée.'));
      win.destroy();
    };
    win.webContents.on('will-redirect', (_e, u) => handle(u));
    win.webContents.on('will-navigate', (_e, u) => handle(u));
    win.webContents.on('did-navigate', (_e, u) => handle(u));
    win.webContents.on('did-redirect-navigation', (_e, u) => handle(u));
    // Liens externes (création de compte, aide…) : navigateur du système.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', () => {
      if (!settled) {
        settled = true;
        reject(new AuthCancelledError());
      }
    });
    win.loadURL(url).catch(() => {});
  });
}

async function requestJson(url, { method = 'POST', json, form, token } = {}) {
  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
  let body;
  if (json) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* réponse non JSON */
  }
  if (!res.ok) {
    const err = new Error(data?.error_description || data?.errorMessage || data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function msTokenRequest(clientId, params) {
  return requestJson(TOKEN_URL, {
    form: { client_id: clientId, redirect_uri: REDIRECT_URI, scope: scopeFor(clientId), ...params },
  });
}

export const exchangeCode = (clientId, code) => msTokenRequest(clientId, { grant_type: 'authorization_code', code });
export const refreshToken = (clientId, refresh) => msTokenRequest(clientId, { grant_type: 'refresh_token', refresh_token: refresh });

function decodeJwt(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

/**
 * Chaîne Microsoft -> Xbox Live -> XSTS -> Minecraft.
 * Renvoie le jeton Minecraft et le profil Java du joueur.
 */
export async function minecraftLogin(clientId, msAccessToken) {
  const xbl = await requestJson('https://user.auth.xboxlive.com/user/authenticate', {
    json: {
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        RpsTicket: isAzureClient(clientId) ? `d=${msAccessToken}` : msAccessToken,
      },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    },
  });

  let xsts;
  try {
    xsts = await requestJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
      json: {
        Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
        RelyingParty: 'rp://api.minecraftservices.com/',
        TokenType: 'JWT',
      },
    });
  } catch (e) {
    const xerr = e.data?.XErr;
    throw new Error(XBOX_ERRORS[xerr] || `Connexion Xbox refusée (${xerr ?? e.message}).`);
  }

  const uhs = xsts.DisplayClaims.xui[0].uhs;
  let mc;
  try {
    mc = await requestJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
      json: { identityToken: `XBL3.0 x=${uhs};${xsts.Token}` },
    });
  } catch (e) {
    if (e.status === 403) {
      throw new Error(
        "Cette application n'est pas (encore) autorisée par Mojang à se connecter aux comptes Minecraft. Voir la section « Authentification Microsoft » du README.",
      );
    }
    throw e;
  }

  let profile;
  try {
    profile = await requestJson('https://api.minecraftservices.com/minecraft/profile', { method: 'GET', token: mc.access_token });
  } catch (e) {
    if (e.status === 404) {
      throw new Error("Ce compte ne possède pas Minecraft: Java Edition (ou n'a pas encore choisi de pseudo sur minecraft.net).");
    }
    throw e;
  }

  return {
    accessToken: mc.access_token,
    expiresAt: Date.now() + mc.expires_in * 1000,
    xuid: decodeJwt(mc.access_token).xuid ?? '',
    profile: { id: profile.id, name: profile.name, skin: profile.skins?.find((s) => s.state === 'ACTIVE')?.url ?? null },
  };
}
