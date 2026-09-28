# SPDX-License-Identifier: MIT
"""
shared_infra.llm.connectors — CRUD des Connecteurs LLM.

Permet de router le chat vers d'autres backends que l'unique llama-server global.

Portées (``scope``) :
  - ``user``   : connecteur perso (``owner_user_id`` renseigné) — clé API propre.
  - ``shared`` : connecteur partagé géré par l'admin (``owner_user_id`` NULL) —
                 typiquement un backend local (llama.cpp / vLLM) visible par tous.

INVARIANT DE SÉCURITÉ : la clé API n'est JAMAIS renvoyée par les fonctions
exposées aux routes (``list_*`` / ``get_*`` publiques → ``_public`` = ``has_key``
seulement). Seuls ``get_*_secret`` — appelés host-side (résolution du target,
test de connexion) — renvoient la clé déchiffrée, et ne sont jamais sérialisés
vers HTTP.

Clés chiffrées au repos via Fernet (``shared_infra/security/encryption.py``,
``key_scheme='fernet'``). ``'plain'`` reste géré en lecture (legacy / FS sans clé).
"""
from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from shared_infra.db._connection import db_conn
from shared_infra.db._dialect import insert_id
from shared_infra.security.encryption import decrypt, encrypt

# Types de provider supportés (l'UI propose ce menu).
PROVIDER_TYPES = (
    "llamacpp", "vllm", "openai", "anthropic",
    "mistral", "groq", "openrouter", "deepseek", "moonshot", "opencode", "generic",
)

# Métadonnées par provider (source unique pour routes + frontend) :
#   wire             : format « wire » (openai-compatible vs anthropic natif)
#   base_url         : URL par défaut (verrouillée pour les connecteurs USER)
#   label            : libellé UI
#   admin_only       : réservé aux connecteurs PARTAGÉS (base_url libre interne)
#   user_base_locked : si True, l'utilisateur ne saisit PAS la base_url (preset
#                      officiel) → pas de fetch arbitraire (anti-SSRF côté user)
PROVIDER_PRESETS = {
    "anthropic":  {"wire": "anthropic", "base_url": "https://api.anthropic.com",   "label": "Anthropic (Claude)",        "admin_only": False, "user_base_locked": True},
    "openai":     {"wire": "openai",    "base_url": "https://api.openai.com/v1",    "label": "OpenAI (GPT)",              "admin_only": False, "user_base_locked": True},
    "mistral":    {"wire": "openai",    "base_url": "https://api.mistral.ai/v1",    "label": "Mistral",                   "admin_only": False, "user_base_locked": True},
    "groq":       {"wire": "openai",    "base_url": "https://api.groq.com/openai/v1","label": "Groq",                     "admin_only": False, "user_base_locked": True},
    "openrouter": {"wire": "openai",    "base_url": "https://openrouter.ai/api/v1", "label": "OpenRouter",                "admin_only": False, "user_base_locked": True},
    "deepseek":   {"wire": "openai",    "base_url": "https://api.deepseek.com/v1",  "label": "DeepSeek",                  "admin_only": False, "user_base_locked": True},
    # Plateforme internationale (platform.moonshot.ai). Les clés créées sur la
    # plateforme Chine (platform.moonshot.cn) ne marchent PAS ici → connecteur
    # partagé « generic » admin avec base .cn dans ce cas.
    "moonshot":   {"wire": "openai",    "base_url": "https://api.moonshot.ai/v1",   "label": "Moonshot (Kimi)",           "admin_only": False, "user_base_locked": True},
    # OpenCode Zen (2026-09-12) — passerelle du projet opencode, compatible
    # OpenAI. ⚠ VÉRIFIÉ avec une clé réelle : son offre GRATUITE (modèles
    # suffixés ``-free``) est RÉSERVÉE au client opencode — appelée d'ici, elle
    # répond 400 « OpenCode's free tier can only be used in OpenCode ». Ce
    # connecteur ne vaut donc que pour les modèles qu'ouvre une clé payante ;
    # c'est le message d'erreur du fournisseur, remonté tel quel à
    # l'utilisateur (cf. ``_llm_retry.provider_message``), qui le dit.
    "opencode":   {"wire": "openai",    "base_url": "https://opencode.ai/zen/v1",   "label": "OpenCode Zen",              "admin_only": False, "user_base_locked": True},
    "llamacpp":   {"wire": "openai",    "base_url": "",                             "label": "llama.cpp (local)",         "admin_only": True,  "user_base_locked": False},
    "vllm":       {"wire": "openai",    "base_url": "",                             "label": "vLLM (local)",              "admin_only": True,  "user_base_locked": False},
    "generic":    {"wire": "openai",    "base_url": "",                             "label": "OpenAI-compatible (custom)","admin_only": True,  "user_base_locked": False},
}


def cloud_provider_types() -> list:
    """Types ajoutables par un UTILISATEUR (base_url verrouillée par preset)."""
    return [p for p, v in PROVIDER_PRESETS.items() if not v.get("admin_only")]


def allowed_provider_types(cfg: "Optional[Dict[str, Any]]" = None) -> list:
    """Fournisseurs ouverts aux connecteurs PERSO (``llm.allowed_provider_types``
    de config.json ; liste vide ou absente = tous les fournisseurs cloud).

    SOURCE UNIQUE : la route de création ET la résolution de cible passent par
    ici — sans quoi retirer un fournisseur de la liste empêchait d'en créer un
    nouveau mais laissait servir ceux déjà créés (AUDIT 2026-09-16, A8). La
    route fournit la config qu'elle a déjà lue ; les autres appelants la
    laissent lire ici."""
    if cfg is None:
        try:
            from shared_infra.config import read_config_json
            cfg = read_config_json() or {}
        except Exception:                                       # noqa: BLE001
            return cloud_provider_types()
    val = ((cfg.get("llm") or {}).get("allowed_provider_types"))
    if isinstance(val, list) and val:
        return [p for p in val if p in PROVIDER_PRESETS]
    return cloud_provider_types()


# ── Clé API : chiffrement (fernet) avec repli lecture 'plain' ─────────────────
def _encode_key(api_key: str) -> tuple[str, str]:
    """(api_key_enc, scheme) à stocker. Vide → ('', 'plain'). Sinon Fernet.

    Lève ``EncryptionUnavailable`` (propagée) si la clé maître est indisponible
    et qu'on tente d'écrire un secret — la route refuse alors plutôt que de
    stocker en clair."""
    if not api_key:
        return "", "plain"
    return encrypt(api_key), "fernet"


def _decode_key(api_key_enc: str, scheme: str) -> str:
    if not api_key_enc:
        return ""
    if scheme == "fernet":
        return decrypt(api_key_enc)
    return api_key_enc  # 'plain' / legacy


_PUBLIC_COLS = ("id", "owner_user_id", "scope", "provider_type", "wire",
                "label", "base_url", "default_model", "models_json", "enabled",
                "key_scheme", "created_at", "updated_at", "last_used")
# Réglages de capacité (migration 0019). Lus à part : une ligne issue d'une base
# pas encore migrée ne doit pas faire échouer toute la vue publique.
_LIMIT_COLS = ("context_window", "max_models", "max_concurrency")


def _limits_of(row) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    keys = set(row.keys()) if hasattr(row, "keys") else set()
    for k in _LIMIT_COLS:
        v = row[k] if k in keys else None
        try:
            out[k] = int(v) if v is not None and int(v) > 0 else None
        except (TypeError, ValueError):
            out[k] = None
    return out


def _public(row) -> Dict[str, Any]:
    """Vue SANS clé (réponses HTTP)."""
    d = {k: row[k] for k in _PUBLIC_COLS}
    d["has_key"] = bool(row["api_key_enc"])
    d["enabled"] = bool(row["enabled"])
    d.update(_limits_of(row))
    return d


def _with_key(row) -> Dict[str, Any]:
    """Vue AVEC clé déchiffrée (host-side uniquement — jamais sérialisée HTTP)."""
    d = {k: row[k] for k in _PUBLIC_COLS}
    d["enabled"] = bool(row["enabled"])
    d.update(_limits_of(row))
    d["api_key"] = _decode_key(row["api_key_enc"], row["key_scheme"])
    return d


# ── Lectures publiques (token-free) ───────────────────────────────────────────
def list_user_connectors(owner_user_id: int) -> List[Dict[str, Any]]:
    """Connecteurs perso de ce user (scope='user')."""
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT * FROM llm_connectors WHERE owner_user_id=? AND scope='user' "
            "ORDER BY label ASC, id ASC", (owner_user_id,))
        return [_public(r) for r in cur.fetchall()]


def list_shared_connectors() -> List[Dict[str, Any]]:
    """Connecteurs partagés (admin), visibles par tous."""
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT * FROM llm_connectors WHERE scope='shared' "
            "ORDER BY label ASC, id ASC")
        return [_public(r) for r in cur.fetchall()]


def get_meta(connector_id: int) -> Optional[Dict[str, Any]]:
    """Vue publique (SANS clé) d'un connecteur, quelle que soit sa portée.

    Réservé aux lectures host-side de réglages (fenêtre de contexte, capacité
    d'ordonnancement) : n'expose rien qu'une route ne renvoie déjà, et ne
    contrôle PAS l'accès — l'appelant a déjà résolu la cible pour ce user."""
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT * FROM llm_connectors WHERE id=?", (int(connector_id),))
        r = cur.fetchone()
        return _public(r) if r else None


# ── Écritures ─────────────────────────────────────────────────────────────────
def create_connector(*, scope: str, provider_type: str, wire: str,
                     owner_user_id: Optional[int] = None, base_url: str = "",
                     api_key: str = "", label: str = "", default_model: str = "",
                     models_json: str = "", enabled: bool = True,
                     context_window: Optional[int] = None,
                     max_models: Optional[int] = None,
                     max_concurrency: Optional[int] = None) -> int:
    key_enc, key_scheme = _encode_key(api_key)
    now = time.time()
    cols = ["owner_user_id", "scope", "provider_type", "wire", "label", "base_url",
            "api_key_enc", "key_scheme", "default_model", "models_json", "enabled",
            "created_at", "updated_at"]
    vals: List[Any] = [owner_user_id, scope, provider_type, wire, label or "",
                       base_url or "", key_enc, key_scheme, default_model or "",
                       models_json or "", 1 if enabled else 0, now, now]
    # Réglages de capacité (0019) écrits seulement s'ils sont fournis : une
    # création sans eux reste valide sur un schéma antérieur à la migration.
    for k, v in (("context_window", context_window), ("max_models", max_models),
                 ("max_concurrency", max_concurrency)):
        if _pos_or_none(v) is not None:
            cols.append(k)
            vals.append(_pos_or_none(v))
    with db_conn() as conn:
        cur = conn.cursor()
        new_id = insert_id(
            cur,
            f"INSERT INTO llm_connectors({', '.join(cols)}) "
            f"VALUES({', '.join('?' for _ in cols)})", tuple(vals))
        conn.commit()
        return new_id


def _pos_or_none(v) -> Optional[int]:
    """Entier > 0, sinon ``None`` (= découverte automatique)."""
    try:
        n = int(v)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def _update(connector_id: int, where_extra: str, where_vals: tuple,
            fields: Dict[str, Any]) -> bool:
    """Coeur partagé des updates (gating fourni par l'appelant)."""
    sets: List[str] = []
    vals: List[Any] = []
    for k in ("provider_type", "wire", "label", "base_url", "default_model", "models_json"):
        if fields.get(k) is not None:
            sets.append(f"{k}=?")
            vals.append(fields[k])
    if fields.get("enabled") is not None:
        sets.append("enabled=?")
        vals.append(1 if fields["enabled"] else 0)
    # Réglages de capacité : présents ⇒ écrits, y compris l'effacement (0 ou
    # vide ⇒ NULL = retour à la découverte automatique).
    for k in _LIMIT_COLS:
        if k in fields:
            sets.append(f"{k}=?")
            vals.append(_pos_or_none(fields[k]))
    key = fields.get("api_key")
    if key:                                    # non-vide → on remplace la clé
        key_enc, key_scheme = _encode_key(key)
        sets += ["api_key_enc=?", "key_scheme=?"]
        vals += [key_enc, key_scheme]
    if not sets:
        return False
    sets.append("updated_at=?")
    vals.append(time.time())
    vals.append(connector_id)
    vals += list(where_vals)
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute(f"UPDATE llm_connectors SET {', '.join(sets)} "
                    f"WHERE id=? {where_extra}", vals)
        conn.commit()
        return cur.rowcount > 0


def update_user_connector(owner_user_id: int, connector_id: int, **fields) -> bool:
    return _update(connector_id, "AND owner_user_id=? AND scope='user'",
                   (owner_user_id,), fields)


def update_shared_connector(connector_id: int, **fields) -> bool:
    return _update(connector_id, "AND scope='shared'", (), fields)


def delete_user_connector(owner_user_id: int, connector_id: int) -> bool:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM llm_connectors WHERE id=? AND owner_user_id=? AND scope='user'",
                    (connector_id, owner_user_id))
        conn.commit()
        return cur.rowcount > 0


def delete_shared_connector(connector_id: int) -> bool:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM llm_connectors WHERE id=? AND scope='shared'",
                    (connector_id,))
        conn.commit()
        return cur.rowcount > 0


# ── Résolution host-side (clé INCLUSE — jamais sérialisée HTTP) ───────────────
def get_secret_for_user(user_id: int, connector_id: int) -> Optional[Dict[str, Any]]:
    """Connecteur utilisable par ce user (perso OU partagé) AVEC clé déchiffrée.

    Sert ``resolve_llm_target`` au moment du chat. Ne JAMAIS sérialiser HTTP."""
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT * FROM llm_connectors WHERE id=? AND "
            "(scope='shared' OR (scope='user' AND owner_user_id=?))",
            (connector_id, user_id))
        r = cur.fetchone()
        return _with_key(r) if r else None


def get_user_secret(owner_user_id: int, connector_id: int) -> Optional[Dict[str, Any]]:
    """Connecteur perso AVEC clé (test de connexion côté user)."""
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT * FROM llm_connectors WHERE id=? AND owner_user_id=? AND scope='user'",
            (connector_id, owner_user_id))
        r = cur.fetchone()
        return _with_key(r) if r else None


def get_shared_secret(connector_id: int) -> Optional[Dict[str, Any]]:
    """Connecteur partagé AVEC clé (test de connexion côté admin)."""
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT * FROM llm_connectors WHERE id=? AND scope='shared'",
                    (connector_id,))
        r = cur.fetchone()
        return _with_key(r) if r else None


def bump_last_used(connector_id: int) -> None:
    """Best-effort (jamais bloquant)."""
    try:
        with db_conn() as conn:
            conn.execute("UPDATE llm_connectors SET last_used=? WHERE id=?",
                         (time.time(), connector_id))
            conn.commit()
    except Exception:
        pass
