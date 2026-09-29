# SPDX-License-Identifier: MIT
"""``python -m toolhost`` — lance l'hôte d'outils.

* par défaut : service réseau (``toolhost.json › bind``, ou ``LOCAL_MCP_*``) —
  MCP en HTTP streamable (``/mcp[/<famille>]``) ET en SSE (``/sse[/<famille>]``),
  API sandbox, terminal et actifs, sur un seul port ;
* ``--stdio`` : le service MCP seul, en sous-process stdio — c'est l'endpoint
  stdio d'un applicatif tiers, et le repli par worker de l'app
  (``mcp.json › x-elpis.fallback``, dérivé par famille).

``--families fs,git`` (ou ``--family fs``) restreint les familles enregistrées,
quel que soit le mode. C'est ce qui donne un serveur MCP stdio PAR FAMILLE :

    python -m toolhost --stdio --families git
"""
from __future__ import annotations

import os
import sys


def _parse_families(argv: "list[str]") -> "str | None":
    """``--families a,b`` / ``--family a`` / ``--families=a,b`` → chaîne, ou
    ``None`` si l'argument est absent."""
    out: "list[str]" = []
    i = 0
    while i < len(argv):
        a = argv[i]
        for flag in ("--families", "--family"):
            if a == flag and i + 1 < len(argv):
                out.append(argv[i + 1])
                i += 1
                break
            if a.startswith(flag + "="):
                out.append(a[len(flag) + 1:])
                break
        i += 1
    return ",".join(x for x in out if x.strip()) if out else None


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    from shared_infra.mcp.families import parse_families
    from toolhost.config import apply_environment, load
    tc = load()
    fams = _parse_families(argv)
    if fams is not None:
        warn: "list[str]" = []
        tc.families = parse_families(fams, warn=warn.append)
        for w in warn:
            # stderr : en ``--stdio``, stdout est le canal JSON-RPC.
            print(f"[toolhost] {w}", file=sys.stderr, flush=True)
    if "--stdio" in argv or tc.transport == "stdio":
        tc.transport = "stdio"
        tc.transports = []
        apply_environment(tc)
        import server.local_mcp_server as S
        S.SANDBOX_ROOT.mkdir(parents=True, exist_ok=True)
        S.register_all_tools(families=list(tc.families))
        try:
            from shared_infra.memory.ax import init_db as _init_ax_db
            _init_ax_db()
        except Exception as e:                                    # noqa: BLE001
            print(f"WARN: ax init_db : {e!r}", file=sys.stderr, flush=True)
        S.mcp.run(show_banner=False)
        return 0
    apply_environment(tc)
    import server.local_mcp_server as S
    if not S.bind_allowed(tc.host, bool(tc.token)):
        print(f"[toolhost] REFUS : bind {tc.host}:{tc.port} hors loopback sans jeton de service.",
              flush=True)
        return 2
    from toolhost.app import build_app
    app = build_app(tc)
    _paths = []
    if "http" in tc.transports:
        _paths.append(f"{S.HTTP_MOUNT_PATH}[/<famille>]")
    if "sse" in tc.transports:
        _paths.append(f"{S.SSE_MOUNT_PATH}[/<famille>]")
    print(f"[toolhost] hôte d'outils : http://{tc.host}:{tc.port}  "
          f"(MCP {' + '.join(_paths)}, familles {', '.join(tc.families)}, "
          f"auth={'bearer' if tc.token else 'aucune (loopback)'})", flush=True)
    import uvicorn
    uvicorn.run(app, host=tc.host, port=tc.port, log_level=os.environ.get("TOOLHOST_LOG_LEVEL", "info"),
                ws_max_size=64 * 1024 * 1024)
    return 0


if __name__ == "__main__":
    sys.exit(main())
