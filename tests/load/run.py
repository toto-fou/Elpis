#!/usr/bin/env python
# SPDX-License-Identifier: MIT
"""
tests/load/run.py — lance une campagne de charge sur une instance jetable.

    venv/bin/python tests/load/run.py                       # tous les scénarios
    venv/bin/python tests/load/run.py --scenario connexion
    venv/bin/python tests/load/run.py --workers 1 --duree 10
    venv/bin/python tests/load/run.py --etiquette avant-correctif

Les résultats sont écrits dans ``tests/load/resultats/<étiquette>/``. Pour
comparer deux campagnes :

    venv/bin/python tests/load/run.py --comparer avant apres

Code de retour : 1 si un seuil de ``budgets.py`` est dépassé, ce qui permet
d'utiliser le harnais comme garde-fou de non-régression.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tests.load import budgets, instance, metrics, scenarios  # noqa: E402

RESULTATS = Path(__file__).resolve().parent / "resultats"


def _comparer(base: str, cand: str) -> int:
    """Compare deux campagnes, série par série. Rend 1 si l'une régresse."""
    ecarts, regressions = [], 0
    for fichier in sorted((RESULTATS / cand).glob("*.json")):
        avant_f = RESULTATS / base / fichier.name
        if not avant_f.exists():
            print(f"  (absent de « {base} ») {fichier.stem}")
            continue
        avant = {s["nom"]: s for s in json.loads(avant_f.read_text())["series"]}
        apres = json.loads(fichier.read_text())
        print(f"\n── {apres['scenario']}")
        for s in apres["series"]:
            a = avant.get(s["nom"])
            if not a:
                continue
            for cle in ("p50_ms", "p95_ms", "p99_ms"):
                v0, v1 = a[cle], s[cle]
                if v0 <= 0:
                    continue
                delta = 100 * (v1 - v0) / v0
                marque = ""
                if delta > 20 and (v1 - v0) > 5:
                    marque, regressions = "  ⚠ RÉGRESSION", regressions + 1
                elif delta < -20 and (v0 - v1) > 5:
                    marque = "  ✓"
                if abs(delta) > 10:
                    ecarts.append(f"  {s['nom']:<32} {cle:<7} {v0:8.1f} → {v1:8.1f} ms "
                                  f"({delta:+.0f} %){marque}")
        print("\n".join(ecarts) or "  (aucun écart supérieur à 10 %)")
        ecarts = []
    return 1 if regressions else 0


async def _campagne(args) -> int:
    noms = ([args.scenario] if args.scenario else list(scenarios.SCENARIOS))
    inconnus = [n for n in noms if n not in scenarios.SCENARIOS]
    if inconnus:
        print(f"scénario inconnu : {inconnus} — connus : {list(scenarios.SCENARIOS)}")
        return 2

    dossier = RESULTATS / args.etiquette
    dossier.mkdir(parents=True, exist_ok=True)
    base = Path(args.repertoire) if args.repertoire else ROOT / ".load-instance"

    print(f"démarrage d'une instance isolée dans {base} "
          f"({args.workers} worker(s), {args.comptes} comptes)…")
    t0 = time.perf_counter()
    inst = instance.demarrer(base, workers=args.workers, comptes=args.comptes,
                             max_requests=args.max_requests,
                             fichiers_sandbox=args.fichiers_sandbox)
    print(f"  répond en {time.perf_counter() - t0:.1f} s sur {inst.url}")
    regime = instance.attendre_stabilisation(inst)
    print(f"  en régime après {time.perf_counter() - t0:.1f} s — "
          f"RSS {regime['rss_mo']} Mo, {regime['process']} process, "
          f"{regime['fds']} fd, {regime['threads']} threads\n")

    verdicts = []
    try:
        for nom in noms:
            fonction = scenarios.SCENARIOS[nom]
            options = {"duree": args.duree}
            if nom == "evenements":
                options["abonnes"] = args.utilisateurs
            else:
                options["utilisateurs"] = args.utilisateurs
            campagne = await fonction(inst, **options)
            print(metrics.rendre(campagne))
            verdict = budgets.evaluer(campagne)
            verdicts.append(verdict)
            print(budgets.rendre_verdict(verdict))
            print()
            (dossier / f"{nom}.json").write_text(
                json.dumps(campagne.json(), ensure_ascii=False, indent=2), encoding="utf-8")
            # Laisse le système redescendre entre deux scénarios : sinon le
            # suivant mesurerait la queue du précédent.
            await asyncio.sleep(2.0)
    finally:
        inst.arreter()

    print(f"résultats écrits dans {dossier}")
    depassements = [d for v in verdicts for d in v["depassements"]]
    if depassements:
        print(f"\n{len(depassements)} dépassement(s) de budget — voir ci-dessus.")
        return 1
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--scenario", help="un seul scénario (défaut : tous)")
    p.add_argument("--utilisateurs", type=int, default=12)
    p.add_argument("--duree", type=float, default=15.0, help="secondes par scénario")
    p.add_argument("--workers", type=int, default=3, help="workers gunicorn")
    p.add_argument("--comptes", type=int, default=8, help="comptes semés")
    p.add_argument("--fichiers-sandbox", type=int, default=0, dest="fichiers_sandbox",
                   help="fichiers semés par bac à sable (0 = vide) — donne du "
                        "travail réel aux routes disque")
    p.add_argument("--max-requests", type=int, default=None, dest="max_requests",
                   help="surcharge gunicorn max_requests (0 = recyclage désactivé, "
                        "pour isoler son effet)")
    p.add_argument("--etiquette", default=time.strftime("%Y%m%d-%H%M%S"))
    p.add_argument("--repertoire", help="dossier de l'instance jetable")
    p.add_argument("--comparer", nargs=2, metavar=("BASE", "CANDIDAT"))
    args = p.parse_args()

    if args.comparer:
        return _comparer(*args.comparer)
    return asyncio.run(_campagne(args))


if __name__ == "__main__":
    raise SystemExit(main())
