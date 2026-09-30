# SPDX-License-Identifier: MIT
# tools/shell_tools.py
"""
Shell execution tool — one ring to rule them all.

Architecture
------------
``execute_shell`` runs inside the user's per-user Docker container
(``UserSandbox``), isolated at the kernel level :

    docker exec -u 10001:10001  --network=none (or a profile)
    -v <sandbox>:/work:rw  --memory ... --cpus ... --pids-limit ...
    --cap-drop ALL + the few capabilities sudo and apt need (``CAPABILITIES``);
    no --read-only (the model "permissif mais cloisonné":
    full power INSIDE a disposable per-user container, locked OUT of the host)

There is no host access and no network unless the admin attaches a profile.

SCOPE NOTE: this kernel isolation covers the SHELL. It does NOT (yet) cover
``fs_tools`` / ``git_tools``, which currently run host-direct behind only a
path-prefix check — do not read this module as proof that every tool is
kernel-sandboxed. See ``_exec_bridge`` for the full picture.

Given the container boundary, an applicative policy on top of the shell would
be redundant; the container IS the security boundary for shell. We therefore
expose a single, maximally-permissive shell tool :

  execute_shell : run an arbitrary command via ``bash -c "<command>"``
                  inside the user's container.

Full shell features are available — pipes (``|``), redirections (``>``,
``>>``, ``2>&1``), heredocs (``<<EOF``), variable expansion (``$VAR``),
command substitution (``$(...)``, backticks), control flow (``for``,
``if``, ``&&``, ``||``). The LLM writes whatever it would type in a real
terminal.

Signature: register(mcp, root_base)
"""
from __future__ import annotations

import os
import re
import time
from pathlib import Path
from typing import Any, Dict, Optional, Union

from fastmcp import Context, FastMCP

from llm_core.context.budget import BUDGET as _BUDGET
from llm_core.tools._exec_bridge import run_shell_via_executor, user_id_for
from shared_infra.sandbox.agent_client import AgentError
from shared_infra.sandbox.paths import SandboxPathError, lexical_rel, to_container

from ._espace import Espace
from ._models import BackgroundShellResult, ErrEnvelope, ExecuteShellResult
from ._toolkit import (
    _read_meta_field,
    err,
    get_username,
    tool_kw,
    tool_kw_mutating,
)

DEFAULT_TIMEOUT_S = 120         # aligné OpenCode (builds/tests réels > 30 s)
MAX_TIMEOUT_S     = 600         # long test suites need headroom
DEFAULT_MAX_OUTPUT = 20_000

# ── Category descriptor (see fs_tools.CATEGORY for the contract) ──────
CATEGORY = {
    "name":  "shell",
    "label": "Terminal",
    "icon":  "ph-terminal-window",
    "color": "slate",
    # No "tools" list — captured automatically at registration time.
}

# Category carried IN the protocol (tags + meta), built by the shared
# toolkit — one place to change if a FastMCP version ever rejects meta=.
_TOOL_KW = tool_kw(CATEGORY)

# execute_shell runs arbitrary commands → mutating + open-world (a script
# can curl the internet if the user's network profile allows it). We do
# NOT flag it destructive — the LLM is responsible for `rm -rf` calls;
# flagging the WRAPPER destructive would warn on `ls` too and numb the
# user to the prompt.
_TOOL_KW_MUT_OW = tool_kw_mutating(CATEGORY, open_world=True,
                                   timeout_s=610.0, serial=False, replay_safe=False,
                                   prune="head_tail")


# ── Tiny helpers ─────────────────────────────────────────────────────
# Harmonized error envelope (tools/_toolkit.py): `error` becomes a stable
# machine code, the human text moves to `message`, the hint to `fix`.
def _spill_floor_chars() -> int:
    """Seuil de débord vers fichier = plancher d'émission (tokens) matérialisé
    via le ratio STABLE — un seuil mouvant ferait déborder/ne plus déborder la
    même sortie d'un tour à l'autre."""
    from llm_core.context.tokens import tokens_to_chars_stable
    return tokens_to_chars_stable(_BUDGET.emit_cap_min_tokens)


def _err(msg: str, hint: str = "", **kw) -> Dict[str, Any]:
    code = re.sub(r"[^a-z0-9]+", "_", str(msg).lower()).strip("_")[:40] or "shell_error"
    return err(code, str(msg), fix=hint or None, **kw)


def _clip_marked(s: Optional[str], cap: int = 2000) -> str:
    """Borne un champ de diagnostic AVEC marqueur (une coupe silencieuse
    faisait passer un stderr amputé pour le stderr complet)."""
    s = s or ""
    if len(s) <= cap:
        return s
    return s[:cap] + f"… [+{len(s) - cap} chars omitted]"


def register(mcp: FastMCP, root_base: Path) -> None:
    root_base = root_base.resolve()

    def _sandbox(username: str) -> Path:
        """Resolve (and create) the user's sandbox folder on the host.

        The host folder is mounted into the container at ``/work``; we still
        need the host path to translate relative ``cwd=`` arguments before
        handing them to the executor bridge.
        """
        try:
            from shared_infra.config import safe_sandbox_name as _ssn
            safe = _ssn(username)
        except Exception:
            safe = "".join(c for c in (username or "") if c.isalnum() or c in "-_") or "guest"
        base = Path(os.environ.get("APP_SANDBOX_DIR") or str(root_base)).resolve()
        # ``P/work`` is the dir mounted at ``/work`` (skills/.memory stay at
        # ``P``, outside it). Migrates the legacy flat layout once.
        from shared_infra.sandbox import ensure_work_subdir
        return ensure_work_subdir(base / safe)

    def _rel_sandbox(path: str, sb: Path, quoi: str = "path") -> str:
        """Chemin relatif à ``/work`` d'un chemin fourni (``/work/x``,
        ``work/x``, ``~/x``, relatif…), sans lire le disque : l'agent et le
        conteneur résolvent les liens, sous ``/work``."""
        if not path:
            raise ValueError(f"{quoi} required")
        try:
            return lexical_rel(sb, path)
        except SandboxPathError:
            raise ValueError(f"{quoi} outside sandbox") from None

    def _resolve_cwd(cwd: Optional[str], sb: Path, esp: Espace) -> str:
        """Dossier de travail relatif à ``/work``, vérifié par l'agent."""
        if not cwd:
            return ""
        rel = _rel_sandbox(cwd, sb, "cwd")
        try:
            e = esp.stat(rel)
        except AgentError as ex:
            if ex.code == "outside_root":
                raise ValueError("cwd outside sandbox") from None
            raise
        if e.get("outside"):
            raise ValueError("cwd outside sandbox")
        if e["kind"] != "dir":
            raise ValueError(f"cwd not a directory: {to_container(rel)}")
        return rel

    # ── execute_shell ─────────────────────────────────────────────────
    @mcp.tool(**_TOOL_KW_MUT_OW)
    def execute_shell(
        ctx: Context,
        command: str,
        cwd: Optional[str] = None,
        timeout_sec: Optional[int] = None,
        stdin: str = "",
        stdin_b64: str = "",
        env: Dict[str, str] = {},
        save_stdout: str = "",
        background: bool = False,
    ) -> Union[ExecuteShellResult, BackgroundShellResult, ErrEnvelope]:
        """Execute an arbitrary shell command inside your sandbox container.

The command is passed verbatim to ``bash -c`` — all shell features are
available: pipes, redirections, heredocs, ``$VAR``, ``$(...)``, backticks,
``for``/``if``/``&&``/``||``. Quotes and special characters need NO extra
escaping beyond normal shell syntax.

``ok:false`` with a ``returncode`` means YOUR COMMAND exited non-zero (the
tool itself worked) — read stdout/stderr and fix the command, do not retry
it unchanged.

IMPORTANT: this tool is for terminal operations (git, builds, tests, package
managers, processes). Do NOT use it for file operations — use the dedicated
tools instead: read_file (not cat/head/tail), edit_file (not sed -i),
write_file (not echo >), list_files (not find/grep -r). They are cheaper,
safer and their output is formatted for you.

If the output is truncated, the FULL output is saved automatically to a
sandbox file (``saved_to`` in the result) — read it with
``read_file(saved_to, grep='...')`` or ``tail``; do not re-run the command
just to see more.

Args:
  command     : the shell command line (anything you'd type in a terminal).
  cwd         : working dir, relative to sandbox root. Defaults to root.
  timeout_sec : max wall time (1..600, default 120). For servers or long
                jobs use ``background=true`` instead of a huge timeout.
  stdin       : text fed to the process's stdin (UTF-8).
  stdin_b64   : base64 bytes fed to stdin (binary-safe; exclusive with stdin).
  env         : extra environment vars. Keys must match [A-Z_][A-Z0-9_]*,
                key<64 chars, value<4000 chars.
  save_stdout : if set, write the FULL stdout to this exact sandbox file
                (otherwise auto-save only happens on truncation).
  background  : run detached and return immediately with {pid, log}. Output
                goes to the log file (read it with read_file / tail). Use
                for servers (http.server, Xvfb…) and long builds.

Returns: {ok, cmd, cwd, returncode, truncated, duration_ms, executor,
          stdout, stderr [, saved_to, saved_bytes]} — background=true
          returns {ok, background, pid, log} instead.
"""
        _username = get_username(ctx)
        try:
            sb = _sandbox(_username)
            if not isinstance(command, str) or not command.strip():
                return _err("empty_command", hint="Provide a command to run.")

            try:
                workdir = _resolve_cwd(cwd, sb, Espace(_username, sb))
            except ValueError as e:
                return _err(str(e), hint="cwd must be inside your sandbox.")

            save_rel: Optional[str] = None
            if save_stdout:
                try:
                    save_rel = _rel_sandbox(save_stdout, sb)
                except ValueError as e:
                    return _err(f"bad save_stdout: {e}")

            # Débord AUTOMATIQUE (sans save_stdout explicite) : si la sortie
            # dépasse la limite de réponse, le bridge écrit le COMPLET ici et
            # le résultat pointe dessus (saved_to + hint). N'écrit RIEN si la
            # sortie tient (l'agent crée alors .tool-output/). Best-effort.
            _auto_spill: Optional[str] = None
            if not save_stdout and not background:
                import secrets as _secrets
                _auto_spill = f".tool-output/shell-{int(time.time())}-{_secrets.token_hex(3)}.log"

            if stdin and stdin_b64:
                return _err("stdin_conflict",
                            hint="Use either stdin (text) or stdin_b64 (bytes), not both.")
            stdin_bytes: Optional[bytes] = None
            if stdin_b64:
                import base64 as _b64
                try:
                    stdin_bytes = _b64.b64decode(stdin_b64, validate=True)
                except Exception:
                    return _err("stdin_b64_invalid",
                                hint="stdin_b64 must be valid base64.")
            elif stdin:
                stdin_bytes = stdin.encode("utf-8")

            env_extra: Dict[str, str] = {"GIT_TERMINAL_PROMPT": "0"}
            for k, v in (env or {}).items():
                if len(k) > 64 or len(str(v)) > 4000:
                    return _err("env_invalid",
                                hint="Key<64 chars, value<4000 chars.")
                if not re.fullmatch(r"[A-Z_][A-Z0-9_]*", k):
                    return _err("env_key_invalid",
                                hint=f"Key '{k}' must match [A-Z_][A-Z0-9_]*")
                env_extra[k] = str(v)

            timeout = max(1, min(int(timeout_sec or DEFAULT_TIMEOUT_S), MAX_TIMEOUT_S))

            # ── Mode BACKGROUND : lance détaché, retourne pid + log ──────
            # La commande originale est transmise en ARGUMENT POSITIONNEL
            # ($1) du wrapper — jamais interpolée dans une string shell →
            # aucun re-quoting, aucune fragilité d'échappement. Le process
            # est reparenté au PID 1 du conteneur (persistant) via nohup+&.
            if background:
                import secrets as _secrets
                _log_rel = f".bg/bg-{int(time.time())}-{_secrets.token_hex(3)}.log"
                _log_container = f"/work/{_log_rel}"
                # AUDIT 2026-08-23 — ``;`` et non ``&&``, plus ``setsid``.
                #
                # En bash, ``&`` a une précédence PLUS FAIBLE que ``&&`` : la
                # LISTE ENTIÈRE ``mkdir && nohup …`` partait en tâche de fond,
                # donc ``$!`` rendait le PID du SOUS-SHELL forké pour cette
                # liste, pas celui de la commande. Rejoué : ``$!`` = 11625
                # (bash) pendant que le vrai ``sleep`` portait 11629. Le
                # modèle recevait donc un PID qui n'est pas le sien, lançait un
                # ``kill <pid>`` que l'outil lui dicte lui-même, et le
                # processus survivait — reparenté au PID 1. Les serveurs
                # s'empilaient jusqu'au ``--pids-limit`` du conteneur.
                # ``setsid`` donne en plus un groupe de processus propre, et
                # ``</dev/null`` évite de retenir stdin.
                _wrapper = ('mkdir -p "$(dirname "$2")"; '
                            'nohup setsid bash -c "$1" >"$2" 2>&1 </dev/null & '
                            'echo "$!"')
                tokens = ["bash", "-c", _wrapper, "bash", command, _log_container]
                bg_timeout = 15   # le wrapper retourne immédiatement
            else:
                tokens = ["bash", "-c", command]
                bg_timeout = timeout

            # ── Live shell (opt-in par appel) ────────────────────────────
            # Le chat pose ``live_shell: "1"`` dans le meta MCP quand le
            # réglage utilisateur « Terminal en direct » est actif. Absent
            # (routines, sous-agents task, desktop-agent, tests) → pas de
            # stream. Jamais en background (le wrapper retourne aussitôt).
            _live = (_read_meta_field(ctx, "live_shell") == "1") and not background

            # Fichiers modifiés par la commande (2026-09-26) : relevé avant /
            # après pour l'historique et les diffs du chat. Pas en
            # background : la commande n'a encore rien fait au retour.
            from llm_core.tools._work_changes import WorkChanges as _WC
            _uid_wc = user_id_for(_username) or None
            _wc = None if background else _WC(_uid_wc, _username, sb, "shell")
            if _wc is not None:
                _wc.__enter__()
            try:
                result = run_shell_via_executor(
                    tokens=tokens,
                    workdir_rel=workdir,
                    sandbox_root=sb,
                    env_extra=env_extra,
                    timeout_s=bg_timeout,
                    max_output=DEFAULT_MAX_OUTPUT,
                    stdin_bytes=stdin_bytes,
                    user_id=user_id_for(_username),
                    username=_username,
                    ctx=ctx,
                    stream_live=_live,
                    # Le bridge écrit le stdout COMPLET avant troncature —
                    # l'ancien code écrivait result["stdout"] déjà tronqué à
                    # 20 KB alors que la doc promettait le complet.
                    save_stdout_rel=save_rel,
                    auto_spill_rel=_auto_spill,
                    # Déborde vers un fichier dès que la sortie dépasse le
                    # PLANCHER d'émission (pas seulement les 20 KB de max_output) :
                    # l'étage d'émission recoupe à emit_cap(n_ctx) ≥ ce plancher,
                    # donc toute sortie tronquée à l'émission a bien un saved_to.
                    # Harnais v4 : plancher en TOKENS, matérialisé STABLE (le
                    # seuil de débord ne doit pas bouger avec le ratio mesuré).
                    spill_over_chars=_spill_floor_chars(),
                )
            except Exception as bridge_err:
                if _wc is not None:
                    _wc.__exit__(None, None, None)
                return _err(
                    f"executor unavailable: {bridge_err}",
                    hint=("Container may be down. Try restarting it via "
                          "the sandbox panel (POST /api/sandbox/me/restart)."),
                    cmd=command,
                )

            if background:
                _pid_txt = (result.get("stdout") or "").strip().splitlines()
                _pid = None
                for _line in reversed(_pid_txt):
                    if _line.strip().isdigit():
                        _pid = int(_line.strip())
                        break
                if not result.get("ok") or _pid is None:
                    return _err("background_launch_failed",
                                hint="Detached launch failed — read stderr.",
                                stderr=_clip_marked(result.get("stderr")),
                                stdout=_clip_marked(result.get("stdout")))
                return {
                    "ok": True, "background": True, "pid": _pid,
                    "cmd": command, "log": _log_container,
                    "hint": (f"Processus détaché (pid {_pid}). Sortie dans "
                             f"{_log_container} — consulte-la avec read_file ou "
                             f"`tail -n 50 {_log_container}` ; arrête avec `kill {_pid}`."),
                }

            if _wc is not None:
                _wc.__exit__(None, None, None)
                _wc.attach(result)

            # Override the bridge's tokens-joined `cmd` with the original
            # shell string — much more readable for the LLM than
            # `bash -c "<escaped string>"`.
            result["cmd"] = command

            if save_rel is not None and "saved_bytes" in result:
                result["saved_to"] = to_container(save_rel)
            elif result.pop("auto_saved", False) and _auto_spill is not None:
                _spill_ct = to_container(_auto_spill)
                result["saved_to"] = _spill_ct
                # AUDIT 2026-08-23 — le débord a DEUX causes et le message n'en
                # nommait qu'une. Le pont déborde sur ``truncated`` OU sur un
                # simple dépassement du plancher d'émission (7 920 caractères
                # mesurés), alors que la troncature réelle n'intervient qu'à
                # 20 000 : dans cette bande, ``truncated: false``, stdout
                # COMPLET, et pourtant « Output truncated ». Le modèle, qui lit
                # le hint avant d'inspecter le booléen, enchaînait un
                # ``read_file`` inutile sur un contenu qu'il avait déjà entier
                # sous les yeux. Deux messages contradictoires dans le même
                # objet — précisément ce que la couche _toolkit prétend
                # supprimer (« une seule marque de troncature, honnête »).
                if result.get("truncated"):
                    _phrase = (f" Output truncated — the FULL output was saved "
                               f"to {_spill_ct}. Use read_file with grep/tail "
                               f"on it; do not re-run the command just to see "
                               f"more.")
                else:
                    _phrase = (f" Full output also saved to {_spill_ct} "
                               f"(the stdout below is COMPLETE — no need to "
                               f"read the file).")
                result["hint"] = ((result.get("hint") or "") + _phrase).strip()

            # ── Hints ciblés sur les codes d'échec récurrents ─────────────
            # (mesuré en prod : `python` vs `python3` = friction n°1 du 127 ;
            # timeout = tentatives de serveurs/Xvfb sans background).
            _rc = result.get("returncode")
            if _rc == 127 and "fix" not in result:
                if re.search(r"(^|[^\w.])python($|[^\w3])", command):
                    result["fix"] = ("`python` n'existe pas dans le conteneur — "
                                     "utilise `python3` (ou `pip3`).")
                else:
                    result["fix"] = ("Commande introuvable (127). Vérifie le nom, ou "
                                     "installe-la (`pip install --user …` / `npm install -g …`).")
            elif result.get("error") == "timeout":
                result["fix"] = ((result.get("hint") or "") +
                                 " Pour un serveur ou un processus long, relance avec "
                                 "background=true (retour immédiat + log).").strip()

            return result
        except Exception as e:
            return _err(str(e))
