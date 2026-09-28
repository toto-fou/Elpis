# SPDX-License-Identifier: MIT
"""Dump lisible des ÉCHANGES INTERNES de la boucle tool-calling à grande
échelle (256k / 1M) — hors pytest, zéro réseau, zéro LLM (2026-07-28).

Rejoue ``run_chat_multi_mcp`` en hermétique (FakeClient SSE scripté, n_ctx
patché, compression désactivée) sur N rounds d'outils volumineux, puis
montre PAR ITÉRATION ce qui est réellement parti au modèle :
    - taille du payload (messages / chars), sorties pleines vs marquées ;
    - décisions du pipeline de réduction (fast-path, drops du budget dur) ;
    - occupation réelle simulée (usage serveur) et règle unique d'overflow ;
    - marques d'élagage émises en fin de tour (``prune_state``) ;
    - ``max_tokens`` clampé.
La trace prod ``LLAMA_WATCH`` (NDJSON, une ligne par appel LLM) est activée
vers ``--out-dir`` — c'est le même canal d'observation que la production.

Usage :
    venv/bin/python tests/perf/backend/bench_ctx_scale_dump.py --ctx 262144 --rounds 30
    venv/bin/python tests/perf/backend/bench_ctx_scale_dump.py --ctx 1048576 --rounds 30
    # options : --tool-chars 30000, --out-dir <dir>, --full (contenus complets)

Réutilise ``tests/llm_core/ctx_scale_harness.py`` (mêmes fabriques et patchs
que la suite pytest) — non collecté par pytest (nom ``bench_*``).
"""
import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

# Lançable depuis n'importe quel CWD : la racine du repo dans sys.path.
_REPO = Path(__file__).resolve().parents[3]
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))

DEFAULT_OUT = Path(__file__).resolve().parent.parent / "results" / "backend" / "ctx_scale_dump"


class _Patcher:
    """Mini-monkeypatch (le process meurt après le run — pas de restauration)."""

    def setattr(self, obj, name, value, raising=True):
        setattr(obj, name, value)

    def setenv(self, key, value):
        os.environ[key] = value


async def _main(args) -> int:
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    # Canal d'observation PROD : une ligne NDJSON par appel LLM.
    os.environ["LLAMA_WATCH"] = "1"
    os.environ["LLAMA_WATCH_DIR"] = str(out_dir)
    if args.full:
        os.environ["LLAMA_WATCH_FULL"] = "1"

    import llm_core._chat_with_tools as _cwt
    from tests.llm_core.ctx_scale_harness import (
        blob, compression_cfg, expected, fit_spy, hermetic_at_scale,
        sse_final_scaled, sse_tool_call_scaled, tool_contents,
    )

    mp = _Patcher()
    E = expected(args.ctx)
    compression_cfg(mp, COMPRESSION_ENABLED=False)
    spy = fit_spy(mp)

    # Occupation réelle simulée : rampe déterministe ≈ croissance d'un vrai
    # run (chaque round ajoute ~tool_chars/3.3 tokens de résultat d'outil).
    pt = [3_000 + int(i * (args.tool_chars / 3.3 + 60)) for i in range(args.rounds)]
    scripts = [
        sse_tool_call_scaled("bench_dump", json.dumps({"step": i}), f"b{i}",
                             prompt_tokens=pt[i])
        for i in range(args.rounds)
    ] + [sse_final_scaled("dump terminé", prompt_tokens=pt[-1] + args.tool_chars // 3)]

    _counter = {"i": 0}

    def _dump_handler(_args):
        i = _counter["i"]
        _counter["i"] += 1
        return blob(args.tool_chars, f"bench{i}")

    builtin = {"bench_dump": {
        "definition": {"type": "function", "function": {
            "name": "bench_dump",
            "description": "Outil synthétique du dump d'échelle.",
            "parameters": {"type": "object", "properties": {
                "step": {"type": "number"}}},
        }},
        "handler": _dump_handler,
    }}

    fake = hermetic_at_scale(mp, scripts, args.ctx)
    events = []

    async def _cb(evt):
        events.append(evt)

    final, _ev, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "system", "content": "SOCLE dump échelle."},
         {"role": "user", "content": "Enchaîne les étapes bench_dump puis conclus."}],
        mcp_configs=[], builtin_tools=builtin,
        username="bench", chat_id="bench-ctx-scale", model="bench-model",
        memory_enabled=False, on_event=_cb)

    # ── Rapport par itération ────────────────────────────────────────────
    print(f"\nn_ctx={args.ctx:,}  rounds={args.rounds}  tool_chars={args.tool_chars:,}")
    print(f"budget prompt={E['prompt_budget']:,} tk   emit cap={E['emit_cap']:,} chars   "
          f"usable={E['usable']:,} tk   prune: protect={E['prune_protect_tokens']:,} tk "
          f"/ min={E['prune_min_tokens']:,} tk\n")
    header = (f"{'it':>3} {'msgs':>5} {'chars':>10} {'pleins':>6} {'marqués':>7} "
              f"{'fastpath':>8} {'drop':>4} "
              f"{'réel tk':>9} {'règle overflow':>22} {'max_tok':>7}")
    print(header)
    print("─" * len(header))

    summary = []
    for i, payload in enumerate(fake.payloads):
        msgs = payload["messages"]
        chars = sum(len(m.get("content") or "") for m in msgs
                    if isinstance(m.get("content"), str))
        from llm_core.context.pruning import PRUNE_CLEARED_MARKER
        tools = tool_contents(msgs)
        pruned = sum(1 for c in tools.values()
                     if isinstance(c, str) and c == PRUNE_CLEARED_MARKER)
        s = spy[i] if i < len(spy) else {}
        real = pt[i - 1] + 15 if 0 < i <= len(pt) else None
        gate_open = bool(real and real >= E["usable"])
        gate_txt = (f"{'OUVRE' if gate_open else 'fermée'} "
                    f"({real:,}/{E['usable']:,})") if real else "—"
        row = {
            "iter": i, "n_msgs": len(msgs), "chars": chars,
            "tools_full": len(tools) - pruned, "tools_pruned": pruned,
            "fastpath": bool(s.get("fastpath")), "dropped": s.get("dropped", 0),
            "real_tokens": real, "overflow_open": gate_open if real else None,
            "max_tokens": payload.get("max_tokens"),
        }
        summary.append(row)
        print(f"{i:>3} {row['n_msgs']:>5} {chars:>10,} {row['tools_full']:>6} "
              f"{pruned:>7} {str(row['fastpath']):>8} {row['dropped']:>4} "
              f"{(f'{real:,}' if real else '—'):>9} {gate_txt:>22} "
              f"{str(row['max_tokens']):>7}")

    warn = [e for e in events if e.get("type") == "warning"]
    prune_evs = [e for e in events if e.get("type") == "prune_state"]
    n_marks = sum(len(e.get("keys") or []) for e in prune_evs)
    print(f"\nmarques d'élagage émises en fin de tour : {n_marks} "
          f"(appliquées au PROCHAIN tour via meta_json)")
    print(f"réponse finale : {final!r}")
    print(f"events : {len(events)} (dont {len(warn)} warning)"
          + (f" — {warn[0]['text'][:100]}…" if warn else ""))

    out_file = out_dir / f"dump-summary-{args.ctx}.ndjson"
    with out_file.open("w", encoding="utf-8") as fh:
        for row in summary:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    watch_files = sorted(p.name for p in out_dir.glob("watch-*.ndjson"))
    print(f"\nrésumé par itération : {out_file}")
    print(f"trace LLAMA_WATCH (payloads détaillés{' COMPLETS' if args.full else ''}) : "
          f"{out_dir}/{watch_files[-1] if watch_files else '(absente)'}")
    print("rapport agrégé : venv/bin/python -m llm_core._watch "
          f"{out_dir}/watch-*.ndjson")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--ctx", type=int, default=262_144,
                    help="n_ctx simulé (262144 ou 1048576)")
    ap.add_argument("--rounds", type=int, default=30,
                    help="nombre de rounds d'outils scriptés")
    ap.add_argument("--tool-chars", type=int, default=30_000,
                    help="taille (chars) de chaque résultat d'outil")
    ap.add_argument("--out-dir", default=str(DEFAULT_OUT),
                    help="dossier des NDJSON (résumé + trace LLAMA_WATCH)")
    ap.add_argument("--full", action="store_true",
                    help="trace LLAMA_WATCH avec contenus COMPLETS des messages")
    return asyncio.run(_main(ap.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
