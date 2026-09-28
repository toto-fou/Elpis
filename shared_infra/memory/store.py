# SPDX-License-Identifier: MIT
"""
shared_infra.memory.store — Index FTS5 de recherche d'historique de sessions.

Table unifiée ``session_messages`` (+ miroir FTS5 ``session_messages_fts``)
couvrant À LA FOIS le chat (``app='chat'``) et l'agentic (``app='agentic'``).
Permet à l'outil ``session_search`` de retrouver le texte BRUT de messages
passés (sans résumé), façon Hermes.

Pourquoi une table dédiée et pas ``chats.messages_json`` ? Ce dernier est un
blob JSON (uniquement LIKE-able) et ne contient PAS les messages agentic. Un
index FTS5 dédié donne une recherche full-text rapide, multi-app, scopée par user.

Idempotent : appelé depuis ``init_db()``. Dégrade proprement si le build SQLite
système n'a pas FTS5 (les écritures/recherches deviennent des no-op silencieux).
"""
from __future__ import annotations

import logging
import re
import time
from typing import Any, Dict, List, Optional

from shared_infra.db._connection import db_conn
from shared_infra.db._dialect import MYSQL, POSTGRES, SQLITE, backend, ci_like, insert_id
from shared_infra.db._schema import FTS_PUNCT

log = logging.getLogger("uvicorn.error")

# Flag de disponibilité FTS5, résolu à l'init. None = pas encore initialisé.
_FTS_OK: Optional[bool] = None


def init_memory_db() -> None:
    """Crée ``session_messages`` + l'index plein texte et ses déclencheurs.
    Idempotent — DDL du schéma de référence (``shared_infra/db/_schema.py``).
    Sans FTS5 dans le build SQLite, la recherche retombe sur LIKE."""
    global _FTS_OK
    from shared_infra.db._schema import ensure_fts, ensure_tables
    with db_conn() as conn:
        ensure_tables(conn, ("session_messages",))
        _FTS_OK = ensure_fts(conn)
        conn.commit()


def session_index_message(*, user_id: int, app: str, session_id: str,
                          scope_key: str, role: str, content: str,
                          ts: Optional[float] = None) -> int:
    """Indexe un message de session. Best-effort : renvoie 0 en cas d'échec."""
    content = (content or "").strip()
    if not content or user_id is None:
        return 0
    try:
        with db_conn() as conn:
            new_id = insert_id(
                conn.cursor(),
                "INSERT INTO session_messages(user_id, app, session_id, scope_key, role, content, ts) "
                "VALUES(?,?,?,?,?,?,?)",
                (int(user_id), app or "chat", session_id or "", scope_key or "",
                 role or "user", content, float(ts if ts is not None else time.time())),
            )
            conn.commit()
            return new_id
    except Exception as e:
        log.debug("[memory_store] index failed: %s", e)
        return 0


def session_index_messages(rows: List[Dict[str, Any]]) -> int:
    """(passe 8, B8) Indexe PLUSIEURS messages en UNE transaction.

    ``rows`` : dicts ``{user_id, app, session_id, scope_key, role, content, ts}``
    (mêmes clés que :func:`session_index_message`). La pré-compaction en
    appelait l'unitaire en boucle : une transaction + un commit PAR ligne,
    soit des centaines de prises du verrou d'écriture d'affilée, sérialisées
    contre tous les workers. Best-effort : renvoie le nombre de lignes écrites
    (0 en cas d'échec — l'indexation ne fait jamais échouer l'appelant)."""
    now = time.time()
    params = []
    for r in rows or ():
        if not isinstance(r, dict):
            continue
        content = (r.get("content") or "").strip()
        uid = r.get("user_id")
        if not content or uid is None:
            continue
        ts = r.get("ts")
        params.append((int(uid), r.get("app") or "chat", r.get("session_id") or "",
                       r.get("scope_key") or "", r.get("role") or "user", content,
                       float(ts if ts is not None else now)))
    if not params:
        return 0
    try:
        with db_conn() as conn:
            conn.executemany(
                "INSERT INTO session_messages(user_id, app, session_id, scope_key, role, content, ts) "
                "VALUES(?,?,?,?,?,?,?)", params)
            conn.commit()
            return len(params)
    except Exception as e:
        log.debug("[memory_store] bulk index failed: %s", e)
        return 0


def session_search_fts(user_id: int, query: str, limit: int = 10) -> List[Dict[str, Any]]:
    """Recherche full-text le texte brut des sessions passées de ce user.

    Renvoie une liste de dicts (app, session_id, role, content, ts). Tombe sur
    une recherche LIKE si FTS5 est absent ; renvoie [] sur requête vide/erreur.
    """
    if not query or not query.strip() or user_id is None:
        return []
    lim = max(1, min(100, int(limit)))

    raw_tokens = [t for t in query.split() if t.strip()]
    if not raw_tokens:
        return []

    with db_conn() as conn:
        cur = conn.cursor()
        try:
            sql, params = _fts_search_sql(raw_tokens, int(user_id), lim)
            cur.execute(sql, params)
            return [_row_to_dict(r) for r in cur.fetchall()]
        except Exception:
            # FTS5 absent → fallback LIKE (sur le premier token, simple mais utile).
            try:
                like = f"%{query.strip()}%"
                cur.execute(
                    "SELECT app, session_id, scope_key, role, content, ts FROM session_messages "
                    f"WHERE user_id = ? AND {ci_like('content')} ORDER BY ts DESC LIMIT ?",
                    (int(user_id), like, lim),
                )
                return [_row_to_dict(r) for r in cur.fetchall()]
            except Exception:
                return []


# ── Recherche en EXTRAITS (2026-09-19) ───────────────────────────────────────
# ``session_search_fts`` renvoie les messages ENTIERS : une recherche courante
# (« python ») ramenait ~14 000 caractères au modèle. L'outil passe désormais
# par des extraits FTS5 (``snippet()``, ~32 jetons autour des mots trouvés),
# avec le titre du chat pour se repérer et une référence ``ref`` : le texte
# ENTIER d'un passage se lit ensuite par ``session_message_by_ref``.
# TOUS les rôles restent cherchés : les lignes ``tool`` / ``tool_call`` sont
# ce que vise le marqueur d'élagage « [Old tool output cleared — use
# session_search to retrieve it] » (llm_core/context/pruning.py).
_SNIPPET_TOKENS = 32
_EXCERPT_CHARS = 220
SEARCH_ROLES = ("user", "assistant", "tool", "tool_call")
MESSAGE_MAX_CHARS = 6000


def _manual_excerpt(content: str, tokens: List[str], mark: bool = False) -> str:
    """Repli sans FTS5 : ~220 caractères autour de la première occurrence.
    ``mark`` : mots trouvés encadrés de « », comme ``snippet()`` de FTS5 et
    ``ts_headline`` (MySQL, dont le plein texte ne rend pas d'extrait)."""
    text = " ".join(str(content or "").split())
    low = text.casefold()
    pos = -1
    for t in tokens:
        pos = low.find(t.casefold())
        if pos >= 0:
            break
    if pos < 0:
        pos = 0
    start = max(0, pos - _EXCERPT_CHARS // 2)
    end = min(len(text), start + _EXCERPT_CHARS)
    out = text[start:end].strip()
    if mark:
        words = [re.escape(t) for t in tokens if t.strip()]
        if words:
            out = re.sub(r"(?<!\w)(" + "|".join(words) + r")(?!\w)", r"«\1»", out, flags=re.I)
    return ("… " if start > 0 else "") + out + (" …" if end < len(text) else "")


def session_search_snippets(user_id: int, query: str, limit: int = 5,
                            roles: tuple = SEARCH_ROLES) -> List[Dict[str, Any]]:
    """Comme :func:`session_search_fts`, mais renvoie des EXTRAITS.

    Dicts ``{app, session_id, role, snippet, ts, title}`` — ``title`` = titre
    du chat quand la session en est un (``""`` sinon). ``[]`` sur requête
    vide ou erreur.
    """
    if not query or not query.strip() or user_id is None:
        return []
    lim = max(1, min(50, int(limit)))
    raw_tokens = [t for t in query.split() if t.strip()]
    if not raw_tokens:
        return []
    roles = tuple(roles or SEARCH_ROLES)
    ph = ",".join("?" for _ in roles)
    out: List[Dict[str, Any]] = []
    with db_conn() as conn:
        cur = conn.cursor()
        try:
            sql, params = _fts_snippet_sql(raw_tokens, int(user_id), roles, lim)
            cur.execute(sql, params)
            for r in cur.fetchall():
                snip = (r["snip"] if "snip" in r.keys()
                        else _manual_excerpt(r["content"], raw_tokens, mark=True))
                out.append({"ref": r["id"], "app": r["app"], "session_id": r["session_id"],
                            "role": r["role"], "ts": r["ts"],
                            "snippet": " ".join(str(snip or "").split())})
        except Exception:
            try:
                cur.execute(
                    "SELECT id, app, session_id, role, content, ts FROM session_messages "
                    f"WHERE user_id = ? AND {ci_like('content')} AND role IN ({ph}) "
                    "ORDER BY ts DESC LIMIT ?",
                    (int(user_id), f"%{query.strip()}%", *roles, lim),
                )
                for r in cur.fetchall():
                    out.append({"ref": r["id"], "app": r["app"], "session_id": r["session_id"],
                                "role": r["role"], "ts": r["ts"],
                                "snippet": _manual_excerpt(r["content"], raw_tokens)})
            except Exception:
                return []
        # Titres des chats (table absente dans certains contextes de test :
        # best-effort, jamais bloquant).
        ids = sorted({o["session_id"] for o in out if o["app"] == "chat"})
        titles: Dict[str, str] = {}
        if ids:
            try:
                qm = ",".join("?" for _ in ids)
                cur.execute(f"SELECT id, title FROM chats WHERE user_id = ? AND id IN ({qm})",
                            (int(user_id), *ids))
                titles = {r["id"]: r["title"] or "" for r in cur.fetchall()}
            except Exception:
                titles = {}
        for o in out:
            o["title"] = titles.get(o["session_id"], "") if o["app"] == "chat" else ""
    return out


def session_message_by_ref(user_id: int, ref: int) -> Optional[Dict[str, Any]]:
    """Le texte ENTIER d'un passage trouvé par :func:`session_search_snippets`
    (plafonné à ``MESSAGE_MAX_CHARS``). Scopé au compte : la référence d'un
    autre utilisateur rend None."""
    try:
        rid = int(ref)
    except (TypeError, ValueError):
        return None
    if user_id is None or rid <= 0:
        return None
    with db_conn() as conn:
        cur = conn.cursor()
        try:
            cur.execute(
                "SELECT id, app, session_id, role, content, ts FROM session_messages "
                "WHERE id = ? AND user_id = ?", (rid, int(user_id)))
            r = cur.fetchone()
        except Exception:
            return None
        if not r:
            return None
        content = str(r["content"] or "")
        out = {"ref": r["id"], "app": r["app"], "session_id": r["session_id"],
               "role": r["role"], "ts": r["ts"],
               "content": content[:MESSAGE_MAX_CHARS],
               "truncated": len(content) > MESSAGE_MAX_CHARS, "title": ""}
        if r["app"] == "chat":
            try:
                cur.execute("SELECT title FROM chats WHERE user_id = ? AND id = ?",
                            (int(user_id), r["session_id"]))
                t = cur.fetchone()
                out["title"] = (t["title"] or "") if t else ""
            except Exception:
                pass
        return out


# ── Requêtes plein texte par moteur ──────────────────────────────────────────
#  SQLite : FTS5 (``MATCH``, ``bm25`` croissant = meilleur, ``snippet``).
#  PostgreSQL : ``websearch_to_tsquery`` (mots reliés par « or »), colonne
#  générée ``content_tsv``, ``ts_rank_cd`` décroissant, ``ts_headline``.
#  MySQL/MariaDB : ``MATCH … AGAINST`` en mode booléen (mots entre guillemets,
#  OU implicite), extraits calculés ici (``_manual_excerpt``).

_PG_PUNCT = str.maketrans({c: " " for c in FTS_PUNCT})


def _fts_terms(raw_tokens: List[str], dialect: str) -> str:
    if dialect == POSTGRES:
        # Même découpage que l'index (``pg_fts_document``) : « plan.md » devient
        # la phrase « plan md », comme en FTS5.
        phrases = (" ".join(t.translate(_PG_PUNCT).split()) for t in raw_tokens)
        return " or ".join('"' + p + '"' for p in phrases if p)
    if dialect == MYSQL:
        return " ".join('"' + t.replace('"', " ") + '"' for t in raw_tokens)
    return " OR ".join('"' + t.replace('"', '""') + '"' for t in raw_tokens)


def _fts_search_sql(raw_tokens: List[str], user_id: int, lim: int):
    d = backend()
    q = _fts_terms(raw_tokens, d)
    if d == POSTGRES:
        return ("SELECT sm.app, sm.session_id, sm.scope_key, sm.role, sm.content, sm.ts, "
                "ts_rank_cd(sm.content_tsv, websearch_to_tsquery('elpis_simple', ?)) AS rank_score "
                "FROM session_messages sm "
                "WHERE sm.content_tsv @@ websearch_to_tsquery('elpis_simple', ?) AND sm.user_id = ? "
                "ORDER BY rank_score DESC LIMIT ?", (q, q, user_id, lim))
    if d == MYSQL:
        return ("SELECT app, session_id, scope_key, role, content, ts, "
                "MATCH(content) AGAINST (? IN BOOLEAN MODE) AS rank_score "
                "FROM session_messages "
                "WHERE MATCH(content) AGAINST (? IN BOOLEAN MODE) AND user_id = ? "
                "ORDER BY rank_score DESC LIMIT ?", (q, q, user_id, lim))
    return ("SELECT sm.app, sm.session_id, sm.scope_key, sm.role, sm.content, sm.ts, "
            "bm25(session_messages_fts) AS rank_score "
            "FROM session_messages_fts "
            "JOIN session_messages sm ON sm.id = session_messages_fts.rowid "
            "WHERE session_messages_fts MATCH ? AND sm.user_id = ? "
            "ORDER BY rank_score LIMIT ?", (q, user_id, lim))


def _fts_snippet_sql(raw_tokens: List[str], user_id: int, roles: tuple, lim: int):
    d = backend()
    q = _fts_terms(raw_tokens, d)
    ph = ",".join("?" for _ in roles)
    if d == POSTGRES:
        opts = (f"StartSel=«, StopSel=», MaxWords={_SNIPPET_TOKENS}, MinWords=12, "
                'MaxFragments=1, FragmentDelimiter=" … "')
        return ("SELECT sm.id, sm.app, sm.session_id, sm.role, sm.ts, "
                "ts_headline('elpis_simple', sm.content, websearch_to_tsquery('elpis_simple', ?), "
                f"'{opts}') AS snip "
                "FROM session_messages sm "
                "WHERE sm.content_tsv @@ websearch_to_tsquery('elpis_simple', ?) "
                f"AND sm.user_id = ? AND sm.role IN ({ph}) "
                "ORDER BY ts_rank_cd(sm.content_tsv, websearch_to_tsquery('elpis_simple', ?)) DESC "
                "LIMIT ?", (q, q, user_id, *roles, q, lim))
    if d == MYSQL:
        return ("SELECT id, app, session_id, role, ts, content "
                "FROM session_messages "
                f"WHERE MATCH(content) AGAINST (? IN BOOLEAN MODE) AND user_id = ? AND role IN ({ph}) "
                "ORDER BY MATCH(content) AGAINST (? IN BOOLEAN MODE) DESC LIMIT ?",
                (q, user_id, *roles, q, lim))
    return ("SELECT sm.id, sm.app, sm.session_id, sm.role, sm.ts, "
            f"snippet(session_messages_fts, 0, '«', '»', ' … ', {_SNIPPET_TOKENS}) AS snip "
            "FROM session_messages_fts "
            "JOIN session_messages sm ON sm.id = session_messages_fts.rowid "
            f"WHERE session_messages_fts MATCH ? AND sm.user_id = ? AND sm.role IN ({ph}) "
            "ORDER BY bm25(session_messages_fts) LIMIT ?", (q, user_id, *roles, lim))


def _row_to_dict(row) -> Dict[str, Any]:
    return {
        "app":        row["app"],
        "session_id": row["session_id"],
        "scope_key":  row["scope_key"],
        "role":       row["role"],
        "content":    row["content"],
        "ts":         row["ts"],
    }


def purge_session_messages(retention_days: int = 180) -> int:
    """Rétention (passe de maintenance, AUDIT 2026-08-31 passe 3).

    ``session_messages`` était la SEULE table à croissance non bornée : une
    ligne par message user/assistant + une par tool/tool_call compressé, le
    contenu recopié dans l'index FTS5 (le trigger ``sm_ad`` nettoie l'index à
    la suppression). ``<=0`` → no-op. Ne lève jamais.
    """
    if retention_days <= 0:
        return 0
    try:
        cutoff = time.time() - retention_days * 86400
        with db_conn() as conn:
            cur = conn.cursor()
            cur.execute("DELETE FROM session_messages WHERE ts < ?", (cutoff,))
            n = cur.rowcount or 0
            conn.commit()
        if n:
            log.info("[maintenance] %d session_messages purgé(s) (>%dj).",
                     n, retention_days)
        return n
    except Exception:
        log.debug("[maintenance] purge_session_messages failed (non-fatal)",
                  exc_info=True)
        return 0
