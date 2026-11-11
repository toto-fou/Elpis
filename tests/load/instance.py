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
3. **Le vrai serveur.** Le core TypeScript construit (``apps/core/dist/main.mjs``,
   un seul process), avec la configuration du dépôt, et l'hôte d'outils
   Python : verrou d'écriture SQLite, verrous de présence, relais vers l'hôte.

Le mot de passe des comptes semés est haché **une seule fois** et recopié :
PBKDF2 coûte 87 ms, semer 50 comptes prendrait 4,3 s pour rien. Le sel est
partagé entre les comptes de test, ce qui serait une faute en production et
n'a aucune conséquence ici (ces comptes ne quittent pas le dossier temporaire).
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parents[2]
_VENV_PYTHON = ROOT / "venv" / "bin" / "python"
PYTHON = str(_VENV_PYTHON) if _VENV_PYTHON.exists() else sys.executable
CORE = ROOT / "apps" / "core" / "dist" / "main.mjs"
NODE = (os.environ.get("ELPIS_NODE") or (str(ROOT / "node" / "bin" / "node") if (ROOT / "node" / "bin" / "node").exists()
        else shutil.which("node") or "node"))

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
    proc: subprocess.Popen
    comptes: list[str] = field(default_factory=list)
    #: L'hôte d'outils (``python -m toolhost``), service requis de l'application.
    outils: Optional[subprocess.Popen] = None
    #: Objets ``psutil.Process`` conservés entre deux sondes : ``cpu_percent``
    #: mesure un delta depuis SON dernier appel sur le même objet.
    _cpu_cache: dict = field(default_factory=dict, repr=False)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    # ── Cycle de vie ────────────────────────────────────────────────────────

    def arreter(self, grace: float = 10.0) -> None:
        for proc in (self.proc, self.outils):
            if proc is not None:
                _arreter_groupe(proc, grace)

    # ── Sondes ──────────────────────────────────────────────────────────────

    def pids(self) -> list[int]:
        """Le core et ses enfants directs (hors hôte d'outils, lancé à part)."""
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
        arbre = []
        for proc in (self.proc, self.outils):
            try:
                if proc is not None:
                    racine = psutil.Process(proc.pid)
                    arbre += [racine] + racine.children(recursive=True)
            except psutil.NoSuchProcess:
                continue
        if not arbre:
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
    """Crée ``nb`` comptes directement en base, sans passer par l'API : schéma posé par le core, une seule empreinte."""
    env = dict(os.environ, APP_CONFIG_PATH=str(base / "config.json"), ELPIS_RACINE=str(ROOT))
    subprocess.run([NODE, str(CORE.with_name("exploitation.mjs")), "admin"], input='{"action": "list"}',
                   cwd=str(ROOT), env=env, capture_output=True, text=True, check=True, timeout=300)
    sel = "0f" * 16
    empreinte = "pbkdf2_sha256$600000$%s$%s" % (       # format de packages/securite, payé UNE fois
        sel, hashlib.pbkdf2_hmac("sha256", MOT_DE_PASSE.encode(), bytes.fromhex(sel), 600_000).hex())
    noms = [f"charge{i:03d}" for i in range(nb)]
    conn = sqlite3.connect(base / "db" / "app.db")
    try:
        conn.executemany(
            "INSERT OR IGNORE INTO users(username, pass_salt, pass_hash, "
            "created_at, is_admin, must_change_pwd) VALUES(?,?,?,?,?,0)",
            [(nom, sel, empreinte, time.time(), 1 if i == 0 else 0) for i, nom in enumerate(noms)])
        conn.commit()
    finally:
        conn.close()
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


def _arreter_groupe(proc: subprocess.Popen, grace: float = 10.0) -> None:
    """SIGTERM au groupe du process (enfants compris : PTY, ``docker exec``), SIGKILL après ``grace``."""
    if proc.poll() is not None:
        return
    for sig, attente in ((signal.SIGTERM, grace), (signal.SIGKILL, 10.0)):
        try:
            os.killpg(proc.pid, sig)
        except (ProcessLookupError, PermissionError):
            proc.send_signal(sig)
        limite = time.monotonic() + attente
        while time.monotonic() < limite and proc.poll() is None:
            time.sleep(0.05)
        if proc.poll() is not None:
            return


def _manifeste(port_outils: int, jeton: str, relais: bool) -> dict:
    url = f"http://127.0.0.1:{port_outils}"
    return {"toolHosts": {"main": {"url": url, "token": jeton}},
            "mcpServers": {"elpis-tools": {"type": "http", "url": f"{url}/mcp",
                                           "headers": {"Authorization": f"Bearer {jeton}"},
                                           "x-elpis": {"role": "toolhost"}}},
            "sandboxHosts": {"main": {"url": url, "token": jeton, "relay": relais}},
            "placement": {"strategy": "single", "host": "main"}}


def _attendre(url: str, proc: subprocess.Popen, journal: Path, attente_max: float) -> bool:
    import httpx
    limite = time.monotonic() + attente_max
    while time.monotonic() < limite:
        if proc.poll() is not None:
            raise RuntimeError(f"{journal.name} : arrêt au démarrage :\n"
                               + journal.read_text(errors="replace")[-4000:])
        try:
            if httpx.get(url, timeout=2.0).status_code == 200:
                return True
        except Exception:
            time.sleep(0.2)
    return False


def demarrer(base: Path, *, comptes: int = 8,
             config_extra: Optional[dict] = None,
             fichiers_sandbox: int = 0,
             attente_max: float = 90.0,
             relais: bool = True) -> Instance:
    """Lance l'hôte d'outils puis l'application ; ``relais`` : main relaie les routes de l'hôte."""
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
    port, port_outils = port_libre(), port_libre()
    jeton = secrets.token_urlsafe(24)
    (base / "mcp.json").write_text(json.dumps(_manifeste(port_outils, jeton, relais)),
                                   encoding="utf-8")

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
        "APP_MCP_MANIFEST": str(base / "mcp.json"),
        "LOCAL_MCP_URL": f"http://127.0.0.1:{port_outils}/mcp",
        "LOCAL_MCP_TOKEN": jeton,
    })
    journal_outils = base / "logs" / "toolhost.log"
    with open(journal_outils, "wb") as sortie:
        outils = subprocess.Popen(
            [PYTHON, "-m", "toolhost"], cwd=str(ROOT), stdout=sortie,
            stderr=subprocess.STDOUT, start_new_session=True,
            env=dict(env, LOCAL_MCP_TRANSPORT="streamable-http", LOCAL_MCP_HOST="127.0.0.1",
                     LOCAL_MCP_PORT=str(port_outils)))
    try:
        if not _attendre(f"http://127.0.0.1:{port_outils}/health", outils, journal_outils, attente_max):
            raise RuntimeError("l'hôte d'outils n'a pas répondu :\n"
                               + journal_outils.read_text(errors="replace")[-4000:])
        return _demarrer_application(base, env, port, outils, noms, attente_max)
    except BaseException:
        _arreter_groupe(outils)
        raise


def _demarrer_application(base: Path, env: dict, port: int, outils: subprocess.Popen, noms: list[str],
                          attente_max: float) -> Instance:
    if not CORE.is_file():
        raise RuntimeError(f"{CORE} absent : construire le core (npm run build)")
    env = dict(env, APP_MODE="main", APP_SERVICE="main", ELPIS_RACINE=str(ROOT),
               MAIN_INTERNAL_URL=f"http://127.0.0.1:{port}")
    with open(base / "logs" / "serveur.log", "wb") as journal:
        proc = subprocess.Popen(
            [NODE, "--enable-source-maps", str(CORE)], cwd=str(ROOT), env=env, stdout=journal,
            stderr=subprocess.STDOUT, start_new_session=True)

    inst = Instance(base=base, port=port, proc=proc, comptes=noms, outils=outils)
    try:
        if _attendre(f"{inst.url}/api/health", proc, base / "logs" / "serveur.log", attente_max):
            return inst
    except RuntimeError:
        inst.arreter()
        raise
    inst.arreter()
    raise RuntimeError(
        f"le serveur n'a pas répondu en {attente_max:.0f} s :\n"
        + (base / "logs" / "serveur.log").read_text(errors="replace")[-4000:])


def attendre_stabilisation(inst: Instance, *, patience: float = 25.0,
                           calme: float = 3.0, marge_mo: float = 4.0) -> dict:
    """Attend que la mémoire cesse de monter avant de mesurer quoi que ce soit.

    Répondre à ``/api/health`` ne veut pas dire « en régime » : le boot
    déclenche en tâche de fond le préchauffage du pool MCP (connexions à
    l'hôte d'outils). Sans cette attente, la première sonde tombe avant et la
    « dérive de RSS » du scénario mesure en réalité un démarrage.

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
