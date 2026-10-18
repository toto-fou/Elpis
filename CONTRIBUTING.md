# Contribuer à Elpis / Contributing

Contributions are welcome — issues and pull requests may be written in French
or English.

## Démarrer

```bash
./install.sh    # guidé : installe, configure et démarre
npm ci          # Node ≥ 24 (.nvmrc) : outils de développement TypeScript
```

- Carte du code : [ARCHITECTURE.md](ARCHITECTURE.md) (détails :
  [docs/architecture.md](docs/architecture.md)).
- Conventions, commandes et pièges : [AGENTS.md](AGENTS.md) — écrit pour les
  agents de code, valable pour tout le monde.
- Interface : [PRODUCT.md](PRODUCT.md) et [DESIGN.md](DESIGN.md).

## Où ranger quoi

| Je modifie… | Dossier |
|---|---|
| une route HTTP du core | sa famille dans `apps/core/src/familles/` (montage : `apps/core/src/familles.ts`) ; routes de l'hôte d'outils : `apps/toolhost/src/` |
| la boucle agentique | `apps/core/src/boucle/` (orchestrateur, tour LLM, exécution des outils) |
| le flux d'un tour de chat | `apps/core/src/familles/chat.ts`, `chat-controle.ts` et `apps/core/src/tour/` (admission, exécution, enregistrement, NDJSON) |
| le contexte, l'ordonnancement | `apps/core/src/contexte/`, `apps/core/src/llm/ordonnanceur/` |
| un outil de l'agent | famille native : `apps/toolhost/src/mcp/` (+ `packages/outils-mcp`) ; famille Office, encore en Python : `llm_core/tools/`, servie par elpis-tools (`server/local_mcp_server.py`) |
| une opération sur les fichiers d'une sandbox | côté hôte : `packages/bac`, `packages/fichiers`, `apps/toolhost/src/fichiers/` ; dans le conteneur : l'agent `shared_infra/sandbox/agent/server.py` (API `/v1`) ; jamais un accès direct de l'hôte |
| Git d'une sandbox | `packages/fichiers/src/git.ts` (par l'agent), `relais-git.ts` (réseau), routes `apps/toolhost/src/git/` |
| la base de données | `packages/db/` (schéma, migrations, dialectes) ; `shared_infra/db/` pour le Python restant |
| l'interface | `frontend/src/` : `features/<domaine>/` (logique TS), `components/<domaine>/` (SFC Vue), `entries/` (points d'entrée), `app/racine/` ; styles `frontend/css/`, images `frontend/assets/` |
| l'installation, le lancement | `install.sh`, `elpis`, `deploy/` |
| la documentation d'exploitation | `docs/exploitation.md`, `docs/configuration.md` |

Détail des paquets : [ARCHITECTURE.md](ARCHITECTURE.md) ; conventions et
pièges : [AGENTS.md](AGENTS.md).

## Avant d'ouvrir une pull request

Les tests vivent dans le dépôt de développement des mainteneurs, pas dans ce
dépôt. Avant d'ouvrir une pull request, lancez :

```bash
npm ci
npm run typecheck   # tsc et vue-tsc
npm run lint        # ESLint
npm run build       # core, hôte d'outils et frontend
```

La CI publique (GitHub Actions) lance les mêmes commandes sur Node 24. Les
mainteneurs passent ensuite la suite complète (TypeScript, Python, parcours
réels dans Chromium) avant de fusionner.

- Python restant (RAG, elpis-tools, `deploy/`) : `venv/bin/ruff check .`.
- Formatage : `npm run format` (Prettier).
- Après avoir ajouté des classes utilitaires Tailwind :
  `node tools/generate_tailwind_css.mjs`.
- Une pull request = un sujet ; décrivez le comportement avant/après et ce
  que vous avez essayé à la main.
- Pas de nouvelle dépendance sous licence copyleft forte (GPL/AGPL) dans le
  cœur : elle doit rester optionnelle (voir `requirements-agpl-optional.txt`).
  Toute dépendance livrée est inscrite dans `THIRD_PARTY_NOTICES.md`.
- Nouveaux fichiers source : en-tête `SPDX-License-Identifier: MIT`.

## Licence

En contribuant, vous acceptez que votre contribution soit distribuée sous
licence MIT (voir [LICENSE](LICENSE)).
