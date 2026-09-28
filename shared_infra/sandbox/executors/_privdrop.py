# SPDX-License-Identifier: MIT
"""shared_infra/sandbox/executors/_privdrop.py — retrait de ``net_admin`` du bounding
set de CHAQUE ``docker exec``.

Le trou
-------
L'entrypoint de l'image sandbox bascule root → UID 10001 avec
``setpriv --bounding-set=-net_admin`` : la descendance de PID 1 ne peut donc
plus toucher au netfilter, et l'allowlist du profil réseau lui est
inviolable (audit CRIT-2).

Mais un process créé par ``docker exec`` **ne descend pas de PID 1** : Docker
le démarre avec le bounding set du CONTENEUR, lequel contient ``net_admin``
en mode ``allowlist_ip`` (``--cap-add NET_ADMIN``, indispensable pour que
l'entrypoint pose les règles au boot). Comme l'UID 10001 a ``sudo``
NOPASSWD, un ``sudo iptables -F OUTPUT`` lancé depuis n'importe quel exec —
donc depuis n'importe quel outil de l'agent, ou depuis le terminal — effaçait
l'allowlist. La protection CRIT-2 ne couvrait en réalité que PID 1.

Mesuré avant correctif (image 1.5.0, profil ``allowlist_ip``) ::

    CapBnd de PID 1              = 00000000a80425fb   (net_admin retiré)
    CapBnd d'un `docker exec`    = 00000000a80435fb   (net_admin PRÉSENT)
    sudo iptables -F OUTPUT      → rc=0, chaîne OUTPUT vidée

Le correctif
------------
On refait pour chaque exec ce que l'entrypoint fait pour PID 1 : l'exec entre
en **root** (``--user 0:0``) et ``setpriv`` retire ``net_admin`` du bounding
set AVANT de redescendre sur l'UID cible. Retirer une capability du bounding
set exige ``CAP_SETPCAP`` — que seul root détient — d'où l'entrée en root,
qui ne dure que le temps de l'``execve`` de setpriv : la commande de
l'appelant, elle, ne voit jamais root.

Après correctif, même scénario : ``sudo iptables -F OUTPUT`` → rc=4
(« Permission denied (you must be root) »), règles intactes.

Dégradation maîtrisée
---------------------
Une image tierce peut ne pas embarquer ``setpriv`` (util-linux), ou ne pas
connaître l'UID cible (``--init-groups`` échoue faute d'entrée passwd). On
**sonde** donc la chaîne complète une fois par (conteneur, exec_user) ; si
elle échoue on retombe EXACTEMENT sur la forme historique
(``--user <exec_user>``, sans retrait) plutôt que de casser l'exec. Ce repli
n'est pas une régression : une image qui n'a pas ``setpriv`` n'a pas non plus
l'entrypoint Elpis, donc elle ne filtrait déjà rien.

⚠ Le cache est PAR PROCESSUS (chaque worker gunicorn sonde une fois) et doit
être purgé quand le conteneur disparaît — sinon un verdict porte sur un
conteneur mort et s'appliquerait à son remplaçant, potentiellement bâti sur
une autre image. ``UserSandbox.stop()`` / ``.destroy()`` appellent ``forget``.
"""
from __future__ import annotations

import logging
import re

logger = logging.getLogger("uvicorn.error")

# "uid:gid" — numérique ou nom d'utilisateur/groupe. Tout le reste est refusé :
# on ne bâtit pas d'argv setpriv à partir d'une valeur de config inattendue.
_EXEC_USER_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]*:[A-Za-z0-9_][A-Za-z0-9_.-]*$")

# {(container_name, exec_user): la chaîne root+setpriv fonctionne-t-elle ?}
_PROBED: dict[tuple[str, str], bool] = {}


def privdrop_argv(exec_user: str) -> list[str] | None:
    """Préfixe ``setpriv`` à insérer devant la commande, ou ``None`` si
    ``exec_user`` n'a pas la forme attendue (on n'applique alors rien).

    Mêmes options que l'entrypoint de l'image, à dessein : ``setpriv``
    (util-linux) attend les noms de capability SANS le préfixe ``cap_``
    (``net_admin``, pas ``cap_net_admin`` — ce dernier donne « unknown
    capability »).
    """
    if not exec_user or not _EXEC_USER_RE.match(exec_user):
        return None
    uid, gid = exec_user.split(":", 1)
    return ["setpriv", f"--reuid={uid}", f"--regid={gid}",
            "--init-groups", "--bounding-set=-net_admin", "--"]


def probe_argv(container_name: str, exec_user: str) -> list[str] | None:
    """argv ``docker`` (binaire exclu) de la sonde : la chaîne complète
    est-elle exécutable dans CE conteneur ? ``true`` est un builtin
    coreutils présent partout où ``setpriv`` l'est."""
    prefix = privdrop_argv(exec_user)
    if prefix is None:
        return None
    return ["exec", "--user", "0:0", container_name, *prefix, "true"]


def cached(container_name: str, exec_user: str) -> bool | None:
    """Verdict déjà connu, ou ``None`` s'il faut sonder."""
    return _PROBED.get((container_name, exec_user))


def remember(container_name: str, exec_user: str, ok: bool) -> None:
    _PROBED[(container_name, exec_user)] = ok
    if not ok:
        logger.warning(
            "[sandbox] privdrop indisponible sur %s (exec_user=%s) : "
            "`setpriv --bounding-set=-net_admin` a échoué — exec en mode "
            "historique, net_admin reste dans le bounding set des exec.",
            container_name, exec_user,
        )


def forget(container_name: str) -> None:
    """Purge le verdict d'un conteneur (stop/destroy) : le suivant portera
    peut-être une autre image."""
    for key in [k for k in _PROBED if k[0] == container_name]:
        _PROBED.pop(key, None)


def resolve(container_name: str, exec_user: str) -> tuple[str, list[str]]:
    """(``--user`` à passer à docker, préfixe argv) d'après le cache SEUL.

    Ne sonde pas : l'appelant possède le transport (async pour
    ``UserSandbox``, ``subprocess`` pour le PTY) et alimente le cache via
    ``remember``. Tant que le verdict est inconnu on rend la forme
    historique — au pire un exec passe sans le retrait, jamais l'inverse.
    """
    prefix = privdrop_argv(exec_user)
    if prefix is not None and cached(container_name, exec_user):
        return "0:0", prefix
    return exec_user, []
