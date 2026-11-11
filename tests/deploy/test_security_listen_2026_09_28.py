# SPDX-License-Identifier: MIT
"""Réglage ``security.listen`` (« local » → 127.0.0.1, « lan » → 0.0.0.0).

Le bind lui-même est couvert par ``test_gunicorn_bind.py``. Ici, les
écrivains du réglage :

* assistant d'installation : défaut « local » en installation neuve, valeur
  en place (ou « lan » si la clé manque) en réinstallation, transmis à
  ``configure`` par ``--listen`` ;
* ``configure`` en lignes : même règle, écriture dans ``config.json``.
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "deploy"))

import configure as C  # noqa: E402
import wizard as W  # noqa: E402

# ── Assistant d'installation ─────────────────────────────────────────────────

@pytest.fixture
def repo(tmp_path, monkeypatch):
    root = tmp_path / "repo"
    (root / "rag_app").mkdir(parents=True)
    shutil.copy(REPO / "config.example.json", root / "config.example.json")
    monkeypatch.setattr(W, "ROOT", root)
    monkeypatch.setattr(W.C, "CONFIG", root / "config.json")
    monkeypatch.setattr(W.C, "ENV_FILE", root / ".env")
    monkeypatch.setattr(W.C, "DB_PASSWORD_FILE", root / "user_db" / ".db_password")
    for k in ("ELPIS_WIZ_OFFLINE", "ELPIS_WIZ_PRESET", "ELPIS_WIZ_CONFIGURE_ARGS", "ELPIS_CFG_LISTEN"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("ELPIS_WIZ_ADMIN", "1")
    return root


def _state(mode="install"):
    ctx = W.Ctx(mode)
    return ctx, W.initial_state(ctx)


def test_installation_neuve_ecoute_locale(repo):
    ctx, st = _state()
    assert st["listen"] == "local"
    acces = next(p for p in W.build_pages(ctx) if p.key == "acces")
    field = next(f for f in acces.fields if f.key == "listen")
    assert field.visible(st)
    st["https"] = "local"
    assert not field.visible(st), "sans objet en HTTPS"


@pytest.mark.parametrize("security,attendu", [({}, "lan"), ({"listen": "local"}, "local"),
                                              ({"listen": "lan"}, "lan")])
def test_reinstallation_conserve_l_existant(repo, security, attendu):
    (repo / "config.json").write_text(json.dumps({"security": security}), encoding="utf-8")
    _ctx, st = _state("configure")
    assert st["listen"] == attendu


def test_option_de_la_ligne_de_commande(repo, monkeypatch):
    monkeypatch.setenv("ELPIS_WIZ_CONFIGURE_ARGS", json.dumps(["--listen", "lan"]))
    assert _state()[1]["listen"] == "lan"


def test_transmis_a_configure_et_resume(repo):
    ctx, st = _state()
    st.update({"db_mode": "sqlite", "https": "off", "listen": "local"})
    argv = W.build_outputs(st, "install", False)["configure"]["argv"]
    assert argv[argv.index("--listen") + 1] == "local"
    rows = dict(next(r for t, r in W.summary(st, ctx) if t == "Accès"))
    assert rows["Écoute"].startswith("ce serveur seulement")
    st["https"] = "local"
    assert "--listen" not in W.build_outputs(st, "install", False)["configure"]["argv"]


# ── configure en lignes ──────────────────────────────────────────────────────

def _access(repo, monkeypatch, cfg, *argv):
    monkeypatch.setattr(C, "ENV_FILE", repo / ".env")
    monkeypatch.setattr(C, "port_in_use", lambda port: False)
    monkeypatch.setattr(C.shutil, "which", lambda name: "/usr/bin/caddy")
    a = C.build_parser().parse_args(["--yes", *argv])
    C.step_access(C.Prompter(False), a, cfg, {})
    return cfg["security"]


def test_configure_ecrit_l_ecoute(repo, monkeypatch):
    assert _access(repo, monkeypatch, {"security": {}}, "--https", "off")["listen"] == "lan"
    assert _access(repo, monkeypatch, C.read_json(repo / "config.example.json"),
                   "--https", "off")["listen"] == "local"
    assert _access(repo, monkeypatch, {"security": {"listen": "local"}},
                   "--https", "off", "--listen", "lan")["listen"] == "lan"
    # HTTPS : sans objet, rien d'écrit (sauf demande explicite).
    assert "listen" not in _access(repo, monkeypatch, {"security": {}}, "--https", "local")
    with pytest.raises(SystemExit):
        C.build_parser().parse_args(["--listen", "tout"])
