# AGENTS.md

Consignes pour les agents de code (et les humains) qui modifient Elpis :
commandes vérifiées, conventions que les tests imposent, pièges connus.
Pour la carte du code, lire [ARCHITECTURE.md](ARCHITECTURE.md) ; pour l'interface,
[PRODUCT.md](PRODUCT.md) et [DESIGN.md](DESIGN.md).

## Le projet en bref

Assistant LLM **auto-hébergé** : chat agentique (outils MCP, sous-agents,
mémoire, skills), éditeur de code sur une sandbox Docker par utilisateur,
routines, service RAG, console d'administration. Backend Python (FastAPI,
Gunicorn), frontend Vue 3 **sans étape de build**, inférence `llama-server`
(llama.cpp) ou tout moteur compatible OpenAI. Interface et documentation en
français. Licence MIT.

`docs/architecture.md` est détaillé ; en cas de doute, le code fait foi, puis
ARCHITECTURE.md.

## Installer et lancer

```bash
./install.sh                                  # Debian 12/13, Ubuntu 24.04 ; venv dans ./venv
venv/bin/pip install -r requirements-dev.txt  # une fois : pytest, pytest-asyncio, pytest-xdist
./elpis start | stop | restart | status       # tous les services
./elpis logs [qdrant|rag|toolhost|main|admin|browser] [-f]
./elpis doctor                                # diagnostic
./elpis db info | check CIBLE | transfer --to CIBLE | use sqlite|CIBLE
```

Lancement manuel (depuis la racine : le serveur lit `frontend/` relativement
au répertoire courant) :

```bash
LOCAL_MCP_TRANSPORT=streamable-http venv/bin/python -m toolhost          # outils MCP :8765
APP_MODE=main LOCAL_MCP_URL=http://127.0.0.1:8765/mcp APP_WORKERS=1 \
  venv/bin/gunicorn -c server/gunicorn_conf.py server.app:app            # chat :8001
APP_MODE=admin venv/bin/gunicorn -c server/gunicorn_admin_conf.py server.admin_app:app  # console :8002
```

Ports par défaut : main 8001, admin 8002, outils MCP (`toolhost`) 8765,
RAG 8000, Qdrant 6333, navigateur 3000, `llama-server` 8080. La configuration
d'instance est `config.json` à la racine (non versionné ; modèle :
`config.example.json`). Les versions `?v=` des ressources sont réécrites au
`BUILD_ID` du process : redémarrer Gunicorn pour invalider les caches.

## Tests

```bash
venv/bin/pytest                           # toute la suite, en parallèle (-n auto)
venv/bin/pytest -n0 tests/db              # en série
venv/bin/pytest -o addopts="" --pdb tests/x.py::test_y   # avec pdb
node tests/frontend/<fichier>.js          # un test unitaire front (sans dépendance)
```

- Toujours le **pytest du venv** : sans `pytest-xdist`, l'option `-n auto` de
  `pytest.ini` échoue.
- Suite qui semble figée : un `config.json` réel pointe vers un moteur LLM
  injoignable qui ne refuse pas vite. Lancer
  `LLAMA_IP=127.0.0.1 LLAMA_PORT=1 venv/bin/pytest`.
- Les fixtures `autouse` de `tests/conftest.py` isolent la base (SQLite
  temporaire), les spools, le manifeste MCP : aucun test ne doit écrire dans
  `user_db/`.
- Aucun test n'exige Docker (il est simulé). Moteurs serveur, sur demande :
  `ELPIS_TEST_PG=hôte:port:base:user:mdp` (idem `ELPIS_TEST_MARIADB`,
  `ELPIS_TEST_MYSQL`) pour `tests/db`, ou `ELPIS_TEST_DB=1 APP_DB_BACKEND=postgres …`
  pour toute la suite (les tests `sqlite_only` sont alors ignorés).
- Identifiants de `parametrize` **déterministes** : xdist compare les
  collectes des workers.
- Charges utiles de référence du harnais : `GOLDEN_UPDATE=1 venv/bin/pytest
  tests/llm_core/test_golden_payload.py`, puis relire le diff JSON.
- Tests front : `tests/frontend/test_*.js` (CommonJS) et `*-unit.mjs` (ESM),
  exécutés aussi par `tests/frontend/test_js_units.py` ; les nouveaux tests
  utilisent `tests/frontend/lib/harnais.js`.
- Tests navigateur (Playwright, à la main) : une paire
  `tests/frontend/<x>-server.mjs` (serveur simulé) + `<x>-verify.mjs`, recette
  en tête de chaque fichier, par exemple
  `PERF_PORT=8940 node tests/frontend/tailwind-server.mjs &` puis
  `PERF_PORT=8940 node tests/frontend/tailwind-verify.mjs`. Playwright est
  résolu dans `browser-service/node_modules` (ou `ELPIS_NODE_MODULES`).

## Lint et fichiers générés

- `venv/bin/ruff check .` et `venv/bin/mypy` (règles et périmètre typé dans
  `pyproject.toml`) : la base est propre et la CI (`.github/workflows/ci.yml`)
  les exige, comme la suite de tests. Un `# noqa` porte sa raison ; un bloc
  d'imports dont l'ordre compte est exclu du tri (voir `pyproject.toml`).
- `frontend/css/style.tailwind.css` est **généré** : après avoir ajouté des
  classes utilitaires dans un gabarit ou un script,
  `node tools/generate_tailwind_css.mjs` (Playwright requis, comme ci-dessus).
  Ne jamais l'éditer à la main.
- `frontend/js/admin/_fields.js` est **généré** depuis les gabarits de la
  console : après avoir ajouté ou renommé un réglage (`data-field`),
  `python3 tools/generate_admin_fields.py`
  (`tests/frontend/test_admin_fields_index.py` échoue sinon).

## Conventions

**Langue et interface**

- Interface en **français**, vouvoiement, libellés d'un ou deux mots ; le
  détail va dans `title`, le texte indicatif ou la documentation.
- **Aucun emoji** dans l'interface (✓ ✗ ⚠ tolérés) ; icônes Phosphor.
- Les prompts système (`system_prompts/*.md`) sont en **anglais**, sans emoji,
  dans leurs budgets de caractères (tests dédiés).

**Code Python**

- Nouveau fichier source : première ligne
  `# SPDX-License-Identifier: MIT` (`// …` en JS), puis une docstring
  d'en-tête « chemin — rôle », souvent avec le « pourquoi ».
- Commentaires et docstrings plutôt en français ; justification
  datée (« pourquoi », date du constat) bienvenue.
- `from __future__ import annotations` ; journal via
  `logging.getLogger("uvicorn.error")`, messages préfixés `[domaine]`.
- Erreurs : `with swallow("domaine.action"):`
  (`shared_infra/observability/tracing.py`) plutôt qu'un `except Exception: pass` ;
  ne jamais avaler `BaseException` ni `asyncio.CancelledError` ; un `except`
  large volontaire porte `# noqa: BLE001`.
- Réglage de configuration : constante dans `shared_infra/config.py` sur le
  modèle `_as_str(os.environ.get("APP_…"), _deep_get(_RAW, "section.clé", défaut))`
  (priorité : variable d'environnement > `config.json` > défaut). Un réglage
  modifiable depuis la console se relit à chaud (`live_config_value()`,
  `config_view()`), sinon il n'agit qu'au redémarrage. Le documenter dans
  `docs/configuration.md`.

**Base de données**

- SQL **portable** SQLite / PostgreSQL / MariaDB-MySQL : passer par
  `shared_infra/db/_dialect.py` pour ce qui diffère.
- Tout `db()` est suivi de son `close()` (ou `with db_conn()`).
- Nouvelle table ou colonne : migration dans `shared_infra/db/_migrations/`
  **et** mise à jour de `_schema.py` et `BASELINE_COVERS` ; aucun DDL ailleurs
  (`tests/db/test_schema_reference_2026_09_26.py`).

**Organisation**

- `shared_infra/` est rangé **par famille** (accounts, chat, db, llm, mcp,
  observability, sandbox, security…) : la logique, les routes et le stockage
  d'un sujet vivent ensemble. `routes/` et `db/` ont des listes de fichiers
  fermées (`tests/shared_infra/test_familles_rangement.py`).
- Routes d'administration : `_require_admin` (administrateur) ou
  `_require_staff` (administrateur ou modérateur) de
  `shared_infra/routes/_helpers.py`. `is_admin` vaut 0, 1 (admin) ou 2
  (modérateur) : jamais `not me["is_admin"]` (test dédié).
- Console d'administration : une page = une entrée du registre
  `frontend/js/admin/_registry.js` (titre, lien `#page`, chargeurs, blocs
  enregistrés) ; un champ de `config.json` porte
  `data-field="config:chemin"` et part par `PATCH /api/admin/config` avec la
  barre d'enregistrement de sa page. Vérification :
  `tests/frontend/admin-verify.mjs` (avec `admin-server.mjs`).

**Frontend**

- Pas de build : Vue 3 global, gabarits dans le DOM, assemblés côté serveur
  par `<!-- @include includes/… -->`.
- Pièges des gabarits dans le DOM : pas de fonction immédiatement appelée ni
  de gestionnaire à plusieurs instructions dans un attribut ; les attributs
  SVG en camelCase passent par un objet `v-bind` ; `@click="fn"` reçoit
  l'événement en premier argument.
- Jamais de nom de classe Tailwind composé à l'exécution (le générateur ne le
  verrait pas) ; jamais de classe de couleur sur `<body>` ; couleurs par
  jetons (DESIGN.md).
- Toute transition Vue nommée est déclarée en CSS **et** dans le bloc
  `prefers-reduced-motion` (`tests/shared_infra/test_transitions_declarees.py`).

**Dépendances et licences**

- Pas de dépendance copyleft forte (GPL, AGPL) dans le cœur : optionnelle
  seulement (`requirements-agpl-optional.txt`).
- Tout paquet ajouté à un `requirements*.txt` est inscrit dans
  `THIRD_PARTY_NOTICES.md` (test dédié).

## Invariants à ne pas casser

Le détail et le pourquoi sont dans [ARCHITECTURE.md](ARCHITECTURE.md). En
résumé, une modification ne doit jamais :

- monter une route d'administration dans le process main (la séparation se
  fait au montage, par `APP_MODE`) ;
- faire varier la tête système entre deux itérations (un seul `role: system`,
  ordre figé, même jeu d'outils) : le cache de préfixe du moteur en dépend et
  `tests/llm_core/test_golden_payload.py` le vérifie ;
- compter des tokens ailleurs que dans `llm_core/context/tokens.py` ;
- séparer un appel d'outil de son résultat, ni modifier les messages de
  travail pendant l'élagage ;
- faire lever l'exécution d'un outil (erreur rendue en JSON), ni rejouer un
  appel MCP qui a peut-être agi ;
- garder dans une variable de module un état qui doit être partagé : chaque
  worker a la sienne ; passer par la base, le répertoire d'exécution ou le
  bus fichier ;
- faire passer une annulation par les événements système ;
- lire un réglage modifiable depuis la console dans une constante figée à
  l'import, ni modifier le dictionnaire de `config_view()` ;
- réorganiser le gestionnaire du flux de chat (`chatbot_app/routes/chats.py`)
  sans relire ses invariants d'ordre (annulation, enregistrement, protocole
  NDJSON), documentés en tête du fichier ;
- toucher au contenu de `/work` depuis l'hôte : tout passe par l'agent du
  conteneur (`shared_infra/sandbox/agent_client.py`, `llm_core/tools/_espace.py`,
  `git_ops` pour Git) — un `open`, `os.walk`, `chmod` ou `unlink` de l'hôte
  sur un chemin suivrait les liens que le conteneur peut poser à tout moment.
  `test_frontiere_interception_2026_09_30.py` le vérifie pour les parcours
  principaux et les fonctions de fichiers courantes (pas `stat`, `glob`,
  `tarfile` ni les sous-processus) : ce n'est pas une preuve, relire les
  appels à `_get_work_path` / `sandbox_path` ; exceptions listées dans
  `docs/sandbox-gateway.md`.

## Git et pull requests

- Une pull request = un sujet ; décrire l'avant et l'après.
- Messages de commit en français, sujet `Domaine : résumé` (espace avant les
  deux-points : `Base :`, `Chat :`, `Sandbox :`, `Tests :`, `Docs :`…), corps
  en puces.
- Ne jamais versionner : `venv/`, `node_modules/`, `config.json*`, `.env`,
  `mcp.json`, `rag_app/rag_config.json`, `user_*/` (base, secrets de session,
  jetons, mot de passe de la base), `logs/`, `dist/`, les archives.
- Publication hors ligne : `./make_release.sh [VERSION]` produit
  `dist/elpis-offline-<version>-<arch>/`, installé par
  `./install.sh --offline DOSSIER` ; la version vient de `pyproject.toml`.
