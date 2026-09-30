# SPDX-License-Identifier: MIT
"""
shared_infra/opencode/store.py — store SQLite de la page « Code ».

Persiste l'état remonté par le plugin ``elpis-remote`` (sessions, messages,
parts opencode BRUTES) + la file de commandes page→plugin + les clients
(process opencode) vus. Remplace l'ancien store en mémoire intra-worker :
toutes les écritures sont des transactions courtes sur la DB partagée (WAL),
donc n'importe quel worker gunicorn peut servir l'ingest, le pull ou la page.

Points structurants :
- le claim des commandes (``claim_commands``) est atomique (``begin_write`` :
  BEGIN IMMEDIATE en SQLite)
  → deux pulls concurrents (même cross-worker) ne consomment jamais deux fois
  la même commande ;
- l'epoch est persisté (``code_meta``) : stable entre workers ET redéploiements
  → le plugin ne re-snapshotte plus ses sessions à chaque restart de l'app
  (l'historique est durable) ;
- les parts sont stockées telles quelles (JSON brut opencode) — le schéma des
  parts dépend de la version d'opencode, le store n'interprète que les ids.
"""
from __future__ import annotations

import json
import os
import sqlite3
import time

from shared_infra.db import _connection as _dbc
from shared_infra.db._connection import db_tx
from shared_infra.db._dialect import begin_write
from shared_infra.db._schema import ensure_tables

# Une commande en file non tirée en 90 s est périmée (CLI absente).
CMD_TTL = 90.0
# Un client (process opencode) est « connecté » si vu (pull/ingest) il y a < 40 s.
CLIENT_TTL = 40.0
# Sessions sans activité depuis 14 j purgées (la CLI peut toujours re-snapshotter).
SESSION_TTL = 14 * 86400.0
_PRUNE_EVERY = 60.0

_initialized: set = set()   # (pid, base) dont le schéma est posé
_last_prune = 0.0

_CODE_TABLES = ("code_sessions", "code_messages", "code_parts", "code_clients",
                "code_commands", "code_meta", "code_notes", "code_permissions",
                "code_questions")


def _ensure_schema() -> None:
    key = (os.getpid(), str(_dbc.DB_PATH))
    if key in _initialized:
        return
    with db_tx() as c:
        # Tables (et colonnes venues après coup) : schéma de référence.
        ensure_tables(c, _CODE_TABLES)
        c.execute('INSERT INTO code_meta(user_id, "key", value) VALUES (0, \'epoch\', ?) '
                  'ON CONFLICT(user_id, "key") DO NOTHING', (repr(time.time()),))
    _initialized.add(key)


def _db():
    """Transaction courte sur la base commune : ``with _db() as c:`` valide à
    la sortie et annule sur exception, puis rend la connexion au pool.

    (2026-09-26) La page Code gardait sa propre connexion SQLite par thread,
    avec d'autres réglages que le pool ; elle passe désormais par
    ``db_tx()`` comme le reste de l'application — condition pour pouvoir
    changer de moteur de base. Les appelants n'ont pas changé.
    """
    _ensure_schema()
    return db_tx()


def _j(v) -> str:
    return json.dumps(v, ensure_ascii=False, default=str)


def _load(s: str) -> dict:
    try:
        d = json.loads(s or "{}")
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def get_epoch() -> float:
    with _db() as c:
        row = c.execute("SELECT value FROM code_meta WHERE user_id=0 AND \"key\"='epoch'").fetchone()
    try:
        return float(row[0]) if row else 0.0
    except (TypeError, ValueError):
        return 0.0


def _meta_set(c: sqlite3.Connection, uid: int, key: str, value: str) -> None:
    c.execute('INSERT INTO code_meta(user_id,"key",value) VALUES(?,?,?) '
              'ON CONFLICT(user_id,"key") DO UPDATE SET value=excluded.value', (uid, key, value))


def _meta_get(uid: int, key: str) -> str:
    with _db() as c:
        row = c.execute('SELECT value FROM code_meta WHERE user_id=? AND "key"=?', (uid, key)).fetchone()
    return row[0] if row else ""


def meta_get(uid: int, key: str) -> str:
    """Lecture code_meta pour les routes (ex. compteur d'échecs d'appairage)."""
    return _meta_get(uid, key)


def meta_set(uid: int, key: str, value: str) -> None:
    with _db() as c:
        _meta_set(c, uid, key, value)
        c.commit()


# ─────────────────────────────────────────────────────────────────────────────
#  Clients (process opencode)
# ─────────────────────────────────────────────────────────────────────────────
def seen_client(uid: int, cid: str, plugin_version: int = 0, directory: str = "",
                revive: bool = False) -> None:
    now = time.time()
    pv = int(plugin_version or 0)
    rv = 1 if revive else 0
    with _db() as c:
        # client tombstoné (bye) : un /pull tardif ne doit rafraîchir NI last_seen
        # NI last_ingest (le fallback de /health garderait « connecté » 40 s).
        # revive=True (chemin INGEST seulement) : le client pousse à nouveau des
        # events (/remote on du même process) → le tombstone est levé.
        if cid and not revive:
            row = c.execute("SELECT bye FROM code_clients WHERE user_id=? AND client_id=?",
                            (uid, cid)).fetchone()
            if row and row[0]:
                return
        _meta_set(c, uid, "last_ingest", repr(now))
        if cid:
            # pv=0 = plugin v1 (n'envoie pas sa version) → insert à 1, et ne pas
            # écraser une version déjà connue pour ce client.
            c.execute(
                "INSERT INTO code_clients(user_id,client_id,last_seen,plugin_version,directory) "
                "VALUES(?,?,?,?,?) ON CONFLICT(user_id,client_id) DO UPDATE SET "
                # Colonnes de la ligne EXISTANTE qualifiées : PostgreSQL tient
                # « bye » seul pour ambigu avec ``excluded.bye``.
                "last_seen=CASE WHEN code_clients.bye=1 AND ?=0 THEN code_clients.last_seen "
                "ELSE excluded.last_seen END, "
                "bye=CASE WHEN ?=1 THEN 0 ELSE code_clients.bye END, "
                "plugin_version=CASE WHEN ?>0 THEN ? ELSE code_clients.plugin_version END, "
                "directory=CASE WHEN excluded.directory!='' THEN excluded.directory "
                "ELSE code_clients.directory END",
                (uid, cid, now, pv if pv > 0 else 1, directory or "", rv, rv, pv, pv))
        c.commit()


def client_bye(uid: int, cid: str) -> None:
    """Déconnexion propre (dispose du plugin) : client mort immédiatement.

    Sans attendre le TTL de 40 s — et si plus aucun client vivant, on remet
    ``last_ingest`` à 0 pour que le fallback de /health lâche aussi tout de suite.
    """
    now = time.time()
    with _db() as c:
        if cid:
            c.execute("UPDATE code_clients SET last_seen=0, bye=1 WHERE user_id=? AND client_id=?",
                      (uid, cid))
        row = c.execute("SELECT COUNT(*) FROM code_clients WHERE user_id=? AND last_seen>?",
                        (uid, now - CLIENT_TTL)).fetchone()
        if not (row and row[0]):
            _meta_set(c, uid, "last_ingest", "0")
        c.commit()


def active_clients(uid: int) -> list:
    with _db() as c:
        rows = c.execute("SELECT client_id FROM code_clients WHERE user_id=? AND last_seen>?",
                         (uid, time.time() - CLIENT_TTL)).fetchall()
    return [r[0] for r in rows]


def clients_list(uid: int) -> list:
    """Clients actifs [{id, directory, plugin_version}] — ciblage /new + landing.

    Les tombstones (bye=1, last_seen=0) tombent naturellement hors du filtre.
    """
    with _db() as c:
        rows = c.execute(
            "SELECT client_id, directory, plugin_version FROM code_clients "
            "WHERE user_id=? AND last_seen>? ORDER BY last_seen DESC",
            (uid, time.time() - CLIENT_TTL)).fetchall()
    return [{"id": r[0], "directory": r[1], "plugin_version": int(r[2] or 0)} for r in rows]


def client_plugin_version(uid: int, cid: str) -> int:
    """Version de plugin d'un client actif précis (0 = client absent/mort)."""
    with _db() as c:
        row = c.execute(
            "SELECT plugin_version FROM code_clients "
            "WHERE user_id=? AND client_id=? AND last_seen>?",
            (uid, cid, time.time() - CLIENT_TTL)).fetchone()
    return int(row[0] or 0) if row else 0


def session_owner(uid: int, sid: str) -> str:
    """client_id propriétaire d'une session ('' si session inconnue)."""
    with _db() as c:
        row = c.execute("SELECT client_id FROM code_sessions WHERE user_id=? AND id=?",
                        (uid, sid)).fetchone()
    return (row[0] or "") if row else ""


def min_plugin_version(uid: int) -> int:
    """Plus vieille version de plugin parmi les clients actifs (0 = aucun client)."""
    with _db() as c:
        row = c.execute("SELECT MIN(plugin_version) FROM code_clients WHERE user_id=? AND last_seen>?",
                        (uid, time.time() - CLIENT_TTL)).fetchone()
    return int(row[0] or 0) if row else 0


def last_ingest(uid: int) -> float:
    try:
        return float(_meta_get(uid, "last_ingest") or 0)
    except (TypeError, ValueError):
        return 0.0


# ─────────────────────────────────────────────────────────────────────────────
#  Application des events (ingest) — une transaction par lot
# ─────────────────────────────────────────────────────────────────────────────
def _part_ts(p: dict) -> float:
    """Timestamp d'une part — ``time`` est un dict ({start,end}) chez opencode."""
    t = p.get("time")
    if isinstance(t, dict):
        t = t.get("start") or t.get("created") or 0
    try:
        return float(t or 0)
    except (TypeError, ValueError):
        return 0.0


def _ensure_session(c: sqlite3.Connection, uid: int, sid: str, cid: str) -> None:
    c.execute("INSERT INTO code_sessions(user_id,id,info,updated_at) VALUES(?,?,?,?) "
              "ON CONFLICT(user_id,id) DO NOTHING",
              (uid, sid, _j({"id": sid, "title": ""}), time.time()))
    if cid:
        c.execute("UPDATE code_sessions SET client_id=? WHERE user_id=? AND id=?", (cid, uid, sid))


def _prune_empty_siblings(c: sqlite3.Connection, uid: int, sid: str, cid: str) -> None:
    """Une seule session VIDE par CLI — les précédentes sont oubliées.

    Le plugin publie désormais les sessions sans message (sinon une session
    fraîche restait invisible alors que la CLI s'affichait connectée). Sans
    garde-fou, chaque redémarrage d'opencode en empilerait une de plus : c'est
    exactement le « ça me crée deux sessions » qui avait fait retenir la
    publication à l'époque. On tranche ici, où l'on a la vue d'ensemble — une
    session vide n'a aucun contenu à perdre, et celle qui reçoit un message
    cesse d'être candidate.
    """
    if not cid:
        return
    rows = c.execute(
        "SELECT s.id FROM code_sessions s WHERE s.user_id=? AND s.client_id=? AND s.id<>? "
        "AND NOT EXISTS (SELECT 1 FROM code_messages m WHERE m.user_id=s.user_id AND m.session_id=s.id) "
        "AND NOT EXISTS (SELECT 1 FROM code_notes n WHERE n.user_id=s.user_id AND n.session_id=s.id)",
        (uid, cid, sid)).fetchall()
    for (old,) in rows:
        _delete_session_full(c, uid, old)


def _set_busy(c: sqlite3.Connection, uid: int, sid: str, busy: bool) -> None:
    c.execute("UPDATE code_sessions SET busy=? WHERE user_id=? AND id=?", (1 if busy else 0, uid, sid))


def _upsert_message(c: sqlite3.Connection, uid: int, sid: str, mid: str, info: dict) -> None:
    created = float((info.get("time") or {}).get("created") or 0) if isinstance(info.get("time"), dict) else 0.0
    c.execute("INSERT INTO code_messages(user_id,session_id,id,info,created) VALUES(?,?,?,?,?) "
              "ON CONFLICT(user_id,session_id,id) DO UPDATE SET info=excluded.info, created=excluded.created",
              (uid, sid, mid, _j(info), created))


def _upsert_part(c: sqlite3.Connection, uid: int, sid: str, mid: str, pid: str, part: dict) -> None:
    c.execute("INSERT INTO code_parts(user_id,session_id,message_id,id,part,ts) VALUES(?,?,?,?,?,?) "
              "ON CONFLICT(user_id,session_id,message_id,id) DO UPDATE SET part=excluded.part, ts=excluded.ts",
              (uid, sid, mid, pid, _j(part), _part_ts(part)))


def _delete_session(c: sqlite3.Connection, uid: int, sid: str) -> None:
    # NE touche PAS code_notes : le chemin session.snapshot fait delete+réinsertion
    # et les traces de commandes doivent survivre au re-snapshot.
    c.execute("DELETE FROM code_sessions WHERE user_id=? AND id=?", (uid, sid))
    c.execute("DELETE FROM code_messages WHERE user_id=? AND session_id=?", (uid, sid))
    c.execute("DELETE FROM code_parts WHERE user_id=? AND session_id=?", (uid, sid))


def _delete_session_full(c: sqlite3.Connection, uid: int, sid: str) -> None:
    """Suppression définitive (session.deleted, dismiss, prune) : notes + permissions + questions aussi."""
    _delete_session(c, uid, sid)
    c.execute("DELETE FROM code_notes WHERE user_id=? AND session_id=?", (uid, sid))
    c.execute("DELETE FROM code_permissions WHERE user_id=? AND session_id=?", (uid, sid))
    c.execute("DELETE FROM code_questions WHERE user_id=? AND session_id=?", (uid, sid))


def _touch_session_meta(c: sqlite3.Connection, uid: int, sid: str, info: dict) -> None:
    """Dénormalise le modèle du dernier message assistant (carte de la landing)."""
    if info.get("role") == "assistant" and info.get("providerID") and info.get("modelID"):
        c.execute("UPDATE code_sessions SET last_model=? WHERE user_id=? AND id=?",
                  (str(info["providerID"]) + "/" + str(info["modelID"]), uid, sid))


def normalize_permission(props: dict) -> dict | None:
    """Shape UNIQUE pour la page à partir des deux formes opencode :

    - v1 ``permission.updated`` : {id, type, pattern?, title, time{created}} ;
    - v2 ``permission.asked``   : {id, permission, patterns[], metadata, tool}
      (vérifiée sur le binaire 1.17.7 — pas de title ni de time).
    Retourne None si id/sessionID manquent.
    """
    if not isinstance(props, dict):
        return None
    p = dict(props)
    if not (p.get("id") and p.get("sessionID")):
        return None
    if not p.get("type") and p.get("permission"):
        p["type"] = str(p["permission"])
    if not p.get("pattern") and isinstance(p.get("patterns"), list):
        p["pattern"] = " ".join(str(x) for x in p["patterns"] if x)
    if not p.get("title"):
        md = p.get("metadata") if isinstance(p.get("metadata"), dict) else {}
        p["title"] = str(md.get("command") or md.get("description")
                         or p.get("pattern") or p.get("type") or "Demande de validation")
    return p


# Bornes de la shape question (l'outil `question` est piloté par le MODÈLE :
# on ne stocke ni ne rediffuse un payload arbitraire).
QUESTION_MAX_QUESTIONS = 20
QUESTION_MAX_OPTIONS = 30
QUESTION_MAX_TEXT = 4000


def normalize_question(props: dict) -> dict | None:
    """Shape UNIQUE pour la page à partir de ``question.asked`` (greffon v14).

    Shape opencode 1.18.16 (lue dans le binaire — ``QuestionRequest``) :
    ``{id "que_…", sessionID, questions: [{question, header, options: [{label,
    description}], multiple?, custom?}], tool?: {messageID, callID}}``.
    Chaque entrée est re-typée (str/bool), bornée, et une question sans texte
    ni option est écartée. Retourne None si id/sessionID manquent ou s'il ne
    reste aucune question exploitable.
    """
    if not isinstance(props, dict):
        return None
    qid, sid = props.get("id"), props.get("sessionID")
    if not (qid and sid):
        return None
    raw = props.get("questions")
    if not isinstance(raw, list):
        return None
    questions = []
    for q in raw[:QUESTION_MAX_QUESTIONS]:
        if not isinstance(q, dict):
            continue
        text = str(q.get("question") or "").strip()[:QUESTION_MAX_TEXT]
        options = []
        for o in (q.get("options") if isinstance(q.get("options"), list) else [])[:QUESTION_MAX_OPTIONS]:
            if isinstance(o, dict):
                label = str(o.get("label") or "").strip()[:QUESTION_MAX_TEXT]
                desc = str(o.get("description") or "").strip()[:QUESTION_MAX_TEXT]
            else:
                label, desc = str(o or "").strip()[:QUESTION_MAX_TEXT], ""
            if label:
                options.append({"label": label, "description": desc})
        if not text and not options:
            continue
        entry = {"question": text, "header": str(q.get("header") or "").strip()[:200],
                 "options": options, "multiple": bool(q.get("multiple")),
                 # opencode : « Allow typing a custom answer (default: true) »
                 "custom": q.get("custom") is not False}
        questions.append(entry)
    if not questions:
        return None
    out = {"id": str(qid), "sessionID": str(sid), "questions": questions}
    tool = props.get("tool")
    if isinstance(tool, dict) and (tool.get("messageID") or tool.get("callID")):
        out["tool"] = {"messageID": str(tool.get("messageID") or ""),
                       "callID": str(tool.get("callID") or "")}
    return out


def _touch_session_preview(c: sqlite3.Connection, uid: int, sid: str, part: dict) -> None:
    """Dénormalise l'aperçu (dernier texte non synthétique) — dernier écrit gagne."""
    if part.get("type") != "text" or part.get("synthetic"):
        return
    txt = " ".join(str(part.get("text") or "").split())
    if txt:
        c.execute("UPDATE code_sessions SET preview=? WHERE user_id=? AND id=?",
                  (txt[:160], uid, sid))


def apply_events(uid: int, events: list, cid: str = "", directory: str = "") -> int:
    """Applique un lot d'events (déjà filtrés sur les types forwardés).

    Une seule transaction par lot : le coalescing 150 ms côté plugin borne le
    débit, et un lot appliqué à moitié ne laisserait pas la page dans un état
    incohérent au milieu d'un message.
    """
    applied = 0
    now = time.time()
    with _db() as c:
        for ev in events:
            typ = (ev or {}).get("type") or ""
            props = (ev or {}).get("properties") or {}
            if typ == "client.commands":
                cmds = props.get("commands")
                if isinstance(cmds, list):
                    clean = []
                    for cm in cmds:
                        if not (isinstance(cm, dict) and cm.get("name")):
                            continue
                        entry = {"name": str(cm.get("name") or ""),
                                 "description": str(cm.get("description") or "")}
                        # champs riches (plugin v2+) — optionnels, tolère un plugin v1
                        for k in ("agent", "model"):
                            if cm.get(k):
                                entry[k] = str(cm[k])
                        if cm.get("has_args"):
                            entry["has_args"] = True
                        clean.append(entry)
                    _meta_set(c, uid, "commands", _j(clean))
            elif typ == "client.models":
                # Modèles d'inférence exposés par la CLI (plugin v3+) — alimente le
                # sélecteur /model de la page. Shape tolérée : providers[].models[]
                # (+ map `default` providerID→modelID depuis le plugin v4).
                provs = props.get("providers")
                if isinstance(provs, list):
                    clean = []
                    for pv in provs:
                        if not isinstance(pv, dict):
                            continue
                        models = pv.get("models")
                        if isinstance(models, dict):        # opencode : map id -> model
                            models = list(models.values())
                        mclean = []
                        for mm in (models or []):
                            if not (isinstance(mm, dict) and mm.get("id")):
                                continue
                            entry = {"id": str(mm.get("id") or ""),
                                     "name": str(mm.get("name") or mm.get("id") or "")}
                            # fenêtre de contexte (plugin v5+) — jauge ctx de la page
                            lim = mm.get("limit")
                            if isinstance(lim, dict) and (lim.get("context") or lim.get("output")):
                                try:
                                    entry["limit"] = {"context": int(lim.get("context") or 0),
                                                      "output": int(lim.get("output") or 0)}
                                except (TypeError, ValueError):
                                    pass
                            mclean.append(entry)
                        if pv.get("id") and mclean:
                            clean.append({"id": str(pv["id"]), "name": str(pv.get("name") or pv["id"]),
                                          "models": mclean})
                    dflt = props.get("default")
                    dflt = {str(k): str(v) for k, v in dflt.items()} if isinstance(dflt, dict) else {}
                    _meta_set(c, uid, "models", _j({"providers": clean, "default": dflt}))
            elif typ == "client.agents":
                # Agents PRIMAIRES de la CLI (plugin v12+) = les modes du TUI :
                # `build` (édite) / `plan` (lecture seule) + agents primaires
                # personnalisés. Le plugin a déjà écarté les sous-agents et les
                # agents internes ; on ne fait que valider la forme.
                ags = props.get("agents")
                if isinstance(ags, list):
                    clean = []
                    for ag in ags:
                        if not (isinstance(ag, dict) and ag.get("name")):
                            continue
                        clean.append({"name": str(ag["name"]),
                                      "description": str(ag.get("description") or "")})
                    if clean:
                        names = {a["name"] for a in clean}
                        dflt = str(props.get("default") or "")
                        if dflt not in names:
                            dflt = "build" if "build" in names else clean[0]["name"]
                        _meta_set(c, uid, "agents", _j({"agents": clean, "default": dflt}))
            elif typ == "session.snapshot":
                # État complet (info + messages) — remplace l'historique de la session.
                s = props.get("session") or {}
                sid = s.get("id")
                if isinstance(s, dict) and sid:
                    _delete_session(c, uid, sid)
                    c.execute("INSERT INTO code_sessions(user_id,id,info,client_id,updated_at) VALUES(?,?,?,?,?)",
                              (uid, sid, _j(s), cid or "", now))
                    if not (props.get("messages") or []):
                        _prune_empty_siblings(c, uid, sid, cid)
                    for m in (props.get("messages") or []):
                        info = (m or {}).get("info") or {}
                        mid = info.get("id")
                        if not mid:
                            continue
                        _upsert_message(c, uid, sid, mid, info)
                        _touch_session_meta(c, uid, sid, info)
                        for p in (m.get("parts") or []):
                            if p.get("id"):
                                _upsert_part(c, uid, sid, mid, p["id"], p)
                                _touch_session_preview(c, uid, sid, p)
            elif typ in ("session.created", "session.updated"):
                s = props.get("session") or props.get("info") or {}
                if isinstance(s, dict) and s.get("id"):
                    sid = s["id"]
                    _ensure_session(c, uid, sid, cid)
                    c.execute("UPDATE code_sessions SET info=?, updated_at=? WHERE user_id=? AND id=?",
                              (_j(s), now, uid, sid))
                    if typ == "session.created":
                        _prune_empty_siblings(c, uid, sid, cid)
            elif typ == "session.deleted":
                sid = props.get("sessionID") or (props.get("info") or {}).get("id")
                if sid:
                    _delete_session_full(c, uid, sid)
            elif typ in ("session.idle", "session.error"):
                sid = props.get("sessionID") or (props.get("info") or {}).get("id") or ""
                if sid:
                    _set_busy(c, uid, sid, False)
            elif typ == "message.updated":
                info = props.get("info") or {}
                sid, mid = info.get("sessionID"), info.get("id")
                if sid and mid:
                    # une session peut arriver via ses messages avant session.created
                    _ensure_session(c, uid, sid, cid)
                    _upsert_message(c, uid, sid, mid, info)
                    _touch_session_meta(c, uid, sid, info)
                    if info.get("role") == "assistant":
                        done = bool((info.get("time") or {}).get("completed")) if isinstance(info.get("time"), dict) else False
                        _set_busy(c, uid, sid, not done)
            elif typ == "message.part.updated":
                part = props.get("part") or {}
                sid, mid, pid = part.get("sessionID"), part.get("messageID"), part.get("id")
                if sid and mid and pid:
                    _ensure_session(c, uid, sid, cid)
                    c.execute("INSERT INTO code_messages(user_id,session_id,id,info) VALUES(?,?,?,?) "
                              "ON CONFLICT(user_id,session_id,id) DO NOTHING",
                              (uid, sid, mid, _j({"id": mid, "role": "assistant", "sessionID": sid})))
                    _upsert_part(c, uid, sid, mid, pid, part)
                    _touch_session_preview(c, uid, sid, part)
                    _set_busy(c, uid, sid, True)
            elif typ in ("permission.updated", "permission.asked"):
                # props = l'objet Permission opencode (v1 OU v2) → normalisé en un
                # seul shape pour la bannière de la page.
                p = normalize_permission(props)
                if p:
                    t = p.get("time")
                    try:
                        created = float(t.get("created") or 0) if isinstance(t, dict) else 0.0
                    except (TypeError, ValueError):
                        created = 0.0
                    if not created:
                        created = now * 1000.0   # v2 : pas de time — même horloge ms
                    c.execute("INSERT INTO code_permissions(user_id,session_id,id,info,created) "
                              "VALUES(?,?,?,?,?) ON CONFLICT(user_id,session_id,id) DO UPDATE SET "
                              "info=excluded.info, created=excluded.created",
                              (uid, p["sessionID"], p["id"], _j(p), created))
            elif typ == "permission.replied":
                # répondu (depuis la page OU depuis le TUI) → la demande disparaît.
                # v1 : permissionID ; v2 (binaire réel) : requestID.
                sid = props.get("sessionID")
                pid = props.get("permissionID") or props.get("requestID")
                if sid and pid:
                    c.execute("DELETE FROM code_permissions WHERE user_id=? AND session_id=? AND id=?",
                              (uid, sid, pid))
            elif typ == "question.asked":
                # props = QuestionRequest opencode → normalisé/borné pour la bannière.
                q = normalize_question(props)
                if q:
                    # (pas d'_ensure_session : parité permissions — le greffon
                    # snapshotte la session AVANT de pousser ses events)
                    c.execute("INSERT INTO code_questions(user_id,session_id,id,info,created) "
                              "VALUES(?,?,?,?,?) ON CONFLICT(user_id,session_id,id) DO UPDATE SET "
                              "info=excluded.info, created=excluded.created",
                              (uid, q["sessionID"], q["id"], _j(q), now * 1000.0))
            elif typ in ("question.replied", "question.rejected"):
                # répondu ou refusé (depuis la page OU depuis le TUI) → la question
                # disparaît. Shape binaire : requestID (questionID toléré).
                sid = props.get("sessionID")
                qid = props.get("requestID") or props.get("questionID")
                if sid and qid:
                    c.execute("DELETE FROM code_questions WHERE user_id=? AND session_id=? AND id=?",
                              (uid, sid, qid))
            elif typ == "message.removed":
                sid, mid = props.get("sessionID"), props.get("messageID")
                if sid and mid:
                    c.execute("DELETE FROM code_messages WHERE user_id=? AND session_id=? AND id=?", (uid, sid, mid))
                    c.execute("DELETE FROM code_parts WHERE user_id=? AND session_id=? AND message_id=?", (uid, sid, mid))
            applied += 1
        _meta_set(c, uid, "last_ingest", repr(now))
        if directory:
            _meta_set(c, uid, "dir", directory)
        c.commit()
    return applied


# ─────────────────────────────────────────────────────────────────────────────
#  Lectures (page) — shapes identiques à l'ancien store mémoire
# ─────────────────────────────────────────────────────────────────────────────
def sessions_list(uid: int) -> list:
    now = time.time()
    with _db() as c:
        rows = c.execute("SELECT id, info, busy, client_id, last_model, preview "
                         "FROM code_sessions WHERE user_id=?", (uid,)).fetchall()
        alive = {r[0] for r in c.execute(
            "SELECT client_id FROM code_clients WHERE user_id=? AND last_seen>?",
            (uid, now - CLIENT_TTL)).fetchall()}
        counts = dict(c.execute("SELECT session_id, COUNT(*) FROM code_messages "
                                "WHERE user_id=? GROUP BY session_id", (uid,)).fetchall())
    out = []
    for sid, info_s, busy, client_id, last_model, preview in rows:
        s = _load(info_s)
        s["busy"] = bool(busy)
        # session pilotable ? (son process opencode est encore vivant) — permet à
        # la page de distinguer « connecté » de l'historique « hors ligne »
        s["connected"] = bool(client_id and client_id in alive)
        s["client"] = client_id or ""              # picker /session (même CLI)
        s["last_model"] = last_model or ""
        s["preview"] = preview or ""
        s["msg_count"] = int(counts.get(sid, 0))
        out.append(s)
    out.sort(key=lambda s: ((s.get("time") or {}).get("updated") or 0), reverse=True)
    return out


def messages_list(uid: int, sid: str) -> list:
    with _db() as c:
        mrows = c.execute("SELECT id, info FROM code_messages WHERE user_id=? AND session_id=?",
                          (uid, sid)).fetchall()
        prows = c.execute("SELECT message_id, part FROM code_parts WHERE user_id=? AND session_id=?",
                          (uid, sid)).fetchall()
        nrows = c.execute("SELECT id, kind, label, detail, created FROM code_notes "
                          "WHERE user_id=? AND session_id=?", (uid, sid)).fetchall()
    by_msg: dict = {}
    for mid, part_s in prows:
        by_msg.setdefault(mid, []).append(_load(part_s))
    out = []
    for mid, info_s in mrows:
        parts = by_msg.get(mid, [])
        parts.sort(key=lambda p: (_part_ts(p), p.get("id") or ""))
        out.append({"info": _load(info_s) or {"id": mid}, "parts": parts})
    # traces de commandes (role synthétique "note") fusionnées au timeline —
    # created en ms comme les time.created opencode, le tri ci-dessous ordonne.
    for nid, kind, label, detail, created in nrows:
        out.append(_note_message(sid, nid, kind, label, detail, created))
    out.sort(key=lambda m: ((m["info"].get("time") or {}).get("created") or 0, m["info"].get("id") or ""))
    return out


def _note_message(sid: str, nid: str, kind: str, label: str, detail: str, created: float) -> dict:
    """Shape message de la fusion des notes (transcript + payload SSE code.note)."""
    return {"info": {"id": "note-" + nid, "role": "note", "sessionID": sid,
                     "time": {"created": created},
                     "note": {"kind": kind, "label": label, "detail": detail or ""}},
            "parts": []}


def add_note(uid: int, sid: str, nid: str, kind: str, label: str, detail: str = "") -> dict:
    """Trace persistante « ce qui a été fait » (slash command / action de la page)."""
    created = time.time() * 1000.0    # ms — même horloge que time.created opencode
    with _db() as c:
        c.execute("INSERT INTO code_notes(user_id,session_id,id,kind,label,detail,created) "
                  "VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,session_id,id) DO UPDATE SET "
                  "kind=excluded.kind, label=excluded.label, detail=excluded.detail, "
                  "created=excluded.created",
                  (uid, sid, nid, kind, label, detail or "", created))
        c.commit()
    return _note_message(sid, nid, kind, label, detail, created)


def permissions_list(uid: int, sid: str) -> list:
    """Demandes de validation opencode en attente pour la session (bannière)."""
    with _db() as c:
        rows = c.execute("SELECT info FROM code_permissions WHERE user_id=? AND session_id=? "
                         "ORDER BY created, id", (uid, sid)).fetchall()
    return [_load(r[0]) for r in rows]


def questions_list(uid: int, sid: str) -> list:
    """Questions de l'outil ``question`` en attente pour la session (bannière)."""
    with _db() as c:
        rows = c.execute("SELECT info FROM code_questions WHERE user_id=? AND session_id=? "
                         "ORDER BY created, id", (uid, sid)).fetchall()
    return [_load(r[0]) for r in rows]


def session_count(uid: int) -> int:
    with _db() as c:
        row = c.execute("SELECT COUNT(*) FROM code_sessions WHERE user_id=?", (uid,)).fetchone()
    return int(row[0] or 0)


def commands_list(uid: int) -> list:
    try:
        cmds = json.loads(_meta_get(uid, "commands") or "[]")
        return cmds if isinstance(cmds, list) else []
    except Exception:
        return []


def models_list(uid: int) -> dict:
    """``{providers: [...], default: {providerID: modelID}}`` (sélecteur /model)."""
    try:
        d = json.loads(_meta_get(uid, "models") or "{}")
        if isinstance(d, list):     # payload d'un plugin v3 (liste nue)
            return {"providers": d, "default": {}}
        if isinstance(d, dict):
            return {"providers": d.get("providers") or [], "default": d.get("default") or {}}
    except Exception:
        pass
    return {"providers": [], "default": {}}


def sweep_undeliverable(uid: int) -> list:
    """Purge les commandes que PLUS AUCUNE CLI ne prendra, et les rend à l'appelant.

    Sans ça, une CLI qui meurt sans dire au revoir (Ctrl-C absorbé, kill -9,
    terminal fermé) laissait la page dans le pire des états : elle acceptait le
    prompt (le client paraît vivant pendant le TTL), la commande restait en file,
    puis disparaissait en silence 90 s plus tard. Vu de l'utilisateur : « j'ai
    envoyé, il ne s'est rien passé » — le « session inaccessible » remonté.

    Une commande est déclarée non délivrable dès qu'elle a dépassé le TTL client
    (40 s) sans que son destinataire possible soit vivant : ciblée → cette CLI
    précise ; sinon → le propriétaire de la session, ou n'importe quelle CLI
    quand la session n'a pas encore de propriétaire.
    """
    now = time.time()
    out = []
    with _db() as c:
        begin_write(c)
        rows = c.execute("SELECT id, session_id, kind, target, created_at FROM code_commands "
                         "WHERE user_id=? AND created_at<?", (uid, now - CLIENT_TTL)).fetchall()
        if not rows:
            c.commit()
            return []
        alive = {r[0] for r in c.execute(
            "SELECT client_id FROM code_clients WHERE user_id=? AND last_seen>?",
            (uid, now - CLIENT_TTL)).fetchall()}
        owners = {r[0]: r[1] for r in c.execute(
            "SELECT id, client_id FROM code_sessions WHERE user_id=?", (uid,)).fetchall()}
        dead = []
        for rid, sid, kind, target, _created in rows:
            if target:
                deliverable = target in alive
            else:
                owner = owners.get(sid) or ""
                deliverable = (owner in alive) if owner else bool(alive)
            if not deliverable:
                dead.append(rid)
                out.append({"id": rid, "sid": sid or "", "kind": kind})
        for rid in dead:
            c.execute("DELETE FROM code_commands WHERE id=? AND user_id=?", (rid, uid))
        c.commit()
    return out


def agents_list(uid: int) -> dict:
    """``{agents: [{name, description}], default: name}`` (sélecteur plan/build).

    Vide tant qu'aucune CLI en plugin v12+ ne s'est annoncée — la page masque
    alors le sélecteur plutôt que d'afficher un choix qui ne serait pas appliqué.
    """
    try:
        d = json.loads(_meta_get(uid, "agents") or "{}")
        if isinstance(d, dict) and isinstance(d.get("agents"), list):
            return {"agents": d["agents"], "default": str(d.get("default") or "")}
    except Exception:
        pass
    return {"agents": [], "default": ""}


def dismiss_session(uid: int, sid: str) -> None:
    with _db() as c:
        _delete_session_full(c, uid, sid)
        c.commit()


# ─────────────────────────────────────────────────────────────────────────────
#  File de commandes (page → plugin) — claim atomique cross-worker
# ─────────────────────────────────────────────────────────────────────────────
def queue_command(uid: int, cmd: dict) -> None:
    """``cmd`` = {id, sid, kind} + payload (text | command+arguments).

    ``target`` (client_id) optionnel : la commande n'est alors prenable QUE par
    ce client — jamais reroutée vers une autre machine (ex. /new sans session).
    """
    payload = {k: v for k, v in cmd.items() if k not in ("id", "sid", "kind", "target")}
    with _db() as c:
        c.execute("DELETE FROM code_commands WHERE created_at<?", (time.time() - CMD_TTL,))
        c.execute("INSERT INTO code_commands(id,user_id,session_id,kind,payload,created_at,target) "
                  "VALUES(?,?,?,?,?,?,?)",
                  (cmd["id"], uid, cmd.get("sid") or "", cmd["kind"], _j(payload), time.time(),
                   cmd.get("target") or ""))
        c.commit()


def claim_commands(uid: int, cid: str) -> list:
    """Tire (et consomme) les commandes prenables par le client ``cid``.

    Atomique sous BEGIN IMMEDIATE : deux pulls concurrents — y compris sur des
    workers différents — ne prennent jamais deux fois la même commande.
    Règle de routage : commande ciblée (``target``) → STRICTEMENT ce client
    (si la cible est morte, CMD_TTL la purge — jamais reroutée) ; sinon prenable
    si sa session appartient à ``cid``, n'a pas de propriétaire connu, ou si
    son propriétaire est mort.
    """
    now = time.time()
    with _db() as c:
        begin_write(c)
        c.execute("DELETE FROM code_commands WHERE created_at<?", (now - CMD_TTL,))
        rows = c.execute("SELECT id, session_id, kind, payload, target FROM code_commands "
                         "WHERE user_id=? ORDER BY created_at", (uid,)).fetchall()
        if not rows:
            c.commit()
            return []
        owners = {r[0]: r[1] for r in c.execute(
            "SELECT id, client_id FROM code_sessions WHERE user_id=?", (uid,)).fetchall()}
        alive = {r[0] for r in c.execute(
            "SELECT client_id FROM code_clients WHERE user_id=? AND last_seen>?",
            (uid, now - CLIENT_TTL)).fetchall()}
        mine, taken = [], []
        for rid, sid, kind, payload_s, target in rows:
            if target:
                if target != cid:
                    continue
            else:
                owner = owners.get(sid) or ""
                if not (owner == cid or not owner or owner not in alive):
                    continue
            cmd = {"id": rid, "sid": sid, "kind": kind}
            cmd.update(_load(payload_s))
            mine.append(cmd)
            taken.append((rid,))
        if taken:
            c.executemany("DELETE FROM code_commands WHERE id=?", taken)
        c.commit()
    return mine


# ─────────────────────────────────────────────────────────────────────────────
#  Pruning (throttlé — appelé au fil de l'eau depuis l'ingest)
# ─────────────────────────────────────────────────────────────────────────────
def prune() -> None:
    global _last_prune
    now = time.time()
    if now - _last_prune < _PRUNE_EVERY:
        return
    _last_prune = now
    with _db() as c:
        c.execute("DELETE FROM code_clients WHERE last_seen<?", (now - 3 * CLIENT_TTL,))
        c.execute("DELETE FROM code_commands WHERE created_at<?", (now - CMD_TTL,))
        old = c.execute("SELECT user_id, id FROM code_sessions WHERE updated_at<?",
                        (now - SESSION_TTL,)).fetchall()
        for ouid, sid in old:
            _delete_session_full(c, ouid, sid)
        # messages/parts/notes/permissions orphelins (session supprimée par un autre chemin)
        c.execute("DELETE FROM code_messages WHERE NOT EXISTS (SELECT 1 FROM code_sessions s "
                  "WHERE s.user_id=code_messages.user_id AND s.id=code_messages.session_id)")
        c.execute("DELETE FROM code_parts WHERE NOT EXISTS (SELECT 1 FROM code_sessions s "
                  "WHERE s.user_id=code_parts.user_id AND s.id=code_parts.session_id)")
        c.execute("DELETE FROM code_notes WHERE NOT EXISTS (SELECT 1 FROM code_sessions s "
                  "WHERE s.user_id=code_notes.user_id AND s.id=code_notes.session_id)")
        c.execute("DELETE FROM code_permissions WHERE NOT EXISTS (SELECT 1 FROM code_sessions s "
                  "WHERE s.user_id=code_permissions.user_id AND s.id=code_permissions.session_id)")
        c.execute("DELETE FROM code_questions WHERE NOT EXISTS (SELECT 1 FROM code_sessions s "
                  "WHERE s.user_id=code_questions.user_id AND s.id=code_questions.session_id)")
        c.commit()
