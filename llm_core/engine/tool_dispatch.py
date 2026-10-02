# SPDX-License-Identifier: MIT
"""llm_core.engine.tool_dispatch — exécution des appels d'outils de la boucle.

Un tour LLM qui appelle des outils passe par ce module, quel que soit son
canal : ``tool_calls`` natifs de l'API, ou appels écrits en texte par un
modèle sans canal natif.

  * ``open_native_round`` / ``open_text_round`` — préparation d'un lot :
    message assistant du tour, identifiants d'appel, arguments décodés,
    identité du propriétaire hors des arguments (``_build_call_meta``) ;
  * ``classify_text_reply`` et ``relaunch_unparsed_call`` — l'étape entre les
    deux canaux : lecture des appels écrits en texte, purge d'un appel vers un
    outil inconnu, relances bornées d'un appel illisible ou perdu ;
  * ``run_tool_batch`` — le noyau commun : annulation, événements
    ``tool_call``, exécution du lot (``engine.tool_exec``, série ou
    parallèle), post-traitement dans l'ordre du modèle, anti-boucle ;
  * ``ChannelSpec`` (``NATIF``, ``TEXTE``) — ce qui diffère volontairement
    entre les canaux ;
  * ``TruncationGuard`` et ``CycleGuard`` — appels coupés par la limite de
    génération et actions de bureau rejouées sans effet ;
  * un appel isolé (``_execute_single_tool_call``) : serveur MCP ou outil
    intégré, borne de durée propre à l'outil, file d'attente du pool,
    décodage du résultat (``pick_tool_payload``), enrichissement des
    événements ``tool_result`` et métriques ``tool_call_metrics``.

Les compteurs d'itérations restent à l'orchestrateur
(``llm_core._chat_with_tools``) : ce module rend des issues
(``BatchOutcome``, cause d'arrêt) qu'il applique. La boucle injecte
``_record_tool_call_metric_safe`` dans le lot depuis SES globales
(``LoopDeps.record_metric``) : c'est le point de substitution des goldens. Le
pool MCP est lu à l'appel via son module propriétaire
(``_mcp_pool.mcp_pool``).
"""
from __future__ import annotations

import asyncio
import functools
import json
import logging
import os
import re
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Literal, Optional, Tuple

from llm_core import _mcp_pool, _tool_parsing
from llm_core._chat_classic import _dump
from llm_core._constants import LLAMA_TOOL_TIMEOUT_S
from llm_core._desktop_session import (
    _extract_desktop_frame,
    desktop_frame_path,
    register_desktop_frame_owner,
)
from llm_core._mcp_pool import MCPQueueSaturated
from llm_core._mcp_wrappers import _resolve_mcp_client
from llm_core._pw_session import (
    _extract_pw_screenshot_url,
    _pw_verb_of,
    _track_pw_session_ownership,
)
from llm_core._scheduling._guard import _emit
from llm_core._tool_parsing import (
    _TOOL_MARKUP_TRACE_RE,
    _looks_like_pure_tool_call_text,
    _strip_tool_call_markup,
    extract_tool_calls,
)
from llm_core._vision import _get_last_screenshot_b64, _track_last_screenshot_for_vision
from llm_core.context.pruning import (
    ephemeral as _ephemeral_msg,
    prepare_tool_result_for_model as _prepare_tool_result_for_model,
    prune_old_vision_frames as _prune_old_vision_frames,
)
from llm_core.engine.live_text import LiveText
from llm_core.engine.result_contract import result_is_tool_failure
from llm_core.engine.run import LoopDeps, RunContext, RunRecord
from llm_core.engine.tool_exec import execute_tool_batch as _execute_tool_batch
from shared_infra import config as _bk_config
from shared_infra.config import LLAMA_MODEL
from shared_infra.observability.tracing import swallow

logger = logging.getLogger("uvicorn.error")


# Studio : un ``desktop_act`` du chat renvoie l'écran APRÈS l'action (sig + éléments).
# ``result`` est coupé à 2000 caractères pour le panneau : le JSON y est invalide
# dès qu'il y a des éléments, et l'enregistreur du Studio perdrait la signature (effet
# visible) et les éléments apparus (attente nommée composée). On les joint à part,
# allégés et bornés.
_DESKTOP_EVENT_KEYS = ("id", "label", "role", "auto_id", "box", "center", "depth", "unnamed",
                       "source", "states", "patterns", "label_source")


def _desktop_event_extra(tool_name, raw, with_elements=True):
    """``sig`` + éléments allégés d'un desktop_act/observe, hors de la coupe à 2000
    caractères de ``result``. Les éléments ne servent qu'à l'enregistreur du Studio
    (mini-chat ``studio_…``) : le chat principal (``with_elements=False``) n'en
    garde que ``sig`` — sinon jusqu'à 600 éléments (~100 Ko) par action, en double
    de l'event ``annotation_frame``."""
    if (tool_name or "") not in ("desktop_act", "desktop_observe"):
        return None
    try:
        obj = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError):
        return None
    if not isinstance(obj, dict):
        return None
    out = {}
    if obj.get("sig"):
        out["sig"] = str(obj["sig"])
    els = obj.get("elements") if with_elements else None
    if isinstance(els, list):
        out["elements"] = [{k: e[k] for k in _DESKTOP_EVENT_KEYS if isinstance(e, dict) and k in e}
                           for e in els[:600] if isinstance(e, dict)]
    return out or None


def _populate_desktop_frame(_evt, tool_name, tool_args, result_str, username,
                            model_has_vision, chat_key):
    """Desktop (computer-use) counterpart of the ``pw_*`` screenshot enrichment.

    If a ``desktop_*`` tool result carries a ``frame_token``: stamp the
    ``screenshot_*`` fields onto ``_evt`` (so the chat panel shows the frame
    inline like Playwright), register frame ownership for ``/api/desktop/frame``,
    track the saved frame for vision injection, and RETURN a dedicated
    ``annotation_frame`` event dict (or ``None``) for the caller to emit to the
    Annotation Studio. Best-effort — never raises."""
    try:
        _df = _extract_desktop_frame(tool_name, tool_args, result_str)
    except Exception:  # noqa: BLE001 — trame illisible : pas d'enrichissement
        _df = None
    if not _df:
        return None
    _evt["screenshot_url"] = _df["url"]
    _evt["screenshot_step"] = _df["step"]
    _evt["screenshot_session"] = _df["session_id"]
    with swallow("harness.populate_desktop_frame"):
        register_desktop_frame_owner(_df["token"], username)
    _ret: Dict[str, Any] = {
        "type": "annotation_frame",
        "image_url": _df["url"],
        "img_w": _df["img_w"],
        "img_h": _df["img_h"],
        "boxes": _df["boxes"],
        "target": _df["session_id"],
        "sig": _df.get("sig") or "",
        "ts": int(time.time() * 1000),
    }
    if model_has_vision:
        with swallow("harness.populate_desktop_frame.2"):
            _dpath = desktop_frame_path(_df["token"])
            if os.path.exists(_dpath):
                # Le décodage/rééchantillonnage Pillow (30-120 ms de CPU par
                # frame) ne se fait pas ICI, sur la boucle : l'appelant le
                # déporte en thread depuis cette clé PRIVÉE, retirée avant
                # l'émission de l'event.
                _ret["_vision_track"] = (chat_key, _dpath)
    return _ret


def _truthy_arg(v) -> bool:
    if isinstance(v, str):
        return v.strip().lower() in ("1", "true", "yes", "on")
    return bool(v)


_SHA_RE = re.compile(r"^[0-9a-f]{64}$")


def _files_event_extra(result_str) -> Dict[str, Any]:
    """``{"files": [...]}`` pour l'event ``tool_result`` (vide sinon)."""
    try:
        res = json.loads(result_str) if isinstance(result_str, str) else result_str
        files = _changed_files_of(res)
        return {"files": files} if files else {}
    except Exception:                                           # noqa: BLE001 — enrichissement facultatif de l'événement
        return {}


def _noter_attente(ms: int) -> None:
    """Attente d'un créneau du moteur → exécution courante (``runs``)."""
    try:
        from shared_infra.observability.runs import current_run
        run = current_run()
        if run is not None:
            run.add_wait(ms)
    except Exception:                                           # noqa: BLE001 — comptage best-effort
        pass


def _noter_fichiers(files) -> None:
    """Fichiers modifiés par un outil → exécution courante (``runs``)."""
    if not files:
        return
    try:
        from shared_infra.observability.runs import current_run
        run = current_run()
        if run is not None:
            run.add_files(files)
    except Exception:                                           # noqa: BLE001 — comptage best-effort
        logger.debug("[runs] fichiers modifiés non comptés", exc_info=True)


def _changed_files_of(res) -> List[Dict[str, Any]]:
    """Fichiers modifiés décrits par le résultat d'un outil, au format
    compact de l'event ``tool_result`` : ``{path, change, before, after,
    added?, removed?, from?}`` (``before``/``after`` : empreinte sha256 d'une
    version de l'historique de session, ``None`` si absente ou non gardée).
    Au plus 50 entrées."""
    if not isinstance(res, dict) or res.get("ok") is False or res.get("error") \
            or res.get("dry_run"):
        return []

    def _sha(v):
        return v if isinstance(v, str) and _SHA_RE.match(v) else None

    def _one(d, change=None):
        path = d.get("path")
        if not isinstance(path, str) or not path:
            return None
        e: Dict[str, Any] = {"path": path[:1024],
                             "change": str(change or d.get("change") or "modified")[:16],
                             "before": _sha(d.get("old_sha256")),
                             "after": _sha(d.get("new_sha256"))}
        for k_src, k_dst in (("lines_added", "added"), ("lines_removed", "removed")):
            if isinstance(d.get(k_src), int):
                e[k_dst] = d[k_src]
        if isinstance(d.get("from"), str):
            e["from"] = d["from"][:1024]
        return e

    out: List[Dict[str, Any]] = []
    fc = res.get("files_changed")
    if isinstance(fc, list):
        for d in fc[:50]:
            if isinstance(d, dict):
                e = _one(d)
                if e:
                    out.append(e)
        return out
    # write_file / edit_file : un seul fichier, décrit à plat. Un no-op
    # (contenu identique) n'est pas une modification.
    if res.get("unchanged") or res.get("action") == "noop":
        return []
    if _sha(res.get("new_sha256")) and isinstance(res.get("path"), str):
        e = _one(res, "created" if res.get("old_sha256") == "" else "modified")
        if e:
            out.append(e)
    return out


def _write_event_extra(tool_name, final_args, result_str) -> Dict[str, Any]:
    """Champs ajoutés au ``tool_result`` d'un outil d'écriture pour l'éditeur.

    - ``path`` : chemin du fichier muté. Pour ``git_write`` le ``path`` est
      relatif au DÉPÔT : on le rejoint à ``repo`` pour obtenir le chemin
      relatif à la sandbox (``repo/path``), sinon le front lirait un homonyme
      à la racine (ou prendrait des 404).
    - ``dry_run`` : présent (True) quand l'appel est un essai à blanc, pour
      que le front n'applique rien au tampon.
    - ``sha256`` : hash du contenu FINAL renvoyé par l'outil (base de
      comparaison exacte côté front, plutôt qu'un mtime relu après coup).
    - ``files`` : fichiers modifiés, pour TOUT outil qui en
      décrit (``files_changed`` du shell, des scripts de skill, de git, de
      ``manage_files`` ; ``path`` + empreintes d'un write/edit). Chaque
      entrée porte les empreintes des versions avant / après gardées dans
      l'historique de session : le chat relit ces versions pour afficher le
      diff, que le fichier soit ouvert dans l'éditeur ou non.
    Ne lève jamais ; ``{}`` si l'outil n'est pas une écriture."""
    out: Dict[str, Any] = {}
    try:
        _res_any = json.loads(result_str) if isinstance(result_str, str) else result_str
    except (ValueError, TypeError):
        _res_any = None
    out.update(_files_event_extra(_res_any))
    try:
        if not isinstance(final_args, dict):
            return out
        _tn_l = (tool_name or "").lower()
        if not ("write" in _tn_l or "edit" in _tn_l or "save" in _tn_l):
            return out
        _wp = final_args.get("path") or final_args.get("filename")
        if not _wp or not isinstance(_wp, str):
            return out
        if _tn_l.endswith("git_write"):
            import posixpath as _pp
            _repo = str(final_args.get("repo") or "").strip().replace("\\", "/")
            for _pref in ("/work/", "work/"):
                if _repo.startswith(_pref):
                    _repo = _repo[len(_pref):]
                    break
            if _repo in ("/work", "work"):
                _repo = ""
            _rel = _wp.strip().replace("\\", "/").lstrip("/")
            _joined = _pp.normpath(_pp.join(_repo.strip("/"), _rel)) if _repo.strip("/") else _pp.normpath(_rel)
            if _joined in (".", "") or _joined.startswith(".."):
                return out
            _wp = _joined
        out["path"] = _wp
        if _truthy_arg(final_args.get("dry_run")):
            out["dry_run"] = True
            return out
        _res = _res_any
        if isinstance(_res, dict) and _res.get("ok") is not False and not _res.get("error"):
            _sha = (_res.get("next_expected_sha256") or _res.get("new_sha256")
                    or _res.get("sha256"))
            if isinstance(_sha, str) and len(_sha) == 64:
                out["sha256"] = _sha
    except Exception:                                           # noqa: BLE001 — enrichissement facultatif de l'événement
        pass
    return out


def _content_block_text(item: Any) -> str:
    """Rendu TEXTE d'un bloc de contenu MCP non textuel.

    - ressource embarquée TEXTE → son texte ;
    - image / audio / ressource binaire → un repère court (type MIME,
      taille), jamais la charge base64 ;
    - lien de ressource → son URI."""
    _typ = type(item).__name__
    res = getattr(item, "resource", None)
    if res is not None:
        _uri: Any = str(getattr(res, "uri", "") or "")
        _txt = getattr(res, "text", None)
        if isinstance(_txt, str):
            return f"[resource {_uri}]\n{_txt}" if _uri else _txt
        _blob = getattr(res, "blob", None) or ""
        _mime = getattr(res, "mimeType", None) or "application/octet-stream"
        return (f"[binary resource {_uri} ({_mime}, "
                f"~{len(_blob) * 3 // 4 // 1024} KB) — not shown]")
    _data = getattr(item, "data", None)
    if isinstance(_data, str):
        _mime = getattr(item, "mimeType", None) or "?"
        _kind = "image" if _typ.startswith("Image") else (
            "audio" if _typ.startswith("Audio") else "binary")
        return f"[{_kind} {_mime}, ~{len(_data) * 3 // 4 // 1024} KB — not shown]"
    _uri = getattr(item, "uri", None)
    if _uri:
        return f"[resource link: {_uri}]"
    return f"[non-text content block: {_typ}]"


def pick_tool_payload(tool_result: Any) -> Any:
    # Erreur signalée par le PROTOCOLE (CallToolResult.isError=True) — c'est
    # notamment la forme que prend une erreur de VALIDATION pydantic des
    # arguments (FastMCP la re-lève, le SDK bas niveau la convertit en
    # isError). Rendu comme un payload ORDINAIRE, ce texte serait classé succès
    # par result_contract (string non-dict) : il brûlerait le budget
    # d'itérations productives et le modèle ne verrait jamais d'échec explicite.
    if getattr(tool_result, "isError", False):
        _txt_parts: list = []
        for _item in (getattr(tool_result, "content", None) or []):
            if hasattr(_item, "text"):
                _txt_parts.append(str(_item.text))
        _txt = "\n\n".join(_txt_parts).strip() or "erreur outil (MCP isError)"
        try:
            _parsed = json.loads(_txt)
        except Exception:  # noqa: BLE001 — texte non JSON : gardé tel quel
            _parsed = None
        # Enveloppe d'erreur déjà structurée (``{"ok": false, …}`` du
        # middleware local OkFalseAsIsError) : conservée telle quelle.
        # ``ok: False`` est POSÉ : ``result_is_error`` ne reconnaît sinon
        # qu'un ``{"error"}`` seul, et ``{"error": "Not Found", "status": 404}``
        # d'un serveur externe passerait pour un succès.
        if isinstance(_parsed, dict) and (_parsed.get("ok") is False
                                          or "error" in _parsed):
            return {**_parsed, "ok": False}
        return {"ok": False, "error": _txt[:2000]}
    if hasattr(tool_result, "content"):
        c = tool_result.content
        if isinstance(c, list) and len(c) > 0:
            if len(c) == 1:
                item = c[0]
                if hasattr(item, "text"):
                    try:
                        return json.loads(item.text)
                    except Exception:  # noqa: BLE001 — texte non JSON : rendu tel quel
                        return item.text
                # Jamais ``str(item)`` : c'est le repr pydantic du bloc, base64
                # COMPRIS — une capture PNG de 300 Ko deviendrait 400 000
                # caractères de contexte, persistés dans tool_history.
                return _content_block_text(item)
            # Multi-blocs (serveurs MCP externes : texte+texte, texte+image…) :
            # aucun bloc n'est perdu. On concatène les blocs texte et on marque
            # les blocs non-texte — pas de json.loads global (la concaténation
            # n'est pas un JSON).
            parts: list = []
            for item in c:
                if hasattr(item, "text"):
                    parts.append(str(item.text))
                else:
                    parts.append(_content_block_text(item))
            return "\n\n".join(parts)
        # ``content`` vide mais ``structuredContent`` fourni (outil à
        # ``outputSchema`` : le texte n'est qu'un « SHOULD » de la spec MCP) :
        # c'est LUI le résultat — sinon le modèle recevrait « [] » et
        # conclurait à l'absence de données.
        _sc = getattr(tool_result, "structuredContent", None)
        if _sc is not None and not c:
            return _sc
        return c
    return _dump(tool_result)


# Tools in a hidden category (e.g. `todowrite` in the `task` category) are
# model-side aids — registered and callable, but not user-facing. The chat
# stream tags their tool_call / tool_result events with ``internal: True``
# so the frontend can suppress them from the visible tool-activity panel.
def _tool_is_internal(tool_name: str) -> bool:
    if not tool_name:
        return False
    try:
        from llm_core._mcp_categories import categorize, is_hidden
        return is_hidden(categorize(tool_name))
    except Exception:  # noqa: BLE001 — catégorie illisible : outil visible
        return False


# ── tool_call_metrics (observabilité) ────────────────────────────────────────
# Seul écrivain de la table ``tool_call_metrics``, que lisent l'onglet admin
# Observabilité, l'onglet Utilisation (/api/usage/me) et les widgets du
# tableau de bord : la boucle outils du chatbot (les deux chemins, natif et
# texte) l'alimente ici.
# Cache username→user_id : la table exige un user_id int alors que cette
# couche ne reçoit que ``username`` (résolution 1 fois par user et par vie
# du process, mêmes données que la session).
_TCM_UID_CACHE: Dict[str, int] = {}


def _record_tool_call_metric_safe(username: str,
                                  chat_id: Optional[str],
                                  tool_name: str,
                                  status: str,
                                  duration_ms: int,
                                  error_short: Optional[str] = None,
                                  **mesures: Any) -> None:
    """Écrit une ligne tool_call_metrics — best-effort, jamais bloquant.

    Rattachée à l'exécution courante (``runs`` ; l'appel y est compté par
    ``tool_exec``, dans la boucle), sinon à la conversation ; ``mesures`` :
    ``call_id``, ``started_at``, ``exit_code``, ``args_bytes``,
    ``result_bytes``."""
    try:
        from llm_core._mcp_categories import categorize
        from shared_infra.observability.runs import current_run
        category = categorize(tool_name)
        run = current_run()
        uid = _TCM_UID_CACHE.get(username)
        if uid is None:
            from shared_infra.accounts.users import get_user
            row = get_user(username)
            if not row:
                return
            uid = int(row["id"])
            _TCM_UID_CACHE[username] = uid
        from shared_infra.observability.tool_metrics_store import record_tool_call_metric
        record_tool_call_metric(
            run_id=run.id if run is not None else str(chat_id or "chat"),
            user_id=uid,
            tool_name=tool_name,
            status=status,
            duration_ms=int(duration_ms),
            error_short=error_short,
            category=category,
            **mesures,
        )
    except Exception:  # noqa: BLE001 — métrique best-effort, jamais bloquante
        logger.debug("[tool_call_metrics] record failed (non-fatal)", exc_info=True)


# ── Détection de cycle d'actions (anti-boucle desktop) ──────────────────────
_CYCLE_ARG_KEYS = ("op", "id", "element_id", "query", "label", "text", "keys", "x", "y", "button")


def _action_cycle_signature(tool_name: str, tool_args: Any, frame_sig: str) -> str:
    """Signature compacte d'une action desktop pour la détection de boucle :
    ``outil | clé-d'arguments stable | dHash de l'écran résultant``. Inclure le
    ``frame_sig`` garantit qu'une répétition qui FAIT avancer l'UI (sig différent)
    n'est PAS comptée comme un cycle — seul le « je clique et rien ne bouge »
    déclenche."""
    args = tool_args if isinstance(tool_args, dict) else {}
    parts = [f"{k}={args[k]}" for k in _CYCLE_ARG_KEYS if args.get(k) not in (None, "")]
    return "%s|%s|%s" % (tool_name or "", ",".join(parts), frame_sig or "")


def _detect_action_cycle(buffer: List[str], signature: str,
                         *, threshold: int = 3, window: int = 6) -> bool:
    """Pousse ``signature`` dans le ring-buffer ``buffer`` (modifié en place,
    borné à ``window``) et renvoie True si la MÊME signature y apparaît au moins
    ``threshold`` fois — le modèle répète une action sans effet visible. Vide la
    fenêtre dès qu'un cycle est signalé pour ne nudger qu'une fois par série."""
    buffer.append(signature)
    if len(buffer) > window:
        del buffer[: len(buffer) - window]
    if signature and buffer.count(signature) >= threshold:
        buffer.clear()
        return True
    return False


# Au-delà de ce nombre de cycles CONFIRMÉS dans un même run, le nudge n'a
# manifestement pas suffi → on ARRÊTE les actions (hard-stop) au lieu de laisser
# un petit modèle brûler tout son budget d'itérations à rejouer.
_CYCLE_HARDSTOP_MAX = 2


# Tool calls coupés par finish=length N fois D'AFFILÉE ⇒ le contexte est
# saturé : chaque relance « compacte » ajoute 2 messages sans faire avancer
# effective_iter, la boucle spinnerait jusqu'au hard cap en AGGRAVANT la
# saturation. On sort proprement par le chemin tool-limit à la place.
_TRUNC_STREAK_MAX = 3


# Part de la fenêtre à partir de laquelle une coupe ``finish=length`` est lue
# « fenêtre pleine » (prompt + sortie ≈ n_ctx). En deçà, c'est le plafond de
# GÉNÉRATION (max_tokens) qui a tranché — un autre diagnostic, un autre geste.
_CTX_FULL_RATIO = 0.95


def _length_cut_is_ctx_full(usage: Optional[Dict[str, Any]],
                            ctx_size: Optional[int]) -> Optional[bool]:
    """``finish_reason == "length"`` : la fenêtre de contexte est-elle vraiment
    pleine ? ``True`` = prompt + complétion touchent n_ctx ; ``False`` = la
    coupe vient du plafond de sortie (la fenêtre a de la marge) ; ``None`` =
    indécidable (fenêtre inconnue ou usage absent).

    Les deux causes se présentent à l'identique côté API. Les lire toujours
    comme « contexte saturé » ferait annoncer une fenêtre pleine à 20 %
    d'occupation après trois écritures trop longues d'affilée, et l'UI
    proposerait de compacter une conversation qui n'en a pas besoin."""
    try:
        pt = int((usage or {}).get("prompt_tokens") or 0)
        ct = int((usage or {}).get("completion_tokens") or 0)
        n_ctx = int(ctx_size or 0)
    except (TypeError, ValueError):
        return None
    if n_ctx <= 0 or pt <= 0:
        return None
    return (pt + ct) >= int(n_ctx * _CTX_FULL_RATIO)


# Défauts PAR-OUTIL de la borne dure MCP quand le défaut global ne suffit pas.
# execute_shell accepte timeout_sec jusqu'à 600 s : la borne doit l'excéder,
# sinon une commande légitime de 600 s meurt en « timeout outil » à 300 s.
# Surchargeable à froid comme le reste.
# Borne d'attente en FILE (sémaphore d'entrée du pool) avant de rendre une
# erreur « file saturée » distincte du timeout d'exécution — cf. call_tool.
# Assez large pour absorber un pic, assez courte pour ne
# pas immobiliser un tour derrière 610 s de shells d'autres utilisateurs.
_TOOL_QUEUE_WAIT_S = 120.0


# REPLI seulement : la borne d'un outil voyage dans sa
# ``meta.policy.timeout_s`` (déclarée par le serveur, ingérée à la connexion —
# cf. ``_mcp_categories.tool_policy``). Ce dict ne sert qu'à un registre encore
# VIDE (worker froid) ou à un serveur externe homonyme : couper un shell
# légitime à la borne globale serait une régression réelle.
_TOOL_TIMEOUT_DEFAULTS = {
    "execute_shell": 610.0,
    "pw_wait": 330.0,
    "desktop_shell": 610.0,
}


def _tool_timeout_s(tool_name: str) -> float:
    """Timeout effectif pour UN outil : override par-outil à froid
    (context_config ``tools.<name>.timeout_s``), sinon ``meta.policy.timeout_s``
    déclarée par le serveur (protocole), sinon repli par nom
    (``_TOOL_TIMEOUT_DEFAULTS``), sinon défaut global ``LLAMA_TOOL_TIMEOUT_S``."""
    with swallow("harness.tool_timeout_s"):
        from llm_core.context_config import CTX as _CTX
        v = _CTX.tool_timeout_s(tool_name)
        if v > 0:
            return v
    # Le builtin ``task`` s'auto-borne à TASK_CHILD_TIMEOUT_S (>> le défaut
    # global) ; le wrapper doit lui laisser une marge, sinon on tuerait un
    # sous-agent LÉGITIME encore dans son budget.
    if tool_name == "task":
        return float(getattr(_bk_config, "TASK_CHILD_TIMEOUT_S", 1800)) + 60.0
    with swallow("harness.tool_timeout_policy"):
        from llm_core._mcp_categories import tool_policy as _tool_policy
        pv = _tool_policy(tool_name).get("timeout_s")
        if pv and float(pv) > 0:
            return float(pv)
    return float(_TOOL_TIMEOUT_DEFAULTS.get(tool_name, LLAMA_TOOL_TIMEOUT_S))


def _tool_timeout_json(tool_name: str, timeout_s: float) -> str:
    """Enveloppe d'erreur ``timeout`` (identique builtin/MCP) : une erreur d'outil
    ORDINAIRE que le modèle voit et à laquelle il s'adapte."""
    logger.warning("[tools] '%s' sans réponse après %.0fs — appel annulé (timeout)",
                   tool_name, timeout_s)
    # Le message ne dit PAS « annulé » : le client abandonne l'attente, mais
    # aucune annulation n'est envoyée au serveur, qui peut encore exécuter
    # l'outil (et appliquer son effet plus tard). Un modèle qui lirait
    # « annulé » relancerait aussitôt — deux effets concurrents.
    return json.dumps({
        "ok": False, "error": "timeout",
        "message": (f"L'outil '{tool_name}' n'a pas répondu en {int(timeout_s)}s — "
                    "attente abandonnée ; il peut encore s'exécuter côté serveur."),
        "fix": ("Vérifie l'état (fichier, dépôt, processus) avant de relancer ; "
                "puis relance une action plus ciblée/rapide, ou découpe le "
                "travail en étapes plus petites."),
    }, ensure_ascii=False)


async def _prefetch_desktop_frame(user_id: Optional[int], tool_name: str, result_str: Any) -> None:
    """Trame desktop d'un hôte DISTANT rapatriée avant ``_populate_desktop_frame``
    (qui lit le PNG sur ce disque pour la vision)."""
    if not user_id or not str(tool_name or "").startswith("desktop_"):
        return
    # Signature À TROIS arguments : un appel à un seul argument lèverait
    # TypeError, avalé ici, et la trame distante ne serait JAMAIS rapatriée.
    # Seules les erreurs de DONNÉES sont tues.
    try:
        _df = _extract_desktop_frame(tool_name, None, result_str)
        tok = (_df or {}).get("token") if isinstance(_df, dict) else None
    except (TypeError, ValueError):
        tok = None
    if not tok:
        return
    await _ensure_local_asset(int(user_id), desktop_frame_path(tok), f"/api/desktop/frame/{tok}")


async def _ensure_local_asset(user_id: Optional[int], local_path: str, relay_path: str) -> bool:
    """Un actif (capture navigateur, trame desktop) produit par un hôte
    d'outils DISTANT n'est pas sur ce disque : on le rapatrie par le relais
    (jeton de service + identité) à ``local_path`` pour que la suite (vision,
    Studio) lise le fichier comme un actif local. ``True`` si présent."""
    if local_path and os.path.exists(local_path):
        return True
    if not user_id or not relay_path:
        return False
    try:
        from shared_infra.sandbox.relay import fetch_relayed_bytes
        data = await fetch_relayed_bytes(int(user_id), relay_path)
    except Exception:                                            # noqa: BLE001 — actif distant indisponible
        data = None
    if not data:
        return False
    try:
        os.makedirs(os.path.dirname(local_path) or ".", exist_ok=True)
        await asyncio.to_thread(Path(local_path).write_bytes, data)
        return True
    except Exception:                                            # noqa: BLE001 — écriture locale impossible : actif absent
        return False


def _build_call_meta(*, is_local: bool, username: str, chat_id: Any,
                     live_shell: bool, call_id: Any, run_log_tok: str,
                     user_id: Optional[int] = None) -> Optional[Dict[str, Any]]:
    """``_meta`` d'un appel d'outil LOCAL — identité out-of-band (username,
    chat_id), ``live_shell`` (le shell streame sa sortie), ``call_id`` (le
    serveur le recopie dans ses notifications → chaque ligne à SON appel) et
    ``log_token`` (routage legacy). ``None`` pour un serveur externe : jamais
    l'identité d'un compte à un tiers (un seul point d'injection pour les
    deux canaux, natif et legacy)."""
    if not is_local:
        return None
    meta: Dict[str, Any] = {"username": username}
    if user_id:
        # Id numérique : un hôte d'outils DISTANT n'a pas la base des comptes
        # pour le retrouver (enveloppe d'identité).
        meta["user_id"] = str(int(user_id))
    if chat_id:
        meta["chat_id"] = str(chat_id)
    if live_shell:
        meta["live_shell"] = "1"
    meta["call_id"] = str(call_id)
    meta["log_token"] = f"{run_log_tok}:{call_id}"
    return meta


async def _execute_single_tool_call(
    tool_name: str,
    final_args: Dict[str, Any],
    tool_cfg_map: Dict[str, Dict],
    builtin_handlers: Dict[str, Callable],
    meta: Optional[Dict[str, Any]] = None,
    progress_callback: Optional[Callable] = None,
    log_callback: Optional[Callable] = None,
) -> str:
    """Dispatch one tool call to builtin handler or MCP pool. Returns JSON string.

    Every error path returns a JSON-encoded ``{"error": str}`` so the LLM can
    see the failure in its next turn. Never raises — that is by design, so a
    single bad tool never aborts the whole chat.

    ``meta`` est transmis comme MCP request meta out-of-band. Utilisé pour passer l'identité (username, chat_id) sans
    polluer ``final_args`` (donc sans leaker dans le schema vu par le LLM).
    Builtin handlers (non-MCP) ignorent ``meta`` — ils n'ont pas accès au
    transport MCP de toute façon.

    ``progress_callback`` reçoit les notifications de progression émises
    par le tool via ``ctx.report_progress()`` ; ``log_callback`` reçoit les
    ``ctx.info/warning/error()``. L'appelant les branche pour réémettre des
    événements ``tool_progress`` / ``tool_log`` consommés par le frontend.
    Builtin handlers ignorent ces callbacks (ils ne passent pas par le
    transport MCP).
    """
    if tool_name in builtin_handlers:
        try:
            _bto = _tool_timeout_s(tool_name)
            # L'APPEL du handler part en threadpool. Un handler SYNCHRONE
            # (outils RAG : httpx.Client, timeout 30 s — embedding + Qdrant +
            # rerank) exécuté INLINE sur la boucle gèlerait TOUS les flux du
            # worker pendant la requête, et HORS de la borne (_tool_timeout_s
            # ne couvre que les awaitables). Dans un thread : un handler async y CRÉE juste
            # sa coroutine (aucune exécution — awaitée plus bas, bornée), un
            # handler sync y fait son I/O, borné lui aussi. NB : un timeout
            # n'interrompt pas le thread (l'I/O s'achève en arrière-plan)
            # mais la boucle et le tour sont libérés immédiatement.
            _bt0 = time.monotonic()
            try:
                bh = await asyncio.wait_for(
                    asyncio.to_thread(builtin_handlers[tool_name], final_args),
                    timeout=_bto)
            except asyncio.TimeoutError:
                return _tool_timeout_json(tool_name, _bto)
            if asyncio.iscoroutine(bh) or asyncio.isfuture(bh):
                # MÊME borne dure que le chemin MCP : un builtin awaitable
                # suspendu ne doit pas geler le tour. Le timeout redevient une
                # erreur d'outil ORDINAIRE ; l'annulation utilisateur
                # (CancelledError) traverse. Le builtin ``task`` s'auto-borne
                # déjà, mais _tool_timeout_s lui laisse la marge nécessaire.
                # Budget RESTANT, pas une seconde borne pleine : deux
                # ``wait_for`` pleins cumuleraient jusqu'à 2×_bto.
                _bleft = max(0.5, _bto - (time.monotonic() - _bt0))
                try:
                    return await asyncio.wait_for(bh, timeout=_bleft)
                except asyncio.TimeoutError:
                    return _tool_timeout_json(tool_name, _bto)
            return bh
        except Exception as e:  # noqa: BLE001 — panne de l'outil rendue au modèle en JSON
            from llm_core.engine.tool_exec import flatten_exception_message
            return json.dumps({"error": flatten_exception_message(e)},
                              ensure_ascii=False)

    target_cfg = tool_cfg_map.get(tool_name)
    if not target_cfg:
        return json.dumps(
            {"error": f"Outil '{tool_name}' inconnu ou désactivé."},
            ensure_ascii=False,
        )
    # Borne dure : un outil MCP suspendu (serveur stdio bloqué, navigateur
    # mort…) ne doit jamais geler le tour NI garder le lock du serveur —
    # sans elle, seule l'annulation utilisateur libérerait la boucle. Le
    # timeout redevient une erreur d'outil ORDINAIRE (le modèle la voit et
    # peut adapter) ; l'annulation utilisateur (CancelledError) traverse.
    timeout_s = _tool_timeout_s(tool_name)
    try:
        # Le budget d'exécution est chronométré DANS le pool, après
        # l'acquisition du sémaphore d'entrée ; l'attente en file a sa propre
        # borne et sa propre erreur (MCPQueueSaturated). Un ``wait_for``
        # externe englobant l'attente ferait « expirer » sous saturation
        # multi-utilisateur un outil jamais exécuté, avec un message
        # « n'a pas répondu » qui pousserait le modèle à re-queuer.
        res = await _mcp_pool.mcp_pool.call_tool(
            target_cfg, tool_name, final_args,
            resolve_client_fn=_resolve_mcp_client,
            meta=meta,
            progress_callback=progress_callback,
            log_callback=log_callback,
            exec_timeout_s=timeout_s,
            queue_timeout_s=_TOOL_QUEUE_WAIT_S,
        )
        return json.dumps(pick_tool_payload(res), ensure_ascii=False)
    except asyncio.TimeoutError:
        return _tool_timeout_json(tool_name, timeout_s)
    except MCPQueueSaturated as e:
        # ``ok: false`` explicite : sans lui, ``engine.result_contract`` ne
        # verrait qu'une enveloppe à deux clés et la compterait comme un SUCCÈS
        # (itération « productive », métrique ``tool_call`` à ok) alors que
        # l'outil n'a jamais tourné.
        return json.dumps({
            "ok": False,
            "error": str(e),
            "fix": ("Le serveur d'outils est saturé par d'autres appels — "
                    "l'outil n'a PAS été exécuté. Réduis le parallélisme ou "
                    "réessaie dans un instant."),
        }, ensure_ascii=False)
    except Exception as e:  # noqa: BLE001 — panne de l'outil rendue au modèle en JSON
        # Message DÉPLIÉ : les transports MCP enveloppent l'exception réelle
        # (ValidationError pydantic incluse) dans un ExceptionGroup anyio dont
        # str() ne dit rien — le modèle doit voir le champ en faute.
        from llm_core.engine.tool_exec import flatten_exception_message
        return json.dumps({"error": flatten_exception_message(e)},
                          ensure_ascii=False)


async def _handle_truncated_tool_call(
    on_event: Optional[Callable],
    working_messages: List[Dict[str, Any]],
    iter_clean: str,
    iteration: int,
    *,
    channel: str,
    run_history: Optional[List[Dict[str, Any]]] = None,
    ctx_full: Optional[bool] = None,
) -> None:
    """Tool call coupé par ``finish=length`` : NE PAS exécuter, NE PAS sauver.

    ``ctx_full`` (cf. ``_length_cut_is_ctx_full``) choisit le constat montré à
    l'utilisateur : le front greffe un bouton « Compacter » sur tout message
    qui parle de contexte — il ne doit apparaître que si la fenêtre est
    réellement pleine.

    Un appel tronqué porte un JSON incomplet (ex. ``write_file`` sans
    ``path``) : l'exécuter lève une ValidationError, et SURTOUT persister le
    message assistant aux tool_calls cassés empoisonne l'historique (500 en
    boucle aux tours suivants). On garde le texte déjà produit, on informe
    l'UI, et on demande au modèle une relance en appel plus compact.

    Partagé par le canal natif (``tool_calls`` structurés) et le canal texte
    (appels écrits dans la prose). L'appelant reste responsable de ``hard_iter += 1`` +
    ``continue``.
    """
    logger.warning(
        "[run_chat_multi_mcp] tool_call %s tronqué (finish=length, iter %d) "
        "— appel(s) NON exécuté(s), relance compacte demandée",
        channel, iteration,
    )
    if ctx_full is True:
        _why = "fenêtre de contexte pleine"
    elif ctx_full is False:
        _why = "plafond de génération atteint"
    else:
        _why = "limite de longueur de génération"
    await _emit(on_event, {
        "type": "info",
        "text": (f"L'appel d'outil a été coupé ({_why}) — nouvelle "
                 "tentative avec un appel plus compact."),
    })
    # On garde le texte éventuel, mais PAS les tool_calls tronqués. Le texte
    # est un vrai output du modèle → il rejoint aussi la tool_history du run
    # (``run_history``) ; le nudge [SYSTEM] ci-dessous reste éphémère (jamais
    # persisté ni rejoué aux tours suivants).
    if iter_clean:
        _kept = {"role": "assistant", "content": iter_clean}
        working_messages.append(_kept)
        if run_history is not None:
            run_history.append(_kept)
    # Le déclencheur est ``finish_reason == "length"`` : la GÉNÉRATION a été
    # coupée — plafond de tokens de sortie ou fenêtre pleine, on ne sait pas
    # lequel des deux ici. Le texte ne tranche donc pas (« by the context
    # limit » ferait conclure au modèle à une saturation de contexte, parfois
    # qu'il ne peut plus rien faire). Le conseil actionnable vaut dans les
    # deux cas.
    _compact_default = (
        "[SYSTEM] Your previous tool call was cut off mid-emission when the "
        "generation hit its length limit: it is incomplete and was NOT "
        "executed. Re-issue it MUCH more compactly — for example, to write "
        "a large file, split it into several smaller successive "
        "write_file calls (append mode) instead of one giant "
        "write."
    )
    # Éditable à froid (context.compact_retry). Vide => défaut EN ci-dessus.
    try:
        from llm_core.context_config import CTX as _CTX
        _compact_msg = _CTX.override("context.compact_retry", _compact_default)
    except Exception:  # noqa: BLE001 — réglage illisible : consigne par défaut
        _compact_msg = _compact_default
    working_messages.append(_ephemeral_msg("user", _compact_msg))


# ══════════════════════════════════════════════════════════════════════════
#  Noyau commun aux deux canaux
# ══════════════════════════════════════════════════════════════════════════

@dataclass(frozen=True, slots=True)
class ChannelSpec:
    """Ce qui diffère volontairement entre le canal natif (``tool_calls`` de
    l'API) et le canal texte (appels écrits dans la prose), pour un même noyau
    d'exécution (``run_tool_batch``).

    Divergences portées par les champs :
      * ``vision`` — natif seulement : suivi des captures Playwright pour la
        vision, injection différée de la capture après ``pw_page("inspect")``
        ou ``desktop_observe``, élagage des vieilles trames ;
      * ``fallback_wrapper`` — texte seulement : gabarit éditable
        ``result_formatting.fallback_wrapper`` appliqué au contenu rendu au
        modèle ;
      * ``cycle_nudge`` — consigne anti-boucle (le natif cite
        ``id/auto_id/label``, un raccourci clavier, le signalement du
        blocage) ;
      * ``log_cycle``, ``log_hard_stop``, ``log_unproductive`` — libellés de
        journal ;
      * ``name`` — libellé du canal dans le traitement d'un appel tronqué.

    Divergences portées par la préparation du lot (``open_native_round`` /
    ``open_text_round``) et par l'orchestrateur :
      * natif : l'appel en cours de génération est vidé
        (``rec.delta_pending_iter``), le reste retenu par l'émission directe
        part avant les outils, les blocs ``_anthropic_thinking`` suivent le
        message assistant, le contenu de ce message est la prose nettoyée,
        un JSON d'arguments invalide n'est pas exécuté (``args_error``) ;
      * texte : le budget de relances (``_malformed_retry``) est réarmé dès
        que la lecture réussit, le message assistant porte des ``tool_calls``
        synthétiques et sa prose débarrassée du balisage, des arguments en
        chaîne non JSON deviennent ``{"value": …}``, les identifiants
        ``legacy_*`` sont rendus uniques dans l'historique."""

    name: str
    vision: bool
    fallback_wrapper: bool
    cycle_nudge: str
    log_cycle: str
    log_hard_stop: str
    log_unproductive: str


NATIF = ChannelSpec(
    name="natif",
    vision=True,
    fallback_wrapper=False,
    cycle_nudge=(
        "WARNING: you just repeated the same action several times with "
        "no change on screen. Stop replaying it: call desktop_observe "
        "to re-read the real state, check you are targeting the right "
        "element (id/auto_id/label), then try a DIFFERENT approach "
        "(another target, a keyboard shortcut, or report the blocker)."
    ),
    log_cycle="[run_chat_multi_mcp] cycle d'action desktop détecté (%s) — nudge différé",
    log_hard_stop="[run_chat_multi_mcp] hard-stop anti-boucle desktop après %d cycles",
    log_unproductive=(
        "[run_chat_multi_mcp] iter %d non productive (tous tool_calls échoués) "
        "— effective_iter reste à %d/%d (hard %d/%d)"),
)

TEXTE = ChannelSpec(
    name="texte",
    vision=False,
    fallback_wrapper=True,
    cycle_nudge=(
        "WARNING: you just repeated the same action several times with "
        "no change on screen. Stop replaying it: call desktop_observe "
        "to re-read the real state, check you are targeting the right "
        "element, then try a DIFFERENT approach."
    ),
    log_cycle="[run_chat_multi_mcp] cycle d'action desktop (fallback) détecté (%s)",
    log_hard_stop="[run_chat_multi_mcp] hard-stop anti-boucle desktop (fallback) après %d cycles",
    log_unproductive=(
        "[run_chat_multi_mcp] iter %d (fallback) non productive — "
        "effective_iter reste à %d/%d (hard %d/%d)"),
)


# Outils desktop qui OBSERVENT sans agir : leur répétition n'est pas une
# boucle, seules les actions mutantes (act, clipboard…) sont surveillées.
_DESKTOP_OBSERVE_TOOLS = ("desktop_observe", "desktop_inspect", "desktop_read",
                          "desktop_session", "desktop_screenshot")

# Itérations productives sans cycle au bout desquelles les cycles confirmés
# sont oubliés.
_CYCLE_DECAY_ITERS = 15


@dataclass(slots=True)
class CycleGuard:
    """Anti-boucle desktop du run : le modèle rejoue-t-il la même action sans
    effet visible à l'écran (signature = outil + arguments + dHash de
    l'écran) ?

    Un cycle confirmé demande une consigne d'observation ; au-delà de
    ``_CYCLE_HARDSTOP_MAX`` cycles, les actions s'arrêtent. Le compteur est
    une SÉRIE : il est remis à zéro après ``_CYCLE_DECAY_ITERS`` itérations
    productives sans cycle. Cumulé sur tout le run, il arrêterait une mission
    de 3 h sur deux blocages passagers survenus à une heure d'intervalle, avec
    100 itérations utiles entre les deux."""

    buffer: List[str] = field(default_factory=list)   # ring-buffer des signatures
    detections: int = 0
    clean_streak: int = 0

    def observe(self, tool_name: str, final_args: Any, frame_sig: str) -> Optional[str]:
        """Action desktop exécutée : rend sa signature si elle confirme un
        cycle (série en cours), ``None`` sinon. Les outils d'observation ne
        sont jamais comptés."""
        if not (tool_name or "").startswith("desktop_") or tool_name in _DESKTOP_OBSERVE_TOOLS:
            return None
        sig = _action_cycle_signature(tool_name, final_args, frame_sig)
        if not _detect_action_cycle(self.buffer, sig):
            return None
        self.detections += 1
        self.clean_streak = 0
        return sig

    @property
    def hard_stop_due(self) -> bool:
        """La consigne n'a pas suffi : arrêter les actions."""
        return self.detections >= _CYCLE_HARDSTOP_MAX

    def on_productive(self) -> None:
        """Itération productive : la série de cycles se relâche."""
        self.clean_streak += 1
        if self.detections and self.clean_streak >= _CYCLE_DECAY_ITERS:
            self.detections = 0
            self.clean_streak = 0


@dataclass(slots=True)
class TruncationGuard:
    """Appels d'outils coupés par ``finish=length``, natif et texte.

    Chaque coupe est qualifiée avant d'être comptée (fenêtre pleine ou
    plafond de génération ?). À ``_TRUNC_STREAK_MAX`` coupes d'affilée, la
    boucle sort par le chemin tool-limit en gardant la cause réelle, au lieu
    de spinner jusqu'au plafond dur en appendant deux messages par relance
    (ce qui AGGRAVE la saturation). Le compteur d'itérations productives n'est
    pas touché."""

    streak: int = 0
    ctx_full: bool = False      # au moins une coupe de la série = fenêtre pleine
    # Cause de l'arrêt, une fois la série atteinte : fenêtre pleine
    # (``"ctx_saturated"``) ou plafond de SORTIE (``"gen_cap"``).
    stop: Optional[Literal["ctx_saturated", "gen_cap"]] = None

    def reset(self) -> None:
        """Un lot d'appels a été lu : le contexte n'est pas (plus) saturé."""
        self.streak = 0
        self.ctx_full = False

    async def cut(self, channel: str, ctx: RunContext, rec: RunRecord,
                  working_messages: List[Dict[str, Any]], *,
                  usage: Dict[str, Any], iter_clean: str, iteration: int) -> bool:
        """Appel coupé : traité sans être exécuté (``_handle_truncated_tool_call``).
        Rend vrai quand la série atteint ``_TRUNC_STREAK_MAX`` : la boucle
        doit sortir, cause dans ``stop``. L'appelant compte l'itération sur
        le plafond dur."""
        _cut_full = _length_cut_is_ctx_full(usage, rec.ctx_size)
        await _handle_truncated_tool_call(
            ctx.on_event, working_messages, iter_clean, iteration,
            channel=channel, run_history=rec.run_tool_history, ctx_full=_cut_full,
        )
        self.streak += 1
        if _cut_full is True:
            self.ctx_full = True
        if self.streak < _TRUNC_STREAK_MAX:
            return False
        if self.ctx_full:
            self.stop = "ctx_saturated"
            await _emit(ctx.on_event, {
                "type": "notice", "level": "warn",
                "message": "contexte saturé — arrêt des appels d'outils",
            })
            logger.warning(
                "[run_chat_multi_mcp] %d tool calls coupés d'affilée "
                "(finish=length, %s) → contexte saturé, sortie par le chemin "
                "tool-limit", self.streak, channel,
            )
            return True
        self.stop = "gen_cap"
        await _emit(ctx.on_event, {
            "type": "notice", "level": "warn",
            "message": "appels d'outils coupés par le plafond de "
                       "génération — arrêt",
        })
        logger.warning(
            "[run_chat_multi_mcp] %d tool calls coupés d'affilée "
            "(finish=length, %s) par le plafond de génération — fenêtre "
            "NON pleine, sortie par le chemin tool-limit",
            self.streak, channel,
        )
        return True


def _is_local_tool(tool_cfg_map: Dict[str, Any], tool_name: str) -> bool:
    """L'injection du ``meta`` (username/chat_id/live_shell/call_id) ne vise
    que les outils du serveur LOCAL, reconnu par sa CONFIG (``tool_cfg_map`` :
    outil → serveur), jamais par PRÉFIXE DE NOM via le registre de
    catégories : un serveur EXTERNE exposant ``read_file``/``memory``…
    recevrait l'identité de l'utilisateur dans son ``_meta``, et le registre
    (peuplé par la connexion locale) créerait une course « registre vide →
    identité guest »."""
    _c = tool_cfg_map.get(tool_name) or {}
    # Toute entrée INTÉGRÉE du manifeste (service partagé, MCP interne de
    # l'app) reçoit l'identité ; jamais un serveur tiers.
    return _c.get("command") == "DEFAULT_LOCAL_PYTHON" or _c.get("identity") == "meta"


async def open_native_round(ctx: RunContext, rec: RunRecord,
                            working_messages: List[Dict[str, Any]], *,
                            live: LiveText, msg: Dict[str, Any],
                            tool_calls: List[Any], iter_clean: str,
                            iteration: int) -> List[Dict[str, Any]]:
    """Canal natif : message assistant du tour et préparation du lot.

    Les ``tool_calls`` sont pris tels que la fonction de flux les rend : ceux
    du canal natif, ou un appel retrouvé dans le raisonnement et promu par
    ``engine.llm_stream`` (tour sans appel natif ni prose, génération non
    coupée). Rien d'autre n'est cherché ici dans le raisonnement."""
    rec.delta_pending_iter = None     # le round s'exécute

    # Contenu pré-outil : l'essentiel est DÉJÀ parti en direct via
    # le flux (le front le reclasse en narration de segment
    # au premier event tool_call). On n'émet ici que le RESTE retenu
    # par la fenêtre/le portail anti-markup, nettoyé du markup
    # <tool_call>/<function=> qu'un modèle mélange parfois à sa prose.
    # Nettoyage divergent sur la partie déjà émise (rare) → on n'émet
    # rien de plus : le transcript persisté porte la version propre.
    _pre_tool_text = _strip_tool_call_markup("".join(live.parts))
    if _pre_tool_text:
        await live.emit_rest(_pre_tool_text, replace_on_divergence=False)

    # Ajouter le message assistant au format OpenAI standard :
    # tool_calls structurés à côté du content textuel. Persisté dans
    # la tool_history du run (delta).
    _round_msg = {
        "role":       "assistant",
        "content":    iter_clean or None,
        "tool_calls": tool_calls,
    }
    # Blocs thinking signés (connecteur Anthropic) : rejoués au
    # prochain appel devant ces tool_use (cf. to_anthropic_messages).
    if msg.get("_anthropic_thinking"):
        _round_msg["_anthropic_thinking"] = msg["_anthropic_thinking"]
    working_messages.append(_round_msg)
    rec.run_tool_history.append(_round_msg)

    # ── Préparation séquentielle des tool_calls ──────────────────
    # Avant l'exécution (sérielle ou parallèle), on décode les arguments,
    # on en RETIRE ``_username``/``_chat_id`` (l'identité voyage hors des
    # arguments, dans le ``_meta`` des outils locaux : ``_build_call_meta``)
    # et on prépare ce ``_meta``. Ce travail est sync et rapide
    # (manipulations de dict) — on le fait ici pour que la phase
    # d'exécution puisse être batchée.
    prepared: List[Dict[str, Any]] = []
    for _idx, tc in enumerate(tool_calls):
        # Formes hostiles (provider non-llama, réponse malformée) :
        # un ``tc`` non-dict ou un ``name`` null lèveraient
        # AttributeError HORS de tout try → tour entier tué. On
        # ignore l'entrée invalide, le reste du lot s'exécute.
        if not isinstance(tc, dict):
            logger.warning(
                "[run_chat_multi_mcp] tool_call non-dict ignoré "
                "(iter %d, idx %d) : %r", iteration, _idx, tc)
            continue
        # Fallback ID basé sur l'index iter+pos (unique au sein
        # de l'itération même si llama.cpp n'envoie pas d'ID).
        call_id   = tc.get("id") or f"call_{iteration}_{_idx}"
        fn        = tc.get("function") or {}
        if not isinstance(fn, dict):
            fn = {}
        tool_name = str(fn.get("name") or "")

        _args_error = None
        _raw_args = fn.get("arguments")
        try:
            tool_args = (_raw_args if isinstance(_raw_args, dict)
                         else json.loads(_raw_args or "{}"))
        except (json.JSONDecodeError, TypeError) as _je:
            # JSON invalide (hors troncature, traitée en amont) :
            # jamais ``{}`` en silence — l'outil partirait sur ses
            # défauts et le modèle ne verrait jamais que son JSON est
            # cassé. L'outil n'est pas exécuté (``args_error``).
            tool_args = {}
            _args_error = (
                f"arguments JSON invalides pour '{tool_name}' ({_je}) — "
                "outil NON exécuté ; renvoyer un objet JSON valide "
                "(guillemets doubles, pas de virgule finale)")
        # ``arguments`` peut être un JSON VALIDE mais non-objet
        # (`"foo"`, `[1,2]`, `5`, `true`) → json.loads réussit mais
        # ``.items()`` lève AttributeError HORS de tout try → tour tué.
        # Même garde que le canal texte (cf. ``open_text_round``).
        if not isinstance(tool_args, dict):
            tool_args = {}

        final_args = {k: v for k, v in tool_args.items() if k not in ("_username", "_chat_id")}
        # Identité passée en MCP request meta (out-of-band), jamais
        # injectée dans les args : le LLM ne voit pas _username/_chat_id
        # dans le schema des tools, et le client n'a pas à filtrer ces
        # champs avant chaque appel.
        #
        # Le meta est résolu côté server par le helper
        # ``_toolkit.get_username(ctx)`` qui lit
        # ``ctx.request_context.meta["username"]``. Les versions plus
        # anciennes de mcp SDK (< 1.19.0) qui ne supportent pas le
        # kwarg ``meta=`` retombent gracieusement sur le défaut "guest"
        # (cf. wrappers + _mcp_pool fallback).
        #
        call_meta = _build_call_meta(
            is_local=_is_local_tool(ctx.tool_cfg_map, tool_name), username=ctx.username,
            chat_id=ctx.chat_id, live_shell=ctx.live_shell, call_id=call_id,
            run_log_tok=ctx.run_log_tok, user_id=ctx.user_id)
        prepared.append({
            "call_id":    call_id,
            "tool_name":  tool_name,
            "final_args": final_args,
            "meta":       call_meta,
            "args_error": _args_error,
        })
        # PAS de log_metric("tool_call") ici : l'appel est seulement
        # PRÉPARÉ, il n'a pas encore tourné. ``engine/tool_exec`` en
        # écrit un à l'EXÉCUTION, enrichi du ``status``. Deux lignes
        # par appel feraient afficher au KPI « Appels outils / 24 h »,
        # qui compte les lignes sans filtrer, jusqu'au double du réel.

    # Pas de garde-fou anti-boucle (cf. la note qui précède ``BatchOutcome``) :
    # chaque appel est TOUJOURS exécuté et le modèle reçoit le vrai résultat ;
    # la terminaison reste bornée par effective/hard cap.
    return prepared


@dataclass(frozen=True, slots=True)
class TextReply:
    """Réponse sans ``tool_calls`` natifs, lue comme du texte : la prose
    (éventuellement purgée) et les appels écrits dedans vers des outils
    connus (``None`` s'il n'y en a pas)."""

    raw_text: str
    iter_clean: str
    calls: Optional[List[Tuple[str, Any]]]


def classify_text_reply(ctx: RunContext, live: LiveText, iter_clean: str,
                        iteration: int) -> TextReply:
    """Mode fallback : texte libre contenant du JSON d'appel d'outil.

    Ne garde que les appels vers des outils effectivement connus. Un appel
    vers un nom inconnu (hallucination, namespace inattendu…) laissé tel quel
    finirait streamé à l'utilisateur via le flux final — JSON visible dans la
    bulle assistant : si toute la prose n'est QUE cette tentative d'appel (pas
    de prose légitime autour), elle est purgée EN PLACE (la reprise et la
    réponse finale relisent ``live.parts``)."""
    raw_text = iter_clean  # balises de raisonnement déjà retirées par llm_turn.call_llm
    legacy_calls = extract_tool_calls(raw_text) if raw_text else None

    # Filtrer les faux positifs : ne garder que les outils effectivement connus
    if legacy_calls:
        known_tools = set(ctx.tool_cfg_map.keys()) | set(ctx.builtin_handlers.keys())
        # ``n`` vient d'un JSON produit par le modèle : un nom non-hashable
        # (dict/liste) lèverait TypeError hors de tout try → tour tué.
        _matched_calls = [(n, a) for n, a in legacy_calls
                          if isinstance(n, str) and n in known_tools]
        if not _matched_calls:
            if _looks_like_pure_tool_call_text(raw_text):
                logger.warning(
                    "[run_chat_multi_mcp] Tool call avec nom(s) inconnu(s) %s "
                    "— JSON supprimé du flux final (itération %d)",
                    [n for n, _ in legacy_calls], iteration,
                )
                raw_text = ""
                iter_clean = ""
                live.purger()
            legacy_calls = None
        else:
            legacy_calls = _matched_calls
    return TextReply(raw_text=raw_text, iter_clean=iter_clean, calls=legacy_calls)


# Relances bornées après un appel d'outil illisible ou perdu
# (``relaunch_unparsed_call``). Évite qu'un modèle qui émet du JSON cassé en
# boucle ne consomme tout le budget : au-delà de ce cap, on laisse retomber sur
# la réponse finale.
_MALFORMED_RETRY_MAX = 2

# Relance quand la tentative d'appel n'a PAS atteint le canal outils (perdue
# dans le reasoning / mangée par le parseur serveur). Formulée pour être
# auto-réparante : un modèle qui ne voulait PAS appeler d'outil conclut en texte.
_LOST_TOOL_CALL_NUDGE = (
    "[SYSTEM] Your last message contained tool-call markup but NO tool call "
    "reached the tool channel — nothing was executed. Re-emit the call now "
    "using the NATIVE tool-call mechanism of this API (do NOT write XML tags "
    "like <tool_call> or <function=...> in your text). If you did not intend "
    "to call a tool, simply give your final answer as plain text."
)


async def relaunch_unparsed_call(rec: RunRecord, working_messages: List[Dict[str, Any]],
                                 reply: TextReply, *, live: LiveText,
                                 iter_thinking: str, iteration: int,
                                 malformed_retry: int) -> Tuple[bool, int]:
    """Relances bornées d'une tentative d'appel qui n'a rien exécuté. Rend
    ``(relance émise, budget de relances consommé)`` ; l'appelant compte
    l'itération sur le plafond dur avant de reboucler.

    Appel illisible : le modèle a tenté un appel d'outil (balise <tool_call>
    ou objet {"name":…}) mais le JSON/balisage était cassé —
    ``extract_tool_calls`` a armé ``_tool_parsing.LAST_PARSE_DIAGNOSTIC``. Sans
    retour, un modèle 30-129B rejoue la même erreur en silence : on lui
    réinjecte le format attendu, au lieu de streamer le JSON cassé à l'UI.

    Appel perdu : AUCUNE prose visible, mais le reasoning du tour porte des
    traces de markup d'appel — l'appel est parti dans le canal reasoning et la
    récupération a échoué (dialecte XML dont le serveur a consommé les
    ouvrantes : il ne reste que des fermantes, rien de parsable). Sans
    relance, le tour meurt en silence après la phrase d'annonce (« Je vais
    créer… » puis plus rien). Même budget que l'appel illisible."""
    # ``raw_text`` non vide ⇒ extract_tool_calls vient d'être rappelé par
    # ``classify_text_reply``, donc LAST_PARSE_DIAGNOSTIC est frais (pas un
    # résidu du parse du reasoning en amont, qui n'aurait pas re-réinitialisé
    # le diagnostic).
    if not reply.calls and reply.raw_text and _tool_parsing.LAST_PARSE_DIAGNOSTIC:
        if malformed_retry < _MALFORMED_RETRY_MAX:
            malformed_retry += 1
            logger.warning(
                "[run_chat_multi_mcp] tool-call non parsable (iter %d) — "
                "feedback de correction au modèle (%d/%d)",
                iteration, malformed_retry, _MALFORMED_RETRY_MAX,
            )
            await live.flush()
            if reply.iter_clean:
                # Vrai output du modèle → persisté dans le delta ; le
                # diagnostic de parse ci-dessous reste éphémère.
                _kept = {"role": "assistant", "content": reply.iter_clean}
                working_messages.append(_kept)
                rec.run_tool_history.append(_kept)
            working_messages.append(_ephemeral_msg(
                "user", _tool_parsing.LAST_PARSE_DIAGNOSTIC))
            return True, malformed_retry
        logger.warning(
            "[run_chat_multi_mcp] tool-call non parsable (iter %d) — cap de "
            "relances atteint (%d), on retombe sur la réponse finale",
            iteration, _MALFORMED_RETRY_MAX,
        )

    if (not reply.calls and not (reply.raw_text or "").strip()
            and _TOOL_MARKUP_TRACE_RE.search(iter_thinking or "")):
        if malformed_retry < _MALFORMED_RETRY_MAX:
            malformed_retry += 1
            logger.warning(
                "[run_chat_multi_mcp] tentative d'appel perdue dans le "
                "reasoning (iter %d, aucun tool call reçu) — relance native "
                "demandée au modèle (%d/%d)",
                iteration, malformed_retry, _MALFORMED_RETRY_MAX,
            )
            working_messages.append(_ephemeral_msg(
                "user", _LOST_TOOL_CALL_NUDGE))
            return True, malformed_retry
        logger.warning(
            "[run_chat_multi_mcp] tentative d'appel perdue dans le reasoning "
            "(iter %d) — cap de relances atteint (%d), réponse finale",
            iteration, _MALFORMED_RETRY_MAX,
        )
    return False, malformed_retry


def open_text_round(ctx: RunContext, rec: RunRecord,
                    working_messages: List[Dict[str, Any]], *,
                    raw_text: str, calls: List[Tuple[str, Any]],
                    finish: Any, iteration: int) -> List[Dict[str, Any]]:
    """Canal texte : préparation du lot et message assistant porteur de
    ``tool_calls`` SYNTHÉTIQUES (même structure que le natif)."""
    logger.warning(
        f"[run_chat_multi_mcp] Fallback legacy tool-call sur itération {iteration} "
        f"(finish_reason='{finish}')"
    )
    # ── Préparation séquentielle (idem chemin natif) ─────────────
    prepared_legacy: List[Dict[str, Any]] = []
    # ``legacy_{iter}_{idx}`` repart de 0 à chaque run : deux tours en
    # canal texte produiraient les MÊMES ids dans l'historique (même
    # classe de défaut que ``_unique_tool_call_ids`` côté natif :
    # élagage et résumeur indexés sur le mauvais appel). Un id déjà vu
    # reçoit un suffixe aléatoire.
    _legacy_seen_ids = {
        tc.get("id") for m in working_messages
        if isinstance(m, dict) and m.get("role") == "assistant"
        for tc in (m.get("tool_calls") or []) if isinstance(tc, dict)
    }
    for _idx, (tool_name, tool_args) in enumerate(calls):
        # ID synthétique apparié au tool_call assistant synthétique
        # construit plus bas (aligne le legacy sur le natif : role=tool
        # + tool_call_id ⇒ tool_history capturée + compteur correct).
        call_id = f"legacy_{iteration}_{_idx}"
        if call_id in _legacy_seen_ids:
            call_id = f"{call_id}_{secrets.token_hex(3)}"
        _legacy_seen_ids.add(call_id)
        # Défense : extract_tool_calls peut renvoyer des args sous forme
        # de string JSON (dialectes hors canal natif). On dé-stringifie
        # comme le chemin natif, et on garantit un dict avant le
        # dict-comprehension (sinon .items() → AttributeError qui, hors
        # try/except LLM, fait planter tout le run_chat_multi_mcp).
        if isinstance(tool_args, str):
            try:
                tool_args = json.loads(tool_args)
            except (json.JSONDecodeError, ValueError):
                tool_args = {"value": tool_args}
        if not isinstance(tool_args, dict):
            tool_args = {}
        final_args = {k: v for k, v in tool_args.items() if k not in ("_username", "_chat_id")}
        # Identité passée en MCP request meta : cf. le commentaire
        # détaillé du chemin natif (``_build_call_meta``).
        call_meta = _build_call_meta(
            is_local=_is_local_tool(ctx.tool_cfg_map, tool_name), username=ctx.username,
            chat_id=ctx.chat_id, live_shell=ctx.live_shell, call_id=call_id,
            run_log_tok=ctx.run_log_tok, user_id=ctx.user_id)
        prepared_legacy.append({
            "call_id":    call_id,
            "tool_name":  tool_name,
            "final_args": final_args,
            "meta":       call_meta,
        })
        # Même raison que sur le canal natif : la métrique appartient à
        # l'exécution, pas à la préparation. Cf. engine/tool_exec.

    # ── Message assistant porteur d'un tool_calls SYNTHÉTIQUE ─────
    # Le modèle a émis ses appels en texte libre (pas de canal natif).
    # On reconstruit la structure OpenAI tool_calls pour que :
    #   • la capture tool_history voie l'assistant comme « première
    #     agentic » (filtre role=assistant AVEC tool_calls) ;
    #   • le résultat stocké en role=tool + tool_call_id soit apparié.
    # Stocké en role=system, le résultat laisserait la tool_history vide et
    # _tool_calls_done à 0 alors que des outils ont bel et bien tourné.
    _legacy_tool_calls = [
        {
            "id":       p["call_id"],
            "type":     "function",
            "function": {
                "name":      p["tool_name"],
                "arguments": json.dumps(p["final_args"], ensure_ascii=False),
            },
        }
        for p in prepared_legacy
    ]
    _legacy_round_msg = {
        "role":       "assistant",
        # Strip du markup <tool_call>/<function=> : les tool_calls
        # structurés ci-dessous portent déjà l'info ; garder le texte
        # brut polluerait la tool_history persistée (ré-injectée au
        # Resume → encourage le modèle à récidiver) et fuirait dans
        # la bulle via les sorties partielles. content=None si le
        # texte n'est QUE du markup (convention OpenAI).
        "content":    _strip_tool_call_markup(raw_text) or None,
        "tool_calls": _legacy_tool_calls,
    }
    working_messages.append(_legacy_round_msg)
    rec.run_tool_history.append(_legacy_round_msg)
    return prepared_legacy


# NOTE — pas de « garde-fou anti-boucle » qui bloquerait le 3e appel identique
# (fingerprint) en renvoyant une enveloppe factice ``{"ok": false, "blocked":
# true, ...}`` au lieu du résultat réel. Deux effets pervers se combineraient :
#   1. Le modèle ne recevrait PLUS la donnée demandée → il re-tenterait →
#      re-bloqué → boucle forcée.
#   2. Cette enveloppe ``ok: false`` serait comptée comme une erreur par
#      ``result_is_tool_failure`` → itération « non productive » → ``effective_iter``
#      n'avancerait jamais, seul ``hard_iter`` monterait → spin jusqu'au hard
#      cap sans rien produire.
#
# La terminaison de la boucle est GARANTIE sans ce mécanisme par la condition
# ``while effective_iter < _effective_iter_budget and hard_iter < _hard_iter_cap``
# (cf. run_chat_multi_mcp) : un répéteur tenace tape au pire le hard cap, mais
# en recevant à chaque fois le VRAI résultat — donc avec une chance d'avancer,
# au lieu d'être enfermé dans un refus.


@dataclass(frozen=True, slots=True)
class BatchOutcome:
    """Issue d'un lot, appliquée par l'orchestrateur à ses compteurs."""

    had_success: bool           # au moins un appel a réussi : itération productive
    cycle_hard_stopped: bool    # boucle d'action persistante : arrêt des actions


async def run_tool_batch(channel: ChannelSpec, ctx: RunContext, rec: RunRecord,
                         deps: LoopDeps, working_messages: List[Dict[str, Any]],
                         prepared: List[Dict[str, Any]], *, iteration: int,
                         cycle: CycleGuard) -> BatchOutcome:
    """Exécute un lot préparé, commun aux deux canaux : annulation, événements
    ``tool_call``, exécution (série ou parallèle), post-traitement dans
    l'ordre du modèle, anti-boucle. ``working_messages`` est complété EN
    PLACE (résultats, trames vision, consigne anti-boucle)."""
    on_event = ctx.on_event
    username = ctx.username
    _emit_partial_tool_history_snapshot = functools.partial(
        rec.emit_partial_snapshot, on_event)
    _guard_cancel = functools.partial(rec.guard_cancel, on_event)

    # ``execute_single`` lié aux tables d'outils de CE run — passé à
    # ``execute_tool_batch`` (injection : évite un cycle d'import).
    async def _bound_execute_single(
        tool_name, final_args, *,
        meta=None, progress_callback=None, log_callback=None,
    ):
        return await _execute_single_tool_call(
            tool_name, final_args, ctx.tool_cfg_map, ctx.builtin_handlers,
            meta=meta, progress_callback=progress_callback,
            log_callback=log_callback,
        )

    # Yield + cancel check une fois après la prep (avant exec)
    await asyncio.sleep(0)
    if ctx.cancelled():
        logger.info("[run_chat_multi_mcp] Cancellation avant tool_call")
        await _emit_partial_tool_history_snapshot()
        raise asyncio.CancelledError("User cancelled")

    # ── Émission des events ``tool_call`` dans l'ordre original ──
    # Le frontend les voit tomber dans l'ordre LLM ; ``tool_result``
    # arrivera plus tard (potentiellement dans un autre ordre si
    # exec parallèle, mais chaque event porte son ``name`` donc le
    # frontend matche correctement).
    for p in prepared:
        _tc_evt = {
            "type": "tool_call", "name": p["tool_name"], "args": p["final_args"],
            # call_id : corrélation fine côté client (live shell —
            # deux execute_shell parallèles portent le même ``name``,
            # seuls leurs call_id distinguent leurs sorties). Champ
            # additif, ignoré par les consommateurs existants.
            "call_id": p.get("call_id"),
        }
        if _tool_is_internal(p["tool_name"]):
            _tc_evt["internal"] = True
        await _emit(on_event, _tc_evt)

    # ── Exécution du lot (série/parallèle) → engine.tool_exec ─────
    # Outils sériels (``_tool_traits``) un par un, chacun coupant le lot en
    # cours (« lecture → écriture → lecture » reste linéaire) ; les autres
    # en parallèle, plafonnés par ``LLAMA_TOOL_PARALLELISM``. Le
    # post-traitement (events tool_result, append, vision) suit l'ordre LLM,
    # ci-dessous : le modèle apparie ainsi appels et résultats au tour
    # suivant. Le lot en cours est posé AVANT l'attente (``rec.ouvrir_lot``,
    # qui rend le dict que remplit l'exécution) : l'instantané d'une
    # annulation en plein lot y lit ce qui a déjà tourné.
    results_by_idx = await _execute_tool_batch(
        prepared,
        results_out       = rec.ouvrir_lot(prepared),
        execute_single    = _bound_execute_single,
        record_metric     = deps.record_metric,
        is_tool_failure   = result_is_tool_failure,
        on_event          = on_event,
        username          = username,
        chat_id           = ctx.chat_id,
        on_cancel_snapshot= _emit_partial_tool_history_snapshot,
        iteration         = iteration,
        emit_progress_log = True,
        is_cancelled      = ctx.is_cancelled,
    )

    # ── Post-traitement séquentiel dans l'ordre original ──────────
    # Émission des tool_result, append au working_messages, vision
    # tracking et injection. Tout cela DOIT être en ordre LLM pour
    # que la conversation reste cohérente côté modèle.
    had_success = False
    _cycle_nudge_pending = False     # nudge anti-boucle à injecter APRÈS la boucle
    _pending_vision_msgs: List[Dict[str, Any]] = []   # frames vision différées
    _chat_key = f"{username}:{ctx.chat_key_suffix}"
    for idx, p in enumerate(prepared):
        tool_name  = p["tool_name"]
        final_args = p["final_args"]
        call_id    = p["call_id"]
        result_content = results_by_idx.get(idx, json.dumps({"error": "no_result"}))

        # ── Détection succès / échec pour le compteur de productivité ─
        # ``_execute_single_tool_call`` renvoie TOUJOURS une string :
        #   - succès → JSON-encoded résultat normal du tool, soit
        #              ``{"ok": true, ...}`` (envelope ``_ok()`` /
        #              typed Pydantic Union), soit un dict
        #              libre quand le tool a son propre format.
        #   - échec  → soit ``{"error": "<msg>"}`` (chaos error
        #              produit par notre filet de sécurité dans
        #              ``_execute_single_tool_call``), soit
        #              ``{"ok": false, "error": "...", "message":
        #              "...", "fix": "..."}`` (envelope ``_err()``
        #              ou branche Union ErrEnvelope).
        # Si UN AU MOINS des tool_calls de cette itération a réussi,
        # on considère l'itération productive. Itération entièrement
        # ratée = compteur ``effective_iter`` PAS incrémenté →
        # le modèle peut retenter sans manger son budget. Le plafond dur de
        # la boucle sert de garde-fou absolu contre les boucles infinies.
        #
        # Heuristique alignée avec le frontend
        # (``frontend/js/chat/_tool_segments.js::resultIsError``), via le helper
        # partagé. PRODUCTIVITÉ = échec d'OUTIL uniquement : une
        # commande shell exécutée avec exit≠0 (pytest rouge, build
        # cassé) est un résultat EXPLOITABLE — elle ne doit pas
        # bloquer l'avancement du budget d'itérations.
        if not result_is_tool_failure(result_content):
            had_success = True

        _evt = {
            "type":   "tool_result",
            "name":   tool_name,
            # call_id : appariement fiable step↔résultat côté client
            # (deux appels PARALLÈLES du même outil — le matching par
            # nom attribue sinon le 1er résultat au dernier step).
            "call_id": call_id,
            "result": result_content[:2000],  # 2000 chars pour le panneau détail UI
            # Durée de l'appel : affichée à côté de chaque outil.
            "duration_ms": p.get("duration_ms"),
        }
        _dk = _desktop_event_extra(tool_name, result_content,
                                   with_elements=str(ctx.chat_key_suffix).startswith("studio_"))
        if _dk:
            _evt["desktop"] = _dk
        # Path du fichier muté (write/edit/save) : permet au frontend de
        # rattacher la diff card au BON fichier. Sans ça il s'appuierait
        # sur un pendingWrite UNIQUE côté front, écrasé quand le modèle
        # émet PLUSIEURS writes dans le même tour (tous les tool_call
        # partent AVANT les tool_result) → seul le dernier fichier
        # s'afficherait. On n'envoie que le chemin, jamais le contenu.
        # ``git_write`` → chemin ``repo/path`` ; ``dry_run`` et
        # ``sha256`` final transmis.
        _evt.update(_write_event_extra(tool_name, final_args, result_content))
        _noter_fichiers(_evt.get("files"))
        if _tool_is_internal(tool_name):
            _evt["internal"] = True
        _ss = _extract_pw_screenshot_url(tool_name, final_args, result_content)
        if _ss:
            _evt["screenshot_url"] = _ss["url"]
            _evt["screenshot_step"] = _ss["step"]
            _evt["screenshot_session"] = _ss["session_id"]
            # ── Vision tracking : stocke la screenshot pour injection éventuelle ──
            # Lue depuis le disque uniquement si le modèle est vision-capable
            # (évite la lecture fichier + compression pour rien).
            if channel.vision and ctx.model_has_vision:
                _pw_screens_dir = os.environ.get("PW_SCREENS_DIR", "/tmp/pw_screens")
                _png_path = os.path.join(
                    _pw_screens_dir,
                    f"step_{_ss['session_id']}_{_ss['step']}.png",
                )
                if await _guard_cancel(_ensure_local_asset(
                        ctx.user_id, _png_path,
                        f"/api/playwright/screenshot/step_{_ss['session_id']}_{_ss['step']}.png")):
                    # Pillow (décodage PNG, LANCZOS, JPEG) hors
                    # boucle.
                    await _guard_cancel(asyncio.to_thread(
                        _track_last_screenshot_for_vision, _chat_key, _png_path))
        # ── Desktop (computer-use) frame → Annotation Studio + vision ──
        await _guard_cancel(_prefetch_desktop_frame(ctx.user_id, tool_name, result_content))
        _af_evt = _populate_desktop_frame(
            _evt, tool_name, final_args, result_content, username,
            ctx.model_has_vision, _chat_key)
        if _af_evt:
            _vt = _af_evt.pop("_vision_track", None)
            if _vt:
                await _guard_cancel(asyncio.to_thread(
                    _track_last_screenshot_for_vision, *_vt))
            await _guard_cancel(_emit(on_event, _af_evt))
            # ── Anti-boucle : le modèle rejoue-t-il la même action sans
            # effet visible ? (signature = outil+args+dHash écran). Ne se
            # déclenche QUE pour les outils desktop MUTANTS (act/clipboard)
            # — une ré-observation répétée n'est pas une boucle.
            _sig = cycle.observe(tool_name, final_args, _af_evt.get("sig") or "")
            if _sig is not None:
                # Nudge DIFFÉRÉ : on ne peut PAS insérer un message user
                # ici (entre l'assistant.tool_calls et ses tool_results),
                # ça orphelinerait les résultats. On l'injecte APRÈS la
                # boucle, une fois tous les tool_results appariés.
                _cycle_nudge_pending = True
                await _guard_cancel(_emit(on_event, {"type": "notice", "level": "warn",
                                                     "message": "boucle d'action détectée — relance d'observation suggérée"}))
                logger.warning(channel.log_cycle, _sig)
        # ── Track ownership Playwright sessions (multi-user safety) ──
        await _guard_cancel(_track_pw_session_ownership(tool_name, final_args, result_content, username))
        await _guard_cancel(_emit(on_event, _evt))
        rec.record_file_mutation(_evt, result_content)

        # ── Stockage du tool result au format OpenAI standard ──
        # role:tool + tool_call_id, content = VUE MODÈLE du résultat :
        # étage unique partagé (desktop compacté, diff d'edit retiré,
        # cap d'émission dérivé du n_ctx). L'event UI complet est déjà
        # parti ci-dessus — l'utilisateur ne perd rien.
        _content_to_send = _prepare_tool_result_for_model(
            tool_name, result_content, rec.ctx_size,
            model_id=(ctx.model or LLAMA_MODEL or None))
        if channel.fallback_wrapper:
            # Le wrapper éditable à froid (result_formatting.fallback_wrapper,
            # placeholders {tool} {result}) s'applique au CONTENU. Vide => le
            # contenu est le résultat brut (format OpenAI canonique).
            with swallow("harness.run_chat_multi_mcp_impl.8"):
                from llm_core.context_config import CTX as _CTX
                _fb_tmpl = _CTX.override("result_formatting.fallback_wrapper", "")
                if _fb_tmpl:
                    _content_to_send = _fb_tmpl.format(tool=tool_name, result=_content_to_send)

        _tool_msg = {
            "role":         "tool",
            "tool_call_id": call_id,
            "content":      _content_to_send,
        }
        working_messages.append(_tool_msg)
        rec.run_tool_history.append(_tool_msg)

        if not channel.vision:
            continue
        # ── INJECTION VISION : screenshot pour modèles multimodaux ──
        # Trigger : pw_page avec action="inspect" + modèle vision-capable
        # + une screenshot récente est dispo. On ajoute un message user
        # contenant l'image pour que le LLM la voie en plus du texte.
        # Les noms d'arguments pw_* sont harmonisés (action|op) : on passe
        # par pw_verb, sinon un pw_page(action="inspect") — la forme
        # documentée — n'injecterait rien.
        _is_inspect = (
            tool_name == "pw_page"
            and isinstance(final_args, dict)
            and (_pw_verb_of("pw_page", final_args) == "inspect")
        ) or (tool_name == "desktop_observe")
        if ctx.model_has_vision and _is_inspect:
            _img_url = _get_last_screenshot_b64(_chat_key)
            if _img_url:
                # Format OpenAI multimodal : content = list of blocks
                _caption_default = (
                    "Here is the current screenshot of the page "
                    "(compressed to 1024px wide). Use it alongside "
                    "the 'inspect' text to precisely locate visual "
                    "elements."
                )
                # Légende éditable à froid (vision.image_caption). Vide => défaut EN.
                try:
                    from llm_core.context_config import CTX as _CTX
                    _caption = _CTX.override("vision.image_caption", _caption_default)
                except Exception:  # noqa: BLE001 — réglage illisible : légende par défaut
                    _caption = _caption_default
                # Éphémère (PAS dans rec.run_tool_history) : une frame
                # base64 persistée serait rejouée à chaque tour suivant
                # (bombe contexte + DB). Le live la voit ; un
                # « Continuer » ne rejoue que le résultat textuel —
                # cohérent avec prune_old_vision_frames (2 frames max)
                # et _clear_last_screenshot_for en fin de run.
                #
                # Injection DIFFÉRÉE, pour la même raison que le nudge
                # anti-boucle plus bas : on est ICI au milieu de
                # l'appariement ``assistant.tool_calls`` → ``tool``.
                # Appendre un message ``user`` entre deux résultats d'un
                # lot parallèle donnerait ``assistant(tool_calls=[A,B])
                # → tool(A) → user(image) → tool(B)`` : ``tool(B)``
                # deviendrait un résultat orphelin, que
                # ``sanitize_message_history`` ne recolle pas (un
                # message ``user`` ne referme pas les ids ouverts) et
                # que la découpe en tours de la compaction prend pour un
                # début de tour. Selon le gabarit du moteur, cela va du
                # 400 en pleine mission à une compaction qui tranche
                # entre un appel et sa réponse. On collecte, on
                # appendra après le dernier ``role:tool`` du lot.
                _pending_vision_msgs.append({
                    "role": "user",
                    "content": [
                        {"type": "text", "text": _caption},
                        {"type": "image_url", "image_url": {"url": _img_url}},
                    ],
                    # Marqueur éphémère : ce message est visible du
                    # modèle mais JAMAIS persisté (cf. commentaire
                    # ci-dessus) — c'est la définition même de
                    # ``pruning.is_ephemeral``, comme pour les autres
                    # injections mi-tour (``_ephemeral_msg``). Sans lui,
                    # tout le sous-système contexte le prendrait pour un
                    # VRAI tour utilisateur : ``task_anchor_index`` en
                    # ferait l'ancre de tâche (l'énoncé de la mission
                    # deviendrait droppable), ``_count_turns``
                    # sur-compterait ``covered_turns``, et
                    # ``_drop_leading_turns`` jetterait au tour suivant
                    # autant de VRAIS tours en trop — un par frame.
                    "_ephemeral": True,
                })
                logger.info(
                    "[vision] Screenshot injectée après pw_page('inspect') "
                    "pour %s (~%d KB)",
                    ctx.model or LLAMA_MODEL,
                    len(_img_url) // 1024,
                )

    # Frames de vision (différées) : tous les tool_results du lot sont
    # appariés, on peut maintenant insérer les messages ``user`` sans
    # orpheliner un résultat (cf. le site de collecte).
    if _pending_vision_msgs:
        working_messages.extend(_pending_vision_msgs)
        _pending_vision_msgs = []
        # Élagage EN PLACE des frames plus anciennes que les 2
        # dernières (même règle que la vue transmise au modèle, cf.
        # pruning.vision_keep) : sur une COPIE seulement, les base64
        # (~150-200 Ko × N pas) resteraient en heap et seraient
        # re-parcourus par fit_context à chaque itération. Rien à
        # préserver ici : ces messages
        # ``_ephemeral`` ne sont jamais persistés (la frame Studio a
        # son propre stockage par frame_token).
        working_messages[:] = _prune_old_vision_frames(working_messages, keep=2)

    # Nudge anti-boucle (différé) : tous les tool_results sont appariés,
    # on peut maintenant insérer le message user sans casser l'appariement.
    cycle_hard_stopped = False
    if _cycle_nudge_pending:
        if cycle.hard_stop_due:
            # Le nudge n'a pas suffi : on ARRÊTE les actions (force la
            # sortie de boucle → la synthèse de sortie renvoie un message clair)
            # plutôt que de laisser le modèle boucler jusqu'au budget.
            cycle_hard_stopped = True
            await _emit(on_event, {"type": "notice", "level": "warn",
                                   "message": "boucle d'action persistante — arrêt automatique des actions"})
            logger.warning(channel.log_hard_stop, cycle.detections)
        else:
            working_messages.append(_ephemeral_msg("user", channel.cycle_nudge))
    return BatchOutcome(had_success=had_success, cycle_hard_stopped=cycle_hard_stopped)
