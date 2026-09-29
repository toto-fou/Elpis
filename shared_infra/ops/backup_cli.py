# SPDX-License-Identifier: MIT
"""shared_infra.ops.backup_cli — sauvegarde en ligne de commande
(``./elpis backup``, et première étape de ``./elpis upgrade``).

Même archive que la console (Maintenance › Sauvegarde) : ``full`` (base,
``user_db/``, sandboxes, serveurs MCP, skins), ``db``, ``sandboxes`` ou
``mcp``. Écrite dans ``backups/`` à la racine du dépôt (hors de ce que la
sauvegarde complète emporte), lisible du seul compte de l'application : elle
contient les secrets de ``user_db/``.
"""
from __future__ import annotations

import argparse
import os
import shutil
from pathlib import Path

SCOPES = ("full", "db", "sandboxes", "mcp")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="./elpis backup",
                                 description="Sauvegarde de l'instance (archive zip).")
    ap.add_argument("scope", nargs="?", default="full", choices=SCOPES)
    ap.add_argument("--dest", help="dossier de destination (défaut : backups/ du dépôt)")
    args = ap.parse_args(argv)

    from shared_infra.config import PROJECT_ROOT
    from shared_infra.routes._helpers import _make_backup_zip
    dest = Path(args.dest) if args.dest else Path(PROJECT_ROOT) / "backups"
    dest.mkdir(parents=True, exist_ok=True)
    os.chmod(dest, 0o700)
    tmp, name = _make_backup_zip(args.scope)
    target = dest / name
    shutil.move(tmp, target)
    os.chmod(target, 0o600)
    print(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
