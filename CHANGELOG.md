# Journal des modifications

Les changements notables d'Elpis, du plus récent au plus ancien. Format inspiré
de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) ; numéros de version
selon [SemVer](https://semver.org/lang/fr/).

## Non publié

### Ajouts

- **Exécutions** (base, migration 0021) : une ligne par tour de chat, run de
  routine, sous-agent ou compaction manuelle — jetons (dont cache et
  réflexion), temps LLM (pré-remplissage, décodage, attente du moteur),
  appels d'outils par famille et erreurs, fichiers modifiés, pics CPU/RAM de
  la sandbox, statut ; les lignes d'usage et d'appels d'outils y sont
  rattachées. Compteurs fiabilisés : moteur sur chaque ligne d'usage, cache
  KV de llama.cpp, appels d'outils avec identifiant, début, code de sortie,
  tailles et statuts `timeout` / `blocked`. Export CSV avec la réflexion.
- **« Détails » d'une réponse** : chronologie de l'exécution qui l'a produite
  (tours du modèle, appels d'outils avec argument principal et extrait du
  résultat, sous-agents, compactions), export JSON aux secrets masqués ;
  réservé au compte propriétaire.
- **Supervision › Exécutions** (console) : coût en ressources par compte
  (jetons, temps du modèle, attente, outils, fichiers, pics de la sandbox),
  liste filtrable des exécutions ; chronologie de n'importe quel compte pour
  l'administrateur. Widgets « Attente d'un créneau LLM » et « Réutilisation
  du cache KV » dans Métriques.
- **Supervision d'un tour** : durée de chaque outil, budget d'itérations
  (« tour n/max »), sous-agent « En attente » avant son lancement, motif et
  seuil d'une compaction, pas « compression du contexte » restitué au
  rechargement, sorties d'outils retirées du contexte comptées. Le modèle
  reçoit aussi le contexte restant et les limites de la sandbox à ses points
  d'étape.
- **Outils externes conformes à la norme MCP** : les familles d'outils de la
  sandbox (`fs`, `shell`, `git`, `browser`, `desktop`, `skill_run`) se
  branchent sur tout client MCP par `<origine>/api/mcp-bridge[/<famille>]`
  (HTTP streamable, révisions 2024-11-05 à 2025-11-25, pagination,
  annotations, `outputSchema` / `structuredContent`, échec d'outil en
  `isError`, outil inconnu ou hors portée en erreur `-32602`).
  Authentification par jeton personnel ou **OAuth 2.1** : le client n'a
  besoin que de l'URL (découverte RFC 9728 / RFC 8414, enregistrement
  dynamique RFC 7591 — activé par défaut, `mcp.oauth.dcr_enabled` —,
  documents de client, PKCE S256, `resource` RFC 8707, rotation et révocation
  des jetons), écran de consentement Elpis par familles. Migration 0023.
- **Paramètres › Connexions** : jetons personnels nommés (opencode, outils),
  portée par familles et expiration, montrés une seule fois puis
  régénérables, avec les blocs de configuration à copier (MCP générique,
  VS Code, opencode, OpenAPI, curl) ; applications OAuth autorisées,
  révocables. Politique `mcp.tokens.*` et `mcp.oauth.*` dans Console ›
  Outils MCP ; accès par jeton d'un compte visibles et révocables depuis sa
  fiche (Console › Comptes).
- **Façade OpenAPI** : `GET /api/tools/<famille>/openapi.json` (OpenAPI 3.1
  générée depuis `tools/list`) et `POST /api/tools/<famille>/<outil>`, pour
  les clients qui ne parlent pas MCP ; même jeton, mêmes familles.
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
- **Intégration continue** (GitHub Actions) : lint (Ruff), typage (mypy),
  suite complète sur SQLite (Python 3.11 et 3.13), PostgreSQL 17 et
  MariaDB 11.4, tests front compris.
- **Exploitation** : `./elpis backup` (archive de la console, écrite dans
  `backups/`) et `./elpis upgrade` (sauvegarde, `git pull --ff-only`,
  dépendances, redémarrage, diagnostic) ;
  [docs/exploitation.md](docs/exploitation.md) (retour arrière, sauvegardes,
  supervision, compatibilité), [ROADMAP.md](ROADMAP.md), modèle de menace
  dans [SECURITY.md](SECURITY.md).

### Modifications

- **Agent de la sandbox** : un agent HTTP (bibliothèque standard) tourne dans
  chaque conteneur, démarré à la demande, pour que l'hôte n'accède plus
  lui-même au contenu de `/work`. Son code est monté en lecture seule et suit
  la version de l'application : aucune reconstruction d'image pour le faire
  évoluer. Nouveaux montages : les conteneurs existants sont recréés.
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
- **Contrats du harnais** : une seule source décide si un outil est sériel,
  rejouable, en lecture seule ou mutant (politique et annotations déclarées
  par le serveur, replis prudents sinon) ; le résumé de compression suit
  cette déclaration et ne compte plus les outils de lecture (Git, navigateur)
  parmi les modifications. Registre unique des événements du flux de chat,
  vérifié contre l'interface, la route et le journal d'exécution ; les
  événements que plus rien n'émet (`delta`, `tool_thinking`) sont retirés de
  l'interface.
- **Chat** : diffs relus dans l'historique ; carte « Fichiers modifiés »
  affichée quand l'éditeur est désactivé.
- **Ancien nom du projet** : compatibilité retirée (conteneurs, étiquettes,
  image, variables d'environnement, greffon opencode) ; les anciens conteneurs
  de sandbox d'avant le renommage sont à supprimer à la main.

### Sécurité

- **Frontière hôte ↔ sandbox** : toute opération sur `/work` (outils
  fichiers, éditeur, historique, aperçus, téléchargements, export et
  import, instantanés, sauvegardes) s'exécute dans le conteneur de
  l'utilisateur, par un agent lancé à la demande sous son UID ; l'hôte ne
  lit ni n'écrit plus `/work`.
- **Fin des droits élargis** : un seul UID, celui du conteneur, écrit dans
  `/work` — fichiers 0644, dossiers 0755 au lieu de 0666 / 0777. Les
  sandboxes existantes sont remises en ordre à leur prochain démarrage
  (`chown -R`, `chmod -R go-w` par le root du conteneur, une fois par
  compte).
- **Git dans la sandbox** : les commandes Git des outils et du panneau Git
  de l'éditeur tournent dans le conteneur de l'utilisateur, par son agent.
  Leurs opérations réseau passent par un relais authentifiant de l'hôte :
  un ticket par opération, seul le dépôt de l'opération joignable,
  identifiant du connecteur ajouté par l'hôte (jamais dans la sandbox),
  push limité aux branches demandées ; `https` et `http` seulement (`ssh`
  et `git://` retirés). Fonctionne avec un profil réseau isolé.
  `bubblewrap` (aperçus Office) devient un paquet de base —
  **installations existantes : `apt install bubblewrap`** (`./elpis
  doctor`) ; sur Ubuntu, l'installeur pose un profil AppArmor s'il est
  bloqué.
- **Conteneurs** : seules les capacités nécessaires (`--cap-drop ALL`, puis
  celles qu'exigent l'entrypoint, sudo et apt) : plus de `NET_RAW`,
  `SETFCAP`, `SYS_CHROOT` ni `MKNOD`. Image `elpis/sandbox:1.7.0` (`ping`
  sans capacité fichier), construite par `./install.sh`. Les conteneurs
  existants sont recréés à leur prochain usage (label `elpis.spec`, ou image
  changée) : ce qui y avait été installé hors de `/work` est perdu.
  **L'image 1.7.0 est obligatoire** : sans elle, les conteneurs existants ne
  sont pas recréés et fichiers, éditeur et Git des sandboxes sont
  indisponibles (message explicite) ; `./elpis upgrade` la charge depuis son
  archive ou la construit. Conteneurs lancés avec `--init` (processus
  orphelins récoltés). Le dossier `user_sandboxes/` est réservé au compte de
  service (0700) ; `./install.sh` ne change plus le propriétaire du contenu
  des sandboxes.
- **Politique Git d'un dépôt** : `.git-tool-policy.json` ne peut plus que
  renforcer les protections par défaut.
- **Navigateur piloté** : destinations limitées à `http` / `https` ; la
  boucle locale, le lien-local, les adresses de l'hôte et ses réseaux de
  conteneurs sont refusés, y compris après une redirection ou pour une
  sous-ressource (relais local qui juge l'adresse résolue) ; réseau local
  autorisé, restreint au besoin par `browser.url_allowlist`
  (docs/configuration.md). Sessions, états sauvegardés, téléchargements et
  références visuelles rangés par compte ; service relancé après une panne.
  **Mise à jour** : une automatisation qui visait `localhost`, l'adresse de
  l'hôte ou un conteneur local est désormais refusée.
- **Jetons en empreinte** (migration 0022) : les jetons `pcr_` (opencode),
  `ept_` (outils) et `evt_` (vision d'une automatisation, limité à la
  localisation à l'écran) ne sont plus gardés qu'en empreinte SHA-256 et ne
  se réaffichent plus ; `GET /api/code/config` ne rend plus de jeton.
  Les postes opencode déjà appairés restent valides. Révoquer les sessions
  d'un compte, réinitialiser ou changer son mot de passe révoque aussi ses
  jetons et ses applications OAuth. **Retour arrière** : l'ancienne version
  ne retrouve pas les jetons convertis (ré-appairer opencode).
- **Relais MCP** : il ne retransmet plus le jeton du client au service
  d'outils (jeton de délégation signé), contrôle l'en-tête `Origin` et
  refuse une `MCP-Protocol-Version` inconnue.

### Corrections et sécurité

- **Image de sandbox** : la console n'inscrit plus l'image livrée dans
  `config.json`. Une instance dont l'onglet Sandbox avait été enregistré
  restait figée sur l'image de l'époque ; seule une image tierce y est
  désormais conservée.
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
- **Base de données** : sur PostgreSQL et MariaDB/MySQL, les migrations du
  schéma de référence ne sont plus rejouées au démarrage d'une base non vierge
  (elles échouaient à chaque démarrage) ; « Enregistrer » de la page Base ne
  modifie plus la base active (cible rangée à part jusqu'à la bascule) ; la
  vérification d'un transfert ne dépend plus de la collation du serveur.
- **Métriques llama.cpp** : les noms publiés (`llamacpp:…`) sont reconnus ;
  avant un chargement ou un déchargement de modèle, l'attente des créneaux au
  repos voit de nouveau les requêtes en cours quand `/health` ne répond pas.
- **Chat** : le pied d'un message (modèle, durée, débits) reste affiché après
  les tours suivants ; il disparaissait au tour suivant.
- **Git** : l'ancien fichier d'identifiants importé
  (`.git-credentials.json.imported`) est supprimé de la sandbox.
- **Audit** : les révocations de sessions (toutes, ou d'un compte) sont
  inscrites au journal d'audit.
- **Journal d'exécution** : le plafond `llm.run_journal_max_mb` est appliqué
  (il était ignoré, 64 Mo toujours).
- **Prompts système** : deux enregistrements simultanés d'une même catégorie
  aboutissent tous deux.
- **Sauvegardes** : l'archive complète inclut le magasin des skills
  personnels (absent jusqu'ici, donc perdu à la restauration) ; journaux et
  fichiers PID ne sont plus ni sauvegardés ni restaurés ; une sauvegarde
  sans la base n'est plus comptée comme récente.

## 1.0.0 — 2026-09-24

Première publication : chat agentique (outils, sous-agents, mémoire long
terme, skills, serveurs MCP), éditeur de code avec sandbox Docker par
utilisateur et terminal, routines, service RAG, console d'administration ;
installation et configuration interactives en deux commandes.
