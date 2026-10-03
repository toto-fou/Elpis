# SPDX-License-Identifier: MIT
"""shared_infra/observability/runs_timeline.py — chronologie d'une exécution
(L5.3, 2026-09-30).

Reconstruite sans jointure approximative : la ligne ``runs``, ses tours LLM
(``usage_events`` du même ``run_id``), ses appels d'outils
(``tool_call_metrics`` du même ``run_id``, enrichis par ``call_id`` de
l'argument principal et d'un extrait du résultat tirés de la ``tool_history``
du message), ses exécutions filles (sous-agents, compactions ; récursif,
profondeur bornée). L'export JSON masque ce qui ressemble à un secret.
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional

from shared_infra.db._connection import db_conn
from shared_infra.observability.runs import get_run

_PROFONDEUR_MAX = 4                 # sous-agents imbriqués (TASK_SUBAGENT_DEPTH ≤ 3) + marge
_ENFANTS_MAX = 200
_EVENEMENTS_MAX = 2000
_ARGUMENT_MAX = 240
_RESULTAT_MAX = 600
# Clés d'arguments qui disent le mieux ce qu'un appel fait, dans l'ordre.
_CLES_PRINCIPALES = ("command", "cmd", "path", "file_path", "paths", "query", "url",
                     "pattern", "action", "name", "repo", "target")


def run_accessible(run: Optional[Dict[str, Any]], user_id: int, is_admin: bool = False) -> bool:
    """L'exécution existe et appartient au compte (ou l'appelant est admin).
    L'identifiant seul ne suffit jamais : ceux d'un message viennent du
    client (relecture L5)."""
    if not run:
        return False
    return bool(is_admin) or (run.get("user_id") is not None and int(run["user_id"]) == int(user_id))


def _lignes(sql: str, params: tuple) -> List[Dict[str, Any]]:
    with db_conn() as conn:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]


def _enfants(run_id: str, profondeur: int = 0) -> List[Dict[str, Any]]:
    if profondeur >= _PROFONDEUR_MAX:
        return []
    rows = _lignes("SELECT id FROM runs WHERE parent_id = ? ORDER BY started_at LIMIT ?",
                   (run_id, _ENFANTS_MAX))
    rendu = []
    for r in rows:
        d = get_run(r["id"])
        if d is not None:
            d["children"] = _enfants(d["id"], profondeur + 1)
            rendu.append(d)
    return rendu


def _argument_principal(arguments: Any) -> str:
    """L'argument qui résume l'appel (commande, chemin, requête…), tronqué."""
    try:
        args = json.loads(arguments) if isinstance(arguments, str) else arguments
    except (TypeError, ValueError):
        return str(arguments or "")[:_ARGUMENT_MAX]
    if not isinstance(args, dict):
        return str(args)[:_ARGUMENT_MAX]
    for cle in _CLES_PRINCIPALES:
        v = args.get(cle)
        if v not in (None, "", []):
            return (f"{cle}: " + (v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)))[:_ARGUMENT_MAX]
    return json.dumps(args, ensure_ascii=False)[:_ARGUMENT_MAX]


def _appels_du_message(user_id: int, chat_id: str, run_id: str) -> Dict[str, Dict[str, str]]:
    """``{call_id: {"name", "argument", "result"}}`` d'après la
    ``tool_history`` du message qui porte ``run_id``."""
    if not chat_id:
        return {}
    try:
        from shared_infra.chat.store import get_chat
        chat = get_chat(int(user_id), str(chat_id)) or {}
    except Exception:                                            # noqa: BLE001
        return {}
    rendu: Dict[str, Dict[str, str]] = {}
    for m in chat.get("messages") or []:
        if not isinstance(m, dict) or run_id not in (m.get("run_ids") or []):
            continue
        for h in m.get("tool_history") or []:
            if not isinstance(h, dict):
                continue
            if h.get("role") == "assistant":
                for tc in h.get("tool_calls") or []:
                    if isinstance(tc, dict) and tc.get("id"):
                        fn = tc.get("function") or {}
                        rendu.setdefault(str(tc["id"]), {}).update(
                            name=str(fn.get("name") or ""),
                            argument=_argument_principal(fn.get("arguments")))
            elif h.get("role") == "tool" and h.get("tool_call_id"):
                contenu = h.get("content")
                texte = contenu if isinstance(contenu, str) else json.dumps(contenu, ensure_ascii=False)
                rendu.setdefault(str(h["tool_call_id"]), {})["result"] = (texte or "")[:_RESULTAT_MAX]
    return rendu


def timeline(run: Dict[str, Any]) -> Dict[str, Any]:
    """Chronologie d'une exécution : événements triés par instant, puis ses
    exécutions filles (avec leurs agrégats)."""
    rid = str(run["id"])
    evenements: List[Dict[str, Any]] = []
    for u in _lignes(
            "SELECT ts, source, model, connector, input_tokens, output_tokens, "
            "cache_read_tokens, cache_creation_tokens, thinking_tokens, tool_tokens, duration_ms, "
            "iterations, "
            "status, error_kind "
            "FROM usage_events WHERE run_id = ? ORDER BY ts LIMIT ?", (rid, _EVENEMENTS_MAX)):
        debut = float(u["ts"] or 0) - int(u.get("duration_ms") or 0) / 1000.0
        evenements.append({"type": "llm", "at": debut, **u})
    appels = _appels_du_message(run.get("user_id") or 0, run.get("chat_id") or "", rid)
    for t in _lignes(
            "SELECT call_id, started_at, ts, tool_name, category, status, duration_ms, "
            "exit_code, args_bytes, result_bytes, error_short FROM tool_call_metrics "
            "WHERE run_id = ? ORDER BY ts LIMIT ?", (rid, _EVENEMENTS_MAX)):
        debut = t.get("started_at") or (float(t["ts"] or 0) - int(t.get("duration_ms") or 0) / 1000.0)
        detail = appels.get(str(t.get("call_id") or ""), {})
        evenements.append({"type": "tool", "at": float(debut), **t,
                           "argument": detail.get("argument", ""),
                           "result": detail.get("result", "")})
    enfants = _enfants(rid)
    for e in enfants:
        evenements.append({"type": "child", "at": float(e.get("started_at") or 0),
                           "run_id": e["id"], "kind": e.get("kind"), "status": e.get("status"),
                           "duration_ms": int(((e.get("ended_at") or e.get("started_at") or 0)
                                               - (e.get("started_at") or 0)) * 1000)})
    evenements.sort(key=lambda x: x["at"])
    return {"run": run, "events": evenements, "children": enfants}


# ── Export : secrets masqués ────────────────────────────────────────────────
_SECRETS = [
    re.compile(r"(?i)\b(authorization|proxy-authorization)\s*[:=]\s*(bearer|basic|token)?\s*[^\s\"',;]+"),
    # clé sensible, séparateur (guillemets éventuellement échappés : stdout
    # JSON d'un outil), puis valeur entre guillemets (espaces compris) ou nue.
    re.compile(r"(?i)\b([a-z0-9_]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key)[a-z0-9_]*)"
               r"(\\?[\"']?\s*[:=]\s*)"
               r"(\\?\"(?:[^\"\\]|\\(?!\"))*\\?\"|'[^']*'|[^\s\"',;&\\]+)"),
    re.compile(r"\b(?:pcr|ept|evt|ghp|gho|ghs|glpat|xox[abp]|sk|sk-ant)[-_][A-Za-z0-9_\-]{12,}"),
    re.compile(r"(?i)(https?://)[^/\s:@]+:[^/\s@]+@"),
    # Fin optionnelle : un extrait tronqué (résultat borné) garde le début.
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|[\s\S]*$)"),
]


def masquer(texte: str) -> str:
    """Remplace ce qui ressemble à un secret par « *** » (en-têtes
    d'authentification, ``clé=valeur`` sensibles, jetons connus, identifiants
    dans une URL, clés privées)."""
    t = texte
    t = _SECRETS[0].sub(lambda m: f"{m.group(1)}: ***", t)
    t = _SECRETS[1].sub(lambda m: f"{m.group(1)}{m.group(2)}***", t)
    t = _SECRETS[2].sub("***", t)
    t = _SECRETS[3].sub(lambda m: f"{m.group(1)}***@", t)
    t = _SECRETS[4].sub("-----PRIVATE KEY (masquée)-----", t)
    return t


def _masquer_objet(v: Any) -> Any:
    if isinstance(v, str):
        return masquer(v)
    if isinstance(v, list):
        return [_masquer_objet(x) for x in v]
    if isinstance(v, dict):
        return {k: _masquer_objet(x) for k, x in v.items()}
    return v


def export(run: Dict[str, Any]) -> Dict[str, Any]:
    """Chronologie complète (filles comprises), secrets masqués."""
    t = timeline(run)
    t["children_timelines"] = [timeline(e) for e in t["children"]]
    return _masquer_objet({"format": "elpis-run/1", **t})


__all__ = ["export", "masquer", "run_accessible", "timeline"]
