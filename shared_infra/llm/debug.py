# SPDX-License-Identifier: MIT
"""
shared_infra.llm.debug — Capture des échanges app ↔ llama.cpp (debug).

Table ``llm_calls`` : une ligne par appel HTTP vers llama.cpp (chemin classic
OU chaque itération du chemin tools). Alimente le viewer admin "Trafic LLM"
(``shared_infra/routes/admin/llm_traffic.py``).

Pourquoi une table SQLite et pas un buffer mémoire : le process "main" (chat,
où ont lieu les appels llama.cpp) et le process "admin" (où vit le viewer)
peuvent être SÉPARÉS (APP_MODE main/admin). Une table dans ``user_db/app.db``
(WAL) est lisible des deux. Ring borné : on purge au-delà de ``max_entries``.

Confidentialité : la requête (messages envoyés) et la réponse sont stockées en
clair — réservé à l'admin (route admin-gated, is_admin==1 strict). Le contenu
de "thinking"/raisonnement N'EST PAS capturé (décision produit). Capture
désactivable via ``llm.debug.enabled`` (config) — cf. ``LLM_DEBUG_ENABLED``.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional

from shared_infra.db._connection import db_conn

logger = logging.getLogger("uvicorn.error")


def init_llm_debug_db() -> None:
    """Crée la table ``llm_calls`` + index. Idempotent — DDL du schéma de
    référence (``shared_infra/db/_schema.py``)."""
    from shared_infra.db._schema import ensure_tables
    with db_conn() as conn:
        ensure_tables(conn, ("llm_calls",))
        conn.commit()


def record_llm_call(
    *,
    req_id:            Optional[str] = None,
    user_id:           Optional[int] = None,
    chat_id:           Optional[str] = None,
    model:             Optional[str] = None,
    path:              Optional[str] = None,
    status:            str = "ok",
    finish_reason:     Optional[str] = None,
    prompt_tokens:     Optional[int] = None,
    completion_tokens: Optional[int] = None,
    duration_ms:       Optional[int] = None,
    n_messages:        Optional[int] = None,
    n_tool_calls:      Optional[int] = None,
    request_json:      Optional[str] = None,
    response_json:     Optional[str] = None,
    error:             Optional[str] = None,
    max_entries:       int = 500,
) -> None:
    """Insère un échange + purge le ring au-delà de ``max_entries``.

    Best-effort : un échec d'écriture ne doit JAMAIS interrompre l'appelant
    (la capture est un outil de debug, pas un chemin critique).
    """
    try:
        with db_conn() as conn:
            cur = conn.cursor()
            cur.execute(
                "INSERT INTO llm_calls("
                "ts, req_id, user_id, chat_id, model, path, status, finish_reason, "
                "prompt_tokens, completion_tokens, duration_ms, n_messages, "
                "n_tool_calls, request_json, response_json, error) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    time.time(), req_id,
                    int(user_id) if user_id is not None else None,
                    chat_id, model, path, status, finish_reason,
                    prompt_tokens, completion_tokens, duration_ms,
                    n_messages, n_tool_calls, request_json, response_json,
                    (error or "")[:1000] if error else None,
                ),
            )
            # Ring : ne garde que les ``max_entries`` plus récents.
            #
            # La forme ``id NOT IN (SELECT … LIMIT n)`` obligeait SQLite à
            # PARCOURIR TOUTE LA TABLE deux fois (``EXPLAIN QUERY PLAN`` :
            # ``SCAN llm_calls`` × 2) à chaque appel LLM — sur une table de
            # 12 Mo, et à l'intérieur de la transaction d'écriture, c'est-à-dire
            # pendant que le verrou d'écriture SQLite (unique pour TOUS les
            # workers) est tenu.
            #
            # On borne par la clé primaire à la place. Soit X le ``max_entries``-ième
            # id en partant du plus récent : les lignes à jeter sont exactement
            # celles d'id < X, puisque les ``max_entries`` conservées sont les plus
            # grandes. Le jeu supprimé est donc IDENTIQUE (y compris si les ids ont
            # des trous : X est lu par position, pas calculé), mais le plan devient
            # ``SEARCH … USING INTEGER PRIMARY KEY (rowid<?)``.
            #
            # Mesuré (payload réel de 66 Ko, ring plein, 400 écritures) — durée de
            # la transaction, donc du verrou tenu :
            #   avant : moy 0,838 ms | p99 4,55 ms | max 18,2 ms
            #   après : moy 0,419 ms | p99 2,74 ms | max 13,4 ms
            #
            # Variante « purger tous les N » essayée puis ÉCARTÉE : elle divise le
            # travail total mais fait exploser la queue (p99 14 ms, max 51 ms) —
            # une suppression groupée tient le verrou bien plus longtemps.
            if max_entries and max_entries > 0:
                cur.execute(
                    "DELETE FROM llm_calls WHERE id < (SELECT id FROM "
                    "(SELECT id FROM llm_calls ORDER BY id DESC LIMIT 1 OFFSET ?) AS seuil)",
                    (int(max_entries) - 1,),
                )
            conn.commit()
    except Exception:
        logger.debug("[llm_calls] write failed (non-fatal)", exc_info=True)


# Colonnes "résumé" (sans les gros JSON) pour le listing.
_SUMMARY_COLS = (
    "id, ts, req_id, user_id, chat_id, model, path, status, finish_reason, "
    "prompt_tokens, completion_tokens, duration_ms, n_messages, n_tool_calls, error"
)


def list_llm_calls(
    *,
    limit: int = 100,
    user_id: Optional[int] = None,
    model: Optional[str] = None,
    status: Optional[str] = None,
    chat_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Liste les échanges récents (résumés, SANS les payloads). Filtres optionnels."""
    where: List[str] = []
    params: List[Any] = []
    if user_id is not None:
        where.append("user_id=?"); params.append(int(user_id))
    if model:
        where.append("model=?"); params.append(model)
    if status:
        where.append("status=?"); params.append(status)
    if chat_id:
        where.append("chat_id=?"); params.append(chat_id)
    where_sql = (" WHERE " + " AND ".join(where)) if where else ""
    limit = max(1, min(int(limit or 100), 1000))
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            f"SELECT {_SUMMARY_COLS} FROM llm_calls{where_sql} ORDER BY id DESC LIMIT ?",
            params + [limit],
        )
        return [dict(r) for r in cur.fetchall()]


def get_llm_call(call_id: int) -> Optional[Dict[str, Any]]:
    """Détail complet d'un échange (INCLUANT request_json/response_json). None si absent."""
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT * FROM llm_calls WHERE id=?", (int(call_id),))
        row = cur.fetchone()
        return dict(row) if row else None


def clear_llm_calls() -> int:
    """Vide la table. Retourne le nombre de lignes supprimées."""
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) AS n FROM llm_calls")
        n = int((cur.fetchone() or {"n": 0})["n"])
        cur.execute("DELETE FROM llm_calls")
        conn.commit()
        return n
