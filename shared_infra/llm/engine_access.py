# SPDX-License-Identifier: MIT
"""
shared_infra.llm.engine_access — Visibilité des serveurs d'inférence et droit
de gérer les modèles, par utilisateur et par groupe (lot B4, 2026-09-16).

Stockage : table ``llm_engine_policies`` (migration 0018), une ligne par
principal (``'user'`` ou ``'group'``). Cf. le plan
``docs/evolutions-upload-moteurs-reprise-design-2026-09-16.md`` § 2.5.

Clés de moteur
==============
- ``"builtin"``      : le serveur intégré (``config.json`` ``llama.*``) ;
- ``"conn:<id>"``    : un connecteur (partagé ou personnel) ;
- ``"*"``            : dans une LISTE uniquement — « tous les serveurs », y
  compris ceux créés plus tard. Sert à rendre l'accès complet à un compte dont
  un groupe est restreint.

Résolution (décisions utilisateur D2, D5, D7)
=============================================
Serveurs :
  1. administrateur (``is_admin == 1``) → tous ;
  2. liste PROPRE à l'utilisateur si elle existe → uniquement ces serveurs ;
  3. sinon UNION des listes des groupes qui en ont une ;
  4. sinon → tous (défaut : accès à tout).
  Une liste vide ``[]`` = aucun serveur. Un ``"*"`` dans la liste retenue = tous.

Droit de gérer les modèles (charger / décharger) :
  1. administrateur → oui ;
  2. valeur propre à l'utilisateur si réglée ;
  3. sinon oui si AU MOINS UN groupe qui la règle l'autorise, non si tous
     ceux qui la règlent l'interdisent ;
  4. sinon → oui (défaut).

Les connecteurs PERSONNELS (``scope='user'``) ne sont jamais filtrés pour leur
propriétaire, et restent inaccessibles aux autres comptes (y compris aux
admins : même règle que ``connectors.get_secret_for_user``).

Suppression d'un connecteur partagé : sa clé est retirée de toutes les listes
(``purge_engine_key``). Une liste qui se retrouve VIDE reste vide et signifie
« aucun serveur » — la transformer en « aucune restriction » ouvrirait tout à
un compte que l'admin avait volontairement restreint.

Erreurs de lecture — choix EXPLICITE : fail-open
================================================
Une erreur de lecture de la table (base verrouillée, migration pas encore
passée) est journalisée (limitée à une ligne par minute) et traitée comme
« aucune restriction » + « gestion autorisée ». C'est le comportement de
l'application avant ce lot, et la même politique que ``chat_locks`` : un défaut
d'infrastructure ne doit pas couper le chat de tous les comptes. Le contrôle
reste une politique d'usage entre collègues, pas une frontière de sécurité
contre un attaquant.

Cache
=====
Contexte par utilisateur (rôle, politique propre, politiques de ses groupes)
gardé ``_TTL_S`` secondes par process. Toute écriture (``set_policy``,
``clear_policy``, ``purge_engine_key``, changement de groupes d'un compte) vide
le cache de CE process ET touche une EMPREINTE partagée dans le répertoire
d'exécution : les autres workers la voient à leur prochaine lecture (un
``stat``) et rechargent aussitôt. Avant, un retrait d'accès pouvait mettre
jusqu'à ``_TTL_S`` secondes à s'appliquer ailleurs — et le TTL seul ne disait
jamais si quelque chose avait changé. Empreinte illisible ⇒ on retombe sur le
TTL (fail-open).

API (utilisée par les routes de chat / LLM — ne pas renommer)
=============================================================
``BUILTIN_KEY``, ``ALL_KEY``, ``connector_key(cid)``, ``parse_key(key)``,
``get_policy``, ``set_policy``, ``clear_policy``, ``list_policies``,
``normalize_engine_keys``, ``resolve_access`` (pure),
``effective_engine_keys(user_id, *, is_admin=None)``,
``can_use_engine(user_id, key, *, is_admin=None)``,
``can_manage_models(user_id, *, is_admin=None)``,
``filter_shared_connectors(user_id, rows, *, is_admin=None)``,
``purge_engine_key(key)``, ``delete_principal_rows(conn, type, id)``,
``bump_stamp()`` (changement d'appartenance aux groupes),
``list_engine_options()``, ``describe_users(rows)``, ``invalidate_cache()``.
"""
from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import threading
import time
from typing import Any, Dict, Iterable, List, Optional, Tuple

from shared_infra.db._connection import db_conn

logger = logging.getLogger("uvicorn.error")

BUILTIN_KEY = "builtin"
ALL_KEY = "*"
PRINCIPAL_TYPES = ("user", "group")

_CONN_RE = re.compile(r"^conn:(\d+)$")
_TTL_S = 3.0
_MAX_KEYS = 200

_cache: Dict[int, Tuple[float, int, Dict[str, Any]]] = {}
_cache_lock = threading.Lock()
_last_warn = [0.0]


def _stamp_path():
    from shared_infra.runtime.runtime_dir import runtime_path
    d = runtime_path("engine_access", "ELPIS_ENGINE_ACCESS_DIR", "/tmp/elpis_engine_access")
    d.mkdir(parents=True, exist_ok=True)
    return d / "policies.stamp"


def _current_stamp() -> int:
    """Version des politiques, VISIBLE DE TOUS LES WORKERS (mtime du témoin).
    0 = indisponible : le cache retombe alors sur le seul TTL."""
    try:
        return _stamp_path().stat().st_mtime_ns
    except FileNotFoundError:
        return 0
    except Exception:                                            # noqa: BLE001
        return 0


def bump_stamp() -> None:
    """Signale un changement de politique ou d'appartenance aux groupes."""
    try:
        p = _stamp_path()
        p.touch()
        os.utime(p, None)
    except Exception:                                            # noqa: BLE001
        logger.debug("[engine_access] empreinte de politiques non touchée", exc_info=True)


# ── Clés ──────────────────────────────────────────────────────────────────────
def connector_key(cid) -> str:
    return f"conn:{int(cid)}"


def parse_key(key) -> Optional[Tuple[str, Optional[int]]]:
    """``('builtin', None)`` | ``('conn', id)`` | ``None`` (clé invalide).

    ``"*"`` n'est PAS une clé de moteur : il n'a de sens que dans une liste."""
    if not isinstance(key, str):
        return None
    k = key.strip()
    if k == BUILTIN_KEY:
        return ("builtin", None)
    m = _CONN_RE.match(k)
    if m:
        cid = int(m.group(1))
        if cid > 0:
            return ("conn", cid)
    return None


def _warn(msg: str, *args) -> None:
    now = time.monotonic()
    if now - _last_warn[0] >= 60.0:
        _last_warn[0] = now
        logger.warning(msg, *args)


def invalidate_cache(user_id: Optional[int] = None) -> None:
    bump_stamp()
    with _cache_lock:
        if user_id is None:
            _cache.clear()
        else:
            _cache.pop(int(user_id), None)


# ── Stockage ─────────────────────────────────────────────────────────────────
def _decode_row(engine_keys_raw, manage_raw) -> Dict[str, Any]:
    keys = None
    if engine_keys_raw is not None:
        try:
            parsed = json.loads(engine_keys_raw)
            keys = [k for k in parsed if isinstance(k, str)] if isinstance(parsed, list) else []
        except (ValueError, TypeError):
            # Valeur illisible : on la lit comme « aucun serveur » plutôt que
            # « tout » — une ligne corrompue ne doit pas ouvrir l'accès.
            keys = []
    manage = None if manage_raw is None else bool(manage_raw)
    return {"engine_keys": keys, "can_manage_models": manage}


def _check_principal_type(principal_type: str) -> str:
    if principal_type not in PRINCIPAL_TYPES:
        raise ValueError(f"principal_type invalide : {principal_type!r}")
    return principal_type


def normalize_engine_keys(keys, *, check_exists: bool = True) -> Optional[List[str]]:
    """Valide et dédoublonne une liste de clés (ordre conservé).

    ``None`` → ``None`` (pas de restriction). Lève ``ValueError`` (message
    lisible, destiné à un 400) si le type est faux, si une clé est mal formée
    ou — avec ``check_exists`` — si ``conn:<id>`` ne désigne pas un connecteur
    PARTAGÉ existant (un connecteur personnel n'a pas à figurer dans une liste
    d'administration)."""
    if keys is None:
        return None
    if not isinstance(keys, list):
        raise ValueError("engine_keys doit être null ou une liste")
    if len(keys) > _MAX_KEYS:
        raise ValueError("engine_keys : trop de clés")
    out: List[str] = []
    bad: List[str] = []
    conn_ids: List[int] = []
    for k in keys:
        if not isinstance(k, str):
            bad.append(repr(k))
            continue
        k = k.strip()
        if k == ALL_KEY:
            if k not in out:
                out.append(k)
            continue
        p = parse_key(k)
        if p is None:
            bad.append(k)
            continue
        if p[0] == "conn":
            conn_ids.append(p[1])
        if k not in out:
            out.append(k)
    if bad:
        raise ValueError("Clés de serveur invalides : " + ", ".join(bad))
    if check_exists and conn_ids:
        with db_conn() as conn:
            marks = ",".join("?" * len(conn_ids))
            rows = conn.execute(
                f"SELECT id FROM llm_connectors WHERE scope='shared' AND id IN ({marks})",
                tuple(conn_ids)).fetchall()
        known = {int(r[0]) for r in rows}
        missing = [connector_key(c) for c in conn_ids if c not in known]
        if missing:
            raise ValueError("Serveurs inconnus : " + ", ".join(sorted(set(missing))))
    return out


def get_policy(principal_type: str, principal_id: int) -> Dict[str, Any]:
    """``{"engine_keys": None|list, "can_manage_models": None|bool}``."""
    _check_principal_type(principal_type)
    with db_conn() as conn:
        row = conn.execute(
            "SELECT engine_keys, can_manage_models FROM llm_engine_policies "
            "WHERE principal_type=? AND principal_id=?",
            (principal_type, int(principal_id))).fetchone()
    if not row:
        return {"engine_keys": None, "can_manage_models": None}
    return _decode_row(row[0], row[1])


def set_policy(principal_type: str, principal_id: int, *,
               engine_keys, can_manage_models) -> Dict[str, Any]:
    """Remplace la politique du principal. Tout-``None`` ⇒ ligne supprimée.

    Les clés sont normalisées SANS contrôle d'existence (c'est la route qui
    valide avec ``normalize_engine_keys(check_exists=True)`` pour répondre 400)."""
    _check_principal_type(principal_type)
    keys = normalize_engine_keys(engine_keys, check_exists=False)
    if can_manage_models is not None and not isinstance(can_manage_models, bool):
        raise ValueError("can_manage_models doit être null ou un booléen")
    if keys is None and can_manage_models is None:
        clear_policy(principal_type, principal_id)
        return {"engine_keys": None, "can_manage_models": None}
    with db_conn() as conn:
        conn.execute(
            """
            INSERT INTO llm_engine_policies(principal_type, principal_id,
                                            engine_keys, can_manage_models, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(principal_type, principal_id) DO UPDATE SET
                engine_keys       = excluded.engine_keys,
                can_manage_models = excluded.can_manage_models,
                updated_at        = excluded.updated_at
            """,
            (principal_type, int(principal_id),
             None if keys is None else json.dumps(keys),
             None if can_manage_models is None else (1 if can_manage_models else 0),
             time.time()))
        conn.commit()
    invalidate_cache()
    return {"engine_keys": keys, "can_manage_models": can_manage_models}


def clear_policy(principal_type: str, principal_id: int) -> None:
    _check_principal_type(principal_type)
    with db_conn() as conn:
        conn.execute("DELETE FROM llm_engine_policies WHERE principal_type=? AND principal_id=?",
                     (principal_type, int(principal_id)))
        conn.commit()
    invalidate_cache()


def delete_principal_rows(conn: sqlite3.Connection, principal_type: str,
                          principal_id: int) -> None:
    """Purge DANS la transaction de l'appelant (suppression d'un compte ou d'un
    groupe). Tolère l'absence de la table (base pas encore migrée)."""
    try:
        conn.execute("DELETE FROM llm_engine_policies WHERE principal_type=? AND principal_id=?",
                     (principal_type, int(principal_id)))
    except sqlite3.OperationalError:
        pass
    invalidate_cache()


def list_policies(principal_type: Optional[str] = None) -> Dict[Tuple[str, int], Dict[str, Any]]:
    """Toutes les politiques (une requête) — vue admin."""
    sql = "SELECT principal_type, principal_id, engine_keys, can_manage_models FROM llm_engine_policies"
    args: tuple = ()
    if principal_type is not None:
        _check_principal_type(principal_type)
        sql += " WHERE principal_type=?"
        args = (principal_type,)
    with db_conn() as conn:
        rows = conn.execute(sql, args).fetchall()
    return {(r[0], int(r[1])): _decode_row(r[2], r[3]) for r in rows}


def purge_engine_key(key: str) -> int:
    """Retire ``key`` de toutes les listes (connecteur supprimé). Une liste
    vidée reste ``[]`` = aucun serveur (cf. docstring du module). Rend le
    nombre de principaux modifiés."""
    if parse_key(key) is None:
        return 0
    changed = 0
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT principal_type, principal_id, engine_keys FROM llm_engine_policies "
            "WHERE engine_keys IS NOT NULL").fetchall()
        for r in rows:
            keys = _decode_row(r[2], None)["engine_keys"] or []
            if key not in keys:
                continue
            keys = [k for k in keys if k != key]
            conn.execute(
                "UPDATE llm_engine_policies SET engine_keys=?, updated_at=? "
                "WHERE principal_type=? AND principal_id=?",
                (json.dumps(keys), time.time(), r[0], int(r[1])))
            changed += 1
        conn.commit()
    invalidate_cache()
    return changed


# ── Résolution ───────────────────────────────────────────────────────────────
def resolve_access(user_policy: Optional[Dict[str, Any]],
                   group_policies: Iterable[Dict[str, Any]],
                   *, is_admin: bool) -> Dict[str, Any]:
    """Résolution PURE (testable sans base).

    Rend ``{"engine_keys": None|frozenset, "engine_source": str,
    "can_manage_models": bool, "manage_source": str}`` ; ``engine_keys=None``
    = tous les serveurs ; sources ∈ ``admin|user|groups|default``."""
    groups = [g for g in (group_policies or []) if g]
    if is_admin:
        return {"engine_keys": None, "engine_source": "admin",
                "can_manage_models": True, "manage_source": "admin"}

    up = user_policy or {}
    if up.get("engine_keys") is not None:
        keys = frozenset(up["engine_keys"])
        eng_source = "user"
    else:
        lists = [g["engine_keys"] for g in groups if g.get("engine_keys") is not None]
        if lists:
            keys = frozenset(k for lst in lists for k in lst)
            eng_source = "groups"
        else:
            keys = None
            eng_source = "default"
    if keys is not None and ALL_KEY in keys:
        keys = None

    if up.get("can_manage_models") is not None:
        manage, man_source = bool(up["can_manage_models"]), "user"
    else:
        vals = [bool(g["can_manage_models"]) for g in groups
                if g.get("can_manage_models") is not None]
        if vals:
            manage, man_source = any(vals), "groups"
        else:
            manage, man_source = True, "default"
    return {"engine_keys": keys, "engine_source": eng_source,
            "can_manage_models": manage, "manage_source": man_source}


def _load_context(user_id: int) -> Optional[Dict[str, Any]]:
    """(rôle, politique propre, politiques des groupes) — mis en cache.
    ``None`` sur erreur de lecture (l'appelant applique le fail-open)."""
    uid = int(user_id)
    now = time.monotonic()
    stamp = _current_stamp()
    with _cache_lock:
        hit = _cache.get(uid)
        if hit and now - hit[0] < _TTL_S and hit[1] == stamp:
            return hit[2]
    try:
        with db_conn() as conn:
            row = conn.execute("SELECT is_admin FROM users WHERE id=?", (uid,)).fetchone()
            is_admin = bool(row and row[0] == 1)
            rows = conn.execute(
                """
                SELECT principal_type, engine_keys, can_manage_models
                FROM llm_engine_policies
                WHERE (principal_type='user' AND principal_id=?)
                   OR (principal_type='group' AND principal_id IN
                        (SELECT group_id FROM user_groups WHERE user_id=?))
                """, (uid, uid)).fetchall()
    except Exception as e:                                       # noqa: BLE001
        _warn("[engine_access] lecture des politiques impossible (%s) — "
              "aucune restriction appliquée", e)
        return None
    user_policy = None
    group_policies: List[Dict[str, Any]] = []
    for r in rows:
        pol = _decode_row(r[1], r[2])
        if r[0] == "user":
            user_policy = pol
        else:
            group_policies.append(pol)
    ctx = {"is_admin": is_admin, "user": user_policy, "groups": group_policies}
    with _cache_lock:
        _cache[uid] = (now, stamp, ctx)
    return ctx


def _resolved(user_id, is_admin: Optional[bool]) -> Dict[str, Any]:
    try:
        uid = int(user_id)
    except (TypeError, ValueError):
        uid = None
    ctx = _load_context(uid) if uid is not None else None
    if ctx is None:
        return resolve_access(None, [], is_admin=bool(is_admin))
    admin = ctx["is_admin"] if is_admin is None else bool(is_admin)
    return resolve_access(ctx["user"], ctx["groups"], is_admin=admin)


def effective_engine_keys(user_id, *, is_admin: Optional[bool] = None) -> Optional[frozenset]:
    """Clés autorisées pour ce compte ; ``None`` = tous les serveurs."""
    return _resolved(user_id, is_admin)["engine_keys"]


def can_manage_models(user_id, *, is_admin: Optional[bool] = None) -> bool:
    return bool(_resolved(user_id, is_admin)["can_manage_models"])


def _connector_scope(cid: int) -> Optional[Tuple[str, Optional[int]]]:
    """``(scope, owner_user_id)`` ou ``None`` si absent. Lève sur erreur base."""
    with db_conn() as conn:
        row = conn.execute("SELECT scope, owner_user_id FROM llm_connectors WHERE id=?",
                           (int(cid),)).fetchone()
    if not row:
        return None
    return (row[0], None if row[1] is None else int(row[1]))


def can_use_engine(user_id, key, *, is_admin: Optional[bool] = None) -> bool:
    """Ce compte peut-il utiliser ce moteur ?

    Clé invalide ou connecteur inexistant → non. Connecteur personnel → oui
    pour son propriétaire seul. Sinon, politique résolue (admin = tout).
    Ne regarde PAS ``enabled`` : c'est une règle de visibilité, la
    désactivation reste contrôlée par la résolution de la cible."""
    p = parse_key(key)
    if p is None:
        return False
    if p[0] == "conn":
        try:
            sc = _connector_scope(p[1])
        except Exception as e:                                   # noqa: BLE001
            _warn("[engine_access] lecture du connecteur %s impossible (%s)", p[1], e)
            sc = ("shared", None)       # fail-open : on laisse la politique décider
        if sc is None:
            return False
        scope, owner = sc
        if scope == "user":
            try:
                return owner is not None and int(user_id) == owner
            except (TypeError, ValueError):
                return False
        if scope != "shared":
            return False
    keys = effective_engine_keys(user_id, is_admin=is_admin)
    return keys is None or key.strip() in keys


def filter_shared_connectors(user_id, rows, *, is_admin: Optional[bool] = None) -> list:
    """Filtre une liste de connecteurs (dicts publics). Les personnels du compte
    passent tels quels ; les partagés selon la politique résolue."""
    keys = effective_engine_keys(user_id, is_admin=is_admin)
    out = []
    for r in rows or []:
        scope = r.get("scope")
        if scope == "user":
            owner = r.get("owner_user_id")
            try:
                if owner is None or int(owner) == int(user_id):
                    out.append(r)
            except (TypeError, ValueError):
                pass
            continue
        if keys is None or connector_key(r.get("id")) in keys:
            out.append(r)
    return out


# ── Vues d'administration ─────────────────────────────────────────────────────
def list_engine_options() -> List[Dict[str, Any]]:
    """Serveurs proposables dans une liste : intégré + connecteurs PARTAGÉS."""
    try:
        import shared_infra.config as _cfg
        builtin_type = getattr(_cfg, "LLAMA_PROVIDER_TYPE", "llamacpp") or "llamacpp"
    except Exception:                                            # noqa: BLE001
        builtin_type = "llamacpp"
    out = [{"key": BUILTIN_KEY, "label": "Serveur intégré", "kind": "builtin",
            "provider_type": builtin_type, "enabled": True}]
    from shared_infra.llm import connectors as _lc
    for c in _lc.list_shared_connectors():
        out.append({"key": connector_key(c["id"]),
                    "label": c.get("label") or c.get("provider_type") or f"Connecteur {c['id']}",
                    "kind": "connector", "provider_type": c.get("provider_type") or "",
                    "base_url": c.get("base_url") or "", "enabled": bool(c.get("enabled"))})
    return out


def _json_keys(keys: Optional[frozenset], order: Optional[List[str]] = None) -> Optional[List[str]]:
    if keys is None:
        return None
    if order:
        return [k for k in order if k in keys] + sorted(k for k in keys if k not in order)
    return sorted(keys)


def describe_users(users: List[Dict[str, Any]]) -> None:
    """Complète EN PLACE les lignes de ``/api/admin/users-with-groups`` :
    réglages propres (``llm_engine_keys``, ``llm_can_manage_models``) et
    effectifs (``llm_effective_engine_keys``, ``llm_engine_source``,
    ``llm_effective_can_manage_models``, ``llm_manage_source``). Une seule
    lecture de la table, quel que soit le nombre de comptes."""
    try:
        pols = list_policies()
    except Exception as e:                                       # noqa: BLE001
        _warn("[engine_access] politiques illisibles pour la vue admin (%s)", e)
        pols = {}
    for u in users:
        own = pols.get(("user", int(u["id"]))) or {"engine_keys": None, "can_manage_models": None}
        groups = [pols[("group", int(g))] for g in (u.get("group_ids") or [])
                  if ("group", int(g)) in pols]
        res = resolve_access(own, groups, is_admin=(u.get("is_admin") == 1))
        u["llm_engine_keys"] = own["engine_keys"]
        u["llm_can_manage_models"] = own["can_manage_models"]
        u["llm_effective_engine_keys"] = _json_keys(res["engine_keys"])
        u["llm_engine_source"] = res["engine_source"]
        u["llm_effective_can_manage_models"] = res["can_manage_models"]
        u["llm_manage_source"] = res["manage_source"]
