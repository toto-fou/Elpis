# SPDX-License-Identifier: MIT
"""
tools/_exec_bridge.py — MCP tools → user sandbox container.

Role
----
Routes shell / script execution from the synchronous MCP tools layer to the
async ``UserSandbox.exec()`` running in the user's per-account Docker
container. Handles host-path → container-path translation for ``cwd`` and
script paths (host ``<SANDBOX_DIR>/<user>/x`` → container ``/work/x``).

Why no shell_policy here ?
--------------------------
For SHELL execution the container is the security boundary. Commands run
through ``docker exec`` as ``exec_user`` (10001:10001), with NET_ADMIN
dropped from their bounding set (``_privdrop``). The container itself has
Docker's default capabilities, ``--network none`` (or the per-profile
network), memory/CPU/PIDs limits and no ``--read-only``: see
``UserSandbox._build_run_args``, the only up-to-date reference.

The model is "permissive inside": sudo NOPASSWD lets the LLM become root IN
its container (``no-new-privileges:false`` on purpose). There is NO user
namespace remapping, so container root is UID 0 for files on the /work bind
mount. What keeps the host safe is the mount/network/pid namespaces, the
cgroup limits, Docker's default seccomp + AppArmor profiles and the absence
of docker.sock. The shell allowlist that v2 used was a belt over the
parachute and was removed in v3 (see shell_tools v3 module docstring).

SCOPE — what actually goes through this bridge
----------------------------------------------
This bridge routes ``execute_shell`` (and the human terminal/editor write
routes have their OWN container path via ``routes/_sandbox_exec.py``). It is
NOT a universal funnel: today ``fs_tools`` (read/write/edit/list/grep) and
``git_tools`` still run HOST-DIRECT (Python ``os``/``shutil`` + host
``subprocess``), as the app's account — they do NOT come through here and
are NOT inside the container. What confines them is ``resolve_under``
(``sandbox/paths.py`` : resolve + relative_to, symlinks leaving the root
refused, ``O_NOFOLLOW`` writes) and, for git, the filtered environment and
the refused config keys of ``sandbox/git_env.py``. So the kernel boundary above applies
to shell, not to every tool. Unifying those host-direct paths behind the
container is a tracked migration; until then this docstring must not be read
as "all tools are sandboxed at the kernel level".

Folder-mode legacy
------------------
The ``folder`` sandbox mode (subprocess on the host) was retired during the
Docker migration. ``execute_shell`` always goes through the container now;
(``_NoToolsExecutorConfigured`` et la couche heartbeat v17 ont été retirées
le 2026-08-23 : zéro consommateur dans le dépôt. Voir la note plus bas.)
Historique — le texte suivant décrivait leur raison d'être :
``_NoToolsExecutorConfigured`` was kept as a public symbol for backward
compatibility but is **never raised** by this bridge. If the daemon is
unreachable, the underlying ``ExecError`` is propagated and the calling tool
returns a user-facing error — there is no host fallback for shell (it would
bypass isolation).

Progress / log reporting (v18, Tier 1 MCP best practices)
---------------------------------------------------------
The v17 bespoke ``_HEARTBEAT_HOOK`` subsystem was removed. It had no
in-tree consumer (``set_heartbeat_hook`` was never called) and required
operator wiring at startup. The MCP-native equivalent is the FastMCP
Context — every tool that wraps the bridge already has a ``ctx: Context``
in scope, and the bridge functions now accept an optional ``ctx`` keyword.

When supplied :
  * ``ctx.info(...)`` lines about the exec (start / end / executor tag)
    flow back to the client as standard MCP ``notifications/message``;
  * ``ctx.report_progress(0/1, 1, message)`` markers fire at the start
    and end of the exec so the client renders a progress indicator.

Tools that don't pass ``ctx`` (legacy callers, tests) still work — the
``ctx_progress`` / ``ctx_log`` paths are simple no-ops. This is purely
additive; no caller is required to change.

For *intra-exec* progress (a 5-second ticker during a long compile, the
v17 use case), we DON'T re-introduce a thread. The MCP client is
responsible for the periodic UI update based on the start-progress event;
the bridge stays single-threaded and side-effect-free.
"""
from __future__ import annotations

import codecs
import logging
import time
from pathlib import Path
from typing import Any, Optional

from shared_infra.accounts.users import get_user as _get_user, get_user_settings
from shared_infra.sandbox.executors import (
    ExecError,
    get_user_sandbox,
)
from shared_infra.security.audit import audit_code_exec

logger = logging.getLogger("uvicorn.error")


# AUDIT 2026-08-23 — couche de compatibilité v17 SUPPRIMÉE :
# ``_NoToolsExecutorConfigured``, ``set_heartbeat_hook`` et les trois
# ``_HEARTBEAT_*``. Zéro occurrence dans TOUT le dépôt hors leurs propres
# définitions — code applicatif ET tests, et aucun ``import *`` qui aurait
# pu les consommer indirectement. Elles étaient conservées « pour que des
# appelants externes ne cassent pas à l'import » : ces appelants n'existent
# pas. ``set_heartbeat_hook`` émettait même un avertissement de dépréciation
# qui ne pouvait jamais être déclenché.
# ⚠ ``register_server_loop`` et ``repair_work_perms``, du même bloc, sont
#   RÉELLEMENT utilisés (local_mcp_server, fs_tools) : ils restent.


# ─── FastMCP context helpers (best-effort, never raise) ──────────────────
#
# The tools that call this bridge have a ``ctx: fastmcp.Context`` in scope.
# Passing it down here lets us emit native MCP notifications (log + progress)
# back to the client without each tool having to do it explicitly.
#
# Both helpers are no-ops when ``ctx`` is None (legacy callers, unit tests
# without a context). They swallow exceptions so a broken transport — say
# the client disconnects mid-exec — never breaks the exec itself.
#
# Note on sync/async: ctx.info() and ctx.report_progress() are coroutines
# in fastmcp 3.x. We're inside a synchronous bridge function (called from
# an MCP tool that itself runs sync inside FastMCP's thread executor).
# We schedule the coroutine on the running event loop via
# asyncio.run_coroutine_threadsafe — fire-and-forget; we don't block on
# the result. If there's no loop (extremely defensive), we silently skip.

def _ctx_info(ctx: Any, message: str) -> None:
    if ctx is None:
        return
    try:
        coro = ctx.info(message)
    except Exception:
        return
    _schedule_ctx_coro(coro)


def _ctx_warning(ctx: Any, message: str) -> None:
    if ctx is None:
        return
    try:
        coro = ctx.warning(message)
    except Exception:
        return
    _schedule_ctx_coro(coro)


def _ctx_progress(ctx: Any, progress: float, total: Optional[float],
                  message: Optional[str] = None) -> None:
    if ctx is None:
        return
    try:
        coro = ctx.report_progress(progress, total, message)
    except Exception:
        return
    _schedule_ctx_coro(coro)


# ── Loop du serveur MCP (live shell) ─────────────────────────────────────
# (2026-09-11, P3) remontés dans ``llm_core.tools._toolkit`` (partagés avec
# les familles sans sandbox — navigateur/desktop — pour le battement) ; les
# noms historiques restent des alias : le middleware ``ServerLoopCapture`` du
# serveur et les tests appellent ``register_server_loop`` / ``_schedule_ctx_coro``.
from llm_core.tools._toolkit import (  # noqa: E402
    LIVE_KIND_SHELL,
    LIVE_LOGGER_SHELL,
    Heartbeat,
    live_notify as _live_notify,
    register_server_loop,
    schedule_ctx_coro as _schedule_ctx_coro,
)

# ─── Path helpers ────────────────────────────────────────────────────────

def _path_to_container(host_path: Path, sandbox_root: Path) -> str:
    """``/home/elpis/sandbox/alice/foo/bar.sh`` → ``/work/foo/bar.sh``

    Handles the edge case where ``host_path`` IS the sandbox root: returns
    ``/work`` (not ``/work/.``) so docker exec --workdir gets a clean value.
    """
    try:
        rel = host_path.resolve().relative_to(sandbox_root.resolve())
    except ValueError:
        raise ExecError(
            f"path outside sandbox: {host_path} not under {sandbox_root}"
        )
    rel_str = rel.as_posix()
    if rel_str in ("", "."):
        return "/work"
    return f"/work/{rel_str}"


# ─── Sync → async wrapper ────────────────────────────────────────────────

import asyncio
import threading

# ── Boucle asyncio PERSISTANTE dédiée au bridge (MAJ-12) ─────────────────
# Avant, ``_run_async`` créait une NOUVELLE event loop à chaque appel
# (``asyncio.run`` dans un ThreadPoolExecutor jetable). Conséquences :
#   • coût (création/destruction de loop + threadpool à chaque exec) ;
#   • les objets asyncio réutilisés entre appels (ex. les ``asyncio.Lock`` de
#     cycle de vie du sandbox, le transport subprocess) se retrouvaient
#     « attached to a different loop » → RuntimeError.
# On maintient donc UNE seule loop tournant dans un thread daemon, et chaque
# appel y poste sa coroutine via ``run_coroutine_threadsafe``. Tous les exec
# du process MCP partagent ainsi la même loop → cohérent et sans churn.
_bridge_loop: "Optional[asyncio.AbstractEventLoop]" = None
_bridge_loop_lock = threading.Lock()


def _get_bridge_loop() -> "asyncio.AbstractEventLoop":
    global _bridge_loop
    if _bridge_loop is not None and _bridge_loop.is_running():
        return _bridge_loop
    with _bridge_loop_lock:
        if _bridge_loop is not None and _bridge_loop.is_running():
            return _bridge_loop
        loop = asyncio.new_event_loop()
        t = threading.Thread(target=loop.run_forever,
                             name="exec-bridge-loop", daemon=True)
        t.start()
        _bridge_loop = loop
        return loop


def _run_async(coro):
    """The MCP tools are sync; our executors are async.

    Poste la coroutine sur la loop persistante du bridge et bloque le thread
    appelant (un worker de tool FastMCP) jusqu'au résultat — comportement
    attendu pour un outil synchrone.
    """
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is not None:
        # Appelé depuis une loop déjà active. (passe 8, B7) — la délégation à
        # un thread ne change RIEN au blocage : ``.result()`` ci-dessous
        # bloque quand même le thread de la loop appelante jusqu'au résultat
        # (la docstring prétendait le contraire). Chemin inatteignable
        # aujourd'hui (les outils sont sync, appelés depuis des threads) ;
        # s'il l'était, la loop appelante gèlerait — on le DIT au lieu de
        # le taire. Le bridge tourne sur SA loop, donc pas d'interblocage
        # tant que ``running`` n'est pas la loop du bridge.
        if running is _get_bridge_loop():
            raise RuntimeError("_run_async appelé depuis la loop du bridge : interblocage")
        logger.warning("_run_async appelé depuis une loop active : la loop appelante "
                       "est BLOQUÉE le temps de l'exec (chemin non prévu)")
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(
                lambda: asyncio.run_coroutine_threadsafe(
                    coro, _get_bridge_loop()).result()
            ).result()
    return asyncio.run_coroutine_threadsafe(coro, _get_bridge_loop()).result()


# ─── Live shell : batcher de sortie incrémentale ─────────────────────────
#
# Transporte la sortie d'un exec en cours vers le client MCP sous forme de
# notifications ``ctx.info`` (logger_name="shell_output") portant un payload
# JSON sentinelle ``{"__shell_output__": {...}}``. Le client (tool_exec.py)
# les traduit en événements NDJSON ``shell_output`` pour le chat.
#
# Contraintes :
#   * ``add()`` est appelé sur la loop du BRIDGE (non-bloquant) ;
#   * les coroutines ctx.* sont planifiées sur la loop du SERVEUR via
#     ``_schedule_ctx_coro`` (jamais sur celle du bridge) ;
#   * flush : dès 2 Ko en attente OU 150 ms après le premier chunk non-flushé ;
#   * cap dur : 64 Ko streamés en live par exec (le résultat final reste la
#     source complète — troncature 20 Ko + spill inchangés) ;
#   * ``close()`` (thread du tool, APRÈS l'exec) fait le flush final, émet
#     l'événement ``done`` et attend (borné) que toutes les notifications
#     soient écrites sur la session AVANT que le tool ne retourne — sinon le
#     wrapper client efface son log_callback et les derniers chunks seraient
#     perdus.

_SHELL_STREAM_FLUSH_CHARS = 2048
_SHELL_STREAM_FLUSH_DELAY_S = 0.150
_SHELL_STREAM_LIVE_CAP = 65_536
_SHELL_STREAM_CLOSE_TIMEOUT_S = 2.0


class _ShellStreamBatcher:
    def __init__(self, ctx: Any) -> None:
        self._ctx = ctx
        # AUDIT 2026-08-22 (C2) — identifiant de l'appel d'outil, lu dans le
        # meta de la requête MCP. Il voyage dans CHAQUE notification : côté
        # client, une session partagée porte jusqu'à huit appels de front et
        # rien d'autre ne permet de savoir à quel terminal une ligne appartient
        # (le protocole ne corrèle pas une notification de log à sa requête).
        try:
            from llm_core.tools._toolkit import _read_meta_field
            self._call_id = _read_meta_field(ctx, "call_id")
            # Jeton de ROUTAGE (audit 2026-08-23) : unique au run, il
            # sert au wrapper MCP à rendre la sortie au bon appel même
            # quand deux comptes portent le même ``call_id``.
            self._log_token = _read_meta_field(ctx, "log_token")
        except Exception:                                       # noqa: BLE001
            self._call_id = None
            self._log_token = None
        self._pending: list[tuple[str, str]] = []   # [(stream, text)]
        self._pending_chars = 0
        self._sent_chars = 0
        self._seq = 0
        self._live_truncated = False
        self._timer: Any = None
        self._futures: list[Any] = []
        self._decoders = {
            "stdout": codecs.getincrementaldecoder("utf-8")("replace"),
            "stderr": codecs.getincrementaldecoder("utf-8")("replace"),
        }

    # ── appelé sur la loop du bridge ─────────────────────────────────────
    def add(self, stream: str, data: bytes) -> None:
        if self._sent_chars >= _SHELL_STREAM_LIVE_CAP:
            self._live_truncated = True
            return
        try:
            text = self._decoders[stream].decode(data)
        except Exception:
            return
        if not text:
            return
        room = _SHELL_STREAM_LIVE_CAP - self._sent_chars - self._pending_chars
        if room <= 0:
            self._live_truncated = True
            return
        if len(text) > room:
            text = text[:room]
            self._live_truncated = True
        if self._pending and self._pending[-1][0] == stream:
            self._pending[-1] = (stream, self._pending[-1][1] + text)
        else:
            self._pending.append((stream, text))
        self._pending_chars += len(text)
        if self._pending_chars >= _SHELL_STREAM_FLUSH_CHARS:
            self._flush()
        elif self._timer is None:
            try:
                loop = asyncio.get_running_loop()
                self._timer = loop.call_later(
                    _SHELL_STREAM_FLUSH_DELAY_S, self._flush)
            except RuntimeError:
                self._flush()

    def _flush(self) -> None:
        if self._timer is not None:
            try:
                self._timer.cancel()
            except Exception:
                pass
            self._timer = None
        if not self._pending:
            return
        batch, self._pending, self._pending_chars = self._pending, [], 0
        for stream, text in batch:
            self._seq += 1
            self._sent_chars += len(text)
            self._notify({"stream": stream, "chunk": text,
                          "seq": self._seq, "done": False})

    def _notify(self, payload: dict[str, Any]) -> None:
        if self._call_id and "call_id" not in payload:
            payload = {**payload, "call_id": self._call_id}
        if self._log_token and "log_token" not in payload:
            payload = {**payload, "log_token": self._log_token}
        # (2026-09-11, P3) notification MCP STRUCTURÉE (``extra``) — plus de
        # JSON dans une chaîne ; repli sentinelle pour un fastmcp ancien.
        coro = _live_notify(self._ctx, LIVE_KIND_SHELL, payload,
                            logger_name=LIVE_LOGGER_SHELL,
                            legacy_key="__shell_output__")
        if coro is None:
            return
        fut = _schedule_ctx_coro(coro)
        if fut is not None:
            self._futures.append(fut)

    # ── appelé depuis le thread du tool, APRÈS le retour de l'exec ───────
    def close(self, *, returncode: int, duration_ms: int,
              timed_out: bool) -> None:
        # Le flush final + l'événement ``done`` s'exécutent SUR la loop du
        # bridge : c'est là que vivent ``_pending`` et le timer — un flush
        # direct depuis ce thread ferait la course avec un ``call_later`` en
        # vol. Repli direct si la loop est indisponible (tests, teardown).
        def _finalize() -> None:
            self._flush()
            self._seq += 1
            self._notify({"done": True, "seq": self._seq,
                          "returncode": returncode,
                          "duration_ms": duration_ms,
                          "timed_out": bool(timed_out),
                          "bytes_total": self._sent_chars,
                          "live_truncated": self._live_truncated})

        # (passe 8, B6) — sur TIMEOUT de ``result()``, la coroutine postée
        # reste en file et VA s'exécuter : rejouer ``_finalize`` d'ici aussi
        # produisait deux ``done`` (seq/bytes_total divergents, terminal live
        # fermé deux fois). Le repli direct n'a de sens que si la loop est
        # indisponible (aucune coroutine postée).
        _posted = False
        try:
            loop = _get_bridge_loop()

            async def _run() -> None:
                _finalize()

            _fut = asyncio.run_coroutine_threadsafe(_run(), loop)
            _posted = True
            _fut.result(timeout=_SHELL_STREAM_CLOSE_TIMEOUT_S)
        except Exception:
            if not _posted:
                _finalize()
        deadline = time.monotonic() + _SHELL_STREAM_CLOSE_TIMEOUT_S
        for fut in list(self._futures):
            budget = deadline - time.monotonic()
            if budget <= 0:
                break
            try:
                fut.result(timeout=budget)
            except Exception:
                pass
        self._futures.clear()


# ─── Public API ─────────────────────────────────────────────────────────

def repair_work_perms(*, username: str, sandbox_root: Path, rel_path: str = "") -> bool:
    """Répare les permissions croisées conteneur→hôte sur un sous-arbre de /work.

    Un chemin créé DANS le conteneur avec des modes restrictifs (``git clone``
    tapé dans un terminal antérieur à son wrapper umask 0000, ``tar -x`` qui
    préserve des modes 0644/0755 de l'archive…) appartient à l'UID 10001 : le
    process hôte (outils fs write/edit) n'est ni owner ni groupe → il ne peut
    ni écrire ni chmod. La réparation passe donc par ``chmod -R o+rwX`` en
    root DANS le conteneur, scopée au premier segment du chemin relatif (le
    dépôt cloné), pas à tout /work. Best-effort : False si le conteneur est
    indisponible — l'appelant laisse alors remonter l'erreur d'origine.
    """
    seg = (rel_path or "").strip("/").split("/")[0]
    if not seg or seg in (".", ".."):
        return False
    target = f"/work/{seg}"
    try:
        row = _get_user(username)
        user_id = int(row["id"]) if row else 0
    except Exception:
        user_id = 0
    try:
        sb = get_user_sandbox(user_id, username, sandbox_root)

        async def _do() -> bool:
            st = await sb.ensure_running()
            if not getattr(st, "running", False):
                return False
            rc, _out, _err = await sb._cli.call(
                "exec", "-u", "0:0", sb.container_name,
                "chmod", "-R", "o+rwX", "--", target, timeout=60)
            return rc == 0

        ok = bool(_run_async(_do()))
        logger.info("[bridge] repair_work_perms user=%r target=%s → %s",
                    username, target, "ok" if ok else "KO")
        return ok
    except Exception as e:
        logger.warning("[bridge] repair_work_perms KO (user=%r, %s): %s",
                       username, target, e)
        return False


def run_shell_via_executor(
    *,
    tokens: list[str],
    workdir_host: Path,
    sandbox_root: Path,
    env_extra: dict[str, str],
    timeout_s: int,
    max_output: int,
    stdin_bytes: bytes | None,
    user_id: int,
    username: str,
    audit_kind: str = "tools.shell",
    ctx: Any = None,
    save_stdout_host: "Optional[Path]" = None,
    auto_spill_host: "Optional[Path]" = None,
    spill_over_chars: "Optional[int]" = None,
    stream_live: bool = False,
) -> dict[str, Any]:
    """Execute a shell command in the user's container.

    Always goes through Docker. If the daemon is unreachable, ``ExecError``
    is propagated to the caller, which surfaces it as a user-facing error.

    v18: ``ctx`` (FastMCP Context) is optional. When supplied, the bridge
    emits MCP-native log and progress notifications back to the client.
    Legacy callers that don't pass ``ctx`` keep working — the helpers are
    safe no-ops.

    ``save_stdout_host`` : chemin HOST où écrire le stdout COMPLET (octets
    bruts, AVANT la troncature ``max_output`` de la réponse). L'écriture se
    fait ici parce que le caller ne voit que le stdout déjà tronqué — c'est
    le fix du bug « save_stdout tronqué à 20 KB ». Best-effort : un échec
    d'écriture n'invalide pas l'exec (champ ``save_error`` posé).
    """
    from shared_infra.sandbox.executors import resolve_network_profile_id
    profile_id = resolve_network_profile_id(get_user_settings(user_id) or {})
    sb = get_user_sandbox(user_id, username, sandbox_root,
                          network_profile_id=profile_id)
    cmd_preview = " ".join(tokens[:4])
    logger.info(
        "[bridge] execute_shell user=%r user_id=%d tokens=%s → docker exec %s (profile=%s)",
        username, user_id, tokens[:3] if tokens else [],
        sb.container_name, sb.network_profile_id or "isolated",
    )
    _ctx_info(ctx, f"shell → {sb.container_name}: {cmd_preview}")
    _ctx_progress(ctx, 0.0, 1.0, f"running: {cmd_preview}")

    workdir_in_container = _path_to_container(workdir_host, sandbox_root)

    # PATH must include the user-site bins (/work/.python-user/bin and
    # /work/.local/bin) — that's where `pip install --user` and
    # `npm install -g` land per the Dockerfile's PYTHONUSERBASE / npm-global
    # setup. Without them, every binary the LLM installs at runtime comes
    # back as "command not found" and the next tool-call sequence wastes a
    # whole turn re-discovering its own state.
    env = {
        "PATH": "/work/.python-user/bin:/work/.local/bin:/work/.npm-global/bin"
                ":/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME": "/work",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "TZ": "UTC",
        # Match the image's defaults so a `pip install` done inside the
        # container drops the user-site as expected (some bridges set
        # PIP_USER but we just rely on PYTHONUSERBASE).
        "PYTHONUSERBASE": "/work/.python-user",
        "PIP_DISABLE_PIP_VERSION_CHECK": "1",
        "PIP_BREAK_SYSTEM_PACKAGES": "1",
        **{k: str(v) for k, v in (env_extra or {}).items() if v is not None},
    }

    audit_code_exec(
        user_id=user_id, username=username,
        kind=audit_kind, code=" ".join(tokens),
        pipeline_id=None, run_id=f"tool-{username}",
        node_id=audit_kind, executor=sb.container_name,
        extra={"cmd_argv": tokens},
    )

    # ── Live shell (opt-in par appel via le meta MCP) ────────────────────
    # ``stream_live`` branche un batcher qui relaie la sortie incrémentale
    # vers le client en notifications MCP pendant l'exec. L'ExecResult et
    # tout l'aval (troncature, spill, save_stdout) restent identiques.
    batcher = _ShellStreamBatcher(ctx) if (stream_live and ctx is not None) else None

    # AUDIT 2026-09-26 — sortie COMPLÈTE pour ``save_stdout`` et le débord :
    # la capture de l'exécuteur est bornée (tête + marqueur + queue au-delà
    # de sa limite) ; l'écrire telle quelle corrompait silencieusement un
    # ``tar c .`` ou un gros CSV sauvés, promis « FULL stdout ». Les paquets
    # bruts sont recopiés au fil de l'eau (mémoire jusqu'à 4 Mo, disque
    # temporaire HÔTE au-delà) puis écrits dans le bac à sable à la fin.
    import tempfile as _tempfile
    _spool_out = _spool_err = None
    if save_stdout_host is not None or auto_spill_host is not None:
        _spool_out = _tempfile.SpooledTemporaryFile(max_size=4 << 20)  # noqa: SIM115 (relu puis fermé plus bas)
        if save_stdout_host is None:
            _spool_err = _tempfile.SpooledTemporaryFile(max_size=4 << 20)  # noqa: SIM115 (relu puis fermé plus bas)

    def _on_chunk(stream: str, data: bytes) -> None:
        if batcher is not None:
            batcher.add(stream, data)
        if stream == "stdout" and _spool_out is not None:
            _spool_out.write(data)
        elif stream == "stderr" and _spool_err is not None:
            _spool_err.write(data)

    t_start = time.monotonic()
    # (2026-09-11, P3) battement pendant une exécution silencieuse : le flux
    # HTTP d'un ``tools/call`` long reste vivant à travers relais et proxy TLS.
    heartbeat = Heartbeat(ctx).start() if ctx is not None else None
    try:
        result = _run_async(sb.exec(
            cmd=tokens,
            workdir_in_container=workdir_in_container,
            env=env,
            stdin_bytes=stdin_bytes,
            timeout_s=timeout_s,
            on_chunk=(_on_chunk if (batcher is not None or _spool_out is not None)
                      else None),
        ))
    except BaseException:
        for _sp in (_spool_out, _spool_err):
            if _sp is not None:
                _sp.close()
        if heartbeat is not None:
            heartbeat.stop()
        if batcher is not None:
            elapsed_ms = int((time.monotonic() - t_start) * 1000)
            batcher.close(returncode=-1, duration_ms=elapsed_ms,
                          timed_out=False)
        raise
    if heartbeat is not None:
        heartbeat.stop()
    elapsed_ms = int((time.monotonic() - t_start) * 1000)
    if batcher is not None:
        batcher.close(returncode=result.returncode,
                      duration_ms=elapsed_ms,
                      timed_out=result.timed_out)
    _ctx_progress(ctx, 1.0, 1.0, f"done in {elapsed_ms} ms (rc={result.returncode})")
    if result.returncode != 0:
        _ctx_warning(ctx, f"shell exited rc={result.returncode} after {elapsed_ms} ms")

    formatted = _format_result(result, tokens, max_output, workdir_in_container)
    try:
        _spilled = _save_outputs(formatted, result, sandbox_root, save_stdout_host,
                                 auto_spill_host, spill_over_chars,
                                 _spool_out, _spool_err)
    finally:
        for _sp in (_spool_out, _spool_err):
            if _sp is not None:
                _sp.close()
    return formatted


def _save_outputs(formatted, result, sandbox_root, save_stdout_host,
                  auto_spill_host, spill_over_chars, spool_out, spool_err) -> bool:
    """``save_stdout`` / débord automatique depuis les copies COMPLÈTES
    (``spool_*``) ; repli sur la capture de l'exécuteur sans elles."""
    # Un exécuteur qui n'appelle pas ``on_chunk`` laisse la copie VIDE alors
    # que la capture ne l'est pas : on retombe alors sur la capture.
    def _got(sp, captured: bytes):
        if sp is None:
            return None
        sp.seek(0, 2)
        return sp if (sp.tell() > 0 or not captured) else None

    spool_out = _got(spool_out, result.stdout)
    spool_err = _got(spool_err, result.stderr) if spool_out is not None else None

    def _size(sp, fallback: bytes) -> int:
        if sp is None:
            return len(fallback)
        sp.seek(0, 2)
        return sp.tell()

    if save_stdout_host is not None:
        try:
            if spool_out is not None:
                _n = _size(spool_out, result.stdout)
                spool_out.seek(0)
                _write_output_file(sandbox_root, save_stdout_host, spool_out)
            else:
                _n = len(result.stdout)
                _write_output_file(sandbox_root, save_stdout_host, result.stdout)
            formatted["saved_bytes"] = _n
        except Exception as _save_err:
            formatted["save_error"] = str(_save_err)[:200]
        return True
    _n_out = _size(spool_out, result.stdout)
    _n_err = _size(spool_err, result.stderr)
    if auto_spill_host is not None and (
        formatted.get("truncated")
        or (spill_over_chars is not None
            and (_n_out + _n_err) > spill_over_chars)
    ):
        # Débord AUTOMATIQUE (modèle OpenCode) : la sortie COMPLÈTE (stdout +
        # stderr) est écrite dans le sandbox sans que le modèle ait pensé à
        # save_stdout. Best-effort. On déborde non seulement quand la réponse
        # est tronquée par ``max_output`` (20 KB), mais AUSSI dès qu'elle
        # dépasse ``spill_over_chars`` (= plancher d'émission) : sinon une
        # sortie dans la bande (plancher, 20 KB] serait coupée plus tard à
        # l'émission SANS ``saved_to`` — la promesse de la description mentirait.
        try:
            if spool_out is not None:
                import shutil as _shutil
                spool_out.seek(0, 2)
                if _n_err:
                    spool_out.write(b"\n--- STDERR ---\n")
                    if spool_err is not None:
                        spool_err.seek(0)
                        _shutil.copyfileobj(spool_err, spool_out)
                    else:
                        spool_out.write(result.stderr)
                _n_full = spool_out.tell()
                spool_out.seek(0)
                _write_output_file(sandbox_root, auto_spill_host, spool_out)
            else:
                _full = result.stdout
                if result.stderr:
                    _full += b"\n--- STDERR ---\n" + result.stderr
                _n_full = len(_full)
                _write_output_file(sandbox_root, auto_spill_host, _full)
            formatted["saved_bytes"] = _n_full
            formatted["auto_saved"] = True
        except Exception as _save_err:
            formatted["save_error"] = str(_save_err)[:200]
        return True
    return False


def _write_output_file(sandbox_root: Path, host_path: Path, data: bytes) -> None:
    """Écrit la sortie sauvegardée (``save_stdout`` / débord automatique)
    SANS suivre de lien symbolique.

    AUDIT 2026-09-25 — le chemin était validé AVANT la commande, puis écrit
    APRÈS par un ``write_bytes`` ordinaire. Entre les deux, la commande
    elle-même tourne sur le même ``/work`` : un lien posé à la place du
    fichier (ou d'un dossier du chemin) redirigeait l'écriture de l'hôte hors
    du bac à sable. On réécrit donc par ``write_beneath`` (ouverture composant
    par composant, O_NOFOLLOW) — le chemin RELATIF validé fait foi."""
    from shared_infra.sandbox.paths import write_beneath
    root = Path(sandbox_root).resolve()
    rel = Path(host_path).relative_to(root).as_posix()
    try:
        from shared_infra.sandbox.policy import use_agent
        _single_uid = use_agent("fs.write")
    except Exception:                                           # noqa: BLE001
        _single_uid = False
    # Même politique que fs_tools : lisible/réécrivable par l'UID du conteneur
    # (sauf écritures déléguées à l'agent, un seul UID).
    write_beneath(root, rel, data, default_mode=(0o644 if _single_uid else 0o666),
                  dir_mode=(None if _single_uid else 0o777))


# ─── Result formatting ──────────────────────────────────────────────────

def _format_result(result, cmd, max_output, cwd_str):
    stdout = result.stdout.decode("utf-8", errors="replace")
    stderr = result.stderr.decode("utf-8", errors="replace")

    # Troncature en gardant la QUEUE : pour une commande shell, la fin
    # (statut, dernière erreur, résumé de build/test) est la partie décisive —
    # l'ancienne coupe tête-seule jetait exactement ça (modèle OpenCode :
    # tail-keep). Le débord automatique (run_shell_via_executor) sauve le
    # complet quand truncated=True.
    truncated = False
    if len(stdout) > max_output:
        _cut = len(stdout) - max_output
        stdout = f"...[TRUNCATED — {_cut} chars omitted, showing the tail]\n" + stdout[-max_output:]
        truncated = True
    if len(stderr) > max_output:
        _cut = len(stderr) - max_output
        stderr = f"...[TRUNCATED — {_cut} chars omitted, showing the tail]\n" + stderr[-max_output:]
        truncated = True

    # Champs PETITS d'abord, stdout/stderr EN DERNIER : le cap d'émission de
    # la boucle coupe la fin de la chaîne JSON — les métadonnées (ok,
    # returncode, saved_to…) doivent survivre à la coupe.
    if result.timed_out:
        return {
            "ok": False, "error": "timeout",
            "hint": f"Exceeded {result.duration_s:.1f}s.",
            "cmd": cmd, "cwd": cwd_str,
            "returncode": 124,
            "duration_ms": int(result.duration_s * 1000),
            "executor": result.executor_tag,
            "stdout": stdout, "stderr": stderr,
        }

    return {
        "ok": result.returncode == 0,
        "cmd": cmd, "cwd": cwd_str,
        "returncode": result.returncode,
        "truncated": truncated,
        "duration_ms": int(result.duration_s * 1000),
        "executor": result.executor_tag,
        "stdout": stdout, "stderr": stderr,
    }


__all__ = [
    "register_server_loop",
    "run_shell_via_executor",
]
