# Tests d'Elpis (dépôt de développement)

Ce dossier, les `test/` des applications et des paquets (`apps/*/test/`,
`packages/*/test/`, `frontend/test/`, `browser-service/test/`), `migration-kit/`
et les configurations Vitest et pytest ne sont pas publiés : le dépôt public
reçoit l'arbre de développement sans eux (`tools/release/exclusions.txt`). Un
contributeur externe y lance `npm ci`, `npm run typecheck`, `npm run lint` et
`npm run build` ; les mainteneurs passent ici la suite complète avant de
fusionner.

## Suite complète

```bash
npm ci                                    # Node ≥ 24 (.nvmrc)
npm run verifier                          # typage, lint, format, build web, Vitest, rejeu des goldens
npx vitest run <chemins>                  # tests ciblés (apps/core, apps/toolhost, packages, frontend)
npx vitest run --project web <chemins>    # frontend seul (happy-dom)
node tests/frontend/reel/run-all.mjs      # parcours réels : core TS réel + Chromium, ports libres
```

- PostgreSQL : `ELPIS_TEST_PG=postgres://elpis:elpis@127.0.0.1:55491/elpis npm run verifier`
  avec un serveur jetable
  (`docker run -d --name pg -e POSTGRES_USER=elpis -e POSTGRES_PASSWORD=elpis -e POSTGRES_DB=elpis -p 55491:5432 postgres:17-alpine`).
  Sans la variable, les tests PostgreSQL sont sautés.
- Les tests qui exigent l'image Docker du bac à sable ou un LLM réel sont
  sautés : c'est attendu.
- Machine partagée et peu dotée : préfixer les commandes lourdes par `lourd`
  (file d'attente), et `NODE_OPTIONS=--max-old-space-size=3072` pour
  `npm run verifier`.
- Parcours réels : `ELPIS_NODE_MODULES` (le `node_modules` qui contient
  Playwright, par exemple celui de `browser-service`) et
  `PLAYWRIGHT_BROWSERS_PATH`. Un écran porté en SFC reçoit son parcours
  (`tests/frontend/reel/*-reel-verify.mjs`).

## Python restant

```bash
venv/bin/pip install -r requirements-dev.txt   # une fois : pytest, pytest-asyncio, pytest-xdist, mypy
venv/bin/pytest                                # toute la suite, en parallèle (-n auto)
venv/bin/pytest -n0 tests/deploy               # en série
venv/bin/pytest -o addopts="" --pdb tests/x.py::test_y
venv/bin/ruff check . && venv/bin/mypy         # lint et typage (pyproject.toml)
```

- Toujours le **pytest du venv** : sans `pytest-xdist`, l'option `-n auto` de
  `pytest.ini` échoue. `LLAMA_IP=127.0.0.1 LLAMA_PORT=1` : aucun moteur LLM.
- Des tests Python lisent les fichiers du front et du déploiement
  (`tests/frontend/*.py`, `tests/deploy/test_install_bootstrap_contract.py`,
  `test_tailwind_arbitrary_utilities.py`, `test_transitions_declarees.py`…) :
  `TMPDIR` court (`mkdir -p /tmp/elpis-v && TMPDIR=/tmp/elpis-v …`),
  sinon « AF_UNIX path too long ».
- `tests/conftest.py` isole la suite de l'instance : `APP_CONFIG_PATH` vise un
  fichier absent, `LLAMA_IP`/`LLAMA_PORT` un port fermé, et `ELPIS_AUDIT_DIR`,
  `APP_DB_PATH`, `APP_SANDBOX_DIR`, `APP_FILE_HISTORY_DIR`, `APP_USER_SKILLS_DIR`,
  `SKILLS_LOCK_PATH` ainsi que le journal applicatif un dossier temporaire : la
  suite n'écrit rien dans `user_db/`, `user_sandboxes/`, `logs/` ni `skills/`.
  Ne jamais lancer pytest dans la copie de production.
- Un `swallow` qui avale un `ImportError`, `NameError` ou `AttributeError` fait
  échouer le test.
- Un test ne lit pas le source pour y chercher du texte : il vérifie un
  comportement (sauf les gardes statiques assumées : Tailwind, transitions,
  frontière Python).
- Substituer une dépendance : patcher le module qui **lit** le nom.
- Le moteur Office (`office/elpis_office`) se teste directement
  (`tests/office/`, `pythonpath = . office` dans `pytest.ini`) ; le worker
  (`python -m elpis_office`) parle sur le descripteur 3 (`test_office_canal.py`).
- Aucun test Python n'exige Docker (simulé) ni de base serveur.
- Identifiants de `parametrize` **déterministes** : xdist compare les
  collectes des workers.
- `tests/test_frontiere_python.py` : aucun import vers un module Python
  disparu (`llm_core`, `server`, elpis-tools…) depuis le Python restant, `deploy/` et les scripts ; la liste des fichiers
  retirés est `tests/frontiere_python_disparus.txt`.

## Goldens, vecteurs et kit de migration

- Goldens de la boucle, du flux de chat et des charges utiles (`tests/goldens/`) :
  produits par l'ancien core Python, figés au tag `python-final`, rejoués par les
  tests TypeScript (`npm run verifier`, étape `goldens:rejeux`) ; une
  réorganisation du code ne doit en changer aucun.
- Vecteurs de parité : une fonction portée pure ou déterministe reçoit des
  vecteurs (`migration-kit/vecteurs/<domaine>.py` écrit
  `packages/…/test/vecteurs/*.json`, figés : `migration-kit/vecteurs/FIGES.md`) ;
  le test TS les rejoue à l'identique.
- `node migration-kit/goldens_check.mjs` : goldens contre le registre
  (`--exiger-entrees`).

## Tests front historiques et bancs

- Tests front : `frontend/test/**` (Vitest, projet `web`, import direct des
  modules TS et montage des SFC) pour tout nouveau test ; restent
  `tests/frontend/test_*.js` (CommonJS) et `*-unit.mjs` (ESM), exécutés par
  `tests/frontend/test_js_units.py` (`tests/frontend/lib/harnais.js`).
- Tests navigateur sur faux serveur (Playwright, à la main, après
  `npm run build:web`) : une paire `tests/frontend/<x>-server.mjs` +
  `<x>-verify.mjs`, recette en tête de chaque fichier, par exemple
  `PERF_PORT=8940 node tests/frontend/tailwind-server.mjs &` puis
  `PERF_PORT=8940 node tests/frontend/tailwind-verify.mjs`.
- Invariants vérifiés par des tests nommés : séparation main/admin
  (`apps/core/test/separation-processus.test.ts`), autorité des tokens
  (`apps/core/test/contexte/tokens-autorite.test.ts`), annulation hors
  événements (`apps/core/test/tour/annulation-hors-evenements.test.ts`), ordre
  du flux (`apps/core/test/tour/goldens-flux-route.test.ts`,
  `readme-flux.test.ts`), réglages vifs (`packages/config/test/reglages-vifs.test.ts`),
  `/work` jamais touché depuis l'hôte (`vitest.garde-travail.mts`).
