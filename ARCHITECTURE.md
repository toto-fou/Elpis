# Architecture

Carte du code d'Elpis : les process, les paquets, où vit chaque chose et les
invariants qui tiennent l'ensemble. Ce document reste court et suit le code ;
le détail (API, schémas, séquences, sous-systèmes) est dans
[docs/architecture.md](docs/architecture.md), dont certaines parties
(arborescence, base de données) sont antérieures au rangement actuel : en cas
d'écart, ce fichier et le code font foi.

## Vue d'ensemble

Elpis est une application **multi-process** auto-hébergée : un serveur
applicatif Python sert l'interface et orchestre le LLM, un hôte d'outils
exécute les outils MCP, chaque utilisateur a son conteneur Docker, et des
services satellites (RAG, navigateur, contrôle d'écran, voix) sont optionnels
et reliés par HTTP.

| Process | Port | Entrée | Rôle |
|---|---|---|---|
| **main** | 8001 | `server/app.py` (`APP_MODE=main`) | chat, éditeur, sandbox, routines, statiques ; Gunicorn, `cpu − 1` workers au-delà de 2 cœurs (`APP_WORKERS`) |
| **admin** | 8002 | `server/admin_app.py` (`APP_MODE=admin`) | console d'administration et `/api/admin/*` ; 1 worker |
| **toolhost** | 8765 | `python -m toolhost` | hôte des outils MCP (HTTP streamable `/mcp[/<famille>]`, SSE), API sandbox et terminal ; sa propre base `user_db/toolhost.db` |
| **rag_app** | 8000 | `rag_app/start.sh` | service RAG autonome (FastAPI + Qdrant :6333, OCR) — optionnel |
| **browser-service** | 3000 | `browser-service/server.js` | navigateur piloté (Node + Playwright) — optionnel |
| **desktop-agent** | 8765 (sur la machine pilotée) | `desktop-agent/` | contrôle d'écran Windows (pywinauto) / Linux (AT-SPI) — optionnel |
| **llama-server** | 8080 | llama.cpp, hors dépôt | inférence locale ; ou tout moteur compatible OpenAI, ou un fournisseur distant |
| **Caddy** | 443 / 8443 / 8444 | `deploy/caddy/` | frontal HTTPS — optionnel |

`./elpis start` lance qdrant, rag, toolhost, main, admin et browser ;
`sudo ./elpis service install` en fait des services systemd (`elpis.target`).

## Le parcours d'un message

Un tour de chat, de la requête au dernier événement :

1. **Entrée.** L'interface envoie `POST /api/chat-saved-stream3`
   (`chatbot_app/routes/chats.py`). La route authentifie, puis refuse si une
   compaction ou une génération tourne déjà sur cette conversation (409) ou si
   l'utilisateur a trop d'exécutions en cours (429, `MAX_RUNS_PER_USER`).
2. **Cible.** `llm_core/_target.py` résout le moteur : `llama-server` intégré
   par défaut, ou un connecteur (activé, clé lisible, fournisseur autorisé).
   Les adresses des serveurs MCP sont résolues côté serveur, jamais reprises
   du client.
3. **Verrou et flux.** Un verrou par conversation (`flock` dans le répertoire
   d'exécution, `shared_infra/runtime/chat_locks.py`) vaut pour tous les
   workers. La réponse est un flux NDJSON alimenté par une tâche de fond via
   une file, jetons regroupés toutes les 25 ms.
4. **Ordonnancement.** Pour une cible llama.cpp, `llm_core/_scheduling/`
   applique l'exclusivité de modèle, les créneaux (slots) et le disjoncteur.
5. **Boucle.** Sans outil : `_chat_classic.py`. Sinon la boucle agentique
   (`_chat_with_tools.py`) : outils collectés dans le pool MCP, tête système
   assemblée, puis à chaque itération porte de compaction, élagage périodique,
   ajustement au contexte (`fit_context`), appel du modèle (Anthropic natif ou
   compatible OpenAI) et exécution des appels d'outils (les outils sériels —
   sandbox, dépôt, écran, sous-agent — un par un, les autres en parallèle,
   shell compris, résultats remis dans l'ordre ; traits de chaque outil dans
   `llm_core/_tool_traits.py`).
6. **Outils.** `_mcp_pool.call_tool` joint le **toolhost** (`python -m
   toolhost`, :8765), qui héberge les familles d'outils de
   `server/local_mcp_server.py` (repli : un sous-process stdio par worker).
   L'identité de l'utilisateur voyage dans `_meta`.
7. **Exécution.** Les commandes shell tournent dans le conteneur de
   l'utilisateur (`docker exec`, privilèges abaissés à l'UID 10001). Les outils
   fichiers, l'éditeur et Git passent par l'agent de ce conteneur
   (`shared_infra/sandbox/agent/`), sous le même UID ; les opérations Git
   réseau lancées par Elpis passent par le relais authentifiant de l'hôte
   (`shared_infra/sandbox/git_relay.py`).
8. **Fin de tour.** Le tour est enregistré (`shared_infra/chat/store.py`,
   contrôle optimiste sur `updated_at` : un conflit est signalé, rien n'est
   écrasé), puis les événements `kv_cache` et `final` partent. La
   consommation va dans `usage_events`, les appels d'outils dans
   `tool_call_metrics`, les compteurs dans `metric_events`.
9. **Arrêt et reprise.** `POST /api/chat/cancel` publie sur le bus
   d'annulation (fichier JSONL suivi par tous les workers). Si le navigateur
   se déconnecte, l'exécution continue détachée (dès qu'un outil a tourné, ou
   si la reprise est activée) ou s'arrête en enregistrant le partiel ; tout
   worker peut la rejoindre par `GET /api/chat/{id}/run/events`.

## Carte du code

### `server/` — points d'entrée

- `app.py` : `create_app()` et `lifespan` ; choisit les routeurs selon
  `APP_MODE` (`main`, `admin`, `full`), installe les middlewares (session,
  CSRF, en-têtes de sécurité, journal des requêtes, maintenance, relais
  sandbox) et démarre les tâches de fond.
- `admin_app.py` : force `APP_MODE=admin`.
- `gunicorn_conf.py`, `gunicorn_admin_conf.py`, `uvicorn_worker.py` (arrêt
  gracieux borné, vidage des flux SSE), `_bind_host.py` (adresse d'écoute,
  repli sur la boucle locale).
- `local_mcp_server.py` : le registre FastMCP des outils locaux, importé par
  `toolhost` (et repli stdio par worker).

### `llm_core/` — le moteur LLM

- **Transport** : `providers/` (`openai_compat`, `anthropic`, `llamacpp`,
  `llama_stream` pour le flux reprenable, `llama_models`, `llama_caps`,
  `discovery`), `_client.py`, `_llama_http.py`, `_llm_retry.py`, `_target.py`
  (cible d'inférence par requête), `engines.py`, `_llm_params.py` (cascade des
  paramètres d'échantillonnage).
- **Boucles de chat** : `_chat_classic.py` (sans outils), `_chat_with_tools.py`
  (boucle agentique), `engine/` (exécution d'un appel d'outil, contrat de
  résultat), `_tool_parsing.py`, `_stream_tag_parser.py`, `_think_*` et
  `_thinking_reconcile.py` (raisonnement).
- **Harnais de contexte** : `context/` — `tokens` (autorité de comptage),
  `budget`, `compaction_gate`, `pruning` (`fit_context`), `assembly` (tête
  système stable à l'octet), `compression/` ; plus
  `conversation_compressor.py`, `context_config.py`, `_ctx_window.py`.
- **Ordonnancement** : `_scheduling/` (files FIFO à deux niveaux, exclusivité
  de modèle, disjoncteur, un ordonnanceur par serveur), `_queue.py`,
  `_capabilities.py`.
- **Outils** : `_mcp_pool.py`, `_mcp_wrappers.py`, `_mcp_categories.py` ;
  `tools/` (fichiers, shell, Git, navigateur, bureau, graphiques, mémoire,
  skills, tâches, sous-agents, RAG ; `app_mcp.py` pour les outils servis dans
  le process) ; `tools/_exec_bridge.py` fait passer les outils synchrones par
  `docker exec` dans la sandbox.
- **Mémoire et skills** : `memory/` (mémoire long terme en Markdown + index
  FTS5), `skills.py`, `_skill_validate.py`, `_system_prompts.py` (assemblage
  du prompt système depuis `system_prompts/`).
- **Divers** : vision et bureau (`_vision.py`, `_detection_client.py`,
  `_desktop_*`), client RAG (`_rag_client.py`), santé et capacités
  (`_health.py`, `_model_info.py`, `_model_lifecycle.py`).

### `shared_infra/` — l'infrastructure, rangée par famille

Chaque sous-paquet réunit la logique, les routes et le stockage d'un sujet ;
son `__init__.py` le décrit.

| Famille | Contenu |
|---|---|
| `accounts` | utilisateurs, groupes, mots de passe, identité signée pour le toolhost, routes d'authentification et de paramètres |
| `appearance` | skins (registre des intégrés, plugins importés dans `user_skins/`, état `config.json` › `skins`, `/api/skins`) et registre des mascottes |
| `chat` | conversations, prompts et gabarits, routes skills |
| `db` | persistance multi-moteurs (voir plus bas) |
| `llm` | connecteurs de modèles, capture de débogage, file d'attente |
| `mcp` | familles d'outils (source unique), serveurs, panneau `/api/mcp/*`, relais, manifeste `mcp.json` |
| `memory` | stockage de la mémoire, mémoire d'accessibilité (`ax/`) |
| `observability` | journal d'accès, `swallow()`, consommation (`usage`), bus d'événements SSE, métriques (`metrics/`) |
| `ops` | entretien quotidien, sauvegardes (locale, distante, planifiée), bascule de base |
| `runtime` | canaux entre workers : annulation, verrous de chat, journal des exécutions |
| `sandbox` | conteneurs par utilisateur (`executors/`), chemins, politique, placement, relais vers un toolhost, fichiers, Git, aperçus Office |
| `scheduling` | élection du leader (`cron_lock`), routines, cron, webhooks |
| `security` | CSRF, dépendances d'authentification, chiffrement Fernet, audit, en-têtes, requêtes locales |
| `git`, `desktop`, `files`, `charts`, `notifications`, `opencode`, `terminal`, `toolhost`, `voice` | Git (fournisseurs, SSRF), contrôle d'écran, analyse de fichiers, graphiques, notifications, client opencode, terminal, rappels du toolhost, relais voix |

`shared_infra/routes/` ne garde que l'orchestrateur (`__init__.py`, dont
l'ordre d'import est l'ordre d'enregistrement), `_state.py`, `_helpers.py`,
quelques routes transverses et la sous-application `admin/`
(`admin_router`, `internal_router` ; `config.py` porte l'enregistrement champ
par champ `PATCH /api/admin/config`, `overview.py` la Vue d'ensemble).
`config.py` résout la configuration, fixe le `BUILD_ID` et note les chemins
lus au démarrage (`BOOT_READ_PATHS`), d'où `ops/restart_pending.py` déduit
les réglages qui attendent un redémarrage.

### `chatbot_app/` — les routes de chat

`routes/chats.py` : `POST /api/chat-saved-stream3` (flux NDJSON), annulation,
compaction, reprise d'exécution ; `routes/saved_chats.py` : conversations
enregistrées, archives, recherche.

### `frontend/` — l'interface

- `index.html` (application ; embarque aussi la console en mode `full`) et
  `admin.html` (console seule, servie par le process admin).
- `includes/` (`layout/`, `main/`, `admin/`, `modals/`) : fragments assemblés
  côté serveur (`<!-- @include … -->`, `shared_infra/routes/system.py`).
- `js/` : `app.js` (racine Vue, assemble les modules), `app-{auth,chat,editor,
  admin,settings}.js`, dossiers `chat/`, `editor/`, `voice/`, `utils.js` ;
  `admin/_registry.js` (arborescence de la console : pages, titres, liens
  `#page`, chargeurs, blocs enregistrés) et `admin/_fields.js` (index des
  réglages pour la recherche Ctrl+K, **généré** par
  `tools/generate_admin_fields.py`).
- `css/style.css` (jetons, composants), `css/style.tailwind.css` (**généré**),
  `css/skins/` (skins intégrés et leur registre `skins.json`) ; `vendor/` (Vue, Monaco, xterm, Chart.js, Marked,
  highlight.js, Mermaid, DOMPurify, Phosphor).

### Services et déploiement

- `toolhost/` : hôte d'outils déployable (MCP, sandbox, terminal), jeton
  `user_db/.local_mcp_token` + en-tête d'identité signé.
- `rag_app/` : service RAG autonome (sans `shared_infra`).
- `browser-service/`, `desktop-agent/` : voir le tableau des process.
- `deploy/` : Caddy, image sandbox (`docker/sandbox/`, `elpis/sandbox:1.7.0`),
  Qdrant, toolhost distant, voix (whisper.cpp :8090, Piper :8091),
  assistant de configuration (`configure.py`, `wizard.py`, `tui.py`).
- `install.sh`, `elpis` (CLI d'exploitation), `make_release.sh` (paquet hors
  ligne), `tools/generate_tailwind_css.mjs`.
- `system_prompts/` (prompts, en anglais), `skills/` (skills globaux ;
  `learned/` = sas de l'administrateur).

### Données d'exécution (hors dépôt)

`config.json` (racine), `user_db/` (base SQLite, secret de session, jetons,
mot de passe de la base, uploads), `user_sandboxes/` (un dossier par
utilisateur, monté sur `/work`), `user_skills/`, `user_skins/` (skins
importés), `logs/`, et
`../mcp_custom_servers/` (à côté du dépôt).

## Base de données

- Moteurs : **SQLite** (défaut), **PostgreSQL** (pg8000), **MariaDB/MySQL**
  (PyMySQL), choisis par `database.backend` dans `config.json` ou `APP_DB_*` ;
  le mot de passe vient de `APP_DB_PASSWORD` ou `user_db/.db_password`, jamais
  de `config.json`.
- `shared_infra/db/` : `_connection.py` (`db()`, `db_conn()`, `init_db` ;
  une connexion par thread en SQLite, pool borné en serveur), `_pool.py`,
  `_server.py` (fait se comporter les moteurs serveur comme `sqlite3`),
  `_pg.py`, `_mysql.py`, `_dialect.py` (SQL propre à chaque moteur),
  `_schema.py` (schéma de référence, `create_all`), `_migrations/` (suivies
  dans `schema_migrations`), `transfer.py` (copie entre moteurs).
- Bascule à chaud : `shared_infra/ops/db_switch.py` (mode maintenance, 503 sur
  les écritures, génération incrémentée), pilotée par la console ou
  `./elpis db`.

## Sandbox et exécution

Un conteneur Docker **par utilisateur** (`elpis-sb-<utilisateur>`, étiquettes
`elpis.*`), image `elpis/sandbox`,
dossier de l'utilisateur monté sur `/work`, réseau coupé sauf profil réseau
attribué, limites mémoire / CPU / processus, seules les capacités nécessaires
(`CAPABILITIES`, sans `NET_RAW` ni `MKNOD`). Le
conteneur est la frontière de sécurité : toute opération sur `/work` s'y
exécute, par son agent (ci-dessous), sous l'UID du conteneur, seul à y
écrire (fichiers 0644, dossiers 0755). L'hôte ne lit ni n'écrit `/work`
(exceptions : `du` du quota, suppression d'un compte, création de
`P/work` ; cf. `docs/sandbox-gateway.md`). Git tourne dans le conteneur, par l'agent
(`sandbox/git_ops.py`) ; ses opérations réseau passent par le relais
authentifiant de l'hôte (`sandbox/git_relay.py`) : un ticket par opération,
le seul dépôt de l'opération joignable, l'identifiant du connecteur ajouté
par l'hôte, jamais dans la sandbox.

Dans chaque conteneur, un **agent** (`sandbox/agent/server.py`, bibliothèque
standard) exécute les opérations sur `/work` que l'hôte lui demande : HTTP sur
`/run/elpis/agent.sock` (dossier `<utilisateur>/.elpis-agent` monté), code monté en
lecture seule depuis l'application, démarré à la demande sous l'UID du
conteneur, relancé s'il n'a pas la version de l'application. L'hôte le joint
par `sandbox/agent_client.py`, qui saisit le socket sans suivre de lien et
tient toute réponse pour non fiable.

## Outils externes (MCP, OAuth, OpenAPI)

Les familles d'outils de la sandbox sont servies par le **service d'outils**
(`server/local_mcp_server.py`, `toolhost/`), en MCP par famille
(`/mcp/<famille>`). Les clients externes le joignent par l'origine de l'app :
le **relais** `shared_infra/mcp/bridge.py` (`/api/mcp-bridge[/<famille>]`)
vérifie le jeton du client — jeton personnel (`shared_infra/accounts/tokens.py`,
en empreinte) ou jeton OAuth (`shared_infra/mcp/oauth.py`,
`routes_oauth.py` : Elpis est son propre serveur d'autorisation) — puis
présente au service un jeton de délégation signé (`mcp/delegation.py`) qui
porte le compte et ses familles : le jeton du client ne quitte jamais le
relais. La **façade OpenAPI** (`mcp/openapi.py`, `routes_openapi.py`)
expose les mêmes outils en HTTP ordinaire. Le **navigateur** (`browser-service/`)
passe par un relais local filtrant (`proxy_guard.js`, `url_guard.js`).

## Invariants

- **Séparation des process.** Les routes d'administration sont **montées**
  seulement en `APP_MODE=admin` (ou `full`) : absentes du process main, ce
  n'est pas un contrôle à l'exécution. Le process admin tourne sous le même
  compte non privilégié, jamais en root.
- **Tête système stable à l'octet.** Un seul message `role: system`, dans un
  ordre figé (`llm_core/context/assembly.py`), pour le cache de préfixe du
  moteur ; le jeu d'outils ne varie pas d'un message à l'autre ; les résumés
  de compaction ne sont jamais fusionnés dans le socle. Les charges utiles de
  référence (`tests/goldens/`) ne changent que par `GOLDEN_UPDATE=1`.
- **Une seule autorité de comptage** : `llm_core/context/tokens.py`. Aucune
  décision ne repose sur un ratio caractères/token.
- **Élagage** (`context/pruning.py`) : ne modifie jamais les messages de
  travail, ne sépare jamais un appel d'outil de son résultat, ne tronque pas
  la dernière perception de bureau, garde les messages système et les plus
  récents.
- **Outils** : l'exécution d'un appel ne lève jamais (erreur rendue en JSON) ;
  le pool MCP ne rejoue jamais un appel qui a peut-être déjà agi.
- **Configuration** : variable d'environnement > `config.json` > défaut ; les
  constantes de module sont figées à l'import ; un réglage modifiable depuis
  la console se relit à chaud (`live_config_value()`, `config_view()`, ou les
  rechargeurs `reload_*_from_disk`), sinon la console l'annonce comme
  « Redémarrage nécessaire » ; ne jamais modifier le dictionnaire rendu par
  `config_view()`.
- **État partagé entre workers** : seulement la base, le répertoire
  d'exécution (bus d'annulation, verrous de génération, leader des tâches
  planifiées, journal d'exécution, reprise des sous-agents), le bus
  d'événements fichier, ou Redis s'il est configuré. Un dictionnaire de module
  vaut pour un seul worker. Une annulation ne passe jamais par les événements
  système (fuite d'identifiants de conversation).
- **Base** : tout `db()` a son `close()` ; SQL portable via `_dialect.py` ;
  une migration met aussi à jour `_schema.py` et `BASELINE_COVERS`.
- **Tâches planifiées** (routines, entretien, sauvegardes) : sur le seul
  worker leader (`scheduling/cron_lock.py`), jamais dans le process admin.
- **Sandbox** : le conteneur est la barrière ; toute opération sur `/work`
  passe par l'agent du conteneur (`sandbox/agent_client.py`, `git_ops.py`),
  jamais par un `open`, `os.walk`, `chmod` ou `unlink` de l'hôte (vérifié
  pour les parcours principaux par `test_frontiere_interception_2026_09_30.py` ;
  exceptions, métadonnées seules : `docs/sandbox-gateway.md`) ; aucun `git` côté hôte sur
  un dépôt de sandbox ; tout conteneur passe par la résolution du profil
  réseau (un profil imposé par l'administrateur l'emporte).

## Tests

- `tests/` suit les paquets : `llm_core/`, `shared_infra/`, `db/`, `chatbot/`,
  `memory/`, `sandbox/`, `rag_app/`, `desktop_agent/`, `toolhost/` ;
  `goldens/` (charges utiles de référence), `load/` (charge, manuel).
- `tests/frontend/` : tests unitaires JS (exécutés aussi par pytest), gardes
  statiques (classes Tailwind, exports), et paires Playwright
  `*-server.mjs` / `*-verify.mjs`.
- Commandes et règles : [AGENTS.md](AGENTS.md).
