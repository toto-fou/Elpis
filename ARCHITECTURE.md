# Architecture

Carte du code d'Elpis : les process, les paquets, où vit chaque chose et les
invariants qui tiennent l'ensemble. Ce document reste court et suit le code ;
le détail (API, schémas, séquences, sous-systèmes) est dans
[docs/architecture.md](docs/architecture.md) ; en cas d'écart, ce fichier et
le code font foi. L'histoire des règles du cœur (boucle agentique, flux de
chat) est dans l'historique git.

## Vue d'ensemble

Elpis est une application **multi-process** auto-hébergée : le core
TypeScript (Node, Fastify) sert l'interface et orchestre le LLM, un hôte d'outils
exécute les outils MCP, chaque utilisateur a son conteneur Docker, et des
services satellites (RAG, navigateur, contrôle d'écran, voix) sont optionnels
et reliés par HTTP.

| Process | Port | Entrée | Rôle |
|---|---|---|---|
| **main** | 8001 | `apps/core/dist/main.mjs` (Node, `APP_MODE=main`) | chat, éditeur, sandbox, routines, statiques ; un process |
| **admin** | 8002 | `apps/core/dist/main.mjs` (Node, `APP_MODE=admin`) | console d'administration et `/api/admin/*` ; un process |
| **toolhost** | 8765 | `apps/toolhost/dist/main.mjs` (Node) | hôte des outils MCP (HTTP streamable `/mcp[/<famille>]`, SSE), API sandbox et terminal ; sa propre base `user_db/toolhost.db` ; sert lui-même ses familles d'outils, dont Office (worker Python `office/`) |
| **rag_app** | 8000 (loopback) | `rag_app/start.sh` | extracteur du RAG (FastAPI, sans état) : texte, pages, localisation, OCR ; le RAG lui-même (collections, droits, indexation, recherche) est dans le core, avec Qdrant :6333 |
| **browser-service** | 3000 | `browser-service/server.js` | navigateur piloté (Node + Playwright) — optionnel |
| **desktop-agent** | 8765 (sur la machine pilotée) | `desktop-agent/` | contrôle d'écran Windows (pywinauto) / Linux (AT-SPI) — optionnel |
| **llama-server** | 8080 | llama.cpp, hors dépôt | inférence locale ; ou tout moteur compatible OpenAI, ou un fournisseur distant |
| **Caddy** | 443 / 8443 | `deploy/caddy/` | frontal HTTPS — optionnel |

`./elpis start` lance qdrant, rag, toolhost, main, admin
et browser ;
`sudo ./elpis service install` en fait des services systemd (`elpis.target`).

## Le parcours d'un message

Un tour de chat, de la requête au dernier événement :

1. **Entrée.** L'interface envoie `POST /api/chat-saved-stream3`
   (`apps/core/src/familles/chat.ts`). L'admission (`apps/core/src/tour/ouverture.ts`,
   `admission.ts`) authentifie, puis refuse si une compaction ou une
   génération tourne déjà sur cette conversation (409) ou si le compte a trop
   d'exécutions en cours (429). La préparation (`tour/preparation.ts`) décide
   ensuite tout le tour : cible, outils, historique, compaction, titre.
2. **Cible.** `apps/core/src/llm/cible.ts` résout le moteur : `llama-server`
   intégré par défaut, ou un connecteur (activé, clé lisible, fournisseur
   autorisé). Les adresses des serveurs MCP sont résolues côté serveur,
   jamais reprises du client.
3. **Verrou et flux.** Un verrou de présence par conversation, en mémoire
   (main est un seul process, `tour/etat.ts`) ; la route le prend, le tour le
   réclame. La réponse est un flux NDJSON (`tour/execution.ts`) pompé par
   `tour/evenements.ts`, jetons regroupés toutes les 25 ms. L'ordre des
   événements et les invariants du flux sont écrits dans
   [apps/core/src/tour/README.md](apps/core/src/tour/README.md).
4. **Ordonnancement.** Pour une cible llama.cpp, `apps/core/src/llm/ordonnanceur/`
   applique l'exclusivité de modèle, les créneaux (slots) et le disjoncteur.
5. **Boucle.** Un seul chemin, avec outils : l'orchestrateur
   (`apps/core/src/boucle/orchestrateur.ts`) collecte les outils dans le pool
   MCP et assemble la tête système, puis, à chaque itération, un tour LLM
   (`boucle/tour-llm.ts`) : porte de compaction, élagage périodique,
   ajustement au contexte, appel du modèle (Anthropic natif ou compatible
   OpenAI). Puis l'exécution du lot d'appels d'outils, la même pour les appels
   natifs et les appels écrits en texte (`boucle/dispatch-outils.ts`,
   `execution-outils.ts`) : les outils mutants un par un, les autres en
   parallèle borné, résultats remis dans l'ordre ; traits de chaque outil dans
   `apps/core/src/outils/traits.ts`. Réponse finale, synthèse sur limite et
   sortie d'erreur sont dans `boucle/sortie.ts`.
6. **Outils.** Le pool MCP (`apps/core/src/outils/mcp/clients.ts`) joint
   l'**hôte d'outils** (`apps/toolhost`, :8765, service requis : le core ne le
   lance jamais lui-même) ; l'identité du compte voyage dans `_meta`. Les
   familles liées au compte (mémoire, tâches, skills, graphiques) sont servies
   en processus par main (`outils/mcp/en-processus.ts`).
7. **Exécution.** Les commandes shell tournent dans le conteneur de
   l'utilisateur (`docker exec`, privilèges abaissés à l'UID 10001). Les outils
   fichiers, l'éditeur et Git passent par l'agent de ce conteneur
   (`shared_infra/sandbox/agent/`, client `@elpis/fichiers`), sous le même
   UID ; les opérations Git réseau lancées par Elpis passent par le relais
   authentifiant de l'hôte (`packages/fichiers/src/relais-git.ts`).
8. **Fin de tour.** Le tour est enregistré (`tour/persistance.ts` puis
   `apps/core/src/chats/stockage.ts`, contrôle optimiste sur `updated_at` : un
   conflit est signalé, rien n'est écrasé), puis les événements `kv_cache` et
   `final` partent. La consommation va dans `usage_events`, les appels
   d'outils dans `tool_call_metrics`, les compteurs dans `metric_events`.
9. **Arrêt et reprise.** `POST /api/chat/cancel`
   (`apps/core/src/familles/chat-controle.ts`) arrête le tour par son
   AbortSignal. Si le navigateur se déconnecte, l'exécution continue détachée
   (dès qu'un outil a tourné, ou si la reprise est activée) ou s'arrête en
   enregistrant le partiel ; on la rejoint par `GET /api/chat/{id}/run/events`,
   y compris après un redémarrage (`tour/journal-run.ts`).

## Carte du code

### `apps/core/` — le core TypeScript

- `src/main.ts` (process, signaux), `composition.ts` (assemblage),
  `familles/` (routes HTTP par famille, montées selon `APP_MODE` ; liste dans
  `familles.ts`).
- **Chat** : `tour/` (admission, préparation, exécution, pompe NDJSON,
  persistance, historique d'un tour), `boucle/` (boucle agentique : dispatch
  des outils, appels écrits en texte, balises du flux, contrat de résultat),
  `chats/` (stockage, prompts, gabarits).
- **LLM** : `llm/` (fournisseurs, cible par requête, paramètres, santé,
  capacités, `ordonnanceur/`), `contexte/` (budget, élagage, assemblage,
  compression).
- **Outils** : `outils/` (catalogue, catégories, MCP, OpenAPI, outils
  intégrés), `relais/` (vers l'hôte d'outils), `memoire/`, `skills/`,
  `graphiques/`, `images/`, `rag/`, `voix/`.
- **Exploitation** : `admin/` et `administration/` (console), `ops/`
  (sauvegardes, bascule de base, entretien, redémarrage), `observabilite/`,
  `evenements/`, `routines/`, `executions/`, `notifications/`, `interface/`
  (pages, statiques).
- `packages/` : paquets partagés avec l'hôte d'outils (`contracts` pour les
  événements du flux, `db` pour le schéma et les moteurs, `http` pour le socle
  Fastify, `auth`, `securite`, `config`, `mcp`, `outils-mcp`, `navigateur`,
  `bureau`, `fichiers`, `images`, `skills`, `verrous`, `bac`, `commun`).
- `apps/toolhost/` : hôte d'outils TS (familles natives, dont Office et son
  worker Python `mcp/office/`, sandbox, terminal).

### `office/` — le moteur Office

- `elpis_office/` : paquet Python autonome (python-docx, python-pptx, lxml,
  Pillow, pydantic, markdown-it-py ; aucun import de `shared_infra`) qui porte les sept outils Word et PowerPoint (`word.py`,
  `powerpoint.py`, `_docx/`, `_pptx/`, `_chart/`, rendu ECharts `echarts_ssr.cjs`).
  Il ne voit le monde que par l'`Env` (`commun.py`) que lui branche l'hôte :
  lecture et écriture de fichiers, graphiques, conversion PDF.
- `canal.py` et `__main__.py` : le worker (`python -m elpis_office`), lancé par
  `apps/toolhost/src/mcp/office/worker.ts` ; cadres JSON et corps binaire sur
  stdin (appels) et descripteur 3 (réponses), stdout et stderr au journal,
  plusieurs appels en parallèle, rappels vers l'hôte.
- `requirements.txt` : ses dépendances, incluses par `requirements.txt`.

### `shared_infra/` — le Python restant, rangé par famille

Ce qu'importe l'assistant de configuration (`deploy/`), plus l'agent du bac
(`sandbox/agent/`, bibliothèque standard seulement). Les routes HTTP sont
toutes dans le core TypeScript.

| Famille | Contenu |
|---|---|
| `accounts` | comptes (`users.py`) |
| `db` | persistance multi-moteurs du Python restant (`_dialect.py`, migrations historiques, `python -m shared_infra.db` pour la configuration) |
| `llm` | connecteurs de modèles |
| `memory` | mise à niveau des anciennes tables de la mémoire AX (`ax/`) |
| `observability` | `swallow()` |
| `runtime` | verrous de fichiers entre process (`elpis.verrou.v1.1`) |
| `sandbox` | agent du conteneur (`agent/`) |
| `security` | chiffrement Fernet |
| `ops` | génération de base publiée par la bascule |

`config.py` résout la configuration du Python restant (variable
d'environnement > `config.json` > défaut).

### `frontend/` — l'interface

- Workspace npm `@elpis/web` (TypeScript, Vue 3.5, Vite) : `npm run build:web`
  écrit `frontend/dist/` ; deux entrées `src/entries/main.ts` (application) et
  `admin.ts` (console), posées dans `index.html` et `admin.html` par
  `<!-- @entree … -->` (manifeste lu par `apps/core/src/interface/pages.ts`).
- `src/platform/` (client HTTP, `ApiResult`, lecteur NDJSON),
  `src/features/<domaine>/` (logique typée : auth, chat, editor, terminal,
  admin, reglages, routines, studio, images, voix, mascotte, skills, code),
  `src/components/<domaine>/` (SFC), `src/utils/`, `src/modeles/` ; contrats
  réseau validés par `@elpis/contracts` (Zod). Console : registre
  `features/admin/registre.ts`, index Ctrl+K `features/admin/champs.gen.ts`
  (**généré** par `frontend/champs-admin.mts`).
- Racines `src/components/racine/{App,AppConsole}.vue` sur `src/app/racine/`
  (état partagé, session, montage des modules, clavier, notifications) ;
  `index.html` et `admin.html` sont des coquilles. Le build embarque le
  runtime Vue sans compilateur de gabarits ; les pages portent une CSP stricte
  (`security.csp`).
- `css/style.css` (jetons, composants), `css/style.tailwind.css` (**généré**),
  `css/skins/` (skins intégrés et leur registre `skins.json`) ; `vendor/` :
  Phosphor et le compilateur Tailwind du générateur ; les autres bibliothèques
  (Vue, Monaco, xterm, ECharts, Chart.js, Marked, highlight.js, Mermaid,
  DOMPurify, Zod) sont des paquets npm aux versions figées.

### Services et déploiement

- `apps/toolhost/` : hôte d'outils déployable seul (MCP, sandbox, terminal ;
  `deploy/toolhost/` pour une machine distante), jeton
  `user_db/.local_mcp_token` + en-tête d'identité signé.
- `rag_app/` : extracteur du RAG (sans `shared_infra`), appelé par `apps/core/src/rag/`.
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

- Moteurs : **SQLite** (défaut, better-sqlite3) et **PostgreSQL** (pg),
  choisis par `database.backend` dans `config.json` ou `APP_DB_*` ; le mot de
  passe vient de `APP_DB_PASSWORD` ou `user_db/.db_password`, jamais de
  `config.json`.
- `packages/db/src/` : `ouvrir.ts` (ouverture selon les réglages),
  `sqlite.ts` (écritures et transactions sérialisées), `postgres.ts` (pool
  borné, valeurs et erreurs relues comme en SQLite), `dialecte.ts` (SQL propre
  à chaque moteur), `schema.ts` et `schema.gen.ts` (schéma de référence),
  `init.ts` (pose du schéma, migrations suivies dans `schema_migrations`).
  Transfert entre moteurs : `apps/core/src/ops/transfert.ts`. Le Python
  restant (configuration) passe par `shared_infra/db/`.
- Bascule à chaud : `apps/core/src/ops/bascule.ts` (mode maintenance, 503 sur
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
(`packages/fichiers/src/git.ts`) ; ses opérations réseau passent par le relais
authentifiant de l'hôte (`packages/fichiers/src/relais-git.ts`) : un ticket par opération,
le seul dépôt de l'opération joignable, l'identifiant du connecteur ajouté
par l'hôte, jamais dans la sandbox.

Dans chaque conteneur, un **agent** (`shared_infra/sandbox/agent/server.py`,
Python, bibliothèque standard) exécute les opérations sur `/work` que l'hôte lui demande : HTTP sur
`/run/elpis/agent.sock` (dossier `<utilisateur>/.elpis-agent` monté), code monté en
lecture seule depuis l'application, démarré à la demande sous l'UID du
conteneur, relancé s'il n'a pas la version de l'application. L'hôte le joint
par `@elpis/fichiers` (`packages/fichiers/src/agent.ts`), qui saisit le socket
sans suivre de lien et tient toute réponse pour non fiable.

## Outils externes (MCP, OAuth, OpenAPI)

Les familles d'outils de la sandbox sont servies par l'**hôte d'outils**
(`apps/toolhost` ; Office par un worker Python), en MCP par famille
(`/mcp/<famille>`). Les clients externes le joignent par l'origine de l'app :
le **relais** `apps/core/src/familles/pont-mcp.ts` (`/api/mcp-bridge[/<famille>]`)
vérifie le jeton du client — jeton personnel (`packages/auth/src/jetons.ts`,
en empreinte) ou jeton OAuth (`packages/auth/src/oauth.ts`,
`apps/core/src/familles/oauth.ts` : Elpis est son propre serveur
d'autorisation) — puis présente à l'hôte un jeton de délégation signé
(`packages/mcp/src/delegation.ts`) qui porte le compte et ses familles : le
jeton du client ne quitte jamais le relais. Les familles liées au compte
(mémoire, tâches, skills, graphiques) sont servies par main lui-même. La **façade OpenAPI** (`apps/core/src/outils/openapi.ts`)
expose les mêmes outils en HTTP ordinaire. Le **navigateur** (`browser-service/`)
passe par un relais local filtrant (`proxy_guard.js`, `url_guard.js`).

## Identifiants de sites

Un coffre par compte (`coffre_identifiants`, mot de passe Fernet, **origine
exacte**) et des jetons `⟦creds:JETON@ORIGINE⟧` liés à une conversation (`coffre_jetons`,
empreinte SHA-256, 30 min, 5 usages) : le modèle ne voit jamais un mot de passe.
Les outils `pw_*` le demandent au core par le canal interne signé
(`/api/internal/creds/resolve`) après un pré-contrôle sans valeur du champ, et
`browser-service` ne le saisit que par la **connexion atomique** `pw_login` (le modèle ne
saisit jamais un secret par un geste), dans une **session sécurisée** (navigateur dédié,
TLS strict, routes en liste blanche, cibles sémantiques), si le frame de l'élément est sur
l'origine du jeton ; les documents qui ont reçu le secret sont remplacés aussitôt après. Détail dans
[docs/architecture.md](docs/architecture.md) (« Coffre d'identifiants »).

## Procédures du navigateur

Une **procédure** est un arbre de comportement (`seq`, `sel`, `if`, `act`, `login`, `retry`), validé par
`@elpis/contracts` (`validerProcedure` : cibles sémantiques, origine exacte, limites dures), enregistré par
compte (`ax_procedures`, versions gardées) et rejoué **sans le modèle** par `pw_run` : l'interpréteur de
`apps/toolhost/src/mcp/browser/procedures/` appelle les traitements de `pw_act` et `pw_login` (garde
d'adresse, mémoire AX, session sécurisée, expurgation) avec un budget, l'annulation de l'appel et l'arrêt sans
rejeu sur un geste ambigu. Un échec réparable est rendu au modèle du chat avec le contexte de la page
(`failed_at.repair`) ; il corrige le nœud par `pw_procedure(action='repair')` (règles strictes) puis reprend
(`resume`). Détail dans [docs/architecture.md](docs/architecture.md) (« Procédures »).

## Invariants

- **Séparation des process.** Les routes d'administration sont **montées**
  seulement en `APP_MODE=admin` (ou `full`) : absentes du process main, ce
  n'est pas un contrôle à l'exécution. Le process admin tourne sous le même
  compte non privilégié, jamais en root.
- **Tête système stable à l'octet.** Un seul message `role: system`, dans un
  ordre figé (`apps/core/src/contexte/assemblage.ts`), pour le cache de préfixe
  du moteur ; le jeu d'outils ne varie pas d'un message à l'autre ; les
  résumés de compaction ne sont jamais fusionnés dans le socle.
- **Une seule autorité de comptage** : `apps/core/src/contexte/tokens.ts`.
  Aucune décision ne repose sur un ratio caractères/token.
- **Élagage** (`apps/core/src/contexte/elagage.ts`) : ne modifie jamais les
  messages de travail, ne sépare jamais un appel d'outil de son résultat, ne
  tronque pas la dernière perception de bureau, garde les messages système et
  les plus récents.
- **Outils** : l'exécution d'un appel ne lève jamais (erreur rendue en JSON) ;
  le pool MCP ne rejoue jamais un appel qui a peut-être déjà agi.
- **Configuration** : variable d'environnement > `config.json` > défaut ; un
  réglage modifiable depuis la console se relit à chaud (`liveConfigValue()`,
  `configView()` de `packages/config/src/vivant.ts`, règle de lint
  `elpis/reglages-vifs`), sinon la console l'annonce comme « Redémarrage
  nécessaire » ; ne jamais modifier le dictionnaire rendu par `configView()`.
- **État partagé entre process** (main, admin, hôte d'outils) :
  seulement la base ou le canal interne. main est un seul process : ses tours
  en cours, verrous de présence et annulations vivent en mémoire. Une
  annulation ne passe jamais par les événements système (fuite
  d'identifiants de conversation).
- **Base** : SQL portable via `packages/db/src/dialecte.ts` ; une nouvelle
  table ou colonne est une migration de `MIGRATIONS_TS`
  (`packages/db/src/init.ts`) ; côté Python, tout `db()` a son `close()`.
- **Secrets d'identification** : jamais en argument d'outil, dans le prompt ni
  dans un journal ; un outil reçoit une référence `JETON.champ`, le core la
  résout (compte, conversation, origine, usages), et tout résultat rendu au modèle
  est nettoyé de la valeur.
- **Tâches planifiées** (routines, entretien, sauvegardes) : dans main, un
  seul planificateur actif entre les process (`apps/core/src/routines/meneur.ts`),
  jamais dans le process admin.
- **Sandbox** : le conteneur est la barrière ; toute opération sur `/work`
  passe par l'agent du conteneur (`@elpis/fichiers`), jamais par un `open`,
  `readdir`, `chmod` ou `rm` de l'hôte (exceptions, métadonnées seules :
  `docs/sandbox-gateway.md`) ; aucun `git` côté hôte sur un dépôt de sandbox ;
  tout conteneur passe par la résolution du profil réseau (un profil imposé
  par l'administrateur l'emporte).

## Tests

Les tests (Vitest pour le TypeScript, pytest pour le Python restant, parcours
réels dans Chromium) vivent dans le dépôt de développement des mainteneurs,
qui les passent avant chaque fusion. Dans ce dépôt : `npm run typecheck`,
`npm run lint` et `npm run build` ([AGENTS.md](AGENTS.md),
[CONTRIBUTING.md](CONTRIBUTING.md)).
