# Feuille de route

Les grandes étapes à venir, sans date. Le détail avance lot par lot dans les
pull requests ; ce qui est livré est dans [CHANGELOG.md](CHANGELOG.md).

## Prochaine version

- Frontière hôte ↔ sandbox durcie ; Git côté serveur dans une prison
  `bubblewrap`.
- Intégration continue : lint, typage, suite complète sur SQLite, PostgreSQL
  et MariaDB.
- Exploitation : `./elpis backup`, `./elpis upgrade`,
  [docs/exploitation.md](docs/exploitation.md).

## Ensuite

- **Contrats d'outils explicites** : une seule description des propriétés
  d'un outil (lecture seule, écriture, réseau, exécution en série).
- **Agent résident dans la sandbox** : fichiers et Git exécutés dans le
  conteneur de l'utilisateur ; l'hôte ne touche plus à son contenu.
- **Observabilité** : trace de chaque tour, relecture d'une exécution.
- **Projets** : un espace par dépôt, `AGENTS.md` comme mémoire du projet.
- **Points de reprise et worktrees** : revenir à un état antérieur d'une
  session, mener plusieurs branches en parallèle.
- **`devcontainer.json`** : l'environnement de la sandbox décrit par le dépôt.
- **Politiques et secrets** : règles pour les actions hors sandbox, rotation
  des secrets.

## Plus tard

- Collaboration entre utilisateurs (projet partagé, passation).

## En continu

- Découpage des plus gros modules, tests de concurrence, périmètre typé
  élargi.
