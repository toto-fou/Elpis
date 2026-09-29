# SPDX-License-Identifier: MIT
"""
backend.services._chat_with_tools — Tool-calling chat orchestration (MCP + builtins).

This is the heart of the agentic chat loop. It owns:

  - ``pick_tool_payload(tool_result)`` — best-effort decode of an MCP tool
                                          result into a Python value the LLM
                                          can consume.
  - ``_clean_json_text(...)``          — strip trailing junk/garbage that some
                                          models emit after a JSON tool call.
  - ``_looks_like_pure_tool_call_text(...)`` — heuristic: does this assistant
                                          message look like a tool call dressed
                                          up as text?
  - ``_llama_chat_with_tools_stream(...)`` — STREAMING tool-calling LLM call
                                          with the OpenAI-native tools[] +
                                          tool_choice="auto" payload, plus
                                          a fallback to non-streaming and
                                          finally to text-parse if llama-server
                                          can't handle the model.
  - ``_select_prune_keys(...)`` — sélection FIN DE TOUR des vieux
                                          tool_results (memo par run,
                                          byte-stable → préfixe KV préservé)
                                          pour contenir la fenêtre sur un
                                          long run agentique.
  - ``_collect_mcp_tools(...)``        — fan out to all configured MCP servers
                                          (stdio + SSE + HTTP) and aggregate
                                          their tools into a single OpenAI
                                          payload.
  - ``_build_runtime_sandbox_context(...)`` — generate the sandbox-aware
                                          system prompt prefix the LLM uses
                                          to know which file roots / shell
                                          tools are available.
  - ``_inject_ax_memory_into_messages(...)`` — splice the user's accessibility
                                          memory (long-term notes) into the
                                          LLM payload as a system message.
  - ``_execute_single_tool_call(...)`` — dispatch one tool_call to the right
                                          MCP / builtin executor and return
                                          the result for the next LLM turn.
  - ``run_chat_multi_mcp(...)``        — main loop. Iterates LLM ↔ tools up
                                          to ``LLAMA_MAX_TOOL_ITERATIONS`` times,
                                          handling cancellation, vision
                                          screenshot injection, and per-turn
                                          metrics. ~830 lines.
  - ``run_chat_multi_mcp_v2(...)``     — alternative loop used in the
                                          ``optimized`` scheduling mode that
                                          releases the LLM slot during tool
                                          execution.

Module-level constants
----------------------
- ``TOOL_RESULT_MAX_OLD`` (200): plancher/filet du niveau d'élagage de
  ``select_prune_keys`` (harnais v4 : marques persistées, unités tokens).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
import time
from contextlib import asynccontextmanager
from contextvars import ContextVar
from typing import Any, Callable, Dict, List, Optional, Tuple

import httpx

from llm_core import _tool_parsing  # module (lecture LAST_PARSE_DIAGNOSTIC, réaffecté)

# Helpers from sibling submodules — the natural import targets after the
# legacy split. We deliberately import through the canonical destination
# rather than ``backend.services._legacy`` to avoid an import cycle.
from llm_core._chat_classic import (
    _coalesce_system_messages,
    _dump,
    _extract_thinking,
    _http_4xx,
    llama_chat,
)
from llm_core._desktop_session import (
    _extract_desktop_frame,
    desktop_frame_path,
    register_desktop_frame_owner,
)
from llm_core._health import verify_llm_availability
from llm_core._llm_retry import (
    KIND_CONTEXT_OVERFLOW as _KIND_CTX_OVERFLOW,
    KIND_FORBIDDEN as _KIND_FORBIDDEN,
    KIND_INVALID_REQUEST as _KIND_INVALID_REQUEST,
    KIND_RATE_LIMITED as _KIND_RATE_LIMITED,
    KIND_UNKNOWN as _KIND_UNKNOWN,
    LLMFailure,
    error_body_text as _llm_error_body_text,
    llm_error_detail as _llm_error_detail,
    llm_error_is_fatal as _llm_error_is_fatal,
    llm_error_kind as _llm_error_kind,
    llm_error_user_message as _llm_error_user_message,
    retry_pause as _llm_retry_pause,
)
from llm_core._mcp_pool import MCPQueueSaturated, mcp_pool
from llm_core._mcp_wrappers import (
    _resolve_mcp_client,
    _sanitize_schema_for_grammar,
    friendly_mcp_error as _friendly_mcp_error,
    mcp_tool_to_openai,
)
from llm_core._metrics import calculate_metrics
from llm_core._model_info import get_model_context_size
from llm_core._pw_session import (
    _extract_pw_screenshot_url,
    _pw_verb_of,
    _track_pw_session_ownership,
)
from llm_core._scheduling._guard import _emit
from llm_core._stream_tag_parser import ThinkTagSplitter
from llm_core._think_resume import should_auto_resume, should_auto_resume_content
from llm_core._think_tokens import (
    measure_thinking_tokens,
    native_reasoning_tokens as _native_reasoning_tokens,
)
from llm_core._thinking_reconcile import reconcile_thinking_content
from llm_core._tool_parsing import extract_tool_calls
from llm_core._tool_traits import tool_traits
from llm_core._vision import (
    _clear_last_screenshot_for,
    _get_last_screenshot_b64,
    _model_supports_vision,
    _track_last_screenshot_for_vision,
)
from shared_infra.config import (
    LLAMA_MODEL,
    LLAMA_RESUMABLE_STREAM,
    LLAMA_RETRIES,
    LLAMA_TIMEOUT_SEC,
    LLAMA_URL,
)
from shared_infra.db import log_metric
from shared_infra.observability.tracing import swallow
from shared_infra.observability.usage_ctx import record_turn_usage

# Studio : un ``desktop_act`` du chat renvoie l'écran APRÈS l'action (sig + éléments).
# ``result`` est coupé à 2000 caractères pour le panneau : le JSON est alors invalide
# dès qu'il y a des éléments, et l'enregistreur du Studio perdait la signature (effet
# visible) et les éléments apparus (attente nommée composée). On les joint à part,
# allégés et bornés.
_DESKTOP_EVENT_KEYS = ("id", "label", "role", "auto_id", "box", "center", "depth", "unnamed",
                       "source", "states", "patterns", "label_source")


def _desktop_event_extra(tool_name, raw, with_elements=True):
    """``sig`` + éléments allégés d'un desktop_act/observe, hors de la coupe à 2000
    caractères de ``result``. Les éléments ne servent qu'à l'enregistreur du Studio
    (mini-chat ``studio_…``) : le chat principal les recevait aussi — jusqu'à 600
    éléments (~100 Ko) par action, en double de l'event ``annotation_frame`` —
    ``with_elements=False`` n'y garde que ``sig``."""
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
    except Exception:
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
                # (passe 7, H6) — le décodage/rééchantillonnage Pillow
                # (30-120 ms de CPU par frame) n'est plus fait ICI, sur la
                # boucle : l'appelant le déporte en thread depuis cette clé
                # PRIVÉE, retirée avant l'émission de l'event.
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
    except Exception:                                           # noqa: BLE001
        return {}


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

    Audit éditeur 2026-09-23 :
    - ``path`` : chemin du fichier muté. Pour ``git_write`` (E10) le ``path``
      est relatif au DÉPÔT : on le rejoint à ``repo`` pour obtenir le chemin
      relatif à la sandbox (``repo/path``), sinon le front lisait un homonyme
      à la racine (ou prenait 3 × 404).
    - ``dry_run`` (E19) : présent (True) quand l'appel était un essai à blanc,
      pour que le front n'applique rien au tampon.
    - ``sha256`` : hash du contenu FINAL renvoyé par l'outil (base de
      comparaison exacte côté front, au lieu du mtime relu après coup).
    - ``files`` (2026-09-26) : fichiers modifiés, pour TOUT outil qui en
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
    except Exception:                                           # noqa: BLE001
        pass
    return out

# Constants and aliases now live in ``_constants`` (single source of truth).
from llm_core._constants import (  # noqa: E402 — import tardif voulu (dépendance circulaire ou coût)
    LLAMA_MAX_TOOL_ITERATIONS,
    LLAMA_TOOL_TIMEOUT_S,
)

# ``backend.config`` aliased — some helpers introspect this module to read
# attributes that may or may not exist on older configs.
from shared_infra import config as _bk_config  # noqa: E402 — import tardif voulu (dépendance circulaire ou coût)

# Harnais long-run (audit 2026-08-01) — lus À L'IMPORT comme les autres
# constantes de ce module. Cadence de l'élagage intra-run et nombre de
# compactions réussies autorisées dans un même run.
_PRUNE_EVERY_ITERS = int(getattr(_bk_config, "PRUNE_EVERY_ITERS", 10) or 0)
_COMPACTIONS_PER_RUN_MAX = max(
    1, int(getattr(_bk_config, "COMPACTIONS_PER_RUN_MAX", 2) or 2))

logger = logging.getLogger("uvicorn.error")


# ── Raisonnement cumulé du run : borne dure (audit long-run 2026-08-21) ─────
# ``_all_thinking`` accumulait le raisonnement de TOUTES les itérations sans
# aucune borne, puis le concaténait en fin de run. Sur une mission de plusieurs
# heures avec un modèle raisonneur (~20 Ko de <think> par itération × 200
# itérations) cela fait des mégaoctets qui sont : gardés en heap pendant tout
# le run, joints en UNE string, POSTés à /tokenize pour la décomposition
# thinking/réponse (le timeout de 5 s expire → on paie l'aller-retour pour
# retomber sur l'estimation), puis renvoyés dans ``metrics["thinking"]`` — donc
# poussés dans une ligne NDJSON unique vers le navigateur.
#
# Le raisonnement est ÉPHÉMÈRE (jamais re-soumis au modèle, strippé à la
# persistance — cf. la règle « thinking hors budget contexte ») : sa seule
# consommation est l'accordéon de l'UI, où le récent est le plus utile. On
# garde donc le SUFFIXE, avec un marqueur explicite en tête.
THINKING_HISTORY_MAX_CHARS = max(0, int(
    getattr(_bk_config, "THINKING_HISTORY_MAX_CHARS", 400_000) or 0))
THINKING_HISTORY_TRUNC_MARKER = (
    "[…raisonnement des itérations antérieures omis (trop volumineux)…]")


def _resume_prefix_join(clean: str, exact: str) -> str:
    """Prose à renvoyer pour une reprise token-exacte.

    ``clean`` est la version affichable (strippée, éventuellement recollée
    d'un segment précédent) ; ``exact`` est le contenu brut du DERNIER
    segment, qui seul porte les espaces de fin. On rend ``clean`` prolongé de
    la queue blanche de ``exact`` : la frontière de reprise est conservée sans
    perdre ce qui a été recollé en amont."""
    tail = exact[len(exact.rstrip()):] if exact else ""
    return (clean or "") + tail


def _clip_thinking_history(parts: List[str]) -> None:
    """Borne EN PLACE le raisonnement cumulé d'un run (suffixe conservé).

    Mute ``parts`` pour que les ``pop()`` de dédoublonnage de la boucle
    (qui portent sur le DERNIER élément) restent valides."""
    if THINKING_HISTORY_MAX_CHARS <= 0 or len(parts) <= 1:
        return
    total = sum(len(p) for p in parts)
    if total <= THINKING_HISTORY_MAX_CHARS:
        return
    kept: List[str] = []
    acc = 0
    # On repart de la fin : le dernier bloc est toujours conservé entier
    # (c'est celui de l'itération courante, que la boucle peut re-pop).
    for p in reversed(parts):
        if kept and acc + len(p) > THINKING_HISTORY_MAX_CHARS:
            break
        kept.append(p)
        acc += len(p)
    kept.reverse()
    if len(kept) < len(parts):
        kept.insert(0, THINKING_HISTORY_TRUNC_MARKER)
    parts[:] = kept


def _content_block_text(item: Any) -> str:
    """Rendu TEXTE d'un bloc de contenu MCP non textuel (AUDIT 2026-09-25).

    - ressource embarquée TEXTE → son texte (il était perdu : « [non-text
      content block: EmbeddedResource] ») ;
    - image / audio / ressource binaire → un repère court (type MIME,
      taille), jamais la charge base64 ;
    - lien de ressource → son URI."""
    _typ = type(item).__name__
    res = getattr(item, "resource", None)
    if res is not None:
        _uri = str(getattr(res, "uri", "") or "")
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
    # isError). Avant, le texte repartait comme un payload ORDINAIRE : classé
    # succès par result_contract (string non-dict), il brûlait le budget
    # d'itérations productives et le modèle ne voyait jamais d'échec explicite.
    if getattr(tool_result, "isError", False):
        _txt_parts: list = []
        for _item in (getattr(tool_result, "content", None) or []):
            if hasattr(_item, "text"):
                _txt_parts.append(str(_item.text))
        _txt = "\n\n".join(_txt_parts).strip() or "erreur outil (MCP isError)"
        try:
            _parsed = json.loads(_txt)
        except Exception:
            _parsed = None
        # Enveloppe d'erreur déjà structurée (``{"ok": false, …}`` du
        # middleware local OkFalseAsIsError) : conservée telle quelle.
        # ``ok: False`` est POSÉ : ``result_is_error`` ne reconnaît sinon
        # qu'un ``{"error"}`` seul, et ``{"error": "Not Found", "status": 404}``
        # d'un serveur externe passait pour un succès (audit 2026-09-24, 2e passe).
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
                    except Exception:
                        return item.text
                # AUDIT 2026-09-25 — ``str(item)`` rendait le repr pydantic
                # du bloc, base64 COMPRIS : une capture PNG de 300 Ko devenait
                # 400 000 caractères de contexte, persistés dans tool_history.
                return _content_block_text(item)
            # Multi-blocs (serveurs MCP externes : texte+texte, texte+image…).
            # Avant : seul c[0] survivait, le reste était perdu SANS marqueur.
            # On concatène les blocs texte et on marque les blocs non-texte —
            # pas de json.loads global (la concaténation n'est pas un JSON).
            parts: list = []
            for item in c:
                if hasattr(item, "text"):
                    parts.append(str(item.text))
                else:
                    parts.append(_content_block_text(item))
            return "\n\n".join(parts)
        # ``content`` vide mais ``structuredContent`` fourni (outil à
        # ``outputSchema`` : le texte n'est qu'un « SHOULD » de la spec MCP) :
        # c'est LUI le résultat — le modèle recevait « [] » et concluait à
        # l'absence de données.
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
    except Exception:
        return False


# Heuristique UNIQUE partagée par le chemin natif, le chemin legacy ET le
# ledger de compression — source : ``engine.result_contract`` (l'historique
# du BUG FIX natif/legacy vit dans la docstring du module partagé).
from llm_core.engine.result_contract import (
    result_is_error as _result_is_error,  # noqa: E402 — import tardif voulu (dépendance circulaire ou coût)
)


def _result_is_tool_failure(result_content: Any) -> bool:
    """True si le résultat dénote un échec de L'OUTIL lui-même — par
    opposition à une COMMANDE utilisateur qui s'est exécutée puis a rendu un
    code de sortie ≠ 0 (pytest rouge, grep sans match, build cassé…).

    ``execute_shell`` renvoie ``{"ok": false, "returncode": N, stdout,
    stderr}`` SANS champ ``error`` quand la commande a tourné : l'outil a
    parfaitement fonctionné et la sortie est exactement l'information
    demandée. Compter ça en « erreur d'outil » (mesuré : 36 % de faux
    échecs sur execute_shell) faussait le taux d'erreur d'observabilité ET
    brûlait le budget d'itérations « productives » sur du travail légitime.
    Un vrai échec d'outil (timeout, sandbox, args invalides) porte toujours
    un code ``error`` — il reste classé échec.
    """
    if not _result_is_error(result_content):
        return False
    try:
        parsed = json.loads(result_content)
    except (json.JSONDecodeError, TypeError, ValueError):
        return True
    if not isinstance(parsed, dict):
        return True
    if parsed.get("ok") is False and "returncode" in parsed and "error" not in parsed:
        return False   # commande exécutée, exit ≠ 0 : l'outil a fait son travail
    return True


# ── tool_call_metrics (observabilité) ────────────────────────────────────────
# L'unique writer de la table ``tool_call_metrics`` vivait dans le moteur
# agentique supprimé : l'onglet admin Observabilité, l'onglet Utilisation
# (/api/usage/me) et les widgets dashboard la lisent toujours mais
# n'affichaient plus que des zéros. La boucle outils du chatbot (les deux
# chemins : natif + fallback legacy) ré-alimente la table ici.
# Cache username→user_id : la table exige un user_id int alors que cette
# couche ne reçoit que ``username`` (résolution 1 fois par user et par vie
# du process, mêmes données que la session).
_TCM_UID_CACHE: Dict[str, int] = {}


def _record_tool_call_metric_safe(username: str,
                                  chat_id: Optional[str],
                                  tool_name: str,
                                  status: str,
                                  duration_ms: int,
                                  error_short: Optional[str] = None) -> None:
    """Écrit une ligne tool_call_metrics — best-effort, jamais bloquant."""
    try:
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
            run_id=str(chat_id or "chat"),
            user_id=uid,
            tool_name=tool_name,
            status=status,
            duration_ms=int(duration_ms),
            error_short=error_short,
        )
    except Exception:
        logger.debug("[tool_call_metrics] record failed (non-fatal)", exc_info=True)


def _clean_json_text(text: str) -> str:
    """Conservé pour compatibilité."""
    s = text.strip()
    s = re.sub(r"^\s*```(?:json)?\s*", "", s, flags=re.IGNORECASE)
    s = re.sub(r"\s*```\s*$", "", s)
    # Strip <tool_call> XML tags (Qwen format)
    s = re.sub(r"</?tool_call>", "", s)
    return s.strip("` \n\r\t")


def _strip_tool_call_markup(text: str) -> str:
    """Retire d'un texte TOUS les blocs d'appel d'outil pour ne garder que la
    prose destinée à l'utilisateur.

    Utilisé sur le chemin de secours « texte libre » : quand llama.cpp ne
    sait pas parser nativement les tool_calls d'un modèle, on récupère les
    appels via ``extract_tool_calls()`` PUIS on nettoie le contenu visible.

    BUG FIX — avant, seul ``<tool_call>...</tool_call>`` (format Qwen) était
    retiré du contenu visible ; les syntaxes ``<function=name>...</function>``
    (Llama/GPT-like — extract_tool_calls strategy 2) restaient affichées
    brutes dans la bulle assistant. On retire désormais les deux dialectes
    (y compris un ``<function=...>`` resté ouvert en fin de flux).
    """
    if not text:
        return text
    s = text
    # 1. Blocs FERMÉS (cas nominal).
    s = re.sub(r"<tool_call>.*?</tool_call>", "", s, flags=re.DOTALL | re.IGNORECASE)
    s = re.sub(r"<function=[^>]*>.*?</function>", "", s, flags=re.DOTALL | re.IGNORECASE)
    # 2. Bloc NON FERMÉ en fin de flux : un appel a commencé mais le modèle
    #    a été coupé avant la balise de fermeture → tout depuis la balise
    #    ouvrante jusqu'à EOF est du markup, pas de la prose. C'est le cas
    #    exact du bug remonté (screenshot : <tool_call> orphelin laissé visible).
    s = re.sub(r"<tool_call>.*$", "", s, flags=re.DOTALL | re.IGNORECASE)
    s = re.sub(r"<function=[^>]*>.*$", "", s, flags=re.DOTALL | re.IGNORECASE)
    # 3. Balises ORPHELINES résiduelles (émission hybride Qwen+Llama : une
    #    balise ouvrante <tool_call> dont le corps a déjà été retiré, ou des
    #    <parameter=>/</function> isolés).
    s = re.sub(r"</?tool_call>", "", s, flags=re.IGNORECASE)
    s = re.sub(r"</?function(?:=[^>]*)?>", "", s, flags=re.IGNORECASE)
    s = re.sub(r"</?parameter(?:=[^>]*)?>", "", s, flags=re.IGNORECASE)
    # GLM-4.5/4.6 : balises d'arguments XML (orphelines après retrait du bloc).
    s = re.sub(r"</?arg_key>", "", s, flags=re.IGNORECASE)
    s = re.sub(r"</?arg_value>", "", s, flags=re.IGNORECASE)
    return s.strip()


# AUDIT 2026-08-31 — streaming DIRECT du contenu sur le chemin outils. L'ancien
# design bufferisait TOUT le contenu puis le rejouait à ~1 000 car/s (12 car +
# sleep 12 ms) : le premier caractère visible n'arrivait qu'à la FIN de la
# génération. La bufferisation ne servait qu'à _strip_tool_call_markup ; elle
# est remplacée par une fenêtre de retenue + un portail : dès qu'une trace de
# markup d'appel d'outil apparaît dans la partie non émise, l'émission directe
# s'arrête pour l'itération (le reste part, nettoyé, en fin d'itération —
# l'ancien comportement). Un FAUX POSITIF du portail est donc bénin.
#
# La fenêtre garantit qu'une AMORCE de balise encore incomplète n'est jamais
# émise (la plus longue amorce discriminante fait ~10 caractères ; 48 laisse de
# la marge sans être perceptible). Les motifs couvrent les dialectes retirés
# par _strip_tool_call_markup + les balises spéciales ``<|…|>`` des dialectes
# de raisonnement inconnus du splitter.
_LIVE_HOLDBACK_CHARS = 48
_LIVE_MARKUP_SUSPECT_RE = re.compile(
    # ``{"name":`` = amorce d'un appel JSON en texte libre (extract_tool_calls
    # strategy JSON pur) : s'il est halluciné vers un outil inconnu, la boucle
    # PURGE le buffer (cf. _looks_like_pure_tool_call_text) — il ne doit donc
    # jamais partir en direct.
    r"<\s*/?\s*(?:tool_call|function|parameter|tools?\b|arg_key|arg_value)"
    r"|<\||\{\s*\"name\"\s*:",
    re.IGNORECASE)


def _live_stream_rest(clean_text: str, raw_text: str, n_emitted: int):
    """Ce qu'il RESTE à émettre d'un texte NETTOYÉ dont un préfixe BRUT de
    ``n_emitted`` caractères est déjà parti en direct.

    ``_strip_tool_call_markup`` termine par ``.strip()`` : le nettoyé peut
    perdre le blanc de tête du brut — on aligne les offsets là-dessus. Retour :
    la queue à émettre (str, possiblement vide), ou ``None`` si le nettoyage a
    MODIFIÉ la partie déjà émise (l'appelant doit resynchroniser ou renoncer)."""
    if n_emitted <= 0:
        return clean_text
    lead_ws = len(raw_text) - len(raw_text.lstrip())
    eff = n_emitted - lead_ws
    if eff <= 0:
        return clean_text
    if clean_text[:eff] == raw_text[lead_ws:n_emitted]:
        return clean_text[eff:]
    return None

# Traces de markup d'appel d'outil (ouvrantes OU fermantes). Les fermantes
# comptent SEULES : quand le modèle émet le dialecte XML (<tool_call>
# <function=…><parameter=…>) HORS canal natif, le parseur du serveur consomme
# les balises ouvrantes en tentant un parse natif, échoue (ce n'est pas le JSON
# attendu), et seules les fermantes atteignent le client — souvent dans le
# canal reasoning. Vu en prod 2026-07-12 : tour mort à 35 tokens, réponse
# « Je vais créer… </parameter></function></tool_call> », aucun outil exécuté.
_TOOL_MARKUP_TRACE_RE = re.compile(
    r"</?tool_call>|</?function(?:=[^>]*)?>|</parameter>", re.IGNORECASE)

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


def _looks_like_pure_tool_call_text(raw_text: str) -> bool:
    """
    Détecte un texte qui est *intégralement* une tentative d'appel d'outil
    (XML <tool_call>, <function=...>, ou JSON pur) — par opposition à de la
    prose normale qui contiendrait un exemple JSON à des fins pédagogiques.

    Utilisé pour supprimer du flux utilisateur les appels d'outils dont le
    nom ne correspond à aucun outil enregistré (hallucination du modèle),
    sans pour autant masquer les réponses légitimes qui mentionnent du JSON.
    """
    if not raw_text:
        return False
    s = raw_text.strip()
    if not s:
        return False
    # Tout le texte = un bloc <tool_call>...</tool_call> (format Qwen)
    if re.fullmatch(r"\s*<tool_call>.*?</tool_call>\s*", s, re.DOTALL | re.IGNORECASE):
        return True
    # Tout le texte = un bloc <function=nom>...</function> (format Llama)
    if re.fullmatch(r"\s*<function=[^>]+>.*?</function>\s*", s, re.DOTALL | re.IGNORECASE):
        return True
    # Tout le texte = du JSON pur (éventuellement dans ```json ... ```)
    try:
        json.loads(_clean_json_text(s))
        return True
    except (json.JSONDecodeError, TypeError, ValueError):
        return False


def _recover_tool_calls_from_reasoning(
    reasoning_text: str, known_names: Optional[set] = None,
) -> List[Dict[str, Any]]:
    """Récupère un appel d'outil PIÉGÉ dans le canal *reasoning*.

    Échec connu des modèles « thinking » (Qwen3, GLM-4.5/4.6) : l'appel part
    dans ``reasoning_content`` / ``<think>`` au lieu du canal ``tool_calls``
    natif → ni exécuté, ni affiché comme réponse (juste visible, brut, dans le
    panneau réflexion). On ne tente la récupération QUE si le reasoning porte un
    markup d'appel EXPLICITE (``<tool_call>`` / ``<function=``) — garde-fou
    contre un modèle qui *raisonnerait* sur un appel sans l'émettre. Si
    ``known_names`` est fourni, on ne promeut QUE les appels dont le nom est un
    outil réellement enregistré (sinon un exemple/hallucination émis dans la
    réflexion serait exécuté). Renvoie une liste de tool_calls au format OpenAI
    (``[]`` si rien d'exploitable)."""
    if not reasoning_text or not re.search(r"<tool_call>|<function=", reasoning_text, re.IGNORECASE):
        return []
    try:
        rec = extract_tool_calls(reasoning_text)
    except Exception:
        return []
    if not rec:
        return []
    if known_names is not None:
        rec = [(n, a) for (n, a) in rec if n in known_names]
        if not rec:
            return []
    return [{
        "id": f"call_{i}",
        "type": "function",
        "function": {"name": n, "arguments": json.dumps(a, ensure_ascii=False)},
    } for i, (n, a) in enumerate(rec)]


# Tâches d'arrêt détachées : on les référence pour qu'elles ne soient pas
# ramassées par le GC avant d'avoir abouti (asyncio ne garde qu'une weakref).
_CANCEL_TASKS: set = set()


def _fire_cancel_stream(client, target, conv_id: str, model: str) -> None:
    """Demande au moteur d'arrêter la session, SANS attendre.

    On est déjà dans l'unwind d'une annulation : tout ``await`` ici serait
    ré-annulé immédiatement. La tâche détachée, elle, aboutit.
    """
    if not conv_id:
        return
    from llm_core.providers.llama_stream import cancel_stream
    base = _endpoint_base(getattr(target, "base_url", "") or LLAMA_URL)
    try:
        # En-tête d'auth du serveur visé (AUDIT 2026-09-16) : sans lui, l'arrêt
        # d'un llama-server protégé par ``--api-key`` rendait 401 et le modèle
        # continuait de générer.
        from llm_core.providers.openai_compat import headers as _auth_headers
        t = asyncio.create_task(cancel_stream(
            client, base, conv_id, model, headers=_auth_headers(target)))
    except RuntimeError:
        return          # plus de boucle (arrêt du worker) : rien à faire
    _CANCEL_TASKS.add(t)
    t.add_done_callback(_CANCEL_TASKS.discard)


def _reasoning_cap_chars(payload: Dict[str, Any]) -> int:
    """Seuil de fermeture du raisonnement, EN CARACTÈRES. 0 = jamais.

    Deux sources, la plus basse gagne :
      - le budget souple explicite (``llama.reasoning_soft_budget_tokens``,
        0 par défaut : rien) ;
      - 80 % du plafond de génération de la requête, QUAND il y en a un. Ce
        n'est pas une limite nouvelle : c'est celle qui existe déjà et qui,
        aujourd'hui, coupe le raisonnement au milieu d'une phrase. Sans
        ``max_tokens`` — le cas de la réflexion volontairement non plafonnée
        en local — il n'y a pas de seuil du tout.
    """
    from llm_core.context.tokens import CHARS_PER_TOKEN
    from shared_infra.config import LLAMA_REASONING_SOFT_BUDGET_TOKENS as _soft
    caps = []
    if _soft and int(_soft) > 0:
        caps.append(int(_soft))
    _mt = payload.get("max_tokens")
    if isinstance(_mt, int) and _mt > 0:
        caps.append(int(_mt * 0.8))
    if not caps:
        return 0
    return int(min(caps) * CHARS_PER_TOKEN)


def _publish_completion(inner, sse, chat_id: Optional[str], model: str):
    """Enveloppe ``on_thinking_token`` : dépose une fois l'``id`` de la
    complétion en cours dans le magasin partagé (cf.
    ``shared_infra.llm.reasoning_control``)."""
    done = [False]

    async def _wrapped(segment: str):
        if inner:
            await inner(segment)
        if done[0] or not chat_id or not sse.completion_id:
            return
        done[0] = True
        with swallow("harness.reasoning_control.note"):
            from llm_core.engines import current_engine
            from shared_infra.llm.reasoning_control import note_completion

            # AUDIT 2026-09-01 (passe 6, B12) — l'écriture fichier (makedirs +
            # open + json.dump + os.replace) partait du callback de token, en
            # SYNC sur la boucle, une fois par itération de la boucle d'outils
            # (nouvelle complétion par appel LLM). Fire-and-forget ORDONNÉ
            # via le thread unique de ``shared_infra.runtime.ordered_io`` (passe 7,
            # R8 : l'exécuteur par défaut est multi-thread → deux écritures
            # last-write-wins du même tour pouvaient s'inverser) ; la valeur
            # de ``completion_id`` est capturée MAINTENANT, pas au moment où
            # le thread s'exécute.
            from shared_infra.runtime.ordered_io import submit_ordered
            _cid = sse.completion_id
            submit_ordered("reasoning_control.note", note_completion,
                           chat_id, _cid, model, current_engine().key)
    return _wrapped


def _reasoning_guard(inner, cap_chars: int, sse, client, target,
                     model: str, req_id: str):
    """Enveloppe ``on_thinking_token`` : demande la fermeture du bloc de
    raisonnement une seule fois, quand il dépasse ``cap_chars``."""
    seen = [0]
    fired = [False]

    async def _wrapped(segment: str):
        if inner:
            await inner(segment)
        if fired[0]:
            return
        seen[0] += len(segment or "")
        if seen[0] < cap_chars or not sse.completion_id:
            return
        fired[0] = True
        from llm_core.providers.llama_stream import end_reasoning
        base = _endpoint_base(getattr(target, "base_url", "") or LLAMA_URL)
        logger.warning(
            "[LLM_REQ %s] raisonnement au-delà du seuil (~%d caractères) → "
            "fermeture demandée au moteur (le modèle passe à la réponse ; "
            "rien n'est tronqué)", req_id, seen[0])
        try:
            from llm_core.providers.openai_compat import headers as _auth_headers
            t = asyncio.create_task(
                end_reasoning(client, base, sse.completion_id, model,
                              headers=_auth_headers(target)))
        except RuntimeError:
            return
        _CANCEL_TASKS.add(t)
        t.add_done_callback(_CANCEL_TASKS.discard)
    return _wrapped


def _endpoint_base(url: str) -> str:
    """Racine du serveur à partir de l'URL de complétion (``…/v1/chat/
    completions`` → ``…``) : les routes de flux reprenable sont voisines, pas
    filles, de celle-ci."""
    u = (url or "").rstrip("/")
    # AUDIT 2026-08-23 — ``/v1`` MANQUAIT de cette liste, alors que les deux
    # autres implémentations du même calcul (``llama_caps._base`` et
    # ``chats.py``) le retirent. Or un connecteur OpenAI-compatible stocke
    # justement une base en ``…/v1`` : on construisait donc
    # ``GET …/v1/v1/stream``, ``POST …/v1/v1/streams/lookup`` et
    # ``DELETE …/v1/v1/stream``. La reprise d'un flux coupé rendait None (fin
    # de tour perdue) et le « Stop » partait sur un 404 classé en succès — si
    # le distant supporte les sessions nommées, la génération n'était JAMAIS
    # arrêtée. L'ordre compte : les suffixes les plus longs d'abord.
    for suffix in ("/v1/chat/completions", "/chat/completions",
                   "/v1/completions", "/v1"):
        if u.endswith(suffix):
            return u[: -len(suffix)]
    return u


def _skipping(cb, already: int):
    """Enveloppe un callback de token pour SAUTER les ``already`` premiers
    caractères déjà envoyés au client.

    La reprise rejoue le flux DEPUIS LE DÉBUT (le tampon du serveur est
    indexé en octets ; nos compteurs sont en caractères — les faire coïncider
    sur de l'UTF-8 serait une source de bugs silencieux). On relit donc tout et
    on ne ré-émet que ce que l'utilisateur n'a pas déjà lu : zéro duplication
    à l'écran, et le résultat final est complet.
    """
    remaining = [max(0, int(already))]

    async def _wrapped(segment: str):
        if remaining[0] > 0:
            n = min(remaining[0], len(segment))
            remaining[0] -= n
            segment = segment[n:]
            if not segment:
                return
        if cb:
            await cb(segment)
    return _wrapped


def _keep_resumed_text(previous, fresh) -> None:
    """Reprise coupée à son tour : le partiel rendu doit couvrir tout ce que
    l'écran a reçu.

    AUDIT 2026-09-24 (n° 14) — la reprise rejoue le flux depuis le début et
    n'émet que ce qui dépasse ``previous`` (cf. ``_skipping``). Si elle meurt
    en route, l'écran a pourtant reçu ce surplus, alors que l'appelant
    rendait ``previous`` seul : le partiel persisté était plus COURT que ce
    que l'utilisateur venait de lire, et « Continuer » repartait de trop loin.
    On recopie donc, canal par canal, le plus long des deux EN PLACE dans
    les listes de ``previous`` — ce sont les tampons de garde de l'appelant
    (sink), qui les relit tels quels pour son partiel."""
    if previous is None or fresh is None:
        return
    for _attr in ("content_parts", "thinking_parts"):
        _old = getattr(previous, _attr, None)
        _new = getattr(fresh, _attr, None)
        if _old is None or not _new:
            continue
        if len("".join(_new)) > len("".join(_old)):
            _old[:] = list(_new)


async def _resume_cut_stream(client, target, conv_id: str, model: str,
                             err: BaseException, *, req_id: str, user_id: str,
                             previous, is_cancelled,
                             on_thinking_token, on_content_token,
                             stream_timeout):
    """Reprend un flux coupé par le TRANSPORT, depuis le tampon du moteur.

    Retourne le résultat COMPLET (flux rejoué du début, tokens déjà lus non
    ré-émis), ou ``None`` quand la reprise n'est pas possible — l'appelant
    retombe alors intégralement sur le comportement historique (partiel +
    bouton « Continuer »).

    Ne s'applique qu'aux coupures de transport : un refus HTTP (4xx/5xx) n'a
    créé aucune session à reprendre, et une annulation est un ARRÊT voulu.
    """
    if not conv_id or isinstance(err, asyncio.CancelledError):
        return None
    if isinstance(err, httpx.HTTPStatusError):
        return None
    base = _endpoint_base(getattr(target, "base_url", "") or LLAMA_URL)
    from llm_core._stream_tag_parser import ThinkTagSplitter
    from llm_core.providers.llama_stream import lookup_streams, resume_request
    from llm_core.providers.llamacpp import SseStreamResult, consume_llama_sse
    from llm_core.providers.openai_compat import headers as _auth_headers
    _hdrs = _auth_headers(target)
    live = await lookup_streams(client, base, [conv_id], model, headers=_hdrs)
    row = live.get(conv_id)
    if not row:
        logger.info("[LLM_REQ %s] flux coupé (%s) et aucune session reprenable "
                    "— repli sur le partiel", req_id, type(err).__name__)
        return None
    logger.warning(
        "[LLM_REQ %s] flux coupé (%s) → REPRISE depuis le tampon du moteur "
        "(%s octets déjà produits, terminé=%s)",
        req_id, type(err).__name__, row.get("total_bytes"), row.get("is_done"))

    seen_content = len("".join(previous.content_parts)) if previous else 0
    seen_think = len("".join(previous.thinking_parts)) if previous else 0
    fresh = SseStreamResult()
    try:
        async with resume_request(client, base, conv_id, model,
                                  from_bytes=0, timeout=stream_timeout,
                                  headers=_hdrs) as r2:
            if r2.status_code != 200:
                return None
            await consume_llama_sse(
                r2, tag_splitter=ThinkTagSplitter(), req_id=req_id,
                user_id=user_id, is_cancelled=is_cancelled,
                on_thinking_token=_skipping(on_thinking_token, seen_think),
                on_content_token=_skipping(on_content_token, seen_content),
                # Pré-stream d'outils volontairement MUET sur la reprise : le
                # front a déjà reçu les deltas du début, les re-jouer ferait
                # clignoter des cartes d'outils déjà affichées. La structure
                # finale, elle, est bien reconstruite dans ``fresh``.
                on_tool_call_delta=None,
                sink=fresh,
            )
    except asyncio.CancelledError:
        raise
    except Exception as e2:
        logger.warning("[LLM_REQ %s] reprise du flux impossible (%s) — repli "
                       "sur le partiel", req_id, str(e2)[:150])
        _keep_resumed_text(previous, fresh)
        return None
    logger.info("[LLM_REQ %s] reprise réussie : %d caractères au total "
                "(%d déjà lus, %d rendus à l'écran)", req_id,
                len(fresh.content()), seen_content,
                max(0, len(fresh.content()) - seen_content))
    return fresh


async def _llama_chat_with_tools_stream(
    messages: List[Dict],
    tools_payload: List[Dict],
    model_override: Optional[str] = None,
    user_id: str = "guest",
    on_thinking_token: Optional[Callable] = None,
    on_content_token:  Optional[Callable] = None,
    on_tool_call_delta: Optional[Callable] = None,
    on_prompt_progress: Optional[Callable] = None,
    is_cancelled:      Optional[Callable[[], bool]] = None,
    sampling_override: Optional[Dict[str, Any]] = None,
    thinking_mode:     bool = False,
    chat_id:           Optional[str] = None,
    resume_think:      Optional[str] = None,
    resume_native_ok:  bool = True,
    resume_content:    Optional[str] = None,
    tool_choice:       str = "auto",
) -> Dict[str, Any]:
    """
    POST /v1/chat/completions avec tools[] en mode stream:True.

    ``tool_choice`` : ``"none"`` pour un tour qui garde ``tools[]`` (préfixe
    KV identique aux itérations) sans offrir d'appel — tour de synthèse.
    Vérifié dans llama.cpp (``oaicompat_chat_params_parse`` puis
    ``common_chat_templates_apply``) : les outils restent rendus dans le
    gabarit, seules la grammaire et l'analyse d'appels sont désactivées.

    ``resume_think`` (auto-reprise d'un raisonnement coupé par le plafond) :
    raisonnement accumulé à POURSUIVRE. Mode natif ``continue_final_message``
    tenté d'abord (reprise token-exacte DANS le bloc think, KV-cache-friendly) ;
    un 4xx bascule en repli prefill ``<think>`` non fermé (+ mémorisation du
    non-support via ``note_continue_final_support``). ``tools[]`` est conservé :
    le modèle peut conclure sa réflexion PUIS appeler un outil.

    Reconstruit les tool_calls depuis les deltas SSE.
    Émet thinking_token / tool_thinking en temps réel.

    ``on_tool_call_delta(index, name_delta, args_delta)`` : callback appelé à
    chaque fragment d'argument / nom reçu depuis llama.cpp AVANT que le tool
    soit exécuté. Utilisé pour pré-afficher en streaming le contenu que le
    modèle va écrire (write_file, edit_file) dans l'éditeur côté frontend.
    Les fragments sont des strings JSON brutes — au frontend de les décoder
    progressivement.

    Fallback automatique vers stream:False si le serveur répond 500
    (certains serveurs ne supportent pas stream+tools).
    Retourne un dict normalisé format non-streaming.
    """
    from llm_core._target import current_target
    _target = current_target()
    # cf. _chat_classic : ``_llama_native`` (TYPE du fournisseur SEUL) garde les
    # extensions de payload pour toute cible llama.cpp ; ``_llamacpp_srv`` gate
    # les appels aux endpoints spécifiques d'un llama-server (/props, /slots),
    # qui suivent le serveur de la CIBLE depuis le 2026-09-16 (intégré OU
    # connecteur llama.cpp) — un moteur vLLM/générique ne les expose pas.
    _llama_native = _target.provider_type == "llamacpp"
    _llamacpp_srv = _target.is_llamacpp
    target_model = model_override or _target.model or LLAMA_MODEL
    # Normalisation pour les templates STRICTS : un seul ``system`` en tête. L'app
    # injecte un 2e system (runtime_context + capacités) quand des outils fs/shell/
    # git sont actifs → Qwen3.5 & co lèvent « System message must be at the
    # beginning » (HTTP 400). cf. _coalesce_system_messages. Étape DISTINCTE du
    # clamp (concern séparé) appliquée juste avant l'envoi.
    # Plus de clamp en NOMBRE de messages (LLAMA_MAX_MSGS retiré 2026-07-28) :
    # la seule borne est le budget en TOKENS (fit_context / budget dur en
    # amont). Si le prompt dépasse malgré tout la fenêtre, le serveur répond
    # « contexte dépassé » → message utilisateur clair (KIND_CONTEXT_OVERFLOW),
    # au lieu d'une amnésie silencieuse des vieux messages.
    # Clés INTERNES du harnais (``_ephemeral``…) retirées ICI, au dernier
    # moment : elles pilotent le comptage de tours côté app mais sont des
    # champs INCONNUS pour un fournisseur strict (400 à l'envoi). Le strip
    # opère sur la copie transitoire — la vue de la boucle les garde.
    msgs = _coalesce_system_messages(_strip_internal_keys(list(messages)))

    # ── Connecteur Anthropic natif : délègue à l'adaptateur /v1/messages ──
    # Renvoie un dict OpenAI non-streaming (mêmes choices/usage) → la boucle
    # agentique appelante reste inchangée.
    if _target.wire == "anthropic":
        from llm_core.providers.anthropic import anthropic_chat_with_tools_stream
        # Messages NON strippés : l'adaptateur relit ``_anthropic_thinking``
        # (blocs signés à rejouer) et reconstruit de toute façon chaque
        # message — aucune clé interne n'atteint l'API.
        return await anthropic_chat_with_tools_stream(
            _coalesce_system_messages(list(messages)), tools_payload, target=_target, model=target_model,
            on_thinking_token=on_thinking_token, on_content_token=on_content_token,
            on_tool_call_delta=on_tool_call_delta, is_cancelled=is_cancelled,
            sampling_override=sampling_override, thinking_mode=thinking_mode,
            chat_id=chat_id,
        )

    # ── Traçage multi-user ─────────────────────────────────────────────────
    import uuid as _uuid
    _req_id = _uuid.uuid4().hex[:8]
    _prompt_chars = sum(len((m.get("content") or "")) for m in msgs if isinstance(m.get("content"), str))

    if tools_payload:
        logger.info(
            "[LLM_REQ %s] START_TOOLS user=%r model=%r n_tools=%d msgs=%d prompt_chars=%d",
            _req_id, user_id, target_model, len(tools_payload), len(msgs), _prompt_chars,
        )
    else:
        logger.info(
            "[LLM_REQ %s] START_TOOLS user=%r model=%r (pas d'outils) msgs=%d prompt_chars=%d",
            _req_id, user_id, target_model, len(msgs), _prompt_chars,
        )

    # ── Paramètres de sampling : pilotés par /props du modèle + override UI ──
    # Avant : temperature=0.2 hardcodé. Maintenant : les valeurs viennent du GGUF
    # (calibré par l'auteur pour un bon tool-calling), et l'utilisateur peut
    # ajuster via sampling_override envoyé depuis le frontend.
    #
    # Note sur ``thinking_mode`` : le paramètre est ACCEPTÉ (signature
    # kwargs-compatible avec run_chat_multi_mcp et la classic path) mais
    # il N'INJECTE PAS ``payload["thinking"]`` ici — contrairement à la
    # classic path. Raison : sur certaines builds llama.cpp, la combinai-
    # son ``thinking`` + ``tools[]`` déclenche un 400 Bad Request au
    # niveau du parseur de payload. Le thinking en mode tools est piloté
    # par le chat_template du modèle lui-même (Qwen3 et dérivés ont un
    # ``enable_thinking=true`` par défaut dans leur template, donc le
    # modèle pense naturellement même sans hint explicite dans le
    # payload). Le ``task`` passé à ``resolve_sampling`` reflète quand
    # même le mode pour que les paramètres de sampling (temperature,
    # top_p) soient cohérents avec le mode de génération attendu.
    if _llamacpp_srv:
        from llm_core._llm_params import resolve_sampling
        sampling_params = await resolve_sampling(
            model_id=target_model,
            task=("thinking" if thinking_mode else "tools"),
            request_override=sampling_override,
        )
    else:
        # Cible distante (cloud/vLLM) : pas d'interrogation du /props LOCAL.
        from llm_core.providers.openai_compat import remote_sampling
        sampling_params = remote_sampling(sampling_override)

    # Corps de requête COMMUN aux deux moteurs (→ providers.llamacpp) :
    # skeleton + KV-cache + clamp de génération adaptatif au n_ctx +
    # chat_template_kwargs + slot pinning. IMPORTANT : ce chemin ne pose PAS
    # ``payload["thinking"]`` même en thinking_mode — thinking + tools[] → 400
    # côté llama.cpp ; le thinking passe par chat_template_kwargs (posé dans
    # build_llama_payload). Le ``task`` de sampling reflète quand même le mode.
    from llm_core._llm_params import (
        sanitize_preserve_reasoning,
        sanitize_reasoning_effort,
    )

    # ── Transport selon la cible (connecteur) ─────────────────────────────
    # Défaut (llama.cpp intégré) : client partagé + LLAMA_URL + payload
    # inchangé. OpenAI-compatible distant : client dédié + URL chat/completions
    # + Bearer + retrait des champs llama-only (sinon 400 côté cloud).
    from llm_core.providers import openai_compat as _oai
    from llm_core.providers.llamacpp import build_llama_payload as _build_payload
    client, _req_url, _req_headers = _oai.endpoint(_target)
    # ── Flux REPRENABLE (llama-server b10545+) ───────────────────────────────
    # Adosse la génération à une session nommée côté moteur : une coupure du
    # transport (veille du portable, proxy, recyclage de worker, read-timeout)
    # ne la tue plus, et on relit le tampon au lieu de perdre la fin du tour.
    # ⚠ En contrepartie, fermer le flux n'arrête plus le modèle : l'arrêt passe
    # par ``cancel_stream`` (câblé sur l'annulation, plus bas).
    _conv_id = ""
    if _llama_native and LLAMA_RESUMABLE_STREAM and chat_id:
        # ⚠ Ici la PREUVE est exigée : nommer la session n'a de sens que si
        # ``/v1/stream`` existe en face. Sur un build ancien l'en-tête serait
        # ignoré, mais la reprise se solderait par un 404 à chaque coupure —
        # et surtout ``DELETE /v1/stream`` n'arrêterait rien, alors que tout
        # le contrat d'annulation repose dessus. Moteur non identifié ⇒ flux
        # non nommé, non reprenable : le comportement d'avant.
        # AUDIT 2026-08-23 — sonder la cible RÉELLE. Sans ``base_url``,
        # ``engine_caps`` retombe sur ``LLAMA_URL``, c'est-à-dire le moteur
        # LOCAL — alors que la garde d'entrée est ``_llama_native``, vraie
        # aussi pour un CONNECTEUR llama.cpp distant. On décidait donc des
        # capacités du serveur B en interrogeant le serveur A, ce que la
        # docstring de ``llama_caps`` présente pourtant comme « une PREUVE,
        # pas une déduction ». Le cache est indexé par base : le coût reste
        # d'une requête toutes les 5 minutes et par serveur.
        # AUDIT 2026-09-16 — le SERVEUR de la cible (``EngineRef``), pas sa
        # seule base : la sonde part avec l'en-tête d'auth (la base seule
        # rendait 401 sur un llama-server protégé par ``--api-key``).
        from llm_core.engines import current_engine as _cur_engine
        from llm_core.providers.llama_caps import engine_caps as _eng_caps
        if (await _eng_caps(engine=_cur_engine())).resumable_stream:
            from llm_core.providers.llama_stream import (
                conversation_id as _conv_of,
                headers_with_conv as _hdr_conv,
            )
            _conv_id = _conv_of(user_id, chat_id)
            _req_headers = _hdr_conv(_req_headers, _conv_id)

    # Reprise : mode natif tenté d'abord, SAUF non-support mémorisé ou
    # ``resume_native_ok=False`` (le raisonnement du tour coupé est arrivé par
    # BALISES <think> dans content — serveur en --reasoning-format none — où
    # une continuation native arriverait sans balise ouvrante et serait
    # classée content) → repli « conclusion » directement.
    _resume_native = False
    if resume_think is not None and _llamacpp_srv:
        from llm_core._llm_params import continue_final_support
        _resume_native = bool(resume_native_ok
                              and continue_final_support(target_model) is not False)

    async def _build_full_payload(*, native_resume: bool) -> Dict[str, Any]:
        """Payload complet (skeleton + reprise éventuelle + tools[] + sanitize).

        Factorisé pour être REJOUABLE : un 4xx sur la reprise native bascule en
        repli prefill et reconstruit le payload sans dupliquer ce bloc."""
        _m = msgs
        _tm = thinking_mode
        _flags: Dict[str, Any] = {}
        if resume_content is not None:
            # Reprise de PROSE : uniquement le canal natif (l'appelant l'a
            # déjà vérifié via should_auto_resume_content). Le serveur re-rend
            # le dernier message assistant NON fermé et continue dedans.
            from llm_core._think_resume import build_content_resume_tail
            _tail, _flags = build_content_resume_tail(resume_content)
            _m = msgs + _tail
        elif resume_think is not None:
            from llm_core._think_resume import build_resume_tail
            _tail, _flags = build_resume_tail(resume_think, native=native_resume)
            _m = msgs + _tail
            if not native_resume:
                # Prefill assistant ⟂ enable_thinking (llama.cpp) : le repli
                # coupe le kwarg de template.
                # ⚠ AUDIT 2026-08-23 — la phrase « le flux de continuation est
                # routé en thinking via ThinkTagSplitter(start_in_think=True) »
                # a été retirée : elle était FAUSSE depuis que le repli de
                # reprise a basculé d'un prefill ``<think>`` NON fermé à un
                # prefill FERMÉ + consigne de conclusion (``_think_resume``).
                # La continuation est routée en CONTENU, et c'est voulu.
                _tm = False
        # reasoning_effort passe par chat_template_kwargs (posé dans
        # build_llama_payload) : compatible tools[] — contrairement à
        # payload["thinking"], c'est le template qui consomme le kwarg.
        p: Dict[str, Any] = await _build_payload(
            _m, target_model=target_model, user_id=user_id,
            sampling_params=sampling_params, llama_native=_llama_native,
            local_llamacpp=_llamacpp_srv, thinking_mode=_tm,
            chat_id=chat_id,
            reasoning_effort=sanitize_reasoning_effort(sampling_override),
            preserve_reasoning=sanitize_preserve_reasoning(sampling_override),
        )
        p.update(_flags)
        if tools_payload:
            # Filet de sécurité au POINT D'ENVOI : normalise le JSON Schema de CHAQUE
            # outil pour le convertisseur grammaire de llama.cpp (retrait des schémas
            # booléens — cf. _sanitize_schema_for_grammar). Couvre TOUTE source d'outil
            # (MCP déjà normalisé à la conversion, builtins, legacy) : un seul schéma
            # booléen (champ pydantic Any/list/tuple) faisait 400 TOUTE la requête sur
            # les builds llama.cpp récents. Idempotent.
            _norm_payload = []
            for _t in tools_payload:
                _fn = (_t.get("function") or {}) if isinstance(_t, dict) else {}
                _params = _fn.get("parameters")
                if isinstance(_params, dict):
                    _t = {**_t, "function": {**_fn, "parameters": _sanitize_schema_for_grammar(_params)}}
                _norm_payload.append(_t)
            # Ordre DÉTERMINISTE (tri stable par nom) → la sérialisation de tools[]
            # est byte-identique d'un tour à l'autre. Les définitions d'outils sont
            # rendues EN TÊTE du prompt par le chat template ; un ordre qui varierait
            # (itération du pool MCP, reconnexion d'un serveur) casserait le
            # prefix-cache dès le préfixe. Le SET d'outils est inchangé — seul
            # l'ordre est figé.
            p["tools"] = sorted(
                _norm_payload,
                key=lambda _t: ((_t.get("function") or {}).get("name") or ""),
            )
            p["tool_choice"] = tool_choice if tool_choice in ("auto", "none") else "auto"
        _oai.sanitize_payload(p, _target)
        return p

    payload: Dict[str, Any] = await _build_full_payload(native_resume=_resume_native)

    # Read-timeout du flux adapté à la fenêtre du modèle (prefill silencieux :
    # cf. rationale dans _client.stream_timeout_for_ctx). Cible LOCALE
    # seulement — le prefill d'un fournisseur distant est côté cloud. Le
    # kwarg n'est passé QUE si la fenêtre impose d'élargir le read au-delà du
    # défaut client (petit modèle → requête byte-identique à avant).
    _stream_to = None
    if _llamacpp_srv:
        try:
            from llm_core._client import stream_timeout_for_ctx
            from llm_core.providers.llama_stream import has_alive_signal
            if has_alive_signal(target_model):
                # Moteur qui a DÉJÀ prouvé qu'il ping pendant le silence : le
                # read-timeout n'a plus à couvrir toute la durée du
                # pré-remplissage, seulement un trou de ping. Un moteur
                # vraiment planté est donc détecté en une minute au lieu du
                # plafond étiré — et, s'il ne l'était pas, la reprise
                # rattraperait le flux de toute façon.
                from shared_infra.config import LLAMA_SSE_PING_INTERVAL_S
                _read_s = max(60.0, 4.0 * float(LLAMA_SSE_PING_INTERVAL_S or 15))
                _stream_to = httpx.Timeout(LLAMA_TIMEOUT_SEC, connect=15.0,
                                           read=_read_s)
            else:
                _cand = stream_timeout_for_ctx(
                    await get_model_context_size(target_model))
                if (_cand.read or 0) > float(LLAMA_TIMEOUT_SEC):
                    _stream_to = _cand
        except Exception:
            _stream_to = None

    last_err = None
    for attempt in range(LLAMA_RETRIES + 1):
        tool_calls_acc: Dict[int, Dict] = {}
        content_parts:  List[str]       = []
        thinking_parts: List[str]       = []
        usage:          Dict            = {}
        timings:        Dict            = {}
        finish_reason:  str             = ""
        # Same robust splitter as the no-tools path. See note above
        # ``ThinkTagSplitter`` import — without this, a ``<think>`` /
        # ``</think>`` tag split across SSE chunks went undetected and
        # the model's actual response stayed trapped in thinking_parts.
        tag_splitter:   ThinkTagSplitter = ThinkTagSplitter()
        # See same flag in llama_chat_stream_tokens — when the model
        # already wrote reasoning via the native ``reasoning_content``
        # channel, any later ``<think>`` block in ``content`` is most
        # likely a duplicate, not new reasoning. Route it as content.
        stream_pre_emitted_thinking: bool = False

        try:
            async with client.stream(
                "POST", _req_url, json=payload, headers=_req_headers,
                **({"timeout": _stream_to} if _stream_to is not None else {}),
            ) as resp:
                # En streaming, httpx ne lit PAS le corps : ``raise_for_status``
                # ne produit alors que « Client error '400 Bad Request' for url
                # … », et le motif réel du refus — contexte dépassé vs schéma
                # d'outil invalide — est définitivement perdu. On lit le corps
                # AVANT de lever, pour que ``llm_error_kind`` puisse le
                # classer et l'utilisateur recevoir un message actionnable.
                # Uniquement sur erreur : lire un 200 ici bufferiserait tout
                # le flux et tuerait le streaming.
                if resp.status_code >= 400:
                    with swallow("harness.llama_chat_with_tools_stream"):
                        await resp.aread()
                # ── 500 = parser tool_call llama.cpp en panne (Qwen3, etc.) ─
                # Stratégie de fallback en 2 temps :
                # 1) Retry non-streaming AVEC tools (peut-être juste un bug de stream)
                # 2) Si ça échoue encore → retry SANS tools, on demande au LLM
                #    de répondre en texte libre, puis on parse via extract_tool_calls
                #    qui supporte XML <tool_call>, JSON, <function=>, etc.
                if resp.status_code == 500:
                    logger.info("[tools_stream] 500 sur stream+tools → fallback non-streaming avec tools")
                    fb_payload = {**payload, "stream": False}
                    fb_payload.pop("thinking", None)
                    try:
                        fb_resp = await client.post(
                            _req_url, json=fb_payload, headers=_req_headers,
                        )
                        fb_resp.raise_for_status()
                        data = fb_resp.json()
                        msg = (data.get("choices") or [{}])[0].get("message") or {}
                        _rc = (msg.get("reasoning_content") or "").strip()
                        _ct = (msg.get("content") or "").strip()
                        if not _rc:
                            _rc, _ct = _extract_thinking(_ct)
                            # Le raisonnement extrait QUITTE le contenu : sinon
                            # il repartait dans l'historique (``_iter_clean``)
                            # et dans le parseur d'appels en texte, la boucle
                            # sautant sa propre extraction dès qu'un thinking a
                            # été émis.
                            if _rc and isinstance(msg, dict):
                                msg["content"] = _ct
                                msg["reasoning_content"] = _rc
                        if _rc and on_thinking_token:
                            for i in range(0, len(_rc), 40):
                                await on_thinking_token(_rc[i:i+40])
                        return data
                    except Exception as fb_err:
                        # Étape 2 : llama.cpp ne sait toujours pas parser les tool_calls
                        # de ce modèle (Qwen3-Coder etc.). On retry SANS tools et on
                        # parse nous-mêmes la sortie texte libre.
                        logger.warning("[tools_stream] Fallback non-stream a aussi échoué (%s) → retry SANS tools, parsing manuel",
                                       str(fb_err)[:200])
                        no_tools_payload = {k: v for k, v in payload.items() if k not in ("tools", "tool_choice")}
                        no_tools_payload["stream"] = False
                        no_tools_payload.pop("thinking", None)
                        # Hint pour le modèle : il doit émettre du texte (avec
                        # éventuellement <tool_call> XML) au lieu d'attendre un schema
                        try:
                            nt_resp = await client.post(
                                _req_url, json=no_tools_payload, headers=_req_headers,
                            )
                            nt_resp.raise_for_status()
                            nt_data = nt_resp.json()
                            nt_choice = (nt_data.get("choices") or [{}])[0] or {}
                            nt_msg = nt_choice.get("message") or {}
                            nt_text = nt_msg.get("content") or ""
                            # AUDIT 2026-09-24 (n° 1b) — le VRAI motif de fin
                            # est conservé. Il était remplacé par
                            # « tool_calls »/« stop » : un appel coupé par le
                            # plafond (``length``) partait à l'exécution avec
                            # des arguments amputés, et une prose tronquée
                            # était rendue sans « Continuer ». ``length`` est
                            # propagé tel quel — la boucle a déjà ses gardes
                            # de troncature (canal natif ET texte) : l'appel
                            # n'est pas exécuté, le tour est relancé ou offert
                            # à « Continuer ».
                            nt_length = (str(nt_choice.get("finish_reason")
                                             or "") == "length")
                            # Parse les tool_calls éventuels via notre extracteur
                            from_text_calls = extract_tool_calls(nt_text)
                            if from_text_calls:
                                # Construit une réponse compatible OpenAI tool_calls format
                                built_tcs = []
                                for i, (tname, targs) in enumerate(from_text_calls):
                                    built_tcs.append({
                                        "id": f"call_{i}",
                                        "type": "function",
                                        "function": {
                                            "name": tname,
                                            "arguments": json.dumps(targs, ensure_ascii=False),
                                        },
                                    })
                                # Strip TOUS les blocs d'appel d'outil du
                                # contenu visible (Qwen <tool_call> ET Llama
                                # <function=>) — cf. _strip_tool_call_markup.
                                cleaned_content = _strip_tool_call_markup(nt_text)
                                return {
                                    "choices": [{
                                        "finish_reason": ("length" if nt_length
                                                          else "tool_calls"),
                                        "message": {
                                            "role": "assistant",
                                            "content": cleaned_content or None,
                                            "tool_calls": built_tcs,
                                        },
                                    }],
                                    "usage": nt_data.get("usage") or {},
                                    "timings": nt_data.get("timings") or {},
                                }
                            # Pas de tool calls détectés → réponse texte normale
                            return {
                                "choices": [{
                                    "finish_reason": ("length" if nt_length
                                                      else "stop"),
                                    "message": {"role": "assistant", "content": nt_text},
                                }],
                                "usage": nt_data.get("usage") or {},
                                "timings": nt_data.get("timings") or {},
                            }
                        except Exception as nt_err:
                            logger.error("[tools_stream] Fallback sans-tools a échoué aussi : %s", str(nt_err)[:200])
                            raise

                if resp.status_code >= 400:
                    resp.raise_for_status()

                # Boucle SSE + flush : consommateur PARTAGÉ avec le chemin
                # classic (→ providers.llamacpp.consume_llama_sse). Il accumule
                # les tool_calls (canal natif) et route thinking/content à
                # l'identique. Le POST-traitement propre au chemin outils
                # (récupération reasoning, forme de retour) reste ci-dessous.
                from llm_core.providers.llamacpp import (
                    SseStreamResult,
                    consume_llama_sse,
                )
                # ``sink`` dont les listes SONT nos buffers de garde
                # (content_parts/thinking_parts) : consume_llama_sse les remplit
                # AU FIL du flux → le partiel est visible même si le flux lève en
                # cours (erreur transport). Sans ça, la réaffectation post-retour
                # ci-dessous ne se produisait pas sur un raise → le garde
                # anti-duplication (plus bas) voyait des buffers vides et laissait
                # un retry ré-émettre tout (régression Phase 5).
                _sse = SseStreamResult()
                _sse.content_parts = content_parts
                _sse.thinking_parts = thinking_parts
                # AUDIT 2026-09-24 (n° 7, régression H2) — l'accumulateur de
                # tool_calls DOIT être celui du sink : sans ce branchement, la
                # garde anti-duplication (``… or tool_calls_acc`` plus bas)
                # voyait toujours un dict VIDE, et une coupure au milieu des
                # arguments d'un ``write_file`` laissait un retry rejouer les
                # ``tool_call_delta`` déjà poussés (aperçu Monaco doublé).
                _sse.tool_calls_acc = tool_calls_acc
                # ── Fin de raisonnement PILOTÉE plutôt que subie ───────────
                # Le chemin outils n'a jamais eu de budget de réflexion :
                # ``thinking_budget_tokens`` + ``tools[]`` = 400 côté
                # llama.cpp. Un raisonnement qui s'emballe se faisait donc
                # couper par le plafond de génération, en plein milieu — d'où
                # la mécanique de reprise du raisonnement, et un aller-retour
                # complet avec le moteur.
                # Le contrôle temps réel change la nature de la limite : on
                # DEMANDE la fermeture du bloc, le modèle sort du raisonnement
                # et rédige sa réponse. Rien n'est tronqué.
                # ⚠ Aucun mur nouveau : sans ``max_tokens`` (réflexion
                # délibérément non plafonnée en local) et sans budget souple
                # explicite, ce garde-fou ne se déclenche JAMAIS.
                _think_cb = on_thinking_token
                if _llama_native and payload.get("reasoning_control"):
                    # Publie l'``id`` de la complétion dès le premier token de
                    # raisonnement : c'est ce qui rend le bouton « Répondre
                    # maintenant » utilisable depuis N'IMPORTE quel worker.
                    # Une écriture par tour, pas par token.
                    _think_cb = _publish_completion(_think_cb, _sse, chat_id,
                                                    target_model)
                _rea_cap = _reasoning_cap_chars(payload)
                if _rea_cap > 0 and _llamacpp_srv:
                    _think_cb = _reasoning_guard(
                        _think_cb, _rea_cap, _sse, client, _target,
                        target_model, _req_id)
                try:
                    _sse = await consume_llama_sse(
                        resp, tag_splitter=tag_splitter, req_id=_req_id,
                        user_id=user_id, is_cancelled=is_cancelled,
                        on_thinking_token=_think_cb,
                        on_content_token=on_content_token,
                        on_tool_call_delta=on_tool_call_delta,
                        on_prompt_progress=on_prompt_progress,
                        sink=_sse,
                    )
                except Exception as _cut:
                    # Coupure du TRANSPORT en plein flux. Le moteur, lui, n'a
                    # rien arrêté (session nommée) : on relit son tampon au
                    # lieu de rendre un partiel et d'armer « Continuer ».
                    _resumed = await _resume_cut_stream(
                        client, _target, _conv_id, target_model, _cut,
                        req_id=_req_id, user_id=user_id,
                        previous=_sse,
                        is_cancelled=is_cancelled,
                        on_thinking_token=on_thinking_token,
                        on_content_token=on_content_token,
                        stream_timeout=_stream_to,
                    )
                    if _resumed is None:
                        raise
                    _sse = _resumed
                    content_parts = _sse.content_parts
                    thinking_parts = _sse.thinking_parts
                    tool_calls_acc = _sse.tool_calls_acc
                finally:
                    # Le flux est fini : cette complétion n'est plus
                    # contrôlable. Sans ce retrait, l'entrée survivait jusqu'à
                    # son TTL (15 min) et « Répondre maintenant » pouvait
                    # viser un tour mort — le moteur refusait, le bouton
                    # retombait sur l'ancien geste coûteux. Idempotent, et
                    # sans effet si rien n'a été publié.
                    if chat_id and payload.get("reasoning_control"):
                        with swallow("harness.reasoning_control.clear"):
                            from shared_infra.llm.reasoning_control import clear_completion
                            clear_completion(chat_id)

            # Le moteur a donné signe de vie pendant le silence du
            # pré-remplissage : on peut resserrer son read-timeout aux tours
            # suivants (cf. llama_stream.note_alive_signal).
            if _sse.prompt_progress:
                from llm_core.providers.llama_stream import note_alive_signal
                note_alive_signal(target_model)

            # Réaffecte les buffers locaux depuis le résultat (post-traitement
            # en aval inchangé ; idempotent — le sink a rempli en place).
            content_parts = _sse.content_parts
            thinking_parts = _sse.thinking_parts
            tool_calls_acc = _sse.tool_calls_acc
            usage = _sse.usage
            timings = _sse.timings
            finish_reason = _sse.finish_reason or ""
            stream_pre_emitted_thinking = _sse.stream_pre_emitted_thinking

            # Assembler la réponse au format dict standard
            built_tcs = _sse.built_tool_calls()
            final_content = "".join(content_parts) or ""

            # ── Récupération d'un tool-call piégé dans le reasoning ──────────
            # Qwen3/GLM-4.x émettent parfois l'appel dans le canal reasoning au
            # lieu du canal tool_calls natif (template/parser qui rate la
            # frontière) → tour mort + markup brut visible dans le « thinking ».
            # Si rien n'a été produit nativement (0 tool-call, 0 prose) mais que
            # le reasoning contient un appel explicite, on le promeut.
            # AUDIT 2026-08-23 — la promotion est INTERDITE quand le serveur a
            # annoncé ``finish_reason="length"``. Le raisonnement est alors
            # tronqué PAR CONSTRUCTION, et les regex de la Stratégie 2 de
            # ``extract_tool_calls`` sont volontairement tolérantes au bloc non
            # fermé (``(?:</parameter>|$)``) : un ``write_file`` coupé en plein
            # ``content`` était donc « extrait » avec sa valeur amputée, puis
            # EXÉCUTÉ — le fichier partait sur le disque à moitié écrit. Pire,
            # la réécriture inconditionnelle de ``finish_reason`` effaçait
            # l'information et contournait du même coup les deux gardes
            # anti-troncature de la boucle (canal natif et canal texte), dont
            # le commentaire décrit précisément ce risque.
            # AUDIT 2026-09-24 (n° 1) — même interdiction pour la coupure
            # SILENCIEUSE (flux fermé sans ``finish_reason``) : le raisonnement
            # y est tout autant tronqué. Le silence doit être constaté ICI,
            # AVANT la récupération : celle-ci réécrit ``finish_reason`` en
            # « tool_calls », et ``_silent_cut`` calculé après valait donc
            # False — l'appel amputé partait à l'exécution.
            _silent_cut = bool(not finish_reason)
            _tronque = (str(finish_reason or "") == "length") or _silent_cut
            if not built_tcs and not final_content.strip() and not _tronque:
                _known_names = {
                    (t.get("function") or {}).get("name")
                    for t in (tools_payload or [])
                } - {None, ""}
                _recovered = _recover_tool_calls_from_reasoning(
                    "".join(thinking_parts), known_names=(_known_names or None))
                if _recovered:
                    built_tcs = _recovered
                    # Ni ``length`` ni une coupure silencieuse n'arrivent
                    # plus jusqu'ici (garde ci-dessus) : la réécriture ne peut
                    # donc plus effacer une troncature. Pour ``stop`` on garde
                    # le comportement historique — c'est ce qui fait exécuter
                    # l'appel récupéré.
                    finish_reason = "tool_calls"
                    logger.warning(
                        "[LLM_REQ %s] %d tool-call(s) récupéré(s) depuis le reasoning "
                        "(canal tool_calls natif manqué — modèle thinking)",
                        _req_id, len(built_tcs),
                    )

            # Log de fin tools_stream : bilan + tool_calls émis
            _in_tok = usage.get("prompt_tokens", 0) if isinstance(usage, dict) else 0
            _out_tok = usage.get("completion_tokens", 0) if isinstance(usage, dict) else 0
            logger.info(
                "[LLM_REQ %s] END_TOOLS user=%r n_tool_calls=%d content_chars=%d in_tok=%d out_tok=%d finish=%s",
                _req_id, user_id, len(built_tcs), len(final_content), _in_tok, _out_tok, finish_reason or "stop",
            )

            # Fin de flux SANS finish_reason ni tool_call : le serveur a fermé
            # le flux sans conclure (crash/coupure réseau SANS exception httpx
            # — l'itérateur SSE se termine simplement). Avant : classé « stop »
            # → la boucle prenait le chemin RÉPONSE FINALE et un run de
            # plusieurs heures se terminait « proprement » en pleine mission,
            # sans bouton « Continuer ». Un flux VIDE est RETENTÉ (aucun token
            # émis → aucun risque de duplication côté client) ; un flux non
            # vide devient un PARTIEL de transport — même traitement que le
            # chemin d'exception ci-dessous (troncature/reprise en aval).
            #
            # AUDIT 2026-08-23 — la détection ne s'auto-désarme PLUS en
            # présence de tool_calls. Elle le faisait (``and not built_tcs``),
            # et c'est précisément le cas d'une coupure au milieu de
            # l'émission des ARGUMENTS : ``built_tool_calls()`` recolle les
            # fragments reçus sans jamais vérifier que le JSON est complet, la
            # réponse remontait en ``finish_reason="tool_calls"`` SANS
            # ``partial``, et la boucle exécutait l'outil avec des arguments
            # tronqués — donc ``args={}`` après l'échec du parse. Un
            # ``delete_file`` ou un ``git_commit`` amputé de ses arguments
            # part ainsi pour de bon, et son résultat parasite entre dans
            # l'historique. Le chemin d'EXCEPTION, lui, abandonnait déjà ces
            # tool_calls pour cette exact raison (« leurs arguments sont
            # tronqués, donc inexécutables ») : on aligne les deux.
            # (``_silent_cut`` est calculé AVANT la récupération ci-dessus.)
            if (_silent_cut and not built_tcs and not final_content.strip()
                    and not "".join(thinking_parts).strip()):
                raise RuntimeError(
                    "flux SSE terminé sans finish_reason (0 token)")
            if _silent_cut and built_tcs:
                logger.warning(
                    "[LLM_REQ %s] flux coupé pendant l'émission de %d "
                    "tool_call(s) — arguments incomplets, abandonnés ; le "
                    "tour repart en partiel.", _req_id, len(built_tcs))
                built_tcs = []
            _fr = finish_reason or (
                "tool_calls" if built_tcs else ("length" if _silent_cut else "stop"))
            # Capture de l'échange pour le viewer admin "Trafic LLM" (best-effort,
            # gated par LLM_DEBUG_ENABLED ; le "thinking" n'est PAS journalisé).
            with swallow("harness.llama_chat_with_tools_stream.2"):
                from llm_core._llm_debug import capture_llm_exchange_async
                await capture_llm_exchange_async(
                    req_id=_req_id, user_id=user_id, chat_id=chat_id,
                    model=target_model, path="tools", request_payload=payload,
                    content=final_content, tool_calls=built_tcs,
                    usage=usage, timings=timings, finish_reason=_fr, status="ok",
                )
            if (resume_content is not None
                    or (resume_think is not None and _resume_native)):
                # Reprise native ABOUTIE → support confirmé pour ce modèle.
                from llm_core._llm_params import note_continue_final_support
                note_continue_final_support(target_model, True)
            # Le moteur a répondu : un ``ConnectError`` ultérieur sera traité
            # comme un REDÉMARRAGE (attente /health) et non comme un serveur
            # absent — cf. llm_core._llm_retry.note_llm_success.
            with swallow("harness.note_llm_success"):
                from llm_core._llm_retry import note_llm_success
                note_llm_success()
            return {
                "choices": [{
                    "finish_reason": _fr,
                    "message": {
                        "role":       "assistant",
                        "content":    final_content or None,
                        "tool_calls": built_tcs or None,
                    },
                }],
                "usage": usage,
                "timings": timings,
                # Le raisonnement de CE tour est-il arrivé par le canal natif
                # ``reasoning_content`` ? Pilote le MODE d'une éventuelle
                # auto-reprise du tour suivant (natif vs repli).
                "reasoning_channel_native": bool(stream_pre_emitted_thinking),
                # Coupure silencieuse (fin de flux sans finish_reason) :
                # marquée comme partiel de TRANSPORT, parité avec le chemin
                # d'exception.
                **({"partial": True} if _silent_cut else {}),
            }

        except asyncio.CancelledError:
            # ⚠ Avec une session nommée, fermer le flux N'ARRÊTE PLUS le
            # modèle — c'est le prix de la reprise. L'arrêt doit donc être
            # DIT au moteur, sinon un Stop laisserait la génération courir
            # jusqu'à l'EOS, sur le seul slot de la machine.
            _fire_cancel_stream(client, _target, _conv_id, target_model)
            raise
        except Exception as e:
            last_err = e
            logger.warning("[LLM_REQ %s] tools_stream attempt %d failed: %s",
                           _req_id, attempt + 1, str(e)[:200])
            # BUG FIX — ne pas retry si des tokens ont déjà été streamés :
            # le retry ré-émettrait tout depuis zéro → contenu dupliqué côté
            # client. On retourne le PARTIEL accumulé (déjà reçu via
            # on_*_token) comme un tour terminé SANS tool calls. Les
            # tool_calls éventuellement reçus à moitié sont abandonnés —
            # leurs ``arguments`` sont tronqués, donc inexécutables.
            # (passe 7, H2) — ``tool_calls_acc`` compte aussi : des fragments
            # d'arguments déjà poussés au front (tool_call_delta) seraient
            # rejoués à l'identique par un retry (même iter/index).
            if content_parts or thinking_parts or tool_calls_acc:
                logger.warning(
                    "[LLM_REQ %s] tools_stream interrompu après émission "
                    "partielle — pas de retry, retour du partiel.", _req_id,
                )
                # AUDIT 2026-09-24 (n° 14) — coupure de TRANSPORT dont la
                # reprise a échoué : avec une session nommée, le moteur, lui,
                # continue de générer jusqu'à l'EOS, sur un slot que
                # l'ordonnanceur croit libre dès ce retour. On lui DIT
                # d'arrêter, comme sur un Stop. Un refus HTTP (4xx/5xx, erreur
                # SSE du fournisseur) n'a rien laissé tourner : rien à arrêter.
                if not isinstance(e, httpx.HTTPStatusError):
                    _fire_cancel_stream(client, _target, _conv_id, target_model)
                with swallow("harness.llama_chat_with_tools_stream.3"):
                    from llm_core._llm_debug import capture_llm_exchange_async
                    await capture_llm_exchange_async(
                        req_id=_req_id, user_id=user_id, chat_id=chat_id,
                        model=target_model, path="tools", request_payload=payload,
                        content="".join(content_parts), usage=usage, timings=timings,
                        finish_reason="partial", status="partial", error=str(e)[:500],
                    )
                return {
                    "choices": [{
                        # Un partiel de transport est par nature INCOMPLET :
                        # ``length`` (et non ``stop``) pour que la boucle arme
                        # ``truncated``/``truncated_in_think`` — parité avec le
                        # chemin classic, qui retournait déjà ``truncated``
                        # quand ce chemin finissait en « stop » silencieux.
                        "finish_reason": "length",
                        "message": {
                            "role": "assistant",
                            "content": ("".join(content_parts) or None),
                            "tool_calls": None,
                        },
                    }],
                    "usage": usage,
                    "timings": timings,
                    # Marqueur racine : le serveur vient de timeouter/planter —
                    # bloque l'auto-reprise (pas de re-POST aveugle).
                    "partial": True,
                }
            # P0 fiche 14 — un 4xx (hors 408/429) est une requête invalide
            # (schéma/grammaire/contexte) : la rejouer à l'identique reproduit
            # exactement le même refus. On abandonne immédiatement au lieu de
            # brûler les tentatives.
            if _llm_error_is_fatal(e):
                # Reprise NATIVE refusée (4xx) = build llama-server sans
                # ``continue_final_message`` : mémoriser puis rejouer LE MÊME
                # appel en mode prefill (repli) — la reprise n'est pas perdue.
                if resume_content is not None and _http_4xx(e):
                    # Reprise de PROSE refusée : le serveur ne connaît pas
                    # ``continue_final_message``. On mémorise (les tentatives
                    # suivantes n'essaieront plus) et on ABANDONNE la reprise —
                    # il n'existe pas de repli sûr pour la prose, cf.
                    # _think_resume.should_auto_resume_content. L'appelant
                    # retombe sur le partiel + « Continuer ».
                    from llm_core._llm_params import note_continue_final_support
                    note_continue_final_support(target_model, False)
                    logger.warning(
                        "[LLM_REQ %s] continue_final_message refusé (%s) — "
                        "reprise de prose abandonnée", _req_id, str(e)[:120],
                    )
                    break
                if resume_think is not None and _resume_native and _http_4xx(e):
                    from llm_core._llm_params import note_continue_final_support
                    note_continue_final_support(target_model, False)
                    logger.warning(
                        "[LLM_REQ %s] continue_final_message refusé (%s) → "
                        "repli prefill <think>", _req_id, str(e)[:120],
                    )
                    _resume_native = False
                    payload = await _build_full_payload(native_resume=False)
                    continue
                logger.warning(
                    "[LLM_REQ %s] erreur non-retryable (%s) — abandon immédiat",
                    _req_id, str(e)[:150],
                )
                break
            if attempt < LLAMA_RETRIES:
                # Backoff expo plafonné + full jitter ; sur 503 llama local
                # (modèle en chargement), attend /health prêt à la place.
                await _llm_retry_pause(e, attempt,
                                       is_cancelled=is_cancelled,
                                       label="tools_stream")

    with swallow("harness.llama_chat_with_tools_stream.4"):
        from llm_core._llm_debug import capture_llm_exchange_async
        await capture_llm_exchange_async(
            req_id=_req_id, user_id=user_id, chat_id=chat_id,
            model=target_model, path="tools", request_payload=payload,
            # Le CORPS de la réponse d'erreur, pas seulement « Client error
            # '400 Bad Request' for url … » : c'est le corps qui dit lequel
            # des champs/messages le moteur a refusé. Sans lui, diagnostiquer
            # un refus demande de rejouer ``llm_calls.request_json`` à la main
            # (constaté deux fois — 2026-08-21 et 2026-08-22).
            content="", status="error",
            error=_llm_error_detail(last_err)[:1000],
        )
    # LLMFailure porte le message ACTIONNABLE (str) + le motif technique
    # (.detail) + la famille (.kind). Avant, les deux branches remontaient
    # « Requête LLM rejetée par le serveur : Client error '400 Bad Request'
    # for url … » ou « LLM inaccessible après N tentatives : … », affichés
    # tels quels dans la bulle de chat : aucune cause, aucun geste à faire.
    # AUDIT 2026-08-23 — le disjoncteur est nourri ICI, pas dans le garde :
    # ce ``raise`` produit un ``LLMFailure`` (RuntimeError), que la boucle
    # agentique attrape avant que le garde ne puisse voir quoi que ce soit.
    with swallow("harness.breaker_note_tools"):
        from llm_core._scheduling._breaker import note_transport_failure
        from llm_core._scheduling._engines import breaker_key as _bk
        from llm_core.engines import current_engine as _ce_brk
        # Clé du serveur de la cible : la panne d'un connecteur n'ouvre plus
        # le circuit du modèle HOMONYME de l'intégré (AUDIT 2026-09-16).
        note_transport_failure(_bk(_ce_brk(), target_model), last_err)
    raise LLMFailure(last_err,
                     attempts=(1 if _llm_error_is_fatal(last_err)
                               else LLAMA_RETRIES + 1))


# ── Budget communiqué au modèle (P0 audit harness, fiche 5) ─────────────────
# Idiome du <system_warning> d'Anthropic (Sonnet 4.5) : le harnais poste des
# points d'étape de budget DANS le flux de la conversation, en append-only
# APRÈS les tool results — jamais dans la tête système ni en réécriture, pour
# préserver la byte-stabilité du prefix-cache KV. Émis aux jalons seulement
# (50 %, 75 %, puis chacune des 5 dernières itérations) : ~10 tokens par
# émission, silence le reste du temps. Le fragment système (FRAGMENT_TOOLS)
# explique au modèle comment lire le tag.
def _harness_status_line(k: int, n: int, *,
                         wall_left_s: Optional[float] = None,
                         hard_left: Optional[int] = None) -> Optional[str]:
    """Ligne ``<harness_status>`` pour k itérations productives consommées sur
    un budget de n — ou None hors jalon. k >= n est géré ailleurs (sortie de
    boucle + tour de synthèse « MAXIMUM STEPS REACHED »).

    ``hard_left`` = itérations restantes avant le PLAFOND DUR (cascade
    d'appels en échec). Ce plafond termine le run tout comme le budget
    d'étapes, mais le modèle n'en entendait jamais parler : il planifiait
    contre un budget qui n'était pas celui qui allait l'arrêter (audit
    2026-08-01, P1-7). On l'annonce dès qu'il devient la contrainte la plus
    proche."""
    # Le plafond dur passe DEVANT quand il est sur le point de mordre : c'est
    # alors lui la vraie limite, et le geste utile n'est pas le même (des
    # appels échouent en série — il faut changer d'approche, pas se dépêcher).
    if hard_left is not None and 0 < hard_left <= 5 and (n <= 0 or k < n):
        return (f"<harness_status>Failed-call ceiling: only {hard_left} attempt(s) "
                "left before this turn is stopped for repeated tool failures "
                "(this is NOT the step budget). Your recent tool calls are "
                "failing: change approach — re-read the actual error, verify "
                "arguments and paths, or report the blocker instead of "
                "retrying.</harness_status>")
    if n <= 0 or k <= 0 or k >= n:
        return None
    left = n - k
    at_half = k == (n + 1) // 2
    at_three_quarters = k == (3 * n + 3) // 4
    if not (at_half or at_three_quarters or left <= 5):
        return None
    if left == 1:
        body = (f"Tool-iteration budget: {k}/{n} used — LAST iteration "
                "available. Deliver your final answer now; call one more tool "
                "only if answering is impossible without it.")
    elif left <= 5:
        body = (f"Tool-iteration budget: {k}/{n} used — only {left} left. "
                "Wrap up: finish the essential steps, then deliver the final "
                "answer. Do not start anything new.")
    else:
        body = (f"Tool-iteration budget: {k}/{n} used, {left} left. Plan the "
                "remaining work to fit. If the goal is already reached, stop "
                "calling tools and answer now; otherwise keep going — do not "
                "stop early while budget remains.")
    if wall_left_s is not None:
        body += f" Wall-clock remaining: ~{max(0, int(wall_left_s // 60))} min."
    return f"<harness_status>{body}</harness_status>"


def _todo_status_reminder(username: str, chat_id: Optional[str]) -> Optional[str]:
    """Bloc ``<todo_status>`` injecté EN DÉBUT DE TOUR quand la todo-list
    persistée du chat (``meta_json["todos"]``, outil ``todowrite``) garde des
    tâches ouvertes. Sans lui, la liste ne survivait qu'en ARCHÉOLOGIE — le
    tool result todowrite enfoui dans le tool_history des tours précédents,
    élagable (prune/compaction) et jamais relu spontanément : le modèle
    « oubliait » de continuer ou solder ses tâches au tour suivant. None si
    pas de chat persisté, pas de liste, ou plus rien d'ouvert."""
    if not chat_id or chat_id == "default":
        return None
    try:
        from shared_infra.chat.store import get_chat_todos
        # (passe 6, B4) — même cache username→uid que les métriques d'outils :
        # ce helper refaisait un ``SELECT * FROM users`` par tour pour ne
        # garder que l'id.
        uid = _TCM_UID_CACHE.get(username)
        if uid is None:
            from shared_infra.accounts.users import get_user
            row = get_user(username)
            if row is None:
                return None
            uid = int(row["id"])
            _TCM_UID_CACHE[username] = uid
        todos = get_chat_todos(uid, chat_id)
    except Exception:
        return None
    open_count = sum(1 for t in todos
                     if isinstance(t, dict) and t.get("status") in ("pending", "in_progress"))
    if not open_count:
        return None
    # Même forme canonique que le ``checklist`` renvoyé par todowrite
    # (``N. [status] contenu``) : le modèle recopie au lieu de reformuler.
    from llm_core.tools._todo_format import render_checklist
    return (
        "<todo_status>Your session todo list from previous turns still has "
        f"{open_count} open task(s):\n" + render_checklist(todos) + "\n"
        "Unless the user's latest message changes the plan, resume this work: "
        "set the task you start to in_progress, mark each task completed as "
        "soon as it is done (or cancelled if obsolete) — always via todowrite "
        "with the FULL updated list, every item with its content (copied "
        "verbatim) and its status.</todo_status>"
    )


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
# un petit modèle brûler tout son budget d'itérations à rejouer. (T4-J)
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

    Les deux causes se présentent à l'identique côté API. L'ancien code lisait
    TOUJOURS « contexte saturé » : trois écritures trop longues d'affilée
    faisaient annoncer une fenêtre pleine à 20 % d'occupation, et l'UI
    proposait de compacter une conversation qui n'en avait pas besoin."""
    try:
        pt = int((usage or {}).get("prompt_tokens") or 0)
        ct = int((usage or {}).get("completion_tokens") or 0)
        n_ctx = int(ctx_size or 0)
    except (TypeError, ValueError):
        return None
    if n_ctx <= 0 or pt <= 0:
        return None
    return (pt + ct) >= int(n_ctx * _CTX_FULL_RATIO)

# ──────────────────────────────────────────────────────────────────────────
# Garantie dure : le prompt ne dépasse JAMAIS la fenêtre de contexte
# ──────────────────────────────────────────────────────────────────────────
# le pipeline de réduction (vision/budget) et
# maybe_compress_conversation (résume les vieux tours) réduisent l'historique
# mais ne GARANTISSENT pas que le prompt final tienne dans n_ctx — ce sont
# des heuristiques, et la compression a un cooldown. Si le prompt dépasse
# n_ctx, le modèle est coupé en cours de génération (finish=length) → tool
# call tronqué → ValidationError + historique empoisonné → 500.
# _enforce_context_budget est le DERNIER rempart : exécuté juste avant
# l'appel LLM, il garantit le fit en retirant au besoin les messages les
# plus anciens.

# Comptage des tokens : centralisé dans llm_core.context.tokens (exact-first
# /tokenize + /apply-template, fallback heuristique UNIQUE 3.3). Ratios et
# planchers de fenêtre : llm_core.context.budget (surcharge à froid via
# context_config.json → budgets.*). Depuis la bascule « réel seul »
# (2026-07-12), la JAUGE de contexte n'estime plus rien : elle lit l'usage
# réel renvoyé par le serveur en fin de requête (event kv_cache unique).
from llm_core.context.budget import (
    BUDGET as _BUDGET,  # noqa: E402 — import tardif voulu (dépendance circulaire ou coût)
)
from llm_core.context.compaction_gate import (
    CompactionThreshold,  # noqa: E402 — import tardif voulu (dépendance circulaire ou coût)
)
from llm_core.context.tokens import (  # noqa: E402 — import tardif voulu (dépendance circulaire ou coût)
    # Point d'injection / ré-export (AUDIT 2026-08-30 / S6) — cf. le bloc
    # ``context.pruning`` plus bas : la suite s'adresse à ce module.
    count_messages_tokens_per_msg as _count_messages_tokens_per_msg,  # noqa: F401
    count_tools_tokens_ex as _count_tools_payload_tokens_ex,
)

# Réserve (tokens) pour la réponse du modèle + les schémas d'outils. Le
# prompt envoyé ne doit pas dépasser (n_ctx - cette réserve).
_CTX_OUTPUT_RESERVE_RATIO = _BUDGET.output_reserve_ratio
_CTX_OUTPUT_RESERVE_MIN   = _BUDGET.output_reserve_min
# Messages récents toujours préservés = le tour courant (réponse et
# résultats d'outils déjà produits). Jamais retirés par le fit : c'est ce
# que le modèle doit garder pour enchaîner sur le tour suivant.
_CTX_KEEP_RECENT = _BUDGET.keep_recent_msgs

# ── Phase 2 : pipeline contexte extrait vers llm_core.context ──────────────
# Étages de réduction (compaction outils / vision / budget dur), hygiène
# d'historique et assemblage opérationnel (runtime_ctx + AX + fold) vivent
# dans context.pruning / context.assembly. Aliases historiques conservés
# (imports des tests + ré-exports _legacy + sites internes de la boucle) —
# retrait prévu en Phase 7.
from llm_core.context.assembly import (  # noqa: E402 — import tardif voulu (dépendance circulaire ou coût)
    assemble_operational_context as _assemble_operational_context,
    # RÉ-EXPORT, pas un import mort (AUDIT 2026-08-30 / S6) : la fonction a
    # déménagé vers ``context.assembly``, mais ce module reste son point
    # d'entrée historique et la suite s'y adresse encore. Une passe de purge
    # automatique l'a retiré et a cassé la collecte de deux fichiers de tests —
    # d'où le ``noqa`` et cette note, pour que la prochaine s'arrête ici.
    fold_operational_block as _fold_operational_block,  # noqa: F401
)
from llm_core.context.pruning import (  # noqa: E402 — import tardif voulu (dépendance circulaire ou coût)
    _VISION_FRAME_PLACEHOLDER,  # noqa: F401
    DESKTOP_TOOL_RESULT_MAX_CHARS as _DESKTOP_TOOL_RESULT_MAX_CHARS,  # noqa: F401
    # Ré-exports — même raison que ci-dessus.
    compact_desktop_elements as _compact_desktop_elements,  # noqa: F401
    enforce_context_budget as _enforce_context_budget,  # noqa: F401
    ephemeral as _ephemeral_msg,
    fit_context as _fit_context,
    prepare_tool_result_for_model as _prepare_tool_result_for_model,
    prune_old_vision_frames as _prune_old_vision_frames,  # noqa: F401
    select_prune_keys as _select_prune_keys,
    strip_internal_keys as _strip_internal_keys,
    truncate_head_tail as _truncate_head_tail,
)

# Harness d'exécution des tool_calls (série/parallèle) : PARTAGÉE par les deux
# canaux natif/legacy (Phase 4 — retire ~110 lignes de duplication verbatim).
from llm_core.engine.tool_exec import (
    execute_tool_batch as _execute_tool_batch,  # noqa: E402 — import tardif voulu (dépendance circulaire ou coût)
)

# Tools de la catégorie « memory » (Hermes) — gouvernées par un TOGGLE per-user
# (défaut OFF), pas par le panneau d'outils ni le set caché toujours-actif.
_MEMORY_TOOL_NAMES = frozenset({"memory", "session_search"})


def _tool_name(t) -> str:
    """Nom d'un outil, qu'il soit un objet (.name) ou un dict ({'name': ...})."""
    return getattr(t, "name", None) or (t.get("name", "") if isinstance(t, dict) else "") or ""


def _apply_memory_gate(raw_tools, memory_enabled: bool, categorize) -> list:
    """Drop the memory-category tools unless ``memory_enabled``.

    Robust even when ``filter_categories`` is None (all-pass) OR the manifest is
    down (``categorize`` returns ""): we match by tool NAME *and* by category, so
    neither path can leak ``memory`` / ``session_search`` when the toggle is OFF.
    Pure (no I/O) → directly unit-testable.
    """
    if memory_enabled:
        return list(raw_tools)
    return [
        t for t in raw_tools
        if _tool_name(t) not in _MEMORY_TOOL_NAMES and categorize(_tool_name(t)) != "memory"
    ]


def _expand_builtin_configs(mcp_configs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Remplace chaque config sentinelle ``DEFAULT_LOCAL_PYTHON`` par la liste
    des entrées intégrées du manifeste (dédoublonnées par nom d'entrée).

    (2026-09-12) Il y a normalement UNE entrée par famille, chacune avec son
    endpoint : la sentinelle se développe donc en autant de configs, et retirer
    une entrée de ``mcp.json`` retire ses outils sans autre geste. Manifeste
    réduit à une seule entrée intégrée : comportement strictement inchangé,
    y compris le nom donné par l'appelant (``task-explore``…)."""
    out: List[Dict[str, Any]] = []
    seen: set = set()
    for cfg in (mcp_configs or []):
        if isinstance(cfg, dict) and cfg.get("type", "sse") == "stdio" \
                and cfg.get("command", "") == "DEFAULT_LOCAL_PYTHON":
            try:
                from shared_infra.mcp.manifest import builtin_client_cfgs as _bcc
                expanded = _bcc(cfg.get("filter_categories"))
            except Exception:                                    # noqa: BLE001
                expanded = [cfg]
            # Le nom donné par l'appelant (« Outils Locaux », « task-explore »)
            # ne survit que s'il n'y a QU'UNE entrée de service à nommer ; avec
            # une entrée par famille, chacune garde la sienne.
            solo = sum(1 for e in expanded
                       if e.get("command") == "DEFAULT_LOCAL_PYTHON") == 1
            for e in expanded:
                k = ("builtin", str(e.get("manifest") or e.get("command") or ""))
                if k in seen:
                    continue
                seen.add(k)
                # Les clés propres à l'appelant (filtre, drapeaux) sont
                # conservées ; l'entrée garde son identité (nom, manifeste,
                # familles) — sans quoi dix entrées porteraient le même nom.
                if e.get("command") == "DEFAULT_LOCAL_PYTHON":
                    e = {**cfg, **e}
                    if solo:
                        e["name"] = cfg.get("name") or e.get("name")
                out.append(e)
            continue
        out.append(cfg)
    return out


async def _collect_mcp_tools(
    mcp_configs: List[Dict[str, Any]],
    builtin_tools: Optional[Dict[str, Any]],
    on_event: Optional[Callable],
    keywords_text: str = "",
    allowed_tool_names: Optional[set] = None,
    memory_enabled: bool = True,
    deny_tool_names: Optional[set] = None,
    read_only: bool = False,
) -> Tuple[Dict[str, Dict], List[Dict], Dict[str, Callable], List[str]]:
    """Connect to every MCP server, collect their tools + filter by category.

    Returns a 4-tuple :
        tool_cfg_map            tool_name → cfg (for later mcp_pool.call_tool)
        tools_payload           list of OpenAI-formatted tool definitions
        builtin_handlers        tool_name → callable (for local/RAG tools)
        connected_server_names  list of names for the "mode" event message

    Raises ``RuntimeError`` if configs were provided but nothing connected
    AND no builtin_tools are available — i.e. the chat would be impossible.

    ``deny_tool_names`` (défaut None) : couche de deny FINALE, appliquée aux
    tools MCP (Y COMPRIS catégories cachées) ET aux builtins — contrairement à
    ``allowed_tool_names`` qui laisse toujours passer les catégories cachées.
    Utilisée par le moteur de sous-agents (outil ``task``) pour retirer sans
    exception ``task``/``todowrite`` de la surface d'un enfant (anti-récursion),
    ``todowrite`` vivant dans la catégorie cachée ``task``. None → inchangé.

    ``read_only`` (défaut False) : mode LECTURE SEULE du chat (« /plan »).
    Ne survivent que les outils ANNOTÉS read-only — y compris dans les
    catégories cachées, qu'aucune exception ne fait passer ici. C'est une
    allow-list, donc fail-fermé : un outil sans annotation tombe.
    """
    _deny: set = set(deny_tool_names) if deny_tool_names else set()
    tool_cfg_map: Dict[str, Dict]     = {}
    tools_payload: List[Dict]         = []
    connected_server_names: List[str] = []

    # Manifest-backed categorization. `categorize()` does an exact-name
    # lookup against the generated manifest (no hand-maintained allow-list).
    # Hidden categories (e.g. `task` → todowrite) are ALWAYS kept available
    # to the model, regardless of the user's filter_categories selection —
    # they're model-side aids, not user-facing capabilities.
    from llm_core._mcp_categories import (
        categorize as _categorize,
        get_hidden_categories as _get_hidden_categories,
        manifest_source as _manifest_source,
    )
    _hidden_cats = set(_get_hidden_categories())
    # registry_source() returns "live" | "static" | "empty" — we have a
    # usable registry whenever it is not "empty".
    _manifest_ok = _manifest_source() != "empty"

    # ── tool_gating config-driven (context_config) ────────────────────────
    # Modèle SÛR « drop-listed » : on ne masque QUE les catégories listées dans
    # tool_gating.gated et seulement si aucun de leurs mots-clés n'apparaît dans
    # le dernier message user. Catégories non listées / cachées / inconnues =
    # toujours exposées. ``_gated_out(name)`` couvre aussi le kill-switch par
    # outil (tools.<name>.enabled=false). Désactivable via tool_gating.enabled.
    try:
        from llm_core.context_config import CTX as _CTX
    except Exception:
        _CTX = None
    _dropped_by_gate = 0

    def _gated_out(_name: str, _explicit_cats: frozenset = frozenset()) -> bool:
        if _CTX is None or not _name:
            return False
        if not _CTX.tool_enabled(_name):          # kill-switch (hors gating)
            return True
        if not _CTX.gating_enabled():
            return False
        _cat = _categorize(_name)
        if not _cat or _cat in _hidden_cats:      # caché / inconnu → toujours dispo
            return False
        # BUG FIX — une catégorie EXPLICITEMENT activée par l'utilisateur dans le
        # panneau MCP (``filter_categories``) ne doit JAMAIS être masquée par le
        # gating par mots-clés : l'utilisateur l'a demandée à la main. Le gating
        # ne sert qu'à réduire le bruit des outils AUTO-inclus. Sans ce garde,
        # activer « Navigateur » (cat. browser, gated par défaut) faisait
        # disparaître tous les pw_* car aucun mot-clé ne matche ci-dessous.
        if _cat in _explicit_cats:
            return False
        # DÉCISION (audit refactor 2026-07) — l'auto-gating par mots-clés
        # (``keywords_text``) reste volontairement NON câblé : fail-OUVERT.
        # Le set d'outils est déjà contrôlé, en amont, par la sélection
        # EXPLICITE du panneau (``filter_categories``), désormais PERSISTÉE
        # par chat (set_chat_tools/meta_json) — donc STABLE au sein d'un chat,
        # ce qui préserve le prefix-cache KV (exigence dure). Un gating auto
        # par mots-clés ferait VARIER le set d'outils au fil des messages
        # → invalidation du cache + « l'outil a disparu », pour un bénéfice
        # qui recoupe le contrôle explicite. On sur-expose plutôt que de
        # cacher (cohérent avec le repli « manifest indisponible » plus bas).
        # ``keywords_text`` reste dans la signature pour un opt-in futur borné.
        if not keywords_text:
            return False
        return _CTX.category_gated_out(_cat, keywords_text)

    # AUDIT 2026-08-31 — connexions EN PARALLÈLE. La boucle awaitait chaque
    # serveur en SÉRIE : au rafraîchissement du cache d'outils (TTL 360 s) ou
    # après éviction (10 min d'inactivité), les coûts spawn/handshake/
    # list_tools s'additionnaient sur le chemin critique avant le premier
    # token. On connecte tout de front — le pool sérialise par CLÉ, plus
    # entre serveurs (cf. _key_lock) — puis on filtre en série dans l'ordre
    # des configs (ordre de ``connected_server_names`` préservé).
    # (2026-09-12, P4) la SENTINELLE (« le service d'outils intégré ») se
    # développe en TOUTES les entrées intégrées du manifeste — service partagé
    # + MCP interne de l'app (mémoire, todo, graphiques, bibliothèque de
    # skills) — avec les mêmes catégories. Un seul point, pour la route de
    # chat, les sous-agents, les routines et le pré-chauffage.
    mcp_configs = _expand_builtin_configs(mcp_configs)
    _conn_results: List[Any] = []
    if mcp_configs:
        _conn_results = await asyncio.gather(
            *(mcp_pool.get_or_connect(cfg, resolve_client_fn=_resolve_mcp_client)
              for cfg in mcp_configs),
            return_exceptions=True,
        )

    for cfg, _conn in zip(mcp_configs, _conn_results):
        allowed_cats = cfg.get("filter_categories")
        try:
            # AUDIT 2026-08-23 — ``_hidden_cats`` et ``_manifest_ok`` étaient
            # figés AVANT cette boucle, donc avant la connexion qui PEUPLE le
            # registre (``_connect_new`` → ``ingest_tools``). Sur un worker
            # froid — première installation, pré-chauffage sauté après 120 s
            # d'attente derrière les autres workers, cache disque illisible —
            # le drapeau valait « empty » et on partait sur le repli fail-open
            # « passing all tools through », alors que l'information arrive
            # de la connexion (désormais faite dans le gather ci-dessus).
            # Mesuré : un utilisateur n'ayant coché que « Fichiers » recevait
            # au 1er tour ['desktop_act', 'execute_shell', 'read_file',
            # 'todowrite', 'write_file'] — le TERMINAL et le CONTRÔLE
            # D'ÉCRAN. Deux lectures d'un dict en mémoire : coût nul.
            if isinstance(_conn, asyncio.CancelledError):
                # Annulation d'un ENFANT isolé (cancel-scope d'un transport
                # MCP) : le parent annulé aurait fait lever ``gather`` lui-même.
                # Un serveur défaillant ne doit pas tuer le tour comme un Stop.
                _conn = RuntimeError("connexion MCP annulée")
            if isinstance(_conn, BaseException):
                raise _conn
            _client, raw_tools = _conn

            # Category filtering. We categorize each *actually exposed*
            # tool via the manifest and keep it if either:
            #   • its category is in the user's allowed_cats, OR
            #   • its category is hidden (always-on, e.g. todowrite).
            # If the manifest is missing (MCP server not restarted yet),
            # filtering is inert — we pass everything through rather than
            # silently dropping every tool.
            _manifest_ok = _manifest_source() != "empty"
            _hidden_cats = set(_get_hidden_categories())
            if allowed_cats is not None and _manifest_ok:
                allowed_set = set(allowed_cats) | _hidden_cats
                # Memory toggle (per-user, default OFF): when ON, let the
                # 'memory' category through the panel filter even though it is
                # NOT a panel-selectable category anymore.
                if memory_enabled:
                    allowed_set.add("memory")
                kept = []
                for t in raw_tools:
                    t_name = getattr(t, "name", "") or t.get("name", "")
                    if _categorize(t_name) in allowed_set:
                        kept.append(t)
                raw_tools = kept
            elif allowed_cats is not None and not _manifest_ok:
                logger.warning(
                    "[_collect_mcp_tools] filter_categories=%s requested but "
                    "tool manifest is unavailable — passing all tools through. "
                    "Restart the MCP server to enable category filtering.",
                    allowed_cats,
                )

            # Per-user memory toggle (default OFF): drop the memory-category
            # tools unless explicitly enabled (see _apply_memory_gate).
            raw_tools = _apply_memory_gate(raw_tools, memory_enabled, _categorize)

            # Catégories explicitement activées par l'utilisateur pour CE serveur
            # (panneau MCP → ``filter_categories``). Elles court-circuitent le
            # tool_gating par mots-clés dans ``_gated_out`` ci-dessous.
            _explicit_cats = frozenset(allowed_cats) if allowed_cats else frozenset()
            for t in raw_tools:
                t_name = getattr(t, "name", "") or t.get("name", "")
                # Deny FINAL (moteur de sous-agents) : s'applique AVANT le bypass
                # des catégories cachées → retire ``todowrite`` (cat. cachée
                # ``task``) et ``task`` de la surface d'un enfant. Aucun bypass.
                if t_name in _deny:
                    continue
                # Lecture seule (« /plan ») : allow-list par ANNOTATION, avant
                # tout le reste et sans exception pour les catégories cachées.
                # Un outil non annoté tombe — c'est le point du fail-fermé.
                if read_only and not tool_traits(t_name, tool=t).read_only:
                    continue
                if _gated_out(t_name, _explicit_cats):
                    _dropped_by_gate += 1
                    continue
                # Allowlist par-outil (moteur d'agents) : un archétype expose
                # un SOUS-ENSEMBLE exact de tools. Les catégories cachées
                # (aides model-side, ex. todowrite) restent toujours dispo.
                if (
                    allowed_tool_names is not None
                    and t_name not in allowed_tool_names
                    and _categorize(t_name) not in _hidden_cats
                ):
                    continue
                # AUDIT 2026-09-24 (n° 17) — un nom déjà fourni par un serveur
                # précédent (ou deux fois par le même) : PREMIER ARRIVÉ GAGNE.
                # Avant, ``tools[]`` annonçait les deux schémas (400 chez
                # Anthropic et OpenAI : noms d'outils uniques exigés) et le
                # routage partait silencieusement vers la DERNIÈRE config. Un
                # seul schéma annoncé, et c'est celui du serveur qui exécute.
                if t_name in tool_cfg_map:
                    logger.warning(
                        "[_collect_mcp_tools] outil '%s' déjà fourni par le "
                        "serveur '%s' — doublon du serveur '%s' ignoré",
                        t_name, (tool_cfg_map[t_name] or {}).get("name", "?"),
                        cfg.get("name", "?"))
                    continue
                tool_cfg_map[t_name] = cfg
                tools_payload.append(mcp_tool_to_openai(t))

            extra = f" ({', '.join(allowed_cats)})" if allowed_cats else ""
            connected_server_names.append(f"{cfg.get('name', '')}{extra}")

        except Exception as e:
            # ⚠ ``warning``, PAS ``error`` (régression 2026-09-04). Le tour
            # CONTINUE après cet échec — les autres serveurs sont déjà connectés
            # et le modèle va répondre. Or côté front, ``error`` est TERMINAL :
            # il marque le message ``isError``, coupe ``isStreaming`` et annule
            # les flux d'édition en cours. Un seul serveur externe injoignable
            # (Jenkins éteint, jeton périmé) sabordait donc l'affichage de tout
            # le tour, sans que rien ne dise que le reste avait fonctionné.
            # ``warning`` rend le même texte en bandeau 12 s et laisse le tour
            # se dérouler. Le cas VRAIMENT fatal — aucun serveur connecté et
            # aucun builtin — lève un RuntimeError plus bas, qui lui produit
            # bien une erreur de tour.
            _srv_name = cfg.get("name", "?")
            logger.warning("[_collect_mcp_tools] serveur MCP '%s' injoignable : %r",
                           _srv_name, e)
            await _emit(on_event, {
                "type": "warning",
                # ``friendly_mcp_error`` aplatit les ExceptionGroup des
                # transports MCP : sans lui, un simple jeton périmé s'affichait
                # en trace de task group, illisible pour qui doit juste aller
                # remettre son token dans le formulaire.
                "text": (f"Serveur d'outils « {_srv_name} » injoignable — ses "
                         f"outils sont absents de ce tour. "
                         f"{_friendly_mcp_error(e)}"),
            })

    # If configs were provided but no tools loaded → server(s) failed to connect.
    #
    # ⚠ « aucun outil » n'est PAS « aucune connexion ». Un filtrage peut
    # légitimement tout retirer : lecture seule (« /plan ») sur un chat dont
    # toutes les catégories cochées sont mutantes, par exemple. Sans la
    # nuance ci-dessous, l'utilisateur recevait « Vérifiez la configuration
    # dans Paramètres → MCP » pour une connexion parfaitement saine — un
    # message qui l'envoie chercher une panne inexistante.
    # ``connected_server_names`` n'est peuplé qu'APRÈS une connexion réussie :
    # c'est lui qui départage les deux cas.
    if mcp_configs and not tool_cfg_map and not builtin_tools:
        if connected_server_names:
            logger.info(
                "[_collect_mcp_tools] connexion OK (%s) mais AUCUN outil ne "
                "passe les filtres%s — le tour se fera sans outils.",
                ", ".join(connected_server_names),
                " (mode lecture seule)" if read_only else "",
            )
        else:
            err_names = [c.get("name", "?") for c in mcp_configs]
            raise RuntimeError(
                f"Impossible de se connecter aux serveurs MCP : {', '.join(err_names)}. "
                "Vérifiez la configuration dans Paramètres → MCP."
            )

    # ── Inject built-in tools (RAG tools, etc.) ─────────────────────────
    # NB lecture seule (« /plan ») : les builtins ne portent PAS d'annotations
    # MCP (ce sont des paires definition/handler construites pour l'appel), on
    # ne peut donc rien prouver à leur sujet ici — leur appliquer le fail-fermé
    # supprimerait le RAG, qui est de la consultation et a toute sa place dans
    # un chat en lecture seule. La barrière pour eux est ``deny_tool_names`` :
    # l'appelant y met ``task`` (un sous-agent, lui, écrirait). Cf. la route de
    # génération, qui construit ce deny.
    builtin_handlers: Dict[str, Callable] = {}
    if builtin_tools:
        for bt_name, bt_info in builtin_tools.items():
            # Deny FINAL (moteur de sous-agents) : un enfant ne reçoit jamais le
            # builtin ``task`` (anti-récursion), même transmis par mégarde.
            if bt_name in _deny:
                continue
            if _gated_out(bt_name):
                _dropped_by_gate += 1
                continue
            # NB : ``allowed_tool_names`` ne s'applique PAS aux builtins. Ce filtre
            # restreint la surface LARGE du serveur MCP local (ex. un sous-ensemble
            # de ``fs``). Les builtins sont au contraire construits EXPLICITEMENT
            # pour cet appel (ex. RAG tools) : ils doivent TOUJOURS être exposés,
            # sinon le modèle voit dans son prompt un outil qu'il ne peut pas
            # appeler → « outil indisponible ».
            # Homonyme d'un outil MCP : le BUILTIN gagne. C'est lui que
            # ``_execute_single_tool_call`` route en premier, et il est construit
            # explicitement pour cet appel (cf. ci-dessus) : on retire donc le
            # schéma et la route MCP, sinon ``tools[]`` porte deux fois le nom
            # et le schéma lu par le modèle n'est pas celui qui s'exécute.
            if bt_name in tool_cfg_map:
                logger.warning(
                    "[_collect_mcp_tools] builtin '%s' homonyme d'un outil du "
                    "serveur '%s' — le builtin prévaut, le schéma MCP est retiré",
                    bt_name, (tool_cfg_map[bt_name] or {}).get("name", "?"))
                del tool_cfg_map[bt_name]
                tools_payload = [
                    d for d in tools_payload
                    if ((d or {}).get("function") or {}).get("name") != bt_name]
            tools_payload.append(bt_info["definition"])
            builtin_handlers[bt_name] = bt_info["handler"]

    if _dropped_by_gate:
        logger.info(
            "[_collect_mcp_tools] tool_gating: %d outil(s) masqué(s) "
            "(hors profil actif ce tour)", _dropped_by_gate,
        )
    return tool_cfg_map, tools_payload, builtin_handlers, connected_server_names

# Réponse rendue quand la sortie finale du modèle n'était QUE du balisage
# d'appel d'outil inexploitable (cf. chemin de réponse finale, n° 9).
_MARKUP_ONLY_REPLY = (
    "Ma dernière réponse était une tentative d'appel d'outil mal formée, qui "
    "n'a pas pu être exécutée. Relancez la demande, au besoin en la "
    "reformulant."
)

# Consigne du tour de SYNTHÈSE final quand le budget d'itérations est épuisé
# (modèle OpenCode max-steps.txt) : appel SANS outils, texte seul. Injectée en
# message user préfixé [SYSTEM], comme la relance compacte (contrainte « un
# seul role:system » des templates stricts).
_MAX_STEPS_WRAPUP = (
    "[SYSTEM] MAXIMUM STEPS REACHED. The step budget for this task is "
    "exhausted and tools are disabled for this turn. Respond with TEXT ONLY: "
    "state that the step limit was reached, summarize concisely what was "
    "actually accomplished (real results only), list what remains to be done, "
    "and recommend the next action. Do not attempt any tool call."
)

# Variantes par CAUSE RÉELLE d'arrêt (audit 2026-07-31). Le run peut sortir par
# le chemin « limite atteinte » sans que le budget d'étapes soit en cause :
# mur d'horloge, contexte saturé, ou cascade d'appels ratés qui a épuisé le cap
# dur (2× le budget) alors que le compteur d'étapes productives, lui, reste
# bas — c'est ce dernier cas qui rendait le message d'origine trompeur, le
# modèle annonçant à l'utilisateur une limite d'étapes qu'il n'avait pas
# atteinte. Même contrat de sortie (texte seul), seul le constat change.
_WRAPUP_BY_KIND = {
    "wallclock": (
        "[SYSTEM] TIME BUDGET REACHED. The wall-clock budget for this task ran "
        "out (the step budget was NOT exhausted) and tools are disabled for "
        "this turn. Respond with TEXT ONLY: state that the time limit was "
        "reached, summarize concisely what was actually accomplished (real "
        "results only), list what remains to be done, and recommend the next "
        "action. Do not attempt any tool call."
    ),
    "ctx_saturated": (
        "[SYSTEM] CONTEXT SATURATED. Your tool calls kept being cut off "
        "mid-emission, so the loop stopped (the step budget was NOT "
        "exhausted). Tools are disabled for this turn. Respond with TEXT ONLY: "
        "state that the context filled up, summarize concisely what was "
        "actually accomplished (real results only), list what remains to be "
        "done, and recommend the next action — restarting from a fresh, "
        "narrower request is usually the fix. Do not attempt any tool call."
    ),
    "gen_cap": (
        "[SYSTEM] OUTPUT LENGTH LIMIT. Your tool calls kept being cut off by "
        "the generation length limit (the context window is NOT full and the "
        "step budget was NOT exhausted), so the loop stopped. Tools are "
        "disabled for this turn. Respond with TEXT ONLY: state that the tool "
        "calls were too long for the output limit, summarize concisely what "
        "was actually accomplished (real results only), list what remains to "
        "be done, and recommend the next action — split large writes into "
        "several smaller calls. Do not attempt any tool call."
    ),
    "hard": (
        "[SYSTEM] TOO MANY FAILED STEPS. The loop stopped on its "
        "failed-iteration guard, not on the step budget: too many tool calls "
        "in a row returned errors. Tools are disabled for this turn. Respond "
        "with TEXT ONLY: state that the run was stopped after repeated tool "
        "failures, quote the decisive error, summarize what was actually "
        "accomplished (real results only), list what remains, and recommend "
        "the next action. Do not attempt any tool call."
    ),
}

# Défauts PAR-OUTIL de la borne dure MCP quand le défaut global ne suffit pas.
# execute_shell accepte timeout_sec jusqu'à 600 s : la borne doit l'excéder,
# sinon une commande légitime de 600 s meurt en « timeout outil » à 300 s
# (incohérence historique). Surchargeable à froid comme le reste.
# Borne d'attente en FILE (sémaphore d'entrée du pool) avant de rendre une
# erreur « file saturée » distincte du timeout d'exécution — cf. call_tool
# (AUDIT 2026-08-31). Assez large pour absorber un pic, assez courte pour ne
# pas immobiliser un tour derrière 610 s de shells d'autres utilisateurs.
_TOOL_QUEUE_WAIT_S = 120.0

# (2026-09-11, P2) REPLI seulement : la borne d'un outil voyage désormais dans
# sa ``meta.policy.timeout_s`` (déclarée par le serveur, ingérée à la
# connexion — cf. ``_mcp_categories.tool_policy``). Ce dict ne sert plus qu'à
# un registre encore VIDE (worker froid) ou à un serveur externe homonyme :
# couper un shell légitime à la borne globale serait une régression réelle.
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
    # R10a — le builtin ``task`` s'auto-borne à TASK_CHILD_TIMEOUT_S (>> le défaut
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
    # AUDIT 2026-09-25 — « appel annulé » était faux : le client abandonne
    # l'attente, mais aucune annulation n'est envoyée au serveur, qui peut
    # encore exécuter l'outil (et appliquer son effet plus tard). Un modèle
    # qui lit « annulé » relance aussitôt — deux effets concurrents.
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
    # Signature À TROIS arguments : l'appel à un seul argument levait
    # TypeError, avalé ici — la trame distante n'était JAMAIS rapatriée
    # (passe robustesse 2026-09-24). Seules les erreurs de DONNÉES sont tues.
    try:
        _df = _extract_desktop_frame(tool_name, None, result_str)
        tok = (_df or {}).get("token") if isinstance(_df, dict) else None
    except (TypeError, ValueError):
        tok = None
    if not tok:
        return
    await _ensure_local_asset(int(user_id), desktop_frame_path(tok), f"/api/desktop/frame/{tok}")


async def _ensure_local_asset(user_id: Optional[int], local_path: str, relay_path: str) -> bool:
    """(2026-09-12, P4) Un actif (capture navigateur, trame desktop) produit
    par un hôte d'outils DISTANT n'est pas sur ce disque : on le rapatrie par
    le relais (jeton de service + identité) à ``local_path`` pour que la suite
    (vision, Studio) lise le fichier comme avant. ``True`` si présent."""
    if local_path and os.path.exists(local_path):
        return True
    if not user_id or not relay_path:
        return False
    try:
        from shared_infra.sandbox.relay import fetch_relayed_bytes
        data = await fetch_relayed_bytes(int(user_id), relay_path)
    except Exception:                                            # noqa: BLE001
        data = None
    if not data:
        return False
    try:
        os.makedirs(os.path.dirname(local_path) or ".", exist_ok=True)
        await asyncio.to_thread(lambda: open(local_path, "wb").write(data))
        return True
    except Exception:                                            # noqa: BLE001
        return False


def _build_call_meta(*, is_local: bool, username: str, chat_id: Any,
                     live_shell: bool, call_id: Any, run_log_tok: str,
                     user_id: Optional[int] = None) -> Optional[Dict[str, Any]]:
    """``_meta`` d'un appel d'outil LOCAL — identité out-of-band (username,
    chat_id), ``live_shell`` (le shell streame sa sortie), ``call_id`` (le
    serveur le recopie dans ses notifications → chaque ligne à SON appel) et
    ``log_token`` (routage legacy). ``None`` pour un serveur externe : jamais
    l'identité d'un compte à un tiers (A12/A13 — un seul point d'injection
    pour les deux canaux, natif et legacy)."""
    if not is_local:
        return None
    meta: Dict[str, Any] = {"username": username}
    if user_id:
        # (2026-09-11, P4) id numérique : un hôte d'outils DISTANT n'a pas la
        # base des comptes pour le retrouver (enveloppe d'identité).
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

    v17.20+ (Phase 2b) — ``meta`` est transmis comme MCP request meta
    out-of-band. Utilisé pour passer l'identité (username, chat_id) sans
    polluer ``final_args`` (donc sans leaker dans le schema vu par le LLM).
    Builtin handlers (non-MCP) ignorent ``meta`` — ils n'ont pas accès au
    transport MCP de toute façon.

    v18 (Tier 1 MCP best practices) — ``progress_callback`` reçoit les
    notifications de progression émises par le tool via
    ``ctx.report_progress()`` ; ``log_callback`` reçoit les
    ``ctx.info/warning/error()``. L'orchestrateur appelant les wire pour
    réémettre en events SSE (``tool_progress``, ``tool_log``) consommés
    par le frontend. Builtin handlers ignorent ces callbacks (ils ne
    passent pas par le transport MCP).
    """
    if tool_name in builtin_handlers:
        try:
            _bto = _tool_timeout_s(tool_name)
            # AUDIT 2026-08-31 (passe 3) — l'APPEL du handler part en
            # threadpool. Un handler SYNCHRONE (outils RAG : httpx.Client,
            # timeout 30 s — embedding + Qdrant + rerank) s'exécutait INLINE
            # sur la boucle : gel de TOUS les flux du worker pendant la
            # requête, et HORS de la borne (_tool_timeout_s ne couvrait que
            # les awaitables). Dans un thread : un handler async y CRÉE juste
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
                # R10a — MÊME borne dure que le chemin MCP : un builtin awaitable
                # suspendu ne doit pas geler le tour. Le timeout redevient une
                # erreur d'outil ORDINAIRE ; l'annulation utilisateur
                # (CancelledError) traverse. Le builtin ``task`` s'auto-borne
                # déjà, mais _tool_timeout_s lui laisse la marge nécessaire.
                # (passe 7, H12) — budget RESTANT, pas une seconde borne
                # pleine : les deux ``wait_for`` cumulaient jusqu'à 2×_bto.
                _bleft = max(0.5, _bto - (time.monotonic() - _bt0))
                try:
                    return await asyncio.wait_for(bh, timeout=_bleft)
                except asyncio.TimeoutError:
                    return _tool_timeout_json(tool_name, _bto)
            return bh
        except Exception as e:
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
    # sans elle, seule l'annulation utilisateur libérait la boucle. Le
    # timeout redevient une erreur d'outil ORDINAIRE (le modèle la voit et
    # peut adapter) ; l'annulation utilisateur (CancelledError) traverse.
    timeout_s = _tool_timeout_s(tool_name)
    try:
        # AUDIT 2026-08-31 — le ``wait_for`` externe englobait aussi l'ATTENTE
        # du sémaphore d'entrée du pool : sous saturation multi-utilisateur, un
        # outil « expirait » sans avoir jamais été exécuté, avec le message
        # « n'a pas répondu » qui poussait le modèle à re-queuer. Le budget
        # d'exécution est désormais chronométré DANS le pool, après
        # l'acquisition ; l'attente en file a sa propre borne et sa propre
        # erreur (MCPQueueSaturated).
        res = await mcp_pool.call_tool(
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
        # voyait qu'une enveloppe à deux clés et la comptait comme un SUCCÈS
        # (itération « productive », métrique ``tool_call`` à ok) alors que
        # l'outil n'a jamais tourné.
        return json.dumps({
            "ok": False,
            "error": str(e),
            "fix": ("Le serveur d'outils est saturé par d'autres appels — "
                    "l'outil n'a PAS été exécuté. Réduis le parallélisme ou "
                    "réessaie dans un instant."),
        }, ensure_ascii=False)
    except Exception as e:
        # Message DÉPLIÉ : les transports MCP enveloppent l'exception réelle
        # (ValidationError pydantic incluse) dans un ExceptionGroup anyio dont
        # str() ne dit rien — le modèle doit voir le champ en faute.
        from llm_core.engine.tool_exec import flatten_exception_message
        return json.dumps({"error": flatten_exception_message(e)},
                          ensure_ascii=False)

# ──────────────────────────────────────────────────────────────────────────
# NOTE — l'ancien « garde-fou anti-boucle » (fingerprint + blocage du 3e appel
# identique) a été RETIRÉ.
#
# Pourquoi : il court-circuitait l'exécution du tool dès le 3e appel identique
# et renvoyait une enveloppe factice ``{"ok": false, "blocked": true, ...}`` au
# lieu du résultat réel. Deux effets pervers se combinaient :
#   1. Le modèle ne recevait PLUS la donnée demandée → il re-tentait → re-bloqué
#      → boucle forcée (le bug exact remonté par l'utilisateur).
#   2. Cette enveloppe ``ok: false`` était comptée comme une erreur par
#      ``_result_is_error`` → itération « non productive » → ``effective_iter``
#      n'avançait jamais, seul ``hard_iter`` montait → spin jusqu'au hard cap
#      sans rien produire.
#
# La terminaison de la boucle reste GARANTIE sans ce mécanisme par la condition
# ``while effective_iter < _effective_iter_budget and hard_iter < _hard_iter_cap``
# (cf. run_chat_multi_mcp) : un répéteur tenace tape au pire le hard cap, mais
# en recevant à chaque fois le VRAI résultat — donc avec une chance d'avancer,
# au lieu d'être enfermé dans un refus.


# Budget d'octets de la ``tool_history`` d'UN run (le « delta » renvoyé à la
# route, persisté sur le message assistant et renvoyé au client).
#
# AUDIT 2026-08-22 (C6) — cette liste n'était bornée par RIEN. Elle grossit de
# deux messages par itération (le tour assistant + un résultat par outil), et
# chaque résultat peut peser jusqu'au plafond d'émission dérivé de n_ctx
# (25 000 tokens, soit ~100 Ko, davantage pour les outils desktop). Sur une
# mission de trois cents itérations cela fait des dizaines de mégaoctets, que
# la fin du tour sérialise puis pousse au navigateur DANS UNE SEULE LIGNE
# NDJSON — exactement au moment où l'utilisateur attend sa réponse.
#
# On garde la TÊTE et la QUEUE (le début du run explique ce qui a été tenté, la
# fin porte le travail récent, le seul que le modèle relira sur un
# « Continuer ») et on remplace le ventre par des repères. Les messages
# ``assistant.tool_calls`` sont TOUJOURS conservés : eux seuls portent
# l'appariement id ↔ résultat, qu'un « Continuer » ré-expanse.
RUN_TOOL_HISTORY_MAX_BYTES = max(
    262_144, int(os.environ.get("RUN_TOOL_HISTORY_MAX_BYTES", str(8 * 1024 * 1024))))


def _tool_call_args_weight(msg: Dict[str, Any]) -> int:
    """Poids des ``tool_calls`` d'un message (noms + arguments)."""
    total = 0
    for tc in (msg.get("tool_calls") or []):
        if not isinstance(tc, dict):
            continue
        fn = tc.get("function") or {}
        if not isinstance(fn, dict):
            continue
        nm = fn.get("name")
        if isinstance(nm, str):
            total += len(nm)
        args = fn.get("arguments")
        if isinstance(args, str):
            total += len(args)
        elif args is not None:
            try:
                total += len(json.dumps(args, ensure_ascii=False))
            except Exception:                                   # noqa: BLE001
                pass
    return total


def _tool_msg_weight(msg: Dict[str, Any]) -> int:
    """Poids d'un message de la ``tool_history``, ARGUMENTS COMPRIS.

    AUDIT 2026-08-23 — cette fonction ne lisait que ``content``. Or un message
    ``assistant.tool_calls`` a ``content=None`` → ``json.dumps(None)`` = «null»
    → poids 4, quel que soit le volume de ses arguments. C'est pourtant là que
    vit la masse : l'argument ``content`` d'un ``write_file`` porte le fichier
    ENTIER (mesuré ailleurs : 54 % du contexte = les arguments des tool_calls).
    Le cap posé en C6 était donc aveugle au terme DOMINANT — 200 itérations de
    ``write_file`` de 200 Ko pesaient 40 Mo réels pour 1 200 octets « vus », et
    ``_cap_run_tool_history`` rendait l'objet d'entrée sans rien élaguer.
    """
    total = 0
    c = msg.get("content")
    if isinstance(c, str):
        total += len(c)
    elif c is not None:
        try:
            total += len(json.dumps(c, ensure_ascii=False))
        except Exception:                                       # noqa: BLE001
            pass
    return total + _tool_call_args_weight(msg)


def _cap_run_tool_history(hist: List[Dict[str, Any]],
                          max_bytes: int = RUN_TOOL_HISTORY_MAX_BYTES
                          ) -> List[Dict[str, Any]]:
    """Borne la taille de la ``tool_history`` d'un run (cf. constante ci-dessus).

    Élague les CONTENUS des résultats d'outils les plus anciens (jamais les
    messages eux-mêmes) : la structure de l'historique reste exacte, seul le
    texte des vieilles sorties est remplacé par un repère.
    """
    total = sum(_tool_msg_weight(m) for m in hist)
    if total <= max_bytes:
        return hist
    # Poids cible : moitié tête, moitié queue.
    keep_tail = max_bytes // 2
    out = [dict(m) for m in hist]
    # 1) Queue protégée : on remonte depuis la fin jusqu'à épuiser keep_tail.
    tail_budget = keep_tail
    protected = set()
    for i in range(len(out) - 1, -1, -1):
        if out[i].get("role") != "tool":
            continue
        w = _tool_msg_weight(out[i])
        if w > tail_budget:
            break
        tail_budget -= w
        protected.add(i)
    # 2) Tête : on élague les plus ANCIENS résultats non protégés jusqu'à
    #    repasser sous le budget.
    for i in range(len(out)):
        if total <= max_bytes:
            break
        if i in protected or out[i].get("role") != "tool":
            continue
        w = _tool_msg_weight(out[i])
        if w < 2048:            # inutile d'élaguer des miettes
            continue
        out[i]["content"] = (
            f"[résultat élagué — {w} caractères ; l'historique d'outils de ce "
            f"run a dépassé son budget de {max_bytes // (1024 * 1024)} Mo]")
        out[i]["content_elided"] = True
        total -= (w - _tool_msg_weight(out[i]))
    # 3) Toujours au-dessus du budget : la masse est dans les ARGUMENTS des
    #    ``assistant.tool_calls`` (write_file & co). On les élague à leur tour,
    #    des plus ANCIENS aux plus récents, en gardant ``id``/``name`` — eux
    #    seuls portent l'appariement, qu'un « Continuer » ré-expanse. Le
    #    remplacement reste du JSON VALIDE : les arguments sont ré-parsés par
    #    certains gabarits, un repère en texte brut les casserait.
    if total > max_bytes:
        _tail_guard = max(0, len(out) - 8)   # les 8 derniers messages intacts
        for i in range(_tail_guard):
            if total <= max_bytes:
                break
            if out[i].get("role") != "assistant" or not out[i].get("tool_calls"):
                continue
            w = _tool_call_args_weight(out[i])
            if w < 2048:
                continue
            _new_calls = []
            for tc in out[i]["tool_calls"]:
                if not isinstance(tc, dict):
                    _new_calls.append(tc)
                    continue
                fn = dict(tc.get("function") or {})
                _args = fn.get("arguments")
                _n = len(_args) if isinstance(_args, str) else 0
                if _n >= 512:
                    fn["arguments"] = json.dumps(
                        {"_elided": f"arguments élagués — {_n} caractères "
                                    f"(budget de tool_history atteint)"},
                        ensure_ascii=False)
                _new_calls.append({**tc, "function": fn})
            out[i] = {**out[i], "tool_calls": _new_calls, "args_elided": True}
            total -= (w - _tool_call_args_weight(out[i]))
    if total > max_bytes:
        logger.warning(
            "[run_chat_multi_mcp] tool_history encore à %d o après élagage "
            "(budget %d o)", total, max_bytes)
    return out


# Relance posée quand l'aplatissement laisserait un message ASSISTANT en
# dernier : un assistant final est interprété comme un « prefill » à
# continuer par les llama-server récents, qui n'en acceptent qu'un. Le
# filet doit rendre la main au modèle, pas lui demander de terminer sa
# propre phrase.
_FLATTEN_RESUME_NUDGE = (
    "[SYSTEM] The structured tool history above was flattened to plain text "
    "for compatibility. Pick the mission up where it stands and continue."
)


# Un 429 n'est pas toujours un rate-limit passager : « quota épuisé » (OpenAI
# ``insufficient_quota``) se classe aussi RATE_LIMITED, alors que le rejouer
# redonnera la même réponse tant que personne n'a rechargé le compte.
# (« Quota exceeded … per minute » de certaines passerelles est, lui, un vrai
# rate-limit : on ne retient que les marqueurs d'un solde épuisé.)
_QUOTA_MARKERS = ("insufficient_quota", "exceeded your current quota")


def _llm_error_hiccup_ok(kind: str, err: Optional[BaseException], *,
                         flatten_pending: bool) -> bool:
    """La relance « hoquet » (même requête, après un backoff) peut-elle
    aboutir pour cette famille de panne ?

    Non pour les pannes DÉTERMINISTES — rejouer la même requête redonne la
    même erreur, douze secondes plus tard et trois fois de suite :
      * dépassement de contexte (a son propre chemin de compaction ; s'il n'a
        pas pu compacter, la requête ne rétrécira pas toute seule) ;
      * refus d'accès (401/403, offre fermée) ;
      * quota épuisé (429 porteur d'un marqueur de quota) ;
      * requête refusée (4xx) une fois l'aplatissement consommé. AVANT, les
        hoquets restent le chemin qui y mène (C5 : on ne court-circuite pas le
        retry transitoire, et l'aplatissement n'arrive qu'après eux)."""
    if kind in (_KIND_CTX_OVERFLOW, _KIND_FORBIDDEN):
        return False
    if kind == _KIND_RATE_LIMITED:
        body = _llm_error_body_text(err).lower()
        if any(m in body for m in _QUOTA_MARKERS):
            return False
    if kind == _KIND_INVALID_REQUEST and not flatten_pending:
        return False
    return True


def _content_text(content: Any) -> str:
    """``content`` d'un message en texte : chaîne telle quelle, liste de blocs
    (fournisseur multimodal OpenAI-compat) réduite à ses blocs texte."""
    if isinstance(content, list):
        return "".join(
            (b.get("text") or "") if isinstance(b, dict) else str(b)
            for b in content)
    return content if isinstance(content, str) else ("" if content is None else str(content))


def _norm_thinking(text: Any) -> str:
    """Forme de comparaison d'un raisonnement : blancs repliés. Le flux brut
    et la valeur ``strip()``ée du message final ne diffèrent souvent QUE par
    là — une égalité stricte les voyait comme deux raisonnements distincts."""
    return " ".join(str(text or "").split())


def _unique_tool_call_ids(tool_calls: List[Dict[str, Any]],
                          history: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Garantit des ids d'appel UNIQUES sur tout l'historique. PURE (copie).

    AUDIT 2026-09-24 (2e passe) — les ids de repli sont positionnels
    (``call_0``, ``call_1``… : accumulateur SSE sans ``id`` fourni par le
    serveur, récupération depuis le raisonnement, repli après 500), donc
    IDENTIQUES d'une itération à l'autre. Or tout ce qui indexe par id prend
    la dernière occurrence : l'élagage (nom d'outil → protection), le
    résumeur (statut ok/ÉCHEC épinglé), la matérialisation d'un Stop (le
    résultat du ``write_file`` du round 2 écarté parce que ``call_0`` du
    round 1 « existe déjà » → écriture rejouée au Continuer). Un id vide ou
    déjà vu reçoit un id neuf ; un id fourni et inédit est gardé tel quel."""
    if not tool_calls:
        return tool_calls
    seen = set()
    for m in history or []:
        if isinstance(m, dict) and m.get("role") == "assistant":
            for tc in (m.get("tool_calls") or []):
                if isinstance(tc, dict) and tc.get("id"):
                    seen.add(tc["id"])
    out: List[Dict[str, Any]] = []
    for tc in tool_calls:
        if not isinstance(tc, dict):
            out.append(tc)
            continue
        _id = tc.get("id")
        if not _id or _id in seen:
            tc = {**tc, "id": f"call_{secrets.token_hex(6)}"}
        seen.add(tc["id"])
        out.append(tc)
    return out


def _flatten_tool_messages(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Dernier recours : convertit tout message lié aux outils en TEXTE.

    Le résultat ne contient plus que des messages ``system``/``user``/
    ``assistant`` avec un simple ``content`` — aucun ``tool_calls``,
    aucun ``role:"tool"``. C'est le filet qui empêche un chat d'être
    DÉFINITIVEMENT bloqué quand la sanitisation n'a pas suffi à
    identifier le poison. Le modèle perd le détail structuré des outils
    mais garde l'info en texte, et surtout le chat redevient utilisable.

    ⚠ La FORME du résultat compte autant que son contenu (constaté en
    production le 2026-08-22). La version précédente repliait chaque
    résultat d'outil dans le message ``assistant`` qui le précédait :
    sur une boucle agentique, elle produisait une file de N messages
    ``assistant`` CONSÉCUTIFS terminée par un assistant. Le même
    llama-server qui acceptait l'historique structuré (dernier message
    ``tool``) a REFUSÉ cette forme en 400 — les builds récents traitent
    un assistant final comme un « prefill » à continuer et posent une
    limite d'un seul. La seule voie de récupération du run se soldait
    donc par un second refus, affiché « Le modèle a refusé la requête
    telle qu'elle a été construite ».

    On rend donc au résultat une forme conversationnelle stricte :
      - les observations d'outils redeviennent des messages ``user``
        (c'est ce qu'elles sont : de l'information DONNÉE au modèle) ;
      - les messages system sont hissés en tête ;
      - deux messages de même rôle ne se suivent jamais ;
      - le dernier message n'est JAMAIS un assistant.

    Les marques ``_ephemeral`` / ``_task_anchor`` survivent (comptage des
    tours de la compaction, ancre protégée par le budget dur) :
      - un message d'origine les garde ; une fusion n'est éphémère que si
        TOUTES ses parties l'étaient (un vrai ``user`` fusionné reste un tour),
        et reste ancre si l'une d'elles l'était ;
      - une observation d'outil devenue ``user`` est éphémère : un ``tool``
        n'ouvrait pas de tour et n'était pas l'énoncé de la tâche — sans la
        marque, chaque résultat aplati comptait pour un tour et devenait
        « la demande en cours » aux yeux du budget dur ;
      - la relance finale (``_FLATTEN_RESUME_NUDGE``) est un nudge du harnais.
    """
    systems: List[Dict[str, Any]] = []
    body: List[Dict[str, Any]] = []

    def _text_of(m: Dict[str, Any]) -> str:
        content = m.get("content")
        if isinstance(content, list):
            content = " ".join(
                b.get("text", "") for b in content
                if isinstance(b, dict) and isinstance(b.get("text"), str)
            )
        return str(content or "")

    def _push(role: str, text: str, *, ephemeral: bool = False,
              anchor: bool = False) -> None:
        text = (text or "").strip()
        if not text:
            return
        if body and body[-1].get("role") == role:
            prev = body[-1]
            prev["content"] = f"{prev['content']}\n\n{text}"
            if not (ephemeral and prev.get("_ephemeral")):
                prev.pop("_ephemeral", None)
            if anchor:
                prev["_task_anchor"] = True
            return
        msg: Dict[str, Any] = {"role": role, "content": text}
        if ephemeral:
            msg["_ephemeral"] = True
        if anchor:
            msg["_task_anchor"] = True
        body.append(msg)

    for m in messages:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        if role == "system":
            systems.append({**m, "content": _text_of(m)})
        elif role == "tool":
            txt = _text_of(m)
            if len(txt) > 8000:
                # Tête+queue (pas tête-seule) : la fin d'un résultat d'outil —
                # verdict, dernière erreur — est souvent la partie décisive.
                txt = _truncate_head_tail(txt, 8000)
            _push("user", f"[Tool result — previous turn]\n{txt}", ephemeral=True)
        elif role == "assistant":
            content = _text_of(m)
            if m.get("tool_calls"):
                names = [
                    (tc.get("function") or {}).get("name", "?")
                    for tc in (m.get("tool_calls") or [])
                    if isinstance(tc, dict)
                ]
                content = (content + f"\n[Tools called: {', '.join(names)}]").strip()
            _push("assistant", content or "(...)",
                  ephemeral=bool(m.get("_ephemeral")))
        else:
            # user, et tout rôle exotique : côté « entrée du modèle ».
            _push("user", _text_of(m), ephemeral=bool(m.get("_ephemeral")),
                  anchor=bool(m.get("_task_anchor")))

    if not body or body[-1].get("role") == "assistant":
        body.append({"role": "user", "content": _FLATTEN_RESUME_NUDGE,
                     "_ephemeral": True})
    return systems + body


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

    Partagé par le chemin NATIF (tool_calls structurés) et le chemin LEGACY
    (texte tag-parsé) — c'était un copié-collé divergent. L'appelant reste
    responsable de ``hard_iter += 1`` + ``continue``.
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
    # lequel des deux ici. L'ancien texte tranchait (« by the context limit ») :
    # le modèle en déduisait une saturation de contexte qui n'était pas
    # forcément la sienne, et concluait parfois qu'il ne pouvait plus rien
    # faire. Le conseil actionnable, lui, vaut dans les deux cas.
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
    except Exception:
        _compact_msg = _compact_default
    working_messages.append(_ephemeral_msg("user", _compact_msg))


async def _run_chat_multi_mcp_wrapper(*args, **kwargs) -> Tuple[str, List[Dict[str, Any]], Dict[str, Any]]:
    """Wrapper public de ``_run_chat_multi_mcp_impl`` avec nettoyage garanti.

    AUDIT 2026-08-02 (M1) — le corps de la fonction (2 300 lignes) n'a aucun
    ``finally`` de niveau fonction : les 3 purges de ``_LAST_SCREENSHOT``
    vivent sur les chemins de ``return`` nominaux, alors que la fonction
    lève ``CancelledError`` en 3 points et que chats.py cancel la task à
    chaque déconnexion client. Chaque « Stop » / fermeture d'onglet pendant
    un tour ayant capturé une screenshot laissait donc un JPEG (100-400 Ko)
    dans le dict module-level À VIE (~2 Mo+/worker/jour d'usage desktop).
    Ce wrapper garantit la purge sur TOUS les chemins — y compris
    annulation et exception — sans réindenter le corps.
    """
    # username / chat_id : mêmes défauts que la signature de l'impl.
    _username = kwargs.get("username", args[3] if len(args) > 3 else "guest")
    _chat_id = kwargs.get("chat_id", args[7] if len(args) > 7 else None)
    # AUDIT 2026-09-25 — l'impl n'enregistre l'usage que sur ses TROIS retours
    # (ok / limite / échec). Un Stop, une déconnexion, un sous-agent tué par
    # son délai sortent par ``CancelledError`` : les tokens consommés — ceux
    # des runs les plus longs — n'étaient comptés nulle part. L'impl tient ce
    # cumul à jour ici ; on l'enregistre si le run meurt annulé.
    _acc: Dict[str, Any] = {}
    _acc_tok = _RUN_USAGE_ACC.set(_acc)
    _t0 = time.time()
    try:
        return await _run_chat_multi_mcp_impl(*args, **kwargs)
    except asyncio.CancelledError:
        _record_cancelled_run_usage(_acc, _t0)
        raise
    except Exception as _run_err:
        # Exception hors des trois retours (post-traitement…) : l'usage des
        # itérations déjà faites était perdu (AUDIT 2026-09-26).
        _record_cancelled_run_usage(_acc, _t0, status="error",
                                    error_kind=type(_run_err).__name__)
        raise
    finally:
        _RUN_USAGE_ACC.reset(_acc_tok)
        with swallow("harness.run_chat_multi_mcp_wrapper"):
            _clear_last_screenshot_for(f"{_username}:{_chat_id or 'default'}")


# Cumul d'usage du run EN COURS (cf. _run_chat_multi_mcp_wrapper).
_RUN_USAGE_ACC: "ContextVar[Optional[Dict[str, Any]]]" = ContextVar(
    "run_usage_acc", default=None)


def _record_cancelled_run_usage(acc: Dict[str, Any], t0: float,
                                status: str = "cancelled",
                                error_kind: str = "") -> None:
    """Enregistre l'usage d'un run ANNULÉ (status ``cancelled``) ou mort sur
    une exception (``error``), s'il a consommé quelque chose et qu'aucun
    retour ne l'a déjà enregistré."""
    if not acc or acc.get("recorded"):
        return
    _in = int(acc.get("in") or 0) + int(acc.get("inflight_in") or 0)
    _out = int(acc.get("out") or 0)
    if _in <= 0 and _out <= 0:
        return
    with swallow("harness.record_usage_on_cancel"):
        record_turn_usage(
            model=acc.get("model") or LLAMA_MODEL, path="tools",
            input_tokens=_in, output_tokens=_out, submitted_tokens=_in,
            usage={"cache_read_input_tokens": int(acc.get("cache_read") or 0),
                   "cache_creation_input_tokens": int(acc.get("cache_creation") or 0)},
            duration_ms=int((time.time() - t0) * 1000),
            iterations=int(acc.get("iterations") or 0),
            status=status, error_kind=error_kind,
        )
        acc["recorded"] = True


async def _run_chat_multi_mcp_impl(
    messages: List[Dict[str, Any]],
    mcp_configs: List[Dict[str, Any]],
    on_event: Optional[Callable] = None,
    username: str = "guest",
    model: Optional[str] = None,
    builtin_tools: Optional[Dict[str, Any]] = None,
    is_cancelled: Optional[Callable[[], bool]] = None,
    chat_id: Optional[str] = None,
    sampling_override: Optional[Dict[str, Any]] = None,
    thinking_mode: bool = False,
    allowed_tool_names: Optional[set] = None,
    memory_enabled: bool = True,
    _inline_semaphore: bool = False,
    priority: str = "high",
    compression_prev_state: Optional[Dict[str, Any]] = None,
    deny_tool_names: Optional[set] = None,
    live_shell: bool = False,
    compression_enabled: Optional[bool] = None,
    compaction_threshold: Optional[CompactionThreshold] = None,
    compaction_max_rounds: Optional[int] = None,
    prune_keys: Optional[list] = None,
    read_only: bool = False,
    user_id: Optional[int] = None,
) -> Tuple[str, List[Dict[str, Any]], Dict[str, Any]]:
    """
    Exécute un chat avec accès aux serveurs MCP via tool calls natifs OpenAI.

    user_id (défaut None) : id numérique du compte, recopié dans le ``_meta``
        des appels d'outils LOCAUX (2026-09-11, P4) — un hôte d'outils DISTANT
        n'a pas la base des comptes pour le retrouver depuis ``username``.

    prune_keys (défaut None) : marques d'élagage DÉJÀ persistées pour ce chat
        (``meta_json["ctx_pruned_keys"]``). La boucle les prend comme état
        initial et y ajoute ses propres sélections intra-run ; l'union est
        ré-émise en fin de tour (event ``prune_state``).

    compression_enabled (défaut None) : autorisation de compaction AUTOMATIQUE
        pour CE tour, déjà résolue par l'appelant (interrupteur maître admin ET
        opt-in per-user ``compression_enabled``). None = repli sur le maître
        seul (routines, appelants sans utilisateur). La compaction manuelle
        (/compact) ne passe pas par ici et reste toujours disponible.

    compaction_threshold (défaut None) : « contexte max avant compaction »
        choisi par le compte (``CompactionThreshold`` : % de la fenêtre OU
        nombre de tokens). None / seuil vide = auto, c'est-à-dire le plafond
        technique (n_ctx − cap de génération − buffer) : comportement
        historique à l'identique. Le seuil est opposé à l'occupation à CHAQUE
        itération — la porte étant évaluée entre deux appels d'outils, rien
        n'est en cours de streaming à cet instant, et une mission de plusieurs
        heures tient dans un seul tour (cf.
        ``llm_core.context.compaction_gate``).

    compaction_max_rounds (défaut None) : cap de compactions par CONVERSATION
        réglé par le compte, convention compresseur (0 = illimité). None = rien
        de réglé ⇒ défaut d'instance ``COMPRESSION_MAX_PER_CHAT``. Relève
        AUSSI le budget de compactions du run : sans ça, un run de plusieurs
        heures buterait sur le plafond de la boucle bien avant le cap choisi.

    live_shell (défaut False) : propage ``live_shell: "1"`` dans le meta MCP
        de chaque tool call → ``execute_shell`` streame sa sortie en direct
        (événements ``shell_output``). Posé par la route chat selon le
        réglage utilisateur « Terminal en direct ».

    compression_prev_state (défaut None) : état de compression persisté du
        chat (round / covered_turns / summary_xml, cf.
        conversation_compressor.extract_compression_state). Permet à la
        compression en boucle d'appliquer le cap COMPRESSION_MAX_PER_CHAT et
        le comptage cumulatif des tours couverts.

    allowed_tool_names (nouveau, défaut None) : si fourni, restreint les outils
        exposés au modèle à CE sous-ensemble exact (par nom). Utilisé par le
        moteur d'agents pour appliquer l'allowlist d'un archétype (ex. un
        ``explorer`` n'obtient qu'un sous-ensemble de la catégorie ``fs``). Les
        catégories cachées (aides model-side) restent toujours disponibles.
        None → comportement historique inchangé.

    deny_tool_names (nouveau, défaut None) : couche de deny FINALE (voir
        _collect_mcp_tools) — s'applique AUSSI aux catégories cachées et aux
        builtins, contrairement à allowed_tool_names. Le moteur de sous-agents
        (outil ``task``) l'utilise pour interdire ``task``/``todowrite`` à un
        enfant (anti-récursion). None → inchangé.

    builtin_tools: dict mapping tool_name → {"definition": {...}, "handler": callable}
                   handler(args) → str (JSON result). Handled inline, no MCP needed.

    _inline_semaphore (nouveau, défaut False) :
        - False (legacy) → le caller est responsable d'acquérir LLM_SEMAPHORE
          autour de l'appel entier à cette fonction. Pendant les tool calls
          MCP, le sémaphore reste pris (comportement historique).
        - True → cette fonction acquiert LLM_SEMAPHORE elle-même, UNIQUEMENT
          autour de chaque appel LLM individuel dans la boucle. Entre deux
          itérations (pendant les tool calls MCP), le sémaphore est libéré.
          Combiné avec --cache-ram côté llama-server, un autre user peut
          utiliser le slot pendant qu'on exécute un tool, et le kv cache
          est automatiquement restauré au retour.
          L'alias ``run_chat_multi_mcp_v2`` force ce comportement.

    OPTIMISATION (mcp_pool) :
    ─────────────────────────
    Les connexions MCP sont désormais persistantes grâce à MCPConnectionPool.
    Au lieu de spawner un nouveau subprocess + handshake + list_tools à chaque
    requête, le pool maintient les connexions en vie et cache les outils
    pendant TOOLS_CACHE_TTL_SEC (défaut 360s). La reconnexion est automatique.

    Fallback automatique : si le LLM ne supporte pas les tool calls natifs
    (finish_reason != "tool_calls" ET pas de tool_calls dans la réponse), on
    tente de détecter des appels JSON en texte libre via extract_tool_calls()
    pour assurer la compatibilité avec les modèles plus anciens.
    """
    await verify_llm_availability()
    start_time = time.time()

    # AUDIT 2026-08-31 (passe 3) — le sémaphore inline ne concerne que le
    # moteur LOCAL (max_models=1 : une seule clé de modèle active). Acquis
    # SANS test de cible, un run sur connecteur CLOUD occupait l'unique slot
    # local à chaque itération (les utilisateurs du modèle local attendaient
    # derrière un run qui n'envoie rien au GPU), et attendait lui-même
    # derrière leurs générations. Même patron que _guard.py (le niveau
    # ordonnanceur saute déjà les cibles distantes).
    #
    # AUDIT 2026-09-16 — un connecteur llama.cpp a désormais SON gestionnaire
    # (``_scheduling._engines``) : le sémaphore inline s'applique à tout
    # serveur llama.cpp, chacun sur le sien ; les autres cibles le sautent.
    if _inline_semaphore:
        try:
            from llm_core.engines import current_engine
            if not current_engine().is_llamacpp:
                _inline_semaphore = False
        except Exception:
            pass

    # ── Détection vision : permet d'injecter les screenshots automatiquement
    # quand le LLM appelle pw_page("inspect") sur un modèle multimodal.
    _model_has_vision = await _model_supports_vision(model or LLAMA_MODEL or "")
    # Chat key pour tracker la dernière screenshot (user + chat_id).
    # Chaque chat garde sa propre screenshot → pas de fuite entre chats du même user.
    _chat_key_suffix = chat_id or "default"

    # ── 1. Connexion aux serveurs MCP via le pool, collecte des outils ────
    # Logique déplacée dans _collect_mcp_tools. Raises RuntimeError si les
    # serveurs sont configurés mais aucun n'a pu se connecter (et pas de
    # builtin_tools pour compenser). Le pool ré-ingère le registre de
    # catégories (tags/meta) à chaque connexion.
    tool_cfg_map, tools_payload, builtin_handlers, connected_server_names = \
        await _collect_mcp_tools(
            mcp_configs, builtin_tools, on_event,
            allowed_tool_names=allowed_tool_names,
            memory_enabled=memory_enabled,
            deny_tool_names=deny_tool_names,
            read_only=read_only,
        )

    # Snapshot des tools actifs pour ce turn. Sert au manifeste
    # ``# Active tools`` injecté dans la tête système et à la porte du rappel
    # todo. Calcul une fois, passé tel quel — les helpers chat ne mutent pas
    # cette liste.
    _allowed_tool_names: List[str] = sorted(set(tool_cfg_map.keys()) | set(builtin_handlers.keys()))

    # (2026-09-02, revue adhérences MCP — A13) L'injection du ``meta``
    # (username/chat_id/live_shell/call_id) ne vise que les outils du serveur
    # LOCAL, reconnu par sa CONFIG (``tool_cfg_map`` : outil → serveur), plus
    # par PRÉFIXE DE NOM via le registre de catégories : un serveur EXTERNE
    # exposant ``read_file``/``memory``… recevait l'identité de l'utilisateur
    # dans son ``_meta``, et le registre (peuplé par la connexion locale) créait
    # une course « registre vide → identité guest ».
    def _is_local_tool(_tn: str) -> bool:
        _c = tool_cfg_map.get(_tn) or {}
        # (2026-09-12, P4) toute entrée INTÉGRÉE du manifeste (service partagé,
        # MCP interne de l'app) reçoit l'identité ; jamais un serveur tiers.
        return _c.get("command") == "DEFAULT_LOCAL_PYTHON" or _c.get("identity") == "meta"

    if on_event and connected_server_names:
        await _emit(on_event, {
            "type": "mode",
            "text": (
                f"Connecté : {', '.join(connected_server_names)} "
                f"({len(tools_payload)} outil(s))"
            ),
        })

    # ── 2. Assemblage du contexte opérationnel (→ context.assembly) ───────
    # Socle défaut si absent + capacités actives (fragments) + runtime_ctx +
    # sanitisation + AX memory + fold dans l'UNIQUE système de tête.
    # Comportement verbatim de l'ancien bloc inline — la byte-stabilité de la
    # tête entre itérations est gardée par les goldens payload.
    # AUDIT 2026-09-25 — hors de la boucle d'événements : l'assemblage lit la
    # base (compte, profil réseau, réglages) et, pour la mémoire AX d'un chat
    # navigateur, interroge le service Playwright par un ``urlopen`` synchrone
    # (jusqu'à 2 s) — tous les flux du worker gelaient à chaque début de tour.
    working_messages = await asyncio.to_thread(
        _assemble_operational_context,
        messages,
        allowed_tool_names=_allowed_tool_names,
        username=username,
    )

    # ── 2b. Rappel d'état todo (début de tour) ────────────────────────────
    # Cf. _todo_status_reminder : des tâches todowrite restées ouvertes au
    # tour précédent sont ré-données au modèle comme ÉTAT COURANT, pas
    # seulement comme archéologie de tool_history. Append en QUEUE (tête
    # système intacte → prefix-cache préservé), éphémère (jamais persisté,
    # jamais rendu côté UI — même canal que <harness_status>). Gate sur la
    # disponibilité réelle de l'outil ce run : un enfant task (todowrite
    # denied) ou un run sans outils n'a rien à faire de ce rappel.
    #
    # AUDIT 2026-09-24 (n° 16) — le tour commence presque toujours par le
    # ``user`` réel : un second ``user`` à sa suite fait lever les gabarits à
    # alternance stricte (famille Gemma, Mistral) → 500, puis aplatissement.
    # Le rappel est alors FUSIONNÉ dans ce dernier ``user``, sur une COPIE (le
    # dict appartient à l'appelant, qui le persiste : le rappel ne doit jamais
    # y entrer). Seule la queue change, la tête système reste intacte.
    if "todowrite" in _allowed_tool_names:
        _todo_reminder = await asyncio.to_thread(_todo_status_reminder, username, chat_id)
        if _todo_reminder:
            _tail = working_messages[-1] if working_messages else None
            if isinstance(_tail, dict) and _tail.get("role") == "user":
                from llm_core.context.pruning import merge_user_suffix
                working_messages[-1] = {
                    **_tail, "content": merge_user_suffix(_tail.get("content"),
                                                          _todo_reminder)}
                # AUDIT 2026-09-25 — le rappel n'existait que pour CE tour :
                # au tour suivant, la question était rendue sans lui, et le
                # préfixe KV divergeait dès elle — tout le tour précédent
                # (outils, résultats) re-préchargé à chaque nouveau message
                # tant que des tâches restaient ouvertes. La route persiste ce
                # suffixe (event interne) et l'expansion le rejoue à l'octet.
                await _emit(on_event, {"type": "llm_user_suffix",
                                       "text": _todo_reminder})
            elif not (isinstance(_tail, dict) and _tail.get("role") == "assistant"):
                # AUDIT 2026-09-26 — queue ``assistant`` = préremplissage d'une
                # reprise (« Continuer » d'un raisonnement coupé) : un ``user``
                # ajouté derrière désarmait ``continue_final_message`` et la
                # reprise native devenait un tour neuf (raisonnement refait).
                working_messages.append(_ephemeral_msg("user", _todo_reminder))

    # 2e valeur de retour de la boucle. Elle ne porte QUE les mutations de
    # fichiers (outil + chemin + succès) : la route chat l'ignore (elle reçoit
    # tout en direct via ``on_event``), mais un appelant HEADLESS — les routines
    # — n'a aucun autre moyen de savoir ce que le run a produit. Volontairement
    # sans le contenu ni le résultat : quelques dizaines d'octets par écriture,
    # pas un second journal.
    events: List[Dict]   = []

    def _record_file_mutation(evt: Dict, result_str: Any) -> None:
        path = evt.get("path")
        if not path:
            return
        events.append({
            "type": "tool_result",
            "name": evt.get("name"),
            "path": path,
            "ok":   not _result_is_tool_failure(result_str),
        })

    cumul_in = cumul_out = 0
    cumul_cache_read = cumul_cache_creation = 0
    # Cumul d'usage partagé avec le wrapper (AUDIT 2026-09-25) : enregistré
    # par lui si le run meurt annulé, marqué ``recorded`` par les retours.
    _usage_acc = _RUN_USAGE_ACC.get()

    def _auto_compaction_on() -> bool:
        """Compaction automatique active pour ce run ? Décision résolue par
        l'appelant, sinon interrupteur maître RELU du disque (AUDIT
        2026-09-26) : lu avant la resynchronisation, il gardait une valeur
        périmée pour les runs sans appelant (routines, agents) quand l'admin
        l'avait changée depuis un autre worker."""
        if compression_enabled is not None:
            return bool(compression_enabled)
        with swallow("harness.auto_compaction_reload"):
            from shared_infra.config import reload_compression_config_from_disk
            reload_compression_config_from_disk()
        return bool(getattr(_bk_config, "COMPRESSION_ENABLED", True))

    def _usage_note(*, recorded: bool = False) -> None:
        if _usage_acc is None:
            return
        _usage_acc.update({
            "in": cumul_in, "out": cumul_out,
            "cache_read": cumul_cache_read,
            "cache_creation": cumul_cache_creation,
            "iterations": effective_iter,
            "model": model or LLAMA_MODEL,
            "inflight_in": 0,
        })
        if recorded:
            _usage_acc["recorded"] = True
    # Raisonnement DÉCLARÉ par le backend (o-series, vLLM récents) : cumulé
    # comme le reste du tour. ``None`` tant qu'aucune itération ne l'a déclaré
    # — auquel cas la mesure de fin de tour prend le relais (tokenisation).
    cumul_reasoning: Optional[int] = None
    last_raw: Dict       = {}
    _all_thinking: List[str] = []   # accumulated thinking across iterations

    # ── 3. Boucle tool-call (cap configurable) ───────────────────────────
    # Limite d'itérations du cycle tool_call → tool_result → tool_call.
    # Défaut : LLAMA_MAX_TOOL_ITERATIONS (env var / config.json). Peut être
    # overridé par chat via sampling_override.max_tool_iterations depuis l'UI.
    # Sans cap, un LLM qui hallucine peut boucler indéfiniment.
    # NOTE: LLM_SEMAPHORE est intentionnellement absent ici.
    # Les appelants (routes.py, orchestrator.py) l'acquièrent déjà AVANT
    # d'appeler run_chat_multi_mcp. asyncio.Semaphore n'est pas réentrant :
    # le ré-acquérir ici provoquerait un deadlock avec LLAMA_MAX_CONCURRENCY=1.
    _max_iter = LLAMA_MAX_TOOL_ITERATIONS
    # Plafond de l'override UI. Le littéral 500 historique était plus BAS que
    # ce qu'un déploiement pouvait légitimement configurer (env/config.json
    # n'ont pas de plafond) : l'UI ne pouvait pas exprimer un run que le
    # serveur autorisait. Le plafond suit désormais la config.
    _iter_ceiling = max(500, LLAMA_MAX_TOOL_ITERATIONS * 4)
    if sampling_override and isinstance(sampling_override, dict):
        _mi_override = sampling_override.get("max_tool_iterations")
        if isinstance(_mi_override, (int, float)) and 1 <= int(_mi_override) <= _iter_ceiling:
            _max_iter = int(_mi_override)
    if _max_iter != LLAMA_MAX_TOOL_ITERATIONS:
        logger.info("[run_chat_multi_mcp] max_tool_iterations override : %d "
                    "(défaut %d)", _max_iter, LLAMA_MAX_TOOL_ITERATIONS)

    # True si le budget dur a DROPPÉ des messages au dernier fit : la mesure
    # réelle décrit alors la vue RÉDUITE, pas working_messages complet → on
    # la débranche (porte sur l'estimation du complet, fast-path off) pour ne
    # pas masquer la saturation. Régime saturé = comportement pré-bascule.
    _fit_dropped = False
    # Groupes que le budget dur a retirés à l'itération précédente : ils le
    # RESTENT (hystérésis, AUDIT 2026-09-25 — cf. enforce_context_budget).
    # Remis à zéro dès que ``working_messages`` est réécrit (compaction,
    # aplatissement) : ses groupes ne désignent plus les mêmes messages.
    _budget_drop_floor = 0
    # Occupation contexte RÉELLE du dernier appel LLM (usage.prompt_tokens +
    # completion_tokens du serveur) et longueur de working_messages à cet
    # instant. None tant qu'aucune réponse reçue — autorité de la règle
    # d'overflow et du fast-path du budget dur.
    _last_real_ctx_tok: Optional[int] = None
    _real_ctx_msg_count: Optional[int] = None
    # État de compression persisté du chat (round/covered/résumé) — avance
    # localement si une compression réussit DANS ce run. Cap atteint →
    # _compr_capped coupe définitivement les checks pour ce run.
    _compr_state_cur = compression_prev_state
    _compr_capped = False
    # Tokens du schéma tools : le set d'outils est STABLE sur tout le run →
    # compté UNE fois (lazy) au lieu de re-dump + re-hash ~30 Ko à chaque
    # itération. Partagé par la pré-porte (repli estimé), la porte exacte du
    # compresseur et le budget dur (cf. _count_tools_payload_tokens_ex).
    _tools_tok_counted: Optional[Tuple[int, bool]] = None
    # Longueur du schéma d'outils en CHARS — numérateur du ratio chars/token
    # mesuré (le dénominateur, ``prompt_tokens``, le facture). Stable sur tout
    # le run, calculé une fois.
    try:
        _tools_payload_chars = (len(json.dumps(tools_payload, ensure_ascii=False))
                                if tools_payload else 0)
    except Exception:
        _tools_payload_chars = 0
    # ctx_size du modèle pour activer le seuil tokens. Récupéré une fois
    # en début de boucle (le modèle ne change pas en cours de conversation).
    # Résolu PAR CIBLE (audit 2026-08-01, P0-3) : sur un connecteur distant, le
    # /props LOCAL décrit un autre modèle — voire rien du tout, et ctx=0 met
    # TOUT le pipeline en veille (ni compaction, ni élagage, ni budget, et un
    # cap d'émission bloqué à son plancher). ``resolve_context_window`` retombe
    # sur le /props local pour une cible locale : comportement inchangé là.
    try:
        from llm_core._ctx_window import resolve_context_window
        _ctx_size_for_compression = await resolve_context_window(
            model or LLAMA_MODEL or "")
    except Exception:
        _ctx_size_for_compression = 0

    # ── Total pour la JAUGE de contexte LIVE ─────────────────────────────
    # Historiquement la jauge était MASQUÉE (total=0) dès que la cible n'était
    # pas le llama-server local : ``get_model_context_size`` y renvoyait le
    # n_ctx d'un AUTRE modèle, donc un pourcentage faux. Depuis que la fenêtre
    # est résolue par CIBLE (``resolve_context_window``), le total est juste
    # quand il est connu — on l'affiche. Fenêtre inconnue ⇒ 0 ⇒ masquée, comme
    # avant : on n'affiche toujours JAMAIS un pourcentage inventé.
    _gauge_ctx_total = _ctx_size_for_compression if _ctx_size_for_compression > 0 else 0

    # ── Cap d'itérations : 2 compteurs (productivité + plafond dur) ───
    # Historique : un simple ``for iteration in range(_max_iter)`` faisait
    # qu'une itération où le modèle appelait un outil qui ÉCHOUE (mauvais
    # nom, arguments invalides, MCP timeout) consommait quand même une
    # itération du budget. Cas vécu en prod : 33 outils réussis + 13
    # échecs = budget de 50 atteint avant la fin du travail réel.
    #
    # Nouveau modèle :
    #   - ``effective_iter`` ne s'incrémente QUE sur une itération
    #     "productive" (au moins un tool_call de cette itération a
    #     renvoyé un résultat sans champ ``error``, ou pas de tool_call
    #     du tout = réponse finale). C'est ce compteur qu'on compare au
    #     budget utilisateur ``_max_iter``.
    #   - ``hard_iter`` est un cap absolu (= ``_max_iter * 2``, plafonné
    #     à ``LLAMA_MAX_TOOL_ITERATIONS`` × 2) qui protège contre les
    #     boucles infinies si TOUS les tool calls d'un modèle hallucinant
    #     échouent en cascade. Sans cela, un modèle cassé pourrait
    #     boucler indéfiniment sans que ``effective_iter`` n'avance.
    _effective_iter_budget = _max_iter
    _hard_iter_cap = max(_max_iter * 2, _max_iter + 10)
    effective_iter = 0
    hard_iter = 0
    iteration = 0

    # ── Budgets de RÉCUPÉRATION : des SÉRIES, pas des totaux de run ──────
    # Audit 2026-08-01 (P0-4). Ces compteurs étaient posés une fois pour tout
    # le run et jamais réarmés. Dimensionnés pour un tour de conversation, ils
    # devenaient absurdes sur une mission : deux hoquets moteur espacés de
    # deux heures, ou trois JSON cassés en 300 itérations, tuaient un run par
    # ailleurs parfaitement productif. Ce qu'on veut borner, c'est un
    # ENCHAÎNEMENT d'échecs (le modèle est coincé) — pas leur somme sur la
    # durée. Tous sont donc remis à zéro dès qu'une itération aboutit.

    # Récupération « historique empoisonné » : si le 1er appel LLM échoue
    # (llama.cpp 500 au rendu du template), on aplatit l'historique tool
    # en texte et on retente UNE seule fois. Ce flag garantit l'unicité
    # (il porte sur l'itération 0 uniquement — pas de notion de série).
    _flatten_retry_done = False
    # M3 : relance après compaction sur « contexte dépassé ». Série bornée,
    # réarmée par toute itération qui aboutit.
    _ctx_overflow_retries = 0
    _CTX_OVERFLOW_RETRY_MAX = 2
    # Backoff des ÉCHECS de compaction : chaque échec consécutif repousse la
    # tentative suivante de 3×2^streak itérations (cap ×8) ; reset au succès.
    _last_compression_iter = -1_000_000  # sentinelle : « jamais »
    _compr_fail_streak = 0
    # Compactions RÉUSSIES dans ce run. Le harnais v4 en autorisait UNE
    # (« un run monstre attendra le tour suivant ») : tenable pour un tour
    # court, absurde pour 200 itérations — passé la première, il ne restait
    # que le budget dur, qui JETTE les vieux tours au lieu de les résumer.
    # Plafond : ``COMPACTIONS_PER_RUN_MAX`` (config, défaut 8), MIS À
    # L'ÉCHELLE du budget d'itérations réel de CE run (audit long-run
    # 2026-08-21) : le réglage global ne peut pas connaître un
    # ``max_tool_iterations`` relevé par chat depuis l'UI, et un run à 600
    # itérations a besoin de plus de compactions qu'un run à 40. Une
    # compaction par tranche de ~25 itérations productives, jamais moins que
    # le réglage global.
    # Le cap PAR CONVERSATION choisi par le compte relève ce budget quand il
    # est plus haut (``run_compaction_budget``) : sur une mission de plusieurs
    # heures, tout tient dans UN run, et un budget de run inférieur au cap
    # réglé couperait la compaction en plein milieu sans rien expliquer.
    from llm_core.context.compaction_gate import (
        run_compaction_budget as _run_budget,
    )
    _run_compaction_max = _run_budget(
        max(_COMPACTIONS_PER_RUN_MAX, min(64, max(1, _max_iter // 25))),
        compaction_max_rounds)
    if _run_compaction_max != _COMPACTIONS_PER_RUN_MAX:
        logger.info(
            "[run_chat_multi_mcp] budget de compactions du run : %d "
            "(réglage %d, mis à l'échelle sur %d itérations, cap du compte %s)",
            _run_compaction_max, _COMPACTIONS_PER_RUN_MAX, _max_iter,
            "—" if compaction_max_rounds is None
            else ("illimité" if compaction_max_rounds <= 0
                  else compaction_max_rounds))
    _compactions_this_run = 0
    # « Contexte max avant compaction » : choix du compte, sinon défaut
    # d'instance, sinon auto (= plafond technique). Résolu UNE fois par run —
    # un seuil qui changerait en plein run ferait bouger la porte d'une
    # itération à l'autre pour rien.
    _compaction_threshold = compaction_threshold
    if _compaction_threshold is None:
        from llm_core.context.compaction_gate import resolve_threshold
        _compaction_threshold = resolve_threshold()   # défaut d'instance seul
    # Trace « la compaction est partie sur le seuil du compte » : une fois
    # par run, sinon chaque itération au-dessus du seuil la répéterait.
    _compaction_threshold_logged = False
    # Ancrage d'OCCUPATION EXACTE du FULL historique : posé quand une
    # confirmation exacte a refusé la compaction. Contrairement à la mesure
    # serveur (qui décrit la VUE envoyée et est invalidée par un drop du
    # budget dur), cet ancrage mesure ``working_messages`` entier — il reste
    # valide quels que soient les drops, et croît par delta mesuré. Sans lui,
    # le cycle estimation→confirmation se re-payait à chaque itération dès
    # que le budget dur droppait (bande morte v2).
    _occ_anchor_tok: Optional[int] = None
    _occ_anchor_count: Optional[int] = None
    # R10b — retries bornés sur un HOQUET transitoire du moteur à iter>0 (le
    # chemin iter 0 a déjà sa récupération). Série CONSÉCUTIVE : un run de
    # plusieurs heures traverse légitimement plusieurs hoquets isolés ; ce
    # qu'il faut arrêter, c'est un moteur qui ne répond plus du tout.
    _llm_hiccup_streak = 0
    _LLM_HICCUP_RETRY_MAX = 3
    # Sortie « le moteur renvoie des réponses vides » : distincte de la limite
    # d'itérations, qu'elle empruntait faute de chemin propre. Série CONSÉCUTIVE
    # avec son propre compteur (cf. le commentaire au point de test).
    _empty_choices_stop = False
    _empty_choices_streak = 0
    _EMPTY_CHOICES_RETRY_MAX = 3
    # Avertissement « contexte non réductible » : émis UNE fois par tour (la
    # condition, elle, se répète à chaque itération).
    _over_budget_warned = False
    # R10c — budget mur d'horloge OPT-IN de la boucle outillée (0 = off, défaut).
    _loop_max_s = float(getattr(_bk_config, "LLAMA_TOOL_LOOP_MAX_S", 0) or 0)
    _loop_t0 = time.monotonic()

    # Anti-boucle desktop : ring-buffer des signatures d'actions (outil + args +
    # dHash écran). Si le modèle répète la même action sans que l'écran change,
    # on lui injecte un nudge plutôt que de gaspiller des itérations.
    _action_cycle_buf: List[str] = []
    # Cycles confirmés → hard-stop (T4-J). Compteur de SÉRIE : il décroît après
    # une plage d'itérations productives sans cycle. Cumulé sur tout le run, il
    # arrêtait une mission de 3 h sur deux blocages passagers survenus à une
    # heure d'intervalle, avec 100 itérations utiles entre les deux.
    _cycle_detections = 0
    _cycle_clean_streak = 0
    _CYCLE_DECAY_ITERS = 15         # itérations productives sans cycle → oubli
    _cycle_hard_stopped = False

    # ── Élagage INTRA-RUN (audit 2026-08-01, P0-1) ───────────────────────
    # Marques d'élagage actives : celles déjà persistées pour ce chat + celles
    # sélectionnées PENDANT ce run. Appliquées à chaque itération par
    # ``fit_context`` (vue transitoire — ``working_messages`` reste intact).
    # Avant, la sélection n'avait lieu qu'en FIN de tour et le rendu qu'au tour
    # SUIVANT : un run de 200 itérations n'élaguait donc jamais rien.
    _run_prune_keys: set = {k for k in (prune_keys or []) if isinstance(k, str)}
    _prune_keys_new: List[str] = []     # sélectionnées ici → à persister
    _last_prune_iter = -10_000

    # A1 — relances bornées après un tool-call non parsable (cf. injection plus
    # bas). Évite qu'un modèle qui émet du JSON cassé en boucle ne consomme tout
    # le budget : au-delà de ce cap, on laisse retomber sur la réponse finale.
    _malformed_retry = 0
    _MALFORMED_RETRY_MAX = 2

    # Fiche 5 — dernier JALON <harness_status> émis (dédoublonnage). Clé
    # mixte ``("steps", k)`` / ``("hard", n)`` : sans ça, le même jalon serait
    # ré-injecté à chaque tour raté — et l'alerte « plafond dur », elle,
    # ne sortirait JAMAIS (elle vit précisément quand effective_iter stagne).
    _hs_last_status_key: Optional[Tuple[str, int]] = None

    # AUDIT 2026-08-23 — un slot LLM pour TOUS les appels de la boucle.
    #
    # En mode « optimized », le garde d'ordonnancement renonce EXPLICITEMENT
    # au niveau 2 (« v2 gère son propre sémaphore ») : la protection est donc
    # entièrement déléguée à cette boucle. Or elle ne couvrait que DEUX de ses
    # QUATRE points d'appel LLM — l'appel outillé et le tour de synthèse. Les
    # deux compactions (porte d'occupation et rattrapage « contexte dépassé »)
    # POSTaient directement, hors de tout ``async with`` : ``llama_chat`` →
    # ``llama_chat_stream_tokens`` n'acquiert rien (aucune occurrence de
    # LLM_SEMAPHORE dans ``_chat_classic`` ni dans le compresseur). Sur un
    # serveur à un slot, un résumé de 50 s atterrissait donc à côté de la
    # génération d'un autre utilisateur : préfixe KV évincé, réutilisation
    # mesurée à 99 % retombée à ~0, et aucun des deux dans le widget de file
    # puisque l'attente n'avait jamais eu lieu.
    def _engine_semaphore():
        """Gestionnaire de concurrence du SERVEUR de la cible (AUDIT
        2026-09-16) : ``LLM_SEMAPHORE`` pour l'intégré, le gestionnaire dédié
        d'un connecteur llama.cpp sinon (cf. ``_scheduling._engines``)."""
        from llm_core._scheduling._engines import scheduling_for
        from llm_core.engines import current_engine
        return scheduling_for(current_engine())[1]

    @asynccontextmanager
    async def _llm_slot():
        """Slot LLM du mode inline ; no-op en classic (le caller le tient)."""
        if _inline_semaphore:
            async with _engine_semaphore().acquire_for(model, priority=priority):
                yield
        else:
            yield

    # AUDIT 2026-08-23 — jeton de routage des logs, unique à CE run.
    #
    # Le routeur de logs du wrapper MCP (``_LogRouter``) est porté par
    # l'instance de wrapper ; or le serveur d'outils locaux se fond en UNE
    # seule entrée de pool (``_make_key``), donc UN routeur pour tous les
    # comptes et tous les chats du worker. Or l'identifiant d'appel n'est
    # unique QUE dans un run : le harnais fabrique ``call_{iter}_{idx}`` /
    # ``legacy_{iter}_{idx}``, et llama.cpp lui-même renvoie ``call_0``. Deux
    # ``execute_shell`` concurrents portaient donc le MÊME jeton : la sortie
    # du terminal d'un compte partait chez l'autre, puis le premier
    # ``unregister`` coupait le flux du second.
    #
    # On ne touche PAS au ``call_id`` — il apparie l'appel et son résultat,
    # côté modèle comme côté rendu chat. On transporte un jeton SÉPARÉ, dédié
    # au routage, que le pont d'exécution recopie dans ses notifications.
    _run_log_tok = secrets.token_hex(4)

    # tool_history de CE run — le DELTA persisté sur le message assistant.
    # Liste parallèle à ``working_messages`` : chaque site d'append agentique
    # « persistable » (rounds assistant, tool results, textes assistant
    # conservés) pousse dans les deux ; les messages de contrôle injectés
    # mi-tour (harness_status, nudges anti-boucle/compact-retry, diagnostics
    # de parse, frame vision base64) restent dans ``working_messages`` seul —
    # ils sont éphémères et ne doivent JAMAIS être rejoués aux tours suivants.
    # Liste séparée ⇒ immunisée contre les réassignations de
    # ``working_messages`` (compression mi-boucle, flatten iter-0) ; les dicts
    # sont partagés, jamais mutés (invariant test_no_mutation_pipeline).
    # C'est CE delta — et non plus une capture cumulative depuis le 1er
    # message agentic — qui borne la croissance : l'ancienne capture
    # ré-incluait l'historique des tours précédents ré-expandé en tête du
    # payload, et la route ré-expansait chaque bulle ⇒ doublement du contexte
    # à chaque tour (1, 7, 19, 43, 91, 187 messages…) jusqu'à saturation de
    # n_ctx (« génération interrompue » systématique).
    _run_tool_history: List[Dict[str, Any]] = []

    def _delta_snapshot() -> List[Dict[str, Any]]:
        """Delta du run, débarrassé d'un ``assistant.tool_calls`` terminal
        orphelin (annulation en PLEINE exécution d'outil : l'assistant a été
        appendé, les ``tool`` results pas encore). Ré-expandé par un
        « Continuer », un tool_calls sans sortie déroute le modèle."""
        hist = list(_run_tool_history)
        while hist and hist[-1].get("role") == "assistant" and hist[-1].get("tool_calls"):
            hist.pop()
        return _cap_run_tool_history(hist)

    # Sortie « contexte saturé » : compteur de tool calls coupés par
    # finish=length D'AFFILÉE. À _TRUNC_STREAK_MAX, on sort par le chemin
    # tool-limit (au lieu de spinner jusqu'au hard cap en appendant 2 messages
    # par relance, ce qui AGGRAVE la saturation).
    _truncated_streak = 0
    _truncated_ctx_full = False   # au moins une coupe de la série = fenêtre pleine
    _ctx_saturated_stop = False
    _gen_cap_stop = False         # série de coupes par le plafond de SORTIE
    # Sortie VOLONTAIRE de la boucle (mur d'horloge, coupes en série, boucle
    # d'action). Avant, ces chemins écrasaient ``effective_iter`` avec le
    # budget pour passer la condition du ``while`` : le couple exposé à l'UI
    # (« 200/200 tours ») mentait, et la cause réelle se perdait derrière une
    # « limite d'itérations atteinte ». Le compteur reste désormais vrai.
    _forced_stop = False
    # ── Auto-reprise d'un raisonnement coupé (filet, cf. _think_resume) ──────
    # Un finish=length SANS tool_call ni prose (coupure 100 % thinking) relance
    # l'appel LLM avec le raisonnement accumulé (continue_final_message natif ou
    # prefill <think>) au lieu d'armer la bannière. C'est AUSSI le garde-fou
    # anti-boucle de ces coupes-là : _TRUNC_STREAK_MAX ne compte que les coupes
    # AVEC tool_calls. Le chaînage est PAR APPEL LLM : remis à zéro dès qu'un
    # round aboutit (symétrique de _truncated_streak = 0). Les prefills de
    # reprise sont TRANSIENTS — jamais dans working_messages ni
    # _run_tool_history (tool_history delta intacte).
    _think_resume_count = 0     # reprises chaînées en cours
    _think_resume_tokens = 0    # completion_tokens cumulés du chaînage
    _pending_think_resume: Optional[str] = None  # demande pour le PROCHAIN appel
    _pending_resume_native_ok = True  # canal natif OK pour cette demande ?
    # Reprise in-run d'une RÉPONSE (prose) coupée — audit long-run 2026-08-21.
    # Sans elle, une coupure par plafond (ou un flux interrompu) en pleine
    # rédaction terminait le tour sur « Continuer » : sans effet dans une
    # mission autonome. Compteur SÉRIE, réarmé par tout tour qui conclut
    # normalement (comme les autres séries de récupération de cette boucle).
    _content_resume_count = 0
    _pending_content_resume: Optional[str] = None
    # Audit « limites fantômes » 2026-07-31 — plusieurs chemins sortent de la
    # boucle par la synthèse sans que le budget soit en cause (``_forced_stop``) :
    # mur d'horloge, contexte saturé, boucle d'action. Le tour de synthèse
    # affirmait alors toujours « step budget exhausted » — une cause FAUSSE :
    # le modèle rapportait à l'utilisateur une limite d'étapes qu'il n'avait pas
    # atteinte. On garde donc la vraie cause pour la lui donner.
    _wallclock_stop = False

    # Snapshot best-effort de la tool_history du run, émis quand la génération
    # est ANNULÉE en pleine boucle d'outils. Sans ça, le partiel sauvé par la
    # route n'a aucune trace des outils déjà exécutés → un « Continuer » repart
    # AVEUGLE et peut rejouer des outils mutants (write/git/shell) déjà
    # appliqués. On émet un event interne (``tool_history_partial``) que la route
    # attache au partiel (fusionné au tronc côté route si Continue). Émission
    # ``shield``ée pour survivre à l'annulation en cours ; tout échec est avalé
    # (on ne perd alors rien de plus que le comportement actuel).
    # Lot d'outils EN COURS — audit 2026-08-23. ``execute_tool_batch`` remplit
    # ``_batch_partial`` en place ; sur annulation réelle elle relève, donc le
    # post-traitement (events ``tool_result`` + push dans _run_tool_history)
    # ne s'exécute JAMAIS pour ce round. Les outils mutants du lot, eux, ont
    # bel et bien appliqué leur effet de bord : ils sont sérialisés, donc
    # exécutés en premier. Sans matérialisation, ``_delta_snapshot`` dépilait
    # en plus l'``assistant.tool_calls`` terminal — le round ne laissait
    # AUCUNE trace, et « Continuer » rejouait le write/commit/shell.
    _batch_partial: Dict[int, str] = {}
    # (passe 7, H2) — itération pour laquelle des ``tool_call_delta`` sont
    # partis SANS ``tool_call`` derrière (encore) ; consommé en tête de boucle
    # (event ``reset``) ou effacé quand le round s'exécute.
    _delta_pending_iter: List[Optional[int]] = [None]
    _batch_prepared: List[Dict[str, Any]] = []

    def _materialiser_lot_interrompu() -> None:
        """Matérialise le round interrompu dans ``_run_tool_history``.

        Chaque appel du lot reçoit un message ``tool`` : son VRAI résultat
        s'il a abouti, une sentinelle explicite sinon. L'appariement
        id ↔ résultat reste donc complet — condition pour que
        l'``assistant.tool_calls`` survive au dépilage de ``_delta_snapshot``
        et pour que le tour ré-expansé soit valide côté gabarit."""
        if not _batch_prepared:
            return
        # AUDIT 2026-09-24 (2e passe) — « sans résultat » recouvre DEUX cas :
        # jamais lancé, ou EN VOL au Stop (l'annulation côté client ne défait
        # pas l'effet déjà appliqué par le serveur : commit, push, écriture).
        # Affirmer « NON exécuté » poussait le modèle à tout relancer au
        # « Continuer » ; on dit la vérité : état inconnu, à vérifier.
        _sentinelle = json.dumps(
            {"error": "interrompu par l'utilisateur avant la fin — exécution "
                      "NON confirmée (l'outil a pu agir en partie) : vérifier "
                      "l'état avant de le relancer"},
            ensure_ascii=False)
        _deja = {m.get("tool_call_id"): m for m in _run_tool_history
                 if m.get("role") == "tool"}
        _n_reels = 0
        for _i, _p in enumerate(_batch_prepared):
            _cid = _p.get("call_id")
            if not _cid:
                continue
            _res = _batch_partial.get(_i)
            _prev = _deja.get(_cid)
            if _prev is not None:
                # (passe 7, H8) — un snapshot ANTÉRIEUR (tâche A du lot) a
                # posé la sentinelle pour cet appel alors que sa tâche a
                # terminé ``execute_single`` entre-temps : le vrai résultat
                # remplace la sentinelle (sinon le partiel affirme qu'un
                # outil n'a pas tourné alors qu'il a tourné).
                if _res is not None and _prev.get("content") == _sentinelle:
                    _prev["content"] = _res
                    _n_reels += 1
                continue
            if _res is None:
                _res = _sentinelle
            else:
                _n_reels += 1
            _run_tool_history.append({
                "role":         "tool",
                "tool_call_id": _cid,
                "content":      _res,
            })
        if _n_reels:
            logger.warning(
                "[run_chat_multi_mcp] annulation en plein lot : %d outil(s) "
                "déjà exécuté(s) matérialisé(s) dans la tool_history du "
                "partiel (sinon « Continuer » les rejouait).", _n_reels)

    async def _emit_partial_tool_history_snapshot() -> None:
        with swallow("harness.emit_partial_tool_history_snapshot"):
            _materialiser_lot_interrompu()
            _ph = _delta_snapshot()
            if _ph:
                await asyncio.shield(_emit(on_event, {
                    "type": "tool_history_partial", "tool_history": _ph,
                }))

    async def _guard_cancel(coro):
        """(passe 7, H4) Point de suspension du POST-TRAITEMENT d'un lot
        d'outils (events, suivi de session Playwright, vision) : une
        annulation délivrée ici arrive alors que les outils ont TOUS tourné
        et que ``_run_tool_history`` porte déjà le round — snapshot avant de
        propager, comme aux autres points d'annulation.

        AUDIT 2026-09-24 (n° 12) — même filet pour les autres points de
        suspension hors des ``try`` d'annulation : tête de boucle, backoffs
        (hoquet, réponse vide), rapatriement des captures, fin de tour
        (mesure du raisonnement, métriques, élagage). À n'utiliser QUE hors
        d'un bloc qui snapshote déjà, sinon l'event partirait deux fois."""
        try:
            return await coro
        except asyncio.CancelledError:
            await _emit_partial_tool_history_snapshot()
            raise

    def _last_run_assistant_text() -> str:
        """Dernier texte assistant produit par CE run (``_run_tool_history``),
        jamais par ``working_messages`` : celle-ci porte tout l'historique du
        chat, et un run sans prose rendait alors la réponse du TOUR PRÉCÉDENT.
        ``content`` en liste de blocs toléré (fournisseur multimodal)."""
        for m in reversed(_run_tool_history):
            if isinstance(m, dict) and m.get("role") == "assistant":
                _t = _content_text(m.get("content"))
                if _t.strip():
                    return _t
        return ""

    # ``execute_single`` lié aux tables d'outils de CE run — passé à
    # ``execute_tool_batch`` (injection : évite un cycle d'import engine↔ce module).
    async def _bound_execute_single(
        tool_name, final_args, *,
        meta=None, progress_callback=None, log_callback=None,
    ):
        return await _execute_single_tool_call(
            tool_name, final_args, tool_cfg_map, builtin_handlers,
            meta=meta, progress_callback=progress_callback,
            log_callback=log_callback,
        )

    def _maybe_inject_harness_status() -> None:
        """Fiche 5 — point d'étape budget appendé APRÈS les tool results du
        tour (append-only, jamais dans la tête système → prefix-cache intact).
        Invisible côté UI : les messages role:user injectés mi-tour ne sont
        jamais rendus (cf. _tool_segments « prompt / nudge mid-turn »).
        ``working_messages`` lu via la closure (suit les réassignations)."""
        nonlocal _hs_last_status_key
        _hard_left = max(0, _hard_iter_cap - hard_iter)
        _hs = _harness_status_line(
            effective_iter, _effective_iter_budget,
            wall_left_s=((_loop_max_s - (time.monotonic() - _loop_t0))
                         if _loop_max_s > 0 else None),
            hard_left=_hard_left,
        )
        if not _hs:
            return
        # Dédoublonnage par JALON, pas par ``effective_iter`` seul : une
        # itération non productive laisse ``effective_iter`` inchangé, et
        # c'est EXACTEMENT le régime où l'alerte « plafond dur » compte. La
        # clé mixte laisse donc passer l'alerte de cascade tout en gardant un
        # seul point d'étape budget par palier.
        _key = ("hard", _hard_left) if _hard_left <= 5 else ("steps", effective_iter)
        if _key == _hs_last_status_key:
            return
        _hs_last_status_key = _key
        # ÉPHÉMÈRE : jamais persisté, donc jamais compté comme un tour
        # (sans quoi ``covered_turns`` sur-compte à la compaction et le
        # tour suivant jette de vrais tours en trop — cf. P1-6).
        working_messages.append(_ephemeral_msg("user", _hs))

    async def _after_truncated_cut(channel: str) -> None:
        """Tool call coupé par ``finish=length`` — chemins natif ET texte.

        Qualifie la coupe avant de la compter (fenêtre pleine ou plafond de
        génération ?), puis, à ``_TRUNC_STREAK_MAX`` coupes d'affilée, force la
        sortie par le chemin tool-limit en gardant la cause réelle. Le compteur
        d'itérations productives n'est PAS touché."""
        nonlocal hard_iter, _truncated_streak, _truncated_ctx_full
        nonlocal _forced_stop, _ctx_saturated_stop, _gen_cap_stop
        _cut_full = _length_cut_is_ctx_full(usage, _ctx_size_for_compression)
        await _handle_truncated_tool_call(
            on_event, working_messages, _iter_clean, iteration,
            channel=channel, run_history=_run_tool_history, ctx_full=_cut_full,
        )
        hard_iter += 1
        _truncated_streak += 1
        if _cut_full is True:
            _truncated_ctx_full = True
        if _truncated_streak < _TRUNC_STREAK_MAX:
            return
        _forced_stop = True
        if _truncated_ctx_full:
            _ctx_saturated_stop = True
            await _emit(on_event, {
                "type": "notice", "level": "warn",
                "message": "contexte saturé — arrêt des appels d'outils",
            })
            logger.warning(
                "[run_chat_multi_mcp] %d tool calls coupés d'affilée "
                "(finish=length, %s) → contexte saturé, sortie par le chemin "
                "tool-limit", _truncated_streak, channel,
            )
        else:
            _gen_cap_stop = True
            await _emit(on_event, {
                "type": "notice", "level": "warn",
                "message": "appels d'outils coupés par le plafond de "
                           "génération — arrêt",
            })
            logger.warning(
                "[run_chat_multi_mcp] %d tool calls coupés d'affilée "
                "(finish=length, %s) par le plafond de génération — fenêtre "
                "NON pleine, sortie par le chemin tool-limit",
                _truncated_streak, channel,
            )

    while (effective_iter < _effective_iter_budget
           and hard_iter < _hard_iter_cap and not _forced_stop):

        # Yield cooperatively : permet à CancelledError (task.cancel())
        # de se propager immédiatement ici si client déconnecté — avec le
        # snapshot de la tool_history, comme aux autres points d'annulation
        # (sinon le partiel du tour précédent de boucle perdait ses outils).
        await _guard_cancel(asyncio.sleep(0))

        # ── Cancellation check (called before LLM request and every tool call) ──
        if is_cancelled and is_cancelled():
            logger.info("[run_chat_multi_mcp] Cancellation demandée par l'utilisateur → arrêt")
            await _emit_partial_tool_history_snapshot()
            raise asyncio.CancelledError("User cancelled")

        # R10c — budget mur d'horloge OPT-IN : une longue chaîne d'outils lents
        # (mais qui réussissent) n'est bornée que par le NOMBRE d'itérations. Si
        # activé (LLAMA_TOOL_LOOP_MAX_S>0) et dépassé, on sort par le chemin
        # « limite atteinte » (tour de synthèse) plutôt que de continuer indéfiniment.
        # La garde « au moins un tour » porte sur le compteur DUR : exiger
        # ``effective_iter > 0`` laissait un run 100 % en échec (aucune
        # itération productive) échapper au budget de temps jusqu'au cap dur.
        if (_loop_max_s > 0 and (time.monotonic() - _loop_t0) > _loop_max_s
                and (effective_iter > 0 or hard_iter > 0)):
            _forced_stop = True
            _wallclock_stop = True
            await _emit(on_event, {"type": "notice", "level": "warn",
                                   "message": "budget de temps de la tâche atteint — synthèse et arrêt"})
            logger.warning("[run_chat_multi_mcp] budget mur d'horloge (%.0fs) atteint → synthèse", _loop_max_s)
            continue

        # Suivi des compteurs pour le reste de la boucle :
        #   ``iteration`` reste le compteur "absolu" affiché dans les
        #   logs/UI (chaque tour LLM = +1) pour ne pas casser les
        #   messages utilisateurs et la corrélation des _req_id.
        iteration = hard_iter

        # Événement de TOUR ReAct (un appel LLM = un tour, quel que soit le
        # nombre de tool calls qu'il émet). Le moteur d'agents s'en sert pour une
        # barre « tours / budget » fidèle — compter les ``tool_call`` surestime
        # quand le modèle fait des appels parallèles.
        # AUDIT 2026-06 — ``tokens_used`` (cumul in+out de TOUS les tours)
        # SUR-COMPTE massivement l'occupation contexte en mode outils : les
        # prompt_tokens de chaque tour ré-incluent tout l'historique, donc le
        # cumul croît quadratiquement. On émet EN PLUS ``context_tokens`` =
        # prompt+completion du DERNIER tour (l'occupation réelle, même calcul
        # que l'event kv_cache) ; champ additif, fallback ``tokens_used``
        # conservé pour les clients existants. Ne PAS toucher cumul_in/out
        # (sémantique comptable assumée, métriques historiques).
        _last_usage_live = (last_raw or {}).get("usage") or {}
        await _emit(on_event, {
            "type": "iteration", "n": effective_iter + 1, "max": _effective_iter_budget,
            # tokens cumulés des tours PRÉCÉDENTS (in+out) → jauge « Contexte »
            # des agents qui bouge EN DIRECT (pas seulement au budget final).
            "tokens_used": cumul_in + cumul_out,
            "context_tokens": int(_last_usage_live.get("prompt_tokens", 0) or 0)
                            + int(_last_usage_live.get("completion_tokens", 0) or 0),
        })

        # Tracker de productivité de l'itération en cours. Mis à True
        # dès qu'au moins UN tool call de cette itération renvoie un
        # résultat sans erreur. Sert à incrémenter ``effective_iter``
        # uniquement sur les itérations productives (voir explication
        # détaillée à l'init du loop).
        _iteration_had_success = False

        await _emit(on_event, {"type": "mode", "text": "Réflexion…"})

        # Callbacks streaming : thinking et contenu émis token par token
        _iter_thinking_parts: List[str] = []
        _iter_content_parts:  List[str] = []

        async def _on_think_iter(tok: str, _buf: List[str] = _iter_thinking_parts) -> None:
            _buf.append(tok)
            await _emit(on_event, {"type": "thinking_token", "text": tok})

        # Émission DIRECTE (AUDIT 2026-08-31, cf. _LIVE_MARKUP_SUSPECT_RE) :
        # ``n`` = caractères déjà émis, ``pend`` = fenêtre non émise,
        # ``gated`` = markup suspecté → plus d'émission pour l'itération.
        # Si l'itération se conclut en tool_calls, le front reclasse le
        # contenu streamé dans la narration du segment (cf. app-chat.js,
        # _preToolText au premier event tool_call) — c'est le même rendu
        # qu'obtenait l'ancien rejeu tool_thinking, mais en direct.
        _live_stream = {"n": 0, "pend": "", "gated": False}

        async def _on_content_iter(tok: str, _buf: List[str] = _iter_content_parts,
                                   _st: Dict[str, Any] = _live_stream) -> None:
            _buf.append(tok)
            if _st["gated"]:
                return
            _st["pend"] += tok
            m = _LIVE_MARKUP_SUSPECT_RE.search(_st["pend"])
            if m is not None:
                _st["gated"] = True
                chunk = _st["pend"][:m.start()]
                _st["pend"] = ""
            else:
                cut = len(_st["pend"]) - _LIVE_HOLDBACK_CHARS
                if cut <= 0:
                    return
                chunk = _st["pend"][:cut]
                _st["pend"] = _st["pend"][cut:]
            if chunk:
                _st["n"] += len(chunk)
                await _emit(on_event, {"type": "content_token", "text": chunk})

        async def _flush_live_pend(_st: Dict[str, Any] = _live_stream) -> None:
            """(passe 7, H11) Émet la fenêtre de retenue avant un ``continue``
            de récupération : ``_live_stream`` est recréé à chaque tour de
            boucle, ces ≤48 caractères déjà générés étaient perdus (narration
            coupée en plein mot). No-op si le portail anti-markup a coupé."""
            if _st["gated"] or not _st["pend"]:
                return
            chunk = _st["pend"]
            _st["pend"] = ""
            _st["n"] += len(chunk)
            await _emit(on_event, {"type": "content_token", "text": chunk})

        # (passe 7, H2) — des fragments d'arguments (tool_call_delta) ont été
        # streamés pour une itération qui n'a PAS abouti à des tool_call
        # (coupure en pleine génération des args, hoquet, aplatissement,
        # rattrapage overflow, tool_call tronqué) : ce tour de boucle la
        # rejoue ou l'abandonne — le front doit jeter l'accumulateur de cette
        # itération, sinon le JSON d'args est concaténé deux fois (aperçu
        # Monaco corrompu) ou l'édition optimiste reste ouverte.
        if _delta_pending_iter[0] is not None:
            await _emit(on_event, {"type": "tool_call_delta", "reset": True,
                                   "index": -1, "iter": _delta_pending_iter[0]})
            _delta_pending_iter[0] = None

        # Callback streaming : fragments d'arguments des tool_calls en cours
        # de génération par le LLM. Émis AVANT l'exécution du tool, purement
        # informatif pour le frontend (pré-affichage streaming de
        # write_file / edit_file dans l'éditeur). Le frontend accumule et
        # décode progressivement le JSON des args. Chaque index correspond
        # à un tool call distinct dans la même itération (parallel tool use).
        async def _on_tool_call_delta_iter(
            index: int,
            name_delta: str,
            args_delta: str,
            _iter: int = iteration,
        ) -> None:
            # (2026-09-02) Le modèle a FINI sa prose : plus aucun texte ne
            # suivra dans ce flux (les deltas d'appel viennent après le
            # contenu). On relâche la fenêtre de retenue MAINTENANT — sinon
            # les ≤48 derniers caractères de la phrase restaient invisibles
            # pendant toute la génération des arguments (plusieurs secondes
            # pour un write_file) et surgissaient d'un coup avec l'appel.
            await _flush_live_pend()
            # On ne transmet que s'il y a quelque chose à transmettre. Le
            # frontend utilise un reset automatique par iteration (tracking
            # via `call_idx` + `iteration`). `_iter` est figé via default
            # arg pour éviter tout piège de late-binding en closure.
            evt: Dict[str, Any] = {
                "type":  "tool_call_delta",
                "index": index,
                "iter":  _iter,
            }
            _delta_pending_iter[0] = _iter    # (passe 7, H2) cf. reset en tête de boucle
            if name_delta:
                evt["name_delta"] = name_delta
            if args_delta:
                evt["args_delta"] = args_delta
            await _emit(on_event, evt)

        # Progression du PRÉ-REMPLISSAGE. C'est la phase où le flux est
        # totalement muet : mesuré 33 s pour 4 339 tokens sur GPU grand
        # public, donc plusieurs MINUTES sur un historique long — pendant
        # lesquelles l'utilisateur ne peut pas distinguer « ça calcule » de
        # « c'est planté ». Le moteur sait le dire depuis b10545, on le relaie.
        #
        # ``cache`` est le bonus : c'est le nombre de tokens RÉELLEMENT
        # réutilisés du préfixe KV, donc la première mesure directe de ce que
        # produisent nos efforts de byte-stabilité (ordre figé des outils,
        # coupes idempotentes, ancrage du prompt).
        _pp_last_emit = [0.0]
        _pp_logged = [False]

        async def _on_prompt_progress(pp: Dict[str, Any]) -> None:
            _total = int(pp.get("total") or 0)
            _done = int(pp.get("processed") or 0)
            _cache = int(pp.get("cache") or 0)
            # Prompt de l'appel EN VOL (AUDIT 2026-09-26) : un Stop pendant
            # la génération perdait sinon ses tokens d'entrée — souvent le
            # plus gros poste du run. Remis à zéro par ``_usage_note`` dès
            # que l'appel se termine et entre dans le cumul.
            if _usage_acc is not None and _total > 0:
                _usage_acc["inflight_in"] = _total
            _final = _total > 0 and _done >= _total
            _now = time.monotonic()
            # Cadence : au plus un événement par demi-seconde, mais le dernier
            # (100 %) passe toujours — sans quoi la barre resterait figée.
            if _final or (_now - _pp_last_emit[0]) >= 0.5:  # noqa: B023 (même itération)
                _pp_last_emit[0] = _now  # noqa: B023 (même itération)
                await _emit(on_event, {
                    "type": "prompt_progress",
                    "total": _total, "processed": _done, "cache": _cache,
                    "time_ms": int(pp.get("time_ms") or 0),
                    "iter": iteration,  # noqa: B023 (même itération)
                })
            if _final and not _pp_logged[0] and _total > 0:  # noqa: B023 (même itération)
                _pp_logged[0] = True  # noqa: B023 (même itération)
                logger.info(
                    "[run_chat_multi_mcp] pré-remplissage iter %d : %d tokens, "
                    "%d réutilisés du cache KV (%.0f %%), %.1f s",
                    iteration, _total, _cache, 100.0 * _cache / _total,  # noqa: B023 (même itération)
                    (pp.get("time_ms") or 0) / 1000.0)
                with swallow("harness.kv_reuse_metric"):
                    await asyncio.to_thread(
                        log_metric, "kv_prefix_reuse_pct",
                        int(100.0 * _cache / _total), {
                            "model": model or LLAMA_MODEL or "",
                            "iteration": iteration,  # noqa: B023 (même itération)
                        })

        # Demande d'auto-reprise CONSOMMÉE par cet appel (cf. plus bas) :
        # posé juste avant l'appel, il dit aux relances (hoquet, aplatissement,
        # compaction, réponse sans ``choices``) qu'il faut la RESTITUER.
        _resume_consumed = False
        _resume_arg: Optional[str] = None
        _resume_native_ok_arg = True
        _resume_content_arg: Optional[str] = None

        # Wrap l'appel LLM principal pour ne pas crasher la boucle entière
        # si llama-server hoquète sur un seul tour (parser tool_calls qui
        # plante, timeout transient, etc.). Au lieu de raise, on émet un
        # event d'erreur et on retourne le partiel accumulé.
        try:
            # F8 — n_ctx figé à 0 sur un échec TRANSITOIRE de /props au démarrage
            # (llama saturé au 1er tour) désactivait budget ET compression pour
            # TOUT le run (early-return sur ctx<=0), même après récupération du
            # serveur → prompt jamais élagué → finish=length en plein tool_call.
            # On re-sonde tant que c'est 0 : la valeur correcte est déjà chauffée
            # par clamp_generation_budget (re-sonde chaque itération). Cache
            # global → quasi-gratuit une fois chaud.
            if not _ctx_size_for_compression or _ctx_size_for_compression <= 0:
                with swallow("harness.run_chat_multi_mcp_impl"):
                    _ctx_size_for_compression = await get_model_context_size(
                        model or LLAMA_MODEL or "")
                    if (_ctx_size_for_compression and _ctx_size_for_compression > 0
                            and _gauge_ctx_total <= 0):
                        # Re-évalue la visibilité de la jauge (local uniquement).
                        with swallow("harness.run_chat_multi_mcp_impl.2"):
                            from llm_core._target import current_target as _ct2
                            # Tout serveur llama.cpp : n_ctx lu sur SON /props.
                            if _ct2().is_llamacpp:
                                _gauge_ctx_total = _ctx_size_for_compression

            # ── Surcoût fixe du prompt : tokens du schéma tools ─────────────
            # Compté UNE fois par run (set d'outils stable), AVANT la porte de
            # compression et le budget : pré-porte (repli estimé), porte exacte
            # et budget dur partagent ainsi le MÊME total. Gate sur ctx connu :
            # si le /props local n'a pas répondu, inutile de tenter le
            # /tokenize (pas de stall pour une cible distante sans serveur).
            if (_tools_tok_counted is None and tools_payload
                    and _ctx_size_for_compression):
                _tools_tok_counted = await _count_tools_payload_tokens_ex(
                    tools_payload, model or LLAMA_MODEL or None)
            _tools_fixed_tok = int(_tools_tok_counted[0]) if _tools_tok_counted else 0

            # ── Compaction : LA règle d'overflow (harnais v4, M3) ─────────
            # occupation ≥ usable = n_ctx − cap de génération − buffer.
            # Occupation, par ordre de vérité : mesure RÉELLE du dernier
            # appel + delta des messages apparus depuis (ratio mesuré,
            # zéro I/O) ; sans mesure (tête de tour, reload) : estimation
            # au ratio mesuré, CONFIRMÉE par un comptage exact dans
            # maybe_compress avant d'agir (l'occupation exacte est alors
            # ancrée comme pseudo-mesure → pas de re-comptage par itération).
            # Ni pourcentage, ni marge, ni cooldown — restent : le backoff
            # des ÉCHECS (×2^streak), « une compaction par run », le cap
            # par chat et la matière minimale (côté compresseur).
            # AUDIT 2026-09-25 — compaction auto DÉSACTIVÉE (le défaut par
            # compte) : la porte entrait quand même dans ``_llm_slot()`` à
            # chaque itération au-dessus du seuil — une attente en FILE pour un
            # compresseur qui répondait aussitôt « disabled », puis une seconde
            # attente pour le vrai appel. Même règle que le compresseur
            # (décision déjà résolue par l'appelant, sinon interrupteur maître).
            _auto_compr_on = _auto_compaction_on()
            if (_auto_compr_on and not _compr_capped
                    and _compactions_this_run < _run_compaction_max):
                _in_backoff = (
                    _compr_fail_streak > 0
                    and (iteration - _last_compression_iter)
                    < 3 * (2 ** min(_compr_fail_streak, 3)))
                _usable_tok = 0
                _gate_tok = 0
                _compr_gate = None
                if _ctx_size_for_compression and _ctx_size_for_compression > 0:
                    # AUDIT 2026-08-02 (W13) — resync disque AVANT lecture :
                    # c'était le seul chemin de lecture des COMPRESSION_* qui
                    # ne repassait pas par reload_compression_config_from_disk,
                    # donc la valeur « oscillait » selon le worker qui servait
                    # le tour après une modif admin, jusqu'au redémarrage.
                    # Alimente AUSSI le buffer et le défaut d'instance du seuil.
                    with swallow("harness.run_chat_multi_mcp_impl.3"):
                        from shared_infra.config import reload_compression_config_from_disk
                        reload_compression_config_from_disk()
                    from llm_core.context.compaction_gate import (
                        compaction_gate,
                        gate_tokens,
                    )
                    _compr_gate = compaction_gate(
                        _ctx_size_for_compression,
                        thinking_mode=thinking_mode,
                        threshold=_compaction_threshold)
                    _usable_tok = _compr_gate.usable_tokens
                    # Le seuil du compte s'oppose à l'occupation à CHAQUE
                    # itération, pas seulement en tête de tour. On est ici
                    # ENTRE deux appels d'outils : la requête précédente est
                    # finie, la suivante n'est pas partie — rien n'est en cours
                    # de streaming, il n'y a pas de flux à couper. Et une
                    # mission de plusieurs heures ne connaît qu'UN tour : la
                    # reporter au « tour suivant » revenait à ne jamais
                    # compacter.
                    _gate_tok = gate_tokens(_compr_gate)
                _occ = None
                _occ_is_real = False
                if _gate_tok > 0 and not _in_backoff:
                    from llm_core.context.tokens import measured_prompt_tokens
                    _real = None if _fit_dropped else _last_real_ctx_tok
                    if (_real and _real > 0 and _real_ctx_msg_count is not None
                            and 0 <= _real_ctx_msg_count <= len(working_messages)):
                        _occ = int(_real) + measured_prompt_tokens(
                            working_messages[_real_ctx_msg_count:],
                            model_id=(model or LLAMA_MODEL or None))
                        _occ_is_real = True
                    elif (_occ_anchor_tok and _occ_anchor_count is not None
                          and 0 <= _occ_anchor_count <= len(working_messages)):
                        # Ancrage exact du FULL historique (drop-proof) + delta.
                        _occ = int(_occ_anchor_tok) + measured_prompt_tokens(
                            working_messages[_occ_anchor_count:],
                            model_id=(model or LLAMA_MODEL or None))
                        _occ_is_real = True
                    else:
                        _occ = measured_prompt_tokens(
                            working_messages,
                            model_id=(model or LLAMA_MODEL or None),
                            extra_fixed=_tools_fixed_tok)
                # Compaction déclenchée par le SEUIL DU COMPTE et non par le
                # plafond technique : dit une fois par run. C'est la seule
                # trace qui distingue « la fenêtre était pleine » de « le
                # compte a demandé à compacter à ce niveau-là » — un opérateur
                # qui voit compacter à 60 % d'occupation doit pouvoir savoir
                # lequel des deux parle.
                if (_occ is not None and _compr_gate is not None
                        and _compr_gate.is_user_threshold
                        and not _compaction_threshold_logged
                        and _occ >= _gate_tok):
                    _compaction_threshold_logged = True
                    logger.info(
                        "[run_chat_multi_mcp] compaction sur le seuil du compte "
                        "(%d tk, réglé %s) à l'itération %d — occupation ≈%d, "
                        "plafond technique à %d tk.",
                        _compr_gate.trigger_tokens, _compr_gate.describe(),
                        iteration, _occ, _usable_tok)
                if _occ is not None and _occ >= _gate_tok:
                    from llm_core.conversation_compressor import (
                        compression_was_attempted,
                        maybe_compress_conversation,
                    )
                    async with _llm_slot():
                        working_messages, _compr_stats = await maybe_compress_conversation(
                            working_messages,
                            llama_chat_fn   = llama_chat,
                            on_event        = on_event,
                            model           = model,
                            user_id         = str(username),
                            log_prefix      = f"multi_mcp[iter{iteration}]",
                            ctx_size_tokens = _ctx_size_for_compression or None,
                            real_tokens     = (_occ if _occ_is_real else None),
                            usable_tokens   = _usable_tok,
                            # Seuil EFFECTIF : celui du compte s'il est plus bas
                            # que le plafond technique. Ancre aussi la cible de la
                            # compaction partielle.
                            trigger_tokens  = _gate_tok,
                            # Cap par conversation choisi par le compte (None =
                            # défaut d'instance). Sur une mission longue, c'est LUI
                            # le vrai mur : atteint, plus rien ne compacte et il ne
                            # reste que le budget dur, qui jette au lieu de résumer.
                            max_rounds      = compaction_max_rounds,
                            prev_state      = _compr_state_cur,
                            # Même surcoût fixe que la jauge et le budget : la
                            # porte se déclenche sur le poids RÉEL du prompt.
                            extra_fixed_tokens = _tools_fixed_tok,
                            # FTS avant destruction : les tours compressés restent
                            # cherchables via session_search (rattachés à CE chat).
                            fts_session_id  = chat_id,
                            # ``auto_enabled`` est une décision DÉJÀ RÉSOLUE par
                            # l'appelant (contrat de maybe_compress_conversation) :
                            # interrupteur maître admin ET opt-in per-user, le mode
                            # mission étant pris en compte côté route. Forcer True
                            # ici court-circuiterait aussi le kill-switch admin.
                            auto_enabled    = compression_enabled,
                        )
                    # Cap par conversation atteint : maybe_compress a émis
                    # ``compression_capped`` (badge UI) — on coupe les checks
                    # pour le reste du run (sinon re-émission à chaque iter).
                    if _compr_stats.get("reason") == "max_rounds_reached":
                        _compr_capped = True
                    # Compression appliquée : l'état LOCAL avance (les tours
                    # couverts ont été REMPLACÉS par le résumé → équivalent
                    # d'un drop PLEIN, d'où applied_drop_turns=covered).
                    if _compr_stats.get("new_state"):
                        _compr_state_cur = dict(
                            _compr_stats["new_state"],
                            applied_drop=True,
                            applied_drop_turns=int(
                                _compr_stats["new_state"].get("covered_turns") or 0),
                        )
                    if (compression_was_attempted(_compr_stats)
                            or _compr_stats.get("defer_retry")):
                        # Backoff : échec consécutif → prochaine tentative
                        # repoussée de 3×2^streak itérations ; succès → reset
                        # + une seule compaction par run.
                        # ``defer_retry`` = compaction ABOUTIE (ou abandonnée
                        # avant l'appel) sans approcher sa cible. La retenter à
                        # l'itération suivante redonnerait le même résultat au
                        # même prix — 50 s d'appel LLM pour quelques milliers
                        # de tokens, toutes les trois minutes. Elle pèse donc
                        # comme un échec dans le backoff, et le compteur se
                        # remet à zéro dès qu'une compaction atteint sa cible.
                        _compr_fail_streak = (
                            0 if (_compr_stats.get("compressed")
                                  and not _compr_stats.get("defer_retry"))
                            else min(_compr_fail_streak + 1, 3))
                        _last_compression_iter = iteration
                        if _compr_stats.get("compressed"):
                            _compactions_this_run += 1
                            _budget_drop_floor = 0
                            # Une compaction qui aboutit prouve que le chemin
                            # de récupération « contexte dépassé » fonctionne :
                            # on réarme sa série.
                            _ctx_overflow_retries = 0
                            # Mesures pré-compression obsolètes : la prochaine
                            # réponse LLM re-mesurera.
                            _last_real_ctx_tok = None
                            _real_ctx_msg_count = None
                            _occ_anchor_tok = None
                            _occ_anchor_count = None
                    elif (_compr_stats.get("reason") == "threshold_not_reached"
                          and _compr_stats.get("occupancy_tokens")):
                        # L'estimation ratio dépassait ``usable`` mais le
                        # comptage EXACT est en dessous : ANCRE l'occupation
                        # exacte du full historique (drop-proof) — le comptage
                        # ne sera pas re-payé à chaque itération.
                        _occ_anchor_tok = int(_compr_stats["occupancy_tokens"])
                        _occ_anchor_count = len(working_messages)

            # ── Élagage INTRA-RUN des vieilles sorties d'outils (P0-1) ────
            # Sélection périodique PENDANT le run : sans elle, les marques
            # n'étaient produites qu'en fin de tour et appliquées qu'au tour
            # SUIVANT — un run long empilait donc ses résultats d'outils sans
            # jamais rien récupérer, et n'avait plus que le budget dur (qui
            # jette) pour tenir dans la fenêtre. Best-effort : un échec ici ne
            # doit jamais interrompre le run.
            if (_PRUNE_EVERY_ITERS > 0 and _ctx_size_for_compression
                    and (iteration - _last_prune_iter) >= _PRUNE_EVERY_ITERS):
                _last_prune_iter = iteration
                try:
                    _new_keys = await _select_prune_keys(
                        working_messages,
                        ctx_size=_ctx_size_for_compression,
                        model_id=(model or LLAMA_MODEL or None),
                        already_marked=_run_prune_keys,
                    )
                    if _new_keys:
                        _run_prune_keys.update(_new_keys)
                        _prune_keys_new.extend(_new_keys)
                        # La dernière mesure serveur décrit la vue AVANT
                        # élagage : la garder ferait rater au fast-path tout
                        # le contexte qu'on vient de libérer. On la débranche
                        # pour que le fit recompte exactement une fois.
                        _last_real_ctx_tok = None
                        _real_ctx_msg_count = None
                        logger.info(
                            "[run_chat_multi_mcp] élagage intra-run iter %d : "
                            "%d sortie(s) d'outil effacée(s) de la vue "
                            "(total marqué : %d)",
                            iteration, len(_new_keys), len(_run_prune_keys),
                        )
                except Exception:
                    logger.debug("[run_chat_multi_mcp] élagage intra-run échoué",
                                 exc_info=True)

            # Pipeline de réduction (→ context.pruning.fit_context) :
            # marques d'élagage → élagage des frames vision (2 dernières
            # gardées) → budget dur (garantie prompt + génération ≤ n_ctx,
            # réserve = cap de génération effectif). working_messages n'est
            # jamais muté : la liste renvoyée est la VUE transitoire envoyée
            # au LLM.
            _fit_stats: Dict[str, Any] = {}
            compacted_msgs = await _fit_context(
                working_messages,
                ctx_size=_ctx_size_for_compression,
                model_id=(model or LLAMA_MODEL or None),
                thinking_mode=thinking_mode,
                tools_fixed_tokens=_tools_fixed_tok,
                real_ctx_tokens=_last_real_ctx_tok,
                real_ctx_msg_count=_real_ctx_msg_count,
                stats_out=_fit_stats,
                prune_keys=_run_prune_keys,
                drop_floor=_budget_drop_floor,
            )
            _budget_drop_floor = int(_fit_stats.get("drop_floor", 0) or 0)
            # Drop par le budget dur ⇔ la vue est plus courte (la vision
            # REMPLACE du contenu, seuls les drops retirent des messages).
            # Conditionne la validité de la prochaine mesure réelle.
            # (passe 8, B12) — la longueur seule mentait quand ``_ensure_user_
            # anchor`` insérait l'ancre dans la passe qui retirait un message
            # (+1 −1) : on lit aussi le compteur ``dropped`` du budget dur.
            _fit_dropped = (bool(_fit_stats.get("dropped"))
                            or _budget_drop_floor > 0
                            or len(compacted_msgs) != len(working_messages))

            # Le budget dur n'a PAS su faire tenir le prompt (message unique
            # plus gros que le budget, ou schémas d'outils qui le mangent
            # entièrement). On part quand même — le serveur tranchera — mais
            # on prévient MAINTENANT plutôt que de laisser l'utilisateur
            # découvrir un refus brut après coup. Une seule fois par tour :
            # la condition se répète à chaque itération.
            if _fit_stats.get("over_budget") and not _over_budget_warned:
                _over_budget_warned = True
                _est = _fit_stats.get("estimated")
                _bud = _fit_stats.get("budget")
                _chiffres = (f" (~{_est} tokens estimés pour ~{_bud} disponibles)"
                             if _est and _bud else "")
                await _emit(on_event, {
                    "type": "warning",
                    "text": (
                        "Contexte maximum atteint : la conversation est trop "
                        "longue pour la fenêtre du modèle et n'a pas pu être "
                        f"réduite davantage{_chiffres}. Compactez la "
                        "conversation (/compact), retirez les pièces jointes "
                        "volumineuses, ou démarrez un nouveau chat."
                    ),
                })

            # Jauge de contexte : AUCUNE émission pré-vol. On n'« imagine »
            # plus le prompt (ni /apply-template ni heuristique) : la jauge est
            # recalée UNIQUEMENT sur l'usage réel renvoyé par le serveur en fin
            # de requête (event kv_cache après chaque réponse, plus bas). Entre
            # deux réponses, le front garde la dernière valeur réelle connue.

            # Auto-reprise : consommer la demande pendante pour CET appel (le
            # raisonnement accumulé à poursuivre — None = appel normal).
            _resume_arg = _pending_think_resume
            _resume_native_ok_arg = _pending_resume_native_ok
            _pending_think_resume = None
            _pending_resume_native_ok = True
            _resume_content_arg = _pending_content_resume
            _pending_content_resume = None
            _resume_consumed = True

            # Mode optimized : on acquiert le sémaphore INLINE uniquement
            # autour de cet appel LLM, pas autour des tool calls qui suivent.
            # Cela permet à un autre user de prendre le slot pendant nos
            # tool calls MCP. Le kv cache est gardé en RAM via --cache-ram.
            if _inline_semaphore:
                _wait_start = time.time()
                async with _engine_semaphore().acquire_for(model, priority=priority):
                    _wait_ms = int((time.time() - _wait_start) * 1000)
                    # Écriture SQLite déportée : elle tombe à CHAQUE
                    # itération, juste avant l'appel LLM, et bloquait la
                    # boucle du worker (cf. _write_telemetry dans
                    # engine/tool_exec pour le raisonnement complet).
                    with swallow("harness.run_chat_multi_mcp_impl.4"):
                        await asyncio.to_thread(
                            log_metric, "llm_wait_time_ms", _wait_ms, {
                                "model": model or LLAMA_MODEL or "",
                                "mode": "optimized",
                                "iteration": iteration,
                            })
                    raw_response = await _llama_chat_with_tools_stream(
                        compacted_msgs,
                        tools_payload,
                        model_override=model,
                        user_id=username,
                        on_thinking_token=_on_think_iter,
                        on_content_token=_on_content_iter,
                        on_tool_call_delta=_on_tool_call_delta_iter,
                        on_prompt_progress=_on_prompt_progress,
                        is_cancelled=is_cancelled,
                        sampling_override=sampling_override,
                        thinking_mode=thinking_mode,
                        chat_id=chat_id,
                        resume_think=_resume_arg,
                        resume_native_ok=_resume_native_ok_arg,
                        resume_content=_resume_content_arg,
                    )
            else:
                # Mode classic : le caller a déjà acquis le sémaphore autour
                # de la boucle entière. Appel direct sans wrapping.
                raw_response = await _llama_chat_with_tools_stream(
                    compacted_msgs,
                    tools_payload,
                    model_override=model,
                    user_id=username,
                    on_thinking_token=_on_think_iter,
                    on_content_token=_on_content_iter,
                    on_tool_call_delta=_on_tool_call_delta_iter,
                    on_prompt_progress=_on_prompt_progress,
                    is_cancelled=is_cancelled,
                    sampling_override=sampling_override,
                    thinking_mode=thinking_mode,
                    chat_id=chat_id,
                    resume_think=_resume_arg,
                    resume_native_ok=_resume_native_ok_arg,
                    resume_content=_resume_content_arg,
                )
        except asyncio.CancelledError:
            await _emit_partial_tool_history_snapshot()
            raise
        except Exception as llm_err:
            logger.warning("[run_chat_multi_mcp] Erreur LLM iter %d: %s — termine avec partiel",
                           iteration, str(llm_err)[:200])
            # AUDIT 2026-09-24 (n° 5) — la demande de reprise a été vidée AVANT
            # l'appel : toutes les relances ci-dessous (``continue``) partaient
            # donc SANS elle. Le modèle réécrivait sa réponse depuis le début
            # (doublon à l'écran) et la partie déjà écrite n'arrivait jamais en
            # base. On la restitue ; la voie d'erreur s'en sert aussi (partiel).
            if _resume_consumed:
                _pending_think_resume = _resume_arg
                _pending_resume_native_ok = _resume_native_ok_arg
                _pending_content_resume = _resume_content_arg

            # ── Récupération « historique empoisonné » ───────────────────
            # Un échec dès l'itération 0 n'est PAS un tool call que le
            # modèle vient de produire — c'est l'HISTORIQUE envoyé qui
            # fait planter llama.cpp (rendu du chat template sur un
            # message tool/tool_calls bancal). _sanitize_message_history
            # a déjà tenté de le réparer en amont ; si ça échoue quand
            # même, on APLATIT tout le tool-history en texte brut et on
            # retente UNE fois. Garantit qu'un chat n'est jamais bloqué
            # en boucle 500 — l'utilisateur n'a plus à changer de chat.
            #
            # SAUF si le serveur a dit « contexte dépassé » : l'historique
            # n'est alors pas malformé, il est trop GROS. L'aplatir ne le
            # réduit pas, la seconde tentative échoue pareil, et l'utilisateur
            # aura lu entre-temps un diagnostic faux (« historique
            # incompatible ») au lieu du seul geste utile — compacter.
            _err_kind = _llm_error_kind(getattr(llm_err, "cause", llm_err))

            # ── M3 : « contexte dépassé » ⇒ compacter puis UNE relance ───
            # Le serveur est l'autorité finale de l'overflow : quand il
            # refuse, on compacte (porte d'occupation acquise —
            # triggered_by_overflow) et on retente l'itération une fois.
            # Équivalent de l'auto-continue d'OpenCode, sans message
            # synthétique (notre compaction est inter-itérations).
            # Compaction auto désactivée : pas d'attente en file pour un
            # compresseur qui répondrait « disabled » (AUDIT 2026-09-26, même
            # règle que la porte d'occupation).
            if (_err_kind == _KIND_CTX_OVERFLOW
                    and _compactions_this_run < _run_compaction_max
                    and _ctx_overflow_retries < _CTX_OVERFLOW_RETRY_MAX
                    and _auto_compaction_on()):
                _ctx_overflow_retries += 1
                from llm_core.conversation_compressor import (
                    maybe_compress_conversation as _mcc_overflow,
                )
                # Le gate est BYPASSÉ ici (``triggered_by_overflow``) : le seuil
                # ne sert qu'à ancrer la cible de la compaction partielle. Un
                # compte qui compacte tôt veut aussi récupérer PLUS de marge
                # quand le serveur vient de refuser. Recalculé localement : le
                # gate de la porte d'occupation peut ne pas avoir été construit
                # cette itération (cap atteint, backoff…).
                _ovf_gate = None
                if _ctx_size_for_compression and _ctx_size_for_compression > 0:
                    from llm_core.context.compaction_gate import compaction_gate as _cg
                    _ovf_gate = _cg(_ctx_size_for_compression,
                                    thinking_mode=thinking_mode,
                                    threshold=_compaction_threshold)
                try:
                    async with _llm_slot():
                        working_messages, _ovf_stats = await _mcc_overflow(
                            working_messages,
                            llama_chat_fn   = llama_chat,
                            on_event        = on_event,
                            model           = model,
                            user_id         = str(username),
                            log_prefix      = f"multi_mcp[iter{iteration}:overflow]",
                            ctx_size_tokens = _ctx_size_for_compression or None,
                            usable_tokens   = (_ovf_gate.usable_tokens if _ovf_gate else None),
                            trigger_tokens  = (_ovf_gate.trigger_tokens if _ovf_gate else None),
                            max_rounds      = compaction_max_rounds,
                            triggered_by_overflow = True,
                            prev_state      = _compr_state_cur,
                            extra_fixed_tokens = _tools_fixed_tok,
                            fts_session_id  = chat_id,
                            # Le rattrapage « contexte dépassé » reste une compaction
                            # AUTOMATIQUE : même autorisation que la porte d'occupation,
                            # sinon un utilisateur qui gère lui-même son compactage se
                            # verrait quand même réécrire son historique.
                            auto_enabled    = compression_enabled,
                        )
                except asyncio.CancelledError:
                    # (passe 7, H3) — appel LLM de ~50 s dans ``except
                    # Exception`` : hors du filet d'annulation principal.
                    await _emit_partial_tool_history_snapshot()
                    raise
                if _ovf_stats.get("compressed"):
                    _compactions_this_run += 1
                    _budget_drop_floor = 0
                    _last_real_ctx_tok = None
                    _real_ctx_msg_count = None
                    # L'ancre décrit une liste qui n'existe plus : la garder
                    # ferait rapporter à l'itération suivante l'occupation
                    # d'AVANT la compaction — et comme elle est marquée
                    # « mesure réelle », maybe_compress sauterait sa
                    # confirmation exacte et recompacterait pour rien, juste
                    # après un overflow. Même geste que le chemin nominal.
                    _occ_anchor_tok = None
                    _occ_anchor_count = None
                    if _ovf_stats.get("new_state"):
                        _compr_state_cur = dict(
                            _ovf_stats["new_state"], applied_drop=True,
                            applied_drop_turns=int(
                                _ovf_stats["new_state"].get("covered_turns") or 0))
                    logger.warning(
                        "[run_chat_multi_mcp] contexte dépassé iter %d → "
                        "compaction puis relance (%d/%d de la série)",
                        iteration, _ctx_overflow_retries,
                        _CTX_OVERFLOW_RETRY_MAX)
                    continue
                # Compaction impossible (matière insuffisante, rollback…) :
                # on retombe sur le message utilisateur KIND_CONTEXT_OVERFLOW.

            # AUDIT 2026-08-22 (C5) — cette récupération n'existait qu'à
            # l'itération 0. Or un historique qui devient irrendable par le
            # gabarit du moteur ARRIVE EN COURS DE RUN : un tool_call émis
            # malformé, un artefact de compaction, un résultat orphelin. À
            # l'itération 150 d'une mission autonome, le moteur répondait 400,
            # la série de hoquets rejouait trois fois la MÊME requête — donc
            # trois fois le même 400 — et le run mourait avec la moitié de son
            # budget intacte, alors que la seule voie de sortie connue
            # (l'aplatissement) était juste là, verrouillée par un
            # ``iteration == 0``. On l'autorise une fois par run, à n'importe
            # quelle itération, pour un REFUS DE REQUÊTE (4xx hors dépassement
            # de contexte, qui a son propre chemin de compaction juste au-dessus)
            # et seulement une fois les hoquets épuisés — un 400 franc n'est pas
            # un hoquet, mais on ne veut pas court-circuiter le retry transitoire.
            # AUDIT 2026-09-24 (n° 6b) — à l'itération 0 aussi, seul un REFUS
            # de requête (ou une panne non classée, typiquement le 500 du rendu
            # de gabarit) justifie l'aplatissement. Un timeout, un 503 de
            # chargement, un 429 ou un 401 aplatissaient l'historique : faux
            # message « historique incompatible », cache KV perdu, et la panne
            # réelle intacte. Ces familles passent désormais par le hoquet.
            _flatten_kind_ok = _err_kind in (_KIND_INVALID_REQUEST, _KIND_UNKNOWN)
            _flatten_now = (
                not _flatten_retry_done
                and _flatten_kind_ok
                and (iteration == 0
                     or _llm_hiccup_streak >= _LLM_HICCUP_RETRY_MAX)
            )
            if _flatten_now:
                _flatten_retry_done = True
                logger.warning(
                    "[run_chat_multi_mcp] échec iter %d (%s) → aplatissement de "
                    "l'historique tool et nouvelle tentative (récupération)",
                    iteration, _err_kind,
                )
                await _emit(on_event, {
                    "type": "info",
                    "text": ("Historique de conversation incompatible avec "
                             "le moteur — récupération automatique en cours "
                             "(les détails d'outils des tours précédents "
                             "sont simplifiés en texte)."),
                })
                working_messages = _flatten_tool_messages(working_messages)
                _budget_drop_floor = 0
                # La liste a changé de forme : l'ancre de la dernière mesure
                # réelle ne correspond plus (comme les trois autres réécritures).
                _real_ctx_msg_count = None
                # Idem pour l'ancrage d'occupation exacte : il décrit la liste
                # d'AVANT (même geste que la compaction sur dépassement).
                _occ_anchor_tok = None
                _occ_anchor_count = None
                continue

            # R10b — HOQUET transitoire du moteur : si AUCUN token n'a été
            # streamé pendant l'appel qui a échoué (buffers d'itération vides → zéro
            # texte déjà envoyé au client, donc zéro duplication) ET qu'aucun outil
            # n'a tourné pour cette itération (l'exception vient de l'appel LLM,
            # AVANT l'exécution des outils), on retente LA MÊME itération.
            # ``working_messages`` n'a pas été muté par cet appel → état identique.
            # Série CONSÉCUTIVE (réarmée par toute itération qui aboutit) : un
            # run de plusieurs heures traverse légitimement plusieurs hoquets
            # isolés ; avec l'ancien « une fois par run », le second hoquet —
            # même survenu deux heures plus tard — terminait la mission.
            #
            # AUDIT 2026-09-24 (n° 6) — (a) la famille de panne compte : une
            # panne DÉTERMINISTE (contexte dépassé non compactable, 401/403,
            # quota, 4xx après aplatissement) n'est pas un hoquet — la rejouer
            # trois fois coûtait 12 s pour la même erreur (cf.
            # ``_llm_error_hiccup_ok``). (b) L'itération 0 y a droit aussi :
            # c'est le même état « rien d'exécuté, rien de streamé » — aucun
            # outil n'a tourné dans ce run, et la garde des buffers vides
            # couvre le texte. Elle ne passait jusqu'ici que par l'aplatissement,
            # désormais réservé aux refus de requête (juste au-dessus).
            if (_llm_hiccup_streak < _LLM_HICCUP_RETRY_MAX
                    and not _iter_content_parts and not _iter_thinking_parts
                    and _llm_error_hiccup_ok(
                        _err_kind, getattr(llm_err, "cause", llm_err),
                        flatten_pending=not _flatten_retry_done)):
                _llm_hiccup_streak += 1
                logger.warning("[run_chat_multi_mcp] hoquet moteur iter %d (%s) → "
                               "nouvelle tentative %d/%d (aucun token émis)",
                               iteration, _err_kind, _llm_hiccup_streak,
                               _LLM_HICCUP_RETRY_MAX)
                await _emit(on_event, {
                    "type": "info",
                    "text": "Hoquet du moteur LLM — nouvelle tentative…",
                })
                # Backoff progressif : un moteur qui redémarre a besoin de plus
                # que 2 s à la troisième tentative. (passe 7, H3) — ce sleep
                # vit dans ``except Exception``, hors du filet d'annulation de
                # l'appel LLM : snapshot via ``_guard_cancel``.
                await _guard_cancel(asyncio.sleep(2 * _llm_hiccup_streak))
                continue

            # Message ACTIONNABLE en tête (LLMFailure stringifie déjà en clair ;
            # pour toute autre exception, la taxonomie donne le repli), motif
            # technique dans ``detail`` — replié derrière « Détails » côté UI,
            # plus jamais la seule chose lue par l'utilisateur.
            _err_text = (str(llm_err) if isinstance(llm_err, LLMFailure)
                         else _llm_error_user_message(llm_err))
            _err_detail = (llm_err.detail if isinstance(llm_err, LLMFailure)
                           else f"{type(llm_err).__name__}: {str(llm_err)[:300]}")
            await _emit(on_event, {
                "type": "error",
                "text": f"{_err_text} La réponse partielle est conservée.",
                "detail": _err_detail,
                "kind": _err_kind,
                # Homogène : itérations PRODUCTIVES sur leur budget. Avant, le
                # numérateur portait ``hard_iter`` (tous les tours) et pouvait
                # donc dépasser le dénominateur affiché.
                "iteration": f"{min(effective_iter + 1, _effective_iter_budget)}/{_effective_iter_budget}",
                "hard_iteration": f"{hard_iter + 1}/{_hard_iter_cap}",
            })
            # Retourne le contenu accumulé jusqu'ici comme réponse finale.
            # BUG FIX (markup leak) — le dernier assistant peut être le
            # message synthétique du fallback legacy (content = texte brut
            # AVEC <tool_call>/<function=>) : strip avant de retourner,
            # comme le chemin de réponse finale (cf. _strip_tool_call_markup
            # sur final_clean). Sans ça le markup brut partait dans la bulle
            # ET en base via la route chats.
            # (2026-09-21) Le partiel vient du DELTA DE CE RUN, jamais de
            # ``working_messages`` : celle-ci porte tout l'historique, si bien
            # qu'un run n'ayant produit que des tool_calls renvoyait la réponse
            # du TOUR PRÉCÉDENT (persistée comme nouvelle réponse, « Continuer »
            # offert), et qu'un « Continuer » renvoyait son propre préfixe —
            # doublé en base par la route.
            # Texte déjà streamé par l'appel qui a échoué : c'est ce que
            # l'utilisateur vient de voir s'interrompre — il prime. Sur une
            # reprise de rédaction, il PROLONGE la prose déjà affichée (les
            # segments d'avant la coupure, restitués dans
            # ``_pending_content_resume``) : sans ce préfixe, le partiel ne
            # portait que le dernier segment et la partie 1 disparaissait en base.
            _partial_text = ((_pending_content_resume or "")
                             + "".join(_iter_content_parts)).strip()
            if not _partial_text:
                _partial_text = _last_run_assistant_text()
            if _partial_text:
                _partial_text = _strip_tool_call_markup(_partial_text)
            # AUDIT 2026-09-24 (n° 13) — mêmes clés d'occupation que les deux
            # autres sorties : sans ``last_prompt_tokens`` ni
            # ``submitted_input_tokens``, la jauge de la route
            # (``_kv_gauge_used_tokens``) retombait sur ``input_tokens`` — le
            # CUMUL des itérations — et affichait 100 % après chaque erreur.
            _err_last_usage = (last_raw or {}).get("usage") or {}
            _err_metrics = {
                "input_tokens": cumul_in,
                "submitted_input_tokens": cumul_in,
                "output_tokens": cumul_out,
                "last_prompt_tokens": int(_err_last_usage.get("prompt_tokens", 0) or 0),
                "last_completion_tokens": int(_err_last_usage.get("completion_tokens", 0) or 0),
                "model": model or LLAMA_MODEL,
                "iterations": effective_iter,
                "tool_iterations": iteration,
                "ended_with_error": True,
                # Comme les retours normal et « limite » : sans cette clé, la
                # réflexion affichée en direct disparaissait au rechargement.
                "thinking": "\n\n".join(
                    p for p in (_all_thinking + ["".join(_iter_thinking_parts or [])]) if p),
                # Un partiel existe → le tour est REPRENABLE : ``truncated``
                # fait poser le flag par la route et le front affiche
                # « Continuer ». Avant, une erreur LLM après retries terminait
                # le run sans aucun chemin de reprise en un clic — fatal en
                # mission autonome de plusieurs heures.
                "truncated": bool(_partial_text),
            }
            # tool_history = DELTA du run (voir _run_tool_history). La route
            # fusionne au tronc si Continue — plus de capture cumulative.
            _err_history = _delta_snapshot()
            if _err_history:
                _err_metrics["tool_history"] = _err_history
                _err_metrics["tool_history_delta"] = True
            # Cohérence avec les retours normal/limite : libère la dernière
            # screenshot trackée pour ce chat (sinon fuite mémoire jusqu'au
            # prochain tour, qui l'écraserait de toute façon).
            _clear_last_screenshot_for(f"{username}:{_chat_key_suffix}")
            # AUDIT 2026-08-23 — registre d'usage. Ce troisième retour était le
            # SEUL des trois à ne rien enregistrer : le retour normal (status
            # "ok") et le retour « cap atteint » (status "tool_limit") le font,
            # et le commentaire de ce dernier pose même la règle (« il ne doit
            # surtout pas être le seul à ne rien enregistrer »). Aucune autre
            # couche ne compensait — la route ne journalise plus. Un run
            # autonome de 3 h qui meurt à l'itération 181 disparaissait donc
            # entièrement de l'onglet Utilisation et du tableau de bord, alors
            # qu'il est le plus coûteux de la journée ; le simple fait de
            # réessayer doublait la consommation réelle sans rien indiquer.
            # Le chemin classic, lui, enregistre bien ses partiels (status
            # "aborted") : on s'aligne dessus.
            # AUDIT 2026-09-26 — mesure du raisonnement et enregistrement
            # SÉPARÉS : un échec de la mesure sautait l'enregistrement, alors
            # que le run était marqué « enregistré » juste après — son usage
            # était perdu pour de bon.
            _err_think_tok = 0
            with swallow("harness.measure_thinking_on_error"):
                _err_think_tok, _ = await _guard_cancel(measure_thinking_tokens(
                    "\n\n".join(_all_thinking), model_id=(model or LLAMA_MODEL or None),
                    usage=({"reasoning_tokens": cumul_reasoning}
                           if cumul_reasoning is not None else None),
                    output_tokens=cumul_out))
            with swallow("harness.record_usage_on_error"):
                record_turn_usage(
                    model=(model or LLAMA_MODEL), path="tools",
                    input_tokens=cumul_in, output_tokens=cumul_out,
                    submitted_tokens=cumul_in, thinking_tokens=_err_think_tok,
                    usage={"cache_read_input_tokens": cumul_cache_read,
                           "cache_creation_input_tokens": cumul_cache_creation},
                    duration_ms=int((time.time() - start_time) * 1000),
                    iterations=effective_iter,
                    status="aborted",
                    error_kind=str(_err_kind or type(llm_err).__name__),
                )
            _usage_note(recorded=True)
            return _partial_text, events, _err_metrics

        last_raw = raw_response
        # L'appel LLM a abouti ⇒ les séries de récupération qui portent sur le
        # TRANSPORT sont réarmées (cf. P0-4 : on borne un enchaînement, pas un
        # total de run). Le compteur de tool-calls malformés, lui, porte sur le
        # CONTENU : il est réarmé plus bas, quand une sortie parsable arrive.
        _llm_hiccup_streak = 0
        _ctx_overflow_retries = 0
        usage     = raw_response.get("usage") or {}
        cumul_in  += usage.get("prompt_tokens", 0)
        cumul_out += usage.get("completion_tokens", 0)
        # Cache de prompt (Anthropic) : ces tokens ne sont PAS inclus dans
        # ``prompt_tokens`` et se perdaient jusqu'ici entre deux itérations —
        # le retour sur investissement du cache restait donc invisible côté
        # métriques. On les cumule comme le reste du tour.
        cumul_cache_read     += int(usage.get("cache_read_input_tokens") or 0)
        cumul_cache_creation += int(usage.get("cache_creation_input_tokens") or 0)
        _usage_note()
        # Raisonnement déclaré : cumulé sur les itérations. Ne lire que la
        # dernière sous-compterait tout ce qui a été pensé avant les outils.
        _rsn_iter = _native_reasoning_tokens(usage)
        if _rsn_iter is not None:
            cumul_reasoning = (cumul_reasoning or 0) + _rsn_iter

        # ── Occupation du CONTEXTE DE TRAVAIL, mesurée (fin de requête) ───
        # ``prompt_tokens`` = tout ce que le serveur a réellement reçu (system
        # + tools + historique) à ``_real_ctx_msg_count`` messages. Autorité de
        # la règle d'overflow et du fast-path du budget dur ; les deux ajoutent
        # par-dessus le delta des messages APPARUS depuis la mesure.
        #
        # ⚠ On n'ajoute PAS ``completion_tokens``, pour deux raisons :
        #   1. le raisonnement qu'il contient est ÉPHÉMÈRE — jamais re-soumis
        #      (la boucle ne garde pas ``reasoning_content`` dans
        #      ``working_messages``, ``save_chat`` strippe ``thinking``) : un
        #      long raisonnement ne pèse RIEN sur le contexte de travail, et le
        #      compter déclenchait la compaction pour une occupation qui
        #      n'existait pas au tour suivant ;
        #   2. sa part visible (texte + tool_calls) est DÉJÀ recomptée par le
        #      delta : le message assistant est ajouté à ``working_messages``
        #      APRÈS cette mesure, donc il tombe dans la tranche
        #      ``[_real_ctx_msg_count:]``. L'additionner ici le comptait deux
        #      fois.
        # C'est aussi ce que fait déjà la jauge de contexte de la route
        # (``last_prompt_tokens`` seul) — les deux vues concordent enfin.
        _pt_real = int(usage.get("prompt_tokens", 0) or 0)
        if _pt_real > 0:
            _last_real_ctx_tok = _pt_real
            # Ratio chars/token MESURÉ (harnais v4) : chaque réponse réelle
            # recale la conversion utilisée pour matérialiser les coupes et
            # estimer les deltas sans I/O. Best-effort.
            with swallow("harness.run_chat_multi_mcp_impl.5"):
                from llm_core.context.tokens import count_image_blocks, note_real_usage, payload_chars
                # Numérateur = chars des messages **+ schéma des outils**.
                # Le dénominateur (``prompt_tokens``) facture tout le prompt,
                # schéma d'outils compris (~30 Ko de JSON) : ne compter que
                # les messages sous-estimait donc systématiquement le ratio
                # chars/token — biais maximal en début de run, quand les
                # outils pèsent plus que l'historique. Un ratio trop bas fait
                # SUR-estimer l'occupation (compaction déclenchée trop tôt) et
                # raccourcit les caps d'émission.
                note_real_usage(model or LLAMA_MODEL or None,
                                payload_chars(compacted_msgs) + _tools_payload_chars,
                                _pt_real,
                                n_images=count_image_blocks(compacted_msgs))
            # Tout message d'indice ≥ cette longueur est POSTÉRIEUR à la
            # mesure (assistant du tour + tool_results à venir) → c'est le
            # delta que le fast-path du budget dur ré-estimera. Mesure valable
            # SEULEMENT si l'envoi était complet (pas de drop au fit).
            _real_ctx_msg_count = None if _fit_dropped else len(working_messages)

        # Watcher contexte/perf (LLAMA_WATCH=1) : prompt assemblé (la vue
        # réellement ENVOYÉE) + mesure réelle du serveur + stats du fit.
        # Best-effort, no-op si inactif.
        with swallow("harness.run_chat_multi_mcp_impl.6"):
            from llm_core._watch import watch_llm_call
            watch_llm_call(
                chat_id=chat_id, path="tools", iteration=iteration,
                model=(model or LLAMA_MODEL or ""),
                messages=compacted_msgs, tools_payload=tools_payload,
                usage=usage, timings=raw_response.get("timings") or {},
                fit=dict(_fit_stats, fit_dropped=_fit_dropped),
            )

        # Jauge de contexte : émission UNIQUE, après chaque réponse, depuis
        # l'usage réel (le front recale la jauge sur CHAQUE event kv_cache —
        # plus d'event pré-vol estimé). Affiché = PROMPT RÉEL seul
        # (``prompt_tokens``) : on N'AJOUTE PAS ``completion_tokens``, qui
        # contient le thinking — éphémère, strippé de l'historique au tour
        # suivant (l'inclure redonnerait le saut « 4,7k en fin de tour vs 800
        # à la relance »). Le contenu généré ce tour apparaîtra dans le
        # prompt_tokens réel de la requête suivante.
        with swallow("harness.run_chat_multi_mcp_impl.7"):
            _kv_used  = _pt_real
            # Cible distante → _gauge_ctx_total=0 : même si ``prompt_tokens`` est
            # réel, on n'a pas le BON n_ctx (le /props local ≠ modèle distant) →
            # on masque plutôt que d'afficher un pourcentage faux.
            _kv_total = int(_gauge_ctx_total or 0)
            if _kv_used > 0 and _kv_total > 0:
                await _emit(on_event, {
                    "type": "kv_cache", "used": _kv_used, "total": _kv_total,
                    "pct": min(100, round(_kv_used / _kv_total * 100)),
                })

        choices = raw_response.get("choices") or []
        if not choices:
            # AUDIT long-run 2026-08-21 — une réponse SANS ``choices`` est une
            # anomalie de moteur (réponse tronquée côté serveur, routeur qui
            # renvoie une enveloppe vide), pas une fin de travail. Le ``break``
            # sec sortait par le chemin « limite d'itérations atteinte » : le
            # run s'arrêtait en plein milieu ET l'utilisateur lisait un
            # diagnostic FAUX (« budget d'itérations épuisé » alors qu'il en
            # restait 180). On la traite comme le hoquet moteur d'à côté :
            # série bornée, réarmée par toute itération qui aboutit.
            # Compteur DÉDIÉ : ``_llm_hiccup_streak`` est remis à zéro dès
            # qu'un appel LLM ABOUTIT (juste au-dessus, ``last_raw = …``) — or
            # une réponse vide EST un appel abouti. Le réutiliser ici faisait
            # repartir la série à 1 à chaque tour : retry infini jusqu'au cap
            # dur, exactement la « boucle improductive » qu'on cherche à
            # éviter. Celui-ci n'est réarmé que par une réponse EXPLOITABLE.
            # Une auto-reprise consommée par cet appel vide est restituée (cf.
            # n° 5 dans ``except``) : la relance porte la MÊME demande, et la
            # sortie de série garde la prose déjà affichée pour son partiel.
            if _resume_consumed:
                _pending_think_resume = _resume_arg
                _pending_resume_native_ok = _resume_native_ok_arg
                _pending_content_resume = _resume_content_arg
            if _empty_choices_streak < _EMPTY_CHOICES_RETRY_MAX:
                _empty_choices_streak += 1
                logger.warning(
                    "[run_chat_multi_mcp] réponse sans 'choices' iter %d → "
                    "nouvelle tentative %d/%d", iteration,
                    _empty_choices_streak, _EMPTY_CHOICES_RETRY_MAX)
                await _emit(on_event, {
                    "type": "info",
                    "text": "Réponse vide du moteur — nouvelle tentative…",
                })
                await _guard_cancel(asyncio.sleep(2 * _empty_choices_streak))
                hard_iter += 1
                continue
            logger.error(
                "[run_chat_multi_mcp] réponse sans 'choices' %d fois de suite "
                "— arrêt du run", _empty_choices_streak)
            _empty_choices_stop = True
            break
        # Réponse exploitable : la série de réponses vides est réarmée.
        _empty_choices_streak = 0

        choice     = choices[0]
        finish     = choice.get("finish_reason", "")
        msg        = choice.get("message") or {}
        tool_calls = _unique_tool_call_ids(msg.get("tool_calls") or [],
                                           working_messages)

        # Thinking accumulé pendant le streaming
        _iter_thinking = "".join(_iter_thinking_parts)
        # ``content`` peut arriver en LISTE de blocs (provider multimodal
        # OpenAI-compat) : ``.strip()`` levait AttributeError HORS de tout
        # try → tour entier tué, rien persisté. Coercition défensive.
        _rc = msg.get("content")
        if isinstance(_rc, list):
            _rc = "".join(
                (b.get("text") or "") if isinstance(b, dict) else str(b)
                for b in _rc)
        _raw_content = (str(_rc) if _rc is not None else "").strip()
        # Copie NON strippée : une reprise de rédaction doit renvoyer au
        # serveur EXACTEMENT ce qu'il a produit. Le ``.strip()`` ci-dessus est
        # bon pour l'affichage, mais il mange l'espace de fin — or c'est
        # précisément à cette frontière que la génération reprend : sans lui,
        # « …en trois » + « parties » donne « troisparties ».
        _raw_content_exact = str(_rc) if _rc is not None else ""

        # Fallback : thinking dans le contenu texte (non détecté en streaming).
        # ``truncated`` : sur une coupure par plafond, un <think> non fermé est
        # du raisonnement tronqué — les promotions anti-bulle-vide 3a/3b sont
        # inhibées (sinon le raisonnement s'affiche en markdown dans la bulle).
        if not _iter_thinking:
            _iter_thinking, _raw_content = _extract_thinking(
                _raw_content, truncated=(str(finish or "") == "length"))
            if _iter_thinking:
                await _emit(on_event, {"type": "thinking_content", "text": _iter_thinking})

        _iter_clean = _raw_content
        if _iter_thinking:
            _all_thinking.append(_iter_thinking)
            _clip_thinking_history(_all_thinking)

        # Continuation d'une auto-reprise : FUSIONNER le segment avec le
        # raisonnement déjà accumulé (la reprise continue token-exacte, souvent
        # en pleine phrase — pas d'entrée séparée dans _all_thinking, dont le
        # rendu final joint par "\n\n").
        if _resume_arg:
            if _iter_thinking and _all_thinking and _all_thinking[-1] == _iter_thinking:
                _all_thinking.pop()
            if _all_thinking and _all_thinking[-1] == _resume_arg:
                _all_thinking.pop()
            _iter_thinking = _resume_arg + (_iter_thinking or "")
            _all_thinking.append(_iter_thinking)
            _clip_thinking_history(_all_thinking)

        # Continuation d'une reprise de PROSE : le segment reprend token-exacte
        # à l'intérieur du message assistant non fermé, donc en pleine phrase.
        # On RECOLLE sans séparateur, et on recolle aussi le buffer de tokens
        # (``_iter_content_parts``) : c'est LUI qui alimente le streaming final
        # vers le client — sans ça, la réponse affichée ne montrerait que le
        # dernier segment, en perdant tout ce qui précède la coupure.
        if _resume_content_arg:
            _iter_clean = _resume_content_arg + (_iter_clean or "")
            # ``_iter_content_parts`` n'est alimenté que par le callback de
            # STREAMING. S'il est vide (fournisseur non-streamant, stub de
            # test), il ne faut RIEN y mettre : plus bas,
            # ``_streamed_content`` prime sur ``raw_text`` dès qu'il est non
            # vide — y insérer le seul report ferait perdre le segment qu'on
            # vient de générer.
            if _iter_content_parts:
                _iter_content_parts.insert(0, _resume_content_arg)
                # (passe 7, H1) — le client tient DÉJÀ ce préfixe (émis avant
                # la coupure, queue comprise) : ``n`` doit le compter, sinon
                # ``_live_stream_rest`` renvoie ``(préfixe+segment)[n2:]`` et
                # la réponse est affichée EN DOUBLE à chaque reprise.
                _live_stream["n"] += len(_resume_content_arg)

        # ── Tool call TRONQUÉ par épuisement de la fenêtre de contexte ────
        # finish_reason == "length" + tool_calls : le modèle a été coupé
        # EN PLEIN MILIEU de l'émission de l'appel d'outil (la fenêtre de
        # contexte est pleine — typiquement in_tok + out_tok ≈ n_ctx).
        # Les `arguments` sont donc un JSON tronqué/invalide. Conséquences
        # si on laisse passer :
        #   * exécution → ValidationError pydantic (ex: write_file sans
        #     `path`, FastMCP rejette avant même le corps de l'outil) ;
        #   * SURTOUT : sauver ce message assistant aux tool_calls cassés
        #     empoisonne l'historique → 500 en boucle aux tours suivants.
        # On ne l'exécute donc PAS et on ne sauve PAS les tool_calls
        # tronqués : on garde le texte produit, on explique au modèle, et
        # on reboucle pour qu'il réémette un appel plus compact.
        if finish == "length" and tool_calls:
            await _flush_live_pend()          # (passe 7, H11)
            await _after_truncated_cut("natif")
            continue

        # ── Mode natif : le LLM retourne tool_calls structurés ────────────
        # Compatibilité OpenAI API stricte : on suit ce que le serveur
        # nous renvoie, point. Pas de tentative d'extraction de tool
        # calls depuis le thinking — si un modèle (Qwen, DeepSeek, …)
        # met son JSON dans un bloc reasoning au lieu du canal natif
        # tool_calls, c'est un bug du modèle/template, pas le nôtre à
        # corriger. Cap sur la portabilité multi-modèles.
        if finish == "tool_calls" or tool_calls:
            _delta_pending_iter[0] = None     # (passe 7, H2) le round s'exécute

            # Contenu pré-outil : l'essentiel est DÉJÀ parti en direct via
            # _on_content_iter (le front le reclasse en narration de segment
            # au premier event tool_call). On n'émet ici que le RESTE retenu
            # par la fenêtre/le portail anti-markup, nettoyé du markup
            # <tool_call>/<function=> qu'un modèle mélange parfois à sa prose.
            # Nettoyage divergent sur la partie déjà émise (rare) → on n'émet
            # rien de plus : le transcript persisté porte la version propre.
            _raw_iter_content = "".join(_iter_content_parts)
            _pre_tool_text = _strip_tool_call_markup(_raw_iter_content)
            if _pre_tool_text:
                _pre_rest = _live_stream_rest(
                    _pre_tool_text, _raw_iter_content, _live_stream["n"])
                if _pre_rest:
                    await _emit(on_event, {"type": "content_token", "text": _pre_rest})

            # Round parsé avec succès ⇒ le contexte n'est pas (plus) saturé,
            # et le chaînage d'auto-reprises repart de zéro (par appel LLM).
            _truncated_streak = 0
            _truncated_ctx_full = False
            _think_resume_count = 0
            _content_resume_count = 0
            _think_resume_tokens = 0

            # Ajouter le message assistant au format OpenAI standard :
            # tool_calls structurés à côté du content textuel. Persisté dans
            # la tool_history du run (delta).
            _round_msg = {
                "role":       "assistant",
                "content":    _iter_clean or None,
                "tool_calls": tool_calls,
            }
            # Blocs thinking signés (connecteur Anthropic) : rejoués au
            # prochain appel devant ces tool_use (cf. to_anthropic_messages).
            if msg.get("_anthropic_thinking"):
                _round_msg["_anthropic_thinking"] = msg["_anthropic_thinking"]
            working_messages.append(_round_msg)
            _run_tool_history.append(_round_msg)

            # ── Préparation séquentielle des tool_calls ──────────────────
            # Avant l'exécution (sérielle ou parallèle), on parse les args et
            # injecte ``_username``/``_chat_id`` pour les outils locaux. Ce
            # travail est sync et rapide (manipulations de dict) — on le fait
            # ici pour que la phase d'exécution puisse être batchée.
            prepared: List[Dict[str, Any]] = []
            for _idx, tc in enumerate(tool_calls):
                # Formes hostiles (provider non-llama, réponse malformée) :
                # un ``tc`` non-dict ou un ``name`` null levaient
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
                    # AUDIT 2026-09-24 (2e passe) — JSON invalide (hors
                    # troncature, traitée en amont) : avant, ``{}`` en silence
                    # et l'outil PARTAIT sur ses défauts ; le modèle ne voyait
                    # jamais que son JSON était cassé et le ré-émettait.
                    tool_args = {}
                    _args_error = (
                        f"arguments JSON invalides pour '{tool_name}' ({_je}) — "
                        "outil NON exécuté ; renvoyer un objet JSON valide "
                        "(guillemets doubles, pas de virgule finale)")
                # F4 — ``arguments`` peut être un JSON VALIDE mais non-objet
                # (`"foo"`, `[1,2]`, `5`, `true`) → json.loads réussit mais
                # ``.items()`` lève AttributeError HORS de tout try → tour tué.
                # Même garde que le chemin legacy (cf. plus bas isinstance dict).
                if not isinstance(tool_args, dict):
                    tool_args = {}

                final_args = {k: v for k, v in tool_args.items() if k not in ("_username", "_chat_id")}
                # v17.20+ (Phase 2b/2c) — identité passée en MCP request meta
                # (out-of-band) plutôt qu'injectée dans les args. Le LLM ne
                # voit plus _username/_chat_id dans le schema des tools, et
                # le client n'a plus à filtrer ces champs avant chaque appel.
                #
                # Le meta est résolu côté server par le helper
                # ``_toolkit.get_username(ctx)`` qui lit
                # ``ctx.request_context.meta["username"]``. Les versions plus
                # anciennes de mcp SDK (< 1.19.0) qui ne supportent pas le
                # kwarg ``meta=`` retombent gracieusement sur le défaut "guest"
                # (cf. wrappers + _mcp_pool fallback).
                #
                call_meta = _build_call_meta(
                    is_local=_is_local_tool(tool_name), username=username,
                    chat_id=chat_id, live_shell=live_shell, call_id=call_id,
                    run_log_tok=_run_log_tok, user_id=user_id)
                prepared.append({
                    "call_id":    call_id,
                    "tool_name":  tool_name,
                    "final_args": final_args,
                    "meta":       call_meta,
                    "args_error": _args_error,
                })
                # PAS de log_metric("tool_call") ici : l'appel est seulement
                # PRÉPARÉ, il n'a pas encore tourné. ``engine/tool_exec`` en
                # écrit un à l'EXÉCUTION, enrichi du ``status``. Les deux
                # coexistaient et le KPI « Appels outils / 24 h », qui compte
                # les lignes sans filtrer, affichait donc jusqu'au double du
                # réel (mesuré : 14 957 lignes avec status contre 12 371 sans).

            # NOTE — garde-fou anti-boucle RETIRÉ (cf. note en tête de module).
            # Chaque appel est désormais TOUJOURS exécuté et le modèle reçoit le
            # vrai résultat ; la terminaison reste bornée par effective/hard cap.

            # Yield + cancel check une fois après la prep (avant exec)
            await asyncio.sleep(0)
            if is_cancelled and is_cancelled():
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

            # ── Exécution : sérielle pour les tools mutants, parallèle sinon ──
            # Stratégie :
            #   - Outils dont le nom commence par un préfixe de
            #     ``LLAMA_TOOL_SERIAL_PREFIXES`` (write_file, edit_file,
            #     sandbox_*, git_*) → sérialisés (effets de bord sur
            #     état partagé : sandbox FS, repo git…).
            #   - Le reste (read_file, search, query, fetch, …) → batché
            #     en parallèle, capé par ``LLAMA_TOOL_PARALLELISM``
            #     (sémaphore).
            #   - L'ordre original est préservé : un tool mutant casse le
            #     batch courant pour respecter les barriers de
            #     synchronisation implicites ("read → write → read"
            #     reste linéaire). Au sein d'un batch parallèle, les
            #     exec sont concurrentes mais le post-traitement (event
            #     tool_result, ajout au working_messages) suit l'ordre
            #     LLM original — critique pour que le LLM matche bien
            #     ses tool_calls avec les tool_results au tour suivant.
            # ── Exécution du lot (série/parallèle) → engine.tool_exec ─────
            # Harness PARTAGÉE avec le canal legacy (retire ~110 lignes de
            # duplication). Ordonnancement : outils mutants sérialisés, outils
            # sûrs batchés en parallèle, ordre LLM préservé. Le post-traitement
            # ordonné (events tool_result, append, vision) suit ci-dessous.
            _batch_partial = {}
            _batch_prepared = prepared
            results_by_idx = await _execute_tool_batch(
                prepared,
                results_out       = _batch_partial,
                execute_single    = _bound_execute_single,
                record_metric     = _record_tool_call_metric_safe,
                is_tool_failure   = _result_is_tool_failure,
                on_event          = on_event,
                username          = username,
                chat_id           = chat_id,
                on_cancel_snapshot= _emit_partial_tool_history_snapshot,
                iteration         = iteration,
                emit_progress_log = True,
                is_cancelled      = is_cancelled,
            )

            # ── Post-traitement séquentiel dans l'ordre original ──────────
            # Émission des tool_result, append au working_messages, vision
            # tracking et injection. Tout cela DOIT être en ordre LLM pour
            # que la conversation reste cohérente côté modèle.
            _cycle_nudge_pending = False     # nudge anti-boucle à injecter APRÈS la boucle
            _pending_vision_msgs: List[Dict[str, Any]] = []   # frames vision différées (C4)
            for idx, p in enumerate(prepared):
                tool_name  = p["tool_name"]
                final_args = p["final_args"]
                call_id    = p["call_id"]
                result_content = results_by_idx.get(idx, json.dumps({"error": "no_result"}))

                # ── Détection succès / échec pour le compteur de productivité ─
                # ``_execute_single_tool_call`` renvoie TOUJOURS une string :
                #   - succès → JSON-encoded résultat normal du tool, soit
                #              ``{"ok": true, ...}`` (envelope ``_ok()`` /
                #              typed Pydantic Union v19+), soit un dict
                #              libre quand le tool a son propre format.
                #   - échec  → soit ``{"error": "<msg>"}`` (chaos error
                #              produit par notre filet de sécurité dans
                #              ``_execute_single_tool_call``), soit
                #              ``{"ok": false, "error": "...", "message":
                #              "...", "fix": "..."}`` (envelope ``_err()``
                #              ou branche Union ErrEnvelope v19+).
                # Si UN AU MOINS des tool_calls de cette itération a réussi,
                # on considère l'itération productive. Itération entièrement
                # ratée = compteur ``effective_iter`` PAS incrémenté →
                # le modèle peut retenter sans manger son budget.
                # ``_hard_iter_cap`` (au-dessus du loop) sert de garde-fou
                # absolu contre les boucles infinies.
                #
                # v19+ — Heuristique alignée avec le frontend
                # (static/js/app-chat.js::_isErrorResult), via le helper
                # partagé. PRODUCTIVITÉ = échec d'OUTIL uniquement : une
                # commande shell exécutée avec exit≠0 (pytest rouge, build
                # cassé) est un résultat EXPLOITABLE — elle ne doit pas
                # bloquer l'avancement du budget d'itérations.
                if not _result_is_tool_failure(result_content):
                    _iteration_had_success = True

                _evt = {
                    "type":   "tool_result",
                    "name":   tool_name,
                    # call_id : appariement fiable step↔résultat côté client
                    # (deux appels PARALLÈLES du même outil — le matching par
                    # nom attribue sinon le 1er résultat au dernier step).
                    "call_id": call_id,
                    "result": result_content[:2000],  # 2000 chars pour le panneau détail UI
                }
                _dk = _desktop_event_extra(tool_name, result_content,
                                           with_elements=str(_chat_key_suffix).startswith("studio_"))
                if _dk:
                    _evt["desktop"] = _dk
                # Path du fichier muté (write/edit/save) : permet au frontend de
                # rattacher la diff card au BON fichier. Sans ça il s'appuyait sur
                # un pendingWrite UNIQUE côté front, écrasé quand le modèle émet
                # PLUSIEURS writes dans le même tour (tous les tool_call partent
                # AVANT les tool_result) → seul le dernier fichier s'affichait.
                # On n'envoie que le chemin, jamais le contenu.
                # Audit éditeur 2026-09-23 (E10/E19) : ``git_write`` → chemin
                # ``repo/path`` ; ``dry_run`` et ``sha256`` final transmis.
                _evt.update(_write_event_extra(tool_name, final_args, result_content))
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
                    if _model_has_vision:
                        _chat_key = f"{username}:{_chat_key_suffix}"
                        _pw_screens_dir = os.environ.get("PW_SCREENS_DIR", "/tmp/pw_screens")
                        _png_path = os.path.join(
                            _pw_screens_dir,
                            f"step_{_ss['session_id']}_{_ss['step']}.png",
                        )
                        if await _guard_cancel(_ensure_local_asset(
                                user_id, _png_path,
                                f"/api/playwright/screenshot/step_{_ss['session_id']}_{_ss['step']}.png")):
                            # (passe 7, H6) Pillow (décodage PNG, LANCZOS,
                            # JPEG) hors boucle.
                            await _guard_cancel(asyncio.to_thread(
                                _track_last_screenshot_for_vision, _chat_key, _png_path))
                # ── Desktop (computer-use) frame → Annotation Studio + vision ──
                await _guard_cancel(_prefetch_desktop_frame(user_id, tool_name, result_content))
                _af_evt = _populate_desktop_frame(
                    _evt, tool_name, final_args, result_content, username,
                    _model_has_vision, f"{username}:{_chat_key_suffix}")
                if _af_evt:
                    _vt = _af_evt.pop("_vision_track", None)    # (passe 7, H6)
                    if _vt:
                        await _guard_cancel(asyncio.to_thread(
                            _track_last_screenshot_for_vision, *_vt))
                    await _guard_cancel(_emit(on_event, _af_evt))
                    # ── Anti-boucle : le modèle rejoue-t-il la même action sans
                    # effet visible ? (signature = outil+args+dHash écran). Ne se
                    # déclenche QUE pour les outils desktop MUTANTS (act/clipboard)
                    # — une ré-observation répétée n'est pas une boucle.
                    if (tool_name or "").startswith("desktop_") and tool_name not in (
                        "desktop_observe", "desktop_inspect", "desktop_read",
                        "desktop_session", "desktop_screenshot",
                    ):
                        _sig = _action_cycle_signature(tool_name, final_args, _af_evt.get("sig") or "")
                        if _detect_action_cycle(_action_cycle_buf, _sig):
                            # Nudge DIFFÉRÉ : on ne peut PAS insérer un message user
                            # ici (entre l'assistant.tool_calls et ses tool_results),
                            # ça orphelinerait les résultats. On l'injecte APRÈS la
                            # boucle, une fois tous les tool_results appariés.
                            _cycle_nudge_pending = True
                            _cycle_detections += 1
                            _cycle_clean_streak = 0   # série de cycles en cours
                            await _guard_cancel(_emit(on_event, {"type": "notice", "level": "warn",
                                                                 "message": "boucle d'action détectée — relance d'observation suggérée"}))
                            logger.warning("[run_chat_multi_mcp] cycle d'action desktop détecté (%s) — nudge différé", _sig)
                # ── Track ownership Playwright sessions (multi-user safety) ──
                await _guard_cancel(_track_pw_session_ownership(tool_name, final_args, result_content, username))
                await _guard_cancel(_emit(on_event, _evt))
                _record_file_mutation(_evt, result_content)

                # ── Stockage du tool result au format OpenAI standard ──
                # role:tool + tool_call_id, content = VUE MODÈLE du résultat :
                # étage unique partagé (desktop compacté, diff d'edit retiré,
                # cap d'émission dérivé du n_ctx). L'event UI complet est déjà
                # parti ci-dessus — l'utilisateur ne perd rien.
                _content_to_send = _prepare_tool_result_for_model(
                    tool_name, result_content, _ctx_size_for_compression,
                    model_id=(model or LLAMA_MODEL or None))

                _tool_msg = {
                    "role":         "tool",
                    "tool_call_id": call_id,
                    "content":      _content_to_send,
                }
                working_messages.append(_tool_msg)
                _run_tool_history.append(_tool_msg)

                # ── INJECTION VISION : screenshot pour modèles multimodaux ──
                # Trigger : pw_page avec action="inspect" + modèle vision-capable
                # + une screenshot récente est dispo. On ajoute un message user
                # contenant l'image pour que le LLM la voie en plus du texte.
                # Les noms d'arguments pw_* sont harmonisés (action|op) : on passe
                # par pw_verb, sinon un pw_page(action="inspect") — la forme
                # désormais documentée — n'injecterait plus rien.
                _chat_key = f"{username}:{_chat_key_suffix}"
                _is_inspect = (
                    tool_name == "pw_page"
                    and isinstance(final_args, dict)
                    and (_pw_verb_of("pw_page", final_args) == "inspect")
                ) or (tool_name == "desktop_observe")
                if _model_has_vision and _is_inspect:
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
                        except Exception:
                            _caption = _caption_default
                        # Éphémère (PAS dans _run_tool_history) : une frame
                        # base64 persistée serait rejouée à chaque tour suivant
                        # (bombe contexte + DB). Le live la voit ; un
                        # « Continuer » ne rejoue que le résultat textuel —
                        # cohérent avec prune_old_vision_frames (2 frames max)
                        # et _clear_last_screenshot_for en fin de run.
                        #
                        # AUDIT 2026-08-22 (C4) — injection DIFFÉRÉE, pour la
                        # même raison que le nudge anti-boucle vingt lignes plus
                        # bas : on est ICI au milieu de l'appariement
                        # ``assistant.tool_calls`` → ``tool``. Appendre un
                        # message ``user`` entre deux résultats d'un lot
                        # parallèle donnait ``assistant(tool_calls=[A,B]) →
                        # tool(A) → user(image) → tool(B)`` : ``tool(B)`` devient
                        # un résultat orphelin, que ``sanitize_message_history``
                        # ne recolle pas (un message ``user`` ne referme pas les
                        # ids ouverts) et que la découpe en tours de la
                        # compaction prend pour un début de tour. Selon le
                        # gabarit du moteur, cela va du 400 en pleine mission à
                        # une compaction qui tranche entre un appel et sa
                        # réponse. On collecte, on appendra après le dernier
                        # ``role:tool`` du lot.
                        _pending_vision_msgs.append({
                            "role": "user",
                            "content": [
                                {"type": "text", "text": _caption},
                                {"type": "image_url", "image_url": {"url": _img_url}},
                            ],
                            # AUDIT 2026-08-23 — marqueur MANQUANT. Ce message
                            # est visible du modèle mais JAMAIS persisté (cf.
                            # commentaire ci-dessus) : c'est la définition même
                            # de ``pruning.is_ephemeral``, et les sept autres
                            # injections mi-tour passent toutes par
                            # ``_ephemeral_msg``. Sans lui, tout le sous-système
                            # contexte le prenait pour un VRAI tour utilisateur :
                            # ``task_anchor_index`` en faisait l'ancre de tâche
                            # (l'énoncé de la mission devenait droppable),
                            # ``_count_turns`` sur-comptait ``covered_turns``,
                            # et ``_drop_leading_turns`` jetait au tour suivant
                            # autant de VRAIS tours en trop — sur une session
                            # desktop de 50 pas, un tour perdu par frame.
                            "_ephemeral": True,
                        })
                        logger.info(
                            "[vision] Screenshot injectée après pw_page('inspect') "
                            "pour %s (~%d KB)",
                            model or LLAMA_MODEL,
                            len(_img_url) // 1024,
                        )

            # Frames de vision (différées) : tous les tool_results du lot sont
            # appariés, on peut maintenant insérer les messages ``user`` sans
            # orpheliner un résultat (cf. C4 au site de collecte).
            if _pending_vision_msgs:
                working_messages.extend(_pending_vision_msgs)
                _pending_vision_msgs = []
                # (passe 7, H9) — élagage EN PLACE des frames plus anciennes
                # que les 2 dernières (même règle que la vue transmise au
                # modèle, cf. pruning.vision_keep) : ``prune_old_vision_frames``
                # ne travaillait que sur une COPIE, les base64 (~150-200 Ko ×
                # N pas) restaient en heap et re-parcourus par _fit_context
                # à chaque itération. Rien à préserver ici : ces messages
                # ``_ephemeral`` ne sont jamais persistés (la frame Studio a
                # son propre stockage par frame_token).
                working_messages[:] = _prune_old_vision_frames(working_messages, keep=2)

            # Nudge anti-boucle (différé) : tous les tool_results sont appariés,
            # on peut maintenant insérer le message user sans casser l'appariement.
            if _cycle_nudge_pending:
                if _cycle_detections >= _CYCLE_HARDSTOP_MAX:
                    # T4-J — le nudge n'a pas suffi : on ARRÊTE les actions (force la
                    # sortie de boucle → la synthèse de sortie renvoie un message clair)
                    # plutôt que de laisser le modèle boucler jusqu'au budget.
                    _cycle_hard_stopped = True
                    _forced_stop = True
                    await _emit(on_event, {"type": "notice", "level": "warn",
                                           "message": "boucle d'action persistante — arrêt automatique des actions"})
                    logger.warning("[run_chat_multi_mcp] hard-stop anti-boucle desktop après %d cycles", _cycle_detections)
                else:
                    working_messages.append(_ephemeral_msg("user", (
                        "WARNING: you just repeated the same action several times with "
                        "no change on screen. Stop replaying it: call desktop_observe "
                        "to re-read the real state, check you are targeting the right "
                        "element (id/auto_id/label), then try a DIFFERENT approach "
                        "(another target, a keyboard shortcut, or report the blocker)."
                    )))

            # Le LLM va synthétiser une réponse finale au prochain tour
            # ── Avancement des compteurs ──────────────────────────────
            # ``hard_iter`` toujours +1 (cap absolu anti-boucle infinie).
            # ``effective_iter`` +1 SEULEMENT si l'itération a été
            # productive (au moins un tool call sans erreur). Une
            # itération 100% ratée ne consomme PAS le budget user.
            hard_iter += 1
            if _iteration_had_success:
                effective_iter += 1
                # Itération PRODUCTIVE ⇒ les séries de récupération liées au
                # CONTENU sont réarmées (P0-4) : le modèle vient de produire un
                # appel exploitable, les erreurs de format antérieures sont de
                # l'histoire ancienne. Le blocage anti-boucle se relâche de la
                # même façon, après une plage franche d'itérations utiles.
                _malformed_retry = 0
                _cycle_clean_streak += 1
                if (_cycle_detections and
                        _cycle_clean_streak >= _CYCLE_DECAY_ITERS):
                    _cycle_detections = 0
                    _cycle_clean_streak = 0
            else:
                logger.info(
                    "[run_chat_multi_mcp] iter %d non productive (tous tool_calls échoués) "
                    "— effective_iter reste à %d/%d (hard %d/%d)",
                    iteration, effective_iter, _effective_iter_budget,
                    hard_iter, _hard_iter_cap,
                )
            _maybe_inject_harness_status()
            continue

        # ── Mode fallback : texte libre contenant du JSON d'appel d'outil ─
        raw_text = _iter_clean  # already stripped of thinking tags above
        legacy_calls = extract_tool_calls(raw_text) if raw_text else None

        # Filtrer les faux positifs : ne garder que les outils effectivement connus
        if legacy_calls:
            known_tools = set(tool_cfg_map.keys()) | set(builtin_handlers.keys())
            # ``n`` vient d'un JSON produit par le modèle : un nom non-hashable
            # (dict/liste) levait TypeError hors de tout try → tour tué.
            _matched_calls = [(n, a) for n, a in legacy_calls
                              if isinstance(n, str) and n in known_tools]
            if not _matched_calls:
                # Le modèle a émis un appel d'outil dont le nom n'existe pas
                # (hallucination, namespace inattendu…). Normalement on laissait
                # tomber silencieusement et raw_text finissait streamé tel quel
                # à l'utilisateur via le flux final — d'où le JSON visible dans
                # la bulle assistant en mode thinking. Si tout raw_text n'était
                # QUE cette tentative d'appel (pas de prose légitime autour),
                # on le purge pour éviter de polluer l'UI.
                if _looks_like_pure_tool_call_text(raw_text):
                    logger.warning(
                        "[run_chat_multi_mcp] Tool call avec nom(s) inconnu(s) %s "
                        "— JSON supprimé du flux final (itération %d)",
                        [n for n, _ in legacy_calls], iteration,
                    )
                    raw_text = ""
                    _iter_clean = ""
                    _iter_content_parts.clear()
                legacy_calls = None
            else:
                legacy_calls = _matched_calls


        # ── Tool call TEXTE tronqué par la fenêtre de contexte ───────────────
        # Même garde que le chemin NATIF plus haut (finish==length + tool_calls)
        # mais pour les appels d'outil en TEXTE : ``extract_tool_calls`` a des
        # regex ancrées sur la fin de chaîne (``…|$``), donc un bloc
        # <tool_call>/<function=> coupé en plein milieu (finish==length) est
        # quand même « extrait » avec des arguments malformés (ex. write_file
        # sans ``path``). L'exécuter déclenche la ValidationError → message
        # assistant aux tool_calls cassés sauvé → 500 en boucle aux tours
        # suivants — exactement ce que la garde native évite. On ne l'exécute
        # donc PAS : on garde le texte et on demande une relance compacte.
        if finish == "length" and legacy_calls:
            await _flush_live_pend()          # (passe 7, H11)
            await _after_truncated_cut("texte")
            continue

        # ── A1 : tool-call détecté mais NON parsable → feedback au modèle ────
        # Le modèle a tenté un appel d'outil (balise <tool_call> ou objet
        # {"name":…}) mais le JSON/balisage était cassé : extract_tool_calls a
        # armé ``_tool_parsing.LAST_PARSE_DIAGNOSTIC``. Sans retour, un modèle
        # 30-129B rejoue la même erreur en silence. On lui réinjecte le format
        # attendu (borné), au lieu de streamer le JSON cassé tel quel à l'UI.
        # ``raw_text`` non vide ⇒ extract_tool_calls vient d'être rappelé en
        # 3116, donc LAST_PARSE_DIAGNOSTIC est frais (pas un résidu du parse du
        # reasoning en amont, qui n'aurait pas re-réinitialisé le diagnostic).
        if not legacy_calls and raw_text and _tool_parsing.LAST_PARSE_DIAGNOSTIC:
            if _malformed_retry < _MALFORMED_RETRY_MAX:
                _malformed_retry += 1
                logger.warning(
                    "[run_chat_multi_mcp] tool-call non parsable (iter %d) — "
                    "feedback de correction au modèle (%d/%d)",
                    iteration, _malformed_retry, _MALFORMED_RETRY_MAX,
                )
                await _flush_live_pend()      # (passe 7, H11)
                if _iter_clean:
                    # Vrai output du modèle → persisté dans le delta ; le
                    # diagnostic de parse ci-dessous reste éphémère.
                    _kept_a1 = {"role": "assistant", "content": _iter_clean}
                    working_messages.append(_kept_a1)
                    _run_tool_history.append(_kept_a1)
                working_messages.append(_ephemeral_msg(
                    "user", _tool_parsing.LAST_PARSE_DIAGNOSTIC))
                hard_iter += 1
                continue
            logger.warning(
                "[run_chat_multi_mcp] tool-call non parsable (iter %d) — cap de "
                "relances atteint (%d), on retombe sur la réponse finale",
                iteration, _MALFORMED_RETRY_MAX,
            )

        # ── A1-bis : tentative d'appel PERDUE hors canal (reasoning) ─────────
        # Cas non couvert par A1 : AUCUNE prose visible (raw_text vide) mais le
        # reasoning du tour porte des traces de markup d'appel — l'appel est
        # parti dans le canal reasoning et la récupération a échoué (dialecte
        # XML dont le serveur a consommé les ouvrantes : il ne reste que des
        # fermantes, rien de parsable). Sans relance, le tour meurt en silence
        # après la phrase d'annonce (« Je vais créer… » puis plus rien — bug
        # « s'arrête net » du 2026-07-12). Même budget borné que A1.
        if (not legacy_calls and not (raw_text or "").strip()
                and _TOOL_MARKUP_TRACE_RE.search(_iter_thinking or "")):
            if _malformed_retry < _MALFORMED_RETRY_MAX:
                _malformed_retry += 1
                logger.warning(
                    "[run_chat_multi_mcp] tentative d'appel perdue dans le "
                    "reasoning (iter %d, aucun tool call reçu) — relance native "
                    "demandée au modèle (%d/%d)",
                    iteration, _malformed_retry, _MALFORMED_RETRY_MAX,
                )
                working_messages.append(_ephemeral_msg(
                    "user", _LOST_TOOL_CALL_NUDGE))
                hard_iter += 1
                continue
            logger.warning(
                "[run_chat_multi_mcp] tentative d'appel perdue dans le reasoning "
                "(iter %d) — cap de relances atteint (%d), réponse finale",
                iteration, _MALFORMED_RETRY_MAX,
            )

        if legacy_calls:
            _malformed_retry = 0     # parse OK sur le canal texte → budget de relance réarmé
            logger.warning(
                f"[run_chat_multi_mcp] Fallback legacy tool-call sur itération {iteration} "
                f"(finish_reason='{finish}')"
            )
            # ── Préparation séquentielle (idem chemin natif) ─────────────
            prepared_legacy: List[Dict[str, Any]] = []
            # AUDIT 2026-09-25 — ``legacy_{iter}_{idx}`` repart de 0 à chaque
            # run : deux tours en canal texte produisaient les MÊMES ids dans
            # l'historique, soit la classe de défaut corrigée pour le canal
            # natif (``_unique_tool_call_ids``) : élagage et résumeur indexés
            # sur le mauvais appel. Un id déjà vu reçoit un suffixe aléatoire.
            _legacy_seen_ids = {
                tc.get("id") for m in working_messages
                if isinstance(m, dict) and m.get("role") == "assistant"
                for tc in (m.get("tool_calls") or []) if isinstance(tc, dict)
            }
            for _idx, (tool_name, tool_args) in enumerate(legacy_calls):
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
                # v17.20+ (Phase 2b/2c) — identité passée en MCP request meta.
                # Voir le commentaire détaillé au site d'injection natif
                # (cherche "Phase 2b/2c" plus haut dans le fichier).
                call_meta = _build_call_meta(
                    is_local=_is_local_tool(tool_name), username=username,
                    chat_id=chat_id, live_shell=live_shell, call_id=call_id,
                    run_log_tok=_run_log_tok, user_id=user_id)
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
            # Sans ça, le legacy stockait en role=system → tool_history vide et
            # _tool_calls_done=0 alors que des outils ont bel et bien tourné.
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
            # Round parsé avec succès ⇒ le contexte n'est pas (plus) saturé,
            # et le chaînage d'auto-reprises repart de zéro (par appel LLM).
            _truncated_streak = 0
            _truncated_ctx_full = False
            _think_resume_count = 0
            _content_resume_count = 0
            _think_resume_tokens = 0

            _legacy_round_msg = {
                "role":       "assistant",
                # Strip du markup <tool_call>/<function=> : les tool_calls
                # structurés ci-dessous portent déjà l'info ; garder le texte
                # brut polluait la tool_history persistée (ré-injectée au
                # Resume → encourage le modèle à récidiver) et fuyait dans
                # la bulle via les sorties partielles. content=None si le
                # texte n'était QUE du markup (convention OpenAI).
                "content":    _strip_tool_call_markup(raw_text) or None,
                "tool_calls": _legacy_tool_calls,
            }
            working_messages.append(_legacy_round_msg)
            _run_tool_history.append(_legacy_round_msg)

            # NOTE — garde-fou anti-boucle RETIRÉ (cf. note en tête de module).

            await asyncio.sleep(0)
            if is_cancelled and is_cancelled():
                logger.info("[run_chat_multi_mcp] Cancellation avant tool_call")
                await _emit_partial_tool_history_snapshot()
                raise asyncio.CancelledError("User cancelled")

            # Émission tool_call dans l'ordre LLM
            for p in prepared_legacy:
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

            # Exec : MÊME harness partagée que le chemin natif (série/parallèle).
            # Le legacy GAGNE au passage les callbacks progress/log MCP qu'il
            # n'avait pas — events tool_progress/tool_log additifs, inchangés.
            _batch_partial = {}
            _batch_prepared = prepared_legacy
            results_legacy = await _execute_tool_batch(
                prepared_legacy,
                results_out       = _batch_partial,
                execute_single    = _bound_execute_single,
                record_metric     = _record_tool_call_metric_safe,
                is_tool_failure   = _result_is_tool_failure,
                on_event          = on_event,
                username          = username,
                chat_id           = chat_id,
                on_cancel_snapshot= _emit_partial_tool_history_snapshot,
                iteration         = iteration,
                emit_progress_log = True,
                is_cancelled      = is_cancelled,
            )

            # Post-traitement dans l'ordre LLM
            _cycle_nudge_pending = False     # nudge anti-boucle différé (cf. chemin natif)
            for idx, p in enumerate(prepared_legacy):
                tool_name  = p["tool_name"]
                final_args = p["final_args"]
                call_id    = p["call_id"]
                res_str = results_legacy.get(idx, json.dumps({"error": "no_result"}))

                # Productivité (cf. chemin natif plus haut) — MÊME règle via
                # le helper partagé : échec d'OUTIL uniquement (une commande
                # exécutée avec exit≠0 reste un résultat exploitable).
                if not _result_is_tool_failure(res_str):
                    _iteration_had_success = True

                _evt = {
                    "type":   "tool_result",
                    "name":   tool_name,
                    "call_id": call_id,   # cf. chemin natif : appariement fiable
                    "result": res_str[:2000],
                }
                _dk = _desktop_event_extra(tool_name, res_str,
                                           with_elements=str(_chat_key_suffix).startswith("studio_"))
                if _dk:
                    _evt["desktop"] = _dk
                # Cf. chemin natif : path du fichier muté pour la diff card
                # multi-fichiers (sans ça, un pendingWrite unique côté front
                # n'affichait que le dernier write d'un tour multi-outils).
                # Audit éditeur 2026-09-23 (E10/E19) : ``git_write`` → chemin
                # ``repo/path`` ; ``dry_run`` et ``sha256`` final transmis.
                _evt.update(_write_event_extra(tool_name, final_args, res_str))
                if _tool_is_internal(tool_name):
                    _evt["internal"] = True
                _ss = _extract_pw_screenshot_url(tool_name, final_args, res_str)
                if _ss:
                    _evt["screenshot_url"] = _ss["url"]
                    _evt["screenshot_step"] = _ss["step"]
                    _evt["screenshot_session"] = _ss["session_id"]
                await _guard_cancel(_prefetch_desktop_frame(user_id, tool_name, res_str))
                _af_evt = _populate_desktop_frame(
                    _evt, tool_name, final_args, res_str, username,
                    _model_has_vision, f"{username}:{_chat_key_suffix}")
                if _af_evt:
                    _vt = _af_evt.pop("_vision_track", None)    # (passe 7, H6)
                    if _vt:
                        await _guard_cancel(asyncio.to_thread(
                            _track_last_screenshot_for_vision, *_vt))
                    await _guard_cancel(_emit(on_event, _af_evt))
                    if (tool_name or "").startswith("desktop_") and tool_name not in (
                        "desktop_observe", "desktop_inspect", "desktop_read",
                        "desktop_session", "desktop_screenshot",
                    ):
                        _sig = _action_cycle_signature(tool_name, final_args, _af_evt.get("sig") or "")
                        if _detect_action_cycle(_action_cycle_buf, _sig):
                            _cycle_nudge_pending = True   # injecté APRÈS la boucle (appariement)
                            _cycle_detections += 1
                            _cycle_clean_streak = 0   # série de cycles en cours
                            await _guard_cancel(_emit(on_event, {"type": "notice", "level": "warn",
                                                                 "message": "boucle d'action détectée — relance d'observation suggérée"}))
                            logger.warning("[run_chat_multi_mcp] cycle d'action desktop (fallback) détecté (%s)", _sig)
                await _guard_cancel(_track_pw_session_ownership(tool_name, final_args, res_str, username))
                await _guard_cancel(_emit(on_event, _evt))
                _record_file_mutation(_evt, res_str)

                # Stockage au format OpenAI standard (role=tool + tool_call_id),
                # apparié à l'assistant.tool_calls synthétique construit plus
                # haut. C'est ce qui aligne le legacy sur le natif : la capture
                # tool_history (filtre role in assistant/tool/user) le retient,
                # et _tool_calls_done (compte les role=tool) le comptabilise —
                # avant, le role=system était silencieusement perdu inter-tours.
                # Le wrapper éditable à froid (result_formatting.fallback_wrapper,
                # placeholders {tool} {result}) reste appliqué au CONTENU. Vide
                # => le contenu est le résultat brut (format OpenAI canonique).
                # Vue MODÈLE unifiée (desktop compacté, diff retiré, cap n_ctx) —
                # avant, ce canal n'appliquait AUCUN cap d'émission (divergence
                # avec le natif).
                _fb_content = _prepare_tool_result_for_model(
                    tool_name, res_str, _ctx_size_for_compression,
                    model_id=(model or LLAMA_MODEL or None))
                with swallow("harness.run_chat_multi_mcp_impl.8"):
                    from llm_core.context_config import CTX as _CTX
                    _fb_tmpl = _CTX.override("result_formatting.fallback_wrapper", "")
                    if _fb_tmpl:
                        _fb_content = _fb_tmpl.format(tool=tool_name, result=_fb_content)
                _fb_tool_msg = {
                    "role":         "tool",
                    "tool_call_id": call_id,
                    "content":      _fb_content,
                }
                working_messages.append(_fb_tool_msg)
                _run_tool_history.append(_fb_tool_msg)

            # Nudge anti-boucle (différé) : tous les tool_results sont appariés.
            if _cycle_nudge_pending:
                if _cycle_detections >= _CYCLE_HARDSTOP_MAX:
                    _cycle_hard_stopped = True       # T4-J — cf. chemin natif
                    _forced_stop = True
                    await _emit(on_event, {"type": "notice", "level": "warn",
                                           "message": "boucle d'action persistante — arrêt automatique des actions"})
                    logger.warning("[run_chat_multi_mcp] hard-stop anti-boucle desktop (fallback) après %d cycles", _cycle_detections)
                else:
                    working_messages.append(_ephemeral_msg("user", (
                        "WARNING: you just repeated the same action several times with "
                        "no change on screen. Stop replaying it: call desktop_observe "
                        "to re-read the real state, check you are targeting the right "
                        "element, then try a DIFFERENT approach."
                    )))

            # Compteurs : même logique que le chemin natif plus haut.
            hard_iter += 1
            if _iteration_had_success:
                effective_iter += 1
                _malformed_retry = 0
                _cycle_clean_streak += 1
                if (_cycle_detections and
                        _cycle_clean_streak >= _CYCLE_DECAY_ITERS):
                    _cycle_detections = 0
                    _cycle_clean_streak = 0
            else:
                logger.info(
                    "[run_chat_multi_mcp] iter %d (fallback) non productive — "
                    "effective_iter reste à %d/%d (hard %d/%d)",
                    iteration, effective_iter, _effective_iter_budget,
                    hard_iter, _hard_iter_cap,
                )
            _maybe_inject_harness_status()
            continue

        # ── Auto-reprise (filet) : coupure du plafond en PLEIN raisonnement ──
        # Aucun tool_call (natif ni legacy), aucune prose visible, finish=length
        # → relancer l'appel avec le raisonnement accumulé (le bloc Réflexion
        # continue de croître côté UI, aucune bannière). Gardes anti-boucle et
        # headroom n_ctx : cf. _think_resume.should_auto_resume. ``partial``
        # (timeout/plantage serveur) bloque la reprise. Prefill TRANSIENT :
        # rien n'entre dans working_messages ni _run_tool_history.
        if (str(finish or "") == "length"
                and not tool_calls and not legacy_calls
                and not _strip_tool_call_markup("".join(_iter_content_parts)).strip()
                and (_iter_thinking or "").strip()
                and not (is_cancelled and is_cancelled())):
            _seg_usage = raw_response.get("usage") or {}
            _resume_ok, _resume_why = should_auto_resume(
                finish="length", content="", thinking=_iter_thinking,
                had_tool_calls=False,
                partial=bool(raw_response.get("partial")),
                resumes_done=_think_resume_count,
                think_tokens_done=(_think_resume_tokens
                                   + int(_seg_usage.get("completion_tokens") or 0)),
                ctx_size=(int(_gauge_ctx_total or 0) or None),
                # Occupation RÉELLE en fin de segment (prompt + généré) = ce que
                # le serveur a en KV. Cf. _think_resume : l'ancien
                # ``last_prompt_tokens + think_tokens_done`` comptait le
                # raisonnement deux fois et bloquait à mi-fenêtre.
                window_tokens=(int(_seg_usage.get("prompt_tokens") or 0)
                               + int(_seg_usage.get("completion_tokens") or 0)),
            )
            if _resume_ok:
                _think_resume_count += 1
                _think_resume_tokens += int(_seg_usage.get("completion_tokens") or 0)
                _pending_think_resume = _iter_thinking
                _pending_resume_native_ok = bool(
                    raw_response.get("reasoning_channel_native"))
                # Une reprise n'est pas un tour productif : hard_iter seul.
                hard_iter += 1
                logger.info(
                    "[run_chat_multi_mcp] raisonnement coupé par le plafond → "
                    "auto-reprise in-run (%s, iter %d, ≈%d tk de thinking cumulés)",
                    _resume_why, iteration, _think_resume_tokens,
                )
                continue
            logger.warning(
                "[run_chat_multi_mcp] coupure en plein raisonnement sans "
                "auto-reprise : %s (iter %d)", _resume_why, iteration,
            )

        # ── Auto-reprise : coupure du plafond en pleine RÉDACTION ────────
        # Symétrique du filet ci-dessus, mais pour la PROSE : finish=length,
        # aucun tool_call, du texte visible déjà produit. C'était jusqu'ici la
        # seule coupure sans reprise automatique — le tour finissait en
        # ``truncated`` + bannière « Continuer », ce qui ne veut rien dire dans
        # une mission autonome de plusieurs heures (personne ne clique).
        # Couvre les DEUX causes : plafond de génération réellement atteint, et
        # partiel de TRANSPORT (flux coupé mi-génération) — dans les deux cas
        # le serveur a du texte cohérent en KV et sait le continuer.
        # Réservé au canal natif ``continue_final_message`` : cf.
        # _think_resume.should_auto_resume_content (un repli par consigne
        # dupliquerait la prose).
        if (str(finish or "") == "length"
                and not tool_calls and not legacy_calls
                and not (is_cancelled and is_cancelled())):
            # Source de vérité : la prose du MESSAGE (``_iter_clean``, déjà
            # débarrassée des balises de raisonnement), avec le buffer streamé
            # en second recours. Ne lire QUE le buffer laisserait passer un
            # fournisseur non-streamant, dont la réponse tronquée n'aurait
            # alors jamais de reprise.
            # ``_raw_content_exact`` porte la frontière EXACTE (espaces de fin
            # compris) ; on ne s'en sert que si la prose strippée en est bien
            # un préfixe — sinon ``_extract_thinking`` a retiré un bloc
            # <think> et seule la version nettoyée est renvoyable.
            _cr_raw = _iter_clean or "".join(_iter_content_parts)
            # AUDIT 2026-08-23 — l'égalité STRICTE n'était vraie qu'à la
            # PREMIÈRE reprise. Dès la deuxième, ``_iter_clean`` a été réécrit
            # en « préfixe accumulé + nouveau segment » alors que
            # ``_raw_content_exact`` ne porte que le NOUVEAU segment : la garde
            # tombait, ``_resume_prefix_join`` n'était pas appelé, et
            # ``_cr_raw`` retombait sur un ``_iter_clean`` déjà ``.strip()``é.
            # L'espace de fin du 2e segment était donc perdu — dans le texte
            # affiché ET dans le message renvoyé au serveur pour
            # ``continue_final_message``, ce qui casse aussi la promesse
            # « token-exacte » et le préfixe KV. ``LLAMA_CONTENT_RESUME_MAX``
            # vaut 4 : les frontières 2, 3 et 4 étaient toutes touchées
            # (« …distinctes.Voici la suite. »).
            # La bonne relation n'est pas l'égalité mais le SUFFIXE : seule la
            # queue blanche du dernier segment est à recoller, quel que soit
            # le préfixe déjà accumulé.
            _exact_strip = (_raw_content_exact or "").strip()
            if (_iter_clean and _raw_content_exact and _exact_strip
                    and _iter_clean.rstrip().endswith(_exact_strip)):
                _cr_raw = _resume_prefix_join(_iter_clean, _raw_content_exact)
            _cr_text = _strip_tool_call_markup(_cr_raw).strip()
            if _cr_text:
                _cr_usage = raw_response.get("usage") or {}
                # Canal natif = cible llama.cpp LOCALE **et** support de
                # ``continue_final_message`` pas déjà infirmé pour ce modèle
                # (le mémo négatif expire — cf. _llm_params, TTL des caches).
                _cr_native_ok = False
                with swallow("harness.content_resume_native_probe"):
                    from llm_core._llm_params import continue_final_support
                    from llm_core._target import current_target as _ct3
                    _cr_native_ok = bool(
                        _ct3().is_llamacpp
                        and continue_final_support(
                            model or LLAMA_MODEL or None) is not False)
                _cr_ok, _cr_why = should_auto_resume_content(
                    finish="length", content=_cr_text, had_tool_calls=False,
                    native_ok=_cr_native_ok,
                    resumes_done=_content_resume_count,
                    ctx_size=(int(_gauge_ctx_total or 0) or None),
                    window_tokens=(int(_cr_usage.get("prompt_tokens") or 0)
                                   + int(_cr_usage.get("completion_tokens") or 0)),
                )
                if _cr_ok:
                    _content_resume_count += 1
                    # La prose brute (AVANT strip du markup) est ce que le
                    # serveur a réellement en KV : c'est elle qu'il faut lui
                    # renvoyer pour qu'il continue token-exacte.
                    _pending_content_resume = _cr_raw
                    # Une reprise n'est pas un tour productif : hard_iter seul.
                    hard_iter += 1
                    logger.info(
                        "[run_chat_multi_mcp] réponse coupée par le plafond → "
                        "auto-reprise de la rédaction (%s, iter %d, %d chars "
                        "déjà écrits)", _cr_why, iteration, len(_cr_text),
                    )
                    # (passe 7, H1) — le client doit tenir EXACTEMENT
                    # ``_cr_text`` avant la reprise : queue retenue (fenêtre /
                    # portail) émise ici, resynchronisation si le nettoyage
                    # diverge du déjà-émis. L'itération de reprise compte ce
                    # préfixe dans ``_live_stream["n"]`` (cf. insert).
                    _cr_rest = _live_stream_rest(
                        _cr_text, "".join(_iter_content_parts), _live_stream["n"])
                    if _cr_rest is None:
                        await _emit(on_event, {"type": "content_replace",
                                               "text": _cr_text})
                    elif _cr_rest:
                        await _emit(on_event, {"type": "content_token",
                                               "text": _cr_rest})
                    await _emit(on_event, {
                        "type": "info",
                        "text": "Réponse tronquée — reprise automatique de la rédaction…",
                    })
                    continue
                logger.warning(
                    "[run_chat_multi_mcp] réponse coupée sans reprise : %s "
                    "(iter %d)", _cr_why, iteration,
                )

        # ── Réponse finale (aucun appel d'outil détecté) ─────────────────
        # Contenu déjà streamé token par token via _on_content_iter
        _streamed_content = "".join(_iter_content_parts)

        # Extraire reasoning_content natif OU <think> du contenu brut
        _final_reasoning = (msg.get("reasoning_content") or "").strip()
        if _final_reasoning:
            final_thinking = _final_reasoning
            final_clean    = raw_text
        else:
            final_thinking, final_clean = (
                _extract_thinking(raw_text, truncated=(str(finish or "") == "length"))
                if raw_text else ("", raw_text))
        # Comparaison NORMALISÉE (blancs) : ``_final_reasoning`` est
        # ``strip()``é alors que ``_all_thinking`` garde le flux brut —
        # l'égalité stricte ratait la correspondance (fournisseur Anthropic :
        # raisonnement streamé ET rendu dans le message) et le raisonnement
        # s'affichait puis se persistait en double.
        _seen_thinking = {_norm_thinking(t) for t in _all_thinking}
        if final_thinking and _norm_thinking(final_thinking) not in _seen_thinking:
            _all_thinking.append(final_thinking)
            _clip_thinking_history(_all_thinking)
            await _emit(on_event, {"type": "thinking_content", "text": final_thinking})

        # AUDIT 2026-08-23 — le buffer STREAMÉ ne court-circuite plus le
        # nettoyage. ``_streamed_content`` est la concaténation BRUTE des
        # tokens de contenu : l'opérateur ``or`` faisait donc gagner la version
        # SALE dès qu'un token avait été streamé, et un dialecte de
        # raisonnement inconnu du splitter (``<|thinking|>…<|/thinking|>``)
        # partait tel quel dans la bulle ET en base — compté deux fois, une
        # fois dans le panneau Réflexion et une fois, balises comprises, dans
        # la réponse. Le splitter connaît désormais ce dialecte (cf.
        # ``_stream_tag_parser``) ; ce filet couvre les builds qui en
        # inventeraient un autre, et les tampons rejoués d'une reprise.
        if _streamed_content:
            _st_think, _st_clean = _extract_thinking(
                _streamed_content, truncated=(str(finish or "") == "length"))
            if _st_think and _norm_thinking(_st_think) not in {
                    _norm_thinking(t) for t in _all_thinking}:
                _all_thinking.append(_st_think)
                _clip_thinking_history(_all_thinking)
            final_clean = _st_clean or final_clean or raw_text or ""
        else:
            final_clean = final_clean or raw_text or ""
        # BUG FIX (markup leak) — un modèle peut émettre du markup d'appel
        # d'outil (Qwen <tool_call>, Llama <function=>) en TEXTE au lieu du
        # canal natif tool_calls. Les appels vers des outils CONNUS ont déjà
        # été ré-exécutés en amont via extract_tool_calls (branche legacy).
        # Ce qui atteint ce point est donc du markup résiduel NON exécutable
        # (outil inconnu, ou markup mêlé à de la prose tombé entre les
        # branches) : on ne doit JAMAIS l'afficher brut dans la bulle. On le
        # nettoie pour l'affichage ET la persistance. cf. _strip_tool_call_markup.
        _pre_strip = final_clean
        final_clean = _strip_tool_call_markup(final_clean)
        if final_clean != _pre_strip:
            # Observabilité : si on a dû nettoyer du markup ICI, c'est que le
            # modèle a free-formé un appel d'outil en texte que la couche
            # native n'a pas capté. Souvent symptôme d'un llama-server lancé
            # SANS --jinja (+ template tool-aware) → le tool-calling natif
            # OpenAI ne s'active pas. cf. note déploiement.
            logger.warning(
                "[run_chat_multi_mcp] markup d'appel d'outil nettoyé du flux "
                "final (iter %d, model=%s) — le modèle a émis un tool call en "
                "TEXTE non capté par le canal natif. Vérifier que llama-server "
                "tourne avec --jinja + un chat template tool-aware.",
                iteration, model or LLAMA_MODEL,
            )
        all_thinking_text = "\n\n".join(_all_thinking)

        # ── Filet « réponse finale piégée dans le thinking » (cf. _thinking_reconcile) ─
        # Même règle que le recovery du chemin classic, mais appliquée ICI
        # (orchestration) plutôt que dans la fonction de stream interne : c'est le seul
        # point où l'on dispose À LA FOIS de la réponse (final_clean) ET du raisonnement
        # live à effacer. Si ce DERNIER tour n'a produit AUCUNE prose visible alors que
        # le modèle a émis du raisonnement (<think> non fermé / reasoning_content-only /
        # </think> scindé), la bulle serait vide et la réponse resterait coincée dans le
        # panneau « thinking » (re-titré « Réponse » côté front). On promeut le
        # raisonnement de CE tour en réponse, on le retire de l'accumulé, et on EFFACE le
        # bloc thinking live (thinking_content="" le remplace) pour ne pas l'afficher en
        # double (panneau + bulle).
        _truncated_in_think = False
        if not (final_clean or "").strip() and (_iter_thinking or "").strip():
            _, _promoted = reconcile_thinking_content(
                _iter_thinking, final_clean, had_tool_calls=False,
                finish=str(finish or ""))
            # Le texte promu peut charrier le markup d'une tentative d'appel
            # partie dans le reasoning (cf. A1-bis) : même nettoyage que le
            # content plus haut. Vidé par le strip = markup pur, PAS une
            # réponse → branche « non promu » (thinking gardé, Continuer armé).
            if _promoted:
                _promoted = _strip_tool_call_markup(_promoted)
            if _promoted:
                final_clean = _promoted
                if _all_thinking and _all_thinking[-1] == _iter_thinking:
                    _all_thinking.pop()
                all_thinking_text = "\n\n".join(_all_thinking)
                await _emit(on_event, {"type": "thinking_content", "text": ""})
                logger.warning(
                    "[run_chat_multi_mcp] réponse finale piégée dans le thinking — promue "
                    "en réponse visible (chars=%d, iter %d).", len(final_clean), iteration)
            else:
                # Coupé par le plafond EN PLEIN raisonnement (finish=length), ou
                # promotion vidée par le strip (markup pur) : PAS une réponse —
                # on n'affiche rien en markdown ; le front garde le bloc thinking
                # et arme « Continuer » (reprise avec le raisonnement en prefill).
                _truncated_in_think = True
                logger.warning(
                    "[run_chat_multi_mcp] raisonnement non promu en réponse "
                    "(finish=%s, %d chars) — thinking gardé, Continuer armé "
                    "(iter %d).", str(finish or ""), len(_iter_thinking or ""),
                    iteration)

        # AUDIT 2026-09-24 (n° 9) — réponse RÉDUITE À RIEN par le nettoyage
        # (balisage d'appel d'outil pur, JSON cassé, relances A1 épuisées) : le
        # retour ``final_clean or raw_text`` persistait alors le balisage BRUT,
        # réaffiché tel quel au rechargement. On ne rend jamais le brut ; une
        # phrase déterministe dit ce qui s'est passé (même principe que le
        # filet final du chemin « limite » : jamais de bulle vide muette). La
        # coupure en plein raisonnement (``_truncated_in_think``) garde sa
        # bulle vide : le bloc Réflexion et « Continuer » la portent.
        if (not (final_clean or "").strip() and not _truncated_in_think
                and (_pre_strip or "").strip()):
            logger.warning(
                "[run_chat_multi_mcp] réponse finale réduite à du balisage "
                "d'appel d'outil non exécutable (iter %d) — message de repli "
                "rendu à la place du brut.", iteration)
            final_clean = _MARKUP_ONLY_REPLY

        # Queue de la réponse finale — l'essentiel est DÉJÀ parti en direct via
        # _on_content_iter (AUDIT 2026-08-31 : l'ancien rejeu intégral à 12 car
        # / 12 ms plafonnait l'affichage à ~1 000 car/s APRÈS une génération
        # muette). Reste à émettre : la fenêtre de retenue, ou tout le texte si
        # le portail anti-markup avait coupé l'émission. Si le nettoyage a
        # modifié la partie déjà émise (strip, extraction d'un dialecte de
        # thinking, reprise de prose), ``content_replace`` resynchronise la
        # bulle — le champ ``assistant`` du 'final' n'y suffit pas : le front
        # ne le préfère au streamé que s'il est au moins aussi LONG.
        if final_clean and on_event:
            try:
                _raw_iter_content = "".join(_iter_content_parts)
                _final_rest = _live_stream_rest(
                    final_clean, _raw_iter_content, _live_stream["n"])
                if _final_rest is None:
                    await _emit(on_event, {"type": "content_replace",
                                           "text": final_clean})
                elif _final_rest:
                    await _emit(on_event, {"type": "content_token",
                                           "text": _final_rest})
            except asyncio.CancelledError:
                # F22 — annulation pendant le re-stream artificiel de la réponse
                # finale : snapshot la tool_history AVANT de propager (comme tous
                # les autres points d'annulation). Sans ça, _partial_tool_history
                # de la route reste vide → le partiel sauvé n'a aucune trace des
                # outils exécutés → un « Continuer » repart aveugle.
                await _emit_partial_tool_history_snapshot()
                raise

        # Récupère les vraies timings de llama.cpp (dernier appel = réponse finale)
        _real_timings = (last_raw or {}).get("timings") or {}
        # Part de RÉFLEXION du tour : mesurée UNE fois, sur le raisonnement
        # cumulé de toutes les itérations (``/tokenize`` en local, estimation au
        # ratio mesuré sinon — cf. _think_tokens). Le raisonnement n'est pas
        # re-soumis d'une itération à l'autre (``working_messages`` ne garde pas
        # ``reasoning_content``) : il ne pèse donc que sur la SORTIE, et
        # ``output = réflexion + réponse`` reste vrai malgré le cumul.
        # Points de suspension de fin de tour sous ``_guard_cancel`` (n° 12) :
        # un Stop ici garde la trace des outils du run dans le partiel.
        _think_tok, _think_est = await _guard_cancel(measure_thinking_tokens(
            all_thinking_text, model_id=model or LLAMA_MODEL,
            usage=({"reasoning_tokens": cumul_reasoning}
                   if cumul_reasoning is not None else None),
            output_tokens=cumul_out))
        meta_for_metrics = {
            "usage":   {"prompt_tokens": cumul_in, "completion_tokens": cumul_out},
            "timings": _real_timings,
            "model":   model or LLAMA_MODEL,
            "thinking": all_thinking_text,
            "thinking_tokens": _think_tok,
            "thinking_tokens_estimated": _think_est,
        }
        metrics = calculate_metrics(meta_for_metrics, time.time() - start_time)
        metrics.update({"input_tokens": cumul_in, "output_tokens": cumul_out})
        # Alias EXPLICITE de ``input_tokens`` (sémantique : tokens SOUMIS —
        # cumul des itérations du tool loop, l'historique re-soumis compte à
        # chaque round = vérité de facturation API). Pour l'OCCUPATION du
        # contexte, voir ``last_prompt_tokens``. Cf. docs/token-counters.md.
        metrics["submitted_input_tokens"] = cumul_in
        # Nombre de TOURS ReAct productifs (un appel LLM = un tour). Exposé sur le
        # chemin normal aussi (le chemin tool_limit le fournit déjà) pour que le
        # moteur d'agents compte des tours, pas des tool calls.
        metrics["iterations"] = effective_iter
        # Troncature de la réponse finale : le modèle a été coupé par le plafond
        # de génération (``finish=="length"``) en pleine prose → on arme
        # ``truncated`` pour que la route offre « Continuer ». Garde sur le
        # contenu VISIBLE : une coupure 100 % thinking (rien dans final_clean)
        # relève de respond-now, pas d'une reprise de réponse.
        metrics["finish_reason"] = finish
        # ``truncated_in_think`` : coupure 100 % thinking — continuable aussi
        # (le front repart avec le raisonnement en prefill), donc truncated.
        metrics["truncated"] = bool(finish == "length"
                                    and ((final_clean or "").strip() or _truncated_in_think))
        metrics["truncated_in_think"] = _truncated_in_think
        # Reprises in-run chaînées sur le DERNIER appel LLM (0 = tour normal).
        metrics["think_resumes"] = _think_resume_count
        # Reprises de RÉDACTION de ce tour : sans ce compteur, une réponse
        # recollée à partir de trois segments est indiscernable d'une réponse
        # écrite d'un trait — et on ne saurait pas si le filet a servi.
        if _content_resume_count:
            metrics["content_resumes"] = _content_resume_count
        # KV cache metric (UX) : `cumul_in` est CUMULÉ sur toutes les
        # itérations du tool loop -- inutilisable pour estimer le KV cache.
        # On expose en plus le prompt_tokens de la DERNIÈRE itération (=
        # taille du dernier prompt envoyé au LLM, qui correspond à ce qui
        # est effectivement chargé dans le KV cache à la fin du tour).
        # Le front utilise ce champ comme fallback quand /api/llm/models
        # ne remonte pas les stats live du KV cache.
        _last_usage = (last_raw or {}).get("usage") or {}
        metrics["last_prompt_tokens"]     = _last_usage.get("prompt_tokens", 0)
        metrics["last_completion_tokens"] = _last_usage.get("completion_tokens", 0)
        if all_thinking_text:
            metrics["thinking"] = all_thinking_text

        # ── Registre d'usage : UNE ligne par tour, ici et nulle part ailleurs ──
        # Avant, ce tour était compté DEUX fois : une fois ici (mode
        # « mcp_native ») et une fois par la route de chat sur les mêmes
        # métriques (mode « mcp ») — le tableau de bord admin sommait les deux.
        # La route ne journalise plus rien : elle se contente d'ouvrir un
        # ``usage_scope``. C'est aussi ce qui rend visibles les routines, les
        # webhooks et les sous-agents, qui passent par ICI mais jamais par la
        # route.
        _real_model = metrics.get("model") or model or LLAMA_MODEL
        record_turn_usage(
            model=_real_model, path="tools",
            input_tokens=cumul_in, output_tokens=cumul_out,
            submitted_tokens=cumul_in, thinking_tokens=_think_tok,
            usage={"cache_read_input_tokens": cumul_cache_read,
                   "cache_creation_input_tokens": cumul_cache_creation},
            duration_ms=int((time.time() - start_time) * 1000),
            iterations=effective_iter,
            # Ce chemin est le tour SAIN : le cap d'itérations sort par un
            # ``return`` antérieur et enregistre son propre statut.
            status="ok",
        )
        _usage_note(recorded=True)
        # Débit et latence restent des séries de perf (pas de la conso) : elles
        # gardent ``metric_events``, mais avec le modèle RÉELLEMENT utilisé —
        # ``LLAMA_MODEL`` est une constante de configuration, elle faussait
        # toute répartition par modèle dès qu'un connecteur externe servait.
        # Les quatre écritures de fin de tour partent dans UNE seule bascule
        # de thread : quatre transactions SQLite d'affilée sur l'event loop,
        # c'est jusqu'à quatre attentes du verrou WAL au moment précis où le
        # client attend son dernier event.
        _mode_tag = "optimized" if _inline_semaphore else "classic"

        def _write_end_of_turn_metrics() -> None:
            log_metric("write_tps",   metrics.get("write_tps", 0), {"model": _real_model})  # noqa: B023 (même itération)
            log_metric("llm_latency", time.time() - start_time,    {"model": _real_model})  # noqa: B023 (même itération)
            # Observabilité scheduling : permet de comparer classic vs optimized
            # sur wait_time et tool_iterations au fil du temps.
            log_metric(
                "llm_scheduling_mode", 1,
                {
                    "model": _real_model,  # noqa: B023 (même itération)
                    "mode": _mode_tag,  # noqa: B023 (même itération)
                    "user": username,
                },
            )
            # Cohérence : même définition de « tour » que ``metrics["iterations"]``
            # renvoyé/affiché (tours PRODUCTIFS = effective_iter). Avant, on loggait
            # ``iteration + 1`` (= hard_iter+1, TOUS les tours) → la métrique
            # d'observabilité et le compteur exposé divergeaient pour la même conv.
            log_metric(
                "llm_tool_iterations", effective_iter,  # noqa: B023 (même itération)
                {"model": _real_model, "mode": _mode_tag},  # noqa: B023 (même itération)
            )

        with swallow("harness.run_chat_multi_mcp_impl.9"):
            await _guard_cancel(asyncio.to_thread(_write_end_of_turn_metrics))

        # Cleanup vision : libère la mémoire de la dernière screenshot après
        # la fin du tour. La prochaine run_chat_multi_mcp repartira de zéro
        # (ou utilisera les screenshots capturées durant ce nouveau tour).
        _clear_last_screenshot_for(f"{username}:{_chat_key_suffix}")

        # ── tool_history sur le chemin NORMAL (réponse finale) ───────────
        # DELTA du run uniquement (_run_tool_history) : les tours précédents
        # sont déjà persistés sur LEURS messages assistant respectifs, la
        # route ré-expanse chaque bulle. L'ancienne capture cumulative
        # (depuis la 1re message agentic) ré-incluait l'historique passé
        # ré-expandé en tête → doublement du contexte à chaque tour.
        _norm_tool_history = _delta_snapshot()
        if _norm_tool_history:
            metrics["tool_history"] = _norm_tool_history
            metrics["tool_history_delta"] = True

        # ── Harnais v4 (M4) : élagage FIN DE TOUR (marques persistées) ───
        # Sélection en tokens exacts des vieilles sorties d'outils ; les clés
        # partent en event INTERNE ``prune_state`` (pattern compression_state)
        # → la route les fusionne dans meta_json["ctx_pruned_keys"] et le
        # rendu du PROCHAIN tour les remplace par le marqueur plein.
        try:
            _new_prune_keys = await _guard_cancel(_select_prune_keys(
                working_messages, ctx_size=_ctx_size_for_compression,
                model_id=(model or LLAMA_MODEL or None),
                already_marked=_run_prune_keys))
            # Union des marques posées PENDANT le run (élagage intra-run) et de
            # la passe finale : les deux doivent être persistées, sinon les
            # sorties effacées de la vue reviendraient PLEINES au tour suivant
            # — le contexte regagné serait reperdu à chaque tour.
            _all_prune_keys = _prune_keys_new + [
                k for k in _new_prune_keys if k not in _run_prune_keys]
            if _all_prune_keys:
                await _guard_cancel(_emit(on_event, {"type": "prune_state",
                                                     "keys": _all_prune_keys}))
        except Exception:
            logger.debug("[run_chat_multi_mcp] select_prune_keys a échoué "
                         "(best-effort)", exc_info=True)

        return final_clean, events, metrics

    # Sortie de boucle sans réponse finale — un des deux caps atteint.
    # Distingue dans les logs lequel a été limitant pour l'observabilité :
    #   - effective_iter_budget : limite UX souhaitée (itérations productives)
    #   - hard_iter_cap         : garde-fou anti-boucle infinie
    # Cause RÉELLE de la sortie — les causes spécifiques d'abord, le budget
    # d'étapes puis le cap dur en dernier recours. Les sorties forcées ne
    # touchent plus ``effective_iter`` : le couple k/budget exposé est vrai.
    if _wallclock_stop:
        _stop_reason = "wallclock"
    elif _ctx_saturated_stop:
        _stop_reason = "ctx_saturated"
    elif _gen_cap_stop:
        _stop_reason = "gen_cap"
    elif _cycle_hard_stopped:
        _stop_reason = "cycle"
    elif _empty_choices_stop:
        _stop_reason = "empty_choices"
    elif effective_iter >= _effective_iter_budget:
        _stop_reason = "steps"
    else:
        _stop_reason = "hard"
    # ``limit_kind`` (contrat existant) : « hard » = garde-fou anti-cascade,
    # « effective » = tout le reste. La cause fine voyage dans ``stop_reason``.
    _limit_kind = "hard" if _stop_reason == "hard" else "effective"
    if _stop_reason == "steps":
        logger.warning(
            "[run_chat_multi_mcp] Limite EFFECTIVE atteinte : %d itérations productives "
            "sur %d total (budget %d, hard cap %d).",
            effective_iter, hard_iter, _effective_iter_budget, _hard_iter_cap,
        )
    elif _stop_reason == "hard":
        logger.warning(
            "[run_chat_multi_mcp] Limite HARD atteinte (boucle improductive) : "
            "%d/%d hard, seulement %d/%d effectives — modèle probablement coincé "
            "sur des appels d'outil échoués en cascade.",
            hard_iter, _hard_iter_cap, effective_iter, _effective_iter_budget,
        )
    else:
        logger.warning(
            "[run_chat_multi_mcp] Sortie forcée (%s) : %d/%d itérations "
            "productives, %d/%d dures — budget d'étapes NON épuisé.",
            _stop_reason, effective_iter, _effective_iter_budget,
            hard_iter, _hard_iter_cap,
        )
    # Compte les tool_calls effectivement exécutés pour le feedback UI.
    # On compte UNIQUEMENT les messages role="tool" (résultats d'outils) :
    # chaque tool exécuté produit exactement un message "tool", donc le
    # compte est 1:1 avec les outils réellement appelés. C'est la même
    # valeur que celle affichée dans toolSteps côté front (qui compte
    # les events ``tool_result``), donc cohérent avec l'UI.
    #
    # Ne PAS additionner aussi les messages assistant.tool_calls : cela
    # produit un double-comptage (un appel = 1 assistant + 1 tool = 2).
    # Bug visible avant : "4 outils utilisés" en haut, "8 outils" dans
    # le banner pour la même conversation.
    # (passe 7, H5) — compté dans ``_run_tool_history`` (le DELTA de ce run),
    # pas dans ``working_messages`` : celui-ci porte l'historique ré-expansé
    # des tours précédents (``_expand_history_for_llm``) et perd les rounds
    # absorbés par une compaction/un aplatissement → compteur faux (persisté,
    # affiché) et porte du tour de synthèse (``> 0``) vraie sans outil ou
    # fausse après compaction.
    _tool_calls_done = sum(
        1
        for m in _run_tool_history
        if m.get("role") == "tool"
    )
    await _emit(on_event, {
        "type":               "tool_limit",
        # ``iterations`` est lu en face de ``max_iterations`` : il porte donc les
        # PRODUCTIVES (même unité que le budget). Le compteur dur reste exposé
        # à part — il monte jusqu'à 2× le budget et n'est pas comparable.
        "iterations":         effective_iter,
        "effective_iterations": effective_iter,
        "hard_iterations":    hard_iter,
        "hard_iterations_max": _hard_iter_cap,
        "max_iterations":     _max_iter,
        "tool_calls_done":    _tool_calls_done,
        "reason":             ("empty_choices" if _empty_choices_stop
                               else "max_iter_reached"),
        "limit_kind":         _limit_kind,
        # Cause fine : steps | hard | wallclock | ctx_saturated | gen_cap |
        # cycle | empty_choices. Le bandeau du front en tire son libellé.
        "stop_reason":        _stop_reason,
    })

    # ── Tour de SYNTHÈSE final (modèle OpenCode « max-steps ») ──────────
    # Avant : le run rendait le dernier partiel SEC (souvent vide — le
    # modèle venait d'appeler un outil). Désormais un DERNIER appel LLM
    # SANS outils force une conclusion texte propre : constat de la limite,
    # résumé du réalisé, tâches restantes. Best-effort : tout échec retombe
    # sur le comportement historique. Sauté si l'arrêt vient de l'anti-boucle
    # desktop (message dédié plus clair) ou sur annulation.
    _wrapup_text = ""
    # Synthèse coupée (plafond de génération ou flux interrompu) : elle ne doit
    # pas être rendue comme complète — cf. ``truncated`` plus bas.
    _wrapup_cut = False
    # Cause réelle de la sortie → consigne de synthèse correspondante. Ordre :
    # les causes SPÉCIFIQUES d'abord, le budget d'étapes en dernier recours.
    _wrapup_kind = _stop_reason if _stop_reason in _WRAPUP_BY_KIND else "steps"
    _wrapup_prompt = _WRAPUP_BY_KIND.get(_wrapup_kind, _MAX_STEPS_WRAPUP)
    # Occupation de contexte à exposer : le DERNIER prompt réellement envoyé
    # (celui de la synthèse s'il a lieu). Sans ce champ, la route retombait sur
    # ``input_tokens`` — le CUMUL de toutes les itérations — et poussait une
    # jauge à 100 % : bannière « contexte presque plein » déverrouillée à
    # chaque limite d'outils, fenêtre à 30 %.
    _limit_last_usage: Dict[str, Any] = dict((last_raw or {}).get("usage") or {})
    if (not _cycle_hard_stopped and _tool_calls_done > 0
            and not (is_cancelled and is_cancelled())):
        try:
            _wrap_stats: Dict[str, Any] = {}
            # AUDIT 2026-09-25 — MÊME ``tools[]`` que les itérations : les
            # gabarits rendent les définitions d'outils EN TÊTE du prompt ;
            # les retirer faisait diverger le préfixe juste après le système —
            # re-préremplissage COMPLET, au moment où le contexte est le plus
            # plein, puis une seconde fois au tour suivant (slot écrasé par un
            # préfixe sans outils). Un appel d'outil émis quand même est
            # ignoré : seul le texte compte (consigne « TEXT ONLY »).
            _wrap_tools_tok = int(_tools_tok_counted[0]) if _tools_tok_counted else 0
            _wrap_msgs = await _fit_context(
                working_messages + [{"role": "user", "content": _wrapup_prompt}],
                ctx_size=_ctx_size_for_compression,
                model_id=(model or LLAMA_MODEL or None),
                thinking_mode=False,
                tools_fixed_tokens=_wrap_tools_tok,
                stats_out=_wrap_stats,
                # AUDIT 2026-09-26 — même plancher que la dernière itération :
                # sans lui, le budget repartait de zéro et retirait jusqu'au
                # filigrane bas — la tête de la vue changeait, et la synthèse
                # re-préremplissait tout le contexte, au plus plein.
                drop_floor=_budget_drop_floor,
                # Le tour de synthèse tourne typiquement CONTRE un contexte
                # plein (c'est souvent ce qui a provoqué la sortie) : sans les
                # marques d'élagage, il repartait avec les sorties d'outils
                # pleines et échouait — laissant une bulle vide.
                prune_keys=_run_prune_keys,
            )

            # Bufferisé SANS émettre : les tokens bruts du tour de synthèse
            # peuvent porter du markup <tool_call>/<function=…>. On ne diffuse
            # qu'APRÈS strip (comme le chemin de réponse finale normal) — sinon
            # du markup brut clignote dans l'UI avant la valeur nettoyée.
            async def _on_wrap_tok(tok: str) -> None:
                return None

            if _inline_semaphore:
                async with _engine_semaphore().acquire_for(model, priority=priority):
                    _wrap_raw = await _llama_chat_with_tools_stream(
                        _wrap_msgs, tools_payload, model_override=model, user_id=username,
                        on_content_token=_on_wrap_tok, is_cancelled=is_cancelled,
                        sampling_override=sampling_override,
                        thinking_mode=False, chat_id=chat_id,
                        # AUDIT 2026-09-26 — outils GARDÉS (préfixe KV) mais
                        # non offerts : la consigne dit « outils désactivés »,
                        # un appel émis quand même vidait la synthèse.
                        tool_choice="none",
                    )
            else:
                _wrap_raw = await _llama_chat_with_tools_stream(
                    _wrap_msgs, tools_payload, model_override=model, user_id=username,
                    on_content_token=_on_wrap_tok, is_cancelled=is_cancelled,
                    sampling_override=sampling_override,
                    thinking_mode=False, chat_id=chat_id,
                    tool_choice="none",
                )
            _wrap_usage = _wrap_raw.get("usage") or {}
            if int(_wrap_usage.get("prompt_tokens") or 0) > 0:
                _limit_last_usage = dict(_wrap_usage)
            cumul_in += _wrap_usage.get("prompt_tokens", 0)
            cumul_out += _wrap_usage.get("completion_tokens", 0)
            # Cache de prompt : cumulé comme à chaque itération de la boucle.
            cumul_cache_read     += int(_wrap_usage.get("cache_read_input_tokens") or 0)
            cumul_cache_creation += int(_wrap_usage.get("cache_creation_input_tokens") or 0)
            _usage_note()
            # Le tour de synthèse consomme comme les autres : sa part de
            # raisonnement déclarée compte aussi, sinon le cumul s'arrête à
            # la dernière itération d'outils.
            _rsn_wrap = _native_reasoning_tokens(_wrap_usage)
            if _rsn_wrap is not None:
                cumul_reasoning = (cumul_reasoning or 0) + _rsn_wrap
            _wrap_choice = (_wrap_raw.get("choices") or [{}])[0] or {}
            _wrap_msg = _wrap_choice.get("message") or {}
            _wrapup_cut = bool(_wrap_raw.get("partial")
                             or str(_wrap_choice.get("finish_reason") or "") == "length")
            _wrap_text_raw = _content_text(_wrap_msg.get("content")).strip()
            # Défense : thinking résiduel + markup d'appel jamais affichés.
            _wt_think, _wrap_text_raw = _extract_thinking(_wrap_text_raw)
            if _wt_think:
                _all_thinking.append(_wt_think)
                _clip_thinking_history(_all_thinking)
            _wrapup_text = _strip_tool_call_markup(_wrap_text_raw).strip()
            # Émettre le texte NETTOYÉ en content_token (même contrat que la
            # réponse finale : _on_wrap_tok a bufferisé sans émettre).
            #
            # AUDIT 2026-08-30 (S9) — c'était une boucle de tranches de 12
            # caractères espacées de 12 ms. Le texte est DÉJÀ complet à cet
            # instant (il faut l'avoir en entier pour en retirer le markup) :
            # ce n'était pas du streaming, mais une animation de streaming, et
            # elle coûtait 1 s par millier de caractères — 3 s pour une synthèse
            # ordinaire, 10 s pour une longue — précisément à la fin d'un run
            # long, quand l'utilisateur attend sa conclusion. Un seul event : le
            # client concatène les ``content_token``, il n'en voit pas la
            # découpe.
            if _wrapup_text and on_event:
                await _emit(on_event, {"type": "content_token",
                                       "text": _wrapup_text})
        except asyncio.CancelledError:
            # (passe 7, H3) — Stop pendant la synthèse (30-60 s contre un
            # contexte plein) : snapshot AVANT de propager, comme les autres
            # points d'annulation — c'est le moment où ``_run_tool_history``
            # est le plus rempli ; sans lui « Continuer » repart aveugle et
            # rejoue les outils mutants.
            await _emit_partial_tool_history_snapshot()
            raise
        except Exception as _wrap_err:
            logger.warning(
                "[run_chat_multi_mcp] tour de synthèse max-steps échoué (%s) — "
                "retour au partiel historique", str(_wrap_err)[:160],
            )
            _wrapup_text = ""

    # Retourner le contenu partiel accumulé (pas un message d'erreur).
    # BUG FIX (markup leak) — même protection que le chemin de réponse
    # finale : le dernier assistant peut porter du markup <tool_call> brut
    # (assistant synthétique du fallback legacy, ou prose mêlée au markup
    # sur le chemin natif) — strip avant affichage/persistance.
    # (2026-09-24, défaut connu n° 1 du parcours prompt) — le repli lisait
    # ``reversed(working_messages)`` : tout l'historique du chat. Un run sans
    # prose, synthèse vide ou en échec, rendait donc la réponse du TOUR
    # PRÉCÉDENT, persistée comme nouvelle réponse (et plantait sur un
    # ``content`` en liste). Même source que la voie d'erreur : le travail de
    # CE run — la prose d'une reprise de rédaction en suspens (déjà affichée,
    # absente du delta) d'abord, puis le dernier assistant du delta.
    _partial = _wrapup_text
    if not _partial:
        _partial = (_pending_content_resume or "").strip() or _last_run_assistant_text()
    if _partial:
        _partial = _strip_tool_call_markup(_partial)
    # T4-J — arrêt anti-boucle : garantir un message clair même si le dernier
    # assistant était vide (il venait d'appeler un outil, sans texte).
    if _cycle_hard_stopped and not (_partial and _partial.strip()):
        _partial = ("Je me suis arrêté : la même action s'est répétée plusieurs fois "
                    "sans que l'écran change (boucle détectée). Vérifie l'état réel de "
                    "la cible (fenêtre active, élément réellement cliquable), puis "
                    "dis-moi comment procéder.")
    # Arrêt « contexte saturé » (streak de tool calls coupés par finish=length) :
    # même garantie — le tour de synthèse a probablement échoué contre le même
    # contexte plein, l'utilisateur doit comprendre quoi faire.
    if _ctx_saturated_stop and not (_partial and _partial.strip()):
        _partial = ("Le contexte du modèle est saturé : mes appels d'outils ont été "
                    "coupés plusieurs fois de suite, je m'arrête pour préserver la "
                    "conversation. Compactez la conversation ou ouvrez un nouveau "
                    "chat pour continuer.")
    # Arrêt « plafond de génération » : la fenêtre n'est PAS pleine, inutile
    # de compacter — il faut des écritures plus courtes ou un max_tokens plus
    # haut. Annoncer un contexte saturé ici envoyait l'utilisateur compacter
    # une conversation qui n'en avait pas besoin.
    if _gen_cap_stop and not (_partial and _partial.strip()):
        _partial = ("Mes appels d'outils ont été coupés plusieurs fois de suite par "
                    "le plafond de génération — le contexte, lui, n'est pas plein. "
                    "Je m'arrête pour ne pas boucler. Relancez avec « Reprendre » "
                    "en demandant des écritures plus courtes (plusieurs appels), "
                    "ou relevez max_tokens dans les réglages de génération.")
    # Arrêt « le moteur renvoie des réponses vides » : rien à voir avec le
    # budget d'itérations, qu'on empruntait faute de chemin propre. Le travail
    # déjà fait est intact — « Continuer » repart de là.
    if _empty_choices_stop and not (_partial and _partial.strip()):
        _partial = ("Le moteur a renvoyé plusieurs réponses vides d'affilée : je "
                    "m'arrête pour ne pas boucler. Le travail déjà effectué est "
                    "conservé — relancez avec « Continuer ».")
    # FILET FINAL — « gracieux » ne doit JAMAIS vouloir dire « bulle vide ».
    # Le tour de synthèse est best-effort : s'il échoue (typiquement contre le
    # même contexte plein qui a provoqué la limite) ET qu'aucun texte assistant
    # n'a été accumulé (le modèle venait d'appeler un outil), on rendait "".
    # L'utilisateur voyait alors une réponse vide sans savoir ce qui s'était
    # passé ni qu'il pouvait reprendre. Message déterministe, sans appel LLM.
    if not (_partial and _partial.strip()):
        _outils = (f" {_tool_calls_done} appel(s) d'outil ont abouti."
                   if _tool_calls_done else "")
        # Le constat doit correspondre à la VRAIE cause : avec le cap dur
        # (cascade d'appels ratés), ce message annonçait « limite atteinte
        # (12/200 tours) » — un chiffre qui contredit sa propre phrase.
        if _wallclock_stop:
            _cause = "J'ai atteint le budget de temps de la tâche"
        elif _limit_kind == "hard":
            _cause = (f"Je me suis arrêté après trop d'appels d'outils en échec "
                      f"d'affilée ({hard_iter} tentatives pour seulement "
                      f"{effective_iter} tour(s) utile(s))")
        else:
            _cause = (f"J'ai atteint la limite d'itérations d'outils "
                      f"({effective_iter}/{_max_iter} tours)")
        _suite = ("Le travail n'est pas terminé : utilisez « Reprendre » pour "
                  "continuer là où je me suis arrêté")
        _suite += ("." if _limit_kind == "hard" else
                   ", ou augmentez le budget d'itérations dans les réglages de "
                   "génération.")
        _partial = f"{_cause} avant de pouvoir rédiger ma réponse.{_outils} {_suite}"
    _limit_metrics = {
        "tool_limit_reached": True,
        "tool_limit_iters":   hard_iter,
        "tool_limit_effective_iters": effective_iter,
        "tool_limit_max":     _max_iter,
        "tool_limit_calls":   _tool_calls_done,
        "tool_limit_kind":    _limit_kind,
        "tool_limit_stop_reason": _stop_reason,
        # True = la réponse retournée est le tour de synthèse final (appel
        # sans outils), pas un partiel brut.
        "max_steps_wrapup":   bool(_wrapup_text),
        # Occupation RÉELLE fin de tour (même contrat que le chemin normal) :
        # c'est ce champ que la jauge de la route lit — jamais le cumul.
        "last_prompt_tokens": int(_limit_last_usage.get("prompt_tokens", 0) or 0),
        "last_completion_tokens": int(_limit_last_usage.get("completion_tokens", 0) or 0),
        "input_tokens":       cumul_in,
        "submitted_input_tokens": cumul_in,   # alias sémantique (tokens soumis)
        "output_tokens":      cumul_out,
    }
    # Même décomposition de la sortie que sur le chemin normal : ce tour est le
    # plus coûteux de tous, la part de réflexion y est la plus intéressante.
    _limit_thinking = "\n\n".join(_all_thinking) if _all_thinking else ""
    _limit_think_tok, _limit_think_est = await _guard_cancel(measure_thinking_tokens(
        _limit_thinking, model_id=model or LLAMA_MODEL,
        usage=({"reasoning_tokens": cumul_reasoning}
               if cumul_reasoning is not None else None),
        output_tokens=cumul_out))
    _limit_metrics["thinking_tokens"] = _limit_think_tok
    _limit_metrics["response_tokens"] = max(0, cumul_out - _limit_think_tok)
    _limit_metrics["thinking_tokens_estimated"] = _limit_think_est
    if _all_thinking:
        _limit_metrics["thinking"] = _limit_thinking
    if _ctx_saturated_stop:
        _limit_metrics["context_saturated"] = True
    if _gen_cap_stop:
        _limit_metrics["gen_cap_stop"] = True
    if _wrapup_text and _wrapup_cut:
        # Synthèse coupée : « Continuer » plutôt qu'une conclusion tronquée
        # présentée comme complète.
        _limit_metrics["truncated"] = True
        _limit_metrics["max_steps_wrapup_truncated"] = True
    if _empty_choices_stop:
        _limit_metrics["empty_choices_stop"] = True
        # Le budget n'est PAS épuisé : la route doit offrir « Continuer »
        # (sans ce flag, l'arrêt se lisait « limite d'itérations atteinte »
        # et la mission s'arrêtait là).
        _limit_metrics["truncated"] = True
    # ── tool_history : DELTA du run (_run_tool_history) ──────────────────
    # Sur un Resume, la route fusionne ce delta au tronc persisté
    # (_merge_continue_tool_history) : plus besoin de capture cumulative —
    # c'était elle qui, ré-expandée à chaque bulle par la route, doublait
    # le contexte à chaque tour. Le compteur _tool_calls_done, lui, reste
    # compté sur working_messages (cumul cohérent avec toolSteps front).
    _tool_history = _delta_snapshot()
    if _tool_history:
        _limit_metrics["tool_history"] = _tool_history
        _limit_metrics["tool_history_delta"] = True
    # Élagage fin de tour aussi sur le chemin « cap atteint » (M4) — le tour
    # est terminé, ses vieilles sorties sont éligibles comme sur le chemin
    # normal. Best-effort.
    try:
        _new_prune_keys = await _guard_cancel(_select_prune_keys(
            working_messages, ctx_size=_ctx_size_for_compression,
            model_id=(model or LLAMA_MODEL or None),
            already_marked=_run_prune_keys))
        _all_prune_keys = _prune_keys_new + [
            k for k in _new_prune_keys if k not in _run_prune_keys]
        if _all_prune_keys:
            await _guard_cancel(_emit(on_event, {"type": "prune_state",
                                                 "keys": _all_prune_keys}))
    except Exception:
        logger.debug("[run_chat_multi_mcp] select_prune_keys (cap) a échoué",
                     exc_info=True)
    _clear_last_screenshot_for(f"{username}:{_chat_key_suffix}")
    # Registre d'usage — ce chemin (cap d'itérations / budget de temps atteint)
    # est le plus COÛTEUX de tous : il ne doit surtout pas être le seul à ne
    # rien enregistrer. Statut ``tool_limit`` pour le distinguer d'un tour sain.
    record_turn_usage(
        model=(model or LLAMA_MODEL), path="tools",
        input_tokens=cumul_in, output_tokens=cumul_out, submitted_tokens=cumul_in,
        thinking_tokens=_limit_think_tok,
        usage={"cache_read_input_tokens": cumul_cache_read,
               "cache_creation_input_tokens": cumul_cache_creation},
        duration_ms=int((time.time() - start_time) * 1000),
        iterations=effective_iter,
        status="tool_limit", error_kind=str(_limit_kind or ""),
    )
    _usage_note(recorded=True)
    return _partial, events, _limit_metrics

# Nom public : le wrapper, habillé de la signature/doc de l'impl.
# ``functools.wraps`` est posé APRÈS coup (l'impl est définie APRÈS le
# wrapper dans le fichier). ``inspect.signature`` et ``inspect.getsource``
# suivent ``__wrapped__`` → l'iso-signature avec v2 et l'inspection de la
# source de la boucle (tests longrun) voient la vraie impl, pas le wrapper.
import functools as _functools  # noqa: E402 — import tardif voulu (dépendance circulaire ou coût)

run_chat_multi_mcp = _functools.wraps(_run_chat_multi_mcp_impl)(_run_chat_multi_mcp_wrapper)


async def run_chat_multi_mcp_v2(
    messages: List[Dict[str, Any]],
    mcp_configs: List[Dict[str, Any]],
    on_event: Optional[Callable] = None,
    username: str = "guest",
    model: Optional[str] = None,
    builtin_tools: Optional[Dict[str, Any]] = None,
    is_cancelled: Optional[Callable[[], bool]] = None,
    chat_id: Optional[str] = None,
    sampling_override: Optional[Dict[str, Any]] = None,
    thinking_mode: bool = False,
    allowed_tool_names: Optional[set] = None,
    memory_enabled: bool = True,
    priority: str = "high",
    compression_prev_state: Optional[Dict[str, Any]] = None,
    deny_tool_names: Optional[set] = None,
    live_shell: bool = False,
    compression_enabled: Optional[bool] = None,
    compaction_threshold: Optional[CompactionThreshold] = None,
    compaction_max_rounds: Optional[int] = None,
    prune_keys: Optional[list] = None,
    read_only: bool = False,
    user_id: Optional[int] = None,
) -> Tuple[str, List[Dict[str, Any]], Dict[str, Any]]:
    """Variante "optimized" : sémaphore LLM acquis INLINE autour de chaque
    appel LLM dans la boucle tool-calling, PAS autour de toute la fonction.

    Le caller NE DOIT PAS wrapper cet appel dans un ``async with
    LLM_SEMAPHORE.acquire_for(...)`` — la fonction gère le sémaphore
    elle-même. Sinon deadlock ou sérialisation inutile.

    :param priority: ``"high"`` (chat user) ou ``"low"`` (pipeline).
        Propagée à chaque acquire interne du sémaphore inline pour
        que les pipelines cèdent leur tour aux chats user.

    Voir run_chat_multi_mcp pour la documentation complète du comportement
    de la boucle tool-calling.
    """
    return await run_chat_multi_mcp(
        messages           = messages,
        mcp_configs        = mcp_configs,
        on_event           = on_event,
        username           = username,
        model              = model,
        builtin_tools      = builtin_tools,
        is_cancelled       = is_cancelled,
        chat_id            = chat_id,
        sampling_override  = sampling_override,
        thinking_mode      = thinking_mode,
        allowed_tool_names = allowed_tool_names,
        memory_enabled     = memory_enabled,
        _inline_semaphore  = True,
        priority           = priority,
        compression_prev_state = compression_prev_state,
        deny_tool_names    = deny_tool_names,
        live_shell         = live_shell,
        compression_enabled = compression_enabled,
        compaction_threshold = compaction_threshold,
        compaction_max_rounds = compaction_max_rounds,
        # DOIT être relayé : la route choisit v2 en mode « optimized », et un
        # paramètre oublié ici ne dégrade pas — il lève un TypeError à l'appel,
        # pour la moitié des déploiements seulement (cf. test d'iso-signature).
        prune_keys         = prune_keys,
        read_only          = read_only,
        user_id            = user_id,
    )

def build_task_builtin_tool(**kwargs):
    """Proxy fin vers :func:`tools.task_tool.build_task_builtin_tool` — garde le
    contrat d'import public ``from llm_core import build_task_builtin_tool``
    stable (façade). Import tardif : ``tools.task_tool`` charge ``run_chat_multi_mcp``
    à l'exécution du handler, jamais à l'import (pas de cycle)."""
    from llm_core.tools.task_tool import build_task_builtin_tool as _build
    return _build(**kwargs)
