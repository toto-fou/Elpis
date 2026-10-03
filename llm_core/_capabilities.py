# SPDX-License-Identifier: MIT
"""
backend.services._capabilities — llama-server capability detection + scheduling-mode resolver.

What lives here
---------------
Two modes are supported (see ``backend.config.LLM_SCHEDULING_MODE``):

- ``classic``    : sémaphore autour de toute la boucle tool-calling (legacy).
- ``optimized``  : sémaphore inline par appel LLM — libère le slot pendant
                   les tool calls MCP pour maximiser l'utilisation côté
                   llama-server avec ``--cache-ram`` (défaut 8 GiB).

Le mode ``auto`` déclenche une détection au démarrage : si llama-server
expose ``/slots``, on considère les capacités nécessaires présentes et on
choisit ``optimized`` ; sinon on retombe sur ``classic``.

Public surface
--------------
- ``detect_llama_capabilities(timeout_s=3.0)`` — probe non-bloquant; remplit
  ``_LLAMA_CAPABILITIES`` et retourne une copie. Tolère un llama-server
  injoignable (renvoie un dict avec ``probe_error`` rempli).
- ``get_llama_capabilities()`` — accès lecture-seule au dict caché.
- ``resolve_scheduling_mode()`` — retourne le mode effectif (``"classic"``
  ou ``"optimized"``, jamais ``"auto"``).

The cache dict ``_LLAMA_CAPABILITIES`` is exported so callers that
historically read it directly (e.g. admin endpoints) keep working.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional

logger = logging.getLogger("uvicorn.error")


# ─────────────────────────────────────────────────────────────────────────────
#
# Deux modes sont supportés (voir backend.config.LLM_SCHEDULING_MODE) :
#
#  - "classic"    : sémaphore autour de toute la boucle tool-calling (legacy).
#  - "optimized"  : sémaphore inline par appel LLM — libère le slot pendant
#                   les tool calls MCP pour maximiser l'utilisation côté
#                   llama-server avec --cache-ram (défaut 8 GiB).
#
# Le mode "auto" déclenche une détection au démarrage : si llama-server expose
# /slots, on considère les capacités nécessaires présentes et on utilise
# "optimized" ; sinon fallback "classic".
#
# Les résultats sont cachés dans ``_LLAMA_CAPABILITIES`` (dict global) pour
# éviter de re-probe à chaque requête. Le dict est rempli par l'appel
# ``detect_llama_capabilities()`` effectué dans le lifespan de FastAPI.

_LLAMA_CAPABILITIES: Dict[str, Any] = {
    "probed": False,            # True une fois la détection effectuée
    "slots_endpoint": False,    # /slots accessible → --slots activé
    "total_slots": None,        # n_slots exposé par /props
    "loaded_model": None,       # modèle actuellement chargé en VRAM (pour widget file d'attente)
    "probe_error": None,        # dernière erreur de probe (pour diagnostic)
    "recommended_mode": "classic",  # "optimized" si slots_endpoint sinon "classic"
}

# AUDIT 2026-08-23 — le probe « auto » est AUTO-CICATRISANT.
#
# ``resolve_scheduling_mode()`` en mode « auto » retombe sur
# ``recommended_mode``, un global de PROCESS écrit à deux endroits seulement :
# le probe unique du lifespan (une fois par worker au démarrage) et l'endpoint
# admin de re-sonde, qui ne met à jour QUE le worker ayant décroché. Ni TTL,
# ni re-tentative — et le filet accidentel qui périmait ces globals, le
# recyclage ``max_requests`` de gunicorn, est désactivé par défaut depuis le
# 2026-08-21 : un worker vit désormais indéfiniment avec sa première réponse.
# Si systemd lance l'application avant llama-server (ou si le moteur met plus
# de 3 s à répondre à /props), les N workers figent « classic » DÉFINITIVEMENT.
# Or ce booléen ne pilote pas un détail : il décide si le sémaphore LLM est
# tenu pendant TOUTE la boucle d'outils ou relâché par appel, et quel moteur
# d'outils sert le tour. La concurrence s'effondrait, sans message ni trace.
#
# On ne re-sonde QUE si le probe précédent a échoué — un succès reste acquis
# (le moteur ne perd pas ``--slots`` en cours de route), donc coût nul en
# régime normal.
_PROBE_RETRY_TTL_S = 60.0
_probe_state: Dict[str, Any] = {"ts": 0.0, "inflight": False}


async def _loaded_model(client: Any, base_url: str) -> Optional[str]:
    """Premier modèle à l'état « loaded » dans ``/v1/models`` d'un routeur."""
    try:
        r = await client.get(f"{base_url}/v1/models")
        if r.status_code != 200:
            return None
        for m in (r.json() or {}).get("data") or []:
            st = m.get("status") if isinstance(m, dict) else None
            val = st.get("value") if isinstance(st, dict) else st
            if val == "loaded" and m.get("id"):
                return str(m["id"])
    except Exception as e:                                      # noqa: BLE001
        logger.debug("[llama_caps] /v1/models illisible : %s", e)
    return None


async def detect_llama_capabilities(timeout_s: float = 3.0) -> Dict[str, Any]:
    """Probe llama-server pour déterminer les capacités disponibles.

    Utilisé au démarrage pour choisir le mode de scheduling par défaut
    ("auto" résout vers "optimized" ou "classic" selon ce qu'on trouve).

    Gère deux topologies llama.cpp :
      1. Single-model   — /slots accessible globalement
      2. Router mode    — /slots nécessite ?model=<nom>, car chaque modèle
                          tourne dans un sous-processus séparé avec ses
                          propres slots. Le router proxyfie vers le bon
                          sous-serveur. Voir doc llama.cpp tools/server.

    Non-bloquant : même si llama-server n'est pas démarré, on retourne
    ``slots_endpoint=False`` + l'erreur, et on laisse l'app démarrer.
    Le probe peut être re-déclenché manuellement via l'endpoint admin.

    Mutation in-place du dict module ``_LLAMA_CAPABILITIES`` et renvoi d'une
    copie pour utilisation immédiate.
    """
    import httpx

    caps: Dict[str, Any] = {
        "probed": True,
        "slots_endpoint": False,
        "total_slots": None,
        "loaded_model": None,       # pour widget file d'attente
        "role": None,               # "router" | "single-model" | None
        "max_instances": None,      # router : nb max de modèles concurrents
        "probe_error": None,
        "recommended_mode": "classic",
    }

    # AUDIT 2026-09-16 (A5) — la sonde recomposait ``http://IP:PORT`` et
    # IGNORAIT donc ``llama.url`` / ``LLAMA_URL`` : un serveur intégré déclaré
    # par URL (HTTPS, proxy inverse, chemin préfixé, autre port) était sondé au
    # mauvais endroit — capacités fausses (pas de /slots, rôle inconnu, mode
    # « classic » imposé) alors que le serveur répondait très bien. Même racine
    # que tout le reste du cœur : celle du moteur intégré.
    from llm_core.engines import builtin_engine
    base_url = builtin_engine().base_root
    if not base_url:                    # config vide : repli historique
        from shared_infra.config import LLAMA_IP, LLAMA_PORT
        base_url = f"http://{LLAMA_IP}:{LLAMA_PORT}"
    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            # ── 1. /props : détection du rôle + total_slots éventuel ────────
            try:
                r_props = await client.get(f"{base_url}/props")
                if r_props.status_code == 200:
                    data = r_props.json() or {}
                    caps["total_slots"]   = data.get("total_slots")
                    caps["role"]          = data.get("role") or "single-model"
                    caps["max_instances"] = data.get("max_instances")
                    # loaded_model — alimente le widget "file d'attente" pour
                    # détecter un switch nécessaire. Différents champs selon
                    # la version de llama-server : model_alias, model_path,
                    # ou le dernier segment du path.
                    lm = (data.get("model_alias")
                          or data.get("model")
                          or data.get("default_generation_settings", {}).get("model"))
                    if not lm:
                        mp = data.get("model_path")
                        if mp:
                            # Garde juste le basename sans extension
                            import os as _os
                            lm = _os.path.splitext(_os.path.basename(str(mp)))[0]
                    caps["loaded_model"] = lm
            except Exception as e:
                caps["probe_error"] = f"/props: {e}"

            # En mode routeur, /props ne donne pas toujours le modèle actif.
            # /v1/models liste tous les modèles disponibles mais pas forcément
            # celui qui est *chargé*. Fallback : si caps["loaded_model"] est
            # vide, on laisse vide — le widget UI ne proposera pas de "switch
            # nécessaire" dans ce cas, évite les faux positifs.

            # ── 2. /slots : deux stratégies selon le rôle ────────────────────
            # En router mode, /slots sans ?model= retourne 404 ou vide parce
            # que les slots appartiennent aux sous-processus, pas au router.
            # Il faut interroger /slots?model=<nom> pour un modèle chargé.
            is_router = (caps["role"] == "router")

            async def _try_slots(url: str) -> bool:
                try:
                    r = await client.get(url)
                    if r.status_code == 200:
                        body = r.json()
                        # Le router retourne parfois 200 avec une structure
                        # vide ({} ou []) même sans vrais slots. On ne
                        # considère "oui" que si on a une liste non vide OU
                        # un objet qui n'a pas juste des champs de router.
                        if isinstance(body, list):
                            return len(body) > 0
                        if isinstance(body, dict):
                            return bool(body) and "role" not in body
                        return True
                    return False
                except Exception:
                    return False

            if is_router:
                # Routeur : on sonde le modèle CHARGÉ, sans charger. Nommer un
                # autre modèle (celui de la config) le chargerait et
                # déchargerait celui qui sert l'utilisateur. Aucun modèle
                # chargé : rien à sonder, la re-sonde d'un tour suivant
                # conclura (``_maybe_reprobe_capabilities``).
                loaded = await _loaded_model(client, base_url)
                if loaded:
                    caps["loaded_model"] = loaded
                    from urllib.parse import quote
                    caps["slots_endpoint"] = await _try_slots(
                        f"{base_url}/slots?model={quote(loaded, safe='')}&autoload=false")
                else:
                    caps["slots_pending"] = True
            else:
                # Single-model : probe direct /slots.
                caps["slots_endpoint"] = await _try_slots(f"{base_url}/slots")

            if (not caps["slots_endpoint"] and not caps["probe_error"]
                    and not caps.get("slots_pending")):
                caps["probe_error"] = (
                    "/slots non accessible — en mode router, vérifie que le "
                    "modèle par défaut est chargeable, et que llama-server "
                    "n'a pas été lancé avec --no-slots."
                )
    except Exception as e:
        caps["probe_error"] = f"connection: {e}"

    # ── Règle de décision ─────────────────────────────────────────────────
    # "optimized" ne dégrade jamais par rapport à "classic" : dans le pire
    # des cas, les deux sont équivalents (si --cache-ram est off côté
    # llama, v2 fait les mêmes appels LLM sous sémaphore que v1 ferait).
    # On recommande donc "optimized" dès que le serveur répond — qu'il
    # soit single-model, routeur avec ou sans modèle chargé, peu importe.
    # "classic" n'est recommandé que si le serveur est injoignable.
    server_up = (caps["slots_endpoint"]
                 or caps.get("role") is not None
                 or caps.get("total_slots") is not None)
    if server_up:
        caps["recommended_mode"] = "optimized"

    _LLAMA_CAPABILITIES.clear()
    _LLAMA_CAPABILITIES.update(caps)
    logger.info(
        "[llama_caps] probe done — role=%s slots=%s total_slots=%s max_instances=%s recommended=%s",
        caps.get("role"), caps["slots_endpoint"], caps["total_slots"],
        caps.get("max_instances"), caps["recommended_mode"],
    )
    return dict(caps)


def get_llama_capabilities() -> Dict[str, Any]:
    """Retourne une copie du dict des capacités détectées (ou valeurs par
    défaut si la détection n'a pas encore eu lieu)."""
    return dict(_LLAMA_CAPABILITIES)


def resolve_scheduling_mode() -> str:
    """Résout le mode effectif à partir de ``LLM_SCHEDULING_MODE`` :

    - "classic"   → "classic"
    - "optimized" → "optimized" (forcé, même si pas détecté — l'admin sait)
    - "auto"      → "optimized" si capacité détectée, sinon "classic"

    Retourne toujours une des deux valeurs concrètes, jamais "auto".
    """
    # AUDIT 2026-08-01 (E6) — source de vérité = le FICHIER, pas la constante
    # d'import. L'endpoint admin mutait ``config.LLM_SCHEDULING_MODE``, ce qui
    # ne s'appliquait qu'au worker ayant reçu le POST (``workers = cpu - 1``) :
    # le mode de scheduling alternait d'une requête à l'autre. La constante
    # reste le défaut pour les déploiements sans clé en config.json.
    from shared_infra.config import LLM_SCHEDULING_MODE, live_config_value
    mode = (live_config_value("llm.scheduling_mode", LLM_SCHEDULING_MODE)
            or "auto")
    mode = str(mode).lower()
    if mode == "classic":
        return "classic"
    if mode == "optimized":
        return "optimized"
    # auto
    _maybe_reprobe_capabilities()
    return _LLAMA_CAPABILITIES.get("recommended_mode", "classic")


def _maybe_reprobe_capabilities() -> None:
    """Relance le probe en tâche de fond si le précédent a ÉCHOUÉ et que le
    délai de re-tentative est écoulé. Best-effort, jamais bloquant : la
    décision du tour courant utilise la valeur connue, la suivante bénéficie
    du résultat. Cf. la note de ``_PROBE_RETRY_TTL_S``."""
    caps = _LLAMA_CAPABILITIES
    if caps.get("slots_endpoint") or _probe_state.get("inflight"):
        return                      # succès acquis, ou sonde déjà en vol
    if not caps.get("probed") and not caps.get("probe_error"):
        return                      # le lifespan n'a pas encore sondé
    import time as _t
    now = _t.monotonic()
    if (now - float(_probe_state.get("ts") or 0.0)) < _PROBE_RETRY_TTL_S:
        return
    _probe_state["ts"] = now
    try:
        import asyncio as _a
        loop = _a.get_running_loop()
    except RuntimeError:
        return                      # pas de boucle (contexte sync/test)
    _probe_state["inflight"] = True

    async def _run() -> None:
        try:
            await detect_llama_capabilities(timeout_s=3.0)
        except Exception:                                       # noqa: BLE001
            pass
        finally:
            _probe_state["inflight"] = False

    try:
        _t_ = loop.create_task(_run())
        _REPROBE_TASKS.add(_t_)
        _t_.add_done_callback(_REPROBE_TASKS.discard)
    except Exception:                                           # noqa: BLE001
        _probe_state["inflight"] = False


# Références fortes : asyncio ne garde qu'une weakref sur les tâches.
_REPROBE_TASKS: set = set()


# ─────────────────────────────────────────────────────────────────────────────
