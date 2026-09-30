# SPDX-License-Identifier: MIT
"""
shared_infra.observability.usage_store — Registre d'usage LLM : écriture + agrégats.

Une ligne par **tour** LLM (pas par itération d'outil) : c'est la granularité
que lit un opérateur (« qui a consommé quoi, quand, par quel chemin »), et
c'est la seule qui ne double-compte pas. Le détail par appel reste disponible
dans ``llm_calls`` (anneau de debug) et les timings dans ``metric_events``.

Contrat d'écriture
==================
``record_usage()`` est **best-effort** : elle n'échoue jamais vers l'appelant.
Une métrique perdue est un incident de télémétrie, pas de conversation — et le
chemin d'appel est celui d'un tour de chat en cours.

Contrat de lecture
==================
Toutes les fonctions d'agrégat sont **bornées dans le temps** (``since`` est
obligatoire) : l'index ``idx_usage_ts`` porte la sélection, les découpes
(utilisateur / source / modèle) ne s'appliquent qu'au sous-ensemble déjà
réduit. C'est la leçon de ``tokens_per_user`` de l'ancien moteur, qui scannait
toute la table sans filtre de date.

Sémantique des compteurs (cf. docs/token-counters.md)
=====================================================
- ``input_tokens`` / ``output_tokens`` : usage RÉEL du backend pour le tour.
  En mode outils, ``input_tokens`` est le cumul des prompts de toutes les
  itérations — c'est la vérité de facturation, pas l'occupation du contexte.
- ``submitted_tokens`` : identique à ``input_tokens`` sur le chemin outils,
  conservé séparément pour rester explicite dans les vues.
- ``thinking_tokens`` : part de RAISONNEMENT du tour. **Sous-ensemble de
  ``output_tokens``**, jamais un troisième terme : « réponse » (texte visible +
  appels d'outils) se dérive par ``output_tokens - thinking_tokens``. Mesuré
  dans la boucle (cf. ``llm_core._think_tokens``) parce qu'aucun backend local
  ne le déclare. 0 sur les lignes antérieures à la migration 0014.
- ``cache_read_tokens`` : jetons d'entrée repris d'un cache. Anthropic : NON
  inclus dans ``input_tokens`` ; llama.cpp et moteurs compatibles OpenAI
  (``prompt_tokens_details.cached_tokens``, sinon ``timings.cache_n``) :
  jetons repris du cache KV, INCLUS dans ``input_tokens``.
  ``cache_creation_tokens`` : Anthropic seulement (0 ailleurs).
- ``run_id`` : l'exécution (``runs``, L5.2) du tour ; vide hors exécution.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional

from shared_infra.db._connection import db_conn
from shared_infra.db._dialect import greatest

logger = logging.getLogger("uvicorn.error")



# Dimensions autorisées pour les regroupements (anti-injection : jamais de
# nom de colonne interpolé hors de cette table).
_GROUP_COLUMNS = {
    "user_id": "user_id",
    "source": "source",
    "model": "model",
    "status": "status",
    "path": "path",
    "connector": "connector",
}

# Métriques agrégeables et leur expression SQL.
_METRIC_EXPR = {
    "tokens": "COALESCE(SUM(input_tokens + output_tokens), 0)",
    "input": "COALESCE(SUM(input_tokens), 0)",
    "output": "COALESCE(SUM(output_tokens), 0)",
    # Réflexion ⊆ sortie : « response » est la sortie MOINS le raisonnement,
    # pas une colonne. MAX(...,0) contre une ligne aberrante (mesure estimée
    # supérieure à la sortie sur un très vieil enregistrement).
    "thinking": "COALESCE(SUM(thinking_tokens), 0)",
    "response": f"COALESCE(SUM({greatest('output_tokens - thinking_tokens', '0')}), 0)",
    "turns": "COUNT(*)",
    "duration_ms": "COALESCE(SUM(duration_ms), 0)",
    "iterations": "COALESCE(SUM(iterations), 0)",
}


def _int(v: Any) -> int:
    try:
        n = int(v or 0)
    except (TypeError, ValueError):
        return 0
    return n if n > 0 else 0


def record_usage(
    *,
    user_id: Optional[int] = None,
    source: str = "unknown",
    origin_id: str = "",
    parent_id: str = "",
    model: str = "",
    connector: str = "",
    path: str = "",
    input_tokens: Any = 0,
    output_tokens: Any = 0,
    submitted_tokens: Any = 0,
    thinking_tokens: Any = 0,
    cache_read_tokens: Any = 0,
    cache_creation_tokens: Any = 0,
    duration_ms: Any = 0,
    iterations: Any = 0,
    status: str = "ok",
    error_kind: str = "",
    ts: Optional[float] = None,
    run_id: str = "",
) -> bool:
    """Enregistre un tour. Best-effort : retourne False au lieu de lever.

    Un tour sans aucun token ET sans erreur n'est pas enregistré : c'est du
    bruit (pré-vol annulé avant tout appel) qui gonflerait le compteur de
    tours et fausserait « tokens / tour »."""
    in_t, out_t = _int(input_tokens), _int(output_tokens)
    # Réflexion ⊆ sortie : borne posée à l'écriture pour que la contrainte soit
    # vraie EN BASE, et pas seulement dans la vue qui l'a calculée.
    think_t = min(_int(thinking_tokens), out_t) if out_t else _int(thinking_tokens)
    st = (status or "ok").strip() or "ok"
    if in_t == 0 and out_t == 0 and st == "ok":
        return False
    try:
        uid = int(user_id) if user_id is not None else None
    except (TypeError, ValueError):
        uid = None
    try:
        with db_conn() as conn:
            conn.execute(
                """
                INSERT INTO usage_events(
                    ts, user_id, source, origin_id, parent_id,
                    model, connector, path,
                    input_tokens, output_tokens, submitted_tokens,
                    thinking_tokens,
                    cache_read_tokens, cache_creation_tokens,
                    duration_ms, iterations, status, error_kind, run_id)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    float(ts if ts is not None else time.time()), uid,
                    (source or "unknown").strip() or "unknown",
                    str(origin_id or ""), str(parent_id or ""),
                    str(model or ""), str(connector or ""), str(path or ""),
                    in_t, out_t, _int(submitted_tokens), think_t,
                    _int(cache_read_tokens), _int(cache_creation_tokens),
                    _int(duration_ms), _int(iterations),
                    st, str(error_kind or "")[:120], str(run_id or "")[:191],
                ),
            )
            conn.commit()
        return True
    except Exception:
        logger.debug("[usage] record_usage failed (non-fatal)", exc_info=True)
        return False


# ── Lecture ─────────────────────────────────────────────────────────────────

def _where(since: float, until: Optional[float], filters: Dict[str, Any]) -> tuple:
    sql = ["ts > ?"]
    params: List[Any] = [float(since)]
    if until is not None:
        sql.append("ts <= ?")
        params.append(float(until))
    for key, val in (filters or {}).items():
        if val is None or key not in _GROUP_COLUMNS:
            continue
        if isinstance(val, (list, tuple, set)):
            vals = list(val)
            if not vals:
                continue
            sql.append(f"{_GROUP_COLUMNS[key]} IN ({','.join('?' * len(vals))})")
            params.extend(vals)
        else:
            sql.append(f"{_GROUP_COLUMNS[key]} = ?")
            params.append(val)
    return " AND ".join(sql), params


def usage_totals(since: float, until: Optional[float] = None, **filters) -> Dict[str, Any]:
    """Totaux sur la fenêtre : tokens, tours, erreurs, cache, durée."""
    where, params = _where(since, until, filters)
    with db_conn() as conn:
        row = conn.execute(
            f"""
            SELECT COUNT(*) AS turns,
                   COALESCE(SUM(input_tokens), 0)  AS input_tokens,
                   COALESCE(SUM(output_tokens), 0) AS output_tokens,
                   COALESCE(SUM(thinking_tokens), 0) AS thinking_tokens,
                   COALESCE(SUM(cache_read_tokens), 0)     AS cache_read_tokens,
                   COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
                   COALESCE(SUM(duration_ms), 0)   AS duration_ms,
                   COALESCE(SUM(iterations), 0)    AS iterations,
                   COALESCE(SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END), 0) AS failures,
                   COUNT(DISTINCT user_id)         AS users
            FROM usage_events WHERE {where}
            """,
            params,
        ).fetchone()
    out = dict(row) if row else {}
    out["total_tokens"] = int(out.get("input_tokens", 0)) + int(out.get("output_tokens", 0))
    # « Réponse » = sortie moins réflexion (dérivée, jamais stockée) : les deux
    # moitiés de la sortie sont ainsi lisibles sans que personne n'ait à
    # soustraire — et sans risque d'additionner la réflexion au total.
    out["response_tokens"] = max(
        0, int(out.get("output_tokens", 0)) - int(out.get("thinking_tokens", 0)))
    return out


def usage_group(
    dimension: str,
    since: float,
    until: Optional[float] = None,
    *,
    metric: str = "tokens",
    limit: int = 10,
    **filters,
) -> List[Dict[str, Any]]:
    """Top ``limit`` valeurs d'une dimension, triées par ``metric`` décroissant.

    Retourne aussi les tours et tokens de chaque groupe : une vue « pics » a
    besoin des deux (un utilisateur peut faire peu de tours très lourds)."""
    col = _GROUP_COLUMNS.get(dimension)
    expr = _METRIC_EXPR.get(metric)
    if not col or not expr:
        return []
    where, params = _where(since, until, filters)
    with db_conn() as conn:
        rows = conn.execute(
            f"""
            SELECT {col} AS "key",
                   {expr} AS value,
                   COUNT(*) AS turns,
                   COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens,
                   COALESCE(SUM(thinking_tokens), 0) AS thinking_tokens,
                   COALESCE(SUM(duration_ms), 0) AS duration_ms,
                   COALESCE(SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END), 0) AS failures
            FROM usage_events WHERE {where}
            GROUP BY {col} ORDER BY value DESC LIMIT ?
            """,
            [*params, max(1, int(limit))],
        ).fetchall()
    return [dict(r) for r in rows]


# ── Purge (rétention automatique + reset manuel) ────────────────────────────



def delete_usage_events(from_ts: Optional[float] = None,
                        to_ts: Optional[float] = None) -> int:
    """Supprime la fenêtre demandée. Sans bornes : vide la table."""
    sql, params = ["1=1"], []
    if from_ts is not None:
        sql.append("ts >= ?"); params.append(float(from_ts))
    if to_ts is not None:
        sql.append("ts <= ?"); params.append(float(to_ts))
    with db_conn() as conn:
        cur = conn.execute(
            f"DELETE FROM usage_events WHERE {' AND '.join(sql)}", params)
        n = cur.rowcount
        conn.commit()
    return int(n or 0)


def purge_usage_events(retention_days: int = 90) -> int:
    """Rétention (passe de maintenance). ``<=0`` → no-op. Ne lève jamais."""
    if retention_days <= 0:
        return 0
    try:
        n = delete_usage_events(to_ts=time.time() - retention_days * 86400)
        if n:
            logger.info("[maintenance] %d usage_events purgé(s) (>%dj).", n, retention_days)
        return n
    except Exception:
        logger.debug("[maintenance] purge_usage_events failed (non-fatal)", exc_info=True)
        return 0
