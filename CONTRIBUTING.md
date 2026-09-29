# Contribuer à Elpis / Contributing

Contributions are welcome — issues and pull requests may be written in French
or English.

## Démarrer

```bash
./install.sh    # guidé : installe, configure et démarre
```

- Carte du code : [ARCHITECTURE.md](ARCHITECTURE.md) (détails :
  [docs/architecture.md](docs/architecture.md)).
- Conventions, commandes et pièges : [AGENTS.md](AGENTS.md) — écrit pour les
  agents de code, valable pour tout le monde.
- Interface : [PRODUCT.md](PRODUCT.md) et [DESIGN.md](DESIGN.md).

## Avant d'ouvrir une pull request

- Tests Python : `venv/bin/pip install -r requirements-dev.txt` une fois, puis `venv/bin/pytest` (le pytest du venv, pas celui du PATH). La suite tourne en parallèle (`-n auto`) ; `venv/bin/pytest -n0` pour la lancer en série.
- Tests unitaires front : `node tests/frontend/<fichier>.js` (aussi lancés
  par pytest).
- Lint et typage : `venv/bin/ruff check .` et `venv/bin/mypy`.
- La CI (GitHub Actions) rejoue tout cela sur Python 3.11 et 3.13, puis la
  suite complète sur PostgreSQL et MariaDB.
- Après avoir ajouté des classes utilitaires Tailwind :
  `node tools/generate_tailwind_css.mjs`.
- Une pull request = un sujet ; décrivez le comportement avant/après.
- Pas de nouvelle dépendance sous licence copyleft forte (GPL/AGPL) dans le
  cœur : elle doit rester optionnelle (voir `requirements-agpl-optional.txt`).
- Nouveaux fichiers source : en-tête `SPDX-License-Identifier: MIT`.

## Licence

En contribuant, vous acceptez que votre contribution soit distribuée sous
licence MIT (voir [LICENSE](LICENSE)).
