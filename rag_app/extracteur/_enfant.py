# SPDX-License-Identifier: MIT
# rag_app/extracteur/_enfant.py — point d'entrée du processus enfant : limites système, protocole NDJSON, travail.
from __future__ import annotations

import json
import os
import sys
import time


def _limites(lim: dict) -> None:
    import resource
    memoire = int(lim["memoire_mo"]) * 1024 * 1024
    cpu = int(lim["cpu_s"])
    resource.setrlimit(resource.RLIMIT_AS, (memoire, memoire))
    resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu + 5))
    resource.setrlimit(resource.RLIMIT_FSIZE, (4 * 1024 * 1024, 4 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def principal() -> None:
    sortie = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
    os.dup2(os.open(os.devnull, os.O_WRONLY), 1)
    dernier = [0.0]

    def envoyer(objet: dict) -> None:
        sortie.write(json.dumps(objet, ensure_ascii=False, separators=(",", ":")) + "\n")

    def progres(fait: int, total: int) -> None:
        maintenant = time.monotonic()
        if fait >= total or maintenant - dernier[0] >= 0.2:
            dernier[0] = maintenant
            envoyer({"type": "progress", "done": int(fait), "total": int(total)})

    job = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    _limites(job["limites"])
    from .erreurs import ErreurExtracteur
    try:
        from .travaux import TRAVAUX
        envoyer({"type": "result", **TRAVAUX[job["type"]](job, progres)})
    except ErreurExtracteur as exc:
        envoyer({"type": "error", "code": exc.code, "message": exc.message, "http": exc.http})
    except MemoryError:
        envoyer({"type": "error", "code": "too_large", "message": "Mémoire insuffisante pour ce fichier.", "http": 413})
    except Exception as exc:  # noqa: BLE001 — le parent ne doit recevoir qu'une erreur typée
        envoyer({"type": "error", "code": "corrupt", "message": f"Analyse impossible ({type(exc).__name__}).",
                 "http": 422})
    sortie.flush()
