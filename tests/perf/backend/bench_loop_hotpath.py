# SPDX-License-Identifier: MIT
"""Microbench des chemins CHAUDS de la boucle tool-calling (par itération).

À CHAQUE itération de run_chat_multi_mcp, le backend refait :
    prune_old_vision_frames → enforce_context_budget
(+ la sélection d'élagage FIN de tour ``select_prune_keys``)
(la jauge, elle, lit l'usage réel du serveur en fin de requête — zéro coût).
Ce script mesure l'overhead PUR de ces fonctions (le réseau /tokenize est
monkeypatché par un fake instantané, le cache LRU est purgé entre variantes)
sur des historiques synthétiques de 50 / 200 / 500 messages.

Usage :
    venv/bin/python tests/perf/backend/bench_loop_hotpath.py --label baseline-X
    # → JSON dans tests/perf/results/backend/<label>__loop_hotpath.json

Comparer avant/après une optimisation : lancer avec deux labels et diff des
médianes (les entrées sont déterministes, pas de réseau, pas de LLM).
"""
import argparse
import asyncio
import json
import statistics
import sys
import time
from pathlib import Path

# Lançable depuis n'importe quel CWD : la racine du repo dans sys.path.
_REPO = Path(__file__).resolve().parents[3]
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))

RESULTS_DIR = Path(__file__).resolve().parent.parent / "results" / "backend"

SIZES = (50, 200, 500)
REPEATS = 15


def build_history(n_msgs: int) -> list:
    """Historique agentic synthétique déterministe : system + cycles
    user / assistant(tool_calls) / tool / assistant, contenus ~600-900 chars
    (mix texte + arguments d'outils, représentatif d'un run outillé)."""
    msgs = [{"role": "system", "content": "prompt système " + "s" * 400}]
    i = 0
    while len(msgs) < n_msgs:
        mod = i % 4
        if mod == 0:
            msgs.append({"role": "user", "content": f"question {i} " + "u" * 600})
        elif mod == 1:
            msgs.append({
                "role": "assistant", "content": None,
                "tool_calls": [{
                    "id": f"call_{i}", "type": "function",
                    "function": {"name": "read_file",
                                 "arguments": json.dumps({"path": f"src/mod_{i}.py", "extra": "a" * 300})},
                }],
            })
        elif mod == 2:
            msgs.append({"role": "tool", "tool_call_id": f"call_{i - 1}",
                         "content": json.dumps({"ok": True, "content": "r" * 800})})
        else:
            msgs.append({"role": "assistant", "content": f"analyse {i} " + "a" * 500})
        i += 1
    return msgs


def build_tools_payload(n_tools: int = 24) -> list:
    return [{
        "type": "function",
        "function": {
            "name": f"tool_{k}",
            "description": "outil synthétique du bench " + "d" * 120,
            "parameters": {"type": "object", "properties": {
                "path": {"type": "string", "description": "chemin cible"},
                "query": {"type": "string"},
            }},
        },
    } for k in range(n_tools)]


async def bench_one(fn_name: str, coro_factory, repeats: int = REPEATS) -> dict:
    lats = []
    for _ in range(repeats):
        t0 = time.perf_counter()
        r = coro_factory()
        if asyncio.iscoroutine(r):
            await r
        lats.append((time.perf_counter() - t0) * 1000.0)
    return {
        "median_ms": round(statistics.median(lats), 3),
        "p95_ms":    round(sorted(lats)[min(len(lats) - 1, int(len(lats) * 0.95))], 3),
        "min_ms":    round(min(lats), 3),
    }


async def main(label: str) -> None:
    import llm_core._llama_http as lh
    from llm_core.context import pruning, tokens

    # /tokenize instantané : ~len(text)/3.3, PAS de réseau, PAS de cache LRU
    # (on veut le coût de NOTRE code : sérialisation, gather, boucles).
    async def _fake_exact(text, model_id=None, timeout=None, **kw):
        return int(len(text) / 3.3)

    # Substitué là où il est lu : ``context.tokens`` (comptage des messages et
    # du schéma d'outils) et ``_llama_http`` (comptages du compresseur).
    orig_tokens = tokens.count_tokens_exact
    tokens.count_tokens_exact = _fake_exact
    orig_lh = getattr(lh, "count_tokens_exact", None)
    lh.count_tokens_exact = _fake_exact

    tools_payload = build_tools_payload()
    out = {"label": label, "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
           "repeats": REPEATS, "results": {}}
    try:
        for n in SIZES:
            msgs = build_history(n)
            cell = {}
            cell["compact_working_messages"] = await bench_one(
                "prune_select", lambda: pruning.select_prune_keys(msgs, ctx_size=32768))  # noqa: B023 (même itération)
            cell["prune_old_vision_frames"] = await bench_one(
                "prune", lambda: pruning.prune_old_vision_frames(msgs))  # noqa: B023 (même itération)
            cell["enforce_context_budget"] = await bench_one(
                "budget", lambda: pruning.enforce_context_budget(list(msgs), 32768, None, 4096))  # noqa: B023 (même itération)
            cell["count_messages_tokens_per_msg"] = await bench_one(
                "count", lambda: tokens.count_messages_tokens_per_msg(msgs, None))  # noqa: B023 (même itération)
            # Le schéma tools est compté UNE fois par run (surcoût fixe partagé
            # pré-porte/porte/budget) — bench du coût unitaire de ce comptage.
            # (Les estimateurs de jauge ont disparu : la jauge lit l'usage réel
            # du serveur en fin de requête, zéro travail côté boucle.)
            cell["count_tools_payload_tokens"] = await bench_one(
                "count_tools", lambda: tokens.count_tools_tokens_ex(tools_payload, None))
            out["results"][str(n)] = cell
            print(f"— {n} messages —")
            for k, v in cell.items():
                print(f"   {k:34s} médiane {v['median_ms']:8.3f} ms   p95 {v['p95_ms']:8.3f} ms")
    finally:
        tokens.count_tokens_exact = orig_tokens
        if orig_lh is not None:
            lh.count_tokens_exact = orig_lh

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    path = RESULTS_DIR / f"{label}__loop_hotpath.json"
    path.write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(f"\nRésultats : {path}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True, help="ex: baseline-20260704")
    args = ap.parse_args()
    asyncio.run(main(args.label))
