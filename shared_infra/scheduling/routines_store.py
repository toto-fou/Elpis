# SPDX-License-Identifier: MIT
"""
shared_infra.scheduling.routines_store — Routines planifiées (tâches récurrentes automatisées).

Une « routine » (table ``editor_routines``) appartient à un utilisateur et décrit
une tâche agentique du chatbot à exécuter sur un horaire cron : modèle, system
prompt, prompt de tâche, sélection de serveurs MCP, skills attachés (ids dont le
corps est injecté dans le system prompt au run), mode thinking. Chaque
exécution est journalisée dans ``editor_routine_runs`` (statut/durée/tokens/
résumé/erreur) — AUCUN chat n'est créé (décision produit : journal seulement).

Surface distincte du Superviseur retiré : la routine rejoue simplement la boucle
``run_chat_multi_mcp`` du chatbot en headless. Elle peut déléguer à des
sous-agents (outil ``task``) SI son champ ``agents_enabled`` est explicitement
activé — opt-in par routine, jamais hérité du réglage de chat.

⚠️ Noms de tables : ``editor_routines`` / ``editor_routine_runs`` (préfixe
``editor_``). La migration ``0004_drop_agents_routines_tables`` DROP les anciens
noms ``scheduled_routines``/``routine_runs`` APRÈS les ``init_*_db()`` ; réutiliser
ces noms les ferait dropper sur une base neuve.

Concurrence (multi-worker) : l'admission d'un run est une transaction
``BEGIN IMMEDIATE`` (COUNT du cap + INSERT atomiques → pas de TOCTOU même entre
workers). Réconciliation des runs orphelins par péremption du heartbeat.

Politique d'HISTORIQUE par routine (2026-09-08) — trois colonnes :
  • ``runs_keep``   : nb de runs TERMINÉS conservés au journal (0 = tous, la
    rétention admin ``ROUTINE_RUNS_RETENTION_DAYS`` reste le filet global).
    Appliquée à CHAQUE transition terminale (``_enforce_runs_keep``) — un run
    ``running`` n'est jamais compté ni supprimé.
  • ``notify_on``   : ``all`` | ``error`` | ``none`` — quels runs poussent une
    notification (centre de notifications = « récap » des routines).
  • ``notify_keep`` : nb de notifications conservées POUR CETTE routine (0 =
    pas de cap dédié ; le cap global par utilisateur s'applique toujours).
Le récap suit la routine : suppression → ses notifications partent avec elle ;
renommage → leurs titres sont réécrits (``routine_notification_title``).
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any, Dict, List, Optional

from shared_infra.db._connection import db, db_conn
from shared_infra.db._dialect import begin_write, cast_int, has_table, insert_id

logger = logging.getLogger("uvicorn.error")

# Champs secrets à NE JAMAIS persister dans le snapshot MCP d'une routine.
# Re-résolus à l'exécution depuis les settings de l'utilisateur (cf. scheduler).
# ``auth_enc`` en fait partie : y figer un chiffré gèlerait la rotation de clé
# (le snapshot resservirait un secret que l'utilisateur croit avoir changé).
_MCP_SECRET_KEYS = ("auth", "authorization", "headers", "token", "api_key",
                    "apikey", "password", "secret", "basic_auth", "bearer",
                    "auth_secret", "auth_enc", "key_scheme",
                    # Créneaux supplémentaires (2026-08-30) : en-têtes et
                    # variables d'environnement portent des jetons au même
                    # titre. ``env`` compris — c'est par là qu'un serveur stdio
                    # reçoit le sien.
                    "headers_enc", "env", "env_enc", "extra_scheme")


def _sanitize_skills(value: Any) -> List[str]:
    """Liste d'ids de skills propre : strings non vides, strippées, dédupliquées
    (ordre conservé). Forme persistée du champ ``skills`` (JSON array). On ne
    snapshotte QUE les ids — les corps sont résolus frais à l'exécution, donc
    une mise à jour du skill profite aux routines existantes."""
    out: List[str] = []
    if not isinstance(value, list):
        return out
    for s in value:
        if not isinstance(s, str):
            continue
        s = s.strip()
        if s and s not in out:
            out.append(s)
    return out


# ── Politique d'historique PAR ROUTINE ───────────────────────────────────────
# Valeurs acceptées de ``notify_on`` (défaut 'all' = comportement historique).
NOTIFY_ON_VALUES = ("all", "error", "none")
# Borne haute des compteurs « conservés » : au-delà, autant laisser 0 (tous).
KEEP_MAX = 500


def _norm_notify_on(value: Any) -> str:
    v = str(value or "all").strip().lower()
    return v if v in NOTIFY_ON_VALUES else "all"


def _norm_keep(value: Any) -> int:
    """Compteur « conservés » : entier borné [0, KEEP_MAX] ; tout ce qui n'est
    pas un entier vaut 0 (= pas de cap)."""
    if isinstance(value, bool):
        return 0
    try:
        n = int(value)
    except (TypeError, ValueError):
        return 0
    return max(0, min(KEEP_MAX, n))


def routine_notification_title(name: str, routine_id: int, *, ok: bool) -> str:
    """Titre d'une notification de fin de run — UNE seule source, partagée par
    l'émetteur (scheduler) et le renommage (``update_routine``) : le récap doit
    afficher le nom COURANT de la routine, pas celui du jour du run."""
    label = (name or "").strip() or f"Routine #{int(routine_id)}"
    return f"Routine « {label} » terminée" if ok else f"Routine « {label} » en échec"


def _table_exists(cur, name: str) -> bool:
    return has_table(cur.connection, name)


# Un run bavard peut toucher des centaines de fichiers ; le journal n'a pas
# vocation à tout lister (et la ligne DB doit rester petite).
_RUN_FILES_MAX = 40
_RUN_FILE_PATH_MAX = 400


def _sanitize_run_files(value: Any) -> List[str]:
    """Chemins produits par un run : strings non vides, dédupliqués, bornés.

    L'ordre d'écriture est conservé (le dernier fichier écrit est souvent le
    livrable). Aucun contenu n'est stocké — juste des chemins déjà bornés au
    sandbox de l'utilisateur par les outils fs.
    """
    out: List[str] = []
    if not isinstance(value, (list, tuple)):
        return out
    for p in value:
        if not isinstance(p, str):
            continue
        p = p.strip()[:_RUN_FILE_PATH_MAX]
        if p and p not in out:
            out.append(p)
        if len(out) >= _RUN_FILES_MAX:
            break
    return out


def _strip_mcp_secrets(servers: Any) -> List[Dict[str, Any]]:
    """Retire les champs secrets de chaque config serveur MCP avant persistance.

    Conserve la FORME (type/url/command/name/filter_categories…) pour un rejeu
    déterministe ; les secrets seront re-fusionnés depuis les settings user au
    moment de l'exécution.
    """
    out: List[Dict[str, Any]] = []
    if not isinstance(servers, list):
        return out
    for s in servers:
        if not isinstance(s, dict):
            continue
        clean = {k: v for k, v in s.items() if k not in _MCP_SECRET_KEYS}
        out.append(clean)
    return out


def init_routines_db() -> None:
    """Crée les tables routines (+ livraisons webhook, exécutions) et leurs
    index, et ajoute aux bases anciennes les colonnes venues après coup
    (skills, webhook_*, trigger_after_*, agents_enabled, runs_keep,
    notify_*, connector_id, files). Idempotent — DDL du schéma de référence
    (``shared_infra/db/_schema.py``)."""
    from shared_infra.db._schema import ensure_tables
    with db_conn() as conn:
        ensure_tables(conn, ("editor_routines", "editor_webhook_deliveries",
                             "editor_routine_runs"))
        conn.commit()


def purge_webhook_deliveries(ttl_s: float = 86400.0) -> int:
    """Purge de fond des lignes de dédup webhook périmées. La purge « au fil de
    l'eau » (record_webhook_delivery) ne tourne QUE sur livraison : si les
    livraisons cessent, la table restait figée indéfiniment. Appelée par la
    maintenance quotidienne. Best-effort : ne lève jamais."""
    try:
        with db_conn() as conn:
            cur = conn.cursor()
            cur.execute("DELETE FROM editor_webhook_deliveries WHERE received_at < ?",
                        (time.time() - float(ttl_s),))
            n = cur.rowcount
            conn.commit()
            if n:
                logger.info("[maintenance] %d livraison(s) webhook purgée(s).", n)
            return n
    except Exception:
        logger.debug("[maintenance] purge_webhook_deliveries failed (non-fatal)",
                     exc_info=True)
        return 0


def purge_routine_runs(retention_days: int = 180) -> int:
    """Supprime les ``editor_routine_runs`` terminés de plus de ``retention_days``.

    Une ligne par exécution de routine, sans aucune purge auparavant → croissance
    illimitée sur un serveur longue durée. On ne touche JAMAIS un run encore
    ``running`` (la réconciliation orphelins s'en charge). Appelée par la passe de
    maintenance quotidienne. ``retention_days <= 0`` → no-op. Best-effort : ne
    lève jamais. Retourne le nb de lignes supprimées.
    """
    if retention_days <= 0:
        return 0
    try:
        with db_conn() as conn:
            cur = conn.cursor()
            cutoff = time.time() - retention_days * 86400
            cur.execute(
                "DELETE FROM editor_routine_runs WHERE started_at < ? AND status != 'running'",
                (cutoff,))
            count = cur.rowcount
            conn.commit()
            if count:
                logger.info("[maintenance] %d editor_routine_runs purgé(s) (>%dj).",
                            count, retention_days)
            return count
    except Exception:
        logger.debug("[maintenance] purge_routine_runs failed (non-fatal)", exc_info=True)
        return 0


# ─────────────────────────────────────────────────────────────────────────────
#  Sérialisation
# ─────────────────────────────────────────────────────────────────────────────
def _row_to_routine(row) -> Dict[str, Any]:
    d = dict(row)
    try:
        d["mcp_snapshot"] = json.loads(d.get("mcp_snapshot") or "[]")
    except Exception:
        d["mcp_snapshot"] = []
    try:
        d["skills"] = _sanitize_skills(json.loads(d.get("skills") or "[]"))
    except Exception:
        d["skills"] = []
    d["thinking_mode"] = bool(d.get("thinking_mode"))
    d["enabled"] = bool(d.get("enabled"))
    # Serveur d'inférence : absent d'une ligne d'avant migration → intégré.
    d["connector_id"] = int(d["connector_id"]) if d.get("connector_id") else None
    # Sous-agents : absent d'une ligne d'avant migration → False (opt-in strict).
    d["agents_enabled"] = bool(d.get("agents_enabled"))
    # Webhook : le secret ne sort JAMAIS d'ici (ni GET, ni exécuteur) — la
    # route publique le lit via get_routine_webhook_secret. L'UI n'a besoin
    # que de « un secret existe ».
    d["webhook_has_secret"] = bool(d.pop("webhook_secret", None))
    d["webhook_enabled"] = bool(d.get("webhook_enabled"))
    # Colonnes de l'éphémère « mode client » (retiré) : ne pas les réexposer
    # si une base intermédiaire les porte encore.
    d.pop("webhook_mode", None)
    d.pop("webhook_url", None)
    try:
        f = json.loads(d.get("webhook_filter") or "{}")
        d["webhook_filter"] = f if isinstance(f, dict) else {}
    except Exception:
        d["webhook_filter"] = {}
    # Enchaînement : normalisé même sur une ligne d'avant migration.
    try:
        d["trigger_after_id"] = int(d["trigger_after_id"]) if d.get("trigger_after_id") else None
    except (TypeError, ValueError, KeyError):
        d["trigger_after_id"] = None
    d["trigger_after_on"] = d.get("trigger_after_on") or "ok"
    # Historique : valeurs normalisées même sur une ligne d'avant migration
    # (ou trafiquée en base) — le front et l'exécuteur lisent des types sûrs.
    d["runs_keep"] = _norm_keep(d.get("runs_keep"))
    d["notify_on"] = _norm_notify_on(d.get("notify_on"))
    d["notify_keep"] = _norm_keep(d.get("notify_keep"))
    return d


# ─────────────────────────────────────────────────────────────────────────────
#  CRUD (owner-gated : chaque requête porte owner_user_id)
# ─────────────────────────────────────────────────────────────────────────────
def create_routine(owner_user_id: int, *, name: str, cron_expr: str,
                   model: Optional[str], system_prompt: str, task_prompt: str,
                   connector_id: Optional[int] = None,
                   mcp_servers: Any, skills: Any = None,
                   thinking_mode: bool = False, enabled: bool = True,
                   trigger_after_id: Optional[int] = None,
                   trigger_after_on: str = "ok",
                   agents_enabled: bool = False,
                   runs_keep: int = 0, notify_on: str = "all",
                   notify_keep: int = 0) -> int:
    now = time.time()
    snapshot = json.dumps(_strip_mcp_secrets(mcp_servers), ensure_ascii=False)
    skills_json = json.dumps(_sanitize_skills(skills), ensure_ascii=False)
    with db_conn() as conn:
        cur = conn.cursor()
        new_id = insert_id(
            cur,
            "INSERT INTO editor_routines(owner_user_id, name, cron_expr, model, "
            "connector_id, system_prompt, task_prompt, mcp_snapshot, skills, "
            "thinking_mode, enabled, created_at, updated_at, trigger_after_id, "
            "trigger_after_on, agents_enabled, runs_keep, notify_on, notify_keep) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (int(owner_user_id), name, cron_expr, (model or None),
             int(connector_id) if connector_id else None,
             system_prompt or "", task_prompt or "", snapshot, skills_json,
             1 if thinking_mode else 0, 1 if enabled else 0, now, now,
             int(trigger_after_id) if trigger_after_id else None,
             trigger_after_on if trigger_after_on in ("ok", "error", "always") else "ok",
             1 if agents_enabled else 0,
             _norm_keep(runs_keep), _norm_notify_on(notify_on), _norm_keep(notify_keep)),
        )
        conn.commit()
        return new_id


def list_routines(owner_user_id: int) -> List[Dict[str, Any]]:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT * FROM editor_routines WHERE owner_user_id=? "
                    "ORDER BY created_at DESC", (int(owner_user_id),))
        rows = [_row_to_routine(r) for r in cur.fetchall()]
        if not rows:
            return rows
        # Enrichit chaque routine avec l'état de son DERNIER run (statut/horodatage,
        # SANS le summary complet pour garder la liste légère) + le nb de runs en
        # cours, pour afficher un statut « d'un coup d'œil » côté liste. 2 requêtes
        # agrégées owner-gated (pas de N+1).
        # ``id`` départage les égalités de started_at (sinon plusieurs lignes
        # revenaient et la « dernière » retenue était arbitraire).
        cur.execute(
            "SELECT routine_id, status, started_at, ended_at, duration_ms "
            "FROM editor_routine_runs r WHERE owner_user_id=? AND id=("
            "  SELECT id FROM editor_routine_runs "
            "  WHERE routine_id=r.routine_id AND owner_user_id=r.owner_user_id "
            "  ORDER BY started_at DESC, id DESC LIMIT 1)",
            (int(owner_user_id),))
        last_by_rid: Dict[int, Dict[str, Any]] = {}
        for rr in cur.fetchall():
            d = dict(rr)
            last_by_rid[int(d["routine_id"])] = d
        cur.execute(
            "SELECT routine_id, COUNT(*) AS n FROM editor_routine_runs "
            "WHERE owner_user_id=? AND status='running' GROUP BY routine_id",
            (int(owner_user_id),))
        running_by_rid = {int(rr["routine_id"]): int(rr["n"]) for rr in cur.fetchall()}
        for r in rows:
            r["last_run"] = last_by_rid.get(int(r["id"]))
            r["running_count"] = running_by_rid.get(int(r["id"]), 0)
        return rows


def get_routine(routine_id: int, owner_user_id: int) -> Optional[Dict[str, Any]]:
    """Tenant-gated : ne renvoie la routine que si elle appartient à l'user."""
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT * FROM editor_routines WHERE id=? AND owner_user_id=?",
                    (int(routine_id), int(owner_user_id)))
        row = cur.fetchone()
        return _row_to_routine(row) if row else None


def get_routine_internal(routine_id: int) -> Optional[Dict[str, Any]]:
    """Récupère par id seul. RÉSERVÉ à l'exécuteur (contexte déjà de confiance) ;
    ne JAMAIS utiliser depuis une route (utiliser get_routine avec owner_user_id)."""
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT * FROM editor_routines WHERE id=?", (int(routine_id),))
        row = cur.fetchone()
        return _row_to_routine(row) if row else None


# Champs éditables via update_routine.
_UPDATABLE = ("name", "cron_expr", "model", "connector_id", "system_prompt", "task_prompt",
              "mcp_snapshot", "skills", "thinking_mode", "enabled",
              "trigger_after_id", "trigger_after_on", "agents_enabled",
              "runs_keep", "notify_on", "notify_keep")

# Champs où ``None`` est une VALEUR légitime à persister (NULL), pas un
# marqueur « inchangé ». La sémantique « champ absent = inchangé » est
# portée par ``if k in fields`` (la route ne met une clé dans fields que
# si le client l'a envoyée). Sans ça, PUT {model: null} (« revenir au
# modèle par défaut ») était silencieusement ignoré : toast de succès,
# mais le scheduler continuait avec l'ancien modèle.
_NULLABLE = {"model", "connector_id", "trigger_after_id"}


def update_routine(routine_id: int, owner_user_id: int, **fields) -> bool:
    """UPDATE owner-gated. ``mcp_servers`` (liste) → re-snapshot strippé.
    Retourne True si une ligne a été modifiée."""
    sets: List[str] = []
    params: List[Any] = []
    if "mcp_servers" in fields:
        fields["mcp_snapshot"] = json.dumps(
            _strip_mcp_secrets(fields.pop("mcp_servers")), ensure_ascii=False)
    if "skills" in fields:
        fields["skills"] = json.dumps(
            _sanitize_skills(fields["skills"]), ensure_ascii=False)
    for k in ("runs_keep", "notify_keep"):
        if k in fields:
            fields[k] = _norm_keep(fields[k])
    if "notify_on" in fields:
        fields["notify_on"] = _norm_notify_on(fields["notify_on"])
    for k in _UPDATABLE:
        if k in fields and (fields[k] is not None or k in _NULLABLE):
            v = fields[k]
            if k in ("thinking_mode", "enabled", "agents_enabled"):
                v = 1 if v else 0
            sets.append(f"{k}=?")
            params.append(v)
    if not sets:
        # Aucun champ persistable ≠ routine inexistante : la route traduit un
        # ``False`` en 404 « Routine introuvable », ce qui faisait croire à
        # l'utilisateur qu'il avait perdu sa routine sur un PUT no-op.
        with db_conn() as conn:
            cur = conn.cursor()
            cur.execute("SELECT 1 FROM editor_routines WHERE id=? AND owner_user_id=?",
                        (int(routine_id), int(owner_user_id)))
            return cur.fetchone() is not None
    sets.append("updated_at=?")
    params.append(time.time())
    params.extend([int(routine_id), int(owner_user_id)])
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute(f"UPDATE editor_routines SET {', '.join(sets)} "
                    f"WHERE id=? AND owner_user_id=?", params)
        changed = cur.rowcount > 0
        # Renommage → le récap (centre de notifications) suit : les titres
        # « Routine « ancien nom » terminée » sont réécrits au nom courant.
        # Même connexion/transaction (une 2e connexion bloquerait sur le
        # verrou d'écriture tenu ici).
        if changed and "name" in fields and _table_exists(cur, "notifications"):
            for kind, ok in (("routine_ok", True), ("routine_error", False)):
                cur.execute(
                    "UPDATE notifications SET title=? WHERE owner_user_id=? "
                    "AND ref_type='routine' AND ref_id=? AND kind=?",
                    (routine_notification_title(fields["name"], routine_id, ok=ok),
                     int(owner_user_id), int(routine_id), kind))
        conn.commit()
        return changed


def set_routine_webhook(routine_id: int, owner_user_id: int, *,
                        enabled: Optional[bool] = None,
                        secret: Optional[str] = None,
                        filter: Optional[Dict[str, Any]] = None) -> bool:
    """Met à jour le déclencheur webhook (owner-gated). Champs à ``None`` =
    inchangés. ``filter`` est sérialisé tel quel (validé côté route)."""
    sets: List[str] = []
    params: List[Any] = []
    if enabled is not None:
        sets.append("webhook_enabled=?")
        params.append(1 if enabled else 0)
    if secret is not None:
        sets.append("webhook_secret=?")
        params.append(secret)
    if filter is not None:
        sets.append("webhook_filter=?")
        params.append(json.dumps(filter, ensure_ascii=False))
    if not sets:
        return False
    sets.append("updated_at=?")
    params.append(time.time())
    params.extend([int(routine_id), int(owner_user_id)])
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute(f"UPDATE editor_routines SET {', '.join(sets)} "
                    f"WHERE id=? AND owner_user_id=?", params)
        conn.commit()
        return cur.rowcount > 0


def get_routine_webhook_secret(routine_id: int) -> Optional[str]:
    """Secret webhook par id seul — RÉSERVÉ à la route publique de livraison
    (vérification HMAC). Jamais exposé par les GET (cf. _row_to_routine)."""
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT webhook_secret FROM editor_routines WHERE id=?",
                    (int(routine_id),))
        row = cur.fetchone()
        return (row["webhook_secret"] or None) if row else None


def record_webhook_delivery(delivery_id: str, routine_id: int,
                            *, ttl_s: float = 86400.0) -> bool:
    """Enregistre une livraison webhook — True si PREMIÈRE vue (à traiter),
    False si rejouée (Gitea/GitHub retentent avec le même id). Purge TTL au
    passage : la table reste bornée sans tâche de maintenance dédiée."""
    now = time.time()
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM editor_webhook_deliveries WHERE received_at < ?",
                    (now - float(ttl_s),))
        cur.execute(
            "INSERT INTO editor_webhook_deliveries"
            "(delivery_id, routine_id, received_at) VALUES(?,?,?) "
            "ON CONFLICT(delivery_id, routine_id) DO NOTHING",
            (str(delivery_id)[:128], int(routine_id), now))
        fresh = cur.rowcount > 0
        conn.commit()
        return fresh


def forget_webhook_delivery(delivery_id: str, routine_id: int) -> bool:
    """Retire la marque de dédup d'une livraison — la prochaine présentation du
    MÊME ``delivery_id`` sera de nouveau traitée comme neuve.

    Compensation de ``record_webhook_delivery`` : la marque est posée AVANT le
    lancement du run (elle doit l'être — c'est elle qui sérialise deux retries
    simultanés arrivant sur deux workers). Si le lancement échoue ensuite sur
    une panne TRANSITOIRE (``BEGIN IMMEDIATE`` refusé après le busy_timeout,
    disque plein), l'émetteur voit un 5xx et retente avec le même id : sans ce
    retrait, le retry était acquitté « duplicate » et le run PERDU pour de bon,
    sans trace au journal. Best-effort : ne lève jamais (on est déjà sur un
    chemin d'erreur)."""
    try:
        with db_conn() as conn:
            cur = conn.cursor()
            cur.execute("DELETE FROM editor_webhook_deliveries "
                        "WHERE delivery_id=? AND routine_id=?",
                        (str(delivery_id)[:128], int(routine_id)))
            n = cur.rowcount
            conn.commit()
            return n > 0
    except Exception:
        logger.warning("[webhooks] dédup non retirée pour la livraison %r "
                       "(routine %s) — un retry sera ignoré",
                       str(delivery_id)[:128], routine_id, exc_info=True)
        return False


def set_routine_enabled(routine_id: int, owner_user_id: int, enabled: bool) -> bool:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("UPDATE editor_routines SET enabled=?, updated_at=? "
                    "WHERE id=? AND owner_user_id=?",
                    (1 if enabled else 0, time.time(),
                     int(routine_id), int(owner_user_id)))
        conn.commit()
        return cur.rowcount > 0


def delete_routine(routine_id: int, owner_user_id: int) -> bool:
    """DELETE owner-gated ; CASCADE supprime les runs associés.

    Nettoie aussi (même transaction) :
      • les pointeurs d'enchaînement ``trigger_after_id`` des routines AVAL —
        la colonne n'a pas de FK, une aval sans planification restait
        « après #17 » à jamais, silencieusement sans plus aucun déclencheur ;
      • les lignes de dédup webhook de la routine (pas de FK non plus) ;
      • ses notifications (le « récap » listait des routines qui n'existaient
        plus, et leur deep-link tombait sur une autre routine).
    """
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM editor_routines WHERE id=? AND owner_user_id=?",
                    (int(routine_id), int(owner_user_id)))
        deleted = cur.rowcount > 0
        if deleted:
            cur.execute("UPDATE editor_routines SET trigger_after_id=NULL, updated_at=? "
                        "WHERE trigger_after_id=?", (time.time(), int(routine_id)))
            cur.execute("DELETE FROM editor_webhook_deliveries WHERE routine_id=?",
                        (int(routine_id),))
            if _table_exists(cur, "notifications"):
                cur.execute("DELETE FROM notifications WHERE owner_user_id=? "
                            "AND ref_type='routine' AND ref_id=?",
                            (int(owner_user_id), int(routine_id)))
        conn.commit()
        return deleted


# ─────────────────────────────────────────────────────────────────────────────
#  Scheduler / concurrence
# ─────────────────────────────────────────────────────────────────────────────
def list_enabled_routines() -> List[Dict[str, Any]]:
    """Toutes les routines actives, tous users (lu par le leader)."""
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT * FROM editor_routines WHERE enabled=1")
        return [_row_to_routine(r) for r in cur.fetchall()]


def list_chained_routines(after_routine_id: int) -> List[Dict[str, Any]]:
    """Routines AVAL actives pointant « après » la routine donnée
    (enchaînement à la Jenkins — lu à chaque fin de run réelle)."""
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT * FROM editor_routines "
                    "WHERE enabled=1 AND trigger_after_id=?",
                    (int(after_routine_id),))
        return [_row_to_routine(r) for r in cur.fetchall()]


def claim_minute_fire(routine_id: int, minute_key: str) -> bool:
    """Garde anti-double-fire par routine ET par minute (atomique).

    Retourne True si CE tick a le droit de déclencher la routine pour cette
    minute (premier à poser ``last_fire_minute=minute_key``), False sinon.
    Survit à un handoff de leader dans la même minute.
    """
    conn = db()
    try:
        conn.isolation_level = None  # contrôle explicite de la transaction
        cur = conn.cursor()
        begin_write(conn)
        cur.execute(
            "UPDATE editor_routines SET last_fire_minute=? "
            "WHERE id=? AND (last_fire_minute IS NULL OR last_fire_minute != ?)",
            (minute_key, int(routine_id), minute_key))
        won = cur.rowcount > 0
        cur.execute("COMMIT")
        return won
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
        raise
    finally:
        try:
            conn.close()
        except Exception:
            pass


def count_running_for_routine(routine_id: int, *, fresh_after_s: "Optional[float]" = None) -> int:
    """Nombre de runs ``running`` pour CETTE routine. Si ``fresh_after_s`` est
    fourni, ne compte que les runs au heartbeat FRAIS (``heartbeat_at`` récent) —
    un run bloqué/orphelin (heartbeat figé) ne compte PAS comme actif, il sera
    réconcilié. Sert à la garde anti-chevauchement par-routine (F10)."""
    with db_conn() as conn:
        cur = conn.cursor()
        if fresh_after_s is not None:
            cur.execute(
                "SELECT COUNT(*) AS n FROM editor_routine_runs "
                "WHERE routine_id=? AND status='running' AND heartbeat_at >= ?",
                (int(routine_id), time.time() - float(fresh_after_s)))
        else:
            cur.execute("SELECT COUNT(*) AS n FROM editor_routine_runs "
                        "WHERE routine_id=? AND status='running'", (int(routine_id),))
        return int((cur.fetchone() or {"n": 0})["n"])


def admit_and_insert_run(routine_id: int, owner_user_id: int, *, trigger: str,
                        cap: int, worker_boot_id: str,
                        overlap_fresh_after_s: Optional[float] = None) -> Optional[int]:
    """Admission atomique gardée par le cap de runs simultanés par utilisateur
    ET (si ``overlap_fresh_after_s`` est fourni) par la garde anti-chevauchement
    PAR ROUTINE (F10).

    ``BEGIN IMMEDIATE`` prend le verrou d'écriture SQLite immédiatement, donc
    les COUNT et l'INSERT forment une seule section critique : deux workers
    (run-now + webhook + scheduled) ne peuvent ni dépasser le cap, ni admettre
    deux runs parallèles de la même routine. F10 vivait avant dans l'appelant
    (``launch_run``) en DEUX transactions — deux livraisons webhook simultanées
    sur deux workers lisaient toutes deux count=0 (TOCTOU) → double run.

    Retourne le ``run_id`` créé (status='running'), ou ``None`` si refusé
    (l'appelant journalise alors un run 'skipped' avec la raison).
    """
    conn = db()
    try:
        conn.isolation_level = None
        cur = conn.cursor()
        begin_write(conn)
        if overlap_fresh_after_s is not None:
            # F10 : un run ACTIF (heartbeat frais) pour cette routine → refus.
            # Un run bloqué/orphelin (heartbeat figé) ne compte pas.
            cur.execute(
                "SELECT COUNT(*) AS n FROM editor_routine_runs "
                "WHERE routine_id=? AND status='running' AND heartbeat_at >= ?",
                (int(routine_id), time.time() - float(overlap_fresh_after_s)))
            if int((cur.fetchone() or {"n": 0})["n"]) > 0:
                cur.execute("COMMIT")
                return None
        cur.execute("SELECT COUNT(*) AS n FROM editor_routine_runs "
                    "WHERE owner_user_id=? AND status='running'",
                    (int(owner_user_id),))
        running = int((cur.fetchone() or {"n": 0})["n"])
        if running >= int(cap):
            cur.execute("COMMIT")
            return None
        now = time.time()
        run_id = insert_id(
            cur,
            "INSERT INTO editor_routine_runs(routine_id, owner_user_id, status, "
            '"trigger", started_at, worker_boot_id, heartbeat_at) '
            "VALUES(?,?,'running',?,?,?,?)",
            (int(routine_id), int(owner_user_id), trigger, now,
             worker_boot_id, now))
        cur.execute("COMMIT")
        return run_id
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
        raise
    finally:
        try:
            conn.close()
        except Exception:
            pass


def insert_skipped_run(routine_id: int, owner_user_id: int, *, trigger: str,
                      reason: str) -> int:
    """Journalise un run non lancé (cap atteint / désactivé)."""
    now = time.time()
    with db_conn() as conn:
        cur = conn.cursor()
        run_id = insert_id(
            cur,
            "INSERT INTO editor_routine_runs(routine_id, owner_user_id, status, "
            '"trigger", started_at, ended_at, duration_ms, error) '
            "VALUES(?,?,'skipped',?,?,?,0,?)",
            (int(routine_id), int(owner_user_id), trigger, now, now,
             (reason or "")[:500]))
        # Un skip est terminal dès l'insertion : il compte dans « X conservés ».
        _enforce_runs_keep(cur, run_id)
        conn.commit()
        return run_id


def _enforce_runs_keep(cur, run_id: int) -> int:
    """Applique le ``runs_keep`` de la routine du run ``run_id`` : supprime les
    runs TERMINÉS les plus anciens au-delà des ``runs_keep`` plus récents.
    0 = no-op. Un run ``running`` n'est ni compté ni supprimé. Même connexion
    que la transition terminale appelante (une seule transaction) — c'est
    ainsi que « garder X exécutions » tient sans tâche de fond dédiée.
    Retourne le nb de lignes supprimées."""
    cur.execute(
        "SELECT r.routine_id AS rid, t.runs_keep AS keep FROM editor_routine_runs r "
        "JOIN editor_routines t ON t.id=r.routine_id WHERE r.id=?", (int(run_id),))
    row = cur.fetchone()
    if not row:
        return 0
    keep = _norm_keep(row["keep"])
    if keep <= 0:
        return 0
    rid = int(row["rid"])
    cur.execute(
        "DELETE FROM editor_routine_runs WHERE routine_id=? AND status!='running' "
        "AND id NOT IN (SELECT id FROM (SELECT id FROM editor_routine_runs WHERE routine_id=? "
        "AND status!='running' ORDER BY started_at DESC, id DESC LIMIT ?) AS garde)",
        (rid, rid, keep))
    return int(cur.rowcount)


def mark_run_ok(run_id: int, *, input_tokens: int = 0, output_tokens: int = 0,
               duration_ms: int = 0, summary: str = "",
               tool_limit_reached: bool = False,
               files: Optional[List[str]] = None) -> bool:
    """Marque un run terminé OK. Gardé ``WHERE status='running'`` (no-op si déjà
    réconcilié orphelin ou si CASCADE l'a supprimé).

    ``files`` = chemins écrits/modifiés pendant le run (déduits des events de la
    boucle d'outils). Le journal ne portait que du texte : pour retrouver ce que
    la routine avait PRODUIT il fallait deviner et fouiller l'éditeur à la main.
    """
    payload = json.dumps(_sanitize_run_files(files), ensure_ascii=False)
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "UPDATE editor_routine_runs SET status='ok', ended_at=?, duration_ms=?, "
            "input_tokens=?, output_tokens=?, summary=?, tool_limit_reached=?, files=? "
            "WHERE id=? AND status='running'",
            (time.time(), int(duration_ms), int(input_tokens), int(output_tokens),
             (summary or "")[:4000], 1 if tool_limit_reached else 0, payload,
             int(run_id)))
        changed = cur.rowcount > 0
        if changed:
            _enforce_runs_keep(cur, run_id)
        conn.commit()
        return changed


def mark_run_error(run_id: int, *, error: str, duration_ms: int = 0,
                   summary: str = "", input_tokens: int = 0,
                   output_tokens: int = 0,
                   files: Optional[List[str]] = None) -> bool:
    """Marque un run en échec. Gardé ``WHERE status='running'`` comme les autres.

    AUDIT 2026-08-23 — les champs de bilan sont désormais acceptés ici aussi.
    Une génération qui échoue APRÈS avoir travaillé (l'appel LLM meurt à
    l'itération 40) a produit une réponse partielle, consommé des tokens et
    parfois écrit des fichiers : les perdre ferait d'un échec une ligne vide,
    alors que c'est justement le cas où l'on veut voir ce qui a été fait.
    Valeurs par défaut = comportement historique inchangé pour les appelants
    qui ne passent que ``error``.
    """
    payload = json.dumps(_sanitize_run_files(files), ensure_ascii=False)
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "UPDATE editor_routine_runs SET status='error', ended_at=?, "
            "duration_ms=?, error=?, summary=?, input_tokens=?, output_tokens=?, "
            "files=? WHERE id=? AND status='running'",
            (time.time(), int(duration_ms), (error or "")[:1000],
             (summary or "")[:4000], int(input_tokens), int(output_tokens),
             payload, int(run_id)))
        changed = cur.rowcount > 0
        if changed:
            _enforce_runs_keep(cur, run_id)
        conn.commit()
        return changed


def mark_run_skipped(run_id: int, *, reason: str, duration_ms: int = 0) -> bool:
    """Requalifie un run DÉJÀ admis (status='running') en 'skipped' — routine
    supprimée/désactivée entre l'admission et le démarrage. Avant, ce chemin
    passait par ``mark_run_error`` : le journal affichait un « Échec » rouge
    pour une désactivation volontaire."""
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "UPDATE editor_routine_runs SET status='skipped', ended_at=?, "
            "duration_ms=?, error=? WHERE id=? AND status='running'",
            (time.time(), int(duration_ms), (reason or "")[:500], int(run_id)))
        changed = cur.rowcount > 0
        if changed:
            _enforce_runs_keep(cur, run_id)
        conn.commit()
        return changed


def mark_run_cancelled(run_id: int, *, duration_ms: int = 0) -> bool:
    """Arrêt VOLONTAIRE (bouton « Arrêter » du journal) : statut terminal
    dédié — un stop utilisateur n'est pas un échec, le journal ne doit pas
    afficher « Échec » en rouge pour un geste délibéré. Même garde
    ``WHERE status='running'`` que mark_run_ok/mark_run_error.

    Limitation assumée : ni ``summary`` ni ``files`` ne sont persistés — au
    moment du CancelledError, la boucle d'outils n'a pas rendu ses events
    (le travail partiel du run n'est pas récupérable ici)."""
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "UPDATE editor_routine_runs SET status='cancelled', ended_at=?, "
            "duration_ms=? WHERE id=? AND status='running'",
            (time.time(), int(duration_ms), int(run_id)))
        changed = cur.rowcount > 0
        if changed:
            _enforce_runs_keep(cur, run_id)
        conn.commit()
        return changed


def get_run(run_id: int, owner_user_id: int) -> Optional[Dict[str, Any]]:
    """Un run précis, owner-gated (validation de propriété pour le stop)."""
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT * FROM editor_routine_runs WHERE id=? AND owner_user_id=?",
            (int(run_id), int(owner_user_id)))
        r = cur.fetchone()
        return dict(r) if r else None


def heartbeat_run(run_id: int) -> bool:
    """Met à jour le heartbeat d'un run en cours (détection d'orphelin)."""
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("UPDATE editor_routine_runs SET heartbeat_at=? "
                    "WHERE id=? AND status='running'", (time.time(), int(run_id)))
        conn.commit()
        return cur.rowcount > 0


def reconcile_orphans(stale_after_s: float = 300.0) -> int:
    """Passe en 'orphaned' les runs 'running' dont le heartbeat est périmé
    (processus exécutant probablement mort). Indépendant du worker : chaque
    worker exécutant rafraîchit le heartbeat de SES runs ; un heartbeat figé
    > ``stale_after_s`` signale un orphelin. Retourne le nb de runs réconciliés."""
    now = time.time()
    cutoff = now - float(stale_after_s)
    with db_conn() as conn:
        cur = conn.cursor()
        # duration_ms : borne basse honnête (dernier signe de vie − départ) —
        # la colonne restait NULL et le journal affichait « — ».
        cur.execute(
            "UPDATE editor_routine_runs SET status='orphaned', ended_at=?, "
            "duration_ms="
            + cast_int("ROUND((COALESCE(heartbeat_at, started_at) - started_at) * 1000)")
            + ", "
            "error='reconciled: heartbeat périmé (processus arrêté ?)' "
            "WHERE status='running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)",
            (now, cutoff))
        n = cur.rowcount
        conn.commit()
        return n


def list_runs(routine_id: int, owner_user_id: int, *, limit: int = 50,
             offset: int = 0) -> List[Dict[str, Any]]:
    """Journal des runs d'une routine (owner-gated)."""
    limit = max(1, min(int(limit or 50), 500))
    offset = max(0, int(offset or 0))
    with db_conn() as conn:
        cur = conn.cursor()
        # Clé secondaire ``id DESC`` : deux runs à started_at identique (skip +
        # lancement dans la même milliseconde) rendaient la pagination et le
        # « dernier run » de la liste instables.
        cur.execute(
            "SELECT * FROM editor_routine_runs WHERE routine_id=? AND owner_user_id=? "
            "ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?",
            (int(routine_id), int(owner_user_id), limit, offset))
        out: List[Dict[str, Any]] = []
        for r in cur.fetchall():
            d = dict(r)
            # ``files`` est stocké en JSON : la route le renvoie tel quel, donc
            # on décode ICI (une ligne d'avant migration vaut '[]' / NULL).
            try:
                d["files"] = _sanitize_run_files(json.loads(d.get("files") or "[]"))
            except (TypeError, ValueError):
                d["files"] = []
            out.append(d)
        return out
