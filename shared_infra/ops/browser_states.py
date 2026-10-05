# SPDX-License-Identifier: MIT
"""shared_infra.ops.browser_states — états du navigateur enregistrés avant la
0.0.1 (``./elpis browser``).

Le service navigateur range chaque état sauvegardé (cookies, stockage local)
sous le compte qui l'a enregistré :
``browser-service/cookies/state_<propriétaire>__<id>.json``. Le propriétaire
est celui que transmettent les outils ``pw_*`` : ``pw_owner`` du nom de
connexion déjà assaini par ``get_username`` (``safe_sandbox_name`` : « rené »
donne « ren »). Un état enregistré avant la 0.0.1, ``state_<id>.json``,
n'appartient à personne : le service ne le charge pas (un compte qui
connaîtrait l'identifiant obtiendrait la session connectée d'un autre) et ne
le purge pas. Seul un administrateur peut décider à qui il revient (les sites
listés y aident) :

* ``states`` liste ces états (identifiant, date, sites des cookies et du
  stockage local, jamais leurs valeurs) ;
* ``migrate-states COMPTE ID…`` (ou ``--all`` : tous) les rattache au compte
  Elpis ``COMPTE`` ; le même ``load_state_id`` les recharge ensuite.

Le rattachement ne remplace jamais un état déjà présent sous le nouveau nom
(vérifié juste avant le renommage), et remet la date de l'état à maintenant
AVANT de le renommer : le service supprime un état ``PW_STATE_MAX_AGE_D``
jours (30 par défaut) après son enregistrement, même s'il sert ; il
effacerait sinon aussitôt un état ancien à peine rattaché.
"""
from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional, Sequence, Tuple
from urllib.parse import urlsplit

# Mêmes motifs que ``isLegacyStateName`` et ``stateFileName`` de
# browser-service/session_util.js.
_NOM_ANCIEN = re.compile(r"state_([A-Za-z0-9-]{8,64})\.json")
_ID = re.compile(r"[A-Za-z0-9-]{8,64}")

SITES_AFFICHES = 4
# Identité des appels d'outils sans compte : un état rattaché à « guest »
# serait offert à tout client non identifié.
_ANONYME = "guest"


@dataclass
class Rattachement:
    """Bilan d'un rattachement : identifiants renommés (à renommer, en essai),
    déjà rattachés à ce compte, erreurs (rien n'a été renommé pour celles-là)."""
    faits: List[str] = field(default_factory=list)
    deja: List[str] = field(default_factory=list)
    erreurs: List[str] = field(default_factory=list)


def dossier_par_defaut() -> Path:
    """``browser-service/cookies`` du dépôt, dossier de lancement du service.
    Calculé sans importer la configuration : ``./elpis doctor`` lit la sortie
    de ``states --count``."""
    return Path(__file__).resolve().parents[2] / "browser-service" / "cookies"


def proprietaire(compte: str) -> str:
    """Propriétaire que les outils ``pw_*`` transmettent pour ``compte``."""
    from shared_infra.config import safe_sandbox_name
    from shared_infra.security.browser_url import pw_owner
    return pw_owner(safe_sandbox_name(compte))


def etats_sans_compte(dossier: Path) -> List[Tuple[str, Path]]:
    """``(id, chemin)`` des états sans propriétaire de ``dossier``, du plus
    ancien au plus récent ; dossier absent → aucun."""
    try:
        noms = os.listdir(dossier)
    except FileNotFoundError:
        return []
    etats = []
    for nom in noms:
        m = _NOM_ANCIEN.fullmatch(nom)
        if m and (dossier / nom).is_file():
            etats.append((m.group(1), dossier / nom))
    return sorted(etats, key=lambda e: (e[1].stat().st_mtime, e[0]))


def _hote(origine: str) -> str:
    try:
        return urlsplit(origine).hostname or origine
    except ValueError:
        return origine


def sites(chemin: Path) -> Optional[List[str]]:
    """Domaines des cookies et hôtes des origines du stockage local d'un état,
    ou ``None`` s'il est illisible. Les valeurs ne sont jamais rendues."""
    try:
        etat = json.loads(chemin.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(etat, dict):
        return None
    cookies, origines = etat.get("cookies"), etat.get("origins")
    vus = set()
    for cookie in cookies if isinstance(cookies, list) else []:
        if isinstance(cookie, dict) and isinstance(cookie.get("domain"), str):
            vus.add(cookie["domain"].lstrip("."))
    for origine in origines if isinstance(origines, list) else []:
        if isinstance(origine, dict) and isinstance(origine.get("origin"), str):
            vus.add(_hote(origine["origin"]))
    return sorted(v for v in vus if v)


def description(chemin: Path) -> str:
    """« date  sites » d'un état, pour la liste et le bilan d'un rattachement."""
    date = time.strftime("%Y-%m-%d %H:%M", time.localtime(chemin.stat().st_mtime))
    s = sites(chemin)
    if s is None:
        detail = "illisible"
    elif not s:
        detail = "(aucun site)"
    else:
        detail = ", ".join(s[:SITES_AFFICHES]) + (" …" if len(s) > SITES_AFFICHES else "")
    return f"{date}  {detail}"


def rattacher(dossier: Path, proprio: str, ids: Sequence[str] = (), *,
              essai: bool = False) -> Rattachement:
    """Renomme ``state_<id>.json`` en ``state_<proprio>__<id>.json`` pour
    les ``ids`` donnés ou, à défaut, pour tous les états sans compte, date
    remise à maintenant (voir l'en-tête). ``essai`` : rien n'est touché."""
    bilan = Rattachement()
    cibles: Sequence[str] = (list(dict.fromkeys(ids)) if ids
                             else [i for i, _ in etats_sans_compte(dossier)])
    for i in cibles:
        if not _ID.fullmatch(i):
            bilan.erreurs.append(f"{i} : identifiant invalide")
            continue
        ancien = dossier / f"state_{i}.json"
        nouveau = dossier / f"state_{proprio}__{i}.json"
        if nouveau.exists():
            if ancien.exists():
                bilan.erreurs.append(f"{i} : {nouveau.name} existe déjà, "
                                     f"{ancien.name} laissé tel quel")
            else:
                bilan.deja.append(i)
            continue
        if not ancien.is_file():
            bilan.erreurs.append(f"{i} : aucun état sans compte sous cet identifiant")
            continue
        if not essai:
            try:
                _renommer(ancien, nouveau)
            except OSError as e:
                bilan.erreurs.append(f"{i} : {e.strerror or e}")
                continue
        bilan.faits.append(i)
    return bilan


def _renommer(ancien: Path, nouveau: Path) -> None:
    """Date à maintenant, puis renommage. S'il échoue, l'état garde sa date
    d'origine : elle aide à retrouver le compte."""
    st = ancien.stat()
    os.utime(ancien)
    try:
        os.rename(ancien, nouveau)
    except OSError:
        with contextlib.suppress(OSError):
            os.utime(ancien, ns=(st.st_atime_ns, st.st_mtime_ns))
        raise


def _compte_connu(compte: str) -> bool:
    from shared_infra.accounts.users import get_user
    return get_user(compte) is not None


def _jours_de_conservation() -> int:
    """``PW_STATE_MAX_AGE_D`` tel que le service le reçoit (``./elpis`` charge
    ``.env``) ; 30 par défaut."""
    try:
        return int(os.environ.get("PW_STATE_MAX_AGE_D") or 30)
    except ValueError:
        return 30


def _lister(dossier: Path, *, nombre_seul: bool) -> int:
    etats = etats_sans_compte(dossier)
    if nombre_seul:
        print(len(etats))
        return 0
    if not etats:
        print(f"Aucun état du navigateur sans compte dans {dossier}.")
        return 0
    print(f"{len(etats)} état(s) du navigateur enregistré(s) avant la 0.0.1, sans compte "
          f"({dossier}) :")
    for i, chemin in etats:
        print(f"  {i}  {description(chemin)}")
    print("Rattacher : ./elpis browser migrate-states COMPTE ID… (--all : tous à ce compte).")
    print(f"Supprimer un état dont personne ne veut : rm {dossier}/state_<ID>.json")
    return 0


def _migrer(dossier: Path, compte: str, ids: Sequence[str], *, tous: bool, essai: bool,
            verifier: bool) -> int:
    if not compte.strip():
        print("Compte Elpis requis.", file=sys.stderr)
        return 2
    if ids and tous:
        print("Des identifiants ou --all, pas les deux.", file=sys.stderr)
        return 2
    if not ids and not tous:
        print("Précisez les identifiants à rattacher (./elpis browser states les liste), "
              "ou --all pour les rattacher tous à ce compte.", file=sys.stderr)
        return 2
    if not dossier.is_dir():
        print(f"Dossier introuvable : {dossier}", file=sys.stderr)
        return 2
    proprio = proprietaire(compte)
    if proprio == _ANONYME and compte != _ANONYME:
        print(f"Le nom {compte!r} se réduit à « {_ANONYME} », l'identité des appels sans "
              "compte : rattachement refusé.", file=sys.stderr)
        return 2
    if verifier:
        try:
            connu = _compte_connu(compte)
        except Exception as e:                    # noqa: BLE001 — erreurs de tous les moteurs de base
            print(f"Base injoignable ({type(e).__name__} : {e}) : --no-check rattache sans "
                  "vérifier le compte.", file=sys.stderr)
            return 2
        if not connu:
            print(f"Compte Elpis inconnu : {compte!r} (nom de connexion exact ; "
                  "--no-check pour rattacher quand même).", file=sys.stderr)
            return 2
    descriptions = {i: description(chemin) for i, chemin in etats_sans_compte(dossier)}
    bilan = rattacher(dossier, proprio, ids, essai=essai)
    for i in bilan.faits:
        print(f"state_{i}.json → state_{proprio}__{i}.json  ({descriptions.get(i, '?')})")
    for i in bilan.deja:
        print(f"{i} : déjà rattaché à ce compte.")
    for erreur in bilan.erreurs:
        print(erreur, file=sys.stderr)
    n = len(bilan.faits)
    if n and essai:
        print(f"Essai : {n} état(s) à rattacher au compte {compte}, rien n'a été renommé.")
    elif n:
        jours = _jours_de_conservation()
        duree = (f"pendant {jours} jours (PW_STATE_MAX_AGE_D ; les recharger ne prolonge pas "
                 "ce délai)" if jours > 0 else "sans limite de durée (PW_STATE_MAX_AGE_D=0)")
        print(f"{n} état(s) rattaché(s) au compte {compte}"
              f"{'' if verifier else ' (compte non vérifié)'} : le même load_state_id les "
              f"recharge {duree}.")
    elif not (bilan.deja or bilan.erreurs):
        print(f"Aucun état du navigateur sans compte dans {dossier}.")
    return 1 if bilan.erreurs else 0


def main(argv: Optional[Sequence[str]] = None) -> int:
    commun = argparse.ArgumentParser(add_help=False)
    commun.add_argument("--dir", type=Path, dest="dossier",
                        help="dossier des états (défaut : browser-service/cookies du dépôt)")
    ap = argparse.ArgumentParser(
        prog="./elpis browser",
        description="États du navigateur enregistrés avant la 0.0.1, sans compte.")
    sous = ap.add_subparsers(dest="commande", required=True)
    liste = sous.add_parser("states", parents=[commun],
                            help="liste les états sans compte (identifiant, date, sites)")
    liste.add_argument("--count", action="store_true", help="n'affiche que leur nombre")
    migre = sous.add_parser("migrate-states", parents=[commun],
                            help="rattache des états sans compte à un compte Elpis")
    migre.add_argument("compte", help="nom de connexion du compte Elpis")
    migre.add_argument("ids", nargs="*", metavar="ID",
                       help="identifiants (load_state_id) des états à rattacher")
    migre.add_argument("--all", action="store_true", dest="tous",
                       help="rattache TOUS les états sans compte à ce compte (s'ils sont "
                            "tous à lui : voir « states »)")
    migre.add_argument("--dry-run", action="store_true", help="affiche sans rien renommer")
    migre.add_argument("--no-check", action="store_true",
                       help="ne vérifie pas que le compte existe dans la base")
    args = ap.parse_args(argv)
    dossier = args.dossier or dossier_par_defaut()
    try:
        if args.commande == "states":
            return _lister(dossier, nombre_seul=args.count)
        return _migrer(dossier, args.compte, args.ids, tous=args.tous, essai=args.dry_run,
                       verifier=not args.no_check)
    except OSError as e:
        print(f"{e.filename or dossier} : {e.strerror or e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
