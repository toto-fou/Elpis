# SPDX-License-Identifier: MIT
"""Champs « image » des messages du chat, assainis à chaque aller-retour.

Le client renvoie tout l'historique à chaque tour : ce qui revient dans ces
champs est du contenu CLIENT. On ne garde que les champs connus, bornés, et
l'URL d'une image est toujours reconstruite depuis son id — jamais une adresse
arbitraire qu'un rechargement ferait charger.

    message user       ``image_request``  options de la demande (Régénérer
                                          après rechargement, Variantes)
    message assistant  ``generated_images`` / ``tool_images``  références
                       ``revised_prompt``   description enrichie utilisée
                       ``image_meta``       modèle et durée (pied de carte)
                       ``image_error``      échec : code, message, réessayable

La légende persistée (:func:`caption`) est aussi ce que le modèle lit aux tours
suivants à la place de l'image : jamais les octets.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from shared_infra.image.store import url_for, valid_id

MAX_REFS = 32
_CAPTION_PROMPT_MAX = 300
_ERROR_CODES = ("unavailable", "forbidden", "invalid", "timeout", "busy", "refused",
                "engine", "cancelled", "too_large")
# Champs du message assistant qui portent des images (live et rechargement).
MESSAGE_FIELDS = ("generated_images", "tool_images", "revised_prompt", "image_meta",
                  "image_error")


def caption(prompt: str, n: int) -> str:
    """Légende persistée : le fil la montre sous l'image, le modèle la lit aux
    tours suivants à la place de l'image."""
    p = " ".join((prompt or "").split())
    if len(p) > _CAPTION_PROMPT_MAX:
        p = p[:_CAPTION_PROMPT_MAX].rstrip() + "…"
    head = "Image générée" if n <= 1 else f"{n} images générées"
    return f"[{head} : « {p} »]"


def failure_caption(message: str) -> str:
    return f"[Échec de la génération d'image : {message}]"


def _entier(v: Any) -> Optional[int]:
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def sanitize_refs(value: Any) -> List[Dict[str, Any]]:
    """Références d'images venues du client : champs connus, URL refaites."""
    out: List[Dict[str, Any]] = []
    if not isinstance(value, list):
        return out
    for item in value[:MAX_REFS]:
        if not isinstance(item, dict) or not valid_id(item.get("id")):
            continue
        iid = item["id"]
        ref: Dict[str, Any] = {"id": iid, "url": url_for(iid), "thumb_url": url_for(iid, thumb=True)}
        for k in ("width", "height", "seed"):
            v = _entier(item.get(k))
            if v is not None:
                ref[k] = v
        mime = item.get("mime")
        if isinstance(mime, str) and mime in ("image/png", "image/jpeg", "image/webp"):
            ref["mime"] = mime
        out.append(ref)
    return out


def sanitize_request(value: Any) -> Optional[Dict[str, Any]]:
    """Options d'un message « Images » (demande de l'utilisateur)."""
    if not isinstance(value, dict):
        return None
    out: Dict[str, Any] = {}
    size = str(value.get("size") or "")[:16]
    if size:
        out["size"] = size
    for k in ("n", "seed", "steps", "side"):
        v = _entier(value.get(k))
        if v is not None:
            out[k] = v
    ratio = value.get("ratio")
    if isinstance(ratio, str) and 0 < len(ratio) <= 8:
        out["ratio"] = ratio
    neg = value.get("negative_prompt")
    if isinstance(neg, str) and neg.strip():
        out["negative_prompt"] = neg.strip()[:2000]
    if value.get("enhance") is True:
        out["enhance"] = True
    st = value.get("strength")
    if isinstance(st, (int, float)) and not isinstance(st, bool) and 0.05 <= st <= 1.0:
        out["strength"] = round(float(st), 2)
    if valid_id(value.get("ref_image_id")):
        out["ref_image_id"] = value["ref_image_id"]
    model = value.get("model")
    if isinstance(model, str) and model.strip():
        out["model"] = model.strip()[:200]
    return out


def sanitize_meta(value: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(value, dict):
        return None
    out: Dict[str, Any] = {}
    if isinstance(value.get("model"), str):
        out["model"] = value["model"][:200]
    d = value.get("duration_s")
    if isinstance(d, (int, float)) and not isinstance(d, bool) and 0 <= d < 86400:
        out["duration_s"] = round(float(d), 1)
    return out or None


def sanitize_error(value: Any) -> Optional[Dict[str, Any]]:
    if value is True:
        return {"code": "engine", "message": "", "retryable": True}
    if not isinstance(value, dict):
        return None
    code = value.get("code") if value.get("code") in _ERROR_CODES else "engine"
    return {"code": code, "message": str(value.get("message") or "")[:400],
            "retryable": value.get("retryable") is not False}


def copy_fields(src: Dict[str, Any], dst: Dict[str, Any]) -> None:
    """Recopie dans ``dst`` les champs « image » assainis de ``src``."""
    if src.get("role") == "user":
        req = sanitize_request(src.get("image_request"))
        if req is not None:
            dst["image_request"] = req
        return
    if src.get("role") != "assistant":
        return
    for k in ("generated_images", "tool_images"):
        refs = sanitize_refs(src.get(k))
        if refs:
            dst[k] = refs
    rp = src.get("revised_prompt")
    if isinstance(rp, str) and rp.strip():
        dst["revised_prompt"] = rp.strip()[:2000]
    meta = sanitize_meta(src.get("image_meta"))
    if meta:
        dst["image_meta"] = meta
    err = sanitize_error(src.get("image_error"))
    if err:
        dst["image_error"] = err


def is_image_request(message: Any) -> bool:
    """Un tour est « image » parce que le DERNIER message user porte
    ``image_request`` — Régénérer et éditer-renvoyer repartent ainsi au moteur
    d'images sans chemin particulier."""
    return isinstance(message, dict) and isinstance(message.get("image_request"), dict)
