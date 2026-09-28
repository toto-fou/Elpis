# SPDX-License-Identifier: MIT
"""
backend.routes.memory — REST inspection (et édition) de la mémoire long-terme.

Endpoints pour OBSERVER ce que l'agent a curé (USER.md / MEMORY.md, façon
Hermes), le flux d'audit du tool ``memory``, et — depuis 2026-08-16 — corriger
à la main ce qu'il a retenu de travers.

Note historique : ce module portait aussi la surface REST de la todo-list
de travail (/api/memory/todos/*). La feature a été retirée intégralement
le 2026-06-12 (tools todo_*, UI et routes).

Endpoints
---------
- GET    /api/memory/state         — contenu et stats de USER.md + MEMORY.md (per-scope)
- PUT    /api/memory/state/{kind}  — réécrit les entrées d'UN magasin (kind: user|memory)
- GET    /api/memory/audit         — flux JSONL des appels au tool ``memory``
- DELETE /api/memory/state         — efface TOUTE la mémoire du user
- GET    /api/memory/ops/{op}      — détail d'une écriture journalisée (avant/après)
- POST   /api/memory/ops/{op}/undo — annule une écriture (si rien n'a bougé depuis)
"""
from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import HTTPException, Request

from shared_infra.config import MEMORY_DIR as SANDBOX_DIR  # racine du magasin mémoire (P4)
from shared_infra.security.deps import require_user_id
from shared_infra.accounts.users import get_username_by_id
from shared_infra.routes._state import router
from llm_core.memory._migrate import migrate_legacy_memory
from llm_core.memory import _journal


def _resolve_username(request: Request) -> str:
    uid = require_user_id(request)
    name = get_username_by_id(uid)
    if not name:
        # BUG FIX (mineur) : on est ici APRÈS require_user_id qui a validé
        # la session. Si on n'arrive pas à résoudre le username, c'est que
        # l'enregistrement user a été supprimé entre-temps OU que la DB a un
        # problème — c'est un état serveur incohérent, pas un défaut de
        # credentials. Renvoyer 401 trompait l'utilisateur en lui disant
        # "reconnectez-vous" alors que le problème est côté serveur. 500
        # remonte correctement l'erreur opérationnelle.
        raise HTTPException(500, "user record missing for authenticated session")
    return name


# ── Long-term memory inspection (façon Hermes) ────────────────────────────────
#
# Endpoints en lecture seule pour OBSERVER ce que l'agent a curé. C'est la
# façon principale de répondre à « est-ce qu'il apprend de l'utilisateur ? » :
#
#   GET /api/memory/state       → contenu et stats de USER.md + MEMORY.md (per-scope)
#   GET /api/memory/audit       → flux JSONL des appels au tool ``memory``
#
# Aucun écriture ici — la curation passe exclusivement par le tool MCP côté LLM.

def _limits() -> tuple[int, int]:
    """``(memory_limit, user_limit)`` — relus sur disque comme le fait l'outil.

    Sans le ``reload_*`` la limite AFFICHÉE (celle de l'import) pouvait différer
    de la limite APPLIQUÉE par le store, et un enregistrement légitime se voyait
    refusé sans que le compteur de la page l'explique.
    """
    from shared_infra import config as _cfg
    try:
        _cfg.reload_memory_config_from_disk()
    except Exception:
        pass
    return (int(getattr(_cfg, "MEMORY_MD_CHAR_LIMIT", 2200)),
            int(getattr(_cfg, "USER_MD_CHAR_LIMIT", 1375)))


def _file_stat(p: Path) -> Dict[str, Any]:
    """Lit un fichier MEMORY.md/USER.md et renvoie ses entrées + stats."""
    from llm_core.memory import entry_ids, parse_entries
    MEMORY_MD_CHAR_LIMIT, USER_MD_CHAR_LIMIT = _limits()
    limit = USER_MD_CHAR_LIMIT if p.name == "USER.md" else MEMORY_MD_CHAR_LIMIT
    if not p.exists():
        return {"exists": False, "path": str(p), "limit": limit,
                "chars": 0, "usage_pct": 0.0, "entries": [], "entry_ids": [],
                "last_modified": None}
    try:
        raw = p.read_text(encoding="utf-8")
    except Exception:
        raw = ""
    entries = parse_entries(raw)
    chars = len(raw)
    return {
        "exists":        True,
        "path":          str(p),
        "limit":         limit,
        "chars":         chars,
        "usage_pct":     round(100.0 * chars / limit, 1) if limit else 0.0,
        "n_entries":     len(entries),
        "entries":       entries,
        # Champ PARALLÈLE à ``entries`` : les ids courts que le modèle voit
        # ([a1f4] …) — calculés au vol, jamais persistés dans le .md. L'onglet
        # Réglages itère ``entries`` (strings) et n'est pas impacté.
        "entry_ids":     entry_ids(entries),
        "last_modified": p.stat().st_mtime,
    }


@router.get("/api/memory/state")
def api_memory_state(request: Request):
    """État courant de la mémoire long-terme du user (USER.md + MEMORY.md scopés).

    Inclut le contenu intégral des fichiers (entrées parsées), le compteur de
    chars, le pourcentage d'usage vs limite, et la liste des scopes agentic
    déjà matérialisés (par hash, l'historique humain remonte via ``ts``).
    """
    username = _resolve_username(request)
    # Resolve (and one-time migrate from legacy ``.memory``) the host-owned
    # ``memory`` dir — same helper the tool uses, so paths never diverge.
    base = migrate_legacy_memory(SANDBOX_DIR, username)
    out: Dict[str, Any] = {
        "username":     username,
        "user_md":      _file_stat(base / "USER.md"),
        "memory_md":    _file_stat(base / "MEMORY.md"),
        "scopes":       [],
    }
    # Origine de chaque note (2026-09-19) — liste PARALLÈLE à ``entries`` :
    # date, source (assistant / Réglages / annulation) et chat qui l'a écrite,
    # lues dans le journal. ``None`` pour une note antérieure au journal.
    try:
        _add_origins(request, base, out)
    except Exception:
        pass
    scopes_dir = base / "scopes"
    if scopes_dir.exists():
        for scope_dir in sorted(scopes_dir.iterdir()):
            if not scope_dir.is_dir():
                continue
            mf = scope_dir / "MEMORY.md"
            if not mf.exists():
                continue
            st = _file_stat(mf)
            st["scope_hash"] = scope_dir.name
            out["scopes"].append(st)
    return out


def _chat_titles(request: Request, chat_ids: List[str]) -> Dict[str, str]:
    """Titres des chats du user courant (best-effort)."""
    ids = sorted({c for c in chat_ids if c})
    if not ids:
        return {}
    try:
        from shared_infra.db._connection import db_conn
        uid = require_user_id(request)
        qm = ",".join("?" for _ in ids)
        with db_conn() as conn:
            rows = conn.execute(
                f"SELECT id, title FROM chats WHERE user_id = ? AND id IN ({qm})",
                (int(uid), *ids)).fetchall()
        return {r["id"]: (r["title"] or "") for r in rows}
    except Exception:
        return {}


def _add_origins(request: Request, base: Path, out: Dict[str, Any]) -> None:
    per_store = {}
    chat_ids: List[str] = []
    for kind, key in (("user", "user_md"), ("memory", "memory_md")):
        orig = _journal.origins(base, kind, out[key].get("entries") or [])
        per_store[key] = orig
        chat_ids += [o["chat_id"] for o in orig if o and o.get("chat_id")]
    titles = _chat_titles(request, chat_ids)
    for key, orig in per_store.items():
        for o in orig:
            if o and o.get("chat_id"):
                o["chat_title"] = titles.get(o["chat_id"], "")
                o["chat_exists"] = o["chat_id"] in titles
        out[key]["origins"] = orig


def _unlink_store_file(p: Path) -> tuple[bool, Optional[str]]:
    removed, err, _text = _unlink_store_file_capture(p)
    return removed, err


def _unlink_store_file_capture(p: Path) -> tuple[bool, Optional[str], Optional[str]]:
    """Supprime un fichier du store sous le MÊME verrou que le tool ``memory``,
    et rend aussi son contenu LU SOUS CE VERROU (``None`` si rien lu).

    (2026-09-21) Le journal d'annulation lisait l'état « avant » HORS du
    verrou : une écriture de l'outil entre la lecture et la suppression
    manquait au journal, et « Annuler » restaurait un état qui la perdait.

    Renvoie ``(supprimé, erreur, contenu)``. Un fichier absent n'est ni
    supprimé ni une erreur.

    F26 — USER.md / MEMORY.md sont écrits sous ``_store_transaction`` (flock
    ``<path>.lock``). Sans prendre le MÊME verrou, un ``memory add`` concurrent
    dont le ``os.replace(tmp, MEMORY.md)`` s'exécute APRÈS notre ``unlink``
    RECRÉE le fichier → effacement silencieusement incomplet. En le prenant,
    delete et add sont sérialisés (delete gagne ; un add postérieur crée un
    fichier NEUF, pas de résurrection du contenu effacé).
    """
    try:
        from llm_core.memory._markdown_store import _store_transaction, StoreBusyError
    except Exception:  # pragma: no cover - import edge
        _store_transaction = None
        StoreBusyError = Exception  # type: ignore
    text: Optional[str] = None
    try:
        if not p.exists():
            return False, None, None
        if _store_transaction is not None and p.name.endswith(".md"):
            with _store_transaction(p):
                if p.exists():
                    try:
                        text = p.read_text(encoding="utf-8")
                    except Exception:
                        text = None
                    p.unlink()
        else:
            try:
                text = p.read_text(encoding="utf-8")
            except Exception:
                text = None
            p.unlink()
        return True, None, text
    except StoreBusyError:  # write en cours : on n'efface pas à l'aveugle
        return False, "écriture mémoire en cours, réessaie", None
    except Exception as e:  # pragma: no cover - FS edge
        return False, str(e), None


def _audit(base: Path, line: Dict[str, Any]) -> None:
    """Ajoute une ligne au journal lu par ``GET /api/memory/audit`` (best-effort).

    Une édition manuelle DOIT y figurer : sans elle, l'audit laisserait croire
    que tout ce que porte le store vient de l'assistant.
    """
    try:
        path = base / ".audit.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(line, ensure_ascii=False) + "\n")
    except Exception:
        pass


# Garde-fous de payload. Le vrai plafond est le char limit du store (≈2 k), qui
# rejette de toute façon un contenu démesuré — ceux-ci évitent seulement de
# sérialiser des mégaoctets avant d'y arriver.
_MAX_ENTRIES = 500
_MAX_PAYLOAD_CHARS = 200_000


@router.put("/api/memory/state/{kind}")
async def api_memory_put(kind: str, request: Request):
    """Réécrit les entrées d'UN magasin (``kind`` = ``user`` ou ``memory``).

    Sert le bouton « Éditer » de Réglages → Mémoire : la curation reste le
    travail de l'assistant, mais ce qu'il a retenu de travers doit pouvoir se
    corriger — sans quoi le seul recours était « Effacer tout ».

    Corps : ``{"entries": ["…", "…"]}`` — la liste COMPLÈTE et ordonnée. Une
    liste vide supprime le fichier (le store refuse un ``rewrite`` vide, par
    garde anti-wipe accidentel ; ici l'intention est explicite).

    Passe par ``MarkdownStore.rewrite`` : même transaction (flock) et même
    contrôle de limite que l'outil, donc aucune écriture concurrente ne peut
    être écrasée à l'aveugle.
    """
    if kind not in ("user", "memory"):
        raise HTTPException(404, "magasin inconnu")
    username = _resolve_username(request)
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(400, "corps JSON invalide")
    raw = payload.get("entries") if isinstance(payload, dict) else None
    if not isinstance(raw, list):
        raise HTTPException(400, "champ « entries » manquant (liste attendue)")
    if len(raw) > _MAX_ENTRIES:
        raise HTTPException(400, f"trop d'entrées (max {_MAX_ENTRIES})")
    entries = [str(e or "").strip() for e in raw]
    entries = [e for e in entries if e]
    if sum(len(e) for e in entries) > _MAX_PAYLOAD_CHARS:
        raise HTTPException(400, "contenu démesuré")

    # AUDIT 2026-08-31 (passe 3) — tout le travail disque/verrous part en
    # threadpool. La route (async) appelait ``set_entries`` en direct :
    # ``_store_transaction`` prend un ``threading.Lock`` bloquant (5 s) puis
    # SPINNE sur le flock en ``time.sleep(0.1)`` — sur la boucle, éditer sa
    # mémoire pendant que l'outil ``memory`` écrit (lui passe déjà par un
    # thread) gelait TOUS les flux du worker jusqu'à 5 s. Les HTTPException
    # levées dans le thread traversent ``to_thread`` telles quelles.
    def _apply():
        base = migrate_legacy_memory(SANDBOX_DIR, username)
        path = base / ("USER.md" if kind == "user" else "MEMORY.md")

        if not entries:
            removed, err, _txt = _unlink_store_file_capture(path)
            if err:
                raise HTTPException(409, err)
            try:
                from llm_core.memory import parse_entries as _pe
                _before = _pe(_txt) if _txt else []
            except Exception:
                _before = []
            if removed:
                try:
                    _journal.append(base, action="rewrite", store=kind,
                                    before=_before, after=[], source="settings")
                except Exception:
                    pass
            _audit(base, {"ts": time.time(), "action": "rewrite", "store": kind,
                          "scope": "user", "source": "settings", "ok": True,
                          "error": None, "error_code": None, "chars": 0,
                          "n_entries": 0, "cleared": bool(removed)})
            return {"ok": True, "state": _file_stat(path)}

        from llm_core.memory import store_for
        from llm_core.memory._markdown_store import StoreBusyError

        mem_limit, user_limit = _limits()
        store = store_for(kind, username, "user", SANDBOX_DIR,
                          memory_limit=mem_limit, user_limit=user_limit)
        # ``set_entries`` et NON ``rewrite`` : ce dernier prend un DOCUMENT qu'il
        # redécoupe sur toute ligne ``---`` ou ``§``, et couperait donc en deux une
        # entrée contenant un trait horizontal Markdown. Ici les frontières sont
        # celles que l'utilisateur a posées dans le formulaire.
        try:
            res = store.set_entries(entries)
        except StoreBusyError:
            raise HTTPException(409, "écriture mémoire en cours, réessayez")
        _audit(base, {"ts": time.time(), "action": "rewrite", "store": kind,
                      "scope": "user", "source": "settings", "ok": bool(res.ok),
                      "error": res.error, "error_code": res.error_code,
                      "chars": res.chars, "limit": res.limit,
                      "usage_pct": res.usage_pct, "n_entries": res.n_entries})
        if not res.ok:
            # Cas courant : dépassement de limite. Le message porte les
            # compteurs, c'est ce que la page affiche telle quelle.
            raise HTTPException(400, res.error or "écriture refusée")
        try:
            _journal.append(base, action="rewrite", store=kind,
                            before=res.before, after=res.entries, source="settings")
        except Exception:
            pass
        return {"ok": True, "state": _file_stat(path)}

    return await asyncio.to_thread(_apply)


@router.get("/api/memory/audit")
def api_memory_audit(request: Request, limit: int = 50):
    """Derniers appels au tool ``memory`` pour ce user (audit JSONL).

    Sert au monitoring : « combien d'écritures ? combien de over_limit ? quel
    ratio add/replace/remove ? ». Limit borné entre 1 et 1000.
    """
    username = _resolve_username(request)
    lim = max(1, min(1000, int(limit)))
    audit_path = migrate_legacy_memory(SANDBOX_DIR, username) / ".audit.jsonl"
    entries: List[Dict[str, Any]] = []
    if audit_path.exists():
        try:
            with open(audit_path, "r", encoding="utf-8") as fh:
                lines = fh.readlines()
            for line in lines[-lim:]:
                line = line.strip()
                if not line:
                    continue
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        except Exception:
            pass
    # Agrégats utiles à un coup d'œil. Les échecs se comptent par
    # ``error_code`` (stable) ; repli sur les sous-chaînes ANGLAISES
    # historiques pour les lignes d'audit antérieures à la v2 (les messages
    # sont passés en français, seul le code est garanti).
    counts: Dict[str, int] = {"add": 0, "replace": 0, "remove": 0, "rewrite": 0,
                              "ok": 0, "failed": 0, "over_limit": 0,
                              "ambiguous": 0, "no_match": 0, "store_busy": 0}
    for e in entries:
        if e.get("action") in counts:
            counts[e["action"]] += 1
        if e.get("ok"):
            counts["ok"] += 1
        else:
            counts["failed"] += 1
            code = e.get("error_code")
            if not code:                       # lignes legacy (pré-error_code)
                err = (e.get("error") or "").lower()
                if "over char limit" in err:
                    code = "over_limit"
                elif "ambiguous" in err:
                    code = "ambiguous"
                elif "no entry" in err:
                    code = "no_match"
            if code in counts:
                counts[code] += 1
    return {"username": username, "count": len(entries),
            "summary": counts, "entries": entries}


@router.delete("/api/memory/state")
def api_memory_delete(request: Request):
    """Efface TOUTE la mémoire long-terme du user (destructif, opt-in).

    Déclenché explicitement depuis Réglages → Mémoire (avec confirmation).
    Supprime, dans le SEUL dossier mémoire de CE user (résolu par ``username``,
    jamais cross-user) : ``USER.md`` (profil), ``MEMORY.md`` (notes), le dossier
    ``scopes/`` (mémoires agentic par scope) et ``.audit.jsonl`` (journal des
    écritures — contient le contenu curé). Irréversible. Le toggle
    ``memory_enabled`` n'est PAS touché (l'utilisateur peut vider sans couper).

    Retour : ``{ok, removed: [...], errors: [...]}`` — 200 même si rien à
    supprimer (``removed`` vide), cohérent avec la lecture qui répond toujours 200.
    """
    import shutil

    username = _resolve_username(request)
    base = migrate_legacy_memory(SANDBOX_DIR, username)
    removed: List[str] = []
    errors: List[str] = []

    # Verrou partagé avec le tool ``memory`` — cf. ``_unlink_store_file``.
    for name in ("USER.md", "MEMORY.md", ".audit.jsonl"):
        ok, err = _unlink_store_file(base / name)
        if ok:
            removed.append(name)
        elif err:
            errors.append(f"{name}: {err}")
    # Le journal porte le contenu avant/après de chaque écriture : il part avec.
    try:
        if _journal.purge(base):
            removed.append(_journal.JOURNAL_NAME)
    except Exception as e:  # pragma: no cover - FS edge
        errors.append(f"{_journal.JOURNAL_NAME}: {e}")

    scopes_dir = base / "scopes"
    try:
        if scopes_dir.exists():
            shutil.rmtree(scopes_dir)
            removed.append("scopes/")
    except Exception as e:  # pragma: no cover - FS edge
        errors.append(f"scopes: {e}")

    return {"ok": not errors, "removed": removed, "errors": errors}


# ── Écritures journalisées : détail + annulation (2026-09-19) ─────────────────
# Le fil du chat montre chaque écriture de l'assistant ; l'outil ne renvoie au
# modèle que l'identifiant ``op``. Le détail (avant/après) et l'annulation
# passent par ces deux routes, scopées au compte de la session.

def _valid_op(op: str) -> str:
    op = str(op or "").strip().lower()
    if not (4 <= len(op) <= 16) or any(c not in "0123456789abcdef" for c in op):
        raise HTTPException(404, "écriture inconnue")
    return op


def _store_of(username: str, kind: str):
    from llm_core.memory import store_for
    mem_limit, user_limit = _limits()
    return store_for(kind, username, "user", SANDBOX_DIR,
                     memory_limit=mem_limit, user_limit=user_limit)


def _op_view(base: Path, username: str, rec: Dict[str, Any]) -> Dict[str, Any]:
    d = _journal.diff(rec)
    undo = _journal.undone_by(base, rec["op"])
    try:
        current = _store_of(username, rec.get("store") or "memory").entries()
    except Exception:
        current = None
    return {
        "op":       rec["op"],
        "ts":       rec.get("ts"),
        "action":   rec.get("action"),
        "store":    rec.get("store"),
        "source":   rec.get("source"),
        "title":    rec.get("title"),
        "added":    d["added"],
        "removed":  d["removed"],
        "n_before": len(rec.get("before") or []),
        "n_after":  len(rec.get("after") or []),
        "undone":   undo is not None,
        "can_undo": (undo is None and rec.get("source") != "undo"
                     and current is not None and current == list(rec.get("after") or [])),
    }


@router.get("/api/memory/ops/{op}")
def api_memory_op(op: str, request: Request):
    """Détail d'une écriture : entrées ajoutées / retirées, annulable ou non."""
    op = _valid_op(op)
    username = _resolve_username(request)
    base = migrate_legacy_memory(SANDBOX_DIR, username)
    rec = _journal.get(base, op)
    if rec is None:
        raise HTTPException(404, "écriture inconnue (journal effacé ou trop ancien)")
    return _op_view(base, username, rec)


@router.post("/api/memory/ops/{op}/undo")
async def api_memory_op_undo(op: str, request: Request):
    """Annule une écriture : remet le magasin dans son état d'AVANT, à condition
    qu'il soit resté dans l'état d'APRÈS (compare-and-set sous le verrou du
    magasin). Sinon 409 : une annulation n'écrase jamais une écriture plus
    récente."""
    op = _valid_op(op)
    username = _resolve_username(request)

    def _apply():
        from llm_core.memory._markdown_store import StoreBusyError
        base = migrate_legacy_memory(SANDBOX_DIR, username)
        rec = _journal.get(base, op)
        if rec is None:
            raise HTTPException(404, "écriture inconnue (journal effacé ou trop ancien)")
        if rec.get("source") == "undo":
            raise HTTPException(409, "une annulation ne s'annule pas")
        if _journal.undone_by(base, op) is not None:
            raise HTTPException(409, "écriture déjà annulée")
        kind = rec.get("store") if rec.get("store") in ("user", "memory") else "memory"
        store = _store_of(username, kind)
        try:
            res = store.restore(list(rec.get("after") or []), list(rec.get("before") or []))
        except StoreBusyError:
            raise HTTPException(409, "écriture mémoire en cours, réessayez")
        if not res.ok:
            if res.error_code == "changed":
                raise HTTPException(409, "la mémoire a changé depuis cette écriture")
            raise HTTPException(409, res.error or "annulation refusée")
        try:
            _journal.append(base, action="undo", store=kind, before=res.before,
                            after=res.entries, source="undo", undo_of=op,
                            chat_id=rec.get("chat_id"))
        except Exception:
            pass
        _audit(base, {"ts": time.time(), "action": "undo", "store": kind,
                      "scope": "user", "source": "undo", "ok": True,
                      "error": None, "error_code": None, "chars": res.chars,
                      "limit": res.limit, "usage_pct": res.usage_pct,
                      "n_entries": res.n_entries, "undo_of": op})
        return {"ok": True, "op": _op_view(base, username, rec)}

    return await asyncio.to_thread(_apply)
