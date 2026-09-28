# SPDX-License-Identifier: MIT
"""
shared_infra/opencode/routes_cli.py — Distribution LAN du CLI « OpenCode ».

But : permettre à N'IMPORTE QUELLE machine du réseau local d'installer/télécharger
OpenCode DEPUIS l'app, **sans Internet**. L'admin dépose les artefacts par OS dans
le dossier de distribution (``OPENCODE_DIST_DIR`` env, ou ``config.json › opencode.dist_dir``,
défaut ``<repo>/cli_dist``), p.ex. ``opencode-linux.tar.gz`` / ``opencode-macos.tar.gz``
/ ``opencode-windows.zip`` (n'importe quelle extension : tar.gz, zip, ou binaire brut).

Endpoints PUBLICS (le ``curl … | bash`` tourne sur une machine SANS cookie de session)
— gated par le flag global ``features.opencode`` (404 si désactivé) :
  - GET /opencode      — alias COURT de install.sh  (chemin affiché par l'app)
  - GET /opencode.ps1  — alias COURT de install.ps1
  - GET /api/cli/install.sh   — script bash (rendu avec l'URL LAN réellement contactée)
  - GET /api/cli/install.ps1  — script PowerShell (Windows)
  - GET /api/cli/bundle/{os}  — artefact de l'OS (linux|macos|windows)

**Amorçage EN CLAIR.** Derrière le frontal HTTPS Caddy (cert LAN auto-signé,
cf. deploy/caddy), la machine cible ne connaît pas encore la CA locale : une
commande d'install en https devait donc désactiver la vérification AVANT même
de télécharger le script (préambule PowerShell de ~400 caractères, cassant
selon la version de .NET). Caddy sert donc ces routes publiques **aussi en
http sur :80** (matcher ``@bootstrap``) → la commande redevient triviale :
``curl -fsSL http://<ip>/opencode | bash``. Deux URL distinctes en découlent :

  - ``BASE``    = origine réellement contactée = base des TÉLÉCHARGEMENTS
                  (http en amorçage clair → zéro TLS à gérer) ;
  - ``APP_URL`` = URL de l'app pour ce qui lui PARLE ensuite (plugin
                  elpis-remote) = https si ``security.https.enabled``.

Le script épingle la CA locale (``http://<hôte>/ca.crt``, servi en clair par
Caddy) dès qu'un https est en jeu ; repli non vérifié sinon. Le plugin
elpis-remote (TypeScript, ``/api/code/plugin.ts``) est proposé en OPTION :
prompt Y/n sur /dev/tty (ou Read-Host), surchargé par ``ELPIS_INSTALL_PLUGIN``.

**Commande ANONYME.** Aucun jeton n'est embarqué : la ligne affichée est la
même pour tous les utilisateurs (partageable, documentable, absente des
historiques shell). L'installeur pose seulement la CIBLE (``app_url``) et le
TLS (CA épinglée) dans ``elpis-remote.json`` ; l'appairage se fait ensuite
depuis opencode via ``/remote login`` (code à saisir dans la page « Code »).
``ELPIS_REMOTE_TOKEN`` reste honoré si quelqu'un le fournit à la main, et une
ré-install PRÉSERVE le jeton déjà appairé.

**Connexion au compte DANS L'INSTALLEUR** (et pas dans ``/remote``) : l'API
plugin d'opencode n'expose aucune primitive de saisie, donc un mot de passe
passé à la commande slash s'afficherait dans le TUI et resterait dans son
historique de commandes. Ce script, lui, a un vrai terminal → frappe masquée
(``stty -echo`` / ``Read-Host -AsSecureString``). Il échange les identifiants
contre le jeton (``POST /api/login-lite`` → cookie → ``GET /api/code/config``),
puis ``/remote`` suffit. Le mot de passe part en CORPS JSON (jamais dans l'URL
ni la ligne de commande, lisibles dans les access logs et ``ps``) et n'est
jamais écrit sur disque. Refus / non-interactif → repli sur ``/remote login``.

Sécurité : ``os`` est mappé via une allowlist (pas d'entrée utilisateur dans le chemin),
le fichier servi est borné au dossier dist (containment ``relative_to``).
"""
from __future__ import annotations

import glob
import logging
import os as _os
import re
from pathlib import Path
from typing import Optional

from fastapi import HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response

from shared_infra.routes._state import router
from shared_infra.config import PROJECT_ROOT, read_config_json, feature_enabled
from llm_core._llama_http import _llama_base_url

logger = logging.getLogger(__name__)

# Alias OS acceptés → clé canonique (= suffixe de fichier attendu).
_OS_ALIASES = {
    "linux": "linux",
    "macos": "macos", "mac": "macos", "darwin": "macos", "osx": "macos",
    "windows": "windows", "win": "windows",
}


def _dist_dir() -> Path:
    raw = (_os.environ.get("OPENCODE_DIST_DIR")
           or str((read_config_json() or {}).get("opencode", {}).get("dist_dir") or "")).strip()
    base = Path(raw) if raw else (PROJECT_ROOT / "cli_dist")
    if not base.is_absolute():
        base = PROJECT_ROOT / base
    return base.resolve()


def _require_opencode_enabled() -> None:
    if not feature_enabled("opencode"):
        raise HTTPException(404, "OpenCode est désactivé par l'administrateur.")


# ── Génération « à chaud » de opencode.json ──────────────────────────────────
# opencode n'auto-découvre PAS les modèles : la carte ``models`` doit être
# énumérée dans le fichier (aucun refresh runtime). On l'assemble donc depuis
# l'état LIVE de l'app — baseURL = llama.cpp courant, modèles = cache chaud
# (``_events_bus._model_cache``, rafraîchi toutes les 10 s) — plutôt que de
# copier un opencode.json statique périmé. Repli offline sur un roster baked-in
# si le serveur d'inférence est injoignable.
_FALLBACK_MODELS: list[dict] = [
    {"id": "qwen3-coder-30b", "vision": False},
    {"id": "qwen3.6-35B", "vision": False},
    {"id": "qwen3.6-27b", "vision": True},
    {"id": "qwen3.6-1m", "vision": False},
    {"id": "gpt-oss-20b", "vision": False},
    {"id": "glm-4.7-flash", "vision": False},
    {"id": "gemma-4-31b", "vision": False},
    {"id": "gemma4-12b", "vision": False},
    {"id": "granite-20b", "vision": False},
    {"id": "default", "vision": False},
]

_MODEL_DISPLAY_NAMES = {
    "qwen3-coder-30b": "Qwen3 Coder 30B",
    "qwen3.6-35B": "Qwen3.6 35B",
    "qwen3.6-27b": "Qwen3.6 27B (vision)",
    "qwen3.6-1m": "Qwen3.6 (1M ctx)",
    "gpt-oss-20b": "GPT-OSS 20B",
    "glm-4.7-flash": "GLM 4.7 Flash",
    "gemma-4-31b": "Gemma 4 31B",
    "gemma4-12b": "Gemma 4 12B",
    "granite-20b": "Granite 20B",
    "default": "Default (preset llama.cpp)",
}

_DEFAULT_MODEL_FALLBACK = "qwen3-coder-30b"


def _live_models() -> tuple[list[dict], set[str]]:
    """(modèles ``[{'id','vision'}…]``, ids « loaded ») depuis le cache chaud.

    Repli sur ``_FALLBACK_MODELS`` (aucun « loaded ») si le cache est froid ou
    le serveur d'inférence injoignable — la config reste valide hors-ligne.
    """
    try:
        from shared_infra.observability import events_bus as _events_bus
        cache = _events_bus._model_cache or {}
        mws = cache.get("models_with_status") or []
        if cache.get("server_reachable") and mws:
            models = [{"id": m["id"], "vision": bool(m.get("vision"))}
                      for m in mws if m.get("id")]
            loaded = {m["id"] for m in mws
                      if m.get("status") == "loaded" and m.get("id")}
            if models:
                return models, loaded
    except Exception:
        pass
    return [dict(m) for m in _FALLBACK_MODELS], set()


def _pick_default_model(model_ids: list[str], loaded: set[str]) -> str:
    """Défaut : préférence config → 1er modèle chargé → 1er dispo → fallback."""
    pref = str((((read_config_json() or {}).get("opencode") or {})
                .get("default_model")) or _DEFAULT_MODEL_FALLBACK).strip()
    if pref in model_ids:
        return pref
    for mid in model_ids:
        if mid in loaded:
            return mid
    return model_ids[0] if model_ids else _DEFAULT_MODEL_FALLBACK


def _model_ctx_limits() -> dict[str, int]:
    """n_ctx/slot connus par modèle — lecture PURE du cache de ``_model_info``
    (peuplé au fil des chats). JAMAIS de sonde ici : ``/props?model=X`` CHARGE
    le modèle sur le routeur. Un modèle jamais utilisé n'a pas de limite →
    opencode n'aura pas de ``limit.context`` pour lui (jauge « N tk » côté
    page Remote code, au lieu d'un %)."""
    try:
        from llm_core import _model_info
        return {k: v for k, v in dict(_model_info._cached_context_size).items()
                if k and v > 0}
    except Exception:
        return {}


def _output_limit(context: int) -> int:
    """``limit.output`` cohérent pour une fenêtre de ``context`` tokens.

    ⚠ opencode SOUSTRAIT cette valeur du contexte pour décider quand compacter
    (``usable = limit.context − min(limit.output, 32000)``, session/overflow.ts) :
    un ``output`` trop généreux ne « permet » pas des réponses plus longues, il
    RONGE la fenêtre utile. Avec l'ancien comportement (``output`` absent →
    opencode retombait sur son plafond de 32 000), un modèle 32K se retrouvait
    avec 768 tokens utilisables → compactage à CHAQUE tour.

    Un huitième de la fenêtre, borné [2048, 16384] : 4 K sur du 32K (87 % de la
    fenêtre reste utile), 16 K sur du 128K et au-delà.
    """
    return max(2048, min(16384, int(context) // 8))


def _generate_opencode_config() -> dict:
    """``opencode.json`` (provider ``elpis``) assemblé depuis l'état live."""
    base_url = _llama_base_url().rstrip("/") + "/v1"
    models, loaded = _live_models()
    model_ids = [m["id"] for m in models]
    limits = _model_ctx_limits()
    models_map: dict[str, dict] = {}
    for m in models:
        entry: dict = {"name": _MODEL_DISPLAY_NAMES.get(m["id"], m["id"]),
                       "tool_call": True}
        if m.get("vision"):
            entry["attachment"] = True
        ctx = int(limits.get(m["id"]) or 0)
        if ctx > 0:
            # fenêtre réelle par slot → jauge ctx de la page Remote code.
            # ⚠ `context` ET `output` : le schéma opencode exige les DEUX
            # (``required: ["context","output"]``). Avec `context` seul, opencode
            # REFUSE tout le fichier — « Missing key provider.elpis.models.<id>.
            # limit.output » — et le provider elpis disparaît. Symptôme vécu :
            # « opencode cassé sur les modèles qwen », précisément ceux qui ont
            # un n_ctx en cache (les seuls à recevoir un `limit`).
            entry["limit"] = {"context": ctx, "output": _output_limit(ctx)}
        models_map[m["id"]] = entry
    return {
        "$schema": "https://opencode.ai/config.json",
        "autoupdate": False,
        "share": "disabled",
        "provider": {
            "elpis": {
                "npm": "@ai-sdk/openai-compatible",
                "name": "Elpis llama.cpp (local)",
                "options": {"baseURL": base_url, "apiKey": "local-no-key"},
                "models": models_map,
            }
        },
        "model": "elpis/" + _pick_default_model(model_ids, loaded),
    }


# ── Outils Elpis dans opencode : bloc ``mcp`` (2026-09-03) ───────────────────
# Le service MCP local partagé (server/local_mcp_server.py, HTTP streamable
# ``/mcp``) accepte le jeton elpis-remote de chaque compte (``pcr_…``) en
# Bearer : un SEUL identifiant par utilisateur pour opencode (plugin /remote +
# outils). Le bloc n'est ajouté que si (1) l'appel est authentifié — session
# web, ou en-tête ``x-elpis-token`` / ``Authorization: Bearer pcr_…`` — et (2) le
# service est partagé ET authentifié (``LOCAL_MCP_URL`` + ``LOCAL_MCP_TOKEN``),
# sinon aucun client externe ne pourrait s'y connecter.
#
# UNE ENTRÉE PAR FAMILLE (2026-09-03) : dans opencode la bascule est le
# SERVEUR MCP (sa boîte « MCPs » itère ``config.mcp``, il n'y a aucune
# granularité interne). Un serveur unique = une seule bascule pour tous les
# outils ; on publie donc ``elpis-<famille>`` → ``…/<famille>``, le service
# restreignant la requête à cette famille (cf. FamilyScopeASGI). Les familles
# exposées viennent de ``LOCAL_MCP_OPENCODE_FAMILIES`` (défaut
# ``git,browser,desktop``) ; fs/shell restent refusés côté serveur.
#
# JOIGNABLE DEPUIS UN AUTRE POSTE (2026-09-04) : l'URL publiée pointe sur
# l'ORIGINE DE L'APP (relais ``/api/mcp-bridge``, cf.
# ``shared_infra/mcp/bridge.py``), pas sur l'adresse propre du service.
# Avant, un poste distant recevait ``http://127.0.0.1:8765/mcp/<famille>`` —
# inutilisable chez lui. Le service peut donc rester lié au loopback.
# Préfixe surchargeable par ``"x-elpis": {"opencode": {"prefix": "…"}}``
# dans ``mcp.json``.
OPENCODE_MCP_PREFIX = "elpis-"


def opencode_mcp_server_name(family: str) -> str:
    """Nom du serveur MCP côté opencode. STABLE : il est préfixé aux noms
    d'outils vus par le modèle (``elpis-git_git_status``), donc gravé dans les
    historiques de session et les permissions de l'utilisateur."""
    prefix = OPENCODE_MCP_PREFIX
    try:
        from shared_infra.mcp import manifest as _mf
        prefix = _mf.load().opencode_prefix() or OPENCODE_MCP_PREFIX
    except Exception:
        pass
    return f"{prefix}{family}"


def _opencode_mcp_url(request: Request) -> Optional[str]:
    """URL du service MCP telle qu'un POSTE utilisateur la joint, ou ``None``
    si le service n'est pas partagé (rien à exposer).

    ⚠ RÉGRESSION CORRIGÉE (2026-09-04). Cette fonction publiait l'adresse du
    service MCP LUI-MÊME : avec le bind par défaut (loopback), tout poste
    distant recevait ``http://127.0.0.1:8765/mcp/<famille>`` — chez lui,
    ``127.0.0.1`` n'est pas le serveur. Les trois entrées ``elpis-*``
    s'affichaient dans opencode et aucune ne répondait. Et même liée à
    ``0.0.0.0``, l'URL restait un SECOND port, en clair, hors du frontal TLS :
    inutilisable derrière Caddy sans ouvrir et sécuriser une deuxième surface.

    Le client parle désormais au MCP par l'ORIGINE QU'IL JOINT DÉJÀ — celle de
    l'app (:func:`_app_url`, qui sait basculer sur le frontal https) — et l'app
    relaie en loopback (``shared_infra/mcp/bridge.py``). Un seul hôte, un
    seul port, un seul certificat, une seule règle de pare-feu ; le service MCP
    peut rester lié au loopback.

    ``LOCAL_MCP_PUBLIC_URL`` reste l'échappatoire explicite pour qui expose le
    service par ses propres moyens (frontal dédié, autre nom d'hôte)."""
    from shared_infra import config as cfg
    public = str(getattr(cfg, "LOCAL_MCP_PUBLIC_URL", "") or "").strip()
    if public:
        return public
    # ⚠ INVARIANT DE SÉCURITÉ — sans URL NI jeton de SERVICE, le service MCP
    # démarre SANS vérificateur (cf. ``_auth_provider``/``build_token_table``) :
    # aucune requête ne porte ``client_kind=opencode``, donc les familles
    # ``fs``/``shell`` ne sont PLUS masquées. Publier dans ce cas donnerait le
    # terminal et le système de fichiers du serveur à tout client opencode.
    # ``service_upstream`` exige les deux (URL + jeton, résolus durablement :
    # jeton depuis le fichier persistant, URL dérivée du descripteur intégré) —
    # c'est ce qui rend le bloc ``mcp`` présent après TOUT redémarrage.
    from shared_infra.mcp.local_registry import service_upstream
    url, token = service_upstream()
    if not url or not token:
        return None
    from shared_infra.mcp.bridge import MCP_PROXY_PREFIX
    return _app_url(request).rstrip("/") + MCP_PROXY_PREFIX


def _live_families() -> Optional[set]:
    """Familles réellement enregistrées par le service, d'après la liste VIVANTE
    des outils (registre de catégories, alimenté à la connexion du pool et
    partagé entre workers par son cache disque). ``None`` = inconnu → on
    n'élague rien : annoncer une famille de trop est moins grave que de n'en
    annoncer aucune parce qu'aucun worker n'a encore connecté le pool."""
    try:
        from llm_core._mcp_categories import get_tool_categories_dict
        cats = {c for c, tools in get_tool_categories_dict().items() if tools}
    except Exception:
        return None
    if not cats:
        return None
    from shared_infra.mcp.families import FAMILY_CATEGORY
    return {f for f, cat in FAMILY_CATEGORY.items() if cat in cats}


def _family_prefs(uid: Optional[int]) -> dict:
    """Choix du COMPTE : ``{famille: bool}``. C'est le seul endroit où une
    bascule survit — celle du TUI d'opencode n'est pas persistée (connect /
    disconnect en mémoire) et un re-sync réécrit ``opencode.json`` en entier."""
    if uid is None:
        return {}
    try:
        from shared_infra.accounts.users import get_user_settings
        raw = (get_user_settings(int(uid)) or {}).get("opencode_mcp_families")
    except Exception:
        return {}
    return {str(k): bool(v) for k, v in raw.items()} if isinstance(raw, dict) else {}


def _opencode_mcp_entries(request: Request, client_token: str,
                          uid: Optional[int] = None) -> dict:
    """``{"elpis-git": {...}, "elpis-browser": {...}, …}`` — une entrée par
    famille exposée, ou ``{}`` s'il n'y a rien à publier."""
    base = _opencode_mcp_url(request)
    if not base or not client_token:
        return {}
    from shared_infra.mcp.families import opencode_families
    families = opencode_families()
    live = _live_families()
    if live is not None:
        families = [f for f in families if f in live]
    prefs = _family_prefs(uid)
    headers = {"Authorization": f"Bearer {client_token}"}
    entries = {opencode_mcp_server_name(f): {
        "type": "remote",
        "url": f"{base.rstrip('/')}/{f}",
        "enabled": bool(prefs.get(f, True)),
        "headers": dict(headers),
    } for f in families}
    # (2026-09-05) Serveurs MCP locaux ADDITIONNELS déclarés en JSON
    # (``mcp.local_servers``, ``expose_opencode: true``, transport réseau) :
    # publiés tels quels, avec LEUR propre URL/en-têtes. C'est le point
    # d'extension « ajouter un MCP local dans le futur » — sans toucher au
    # service intégré ni aux serveurs externes.
    try:
        from shared_infra.mcp.local_registry import opencode_local_servers, opencode_entry_for
        for d in opencode_local_servers():
            name = str(d.get("name") or "").strip()
            if name and name not in entries:
                entries[name] = opencode_entry_for(d)
    except Exception:                                            # noqa: BLE001
        pass
    return entries


def _client_token_for(request: Request) -> Optional[str]:
    """Jeton elpis-remote de l'appelant (cf. ``_client_identity``)."""
    return _client_identity(request)[0]


def _client_identity(request: Request) -> "tuple[Optional[str], Optional[int]]":
    """``(jeton elpis-remote, id du compte)`` de l'appelant : en-tête
    ``x-elpis-token`` ou ``Authorization: Bearer pcr_…`` (installeur après
    connexion), sinon la session web (jeton minté à la demande).
    ``(None, None)`` = appel anonyme. L'id sert à lire les préférences du
    compte (familles activées)."""
    try:
        from shared_infra.opencode.routes_code import _get_or_mint_token, _resolve_token
    except Exception:
        return None, None
    from shared_infra.env_compat import token_header
    tok = token_header(request.headers)
    if not tok:
        auth = (request.headers.get("authorization") or "").strip()
        if auth.lower().startswith("bearer "):
            tok = auth[7:].strip()
    if tok:
        uid = _resolve_token(tok)
        return (tok, int(uid)) if uid is not None else (None, None)
    try:
        from shared_infra.security.deps import require_user_id
        uid = require_user_id(request)
    except Exception:
        return None, None                          # pas de session (ou middleware absent)
    try:
        return _get_or_mint_token(int(uid)), int(uid)
    except Exception:
        return None, None


def _resolve_bundle(os_key: str) -> Optional[Path]:
    """Artefact pour l'OS dans le dossier dist (containment vérifié), ou None."""
    norm = _OS_ALIASES.get((os_key or "").strip().lower())
    if not norm:
        return None
    dist = _dist_dir()
    for m in sorted(glob.glob(str(dist / f"opencode-{norm}.*"))):
        p = Path(m).resolve()
        try:
            p.relative_to(dist)          # borne au dossier dist (défense en profondeur)
        except ValueError:
            continue
        if p.is_file():
            return p
    return None


# Forme STRICTE d'une base URL : http(s)://host[:port], uniquement des caractères
# sûrs. Le Host header est contrôlable par le client → on REFUSE tout ce qui pourrait
# casser le script shell/PowerShell rendu (quote, ;, espace, backtick, $, …).
_SAFE_BASE_RE = re.compile(r"^https?://[A-Za-z0-9.\-]+(:\d{1,5})?$")


def _base_url(request: Request) -> str:
    """URL réellement contactée par le client (Host LAN), sans slash final — pour
    que les scripts téléchargent le bundle depuis le MÊME hôte (offline-LAN).

    SÉCURITÉ : ``request.base_url`` dérive du Host header (non fiable). On la VALIDE
    contre une forme stricte avant de l'interpoler dans les scripts install.sh/ps1,
    sinon un Host malveillant injecterait des commandes (RCE sur la machine cible)."""
    raw = str(request.base_url).rstrip("/")
    if not _SAFE_BASE_RE.match(raw):
        raise HTTPException(400, "Hôte invalide.")
    return raw


def _app_url(request: Request) -> str:
    """URL par laquelle l'app doit être CONTACTÉE ensuite (plugin elpis-remote).

    Distincte de :func:`_base_url` (= base des téléchargements) : l'amorçage
    passe volontairement en clair sur :80, mais le plugin, lui, doit taper
    l'app sur son vrai port. Si ``security.https.enabled``, c'est le frontal
    Caddy (https, port ``https.main_port``) — quel que soit le schéma par
    lequel ce script a été récupéré. Sinon, l'origine contactée convient.
    """
    base = _base_url(request)
    try:
        from shared_infra.config import https_enabled, https_ports
        if not https_enabled():
            return base
        port = int((https_ports() or {}).get("main") or 443)
    except Exception:
        return base
    host = base.split("://", 1)[1].split(":", 1)[0]
    return f"https://{host}" if port == 443 else f"https://{host}:{port}"


# Templates rendus (raw-strings + ``.replace("__BASE__", base)``) — PAS de
# f-string : le corps shell/PowerShell contient des ``{}`` (blocs, groupes) et
# des ``\`` (chemins Windows) qu'un f-string forcerait à doubler. ``base`` et
# ``app_url`` sont dérivés de ``_base_url()`` (validé AVANT interpolation :
# défense anti-injection) et sont les SEULES substitutions — aucun autre input
# utilisateur n'entre ici.
_INSTALL_SH_TEMPLATE = r"""#!/usr/bin/env bash
set -euo pipefail
# Installeur OpenCode — servi par __BASE__ (réseau local).
BASE="__BASE__"        # base des TÉLÉCHARGEMENTS (http en amorçage clair)
APP_URL="__APP_URL__"  # URL de l'app pour le plugin (https si frontal TLS)
case "$(uname -s)" in
  Linux*)  OS=linux ;;
  Darwin*) OS=macos ;;
  *) echo "OS non géré par ce script ; utilise le téléchargement direct dans l'app." >&2; exit 1 ;;
esac
BIN_DIR="${OPENCODE_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$BIN_DIR"
# Défini ICI (et plus au moment d'écrire la config) : la CA locale y est déposée
# dès sa récupération, donc AVANT de savoir si le plugin sera installé. Elle doit
# survivre au script — c'est le fichier que le plugin épingle.
CFG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
mkdir -p "$CFG_DIR"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
# ── HTTPS (frontal Caddy, cert LAN auto-signé) ──
# En amorçage clair (BASE en http, cf. deploy/caddy › @bootstrap) les
# téléchargements n'ont AUCUN TLS à gérer. La CA locale n'est récupérée que si
# un https est en jeu : l'app (APP_URL — le plugin lui parlera) et/ou les
# téléchargements eux-mêmes (BASE https = commande historique).
CURL_TLS=""
CA_FILE=""
# Récupération de la CA : deux sources, la seconde rattrape les déploiements
# SANS frontal :80 (HTTPS direct, port 80 filtré) où l'ancienne version ne
# trouvait rien et tombait sur « -k » pour de bon.
#   1. http://<hôte>/ca.crt      — publié en clair par Caddy (deploy/caddy)
#   2. <app>/api/cli/ca.crt      — servi par l'app elle-même (toujours joignable)
# Les deux sont des canaux NON authentifiés : c'est un amorçage de confiance
# (TOFU), au même niveau de risque qu'un « -k » ponctuel. La différence est
# décisive pour la suite : une fois la CA en main, TOUT ce qui parle à l'app est
# réellement vérifié — au lieu de désactiver la vérification à demeure.
ca_looks_valid() { grep -q 'BEGIN CERTIFICATE' "$1" 2>/dev/null; }
CA_DST="$CFG_DIR/elpis-ca.crt"
fetch_ca() {
  _h="${APP_URL#*://}"; _h="${_h%%[:/]*}"
  for _u in "http://$_h/ca.crt" "$BASE/api/cli/ca.crt" "$APP_URL/api/cli/ca.crt"; do
    if curl -fsSk -m 5 "$_u" -o "$TMP/ca.crt" 2>/dev/null && ca_looks_valid "$TMP/ca.crt"; then
      # Emplacement DURABLE tout de suite : $TMP disparaît à la sortie du script,
      # or c'est ce chemin que le plugin épingle (`ca_file`) et que l'utilisateur
      # peut réutiliser (`curl --cacert`, git, etc.).
      cp "$TMP/ca.crt" "$CA_DST" && chmod 644 "$CA_DST" 2>/dev/null || true
      CA_FILE="$CA_DST"
      echo "CA locale récupérée ($_u) → $CA_DST"
      return 0
    fi
  done
  rm -f "$TMP/ca.crt"
  return 1
}
case "$BASE $APP_URL" in
  *https://*) fetch_ca || echo "⚠ CA locale introuvable (ni :80, ni /api/cli/ca.crt)." ;;
esac
# ── Confiance SYSTÈME — comportement PAR DÉFAUT ──────────────────────────────
# C'est LE bon geste sur un réseau local sans Internet : l'amorçage se fait en
# clair (rien à vérifier), puis la CA de l'app est installée SUR LE POSTE. Après
# quoi `curl`, `git`, `wget` et le navigateur parlent à l'app en https vérifié —
# plus aucun `-k` nulle part, et le certificat retrouve son rôle.
# Épingler seul (ca_file) ne soigne que ce script et le plugin ; tous les autres
# outils continuaient de refuser le certificat.
# Opt-out explicite : ELPIS_TRUST_CA=n.
trust_ca_system() {
  [ -n "$CA_FILE" ] || return 1
  if [ -d /usr/local/share/ca-certificates ]; then
    _dst=/usr/local/share/ca-certificates/elpis-local-ca.crt; _upd="update-ca-certificates"
  elif [ -d /etc/pki/ca-trust/source/anchors ]; then
    _dst=/etc/pki/ca-trust/source/anchors/elpis-local-ca.crt; _upd="update-ca-trust extract"
  else
    return 1
  fi
  # ⚠ stdin de ce script EST le tube de curl : un `sudo` qui demande un mot de
  # passe le lirait DANS LE SCRIPT (et l'exécuterait ensuite comme du shell).
  # D'où : root direct, sinon sudo NON interactif (-n), sinon sudo branché sur
  # le terminal réel — jamais sur le tube.
  _run_priv() {
    # Les tentatives NON interactives sont muettes : on explique nous-mêmes
    # l'échec, un « cp: Permission denied » brut ne ferait qu'ajouter du bruit.
    # Le sudo interactif, lui, garde sa sortie — sinon son invite de mot de passe
    # serait invisible et l'utilisateur croirait le script figé.
    if [ "$(id -u)" = 0 ]; then "$@" 2>/dev/null; return $?; fi
    command -v sudo >/dev/null 2>&1 || return 1
    sudo -n "$@" 2>/dev/null && return 0
    ( : < /dev/tty ) 2>/dev/null || return 1
    sudo "$@" < /dev/tty
  }
  _run_priv cp "$CA_FILE" "$_dst" || return 1
  _run_priv chmod 644 "$_dst" || true
  # shellcheck disable=SC2086  # _upd peut valoir « update-ca-trust extract »
  _run_priv $_upd >/dev/null 2>&1 || return 1
  return 0
}
ca_already_trusted() {
  # Déjà dans le magasin ? Alors il n'y a rien à faire, et surtout rien à
  # demander : une ré-install sur un poste déjà configuré doit être muette.
  curl -fsS -m 5 --head "$APP_URL/api/public-config" >/dev/null 2>&1
}
if [ -n "$CA_FILE" ]; then
  WANT_TRUST=y                       # défaut : on configure le poste
  case "${ELPIS_TRUST_CA:-}" in [nN0]*) WANT_TRUST=n ;; esac
  if ca_already_trusted; then
    echo "Certificat de $APP_URL déjà reconnu par ce poste — rien à installer."
  elif [ "$WANT_TRUST" = n ]; then
    echo "CA non ajoutée au magasin système (ELPIS_TRUST_CA=n) — elle reste épinglée pour opencode."
  elif trust_ca_system; then
    echo "CA installée dans le magasin système — https vérifié partout sur ce poste (curl, git, navigateur)."
  else
    # Échec = droits absents ou distribution non gérée. La CA est là, le geste
    # est à un pas : on donne la commande exacte plutôt qu'un simple constat.
    echo "⚠ Impossible d'installer la CA dans le magasin système (droits administrateur requis)."
    echo "  opencode et son greffon fonctionnent quand même (CA épinglée : $CA_FILE)."
    if [ -d /etc/pki/ca-trust/source/anchors ]; then
      echo "  Pour les autres outils :  sudo cp '$CA_FILE' /etc/pki/ca-trust/source/anchors/elpis-local-ca.crt && sudo update-ca-trust extract"
    else
      echo "  Pour les autres outils :  sudo cp '$CA_FILE' /usr/local/share/ca-certificates/elpis-local-ca.crt && sudo update-ca-certificates"
    fi
  fi
fi
if [ "${BASE#https://}" != "$BASE" ]; then
  if curl -fsS -m 5 --head "$BASE/api/cli/opencode.json" >/dev/null 2>&1; then
    : # certificat vérifiable — rien à faire
  elif [ -n "$CA_FILE" ] \
       && curl -fsS -m 5 --cacert "$CA_FILE" --head "$BASE/api/cli/opencode.json" >/dev/null 2>&1; then
    CURL_TLS="--cacert $CA_FILE"
    echo "Téléchargements https vérifiés via la CA locale."
  else
    # Deux causes bien distinctes, et l'ancien message les confondait (« CA
    # introuvable » alors qu'on venait d'en récupérer une) : une CA qui ne signe
    # PAS le certificat de l'app, c'est un autre service sur le port 80 ou une
    # PKI régénérée — pas la même consigne pour l'administrateur.
    if [ -n "$CA_FILE" ]; then
      echo "⚠ La CA récupérée ne valide PAS le certificat de $BASE (autre service sur :80, ou PKI régénérée)."
      # Ni épinglée, ni laissée sur le disque : le plugin échouerait à chaque
      # appel, et un fichier « elpis-ca.crt » erroné est un piège pour la suite.
      CA_FILE=""; rm -f "$CA_DST"
    else
      echo "⚠ Certificat https non vérifiable et aucune CA locale joignable."
    fi
    CURL_TLS="-k"
    echo "  → mode non vérifié (-k) pour cette installation."
  fi
fi
fetch()  { curl -fSL  $CURL_TLS "$@"; }
fetchq() { curl -fsSL $CURL_TLS "$@"; }
# Options TLS pour parler à l'APP (≠ base des téléchargements) : en amorçage
# clair BASE est en http donc CURL_TLS est vide, alors qu'APP_URL peut être en
# https derrière Caddy — s'en servir tel quel ferait échouer la connexion au
# compte sur un cert auto-signé.
APP_TLS=""
if [ "${APP_URL#https://}" != "$APP_URL" ]; then
  if curl -fsS -m 5 --head "$APP_URL/api/public-config" >/dev/null 2>&1; then
    :                                             # cert vérifiable
  elif [ -n "$CA_FILE" ]; then
    APP_TLS="--cacert $CA_FILE"
  else
    APP_TLS="-k"
  fi
fi
echo "Téléchargement d'OpenCode ($OS) depuis $BASE ..."
fetch "$BASE/api/cli/bundle/$OS" -o "$TMP/opencode.bundle"
# Détecte l'archive (tar.gz / zip) ou un binaire brut.
if tar tzf "$TMP/opencode.bundle" >/dev/null 2>&1; then
  # --no-same-owner : l'archive porte l'uid/gid de la machine qui l'a fabriquée.
  # Sous root — ou dans un conteneur / espace de noms utilisateur — tar essaie
  # de le restaurer et ÉCHOUE (« Cannot change ownership »), ce qui interrompt
  # toute l'installation. Les fichiers doivent appartenir à qui installe.
  tar xzf "$TMP/opencode.bundle" -C "$TMP" --no-same-owner
elif command -v unzip >/dev/null 2>&1 && unzip -tq "$TMP/opencode.bundle" >/dev/null 2>&1; then
  unzip -q "$TMP/opencode.bundle" -d "$TMP"
else
  cp "$TMP/opencode.bundle" "$TMP/opencode"
fi
BIN="$(find "$TMP" -type f -name 'opencode' | head -n1 || true)"
[ -n "$BIN" ] || BIN="$TMP/opencode"
install -m 0755 "$BIN" "$BIN_DIR/opencode"
echo "OpenCode installé : $BIN_DIR/opencode"
# ── Config Elpis : récupérée À CHAUD depuis le serveur (modèles + endpoint courants). ──
# À défaut (offline / serveur down), repli sur le opencode.json embarqué dans l'archive.
# (CFG_DIR est défini plus haut : la CA locale y est déposée dès sa récupération.)
CFG_DST="$CFG_DIR/opencode.json"
CFG_SRC=""
if fetchq "$BASE/api/cli/opencode.json" -o "$TMP/opencode.fresh.json" 2>/dev/null; then
  CFG_SRC="$TMP/opencode.fresh.json"
  echo "Config Elpis à jour récupérée depuis $BASE."
else
  CFG_SRC="$(find "$TMP" -type f -name 'opencode.json' | head -n1 || true)"
  [ -n "$CFG_SRC" ] && echo "Config live indisponible — repli sur la config embarquée (offline)."
fi
if [ -n "$CFG_SRC" ]; then
  mkdir -p "$CFG_DIR"
  if [ -f "$CFG_DST" ]; then
    cp "$CFG_DST" "$CFG_DST.bak"
    echo "Ancienne config sauvegardée : $CFG_DST.bak"
  fi
  cp "$CFG_SRC" "$CFG_DST"
  echo "Config Elpis installée (à jour) : $CFG_DST"
fi
# ── Pré-amorçage des dépendances de plugin — LE correctif « opencode met 1 min
#    à démarrer ». Dès qu'un plugin est présent, opencode lance un `npm install
#    @opencode-ai/plugin` dans CHAQUE dossier de config et BLOQUE le chargement
#    des plugins dessus (config.ts › waitForDependencies). Mesuré ici : 30 s en
#    1.17.7, 71 s en 1.18.16 au premier lancement AVEC Internet — et un blocage
#    de plusieurs minutes quand le réseau ne répond pas (pare-feu qui drop), ce
#    qui est exactement le cas d'un déploiement LAN sans Internet.
#    opencode saute complètement l'install si `node_modules` existe ET que les
#    dépendances déclarées figurent dans le lock (core/src/npm.ts › install) :
#    trois fichiers suffisent, aucun paquet à télécharger. Vérifié réseau coupé :
#    démarrage 8,6 s au lieu de « jamais ».
seed_node_deps() {
  [ -d "$1" ] || return 0
  [ -e "$1/node_modules" ] && return 0        # déjà installé — ne rien toucher
  mkdir -p "$1/node_modules" || return 0
  [ -f "$1/package.json" ] || printf '{\n  "dependencies": { "@opencode-ai/plugin": "%s" }\n}\n' "$2" > "$1/package.json"
  [ -f "$1/package-lock.json" ] || printf '{ "name": "opencode-config", "lockfileVersion": 3, "requires": true,\n  "packages": { "": { "dependencies": { "@opencode-ai/plugin": "%s" } } } }\n' "$2" > "$1/package-lock.json"
  echo "Dépendances de plugin pré-amorcées ($1) — démarrage immédiat hors ligne."
}
# `|| true` DANS le groupe : avec `set -o pipefail`, un binaire absent (127)
# ferait échouer tout le script sur cette simple lecture de version.
OC_VERSION="$({ "$BIN_DIR/opencode" --version 2>/dev/null || true; } | tr -d '\r' | head -n1)"
case "$OC_VERSION" in ''|*[!0-9.]*) OC_VERSION="1.0.0" ;; esac
seed_node_deps "$CFG_DIR" "$OC_VERSION"
# ── Plugin elpis-remote (TypeScript, chargé nativement par opencode) : sessions
#    remontées/pilotables depuis la page « Code ». Choix EXPLICITE : prompt Y/n
#    (via /dev/tty — stdin est le pipe du curl), surchargé par
#    ELPIS_INSTALL_PLUGIN=y|n ; défaut = y — ce script est servi PAR l'app, donc
#    l'intention est claire. (Le jeton ne sert plus d'indice : la commande
#    d'install est désormais anonyme, l'appairage se fait après coup via
#    « /remote login ».)
PLUGIN_DIR="$CFG_DIR/plugin"
WANT_PLUGIN=""
case "${ELPIS_INSTALL_PLUGIN:-}" in
  [yYoO1]*) WANT_PLUGIN=y ;;
  [nN0]*)   WANT_PLUGIN=n ;;
esac
if [ -z "$WANT_PLUGIN" ]; then
  DEF=y
  # ( : </dev/tty ) OUVRE réellement le tty : vrai test d'interactivité — un
  # [ -r /dev/tty ] seul est vrai même sans terminal contrôlant (cron/daemon).
  if ( : < /dev/tty ) 2>/dev/null; then
    if [ "$DEF" = y ]; then HINT="[Y/n]"; else HINT="[y/N]"; fi
    printf 'Installer le plugin elpis-remote (pilotage depuis la page Remote code) ? %s ' "$HINT" > /dev/tty 2>/dev/null || true
    read -r REPLY < /dev/tty || REPLY=""
    case "$REPLY" in
      [yYoO]*) WANT_PLUGIN=y ;;
      [nN]*)   WANT_PLUGIN=n ;;
      *)       WANT_PLUGIN=$DEF ;;
    esac
  else
    WANT_PLUGIN=$DEF
    echo "(non interactif : plugin elpis-remote = $WANT_PLUGIN — forcer avec ELPIS_INSTALL_PLUGIN=y|n)"
  fi
fi
if [ "$WANT_PLUGIN" = y ]; then
  if fetchq "$BASE/api/code/plugin.ts" -o "$TMP/elpis-remote.ts" 2>/dev/null; then
    mkdir -p "$PLUGIN_DIR"
    cp "$TMP/elpis-remote.ts" "$PLUGIN_DIR/elpis-remote.ts"
    # ère pré-TypeScript : jamais DEUX plugins chargés (opencode glob *.{ts,js})
    rm -f "$PLUGIN_DIR/elpis-remote.js" "$PLUGIN_DIR/elpis-remote.js.bak"
    echo "Plugin elpis-remote installé : $PLUGIN_DIR/elpis-remote.ts"
  else
    echo "⚠ Plugin elpis-remote non récupéré ($BASE/api/code/plugin.ts) —"
    echo "  serveur pas à jour ou fonctionnalité désactivée ; relancez ce script après mise à jour."
  fi
else
  echo "Plugin elpis-remote non installé (choix)."
  if [ -e "$PLUGIN_DIR/elpis-remote.ts" ] || [ -e "$PLUGIN_DIR/elpis-remote.js" ]; then
    rm -f "$PLUGIN_DIR/elpis-remote.ts" "$PLUGIN_DIR/elpis-remote.ts.bak" \
          "$PLUGIN_DIR/elpis-remote.js" "$PLUGIN_DIR/elpis-remote.js.bak"
    echo "  Ancien plugin retiré ($PLUGIN_DIR) — opencode redevient 100 % local."
  fi
fi
# ── Conf elpis-remote : écrite DÈS que le plugin est installé, même SANS jeton.
#    La commande d'install est anonyme (aucun secret à copier) ; ce qu'elle pose
#    ici c'est la CIBLE (app_url) et le TLS (CA locale épinglée, sinon repli non
#    vérifié) — sans quoi le plugin se rabattrait sur « insecure » à la première
#    erreur de certificat. Le jeton arrive après, via « /remote login ».
if [ "$WANT_PLUGIN" = y ]; then
  RJSON="$CFG_DIR/elpis-remote.json"
  KEEP=false
  grep -qs '"enabled": *true' "$RJSON" 2>/dev/null && KEEP=true   # ré-install : garder l'état actif
  # Jeton : l'env s'il est fourni, sinon CELUI DÉJÀ APPAIRÉ — une ré-install ne
  # doit pas désappairer un poste qui marchait.
  TOKEN="${ELPIS_REMOTE_TOKEN:-}"
  if [ -z "$TOKEN" ] && [ -f "$RJSON" ]; then
    TOKEN="$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$RJSON" | head -n1)"
  fi
  # ── Connexion au compte, ICI et pas dans opencode ──────────────────────────
  # L'API plugin d'opencode n'a AUCUNE primitive de saisie : un mot de passe
  # passé à /remote arriverait par la ligne de commande du TUI (affiché à
  # l'écran, conservé dans l'historique de commandes). Ce script, lui, tourne
  # dans un vrai shell : `read -rs` masque la frappe. On échange donc les
  # identifiants contre le jeton une bonne fois, et /remote marche ensuite seul.
  # Le mot de passe n'est JAMAIS écrit sur disque ni passé en argument.
  if [ -z "$TOKEN" ] && ( : < /dev/tty ) 2>/dev/null; then
    printf 'Connecter votre compte %s maintenant ? [Y/n] ' "$APP_URL" > /dev/tty
    read -r WANT_LOGIN < /dev/tty || WANT_LOGIN=""
    case "$WANT_LOGIN" in [nN]*) WANT_LOGIN=n ;; *) WANT_LOGIN=y ;; esac
    if [ "$WANT_LOGIN" = y ]; then
      COOKIES="$TMP/cookies.txt"
      for _try in 1 2 3; do
        printf '  Identifiant : ' > /dev/tty
        read -r LOGIN_USER < /dev/tty || LOGIN_USER=""
        printf '  Mot de passe : ' > /dev/tty
        # -s : frappe masquée. Le retour chariot n'étant pas affiché, on le pose.
        stty -echo 2>/dev/null < /dev/tty
        read -r LOGIN_PASS < /dev/tty || LOGIN_PASS=""
        stty echo 2>/dev/null < /dev/tty
        printf '\n' > /dev/tty
        [ -n "$LOGIN_USER" ] && [ -n "$LOGIN_PASS" ] || { echo "  Identifiants vides."; continue; }
        # Les identifiants partent en corps JSON (jamais dans l'URL : elle
        # finirait dans les access logs). --data @- via stdin plutôt qu'en
        # argument : la ligne de commande curl est lisible dans `ps`.
        LOGIN_BODY="$(LOGIN_USER="$LOGIN_USER" LOGIN_PASS="$LOGIN_PASS" awk 'BEGIN{
          u=ENVIRON["LOGIN_USER"]; p=ENVIRON["LOGIN_PASS"];
          gsub(/\\/,"\\\\",u); gsub(/"/,"\\\"",u);
          gsub(/\\/,"\\\\",p); gsub(/"/,"\\\"",p);
          printf "{\"username\":\"%s\",\"password\":\"%s\"}", u, p }')"
        LOGIN_PASS=""   # plus besoin en mémoire du shell
        if printf '%s' "$LOGIN_BODY" | curl -fsS $APP_TLS -c "$COOKIES" \
             -H 'Content-Type: application/json' --data @- \
             "$APP_URL/api/login-lite" > /dev/null 2>&1; then
          LOGIN_BODY=""
          TOKEN="$(curl -fsS $APP_TLS -b "$COOKIES" "$APP_URL/api/code/config" 2>/dev/null \
                   | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
          if [ -n "$TOKEN" ]; then
            echo "  ✓ Connecté ($LOGIN_USER) — jeton configuré."
            break
          fi
          echo "  Connexion réussie mais jeton indisponible (fonctionnalité Code désactivée ?)."
          break
        fi
        LOGIN_BODY=""
        echo "  ✗ Identifiants refusés."
      done
      rm -f "$COOKIES"
    fi
  fi
  # app_url = APP_URL (pas BASE) : l'amorçage peut être en clair alors que
  # l'app, elle, n'écoute qu'en https derrière Caddy.
  # La CA est DÉJÀ à sa place définitive ($CA_DST, posée à la récupération) —
  # ne pas la recopier ici : `cp` sur lui-même échouerait, et le script est en
  # `set -e`. On ne fait qu'écrire le chemin.
  TLS_JSON=""
  if [ -n "$CA_FILE" ]; then
    TLS_JSON=',\n  "ca_file": "'"$CA_FILE"'"'
  elif [ "${APP_URL#https://}" != "$APP_URL" ]; then
    TLS_JSON=',\n  "insecure": true'
  fi
  printf '{\n  "app_url": "%s",\n  "token": "%s",\n  "enabled": %s%b\n}\n' \
    "$APP_URL" "$TOKEN" "$KEEP" "$TLS_JSON" > "$RJSON"
  if [ -n "$TOKEN" ]; then
    echo "Jeton elpis-remote configuré ($RJSON)."
    echo "→ Dans opencode, tapez simplement /remote pour remonter votre session dans la page « Code »."
    # ── Outils Elpis (MCP) : la config est re-récupérée AVEC le jeton du compte
    #    (vers l'APP, TLS vérifié — jamais sur l'amorçage en clair) : le serveur
    #    y ajoute le bloc ``mcp`` si son service d'outils est partagé et
    #    authentifié. Sinon (service non exposé) la config posée plus haut reste.
    if curl -fsS $APP_TLS -m 10 -H "x-elpis-token: $TOKEN" "$APP_URL/api/cli/opencode.json" \
         -o "$TMP/opencode.user.json" 2>/dev/null && grep -q '"mcp"' "$TMP/opencode.user.json"; then
      cp "$TMP/opencode.user.json" "$CFG_DST"
      echo "Outils Elpis (MCP, au nom de ${LOGIN_USER:-votre compte}) ajoutés à $CFG_DST."
    else
      echo "Outils Elpis (MCP) non exposés par ce serveur — config opencode inchangée."
    fi
  else
    echo "Cible elpis-remote configurée ($RJSON) — pas encore de jeton."
    echo "→ Dans opencode, tapez /remote login : un code s'affiche, à saisir dans la page « Code » de l'app."
  fi
fi
# ── PATH : ajout idempotent aux fichiers rc du shell (gardé par un marqueur). ──
case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *)
    ADDED=""
    for RC in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile" "$HOME/.bash_profile"; do
      # .bashrc est créé s'il manque ; les autres ne sont touchés que s'ils existent.
      if [ ! -e "$RC" ] && [ "$RC" != "$HOME/.bashrc" ]; then continue; fi
      if grep -qs 'OPENCODE_ELPIS_PATH' "$RC" 2>/dev/null; then continue; fi
      {
        echo ''
        echo '# OPENCODE_ELPIS_PATH (installeur OpenCode)'
        echo 'case ":$PATH:" in *":'"$BIN_DIR"':"*) ;; *) export PATH="'"$BIN_DIR"':$PATH" ;; esac'
      } >> "$RC"
      ADDED="$ADDED $RC"
    done
    if [ -n "$ADDED" ]; then
      echo "PATH mis à jour dans :$ADDED"
      echo "→ Ouvrez un nouveau terminal, ou lancez : source $HOME/.bashrc"
    elif grep -qs 'OPENCODE_ELPIS_PATH' "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile" "$HOME/.bash_profile" 2>/dev/null; then
      echo "PATH déjà configuré (relance un terminal pour en profiter)."
    else
      echo "→ Ajoutez $BIN_DIR à votre PATH."
    fi
    ;;
esac
"""

_INSTALL_PS1_TEMPLATE = r"""# Installeur OpenCode -- servi par __BASE__ (reseau local).
# NOTE : ce script doit rester 100% ASCII. PowerShell 5.1 (Win10/11) lit un
# .ps1 sans BOM en ANSI : un caractere accentue UTF-8 s'y decode en deux
# octets dont l'un peut FERMER une chaine et casser le parsing du fichier
# entier. Garde-fou cote serveur dans cli_install_ps1().
$ErrorActionPreference = 'Stop'
$Base   = '__BASE__'      # base des TELECHARGEMENTS (http en amorcage clair)
$AppUrl = '__APP_URL__'   # URL de l'app pour le plugin (https si frontal TLS)
# --- HTTPS (frontal Caddy, cert LAN auto-signe) : rien a faire tant qu'AUCUNE
# des deux URL n'est en https. En amorcage clair $Base est en http, mais $AppUrl
# peut etre en https (frontal TLS) -- et c'est LUI qu'on contacte pour connecter
# le compte : ne tester que $Base laissait cet appel echouer sur le cert.
# Si la verification echoue, on la desactive POUR CE SCRIPT
# (PS7 : SkipCertificateCheck ; PS5.1 : callback compile).
$Insecure = $false
if (($Base -like 'https://*') -or ($AppUrl -like 'https://*')) {
  if ($PSVersionTable.PSVersion.Major -lt 6) {
    # .NET Framework peut demarrer SANS TLS 1.2 alors que Caddy exige TLS >= 1.2
    # ("The underlying connection was closed") -- a activer AVANT tout appel.
    # 3072 = Tls12 (valeur numerique : l'enum manque sur les vieux .NET).
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
  }
  # Sonde l'URL https REELLEMENT en jeu (les deux si besoin).
  $ProbeUrl = if ($Base -like 'https://*') { "$Base/api/cli/opencode.json" } else { "$AppUrl/api/public-config" }
  try { Invoke-WebRequest -UseBasicParsing -Method Head -Uri $ProbeUrl -TimeoutSec 5 | Out-Null }
  catch {
    $Insecure = $true
    if ($PSVersionTable.PSVersion.Major -ge 6) {
      $PSDefaultParameterValues['Invoke-WebRequest:SkipCertificateCheck'] = $true
      # Invoke-RestMethod (lecture du jeton) est une AUTRE cmdlet : sans cette
      # 2e entree, elle repasserait par la verification et echouerait.
      $PSDefaultParameterValues['Invoke-RestMethod:SkipCertificateCheck'] = $true
    } else {
      # PAS de scriptblock { $true } : .NET peut invoquer le callback sur un
      # thread SANS runspace PowerShell -> handshake avorte ("The underlying
      # connection was closed"). Callback C# COMPILE (Add-Type) = thread-safe.
      if (-not ('ElpisTrustAll' -as [type])) {
        Add-Type 'using System.Net;public class ElpisTrustAll{public static void Go(){ServicePointManager.ServerCertificateValidationCallback=delegate{return true;};}}'
      }
      [ElpisTrustAll]::Go()
    }
    Write-Host "Certificat https non verifiable (CA locale) -- verification desactivee pour ce script."
  }
}
# --- CA locale : recuperee TOT (avant tout le reste) et proposee au magasin de
# confiance de l'utilisateur. C'est la vraie alternative a -k / SkipCertificate :
# une fois la CA approuvee, curl, git, le navigateur et opencode verifient
# reellement le certificat de l'app. Deux sources, la 2e rattrape les
# deploiements sans frontal :80 (https direct, port 80 filtre).
$CfgDir = Join-Path $env:USERPROFILE '.config\opencode'
New-Item -ItemType Directory -Force -Path $CfgDir | Out-Null
$CaFile = $null
if (($AppUrl -like 'https://*') -or ($Base -like 'https://*')) {
  # Emplacement DURABLE tout de suite : c'est ce chemin que le greffon epingle
  # (ca_file) et que l'utilisateur peut reutiliser ensuite.
  $CaDst = Join-Path $CfgDir 'elpis-ca.crt'
  foreach ($u in @(("http://" + ([uri]$AppUrl).Host + "/ca.crt"), "$Base/api/cli/ca.crt", "$AppUrl/api/cli/ca.crt")) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $u -OutFile $CaDst -TimeoutSec 10
      if ((Get-Content $CaDst -Raw) -match 'BEGIN CERTIFICATE') {
        $CaFile = $CaDst; Write-Host "CA locale recuperee ($u) -> $CaDst"; break
      }
    } catch {}
  }
  if (-not $CaFile) {
    Remove-Item -Force -ErrorAction SilentlyContinue $CaDst
    Write-Host "Attention : CA locale introuvable (ni :80, ni /api/cli/ca.crt)."
  }
}
# --- Confiance du poste : comportement PAR DEFAUT (opt-out ELPIS_TRUST_CA=n).
# Reseau local sans Internet : on amorce en clair, puis on installe la CA SUR LE
# POSTE. Ensuite curl, git et le navigateur parlent a l'app en https verifie --
# plus aucun -k, et le certificat retrouve son role. Cert:\CurrentUser\Root est
# le magasin de l'UTILISATEUR : aucun droit administrateur (Windows affiche une
# confirmation de securite, c'est normal et voulu). ---
if ($CaFile) {
  $AlreadyTrusted = $false
  try {
    Invoke-WebRequest -UseBasicParsing -Method Head -Uri "$AppUrl/api/public-config" -TimeoutSec 5 | Out-Null
    $AlreadyTrusted = $true
  } catch {}
  if ($AlreadyTrusted) {
    Write-Host "Certificat de $AppUrl deja reconnu par ce poste -- rien a installer."
  } elseif ($env:ELPIS_TRUST_CA -match '^[nN0]') {
    Write-Host "CA non ajoutee au magasin (ELPIS_TRUST_CA=n) -- elle reste epinglee pour opencode."
  } else {
    try {
      Import-Certificate -FilePath $CaFile -CertStoreLocation Cert:\CurrentUser\Root -ErrorAction Stop | Out-Null
      Write-Host "CA installee dans le magasin de confiance utilisateur -- https verifie partout sur ce poste."
    } catch {
      Write-Host "Attention : installation de la CA refusee ou impossible."
      Write-Host "  opencode et son greffon fonctionnent quand meme (CA epinglee : $CaFile)."
      Write-Host "  Pour les autres outils : Import-Certificate -FilePath '$CaFile' -CertStoreLocation Cert:\CurrentUser\Root"
    }
  }
}
$BinDir = if ($env:OPENCODE_BIN_DIR) { $env:OPENCODE_BIN_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\opencode' }
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$Tmp = (New-Item -ItemType Directory -Force -Path (Join-Path $env:TEMP ('opencode-' + [guid]::NewGuid()))).FullName
$Bundle = Join-Path $Tmp 'opencode.zip'
Write-Host "Telechargement d'OpenCode (windows) depuis $Base ..."
Invoke-WebRequest -UseBasicParsing -Uri "$Base/api/cli/bundle/windows" -OutFile $Bundle
try { Expand-Archive -Force -Path $Bundle -DestinationPath $Tmp } catch { Copy-Item $Bundle (Join-Path $Tmp 'opencode.exe') -Force }
$Exe = Get-ChildItem -Path $Tmp -Recurse -Filter 'opencode*.exe' | Select-Object -First 1
if (-not $Exe) { $Exe = Get-Item (Join-Path $Tmp 'opencode.exe') }
Copy-Item $Exe.FullName (Join-Path $BinDir 'opencode.exe') -Force
Write-Host "OpenCode installe : $BinDir\opencode.exe"
# --- Config Elpis : recuperee A CHAUD depuis le serveur (modeles + endpoint courants). ---
# ($CfgDir est defini plus haut : la CA y est deposee des sa recuperation.)
$CfgDst = Join-Path $CfgDir 'opencode.json'
$CfgSrc = $null
try {
  $Fresh = Join-Path $Tmp 'opencode.fresh.json'
  Invoke-WebRequest -UseBasicParsing -Uri "$Base/api/cli/opencode.json" -OutFile $Fresh
  $CfgSrc = $Fresh
  Write-Host "Config Elpis a jour recuperee depuis $Base."
} catch {
  $c = Get-ChildItem -Path $Tmp -Recurse -Filter 'opencode.json' | Select-Object -First 1
  if ($c) { $CfgSrc = $c.FullName; Write-Host "Config live indisponible -- repli sur la config embarquee (offline)." }
}
if ($CfgSrc) {
  if (Test-Path $CfgDst) { Copy-Item $CfgDst "$CfgDst.bak" -Force; Write-Host "Ancienne config sauvegardee : $CfgDst.bak" }
  Copy-Item $CfgSrc $CfgDst -Force
  Write-Host "Config Elpis installee (a jour) : $CfgDst"
}
# --- Pre-amorcage des dependances de plugin -- LE correctif "opencode met une
#     minute a demarrer". Des qu'un plugin est present, opencode lance un
#     `npm install @opencode-ai/plugin` dans chaque dossier de config et BLOQUE
#     le chargement des plugins dessus. Mesure : 30 s (1.17.7) a 71 s (1.18.16)
#     AVEC Internet, plusieurs minutes quand le reseau ne repond pas. opencode
#     saute l'install si node_modules existe et que le lock declare la
#     dependance : trois fichiers, zero telechargement. ---
$OcVersion = "1.0.0"
try {
  $v = (& (Join-Path $BinDir 'opencode.exe') --version 2>$null | Select-Object -First 1)
  if ($v -match '^[0-9][0-9.]*$') { $OcVersion = $v.Trim() }
} catch {}
$NodeMods = Join-Path $CfgDir 'node_modules'
if (-not (Test-Path $NodeMods)) {
  New-Item -ItemType Directory -Force -Path $NodeMods | Out-Null
  $PkgJson = Join-Path $CfgDir 'package.json'
  $LockJson = Join-Path $CfgDir 'package-lock.json'
  if (-not (Test-Path $PkgJson)) {
    '{ "dependencies": { "@opencode-ai/plugin": "' + $OcVersion + '" } }' | Set-Content -Encoding UTF8 $PkgJson
  }
  if (-not (Test-Path $LockJson)) {
    '{ "name": "opencode-config", "lockfileVersion": 3, "requires": true, "packages": { "": { "dependencies": { "@opencode-ai/plugin": "' + $OcVersion + '" } } } }' | Set-Content -Encoding UTF8 $LockJson
  }
  Write-Host "Dependances de plugin pre-amorcees -- demarrage immediat hors ligne."
}
# --- Plugin elpis-remote (TypeScript, charge nativement par opencode) : choix
#    EXPLICITE Y/n -- surcharge par ELPIS_INSTALL_PLUGIN=y|n ; defaut = y (ce
#    script est servi PAR l'app, l'intention est claire). Le jeton ne sert plus
#    d'indice : la commande d'install est anonyme, l'appairage se fait apres
#    coup via /remote login. ---
$PluginDir = Join-Path $CfgDir 'plugin'
$WantPlugin = $null
if ($env:ELPIS_INSTALL_PLUGIN) {
  $WantPlugin = ($env:ELPIS_INSTALL_PLUGIN -match '^[yYoO1]')
}
if ($null -eq $WantPlugin) {
  $Def = $true
  $Hint = if ($Def) { '[Y/n]' } else { '[y/N]' }
  try {
    $r = Read-Host "Installer le plugin elpis-remote (pilotage depuis la page Remote code) ? $Hint"
    if ($r -match '^[yYoO]') { $WantPlugin = $true }
    elseif ($r -match '^[nN]') { $WantPlugin = $false }
    else { $WantPlugin = $Def }
  } catch { $WantPlugin = $Def }
}
$OldPlugin = @('elpis-remote.js', 'elpis-remote.js.bak', 'elpis-remote.ts.bak') |
  ForEach-Object { Join-Path $PluginDir $_ }
if ($WantPlugin) {
  try {
    New-Item -ItemType Directory -Force -Path $PluginDir | Out-Null
    Invoke-WebRequest -UseBasicParsing -Uri "$Base/api/code/plugin.ts" -OutFile (Join-Path $PluginDir 'elpis-remote.ts')
    # ere pre-TypeScript : jamais DEUX plugins charges (opencode glob *.{ts,js})
    Remove-Item -Force -ErrorAction SilentlyContinue $OldPlugin
    Write-Host "Plugin elpis-remote installe : $PluginDir\elpis-remote.ts"
  } catch {
    Write-Host "Plugin elpis-remote non installe (app injoignable ?) -- recuperable plus tard via $Base/api/code/plugin.ts"
  }
} else {
  Write-Host "Plugin elpis-remote non installe (choix)."
  $Leftover = @($OldPlugin + (Join-Path $PluginDir 'elpis-remote.ts')) | Where-Object { Test-Path $_ }
  if ($Leftover) { Remove-Item -Force $Leftover; Write-Host "  Ancien plugin retire ($PluginDir)." }
}
# --- Conf elpis-remote : ecrite DES que le plugin est installe, meme SANS jeton.
#     La commande d'install est anonyme ; ce qu'elle pose ici c'est la CIBLE
#     (app_url) et le TLS (CA locale epinglee). Le jeton arrive apres, via
#     /remote login. ---
if ($WantPlugin) {
  $RJson = Join-Path $CfgDir 'elpis-remote.json'
  $Keep = $false
  $Token = $env:ELPIS_REMOTE_TOKEN
  if (Test-Path $RJson) {
    try {
      $old = Get-Content $RJson -Raw | ConvertFrom-Json
      if ($old.enabled) { $Keep = $true }
      # Re-install : ne jamais desappairer un poste qui marchait.
      if (-not $Token -and $old.token) { $Token = $old.token }
    } catch {}
  }
  # CA locale : deja a sa place definitive ($CfgDir\elpis-ca.crt, posee a la
  # recuperation). On ne fait que l'EPINGLER pour que le greffon (fetch Bun)
  # verifie vraiment l'app en https au lieu de se rabattre sur "insecure" --
  # Bun n'utilise PAS le magasin de Windows, l'epinglage reste indispensable
  # meme quand la CA a ete installee sur le poste.
  $CaPinned = $CaFile
  # --- Connexion au compte, ICI et pas dans opencode ---
  # L'API plugin d'opencode n'a AUCUNE primitive de saisie : un mot de passe
  # passe a /remote arriverait par la ligne de commande du TUI (affiche a
  # l'ecran, garde dans l'historique). Ce script tourne dans un vrai shell :
  # Read-Host -AsSecureString masque la frappe. Le mot de passe n'est jamais
  # ecrit sur disque, et le SecureString est efface juste apres l'envoi.
  if (-not $Token) {
    $ans = Read-Host "Connecter votre compte $AppUrl maintenant ? [Y/n]"
    if ($ans -notmatch '^[nN]') {
      $sess = New-Object Microsoft.PowerShell.Commands.WebRequestSession
      for ($i = 0; $i -lt 3; $i++) {
        $u = Read-Host "  Identifiant"
        $sec = Read-Host "  Mot de passe" -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
        try { $pw = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
        if (-not $u -or -not $pw) { Write-Host "  Identifiants vides."; continue }
        try {
          $payload = @{ username = $u; password = $pw } | ConvertTo-Json -Compress
          $pw = $null                       # plus besoin en clair
          Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$AppUrl/api/login-lite" `
            -ContentType 'application/json' -Body $payload -WebSession $sess | Out-Null
          $payload = $null
          $cfg = Invoke-RestMethod -Uri "$AppUrl/api/code/config" -WebSession $sess
          if ($cfg.token) {
            $Token = $cfg.token
            Write-Host "  OK Connecte ($u) -- jeton configure."
            break
          }
          Write-Host "  Connexion reussie mais jeton indisponible (fonctionnalite Code desactivee ?)."
          break
        } catch {
          $pw = $null; $payload = $null
          Write-Host "  Identifiants refuses."
        }
      }
    }
  }
  # app_url = $AppUrl (PAS $Base) : l'amorcage peut etre en clair alors que
  # l'app, elle, n'ecoute qu'en https derriere Caddy.
  # token = '' (jamais $null : ConvertTo-Json ecrirait `null`, que le plugin
  # relit en `undefined` -- '' est le meme faux mais reste une chaine).
  $Conf = @{ app_url = $AppUrl; token = ''; enabled = $Keep }
  if ($Token) { $Conf.token = $Token }
  if ($CaPinned) { $Conf.ca_file = $CaPinned }                              # option tls de Bun
  elseif ($Insecure -or $AppUrl -like 'https://*') { $Conf.insecure = $true }
  $Conf | ConvertTo-Json | Set-Content -Encoding UTF8 $RJson
  if ($Token) {
    Write-Host "Jeton elpis-remote configure ($RJson)."
    Write-Host "-> Dans opencode, tapez simplement /remote pour remonter votre session dans la page Code."
    # --- Outils Elpis (MCP) : config re-recuperee AVEC le jeton du compte (bloc mcp
    #     ajoute par le serveur si son service d'outils est partage et authentifie).
    try {
      $UserCfg = Join-Path $Tmp 'opencode.user.json'
      Invoke-WebRequest -UseBasicParsing -Headers @{ 'x-elpis-token' = $Token } `
        -Uri "$AppUrl/api/cli/opencode.json" -OutFile $UserCfg
      if ((Get-Content $UserCfg -Raw) -match '"mcp"') {
        Copy-Item $UserCfg $CfgDst -Force
        Write-Host "Outils Elpis (MCP) ajoutes a $CfgDst."
      } else {
        Write-Host "Outils Elpis (MCP) non exposes par ce serveur -- config opencode inchangee."
      }
    } catch { Write-Host "Outils Elpis (MCP) : config utilisateur non recuperee -- config opencode inchangee." }
  } else {
    Write-Host "Cible elpis-remote configuree ($RJson) -- pas encore de jeton."
    Write-Host "-> Dans opencode, tapez /remote login : un code s'affiche, a saisir dans la page Code de l'app."
  }
}
# --- PATH utilisateur (persistant, sans droits admin) -- idempotent. ---
$u = [Environment]::GetEnvironmentVariable('Path','User')
if (-not $u) { $u = '' }
if (($u -split ';') -notcontains $BinDir) {
  [Environment]::SetEnvironmentVariable('Path', ($u.TrimEnd(';') + ';' + $BinDir), 'User')
  $env:Path = $env:Path + ';' + $BinDir
  Write-Host "PATH utilisateur mis a jour. Rouvrez votre terminal pour en profiter."
} else {
  Write-Host "$BinDir est deja dans votre PATH."
}
"""


def _render(template: str, request: Request) -> str:
    return (template
            .replace("__BASE__", _base_url(request))
            .replace("__APP_URL__", _app_url(request)))


@router.get("/api/cli/install.sh")
def cli_install_sh(request: Request):
    _require_opencode_enabled()
    return PlainTextResponse(
        _render(_INSTALL_SH_TEMPLATE, request),
        media_type="text/x-shellscript; charset=utf-8",
    )


@router.get("/api/cli/install.ps1")
def cli_install_ps1(request: Request):
    _require_opencode_enabled()
    script = _render(_INSTALL_PS1_TEMPLATE, request)
    if any(ord(c) > 127 for c in script):
        # Garde-fou : PowerShell 5.1 lit un .ps1 sans BOM en ANSI — un caractere
        # non-ASCII reintroduit ici peut casser le parsing cote cible.
        logger.warning("install.ps1 (opencode) contient des caracteres non-ASCII")
    return PlainTextResponse(script, media_type="text/plain; charset=utf-8")


# ── Alias COURTS (chemins affiches par l'app) ────────────────────────────────
# C'est ce que l'utilisateur copie : `curl -fsSL http://<ip>/opencode | bash`
# ou `iex(irm http://<ip>/opencode.ps1)`. Servis aussi EN CLAIR par Caddy sur
# :80 (deploy/caddy/Caddyfile.template › @bootstrap) : la machine cible n'a
# alors aucun certificat a valider pour amorcer. En acces HTTP direct (sans
# frontal TLS) ils repondent tels quels sur le port de l'app.
@router.get("/opencode")
def cli_install_sh_short(request: Request):
    return cli_install_sh(request)


@router.get("/opencode.ps1")
def cli_install_ps1_short(request: Request):
    return cli_install_ps1(request)


@router.get("/api/cli/opencode.json")
def cli_opencode_config(request: Request):
    """``opencode.json`` généré à chaud (modèles + endpoint courants).

    Public (le ``curl … | bash`` tourne sans cookie) mais gated par
    ``features.opencode``. N'expose que des ids de modèles + une baseURL LAN.
    L'installeur le récupère au lieu de copier un fichier statique périmé ;
    utilisable aussi en re-sync : ``curl <LAN>/api/cli/opencode.json -o ~/.config/opencode/opencode.json``.

    Appel AUTHENTIFIÉ (session, ou ``x-elpis-token`` — ce que fait l'installeur
    une fois le compte connecté) : ajoute le bloc ``mcp`` des outils Elpis,
    avec le jeton du compte, si le service MCP est partagé et authentifié —
    UNE ENTRÉE PAR FAMILLE (``elpis-git``, ``elpis-browser``…), donc une
    bascule par famille dans opencode, chacune activée selon le choix du compte.
    """
    _require_opencode_enabled()
    cfg = _generate_opencode_config()
    tok, uid = _client_identity(request)
    entries = _opencode_mcp_entries(request, tok, uid) if tok else {}
    if entries:
        cfg["mcp"] = entries
    # Servi INDENTÉ : ce fichier est posé tel quel dans ~/.config/opencode par
    # l'installeur et relu/édité à la main (« model », serveurs MCP…) — une
    # ligne unique de 2 Ko n'est pas une config lisible.
    import json as _json
    return Response(_json.dumps(cfg, indent=2, ensure_ascii=False) + "\n",
                    media_type="application/json")


@router.get("/api/cli/opencode/families")
def cli_opencode_families(request: Request):
    """Familles d'outils publiées à opencode, avec leur libellé et l'état choisi
    par le compte. Sert la modale OpenCode — la liste vient du serveur (config +
    outils réellement enregistrés), jamais d'une copie figée dans le front."""
    _require_opencode_enabled()
    tok, uid = _client_identity(request)
    if not tok:
        raise HTTPException(401, "Authentification requise.")
    prefs = _family_prefs(uid)
    labels = {}
    try:
        from llm_core._mcp_categories import get_categories
        labels = {c["name"]: c.get("label") or c["name"]
                  for c in get_categories(include_hidden=True)}
    except Exception:
        pass
    from shared_infra.mcp.families import FAMILY_CATEGORY, opencode_families
    live = _live_families()
    out = []
    for f in opencode_families():
        if live is not None and f not in live:
            continue
        out.append({"name": f,
                    "label": labels.get(FAMILY_CATEGORY.get(f, f)) or f,
                    "server": opencode_mcp_server_name(f),
                    "enabled": bool(prefs.get(f, True))})
    return JSONResponse({"families": out})


# ── CA locale servie PAR L'APP ───────────────────────────────────────────────
# Caddy publie déjà la CA en clair sur ``http://<hôte>/ca.crt`` (port 80). Mais
# ce chemin n'existe QUE derrière le frontal : sur un déploiement en HTTP direct
# (ou si :80 est filtré), l'installeur ne trouvait aucune CA et se rabattait sur
# ``-k``. On la sert donc aussi ici — même origine que le reste, donc toujours
# joignable. Un certificat d'AC est public par nature (c'est ce qu'on distribue
# aux postes pour qu'ils VÉRIFIENT) : aucun secret n'est exposé.
_CA_DEFAULT = "/etc/caddy/elpis-pki/ca.crt"


def _ca_cert_path() -> Optional[Path]:
    raw = (_os.environ.get("ELPIS_CA_FILE")
           or str((((read_config_json() or {}).get("security") or {})
                   .get("https") or {}).get("ca_file") or "")).strip()
    p = Path(raw) if raw else Path(_CA_DEFAULT)
    try:
        return p if p.is_file() else None
    except OSError:
        return None


@router.get("/api/cli/ca.crt")
def cli_ca_cert():
    """CA locale (PEM) — épinglage TLS par les installeurs et le plugin.

    PUBLIC et non gaté par ``features.opencode`` : l'installeur desktop et tout
    client LAN en ont besoin pour vérifier le certificat de l'app.
    """
    p = _ca_cert_path()
    if p is None:
        raise HTTPException(404, "Aucune CA locale (HTTPS non déployé sur cette instance).")
    return FileResponse(p, filename="ca.crt", media_type="application/x-pem-file")


@router.get("/api/cli/bundle/{os_key}")
def cli_bundle(os_key: str, request: Request):
    _require_opencode_enabled()
    p = _resolve_bundle(os_key)
    if p is None:
        raise HTTPException(
            404,
            f"Artefact OpenCode introuvable pour « {os_key} ». "
            f"Dépose un fichier opencode-<os>.(tar.gz|zip) dans {_dist_dir()} "
            f"(os ∈ linux|macos|windows).",
        )
    return FileResponse(p, filename=p.name, media_type="application/octet-stream")
