# SPDX-License-Identifier: MIT
"""tests/deploy/test_installeur_moteurs_2026_10_19.py — installeur des moteurs locaux : quatre types (llama.cpp, vLLM, SGLang, générique), port par défaut du type, clé API écrite mais jamais affichée, refus 401, configuration ancienne intacte, conseils de lancement."""
from __future__ import annotations

import importlib.util
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "deploy"))

import tui as T  # noqa: E402
import wizard as W  # noqa: E402

CLE = "cle-de-test-7f3a91"


# ── Faux serveur LLM : /v1/models gardé par une clé, /health ouvert (comme vLLM --api-key) ──

class _Moteur(BaseHTTPRequestHandler):
    cle = ""
    entetes: list = []

    def do_GET(self):  # noqa: N802
        type(self).entetes.append(self.headers.get("Authorization") or "")
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path != "/v1/models":
            code, corps = 404, b'{"detail": "Not Found"}'
        elif self.cle and self.headers.get("Authorization") != f"Bearer {self.cle}":
            code, corps = 401, b'{"error": "Unauthorized"}'
        else:
            code, corps = 200, json.dumps({"object": "list", "data": [
                {"id": "Qwen/Qwen3-8B", "object": "model", "owned_by": "vllm", "max_model_len": 8192}]}).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(corps)))
        self.end_headers()
        self.wfile.write(corps)

    def log_message(self, *_a):
        pass


@pytest.fixture
def moteur():
    """Rend la base du faux serveur ; sa clé attendue est ``_Moteur.cle`` (vide = aucune)."""
    _Moteur.cle, _Moteur.entetes = CLE, []
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Moteur)
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()
    srv.server_close()


@pytest.fixture
def conf(tmp_path, monkeypatch):
    """configure.py chargé à part, chemins redirigés vers un dépôt vierge."""
    spec = importlib.util.spec_from_file_location("elpis_configure_moteurs", REPO / "deploy/configure.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    for nom, chemin in (("ROOT", tmp_path), ("CONFIG", tmp_path / "config.json"),
                        ("ENV_FILE", tmp_path / ".env"),
                        ("USER_DB", tmp_path / "user_db")):
        monkeypatch.setattr(mod, nom, chemin)
    for k in [k for k in os.environ if k.startswith("ELPIS_CFG_") or k == "LLAMA_API_KEY"]:
        monkeypatch.delenv(k)
    return mod


def _llm(conf, cfg, *argv, models=None, err="Connection refused"):
    """Étape LLM sans question ; ``models`` remplace la sonde réseau (None = sonde réelle)."""
    if models is not None:
        conf.list_models = lambda base, headers=None: (models, "" if models else err)
    conf.step_llm(conf.Prompter(False), conf.build_parser().parse_args(["--yes", *argv]), cfg)
    return cfg["llama"]


def _exemple():
    return json.loads((REPO / "config.example.json").read_text(encoding="utf-8"))


# ── Types de moteur : les mêmes que le core ──────────────────────────────────

def test_alias_et_types_identiques_au_core(conf):
    src = (REPO / "packages/config/src/reglages.ts").read_text(encoding="utf-8")
    bloc = re.search(r"const ALIAS_MOTEUR_LLAMA[^=]*= new Map\(\[(.*?)\]\);", src, re.S)[1]
    assert dict(re.findall(r'\["([^"]*)", "([^"]*)"\]', bloc)) == conf.ENGINE_ALIASES
    assert list(conf.ENGINES) == ["llamacpp", "vllm", "sglang", "generic"]
    assert set(conf.ENGINE_ALIASES.values()) == set(conf.ENGINES)
    assert [conf.canon_engine(v) for v in (None, "", " LLaMA.cpp ", "SGLang", "openai-compatible", "inconnu")] == [
        "llamacpp", "llamacpp", "llamacpp", "sglang", "generic", "generic"]
    aide = conf.build_parser().format_help()
    assert "llamacpp | vllm | sglang | generic" in aide and "--llm-api-key" in aide


def test_drapeaux_conseilles_identiques_aux_profils_du_core(conf):
    src = (REPO / "apps/core/src/llm/profils.ts").read_text(encoding="utf-8")
    sujets = {"réflexion": "reflexion", "outils": "outils", "jetons en cache": "jetonsEnCache", "métriques": "metriques"}
    for moteur, libelle in (("llamacpp", "llama.cpp"), ("vllm", "vLLM"), ("sglang", "SGLang")):
        profil = src.split(f'libelle: "{libelle}"', 1)[1]
        assert int(re.search(r"portParDefaut: (\d+)", profil)[1]) == conf.LLM_PORTS[moteur], moteur
        if moteur == "llamacpp":
            continue
        drapeaux = re.search(r"drapeaux: \{(.*?)\n    \}", profil, re.S)[1]
        for sujet, opt, detail in conf.LAUNCH_FLAGS[moteur]:
            ts = re.search(rf"{sujets[sujet]}:\s*\"([^\"]*)\"", drapeaux)[1]
            assert re.findall(r"--[a-z][a-z-]+", opt + detail) == re.findall(r"--[a-z][a-z-]+", ts), (moteur, sujet)
        assert [s for s, _o, _d in conf.LAUNCH_FLAGS[moteur]] == list(sujets)
    assert conf.launch_advice("llamacpp") == conf.launch_advice("generic") == []


@pytest.mark.parametrize("moteur,url", [("llamacpp", None), ("vllm", "http://127.0.0.1:8000"),
                                        ("sglang", "http://127.0.0.1:30000"), ("generic", None)])
def test_configure_quatre_moteurs_port_par_defaut(conf, moteur, url):
    llama = _llm(conf, _exemple(), "--engine", moteur, models=[])
    assert llama["engine"] == moteur
    # llama.cpp et générique gardent le 8080 de config.example.json : rien à réécrire.
    assert llama["url"] == (url or "") and (llama["ip"], llama["port"]) == ("127.0.0.1", "8080")


def test_configure_alias_et_adresse_saisie(conf):
    cfg = {"llama": {"engine": "llama", "url": "http://gpu.lan:8080", "model": "m"}}
    llama = _llm(conf, cfg, "--engine", "vllm", models=[])
    assert llama["url"] == "http://gpu.lan:8080", "adresse saisie : le port ne suit pas le type"
    llama = _llm(conf, {}, "--engine", "SGLang", "--llm-url", "http://gpu.lan:30000/v1/chat/completions", models=[])
    assert (llama["engine"], llama["url"]) == ("sglang", "http://gpu.lan:30000"), "base du serveur écrite"


# ── Configuration ancienne : valide, non réécrite sans raison ────────────────

@pytest.mark.parametrize("llama", [
    {"ip": "10.1.2.3", "port": "8080", "model": "m"},
    {"url": "http://llm.lan:8080/v1/chat/completions", "engine": "llama.cpp", "model": "m"},
    {"url": "http://llm.lan:8000/v1", "engine": "vllm", "model": "m", "api_key": CLE},
    {"model": "m"},
])
def test_configuration_ancienne_intacte(conf, monkeypatch, llama):
    cfg = {"llama": json.loads(json.dumps(llama))}
    assert _llm(conf, cfg, models=["m"]) == llama
    # Même chemin que l'assistant : ses réponses, réappliquées telles quelles.
    st = {"engine": conf.canon_engine(llama.get("engine")), "llm_url": conf.llm_base(llama),
          "llm_api_key": llama.get("api_key", ""), "llm_model_final": "m", "https": "off", "listen": "local",
          "admin_user": "admin"}
    out = W.build_outputs(st, "configure", True)
    argv = out["configure"]["argv"]
    for k, v in out["configure"]["env"].items():
        monkeypatch.setenv(k, v)
    assert _llm(conf, cfg, *argv[1:argv.index("--https")], models=["m"]) == llama


def test_changement_d_adresse_ecrit_la_base(conf):
    cfg = {"llama": {"ip": "10.1.2.3", "port": "8080", "model": "m"}}
    llama = _llm(conf, cfg, "--llm-url", "http://10.1.2.3:8081/v1", models=["m"])
    assert llama == {"ip": "10.1.2.3", "port": "8080", "model": "m", "url": "http://10.1.2.3:8081"}


# ── Clé API : écrite (0600), jamais affichée, envoyée en Bearer ──────────────

def test_cle_ecrite_jamais_affichee(conf, moteur, monkeypatch, capsys):
    monkeypatch.setenv("ELPIS_CFG_LLM_API_KEY", f" {CLE} ")
    cfg = _exemple()
    llama = _llm(conf, cfg, "--engine", "vllm", "--llm-url", moteur)
    assert llama["api_key"] == CLE and llama["model"] == "Qwen/Qwen3-8B" and llama["url"] == moteur
    assert f"Bearer {CLE}" in _Moteur.entetes, "sonde GET /v1/models avec la clé"
    sortie = capsys.readouterr()
    assert CLE not in sortie.out + sortie.err and "clé API définie" in sortie.out
    conf.write_json(conf.CONFIG, cfg)
    assert stat.S_IMODE(conf.CONFIG.stat().st_mode) == 0o600
    assert json.loads(conf.CONFIG.read_text())["llama"]["api_key"] == CLE
    # Vide : la clé est retirée ; absente des options : gardée.
    assert _llm(conf, cfg, "--llm-url", moteur, "--llm-api-key", CLE)["api_key"] == CLE
    monkeypatch.delenv("ELPIS_CFG_LLM_API_KEY")
    assert _llm(conf, cfg, models=["Qwen/Qwen3-8B"])["api_key"] == CLE
    assert _llm(conf, cfg, "--llm-api-key", "", models=["Qwen/Qwen3-8B"])["api_key"] == ""


def test_cle_saisie_masquee_en_lignes(conf, monkeypatch):
    saisies = iter(["", "http://gpu:8000", "", ""])         # type, adresse, autre essai, modèle
    monkeypatch.setattr("builtins.input", lambda _q: next(saisies, ""))
    monkeypatch.setattr(conf.getpass, "getpass", lambda q: CLE if "Clé API" in q else "")
    conf.list_models = lambda base, headers=None: ([], "Connection refused")
    cfg = {"llama": {"engine": "vllm"}}
    conf.step_llm(conf.Prompter(True), conf.build_parser().parse_args([]), cfg)
    assert cfg["llama"]["api_key"] == CLE
    monkeypatch.setattr(conf.getpass, "getpass", lambda q: "-" if "inchangée" in q else "")
    saisies = iter([""] * 5)
    conf.step_llm(conf.Prompter(True), conf.build_parser().parse_args([]), cfg)
    assert cfg["llama"]["api_key"] == "", "« - » retire la clé"


@pytest.mark.parametrize("cle,attendu", [("mauvaise", "clé refusée (HTTP 401)"), ("", "clé API demandée (HTTP 401)")])
def test_401_message_clair(conf, moteur, monkeypatch, capsys, cle, attendu):
    assert conf.list_models(moteur, conf.llm_headers(cle)) == ([], attendu)
    if cle:
        monkeypatch.setenv("ELPIS_CFG_LLM_API_KEY", cle)
    _llm(conf, {}, "--engine", "vllm", "--llm-url", moteur)
    err = capsys.readouterr().err
    assert attendu in err and "--api-key" in err and (not cle or cle not in err)


def _configure(*args, env=None, cwd=None):
    e = {k: v for k, v in os.environ.items() if not k.startswith("ELPIS_CFG_") and k != "LLAMA_API_KEY"}
    return subprocess.run([sys.executable, str(REPO / "deploy/configure.py"), *args], env={**e, **(env or {})},
                          capture_output=True, text=True, timeout=60, cwd=cwd)


def test_check_llm_cle_par_l_environnement(moteur, tmp_path):
    r = _configure("--check-llm", "--engine", "vllm", "--llm-url", moteur + "/v1/chat/completions",
                   env={"ELPIS_CFG_LLM_API_KEY": CLE})
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.strip() == f"vLLM sur {moteur} : 1 modèle(s) (Qwen/Qwen3-8B), clé API envoyée"
    r = _configure("--check-llm", "--engine", "sglang", "--llm-url", moteur,
                   env={"ELPIS_CFG_LLM_API_KEY": "mauvaise-cle-91b2"})
    assert r.returncode == 1 and "clé refusée (HTTP 401) — renseignez llama.api_key" in r.stdout
    assert "mauvaise-cle-91b2" not in r.stdout + r.stderr
    # Réponses de l'assistant : la clé arrive par leur bloc env, jamais par la ligne de commande.
    ans = tmp_path / "a.json"
    ans.write_text(json.dumps({"configure": {"argv": ["--yes", "--engine", "vllm", "--llm-url", moteur],
                                             "env": {"ELPIS_CFG_LLM_API_KEY": CLE}}}))
    r = _configure("--answers", str(ans), "--check-llm")
    assert r.returncode == 0 and "clé API envoyée" in r.stdout and CLE not in r.stdout


def test_check_llm_injoignable_et_port_du_rag():
    r = _configure("--check-llm", "--engine", "vllm", "--llm-url", "http://127.0.0.1:1")
    assert r.returncode == 1 and r.stdout.startswith("vLLM sur http://127.0.0.1:1 : ")
    assert "service RAG" in W.C.rag_port_clash("http://localhost:8000")
    assert W.C.rag_port_clash("http://gpu.lan:8000") is None


def test_conseils_de_lancement(tmp_path):
    racine = tmp_path / "depot"
    (racine / "deploy").mkdir(parents=True)
    shutil.copy(REPO / "deploy/configure.py", racine / "deploy/configure.py")
    cfg = racine / "config.json"
    for moteur, attendus in (("vllm", ["--reasoning-parser", "--tool-call-parser", "--enable-prompt-tokens-details",
                                       "--disable-log-stats"]),
                             ("sglang", ["--reasoning-parser", "--tool-call-parser", "--enable-cache-report",
                                         "--enable-metrics"])):
        cfg.write_text(json.dumps({"llama": {"engine": moteur, "api_key": CLE}}))
        r = subprocess.run([sys.executable, str(racine / "deploy/configure.py"), "--conseils-moteur"],
                           capture_output=True, text=True, timeout=60, env={"PATH": os.environ["PATH"]})
        assert r.returncode == 0 and all(a in r.stdout for a in attendus), r.stdout
        assert "--api-key" in r.stdout and CLE not in r.stdout
    for moteur in ("llamacpp", "generic", "llama.cpp"):
        cfg.write_text(json.dumps({"llama": {"engine": moteur}}))
        r = subprocess.run([sys.executable, str(racine / "deploy/configure.py"), "--conseils-moteur"],
                           capture_output=True, text=True, timeout=60, env={"PATH": os.environ["PATH"]})
        assert r.returncode == 0 and r.stdout == ""


# ── Assistant par pages ──────────────────────────────────────────────────────

@pytest.fixture
def depot(tmp_path, monkeypatch):
    root = tmp_path / "repo"
    (root / "rag_app").mkdir(parents=True)
    shutil.copy(REPO / "config.example.json", root / "config.example.json")
    monkeypatch.setattr(W, "ROOT", root)
    monkeypatch.setattr(W.C, "CONFIG", root / "config.json")
    monkeypatch.setattr(W.C, "ENV_FILE", root / ".env")
    monkeypatch.setattr(W.C, "DB_PASSWORD_FILE", root / "user_db" / ".db_password")
    for k in ("ELPIS_WIZ_OFFLINE", "ELPIS_WIZ_PRESET", "ELPIS_WIZ_CONFIGURE_ARGS", "ELPIS_WIZ_APT",
              "ELPIS_CFG_LLM_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("ELPIS_WIZ_ADMIN", "1")
    return root


def _assistant(mode="install"):
    ctx = W.Ctx(mode)
    st = W.initial_state(ctx)
    pages = W.build_pages(ctx)
    return ctx, st, T.Wizard("t", pages, st), next(p for p in pages if p.key == "llm")


def _champ(page, cle):
    return next(f for f in page.fields if f.key == cle)


def test_assistant_quatre_moteurs_et_port_par_defaut(depot):
    _ctx, st, wiz, llm = _assistant()
    assert [o.value for o in _champ(llm, "engine").opts(st)] == ["llamacpp", "vllm", "sglang", "generic"]
    url = _champ(llm, "llm_url")
    assert st["llm_url"] == "http://127.0.0.1:8080" and url.hint_text(st) == "http://127.0.0.1:8080"
    for moteur, port in (("vllm", 8000), ("sglang", 30000), ("generic", 8080), ("llamacpp", 8080)):
        st["engine"] = moteur
        wiz.normalize()
        assert st["llm_url"] == f"http://127.0.0.1:{port}" and url.hint_text(st) == f"http://127.0.0.1:{port}"
    st["llm_url"] = "http://gpu.lan:8080"           # adresse saisie : elle ne suit plus le type
    st["engine"] = "vllm"
    wiz.normalize()
    assert st["llm_url"] == "http://gpu.lan:8080" and url.hint_text(st) == "http://127.0.0.1:8000"
    st["llm_url"] = ""                               # champ vidé : le défaut du type revient
    st["engine"] = "sglang"
    wiz.normalize()
    assert st["llm_url"] == "http://127.0.0.1:30000"


def test_assistant_conseils_et_port_du_rag_affiches(depot):
    _ctx, st, wiz, llm = _assistant()
    st["engine"] = "vllm"
    wiz.normalize()
    assert "RAG" in _champ(llm, "_llm_clash").text(st) and "8000" in _champ(llm, "_llm_clash").text(st)
    assert "--enable-prompt-tokens-details" in _champ(llm, "_llm_flags").text(st)
    st["engine"] = "llamacpp"
    wiz.normalize()
    assert _champ(llm, "_llm_clash").text(st) is None and _champ(llm, "_llm_flags").text(st) is None
    for w, h in ((80, 24), (50, 14)):
        wiz.page_i = wiz.pages.index(llm)
        st["engine"] = "sglang"
        wiz.normalize()
        assert all(T.visible_len(x) <= w for x in wiz.frame(w, h))


def test_assistant_option_engine_suit_le_port(depot, monkeypatch):
    monkeypatch.setenv("ELPIS_WIZ_CONFIGURE_ARGS", json.dumps(["--engine", "sglang"]))
    _ctx, st, _wiz, _llm = _assistant()
    assert (st["engine"], st["llm_url"]) == ("sglang", "http://127.0.0.1:30000")
    monkeypatch.setenv("ELPIS_WIZ_CONFIGURE_ARGS", json.dumps(["--engine", "vllm", "--llm-url", "http://gpu:9000"]))
    _ctx, st, _wiz, _llm = _assistant()
    assert (st["engine"], st["llm_url"]) == ("vllm", "http://gpu:9000")


def test_assistant_reprend_la_cle_sans_l_afficher(depot, tmp_path):
    (depot / "config.json").write_text(json.dumps({"llama": {
        "engine": "tgi", "url": "http://llm.lan:8000/v1/chat/completions", "api_key": CLE, "model": "m"}}))
    ctx, st, wiz, llm = _assistant("configure")
    assert (st["engine"], st["llm_url"], st["llm_api_key"]) == ("generic", "http://llm.lan:8000", CLE)
    assert _champ(llm, "llm_api_key").secret
    wiz.page_i = wiz.pages.index(llm)
    ecran = "\n".join(wiz.frame(100, 40))
    resume = json.dumps(W.summary(st, ctx), ensure_ascii=False)
    assert CLE not in ecran and CLE not in resume and "définie (masquée)" in resume
    out = W.build_outputs(W.finalize(st), "configure", True)
    assert out["configure"]["env"]["ELPIS_CFG_LLM_API_KEY"] == CLE
    assert CLE not in json.dumps(out["configure"]["argv"]) and CLE not in json.dumps(out["install"])
    path = tmp_path / "run" / "a.json"
    W.write_answers(path, W.finalize(st), "install", True)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    r = subprocess.run([sys.executable, str(REPO / "deploy/wizard.py"), "export-sh", str(path)],
                       capture_output=True, text=True, check=True)
    assert CLE not in r.stdout
    st["llm_api_key"] = ""                            # champ vidé : la clé est retirée
    assert W.build_outputs(W.finalize(st), "configure", True)["configure"]["env"]["ELPIS_CFG_LLM_API_KEY"] == ""


def test_assistant_sonde_avec_la_cle_et_401(depot, moteur):
    _ctx, st, wiz, llm = _assistant("configure")
    note = _champ(llm, "_llm_note").text
    st.update(engine="vllm", llm_url=moteur, llm_api_key="")
    W.probe_models("llm")(st, wiz)
    wiz.tasks["llm"].join(10)
    assert note(st) == "✗ Clé API demandée (HTTP 401) : saisissez la valeur de --api-key du serveur."
    st["llm_api_key"] = "mauvaise"
    W.probe_models("llm")(st, wiz)
    wiz.tasks["llm"].join(10)
    assert note(st).startswith("✗ Clé refusée (HTTP 401)")
    st["llm_api_key"] = CLE
    _champ(llm, "llm_api_key").on_commit(st, wiz)
    wiz.tasks["llm"].join(10)
    assert note(st) == f"✓ {moteur} répond : 1 modèle(s)." and st["llm_model"] == "Qwen/Qwen3-8B"
    assert _Moteur.entetes[-1] == f"Bearer {CLE}"


def test_assistant_cle_par_l_environnement_ou_l_option(depot, monkeypatch):
    monkeypatch.setenv("ELPIS_CFG_LLM_API_KEY", CLE)
    assert _assistant()[1]["llm_api_key"] == CLE
    monkeypatch.delenv("ELPIS_CFG_LLM_API_KEY")
    monkeypatch.setenv("ELPIS_WIZ_CONFIGURE_ARGS", json.dumps(["--llm-api-key", "autre"]))
    assert _assistant()[1]["llm_api_key"] == "autre"


# ── install.sh : secrets masqués dans le journal, note finale ────────────────

def test_install_masque_les_secrets_et_rappelle_les_drapeaux():
    src = (REPO / "install.sh").read_text(encoding="utf-8")
    fonction = re.search(r"^args_masques\(\) \{.*?^\}", src, re.S | re.M)[0]
    r = subprocess.run(["bash", "-c", fonction + '\nargs_masques "$@"', "_", "--llm-url", "http://h:8000",
                        "--llm-api-key", CLE, f"--cloud-api-key={CLE}", "--admin-password", CLE, "--yes"],
                       capture_output=True, text=True, check=True)
    assert r.stdout == ("--llm-url http://h:8000 --llm-api-key ******** --cloud-api-key=******** "
                        "--admin-password ******** --yes")
    assert '$(args_masques "$@")' in src and "$*" not in src.split("# ── Journal", 1)[1].split("exec >", 1)[0]
    assert re.search(r'^conseils="\$\(python3 "\$ROOT/deploy/configure\.py" --conseils-moteur', src, re.M)
    r = subprocess.run(["bash", str(REPO / "install.sh"), "--dry-run", "--yes", "--", "--llm-api-key", CLE],
                       capture_output=True, text=True, timeout=60, cwd=str(REPO), stdin=subprocess.DEVNULL)
    assert CLE not in r.stdout + r.stderr and "./elpis configure --yes --llm-api-key ********" in r.stdout


# ── ./elpis doctor : serveur LLM sondé avec la clé, conseils, sonde du core ───

from tests.deploy.test_lanceur_exploitation_ts import FAUX_NODE, FAUX_PY, _elpis, _executable  # noqa: E402


@pytest.fixture
def racine_doctor(tmp_path):
    r = tmp_path / "elpis"
    for d in ("deploy/node", "apps/core/dist", "apps/toolhost/dist", "venv/bin", "rag_app", "user_db/run", "logs"):
        (r / d).mkdir(parents=True)
    for f in ("elpis", "deploy/node/node.env", "deploy/node/runtime.sh", "deploy/node/relance.sh",
              "deploy/prerequis-apt.sh", "deploy/prerequis-apt.txt", "deploy/configure.py"):
        shutil.copy2(REPO / f, r / f)
    _executable(r / "venv/bin/python", FAUX_PY)
    (r / "config.json").write_text("{}", encoding="utf-8")
    for f in ("apps/core/dist/main.mjs", "apps/core/dist/exploitation.mjs", "apps/toolhost/dist/main.mjs"):
        (r / f).write_text("", encoding="utf-8")
    _executable(r / "faux-node", FAUX_NODE)
    return r


def test_doctor_serveur_llm_cle_et_conseils(racine_doctor, moteur):
    r, trace = _elpis(racine_doctor, "doctor", LLAMA_URL_TS=moteur + "/v1/chat/completions",
                      LLAMA_ENGINE_TS="vllm", LLAMA_API_KEY_TS=CLE)
    sortie = r.stdout + r.stderr
    assert f"serveur LLM : vLLM sur {moteur} : 1 modèle(s) (Qwen/Qwen3-8B), clé API envoyée" in sortie, sortie
    assert "--enable-prompt-tokens-details" in r.stdout and "--reasoning-parser" in r.stdout and "--api-key" in r.stdout
    assert "sonde du moteur par le core : main arrêté" in r.stdout
    assert f"Bearer {CLE}" in _Moteur.entetes
    assert CLE not in sortie and not [ligne for ligne in trace if CLE in ligne], "clé affichée ou sur une ligne de commande"


def test_doctor_cle_refusee(racine_doctor, moteur):
    r, _ = _elpis(racine_doctor, "doctor", LLAMA_URL_TS=moteur, LLAMA_ENGINE_TS="sglang", LLAMA_API_KEY_TS="mauvaise-cle-91b2")
    assert (f"serveur LLM : NON (SGLang sur {moteur} : clé refusée (HTTP 401) — renseignez llama.api_key avec la "
            "valeur de --api-key du serveur ; ./elpis configure)") in r.stderr, r.stderr
    assert "--enable-metrics" in r.stdout and "mauvaise-cle-91b2" not in r.stdout + r.stderr


def test_doctor_llama_cpp_sans_conseils(racine_doctor, moteur):
    _Moteur.cle = ""
    r, _ = _elpis(racine_doctor, "doctor", LLAMA_URL_TS=moteur + "/v1/chat/completions")
    assert f"serveur LLM : llama.cpp sur {moteur} : 1 modèle(s) (Qwen/Qwen3-8B)\n" in r.stdout
    assert "drapeaux de lancement conseillés" not in r.stdout


def test_doctor_sonde_du_core_depuis_le_journal(racine_doctor):
    (racine_doctor / "logs/main.log").write_text("\n".join([
        "2026-10-19T08:00:00.000Z INFO [llm] [moteur] vLLM injoignable sur http://gpu:8000",
        "2026-10-19T08:00:00.001Z WARNING [llm] [moteur] vLLM ne répond pas sur http://gpu:8000/health : vérifiez llama.url",
        "2026-10-19T09:00:00.000Z INFO [requete] GET /api/health 200",
        "2026-10-19T09:00:01.000Z INFO [llm] [moteur] vLLM 0.31.0 sur http://gpu:8000, modèle Qwen/Qwen3-8B, contexte "
        "8192 jetons, métriques oui, tokenisation exacte oui, concurrence gérée par le moteur",
        "2026-10-19T09:05:00.000Z WARNING [llm] [moteur] vLLM (builtin) : jetons repris du cache non rapportés, "
        "ajoutez --enable-prompt-tokens-details",
    ]) + "\n", encoding="utf-8")
    vivant = subprocess.Popen(["sleep", "120"])
    try:
        (racine_doctor / "user_db/run/main.pid").write_text(f"{vivant.pid}\n", encoding="utf-8")
        r, _ = _elpis(racine_doctor, "doctor")
    finally:
        vivant.kill()
        vivant.wait()
    assert ("sonde du moteur par le core (2026-10-19T09:00:01.000Z) : vLLM 0.31.0 sur http://gpu:8000, modèle "
            "Qwen/Qwen3-8B, contexte 8192 jetons") in r.stdout, r.stdout
    assert "vLLM (builtin) : jetons repris du cache non rapportés, ajoutez --enable-prompt-tokens-details" in r.stderr
    assert "injoignable sur http://gpu:8000" not in r.stdout + r.stderr, "bloc du démarrage précédent écarté"
    (racine_doctor / "logs/main.log").write_text("2026-10-19T09:00:00.000Z INFO [requete] GET /\n", encoding="utf-8")
    vivant = subprocess.Popen(["sleep", "120"])
    try:
        (racine_doctor / "user_db/run/main.pid").write_text(f"{vivant.pid}\n", encoding="utf-8")
        r, _ = _elpis(racine_doctor, "doctor")
    finally:
        vivant.kill()
        vivant.wait()
    assert "sonde du moteur par le core : aucune ligne [moteur] dans le journal de main" in r.stdout


def test_assistant_dans_un_terminal_vllm_et_cle(tmp_path):
    """Parcours au clavier : vLLM choisi, l'adresse passe au port 8000, la clé saisie n'apparaît qu'en points."""
    from tests.deploy.test_installeur_assistant_2026_09_27 import _assistant_vierge, _drive
    out = tmp_path / "a.json"
    cle = "zq9x7kw4"
    keys = [b" ", b"\r", b"3", b"\r",         # navigateur décoché ; sandbox « Aucune »
            b"\r",                            # SQLite
            b"2", b"\r", b"\r",               # vLLM ; adresse proposée gardée
            cle.encode(), b"\r",              # clé du serveur
            b"\t", b"\t", b"\t", b"\t", b"\t",  # Accès, RAG, Voix, Admin, Résumé
            b"\r", b"\r"]                     # Démarrage ; Installer
    env = {"TERM": "xterm-256color", "LANG": "C.UTF-8", "ELPIS_WIZ_ADMIN": "1",
           "ELPIS_WIZ_CONFIGURE_ARGS": json.dumps(["--rag", "off"])}
    screen, code = _drive([sys.executable, str(_assistant_vierge(tmp_path)), "install", "--out", str(out)], keys, env)
    assert code == 0, screen[-2000:]
    data = json.loads(out.read_text())
    argv = data["configure"]["argv"]
    assert argv[argv.index("--engine") + 1] == "vllm" and argv[argv.index("--llm-url") + 1] == "http://127.0.0.1:8000"
    assert data["configure"]["env"]["ELPIS_CFG_LLM_API_KEY"] == cle and cle not in json.dumps(argv)
    assert cle not in screen and "•" * len(cle) in screen
    assert "--enable-prompt-tokens-details" in screen
