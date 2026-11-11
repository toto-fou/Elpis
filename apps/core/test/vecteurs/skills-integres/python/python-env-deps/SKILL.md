---
name: python-env-deps
description: Créer un environnement virtuel Python propre et gérer les dépendances — venv, activation, pip, requirements.txt vs pyproject.toml, install editable, figer les versions, réparer un venv cassé
tags: [python, venv, pip, requirements, pyproject, dependances, editable, freeze, environnement]
---

# Environnement virtuel Python et dépendances

Isole chaque projet dans son venv, installe ses dépendances de façon
reproductible, et fige les versions qui marchent.

## Pré-requis
- `python3` avec le module `venv` (Debian/Ubuntu : `apt install python3-venv`).

## Voie rapide — script bundlé

```
skill_run_script(name="python/python-env-deps", script="scripts/make_venv.sh")
skill_run_script(name="python/python-env-deps", script="scripts/make_venv.sh",
                 args=["chemin/projet"])
```

Le script s'exécute depuis `/work` : sans argument il travaille à la racine de
ton dossier de travail, sinon dans le sous-dossier passé en argument. Il crée
`.venv/`, met `pip` à niveau, installe ce que le projet déclare
(`requirements.txt`, sinon `pyproject.toml` en editable, avec l'extra `dev` si
présent) et affiche l'état figé (`pip freeze`).

## Étapes (manuel)

1. **Créer et activer le venv** (à la racine du projet) :
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate        # (fish : .venv/bin/activate.fish)
   python -m pip install --upgrade pip
   ```
   Sans activation, préfixer : `.venv/bin/python`, `.venv/bin/pip` — c'est
   équivalent et plus sûr en script.

2. **Installer les dépendances déclarées** :
   ```bash
   pip install -r requirements.txt            # projet à requirements
   pip install -e .                           # projet à pyproject.toml (editable)
   pip install -e ".[dev]"                    # + dépendances de dev (extra)
   ```
   `-e` (editable) fait pointer l'import vers les sources : les modifications
   du code sont prises en compte sans réinstaller.

3. **Ajouter une dépendance** : l'installer, VÉRIFIER que le projet marche,
   puis la déclarer —
   - `requirements.txt` : ajouter `paquet>=2,<3` (borne majeure) ;
   - `pyproject.toml` : dans `[project] dependencies` (ou l'extra `dev`).
   La déclaration est la source de vérité, pas l'état du venv.

4. **Figer pour la reproductibilité** (déploiement, CI) :
   ```bash
   pip freeze > requirements.lock.txt         # versions exactes du venv
   pip install -r requirements.lock.txt       # rejouer À L'IDENTIQUE ailleurs
   ```
   Convention : `requirements.txt` = intentions (bornes souples),
   `requirements.lock.txt` = photographie exacte qui marche.

5. **Réparer un venv douteux** : ne pas soigner, RECRÉER —
   ```bash
   deactivate 2>/dev/null; rm -rf .venv
   # puis étapes 1-2 (30 secondes, zéro état résiduel)
   ```

## Vérification
- `which python` pointe dans `.venv/bin/` ; `python -c "import <paquet>"` passe.
- `pip check` ne signale aucun conflit de versions.

## Pièges
- `sudo pip install` ou pip dans le Python système : casse des outils de l'OS
  et fuit d'un projet à l'autre — toujours un venv par projet.
- Le venv NE SE COMMITE PAS (`.venv/` dans `.gitignore`) ; ce qui se versionne,
  c'est la déclaration (requirements/pyproject) et le lock.
- Un venv créé avec un autre interpréteur (`python3.9` vs `python3.12`) ne se
  « migre » pas : recréer après un changement de version de Python.
- Derrière un proxy/offline : `pip download -d wheels/ -r requirements.txt`
  sur une machine connectée, puis `pip install --no-index --find-links wheels/`.
