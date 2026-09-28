# SPDX-License-Identifier: MIT
"""llm_core.providers.llama_stream — flux SSE REPRENABLE de llama-server.

Depuis b10545, llama-server sait garder une génération en vie APRÈS la
disparition du client HTTP, et la relire ensuite depuis son tampon :

    POST /v1/chat/completions   + en-tête ``X-Conversation-Id: <id>``
        → la génération est adossée à une session nommée ; couper la
          connexion ne l'arrête plus.
    GET  /v1/stream?conv_id=<id>&from=<octet>
        → rejoue les octets SSE déjà produits, puis continue EN DIRECT.
    POST /v1/streams/lookup {"conversation_ids": [...]}
        → pour chaque id demandé : ``is_done``, ``total_bytes``, horodatages.
    DELETE /v1/stream?conv_id=<id>
        → arrêt explicite : annule le producteur et évince la session.

Vérifié en conditions réelles le 2026-08-22 (b10545, mode routeur) : client
coupé au bout de 25 caractères, ``lookup`` répond ``is_done:false``, la reprise
rejoue le début PUIS la suite, ``DELETE`` renvoie 204.

⚠ CONSÉQUENCE À NE PAS MANQUER — poser l'en-tête change la sémantique de
l'annulation : fermer le flux HTTP n'arrête PLUS le modèle. C'est
``cancel_stream`` qui arrête, et lui seul. Les deux sont câblés ensemble ; le
drapeau ``LLAMA_RESUMABLE_STREAM`` coupe les deux d'un coup.

Côté serveur : tampon en anneau de 4 Mio par session, TTL de 300 s après la
fin, et une nouvelle requête portant le MÊME id évince la précédente en
annulant son producteur (invariant « une conversation = au plus une session
vivante » — le même invariant que notre garde 409).

Rien ici n'est obligatoire : un build qui ignore l'en-tête ne crée pas de
session, la reprise répond 404 et l'appelant retombe sur le comportement
historique.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger("uvicorn.error")

CONV_HEADER = "X-Conversation-Id"


def conversation_id(user_id: Any, chat_id: Optional[str],
                    purpose: str = "chat") -> str:
    """Identifiant de session STABLE et non devinable.

    Stable : dérivé de la CONVERSATION — un worker recyclé, ou un autre
    worker, retombe sur le même id et peut donc reprendre le flux, ou
    l'arrêter.
    Non devinable : le serveur de modèles n'authentifie personne, et qui
    connaît un id peut LIRE le flux correspondant. On passe donc par un HMAC
    du secret d'instance plutôt que par ``chat`` en clair.

    ``purpose`` sépare les usages qui partagent une conversation : une
    compaction ne doit jamais évincer la session du run en cours (une requête
    au même id annule la précédente, côté serveur).

    ⚠ ``user_id`` est accepté pour la compatibilité des appels mais N'ENTRE
    PAS dans la clé — AUDIT 2026-08-23. Il ne PEUT pas y entrer : le harnais
    ne connaît que le NOM d'utilisateur (``_chat_with_tools`` reçoit
    ``user_id=username``, une chaîne) et la route d'annulation que son
    IDENTIFIANT NUMÉRIQUE (``require_user_id`` rend un int). Les deux HMAC
    différaient donc systématiquement : le ``DELETE /v1/stream`` de la route
    visait une session inexistante, le 404 était classé en succès, et le
    filet explicitement conçu pour le cas « worker mort / run détaché » —
    le SEUL qui arrête vraiment le modèle sur un flux nommé — était un no-op
    silencieux ; la génération tournait jusqu'à l'EOS sur le slot GPU pendant
    que la bannière annonçait « annulé ». C'est le même piège que
    ``shared_infra/reasoning_control``, qui l'avait déjà tranché de la même
    façon : la clé ne porte QUE le chat. Un ``chat_id`` appartient à un seul
    compte, et l'autorisation est faite en amont par ``get_chat`` dans la
    route ; le HMAC du secret d'instance suffit à la non-devinabilité.
    """
    if not chat_id:
        return ""
    try:
        from shared_infra.config import SESSION_SECRET as _secret
    except Exception:
        _secret = ""
    raw = f"{purpose}:{chat_id}".encode("utf-8", "replace")
    return hmac.new(str(_secret).encode("utf-8", "replace"), raw,
                    hashlib.sha256).hexdigest()[:32]


def headers_with_conv(headers: Optional[Dict[str, str]],
                      conv_id: str) -> Dict[str, str]:
    """Copie de ``headers`` portant l'en-tête de session (no-op si vide)."""
    out = dict(headers or {})
    if conv_id:
        out[CONV_HEADER] = conv_id
    return out


async def lookup_streams(client: Any, base_url: str, conv_ids: List[str],
                         model: str = "", *,
                         headers: Optional[Dict[str, str]] = None
                         ) -> Dict[str, Dict[str, Any]]:
    """Sessions vivantes parmi ``conv_ids`` — réponse AUTORITAIRE du moteur.

    Le serveur ne répond que sur les ids qu'on lui nomme : impossible
    d'énumérer les sessions d'autrui, et inutile de tenir un registre côté
    app. Best-effort : toute panne rend un dict vide (l'appelant retombe sur
    son propre état).
    """
    if not conv_ids:
        return {}
    try:
        payload: Dict[str, Any] = {"conversation_ids": list(conv_ids)}
        if model:
            payload["model"] = model
        _kw = {"headers": headers} if headers else {}
        r = await client.post(f"{base_url.rstrip('/')}/v1/streams/lookup",
                              json=payload, timeout=10.0, **_kw)
        if r.status_code != 200:
            return {}
        return {row["conversation_id"]: row for row in (r.json() or [])
                if isinstance(row, dict) and row.get("conversation_id")}
    except Exception as e:
        logger.debug("[llama_stream] lookup indisponible : %s", str(e)[:120])
        return {}


def resume_request(client: Any, base_url: str, conv_id: str,
                   model: str = "", from_bytes: int = 0, timeout: Any = None,
                   *, headers: Optional[Dict[str, str]] = None):
    """Gestionnaire de contexte du flux de REPRISE (``GET /v1/stream``).

    Rejoue le tampon depuis ``from_bytes`` puis bloque sur le direct — c'est
    donc un flux SSE identique à celui de la requête d'origine, que le
    consommateur habituel sait lire tel quel.
    """
    params: Dict[str, Any] = {"conv_id": conv_id, "from": int(from_bytes)}
    if model:
        params["model"] = model
    kw = {"timeout": timeout} if timeout is not None else {}
    if headers:
        kw["headers"] = headers
    return client.stream("GET", f"{base_url.rstrip('/')}/v1/stream",
                         params=params, **kw)


async def cancel_stream(client: Any, base_url: str, conv_id: str,
                        model: str = "", *,
                        headers: Optional[Dict[str, str]] = None) -> bool:
    """Arrêt EXPLICITE d'une session (``DELETE /v1/stream``).

    ⚠ Seul vrai moyen d'arrêter une génération adossée à une session : fermer
    la connexion ne suffit plus, c'est précisément ce que la reprise garantit.
    Fonctionne depuis N'IMPORTE QUEL worker (le moteur est l'autorité), ce que
    notre bus d'annulation par fichier ne pouvait pas offrir au modèle.
    """
    if not conv_id:
        return False
    try:
        params: Dict[str, Any] = {"conv_id": conv_id}
        if model:
            params["model"] = model
        _kw = {"headers": headers} if headers else {}
        r = await client.request("DELETE", f"{base_url.rstrip('/')}/v1/stream",
                                 params=params, timeout=10.0, **_kw)
        ok = r.status_code in (200, 204, 404)
        if not ok:
            logger.warning("[llama_stream] DELETE conv=%s → HTTP %s",
                           conv_id[:8], r.status_code)
        return ok
    except Exception as e:
        logger.debug("[llama_stream] DELETE indisponible : %s", str(e)[:120])
        return False


# ─────────────────────────────────────────────────────────────────────────────
#  Capacité OBSERVÉE : « ce moteur donne signe de vie pendant le silence »
# ─────────────────────────────────────────────────────────────────────────────
# Le read-timeout du flux est aujourd'hui ÉTIRÉ à l'aveugle en fonction de
# n_ctx : c'était la seule parade au silence du pré-remplissage (mesuré 33 s
# pour 4 339 tokens, donc des minutes sur un historique long). Conséquence :
# un moteur réellement planté immobilise le run jusqu'à ce plafond.
#
# Dès qu'un moteur nous a envoyé un ``prompt_progress`` — ou qu'une reprise a
# abouti — on SAIT qu'il ping pendant le silence, et le read-timeout peut
# redevenir court : le flux ne reste jamais muet plus que l'intervalle de ping.
# Mémoire par modèle, en RAM, remise à zéro au redémarrage du worker : on ne
# resserre jamais sur une supposition, seulement sur une observation.
_ALIVE_SIGNAL: Dict[str, bool] = {}


def _alive_key(model: str) -> str:
    """Par (serveur, modèle) — AUDIT 2026-09-16 : un ping observé sur un
    connecteur ne prouve rien du modèle homonyme de l'intégré (et vice versa)."""
    try:
        from llm_core.engines import current_engine
        return current_engine().cache_key(str(model or ""))
    except Exception:                                           # noqa: BLE001
        return str(model or "")


def note_alive_signal(model: str) -> None:
    if model:
        _ALIVE_SIGNAL[_alive_key(model)] = True


def has_alive_signal(model: str) -> bool:
    return bool(_ALIVE_SIGNAL.get(_alive_key(model)))


async def end_reasoning(client: Any, base_url: str, completion_id: str,
                        model: str = "", *,
                        headers: Optional[Dict[str, str]] = None) -> bool:
    """Ferme le bloc de raisonnement d'une complétion EN COURS.

    ``POST /v1/chat/completions/control {id, action:"reasoning_end"}``. Exige
    ``reasoning_control: true`` sur la requête d'origine — sinon le sampler de
    budget n'a pas été créé et l'appel est un non-événement.

    Ce n'est PAS une troncature : le modèle sort du raisonnement et rédige sa
    réponse. C'est la différence avec un plafond de génération, qui coupe au
    milieu d'une phrase et laisse le tour inutilisable.
    """
    if not completion_id:
        return False
    try:
        body: Dict[str, Any] = {"id": completion_id, "action": "reasoning_end"}
        if model:
            body["model"] = model
        _kw = {"headers": headers} if headers else {}
        r = await client.post(
            f"{base_url.rstrip('/')}/v1/chat/completions/control",
            json=body, timeout=10.0, **_kw)
        ok = r.status_code == 200 and bool((r.json() or {}).get("success"))
        if not ok:
            logger.info("[llama_stream] reasoning_end refusé (HTTP %s) : %s",
                        r.status_code, r.text[:160])
        return ok
    except Exception as e:
        logger.debug("[llama_stream] reasoning_end indisponible : %s", str(e)[:120])
        return False
