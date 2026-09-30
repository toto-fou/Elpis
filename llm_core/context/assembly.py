# SPDX-License-Identifier: MIT
"""llm_core.context.assembly — assemblage BYTE-STABLE du contexte opérationnel.

Construit le message système de TÊTE envoyé au modèle, dans un ordre figé
(invariant prefix-cache KV — gardé par le golden « tête système
byte-identique entre itérations ») :

    socle/identité → mémoire AX (sites connus) → <runtime_context> →
    fragments de capacité (FRAGMENT_*) — le tout FUSIONNÉ en un seul
    ``role:system`` (certains templates Jinja renvoient 400 au 2ᵉ système).

Exception structurelle : les messages système PORTEURS d'un résumé de
compression (``[COMPRESSED_SUMMARY_V1]``) ne sont JAMAIS fusionnés dans le
socle — un porteur avalé par la tête faisait perdre le socle entier à la
recompression suivante. Ils restent des messages séparés, coalescés
seulement à l'envoi (``_coalesce_system_messages``).

Extrait de ``_chat_with_tools`` (Phase 2 du refactor) — comportement
verbatim ; ``assemble_operational_context`` remplace le bloc inline
« 2. Construction du contexte de conversation » de la boucle.
"""
from __future__ import annotations

import logging
from typing import Dict, Iterable, List

from llm_core.context.pruning import sanitize_message_history
from shared_infra import config as _bk_config

logger = logging.getLogger("uvicorn.error")


def _network_status_line(username: str) -> str:
    """Real network state of the user's sandbox, resolved at assembly time.

    The prompt used to hardcode "Network: blocked by default" — a DYNAMIC
    property frozen in static prose (audit 2026-07-26): agents reported the
    network as their #1 blocker while the admin had opened it. Best-effort:
    resolution failure falls back to a neutral, non-asserting phrase. The
    value is stable within a session (same profile) → prefix-cache safe.
    """
    try:
        from shared_infra.accounts.users import get_user, get_user_settings
        from shared_infra.sandbox.executors import load_admin_config, resolve_network_profile_id
        row = get_user(username)
        pid = "isolated"
        if row:
            pid = resolve_network_profile_id(get_user_settings(int(row["id"])) or {})
        prof = load_admin_config().get_profile(pid)
        if getattr(prof, "mode", "none") == "none":
            return (f"  • Network: NONE this session (profile '{pid}') — every "
                    "outbound connection fails (expected, not a bug).")
        return (f"  • Network: OPEN via profile '{pid}' (mode: {prof.mode}) — "
                "a refused connection means that destination is outside the "
                "profile, not a tool bug.")
    except Exception:
        return ("  • Network: depends on the sandbox profile; if blocked, "
                "outbound connections fail with a connection error "
                "(expected, not a bug).")


def build_runtime_sandbox_context(username: str) -> str:
    """Build a short system message describing the LLM's sandbox model.

    Why this exists: without this, when the LLM asks fs_tools / shell to
    write somewhere, it often picks absolute system paths it remembers
    from training (`/tmp/foo`, `/home/x/y`, `/var/log/`). These all fail
    with "outside sandbox" and the LLM tends to retry blindly with
    similar paths — burning iterations on a futile loop.

    Since the Docker migration the host sandbox path is NOT a useful piece
    of information for the LLM (it lives on the FastAPI host, not in the
    container). We give it the only fact that actually matters: all paths
    are relative, anchored at the sandbox root, never absolute.

    Empty string returned if username is missing — caller should not
    inject in that case.
    """
    if not username:
        return ""

    # Préfixe sandbox éditable à froid (context.sandbox_prefix). Vide => bloc
    # <runtime_context> historique ci-dessous → identique tant que non surchargé.
    # Placeholders supportés : {username} et {root} (= username).
    try:
        from llm_core.context_config import CTX as _CTX
        _ov = _CTX.override("context.sandbox_prefix", "")
        if _ov:
            try:
                return _ov.format(username=username, root=username)
            except Exception:
                return _ov
    except Exception:
        pass

    _net_line = _network_status_line(username)
    return f"""<runtime_context>
You operate inside an isolated per-user sandbox (user id: {username}).

PATHS — all relative to your sandbox root:

  • fs_tools (read_file, write_file, edit_file, list_files, manage_files,
    code): `path` is relative.
  • shell tool (execute_shell): `cwd` and `save_stdout` are relative.

  ✓ path="src/main.py"   path="."   path="tmp/scratch.txt"
  ✗ path="/tmp/foo"   path="/home/x"   path="../up"   path="~/file"

  On "outside sandbox" or "not_found": the path was wrong — rethink it as a
  relative path; do not retry the same absolute path with a small variation.

GIT — a repo is ANY directory in your sandbox containing `.git/`:

  `repo` = its RELATIVE path from the sandbox root (e.g. "myproject",
  "code/web-app"); `path` in git_write / git_query is relative to the REPO
  root. New repos (git_action init/clone, git_clone) are created at the
  sandbox root — there is NO dedicated subfolder.
  Discover existing repos with git_query(action="repos").

SHELL — commands run inside your Docker container:

  • The rootfs is READ-ONLY; only your sandbox (mounted at /work) persists.
    The tools translate relative paths to /work for you. /tmp is writable
    but ephemeral.
{_net_line}
  • execute_shell goes through `bash -c` (all shell metacharacters are
    interpreted). For stdout larger than ~20 KB, use save_stdout=<path>.
</runtime_context>"""


def build_active_tools_manifest(allowed_tool_names: Iterable[str]) -> str:
    """One explicit, compact list of every tool callable THIS session.

    Audit 2026-07-26 : le socle disait « si des outils sont actifs, des guides
    apparaissent » et les fragments parlaient au conditionnel (« If a task tool
    is available… ») — sans liste, l'agent a conclu à tort « pas d'outil git ».
    Ce manifeste lève l'ambiguïté : un outil absent d'ici n'existe pas ce
    tour. Trié (byte-stable pour le prefix-cache) ; groupé par catégorie.
    """
    names = sorted({str(n).strip() for n in (allowed_tool_names or ()) if str(n).strip()})
    if not names:
        return ""
    try:
        from llm_core._mcp_categories import categorize as _categorize
    except Exception:
        def _categorize(_n):  # dégradé : liste à plat
            return "tools"
    by_cat: Dict[str, List[str]] = {}
    for n in names:
        by_cat.setdefault(_categorize(n) or "other", []).append(n)
    lines = [
        "# Active tools (this session)",
        "",
        "The tools callable this session are EXACTLY the ones below — a tool "
        "absent from this list does not exist right now (do not assume or "
        "invent one, and do not conclude a capability is missing without "
        "checking here first).",
        "",
    ]
    for cat in sorted(by_cat):
        lines.append(f"- {cat}: " + ", ".join(by_cat[cat]))
    return "\n".join(lines)


def inject_ax_memory_into_messages(working_messages: List[Dict],
                                   owner: str = "") -> None:
    """Inject prior UI knowledge (AX memory) into the system prompt.

    Rendu FULL (hierarchie DOM complete) si c'est un chat neuf, FOCUSED
    (position + ancetres + siblings + descendants) si on reprend un chat.
    Best-effort : toute exception est avalée pour ne jamais casser un chat.

    Mutates ``working_messages`` in place. Returns None.
    """
    try:
        from shared_infra.memory.ax import (
            detect_session_url as _ax_session_url,
            detect_sites_from_text as _ax_detect,
            normalize_url as _ax_normalize,
            render_site_contextual as _ax_render,
        )
        _recent_user_text = "\n".join(
            (m.get("content") or "") if isinstance(m.get("content"), str) else ""
            for m in working_messages[-6:]
            if m.get("role") == "user"
        )
        _sites = _ax_detect(_recent_user_text)

        # Detection de la page courante via session Playwright active
        _session_url = _ax_session_url(working_messages, owner=owner)
        _current_site = None
        _current_path = None
        if _session_url:
            _current_site, _current_path = _ax_normalize(_session_url)
            if _current_site and _current_site not in _sites:
                _sites.insert(0, _current_site)

        # Mode d'injection : full (cartographie complete) si chat neuf,
        # focused (juste autour de la position) si on reprend avec tool_history
        _has_tool_history = any(
            m.get("role") in ("tool", "system")
            and isinstance(m.get("content"), str)
            and ("tool_call" in (m.get("content") or "")
                 or "session_id" in (m.get("content") or ""))
            for m in working_messages
        )
        _ax_iter = 1 if _has_tool_history else 0

        _ax_blocks: List[str] = []
        for _s in _sites:
            _path = _current_path if _s == _current_site else None
            _block = _ax_render(_s, current_path=_path, iteration=_ax_iter,
                                owner=owner)
            if _block:
                _ax_blocks.append(_block)

        if _ax_blocks:
            # Source de l'en-tête : system_prompts/AX_MEMORY_HEADER.md
            # (centralisé via backend.config). Fichier vide/absent →
            # on skippe l'injection AX complète pour ce tour. Non
            # fatal : AX memory est une optimisation, pas une feature
            # critique — les sites inconnus passent par le flow normal.
            _ax_header = (getattr(_bk_config, "SYSTEM_PROMPT_AX_MEMORY_HEADER", "") or "").strip()
            if not _ax_header:
                logger.debug("[ax] header prompt vide/absent → skip injection")
                raise RuntimeError("__ax_skip__")  # sort du try/except wrapper
            _ax_text = (
                "\n\n" + _ax_header + "\n\n"
                + "\n\n".join(_ax_blocks)
            )
            for _i, _m in enumerate(working_messages):
                if _m.get("role") == "system":
                    working_messages[_i] = {
                        "role": "system",
                        "content": (_m.get("content") or "") + _ax_text,
                    }
                    break
            _focus_info = (
                f" (focus on {_current_path})"
                if _current_path else ""
            )
            logger.info(
                "[ax] injected %d site(s) into system prompt "
                "(%d chars, mode=%s)%s: %s",
                len(_ax_blocks), len(_ax_text),
                ("focused" if _ax_iter else "full"),
                _focus_info, ", ".join(_sites),
            )
    except RuntimeError as _rt:
        # Cas spécial : skip demandé par le header vide. Log déjà émis.
        if str(_rt) != "__ax_skip__":
            logger.debug("[ax] inject failed (non-fatal): %s", _rt)
    except Exception as _ax_err:
        logger.debug("[ax] inject failed (non-fatal): %s", _ax_err)


def fold_operational_block(working_messages: List[Dict], op_text: str) -> None:
    """Fusionne le bloc opérationnel (runtime_context + fragments de capacité) dans
    le message système de TÊTE, au lieu d'insérer un 2ᵉ message ``role:system``.

    Certains templates Jinja n'acceptent qu'un seul message système (au bon
    endroit) — la garantie DURE est portée par ``_coalesce_system_messages``,
    appliqué à l'ENVOI sur une copie transitoire (cf. _llama_chat_with_tools_stream).
    Le fold, lui, structure l'état persistant de la boucle : un socle unique et
    stable en tête.

    EXCEPTION — les messages système porteurs d'un résumé de compression
    (``[COMPRESSED_SUMMARY_V1]``, cf. conversation_compressor.is_summary_carrier)
    ne sont JAMAIS fusionnés dans le socle : un porteur avalé par la tête faisait
    perdre le socle ENTIER à la recompression suivante (le filtre du compresseur
    retirait le message fusionné complet — socle compris — en reconstruisant
    ``[systems] + [nouveau résumé] + bridge + recent``). Ils restent des messages
    système séparés, coalescés seulement à l'envoi.

    - S'il existe des messages système NON-porteurs en tête, on les coalesce en
      un seul et on ajoute ``op_text`` à la fin de son contenu.
    - S'il n'y a QUE des porteurs (ou aucun système), ``op_text`` devient le
      socle, inséré en position 0 (identité/opérationnel avant le résumé).

    L'objet dict est REMPLACÉ (jamais muté en place) : ``working_messages`` partage ses
    références avec l'historique persistant (``messages``) — muter ``content``
    corromprait le message système stocké / la ``tool_history``. Mutation in-place de la
    LISTE ``working_messages`` (comme les autres helpers de ce module), rien renvoyé.
    """
    op_text = (op_text or "").strip()
    if not op_text:
        return
    _sep = "\n\n---\n\n"
    try:
        from llm_core.conversation_compressor import is_summary_carrier as _is_carrier
    except Exception:                       # fail-open : comportement historique
        def _is_carrier(_m):                # type: ignore[misc]
            return False
    # Indices des messages système CONSÉCUTIFS en tête, hors porteurs de résumé.
    _lead: List[int] = []
    for _i, _m in enumerate(working_messages):
        if _m.get("role") == "system":
            if not _is_carrier(_m):
                _lead.append(_i)
        else:
            break
    if not _lead:
        working_messages.insert(0, {"role": "system", "content": op_text})
        return
    _parts: List[str] = []
    for _i in _lead:
        _c = working_messages[_i].get("content")
        if isinstance(_c, str) and _c.strip():
            _parts.append(_c.strip())
        elif isinstance(_c, list):
            # F27 — content MULTIMODAL (liste) : EXTRAIRE le texte au lieu de
            # le jeter/écraser. Sans ça, un message système de tête à contenu
            # liste était supprimé (_lead[1:]) ou son texte remplacé par op_text
            # (_lead[0]) → perte d'instructions système, alors que
            # _coalesce_system_messages (à l'envoi) le préserve. Asymétrie
            # corrigée : on aligne le fold sur le coalesce.
            _txt = " ".join(
                b.get("text", "") for b in _c
                if isinstance(b, dict) and isinstance(b.get("text"), str)
            ).strip()
            if _txt:
                _parts.append(_txt)
    _parts.append(op_text)
    # Remplace le 1er système non-porteur par le fusionné ; retire les autres.
    working_messages[_lead[0]] = {**working_messages[_lead[0]], "content": _sep.join(_parts)}
    for _i in reversed(_lead[1:]):
        del working_messages[_i]


def assemble_operational_context(
    messages: List[Dict],
    *,
    allowed_tool_names: Iterable[str],
    username: str,
) -> List[Dict]:
    """Assemble les ``working_messages`` du tour — comportement verbatim de
    l'ancien bloc inline de ``run_chat_multi_mcp`` :

    1. socle par défaut (``SYSTEM_PROMPT_DEFAULT``) seulement si AUCUN message
       system n'est présent ;
    2. capacités actives dérivées des outils exposés (registre de catégories
       MCP ; « rag » synthétisé pour les builtins ``rag_*``) ;
    3. ``<runtime_context>`` seulement si une catégorie fichier/shell/git est
       active ET pas déjà présent (fail-open) ;
    4. sanitisation structurelle de l'historique (500 Jinja sinon) ;
    5. injection AX memory (sites connus) sur le système de tête ;
    6. fold du bloc opérationnel (runtime_context + FRAGMENT_*) dans
       l'UNIQUE système de tête — porteurs de résumé exclus.
    """
    has_system = any(m.get("role") == "system" for m in messages)
    working: List[Dict] = []
    _default_sys = (getattr(_bk_config, "SYSTEM_PROMPT_DEFAULT", "") or "").strip()
    if not has_system and _default_sys:
        working.append({"role": "system", "content": _default_sys})

    # Capacités actives du tour : pilotent l'injection conditionnelle du
    # runtime_context ET des fragments. Best-effort.
    try:
        from llm_core._mcp_categories import categorize as _categorize
        _active_categories = {_categorize(n) for n in allowed_tool_names}
        _active_categories.discard("other")
        # Les outils RAG sont des BUILTINS (pas de catégorie MCP) → categorize()
        # renvoie "other". On synthétise la capacité « rag » pour que son fragment
        # de contenu (FRAGMENT_RAG) s'injecte, sans toucher au registre MCP.
        if any(str(n).startswith("rag_") for n in allowed_tool_names):
            _active_categories.add("rag")
    except Exception:
        _active_categories = set()

    # runtime_context (sandbox fichiers/shell/git) : pertinent seulement si une
    # catégorie fichier/shell/git est active (sinon bruit/trompeur en session
    # browser/desktop/RAG). fail-open en cas d'erreur. Pas de ré-injection si
    # l'orchestrateur a déjà posé un <runtime_context> dans messages.
    try:
        from llm_core._system_prompts import capability_wants_runtime_context as _wants_rc
        _want_runtime_ctx = _wants_rc(_active_categories)
    except Exception:
        _want_runtime_ctx = True
    _already_has_ctx = any(
        "<runtime_context>" in (m.get("content") or "")
        for m in messages if m.get("role") == "system"
    )
    _runtime_ctx = (
        build_runtime_sandbox_context(username)
        if (_want_runtime_ctx and not _already_has_ctx) else ""
    )

    working.extend(messages)

    # Sanitisation : neutralise un historique mal formé AVANT l'envoi —
    # sans ça le rendu du chat template plante en 500 dès l'itération 0.
    working = sanitize_message_history(working)

    # AX memory : prior UI knowledge pour les sites connus (mutation in-place,
    # best-effort).
    inject_ax_memory_into_messages(working, owner=username or "")

    # Contexte opérationnel : fusionné dans l'unique système de tête.
    try:
        from llm_core._system_prompts import build_capability_block as _bcb
        _cap_block = _bcb(_active_categories)
    except Exception:
        _cap_block = None
    # Manifeste des outils actifs — injecté dès qu'au moins un outil est exposé
    # (même sans catégorie d'action) : c'est lui qui lève l'ambiguïté des
    # formulations conditionnelles des fragments. Best-effort.
    try:
        _manifest = build_active_tools_manifest(allowed_tool_names)
    except Exception:
        _manifest = ""
    _op_parts = [p for p in (_manifest, _runtime_ctx, _cap_block) if p]
    if _op_parts:
        fold_operational_block(working, "\n\n---\n\n".join(_op_parts))
    return working
