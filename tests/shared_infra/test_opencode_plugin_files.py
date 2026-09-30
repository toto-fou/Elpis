# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_opencode_plugin_files.py — artefacts du plugin elpis-remote.

Le plugin vit dans ``shared_infra/opencode/plugin/`` : ``elpis-remote.ts``
(canonique, TypeScript chargé nativement par opencode/Bun) et
``elpis-remote-bootstrap.js`` (shim de migration servi à /api/code/plugin.js
pour le « /remote update » des anciens plugins ≤ v8). Ici : cohérence des
marqueurs/versions, validité JS du shim (node --check), et run RÉEL de
l'installeur bash (curl stubé) pour le choix y/N du plugin.

Le smoke COMPORTEMENTAL (faux serveur + faux client opencode, sous Bun) est à
part : ``tests/opencode_plugin/smoke.ts`` (voir son README — Bun absent des VM
offline, donc hors pytest).
"""
from __future__ import annotations

import contextlib
import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from unittest import mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

REPO = Path(__file__).resolve().parents[2]
PLUGIN_DIR = REPO / "shared_infra" / "opencode" / "plugin"
TS = (PLUGIN_DIR / "elpis-remote.ts").read_text(encoding="utf-8")
SHIM = (PLUGIN_DIR / "elpis-remote-bootstrap.js").read_text(encoding="utf-8")


# ── Marqueurs et versions (contrat du flux /remote update, v8 ET v9) ─────────

def test_markers_and_versions_in_sync():
    # startsWith("// elpis-remote") + regex PLUGIN_VERSION : les DEUX flux
    # update (v8 → plugin.js, v9 → plugin.ts) valident la réponse ainsi.
    assert TS.startswith("// elpis-remote")
    assert SHIM.startswith("// elpis-remote")
    vts = re.search(r"const PLUGIN_VERSION = (\d+)", TS)
    vjs = re.search(r"const PLUGIN_VERSION = (\d+)", SHIM)
    assert vts and vjs and vts.group(1) == vjs.group(1)
    import shared_infra.opencode.routes_code as code
    assert code._PLUGIN_CURRENT == int(vts.group(1))


def test_ts_is_erasable_typescript_only():
    # opencode/Bun strippe les types ; on s'interdit les syntaxes NON erasables
    # (enum/namespace/decorators/param properties) pour rester compatible avec
    # tout futur strip-types (Node 22+, esbuild…).
    for forbidden in ("\nenum ", "\nnamespace ", "\n@", "declare module"):
        assert forbidden not in TS, forbidden


def test_shim_downloads_canonical_and_self_deletes():
    assert "/api/code/plugin.ts" in SHIM
    assert "rmQuiet(JS_PATH)" in SHIM          # s'efface après migration
    assert "tsAlreadyThere" in SHIM            # jamais 2 instances dans un run
    assert "__APP_URL__" in SHIM               # substitué au service


# ── Store de conf : portée MACHINE vs INSTANCE, écriture concurrente-sûre ────
# elpis-remote.json est PARTAGÉ par tous les opencode d'un même utilisateur.
# Deux invariants à ne jamais reperdre :
#   • `enabled` est PAR PROJET (sinon /remote off dans un projet coupe les
#     autres, et une reprise auto en réveille qui ne devraient pas l'être) ;
#   • toute écriture est un read-modify-write (sinon un process écrase le jeton
#     qu'un voisin vient d'appairer, ou l'état d'un autre projet).

_CONF_REGION = re.search(
    r"// #region conf-store[^\n]*\n(.*?)// #endregion conf-store", TS, re.S)

# Annotations TS présentes dans la région, à effacer pour exécuter sous Node 20
# (pas de --experimental-strip-types avant Node 22, ni bun/tsc sur les VM
# offline). Si un nouveau type apparaît, `node --check` casse le test avec un
# message clair — étendre cette table plutôt que contourner.
_TS_STRIPS = (
    ("(): RemoteConf =>", "() =>"),
    ("(c: RemoteConf): void =>", "(c) =>"),
    ("(fn: (c: RemoteConf) => void): RemoteConf =>", "(fn) =>"),
    ("(c: RemoteConf, key: string): boolean =>", "(c, key) =>"),
    ("(directory: string): string =>", "(directory) =>"),
    ("(dir: string, n: number): string =>", "(dir, n) =>"),
    ("(key: string, patch: InstanceConf): void =>", "(key, patch) =>"),
    ("(key: string): void =>", "(key) =>"),
    ("(pid?: number): boolean =>", "(pid) =>"),
    (" as RemoteConf", ""),
)


def _conf_store_js() -> str:
    assert _CONF_REGION, "région conf-store absente de elpis-remote.ts"
    src = _CONF_REGION.group(1)
    for a, b in _TS_STRIPS:
        src = src.replace(a, b)
    return src


def test_conf_store_region_exists_and_is_self_contained():
    src = _conf_store_js()
    # la région doit rester PURE : rien du corps du plugin (client, toasts, état)
    for leak in ("client.", "toast(", "enabled =", "appBase("):
        assert leak not in src, f"fuite du corps du plugin dans conf-store : {leak}"
    assert "renameSync" in src            # remplacement atomique
    assert "process.pid" in src           # tmp par process : pas de collision
    assert "instances" in src


def test_ts_never_writes_conf_wholesale():
    # Régression v9 : `saveConf(conf)` réécrivait TOUT le fichier depuis un objet
    # en mémoire potentiellement périmé. Seul mutateConf a le droit d'écrire.
    # (Le mot peut subsister dans un commentaire d'historique — on interdit les
    # APPELS, pas la mention.)
    assert "saveConf(" not in TS
    assert TS.count("fs.writeFileSync(tmp") == 1
    # le flag global legacy est LU (repli de migration) mais jamais réécrit
    assert "c.enabled =" not in TS and "conf.enabled =" not in TS


@pytest.mark.skipif(shutil.which("node") is None, reason="node absent")
def _run_conf_store(tmp_path: Path, script: str) -> dict:
    """Exécute la VRAIE région conf-store sous Node, sur un HOME jetable."""
    home = tmp_path / "home"
    (home / ".config" / "opencode").mkdir(parents=True, exist_ok=True)
    harness = (
        'import fs from "node:fs";\n'
        'import os from "node:os";\n'
        'import path from "node:path";\n'
        f'const CONF_PATH = {json.dumps(str(home / ".config" / "opencode" / "elpis-remote.json"))};\n'
        + _conf_store_js()
        + "\n" + script + "\n"
    )
    p = tmp_path / "confstore.mjs"
    p.write_text(harness, encoding="utf-8")
    r = subprocess.run(["node", str(p)], capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout or "{}")


@pytest.mark.skipif(shutil.which("node") is None, reason="node absent")
def test_conf_store_is_valid_js_after_strip(tmp_path):
    _run_conf_store(tmp_path, 'console.log(JSON.stringify({ok: true}));')


@pytest.mark.skipif(shutil.which("node") is None, reason="node absent")
def test_enabled_is_per_project(tmp_path):
    out = _run_conf_store(tmp_path, """
      mutateConf((c) => { c.token = "pcr_x"; });
      const A = claimInstanceSlot("/home/u/projA"), B = claimInstanceSlot("/home/u/projB");
      writeInstance(A, { enabled: true });
      writeInstance(B, { enabled: false });
      const c = loadConf();
      console.log(JSON.stringify({
        a: instanceEnabled(c, A), b: instanceEnabled(c, B), token: c.token, A, B,
      }));
    """)
    assert out["a"] is True and out["b"] is False and out["token"] == "pcr_x"
    # deux répertoires = deux slots « premiers », sans suffixe
    assert out["A"] == "/home/u/projA" and out["B"] == "/home/u/projB"


@pytest.mark.skipif(shutil.which("node") is None, reason="node absent")
def test_legacy_global_enabled_is_the_default_until_project_is_set(tmp_path):
    # Poste v9 qui marchait (enabled global true) : la MAJ du plugin ne doit pas
    # débrancher la reprise auto… mais un /remote off ciblé doit primer.
    out = _run_conf_store(tmp_path, """
      fs.writeFileSync(CONF_PATH, JSON.stringify({ token: "t", enabled: true }));
      const A = claimInstanceSlot("/projA"), B = claimInstanceSlot("/projB");
      const before = instanceEnabled(loadConf(), A);
      writeInstance(A, { enabled: false });
      const c = loadConf();
      console.log(JSON.stringify({
        before, a: instanceEnabled(c, A), b: instanceEnabled(c, B),
        legacyKept: c.enabled,
      }));
    """)
    assert out == {"before": True, "a": False, "b": True, "legacyKept": True}


@pytest.mark.skipif(shutil.which("node") is None, reason="node absent")
def test_concurrent_writers_do_not_clobber(tmp_path):
    # Le scénario exact du bug : le process B tient un `conf` chargé AVANT que le
    # process A n'appaire un jeton. Sans read-modify-write, l'écriture de B
    # (son propre enabled) effaçait le jeton tout juste posé par A.
    out = _run_conf_store(tmp_path, """
      const staleB = loadConf();                 // B a lu le fichier vide
      mutateConf((c) => { c.token = "pcr_appaire_par_A"; });   // A appaire
      const B = claimInstanceSlot("/projB");
      writeInstance(B, { enabled: true });                    // B écrit ensuite
      const c = loadConf();
      console.log(JSON.stringify({
        staleHadToken: !!staleB.token,
        token: c.token,
        b: instanceEnabled(c, B),
      }));
    """)
    assert out == {"staleHadToken": False, "token": "pcr_appaire_par_A", "b": True}


@pytest.mark.skipif(shutil.which("node") is None, reason="node absent")
def test_instances_map_is_bounded(tmp_path):
    out = _run_conf_store(tmp_path, """
      // pid: 0 = slot libéré (mort) — seuls ceux-là sont éligibles au bornage
      for (let i = 0; i < 60; i++) writeInstance("/p" + i, { enabled: true, pid: 0 });
      const c = loadConf();
      const keys = Object.keys(c.instances);
      console.log(JSON.stringify({ n: keys.length, hasLast: keys.includes("/p59") }));
    """)
    assert out["n"] == 50 and out["hasLast"] is True


@pytest.mark.skipif(shutil.which("node") is None, reason="node absent")
def test_shim_is_valid_esm_javascript(tmp_path):
    # le shim ATTERRIT dans elpis-remote.js chez les clients v8 : il doit rester
    # du JS pur (une annotation TS le casserait au chargement par Bun en .js)
    p = tmp_path / "shim.mjs"
    p.write_text(SHIM.replace("__APP_URL__", "http://lan.test:8000"), encoding="utf-8")
    subprocess.run(["node", "--check", str(p)], check=True, capture_output=True)


# ── Installeur bash : run RÉEL avec curl stubé (réseau/binaire simulés) ──────

_FAKE_CURL = r"""#!/usr/bin/env bash
# stub curl : sert les endpoints attendus par install.sh (offline, via fichiers)
out=""; url=""; head=""; hdr=""
args=("$@")
for ((i=0; i<${#args[@]}; i++)); do
  a="${args[$i]}"
  case "$a" in
    -o) out="${args[$((i+1))]}" ;;
    -H) hdr="$hdr ${args[$((i+1))]}" ;;
    --head|-I) head=1 ;;
    http*|https*) url="$a" ;;
  esac
done
# Sonde « ce poste reconnaît-il déjà le certificat de l'app ? » : par défaut NON
# (c'est le cas qui nous intéresse — CA pas encore installée). FAKE_TRUSTED=1
# rejoue le poste déjà configuré, où le script ne doit RIEN réinstaller.
case "$url" in
  *"/api/public-config"*)
    if [ -n "$head" ] && [ -z "${FAKE_TRUSTED:-}" ]; then exit 60; fi ;;
esac
case "$url" in
  *"/api/cli/bundle/"*)      printf 'FAKE-OPENCODE-BINARY' > "$out" ;;
  # Config : anonyme → {} ; AVEC le jeton du compte (x-elpis-token) et
  # FAKE_MCP=1 → le serveur y ajoute le bloc mcp des outils Elpis.
  *"/api/cli/opencode.json"*)
      printf '%s\n' "$hdr" >> "${FAKE_CFG_LOG:-/dev/null}"
      case "$hdr" in
        *x-elpis-token:*) if [ -n "${FAKE_MCP:-}" ]; then printf '{"mcp":{"elpis-tools":{"url":"x"}}}' > "$out"; else printf '{}' > "$out"; fi ;;
        *) printf '{}' > "$out" ;;
      esac ;;
  *"/api/code/plugin.ts"*)   printf '// elpis-remote\nconst PLUGIN_VERSION = 9;\n' > "$out" ;;
  # PEM RÉALISTE : l'installeur vérifie le marqueur « BEGIN CERTIFICATE » avant
  # d'épingler quoi que ce soit (un proxy captif renvoie du HTML en 200, et
  # l'épingler casserait tout le TLS ensuite). ``FAKE_CA_JUNK`` rejoue ce cas.
  *"/ca.crt"*)               [ -n "${FAKE_CA:-}" ] || exit 22
                             if [ -n "${FAKE_CA_JUNK:-}" ]; then
                               printf '<html>portail captif</html>' > "$out"
                             else
                               printf -- '-----BEGIN CERTIFICATE-----\nRkFLRQ==\n-----END CERTIFICATE-----\n' > "$out"
                             fi ;;
  # ── Connexion au compte (login-lite → cookie → jeton) ──
  # Le corps JSON arrive par STDIN (--data @-) : jamais en argument.
  *"/api/login-lite"*)
      body="$(cat)"
      printf '%s' "$body" >> "${FAKE_LOGIN_LOG:-/dev/null}"
      case "$body" in
        *'"username":"alice"'*'"password":"bonmdp"'*) exit 0 ;;
        *) exit 22 ;;                       # 401 → curl -f rend 22
      esac ;;
  # EXT.1 : la config ne rend plus de jeton ; le jeton du poste est CRÉÉ
  # (POST /api/code/token, nommé d'après la machine) et montré une fois.
  *"/api/code/config"*)      printf '{"app_url":"x","tokens":0}' ;;
  *"/api/code/token"*)       printf '%s\n' "$*" >> "${FAKE_TOKEN_LOG:-/dev/null}"
                             printf '{"token":"pcr_par_login"}' ;;
  *) [ -n "$out" ] && : > "$out" ;;
esac
exit 0
"""


def _render_install_sh(https: bool = True) -> str:
    """Installeur rendu tel que servi. ``https`` simule le frontal Caddy actif :
    l'amorçage reste en http (chemin ``@bootstrap``, ici ``testserver``) mais
    ``APP_URL`` — ce que le plugin contactera — bascule en https."""
    import shared_infra.config as cfg
    app = FastAPI()
    from shared_infra.routes._state import router
    app.include_router(router)
    with mock.patch.object(cfg, "https_enabled", lambda: https), \
         mock.patch.object(cfg, "https_ports",
                           lambda: {"main": 443, "admin": 8443, "rag": 8444}):
        return TestClient(app).get("/api/cli/install.sh").text


def _render_install_ps1() -> str:
    """Installeur PowerShell rendu tel que servi (frontal https actif)."""
    import shared_infra.config as cfg
    app = FastAPI()
    from shared_infra.routes._state import router
    app.include_router(router)
    with mock.patch.object(cfg, "https_enabled", lambda: True), \
         mock.patch.object(cfg, "https_ports",
                           lambda: {"main": 443, "admin": 8443, "rag": 8444}):
        return TestClient(app).get("/api/cli/install.ps1").text


def _run_install(tmp_path: Path, env_extra: dict,
                 https: bool = True) -> subprocess.CompletedProcess:
    home = tmp_path / "home"; home.mkdir(exist_ok=True)
    bindir = tmp_path / "stub"; bindir.mkdir(exist_ok=True)
    fake = bindir / "curl"
    fake.write_text(_FAKE_CURL, encoding="utf-8")
    fake.chmod(0o755)
    script = tmp_path / "install.sh"
    script.write_text(_render_install_sh(https), encoding="utf-8")
    env = {**os.environ, **env_extra,
           "PATH": f"{bindir}:{os.environ['PATH']}",
           "HOME": str(home), "XDG_CONFIG_HOME": str(home / ".config"),
           "OPENCODE_BIN_DIR": str(home / "bin")}
    # setsid : garantit l'ABSENCE de terminal contrôlant (le prompt y/N lit
    # /dev/tty) — sinon un pytest lancé depuis un vrai tty resterait bloqué.
    cmd = (["setsid"] if shutil.which("setsid") else []) + ["bash", str(script)]
    return subprocess.run(cmd, env=env, capture_output=True,
                          text=True, timeout=60, stdin=subprocess.DEVNULL)


def test_install_sh_plugin_yes_installs_ts_and_purges_js(tmp_path):
    home = tmp_path / "home"
    plugdir = home / ".config" / "opencode" / "plugin"
    plugdir.mkdir(parents=True)
    (plugdir / "elpis-remote.js").write_text("// vieux plugin v8")   # legacy
    r = _run_install(tmp_path, {"ELPIS_INSTALL_PLUGIN": "y",
                                "ELPIS_REMOTE_TOKEN": "pcr_test"})
    assert r.returncode == 0, r.stderr
    assert (plugdir / "elpis-remote.ts").exists()
    assert not (plugdir / "elpis-remote.js").exists()   # purge : jamais 2 plugins
    conf = (home / ".config" / "opencode" / "elpis-remote.json").read_text()
    assert '"token": "pcr_test"' in conf
    assert (home / "bin" / "opencode").exists()


def test_install_sh_plugin_no_removes_existing(tmp_path):
    home = tmp_path / "home"
    plugdir = home / ".config" / "opencode" / "plugin"
    plugdir.mkdir(parents=True)
    (plugdir / "elpis-remote.ts").write_text("// elpis-remote v9")
    (plugdir / "elpis-remote.js").write_text("// vieux plugin v8")
    r = _run_install(tmp_path, {"ELPIS_INSTALL_PLUGIN": "n",
                                "ELPIS_REMOTE_TOKEN": "pcr_test"})
    assert r.returncode == 0, r.stderr
    assert not (plugdir / "elpis-remote.ts").exists()   # refus ⇒ retrait complet
    assert not (plugdir / "elpis-remote.js").exists()
    # pas de conf jeton pour un plugin refusé
    assert not (home / ".config" / "opencode" / "elpis-remote.json").exists()
    assert (home / "bin" / "opencode").exists()          # opencode installé quand même


def test_install_sh_non_interactive_defaults(tmp_path):
    # Sans env ni tty : défaut = y. La commande d'install est ANONYME (plus de
    # jeton pour signaler l'intention) — mais elle est servie par l'app, donc
    # vouloir le plugin est le cas courant ; `ELPIS_INSTALL_PLUGIN=n` refuse.
    r = _run_install(tmp_path, {})
    assert r.returncode == 0, r.stderr
    assert (tmp_path / "home" / ".config" / "opencode" / "plugin" / "elpis-remote.ts").exists()
    assert "non interactif" in r.stdout
    shutil.rmtree(tmp_path / "home")
    r2 = _run_install(tmp_path, {"ELPIS_INSTALL_PLUGIN": "n"})
    assert r2.returncode == 0, r2.stderr
    assert not (tmp_path / "home" / ".config" / "opencode" / "plugin" / "elpis-remote.ts").exists()


def test_install_sh_writes_target_conf_without_any_token(tmp_path):
    # Cœur du changement : SANS jeton, la conf est quand même posée (cible +
    # CA épinglée). Sans elle le plugin retomberait en « insecure » à la
    # première erreur de certificat, et /remote login taperait à l'aveugle.
    r = _run_install(tmp_path, {"ELPIS_INSTALL_PLUGIN": "y", "FAKE_CA": "1"})
    assert r.returncode == 0, r.stderr
    conf = _remote_conf(tmp_path)
    assert conf["token"] == ""                       # anonyme — appairage après coup
    assert conf["app_url"] == "https://testserver"
    assert conf["ca_file"].endswith("elpis-ca.crt")  # vérification RÉELLE conservée
    assert conf["enabled"] is False
    assert "/remote login" in r.stdout


def test_install_sh_reinstall_keeps_paired_token(tmp_path):
    # Ré-install SANS jeton sur un poste déjà appairé : ne pas le désappairer.
    r = _run_install(tmp_path, {"ELPIS_INSTALL_PLUGIN": "y",
                                "ELPIS_REMOTE_TOKEN": "pcr_deja_appaire"})
    assert r.returncode == 0, r.stderr
    assert _remote_conf(tmp_path)["token"] == "pcr_deja_appaire"
    r2 = _run_install(tmp_path, {"ELPIS_INSTALL_PLUGIN": "y"})
    assert r2.returncode == 0, r2.stderr
    assert _remote_conf(tmp_path)["token"] == "pcr_deja_appaire"


# ── Amorçage en clair : la CA locale est épinglée pour le plugin ─────────────
# La commande copiée par l'utilisateur passe par http://<ip>/opencode (Caddy
# :80) — donc AUCUN TLS à contourner pour l'amorçage. Mais l'app, elle, écoute
# en https : le script doit récupérer la CA (servie en clair sur /ca.crt) et
# l'épingler dans elpis-remote.json, sinon le plugin retombe en non vérifié.

def _remote_conf(tmp_path: Path) -> dict:
    p = tmp_path / "home" / ".config" / "opencode" / "elpis-remote.json"
    return json.loads(p.read_text(encoding="utf-8"))


def test_install_sh_pins_local_ca_for_the_plugin(tmp_path):
    r = _run_install(tmp_path, {"ELPIS_INSTALL_PLUGIN": "y",
                                "ELPIS_REMOTE_TOKEN": "pcr_test",
                                "FAKE_CA": "1"})
    assert r.returncode == 0, r.stderr
    cfg_dir = tmp_path / "home" / ".config" / "opencode"
    conf = _remote_conf(tmp_path)
    # app_url = URL de l'APP (https), pas la base de téléchargement (http)
    assert conf["app_url"] == "https://testserver"
    assert conf["ca_file"] == str(cfg_dir / "elpis-ca.crt")
    assert "BEGIN CERTIFICATE" in (cfg_dir / "elpis-ca.crt").read_text()
    assert "insecure" not in conf                    # vérification RÉELLE, pas de repli


def test_install_sh_seeds_plugin_deps_for_offline_start(tmp_path):
    """Pré-amorçage npm : LE correctif du démarrage à 30-90 s.

    Dès qu'un plugin est présent, opencode lance un ``npm install
    @opencode-ai/plugin`` dans le dossier de config et BLOQUE le chargement des
    plugins dessus — donc l'affichage du TUI. Hors ligne, il n'aboutit jamais.
    opencode saute l'install si ``node_modules`` existe ET que le lock déclare
    la dépendance : c'est ce trio que l'installeur pose.
    """
    r = _run_install(tmp_path, {"ELPIS_INSTALL_PLUGIN": "y"})
    assert r.returncode == 0, r.stderr
    cfg = tmp_path / "home" / ".config" / "opencode"
    assert (cfg / "node_modules").is_dir()
    pkg = json.loads((cfg / "package.json").read_text())
    lock = json.loads((cfg / "package-lock.json").read_text())
    assert "@opencode-ai/plugin" in pkg["dependencies"]
    # le contrat exact lu par opencode (core/src/npm.ts › install › checkDirty) :
    # tout paquet déclaré doit figurer dans packages[""] du lock, sinon reify()
    assert "@opencode-ai/plugin" in lock["packages"][""]["dependencies"]


def test_install_sh_seed_never_clobbers_a_real_node_modules(tmp_path):
    # Un poste qui a déjà de VRAIES dépendances installées ne doit pas les voir
    # remplacées par un dossier vide (opencode ne les réinstallerait jamais).
    cfg = tmp_path / "home" / ".config" / "opencode"
    (cfg / "node_modules" / "@opencode-ai").mkdir(parents=True)
    (cfg / "node_modules" / "@opencode-ai" / "marqueur").write_text("x")
    r = _run_install(tmp_path, {"ELPIS_INSTALL_PLUGIN": "y"})
    assert r.returncode == 0, r.stderr
    assert (cfg / "node_modules" / "@opencode-ai" / "marqueur").exists()
    assert not (cfg / "package-lock.json").exists()   # rien n'a été inventé


def test_install_sh_installs_the_ca_on_the_machine_by_default(tmp_path):
    """Réseau local sans Internet : amorçage en clair, PUIS la CA sur le poste.

    C'est la seule façon de garder un https réellement vérifié partout (curl,
    git, navigateur) sans `-k`. Le défaut est donc « on installe » — refuser
    reste possible via ELPIS_TRUST_CA=n.
    """
    r = _run_install(tmp_path, {"ELPIS_INSTALL_PLUGIN": "y", "FAKE_CA": "1"})
    assert r.returncode == 0, r.stderr
    # pas de root ni de sudo dans le bac à sable de test : le script ne doit pas
    # échouer, mais DIRE quoi faire — jamais laisser l'utilisateur sans issue.
    out = r.stdout
    assert "CA locale récupérée" in out
    # sans root ni sudo : le script ne DOIT pas échouer, mais donner la commande
    assert "magasin système" in out
    assert "update-ca-certificates" in out or "update-ca-trust" in out
    # et surtout : la CA reste posée à un emplacement DURABLE (hors $TMP)
    cfg = tmp_path / "home" / ".config" / "opencode"
    assert (cfg / "elpis-ca.crt").is_file()
    assert _remote_conf(tmp_path)["ca_file"] == str(cfg / "elpis-ca.crt")


def test_install_sh_skips_trust_when_cert_already_valid(tmp_path):
    # Poste déjà configuré (CA dans le magasin) : une ré-install ne doit RIEN
    # retoucher au magasin de confiance, ni le dire à moitié.
    r = _run_install(tmp_path, {"ELPIS_INSTALL_PLUGIN": "y", "FAKE_CA": "1",
                                "FAKE_TRUSTED": "1"})
    assert r.returncode == 0, r.stderr
    assert "déjà reconnu" in r.stdout
    assert "update-ca-certificates" not in r.stdout


def test_install_sh_trust_can_be_declined(tmp_path):
    r = _run_install(tmp_path, {"ELPIS_INSTALL_PLUGIN": "y", "FAKE_CA": "1",
                                "ELPIS_TRUST_CA": "n"})
    assert r.returncode == 0, r.stderr
    assert "ELPIS_TRUST_CA=n" in r.stdout
    # refuser le magasin ne doit PAS dégrader le reste : la CA est épinglée,
    # donc opencode et le greffon vérifient toujours réellement le certificat.
    assert _remote_conf(tmp_path).get("ca_file", "").endswith("elpis-ca.crt")
    assert "insecure" not in _remote_conf(tmp_path)


def test_install_sh_ca_survives_a_refused_plugin(tmp_path):
    # Sans le greffon, la CA doit quand même rester sur le poste : c'est elle
    # qui permet à curl/git de parler à l'app. Avant, elle vivait dans $TMP et
    # n'était copiée que dans la branche « plugin installé ».
    r = _run_install(tmp_path, {"ELPIS_INSTALL_PLUGIN": "n", "FAKE_CA": "1"})
    assert r.returncode == 0, r.stderr
    assert (tmp_path / "home" / ".config" / "opencode" / "elpis-ca.crt").is_file()


def test_install_sh_refuses_to_pin_a_non_certificate(tmp_path):
    # Portail captif / page d'erreur en 200 : épingler ça casserait tout le TLS
    # ensuite (et le message d'erreur serait incompréhensible). On n'épingle pas.
    r = _run_install(tmp_path, {"ELPIS_INSTALL_PLUGIN": "y", "ELPIS_REMOTE_TOKEN": "pcr_t",
                                "FAKE_CA": "1", "FAKE_CA_JUNK": "1"})
    assert r.returncode == 0, r.stderr
    conf = _remote_conf(tmp_path)
    assert "ca_file" not in conf
    assert conf.get("insecure") is True          # repli explicite, pas silencieux
    assert "CA locale introuvable" in r.stdout


def test_install_sh_insecure_fallback_when_ca_unreachable(tmp_path):
    # CA introuvable (Caddy pas à jour / :80 filtré) → repli explicite
    r = _run_install(tmp_path, {"ELPIS_INSTALL_PLUGIN": "y",
                                "ELPIS_REMOTE_TOKEN": "pcr_test"})
    assert r.returncode == 0, r.stderr
    conf = _remote_conf(tmp_path)
    assert conf["app_url"] == "https://testserver"
    assert conf["insecure"] is True
    assert "ca_file" not in conf


def test_install_sh_http_only_deployment_needs_no_ca(tmp_path):
    # Sans frontal TLS : APP_URL == BASE (http) → ni CA, ni insecure.
    r = _run_install(tmp_path, {"ELPIS_INSTALL_PLUGIN": "y",
                                "ELPIS_REMOTE_TOKEN": "pcr_test",
                                "FAKE_CA": "1"}, https=False)
    assert r.returncode == 0, r.stderr
    conf = _remote_conf(tmp_path)
    assert conf["app_url"] == "http://testserver"
    assert "ca_file" not in conf and "insecure" not in conf


# ── Connexion au compte DEPUIS L'INSTALLEUR ─────────────────────────────────
# Pourquoi ici et pas dans /remote : l'API plugin d'opencode n'expose aucune
# primitive de saisie, donc un mot de passe passé à la commande slash serait
# affiché dans le TUI et conservé dans son historique. L'installeur, lui, a un
# vrai terminal → frappe masquée (stty -echo). Ces tests tournent donc sous PTY.

def _run_install_pty(tmp_path: Path, keys: str, env_extra: dict | None = None,
                     https: bool = True) -> tuple[str, Path]:
    """Lance l'installeur AVEC un terminal et pousse ``keys`` au prompt."""
    import pty
    import select

    home = tmp_path / "home"; home.mkdir(exist_ok=True)
    bindir = tmp_path / "stub"; bindir.mkdir(exist_ok=True)
    fake = bindir / "curl"
    fake.write_text(_FAKE_CURL, encoding="utf-8")
    fake.chmod(0o755)
    script = tmp_path / "install.sh"
    script.write_text(_render_install_sh(https), encoding="utf-8")
    login_log = tmp_path / "login_body.txt"
    env = {**os.environ, **(env_extra or {}),
           "PATH": f"{bindir}:{os.environ['PATH']}",
           "HOME": str(home), "XDG_CONFIG_HOME": str(home / ".config"),
           "OPENCODE_BIN_DIR": str(home / "bin"),
           "FAKE_LOGIN_LOG": str(login_log)}

    pid, fd = pty.fork()
    if pid == 0:                                  # enfant : devient le script
        try:
            os.execvpe("bash", ["bash", str(script)], env)
        finally:
            os._exit(127)
    out = b""
    os.write(fd, keys.encode())
    deadline = time.time() + 45
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 1.0)
        if r:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
        if os.waitpid(pid, os.WNOHANG)[0]:
            break
    try:
        os.close(fd)
    except OSError:
        pass
    with contextlib.suppress(Exception):
        os.waitpid(pid, 0)
    return out.decode(errors="replace"), login_log


def _remote_json(tmp_path: Path) -> dict:
    return json.loads((tmp_path / "home" / ".config" / "opencode"
                       / "elpis-remote.json").read_text(encoding="utf-8"))


def test_installer_login_exchanges_credentials_for_token(tmp_path):
    # plugin=y, connexion=y (défaut), identifiants valides → jeton posé.
    tok_log = tmp_path / "token.log"
    out, login_log = _run_install_pty(
        tmp_path, keys="y\nalice\nbonmdp\n",
        env_extra={"ELPIS_INSTALL_PLUGIN": "y", "FAKE_TOKEN_LOG": str(tok_log)})
    assert "Connecté (alice)" in out or "Connecte (alice)" in out, out[-1500:]
    assert _remote_json(tmp_path)["token"] == "pcr_par_login"
    # EXT.1 : jeton DE CE POSTE, créé par POST et nommé d'après la machine.
    appel = tok_log.read_text(encoding="utf-8")
    assert "-X POST" in appel and '"name":"opencode - ' in appel
    # le mot de passe part en CORPS JSON (jamais dans l'URL → access logs)
    assert '"password":"bonmdp"' in login_log.read_text(encoding="utf-8")


def test_installer_login_adds_elpis_tools_mcp_to_opencode_json(tmp_path):
    """(2026-09-03) Après connexion, la config opencode est re-récupérée AVEC
    le jeton du compte : si le serveur y met le bloc ``mcp`` (service MCP
    partagé et authentifié), elle remplace celle posée anonymement."""
    cfg_log = tmp_path / "cfg.log"
    out, _ = _run_install_pty(
        tmp_path, keys="y\nalice\nbonmdp\n",
        env_extra={"ELPIS_INSTALL_PLUGIN": "y", "FAKE_MCP": "1",
                   "FAKE_CFG_LOG": str(cfg_log)})
    assert "Outils Elpis (MCP" in out and "ajoutés" in out, out[-1500:]
    assert "x-elpis-token: pcr_par_login" in cfg_log.read_text(encoding="utf-8")
    cfg = json.loads((tmp_path / "home" / ".config" / "opencode" / "opencode.json").read_text(encoding="utf-8"))
    assert "elpis-tools" in cfg["mcp"]


def test_installer_leaves_config_alone_when_mcp_not_exposed(tmp_path):
    """Serveur sans service MCP partagé : la config anonyme reste telle quelle."""
    out, _ = _run_install_pty(
        tmp_path, keys="y\nalice\nbonmdp\n",
        env_extra={"ELPIS_INSTALL_PLUGIN": "y"})
    assert "non exposés" in out, out[-1500:]
    cfg = json.loads((tmp_path / "home" / ".config" / "opencode" / "opencode.json").read_text(encoding="utf-8"))
    assert "mcp" not in cfg


def test_installer_login_can_be_declined(tmp_path):
    out, _ = _run_install_pty(tmp_path, keys="n\n",
                              env_extra={"ELPIS_INSTALL_PLUGIN": "y"})
    conf = _remote_json(tmp_path)
    assert conf["token"] == ""                    # cible posée, pas de jeton
    assert conf["app_url"]
    assert "/remote login" in out                 # on renvoie vers l'autre voie


def test_installer_login_retries_on_bad_credentials(tmp_path):
    # mauvais mot de passe puis bon : l'installeur redemande au lieu d'abandonner
    out, _ = _run_install_pty(
        tmp_path, keys="y\nalice\nmauvais\nalice\nbonmdp\n",
        env_extra={"ELPIS_INSTALL_PLUGIN": "y"})
    assert "refus" in out.lower(), out[-1500:]
    assert _remote_json(tmp_path)["token"] == "pcr_par_login"


def test_installer_skips_login_when_token_already_known(tmp_path):
    # ELPIS_REMOTE_TOKEN fourni → aucune question de connexion.
    out, _ = _run_install_pty(
        tmp_path, keys="",
        env_extra={"ELPIS_INSTALL_PLUGIN": "y", "ELPIS_REMOTE_TOKEN": "pcr_env"})
    assert "Connecter votre compte" not in out
    assert _remote_json(tmp_path)["token"] == "pcr_env"


def test_installer_ps1_login_uses_masked_input_and_json_body():
    ps1 = _render_install_ps1()
    # frappe masquée (jamais Read-Host nu pour le mot de passe)
    assert "-AsSecureString" in ps1
    assert "ZeroFreeBSTR" in ps1                       # le BSTR est libéré
    # corps JSON + session : jamais d'identifiants dans l'URL
    assert "/api/login-lite" in ps1 and "ConvertTo-Json -Compress" in ps1
    assert "-WebSession $sess" in ps1
    # Invoke-RestMethod a SA propre entrée SkipCertificateCheck (cmdlet distincte)
    assert "Invoke-RestMethod:SkipCertificateCheck" in ps1


# ── Sémantique de /remote et des commandes visant la CLI ────────────────────
# Symptômes rapportés : (a) « /remote » sur une 2e instance répondait « Remote
# désactivé » alors que la session s'activait ; (b) /exit tuait le serveur sous
# un TUI vivant, et /new annonçait « ouverte ici » même quand le TUI n'avait pas
# basculé — d'où l'impression d'un opencode qui tourne en arrière-plan.

def test_remote_activates_and_never_toggles_off():
    # La reprise auto remet `enabled` à true SANS le dire : en bascule, /remote
    # coupait donc au moment où l'utilisateur voulait activer.
    assert 'if (enabled && !arg) { stop();' not in TS
    branch = TS.split('} else if (!arg || arg === "on") {', 1)[1].split("} else {", 1)[0]
    assert "déjà actif" in branch                  # message honnête
    assert "snapshot(input.sessionID)" in branch   # et la session est publiée
    assert "stop()" not in branch                  # /remote n'éteint plus jamais
    # couper reste possible, explicitement
    assert 'arg === "off"' in TS


def test_two_live_processes_in_the_same_dir_get_distinct_slots(tmp_path):
    out = _run_conf_store(tmp_path, """
      // process 1 (nous) prend le 1er slot et l'active
      const A = claimInstanceSlot("/w/proj");
      writeInstance(A, { enabled: true });
      // process 2 : on simule un VOISIN VIVANT en plaçant notre propre pid sur
      // le slot 1 (pidAlive(process.pid) === true), puis on re-réclame.
      const B = claimInstanceSlot("/w/proj");
      const c = loadConf();
      console.log(JSON.stringify({
        A, B,
        aEnabled: instanceEnabled(c, A),
        bEnabled: instanceEnabled(c, B),
      }));
    """)
    assert out["A"] == "/w/proj"
    assert out["B"] == "/w/proj#2", out          # slot distinct
    assert out["aEnabled"] is True
    # un slot supplémentaire démarre ÉTEINT : sinon on recrée le couplage
    assert out["bEnabled"] is False


def test_dead_slot_is_reclaimed_and_keeps_its_setting(tmp_path):
    # Redémarrage : le pid d'avant est mort → on REPREND le slot 1 (pas #2) et
    # son `enabled` est conservé (c'est la reprise auto attendue).
    out = _run_conf_store(tmp_path, """
      fs.writeFileSync(CONF_PATH, JSON.stringify({
        token: "t",
        instances: { "/w/proj": { enabled: true, pid: 999999, dir: "/w/proj" } },
      }));
      const K = claimInstanceSlot("/w/proj");
      const c = loadConf();
      console.log(JSON.stringify({
        K, enabled: instanceEnabled(c, K), pid: c.instances[K].pid, mine: process.pid,
      }));
    """)
    assert out["K"] == "/w/proj"                  # slot repris, pas un nouveau
    assert out["enabled"] is True                 # réglage conservé
    assert out["pid"] == out["mine"]              # occupé par nous


def test_released_slot_is_reusable_without_losing_its_setting(tmp_path):
    out = _run_conf_store(tmp_path, """
      const A = claimInstanceSlot("/w/proj");
      writeInstance(A, { enabled: true });
      releaseInstanceSlot(A);                     // sortie propre (dispose)
      const after = loadConf().instances[A];
      const B = claimInstanceSlot("/w/proj");     // relance : même slot
      console.log(JSON.stringify({
        freedPid: after.pid, keptEnabled: after.enabled,
        B, enabled: instanceEnabled(loadConf(), B),
      }));
    """)
    assert out["freedPid"] == 0 and out["keptEnabled"] is True
    assert out["B"] == "/w/proj" and out["enabled"] is True


def test_trim_never_evicts_a_live_slot(tmp_path):
    # Le bornage ne doit pas libérer le slot d'un process vivant.
    out = _run_conf_store(tmp_path, """
      const live = claimInstanceSlot("/w/live");
      for (let i = 0; i < 60; i++) writeInstance("/w/dead" + i, { pid: 0 });
      const c = loadConf();
      console.log(JSON.stringify({
        stillThere: !!c.instances[live],
        livePid: c.instances[live] ? c.instances[live].pid : null,
        mine: process.pid,
        total: Object.keys(c.instances).length,
      }));
    """)
    assert out["stillThere"] is True
    assert out["livePid"] == out["mine"]
    assert out["total"] <= 50


def test_snapshot_failure_does_not_blacklist_the_session():
    # Régression : sur échec transitoire la session restait marquée
    # « snapshottée » et n'était jamais republiée de tout le run.
    body = TS.split("const snapshot = ", 1)[1].split("const sessionHasMessages", 1)[0]
    catch_part = body.split("} catch {", 1)[1]
    assert "snapshotted.delete(sid)" in catch_part


def test_auto_resume_announces_the_new_client():
    # start() et la reprise auto doivent passer par la MÊME annonce : sans elle,
    # un opencode redémarré n'existait pour l'app qu'au premier long-poll.
    assert "const announce = (" in TS
    resume = TS.split("if (instanceEnabled(conf, instKey) && conf.token)", 1)[1].split("}", 1)[0]
    assert "announce()" in resume
    start_body = TS.split("const start = (", 1)[1].split("const activate", 1)[0]
    assert "announce()" in start_body
    # plus de duplication de l'ingest d'annonce
    assert TS.count('"/api/code/ingest", { method: "POST",') == 1


def test_remote_when_already_active_reannounces_and_is_honest():
    branch = TS.split('} else if (!arg || arg === "on") {', 1)[1].split("} else {", 1)[0]
    assert "announce()" in branch                       # l'action sert à quelque chose
    assert "sessionExists(input.sessionID)" in branch
    # message honnête quand opencode n'a pas encore de session à publier
    assert "premier message" in branch



def test_activation_message_does_not_promise_an_unpublished_session():
    act = TS.split("const activate = ", 1)[1].split("const stop = ", 1)[0]
    # on teste l'EXISTENCE de la session, pas ses messages : `input.sessionID`
    # est fourni même quand opencode n'a encore rien matérialisé
    assert "sessionExists" in act
    assert "premier message" in act                  # explique le cas irréductible
    # les 3 sites d'activation passent par le helper (plus de message figé)
    assert TS.count("await activate(") == 3
    assert "— session visible dans la page Remote code.\"; }" not in TS



def test_tui_is_driven_through_publish_not_execute_command():
    # ⚠ `selectSession` EXISTE (POST /tui/select-session {sessionID}, vérifié sur
    # l'OpenAPI de 1.17.7 ET 1.18.16) — l'affirmation inverse des versions ≤ v12
    # est ce qui rendait « Nouvelle session » inutilisable. Il est donc utilisé,
    # mais en appel FACULTATIF (un serve headless n'a aucun TUI au bout).
    assert "selectSession" in TS
    assert "client.tui.executeCommand" not in TS     # mesuré inerte
    body = TS.split("const tuiCommand = ", 1)[1].split("const toast = ", 1)[0]
    assert "client.tui.publish" in body
    assert '"tui.command.execute"' in body


def test_new_creates_the_session_then_switches_the_tui():
    """« Nouvelle session » doit produire quelque chose de VISIBLE.

    `session.new` du TUI ne matérialise rien (opencode crée la session au premier
    message, mesuré 1.17.7 et 1.18.16) : la page restait vide, d'où le « /new ne
    fait rien ». v13 crée la session par l'API — donc elle existe et se publie —
    puis bascule le TUI dessus via `tui.selectSession` (qui existe bel et bien).
    """
    new_branch = TS.split('action === "new"', 1)[1].split('action === "delete"', 1)[0]
    code = "\n".join(l for l in new_branch.splitlines() if not l.strip().startswith("//"))
    assert "client.session.create" in code
    assert "selectSession" in code
    assert "snapshot(created)" in code               # visible sans attendre l'event
    assert "session_new" not in code                 # clé de keybind, pas commande
    # le raccourci TUI reste le REPLI quand la création échoue — jamais les deux
    # (sinon deux sessions pour un seul clic)
    assert 'tuiCommand("session.new")' in code
    assert code.index("client.session.create") < code.index('tuiCommand("session.new")')



def test_exit_uses_a_signal_because_no_tui_exit_command_exists():
    exit_branch = TS.split('c.kind === "exit"', 1)[1].split("}\n        }", 1)[0]
    code = "\n".join(l for l in exit_branch.splitlines() if not l.strip().startswith("//"))
    assert "app_exit" not in code                    # n'existe pas dans l'enum
    assert "SIGTERM" in code
    assert code.index("SIGTERM") < code.rindex("process.exit(0)")


def test_empty_sessions_are_published_and_deduped_upstream():
    """v13 : le greffon publie AUSSI les sessions vides.

    La règle inverse (v≤12) évitait des entrées fantômes au redémarrage, mais
    produisait pire : une session fraîche restait invisible pendant que la page
    affichait « CLI connectée ». Le fantôme se traite désormais côté app, là où
    l'on voit toutes les sessions d'une CLI (`_prune_empty_siblings`).
    """
    body = TS.split("const snapshot = ", 1)[1].split("const sessionExists", 1)[0]
    assert "if (!msgs.length)" not in body            # plus de rétention
    assert "allowEmpty" not in TS                     # ni exception ponctuelle
    # un échec transitoire doit toujours rendre la session republiable
    assert "snapshotted.delete(sid)" in body
    # le garde-fou anti-fantômes existe bien, côté store
    store = (REPO / "shared_infra" / "opencode" / "store.py").read_text(encoding="utf-8")
    assert "_prune_empty_siblings" in store




def test_question_kind_is_forwarded_and_answered_through_the_inner_client():
    # v14 : l'outil `question` BLOQUE le tour jusqu'à la réponse ; les 3 events
    # sont remontés et la page répond via le kind "question" (reply | reject).
    fwd = TS.split("const FORWARD = new Set<string>([", 1)[1].split("]);", 1)[0]
    for ev in ("question.asked", "question.replied", "question.rejected"):
        assert f'"{ev}"' in fwd, ev
    assert 'c.kind === "question"' in TS
    body = TS.split("const answerQuestion = ", 1)[1].split("// au démarrage, command.list()", 1)[0]
    # ⚠ le SDK v1 reçu par les plugins (1.17.7 ET 1.18.16) n'a PAS de ressource
    # `question` : le chemin réel est le client HTTP interne des méthodes
    # générées (fonctionne aussi sans port, via le fetch in-process) ; SDK
    # futur d'abord, fetch brut sur serverUrl en dernier recours.
    assert "client.question" in body
    assert "client._client" in body and 'raw.post({' in body
    assert "serverUrl" in body
    assert '"/question/{requestID}/" + verb' in body
    # un client hey-api ne throw PAS sur 4xx/5xx : {error} doit devenir un échec
    # (sinon la page croirait la réponse livrée et la CLI resterait bloquée)
    assert body.count("failedHttp(r)") >= 2
    # le refus part sans body (`/reject`), la réponse avec {answers}
    assert 'answers ? "reply" : "reject"' in body
    # la commande est refusée si ni réponses ni refus (jamais un appel à vide)
    guard = TS.split('c.kind === "question"', 1)[1].split("{", 1)[0]
    assert "Array.isArray(c.answers)" in guard and 'c.response === "reject"' in guard
