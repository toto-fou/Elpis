# SPDX-License-Identifier: MIT
"""
shared_infra.observability.metrics.daily_report — Rapport quotidien d'usage de l'IA d'équipe.

Construit un snapshot CURÉ des KPI pertinents pour un suivi quotidien d'équipe,
en RÉUTILISANT le moteur de métriques existant (``metrics/engine.py`` — aucun
nouveau tracking). Le snapshot est :
  • affiché à l'écran (zone Métriques admin, « Rapport du jour ») ;
  • exportable / imprimable ;
  • persisté une fois par jour (``daily_usage_reports``) et notifié aux admins
    (digest automatique, déclenché par la passe de maintenance leader-only).

Le digest est IDEMPOTENT par jour : si un rapport existe déjà pour la date, on
ne régénère pas et on ne re-notifie pas (évite les doublons après un redémarrage
en cours de journée).
"""
from __future__ import annotations

import logging
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

logger = logging.getLogger("uvicorn.error")

# ── Catalogue curé : sections ordonnées → widgets (source de vérité partagée
#    front/back pour le rendu du rapport). Tous les ids existent déjà dans
#    ``metrics/engine.py`` (vérifiés). ───────────────────────────────────────
REPORT_SECTIONS: List[Dict[str, Any]] = [
    {"id": "adoption", "label": "Adoption",
     "widgets": ["kpi_dau", "kpi_chats", "kpi_new_chats", "kpi_logins"]},
    {"id": "volume", "label": "Volume",
     "widgets": ["kpi_messages", "usage_tokens", "usage_turns",
                 "usage_cache", "usage_thinking", "kpi_tool_calls", "kpi_rag_hits"]},
    {"id": "performance", "label": "Performance",
     "widgets": ["kpi_avg_tps", "kpi_latency", "kpi_latency_p95",
                 "usage_failure_rate"]},
    {"id": "models", "label": "Modèles",
     "widgets": ["kpi_top_model", "kpi_model_loads"]},
    # Exploitation : ce que la plateforme a fait sans personne devant l'écran.
    # Absente de l'ancien rapport, qui ne parlait que d'activité humaine.
    {"id": "exploitation", "label": "Exploitation",
     "widgets": ["routine_runs", "scheduler_health", "usage_offhours"]},
    {"id": "health", "label": "Santé plateforme",
     "widgets": ["kpi_uptime", "kpi_db_size", "kpi_ram", "kpi_llm_status"]},
    {"id": "charts", "label": "Graphiques",
     "widgets": ["usage_timeline", "usage_input_timeline", "usage_thinking_timeline",
                 "usage_by_model", "tools_usage",
                 "usage_top_users", "latency_percentiles", "active_users_day",
                 "routine_runs_timeline"]},
]

# Liste plate dédupliquée (ordre préservé) des ids à calculer.
REPORT_WIDGET_IDS: List[str] = list(dict.fromkeys(
    wid for s in REPORT_SECTIONS for wid in s["widgets"]))


def _today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def build_daily_report(scope_hours: int = 24, date: Optional[str] = None) -> Dict[str, Any]:
    """Calcule le snapshot du rapport (sans le persister).

    Réutilise ``registry.get_widgets_data`` — les providers inconnus/en erreur
    sont gérés par le moteur (clé ``{"error": ...}``)."""
    from shared_infra.observability.metrics.engine import registry
    widgets = registry.get_widgets_data(REPORT_WIDGET_IDS, scope_hours=scope_hours)
    wanted = set(REPORT_WIDGET_IDS)
    titles = {p.id: p.title for p in registry.providers if p.id in wanted}
    return {
        "date": date or _today(),
        "generated_at": time.time(),
        "scope_hours": scope_hours,
        "sections": REPORT_SECTIONS,
        "titles": titles,
        "widgets": widgets,
    }


def _val(widgets: Dict[str, Any], wid: str) -> str:
    """Valeur affichable d'un KPI ``value`` (avec unité), ou « — » si absent."""
    d = widgets.get(wid)
    if not isinstance(d, dict) or "error" in d or d.get("value") is None:
        return "—"
    unit = d.get("unit") or ""
    return f"{d['value']} {unit}".strip()


def _summary_text(payload: Dict[str, Any]) -> str:
    """Résumé court (corps de la notification admin)."""
    w = payload.get("widgets") or {}
    return (
        f"Utilisateurs actifs : {_val(w, 'kpi_dau')} · "
        f"Messages : {_val(w, 'kpi_messages')} · "
        f"Tokens : {_val(w, 'usage_tokens')}\n"
        f"Appels outils : {_val(w, 'kpi_tool_calls')} · "
        f"RAG : {_val(w, 'kpi_rag_hits')} · "
        f"Vitesse : {_val(w, 'kpi_avg_tps')} · "
        f"Latence : {_val(w, 'kpi_latency')} · "
        f"Échecs : {_val(w, 'usage_failure_rate')}\n"
        f"Runs de routines : {_val(w, 'routine_runs')} · "
        f"Hors plage : {_val(w, 'usage_offhours')} · "
        f"Modèle dominant : {_val(w, 'kpi_top_model')}"
    )


def _date_to_ref_id(date: str) -> Optional[int]:
    """Encode ``YYYY-MM-DD`` en entier ``YYYYMMDD`` pour ``ref_id`` (deep-link
    vers le rapport de CETTE date). Retourne ``None`` si la date est inattendue."""
    try:
        return int(str(date).replace("-", ""))
    except (TypeError, ValueError):
        return None


def _notify_admins(date: str, payload: Dict[str, Any]) -> int:
    """Crée une notification « Rapport d'usage IA » pour chaque admin/staff +
    pousse le badge live SSE enrichi (best-effort). Retourne le nb d'admins
    notifiés. ``ref_id`` porte la date (YYYYMMDD) pour un deep-link précis."""
    from shared_infra.accounts.users import get_all_users
    from shared_infra.notifications.push import push_notification
    title = f"Rapport d'usage IA — {date}"
    body = _summary_text(payload)
    ref_id = _date_to_ref_id(date)
    admins = [u for u in get_all_users() if u.get("is_admin") in (1, 2)]
    for u in admins:
        push_notification(int(u["id"]), "daily_report", title, body=body,
                          ref_type="daily_report", ref_id=ref_id)
    return len(admins)


def generate_and_store_daily_digest(date: Optional[str] = None,
                                    force: bool = False) -> Optional[str]:
    """Génère + persiste + notifie le digest du jour. Idempotent (skip si déjà
    présent et ``force`` False). Retourne la date générée, ou None si skip.

    SYNC — appelée via ``asyncio.to_thread`` depuis la passe de maintenance."""
    from shared_infra.observability.daily_reports_store import report_exists, store_daily_report
    date = date or _today()
    if not force and report_exists(date):
        return None
    payload = build_daily_report(scope_hours=24, date=date)
    store_daily_report(date, payload)
    n = _notify_admins(date, payload)
    logger.info("[digest] rapport quotidien %s généré + notifié à %d admin(s).", date, n)
    return date
