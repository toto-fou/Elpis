# AGENTS.md

Consignes pour les agents de code (et les humains) qui modifient Elpis :
commandes, conventions, pièges connus. Pour la carte du code, lire
[ARCHITECTURE.md](ARCHITECTURE.md) ; pour l'interface,
[PRODUCT.md](PRODUCT.md) et [DESIGN.md](DESIGN.md).

## Le projet en bref

Assistant LLM **auto-hébergé** : chat agentique (outils MCP, sous-agents,
mémoire, skills), éditeur de code sur une sandbox Docker par utilisateur,
routines, service RAG, console d'administration. Core (main, admin) et hôte
d'outils en TypeScript (Node 24, Fastify) ; interface en TypeScript et Vue 3
(SFC compilés par Vite). Restent en Python : le service RAG (`rag_app/`),
elpis-tools (`server/local_mcp_server.py`, qui sert la famille d'outils
Office), `desktop-agent/`, l'agent du bac (`shared_infra/sandbox/agent/`) et
l'installation (`deploy/configure.py`, `deploy/wizard.py`). Inférence
`llama-server` (llama.cpp) ou tout moteur compatible OpenAI. Interface et
documentation en français. Licence MIT.

`docs/architecture.md` est détaillé ; en cas de doute, le code fait foi, puis
ARCHITECTURE.md.

## Installer et lancer

```bash
./install.sh                                  # Debian 12/13, Ubuntu 24.04 : Node 24 dans node/, venv dans venv/
./elpis start | stop | restart | status       # tous les services
./elpis logs [qdrant|rag|tools|toolhost|main|admin|browser] [-f]
./elpis doctor                                # diagnostic
./elpis db info | check CIBLE | transfer --to CIBLE | use sqlite|CIBLE
```

Lancement manuel (depuis la racine : le serveur lit `frontend/` relativement
au répertoire courant) :

```bash
npm ci && npm run build                                                    # bundles du core, de l'hôte d'outils et du front (frontend/dist)
ELPIS_RACINE=$PWD node/bin/node apps/toolhost/dist/main.mjs --elpis-tools # famille Office (elpis-tools, Python) :8767
ELPIS_RACINE=$PWD TOOLHOST_MCP_UPSTREAM=http://127.0.0.1:8767/mcp \
  node/bin/node apps/toolhost/dist/main.mjs                              # hôte d'outils MCP :8765
ELPIS_RACINE=$PWD APP_MODE=main LOCAL_MCP_URL=http://127.0.0.1:8765/mcp \
  node/bin/node apps/core/dist/main.mjs                                  # chat :8001
ELPIS_RACINE=$PWD APP_MODE=admin LOCAL_MCP_URL=http://127.0.0.1:8765/mcp \
  node/bin/node apps/core/dist/main.mjs                                  # console :8002
```

Ports par défaut : main 8001, admin 8002, outils MCP (`toolhost`) 8765,
elpis-tools 8767 (loopback), RAG 8000, Qdrant 6333, navigateur 3000,
`llama-server` 8080. La configuration d'instance est `config.json` à la racine
(non versionné ; modèle : `config.example.json`). Les versions `?v=` des
ressources sont réécrites au `BUILD_ID` du process : redémarrer le core pour
invalider les caches.

## Vérifier une contribution

```bash
npm ci                 # Node ≥ 24 (.nvmrc) ; dépendances exactes, un seul package-lock.json
npm run typecheck      # tsc (core, hôte d'outils, paquets) et vue-tsc (interface)
npm run lint           # ESLint
npm run build          # bundles du core, de l'hôte d'outils et du frontend
npm run format         # applique Prettier (npm run format:check pour vérifier)
```

Les tests vivent dans le dépôt de développement des mainteneurs, pas dans ce
dépôt : ils passent la suite complète (TypeScript, Python, parcours réels dans
Chromium) avant de fusionner une pull request. Décrivez dans la pull request
ce que vous avez essayé à la main (écran, commande, cas limite).

Python restant (RAG, elpis-tools, `deploy/`) : `venv/bin/ruff check .`
(règles dans `pyproject.toml`, ruff est installé par `requirements.txt`).

## TypeScript

Espace de travail npm à la racine : applications dans `apps/` (`apps/core` :
main et admin ; `apps/toolhost` : hôte d'outils), paquets partagés dans
`packages/` (`@elpis/auth`, `bac`, `commun`, `config`, `contracts`, `db`,
`fichiers`, `http`, `mcp`, `outils-mcp`, `securite`…), interface dans
`frontend/` (workspace `@elpis/web`).

- **Code** : en-tête `// SPDX-License-Identifier: MIT` puis `/** chemin — rôle */` ;
  commentaires réduits au maximum : une ligne au plus par fonction, en français,
  sans trace d'audit (le pourquoi long va dans le message de commit ou `docs/`) ;
  ESM, TypeScript strict, syntaxe effaçable seulement (ni `enum` ni `namespace`),
  `import type` pour les types ; aucune promesse flottante (lint).
- **Contrats partagés** : `@elpis/contracts` (schémas Zod des routes et du flux ;
  `npm run generer -w @elpis/contracts` écrit `.d.ts` et schémas JSON dans `dist/`).
- **JSON** : `@elpis/commun` écrit comme `json.dumps` de Python (`pyJsonDumps`)
  là où la forme sur le disque ou sur le réseau est partagée avec le Python
  restant ; `JSON.stringify` n'écrit ni ne trie comme Python.
- **Dépendances** : versions exactes (`.npmrc`) ; licences permissives (MIT,
  Apache-2.0, ISC, BSD) pour tout ce qui est livré, MPL-2.0 ou BlueOak admis
  pour les seuls outils de développement non distribués ; le build refuse un
  paquet livré hors de la politique de `migration-kit/deps.map.json`. npm 11
  bloque les scripts d'installation non approuvés : `npm install-scripts approve
  <paquet>` après relecture (champ `allowScripts`). Une dépendance d'exécution
  est inscrite dans `THIRD_PARTY_NOTICES.md` (`npm run licences` réécrit
  `LICENSES/npm-*.txt`).

## Fichiers générés

- `frontend/css/style.tailwind.css` : après avoir ajouté des classes
  utilitaires dans un SFC, un module TS ou un gabarit (`.vue`, `.ts`, `.html`,
  `.js`), `node tools/generate_tailwind_css.mjs` (Playwright requis, résolu dans
  `browser-service/node_modules` ou `ELPIS_NODE_MODULES`). Ne jamais l'éditer à
  la main.
- `frontend/src/features/admin/champs.gen.ts` est généré depuis les pages de la
  console (`frontend/src/components/admin/Page*.vue`) : après avoir ajouté ou
  renommé un réglage (`data-field`), `node frontend/champs-admin.mts`.
- `frontend/dist/`, `apps/core/dist/`, `apps/toolhost/dist/` : produits par
  `npm run build`, jamais versionnés.

## Conventions

**Langue et interface**

- Interface en **français**, vouvoiement, libellés d'un ou deux mots ; le
  détail va dans `title`, le texte indicatif ou la documentation.
- **Aucun emoji** dans l'interface (✓ ✗ ⚠ tolérés) ; icônes Phosphor.
- Les prompts système (`system_prompts/*.md`) sont en **anglais**, sans emoji,
  dans leurs budgets de caractères.

**Code Python** (services restants : RAG, elpis-tools, desktop-agent, agent du bac, deploy)

- Nouveau fichier source : première ligne `# SPDX-License-Identifier: MIT`,
  puis une docstring d'en-tête « chemin — rôle » sur une ligne.
- Commentaires en français, au présent, une ligne au plus par fonction : la
  règle, sa raison. Pas de trace d'audit dans le code (date de constat,
  identifiant de lot, récit de l'ancien comportement) : l'historique va dans le
  message de commit.
- `from __future__ import annotations` ; journal via
  `logging.getLogger("uvicorn.error")`, messages préfixés `[domaine]`.
- Erreurs : `with swallow("domaine.action"):`
  (`shared_infra/observability/tracing.py`) plutôt qu'un `except Exception: pass` ;
  ne jamais avaler `BaseException` ni `asyncio.CancelledError` ; un `except`
  large volontaire porte `# noqa: BLE001`.
- Réglage lu par le Python restant : constante dans `shared_infra/config.py`
  (priorité : variable d'environnement > `config.json` > défaut), documentée
  dans `docs/configuration.md`.

**Base de données**

- SQL **portable** SQLite / PostgreSQL : passer par
  `packages/db/src/dialecte.ts` pour ce qui diffère (`shared_infra/db/_dialect.py`
  côté Python restant).
- Schéma : `packages/db/src/schema.ts` (tables dans `schema.gen.ts`) ; nouvelle
  table ou colonne = migration ajoutée à `MIGRATIONS_TS`
  (`packages/db/src/init.ts`) ; pas de DDL hors de `packages/db` (seule
  exception : le transfert de base, `apps/core/src/ops/transfert.ts`).
- Python : tout `db()` est suivi de son `close()` (ou `with db_conn()`).

**Organisation**

- Core TS : routes HTTP par famille (`apps/core/src/familles/`, liste dans
  `apps/core/src/familles.ts`), montées selon `APP_MODE` ; la logique d'un sujet
  vit dans son dossier de `apps/core/src/` ou dans un paquet de `packages/`
  partagé avec l'hôte d'outils.
- `shared_infra/` (Python restant) est rangé **par famille** (accounts, chat,
  db, llm, mcp, observability, sandbox, security…).
- Routes d'administration : familles `admin-*` de `apps/core/src/familles/`
  (process admin seulement) ; rôle vérifié par `exigerRole`
  (`packages/auth/src/garde.ts`). `is_admin` vaut 0, 1 (admin) ou 2
  (modérateur) : toujours comparer la valeur (`Number(is_admin) === 1`), jamais
  un simple test de vérité.
- Console d'administration : une page = une entrée du registre
  `frontend/src/features/admin/registre.ts` (titre, lien `#page`, chargeurs,
  blocs enregistrés) et un SFC `frontend/src/components/admin/Page*.vue` ; un
  champ de `config.json` porte `data-field="config:chemin"` et part par
  `PATCH /api/admin/config` avec la barre d'enregistrement de sa page.

**Frontend**

- Build Vite : `frontend/` est le workspace `@elpis/web` ; `npm run build:web`
  écrit `frontend/dist/` (à relancer après toute modification de
  `frontend/src`). Entrées `src/entries/main.ts` (chat, éditeur, routines…) et
  `admin.ts` (console), précédées de `diagnostic.ts` (fenêtre d'erreur si rien
  n'est monté), posées par `<!-- @entree … -->`, que
  `apps/core/src/interface/pages.ts` remplace par les balises du manifeste
  (noms hachés, cache long).
- Rangement de `frontend/src/` : `platform/` (client HTTP et `ApiResult`,
  lecteur NDJSON), `features/<domaine>/` (logique et état en TS strict : auth,
  chat, editor, terminal, admin, reglages, routines, studio, images, voix,
  mascotte, skills, code), `components/<domaine>/` (SFC
  `<script setup lang="ts">`, contrôlés par `vue-tsc`), `utils/` et `modeles/`
  (fonctions pures), `app/racine/` (racine : état partagé, session, montage des
  modules, clavier).
- Réseau : JSON reçu en `unknown` et validé aux frontières par les schémas Zod
  de `@elpis/contracts` ; erreurs `{"detail"}` et 422 décodées par `ApiResult` ;
  flux de chat typé par `EvenementFlux`, reducer exhaustif (un événement inconnu
  est journalisé, jamais appliqué). Un cast n'est pas une validation. Nouvelle
  route consommée = son schéma dans `packages/contracts`.
- État : un domaine par fonctionnalité, transmis par injection typée (clé
  `provide` / `inject`, ex. `features/chat/page/domaines.ts`,
  `features/editor/domaine.ts`), clés absentes nommées au montage ; ni `$root`,
  ni store global. Monaco, xterm et objets tiers en `shallowRef`/`markRaw`.
- Racines : `src/components/racine/App.vue` (chat) et `AppConsole.vue`
  (console), sur `creerRacine()` (`src/app/racine/racine.ts`) ; elles
  fournissent les domaines injectés. `index.html` et `admin.html` ne sont que
  des coquilles (`<div id="app">`) : aucun gabarit dans le DOM, aucun script
  classique. Le build embarque le runtime Vue sans compilateur de gabarits
  (alias `vue.runtime.esm-bundler.js` de `vite.config.mts`) et les pages portent
  une CSP stricte (`security.csp`) : tout gabarit est un SFC précompilé.
- Vendor : paquets npm aux versions figées, aucun CDN (production hors ligne).
  Monaco (ESM et workers) et xterm sont des chunks chargés à l'ouverture de
  l'éditeur ou du terminal ; Mermaid, ECharts, Chart.js et highlight.js sont
  leurs fichiers de distribution, copiés par Vite et chargés à la demande
  (`frontend/vendor.config.mts`, `src/platform/vendor.ts`).
- HTML rendu (Markdown, SVG, aperçus) : toujours purifié par DOMPurify ; pas de
  `v-html` sur du contenu non purifié.
- Jamais de nom de classe Tailwind composé à l'exécution (le générateur ne le
  verrait pas) ; jamais de classe de couleur sur `<body>` ; couleurs par
  jetons (DESIGN.md).
- Toute transition Vue nommée est déclarée en CSS **et** dans le bloc
  `prefers-reduced-motion`.

**Dépendances et licences**

- Pas de dépendance copyleft forte (GPL, AGPL) dans le cœur : optionnelle
  seulement (`requirements-agpl-optional.txt`).
- Tout paquet ajouté à un `requirements*.txt` ou livré par npm est inscrit dans
  `THIRD_PARTY_NOTICES.md`.

## Invariants à ne pas casser

Le détail et le pourquoi sont dans [ARCHITECTURE.md](ARCHITECTURE.md). En
résumé, une modification ne doit jamais :

- monter une route de la console (`/api/admin/*`) dans le process main : la
  séparation se fait au montage, par `APP_MODE` ;
- faire varier la tête système entre deux itérations (un seul `role: system`,
  ordre figé, même jeu d'outils) : le cache de préfixe du moteur en dépend ;
- compter des tokens ailleurs que dans `apps/core/src/contexte/tokens.ts`
  (requête `/tokenize` ou `/apply-template`, `new URL("tokenize", base)`
  compris), ni redéfinir le ratio chars/token (`@elpis/config`) ;
- séparer un appel d'outil de son résultat, ni modifier les messages de
  travail pendant l'élagage ;
- faire lever l'exécution d'un outil (erreur rendue en JSON), ni rejouer un
  appel MCP qui a peut-être agi ;
- garder dans une variable de module un état qui doit être partagé entre
  process (main, admin, hôte d'outils, elpis-tools) : passer par la base ou
  le canal interne ;
- faire passer une annulation par les événements système : un Stop passe par
  l'AbortSignal du tour ;
- lire un réglage modifiable depuis la console dans une constante figée à
  l'import (clé de `config` rechargée par `packages/config/src/vivant.ts`,
  `liveConfigValue()`, `maxRecentChats()`…) : règle de lint
  `elpis/reglages-vifs` ;
- réorganiser le flux de chat (`apps/core/src/familles/chat.ts` et
  `apps/core/src/tour/`) sans relire `apps/core/src/tour/README.md` : ses
  invariants (verrou, annulation, enregistrement) et l'ordre des événements
  NDJSON ;
- toucher au contenu de `/work` depuis l'hôte : tout passe par l'agent du
  bac (`@elpis/bac`, `@elpis/fichiers`) ; un `open`, `readdir`, `rm` ou
  `chmod` de l'hôte sur un chemin suivrait les liens que le conteneur peut
  poser à tout moment. Les seules exceptions (création de `P/work`,
  occupation, dernière activité, suppression d'un compte) passent par les
  primitives à descripteurs de `@elpis/securite` (`confinement.ts`). Voir
  aussi [docs/sandbox-gateway.md](docs/sandbox-gateway.md).

## Git et pull requests

- Une pull request = un sujet ; décrire l'avant et l'après.
- Messages de commit en français, sujet `Domaine : résumé` (espace avant les
  deux-points : `Base :`, `Chat :`, `Sandbox :`, `Docs :`…), corps en puces.
- Ne jamais versionner : `venv/`, `node/`, `node_modules/`, `config.json*`,
  `.env`, `mcp.json`, `rag_app/rag_config.json`, `user_*/` (base, secrets de
  session, jetons, mot de passe de la base), `logs/`, `dist/`, les archives.
- Publication hors ligne : `./make_release.sh [VERSION]` produit
  `dist/elpis-offline-<version>-<arch>/` (et son `.tar`), installé par
  `./install.sh --offline DOSSIER` ; la version vient de `pyproject.toml`.
