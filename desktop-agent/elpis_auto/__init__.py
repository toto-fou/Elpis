# SPDX-License-Identifier: MIT
"""elpis_auto — runtime des scripts d'automatisation produits par le Studio.

Un script généré est un fichier Python ordinaire :

    from elpis_auto import Session
    s = Session(monitor=0)
    s.launch("calc.exe", wait_window="Calculatrice")
    s.click(auto_id="num7Button", name="Sept", role="button", at=(812, 640))
    s.expect.value(auto_id="CalculatorResults", contains="7")
    raise SystemExit(s.finish())

Il tourne SUR la machine cible, avec le Python de l'agent (``run-script.bat`` /
``run-script.sh``), et parle aux backends de l'agent EN PROCESS — pas de
serveur, pas de réseau, pas d'Elpis. Le rapport (JSON + HTML + captures
d'échec) est écrit dans ``rapports/``.

Ce que le runtime NE fait pas seul : la vision et l'OCR (modèle côté Elpis).
Un script qui en a besoin le déclare (``Session(needs=["vision"])``) et échoue
EXPLICITEMENT au démarrage tant qu'aucun Elpis n'est configuré — jamais en
silence au milieu d'une exécution.
"""
from .session import (  # noqa: F401
    Session, Target, CheckFailed, NeedsVision, StepError, TargetNotFound, __version__,
)

__all__ = ["Session", "Target", "CheckFailed", "NeedsVision", "StepError", "TargetNotFound", "__version__"]
