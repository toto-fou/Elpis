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
| un outil de l'agent | famille native : `apps/toolhost/src/mcp/` (+ `packages/outils-mcp`) ; famille Office : `apps/toolhost/src/mcp/office/` (hôte, fichiers et conversions) et le moteur Python `office/elpis_office/` |
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

- Python restant (RAG, moteur Office, `deploy/`) : `venv/bin/ruff check .`.
- Formatage : `npm run format` (Prettier).
- Après avoir ajouté des classes utilitaires Tailwind :
  `node tools/generate_tailwind_css.mjs`.
- Une pull request = un sujet ; décrivez le comportement avant/après et ce
  que vous avez essayé à la main.
- Pas de nouvelle dépendance sous licence copyleft forte (GPL/AGPL) dans le
  cœur : elle doit rester optionnelle (voir `requirements-agpl-optional.txt`).
  Toute dépendance livrée est inscrite dans `THIRD_PARTY_NOTICES.md`.
<!-- REUSE-IgnoreStart -->
- Nouveaux fichiers source : en-tête `SPDX-License-Identifier: MIT`.
<!-- REUSE-IgnoreEnd -->
- Signez vos commits (`git commit -s`) : voir « Certificat d'origine » ci-dessous.

## Certificat d'origine (DCO)

Chaque commit porte une ligne `Signed-off-by: Prénom Nom <identité Git>`,
ajoutée par `git commit -s`. Elle atteste le
[Developer Certificate of Origin 1.1](https://developercertificate.org) : vous
avez écrit la contribution, ou vous avez le droit de la publier sous la licence
MIT du projet. Pas de CLA. Oubli : `git commit --amend -s` (dernier commit) ou
`git rebase --signoff` (plusieurs). Le sign-off n'est pas encore vérifié en CI.

Le texte du DCO fait foi en anglais ; il n'est pas recopié ici.

## Code assisté par IA

Vous pouvez utiliser un assistant de code (Claude Code, Copilot, etc.), sous
ces conditions :

- Vous restez l'**auteur** et le **responsable** de la contribution : le
  sign-off (DCO) est le vôtre, jamais celui de l'outil.
- Vous **relisez et comprenez** chaque ligne proposée, et vous l'avez essayée
  vous-même ; une pull request que son auteur ne sait pas expliquer est refusée.
- Vous **garantissez les droits** sur le résultat : pas de code généré qui
  reproduit du code tiers sous une licence incompatible avec la licence MIT
  (copyleft, licence inconnue, source sans licence), pas de texte ou d'image
  copiés d'une œuvre protégée, pas de secret ni de donnée personnelle dans les
  invites.
- Dites-le dans la description de la pull request lorsqu'une part importante a
  été générée (nom de l'outil, étendue) ; une trace `Co-Authored-By` dans le
  message de commit est bienvenue.
- Les mêmes règles valent pour les images, les icônes et les textes.

## Code de conduite

La participation au projet suppose le respect du
[code de conduite](CODE_OF_CONDUCT.md) (Contributor Covenant 2.1).

## Licence

En contribuant, vous acceptez que votre contribution soit distribuée sous
licence MIT (voir [LICENSE](LICENSE)).
