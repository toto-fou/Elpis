# SPDX-License-Identifier: MIT
"""``python -m shared_infra.db`` — exploitation de la base (chantier
multi-moteurs, lot D).

    info                         moteur actif, version, taille, schéma
    check  CIBLE                 joignable ? version, vide ?, latence
    transfer --to CIBLE [--from CIBLE] [--dry-run] [--report FICHIER]
    use sqlite | CIBLE           écrit la section « database » de config.json

CIBLE : ``sqlite:/chemin/app.db``, ``postgres://user@hôte:5432/base``,
``mysql://user@hôte:3306/base`` (``?tls=require|verify``). Le mot de passe
vient de ``--password-env VAR`` (nom d'une variable d'environnement) ou d'une
saisie masquée ; jamais de la ligne de commande.

``use sqlite`` est la porte de sortie quand le serveur de base est tombé :
l'application redémarre sur son fichier SQLite (``APP_DB_BACKEND=sqlite``
fait de même sans toucher à la config). Redémarrer l'application ensuite.
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
from pathlib import Path


def _password(args, target) -> None:
    if target["backend"] == "sqlite" or target.get("password"):
        return
    if args.password_env:
        target["password"] = os.environ.get(args.password_env, "")
    elif sys.stdin.isatty():
        target["password"] = getpass.getpass(f"Mot de passe de {target['user']}@{target['host']} : ")


def _target(args, text):
    from shared_infra.db.transfer import parse_target
    t = parse_target(text)
    _password(args, t)
    return t


def cmd_info(args) -> int:
    from shared_infra.db._connection import db_info
    print(json.dumps(db_info(), ensure_ascii=False, indent=2))
    return 0


def cmd_check(args) -> int:
    from shared_infra.db.transfer import check_target
    try:
        out = check_target(_target(args, args.target))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


def cmd_transfer(args) -> int:
    from shared_infra.db import transfer as T
    src = _target(args, args.source) if args.source else T.active_target()
    dst = _target(args, args.to)

    def progress(table, done, total):
        if sys.stderr.isatty():
            print(f"\r{table:<32} {done}/{total}", end="", file=sys.stderr, flush=True)

    try:
        report = T.transfer(src, dst, dry_run=args.dry_run, progress=progress)
    except T.TransferError as exc:
        print(f"\nrefusé : {exc}", file=sys.stderr)
        return 2
    if sys.stderr.isatty():
        print(file=sys.stderr)
    text = json.dumps(report, ensure_ascii=False, indent=2)
    if args.report:
        Path(args.report).write_text(text, encoding="utf-8")
    print(text)
    return 0 if report["ok"] else 1


def cmd_use(args) -> int:
    from shared_infra import config as cfg
    new = cfg.read_config_json()
    if args.target == "sqlite":
        new.setdefault("database", {})["backend"] = "sqlite"
    else:
        from shared_infra.db.transfer import check_target
        t = _target(args, args.target)
        info = check_target(t)
        if info["empty"]:
            print("refusé : la base cible est vide — faire d'abord « transfer ».", file=sys.stderr)
            return 2
        new["database"] = {"backend": t["backend"], "host": t["host"], "port": t["port"],
                           "name": t["name"], "user": t["user"], "tls": t["tls"]}
        if t.get("password"):
            pw = Path(cfg.DB_PATH).parent / ".db_password"
            fd = os.open(pw, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(t["password"])
    cfg.write_config_json(new)
    print(f"database.backend = {new['database']['backend']} — redémarrer l'application.")
    if os.environ.get("APP_DB_BACKEND"):
        print("attention : APP_DB_BACKEND est posé dans l'environnement et prime sur config.json.")
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="python -m shared_infra.db", description=__doc__.split("\n")[0])
    p.add_argument("--password-env", help="variable d'environnement qui porte le mot de passe")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("info", help="moteur actif, version, taille, schéma").set_defaults(fn=cmd_info)
    c = sub.add_parser("check", help="tester une cible")
    c.add_argument("target")
    c.set_defaults(fn=cmd_check)
    t = sub.add_parser("transfer", help="copier les données vers une base vide")
    t.add_argument("--to", required=True)
    t.add_argument("--from", dest="source", help="défaut : la base active")
    t.add_argument("--dry-run", action="store_true")
    t.add_argument("--report", help="écrire le rapport JSON dans ce fichier")
    t.set_defaults(fn=cmd_transfer)
    u = sub.add_parser("use", help="choisir la base de l'application")
    u.add_argument("target", help="sqlite ou une CIBLE serveur")
    u.set_defaults(fn=cmd_use)
    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
