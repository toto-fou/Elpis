# SPDX-License-Identifier: MIT
"""
backend.services._llama_http — Thin HTTP wrappers around llama-server.

What lives here
---------------
Five small coroutines that wrap the most common llama-server calls:

  - ``_llama_base_url()``     — derive scheme://host:port from LLAMA_URL
  - ``_llama_get(path)``      — GET → JSON (or {"_raw": ...} on parse fail)
  - ``_llama_get_text(path)`` — GET → raw text (used for /metrics)
  - ``_llama_post(path, body)`` — POST + JSON body
  - ``_llama_delete(path)``   — DELETE

POST/DELETE return ``{"_status": code, ...}``; GET/GET_TEXT return None
on error. Callers branch on the returned shape rather than try/except.

Pulled out of ``_legacy.py`` because: pure utility, no module-level
state, depended-upon by ``_model_info``, ``_model_lifecycle``, ``_health``,
and a few admin endpoints. Moving these first unblocks the rest.

Shared admin client
-------------------
Le hot-path (chat) utilise déjà un client partagé via ``_client.py``
(``_get_llm_client()``). Ces wrappers servent aux endpoints d'admin et
de monitoring : ``/health``, ``/props``, ``/v1/models``, ``/slots``,
``/metrics``, ``/models/load``, ``/models/unload``, ``/infill``, et
``/tokenize`` (ajouté ici). Avant chaque appel ouvrait sa propre socket
(``async with httpx.AsyncClient(...) as c``). Sur un dashboard admin
qui poll /health toutes les 5s + /slots côté widget queue, ça produit
des dizaines de TCP+TLS handshake/secondes évitables. On utilise
maintenant un client partagé persistant avec keep-alive.
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections import OrderedDict
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import httpx

from shared_infra.config import LLAMA_URL

logger = logging.getLogger("uvicorn.error")


def _llama_base_url() -> str:
    p = urlparse(LLAMA_URL)
    return f"{p.scheme}://{p.netloc}"


# ── Client partagé pour les appels admin/monitoring ────────────────────
# Persistant + keep-alive : évite de recréer une socket à chaque
# /health, /slots, /props… Le timeout est passé par requête (paramètre
# explicite des wrappers) plutôt qu'au client, pour que les timeouts
# courts (3s sur /health) restent courts sans casser les longs (180s
# sur /models/load). Voir ``conversation_compressor._get_endpoint_client``
# pour le même pattern dans un autre contexte.
_admin_client: Optional[httpx.AsyncClient] = None
_admin_client_lock_create = None  # threading.Lock() lazy


def _get_admin_client_lock():
    global _admin_client_lock_create
    if _admin_client_lock_create is None:
        import threading
        _admin_client_lock_create = threading.Lock()
    return _admin_client_lock_create


def _get_admin_client() -> httpx.AsyncClient:
    """Client HTTP partagé pour les appels admin/monitoring. Lazy-créé.

    Note : ne JAMAIS appeler ``aclose()`` sur ce client en dehors du
    lifespan FastAPI. Voir ``close_admin_client()``.
    """
    global _admin_client
    if _admin_client is not None and not _admin_client.is_closed:
        return _admin_client
    # Création protégée par un threading.Lock pour éviter qu'un import
    # initial concurrent crée deux clients (cf. même pattern dans
    # conversation_compressor.py).
    with _get_admin_client_lock():
        if _admin_client is None or _admin_client.is_closed:
            _admin_client = httpx.AsyncClient(
                # timeout=None : par-requête. Permet aux callers d'utiliser
                # 3s pour /health et 180s pour /models/load sans toucher
                # la config du client.
                timeout=None,
                limits=httpx.Limits(
                    max_keepalive_connections=4,
                    max_connections=8,
                    keepalive_expiry=120,
                ),
                http2=False,  # llama-server est HTTP/1.1
            )
    return _admin_client


async def close_admin_client() -> None:
    """À appeler au shutdown FastAPI (lifespan), avant close_llm_client()."""
    global _admin_client
    if _admin_client and not _admin_client.is_closed:
        try:
            await _admin_client.aclose()
        except Exception:
            pass
        _admin_client = None


def _engine(engine=None):
    """Serveur visé : explicite, sinon celui de la cible du tour, sinon
    l'intégré (cf. ``llm_core.engines``). AUDIT 2026-09-16 — ces wrappers
    visaient ``LLAMA_URL`` en dur, y compris pendant un tour destiné à un
    autre serveur, avec le nom du modèle distant (autoload du routeur)."""
    if engine is not None:
        return engine
    from llm_core.engines import current_engine
    return current_engine()


def _engine_url_headers(path: str, engine=None):
    eng = _engine(engine)
    root = eng.base_root if not eng.is_builtin else _llama_base_url()
    return f"{root}{path}", (eng.header_dict() or None)


#: Routes qu'un routeur ne sert que pour UN modèle nommé (sans ``?model=`` :
#: 400 « model name is missing »).
_PER_MODEL_PATHS = ("/metrics", "/slots")

#: Modèle lancé sans ``--metrics`` (501) : plus de demande pendant ce délai
#: (sinon une erreur toutes les 10 s, par worker). Clé : serveur + chemin
#: routé, donc par modèle sur un routeur.
_METRICS_OFF_S = 300.0
_metrics_off_until: Dict[str, float] = {}


def _metrics_key(engine, routed: str) -> str:
    return f"{_engine(engine).key}{routed}"


def _metrics_off(engine, routed: str) -> bool:
    return _metrics_off_until.get(_metrics_key(engine, routed), 0.0) > time.monotonic()


async def _per_model_path(path: str, engine=None) -> Optional[str]:
    """``/metrics`` et ``/slots`` de l'intégré en mode routeur : on nomme le
    modèle CHARGÉ, sans jamais en charger un (``autoload=false``) ; aucun
    modèle chargé = rien à demander (``None``). Toute autre route, un serveur
    mono-modèle ou un connecteur : chemin inchangé."""
    if path not in _PER_MODEL_PATHS:
        return path
    routed = await _route_to_loaded(path, engine)
    if routed and path == "/metrics" and _metrics_off(engine, routed):
        return None
    return routed


async def _route_to_loaded(path: str, engine=None) -> Optional[str]:
    try:
        if not _engine(engine).is_builtin:
            return path
        from llm_core.providers.llama_caps import engine_caps
        caps = await engine_caps()
        if not caps.is_router:
            return path
        from llm_core._health import get_currently_loaded_model
        loaded = await get_currently_loaded_model()
    except Exception as e:                                      # noqa: BLE001
        logger.debug("[llama_http] modèle chargé inconnu (%s)", e)
        return path
    if not loaded:
        return None
    from urllib.parse import quote
    suffix = "&autoload=false" if caps.autoload_param else ""
    return f"{path}?model={quote(loaded, safe='')}{suffix}"


async def _llama_get(path: str, timeout: float = 5.0, *, engine=None) -> Optional[Dict]:
    routed = await _per_model_path(path, engine)
    if routed is None:
        return None
    url, headers = _engine_url_headers(routed, engine)
    try:
        c = _get_admin_client()
        r = await c.get(url, timeout=timeout, headers=headers)
        if r.status_code == 200:
            try:
                return r.json()
            except Exception:
                return {"_raw": r.text[:2000]}
    except Exception:
        pass
    return None


async def _llama_get_text(path: str, timeout: float = 5.0, *, engine=None) -> Optional[str]:
    """GET returning raw text (for /metrics prometheus endpoint)."""
    routed = await _per_model_path(path, engine)
    if routed is None:
        return None
    url, headers = _engine_url_headers(routed, engine)
    try:
        c = _get_admin_client()
        r = await c.get(url, timeout=timeout, headers=headers)
        if r.status_code == 200:
            return r.text
        if r.status_code == 501 and path == "/metrics":
            _metrics_off_until[_metrics_key(engine, routed)] = time.monotonic() + _METRICS_OFF_S
            logger.info("[llama_http] /metrics non activé sur le serveur "
                        "(option --metrics) : relu dans %d s", int(_METRICS_OFF_S))
    except Exception:
        pass
    return None


async def _llama_post(path: str, body: Dict, timeout: float = 60.0, *,
                      engine=None) -> Optional[Dict]:
    url, headers = _engine_url_headers(path, engine)
    try:
        c = _get_admin_client()
        r = await c.post(url, json=body, timeout=timeout, headers=headers)
        try:
            return {"_status": r.status_code, **r.json()}
        except Exception:
            return {"_status": r.status_code, "text": r.text[:300]}
    except Exception as e:
        # ``error_type`` : distingue un serveur INJOIGNABLE d'une requête
        # simplement lente (cf. disjoncteur de ``/tokenize``).
        return {"_status": 0, "error": str(e), "error_type": type(e).__name__}


async def _llama_delete(path: str, timeout: float = 30.0, *, engine=None) -> Optional[Dict]:
    url, headers = _engine_url_headers(path, engine)
    try:
        c = _get_admin_client()
        r = await c.delete(url, timeout=timeout, headers=headers)
        try:
            return {"_status": r.status_code, **r.json()}
        except Exception:
            return {"_status": r.status_code, "text": r.text[:300]}
    except Exception as e:
        return {"_status": 0, "error": str(e)}


# ─────────────────────────────────────────────────────────────────────
# /tokenize helper — comptage exact via llama-server
# ─────────────────────────────────────────────────────────────────────
# llama-server expose ``POST /tokenize`` qui retourne la liste des
# tokens BPE pour un texte donné. C'est le seul moyen exact de compter
# les tokens (les heuristiques chars/3 sont à ±20%). Pour les décisions
# critiques (compresser ou pas, tronquer ou pas), on veut le vrai
# nombre — ~5-20ms côté llama.cpp.
#
# On cache par hash + model_id : la même conversation revue 5 fois ne
# retokenise pas 5 fois.

# Cache LRU borné (OrderedDict). Clé = (model_id, sha256(text)),
# valeur = nombre de tokens.
_TOKENIZE_CACHE: "OrderedDict[tuple, int]" = OrderedDict()
_TOKENIZE_CACHE_MAX = 2048

# OPTIM 2026-09-26 — disjoncteur de ``/tokenize`` par URL. Serveur injoignable
# ou qui ne répond plus (chargement de modèle, saturation) : les échecs ne
# sont pas mémorisés (à raison), donc CHAQUE itération renvoyait une requête
# par message non compté — des centaines en parallèle dans un pool de 8
# connexions, chacune jusqu'à son timeout de 5 s. Après un échec de TRANSPORT,
# les appels suivants vers la même URL rendent ``None`` (estimation côté
# appelant) pendant ``_TOKENIZE_BACKOFF_S``.
_TOKENIZE_BACKOFF_S = 3.0
_TOKENIZE_DOWN_UNTIL: Dict[str, float] = {}


# Échecs qui ouvrent le disjoncteur. AUDIT 2026-09-26 — pas n'importe quel
# ``_status: 0`` : un ``PoolTimeout`` (pool saturé par d'autres chats) ou la
# lecture lente d'un GROS texte (prompt rendu de plusieurs centaines de Ko)
# ne disent rien de la santé du serveur, et coupaient le comptage exact de
# tous les chats pendant 3 s. Un délai de lecture sur un texte COURT, lui,
# signe un serveur qui ne répond plus (chargement de modèle, saturation).
_TOKENIZE_DOWN_ERRORS = frozenset({
    "ConnectError", "ConnectTimeout", "RemoteProtocolError",
    "ConnectionRefusedError", "ConnectionResetError", "OSError",
})
_TOKENIZE_SLOW_TEXT_CHARS = 20_000


def _tokenize_note_failure(r: Optional[Dict[str, Any]], engine, text_chars: int) -> None:
    """Ouvre le disjoncteur si l'échec ``r`` signe un serveur hors d'état."""
    if not r or r.get("_status") != 0:
        return
    _et = str(r.get("error_type") or "")
    if _et in _TOKENIZE_DOWN_ERRORS or (
            _et in ("ReadTimeout", "WriteTimeout")
            and text_chars <= _TOKENIZE_SLOW_TEXT_CHARS):
        _TOKENIZE_DOWN_UNTIL[_engine_url_headers("/tokenize", engine)[0]] = (
            time.monotonic() + _TOKENIZE_BACKOFF_S)


def tokenize_backoff_active(engine=None) -> bool:
    """Vrai si le disjoncteur de ``/tokenize`` est ouvert pour ce serveur.
    Jamais d'exception : une résolution de serveur en échec vaut « fermé »
    (l'appel réel échouera et sera compté normalement)."""
    if not _TOKENIZE_DOWN_UNTIL:
        return False
    try:
        url, _ = _engine_url_headers("/tokenize", engine)
    except Exception:                                           # noqa: BLE001
        return False
    until = _TOKENIZE_DOWN_UNTIL.get(url)
    return until is not None and time.monotonic() < until


def _tokenize_cache_key(text: str, model_id: Optional[str], add_special: bool = False,
                        engine=None) -> tuple:
    import hashlib as _hl
    h = _hl.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:24]
    # Clé du modèle inchangée pour l'intégré ; préfixée par le serveur sinon
    # (deux serveurs, même nom, tokenizers potentiellement différents).
    mk = engine.cache_key(model_id) if engine is not None else (model_id or "")
    return (mk, h, bool(add_special))


async def count_tokens_exact(
    text: str,
    model_id: Optional[str] = None,
    *,
    timeout: float = 5.0,
    use_cache: bool = True,
    add_special: bool = False,
) -> Optional[int]:
    """Renvoie le nombre exact de tokens d'un texte selon le tokenizer
    du modèle chargé.

    Stratégie :
      - Cache LRU sur (model_id, hash) — 2048 entrées max.
      - POST /tokenize avec ``{"content": text}``, ou
        ``{"content": text, "model": model_id}`` en mode router.
      - Retourne ``len(response.tokens)``.
      - En cas d'échec (serveur down, endpoint absent, timeout),
        retourne ``None`` — au caller de fallback sur l'heuristique.

    Args:
        text: Le texte à tokenizer. Vide → 0 directement.
        model_id: Modèle cible (utile en mode router multi-instance).
        timeout: Timeout HTTP en secondes (défaut 5.0).
        use_cache: Si False, bypass le cache (utile pour les benchmarks).

    Returns:
        Un int (nombre de tokens) ou None si indisponible.
    """
    if not text:
        return 0
    eng = _engine()
    if not eng.is_llamacpp:
        # Pas de /tokenize hors llama.cpp (cloud, vLLM…) : estimation côté appelant.
        return None
    key = _tokenize_cache_key(text, model_id, add_special, eng) if use_cache else None
    if use_cache and key in _TOKENIZE_CACHE:
        # Touch pour LRU
        v = _TOKENIZE_CACHE[key]
        _TOKENIZE_CACHE.move_to_end(key)
        return v
    if tokenize_backoff_active(eng):
        return None

    # ``add_special`` : ajoute les tokens spéciaux (BOS…) comme le fait
    # llama.cpp en tokenisant un prompt de complétion. On l'active pour
    # compter un prompt RENDU par le template (cf. count_rendered_prompt_tokens_exact) ;
    # les appels par bout de texte le laissent à False (défaut llama).
    body: Dict[str, Any] = {"content": text, "add_special": bool(add_special)}
    if model_id:
        body["model"] = model_id
    r = await _llama_post("/tokenize", body, timeout=timeout, engine=eng)
    if not r or r.get("_status") != 200:
        _tokenize_note_failure(r, eng, len(text))
        return None
    tokens = r.get("tokens")
    if not isinstance(tokens, list):
        return None
    n = len(tokens)
    if use_cache and key is not None:
        _TOKENIZE_CACHE[key] = n
        _TOKENIZE_CACHE.move_to_end(key)
        # Eviction LRU
        while len(_TOKENIZE_CACHE) > _TOKENIZE_CACHE_MAX:
            _TOKENIZE_CACHE.popitem(last=False)
    return n


def _messages_text_only(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Aplati le content multimodal en texte pour ``/apply-template``.

    Les blocs image ne sont pas tokenisables comme du texte (leur forfait est
    ajouté à part par l'appelant) ; on les retire pour que ``/apply-template``
    ne rejette pas la requête sur une conv multimodale. tool_calls et messages
    ``role:tool`` sont laissés intacts (le template les rend)."""
    out: List[Dict[str, Any]] = []
    for m in messages:
        c = m.get("content")
        if isinstance(c, list):
            txt = " ".join(
                b.get("text", "") for b in c
                if isinstance(b, dict) and isinstance(b.get("text"), str)
            )
            m2 = dict(m)
            m2["content"] = txt
            out.append(m2)
        else:
            out.append(m)
    return out


async def count_rendered_prompt_tokens_exact(
    messages: List[Dict[str, Any]],
    tools: Optional[List[Dict[str, Any]]] = None,
    model_id: Optional[str] = None,
    *,
    timeout: float = 5.0,
) -> Optional[int]:
    """Compte EXACT du prompt, égal au ``usage.prompt_tokens`` de llama.cpp.

    Le comptage par message (``count_tokens_for_messages`` /
    ``message_text_for_tokenize``) tokenise chaque message en texte brut + un
    forfait fixe/message : il RATE la structure réelle du chat template (tokens
    spéciaux ``<|im_start|>``/``<|im_end|>``, prompt de génération, embedding des
    tools, BOS) → biais systématique vs le vrai nombre de tokens du prompt. Ici
    on demande à llama-server de RENDRE le prompt exactement comme pour
    ``/v1/chat/completions`` (``POST /apply-template``) puis on le tokenise avec
    ``add_special`` → le compte correspond au token près.

    Retourne ``None`` si ``/apply-template`` est absent (vieux build) ou échoue
    → l'appelant retombe sur l'estimation par message. Ne compte PAS le forfait
    image (blocs non tokenisables) : à ajouter par l'appelant.
    """
    if not messages:
        return 0
    eng = _engine()
    if not eng.is_llamacpp:
        return None
    # Même serveur que ``/tokenize`` : disjoncteur ouvert → estimation.
    if tokenize_backoff_active(eng):
        return None
    body: Dict[str, Any] = {"messages": _messages_text_only(messages)}
    if tools:
        body["tools"] = tools
    if model_id:
        body["model"] = model_id
    r = await _llama_post("/apply-template", body, timeout=timeout, engine=eng)
    if not r or r.get("_status") != 200:
        # Un rendu échoue sur un serveur injoignable AVANT toute tokenisation :
        # le compter, sinon chaque comptage payait son propre timeout.
        _tokenize_note_failure(r, eng, 0)
        return None
    prompt = r.get("prompt")
    if not isinstance(prompt, str) or not prompt:
        return None
    return await count_tokens_exact(prompt, model_id, timeout=timeout, add_special=True)


async def count_tokens_for_messages(
    messages: List[Dict[str, Any]],
    model_id: Optional[str] = None,
    *,
    timeout: float = 5.0,
) -> Optional[int]:
    """Variante ``messages``-aware de ``count_tokens_exact``.

    Sérialise les messages dans un format minimal (rôle + content +
    tool_calls + résultats d'outils) et somme les tokens de chaque
    message. Approche conservatrice : surestime de quelques tokens par
    message (les délim spéciaux du chat_template) — préférable à
    sous-estimer pour une décision de compression.

    IMPORTANT : on inclut le nom et les arguments des ``tool_calls`` (un
    assistant qui n'émet QUE des tool_calls a ``content=None`` mais peut
    porter un ``write`` ou un ``grep`` massif) ainsi que le ``content``
    des messages ``role:tool``. Sans ça, la porte tokens du compresseur
    était neutralisée sur les conversations agentic chargées en appels
    d'outils — le cas d'usage principal du compresseur. On réutilise la
    sérialisation de ``context.tokens.message_text_for_tokenize`` — une seule
    recette pour les deux comptages (import différé, aucun cycle).

    Comptage EXACT d'abord : ``count_rendered_prompt_tokens_exact`` rend la
    conv via ``POST /apply-template`` puis la tokenise avec ``add_special`` →
    inclut les délimiteurs du template (le comptage par message les rate). Si
    ``/apply-template`` est indisponible (vieux build), on retombe sur
    l'approche par message ci-dessous (portable, conservatrice).
    """
    if not messages:
        return 0
    # ── Exact via le template rendu (fallback transparent si indisponible) ─
    _rendered = await count_rendered_prompt_tokens_exact(
        messages, None, model_id, timeout=timeout)
    if isinstance(_rendered, int) and _rendered > 0:
        return _rendered
    # ── Sérialisation par message (sync, cheap) ──────────────────────────
    # On construit d'abord le texte minimal de chaque message, PUIS on les
    # tokenise CONCURREMMENT (cf. plus bas). Avant, chaque message était
    # tokenisé en série (``await`` un par un) : sur une conversation longue
    # NON cachée (50 messages), ça enchaînait 50 round-trips HTTP /tokenize
    # séquentiels — et ce comptage tourne à CHAQUE tour (décision de
    # compression + fit du budget de contexte).
    #
    # AUDIT 2026-08-23 — import MORT supprimé.
    #
    # Ce bloc tentait ``from llm_core._chat_with_tools import
    # _message_text_for_tokenize``, un symbole qui n'existe NULLE PART dans le
    # dépôt : l'import échouait à chaque compaction et seul le repli inline
    # vivait. Le branchement primaire était structurellement inatteignable, et
    # deux docstrings plus un commentaire de test décrivaient un « sérialiseur
    # partagé » fictif — quiconque ajustait la sérialisation dans
    # ``_chat_with_tools`` croyait modifier le chemin utilisé.
    #
    # La recette partagée que ces docstrings décrivent existe maintenant pour
    # de bon : ``context.tokens.message_text_for_tokenize`` (aucun cycle
    # d'import), utilisée ici ET par le comptage par message.
    from llm_core.context.tokens import message_text_for_tokenize as _serialize

    texts: List[str] = []
    for m in messages:
        if not isinstance(m, dict):
            continue
        texts.append(_serialize(m))

    if not texts:
        return 0

    # ── Tokenisation CONCURRENTE ─────────────────────────────────────────
    # ``count_tokens_exact`` consulte le cache LRU par (model_id, hash) AVANT
    # tout réseau : les messages déjà vus aux tours précédents restent
    # gratuits, et le ``gather`` ne fait que supprimer la latence réseau
    # série sur les messages froids. Le parallélisme réel reste borné par le
    # pool de connexions du client admin partagé (max_connections=8), donc
    # pas de thundering herd vers llama-server.
    # AUDIT 2026-09-26 — concurrence BORNÉE à la taille du pool : une vague
    # de N requêtes partait avant que le premier échec n'ouvre le
    # disjoncteur, chacune attendant son propre timeout (compaction d'un
    # historique de 800 messages sur un serveur qui ne répond plus : ~10 s
    # par comptage). Disjoncteur déjà ouvert → indisponible tout de suite.
    if tokenize_backoff_active():
        return None
    _sem = asyncio.Semaphore(8)

    async def _one(txt: str) -> Optional[int]:
        async with _sem:
            return await count_tokens_exact(txt, model_id, timeout=timeout)

    counts = await asyncio.gather(*(_one(t) for t in texts))
    # Un seul échec (None) → on bascule en mode "indisponible" pour que le
    # caller fallback proprement plutôt que renvoyer une somme partielle qui
    # sous-estimerait le vrai total.
    if any(c is None for c in counts):
        return None
    # Marge de ~4 tokens par message pour les délimiteurs du template.
    return sum(c + 4 for c in counts)


def invalidate_tokenize_cache(model_id: Optional[str] = None) -> None:
    """Invalide le cache de tokenisation. Appelé typiquement au switch
    de modèle (le tokenizer peut changer)."""
    global _TOKENIZE_CACHE
    if model_id is None:
        _TOKENIZE_CACHE.clear()
    else:
        # Invalide les entrées de ce modèle (clé brute pour l'intégré,
        # « <serveur>|<modèle> » pour les autres — cf. EngineRef.cache_key).
        keys_to_remove = [k for k in _TOKENIZE_CACHE
                          if k[0] == model_id or str(k[0]).endswith("|" + model_id)]
        for k in keys_to_remove:
            _TOKENIZE_CACHE.pop(k, None)
