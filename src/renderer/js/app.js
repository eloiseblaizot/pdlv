import { call, on, store } from './api.js';
import { clear, h, headUrl, icon, modal, toast } from './ui.js';
import { renderHome } from './views/home.js';
import { renderImages } from './views/images.js';
import { renderMaps } from './views/maps.js';
import { renderModpack } from './views/modpack.js';
import { renderPacks } from './views/packs.js';
import { renderSettings } from './views/settings.js';

const VIEWS = [
  { id: 'home', label: 'Accueil', icon: 'home', render: renderHome },
  { id: 'maps', label: 'Cartes', icon: 'map', render: renderMaps, full: true },
  { id: 'modpack', label: 'Modpack', icon: 'package', render: renderModpack },
  { id: 'packs', label: 'Packs de textures', icon: 'palette', render: renderPacks },
  { id: 'images', label: 'Images', icon: 'image', render: renderImages },
  { id: 'settings', label: 'Paramètres', icon: 'settings', render: renderSettings },
];

const $ = (id) => document.getElementById(id);
let currentView = null;
let cleanupView = null;

// --- Navigation ------------------------------------------------------------------

export function navigate(id, params = {}) {
  const view = VIEWS.find((v) => v.id === id) ?? VIEWS[0];
  cleanupView?.();
  cleanupView = null;
  currentView = view.id;
  for (const b of $('nav').children) b.classList.toggle('active', b.dataset.view === view.id);
  const container = clear($('view'));
  container.classList.toggle('full', !!view.full);
  container.scrollTop = 0;
  cleanupView = view.render(container, { navigate, params }) ?? null;
}

function buildNav() {
  const nav = clear($('nav'));
  for (const v of VIEWS) {
    nav.append(
      h(
        'button',
        { 'data-view': v.id, onclick: () => navigate(v.id) },
        icon(v.icon),
        v.label,
        v.id === 'modpack' ? h('span.badge', { id: 'modpack-badge', hidden: true }, 'MAJ') : null,
      ),
    );
  }
}

// --- Compte -------------------------------------------------------------------------

function showLogin(errorMessage) {
  $('app').hidden = true;
  $('login').hidden = false;
  const err = $('login-error');
  err.hidden = !errorMessage;
  err.textContent = errorMessage ?? '';
}

function showApp() {
  $('login').hidden = true;
  $('app').hidden = false;
  const acc = store.account;
  $('account-name').textContent = acc.name;
  $('account-head').src = headUrl(acc.uuid, 64);
  if (!currentView) navigate('home');
}

async function login() {
  const btn = $('login-btn');
  btn.disabled = true;
  $('login-error').hidden = true;
  try {
    const account = await call('auth:login');
    store.set({ account });
    showApp();
    toast(`Bienvenue, ${account.name} !`, 'ok');
  } catch (e) {
    if (!e.cancelled) showLogin(e.message);
  } finally {
    btn.disabled = false;
  }
}

async function logout() {
  if (store.game.state !== 'idle') return toast('Impossible de se déconnecter pendant une partie.', 'error');
  const ok = await modal({
    title: 'Se déconnecter ?',
    body: h('p', 'Tu devras te reconnecter avec ton compte Microsoft pour jouer.'),
    actions: [
      { label: 'Annuler', value: false },
      { label: 'Se déconnecter', value: true, kind: 'primary' },
    ],
  });
  if (!ok) return;
  await call('auth:logout');
  store.set({ account: null });
  showLogin();
}

// --- Barre de jeu -------------------------------------------------------------------------

const progressState = { label: null, ratio: null, detail: '' };

function renderMiniStatus() {
  const s = store.status;
  $('mini-name').textContent = store.info?.serverName ?? 'Pays de la Valière';
  if (!s) $('mini-status').textContent = 'Vérification…';
  else if (s.online) $('mini-status').textContent = `🟢 Ouvert · ${s.playersOnline}/${s.playersMax} joueurs`;
  else $('mini-status').textContent = '🔴 Fermé';
  $('mini-favicon').src = s?.favicon ?? 'assets/icon.png';
}

function renderProgress() {
  const zone = clear($('progress-zone'));
  const state = store.game.state;
  if (state === 'preparing' && progressState.label) {
    const bar = h('div.bar', h('i'));
    if (progressState.ratio == null) bar.classList.add('indeterminate');
    else bar.firstChild.style.width = `${Math.round(progressState.ratio * 100)}%`;
    zone.append(h('div.label', h('b', progressState.label), h('span', progressState.detail)), bar);
  } else if (state === 'running') {
    zone.append(
      h('div.label', h('b', 'Minecraft est lancé — bon jeu !'), h('a', { onclick: showConsole }, 'Voir le journal')),
      h('div.bar', h('i', { style: { width: '100%' } })),
    );
  } else {
    const m = store.modpack;
    let hint = 'Prêt à jouer.';
    if (m?.remote && !m.upToDate)
      hint = m.installedVersion
        ? `Mise à jour ${m.remote.version} disponible : elle sera installée au lancement.`
        : 'Le jeu et le modpack seront installés au premier lancement.';
    if (m?.offline) hint = 'Mode hors-ligne : la liste des mods n’a pas pu être vérifiée.';
    zone.append(h('div.hint', hint));
  }
}

function renderPlayButton() {
  const btn = $('play-btn');
  const state = store.game.state;
  btn.className = 'play';
  btn.disabled = false;
  clear(btn);
  if (state === 'preparing') {
    btn.classList.add('cancel');
    btn.append('ANNULER');
  } else if (state === 'running') {
    btn.disabled = true;
    btn.append(h('span', 'EN JEU', h('small', 'Minecraft est ouvert')));
  } else {
    btn.append(icon('play'), 'JOUER');
  }
}

let playRequested = false;

async function onPlay() {
  const state = store.game.state;
  if (state === 'preparing') return call('game:cancel');
  // Le renouvellement de session précède l'installation : on ignore les doubles clics.
  if (state !== 'idle' || playRequested) return;
  playRequested = true;
  progressState.label = 'Préparation…';
  progressState.ratio = null;
  progressState.detail = '';
  try {
    await call('game:play');
  } catch (e) {
    if (e.sessionExpired) {
      store.set({ account: null });
      return showLogin(e.message);
    }
    if (!e.cancelled) {
      modal({
        title: 'Lancement impossible',
        body: h('p.selectable', e.message),
        actions: [{ label: 'OK', value: true, kind: 'primary' }],
      });
    }
  } finally {
    playRequested = false;
    refreshModpack();
  }
}

function onProgress(p) {
  const pct = p.total ? p.done / p.total : null;
  progressState.label = p.label ?? 'Préparation…';
  progressState.ratio = p.phase === 'start' ? null : pct;
  if (p.phase === 'download' && p.total) progressState.detail = `${(p.done / 1048576).toFixed(0)} / ${(p.total / 1048576).toFixed(0)} Mo`;
  else if (p.phase === 'check') progressState.detail = `Vérification ${p.done}/${p.total}`;
  else if (p.phase === 'process') progressState.detail = `Étape ${Math.min(p.done + 1, p.total)}/${p.total}`;
  else progressState.detail = '';
  renderProgress();
}

// --- Journal du jeu / crash ------------------------------------------------------------------

export async function showConsole() {
  const lines = await call('game:logs');
  const box = h('div.console');
  const add = (l) => {
    box.append(h('div', { class: /ERROR|FATAL|Exception/.test(l) ? 'e' : /WARN/.test(l) ? 'w' : '' }, l));
  };
  lines.forEach(add);
  const off = on('log', (l) => {
    add(l);
    box.scrollTop = box.scrollHeight;
  });
  setTimeout(() => (box.scrollTop = box.scrollHeight));
  await modal({ title: 'Journal du jeu', body: box, actions: [{ label: 'Fermer', value: true }] });
  off();
}

function onGameState(s) {
  store.set({ game: s });
  renderPlayButton();
  renderProgress();
  if (s.state === 'idle' && s.crashed) {
    const body = h(
      'div',
      h('p', `Minecraft s'est arrêté de manière inattendue (code ${s.exitCode}).`),
      h('p.muted.small', { style: { margin: '8px 0' } }, 'Dernières lignes du journal :'),
      h('div.console', { style: { height: '220px' } }, (s.lastLines ?? []).join('\n')),
    );
    const actions = [{ label: 'Fermer', value: null }];
    if (s.crashReport) actions.unshift({ label: 'Ouvrir le rapport de crash', value: 'report' });
    modal({ title: 'Le jeu a planté', body, actions }).then((v) => {
      if (v === 'report') call('open:crashReport', s.crashReport);
    });
  }
}

// --- Données partagées --------------------------------------------------------------------------

export async function refreshModpack() {
  try {
    const modpack = await call('modpack:info');
    store.set({ modpack });
    const badge = $('modpack-badge');
    if (badge) badge.hidden = !(modpack.remote && modpack.installedVersion && !modpack.upToDate);
  } catch {
    /* affiché dans la vue modpack */
  }
  renderProgress();
}

function renderUpdate(u) {
  const zone = clear($('update-zone'));
  if (u.state === 'ready') {
    zone.append(
      icon('sparkles'),
      `Version ${u.version} prête`,
      h('button.btn.primary.small', { onclick: () => call('update:install') }, 'Redémarrer'),
    );
  } else if (u.state === 'available') {
    zone.append(icon('sparkles'), `Nouvelle version du launcher (${u.version}) disponible`);
    if (store.info?.updatesUrl)
      zone.append(h('button.btn.primary.small', { onclick: () => call('open:url', store.info.updatesUrl) }, 'Télécharger'));
  } else if (u.state === 'downloading') {
    zone.append(`Téléchargement de la mise à jour du launcher${u.percent != null ? ` (${u.percent} %)` : '…'}`);
  }
}

// --- Démarrage -----------------------------------------------------------------------------------

async function boot() {
  // Un fichier glissé sur la fenêtre ne doit pas remplacer l'interface.
  for (const type of ['dragover', 'drop']) document.addEventListener(type, (e) => e.preventDefault());
  buildNav();
  $('login-btn').addEventListener('click', login);
  $('logout-btn').append(icon('logout'));
  $('logout-btn').addEventListener('click', logout);
  $('play-btn').addEventListener('click', onPlay);

  on('status', (status) => {
    store.set({ status });
    renderMiniStatus();
  });
  on('progress', onProgress);
  on('game', onGameState);
  on('update', renderUpdate);
  on('account', (account) => {
    store.set({ account });
    if (!account) showLogin('Ta session a expiré, reconnecte-toi.');
    else if (!$('app').hidden) $('account-name').textContent = account.name;
  });

  const [info, account, gameState] = await Promise.all([call('app:info'), call('auth:get'), call('game:state')]);
  store.set({ info, account, game: gameState });
  renderPlayButton();
  renderProgress();
  if (account) showApp();
  else showLogin();

  call('status:get').then((status) => {
    store.set({ status });
    renderMiniStatus();
  });
  refreshModpack();
}

boot();
