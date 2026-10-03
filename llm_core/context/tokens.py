# SPDX-License-Identifier: MIT
"""llm_core.context.tokens — L'AUTORITÉ unique de comptage de tokens.

Toute question « combien de tokens ? » de l'app passe ici :

- **Exact d'abord** : tokenizer réel de llama-server (``POST /tokenize``
  par message avec cache LRU, ``/apply-template`` pour le prompt RENDU
  complet) via ``count_tokens_exact`` / ``count_rendered_prompt_tokens_exact``.
- **Fallback heuristique UNIQUE** : ratio ``CHARS_PER_TOKEN = 3.3``
  (conservateur : SURESTIME — les BPE modernes tournent à ~3.5-4 chars/token
  FR/EN), surcoût fixe ``MSG_OVERHEAD_TOKENS`` par message, forfait image
  ``image_token_cost()``.

Historique (audit 2026-07) : trois ratios divergents coexistaient (4.0 dans
context_config, 3.5 dans rag_tools et la compaction, 3.3 ici) et le comptage
« jauge / budget / porte de compression » vivait en sous-système privé de
``_chat_with_tools`` — les décisions divergeaient de ~15-20 % sur le même
texte. Ce module est la source de vérité ; ``llm_core._token_estimate`` est
conservé en shim de compatibilité.

Testabilité : ``count_tokens_exact`` est importé au NIVEAU MODULE — les
tests le monkeypatchent via ``llm_core.context.tokens.count_tokens_exact``.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from collections import OrderedDict
from typing import Any, Dict, List, Optional, Tuple

from llm_core._llama_http import count_tokens_exact

logger = logging.getLogger("uvicorn.error")

# Ratio chars/token unique du fallback. Doit rester ≤ au ratio réel des
# tokenizers cibles (surestimation = marge de sécurité pour les budgets).
# Depuis T0 (harnais v4, 2026-07-28) il ne sert plus que d'AMORCE FROIDE au
# ratio MESURÉ ci-dessous — plus aucune décision ne repose sur lui.
CHARS_PER_TOKEN = 3.3
# Surcoût fixe par message (délimiteurs de rôle / balises du chat template).
MSG_OVERHEAD_TOKENS = 8

# Caractères « LARGES » (audit 2026-09-24, n° 4) : idéogrammes CJK, kana,
# hangul, écritures indiennes / thaï / birman, pleine chasse, emoji. Les BPE
# courants les découpent à ~1 token par caractère (souvent plus sur les
# vieux vocabulaires) — rien à voir avec les ~3.5-4 chars/token du latin.
# Compter un texte chinois en ``len()/3.3`` le sous-estimait donc d'un facteur
# ~3 sur les connecteurs sans /tokenize. Chaque caractère large pèse ici
# ``_WIDE_CHAR_WEIGHT`` caractères latins, soit ~1 token au ratio d'amorce.
# Les accents, le cyrillique, le grec, l'arabe et la ponctuation typographique
# (« … », « — », « ’ ») restent à 1 : ils sont sous U+0900 ou dans le bloc
# de ponctuation générale (< U+2E80).
_WIDE_CHAR_WEIGHT = CHARS_PER_TOKEN
_WIDE_CHARS_RE = re.compile("[\u0900-\u109f\u1100-\u11ff\u2e80-\U0010ffff]")


def weighted_len(s: Optional[str]) -> int:
    """Longueur « équivalent latin » d'un texte : ``len(s)`` pour l'ASCII et
    le latin étendu, ``_WIDE_CHAR_WEIGHT`` par caractère large.

    Chemin rapide ``isascii()`` (cas dominant : code, JSON, anglais) ; sinon
    un seul balayage regex en C — pas de boucle Python par caractère sur le
    chemin chaud du fast-path."""
    if not s:
        return 0
    if s.isascii():
        return len(s)
    n_wide = len(_WIDE_CHARS_RE.findall(s))
    if not n_wide:
        return len(s)
    return len(s) - n_wide + int(round(n_wide * _WIDE_CHAR_WEIGHT))


# ──────────────────────────────────────────────────────────────────────────
# Ratio MESURÉ chars/token — par modèle, alimenté par l'usage RÉEL serveur
# ──────────────────────────────────────────────────────────────────────────
# Principe « zéro décision en chars » (harnais v4) : les seuils de l'app sont
# en TOKENS. Quand une longueur de CHAÎNE doit être matérialisée (coupe d'un
# résultat d'outil, budget de sérialisation) ou qu'un DELTA doit être estimé
# sans I/O (fast-path), on convertit via ce ratio — mesuré sur les réponses
# réelles (chars du prompt envoyé ÷ prompt_tokens facturés), PAS une
# constante. EWMA par modèle, bornée contre les mesures aberrantes ; amorce
# froide = CHARS_PER_TOKEN, remplacée dès la première réponse réelle.
#
# NB : le ratio inclut le surcoût du chat template dans son dénominateur →
# il SOUS-estime légèrement les chars/token du contenu pur, donc les coupes
# matérialisées sont un peu plus courtes que le budget — le bon côté.
#
# Unité du numérateur : chars PONDÉRÉS (``weighted_len``) — la même que celle
# des estimations qui divisent par ce ratio. Borne basse (audit 2026-09-24,
# n° 4) : à 1.5, une vraie mesure sur du texte CJK (0.6-1.4 chars BRUTS par
# token) était jetée en silence et l'estimation restait ~3× trop basse. Avec
# le numérateur pondéré, un prompt CJK mesure ~2-5 ; la borne descend à 1.0,
# sous laquelle la mesure est réellement aberrante (images non déclarées,
# numérateur incomplet) — rejetée, mais tracée.
_RATIO_ALPHA = 0.3
_RATIO_MIN, _RATIO_MAX = 1.0, 8.0
_measured_ratio: Dict[str, float] = {}


def note_real_usage(model_id: Optional[str],
                    prompt_chars: int, prompt_tokens: int,
                    n_images: int = 0) -> None:
    """Alimente le ratio mesuré depuis une réponse RÉELLE du serveur.
    Best-effort, jamais d'exception (chemin chaud de la boucle).

    ``n_images`` : nombre de blocs image du prompt mesuré (cf.
    ``count_image_blocks``). Audit 2026-09-24, n° 6 — le numérateur ne voit
    pas les images, le dénominateur (``prompt_tokens``) les facture : le
    ratio sortait trop BAS, puis les estimations rajoutaient le forfait image
    par-dessus, soit les images comptées deux fois. On ne soustrait PAS le
    forfait du dénominateur : il est volontairement SURESTIMÉ (1500 contre
    ~800 réels sur un VL local), la soustraction ferait monter le ratio au-
    dessus du vrai, donc sous-estimer — le sens dangereux. Une mesure
    polluée par des images ne met donc simplement PAS à jour le ratio : il
    garde la dernière mesure propre (ou l'amorce), jamais une valeur fausse."""
    try:
        if not prompt_tokens or prompt_tokens <= 0 or prompt_chars <= 0:
            return
        if n_images and int(n_images) > 0:
            return
        r = prompt_chars / prompt_tokens
        if not (_RATIO_MIN <= r <= _RATIO_MAX):
            logger.debug(
                "[tokens] ratio mesuré %.2f chars/token hors bornes [%.1f, %.1f] "
                "(modèle %s) — ignoré", r, _RATIO_MIN, _RATIO_MAX, model_id)
            return
        # AUDIT 2026-08-23 — on alimente AUSSI la clé "" (ratio de repli du
        # process). Les deux appelants passent toujours un modèle, donc cette
        # clé n'était JAMAIS peuplée : tout comptage sans ``model_id`` — la
        # jauge de la route, les replis du compresseur — restait bloqué à vie
        # sur l'amorce froide 3.3, soit 27 % d'écart mesuré avec la boucle.
        for key in {model_id or "", ""}:
            prev = _measured_ratio.get(key)
            _measured_ratio[key] = r if prev is None \
                else prev + _RATIO_ALPHA * (r - prev)
    except Exception:
        pass


def measured_chars_per_token(model_id: Optional[str] = None) -> float:
    """Ratio chars/token MESURÉ pour ce modèle (amorce froide 3.3).

    ⚠ Un modèle NOMMÉ mais jamais mesuré garde l'amorce froide : son
    tokenizer peut n'avoir rien à voir avec celui d'un autre. Seul un
    appelant qui ne nomme AUCUN modèle — la jauge de la route, les replis du
    compresseur — hérite du ratio de repli du process (clé ``""``), qui vaut
    toujours mieux que 3.3 figé (27 % d'écart mesuré avec la boucle).
    """
    if model_id:
        return _measured_ratio.get(model_id, CHARS_PER_TOKEN)
    return _measured_ratio.get("", CHARS_PER_TOKEN)


def tokens_to_chars(n_tokens: int, model_id: Optional[str] = None) -> int:
    """Matérialise un budget de TOKENS en longueur de chaîne (ratio mesuré).
    Réservé aux COUPES — jamais à une décision."""
    return max(0, int(n_tokens * measured_chars_per_token(model_id)))


def tokens_to_chars_stable(n_tokens: int) -> int:
    """Variante STABLE (amorce 3.3 figée) pour les caps ré-évalués à chaque
    tour sur un contenu déjà stocké (filet sanitize, plancher desktop) : un
    ratio qui bouge re-couperait un contenu déjà coupé → byte-instabilité du
    préfixe KV. Les coupes UNIQUES (émission) utilisent le ratio mesuré."""
    return max(0, int(n_tokens * CHARS_PER_TOKEN))


def payload_chars(messages: List[Dict[str, Any]]) -> int:
    """Chars « comptables » d'une liste de messages (content texte + nom et
    arguments des tool_calls) — le numérateur du ratio mesuré.

    Chars PONDÉRÉS (``weighted_len``) : un caractère CJK vaut ~1 token, pas
    1/3.3 (audit 2026-09-24, n° 4). Identique à ``len`` sur l'ASCII."""
    total = 0
    for m in messages or []:
        if not isinstance(m, dict):
            continue
        c = m.get("content")
        if isinstance(c, str):
            total += weighted_len(c)
        elif isinstance(c, list):
            for blk in c:
                if isinstance(blk, dict) and isinstance(blk.get("text"), str):
                    total += weighted_len(blk["text"])
        for tc in (m.get("tool_calls") or []):
            if isinstance(tc, dict):
                fn = tc.get("function") or {}
                _nm = fn.get("name")
                _args = fn.get("arguments")
                total += weighted_len(_nm if isinstance(_nm, str) else "") \
                    + weighted_len(_args if isinstance(_args, str) else "")
    return total


def count_image_blocks(messages: Optional[list]) -> int:
    """Nombre de blocs image (``image_url`` / ``image``) de ``messages`` —
    à passer à ``note_real_usage(n_images=…)``."""
    n = 0
    for m in messages or []:
        if not isinstance(m, dict):
            continue
        c = m.get("content")
        if isinstance(c, list):
            for blk in c:
                if isinstance(blk, dict) and blk.get("type") in ("image_url", "image"):
                    n += 1
    return n


def est_tokens_message_measured(m: Dict[str, Any],
                                model_id: Optional[str] = None) -> int:
    """Estimation d'UN message en tokens via le ratio MESURÉ (surcoût fixe et
    forfait image inclus). Remplace ``est_tokens_message`` (3.3 statique)
    dans les DÉCISIONS sans I/O (fast-path, croissance de tour)."""
    ratio = measured_chars_per_token(model_id)
    total = MSG_OVERHEAD_TOKENS + int(payload_chars([m]) / ratio)
    c = m.get("content")
    if isinstance(c, list):
        img_cost = None
        for blk in c:
            if isinstance(blk, dict) and blk.get("type") in ("image_url", "image"):
                if img_cost is None:
                    img_cost = image_token_cost()
                total += img_cost
    return total


def tool_prompt_tokens(messages: Optional[List[Dict[str, Any]]],
                       model_id: Optional[str] = None, *, defs_tokens: int = 0) -> int:
    """Part d'un prompt occupée par les OUTILS : leurs définitions
    (``defs_tokens``, schéma envoyé à chaque appel), les appels d'outils
    re-soumis (nom et arguments des ``tool_calls`` de l'assistant) et leurs
    résultats (messages ``tool``). Convention des fournisseurs (OpenAI,
    Anthropic) : tout cela est de l'ENTRÉE ; seul l'appel émis par le modèle
    dans SA réponse compte en sortie. Estimation au ratio mesuré, sans I/O."""
    ratio = measured_chars_per_token(model_id)
    n = max(0, int(defs_tokens or 0))
    for m in messages or ():
        if not isinstance(m, dict):
            continue
        if m.get("role") == "tool":
            n += est_tokens_message_measured(m, model_id)
        elif m.get("tool_calls"):
            n += int(payload_chars([{"tool_calls": m["tool_calls"]}]) / ratio)
    return n


def measured_prompt_tokens(messages: List[Dict[str, Any]], *,
                           model_id: Optional[str] = None,
                           extra_fixed: int = 0) -> int:
    """Somme de ``est_tokens_message_measured`` — le delta sans I/O du
    fast-path et du déclencheur d'overflow (unités tokens, ratio réel)."""
    return sum(est_tokens_message_measured(m, model_id)
               for m in messages if isinstance(m, dict)) \
        + max(0, int(extra_fixed or 0))


def image_token_cost() -> int:
    """Coût forfaitaire d'un bloc image (non tokenisable comme du texte).

    Piloté par la config (``CTX_IMAGE_TOKEN_COST``, défaut 1500) — valeur
    PRUDENTE : doit SURESTIMER (800 sous-estimait une capture 1080p sur un
    VL local). Plancher 256 contre une config aberrante.
    """
    try:
        from shared_infra import config as _cfg
        return max(256, int(getattr(_cfg, "CTX_IMAGE_TOKEN_COST", 1500) or 1500))
    except Exception:
        return 1500


# Figé à l'import comme historiquement (la config est elle-même chargée à
# l'import du process).
IMAGE_TOKEN_COST = image_token_cost()


def est_tokens_text(s: Optional[str]) -> int:
    """Estimation pour un texte brut (sans surcoût message). Chars pondérés :
    un caractère CJK compte ~1 token (cf. ``weighted_len``)."""
    return int(weighted_len(s) / CHARS_PER_TOKEN)


def image_forfait_tokens(messages: Optional[list]) -> int:
    """Somme du forfait image sur tous les blocs image de ``messages``.

    Complément des comptages EXACTS : ``/apply-template`` + ``/tokenize`` ne
    voient que le texte — les blocs image (non tokenisables) ajoutent leur
    forfait PAR-DESSUS le compte exact (porte de compression,
    ``_count_tokens_async_ex``). Les chemins heuristiques
    (``est_tokens_message``) l'incluent déjà — ne pas cumuler.
    """
    n = count_image_blocks(messages)
    return n * image_token_cost() if n else 0


def est_tokens_message(m: Dict[str, Any]) -> int:
    """Estimation pour UN message OpenAI-format complet.

    Couvre : content str, content multimodal (blocs text + forfait par bloc
    image), tool_calls (nom + arguments — souvent le plus gros poste sur une
    conversation agentic), + surcoût fixe par message.
    """
    total = MSG_OVERHEAD_TOKENS
    img_cost: Optional[int] = None
    c = m.get("content")
    if isinstance(c, str):
        total += est_tokens_text(c)
    elif isinstance(c, list):
        for blk in c:
            if not isinstance(blk, dict):
                continue
            t = blk.get("text")
            if isinstance(t, str):
                total += est_tokens_text(t)
            elif blk.get("type") in ("image_url", "image"):
                if img_cost is None:
                    img_cost = image_token_cost()
                total += img_cost
    for tc in (m.get("tool_calls") or []):
        if isinstance(tc, dict):
            fn = tc.get("function") or {}
            nm = fn.get("name")
            if isinstance(nm, str):
                total += est_tokens_text(nm)
            args = fn.get("arguments")
            if isinstance(args, str):
                total += est_tokens_text(args)
    return total


# ── Mémo de comptage par message (cf. C7 dans count_messages_tokens_per_msg_ex)
#
# Clé = identité de l'objet message. Un dict de message est muté sur place très
# rarement (et jamais son contenu tokenisable) ; on valide quand même sur la
# LONGUEUR du texte sérialisé, ce qui coûte le prix d'une sérialisation
# UNIQUEMENT en cas de succès douteux — jamais le hachage. L'entrée est
# abandonnée dès que le message est collecté (clés faibles impossibles sur un
# dict : on borne par un LRU).
_MSG_TOKEN_MEMO: "OrderedDict[int, Tuple[tuple, int]]" = OrderedDict()
_MSG_TOKEN_MEMO_MAX = 4096


def _memo_signature(m: Dict[str, Any], model_id: Optional[str]) -> tuple:
    """Signature bon marché d'un message, SANS le sérialiser.

    Elle protège de deux confusions :
      • le message a changé depuis le comptage (taille du contenu, nombre de
        blocs, nombre de tool_calls, rôle) ;
      • l'adresse a été RECYCLÉE par un autre dict après collecte du premier —
        d'où ``id(content)`` en plus de ``id(m)`` : il faudrait que les deux
        objets soient réalloués aux mêmes adresses, avec le même rôle et la
        même taille, pour se tromper.
    Le ``model_id`` en fait partie : changer de modèle change de tokenizer,
    donc invalide tout compte exact.
    """
    c = m.get("content")
    fp: tuple
    # (passe 8, B11) — empreinte O(1) du TEXTE (tête + queue) en plus de la
    # taille : deux textes de même longueur aux adresses recyclées (freelists
    # LIFO de CPython) partageaient sinon la signature, et le compte d'un
    # message MORT pouvait servir pour un vivant.
    if isinstance(c, str):
        size, blocks, fp = len(c), 1, (c[:24], c[-24:])
    elif isinstance(c, list):
        size = sum(len(b.get("text") or "") for b in c if isinstance(b, dict))
        blocks = len(c)
        _t0 = next((b.get("text") for b in c
                    if isinstance(b, dict) and isinstance(b.get("text"), str)), "") or ""
        fp = (_t0[:24], _t0[-24:])
    else:
        size, blocks, fp = 0, 0, ()
    tcs = m.get("tool_calls")
    if not isinstance(tcs, list):
        tcs = []
    n_tc = len(tcs)
    # AUDIT 2026-08-23 — empreinte des TOOL_CALLS. Deux trous fermés ici :
    #   (a) ``size`` ne couvrait que ``content``, or un assistant qui n'émet
    #       que des tool_calls a ``content=None`` — donc ``size=0``,
    #       ``blocks=0`` et ``id(None)``, une CONSTANTE du process. Tous ces
    #       messages partageaient la signature ``(assistant,0,0,n_tc,id(None),
    #       model)`` : seul le nombre d'appels les distinguait.
    #   (b) la masse d'une conversation agentique vit précisément dans les
    #       ``arguments`` — invisibles de la signature.
    # Le mémo étant indexé sur ``id(m)`` et jamais purgé, une adresse
    # recyclée par CPython (freelists LIFO ; ``sanitize_message_history``
    # reconstruit un dict NEUF par message à chaque tour) rendait alors le
    # compte d'un message MORT. Mesuré : 441 tokens au lieu de 43.
    # On ajoute une empreinte O(1) par appel — longueur + 24 caractères de
    # tête et de queue des arguments —, jamais une sérialisation.
    tc_sig: tuple = ()
    if n_tc:
        parts = []
        for tc in tcs:
            fn = (tc or {}).get("function") or {} if isinstance(tc, dict) else {}
            a = fn.get("arguments")
            a = a if isinstance(a, str) else ""
            parts.append((str((tc or {}).get("id") or "") if isinstance(tc, dict) else "",
                          str(fn.get("name") or ""), len(a), a[:24], a[-24:]))
        tc_sig = tuple(parts)
    return (m.get("role"), blocks, size, n_tc, id(c), model_id or "", tc_sig, fp)


def _memo_lookup(m: Dict[str, Any], model_id: Optional[str]) -> Optional[int]:
    ent = _MSG_TOKEN_MEMO.get(id(m))
    if ent is None:
        return None
    sig, tokens = ent
    if sig != _memo_signature(m, model_id):
        _MSG_TOKEN_MEMO.pop(id(m), None)
        return None
    _MSG_TOKEN_MEMO.move_to_end(id(m))
    return tokens


def _memo_store(m: Dict[str, Any], model_id: Optional[str], tokens: int) -> None:
    _MSG_TOKEN_MEMO[id(m)] = (_memo_signature(m, model_id), tokens)
    _MSG_TOKEN_MEMO.move_to_end(id(m))
    while len(_MSG_TOKEN_MEMO) > _MSG_TOKEN_MEMO_MAX:
        _MSG_TOKEN_MEMO.popitem(last=False)
    _sk = _short_key(m, model_id)
    if _sk is not None:
        _SHORT_TOKEN_MEMO[_sk] = tokens
        _SHORT_TOKEN_MEMO.move_to_end(_sk)
        while len(_SHORT_TOKEN_MEMO) > _SHORT_TOKEN_MEMO_MAX:
            _SHORT_TOKEN_MEMO.popitem(last=False)


# AUDIT 2026-09-26 — mémo par CONTENU des messages courts sans tool_calls.
# ``apply_prune_marks`` (sortie d'outil remplacée par la marque d'élagage)
# construit une COPIE neuve à chaque ``fit_context`` : son ``id`` ne revient
# jamais, donc chaque message élagué repartait au comptage à chaque itération
# et chassait du mémo principal les entrées vivantes des autres chats.
_SHORT_TOKEN_MEMO: "OrderedDict[tuple, int]" = OrderedDict()
_SHORT_TOKEN_MEMO_MAX = 512
_SHORT_TOKEN_CHARS = 512


def _short_key(m: Dict[str, Any], model_id: Optional[str]) -> Optional[tuple]:
    c = m.get("content")
    if not isinstance(c, str) or len(c) > _SHORT_TOKEN_CHARS or m.get("tool_calls"):
        return None
    return (model_id or "", m.get("role"), c)


def _short_lookup(m: Dict[str, Any], model_id: Optional[str]) -> Optional[int]:
    _sk = _short_key(m, model_id)
    if _sk is None:
        return None
    v = _SHORT_TOKEN_MEMO.get(_sk)
    if v is not None:
        _SHORT_TOKEN_MEMO.move_to_end(_sk)
    return v


def message_text_for_tokenize(m: Dict[str, Any]) -> str:
    """Sérialise UN message en texte brut pour POST /tokenize.

    Concatène : rôle + content texte + nom et arguments des tool_calls.
    Les blocs image ne sont pas tokenisables comme texte — leur coût est
    ajouté à part par le caller (cf. ``IMAGE_TOKEN_COST``)."""
    parts: List[str] = []
    role = m.get("role")
    if role:
        parts.append(str(role))
    c = m.get("content")
    if isinstance(c, str):
        parts.append(c)
    elif isinstance(c, list):
        for blk in c:
            if isinstance(blk, dict):
                t = blk.get("text")
                if isinstance(t, str):
                    parts.append(t)
    for tc in (m.get("tool_calls") or []):
        if isinstance(tc, dict):
            fn = tc.get("function") or {}
            nm = fn.get("name")
            if isinstance(nm, str):
                parts.append(nm)
            args = fn.get("arguments")
            if isinstance(args, str):
                parts.append(args)
    return "\n".join(p for p in parts if p)


async def count_messages_tokens_per_msg(
    messages: List[Dict[str, Any]],
    model_id: Optional[str] = None,
) -> List[int]:
    """Tokens PAR MESSAGE via le tokenizer EXACT de llama-server (POST
    /tokenize, cf. _llama_http.count_tokens_exact). Cache LRU global donc
    les vieux messages déjà vus aux itérations précédentes sont gratuits.

    Si /tokenize échoue ponctuellement pour un message (serveur saturé,
    timeout…), retombe sur l'estimation chars/token pour CE message-là
    plutôt qu'invalider tout le comptage. Décision par message, pas
    tout-ou-rien : la majorité des messages garde le compte exact.
    """
    counts, _ = await count_messages_tokens_per_msg_ex(messages, model_id)
    return counts


async def count_messages_tokens_per_msg_ex(
    messages: List[Dict[str, Any]],
    model_id: Optional[str] = None,
) -> Tuple[List[int], int]:
    """Variante instrumentée de ``count_messages_tokens_per_msg`` :
    retourne ``(tokens_par_message, nb_messages_en_fallback)``. Le second
    membre permet de propager un flag « estimé » jusqu'à la jauge (un seul
    message froid en fallback suffit à rendre le total approximatif).
    Un message au texte VIDE n'est pas compté comme fallback (l'estimation
    d'un message vide est exacte par construction).

    Tokenisation CONCURRENTE : tous les ``count_tokens_exact`` partent en
    parallèle (``gather``) — le cache LRU est consulté avant le réseau, le
    parallélisme reste borné par le pool du client admin (max_connections=8).
    """
    # AUDIT 2026-08-22 (C7) — mémo PAR MESSAGE, en amont du cache de
    # tokenisation. Ce chemin « lent » est celui d'une mission longue : le
    # raccourci de ``fit_context`` se désactive dès 85 % d'occupation et après
    # chaque élagage ou compaction, donc les ~150 dernières itérations passent
    # toutes par ici. Or même avec 100 % de succès du cache LRU, on
    # re-sérialisait puis re-hachait (SHA-256) l'HISTORIQUE ENTIER à chaque
    # itération, sur l'event loop et avant le moindre ``await`` : quelques
    # centaines de millisecondes par tour, croissantes, pendant lesquelles TOUS
    # les flux du worker (les autres utilisateurs compris) sont gelés. On garde
    # donc le compte à côté du message, réutilisé tant que son identité et sa
    # taille n'ont pas bougé.
    texts: List[Optional[str]] = []
    memo_hits: List[Optional[int]] = []
    for m in messages:
        cached = _memo_lookup(m, model_id)
        if cached is None:
            cached = _short_lookup(m, model_id)
        if cached is not None:
            memo_hits.append(cached)
            texts.append(None)
        else:
            memo_hits.append(None)
            texts.append(message_text_for_tokenize(m))

    # Concurrence bornée à la taille du pool du client admin : au-delà, les
    # requêtes attendaient une connexion dans le pool. Surtout, une tâche qui
    # démarre APRÈS un échec de transport voit le disjoncteur de
    # ``count_tokens_exact`` ouvert et rend la main tout de suite, au lieu
    # d'attendre son propre timeout (OPTIM 2026-09-26).
    _sem = asyncio.Semaphore(8)

    async def _exact(text: Optional[str]) -> Optional[int]:
        if not text:
            return None
        try:
            async with _sem:
                return await count_tokens_exact(text, model_id, timeout=5.0)
        except Exception:
            return None

    # OPTIM 2026-09-26 — une tâche asyncio par message À COMPTER seulement :
    # le gather sur TOUS les messages créait une tâche (et deux rappels de
    # boucle) par message déjà mémorisé — 144 000 tâches pour 150 itérations
    # d'un historique de 800 messages, ~40 % du temps propre de la boucle.
    _todo = [i for i, t in enumerate(texts) if t]
    counts: List[Optional[int]] = [None] * len(texts)
    if _todo:
        for i, n in zip(_todo, await asyncio.gather(*(_exact(texts[i]) for i in _todo))):
            counts[i] = n
    out: List[int] = []
    n_fallback = 0
    for m, txt, n, memo in zip(messages, texts, counts, memo_hits):
        if memo is not None:
            out.append(memo)
            continue
        if n is None:
            # Repli par message : ratio MESURÉ (harnais v4), pas le 3.3 figé.
            # Ratio DU MODÈLE compté (audit 2026-09-24, n° 5) : sans
            # ``model_id``, c'était la clé ``""`` — la moyenne de tous les
            # modèles du process, tokenizers sans rapport compris.
            out.append(est_tokens_message_measured(m, model_id))
            if txt:
                n_fallback += 1
            continue
        n += MSG_OVERHEAD_TOKENS
        c = m.get("content")
        if isinstance(c, list):
            for blk in c:
                if isinstance(blk, dict) and blk.get("type") in ("image_url", "image"):
                    n += IMAGE_TOKEN_COST
        # Seuls les comptes EXACTS sont mémorisés : un repli par estimation
        # doit rester retentable au tour suivant (le serveur peut être
        # redevenu joignable).
        _memo_store(m, model_id, n)
        out.append(n)
    return out, n_fallback


async def count_tools_tokens_ex(
    tools_payload: Optional[List[Dict[str, Any]]],
    model_id: Optional[str] = None,
) -> Tuple[int, bool]:
    """Tokens du schéma JSON des tools : ``(total, estimated)``.

    PRÉ-CALCULÉ une fois par run par la boucle tool-calling : le set d'outils
    est stable d'une itération à l'autre, mais le ``json.dumps`` (~30 Ko) +
    hash de cache étaient refaits À CHAQUE itération pour un résultat
    identique."""
    if not tools_payload:
        return 0, False
    try:
        _tj = json.dumps(tools_payload, ensure_ascii=False)
        _tt = await count_tokens_exact(_tj, model_id, timeout=5.0)
        if _tt is not None:
            return int(_tt), False
        return max(1, est_tokens_text(_tj)), True
    except Exception:
        # Parité historique : tools non comptés sur exception — le total
        # appelant est alors incomplet, donc marqué estimé.
        return 0, True


def approx_prompt_tokens(
    messages: List[Dict[str, Any]], *, extra_fixed: int = 0,
) -> int:
    """Approximation en TOKENS, sans I/O, sur le ratio unifié 3.3.

    Couverture : content + tool_calls + forfait image + surcoût par
    message, ratio aligné sur le reste de l'app. ``extra_fixed`` = surcoût
    fixe connu du prompt réel (ex. schéma des tools pré-compté). Sert de
    REPLI à la pré-porte de compression quand aucune mesure réelle (usage
    serveur) n'est encore disponible.
    """
    return sum(est_tokens_message(m) for m in messages if isinstance(m, dict)) \
        + max(0, int(extra_fixed or 0))
