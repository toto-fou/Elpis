# Journal des modifications

Les changements notables d'Elpis, du plus récent au plus ancien. Format inspiré
de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) ; numéros de version
selon [SemVer](https://semver.org/lang/fr/).

## 0.1.0 — 2026-10-18

**Le core d'Elpis est réécrit en TypeScript.** L'application (main), la
console d'administration et l'hôte d'outils tournent sur Node.js 24, avec la
même API, la même base et les mêmes fichiers de configuration que la 0.0.1.
L'interface est en TypeScript et en composants Vue précompilés, sans
compilateur Vue au chargement, sous une politique de sécurité du contenu
(CSP). Restent en Python : le service RAG, elpis-tools (documents Word et
PowerPoint), l'agent des sandboxes, l'agent de bureau Windows et l'assistant
d'installation (`./elpis configure`). Les écarts de comportement voulus avec
la version Python sont listés dans docs/ecarts-python.md.

### Pour l'exploitant

- **Node.js 24 installé par Elpis.** `install.sh` place le runtime officiel
  Node.js 24.21 dans `node/` (somme SHA-256 figée dans
  `deploy/node/node.env`, sans npm) et construit les bundles du core
  (`apps/core/dist`), de l'hôte d'outils (`apps/toolhost/dist`) et du
  frontend. Sans paquet hors ligne, la construction demande `build-essential`
  et `python3` (groupe apt `construction-hote`). Le paquet hors ligne de
  `make_release.sh` contient le runtime et les bundles construits pour son
  architecture.
- **Mise à jour depuis la 0.0.1** : `./elpis upgrade`, puis
  `deploy/node/installer.sh node` et `deploy/node/installer.sh core` (ou
  `./install.sh`, idempotent), `sudo ./elpis service install` et
  `./elpis doctor` ; hors ligne, `./install.sh --offline <paquet>`. Détail :
  docs/exploitation.md, « Mettre à jour ».
- **Une connexion à refaire.** Le cookie de session change de format : celui
  de la 0.0.1 est ignoré sans erreur (page de connexion), une connexion
  suffit ; de même au retour vers la version Python. Jetons d'API et
  d'opencode et accès OAuth restent valides.
- **Services** : `tools` (elpis-tools, `127.0.0.1:8767`) rejoint `qdrant`,
  `rag`, `toolhost`, `main`, `admin` et `browser` ; plus de gunicorn.
  Après la mise à jour, `sudo ./elpis service install` réécrit les unités.
- **Fournisseurs cloud fermés par défaut aux comptes non administrateurs.**
  Sans `llm.allowed_provider_types`, ces comptes ne branchent plus de
  fournisseur cloud avec leur propre clé, et leurs connecteurs cloud
  personnels cessent de servir. Les connecteurs partagés et ceux des
  administrateurs ne changent pas. Pour garder l'ancien comportement :
  Console › Modèles › Accès utilisateurs › Fournisseurs autorisés.
- **Retour à la version Python** : tag `python-final`, procédure dans
  docs/exploitation.md, « Revenir à la version Python (tag `python-final`) ».

### Changements

- **Le core Python est retiré.** main et admin ne tournent plus que sur le
  core TypeScript (`apps/core/dist/main.mjs`) : `server/app.py`,
  `admin_app.py`, les confs Gunicorn, `chatbot_app/` et le moteur Python
  (boucle, contexte, ordonnancement, routes) sont supprimés, `gunicorn` quitte
  `requirements.txt`. L'ancien hôte d'outils Python (`python -m toolhost`) et
  les routes Python de la sandbox, du terminal et du bureau partent aussi ;
  `ELPIS_TOOLHOST=python` et `ELPIS_CLI=python` dans `.env` sont ignorés
  (`./elpis doctor` le signale).
- **Familles d'outils natives par défaut** : sans clé `familles_natives`
  dans `toolhost.json` (ou sans ce fichier), l'hôte d'outils Node.js sert
  lui-même toutes les familles portées en TypeScript (browser, desktop, fs,
  git, shell, skill_run) ; elpis-tools ne garde que les autres (office). Une
  liste explicite, même vide, est respectée : une famille portée qui n'y
  figure pas est relayée à elpis-tools. `./elpis doctor` affiche les
  familles natives effectives.
- **Commandes d'exploitation par le core Node.js.** `./elpis backup`,
  `./elpis db`, `./elpis browser`, la sauvegarde de `./elpis upgrade` et les
  contrôles de `./elpis doctor` (base joignable, verrous de fichiers,
  bubblewrap, serveur LLM, états du navigateur) passent par
  `apps/core/dist/exploitation.mjs` ; options, sorties et codes de sortie
  inchangés. La sauvegarde de la console et l'envoi distant planifié lisent
  le `/work` des comptes par l'agent de leur sandbox. Détail :
  docs/exploitation.md.
- **L'hôte d'outils est le bundle Node.js (`apps/toolhost`).** `./elpis`,
  les unités systemd et le déploiement distant (`deploy/toolhost/`) lancent
  `apps/toolhost/dist/main.mjs` au lieu de `python -m toolhost`. Les familles
  d'outils encore en Python lui sont servies par elpis-tools (service
  `tools`, `127.0.0.1:8767`). Construction : node-pty est compilé par
  `npm ci` (build-essential, python3), le paquet hors ligne contient le bundle
  de l'hôte pour son architecture. **Mise à jour** : après
  `./elpis upgrade`, `sudo ./elpis service install` (unités `elpis-tools` et
  hôte Node.js) ; hôte distant : relancer `install_toolhost.sh` (deux unités).
- **Les outils liés au compte (mémoire, tâches, skills, graphiques) sont
  servis par main lui-même** : l'hôte d'outils ne les sert plus, et
  `/api/mcp-bridge/<famille>` les sert directement. `mcp.example.json` les
  déclare en entrées `inprocess`. Les familles relayées ne sont plus servies
  en SSE (`mcp_upstream_sse` non lancé) : l'export SSE de la console les
  signale omises. Détail : docs/exploitation.md.
- **Connecteurs LLM : fournisseurs cloud fermés par défaut aux comptes non
  administrateurs** (`llm.allowed_provider_types` absente ou vide = aucun ;
  la 0.0.1 les ouvrait tous). Les administrateurs ne sont pas soumis à la
  liste, les types locaux restent réservés aux connecteurs partagés.
  Réglages › Modèles IA ne propose que les types ouverts et marque « fermé
  par l'administrateur » un connecteur existant d'un type fermé. Détail :
  docs/configuration.md, « Fournisseurs cloud des comptes ».
- **Identifiants git posés par l'agent** (famille `git` native de l'hôte
  d'outils) : `git_set_credential` et `git_clone` avec identifiant
  n'enregistrent un connecteur que pour un hôte (port compris) déjà présent
  dans les Connecteurs Git du compte ou d'un administrateur ; sinon l'agent
  reçoit `host_not_registered` et demande d'ajouter le connecteur dans
  Réglages → Connecteurs Git. Ils ne mettent à jour que les connecteurs créés
  automatiquement (`auto`), jamais un connecteur saisi dans Réglages ou importé
  (`connector_exists`). Un ancien `.git-credentials.json` du bac suit la
  même règle (le fichier est gardé si un hôte est refusé). Le clone de
  l'éditeur n'est pas concerné.

### Ajouts

- **Documents Word et PowerPoint de la sandbox : sept outils.** Famille
  `office` : `docx_create`, `docx_read`, `docx_edit`, `pptx_create`,
  `pptx_read`, `pptx_edit`, `office_export` (PDF).
  - Les fichiers sont lus et écrits dans `/work`, par l'agent de la sandbox,
    avec l'écriture gardée de `write_file` (historique, verrou de l'éditeur) ;
    ils apparaissent dans la carte des fichiers modifiés et s'ouvrent dans
    l'éditeur avec l'aperçu Office. Chemin cadré : extension imposée et
    corrigée, nom nettoyé, un fichier existant est remplacé (version
    précédente dans l'historique).
  - Word : contenu en Markdown, plus `!id` (graphique), encadrés
    `> [!NOTE]`, `[TOC]`, `\newpage` ; page de garde, sommaire, en-tête,
    pied, numéros de page, filigrane, modèle .dotx de la sandbox.
    PowerPoint : 14 mises en page composées (titre, chiffres clés,
    graphique, chronologie, processus, comparaison…), thèmes, modèle .potx.
  - Modifications par lot en un appel (remplacer, remplir des `{{champs}}`,
    réécrire, insérer après un titre, cellules et lignes de tableau,
    diapos ajoutées, déplacées, dupliquées, notes) ; les numéros se réfèrent
    au fichier tel qu'il était avant l'appel.
  - Graphiques mutualisés avec les outils `chart_*` : natifs et éditables
    quand Word et PowerPoint ont l'équivalent, sinon image ECharts rendue
    côté serveur (Node + LibreOffice isolé).
  - Lecture tolérante (synonymes français, casse), corrections renvoyées au
    modèle, refus guidés et garde-fou anti-boucle, comme les graphiques.
  - Moteurs repris des serveurs MCP docx-mcp et pptx-mcp (MIT), sans état,
    sans réseau, sans Jinja ni matplotlib. Nouvelles dépendances :
    python-pptx (MIT), XlsxWriter (BSD-2-Clause).
  - Installation existante : `./elpis configure`, `./elpis start` et
    `./elpis upgrade` ajoutent à `mcp.json` toute famille de
    `mcp.example.json` qui y manque (`elpis-office` ici), sur le modèle de
    ses entrées d'hôte d'outils (même hôte, même port, mêmes en-têtes) ; une
    famille éteinte, renommée ou exclue reste telle quelle, et
    `./elpis doctor` signale une famille absente.
- **Graphiques : un outil par type, rendu Apache ECharts.** Les quatre outils
  Chart.js et `generate_table` sont remplacés par 30 outils `chart_<type>`
  (barres, courbes, aires, flux, radar, cascade, secteurs, anneau, rose,
  treemap, sunburst, entonnoir, histogramme, boîtes à moustaches, nuage,
  bulles, carte de chaleur, calendrier, coordonnées parallèles, sankey,
  cordes, réseau, arbre, Gantt, chandeliers, jauge, progression, indicateurs,
  tableau).
  - Le modèle donne un tableau de lignes ; les colonnes sont reconnues et le
    serveur construit séries, matrices, nœuds, quartiles et classes. Les
    valeurs finies sont des `enum` (imposés par la grammaire de llama.cpp) ;
    la lecture reste tolérante (casse, synonymes, « 1 234,5 € », CSV,
    colonnes mal nommées) et chaque correction est renvoyée au modèle.
  - Un appel identique à un appel déjà refusé dans la conversation reçoit un
    refus explicite (« ne le renvoie pas tel quel »).
  - Cartes : zoom des longues séries, tableau des données, PNG, agrandir,
    bascule barres / courbe / aire, thème sombre ; ECharts (1,1 Mo) est chargé
    au premier graphique.
  - Banc ornith-1.5-9B (14 demandes × 2) : 28/28 graphiques justes au premier
    appel, contre 16/28 avec les outils précédents.

### Autres changements

- **Base de données : MariaDB/MySQL n'est plus pris en charge** ; SQLite et
  PostgreSQL restent. Le pilote PyMySQL, le choix `--db mariadb-local`
  d'`install.sh` et l'option MariaDB/MySQL de l'assistant, de
  `./elpis configure` et de la console sont retirés. Une instance encore sur
  ce moteur refuse de démarrer, au lieu de repartir sur un fichier SQLite
  vide. **Mise à jour** : en sortir avant, avec la version en place
  (Console › Base de données › « Revenir à SQLite », ou « Migrer et
  basculer » vers PostgreSQL). Détail : docs/exploitation.md, « Mettre à
  jour ».
- **Pièces jointes : les captures réseau (`.pcap`, `.pcapng`, `.cap`) ne sont
  plus analysées.** La route `POST /api/tools/parse-file` et la dépendance
  `dpkt` sont retirées ; une capture déposée dans le chat est refusée avec un
  message.
- **Hôte d'outils : service requis, relais partout.** L'application joint
  toujours l'hôte d'outils en réseau et ne lance plus
  de sous-process stdio du serveur d'outils ; hôte arrêté = outils
  indisponibles (`./elpis doctor` le signale). `relay: true` est posé par
  défaut dans `mcp.json › sandboxHosts` : main relaie vers l'hôte la sandbox,
  le terminal, les captures et les trames, même sur la même machine.
  **Mise à jour** : `./elpis configure` ajoute le relais à un `mcp.json`
  existant. Détail : docs/exploitation.md, « Mettre à jour ».
- **Verrous de fichiers partagés entre processus : nouveau format.** Mémoire
  (`MEMORY.md.lock`, `USER.md.lock`, `.journal.jsonl.lock`), skills
  (`.skills_write.lock`), historique des fichiers, cycle de vie et migration
  `/work` des sandboxes, pose du schéma de la base et nettoyage au démarrage,
  création du secret de session et de la clé de chiffrement : le `flock`
  laisse la place à un fichier créé en exclusif qui porte le PID, la
  machine et l'heure de prise (protocole `elpis.verrou.v1.1`, commun au core
  TypeScript et au Python restant). Le fichier n'existe que pendant la prise ; les anciens
  fichiers vides sont repris à la première écriture ; le verrou d'un
  processus tué est repris aussitôt sur la même machine (ou après un
  redémarrage), sinon après sa péremption (2 min ; les opérations longues,
  comme le cycle de vie des sandboxes ou la pose du schéma, la prolongent
  tant qu'elles travaillent). Une attente de plus de 30 s est journalisée
  avec le détenteur du verrou. Les dossiers de données doivent être sur un
  disque local : `./elpis doctor` signale un NFS ou un CIFS.
  **Mise à jour** : redémarrer ensemble les services d'une même machine
  (`./elpis upgrade` le fait).
- Les graphiques enregistrés avant cette version (configurations Chart.js) ne
  sont plus tracés : la carte invite à les redemander. Chart.js reste utilisé
  par le tableau de bord de la console.
- **Navigateur : états sauvegardés d'avant la 0.0.1 (rupture non signalée
  dans ses notes).** La 0.0.1 range les états de
  `pw_session(action='save_state')` (cookies, stockage local) par compte,
  sous `browser-service/cookies/state_<propriétaire>__<id>.json`. Ses notes
  ne disent pas que les états existants, `state_<id>.json`, ne se rechargent
  plus, ni qu'un état est supprimé 30 jours après son enregistrement, même
  s'il sert (`PW_STATE_MAX_AGE_D`, `0` = jamais). Cette purge a pu effacer
  les plus anciens, et la sauvegarde d'Elpis n'emporte pas ce dossier. Le
  service ne rattache jamais de lui-même un état sans compte : n'importe quel
  compte qui connaîtrait son identifiant obtiendrait la session connectée
  d'un autre.
  **Mise à jour** : `./elpis browser states` liste les états sans compte
  restants (identifiant, date, sites) ; `./elpis browser migrate-states
  COMPTE ID…` rattache ceux d'un compte Elpis (`--all` : tous, s'ils sont
  tous à lui) ; le même `load_state_id` les recharge ensuite pendant 30
  jours. Détail : docs/exploitation.md, « Mettre à jour ».

### Corrections

- **Réinstallation d'un hôte d'outils distant** : `install_toolhost.sh`
  relancé depuis une autre copie du dépôt effaçait `toolhost.json`,
  `Caddyfile.toolhost` et le runtime `node/` de la machine (copie en
  `rsync --delete`). Ils sont maintenant gardés.
- **Historique des fichiers avec un hôte d'outils distant** : la connexion
  ouvre la nouvelle session d'historique sur l'hôte, là où l'éditeur et
  l'assistant notent leurs écritures. Elle était ouverte sur la machine de
  l'application : la session du compte sur l'hôte n'était jamais renouvelée.
  **Mise à jour** : mettre aussi à jour l'hôte d'outils distant ; un hôte
  plus ancien répond 404 (avertissement au journal à chaque connexion,
  session non renouvelée).
- **Relais vers l'hôte d'outils** : l'URL amont est construite depuis le
  chemin brut de la requête ; les segments `..` et les séparateurs encodés
  sont refusés. Les aperçus (`/api/sandbox/pv/…`, `/pvs/…`) relayés portent
  l'identité de leur jeton ; le code de fermeture d'un terminal (session
  expirée, session inconnue) arrive au navigateur.
- **Profil réseau imposé avec un hôte d'outils distant** : l'application
  transmet à l'hôte, dans l'enveloppe d'identité, le profil imposé par
  l'administrateur. Le panneau du bac à sable l'affiche et verrouille le
  sélecteur, et l'hôte refuse tout autre profil, même quand il a sa propre
  base. **Mise à jour** : mettre aussi à jour l'hôte d'outils distant ; un
  hôte plus ancien ignore l'imposition transmise et garde sa base.
- **Ordonnanceur LLM : priorités et routines.**
  - Sur un même modèle, un chat passe avant une routine qui attend un
    créneau. Une routine qui attend depuis plus de 30 s reprend son rang
    d'arrivée.
  - Une routine retenue par la grâce d'un chat (8 s après chaque message)
    passe au plus 30 s après son premier blocage, même sous un flux continu
    de messages. Elle ne subit plus une seconde grâce une fois passée.
  - Un réglage de connecteur modifié à chaud (`max_concurrency`,
    `max_models`) sert les demandes déjà en attente, dans l'ordre de la file
    (chats d'abord).
- **Complétion de l'éditeur (`/api/llm/infill`)** : elle passe par
  l'ordonnanceur complet et ne fait plus changer de modèle sous un chat ou
  une routine.
  - Au-delà de 20 s d'attente, elle répond « Modèle occupé par une autre
    génération — réessayez plus tard. ».
  - Serveur jugé hors service (disjoncteur ouvert) : réponse `ok: false`
    avec l'explication, au lieu d'une erreur 500. Ses échecs de connexion
    comptent pour le disjoncteur.
- **Studio** : quitter le Studio sans action en cours n'affiche plus « Arrêt
  demandé — l'action en cours sur la VM se termine » ; le message reste
  quand une action était réellement en cours.
- **Navigateur** : `pw_session(action='start')` avec le `load_state_id` d'un
  état introuvable ou sans compte rend l'explication du service (comment le
  rattacher, durée de conservation) au lieu de « Session not found », même
  quand le compte a déjà une session ouverte ; un état demandé sur une
  session réutilisée est signalé comme non chargé (`state_loaded: false`).
  Une référence d'élément périmée ou une option de liste introuvable ne sont
  plus présentées comme une session introuvable. Les états sans compte ne
  sont plus purgés ; le service les signale à son démarrage et
  `./elpis doctor` les compte.

## 0.0.1 — 2026-10-04

Première version publiée : chat agentique (outils, sous-agents, mémoire long
terme, skills, serveurs MCP), éditeur de code avec sandbox Docker par
utilisateur et terminal, routines, service RAG, console d'administration ;
installation et configuration interactives en deux commandes.

### Ajouts

- **Tokens par type, partout, au sens des fournisseurs (OpenAI, Anthropic)** :
  l'entrée contient le cache (relu) et la part des outils (définitions, appels
  et résultats re-soumis, estimée), la sortie contient la réflexion.
  - Réglages › Utilisation : une barre par type — Entrée, Cache, Outils,
    Sortie, Réflexion — et une barre par origine.
  - Chat : « cache N % » sur la ligne du message ; infobulle « Entrée … · cache
    … · utile … · outils ≈ … » / « Sortie … · réflexion … · réponse … ».
    Pendant la lecture du prompt, « Prefill… N % · cache M % »
    remplace « Réflexion… N % », sur l'entrée utile, aussi sans outils et sur
    « Continuer ». « Continuer » additionne les segments.
  - Détails d'une réponse : tuiles Entrée et Sortie, prefill + génération.
  - Console : détail de « Tokens consommés », « Cache de prompt » affiché par
    défaut, frise « Entrée — cache vs utile », barres par modèle et par
    utilisateur, colonnes Entrée / Sortie et prefill + génération dans
    Exécutions, cache dans le rapport quotidien.
  - Entrée Anthropic ramenée au sens commun (cache compris, migration 0025
    pour l'historique) ; part des outils enregistrée par tour et par
    exécution (migration 0026) ; un seul format de nombres (« 12,3 k »).

- **Génération d'images** (migration 0024) : un moteur réglé dans la console
  (Modèles & services › Images) — `sd-server` de stable-diffusion.cpp (file,
  annulation) ou service compatible OpenAI —, ouvert à tous ou à des groupes.
  Mode Images du composeur (menu +, Alt+I, `/image`) : format, taille, nombre,
  description enrichie, graine, édition d'une image ; une case par image avec
  file et temps écoulé, Stop ; carte de résultat (modèle, durée, graine,
  Variantes, Copier), visionneuse, suppression annulable, galerie
  personnelle ; préférences par compte côté serveur ; outil `generate_image`
  du modèle (plafond par tour, refusé en mode plan) ; tours d'images dans
  Supervision › Exécutions. Clé API chiffrée, TLS sur le magasin du système
  plus une autorité collée, générations simultanées limitées sur tous les
  workers, rétention par compte, images supprimées avec leur conversation ou
  leur compte.

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

- **Créneaux du moteur LLM communs à tous les process** : un créneau du
  llama-server (`-np`) est désormais un fichier verrouillé partagé par les
  workers et la console (`ELPIS_LLM_SLOTS_DIR`). Avant, chaque worker gardait
  sa part (`créneaux ÷ workers`, au moins 1) : sept workers lançaient sept
  générations sur quatre créneaux, trois workers en laissaient un inutilisé.
  Un chat passe toujours avant une tâche de fond, y compris d'un worker à
  l'autre.
- **Workers Gunicorn** : par défaut `min(4, cœurs − 1)` au-delà de 2 cœurs
  (`APP_WORKERS` l'impose toujours) ; une machine de 32 cœurs lançait 31
  workers.
- **Service d'outils** : appels simultanés plafonnés au total
  (`MCP_TOOL_MAX_CONCURRENT`, 48) et par compte
  (`MCP_TOOL_MAX_CONCURRENT_PER_USER`, 12), attente bornée
  (`MCP_TOOL_QUEUE_WAIT_S`, 30 s) puis erreur lisible par le modèle ; pool de
  threads réglable (`MCP_TOOL_THREADS`, 64 au lieu de 40). Des commandes
  longues d'un seul compte ne figent plus le service pour les autres.
- **Installation** : `install.sh` et son assistant ne proposent plus
  d'installer le moteur vocal (whisper.cpp + Piper) sur la machine d'Elpis ;
  il se déploie à part avec `deploy/voice/`, et la page « Voix » de
  l'assistant demande les adresses des deux services. `--with-voice` et
  `--no-voice` sont ignorées avec un avertissement.
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
- **Découpage du cœur** : la boucle agentique et le flux de chat sont rangés en
  modules, sans changement de comportement. L'orchestrateur de la boucle
  (`llm_core/_chat_with_tools.py`) garde les compteurs et l'aiguillage de
  chaque tour ; le tour LLM, l'exécution des appels d'outils (un seul noyau
  pour les appels natifs et les appels écrits en texte), les reprises et les
  sorties du run vivent dans `llm_core/engine/`. La route du flux de chat
  n'enchaîne plus que des étapes : préparation, exécution, enregistrement et
  historique du tour sont dans `chatbot_app/turn/`, l'annulation et la
  compression manuelle dans leurs propres modules de routes.
- **Tests** : la suite s'isole de l'instance (configuration absente, moteur
  LLM injoignable, données de l'instance et journaux dans un dossier
  temporaire : elle n'écrit plus dans `user_db/` ni `user_sandboxes/`) et
  donne le même résultat dans la copie de travail, un
  worktree et la CI : un `config.json` local ne provoque plus de faux échec.
  Goldens complets de la boucle et du flux de chat, scénario par scénario ;
  gardes contre un patch sans effet, un import fait à l'appel qui vise un nom
  disparu, une erreur de code avalée par `swallow` et le retour de traces
  d'audit dans les commentaires. Le test de l'installeur lit la sortie du
  pseudo-terminal jusqu'au bout.
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

- **Bascule de base interrompue** (process de la console tué pendant la
  copie) : les écritures ne répondent plus 503 indéfiniment, la tâche
  apparaît « interrompue » et « Migrer » peut être relancé tout de suite.
  Une copie ou une vérification en échec vide la base cible, qui était
  vierge au départ : la nouvelle tentative n'est plus refusée (« cible non
  vide »). Pendant une bascule, une configuration illisible bloque les
  écritures au lieu de les laisser passer.
- **Installation vers PostgreSQL / MariaDB** : si la copie des données
  SQLite échoue, Elpis reste sur SQLite (données intactes) et la nouvelle
  base est gardée en attente dans la console › Base de données ; avant, le
  schéma y était créé quand même et la copie ne pouvait plus être relancée.
- **Console › Métriques** : l'export Prometheus et l'export CSV rendent
  leur connexion à la base même en cas d'erreur (sur PostgreSQL / MariaDB,
  chaque fuite retirait une connexion au pool jusqu'au redémarrage).
- **Changement de modèle avec un llama-server routeur** (une instance à la
  fois) : choisir un autre modèle dans un chat rechargeait l'ancien, avec
  des erreurs 500 côté llama. Trois causes, corrigées :
  - la sélection revenait d'elle-même sur le modèle chargé au
    rafraîchissement de la liste ; elle est désormais gardée jusqu'à l'envoi,
    et un modèle dont le chargement a échoué est signalé dans le sélecteur ;
  - la sonde des capacités interrogeait le modèle par défaut de la
    configuration, et le chargeait ; elle n'interroge plus que le modèle
    chargé, sans jamais en charger un ;
  - le panneau Sampling et les propriétés d'un modèle lisaient `/props` en
    chargeant le modèle ; ces lectures passent `autoload=false`, et un
    modèle non lu ne laisse plus de capacités fausses en cache.
  `/metrics` et `/slots` nomment le modèle chargé (fin des 400 « model name
  is missing ») ; la jauge KV demande des modèles lancés avec `--metrics`.
- **Cycles d'import** : importer en premier
  `shared_infra/opencode/routes_cli.py`,
  `shared_infra/observability/routes_events.py` ou
  `shared_infra/desktop/routes.py` échouait (« partially initialized
  module ») : des imports de niveau module refermaient un cycle avec le
  paquet des routes. Ils sont faits à l'appel, dans
  `shared_infra/desktop/routes.py` et `shared_infra/opencode/routes_code.py`.
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
- **Outils** : une réponse qui n'est qu'un appel écrit en texte vers un outil
  inexistant relance le modèle (deux fois au plus, en lui nommant l'outil) au
  lieu de finir sur une réponse vide.
- **Compaction** (chat sans outils, réflexion active) : la porte réserve le
  même plafond de génération que le budget de contexte.
- **Git** : l'ancien fichier d'identifiants importé
  (`.git-credentials.json.imported`) est supprimé de la sandbox.
- **Audit** : les révocations de sessions (toutes, ou d'un compte) sont
  inscrites au journal d'audit.
- **Console** : après un conflit (« Modifié ailleurs entre-temps »),
  « Reprendre la valeur du serveur » enregistre les autres modifications de
  la page au lieu de signaler un échec ; l'URL complète du moteur local suit
  de nouveau l'hôte et le port modifiés.
- **Journal d'exécution** : le plafond `llm.run_journal_max_mb` est appliqué
  (il était ignoré, 64 Mo toujours).
- **Prompts système** : deux enregistrements simultanés d'une même catégorie
  aboutissent tous deux.
- **Sauvegardes** : l'archive complète inclut le magasin des skills
  personnels (absent jusqu'ici, donc perdu à la restauration) ; journaux et
  fichiers PID ne sont plus ni sauvegardés ni restaurés ; une sauvegarde
  sans la base n'est plus comptée comme récente.
- **Sandbox** : les parcours de l'agent (listage, relevé des fichiers
  modifiés, taille) n'entrent jamais dans un lien, même apparu pendant le
  parcours ; la matrice adversariale se rejoue contre le vrai conteneur
  (`docs/sandbox-gateway.md`, « Tests »).
