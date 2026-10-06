import { call, store } from '../api.js';
import { clear, emptyState, h, icon } from '../ui.js';

const TABS = [
  { id: 'bluemap', label: 'Carte du monde (BlueMap)', icon: 'map' },
  { id: 'transport', label: 'Plan des transports', icon: 'train' },
];

export function renderMaps(root, { params }) {
  let tab = params.tab ?? 'bluemap';
  const frames = {};
  const bar = h('div.maps-bar');
  const area = h('div.map-frame');
  root.append(bar, area);

  function url(id) {
    return store.info?.maps?.[id];
  }

  function renderBar() {
    const tabs = h(
      'div.tabs',
      TABS.map((t) =>
        h(
          'button',
          {
            class: t.id === tab ? 'active' : '',
            onclick: () => {
              tab = t.id;
              renderBar();
              renderArea();
            },
          },
          icon(t.icon),
          t.label,
        ),
      ),
    );
    clear(bar).append(
      tabs,
      h('span', { style: { flex: 1 } }),
      h('button.btn.ghost.small', { title: 'Recharger', onclick: () => frames[tab] && (frames[tab].src = url(tab)) }, icon('refresh')),
      h('button.btn.secondary.small', { onclick: () => call('open:url', url(tab)) }, icon('external'), 'Ouvrir dans le navigateur'),
    );
  }

  function renderArea() {
    const online = store.status?.online;
    if (!online) {
      for (const f of Object.values(frames)) f.remove();
      for (const k of Object.keys(frames)) delete frames[k];
      clear(area).append(
        h(
          'div.map-closed',
          h(
            'div.card',
            { style: { maxWidth: '440px' } },
            emptyState(
              'map',
              store.status ? 'Le serveur est fermé' : 'Vérification du serveur…',
              'Les cartes en direct sont disponibles uniquement lorsque le serveur est ouvert.',
            ),
          ),
        ),
      );
      return;
    }
    area.querySelector('.map-closed')?.remove();
    // Les cartes déjà chargées sont conservées pour éviter de les recharger à chaque onglet.
    if (!frames[tab]) {
      // Pas de « allow-top-navigation » : une carte ne peut pas remplacer l'interface du launcher.
      frames[tab] = h('iframe', {
        src: url(tab),
        title: tab,
        allow: 'fullscreen',
        referrerpolicy: 'no-referrer',
        sandbox: 'allow-scripts allow-same-origin allow-popups allow-forms',
      });
      area.append(frames[tab]);
    }
    for (const [id, f] of Object.entries(frames)) f.hidden = id !== tab;
  }

  renderBar();
  renderArea();
  let wasOnline = store.status?.online;
  return store.subscribe((patch) => {
    if ('status' in patch && store.status?.online !== wasOnline) {
      wasOnline = store.status?.online;
      renderArea();
    }
  });
}
