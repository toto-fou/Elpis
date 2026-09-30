# SPDX-License-Identifier: MIT
"""
shared_infra/accounts/tokens.py — jetons personnels (lot EXT.1, 2026-09-30).

Un compte possède plusieurs jetons NOMMÉS ; seule leur EMPREINTE SHA-256 est
gardée (table ``tool_tokens``). Un jeton se montre UNE fois, à sa création ou à
sa régénération, puis n'est plus jamais réaffichable : perdu = régénéré.

Trois types, trois préfixes (défense en profondeur : un ``startswith`` ne
confond jamais deux types, et chaque vérificateur ne demande que les siens) :

* ``pcr_`` **opencode** — plugin ``elpis-remote``, ``opencode.json``, relais
  MCP (familles opencode). Sans expiration (un poste appairé le garde).
* ``ept_`` **outils** — clients MCP et OpenAPI externes. Portée = familles
  cochées ∩ politique de l'admin, avec expiration.
* ``evt_`` **vision** — remis à une automatisation de bureau pour 12 h, valable
  seulement pour ``/api/desktop/locate``, masqué de la liste.

``resolve`` refuse : jeton inconnu, expiré, compte supprimé, type non demandé,
type désactivé (fonction opencode ou jetons d'outils coupés par l'admin).

Politique (``mcp.tokens.*``, relue à chaud) : ``tools_enabled`` (vrai),
``tools_families`` (``fs,shell,git,desktop,browser,skill_run``), ``max_days`` (90,
0 = sans limite), ``max_per_user`` (20).
"""
from __future__ import annotations

import hashlib
import logging
import os
import secrets
import time
from typing import Any, Dict, Iterable, List, Optional, Tuple

from shared_infra.db import _connection as _dbc
from shared_infra.db._connection import db_conn, db_tx
from shared_infra.db._dialect import has_table, insert_id

logger = logging.getLogger("uvicorn.error")

PREFIXES: Dict[str, str] = {"opencode": "pcr_", "tools": "ept_", "vision": "evt_"}
KINDS: Tuple[str, ...] = tuple(PREFIXES)
_KIND_OF_PREFIX = {p: k for k, p in PREFIXES.items()}

VISION_TTL_S = 12 * 3600
VISION_MAX_PER_USER = 20            # jetons de vision valides gardés par compte
_TOUCH_EVERY_S = 300.0
_NAME_MAX = 80

# Familles qu'un jeton d'outils peut porter : celles qui ont DÉJÀ un point
# d'accès externe (``/mcp/<famille>``). ``desktop`` et ``browser`` sont proposés
# mais jamais cochés d'office dans « Connexions » (le premier pilote des
# machines hors de la sandbox, le second navigue — destinations et sessions
# bornées par la garde du service navigateur). Les familles internes à l'app
# (chart, memory, skill, todo) ne sont jamais exposées.
EXTERNAL_FAMILIES: Tuple[str, ...] = ("fs", "shell", "git", "desktop", "browser", "skill_run")
DEFAULT_TOOLS_FAMILIES = "fs,shell,git,desktop,browser,skill_run"
DEFAULT_MAX_DAYS = 90
DEFAULT_MAX_PER_USER = 20


# ── Politique (relue à chaud) ────────────────────────────────────────────────
def _cfg(path: str, default: Any) -> Any:
    try:
        from shared_infra.config import live_config_value
        v = live_config_value(path, default)
        return default if v is None else v
    except Exception:                                             # noqa: BLE001
        return default


def _as_int(v: Any, default: int, lo: int, hi: int) -> int:
    try:
        n = int(v)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def _parse_families(v: Any) -> List[str]:
    items = v if isinstance(v, (list, tuple, set)) else str(v or "").split(",")
    out: List[str] = []
    for f in items:
        f = str(f or "").strip()
        if f and f in EXTERNAL_FAMILIES and f not in out:
            out.append(f)
    return out


def policy() -> Dict[str, Any]:
    """Politique de l'admin pour les jetons d'outils, relue à chaque appel."""
    enabled = _cfg("mcp.tokens.tools_enabled", True)
    return {
        "tools_enabled": enabled is not False and str(enabled).lower() not in ("false", "0", "off"),
        "tools_families": _parse_families(_cfg("mcp.tokens.tools_families", DEFAULT_TOOLS_FAMILIES)),
        "max_days": _as_int(_cfg("mcp.tokens.max_days", DEFAULT_MAX_DAYS), DEFAULT_MAX_DAYS, 0, 3650),
        "max_per_user": _as_int(_cfg("mcp.tokens.max_per_user", DEFAULT_MAX_PER_USER),
                                DEFAULT_MAX_PER_USER, 1, 1000),
    }


def _opencode_enabled() -> bool:
    try:
        from shared_infra.config import feature_enabled
        return bool(feature_enabled("opencode"))
    except Exception:                                             # noqa: BLE001
        return False


def _kind_enabled(kind: str, pol: Optional[Dict[str, Any]] = None) -> bool:
    if kind == "opencode":
        return _opencode_enabled()
    if kind == "tools":
        return bool((pol or policy())["tools_enabled"])
    return kind == "vision"


# ── Stockage ─────────────────────────────────────────────────────────────────
_ready: set = set()


def _prepare() -> None:
    """Table posée et anciens jetons en clair convertis, une fois par process
    et par base. Sur PostgreSQL et MariaDB, la migration 0022 est tamponnée
    sans être rejouée : la conversion se fait ici, en DML seul."""
    key = (os.getpid(), str(getattr(_dbc, "DB_PATH", "")))
    if key in _ready:
        return
    from shared_infra.db._schema import ensure_tables
    with db_tx() as c:
        ensure_tables(c, ("tool_tokens",))
    try:
        convert_legacy()
    except Exception:                                             # noqa: BLE001
        logger.warning("[tokens] conversion des anciens jetons impossible", exc_info=True)
    _ready.add(key)


def digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _mint(kind: str) -> str:
    return PREFIXES[kind] + secrets.token_urlsafe(30)


def convert_legacy() -> int:
    """``code_remote_tokens`` (jetons ``pcr_`` en clair, un par compte) →
    empreintes de type opencode. DML seul, idempotent : les lignes converties
    sont effacées, la table vide reste (sa suppression est l'affaire de la
    migration 0022 sur SQLite)."""
    n = 0
    with db_tx() as c:
        if not has_table(c, "code_remote_tokens"):
            return 0
        rows = c.execute(
            "SELECT t.user_id, t.token, t.created_at FROM code_remote_tokens t "
            "JOIN users u ON u.id = t.user_id").fetchall()
        for uid, tok, created in rows:
            tok = str(tok or "")
            if not tok:
                continue
            h = digest(tok)
            if c.execute("SELECT 1 FROM tool_tokens WHERE token_hash=?", (h,)).fetchone():
                continue
            c.execute(
                "INSERT INTO tool_tokens(user_id, kind, name, token_hash, hint, families, created_at) "
                "VALUES(?,?,?,?,?,?,?)",
                (int(uid), "opencode", "opencode", h, tok[-4:], "", float(created or 0) or time.time()))
            n += 1
        if not rows and not c.execute("SELECT 1 FROM code_remote_tokens").fetchone():
            # Rien d'ancien (cas de CHAQUE démarrage de process sur PostgreSQL /
            # MariaDB, où la table vide subsiste) : aucune écriture — surtout
            # pas de purge des appairages en cours.
            return 0
        c.execute("DELETE FROM code_remote_tokens")
        # Appairages en cours au moment de la conversion : leur colonne
        # ``token`` a pu recevoir un pcr_ en clair avant la mise à jour (0022
        # fait de même sur SQLite). Une seule fois : la table ancienne est
        # vide ensuite.
        if has_table(c, "code_pairings"):
            c.execute("DELETE FROM code_pairings WHERE token IS NOT NULL")
    if n:
        logger.info("[tokens] %d ancien(s) jeton(s) opencode converti(s) en empreinte", n)
    return n


def _row(r: Any) -> Dict[str, Any]:
    fams = [f for f in str(r[6] or "").split(",") if f]
    return {"id": int(r[0]), "user_id": int(r[1]), "kind": str(r[2]), "name": str(r[3] or ""),
            "hint": str(r[5] or ""), "families": fams, "created_at": float(r[7] or 0),
            "expires_at": (float(r[8]) if r[8] is not None else None),
            "last_used_at": (float(r[9]) if r[9] is not None else None)}


_COLS = ("id, user_id, kind, name, token_hash, hint, families, created_at, expires_at, last_used_at")


class TokenError(ValueError):
    """Demande de jeton refusée (message destiné à l'utilisateur)."""


def _clean_name(name: Any, default: str) -> str:
    n = " ".join(str(name or "").split())[:_NAME_MAX]
    return n or default


def _validate_tools_request(families: Optional[Iterable[str]], days: Optional[int],
                            pol: Dict[str, Any]) -> Tuple[List[str], Optional[float]]:
    allowed = pol["tools_families"]
    asked = [str(f).strip() for f in (families or []) if str(f).strip()]
    bad = [f for f in asked if f not in allowed]
    if bad:
        raise TokenError("Famille non autorisée : " + ", ".join(sorted(set(bad))) + ".")
    fams = [f for f in allowed if f in asked]
    if not fams:
        raise TokenError("Cochez au moins une famille d'outils.")
    max_days = int(pol["max_days"])
    try:
        d = int(days) if days is not None else 0
    except (TypeError, ValueError):
        raise TokenError("Durée invalide.")
    if d < 0:
        raise TokenError("Durée invalide.")
    if max_days and (d == 0 or d > max_days):
        if d > max_days:
            raise TokenError(f"Durée maximale : {max_days} jours.")
        d = max_days
    return fams, (time.time() + d * 86400.0) if d else None


def check_quota(user_id: int, conn: Any = None, pol: Optional[Dict[str, Any]] = None,
                now: Optional[float] = None) -> None:
    """Lève ``TokenError`` si le compte a atteint ``max_per_user`` jetons
    opencode + outils VALIDES (les jetons expirés ne comptent plus)."""
    pol = pol or policy()
    now = time.time() if now is None else now
    sql = ("SELECT COUNT(*) FROM tool_tokens WHERE user_id=? AND kind<>'vision' "
           "AND (expires_at IS NULL OR expires_at>?)")
    if conn is not None:
        n = conn.execute(sql, (int(user_id), now)).fetchone()
    else:
        _prepare()
        with db_tx() as c:
            n = c.execute(sql, (int(user_id), now)).fetchone()
    if n and int(n[0]) >= int(pol["max_per_user"]):
        raise TokenError(f"Nombre maximal de jetons atteint ({pol['max_per_user']}). "
                         "Révoquez-en un d'abord.")


def create(user_id: int, kind: str, name: str = "", families: Optional[Iterable[str]] = None,
           days: Optional[int] = None) -> Tuple[str, Dict[str, Any]]:
    """Crée un jeton ; rend ``(jeton en clair, ligne)``. Le clair n'est
    rendu qu'ici : il n'est stocké nulle part."""
    if kind not in PREFIXES:
        raise TokenError("Type de jeton inconnu.")
    _prepare()
    pol = policy()
    fams: List[str] = []
    expires: Optional[float] = None
    if kind == "tools":
        if not pol["tools_enabled"]:
            raise TokenError("Les jetons d'outils sont désactivés par l'administrateur.")
        fams, expires = _validate_tools_request(families, days, pol)
    elif kind == "vision":
        expires = time.time() + VISION_TTL_S
    elif kind == "opencode" and not _opencode_enabled():
        raise TokenError("OpenCode est désactivé par l'administrateur.")
    default_name = {"opencode": "opencode", "tools": "outils", "vision": "vision"}[kind]
    tok = _mint(kind)
    now = time.time()
    with db_tx() as c:
        if kind != "vision":
            check_quota(user_id, conn=c, pol=pol, now=now)
        else:
            # Les jetons de vision expirés ne servent plus à rien : ménage.
            c.execute("DELETE FROM tool_tokens WHERE kind='vision' AND expires_at<?", (now,))
            # Plafond par compte (un par lancement d'automatisation) : les plus
            # anciens encore valides cèdent la place.
            ids = [int(r[0]) for r in c.execute(
                "SELECT id FROM tool_tokens WHERE user_id=? AND kind='vision' ORDER BY created_at DESC, id DESC",
                (int(user_id),)).fetchall()]
            for old_id in ids[VISION_MAX_PER_USER - 1:]:
                c.execute("DELETE FROM tool_tokens WHERE id=?", (old_id,))
        tid = insert_id(
            c.cursor(),
            "INSERT INTO tool_tokens(user_id, kind, name, token_hash, hint, families, created_at, "
            "expires_at, last_used_at) VALUES(?,?,?,?,?,?,?,?,?)",
            (int(user_id), kind, _clean_name(name, default_name), digest(tok), tok[-4:],
             ",".join(fams), now, expires, None))
    return tok, {"id": tid, "user_id": int(user_id), "kind": kind,
                 "name": _clean_name(name, default_name), "hint": tok[-4:], "families": fams,
                 "created_at": now, "expires_at": expires, "last_used_at": None}


def resolve(token: str, kinds: Iterable[str] = ("tools",), touch: bool = True) -> Optional[Dict[str, Any]]:
    """Jeton en clair → ``{id, user_id, username, kind, name, families,
    expires_at}`` ou ``None``. Pour un jeton d'outils, ``families`` est déjà
    l'intersection avec la politique courante (jamais vide)."""
    tok = str(token or "").strip()
    kind = _KIND_OF_PREFIX.get(tok[:4])
    if not kind or kind not in tuple(kinds) or len(tok) < 20:
        return None
    pol = policy()
    if not _kind_enabled(kind, pol):
        return None
    try:
        _prepare()
        with db_conn() as c:
            r = c.execute(
                "SELECT t.id, t.user_id, t.kind, t.name, t.token_hash, t.hint, t.families, "
                "t.created_at, t.expires_at, t.last_used_at, u.username "
                "FROM tool_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash=?",
                (digest(tok),)).fetchone()
    except Exception:                                             # noqa: BLE001
        logger.warning("[tokens] vérification impossible", exc_info=True)
        return None
    if not r or str(r[2]) != kind or not r[10]:
        return None
    row = _row(r)
    if row["expires_at"] is not None and row["expires_at"] <= time.time():
        return None
    fams = row["families"]
    if kind == "tools":
        fams = [f for f in fams if f in pol["tools_families"]]
        if not fams:
            return None
    out = {"id": row["id"], "user_id": row["user_id"], "username": str(r[10]), "kind": kind,
           "name": row["name"], "families": fams, "expires_at": row["expires_at"]}
    if touch:
        touch_last_used(row["id"], row["last_used_at"])
    return out


_touched: Dict[int, float] = {}


def touch_last_used(token_id: int, known: Optional[float] = None) -> None:
    """``last_used_at`` au plus toutes les 5 minutes (écriture évitée sur
    chaque appel d'outil)."""
    now = time.time()
    last = max(float(known or 0), _touched.get(int(token_id), 0.0))
    if now - last < _TOUCH_EVERY_S:
        return
    _touched[int(token_id)] = now
    if len(_touched) > 4096:
        _touched.clear()
    try:
        with db_tx() as c:
            c.execute("UPDATE tool_tokens SET last_used_at=? WHERE id=?", (now, int(token_id)))
    except Exception:                                             # noqa: BLE001
        logger.debug("[tokens] last_used_at non écrit", exc_info=True)


def list_for(user_id: int, include_hidden: bool = False) -> List[Dict[str, Any]]:
    """Jetons du compte, plus récents d'abord ; les jetons de vision (usage
    interne, 12 h) sont masqués."""
    _prepare()
    sql = f"SELECT {_COLS} FROM tool_tokens WHERE user_id=?"
    if not include_hidden:
        sql += " AND kind<>'vision'"
    with db_conn() as c:
        rows = c.execute(sql + " ORDER BY created_at DESC, id DESC", (int(user_id),)).fetchall()
    return [_row(r) for r in rows]


def get_for(user_id: int, token_id: int) -> Optional[Dict[str, Any]]:
    _prepare()
    with db_conn() as c:
        r = c.execute(f"SELECT {_COLS} FROM tool_tokens WHERE id=? AND user_id=? AND kind<>'vision'",
                      (int(token_id), int(user_id))).fetchone()
    return _row(r) if r else None


def revoke(user_id: int, token_id: int) -> bool:
    _prepare()
    with db_tx() as c:
        cur = c.execute("DELETE FROM tool_tokens WHERE id=? AND user_id=?",
                        (int(token_id), int(user_id)))
        return bool(cur.rowcount)


def revoke_kind(user_id: int, kind: str) -> int:
    _prepare()
    with db_tx() as c:
        cur = c.execute("DELETE FROM tool_tokens WHERE user_id=? AND kind=?", (int(user_id), kind))
        return int(cur.rowcount or 0)


def regenerate(user_id: int, token_id: int) -> Optional[Tuple[str, Dict[str, Any]]]:
    """Nouveau jeton de même nom, type et familles ; l'ancien est révoqué.
    La durée d'un jeton d'outils repart de maintenant (même durée, bornée par
    la politique courante)."""
    old = get_for(user_id, token_id)
    if not old:
        return None
    days: Optional[int] = None
    if old["kind"] == "tools" and old["expires_at"]:
        days = max(1, round((old["expires_at"] - old["created_at"]) / 86400.0))
        pol_max = policy()["max_days"]
        if pol_max:
            days = min(days, pol_max)
    # Tout ce qui ferait refuser la création est vérifié AVANT de supprimer
    # l'ancien jeton : un refus le laisse intact.
    if old["kind"] == "tools":
        if not policy()["tools_enabled"]:
            raise TokenError("Les jetons d'outils sont désactivés par l'administrateur.")
        fams = [f for f in old["families"] if f in policy()["tools_families"]]
        if not fams:
            raise TokenError("Aucune des familles de ce jeton n'est encore autorisée.")
    else:
        if old["kind"] == "opencode" and not _opencode_enabled():
            raise TokenError("OpenCode est désactivé par l'administrateur.")
        fams = old["families"]
    _prepare()
    with db_tx() as c:
        c.execute("DELETE FROM tool_tokens WHERE id=? AND user_id=?", (int(token_id), int(user_id)))
    return create(user_id, old["kind"], old["name"], fams, days)


def delete_for_user(user_id: int, conn: Any = None) -> None:
    """Purge des jetons d'un compte supprimé (dans la transaction de
    l'appelant si ``conn`` est fourni)."""
    if conn is not None:
        conn.execute("DELETE FROM tool_tokens WHERE user_id=?", (int(user_id),))
        return
    _prepare()
    with db_tx() as c:
        c.execute("DELETE FROM tool_tokens WHERE user_id=?", (int(user_id),))


def revoke_all_access(user_id: int) -> Dict[str, int]:
    """Coupe tout l'accès NON interactif d'un compte : jetons personnels
    (opencode, outils, vision) et autorisations OAuth. Appelé quand ses
    sessions sont révoquées ou son mot de passe changé : un compte coupé ne
    garde aucune porte d'entrée par jeton.

    → ``{"tokens": n, "oauth": n}`` (autorisations OAuth valables supprimées)."""
    out = {"tokens": 0, "oauth": 0}
    _prepare()
    with db_tx() as c:
        out["tokens"] = int(c.execute("DELETE FROM tool_tokens WHERE user_id=?",
                                      (int(user_id),)).rowcount or 0)
    try:
        from shared_infra.mcp import oauth as _oauth
        out["oauth"] = len(_oauth.list_grants(int(user_id)))
        _oauth.delete_for_user(int(user_id))
    except Exception:                                             # noqa: BLE001
        logger.warning("[tokens] révocation OAuth du compte %s impossible", user_id, exc_info=True)
    if out["tokens"] or out["oauth"]:
        logger.info("[tokens] compte %s : %d jeton(s) et %d application(s) révoqués",
                    user_id, out["tokens"], out["oauth"])
    return out


def kind_of(token: str) -> Optional[str]:
    return _KIND_OF_PREFIX.get(str(token or "")[:4])


__all__ = ["EXTERNAL_FAMILIES", "KINDS", "PREFIXES", "TokenError", "check_quota", "convert_legacy", "create", "revoke_all_access",
           "delete_for_user", "digest", "get_for", "kind_of", "list_for", "policy", "regenerate",
           "resolve", "revoke", "revoke_kind", "touch_last_used"]
