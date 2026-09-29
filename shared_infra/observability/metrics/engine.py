# SPDX-License-Identifier: MIT
import collections
import logging
import os
import threading
import time
from abc import ABC, abstractmethod
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, Iterable, List, Optional

import psutil

from shared_infra.db._dialect import json_get, local_strftime, round_
from shared_infra.observability.usage_store import db_conn

logger = logging.getLogger("uvicorn.error")

class BackgroundMonitor:
    """Collecte les métriques système globales en arrière-plan.

    CPU : charge globale de la machine (tous les cœurs combinés).
    RAM : pourcentage de mémoire utilisée.
    Disk I/O : débit lecture / écriture en Mo/s (delta entre deux mesures).
    Load : load average 1 min (normalisé par le nombre de cœurs).
    """
    def __init__(self):
        self.history = collections.deque(maxlen=300)
        self._cpu_count = psutil.cpu_count() or 1
        # Handle sur CE process (worker courant) pour échantillonner le
        # per-process en plus du système global. C'est le signal qui
        # désigne une fuite lente (RSS qui ne redescend jamais, fd/threads
        # qui s'accumulent) — invisible dans virtual_memory()/cpu_percent()
        # qui sont machine-wide.
        try:
            self._proc = psutil.Process(os.getpid())
        except Exception:
            self._proc = None
        t = threading.Thread(target=self._run, daemon=True); t.start()

    def _run(self):
        # Premier appel pour initialiser le compteur interne de psutil
        try:
            psutil.cpu_percent(interval=None)
            prev_disk_io = psutil.disk_io_counters()
        except Exception:
            prev_disk_io = None
        prev_time = time.monotonic()
        while True:
            time.sleep(2)
            # AUDIT 2026-08-02 (E6) — le corps de boucle n'avait AUCUN
            # try/except : une seule OSError/psutil.Error de lecture /proc
            # (montage restreint, teardown, hotplug disque) tuait le thread
            # DÉFINITIVEMENT — personne ne le join() ni ne le surveille —
            # et le dashboard admin affichait pour toujours la dernière
            # valeur, indiscernable d'une machine calme.
            try:
                self._sample_once(prev_disk_io, prev_time)
                prev_time = time.monotonic()
                try:
                    prev_disk_io = psutil.disk_io_counters()
                except Exception:
                    prev_disk_io = None
            except Exception:
                logger.warning("[metrics] itération de sampling échouée",
                               exc_info=True)

    def _sample_once(self, prev_disk_io, prev_time):
            now_mono = time.monotonic()
            dt = now_mono - prev_time
            if dt <= 0:
                dt = 2.0

            # CPU global (tous les cœurs)
            cpu = round(psutil.cpu_percent(interval=None), 1)

            # RAM
            ram = round(psutil.virtual_memory().percent, 1)

            # Disk I/O (Mo/s)
            disk_io = psutil.disk_io_counters()
            if disk_io and prev_disk_io:
                read_mbs = round((disk_io.read_bytes - prev_disk_io.read_bytes) / dt / (1024 * 1024), 2)
                write_mbs = round((disk_io.write_bytes - prev_disk_io.write_bytes) / dt / (1024 * 1024), 2)
            else:
                read_mbs = 0.0
                write_mbs = 0.0
            # AUDIT 2026-08-02 (F10) — plus de ``prev_disk_io = disk_io`` /
            # ``prev_time = now_mono`` ici : dead-stores laissés par le refactor
            # E6 (ces locaux ne sont jamais relus dans _sample_once ; c'est
            # ``_run`` qui recalcule prev_* après l'appel).

            # Load average (1 min), normalisé par le nombre de cœurs → %
            try:
                load1 = os.getloadavg()[0]
                load_pct = round(load1 / self._cpu_count * 100, 1)
            except (OSError, AttributeError):
                load_pct = cpu  # fallback Windows

            # Per-process (worker courant) : RSS Mo, descripteurs de fichiers
            # ouverts, threads. Best-effort — ne jamais casser la boucle de
            # collecte si psutil échoue (process en cours de teardown, etc.).
            rss_mb = 0.0
            num_fds = 0
            num_threads = 0
            if self._proc is not None:
                try:
                    rss_mb = round(self._proc.memory_info().rss / (1024 * 1024), 1)
                except Exception:
                    pass
                try:
                    # num_fds() est POSIX-only ; absent sur Windows.
                    num_fds = self._proc.num_fds()
                except Exception:
                    pass
                try:
                    num_threads = self._proc.num_threads()
                except Exception:
                    pass

            self.history.append({
                "time": time.strftime('%H:%M:%S'),
                "cpu": cpu,
                "ram": ram,
                "disk_read": read_mbs,
                "disk_write": write_mbs,
                "load": load_pct,
                "rss_mb": rss_mb,
                "num_fds": num_fds,
                "num_threads": num_threads,
            })

sys_monitor = BackgroundMonitor()

class MetricProvider(ABC):
    @property
    @abstractmethod
    def id(self): pass
    @property
    @abstractmethod
    def title(self): pass
    @property
    @abstractmethod
    def type(self): pass
    @property
    def width(self): return "1/2"
    @property
    def icon(self): return "ph-chart-bar"
    @property
    def color(self): return "blue"
    @property
    def category(self):
        """
        Logical group for visual grouping in the dashboard.
        Recognised values (rendered in this order in the UI):
            'activity'    — DAU/WAU/MAU, sessions, logins, chats created
            'volume'      — messages, tokens, files, totals
            'performance' — latency, throughput, error rate
            'system'      — CPU, RAM, disk, DB size, uptime
            'general'     — fallback for un-categorised widgets
        """
        return "general"
    @property
    def event_types(self):
        """
        Tuple of metric_events.event_type values whose insertion should
        trigger an automatic refresh of THIS widget on every connected
        dashboard. Empty tuple = no auto-refresh (the widget only
        updates on the regular polling interval).

        Examples :
          • KPIMessages depends on 'message_sent' → ('message_sent',)
          • KPISchedulerHealth depends on the upkeep + skip markers →
            ('scheduler_skip', 'maintenance_pass')
          • KPIDisk reads psutil and is unaffected by metric_events →
            empty tuple

        See backend/metric_broadcast.py for the wire format and
        backend/db/_legacy.py:log_metric for the publish call.
        """
        return ()
    @property
    def purge_spec(self):
        """Ce que « réinitialiser ce widget » signifie, ou ``None``.

        Le widget est seul à savoir d'où viennent ses chiffres : c'est donc
        lui qui décrit sa purge, et l'IHM n'a jamais à connaître ni table ni
        SQL. Par défaut : les ``event_types`` dont il dépend. Un widget qui
        lit psutil (RAM, disque) n'a rien à purger — il retourne None, et
        l'IHM n'affiche pas l'action."""
        types = list(self.event_types or ())
        return {"target": "metric_events", "event_types": types} if types else None
    @abstractmethod
    def get_data(self): pass

# ── Fenêtre d'observation partagée ──────────────────────────────────────────
# Le sélecteur 1 j / 7 j / 30 j de la console ne touchait que quatre providers
# sur soixante : un opérateur qui passait en « 30 j » lisait toujours des
# chiffres à 24 h, sans que rien ne le lui dise — et plusieurs titres
# annonçaient « (24h) » en dur. Tout widget dont la valeur DÉPEND d'une période
# lit désormais la fenêtre ; les jauges instantanées (RAM, disque, taille de la
# base, état du moteur) l'ignorent, à raison.
SCOPE_HOURS_CHOICES = (24, 168, 720)


def _scope_hours(override=None) -> int:
    try:
        h = int(override) if override is not None else 24
    except (TypeError, ValueError):
        return 24
    return h if h in SCOPE_HOURS_CHOICES else 24


def _scope_label(hours: int) -> str:
    return {24: "24 h", 168: "7 j", 720: "30 j"}.get(int(hours), f"{hours} h")


def _count_metric(event_type, hours=24):
    with db_conn() as conn:
        r = conn.execute("SELECT COUNT(*) FROM metric_events WHERE event_type=? AND created_at>?",
                         (event_type, time.time()-hours*3600)).fetchone()
        return r[0] if r else 0

def _avg_metric(event_type, hours=24, positive_only=True):
    with db_conn() as conn:
        q = "SELECT COALESCE(AVG(value),0) FROM metric_events WHERE event_type=? AND created_at>?"
        if positive_only: q += " AND value>0"
        r = conn.execute(q, (event_type, time.time()-hours*3600)).fetchone()
        return round(r[0],1) if r else 0


def _percentile_metric(event_type, hours, percentile, positive_only=True):
    """
    Compute a percentile (e.g. 95 for P95) of a metric event's value.

    SQLite has no native PERCENTILE function so we pull the matching
    rows ordered by value and pick the entry at floor(N * p / 100).
    For typical 24-hour windows this dataset is small (< 10 k rows
    even on busy instances) so the in-process sort is fine.

    The percentile is a much better signal than the average for
    latency/throughput :
      • avg is dragged down by fast successful calls,
      • P95 surfaces the "worst experience for one user in twenty",
      • P99 surfaces tail problems that hint at infra issues.

    Returns 0 if no data.
    """
    with db_conn() as conn:
        q = "SELECT value FROM metric_events WHERE event_type=? AND created_at>?"
        if positive_only:
            q += " AND value>0"
        q += " ORDER BY value"
        rows = conn.execute(q, (event_type, time.time()-hours*3600)).fetchall()
    if not rows:
        return 0
    n = len(rows)
    idx = max(0, min(n - 1, int(n * percentile / 100)))
    val = rows[idx][0]
    return round(val, 2) if isinstance(val, (int, float)) else 0


def _distinct_users(hours):
    """
    Distinct users who sent ≥ 1 message in the past N hours.
    Cornerstone of DAU / WAU / MAU.

    Reads from ``message_sent`` events (logged on every user prompt) —
    the canonical "user did something" signal. We dedupe via DISTINCT
    on the JSON-extracted ``user`` tag.
    """
    with db_conn() as conn:
        r = conn.execute(
            f"SELECT COUNT(DISTINCT {json_get('tags_json', 'user')}) "
            "FROM metric_events "
            "WHERE event_type='message_sent' AND created_at>? "
            f"  AND {json_get('tags_json', 'user')} IS NOT NULL "
            f"  AND {json_get('tags_json', 'user')} != ''",
            (time.time() - hours * 3600,)
        ).fetchone()
        return int(r[0]) if r else 0


def _db_size_bytes():
    """Disk size of the main SQLite database file. Includes WAL."""
    try:
        from shared_infra.config import DB_PATH
        total = 0
        for suf in ("", "-wal", "-shm"):
            p = str(DB_PATH) + suf
            if os.path.exists(p):
                total += os.path.getsize(p)
        return total
    except Exception:
        return 0


def _dir_size_bytes(path):
    """Recursive size of a directory tree. Bounded crawl (32 k entries)."""
    total = 0
    visited = 0
    try:
        for root, _dirs, files in os.walk(path):
            for f in files:
                visited += 1
                if visited > 32000:
                    return total  # safety bail for huge sandbox dirs
                try:
                    total += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
    except OSError:
        return 0
    return total


# ═══════════ KPI WIDGETS ═══════════
#
# Each KPI inherits a ``category`` ('activity' / 'volume' / 'performance' /
# 'system') so the dashboard front-end can render them in logical groups
# (Activité, Volume, Performance, Système). Adding a new KPI ?  Pick the
# category that best describes the question it answers :
#   - "qui utilise / quand" → activity
#   - "combien de X généré" → volume
#   - "à quelle vitesse / qualité" → performance
#   - "ressources machine" → system

class KPIUsersProvider(MetricProvider):
    id="kpi_users"; title="Utilisateurs"; type="value"; width="1/4"; icon="ph-users"; color="blue"
    @property
    def category(self): return "activity"
    def get_data(self):
        with db_conn() as conn:
            c=conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
            return {"value":c,"unit":"comptes","color":"blue","icon":"ph-users"}

# ── ACTIVITY: Daily / Weekly / Monthly Active Users ───────────────────
# These are the cornerstone of any long-term usage dashboard. DAU shows
# "did anybody actually use the platform today", WAU answers "weekly
# adoption", MAU shows growth. The trio together reveals stickiness:
# DAU/MAU ratio of 0.3+ is a sign of habitual use, < 0.1 means most
# users are one-off.
class KPIDAUProvider(MetricProvider):
    """Utilisateurs actifs sur la FENÊTRE choisie (1 j / 7 j / 30 j).

    Le titre annonçait « (24h) » quel que soit le réglage : le widget ne
    répondait donc jamais à la question posée par le sélecteur. Les entrées
    dédiées 7 j (``kpi_wau``) et 30 j (``kpi_mau``) restent disponibles pour
    qui veut les trois côte à côte."""
    id="kpi_dau"; title="Utilisateurs actifs"; type="value"; width="1/4"; icon="ph-user-circle"; color="emerald"
    @property
    def category(self): return "activity"
    @property
    def event_types(self): return ('message_sent',)
    def get_data(self, scope_hours=None):
        h = _scope_hours(scope_hours)
        return {"value":_distinct_users(h),"unit":f"actifs / {_scope_label(h)}",
                "color":"emerald","icon":"ph-user-circle"}

class KPIWAUProvider(MetricProvider):
    id="kpi_wau"; title="Actifs (7j)"; type="value"; width="1/4"; icon="ph-users-three"; color="emerald"
    @property
    def category(self): return "activity"
    @property
    def event_types(self): return ('message_sent',)
    def get_data(self):
        return {"value":_distinct_users(24*7),"unit":"users / 7j","color":"emerald","icon":"ph-users-three"}

class KPIMAUProvider(MetricProvider):
    id="kpi_mau"; title="Actifs (30j)"; type="value"; width="1/4"; icon="ph-users-four"; color="emerald"
    @property
    def category(self): return "activity"
    @property
    def event_types(self): return ('message_sent',)
    def get_data(self):
        return {"value":_distinct_users(24*30),"unit":"users / 30j","color":"emerald","icon":"ph-users-four"}

class KPIChatsProvider(MetricProvider):
    id="kpi_chats"; title="Conversations actives"; type="value"; width="1/4"; icon="ph-chat-dots"; color="purple"
    @property
    def category(self): return "activity"
    def get_data(self):
        with db_conn() as conn:
            c=conn.execute("SELECT COUNT(*) FROM chats WHERE archived=0").fetchone()[0]
            return {"value":c,"unit":"actives","color":"purple","icon":"ph-chat-dots"}

class KPINewChatsProvider(MetricProvider):
    id="kpi_new_chats"; title="Nouveaux chats"; type="value"; width="1/4"; icon="ph-plus-circle"; color="violet"
    @property
    def category(self): return "activity"
    @property
    def event_types(self): return ('new_chat',)
    def get_data(self):
        return {"value":_count_metric("new_chat"),"unit":"chats/24h","color":"violet","icon":"ph-plus-circle"}

class KPILoginsProvider(MetricProvider):
    id="kpi_logins"; title="Connexions"; type="value"; width="1/4"; icon="ph-sign-in"; color="blue"
    @property
    def category(self): return "activity"
    @property
    def event_types(self): return ('user_login',)
    def get_data(self):
        return {"value":_count_metric("user_login"),"unit":"logins/24h","color":"blue","icon":"ph-sign-in"}

class KPIGroupsProvider(MetricProvider):
    id="kpi_groups"; title="Groupes"; type="value"; width="1/4"; icon="ph-users-three"; color="teal"
    @property
    def category(self): return "activity"
    def get_data(self):
        with db_conn() as conn:
            try: c=conn.execute('SELECT COUNT(*) FROM "groups"').fetchone()[0]
            except Exception: c=0
            return {"value":c,"unit":"groupes","color":"teal","icon":"ph-users-three"}

class KPIArchivedChatsProvider(MetricProvider):
    id="kpi_archived"; title="Chats archivés"; type="value"; width="1/4"; icon="ph-archive"; color="slate"
    @property
    def category(self): return "activity"
    def get_data(self):
        with db_conn() as conn:
            c=conn.execute("SELECT COUNT(*) FROM chats WHERE archived=1").fetchone()[0]
            return {"value":c,"unit":"archivés","color":"slate","icon":"ph-archive"}


# ── VOLUME ─────────────────────────────────────────────────────────────

class KPIMessagesProvider(MetricProvider):
    id="kpi_messages"; title="Messages"; type="value"; width="1/4"; icon="ph-chat-text"; color="sky"
    @property
    def category(self): return "volume"
    @property
    def event_types(self): return ('message_sent',)
    def get_data(self, scope_hours=None):
        h = _scope_hours(scope_hours)
        return {"value":_count_metric("message_sent", hours=h),
                "unit":f"messages / {_scope_label(h)}","color":"sky","icon":"ph-chat-text"}



class KPIAvgMessagesPerChatProvider(MetricProvider):
    """
    Average chat depth — total messages / chat. Long-term signal of
    engagement quality: 2 = single Q&A and bounce, 10+ = real working
    sessions. Computed from the chats table directly so it covers
    historical data, not just the metric retention window.
    """
    id="kpi_avg_msgs_per_chat"; title="Msgs / chat (moy.)"; type="value"; width="1/4"; icon="ph-conversation"; color="sky"
    @property
    def category(self): return "volume"
    @property
    def event_types(self): return ('message_sent', 'new_chat')
    def get_data(self):
        with db_conn() as conn:
            try:
                # messages_json is a JSON array — its length is the message count.
                row = conn.execute(
                    "SELECT AVG(json_array_length(messages_json)) FROM chats"
                ).fetchone()
                avg = round(row[0] or 0, 1)
            except Exception:
                avg = 0
            return {"value":avg,"unit":"msgs/chat","color":"sky","icon":"ph-conversation"}


class KPISandboxWritesProvider(MetricProvider):
    id="kpi_sandbox_writes"; title="Fichiers écrits"; type="value"; width="1/4"; icon="ph-file-code"; color="emerald"
    @property
    def category(self): return "volume"
    @property
    def event_types(self): return ('sandbox_write',)
    def get_data(self):
        return {"value":_count_metric("sandbox_write"),"unit":"fichiers/24h","color":"emerald","icon":"ph-file-code"}

class KPIToolCallsProvider(MetricProvider):
    id="kpi_tool_calls"; title="Appels outils"; type="value"; width="1/4"; icon="ph-wrench"; color="amber"
    @property
    def category(self): return "volume"
    @property
    def event_types(self): return ('tool_call',)
    def get_data(self):
        return {"value":_count_metric("tool_call"),"unit":"appels/24h","color":"amber","icon":"ph-wrench"}

class KPIRAGHitsProvider(MetricProvider):
    id="kpi_rag_hits"; title="Requêtes RAG"; type="value"; width="1/4"; icon="ph-database"; color="cyan"
    @property
    def category(self): return "volume"
    @property
    def event_types(self): return ('rag_hit',)
    def get_data(self):
        return {"value":_count_metric("rag_hit"),"unit":"requêtes/24h","color":"cyan","icon":"ph-database"}

class KPIModelLoadsProvider(MetricProvider):
    id="kpi_model_loads"; title="Chargements modèle"; type="value"; width="1/4"; icon="ph-upload"; color="blue"
    @property
    def category(self): return "volume"
    @property
    def event_types(self): return ('model_load',)
    def get_data(self):
        return {"value":_count_metric("model_load"),"unit":"loads/24h","color":"blue","icon":"ph-upload"}

class KPITotalMessagesProvider(MetricProvider):
    id="kpi_total_messages"; title="Messages totaux"; type="value"; width="1/4"; icon="ph-chats"; color="emerald"
    @property
    def category(self): return "volume"
    @property
    def event_types(self): return ('message_sent',)
    def get_data(self):
        with db_conn() as conn:
            c=conn.execute("SELECT COUNT(*) FROM metric_events WHERE event_type='message_sent'").fetchone()[0]
            l=f"{c/1000:.1f}k" if c>=1000 else str(c)
            return {"value":l,"unit":"messages","color":"emerald","icon":"ph-chats"}


# ── PERFORMANCE ────────────────────────────────────────────────────────

class KPIAvgTPSProvider(MetricProvider):
    id="kpi_avg_tps"; title="Vitesse moy."; type="value"; width="1/4"; icon="ph-speedometer"; color="orange"
    @property
    def category(self): return "performance"
    @property
    def event_types(self): return ('write_tps',)
    def get_data(self, scope_hours=None):
        h = _scope_hours(scope_hours)
        return {"value":_avg_metric("write_tps", hours=h),"unit":"tokens/s",
                "color":"orange","icon":"ph-speedometer",
                "detail":f"moyenne sur {_scope_label(h)}"}

class KPIAvgLatencyProvider(MetricProvider):
    id="kpi_latency"; title="Latence moy. LLM"; type="value"; width="1/4"; icon="ph-timer"; color="rose"
    @property
    def category(self): return "performance"
    @property
    def event_types(self): return ('llm_latency',)
    def get_data(self):
        return {"value":_avg_metric("llm_latency"),"unit":"sec/réponse","color":"rose","icon":"ph-timer"}

class KPILatencyP95Provider(MetricProvider):
    """
    95e percentile of LLM latency over the last 24h. Why this matters
    over the average: a single 60-second outlier can drag the average
    visibly without telling you HOW BAD the worst experiences are.
    P95 = "1 user in 20 had a worse experience than this" — the
    actionable number.
    """
    id="kpi_latency_p95"; title="Latence P95"; type="value"; width="1/4"; icon="ph-arrow-up-right"; color="rose"
    @property
    def category(self): return "performance"
    @property
    def event_types(self): return ('llm_latency',)
    def get_data(self, scope_hours=None):
        h = _scope_hours(scope_hours)
        v = _percentile_metric("llm_latency", hours=h, percentile=95)
        return {"value":v,"unit":"sec (95e)","color":"rose","icon":"ph-arrow-up-right",
                "detail":f"sur {_scope_label(h)}"}

class KPILatencyP99Provider(MetricProvider):
    """99e percentile latency — the tail that hurts."""
    id="kpi_latency_p99"; title="Latence P99"; type="value"; width="1/4"; icon="ph-warning"; color="red"
    @property
    def category(self): return "performance"
    @property
    def event_types(self): return ('llm_latency',)
    def get_data(self):
        v = _percentile_metric("llm_latency", hours=24, percentile=99)
        return {"value":v,"unit":"sec (99e)","color":"red","icon":"ph-warning"}


class KPIAvgModelProvider(MetricProvider):
    """Modèle le plus sollicité, lu dans le registre d'usage.

    Il lisait auparavant le tag ``model`` de ``metric_events`` — figé sur la
    constante ``LLAMA_MODEL`` par la boucle outils : le KPI répondait donc
    « le modèle configuré », pas « le modèle utilisé »."""
    id="kpi_top_model"; title="Modèle dominant"; type="value"; width="1/4"; icon="ph-robot"; color="indigo"
    @property
    def category(self): return "performance"
    def get_data(self, scope_hours=None):
        try:
            hours = int(scope_hours or 24)
        except (TypeError, ValueError):
            hours = 24
        with db_conn() as conn:
            row = conn.execute(
                """SELECT model, COUNT(*) AS c FROM usage_events
                   WHERE ts > ? AND model NOT IN ('', 'rag', 'RAG')
                   GROUP BY model ORDER BY c DESC LIMIT 1""",
                (time.time() - hours * 3600,)).fetchone()
        name = row[0].split("/")[-1] if row and row[0] else "—"
        if len(name) > 18:
            name = name[:16] + "…"
        return {"value": name, "unit": "modèle dominant", "color": "indigo",
                "icon": "ph-robot"}

class KPILLMStatusProvider(MetricProvider):
    id="kpi_llm_status"; title="LLM Server"; type="value"; width="1/4"; icon="ph-hard-drives"; color="blue"
    @property
    def category(self): return "performance"
    def get_data(self):
        try:
            from llm_core import get_llm_health_sync
            h=get_llm_health_sync()
            # ``state`` : seule couleur que la console affiche encore — elle
            # signale une ANOMALIE (``color`` reste pour la rétrocompatibilité).
            if not h["server_reachable"]: return {"value":"Hors ligne","unit":"serveur","color":"red","icon":"ph-hard-drives","state":"danger"}
            models=h.get("models_loaded",[])
            name=models[0]["id"].split("/")[-1] if models else "—"
            if len(name)>18: name=name[:16]+"…"
            return {"value":name,"unit":h.get("status","ok"),"color":"emerald","icon":"ph-hard-drives"}
        except Exception: return {"value":"Erreur","unit":"serveur","color":"red","icon":"ph-hard-drives","state":"danger"}



# ── SYSTEM ─────────────────────────────────────────────────────────────

def _fill_state(percent):
    """Remplissage d'une ressource → état affiché (``None`` = normal)."""
    if percent >= 90: return "danger"
    if percent >= 80: return "warn"
    return None


class KPIDiskProvider(MetricProvider):
    id="kpi_disk"; title="Disque"; type="value"; width="1/4"; icon="ph-hard-drive"; color="amber"
    @property
    def category(self): return "system"
    def get_data(self):
        d=psutil.disk_usage('/'); g=round(d.used/(1024**3),1); t=round(d.total/(1024**3),1)
        return {"value":f"{g}","unit":f"/ {t} Go","color":"amber" if d.percent<80 else "red","icon":"ph-hard-drive",
                "state":_fill_state(d.percent)}

class KPIRAMProvider(MetricProvider):
    id="kpi_ram"; title="RAM"; type="value"; width="1/4"; icon="ph-memory"; color="purple"
    @property
    def category(self): return "system"
    def get_data(self):
        m=psutil.virtual_memory(); g=round(m.used/(1024**3),1); t=round(m.total/(1024**3),1)
        return {"value":f"{g}","unit":f"/ {t} Go","color":"purple" if m.percent<80 else "red","icon":"ph-memory",
                "state":_fill_state(m.percent)}

class KPIDBSizeProvider(MetricProvider):
    """
    Disk size of the SQLite DB (including WAL / SHM sidecars). Grows
    with the metric_events table mainly — useful capacity-planning
    signal. Triggers an "archive old metrics" reflex when > 1 GB.
    """
    id="kpi_db_size"; title="Base de données"; type="value"; width="1/4"; icon="ph-database"; color="cyan"
    @property
    def category(self): return "system"
    def get_data(self):
        n = _db_size_bytes()
        # We display value / unit separately so the front uses its bigger
        # font for the value. Pick the unit based on magnitude.
        if n >= 1024**3:
            return {"value":f"{n/(1024**3):.2f}","unit":"Go","color":"cyan","icon":"ph-database"}
        if n >= 1024**2:
            return {"value":f"{n/(1024**2):.0f}","unit":"Mo","color":"cyan","icon":"ph-database"}
        return {"value":f"{n/1024:.0f}","unit":"Ko","color":"cyan","icon":"ph-database"}

class KPISandboxStorageProvider(MetricProvider):
    """Total disk used by user sandboxes (per security.app.sandbox_dir)."""
    id="kpi_sandbox_storage"; title="Stockage sandbox"; type="value"; width="1/4"; icon="ph-folder"; color="orange"
    @property
    def category(self): return "system"
    def get_data(self):
        try:
            from shared_infra.config import SANDBOX_DIR
            n = _dir_size_bytes(str(SANDBOX_DIR))
        except Exception:
            n = 0
        if n >= 1024**3:
            return {"value":f"{n/(1024**3):.2f}","unit":"Go","color":"orange","icon":"ph-folder"}
        if n >= 1024**2:
            return {"value":f"{n/(1024**2):.0f}","unit":"Mo","color":"orange","icon":"ph-folder"}
        return {"value":f"{n/1024:.0f}","unit":"Ko","color":"orange","icon":"ph-folder"}

class KPIUptimeProvider(MetricProvider):
    """Uptime de l'APPLICATION (ce worker), pas de la machine.

    ``psutil.boot_time()`` mesurait le démarrage du système : le KPI affichait
    fièrement « 42 j » juste après un redémarrage de l'application — soit
    exactement le contraire de ce qu'un exploitant vient y chercher."""
    id="kpi_uptime"; title="Uptime application"; type="value"; width="1/4"; icon="ph-clock-clockwise"; color="teal"
    @property
    def category(self): return "system"
    def get_data(self):
        try:
            secs = int(time.time() - psutil.Process(os.getpid()).create_time())
            d, rem = divmod(secs, 86400)
            h, rem = divmod(rem, 3600)
            m, _ = divmod(rem, 60)
            if d > 0:   label = f"{d}j {h}h"
            elif h > 0: label = f"{h}h {m}m"
            else:       label = f"{m}m"
            return {"value": label, "unit": "depuis le démarrage", "color":"teal", "icon":"ph-clock-clockwise"}
        except Exception:
            return {"value":"—","unit":"depuis le démarrage","color":"slate","icon":"ph-clock-clockwise"}

# ═══════════ GRAPHES ═══════════

class SystemLoadProvider(MetricProvider):
    id="system_load"; title="Charge Système Live — CPU / RAM (10 min)"; type="line"; width="full"
    def get_data(self):
        h=list(sys_monitor.history)
        # Specs hardware exposées dynamiquement pour enrichir le titre côté front
        try:
            _cores_logical  = psutil.cpu_count(logical=True)  or 1
            _cores_physical = psutil.cpu_count(logical=False) or _cores_logical
            _ram_total_gb   = round(psutil.virtual_memory().total / (1024**3), 1)
            _cpu_freq = psutil.cpu_freq()
            _ghz = round(_cpu_freq.current / 1000, 2) if _cpu_freq and _cpu_freq.current else None
        except Exception:
            _cores_logical = _cores_physical = 0; _ram_total_gb = 0; _ghz = None
        _freq_str = f" @ {_ghz} GHz" if _ghz else ""
        dyn_title = f"Charge Système Live — {_cores_physical}c/{_cores_logical}t{_freq_str} · {_ram_total_gb} Go RAM (10 min)"
        return {"title": dyn_title,
            "host": {"cores_logical": _cores_logical, "cores_physical": _cores_physical,
                     "ram_total_gb": _ram_total_gb, "cpu_ghz": _ghz},
            "labels":[x["time"] for x in h],"datasets":[
            {"label":"CPU %","data":[x["cpu"] for x in h],"borderColor":"#3b82f6","backgroundColor":"rgba(59,130,246,0.08)","borderWidth":2,"tension":0.4,"fill":True,"pointRadius":0},
            {"label":"RAM %","data":[x["ram"] for x in h],"borderColor":"#8b5cf6","backgroundColor":"rgba(139,92,246,0.08)","borderWidth":2,"tension":0.4,"fill":True,"pointRadius":0}]}

class DiskIOProvider(MetricProvider):
    id="disk_io"; title="Disque I/O Live (Mo/s)"; type="line"; width="full"
    def get_data(self):
        h=list(sys_monitor.history)
        return {"labels":[x["time"] for x in h],"datasets":[
            {"label":"Lecture Mo/s","data":[x.get("disk_read",0) for x in h],"borderColor":"#10b981","backgroundColor":"rgba(16,185,129,0.08)","borderWidth":2,"tension":0.4,"fill":True,"pointRadius":0},
            {"label":"Écriture Mo/s","data":[x.get("disk_write",0) for x in h],"borderColor":"#ef4444","backgroundColor":"rgba(239,68,68,0.08)","borderWidth":2,"tension":0.4,"fill":True,"pointRadius":0}]}

class ProcLiveProvider(MetricProvider):
    """Per-process LIVE (10 min) du worker hébergeant ce dashboard.

    RSS (Mo) + descripteurs de fichiers ouverts, échantillonnés toutes les
    2 s par ``BackgroundMonitor``. Deux axes implicites (Mo vs compte) mais
    on les superpose : ce qui compte ici est la PENTE, pas la valeur absolue.
    Fenêtre volatile (perdue au restart) → pour la tendance multi-jours voir
    ``ProcResourcesProvider`` (persistée en metric_events)."""
    id="proc_live"; title="Process worker — RSS Mo / fd ouverts (live, 10 min)"; type="line"; width="full"
    @property
    def category(self): return "system"
    def get_data(self):
        h=list(sys_monitor.history)
        return {"labels":[x["time"] for x in h],"datasets":[
            {"label":"RSS Mo","data":[x.get("rss_mb",0) for x in h],"borderColor":"#8b5cf6","backgroundColor":"rgba(139,92,246,0.08)","borderWidth":2,"tension":0.4,"fill":True,"pointRadius":0},
            {"label":"fd ouverts","data":[x.get("num_fds",0) for x in h],"borderColor":"#f59e0b","backgroundColor":"rgba(245,158,11,0.08)","borderWidth":2,"tension":0.4,"fill":False,"pointRadius":0},
            {"label":"threads","data":[x.get("num_threads",0) for x in h],"borderColor":"#10b981","backgroundColor":"rgba(16,185,129,0.08)","borderWidth":2,"tension":0.4,"fill":False,"pointRadius":0}]}


def _proc_trend_chart(event_types_labels_colors, days=7):
    """Ligne 7 jours d'un ou plusieurs ``proc_*`` persistés en metric_events.

    Agrège en MAX(value) par heure → en multi-worker, c'est le PIRE worker
    qui ressort (celui qui fuit). Une pente qui monte de façon monotone sur
    plusieurs jours == le coupable du redémarrage hebdomadaire."""
    from shared_infra.observability.metrics.process_sampler import (
        gauge_union_params,
        gauge_union_sql,
    )

    _BUCKET = local_strftime("%d/%m %Hh", "created_at")
    datasets = []
    labels_master: List[str] = []
    since = time.time() - days * 86400
    with db_conn() as conn:
        cur = conn.cursor()
        for et, label, color, fill in event_types_labels_colors:
            # L'union couvre les lignes de l'ancien format (un event_type par
            # jauge) encore présentes jusqu'au bout de la rétention, ET celles
            # du format groupé ``proc_sample``. Sans elle, chaque courbe se
            # couperait net à la date de déploiement.
            #
            # ``ORDER BY MIN(ts)`` remplace l'ancien ``ORDER BY created_at`` :
            # une colonne nue hors agrégat, dont SQLite tirait une valeur
            # arbitraire du groupe. L'ordre obtenu était le bon par chance,
            # il est maintenant le bon par construction.
            cur.execute(
                f"""SELECT h, {round_("MAX(v)", 1)} AS v FROM ({gauge_union_sql(_BUCKET)}) AS g
                    WHERE v IS NOT NULL GROUP BY h ORDER BY MIN(ts) ASC""",
                gauge_union_params(et, since),
            )
            rows = cur.fetchall()
            if len(rows) > len(labels_master):
                labels_master = [r[0] for r in rows]
            datasets.append({
                "label": label,
                "data": [r[1] for r in rows],
                "borderColor": f"rgb({color})",
                "backgroundColor": f"rgba({color},0.1)",
                "tension": 0.4, "fill": fill, "borderWidth": 2, "pointRadius": 0,
            })
    return {"labels": labels_master, "datasets": datasets}


class ProcResourcesProvider(MetricProvider):
    """Tendance 7 jours des ressources OS par-process (RSS / fd / threads),
    persistée → survit aux restarts. Le diagnostic n°1 d'une fuite lente."""
    id="proc_resources"; title="Process — RSS Mo / fd / threads (tendance 7j, pire worker)"; type="line"; width="full"
    @property
    def category(self): return "system"
    def get_data(self):
        return _proc_trend_chart([
            ("proc_rss_mb",      "RSS Mo",     "139,92,246", True),
            ("proc_num_fds",     "fd ouverts", "245,158,11", False),
            ("proc_num_threads", "threads",    "16,185,129", False),
        ])


class ProcAppCountersProvider(MetricProvider):
    """Tendance 7 jours des compteurs APPLICATIFS in-process : tasks de chat
    actives, terminaux PTY, clients SSE, background-tasks, runs de routines.
    Un de ces compteurs qui ne redescend jamais == fuite logique (cleanup
    manqué) plutôt qu'OS."""
    id="proc_app_counters"; title="Process — tasks chat / PTY / SSE / bg / routines (tendance 7j)"; type="line"; width="full"
    @property
    def category(self): return "system"
    def get_data(self):
        return _proc_trend_chart([
            ("proc_active_chat_tasks", "tasks chat",  "59,130,246",  False),
            ("proc_pty_terminals",     "PTY",         "239,68,68",   False),
            ("proc_sse_clients",       "clients SSE", "16,185,129",  False),
            ("proc_bg_tasks",          "bg tasks",    "245,158,11",  False),
            ("proc_routine_tasks",     "routines",    "168,85,247",  False),
            ("proc_sqlite_wal_mb",     "WAL Mo",      "6,182,212",   True),
        ])


def _hourly_chart(event_type, label, color, hours=24, agg="COUNT"):
    with db_conn() as conn:
        cur=conn.cursor()
        val_expr = "COUNT(*)" if agg=="COUNT" else round_("AVG(value)", 1)
        q = f"""SELECT {local_strftime('%H:00', 'created_at')} as h, {val_expr} as v
                FROM metric_events WHERE event_type=? AND created_at>?"""
        if agg != "COUNT": q += " AND value>0"
        q += " GROUP BY h ORDER BY h ASC"
        cur.execute(q, (event_type, time.time()-hours*3600)); rows=cur.fetchall()
        return {"labels":[r[0] for r in rows],"datasets":[{"label":label,"data":[r[1] for r in rows],
            "backgroundColor":f"rgba({color},0.7)","borderRadius":4}]}

def _daily_chart(event_type, label, color, days=7, chart_type="bar"):
    with db_conn() as conn:
        cur=conn.cursor()
        cur.execute(f"""SELECT {local_strftime('%d/%m', 'created_at')} as d, COUNT(*) as c
            FROM metric_events WHERE event_type=? AND created_at>? GROUP BY d ORDER BY MIN(created_at) ASC""",
            (event_type, time.time()-days*86400)); rows=cur.fetchall()
        ds = {"label":label,"data":[r[1] for r in rows]}
        if chart_type == "bar":
            ds["backgroundColor"] = f"rgba({color},0.7)"; ds["borderRadius"] = 4
        else:
            ds["borderColor"] = f"rgb({color})"; ds["backgroundColor"] = f"rgba({color},0.1)"
            ds["tension"] = 0.4; ds["fill"] = True; ds["borderWidth"] = 2; ds["pointRadius"] = 4
        return {"labels":[r[0] for r in rows],"datasets":[ds]}


class WriteTpsHistoryProvider(MetricProvider):
    id="write_tps_history"; title="Vitesse tokens/s (24h)"; type="line"; width="1/2"
    @property
    def event_types(self): return ('write_tps',)
    def get_data(self):
        with db_conn() as conn:
            cur=conn.cursor()
            cur.execute(f"""SELECT {local_strftime('%H:00', 'created_at')} as h, {round_('AVG(value)', 1)} as v
                FROM metric_events WHERE event_type='write_tps' AND created_at>? AND value>0 GROUP BY h ORDER BY h ASC""",(time.time()-86400,))
            rows=cur.fetchall()
            return {"labels":[r[0] for r in rows],"datasets":[{"label":"t/s moyen","data":[r[1] for r in rows],
                "borderColor":"#f97316","backgroundColor":"rgba(249,115,22,0.1)","tension":0.4,"fill":True,"borderWidth":2,"pointRadius":3}]}

class LLMLatencyHistoryProvider(MetricProvider):
    id="llm_latency_history"; title="Latence LLM/heure (sec)"; type="line"; width="1/2"
    @property
    def event_types(self): return ('llm_latency',)
    def get_data(self):
        with db_conn() as conn:
            cur=conn.cursor()
            cur.execute(f"""SELECT {local_strftime('%H:00', 'created_at')} as h, {round_('AVG(value)', 2)} as v
                FROM metric_events WHERE event_type='llm_latency' AND created_at>? AND value>0 GROUP BY h ORDER BY h ASC""",(time.time()-86400,))
            rows=cur.fetchall()
            return {"labels":[r[0] for r in rows],"datasets":[{"label":"Latence (s)","data":[r[1] for r in rows],
                "borderColor":"#ec4899","backgroundColor":"rgba(236,72,153,0.1)","tension":0.4,"fill":True,"borderWidth":2,"pointRadius":3}]}


class ChatsPerDayProvider(MetricProvider):
    id="chats_per_day"; title="Nouveaux chats/jour (7j)"; type="line"; width="1/2"
    @property
    def event_types(self): return ('new_chat',)
    def get_data(self): return _daily_chart("new_chat","Nouveaux chats","99,102,241",7,"line")

class MessagesPerDayProvider(MetricProvider):
    id="messages_per_day"; title="Messages/jour (7j)"; type="bar"; width="1/2"
    @property
    def event_types(self): return ('message_sent',)
    def get_data(self): return _daily_chart("message_sent","Messages","99,102,241")

class SandboxWritesHistoryProvider(MetricProvider):
    id="sandbox_writes_history"; title="Fichiers sandbox/jour (7j)"; type="bar"; width="1/2"
    @property
    def event_types(self): return ('sandbox_write',)
    def get_data(self): return _daily_chart("sandbox_write","Fichiers","16,185,129")

class SandboxWritesByExtProvider(MetricProvider):
    id="sandbox_writes_ext"; title="Fichiers par extension (7j)"; type="doughnut"; width="1/4"
    @property
    def event_types(self): return ('sandbox_write',)
    def get_data(self):
        with db_conn() as conn:
            cur=conn.cursor()
            cur.execute(f"""SELECT {json_get('tags_json', 'ext')} as e, COUNT(*) as c
                FROM metric_events WHERE event_type='sandbox_write' AND created_at>?
                AND {json_get('tags_json', 'ext')} IS NOT NULL GROUP BY e ORDER BY c DESC LIMIT 8""",(time.time()-604800,))
            rows=cur.fetchall()
            c=["#3b82f6","#10b981","#f59e0b","#ef4444","#8b5cf6","#06b6d4","#f97316","#84cc16"]
            return {"labels":[("."+r[0]) if r[0] else "autre" for r in rows],"datasets":[{"data":[r[1] for r in rows],"backgroundColor":c[:len(rows)]}]}

class SandboxWritesByUserProvider(MetricProvider):
    id="sandbox_writes_user"; title="Fichiers par utilisateur (7j)"; type="bar"; width="1/2"
    @property
    def event_types(self): return ('sandbox_write',)
    def get_data(self):
        with db_conn() as conn:
            cur=conn.cursor()
            cur.execute(f"""SELECT {json_get('tags_json', 'user')} as u, COUNT(*) as c
                FROM metric_events WHERE event_type='sandbox_write' AND created_at>?
                AND {json_get('tags_json', 'user')} IS NOT NULL GROUP BY u ORDER BY c DESC LIMIT 10""",(time.time()-604800,))
            rows=cur.fetchall()
            c=["#10b981","#3b82f6","#f59e0b","#ef4444","#8b5cf6","#06b6d4","#f97316","#84cc16","#ec4899","#6366f1"]
            return {"labels":[r[0] for r in rows],"datasets":[{"label":"Fichiers","data":[r[1] for r in rows],"backgroundColor":c[:len(rows)],"borderRadius":4}]}

class RAGUsageProvider(MetricProvider):
    id="rag_usage"; title="Requêtes RAG/heure (24h)"; type="bar"; width="1/2"
    @property
    def event_types(self): return ('rag_hit',)
    def get_data(self): return _hourly_chart("rag_hit","Requêtes RAG","6,182,212")

class LoginsPerDayProvider(MetricProvider):
    id="logins_per_day"; title="Connexions/jour (7j)"; type="bar"; width="1/2"
    @property
    def event_types(self): return ('user_login',)
    def get_data(self): return _daily_chart("user_login","Connexions","59,130,246")

class ActiveUsersPerDayProvider(MetricProvider):
    id="active_users_day"; title="Utilisateurs actifs/jour (7j)"; type="line"; width="1/2"
    @property
    def event_types(self): return ('message_sent',)
    def get_data(self):
        with db_conn() as conn:
            cur=conn.cursor()
            cur.execute(f"""SELECT {local_strftime('%d/%m', 'created_at')} as d,
                COUNT(DISTINCT {json_get('tags_json', 'user')}) as c
                FROM metric_events WHERE event_type='message_sent' AND created_at>?
                AND {json_get('tags_json', 'user')} IS NOT NULL GROUP BY d ORDER BY MIN(created_at) ASC""",(time.time()-604800,))
            rows=cur.fetchall()
            return {"labels":[r[0] for r in rows],"datasets":[{"label":"Actifs","data":[r[1] for r in rows],
                "borderColor":"#10b981","backgroundColor":"rgba(16,185,129,0.1)","tension":0.4,"fill":True,"borderWidth":2,"pointRadius":4}]}


class ToolsUsageProvider(MetricProvider):
    id="tools_usage"; title="Top Outils MCP (7j)"; type="doughnut"; width="1/4"
    @property
    def event_types(self): return ('tool_call',)
    def get_data(self):
        with db_conn() as conn:
            cur=conn.cursor()
            cur.execute(f"""SELECT {json_get('tags_json', 'tool')} as t, COUNT(*) as c
                FROM metric_events WHERE event_type='tool_call' AND created_at>? GROUP BY t ORDER BY c DESC LIMIT 6""",(time.time()-604800,))
            rows=cur.fetchall()
            return {"labels":[r[0] or "?" for r in rows],"datasets":[{"data":[r[1] for r in rows],
                "backgroundColor":["#ef4444","#f97316","#f59e0b","#84cc16","#06b6d4","#8b5cf6"]}]}


class CodeWriteTimeProvider(MetricProvider):
    id="code_write_time"; title="Temps écriture fichiers (24h)"; type="line"; width="1/2"
    @property
    def event_types(self): return ('code_write_time',)
    def get_data(self):
        with db_conn() as conn:
            cur=conn.cursor()
            cur.execute(f"""SELECT {local_strftime('%H:00', 'created_at')} as h, {round_('AVG(value)', 2)} as v
                FROM metric_events WHERE event_type='code_write_time' AND created_at>? GROUP BY h ORDER BY h ASC""",(time.time()-86400,))
            rows=cur.fetchall()
            return {"labels":[r[0] for r in rows],"datasets":[{"label":"sec/fichier","data":[r[1] for r in rows],
                "borderColor":"#10b981","backgroundColor":"rgba(16,185,129,0.1)","tension":0.4,"fill":True,"borderWidth":2,"pointRadius":4}]}


# ═══════════ LONG-TERM CHARTS (the missing 30-day visibility) ═══════════
# These complement the 24h / 7-day windows already covered above by
# zooming out to 30 days. They surface trends invisible at finer
# granularity: monthly growth, weekly seasonality, week-over-week
# regressions.


class MessagesHistory30dProvider(MetricProvider):
    """Daily message count, 30 days."""
    id="messages_history_30d"; title="Messages échangés (30 jours)"; type="line"; width="1/2"
    @property
    def event_types(self): return ('message_sent',)
    def get_data(self):
        with db_conn() as conn:
            cur=conn.cursor()
            cur.execute(f"""SELECT {local_strftime('%d/%m', 'created_at')} as d, COUNT(*) as c
                FROM metric_events WHERE event_type='message_sent' AND created_at>?
                GROUP BY d ORDER BY MIN(created_at) ASC""", (time.time()-30*86400,))
            rows=cur.fetchall()
            return {"labels":[r[0] for r in rows],"datasets":[{"label":"Messages","data":[r[1] for r in rows],
                "borderColor":"#3b82f6","backgroundColor":"rgba(59,130,246,0.1)",
                "tension":0.4,"fill":True,"borderWidth":2,"pointRadius":3}]}


# ═══════════ ERROR / QUALITY TRENDS ═══════════



# ═══════════ CHAT LIFECYCLE (created vs archived) ═══════════

class ChatLifecycleProvider(MetricProvider):
    """
    Net chat creation (new vs archived) per day, 30 days. A divergent
    signal — increasing archive rate while new chats stagnate suggests
    declining engagement.
    """
    id="chat_lifecycle"; title="Chats : création vs archivage (30j)"; type="line"; width="1/2"
    @property
    def event_types(self): return ('new_chat',)
    def get_data(self):
        cutoff = time.time() - 30*86400
        with db_conn() as conn:
            cur=conn.cursor()
            cur.execute(f"""SELECT {local_strftime('%d/%m', 'created_at')} as d, COUNT(*) as c
                FROM metric_events WHERE event_type='new_chat' AND created_at>?
                GROUP BY d ORDER BY MIN(created_at) ASC""", (cutoff,))
            news = {r[0]: r[1] for r in cur.fetchall()}
            try:
                cur.execute(f"""SELECT {local_strftime('%d/%m', 'archived_at')} as d, COUNT(*) as c
                    FROM chats WHERE archived=1 AND archived_at IS NOT NULL AND archived_at>?
                    GROUP BY d ORDER BY MIN(archived_at) ASC""", (cutoff,))
                archs = {r[0]: r[1] for r in cur.fetchall()}
            except Exception:
                archs = {}
        labels = sorted(set(news) | set(archs))
        return {"labels": labels, "datasets": [
            {"label": "Créés", "data": [news.get(d, 0) for d in labels],
             "borderColor": "#10b981", "backgroundColor": "rgba(16,185,129,0.1)",
             "tension": 0.4, "fill": True, "borderWidth": 2, "pointRadius": 3},
            {"label": "Archivés", "data": [archs.get(d, 0) for d in labels],
             "borderColor": "#94a3b8", "backgroundColor": "rgba(148,163,184,0.1)",
             "tension": 0.4, "fill": False, "borderWidth": 2, "pointRadius": 3},
        ]}


# ═══════════ STORAGE BREAKDOWN (capacity planning) ═══════════

class StorageBreakdownProvider(MetricProvider):
    """
    Where does the disk usage live ? Donut split between DB, sandboxes,
    user uploads, logs. Each slice is a directory size in bytes.
    """
    id="storage_breakdown"; title="Stockage : répartition"; type="doughnut"; width="1/4"
    def get_data(self):
        sizes = {}
        sizes["Base de données"] = _db_size_bytes()
        try:
            from shared_infra.config import SANDBOX_DIR
            sizes["Sandboxes"] = _dir_size_bytes(str(SANDBOX_DIR))
        except Exception:
            sizes["Sandboxes"] = 0
        try:
            # Uploads dir comes from runtime config (not a constant)
            cfg = {}
            try:
                from shared_infra.config import read_config_json
                cfg = (read_config_json() or {}).get("app") or {}
            except Exception:
                pass
            up_path = cfg.get("upload_dir", "user_db/uploads")
            sizes["Uploads"] = _dir_size_bytes(up_path)
        except Exception:
            sizes["Uploads"] = 0
        try:
            sizes["Logs"] = _dir_size_bytes("user_db/logs")
        except Exception:
            sizes["Logs"] = 0
        # Convert to MB for the chart so values fit Chart.js axis well.
        labels = list(sizes.keys())
        data_mb = [round(v / (1024**2), 2) for v in sizes.values()]
        return {"labels": labels, "datasets": [{
            "data": data_mb,
            "backgroundColor": ["#06b6d4", "#f97316", "#8b5cf6", "#94a3b8"],
            "label": "Mo",
        }]}


# ═══════════ LATENCY DISTRIBUTION (P50/P75/P95/P99 bars) ═══════════

class LatencyPercentilesProvider(MetricProvider):
    """
    Bar chart of LLM latency percentiles (24h). Shows P50/P75/P95/P99
    side by side — the spread reveals tail behaviour. A large gap
    between P50 and P95 means the average user has a great experience
    but a few endure painful waits — usually fixable by tuning batch
    size or model concurrency.
    """
    id="latency_percentiles"; title="Latence LLM — percentiles"; type="bar"; width="1/2"
    @property
    def event_types(self): return ('llm_latency',)
    def get_data(self, scope_hours=None):
        ps = [50, 75, 95, 99]
        h = _scope_hours(scope_hours)
        vals = [_percentile_metric("llm_latency", hours=h, percentile=p) for p in ps]
        return {"labels": [f"P{p}" for p in ps], "datasets": [{
            "label": "Secondes", "data": vals,
            "backgroundColor": ["#10b981", "#3b82f6", "#f59e0b", "#ef4444"],
            "borderRadius": 6,
        }]}


# ═══════════ SET CURÉ ═══════════
# Les widgets affichés par défaut. Critère d'entrée : le widget répond à une
# question qu'un exploitant se pose vraiment (« la plateforme tourne-t-elle ? »,
# « qui consomme ? », « qu'est-ce qui a tourné cette nuit ? »), et sa valeur est
# JUSTE. Tout le reste reste enregistré et activable à la demande.
DEFAULT_WIDGETS = frozenset({
    # Conso réelle et attribution
    "usage_tokens", "usage_offhours", "usage_turns", "usage_failure_rate",
    "usage_thinking", "usage_thinking_timeline",
    "usage_timeline", "usage_user_peaks", "usage_top_users", "usage_by_source",
    "usage_by_model", "usage_heatmap", "usage_turns_timeline",
    # Exploitation
    "routine_runs", "routine_runs_timeline", "scheduler_health",
    "kpi_llm_status", "kpi_top_model",
    # Adoption
    "kpi_users", "kpi_dau", "kpi_chats", "kpi_messages",
    # Performance
    "kpi_avg_tps", "kpi_latency_p95", "latency_percentiles", "tool_error_rate",
    # Ressources
    "kpi_ram", "kpi_disk", "kpi_db_size", "system_load",
})


# ═══════════ REGISTRY ═══════════
class MetricsRegistry:
    def __init__(self):
        self.providers: List[MetricProvider] = []
        # Inverse index built lazily once on first lookup. Maps each
        # metric event_type to the set of provider ids whose data
        # depends on it. Used by log_metric → metric_broadcast.publish
        # to compute "what should the dashboard refresh ?" without
        # re-iterating providers on every metric write.
        self._event_type_index: Optional[Dict[str, List[str]]] = None

    def register(self, p: MetricProvider):
        self.providers.append(p)
        # Invalidate cached inverse index — next lookup will rebuild it.
        self._event_type_index = None

    def _build_event_type_index(self) -> Dict[str, List[str]]:
        idx: Dict[str, List[str]] = {}
        for p in self.providers:
            for et in (p.event_types or ()):
                idx.setdefault(et, []).append(p.id)
        return idx

    def affected_provider_ids(self, event_type: str) -> List[str]:
        """
        Provider ids whose data depends on the given metric event_type.
        Called from db.log_metric() to drive selective dashboard
        refreshes via the metric_broadcast bus.
        """
        if self._event_type_index is None:
            self._event_type_index = self._build_event_type_index()
        return self._event_type_index.get(event_type, [])

    def get_dashboard_config(self, scope_hours: int = 24):
        # v17 — ``scope_hours`` permet aux providers conscients du scope
        # (cf. _v17_providers.py) de switch entre 24h / 7j / 30j. Les
        # providers existants l'ignorent (try/except TypeError pour la
        # back-compat — leur signature ``get_data(self)`` ne change pas).
        # ``category`` is exposed in the layout payload so the front
        # can group KPIs into sections (Activité / Volume / Performance
        # / Système). Charts ignore it (single flow), but having the
        # field is harmless.
        layout = [{
            "id": p.id, "title": p.title, "type": p.type,
            "width": p.width, "category": p.category,
            # Set CURÉ : ce que l'on montre par défaut. Les autres widgets
            # restent disponibles dans le sélecteur, mais un tableau de bord
            # qui affiche soixante cartes d'emblée ne se lit pas — l'opérateur
            # doit voir l'état de la plateforme, pas la chercher.
            "default": p.id in DEFAULT_WIDGETS,
            # Descripteur de purge : présent ⇒ l'IHM propose « Réinitialiser »
            # sur CE widget, et sait quoi demander au serveur sans rien
            # connaître du schéma.
            "purge": p.purge_spec,
        } for p in self.providers]
        def _safe_get(p):
            try:
                try:
                    return p.id, p.get_data(scope_hours=scope_hours)
                except TypeError:
                    # Provider d'avant v17 — signature sans kwargs
                    return p.id, p.get_data()
            except Exception as e:
                return p.id, {"error": str(e)}
        data_map = {}
        with ThreadPoolExecutor(max_workers=min(len(self.providers),12)) as pool:
            for pid, data in pool.map(_safe_get, self.providers):
                data_map[pid] = data
        return {"layout":layout,"data":data_map}

    def get_widgets_data(self, ids: Iterable[str], scope_hours: int = 24) -> Dict[str, Any]:
        """
        Compute fresh data for ONLY the listed provider ids. Used by
        the auto-refresh mechanism to avoid re-fetching the entire
        dashboard payload on every metric event.

        Unknown ids are silently skipped — the front filters before
        sending so this should rarely matter.

        v17 — ``scope_hours`` est propagé aux providers scope-aware
        (cf. _v17_providers.py), ignoré sinon.
        """
        ids_set = set(ids)
        targets = [p for p in self.providers if p.id in ids_set]
        if not targets:
            return {}
        def _safe_get(p):
            try:
                try:
                    return p.id, p.get_data(scope_hours=scope_hours)
                except TypeError:
                    return p.id, p.get_data()
            except Exception as e: return p.id, {"error": str(e)}
        out: Dict[str, Any] = {}
        # ThreadPool only when more than one widget — saves the spawn cost
        # for the common single-widget case (e.g. only kpi_messages).
        if len(targets) == 1:
            pid, data = _safe_get(targets[0])
            out[pid] = data
        else:
            with ThreadPoolExecutor(max_workers=min(len(targets), 8)) as pool:
                for pid, data in pool.map(_safe_get, targets):
                    out[pid] = data
        return out

registry = MetricsRegistry()

# ── KPIs ────────────────────────────────────────────────────────────
# Activity (who/when)
registry.register(KPIUsersProvider())
registry.register(KPIDAUProvider())
registry.register(KPIWAUProvider())
registry.register(KPIMAUProvider())
registry.register(KPIChatsProvider())
registry.register(KPINewChatsProvider())
registry.register(KPILoginsProvider())
registry.register(KPIGroupsProvider())
registry.register(KPIArchivedChatsProvider())
# Volume (what's produced)
registry.register(KPIMessagesProvider())
registry.register(KPIAvgMessagesPerChatProvider())
registry.register(KPISandboxWritesProvider())
registry.register(KPIToolCallsProvider())
registry.register(KPIRAGHitsProvider())
registry.register(KPIModelLoadsProvider())
registry.register(KPITotalMessagesProvider())
# Performance (speed/quality)
registry.register(KPIAvgTPSProvider())
registry.register(KPIAvgLatencyProvider())
registry.register(KPILatencyP95Provider())
registry.register(KPILatencyP99Provider())
registry.register(KPIAvgModelProvider())
registry.register(KPILLMStatusProvider())
# System (resources)
registry.register(KPIDiskProvider())
registry.register(KPIRAMProvider())
registry.register(KPIDBSizeProvider())
registry.register(KPISandboxStorageProvider())
registry.register(KPIUptimeProvider())

# ── Charts ──────────────────────────────────────────────────────────
# Realtime / system load
registry.register(SystemLoadProvider())
registry.register(DiskIOProvider())
registry.register(ProcLiveProvider())            # NEW — per-process live (RSS/fd/threads)
registry.register(ProcResourcesProvider())       # NEW — per-process OS trend 7j (anti-fuite lente)
registry.register(ProcAppCountersProvider())     # NEW — compteurs applicatifs trend 7j
# 24h/short term
registry.register(WriteTpsHistoryProvider())
registry.register(LLMLatencyHistoryProvider())
registry.register(LatencyPercentilesProvider())  # NEW — P50/P75/P95/P99
registry.register(RAGUsageProvider())
registry.register(CodeWriteTimeProvider())
# 7-day breakdowns
registry.register(ChatsPerDayProvider())
registry.register(MessagesPerDayProvider())
registry.register(SandboxWritesHistoryProvider())
registry.register(SandboxWritesByExtProvider())
registry.register(SandboxWritesByUserProvider())
registry.register(LoginsPerDayProvider())
registry.register(ActiveUsersPerDayProvider())
registry.register(ToolsUsageProvider())
# 30-day long-term trends (NEW)
registry.register(MessagesHistory30dProvider())
registry.register(ChatLifecycleProvider())
# Capacity / storage (NEW)
registry.register(StorageBreakdownProvider())

# ── v17 — Agentic/sub-agent/team observability providers ───────────────
# Ces 5 widgets vivent dans un module séparé (_v17_providers.py) pour
# qu'on puisse les itérer sans toucher au gros engine.py. Cf. fichier
# pour la description de chaque + sources de données.
try:
    from shared_infra.observability.metrics._usage_providers import register_all as _usage_register_all
    _usage_register_all(registry)
except Exception as _e:
    import logging as _lg
    _lg.getLogger("uvicorn.error").warning("[metrics/usage] register_all failed: %s", _e)

try:
    from shared_infra.observability.metrics._v17_providers import register_all as _v17_register_all
    _v17_register_all(registry)
except Exception as _e:
    # Best-effort : un providers v17 cassé ne doit pas empêcher le
    # dashboard de démarrer. Trace dans les logs uvicorn.
    import logging as _lg
    _lg.getLogger("uvicorn.error").warning("[metrics/v17] register_all failed: %s", _e)
