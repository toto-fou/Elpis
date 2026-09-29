# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_automation_bundle_2026_09_12.py — POST /api/desktop/automation-bundle.

Un script du Studio téléchargé seul ne tourne nulle part sans le runtime : le
bundle zip embarque le .py, ``elpis_auto`` et ses backends, un requirements.txt
SANS les paquets du serveur HTTP, des lanceurs qui créent un venv local, et un
README. Le script seul reste un téléchargement client (runtime déjà en place).
"""
from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient


@pytest.fixture()
def client(monkeypatch):
    # ⚠ Ordre d'import : ``shared_infra.routes`` (chef d'orchestre) AVANT le module
    # de famille, sinon import circulaire desktop.routes → opencode.routes_cli →
    # routes._state → routes/__init__ → routes_code → routes_cli (partiel).
    import shared_infra.desktop.routes as rt
    import shared_infra.routes  # noqa: F401

    def _fake_uid(request: Request):
        uid = request.headers.get("x-test-user")
        if not uid:
            raise HTTPException(401, "auth requise")
        return int(uid)

    monkeypatch.setattr(rt, "require_user_id", _fake_uid)
    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


_H = {"x-test-user": "1"}
CODE = 'from elpis_auto import Session\ns = Session()\ns.click(name="OK")\nraise SystemExit(s.finish())\n'


def _names(r):
    return set(zipfile.ZipFile(io.BytesIO(r.content)).namelist())


def test_bundle_contient_script_runtime_requirements_et_lanceurs(client):
    r = client.post("/api/desktop/automation-bundle",
                    json={"name": "Flux de connexion", "code": CODE, "os": "windows"}, headers=_H)
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/zip")
    assert 'filename="flux-de-connexion.zip"' in r.headers["content-disposition"]
    names = _names(r)
    for n in ("flux-de-connexion/flux-de-connexion.py", "flux-de-connexion/elpis_auto/session.py",
              "flux-de-connexion/elpis_auto/__main__.py", "flux-de-connexion/backends/windows.py",
              "flux-de-connexion/backends/__init__.py", "flux-de-connexion/normalize.py",
              "flux-de-connexion/requirements.txt", "flux-de-connexion/run.bat",
              "flux-de-connexion/run.sh", "flux-de-connexion/README.txt"):
        assert n in names, n
    assert not any(n.endswith(".pyc") or "__pycache__" in n for n in names)
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert z.read("flux-de-connexion/flux-de-connexion.py").decode() == CODE
    req = z.read("flux-de-connexion/requirements.txt").decode()
    assert "pywinauto" in req and "fastapi" not in req and "uvicorn" not in req
    assert "python -m elpis_auto" in z.read("flux-de-connexion/README.txt").decode()
    bat = z.read("flux-de-connexion/run.bat").decode()
    assert "-m elpis_auto" in bat and "flux-de-connexion.py" in bat and "requirements.txt" in bat
    assert z.getinfo("flux-de-connexion/run.sh").external_attr >> 16 & 0o111, "run.sh exécutable"
    # Lanceur Windows : robuste (vu sur VM) — pas de parenthèse dans un echo d'un
    # bloc if (cmd fermait le bloc : « ... était inattendu »), dépendances
    # (ré)installées tant que le marqueur manque, wheels hors ligne d'abord, DLL
    # pywin32 posées à côté de python.exe.
    for line in bat.splitlines():
        if line.strip().lower().startswith("echo "):
            assert "(" not in line and ")" not in line, line
    assert "deps-ok" in bat and "wheels\\windows" in bat and "--no-index" in bat and "pywin32_system32" in bat
    assert "python-win" in bat, "le Python 3.11 de l'agent, s'il est à côté, prime (celui des wheels)"
    # Lancé par DOUBLE-CLIC (vu sur VM : la fenêtre disparaissait = « crash ») : la
    # console reste ouverte pour lire le résultat, y compris quand l'installation
    # échoue (:die) — et jamais de « exit /b 2 » enfoui dans un bloc entre parenthèses.
    assert bat.count("pause") == 2 and ":die" in bat and "%CMDCMDLINE%" in bat
    assert "|| exit /b" not in bat and "goto die" in bat
    assert "set RC=%ERRORLEVEL%" in bat and "exit /b %RC%" in bat
    sh = z.read("flux-de-connexion/run.sh").decode()
    assert "deps-ok" in sh and "wheels/linux" in sh
    readme = z.read("flux-de-connexion/README.txt").decode()
    assert "DEPUIS LE BUREAU" in readme and "mfc140u" in readme
    assert not any("/wheels/" in n for n in names), "sans include_wheels, pas de wheels"


@pytest.mark.skipif(not (Path(__file__).resolve().parents[2] / "desktop-agent" / "wheels").is_dir(),
                    reason="roues hors-ligne absentes (produites par make_release.sh)")
def test_bundle_avec_wheels_hors_ligne(client):
    r = client.post("/api/desktop/automation-bundle",
                    json={"name": "x", "code": CODE, "os": "windows", "include_wheels": True}, headers=_H)
    assert r.status_code == 200
    z = zipfile.ZipFile(io.BytesIO(r.content))
    wheels = [n for n in z.namelist() if n.startswith("x/wheels/windows/") and n.endswith(".whl")]
    assert wheels and any("pywinauto" in n for n in wheels) and not any("fastapi" in n for n in wheels) or wheels
    assert all(z.getinfo(n).compress_type == zipfile.ZIP_STORED for n in wheels), "wheels déjà compressées"
    assert "wheels/windows/" in z.read("x/README.txt").decode()


def test_bundle_linux_requirements(client):
    r = client.post("/api/desktop/automation-bundle", json={"name": "x", "code": CODE, "os": "linux"}, headers=_H)
    req = zipfile.ZipFile(io.BytesIO(r.content)).read("x/requirements.txt").decode()
    assert "PyGObject" in req and "pywinauto" not in req and "fastapi" not in req


def test_bundle_slug_et_erreurs(client):
    r = client.post("/api/desktop/automation-bundle", json={"name": "  ", "code": CODE}, headers=_H)
    assert r.status_code == 200 and "automatisation/automatisation.py" in _names(r)
    r = client.post("/api/desktop/automation-bundle", json={"name": "../../etc", "code": CODE}, headers=_H)
    assert all(not n.startswith(("..", "/")) for n in _names(r)) and "etc/etc.py" in _names(r)
    assert client.post("/api/desktop/automation-bundle", json={"name": "a", "code": ""}, headers=_H).status_code == 400
    assert client.post("/api/desktop/automation-bundle", json={"name": "a", "code": CODE}).status_code == 401


def test_bundle_embarque_lib_et_vignettes(client):
    import base64
    r = client.post("/api/desktop/automation-bundle",
                    json={"name": "x", "code": 's.click(image="assets/el_b-abc.png")\n', "os": "windows",
                          "libs": {"lib/connexion.py": "def login():\n    pass\n", "../evil.py": "x", "lib/../../y.py": "x"},
                          "assets": {"assets/el_b-abc.png": base64.b64encode(b"\x89PNG\r\n\x1a\n").decode(), "assets/bad.png": "%%%"}},
                    headers=_H)
    assert r.status_code == 200
    z = zipfile.ZipFile(io.BytesIO(r.content))
    names = set(z.namelist())
    assert "x/lib/connexion.py" in names and "x/lib/__init__.py" in names
    assert "x/assets/el_b-abc.png" in names and z.read("x/assets/el_b-abc.png").startswith(b"\x89PNG")
    assert not any("evil" in n or "y.py" in n or "bad.png" in n for n in names), "chemins hors lib/assets et base64 invalide ignorés"


def test_locate_par_la_vision(client, monkeypatch):
    import base64

    import llm_core._detection_client as dc
    import shared_infra.desktop.routes as rt
    monkeypatch.setattr(rt._cfg, "VISION_ENDPOINT_URL", "http://vision", raising=False)
    for k, v in (("VISION_FORMAT", "omniparser"), ("VISION_RESPONSE_MAP", {}), ("VISION_TIMEOUT_SEC", 5)):
        monkeypatch.setattr(rt._cfg, k, v, raising=False)
    seen = {}

    def fake_detect(png, **kw):
        seen.update(kw)
        return [{"box": [10, 10, 50, 30], "label": "bouton vert", "confidence": 0.9},
                {"box": [100, 100, 120, 120], "label": "autre", "confidence": 0.4}]
    monkeypatch.setattr(dc, "detect", fake_detect)
    monkeypatch.setattr("llm_core.tools.desktop_tools._png_size", lambda png: (640, 360))
    png_b64 = base64.b64encode(b"\x89PNG\r\n\x1a\nfake").decode()
    r = client.post("/api/desktop/locate", json={"image_b64": png_b64, "describe": "le bouton vert"}, headers=_H)
    assert r.status_code == 200 and r.json()["box"] == [10, 10, 50, 30] and r.json()["confidence"] == 0.9
    assert seen["prompt"] == "le bouton vert"
    # jeton elpis-remote en Bearer (le script tourne sur la VM, sans cookie)
    monkeypatch.setattr("shared_infra.opencode.routes_code._resolve_token", lambda tok: 7 if tok == "pcr_ok" else None, raising=False)
    r2 = client.post("/api/desktop/locate", json={"image_b64": png_b64, "describe": "x"}, headers={"Authorization": "Bearer pcr_ok"})
    assert r2.status_code == 200
    assert client.post("/api/desktop/locate", json={"image_b64": png_b64, "describe": "x"}, headers={"Authorization": "Bearer pcr_ko"}).status_code == 401
    assert client.post("/api/desktop/locate", json={"describe": "x"}, headers=_H).status_code == 400
    monkeypatch.setattr(dc, "detect", lambda png, **kw: [])
    assert client.post("/api/desktop/locate", json={"image_b64": png_b64, "describe": "rien"}, headers=_H).status_code == 404
