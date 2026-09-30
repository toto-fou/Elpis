# SPDX-License-Identifier: MIT
"""
backend/metrics/_v17_providers.py — Providers métrics ajoutés en v17.

Widgets centrés sur l'observabilité des outils :

  - ToolErrorRateProvider    : top 10 outils par % d'erreur
  - ToolCallVolumeProvider   : volume d'appels d'outils
  - ToolCallLatencyProvider  : latence des appels d'outils
  - KPIToolFailuresProvider  : KPI échecs outils

(Les 4 providers agentiques d'origine — subagent_usage,
subagent_error_rate, team_rounds_distribution, budget_exhaustions —
ont été retirés avec le moteur agentique : leurs event_types
subagent_call/team_round/budget_exhausted ne sont plus jamais émis,
les widgets restaient vides en permanence sur le dashboard.)

Tous supportent un param ``hours`` lu côté query (24, 168, 720) via le
mécanisme de toggle ajouté en parallèle dans le frontend. Les
providers émettent ``time_scopes_available: [24, 168, 720]`` dans leur
get_data() pour que le frontend sache quoi afficher comme onglets.

Source des données
==================

Les widgets s'appuient sur l'event ``tool_call`` (tag
``status=ok|error``) émis via ``shared_infra.db._connection.log_metric``
depuis la boucle outils du chatbot (llm_core/_chat_with_tools.py),
persisté dans la table ``metric_events`` de SQLite.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Tuple

from shared_infra.db._dialect import json_get
from shared_infra.observability.metrics.engine import MetricProvider
from shared_infra.observability.usage_store import db_conn

logger = logging.getLogger("uvicorn.error")


# ─── Default time scope ────────────────────────────────────────────────
# Les providers v17 retournent le scope demandé (24h par défaut) mais
# annoncent dans leur output les scopes disponibles pour qu'un onglet
# côté UI permette le switch. Le scope est lu depuis query.scope_hours
# dans le wrapper d'admin_stats — voir routes/admin/metrics.py.

DEFAULT_SCOPE_HOURS = 24
AVAILABLE_SCOPES_HOURS: Tuple[int, ...] = (24, 168, 720)   # 24h, 7j, 30j


def _scope_label(hours: int) -> str:
    if hours <= 24:    return "24h"
    if hours <= 168:   return "7j"
    if hours <= 720:   return "30j"
    return f"{hours}h"


def _read_scope_hours(provider: MetricProvider, override: Any = None) -> int:
    """v17 — Le scope est passé en kwarg à get_data(); à défaut, lit
    l'attribut ``_scope_hours`` sur l'instance (mode legacy de l'API
    interne). Default = 24h si rien.
    """
    if override is not None:
        try:
            return int(override)
        except (TypeError, ValueError):
            pass
    return int(getattr(provider, "_scope_hours", DEFAULT_SCOPE_HOURS) or DEFAULT_SCOPE_HOURS)


# ─── 5. Tool error rate ────────────────────────────────────────────────

class ToolErrorRateProvider(MetricProvider):
    """Top 10 outils MCP par taux d'erreur sur la fenêtre choisie.

    Source : metric_events.event_type = 'tool_call' avec tag
    ``status=ok|error``. Le tag ``error`` n'était PAS posé avant v17 ;
    les events sans status sont comptés comme ``ok`` (back-compat).

    Tri : par error_rate desc (tools les plus à problème en tête).
    Affichage : bar avec couleur graduée selon error_rate.
    """
    id    = "tool_error_rate"
    title = "Outils — taux d'erreur"
    type  = "bar"
    width = "full"
    icon  = "ph-wrench"
    color = "rose"

    @property
    def category(self): return "performance"

    @property
    def event_types(self): return ("tool_call",)

    def get_data(self, scope_hours=None):
        hours = _read_scope_hours(self, scope_hours)
        since = time.time() - hours * 3600
        tally: Dict[str, Dict[str, int]] = {}
        try:
            with db_conn() as conn:
                rows = conn.execute(f"""
                    SELECT {json_get('tags_json', 'tool')}   AS tool,
                           {json_get('tags_json', 'status')} AS st,
                           COUNT(*) AS n
                    FROM metric_events
                    WHERE event_type='tool_call' AND created_at > ?
                    GROUP BY tool, st
                """, (since,)).fetchall()
            for tool, st, n in rows:
                tool = tool or "unknown"
                bucket = tally.setdefault(tool, {"ok": 0, "error": 0, "total": 0})
                if (st or "ok") == "error":
                    bucket["error"] += n
                else:
                    bucket["ok"] += n
                bucket["total"] += n
        except Exception as e:
            logger.warning("[v17/tool_error_rate] query failed: %s", e)

        # Filtrer tools avec assez d'appels pour être statistiquement intéressants (>= 5)
        # Puis tri par error_rate desc
        sortable: List[Tuple[str, float, int]] = []
        for tool, b in tally.items():
            if b["total"] < 5:
                continue
            rate = (b["error"] / b["total"]) * 100.0
            sortable.append((tool, rate, b["total"]))
        sortable.sort(key=lambda x: (-x[1], -x[2]))
        sortable = sortable[:10]

        def _color_for(rate: float) -> str:
            if rate >= 30: return "#DC2626"  # red-600
            if rate >= 10: return "#F59E0B"  # amber-500
            if rate >= 3:  return "#FACC15"  # yellow-400
            return "#10B981"                 # emerald-500

        labels = [t for t, _, _ in sortable]
        rates  = [round(r, 1) for _, r, _ in sortable]
        return {
            "labels": labels,
            "datasets": [{
                "label": f"% erreur / {_scope_label(hours)}",
                "data":  rates,
                "backgroundColor": [_color_for(r) for r in rates],
            }],
            "tooltips": [{"tool": t, "rate": round(r, 1), "calls": n}
                         for t, r, n in sortable],
            "scope_hours": hours,
            "scopes_available": list(AVAILABLE_SCOPES_HOURS),
        }


# ─── 6. Tool call volume (tool_call_metrics, Phase 1 task #4) ──────────
#
# Les 3 providers suivants (volume / latency / failures) lisent la
# NOUVELLE table ``tool_call_metrics`` (cf. shared_infra/observability/tool_metrics_store.py)
# plutôt que ``metric_events.event_type='tool_call'``.
#
# Différence avec ``ToolErrorRateProvider`` (ci-dessus) :
#   - tool_call_metrics a une colonne ``duration_ms`` typée et un statut
#     ``blocked`` distinct (Tool Firewall Phase 3) — métrique plus riche.
#   - les events legacy ``tool_call`` continuent d'exister pour compat
#     mais les NOUVEAUX appels MCP (depuis instrumentation orchestrator
#     ``_execute_mcp_tool``) sont uniquement enregistrés dans la nouvelle
#     table.
#
# Le frontend admin peut afficher les deux jusqu'à ce que la table
# legacy soit décommissionnée en Phase 6.

class ToolCallVolumeProvider(MetricProvider):
    """Top 10 outils par nombre d'appels (toutes statuses confondues).

    Source : ``tool_call_metrics`` (Phase 1 task #4).
    """
    id    = "tool_call_volume"
    title = "Outils — volume d'appels"
    type  = "bar"
    width = "full"
    icon  = "ph-stack"
    color = "blue"

    @property
    def category(self): return "performance"

    def get_data(self, scope_hours=None):
        hours = _read_scope_hours(self, scope_hours)
        since = time.time() - hours * 3600
        rows: List[Tuple[str, int]] = []
        try:
            with db_conn() as conn:
                rows = list(conn.execute("""
                    SELECT tool_name, COUNT(*) AS n
                    FROM tool_call_metrics
                    WHERE ts > ?
                    GROUP BY tool_name
                    ORDER BY n DESC
                    LIMIT 10
                """, (since,)).fetchall())
        except Exception as e:
            logger.warning("[v17/tool_call_volume] query failed: %s", e)

        labels = [r[0] for r in rows]
        counts = [int(r[1]) for r in rows]
        return {
            "labels": labels,
            "datasets": [{
                "label": f"appels / {_scope_label(hours)}",
                "data": counts,
                "backgroundColor": "#3B82F6",  # blue-500
            }],
            "scope_hours": hours,
            "scopes_available": list(AVAILABLE_SCOPES_HOURS),
        }


class ToolCallLatencyProvider(MetricProvider):
    """Top 10 outils les plus lents (durée moyenne des appels success).

    Source : ``tool_call_metrics``, filtre ``status='success'`` (les
    erreurs/timeouts sont sortis pour ne pas biaiser la moyenne avec des
    durées tronquées par des aborts).
    """
    id    = "tool_call_latency"
    title = "Outils — latence moyenne"
    type  = "bar"
    width = "full"
    icon  = "ph-gauge"
    color = "amber"

    @property
    def category(self): return "performance"

    def get_data(self, scope_hours=None):
        hours = _read_scope_hours(self, scope_hours)
        since = time.time() - hours * 3600
        rows: List[Tuple[str, float, int]] = []
        try:
            with db_conn() as conn:
                rows = list(conn.execute("""
                    SELECT tool_name,
                           AVG(duration_ms) AS avg_ms,
                           COUNT(*)         AS n
                    FROM tool_call_metrics
                    WHERE ts > ? AND status='success'
                    GROUP BY tool_name
                    HAVING COUNT(*) >= 3
                    ORDER BY avg_ms DESC
                    LIMIT 10
                """, (since,)).fetchall())
        except Exception as e:
            logger.warning("[v17/tool_call_latency] query failed: %s", e)

        def _color_for(ms: float) -> str:
            if ms >= 5000: return "#DC2626"   # red-600 — > 5s
            if ms >= 1000: return "#F59E0B"   # amber-500 — > 1s
            if ms >= 200:  return "#FACC15"   # yellow-400 — > 200ms
            return "#10B981"                  # emerald-500 — rapide

        labels = [r[0] for r in rows]
        avgs   = [round(float(r[1]), 1) for r in rows]
        return {
            "labels": labels,
            "datasets": [{
                "label": f"durée moyenne (ms) / {_scope_label(hours)}",
                "data":  avgs,
                "backgroundColor": [_color_for(m) for m in avgs],
            }],
            "tooltips": [{"tool": t, "avg_ms": round(float(m), 1), "calls": int(n)}
                         for t, m, n in rows],
            "scope_hours": hours,
            "scopes_available": list(AVAILABLE_SCOPES_HOURS),
        }


class KPIToolFailuresProvider(MetricProvider):
    """KPI : nombre total d'appels d'outils en échec sur la fenêtre choisie.

    Compte ``status != 'success'`` (regroupe error + blocked + timeout).
    ``blocked`` viendra du Tool Firewall (Phase 3) — un compteur élevé y
    indiquera des configurations ACL trop strictes ou des LLMs qui
    tentent des actions interdites.
    """
    id    = "kpi_tool_failures"
    title = "Outils en échec"
    type  = "value"
    width = "1/4"
    icon  = "ph-warning-octagon"
    color = "rose"

    @property
    def category(self): return "performance"

    def get_data(self, scope_hours=None):
        hours = _read_scope_hours(self, scope_hours)
        since = time.time() - hours * 3600
        n = 0
        try:
            with db_conn() as conn:
                n = int(conn.execute(
                    "SELECT COUNT(*) FROM tool_call_metrics "
                    "WHERE ts > ? AND status != 'success'",
                    (since,),
                ).fetchone()[0])
        except Exception as e:
            logger.warning("[v17/kpi_tool_failures] query failed: %s", e)
        return {
            "value": n,
            "unit":  f"échecs / {_scope_label(hours)}",
            "color": "rose",
            "icon":  "ph-warning-octagon",
            "state": "warn" if n else None,
            "scope_hours": hours,
            "scopes_available": list(AVAILABLE_SCOPES_HOURS),
        }


# ─── Registry helper ───────────────────────────────────────────────────

def register_all(registry) -> None:
    """Enregistre les providers v17 dans le registry global.

    Appelé depuis backend/metrics/engine.py à la fin du fichier (voir
    ligne d'inscription). Séparé en helper pour qu'un test puisse
    register dans un registry isolé.

    4 providers outils (les 4 providers agentiques ont été retirés
    avec le moteur agentique — event_types plus jamais émis).
    """
    registry.register(ToolErrorRateProvider())
    # Phase 1 task #5 — observability dashboard
    registry.register(ToolCallVolumeProvider())
    registry.register(ToolCallLatencyProvider())
    registry.register(KPIToolFailuresProvider())
