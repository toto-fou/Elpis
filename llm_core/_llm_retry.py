# SPDX-License-Identifier: MIT
"""
llm_core._llm_retry — retry/backoff LLM partagé (chemins classic + tools).

Trois briques :

- **Classification fatal/transitoire** : un 4xx (hors 408/409/429) est une
  requête invalide (schéma d'outil, grammaire GBNF, contexte trop long) —
  la rejouer à l'identique reproduit exactement la même erreur ; on remonte
  immédiatement au lieu de brûler les tentatives.
- **Backoff exponentiel plafonné + full jitter** (Brooker/AWS) : délai tiré
  uniformément dans [0, min(cap, base·2^attempt)] — décorrèle les workers /
  chats / routines qui retenteraient au même instant sur un llama-server
  fragile.
- **Attente « modèle en chargement »** : llama-server répond 503 pendant le
  (re)chargement d'un modèle (10-60 s typiques en local). Plutôt que de
  consommer les tentatives pendant le warm-up, on sonde GET /health jusqu'à
  « prêt » (borné par ``LLAMA_LOADING_WAIT_S``) puis on retente aussitôt.
  Réservé aux cibles llama.cpp (intégré ou connecteur) — le 503 d'un autre
  fournisseur est un rate-limit, traité en backoff normal. Un serveur ABSENT (connexion
  refusée) ne déclenche PAS l'attente : échec rapide via le backoff.

Toutes les attentes sont cancel-aware : découpées en petits sommeils qui
LÈVENT ``asyncio.CancelledError`` dès que ``is_cancelled()`` passe à True —
sans le raise, un stop utilisateur pendant le backoff laisserait partir une
tentative de plus (« le modèle repart après stop »). ``task.cancel()``
interrompt de toute façon les ``asyncio.sleep`` sous-jacents.
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from typing import Any, Awaitable, Callable, Dict, Optional

import httpx

logger = logging.getLogger("uvicorn.error")

_SLEEP_SLICE_S = 0.2   # granularité des attentes cancel-aware

# ── Redémarrage du moteur PENDANT un run ─────────────────────────────────────
# Le backoff seul couvre ~45 s au total (LLAMA_RETRIES=3, cap 15 s, full
# jitter) : moins que le temps de (re)démarrage d'un llama-server — swap de
# modèle en mode routeur, redémarrage systemd, relance après OOM. Sans attente
# sur ``ConnectError``, une mission autonome de six heures mourrait sur un
# redémarrage de moteur de 60 s, avec un « serveur injoignable » comme seule
# trace.
#
# On ne peut pas pour autant attendre sur TOUT ConnectError : quand le serveur
# n'a jamais été démarré, l'utilisateur interactif doit avoir son échec tout de
# suite (c'est le contrat documenté ci-dessus). Le discriminant est l'histoire
# du processus : si un appel a DÉJÀ abouti ici, le moteur existe et une coupure
# est un redémarrage — on attend /health comme pour un 503. Sinon, échec rapide.
_last_llm_success_mono: Optional[float] = None
# L'histoire est tenue PAR SERVEUR : qu'un connecteur ait répondu ne prouve
# pas que l'intégré existe (et inversement). ``_last_…``
# garde la vue « dernier succès, tous serveurs » (compat).
_last_success_by_engine: Dict[str, float] = {}
# Au-delà, on considère que l'information est périmée (worker qui vit
# indéfiniment : le recyclage gunicorn est désactivé).
_SUCCESS_MEMORY_S = 3600.0


def _current_engine_key() -> str:
    try:
        from llm_core.engines import current_engine
        return current_engine().key
    except Exception:                                           # noqa: BLE001
        return "builtin"


def note_llm_success() -> None:
    """À appeler après CHAQUE appel LLM abouti : arme l'attente de
    redémarrage sur les erreurs de connexion ultérieures."""
    global _last_llm_success_mono
    _last_llm_success_mono = time.monotonic()
    _last_success_by_engine[_current_engine_key()] = _last_llm_success_mono


def forget_llm_success() -> None:
    """Oublie l'historique de succès (isolation des tests)."""
    global _last_llm_success_mono
    _last_llm_success_mono = None
    _last_success_by_engine.clear()


def _engine_was_alive() -> bool:
    """True si un appel LLM a abouti récemment dans CE processus, SUR le
    serveur de la cible courante."""
    ts = _last_success_by_engine.get(_current_engine_key())
    return ts is not None and (time.monotonic() - ts) < _SUCCESS_MEMORY_S


def _cfg(name: str, default):
    """Constante lue PARESSEUSEMENT dans shared_infra.config : monkeypatchable
    en test, et l'import de ce module ne fige aucune valeur."""
    try:
        import shared_infra.config as _c
        return getattr(_c, name, default)
    except Exception:
        return default


def llm_error_is_fatal(e: Optional[BaseException]) -> bool:
    """True si rejouer la MÊME requête reproduira la même erreur : réponse
    4xx hors 408 (timeout de requête), 409 (conflit) et 429 (rate-limit),
    qui restent transitoires (un 409 classé fatal abandonnerait au premier
    essai avec « réessayer donnera le même résultat »)."""
    if isinstance(e, httpx.HTTPStatusError):
        try:
            code = int(e.response.status_code)
        except Exception:
            return False
        return 400 <= code < 500 and code not in (408, 409, 429)
    return False


def llm_error_is_loading(e: Optional[BaseException]) -> bool:
    """True pour le 503 renvoyé par llama-server pendant le chargement d'un
    modèle (serveur vivant, pas encore prêt)."""
    return (isinstance(e, httpx.HTTPStatusError)
            and getattr(e.response, "status_code", 0) == 503)


# ─────────────────────────────────────────────────────────────────────
#  TAXONOMIE DES PANNES — de l'exception au message actionnable
# ─────────────────────────────────────────────────────────────────────
# ``llm_error_is_fatal`` répond « faut-il retenter ? » ; ça ne suffit pas à
# PARLER À L'UTILISATEUR. Un 400 « conversation trop longue » et un 400
# « schéma d'outil invalide » sont tous deux fatals, mais le premier se
# résout en compactant la conversation et le second est un bug à signaler.
# Sans cette distinction, les deux ressortiraient en « Requête LLM rejetée
# par le serveur : Client error '400 Bad Request' for url … » — un message
# qui ne dit ni la cause ni le geste à faire.

# Motifs renvoyés par les backends quand le prompt ne tient pas dans la
# fenêtre. llama.cpp a changé de formulation entre versions, et les cibles
# distantes (connecteurs OpenAI-compatible) ont les leurs.
_CTX_OVERFLOW_MARKERS = (
    "exceeds the available context size",   # llama.cpp récent
    "exceed the available context",
    "context size exceeded",
    "context_length_exceeded",              # OpenAI-compatible
    "maximum context length",
    "too large to process",                 # llama.cpp : batch physique
    "prompt is too long",                   # Anthropic-compatible
    "n_ctx",
)

# Refus d'ACCÈS : la clé, le compte ou l'offre n'ouvrent pas ce modèle. Ce
# n'est pas une requête mal formée — réessayer, changer les outils ou compacter
# n'y changera rien, seul un autre modèle ou une autre clé le fera. Distinguer
# les deux évite d'envoyer l'utilisateur chercher une cause qui n'existe pas.
# (Exemple : OpenCode Zen répond 400 « OpenCode's free tier can only be used
# in OpenCode » — un refus d'offre déguisé en requête invalide.)
_ACCESS_MARKERS = (
    "can only be used",
    "not allowed", "not permitted", "no access", "not authorized",
    "unauthorized", "forbidden", "permission",
    "is disabled", "model is disabled",
    "insufficient_quota", "exceeded your current quota",
    "subscription", "free tier", "requires a paid",
)

KIND_CONTEXT_OVERFLOW = "context_overflow"
KIND_INVALID_REQUEST = "invalid_request"
KIND_FORBIDDEN = "forbidden"
KIND_RATE_LIMITED = "rate_limited"
KIND_LOADING = "loading"
KIND_UNREACHABLE = "unreachable"
KIND_TIMEOUT = "timeout"
KIND_UNKNOWN = "unknown"


def provider_message(e: Optional[BaseException], limit: int = 220) -> str:
    """Message LISIBLE renvoyé par le fournisseur, ou "".

    Les passerelles renvoient un JSON du genre ``{"error": {"message": "…"}}``.
    Ce texte dit souvent EXACTEMENT ce qui bloque (« ce modèle n'est pas ouvert
    à cette clé »), là où notre famille de panne ne peut que généraliser. On ne
    garde qu'un texte court et d'une seule ligne : une page HTML d'un portail
    captif ou une trace de pile n'ont rien à faire dans une bulle de chat."""
    raw = error_body_text(e, limit=4000).strip()
    if not raw or raw[:1] in ("<",):
        return ""
    msg = ""
    try:
        data = json.loads(raw)
    except Exception:
        data = None
    if isinstance(data, dict):
        err = data.get("error")
        if isinstance(err, dict):
            msg = str(err.get("message") or err.get("detail") or "")
        elif isinstance(err, str):
            msg = err
        if not msg:
            msg = str(data.get("message") or data.get("detail") or "")
    elif data is None and len(raw) <= limit and "\n" not in raw:
        msg = raw                                  # texte brut court
    msg = " ".join(str(msg).split())
    return msg[:limit] if msg else ""


def error_body_text(e: Optional[BaseException], limit: int = 2000) -> str:
    """Corps de la réponse d'erreur, ou "" s'il n'est pas lisible.

    ATTENTION : sur une réponse STREAMING, httpx ne lit rien tant qu'on ne le
    demande pas — ``.text`` lève alors ``ResponseNotRead``. L'appelant doit
    avoir fait ``await resp.aread()`` avant de lever (cf.
    ``engine.llm_stream._llama_chat_with_tools_stream``) ;
    sinon on retourne "" et la classification retombe sur le code HTTP seul.
    """
    resp = getattr(e, "response", None)
    if resp is None:
        return ""
    try:
        return (resp.text or "")[:limit]
    except Exception:
        return ""


def llm_error_kind(e: Optional[BaseException]) -> str:
    """Famille de panne, pour choisir le message montré à l'utilisateur."""
    if isinstance(e, httpx.HTTPStatusError):
        try:
            code = int(e.response.status_code)
        except Exception:
            code = 0
        body = error_body_text(e).lower()
        if any(m in body for m in _CTX_OVERFLOW_MARKERS):
            return KIND_CONTEXT_OVERFLOW
        if code == 503:
            return KIND_LOADING
        # 529 = « overloaded » d'Anthropic (surcharge PASSAGÈRE du service,
        # pas une panne) : même conduite qu'un 429 — patienter, puis relancer.
        if code in (429, 529) or (code >= 500 and "overloaded" in body):
            return KIND_RATE_LIMITED
        if code == 408:
            return KIND_TIMEOUT
        if code in (401, 403):
            return KIND_FORBIDDEN
        # Un 4xx dont le corps parle d'accès est un refus d'OFFRE, pas une
        # requête mal formée : le conseil à donner n'est pas le même.
        if 400 <= code < 500 and any(m in body for m in _ACCESS_MARKERS):
            return KIND_FORBIDDEN
        if 400 <= code < 500:
            return KIND_INVALID_REQUEST
        return KIND_UNKNOWN
    if isinstance(e, (httpx.ConnectError, httpx.ConnectTimeout)):
        return KIND_UNREACHABLE
    if isinstance(e, (httpx.ReadTimeout, httpx.PoolTimeout, httpx.WriteTimeout)):
        return KIND_TIMEOUT
    return KIND_UNKNOWN


# Un message par famille : ce qui s'est passé, puis QUOI FAIRE. Vouvoiement,
# pas de jargon HTTP — le détail technique reste dans les logs et dans le
# champ ``detail`` de l'event d'erreur.
_KIND_MESSAGES = {
    KIND_CONTEXT_OVERFLOW: (
        "La conversation dépasse la fenêtre de contexte du modèle. "
        "Compactez la conversation, ouvrez un nouveau chat, ou retirez les "
        "pièces jointes volumineuses du dernier message."
    ),
    KIND_INVALID_REQUEST: (
        "Le modèle a refusé la requête telle qu'elle a été construite. "
        "Réessayer à l'identique donnera le même résultat : changez de modèle, "
        "ou désactivez les outils du chat pour isoler la cause."
    ),
    KIND_FORBIDDEN: (
        "La clé de ce connecteur n'ouvre pas ce modèle. "
        "Mettez une clé qui y donne droit, ou choisissez un modèle que la "
        "vôtre couvre — relancer à l'identique donnera le même refus."
    ),
    KIND_RATE_LIMITED: (
        "Le service du modèle limite le débit des requêtes. "
        "Patientez quelques instants avant de relancer."
    ),
    KIND_LOADING: (
        "Le modèle est encore en cours de chargement. "
        "Relancez la génération dans quelques instants."
    ),
    KIND_UNREACHABLE: (
        "Le serveur du modèle est injoignable. "
        "Vérifiez qu'il est démarré, puis relancez la génération."
    ),
    KIND_TIMEOUT: (
        "Le modèle n'a pas répondu dans le temps imparti. "
        "Relancez la génération, ou choisissez un modèle plus léger."
    ),
    KIND_UNKNOWN: (
        "La génération a échoué pour une raison inattendue. "
        "Relancez-la ; si le problème persiste, consultez les journaux."
    ),
}


def llm_error_user_message(e: Optional[BaseException]) -> str:
    """Message prêt à afficher : notre conseil, suivi de l'explication DU
    FOURNISSEUR quand il en donne une.

    Sans elle, un refus précis (« ce modèle n'est ouvert qu'au client maison »)
    arriverait à l'utilisateur sous la forme « la génération a échoué pour une
    raison inattendue » — la seule information utile de tout l'échange serait
    jetée à un pas de l'écran."""
    base = _KIND_MESSAGES.get(llm_error_kind(e), _KIND_MESSAGES[KIND_UNKNOWN])
    msg = provider_message(e)
    if not msg:
        return base
    # Phrase complète : les messages de cette table se terminent par un point,
    # et un test verrouille cette forme.
    return f"{base} Le fournisseur répond : « {msg.rstrip('.')} »."


def llm_error_detail(e: Optional[BaseException],
                     attempts: Optional[int] = None) -> str:
    """Motif TECHNIQUE : pour les journaux et le repli « Détails » de l'UI.
    Jamais la seule chose montrée à l'utilisateur."""
    if e is None:
        return ""
    parts = [f"{type(e).__name__}: {str(e)[:300]}"]
    body = error_body_text(e, limit=400).strip()
    if body:
        parts.append(f"réponse serveur : {body}")
    if attempts:
        parts.append(f"{attempts} tentative(s)")
    return " — ".join(parts)


class ProviderError(httpx.HTTPStatusError):
    """Refus du fournisseur remis en forme HTTP (cf. ``provider_http_error``).
    Sous-classe d'``HTTPStatusError`` : toute la taxonomie s'applique, et la
    reprise d'un flux coupé (réservée aux coupures de TRANSPORT) l'écarte
    comme n'importe quel refus HTTP."""


def provider_http_error(status: int, body: str, *, url: str = "http://llm.invalid/",
                        message: str = "", headers: Any = None) -> httpx.HTTPStatusError:
    """Erreur du fournisseur reçue HORS du code HTTP de la réponse, remise
    dans la forme que la taxonomie sait lire.

    Deux producteurs : l'événement d'erreur SSE émis EN COURS de flux (la
    réponse était un 200, l'erreur arrive dans le corps — llama.cpp,
    OpenAI-compatible, ``{"type": "error"}`` d'Anthropic), et l'adaptateur
    Anthropic. Une exception nue (``RuntimeError``) serait classée UNKNOWN
    par ``llm_error_kind`` : pas de compaction sur « prompt is too long », pas
    de backoff sur 429/529, 401 pris pour un historique empoisonné. On
    fabrique donc un ``httpx.HTTPStatusError`` complet — code et corps
    LISIBLES — pour que ``llm_error_kind``, ``llm_error_is_fatal`` et
    ``provider_message`` le traitent exactement comme un refus HTTP."""
    req = httpx.Request("POST", url or "http://llm.invalid/")
    # En-têtes d'origine GARDÉS : ``Retry-After`` y est lu (retry_after_seconds).
    resp = httpx.Response(int(status or 500), text=str(body or ""), request=req,
                          headers=headers)
    return ProviderError(
        message or f"{int(status or 500)}: {str(body or '')[:300]}",
        request=req, response=resp)


class LLMFailure(RuntimeError):
    """Échec d'appel LLM DÉJÀ traduit pour l'utilisateur.

    ``str(exc)`` est le message actionnable : les chemins qui remontent une
    exception telle quelle vers l'UI (``on_event({"type": "error", "text":
    str(e)})``) affichent donc d'emblée une phrase utile au lieu d'un
    « Client error '400 Bad Request' for url … ». Le motif technique reste
    disponible séparément dans ``detail``, et la famille dans ``kind`` (pour
    que l'appelant adapte son comportement — p. ex. ne pas diagnostiquer un
    « historique empoisonné » quand le contexte est simplement plein).
    """

    def __init__(self, cause: Optional[BaseException],
                 *, attempts: Optional[int] = None):
        self.cause = cause
        self.kind = llm_error_kind(cause)
        self.detail = llm_error_detail(cause, attempts)
        super().__init__(llm_error_user_message(cause))


def backoff_delay(attempt: int, *, base: Optional[float] = None,
                  cap: Optional[float] = None) -> float:
    """Full jitter : uniforme dans [0, min(cap, base·2^attempt)]."""
    b = float(_cfg("LLAMA_RETRY_BACKOFF_SEC", 0.6) if base is None else base)
    c = float(_cfg("LLAMA_RETRY_BACKOFF_CAP_S", 15.0) if cap is None else cap)
    return random.uniform(0.0, max(0.0, min(c, b * (2 ** max(0, int(attempt))))))


# Plafond d'un ``Retry-After`` honoré : au-delà, attendre bloquerait le tour
# plus longtemps qu'un utilisateur ne patiente — on échoue plutôt vite.
_RETRY_AFTER_CAP_S = 60.0


def retry_after_seconds(e: Optional[BaseException]) -> Optional[float]:
    """Délai demandé par l'en-tête ``Retry-After`` (secondes OU date HTTP),
    borné à ``_RETRY_AFTER_CAP_S`` ; ``None`` sans en-tête lisible.

    Ne pas l'ignorer : sur un 429 « Retry-After: 20 », le full jitter
    (0,6 s·2^n) relancerait toutes les tentatives en ~4 s, et toutes
    échoueraient."""
    if not isinstance(e, httpx.HTTPStatusError):
        return None
    try:
        raw = (e.response.headers.get("retry-after-ms") or "").strip()
        if raw:
            return max(0.0, min(_RETRY_AFTER_CAP_S, float(raw) / 1000.0))
        raw = (e.response.headers.get("retry-after") or "").strip()
    except Exception:
        return None
    if not raw:
        return None
    try:
        secs = float(raw)
    except ValueError:
        try:
            import datetime as _dt
            from email.utils import parsedate_to_datetime
            when = parsedate_to_datetime(raw)
            if when.tzinfo is None:
                when = when.replace(tzinfo=_dt.timezone.utc)
            secs = (when - _dt.datetime.now(_dt.timezone.utc)).total_seconds()
        except Exception:
            return None
    return max(0.0, min(_RETRY_AFTER_CAP_S, secs))


async def _cancel_aware_sleep(seconds: float,
                              is_cancelled: Optional[Callable[[], bool]]) -> None:
    """Sommeil découpé qui LÈVE CancelledError si le flag d'annulation passe à
    True — jamais de tentative supplémentaire après un stop utilisateur."""
    deadline = time.monotonic() + max(0.0, seconds)
    while True:
        if is_cancelled and is_cancelled():
            raise asyncio.CancelledError("llm_retry: cancelled during backoff")
        left = deadline - time.monotonic()
        if left <= 0:
            return
        await asyncio.sleep(min(_SLEEP_SLICE_S, left))


async def wait_llama_ready(
    max_wait_s: Optional[float] = None,
    *,
    is_cancelled: Optional[Callable[[], bool]] = None,
    probe: Optional[Callable[[], Awaitable[Optional[int]]]] = None,
    poll_s: float = 2.0,
) -> bool:
    """Sonde GET /health du llama-server local jusqu'à 200 ou l'échéance.

    ``probe`` (injectable en test) renvoie le status HTTP, ou None si le
    serveur est injoignable. Retourne True si le serveur est redevenu prêt,
    False à l'échéance ; lève CancelledError si l'utilisateur annule."""
    limit = float(_cfg("LLAMA_LOADING_WAIT_S", 90.0)
                  if max_wait_s is None else max_wait_s)
    if probe is None:
        async def probe() -> Optional[int]:      # pragma: no cover — réseau
            try:
                # Serveur de la CIBLE : un connecteur llama.cpp qui
                # redémarre est attendu comme l'intégré.
                from llm_core._client import _get_llm_client
                from llm_core._llama_http import _engine_url_headers
                from llm_core.engines import current_engine
                _eng = current_engine()
                url, hdrs = _engine_url_headers("/health", _eng)
                client = (_get_llm_client() if _eng.is_builtin
                          else _get_llm_client(_eng.base_root))
                r = await client.get(url, timeout=3.0, headers=hdrs)
                return r.status_code
            except Exception:
                return None
    deadline = time.monotonic() + max(0.0, limit)
    while True:
        if is_cancelled and is_cancelled():
            raise asyncio.CancelledError("llm_retry: cancelled while waiting for /health")
        try:
            status = await probe()
        except Exception:
            status = None
        if status == 200:
            return True
        if time.monotonic() >= deadline:
            return False
        await _cancel_aware_sleep(poll_s, is_cancelled)


async def retry_pause(
    e: BaseException,
    attempt: int,
    *,
    is_cancelled: Optional[Callable[[], bool]] = None,
    label: str = "",
) -> None:
    """Pause AVANT la tentative suivante, adaptée à l'erreur : 503 sur une
    cible llama.cpp (intégré ou connecteur) = attendre /health prêt (warm-up
    de modèle), sinon backoff exponentiel plafonné + full jitter."""
    _tag = f" {label}" if label else ""
    local = True   # pas de contextvar posé = moteur intégré (llama.cpp local)
    try:
        # Tout serveur llama.cpp (intégré ou connecteur) : l'attente de /health
        # suit le serveur de la cible (cf. ``wait_llama_ready``).
        from llm_core._target import current_target
        local = bool(current_target().is_llamacpp)
    except Exception:
        pass
    _restarting = (llm_error_kind(e) == KIND_UNREACHABLE and _engine_was_alive())
    if local and (llm_error_is_loading(e) or _restarting):
        _why = ("503 chargement de modèle" if not _restarting
                else "moteur injoignable après un appel abouti — redémarrage ?")
        t0 = time.monotonic()
        if await wait_llama_ready(is_cancelled=is_cancelled):
            _waited = time.monotonic() - t0
            logger.info(
                "[llm_retry%s] llama-server prêt après %.1fs d'attente "
                "(%s) — nouvelle tentative", _tag, _waited, _why)
            # /health à 200 DÈS la première sonde ne prouve pas que le modèle
            # demandé est prêt (mode routeur, reverse-proxy : 503 du POST
            # malgré /health ok) : sans attente réelle, on garde le backoff,
            # sinon les tentatives partiraient coup sur coup.
            if _waited >= 1.0:
                return
        else:
            logger.warning(
                "[llm_retry%s] llama-server toujours pas prêt après %.0fs "
                "d'attente (%s) — backoff standard", _tag,
                time.monotonic() - t0, _why)
        await _cancel_aware_sleep(backoff_delay(attempt), is_cancelled)
        return
    # ``Retry-After`` du fournisseur (429/503…) : on le respecte, borné.
    _ra = retry_after_seconds(e)
    if _ra is not None:
        logger.info("[llm_retry%s] Retry-After : %.1fs", _tag, _ra)
        await _cancel_aware_sleep(_ra, is_cancelled)
        return
    await _cancel_aware_sleep(backoff_delay(attempt), is_cancelled)
