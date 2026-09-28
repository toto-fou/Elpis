---
name: python-debug-profile
description: Déboguer et profiler du Python — breakpoint et pdb (commandes essentielles), post-mortem, pytest --pdb, logging plutôt que print, lire une traceback chaînée, profiler CPU avec cProfile et mémoire avec tracemalloc
tags: [python, debug, pdb, breakpoint, traceback, logging, profiling, cprofile, tracemalloc, performance]
---

# Déboguer et profiler du code Python

Isole un bug avec le débogueur intégré et trouve où part le temps CPU ou la
mémoire — sans rien installer.

## Pré-requis
- Python 3.9+ ; aucun paquet requis (pdb, cProfile, tracemalloc sont dans la
  bibliothèque standard).

## Voie rapide — profiling CPU (script bundlé)

```
skill_run_script(name="python/python-debug-profile", script="scripts/profile_hotspots.sh",
                 args=["mon_script.py"])
skill_run_script(name="python/python-debug-profile", script="scripts/profile_hotspots.sh",
                 args=["mon_script.py", "--", "--arg-du-script"])
skill_run_script(name="python/python-debug-profile", script="scripts/profile_hotspots.sh",
                 args=["mon_script.py"], env={"TOP": "30", "SORT": "tottime"})
```

Le script s'exécute depuis `/work` (chemins d'`args` relatifs à ton dossier de
travail). Il lance `cProfile`, garde le profil brut (`profile.out`, écrit dans
`/work`) et affiche le top des fonctions par temps cumulé — la première
fonction « à vous » dans ce top est presque toujours le point à optimiser.

## Étapes — débogage

1. **Poser un point d'arrêt** au plus près du symptôme :
   ```python
   breakpoint()        # ouvre pdb ici (désactivable : PYTHONBREAKPOINT=0)
   ```
   Commandes pdb essentielles : `n` (ligne suivante), `s` (entrer dans
   l'appel), `c` (continuer), `l`/`ll` (code), `p expr` (afficher),
   `pp vars(obj)`, `bt` (pile), `u`/`d` (monter/descendre la pile), `q`.

2. **Post-mortem** — inspecter l'état AU MOMENT du crash :
   ```bash
   python -m pdb -c continue mon_script.py     # s'arrête sur l'exception
   pytest --pdb                                # idem au premier test rouge
   ```

3. **Lire la traceback en entier, de BAS en haut** : la dernière ligne donne
   le type et le message ; la première frame « dans votre code » (pas dans
   une lib) donne le lieu. Les tracebacks chaînées se lisent par blocs :
   `The above exception was the direct cause` = cause racine AU-DESSUS.

4. **Tracer sans s'arrêter — logging, pas print** :
   ```python
   import logging
   logging.basicConfig(level=logging.DEBUG,
                       format="%(asctime)s %(name)s %(levelname)s %(message)s")
   log = logging.getLogger(__name__)
   log.debug("état avant calcul : %s", etat)   # %s paresseux, pas de f-string
   ```
   Un blocage silencieux (deadlock, boucle) : `kill -SIGABRT <pid>` après
   `import faulthandler; faulthandler.enable()` → dump des piles de tous les
   threads.

## Étapes — profiling

5. **CPU** : script bundlé ci-dessus, ou à la main :
   ```bash
   python -m cProfile -o profile.out mon_script.py
   python -c "import pstats; pstats.Stats('profile.out').sort_stats('cumulative').print_stats(20)"
   ```
   `cumulative` = temps fonction + appels internes (où ça se passe) ;
   `tottime` = temps propre (qui brûle réellement le CPU).

6. **Mémoire** : `tracemalloc` compare deux instants :
   ```python
   import tracemalloc
   tracemalloc.start()
   avant = tracemalloc.take_snapshot()
   travail()
   for stat in tracemalloc.take_snapshot().compare_to(avant, "lineno")[:10]:
       print(stat)      # top 10 des lignes qui ont alloué
   ```

7. **Micro-benchmark honnête** (comparer deux implémentations) :
   ```bash
   python -m timeit -s "from module import f" "f(1000)"
   ```

## Vérification
- Le correctif est couvert par un test qui échouait avant (voir
  **python-tests-pytest**).
- Après optimisation : re-profiler — le hotspot visé a disparu du top ET le
  temps total a baissé (sinon c'était le mauvais hotspot).

## Pièges
- Optimiser sans avoir profilé : l'intuition se trompe presque toujours de
  hotspot — mesurer d'abord.
- Des `print` de debug oubliés partent en prod ; `log.debug` gated par le
  niveau ne coûte rien et reste.
- `breakpoint()` commité bloque la CI (stdin fermé) — grep avant commit ;
  en garde-fou : `PYTHONBREAKPOINT=0` dans l'environnement CI.
- Profiler un run trop court (< 1 s) : le bruit domine — profiler un volume
  représentatif ou boucler le travail.
