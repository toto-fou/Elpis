# SPDX-License-Identifier: MIT
"""Assistant d'installation par pages (``deploy/tui.py``, ``deploy/wizard.py``).

Défauts corrigés, un test chacun :

* les choix d'une page désactivent les saisies qui n'ont plus de sens
  ailleurs (sans Caddy, pas de HTTPS ; sans droits admin, rien qui en
  demande ; moteur vocal local, adresses fixées) ;
* le choix de la base arrive jusqu'à la configuration (options de
  ``configure``), y compris une base locale ;
* toutes les réponses sont prises d'abord, puis appliquées sans question
  (``configure --answers``) ; les secrets ne passent pas par la ligne de
  commande.
"""
from __future__ import annotations

import fcntl
import json
import os
import pty
import select
import shutil
import stat
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "deploy"))

import tui as T  # noqa: E402
import wizard as W  # noqa: E402


# ── Clavier et rendu ─────────────────────────────────────────────────────────

def test_touches():
    assert T.parse_keys(b"\x1b[A\x1b[B\x1b[C\x1b[D") == ["up", "down", "right", "left"]
    assert T.parse_keys(b"\x1b[Z\t\r \x7f") == ["shift-tab", "tab", "enter", "space", "backspace"]
    assert T.parse_keys(b"\x1b[3~\x1b[1;5C\x1bOH") == ["delete", "right", "home"]
    assert T.parse_keys("é€".encode()) == ["é", "€"]
    assert T.parse_keys(b"\x1b") == ["esc"]
    assert T.parse_keys(b"\x1b[200~ab\x1b[201~") == ["a", "b"]           # collage encadré


def test_ligne_tronquee_a_la_largeur():
    line = T.render_line([("abc", "b"), ("x" * 50, "d")], 20)
    assert T.visible_len(line) == 20 and line.endswith("…\x1b[0m")


# ── Assistant sans terminal ──────────────────────────────────────────────────

@pytest.fixture
def ctx_env(tmp_path, monkeypatch):
    """Dépôt vierge (pas de config.json) ; droits admin selon le test."""
    root = tmp_path / "repo"
    (root / "rag_app").mkdir(parents=True)
    shutil.copy(REPO / "config.example.json", root / "config.example.json")
    shutil.copy(REPO / "rag_app" / "rag_config.example.json", root / "rag_app" / "rag_config.example.json")
    monkeypatch.setattr(W, "ROOT", root)
    monkeypatch.setattr(W.C, "CONFIG", root / "config.json")
    monkeypatch.setattr(W.C, "RAG_CONFIG", root / "rag_app" / "rag_config.json")
    monkeypatch.setattr(W.C, "ENV_FILE", root / ".env")
    monkeypatch.setattr(W.C, "DB_PASSWORD_FILE", root / "user_db" / ".db_password")
    for k in ("ELPIS_WIZ_ADMIN", "ELPIS_WIZ_OFFLINE", "ELPIS_WIZ_PRESET", "ELPIS_WIZ_CONFIGURE_ARGS"):
        monkeypatch.delenv(k, raising=False)
    return root


def _wizard(mode="install", admin=True, monkeypatch=None):
    if monkeypatch:
        monkeypatch.setenv("ELPIS_WIZ_ADMIN", "1" if admin else "0")
    ctx = W.Ctx(mode)
    st = W.initial_state(ctx)
    st["db_port"] = st.get("db_port") or "5432"
    wiz = T.Wizard("t", W.build_pages(ctx), st)
    return ctx, st, wiz


def _page(wiz, key):
    for i, p in enumerate(wiz.pages):
        if p.key == key:
            wiz.page_i = i
            wiz.focus = 0
            return p
    raise KeyError(key)


def _opt_reason(page, field_key, value, st):
    f = next(f for f in page.fields if f.key == field_key)
    opts = f.opts(st) if isinstance(f, T.Radio) else f.options
    return next(o for o in opts if o.value == value).disabled(st)


def test_sans_caddy_pas_de_https(ctx_env, monkeypatch):
    ctx, st, wiz = _wizard(monkeypatch=monkeypatch)
    ctx.have["caddy"] = False
    acces = _page(wiz, "acces")
    assert _opt_reason(acces, "https", "local", st) == "cochez Caddy (page Composants)"
    st["components"] = sorted(set(st["components"]) | {"caddy"})
    assert _opt_reason(acces, "https", "local", st) is None
    st["https"] = "local"
    st["components"].remove("caddy")        # décoché ensuite : le HTTPS retombe
    wiz.normalize()
    assert st["https"] == "off"


def test_sans_droits_admin_rien_qui_en_demande(ctx_env, monkeypatch):
    ctx, st, wiz = _wizard(admin=False, monkeypatch=monkeypatch)
    comp = _page(wiz, "comp")
    for k in ("office", "caddy", "voice"):
        assert _opt_reason(comp, "components", k, st) == "droits administrateur requis"
    assert "office" not in st["components"]
    base = _page(wiz, "base")
    assert _opt_reason(base, "db_mode", "postgres-local", st) == "droits administrateur requis"
    fin = _page(wiz, "fin")
    assert _opt_reason(fin, "after", "service", st)
    assert st["after"] != "service"


def test_moteur_vocal_local_fixe_les_adresses(ctx_env, monkeypatch):
    ctx, st, wiz = _wizard(monkeypatch=monkeypatch)
    voix = _page(wiz, "voix")
    shown = {f.key for f in voix.shown(st)}
    assert "voice" in shown and "_voice_local" in shown
    st["components"].append("voice")
    shown = {f.key for f in voix.shown(st) if not isinstance(f, T.Note) or f.text(st)}
    assert shown == {"_voice_local"}
    out = W.build_outputs(W.finalize(st), "install", False)["configure"]["argv"]
    assert out[out.index("--voice") + 1] == "on" and "http://127.0.0.1:8090" in out


def test_base_locale_rien_a_saisir_et_transmise_a_configure(ctx_env, monkeypatch):
    ctx, st, wiz = _wizard(monkeypatch=monkeypatch)
    base = _page(wiz, "base")
    st["db_mode"] = "postgres-local"
    assert not any(isinstance(f, T.Text) for f in base.shown(st))
    out = W.build_outputs(W.finalize(st), "install", False)
    argv = out["configure"]["argv"]
    assert out["install"]["DB_MODE"] == "postgres-local"
    assert argv[argv.index("--db") + 1] == "postgres" and argv[argv.index("--db-host") + 1] == "127.0.0.1"
    assert "ELPIS_CFG_DB_PASSWORD" not in out["configure"]["env"]      # fichier écrit par install.sh


def test_serveur_existant_secret_hors_ligne_de_commande(ctx_env, monkeypatch):
    ctx, st, wiz = _wizard(monkeypatch=monkeypatch)
    st.update(db_mode="external", db_engine="mysql", db_host="db.lan", db_port="3306",
              db_password="s3cret", admin_password="motdepasse1", cloud=True,
              cloud_provider="mistral", cloud_key="clé-api")
    out = W.build_outputs(W.finalize(st), "install", False)
    argv, env = out["configure"]["argv"], out["configure"]["env"]
    assert argv[argv.index("--db") + 1] == "mysql" and argv[argv.index("--db-host") + 1] == "db.lan"
    assert env["ELPIS_CFG_DB_PASSWORD"] == "s3cret"
    assert env["ELPIS_CFG_ADMIN_PASSWORD"] == "motdepasse1"
    assert env["ELPIS_CFG_CLOUD_API_KEY"] == "clé-api"
    assert not {"s3cret", "motdepasse1", "clé-api"} & set(argv)


def test_changement_de_moteur_change_le_port(ctx_env, monkeypatch):
    ctx, st, wiz = _wizard(monkeypatch=monkeypatch)
    st.update(db_mode="external", db_engine="mysql", db_port="5432")
    wiz.normalize()
    assert st["db_port"] == "3306"
    st["db_port"] = "6543"                 # port choisi : on n'y touche plus
    st["db_engine"] = "postgres"
    wiz.normalize()
    assert st["db_port"] == "6543"


def test_mot_de_passe_genere_seulement_a_la_premiere_installation(ctx_env, monkeypatch):
    ctx, st, wiz = _wizard(monkeypatch=monkeypatch)
    out = W.build_outputs(W.finalize(st), "install", False)
    assert out["admin_generated"] and out["configure"]["env"]["ELPIS_CFG_ADMIN_PASSWORD_GENERATED"] == "1"
    out = W.build_outputs(W.finalize(st), "install", True)            # réinstallation
    assert not out["admin_generated"] and "ELPIS_CFG_ADMIN_PASSWORD" not in out["configure"]["env"]


def test_validation_bloque_la_page_suivante(ctx_env, monkeypatch):
    ctx, st, wiz = _wizard(monkeypatch=monkeypatch)
    _page(wiz, "admin")
    st["admin_password"] = "court"
    wiz.next_page()
    assert wiz.page.key == "admin" and "admin_password" in wiz.errors


def test_clavier_coche_choisit_et_avance(ctx_env, monkeypatch):
    ctx, st, wiz = _wizard(monkeypatch=monkeypatch)
    _page(wiz, "comp")
    before = set(st["components"])
    wiz.handle("space")                                  # 1re case : navigateur
    assert set(st["components"]) == before ^ {"browser"}
    wiz.handle("enter")                                  # → image sandbox
    wiz.handle("3")                                      # « Aucune »
    assert st["sandbox"] == "none"
    wiz.handle("enter")                                  # → page suivante
    assert wiz.page.key == "base"
    for key in ("tab",) * 6:
        wiz.handle(key)
    assert wiz.page.key == "fin"
    wiz.handle("down"), wiz.handle("down"), wiz.handle("down")
    assert wiz.handle("enter") == "finish" and st["_action"] == "ok"


def test_installer_pendant_une_sonde_valide_a_sa_fin(ctx_env, monkeypatch):
    """Entrée sur « Installer » pendant une sonde réseau : plus refusé (il
    fallait appuyer une seconde fois), validé dès la fin de la sonde."""
    import threading
    ctx, st, wiz = _wizard(monkeypatch=monkeypatch)
    ev = threading.Event()
    wiz.run_async("sonde", ev.wait)
    assert wiz.try_finish("ok") is None and wiz.pending_finish == "ok"
    ev.set()
    wiz.tasks["sonde"].join(2)
    assert not wiz.busy() and wiz.try_finish(wiz.pending_finish) == "finish"


@pytest.mark.parametrize("size", [(80, 24), (50, 14), (132, 50)])
def test_rendu_tient_dans_l_ecran(ctx_env, monkeypatch, size):
    ctx, st, wiz = _wizard(monkeypatch=monkeypatch)
    w, h = size
    for i in range(len(wiz.pages)):
        wiz.page_i = i
        lines = wiz.frame(w, h)
        assert len(lines) <= h and all(T.visible_len(x) <= w for x in lines)


def test_options_de_la_ligne_de_commande_pre_remplissent(ctx_env, monkeypatch):
    monkeypatch.setenv("ELPIS_WIZ_PRESET", json.dumps({"with_office": "0", "db_mode": "mariadb-local"}))
    monkeypatch.setenv("ELPIS_WIZ_CONFIGURE_ARGS", json.dumps(["--llm-url", "http://gpu:9000", "--rag", "off"]))
    ctx, st, wiz = _wizard(monkeypatch=monkeypatch)
    assert "office" not in st["components"] and st["db_mode"] == "mariadb-local"
    assert st["llm_url"] == "http://gpu:9000" and st["rag"] is False


def test_reinstallation_reprend_la_configuration(ctx_env, monkeypatch):
    (ctx_env / "config.json").write_text(json.dumps({
        "llama": {"url": "http://llm.lan:8080/v1/chat/completions", "engine": "vllm", "model": "m"},
        "database": {"backend": "postgres", "host": "db.lan", "port": 5433, "name": "prod", "user": "app"},
        "voice": {"enabled": True, "stt": {"endpoint_url": "http://v:8090"}},
    }), encoding="utf-8")
    ctx, st, wiz = _wizard(monkeypatch=monkeypatch)
    assert ctx.reinstall
    assert (st["llm_url"], st["engine"], st["llm_model_name"]) == ("http://llm.lan:8080", "vllm", "m")
    assert (st["db_mode"], st["db_host"], st["db_port"], st["db_name"]) == ("external", "db.lan", "5433", "prod")
    assert st["voice"] and st["stt_url"] == "http://v:8090"


# ── Fichier de réponses et sous-commandes ────────────────────────────────────

def test_fichier_de_reponses_prive_et_exporte(ctx_env, monkeypatch, tmp_path):
    ctx, st, wiz = _wizard(monkeypatch=monkeypatch)
    st["db_mode"] = "sqlite"
    path = tmp_path / "run" / "a.json"
    W.write_answers(path, W.finalize(st), "install", False)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    r = subprocess.run([sys.executable, str(REPO / "deploy/wizard.py"), "export-sh", str(path)],
                       capture_output=True, text=True, check=True)
    env = dict(line.split("=", 1) for line in r.stdout.splitlines())
    assert env["DB_MODE"] == "sqlite" and env["SANDBOX_MODE"] == "build"
    gen = json.loads(path.read_text())["admin_generated"]
    subprocess.run([sys.executable, str(REPO / "deploy/wizard.py"), "set", str(path), "db_mode=postgres-local"],
                   check=True)
    data = json.loads(path.read_text())
    assert data["install"]["DB_MODE"] == "postgres-local"
    assert data["admin_generated"] == gen, "le mot de passe généré ne doit pas changer"
    r = subprocess.run([sys.executable, str(REPO / "deploy/wizard.py"), "final-note", str(path)],
                       capture_output=True, text=True, check=True)
    assert gen in r.stdout


def test_configure_lit_les_reponses_et_teste_la_base(tmp_path):
    ans = tmp_path / "a.json"
    ans.write_text(json.dumps({"configure": {"argv": ["--yes", "--db", "sqlite"], "env": {}}}))
    r = subprocess.run([sys.executable, str(REPO / "deploy/configure.py"), "--answers", str(ans), "--check-db"],
                       capture_output=True, text=True, timeout=60)
    assert r.returncode == 0 and "SQLite" in r.stdout


@pytest.mark.skipif(not os.environ.get("ELPIS_TEST_PG"), reason="ELPIS_TEST_PG absent")
def test_check_db_serveur_reel(tmp_path):
    host, port, name, user, password = os.environ["ELPIS_TEST_PG"].split(":", 4)
    ans = tmp_path / "a.json"
    ans.write_text(json.dumps({"configure": {"argv": [
        "--yes", "--db", "postgres", "--db-host", host, "--db-port", port, "--db-name", name,
        "--db-user", user], "env": {"ELPIS_CFG_DB_PASSWORD": password}}}))
    r = subprocess.run([sys.executable, str(REPO / "deploy/configure.py"), "--answers", str(ans), "--check-db"],
                       capture_output=True, text=True, timeout=90)
    assert r.returncode == 0 and "joignable" in r.stdout.splitlines()[-1]
    ans.write_text(ans.read_text().replace(password, "faux-mot-de-passe"))
    r = subprocess.run([sys.executable, str(REPO / "deploy/configure.py"), "--answers", str(ans), "--check-db"],
                       capture_output=True, text=True, timeout=90)
    assert r.returncode == 1 and "connexion impossible" in r.stdout.splitlines()[-1]


# ── Dans un vrai terminal (pseudo-terminal) ──────────────────────────────────

def _drive(argv, keys, env, cols=100, rows=34, timeout=30):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.execvp(argv[0], argv)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    out = b""

    def pump(t):
        nonlocal out
        end = time.time() + t
        while time.time() < end:
            if select.select([fd], [], [], 0.05)[0]:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    return
                if not data:
                    return
                out += data

    pump(1.5)
    for k in keys:
        os.write(fd, k)
        pump(0.2)
    deadline = time.time() + timeout
    status = None
    while time.time() < deadline:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            break
        pump(0.2)
    else:
        os.kill(pid, 9)
        os.waitpid(pid, 0)
    return out.decode("utf-8", "replace"), (os.waitstatus_to_exitcode(status) if status is not None else None)


def test_assistant_dans_un_terminal(tmp_path):
    out = tmp_path / "a.json"
    env = {"TERM": "xterm-256color", "LANG": "C.UTF-8", "ELPIS_WIZ_ADMIN": "1",
           "ELPIS_WIZ_CONFIGURE_ARGS": json.dumps(["--llm-url", "http://127.0.0.1:9", "--rag", "off"])}
    keys = [b" ", b"\r", b"3", b"\r",         # navigateur décoché ; sandbox « Aucune »
            b"2", b"\r",                      # PostgreSQL sur cette machine
            b"\t", b"\t", b"\t", b"\t",       # LLM, Accès, RAG, Voix
            b"\t",                            # Admin (mot de passe généré)
            b"\r", b"\r"]                     # Démarrage : services ; Installer
    screen, code = _drive([sys.executable, str(REPO / "deploy/wizard.py"), "install", "--out", str(out)],
                          keys, env)
    assert code == 0, screen[-2000:]
    assert "\x1b[?1049h" in screen and "\x1b[?1049l" in screen, "écran alternatif ouvert puis rendu"
    data = json.loads(out.read_text())
    assert data["install"]["DB_MODE"] == "postgres-local"
    assert data["install"]["SANDBOX_MODE"] == "none" and data["install"]["WITH_BROWSER"] == 0
    assert stat.S_IMODE(out.stat().st_mode) == 0o600


def test_echap_abandonne_sans_rien_ecrire(tmp_path):
    out = tmp_path / "a.json"
    screen, code = _drive([sys.executable, str(REPO / "deploy/wizard.py"), "install", "--out", str(out)],
                          [b"\x1b", b"o"], {"TERM": "xterm", "LANG": "C.UTF-8"})
    assert code == 1 and not out.exists()


def test_terminal_inutilisable(tmp_path):
    r = subprocess.run([sys.executable, str(REPO / "deploy/wizard.py"), "install", "--out", str(tmp_path / "a")],
                       env=dict(os.environ, TERM="dumb"), capture_output=True, text=True, timeout=30)
    assert r.returncode == 3
