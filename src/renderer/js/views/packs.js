import { call, on, openFolder, store } from '../api.js';
import { clear, emptyState, formatBytes, formatDate, h, icon, loading, toast } from '../ui.js';

export function renderPacks(root) {
  const list = h('div');
  root.append(
    h(
      'div.page-head',
      h(
        'div',
        h('h2', 'Packs de textures'),
        h('p', 'Les packs de ressources du serveur. Ils sont activés automatiquement au prochain lancement du jeu.'),
      ),
      h('button.btn.secondary', { onclick: () => openFolder('resourcepacks') }, icon('folder'), 'Ouvrir le dossier'),
    ),
    list,
  );

  const progress = new Map();
  const offProgress = on('pack-progress', (p) => {
    const bar = progress.get(p.name);
    if (bar && p.total) bar.style.width = `${Math.round((p.done / p.total) * 100)}%`;
  });

  async function load() {
    clear(list).append(loading('Récupération des packs…'));
    let packs;
    try {
      packs = await call('packs:list');
    } catch (e) {
      clear(list).append(
        h(
          'div.card',
          emptyState(
            'alert',
            'Impossible de récupérer les packs',
            e.message,
            h('button.btn.secondary', { onclick: load }, icon('refresh'), 'Réessayer'),
          ),
        ),
      );
      return;
    }
    clear(list);
    if (!packs.length)
      return list.append(
        h('div.card', emptyState('palette', 'Aucun pack disponible', 'L’équipe n’a pas encore publié de pack de textures.')),
      );
    const grid = h('div.packs');
    for (const p of packs) grid.append(packCard(p));
    // Le jeu réécrit ses options en quittant : on ne touche aux packs que jeu fermé.
    if (store.game.state !== 'idle') {
      for (const el of grid.querySelectorAll('button, input')) el.disabled = true;
      list.append(
        h(
          'div.announcement',
          { style: { marginTop: 0, marginBottom: '16px' } },
          icon('info'),
          h('p', 'Ferme le jeu pour installer ou activer des packs de textures.'),
        ),
      );
    }
    list.append(grid);
  }

  function packCard(p) {
    const actions = h('div.actions');
    const run = async (fn, okMsg) => {
      for (const b of actions.querySelectorAll('button,input')) b.disabled = true;
      try {
        await fn();
        if (okMsg) toast(okMsg, 'ok');
      } catch (e) {
        toast(e.message, 'error', 7000);
      }
      load();
    };

    if (!p.installed) {
      const bar = h('i');
      progress.set(p.name, bar);
      actions.append(
        h(
          'button.btn.primary.small',
          {
            onclick: (e) => (
              e.currentTarget.replaceWith(h('div.bar', { style: { flex: 1 } }, bar)),
              run(() => call('packs:install', p.name), `${p.title} installé et activé.`)
            ),
          },
          icon('download'),
          'Installer',
        ),
      );
    } else {
      const toggle = h('input', {
        type: 'checkbox',
        checked: p.enabled,
        onchange: (e) => run(() => call('packs:toggle', p.name, e.target.checked)),
      });
      actions.append(h('label.switch', toggle, h('i'), p.enabled ? 'Activé' : 'Désactivé'));
      actions.append(h('span', { style: { flex: 1 } }));
      if (p.updateAvailable)
        actions.append(
          h(
            'button.btn.primary.small',
            { onclick: () => run(() => call('packs:install', p.name), 'Pack mis à jour.') },
            icon('refresh'),
            'Mettre à jour',
          ),
        );
      actions.append(
        h(
          'button.btn.ghost.small',
          { title: 'Supprimer', onclick: () => run(() => call('packs:remove', p.name), 'Pack supprimé.') },
          icon('trash'),
        ),
      );
    }

    return h(
      'div.card.pack',
      h(
        'div.top',
        h('div.icon', p.icon ? h('img', { src: p.icon, alt: '' }) : icon('palette')),
        h('div', h('h4', p.title), h('div.muted.small', `${formatBytes(p.size)} · ${formatDate(p.modified)}`)),
      ),
      h('div.desc', p.description || (p.installed ? '' : 'Non installé')),
      actions,
    );
  }

  load();
  let wasIdle = store.game.state === 'idle';
  const offStore = store.subscribe((patch) => {
    const idle = store.game.state === 'idle';
    if ('game' in patch && idle !== wasIdle) {
      wasIdle = idle;
      load();
    }
  });
  return () => {
    offProgress();
    offStore();
  };
}
