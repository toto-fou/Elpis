# SPDX-License-Identifier: MIT
"""
backend.routes.system — Public/system endpoints, HTML page entrypoints, and
public-config URL resolution.

Endpoints
---------
HTML page entrypoints (server-side @include assembly + ?v= cache-busting)
- GET  /                  — main chat/editor SPA

System / health / metadata
- GET  /api/health        — liveness probe (always 200)
- GET  /api/help/readme   — serves the project README to the in-app help drawer
- GET  /api/inbox/count   — shared-prompts pending count
- GET  /api/public-config — branding + split-mode admin/main URL discovery

NOT yet moved here (still in ``_legacy.py``)
--------------------------------------------
- ``/api/system-events`` SSE — depends on ``_cron_started``,
  ``start_cron_scheduler``, ``_ensure_model_poller``, and the ``system_events``
  bus instance, all still living in ``_legacy``. Move once those are
  extracted to a ``core.events`` module.
"""
from __future__ import annotations

import os
from typing import Any, Dict, Optional

from fastapi import HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse

from shared_infra.config import (
    AGENTS_ENABLED,
    PROJECT_ROOT, config_view, https_enabled, https_ports,
)
from shared_infra.security.deps import require_user_id
from shared_infra.chat.prompts_store import (
    list_shared_prompts,
)
from shared_infra.routes._state import router



# ─────────────────────────────────────────────────────────────────────────────
#  HTML PAGE ASSEMBLY HELPER
# ─────────────────────────────────────────────────────────────────────────────
# ─────────────────────────────────────────────────────────────────────────────
#  Empreinte des bundles vendor
# ─────────────────────────────────────────────────────────────────────────────
# Les bundles tiers ne changent qu'au redéploiement. Les taguer au BUILD_ID —
# qui change à CHAQUE redémarrage de gunicorn — les ferait re-télécharger pour
# rien. On les tague donc par (mtime, taille) : l'URL ne bouge que si le
# FICHIER bouge, ce qui rend un ``Cache-Control: immutable`` correct par
# construction (cf. _CacheBustingStaticFiles dans server/app.py).
#
# Mémoïsé : les fichiers vendor ne changent pas en cours de process, et cette
# fonction est appelée une dizaine de fois par rendu de page.
_VENDOR_FP_CACHE: Dict[str, str] = {}

# Bundles chargés dynamiquement par ``window.ensureVendor`` (frontend/js/utils.js).
# Ils ne figurent dans aucune balise HTML, donc la réécriture ne les voit pas :
# leurs empreintes sont publiées dans ``window.__VENDOR_V__``. Cette liste doit
# rester alignée sur les groupes déclarés dans utils.js — un test le vérifie.
_LAZY_VENDOR = (
    "vendor/mermaid.min.js",
    "vendor/highlight.min.js",
    "vendor/chart.js",
    "vendor/chartjs-adapter-date-fns.bundle.min.js",
    "vendor/chartjs-plugin-datalabels.min.js",
    "vendor/chartjs-plugin-annotation.min.js",
    "vendor/chartjs-chart-treemap.min.js",
    "vendor/chartjs-chart-sankey.min.js",
    "vendor/chartjs-chart-matrix.min.js",
    "vendor/chartjs-chart-boxplot.umd.min.js",
    "vendor/chartjs-chart-financial.js",
    "vendor/monaco/vs/loader.js",
)


def vendor_fingerprint(static_rel: str) -> str:
    """Empreinte courte d'un fichier vendor désigné par ``static/vendor/...``.

    Retombe sur le BUILD_ID si le fichier est introuvable : on préfère un
    cache-bust inutile à une URL sans version, qui serait servie en
    ``immutable`` sans pouvoir être invalidée.
    """
    cached = _VENDOR_FP_CACHE.get(static_rel)
    if cached:
        return cached
    from shared_infra.config import BUILD_ID
    fp = BUILD_ID
    try:
        rel = static_rel[len("static/"):] if static_rel.startswith("static/") else static_rel
        st = os.stat(os.path.join("frontend", rel))
        import hashlib as _hl
        fp = _hl.blake2b(f"{st.st_mtime_ns}:{st.st_size}".encode(),
                         digest_size=5).hexdigest()
    except OSError:
        pass
    _VENDOR_FP_CACHE[static_rel] = fp
    return fp


# ─────────────────────────────────────────────────────────────────────────────
#  Assemblage des pages — mis en cache sur l'état du disque
# ─────────────────────────────────────────────────────────────────────────────
# Assembler ``index.html`` coûte 27 ms par chargement : 7 ms de ``@include`` (une
# quarantaine de fichiers lus et recollés), 11 ms de réécriture des ``?v=`` par
# expression régulière sur 1,26 Mo, et 6 ms d'empreintes vendor. À chaque
# ouverture de page, pour un résultat rigoureusement identique tant que rien n'a
# changé sur le disque.
#
# Même patron que le cache de ``config.json`` : la source de vérité reste le
# FICHIER. On mémorise l'état ``(mtime, taille)`` de la page ET de chacun de ses
# includes ; toucher n'importe lequel fait tomber le cache. Vérifier une
# quarantaine de ``stat`` coûte ~80 µs, contre 27 ms d'assemblage.
_page_cache: Dict[str, Any] = {}


def _sources_key(paths) -> tuple:
    out = []
    for p in paths:
        try:
            st = os.stat(p)
            out.append((p, st.st_mtime_ns, st.st_size))
        except OSError:
            out.append((p, 0, -1))       # disparu : la clé change, le cache tombe
    return tuple(out)


def render_page(rel_path: str) -> str:
    """Page HTML assemblée, servie depuis le cache tant que le disque n'a pas bougé.

    ``rel_path`` est relatif à ``frontend/`` (``index.html``, ``admin.html``).
    """
    root = os.path.join("frontend", rel_path)
    entry = _page_cache.get(rel_path)
    if entry is not None and _sources_key(entry["sources"]) == entry["key"]:
        return entry["html"]

    with open(root, "r", encoding="utf-8") as f:
        content = f.read()
    lus: list = [root]
    html = _apply_includes_and_cachebust(content, _lus=lus)
    _page_cache[rel_path] = {
        "sources": lus,
        "key": _sources_key(lus),
        "html": html,
    }
    return html


def _apply_includes_and_cachebust(content: str, _lus: "Optional[list]" = None) -> str:
    """
    Server-side HTML assembly helper for ``/`` (the chat/editor SPA).

    ── Includes ────────────────────────────────────────────────────
    Syntax inside any static HTML file:
        <!-- @include includes/login_card.html -->

    Paths are RESOLVED RELATIVE TO static/ and must stay under
    static/includes/ (no ../, no absolute paths). Missing includes
    render as an HTML comment so a template typo doesn't blank the
    page. Runs up to 3 passes so includes can themselves contain
    @include directives (e.g. a modal group that composes sub-includes).

    ── Cache-bust ──────────────────────────────────────────────────
    Replaces every ``?v=<something>`` querystring with the current
    BUILD_ID (defined in backend/config.py at module load time).

    BUILD_ID is STABLE for the life of the gunicorn instance — it changes
    only when gunicorn restarts. This means :
      • Same user visiting /  → same ?v → browser cache hit → no re-DL
      • Gunicorn restarts     → new BUILD_ID → new ?v → browser sees
                                "new URL", re-downloads only what changed
                                (CSS, JS), without needing Ctrl+F5.

    Runs AFTER @include assembly so versioned URLs inside includes
    (e.g. `<script src="…?v=…">` in a modal partial) are also re-versioned.
    The regex accepts both integer (`?v=1234`) and float (`?v=4.23`)
    formats — the earlier index-only regex `\\?v=\\d+` missed floats,
    causing agentic.js?v=4.23 to stay cached forever.
    """
    import json as _json
    import re as _re
    from shared_infra.config import BUILD_ID

    def _include(match):
        rel = match.group(1).strip()
        if not rel.startswith("includes/") or ".." in rel or rel.startswith("/"):
            return f"<!-- @include: invalid path {rel!r} -->"
        # On note le chemin même en cas d'échec : un include ABSENT qui
        # réapparaît doit invalider le cache, sinon la page resterait
        # définitivement amputée.
        if _lus is not None:
            _lus.append(f"frontend/{rel}")
        try:
            with open(f"frontend/{rel}", "r", encoding="utf-8") as pf:
                return pf.read()
        except FileNotFoundError:
            return f"<!-- @include: include not found: {rel} -->"
        except OSError as exc:
            return f"<!-- @include: read error on {rel}: {exc} -->"

    for _ in range(3):
        new_content = _re.sub(r'<!--\s*@include\s+(\S+)\s*-->', _include, content)
        if new_content == content:
            break
        content = new_content

    # Le ?v= peut contenir digits, points, tirets (notre format BUILD_ID
    # contient un tiret : "1714123456-a3f9d2"). On accepte largement.
    content = _re.sub(r'\?v=[\w.-]+', f'?v={BUILD_ID}', content)

    # ── Vendor : versionné par EMPREINTE DE CONTENU, pas par BUILD_ID ─────
    # Ces bundles tiers ne changent qu'au redéploiement, jamais entre deux
    # redémarrages. Les taguer au BUILD_ID les ferait re-télécharger à chaque
    # restart de gunicorn — 733 Ko pour rien. Une empreinte (mtime, taille)
    # ne bouge que si le fichier bouge, ce qui autorise le serveur à les
    # servir en ``immutable`` (cf. _CacheBustingStaticFiles) : zéro requête de
    # revalidation sur les visites suivantes.
    #
    # Les assets APPLICATIFS gardent délibérément le BUILD_ID et le
    # ``no-cache`` : l'auteur a choisi qu'un redéploiement soit visible
    # immédiatement, et une édition de JS en dev ne doit pas rester collée.
    content = _re.sub(
        r'((?:src|href)=")(static/vendor/[^"?]+)(")',
        lambda m: f'{m.group(1)}{m.group(2)}?v={vendor_fingerprint(m.group(2))}{m.group(3)}',
        content,
    )

    # Empreintes des bundles chargés DYNAMIQUEMENT (ensureVendor, utils.js) :
    # ils ne passent pas par le HTML, donc la réécriture ci-dessus ne les voit
    # pas. On les publie dans un global que le chargeur consulte.
    _map = {p: vendor_fingerprint("static/" + p) for p in _LAZY_VENDOR}
    content = content.replace(
        "</head>",
        "<script>window.__VENDOR_V__=" + _json.dumps(_map) + ";</script>\n</head>",
        1,
    )
    return content


# ─────────────────────────────────────────────────────────────────────────────
#  HTML PAGE ENTRYPOINTS
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/", response_class=HTMLResponse)
def index():
    content = render_page("index.html")
    return HTMLResponse(content=content, headers={
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0"
    })


# ─────────────────────────────────────────────────────────────────────────────
#  HEALTH / HELP / INBOX
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/api/health")
def api_health():
    return {"status": "ok"}


@router.get("/api/help/readme")
def api_get_readme(request: Request, doc: str = "user"):
    """Sert la documentation à la modal d'aide in-app.

    ``doc=user`` (défaut) → ``docs/guide-utilisateur.md`` (guide utilisateur) ;
    ``doc=dev``           → ``docs/architecture.md`` (doc développeur).

    Les deux contiennent des diagrammes Mermaid (blocs ```` ```mermaid ````) qui
    sont rendus côté front par le même pipeline que le chat.
    """
    require_user_id(request)
    is_dev = str(doc or "").strip().lower() in ("dev", "developer", "developpeur", "devs")
    if is_dev:
        readme_path = PROJECT_ROOT / "docs" / "architecture.md"
        label = "docs/architecture.md"
    else:
        readme_path = PROJECT_ROOT / "docs" / "guide-utilisateur.md"
        label = "docs/guide-utilisateur.md"
    resolved_doc = "dev" if is_dev else "user"
    if not readme_path.exists():
        return {"content": f"# Fichier {label} introuvable\n\nAucune documentation n'a été trouvée.", "doc": resolved_doc}
    try:
        content = readme_path.read_text(encoding="utf-8")
        return {"content": content, "doc": resolved_doc}
    except Exception as e:
        return {"content": f"# Erreur de lecture\n\nImpossible de lire le fichier: {str(e)}", "doc": resolved_doc}


@router.get("/api/inbox/count")
def api_inbox_count(request: Request):
    """Return the number of shared prompts waiting for the user."""
    uid = require_user_id(request)
    prompts = list_shared_prompts(uid)
    return {"count": len(prompts), "prompts": len(prompts)}


# ─────────────────────────────────────────────────────────────────────────────
#  PUBLIC CONFIG  (branding + split-mode URL resolution)
# ─────────────────────────────────────────────────────────────────────────────
_LOCALHOST_HOSTS = frozenset({"localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"})


def _rewrite_localhost_url(env_url: str, request: Request) -> str:
    """If ``env_url`` points at a localhost-family hostname AND the request
    did NOT itself come via localhost, replace just the hostname with the
    one the client is currently using. Port and path from the env URL are
    preserved — those reflect the real cross-process listener layout.

    Return-value contract (important for the frontend's fallback chain):

    - ``env_url`` unchanged when the URL is already usable as-is
      (non-localhost hostname, or request itself is from localhost).
    - The rewritten URL when localhost was successfully replaced with
      a public hostname.
    - **Empty string** when the env URL has localhost AND we were unable
      to determine a usable client hostname (no Host header, only
      forwarded headers that themselves point at localhost, parse
      errors, etc.). Returning the localhost URL in that case would be
      WORSE than empty: the frontend's bootstrap fallback (which
      synthesizes from ``window.location``) is always at least as good,
      so we'd rather hand back ``""`` and let it kick in. Without this,
      a misconfigured proxy that strips the public Host header was
      enough to produce buttons pointing at ``localhost`` on every
      remote browser — bug visible as "le bouton retour me renvoie sur
      localhost".

    Empty input returns empty unchanged (no env var configured →
    frontend uses its own fallback).
    """
    if not env_url:
        return env_url
    try:
        from urllib.parse import urlsplit, urlunsplit
        parts = urlsplit(env_url)
        env_host = (parts.hostname or "").lower()
        if env_host not in _LOCALHOST_HOSTS:
            # Already a public URL — leave it alone.
            return env_url

        # What hostname is the client actually hitting? We try several
        # signals in order of trustworthiness, and we SKIP any that
        # itself resolves to a localhost-family value — accepting
        # "localhost" as the answer here would just produce the same
        # broken URL. Empty string is the right signal: the frontend's
        # window.location bootstrap handles it correctly.
        candidates = []
        # Trust X-Forwarded-Host first (set by reverse proxies). Take
        # only the first entry — the chain may include intermediate
        # proxies after the public-facing one.
        xfh = request.headers.get("x-forwarded-host", "")
        if xfh:
            candidates.append(xfh.split(",")[0].strip())
        # Then the regular Host header (direct browser → app, no proxy).
        host_h = request.headers.get("host", "")
        if host_h:
            candidates.append(host_h.strip())
        # Last resort: client IP. Almost always a private address in
        # split-mode setups but worth a try if Host is somehow missing.
        if request.client and request.client.host:
            candidates.append(request.client.host)

        client_host = ""
        for cand in candidates:
            # Strip port from the candidate (we keep the env URL's port).
            # IPv6 hosts arrive bracketed: "[::1]:8001" — split on the
            # last colon only when there's no closing bracket OR after
            # the closing bracket.
            if cand.startswith("["):
                h = cand.split("]")[0] + "]"
            else:
                h = cand.split(":")[0]
            h_lower = h.lower().strip("[]")
            if h and h_lower not in _LOCALHOST_HOSTS:
                client_host = h
                break

        if not client_host:
            # All candidates were missing or themselves localhost. The
            # configured env URL is unusable AND we have no public host
            # to substitute — return "" so the frontend keeps whatever
            # it bootstrapped from window.location instead of getting
            # the localhost-laden value back from us.
            return ""

        # Reassemble. ``parts.port`` may be None if the env URL didn't
        # specify a port, in which case the default port is implicit.
        new_netloc = client_host
        if parts.port is not None:
            new_netloc = f"{client_host}:{parts.port}"
        return urlunsplit((parts.scheme, new_netloc, parts.path, parts.query, parts.fragment))
    except Exception:
        # Any parsing edge case: same logic as above — if the env URL
        # had localhost in it, returning it as-is is worse than empty
        # (the frontend has a smarter bootstrap fallback). If it didn't,
        # we wouldn't have reached this far. Return "".
        return ""


# ─────────────────────────────────────────────────────────────────────
#  Public-URL synthesis fallback for split-mode without env vars
# ─────────────────────────────────────────────────────────────────────
#
#  ``ADMIN_PUBLIC_URL`` and ``MAIN_PUBLIC_URL`` are supposed to be set
#  by the operator when running in split mode (APP_MODE=main on one
#  process, APP_MODE=admin on another). Reality: very often they aren't,
#  or they're set to ``http://localhost:<port>/`` because that's what
#  ``./elpis start`` defaults to. For a remote user (anyone not
#  on the VM itself) the consequences are:
#    • "Admin" button in the chat sidebar → empty URL → falls back to
#      the legacy in-page admin instead of navigating to the dedicated
#      admin process. (Symptom: "le bouton coté chatbot pour aller sur
#      la page admin me renvoi sur l'ancienne page".)
#    • "Retour à l'app" on the admin page → empty or localhost →
#      ERR_CONNECTION_REFUSED on a remote client. (Symptom: "le bouton
#      retourner au chat me renvoie vers localhost".)
#    • At login, the legacy auto-flip to in-page admin fires because
#      ``adminAppUrl.value`` is empty (the splitMode test sees nothing).
#      (Symptom: "à la connexion la page admin pop".)
#
#  ``_rewrite_localhost_url`` already handles the localhost-env-var
#  case (see above). What's missing is the *empty* env var case: if
#  the operator never set ``ADMIN_PUBLIC_URL`` but really is running
#  in split mode, we still want the chat sidebar button to know where
#  to navigate. So we synthesise a default from the request itself —
#  exactly the same heuristic the admin.html bootstrap script uses
#  client-side, kept in sync so both produce identical URLs.
#
#  Heuristic:
#   • If the request port is one of the recognised dev pair ports
#     (8001 ↔ 8002 — see ./elpis start), swap to the peer.
#   • Otherwise (request on 80 / 443 / any other port — typically a
#     reverse proxy mapping both processes to the same public host),
#     use the conventional path layout: ``/`` for chat, ``/admin``
#     for admin.
#
#  We intentionally do NOT synthesise in ``APP_MODE=full``: there's
#  only one process, the URLs MUST stay empty so the frontend keeps
#  using the in-page admin view. Synthesising would point the user
#  at the same process they're already on, which would just be weird.

def _request_scheme(request: Request) -> str:
    """Public scheme of the incoming request.

    Honour ``X-Forwarded-Proto`` (set by reverse proxies terminating
    TLS) before ``request.url.scheme`` (which sees the upstream HTTP
    when behind such a proxy)."""
    fwd_proto = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    if fwd_proto in ("http", "https"):
        return fwd_proto
    try:
        s = (request.url.scheme or "").lower()
        if s in ("http", "https"):
            return s
    except Exception:
        pass
    return "http"


def _request_public_host(request: Request) -> str:
    """``host:port`` the client is currently using to reach us.

    Same precedence as ``_rewrite_localhost_url``: X-Forwarded-Host
    first (proxy), then Host header. Returns empty if neither is set —
    callers treat that as "synthesis impossible"."""
    fwd = request.headers.get("x-forwarded-host", "").split(",")[0].strip()
    return fwd or request.headers.get("host", "") or ""


def _split_host_port(host_hdr: str) -> tuple[str, str]:
    """Split a Host-header value into ``(host, port)``. Handles IPv6
    brackets correctly. Empty port is returned as empty string, not
    None — keeps comparisons in ``_synthesize_public_url`` simple."""
    if not host_hdr:
        return "", ""
    if host_hdr.startswith("["):
        # "[::1]:8001" → host="[::1]", port="8001"
        bracket_end = host_hdr.find("]")
        if bracket_end < 0:
            return host_hdr, ""
        host = host_hdr[: bracket_end + 1]
        rest = host_hdr[bracket_end + 1:]
        port = rest[1:] if rest.startswith(":") else ""
        return host, port
    if ":" in host_hdr:
        h, p = host_hdr.rsplit(":", 1)
        return h, p
    return host_hdr, ""


def _synthesize_public_url(request: Request, kind: str) -> str:
    """Synthesise a public URL for the *peer* process from the request.

    ``kind`` is ``'main'`` or ``'admin'``. Returns ``""`` if the
    incoming request has no Host header (synthesis impossible).
    """
    if kind not in ("main", "admin"):
        return ""
    host_hdr = _request_public_host(request)
    if not host_hdr:
        return ""

    host, port = _split_host_port(host_hdr)
    scheme = _request_scheme(request)

    # Heuristic 0 — mode HTTPS actif (frontal Caddy, toggle admin) : les
    # URLs publiques sont déterministes quel que soit le port entrant —
    # main sur security.https.main_port (443 implicite), admin sur
    # admin_port. Les heuristiques 8001↔8002 ci-dessous produiraient des
    # URLs http vers des binds devenus loopback.
    if https_enabled():
        p = https_ports()
        target = p["main"] if kind == "main" else p["admin"]
        path = "/" if kind == "main" else "/admin"
        netloc = host if target == 443 else f"{host}:{target}"
        return f"https://{netloc}{path}"

    # Heuristic 1 — recognised dev pair ports (./elpis start).
    if kind == "main":
        if port == "8002":
            return f"{scheme}://{host}:8001/"
        if port == "8001":
            # Already on main — reflect the request URL itself so the
            # admin process can hand this back to its clients. The
            # trailing slash matters for the frontend's URL parser.
            return f"{scheme}://{host_hdr}/"
    else:  # admin
        if port == "8001":
            return f"{scheme}://{host}:8002/admin"
        if port == "8002":
            return f"{scheme}://{host_hdr}/admin"

    # Heuristic 2 — non-pair port (80/443 behind a reverse proxy that
    # maps both processes onto the same public host with paths). Use
    # the conventional "/" + "/admin" layout.
    if kind == "main":
        return f"{scheme}://{host_hdr}/"
    return f"{scheme}://{host_hdr}/admin"


def _resolve_public_url(env_url: str, request: Request, kind: str, app_mode: str) -> str:
    """Three-tier resolver: env var → localhost rewrite → request synthesis.

    1. ``env_url`` populated + already public → returned as-is by
       ``_rewrite_localhost_url``.
    2. ``env_url`` populated + localhost-family + remote client →
       ``_rewrite_localhost_url`` swaps the hostname.
    3. ``env_url`` empty AND we're in split mode → synthesise from the
       request. This is the case operators most commonly hit ("I never
       set ADMIN_PUBLIC_URL because I forgot it existed").

    In ``APP_MODE=full`` (single-process / legacy) the empty case
    stays empty — the frontend then uses its in-page admin view, which
    is the correct UX for that topology.
    """
    # Mode HTTPS actif : la synthèse (déterministe, voir heuristic 0)
    # PRIME sur l'env — les ADMIN_PUBLIC_URL/MAIN_PUBLIC_URL posées par
    # les scripts de lancement (http://localhost:800x) pointent vers des
    # binds devenus loopback et avec le mauvais schéma.
    if app_mode and app_mode != "full" and https_enabled():
        return _synthesize_public_url(request, kind) or ""
    rewritten = _rewrite_localhost_url(env_url, request)
    if rewritten:
        return rewritten
    if app_mode and app_mode != "full":
        return _synthesize_public_url(request, kind)
    return ""


# ─────────────────────────────────────────────────────────────────────────────
#  Logo d'accueil — servi comme une image, pas comme du JSON
# ─────────────────────────────────────────────────────────────────────────────
# L'admin peut téléverser un logo d'accueil ; il est stocké en data-URI base64
# dans ``config.json``. Sur cette instance, cette seule valeur pèse 388 Ko — soit
# 96 % du fichier de configuration — et ``/api/public-config`` la renvoyait
# telle quelle À CHAQUE démarrage de l'application, pour une image affichée en
# 144 px. Une réponse JSON n'étant pas mise en cache, ces 388 Ko repartaient à
# chaque ouverture de page.
#
# On garde le FORMAT DE STOCKAGE intact — donc aucune migration, et le
# téléversement admin est inchangé — mais ``/api/public-config`` renvoie
# désormais l'URL d'un endpoint qui sert les octets décodés, avec un cache long
# versionné par le contenu. Le front n'a rien à changer : il fait
# ``<img :src="welcomeConfig.image_b64">`` et sa valeur par défaut est déjà un
# chemin (``static/elpis-256.png``), pas un data-URI.

def _welcome_image_parts():
    """(mimetype, octets, empreinte) du logo stocké, ou None s'il n'y en a pas."""
    raw = ((config_view().get("welcome") or {}).get("image_b64") or "")
    if not isinstance(raw, str) or not raw.startswith("data:"):
        return None
    try:
        head, b64 = raw.split(",", 1)
        mime = head[5:].split(";")[0] or "image/png"
        import base64 as _b64, hashlib as _hl
        data = _b64.b64decode(b64, validate=False)
        return mime, data, _hl.blake2b(data, digest_size=8).hexdigest()
    except Exception:
        return None


@router.get("/api/welcome-image")
def get_welcome_image():
    parts = _welcome_image_parts()
    if parts is None:
        raise HTTPException(404, "Aucun logo d'accueil stocké")
    mime, data, fp = parts
    from fastapi.responses import Response as _Response
    return _Response(content=data, media_type=mime, headers={
        # L'URL porte l'empreinte du CONTENU : un logo remplacé change d'URL,
        # donc l'immuabilité est sûre.
        "Cache-Control": "public, max-age=31536000, immutable",
        "ETag": f'"{fp}"',
    })


@router.get("/api/public-config")
def get_public_config(request: Request):
    # Lecture SEULE : ``config_view`` sert la vue partagée (3 µs) au lieu d'une
    # copie profonde des 403 Ko (119 µs). Les sous-dicts partis dans la réponse
    # ne sont que sérialisés — ne JAMAIS les muter ici, ce serait contaminer le
    # cache de tout le process.
    config = config_view()
    # AUDIT 2026-08-30 (S5) — ce repli pointait sur ``static/elpis.png``, retiré
    # du dépôt. Inerte sur une instance configurée (``config.json`` porte un
    # base64), mais c'est EXACTEMENT le chemin d'une installation neuve : le
    # tout premier écran d'accueil affichait une image morte. ``elpis-256.png``
    # est l'asset survivant (il sert déjà d'apple-touch-icon).
    welcome = config.get("welcome", {
        "type": "image",
        "icon": "ph-sparkle text-blue-500",
        "size": 112, "width": 112, "height": 112,
        "image_b64": "static/elpis-256.png"
    })
    app_info = config.get("app_info", {
        "name": "Elpis", "version": "1.0.0", "team_name": "Elpis",
        "engine": "llama.cpp", "description": "", "icon_type": "phosphor",
        "icon": "ph-robot", "icon_color": "#ffffff", "icon_bg": "#0f172a", "logo_b64": ""
    })
    login_page = config.get("login_page", {
        "title": "Connexion", "subtitle": "",
        "icon_type": "phosphor", "icon": "ph-robot",
        "icon_color": "#ffffff", "icon_bg": "#2563eb",
        "logo_b64": "", "bg_color": "", "card_color": "#ffffff",
        "text_color": "", "btn_color": "#0f172a"
    })
    # ── Split-app awareness ──────────────────────────────────────────────
    # When the admin process runs in a SEPARATE gunicorn (the recommended
    # security posture), the chat-facing process exposes here the URL the
    # browser should navigate to when the user clicks the Admin button in
    # the sidebar. ``ADMIN_PUBLIC_URL`` is set in the .env / ./elpis start
    # to e.g. "http://localhost:8002/admin" (dev) or "https://your.host/admin"
    # (prod, behind a reverse proxy that routes /admin → the admin process).
    #
    # If unset, the frontend falls back to in-page admin view (legacy /
    # APP_MODE=full single-process behaviour).
    #
    # ``app_mode`` lets the frontend tell the user which process they're
    # talking to — e.g. add an "ADMIN" badge in the header, or warn if
    # they're somehow on the chat-side admin button while the backend is
    # in admin-only mode.
    # Le logo d'accueil part par ``/api/welcome-image`` (cf. plus haut) : on ne
    # recopie pas ses 388 Ko dans une réponse JSON non cachée, à chaque
    # démarrage de l'application. Le champ garde son nom — le front y met un
    # ``src``, peu lui importe que ce soit un data-URI ou un chemin.
    _img = _welcome_image_parts()
    if _img is not None:
        welcome = {**welcome, "image_b64": f"/api/welcome-image?v={_img[2]}"}

    admin_url = (os.environ.get("ADMIN_PUBLIC_URL") or "").strip()
    main_url = (os.environ.get("MAIN_PUBLIC_URL") or "").strip()
    app_mode = (os.environ.get("APP_MODE") or "full").lower()

    # ── Localhost rewriting for remote clients ──────────────────────────
    # See _rewrite_localhost_url docstring for the full rationale.
    admin_url = _resolve_public_url(admin_url, request, "admin", app_mode)
    main_url = _resolve_public_url(main_url, request, "main", app_mode)
    # (``flowise_url`` retiré : le plugin Flowise et son bouton sidebar ont
    # été supprimés — il ne reste aucun consommateur de cette URL.)

    # Moteur vocal : la coercition et les bornes vivent dans la famille, pas
    # ici. Un seul appel — ``voice_flags`` relit ``config.json``.
    try:
        from shared_infra.voice.config import voice_flags as _voice_flags
        _voice_stt, _voice_tts = _voice_flags()
    except Exception:                                           # noqa: BLE001
        _voice_stt = _voice_tts = False

    return JSONResponse({
        "welcome":   welcome,
        "app_info":  app_info,
        "login_page": login_page,
        # New fields, additive — older frontends just ignore them.
        "admin_url": admin_url,
        "main_url":  main_url,
        "app_mode":  app_mode,
        # Feature flags GLOBAUX (toggle admin, config.json › features). Absents ou
        # non-false ⇒ activé (rétro-compat). Le front masque les surfaces désactivées.
        "features": {
            "opencode": (config.get("features") or {}).get("opencode", True) is not False,
            # Sous-agents (outil ``task``) : interrupteur MAÎTRE d'instance
            # (llm.task.enabled). Exposé pour que le front n'offre pas des
            # cases à cocher que le serveur ignorera — un opt-in per-user ou
            # per-routine inerte est exactement le réglage mort qu'on traque.
            "agents": bool(AGENTS_ENABLED),
            # Aperçus Office de l'éditeur (docx/pptx/xlsx via LibreOffice).
            # Le PDF reste visible même coupé : il ne demande aucune conversion.
            "office_preview": (config.get("features") or {}).get("office_preview", True) is not False,
            # Moteur vocal — deux drapeaux plutôt qu'un : la reconnaissance et
            # la synthèse vivent sur deux services distincts, l'un peut être
            # configuré sans l'autre. Défaut OFF STRICT, à l'inverse des
            # drapeaux ci-dessus : une fonction qui ouvre le micro ne s'allume
            # pas par rétro-compatibilité. Une adresse vide vaut éteint — sinon
            # le bouton existerait sans aboutir nulle part.
            "voice_stt": _voice_stt,
            "voice_tts": _voice_tts,
        },
    })
