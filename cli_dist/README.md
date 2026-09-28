# cli_dist — artefacts OpenCode servis sur le réseau local

Ce dossier est servi par l'app via `/api/cli/bundle/{os}` pour permettre aux
machines du **réseau local** d'installer/télécharger **OpenCode** *sans Internet*
(menu chat → « OpenCode »).

## Comment alimenter ce dossier

Dépose **un artefact par OS** ici, nommé `opencode-<os>.<ext>` :

| OS | Nom de fichier (exemples) |
|----|---------------------------|
| Linux   | `opencode-linux.tar.gz` |
| macOS   | `opencode-macos.tar.gz` |
| Windows | `opencode-windows.zip`  |

- `<os>` ∈ `linux` \| `macos` \| `windows`.
- L'extension est libre (`tar.gz`, `zip`, ou même un binaire brut) : l'installeur
  détecte le format à l'exécution. Un seul fichier `opencode-<os>.*` par OS.
- Le binaire à l'intérieur doit s'appeler `opencode` (ou `opencode*.exe` sous Windows).

Récupère les binaires depuis https://opencode.ai (releases) sur une machine
connectée, puis copie-les ici sur le serveur.

## Config llama.cpp — générée à chaud (plus de fichier statique périmé)

Les artefacts livrés (`opencode-linux.tar.gz`, `opencode-windows.zip`, **opencode
v1.18.16**) contiennent **le binaire + un `opencode.json` de secours** + un
`README-Elpis.txt`. Mais à l'installation la config est désormais **générée
dynamiquement par le serveur** (`GET /api/cli/opencode.json`) depuis l'état LIVE de
l'app : `baseURL` du llama.cpp courant (`config.json › llama`) + **liste des modèles
réelle** (cache `/v1/models`). opencode n'auto-découvrant PAS les modèles, c'est ce
qui évite une carte de modèles obsolète. Repli 100 % hors-ligne sur le `opencode.json`
embarqué si le serveur est injoignable (provider openai-compatible embarqué,
`autoupdate`/`share` off, aucune clé).

- **Installé via `install.sh` / `install.ps1`** : la config fraîche est écrite dans
  `~/.config/opencode/opencode.json` (**écrasement + sauvegarde `.bak`** de l'ancienne),
  et le binaire (`~/.local/bin` / `%LOCALAPPDATA%\opencode`) est **ajouté
  automatiquement au PATH** (rc du shell / PATH utilisateur Windows, idempotent).
- **Re-synchroniser la config seule** (après un changement de modèles côté serveur) :
  `curl -fsSL http://<LAN>/api/cli/opencode.json -o ~/.config/opencode/opencode.json`
  (chemin d'amorçage en clair — cf. « Certificat » plus bas ; plus de `-k`).
- **Outils Elpis dans opencode (bloc `mcp`, 2026-09-03)** : l'installeur, une fois
  le compte connecté, re-récupère la config AVEC le jeton elpis-remote
  (`x-elpis-token`) — le serveur y ajoute **une entrée MCP par famille d'outils**
  (`elpis-git`, `elpis-browser`, `elpis-desktop` → `…:8765/mcp/<famille>`, Bearer =
  le même jeton que le plugin `/remote`) si son service d'outils est partagé et
  authentifié (`LOCAL_MCP_URL` + `LOCAL_MCP_TOKEN`, cf. `./elpis start`).
  Une entrée = **une bascule** dans opencode (sa boîte « MCPs » n'a pas de
  granularité plus fine). Familles publiées : `LOCAL_MCP_OPENCODE_FAMILIES`
  (défaut `git,browser,desktop` — le reste, opencode le fait déjà) ; **fs/shell**
  restent refusées côté serveur (`LOCAL_MCP_OPENCODE_EXCLUDE_FAMILIES`).
  L'utilisateur choisit ses familles dans la modale OpenCode de l'app : ce choix
  est rendu en `"enabled": true|false` et **survit au re-sync**, contrairement à
  la bascule du TUI d'opencode (connect/disconnect, jamais écrite dans le fichier).
  Re-sync avec jeton :
  `curl -H "x-elpis-token: $TOKEN" https://<app>/api/cli/opencode.json -o ~/.config/opencode/opencode.json`.
- ⚠️ **`limit` doit porter `context` ET `output`.** Le schéma opencode les exige
  tous les deux : avec `context` seul, opencode REFUSE tout le fichier
  (« Missing key provider.elpis.models.\<id\>.limit.output ») et le provider
  `elpis` disparaît. Et `output` doit rester PETIT devant `context` : opencode
  compacte dès que `context − output` est atteint (`_output_limit()` dans
  `shared_infra/opencode/routes_cli.py` : un huitième, borné [2048, 16384]).
- **Téléchargé manuellement** : lancer opencode depuis le dossier extrait (il lit le
  `opencode.json` voisin = version de secours), ou copier le fichier généré ci-dessus.
- **Changer le modèle par défaut** : `config.json › opencode.default_model` (validé
  contre le roster live ; ou éditer `model` dans `opencode.json`).
- **Régénérer un paquet** : reprendre l'asset brut `opencode-<os>-x64.(tar.gz|zip)`
  d'opencode.ai puis y ajouter `opencode.json` (secours) + `README-Elpis.txt`.

## Plugin `elpis-remote` — sessions dans la page « Code »

L'installeur **propose** (choix `y/N`, surchargeable par
`ELPIS_INSTALL_PLUGIN=y|n` ; défaut `y` si un jeton est fourni) le plugin
**elpis-remote** — du **TypeScript natif** (opencode/Bun charge `*.{ts,js}`
sans build) : `~/.config/opencode/plugin/elpis-remote.ts`, servi par
`GET /api/code/plugin.ts` avec l'URL de l'app bakée (source :
`shared_infra/opencode/plugin/`). Refuser le plugin **retire** un éventuel
plugin déjà installé. `GET /api/code/plugin.js` ne sert plus qu'un shim de
migration pour les anciens `.js` (≤ v8) qui font `/remote update`.

La commande d'install copiée depuis le modal (session connectée) embarque
`ELPIS_REMOTE_TOKEN=<jeton du user>` en variable d'env dans le pipe (jamais dans
l'URL ni les access logs) ; le script écrit `~/.config/opencode/elpis-remote.json`
(`enabled` préservé au ré-install, CA locale épinglée ou repli `insecure` si
l'app est en https Caddy). Ensuite, dans opencode : **`/remote`** tout court
active la remontée — la session apparaît dans la page « Code », historique
compris, associée au bon utilisateur, et peut être **pilotée** depuis l'app
(prompts, interruption). `/remote` bascule on/off, `/remote status` affiche
l'état ; `/remote <jeton>` reste dispo (install manuelle / jeton régénéré).

## Endpoints (publics, gated par le flag admin `features.opencode`)

- `GET /api/cli/install.sh`  — script d'install bash (rendu avec l'URL LAN courante)
- `GET /api/cli/install.ps1` — script d'install PowerShell
- `GET /api/cli/bundle/{os}` — télécharge l'artefact de l'OS
- `GET /api/cli/opencode.json` — config générée à chaud (modèles + endpoint courants)

## Config

- Dossier configurable via env `OPENCODE_DIST_DIR` ou `config.json › opencode.dist_dir`
  (défaut : ce dossier `<repo>/cli_dist`).
- Activable/désactivable dans **Admin › Configuration › Système › Fonctionnalités › OpenCode**.

## Démarrage : pourquoi opencode mettait 30 s à 1 min 30

Dès qu'**un plugin** est présent, opencode lance un `npm install
@opencode-ai/plugin` dans **chaque dossier de config** et **bloque le chargement
des plugins** dessus (`config.ts › waitForDependencies`) — donc l'affichage. Mesuré
ici : **30 s** (1.17.7) et **71 s** (1.18.16) au premier lancement *avec* Internet ;
**jamais terminé** quand le réseau ne répond pas (pare-feu qui drop) — c'est-à-dire
le cas normal d'un déploiement LAN sans Internet.

opencode saute entièrement l'install si `node_modules` existe **et** que le lock
déclare la dépendance (`packages/core/src/npm.ts › install`). Les installeurs
posent donc trois artefacts, **sans rien télécharger** :

```
~/.config/opencode/node_modules/        (dossier vide)
~/.config/opencode/package.json         { "dependencies": { "@opencode-ai/plugin": "<version>" } }
~/.config/opencode/package-lock.json    packages[""].dependencies : la même
```

Démarrage mesuré réseau coupé : **8,6 s** au lieu de « jamais ». Un
`node_modules` déjà peuplé n'est **jamais** touché.

⚠️ Un projet qui possède son propre dossier `.opencode/` paie le même coût la
première fois (opencode installe aussi dedans) : y créer les mêmes trois
artefacts, ou lancer opencode une fois avec Internet.

## Certificat auto-signé (frontal HTTPS)

Modèle assumé sur un LAN sans Internet : **l'amorçage se fait en clair, puis la
CA de l'app est installée sur le poste**. Le certificat garde son rôle et il n'y
a de `-k` nulle part.

- **Deux sources** : `http://<hôte>/ca.crt` (Caddy `:80`) et
  `GET /api/cli/ca.crt` (servi par l'app — couvre les déploiements sans frontal
  `:80`, seul cas où l'installeur restait en `-k`). Le contenu est vérifié (vrai
  PEM) avant tout usage, et déposé dans `~/.config/opencode/elpis-ca.crt`.
- **Installation sur le poste par défaut** (`update-ca-certificates` /
  `update-ca-trust` / `Cert:\CurrentUser\Root`) → `curl`, `git` et le navigateur
  parlent à l'app en https vérifié. Opt-out : `ELPIS_TRUST_CA=n`. Sans droits
  administrateur, le script affiche la commande exacte à rejouer.
- **Épinglage conservé** (`elpis-remote.json › ca_file`, `--cacert`) : ⚠ Bun
  n'utilise **pas** le magasin de l'OS, le greffon a besoin du chemin explicite.

Le repli non vérifié ne subsiste que si aucune CA n'est joignable, et il est
annoncé explicitement.

> Les binaires ne sont **pas** versionnés (cf. `.gitignore`) : l'administrateur
> les dépose dans ce dossier avant d'activer la fonctionnalité.
