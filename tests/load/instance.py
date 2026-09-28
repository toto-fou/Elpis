# SPDX-License-Identifier: MIT
"""
tests/load/instance.py — une instance jetable de l'application, sous charge.

Ce que ce module garantit
-------------------------
1. **Aucune donnée réelle touchée.** Config, base, sandboxes et spools vivent
   dans un dossier temporaire. ``APP_CONFIG_PATH`` / ``APP_DB_PATH`` /
   ``APP_SANDBOX_DIR`` sont posés explicitement, jamais hérités.
2. **Aucun backend LLM requis.** ``LLAMA_PORT=1`` fait échouer vite toute
   tentative de connexion au moteur — les scénarios de charge portent sur le
   serveur, pas sur la génération.
3. **Le vrai serveur, en multi-worker.** gunicorn avec la configuration du
   dépôt : c'est le seul moyen de voir ce qui ne se voit qu'entre process —
   contention du verrou d'écriture SQLite, verrous ``flock`` de présence, bus
   d'événements sur fichier.

Le mot de passe des comptes semés est haché **une seule fois** et recopié :
PBKDF2 coûte 87 ms, semer 50 comptes prendrait 4,3 s pour rien. Le sel est
partagé entre les comptes de test, ce qui serait une faute en production et
n'a aucune conséquence ici (ces comptes ne quittent pas le dossier temporaire).
"""
from __future__ import annotations

import base64
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parents[2]
PYTHON = str(ROOT / "venv" / "bin" / "python")

MOT_DE_PASSE = "Charge!2026aB"


def port_libre() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@dataclass
class Instance:
    """Une application lancée, prête à recevoir de la charge."""
    base: Path
    port: int
    workers: int
    proc: subprocess.Popen
    comptes: list[str] = field(default_factory=list)
    #: Objets ``psutil.Process`` conservés entre deux sondes : ``cpu_percent``
    #: mesure un delta depuis SON dernier appel sur le même objet.
    _cpu_cache: dict = field(default_factory=dict, repr=False)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    # ── Cycle de vie ────────────────────────────────────────────────────────

    def arreter(self, grace: float = 10.0) -> None:
        if self.proc.poll() is not None:
            return
        self.proc.send_signal(signal.SIGTERM)
        limite = time.monotonic() + grace
        while time.monotonic() < limite and self.proc.poll() is None:
            time.sleep(0.05)
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait(timeout=10)

    # ── Sondes ──────────────────────────────────────────────────────────────

    def pids(self) -> list[int]:
        """Le maître gunicorn et ses workers (les sous-process MCP exclus :
        ils ont leur propre ligne de commande)."""
        import psutil
        try:
            maitre = psutil.Process(self.proc.pid)
        except psutil.NoSuchProcess:
            return []
        vivants = [maitre] + [e for e in maitre.children(recursive=False)]
        return [p.pid for p in vivants if p.is_running()]

    def sonde_process(self) -> dict:
        """RSS / descripteurs / threads / CPU agrégés sur l'arbre du serveur.

        Le CPU est **indispensable** pour lire les autres chiffres. Sans lui,
        une latence qui monte ressemble toujours à une file d'attente qu'on
        pourrait élargir — alors qu'il peut simplement ne plus rester de
        cœur disponible. Les deux causes se corrigent à l'opposé l'une de
        l'autre : élargir une file déjà limitée par le CPU **dégrade**.

        ``cpu_pct`` est cumulé sur l'arbre et rapporté au nombre de cœurs :
        100 % = la machine entière est occupée par le serveur.
        """
        import psutil
        rss = fds = threads = 0
        cpu = 0.0
        n = 0
        try:
            maitre = psutil.Process(self.proc.pid)
            arbre = [maitre] + maitre.children(recursive=True)
        except psutil.NoSuchProcess:
            return {"rss_mo": 0.0, "fds": 0, "threads": 0, "process": 0, "cpu_pct": 0.0}
        for p in arbre:
            try:
                with p.oneshot():
                    rss += p.memory_info().rss
                    fds += p.num_fds()
                    threads += p.num_threads()
                # Intervalle nul = delta depuis le dernier appel sur CE même
                # objet ; on garde donc les objets d'un tour à l'autre.
                cpu += self._cpu_cache.setdefault(p.pid, p).cpu_percent(None)
                n += 1
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                self._cpu_cache.pop(p.pid, None)
                continue
        coeurs = psutil.cpu_count() or 1
        return {"rss_mo": round(rss / 1048576, 1), "fds": fds,
                "threads": threads, "process": n,
                "cpu_pct": round(cpu / coeurs, 1)}

    def sonde_base(self) -> dict:
        """Taille de la base et du journal WAL — un WAL qui gonfle sans
        redescendre signale des lecteurs qui empêchent le checkpoint."""
        db = self.base / "db" / "app.db"
        taille = lambda p: round(p.stat().st_size / 1048576, 2) if p.exists() else 0.0
        return {"db_mo": taille(db), "wal_mo": taille(db.with_name(db.name + "-wal"))}


def _config(base: Path, extra: Optional[dict] = None) -> dict:
    cfg = {
        "app": {
            "db_path": str(base / "db" / "app.db"),
            "sandbox_dir": str(base / "sandboxes"),
        },
        # Le viewer « Trafic LLM » est actif par défaut en production : on le
        # laisse actif ici aussi, sinon la charge ne mesurerait pas ce que
        # l'exploitant subit réellement.
        "llm": {"debug": {"enabled": True}},
        "security": {"https": {"enabled": False}},
    }
    for cle, valeur in (extra or {}).items():
        cfg[cle] = {**cfg.get(cle, {}), **valeur} if isinstance(valeur, dict) else valeur
    return cfg


def _semer_comptes(base: Path, nb: int) -> list[str]:
    """Crée ``nb`` comptes directement en base, sans passer par l'API."""
    sys.path.insert(0, str(ROOT))
    os.environ["APP_CONFIG_PATH"] = str(base / "config.json")
    from shared_infra.db import _connection as _legacy
    from shared_infra.accounts.users import _hash_password
    import shared_infra.config as cfg
    import importlib
    importlib.reload(cfg)
    _legacy.DB_PATH = str(base / "db" / "app.db")
    _legacy.reset_pool()

    from shared_infra.db import init_db
    init_db()

    sel = "0f" * 16
    empreinte = _hash_password(MOT_DE_PASSE, sel)      # payé UNE fois
    noms = [f"charge{i:03d}" for i in range(nb)]
    with _legacy.db_conn() as conn:
        for i, nom in enumerate(noms):
            conn.execute(
                "INSERT OR IGNORE INTO users(username, pass_salt, pass_hash, "
                "created_at, is_admin, must_change_pwd) VALUES(?,?,?,?,?,0)",
                (nom, sel, empreinte, time.time(), 1 if i == 0 else 0))
        conn.commit()
    _legacy.reset_pool()
    return noms


def semer_sandbox(base: Path, noms: list[str], *, fichiers: int = 400) -> int:
    """Remplit les bacs à sable de fichiers, pour que les routes disque aient
    du vrai travail.

    Sur un dossier vide, ``/api/sandbox/tree`` et ``/api/sandbox/grep``
    répondent en une milliseconde : la campagne mesurerait alors le coût du
    routage, pas celui du disque — et ne dirait rien du plafond du pool de
    threads (ces routes sont synchrones).
    """
    corps = "\n".join(f"def fonction_{i}():\n    return {i}" for i in range(30))
    ecrits = 0
    for nom in noms:
        racine = base / "sandboxes" / nom / "work"
        for i in range(fichiers):
            dossier = racine / f"module{i // 25:02d}"
            dossier.mkdir(parents=True, exist_ok=True)
            (dossier / f"fichier{i:04d}.py").write_text(corps, encoding="utf-8")
            ecrits += 1
    return ecrits


def demarrer(base: Path, *, workers: int = 3, comptes: int = 8,
             config_extra: Optional[dict] = None,
             max_requests: Optional[int] = None,
             fichiers_sandbox: int = 0,
             attente_max: float = 90.0) -> Instance:
    """Lance une instance isolée et attend qu'elle réponde."""
    if base.exists():
        shutil.rmtree(base)
    (base / "db").mkdir(parents=True)
    (base / "sandboxes").mkdir()
    (base / "logs").mkdir()
    (base / "config.json").write_text(
        json.dumps(_config(base, config_extra), ensure_ascii=False), encoding="utf-8")

    noms = _semer_comptes(base, comptes)
    if fichiers_sandbox:
        semer_sandbox(base, noms, fichiers=fichiers_sandbox)
    port = port_libre()

    env = dict(os.environ)
    env.update({
        "APP_CONFIG_PATH": str(base / "config.json"),
        "APP_DB_PATH": str(base / "db" / "app.db"),
        "APP_SANDBOX_DIR": str(base / "sandboxes"),
        "APP_SESSION_SECRET": base64.b64encode(os.urandom(36)).decode(),
        "BIND": f"127.0.0.1:{port}",
        # Pas de moteur LLM sur la machine de mesure : on veut un échec
        # immédiat, pas un délai de garde qui polluerait les percentiles.
        "LLAMA_IP": "127.0.0.1",
        "LLAMA_PORT": "1",
        "PYTHONPATH": str(ROOT),
    })
    argv = [PYTHON, "-m", "gunicorn", "-c", "server/gunicorn_conf.py",
            "--workers", str(workers)]
    if max_requests is not None:
        # Permet d'ISOLER l'effet du recyclage : une campagne à
        # ``--max-requests 0`` sert de témoin quand on soupçonne le recyclage
        # d'être la cause des requêtes perdues.
        argv += ["--max-requests", str(max_requests)]
        if max_requests == 0:
            argv += ["--max-requests-jitter", "0"]
    argv.append("server.app:app")
    journal = open(base / "logs" / "serveur.log", "wb")
    proc = subprocess.Popen(
        argv, cwd=str(ROOT), env=env, stdout=journal, stderr=subprocess.STDOUT,
        start_new_session=True)

    inst = Instance(base=base, port=port, workers=workers, proc=proc, comptes=noms)
    limite = time.monotonic() + attente_max
    import httpx
    while time.monotonic() < limite:
        if proc.poll() is not None:
            raise RuntimeError(
                "le serveur s'est arrêté au démarrage :\n"
                + (base / "logs" / "serveur.log").read_text(errors="replace")[-4000:])
        try:
            if httpx.get(f"{inst.url}/api/health", timeout=2.0).status_code == 200:
                return inst
        except Exception:
            time.sleep(0.2)
    inst.arreter()
    raise RuntimeError(
        f"le serveur n'a pas répondu en {attente_max:.0f} s :\n"
        + (base / "logs" / "serveur.log").read_text(errors="replace")[-4000:])


def attendre_stabilisation(inst: Instance, *, patience: float = 25.0,
                           calme: float = 3.0, marge_mo: float = 4.0) -> dict:
    """Attend que la mémoire cesse de monter avant de mesurer quoi que ce soit.

    Répondre à ``/api/health`` ne veut pas dire « en régime » : le boot
    déclenche en tâche de fond le préchauffage du pool MCP, qui lance **un
    sous-process d'environ 80 Mo par worker**. Sans cette attente, la première
    sonde tombe avant eux et la « dérive de RSS » du scénario mesure en réalité
    un démarrage — 200 Mo de faux positif, exactement le genre de chiffre qui
    fait chercher une fuite là où il n'y en a pas.

    On considère l'instance stable après ``calme`` secondes sans hausse
    supérieure à ``marge_mo``.
    """
    limite = time.monotonic() + patience
    dernier = inst.sonde_process()["rss_mo"]
    stable_depuis = time.monotonic()
    while time.monotonic() < limite:
        time.sleep(0.5)
        courant = inst.sonde_process()["rss_mo"]
        if courant - dernier > marge_mo:
            stable_depuis = time.monotonic()
        dernier = max(dernier, courant)
        if time.monotonic() - stable_depuis >= calme:
            break
    return inst.sonde_process()
