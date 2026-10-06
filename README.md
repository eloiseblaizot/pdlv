# Launcher — Pays de la Valière

Launcher officiel du serveur Minecraft **Pays de la Valière** (Minecraft 1.20.1 + Forge), pour Windows, macOS et Linux.

## Fonctionnalités

- **Connexion Microsoft / Xbox** : fenêtre de connexion officielle Microsoft. Les comptes Mojang n'existent plus, ils ont tous été migrés vers Microsoft. La session est conservée de façon chiffrée (trousseau du système) et renouvelée automatiquement.
- **Accueil** :
  - statut du serveur (ouvert/fermé, MOTD, latence, joueurs connectés avec leur tête) ;
  - version du modpack et notes de version ;
  - annonce optionnelle ;
  - raccourcis vers les cartes, les images et les packs de textures.
- **Bouton JOUER** :
  - installe ou met à jour Java 17, Minecraft 1.20.1, Forge et les mods ;
  - lance le jeu et **se connecte directement** à `mc.paysdelavaliere.fr`.
- **Modpack** : liste des mods, mise à jour, réparation, et **suggestion de nouveaux mods** (recherche Modrinth + envoi sur Discord).
- **Packs de textures** : installation en un clic depuis `ftp.paysdelavaliere.fr/Ressourcespack/`, activation et désactivation automatique dans le jeu.
- **Cartes** : BlueMap et plan des transports intégrés, **uniquement quand le serveur est ouvert**.
- **Images** :
  - ouverture du Drive pour envoyer des images ;
  - galerie des images du serveur, avec bouton « copier le lien » pour les cadres du mod *Online Picture Frames*.
- **Paramètres** :
  - mémoire allouée, plein écran, connexion directe ;
  - Java personnalisé ;
  - accès aux dossiers, réparation de l'installation, journal du jeu, rapport de crash.
- **Mise à jour automatique du launcher** (Windows et Linux ; sur macOS, voir plus bas).

## Organisation du code

```
launcher.config.json        Adresses du serveur, du modpack, des cartes… (à adapter)
src/main/                   Processus principal Electron
  main.js                   Fenêtre, sécurité, API exposée à l'interface
  auth/                     Connexion Microsoft → Xbox Live → Minecraft
  game/                     Java, Minecraft, Forge, synchronisation des mods, lancement
  services/                 Statut serveur, packs de textures, images, suggestions
src/preload/preload.cjs     Pont sécurisé entre l'interface et le processus principal
src/renderer/               Interface (HTML/CSS/JS, sans framework)
tools/build-modpack.mjs     Génère le manifest du modpack à publier
build/icon.png              Icône de l'application (1024×1024)
```

Les données des joueurs sont séparées de leur `.minecraft` :

| Système | Dossier |
| --- | --- |
| Windows | `%APPDATA%\.paysdelavaliere` |
| macOS | `~/Library/Application Support/paysdelavaliere` |
| Linux | `~/.paysdelavaliere` |

## Développement

Prérequis : Node.js 20 ou plus récent. Java n'est pas nécessaire, le launcher l'installe lui-même.

```bash
npm install
```

```bash
npm start
```

Variables utiles pendant le développement :

- `PDLV_HOME=/un/dossier` : dossier de données alternatif, pour ne pas toucher à son installation réelle.
- `PDLV_CONFIG=/chemin/config.json` : surcharge partielle de `launcher.config.json`, par exemple pour pointer vers un manifest de test.

## Publier le modpack

Le launcher télécharge `https://ftp.paysdelavaliere.fr/Modspack/manifest.json`. Ce fichier liste les mods avec leur empreinte SHA‑1. Les joueurs ne téléchargent que les mods qui ont changé, pas un gros zip.

1. Mets les `.jar` du pack dans un dossier, par exemple `~/Downloads/Modspack`.
2. Génère le dossier à publier :

   ```bash
   npm run modpack -- --mods ~/Downloads/Modspack --version 1.0.1 --changelog "Ajout de X" --changelog "Mise à jour de Y" --previous https://ftp.paysdelavaliere.fr/Modspack/manifest.json
   ```

3. Envoie le **contenu** de `modpack-dist/` (`manifest.json` + dossier `mods/`) dans le dossier `Modspack/` du serveur de fichiers.

Au lancement suivant, chaque joueur reçoit la mise à jour. Les mods qui ne font plus partie du pack ne sont pas supprimés : ils sont déplacés dans `mods_desactives/`.

Options du manifest, modifiables à la main après génération :

- `forge` : version de Forge. Par défaut 47.4.26, la dernière pour 1.20.1. **Le serveur doit utiliser la même.**
- `mods[].side` : `both` (défaut), `client` (non installé sur le serveur) ou `server` (non téléchargé par les joueurs). Ces valeurs peuvent aussi être fixées dans `tools/modpack.overrides.json`, par exemple `{ "chunky": { "side": "server" } }`.
- `files` : fichiers de configuration à distribuer, sous la forme `{ "path": "config/x.toml", "url": "files/config/x.toml", "sha1": "…", "size": 123, "overwrite": false }`.
- `launcher.announcement` : message affiché sur l'accueil.
- `launcher.suggestionsWebhook` : URL d'un webhook Discord qui reçoit les suggestions de mods. Il est modifiable sans republier le launcher.
  > ⚠️ Cette URL est lisible par n'importe qui : elle est dans le manifest public et dans le launcher. Quelqu'un qui la récupère peut poster dans le salon. Utilise un salon dédié aux suggestions et régénère le webhook s'il est détourné : le changer dans le manifest suffit, sans republier le launcher. Pour une protection complète, il faudrait un petit relais sur ton serveur qui garde le webhook secret et limite les envois.

> Un modpack 1.0.0 prêt à publier a déjà été généré dans `modpack-dist/` à partir des 18 mods actuels.

## Packs de textures et images

- **Packs de textures** : dépose les `.zip` dans `Ressourcespack/`. Les zips actuels contiennent un dossier racine et des fichiers `__MACOSX` (créés par « Compresser » sur macOS), ce que Minecraft ne reconnaît pas. Le launcher les réorganise automatiquement à l'installation. Pour les joueurs sans launcher, compresse plutôt le *contenu* du dossier du pack (`pack.mcmeta` à la racine du zip).
- **Images** : le bouton « Ouvrir le Drive » ouvre `images.uploadUrl` dans une fenêtre dédiée, où la connexion Synology est mémorisée. Pour permettre l'envoi sans compte, crée une « demande de fichier » Synology et mets son lien dans `launcher.config.json`. La galerie lit `ftp.paysdelavaliere.fr/Images/`.

## Côté serveur

- Le serveur doit tourner sous **Forge 1.20.1-47.4.26** avec les mêmes mods (hors mods `client`).
- Liste complète des joueurs : le ping Minecraft n'en renvoie qu'une douzaine au maximum. Pour les afficher tous :
  1. active Query dans `server.properties` (`enable-query=true`, `query.port=25565`) ;
  2. ouvre le port **UDP** correspondant ;
  3. renseigne `"queryPort": 25565` dans `launcher.config.json`.
- Les cartes (`maps.bluemap`, `maps.transport`) sont intégrées dans le launcher. Leurs en-têtes anti-iframe éventuels sont ignorés pour ces deux adresses uniquement.

## Authentification Microsoft

Par défaut, `auth.microsoftClientId` vaut `00000000402b5328` : c'est l'identifiant public historique du client Minecraft, utilisé par de nombreux launchers communautaires. Il fonctionne tout de suite.

Pour un launcher pérenne et à ton nom :

1. Crée une application sur le [portail Azure](https://portal.azure.com) (« App registrations ») :
   - type de compte : *Personal Microsoft accounts only* ;
   - plateforme : *Mobile and desktop* ;
   - URI de redirection : `https://login.live.com/oauth20_desktop.srf`.
2. Demande l'accès à l'API Minecraft pour cet identifiant via le [formulaire de Mojang](https://aka.ms/mce-reviewappid). La validation prend quelques jours.
3. Remplace `auth.microsoftClientId` par le GUID de ton application. Le launcher choisit automatiquement le bon mode de connexion.

Tant que Mojang n'a pas validé l'application, la connexion échoue avec un message explicite.

## Construire et distribuer

```bash
npm run dist:win
```

```bash
npm run dist:mac
```

```bash
npm run dist:linux
```

- `dist:win` produit un installateur `.exe` (NSIS).
- `dist:mac` produit des `.dmg` et `.zip` (Apple Silicon et Intel).
- `dist:linux` produit un `.AppImage` et un `.deb`. Le `.deb` ne se construit que sous Linux.

Le plus simple est la CI GitHub (`.github/workflows/build.yml`) : elle construit les trois plateformes à chaque push. Avec un tag `v1.0.1`, elle crée en plus une release GitHub en brouillon avec tous les fichiers.

**Mises à jour automatiques** : pour publier une version, augmente `version` dans `package.json`, construis, puis envoie dans `https://ftp.paysdelavaliere.fr/Launcher/` :

- les installateurs ;
- les fichiers `.blockmap` ;
- les fichiers `latest.yml`, `latest-mac.yml` et `latest-linux.yml`.

Les launchers déjà installés se mettent à jour d'eux-mêmes.

**Signature** : sans certificat, le launcher fonctionne, avec quelques limites.

- **Windows** : SmartScreen affiche un avertissement au premier lancement (« Informations complémentaires » → « Exécuter quand même »).
- **macOS** :
  - il faut autoriser l'application une première fois dans *Réglages Système → Confidentialité et sécurité → Ouvrir quand même* ;
  - la mise à jour automatique est **désactivée** : macOS l'interdit aux apps non signées, le launcher affiche alors seulement « Nouvelle version disponible » ;
  - avec un compte Apple Developer, renseigne les secrets `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` et `APPLE_TEAM_ID` dans GitHub, puis passe `updates.macAppSigned` à `true` dans `launcher.config.json`.

> Le nom technique de l'application est `Pays de la Valiere`, sans accent. Electron sur macOS ne retrouve pas ses processus internes si le nom du bundle contient un « è ». Le nom affiché (Dock, raccourcis, fenêtre) reste « Pays de la Valière ».

## Crédits

- Le launcher installe [Minecraft Forge](https://minecraftforge.net). L'équipe Forge demande aux outils qui automatisent l'installation de soutenir le projet : [Patreon de LexManos](https://www.patreon.com/LexManos/).
- Police [Quicksand](https://fonts.google.com/specimen/Quicksand) (licence SIL OFL, voir `src/renderer/fonts/OFL.txt`).
- Icônes inspirées de [Lucide](https://lucide.dev) (licence ISC).
- [@xmcl/core](https://github.com/Voxelum/minecraft-launcher-core-node) pour la génération de la ligne de commande du jeu.
