# SPDX-License-Identifier: MIT
"""backend.db.chats — Chats CRUD + archive/search + sliding-window retention.

Tables: ``chats``.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional
import time
import json
import sqlite3

from shared_infra.db._connection import db, db_conn
from shared_infra.db._dialect import MYSQL, begin_write, ci_like, dialect_of
# Accesseur (et non la constante ``MAX_RECENT_CHATS``) : le plafond est réglable
# depuis l'administration et doit s'appliquer sans redémarrage — cf. la docstring
# de ``max_recent_chats`` dans ``shared_infra/config.py``.
from shared_infra.config import max_recent_chats


def _chat_meta(row) -> Dict[str, Any]:
    """``meta_json`` parsé (réglages par-chat) — tolère un schéma pré-0008."""
    try:
        d = json.loads(row["meta_json"] or "{}")
        return d if isinstance(d, dict) else {}
    except (KeyError, IndexError, TypeError, ValueError):
        return {}


def get_chat_todos(user_id: int, chat_id: str) -> List[Dict[str, str]]:
    """Todo-list persistée (``meta_json["todos"]``, outil ``todowrite``) SANS
    charger ``messages_json`` — lue par le harnais EN DÉBUT DE CHAQUE TOUR
    (rappel <todo_status>) : ``get_chat`` désérialiserait tout l'historique."""
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT meta_json FROM chats WHERE id=? AND user_id=?", (chat_id, user_id))
        row = cur.fetchone()
        if not row:
            return []
        todos = _chat_meta(row).get("todos")
        return todos if isinstance(todos, list) else []


def get_chat_plan_mode(user_id: int, chat_id: str) -> bool:
    """Mode lecture seule du chat, SANS charger ``messages_json``.

    Même motif que ``get_chat_todos`` : lu à chaque tour par la route de
    génération, qui n'a que faire de l'historique sérialisé à cet instant.
    Chat inconnu ou meta absente ⇒ False.
    """
    if not chat_id:
        return False
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT meta_json FROM chats WHERE id=? AND user_id=?", (chat_id, user_id))
        row = cur.fetchone()
        return bool(_chat_meta(row).get("plan_mode")) if row else False


def get_chat(user_id: int, chat_id: str) -> Optional[Dict[str, Any]]:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT * FROM chats WHERE id=? AND user_id=?", (chat_id, user_id))
        row = cur.fetchone()
        if not row: return None
        meta = _chat_meta(row)
        return {
            "id": row["id"],
            "title": row["title"],
            "updated_at": float(row["updated_at"]),
            "archived": bool(row["archived"]),
            "messages": json.loads(row["messages_json"] or "[]"),
            # Catégories d'outils mémorisées PAR CHAT (panneau Outils). ``None``
            # = jamais posées (chat d'avant la feature) → le front garde alors
            # les toggles courants au lieu de tout éteindre.
            "tools": meta.get("tools") if isinstance(meta.get("tools"), list) else None,
            # Mode lecture seule du chat (commande « /plan ») : la boucle de
            # génération ne garde alors que les outils annotés read-only.
            # Booléen simple — absent ⇒ False, il n'y a pas d'état « jamais
            # posé » à distinguer ici (contrairement à ``tools``).
            "plan_mode": bool(meta.get("plan_mode")),
            # Todo-list du chat (outil ``todowrite``) — seed du panneau front
            # au chargement ; mise à jour live via l'event ``todo_updated``.
            "todos": meta.get("todos") if isinstance(meta.get("todos"), list) else [],
            # Marques d'élagage de contexte (harnais v4, M4) : clés des
            # sorties d'outils effacées de la VUE modèle (stockage intact).
            "ctx_pruned_keys": meta.get("ctx_pruned_keys")
                if isinstance(meta.get("ctx_pruned_keys"), list) else [],
            # Occupation RÉELLE du contexte à la fin du dernier tour
            # (``{used, total, pct, model, ts}``) : re-sème la jauge du front
            # après un rechargement/redémarrage — l'utilisateur sait où il en
            # est AVANT de reprendre. None = jamais mesurée (ou effacée par une
            # compaction, qui change l'occupation).
            "ctx_usage": meta.get("ctx_usage")
                if isinstance(meta.get("ctx_usage"), dict) else None,
            # Suffixes LLM des questions (rappel ``<todo_status>`` fusionné
            # au dernier user d'un tour) : ``{signature: texte}``, rejoués à
            # l'identique par l'expansion de l'historique — préfixe KV stable
            # d'un tour à l'autre (AUDIT 2026-09-25).
            "llm_user_suffixes": meta.get("llm_user_suffixes")
                if isinstance(meta.get("llm_user_suffixes"), dict) else {},
        }


def list_chats(user_id: int, archived: int) -> List[Dict[str, Any]]:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT id,title,updated_at,archived FROM chats WHERE user_id=? AND archived=? ORDER BY updated_at DESC",
            (user_id, archived),
        )
        rows = cur.fetchall()
        out = [{"id": r["id"], "title": r["title"], "updated_at": float(r["updated_at"]), "archived": bool(r["archived"])} for r in rows]
        if archived == 0: out = out[:max_recent_chats()]
        return out


def upsert_chat(user_id: int, chat_id: str, title: str, messages: List[Dict[str, str]],
                updated_at: float, expected_updated_at: "Optional[float]" = None) -> bool:
    """Insert or update a chat owned by ``user_id``. Retourne ``True`` si le
    tour a été persisté, ``False`` sur CONFLIT de concurrence optimiste.

    BUG FIX (élevé) — collision silencieuse : la requête SQL utilise
    ``ON CONFLICT(id) DO UPDATE ... WHERE chats.user_id = excluded.user_id``,
    qui filtre l'UPDATE à l'utilisateur propriétaire. Si un chat avec le même
    ``chat_id`` existait déjà pour un AUTRE user (théoriquement rare avec
    des IDs hex 12 bytes mais possible via payload manipulé), l'INSERT
    échouait sur la PRIMARY KEY et l'UPDATE était filtré → la requête
    retournait 200 OK sans rien sauver, l'utilisateur croyait avoir
    persisté sa conversation. On lève maintenant ``ValueError`` que les
    routes traduisent en HTTP 409 (cf. callers dans ``routes/saved_chats.py``
    et ``routes/chats.py``).

    Note : pour les CRÉATIONS pures (chat_id n'existe nulle part), le
    INSERT réussit normalement et rowcount == 1.

    F2 — ``expected_updated_at`` (concurrence optimiste CROSS-WORKER) : si
    fourni, l'UPDATE n'écrit QUE si ``chats.updated_at`` vaut encore cette
    valeur (le chat n'a pas bougé depuis la lecture). En multi-worker les
    gardes in-process (_manual_compressions/_active_chat_tasks) ne se voient
    pas ; sans cela, une compression manuelle et une génération concurrentes
    sur le MÊME chat s'écrasaient à l'aveugle (dernier écrivain gagne →
    tour utilisateur perdu / résumé écrasé). ``None`` = comportement
    historique inchangé (écriture inconditionnelle). Retourne ``False`` si
    le chat a changé entre-temps (l'appelant surface « non persisté » plutôt
    que de clobberer)."""
    # Le « thinking » (raisonnement) n'est utile qu'à l'affichage LIVE du tour
    # en cours : on ne le RETIENT PAS en base. Inutile au rechargement (bruit)
    # et déjà strippé du prompt des tours suivants. Seul écrit-chemin des
    # messages → on nettoie ici une fois pour toutes (stream, save-messages, édit).
    # EXCEPTION ciblée : ``resume_thinking`` (posé UNIQUEMENT sur un tour coupé
    # en plein raisonnement, purgé à la reprise aboutie) passe — c'est lui qui
    # rend « Continuer » utile après rechargement. Volontairement un autre nom
    # de champ : le choix « thinking non persisté » reste la règle.
    # AUDIT 2026-08-23 — le nettoyage porte AUSSI sur ``metrics["thinking"]``.
    # Le raisonnement y est recopié par ``calculate_metrics`` et par la boucle
    # d'outils ; ne strippper que le champ de premier niveau laissait passer
    # jusqu'à 400 000 caractères par message, y compris par ``PUT
    # /save-messages`` (le front y renvoie ``m.metrics`` tel qu'il l'a reçu).
    _clean = []
    for _m in messages:
        if isinstance(_m, dict) and "thinking" in _m:
            _m = {k: v for k, v in _m.items() if k != "thinking"}
        _mt = _m.get("metrics") if isinstance(_m, dict) else None
        if isinstance(_mt, dict) and "thinking" in _mt:
            _m = dict(_m)
            _m["metrics"] = {k: v for k, v in _mt.items() if k != "thinking"}
        _clean.append(_m)
    messages = _clean
    with db_conn() as conn:
        cur = conn.cursor()
        mj = json.dumps(messages, ensure_ascii=False)
        if dialect_of(conn) == MYSQL:
            _upsert_chat_mysql(cur, chat_id, user_id, title, mj, updated_at,
                               expected_updated_at)
        elif expected_updated_at is None:
            cur.execute("""
                INSERT INTO chats(id, user_id, title, messages_json, updated_at, archived)
                VALUES (?, ?, ?, ?, ?, 0)
                ON CONFLICT(id) DO UPDATE SET
                    title        = excluded.title,
                    messages_json= excluded.messages_json,
                    updated_at   = excluded.updated_at
                WHERE chats.user_id = excluded.user_id
            """, (chat_id, user_id, title, mj, updated_at))
        else:
            # Garde optimiste : l'UPDATE ne s'applique que si updated_at est
            # RESTÉ à la valeur lue (le tour concurrent l'aurait bougé).
            cur.execute("""
                INSERT INTO chats(id, user_id, title, messages_json, updated_at, archived)
                VALUES (?, ?, ?, ?, ?, 0)
                ON CONFLICT(id) DO UPDATE SET
                    title        = excluded.title,
                    messages_json= excluded.messages_json,
                    updated_at   = excluded.updated_at
                WHERE chats.user_id = excluded.user_id
                  AND chats.updated_at = ?
            """, (chat_id, user_id, title, mj, updated_at, expected_updated_at))
        # rowcount == 0 : soit l'INSERT a conflicté ET le WHERE de l'UPDATE n'a
        # pas matché. On commit AVANT toute suite pour libérer le lock SQLite.
        affected = cur.rowcount
        conn.commit()
        if affected != 0:
            return True
        # Désambiguïser : le chat existe-t-il pour CE user ?
        cur.execute("SELECT 1 FROM chats WHERE id=? AND user_id=?", (chat_id, user_id))
        if cur.fetchone() is not None:
            # Existe pour ce user mais l'UPDATE n'a pas matché → soit garde
            # optimiste (updated_at a bougé), soit rien à changer. Avec une
            # garde optimiste posée, c'est un CONFLIT → False (ne pas clobberer).
            if expected_updated_at is not None:
                return False
            # Sans garde optimiste, un no-op improbable (mêmes valeurs) reste OK.
            return True
        # N'existe pas pour ce user → un AUTRE user possède ce chat_id.
        raise ValueError(
            f"chat_id collision: chat {chat_id!r} exists for a different user"
        )


def _upsert_chat_mysql(cur, chat_id: str, user_id: int, title: str, mj: str,
                       updated_at: float, expected_updated_at: "Optional[float]") -> None:
    """Branche MySQL/MariaDB de :func:`upsert_chat` : ``ON DUPLICATE KEY
    UPDATE`` n'a pas de ``WHERE``, or la clause porte ici la PROPRIÉTÉ du chat
    et la concurrence optimiste. Même contrat : ``cur.rowcount`` vaut 1 si le
    tour est écrit, 0 sinon (l'appelant désambiguïse ensuite).

    UPDATE conditionnel d'abord ; si rien ne correspond, INSERT. Deux
    créations simultanées du même chat par le même compte : la seconde bute
    sur la clé primaire et retente l'UPDATE, comme l'upsert SQLite l'aurait
    fait. (``rowcount`` = lignes TROUVÉES, grâce à ``CLIENT.FOUND_ROWS``.)
    """
    if expected_updated_at is None:
        upd = ("UPDATE chats SET title=?, messages_json=?, updated_at=? "
               "WHERE id=? AND user_id=?", (title, mj, updated_at, chat_id, user_id))
    else:
        upd = ("UPDATE chats SET title=?, messages_json=?, updated_at=? "
               "WHERE id=? AND user_id=? AND updated_at=?",
               (title, mj, updated_at, chat_id, user_id, expected_updated_at))
    cur.execute(*upd)
    if cur.rowcount:
        return
    try:
        cur.execute("INSERT INTO chats(id, user_id, title, messages_json, updated_at, archived) "
                    "VALUES (?, ?, ?, ?, ?, 0)", (chat_id, user_id, title, mj, updated_at))
    except sqlite3.IntegrityError:
        cur.execute(*upd)                 # créé entre-temps : rowcount dit la suite


def _merge_meta_json(user_id: int, chat_id: str, mutate) -> bool:
    """Lecture-modification-écriture ATOMIQUE de ``chats.meta_json``.

    ``mutate(meta: dict) -> None`` modifie le dict en place ; le résultat est
    réécrit sous la MÊME transaction que la lecture.

    AUDIT 2026-08-01 (E7) — les trois écrivains de ce champ (``set_chat_tools``,
    ``add_chat_pruned_keys``, ``set_chat_todos``) faisaient chacun un ``SELECT``
    HORS transaction (sqlite3 n'en ouvre une implicitement que sur les DML) puis
    un ``UPDATE`` du dict ENTIER. Deux écrivains concurrents — l'agent qui
    appelle ``todowrite`` pendant que le panneau Outils PUT ses catégories, sur
    des workers différents — partaient donc du même état lu : le second écrasait
    le premier, effaçant la todo-list ou rétablissant d'anciennes catégories,
    sans erreur ni log.

    ``BEGIN IMMEDIATE`` prend le verrou d'écriture DÈS la lecture : le second
    writer attend (``busy_timeout``) puis relit l'état à jour. Même patron que
    ``db/scenarios.py:claim_minute_fire``.
    """
    conn = db()
    try:
        conn.isolation_level = None          # gestion manuelle des transactions
        cur = conn.cursor()
        begin_write(conn)
        try:
            cur.execute("SELECT meta_json FROM chats WHERE id=? AND user_id=?",
                        (chat_id, user_id))
            row = cur.fetchone()
            if not row:
                cur.execute("COMMIT")
                return False
            try:
                meta = json.loads(row["meta_json"] or "{}")
                if not isinstance(meta, dict):
                    meta = {}
            except (KeyError, TypeError, ValueError):
                meta = {}
            mutate(meta)
            cur.execute("UPDATE chats SET meta_json=? WHERE id=? AND user_id=?",
                        (json.dumps(meta, ensure_ascii=False), chat_id, user_id))
            changed = cur.rowcount > 0
            cur.execute("COMMIT")
            return changed
        except Exception:
            try:
                cur.execute("ROLLBACK")
            except Exception:
                pass
            raise
    finally:
        conn.close()


def set_chat_tools(user_id: int, chat_id: str, tools: List[str]) -> bool:
    """Mémorise les catégories d'outils actives PAR CHAT (merge dans meta_json).

    ``tools`` = liste des noms de catégories cochées ([] = tout décoché — état
    valide, distinct de « jamais posé »). Retourne False si le chat n'existe
    pas (encore) pour cet utilisateur — l'appelant retente au tour suivant.

    (2026-09-12) La liste porte aussi les outils DÉCOCHÉS un par un, préfixés
    d'un tiret (``-edit_file``) : on enregistre les exclusions, pas les
    inclusions, si bien que « tout coché » reste une liste vide et qu'aucun
    chat existant ne change de comportement. Le plafond passe donc de 64 à 192
    entrées : 8 catégories + jusqu'à 53 exclusions + les serveurs ``ext:`` et
    ``mf:`` dépassaient l'ancien, qui tronquait EN SILENCE.
    """
    clean = [str(t)[:64] for t in (tools or []) if isinstance(t, str) and t.strip()][:192]

    def _mutate(meta: dict) -> None:
        meta["tools"] = clean

    # PAS de bump d'updated_at : un toggle n'est pas un « tour » (il ne doit
    # ni remonter le chat dans la sidebar ni invalider la garde optimiste F2).
    return _merge_meta_json(user_id, chat_id, _mutate)


def set_chat_plan_mode(user_id: int, chat_id: str, plan_mode: bool) -> bool:
    """Mémorise le mode LECTURE SEULE du chat (merge dans meta_json).

    Même canal que ``set_chat_tools`` : réglage par-chat, écrit sous la
    transaction de ``_merge_meta_json`` (donc sans écraser ``tools`` ni
    ``todos``), et SANS bump d'``updated_at`` — basculer un mode n'est pas
    un tour de conversation.

    C'est cette valeur, relue côté route de génération, qui fait autorité :
    le front n'en est qu'un miroir d'affichage.
    """
    val = bool(plan_mode)

    def _mutate(meta: dict) -> None:
        meta["plan_mode"] = val

    return _merge_meta_json(user_id, chat_id, _mutate)


def add_chat_pruned_keys(user_id: int, chat_id: str,
                         keys: List[str], cap: int = 500) -> bool:
    """Fusionne des clés d'élagage de contexte dans
    ``meta_json["ctx_pruned_keys"]`` (harnais v4, M4).

    Idempotent (clés dédupliquées, ordre d'arrivée conservé) ; liste
    plafonnée FIFO à ``cap`` — les sorties les plus anciennes finissent de
    toute façon couvertes par un résumé de compaction. Même canal que
    ``set_chat_todos`` (merge meta_json, jamais les messages)."""
    if not keys:
        return True

    def _mutate(meta: dict) -> None:
        cur_keys = meta.get("ctx_pruned_keys")
        merged = list(cur_keys) if isinstance(cur_keys, list) else []
        seen = set(merged)
        for k in keys:
            if isinstance(k, str) and k and k not in seen:
                merged.append(k)
                seen.add(k)
        if len(merged) > cap:
            merged = merged[-cap:]
        meta["ctx_pruned_keys"] = merged

    # Le merge est fait SOUS la transaction (cf. _merge_meta_json) : deux
    # écrivains concurrents ne peuvent plus perdre les clés de l'autre.
    # False = chat inexistant pour ce user (sémantique inchangée).
    return _merge_meta_json(user_id, chat_id, _mutate)


def delete_chats_by_ids(user_id: int, chat_ids: List[str]) -> int:
    """Supprime plusieurs chats en UNE transaction.

    AUDIT 2026-09-01 (passe 6, B6) — la suppression groupée bouclait sur
    ``delete_chat`` : une connexion + une transaction + un commit (fsync WAL)
    PAR chat. Ici un seul commit ; ``IN`` par tranches de 500 (limite SQLite
    de variables). Retourne le nombre de lignes supprimées."""
    ids = [str(c) for c in (chat_ids or []) if str(c)]
    if not ids:
        return 0
    with db_conn() as conn:
        cur = conn.cursor()
        total = 0
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            ph = ",".join("?" * len(chunk))
            cur.execute(
                f"DELETE FROM chats WHERE user_id=? AND id IN ({ph})",  # noqa: S608
                (user_id, *chunk))
            total += cur.rowcount
        conn.commit()
        return total


def delete_all_chats(user_id: int, archived: int = 0) -> int:
    """Supprime TOUS les chats (par défaut : non archivés) d'un utilisateur en
    une transaction — même motif que ``delete_chats_by_ids`` (passe 6, B6)."""
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM chats WHERE user_id=? AND archived=?",
                    (user_id, int(archived)))
        n = cur.rowcount
        conn.commit()
        return n


def clean_ctx_usage(raw) -> Optional[Dict[str, Any]]:
    """Snapshot d'occupation de contexte NETTOYÉ pour ``meta_json["ctx_usage"]``
    — ``{used, total, pct, model, ts}`` ou None si la mesure est inexploitable
    (pas de total, pas d'occupation, types cassés). ``used`` est borné au
    total, ``pct`` recalculé s'il manque, ``ts`` posé s'il manque."""
    if not isinstance(raw, dict):
        return None
    try:
        used = int(raw.get("used") or 0)
        total = int(raw.get("total") or 0)
    except (TypeError, ValueError):
        return None
    if used <= 0 or total <= 0:
        return None
    used = min(used, total)
    try:
        pct = int(raw.get("pct")) if raw.get("pct") is not None else None
    except (TypeError, ValueError):
        pct = None
    if pct is None or not (0 <= pct <= 100):
        pct = min(100, round(used / total * 100))
    try:
        ts = float(raw.get("ts") or 0) or time.time()
    except (TypeError, ValueError):
        ts = time.time()
    model = raw.get("model")
    return {
        "used": used, "total": total, "pct": pct,
        "model": (str(model)[:120] if isinstance(model, str) and model else ""),
        "ts": ts,
    }


def clear_chat_ctx_usage(user_id: int, chat_id: str) -> bool:
    """Efface l'occupation persistée (compaction manuelle : l'historique vient
    de changer, l'ancienne mesure décrit une conversation qui n'existe plus —
    la jauge repart masquée jusqu'à la prochaine mesure réelle).
    False = chat inexistant pour ce user."""
    def _mutate(meta: dict) -> None:
        meta.pop("ctx_usage", None)

    return _merge_meta_json(user_id, chat_id, _mutate)


def finalize_turn_meta(user_id: int, chat_id: str,
                       pruned_keys: Optional[List[str]] = None,
                       tools: Optional[List[str]] = None,
                       plan_mode_off: bool = False,
                       cap: int = 500,
                       ctx_usage: Optional[Dict[str, Any]] = None,
                       user_suffixes: Optional[Dict[str, Optional[str]]] = None,
                       suffix_drop_from_rank: Optional[int] = None) -> bool:
    """Écritures meta_json de FIN DE TOUR, en UNE transaction.

    ``user_suffixes`` (AUDIT 2026-09-25) : ``{signature de question: texte}``
    ajoutés aux suffixes LLM persistés (``llm_user_suffixes``, 40 derniers).

    ``ctx_usage`` (2026-09-07) : occupation réelle de fin de tour
    (cf. ``clean_ctx_usage``) — None = intact ; shape invalide = ignorée.

    AUDIT 2026-09-01 (passe 6, B1) — la fin de tour enchaînait jusqu'à trois
    ``_merge_meta_json`` distincts (``add_chat_pruned_keys``, ``set_chat_tools``,
    ``set_chat_plan_mode``) : trois ``BEGIN IMMEDIATE`` successifs sur la MÊME
    ligne, chacun relisant/réécrivant la même colonne, avant l'event ``final``.
    Ici les trois mutations partagent la transaction ; chaque volet est
    optionnel (``None``/False = intact). Sémantique de chaque volet identique
    aux helpers unitaires (qui restent la voie pour les mises à jour isolées).
    False = chat inexistant pour ce user."""
    clean_tools = None
    if tools is not None:
        clean_tools = [str(t)[:64] for t in (tools or [])
                       if isinstance(t, str) and t.strip()][:64]
    clean_ctx = clean_ctx_usage(ctx_usage) if ctx_usage is not None else None

    def _mutate(meta: dict) -> None:
        if pruned_keys:
            cur_keys = meta.get("ctx_pruned_keys")
            merged = list(cur_keys) if isinstance(cur_keys, list) else []
            seen = set(merged)
            for k in pruned_keys:
                if isinstance(k, str) and k and k not in seen:
                    merged.append(k)
                    seen.add(k)
            if len(merged) > cap:
                merged = merged[-cap:]
            meta["ctx_pruned_keys"] = merged
        if clean_tools is not None:
            meta["tools"] = clean_tools
        if plan_mode_off:
            meta["plan_mode"] = False
        if clean_ctx is not None:
            meta["ctx_usage"] = clean_ctx
        if user_suffixes or suffix_drop_from_rank is not None:
            cur = meta.get("llm_user_suffixes")
            merged_s = dict(cur) if isinstance(cur, dict) else {}
            # AUDIT 2026-09-26 — historique RÉÉCRIT à partir de ce rang
            # (retry, édition, troncature) : les suffixes des questions de
            # rang ≥ n appartiennent à l'ancienne branche. Gardés, un texte
            # identique revenu au même rang rejouait un ``<todo_status>``
            # que le modèle n'avait jamais vu dans cette branche.
            if suffix_drop_from_rank is not None:
                for _k in list(merged_s):
                    try:
                        _rk = int(str(_k).split(":", 1)[0])
                    except ValueError:
                        continue
                    if _rk >= int(suffix_drop_from_rank):
                        merged_s.pop(_k, None)
            for k, v in (user_suffixes or {}).items():
                if not (isinstance(k, str) and k):
                    continue
                merged_s.pop(k, None)
                # ``None`` : ce tour n'a PAS de suffixe — l'entrée est retirée.
                if isinstance(v, str) and v:
                    merged_s[k[:64]] = v[:8000]
            meta["llm_user_suffixes"] = dict(list(merged_s.items())[-40:])

    return _merge_meta_json(user_id, chat_id, _mutate)


def set_chat_todos(user_id: int, chat_id: str, todos: List[Dict[str, str]]) -> bool:
    """Persiste la todo-list du chat (outil ``todowrite``, sémantique
    replace-all) dans ``meta_json["todos"]`` — même canal que ``set_chat_tools``,
    pas de bump d'updated_at (une mise à jour de liste n'est pas un tour).
    Liste vide = état valide (tout effacé). False si le chat n'existe pas."""
    clean: List[Dict[str, str]] = []
    for t in (todos or [])[:50]:
        if not isinstance(t, dict) or not str(t.get("content") or "").strip():
            continue
        clean.append({
            "content": str(t["content"])[:300],
            "status": str(t.get("status") or "pending")[:16],
            "priority": str(t.get("priority") or "medium")[:8],
        })
    def _mutate(meta: dict) -> None:
        meta["todos"] = clean

    return _merge_meta_json(user_id, chat_id, _mutate)


def enforce_recent_chats_cap(user_id: int) -> None:
    """SUPPRIME les conversations actives au-delà du plafond (les plus anciennes).

    Anciennement ``enforce_sliding_20`` : le nom gravait un 20 que le réglage
    ``app.max_recent_chats`` contredisait depuis longtemps.
    """
    cap = max_recent_chats()
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id FROM chats WHERE user_id=? AND archived=0 ORDER BY updated_at DESC", (user_id,))
        ids = [r["id"] for r in cur.fetchall()]
        if len(ids) > cap:
            to_delete = ids[cap:]
            cur.execute(f"DELETE FROM chats WHERE user_id=? AND archived=0 AND id IN ({','.join(['?']*len(to_delete))})", (user_id, *to_delete))
        conn.commit()


def rename_chat(user_id: int, chat_id: str, title: str) -> bool:
    title = (title or "").strip()[:60]
    if not title: return False
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("UPDATE chats SET title=?, updated_at=? WHERE id=? AND user_id=?", (title, time.time(), chat_id, user_id))
        changed = cur.rowcount > 0
        conn.commit()
        return changed


def set_title_if_default(user_id: int, chat_id: str, title: str) -> bool:
    """Pose le titre d'un chat encore « Nouveau chat » (ou sans titre), dès le
    DÉBUT d'un tour (chantier C, 2026-09-16) : un run en fond est visible dans
    la barre latérale de tous les onglets, et y lisait « Nouveau chat » jusqu'à
    sa fin. N'écrase jamais un titre choisi entre-temps, et ne bumpe PAS
    ``updated_at`` : ce n'est pas un tour, et la garde optimiste de fin de tour
    doit rester valide."""
    title = (title or "").strip()[:60]
    if not title or title == "Nouveau chat":
        return False
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("UPDATE chats SET title=? WHERE id=? AND user_id=? "
                    "AND (title='' OR title='Nouveau chat')", (title, chat_id, user_id))
        changed = cur.rowcount > 0
        conn.commit()
        return changed


def delete_chat(user_id: int, chat_id: str) -> bool:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM chats WHERE id=? AND user_id=?", (chat_id, user_id))
        changed = cur.rowcount > 0
        conn.commit()
        return changed


def archive_chat(user_id: int, chat_id: str) -> bool:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("UPDATE chats SET archived=1, archived_at=? WHERE id=? AND user_id=?", (time.time(), chat_id, user_id))
        changed = cur.rowcount > 0
        conn.commit()
        return changed


def unarchive_chat(user_id: int, chat_id: str) -> bool:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("UPDATE chats SET archived=0 WHERE id=? AND user_id=?", (chat_id, user_id))
        changed = cur.rowcount > 0
        conn.commit()
        return changed


def search_chats(user_id: int, query: str, archived: int = 0,
                 deep: bool = False) -> List[Dict[str, Any]]:
    """Recherche dans la liste des chats de l'utilisateur.

    Par défaut (``deep=False``) la recherche ne porte que sur le **titre**
    du chat. C'est ce que la plupart des users attendent et ça exploite
    l'index ``idx_chats_user_archived (user_id, archived, updated_at)``
    pour être quasi instantané même avec des centaines de chats.

    Si ``deep=True``, on ajoute une passe ``LIKE`` sur ``messages_json``.
    Attention : ``messages_json`` n'est PAS indexable pour les sous-chaînes
    → full-table scan proportionnel au nombre de chats × taille moyenne
    du JSON. Sur un user avec 100 chats de 50 messages, un deep search
    peut prendre plusieurs secondes et geler l'UI.

    Mots-clés courts (<3 caractères) dans un deep search produisent
    énormément de faux positifs sur le JSON (les champs ``role``, ``id``,
    les guillemets eux-mêmes matchent). On garde un plancher à 2 chars
    sur le titre mais on exige >=3 chars pour un deep scan.
    """
    q = (query or "").strip()
    if not q:
        return []
    # Le plafond de résultats suit celui de la liste (jadis 50 en dur). Sinon un
    # chat VISIBLE dans la barre latérale peut rester introuvable à la recherche
    # dès que le plafond dépasse 50 — la recherche doit couvrir au moins ce que
    # la liste montre.
    cap = max(50, max_recent_chats())
    with db_conn() as conn:
        cur = conn.cursor()
        like_q = f"%{q}%"
        if deep and len(q) >= 3:
            cur.execute(
                "SELECT id, title, updated_at, archived FROM chats "
                f"WHERE user_id=? AND archived=? AND ({ci_like('title')} OR {ci_like('messages_json')}) "
                "ORDER BY updated_at DESC LIMIT ?",
                (user_id, archived, like_q, like_q, cap),
            )
        else:
            # Recherche title-only (rapide, indexée).
            cur.execute(
                "SELECT id, title, updated_at, archived FROM chats "
                f"WHERE user_id=? AND archived=? AND {ci_like('title')} "
                "ORDER BY updated_at DESC LIMIT ?",
                (user_id, archived, like_q, cap),
            )
        rows = cur.fetchall()
        return [{"id": r["id"], "title": r["title"],
                 "updated_at": float(r["updated_at"]),
                 "archived": bool(r["archived"])} for r in rows]
