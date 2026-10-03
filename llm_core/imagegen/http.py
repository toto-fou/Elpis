# SPDX-License-Identifier: MIT
"""Transport HTTP des moteurs d'images.

  * TLS : magasin du système (PKI interne de l'entreprise) plus l'autorité
    collée en console (``image.ca_pem``) ; ``verify=False`` seulement si
    l'administrateur décoche la case. httpx seul, avec ``verify=True``, ne
    lirait que certifi : une PKI interne y serait refusée ;
  * ``trust_env=False`` : les moteurs vivent sur le LAN, un ``HTTP_PROXY``
    hérité les détournerait vers le proxy d'entreprise ;
  * chaque réponse est lue EN FLUX et plafonnée : une réponse démesurée
    (base64 d'un lot entier, serveur fou) s'arrête au plafond au lieu
    d'occuper la mémoire du worker ;
  * ``_TRANSPORT`` : couture de test (``httpx.MockTransport``), ``None`` en
    production.
"""
from __future__ import annotations

import functools
import json
import ssl
from dataclasses import dataclass
from typing import Any, Dict, Optional, Union

import httpx

from llm_core.imagegen.base import HINT_ADMIN, ImageError

_TRANSPORT: Optional[httpx.AsyncBaseTransport] = None

#: Réponses de contrôle (capacités, état d'un job en file, liste de modèles).
SMALL_BYTES = 2 * 1024 * 1024
#: Réponses qui portent les images (base64 d'un lot) : 8 images 2048² en PNG
#: tiennent largement dessous.
LARGE_BYTES = 160 * 1024 * 1024


@functools.lru_cache(maxsize=8)
def _contexte(ca_pem: str) -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    if ca_pem:
        ctx.load_verify_locations(cadata=ca_pem)
    return ctx


def tls(verify: bool, ca_pem: str = "") -> Union[bool, ssl.SSLContext]:
    if not verify:
        return False
    try:
        return _contexte((ca_pem or "").strip())
    except (ssl.SSLError, ValueError) as exc:
        raise ImageError("Autorité de certification illisible. " + HINT_ADMIN,
                         code="unavailable", detail=repr(exc)) from exc


def client(timeout: float, *, verify: bool = True, ca_pem: str = "") -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=10.0),
                             transport=_TRANSPORT, trust_env=False,
                             verify=tls(verify, ca_pem))


@dataclass
class Reply:
    status_code: int
    content: bytes

    def json(self) -> Any:
        return json.loads(self.content or b"null")

    @property
    def text(self) -> str:
        return self.content.decode("utf-8", "replace")


async def fetch(c: httpx.AsyncClient, method: str, url: str, *,
                limit: int = SMALL_BYTES, headers: Optional[Dict[str, str]] = None,
                **kw: Any) -> Reply:
    """Requête lue en flux, plafonnée à ``limit`` octets. Les pannes réseau
    deviennent des :class:`ImageError` (``unavailable`` / ``timeout``)."""
    try:
        async with c.stream(method, url, headers=headers, **kw) as r:
            declared = r.headers.get("content-length")
            if declared and declared.isdigit() and int(declared) > limit:
                raise ImageError("Réponse du moteur trop volumineuse.", code="too_large",
                                 detail=f"{url}: {declared} octets annoncés")
            buf = bytearray()
            async for chunk in r.aiter_bytes():
                buf += chunk
                if len(buf) > limit:
                    raise ImageError("Réponse du moteur trop volumineuse.", code="too_large",
                                     detail=f"{url}: plus de {limit} octets")
            return Reply(r.status_code, bytes(buf))
    except httpx.TimeoutException as exc:
        raise ImageError("Le moteur d'images ne répond pas à temps.",
                         code="timeout", detail=f"{url}: {exc!r}") from exc
    except httpx.HTTPError as exc:
        raise ImageError("Moteur d'images injoignable. " + HINT_ADMIN,
                         code="unavailable", detail=f"{url}: {exc!r}") from exc


def error_excerpt(reply: Reply) -> str:
    """Message lisible d'une réponse en erreur (journal seulement)."""
    try:
        body = reply.json()
        if isinstance(body, dict):
            err = body.get("error")
            if isinstance(err, dict) and err.get("message"):
                return str(err["message"])[:300]
            if isinstance(err, str):
                return err[:300]
            for k in ("message", "detail"):
                if body.get(k):
                    return str(body[k])[:300]
    except ValueError:
        pass
    return reply.text.strip()[:300]


def raise_for_status(reply: Reply, what: str) -> None:
    """Code HTTP du moteur → :class:`ImageError` avec le geste utile. Le
    détail du moteur va au journal, pas à l'utilisateur."""
    code = reply.status_code
    if code < 400:
        return
    detail = f"{what}: HTTP {code}: {error_excerpt(reply)}"
    if code in (401, 403):
        raise ImageError("Clé API refusée par le moteur d'images. " + HINT_ADMIN,
                         code="unavailable", detail=detail, status=code)
    if code == 429:
        raise ImageError("Moteur d'images saturé : réessayez dans un instant.",
                         code="busy", detail=detail, status=code)
    if code >= 500:
        raise ImageError(f"Moteur d'images en erreur (HTTP {code}).",
                         code="engine", detail=detail, status=code)
    raise ImageError(f"Le moteur a refusé la demande (HTTP {code}).",
                     code="refused", detail=detail, status=code)


def json_body(reply: Reply, what: str) -> Any:
    try:
        return reply.json()
    except ValueError as exc:
        raise ImageError("Réponse illisible du moteur d'images.", code="engine",
                         detail=f"{what}: {exc!r}") from exc
