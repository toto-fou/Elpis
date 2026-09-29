# Journal des modifications

Les changements notables d'Elpis, du plus récent au plus ancien. Format inspiré
de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) ; numéros de version
selon [SemVer](https://semver.org/lang/fr/).

## Non publié

### Ajouts

- **Base de données multi-moteurs** : PostgreSQL et MariaDB/MySQL en plus de
  SQLite ; pool de connexions unique, SQL portable et schéma de référence ;
  adaptateurs serveur et suite de tests sur quatre moteurs ; transfert entre
  moteurs, commandes `./elpis db info | check | transfer | use` et page « Base
  de données » de la console ; choix de la base à l'installation.
- **Installeur par pages** : `./install.sh` pose toutes ses questions dans un
  assistant en terminal, vérifie les droits d'emblée, prépare et teste la base
  avant de continuer.
- **Console d'administration refondue** : six entrées par fonction et
  page d'arrivée « Vue d'ensemble » (ce qui demande l'attention, état des
  services, dernières 24 h) ; enregistrement par écran, champ par champ
  (`PATCH /api/admin/config`, conflits signalés), garde de sortie et Ctrl+S ;
  bandeau « Redémarrage nécessaire » ; recherche Ctrl+K ; la console suit les
  thèmes et le mode sombre (mode « Système »).
- **Skins plugins** : page Console › Système › Apparence pour activer ou
  désactiver chaque skin, choisir le skin par défaut, créer un skin depuis un
  modèle (couleurs claires et sombres, aperçu en direct), importer ou exporter
  un zip. Les skins importés vivent hors du code (`user_skins/`, inclus dans
  les sauvegardes complètes). Registres uniques `skins.json` et
  `mascottes.json`. Le skin Kiki est désactivé par défaut.
- **Écoute réseau explicite** (`security.listen`) : l'installeur demande
  « ce serveur seulement » ou « réseau local » ; une installation neuve
  écoute en local par défaut.

### Modifications

- **Licence MIT** : Elpis passe de la licence Apache-2.0 à la licence MIT
  (`LICENSE`, `NOTICE`, en-têtes SPDX, `pyproject.toml`). Les textes de licence
  des composants vendorisés sont reproduits dans `LICENSES/`.
- **Documentation recentrée sur le harnais** : le guide utilisateur, la doc
  développeur et le panneau Sampling n'expliquent plus le fonctionnement
  général d'un LLM ; ils décrivent ce que fait l'application autour du modèle.
  Guide, doc développeur et configuration alignés sur le code actuel.
- **Harnais LLM** : flux et transport, boucle d'outils, gestion du contexte,
  pool MCP et sous-agents, route de chat et bouton « Continuer » ; audit en
  quatre passes : requêtes Anthropic/OpenAI, identifiants d'appel, relances et
  raisonnement, robustesse et code mort, écritures sans suivre de lien et cache
  KV stable, comptage de contexte et télémétrie, client RAG.
- **Moteur d'événements** : bus fichier sans perte, flux revalidés,
  contre-pression du terminal.
- **Chat** : diffs relus dans l'historique ; carte « Fichiers modifiés »
  affichée quand l'éditeur est désactivé.
- **Ancien nom du projet** : compatibilité retirée (conteneurs, étiquettes,
  image, variables d'environnement, greffon opencode) ; les anciens conteneurs
  de sandbox d'avant le renommage sont à supprimer à la main.

### Corrections et sécurité

- **Installeur** : root via `su` sans tiret (runuser introuvable, faux
  « python3-venv ? »), client Docker sur Debian 13, mot de passe admin généré
  jamais écrit dans le journal.
- **Agent desktop** : plus aucune dépendance GPL (pyautogui sans ses
  dépendances optionnelles GPL, python-xlib LGPL).
- **Console admin** : skin et mode sombre lus et enregistrés depuis le
  processus admin (plus de 404) ; sauvegarde et restauration affichent
  « Compression en cours… » / « Restauration en cours… » avec une roue et le
  temps écoulé au lieu d'un « 0 o » figé.
- **Socle** : droits de la base, `APP_MODE`, sauvegarde et restauration sûres,
  documentation de sécurité.
- **RAG** : requêtes fiables sur collections hybrides, import borné, file OCR
  robuste ; passe de robustesse complète — cœur, recherche, OCR, console.
- **Sandbox** : archives sur disque et bornées, cycle de vie fiable, copie sans
  lien.
- **Métriques llama.cpp** : les noms publiés (`llamacpp:…`) sont reconnus ;
  avant un chargement ou un déchargement de modèle, l'attente des créneaux au
  repos voit de nouveau les requêtes en cours quand `/health` ne répond pas.

## 1.0.0 — 2026-09-24

Première publication : chat agentique (outils, sous-agents, mémoire long
terme, skills, serveurs MCP), éditeur de code avec sandbox Docker par
utilisateur et terminal, routines, service RAG, console d'administration ;
installation et configuration interactives en deux commandes.
