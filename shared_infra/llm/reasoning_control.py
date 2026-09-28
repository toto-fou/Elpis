# SPDX-License-Identifier: MIT
"""
shared_infra.llm.reasoning_control — quelle complétion est en train de RAISONNER,
pour une conversation donnée.

Sert au bouton « Répondre maintenant ». Depuis llama-server b10545, couper un
raisonnement en cours ne demande plus de tout relancer : il suffit d'un
``POST /v1/chat/completions/control {id, action:"reasoning_end"}`` — le modèle
sort du bloc de raisonnement et rédige sa réponse DANS LE FLUX EN COURS.

Encore faut-il connaître le ``id`` de la complétion. Il n'existe que dans le
worker qui streame, et le clic du bouton peut atterrir sur n'importe lequel des
workers gunicorn. Deux options se présentaient :

  * le renvoyer au navigateur et le laisser le reposter — mais c'est un
    identifiant du MOTEUR, qui n'authentifie personne : le faire traverser la
    frontière de confiance pour une commodité d'implémentation ne se justifie
    pas ;
  * le déposer dans un petit magasin partagé — c'est ce qui est fait ici.

La clé est la CONVERSATION seule, pas le couple (utilisateur, conversation) :
le harnais ne connaît que le nom d'utilisateur, la route ne connaît que son
identifiant numérique, et faire correspondre les deux ici serait une source
d'erreur silencieuse. L'autorisation est faite là où elle doit l'être — la
route vérifie que la conversation appartient bien à l'appelant (``get_chat``)
avant d'agir.

Une écriture par TOUR au plus (au premier token de raisonnement), pas par
token. Le fichier est nommé par un condensé : ni identifiant de conversation
ni nom d'utilisateur en clair dans ``/tmp``.

Best-effort de bout en bout : sans magasin utilisable, le bouton retombe sur
son comportement historique (annuler puis relancer avec le raisonnement en
préfixe), qui reste correct — juste plus coûteux.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, Optional

from shared_infra.runtime.runtime_dir import runtime_path

logger = logging.getLogger("uvicorn.error")

# Au-delà, l'entrée est considérée périmée : une complétion terminée ne peut
# plus être contrôlée (le moteur répond alors « aucune correspondance »), et on
# évite d'agir sur un tour qui n'existe plus.
ENTRY_TTL_S = 900.0

DIR = runtime_path("reasoning_ctl", "ELPIS_REASONING_CTL_DIR",
                   "/tmp/elpis_reasoning_ctl")


def _path(chat_id: str) -> Path:
    from shared_infra.config import SESSION_SECRET
    h = hashlib.sha256(
        f"{SESSION_SECRET}:{chat_id}".encode("utf-8", "replace")).hexdigest()[:24]
    return Path(DIR) / f"{h}.json"


def note_completion(chat_id: str, completion_id: str,
                    model: str = "", engine_key: str = "builtin") -> None:
    """Déclare la complétion en cours pour ce chat (écriture atomique).

    ``engine_key`` (AUDIT 2026-09-16) : serveur qui porte la complétion
    (``builtin`` | ``conn:<id>``). Sans lui, « Répondre maintenant » visait
    toujours l'intégré — un tour sur un connecteur llama.cpp n'avait aucune
    prise. Jamais de secret ici : la route re-résout le serveur (et son
    en-tête d'auth) à partir de la clé, pour l'appelant authentifié."""
    if not chat_id or not completion_id:
        return
    try:
        os.makedirs(str(DIR), mode=0o700, exist_ok=True)
        p = _path(chat_id)
        tmp = p.with_suffix(".tmp")
        payload = {"completion_id": str(completion_id), "model": str(model or ""),
                   "engine_key": str(engine_key or "builtin"), "ts": time.time()}
        with open(os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600),
                  "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
        os.replace(str(tmp), str(p))
    except Exception as e:
        logger.debug("[reasoning_ctl] écriture impossible : %s", str(e)[:120])


def get_completion(chat_id: str) -> Optional[Dict[str, Any]]:
    """Complétion en cours pour ce chat, ou ``None`` (absente ou périmée)."""
    if not chat_id:
        return None
    try:
        p = _path(chat_id)
        if not p.exists():
            return None
        data = json.loads(p.read_text(encoding="utf-8"))
        if (time.time() - float(data.get("ts") or 0)) > ENTRY_TTL_S:
            return None
        return data if data.get("completion_id") else None
    except Exception:
        return None


def clear_completion(chat_id: str) -> None:
    try:
        _path(chat_id).unlink(missing_ok=True)
    except Exception:
        pass
