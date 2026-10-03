# SPDX-License-Identifier: MIT
"""
shared_infra.observability.metrics._usage_providers — Widgets branchés sur ``usage_events``.

Ce que ces widgets répondent, et que les anciens ne pouvaient pas
==================================================================
Les vues d'activité historiques lisaient ``message_sent``, émis uniquement par
la route de chat : tout ce qui tourne sans navigateur (routines, webhooks,
sous-agents) y valait zéro. Ici, la source est le registre d'usage, alimenté
DANS la boucle LLM — par où passent tous les appelants. « Qui a consommé quoi,
quand » devient donc une question qui a une réponse, la nuit comme le jour.

Trois familles :
  - **Conso** : tokens, tours, échecs, cache — en valeurs RÉELLES et comptées
    une seule fois (l'ancien ``total_tokens`` était journalisé deux fois pour
    un même tour outillé).
  - **Attribution** : par utilisateur, par source, par modèle réel, avec
    détection des pics et part hors plage de bureau.
  - **Exploitation** : runs de routines, santé du planificateur, entretien.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Tuple

from shared_infra.db._dialect import greatest, local_part_int
from shared_infra.observability.metrics.engine import MetricProvider
from shared_infra.observability.metrics.series import (
    PALETTE,
    aggregate_series,
    granularity_for,
    plan_buckets,
    resolve_tz,
    to_chart,
)
from shared_infra.observability.usage_store import db_conn

logger = logging.getLogger("uvicorn.error")

DEFAULT_SCOPE_HOURS = 24
AVAILABLE_SCOPES: Tuple[int, ...] = (24, 168, 720)

# Libellés des sources — l'id technique ne doit jamais atteindre l'écran.
SOURCE_LABELS = {
    "chat": "Chat", "routine": "Routine", "webhook": "Webhook",
    "subagent": "Sous-agent", "title": "Titre", "compression": "Compression",
    "scenario": "Studio", "remote": "Remote code", "unknown": "Non attribué",
}
STATUS_LABELS = {
    "ok": "Réussi", "error": "Erreur", "aborted": "Interrompu",
    "timeout": "Timeout", "tool_limit": "Limite outils",
    "skipped": "Ignoré", "cancelled": "Annulé", "orphaned": "Orphelin",
    "running": "En cours",
}


class UsageProvider(MetricProvider):
    """Base des widgets du registre : ils se purgent tous de la même façon."""
    @property
    def purge_spec(self):
        return {"target": "usage_events"}


class RoutineRunsProviderBase(MetricProvider):
    """Base des widgets de runs. Purger ici efface le JOURNAL des runs, pas
    seulement des compteurs : l'IHM doit le dire avant de confirmer."""
    @property
    def purge_spec(self):
        return {"target": "editor_routine_runs", "destructive": True}


def _scope(override: Any = None) -> int:
    try:
        h = int(override) if override is not None else DEFAULT_SCOPE_HOURS
    except (TypeError, ValueError):
        h = DEFAULT_SCOPE_HOURS
    return h if h in AVAILABLE_SCOPES else DEFAULT_SCOPE_HOURS


def _since(hours: int) -> float:
    return time.time() - hours * 3600


def _fmt_tokens(v: Any) -> str:
    """Format compact des tokens, le même que le front (``fmtTokenCount``,
    utils.js) : « 845 », « 12,3 k », « 245 k », « 1,2 M »."""
    try:
        n = max(0.0, float(v or 0))
    except (TypeError, ValueError):
        return "0"

    def _dec(x: float, digits: int) -> str:
        s = f"{x:.{digits}f}"
        if "." in s:
            s = s.rstrip("0").rstrip(".")
        return s.replace(".", ",")
    if n >= 999_500:                    # « 1 000 k » → « 1 M », comme le front
        return _dec(n / 1_000_000, 0 if n >= 1e8 else 1) + " M"
    if n >= 1000:
        return _dec(n / 1000, 0 if n >= 1e5 else 1) + " k"
    return str(int(n))


def _usernames() -> Dict[int, str]:
    """Table id → nom, en UNE requête. Les widgets affichent des noms ; la
    base, elle, ne stocke plus que des ids (un rename n'orpheline plus rien)."""
    try:
        with db_conn() as conn:
            rows = conn.execute("SELECT id, username FROM users").fetchall()
        return {int(r[0]): r[1] for r in rows}
    except Exception:
        return {}


# ── Plage « heures de bureau » ──────────────────────────────────────────────

def business_hours_cfg() -> Tuple[int, int, List[int]]:
    from shared_infra.config import (
        METRICS_BUSINESS_DAYS,
        METRICS_BUSINESS_END,
        METRICS_BUSINESS_START,
    )
    days: List[int] = []
    for part in str(METRICS_BUSINESS_DAYS or "").split(","):
        part = part.strip()
        if part.isdigit() and 1 <= int(part) <= 7:
            days.append(int(part))
    return int(METRICS_BUSINESS_START), int(METRICS_BUSINESS_END), (days or [1, 2, 3, 4, 5])


def business_sql(ts_col: str = "ts") -> str:
    """Prédicat SQL « dans la plage de bureau », en heure locale.

    ``%w`` (0 = dimanche) plutôt que ``%u`` : présent dans toutes les versions
    de SQLite embarquées, là où ``%u`` est récent. Les jours ISO configurés
    sont convertis (dimanche 7 → 0)."""
    start, end, days = business_hours_cfg()
    wdays = ",".join(str(d % 7) for d in days)
    hour = local_part_int("%H", ts_col)
    dow = local_part_int("%w", ts_col)
    return f"({hour} >= {start} AND {hour} < {end} AND {dow} IN ({wdays}))"


# ── KPI ─────────────────────────────────────────────────────────────────────

class KPIUsageTokensProvider(UsageProvider):
    """Tokens réellement consommés sur la fenêtre — entrée + sortie, comptés
    UNE fois. L'ancien KPI sommait ``total_tokens``, journalisé deux fois par
    tour outillé : il affichait environ le double."""
    id = "usage_tokens"; title = "Tokens consommés"; type = "value"
    width = "1/4"; icon = "ph-lightning"; color = "emerald"
    @property
    def category(self): return "volume"
    def get_data(self, scope_hours=None):
        from shared_infra.observability.usage_store import usage_totals
        h = _scope(scope_hours)
        t = usage_totals(_since(h))
        # Entrée et sortie détaillées sur place : sans ça, « 1,2 M entrée » ne
        # dit pas combien a été relu du cache, ni « sortie » si la plateforme
        # a répondu ou réfléchi.
        from shared_infra.observability.usage_store import token_breakdown
        b = token_breakdown(t.get("input_tokens"), t.get("output_tokens"),
                            cache_read_tokens=t.get("cache_read_tokens"),
                            thinking_tokens=t.get("thinking_tokens"))
        _detail = f"{_fmt_tokens(b['input'])} entrée"
        if b["cache"]:
            _detail += f" (cache {round(b['cache_pct'])} %)"
        _detail += f" · {_fmt_tokens(b['output'])} sortie"
        if b["thinking"]:
            _detail += f" (réflexion {round(100.0 * b['thinking'] / b['output'])} %)"
        return {"value": _fmt_tokens(t.get("total_tokens")),
                "unit": f"tokens/{'24h' if h == 24 else ('7j' if h == 168 else '30j')}",
                "color": "emerald", "icon": "ph-lightning",
                "detail": _detail}


class KPIUsageOffHoursProvider(UsageProvider):
    """Part de la consommation produite HORS plage de bureau.

    C'est le chiffre qui manquait : il dit en un coup d'œil combien la
    plateforme travaille pendant que personne ne la regarde."""
    id = "usage_offhours"; title = "Hors plage"; type = "value"
    width = "1/4"; icon = "ph-moon"; color = "violet"
    @property
    def category(self): return "activity"
    def get_data(self, scope_hours=None):
        h = _scope(scope_hours)
        with db_conn() as conn:
            row = conn.execute(
                f"""SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total,
                           COALESCE(SUM(CASE WHEN {business_sql()} THEN
                                        input_tokens + output_tokens ELSE 0 END), 0) AS inside
                    FROM usage_events WHERE ts > ?""", (_since(h),)).fetchone()
        total = float(row["total"] or 0) if row else 0.0
        inside = float(row["inside"] or 0) if row else 0.0
        out = total - inside
        pct = round(100.0 * out / total, 1) if total > 0 else 0.0
        start, end, days = business_hours_cfg()
        return {"value": f"{pct} %", "unit": "des tokens", "color": "violet",
                "icon": "ph-moon",
                "detail": f"{_fmt_tokens(out)} hors {start}h–{end}h ({len(days)} j/sem.)"}


class KPIUsageTurnsProvider(UsageProvider):
    id = "usage_turns"; title = "Tours LLM"; type = "value"
    width = "1/4"; icon = "ph-arrows-clockwise"; color = "sky"
    @property
    def category(self): return "volume"
    def get_data(self, scope_hours=None):
        from shared_infra.observability.usage_store import usage_totals
        h = _scope(scope_hours)
        t = usage_totals(_since(h))
        turns = int(t.get("turns") or 0)
        per = int((t.get("total_tokens") or 0) / turns) if turns else 0
        return {"value": turns, "unit": "tours", "color": "sky",
                "icon": "ph-arrows-clockwise",
                "detail": f"{_fmt_tokens(per)} tokens/tour · {int(t.get('iterations') or 0)} itérations"}


class KPIUsageFailureRateProvider(UsageProvider):
    """Taux d'échec RÉEL des tours.

    Les anciens widgets d'erreur lisaient ``stream_abort``, un event qui n'a
    jamais eu le moindre émetteur : ils affichaient 0 % depuis toujours. Ici
    le statut est écrit par la boucle elle-même, à chaque fin de tour."""
    id = "usage_failure_rate"; title = "Tours en échec"; type = "value"
    width = "1/4"; icon = "ph-warning-circle"; color = "rose"
    @property
    def category(self): return "performance"
    def get_data(self, scope_hours=None):
        from shared_infra.observability.usage_store import usage_totals
        h = _scope(scope_hours)
        t = usage_totals(_since(h))
        turns = int(t.get("turns") or 0)
        fails = int(t.get("failures") or 0)
        pct = round(100.0 * fails / turns, 1) if turns else 0.0
        color = "emerald" if pct < 1 else ("amber" if pct < 5 else "rose")
        state = None if pct < 1 else ("warn" if pct < 5 else "danger")
        return {"value": f"{pct} %", "unit": f"{fails}/{turns} tours",
                "color": color, "icon": "ph-warning-circle", "state": state}


class KPIUsageCacheProvider(UsageProvider):
    """Part de l'entrée relue d'un cache (cache KV de llama.cpp, cache des
    fournisseurs) plutôt que calculée : le reste est l'entrée UTILE. Le cache
    est compris dans l'entrée pour tous les moteurs (cf. ``usage_store``)."""
    id = "usage_cache"; title = "Cache de prompt"; type = "value"
    width = "1/4"; icon = "ph-database"; color = "cyan"
    @property
    def category(self): return "performance"
    def get_data(self, scope_hours=None):
        from shared_infra.observability.usage_store import usage_cache_totals
        t = usage_cache_totals(_since(_scope(scope_hours)))
        read, created = t["cache_read_tokens"], t["cache_creation_tokens"]
        if read == 0 and created == 0:
            return {"value": "—", "unit": "non utilisé", "color": "slate",
                    "icon": "ph-database"}
        total = t["input_total"]
        ratio = round(100.0 * read / total, 1) if total else 0.0
        detail = f"{_fmt_tokens(read)} en cache · {_fmt_tokens(max(0, total - read))} utiles"
        if created:
            detail += f" · {_fmt_tokens(created)} mis en cache"
        return {"value": f"{ratio} %", "unit": "de l'entrée relue du cache",
                "color": "cyan", "icon": "ph-database", "detail": detail}


class KPIUsageThinkingProvider(UsageProvider):
    """Part de la SORTIE partie en raisonnement.

    ``completion_tokens`` mélange le thinking, les appels d'outils et la
    réponse : aucune vue ne pouvait dire si un tour à 8 000 tokens de sortie
    avait rédigé ou rédigé APRÈS avoir longuement réfléchi. La mesure est faite
    dans la boucle (``llm_core._think_tokens``) et stockée à part.

    Le pourcentage se lit sur la sortie, PAS sur le total : le raisonnement ne
    s'ajoute pas à l'entrée, il en est indépendant."""
    id = "usage_thinking"; title = "Réflexion"; type = "value"
    width = "1/4"; icon = "ph-brain"; color = "amber"
    @property
    def category(self): return "volume"
    def get_data(self, scope_hours=None):
        from shared_infra.observability.usage_store import usage_totals
        t = usage_totals(_since(_scope(scope_hours)))
        out = int(t.get("output_tokens") or 0)
        think = int(t.get("thinking_tokens") or 0)
        if out <= 0:
            return {"value": "—", "unit": "aucune sortie", "color": "slate",
                    "icon": "ph-brain"}
        if think <= 0:
            # Distinct de « 0 % » : un modèle sans raisonnement et un registre
            # antérieur à la mesure se ressemblent, il ne faut pas les affirmer.
            return {"value": "—", "unit": "aucun raisonnement mesuré",
                    "color": "slate", "icon": "ph-brain",
                    "detail": f"{_fmt_tokens(out)} de sortie, tout en réponse"}
        pct = round(100.0 * think / out, 1)
        return {"value": f"{pct} %", "unit": "de la sortie", "color": "amber",
                "icon": "ph-brain",
                "detail": (f"{_fmt_tokens(think)} de réflexion · "
                           f"{_fmt_tokens(t.get('response_tokens'))} de réponse")}


class KPIRoutineRunsProvider(RoutineRunsProviderBase):
    """Runs de routines sur la fenêtre. Aucun widget admin ne lisait
    ``editor_routine_runs`` : l'exécution planifiée n'existait tout
    simplement pas du point de vue de l'exploitant."""
    id = "routine_runs"; title = "Runs de routines"; type = "value"
    width = "1/4"; icon = "ph-clock-countdown"; color = "indigo"
    @property
    def category(self): return "activity"
    def get_data(self, scope_hours=None):
        h = _scope(scope_hours)
        with db_conn() as conn:
            row = conn.execute(
                """SELECT COUNT(*) AS n,
                          SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS ko,
                          SUM(CASE WHEN status IN ('skipped','orphaned') THEN 1 ELSE 0 END) AS lost
                   FROM editor_routine_runs WHERE started_at > ?""",
                (_since(h),)).fetchone()
        n = int((row["n"] if row else 0) or 0)
        ko = int((row["ko"] if row else 0) or 0)
        lost = int((row["lost"] if row else 0) or 0)
        return {"value": n, "unit": "runs", "icon": "ph-clock-countdown",
                "color": "rose" if ko else ("amber" if lost else "indigo"),
                "state": "danger" if ko else ("warn" if lost else None),
                "detail": f"{ko} en erreur · {lost} non exécuté(s)"}


class KPISchedulerHealthProvider(MetricProvider):
    """Santé de l'exploitation : planificateur vivant, entretien à jour,
    minutes de cron enjambées. Trois signaux qu'il fallait jusqu'ici deviner
    en lisant les logs."""
    id = "scheduler_health"; title = "Planification"; type = "value"
    width = "1/4"; icon = "ph-heartbeat"; color = "teal"
    @property
    def category(self): return "system"
    @property
    def event_types(self): return ("scheduler_skip", "maintenance_pass")
    def get_data(self, scope_hours=None):
        now = time.time()
        from shared_infra.observability.metrics.process_sampler import last_heartbeat_at
        with db_conn() as conn:
            # Lit les deux formats : l'ancien (event_type='proc_scheduler_alive')
            # et le groupé (proc_sample, jauge dans tags_json).
            last_alive = last_heartbeat_at(conn)
            upkeep = conn.execute(
                "SELECT MAX(created_at) FROM metric_events "
                "WHERE event_type='maintenance_pass'").fetchone()
            skips = conn.execute(
                "SELECT COALESCE(SUM(value),0) FROM metric_events "
                "WHERE event_type='scheduler_skip' AND created_at>?",
                (now - 86400,)).fetchone()
        last_upkeep = float(upkeep[0]) if upkeep and upkeep[0] else 0.0
        n_skips = int(skips[0] or 0) if skips else 0
        # Le sampler écrit toutes les 5 min : au-delà de 15 min sans signe de
        # vie, plus personne ne tient le verrou de leader.
        ok = last_alive > 0 and (now - last_alive) < 900
        if not ok:
            return {"value": "Arrêtée", "unit": "aucun leader actif",
                    "color": "rose", "icon": "ph-heartbeat", "state": "danger"}
        upkeep_txt = ("jamais" if not last_upkeep
                      else f"il y a {int((now - last_upkeep) / 3600)} h")
        return {"value": "Active", "unit": f"entretien : {upkeep_txt}",
                "color": "amber" if n_skips else "teal", "icon": "ph-heartbeat",
                "state": "warn" if n_skips else None,
                "detail": (f"{n_skips} minute(s) enjambée(s) sur 24 h" if n_skips
                           else "aucune minute enjambée sur 24 h")}


# ── Graphiques ──────────────────────────────────────────────────────────────

class UsageTimelineProvider(UsageProvider):
    """Consommation dans le temps, empilée par source.

    Frise véritable : chaque seau porte sa date et les seaux vides valent 0 —
    une nuit calme se voit, une nuit chargée aussi."""
    id = "usage_timeline"; title = "Consommation par source"; type = "bar_stacked"
    width = "full"; icon = "ph-chart-bar"; color = "blue"
    @property
    def category(self): return "volume"
    def get_data(self, scope_hours=None):
        h = _scope(scope_hours)
        plan = plan_buckets(_since(h), None, granularity_for(h))
        agg = aggregate_series(
            table="usage_events", ts_col="ts",
            value_expr="COALESCE(SUM(input_tokens + output_tokens),0)",
            plan=plan, group_col="source")
        return to_chart(plan, agg, kind="bar", stacked=True, labels_map=SOURCE_LABELS)


class UsageTurnsTimelineProvider(UsageProvider):
    id = "usage_turns_timeline"; title = "Tours LLM dans le temps"; type = "line"
    width = "1/2"; icon = "ph-chart-line"; color = "sky"
    @property
    def category(self): return "volume"
    def get_data(self, scope_hours=None):
        h = _scope(scope_hours)
        plan = plan_buckets(_since(h), None, granularity_for(h))
        agg = aggregate_series(table="usage_events", ts_col="ts",
                               value_expr="COUNT(*)", plan=plan, group_col="status")
        return to_chart(plan, agg, kind="line", labels_map=STATUS_LABELS)


class UsageThinkingTimelineProvider(UsageProvider):
    """Sortie décomposée dans le temps : réflexion vs réponse.

    La frise « Consommation par source » montre COMBIEN ; celle-ci montre EN
    QUOI. Un modèle qui se met à ruminer (changement d'effort de réflexion,
    prompt système alourdi) se voit ici avant d'apparaître sur la facture.

    Deux agrégats sur la même table plutôt qu'un ``group_col`` : la découpe
    n'est pas une colonne mais une soustraction (réflexion ⊆ sortie)."""
    id = "usage_thinking_timeline"; title = "Sortie — réflexion vs réponse"
    type = "bar_stacked"; width = "1/2"; icon = "ph-brain"; color = "amber"
    @property
    def category(self): return "volume"
    def get_data(self, scope_hours=None):
        h = _scope(scope_hours)
        plan = plan_buckets(_since(h), None, granularity_for(h))
        series = {}
        for label, expr in (
            ("Réflexion", "COALESCE(SUM(thinking_tokens),0)"),
            ("Réponse", f"COALESCE(SUM({greatest('output_tokens - thinking_tokens', '0')}),0)"),
        ):
            agg = aggregate_series(table="usage_events", ts_col="ts",
                                   value_expr=expr, plan=plan)
            # Sans ``group_col``, l'agrégat revient sous la clé "" : on la
            # renomme pour que ``to_chart`` étiquette les deux séries.
            series[label] = agg.get("", {})
        return to_chart(plan, series, kind="bar", stacked=True)


class UsageInputTimelineProvider(UsageProvider):
    """Entrée décomposée dans le temps : relue du cache vs utile (réellement
    calculée). Jumelle de « Sortie — réflexion vs réponse » : un prompt
    système qui change à chaque tour, ou un cache KV trop petit, se voit ici
    (la part utile grimpe) avant de se sentir en latence."""
    id = "usage_input_timeline"; title = "Entrée — cache vs utile"
    type = "bar_stacked"; width = "1/2"; icon = "ph-database"; color = "cyan"
    @property
    def category(self): return "volume"
    def get_data(self, scope_hours=None):
        h = _scope(scope_hours)
        plan = plan_buckets(_since(h), None, granularity_for(h))
        series = {}
        for label, expr in (
            ("Cache", "COALESCE(SUM(cache_read_tokens),0)"),
            ("Utile", f"COALESCE(SUM({greatest('input_tokens - cache_read_tokens', '0')}),0)"),
        ):
            agg = aggregate_series(table="usage_events", ts_col="ts",
                                   value_expr=expr, plan=plan)
            series[label] = agg.get("", {})
        return to_chart(plan, series, kind="bar", stacked=True)


# Les quatre postes disjoints d'une consommation (cf. ``token_breakdown``),
# dans l'ordre des barres empilées.
_POSTES = (("Cache", "cache"), ("Entrée utile", "input_new"),
           ("Réflexion", "thinking"), ("Réponse", "response"))


def _stacked_postes(labels: List[str], rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    from shared_infra.observability.usage_store import token_breakdown
    parts = [token_breakdown(r.get("input_tokens"), r.get("output_tokens"),
                             cache_read_tokens=r.get("cache_read_tokens"),
                             thinking_tokens=r.get("thinking_tokens")) for r in rows]
    return {"labels": labels,
            "datasets": [{"label": label, "data": [p[key] for p in parts],
                          "backgroundColor": f"rgba({PALETTE[i % len(PALETTE)]},0.8)",
                          "borderRadius": 2}
                         for i, (label, key) in enumerate(_POSTES)],
            "meta": {"horizontal": True}}


class UsageBySourceProvider(UsageProvider):
    id = "usage_by_source"; title = "Répartition par source"; type = "doughnut"
    width = "1/4"; icon = "ph-chart-pie"; color = "violet"
    @property
    def category(self): return "volume"
    def get_data(self, scope_hours=None):
        from shared_infra.observability.usage_store import usage_group
        rows = usage_group("source", _since(_scope(scope_hours)), limit=12)
        colors = [f"rgb({PALETTE[i % len(PALETTE)]})" for i in range(len(rows))]
        return {"labels": [SOURCE_LABELS.get(r["key"], r["key"] or "?") for r in rows],
                "datasets": [{"label": "Tokens",
                              "data": [r["value"] for r in rows],
                              "backgroundColor": colors, "borderRadius": 4}]}


class UsageByModelProvider(UsageProvider):
    """Tokens par modèle RÉEL.

    L'ancien widget lisait un tag figé sur ``LLAMA_MODEL`` (une constante de
    configuration) : dès qu'un connecteur externe servait le tour, la
    répartition attribuait tout au modèle local."""
    id = "usage_by_model"; title = "Tokens par modèle"; type = "bar_stacked"
    width = "1/2"; icon = "ph-robot"; color = "indigo"
    @property
    def category(self): return "volume"
    def get_data(self, scope_hours=None):
        from shared_infra.observability.usage_store import usage_group
        rows = usage_group("model", _since(_scope(scope_hours)), limit=10)
        return _stacked_postes([(r["key"] or "inconnu")[:38] for r in rows], rows)


class UsageTopUsersProvider(UsageProvider):
    """Top consommateurs SUR LA FENÊTRE. L'ancien équivalent n'avait aucun
    filtre de date : il cumulait depuis toujours et scannait toute la table."""
    id = "usage_top_users"; title = "Tokens par utilisateur"; type = "bar_stacked"
    width = "1/2"; icon = "ph-users"; color = "emerald"
    @property
    def category(self): return "activity"
    def get_data(self, scope_hours=None):
        from shared_infra.observability.usage_store import usage_group
        rows = usage_group("user_id", _since(_scope(scope_hours)), limit=10)
        names = _usernames()
        return _stacked_postes([names.get(r["key"], "non attribué") for r in rows], rows)


class UsageHeatmapProvider(UsageProvider):
    """Activité jour × heure, TOUTES sources.

    L'ancienne heatmap lisait ``message_sent`` — émis par la seule route de
    chat : elle représentait les heures de présence humaine, pas l'activité de
    la plateforme. Celle-ci compte les tokens réellement consommés, d'où
    qu'ils viennent."""
    id = "usage_heatmap"; title = "Activité — jour × heure"; type = "bar_stacked"
    width = "full"; icon = "ph-calendar"; color = "violet"
    @property
    def category(self): return "activity"
    def get_data(self, scope_hours=None):
        h = _scope(scope_hours)
        with db_conn() as conn:
            rows = conn.execute(
                f"""SELECT {local_part_int('%w', 'ts')} AS dow,
                          {local_part_int('%H', 'ts')} AS hh,
                          COALESCE(SUM(input_tokens + output_tokens),0) AS v
                   FROM usage_events WHERE ts > ? GROUP BY dow, hh""",
                (_since(h),)).fetchall()
        jours = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"]
        ordre = [1, 2, 3, 4, 5, 6, 0]          # semaine ISO : lundi d'abord
        grid = {(int(r["dow"]), int(r["hh"])): float(r["v"] or 0) for r in rows}
        datasets = []
        for i, d in enumerate(ordre):
            datasets.append({
                "label": jours[d],
                "data": [grid.get((d, hh), 0) for hh in range(24)],
                "backgroundColor": f"rgba({PALETTE[i % len(PALETTE)]},0.75)",
                "borderRadius": 3, "stack": "all",
            })
        return {"labels": [f"{hh:02d}h" for hh in range(24)], "datasets": datasets,
                "meta": {"timezone": resolve_tz()[1], "stacked": True}}


class RoutineRunsTimelineProvider(RoutineRunsProviderBase):
    """Runs de routines dans le temps, empilés par statut — la vue qui
    manquait pour savoir ce qui s'est passé cette nuit."""
    id = "routine_runs_timeline"; title = "Runs de routines"; type = "bar_stacked"
    width = "1/2"; icon = "ph-clock-countdown"; color = "indigo"
    @property
    def category(self): return "activity"
    def get_data(self, scope_hours=None):
        h = _scope(scope_hours)
        plan = plan_buckets(_since(h), None, granularity_for(h))
        agg = aggregate_series(table="editor_routine_runs", ts_col="started_at",
                               value_expr="COUNT(*)", plan=plan, group_col="status")
        return to_chart(plan, agg, kind="bar", stacked=True, labels_map=STATUS_LABELS)


# ── Tableau : pics par utilisateur ──────────────────────────────────────────

class UsageUserPeaksProvider(UsageProvider):
    """Pics d'activité par utilisateur et consommation associée.

    Pour chaque utilisateur de la fenêtre : ce qu'il a consommé, en combien de
    tours, quand se situe son pic (le seau le plus lourd) et quelle part de sa
    consommation tombe hors plage de bureau. C'est la vue qui permet de dire
    « cette nuit, 400 k tokens : c'est la routine de Xavier à 3 h »."""
    id = "usage_user_peaks"; title = "Pics par utilisateur"; type = "table"
    width = "full"; icon = "ph-trend-up"; color = "amber"
    @property
    def category(self): return "activity"
    def get_data(self, scope_hours=None):
        h = _scope(scope_hours)
        since = _since(h)
        gran = granularity_for(h)
        plan = plan_buckets(since, None, gran)
        names = _usernames()
        with db_conn() as conn:
            totals = conn.execute(
                f"""SELECT user_id,
                           COALESCE(SUM(input_tokens + output_tokens),0) AS tokens,
                           COUNT(*) AS turns,
                           COALESCE(SUM(CASE WHEN NOT {business_sql()} THEN
                                        input_tokens + output_tokens ELSE 0 END),0) AS off,
                           COALESCE(SUM(CASE WHEN status!='ok' THEN 1 ELSE 0 END),0) AS fails,
                           COUNT(DISTINCT source) AS n_sources
                    FROM usage_events WHERE ts > ?
                    GROUP BY user_id ORDER BY tokens DESC LIMIT 15""",
                (since,)).fetchall()
        # Pic : le seau le plus lourd de chaque utilisateur, sur le même
        # calendrier que les graphiques (donc lisible en regard).
        peaks = aggregate_series(
            table="usage_events", ts_col="ts",
            value_expr="COALESCE(SUM(input_tokens + output_tokens),0)",
            plan=plan, group_col="user_id")
        # Libellé lisible : un tableau se lit à l'œil, pas à la seconde près.
        # Les graphiques gardent l'ISO complet (précision dans l'infobulle).
        def _human(iso: str) -> str:
            if len(iso) >= 16:                      # 2026-08-12T14:00
                return f"{iso[8:10]}/{iso[5:7]} {iso[11:16]}"
            if len(iso) == 10:                      # 2026-08-12
                return f"{iso[8:10]}/{iso[5:7]}"
            return iso
        label_by_key = {k: _human(v) for k, v in zip(plan.keys, plan.labels)}
        rows: List[Dict[str, Any]] = []
        for r in totals:
            uid = r["user_id"]
            series = peaks.get(uid, {}) or peaks.get(str(uid), {})
            peak_key, peak_val = ("", 0.0)
            if series:
                peak_key, peak_val = max(series.items(), key=lambda kv: kv[1])
            tokens = float(r["tokens"] or 0)
            rows.append({
                "utilisateur": names.get(uid, "non attribué") if uid is not None else "non attribué",
                "tokens": _fmt_tokens(tokens),
                "tours": int(r["turns"] or 0),
                "pic": label_by_key.get(peak_key, "—"),
                "pic_tokens": _fmt_tokens(peak_val),
                "hors_plage": (f"{round(100.0 * float(r['off'] or 0) / tokens, 1)} %"
                               if tokens > 0 else "—"),
                "echecs": int(r["fails"] or 0),
            })
        return {
            "columns": [
                {"key": "utilisateur", "label": "Utilisateur"},
                {"key": "tokens", "label": "Tokens", "align": "right"},
                {"key": "tours", "label": "Tours", "align": "right"},
                {"key": "pic", "label": "Pic"},
                {"key": "pic_tokens", "label": "Au pic", "align": "right"},
                {"key": "hors_plage", "label": "Hors plage", "align": "right"},
                {"key": "echecs", "label": "Échecs", "align": "right"},
            ],
            "rows": rows,
            "meta": {"granularity": gran, "timezone": plan.tz_name},
        }


def register_all(registry) -> None:
    for provider in (
        KPIUsageTokensProvider(), KPIUsageOffHoursProvider(),
        KPIUsageTurnsProvider(), KPIUsageFailureRateProvider(),
        KPIUsageCacheProvider(), KPIUsageThinkingProvider(),
        KPIRoutineRunsProvider(),
        KPISchedulerHealthProvider(),
        UsageTimelineProvider(), UsageTurnsTimelineProvider(),
        UsageThinkingTimelineProvider(), UsageInputTimelineProvider(),
        UsageBySourceProvider(), UsageByModelProvider(),
        UsageTopUsersProvider(), UsageHeatmapProvider(),
        RoutineRunsTimelineProvider(), UsageUserPeaksProvider(),
    ):
        registry.register(provider)
