# SPDX-License-Identifier: MIT
"""
shared_infra.git._http — Client HTTP-JSON minimal (stdlib) pour les APIs de PR/MR.

Déplacé depuis ``git_tools._http_json`` pour être partagé par l'abstraction de
providers. Ne lève JAMAIS : toute erreur va dans le champ ``error``.

SSRF sur les REDIRECTIONS (durci 2026-07-18) : ``urllib`` suit les 30x par
défaut ; l'URL initiale est validée par l'appelant (``block_remote_url_reason``)
mais PAS la cible d'une redirection → un endpoint git malveillant/compromis
pouvait renvoyer ``302 → http://169.254.169.254/…`` (métadonnées cloud, pivot
LAN), avec l'en-tête ``Authorization`` attaché. On installe un handler de
redirection qui RE-VALIDE chaque saut avec la MÊME politique SSRF et RETIRE
l'``Authorization`` sur un changement de host.
"""
from __future__ import annotations

import base64
import json
import urllib.error
import urllib.request
from typing import Any, Dict, Iterable, Optional
from urllib.parse import urlsplit


class _SsrfValidatingRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Handler de redirection qui applique la politique SSRF à CHAQUE saut."""

    def __init__(self, allow_hosts: Iterable[str], allow_schemes: Iterable[str]):
        super().__init__()
        self._allow_hosts = tuple(allow_hosts or ())
        self._allow_schemes = tuple(allow_schemes or ("https",))

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        from shared_infra.git.ssrf import block_remote_url_reason
        reason = block_remote_url_reason(
            newurl, allow_schemes=self._allow_schemes, allow_hosts=self._allow_hosts,
        )
        if reason:
            # Refuse net : une redirection vers une cible non validée (IP interne,
            # schéma interdit, host non allowlisté) est traitée comme une erreur.
            raise urllib.error.HTTPError(
                newurl, code, f"SSRF blocked redirect: {reason}", headers, fp)
        new_req = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new_req is not None:
            # Fuite de credentials : ne JAMAIS ré-attacher l'Authorization à un
            # host différent de l'original (le handler urllib ne le fait pas
            # toujours selon la version).
            try:
                old_host = (urlsplit(req.full_url).hostname or "").lower()
                new_host = (urlsplit(newurl).hostname or "").lower()
                if old_host != new_host:
                    for _h in ("Authorization", "authorization"):
                        new_req.headers.pop(_h, None)
                        new_req.unredirected_hdrs.pop(_h, None)
            except Exception:
                pass
        return new_req


def http_json(url: str, *, method: str = "GET", body: Optional[Dict] = None,
              headers: Optional[Dict] = None, timeout: int = 12,
              ssrf_allow_hosts: Iterable[str] = (),
              ssrf_allow_schemes: Iterable[str] = ("https",)) -> Dict[str, Any]:
    """``{ok, status, body, error?}``. Le ``body`` est le JSON parsé (ou texte).

    ``ssrf_allow_hosts`` / ``ssrf_allow_schemes`` : politique SSRF ré-appliquée
    à chaque redirection (cf. ``_SsrfValidatingRedirectHandler``). Par défaut,
    seul ``https`` vers un host PUBLIC est suivi — l'appelant passe le host du
    connecteur ENREGISTRÉ pour autoriser un self-hosted (http/LAN)."""
    try:
        data_bytes = None
        h = {"Accept": "application/json", "User-Agent": "elpis-git/1"}
        if headers:
            h.update(headers)
        if body is not None:
            data_bytes = json.dumps(body).encode("utf-8")
            h.setdefault("Content-Type", "application/json")
        req = urllib.request.Request(url, data=data_bytes, headers=h, method=method)
        opener = urllib.request.build_opener(
            _SsrfValidatingRedirectHandler(ssrf_allow_hosts, ssrf_allow_schemes))
        with opener.open(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(raw) if raw else {}
            except Exception:
                parsed = {"_raw": raw[:500]}
            return {"ok": True, "status": resp.status, "body": parsed}
    except urllib.error.HTTPError as e:
        try:
            body_str = e.read().decode("utf-8", errors="replace")
        except Exception:
            body_str = ""
        return {"ok": False, "status": e.code, "body": body_str[:500],
                "error": f"HTTP {e.code}: {e.reason}"}
    except urllib.error.URLError as e:
        return {"ok": False, "status": 0, "error": f"Network: {e.reason}"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "status": 0, "error": f"{type(e).__name__}: {e}"}


def basic_auth_header(user: str, token: str) -> str:
    raw = f"{user}:{token}".encode("utf-8")
    return "Basic " + base64.b64encode(raw).decode("ascii")
