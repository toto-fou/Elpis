# SPDX-License-Identifier: MIT
"""
Admin metrics & stats endpoints (prometheus, dashboards, export, widgets).

Auto-extracted from the former monolithic ``backend/routes/admin.py``.
The endpoint bodies are byte-for-byte identical to the originals.
"""
from __future__ import annotations

import asyncio
import logging
import secrets
import time
from typing import Any, Dict, List, Optional

from fastapi import HTTPException, Request
from fastapi.responses import (
    JSONResponse,
)

from shared_infra.accounts.users import (
    get_user_by_id,
)
from shared_infra.config import (
    read_config_json,
    write_config_json,
)
from shared_infra.db._connection import db
from shared_infra.db._dialect import local_datetime
from shared_infra.observability.metrics.engine import registry as metrics_registry

# Helpers shared with _legacy. Single source of truth.
# Routers — owned by ``_state``. We import them so endpoint decorators
# below register on the SAME singleton router instances mounted by
# ``app.py`` / ``admin_app.py``.
from shared_infra.routes.admin._state import admin_router
from shared_infra.security.deps import require_user_id

logger = logging.getLogger("uvicorn.error")


@admin_router.get("/api/admin/stats-dynamic")
def api_admin_stats_dynamic(request: Request, scope_hours: int = 24,
                            ids: Optional[str] = None):
    """Layout + données du tableau de bord.

    ``scope_hours`` (24/168/720) est propagé à tous les providers.
    ``ids`` (liste séparée par des virgules) ne recalcule QUE les widgets
    demandés : la boucle « live » du front rafraîchissait deux graphiques en
    recalculant les soixante providers toutes les trois secondes — l'essentiel
    du travail SQL de la console partait là.
    """
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] not in (1, 2): raise HTTPException(403, "Staff required")
    # Clamp to known sane values (avoid pathological queries)
    if scope_hours not in (24, 168, 720):
        scope_hours = 24
    if ids:
        wanted = [s.strip() for s in str(ids).split(",") if s.strip()][:40]
        return JSONResponse(
            {"data": metrics_registry.get_widgets_data(wanted, scope_hours=scope_hours),
             "partial": True},
            headers={"Cache-Control": "no-cache"})
    return JSONResponse(metrics_registry.get_dashboard_config(scope_hours=scope_hours),
                        headers={"Cache-Control": "no-cache"})


def _scrape_token() -> str:
    """Jeton de scrape courant (vide = non configuré)."""
    try:
        cfg = read_config_json() or {}
        return str(((cfg.get("metrics") or {}).get("scrape_token") or "")).strip()
    except Exception:
        return ""


def _scrape_authorized(request: Request) -> bool:
    """Autorise un scrape sans session : ``Authorization: Bearer <jeton>`` ou
    ``?token=<jeton>``.

    Le endpoint Prometheus exigeait un cookie d'admin — donc inutilisable par
    un scraper, qui n'a pas de navigateur. Même présentation que les webhooks
    entrants (en-tête ou query) et même comparaison à temps constant."""
    token = _scrape_token()
    if not token:
        return False
    presented = ""
    auth = request.headers.get("authorization") or ""
    if auth.lower().startswith("bearer "):
        presented = auth[7:].strip()
    if not presented:
        presented = (request.query_params.get("token") or "").strip()
    if not presented:
        return False
    return secrets.compare_digest(token, presented)


@admin_router.get("/api/admin/metrics/scrape-token")
def api_admin_scrape_token_get(request: Request):
    """État du jeton de scrape (admin strict). Le jeton est renvoyé en clair :
    c'est un secret d'instance que son propriétaire doit pouvoir recopier dans
    la configuration de son collecteur."""
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] != 1:
        raise HTTPException(403, "Admin required")
    tok = _scrape_token()
    return JSONResponse({"configured": bool(tok), "token": tok or None},
                        headers={"Cache-Control": "no-store"})


@admin_router.post("/api/admin/metrics/scrape-token")
async def api_admin_scrape_token_set(request: Request):
    """``{action: "generate"|"revoke"}`` — génère ou révoque le jeton."""
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] != 1:
        raise HTTPException(403, "Admin required")
    try:
        body = await request.json()
    except Exception:
        body = {}
    action = str((body or {}).get("action") or "generate")
    if action not in ("generate", "revoke"):
        raise HTTPException(400, "Action inconnue")
    token = "" if action == "revoke" else secrets.token_urlsafe(32)
    cfg = read_config_json() or {}
    cfg.setdefault("metrics", {})["scrape_token"] = token
    write_config_json(cfg)
    try:
        from shared_infra.security.audit import audit_event
        audit_event(user_id=uid, username=(me["username"] if me else None),
                    action=f"admin.metrics.scrape_token.{action}", details={})
    except Exception:
        pass
    return JSONResponse({"configured": bool(token), "token": token or None},
                        headers={"Cache-Control": "no-store"})


@admin_router.get("/api/admin/metrics/prometheus")
def api_admin_metrics_prometheus(request: Request):
    """Prometheus-compatible /metrics endpoint for external dashboards.

    Deux authentifications acceptées : la session admin (consultation depuis
    la console) ou le jeton de scrape (collecteur externe)."""
    if not _scrape_authorized(request):
        uid = require_user_id(request)
        me = get_user_by_id(uid)
        if not me or me["is_admin"] not in (1, 2): raise HTTPException(403, "Staff required")

    from shared_infra.db._connection import db as _db
    lines = []
    lines.append("# HELP elpis_up Application is running")
    lines.append("# TYPE elpis_up gauge")
    lines.append("elpis_up 1")

    try:
        conn = _db(); cur = conn.cursor()

        # Total users
        cur.execute("SELECT COUNT(*) FROM users")
        lines.append("# HELP elpis_users_total Total registered users")
        lines.append("# TYPE elpis_users_total gauge")
        lines.append(f"elpis_users_total {cur.fetchone()[0]}")

        # Total chats
        cur.execute("SELECT COUNT(*) FROM chats WHERE archived=0")
        lines.append("# HELP elpis_chats_active Total active chats")
        lines.append("# TYPE elpis_chats_active gauge")
        lines.append(f"elpis_chats_active {cur.fetchone()[0]}")

        # Total messages (assistant replies = metric_events avec role=assistant)
        # La table `messages` n'existe pas — les messages sont dans metric_events.
        cur.execute("""
            SELECT COUNT(*) FROM metric_events
            WHERE event_type='message_sent'
              AND tags_json LIKE '%"role": "assistant"%'
        """)
        lines.append("# HELP elpis_messages_total Total assistant messages")
        lines.append("# TYPE elpis_messages_total gauge")
        lines.append(f"elpis_messages_total {cur.fetchone()[0]}")

        # Tokens last 24h
        since_24h = time.time() - 86400
        # (``elpis_tokens_24h`` retirée : elle sommait ``total_tokens`` de
        #  ``metric_events``, une série que plus personne n'émet depuis que la
        #  consommation vit dans ``usage_events``. Elle aurait exporté 0 pour
        #  toujours. Remplacée par ``elpis_tokens_total{window="1d|7d|30d"}``.)

        # Avg TPS last 1h
        since_1h = time.time() - 3600
        cur.execute("SELECT AVG(value) FROM metric_events WHERE event_type='write_tps' AND created_at>?", (since_1h,))
        avg_tps = cur.fetchone()[0]
        lines.append("# HELP elpis_avg_tps Average tokens per second (1h)")
        lines.append("# TYPE elpis_avg_tps gauge")
        lines.append(f"elpis_avg_tps {round(avg_tps, 2) if avg_tps else 0}")

        # Avg latency last 1h
        cur.execute("SELECT AVG(value) FROM metric_events WHERE event_type='llm_latency' AND created_at>?", (since_1h,))
        avg_lat = cur.fetchone()[0]
        lines.append("# HELP elpis_avg_latency_seconds Average LLM latency in seconds (1h)")
        lines.append("# TYPE elpis_avg_latency_seconds gauge")
        lines.append(f"elpis_avg_latency_seconds {round(avg_lat, 3) if avg_lat else 0}")

        # RAG hits 24h
        cur.execute("SELECT COUNT(*) FROM metric_events WHERE event_type='rag_hit' AND created_at>?", (since_24h,))
        lines.append("# HELP elpis_rag_hits_24h RAG queries in last 24 hours")
        lines.append("# TYPE elpis_rag_hits_24h gauge")
        lines.append(f"elpis_rag_hits_24h {cur.fetchone()[0]}")

        # Tool calls 24h
        cur.execute("SELECT COUNT(*) FROM metric_events WHERE event_type='tool_call' AND created_at>?", (since_24h,))
        lines.append("# HELP elpis_tool_calls_24h Tool calls in last 24 hours")
        lines.append("# TYPE elpis_tool_calls_24h gauge")
        lines.append(f"elpis_tool_calls_24h {cur.fetchone()[0]}")

        # ── Registre d'usage (24 h) ──────────────────────────────────────
        # Ces séries remplacent l'ancien ``total_tokens`` de metric_events,
        # qui comptait deux fois chaque tour outillé et taguait un modèle
        # figé. Ici : valeurs réelles, une ligne par tour, dimensions vraies.
        def _esc(v: Any) -> str:
            return str(v or "unknown").replace('\\', '').replace('"', '')[:120]

        # Trois fenêtres — 1 j, 7 j, 30 j — pour chaque dimension. Un
        # collecteur externe ne peut PAS reconstituer une fenêtre de 30 jours
        # à partir d'une jauge à 24 h : il faut la lui donner. Le label
        # ``window`` évite de multiplier les noms de séries.
        _FENETRES = (("1d", 86400), ("7d", 7 * 86400), ("30d", 30 * 86400))

        lines.append("# HELP elpis_tokens_total Tokens consumed over the window")
        lines.append("# TYPE elpis_tokens_total gauge")
        lines.append("# HELP elpis_turns_total LLM turns over the window")
        lines.append("# TYPE elpis_turns_total gauge")
        lines.append("# HELP elpis_tokens_by_model Tokens per model over the window")
        lines.append("# TYPE elpis_tokens_by_model gauge")
        lines.append("# HELP elpis_tokens_by_source Tokens per source over the window")
        lines.append("# TYPE elpis_tokens_by_source gauge")
        lines.append("# HELP elpis_turns_by_source LLM turns per source over the window")
        lines.append("# TYPE elpis_turns_by_source gauge")
        lines.append("# HELP elpis_turns_by_status LLM turns per outcome over the window")
        lines.append("# TYPE elpis_turns_by_status gauge")
        lines.append("# HELP elpis_tokens_offhours Tokens produced outside business hours")
        lines.append("# TYPE elpis_tokens_offhours gauge")

        from shared_infra.observability.metrics._usage_providers import business_sql
        _hors = f"NOT {business_sql()}"
        for _lbl, _secs in _FENETRES:
            _since = time.time() - _secs

            cur.execute(
                "SELECT COALESCE(SUM(input_tokens+output_tokens),0), COUNT(*), "
                f"COALESCE(SUM(CASE WHEN {_hors} THEN input_tokens+output_tokens "
                "ELSE 0 END),0) FROM usage_events WHERE ts>?", (_since,))
            _row = cur.fetchone() or (0, 0, 0)
            lines.append(f'elpis_tokens_total{{window="{_lbl}"}} {int(_row[0] or 0)}')
            lines.append(f'elpis_turns_total{{window="{_lbl}"}} {int(_row[1] or 0)}')
            lines.append(f'elpis_tokens_offhours{{window="{_lbl}"}} {int(_row[2] or 0)}')

            cur.execute(
                "SELECT model, COALESCE(SUM(input_tokens+output_tokens),0) "
                "FROM usage_events WHERE ts>? GROUP BY model", (_since,))
            for row in cur.fetchall():
                lines.append(f'elpis_tokens_by_model{{window="{_lbl}",'
                             f'model="{_esc(row[0])}"}} {int(row[1] or 0)}')

            cur.execute(
                "SELECT source, COALESCE(SUM(input_tokens+output_tokens),0), COUNT(*) "
                "FROM usage_events WHERE ts>? GROUP BY source", (_since,))
            for row in cur.fetchall():
                src = _esc(row[0])
                lines.append(f'elpis_tokens_by_source{{window="{_lbl}",'
                             f'source="{src}"}} {int(row[1] or 0)}')
                lines.append(f'elpis_turns_by_source{{window="{_lbl}",'
                             f'source="{src}"}} {int(row[2] or 0)}')

            cur.execute("SELECT status, COUNT(*) FROM usage_events WHERE ts>? "
                        "GROUP BY status", (_since,))
            for row in cur.fetchall():
                lines.append(f'elpis_turns_by_status{{window="{_lbl}",'
                             f'status="{_esc(row[0])}"}} {int(row[1] or 0)}')

        # ── Exploitation : runs de routines, planificateur, entretien ─────
        # Ce sont EXACTEMENT les séries qu'un opérateur veut alerter : un run
        # nocturne en échec, un planificateur sans leader, un entretien qui
        # ne tourne plus. Aucune n'était exposée.
        lines.append("# HELP elpis_routine_runs Routine runs per status over the window")
        lines.append("# TYPE elpis_routine_runs gauge")
        for _lbl, _secs in _FENETRES:
            cur.execute(
                "SELECT status, COUNT(*) FROM editor_routine_runs WHERE started_at>? "
                "GROUP BY status", (time.time() - _secs,))
            for row in cur.fetchall():
                lines.append(f'elpis_routine_runs{{window="{_lbl}",'
                             f'status="{_esc(row[0])}"}} {int(row[1] or 0)}')

        # Lit les deux formats de télémétrie de process (cf. process_sampler).
        from shared_infra.observability.metrics.process_sampler import last_heartbeat_at
        _last_alive = last_heartbeat_at(conn)
        _alive_age = (time.time() - _last_alive) if _last_alive else -1
        lines.append("# HELP elpis_scheduler_last_seen_seconds Age of the last scheduler heartbeat (-1 = never)")
        lines.append("# TYPE elpis_scheduler_last_seen_seconds gauge")
        lines.append(f"elpis_scheduler_last_seen_seconds {round(_alive_age, 1)}")

        cur.execute("SELECT MAX(created_at) FROM metric_events WHERE event_type='maintenance_pass'")
        _row = cur.fetchone()
        _upkeep_age = (time.time() - float(_row[0])) if _row and _row[0] else -1
        lines.append("# HELP elpis_maintenance_last_run_seconds Age of the last upkeep pass (-1 = never)")
        lines.append("# TYPE elpis_maintenance_last_run_seconds gauge")
        lines.append(f"elpis_maintenance_last_run_seconds {round(_upkeep_age, 1)}")

        cur.execute("SELECT COALESCE(SUM(value),0) FROM metric_events "
                    "WHERE event_type='scheduler_skip' AND created_at>?", (since_24h,))
        _row = cur.fetchone()
        lines.append("# HELP elpis_scheduler_skipped_minutes_24h Cron minutes never evaluated in last 24h")
        lines.append("# TYPE elpis_scheduler_skipped_minutes_24h gauge")
        lines.append(f"elpis_scheduler_skipped_minutes_24h {int(_row[0] or 0) if _row else 0}")

        conn.close()
    except Exception as e:
        lines.append(f"# Error: {str(e)}")

    # System metrics
    try:
        import psutil
        lines.append("# HELP elpis_cpu_percent CPU usage percent")
        lines.append("# TYPE elpis_cpu_percent gauge")
        lines.append(f"elpis_cpu_percent {psutil.cpu_percent()}")
        mem = psutil.virtual_memory()
        lines.append("# HELP elpis_memory_used_bytes Memory used in bytes")
        lines.append("# TYPE elpis_memory_used_bytes gauge")
        lines.append(f"elpis_memory_used_bytes {mem.used}")
        lines.append("# HELP elpis_memory_total_bytes Total memory in bytes")
        lines.append("# TYPE elpis_memory_total_bytes gauge")
        lines.append(f"elpis_memory_total_bytes {mem.total}")
        disk = psutil.disk_usage('/')
        lines.append("# HELP elpis_disk_used_bytes Disk used in bytes")
        lines.append("# TYPE elpis_disk_used_bytes gauge")
        lines.append(f"elpis_disk_used_bytes {disk.used}")
        lines.append("# HELP elpis_disk_total_bytes Disk total in bytes")
        lines.append("# TYPE elpis_disk_total_bytes gauge")
        lines.append(f"elpis_disk_total_bytes {disk.total}")
    except ImportError:
        pass

    # Per-process gauges (worker servant ce scrape). Réutilise les accesseurs
    # du sampler de métriques SANS persister (lecture live). En multi-worker la
    # tendance multi-jours vit dans metric_events ; ici on expose l'instantané
    # du worker scrapé, taggé par PID, pour un scrape Prometheus externe.
    try:
        import os as _os

        from shared_infra.observability.metrics.process_sampler import _SAMPLES
        pid = _os.getpid()
        lines.append("# HELP elpis_proc Per-process resource & app counters (live)")
        lines.append("# TYPE elpis_proc gauge")
        for event_type, accessor in _SAMPLES:
            try:
                val = float(accessor())
            except Exception:
                continue
            lines.append(f'elpis_proc{{metric="{event_type}",pid="{pid}"}} {val}')
    except Exception:
        pass

    # LLM server status
    try:
        from llm_core import get_llm_health_sync
        h = get_llm_health_sync()
        lines.append("# HELP elpis_llm_server_up LLM server reachable")
        lines.append("# TYPE elpis_llm_server_up gauge")
        lines.append(f"elpis_llm_server_up {1 if h.get('server_reachable') else 0}")
        kv = h.get("kv_cache", {})
        if kv.get("total", 0) > 0:
            lines.append("# HELP elpis_kv_cache_used KV cache slots used")
            lines.append("# TYPE elpis_kv_cache_used gauge")
            lines.append(f"elpis_kv_cache_used {kv['used']}")
            lines.append("# HELP elpis_kv_cache_total KV cache slots total")
            lines.append("# TYPE elpis_kv_cache_total gauge")
            lines.append(f"elpis_kv_cache_total {kv['total']}")
    except Exception:
        pass

    from starlette.responses import Response as _PlainResponse
    return _PlainResponse(
        content="\n".join(lines) + "\n",
        media_type="text/plain; version=0.0.4; charset=utf-8",
        headers={"Cache-Control": "no-cache"},
    )


@admin_router.get("/api/admin/export-metrics")
def api_export_metrics(request: Request, days: int = 7, target: str = "metric_events"):
    """Export CSV — ``target`` = ``metric_events`` (compteurs) ou
    ``usage_events`` (registre de consommation).

    Sert aussi de filet avant une purge : l'IHM propose l'export du périmètre
    concerné avant de confirmer une suppression."""
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] not in (1, 2): raise HTTPException(403, "Staff required")
    if target not in ("metric_events", "usage_events"):
        raise HTTPException(400, "Cible d'export inconnue")
    import csv
    import io

    from shared_infra.db._connection import db as _db
    conn = _db(); cur = conn.cursor()
    since = time.time() - max(1, min(3650, int(days))) * 86400
    if target == "usage_events":
        cols = ["ts", "user_id", "source", "origin_id", "parent_id", "model",
                "connector", "path", "input_tokens", "output_tokens",
                "submitted_tokens", "cache_read_tokens", "cache_creation_tokens",
                "duration_ms", "iterations", "status", "error_kind"]
        cur.execute(
            f"SELECT {local_datetime('ts')} AS ts, "
            f"{', '.join(cols[1:])} FROM usage_events WHERE ts > ? ORDER BY ts ASC",
            (since,))
    else:
        cols = ["event_type", "value", "tags", "user_id", "created_at"]
        cur.execute(f"""
            SELECT event_type, value, tags_json, user_id,
                   {local_datetime('created_at')} as created_at
            FROM metric_events WHERE created_at > ?
            ORDER BY created_at ASC
        """, (since,))
    rows = cur.fetchall(); conn.close()
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(cols)
    for r in rows:
        writer.writerow(list(r))
    buf.seek(0)
    from fastapi.responses import Response as _Response
    return _Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition":
                 f"attachment; filename={target}_{days}j_{int(time.time())}.csv"}
    )


# ── Purge / réinitialisation des métriques ───────────────────────────────────
# Jusqu'ici, la seule façon de remettre un graphique à zéro était d'attendre la
# rétention (90 jours) ou d'ouvrir la base à la main. Après un incident, une
# campagne de tests ou une migration, l'historique fausse durablement toutes
# les moyennes — et un opérateur n'a aucun moyen de repartir propre.
#
# Deux garde-fous : ``dry_run`` (obligatoire en premier appel côté IHM) annonce
# le volume AVANT de supprimer, et chaque purge effective part au journal
# d'audit avec son périmètre. Les tables purgeables sont une liste fermée : on
# ne prend pas un nom de table depuis la requête.
_PURGEABLE = {
    # cible          → (table,                  colonne de temps)
    "usage_events":         ("usage_events", "ts"),
    "metric_events":        ("metric_events", "created_at"),
    "tool_call_metrics":    ("tool_call_metrics", "ts"),
    "daily_usage_reports":  ("daily_usage_reports", "created_at"),
    "editor_routine_runs":  ("editor_routine_runs", "started_at"),
}


def _purge_where(target: str, body: Dict[str, Any]) -> tuple:
    """Construit le WHERE d'une purge. Tout est paramétré ; les seules parties
    interpolées viennent de ``_PURGEABLE`` ou de listes blanches."""
    table, ts_col = _PURGEABLE[target]
    sql: List[str] = ["1=1"]
    params: List[Any] = []
    try:
        if body.get("from") is not None:
            sql.append(f"{ts_col} >= ?"); params.append(float(body["from"]))
        if body.get("to") is not None:
            sql.append(f"{ts_col} <= ?"); params.append(float(body["to"]))
    except (TypeError, ValueError):
        raise HTTPException(400, "Bornes temporelles invalides")
    types = body.get("event_types")
    if target == "metric_events" and isinstance(types, list) and types:
        names = [str(t)[:64] for t in types][:40]
        sql.append(f"event_type IN ({','.join('?' * len(names))})")
        params.extend(names)
    sources = body.get("sources")
    if target == "usage_events" and isinstance(sources, list) and sources:
        names = [str(s)[:32] for s in sources][:20]
        sql.append(f"source IN ({','.join('?' * len(names))})")
        params.extend(names)
    return table, " AND ".join(sql), params


@admin_router.post("/api/admin/metrics/purge")
async def api_admin_metrics_purge(request: Request):
    """Purge sélective ou totale des métriques.

    Corps : ``{targets: [...], event_types?: [...], sources?: [...],
    from?: epoch, to?: epoch, dry_run?: bool}``. Sans ``targets``, rien n'est
    fait : une purge « par défaut » serait exactement l'erreur qu'on veut
    rendre impossible.
    """
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] != 1:
        raise HTTPException(403, "Admin required")     # purge = admin STRICT
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        raise HTTPException(400, "Corps JSON attendu")

    targets = body.get("targets")
    if not isinstance(targets, list) or not targets:
        raise HTTPException(400, "Aucune cible : précisez « targets »")
    unknown = [t for t in targets if t not in _PURGEABLE]
    if unknown:
        raise HTTPException(400, f"Cible inconnue : {', '.join(map(str, unknown[:3]))}")

    dry = bool(body.get("dry_run", True))

    # AUDIT 2026-09-01 (passe 5, B4) — COUNT + DELETE massifs (tables conçues
    # pour croître) + wal_checkpoint tenaient le verrou d'écriture plusieurs
    # secondes DEPUIS le thread de la boucle : générations gelées sur tout le
    # worker. Tout le travail SQL part en thread (cf. maintenance.py qui fait
    # déjà exactement ça pour ses purges).
    def _run_purge():
        counted: Dict[str, int] = {}
        deleted: Dict[str, int] = {}
        conn = db()
        try:
            for target in targets:
                table, where, params = _purge_where(target, body)
                try:
                    row = conn.execute(
                        f"SELECT COUNT(*) FROM {table} WHERE {where}", params).fetchone()
                    counted[target] = int(row[0]) if row else 0
                    if not dry:
                        cur = conn.execute(f"DELETE FROM {table} WHERE {where}", params)
                        deleted[target] = int(cur.rowcount or 0)
                except Exception as exc:                   # table absente, etc.
                    logger.warning("[metrics/purge] %s : %s", target, exc)
                    counted.setdefault(target, 0)
            if not dry:
                conn.commit()
        finally:
            try:
                conn.close()
            except Exception:
                pass
        return counted, deleted

    counted, deleted = await asyncio.to_thread(_run_purge)

    if not dry:
        try:
            from shared_infra.security.audit import audit_event
            audit_event(user_id=uid, username=(me["username"] if me else None),
                        action="admin.metrics.purge",
                        details={"targets": targets, "deleted": deleted,
                                 "from": body.get("from"), "to": body.get("to"),
                                 "event_types": body.get("event_types"),
                                 "sources": body.get("sources")})
        except Exception:
            logger.debug("[metrics/purge] audit non journalisé", exc_info=True)
        # Le WAL garde les pages supprimées jusqu'au prochain checkpoint : sans
        # ça, « j'ai purgé » ne libère rien de visible sur le disque.
        # (passe 5, B4) — checkpoint TRUNCATE = potentiellement long : thread.
        try:
            from shared_infra.db._connection import wal_checkpoint
            await asyncio.to_thread(wal_checkpoint)
        except Exception:
            pass

    return JSONResponse({"dry_run": dry, "counted": counted, "deleted": deleted},
                        headers={"Cache-Control": "no-cache"})


# NOTE — endpoints legacy retirés (réalignement admin 2026-06) :
#   * GET /api/admin/stats          → doublon de /api/admin/stats-dynamic
#     (le dashboard n'appelait plus que stats-dynamic).
#   * GET /api/admin/stats/widgets  → refresh sélectif conçu pour un
#     handler SSE « metric_dirty » jamais implémenté côté frontend.


# ── Rapport quotidien d'usage IA d'équipe ─────────────────────────────────────
# Snapshot CURÉ des KPI pertinents (cf. metrics/daily_report.py), réutilisant le
# moteur de métriques. Sert la vue « Rapport du jour » + l'historique + l'export.
@admin_router.get("/api/admin/report/daily")
def api_admin_report_daily(request: Request, date: Optional[str] = None):
    """Rapport du jour. Sans ``date`` : renvoie celui du jour (snapshot persisté
    si déjà généré par le digest, sinon calculé en direct). Avec ``date`` : le
    rapport persisté de ce jour (404 si absent)."""
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] not in (1, 2): raise HTTPException(403, "Staff required")
    from datetime import datetime as _dt

    from shared_infra.observability.daily_reports_store import get_daily_report
    from shared_infra.observability.metrics.daily_report import build_daily_report
    if date:
        rep = get_daily_report(date)
        if rep is None:
            raise HTTPException(404, "Aucun rapport pour cette date")
        return JSONResponse(rep, headers={"Cache-Control": "no-cache"})
    today = _dt.now().strftime("%Y-%m-%d")
    rep = get_daily_report(today) or build_daily_report(scope_hours=24, date=today)
    return JSONResponse(rep, headers={"Cache-Control": "no-cache"})


@admin_router.get("/api/admin/report/daily/list")
def api_admin_report_daily_list(request: Request, limit: int = 60):
    """Historique léger (dates) des rapports persistés."""
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] not in (1, 2): raise HTTPException(403, "Staff required")
    from shared_infra.observability.daily_reports_store import list_daily_reports
    return JSONResponse({"reports": list_daily_reports(max(1, min(366, limit)))},
                        headers={"Cache-Control": "no-cache"})


@admin_router.post("/api/admin/report/daily/generate")
def api_admin_report_daily_generate(request: Request):
    """Génère + persiste + notifie le digest du jour (bouton admin). ``force`` :
    régénère même si déjà présent."""
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    # Audit 2026-09-22, H6 : persiste + notifie → admin seul (le modérateur garde la lecture).
    if not me or me["is_admin"] != 1: raise HTTPException(403, "Admin required")
    from shared_infra.observability.metrics.daily_report import generate_and_store_daily_digest
    generated = generate_and_store_daily_digest(force=True)
    return JSONResponse({"ok": True, "date": generated})


@admin_router.get("/api/admin/report/daily/auto")
def api_admin_report_daily_auto_get(request: Request):
    """État du digest quotidien AUTOMATIQUE (notification 1×/jour aux admins)."""
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] not in (1, 2): raise HTTPException(403, "Staff required")
    from shared_infra.config import read_config_json
    m = (read_config_json() or {}).get("maintenance", {})
    enabled = bool(m.get("daily_digest_enabled", True)) if isinstance(m, dict) else True
    return JSONResponse({"enabled": enabled}, headers={"Cache-Control": "no-cache"})


@admin_router.post("/api/admin/report/daily/auto")
async def api_admin_report_daily_auto_set(request: Request):
    """Active/désactive le digest quotidien AUTOMATIQUE (+ sa notification).
    Persisté dans config.json, relu À CHAUD par la passe de maintenance. Le
    bouton « Générer » manuel reste disponible quel que soit cet état."""
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    # Audit 2026-09-22, H6 : écriture de config.json → admin seul (le modérateur garde la lecture).
    if not me or me["is_admin"] != 1: raise HTTPException(403, "Admin required")
    body = await request.json()
    enabled = bool((body or {}).get("enabled", False))
    from shared_infra.config import read_config_json, write_config_json
    full = read_config_json() or {}
    m = full.get("maintenance") if isinstance(full.get("maintenance"), dict) else {}
    m["daily_digest_enabled"] = enabled
    full["maintenance"] = m
    write_config_json(full)
    return JSONResponse({"ok": True, "enabled": enabled})
