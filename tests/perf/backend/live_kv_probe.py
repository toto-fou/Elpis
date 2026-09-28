# SPDX-License-Identifier: MIT
"""Probe RÉELLE llama.cpp — churn du préfixe KV : anciens tiers GLISSANTS vs
élagage MONOTONE (2026-07-12).

Simule un run agentique qui grossit (1 tool_result de --blob chars par
itération), produit à chaque itération la vue envoyée par (A) l'ANCIEN
``compact_tool_results`` à tiers glissants par rang et (B) le NOUVEAU
monotone à memo, puis envoie chaque vue au VRAI serveur (max_tokens=1,
cache_prompt) et lit ``timings.prompt_n`` = tokens réellement re-préfillés
(la vérité serveur sur la réutilisation du cache).

Les deux variantes utilisent un nonce distinct dans le system → aucun
partage de cache entre elles. Les rôles tool/tool_calls sont aplatis en
user/assistant AVANT l'envoi (transformation déterministe, identique aux
deux variantes — le template du serveur n'a pas besoin de supporter les
rôles outil, et la propriété mesurée est la stabilité du préfixe).

Usage :
    venv/bin/python tests/perf/backend/live_kv_probe.py \
        [--model Qwen3.5-9B-UD-Q4_K_XL] [--iters 14] [--blob 6000] [--ctx N]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time

import httpx

from shared_infra import config as cfg
from llm_core.context.budget import BUDGET
from llm_core.context.pruning import compact_tool_results, truncate_head_tail

BASE = cfg.LLAMA_URL.split("/v1/")[0]


# ── ANCIEN algorithme (tiers glissants par rang), reproduit verbatim ─────────
def old_compact(working_messages, ctx_tokens=None):
    tool_indices = [i for i, m in enumerate(working_messages) if m.get("role") == "tool"]
    if len(tool_indices) <= 3:
        return working_messages
    if ctx_tokens and ctx_tokens > 0:
        budget_chars = ctx_tokens * 3.5
        total_chars = sum(len(m["content"]) for m in working_messages
                          if isinstance(m.get("content"), str))
        if total_chars < budget_chars * 0.50:
            return working_messages
        max_recent = int(budget_chars * 0.12)
        max_middle = int(budget_chars * 0.04)
        max_old    = int(budget_chars * 0.008)
    else:
        max_recent, max_middle, max_old = 12000, 2500, 200
    truncate_at = {}
    for rank, idx in enumerate(reversed(tool_indices)):
        if rank < 3:
            limit = max_recent
        elif rank < 10:
            limit = max_middle
        else:
            limit = max_old
        truncate_at[idx] = limit
    out = []
    for i, m in enumerate(working_messages):
        if i in truncate_at:
            content = m.get("content") or ""
            limit = truncate_at[i]
            if isinstance(content, str) and len(content) > limit:
                m = {**m, "content": truncate_head_tail(content, limit)}
        out.append(m)
    return out


# ── Corpus déterministe ──────────────────────────────────────────────────────
def blob(k: int, size: int) -> str:
    line = f"resultat outil #{k} — ligne de sortie avec details varies\n"
    n = max(1, size // len(line))
    return (line * n)[:size]


def history(n_tools: int, nonce: str, blob_size: int):
    msgs = [
        {"role": "system",
         "content": f"[{nonce}] Tu es un agent d'ingenierie. Socle de test. " * 20},
        {"role": "user", "content": "Analyse le depot et liste les problemes."},
    ]
    for k in range(n_tools):
        msgs.append({"role": "assistant", "content": "",
                     "tool_calls": [{"id": f"c{k}", "type": "function",
                                     "function": {"name": "lire_bloc",
                                                  "arguments": json.dumps({"n": k})}}]})
        msgs.append({"role": "tool", "tool_call_id": f"c{k}",
                     "content": blob(k, blob_size)})
    return msgs


def sendable(view):
    """Aplatis tool/tool_calls en user/assistant (déterministe, identique aux
    deux variantes) — indépendant du support des rôles outil par le template."""
    out = []
    for m in view:
        role, c = m.get("role"), m.get("content")
        if role == "tool":
            out.append({"role": "user",
                        "content": f"[resultat {m.get('tool_call_id')}]\n{c}"})
        elif role == "assistant" and m.get("tool_calls"):
            calls = "; ".join(
                f"{tc['function']['name']}({tc['function']['arguments']})"
                for tc in m["tool_calls"])
            out.append({"role": "assistant", "content": f"J'appelle: {calls}"})
        else:
            out.append({"role": role, "content": c})
    return out


async def measure(client: httpx.AsyncClient, model: str, msgs, timeout: float):
    payload = {
        "model": model, "messages": msgs, "stream": False,
        "max_tokens": 1, "temperature": 0, "cache_prompt": True,
    }
    t0 = time.perf_counter()
    r = await client.post(f"{BASE}/v1/chat/completions", json=payload,
                          timeout=timeout)
    wall_ms = (time.perf_counter() - t0) * 1000
    r.raise_for_status()
    d = r.json()
    t = d.get("timings") or {}
    u = d.get("usage") or {}
    return {
        "prompt_tokens": int(u.get("prompt_tokens") or 0),
        "prompt_n": int(t.get("prompt_n") or -1),
        "prompt_ms": float(t.get("prompt_ms") or 0),
        "wall_ms": wall_ms,
    }


async def run_variant(client, model, name, algo, iters, blob_size, ctx, timeout):
    rows = []
    print(f"\n─── variante {name} ───")
    for i in range(1, iters + 1):
        view = algo(history(i, name, blob_size))
        m = await measure(client, model, sendable(view), timeout)
        rows.append(m)
        print(f"  iter {i:2d} : prompt={m['prompt_tokens']:6d} tok  "
              f"re-préfillé={m['prompt_n']:6d} tok  "
              f"prefill={m['prompt_ms']:8.1f} ms")
    return rows


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen3.5-9B-UD-Q4_K_XL")
    ap.add_argument("--iters", type=int, default=14)
    ap.add_argument("--blob", type=int, default=6000)
    ap.add_argument("--ctx", type=int, default=0,
                    help="n_ctx par slot pour les algos (défaut : /props réel)")
    args = ap.parse_args()

    ctx = args.ctx
    if not ctx:
        from llm_core._model_info import get_model_context_size
        ctx = await get_model_context_size(args.model) or 32768
    print(f"serveur={BASE}  modèle={args.model}  n_ctx/slot={ctx}  "
          f"blob={args.blob}c  iters={args.iters}")
    trigger = ctx * BUDGET.tool_compact_chars_per_token * BUDGET.tool_compact_trigger
    print(f"seuil d'élagage ≈ {int(trigger)} chars → franchi vers l'itération "
          f"~{max(1, int(trigger // args.blob))}")

    async with httpx.AsyncClient() as client:
        # 1er appel = chargement éventuel du modèle par le routeur (long).
        print("préchauffage (chargement modèle éventuel)…")
        await measure(client, args.model,
                      [{"role": "user", "content": "ping"}], timeout=600)

        memo: dict = {}
        rows_new = await run_variant(
            client, args.model, "MONOTONE",
            lambda h: compact_tool_results(h, ctx_tokens=ctx, prune_memo=memo),
            args.iters, args.blob, ctx, timeout=300)
        rows_old = await run_variant(
            client, args.model, "GLISSANT",
            lambda h: old_compact(h, ctx_tokens=ctx),
            args.iters, args.blob, ctx, timeout=300)

    def tot(rows, k):
        return sum(r[k] for r in rows)

    print("\n════ TOTAUX (itérations 2..N — la 1re est un prefill à froid) ════")
    for name, rows in (("GLISSANT (ancien)", rows_old), ("MONOTONE (nouveau)", rows_new)):
        body = rows[1:]
        print(f"  {name:20s} re-préfillé Σ={tot(body, 'prompt_n'):7d} tok   "
              f"prefill Σ={tot(body, 'prompt_ms')/1000:6.2f} s   "
              f"(soumis Σ={tot(body, 'prompt_tokens')} tok)")
    on, oo = tot(rows_new[1:], "prompt_n"), tot(rows_old[1:], "prompt_n")
    if on > 0:
        print(f"  → tokens re-préfillés : ÷{oo/on:.1f} ; "
              f"prefill : ÷{tot(rows_old[1:], 'prompt_ms')/max(1e-9, tot(rows_new[1:], 'prompt_ms')):.1f}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
