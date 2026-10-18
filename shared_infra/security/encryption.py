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
     tests). Créé une seule fois sous le verrou ``elpis.verrou.v1.1``
     ``.encryption_key.lock`` et publié par lien exclusif (la première clé
     posée gagne, y compris face au core TypeScript).

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
import tempfile
import threading
import time
from pathlib import Path
from typing import Optional, Tuple

from cryptography.fernet import Fernet, InvalidToken

from shared_infra.config import _RAW, DB_PATH, _as_str, _deep_get  # type: ignore

logger = logging.getLogger("uvicorn.error")


class EncryptionUnavailable(RuntimeError):
    """Aucune clé maître résolvable/créable — refuser d'écrire un secret."""


_KEY_FILE = Path(DB_PATH).parent / ".encryption_key"
_KEY_LOCK = Path(DB_PATH).parent / ".encryption_key.lock"
_ATTENTE_ECRITURE_S = 1.0

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


def _lire_cle() -> Tuple[bool, Optional[str]]:
    """(présent, contenu) : seuls ENOENT et ENOTDIR valent absence ; contenu ``None`` si illisible."""
    try:
        return True, _KEY_FILE.read_text().strip()
    except (FileNotFoundError, NotADirectoryError):
        return False, None
    except (OSError, UnicodeDecodeError):
        return True, None


def _relire_sous_verrou() -> Tuple[bool, Optional[str]]:
    """Relecture sous le verrou ; un fichier présent mais vide peut être en cours d'écriture : 1 s de patience."""
    fin = time.monotonic() + _ATTENTE_ECRITURE_S
    present, s = _lire_cle()
    while present and not s and time.monotonic() < fin:
        time.sleep(0.05)
        present, s = _lire_cle()
    return present, s


def _cle_inutilisable() -> None:
    logger.critical(
        "[encryption] %s est présent mais vide ou illisible : il n'est PAS remplacé (les secrets "
        "chiffrés avec lui seraient perdus). Corriger ses droits ou le restaurer, ou définir "
        "APP_ENCRYPTION_KEY.", _KEY_FILE)


def _fsync_dossier(dossier: Path) -> None:
    """Rend durable une entrée de dossier (lien, création) ; sans effet là où c'est impossible."""
    try:
        fd = os.open(dossier, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _ecrire_exclusif(key: bytes) -> bool:
    """Création exclusive du fichier de clé (système sans liens durs) ; faux s'il existe ; jamais laissé vide."""
    try:
        fd = os.open(_KEY_FILE, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        return False
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(key)
            fh.flush()
            os.fsync(fh.fileno())
    except BaseException:
        _KEY_FILE.unlink(missing_ok=True)
        raise
    _fsync_dossier(_KEY_FILE.parent)
    return True


def _publish_key(tmp: Path, key: bytes) -> Optional[bytes]:
    """Publication exclusive : une clé posée entre-temps l'emporte ; un fichier vide ou illisible reste en place."""
    try:
        try:
            os.link(tmp, _KEY_FILE)
            _fsync_dossier(_KEY_FILE.parent)
            return key
        except FileExistsError:
            pass
        except OSError:
            if _ecrire_exclusif(key):
                return key
    finally:
        tmp.unlink(missing_ok=True)
    present, autre = _lire_cle()
    if present and autre:
        return _coerce_to_fernet_key(autre)
    _cle_inutilisable()
    return None


def _load_or_create_key() -> Optional[bytes]:
    """Résout la clé maître (environnement, config.json, fichier) ; ne la crée que si le fichier est absent."""
    env_val = _as_str(os.environ.get("APP_ENCRYPTION_KEY"), "")
    if env_val:
        return _coerce_to_fernet_key(env_val)
    json_val = _as_str(_deep_get(_RAW, "app.encryption_key", ""), "")
    if json_val:
        return _coerce_to_fernet_key(json_val)
    present, s = _lire_cle()
    if present and s:
        return _coerce_to_fernet_key(s)
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
        from shared_infra.runtime.verrou_fichier import VerrouFichier
        with VerrouFichier(_KEY_LOCK):
            present, s = _relire_sous_verrou()
            if present:
                if s:
                    return _coerce_to_fernet_key(s)
                _cle_inutilisable()
                return None
            key = Fernet.generate_key()
            fd, nom = tempfile.mkstemp(dir=str(_KEY_FILE.parent), prefix=".encryption_key.", suffix=".tmp")
            tmp = Path(nom)
            try:
                with os.fdopen(fd, "wb") as fh:
                    fh.write(key)
                    fh.flush()
                    os.fsync(fh.fileno())
                return _publish_key(tmp, key)
            finally:
                tmp.unlink(missing_ok=True)
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
