---
name: robotframework
description: Automatisation de tests Robot Framework — écrire une suite .robot (sections, keywords, resources), lancer une suite et relancer les échecs, lire log.html et output.xml, automatiser un parcours web avec SeleniumLibrary sans tests flaky
tags: [robotframework, robot, tests, automatisation, qa, selenium, keywords, suite, rpa]
domain: robotframework
compatibility: python3 + pip (robotframework ; robotframework-seleniumlibrary et un navigateur pour le web)
---

# Robot Framework — package de procédures d'automatisation de tests

Package des procédures Robot Framework. Chaque opération est un sous-skill
autonome : charger UNIQUEMENT celui qui correspond à la tâche, via `skill_get`.

| Sous-skill (`skill_get("robotframework/…")`) | Quand l'utiliser |
|---|---|
| `robotframework/robotframework-write-tests` | écrire ou structurer une suite `.robot` : sections, keywords maison, variables, resources, tags |
| `robotframework/robotframework-run-and-debug` | lancer une suite (par tag, avec variables), relancer uniquement les échecs, lire les résultats, déboguer |
| `robotframework/robotframework-selenium-web` | automatiser un parcours navigateur avec SeleniumLibrary : locators, attentes explicites, anti-flaky, headless |

## Pré-requis communs

- Python 3.8+ et `pip`. Installation de base :

  ```bash
  pip install robotframework            # noyau
  pip install robotframework-seleniumlibrary   # seulement pour le web
  robot --version
  ```

- Une suite = un fichier `.robot` (ou un dossier de fichiers `.robot`).
  Toujours lancer avec `-d results/` pour ne pas polluer le dossier courant.

## Ordre typique

Écrire la suite (`robotframework-write-tests`) → la lancer et lire les
résultats (`robotframework-run-and-debug`) → si le sujet est une interface
web, les patterns SeleniumLibrary vivent dans `robotframework-selenium-web`.
