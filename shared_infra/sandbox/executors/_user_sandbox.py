# SPDX-License-Identifier: MIT
"""
agentic/executors/_user_sandbox.py — Conteneur Docker persistant par user.

DOCKER LOCAL UNIQUEMENT — pas de TLS, pas de host distant.

Architecture
------------
Chaque utilisateur peut activer le mode "sandbox docker" depuis ses
paramètres. À l'activation, un container Docker persistant est créé pour
lui (``elpis-sb-<username>``). Le sandbox folder de l'user
(``/home/elpis/sandbox/<username>``) est monté en volume sur ``/work``.

Toutes les exécutions (tools MCP, nodes du pipeline) passent ensuite par
``docker exec`` dans ce container.

Lifecycle
---------
- ``ensure_running()`` : vérifie / crée / redémarre au besoin.
- ``exec(cmd, ...)`` : exécute une commande dans le container.
- ``stop()`` / ``destroy()`` : actions explicites de l'user ou du gc.

Sécurité (modèle 1.2.0 — « permissif mais cloisonné »)
------------------------------------------------------
Le container démarre avec (``_build_run_args``, seule référence à jour) :
  --security-opt no-new-privileges:false   (voulu : sudo doit marcher)
  capacités par défaut de Docker moins MKNOD (--cap-drop MKNOD ; ni SYS_ADMIN
  ni NET_ADMIN ; NET_ADMIN est AJOUTÉ en profil « liste blanche IP » pour que
  l'entrypoint pose iptables, puis retiré du bounding set : setpriv pour
  PID 1, ``_privdrop`` pour chaque ``docker exec``)
  --network none (sauf profil)  --memory --cpus --pids-limit
  -v <sandbox>:/work:rw
Pas de ``--user`` : l'entrypoint démarre en root (chown de /work, règles
réseau) puis descend en 10001:10001 par setpriv ; les ``docker exec``
tournent sous ``exec_user``.

À l'INTÉRIEUR de son container l'user a les pleins pouvoirs : sudo
NOPASSWD, filesystem inscriptible, toolchain de build, apt/pip. C'est
volontaire — un container par user est jetable et cloisonné.

Ce qui protège l'HÔTE et les AUTRES users reste en place :
  - pas de /var/run/docker.sock monté  → pas d'évasion DinD
  - seccomp + AppArmor par défaut de Docker actifs
  - pas de SYS_ADMIN ni des autres capabilities hors défaut Docker
  - 1 container isolé par user, volume /work cloisonné
  - réseau coupé par défaut (profil réseau explicite requis)
  - limites mémoire / CPU / PIDs
Pas de remappage d'UID (userns) : root dans le container est l'UID 0 pour
les fichiers du montage /work. Durcissement disponible sans changer ce
modèle : un runtime OCI dédié (gVisor, ``executors.runtime``).

Donc le LLM peut faire ce qu'il veut DANS le container, sans pour
autant pouvoir toucher l'hôte ou un autre user.

Configuration ``config.json`` :

::

    {
      "executors": {
        "image": "elpis/sandbox:1.6.0",
        "limits": {
          "memory_mb": 2048, "cpu_quota_pct": 100,
          "pids_max": 512,   "timeout_s": 600
        },
        "exec_user": "10001:10001",
        "force_user_docker": false,
        "idle_kill_hours":   24
      }
    }

``exec_user`` : UID:GID des ``docker exec``. Défaut ``10001:10001``
(l'user a sudo pour repasser root au besoin). Mettre ``"0:0"`` fait
tourner directement chaque commande en root dans le container — pratique
si le LLM oublie de préfixer ``sudo``.
"""
from __future__ import annotations

import asyncio
import json
import os
import logging
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from shared_infra.sandbox.executors._base import (
    ExecError, ExecResult, kill_process_group,
)
from shared_infra.sandbox.executors._readiness import get_readiness_cache
from shared_infra.sandbox import naming as _naming
from shared_infra.sandbox.executors import _privdrop

logger = logging.getLogger("uvicorn.error")

# Plafond de la sortie GARDÉE en mémoire, par flux (stdout, stderr) d'un exec.
# Au-delà, la tête et la queue sont conservées (moitié chacune) et le milieu
# est compté puis signalé (AUDIT 2026-09-25).
try:
    import os as _os
    _EXEC_CAPTURE_MAX_BYTES = max(64 * 1024, int(
        _os.environ.get("SANDBOX_EXEC_CAPTURE_MAX_BYTES", str(32 * 1024 * 1024))))
except (TypeError, ValueError):
    _EXEC_CAPTURE_MAX_BYTES = 32 * 1024 * 1024


class _BoundedCapture:
    """Tampon de sortie BORNÉ : tête + queue, milieu écarté et compté.

    La queue est une file de paquets (retrait en O(1) par la gauche) : un
    ``bytearray`` qu'on raboterait par ``del buf[:n]`` recopierait toute la
    queue à chaque paquet, soit un coût quadratique sur une sortie massive."""

    __slots__ = ("_half", "_head", "_tail", "_tail_size", "dropped")

    def __init__(self, cap: int) -> None:
        from collections import deque
        self._half = max(1, int(cap) // 2)
        self._head = bytearray()
        self._tail = deque()
        self._tail_size = 0
        self.dropped = 0

    def add(self, data: bytes) -> None:
        room = self._half - len(self._head)
        if room > 0:
            self._head += data[:room]
            data = data[room:]
        if not data:
            return
        self._tail.append(data)
        self._tail_size += len(data)
        while self._tail and self._tail_size - len(self._tail[0]) >= self._half:
            x = self._tail.popleft()
            self._tail_size -= len(x)
            self.dropped += len(x)

    def value(self) -> bytes:
        tail = b"".join(self._tail)
        if not self.dropped:
            return bytes(self._head) + tail
        marker = (f"\n…[{self.dropped} bytes omitted: output exceeded the "
                  f"{2 * self._half} bytes capture limit]…\n").encode()
        return bytes(self._head) + marker + tail

# Host-side marker (at the per-user dir ``P``, sibling of ``P/work`` — outside
# the mount, invisible to the model) recording that the one-time other-writable
# repair of pre-existing /work paths has run. Lets the costly ``chmod -R`` run
# once per sandbox instead of on every backend restart.
# Nouveau nom ⇒ la passe one-shot re-tourne une fois par sandbox existante.
#   v2 (2026-07-21) : clones faits dans le terminal AVANT son wrapper umask
#                     0000 (arbres 0644/0755 en UID 10001, host non-writables).
#   v3 (2026-07-30) : clones/init/pull host-side pendant que
#                     ``sandbox_grant_access`` était inerte (mauvaise arité →
#                     TypeError avalé) — arbres 0644/0755 à l'UID de l'app,
#                     cette fois NON éditables depuis le conteneur. Le même
#                     ``chmod -R o+rwX`` répare les deux sens.
# ⚠ Doit rester synchronisé avec ``shared_infra.sandbox.paths._PERMS_MARKER``.
_PERMS_MARKER = ".perms-reconciled-v3"


# ── Sérialisation du cycle de vie container, par user ────────────────────────
# Sans verrou, deux exec() concurrents pour le MÊME user voyaient tous deux
# « container absent » et lançaient deux ``docker run --name`` → « name already
# in use », ou le ``rm`` de l'un détruisait le container que l'autre venait de
# créer (audit CRIT-4). On sérialise donc create/start/stop/destroy par user.
#
# Subtilité event-loop : le bridge sync→async (tools/_exec_bridge._run_async)
# peut exécuter chaque appel sur une boucle asyncio ÉPHÉMÈRE différente. Un
# asyncio.Lock est lié à sa boucle de création → l'utiliser depuis une autre
# boucle lève « got Future attached to a different loop ». On clé donc le verrou
# par (user_id, id(loop)) : chaque boucle a son propre verrou. La sérialisation
# inter-boucles résiduelle est couverte par l'idempotence de ``_create`` (qui
# tolère « name already in use »). Combinés, plus aucune course destructrice.
#
# Passe sandbox 2026-09-26 — deux défauts de la clé ``(user_id, id(loop))`` :
#   • chaque boucle éphémère du pont ajoutait une entrée JAMAIS retirée
#     (croissance sans borne), et un ``id()`` réutilisé par une boucle neuve
#     retombait sur un verrou lié à une boucle morte (« attached to a
#     different loop ») ;
#   • rien ne sérialisait create / rm ENTRE workers : deux workers qui
#     détectaient la même dérive (montage, profil réseau) faisaient chacun
#     ``rm -fv`` + ``_create``, le second détruisant le container tout neuf
#     du premier.
# Les verrous sont donc rangés par boucle dans une WeakKeyDictionary (libérés
# avec la boucle), et doublés d'un ``flock`` PAR COMPTE, partagé par tous les
# process. Le flock est pris en thread, borné (fail-open au-delà : la
# sérialisation reste un confort, l'idempotence de ``_create`` demeure).
import weakref as _weakref

_lifecycle_locks: "_weakref.WeakKeyDictionary" = _weakref.WeakKeyDictionary()
_LIFECYCLE_FLOCK_WAIT_S = 120.0


def _loop_lock(user_id: int) -> asyncio.Lock:
    loop = asyncio.get_running_loop()
    per_loop = _lifecycle_locks.get(loop)
    if per_loop is None:
        per_loop = {}
        _lifecycle_locks[loop] = per_loop
    lk = per_loop.get(user_id)
    if lk is None:
        lk = asyncio.Lock()
        per_loop[user_id] = lk
    return lk


def _lifecycle_flock_acquire(user_id: int) -> Optional[int]:
    """fd du flock inter-process du compte, ou ``None`` (indisponible ou
    délai dépassé : fail-open)."""
    import fcntl
    try:
        from shared_infra.config import SANDBOX_DIR
        d = Path(SANDBOX_DIR) / ".lifecycle_locks"
        d.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(str(d / f"u{int(user_id)}.lock"), os.O_RDWR | os.O_CREAT, 0o600)
    except OSError:
        return None
    deadline = time.monotonic() + _LIFECYCLE_FLOCK_WAIT_S
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return fd
        except OSError:
            if time.monotonic() >= deadline:
                os.close(fd)
                logger.warning("[sandbox] verrou de cycle de vie inter-process "
                               "non obtenu (user_id=%s) — on continue", user_id)
                return None
            time.sleep(0.05)


def _lifecycle_flock_release(fd: Optional[int]) -> None:
    if fd is None:
        return
    try:
        os.close(fd)                     # fermer relâche le flock
    except OSError:
        pass


class _LifecycleGuard:
    """``async with _lifecycle_lock(uid)`` : verrou de boucle PUIS flock."""

    def __init__(self, user_id: int) -> None:
        self.user_id = user_id
        self._lk: Optional[asyncio.Lock] = None
        self._fd: Optional[int] = None

    async def __aenter__(self):
        self._lk = _loop_lock(self.user_id)
        await self._lk.acquire()
        task = asyncio.ensure_future(
            asyncio.to_thread(_lifecycle_flock_acquire, self.user_id))
        try:
            self._fd = await asyncio.shield(task)
        except BaseException:
            # Annulé pendant l'attente : le thread peut encore OBTENIR le
            # flock — on le rendra dès qu'il aboutit, sinon il resterait tenu
            # jusqu'à la mort du process.
            task.add_done_callback(
                lambda t: (not t.cancelled() and t.exception() is None
                           and _lifecycle_flock_release(t.result())))
            self._lk.release()
            raise
        return self

    async def __aexit__(self, *exc):
        _lifecycle_flock_release(self._fd)
        self._fd = None
        if self._lk is not None:
            self._lk.release()
        return False


def _lifecycle_lock(user_id: int) -> _LifecycleGuard:
    """Verrou de cycle de vie pour ce user : boucle courante + inter-process."""
    return _LifecycleGuard(user_id)


@dataclass
class NetworkProfile:
    """Profil réseau nommé, configurable par l'admin et choisi par l'user."""
    id:          str            # ex "isolated", "lan_prod", "web_test"
    name:        str            # ex "Isolé", "LAN Production"
    mode:        str            # "none" | "bridge" | "allowlist_ip"
    ips:         list           # ["10.1.2.3", "10.0.0.0/24"]
    description: str = ""
    # ── Réglage fin (allowlist_ip uniquement, tous optionnels) ──────────
    # domains : FQDN résolus côté HÔTE à la création du conteneur (A records
    #   IPv4) — les IPs résolues rejoignent l'allowlist et le domaine est
    #   épinglé via --add-host (pas besoin d'ouvrir le DNS, et l'épinglage
    #   neutralise le rebinding). ports : restriction TCP appliquée par
    #   l'entrypoint (vide = tous ports — image < 1.6.0 : ignoré, dégradation
    #   vers toutes-portes). dns : résolveurs explicites (--dns + port 53).
    domains:     list = None    # ["github.com", "pypi.org"]
    ports:       list = None    # [443, 80]
    dns:         list = None    # ["10.0.0.1"]

    def to_dict(self) -> dict:
        return {
            "id": self.id, "name": self.name, "mode": self.mode,
            "ips": list(self.ips or []), "description": self.description,
            "domains": list(self.domains or []),
            "ports": [int(p) for p in (self.ports or [])],
            "dns": list(self.dns or []),
        }

    @classmethod
    def from_dict(cls, d: dict) -> "NetworkProfile":
        def _ints(xs):
            out = []
            for x in xs or []:
                try:
                    out.append(int(x))
                except (TypeError, ValueError):
                    continue
            return out
        return cls(
            id=str(d.get("id", "") or "").strip()[:32],
            name=str(d.get("name", "") or "").strip()[:60],
            mode=d.get("mode", "none") if d.get("mode") in ("none", "bridge", "allowlist_ip") else "none",
            ips=[str(x).strip() for x in (d.get("ips") or []) if str(x).strip()],
            description=str(d.get("description", "") or "")[:200],
            domains=[str(x).strip().lower().rstrip(".")
                     for x in (d.get("domains") or []) if str(x).strip()],
            ports=_ints(d.get("ports")),
            dns=[str(x).strip() for x in (d.get("dns") or []) if str(x).strip()],
        )


def netcfg_hash(profile: "NetworkProfile") -> str:
    """Empreinte STABLE (12 hex) de la config réseau d'un profil.

    Posée en label ``elpis.netcfg`` à la création du conteneur ;
    ``ensure_running`` compare et recrée au premier exec quand l'admin a
    modifié le profil depuis (dérive). Le hash porte la CONFIG, pas les IPs
    résolues des domaines — une rotation DNS ne déclenche pas de recréation.
    """
    import hashlib
    payload = json.dumps({
        "mode": profile.mode,
        "ips": sorted(profile.ips or []),
        "domains": sorted(profile.domains or []),
        "ports": sorted(int(p) for p in (profile.ports or [])),
        "dns": sorted(profile.dns or []),
    }, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]


def resolve_profile_domains(profile: "NetworkProfile") -> Dict[str, list]:
    """Résout les ``domains`` du profil en IPv4 — {domaine: [ips triées]}.

    Appelée au moment de la CRÉATION du conteneur (via to_thread), PAS dans
    ``_build_run_args`` qui doit rester pur/testable. Best-effort : un domaine
    irrésoluble est ignoré avec warning — le conteneur démarre avec le reste
    de l'allowlist plutôt que d'échouer en boucle.
    """
    import socket
    resolved: Dict[str, list] = {}
    for dom in (profile.domains or []):
        try:
            infos = socket.getaddrinfo(dom, None, family=socket.AF_INET,
                                       type=socket.SOCK_STREAM)
            ips = sorted({i[4][0] for i in infos})
            if ips:
                resolved[dom] = ips
        except OSError as e:
            logger.warning("[sandbox] profil %s : domaine %r irrésoluble (%s) — ignoré",
                           profile.id, dom, e)
    return resolved


def _default_profiles() -> list:
    """Profils par défaut si admin n'a rien customisé."""
    return [
        NetworkProfile(
            id="isolated", name="Isolé total", mode="none", ips=[],
            description="Aucun accès réseau. Sécurité maximale.",
        ),
    ]


# ── Profil EFFECTIF d'un user ────────────────────────────────────────────
# Deux clés dans ``user_settings`` :
#   * ``network_profile_id``        — le choix de l'utilisateur ;
#   * ``forced_network_profile_id`` — l'imposition de l'admin (2026-08-05).
# L'imposition PRIME toujours et le choix est verrouillé côté UI + API. Tout
# code qui construit un ``UserSandbox`` DOIT passer par ce résolveur : lire
# ``network_profile_id`` en direct laisserait un utilisateur déjà positionné
# sur un profil ouvert continuer d'y tourner malgré l'imposition.

def resolve_network_profile_id(settings: Optional[Dict[str, Any]]) -> str:
    """Profil effectif à partir d'un dict de settings user."""
    s = settings or {}
    forced = str(s.get("forced_network_profile_id") or "").strip()
    return forced or str(s.get("network_profile_id") or "").strip() or "isolated"


def user_network_profile_id(user_id: int) -> str:
    """Profil effectif d'un user (enveloppe d'identité, sinon lecture DB).
    Fail-closed sur ``isolated``."""
    try:
        from shared_infra.accounts.identity import resolve_network_profile_id as _ident_np
        _np = _ident_np(user_id)
        if _np:
            return _np
    except Exception:                                           # noqa: BLE001
        pass
    try:
        from shared_infra.accounts.users import get_user_settings
        return resolve_network_profile_id(get_user_settings(int(user_id)) or {})
    except Exception:                                           # noqa: BLE001
        return "isolated"


@dataclass
class SandboxAdminConfig:
    image:     str = "elpis/sandbox:1.6.0"
    memory_mb: int = 2048
    cpu_quota_pct: int = 100
    pids_max:  int = 512
    timeout_s: int = 600
    force_user_docker: bool = False
    idle_kill_hours: int = 24

    # UID:GID utilisé par les `docker exec`. "10001:10001" = user normal
    # (avec sudo NOPASSWD dans l'image). "0:0" = root direct.
    exec_user: str = "10001:10001"

    # Profils réseau définis par l'admin, choisis par l'user
    network_profiles: list = None  # list[NetworkProfile]

    # ── Durcissement opt-in (Step 6 — défaut OFF = statu quo) ───────────
    # runtime : runtime OCI alternatif (ex "runsc" pour gVisor, "kata-runtime")
    #   qui isole les syscalls au niveau hôte SANS retirer le modèle
    #   "permissif dans le container". Vide = runtime Docker par défaut.
    # extra_run_args : flags `docker run` supplémentaires fournis par l'admin
    #   (passthrough avancé). Liste vide par défaut.
    runtime: str = ""
    extra_run_args: list = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any] | None) -> "SandboxAdminConfig":
        d = d or {}
        limits = d.get("limits") or {}

        # Parse profils
        raw_profiles = d.get("network_profiles") or []
        profiles = [NetworkProfile.from_dict(p) for p in raw_profiles
                    if isinstance(p, dict) and p.get("id") and p.get("name")]

        # Migration legacy : si on trouve l'ancien network_mode + network_allowlist
        # mais pas de profils, on reconstruit un profil legacy
        if not profiles and (d.get("network_mode") or d.get("network_allowlist")):
            profiles = [NetworkProfile(
                id="legacy",
                name="Profil migré (legacy)",
                mode=d.get("network_mode", "none"),
                ips=list(d.get("network_allowlist") or []),
                description="Migré automatiquement depuis l'ancienne config.",
            )]

        # Garantir au moins un profil "isolated"
        if not profiles:
            profiles = _default_profiles()
        elif not any(p.id == "isolated" for p in profiles):
            profiles.insert(0, _default_profiles()[0])

        return cls(
            image=str(d.get("image") or "").strip() or "elpis/sandbox:1.6.0",
            memory_mb=int(limits.get("memory_mb", 2048)),
            cpu_quota_pct=int(limits.get("cpu_quota_pct", 100)),
            pids_max=int(limits.get("pids_max", 512)),
            timeout_s=int(limits.get("timeout_s", 600)),
            exec_user=str(d.get("exec_user") or "10001:10001").strip(),
            force_user_docker=bool(d.get("force_user_docker", False)),
            idle_kill_hours=int(d.get("idle_kill_hours", 24)),
            network_profiles=profiles,
            runtime=str(d.get("runtime") or "").strip(),
            extra_run_args=[str(x) for x in (d.get("extra_run_args") or []) if str(x).strip()],
        )

    def get_profile(self, profile_id: str) -> "NetworkProfile":
        """Retourne le profil correspondant, ou le profil 'isolated' par défaut."""
        for p in self.network_profiles or []:
            if p.id == profile_id:
                return p
        # Fallback : premier profil ou isolated
        if self.network_profiles:
            return self.network_profiles[0]
        return _default_profiles()[0]


def load_admin_config() -> SandboxAdminConfig:
    from shared_infra.config import read_config_json
    raw = read_config_json() or {}
    return SandboxAdminConfig.from_dict(raw.get("executors") or {})


# ─── Wrapper Docker CLI (local uniquement) ───────────────────────────────

class _DockerCLI:
    def __init__(self) -> None:
        self._bin = shutil.which("docker") or "/usr/bin/docker"

    @property
    def bin(self) -> str:
        return self._bin

    async def call(self, *args: str,
                   stdin_bytes: bytes | None = None,
                   timeout: int = 30) -> tuple[int, bytes, bytes]:
        proc = await asyncio.create_subprocess_exec(
            self._bin, *args,
            stdin=asyncio.subprocess.PIPE if stdin_bytes is not None else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            out, err = await asyncio.wait_for(
                proc.communicate(input=stdin_bytes), timeout=timeout
            )
        except asyncio.TimeoutError:
            await kill_process_group(proc)
            return 124, b"", b"docker call timeout"
        except BaseException:
            # Passe sandbox 2026-09-26 — ANNULATION (client parti, wait_for
            # d'un appelant) : le ``docker run`` / ``docker load`` / ``inspect``
            # continuait en orphelin, jamais récolté. Même traitement que le
            # dépassement de délai, puis on propage.
            await asyncio.shield(kill_process_group(proc))
            raise
        return proc.returncode or 0, out, err


@dataclass
class SandboxStatus:
    exists: bool
    running: bool
    container_id: Optional[str] = None
    container_name: Optional[str] = None
    image: Optional[str] = None
    started_at: Optional[str] = None
    error: Optional[str] = None


class UserSandbox:
    """Container persistant pour un user (1 instance par user)."""

    def __init__(self, user_id: int, username: str,
                 sandbox_path: Path,
                 cfg: Optional[SandboxAdminConfig] = None,
                 network_profile_id: Optional[str] = None) -> None:
        self.user_id = user_id
        # Source unique partagée (backend.config) : MÊME sanitization que le
        # dossier sandbox monté sur /work et que l'arbo du front. L'ancien
        # « remplacer par - + tronquer 32 » divergeait du dossier (delete) et
        # confondait Jean.Dupont / Jean-Dupont sur le même container → montage
        # croisé entre users (audit MAJ-10). On garde [A-Za-z0-9_-] tel quel.
        from shared_infra.config import safe_sandbox_name
        self.username = safe_sandbox_name(username)
        self.sandbox_path = sandbox_path
        self.cfg = cfg or load_admin_config()
        self.network_profile_id = network_profile_id  # peut être None
        self._cli = _DockerCLI()
        # One-shot guard (per container, per process): reconcile the /work
        # mount the first time we see this container running, to recreate any
        # container that predates the work-subdir migration (old flat mount).
        self._mount_verified = False
        # One-shot guard (per process): make every PRE-EXISTING path under
        # /work other-writable so the host UID can mutate files/dirs the
        # container created before umask 0000 (legacy 0775 dirs blocked the
        # host fs tools). New writes are already cross-writable via umask 0000;
        # this only repairs the backlog. Persisted across restarts by a host-
        # side marker (``_PERMS_MARKER``) so the costly ``chmod -R`` runs once.
        self._perms_reconciled = False
        # One-shot guard (per container, per process): compare the container's
        # ``elpis.netcfg`` label to the CURRENT profile hash and recreate on
        # mismatch — sans ça, une édition admin du profil (IPs, domaines,
        # ports, DNS) laissait les conteneurs en marche sur les vieilles
        # règles iptables indéfiniment.
        self._netcfg_verified = False

    @property
    def container_name(self) -> str:
        return _naming.container_name(self.username)

    @property
    def network_profile(self) -> NetworkProfile:
        """Le profil réseau actif pour ce user (résolu à chaque accès)."""
        return self.cfg.get_profile(self.network_profile_id or "isolated")

    # ── Status ────────────────────────────────────────────────────────────

    async def _inspect_status(self):
        return await self._cli.call(
            "container", "inspect", self.container_name,
            "--format",
            '{{.Id}}|{{.Name}}|{{.State.Running}}|{{.Config.Image}}|{{.State.StartedAt}}',
            timeout=10,
        )

    async def status(self) -> SandboxStatus:
        rc, out, _ = await self._inspect_status()
        if rc != 0:
            return SandboxStatus(exists=False, running=False,
                                 container_name=self.container_name)
        line = out.decode("utf-8", errors="replace").strip()
        if not line:
            return SandboxStatus(exists=False, running=False,
                                 container_name=self.container_name)
        cid, name, running, image, started = (line.split("|") + [""] * 5)[:5]
        return SandboxStatus(
            exists=True,
            running=(running.lower() == "true"),
            container_id=cid,
            container_name=name.lstrip("/"),
            image=image,
            started_at=started or None,
        )

    async def container_ip(self) -> Optional[str]:
        """IP du conteneur sur son réseau Docker (aperçu localhost).

        None si le conteneur n'existe pas, n'est pas démarré, ou n'a aucune
        IP — cas nominal du profil réseau ``none`` (isolated) : seul ``lo``
        existe, l'hôte ne peut pas le joindre en TCP. En ``bridge`` /
        ``allowlist_ip``, IP 172.17.x.x joignable depuis l'hôte (l'iptables
        de l'entrypoint ne filtre que la chaîne OUTPUT — l'entrant passe).
        """
        rc, out, _ = await self._cli.call(
            "container", "inspect", self.container_name,
            "--format",
            '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}',
            timeout=10,
        )
        if rc != 0:
            return None
        for tok in out.decode("utf-8", errors="replace").split():
            tok = tok.strip()
            if tok:
                return tok
        return None

    async def _work_mount_matches(self) -> bool:
        """True if the running container binds ``self.sandbox_path`` at /work.

        Fail-open: if the source can't be determined (inspect fails, container
        gone, no /work mount), return True so we never disrupt a working
        container on uncertainty. Used once to detect a pre-migration container
        whose /work still binds the old flat per-user dir."""
        rc, out, _ = await self._cli.call(
            "inspect", "--format",
            '{{range .Mounts}}{{if eq .Destination "/work"}}{{.Source}}{{end}}{{end}}',
            self.container_name, timeout=5,
        )
        if rc != 0:
            return True
        src = out.decode("utf-8", errors="replace").strip()
        if not src:
            return True
        try:
            return Path(src).resolve() == Path(self.sandbox_path).resolve()
        except OSError:                                   # pragma: no cover
            return True

    async def _reconcile_work_mount(self, st: SandboxStatus) -> SandboxStatus:
        """Recreate the container if its /work mount source no longer matches
        ``self.sandbox_path`` (it predates the work-subdir migration). Attempted
        at most once per container per process; fail-open on any uncertainty."""
        self._mount_verified = True            # attempt once, whatever the outcome
        if await self._work_mount_matches():
            return st
        logger.info("[sandbox] %s : /work montait l'ancienne arbo plate → "
                    "recréation sur %s", self.container_name, self.sandbox_path)
        async with _lifecycle_lock(self.user_id):
            # Re-check under the lock: a peer worker may have recreated already.
            cur = await self.status()
            if cur.running and not await self._work_mount_matches():
                await self._cli.call("rm", "-fv", self.container_name, timeout=10)
                await self._create()
            return await self.status()

    async def _netcfg_matches(self) -> bool:
        """True si le label ``elpis.netcfg`` du conteneur correspond au hash
        du profil ACTUEL. Fail-open sur toute incertitude (inspect KO).

        Label absent (conteneur d'avant la fonctionnalité) : recréation
        seulement si le profil courant est ``allowlist_ip`` — c'est le cas
        sécurité (règles potentiellement périmées) ; none/bridge n'ont pas
        de règles à dériver."""
        profile = self.network_profile
        rc, out, _ = await self._cli.call(
            "inspect", "--format", _naming.label_tpl("netcfg"),
            self.container_name, timeout=5,
        )
        if rc != 0:
            return True
        cur = out.decode("utf-8", errors="replace").strip()
        if not cur or cur == "<no value>":
            return profile.mode != "allowlist_ip"
        return cur == netcfg_hash(profile)

    async def _reconcile_network(self, st: SandboxStatus) -> SandboxStatus:
        """Recrée le conteneur si sa config réseau a dérivé du profil courant
        (l'admin a édité le profil après création). Une tentative par
        conteneur et par process ; fail-open sur incertitude — même contrat
        que ``_reconcile_work_mount``."""
        self._netcfg_verified = True           # attempt once, whatever the outcome
        if await self._netcfg_matches():
            return st
        logger.info("[sandbox] %s : config réseau dérivée du profil %r → recréation",
                    self.container_name, self.network_profile_id or "isolated")
        async with _lifecycle_lock(self.user_id):
            cur = await self.status()
            if cur.running and not await self._netcfg_matches():
                await self._cli.call("rm", "-fv", self.container_name, timeout=10)
                await self._create()
            return await self.status()

    async def _reconcile_work_perms(self) -> None:
        """One-time repair so the HOST UID can mutate everything under /work.

        Host (operator UID, e.g. 1000) and the container (UID 10001) share no
        group, so a container-created dir at the default 0775 (group-writable)
        is NOT writable by the host — the host fs tools then fail to create a
        file inside a directory the shell just made. ``umask 0000`` already
        fixes this for NEW writes; this repairs the pre-existing backlog by
        making every current path other-writable (``chmod -R o+rwX`` — ``X``
        only adds +x to dirs / already-exec files, so data files don't become
        executable). Run as container root (``-u 0:0``) because the host can't
        chmod paths it doesn't own, and ``setfacl`` is absent from the image.

        Best-effort, never raises. Gated by an in-memory per-process flag AND a
        host-side marker (``_PERMS_MARKER``) so the ``chmod -R`` runs once per
        sandbox; a transient failure leaves the marker unwritten so the next
        process retries.
        """
        if self._perms_reconciled:
            return
        self._perms_reconciled = True          # attempt once per process, whatever the outcome
        marker: Optional[Path] = None
        try:
            marker = Path(self.sandbox_path).parent / _PERMS_MARKER
            if marker.exists():
                return
        except Exception:
            marker = None
        try:
            rc, _, err = await self._cli.call(
                "exec", "-u", "0:0", self.container_name,
                "sh", "-c", "chmod -R o+rwX /work 2>/dev/null || true",
                timeout=120,
            )
            if rc == 0 and marker is not None:
                try:
                    marker.write_text("1", encoding="utf-8")
                except OSError:
                    pass
            elif rc != 0:
                logger.warning("[sandbox] reconcile work perms rc=%s (%s): %s",
                               rc, self.container_name,
                               err.decode("utf-8", "replace")[:200] if err else "")
        except asyncio.CancelledError:
            # Tentative INTERROMPUE (pas un échec) : la garde une-fois ne doit
            # pas empêcher ce process de retenter plus tard.
            self._perms_reconciled = False
            raise
        except Exception as e:                                  # pragma: no cover
            logger.warning("[sandbox] reconcile work perms KO (%s): %s",
                           self.container_name, e)

    async def daemon_reachable(self) -> tuple[bool, str]:
        rc, out, err = await self._cli.call(
            "version", "--format", "{{.Server.Version}}", timeout=5
        )
        if rc == 0:
            return True, out.decode().strip()
        return False, err.decode("utf-8", errors="replace").strip().split("\n")[0]

    # ── Lifecycle ─────────────────────────────────────────────────────────

    async def ensure_running(self) -> SandboxStatus:
        # Hottest path: a FRESH, AUTHORITATIVE "running" signal from the
        # readiness cache (fed by `docker events`) lets us skip the per-exec
        # `docker container inspect`. The cache confirms "running" only while
        # the events stream is healthy, so on ANY uncertainty we fall through
        # to the real status() below — identical behavior to pre-cache. The
        # synthetic status carries no container_id (cosmetic in ExecResult).
        cache = get_readiness_cache()
        # Gate the warm-cache shortcut on _mount_verified: a container started
        # before the work-subdir migration can be marked "running" by a docker
        # `start` event WITHOUT ever passing through _reconcile_work_mount, so
        # the shortcut could serve the stale flat mount indefinitely. Until we've
        # verified the /work mount once (per process), fall through to status()
        # + reconcile. After that, the hot path is unchanged.
        if (self._mount_verified and self._netcfg_verified
                and cache.confirmed_running(self.container_name)):
            return SandboxStatus(exists=True, running=True,
                                 container_name=self.container_name)

        # Fast path hors verrou : si déjà running, rien à sérialiser (le cas
        # ultra-majoritaire — on ne paie pas le coût du lock à chaque exec).
        st = await self.status()
        if st.running:
            # Reconciliation une-fois du mont /work : un container créé AVANT la
            # migration work-subdir bind toujours l'ancienne arbo plate ``P`` sur
            # /work (ses fichiers vivent désormais sous ``P/work``). On le détecte
            # une seule fois par container/process et on recrée avec le bon mont.
            if not self._mount_verified:
                st = await self._reconcile_work_mount(st)
            # Dérive réseau : même modèle une-fois que le mont /work (l'admin
            # a pu éditer le profil pendant que le conteneur tournait).
            if st.running and not self._netcfg_verified:
                st = await self._reconcile_network(st)
            if st.running:
                await self._reconcile_work_perms()
                cache.record_running(self.container_name)
            return st

        # Slow path SÉRIALISÉ par user : create/start/recreate. Empêche deux
        # exec() concurrents de lancer deux ``docker run`` rivaux (CRIT-4).
        async with _lifecycle_lock(self.user_id):
            # Re-check sous verrou : une coroutine concurrente a pu créer le
            # container pendant qu'on attendait le verrou.
            st = await self.status()
            if st.running:
                await self._reconcile_work_perms()
                cache.record_running(self.container_name)
                return st
            res = await self._ensure_running_locked(st)
            if res.running:
                await self._reconcile_work_perms()
                cache.record_running(self.container_name)
            return res

    async def _ensure_running_locked(self, st: SandboxStatus) -> SandboxStatus:
        if st.exists:
            # Container existe mais pas running → exited (probablement crash
            # de l'entrypoint au boot précédent). On vérifie le exit code :
            # si != 0, on détruit et recrée pour repartir clean. Si = 0,
            # on tente un simple start (cas rare).
            rc_inspect, out_inspect, _ = await self._cli.call(
                "inspect", "--format", "{{.State.ExitCode}}|{{.State.OOMKilled}}",
                self.container_name, timeout=5,
            )
            oom = False
            try:
                _code, _, _oom = out_inspect.decode().strip().partition("|")
                exit_code = int(_code) if rc_inspect == 0 else -1
                oom = _oom.strip().lower() == "true"
            except (ValueError, AttributeError):
                exit_code = -1
            # Passe sandbox 2026-09-26 — 137/143 = arrêt par SIGKILL/SIGTERM,
            # c.-à-d. un ``docker stop`` (GC d'inactivité, redémarrage du
            # démon) : PID 1 est ``sleep infinity`` sans ``--init``, il ignore
            # SIGTERM et ``stop -t 5`` finit TOUJOURS en SIGKILL (137). Ce
            # n'est pas un crash : avant, chaque retour après une veille
            # détruisait et recréait le container (couche d'écriture perdue —
            # paquets installés hors /work —, run + chmod repayés). On le
            # redémarre ; un OOM reste traité comme un crash.
            if exit_code in (137, 143) and not oom:
                exit_code = 0

            if exit_code != 0:
                logger.info(
                    "[sandbox] container %s en état exited (code=%d) → destroy + recreate",
                    self.container_name, exit_code,
                )
                await self._cli.call("rm", "-fv", self.container_name, timeout=10)
                await self._create()
            else:
                # Exit code 0 : tentative de start (peu probable mais possible)
                rc, _, err = await self._cli.call("start", self.container_name, timeout=15)
                if rc != 0:
                    logger.warning("[sandbox %s] start KO, recreate: %s",
                                   self.container_name, err.decode(errors="replace"))
                    await self._cli.call("rm", "-f", self.container_name, timeout=10)
                    await self._create()
        else:
            await self._create()

        return await self.status()

    def _build_run_args(self, profile: "NetworkProfile",
                        resolved_domains: "Optional[Dict[str, list]]" = None) -> list:
        """Pure construction of the ``docker run`` argv (no I/O), so the run
        profile — including the opt-in hardening flags — is unit-testable.

        ``resolved_domains`` : {domaine: [IPv4]} résolu par l'appelant
        (``resolve_profile_domains`` dans ``_create`` — la résolution est de
        l'I/O, elle n'a pas sa place ici).

        Modèle 1.2.0 « permissif DANS le container » : pas de ``--read-only``
        ni ``--cap-drop=ALL``/``no-new-privileges:true`` (sudo doit marcher) ;
        l'isolation hôte vient des namespaces + seccomp/apparmor par défaut +
        pas de docker.sock. Seule ``MKNOD`` est retirée (2026-09-29) : un nœud
        de périphérique créé dans /work par le root du conteneur resterait
        ouvrable depuis l'hôte, hors du cgroup de périphériques du conteneur. Les ``docker exec`` forcent l'UID via
        ``self.cfg.exec_user``, donc pas de ``--user`` ici (l'entrypoint passe
        root→10001 via setpriv).
        """
        run_args = [
            "run", "-d",
            "--name", self.container_name,
            "--label", _naming.label("user_id", self.user_id),
            "--label", _naming.label("username", self.username),
            "--security-opt", "no-new-privileges:false",
            "--cap-drop", "MKNOD",
            "--tmpfs", "/run:rw,size=10m,mode=755",
            "--shm-size", "1g",
            "--memory", f"{self.cfg.memory_mb}m",
            "--cpus", f"{self.cfg.cpu_quota_pct / 100.0:.2f}",
            "--pids-limit", str(self.cfg.pids_max),
            "-e", "HOME=/work",
            "-e", "LANG=C.UTF-8",
            "-e", "LC_ALL=C.UTF-8",
            "-e", "TZ=UTC",
            "-e", "MOZ_HEADLESS=1",
            "-v", f"{self.sandbox_path}:/work:rw",
            "--workdir", "/work",
        ]

        # NOTE — Les skills (PERSO comme GLOBAUX) ne sont VOLONTAIREMENT plus
        # montés dans ``/work`` : l'agent y accède uniquement via les outils
        # MCP (``skill_get`` / ``skill_read_file`` / ``skill_run_script``).
        # ``sandbox_path`` est désormais ``P/work`` ; les dossiers ``skills/``
        # et ``.memory/`` vivent à ``P``, HORS du mont — donc invisibles et
        # non-supprimables depuis le conteneur. (Ancien mont RO
        # ``<projet>/skills:/work/.skills`` retiré.)

        # Opt-in hardening (Step 6, default OFF): an alternate OCI runtime
        # (gVisor "runsc", Kata) sandboxes syscalls at the host boundary while
        # KEEPING the permissive-inside model. Inserted right after `run -d`.
        if self.cfg.runtime:
            run_args[2:2] = ["--runtime", self.cfg.runtime]

        # ─── Network mode (selon le profil choisi) ──────────────────────
        # Label netcfg : empreinte de la config réseau ACTUELLE du profil.
        # ``_reconcile_network`` la compare au hash courant pour détecter la
        # dérive (profil édité par l'admin après création du conteneur).
        run_args.extend(["--label", _naming.label("netcfg", netcfg_hash(profile))])
        net_mode = profile.mode
        if net_mode == "none":
            run_args.extend(["--network", "none"])
        elif net_mode == "bridge":
            pass
        elif net_mode == "allowlist_ip":
            # NET_ADMIN pour que l'entrypoint pose les règles iptables DANS le
            # netns du container (pas sur l'hôte).
            run_args.extend(["--cap-add", "NET_ADMIN"])
            # Allowlist effective = IPs admin + IPs résolues des domaines +
            # résolveurs DNS. Les résolveurs y figurent AUSSI (pas seulement
            # dans ELPIS_DNS) pour la compat image < 1.6.0, dont l'entrypoint
            # ignore les nouveaux env (dégradation : toutes-portes, jamais
            # moins sûr que l'existant).
            resolved = resolved_domains or {}
            allow: list = list(profile.ips or [])
            for dom in (profile.domains or []):
                ips = list(resolved.get(dom) or [])
                allow.extend(ips)
                if ips:
                    # Épinglage /etc/hosts : le conteneur joint le domaine sans
                    # résolution live, et le rebinding est neutralisé.
                    run_args.extend(["--add-host", f"{dom}:{ips[0]}"])
            allow.extend(profile.dns or [])
            seen: set = set()
            allow = [x for x in allow if not (x in seen or seen.add(x))]
            net_env = {"ALLOWLIST": " ".join(allow)}
            if profile.ports:
                net_env["ALLOWLIST_PORTS"] = ",".join(str(int(p)) for p in profile.ports)
            if profile.dns:
                net_env["DNS"] = " ".join(profile.dns)
            for key, val in net_env.items():
                run_args.extend(["-e", f"ELPIS_{key}={val}"])
            if profile.dns:
                for ip in profile.dns:
                    run_args.extend(["--dns", str(ip)])

        # Admin passthrough flags (advanced/opt-in).
        for a in (self.cfg.extra_run_args or []):
            run_args.append(str(a))

        run_args.extend([self.cfg.image, "sleep", "infinity"])
        return run_args

    async def _create(self) -> None:
        # Cleanup défensif CONDITIONNEL : on ne supprime que si un container du
        # même nom existe ET n'est PAS running. Avant, le ``rm -fv`` était
        # inconditionnel → sur deux _create concurrents (boucles asyncio
        # distinctes, cf. _lifecycle_lock), le rm de l'un détruisait le
        # container que l'autre venait de créer et utilisait (audit CRIT-4).
        pre = await self.status()
        if pre.running:
            # Une coroutine/boucle concurrente a déjà créé+démarré le container.
            # Idempotent : on le réutilise tel quel.
            return
        if pre.exists:
            await self._cli.call("rm", "-fv", self.container_name, timeout=10)

        # Vérifier image présente, sinon tenter de la charger
        rc_img, _, _ = await self._cli.call(
            "image", "inspect", self.cfg.image, timeout=10
        )
        if rc_img != 0:
            # Tente l'auto-load (bloquant ici puisqu'on a besoin de l'image
            # pour créer le container)
            from shared_infra.sandbox.executors._image_loader import (
                ensure_image_loaded, ImageLoadStatus,
            )
            state = await ensure_image_loaded(self.cfg.image, blocking=True)
            if state.status == ImageLoadStatus.LOADING:
                # AUDIT 2026-08-02 (E2) — blocking=True attend désormais
                # vraiment la fin ; n'atteint cette branche que si l'attente
                # a expiré (330 s). Message honnête : c'est une progression
                # qui dure, PAS un échec définitif — l'ancien code affichait
                # le message de progression comme erreur (« indisponible.
                # Chargement de l'image (612 MB)… ») dès qu'un 2e onglet
                # arrivait pendant un chargement.
                raise ExecError(
                    f"Le chargement de l'image '{self.cfg.image}' est toujours "
                    f"en cours ({state.progress_msg}). Réessayez dans quelques "
                    f"instants."
                )
            if state.status != ImageLoadStatus.LOADED:
                raise ExecError(
                    f"Image '{self.cfg.image}' indisponible. "
                    f"{state.error or state.progress_msg}"
                )

        # Sandbox folder doit exister + être accessible par UID 10001
        self.sandbox_path.mkdir(parents=True, exist_ok=True)
        try:
            import os
            # Force 0o777 unconditionally (not just when world-writable is
            # missing) — the previous "only chmod if not world-writable"
            # check skipped folders that were 0o775, which keeps the
            # container UID 10001 from creating files at the root if the
            # operator's UID doesn't match. The folder is per-user and
            # already isolated by the parent directory's perms (or by the
            # OS-level user separation if SANDBOX_DIR is per-user); 0o777
            # at this level is the simplest cross-UID arrangement.
            os.chmod(self.sandbox_path, 0o777)
        except OSError as e:
            logger.warning("[sandbox] chmod %s impossible : %s",
                           self.sandbox_path, e)

        profile = self.network_profile
        net_mode = profile.mode
        # Résolution des domaines du profil (I/O DNS, hors _build_run_args) —
        # best-effort dans un thread : l'OS applique ses propres timeouts.
        resolved_domains: Dict[str, list] = {}
        if net_mode == "allowlist_ip" and (profile.domains or []):
            try:
                resolved_domains = await asyncio.to_thread(
                    resolve_profile_domains, profile)
            except Exception as e:                     # noqa: BLE001
                logger.warning("[sandbox] résolution domaines profil %s KO : %s",
                               profile.id, e)
        run_args = self._build_run_args(profile, resolved_domains)
        rc, _, err = await self._cli.call(*run_args, timeout=60)
        if rc != 0:
            err_txt = err.decode(errors="replace").strip()
            # Course inter-boucles : une autre coroutine a créé le container
            # entre notre status() et notre run. Docker répond « name already
            # in use » → ce n'est PAS une erreur, le container existe. On le
            # réutilise (idempotent) au lieu de planter (audit CRIT-4).
            if "already in use" in err_txt.lower():
                st = await self.status()
                if st.running:
                    logger.info("[sandbox] %s déjà créé par un appel concurrent — réutilisé",
                                self.container_name)
                    return
            raise ExecError(
                f"docker run a échoué : {err_txt[:400]}"
            )

        # Note: pour allowlist_ip, le filtrage iptables est appliqué par
        # l'entrypoint du container lui-même (script /entrypoint.sh dans
        # l'image), pas depuis l'app. Voir Dockerfile + entrypoint.sh.

        # Vérification post-run : si l'entrypoint a planté, le container
        # est déjà sorti. On attend brièvement et on vérifie.
        await asyncio.sleep(0.8)
        check_rc, check_out, _ = await self._cli.call(
            "inspect", "--format", "{{.State.Status}}|{{.State.ExitCode}}",
            self.container_name, timeout=5,
        )
        if check_rc == 0:
            status_str = check_out.decode().strip()
            if status_str.startswith("exited") or status_str.startswith("dead"):
                # Récupérer les logs AVANT toute suppression — c'est notre
                # seul moyen de savoir pourquoi l'entrypoint a planté.
                logs_rc, logs_out, _ = await self._cli.call(
                    "logs", "--tail", "30", self.container_name, timeout=5,
                )
                log_text = logs_out.decode(errors="replace").strip() if logs_rc == 0 else "(logs indisponibles)"
                # IMPORTANT : on NE SUPPRIME PAS le container ici. Si on le
                # supprime, le caller (sandbox_me_post) ne peut plus accéder
                # aux logs et on perd l'info utile pour l'user.
                # Le container `exited` sera détruit + recréé au prochain
                # appel de ensure_running (voir logique exit_code != 0).
                logger.warning(
                    "[sandbox] container %s a crashé (état=%s). Logs:\n%s",
                    self.container_name, status_str, log_text[-500:],
                )
                raise ExecError(
                    f"Container a crashé au démarrage (état={status_str}).",
                    container_logs=log_text[-1500:],
                )

        logger.info(
            "[sandbox] container créé : %s pour user_id=%d (profil=%s, mode=%s)",
            self.container_name, self.user_id, profile.id, net_mode,
        )
        if net_mode == "allowlist_ip":
            logger.info(
                "[sandbox] → %d IP(s) autorisées via iptables : %s",
                len(profile.ips or []), ", ".join(profile.ips or []) or "(aucune)",
            )
        elif net_mode == "bridge":
            logger.info("[sandbox] → réseau ouvert (bridge Docker)")
        else:
            logger.info("[sandbox] → isolé total (--network=none)")

    async def stop(self) -> None:
        # Sérialisé par user (cf. _lifecycle_lock) pour ne pas couper le netns
        # pendant qu'un ensure_running()/_create() concurrent le manipule.
        # Note: les rules iptables sont DANS le container (entrypoint), donc le
        # stop nettoie automatiquement le netns.
        async with _lifecycle_lock(self.user_id):
            await self._cli.call("stop", "-t", "5", self.container_name, timeout=15)
        # Le conteneur suivant portera peut-être une autre image : le verdict
        # privdrop ne doit pas lui être appliqué à l'aveugle.
        _privdrop.forget(self.container_name)
        # Invalidate the readiness cache immediately so a concurrent exec
        # can't be served a stale "running" for a container we just stopped.
        get_readiness_cache().record_stopped(self.container_name)

    async def destroy(self) -> None:
        async with _lifecycle_lock(self.user_id):
            await self._cli.call("rm", "-fv", self.container_name, timeout=20)
        _privdrop.forget(self.container_name)
        get_readiness_cache().record_stopped(self.container_name)

    async def restart(self) -> SandboxStatus:
        # destroy + ensure_running prennent chacun le verrou ; on ne le tient
        # pas en continu ici pour rester réentrant (asyncio.Lock non réentrant).
        await self.destroy()
        return await self.ensure_running()

    # ── Exécution ─────────────────────────────────────────────────────────

    async def _ensure_privdrop_probed(self, exec_user: str) -> None:
        """Sonde UNE fois par (conteneur, exec_user) si la chaîne
        ``docker exec -u 0:0 → setpriv --bounding-set=-net_admin → exec_user``
        est utilisable dans ce conteneur.

        Pourquoi c'est nécessaire : un process créé par ``docker exec`` ne
        descend pas de PID 1, il reçoit donc le bounding set du CONTENEUR —
        qui contient ``net_admin`` en mode ``allowlist_ip``. Avec sudo
        NOPASSWD, ``sudo iptables -F OUTPUT`` effaçait l'allowlist depuis
        n'importe quel outil. Cf. ``_privdrop`` pour la mesure et le repli.
        """
        if _privdrop.cached(self.container_name, exec_user) is not None:
            return
        argv = _privdrop.probe_argv(self.container_name, exec_user)
        if argv is None:
            return
        try:
            rc, _out, _err = await self._cli.call(*argv, timeout=10)
        except Exception:                                   # pragma: no cover
            rc = 1
        _privdrop.remember(self.container_name, exec_user, rc == 0)

    async def exec(self,
                   cmd: list[str],
                   *,
                   workdir_in_container: str = "/work",
                   env: dict[str, str] | None = None,
                   stdin_bytes: bytes | None = None,
                   timeout_s: int | None = None,
                   on_chunk: "Optional[Callable[[str, bytes], None]]" = None
                   ) -> ExecResult:
        st = await self.ensure_running()
        if not st.running:
            raise ExecError(
                f"Container {self.container_name} n'a pas pu démarrer"
            )

        timeout = timeout_s or self.cfg.timeout_s

        # MAJ-14 — marque l'activité réelle : on pousse le mtime de la racine
        # sandbox à « maintenant » à chaque exec. ``gc_idle_containers`` se base
        # sur ce mtime ; sans ça, il ne bougeait qu'à l'ajout/suppression d'une
        # entrée à la RACINE (pas lors d'un build dans un sous-dossier) → un
        # container actif pouvait être stoppé en plein travail. Best-effort.
        try:
            import os as _os
            _os.utime(self.sandbox_path, None)
        except OSError:
            pass

        # On force --user sur chaque exec (sinon docker exec ouvre la
        # session en root en bypassant le CMD de l'entrypoint).
        # Défaut 10001:10001 ; l'admin peut mettre "0:0" via config.json
        # (executors.exec_user) pour que tout tourne root sans `sudo`.
        exec_user = self.cfg.exec_user or "10001:10001"
        # ── retrait de net_admin (cf. _privdrop) ──────────────────────────
        # On entre en root et `setpriv` retire net_admin du bounding set
        # AVANT de redescendre sur exec_user : la commande de l'appelant ne
        # voit jamais root, mais ne peut plus toucher au netfilter. Si la
        # chaîne n'est pas disponible (image sans util-linux), `resolve`
        # rend la forme historique — jamais d'exec cassé.
        await self._ensure_privdrop_probed(exec_user)
        docker_user, privdrop_prefix = _privdrop.resolve(
            self.container_name, exec_user)
        exec_args = ["exec", "--user", docker_user,
                     "--workdir", workdir_in_container]
        if stdin_bytes is not None:
            exec_args.append("-i")
        env = dict(env or {})
        # git in-container : un repo écrit côté HÔTE (git_action init/clone,
        # panneau git) appartient à l'UID de l'app, pas à exec_user → git y
        # refusait TOUTE commande (« detected dubious ownership »). /work est
        # par construction le volume du seul utilisateur du conteneur : on le
        # déclare sûr via le protocole env GIT_CONFIG (sans toucher au repo ni
        # à un ~/.gitconfig visible). On n'écrase jamais un GIT_CONFIG_COUNT
        # déjà posé par l'appelant.
        if "GIT_CONFIG_COUNT" not in env:
            env["GIT_CONFIG_COUNT"] = "1"
            env["GIT_CONFIG_KEY_0"] = "safe.directory"
            env["GIT_CONFIG_VALUE_0"] = "*"
        for k, v in env.items():
            exec_args += ["-e", f"{k}={v}"]
        exec_args.append(self.container_name)

        # ── umask 0000 wrapper ────────────────────────────────────────────
        # The /work volume is shared between the host process (running as the
        # operator's UID, e.g. 1000/`mcp`) and the container UID (default
        # 10001). These two share NO group in this deployment (host GID 1000
        # ≠ container GID 10001), so a *group*-writable file is NOT writable
        # by the other side. Default umask 022 → 0644/0755 (host can read but
        # not overwrite). umask 0002 → 0664/0775 only bridges the gap WHEN the
        # two sides share a GID — which they don't here, so the model hit
        # "permission denied" creating files via the host fs tools inside a
        # directory the shell had just made (10001-owned, group-only-write).
        # We therefore force umask 0000 → files 0666 / dirs 0777 (OTHER-
        # writable), making container-created paths writable by the host UID
        # regardless of group. This is symmetric with the host side, which
        # already widens its own writes to 0666/0777 (`write_beneath` modes,
        # `paths.widen_beneath`), so the /work volume is
        # fully cross-writable in either direction. The per-user sandbox is
        # isolated (single user, `--network=none`), so world-writable bits
        # *within it* are not a new exposure. We use `sh -c 'umask 0000;
        # exec "$@"' --` to apply the umask without changing the visible
        # argv (process name in `ps`, signal handling, etc.).
        #
        # NB: we always wrap, even for plain `["sh", "-c", "..."]` calls,
        # because the cost is one extra shell process per exec (~1 ms) and
        # the consistency simplifies reasoning. If the agent calls
        # `umask` explicitly inside its cmd it still wins (umask is per-
        # process and inherited; our wrapper only sets the floor).
        # ── timeout CÔTÉ CONTAINER (MAJ-11) ───────────────────────────────
        # Tuer le ``docker exec`` côté HÔTE (kill_process_group) NE tue PAS le
        # process distant : docker le laisse tourner dans le container →
        # accumulation d'orphelins jusqu'à --pids-limit, container inutilisable.
        # On enveloppe donc la commande dans ``timeout -k 5 <N>`` qui s'exécute
        # DANS le container : à l'échéance, le kernel du container envoie SIGTERM
        # puis SIGKILL au process → pas d'orphelin, rc 124. Le ``wait_for`` côté
        # hôte garde une marge (+10 s) et ne sert plus que de filet si le
        # ``timeout`` interne ne rendait pas la main (process en état D).
        # BUG FIX — ``"$1" "$@"`` réinjectait le timeout : ``$@`` expanse TOUS
        # les positionnels À PARTIR DE $1, donc ``timeout_arg`` apparaissait
        # deux fois → ``timeout -k 5 60 60 <cmd>``. ``timeout`` lisait alors le
        # 2e « 60 » comme la COMMANDE à lancer → « command not found » (rc 127)
        # sur CHAQUE exec, cassant tout le FS sandbox (upload/save/mkdir/…) et
        # le terminal. On capture $1, ``shift``, puis ``"$@"`` = la vraie cmd.
        timeout_arg = str(int(timeout))
        exec_args += privdrop_prefix + [
                      "sh", "-c",
                      'umask 0000; t="$1"; shift; exec timeout -k 5 "$t" "$@"',
                      "--", timeout_arg] + list(cmd)

        t0 = time.monotonic()
        proc = await asyncio.create_subprocess_exec(
            self._cli.bin, *exec_args,
            stdin=asyncio.subprocess.PIPE if stdin_bytes is not None else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        timed_out = False
        # AUDIT 2026-09-25 — UN seul chemin de lecture, incrémental et BORNÉ.
        # ``communicate()`` (chemin sans live shell) et les ``bytearray`` du
        # live shell gardaient TOUTE la sortie en mémoire du worker hôte :
        # ``max_output`` ne tronque que l'affichage, et le ``--memory`` du
        # conteneur ne borne pas le lecteur côté hôte. Une commande qui écrit
        # plusieurs Go (``yes``, ``cat`` d'un gros binaire) pendant les 600 s
        # permises faisait tomber le worker — et tous ses utilisateurs. On
        # garde la TÊTE et la QUEUE (la fin porte statut et erreurs) dans la
        # limite ``_EXEC_CAPTURE_MAX_BYTES`` ; le reste est compté et signalé.
        # ``on_chunk(stream_name, data)`` est appelé sur la loop courante
        # (celle du bridge exec) à chaque paquet lu — il DOIT être
        # non-bloquant.
        out_buf = _BoundedCapture(_EXEC_CAPTURE_MAX_BYTES)
        err_buf = _BoundedCapture(_EXEC_CAPTURE_MAX_BYTES)

        async def _feed_stdin() -> None:
            if stdin_bytes is None or proc.stdin is None:
                return
            try:
                proc.stdin.write(stdin_bytes)
                await proc.stdin.drain()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                try:
                    proc.stdin.close()
                except Exception:
                    pass

        async def _pump(reader, name: str, buf: "_BoundedCapture") -> None:
            if reader is None:
                return
            while True:
                data = await reader.read(65536)
                if not data:
                    break
                buf.add(data)
                if on_chunk is None:
                    continue
                try:
                    on_chunk(name, data)
                except Exception:
                    # Un callback cassé ne doit jamais tuer l'exec.
                    pass

        # (passe 8, B5) — tâches NOMMÉES : ``gather`` sans
        # ``return_exceptions`` propage la première exception mais laisse
        # ses frères TOURNER ; seul le timeout (annulation par ``wait_for``)
        # les arrêtait. Une annulation du tour ou une pompe cassée
        # laissait les pompes et le ``docker exec`` vivants après l'exec
        # (sortie shell fantôme, fuite de process).
        _jobs = [asyncio.ensure_future(_c) for _c in (
            _feed_stdin(),
            _pump(proc.stdout, "stdout", out_buf),
            _pump(proc.stderr, "stderr", err_buf),
            proc.wait(),
        )]
        try:
            await asyncio.wait_for(asyncio.gather(*_jobs), timeout=timeout + 10)
            if proc.returncode == 124:
                timed_out = True
        except asyncio.TimeoutError:
            timed_out = True
            await kill_process_group(proc)
        except BaseException:
            for _j in _jobs:
                if not _j.done():
                    _j.cancel()
            await kill_process_group(proc)
            await asyncio.gather(*_jobs, return_exceptions=True)
            raise
        out, err = out_buf.value(), err_buf.value()

        # Self-heal the readiness cache: if `docker exec` reports the
        # container is gone/stopped (the rare stale-"running" window), record
        # it as stopped so the NEXT ensure_running() repairs via the full
        # path. We never auto-retry — the command may have side effects.
        if proc.returncode not in (0, 124, None):
            _low = (err or b"").decode("utf-8", errors="replace").lower()
            if "no such container" in _low or "is not running" in _low:
                get_readiness_cache().record_stopped(self.container_name)

        return ExecResult(
            returncode=proc.returncode if proc.returncode is not None else -1,
            stdout=out or b"",
            stderr=err or b"",
            duration_s=time.monotonic() - t0,
            timed_out=timed_out,
            executor_tag=f"docker.user.{self.username}",
            container_id=st.container_id,
        )

    async def stats(self) -> Dict[str, Any]:
        rc, out, _ = await self._cli.call(
            "stats", "--no-stream", "--format",
            '{"cpu":"{{.CPUPerc}}","mem":"{{.MemUsage}}","mem_pct":"{{.MemPerc}}",'
            '"pids":"{{.PIDs}}"}',
            self.container_name, timeout=10,
        )
        if rc != 0:
            return {}
        try:
            import json
            return json.loads(out.decode().strip())
        except Exception:
            return {}


async def gc_idle_containers(idle_hours: int | None = None) -> list[str]:
    """Stoppe les containers user inactifs depuis ``idle_hours``."""
    cfg = load_admin_config()
    if not shutil.which("docker"):
        return []

    cli = _DockerCLI()
    threshold = (idle_hours if idle_hours is not None else cfg.idle_kill_hours) * 3600
    if threshold <= 0:
        return []

    rc, out, _ = await cli.call("ps", *_naming.label_filter("user_id"),
                                "--format", '{{.Names}}', timeout=15)
    if rc != 0:
        return []
    names = out.decode().splitlines()

    stopped: list[str] = []
    now = time.time()
    for name in names:
        name = name.strip()
        if not name:
            continue
        rc2, out2, _ = await cli.call(
            "inspect", "--format",
            _naming.label_tpl("username"),
            name, timeout=5,
        )
        if rc2 != 0:
            continue
        username = out2.decode().strip()
        from shared_infra.config import SANDBOX_DIR
        # Idle = no WORK activity. Agent/editor writes land in ``P/work`` (the
        # mounted dir), not ``P`` — probe the work root so active users aren't
        # falsely flagged idle (their ``P`` mtime no longer moves on writes).
        sb = Path(SANDBOX_DIR) / username / "work"
        try:
            last = sb.stat().st_mtime
        except OSError:
            last = 0
        # F25 — un job lancé via ``execute_shell(background=true)`` n'appelle
        # plus ``exec`` (qui bumpe le mtime de ``P/work``) ; il écrit dans
        # ``P/work/.bg/bg-*.log``. Sans ce max, le GC jugeait le conteneur idle
        # et TUAIT le job détaché en plein travail. On prend donc aussi le mtime
        # du log de fond le plus récent → un job actif rafraîchit l'horloge.
        try:
            _bg = sb / ".bg"
            if _bg.is_dir():
                for _lg in _bg.iterdir():
                    try:
                        last = max(last, _lg.stat().st_mtime)
                    except OSError:
                        continue
        except OSError:
            pass
        if now - last > threshold:
            await cli.call("stop", "-t", "5", name, timeout=15)
            get_readiness_cache().record_stopped(name)
            stopped.append(name)
            logger.info("[sandbox-gc] container stoppé (idle %ds) : %s",
                        int(now - last), name)
    return stopped


_USER_SANDBOXES: dict[int, UserSandbox] = {}


def get_user_sandbox(user_id: int, username: str,
                     sandbox_path: Path,
                     network_profile_id: Optional[str] = None) -> UserSandbox:
    cached = _USER_SANDBOXES.get(user_id)
    if cached is not None:
        cached.cfg = load_admin_config()
        # Update profile_id si fourni — le user a peut-être changé son choix
        if network_profile_id is not None:
            cached.network_profile_id = network_profile_id
        return cached
    sb = UserSandbox(user_id, username, sandbox_path,
                     network_profile_id=network_profile_id)
    _USER_SANDBOXES[user_id] = sb
    return sb


def reset_user_sandbox_cache(user_id: Optional[int] = None) -> None:
    """Oublie les instances en cache. ``user_id`` : ce compte SEUL.

    Passe sandbox 2026-09-26 — le changement de profil d'UN utilisateur (et
    l'échec de démarrage de SON conteneur) vidait le cache de TOUS : chacun
    reperdait ses gardes une-fois (``_mount_verified``, ``_netcfg_verified``,
    ``_perms_reconciled``) → rafale de ``docker inspect`` / réconciliations.
    Sans argument : tout (changement de configuration admin)."""
    if user_id is None:
        _USER_SANDBOXES.clear()
    else:
        _USER_SANDBOXES.pop(int(user_id), None)


__all__ = [
    "SandboxAdminConfig", "SandboxStatus", "UserSandbox", "NetworkProfile",
    "load_admin_config", "get_user_sandbox", "reset_user_sandbox_cache",
    "gc_idle_containers",
]
