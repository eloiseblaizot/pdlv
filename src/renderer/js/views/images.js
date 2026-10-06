import { call } from '../api.js';
import { clear, emptyState, formatBytes, h, icon, loading, toast } from '../ui.js';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

export function renderImages(root) {
  let path = [];
  const crumbs = h('div.crumbs');
  const content = h('div');

  root.append(
    h(
      'div.page-head',
      h(
        'div',
        h('h2', 'Images'),
        h('p', 'Les images du serveur, à afficher en jeu dans les cadres photo (mod « Online Picture Frames »).'),
      ),
    ),
    h(
      'div.card.upload-card',
      h('div.ic', icon('upload')),
      h(
        'div',
        { style: { flex: 1 } },
        h('h3', 'Envoyer une image sur le serveur'),
        h(
          'p.muted',
          'Dépose tes images dans le Drive du serveur ; elles apparaîtront ensuite ci-dessous avec un lien à copier dans le cadre photo.',
        ),
      ),
      h('button.btn.primary', { onclick: () => call('images:openUpload') }, icon('upload'), 'Ouvrir le Drive'),
    ),
    crumbs,
    content,
  );

  function renderCrumbs() {
    clear(crumbs).append(h('button', { onclick: () => go([]) }, 'Images'));
    path.forEach((p, i) => crumbs.append(h('span', '/'), h('button', { onclick: () => go(path.slice(0, i + 1)) }, p)));
  }

  async function go(newPath) {
    path = newPath;
    renderCrumbs();
    clear(content).append(loading());
    let entries;
    try {
      entries = await call('images:list', path.map((p) => `${encodeURIComponent(p)}/`).join(''));
    } catch (e) {
      clear(content).append(
        h(
          'div.card',
          emptyState(
            'alert',
            'Impossible de lister les images',
            e.message,
            h('button.btn.secondary', { onclick: () => go(path) }, icon('refresh'), 'Réessayer'),
          ),
        ),
      );
      return;
    }
    clear(content);
    const folders = entries.filter((e) => e.isDir);
    const images = entries.filter((e) => !e.isDir && IMAGE_EXT.test(e.name));
    const others = entries.filter((e) => !e.isDir && !IMAGE_EXT.test(e.name));
    if (!folders.length && !images.length && !others.length) {
      content.append(h('div.card', emptyState('image', 'Dossier vide', 'Aucune image ici pour le moment.')));
      return;
    }
    if (folders.length) {
      content.append(
        h(
          'div.gallery',
          { style: { marginBottom: '14px' } },
          folders.map((f) => h('button.folder', { onclick: () => go([...path, f.name]) }, icon('folder'), h('b', f.name))),
        ),
      );
    }
    const grid = h('div.gallery');
    for (const img of images) {
      grid.append(
        h(
          'div.shot',
          h('img.thumb', {
            src: img.url,
            loading: 'lazy',
            alt: img.name,
            title: img.name,
            onclick: () => call('open:url', img.url),
            style: { cursor: 'zoom-in' },
          }),
          h(
            'div.meta',
            h('b', { title: img.name }, img.name),
            h('span.muted.small', formatBytes(img.size)),
            h(
              'button.btn.ghost.small',
              {
                title: 'Copier le lien',
                onclick: () => {
                  call('clipboard:write', img.url);
                  toast('Lien copié ! Colle-le dans un cadre photo en jeu.', 'ok');
                },
              },
              icon('copy'),
            ),
          ),
        ),
      );
    }
    content.append(grid);
    if (others.length) {
      content.append(
        h(
          'p.muted.small',
          { style: { marginTop: '14px' } },
          `${others.length} autre(s) fichier(s) non affiché(s) (formats non pris en charge en jeu).`,
        ),
      );
    }
  }

  go([]);
}
