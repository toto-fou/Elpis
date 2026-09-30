# SPDX-License-Identifier: MIT
"""llm_core._watch — watcher contexte/perf (traceur NDJSON, opt-in par env).

Objectif : VOIR ce que la boucle envoie réellement au LLM et ce qu'elle en
reçoit, pour chasser les optimisations de contexte (parité agentique
OpenCode) : prompts assemblés (taille par message, tête système, sorties
élaguées), payload tools, usage/timings RÉELS du serveur — dont
``timings.prompt_n`` = tokens re-préfillés, la mesure directe de
l'efficacité du cache KV — stats du fit (fast-path, drops, memo d'élagage)
et sorties d'outils (taille/durée/statut).

Complémentaire du tap DB ``_llm_debug`` (viewer admin « Trafic LLM ») : ici
c'est un fichier NDJSON par process, fait pour le diff/le grep/le rapport
hors-ligne, et pensé zéro-coût quand désactivé (un seul check d'env).

Activation :
    LLAMA_WATCH=1              → active le traceur
    LLAMA_WATCH_DIR=<dir>      → dossier de sortie (défaut : ./traces/llm-watch)
    LLAMA_WATCH_FULL=1         → contenu COMPLET des messages (défaut : tête
                                 de 160 chars — les fichiers restent légers)

Fichiers : ``watch-YYYYMMDD-<pid>.ndjson`` (un par jour et par worker —
appends jamais entrelacés). Une ligne = un record JSON :
    kind="llm_call"  : un appel LLM (prompt assemblé + réponse mesurée)
    kind="tool"      : une exécution d'outil

Rapport :
    venv/bin/python -m llm_core._watch traces/llm-watch/*.ndjson

Garanties : 100 % best-effort (toute exception avalée), aucun impact sur le
chat ; rien n'est écrit si LLAMA_WATCH n'est pas actif.
"""
from __future__ import annotations

import json
import os
import threading
import time
from typing import Any, Dict, List, Optional

_LOCK = threading.Lock()
_FH = None                # handle courant
_FH_DAY = None            # jour du handle (rotation quotidienne)

_HEAD_CHARS = 160         # extrait de message quand LLAMA_WATCH_FULL≠1

# Marqueurs posés par context.pruning — permettent d'étiqueter, dans le
# prompt assemblé, ce qui a déjà été élagué/élidé.
_PRUNE_MARKER = "chars omitted — tool history compaction"
_VISION_MARKER = "previous screenshot elided"


def watch_enabled() -> bool:
    return os.environ.get("LLAMA_WATCH", "").strip().lower() in ("1", "true", "yes", "on")


def _watch_dir() -> str:
    return os.environ.get("LLAMA_WATCH_DIR", "").strip() or os.path.join("traces", "llm-watch")


def _full_content() -> bool:
    return os.environ.get("LLAMA_WATCH_FULL", "").strip().lower() in ("1", "true", "yes", "on")


def _write(record: Dict[str, Any]) -> None:
    """Append une ligne NDJSON (rotation quotidienne, fichier par PID)."""
    global _FH, _FH_DAY
    try:
        day = time.strftime("%Y%m%d")
        with _LOCK:
            if _FH is None or _FH_DAY != day:
                if _FH is not None:
                    try:
                        _FH.close()
                    except Exception:
                        pass
                d = _watch_dir()
                os.makedirs(d, exist_ok=True)
                path = os.path.join(d, f"watch-{day}-{os.getpid()}.ndjson")
                _FH = open(path, "a", encoding="utf-8", buffering=1)  # noqa: SIM115 (journal du jour, gardé ouvert)
                _FH_DAY = day
            _FH.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    except Exception:
        pass


def _msg_entry(i: int, m: Dict[str, Any]) -> Dict[str, Any]:
    """Résumé d'UN message du prompt assemblé (taille, marqueurs, extrait)."""
    role = m.get("role")
    c = m.get("content")
    e: Dict[str, Any] = {"i": i, "role": role}
    if isinstance(c, str):
        e["chars"] = len(c)
        if role == "tool":
            if m.get("tool_call_id"):
                e["tcid"] = m["tool_call_id"]
            if _PRUNE_MARKER in c:
                e["pruned"] = True
        if _full_content():
            e["content"] = c
        elif c:
            e["head"] = c[:_HEAD_CHARS]
    elif isinstance(c, list):
        # multimodal : parts texte + nombre d'images (les frames élidées ont
        # déjà été remplacées par un placeholder texte par le pipeline).
        txt = "".join(b.get("text", "") for b in c
                      if isinstance(b, dict) and isinstance(b.get("text"), str))
        e["chars"] = len(txt)
        e["imgs"] = sum(1 for b in c if isinstance(b, dict) and b.get("type") == "image_url")
        if any(isinstance(b, dict) and _VISION_MARKER in (b.get("text") or "") for b in c):
            e["vision_pruned"] = True
        if _full_content():
            e["content"] = txt
        elif txt:
            e["head"] = txt[:_HEAD_CHARS]
    tcs = m.get("tool_calls")
    if tcs:
        e["tool_calls"] = [
            {"name": (tc.get("function") or {}).get("name"),
             "args_chars": len((tc.get("function") or {}).get("arguments") or "")}
            for tc in tcs if isinstance(tc, dict)
        ]
    return e


def watch_llm_call(
    *,
    chat_id: Optional[str],
    path: str,                       # "tools" | "classic"
    iteration: Optional[int],
    model: Optional[str],
    messages: Optional[List[Dict[str, Any]]],
    tools_payload: Optional[List[Dict[str, Any]]],
    usage: Optional[Dict[str, Any]],
    timings: Optional[Dict[str, Any]],
    fit: Optional[Dict[str, Any]] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> None:
    """Journalise UN appel LLM : le prompt réellement assemblé (la vue envoyée,
    pas working_messages) + la mesure réelle du serveur. Best-effort, no-op si
    LLAMA_WATCH inactif."""
    if not watch_enabled():
        return
    try:
        usage = usage or {}
        timings = timings or {}
        rec: Dict[str, Any] = {
            "kind": "llm_call", "ts": round(time.time(), 3),
            "chat": str(chat_id or ""), "path": path, "iter": iteration,
            "model": model or "",
        }
        if messages:
            entries = [_msg_entry(i, m) for i, m in enumerate(messages)
                       if isinstance(m, dict)]
            rec["n_msgs"] = len(entries)
            rec["total_chars"] = sum(e.get("chars", 0) for e in entries)
            rec["head_chars"] = next(
                (e.get("chars", 0) for e in entries if e.get("role") == "system"), 0)
            rec["msgs"] = entries
        if tools_payload:
            try:
                _tp = json.dumps(tools_payload, ensure_ascii=False, sort_keys=True)
                rec["tools"] = {"n": len(tools_payload), "chars": len(_tp)}
            except Exception:
                rec["tools"] = {"n": len(tools_payload)}
        pt = int(usage.get("prompt_tokens") or 0)
        ct = int(usage.get("completion_tokens") or 0)
        pn = timings.get("prompt_n")
        rec["usage"] = {"prompt_tokens": pt, "completion_tokens": ct}
        rec["timings"] = {
            k: timings[k] for k in
            ("prompt_n", "prompt_ms", "predicted_n", "predicted_ms", "cache_n")
            if k in timings
        }
        # Efficacité du cache KV, mesurée par le SERVEUR : prompt_n = tokens
        # re-préfillés (hors préfixe réutilisé). reused = pt − prompt_n.
        if pt > 0 and isinstance(pn, (int, float)) and pn >= 0:
            reused = max(0, pt - int(pn))
            rec["kv"] = {"reused": reused,
                         "ratio": round(reused / pt, 4) if pt else 0.0}
        if fit:
            rec["fit"] = fit
        if extra:
            rec["extra"] = extra
        _write(rec)
    except Exception:
        pass


def watch_tool_call(
    *,
    chat_id: Optional[str],
    iteration: Optional[int],
    tool: str,
    args_chars: int,
    result_chars: int,
    duration_ms: int,
    status: str,
) -> None:
    """Journalise UNE exécution d'outil (taille entrée/sortie, durée, statut)."""
    if not watch_enabled():
        return
    try:
        _write({
            "kind": "tool", "ts": round(time.time(), 3),
            "chat": str(chat_id or ""), "iter": iteration, "tool": tool,
            "args_chars": int(args_chars), "result_chars": int(result_chars),
            "ms": int(duration_ms), "status": status,
        })
    except Exception:
        pass


# ──────────────────────────────────────────────────────────────────────────
# Rapport hors-ligne : venv/bin/python -m llm_core._watch <fichiers.ndjson>
# ──────────────────────────────────────────────────────────────────────────

def _fmt_k(n: float) -> str:
    return f"{n/1000:.1f}k" if abs(n) >= 1000 else str(int(n))


def _load(paths: List[str]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for p in paths:
        try:
            with open(p, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        out.append(json.loads(line))
                    except Exception:
                        continue
        except OSError:
            continue
    out.sort(key=lambda r: r.get("ts", 0))
    return out


def report(paths: List[str]) -> str:
    """Synthèse lisible des traces : par chat — volumétrie, efficacité KV,
    pires itérations, messages/outils les plus lourds. Sert à répondre à
    « où part le contexte, où part le temps ? »."""
    recs = _load(paths)
    calls = [r for r in recs if r.get("kind") == "llm_call"]
    tools = [r for r in recs if r.get("kind") == "tool"]
    lines: List[str] = []
    if not recs:
        return "aucun record (fichiers vides ou LLAMA_WATCH inactif)"

    chats = sorted({r.get("chat", "") for r in recs})
    for chat in chats:
        c_calls = [r for r in calls if r.get("chat") == chat]
        c_tools = [r for r in tools if r.get("chat") == chat]
        if not c_calls and not c_tools:
            continue
        lines.append(f"── chat {chat or '(sans id)'} "
                     f"— {len(c_calls)} appel(s) LLM, {len(c_tools)} outil(s)")
        if c_calls:
            pt = sum(r.get("usage", {}).get("prompt_tokens", 0) for r in c_calls)
            ct = sum(r.get("usage", {}).get("completion_tokens", 0) for r in c_calls)
            pn = sum(int(r.get("timings", {}).get("prompt_n") or 0) for r in c_calls)
            pms = sum(float(r.get("timings", {}).get("prompt_ms") or 0) for r in c_calls)
            reused = sum(r.get("kv", {}).get("reused", 0) for r in c_calls)
            lines.append(f"   tokens soumis Σ={_fmt_k(pt)}  générés Σ={_fmt_k(ct)}  "
                         f"re-préfillés Σ={_fmt_k(pn)}  prefill Σ={pms/1000:.1f}s")
            if pt:
                lines.append(f"   cache KV : réutilisé {_fmt_k(reused)}/{_fmt_k(pt)} "
                             f"({100*reused/pt:.0f} %)")
            worst = sorted((r for r in c_calls if r.get("kv")),
                           key=lambda r: r["kv"]["ratio"])[:3]
            for r in worst:
                lines.append(
                    f"   pire ratio : iter={r.get('iter')} "
                    f"ratio={100*r['kv']['ratio']:.0f} % "
                    f"(prompt={_fmt_k(r['usage']['prompt_tokens'])}, "
                    f"re-préfillé={_fmt_k(int(r['timings'].get('prompt_n') or 0))})")
            last = c_calls[-1]
            if last.get("msgs"):
                heavy = sorted(last["msgs"], key=lambda e: -e.get("chars", 0))[:5]
                lines.append("   messages les plus lourds (dernier appel) : " + ", ".join(
                    f"#{e['i']} {e.get('role')}"
                    f"{'(élagué)' if e.get('pruned') else ''} {_fmt_k(e.get('chars', 0))}c"
                    for e in heavy))
                lines.append(f"   tête système : {_fmt_k(last.get('head_chars', 0))}c ; "
                             f"total : {_fmt_k(last.get('total_chars', 0))}c ; "
                             f"tools payload : "
                             f"{_fmt_k((last.get('tools') or {}).get('chars', 0))}c")
        if c_tools:
            by_tool: Dict[str, Dict[str, float]] = {}
            for t in c_tools:
                a = by_tool.setdefault(t.get("tool", "?"),
                                       {"n": 0, "out": 0, "max": 0, "ms": 0, "err": 0})
                a["n"] += 1
                a["out"] += t.get("result_chars", 0)
                a["max"] = max(a["max"], t.get("result_chars", 0))
                a["ms"] += t.get("ms", 0)
                a["err"] += 1 if t.get("status") == "error" else 0
            lines.append("   outils : " + " · ".join(
                f"{name}×{int(a['n'])} (Σ{_fmt_k(a['out'])}c, max {_fmt_k(a['max'])}c, "
                f"Σ{a['ms']/1000:.1f}s{', err ' + str(int(a['err'])) if a['err'] else ''})"
                for name, a in sorted(by_tool.items(), key=lambda kv: -kv[1]["out"])))
    return "\n".join(lines)


if __name__ == "__main__":  # pragma: no cover — CLI manuel
    import sys
    print(report(sys.argv[1:]))
