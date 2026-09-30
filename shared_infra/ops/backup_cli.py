# SPDX-License-Identifier: MIT
"""shared_infra.ops.backup_cli — sauvegarde en ligne de commande
(``./elpis backup``, et première étape de ``./elpis upgrade``).

Même archive que la console (Système › Données › Sauvegarde) : ``full``
(base, ``user_db/``, sandboxes, serveurs MCP, skins), ``db``, ``sandboxes`` ou
``mcp``. Construite directement dans ``backups/`` à la racine du dépôt (hors
de ce que la sauvegarde complète emporte), lisible du seul compte de
l'application : elle contient les secrets de ``user_db/``.

Code de sortie non nul si une archive ``full`` ou ``db`` ne contient pas la
base ; les fichiers ignorés sont listés sur la sortie d'erreur.
"""
from __future__ import annotations

import argparse
import os
import sys
import zipfile
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
    if not dest.is_dir():
        dest.mkdir(parents=True)
        os.chmod(dest, 0o700)          # créé ici : lisible du seul compte
    tmp, name = _make_backup_zip(args.scope, directory=str(dest))   # mkstemp : 0600
    target = dest / name
    os.replace(tmp, target)
    with zipfile.ZipFile(target) as zf:
        noms = zf.namelist()
        if "backup-warnings.txt" in noms:
            sys.stderr.write(zf.read("backup-warnings.txt").decode("utf-8", "replace"))
    print(target)
    if args.scope in ("full", "db") and not any(n.startswith("db/") for n in noms):
        print("sauvegarde incomplète : la base n'y est pas", file=sys.stderr)
        return 1
    from shared_infra.routes._helpers import backup_incomplete
    if backup_incomplete(name):
        print("sauvegarde incomplète : /work d'au moins un compte non sauvegardé",
              file=sys.stderr)
        return 3                                           # distinct : ./elpis upgrade continue
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
