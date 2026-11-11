# SPDX-License-Identifier: MIT
"""tests/conftest.py — isolation des ressources RÉELLES de la machine : configuration, données de l'instance, moteur LLM."""
from __future__ import annotations

import atexit
import os
import shutil
import tempfile
from pathlib import Path


# ── Configuration d'instance et moteur LLM : jamais ceux de la machine ───────
# Le core et les services lancés par un test lisent ``config.json`` et
# ``LLAMA_IP``/``LLAMA_PORT`` au démarrage : ces variables sont donc posées ici,
# avant tout. Sans elles, la suite lancée depuis une copie qui porte un vrai
# ``config.json`` (HTTPS actif, moteur du réseau local) échoue sans défaut du
# code (URL ``https://``, certificat auto-signé, goldens qui dérivent) ou
# attend ~9 s par appel un moteur qui ne répond pas ; un ``llama-server`` local
# sur le port 8080 serait, lui, réellement interrogé.
#   - ``APP_CONFIG_PATH`` : fichier absent dans un dossier temporaire — la
#     configuration vaut ``{}``, comme en CI, et une écriture de la
#     configuration par un test n'atteint jamais le vrai fichier ;
#   - ``LLAMA_IP=127.0.0.1``, ``LLAMA_PORT=1`` : connexion refusée tout de suite ;
#   - ``ELPIS_AUDIT_DIR`` : dossier temporaire — le journal d'audit de sécurité
#     ne reçoit jamais les actions d'administration fictives des tests ; sans
#     lui, elles iraient dans ``logs/audit`` de la copie de travail, ou dans
#     ``/var/lib/elpis`` ;
#   - ``APP_DB_PATH``, ``APP_SANDBOX_DIR``, ``APP_FILE_HISTORY_DIR``,
#     ``APP_USER_SKILLS_DIR``, ``SKILLS_LOCK_PATH`` : données de l'instance dans le dossier
#     temporaire. Sans eux, les chemins par défaut désignent ``user_db/``,
#     ``user_sandboxes/`` et ``user_skills/`` de la copie de travail, c'est-à-dire
#     les données réelles de l'instance : secret de session (posé à côté de la
#     base), historique des fichiers, instantanés et verrous de sandbox, y compris
#     pour les sous-processus lancés par un test.
# Une valeur déjà présente dans l'environnement prime : un développeur peut
# toujours viser sa configuration ou son moteur. Les workers xdist héritent de
# l'environnement du processus principal, donc du même dossier.
def _isoler_configuration_et_moteur() -> None:
    dossier: list[str] = []

    def _temporaire(nom: str) -> str:
        if not dossier:
            dossier.append(tempfile.mkdtemp(prefix="elpis-tests-"))
            atexit.register(shutil.rmtree, dossier[0], ignore_errors=True)
        return os.path.join(dossier[0], nom)

    if not os.environ.get("APP_CONFIG_PATH"):
        os.environ["APP_CONFIG_PATH"] = _temporaire("config.json")
    if not os.environ.get("ELPIS_AUDIT_DIR"):
        os.environ["ELPIS_AUDIT_DIR"] = _temporaire("audit")
    for variable, nom in (("APP_DB_PATH", os.path.join("user_db", "app.db")),
                          ("APP_SANDBOX_DIR", "user_sandboxes"),
                          ("APP_FILE_HISTORY_DIR", "file_history"),
                          ("APP_USER_SKILLS_DIR", "user_skills"),
                          ("SKILLS_LOCK_PATH", ".skills_write.lock")):
        if not os.environ.get(variable):
            os.environ[variable] = _temporaire(nom)
    os.environ.setdefault("LLAMA_IP", "127.0.0.1")
    os.environ.setdefault("LLAMA_PORT", "1")


_isoler_configuration_et_moteur()


# Fichiers de configuration RÉELS du dépôt : la suite ne doit ni les créer ni
# les modifier (une instance lancée depuis ce dépôt les lit au démarrage).
_FICHIERS_REELS = ("config.json", "mcp.json", ".env")


def _empreinte_fichiers_reels() -> dict:
    racine = Path(__file__).resolve().parents[1]
    vus = {}
    for rel in _FICHIERS_REELS:
        try:
            st = (racine / rel).stat()
            vus[rel] = (st.st_mtime_ns, st.st_size)
        except FileNotFoundError:
            vus[rel] = None
    return vus


def pytest_sessionstart(session):
    session.config._fichiers_reels = _empreinte_fichiers_reels()


def pytest_sessionfinish(session, exitstatus):
    if hasattr(session.config, "workerinput"):         # contrôleur xdist seul
        return
    avant = getattr(session.config, "_fichiers_reels", None)
    if avant is None:
        return
    touches = [rel for rel, e in _empreinte_fichiers_reels().items() if e != avant.get(rel)]
    if touches:
        session.config.get_terminal_writer().line(
            "ÉCHEC : la suite a créé ou modifié des fichiers réels du dépôt : "
            + ", ".join(touches), red=True)
        session.exitstatus = 1
