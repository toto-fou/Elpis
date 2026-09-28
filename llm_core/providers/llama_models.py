# SPDX-License-Identifier: MIT
"""llm_core.providers.llama_models — pilotage des modèles d'un llama-server
en mode ROUTEUR (b10545+).

Le routeur expose ce que l'app devinait jusque-là :

    GET  /models                → inventaire + statut (loaded / unloaded)
    POST /models/load           {"model": "..."}
    POST /models/unload         {"model": "..."}
    GET  /models/sse            événements temps réel (chargement, progression)

Deux gains directs :

  - « le modèle est-il chargé ? » devient une RÉPONSE, plus une déduction à
    partir de nos propres verrous. Le widget de file d'attente peut enfin dire
    la vérité au lieu d'annoncer « chargement » par défaut.
  - décharger devient possible. Sur une machine à un seul GPU qui héberge une
    douzaine de modèles, libérer la VRAM avant d'en charger un autre est la
    différence entre un swap propre et un swap qui rame.

⚠ ``load``/``unload`` sont des actions GLOBALES : elles touchent tous les
utilisateurs de l'instance. Elles n'ont donc rien à faire dans un chemin
automatique tant qu'elles ne sont pas coordonnées avec le verrou d'exclusivité
de modèle — d'où leur présence ici comme OUTILS, appelés par l'administration,
et pas par la boucle de chat.

Tout est best-effort : un serveur mono-modèle (ou plus ancien) renvoie 404 et
les fonctions rendent une valeur neutre.
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger("uvicorn.error")

# Cache très court de l'inventaire : la file d'attente peut l'interroger à
# chaque tour sans transformer /models en source de charge.
_CACHE_TTL_S = 3.0
_cache: Dict[str, Any] = {"ts": 0.0, "data": {}}
# AUDIT 2026-09-16 — un inventaire PAR SERVEUR. ``_cache`` reste celui du
# serveur intégré (lu et remis à zéro par des tests) ; les connecteurs llama.cpp
# ont chacun le leur. Avant, un cache global unique rendait l'inventaire d'un
# serveur à qui interrogeait l'autre.
_caches_other: Dict[str, Dict[str, Any]] = {}


def _base(url: str) -> str:
    u = (url or "").rstrip("/")
    for suffix in ("/v1/chat/completions", "/chat/completions", "/v1"):
        if u.endswith(suffix):
            return u[: -len(suffix)]
    return u


def _resolve(base_url: str = "", engine=None):
    """``(racine, en-têtes, cache, moteur)`` du serveur visé.

    ``base_url`` explicite ⇒ ce serveur, sans en-tête (contrat historique) ;
    sinon ``engine`` ; sinon le serveur de la CIBLE COURANTE
    (``engines.current_engine``) — l'intégré hors tour de chat."""
    if base_url:
        return _base(base_url), None, _cache, None
    if engine is None:
        try:
            from llm_core.engines import current_engine
            engine = current_engine()
        except Exception:                           # noqa: BLE001
            engine = None
    if engine is None or engine.is_builtin:
        from shared_infra.config import LLAMA_URL
        return _base(LLAMA_URL), None, _cache, engine
    c = _caches_other.setdefault(engine.key, {"ts": 0.0, "data": {}})
    return _base(engine.base_root), (engine.header_dict() or None), c, engine


async def _caps_for(base_url: str, engine):
    """Capacités du serveur visé. L'intégré garde l'appel historique
    ``engine_caps(base_url)`` ; un connecteur passe son ``EngineRef`` (en-tête
    d'authentification compris)."""
    from llm_core.providers.llama_caps import engine_caps
    if engine is not None and not engine.is_builtin and not base_url:
        return await engine_caps(engine=engine)
    return await engine_caps(base_url)


async def model_statuses(base_url: str = "",
                         force: bool = False, *, engine=None) -> Dict[str, str]:
    """``{nom: "loaded" | "unloaded" | "loading"}``. Vide si indisponible."""
    root, headers, _cache_v, _eng = _resolve(base_url, engine)
    if _eng is not None and not _eng.is_llamacpp:
        return {}
    now = time.monotonic()
    if not force and (now - float(_cache_v["ts"])) < _CACHE_TTL_S:
        return dict(_cache_v["data"])
    try:
        from llm_core._client import _get_llm_client
        # Un connecteur a son propre pool (cf. ``_client``) : son inventaire ne
        # doit pas occuper les keep-alives réservés au serveur intégré.
        _dedie = _eng is not None and not _eng.is_builtin
        client = _get_llm_client(root) if _dedie else _get_llm_client()
        _kw = {"headers": headers} if headers else {}
        r = await client.get(f"{root}/v1/models", timeout=5.0, **_kw)
        if r.status_code != 200:
            # AUDIT 2026-08-31 (passe 3) — l'ÉCHEC est mémoïsé aussi : sans
            # ça, un moteur local injoignable (ou port filtré : timeout 5 s
            # plein) était re-sondé À CHAQUE appel — en tête de chaque tour.
            _cache_v["ts"], _cache_v["data"] = now, {}
            return {}
        out: Dict[str, str] = {}
        for m in (r.json() or {}).get("data") or []:
            if not isinstance(m, dict) or not m.get("id"):
                continue
            st = m.get("status")
            val = st.get("value") if isinstance(st, dict) else st
            out[str(m["id"])] = str(val or "unknown")
        _cache_v["ts"], _cache_v["data"] = now, out
        return dict(out)
    except Exception as e:
        logger.debug("[llama_models] inventaire indisponible : %s", str(e)[:120])
        _cache_v["ts"], _cache_v["data"] = now, {}     # échec mémoïsé (TTL 3 s)
        return {}


def invalidate_statuses(engine=None) -> None:
    """Périme l'inventaire d'un serveur (``None`` = tous)."""
    if engine is None:
        _cache["ts"] = 0.0
        for c in _caches_other.values():
            c["ts"] = 0.0
        return
    if engine.is_builtin:
        _cache["ts"] = 0.0
    elif engine.key in _caches_other:
        _caches_other[engine.key]["ts"] = 0.0


async def is_loaded(model: str, base_url: str = "",
                    *, force: bool = False) -> Optional[bool]:
    """``True``/``False``, ou ``None`` quand le serveur ne sait pas répondre
    (mono-modèle, build ancien) — à ne pas confondre avec « déchargé ».

    ``force`` court-circuite le cache de 3 s de ``model_statuses`` : utile
    pour une re-vérification anti-course, qui doit voir l'état RÉEL."""
    if not model:
        return None
    st = await model_statuses(base_url, force=force)
    if not st:
        return None
    return st.get(model) == "loaded"


async def _post(path: str, model: str, base_url: str, engine=None) -> bool:
    root, headers, _cache_v, _eng = _resolve(base_url, engine)
    # Moteur sans API de modèles (mono-modèle, build ancien) : l'appel
    # rendrait 404. On ne le tente pas — le repli est de toute façon « le
    # modèle est celui qui est déjà là ».
    try:
        if not (await _caps_for(base_url, _eng)).models_api:
            logger.debug("[llama_models] %s ignoré : pas d'API de modèles", path)
            return False
    except Exception:                               # noqa: BLE001
        pass
    try:
        from llm_core._client import _get_llm_client
        _kw = {"headers": headers} if headers else {}
        _dedie = _eng is not None and not _eng.is_builtin
        r = await (_get_llm_client(root) if _dedie else _get_llm_client()).post(
            f"{root}{path}", json={"model": model}, timeout=600.0, **_kw)
        ok = r.status_code == 200
        if not ok:
            logger.warning("[llama_models] %s %s → HTTP %s : %s",
                           path, model, r.status_code, r.text[:160])
        _cache_v["ts"] = 0.0      # inventaire périmé
        return ok
    except Exception as e:
        logger.warning("[llama_models] %s %s a échoué : %s", path, model,
                       str(e)[:150])
        return False


async def load_model(model: str, base_url: str = "", *, engine=None) -> bool:
    """Demande le chargement d'un modèle. ⚠ Action globale.

    ⚠ **Non bloquant** : le routeur accuse réception et charge en tâche de
    fond (mesuré : ``{"success":true}`` en 20 ms pour un modèle qui met une
    minute à monter en VRAM). Le succès de cet appel ne dit donc RIEN de
    l'aboutissement du chargement — pour le suivre, cf. :func:`watch_load`.
    """
    return await _post("/models/load", model, base_url, engine)


async def unload_model(model: str, base_url: str = "", *, engine=None) -> bool:
    """Décharge un modèle et rend sa VRAM. ⚠ Action globale : coupe l'herbe
    sous le pied de tout run en cours sur ce modèle."""
    return await _post("/models/unload", model, base_url, engine)


# ─────────────────────────────────────────────────────────────────────────────
#  Progression RÉELLE d'un chargement
# ─────────────────────────────────────────────────────────────────────────────
#
# Le serveur enfant branche le vrai callback de chargement de llama.cpp
# (``llama_model_params.progress_callback``) et pousse au routeur, échantillonné
# à un point par 200 ms :
#
#     {"stages": ["text_model", "spec_model", "mmproj_model"],
#      "current": "text_model", "value": 0.0 … 1.0}
#
# Le routeur le rediffuse sur ``/models/sse``. Capture réelle d'un chargement
# de 27B (2026-08-22) : 36 échantillons monotones de 0 à 100 %, puis un dernier
# événement ``loaded`` porteur des métadonnées du modèle (n_ctx compris).
#
# ⚠ Trois pièges, tous vérifiés en direct :
#   - ``GET /models`` ne porte JAMAIS la progression (seulement value/args/
#     preset/exit_code/failed) : sonder l'inventaire donne « loading », jamais
#     un pourcentage ;
#   - **aucun instantané à la connexion** — un abonnement ouvert alors que le
#     modèle est DÉJÀ chargé n'entend rien, jamais. D'où la re-vérification
#     ci-dessous APRÈS ouverture du flux, qui ferme la course ;
#   - un des messages d'étape ne porte pas de ``value`` (clé ``stage`` au
#     singulier, émis à l'entrée de l'étape mmproj) : ``value`` est optionnel.

#: Deux formes d'événement portent un changement d'état (l'une historique,
#: l'autre introduite avec la progression). On accepte les deux.
_STATUS_EVENTS = ("status_change", "model_status")


def _download_pct(progress: Any) -> Optional[float]:
    """Agrège la progression de TÉLÉCHARGEMENT (octets, par URL) en fraction.

    Un premier usage d'un modèle absent du disque commence par le récupérer :
    plusieurs minutes pendant lesquelles « chargement » serait un mensonge.
    """
    if not isinstance(progress, dict) or not progress:
        return None
    done = total = 0
    for part in progress.values():
        if not isinstance(part, dict):
            continue
        done += int(part.get("done") or 0)
        total += int(part.get("total") or 0)
    if total <= 0:
        return None
    return max(0.0, min(1.0, done / total))


def _new_sse_client(timeout_s: float):
    """Client HTTP DÉDIÉ à un suivi de chargement (cf. ``watch_load``).

    Point d'injection unique : c'est ce que les tests remplacent, et c'est ce
    qui garantit qu'aucun flux long ne s'installe dans le pool de monitoring
    partagé (``_llama_http._get_admin_client``, 8 connexions pour /props,
    /health, /tokenize et /apply-template)."""
    import httpx as _httpx
    return _httpx.AsyncClient(
        timeout=_httpx.Timeout(timeout_s, connect=5.0,
                               read=timeout_s, write=5.0),
        limits=_httpx.Limits(max_connections=1, max_keepalive_connections=0),
        http2=False,
    )


async def watch_load(
    model: str,
    base_url: str = "",
    on_progress: Optional[Callable] = None,
    *,
    timeout_s: float = 900.0,
) -> Optional[bool]:
    """Suit le chargement de ``model`` et rend ``True`` quand il est en VRAM.

    ``on_progress(stage, pct, stages)`` est attendu (coroutine) à chaque
    échantillon : ``stage`` = étape en cours (``"text_model"``,
    ``"download"``…), ``pct`` = 0-100 ou ``None`` quand l'étape ne se chiffre
    pas, ``stages`` = la liste complète des étapes prévues.

    ``False`` = le chargement a échoué (le moteur repasse le modèle à
    ``unloaded``). ``None`` = indisponible (moteur trop ancien, pas de routeur,
    délai dépassé) — l'appelant retombe alors sur son estimation.
    """
    if not model:
        return None
    root, headers, _cache_v, _eng = _resolve(base_url)
    try:
        if not (await _caps_for(base_url, _eng)).models_sse:
            return None
    except Exception:                               # noqa: BLE001
        return None

    try:
        url = f"{root}/models/sse"
        # AUDIT 2026-08-23 — client DÉDIÉ, hors du pool de monitoring.
        #
        # Ce flux SSE retient une connexion pendant TOUT le chargement (jusqu'à
        # 600 s côté chat, 900 s par défaut). Il était ouvert sur le client
        # admin PARTAGÉ, plafonné à ``max_connections=8`` — le même qui sert
        # ``/props`` (n_ctx par slot, engine_caps), ``/health``, et surtout
        # ``/tokenize`` + ``/apply-template``, appelés à CHAQUE tour par
        # ``count_tokens_for_messages``. Huit conversations qui attendent un
        # swap de modèle ouvraient huit suivis (un par couple user/chat) et
        # saturaient le pool : le neuvième appel admin — n'importe lequel —
        # levait ``PoolTimeout`` au bout de son propre timeout court, ce qui
        # faisait rendre n_ctx=0, neutralisait la porte tokens du compresseur
        # et installait des capacités UNKNOWN pour 5 minutes.
        # Un client par suivi : quelques dizaines d'octets, et le monitoring
        # cesse d'être l'otage des chargements.
        _sse_client = _new_sse_client(timeout_s)
        async with _sse_client, _sse_client.stream(
                "GET", url, headers={"Accept": "text/event-stream",
                                     **(headers or {})}) as resp:
            if resp.status_code != 200:
                return None
            # Fermeture de la course : le modèle a pu finir de charger entre
            # la décision d'attendre et l'ouverture du flux. Aucun instantané
            # n'étant émis, sans ce contrôle on attendrait un événement qui ne
            # viendra jamais — jusqu'au délai.
            # ``force=True`` : sans lui, cette re-vérification lit le cache de
            # 3 s de ``model_statuses`` — plusieurs suivis démarrés en rafale
            # voyaient donc un inventaire périmé, rataient la course qu'elle
            # est censée fermer, et tenaient leur connexion jusqu'au délai.
            if await is_loaded(model, base_url, force=True) is True:
                return True
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                try:
                    evt = json.loads(line[5:].strip())
                except Exception:                   # noqa: BLE001
                    continue
                if not isinstance(evt, dict) or evt.get("model") != model:
                    continue
                data = evt.get("data") or {}
                if evt.get("event") == "download_progress":
                    _p = _download_pct((data or {}).get("progress"))
                    if on_progress:
                        await on_progress("download",
                                          None if _p is None else _p * 100.0,
                                          ["download"])
                    continue
                if evt.get("event") not in _STATUS_EVENTS:
                    continue
                status = str(data.get("status") or "")
                if status == "loaded":
                    _cache_v["ts"] = 0.0
                    return True
                if status in ("unloaded", "failed"):
                    _cache_v["ts"] = 0.0
                    return False
                if status != "loading":
                    continue
                prog = data.get("progress") or {}
                if not on_progress:
                    continue
                _val = prog.get("value")
                _stages = prog.get("stages") or []
                await on_progress(
                    str(prog.get("current") or prog.get("stage") or ""),
                    None if not isinstance(_val, (int, float))
                    else float(_val) * 100.0,
                    [str(x) for x in _stages] if isinstance(_stages, list) else [],
                )
    except Exception as e:                          # noqa: BLE001
        logger.debug("[llama_models] suivi du chargement de %s interrompu : %s",
                     model, str(e)[:150])
    return None
