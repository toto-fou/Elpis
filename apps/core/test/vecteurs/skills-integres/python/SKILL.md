---
name: python
description: Développement Python — créer un environnement virtuel propre et gérer les dépendances (venv, pip, requirements, pyproject), écrire et lancer des tests pytest (fixtures, parametrize, mocking), déboguer et profiler (pdb, logging, cProfile, tracemalloc)
tags: [python, venv, pip, dependances, pytest, tests, debug, profiling, packaging]
domain: python
compatibility: python3.9+ avec venv et pip
---

# Python — package de procédures de développement

Package des procédures Python. Chaque opération est un sous-skill autonome :
charger UNIQUEMENT celui qui correspond à la tâche, via `skill_get`.

| Sous-skill (`skill_get("python/…")`) | Quand l'utiliser |
|---|---|
| `python/python-env-deps` | créer/réparer un venv, installer et figer les dépendances (requirements, pyproject, editable) |
| `python/python-tests-pytest` | écrire des tests pytest (fixtures, parametrize, monkeypatch, mock) et lancer la suite efficacement |
| `python/python-debug-profile` | déboguer (breakpoint, pdb, post-mortem, logging) et profiler (cProfile, tracemalloc) un code lent ou buggé |

## Pré-requis communs

- Python 3.9+ avec les modules `venv` et `pip` :

  ```bash
  python3 --version
  python3 -m venv --help >/dev/null && echo "venv OK"
  ```

- Règle d'or transversale : JAMAIS de `pip install` dans le Python système
  (ni `sudo pip`) — toujours dans un venv du projet (`python/python-env-deps`).

## Ordre typique

Environnement d'abord (`python-env-deps`) → tests en continu
(`python-tests-pytest`) → et quand un comportement ou une lenteur résiste,
`python-debug-profile`.
