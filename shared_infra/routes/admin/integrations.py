# SPDX-License-Identifier: MIT
"""
Admin integrations endpoints.

Owns:
    POST /api/admin/rag-service/test  — ping a candidate RAG service URL
                                        before the admin saves it to config
    POST /api/admin/voice/test        — sonde les deux services vocaux (STT et
                                        TTS) avant enregistrement, séparément
    POST /api/admin/voice/models      — ce que le serveur vocal a chargé
                                        (modèles ou voix), pour la liste
                                        déroulante de la console

Pattern note
------------
The admin UI lets the operator type a URL + token in the form and click
"Tester la connexion" *before* hitting the global Save button — that
flow is impossible if the test endpoint reads from the saved config, so
this route accepts URL/token in the request body and forwards them to
``_rag_client.ping`` as overrides.

A successful response includes the rag_app's ``/api/health`` payload
(version, collection, auth_required flag) so the UI can display useful
feedback ("Connecté à rag_app v2.3.0, collection=exigences, 1842 chunks").
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, Optional

from fastapi import HTTPException, Request

from llm_core._rag_client import RagServiceError, ping
from shared_infra.accounts.users import get_user_by_id
from shared_infra.routes.admin._state import admin_router
from shared_infra.security.deps import require_user_id
from shared_infra.voice.config import VOICE_DEFAULTS

logger = logging.getLogger("uvicorn.error")


def _require_admin(request: Request) -> int:
    """Same pattern other admin endpoints use."""
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] != 1:
        raise HTTPException(403, "Admin required")
    return uid


@admin_router.post("/api/admin/rag-service/test")
async def api_admin_rag_service_test(request: Request) -> Dict[str, Any]:
    """
    Body (all optional — when absent, falls back to saved config):
      { url: str, token: str, timeout: float }

    Response (success):
      { ok: true, status: <health payload from rag_app> }

    Response (failure):
      { ok: false, error: <human-readable message> }
      Always HTTP 200 — the UI reads ``ok`` to decide what to render.
      We deliberately don't 4xx/5xx because a failed *test* is not a
      failed *request*; the test itself succeeded in determining that
      the URL is unreachable.
    """
    _require_admin(request)
    try:
        data = await request.json()
    except Exception:
        data = {}

    url: Optional[str]   = (data.get("url") or "").strip() or None
    token: Optional[str] = data.get("token")  # may be empty string (= no token)
    timeout = data.get("timeout") or 5.0
    try:
        timeout = float(timeout)
    except (TypeError, ValueError):
        timeout = 5.0
    timeout = max(0.5, min(timeout, 30.0))  # clamp

    try:
        # Même raison qu'au-dessus, avec un plafond de 30 s ici : ``ping`` est
        # synchrone, et le test d'intégration se déclenche depuis l'admin
        # pendant que d'autres utilisateurs génèrent.
        health = await asyncio.to_thread(ping, url=url, token=token,
                                         timeout=timeout)
        return {"ok": True, "status": health}
    except RagServiceError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        logger.exception("[admin/rag-service/test] unexpected error")
        return {"ok": False, "error": f"Erreur interne: {e}"}


# ═══════════════════════════════════════════════════════════════════════════
#  MOTEUR VOCAL
# ═══════════════════════════════════════════════════════════════════════════

# Champs texte que le formulaire peut surcharger, par section. ``verify`` est
# traité à part (booléen).
_CHAMPS_VOIX = ("endpoint_url", "format", "model", "language", "prompt",
                "token", "voice")


def _fusion_voix(enregistree: Dict[str, Any], data: Dict[str, Any],
                 section: str) -> Dict[str, Any]:
    """Config enregistrée + surcharges du formulaire, bornes conservées."""
    base = dict(enregistree[section])
    brut = data.get(section)
    if isinstance(brut, dict):
        for cle in _CHAMPS_VOIX:
            if brut.get(cle) is not None:
                base[cle] = str(brut[cle]).strip()
        if brut.get("verify") is not None:
            base["verify"] = brut["verify"] is not False and \
                str(brut["verify"]).strip().lower() not in ("false", "0")
        base["endpoint_url"] = (base.get("endpoint_url") or "").rstrip("/")
        base["format"] = (base.get("format") or "").lower()
        try:
            if brut.get("timeout_sec") is not None:
                base["timeout_sec"] = max(2, min(60, int(brut["timeout_sec"])))
        except (TypeError, ValueError):
            pass
    # Un test ne doit jamais faire patienter l'opérateur une demi-minute.
    base["timeout_sec"] = min(int(base.get("timeout_sec") or 30), 30)
    return base


def _ecarts_voix(enregistree: Dict[str, Any], data: Dict[str, Any]) -> list:
    """Les champs du formulaire qui diffèrent de ce qui est ENREGISTRÉ.

    Seuls les champs envoyés comptent : un champ absent du corps vaut « valeur
    enregistrée », il ne peut pas différer.
    """
    ecarts = []
    if "enabled" in data and (data.get("enabled") is True) != enregistree["enabled"]:
        ecarts.append("enabled")
    for section in ("stt", "tts"):
        brut = data.get(section)
        if not isinstance(brut, dict):
            continue
        fusion = _fusion_voix(enregistree, data, section)
        for cle in _CHAMPS_VOIX + ("verify",):
            if brut.get(cle) is None:
                continue
            if cle not in enregistree[section]:
                continue          # ex. ``voice`` côté stt : sans objet
            valeur = fusion.get(cle)
            # Un champ laissé vide retombe sur le défaut à la lecture
            # (``get_voice_config``) : vide contre défaut n'est pas un écart.
            if valeur == "" and enregistree[section].get(cle) == VOICE_DEFAULTS[section].get(cle):
                continue
            if valeur != enregistree[section].get(cle):
                ecarts.append(f"{section}.{cle}")
    return ecarts


@admin_router.post("/api/admin/voice/test")
async def api_admin_voice_test(request: Request) -> Dict[str, Any]:
    """
    Sonde les deux services vocaux, séparément.

    Body (tout est optionnel — absent = valeur enregistrée) :
      { enabled?: bool,
        stt: {endpoint_url, format, language, model, prompt, token, verify, timeout_sec},
        tts: {endpoint_url, format, model, voice, token, verify, timeout_sec} }

    Réponse :
      { ok: bool,
        stt: {ok, text?, format?, error?, detail?},
        tts: {ok, bytes?, mime?, voices?, error?, detail?},
        enabled: bool,                 # voice.enabled ENREGISTRÉ
        saved_matches_form: bool,      # le formulaire testé == config enregistrée
        unsaved: [str],                # champs qui diffèrent (« stt.endpoint_url »…)
        flags: {stt: bool, tts: bool}, # ce qui est RÉELLEMENT actif (config enregistrée)
        https: bool,                   # l'application est servie en HTTPS (Caddy)
        warnings: [str] }

    **Toujours HTTP 200**, même quand les deux services sont morts : un test
    raté n'est pas une requête ratée — le test a parfaitement réussi à établir
    que l'adresse ne répond pas. L'interface lit ``ok``.

    Les surcharges permettent de tester AVANT d'enregistrer : l'opérateur tape
    une adresse, clique « Tester », et ne sauve que si ça répond. Rien n'est
    écrit ici. Mais un test vert ne suffisait pas : il sondait le FORMULAIRE,
    sans rien dire de l'interrupteur, de l'enregistrement ni des cases de
    chaque utilisateur — d'où « le test passe mais rien ne marche ». Le bloc
    d'état et ``warnings`` disent ce qui manque encore.
    """
    _require_admin(request)
    try:
        data = await request.json()
    except Exception:                                           # noqa: BLE001
        data = {}
    if not isinstance(data, dict):
        data = {}

    from shared_infra.config import https_enabled
    from shared_infra.voice import client as moteur
    from shared_infra.voice.config import get_voice_config, voice_flags
    from shared_infra.voice.errors import VoiceError

    enregistree = get_voice_config()

    async def _sonde(section: str, sonde) -> Dict[str, Any]:
        cfg = _fusion_voix(enregistree, data, section)
        if not cfg["endpoint_url"]:
            return {"ok": False, "error": "Aucune adresse renseignée."}
        if section == "tts" and cfg["format"] == "openai" and not cfg.get("model"):
            return {"ok": False,
                    "error": "Format openai : renseignez le modèle de synthèse (ex. tts-1)."}
        try:
            return {"ok": True, **(await sonde(cfg))}
        except VoiceError as exc:
            return {"ok": False, "error": exc.message,
                    "detail": exc.detail or None}
        except Exception as exc:                                # noqa: BLE001
            logger.exception("[admin/voice/test] %s : erreur inattendue", section)
            return {"ok": False, "error": f"Erreur interne : {exc}"}

    # En parallèle : deux machines distinctes, aucune raison de les interroger
    # l'une après l'autre et de doubler l'attente de l'opérateur.
    stt, tts = await asyncio.gather(
        _sonde("stt", moteur.sonde_stt),
        _sonde("tts", moteur.sonde_tts),
    )

    stt_on, tts_on = voice_flags(enregistree)
    ecarts = _ecarts_voix(enregistree, data)
    https = https_enabled()
    avertissements = []
    if not enregistree["enabled"]:
        avertissements.append("Moteur vocal désactivé (case Activer).")
    if ecarts:
        avertissements.append("Configuration non enregistrée : le test porte sur le formulaire.")
    if enregistree["enabled"] and not (stt_on or tts_on):
        avertissements.append("Aucune adresse enregistrée : ni dictée ni lecture ne sont actives.")
    if stt_on or tts_on:
        avertissements.append("Chaque utilisateur doit cocher Dictée / Réponse vocale "
                              "dans ses Paramètres.")
    if ecarts or not (stt_on or tts_on) or not enregistree["enabled"]:
        avertissements.append("Après enregistrement, rechargez la page pour voir le micro.")
    if not https:
        avertissements.append("Le micro exige HTTPS (ou localhost) : activez HTTPS "
                              "dans Sécurité › Accès HTTPS.")

    return {
        "ok": bool(stt.get("ok") and tts.get("ok")),
        "stt": stt,
        "tts": tts,
        "enabled": enregistree["enabled"],
        "saved_matches_form": not ecarts,
        "unsaved": ecarts,
        "flags": {"stt": stt_on, "tts": tts_on},
        "https": https,
        "warnings": avertissements,
    }


@admin_router.post("/api/admin/voice/models")
async def api_admin_voice_models(request: Request) -> Dict[str, Any]:
    """
    Ce que le serveur vocal a chargé : modèles (STT, TTS openai) ou voix (TTS).

    Body : { section: "stt"|"tts", endpoint_url, format, token, verify? }
      Valeurs du FORMULAIRE, comme le test ; absentes = valeurs enregistrées.

    Réponse (toujours HTTP 200) :
      { ok: true,  models: [{id, label}], current: str|null, source: str, detail?: str }
      { ok: false, models: [], current: null, source: "", error: str, detail?: str }

    ``current`` : l'élément à présélectionner — celui que le serveur annonce
    comme chargé au démarrage, sinon celui déjà configuré s'il existe là-bas,
    sinon l'unique élément. Pour whisper.cpp, un seul élément d'``id`` vide :
    le serveur ne publie pas le nom de son modèle.
    """
    _require_admin(request)
    try:
        data = await request.json()
    except Exception:                                           # noqa: BLE001
        data = {}
    if not isinstance(data, dict):
        data = {}
    section = str(data.get("section") or "").strip().lower()
    if section not in ("stt", "tts"):
        return {"ok": False, "models": [], "current": None, "source": "",
                "error": "Section inconnue : « stt » ou « tts »."}

    from shared_infra.voice import client as moteur
    from shared_infra.voice.config import get_voice_config
    from shared_infra.voice.errors import VoiceError

    cfg = _fusion_voix(get_voice_config(), {section: data}, section)
    if not cfg["endpoint_url"]:
        return {"ok": False, "models": [], "current": None, "source": "",
                "error": "Aucune adresse renseignée."}
    try:
        resultat = await moteur.liste_modeles(section, cfg)
    except VoiceError as exc:
        sortie = {"ok": False, "models": [], "current": None, "source": "",
                  "error": exc.message}
        if exc.detail:
            sortie["detail"] = exc.detail
        return sortie
    except Exception as exc:                                    # noqa: BLE001
        logger.exception("[admin/voice/models] %s : erreur inattendue", section)
        return {"ok": False, "models": [], "current": None, "source": "",
                "error": f"Erreur interne : {exc}"}
    return {"ok": True, **resultat}
