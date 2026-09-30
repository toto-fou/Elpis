# SPDX-License-Identifier: MIT
"""
llm_core._desktop_replay — exécuteur de rejeu de scénarios de test desktop.

Rejoue une séquence de pas enregistrés (cf. _scenario_model.js / db/scenarios.py)
de façon DÉTERMINISTE — SANS LLM dans le cas nominal :

  • re-ancrage par label/rôle sur l'arbre d'accessibilité (observe a11y, rapide),
  • repli sur les coordonnées brutes enregistrées,
  • AUTO-RÉPARATION (1 passe vision) seulement si l'ancre sémantique est
    introuvable : on ré-observe AVEC le label comme prompt de grounding, puis on
    re-résout. ``healed=True`` est journalisé pour signaler une UI qui a bougé.

Réutilise les MÊMES primitives que le chat/clic (observe_core / act_core /
resolve_element) → aucune logique d'action dupliquée. Tout est synchrone
(requests) ; le runner l'appelle via ``run_in_threadpool``.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

import shared_infra.config as _cfg
from llm_core._desktop_session import resolve_element
from llm_core.tools.desktop_tools import (
    _ham_hex,
    act_core,
    grab_core,
    launch_core,
    observe_core,
    probe_tree_core,
    read_text_core,
    wait_window_core,
)

logger = logging.getLogger("uvicorn.error")

_POINT_OPS = ("click", "left_click", "double_click", "right_click", "triple_click",
              "middle_click", "move", "drag")
# Ops SÉMANTIQUES (UIA) : l'agent re-résout le contrôle par auto_id/nom au moment
# d'agir → pas de point requis ; on thread l'ancre (auto_id/libellé/rôle) + valeur.
_SEMANTIC_REPLAY_OPS = ("toggle", "check", "uncheck", "select", "expand", "collapse",
                        "scroll_into_view", "set_value", "invoke")
_ACT_ARG_KEYS = ("text", "keys", "button", "clicks", "dy", "x2", "y2", "modifiers")

# ── Attentes intelligentes (action → vérification d'événement) ────────────────
# Chaque pas attend que SON attente (``expect``) se réalise, jusqu'à son timeout
# (configurable 1,5 s → 5 min). Sondes du moins cher au plus cher : signature
# dHash (stabilité) → présence a11y → OCR → 1 passe vision en dernier recours.
DEFAULT_TIMEOUT_MS = 30_000
MIN_TIMEOUT_MS = 1_500            # plancher bas → FAST-FAIL (un pas peut viser court)
MAX_TIMEOUT_MS = 300_000          # 5 min
_STABLE_CEILING_MS = 8_000       # 'stable' best-effort : plafond pour ne pas gaspiller
                                 # 30 s sur un écran qui ne se fige jamais (anim/caret)
_SETTLE_QUIET_MS = 700            # écran « stable » = inchangé pendant ce délai
_SETTLE_POLL_MS = 400
_ELEMENT_POLL_MS = 600
_TEXT_POLL_MS = 1500             # OCR coûteux → sondage espacé
_SIG_SAME = int(os.environ.get("DESKTOP_SIG_SAME", "2") or 2)  # hamming ≤ N → « identique » (réglable)
_RETRY_BACKOFF_MS = 600          # pause croissante entre tentatives d'un même pas
_MAX_RETRY = 5                   # garde-fou sur step.retry

# ── C2 : budget de SELF-HEAL vision PAR RUN de rejeu ─────────────────────────
# La self-heal (1 passe vision pour re-localiser une ancre déplacée, ~0,5-2 s)
# est chère ; sans plafond, un écran globalement décalé la déclenche à CHAQUE pas
# (un scénario de 50 pas → 50 passes vision = des dizaines de secondes, et coûteux
# si l'observateur est un LLM local). On borne par run. Clé = cible (un run/cible
# à la fois via le verrou DB). HORS rejeu (cible absente du registre), la
# self-heal n'est PAS bornée → le chemin live ``desktop_wait`` reste inchangé.
_self_heal_left: Dict[str, int] = {}


def _self_heal_cap() -> int:
    """Budget self-heal courant (config hot-reloadable, LU en début de run)."""
    return max(0, int(getattr(_cfg, "DESKTOP_REPLAY_SELF_HEAL_MAX", 10) or 0))


def _self_heal_begin(target: str) -> None:
    _self_heal_left[target] = _self_heal_cap()

def _self_heal_end(target: str) -> bool:
    """Nettoie le budget du run et renvoie True si le budget a été ÉPUISÉ (au moins
    une passe self-heal refusée faute de budget) — « no silent cap »."""
    left = _self_heal_left.pop(target, None)
    exhausted = bool(left == 0)             # 0 = tout consommé (None = jamais démarré)
    if exhausted:
        logger.warning("[replay] budget self-heal vision ÉPUISÉ sur ce run — des "
                       "ancres déplacées ont pu échouer faute de passe vision")
    return exhausted

def _self_heal_allow(target: str) -> bool:
    """True si une passe self-heal vision est permise (et la décompte). Hors rejeu
    (cible absente) → toujours True : le chemin live n'est jamais borné."""
    if target not in _self_heal_left:
        return True
    if _self_heal_left[target] <= 0:
        return False
    _self_heal_left[target] -= 1
    return True

def _self_heal_denied(target: str) -> bool:
    """True si une passe self-heal serait REFUSÉE ICI faute de budget (rejeu borné,
    budget à 0) — sert à enrichir l'erreur d'ancre non résolue."""
    return target in _self_heal_left and _self_heal_left[target] <= 0


def _now_ms() -> int:
    # AUDIT 2026-08-30 (S8) — monotonic (ex-``time.time()``). Cette horloge ne
    # sert QUE des durées : échéances d'attente d'élément, fenêtres de stabilité
    # (``stable_since``), et les ``_now_ms() - start`` rendus en ``duration_ms``.
    # Aucun horodatage absolu n'en dépend (vérifié sur les ~20 appels), donc un
    # recalage d'horloge ne peut plus faire expirer un rejeu en cours ni rendre
    # une durée négative.
    return int(time.monotonic() * 1000)


# ── Annulation COOPÉRATIVE du rejeu (« Arrêter ») ───────────────────────────
# Le rejeu tourne en thread (run_in_threadpool) → annuler la tâche asyncio ne le
# tue pas. On utilise un thread-local (un rejeu = un thread) : ``replay_scenario``
# y pose une fonction ``should_abort`` ; chaque attente passe par ``_sleep_ms``
# qui lève ``ReplayAborted`` dès qu'elle renvoie True → on sort de N'IMPORTE quelle
# boucle d'attente sans toucher leurs 7 signatures. ``ReplayAborted`` dérive de
# BaseException pour TRAVERSER les ``except Exception`` des pas (sinon avalé).
class ReplayAborted(BaseException):
    """Signal interne : l'utilisateur a demandé l'arrêt du rejeu en cours."""


_replay_local = threading.local()


def _set_abort_check(fn) -> None:
    _replay_local.abort = fn


def _clear_abort_check() -> None:
    _replay_local.abort = None


def _aborted() -> bool:
    fn = getattr(_replay_local, "abort", None)
    try:
        return bool(fn and fn())
    except Exception:
        return False


def _sleep_ms(ms: int) -> None:
    if _aborted():                       # arrêt demandé → sort de la boucle d'attente
        raise ReplayAborted()
    if ms > 0:
        time.sleep(ms / 1000.0)


def _clamp_timeout(ms: Any) -> int:
    try:
        v = int(ms)
    except (TypeError, ValueError):
        return DEFAULT_TIMEOUT_MS
    return max(MIN_TIMEOUT_MS, min(MAX_TIMEOUT_MS, v))


def _sig_of(res: Any) -> str:
    return (res.get("sig") or "") if isinstance(res, dict) else ""


def wait_stable(username: str, target: str, *, timeout_ms: int,
                quiet_ms: int = _SETTLE_QUIET_MS, poll_ms: int = _SETTLE_POLL_MS) -> int:
    """Attend que l'écran cesse de bouger (signatures dHash quasi identiques
    pendant ``quiet_ms``), borné par ``timeout_ms``. Retourne le temps attendu (ms).
    Best-effort : ne « échoue » jamais — au pire on a attendu le budget."""
    start = _now_ms()
    deadline = start + max(0, timeout_ms)
    prev = _sig_of(grab_core(username, target))
    stable_since = _now_ms()
    while _now_ms() < deadline:
        _sleep_ms(poll_ms)
        cur = _sig_of(grab_core(username, target))
        if not cur or not prev or _ham_hex(prev, cur) > _SIG_SAME:
            stable_since = _now_ms()           # ça bouge encore → on réarme
        prev = cur
        if _now_ms() - stable_since >= quiet_ms:
            break
    return _now_ms() - start


def _sonde_ok(obs) -> bool:
    """La sonde a11y a-t-elle ABOUTI ?

    AUDIT 2026-08-23 — ``probe_tree_core`` relaie l'enveloppe ``err()`` de
    ``_agent_req`` (``ok: False``) pour tous les échecs durs :
    ``agent_unreachable``, ``agent_timeout``, ``agent_busy`` (503 marqué
    non-retryable), ``agent_http_error``. Un échec de sonde ne doit JAMAIS
    devenir un verdict : les attentes « l'élément a disparu », « la valeur
    n'est plus là », « il reste ≤ N éléments » se déclaraient satisfaites au
    PREMIER tour, en 0 ms, dès que la machine cible ne répondait plus — et le
    pas suivant du scénario cliquait aux coordonnées d'une boîte de dialogue
    toujours à l'écran.
    """
    return not (isinstance(obs, dict) and obs.get("ok") is False)


def wait_element(username: str, target: str, query: str, *, present: bool,
                 timeout_ms: int, poll_ms: int = _ELEMENT_POLL_MS,
                 self_heal: bool = True) -> Tuple[bool, int]:
    """Attend qu'un élément (par label/requête) soit présent (``present=True``) ou
    absent (``False``) dans l'arbre a11y, borné. Sonde a11y (pas cher) ; 1 passe
    vision en dernier recours (présence seulement). Retourne ``(satisfait, ms)``."""
    start = _now_ms()
    deadline = start + max(0, timeout_ms)
    if not query:
        return (True, 0)
    while True:
        obs = probe_tree_core(username, target)
        ok_obs = _sonde_ok(obs)
        if not ok_obs:
            # Sonde en échec : aucun verdict. On retente jusqu'à l'échéance,
            # puis on rend NON satisfait — jamais « satisfait par défaut ».
            if _now_ms() >= deadline:
                return (False, _now_ms() - start)
            _sleep_ms(poll_ms)
            continue
        found = bool(_center(resolve_element(username, target, query=query)))
        if found == present:
            return (True, _now_ms() - start)
        if _now_ms() >= deadline:
            if present and self_heal and _self_heal_allow(target):  # 1 passe vision (bornée en rejeu, C2)
                observe_core(username, target, prompt=query, use_vision=True, use_tree=True)
                if _center(resolve_element(username, target, query=query)):
                    return (True, _now_ms() - start)
            return (False, _now_ms() - start)
        _sleep_ms(poll_ms)


def wait_text(username: str, target: str, text: str, *, present: bool,
              timeout_ms: int, poll_ms: int = _TEXT_POLL_MS, cmp: str = "partiel") -> Tuple[bool, int]:
    """Attend qu'un texte soit présent/absent à l'écran (OCR), borné. ``cmp`` =
    mode de comparaison (partiel|exact|regex). Retourne ``(satisfait, ms)``."""
    start = _now_ms()
    deadline = start + max(0, timeout_ms)
    needle = (text or "").strip()
    last_sig = None
    hay = ""
    while True:
        # CIBLAGE DU COMPUTE : l'OCR (vision) est cher → on ne le REFAIT que si
        # l'écran a changé (signature dHash, une simple capture). Un écran figé
        # qui attend un texte ne provoque qu'UN seul OCR au lieu d'un par sonde.
        cur_sig = _sig_of(grab_core(username, target))
        if last_sig is None or not cur_sig or _ham_hex(cur_sig, last_sig) > _SIG_SAME:
            res = read_text_core(username, target)
            hay = (res.get("text") or "") if isinstance(res, dict) else ""
            last_sig = cur_sig
        contains = _text_cmp(hay, needle, cmp)
        if contains == present:
            return (True, _now_ms() - start)
        if _now_ms() >= deadline:
            return (False, _now_ms() - start)
        _sleep_ms(poll_ms)


_WINDOW_ROLES = ("window", "dialog", "frame", "document", "pane", "panel")


def _el_key(el: Dict[str, Any]) -> str:
    label = str(el.get("label") or "").strip().lower()
    role = str(el.get("role") or "").lower()
    return (label + "" + role) if label else ("#" + str(el.get("id") or ""))


def _observe_keys(username: str, target: str) -> set:
    obs = probe_tree_core(username, target)
    els = obs.get("elements") if isinstance(obs, dict) else None
    return {_el_key(e) for e in (els or []) if isinstance(e, dict)}


def wait_appear(username: str, target: str, baseline: set, *, timeout_ms: int,
                poll_ms: int = _ELEMENT_POLL_MS, min_new: int = 3) -> Tuple[bool, int]:
    """Attend qu'un NOUVEL élément apparaisse vs ``baseline`` (photographiée AVANT
    l'action) : une nouvelle FENÊTRE/dialogue, ou au moins ``min_new`` éléments
    inédits (une app qui s'ouvre en ajoute beaucoup). **Robuste aux titres qui
    changent** (on ne matche aucun label précis) → idéal pour « lancer un
    raccourci ». Retourne ``(satisfait, ms)``."""
    start = _now_ms()
    deadline = start + max(0, timeout_ms)
    base = set(baseline or set())
    while True:
        obs = probe_tree_core(username, target)
        els = obs.get("elements") if isinstance(obs, dict) else []
        new = [e for e in (els or []) if isinstance(e, dict) and _el_key(e) not in base]
        new_win = [e for e in new if str(e.get("role") or "").lower() in _WINDOW_ROLES]
        if new_win or len(new) >= min_new:
            return (True, _now_ms() - start)
        if _now_ms() >= deadline:
            return (False, _now_ms() - start)
        _sleep_ms(poll_ms)


def _text_cmp(haystack: str, needle: str, cmp: str = "partiel") -> bool:
    """Compare ``haystack`` à ``needle`` selon le mode (« texte partiel ») :
    ``exact`` (égalité, casse + espaces normalisés), ``regex`` (recherche), sinon
    ``partiel`` (sous-chaîne, insensible à la casse — défaut tolérant). ``needle``
    vide → vrai si ``haystack`` non vide. Partagé par les attentes Texte & Valeur."""
    h = str(haystack or "")
    n = str(needle or "")
    if not n.strip():
        return bool(h.strip())
    c = str(cmp or "partiel").strip().lower()
    if c == "exact":
        return h.strip().lower() == n.strip().lower()
    if c == "regex":
        import re as _re
        try:
            return _re.search(n, h) is not None
        except _re.error:
            return n.lower() in h.lower()
    return n.strip().lower() in h.lower()        # partiel (défaut)


def _expect_cmp(expect: Dict[str, Any]) -> str:
    """Mode de comparaison d'une attente Texte/Valeur : ``expect.cmp`` ∈
    partiel|exact|regex, avec repli sur l'ancien booléen ``expect.match`` (regex)."""
    c = str((expect or {}).get("cmp") or "").strip().lower()
    if c in ("partiel", "exact", "regex"):
        return c
    return "regex" if (expect or {}).get("match") else "partiel"


def _value_matches(val: str, needle: str, cmp="partiel") -> bool:
    """Compat : ``cmp`` peut être l'ancien booléen ``match`` (True → regex)."""
    if isinstance(cmp, bool):
        cmp = "regex" if cmp else "partiel"
    return _text_cmp(val, needle, cmp)


def _count_ok(cnt: int, op: str, n: int) -> bool:
    op = (op or "==").strip()
    if op in (">=", "ge"):
        return cnt >= n
    if op in ("<=", "le"):
        return cnt <= n
    if op in (">", "gt"):
        return cnt > n
    if op in ("<", "lt"):
        return cnt < n
    return cnt == n


def _read_element_value(username: str, target: str, el: Dict[str, Any]) -> str:
    """Valeur d'un élément : ``value`` a11y (UIA ValuePattern / AT-SPI) en priorité,
    repli OCR ciblé sur sa box (read_text_core) — couvre les champs custom/canvas."""
    if not el:
        return ""
    v = el.get("value")
    if v not in (None, ""):
        return str(v)
    try:
        r = read_text_core(username, target, element_id=str(el.get("id") or ""))
        return (r.get("text") or "") if isinstance(r, dict) else ""
    except Exception:  # pragma: no cover
        return ""


def wait_value(username: str, target: str, query: str, expected: str, *, present: bool,
               cmp: str = "partiel", timeout_ms: int, poll_ms: int = _ELEMENT_POLL_MS) -> Tuple[bool, int]:
    """Attend que la VALEUR de l'élément ``query`` matche ``expected`` (présent/absent),
    selon ``cmp`` (partiel|exact|regex), borné. Lit la valeur a11y puis OCR en repli."""
    start = _now_ms()
    deadline = start + max(0, timeout_ms)
    while True:
        if not _sonde_ok(probe_tree_core(username, target)):
            if _now_ms() >= deadline:
                return (False, _now_ms() - start)
            _sleep_ms(poll_ms)
            continue
        el = resolve_element(username, target, query=query) if query else None
        ok = _value_matches(_read_element_value(username, target, el or {}), expected, cmp)
        if ok == present:
            return (True, _now_ms() - start)
        if _now_ms() >= deadline:
            # C4 — self-heal (borné en rejeu) : 1 passe vision (label en grounding)
            # puis re-vérifie une fois, comme wait_element — une valeur dont l'élément
            # a bougé n'échoue plus faute de passe vision.
            if present and query and _self_heal_allow(target):
                observe_core(username, target, prompt=query, use_vision=True,
                             use_tree=True, persist_frame=False)
                el2 = resolve_element(username, target, query=query)
                if _value_matches(_read_element_value(username, target, el2 or {}),
                                  expected, cmp) == present:
                    return (True, _now_ms() - start)
            return (False, _now_ms() - start)
        _sleep_ms(poll_ms)


def wait_state(username: str, target: str, query: str, state: str, *,
               timeout_ms: int, poll_ms: int = _ELEMENT_POLL_MS) -> Tuple[bool, int]:
    """Attend qu'un élément ``query`` porte l'état a11y ``state`` (checked/enabled/
    focused/selected…), borné. Retourne ``(satisfait, ms)``."""
    start = _now_ms()
    deadline = start + max(0, timeout_ms)
    st = str(state or "").strip().lower()
    while True:
        if not _sonde_ok(probe_tree_core(username, target)):
            if _now_ms() >= deadline:
                return (False, _now_ms() - start)
            _sleep_ms(poll_ms)
            continue
        el = resolve_element(username, target, query=query) if query else None
        states = [str(s).lower() for s in (el.get("states") or [])] if el else []
        if st and st in states:
            return (True, _now_ms() - start)
        if _now_ms() >= deadline:
            # C4 — self-heal (borné) : 1 passe vision puis re-vérifie l'état une fois.
            if st and query and _self_heal_allow(target):
                observe_core(username, target, prompt=query, use_vision=True,
                             use_tree=True, persist_frame=False)
                el2 = resolve_element(username, target, query=query)
                st2 = [str(s).lower() for s in (el2.get("states") or [])] if el2 else []
                if st in st2:
                    return (True, _now_ms() - start)
            return (False, _now_ms() - start)
        _sleep_ms(poll_ms)


def wait_count(username: str, target: str, query: str, role: str, op: str, n: int, *,
               timeout_ms: int, poll_ms: int = _ELEMENT_POLL_MS) -> Tuple[bool, int]:
    """Attend que le NOMBRE d'éléments matchant ``query`` (sous-chaîne label) et/ou
    ``role`` satisfasse ``op n`` (==,>=,<=,>,<), borné. Ex. « 3 lignes ajoutées »."""
    start = _now_ms()
    deadline = start + max(0, timeout_ms)
    q = str(query or "").strip().lower()
    rl = str(role or "").strip().lower()
    while True:
        obs = probe_tree_core(username, target)
        if not _sonde_ok(obs):
            if _now_ms() >= deadline:
                return (False, _now_ms() - start)
            _sleep_ms(poll_ms)
            continue
        els = obs.get("elements") if isinstance(obs, dict) else []
        cnt = 0
        for e in (els or []):
            if not isinstance(e, dict):
                continue
            lbl = str(e.get("label") or e.get("name") or "").lower()
            ro = str(e.get("role") or "").lower()
            if (not q or q in lbl) and (not rl or ro == rl):
                cnt += 1
        if _count_ok(cnt, op, n):
            return (True, _now_ms() - start)
        if _now_ms() >= deadline:
            return (False, _now_ms() - start)
        _sleep_ms(poll_ms)


def _expect_query(expect: Dict[str, Any]) -> str:
    q = expect.get("query") or expect.get("value")
    if not q:
        q = (expect.get("anchor") or {}).get("label") or (expect.get("anchor") or {}).get("query")
    return str(q or "")


def check_expect(username: str, target: str, expect: Dict[str, Any],
                 timeout_ms: int, baseline: Optional[set] = None) -> Tuple[bool, int, str]:
    """Vérifie l'attente d'un pas (``expect.kind`` ∈ element|element_gone|text|
    text_gone|appear|stable|none), bornée par ``timeout_ms``. ``baseline`` =
    éléments d'AVANT l'action (requis pour ``appear``). Retourne
    ``(satisfait, ms_attendus, détail)``."""
    kind = (expect or {}).get("kind") or "stable"
    q = _expect_query(expect or {})
    if kind == "none":
        return (True, 0, "none")
    if kind == "appear":
        ok2, waited = wait_appear(username, target, baseline or set(), timeout_ms=timeout_ms)
        return (ok2, waited, "appear")
    if kind == "window_ready":
        # Synchro UIA fiable : l'agent attend qu'une fenêtre matche ET soit
        # PRÊTE (ReadyForUserInteraction / WaitForInputIdle). Idéal au lancement.
        import re as _re
        aid = (expect.get("anchor") or {}).get("auto_id") or ""
        r = wait_window_core(username, target,
                             title_re=(_re.escape(q) if (q and not aid) else ""),
                             auto_id=aid, ready=True, timeout_ms=timeout_ms)
        ok2 = bool(isinstance(r, dict) and r.get("ok") is not False and r.get("found"))
        return (ok2, 0, "window_ready «%s»" % (aid or q))
    if kind in ("element", "element_gone"):
        ok2, waited = wait_element(username, target, q, present=(kind == "element"), timeout_ms=timeout_ms)
        return (ok2, waited, "%s «%s»" % (kind, q))
    if kind in ("text", "text_gone"):
        ok2, waited = wait_text(username, target, q, present=(kind == "text"),
                                cmp=_expect_cmp(expect), timeout_ms=timeout_ms)
        return (ok2, waited, "%s «%s»" % (kind, q))
    if kind in ("value", "value_gone"):
        # Vérifie le RÉSULTAT (le champ « q » contient/matche « expected » selon le
        # mode partiel/exact/regex), pas juste la présence — attrape les valeurs
        # silencieusement fausses.
        ev = str((expect or {}).get("expected") or "")
        ok2, waited = wait_value(username, target, q, ev, present=(kind == "value"),
                                 cmp=_expect_cmp(expect), timeout_ms=timeout_ms)
        return (ok2, waited, "%s «%s»=«%s»" % (kind, q, ev))
    if kind == "state":
        stt = str((expect or {}).get("state") or "")
        ok2, waited = wait_state(username, target, q, stt, timeout_ms=timeout_ms)
        return (ok2, waited, "state «%s» %s" % (q, stt))
    if kind == "count":
        op = str((expect or {}).get("op") or "==")
        try:
            n = int((expect or {}).get("count") or 0)
        except (TypeError, ValueError):
            n = 0
        ok2, waited = wait_count(username, target, q, (expect or {}).get("role") or "",
                                 op, n, timeout_ms=timeout_ms)
        return (ok2, waited, "count «%s» %s%s" % (q or (expect or {}).get("role") or "*", op, n))
    # 'stable' (et tout kind inconnu, prudent) : best-effort, jamais en échec.
    # Plafonné (_STABLE_CEILING_MS) : inutile d'attendre 30 s qu'un écran animé se
    # fige — la stabilité n'échoue jamais, on ne fait que temporiser.
    return (True, wait_stable(username, target,
                              timeout_ms=min(timeout_ms, _STABLE_CEILING_MS)), "stable")


def _default_expect(step: Dict[str, Any]) -> Dict[str, Any]:
    """Attente par défaut quand un pas n'en porte pas (scénario ancien / non
    annoté) : on attend seulement la STABILITÉ — « pas d'effet » ne casse jamais."""
    return {"kind": "stable"}


def _act_kwargs(args: Dict[str, Any]) -> Dict[str, Any]:
    args = args or {}
    return {k: args[k] for k in _ACT_ARG_KEYS if k in args and args[k] not in (None, "")}


def step_label(step: Dict[str, Any]) -> str:
    op = (step.get("op") or "?")
    a = step.get("anchor") or {}
    who = a.get("label") or a.get("query") or (("#" + str(a["id"])) if a.get("id") else None)
    if not who and a.get("x") is not None:
        who = "(%s,%s)" % (a.get("x"), a.get("y"))
    args = step.get("args") or {}
    if op in ("type", "paste") and args.get("text"):
        return "%s « %s »" % (op, args["text"])
    if op == "key" and args.get("keys"):
        return "key %s" % args["keys"]
    return op + ((" « %s »" % who) if who else "")


def _center(el: Optional[Dict[str, Any]]) -> Optional[Tuple[int, int]]:
    if not el:
        return None
    c = el.get("center") or []
    if len(c) >= 2:
        return (int(c[0]), int(c[1]))
    return None


def _anchor_point(anchor: Dict[str, Any]) -> Optional[Tuple[int, int]]:
    """Coords ENREGISTRÉES d'une ancre (repli sans sonde) : x/y explicites, sinon
    le centre de la box capturée (via ``_center``). ``None`` si aucune."""
    anchor = anchor or {}
    if anchor.get("x") is not None and anchor.get("y") is not None:
        try:
            return (int(anchor["x"]), int(anchor["y"]))
        except (TypeError, ValueError):
            pass
    return _center(anchor)


def _resolve_anchor(username: str, target: str, anchor: Dict[str, Any],
                    self_heal: bool = True) -> Tuple[Optional[Tuple[int, int]], bool, Optional[str]]:
    """Retrouve le point (x,y) où agir pour cette ancre, au rejeu.

    Retourne ``(point|None, healed, error|None)``."""
    anchor = anchor or {}
    aid = anchor.get("auto_id")
    label = anchor.get("label") or anchor.get("query")
    role = anchor.get("role")
    near = None
    if anchor.get("x") is not None and anchor.get("y") is not None:
        near = (float(anchor["x"]), float(anchor["y"]))   # point explicite → départage
    else:
        # Les ancres ÉLÉMENT (cas typique : pas ancré par label + box) ne portent
        # PAS x/y — seulement ``center``/``box`` (cf. _scenario_model.ANCHOR_FIELDS).
        # Sans ça, ``near`` restait None → le scoring de proximité de _pick_best ne
        # jouait jamais → retombée sur le « premier match » (ex. « Save As » au
        # lieu de « Save » quand deux libellés matchent). On dérive donc le point.
        c = anchor.get("center")
        if isinstance(c, (list, tuple)) and len(c) >= 2:
            try:
                near = (float(c[0]), float(c[1]))
            except Exception:
                near = None
        if near is None:
            b = anchor.get("box")
            if isinstance(b, (list, tuple)) and len(b) >= 4:
                try:
                    near = ((float(b[0]) + float(b[2])) / 2.0,
                            (float(b[1]) + float(b[3])) / 2.0)
                except Exception:
                    near = None

    if aid or label:
        # 1) déterministe : a11y rapide (pas de vision) → match par auto_id (le
        #    plus stable) puis par label.
        obs = probe_tree_core(username, target)
        if not (isinstance(obs, dict) and obs.get("ok") is False):
            pt = _center(resolve_element(username, target, auto_id=(aid or None),
                                         query=(label or None), near=near, role=role))
            if pt:
                return (pt, False, None)
        # 2) auto-réparation : 1 passe vision avec le label comme grounding (bornée par run, C2).
        if self_heal and label and _self_heal_allow(target):
            obs2 = observe_core(username, target, prompt=str(label), use_vision=True, use_tree=True)
            if not (isinstance(obs2, dict) and obs2.get("ok") is False):
                pt = _center(resolve_element(username, target, auto_id=(aid or None),
                                             query=(label or None), near=near, role=role))
                if pt:
                    return (pt, True, None)

    # 3) repli sur les coordonnées brutes enregistrées.
    if anchor.get("x") is not None and anchor.get("y") is not None:
        return ((int(anchor["x"]), int(anchor["y"])), False, None)

    # 4) dernier recours : l'id brut (rarement stable entre runs).
    if anchor.get("id"):
        obs = probe_tree_core(username, target)
        if not (isinstance(obs, dict) and obs.get("ok") is False):
            pt = _center(resolve_element(username, target, element_id=str(anchor["id"])))
            if pt:
                return (pt, False, None)

    # R7 — « no silent cap » : si une ancre à label reste introuvable ET que la
    # passe self-heal a été REFUSÉE faute de budget, le dire dans l'erreur du pas.
    if label and _self_heal_denied(target):
        return (None, False, "anchor_unresolved (budget self-heal épuisé)")
    return (None, False, "anchor_unresolved")


# ── Politique d'échec par pas (retry + continue/abort) ────────────────────────
def _step_retry(step: Dict[str, Any]) -> int:
    """Nombre de RÉ-essais d'un pas (0 = une seule tentative). Borné _MAX_RETRY."""
    try:
        return max(0, min(_MAX_RETRY, int(step.get("retry", 0) or 0)))
    except (TypeError, ValueError):
        return 0


def _step_on_error(step: Dict[str, Any], default: str) -> str:
    """Politique d'un pas en échec : ``continue`` (enchaîner) ou ``abort`` (stopper
    le scénario, pas suivants ``skipped``). Repli sur ``default``."""
    v = str(step.get("on_error") or "").strip().lower()
    return v if v in ("continue", "abort") else default


def run_step_once(username: str, target: str, step: Dict[str, Any], *,
                  self_heal: bool = True) -> Dict[str, Any]:
    """Exécute UNE tentative d'un pas : (ré)ancrage → action → vérification de
    l'attente. Pur (aucune persistance). Retourne
    ``{status, healed, error, frame_token, waited_ms, expect}``."""
    op = (step.get("op") or "").strip().lower()
    anchor = step.get("anchor") or {}
    args = step.get("args") or {}
    timeout_ms = _clamp_timeout(step.get("timeout_ms", step.get("timeoutMs")))
    expect = step.get("expect") or _default_expect(step)

    aid = str((anchor or {}).get("auto_id") or "").strip()
    uia_click = aid and op in ("click", "left_click", "double_click")
    point: Optional[Tuple[int, int]] = None
    healed = False
    if op in _POINT_OPS:
        if uia_click:
            # P1-é2 : clic ancré auto_id → l'agent INVOQUE le contrôle par son id
            # (déterministe, robuste aux déplacements). Le point n'est qu'un repli :
            # inutile de SONDER l'arbre pour le résoudre (économise une sonde/pas) —
            # on passe les coords ENREGISTRÉES. Si l'invoke échoue côté agent, la
            # boucle de retry du pas repassera par le chemin résolu.
            point = _anchor_point(anchor)
        else:
            point, healed, err = _resolve_anchor(username, target, anchor, self_heal=self_heal)
            if point is None:
                return {"status": "failed", "healed": healed, "error": err or "anchor_unresolved",
                        "frame_token": None, "waited_ms": 0, "expect": ""}

    # « appear » : photographier les éléments AVANT l'action (détecte ceux qui
    # apparaissent ensuite : nouvelle fenêtre…).
    _baseline = None
    if (expect or {}).get("kind") == "appear":
        try:
            _baseline = _observe_keys(username, target)
        except Exception:  # pragma: no cover
            _baseline = set()

    if op == "launch":
        # Synchro fiable (WaitForInputIdle côté agent) avant d'enchaîner.
        app = str((args or {}).get("app") or (args or {}).get("target") or "")
        try:
            res = launch_core(username, target, app=app, timeout_ms=timeout_ms)
        except Exception as e:  # pragma: no cover
            res = {"ok": False, "error": "exception", "message": str(e)[:200]}
    else:
        kw = _act_kwargs(args)
        kw["op"] = op
        if point is not None:
            kw["x"], kw["y"] = point[0], point[1]
        # UIA-first : clic sur une ancre auto_id → on INVOQUE le contrôle
        # (déterministe, robuste aux déplacements) ; coords = repli.
        if uia_click:
            kw["op"] = "invoke"
            kw["auto_id"] = aid
            kw["name"] = (anchor.get("label") or anchor.get("query") or "")
            kw["control_type"] = anchor.get("role") or ""
            if op == "double_click":
                kw["clicks"] = 2
        elif op in _SEMANTIC_REPLAY_OPS:
            # Ops sémantiques (toggle/select/expand/set_value/invoke…) : pas de
            # point ; l'agent re-résout par auto_id (live). On thread l'ancre, et
            # on observe (a11y) pour qu'act_core résolve AUSSI par libellé quand
            # l'ancre n'a pas d'auto_id (élément retrouvé dans le cache du run).
            if aid:
                kw["auto_id"] = aid
            lbl = anchor.get("label") or anchor.get("query") or ""
            if lbl:
                kw["name"] = lbl
                kw["query"] = lbl
            ct = anchor.get("role") or ""
            if ct:
                kw["control_type"] = ct
            try:
                probe_tree_core(username, target)
            except Exception:  # pragma: no cover
                pass
        try:
            # C3 — pour type/paste, semantic_click n'enclenche QUE la garde « type
            # sans effet » (T-FX) : si la frappe ne change pas l'écran (focus non
            # posé / fenêtre en arrière-plan), le pas ÉCHOUE au lieu d'un faux succès.
            # Pas de désambiguïsation (elle exige une query, absente pour type/paste).
            res = act_core(username, target,
                           semantic_click=(op in ("type", "paste")), **kw)
        except Exception as e:  # pragma: no cover
            res = {"ok": False, "error": "exception", "message": str(e)[:200]}
    ok = isinstance(res, dict) and res.get("ok") is not False
    frame_token = (res or {}).get("frame_token")
    if not ok:
        return {"status": "failed", "healed": healed,
                "error": (res or {}).get("error") or "act_failed",
                "frame_token": frame_token, "waited_ms": 0, "expect": ""}

    # Action réussie → ATTENDRE que l'événement attendu se réalise (vérif fiable),
    # borné par le timeout du pas (on tolère ainsi une app lente).
    try:
        exp_ok, waited_ms, expect_detail = check_expect(
            username, target, expect, timeout_ms, baseline=_baseline)
    except Exception:  # pragma: no cover
        exp_ok, waited_ms, expect_detail = True, 0, "expect_error"
    if not exp_ok:
        return {"status": "failed", "healed": healed,
                "error": "expect_timeout: %s" % expect_detail,
                "frame_token": frame_token, "waited_ms": waited_ms, "expect": expect_detail}
    return {"status": "passed", "healed": healed, "error": None,
            "frame_token": frame_token, "waited_ms": waited_ms, "expect": expect_detail}


def _skipped_record(i: int, step: Dict[str, Any]) -> Dict[str, Any]:
    return {"step_index": i, "op": (step.get("op") or "").strip().lower(),
            "label": step_label(step), "status": "skipped", "healed": False,
            "error": None, "frame_token": None, "duration_ms": 0, "waited_ms": 0,
            "expect": "", "attempts": 0}


def replay_scenario(steps: List[Dict[str, Any]], username: str, target: str, *,
                    on_step: Optional[Callable[[Dict[str, Any]], None]] = None,
                    self_heal: bool = True, from_step: int = 0,
                    default_on_error: str = "continue",
                    should_abort: Optional[Callable[[], bool]] = None) -> Dict[str, Any]:
    """Exécute les pas en séquence avec RETRY (``step.retry``) et politique d'échec
    (``step.on_error`` ∈ continue|abort, repli ``default_on_error``).

    • ``from_step`` : démarre au pas N (reprise après échec / dry-run) — les pas
      précédents comptent comme ``skipped``.
    • ``abort`` : au premier échec non rattrapé, on STOPPE et les pas restants
      sont marqués ``skipped`` (ni cascade ni gaspillage de temps).

    Retourne ``{total, passed, failed, skipped, from_step, aborted,
    results:[{step_index, op, label, status, healed, error, frame_token,
    duration_ms, waited_ms, expect, attempts}]}``. ``on_step`` est appelé après
    CHAQUE pas exécuté ou sauté (persistance/streaming incrémental)."""
    steps = list(steps or [])
    total = len(steps)
    try:
        start = max(0, int(from_step or 0))
    except (TypeError, ValueError):
        start = 0

    results: List[Dict[str, Any]] = []
    passed = failed = 0
    skipped = min(start, total)            # pas avant la reprise = sautés (non rejoués)
    aborted = False
    cancelled = False                      # arrêt DEMANDÉ par l'utilisateur (≠ abort on_error)

    def _emit(rec: Dict[str, Any]) -> None:
        results.append(rec)
        if on_step:
            try:
                on_step(rec)
            except Exception:
                logger.debug("[replay] on_step a levé (ignoré)", exc_info=True)

    # C2 — borne la self-heal vision sur CE run ; le finally GARANTIT le nettoyage
    # (sinon une entrée fantôme caperait à tort le chemin live desktop_wait).
    _self_heal_begin(target)
    _set_abort_check(should_abort)         # « Arrêter » : lu entre les pas ET dans les attentes
    try:
        for i in range(start, total):
            step = steps[i]
            # Annulation (un pas précédent a demandé l'abort, OU arrêt utilisateur
            # demandé entre deux pas) → les pas restants sont marqués sautés.
            _stop = bool(should_abort and should_abort())   # appelé UNE fois / pas
            if aborted or _stop:
                if _stop and not aborted:
                    cancelled = True
                aborted = True
                skipped += 1
                _emit(_skipped_record(i, step))
                continue

            # AUDIT 2026-08-30 (S8) — monotonic : ne sert qu'au duration_ms.
            t0 = time.monotonic()
            retry = _step_retry(step)
            attempts = 0
            out: Dict[str, Any] = {"status": "failed", "healed": False, "error": "not_run",
                                   "frame_token": None, "waited_ms": 0, "expect": ""}
            try:
                for attempt in range(retry + 1):
                    attempts += 1
                    out = run_step_once(username, target, step, self_heal=self_heal)
                    if out.get("status") == "passed":
                        break
                    if attempt < retry:            # backoff croissant avant le ré-essai
                        _sleep_ms(_RETRY_BACKOFF_MS * (attempt + 1))
            except ReplayAborted:
                # Arrêt demandé PENDANT une attente → ce pas est annulé, on stoppe.
                cancelled = True
                aborted = True
                skipped += 1
                _emit(_skipped_record(i, step))
                continue

            status = out.get("status") or "failed"
            if status == "passed":
                passed += 1
            else:
                failed += 1
            _emit({
                "step_index": i, "op": (step.get("op") or "").strip().lower(),
                "label": step_label(step), "status": status, "healed": bool(out.get("healed")),
                "error": out.get("error"), "frame_token": out.get("frame_token"),
                "duration_ms": int((time.monotonic() - t0) * 1000),
                "waited_ms": int(out.get("waited_ms") or 0), "expect": out.get("expect") or "",
                "attempts": attempts,
            })
            if status == "failed" and _step_on_error(step, default_on_error) == "abort":
                aborted = True
    finally:
        heal_exhausted = _self_heal_end(target)
        _clear_abort_check()

    healed = sum(1 for r in results if r.get("healed"))
    return {"total": total, "passed": passed, "failed": failed, "skipped": skipped,
            "from_step": start, "aborted": aborted, "cancelled": cancelled,
            "healed": healed, "heal_budget_exhausted": heal_exhausted,
            "results": results}
