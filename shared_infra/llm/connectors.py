# SPDX-License-Identifier: MIT
"""shared_infra/llm/connectors.py — connecteurs LLM (liste des partagés, création, mise à jour) pour l'installation ; la clé API est chiffrée au repos (Fernet, ``key_scheme='fernet'``) et n'est jamais renvoyée par ``_public`` (``has_key`` seulement)."""
from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from shared_infra.db._connection import db_conn
from shared_infra.db._dialect import insert_id
from shared_infra.security.encryption import encrypt

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


# ── Clé API : chiffrement (fernet) avec repli lecture 'plain' ─────────────────
def _encode_key(api_key: str) -> tuple[str, str]:
    """(api_key_enc, scheme) à stocker. Vide → ('', 'plain'). Sinon Fernet.

    Lève ``EncryptionUnavailable`` (propagée) si la clé maître est indisponible
    et qu'on tente d'écrire un secret — la route refuse alors plutôt que de
    stocker en clair."""
    if not api_key:
        return "", "plain"
    return encrypt(api_key), "fernet"


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


def list_shared_connectors() -> List[Dict[str, Any]]:
    """Connecteurs partagés (admin), visibles par tous."""
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT * FROM llm_connectors WHERE scope='shared' "
            "ORDER BY label ASC, id ASC")
        return [_public(r) for r in cur.fetchall()]


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


def update_shared_connector(connector_id: int, **fields) -> bool:
    return _update(connector_id, "AND scope='shared'", (), fields)


