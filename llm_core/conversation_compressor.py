# SPDX-License-Identifier: MIT
"""
backend/services/conversation_compressor.py
───────────────────────────────────────────

Compression conversationnelle professionnelle pour longues sessions
agentic. Remplace les vieux tours d'une conversation par un résumé
structuré qui préserve les informations techniques permettant à un
agent successeur de reprendre la tâche sans perte.

Architecture
────────────

Trois zones dans une conversation compressée :

    [SYSTEM prompts originaux]             ← intacts
    [SUMMARY structuré cumulatif]          ← résumé XML-like
    [BRIDGE — quelques tours détaillés]    ← transition
    [RECENT — derniers tours intacts]      ← focus courant

Le résumé suit un format structuré à balises XML-like, plus robuste
que le JSON (moins d'erreurs d'échappement) et plus parsable qu'un
résumé narratif. Sections : <context>, <facts>, <actions_done>,
<state>, <pitfalls>. Les LLM modernes le produisent très fiablement.

Cumulativité
────────────

Si un résumé précédent existe dans la conversation (balise
<prev_summary> reconnue), le compresseur le fusionne avec les nouveaux
tours au lieu de réécrire depuis zéro. Ça évite la dilution
progressive et garde l'historique des pitfalls connus.

Modèle utilisé
──────────────

Par défaut : même modèle que la conversation (cohérence, pas de
dépendance externe). Si ``config.llm.compression.external_model`` est
défini, un modèle dédié est utilisé à la place (typiquement plus petit
et plus rapide, ne bloque pas la latence utilisateur).
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

import httpx

from shared_infra.config import LLAMA_MODEL
from shared_infra.observability.usage_ctx import record_turn_usage, usage_scope

logger = logging.getLogger("elpis.compressor")


# ─────────────────────────────────────────────────────────────────────────────
# Client HTTP dédié pour l'endpoint de compression externe
# ─────────────────────────────────────────────────────────────────────────────
#
# Volontairement SÉPARÉ du client principal (_get_llm_client dans
# backend/services/_legacy.py). Raisons :
#
#   1. Isolation du pool : le client principal est configuré pour
#      LLAMA_MAX_CONCURRENCY slots du serveur chat. Si on le réutilise pour
#      taper un autre serveur, on pollue ses keep-alives et on risque la
#      confusion côté httpx.
#
#   2. Timeout propre : la compression peut être plus longue que le chat
#      (gros prompt d'historique à ingérer). On veut un timeout dédié sans
#      impacter les requêtes chat concurrentes.
#
#   3. Lifecycle découplé : si l'admin désactive puis réactive l'endpoint,
#      on peut fermer ce client sans perturber le chat.

_endpoint_client: Optional[httpx.AsyncClient] = None
# BUG FIX B6 — lock pour la création du client httpx. Avant, le check
# `_endpoint_client is None or .is_closed` puis création n'étaient pas
# atomiques : deux compressions concurrentes pouvaient toutes deux passer
# le check et créer chacune un AsyncClient → fuite (le 2e remplace le 1er
# dans la global mais l'ancien reste référencé par la coroutine qui l'a
# créé). asyncio.Lock est lazy : pas créé tant que jamais nécessaire.
#
# BUG FIX (mineur) — la création paresseuse de ``_endpoint_client_lock``
# elle-même n'était pas thread-safe (si le module est importé ou utilisé
# depuis plusieurs loops/threads, par ex. en tests ou via ``asyncio.run``
# imbriqués). Le ``if X is None: X = Lock()`` peut s'entrelacer entre
# threads → deux locks distincts, dont un orphelin. On gate la création
# avec un ``threading.Lock`` (rapide, pas de await à l'intérieur).
import asyncio as _asyncio
import threading as _threading

_endpoint_client_lock: Optional[_asyncio.Lock] = None
_endpoint_client_lock_create_guard = _threading.Lock()


def _get_endpoint_client_lock() -> _asyncio.Lock:
    global _endpoint_client_lock
    if _endpoint_client_lock is not None:
        return _endpoint_client_lock
    with _endpoint_client_lock_create_guard:
        if _endpoint_client_lock is None:
            _endpoint_client_lock = _asyncio.Lock()
    return _endpoint_client_lock


async def _get_endpoint_client() -> httpx.AsyncClient:
    """Client HTTP paresseux, partagé entre toutes les compressions vers
    l'endpoint dédié. Créé au 1er appel, gardé en keep-alive.

    BUG FIX (config muette) : avant cette fonction prenait un
    ``timeout_sec`` qui était utilisé pour ``httpx.AsyncClient(timeout=...)``.
    Comme le client est mis en cache après la 1re création, le
    ``timeout_sec`` des appels suivants était silencieusement ignoré ;
    une reconfiguration admin n'avait effet qu'après redémarrage.
    Maintenant : pas de timeout client (None = pas de cap au niveau
    httpx), le timeout est appliqué *par requête* via le paramètre
    ``timeout=`` de ``client.post(...)`` dans l'appelant. Cela fait
    que chaque appel utilise le timeout courant de la config.
    """
    global _endpoint_client
    # Fast path sans lock : si déjà initialisé et open, retour direct.
    if _endpoint_client is not None and not _endpoint_client.is_closed:
        return _endpoint_client
    # Slow path sous lock : double-check pour éviter la race.
    async with _get_endpoint_client_lock():
        if _endpoint_client is None or _endpoint_client.is_closed:
            _endpoint_client = httpx.AsyncClient(
                # timeout=None : pas de plafond global au niveau client.
                # Chaque appel passe son propre timeout à client.post(...).
                timeout=None,
                limits=httpx.Limits(
                    max_keepalive_connections=2,
                    max_connections=4,
                    keepalive_expiry=120,
                ),
                http2=False,  # llama-server est HTTP/1.1
            )
        return _endpoint_client


async def close_endpoint_client() -> None:
    """À appeler au shutdown du serveur FastAPI (lifespan)."""
    global _endpoint_client
    if _endpoint_client and not _endpoint_client.is_closed:
        try:
            await _endpoint_client.aclose()
        except Exception:
            pass
        _endpoint_client = None


async def _call_external_endpoint(
    messages: List[Dict[str, Any]],
    *,
    url: str,
    model: str,
    timeout_sec: int,
) -> Tuple[str, Dict[str, Any]]:
    """Appel direct à un endpoint OpenAI-compatible (llama-server, vLLM, etc.)
    pour générer le résumé.

    Sampling conservateur (temp=0.2, top_p=0.9) : on veut du rappel factuel,
    pas de créativité. Les valeurs sont alignées sur ce que les modèles
    testés (Qwen2.5, Llama-3.2, Phi-3.5) produisent de plus fiable pour
    de la summarisation structurée.

    Non-streaming : un seul POST, on attend la réponse complète. Le résumé
    n'a pas vocation à être affiché token-par-token, donc streamer coûterait
    du code pour aucun gain UX.

    Retourne ``(content, meta)`` compatible avec la signature ``llama_chat``
    utilisée ailleurs dans le code — en particulier
    ``meta["model"]`` et ``meta["usage"]`` sont remplis.
    """
    payload = {
        "model":       model,
        "messages":    messages,
        "stream":      False,
        "temperature": 0.2,
        "top_p":       0.9,
        "max_tokens":  4096,  # cap raisonnable : un résumé XML-like dépasse rarement 1500 tokens
    }
    client = await _get_endpoint_client()
    resp = await client.post(url, json=payload, timeout=timeout_sec)
    resp.raise_for_status()
    data = resp.json()
    choices = data.get("choices") or []
    if not choices:
        return "", {"model": model, "error": "no_choices", "external_endpoint": True}
    content = ((choices[0].get("message") or {}).get("content")) or ""
    usage = data.get("usage") or {}
    return content.strip(), {
        "model":              model,
        "usage":              usage,
        "external_endpoint":  True,
        "endpoint_url":       url,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Estimation tokens — seuil proactif basé sur l'occupation du contexte
# ─────────────────────────────────────────────────────────────────────────────
#
# Heuristique UNIFIÉE (llm_core._token_estimate, ratio 3.3 chars/token
# conservateur) : le compresseur, _chat_with_tools et context_config
# partagent désormais le même fallback — avant, un chars/3 local faisait
# déclencher la porte de compression ~10 % plus tôt que le budget de
# contexte sur le même texte. Compte aussi le forfait image (absent de
# l'ancienne version : un chat multimodal sous-estimait son occupation).

def _estimate_tokens(messages: List[Dict[str, Any]],
                     model_id: Optional[str] = None) -> int:
    """Approximation rapide en tokens (content, tool_calls, forfait image)
    via le ratio chars/token MESURÉ (harnais v4 — plus de 3.3 statique hors
    amorce froide).

    NOTE: c'est un *fallback*. Pour les décisions critiques, préférer
    ``_count_tokens_async_ex`` (/tokenize exact).
    """
    from llm_core.context.tokens import measured_prompt_tokens
    return measured_prompt_tokens(messages, model_id=model_id or None)


async def _count_tokens_async_ex(
    messages: List[Dict[str, Any]],
    model_id: Optional[str] = None,
) -> "Tuple[int, bool]":
    """Compte les tokens via ``/tokenize`` côté llama-server, ou retombe
    sur l'heuristique unifiée si l'endpoint est indisponible. Retourne
    ``(tokens, estimated)`` — ``estimated=True`` en fallback heuristique
    (propagé jusqu'aux stats ``tokens_estimated`` de la compression).

    Préférable à ``_estimate_tokens`` quand on a le contexte async — la
    précision change la qualité des décisions de compression :
      - sur du texte FR/EN moderne (BPE Qwen, Llama3) ~3.5-4 chars/token
      - heuristique unifiée = chars/3,3 → surestime légèrement (marge voulue)
      - /tokenize = exact → décide au bon moment

    Sur un long chat, chaque compression économisée = ~1 LLM call de
    summarisation = quelques secondes (et un round-trip au modèle de
    compression). /tokenize coûte ~5-20ms et est caché par hash.
    """
    from llm_core._llama_http import count_tokens_for_messages
    n = await count_tokens_for_messages(messages, model_id, timeout=5.0)
    if n is not None:
        # Le compte exact est TEXTE seulement : les blocs image (non
        # tokenisables) ajoutent leur forfait PAR-DESSUS — même règle que la
        # jauge live (helper partagé). Le fallback heuristique ci-dessous
        # l'inclut déjà via est_tokens_message : ne PAS cumuler là-bas.
        from llm_core._token_estimate import image_forfait_tokens
        return n + image_forfait_tokens(messages), False
    # Fallback : heuristique
    return _estimate_tokens(messages, model_id), True


# ─────────────────────────────────────────────────────────────────────────────
# Prompt système — cœur technique du compresseur
# ─────────────────────────────────────────────────────────────────────────────
#
# Ce prompt a été affiné pour produire un résumé utilisable par un agent :
#   - Format XML-like rigide (parsable, pas d'ambiguïté)
#   - Style télégraphique factuel (pas "il a dit / elle a demandé")
#   - Préservation stricte des IDs, chemins, valeurs exactes
#   - Sections supprimées quand vides (pas de <facts></facts> vides)
#   - Fusion intelligente avec un résumé précédent si fourni
#
# Le prompt est volontairement ferme ("DOIT", "NE DOIS PAS") pour cadrer
# les LLM moins disciplinés. Les règles sont numérotées pour être citées
# dans les messages d'erreur de validation si le format est cassé.
#
# Le contenu est maintenant chargé depuis system_prompts/COMPRESSOR_SYSTEM.md
# (centralisé dans backend.config). Fallback inline minimal si le fichier
# est absent/vide : le compresseur ne peut pas fonctionner sans *aucune*
# instruction, donc on dégrade vers un prompt rudimentaire plutôt que de
# désactiver la compression. Le fallback produit un résumé moins bien
# structuré mais fonctionnel — et log un warning au chargement.

_FALLBACK_COMPRESSOR_PROMPT = (
    "You compress conversations. Produce a concise, factual, telegraphic "
    "summary of what was done, the current state, and the important "
    "technical facts (names, IDs, values). Write it in the conversation's "
    "language. Start directly with the summary, no introduction."
)

try:
    from shared_infra import config as _compr_cfg
    _COMPRESSOR_SYSTEM_PROMPT = (
        (getattr(_compr_cfg, "SYSTEM_PROMPT_COMPRESSOR", "") or "").strip()
        or _FALLBACK_COMPRESSOR_PROMPT
    )
    if _COMPRESSOR_SYSTEM_PROMPT is _FALLBACK_COMPRESSOR_PROMPT:
        logger.warning(
            "[compressor] system_prompts/COMPRESSOR_SYSTEM.md absent/vide → "
            "fallback inline minimal actif. Résumés moins structurés."
        )
except Exception as _compr_load_err:
    logger.warning(
        "[compressor] échec chargement prompt centralisé (%s) → fallback inline",
        _compr_load_err,
    )
    _COMPRESSOR_SYSTEM_PROMPT = _FALLBACK_COMPRESSOR_PROMPT


# ─────────────────────────────────────────────────────────────────────────────
# Marqueurs internes — détection d'un résumé déjà présent dans la conv
# ─────────────────────────────────────────────────────────────────────────────
#
# Le compresseur insère le résumé comme message system avec un préfixe
# identifiable. À la prochaine compression, on détecte cette chaîne pour
# extraire le résumé précédent et le fournir au LLM comme <prev_summary>.

_SUMMARY_MARKER_START = "[COMPRESSED_SUMMARY_V1]"
_SUMMARY_MARKER_END = "[/COMPRESSED_SUMMARY_V1]"


def _extract_previous_summary(messages: List[Dict[str, Any]]) -> Optional[str]:
    """Cherche un résumé de compression précédent dans les messages system.
    Retourne son contenu brut (le XML-like sans les marqueurs) ou None."""
    for m in messages:
        if m.get("role") != "system":
            continue
        content = m.get("content") or ""
        if _SUMMARY_MARKER_START in content:
            try:
                start = content.index(_SUMMARY_MARKER_START) + len(_SUMMARY_MARKER_START)
                end = content.index(_SUMMARY_MARKER_END, start)
                return content[start:end].strip()
            except ValueError:
                continue
    return None


def _format_summary_as_system_message(
    summary_xml: str,
    turns_compressed: int,
    ledger_block: str = "",
) -> Dict[str, Any]:
    """Emballe le résumé dans un message system avec marqueurs de détection
    + métadonnées lisibles par un humain qui relirait la conversation.

    ``ledger_block`` (v3) : bloc ``[ARTIFACTS v=1]`` déterministe épinglé
    APRÈS les marqueurs — hors du span renvoyé au LLM par
    ``_extract_previous_summary`` (jamais re-résumé), mais DANS la zone
    mangée par ``_strip_summary_span`` (retiré proprement avec l'ancien
    résumé à la recompression, pas de duplication)."""
    _note_default = (
        f"(Compressed memory of {turns_compressed} earlier turns. The facts "
        f"above are the source of truth for that period. The messages that "
        f"follow are the most recent, up-to-date ones.)"
    )
    # Note de ré-injection éditable à froid (compression.reinjection_note,
    # placeholder {n}). Vide => note FR historique ci-dessus → identique tant
    # que le JSON ne la surcharge pas. Permet d'aligner la langue sur le prompt
    # compresseur (EN) pour les petits modèles multilingues.
    _note = _note_default
    try:
        from llm_core.context_config import CTX as _CTX
        _ov = _CTX.override("compression.reinjection_note", "")
        if _ov:
            _note = _ov.replace("{n}", str(turns_compressed)) if "{n}" in _ov else _ov
    except Exception:
        pass
    body = (
        f"{_SUMMARY_MARKER_START}\n"
        f"{summary_xml.strip()}\n"
        f"{_SUMMARY_MARKER_END}\n"
        f"\n{_note}"
    )
    if (ledger_block or "").strip():
        body += f"\n\n{ledger_block.strip()}"
    return {"role": "system", "content": body}


# ─────────────────────────────────────────────────────────────────────────────
# État PERSISTANT de compression — round + tours couverts + résumé
# ─────────────────────────────────────────────────────────────────────────────
#
# Historiquement le résumé n'était JAMAIS persisté : la route ne sauvegarde
# que les messages client + la réponse, et le front ne renvoie jamais de
# message system. Conséquences : la re-compression était re-payée à CHAQUE
# tour au-delà du seuil (un appel LLM de résumé complet par tour !) et un
# cap « N compressions max par chat » était impossible à tenir.
#
# Le correctif : un message system d'ÉTAT, préfixé d'une ligne machine
# ``[COMPRESSION_META v=1 round=N covered_turns=M]`` au-dessus des marqueurs
# ``[COMPRESSED_SUMMARY_V1]`` existants (inchangés → compat totale avec
# _extract_previous_summary). La route le persiste EN TÊTE de messages_json
# et le ré-applique au chargement suivant :
#   - round          : nombre de compressions déjà appliquées (cap ×N)
#   - covered_turns  : tours de tête de l'historique client couverts par le
#                      résumé → re-droppés à chaque requête (économie réelle)
#   - summary_xml    : le résumé structuré lui-même
#
# Purge du chat = disparition du message d'état = compteur remis à zéro
# (sémantique assumée : un historique nettoyé peut re-compresser).

_COMPRESSION_META_RE = re.compile(
    r"\[COMPRESSION_META v=1 round=(\d+) covered_turns=(\d+)\]"
)

# Blocs de raisonnement qu'un fine-tune « reasoning » peut émettre dans le
# canal content même thinking désactivé (<think>…</think> / <thinking>…</thinking>).
# Retirés avant validation du résumé (sinon un raisonnement seul passait pour
# le résumé, ou masquait l'absence de balises structurées).
_RE_THINK_BLOCK = re.compile(r"<think(?:ing)?>.*?</think(?:ing)?>", re.DOTALL | re.IGNORECASE)
# Ouvrant de raisonnement ORPHELIN (sans fermeture) : cas d'une réponse coupée
# par le cap max_tokens EN PLEIN <think> — le strip close-only ne le voit pas.
_RE_THINK_OPEN = re.compile(r"<think(?:ing)?>", re.IGNORECASE)


def extract_compression_state(messages: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Extrait l'état de compression persisté depuis les messages system.

    Retourne ``{"round": int, "covered_turns": int, "summary_xml": str}``
    ou ``None`` si aucun résumé n'est présent. Un résumé V1 SANS ligne META
    (état pré-migration, théorique) est traité défensivement comme
    ``round=1, covered_turns=0`` : le cap le compte, le drop ne s'applique
    pas (0 tour couvert → injection seule).
    """
    for m in messages or []:
        if not isinstance(m, dict) or m.get("role") != "system":
            continue
        content = m.get("content") or ""
        if not isinstance(content, str) or _SUMMARY_MARKER_START not in content:
            continue
        try:
            start = content.index(_SUMMARY_MARKER_START) + len(_SUMMARY_MARKER_START)
            end = content.index(_SUMMARY_MARKER_END, start)
        except ValueError:
            continue
        summary = content[start:end].strip()
        # v3 — artifact ledger : cumulé de round en round via l'état (le
        # porteur le transporte hors marqueurs ; on le re-extrait ici pour
        # que build_state_system_message puisse le ré-épingler).
        _ledger_lines = parse_ledger_lines(content)
        _ledger = render_artifact_ledger(_ledger_lines) if _ledger_lines else ""
        mt = _COMPRESSION_META_RE.search(content)
        if mt:
            return {
                "round":         int(mt.group(1)),
                "covered_turns": int(mt.group(2)),
                "summary_xml":   summary,
                "ledger_block":  _ledger,
            }
        return {"round": 1, "covered_turns": 0, "summary_xml": summary,
                "ledger_block": _ledger}
    return None


def build_state_system_message(
    summary_xml: str,
    round_no: int,
    covered_turns: int,
    turns_compressed: Optional[int] = None,
    ledger_block: str = "",
) -> Dict[str, Any]:
    """Message system d'état : ligne META (machine) + résumé marqué V1
    (via ``_format_summary_as_system_message``, note humaine incluse) +
    artifact ledger éventuel (v3, hors marqueurs)."""
    base = _format_summary_as_system_message(
        summary_xml,
        turns_compressed if turns_compressed is not None else covered_turns,
        ledger_block=ledger_block,
    )
    meta = f"[COMPRESSION_META v=1 round={int(round_no)} covered_turns={int(covered_turns)}]"
    base["content"] = f"{meta}\n{base['content']}"
    return base


# Séparateur du fold opérationnel (_chat_with_tools._fold_operational_block)
# et de l'assemblage du socle (assemble_system_messages) : sert de borne de
# bloc quand un contenu system FUSIONNÉ porte socle + résumé dans une même
# chaîne (chat rechargé passé par le fold, contenu hérité).
_FOLD_SEP = "\n\n---\n\n"


def is_summary_carrier(msg: Any) -> bool:
    """True si ``msg`` est un message system porteur d'un bloc résumé
    ``[COMPRESSED_SUMMARY_V1]`` — l'état de compression injecté par
    ``apply_persisted_state`` ou reconstruit par ``compress()``.

    Public : ``_fold_operational_block`` (boucle outils) s'en sert pour ne
    JAMAIS fusionner le porteur dans le message système de tête. Un porteur
    avalé par la tête faisait perdre le socle ENTIER à la recompression
    suivante : le filtre de ``compress()`` jetait le message fusionné complet
    (identité + mémoire + skills + runtime_context + fragments compris).
    """
    return (
        isinstance(msg, dict)
        and msg.get("role") == "system"
        and isinstance(msg.get("content"), str)
        and _SUMMARY_MARKER_START in msg["content"]
    )


def _strip_summary_span(content: str) -> str:
    """Retire le(s) bloc(s) résumé (ligne META + marqueurs + note) d'un contenu
    system en PRÉSERVANT le reste (socle fusionné par un fold ou un coalesce).

    Piloté par les MARQUEURS, pas par un split sur séparateur : un contenu
    fusionné peut joindre en ``\\n\\n---\\n\\n`` (fold) comme en ``\\n\\n``
    (coalesce d'envoi). Bornes du bloc :

      - début : le séparateur de fold immédiatement au-dessus s'il jouxte le
        bloc, sinon la ligne ``[COMPRESSION_META…]`` collée au marqueur, sinon
        le marqueur START lui-même ;
      - fin : le prochain séparateur de fold APRÈS le marqueur END — la note
        qui suit le bloc est libre (surchargeable via
        ``compression.reinjection_note``), donc non pattern-matchable ; on
        mange jusqu'au séparateur suivant ou la fin de chaîne (le bloc d'état
        est toujours en dernière position d'une tête fusionnée réelle).
        START sans END (contenu corrompu) → coupe jusqu'à la fin.

    Retourne ``""`` si le message n'était que le bloc — l'appelant droppe
    alors le message entier (comportement historique du porteur autonome).
    """
    out = content
    while _SUMMARY_MARKER_START in out:
        s = out.index(_SUMMARY_MARKER_START)
        # Début : remonte à la ligne META si elle jouxte le marqueur…
        block_start = s
        m_meta = None
        for m_it in _COMPRESSION_META_RE.finditer(out, 0, s):
            m_meta = m_it                      # dernière META avant START
        if m_meta is not None and not out[m_meta.end():s].strip():
            block_start = m_meta.start()
        # …puis au séparateur de fold immédiatement au-dessus (pas de « --- »
        # orphelin après retrait).
        sep_prev = out.rfind(_FOLD_SEP, 0, block_start)
        if sep_prev != -1 and not out[sep_prev + len(_FOLD_SEP):block_start].strip():
            block_start = sep_prev
        # Fin : prochain séparateur de fold après END (note incluse), sinon EOS.
        e = out.find(_SUMMARY_MARKER_END, s)
        if e == -1:
            block_end = len(out)
        else:
            sep_next = out.find(_FOLD_SEP, e + len(_SUMMARY_MARKER_END))
            block_end = len(out) if sep_next == -1 else sep_next
        # Bloc en tête de chaîne : consomme aussi le séparateur SUIVANT (sinon
        # le reste commencerait par un « --- » orphelin).
        if block_start == 0 and block_end < len(out):
            block_end += len(_FOLD_SEP)
        out = out[:block_start] + out[block_end:]
    return out.strip()


def _strip_summary_messages(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Retire tout bloc résumé des messages system (idempotence : apply sur
    une liste déjà porteuse d'état ne duplique rien).

    Porteur AUTONOME (cas nominal) → message retiré entier, comme avant.
    Contenu FUSIONNÉ (défense : socle + résumé dans le même message, hérité
    d'un fold/coalesce) → seul le span résumé est retiré, le socle survit.
    Remplacement d'objet, jamais de mutation (dicts partagés avec l'historique).
    """
    out: List[Dict[str, Any]] = []
    for m in messages:
        if not is_summary_carrier(m):
            out.append(m)
            continue
        stripped = _strip_summary_span(m.get("content") or "")
        if stripped:
            out.append({**m, "content": stripped})
    return out


# Compaction PARTIELLE (2026-07-28) : cible d'occupation APRÈS compression,
# en fraction de la fenêtre utilisable (``usable``). 0.6 → on ne résume que
# les tours les plus anciens nécessaires pour redescendre à ~60 % du seuil ;
# le reste — le plus récent, donc le plus important — reste verbatim.
_PARTIAL_TARGET_RATIO = 0.6

# Coût ATTENDU du résumé produit, en tokens. Sert uniquement à projeter le gain
# AVANT l'appel LLM (garde ``gain_too_small``) : le prompt du compresseur borne
# la sortie à ~350 mots, et les résumés réellement produits en usage tournent
# autour de 450-600 tokens. Volontairement pessimiste — sous-estimer le coût
# ferait partir des compactions qui ne rapportent rien.
_EXPECTED_SUMMARY_TOKENS = 600


def _is_ephemeral(m: Any) -> bool:
    """Message de CONTRÔLE injecté mi-tour par le harnais (point d'étape
    budget, diagnostic de parse, relance compacte, nudge anti-boucle).

    Ce sont des ``role:user`` visibles du modèle mais JAMAIS persistés. Les
    compter comme des tours (audit 2026-08-01, P1-6) sur-comptait
    ``covered_turns`` à la compaction : au tour suivant, l'historique
    re-expansé ne contient plus ces messages, et ``_drop_leading_turns``
    jetait donc autant de VRAIS tours en trop — perte silencieuse d'un
    historique que le résumé ne couvrait pas.

    Import local et tolérant : ce module doit rester importable seul.
    """
    try:
        from llm_core.context.pruning import is_ephemeral
        return is_ephemeral(m)
    except Exception:
        return bool(isinstance(m, dict) and m.get("_ephemeral"))


def _leading_turn_groups(messages: List[Dict[str, Any]]) -> List[List[Dict[str, Any]]]:
    """Découpe ``messages`` (non-system) en GROUPES par tour — même sémantique
    que ``_count_turns``/``_drop_leading_turns`` : user = nouveau tour,
    assistant à tool_calls = nouveau tour, assistant pur = nouveau tour sauf
    réponse finale post-tool, tool = rattaché au tour courant."""
    groups: List[List[Dict[str, Any]]] = []
    cur: List[Dict[str, Any]] = []
    prev_was_tool = False
    for m in messages:
        role = m.get("role") if isinstance(m, dict) else None
        is_new = False
        if role == "user":
            is_new = not _is_ephemeral(m)
            prev_was_tool = False
        elif role == "assistant":
            is_new = bool(m.get("tool_calls")) or not prev_was_tool
            prev_was_tool = False
        elif role == "tool":
            prev_was_tool = True
        if is_new and cur:
            groups.append(cur)
            cur = []
        cur.append(m)
    if cur:
        groups.append(cur)
    return groups


def _drop_leading_turns(
    messages: List[Dict[str, Any]], n_turns: int,
) -> List[Dict[str, Any]]:
    """Retire les ``n_turns`` premiers TOURS non-system (même sémantique de
    tour que ``_count_turns`` : user=1, assistant à tool_calls=1, assistant
    pur=1 sauf réponse finale post-tool, tool=0 — rattaché à son tour)."""
    out: List[Dict[str, Any]] = []
    turns = 0
    prev_was_tool = False
    for m in messages:
        role = m.get("role") if isinstance(m, dict) else None
        if role == "system":
            out.append(m)
            continue
        if role == "user":
            if not _is_ephemeral(m):
                turns += 1
            prev_was_tool = False
        elif role == "assistant":
            if m.get("tool_calls"):
                turns += 1
            elif not prev_was_tool:
                turns += 1
            prev_was_tool = False
        elif role == "tool":
            prev_was_tool = True
        if turns > n_turns:
            out.append(m)
    return out


def apply_persisted_state(
    messages: List[Dict[str, Any]],
    state: Optional[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """Ré-applique l'état de compression persisté au prompt d'une requête.

    Le client renvoie TOUJOURS l'historique complet (les bulles visibles ne
    changent pas à la compression) : c'est ici que le résumé remplace
    concrètement les vieux tours à chaque requête.

      1. retire tout message-résumé déjà présent (idempotent) ;
      2. si ``covered_turns`` est COHÉRENT avec l'historique reçu (assez de
         tours restants pour les zones bridge+recent), droppe les
         ``covered_turns`` premiers tours ;
      3. sinon (ancien message édité/supprimé, retry…) DROP PARTIEL : on
         retire ``min(covered, total − keep)`` tours de tête — tous ≤
         covered donc subsumés par le résumé. L'ancien fallback tout-ou-rien
         renvoyait résumé + tours couverts EN DOUBLE à chaque requête. Cas
         dominant (retry / édition de FIN, tête intacte) : sûr. Résiduel :
         une suppression de TÊTE peut faire glisser un tour non résumé dans
         la fenêtre droppée (rare × rare, perte bornée, assumée) ;
      4. insère le message d'état après le bloc system de tête.

    Retourne ``(messages_ajustés, state_out)`` où ``state_out`` porte en plus
    ``applied_drop: bool`` et ``applied_drop_turns: int`` (nombre RÉEL de
    tours retirés — drop partiel possible) — indispensables au comptage
    cumulatif de ``covered_turns`` à la compression suivante : les tours
    couverts encore présents y seront re-comptés dans ``turns_compressed``
    (couverts exactement une fois).
    """
    if not state or not (state.get("summary_xml") or "").strip():
        return messages, state

    msgs = _strip_summary_messages(list(messages or []))
    covered = max(0, int(state.get("covered_turns") or 0))

    applied_drop = False
    dropped_turns = 0
    if covered > 0:
        try:
            from shared_infra import config as _cfg
            _keep = int(getattr(_cfg, "COMPRESSION_KEEP_RECENT", 6)) \
                + int(getattr(_cfg, "COMPRESSION_KEEP_BRIDGE", 3))
        except Exception:
            _keep = 9
        total_turns = _count_turns(msgs)
        # Après drop il doit rester AU MOINS les zones bridge+recent.
        # Historique cohérent (covered ≤ total − keep) → drop PLEIN.
        # Incohérent (édition/suppression côté client, retry) → drop PARTIEL
        # de ce qui peut l'être : chaque tour retiré est ≤ covered, donc
        # subsumé par le résumé (cf. docstring, point 3).
        dropped_turns = min(covered, max(0, total_turns - _keep))
        if dropped_turns > 0:
            msgs = _drop_leading_turns(msgs, dropped_turns)
            applied_drop = True

    state_msg = build_state_system_message(
        state["summary_xml"],
        int(state.get("round") or 1),
        covered,
        ledger_block=state.get("ledger_block") or "",
    )
    # Insertion après le bloc system de TÊTE (le résumé fait partie du
    # contexte d'amorçage, avant le premier tour visible).
    insert_at = 0
    for i, m in enumerate(msgs):
        if isinstance(m, dict) and m.get("role") == "system":
            insert_at = i + 1
        else:
            break
    msgs.insert(insert_at, state_msg)

    state_out = dict(state)
    state_out["applied_drop"] = applied_drop
    # Compte RÉEL de tours retirés (peut être < covered en drop partiel) :
    # le cumul de covered_turns au round suivant repose dessus.
    state_out["applied_drop_turns"] = dropped_turns
    return msgs, state_out


# ─────────────────────────────────────────────────────────────────────────────
# Découpage turn-based : on compte les "tours" (user→assistant) pas les messages
# ─────────────────────────────────────────────────────────────────────────────
#
# Un "tour" = un échange user → assistant (+ tools éventuels entre les deux).
# C'est l'unité naturelle de compression : on n'a pas envie de couper au
# milieu d'un cycle tool-call → tool-result → réponse assistant.

def _count_turns(messages: List[Dict[str, Any]]) -> int:
    """Compte le nombre de "tours" dans la conversation.

    Un "tour" est défini ici comme une UNITÉ DE PROGRESSION — pas
    seulement un échange user→assistant classique. Dans un pipeline
    agentic, un seul message user peut déclencher 30 tool calls ;
    chacun de ces cycles (assistant→tool_call→tool_result) compte
    comme un tour parce qu'il enrichit la conversation d'un échange
    structurel qui grossit le contexte.

    Règles :
      - Un message role=user compte pour 1 tour
      - Un message role=assistant qui appelle des tools compte pour 1 tour
      - Les messages role=tool (résultats) ne comptent pas
        (ils sont toujours appariés à l'assistant qui les a déclenchés)
      - Un message role=assistant pur (pas de tool) ne compte que s'il
        n'a pas été précédé immédiatement d'un tool result
        (évite de compter deux fois la "réponse finale" après tools)

    Cette définition garantit que :
      - Conversation classique 30 échanges user↔assistant → 30 tours
      - Conversation agentic 1 user + 25 tool calls → 26 tours
      - Mixte : chaque nouvelle "décision" du système compte
    """
    turns = 0
    prev_was_tool = False
    for m in messages:
        if not isinstance(m, dict):
            continue       # même garde que les autres lectures de « tour »
        role = m.get("role")
        if role == "user":
            # Nudge éphémère du harnais ⇒ PAS un tour (cf. _is_ephemeral).
            if not _is_ephemeral(m):
                turns += 1
            prev_was_tool = False
        elif role == "assistant":
            if m.get("tool_calls"):
                turns += 1
                prev_was_tool = False
            elif not prev_was_tool:
                # Assistant "pur" qui n'est pas juste une réponse après tools
                turns += 1
            prev_was_tool = False
        elif role == "tool":
            prev_was_tool = True
    return turns


def _split_by_turn_index(
    messages: List[Dict[str, Any]],
    keep_recent_turns: int,
    keep_bridge_turns: int,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Découpe les messages en 4 zones :
        (system, to_compress, bridge, recent)

    - system   : tous les messages role=system (y compris un éventuel résumé précédent)
    - to_compress : vieux tours à remplacer par le résumé
    - bridge   : tours de transition (gardés mais seront peut-être résumés plus tard)
    - recent   : derniers tours intacts, focus courant

    Le découpage se fait sur la base des TOURS (définis par _count_turns —
    voir la docstring de cette fonction). Un tour commence à chaque
    message user OU chaque assistant-avec-tool-calls. On ne coupe jamais
    entre un assistant-tool-call et son tool-result associé.
    """
    system_msgs = [m for m in messages if m.get("role") == "system"]
    non_system = [m for m in messages if m.get("role") != "system"]

    # Identifie les indices qui OUVRENT un nouveau tour dans non_system.
    # Même logique que _count_turns mais retourne les positions.
    turn_start_indices: List[int] = []
    prev_was_tool = False
    for i, m in enumerate(non_system):
        role = m.get("role")
        if role == "user":
            # AUDIT 2026-08-23 — les nudges du harnais sont des ``role:user``
            # ÉPHÉMÈRES : jamais persistés, donc absents de l'historique
            # ré-expansé au tour suivant. Les trois autres fonctions de tour de
            # ce module les excluent déjà (``_count_turns``,
            # ``_leading_turn_groups``, ``_drop_leading_turns``) ; celle-ci,
            # dont la docstring affirme pourtant « même logique que
            # _count_turns », les comptait. Or la boucle appende un
            # ``<harness_status>`` par palier d'itération : la séquence réelle
            # devient ``assistant(tool_calls) | tool | user(éphémère)``, soit
            # DEUX ouvertures de tour par itération au sens du découpage contre
            # UNE au sens du comptage. ``recent_start_turn_idx = total_turns −
            # keep_recent_turns`` découpait donc sur un compte gonflé et la
            # zone protégée fondait de moitié : mesuré, 4 cycles d'outil
            # préservés au lieu des 9 demandés par la configuration.
            if not _is_ephemeral(m):
                turn_start_indices.append(i)
            prev_was_tool = False
        elif role == "assistant":
            if m.get("tool_calls"):
                turn_start_indices.append(i)
                prev_was_tool = False
            elif not prev_was_tool:
                turn_start_indices.append(i)
            # pas de reset si c'est la réponse finale après tools
            prev_was_tool = False
        elif role == "tool":
            prev_was_tool = True

    total_turns = len(turn_start_indices)
    if total_turns <= keep_recent_turns + keep_bridge_turns:
        # Pas assez de tours pour compresser quoi que ce soit
        return system_msgs, [], [], non_system

    # Index du premier message "recent" et "bridge" dans non_system
    recent_start_turn_idx = total_turns - keep_recent_turns
    bridge_start_turn_idx = max(0, recent_start_turn_idx - keep_bridge_turns)

    recent_start = turn_start_indices[recent_start_turn_idx]
    bridge_start = (
        turn_start_indices[bridge_start_turn_idx]
        if keep_bridge_turns > 0 and bridge_start_turn_idx < recent_start_turn_idx
        else recent_start
    )

    to_compress = non_system[:bridge_start]
    bridge = non_system[bridge_start:recent_start] if keep_bridge_turns > 0 else []
    recent = non_system[recent_start:]

    return system_msgs, to_compress, bridge, recent


# ─────────────────────────────────────────────────────────────────────────────
#  ANCRE DE TÂCHE — le message ``user`` qui porte la mission ne part JAMAIS
# ─────────────────────────────────────────────────────────────────────────────
# Un "tour" au sens de ``_count_turns`` s'ouvre AUSSI sur un assistant qui
# appelle un outil. Sur une boucle agentique — un seul message ``user`` suivi
# de cinquante cycles outil — la fenêtre « recent » ne contient donc QUE des
# paires (assistant, tool) et l'énoncé de la mission tombe dans la zone
# résumée. L'historique reconstruit devient ``system, assistant, tool, …`` :
#
#   - il ne contient plus AUCUN ``user`` — les gabarits à alternance stricte
#     (famille Gemma et dérivés) lèvent ``raise_exception`` au rendu, ce que
#     llama-server renvoie en 500 ; le run mourait en pleine mission (constaté
#     en production le 2026-08-22, chat de 54 messages compacté à 29) ;
#   - et le modèle a purement et simplement OUBLIÉ ce qu'on lui demandait :
#     il ne lui reste que le résumé de ce qu'il a déjà fait.
#
# L'étage « budget dur » protège déjà cette ancre (``pruning.task_anchor_index``,
# audit 2026-08-01 P0-2) ; la compaction, elle, ne la protégeait pas. On
# ré-épingle donc l'énoncé en tête de la fenêtre conservée quand il vient
# d'être résumé.

_ANCHOR_PIN_MAX_CHARS = 6000
_ANCHOR_FALLBACK_TEXT = (
    "[SYSTEM] Mission in progress — the original request is summarized above. "
    "Continue from there."
)


def _anchor_message(messages: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Dernier ``user`` porteur de la demande = énoncé de la tâche en cours.

    Même définition que ``llm_core.context.pruning.task_anchor_index`` : les
    nudges du harnais (``_ephemeral``) sont des ``role:user`` qui ne portent
    aucune demande, ils ne font pas ancre. Seule exception : l'ancre
    RÉ-ÉPINGLÉE par un round précédent (``_task_anchor``), qui est éphémère
    par construction — elle porte l'énoncé, donc elle fait ancre.
    """
    for m in reversed(messages):
        if not (isinstance(m, dict) and m.get("role") == "user"):
            continue
        if m.get("_task_anchor") or not _is_ephemeral(m):
            return m
    return None


def _anchor_pin(content: str) -> Dict[str, Any]:
    """Message d'ancrage ré-épinglé.

    ``_ephemeral`` : il vit dans la vue modèle mais n'existe PAS dans
    l'historique persisté — sans ce marqueur il serait compté comme un vrai
    tour par ``_count_turns``, ``covered_turns`` serait sur-compté et
    ``_drop_leading_turns`` jetterait autant de vrais tours au tour suivant
    (exactement la panne décrite par ``pruning.is_ephemeral``).
    ``_task_anchor`` : il porte quand même la DEMANDE — le budget dur le
    protège (``pruning.task_anchor_index``) et le round de compaction suivant
    le reconnaît au lieu de le remplacer par le texte de repli.
    """
    return {"role": "user", "content": content,
            "_ephemeral": True, "_task_anchor": True}


def _pin_task_anchor(kept: List[Dict[str, Any]],
                     dropped: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Messages à ré-insérer en tête de ``kept`` pour qu'il porte une ancre.

    Retourne ``[]`` quand ``kept`` en contient déjà une ET commence par un
    ``user`` (cas courant : rien ne change, aucun coût, aucun octet de prompt
    déplacé).

    Audit 2026-09-24, n° 16 — ``kept`` peut porter l'ancre plus loin tout en
    COMMENÇANT par un assistant : un tour s'ouvre aussi sur un assistant
    (``_count_turns``), donc la coupe de la compaction partielle
    (``_n_take`` impair sur un échange user↔assistant) ou celle du bridge
    tombe entre une question et sa réponse. ``system, résumé, assistant, …``
    fait lever les gabarits à alternance stricte (Gemma, Mistral → 500) et
    Anthropic refuse un premier message ``assistant``. On pose alors un
    ``user`` ÉPHÉMÈRE de raccord : non compté comme tour (``covered_turns``
    et ``_drop_leading_turns`` restent exacts, la coupe elle-même ne bouge
    pas), jamais persisté — au tour suivant, l'historique ré-expansé tombe
    sur le même filet (``pruning._ensure_user_anchor``), même texte.
    """
    if _anchor_message(kept) is not None:
        first = next((m for m in kept if isinstance(m, dict)), None)
        if first is not None and first.get("role") in ("assistant", "tool"):
            from llm_core.context.pruning import _LEADING_ANCHOR_TEXT
            return [{"role": "user", "content": _LEADING_ANCHOR_TEXT,
                     "_ephemeral": True}]
        return []
    src = _anchor_message(dropped)
    if src is None:
        # Aucune ancre nulle part (historique déjà amputé par un round
        # précédent) : on en pose une minimale — un historique SANS ``user``
        # n'est pas rendable par les gabarits à alternance stricte.
        return [_anchor_pin(_ANCHOR_FALLBACK_TEXT)]
    content = src.get("content")
    if isinstance(content, list):
        # Multimodal : on ne ré-épingle QUE le texte. Ré-injecter l'image
        # doublerait une pièce jointe déjà comptée dans le résumé.
        content = " ".join(
            b.get("text", "") for b in content
            if isinstance(b, dict) and isinstance(b.get("text"), str)
        )
    content = str(content or "").strip() or _ANCHOR_FALLBACK_TEXT
    if len(content) > _ANCHOR_PIN_MAX_CHARS:
        from llm_core.context.pruning import truncate_head_tail
        content = truncate_head_tail(content, _ANCHOR_PIN_MAX_CHARS,
                                     reason="mission épinglée")
    return [_anchor_pin(content)]


# ─────────────────────────────────────────────────────────────────────────────
# Sérialisation des messages à compresser → texte dense
# ─────────────────────────────────────────────────────────────────────────────
#
# On transforme la liste de messages en un bloc de texte structuré que
# le LLM va résumer. Les tool calls et tool results sont aplatis en une
# forme compacte qui fait ressortir l'essentiel.

# Sérialisation de l'entrée du résumeur + artifact ledger : extraits vers
# context.compression.serializer (v3 — budget dérivé du n_ctx, fin des coupes
# 2000/200 destructrices, contenu des outils mutants remplacé par le ledger).
# Alias conservé pour les importeurs historiques.
from llm_core.context.compression.serializer import (
    compute_serializer_budget,
    extract_artifact_ledger,
    merge_ledger_lines,
    parse_ledger_lines,
    render_artifact_ledger,
    serialize_for_compression as _serialize_for_compression,
)

# ─────────────────────────────────────────────────────────────────────────────
# Interface publique — ConversationCompressor
# ─────────────────────────────────────────────────────────────────────────────
#
# API stateless : on passe les messages + config, on récupère la version
# compressée. Pas d'état partagé, pas de singleton, facile à tester.

class ConversationCompressor:
    """Compresseur stateless. L'état (résumé précédent) vit dans la
    conversation elle-même, extrait à la volée à chaque compression."""

    def __init__(
        self,
        llama_chat_fn: Callable,
        *,
        keep_recent_turns: int = 6,
        keep_bridge_turns: int = 3,
    ) -> None:
        """
        ``llama_chat_fn`` : async callable(messages, model_override=None) → (text, meta)
        Doit avoir la même signature que backend.services.llama_chat.

        Harnais v4 (M3) : plus de règles en TOURS (trigger_after/every) — le
        déclenchement appartient à la règle unique d'overflow du caller
        (``occupation réelle ≥ usable``). Il ne reste que la géométrie des
        zones conservées (recent/bridge) et la garde de matière minimale.
        """
        self.llama_chat = llama_chat_fn
        self.keep_recent_turns = keep_recent_turns
        self.keep_bridge_turns = keep_bridge_turns

    def min_matter_turns(self) -> int:
        """Matière MINIMALE pour qu'une compaction ait un sens : il faut que
        la zone ``to_compress`` existe au-delà des zones conservées."""
        return self.keep_recent_turns + self.keep_bridge_turns + 2

    async def compress(
        self,
        messages: List[Dict[str, Any]],
        *,
        model_override:       Optional[str] = None,
        user_id:              str           = "system",
        endpoint_url:         Optional[str] = None,
        endpoint_model:       Optional[str] = None,
        endpoint_timeout_sec: int           = 120,
        ctx_size_tokens:      Optional[int] = None,
        usable_tokens:        Optional[int] = None,
        force:                bool          = False,
        precomputed_tokens_before: Optional[Tuple[int, bool]] = None,
        count_exact:          bool          = True,
        extra_fixed_tokens:   int           = 0,
        require_projected_gain: bool        = False,
        fts_session_id:       Optional[str] = None,
        count_model:          Optional[str] = None,
    ) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
        """Compresse la conversation (le DÉCLENCHEMENT appartient au caller —
        règle unique d'overflow du harnais v4 dans maybe_compress/la boucle).

        Trois chemins d'appel LLM, dans l'ordre de préférence :

          1. ``endpoint_url`` non vide → POST direct à ce endpoint avec
             ``endpoint_model`` (serveur dédié, ne bloque pas le chat).
          2. Sinon ``model_override`` → appel à ``self.llama_chat`` avec
             ce nom de modèle (serveur principal, modèle différent —
             suppose LLAMA_MAX_MODELS > 1).
          3. Sinon → appel à ``self.llama_chat`` avec le modèle courant
             (même serveur, même modèle, il se résume lui-même).

        ``usable_tokens`` = seuil qui a DÉCLENCHÉ la compaction, en tokens :
        ancre de la compaction PARTIELLE automatique (cible ``seuil ×
        _PARTIAL_TARGET_RATIO``). C'est le plafond technique (n_ctx − cap de
        génération − buffer) par défaut, ou le seuil plus bas choisi par le
        compte quand il y en a un — l'appelant tranche, cf.
        ``maybe_compress_conversation(trigger_tokens=…)``. ``force=True`` (déclencheur
        MANUEL) = prise complète historique ; les gardes ``nothing_to_
        compress`` et qualité (no-gain, format) restent actives.

        ``precomputed_tokens_before`` = ``(tokens, estimated)`` déjà compté
        par le caller → évite un /tokenize redondant. Toujours BRUT
        (messages seuls) : le surcoût fixe est ajouté ici, jamais en amont.

        ``extra_fixed_tokens`` = surcoût FIXE du prompt réel absent des
        messages (schéma tools), ajouté SYMÉTRIQUEMENT aux stats
        ``tokens_before``/``tokens_after`` — la garde no-gain et
        ``tokens_saved`` (différences) y sont invariantes.

        ``require_projected_gain=True`` = renoncer AVANT l'appel LLM quand la
        zone compressible ne pèse même pas le résumé qui la remplacerait
        (``reason: gain_too_small``). Ce n'est pas un arbitrage de politique :
        c'est la garde NO-GAIN existante, avancée avant les 50 s d'appel au
        lieu d'être constatée après. Sur une boucle agentique la zone peut
        être minuscule alors que l'occupation dépasse le seuil — les tours
        protégés portent l'essentiel du poids et le résumeur ne se voit offrir
        que la tête maigre du run. Le manuel et le rattrapage « contexte
        dépassé » en sont dispensés : eux doivent tenter quoi qu'il arrive.

        Retourne ``(compressed_messages, stats)``. ``stats["compressed"]``
        est le booléen à tester pour savoir si quelque chose s'est passé.
        """
        # Compte les tokens UNE SEULE FOIS via /tokenize si possible — pour
        # les stats, la garde no-gain et la sélection partielle.
        # ``count_model`` (passe robustesse 2026-09-24) : le modèle avec
        # lequel l'APPELANT a compté ``precomputed_tokens_before``. Sans lui,
        # « avant » était compté avec le ratio du modèle de chat et « après »
        # avec celui du modèle de compression externe — la garde no-gain et
        # la sélection partielle mélangeaient deux unités.
        target_model_for_count = (count_model
                                  or model_override
                                  or endpoint_model
                                  or LLAMA_MODEL or "")
        if precomputed_tokens_before is not None:
            tokens_before, tokens_before_est = precomputed_tokens_before
        else:
            tokens_before, tokens_before_est = await _count_tokens_async_ex(
                messages, target_model_for_count or None,
            )

        system_msgs, to_compress, bridge, recent = _split_by_turn_index(
            messages,
            keep_recent_turns=self.keep_recent_turns,
            keep_bridge_turns=self.keep_bridge_turns,
        )

        if not to_compress:
            return messages, {"compressed": False, "reason": "nothing_to_compress"}

        # ── v4 : compaction PARTIELLE (automatique seulement) ─────────────
        # « Ne prend pas tout, garde le plus important » : on ne résume que
        # les tours les plus ANCIENS nécessaires pour redescendre à
        # ``usable × _PARTIAL_TARGET_RATIO`` ; les tours compressibles plus
        # récents restent VERBATIM entre le résumé et le bridge. Sélection en
        # tokens EXACTS (/tokenize LRU par message — zéro décision en chars).
        # Les tours pris forment un PRÉFIXE → ``covered_turns`` et le drop de
        # tête d'``apply_persisted_state`` restent exacts. Manuel (/compact)
        # ou ``usable`` inconnu : comportement historique (tout part au
        # résumé).
        kept_verbatim: List[Dict[str, Any]] = []
        # Cible d'occupation visée et poids RÉEL de la zone qui partira au
        # résumé — deux mesures qui n'existaient nulle part, alors que ce sont
        # elles qui disent si la compaction a une chance d'aboutir.
        _target_after = 0
        _zone_tokens = 0
        if not force and usable_tokens and usable_tokens > 0:
            try:
                from shared_infra import config as _pt_cfg
                _pt_ratio = float(getattr(_pt_cfg, "COMPACTION_PARTIAL_TARGET_RATIO",
                                          _PARTIAL_TARGET_RATIO))
            except Exception:
                _pt_ratio = _PARTIAL_TARGET_RATIO
            _target_after = int(usable_tokens * _pt_ratio)
            _excess = (tokens_before + int(extra_fixed_tokens or 0)) - _target_after
            if _excess > 0:
                _groups = _leading_turn_groups(to_compress)
                from llm_core.context.tokens import count_messages_tokens_per_msg
                _per_msg = await count_messages_tokens_per_msg(
                    to_compress, target_model_for_count or None)
                _sizes, _i = [], 0
                for _g in _groups:
                    _sizes.append(sum(_per_msg[_i:_i + len(_g)]))
                    _i += len(_g)
                _freed, _n_take = 0, 0
                for _sz in _sizes:
                    if _freed >= _excess:
                        break
                    _freed += _sz
                    _n_take += 1
                # Prendre < 2 tours ne vaut pas un appel résumeur ; tout
                # prendre = comportement historique (leftover vide).
                if 2 <= _n_take < len(_groups):
                    kept_verbatim = [m for g in _groups[_n_take:] for m in g]
                    to_compress = [m for g in _groups[:_n_take] for m in g]
                    _zone_tokens = _freed
                else:
                    _zone_tokens = sum(_sizes)

        # ── Garde de GAIN PROJETÉ : renoncer AVANT de payer l'appel LLM ──
        # L'occupation dépasse le seuil, mais la seule matière compressible
        # tient parfois en quelques centaines de tokens (tours protégés qui
        # portent tout le poids). Le résumé coûterait alors presque autant que
        # ce qu'il remplace : la garde no-gain, elle, ne s'en aperçoit qu'APRÈS
        # la génération, quand les 50 s sont dépensées.
        if require_projected_gain and _zone_tokens > 0:
            _projected = _zone_tokens - _EXPECTED_SUMMARY_TOKENS
            if _projected <= 0:
                logger.info(
                    "[compressor] compaction abandonnée avant l'appel : la "
                    "zone compressible ne pèse que %d tk, soit moins que le "
                    "résumé qui la remplacerait (~%d tk) — la garde no-gain "
                    "l'aurait annulée après coup (occupation %d tk, cible "
                    "%d tk)",
                    _zone_tokens, _EXPECTED_SUMMARY_TOKENS,
                    tokens_before + int(extra_fixed_tokens or 0), _target_after,
                )
                return messages, {
                    "compressed":          False,
                    "reason":              "gain_too_small",
                    # Re-tenter à l'itération suivante donnerait la MÊME
                    # réponse pour un coût de comptage non nul : la boucle
                    # diffère (cf. ``_compr_fail_streak``).
                    "defer_retry":         True,
                    "zone_tokens":         _zone_tokens,
                    "target_after_tokens": _target_after,
                    "tokens_before":       tokens_before + int(extra_fixed_tokens or 0),
                }

        turns_compressed = _count_turns(to_compress)

        # Récupère un résumé précédent si existant
        prev_summary = _extract_previous_summary(messages)

        # ── v3 : budget d'entrée du résumeur dérivé du n_ctx du modèle de
        # compression (fin de la coupe FIXE 2000 chars qui détruisait les gros
        # résultats). Endpoint distant / ctx inconnu → plancher historique.
        from llm_core.context.compression.serializer import (
            compute_serializer_budget_tokens,
            compute_serializer_total_budget_tokens,
        )
        from llm_core.context.tokens import tokens_to_chars
        _ser_budget = tokens_to_chars(
            compute_serializer_budget_tokens(len(to_compress), None))
        # Plafond TOTAL de l'entrée (audit 2026-09-24, n° 3) : le budget par
        # message ne bornait pas la somme. Défaut « fenêtre de 8 k » tant que
        # celle du modèle de compression est inconnue (endpoint distant).
        _ser_total = tokens_to_chars(compute_serializer_total_budget_tokens(None))
        if not endpoint_url:
            try:
                from llm_core import get_model_context_size as _gmcs
                _compr_ctx = await _gmcs(model_override or LLAMA_MODEL or "")
                _ser_budget = compute_serializer_budget(
                    len(to_compress), _compr_ctx,
                    model_id=(model_override or LLAMA_MODEL or None))
                _ser_total = tokens_to_chars(
                    compute_serializer_total_budget_tokens(_compr_ctx),
                    model_override or LLAMA_MODEL or None)
            except Exception:
                pass

        # ── v3 : artifact ledger — les fichiers touchés par les tours
        # compressés sont épinglés en bloc DÉTERMINISTE (op/chemin/taille/
        # statut), cumulé avec le ledger des rounds précédents (le disque est
        # la source de vérité ; le résumé LLM n'a plus à « retenir » du code).
        _prev_ledger_lines: List[str] = []
        for _m in messages:
            if is_summary_carrier(_m):
                _prev_ledger_lines = parse_ledger_lines(_m.get("content") or "")
                break
        _new_ledger_lines = [e.render() for e in extract_artifact_ledger(to_compress)]
        _ledger_block = render_artifact_ledger(
            merge_ledger_lines(_prev_ledger_lines, _new_ledger_lines),
        )

        # Construit le prompt de compression
        conversation_text = _serialize_for_compression(
            to_compress, max_chars_per_msg=_ser_budget,
            max_total_chars=_ser_total,
        )
        user_payload = conversation_text
        if prev_summary:
            # M5 — update-merge du résumé ANCRÉ : l'ancien résumé est fourni
            # tel quel et le modèle le MET À JOUR (fusion des faits nouveaux,
            # entrées encore pertinentes conservées) au lieu de régénérer de
            # zéro round après round.
            user_payload = (
                f"<anchored_summary>\n{prev_summary}\n</anchored_summary>\n\n"
                "Update the anchored summary above: merge in the facts from "
                "the new turns below, keep still-relevant entries, move "
                "finished work to Done, drop obsolete Next Steps. On "
                "contradiction, the new turns win. Output the FULL updated "
                "summary in the same anchored format.\n\n"
                f"{conversation_text}"
            )

        compression_prompt = [
            {"role": "system", "content": _COMPRESSOR_SYSTEM_PROMPT},
            {"role": "user",   "content": user_payload},
        ]

        # ── Choix du chemin d'appel LLM ─────────────────────────────────────
        _t_start = time.time()
        used_path = "self"  # pour les stats UI
        try:
            if endpoint_url:
                # CHEMIN 1 : endpoint dédié (préféré si configuré)
                used_path = "endpoint"
                _model_for_endpoint = endpoint_model or model_override or ""
                summary_text, meta = await _call_external_endpoint(
                    compression_prompt,
                    url         = endpoint_url,
                    model       = _model_for_endpoint,
                    timeout_sec = endpoint_timeout_sec,
                )
                # Registre d'usage : compresser COÛTE un appel LLM complet, et
                # ce coût n'était mesuré nulle part — la compression semblait
                # gratuite dans toutes les vues. Ce chemin ne passe pas par
                # ``llama_chat_stream_tokens``, il enregistre donc lui-même.
                with usage_scope("compression"):
                    record_turn_usage(
                        usage=(meta or {}).get("usage"),
                        model=_model_for_endpoint, path="compression",
                        duration_ms=int((time.time() - _t_start) * 1000),
                        iterations=1)
            else:
                # CHEMIN 2 ou 3 : llama_chat classique (même serveur)
                used_path = "external_model" if model_override else "self"
                # Cap de sortie : sans lui, le chemin self hérite de
                # LLAMA_MAX_TOKENS_CHAT (16k) — un résumé-fleuve mange le gain
                # de la compression. Aligné sur le cap de l'endpoint dédié ;
                # le budget dur du prompt (≤ ~350 mots) fait le vrai travail.
                # Détection de signature : les fakes de test (llama_chat_fn)
                # n'acceptent pas tous ``sampling_override``.
                _kw: Dict[str, Any] = {}
                try:
                    import inspect as _inspect
                    if "sampling_override" in _inspect.signature(
                            self.llama_chat).parameters:
                        _kw["sampling_override"] = {"max_tokens": 4096}
                except (TypeError, ValueError):
                    pass
                # Scope « compression » : l'appel descend dans
                # ``llama_chat_stream_tokens``, qui enregistre le tour — le
                # scope fait qu'il est étiqueté compression et non chat.
                with usage_scope("compression"):
                    summary_text, meta = await self.llama_chat(
                        compression_prompt,
                        user_id        = user_id,
                        model_override = model_override,
                        **_kw,
                    )
        except Exception as e:
            logger.warning(
                "[compressor] LLM call failed (path=%s): %s",
                used_path, str(e)[:200],
            )
            return messages, {
                "compressed": False,
                "reason":     f"llm_error: {str(e)[:200]}",
                "path":       used_path,
            }

        duration_ms = int((time.time() - _t_start) * 1000)

        # Retire le raisonnement : certains fine-tunes « reasoning » émettent des
        # blocs <think>…</think> dans le canal content MÊME thinking désactivé
        # (leur chat_template ignore enable_thinking=False). Sans ce strip, un
        # raisonnement seul (réponse coupée par le cap) passait pour le résumé,
        # ou le raisonnement masquait l'absence de balises → invalid_format
        # systématique = bouton manuel qui n'aboutit jamais.
        summary_text = _RE_THINK_BLOCK.sub("", summary_text or "").strip()
        # F11 — <think> NON FERMÉ (raisonnement tronqué par le cap max_tokens) :
        # le strip close-only ci-dessus ne le retire pas. Sans cette coupe, un
        # raisonnement partiel (sans balise XML) serait COERCÉ dans <context>
        # plus bas et INSTALLÉ comme résumé (la garde no-gain ne teste que la
        # taille) → N tours d'historique remplacés par du raisonnement tronqué.
        # On coupe de l'ouvrant orphelin jusqu'à la fin ; ce qui reste avant
        # (souvent vide) retombe sur summary_too_short → rollback propre.
        _m_open = _RE_THINK_OPEN.search(summary_text)
        if _m_open is not None:
            summary_text = summary_text[:_m_open.start()].strip()

        if not summary_text or len(summary_text) < 30:
            return messages, {
                "compressed":  False,
                "reason":      "summary_too_short",
                "path":        used_path,
                "duration_ms": duration_ms,
            }

        # Format attendu = balises XML (<context> etc.). Certains modèles
        # (non-anglophones, fine-tunes) rendent le résumé en headers markdown /
        # prose structurée SANS les balises. L'ancienne validation STRICTE
        # renvoyait alors summary_invalid_format → rollback → le bouton de
        # compression manuelle n'aboutissait JAMAIS sur ces modèles. On
        # ENVELOPPE désormais le contenu (déjà dense, ≥30 c., raisonnement
        # retiré) dans <context> : il redevient parsable et réinjectable — pas
        # de « narratif re-mergé non parsé » puisqu'il est maintenant structuré.
        # Le garde NO-GAIN ci-dessous reste la vraie sécurité contre un résumé
        # inutile (il annule proprement si aucun token n'est gagné).
        summary_coerced = False
        # M5 — format ancré : sections Markdown « ## … » attendues ; les
        # balises XML historiques restent acceptées (états persistés des
        # chats d'avant la bascule, re-merge sans churn). Ni l'un ni l'autre
        # → enveloppé dans <context> (coerce), le no-gain reste la sécurité.
        if not ("## " in summary_text or any(
                tag in summary_text for tag in
                ("<context>", "<facts>", "<state>", "<actions_done>", "<pitfalls>"))):
            logger.warning(
                "[compressor] résumé sans structure (ni sections ## ni balises, "
                "path=%s) → enveloppé dans <context> (coerce)", used_path,
            )
            summary_text = f"<context>\n{summary_text}\n</context>"
            summary_coerced = True

        # Reconstruit la conversation compressée :
        # [system originaux sans l'ancien résumé] + [nouveau résumé] + [bridge] + [recent]
        #
        # Ne PAS jeter un message entier parce qu'il porte le marqueur : sur un
        # chat rechargé passé par le fold (tête fusionnée socle+résumé), c'était
        # TOUT le socle (identité + mémoire + skills + runtime_context +
        # fragments) qui disparaissait pour le reste du run. On retire seulement
        # le SPAN du résumé ; le message ne tombe que s'il ne reste rien d'autre.
        system_without_prev_summary = []
        for m in system_msgs:
            _c = m.get("content") or ""
            if not (isinstance(_c, str) and _SUMMARY_MARKER_START in _c):
                system_without_prev_summary.append(m)
                continue
            _kept = _strip_summary_span(_c)
            if _kept:
                # Remplacement d'objet, jamais de mutation : le dict peut être
                # partagé avec l'historique persistant (même règle que le fold).
                system_without_prev_summary.append({**m, "content": _kept})
        summary_msg = _format_summary_as_system_message(
            summary_text, turns_compressed, ledger_block=_ledger_block,
        )

        compressed = []
        compressed.extend(system_without_prev_summary)
        compressed.append(summary_msg)
        # L'énoncé de la mission ne doit pas partir avec les tours résumés :
        # sans lui l'historique n'a plus aucun ``user`` (500 au rendu du
        # gabarit) et le modèle a oublié ce qu'on lui demande. Cf.
        # ``_pin_task_anchor`` : no-op quand la fenêtre conservée en porte
        # déjà un, c'est-à-dire dans la quasi-totalité des cas.
        compressed.extend(_pin_task_anchor(
            kept_verbatim + bridge + recent, to_compress))
        # Compaction partielle : les tours compressibles NON pris (les plus
        # récents de la zone) restent verbatim entre le résumé et le bridge.
        compressed.extend(kept_verbatim)
        compressed.extend(bridge)
        compressed.extend(recent)

        # Stats pour observabilité / UI
        original_chars = sum(len(str(m.get("content") or "")) for m in messages)
        compressed_chars = sum(len(str(m.get("content") or "")) for m in compressed)
        # ``tokens_before`` a déjà été compté plus haut via /tokenize (exact).
        # Pour ``tokens_after``, idem — on bénéficie aussi du cache LRU.
        # ``count_exact=False`` (cible non-locale) : heuristique unifiée,
        # cohérente avec le before (même règle → no-gain/ratio valides).
        if count_exact:
            tokens_after, tokens_after_est = await _count_tokens_async_ex(
                compressed, target_model_for_count or None)
        else:
            from llm_core.context.tokens import measured_prompt_tokens as _mpt2
            tokens_after, tokens_after_est = _mpt2(
                compressed, model_id=(target_model_for_count or None)), True
        tokens_estimated = bool(tokens_before_est or tokens_after_est)

        # Surcoût FIXE du run (schéma tools — hors messages) : ajouté
        # SYMÉTRIQUEMENT aux deux totaux → stats/événements cohérents avec la
        # jauge live. La garde no-gain et ``tokens_saved`` (différences) sont
        # invariantes ; ``precomputed_tokens_before`` reste BRUT côté caller.
        if extra_fixed_tokens:
            tokens_before += int(extra_fixed_tokens)
            tokens_after  += int(extra_fixed_tokens)

        # Garde NO-GAIN : un résumé plus verbeux que ce qu'il remplace (LLM
        # bavard, zone à compresser déjà courte) rendait la conversation PLUS
        # GROSSE — et l'ancien ``tokens_saved = max(0, …)`` masquait le cas
        # (0 affiché, compression quand même appliquée → perte définitive du
        # détail contre AUCUN gain). Rollback : l'original est conservé.
        if tokens_after >= tokens_before:
            logger.warning(
                "[compressor] compression sans gain (%d → %d tokens, path=%s) → rollback",
                tokens_before, tokens_after, used_path,
            )
            return messages, {
                "compressed":       False,
                "reason":           "no_token_gain",
                "tokens_before":    tokens_before,
                "tokens_after":     tokens_after,
                "tokens_estimated": tokens_estimated,
                "path":             used_path,
                "duration_ms":      duration_ms,
            }

        # ── Cible ATTEINTE ou non ────────────────────────────────────────
        # La compaction partielle vise ``seuil × ratio``. Rien ne vérifiait
        # qu'elle y arrivait : sur une boucle agentique, le plancher
        # structurel (socle + tours protégés + résumé) peut être 10 k au-dessus
        # de la cible, et la compaction repartait pour un tour toutes les
        # quelques itérations en grattant 3 k à chaque fois. On mesure l'écart
        # et on le dit — la boucle s'en sert pour espacer les tentatives.
        _asked = (tokens_before - _target_after) if _target_after > 0 else 0
        _got = tokens_before - tokens_after
        _target_reached = bool(_target_after <= 0 or tokens_after <= _target_after)
        # « Manquée » ≠ « pas pile sur la cible » : on ne parle d'échec que
        # quand moins de la MOITIÉ de l'excès demandé a été récupérée.
        _target_missed = bool(_asked > 0 and not _target_reached
                              and _got * 2 < _asked)
        if _target_missed:
            logger.warning(
                "[compressor] cible manquée : %d → %d tk (−%d) alors que la "
                "cible était %d tk — il manque %d tk. Zone compressible : "
                "%d tk. La matière compactable ne suffit pas à ramener "
                "l'occupation sous la cible (tours protégés = %d récents + %d "
                "de transition) ; prochaine tentative différée.",
                tokens_before, tokens_after, _got, _target_after,
                tokens_after - _target_after, _zone_tokens,
                self.keep_recent_turns, self.keep_bridge_turns,
            )

        stats = {
            "compressed":           True,
            "turns_compressed":     turns_compressed,
            "messages_before":      len(messages),
            "messages_after":       len(compressed),
            "chars_before":         original_chars,
            "chars_after":          compressed_chars,
            "tokens_before":        tokens_before,
            "tokens_after":         tokens_after,
            "tokens_saved":         max(0, tokens_before - tokens_after),
            "tokens_estimated":     tokens_estimated,
            "ratio":                round(compressed_chars / max(original_chars, 1), 3),
            "had_previous_summary": prev_summary is not None,
            "summary_coerced":      summary_coerced,
            "model_used":           (meta or {}).get("model") if isinstance(meta, dict) else None,
            "path":                 used_path,
            "duration_ms":          duration_ms,
            "ledger_block":         _ledger_block,
            "target_after_tokens":  _target_after,
            "target_reached":       _target_reached,
            "zone_tokens":          _zone_tokens,
            # Consommé par la boucle outils : une compaction qui aboutit sans
            # approcher sa cible ne doit pas être retentée dans la foulée.
            "defer_retry":          _target_missed,
        }

        # ── v3 : FTS AVANT destruction — les tool_results et tool_calls des
        # tours qui vont être remplacés par le résumé sont indexés dans la
        # recherche d'historique (session_search). Avant, une fois compressés
        # ils étaient perdus du contexte ET du rappel (double perte, audit
        # diagnostic #4). Lazy (uniquement au moment où on détruit), best-effort.
        # AUDIT 2026-08-31 (passe 3) — en threadpool : une transaction SQLite
        # (db_conn + INSERT + commit + triggers FTS5) PAR tool/tool_call
        # compressé — 60-100 pour 40 tours — s'exécutait sur la boucle, au
        # moment exact où l'utilisateur attend la reprise du flux ; sous
        # contention WAL, busy_timeout autorise 10 s PAR insert. Même
        # diagnostic que la télémétrie d'outils (engine/tool_exec).
        await _asyncio.to_thread(
            _index_covered_turns_fts,
            to_compress, username=user_id, session_id=fts_session_id,
        )
        logger.info(
            "[compressor] OK path=%s — %d tours résumés, %d→%d tokens (−%d, ratio %.1f%%), %dms, cumulatif=%s",
            used_path, turns_compressed,
            tokens_before, tokens_after, stats["tokens_saved"],
            stats["ratio"] * 100, duration_ms, prev_summary is not None,
        )
        return compressed, stats


def _index_covered_turns_fts(
    to_compress: List[Dict[str, Any]],
    *,
    username: str,
    session_id: Optional[str],
    app: str = "chat",
) -> None:
    """Indexe dans la recherche d'historique (FTS5, outil ``session_search``)
    les tool_results et tool_calls des tours SUR LE POINT d'être remplacés
    par le résumé.

    L'index de session ne couvre que user+assistant (``MemoryManager.
    sync_turn``) : une fois un tour compressé, ses sorties d'outils étaient
    perdues du contexte ET du rappel. Indexation LAZY — uniquement au moment
    de la destruction, zéro bruit tant que rien n'est compressé. Best-effort,
    ne lève jamais (la compression n'échoue pas sur un souci d'index).
    """
    try:
        from shared_infra.accounts.users import get_user
        from shared_infra.memory.store import session_index_messages
        row = get_user(username) if username else None
        if not row:
            return
        uid = int(row["id"])
        sid = str(session_id or "compressed")
        now = time.time()
        # (passe 8, B8) — lignes collectées puis écrites en UNE transaction
        # (avant : un commit par ligne, des centaines de prises du verrou
        # d'écriture d'affilée).
        rows: list = []
        for m in to_compress:
            if not isinstance(m, dict):
                continue
            role = m.get("role")
            if role == "tool":
                c = m.get("content")
                if isinstance(c, str) and c.strip():
                    rows.append(dict(user_id=uid, app=app, session_id=sid, scope_key="",
                                     role="tool", content=c[:4000], ts=now))
            elif role == "assistant":
                for tc in (m.get("tool_calls") or []):
                    if not isinstance(tc, dict):
                        continue
                    fn = tc.get("function") or {}
                    name = fn.get("name") or ""
                    args = fn.get("arguments")
                    if not name:
                        continue
                    txt = f"{name} {args if isinstance(args, str) else ''}".strip()
                    rows.append(dict(user_id=uid, app=app, session_id=sid, scope_key="",
                                     role="tool_call", content=txt[:1000], ts=now))
        n = session_index_messages(rows) if rows else 0
        if n:
            logger.info(
                "[compressor] %d ligne(s) outil indexée(s) en FTS avant "
                "compression (session %s)", n, sid[:12],
            )
    except Exception:
        logger.debug("[compressor] FTS pré-compression échoué (non-fatal)",
                     exc_info=True)


# ─────────────────────────────────────────────────────────────────────────────
# Helper unifié — appelable depuis n'importe quel chemin chat
# ─────────────────────────────────────────────────────────────────────────────
#
# Ce helper encapsule le cycle complet "check → compress → emit events"
# pour éviter la duplication dans :
#   - backend/services/_legacy.py : run_chat_multi_mcp (boucle tool-calling)
#   - backend/routes/_legacy.py : chemin chat classic (avant llama_chat_stream_tokens)
#
# La logique reste centralisée ici. Les caller sites font juste un appel
# et récupèrent la liste de messages (compressés si applicable, identique
# sinon). Comportement non-fatal : toute erreur est loggée et les messages
# originaux retournés.

# Raisons d'échec correspondant à une VRAIE tentative de compression (appel
# LLM parti, ou résumé produit mais rejeté) — par opposition aux pré-checks
# gratuits (threshold_not_reached, nothing_to_compress, disabled, not_run).
# La connaissance des chaînes ``reason`` reste DANS ce module : le moteur de
# chat ne doit pas matcher des préfixes de chaîne.
_ATTEMPTED_FAILURE_PREFIXES = (
    "llm_error", "summary_too_short", "summary_invalid_format",
    "no_token_gain", "exception",
)

# Warning « reload config échoué » émis UNE fois par process (puis debug).
_RELOAD_WARNED_ONCE = False


def compression_was_attempted(stats: Dict[str, Any]) -> bool:
    """True si la compression a réellement été TENTÉE (succès OU échec coûteux).

    BUG FIX (audit 2026-06) — utilisé par la boucle tool-calling pour
    appliquer le cooldown aussi sur échec : sans ça, un compresseur down
    (endpoint mort, timeout) était retenté à CHAQUE itération, un appel
    coûteux en boucle. Les pré-checks gratuits ne déclenchent pas le
    cooldown (le re-check est quasi nul).
    """
    try:
        if stats.get("compressed"):
            return True
        return str(stats.get("reason", "")).startswith(_ATTEMPTED_FAILURE_PREFIXES)
    except Exception:
        return False


async def maybe_compress_conversation(
    messages: List[Dict[str, Any]],
    *,
    llama_chat_fn:   Callable,
    on_event:        Optional[Callable] = None,
    model:           Optional[str]      = None,
    user_id:         str                = "system",
    log_prefix:      str                = "chat",
    ctx_size_tokens: Optional[int]      = None,
    real_tokens:     Optional[int]      = None,
    usable_tokens:   Optional[int]      = None,
    trigger_tokens:  Optional[int]      = None,
    max_rounds:      Optional[int]      = None,
    triggered_by_overflow: bool         = False,
    prev_state:      Optional[Dict[str, Any]] = None,
    manual:          bool               = False,
    extra_fixed_tokens: int             = 0,
    fts_session_id:  Optional[str]      = None,
    auto_enabled:    Optional[bool]     = None,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Vérifie si la conversation mérite une compression et l'applique si oui.

    Retourne ``(messages, stats)`` :
      - ``messages`` : liste compressée si applicable, sinon les messages
        originaux inchangés.
      - ``stats`` : dict ``{"compressed": bool, ...}``. Les callers
        peuvent tester ``stats["compressed"]`` pour savoir si la
        compression a effectivement eu lieu (utile pour un cooldown
        côté boucle tool-calling).

    Non-fatal : toute erreur est loggée et ``(messages_originaux, {"compressed": False, "reason": ...})``
    est retourné.

    ``trigger_tokens`` = seuil de DÉCLENCHEMENT effectif, quand il diffère du
    plafond technique ``usable_tokens`` (le compte a choisi de compacter plus
    tôt — cf. ``llm_core.context.compaction_gate``). ``None`` ⇒ le plafond
    technique fait office de seuil : comportement historique, à l'identique.
    C'est aussi l'ancre de la compaction PARTIELLE : la cible visée est
    ``trigger × partial_target_ratio``, sans quoi un seuil abaissé viserait
    une taille SUPÉRIEURE à l'occupation courante et ne compacterait rien.
    Comme ``auto_enabled``, c'est une décision DÉJÀ RÉSOLUE par l'appelant
    (cf. ``llm_core.context.compaction_gate``).

    ``max_rounds`` = cap de compactions pour CETTE conversation (auto ET manuel
    confondus, 0 = illimité), quand le compte en a choisi un. ``None`` ⇒ défaut
    d'instance ``COMPRESSION_MAX_PER_CHAT`` : comportement historique. Un run
    de plusieurs heures compacte dix fois ou plus — le cap par défaut y devient
    le facteur limitant, d'où le réglage per-user.

    ``prev_state`` = état persisté (cf. ``extract_compression_state`` /
    ``apply_persisted_state``) : porte le ``round`` (cap
    ``COMPRESSION_MAX_PER_CHAT``, auto ET manuel confondus) et le flag
    ``applied_drop`` (comptage cumulatif de ``covered_turns``).

    ``manual=True`` (déclencheur utilisateur) : bypasse les seuils
    ``should_compress`` — le cap, la garde nothing_to_compress et les gardes
    qualité (no-gain, format) restent actives.

    ``extra_fixed_tokens`` = surcoût FIXE du prompt réel absent de
    ``messages`` (schéma tools compté une fois par run dans la boucle
    outils). Compté dans le seuil de déclenchement et les totaux affichés
    (``compression_start.tokens``, stats) → mêmes ordres de grandeur que la
    jauge live. Chemins sans tools (classic, route manuelle) : 0.

    Sur succès, émet l'event INTERNE ``compression_state`` (round,
    covered_turns, summary_xml, stats) — intercepté par la route pour la
    persistance, jamais forwardé au client. Au cap atteint, émet
    ``compression_capped`` (round, max) — celui-là VA au client (badge UI).

    Pattern UX (inspiré de Claude Code / Cursor) :
      1. Pre-check ``should_compress`` AVANT d'émettre quoi que ce soit
      2. Si non → retourne immédiatement, aucun signal UI émis
      3. Si oui → émet ``compression_start`` (widget apparaît côté front)
      4. Appelle le LLM de compression (bloquant pour cette conversation
         uniquement ; les autres conversations continuent en parallèle
         si l'endpoint dédié est configuré)
      5. Émet ``compression_done`` avec stats enrichies
      6. Le caller enchaîne avec le contexte compressé

    Entre 3. et 5., la pipeline tool-calling de CETTE conversation est en
    pause. Les autres utilisateurs ne sont PAS affectés si
    ``endpoint_url`` est configurée (serveur séparé). En fallback
    (``endpoint_url`` vide) on bloque un slot du serveur principal —
    d'où l'intérêt de configurer un endpoint dédié pour les déploiements
    multi-utilisateurs.
    """
    _empty_stats: Dict[str, Any] = {"compressed": False, "reason": "not_run"}
    try:
        from shared_infra import config as _cfg
        # ── Multi-worker safety : resync depuis disk avant chaque compression.
        # En gunicorn multi-worker, le POST /api/admin/compression-config ne
        # met à jour QUE la mémoire du worker qui reçoit la requête. Sans
        # ce reload, les autres workers compresseraient avec leurs anciennes
        # valeurs (ex: trigger_after_turns=20 au lieu de 30) — c'est le bug
        # "les params ne sont pas pris en compte" rapporté par les admins.
        # Le reload utilise un cache mtime → cost quasi-nul en single-worker
        # et tant que config.json n'a pas changé. Best-effort : on ne bloque
        # pas la compression si le reload échoue pour une raison quelconque.
        try:
            _cfg.reload_compression_config_from_disk()
        except Exception as _reload_err:
            # 1er échec du process en WARNING (un admin qui modifie la config
            # multi-worker doit le voir), les suivants en debug (pas de spam :
            # l'échec se répète à chaque compression tant que la cause dure).
            global _RELOAD_WARNED_ONCE
            if not _RELOAD_WARNED_ONCE:
                _RELOAD_WARNED_ONCE = True
                logger.warning(
                    "[%s] reload_compression_config_from_disk a échoué : %s — ce worker "
                    "continue avec ses valeurs en mémoire (les changements admin ne sont "
                    "PAS appliqués ici). Averti une seule fois par process.",
                    log_prefix, str(_reload_err)[:120],
                )
            else:
                logger.debug(
                    "[%s] reload_compression_config_from_disk a échoué : %s (on continue avec les valeurs en mémoire)",
                    log_prefix, str(_reload_err)[:120],
                )
        # Le toggle ne gouverne que la compaction AUTOMATIQUE (déclenchée en
        # cours de génération, y compris le rattrapage « contexte dépassé »).
        # Une compaction MANUELLE (/compact, manual=True) est un acte explicite
        # de l'utilisateur : elle reste toujours possible.
        #
        # ``auto_enabled`` = décision DÉJÀ résolue par l'appelant (interrupteur
        # maître admin ET opt-in per-user ``compression_enabled``). None =
        # appelant qui ne connaît pas d'utilisateur (routines, outillage) →
        # repli sur le maître seul, comportement historique.
        _auto_on = _cfg.COMPRESSION_ENABLED if auto_enabled is None else bool(auto_enabled)
        if not _auto_on and not manual:
            return messages, {"compressed": False, "reason": "disabled"}

        compressor = ConversationCompressor(
            llama_chat_fn       = llama_chat_fn,
            keep_recent_turns   = _cfg.COMPRESSION_KEEP_RECENT,
            keep_bridge_turns   = _cfg.COMPRESSION_KEEP_BRIDGE,
        )

        # ── Résolution du chemin d'appel (endpoint dédié > external model > self)
        endpoint_url         = _cfg.COMPRESSION_ENDPOINT_URL
        endpoint_model       = _cfg.COMPRESSION_ENDPOINT_MODEL
        endpoint_timeout_sec = _cfg.COMPRESSION_ENDPOINT_TIMEOUT_SEC

        # ── LA règle (harnais v4) : occupation ≥ usable ───────────────────
        # ``usable`` = n_ctx − cap de génération − buffer : fourni par la
        # boucle (qui connaît thinking/tools), sinon dérivé du n_ctx ici.
        # Occupation, par ordre de vérité : mesure RÉELLE du serveur
        # (``real_tokens``, passée par la boucle) → estimation au ratio
        # MESURÉ (zéro I/O) confirmée par un comptage exact avant d'agir.
        # ``triggered_by_overflow`` : le serveur a DIT « contexte dépassé »
        # (KIND_CONTEXT_OVERFLOW) — la porte d'occupation est acquise.
        if usable_tokens is None and ctx_size_tokens and ctx_size_tokens > 0:
            from llm_core.context.compaction_gate import usable_window
            usable_tokens = usable_window(ctx_size_tokens, False)
        # Seuil EFFECTIF : celui du compte s'il est plus bas, sinon le plafond
        # technique. Borné par ``usable`` — un réglage ne doit jamais REPOUSSER
        # la compaction au-delà de ce que la fenêtre supporte.
        _trigger = usable_tokens
        if (trigger_tokens and trigger_tokens > 0
                and usable_tokens and usable_tokens > 0):
            _trigger = min(int(trigger_tokens), int(usable_tokens))
        # Résolu ICI (et non plus après la porte) : la porte d'occupation
        # doit compter avec le MÊME ratio chars/token que la boucle, et
        # le chemin manuel en a besoin autant que l'automatique.
        _model_for_count = (model or endpoint_model
                            or _cfg.COMPRESSION_EXTERNAL_MODEL
                            or LLAMA_MODEL or "")
        if not manual:
            _turns_cheap = _count_turns(messages)
            if _turns_cheap < compressor.min_matter_turns():
                return messages, {"compressed": False,
                                  "reason": "threshold_not_reached"}
            if not (usable_tokens and usable_tokens > 0):
                # Fenêtre inconnue (cible distante sans n_ctx) : impossible de
                # dimensionner quoi que ce soit — pas d'auto-compaction.
                return messages, {"compressed": False, "reason": "ctx_unknown"}
            if not triggered_by_overflow:
                if isinstance(real_tokens, (int, float)) and real_tokens > 0:
                    _occ = int(real_tokens)
                else:
                    from llm_core.context.tokens import measured_prompt_tokens
                    # AUDIT 2026-08-23 — ``model_id`` MANQUANT ici alors que la
                    # boucle le passe (``_chat_with_tools`` :3184/3191/3196).
                    # ``measured_chars_per_token`` retombait donc sur l'amorce
                    # froide 3.3 pendant que la boucle utilisait le ratio
                    # MESURÉ (2.6 sur un modèle code) : 27 % d'écart sur la
                    # MÊME occupation, comparée au MÊME seuil. La boucle
                    # ouvrait la porte, le compresseur répondait
                    # « threshold_not_reached », et la boucle ancrait ensuite
                    # cette estimation comme pseudo-mesure.
                    _occ = measured_prompt_tokens(
                        messages, model_id=(_model_for_count or None),
                        extra_fixed=extra_fixed_tokens)
                if _occ < _trigger:
                    return messages, {"compressed": False,
                                      "reason": "threshold_not_reached",
                                      "occupancy_tokens": _occ,
                                      "usable_tokens": usable_tokens,
                                      "trigger_tokens": _trigger}

        # ── Comptage exact (stats + partielle + confirmation) ─────────────
        # Cible NON llama.cpp (connecteur cloud / vLLM) : pas de /tokenize →
        # estimation au ratio mesuré, FLAGGÉE estimée — before et after
        # utilisent la même règle, donc la garde no-gain et le ratio restent
        # valides. Un connecteur llama.cpp compte exactement sur SON serveur
        # (``/tokenize`` suit la cible depuis le 2026-09-16).
        _count_exact = True
        try:
            from llm_core._target import current_target as _ct
            _count_exact = bool(_ct().is_llamacpp)
        except Exception:
            _count_exact = True
        if _count_exact:
            tokens_before, tokens_before_est = await _count_tokens_async_ex(
                messages, _model_for_count or None)
        else:
            from llm_core.context.tokens import measured_prompt_tokens as _mpt
            tokens_before, tokens_before_est = _mpt(
                messages, model_id=(_model_for_count or None)), True
        # Confirmation exacte quand la porte a ouvert sur l'ESTIMATION seule
        # (pas de mesure réelle, pas d'overflow serveur) : l'occupation
        # exacte est retournée dans les stats — la boucle l'ancre comme
        # pseudo-mesure pour ne pas re-payer ce comptage à chaque itération.
        if (not manual and not triggered_by_overflow
                and not (isinstance(real_tokens, (int, float)) and real_tokens > 0)):
            _occ_exact = tokens_before + int(extra_fixed_tokens or 0)
            if _occ_exact < _trigger:
                return messages, {"compressed": False,
                                  "reason": "threshold_not_reached",
                                  "occupancy_tokens": _occ_exact,
                                  "usable_tokens": usable_tokens,
                                  "trigger_tokens": _trigger}

        # ── Cap DUR par conversation (auto ET manuel) ──────────────────────
        # Vérifié APRÈS should_compress : l'event ``compression_capped`` ne
        # part que quand une compression AURAIT eu lieu (pas de spam à chaque
        # tour d'un chat au-dessus du seuil). _enforce_context_budget reste le
        # dernier rempart pour le fit du contexte.
        # Cap du COMPTE s'il en a réglé un (0 = illimité, valeur légitime :
        # d'où le test sur None et pas sur la véracité), défaut d'instance
        # sinon.
        _max_rounds = (int(max_rounds) if max_rounds is not None
                       else int(getattr(_cfg, "COMPRESSION_MAX_PER_CHAT", 0) or 0))
        _rounds_done = int((prev_state or {}).get("round") or 0)
        if _max_rounds > 0 and _rounds_done >= _max_rounds:
            logger.info(
                "[%s] compression bloquée : cap atteint (%d/%d rounds)%s",
                log_prefix, _rounds_done, _max_rounds, " [manuel]" if manual else "",
            )
            if on_event:
                try:
                    await on_event({
                        "type":  "compression_capped",
                        "round": _rounds_done,
                        "max":   _max_rounds,
                    })
                except Exception:
                    pass
            return messages, {
                "compressed": False, "reason": "max_rounds_reached",
                "round": _rounds_done, "max": _max_rounds,
            }

        # À partir d'ici on sait qu'on va compresser. Signal clair à l'user.
        if endpoint_url:
            compress_model = endpoint_model or model or ""
            uses_external  = True
            path_kind      = "endpoint"
        elif _cfg.COMPRESSION_EXTERNAL_MODEL:
            compress_model = _cfg.COMPRESSION_EXTERNAL_MODEL
            uses_external  = True
            path_kind      = "external_model"
        else:
            compress_model = model or ""
            uses_external  = False
            path_kind      = "self"

        turns_before = _count_turns(messages)
        # ``tokens_before`` déjà compté plus haut via /tokenize.

        if on_event:
            try:
                await on_event({
                    "type":     "compression_start",
                    "external": uses_external,
                    "path":     path_kind,
                    "model":    compress_model,
                    "turns":    turns_before,
                    # Même base que la jauge live : messages + surcoût fixe
                    # (tools) — le widget et la jauge racontent le même chiffre.
                    "tokens":   tokens_before + int(extra_fixed_tokens or 0),
                    "ctx_size": ctx_size_tokens or 0,
                    # L5.5 : seuil qui a déclenché (jetons) et motif.
                    "threshold": int(_trigger or 0),
                    "reason":    ("manual" if manual else "overflow" if triggered_by_overflow
                                  else "threshold"),
                })
            except Exception:
                pass

        logger.info(
            "[%s] compression triggered : path=%s, model=%s, turns=%d, tokens≈%d, "
            "n_ctx=%s, seuil=%s%s",
            log_prefix, path_kind, compress_model,
            turns_before, tokens_before + int(extra_fixed_tokens or 0), ctx_size_tokens,
            _trigger,
            "" if _trigger == usable_tokens else f" (plafond technique {usable_tokens})",
        )

        # Renoncer avant l'appel quand la zone ne pèse même pas son résumé.
        # Le déclencheur MANUEL et le rattrapage « contexte dépassé » en sont
        # dispensés : le premier est un ordre explicite, le second une
        # situation où toute marge est bonne à prendre.
        _want_gain = not manual and not triggered_by_overflow

        # ── Appel BLOQUANT au LLM de compression ──────────────────────────
        compressed, stats = await compressor.compress(
            messages,
            model_override       = _cfg.COMPRESSION_EXTERNAL_MODEL or model,
            user_id              = user_id,
            endpoint_url         = endpoint_url or None,
            endpoint_model       = endpoint_model or None,
            endpoint_timeout_sec = endpoint_timeout_sec,
            ctx_size_tokens      = ctx_size_tokens,
            # Ancre de la compaction PARTIELLE = le seuil qui a DÉCLENCHÉ, pas
            # le plafond technique. Avec un seuil abaissé (ex. 131k pendant que
            # ``usable`` vaut 225k), viser ``usable × 0.6`` = 135k reviendrait à
            # viser PLUS que l'occupation courante : rien à résumer, no-gain.
            # Viser ``trigger × 0.6`` compacte vraiment et donne l'hystérésis
            # (on redescend à 60 % du seuil, le tour suivant ne re-déclenche pas).
            usable_tokens        = _trigger,
            force                = manual,
            count_exact          = _count_exact,
            # Déjà compté ci-dessus sur la MÊME liste → évite un /tokenize
            # redondant (le should_compress interne re-vérifie sans re-compter).
            # BRUT (sans extra) : compress() ajoute le surcoût lui-même.
            precomputed_tokens_before = (tokens_before, tokens_before_est),
            extra_fixed_tokens   = int(extra_fixed_tokens or 0),
            require_projected_gain = _want_gain,
            fts_session_id       = fts_session_id,
            count_model          = _model_for_count or None,
        )

        # ── Comptabilité d'état (round + tours couverts cumulés) ──────────
        # covered_turns cumule le nombre RÉEL de tours retirés en début de
        # requête (``applied_drop_turns`` — drop partiel possible) : les
        # tours couverts encore présents dans la liste sont re-comptés dans
        # ``turns_compressed`` → couverts exactement une fois. Compat : un
        # état sans ``applied_drop_turns`` retombe sur l'ancien booléen.
        if stats.get("compressed"):
            _new_round = _rounds_done + 1
            _ps = prev_state or {}
            if "applied_drop_turns" in _ps:
                _prev_cov = int(_ps.get("applied_drop_turns") or 0)
            else:
                _prev_cov = int(_ps.get("covered_turns") or 0) \
                    if _ps.get("applied_drop") else 0
            _new_covered = _prev_cov + int(stats.get("turns_compressed") or 0)
            stats["round"]      = _new_round
            stats["max_rounds"] = _max_rounds
            _summary_xml = _extract_previous_summary(compressed) or ""
            # Aussi exposé dans les stats : la boucle tool-calling s'en sert
            # pour faire avancer son état local (une 2e compression dans le
            # MÊME run doit voir round+1, pas l'état d'entrée de requête).
            stats["new_state"] = {
                "round":            _new_round,
                "covered_turns":    _new_covered,
                "summary_xml":      _summary_xml,
                "turns_compressed": int(stats.get("turns_compressed") or 0),
                # v3 : le ledger voyage avec l'état (rebuild du porteur à la
                # persistance et aux requêtes suivantes).
                "ledger_block":     stats.get("ledger_block") or "",
            }
            if on_event and _summary_xml:
                try:
                    # Event INTERNE (persistance) — la route l'intercepte et ne
                    # le forwarde jamais au client (pattern tool_history_partial).
                    # Champs = exactement ce que la persistance consomme
                    # (round/covered/summary/turns) — rien de décoratif.
                    await on_event({
                        "type":             "compression_state",
                        "round":            _new_round,
                        "covered_turns":    _new_covered,
                        "summary_xml":      _summary_xml,
                        "turns_compressed": int(stats.get("turns_compressed") or 0),
                        "ledger_block":     stats.get("ledger_block") or "",
                    })
                except Exception:
                    pass

        # ── Signal de fin (toujours émis, avec stats) ─────────────────────
        if on_event:
            try:
                await on_event({
                    "type":     "compression_done",
                    "external": uses_external,
                    "path":     path_kind,
                    "stats":    stats,
                })
            except Exception:
                pass

        if stats.get("compressed"):
            logger.info(
                "[%s] compression OK : %d → %d msgs, %d → %d tokens (−%d), %dms, cumulatif=%s",
                log_prefix,
                stats.get("messages_before", 0),
                stats.get("messages_after", 0),
                stats.get("tokens_before", 0),
                stats.get("tokens_after", 0),
                stats.get("tokens_saved", 0),
                stats.get("duration_ms", 0),
                stats.get("had_previous_summary", False),
            )
            return compressed, stats

        # Compression tentée mais non aboutie (résumé trop court, endpoint KO, etc.)
        logger.warning(
            "[%s] compression attempted but not applied : %s",
            log_prefix, stats.get("reason", "unknown"),
        )
        return messages, stats
    except Exception as err:
        logger.warning(f"[{log_prefix}] compression failed (non-fatal): {err}")
        return messages, {"compressed": False, "reason": f"exception: {str(err)[:200]}"}
