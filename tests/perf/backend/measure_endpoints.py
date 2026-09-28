# SPDX-License-Identifier: MIT
"""Mesure de latence des endpoints pollés + détection de contention.

Technique du canari : pendant qu'on martèle un endpoint cible à concurrence
croissante, un endpoint async léger (/api/public-config) est sondé toutes les
50 ms. Si le p95 du canari sous charge dépasse 3× sa latence à vide, il y a
contention côté serveur (event loop, threadpool anyio ou verrou SQLite).

Les endpoints `def` de FastAPI tournent dans le threadpool anyio (40 threads)
— ils ne bloquent pas l'event loop directement ; ce script mesure donc l'effet
RÉEL de la charge, sans présupposé.

Usage (app démarrée, idéalement avec PYTHONASYNCIODEBUG=1) :
    venv/bin/python tests/perf/backend/measure_endpoints.py --label baseline-X
    # endpoints authentifiés : --cookie "session=..."
"""
import argparse
import asyncio
import json
import statistics
import time
from pathlib import Path

import httpx

DEFAULT_TARGETS = [
    "/api/inbox/count",
    "/api/notifications/unread-count",
    "/api/saved/chats?archived=0",
    "/api/llm/models",
]
CANARY = "/api/public-config"


def pct(vals, p):
    if not vals:
        return 0.0
    s = sorted(vals)
    return s[min(len(s) - 1, int(len(s) * p))]


async def hammer(client, url, conc, n):
    sem = asyncio.Semaphore(conc)
    lats, statuses = [], {}

    async def one():
        async with sem:
            t0 = time.perf_counter()
            try:
                r = await client.get(url)
                statuses[r.status_code] = statuses.get(r.status_code, 0) + 1
            except Exception:
                statuses["err"] = statuses.get("err", 0) + 1
            lats.append((time.perf_counter() - t0) * 1000)

    await asyncio.gather(*[one() for _ in range(n)])
    return lats, statuses


async def canary_probe(client, stop_evt):
    lats = []
    while not stop_evt.is_set():
        t0 = time.perf_counter()
        try:
            await client.get(CANARY)
        except Exception:
            pass
        lats.append((time.perf_counter() - t0) * 1000)
        await asyncio.sleep(0.05)
    return lats


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8001")
    ap.add_argument("--label", required=True)
    ap.add_argument("--cookie", default="")
    ap.add_argument("--targets", nargs="*", default=DEFAULT_TARGETS)
    ap.add_argument("-n", type=int, default=200, help="requêtes par cellule")
    args = ap.parse_args()

    headers = {"Cookie": args.cookie} if args.cookie else {}
    out = {"base": args.base, "label": args.label, "cells": []}
    async with httpx.AsyncClient(base_url=args.base, headers=headers, timeout=30) as client:
        # Latence du canari à vide (référence du ratio).
        base_canary, _ = await hammer(client, CANARY, 1, 50)
        canary_p50 = pct(base_canary, 0.5)
        print(f"canari à vide : p50={canary_p50:.1f}ms")

        for url in args.targets:
            for conc in (1, 10, 50):
                stop = asyncio.Event()
                probe = asyncio.create_task(canary_probe(client, stop))
                lats, statuses = await hammer(client, url, conc, args.n)
                stop.set()
                canary = await probe
                ratio = (pct(canary, 0.95) / canary_p50) if canary_p50 else 0.0
                cell = {
                    "url": url, "conc": conc, "n": args.n, "statuses": statuses,
                    "p50": round(pct(lats, 0.5), 1), "p95": round(pct(lats, 0.95), 1),
                    "p99": round(pct(lats, 0.99), 1), "mean": round(statistics.mean(lats), 1),
                    "canary_p95": round(pct(canary, 0.95), 1),
                    "canary_ratio": round(ratio, 2),
                }
                out["cells"].append(cell)
                flag = "  ⚠ CONTENTION" if ratio > 3 else ""
                print(f"{url} conc={conc:>2}  p50={cell['p50']:>7}ms  p95={cell['p95']:>7}ms  "
                      f"canari×{cell['canary_ratio']}{flag}  {statuses}")

    dest = Path(__file__).resolve().parent.parent / "results" / args.label
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "backend.json").write_text(json.dumps(out, indent=1))
    print(f"→ {dest / 'backend.json'}")


if __name__ == "__main__":
    asyncio.run(main())
