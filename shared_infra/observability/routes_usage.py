# SPDX-License-Identifier: MIT
"""
shared_infra.observability.routes_usage — Métriques d'usage de l'utilisateur courant.

    GET /api/usage/me?days={1|7|30|90}  (défaut 30 ; clampé au plus proche)

Agrège, pour l'utilisateur authentifié (jamais cross-user) :
  - chats actifs / archivés (table ``chats``)
  - tokens entrée/sortie + répartition par origine (``usage_events``)
  - messages envoyés / reçus (``metric_events`` event ``message_sent``)
  - exécutions de routines (``editor_routine_runs``, scopé ``owner_user_id``)

Notes de fiabilité :
  - Les tokens viennent du registre ``usage_events`` (une ligne par tour,
    ``user_id`` entier) : la répartition entrée/sortie est TOUJOURS connue —
    l'ancien badge « estimé » venait des chemins outillés qui ne journalisaient
    qu'un total, et du double comptage entre modes. Les deux ont disparu avec
    le registre. Un rename d'utilisateur n'orpheline plus rien.
  - La SORTIE est elle-même découpée : ``thinking`` (raisonnement) et
    ``response`` (texte visible + appels d'outils). Leur somme vaut ``output``
    — la réflexion n'est pas un troisième poste, elle était jusqu'ici noyée
    dans le total « sortie ». Les tours antérieurs à la migration 0014 n'ont
    jamais porté la mesure et comptent donc 0 en réflexion.
  - Le registre compte AUSSI ce qui tourne sans navigateur (routines,
    webhooks, sous-agents) : le total d'un utilisateur peut donc dépasser ce
    que ses conversations laissent voir. C'est le but — ``by_source`` le dit.
  - ``message_sent`` reste dans ``metric_events`` (compteur d'activité
    humaine) : on borne par event_type + created_at d'abord (index), le
    ``json_extract`` ne porte que sur le sous-ensemble déjà réduit.
  - Tous les agrégats sont COALESCE(...,0) → un nouvel utilisateur reçoit un
    200 avec des zéros, jamais de 404/500.
"""
from __future__ import annotations

import logging
import time

from fastapi import Request
from fastapi.responses import JSONResponse

from shared_infra.accounts.users import get_username_by_id
from shared_infra.db._dialect import json_get
from shared_infra.observability.usage_store import db_conn, token_breakdown
from shared_infra.routes._state import router
from shared_infra.security.deps import require_user_id

logger = logging.getLogger("uvicorn.error")

_ALLOWED_DAYS = (1, 7, 30, 90)


@router.get("/api/usage/me")
def api_usage_me(request: Request, days: str = "30"):
    # ``days`` typé en str pour rester TOLÉRANT : FastAPI renverrait 422 sur un
    # int non parsable avant même d'entrer ici. On parse + clampe nous-mêmes.
    uid = require_user_id(request)
    try:
        days = int(days)
    except (TypeError, ValueError):
        days = 30
    if days not in _ALLOWED_DAYS:
        days = min(_ALLOWED_DAYS, key=lambda d: abs(d - days))

    username = get_username_by_id(uid) or f"user_{uid}"
    since = time.time() - days * 86400

    n_active = n_archived = 0
    in_tok = out_tok = total_tok = 0
    think_tok = resp_tok = 0
    parts = token_breakdown()
    estimated = False
    msg_user = msg_assistant = 0
    r_n = r_ok = r_err = r_in = r_out = 0
    r_avg = 0.0

    with db_conn() as conn:
        cur = conn.cursor()

        # 1) Chats (état courant, pas borné par days) — idx_chats_user_archived
        try:
            cur.execute(
                "SELECT COALESCE(SUM(CASE WHEN archived=0 THEN 1 ELSE 0 END),0), "
                "       COALESCE(SUM(CASE WHEN archived=1 THEN 1 ELSE 0 END),0) "
                "FROM chats WHERE user_id=?", (uid,))
            row = cur.fetchone()
            n_active, n_archived = int(row[0] or 0), int(row[1] or 0)
        except Exception as e:
            logger.debug("[usage] chats agg failed: %s", e)

        # 2) Tokens — registre d'usage : une ligne par tour, entrée et sortie
        #    toujours séparées, et TOUTES les origines comptées (chat, mais
        #    aussi routines, webhooks et sous-agents, qui n'apparaissaient
        #    nulle part ici). La répartition n'est plus « indisponible » :
        #    l'ancienne source ne journalisait qu'un total sur les chemins
        #    outillés, d'où le badge « estimé » — qui disparaît.
        try:
            cur.execute("""
                SELECT COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0),
                       COALESCE(SUM(thinking_tokens),0), COALESCE(SUM(cache_read_tokens),0),
                       COALESCE(SUM(cache_creation_tokens),0), COALESCE(SUM(tool_tokens),0)
                FROM usage_events WHERE user_id=? AND ts >= ?
            """, (uid, since))
            row = cur.fetchone()
            # Au sens des fournisseurs : l'entrée se lit cache + utile et
            # contient la part des outils ; la sortie se lit réflexion +
            # réponse (texte visible + appels d'outils). Réflexion, cache et
            # outils sont des sous-ensembles : JAMAIS ajoutés au total.
            parts = token_breakdown(row[0], row[1], thinking_tokens=row[2],
                                    cache_read_tokens=row[3], cache_creation_tokens=row[4],
                                    tool_tokens=row[5])
            in_tok, out_tok = parts["input"], parts["output"]
            think_tok, resp_tok = parts["thinking"], parts["response"]
            total_tok = in_tok + out_tok
        except Exception as e:
            logger.debug("[usage] tokens agg failed: %s", e)

        # Répartition par origine : « où sont passés mes tokens ? » est la
        # première question qu'on se pose devant un total.
        by_source = []
        try:
            cur.execute("""
                SELECT source, COALESCE(SUM(input_tokens + output_tokens),0) AS t,
                       COUNT(*) AS n, COALESCE(SUM(input_tokens),0),
                       COALESCE(SUM(output_tokens),0), COALESCE(SUM(cache_read_tokens),0),
                       COALESCE(SUM(thinking_tokens),0), COALESCE(SUM(tool_tokens),0)
                FROM usage_events WHERE user_id=? AND ts >= ?
                GROUP BY source ORDER BY t DESC
            """, (uid, since))
            for r in cur.fetchall():
                b = token_breakdown(r[3], r[4], cache_read_tokens=r[5], thinking_tokens=r[6],
                                    tool_tokens=r[7])
                by_source.append({"source": r[0], "tokens": int(r[1] or 0), "turns": int(r[2] or 0),
                                  "input": b["input"], "output": b["output"],
                                  "cache": b["cache"], "input_new": b["input_new"],
                                  "tools": b["tools"],
                                  "thinking": b["thinking"], "response": b["response"]})
        except Exception as e:
            logger.debug("[usage] by_source agg failed: %s", e)

        split_available = True

        # 3) Messages — event 'message_sent', tags {role, user}
        try:
            role = json_get("tags_json", "role")
            cur.execute(f"""
                SELECT
                  COALESCE(SUM(CASE WHEN {role}='user'      THEN 1 ELSE 0 END),0),
                  COALESCE(SUM(CASE WHEN {role}='assistant' THEN 1 ELSE 0 END),0)
                FROM metric_events
                WHERE event_type='message_sent' AND created_at >= ?
                  AND {json_get("tags_json", "user")} = ?
            """, (since, username))
            row = cur.fetchone()
            msg_user, msg_assistant = int(row[0] or 0), int(row[1] or 0)
        except Exception as e:
            logger.debug("[usage] messages agg failed: %s", e)

        # 4) Routines — scopé owner_user_id (robuste au rename)
        try:
            cur.execute("""
                SELECT COUNT(*),
                       COALESCE(SUM(CASE WHEN status='ok'    THEN 1 ELSE 0 END),0),
                       COALESCE(SUM(CASE WHEN status='error' THEN 1 ELSE 0 END),0),
                       COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0),
                       COALESCE(AVG(duration_ms),0)
                FROM editor_routine_runs
                WHERE owner_user_id=? AND started_at >= ?
            """, (uid, since))
            row = cur.fetchone()
            r_n, r_ok, r_err = int(row[0] or 0), int(row[1] or 0), int(row[2] or 0)
            r_in, r_out, r_avg = int(row[3] or 0), int(row[4] or 0), float(row[5] or 0)
        except Exception as e:
            logger.debug("[usage] routines agg failed: %s", e)

    # Les appels d'outils NE SONT PLUS agrégés ici (2026-08-16, retour user) :
    # « fs_read : 42 » ne dit rien à l'utilisateur de son propre usage, et le
    # bloc a été retiré de Réglages → Utilisation. Le détail par outil vit
    # toujours là où il sert — Administration → Observabilité, qui l'agrège
    # par sa propre route. On économise donc
    # un GROUP BY sur ``tool_call_metrics`` à chaque ouverture de l'onglet.

    return JSONResponse({
        "days": days,
        "since": since,
        "chats":    {"active": n_active, "archived": n_archived,
                     "total": n_active + n_archived},
        "messages": {"sent": msg_user, "received": msg_assistant},
        "tokens":   {"input": in_tok, "output": out_tok, "total": total_tok,
                     # Décomposition de l'ENTRÉE (somme = input) : relue du
                     # cache vs utile (réellement calculée).
                     "cache": parts["cache"], "input_new": parts["input_new"],
                     "cache_creation": parts["cache_creation"],
                     "cache_pct": parts["cache_pct"],
                     # Part de l'ENTRÉE occupée par les outils (définitions,
                     # appels et résultats re-soumis), estimée.
                     "tools": parts["tools"],
                     # Décomposition de la SORTIE (somme = output), pas du total.
                     "thinking": think_tok, "response": resp_tok,
                     "estimated": estimated, "split_available": split_available,
                     "by_source": by_source},
        "routines": {"runs": r_n, "ok": r_ok, "error": r_err,
                     "input_tokens": r_in, "output_tokens": r_out,
                     "avg_duration_ms": round(r_avg)},
    }, headers={"Cache-Control": "no-cache"})
