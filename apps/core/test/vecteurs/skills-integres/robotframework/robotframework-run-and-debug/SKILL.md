---
name: robotframework-run-and-debug
description: Lancer une suite Robot Framework (par tag, avec variables), relancer uniquement les échecs et fusionner les rapports, lire log.html et output.xml, déboguer un test rouge
tags: [robotframework, robot, rebot, run, rerun, debug, log, output, rapport, tags]
---

# Lancer une suite Robot Framework et déboguer les échecs

Exécute une suite `.robot`, produit les rapports, relance uniquement les cas
en échec, et isole la cause d'un test rouge.

## Pré-requis
- `pip install robotframework` (voir le package **robotframework**).
- Une suite `.robot` (ou un dossier de suites).

## Voie rapide — script bundlé

```
skill_run_script(name="robotframework/robotframework-run-and-debug",
                 script="scripts/run_suite.sh", args=["tests/"])
skill_run_script(name="robotframework/robotframework-run-and-debug",
                 script="scripts/run_suite.sh",
                 args=["tests/", "-i", "smoke", "-v", "URL_BASE:http://localhost:8080"])
skill_run_script(name="robotframework/robotframework-run-and-debug",
                 script="scripts/run_suite.sh", args=["tests/"],
                 env={"RERUN_FAILED": "1"})
```

Le script s'exécute depuis `/work` (chemins d'`args` relatifs à ton dossier de
travail ; les rapports atterrissent dans `/work/results/`). Il lance `robot`
avec un dossier de résultats propre, relaie tags et variables, et — avec
`env={"RERUN_FAILED": "1"}` — relance les échecs puis fusionne les deux passes
avec `rebot --merge` (verdict final = résultat fusionné).

## Étapes (manuel)

1. **Lancer** avec un dossier de résultats dédié :
   ```bash
   robot -d results tests/                      # toute la suite
   robot -d results -i smoke tests/             # par tag (-i inclut, -e exclut)
   robot -d results -v URL_BASE:http://localhost:8080 tests/   # surcharge une variable
   robot -d results -t "Le Login *" tests/      # par nom de cas (glob)
   ```

2. **Lire les résultats** — trois fichiers dans `results/` :
   - `report.html` : synthèse pass/fail par suite et tag ;
   - `log.html` : LE fichier de debug — arbre keyword par keyword, arguments
     réels, messages, capture au point d'échec ;
   - `output.xml` : données brutes, sert aux relances et à `rebot`.

3. **Relancer uniquement les échecs** puis fusionner :
   ```bash
   robot -d results --output original.xml tests/
   robot -d results --rerunfailed results/original.xml --output rerun.xml tests/
   rebot -d results --merge results/original.xml results/rerun.xml
   ```
   `--merge` remplace le résultat des cas relancés dans le rapport final —
   un cas vert à la 2e passe est compté vert (utile contre les flaky).

4. **Déboguer un cas précis** :
   ```bash
   robot -d results -t "Nom Exact Du Cas" --loglevel TRACE tests/
   ```
   `TRACE` logge arguments et valeurs de retour de CHAQUE keyword dans
   `log.html`. Pour valider sans exécuter : `robot --dryrun` (syntaxe +
   résolution des keywords).

5. **En CI** : `robot --exitonfailure` (stoppe au premier échec) et
   `--nostatusrc` si le pipeline gère lui-même le verdict. Le code retour de
   `robot` = nombre de cas en échec (0 = tout vert, cap à 250).

## Vérification
- `report.html` affiche « All tests passed » ; code retour 0.
- Après un merge de relance : le rapport porte la mention « re-executed ».

## Pièges
- Relancer SANS `--output` séparé écrase `output.xml` de la première passe —
  la relance n'a alors plus la liste des échecs à rejouer.
- `--rerunfailed` sur un `output.xml` sans échec relance… rien (et sort en
  erreur « Collecting failed tests failed ») : tester d'abord le cas nominal.
- Un tag mal orthographié dans `-i` ne lance RIEN et sort en erreur
  « contains no tests matching tag » — vérifier avec `robot --dryrun -i`.
- `log.html` volumineux : `--loglevel TRACE` sur toute une grosse suite peut
  produire des centaines de Mo — réserver TRACE au cas isolé avec `-t`.
