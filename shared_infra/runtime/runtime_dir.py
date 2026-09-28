# SPDX-License-Identifier: MIT
"""
shared_infra.runtime.runtime_dir — Racine des canaux inter-process de l'application.

AUDIT 2026-08-22 (D8) — quatre mécanismes font tenir ensemble les workers
gunicorn : le bus d'annulation, les verrous de présence des générations, le
verrou de leader des routines, et le magasin de reprise des sous-agents.
Chacun avait choisi son chemin dans ``/tmp``, et trois d'entre eux acceptaient
une surcharge par variable d'environnement — le quatrième (le bus
d'annulation) l'avait en dur. Deux conséquences :

* **Cohérence.** Le jour où ces services sont lancés par des unités systemd
  avec le durcissement usuel ``PrivateTmp=yes``, chaque service reçoit son
  propre ``/tmp`` : les quatre canaux se scindent EN SILENCE. Le Stop cesse de
  traverser, la console d'administration compte zéro génération en cours, et
  rien ne signale la panne. Une racine unique, surchargeable d'un seul geste
  (``ELPIS_RUNTIME_DIR``), rend le déploiement explicite.
* **Intégrité.** ``/tmp`` est partagé par tous les comptes de la machine. Un
  fichier de bus créé à l'avance par un autre compte, en écriture pour tous,
  laisserait n'importe qui écrire des demandes d'annulation — c'est-à-dire
  tuer les générations d'autrui. On vérifie donc le propriétaire et les droits
  avant d'écrire ou de lire, et on refuse un répertoire qui n'est pas à nous.

Les surcharges historiques (``ELPIS_CHAT_LOCK_DIR``, ``ELPIS_TASK_RESUME_DIR``,
``ELPIS_CRON_LOCK_PATH``) restent prioritaires : un déploiement existant qui
les pose ne doit pas changer de comportement.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

from shared_infra.env_compat import env

logger = logging.getLogger("uvicorn.error")

# Racine EXPLICITE, ou rien. ``ELPIS_RUNTIME_DIR`` non posé ⇒ chaque canal
# garde son chemin historique (cf. ``runtime_path``).
#
# ⚠ POURQUOI PAS DE NOUVELLE RACINE PAR DÉFAUT : le rechargement est gracieux,
# et depuis l'audit 2026-08-22 un ancien worker peut survivre des heures pour
# finir ses missions. Changer les chemins par défaut ferait donc coexister,
# pendant tout ce temps, des workers qui ne partagent PLUS rien : un Stop émis
# par un worker neuf n'atteindrait pas un run porté par un ancien, la garde
# « une génération par chat » deviendrait aveugle de part et d'autre, et deux
# ordonnanceurs de routines se croiraient chacun seul leader. Le déplacement
# est donc un geste d'exploitant, fait à l'arrêt.
_RAW_ROOT = (env("ELPIS_RUNTIME_DIR") or "").strip()
RUNTIME_DIR = Path(_RAW_ROOT) if _RAW_ROOT else Path("/tmp")

_verified = False


def _own_and_private(path: Path) -> bool:
    """Le chemin nous appartient-il, sans droits pour les autres ?"""
    try:
        st = path.stat()
    except OSError:
        return False
    if st.st_uid != os.geteuid():
        return False
    return not (st.st_mode & 0o077)


def ensure_runtime_dir() -> bool:
    """Crée (ou valide) la racine. ``False`` = inutilisable, l'appelant se
    rabat sur son comportement dégradé habituel (garde per-worker)."""
    global _verified
    if _verified:
        return True
    if not _RAW_ROOT:
        # Pas de racine dédiée : chaque canal crée son propre dossier comme
        # il l'a toujours fait. Rien à valider ici, et surtout pas ``/tmp``
        # lui-même (qui appartient à root et est ouvert à tous, par nature).
        _verified = True
        return True
    try:
        RUNTIME_DIR.mkdir(parents=True, mode=0o700, exist_ok=True)
    except OSError as exc:
        logger.warning("[runtime_dir] %s inutilisable (%r)", RUNTIME_DIR, exc)
        return False
    try:
        os.chmod(RUNTIME_DIR, 0o700)
    except OSError:
        pass
    if not _own_and_private(RUNTIME_DIR):
        # Un répertoire préexistant qui appartient à quelqu'un d'autre (ou
        # ouvert en écriture) n'est PAS un endroit où poser des canaux de
        # contrôle : on le dit fort, une seule fois.
        logger.error(
            "[runtime_dir] %s n'appartient pas à cet utilisateur ou est "
            "accessible aux autres comptes — canaux inter-process DÉSACTIVÉS. "
            "Corrigez les droits, ou pointez ELPIS_RUNTIME_DIR ailleurs.",
            RUNTIME_DIR)
        return False
    _verified = True
    return True


def runtime_path(name: str, env_override: str = "",
                 legacy_default: str = "") -> Path:
    """Chemin d'un canal inter-process.

    Ordre de priorité, du plus explicite au plus ancien :
      1. la surcharge dédiée du canal (``ELPIS_CHAT_LOCK_DIR``…) — un
         déploiement qui la pose déjà ne doit rien voir changer ;
      2. la racine commune ``ELPIS_RUNTIME_DIR``, quand l'exploitant l'a posée ;
      3. le chemin historique du canal (cf. l'avertissement sur RUNTIME_DIR).
    """
    if env_override:
        override = (env(env_override) or "").strip()
        if override:
            return Path(override)
    if _RAW_ROOT:
        return RUNTIME_DIR / name
    return Path(legacy_default) if legacy_default else RUNTIME_DIR / name


def file_is_safe(path: Path) -> bool:
    """Le fichier peut-il servir de canal de contrôle ?

    Ce qui compte vraiment, c'est QUI PEUT ÉCRIRE : une ligne d'annulation
    déposée par un tiers tuerait la génération d'un utilisateur. On refuse
    donc un fichier qui appartient à un autre compte — cas irrécupérable —
    et on REPARE des droits trop larges quand le fichier est bien le nôtre
    (un chemin de création avec un umask permissif suffit à produire un 0644,
    ce qui n'est pas une attaque mais ne doit pas rester).

    Un fichier ABSENT est sûr : il sera créé en 0600.
    """
    try:
        st = path.stat()
    except FileNotFoundError:
        return True
    except OSError:
        return False
    if st.st_uid != os.geteuid():
        return False
    if st.st_mode & 0o077:
        try:
            os.chmod(path, 0o600)
        except OSError:
            return False
    return True
