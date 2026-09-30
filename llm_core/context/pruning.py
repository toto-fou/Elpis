# SPDX-License-Identifier: MIT
"""llm_core.context.pruning — pipeline de RÉDUCTION du contexte (harnais v4).

Par ITÉRATION, ``fit_context`` orchestre trois étages :

1. ``apply_prune_marks`` — les sorties d'outils marquées sont remplacées par
   le marqueur plein dans la VUE envoyée (stockage intact).
2. ``prune_old_vision_frames`` — seules les N dernières frames image restent
   en base64, les anciennes deviennent un placeholder texte.
3. ``enforce_context_budget``  — LE dernier rempart : garantit que le prompt
   tient dans n_ctx − réserve (comptage exact via l'autorité tokens),
   en retirant au besoin les messages les plus anciens. Sauté (fast-path
   zéro I/O) quand la projection depuis la mesure RÉELLE du serveur tient
   largement dans le budget.

La SÉLECTION des sorties à élaguer (``select_prune_keys``, unités TOKENS)
tourne pendant le run — cadence ``PRUNE_EVERY_ITERS`` — ET en fin de tour ;
les marques sont persistées dans meta_json et re-rendues à l'expansion du tour
suivant (monotone inter-tours, préfixe KV stable). Avant l'audit 2026-08-01
elle n'existait qu'en fin de tour : un run de plusieurs centaines d'itérations
n'élaguait donc jamais rien et n'avait plus que le budget dur — qui JETTE des
messages entiers au lieu d'effacer des sorties récupérables. L'étage 0 (cap
d'ÉMISSION ``prepare_tool_result_for_model``) borne chaque sortie à l'append.

Invariants durs (préservés du code d'origine, gardés par les tests) :
- ``working_messages`` n'est JAMAIS muté — les étages renvoient des copies ;
  la liste envoyée au LLM est une VUE transitoire, la tool_history persistée
  reste complète.
- une paire tool_call ↔ tool_result n'est jamais désappariée (le message
  ``tool`` n'est jamais supprimé seul ; après drop, re-sanitisation) ;
- la perception desktop la plus récente n'est jamais tronquée ;
- les messages ``system`` et les ``keep_recent_msgs`` derniers messages ne
  sont jamais retirés par le budget dur.

Vit ici aussi ``sanitize_message_history`` — l'hygiène structurelle OpenAI
(tool_calls réparés, orphelins retirés) dont dépendent l'assemblage ET le
budget dur.

Extrait de ``_chat_with_tools`` (Phase 2 du refactor) — comportement
verbatim, ratios sourcés de ``context.budget.BUDGET``.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

from llm_core.context.budget import BUDGET

# AUDIT 2026-08-23 — ``approx_prompt_tokens`` retiré de cet import : il
# n'était utilisé NULLE PART dans ce module (0 occurrence du nom dans le
# corps), et sa docstring décrit un rôle de repli tenu depuis le harnais
# v4 par ``measured_prompt_tokens`` — l'y laisser invitait à réintroduire
# le ratio figé 3.3 dans une décision de budget.
from llm_core.context.tokens import count_messages_tokens_per_msg
from shared_infra import config as _bk_config

logger = logging.getLogger("uvicorn.error")


# ──────────────────────────────────────────────────────────────────────────
# Étage 1 — compaction des tool_results
# ──────────────────────────────────────────────────────────────────────────

def truncate_head_tail(content: str, limit: int,
                       reason: str = "tool history compaction") -> str:
    """Tronque ``content`` à ≤ ``limit`` chars en gardant TÊTE + QUEUE.

    Le head-only coupait toujours la FIN du résultat — or pour une sortie
    shell, un run de script ou un appel d'outil, la fin (code de sortie,
    dernières lignes, message d'erreur final) est souvent la partie
    décisive pour la suite du raisonnement. On répartit donc le budget :
    ~70% tête (le contexte : ce qui a été lu/produit) + ~30% queue (la
    conclusion : statut, erreur finale). Coupe sur une frontière de ligne
    quand une est proche, pour ne pas trancher en plein milieu d'un mot.

    La place du marqueur est RÉSERVÉE dans le budget (borne sup : omitted ≤
    len(content)) : la sortie ne dépasse jamais ``limit`` dès que celui-ci
    laisse la place du marqueur — vrai pour tous les appelants (plancher
    200 chars). Cette garantie porte l'idempotence du
    filet ``sanitize_message_history`` : une fois coupé, len ≤ cap → plus
    jamais retouché (byte-stable inter-tours, préfixe KV préservé).

    ``reason`` personnalise le marqueur (défaut byte-identique à
    l'historique) — le cap d'ÉMISSION shell réutilise cette coupe avec sa
    propre raison, distincte de la compaction d'historique.
    """
    marker_reserve = len(f"\n…[{len(content)} chars omitted — {reason}]…\n")
    eff = max(2, limit - marker_reserve)
    head_budget = max(1, int(eff * BUDGET.head_split))
    tail_budget = max(1, eff - head_budget)

    head = content[:head_budget]
    tail = content[-tail_budget:]
    # Coupe propre sur un saut de ligne si on en trouve un raisonnablement
    # près de la frontière (sinon on garde la coupe brute).
    _nl = head.rfind("\n")
    if _nl > head_budget * 0.5:
        head = head[:_nl]
    _nl = tail.find("\n")
    if 0 <= _nl < tail_budget * 0.5:
        tail = tail[_nl + 1:]

    omitted = len(content) - len(head) - len(tail)
    return (
        f"{head}\n"
        f"…[{omitted} chars omitted — {reason}]…\n"
        f"{tail}"
    )


# ── Harnais v4 (M4) : élagage FIN DE TOUR, en TOKENS, marques persistées ──
# Remplace les vagues par itération pilotées en chars (`compact_tool_results`,
# supprimé) : une passe en fin de tour SÉLECTIONNE les vieilles sorties
# d'outils à effacer de la VUE modèle ; leurs clés (recette ``_prune_key``)
# sont persistées dans ``chats.meta_json["ctx_pruned_keys"]`` et le rendu
# (``_expand_history_for_llm``) remplace le contenu ENTIER par le marqueur —
# monotone inter-tours (le marqueur ne change jamais → préfixe KV stable),
# stockage intact (session_search retrouve le plein).

PRUNE_CLEARED_MARKER = (
    "[Old tool output cleared — use session_search to retrieve it]"
)
# Outils dont les sorties ne sont JAMAIS élaguées (contrat skills : les
# instructions chargées doivent rester visibles tout le run).
_PRUNE_PROTECTED_TOOL_PREFIXES = ("skill",)


def _prune_key(m: Dict[str, Any]) -> Optional[str]:
    """Identité STABLE d'un tool_result pour les marques d'élagage.

    ``tool_call_id`` seul ne suffit pas : les modèles qui n'émettent pas
    d'id retombent sur ``call_0``/``call_1`` — réutilisés à CHAQUE
    itération. On y adjoint la longueur + les bords du contenu ORIGINAL
    (déterministe inter-process, aucun hash de tout le contenu)."""
    c = m.get("content")
    if not isinstance(c, str) or not c:
        return None
    return f"{m.get('tool_call_id') or ''}|{len(c)}|{c[:48]}|{c[-48:]}"


def merge_user_suffix(content: Any, suffix: str) -> Any:
    """Contenu d'une question AUGMENTÉ d'un suffixe réservé au modèle (rappel
    ``<todo_status>``). Règle UNIQUE, partagée par la boucle (injection en
    début de tour) et par l'expansion de l'historique (rejeu aux tours
    suivants) : les deux doivent produire les MÊMES octets, sinon le préfixe
    KV diverge à cette question (AUDIT 2026-09-25)."""
    if isinstance(content, list):
        return list(content) + [{"type": "text", "text": suffix}]
    txt = content if isinstance(content, str) else ("" if content is None else str(content))
    return f"{txt}\n\n{suffix}" if txt.strip() else suffix


def user_suffix_sig(index: int, content: Any) -> str:
    """Signature d'une question : son RANG parmi les questions de la
    conversation + une empreinte de son contenu. Le rang distingue deux
    questions identiques (« ok » posé à deux tours)."""
    import hashlib
    try:
        raw = content if isinstance(content, str) else json.dumps(
            content, ensure_ascii=False, sort_keys=True)
    except (TypeError, ValueError):
        raw = str(content)
    return f"{int(index)}:{hashlib.sha1(raw.encode('utf-8', 'replace')).hexdigest()[:16]}"


def is_ephemeral(m: Any) -> bool:
    """True si ``m`` est un message de CONTRÔLE injecté mi-tour.

    Les nudges du harnais (point d'étape budget, diagnostic de parse, relance
    compacte, anti-boucle) sont des ``role:user`` adressés au modèle mais
    JAMAIS persistés : ils vivent dans ``working_messages`` le temps du run
    et disparaissent au tour suivant.

    Sans ce marqueur ils étaient comptés comme de VRAIS tours par
    ``_count_turns`` (compresseur) et par l'index de tours de
    ``select_prune_keys`` — alors qu'ils sont absents de l'historique
    re-expansé au tour suivant. Conséquence mesurée : ``covered_turns``
    sur-compté à la compaction, puis ``_drop_leading_turns`` qui jette
    autant de vrais tours EN TROP au tour d'après (perte silencieuse).
    """
    return bool(isinstance(m, dict) and m.get("_ephemeral"))


def ephemeral(role: str, content: str) -> Dict[str, Any]:
    """Fabrique un message de contrôle éphémère (cf. ``is_ephemeral``)."""
    return {"role": role, "content": content, "_ephemeral": True}


# Clés INTERNES (préfixe ``_``) : utiles au harnais, invalides dans un payload
# OpenAI/Anthropic. Strippées à l'envoi (cf. strip_internal_keys).
def strip_internal_keys(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Copie de ``messages`` sans les clés de harnais (``_ephemeral``, …).

    Appliqué juste avant l'envoi : les fournisseurs stricts rejettent un
    champ inconnu dans un message. Ne copie QUE les messages concernés
    (les autres sont passés par référence — zéro coût sur le cas courant)."""
    out: List[Dict[str, Any]] = []
    for m in messages or []:
        if isinstance(m, dict) and any(
                isinstance(k, str) and k.startswith("_") for k in m):
            out.append({k: v for k, v in m.items()
                        if not (isinstance(k, str) and k.startswith("_"))})
        else:
            out.append(m)
    return out


def apply_prune_marks(messages: List[Dict[str, Any]],
                      keys) -> List[Dict[str, Any]]:
    """Vue MODÈLE de ``messages`` avec les sorties d'outils marquées effacées.

    Renvoie une COPIE : chaque ``role:tool`` dont la ``_prune_key`` figure
    dans ``keys`` voit son contenu ENTIER remplacé par
    ``PRUNE_CLEARED_MARKER``. Le stockage n'est jamais touché
    (``session_search`` retrouve le plein).

    Recette partagée par les deux sites d'application (harnais v4 M4+) :
      • la boucle, PENDANT le run (élagage intra-run — voir ``fit_context``) ;
      • la route, au rendu de l'historique persisté du tour SUIVANT
        (``_expand_history_for_llm``).

    Une seule recette ⇒ le même tool_result rend le même marqueur des deux
    côtés : le préfixe KV reste byte-stable au passage d'un tour à l'autre.
    """
    ks = keys if isinstance(keys, (set, frozenset)) else set(keys or ())
    if not ks:
        return messages
    out: List[Dict[str, Any]] = []
    for m in messages:
        if (isinstance(m, dict) and m.get("role") == "tool"
                and isinstance(m.get("content"), str)
                and m.get("content") != PRUNE_CLEARED_MARKER
                and _prune_key(m) in ks):
            out.append({**m, "content": PRUNE_CLEARED_MARKER})
        else:
            out.append(m)
    return out


async def select_prune_keys(
    working_messages: List[Dict[str, Any]],
    *,
    ctx_size: Optional[int],
    model_id: Optional[str] = None,
    already_marked=None,
) -> List[str]:
    """Sélection FIN DE TOUR des sorties d'outils à marquer (unités TOKENS,
    comptes exacts /tokenize LRU — zéro décision en chars).

    Transposition d'OpenCode (``compaction.prune``), décisions user
    2026-07-28 : actif par défaut, fenêtre protégée = 20 % du n_ctx TOTAL.

    Parcours arrière des ``role:tool`` :
      - les sorties des 2 DERNIERS TOURS ne sont jamais candidates ;
      - arrêt à la frontière du dernier résumé de compaction ;
      - arrêt à la première sortie DÉJÀ marquée (monotonie : tout ce qui est
        plus ancien l'est aussi) — reconnue soit par son contenu (marqueur
        déjà rendu, cas du tour suivant), soit par ``already_marked`` (clés
        marquées PENDANT ce run, où le contenu de ``working_messages`` est
        encore plein puisqu'on ne le mute jamais) ;
      - protégés : la perception desktop la plus récente (``"elements"``),
        les outils ``skill*``, et les sorties récentes cumulant jusqu'à
        ``prune.protect_tokens`` (0 → 20 % · n_ctx) ;
      - la passe n'est actée que si le gain total ≥ ``prune.min_tokens``
        (0 → min(20 000, 10 % · n_ctx)).

    Retourne les CLÉS (``_prune_key``) à ajouter aux marques persistées —
    jamais les messages mutés (la vue est dérivée au rendu)."""
    if not ctx_size or ctx_size <= 0 or not working_messages:
        return []
    _marked = (already_marked if isinstance(already_marked, (set, frozenset))
               else set(already_marked or ()))
    try:
        if not bool(getattr(_bk_config, "PRUNE_ENABLED", True)):
            return []
        protect = int(getattr(_bk_config, "PRUNE_PROTECT_TOKENS", 0) or 0)
        min_gain = int(getattr(_bk_config, "PRUNE_MIN_TOKENS", 0) or 0)
    except Exception:
        protect, min_gain = 0, 0
    if protect <= 0:
        protect = int(ctx_size * 0.20)
    if min_gain <= 0:
        min_gain = min(20_000, int(ctx_size * 0.10))

    # Index de tour par message (sémantique _count_turns) + nom d'outil par
    # tool_call_id + frontière du dernier résumé de compaction.
    turn_idx: List[int] = []
    turns = 0
    prev_was_tool = False
    tool_name_by_id: Dict[str, str] = {}
    last_summary_i = -1
    for i, m in enumerate(working_messages):
        role = m.get("role") if isinstance(m, dict) else None
        if role == "user":
            # Nudges du harnais : présents dans la vue modèle, absents de
            # l'historique persisté → les compter fausse la fenêtre « 2
            # derniers tours » (elle rétrécit à chaque point d'étape budget).
            if not is_ephemeral(m):
                turns += 1
            prev_was_tool = False
        elif role == "assistant":
            if m.get("tool_calls"):
                turns += 1
                for tc in m.get("tool_calls") or []:
                    if isinstance(tc, dict):
                        fn = tc.get("function") or {}
                        if tc.get("id") and fn.get("name"):
                            tool_name_by_id[tc["id"]] = fn["name"]
            elif not prev_was_tool:
                turns += 1
            prev_was_tool = False
        elif role == "tool":
            prev_was_tool = True
        elif role == "system":
            c = m.get("content")
            if isinstance(c, str) and "[COMPRESSED_SUMMARY_V1]" in c:
                last_summary_i = i
        turn_idx.append(turns)
    total_turns = turns

    # Candidats : tool str, après la frontière résumé, hors 2 derniers tours,
    # hors déjà-marqués / desktop le plus récent / outils protégés.
    tool_indices = [i for i, m in enumerate(working_messages)
                    if isinstance(m, dict) and m.get("role") == "tool"
                    and isinstance(m.get("content"), str)]
    protected_desktop = -1
    for i in reversed(tool_indices):
        c = working_messages[i]["content"]
        if '"elements"' in c and c != PRUNE_CLEARED_MARKER:
            protected_desktop = i
            break

    candidates: List[int] = []       # du plus RÉCENT au plus ancien
    for i in reversed(tool_indices):
        m = working_messages[i]
        c = m["content"]
        if c == PRUNE_CLEARED_MARKER or (_marked and _prune_key(m) in _marked):
            break                    # monotonie : plus ancien = déjà marqué
        if i <= last_summary_i:
            break                    # couvert par un résumé de compaction
        if turn_idx[i] > total_turns - 2:
            continue                 # 2 derniers tours : jamais candidats
        if i == protected_desktop:
            continue
        name = tool_name_by_id.get(m.get("tool_call_id") or "", "")
        if name.startswith(_PRUNE_PROTECTED_TOOL_PREFIXES):
            continue
        candidates.append(i)
    if not candidates:
        return []

    # Comptes EXACTS par sortie (une passe /tokenize LRU groupée).
    cand_msgs = [working_messages[i] for i in candidates]
    per_tok = await count_messages_tokens_per_msg(cand_msgs, model_id)

    # Fenêtre protégée en tokens (du récent vers l'ancien), puis gain.
    to_mark: List[int] = []
    reclaim = 0
    acc = 0
    for i, tok in zip(candidates, per_tok):
        acc += tok
        if acc <= protect:
            continue
        to_mark.append(i)
        reclaim += tok
    if not to_mark or reclaim < min_gain:
        return []
    # AUDIT 2026-08-23 — une signature AMBIGUË n'est jamais marquée.
    # La clé vaut (id | longueur | bords du contenu). Deux sorties IDENTIQUES
    # d'un outil idempotent — ``ls``, ``git status``, ``pwd``, ``read_file``
    # d'un fichier inchangé — la partagent donc, et l'id de repli est
    # déterministe : ``call_0`` à chaque itération quand le modèle n'en fournit
    # pas. Marquer l'ancienne occurrence effaçait AUSSI la récente, y compris
    # celle que le modèle venait de produire : il relisait
    # « [Old tool output cleared] » à la place de son propre résultat, et
    # relançait l'outil — la boucle exacte que l'élagage doit éviter.
    # On écarte donc toute clé qui correspond encore à une sortie CONSERVÉE.
    # ⚠ Reste connu : une sortie identique répétée n'est plus élaguable du
    # tout. Rendre la clé unique par occurrence est la vraie réponse, mais la
    # recette doit rester identique entre la boucle et la route (sinon le
    # préfixe KV se dé-stabilise) alors qu'elles parcourent des listes
    # différentes — chantier à part entière.
    _marquees = set(to_mark)
    _a_garder = set()
    for i in tool_indices:
        if i in _marquees:
            continue
        _m = working_messages[i]
        if _m["content"] == PRUNE_CLEARED_MARKER:
            continue                     # déjà effacée : ne protège rien
        _k = _prune_key(_m)
        if _k is not None and not (_marked and _k in _marked):
            _a_garder.add(_k)

    keys = []
    for i in to_mark:
        k = _prune_key(working_messages[i])
        if k is not None and k not in _a_garder:
            keys.append(k)
    return keys


# ──────────────────────────────────────────────────────────────────────────
# Étage 2 — computer-use : élagage frames image + éléments perçus
# ──────────────────────────────────────────────────────────────────────────
# Les boucles d'automatisation desktop sont les plus gourmandes en contexte :
# chaque ``desktop_observe`` ré-injecte (a) une image base64 (~50-150 Ko) ET
# (b) une liste d'éléments verbeuse (box/confidence/source/depth par item). Sur
# 50-500 pas, ces deux sources gonflent le payload à chaque tour. On les élague
# au moment de construire la liste ENVOYÉE au modèle, sans toucher
# ``working_messages`` (le Studio/persistance gardent la frame complète).

# Champs d'un élément perçu réellement utiles au MODÈLE pour agir/raisonner.
# Le reste (box, confidence, source, depth) est du bruit : la box a déjà servi
# au Studio (event ``annotation_frame`` émis AVANT l'append), le modèle agit via
# ``id``/``center``/``auto_id``.
_DESKTOP_EL_KEEP = ("id", "label", "role", "center", "auto_id", "value", "do")
# Métadonnées de frame réservées au Studio/vision — inutiles dans le TEXTE du
# tool_result (l'image part séparément par le canal vision).
_DESKTOP_FRAME_DROP = ("frame_token", "img_w", "img_h", "sig", "vision_used", "tree_used")
# Budget chars d'un tool_result desktop à l'injection : la liste d'éléments doit
# passer ENTIÈRE (la couper re-masquerait des éléments que le modèle doit voir).
# Bornée par le cap de nœuds de l'agent + la coupe des `value`. Piloté par config.
DESKTOP_TOOL_RESULT_MAX_CHARS = max(
    8000, int(getattr(_bk_config, "DESKTOP_TOOL_RESULT_MAX_CHARS", 60000) or 60000)
)


def compact_desktop_elements(content_str: str) -> str:
    """Réduit le tool_result d'une perception desktop (clé ``elements``
    volumineuse) à l'essentiel pour le LLM : par élément
    ``{id,label,role,center,auto_id,value,states}``. Le Studio a déjà reçu la
    frame complète (boxes) via l'event. Renvoie la chaîne JSON compactée, ou
    l'originale si ce n'est pas un résultat desktop parsable avec ``elements``.
    Best-effort, ne lève jamais."""
    if not isinstance(content_str, str) or '"elements"' not in content_str:
        return content_str
    try:
        data = json.loads(content_str)
    except Exception:
        return content_str
    if not isinstance(data, dict) or not isinstance(data.get("elements"), list):
        return content_str
    slim_els = []
    for e in data["elements"]:
        if not isinstance(e, dict):
            continue
        se = {k: e[k] for k in _DESKTOP_EL_KEEP if e.get(k) not in (None, "", [], {})}
        _v = se.get("value")
        if isinstance(_v, str) and len(_v) > 300:
            se["value"] = _v[:300] + "…"          # borne un `value` géant (éditeur) → liste prévisible
        st = e.get("states")
        if isinstance(st, list) and st:
            se["states"] = [str(s) for s in st][:6]   # seulement les états actifs, capés
        slim_els.append(se)
    out = {k: v for k, v in data.items() if k not in _DESKTOP_FRAME_DROP}
    out["elements"] = slim_els
    try:
        return json.dumps(out, ensure_ascii=False)
    except Exception:  # pragma: no cover
        return content_str


_VISION_FRAME_PLACEHOLDER = (
    "[previous screenshot elided to save context — "
    "call desktop_observe to see the current screen]"
)


def prune_old_vision_frames(messages: List[Dict], keep: int = 2) -> List[Dict]:
    """Renvoie une COPIE de ``messages`` où, parmi les messages porteurs d'une
    image (``content`` = liste avec un bloc ``image_url``), seuls les ``keep``
    plus récents conservent leur image ; les plus anciens voient leur(s) bloc(s)
    ``image_url`` remplacé(s) par un court texte. Sans ça les captures base64
    desktop/inspect s'accumulent à CHAQUE tour et font exploser le payload. La
    liste originale n'est jamais modifiée (frame gardée pour Studio/persistance).
    """
    img_idx = [
        i for i, m in enumerate(messages)
        if isinstance(m.get("content"), list)
        and any(isinstance(b, dict) and b.get("type") == "image_url" for b in m["content"])
    ]
    if len(img_idx) <= max(0, keep):
        return messages
    to_strip = set(img_idx if keep <= 0 else img_idx[:-keep])
    out = []
    for i, m in enumerate(messages):
        if i in to_strip:
            kept, stripped = [], False
            for b in m["content"]:
                if isinstance(b, dict) and b.get("type") == "image_url":
                    stripped = True
                    continue
                kept.append(b)
            if stripped:
                kept.append({"type": "text", "text": _VISION_FRAME_PLACEHOLDER})
            m = {**m, "content": kept}
        out.append(m)
    return out


# ──────────────────────────────────────────────────────────────────────────
# Étage 0 — vue MODÈLE d'un résultat d'outil à l'ÉMISSION (append role:tool)
# ──────────────────────────────────────────────────────────────────────────

def emit_cap_tokens(ctx_tokens: Optional[int]) -> int:
    """Cap d'émission d'UN résultat d'outil, en TOKENS, dérivé du n_ctx par
    slot : clamp(plancher, ratio × n_ctx, plafond). n_ctx inconnu → plancher.
    Sur une grande fenêtre le modèle voit large — l'élagage aval récupère le
    contexte au bon moment ; sur une petite fenêtre le plancher tient."""
    if ctx_tokens and ctx_tokens > 0:
        return min(BUDGET.emit_cap_max_tokens,
                   max(BUDGET.emit_cap_min_tokens,
                       int(ctx_tokens * BUDGET.emit_cap_ratio)))
    return BUDGET.emit_cap_min_tokens


def emit_cap_chars(ctx_tokens: Optional[int],
                   model_id: Optional[str] = None) -> int:
    """Matérialisation en CHARS du cap d'émission (ratio MESURÉ du modèle —
    coupe UNIQUE à l'émission, jamais ré-appliquée sur du contenu stocké).
    Borné sous le filet sanitize pour qu'une coupe d'émission ne puisse
    jamais être re-coupée par le filet (byte-stabilité)."""
    from llm_core.context.tokens import tokens_to_chars, tokens_to_chars_stable
    cap = tokens_to_chars(emit_cap_tokens(ctx_tokens), model_id)
    filet = tokens_to_chars_stable(BUDGET.sanitize_tool_max_tokens)
    return max(200, min(cap, filet - 5_000))


def _strip_model_diff(content: str) -> str:
    """Retire le diff unifié complet du RÉSULTAT VU PAR LE MODÈLE (edit_file /
    write_file) — modèle OpenCode : « Edit applied successfully », le diff vit
    côté UI (l'event ``tool_result`` complet part AVANT cet étage). Le modèle
    garde les stats (+a/-d) et les sha de chaînage. Best-effort : contenu non
    JSON ou sans ``diff`` → inchangé."""
    try:
        d = json.loads(content)
    except Exception:
        return content
    if not isinstance(d, dict) or "diff" not in d:
        return content
    diff = d.pop("diff")
    added, removed = d.get("lines_added"), d.get("lines_removed")
    if added is not None or removed is not None:
        d["diff_stat"] = f"+{added or 0}/-{removed or 0} lines"
    else:
        d["diff_stat"] = f"{len(str(diff).splitlines())} diff lines"
    d["diff_note"] = "full diff shown to the user; re-read the file if you need the exact content"
    try:
        return json.dumps(d, ensure_ascii=False)
    except Exception:  # pragma: no cover
        return content


def _compact_files_changed(content: str) -> str:
    """``files_changed`` (shell, git, scripts, manage_files) vu par le MODÈLE :
    une ligne courte par fichier (« chemin (modifié, +3/-1) »), sans les
    empreintes de versions — elles ne servent qu'au diff de l'interface,
    qui les lit dans l'event ``tool_result`` complet (2026-09-26)."""
    if '"files_changed"' not in content:
        return content
    try:
        d = json.loads(content)
    except Exception:
        return content
    fc = d.get("files_changed") if isinstance(d, dict) else None
    if not isinstance(fc, list):
        return content
    out = []
    for e in fc:
        if not isinstance(e, dict) or not e.get("path"):
            continue
        bits = [str(e.get("change") or "modified")]
        if e.get("from"):
            bits.append(f"from {e['from']}")
        if isinstance(e.get("lines_added"), int):
            bits.append(f"+{e['lines_added']}/-{e.get('lines_removed') or 0}")
        out.append(f"{e['path']} ({', '.join(bits)})")
    d["files_changed"] = out
    try:
        return json.dumps(d, ensure_ascii=False)
    except Exception:  # pragma: no cover
        return content


def prepare_tool_result_for_model(
    tool_name: str,
    content: Any,
    ctx_tokens: Optional[int] = None,
    model_id: Optional[str] = None,
) -> Any:
    """Vue MODÈLE d'un résultat d'outil au moment de l'append ``role:tool``.

    Étage UNIQUE partagé par les deux canaux (natif/legacy) :
      1. desktop_* : compaction des éléments (le Studio a déjà la frame
         complète via l'event) + budget large dédié ;
      2. edit_file/write_file : diff unifié retiré (stats conservées) ;
      3. cap d'émission dérivé du n_ctx (``emit_cap_chars``).
    L'event UI ``tool_result`` (complet) est émis AVANT cet étage — rien de
    tout ceci n'ampute ce que l'utilisateur voit."""
    if not isinstance(content, str):
        return content
    content = _compact_files_changed(content)
    cap = emit_cap_chars(ctx_tokens, model_id)
    # (2026-09-11, P2) mode d'élagage déclaré par le serveur (``meta.policy.prune``
    # : desktop | diff | head_tail) ; les tests par nom restent le REPLI.
    try:
        from llm_core._mcp_categories import tool_policy as _tool_policy
        _prune = str(_tool_policy(tool_name).get("prune") or "")
    except Exception:                                           # noqa: BLE001
        _prune = ""
    if _prune == "desktop" or (not _prune and (tool_name or "").startswith("desktop_")):
        content = compact_desktop_elements(content)
        # La liste d'éléments desktop doit arriver ENTIÈRE au modèle (la
        # tronquer masquait des éléments à détecter) → plancher large, exprimé
        # en TOKENS (desktop.tool_result_max_tokens ; compat : l'ancienne clé
        # chars est encore honorée si la nouvelle est absente). Lu à l'APPEL.
        _dk_tokens = int(getattr(_bk_config, "DESKTOP_TOOL_RESULT_MAX_TOKENS", 0) or 0)
        if _dk_tokens > 0:
            from llm_core.context.tokens import tokens_to_chars_stable
            _dk_floor = tokens_to_chars_stable(_dk_tokens)
        else:
            _dk_floor = getattr(_bk_config, "DESKTOP_TOOL_RESULT_MAX_CHARS",
                                DESKTOP_TOOL_RESULT_MAX_CHARS)
        cap = max(cap, _dk_floor)
    elif _prune == "diff" or (not _prune and tool_name in ("edit_file", "write_file")):
        content = _strip_model_diff(content)
    if len(content) > cap:
        if _prune == "head_tail" or tool_name == "task" or (not _prune and tool_name == "execute_shell"):
            # Le bridge shell garde la QUEUE (verdict de build, dernière
            # erreur) et met les métadonnées en TÊTE du JSON — une coupe
            # tête-seule jetait précisément la fin préservée. Idem pour le
            # rapport final d'un sous-agent ``task`` : ses CONCLUSIONS
            # arrivent à la fin (contrat des personas AGENT_TASK_*) — la
            # coupe tête-seule jetait exactement ce que le parent a délégué.
            # Tête+queue : métadonnées/enveloppe ET conclusion survivent.
            content = truncate_head_tail(
                content, cap, reason="result truncated at emission, tail preserved")
        else:
            omitted = len(content) - cap
            content = content[:cap] + f"\n…[result truncated, {omitted} chars omitted]"
    return content


# ──────────────────────────────────────────────────────────────────────────
# Hygiène structurelle (partagée assemblage / budget / boucle)
# ──────────────────────────────────────────────────────────────────────────

def sanitize_message_history(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Rend une liste de messages OpenAI STRUCTURELLEMENT SÛRE pour le
    chat template de llama.cpp.

    Un historique mal formé — typiquement hérité d'un tour précédent dont
    un tool call a foiré — fait planter llama.cpp en 500 AU RENDU du
    chat template. Et comme l'app renvoie le même historique à chaque
    relance, le chat se retrouve bloqué en boucle 500 (l'utilisateur doit
    changer de chat). Cette passe neutralise les causes connues :

      * ``assistant.tool_calls[].function.arguments`` qui n'est pas du
        JSON valide → réparé (dict ré-encodé, sinon ``"{}"``).
      * tool_call sans ``id`` / ``type`` / ``name`` → complété ou retiré.
      * message ``role:"tool"`` orphelin (aucun tool_call correspondant
        dans un assistant qui précède) → supprimé : les templates qui
        apparient tool_call ↔ result plantent dessus. EXCEPTION : un
        résultat sans ``tool_call_id`` (ou à id inconnu) est apparié, dans
        l'ordre, à un tool_call qui n'avait PAS d'id (id ``hist_…`` forgé
        ici) — avant, l'id forgé rendait ce résultat orphelin à coup sûr.
      * tool_call resté SANS résultat à la fin → retiré de son assistant
        (cf. ``_drop_unanswered_calls``) : OpenAI et Anthropic répondent 400
        sur un appel sans réponse.
      * ``content`` de message tool gigantesque → tronqué.
      * premier message non-system qui n'est pas un ``user`` → ancre posée
        (cf. ``_ensure_user_anchor``).

    Idempotente : ré-appliquée sur un historique déjà sain, ne change rien.
    """
    if not messages:
        return messages
    out: List[Dict[str, Any]] = []
    open_ids: set = set()          # ids de tool_calls en attente de result
    seen_ids: set = set()          # tous les ids d'appel émis (doublons)
    # Ids FORGÉS (tool_call arrivé sans ``id``) encore ouverts, dans l'ordre
    # d'émission : un résultat sans id ou à id inconnu leur est apparié.
    anon_open: List[str] = []
    # Filet en TOKENS (harnais v4), matérialisé via le ratio STABLE : le
    # filet est ré-évalué à chaque tour sur du contenu stocké — un ratio
    # mouvant re-couperait un contenu déjà coupé (byte-instabilité KV).
    from llm_core.context.tokens import tokens_to_chars_stable
    _MAX_TOOL_CONTENT = tokens_to_chars_stable(BUDGET.sanitize_tool_max_tokens)
    for m in messages:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        if role == "assistant" and m.get("tool_calls"):
            tcs: List[Dict[str, Any]] = []
            for tc in m.get("tool_calls") or []:
                if not isinstance(tc, dict):
                    continue
                fn = dict(tc.get("function") or {})
                if not fn.get("name"):
                    continue  # tool_call sans nom = inexploitable
                args = fn.get("arguments")
                if isinstance(args, dict):
                    fn["arguments"] = json.dumps(args, ensure_ascii=False)
                elif isinstance(args, str):
                    try:
                        json.loads(args)
                    except Exception:
                        # arguments non parsables → on neutralise plutôt
                        # que de laisser llama.cpp planter au json::parse.
                        fn["arguments"] = "{}"
                else:
                    fn["arguments"] = "{}"
                tc_id = tc.get("id")
                if not tc_id:
                    tc_id = f"hist_{len(out)}_{len(tcs)}"
                    anon_open.append(tc_id)
                tcs.append({
                    "id": tc_id,
                    "type": tc.get("type") or "function",
                    "function": {"name": fn["name"], "arguments": fn["arguments"]},
                })
                open_ids.add(tc_id)
                seen_ids.add(tc_id)
            # Clés du harnais (``_anthropic_thinking`` : blocs signés à
            # rejouer, ``_prune_key``, ``_pinned``…) et ``reasoning_content``
            # CONSERVÉES : la reconstruction les perdait dès que le budget dur
            # retirait un message — et Anthropic répondait 400 faute de blocs
            # thinking, précisément contexte plein (passe robustesse 2026-09-24).
            nm: Dict[str, Any] = {k: v for k, v in m.items()
                                  if isinstance(k, str) and k.startswith("_")}
            if m.get("reasoning_content"):
                nm["reasoning_content"] = m["reasoning_content"]
            nm.update({"role": "assistant", "content": m.get("content")})
            if tcs:
                nm["tool_calls"] = tcs
            elif not nm.get("content"):
                nm["content"] = ""   # assistant vide + sans tool_calls = invalide
            out.append(nm)
        elif role == "tool":
            tcid = m.get("tool_call_id")
            if tcid and tcid in seen_ids and tcid not in open_ids:
                # Second résultat pour un appel DÉJÀ répondu : doublon. Avant,
                # il tombait dans l'appariement anonyme et devenait le
                # résultat d'un AUTRE appel.
                continue
            if not tcid or tcid not in open_ids:
                # Audit 2026-09-24, n° 7 — l'appel n'avait pas d'id : le
                # résultat ne pouvait pas le citer. On l'apparie au plus
                # ancien appel anonyme encore ouvert (ordre d'émission = ordre
                # des résultats, discipline de la boucle).
                while anon_open and anon_open[0] not in open_ids:
                    anon_open.pop(0)
                if not anon_open:
                    continue  # orphelin → cause classique de 500 au rendu
                tcid = anon_open.pop(0)
            content = m.get("content")
            if isinstance(content, str) and len(content) > _MAX_TOOL_CONTENT:
                # Filet de sécurité (contenu pathologique hors cap d'émission) :
                # tête+queue, pas tête-seule — un filet ne jette pas la
                # conclusion. Idempotent : une fois coupé, len ≤ cap (garanti
                # par la réserve du marqueur dans truncate_head_tail).
                content = truncate_head_tail(content, _MAX_TOOL_CONTENT,
                                             reason="oversized tool result")
            nt: Dict[str, Any] = {k: v for k, v in m.items()
                                  if isinstance(k, str) and k.startswith("_")}
            if m.get("name"):
                nt["name"] = m["name"]
            nt.update({"role": "tool", "tool_call_id": tcid, "content": content})
            out.append(nt)
            open_ids.discard(tcid)
        else:
            out.append(m)
    if open_ids:
        out = _drop_unanswered_calls(out, open_ids)
    return _ensure_user_anchor(out)


def _drop_unanswered_calls(out: List[Dict[str, Any]],
                           unanswered: set) -> List[Dict[str, Any]]:
    """Retire des assistants les tool_calls restés SANS résultat.

    Audit 2026-09-24, n° 7 — un appel sans réponse (tour coupé entre l'appel
    et l'exécution, résultat perdu par le budget dur) partait tel quel :
    llama.cpp le tolère, OpenAI et Anthropic répondent 400 (« tool_call_ids
    did not have response messages » / « tool_use without tool_result »).

    Deux réparations possibles ; on RETIRE l'appel plutôt que d'injecter un
    résultat synthétique :
      * rien n'est inventé — un faux « résultat indisponible » pourrait être
        lu comme un échec réel de l'outil (et relayé tel quel à
        l'utilisateur), alors que l'outil n'a peut-être jamais tourné ;
      * aucune hypothèse de POSITION : un résultat synthétique doit être
        inséré juste après les résultats de son lot, or un historique mal
        formé n'a justement pas de position sûre ;
      * même discipline que la reprise d'un sous-agent
        (``task_tool``, « un appel resté sans réponse est retiré de la
        vague ») ;
      * idempotent : une fois retiré, il n'y a plus rien à fermer.
    L'assistant garde son texte ; vidé de tout, il redevient ``content=""``
    (même règle que plus haut pour un assistant sans appel exploitable).
    """
    res: List[Dict[str, Any]] = []
    for m in out:
        if (isinstance(m, dict) and m.get("role") == "assistant"
                and m.get("tool_calls")):
            kept = [tc for tc in m["tool_calls"] if tc.get("id") not in unanswered]
            if len(kept) != len(m["tool_calls"]):
                nm = {k: v for k, v in m.items() if k != "tool_calls"}
                if kept:
                    nm["tool_calls"] = kept
                elif not nm.get("content"):
                    nm["content"] = ""
                m = nm
        res.append(m)
    return res


# Posé quand l'historique a perdu son dernier ``user`` : il faut un tour
# utilisateur pour que les gabarits à alternance stricte rendent, et le
# modèle doit savoir POURQUOI il n'a sous les yeux qu'un résumé.
_ORPHAN_ANCHOR_TEXT = (
    "[SYSTEM] Mission in progress — the original request was summarized into "
    "the context above. Continue from there."
)
# Posé quand l'historique a encore un ``user`` mais COMMENCE (après les
# ``system``) par un assistant ou un outil : la tête de conversation a été
# résumée ou retirée pour tenir dans la fenêtre.
_LEADING_ANCHOR_TEXT = (
    "[SYSTEM] Earlier turns of this conversation were summarized or trimmed "
    "to fit the context window. Continue from there."
)


def _ensure_user_anchor(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Filet : un historique de conversation porte TOUJOURS un ``user``.

    Un historique ``system, assistant, tool, assistant, tool, …`` sans le
    moindre ``role:user`` n'est pas une conversation : les gabarits à
    alternance stricte (famille Gemma et dérivés) lèvent ``raise_exception``
    au rendu, et llama-server répond 500 — le chat est alors bloqué tant que
    l'historique n'a pas changé.

    Cette forme n'arrive PAS d'un client : elle est produite par nos propres
    étages de réduction quand la demande sort de la fenêtre conservée (une
    boucle agentique n'a qu'un seul ``user`` pour cinquante cycles d'outils).
    Le vrai correctif est en amont — la compaction ré-épingle l'ancre
    (``conversation_compressor._pin_task_anchor``) et le budget dur la protège
    (``task_anchor_index``). Ceci est le filet de dernier recours, commun à
    TOUS les chemins de réduction : il coûte un ``any()`` sur le cas courant.

    Ne touche à rien tant qu'il n'y a pas d'échange (system seul, ou liste
    vide) : il n'y a alors rien à ancrer.

    Audit 2026-09-24, n° 16 — il ne suffit pas qu'un ``user`` existe : il
    doit OUVRIR la conversation. La compaction partielle (coupe entre deux
    tours au sens de ``_count_turns``, où un assistant ouvre aussi un tour)
    et le budget dur (retrait en ordre ascendant) peuvent laisser
    ``system, assistant, …, user, …`` ; les gabarits à alternance stricte
    (Gemma, Mistral) lèvent alors au rendu et Anthropic refuse un premier
    message ``assistant``. Même réparation : un ``user`` éphémère en tête.
    Éphémère, il n'est jamais persisté et n'est pas compté comme un tour —
    ``covered_turns`` et ``_drop_leading_turns`` restent cohérents.
    """
    insert_at = 0
    for m in messages:
        if isinstance(m, dict) and m.get("role") == "system":
            insert_at += 1
        else:
            break
    if any(isinstance(m, dict) and m.get("role") == "user" for m in messages):
        first = messages[insert_at] if insert_at < len(messages) else None
        if not (isinstance(first, dict)
                and first.get("role") in ("assistant", "tool")):
            return messages
        logger.info(
            "[sanitize] la conversation commence par un %s après les system — "
            "ancre user posée en position %d (gabarits à alternance stricte)",
            first.get("role"), insert_at,
        )
        out = list(messages)
        out.insert(insert_at, {"role": "user", "content": _LEADING_ANCHOR_TEXT,
                               "_ephemeral": True})
        return out
    if not any(isinstance(m, dict) and m.get("role") in ("assistant", "tool")
               for m in messages):
        return messages
    logger.warning(
        "[sanitize] historique sans aucun message user (%d messages) — ancre "
        "de tâche posée en position %d ; sans elle le rendu du gabarit "
        "échoue en 500.", len(messages), insert_at,
    )
    out = list(messages)
    out.insert(insert_at, {"role": "user", "content": _ORPHAN_ANCHOR_TEXT,
                           "_ephemeral": True, "_task_anchor": True})
    return out


# ──────────────────────────────────────────────────────────────────────────
# Étage 3 — budget dur (dernier rempart)
# ──────────────────────────────────────────────────────────────────────────

# Part MAXIMALE du budget que l'ancre de tâche a le droit d'occuper pour
# rester protégée. Au-delà (grosse pièce jointe collée dans la demande
# initiale), la protéger rendrait le fit insoluble : on la relâche.
_ANCHOR_MAX_RATIO = 0.15

# Plancher absolu de la queue protégée — en dessous, le budget dur n'aurait
# plus de quoi préserver le cycle d'outil en cours.
_KEEP_RECENT_MIN = 6


def effective_keep_recent(n_msgs: int) -> int:
    """Taille EFFECTIVE de la queue protégée pour une liste de ``n_msgs``.

    ``BUDGET.keep_recent_msgs`` (16) est un PLAFOND pensé pour le régime
    agentique — un cycle d'outil vaut deux messages, 16 sanctuarise donc 8
    cycles. Mais appliqué en absolu à une conversation courte, il protège la
    liste ENTIÈRE : plus rien n'est retirable et le budget dur ne peut plus
    faire son travail (constaté en portant le plancher de 10 à 16 — une
    conversation de 15 messages ne tenait plus dans une petite fenêtre).

    On borne donc la queue à un TIERS de la conversation, avec un plancher
    dur : les longues boucles agentiques obtiennent les 16, les échanges
    courts gardent de la matière élaguable.
    """
    return max(_KEEP_RECENT_MIN, min(BUDGET.keep_recent_msgs, n_msgs // 3))


def task_anchor_index(messages: List[Dict[str, Any]]) -> int:
    """Indice du message qui porte L'ÉNONCÉ DE LA TÂCHE EN COURS, ou -1.

    = le DERNIER ``role:user`` non éphémère. C'est la demande qui a déclenché
    le run : ce que l'agent est en train d'essayer de faire.

    Pourquoi le dernier et pas le premier — le premier message d'une
    conversation n'est PAS la mission courante (dans un chat de 20 tours,
    c'est un échange vieux et souvent hors sujet). Protéger la tête ferait
    même l'inverse du but recherché : le budget, contraint de trouver ses
    tokens ailleurs, mangerait la VRAIE demande pour préserver une phrase
    obsolète. (Vérifié par ``test_enforce_budget_protege_le_tour_courant_entier``,
    qui l'a attrapé sur-le-champ.)

    Pourquoi c'est nécessaire (audit 2026-08-01, P0-2) : le budget dur retire
    les messages les plus anciens en ordre ascendant, et la demande recule
    dans la liste à mesure que la boucle empile ses cycles d'outils. Au bout
    de quelques dizaines d'itérations elle sort de la queue protégée par
    ``keep_recent_msgs`` et devient droppable — l'agent garde alors son
    dernier ``grep`` et a OUBLIÉ ce qu'on lui a demandé. Les messages
    éphémères (nudges du harnais) sont ignorés : ce sont des ``role:user``
    qui ne portent aucune demande.
    """
    for i in range(len(messages) - 1, -1, -1):
        m = messages[i]
        if not isinstance(m, dict):
            continue
        if m.get("role") != "user":
            continue
        # ``_task_anchor`` : ancre RÉ-ÉPINGLÉE par la compaction (le tour qui
        # portait la demande vient d'être résumé). Éphémère par construction —
        # elle n'existe pas dans l'historique persisté — mais elle porte
        # l'énoncé, donc elle est l'ancre et doit être protégée comme telle.
        if m.get("_task_anchor") or not is_ephemeral(m):
            return i
    return -1


def protected_indices(messages: List[Dict[str, Any]],
                      per_msg: Optional[List[int]] = None,
                      budget: Optional[int] = None) -> set:
    """Indices que le budget dur ne doit JAMAIS retirer.

    - tous les ``system`` (déjà garanti par l'appelant, repris ici pour que
      la fonction soit utilisable seule) ;
    - les messages ÉPINGLÉS (``_pinned``) — réservé aux blocs que le harnais
      poserait délibérément et qui ne doivent jamais tomber ;
    - l'ANCRE DE TÂCHE (``task_anchor_index``), sauf si elle pèse à elle
      seule plus de ``_ANCHOR_MAX_RATIO`` du budget : une pièce jointe
      géante ne doit pas rendre le fit insoluble (on préfère perdre l'ancre
      que ne rien pouvoir envoyer).
    """
    out = {i for i, m in enumerate(messages)
           if isinstance(m, dict)
           and (m.get("role") == "system" or m.get("_pinned"))}
    anchor = task_anchor_index(messages)
    if anchor >= 0:
        too_heavy = (
            per_msg is not None and budget is not None and budget > 0
            and 0 <= anchor < len(per_msg)
            and per_msg[anchor] > budget * _ANCHOR_MAX_RATIO
        )
        if not too_heavy:
            out.add(anchor)
    return out


def _atomic_groups(messages: List[Dict[str, Any]]) -> List[List[int]]:
    """Groupes d'indices que le budget dur retire d'un bloc, en ordre
    ascendant de leur premier indice.

    Un ``assistant`` à ``tool_calls`` forme un groupe avec ses résultats : les
    ``tool`` qui citent l'un de ses ids (où qu'ils soient ensuite) et les
    ``tool`` SANS id qui le suivent immédiatement (appariés dans l'ordre par
    ``sanitize_message_history``). Tout autre message est un groupe à lui
    seul — y compris un ``tool`` orphelin, que sanitize retirera de toute
    façon.
    """
    n = len(messages)
    owner: Dict[int, int] = {}
    groups: Dict[int, List[int]] = {}
    for i, m in enumerate(messages):
        if i in owner or not isinstance(m, dict):
            continue
        grp = [i]
        if m.get("role") == "assistant" and m.get("tool_calls"):
            ids = {tc.get("id") for tc in m.get("tool_calls") or []
                   if isinstance(tc, dict) and tc.get("id")}
            contiguous = True
            found: set = set()
            for j in range(i + 1, n):
                if not contiguous and found >= ids:
                    break  # tous les résultats vus : inutile de balayer la suite
                mj = messages[j]
                if not (isinstance(mj, dict) and mj.get("role") == "tool"):
                    contiguous = False
                    continue
                if j in owner:
                    continue
                tcid = mj.get("tool_call_id")
                if (tcid and tcid in ids) or (contiguous and not tcid):
                    grp.append(j)
                    owner[j] = i
                    if tcid:
                        found.add(tcid)
        groups[i] = grp
    return [groups[i] for i in sorted(groups)]


# Filigrane bas du budget dur (AUDIT 2026-09-25) : quand il faut retirer,
# on retire jusqu'à cette fraction du budget — pas au ras — pour que les
# itérations suivantes tiennent sans nouveau retrait (préfixe KV stable).
_DROP_LOW_WATERMARK = 0.75


async def enforce_context_budget(
    messages: List[Dict[str, Any]],
    ctx_size: Optional[int],
    model_id: Optional[str] = None,
    gen_cap_tokens: Optional[int] = None,
    fixed_overhead_tokens: int = 0,
    stats_out: Optional[Dict[str, Any]] = None,
    drop_floor: int = 0,
) -> List[Dict[str, Any]]:
    """GARANTIT que le prompt tient dans la fenêtre de contexte.

    Exécuté juste avant l'appel LLM, APRÈS la compaction des tool_results
    et la compression LLM. Si l'estimation dépasse encore
    ``ctx_size - réserve``, retire les messages les plus ANCIENS (hors
    ``system``) jusqu'à ce que ça rentre. Sont toujours préservés :
      * tous les messages ``system`` ;
      * l'ANCRE DE TÂCHE et les messages épinglés (cf. ``protected_indices``) —
        un agent ne doit jamais perdre l'énoncé de ce qu'on lui demande ;
      * les ``BUDGET.keep_recent_msgs`` derniers messages ;
      * le TOUR COURANT (tout ce qui suit le dernier ``user``) tant qu'il
        reste des tours précédents à retirer — l'ordre ascendant du drop
        ne l'ampute (par sa tête) qu'en dernier recours.

    Comptage des tokens : llama-server ``POST /tokenize`` via l'autorité
    ``context.tokens`` (cache LRU global). Comptage EXACT selon le
    tokenizer du modèle chargé. Fallback per-message sur l'estimation
    chars/token si /tokenize est indisponible.

    Après suppression on repasse ``sanitize_message_history`` : retirer un
    ``assistant`` peut laisser un ``tool`` orphelin (résultat sans son
    tool_call), ce qui ferait planter le chat template.

    NB : n'altère QUE la liste envoyée au LLM (vue transitoire). La
    ``working_messages`` complète — donc la tool_history persistée — n'est
    pas touchée : l'historique reste complet, seul l'envoi est borné.

    ``fixed_overhead_tokens`` = surcoût FIXE du prompt réel absent de
    ``messages`` (schéma tools, compté une fois par run). Soustrait du
    budget : sans lui, le fit croyait le prompt rentrant alors que
    prompt + tools + génération pouvait dépasser n_ctx (finish=length —
    exactement ce que cette fonction existe pour empêcher).
    """
    # ``stats_out`` remonte à l'appelant les cas où la GARANTIE n'en est plus
    # une : sans ça, un prompt qu'on n'a pas su réduire partait quand même,
    # le serveur le refusait, et l'utilisateur ne voyait qu'une erreur brute
    # après coup — alors que la situation était connue AVANT l'envoi.
    def _note(**kw) -> None:
        if stats_out is not None:
            stats_out.update(kw)

    if not ctx_size or ctx_size <= 0 or not messages:
        if messages:
            _note(ctx_unknown=True)
        return messages
    # C2a — la réserve DOIT couvrir au moins le cap de génération réellement
    # autorisé (LLAMA_MAX_TOKENS_CHAT/THINKING) : reserve >= gen_cap, plafonnée
    # à 75 % du n_ctx (cf. ContextBudget.reserve_tokens — même calcul, source
    # unique).
    reserve = BUDGET.reserve_tokens(ctx_size, gen_cap_tokens)
    budget = ctx_size - reserve - max(0, int(fixed_overhead_tokens or 0))
    if budget <= 0:
        # Le surcoût fixe (schémas d'outils) mange à lui seul tout le budget :
        # aucun élagage de messages ne peut sauver l'envoi.
        _note(over_budget=True, over_reason="overhead",
              budget=budget, ctx_size=ctx_size)
        return messages

    per_msg = await count_messages_tokens_per_msg(messages, model_id)
    total = sum(per_msg)
    if total <= budget:
        _note(drop_floor=0)
        return messages  # tient déjà → rien à faire

    n = len(messages)
    keep_tail_from = max(0, n - effective_keep_recent(n))
    # Politique « tours précédents d'abord, tête du tour courant en dernier
    # recours » : réalisée par l'ordre ASCENDANT du drop — les messages du
    # tour courant (tout ce qui suit le dernier ``user``) portent les indices
    # les plus hauts sous keep_tail_from, ils ne partent donc qu'une fois
    # tous les tours précédents retirés. En boucle agentique le tour courant
    # déborde vite les keep_recent_msgs derniers messages (un cycle d'outil
    # = 2 messages) : ce sont les tests de budget qui vissent cette
    # politique. La queue keep_recent_msgs et les ``system`` restent
    # inviolables.
    _protected = protected_indices(messages, per_msg, budget)
    # Retrait par GROUPES ATOMIQUES (audit 2026-09-24, n° 8) : un
    # ``assistant(tool_calls)`` part avec TOUS ses résultats, ou pas du tout.
    # Avant, la liste des droppables s'arrêtait à ``keep_tail_from`` message
    # par message : l'assistant juste avant la queue protégée pouvait partir
    # alors que ses ``tool`` étaient DANS la queue — ``sanitize_message_history``
    # les supprimait ensuite comme orphelins (lot parallèle de 8 lectures en
    # régime serré : les dernières observations disparaissaient et le modèle
    # relançait les mêmes appels). Un groupe dont un membre est protégé
    # (queue, ancre, épinglé) est gardé en entier ; ``total`` décompte
    # exactement ce qui part.
    #
    # HYSTÉRÉSIS (AUDIT 2026-09-25) — retirer le STRICT minimum faisait
    # glisser la fenêtre d'un cycle d'outil à CHAQUE itération : le premier
    # message après la tête changeait à chaque appel, et le préfixe KV était
    # perdu (re-préremplissage de tout l'historique, par itération), tandis
    # que le modèle oubliait ses observations une à une (mesuré : un
    # sous-agent re-listait les mêmes dossiers en boucle). Désormais :
    #   1. ``drop_floor`` groupes (ceux retirés à l'appel précédent de la
    #      boucle) restent retirés — la vue ne « respire » plus ;
    #   2. s'il faut retirer davantage, on descend jusqu'à un FILIGRANE BAS
    #      (``_DROP_LOW_WATERMARK`` du budget) : la marge dégagée absorbe
    #      plusieurs itérations sans nouveau retrait, donc sans nouvelle
    #      rupture du préfixe.
    _droppable = [grp for grp in _atomic_groups(messages)
                  if not any(j >= keep_tail_from or j in _protected
                             or messages[j].get("role") == "system" for j in grp)]
    dropped: set = set()
    _k = 0
    _anchor = task_anchor_index(messages)
    _target = int(budget * _DROP_LOW_WATERMARK)
    _floor = _droppable[:max(0, int(drop_floor or 0))]
    # AUDIT 2026-09-26 — groupes du plancher pris dans le TOUR COURANT (ancre
    # comprise) : ils reviennent quand la place est revenue (marques
    # d'élagage, images retirées) au lieu de rester perdus jusqu'à la fin du
    # run — mais TOUS ENSEMBLE et seulement sous le filigrane bas. Un retour
    # groupe par groupe dès que le total repasse sous le budget refaisait
    # glisser la vue (et casser le préfixe KV) à chaque itération.
    _floor_prev = [g for g in _floor if not (_anchor >= 0 and min(g) >= _anchor)]
    _floor_cur = [g for g in _floor if _anchor >= 0 and min(g) >= _anchor]
    for grp in _floor_prev:
        dropped.update(grp)
        total -= sum(per_msg[j] for j in grp)
        _k += 1
    if _floor_cur and total > _target:
        for grp in _floor_cur:
            dropped.update(grp)
            total -= sum(per_msg[j] for j in grp)
            _k += 1
    if total > budget:
        # Le TOUR COURANT (à partir de l'ancre, ANCRE COMPRISE quand elle est
        # trop lourde pour être protégée) n'est entamé que si le BUDGET
        # l'exige — jamais pour la seule marge (« tête du tour courant en
        # dernier recours ») ; une fois entamé, il l'est avec la même marge,
        # sinon une mission en un seul tour glisserait à chaque itération.
        _cut_courant = False
        for grp in _droppable[_k:]:
            if total <= _target:
                break
            if _anchor >= 0 and min(grp) >= _anchor:
                if total > budget:
                    _cut_courant = True
                elif not _cut_courant:
                    break
            dropped.update(grp)
            total -= sum(per_msg[j] for j in grp)
            _k += 1
    _note(drop_floor=_k)
    # Tête ALIGNÉE (audit 2026-09-24, n° 16) : le retrait ascendant peut
    # s'arrêter juste après une question, laissant sa RÉPONSE seule en tête
    # (``system, assistant, user, …``) — rejet des gabarits à alternance
    # stricte. Une réponse sans sa question ne porte plus rien d'utile : on
    # la retire aussi tant qu'elle est retirable. Un assistant à
    # ``tool_calls`` n'est PAS concerné (ses observations restent utiles au
    # run en cours) : le filet ``_ensure_user_anchor`` pose alors un ``user``
    # de raccord.
    if dropped:
        for i, m in enumerate(messages):
            if i in dropped or m.get("role") == "system":
                continue
            if (m.get("role") != "assistant" or m.get("tool_calls")
                    or i >= keep_tail_from or i in _protected):
                break
            dropped.add(i)
            total -= per_msg[i]

    if not dropped:
        logger.warning(
            "[run_chat_multi_mcp] contexte au-dessus du budget (~%d > %d) "
            "mais rien de retirable (system + ancre de tâche + tour courant "
            "protégés)",
            sum(per_msg), budget,
        )
        # Cas le plus fréquent : un message unique (grosse pièce jointe, gros
        # résultat d'outil) plus gros à lui seul que le budget. On part quand
        # même — le serveur tranchera — mais l'appelant peut désormais
        # prévenir l'utilisateur AVANT le refus.
        _note(over_budget=True, over_reason="nothing_droppable",
              estimated=total, budget=budget, ctx_size=ctx_size)
        return messages

    if total > budget:
        # Droppables ÉPUISÉS mais toujours au-dessus : la queue protégée
        # (keep_recent_msgs + system) dépasse à elle seule le budget. Sans
        # cette note, l'envoi surdimensionné partait en silence — le serveur
        # coupait chaque génération (finish=length) sans que l'utilisateur
        # soit prévenu. Régime typique d'un chat agentique mûr aux gros
        # résultats d'outils.
        logger.warning(
            "[run_chat_multi_mcp] contexte toujours au-dessus du budget après "
            "élagage complet (~%d > %d) — queue protégée trop lourde",
            total, budget,
        )
        _note(over_budget=True, over_reason="tail_too_heavy",
              estimated=total, budget=budget, ctx_size=ctx_size)

    kept = [m for j, m in enumerate(messages) if j not in dropped]
    # Compteur de retrait PROPRE au budget (AUDIT 2026-09-26) : la
    # différence de longueurs calculée par ``fit_context`` valait 0 quand un
    # retrait d'un message était compensé par le ``user`` de raccord
    # (``_ensure_user_anchor``) — la boucle croyait la vue complète et le
    # fast-path suivant renvoyait l'historique ENTIER, au-dessus du budget.
    _note(dropped=len(dropped))
    logger.info(
        "[run_chat_multi_mcp] fit contexte : %d ancien(s) message(s) retiré(s) "
        "de l'envoi pour tenir dans ~%d tokens (n_ctx=%d, réserve=%d, tools=%d)",
        len(dropped), budget, ctx_size, reserve,
        max(0, int(fixed_overhead_tokens or 0)),
    )
    return sanitize_message_history(kept)


# ──────────────────────────────────────────────────────────────────────────
# Orchestrateur — appelé par la boucle à chaque itération
# ──────────────────────────────────────────────────────────────────────────

# Marge du fast-path du budget dur : on ne SAUTE le comptage exact que si la
# projection (mesure réelle serveur + estimation des seuls messages apparus
# depuis) tient sous cette fraction du budget. La projection est déjà
# conservatrice (le réel inclut tools+system pourtant re-soustraits du budget,
# et la complétion double-compte le message assistant ré-estimé) — la marge
# couvre le reste.
_FASTPATH_MARGIN = 0.85


async def fit_context(
    working_messages: List[Dict[str, Any]],
    *,
    ctx_size: Optional[int],
    model_id: Optional[str],
    thinking_mode: bool,
    tools_fixed_tokens: int,
    vision_keep: int = 2,
    real_ctx_tokens: Optional[int] = None,
    real_ctx_msg_count: Optional[int] = None,
    stats_out: Optional[Dict[str, Any]] = None,
    prune_keys=None,
    drop_floor: int = 0,
) -> List[Dict[str, Any]]:
    """Pipeline de réduction : marques d'élagage → vision → budget dur.

    Renvoie la LISTE À ENVOYER au LLM (vue transitoire) ; ``working_messages``
    n'est jamais muté. La réserve du budget dur = le cap de génération
    EFFECTIF (adaptatif au n_ctx), identique à celui réellement envoyé en
    max_tokens → prompt + sortie ≤ n_ctx garanti sans sur-réserver.

    ``real_ctx_tokens`` / ``real_ctx_msg_count`` : dernière occupation RÉELLE
    mesurée par le serveur (usage prompt+completion) et longueur de
    ``working_messages`` à cet instant. Fast-path : si réel + estimation des
    seuls messages APPARUS depuis tient sous ``_FASTPATH_MARGIN`` du budget,
    le comptage exact par message (/tokenize) est sauté pour cette itération —
    zéro I/O de comptage en régime confortable, rigueur intacte près du bord.

    ``prune_keys`` : marques d'élagage ACTIVES pour cette itération (union
    des marques persistées du chat et de celles sélectionnées pendant le run).
    Appliquées ici, en TÊTE de pipeline, pour que le budget dur mesure la vue
    réellement envoyée. C'est ce qui rend l'élagage effectif PENDANT un run
    long : avant (harnais v4 M4), les marques n'étaient rendues qu'au tour
    SUIVANT par la route, donc un run de 200 itérations n'élaguait jamais rien
    et n'avait plus que le budget dur — qui JETTE au lieu de résumer.

    ``stats_out`` : si fourni, rempli avec ``{"fastpath": bool, "dropped": int}``
    (observabilité — watcher LLAMA_WATCH).
    """
    out = apply_prune_marks(working_messages, prune_keys)
    out = prune_old_vision_frames(out, keep=vision_keep)
    if stats_out is not None:
        stats_out["fastpath"] = False
        stats_out["dropped"] = 0
    gen_cap = BUDGET.generation_cap(thinking_mode, ctx_size)
    if (real_ctx_tokens and real_ctx_tokens > 0
            and real_ctx_msg_count is not None
            and 0 <= real_ctx_msg_count <= len(out)
            and ctx_size and ctx_size > 0):
        budget = BUDGET.prompt_budget(ctx_size, gen_cap, tools_fixed_tokens)
        if budget > 0:
            appended = out[real_ctx_msg_count:]
            # Delta sans I/O en unités RÉELLES : ratio mesuré du modèle
            # (plus l'heuristique 3.3 statique — principe zéro-char v4).
            from llm_core.context.tokens import measured_prompt_tokens
            projected = int(real_ctx_tokens) \
                + measured_prompt_tokens(appended, model_id=model_id)
            if projected <= budget * _FASTPATH_MARGIN:
                if stats_out is not None:
                    stats_out["fastpath"] = True
                    stats_out["drop_floor"] = 0
                return out
    fitted = await enforce_context_budget(
        out,
        ctx_size,
        model_id=model_id,
        gen_cap_tokens=gen_cap,
        fixed_overhead_tokens=tools_fixed_tokens,
        stats_out=stats_out,
        drop_floor=drop_floor,
    )
    if stats_out is not None:
        # Le compteur du budget dur prime : la différence de longueurs
        # s'annule quand l'ancre ``user`` de raccord compense un retrait.
        stats_out["dropped"] = max(int(stats_out.get("dropped") or 0),
                                   len(out) - len(fitted), 0)
    return fitted
