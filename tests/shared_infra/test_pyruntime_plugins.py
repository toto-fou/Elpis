# SPDX-License-Identifier: MIT
"""Plugins pydantic coupés : le venv en porte un que rien ne demande.

``pydantic`` balaie les entry points du groupe ``pydantic`` au premier modèle
construit et importe ce qu'il trouve. Le venv déclare
``logfire-plugin -> logfire.integrations.pydantic:plugin`` — or **aucun module
du dépôt n'importe logfire**. Le charger traîne opentelemetry (132 modules),
rich, requests et les stubs protobuf ``google`` dans CHAQUE worker et dans
chaque sous-process MCP.

Les tests d'effet réel passent par un sous-process : le process pytest a déjà
importé pydantic et posé le drapeau, il ne peut rien prouver sur lui-même.
"""
from __future__ import annotations

import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from shared_infra.runtime import pyruntime

ROOT = Path(__file__).resolve().parents[2]


def _run(code: str, env_extra: dict | None = None) -> str:
    env = dict(os.environ)
    env.pop(pyruntime.PYDANTIC_PLUGINS_FLAG, None)
    env["PYTHONPATH"] = str(ROOT)
    env.update(env_extra or {})
    out = subprocess.run([sys.executable, "-c", textwrap.dedent(code)],
                         cwd=ROOT, env=env, capture_output=True, text=True, timeout=180)
    assert out.returncode == 0, out.stderr[-3000:]
    return out.stdout


# ── Le drapeau lui-même ─────────────────────────────────────────────────────

def test_le_drapeau_est_pose_a_l_import(monkeypatch):
    monkeypatch.delenv(pyruntime.PYDANTIC_PLUGINS_FLAG, raising=False)
    assert pyruntime.disable_pydantic_plugins() is True
    assert os.environ[pyruntime.PYDANTIC_PLUGINS_FLAG] == "1"


def test_un_choix_de_l_exploitant_prime(monkeypatch):
    """``PYDANTIC_DISABLE_PLUGINS=0`` doit rester une échappatoire."""
    monkeypatch.setenv(pyruntime.PYDANTIC_PLUGINS_FLAG, "0")
    assert pyruntime.disable_pydantic_plugins() is False
    assert os.environ[pyruntime.PYDANTIC_PLUGINS_FLAG] == "0"


def test_la_valeur_deja_posee_n_est_pas_ecrasee(monkeypatch):
    monkeypatch.setenv(pyruntime.PYDANTIC_PLUGINS_FLAG, "__all__")
    assert pyruntime.disable_pydantic_plugins() is False
    assert os.environ[pyruntime.PYDANTIC_PLUGINS_FLAG] == "__all__"


def test_valeur_reconnue_par_pydantic():
    """La valeur posée doit faire partie de celles que pydantic honore —
    sinon le drapeau serait décoratif."""
    from pydantic.plugin import _loader
    src = Path(_loader.__file__).read_text(encoding="utf-8")
    assert "'1'" in src or '"1"' in src, \
        "pydantic n'accepte plus '1' : revoir la valeur posée par pyruntime"


# ── Effet réel, mesuré en sous-process ──────────────────────────────────────

PROBE = """
    import sys
    {prelude}
    from fastapi import FastAPI          # construit des modèles pydantic
    FastAPI()
    print("logfire" in sys.modules, "opentelemetry" in sys.modules, len(sys.modules))
"""


def test_sans_le_garde_fou_logfire_est_bien_charge():
    """Témoin : la dépendance existe et se charge toute seule. Si ce test
    échoue un jour, c'est que logfire a quitté le venv — le garde-fou devient
    alors sans objet, mais reste correct."""
    logfire, otel, _ = _run(PROBE.format(prelude="")).split()
    if logfire != "True":
        pytest.skip("logfire n'est plus installé : plus rien à couper")
    assert otel == "True"


def test_le_garde_fou_evite_logfire_et_opentelemetry():
    out = _run(PROBE.format(prelude="import shared_infra.runtime.pyruntime"))
    logfire, otel, _n = out.split()
    assert (logfire, otel) == ("False", "False")


def test_l_import_du_paquet_server_suffit():
    """Le point d'entrée réel : gunicorn importe ``server.app``, ce qui passe
    par ``server/__init__.py``. Rien d'autre à poser côté exploitant."""
    out = _run("""
        import sys, os
        import server                    # noqa: F401
        print(os.environ.get("PYDANTIC_DISABLE_PLUGINS"), "logfire" in sys.modules)
    """)
    flag, logfire = out.split()
    assert flag == "1" and logfire == "False"


def test_le_serveur_mcp_local_pose_le_garde_fou_lui_meme():
    """Il est lancé PAR CHEMIN (``python server/local_mcp_server.py``) :
    ``server/__init__.py`` ne s'exécute pas. Le fichier doit donc importer
    ``pyruntime`` lui-même, AVANT fastmcp."""
    src = (ROOT / "server" / "local_mcp_server.py").read_text(encoding="utf-8")
    i_run = src.index("import shared_infra.runtime.pyruntime")
    i_mcp = src.index("from fastmcp import")
    assert i_run < i_mcp, "le garde-fou doit précéder l'import de fastmcp"


# ── FastMCP : aucun appel sortant au démarrage ──────────────────────────────

def test_les_reglages_fastmcp_sont_poses(monkeypatch):
    for cle in pyruntime.FASTMCP_OFFLINE_SETTINGS:
        monkeypatch.delenv(cle, raising=False)
    assert set(pyruntime.keep_fastmcp_offline()) == set(pyruntime.FASTMCP_OFFLINE_SETTINGS)
    assert os.environ["FASTMCP_CHECK_FOR_UPDATES"] == "off"


def test_un_choix_de_l_exploitant_prime_aussi_sur_fastmcp(monkeypatch):
    monkeypatch.setenv("FASTMCP_CHECK_FOR_UPDATES", "stable")
    posees = pyruntime.keep_fastmcp_offline()
    assert "FASTMCP_CHECK_FOR_UPDATES" not in posees
    assert os.environ["FASTMCP_CHECK_FOR_UPDATES"] == "stable"


def test_fastmcp_honore_bien_le_reglage():
    """Le réglage doit être RECONNU par fastmcp, pas seulement posé : c'est le
    seul point qui prouve que la version installée n'ira pas sur le réseau."""
    out = _run("""
        import shared_infra.runtime.pyruntime
        import fastmcp
        print(fastmcp.settings.check_for_updates)
    """)
    assert out.strip() == "off", f"fastmcp ignore le réglage (valeur vue : {out.strip()!r})"


def test_aucune_cle_fastmcp_morte():
    """Une clé que fastmcp ne connaît plus est un no-op silencieux : on ne veut
    pas continuer à la poser en croyant qu'elle protège quelque chose. Le préfixe
    d'environnement de fastmcp est ``FASTMCP_`` ; le champ correspondant est le
    reste de la clé en minuscules."""
    import fastmcp
    champs = set(fastmcp.settings.__class__.model_fields)
    inconnues = [cle for cle in pyruntime.FASTMCP_OFFLINE_SETTINGS
                 if cle.removeprefix("FASTMCP_").lower() not in champs]
    assert not inconnues, (
        f"clés ignorées par fastmcp {fastmcp.__version__} : {inconnues} — "
        "à retirer ou à remplacer par l'argument correspondant au point d'appel")


def test_la_banniere_est_coupee_au_point_d_appel():
    """La bannière ne se coupe plus par l'environnement (renommée en amont et
    réduite à la CLI) : elle doit l'être par l'argument de ``mcp.run``, qui vaut
    pour toutes les versions. Sans ça, un pavé ASCII part sur stderr — donc dans
    le journal du worker — à chaque démarrage de sous-process MCP."""
    src = (ROOT / "server" / "local_mcp_server.py").read_text(encoding="utf-8")
    appels = [l.strip() for l in src.splitlines() if "mcp.run(" in l]
    assert appels, "aucun appel à mcp.run trouvé"
    sans_garde = [a for a in appels if "show_banner=False" not in a]
    assert not sans_garde, f"appels sans coupure de bannière : {sans_garde}"


def test_le_serveur_mcp_local_n_appelle_pas_pypi(tmp_path):
    """Vérification de bout en bout sur le VRAI point d'entrée : le cache de
    version de fastmcp ne doit plus être écrit. ``FASTMCP_HOME`` est détourné
    vers un dossier jetable pour ne pas dépendre de l'état de la machine."""
    faux_home = tmp_path / "fastmcp-home"
    cache = faux_home / "version_cache.json"
    out = subprocess.run(
        [sys.executable, "server/local_mcp_server.py"],
        cwd=ROOT, stdin=subprocess.DEVNULL, capture_output=True, timeout=180,
        env={**os.environ, "FASTMCP_HOME": str(faux_home),
             "PYTHONPATH": str(ROOT), "LLAMA_IP": "127.0.0.1", "LLAMA_PORT": "1"})
    assert not cache.exists(), (
        "fastmcp a interrogé pypi.org au démarrage du serveur MCP "
        f"(cache écrit dans {cache}). Sortie : {out.stderr[-500:]!r}")


def test_le_service_rag_est_couvert_sans_importer_shared_infra():
    """``rag_app`` se déploie seul (``uvicorn app:app`` depuis son dossier) :
    il ne peut pas importer ``shared_infra``, d'où la recopie du réglage."""
    src = (ROOT / "rag_app" / "app.py").read_text(encoding="utf-8")
    i_flag = src.index("PYDANTIC_DISABLE_PLUGINS")
    i_fastapi = src.index("from fastapi import")
    assert i_flag < i_fastapi, "le réglage doit précéder l'import de fastapi"
    assert "import shared_infra" not in src.split("from fastapi import")[0], \
        "rag_app doit rester déployable sans shared_infra"
