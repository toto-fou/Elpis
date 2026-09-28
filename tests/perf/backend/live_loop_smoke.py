# SPDX-License-Identifier: MIT
"""Smoke RÉEL de run_chat_multi_mcp contre le llama.cpp du LLAMA_URL.

Valide en conditions réelles les deux bascules « réel seul » + « élagage
monotone » ET le watcher :
  - le modèle appelle un outil builtin synthétique (lire_bloc) plusieurs fois ;
  - les events ``kv_cache`` émis sont RÉELS (un par itération, sans phase ni
    est, used = usage.prompt_tokens du serveur) ;
  - le watcher (LLAMA_WATCH) journalise prompts assemblés + outils, et le
    rapport s'imprime à la fin.

Usage :
    PYTHONPATH=. venv/bin/python tests/perf/backend/live_loop_smoke.py \
        [--model Qwen3.5-9B-UD-Q4_K_XL] [--blob 5000] [--blocs 3]
"""
from __future__ import annotations

import argparse
import asyncio
import glob
import json
import os
import sys

os.environ.setdefault("LLAMA_WATCH", "1")
os.environ.setdefault("LLAMA_WATCH_DIR", os.path.join("traces", "llm-watch"))


def blob(n: int, size: int) -> str:
    line = f"bloc {n} — donnees de test repetees pour gonfler le contexte\n"
    return (line * (max(1, size // len(line))))[:size]


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen3.5-9B-UD-Q4_K_XL")
    ap.add_argument("--blob", type=int, default=5000)
    ap.add_argument("--blocs", type=int, default=3)
    ap.add_argument("--max-iter", type=int, default=0,
                    help="force un petit budget d'itérations (test du wrap-up max-steps)")
    args = ap.parse_args()

    from llm_core._chat_with_tools import run_chat_multi_mcp

    async def lire_bloc(fargs):
        n = int((fargs or {}).get("n") or 0)
        return {"bloc": n, "contenu": blob(n, args.blob)}

    async def todowrite(fargs):
        from llm_core.tools.todo_tools import _coerce
        items = _coerce(list((fargs or {}).get("todos") or []))
        remaining = sum(1 for t in items if t["status"] in ("pending", "in_progress"))
        return {"ok": True, "count": len(items), "remaining": remaining,
                "persisted": False, "todos": items}

    builtin_tools = {
        "lire_bloc": {
            "definition": {"type": "function", "function": {
                "name": "lire_bloc",
                "description": "Lit le bloc numero n du corpus de test et renvoie son contenu.",
                "parameters": {"type": "object",
                               "properties": {"n": {"type": "integer",
                                                    "description": "numero du bloc"}},
                               "required": ["n"]},
            }},
            "handler": lire_bloc,
        },
        "todowrite": {
            "definition": {"type": "function", "function": {
                "name": "todowrite",
                "description": ("Create and maintain the task list for the current session. "
                                "Replaces the WHOLE list on every call. Keep exactly ONE item "
                                "in_progress; mark completed the moment a step is verified. "
                                "statuses: pending|in_progress|completed|cancelled."),
                "parameters": {"type": "object", "properties": {
                    "todos": {"type": "array", "items": {"type": "object", "properties": {
                        "content": {"type": "string"},
                        "status": {"type": "string"},
                        "priority": {"type": "string"},
                    }, "required": ["content"]}},
                }, "required": ["todos"]},
            }},
            "handler": todowrite,
        },
    }

    consigne = ("Planifie d'abord avec todowrite (3 etapes : lire bloc 1, lire bloc 2, conclure). "
                "Puis execute : appelle lire_bloc n=1 puis n=2 (UN appel par tour), en mettant a "
                "jour la todo-list avec todowrite apres CHAQUE etape terminee. "
                "Quand tout est completed, reponds exactement: TERMINE")
    messages = [
        {"role": "system", "content": "Tu es un agent de test outillé. Fais exactement ce qui est demandé."},
        {"role": "user", "content": consigne},
    ]

    events = []

    async def on_event(ev):
        events.append(ev)
        if ev.get("type") == "todo_updated":
            print("  event todo_updated  "
                  + " | ".join(f"[{t['status']}] {t['content'][:40]}" for t in ev.get("todos", [])))
        if ev.get("type") in ("kv_cache", "iteration", "tool_call", "error", "info"):
            print(f"  event {ev.get('type'):12s} "
                  + json.dumps({k: v for k, v in ev.items() if k != 'type'},
                               ensure_ascii=False)[:140])

    print(f"modèle={args.model}  blob={args.blob}c  → run_chat_multi_mcp réel…")
    final, _evs, metrics = await run_chat_multi_mcp(
        messages, [], on_event=on_event, username="probe",
        model=args.model, builtin_tools=builtin_tools,
        chat_id="live-smoke", thinking_mode=False,
        sampling_override=({"max_tool_iterations": args.max_iter}
                           if args.max_iter > 0 else None),
    )
    if args.max_iter:
        print(f"\n  max_steps_wrapup={metrics.get('max_steps_wrapup')} "
              f"(limite {metrics.get('tool_limit_kind')})")

    kv = [e for e in events if e.get("type") == "kv_cache"]
    tools_ok = sum(1 for e in events if e.get("type") == "tool_result")
    print("\n════ RÉSULTAT ════")
    print(f"réponse finale : {final[:200]!r}")
    print(f"itérations LLM : {metrics.get('tool_iterations')}  "
          f"in={metrics.get('input_tokens')}  out={metrics.get('output_tokens')}")
    print(f"events kv_cache : {len(kv)} — used={[e.get('used') for e in kv]}")
    assert kv, "aucun event kv_cache (jauge réelle) reçu"
    assert all("phase" not in e and "est" not in e for e in kv), \
        "event kv_cache pré-vol/estimé détecté (régression « réel seul »)"
    assert all(e.get("used", 0) > 0 and e.get("total", 0) > 0 for e in kv)
    print(f"tool_result events : {tools_ok}")

    print("\n════ WATCHER (rapport) ════")
    from llm_core._watch import report
    files = sorted(glob.glob(os.path.join(os.environ["LLAMA_WATCH_DIR"],
                                          "watch-*.ndjson")))
    print(report(files[-1:]))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
