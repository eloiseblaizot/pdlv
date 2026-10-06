import { call, store } from '../api.js';
import { clear, formatDate, h, headUrl, icon, motd } from '../ui.js';

export function renderHome(root, { navigate }) {
  const hero = h('div');
  const announcement = h('div');
  const serverCard = h('div.card');
  const modpackCard = h('div.card');
  const shortcuts = h('div.card');

  root.append(hero, announcement, h('div.home-grid', h('div.grid', serverCard, shortcuts), h('div.grid', modpackCard)));

  function renderHero() {
    const s = store.status;
    const acc = store.account;
    const pills = [];
    if (!s)
      pills.push(
        h('span.pill', h('span.spinner', { style: { width: '12px', height: '12px', borderWidth: '2px' } }), 'Vérification du serveur'),
      );
    else if (s.online) {
      pills.push(h('span.pill.ok', h('span.dot'), 'Serveur ouvert'));
      pills.push(h('span.pill', `${s.playersOnline} / ${s.playersMax} joueurs`));
      if (s.latency != null) pills.push(h('span.pill', `${s.latency} ms`));
    } else pills.push(h('span.pill.ko', h('span.dot'), 'Serveur fermé'));
    if (store.info?.server) pills.push(h('span.pill', store.info.server.host));

    clear(hero).append(
      h(
        'div.hero',
        h('img.favicon', { src: s?.favicon ?? 'assets/icon.png', alt: '' }),
        h(
          'div.txt',
          h('div.hello', `Bonjour ${acc?.name ?? ''} 👋`),
          h('h2', store.info?.serverName ?? 'Pays de la Valière'),
          s?.online && s.motd
            ? h('div.motd', motd(s.motd))
            : h('div.motd', s ? 'Le serveur est actuellement fermé. Reviens un peu plus tard !' : '…'),
          h('div.pills', pills),
        ),
      ),
    );
  }

  function renderServer() {
    const s = store.status;
    clear(serverCard).append(
      h(
        'div.card-head',
        h('h3', icon('users'), 'Joueurs en ligne'),
        h('button.btn.ghost.small', { title: 'Actualiser', onclick: () => call('status:refresh') }, icon('refresh')),
      ),
    );
    if (!s) return serverCard.append(h('p.muted', 'Vérification…'));
    if (!s.online) {
      return serverCard.append(
        h('p.muted', 'Le serveur est fermé : la liste des joueurs et les cartes en direct reviendront à sa réouverture.'),
      );
    }
    serverCard.append(h('div.stat-big', s.playersOnline, h('small', ` / ${s.playersMax}`)));
    if (s.playersOnline === 0) {
      serverCard.append(h('p.muted', { style: { marginTop: '8px' } }, 'Personne pour le moment — sois le premier !'));
      return;
    }
    const list = h('div.players', { style: { marginTop: '12px' } });
    for (const p of s.players) list.append(h('div.player', h('img', { src: headUrl(p.uuid ?? p.name, 32), alt: '' }), p.name));
    serverCard.append(list);
    if (!s.playersComplete) {
      serverCard.append(
        h('p.muted.small', { style: { marginTop: '8px' } }, `… et ${Math.max(0, s.playersOnline - s.players.length)} autre(s).`),
      );
    }
  }

  function renderModpack() {
    const m = store.modpack;
    clear(modpackCard).append(
      h(
        'div.card-head',
        h('h3', icon('package'), 'Modpack'),
        h('button.btn.ghost.small', { onclick: () => navigate('modpack') }, 'Détails'),
      ),
    );
    if (!m) return modpackCard.append(h('p.muted', 'Chargement…'));
    if (!m.remote) return modpackCard.append(h('p.muted', m.error ?? 'Modpack indisponible.'));
    const r = m.remote;
    let status;
    if (!m.installedVersion) status = h('span.pill.rose', 'À installer');
    else if (m.upToDate) status = h('span.pill.ok', icon('check'), 'À jour');
    else status = h('span.pill.rose', `Mise à jour ${r.version}`);
    modpackCard.append(
      h(
        'dl.kv',
        h('dt', 'Version'),
        h('dd', h('span.row', r.version, status)),
        h('dt', 'Minecraft'),
        h('dd', `${r.minecraft} · Forge ${r.forge}`),
        h('dt', 'Mods'),
        h('dd', `${r.mods.length} mods`),
        h('dt', 'Publiée le'),
        h('dd', formatDate(r.releasedAt)),
      ),
    );
    if (r.changelog.length) {
      modpackCard.append(
        h('h4', { style: { marginTop: '16px', fontSize: '14px' } }, 'Nouveautés'),
        h(
          'ul.changelog',
          r.changelog.slice(0, 6).map((c) => h('li', c)),
        ),
      );
    }
    modpackCard.append(
      h(
        'div.row',
        { style: { marginTop: '16px' } },
        h('button.btn.secondary.small', { onclick: () => navigate('modpack', { suggest: true }) }, icon('bulb'), 'Suggérer un mod'),
        h('button.btn.secondary.small', { onclick: () => navigate('packs') }, icon('palette'), 'Packs de textures'),
      ),
    );
  }

  function renderAnnouncement() {
    const text = store.modpack?.remote?.announcement;
    clear(announcement);
    if (text) announcement.append(h('div.announcement', icon('info'), h('p', text)));
  }

  function renderShortcuts() {
    const online = !!store.status?.online;
    clear(shortcuts).append(
      h('div.card-head', h('h3', icon('sparkles'), 'Raccourcis')),
      h(
        'div.tiles',
        h(
          'button.tile',
          {
            disabled: !online,
            title: online ? '' : 'Disponible quand le serveur est ouvert',
            onclick: () => navigate('maps', { tab: 'bluemap' }),
          },
          icon('map'),
          h('b', 'Carte du monde'),
          h('span', online ? 'BlueMap en direct' : 'Serveur fermé'),
        ),
        h(
          'button.tile.plum',
          {
            disabled: !online,
            title: online ? '' : 'Disponible quand le serveur est ouvert',
            onclick: () => navigate('maps', { tab: 'transport' }),
          },
          icon('train'),
          h('b', 'Plan des transports'),
          h('span', online ? 'Réseau MTR' : 'Serveur fermé'),
        ),
        h('button.tile.rose', { onclick: () => navigate('images') }, icon('upload'), h('b', 'Images'), h('span', 'Envoyer et partager')),
        h(
          'button.tile.steel',
          { onclick: () => navigate('packs') },
          icon('palette'),
          h('b', 'Packs de textures'),
          h('span', 'Installer en un clic'),
        ),
      ),
    );
  }

  const renderAll = () => {
    renderHero();
    renderAnnouncement();
    renderServer();
    renderModpack();
    renderShortcuts();
  };
  renderAll();
  return store.subscribe((patch) => {
    if ('status' in patch || 'account' in patch) {
      renderHero();
      renderServer();
      renderShortcuts();
    }
    if ('modpack' in patch) {
      renderModpack();
      renderAnnouncement();
    }
  });
}
