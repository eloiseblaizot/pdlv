import { call, store } from '../api.js';
import { refreshModpack } from '../app.js';
import { clear, formatBytes, formatDate, h, icon, loading, toast } from '../ui.js';

export function renderModpack(root, { params }) {
  const head = h('div.page-head');
  const top = h('div.modpack-grid');
  const modsCard = h('div.card', { style: { marginTop: '18px' } });
  const suggestCard = h('div.card', { style: { marginTop: '18px' } });
  root.append(head, top, modsCard, suggestCard);

  clear(head).append(
    h('div', h('h2', 'Modpack'), h('p', 'Les mods nécessaires pour rejoindre le serveur, installés et mis à jour automatiquement.')),
  );

  function renderTop() {
    const m = store.modpack;
    clear(top);
    if (!m) return top.append(h('div.card', loading()));
    if (!m.remote) {
      return top.append(
        h('div.card', h('h3', icon('alert'), 'Modpack indisponible'), h('p.muted', { style: { marginTop: '8px' } }, m.error)),
      );
    }
    const r = m.remote;
    const busy = store.game.state !== 'idle';
    let state;
    if (!m.installedVersion) state = h('span.pill.rose', 'Non installé');
    else if (m.upToDate) state = h('span.pill.ok', icon('check'), 'À jour');
    else state = h('span.pill.rose', `Installé : ${m.installedVersion}`);

    const updateBtn = h(
      'button.btn.primary',
      {
        disabled: busy || m.upToDate,
        onclick: async () => {
          try {
            await call('modpack:update');
            toast('Modpack à jour !', 'ok');
          } catch (e) {
            if (!e.cancelled) toast(e.message, 'error', 8000);
          } finally {
            refreshModpack();
          }
        },
      },
      icon('download'),
      m.installedVersion ? 'Mettre à jour' : 'Installer',
    );

    top.append(
      h(
        'div.card',
        h('div.card-head', h('h3', icon('package'), `${r.name} ${r.version}`), state),
        h(
          'dl.kv',
          h('dt', 'Minecraft'),
          h('dd', r.minecraft),
          h('dt', 'Forge'),
          h('dd', r.forge),
          h('dt', 'Mods'),
          h('dd', `${r.mods.length} (${formatBytes(r.totalSize)})`),
          h('dt', 'Publiée le'),
          h('dd', formatDate(r.releasedAt)),
        ),
        h(
          'div.row',
          { style: { marginTop: '16px' } },
          updateBtn,
          h('button.btn.secondary', { onclick: () => call('open:folder', 'mods') }, icon('folder'), 'Dossier des mods'),
        ),
        m.offline
          ? h('p.muted.small', { style: { marginTop: '10px' } }, 'Hors-ligne : informations issues de la dernière synchronisation.')
          : null,
      ),
      h(
        'div.card',
        h('div.card-head', h('h3', icon('sparkles'), 'Notes de version')),
        r.changelog.length
          ? h(
              'ul.changelog',
              r.changelog.map((c) => h('li', c)),
            )
          : h('p.muted', 'Aucune note pour cette version.'),
      ),
    );
  }

  function renderMods() {
    const r = store.modpack?.remote;
    clear(modsCard).append(h('div.card-head', h('h3', icon('package'), 'Liste des mods')));
    if (!r) return;
    const sideLabel = { both: 'Client + serveur', client: 'Client', server: 'Serveur' };
    modsCard.append(
      h(
        'div.mods-scroll',
        h(
          'table.mods',
          h('thead', h('tr', h('th', 'Mod'), h('th', 'Version'), h('th', 'Côté'), h('th', { style: { textAlign: 'right' } }, 'Taille'))),
          h(
            'tbody',
            r.mods.map((mod) =>
              h(
                'tr',
                h('td', h('b', mod.name)),
                h('td.v', mod.version),
                h('td.muted', sideLabel[mod.side] ?? mod.side),
                h('td.muted', { style: { textAlign: 'right' } }, formatBytes(mod.size)),
              ),
            ),
          ),
        ),
      ),
    );
  }

  // --- Suggestions ---------------------------------------------------------------
  let selected = null;
  function renderSuggest() {
    const enabled = store.info?.suggestionsEnabled;
    const input = h('input.input', { placeholder: 'Rechercher un mod Forge 1.20.1 sur Modrinth…', type: 'search' });
    const results = h('div.results');
    const reason = h('textarea.textarea', {
      placeholder: 'Pourquoi ce mod ? (ce qu’il apporte au serveur, liens utiles…)',
      maxlength: 1500,
    });
    const free = h('input.input', { placeholder: 'Ou saisis le nom / le lien d’un mod', maxlength: 200 });
    const sendBtn = h('button.btn.primary', { disabled: !enabled }, icon('bulb'), 'Envoyer la suggestion');

    const search = async () => {
      const q = input.value.trim();
      if (!q) return;
      clear(results).append(loading('Recherche…'));
      try {
        const hits = await call('mods:search', q);
        const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]/g, '');
        const installed = new Set((store.modpack?.remote?.mods ?? []).flatMap((m) => [norm(m.name), norm(m.id)]));
        clear(results);
        if (!hits.length) results.append(h('p.muted', 'Aucun mod Forge 1.20.1 trouvé.'));
        for (const hit of hits) {
          const el = h(
            'button.result',
            {
              onclick: () => {
                selected = hit;
                for (const c of results.children) c.classList.remove('selected');
                el.classList.add('selected');
                free.value = '';
              },
            },
            hit.icon ? h('img', { src: hit.icon, alt: '' }) : h('div.noicon'),
            h('div.t', h('b', hit.title), h('span', hit.description)),
            installed.has(norm(hit.title)) || installed.has(norm(hit.slug))
              ? h('span.pill.ok', 'Déjà dans le pack')
              : h('span.pill', `${Intl.NumberFormat('fr-FR', { notation: 'compact' }).format(hit.downloads)} tél.`),
            h(
              'a.btn.ghost.small',
              { title: 'Voir sur Modrinth', onclick: (e) => (e.stopPropagation(), call('open:url', hit.url)) },
              icon('external'),
            ),
          );
          results.append(el);
        }
      } catch (e) {
        clear(results).append(h('p.muted', e.message));
      }
    };
    input.addEventListener('keydown', (e) => e.key === 'Enter' && search());
    free.addEventListener('input', () => {
      if (free.value) {
        selected = null;
        for (const c of results.children) c.classList.remove('selected');
      }
    });

    sendBtn.addEventListener('click', async () => {
      const title = selected?.title ?? free.value.trim();
      if (!title) return toast('Choisis un mod dans la recherche ou saisis son nom.', 'error');
      const url = selected?.url ?? (/^https?:\/\//.test(free.value.trim()) ? free.value.trim() : '');
      sendBtn.disabled = true;
      try {
        await call('mods:suggest', { title, url, reason: reason.value.trim() });
        toast('Merci ! Ta suggestion a été transmise à l’équipe.', 'ok');
        reason.value = '';
        free.value = '';
        selected = null;
        for (const c of results.children) c.classList.remove('selected');
      } catch (e) {
        toast(e.message, 'error', 7000);
      } finally {
        sendBtn.disabled = !enabled;
      }
    });

    clear(suggestCard).append(
      h('div.card-head', h('h3', icon('bulb'), 'Suggérer un nouveau mod')),
      h(
        'p.muted',
        { style: { marginBottom: '14px' } },
        'Propose un mod à l’équipe du serveur. Il doit être compatible Forge 1.20.1 et, idéalement, utile à tout le monde.',
      ),
      h('div.search-row', input, h('button.btn.secondary', { onclick: search }, icon('search'), 'Rechercher')),
      results,
      h('div.grid', { style: { marginTop: '14px', gap: '10px' } }, free, reason),
      h(
        'div.row',
        { style: { marginTop: '12px', justifyContent: 'flex-end' } },
        enabled ? null : h('span.muted.small', 'Envoi pas encore configuré par l’équipe.'),
        sendBtn,
      ),
    );
    if (params.suggest) setTimeout(() => suggestCard.scrollIntoView({ behavior: 'smooth' }), 50);
  }

  renderTop();
  renderMods();
  renderSuggest();
  refreshModpack();
  return store.subscribe((patch) => {
    if ('modpack' in patch || 'game' in patch) {
      renderTop();
      if ('modpack' in patch) renderMods();
    }
  });
}
