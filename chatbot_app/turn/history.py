# SPDX-License-Identifier: MIT
"""
chatbot_app.turn.history — l'historique du chat entre le client, la
base et le modèle : normalisation du payload, champs portés par les messages
(fichiers modifiés, jalons de compaction, métriques, sous-agents), greffe du
travail d'un tour stoppé, découpe et fusions d'un « Continuer », consignes de
reprise et expansion vers le format OpenAI.

Partagé par la préparation, l'exécution et la compression manuelle. Les
fonctions qui modifient une entrée en place le disent dans leur docstring ;
les autres rendent de nouvelles listes.
"""
from __future__ import annotations

import logging
import math
import re
from typing import Optional

from shared_infra.observability.tracing import swallow
from shared_infra.routes._helpers import _msg_text

logger = logging.getLogger("uvicorn.error")


def _metrics_for_persist(met) -> dict:
    """Pied d'un message (modèle, durée, débits, jetons, contexte) renvoyé par
    le client pour les tours PRÉCÉDENTS : valeurs simples et bornées
    seulement, jamais de copie du raisonnement ni des outils. Sans cet
    aller-retour, le pied disparaîtrait au tour suivant."""
    if not isinstance(met, dict):
        return {}
    out = {}
    for k, v in list(met.items())[:40]:
        if k in ("tool_history", "thinking") or not isinstance(k, str):
            continue
        if v is None or isinstance(v, (bool, int, float)):
            out[k] = v
        elif isinstance(v, str) and len(v) <= 200:
            out[k] = v
        elif k == "kv_cache" and isinstance(v, dict):
            out[k] = {x: v[x] for x in ("used", "total", "pct")
                      if isinstance(v.get(x), (int, float))}
    return out


def _task_runs_for_persist(runs):
    """Records ``task_runs`` persistés SANS le champ ``tools`` : le déroulé
    outil-par-outil n'est pas rendu par la carte agent (elle n'itère jamais
    ``run.tools``, le harnais task-verify vérifie même son absence). Le
    garder gonflerait la DB ET le payload renvoyé à chaque tour (cap 50 ×
    args_preview × runs). ``transcript`` est en revanche CONSERVÉ : c'est le
    déroulé compact borné côté task_tool (120 entrées, texte 1500 c,
    résultat 400 c) qui alimente la modale « œil » de la carte agent
    après rechargement."""
    return [
        {k: v for k, v in r.items() if k != "tools"}
        for r in (runs or []) if isinstance(r, dict)
    ]

# Dernier assistant = UNIQUEMENT un bloc <think> fermé (prefill « Répondre
# maintenant » du front, ou reprise d'un raisonnement tronqué par le plafond).
_THINK_ONLY_RE = re.compile(r"^\s*<think>[\s\S]*</think>\s*$", re.IGNORECASE)

# Placeholder du partiel annulé sans prose : du POINT DE VUE d'une reprise,
# c'est un contenu VIDE (le vrai état continuable est ``resume_thinking``).
_CANCEL_PLACEHOLDER = "_(génération interrompue)_"

_RESUME_ANSWER = (
    "Resume your previous answer exactly where it "
    "stopped. Do not repeat it and do not restart it "
    "from the beginning — simply continue."
)
# Quand le dernier assistant n'est QU'un raisonnement (<think>…</think>), la
# consigne « Reprends ta réponse » inviterait le modèle à POURSUIVRE son
# raisonnement — streamé hors balises, donc classé content et rendu en
# markdown (« le thinking sort du bloc »). On lui demande explicitement la
# réponse finale.
# Texte CANONIQUE dans llm_core._think_resume (partagé avec le repli
# d'auto-reprise des moteurs — une divergence recréerait deux comportements).
from llm_core._think_resume import RESUME_AFTER_THINK_INSTRUCTION as _RESUME_AFTER_THINK


def _resume_instruction(content) -> str:
    """Consigne de reprise selon la nature du dernier assistant (réponse
    entamée vs raisonnement seul)."""
    with swallow("chat.resume_instruction"):
        if _THINK_ONLY_RE.match(str(content or "")):
            return _RESUME_AFTER_THINK
    return _RESUME_ANSWER


def _tool_entry_sigs(h) -> set:
    """Signatures composites des entrées AGENTIQUES d'une entrée de
    ``tool_history`` (assistant.tool_calls / tool result). Entrées texte
    (assistant sans tool_calls, user) → set vide.

    L'id seul ne suffit pas : les ids fallback (``call_{iter}_{idx}``,
    ``legacy_{iter}_{idx}``) sont déterministes PAR RUN et se répètent d'un
    tour à l'autre — id + nom + préfixe d'arguments (ou de résultat) rend une
    collision entre travail frais et préfixe rejoué improbable."""
    sigs: set = set()
    if not isinstance(h, dict):
        return sigs
    if h.get("role") == "assistant" and h.get("tool_calls"):
        for _tc in h["tool_calls"]:
            if isinstance(_tc, dict):
                _fn = _tc.get("function") or {}
                sigs.add(("tc", _tc.get("id"), _fn.get("name"),
                          str(_fn.get("arguments") or "")[:80]))
    elif h.get("role") == "tool":
        sigs.add(("tr", h.get("tool_call_id"), str(h.get("content") or "")[:80]))
    return sigs

_FC_CHANGES = ("created", "modified", "deleted", "moved")
_FC_SHA = re.compile(r"^[0-9a-f]{64}$")
_FC_MAX = 200


def _fc_clean(e) -> Optional[dict]:
    """Entrée ``files_changed`` validée (vient du client au round-trip)."""
    if not isinstance(e, dict):
        return None
    path = e.get("path")
    if not isinstance(path, str) or not path or len(path) > 1024:
        return None
    out = {"path": path, "change": e.get("change") if e.get("change") in _FC_CHANGES else "modified"}
    for k in ("before", "after"):
        v = e.get(k)
        out[k] = v if isinstance(v, str) and _FC_SHA.match(v) else None
    for k in ("added", "removed"):
        if isinstance(e.get(k), int) and not isinstance(e.get(k), bool) and 0 <= e[k] < 10**8:
            out[k] = e[k]
    if isinstance(e.get("from"), str) and len(e["from"]) <= 1024:
        out["from"] = e["from"]
    return out


def _fc_merge(acc: dict, files) -> None:
    """Fusionne les ``files`` d'un ``tool_result`` dans ``acc`` ({chemin:
    entrée}) : l'état « avant » est celui du PREMIER outil du tour qui a
    touché le fichier, l'état « après » celui du dernier. Les
    lignes ± ne valent que pour une seule écriture : au-delà, le front les
    recalcule depuis les deux versions."""
    if not isinstance(files, list):
        return
    for raw in files[:_FC_MAX]:
        e = _fc_clean(raw)
        if e is None:
            continue
        prev = acc.get(e["path"])
        if prev is None:
            if len(acc) < _FC_MAX:
                acc[e["path"]] = e
            continue
        merged = dict(prev)
        merged["after"] = e["after"]
        merged.pop("added", None)
        merged.pop("removed", None)
        if prev["change"] == "created":
            merged["change"] = "deleted" if e["change"] == "deleted" else "created"
        elif e["change"] == "deleted":
            merged["change"] = "deleted"
        elif prev["change"] == "deleted":
            merged["change"] = "modified"
        if prev["change"] == "created" and e["change"] == "deleted":
            acc.pop(e["path"], None)              # créé puis supprimé : rien
            continue
        acc[e["path"]] = merged


def _fc_list(msg: dict) -> list:
    """``files_changed`` validé d'un message (round-trip client)."""
    fc = msg.get("files_changed")
    if not isinstance(fc, list):
        return []
    return [e for e in (_fc_clean(x) for x in fc[:_FC_MAX]) if e]


_COMPACTION_NOMBRES = ("round", "threshold", "ctx_size", "tokens_before", "tokens_after", "tokens_saved",
                       "messages_before", "messages_after", "duration_ms", "turns_compressed")


def _compaction_pour_message(c: dict) -> dict:
    """Jalon de compaction gardé sur un message : champs connus,
    bornés (il revient du client au tour suivant)."""
    out: dict = {}
    for k in _COMPACTION_NOMBRES:
        v = c.get(k)
        # Bornes : le client renvoie ces jalons au tour suivant (Infinity,
        # NaN ou 1e300 passent json.loads).
        if isinstance(v, (int, float)) and not isinstance(v, bool) \
                and math.isfinite(v) and 0 <= v < 10**9:
            out[k] = int(v)
    for k, n in (("reason", 32), ("path", 32), ("model_used", 120)):
        v = c.get(k)
        if isinstance(v, str) and v:
            out[k] = v[:n]
    if isinstance(c.get("had_previous_summary"), bool):
        out["had_previous_summary"] = c["had_previous_summary"]
    return out


def _rounds_d_outils(tool_history) -> int:
    """Rounds d'outils (messages assistant porteurs de ``tool_calls``) d'une
    ``tool_history`` — l'unité du ``round`` d'un jalon de compaction."""
    return sum(1 for h in (tool_history or []) if isinstance(h, dict)
               and h.get("role") == "assistant" and h.get("tool_calls"))


def _merge_prev_segment_lists(prev_msg: dict, msg: dict) -> None:
    """« Continuer » : les ``task_runs`` et les exécutions (``run_ids``) du
    segment tronqué passent EN TÊTE de ceux de la continuation (sans
    doublon). Mute ``msg``."""
    # Jalons de compaction de la continuation : leur ``round`` compte depuis
    # la reprise ; la tool_history rechargée = tronc + delta → décalage du
    # nombre de rounds du tronc (format delta seulement, le legacy est
    # cumulatif et ne se recompte pas).
    if prev_msg.get("tool_history_delta") and isinstance(msg.get("compactions"), list):
        _dec = _rounds_d_outils(prev_msg.get("tool_history"))
        if _dec:
            msg["compactions"] = [({**c, "round": int(c.get("round") or 0) + _dec}
                                   if isinstance(c, dict) else c) for c in msg["compactions"]]
    # Sorties élaguées : le segment tronqué et la suite s'additionnent.
    _p_anc, _p_neuf = prev_msg.get("pruned"), msg.get("pruned")
    if isinstance(_p_anc, int) and not isinstance(_p_anc, bool) and _p_anc > 0:
        msg["pruned"] = _p_anc + (_p_neuf if isinstance(_p_neuf, int) and not isinstance(_p_neuf, bool) else 0)
    for _k in ("task_runs", "run_ids", "compactions"):
        _anc = prev_msg.get(_k) if isinstance(prev_msg.get(_k), list) else []
        if not _anc:
            continue
        _neuf = msg.get(_k) if isinstance(msg.get(_k), list) else []
        msg[_k] = list(_anc) + [x for x in _neuf if x not in _anc]
    # Fichiers modifiés : l'« avant » du segment tronqué reste la référence.
    _anc_fc = _fc_list(prev_msg)
    if _anc_fc:
        _acc = {e["path"]: e for e in _anc_fc}
        _fc_merge(_acc, _fc_list(msg))
        msg["files_changed"] = list(_acc.values())




def _merge_continue_tool_history(prev_msg: dict, cont_hist, cont_is_delta: bool) -> dict:
    """Fusion de la ``tool_history`` d'un « Continuer » : tronc (message
    tronqué persisté) + delta de la continuation, CONCATÉNÉS.

    → ``{"tool_history": [...], "tool_history_delta": bool}`` ou ``{}`` si
    rien à porter. Le résultat n'est marqué delta que si AUCUN segment legacy
    (cumulatif) n'y entre : un tronc legacy garde le format legacy → la dédup
    de ``_expand_history_for_llm`` coupera son préfixe rejoué."""
    prev_hist = prev_msg.get("tool_history") if isinstance(prev_msg.get("tool_history"), list) else []
    prev_delta = bool(prev_msg.get("tool_history_delta"))
    cont = cont_hist if isinstance(cont_hist, list) else []
    merged = list(prev_hist) + list(cont)
    if not merged:
        return {}
    merged_delta = ((prev_delta or not prev_hist)
                    and (bool(cont_is_delta) or not cont))
    return {"tool_history": merged, "tool_history_delta": merged_delta}


# Rôles acceptés dans le payload client.
#
# ``notice`` = marqueur d'INTERFACE persistant (« conversation compactée »,
# posé par la compaction). Il ne part JAMAIS au modèle — _expand_history_for_llm
# l'exclut — mais il doit traverser le round-trip client, sinon il disparaît du
# fil dès le tour suivant (la persistance repart de la liste filtrée).
_CLIENT_ROLES = ("user", "assistant", "system", "tool", "notice")

# Champs structurés d'une notice, préservés au persist : ce sont eux qui font
# vivre l'accordéon de vérification et le « contexte ≈ N tokens » après un
# rechargement (le porteur system, lui, est jeté par le front).
_NOTICE_FIELDS = ("kind", "ts", "round", "tokens_after", "summary")


_GRAFT_KEYS = ("tool_history", "tool_history_delta", "task_runs",
               "resume_thinking", "thinkingTruncated", "run_ids", "compactions")


def _graft_stopped_turn_state(filtres: list, persistables: list, db_msgs) -> int:
    """Recolle aux assistants TRONQUÉS du payload l'état d'outils que seule la
    base connaît (cf. appel). Même position, même question juste avant, même
    texte (ou texte vide / placeholder côté client) : sinon rien. Les dicts
    du client sont remplacés par des copies. Rend le nombre de messages
    complétés."""
    if not isinstance(db_msgs, list) or len(filtres) != len(persistables):
        return 0
    n = 0
    for i, m in enumerate(filtres):
        if i >= len(db_msgs):
            break
        if i == 0:
            continue
        d = db_msgs[i]
        if not (isinstance(d, dict) and m.get("role") == "assistant"
                and d.get("role") == "assistant" and d.get("isTruncated")):
            continue
        if m.get("tool_history") or not (d.get("tool_history") or d.get("task_runs")):
            continue
        _prev_c, _prev_d = filtres[i - 1], db_msgs[i - 1]
        if not (isinstance(_prev_d, dict) and _prev_c.get("role") == _prev_d.get("role")
                and _prev_c.get("content") == _prev_d.get("content")):
            continue
        _mc = m.get("content")
        if not (_mc == d.get("content") or _mc in ("", None, _CANCEL_PLACEHOLDER)):
            continue
        _add = {k: d[k] for k in _GRAFT_KEYS if d.get(k) and not m.get(k)}
        if not _add:
            continue
        _add.setdefault("isTruncated", True)
        filtres[i] = {**m, **_add}
        persistables[i] = {**persistables[i], **_add}
        n += 1
    return n


def _normalize_client_messages(messages: list) -> tuple[list, list]:
    """Payload client → ``(filtrés, persistables)``.

    - *filtrés* : les dicts d'origine dont le rôle et le type de contenu sont
      valides — c'est la vue passée à ``_expand_history_for_llm`` et à
      ``last_user_text``, qui peuvent avoir besoin de champs non persistés.
    - *persistables* : des copies à champs whitelistés, base de ce qui sera
      écrit en base à la fin du tour.

    On NE strippe PAS ``tool_history`` : ne garder que role+content
    effacerait l'historique d'outils des tours précédents à chaque persist —
    dès le 3e tour, le modèle ne retrouverait plus la trace de ses appels
    passés. Même raison pour ``thinking``, ``images``, ``task_runs`` et les
    champs de notice.
    """
    filtres: list = []
    for _m in messages or []:
        if not isinstance(_m, dict):
            continue
        if _m.get("role") not in _CLIENT_ROLES:
            continue
        if not isinstance(_m.get("content", ""), (str, list)):
            continue
        filtres.append(_m)

    persistables: list = []
    for m in filtres:
        _mm = {"role": m["role"], "content": m.get("content", "")}
        if m.get("tool_history"):
            _mm["tool_history"] = m["tool_history"]
            # Marqueur de format delta : sans lui, un historique delta
            # re-persisté après un round-trip client redeviendrait « legacy »
            # aux yeux de la dédup d'expansion et du parseur de segments front.
            if m.get("tool_history_delta"):
                _mm["tool_history_delta"] = True
        if m.get("thinking"):
            _mm["thinking"] = m["thinking"]
        # Raisonnement d'un tour coupé en plein think (``truncated_in_think``) :
        # SEULE portion de thinking persistée (``upsert_chat`` strippe le champ
        # ``thinking`` générique) — c'est elle qui rend un « Continuer » utile
        # (reprise avec le raisonnement au lieu de repartir de zéro). Purgée à
        # la reprise aboutie (cf. fusion Continue).
        if isinstance(m.get("resume_thinking"), str) and m["resume_thinking"]:
            _mm["resume_thinking"] = m["resume_thinking"]
        if m.get("thinkingTruncated"):
            _mm["thinkingTruncated"] = True
        if m.get("images"):
            _mm["images"] = m["images"]
        # Fichiers modifiés par les outils du tour (diffs du chat).
        _fcl = _fc_list(m) if m.get("files_changed") else []
        if _fcl:
            _mm["files_changed"] = _fcl
        # Cartes agents (outil ``task``) des tours PRÉCÉDENTS : préservées au
        # round-trip client → sinon effacées au persist du tour suivant.
        # (``tools`` strippé — dégraisse aussi les records legacy.)
        if m.get("task_runs"):
            _runs_rt = _task_runs_for_persist(m["task_runs"])
            if _runs_rt:
                _mm["task_runs"] = _runs_rt
        # Exécutions du message (``runs``) : sinon perdues au persist.
        if isinstance(m.get("run_ids"), list):
            _rids = [r for r in m["run_ids"] if isinstance(r, str) and 0 < len(r) <= 64][:64]
            if _rids:
                _mm["run_ids"] = _rids
        if isinstance(m.get("pruned"), int) and not isinstance(m.get("pruned"), bool) \
                and 0 < m["pruned"] < 100000:
            _mm["pruned"] = m["pruned"]
        # Jalons de compaction du message : sinon perdus au persist.
        if isinstance(m.get("compactions"), list):
            _cps = [_compaction_pour_message(c) for c in m["compactions"][:20] if isinstance(c, dict)]
            if _cps:
                _mm["compactions"] = _cps
        _met = _metrics_for_persist(m.get("metrics"))
        if _met:
            _mm["metrics"] = _met
        if m.get("role") == "notice":
            for _k in _NOTICE_FIELDS:
                if m.get(_k) is not None:
                    _mm[_k] = m[_k]
        persistables.append(_mm)
    return filtres, persistables


def _tronc_pour_reprise(prev: dict) -> str:
    """Tronc à conserver DEVANT la continuation, lors d'un « Continuer ».

    ``_CANCEL_PLACEHOLDER`` est un marqueur d'INTERFACE que la route écrit
    elle-même quand une annulation n'a produit aucune prose. Ne pas le
    concaténer devant la reprise : il serait figé dans le contenu PERSISTÉ (la
    réponse finale commencerait par « _(génération interrompue)_ »), et
    surtout l'égalité stricte de ``_expand_history_for_llm`` (qui sait, elle,
    écarter ce marqueur) ne reconnaîtrait plus la chaîne fusionnée — le
    marqueur repartirait au modèle à tous les tours suivants. La vue modèle
    et la persistance appliquent donc la même garde.
    """
    texte = _msg_text(prev.get("content", ""))
    return "" if texte.strip() == _CANCEL_PLACEHOLDER else texte


def _split_for_continue(msgs: list) -> tuple[dict, list, list]:
    """Isole le dernier assistant d'un fil pouvant se terminer par des notices.

    Retourne ``(prev, avant, apres)`` — ``prev`` vaut ``{}`` si le fil ne se
    termine pas par un assistant, et l'appelant ne fusionne alors rien.

    Une notice est ajoutée EN FIN de fil par la compaction : elle peut donc
    s'intercaler après le dernier assistant. Un simple ``msgs[-1]`` raterait la
    fusion d'un « Continue » lancé juste après une compaction, et le
    rechargement afficherait DEUX bulles assistant — précisément ce que cette
    fusion existe pour éviter. ``apres`` est réinjecté après le message
    fusionné pour que la notice ne change pas de place dans le fil.
    """
    i = len(msgs) - 1
    while i >= 0 and (msgs[i] or {}).get("role") == "notice":
        i -= 1
    if i < 0 or (msgs[i] or {}).get("role") != "assistant":
        return {}, msgs, []
    return msgs[i], msgs[:i], msgs[i + 1:]

def _expand_history_for_llm(messages: list, *, is_continue: bool = False,
                            pruned_keys=(), resume_native: bool = False,
                            user_suffixes=None) -> list:
    """Expanse l'historique client en messages OpenAI pour le LLM :
    ``tool_history`` persistée → messages assistant(tool_calls)/tool/user
    intercalés, + prompt de reprise si ``is_continue`` sur le dernier
    assistant.

    Deux formats de ``tool_history`` coexistent :
      • DELTA (``tool_history_delta`` sur le message) : uniquement le travail
        du run qui a produit ce message → expansion intégrale ;
      • LEGACY (non marqué) : capture CUMULATIVE depuis le 1er message
        agentique — chaque historique re-contient ceux des tours précédents.
        Expansé tel quel, le payload DOUBLAIT à chaque tour (1, 7, 19, 43,
        91, 187 messages…) jusqu'à saturer n_ctx (« génération interrompue »
        systématique). On coupe donc le préfixe déjà émis (signatures
        composites, cf. _tool_entry_sigs) — croissance ramenée à ~linéaire
        sans migration des chats existants.

    PARTAGÉ par la route de streaming ET la compression manuelle : les deux
    doivent produire exactement la même structure de tours, sinon le
    ``covered_turns`` persisté par l'un serait incohérent pour l'autre
    (le fallback no-drop rattraperait, mais en perdant l'économie du drop).

    ``pruned_keys`` : clés d'élagage persistées
    (``meta_json["ctx_pruned_keys"]``) — les tool_results correspondants
    sont rendus comme MARQUEUR plein dans la vue modèle (monotone, le
    stockage reste complet).

    ``resume_native`` : le serveur cible accepte ``continue_final_message``
    (support CONFIRMÉ, cf. ``continue_final_support``) — un Continue sur un
    assistant think-only (``resume_thinking``) émet alors la forme native
    ``{assistant, content:"", reasoning_content}`` en DERNIER message
    (build_llama_payload arme les flags) : la génération reprend DANS le bloc
    think. Sinon, repli « <think>…</think> fermé + consigne de conclusion ».
    """

    def _resume_tail_for(_rt: str) -> list:
        from llm_core._think_resume import clip_resume_thinking
        _rt = clip_resume_thinking(str(_rt))
        if resume_native:
            return [{"role": "assistant", "content": "", "reasoning_content": _rt}]
        return [
            {"role": "assistant", "content": "<think>\n" + _rt + "\n</think>"},
            {"role": "user", "content": _RESUME_AFTER_THINK},
        ]

    _pruned = set(pruned_keys or ())
    if _pruned:
        from llm_core.context.pruning import PRUNE_CLEARED_MARKER, _prune_key
    out: list = []
    # Signatures des entrées agentiques déjà émises — sert à couper le
    # préfixe rejoué des historiques LEGACY cumulatifs.
    seen_sigs: set = set()
    _suffixes = user_suffixes if isinstance(user_suffixes, dict) else {}
    if _suffixes:
        from llm_core.context.pruning import merge_user_suffix, user_suffix_sig
    _user_rank = 0
    _last_user_i = max((j for j, mm in enumerate(messages)
                        if (mm or {}).get("role") == "user"), default=-1)
    # ``last_idx`` = dernier message NON-notice : la consigne de reprise
    # (is_continue) vise le dernier assistant même si une notice de
    # compaction a été ajoutée après lui.
    last_idx = len(messages) - 1
    while last_idx >= 0 and (messages[last_idx] or {}).get("role") == "notice":
        last_idx -= 1
    for _i, _m in enumerate(messages):
        _role = _m.get("role")
        # ``notice`` = marqueur UI persisté (ex. « conversation compactée »,
        # posé par /compress) : affiché dans le fil, JAMAIS envoyé au modèle
        # (role inconnu → 400 Jinja) ni compté dans l'indexation des tours.
        if _role == "notice":
            continue
        _content = _m.get("content")
        _hist = _m.get("tool_history") if isinstance(_m, dict) else None
        if _role == "assistant" and isinstance(_hist, list) and _hist:
            _start = 0
            if not _m.get("tool_history_delta"):
                # LEGACY cumulatif : le préfixe rejoué est en TÊTE. On avance
                # tant que les signatures ont déjà été émises et on s'ARRÊTE à
                # la première entrée fraîche.
                #
                # Ne PAS retenir le DERNIER index vu : les ids de repli sont
                # déterministes et se répètent d'un tour à l'autre
                # (`providers/llamacpp.py` émet `call_{i}` indexé sur la
                # position ; idem `call_{iter}_{idx}`), si bien qu'un outil
                # idempotent rappelé avec les mêmes arguments — `ls`,
                # `git status`, `read_file` — produit en QUEUE une signature
                # déjà vue. `_start` sauterait alors par-dessus du travail
                # frais : soit il serait retiré de la vue du modèle, soit la
                # coupe tomberait entre un `assistant.tool_calls` et son
                # résultat, et le message `tool` orphelin ferait répondre 400
                # au provider (« génération interrompue »).
                _start = 0
                for _k, _h in enumerate(_hist):
                    _sigs = _tool_entry_sigs(_h)
                    if not _sigs:
                        # Entrée texte : aucune signature, donc impossible de
                        # dire si elle a déjà été émise. Elle ne tranche pas et
                        # ne fait pas avancer la coupe (elle sera incluse dans
                        # le préfixe si une entrée VUE la suit).
                        continue
                    if _sigs <= seen_sigs:
                        _start = _k + 1          # entrée du préfixe rejoué
                        continue
                    break                        # première entrée FRAÎCHE
                # Les entrées ``user`` de tête après la coupe (prompts des
                # tours précédents / nudges) sont déjà présentes en messages
                # plats — les rejouer les dupliquerait.
                while _start < len(_hist) and (_hist[_start] or {}).get("role") == "user":
                    _start += 1
                # Ne JAMAIS commencer sur un résultat d'outil : sans son
                # ``assistant.tool_calls``, le provider rejette le payload.
                while _start < len(_hist) and (_hist[_start] or {}).get("role") == "tool":
                    _start += 1

            for _h in _hist[_start:]:
                if not isinstance(_h, dict):
                    continue
                _hr = _h.get("role")
                if _hr not in ("assistant", "tool", "user"):
                    continue

                _expanded = {"role": _hr}
                if "content" in _h:
                    _expanded["content"] = _h.get("content")
                if _hr == "assistant" and _h.get("tool_calls"):
                    _expanded["tool_calls"] = _h["tool_calls"]
                if _hr == "tool" and _h.get("tool_call_id"):
                    _expanded["tool_call_id"] = _h["tool_call_id"]
                    # Marque d'élagage : contenu ENTIER remplacé par le
                    # marqueur dans la vue envoyée — jamais dans le stockage.
                    if _pruned and _prune_key(_h) in _pruned:
                        _expanded["content"] = PRUNE_CLEARED_MARKER
                out.append(_expanded)
                seen_sigs |= _tool_entry_sigs(_h)

            if is_continue and _i == last_idx:
                # « Continuer » sur un assistant AVEC tool_history : la
                # consigne de reprise est injectée ici aussi, sinon le modèle
                # ne saurait pas qu'il doit continuer.
                _c_str = str(_content).strip() if _content else ""
                if _c_str and _c_str != _CANCEL_PLACEHOLDER:
                    out.append({"role": "assistant", "content": _content})
                    out.append({"role": "user", "content": _resume_instruction(_content)})
                elif _m.get("resume_thinking"):
                    # Tour coupé en PLEIN raisonnement (content vide) : reprise
                    # À PARTIR du raisonnement persisté. Sans consigne, le
                    # modèle repartirait de zéro → re-raisonnerait 5-10 min →
                    # retomberait sur le même mur, en boucle.
                    out.extend(_resume_tail_for(_m["resume_thinking"]))
            else:
                if _content:
                    out.append({"role": "assistant", "content": _content})
        else:

            if is_continue and _i == last_idx and _role == "assistant":
                _c_str = str(_content).strip() if _content else ""
                if _c_str and _c_str != _CANCEL_PLACEHOLDER:
                    out.append({"role": "assistant", "content": _content})
                    out.append({"role": "user", "content": _resume_instruction(_content)})
                elif _m.get("resume_thinking"):
                    # Même règle que la branche tool_history : cf. ci-dessus.
                    out.extend(_resume_tail_for(_m["resume_thinking"]))
                continue
            # Rejeu À L'OCTET du suffixe réservé au modèle (rappel
            # ``<todo_status>``) que la boucle a fusionné à cette question :
            # sans lui, le préfixe KV divergerait dès elle au tour suivant.
            # Jamais sur la DERNIÈRE question (le tour en cours reçoit son
            # propre rappel, frais, de la boucle) — sauf sur un « Continuer » :
            # la dernière question est alors celle du tour REPRIS, qui a reçu
            # (et persisté) son rappel pendant ce tour ; la boucle fusionne le
            # rappel frais dans la consigne de reprise, pas dans elle. Sans ce
            # rejeu, le préfixe divergerait sur elle et tout le tour tronqué
            # serait re-prérempli.
            if _role == "user" and _suffixes and (_i < _last_user_i or is_continue):
                _sig = user_suffix_sig(_user_rank, _content)
                if _sig in _suffixes:
                    _content = merge_user_suffix(_content, _suffixes[_sig])
            if _role == "user":
                _user_rank += 1
            out.append({"role": _role, "content": _content})
    return out
