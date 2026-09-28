# SPDX-License-Identifier: MIT
"""
shared_infra/sandbox/preview_token.py — jeton d'URL de l'aperçu « Web ».

Audit 2026-09-22 (H1). L'aperçu montait les fichiers de la sandbox sur
l'ORIGINE de l'app, sans isolation : un ``.html`` écrit par l'agent ou venu
d'un dépôt cloné tournait avec la session de celui qui l'ouvrait. Le remède
est une origine opaque (``CSP: sandbox`` + iframe ``sandbox``) — mais un
document à origine opaque n'envoie PLUS le cookie de session à ses
sous-ressources (vérifié Chromium et Firefox, cookie ``SameSite=Lax``) : CSS,
JS et ``fetch`` relatifs tombaient en 401.

L'identité voyage donc dans le CHEMIN : ``/api/sandbox/pv/<jeton>/<fichier>``.
Les références relatives héritent du préfixe, jeton compris. Le jeton ne
donne que ce que la page en aperçu a déjà : lire la sandbox de son
propriétaire et joindre ses serveurs d'aperçu, pendant ``TTL_S``. Jamais la
session, ni l'API.
"""
from __future__ import annotations

import hashlib
import hmac
import time
from typing import Optional

TTL_S = 3600


def _key() -> bytes:
    from shared_infra.config import SESSION_SECRET
    return hashlib.sha256(b"elpis-preview-token\0" + str(SESSION_SECRET).encode()).digest()


def _sig(body: str) -> str:
    return hmac.new(_key(), body.encode(), hashlib.sha256).hexdigest()[:32]


def make_preview_token(user_id: int, ttl: int = TTL_S) -> tuple:
    """``(jeton, expiration epoch)``."""
    exp = int(time.time()) + int(ttl)
    body = f"{int(user_id)}-{exp}"
    return f"{body}-{_sig(body)}", exp


def check_preview_token(token: str) -> Optional[int]:
    """Identifiant utilisateur du jeton, ou ``None`` (forme, signature, expiré)."""
    try:
        uid_s, exp_s, sig = str(token).split("-")
        body = f"{int(uid_s)}-{int(exp_s)}"
    except (ValueError, TypeError):
        return None
    if not hmac.compare_digest(sig, _sig(body)) or int(exp_s) < time.time():
        return None
    return int(uid_s)


__all__ = ["TTL_S", "make_preview_token", "check_preview_token"]
