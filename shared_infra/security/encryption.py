# SPDX-License-Identifier: MIT
"""
shared_infra.security.encryption — Chiffrement symétrique au repos (Fernet).

Sert à chiffrer les **clés API des connecteurs LLM** (Anthropic / OpenAI / …)
avant stockage en base. Cf. ``shared_infra/llm/connectors.py``.

Résolution de la clé maître (même esprit que ``SESSION_SECRET`` dans
``config.py``), par ordre de priorité :

  1. Env var ``APP_ENCRYPTION_KEY``   → posée par le startup avant le fork
     gunicorn ⇒ identique pour tous les workers (approche préférée en prod).
  2. ``config.json › app.encryption_key``  → config explicite de l'admin.
  3. Fichier dédié ``<user_db>/.encryption_key``  → fallback (uvicorn seul,
     tests). Créé une seule fois avec verrou ``fcntl`` (anti-race workers).

La valeur fournie en 1/2 peut être :
  - une clé Fernet valide (44 chars base64 urlsafe) → utilisée telle quelle ;
  - n'importe quelle chaîne secrète → on en **dérive** une clé Fernet
    déterministe (``urlsafe_b64encode(sha256(secret))``) pour que l'opérateur
    n'ait pas à générer un format précis.

INVARIANT : si AUCUNE clé ne peut être résolue NI créée (FS read-only sans env/
config), ``encrypt`` lève ``EncryptionUnavailable`` — la couche DB refuse alors
d'écrire un secret plutôt que de le stocker en clair par accident.
"""
from __future__ import annotations

import base64
import hashlib
import logging
import os
import threading
from pathlib import Path
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken

from shared_infra.config import _RAW, DB_PATH, _as_str, _deep_get  # type: ignore

logger = logging.getLogger("uvicorn.error")


class EncryptionUnavailable(RuntimeError):
    """Aucune clé maître résolvable/créable — refuser d'écrire un secret."""


_KEY_FILE = Path(DB_PATH).parent / ".encryption_key"
_KEY_LOCK = Path(DB_PATH).parent / ".encryption_key.lock"

_cipher: Optional[Fernet] = None
_cipher_lock = threading.Lock()
_resolved = False  # True une fois la résolution tentée (succès OU échec définitif)


def _derive_fernet_key(secret: str) -> bytes:
    """Toute chaîne → clé Fernet déterministe (32 octets b64 urlsafe)."""
    digest = hashlib.sha256(secret.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest)


def _coerce_to_fernet_key(value: str) -> bytes:
    """Accepte une clé Fernet déjà valide, sinon dérive depuis la chaîne."""
    raw = value.strip()
    try:
        # Une clé Fernet valide est acceptée telle quelle par le constructeur.
        Fernet(raw.encode("ascii"))
        return raw.encode("ascii")
    except (ValueError, TypeError):
        return _derive_fernet_key(raw)


def _load_or_create_key() -> Optional[bytes]:
    """Résout la clé maître selon l'ordre de priorité documenté.

    Retourne la clé Fernet (bytes) ou ``None`` si elle ne peut être ni lue ni
    créée (FS read-only sans env/config)."""
    # 1. Env var
    env_val = _as_str(os.environ.get("APP_ENCRYPTION_KEY"), "")
    if env_val:
        return _coerce_to_fernet_key(env_val)

    # 2. config.json
    json_val = _as_str(_deep_get(_RAW, "app.encryption_key", ""), "")
    if json_val:
        return _coerce_to_fernet_key(json_val)

    # 3. Fichier dédié (fast path : lecture sans lock)
    try:
        s = _KEY_FILE.read_text().strip()
        if s:
            return _coerce_to_fernet_key(s)
    except (FileNotFoundError, OSError):
        pass

    # Slow path : génération avec verrou exclusif (premier démarrage).
    try:
        _KEY_FILE.parent.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        logger.critical(
            "[encryption] Impossible de créer %s pour persister la clé de "
            "chiffrement (%s) — les secrets des connecteurs LLM ne pourront "
            "PAS être stockés. Définir APP_ENCRYPTION_KEY dans l'environnement.",
            _KEY_FILE.parent, e,
        )
        return None

    try:
        import fcntl
        with open(_KEY_LOCK, "w") as lf:
            fcntl.flock(lf.fileno(), fcntl.LOCK_EX)
            try:
                # Re-vérifier après le lock (un autre process l'a peut-être créé).
                try:
                    s = _KEY_FILE.read_text().strip()
                    if s:
                        return _coerce_to_fernet_key(s)
                except (FileNotFoundError, OSError):
                    pass
                key = Fernet.generate_key()  # 44 chars b64 urlsafe
                tmp = _KEY_FILE.with_suffix(".tmp")
                tmp.write_bytes(key)
                try:
                    tmp.chmod(0o600)
                except Exception:
                    pass
                tmp.replace(_KEY_FILE)
                return key
            finally:
                fcntl.flock(lf.fileno(), fcntl.LOCK_UN)
    except Exception as e:
        logger.critical(
            "[encryption] Échec d'écriture de la clé de chiffrement dans %s : "
            "%s. Les clés API des connecteurs LLM ne seront pas stockables. "
            "Définir APP_ENCRYPTION_KEY explicitement.",
            _KEY_FILE, e,
        )
        return None


def _get_cipher() -> Optional[Fernet]:
    """Cipher Fernet mémoïsé (résolution paresseuse, thread-safe)."""
    global _cipher, _resolved
    if _resolved:
        return _cipher
    with _cipher_lock:
        if _resolved:
            return _cipher
        key = _load_or_create_key()
        _cipher = Fernet(key) if key else None
        _resolved = True
        return _cipher


def encrypt(plaintext: str) -> str:
    """Chiffre une chaîne → token Fernet (urlsafe str).

    Lève ``EncryptionUnavailable`` si aucune clé maître n'est disponible."""
    cipher = _get_cipher()
    if cipher is None:
        raise EncryptionUnavailable(
            "Clé de chiffrement indisponible — définir APP_ENCRYPTION_KEY."
        )
    return cipher.encrypt((plaintext or "").encode("utf-8")).decode("ascii")


def decrypt(token: str) -> str:
    """Déchiffre un token Fernet. Retourne '' sur token invalide/clé absente."""
    cipher = _get_cipher()
    if cipher is None:
        return ""
    try:
        return cipher.decrypt((token or "").encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError, TypeError):
        logger.warning("[encryption] token Fernet invalide (clé tournée ?)")
        return ""
