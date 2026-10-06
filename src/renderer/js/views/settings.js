import { call, openFolder, store } from '../api.js';
import { refreshModpack, showConsole } from '../app.js';
import { h, icon, modal, toast } from '../ui.js';

export function renderSettings(root) {
  const info = store.info;
  root.append(h('div.page-head', h('div', h('h2', 'Paramètres'), h('p', 'Performances du jeu, Java et outils de dépannage.'))));
  const gameCard = h('div.card');
  const javaCard = h('div.card');
  const grid = h('div.settings', gameCard, javaCard);
  root.append(grid);

  call('settings:get').then((s) => {
    const save = async (patch) => {
      try {
        Object.assign(s, await call('settings:set', patch));
      } catch (e) {
        toast(e.message, 'error');
      }
    };

    // --- Mémoire -----------------------------------------------------------
    const maxMb = Math.max(4096, Math.floor((info.totalMemMb - 1024) / 512) * 512);
    const out = h('output', `${(s.memoryMb / 1024).toFixed(1)} Go`);
    const range = h('input', {
      type: 'range',
      min: 2048,
      max: maxMb,
      step: 512,
      value: s.memoryMb,
      oninput: (e) => (out.textContent = `${(e.target.value / 1024).toFixed(1)} Go`),
      onchange: (e) => save({ memoryMb: Number(e.target.value) }),
    });

    const check = (key, title, desc) =>
      h(
        'div.check-row',
        h('div', h('b', title), h('span', desc)),
        h('label.switch', h('input', { type: 'checkbox', checked: s[key], onchange: (e) => save({ [key]: e.target.checked }) }), h('i')),
      );

    gameCard.append(
      h('h3', icon('memory'), 'Jeu'),
      h(
        'label.field',
        'Mémoire allouée',
        h('div.range-row', range, out),
        h(
          'span.help',
          `Ta machine dispose de ${(info.totalMemMb / 1024).toFixed(0)} Go. 4 à 6 Go conviennent au modpack ; trop de mémoire peut provoquer des saccades.`,
        ),
      ),
      check('autoConnect', 'Connexion directe au serveur', 'Rejoint le serveur dès que le jeu a démarré.'),
      check('fullscreen', 'Plein écran', 'Démarre Minecraft en plein écran.'),
      check('hideOnLaunch', 'Masquer le launcher pendant la partie', 'Il réapparaît automatiquement quand tu quittes le jeu.'),
    );

    // --- Java ---------------------------------------------------------------
    const javaLabel = h('span.help', s.javaPath ? s.javaPath : 'Automatique : Java 17 fourni par Mojang est installé par le launcher.');
    const jvm = h('input.input', { value: s.jvmArgs, placeholder: 'ex. -XX:+UseZGC', onchange: (e) => save({ jvmArgs: e.target.value }) });
    javaCard.append(
      h('h3', icon('wrench'), 'Java'),
      h(
        'label.field',
        'Exécutable Java',
        javaLabel,
        h(
          'div.row',
          h(
            'button.btn.secondary.small',
            {
              onclick: async () => {
                try {
                  const r = await call('settings:pickJava');
                  if (r) {
                    Object.assign(s, r);
                    javaLabel.textContent = r.javaPath;
                    toast('Java personnalisé enregistré.', 'ok');
                  }
                } catch (e) {
                  toast(e.message, 'error', 7000);
                }
              },
            },
            'Choisir…',
          ),
          h(
            'button.btn.ghost.small',
            {
              onclick: async () => {
                await save({ javaPath: '' });
                javaLabel.textContent = 'Automatique : Java 17 fourni par Mojang est installé par le launcher.';
              },
            },
            'Revenir à l’automatique',
          ),
        ),
      ),
      h('label.field', 'Arguments JVM supplémentaires', jvm, h('span.help', 'Réservé aux utilisateurs avancés.')),
    );
  });

  // --- Dossiers & dépannage ----------------------------------------------------
  const folder = (which, label) => h('button.btn.secondary.small', { onclick: () => openFolder(which) }, icon('folder'), label);
  grid.append(
    h(
      'div.card',
      h('h3', icon('folder'), 'Dossiers'),
      h(
        'div.folders',
        folder('game', 'Dossier du jeu'),
        folder('mods', 'Mods'),
        folder('resourcepacks', 'Packs de textures'),
        folder('screenshots', 'Captures d’écran'),
        folder('logs', 'Logs du jeu'),
        folder('crash', 'Rapports de crash'),
      ),
    ),
    h(
      'div.card',
      h('h3', icon('terminal'), 'Dépannage'),
      h(
        'p.muted',
        'Le jeu ne démarre plus ? La réparation vérifie chaque fichier (Java, Minecraft, Forge, mods) et retélécharge ceux qui sont abîmés.',
      ),
      h(
        'div.row',
        h(
          'button.btn.secondary',
          {
            onclick: async (e) => {
              if (store.game.state !== 'idle') return toast('Ferme le jeu avant de lancer une réparation.', 'error');
              const ok = await modal({
                title: 'Réparer l’installation ?',
                body: h('p', 'Tous les fichiers vont être vérifiés. Cela peut prendre quelques minutes.'),
                actions: [
                  { label: 'Annuler', value: false },
                  { label: 'Réparer', value: true, kind: 'primary' },
                ],
              });
              if (!ok) return;
              e.target.disabled = true;
              try {
                await call('game:repair');
                toast('Installation vérifiée et réparée.', 'ok');
              } catch (err) {
                if (!err.cancelled) toast(err.message, 'error', 8000);
              } finally {
                e.target.disabled = false;
                refreshModpack();
              }
            },
          },
          icon('wrench'),
          'Réparer l’installation',
        ),
        h('button.btn.ghost', { onclick: showConsole }, icon('terminal'), 'Journal du jeu'),
        h('button.btn.ghost', { onclick: () => openFolder('launcherLogs') }, 'Logs du launcher'),
      ),
      h('p.muted.small', `Launcher version ${info.version} · ${info.platform}`),
    ),
  );
}
