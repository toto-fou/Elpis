# SPDX-License-Identifier: MIT
"""llm_core.providers.llama_caps — ce que le moteur en face SAIT FAIRE.

Le problème
-----------
Les capacités câblées en août 2026 (flux reprenable, progression du
pré-remplissage, contrôle du raisonnement, API ``/models`` du routeur, sonde
sans chargement) ont toutes été vérifiées sur **llama.cpp b10545**. Rien ne
garantit que le serveur en face soit celui-là : le même déploiement peut
pointer vers un build de six mois, un fork, ou un serveur OpenAI-compatible
qui n'est pas llama.cpp du tout.

Jusqu'ici chaque appel se débrouillait seul — une reprise de flux qui tombe
sur un 404 rend ``None``, ``end_reasoning`` rend ``False``, ``/models`` rend
``{}``. Ça fonctionne, mais ça se paie : un aller-retour HTTP perdu par
occasion, un avertissement dans le journal à chaque fois, et surtout une
intention illisible — « est-ce que ça a échoué ou est-ce que ce n'est pas
supporté ? ».

Ce module répond à la question UNE fois, et les appelants n'essaient plus ce
qui ne peut pas marcher. Sur un build ancien, tout retombe sur le
comportement historique : flux non reprenable, aucune progression, « Répondre
maintenant » qui annule et relance, sonde ``/props`` sans ``autoload``.

Deux sources de vérité, aucune devinette
----------------------------------------
``GET /props`` (gratuit, ne charge aucun modèle — vérifié en direct sur un
routeur b10545) donne les deux :

  ``build_info``  ``"b10545-a30273376"`` → le numéro de build, comparé aux
                  planchers ci-dessous ;
  ``role``        ``"router"`` → l'API ``/models`` existe. C'est une PREUVE,
                  pas une déduction : un build récent lancé en mono-modèle
                  n'a pas ces routes, et son ``role`` ne dit pas « router ».

⚠ Sonde inaboutie (moteur injoignable, ``/props`` absent, réponse sans
``build_info``) ⇒ **aucune ROUTE récente n'est tentée** : le comportement
historique est toujours correct, juste moins efficace, alors que supposer
récent ferait payer un aller-retour perdu à chaque occasion. Les CHAMPS de
corps, eux, gardent le bénéfice du doute — un champ inconnu est ignoré sans
erreur, donc les envoyer ne coûte rien et les retirer coûterait une
fonctionnalité. Cf. ``_proven`` / ``_not_older``.

⚠ Le cache a un TTL. Un cache de ``/props`` SANS TTL a déjà été la racine de
400 intermittents (audit 2026-08-21) : un serveur redémarré sur un autre
modèle gardait éternellement les capacités de l'ancien.
"""
from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass
from typing import Any, Dict, Tuple

logger = logging.getLogger("uvicorn.error")

#: Build llama.cpp où CHAQUE capacité ci-dessous a été vérifiée EN SITU
#: (sondes live du 2026-08-22 : reprise après coupure, ``prompt_progress``
#: reçu, ``{"success":true}`` du contrôle de raisonnement, ``/models/sse``
#: capturé pendant un chargement réel). Un plancher par capacité, et non un
#: seuil global, pour qu'abaisser l'un après vérification n'affecte pas les
#: autres — aucune de ces valeurs n'est devinée à partir d'un journal de
#: modifications.
MIN_BUILD_RESUMABLE_STREAM = 10545
MIN_BUILD_RETURN_PROGRESS  = 10545
MIN_BUILD_SSE_PING         = 10545
MIN_BUILD_REASONING_CTL    = 10545
MIN_BUILD_MODELS_SSE       = 10545
MIN_BUILD_AUTOLOAD_PARAM   = 10545

#: Durée de validité de la sonde. Assez long pour que le coût soit nul
#: (une requête par worker et par cible toutes les 5 minutes), assez court
#: pour qu'un serveur mis à jour — ou remplacé — soit vu sans redémarrer
#: l'application.
CAPS_TTL_S = 300.0

#: TTL d'une sonde qui a ÉCHOUÉ. AUDIT 2026-08-23 — un échec était mémorisé
#: exactement comme un succès, pour 300 s. Or il ne porte AUCUNE information
#: sur le moteur : un timeout de 3 s pendant un pré-remplissage silencieux
#: (26 s mesurées) suffisait à figer les capacités sur UNKNOWN pendant cinq
#: minutes — et ``resumable_stream`` étant une capacité à PREUVE REQUISE, tout
#: ce qui en dépend passait silencieusement en no-op sur cette fenêtre.
CAPS_FAIL_TTL_S = 10.0

# ``b10545-a30273376``, ``b6120``… Le numéro suit un ``b`` isolé.
_RE_BUILD = re.compile(r"\bb(\d{3,7})\b")

_cache: Dict[str, Tuple[float, "EngineCaps"]] = {}
_warned: set = set()


@dataclass(frozen=True)
class EngineCaps:
    """Capacités RÉSOLUES d'un moteur, telles qu'opposables à un appel.

    ``known=False`` = la sonde n'a pas abouti : tout est à ``False`` et
    l'appelant se comporte comme avant l'été 2026.
    """
    known:     bool = False
    build:     int  = 0
    is_router: bool = False

    # ── Deux règles, et l'asymétrie est délibérée ────────────────────────
    #
    # ``_proven`` — PREUVE exigée. Réservé à ce qui change le CONTRAT, pas
    #   simplement l'efficacité : nommer un flux engage la reprise ET
    #   l'annulation (``DELETE /v1/stream``), à chaque coupure et à chaque
    #   Stop. Se tromper là coûte un aller-retour perdu par occasion, sur un
    #   chemin très fréquenté, alors que le repli — flux anonyme, non
    #   reprenable — est parfaitement correct. Idem pour l'API ``/models``,
    #   dont la preuve n'est d'ailleurs pas une version mais le mode routeur.
    #
    # ``_not_older`` — BÉNÉFICE DU DOUTE. Pour tout ce qui est INERTE quand
    #   ce n'est pas supporté : champs de corps et paramètres d'URL (llama.cpp
    #   ignore un champ inconnu sans lever d'erreur, vérifié en direct), et le
    #   contrôle du raisonnement — une requête RARE, déclenchée par un clic,
    #   dont le refus est déjà rendu au client comme un repli propre. Les
    #   envoyer à un moteur qui ne les connaît pas ne coûte rien ; ne pas les
    #   envoyer à un moteur capable coûte une fonctionnalité entière. Seule
    #   une version LUE et trop ancienne les retire.
    def _proven(self, floor: int) -> bool:
        return self.known and self.build >= floor

    def _not_older(self, floor: int) -> bool:
        return (not self.known) or self.build >= floor

    # ── Routes et en-têtes : preuve exigée ───────────────────────────────
    @property
    def resumable_stream(self) -> bool:
        """``X-Conversation-Id`` + ``GET /v1/stream`` + ``DELETE /v1/stream``."""
        return self._proven(MIN_BUILD_RESUMABLE_STREAM)

    @property
    def reasoning_control(self) -> bool:
        """``POST /v1/chat/completions/control`` — la ROUTE, celle que le
        bouton « Répondre maintenant » appelle.

        Au doute, et non à la preuve : un clic n'arrive pas cent fois par
        tour, le refus est déjà traduit en repli côté client, et exiger la
        preuve ferait perdre le geste natif dès que ``/props`` est
        momentanément muet — pour économiser une requête.
        """
        return self._not_older(MIN_BUILD_REASONING_CTL)

    # ── Champs de corps : bénéfice du doute ──────────────────────────────
    @property
    def payload_return_progress(self) -> bool:
        """Champ ``return_progress`` → événements ``prompt_progress``."""
        return self._not_older(MIN_BUILD_RETURN_PROGRESS)

    @property
    def payload_sse_ping(self) -> bool:
        """Champ ``sse_ping_interval`` → le moteur donne signe de vie."""
        return self._not_older(MIN_BUILD_SSE_PING)

    @property
    def payload_reasoning_control(self) -> bool:
        """Champ ``reasoning_control`` — l'ARMEMENT, sans lequel la route
        n'a aucune prise. Envoyé au doute : sans lui, un moteur capable
        perdrait le bouton « Répondre maintenant » pour rien."""
        return self._not_older(MIN_BUILD_REASONING_CTL)

    @property
    def models_api(self) -> bool:
        """``GET /models``, ``POST /models/load|unload``. Preuve directe :
        seul un serveur en mode ROUTEUR expose ces routes."""
        return self.known and self.is_router

    @property
    def models_sse(self) -> bool:
        """``GET /models/sse`` — progression RÉELLE d'un chargement."""
        return self.models_api and self._proven(MIN_BUILD_MODELS_SSE)

    @property
    def autoload_param(self) -> bool:
        """``/props?model=X&autoload=false`` — sonder SANS charger.

        ⚠ Au doute, et c'est important : omettre le paramètre sur un moteur
        capable fait CHARGER 27 Go pour une simple sonde (invariant
        model-select-no-autoload), alors que l'envoyer à un moteur qui ne le
        connaît pas ne change rien — un paramètre d'URL inconnu est ignoré.
        Envoyer n'est donc jamais pire, et parfois indispensable.
        """
        return self._not_older(MIN_BUILD_AUTOLOAD_PARAM)

    def describe(self) -> str:
        if not self.known:
            return "moteur non identifié (comportement historique)"
        return (f"build b{self.build}"
                f"{', routeur' if self.is_router else ', mono-modèle'}")


#: Moteur non identifié — aucune capacité récente. Valeur de repli PARTOUT.
UNKNOWN = EngineCaps()


def _base(url: str) -> str:
    u = (url or "").rstrip("/")
    for suffix in ("/v1/chat/completions", "/chat/completions", "/v1"):
        if u.endswith(suffix):
            return u[: -len(suffix)]
    return u


def parse_build(build_info: Any) -> int:
    """``"b10545-a30273376"`` → ``10545``. 0 si illisible.

    Fonction séparée et testée : c'est elle qui décide si un déploiement
    bénéficie des capacités récentes ou retombe sur l'historique.
    """
    m = _RE_BUILD.search(str(build_info or ""))
    if not m:
        return 0
    try:
        return int(m.group(1))
    except ValueError:
        return 0


def _resolve(base_url: str, engine) -> Tuple[str, Any]:
    """``(racine, en-têtes)`` du serveur sondé.

    AUDIT 2026-09-16 — sans ``base_url`` ni ``engine``, le serveur est celui
    de la CIBLE COURANTE (``engines.current_engine``) : l'intégré hors tour de
    chat, le connecteur pendant un tour qui le vise — avec son en-tête
    d'authentification. Avant, la sonde partait sans en-tête : un llama-server
    lancé avec ``--api-key`` répondait 401 et ses capacités restaient
    UNKNOWN. Un moteur qui n'est pas llama.cpp n'est pas sondé (racine vide)."""
    if engine is None and not base_url:
        try:
            from llm_core.engines import current_engine
            engine = current_engine()
        except Exception:                           # noqa: BLE001
            engine = None
    if engine is not None:
        if not engine.is_llamacpp:
            return "", None
        if engine.is_builtin:
            try:
                from shared_infra.config import LLAMA_URL
                return _base(LLAMA_URL), None
            except Exception:                       # noqa: BLE001
                return "", None
        return _base(engine.base_root), (engine.header_dict() or None)
    return _base(base_url), None


async def engine_caps(base_url: str = "", *, force: bool = False,
                      engine=None) -> EngineCaps:
    """Capacités du moteur derrière ``base_url`` (ou ``engine``, ou la cible
    courante). Jamais d'exception.

    Best-effort de bout en bout : toute erreur rend ``UNKNOWN``, c'est-à-dire
    le comportement d'avant les capacités b10545.
    """
    base, headers = _resolve(base_url, engine)
    if not base:
        return UNKNOWN

    now = time.monotonic()
    hit = _cache.get(base)
    if not force and hit and (now - hit[0]) < CAPS_TTL_S:
        return hit[1]

    caps = UNKNOWN
    try:
        from llm_core._llama_http import _get_admin_client
        _kw = {"headers": headers} if headers else {}
        r = await _get_admin_client().get(f"{base}/props", timeout=3.0, **_kw)
        if r.status_code == 200:
            props = r.json() or {}
            build = parse_build(props.get("build_info"))
            if build > 0:
                caps = EngineCaps(
                    known=True, build=build,
                    is_router=(str(props.get("role") or "") == "router"),
                )
    except Exception as e:                          # noqa: BLE001
        logger.debug("[llama_caps] sonde /props impossible (%s) — repli sur le "
                     "comportement historique", str(e)[:120])

    # Une sonde en échec est mémorisée BRIÈVEMENT (``CAPS_FAIL_TTL_S``) : on
    # antidate son horodatage pour qu'elle expire tôt, sans changer la forme
    # du cache que lisent ``cached_caps`` et la garde de TTL ci-dessus.
    _cache[base] = (now if caps.known else now - (CAPS_TTL_S - CAPS_FAIL_TTL_S),
                    caps)
    if base not in _warned:
        _warned.add(base)
        logger.info("[llama_caps] %s : %s", base, caps.describe())
    return caps


def cached_caps(base_url: str = "", *, engine=None) -> EngineCaps:
    """Dernières capacités connues, SANS I/O. ``UNKNOWN`` si jamais sondé.

    Pour les rares chemins synchrones. Tout chemin async doit préférer
    ``engine_caps`` — lui rafraîchit.
    """
    base, _ = _resolve(base_url, engine)
    hit = _cache.get(base)
    return hit[1] if hit else UNKNOWN


def invalidate(base_url: str = "") -> None:
    """Oublie la sonde — après un redémarrage du moteur, ou en test."""
    if not base_url:
        _cache.clear()
        _warned.clear()
        return
    _cache.pop(_base(base_url), None)
