# SPDX-License-Identifier: MIT
"""
shared_infra.mcp.servers — Bibliothèque MCP PARTAGÉE (publiée par l'admin).

``settings.mcp_servers`` reste la liste PERSO de chaque utilisateur. Cette table
est la liste COMMUNE : l'admin publie « Jenkins » une fois, tous les comptes le
voient dans leur gestionnaire de serveurs et cochent l'œil pour l'afficher dans
leur panneau Outils (``settings.shared_mcp_visible`` — vide par défaut, donc
rien n'apparaît sans geste explicite).

INVARIANT DE SÉCURITÉ (calqué sur ``llm_connectors``) : le secret d'auth n'est
JAMAIS renvoyé par les fonctions exposées aux routes. ``list_shared`` /
``get_shared`` rendent ``has_auth`` ; seul ``resolve_config`` — appelé host-side
au moment du tour de chat — reconstruit la config MCP complète avec l'en-tête
d'authentification, et cette valeur ne repart jamais vers le navigateur.

Ids exposés sous la forme ``shared:<n>`` : ils cohabitent avec les ids perso
(``server_<timestamp>``) dans le MÊME panneau sans collision possible, et le
préfixe est ce qui dit à la route de chat « celui-là, résous-le en base ».
"""
from __future__ import annotations

import json
import re
import time
from typing import Any, Dict, List, Optional

from shared_infra.db._connection import db_conn
from shared_infra.db._dialect import insert_id
from shared_infra.security.encryption import decrypt, encrypt

SERVER_TYPES = ("sse", "stdio", "http")
# ``header`` — la clé va dans un en-tête NOMMÉ par l'utilisateur (``auth_user``
# porte le nom, le secret porte la valeur). C'est la forme la plus répandue
# après Bearer : X-API-Key, X-Api-Token, PRIVATE-TOKEN…
AUTH_MODES = ("", "basic", "raw", "bearer", "header")

# Transports HTTP : l'en-tête d'auth y a un sens (contrairement à stdio).
HTTP_TYPES = ("sse", "http")

# Nom d'en-tête retenu quand le mode ``header`` est choisi sans en nommer un.
DEFAULT_HEADER_NAME = "X-API-Key"

# ── Paires supplémentaires (en-têtes HTTP / variables d'environnement) ────────
# Même contrat que le secret principal : la VALEUR est chiffrée au repos et ne
# repart jamais vers le navigateur ; seul le NOM circule, avec un booléen
# ``has_value``. Bornes volontairement basses : ces listes vivent dans le blob
# ``settings_json`` re-PUT à chaque changement de préférence.
MAX_PAIRS = 20
MAX_PAIR_NAME = 128
MAX_PAIR_VALUE = 8192

# RFC 9110 token, borné. Un nom hors de cette grammaire ferait lever httpx
# AVANT tout envoi (``LocalProtocolError``) — donc on le jette ici.
_HEADER_NAME_RE = re.compile(r"^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$")
_ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")

# En-têtes posés par le transport lui-même. Les laisser écraser produit une
# requête invalide (``Content-Length`` faux, ``Transfer-Encoding`` en doublon)
# ou détourne la connexion (``Host``) — aucun serveur MCP ne demande ça.
_RESERVED_HEADERS = frozenset({
    "host", "content-length", "connection", "transfer-encoding", "upgrade",
    "keep-alive", "proxy-authorization", "proxy-connection", "te", "trailer",
    "expect",
})

# Variables que le wrapper stdio calcule lui-même (cf. MCPStdioWrapper) :
# les écraser casse la résolution d'imports du sous-processus.
_RESERVED_ENV = frozenset({"PYTHONPATH", "NODE_PATH", "APP_SANDBOX_DIR"})


class InvalidPair(ValueError):
    """Nom d'en-tête / de variable refusé. Levée UNIQUEMENT sur les chemins
    qui peuvent répondre 400 (routes de la bibliothèque partagée) ; la fusion
    perso, elle, ne lève jamais — cf. ``merge_personal_mcp``."""


def _pair_name_ok(name: str, kind: str) -> bool:
    if kind == "env":
        return bool(_ENV_NAME_RE.match(name)) and name not in _RESERVED_ENV
    return bool(_HEADER_NAME_RE.match(name)) and name.lower() not in _RESERVED_HEADERS


def header_name_ok(name: str) -> bool:
    """Un nom d'en-tête est-il utilisable comme créneau d'auth ``header`` ?"""
    return _pair_name_ok(str(name or "").strip(), "headers")


def sanitize_pairs(raw: Any, *, kind: str, strict: bool = False) -> List[Dict[str, str]]:
    """Liste client → paires propres ``[{name, value}]``.

    ``strict=True`` lève ``InvalidPair`` sur un nom refusé (chemin admin, qui
    peut répondre 400) ; sinon la paire est simplement jetée (chemin perso, où
    un blob rejeté rendrait TOUS les réglages non enregistrables).
    Doublons : la DERNIÈRE occurrence gagne, l'ordre de première apparition est
    conservé — c'est ce que fait un dict d'en-têtes côté transport.
    """
    out: List[Dict[str, str]] = []
    seen: Dict[str, int] = {}
    for item in (raw or [])[:MAX_PAIRS * 4]:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()[:MAX_PAIR_NAME]
        if not name:
            continue
        if not _pair_name_ok(name, kind):
            if strict:
                raise InvalidPair(name)
            continue
        value = str(item.get("value") or "")[:MAX_PAIR_VALUE].strip()
        if name in seen:
            out[seen[name]]["value"] = value
            continue
        seen[name] = len(out)
        out.append({"name": name, "value": value})
        if len(out) >= MAX_PAIRS:
            break
    return out


def merge_pairs(old_pairs: Any, new_pairs: Any, *, kind: str,
                strict: bool = False) -> List[Dict[str, str]]:
    """Fusionne les paires reçues avec celles en place — « vide = inchangé ».

    Même contrat que ``auth_secret`` : le navigateur ne relit jamais une
    valeur, donc il renvoie le nom avec une valeur vide. On reporte alors
    celle déjà stockée SOUS LE MÊME NOM. Renommer un en-tête perd donc sa
    valeur, ce qui est le comportement voulu (un nom différent = un autre
    créneau, l'ancien secret n'a plus de raison d'y aller).
    """
    stored = {p["name"]: p["value"] for p in (old_pairs or [])
              if isinstance(p, dict) and p.get("name")}
    out = sanitize_pairs(new_pairs, kind=kind, strict=strict)
    for p in out:
        if not p["value"]:
            p["value"] = stored.get(p["name"], "")
    return out


def pairs_public(pairs: Any) -> List[Dict[str, Any]]:
    """Vue navigateur : le nom, jamais la valeur. ``value`` reste présent et
    VIDE pour que le formulaire fasse un aller-retour sans sentinelle."""
    return [{"name": p["name"], "value": "", "has_value": bool(p.get("value"))}
            for p in (pairs or []) if isinstance(p, dict) and p.get("name")]


def _encode_pairs(pairs: Any) -> tuple[str, str]:
    """(blob stocké, schéma). Liste vide → ``('', 'plain')``.

    Propage ``EncryptionUnavailable`` comme ``_encode_secret`` : la route
    refuse d'enregistrer plutôt que de poser un jeton en clair.
    """
    clean = [p for p in (pairs or [])
             if isinstance(p, dict) and p.get("name")]
    if not clean:
        return "", "plain"
    return encrypt(json.dumps(clean, ensure_ascii=False)), "fernet"


def _decode_pairs(enc: str, scheme: str) -> List[Dict[str, str]]:
    """Blob → paires. Tolérant : un blob illisible (clé de chiffrement
    remplacée) rend une liste VIDE au lieu de casser le serveur entier."""
    if not enc:
        return []
    try:
        raw = decrypt(enc) if scheme == "fernet" else enc
        data = json.loads(raw)
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    return [{"name": str(p.get("name") or ""), "value": str(p.get("value") or "")}
            for p in data if isinstance(p, dict) and p.get("name")]


def _pairs_to_dict(pairs: Any) -> Dict[str, str]:
    """Paires → dict prêt pour le transport. Les valeurs VIDES sont retirées :
    une paire dont la valeur n'a jamais été saisie est un créneau en attente,
    pas un en-tête à envoyer vide (que beaucoup de serveurs rejettent)."""
    return {p["name"]: p["value"] for p in (pairs or [])
            if isinstance(p, dict) and p.get("name") and p.get("value")}

# Préfixe d'id public. ``shared_id("shared:3") == 3`` ; tout le reste → None.
ID_PREFIX = "shared:"


def public_id(row_id: int) -> str:
    return f"{ID_PREFIX}{int(row_id)}"


def shared_id(public: Any) -> Optional[int]:
    """``"shared:3"`` → 3 ; toute autre forme → ``None`` (id perso, bruit…)."""
    s = str(public or "")
    if not s.startswith(ID_PREFIX):
        return None
    try:
        return int(s[len(ID_PREFIX):])
    except ValueError:
        return None


def _encode_secret(secret: str) -> tuple[str, str]:
    """(valeur stockée, schéma). Vide → ('', 'plain'). Sinon Fernet.

    Propage ``EncryptionUnavailable`` : la route refuse d'enregistrer plutôt que
    de stocker un token en clair."""
    if not secret:
        return "", "plain"
    return encrypt(secret), "fernet"


def normalize_secret(mode: str, secret: str) -> str:
    """Nettoie le secret AVANT stockage, selon le mode.

    Mode ``bearer`` : on stocke le jeton NU. L'utilisateur colle souvent
    l'en-tête entier (« Bearer eyJ… ») copié d'une doc ; sans ce retrait on
    enverrait « Bearer Bearer eyJ… ». Le ``strip()`` compte autant : un espace
    final fait rejeter l'en-tête par httpx (``LocalProtocolError``) AVANT tout
    envoi, et beaucoup de serveurs comparent le reste sans le retailler.
    """
    s = (secret or "").strip()
    if mode == "bearer" and s[:7].lower() == "bearer ":
        s = s[7:].strip()
    return s


def _decode_secret(enc: str, scheme: str) -> str:
    if not enc:
        return ""
    if scheme == "fernet":
        return decrypt(enc)
    return enc


# Colonnes rendues à un compte ORDINAIRE. Volontairement pauvres : il n'a besoin
# que de reconnaître le serveur dans sa liste et de décider s'il l'affiche.
_USER_COLS = ("id", "name", "type", "enabled")

# Colonnes rendues à l'ADMIN, qui édite l'entrée : elles remplissent son
# formulaire. ``auth_user`` et l'URL interne s'arrêtent ici — c'est la moitié
# d'un couple Basic et le point d'entrée exact du service ; les diffuser à tous
# les comptes n'apportait rien à leur usage (cocher un œil) et donnait à
# n'importe quel compte de quoi attaquer le service directement.
_ADMIN_COLS = _USER_COLS + ("url", "command", "auth_mode", "auth_user",
                            "created_at", "updated_at")


def _public(row, *, admin: bool = False) -> Dict[str, Any]:
    """Vue SANS secret. ``admin=False`` (défaut) = vue d'usage : de quoi
    reconnaître et afficher le serveur, rien de plus."""
    d = {k: row[k] for k in (_ADMIN_COLS if admin else _USER_COLS)}
    d["id"] = public_id(d["id"])
    d["enabled"] = bool(d["enabled"])
    d["has_auth"] = bool(row["auth_enc"])
    d["shared"] = True
    if admin:
        # Noms seuls — les valeurs restent côté serveur, comme ``auth_enc``.
        # Ils remplissent le formulaire d'édition ; un compte ordinaire n'a
        # rien à en faire (il ne fait que cocher l'œil).
        scheme = _row_get(row, "extra_scheme", "plain")
        d["headers"] = pairs_public(
            _decode_pairs(_row_get(row, "headers_enc", ""), scheme))
        d["env"] = pairs_public(
            _decode_pairs(_row_get(row, "env_enc", ""), scheme))
    return d


def _row_get(row, key: str, default: Any = "") -> Any:
    """Lecture tolérante d'une colonne : une base pas encore migrée (le
    pré-chauffage MCP peut lire avant ``run_pending``) n'a pas les colonnes
    ``headers_enc``/``env_enc``/``extra_scheme``."""
    try:
        val = row[key]
    except (IndexError, KeyError):
        return default
    return default if val is None else val


# ── Lectures ──────────────────────────────────────────────────────────────────
def list_shared(*, admin: bool = False,
                include_disabled: Optional[bool] = None) -> List[Dict[str, Any]]:
    """Bibliothèque publiée, vue sans secret.

    Un compte ordinaire ne voit QUE les entrées actives : une entrée désactivée
    n'est pas cochable, et la lui montrer ne ferait qu'exposer un service de
    plus. L'admin voit tout, avec les champs d'édition."""
    if include_disabled is None:
        include_disabled = admin
    sql = "SELECT * FROM mcp_shared_servers"
    if not include_disabled:
        sql += " WHERE enabled=1"
    sql += " ORDER BY name ASC, id ASC"
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute(sql)
        return [_public(r, admin=admin) for r in cur.fetchall()]


def get_shared(server_id: int, *, admin: bool = False) -> Optional[Dict[str, Any]]:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT * FROM mcp_shared_servers WHERE id=?", (int(server_id),))
        r = cur.fetchone()
        return _public(r, admin=admin) if r else None


# ── Écritures (admin) ─────────────────────────────────────────────────────────
def create_shared(*, name: str, type: str = "sse", url: str = "",
                  command: str = "", auth_mode: str = "", auth_user: str = "",
                  auth_secret: str = "", enabled: bool = True,
                  headers: Any = None, env: Any = None) -> int:
    enc, scheme = _encode_secret(normalize_secret(auth_mode or "", auth_secret))
    # Un créneau supplémentaire n'a de sens que sur son transport : des
    # en-têtes sur du stdio (ou des variables sur du HTTP) seraient inertes
    # mais entreraient dans l'empreinte d'auth de la clé du pool.
    h_pairs = headers if type in HTTP_TYPES else []
    e_pairs = env if type == "stdio" else []
    h_enc, h_scheme = _encode_pairs(h_pairs)
    e_enc, e_scheme = _encode_pairs(e_pairs)
    extra_scheme = "fernet" if (h_scheme == "fernet" or e_scheme == "fernet") else "plain"
    now = time.time()
    with db_conn() as conn:
        cur = conn.cursor()
        new_id = insert_id(
            cur,
            "INSERT INTO mcp_shared_servers(name, type, url, command, auth_mode, "
            "auth_user, auth_enc, key_scheme, headers_enc, env_enc, extra_scheme, "
            "enabled, created_at, updated_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (name, type, url or "", command or "", auth_mode or "",
             auth_user or "", enc, scheme, h_enc, e_enc, extra_scheme,
             1 if enabled else 0, now, now))
        conn.commit()
        return new_id


def shared_pairs(server_id: int) -> tuple[List[Dict[str, str]], List[Dict[str, str]]]:
    """Paires (en-têtes, variables) EN CLAIR d'une ligne partagée — host-side.

    Sert à la fusion « vide = inchangé » de ``update_shared`` et au bouton
    « Tester » (qui doit pouvoir éprouver une entrée sans re-saisir chaque
    valeur)."""
    r = raw_shared(server_id)
    if not r:
        return [], []
    scheme = r.get("extra_scheme") or "plain"
    return (_decode_pairs(r.get("headers_enc") or "", scheme),
            _decode_pairs(r.get("env_enc") or "", scheme))


def update_shared(server_id: int, **fields) -> bool:
    """Update partiel. ``auth_secret`` non-vide remplace le secret ; absent ou
    vide, le secret en place est CONSERVÉ (l'admin qui renomme un serveur n'a
    pas à re-saisir le token). Pour retirer l'auth : ``auth_mode=""``, qui
    efface aussi le secret — y compris si un ``auth_secret`` non vide est joint
    dans le même appel (le retrait prime, cf. plus bas)."""
    sets: List[str] = []
    vals: List[Any] = []
    for k in ("name", "type", "url", "command", "auth_user"):
        if fields.get(k) is not None:
            sets.append(f"{k}=?")
            vals.append(fields[k])
    if fields.get("enabled") is not None:
        sets.append("enabled=?")
        vals.append(1 if fields["enabled"] else 0)

    mode = fields.get("auth_mode")
    secret = fields.get("auth_secret")
    # « Aucune » PRIME sur un secret encore présent dans le payload. Le champ de
    # saisie est masqué par un ``v-if`` quand le mode passe à « Aucune », mais
    # démonter l'input ne vide PAS son modèle : le navigateur ré-émet le token
    # tapé juste avant, avec ``auth_mode=""``. Les deux branches empilaient alors
    # DEUX ``auth_enc=?`` dans le même UPDATE — SQLite tolère et garde le
    # DERNIER, donc le token repartait chiffré en base sur une entrée « sans
    # authentification » et ``has_auth`` restait vrai, en contradiction directe
    # avec la promesse ci-dessus. Exclusives : au plus une écriture de auth_enc.
    if mode is not None:
        sets.append("auth_mode=?")
        vals.append(mode)
    if mode is not None and not mode:      # « Aucune » → le secret n'a plus de sens
        sets += ["auth_enc=?", "key_scheme=?"]
        vals += ["", "plain"]
    elif secret:
        # Le mode gouverne la normalisation. S'il n'est pas dans le payload
        # (update partiel), on relit celui en place plutôt que de deviner.
        eff_mode = mode
        if eff_mode is None:
            with db_conn() as _c:
                _r = _c.execute(
                    "SELECT auth_mode FROM mcp_shared_servers WHERE id=?",
                    (int(server_id),)).fetchone()
            eff_mode = (_r["auth_mode"] if _r else "") or ""
        enc, scheme = _encode_secret(normalize_secret(eff_mode, secret))
        sets += ["auth_enc=?", "key_scheme=?"]
        vals += [enc, scheme]

    # Créneaux supplémentaires — même contrat « vide = inchangé », mais PAR
    # NOM (cf. merge_pairs). Absents du payload = laissés tels quels ; présents
    # = la liste reçue fait autorité (c'est ainsi qu'on en RETIRE un).
    if fields.get("headers") is not None or fields.get("env") is not None:
        old_h, old_e = shared_pairs(server_id)
        eff_type = fields.get("type")
        if eff_type is None:
            _r = raw_shared(server_id) or {}
            eff_type = _r.get("type") or "sse"
        new_h = (merge_pairs(old_h, fields.get("headers"), kind="headers")
                 if fields.get("headers") is not None else old_h)
        new_e = (merge_pairs(old_e, fields.get("env"), kind="env")
                 if fields.get("env") is not None else old_e)
        if eff_type not in HTTP_TYPES:
            new_h = []
        if eff_type != "stdio":
            new_e = []
        h_enc, h_scheme = _encode_pairs(new_h)
        e_enc, e_scheme = _encode_pairs(new_e)
        sets += ["headers_enc=?", "env_enc=?", "extra_scheme=?"]
        vals += [h_enc, e_enc,
                 "fernet" if (h_scheme == "fernet" or e_scheme == "fernet") else "plain"]

    if not sets:
        return False
    sets.append("updated_at=?")
    vals.append(time.time())
    vals.append(int(server_id))
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute(f"UPDATE mcp_shared_servers SET {', '.join(sets)} WHERE id=?", vals)
        conn.commit()
        return cur.rowcount > 0


def delete_shared(server_id: int) -> bool:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM mcp_shared_servers WHERE id=?", (int(server_id),))
        conn.commit()
        return cur.rowcount > 0


# ── Résolution host-side (secret INCLUS — jamais sérialisée HTTP) ─────────────
def resolve_config(server_id: int) -> Optional[Dict[str, Any]]:
    """Config MCP prête pour ``_resolve_mcp_client``, en-tête d'auth compris.

    Retourne ``None`` si l'entrée n'existe pas ou est désactivée : la route de
    chat jette alors l'entrée au lieu de tenter une connexion boiteuse.
    """
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT * FROM mcp_shared_servers WHERE id=? AND enabled=1",
                    (int(server_id),))
        r = cur.fetchone()
    if not r:
        return None
    return _row_to_config(r)


def raw_shared(server_id: int) -> Optional[Dict[str, Any]]:
    """Ligne brute, ``auth_enc`` compris — HOST-SIDE uniquement.

    Sert au bouton « Tester » : il faut pouvoir éprouver une entrée DÉSACTIVÉE
    (``resolve_config`` ne rend que les actives) et reporter le secret stocké
    quand l'admin n'en ressaisit pas.
    """
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT * FROM mcp_shared_servers WHERE id=?", (int(server_id),))
        r = cur.fetchone()
    return dict(r) if r else None


def _row_to_config(r) -> Dict[str, Any]:
    """Ligne DB → config MCP (auth déchiffrée). Host-side uniquement."""
    cfg: Dict[str, Any] = {
        "id": public_id(r["id"]),
        "name": r["name"],
        "type": r["type"],
        "url": r["url"],
        "command": r["command"],
    }
    scheme = _row_get(r, "extra_scheme", "plain")
    # L'en-tête d'auth n'a de sens que sur un transport HTTP/SSE. Sur du stdio
    # il serait inerte pour ``_resolve_mcp_client`` mais entrerait quand même
    # dans l'empreinte d'auth de la clé du pool — deux configs identiques au
    # token près y ouvriraient deux sous-processus au lieu d'en partager un.
    if r["type"] not in HTTP_TYPES:
        env = _pairs_to_dict(_decode_pairs(_row_get(r, "env_enc", ""), scheme))
        if env:
            cfg["env"] = env
        return cfg
    headers = _pairs_to_dict(_decode_pairs(_row_get(r, "headers_enc", ""), scheme))
    if headers:
        cfg["headers"] = headers
    secret = _decode_secret(r["auth_enc"], r["key_scheme"])
    _apply_auth_mode(cfg, r["auth_mode"], r["auth_user"], secret)
    return cfg


def _apply_auth_mode(cfg: Dict[str, Any], mode: Any, user: Any, secret: str) -> None:
    """Pose le créneau d'auth PRINCIPAL sur une config déjà porteuse de ses
    en-têtes supplémentaires.

    Le mode prime sur la liste : si l'utilisateur a nommé le même en-tête des
    deux côtés, c'est le créneau d'auth — celui dont la valeur est masquée par
    ``has_auth`` — qui gagne. Une seule règle à retenir, dans les deux sens.
    """
    mode = mode or ""
    user = str(user or "")
    if not secret:
        return
    if mode == "basic" and user:
        cfg["basic_auth"] = {"username": user, "token": secret}
    elif mode == "bearer":
        cfg["authorization"] = f"Bearer {secret}"
    elif mode == "raw":
        cfg["authorization"] = secret
    elif mode == "header":
        name = user.strip() or DEFAULT_HEADER_NAME
        if header_name_ok(name):
            cfg.setdefault("headers", {})
            cfg["headers"] = {**cfg["headers"], name: secret}


def resolve_many(public_ids: List[Any]) -> List[Dict[str, Any]]:
    """``resolve_config`` sur une liste d'ids publics, ordre préservé, entrées
    inconnues/désactivées silencieusement jetées.

    UNE requête pour toute la liste : c'est un chemin chaud (chaque tour de chat
    avec sous-agents, chaque run de routine), une connexion + un SELECT par id y
    était du gaspillage pur."""
    rids: List[int] = []
    for pid in public_ids or []:
        rid = shared_id(pid)
        if rid is not None and rid not in rids:
            rids.append(rid)
    if not rids:
        return []
    marks = ",".join("?" * len(rids))
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            f"SELECT * FROM mcp_shared_servers WHERE enabled=1 AND id IN ({marks})",
            rids)
        by_id = {int(r["id"]): r for r in cur.fetchall()}
    return [_row_to_config(by_id[rid]) for rid in rids if rid in by_id]


# ── Serveurs PERSO (settings.mcp_servers) ────────────────────────────────────
# Même forme au repos que la ligne partagée : auth_mode / auth_user / auth_enc /
# key_scheme. Le secret ne quitte JAMAIS le serveur — ni en GET, ni dans le
# payload de chat, ni dans un instantané de routine.

# Seules clés qu'un client peut écrire. Liste BLANCHE : ``auth_enc`` et
# ``key_scheme`` en sont absents, sinon un client poserait key_scheme='plain'
# avec un secret en clair (downgrade) ou rejouerait un chiffré volé.
# ``headers`` en est SORTI (2026-08-30) : la clé existait, le transport la
# lisait, mais elle était recopiée telle quelle — donc stockée en clair et
# renvoyée au navigateur à chaque GET. Elle passe désormais par le même
# créneau chiffré que le secret principal (``headers_enc``), alimenté
# explicitement dans ``merge_personal_mcp``.
_PERSONAL_CLIENT_KEYS = ("id", "name", "type", "url", "command", "visible",
                         "auth_mode", "auth_user")

# Champs qui ne doivent JAMAIS repartir vers le navigateur.
_PERSONAL_SECRET_KEYS = ("auth_enc", "key_scheme", "auth_secret",
                         "authorization", "basic_auth",
                         "headers_enc", "env_enc", "extra_scheme")


def personal_pairs(srv: Any) -> tuple[List[Dict[str, str]], List[Dict[str, str]]]:
    """Paires (en-têtes, variables) EN CLAIR d'une entrée perso — host-side.

    Reprend au vol la forme LEGACY ``headers: {"X-Api-Key": "…"}`` posée en
    clair par l'ancienne clé de passe-plat : elle reste fonctionnelle tant
    qu'une sauvegarde ne l'a pas migrée vers le créneau chiffré.
    """
    if not isinstance(srv, dict):
        return [], []
    scheme = srv.get("extra_scheme") or "plain"
    headers = _decode_pairs(srv.get("headers_enc") or "", scheme)
    if not headers:
        legacy = srv.get("headers")
        if isinstance(legacy, dict):
            headers = sanitize_pairs(
                [{"name": k, "value": v} for k, v in legacy.items()],
                kind="headers")
    return headers, _decode_pairs(srv.get("env_enc") or "", scheme)


def personal_public(srv: Any) -> Dict[str, Any]:
    """Vue navigateur d'un serveur perso : sans secret, avec ``has_auth``."""
    if not isinstance(srv, dict):
        return {}
    out = {k: v for k, v in srv.items()
           if k not in _PERSONAL_SECRET_KEYS and k != "headers"}
    out["has_auth"] = bool(srv.get("auth_enc") or srv.get("authorization")
                           or srv.get("basic_auth"))
    headers, env = personal_pairs(srv)
    out["headers"] = pairs_public(headers)
    out["env"] = pairs_public(env)
    return out


def personal_to_config(srv: Any, *, allow_stdio: bool = False) -> Dict[str, Any]:
    """Entrée perso → config MCP prête pour ``_resolve_mcp_client``.

    Tolérant au legacy : une entrée non migrée (``authorization`` /
    ``basic_auth`` en clair, faute de clé de chiffrement disponible au moment
    de la migration) reste fonctionnelle.

    ``allow_stdio`` (2026-09-20) : False pour un propriétaire non admin → une
    entrée ``stdio`` donne ``{}`` (jamais spawnée). Refus PAR DÉFAUT depuis le
    2026-09-21 : un appelant qui oublie le drapeau (les sous-agents de routine
    l'oubliaient) obtient un refus, plus une exécution sur l'hôte. Seul un
    usage sans exécution (clé de pool à invalider) passe ``True`` sans
    connaître le propriétaire.
    """
    if not isinstance(srv, dict):
        return {}
    if str(srv.get("type") or "").lower() == "stdio" and not allow_stdio:
        return {}
    # Même drapeau « propriétaire admin » pour la garde SSRF (audit 2026-09-22,
    # H7) : une entrée perso d'un non-admin vers une adresse interne n'est
    # jamais connectée, même enregistrée avant la garde.
    if (srv.get("type") in HTTP_TYPES and not allow_stdio
            and personal_url_block_reason(srv.get("url"))):
        return {}
    cfg = {k: v for k, v in srv.items()
           if k not in ("auth_enc", "key_scheme", "auth_secret", "has_auth",
                        "visible", "headers", "headers_enc", "env_enc",
                        "extra_scheme")}
    stype = srv.get("type")
    headers, env = personal_pairs(srv)
    if stype == "stdio":
        env_map = _pairs_to_dict(env)
        if env_map:
            cfg["env"] = env_map
    elif stype in HTTP_TYPES:
        header_map = _pairs_to_dict(headers)
        if header_map:
            cfg["headers"] = header_map

    enc = srv.get("auth_enc") or ""
    if not enc:
        # Legacy jamais migré : ``authorization``/``basic_auth`` sont encore en
        # clair dans l'entrée et ont été recopiés par le filtre ci-dessus.
        return cfg
    cfg.pop("authorization", None)
    cfg.pop("basic_auth", None)
    if stype not in HTTP_TYPES:
        return cfg
    try:
        secret = _decode_secret(enc, srv.get("key_scheme") or "plain")
    except Exception:
        return cfg
    _apply_auth_mode(cfg, srv.get("auth_mode"), srv.get("auth_user"), secret)
    return cfg


def personal_url_block_reason(url: Any) -> Optional[str]:
    """Motif de refus de l'URL d'un serveur MCP PERSO d'un non-admin, ou
    ``None`` (audit 2026-09-22, H7).

    Sans garde, n'importe quel compte faisait émettre par le SERVEUR des
    requêtes vers ``127.0.0.1`` (service RAG, routes internes qui ne
    vérifient que la boucle locale), le LAN ou ``169.254.169.254``, avec des
    en-têtes libres. Mode strict de ``block_remote_url_reason`` : seules les
    adresses publiques passent. Un serveur interne légitime se publie par un
    admin dans la bibliothèque partagée (non soumise à cette garde).
    Limite : l'hôte est résolu ici puis de nouveau à la connexion (rebinding
    DNS non couvert)."""
    u = str(url or "")
    now = time.monotonic()
    hit = _URL_VERDICTS.get(u)
    if hit and now - hit[0] < 60:
        return hit[1]
    from shared_infra.git.ssrf import block_remote_url_reason
    why = block_remote_url_reason(u, allow_schemes=("http", "https"))
    if len(_URL_VERDICTS) > 512:
        _URL_VERDICTS.clear()
    _URL_VERDICTS[u] = (now, why)
    return why


# Verdicts récents (60 s) : ``personal_to_config`` tourne à chaque tour de
# chat, la résolution DNS de la garde n'a pas à s'y répéter.
_URL_VERDICTS: Dict[str, tuple] = {}


class StdioNotAllowed(ValueError):
    """Un compte non administrateur a tenté d'AJOUTER un serveur perso
    ``stdio`` (2026-09-20). Un tel serveur est une COMMANDE exécutée sur
    l'hôte, hors sandbox, avec l'environnement du worker : c'est une
    exécution de code arbitraire pour quiconque possède un compte. Les gardes
    « modification / suppression réservées aux administrateurs » ne couvraient
    que les entrées EXISTANTES ; l'ajout passait."""


class UrlNotAllowed(StdioNotAllowed):
    """URL d'un serveur perso vers une adresse interne (``personal_url_block_reason``).
    Sous-classe de ``StdioNotAllowed`` : les routes la traduisent déjà en 403."""


def merge_personal_mcp(old_list: Any, new_list: Any, *,
                       allow_stdio: bool = False) -> List[Dict[str, Any]]:
    """Fusionne la liste perso reçue du client avec celle en base.

    Le créneau secret n'est JAMAIS peuplé depuis les octets du client : soit
    l'utilisateur tape un nouveau secret (``auth_secret``), soit on reporte
    celui déjà stocké. C'est ce qui rend « vide = inchangé » sûr sans sentinelle
    devinable, et ce qui empêche ``saveSettings`` — qui re-PUT le blob ENTIER à
    chaque changement de préférence — d'effacer tous les jetons.

    Ne lève jamais sur une entrée malformée : un blob rejeté rendrait TOUS les
    réglages non enregistrables (même raisonnement que le renommage d'ids).
    """
    old_by_id = {str(s.get("id")): s for s in (old_list or [])
                 if isinstance(s, dict) and s.get("id")}
    out: List[Dict[str, Any]] = []
    for srv in (new_list or []):
        if not isinstance(srv, dict):
            continue
        entry = {k: srv[k] for k in _PERSONAL_CLIENT_KEYS if k in srv}
        stype = str(entry.get("type") or "sse").strip().lower()
        entry["type"] = stype if stype in SERVER_TYPES else "sse"
        # ``stdio`` sans droit : refus net de l'AJOUT, mais aussi de la
        # conversion d'une entrée existante (http → stdio) et du changement de
        # commande. Avant le 2026-09-21 seul l'id NOUVEAU était refusé : un
        # modérateur, qui passe la garde de modification de la route, pouvait
        # réécrire un serveur existant en commande. Une entrée stdio DÉJÀ
        # enregistrée et renvoyée à l'identique reste acceptée (le blob entier
        # est re-PUT à chaque préférence) ; elle n'est jamais exécutée pour un
        # non-admin (cf. ``personal_to_config``).
        if entry["type"] == "stdio" and not allow_stdio:
            _prev = old_by_id.get(str(srv.get("id")))
            if (_prev is None
                    or str(_prev.get("type") or "").strip().lower() != "stdio"
                    or str(_prev.get("command") or "") != str(entry.get("command") or "")):
                raise StdioNotAllowed(
                    "Serveur MCP « Local » (commande exécutée sur le serveur) "
                    "réservé aux administrateurs.")
        # URL interne (loopback, LAN, métadonnées) : refusée à l'AJOUT ou au
        # CHANGEMENT d'URL ; une entrée existante renvoyée telle quelle passe
        # (le blob entier est re-PUT à chaque préférence) mais n'est jamais
        # connectée (cf. ``personal_to_config``).
        if entry["type"] in HTTP_TYPES and not allow_stdio:
            _prev = old_by_id.get(str(srv.get("id")))
            _url = str(entry.get("url") or "")[:2000]
            if (_prev is None or str(_prev.get("url") or "") != _url):
                _why = personal_url_block_reason(_url)
                if _why:
                    raise UrlNotAllowed(
                        f"Adresse de serveur MCP refusée ({_why}) : les adresses "
                        f"internes (machine locale, réseau privé) sont réservées "
                        f"aux serveurs publiés par un administrateur.")
        mode = str(entry.get("auth_mode") or "").strip().lower()
        entry["auth_mode"] = mode if mode in AUTH_MODES else ""
        entry["name"] = str(entry.get("name") or "")[:120]
        for k in ("url", "command"):
            if k in entry:
                entry[k] = str(entry[k] or "")[:2000]
        entry["auth_user"] = str(entry.get("auth_user") or "")[:200]

        old = old_by_id.get(str(srv.get("id")))

        # ── Créneaux supplémentaires (chiffrés, jamais relus par le client) ──
        # Clé ABSENTE = « laisse en place » (un client d'une version antérieure
        # ne doit pas effacer ce qu'il ne sait pas afficher) ; clé PRÉSENTE =
        # la liste reçue fait autorité, y compris vide pour tout retirer.
        old_h, old_e = personal_pairs(old or {})
        new_h = (merge_pairs(old_h, srv.get("headers"), kind="headers")
                 if "headers" in srv else old_h)
        new_e = (merge_pairs(old_e, srv.get("env"), kind="env")
                 if "env" in srv else old_e)
        if entry["type"] not in HTTP_TYPES:
            new_h = []
        if entry["type"] != "stdio":
            new_e = []
        try:
            h_enc, h_scheme = _encode_pairs(new_h)
            e_enc, e_scheme = _encode_pairs(new_e)
        except Exception:
            # Chiffrement indisponible : on ne dégrade PAS en clair. La route
            # ``/settings`` lève déjà 503 sur le secret principal ; ici on se
            # contente de ne rien poser plutôt que d'écrire un jeton lisible.
            h_enc = e_enc = ""
            h_scheme = e_scheme = "plain"
        entry["headers_enc"] = h_enc
        entry["env_enc"] = e_enc
        entry["extra_scheme"] = (
            "fernet" if (h_scheme == "fernet" or e_scheme == "fernet") else "plain")

        # Mode ``header`` : le nom de l'en-tête EST la moitié du créneau. Vide →
        # défaut usuel ; invalide → l'auth est retirée plutôt que d'expédier le
        # jeton sous un nom que l'utilisateur n'a pas demandé (le badge « auth »
        # disparaît, ce qui rend la faute visible au lieu de la taire).
        if entry["auth_mode"] == "header":
            name = entry["auth_user"].strip() or DEFAULT_HEADER_NAME
            if header_name_ok(name):
                entry["auth_user"] = name
            else:
                entry["auth_mode"] = ""

        secret = str(srv.get("auth_secret") or "")
        if not entry["auth_mode"]:
            # « Aucune » PRIME sur un secret encore dans le payload : le v-if de
            # Vue démonte l'input sans vider son modèle (cf. update_shared).
            entry["auth_enc"], entry["key_scheme"] = "", "plain"
            entry["auth_user"] = ""
        elif secret:
            entry["auth_enc"], entry["key_scheme"] = _encode_secret(
                normalize_secret(entry["auth_mode"], secret))
        elif old and old.get("auth_enc"):
            entry["auth_enc"] = old["auth_enc"]
            entry["key_scheme"] = old.get("key_scheme") or "plain"
        elif old and (old.get("authorization") or old.get("basic_auth")):
            # Reprise paresseuse d'une entrée legacy jamais migrée.
            _legacy = _legacy_secret(old)
            if _legacy:
                entry["auth_enc"], entry["key_scheme"] = _encode_secret(_legacy)
                if old.get("basic_auth"):
                    entry.setdefault("auth_user", "")
                    entry["auth_user"] = str(
                        (old.get("basic_auth") or {}).get("username") or "")[:200]
            else:
                entry["auth_enc"], entry["key_scheme"] = "", "plain"
        else:
            entry["auth_enc"], entry["key_scheme"] = "", "plain"
        out.append(entry)
    return out


def client_builtin_ref(raw: Any) -> Optional[Dict[str, Any]]:
    """Entrée « outils locaux » reçue d'un client → sentinelle RECONSTRUITE.

    Du client, seuls le nom affiché et les catégories cochées sont repris ; le
    type, la commande et tout le reste sont posés ici. Avant le 2026-09-21, la
    route de chat recopiait l'entrée telle quelle dès que ``command`` valait la
    sentinelle : ``type: "sse"`` + ``url`` + ``headers`` faisaient ouvrir au
    backend une URL arbitraire (SSRF), ``type: "inprocess"`` + ``families``
    chargeait des familles retirées du manifeste. ``None`` si ce n'est pas une
    entrée d'outils locaux."""
    from shared_infra.mcp.manifest import BUILTIN_SENTINEL
    if not isinstance(raw, dict) or raw.get("command") != BUILTIN_SENTINEL:
        return None
    cfg: Dict[str, Any] = {
        "type": "stdio",
        "name": str(raw.get("name") or "Outils Locaux")[:120],
        "command": BUILTIN_SENTINEL,
    }
    cats = raw.get("filter_categories")
    if isinstance(cats, list):
        cfg["filter_categories"] = [c for c in cats if isinstance(c, str)][:64]
    return cfg


def _legacy_secret(srv: Dict[str, Any]) -> str:
    """Secret en clair d'une entrée perso d'avant migration."""
    b = srv.get("basic_auth")
    if isinstance(b, dict):
        return str(b.get("password") or b.get("token") or "")
    return str(srv.get("authorization") or "")


def resolve_personal(user_settings: Any, server_id: Any, *,
                     allow_stdio: bool = False) -> Optional[Dict[str, Any]]:
    """Config perso par id, déchiffrée. ``None`` si l'id est inconnu.

    Host-side : c'est ce qui remplace la confiance faite au client sur les
    configs qu'il envoie dans le payload de chat. ``allow_stdio`` : cf.
    ``personal_to_config`` (False pour un propriétaire non admin).
    """
    for srv in ((user_settings or {}).get("mcp_servers") or []):
        if isinstance(srv, dict) and str(srv.get("id")) == str(server_id):
            return personal_to_config(srv, allow_stdio=allow_stdio) or None
    return None


def resolve_for_agents(user_settings: Any, *,
                       allow_stdio: bool = False) -> List[Dict[str, Any]]:
    """Serveurs MCP qu'un agent CUSTOM peut référencer par ``mcp_server_ids``.

    = les serveurs PERSO de l'utilisateur (tels quels, y compris ceux qu'il a
    masqués du panneau : masquer est un choix d'affichage du chat, pas une
    dépublication) + ceux de la bibliothèque PARTAGÉE qu'il a choisi d'afficher,
    résolus AVEC leur authentification.

    Host-side uniquement : cette liste alimente ``build_task_builtin_tool`` et
    ne repart JAMAIS vers le navigateur. Définition UNIQUE — la route de chat et
    le scheduler de routines doivent voir exactement les mêmes serveurs, sinon
    le même agent custom n'a pas la même surface selon qui le lance.
    """
    own = [c for c in (personal_to_config(s, allow_stdio=allow_stdio)
                       for s in ((user_settings or {}).get("mcp_servers") or [])
                       if isinstance(s, dict)) if c]
    visible = (user_settings or {}).get("shared_mcp_visible") or []
    return own + resolve_many(visible)
