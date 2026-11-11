# SPDX-License-Identifier: MIT
"""tests/deploy/test_deploiement_core_node.py — ./elpis lance main et admin par le core Node : unités systemd, gardes, arrêt gracieux, relance après redémarrage, doctor."""
from __future__ import annotations

import getpass
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
DIST = REPO / "apps" / "core" / "dist"


@pytest.fixture
def racine(tmp_path):
    r = tmp_path / "elpis"
    for d in ("deploy/node", "deploy/toolhost", "apps/core/dist", "apps/toolhost/dist", "venv/bin", "rag_app",
              "user_db/run"):
        (r / d).mkdir(parents=True)
    for f in ("elpis", "deploy/node/node.env", "deploy/node/runtime.sh", "deploy/node/relance.sh",
              "deploy/prerequis-apt.sh", "deploy/prerequis-apt.txt"):
        shutil.copy2(REPO / f, r / f)
    (r / "venv/bin/python").symlink_to(sys.executable)
    _executable(r / "venv/bin/uvicorn", "#!/bin/sh\nexit 0\n")
    (r / "config.json").write_text("{}", encoding="utf-8")
    (r / "apps/core/dist/main.mjs").write_text("", encoding="utf-8")
    (r / "apps/toolhost/dist/main.mjs").write_text("", encoding="utf-8")
    return r


def _executable(chemin: Path, texte: str) -> Path:
    chemin.write_text(texte, encoding="utf-8")
    chemin.chmod(0o755)
    return chemin


def _faux_node(racine: Path, version: str = "24.21.0") -> Path:
    return _executable(racine / "faux-node", f'#!/bin/sh\n[ "$1" = -v ] && {{ echo v{version}; exit 0; }}\nexit 0\n')


def _elpis(racine: Path, *args: str, node: Path | str, timeout: float = 120) -> subprocess.CompletedProcess:
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(racine), "LANG": "C.UTF-8",
           "ELPIS_USER": getpass.getuser(), "ELPIS_NODE": str(node)}
    return subprocess.run(["bash", str(racine / "elpis"), *args], env=env, capture_output=True, text=True,
                          timeout=timeout, cwd=str(racine), stdin=subprocess.DEVNULL)


def _unites(sortie: str) -> dict[str, str]:
    return {m[1]: m[2] for m in re.finditer(r"^### (\S+)\n(.*?)(?=^### |\Z)", sortie, re.S | re.M)}


def test_unites_du_core_node(racine):
    node = _faux_node(racine)
    r = _elpis(racine, "service", "print", node=node)
    assert r.returncode == 0, r.stderr
    unites = _unites(r.stdout)
    for mode in ("main", "admin"):
        lignes = unites[f"elpis-{mode}.service"].splitlines()
        assert f"ExecStart={node} --enable-source-maps --use-system-ca {racine}/apps/core/dist/main.mjs " in lignes
        for attendue in (f'Environment="APP_MODE={mode}"', f'Environment="APP_SERVICE={mode}"',
                         f'Environment="ELPIS_RACINE={racine}"', 'Environment="MAIN_INTERNAL_URL=http://127.0.0.1:8001"',
                         'Environment="LOCAL_MCP_URL=http://127.0.0.1:8765/mcp"', f"EnvironmentFile=-{racine}/.env",
                         f"WorkingDirectory={racine}", "Restart=always", "SuccessExitStatus=75", "KillMode=mixed",
                         "KillSignal=SIGTERM", "TimeoutStopSec=310",
                         "After=elpis-toolhost.service elpis-rag.service elpis-browser.service caddy.service"):
            assert attendue in lignes, (mode, attendue)
        assert "gunicorn" not in unites[f"elpis-{mode}.service"]
        assert "relance.sh" not in unites[f"elpis-{mode}.service"]
    assert 'Environment="ENABLE_CLI=1"' in unites["elpis-main.service"].splitlines()
    assert not any("APP_NODE_BIN" in ligne for ligne in unites["elpis-toolhost.service"].splitlines())
    lignes = unites["elpis-rag.service"].splitlines()
    assert "TimeoutStopSec=30" in lignes and "Restart=on-failure" in lignes
    assert not any(ligne.startswith("KillSignal") for ligne in lignes)
    assert {"elpis-main.service", "elpis-admin.service", "elpis-toolhost.service"} \
        <= set(unites["elpis.target"].split("Wants=")[1].split())
    for retire in ("elpis-appmcp.service", "elpis-tools.service"):
        assert retire not in unites and retire not in unites["elpis.target"]


def test_elpis_appmcp_python_ignore(racine):
    """ELPIS_APPMCP=python dans .env (retour arrière retiré en 0.1.0) : aucune unité appmcp, main et admin inchangés."""
    (racine / ".env").write_text("ELPIS_APPMCP=python\n", encoding="utf-8")
    r = _elpis(racine, "service", "print", node=_faux_node(racine))
    assert r.returncode == 0, r.stderr
    unites = _unites(r.stdout)
    assert "elpis-appmcp.service" not in unites and "elpis-appmcp.service" not in unites["elpis.target"]
    for mode in ("main", "admin"):
        assert "After=elpis-toolhost.service elpis-rag.service elpis-browser.service caddy.service" \
            in unites[f"elpis-{mode}.service"].splitlines()


def test_hote_d_outils_ts_sans_elpis_tools(racine):
    """L'hôte d'outils est le bundle Node (relancé sur 75 comme le core) ; elpis-tools et son amont n'existent plus."""
    node = _faux_node(racine)
    r = _elpis(racine, "service", "print", node=node)
    assert r.returncode == 0, r.stderr
    unites = _unites(r.stdout)
    hote = unites["elpis-toolhost.service"].splitlines()
    assert f"ExecStart={node} --enable-source-maps --use-system-ca {racine}/apps/toolhost/dist/main.mjs " in hote
    for attendue in (f'Environment="ELPIS_RACINE={racine}"', 'Environment="TOOLHOST_APP_URL=http://127.0.0.1:8001"',
                     'Environment="LOCAL_MCP_PORT=8765"', "Restart=always", "SuccessExitStatus=75", "TimeoutStopSec=30",
                     "After=network-online.target docker.service"):
        assert attendue in hote, attendue
    assert not any(m in ligne for ligne in hote for m in ("-m toolhost", "UPSTREAM", "elpis-tools"))
    assert "elpis-tools.service" not in unites
    (racine / ".env").write_text("ELPIS_TOOLS_PORT=9917\n", encoding="utf-8")
    unites = _unites(_elpis(racine, "service", "print", node=node).stdout)
    assert "9917" not in unites["elpis-toolhost.service"] and "elpis-tools.service" not in unites


def test_elpis_toolhost_python_ignore(racine):
    """ELPIS_TOOLHOST=python dans .env (retour arrière retiré en 0.1.0) : l'hôte reste le bundle Node, sans elpis-tools."""
    node = _faux_node(racine)
    (racine / ".env").write_text("ELPIS_TOOLHOST=python\n", encoding="utf-8")
    r = _elpis(racine, "service", "print", node=node)
    assert r.returncode == 0, r.stderr
    unites = _unites(r.stdout)
    hote = unites["elpis-toolhost.service"].splitlines()
    assert f"ExecStart={node} --enable-source-maps --use-system-ca {racine}/apps/toolhost/dist/main.mjs " in hote
    assert not any("-m toolhost" in ligne for ligne in hote)
    assert "elpis-tools.service" not in unites["elpis.target"]


def test_sans_bundle_de_l_hote_pas_d_unite_de_l_hote(racine):
    (racine / "apps/toolhost/dist/main.mjs").unlink()
    r = _elpis(racine, "service", "print", node=_faux_node(racine))
    assert r.returncode == 0, r.stderr
    assert "toolhost non installé" in r.stderr and "tools non installé" not in r.stderr
    assert "elpis-toolhost.service" not in set(_unites(r.stdout))


def _node_natives(racine: Path, natives: str = "browser,fs") -> Path:
    (racine / "natives").write_text(natives + "\n", encoding="utf-8")
    return _executable(racine / "faux-node-hote", '#!/bin/sh\n[ "$1" = -v ] && { echo v24.21.0; exit 0; }\n'
                       'case " $* " in *" --familles-natives "*) cat "$(dirname "$0")/natives" ;; esac\nexit 0\n')


def test_doctor_et_status_sans_elpis_tools(racine):
    """Le doctor affiche les familles servies par l'hôte d'outils et signale les réglages obsolètes ; status n'a plus de ligne tools."""
    (racine / ".env").write_text("ELPIS_TOOLS_PORT=9917\n", encoding="utf-8")
    r = _elpis(racine, "doctor", node=_node_natives(racine), timeout=300)
    assert "hôte d'outils : familles servies browser,fs (toolhost.json › families)" in r.stdout
    assert "elpis-tools" not in r.stdout + r.stderr and "9917" not in r.stdout + r.stderr
    assert not re.search(r"^\s+tools\s", _elpis(racine, "status", node=_faux_node(racine)).stdout, re.M)
    (racine / "toolhost.json").write_text('{"mcp_upstream": "http://127.0.0.1:8767/mcp"}', encoding="utf-8")
    r = _elpis(racine, "doctor", node=_node_natives(racine, ""), timeout=300)
    assert "hôte d'outils : familles servies aucune" in r.stdout
    assert "familles_natives / mcp_upstream sont obsolètes" in r.stderr


@pytest.mark.parametrize("env_fichier,attendu", [
    ("", "{racine}/user_db/run/charts"),
    ("TMPDIR={racine}/tmp/\n", "{racine}/user_db/run/charts"),
    ("TMPDIR={racine}/tmp\nCHART_CACHE_DIR=/srv/graphiques\n", "/srv/graphiques"),
])
def test_cache_des_graphiques_partage(racine, env_fichier, attendu):
    """Le core écrit le cache des graphiques, l'hôte d'outils le relit : même dossier, jamais de PrivateTmp."""
    (racine / "tmp").mkdir()
    (racine / ".env").write_text(env_fichier.format(racine=racine), encoding="utf-8")
    r = _elpis(racine, "service", "print", node=_faux_node(racine))
    assert r.returncode == 0, r.stderr
    unites = _unites(r.stdout)
    for service in ("main", "admin", "toolhost"):
        assert f'Environment="CHART_CACHE_DIR={attendu.format(racine=racine)}"' in unites[f"elpis-{service}.service"].splitlines()
    assert not any("PrivateTmp" in corps for corps in unites.values())


@pytest.mark.skipif(shutil.which("systemd-analyze") is None, reason="systemd-analyze absent")
def test_unites_valides_pour_systemd(racine, tmp_path):
    r = _elpis(racine, "service", "print", node=_faux_node(racine))
    assert r.returncode == 0, r.stderr
    dossier = tmp_path / "unites"
    dossier.mkdir()
    for nom, corps in _unites(r.stdout).items():
        (dossier / nom).write_text(corps.rstrip() + "\n", encoding="utf-8")
    v = subprocess.run(["systemd-analyze", "verify", "--man=no", "--recursive-errors=no",
                        *sorted(str(p) for p in dossier.iterdir())], capture_output=True, text=True, timeout=120)
    assert v.returncode == 0, v.stderr


@pytest.mark.parametrize("commande", [("start",), ("service", "print"), ("restart",)])
def test_sans_bundle_rien_ne_demarre(racine, commande):
    (racine / "apps/core/dist/main.mjs").unlink()
    r = _elpis(racine, *commande, node=_faux_node(racine))
    assert r.returncode != 0 and "Core non construit" in r.stderr, r.stderr
    assert list((racine / "user_db/run").glob("*.pid")) == []


@pytest.mark.parametrize("version", ["20.19.0", "24.8.1", "25.0.0"])
def test_node_hors_24_9_refuse(racine, version):
    r = _elpis(racine, "start", node=_faux_node(racine, version))
    assert r.returncode != 0 and f"v{version}" in r.stderr and "Node 24.x" in r.stderr, r.stderr
    assert list((racine / "user_db/run").glob("*.pid")) == []


def test_stop_laisse_le_core_finir_au_dela_de_20_s(racine, tmp_path):
    """Main, détaché comme sous ./elpis start (orphelin, jamais zombie de pytest), a 300 s pour finir, pas 20 s."""
    fini = tmp_path / "fini"
    script = ("import signal, sys, time\n"
              "def fin(*_):\n"
              "    time.sleep(22)\n"
              f"    open({str(fini)!r}, 'w').write('ok')\n"
              "    sys.exit(0)\n"
              "signal.signal(signal.SIGTERM, fin)\n"
              "while True:\n"
              "    time.sleep(1)\n")
    lanceur = subprocess.run(["bash", "-c", 'setsid "$0" -c "$1" </dev/null >/dev/null 2>&1 & echo $!',
                              sys.executable, script], capture_output=True, text=True, check=True, timeout=30)
    pid = int(lanceur.stdout.strip())
    try:
        (racine / "user_db/run/main.pid").write_text(str(pid), encoding="utf-8")
        time.sleep(0.5)
        debut = time.monotonic()
        r = _elpis(racine, "stop", node=_faux_node(racine), timeout=120)
        assert r.returncode == 0, r.stderr
        assert fini.read_text() == "ok" and time.monotonic() - debut >= 22
        assert "Le core finit ses requêtes en cours" in r.stdout
        assert not (racine / "user_db/run/main.pid").exists()
    finally:
        try:
            os.killpg(pid, 9)
        except ProcessLookupError:
            pass


def _detache(script: str) -> int:
    lanceur = subprocess.run(["bash", "-c", 'setsid "$0" -c "$1" </dev/null >/dev/null 2>&1 & echo $!',
                              sys.executable, script], capture_output=True, text=True, check=True, timeout=30)
    return int(lanceur.stdout.strip())


def test_stop_arrete_les_outils_apres_la_fin_du_core(racine, tmp_path):
    traces = tmp_path / "traces"
    fin = ("import signal, sys, time\n"
           "def fin(*_):\n"
           "    time.sleep({delai})\n"
           f"    open({str(traces)!r}, 'a').write('{{nom}} %f\\n' % time.time())\n"
           "    sys.exit(0)\n"
           "signal.signal(signal.SIGTERM, fin)\n"
           "while True:\n"
           "    time.sleep(1)\n")
    pids = {nom: _detache(fin.format(delai=delai, nom=nom)) for nom, delai in
            (("main", 2), ("admin", 2), ("toolhost", 0), ("tools", 0))}
    try:
        for nom, pid in pids.items():
            (racine / f"user_db/run/{nom}.pid").write_text(str(pid), encoding="utf-8")
        time.sleep(0.5)
        r = _elpis(racine, "stop", node=_faux_node(racine), timeout=120)
        assert r.returncode == 0, r.stderr
        moments = dict(ligne.split() for ligne in traces.read_text().splitlines())
        assert set(moments) == {"main", "admin", "toolhost", "tools"}
        assert abs(float(moments["main"]) - float(moments["admin"])) < 1.5
        assert min(float(moments["toolhost"]), float(moments["tools"])) >= max(float(moments["main"]), float(moments["admin"]))
    finally:
        for pid in pids.values():
            try:
                os.killpg(pid, 9)
            except ProcessLookupError:
                pass


@pytest.mark.parametrize("reglage,libelle,valide", [
    ("SSL_CERT_FILE={racine}/absent.pem", "{racine}/absent.pem", False),
    ("SSL_CERT_DIR={racine}/ca-vide", "SSL_CERT_DIR={racine}/ca-vide", False),
    ("SSL_CERT_DIR={racine}/ca", "SSL_CERT_DIR={racine}/ca", True),
    ("SSL_CERT_DIR={racine}/ca-vide:{racine}/ca", "SSL_CERT_DIR={racine}/ca-vide:{racine}/ca", False),
])
def test_doctor_verifie_les_autorites_de_confiance(racine, reglage, libelle, valide):
    (racine / "ca-vide").mkdir()
    (racine / "ca").mkdir()
    (racine / "ca" / "f690af4c.0").write_text("-----BEGIN CERTIFICATE-----\n", encoding="utf-8")
    (racine / ".env").write_text(reglage.format(racine=racine) + "\n", encoding="utf-8")
    sortie = _elpis(racine, "doctor", node=_faux_node(racine), timeout=300)
    lignes = [ligne for ligne in (sortie.stdout + sortie.stderr).splitlines() if "autorités de confiance" in ligne]
    assert len(lignes) == 1 and f"autorités de confiance ({libelle.format(racine=racine)})" in lignes[0], lignes
    assert (" : NON" not in lignes[0]) is valide


@pytest.mark.parametrize("cas", ["livre", "autre", "ailleurs"])
def test_doctor_verifie_l_empreinte_du_runtime(racine, cas):
    if cas == "ailleurs":
        node = _faux_node(racine)
    else:
        (racine / "node/bin").mkdir(parents=True)
        node = _executable(racine / "node/bin/node", '#!/bin/sh\n[ "$1" = -v ] && { echo v24.21.0; exit 0; }\nexit 0\n')
    if cas == "livre":
        empreinte = subprocess.run(["bash", "-c", f'. "{racine}/deploy/node/runtime.sh"; runtime_empreinte "{racine}/node"'],
                                   capture_output=True, text=True, check=True).stdout.strip()
        env = racine / "deploy/node/node.env"
        env.write_text(re.sub(r"^(NODE_RUNTIME_SHA256_\w+)=.*$", rf"\g<1>={empreinte}",
                              env.read_text(encoding="utf-8"), flags=re.M), encoding="utf-8")
    r = _elpis(racine, "doctor", node=node, timeout=300)
    lignes = [ligne for ligne in (r.stdout + r.stderr).splitlines() if "runtime Node.js" in ligne]
    assert len(lignes) == 1, lignes
    if cas == "ailleurs":
        assert "empreinte non vérifiée" in lignes[0]
    else:
        assert "runtime Node.js livré (node/, sans npm, empreinte" in lignes[0]
        assert (" : NON" in lignes[0]) is (cas == "autre"), lignes[0]


def test_status_voit_le_navigateur_sur_le_node_du_core(racine, tmp_path):
    (racine / "browser-service/node_modules").mkdir(parents=True)
    (racine / "node/bin").mkdir(parents=True)
    _executable(racine / "node/bin/node", '#!/bin/sh\n[ "$1" = -v ] && echo v24.21.0\n')
    outils = tmp_path / "outils"
    outils.mkdir()
    for outil in ("bash", "dirname", "readlink", "cat", "uname"):
        (outils / outil).symlink_to(shutil.which(outil))
    r = subprocess.run([str(outils / "bash"), str(racine / "elpis"), "status"], capture_output=True, text=True,
                       timeout=60, cwd=str(racine), env={"PATH": str(outils), "HOME": str(racine), "LANG": "C.UTF-8"},
                       stdin=subprocess.DEVNULL)
    assert re.search(r"^  browser\s+-\s+3000\s+arrêté$", r.stdout, re.M), r.stdout + r.stderr


FAUX_CORE = """#!/bin/sh
[ "$1" = -v ] && { echo v24.21.0; exit 0; }
case " $* " in *" --familles-relayees "*) echo git; exit 0 ;; esac
case "${FAUX_CORE:-vivant}" in
    vivant) echo "core $APP_MODE en route"; exec sleep 60 ;;
    *) echo "erreur fatale au démarrage de $APP_MODE"; exit 1 ;;
esac
"""

FAUX_CURL = """#!/bin/sh
case " $* " in *" --noproxy "*) ;; *) [ -n "$http_proxy" ] && exit 5 ;; esac
for a; do url="$a"; done
case "$url" in
    *:8001/api/health) [ "${FAUX_SANTE_MAIN:-ok}" = ok ] ;;
    *:8002/api/health) [ "${FAUX_SANTE_ADMIN:-ok}" = ok ] ;;
    *) exit 7 ;;
esac
"""


@pytest.mark.parametrize("commande,core,main,admin,code,attendu", [
    ("start", "vivant", "ok", "ok", 0, "main et admin répondent (/api/health)."),
    ("start-proxy", "vivant", "ok", "ok", 0, "main et admin répondent (/api/health)."),
    ("restart", "vivant", "ok", "ok", 0, "main et admin répondent (/api/health)."),
    ("start", "vivant", "ok", "non", 1, "admin ne répond pas sur /api/health (port 8002) après 3 s."),
    ("restart", "plante", "non", "non", 1, "main s'est arrêté sans répondre sur /api/health (port 8001)."),
])
def test_start_attend_la_sante_de_main_et_admin(racine, tmp_path, commande, core, main, admin, code, attendu):
    bin_ = tmp_path / "faux-bin"
    bin_.mkdir()
    _executable(bin_ / "curl", FAUX_CURL)
    node = _executable(racine / "faux-core", FAUX_CORE)
    env = {"PATH": f"{bin_}:{os.environ.get('PATH', '/usr/bin:/bin')}", "HOME": str(racine), "LANG": "C.UTF-8",
           "ELPIS_NODE": str(node), "ELPIS_ATTENTE_SANTE": "3", "FAUX_CORE": core,
           "FAUX_SANTE_MAIN": main, "FAUX_SANTE_ADMIN": admin}
    if commande == "start-proxy":                            # proxy de l'environnement : jamais pour 127.0.0.1
        commande, env["http_proxy"] = "start", "http://127.0.0.2:9"
    debut = time.monotonic()
    try:
        r = subprocess.run(["bash", str(racine / "elpis"), commande], env=env, capture_output=True, text=True,
                           timeout=120, cwd=str(racine), stdin=subprocess.DEVNULL)
    finally:
        subprocess.run(["bash", str(racine / "elpis"), "stop"], env=env, capture_output=True, timeout=120,
                       cwd=str(racine), stdin=subprocess.DEVNULL)
    sortie = r.stdout + r.stderr
    assert r.returncode == code and attendu in sortie, sortie
    if code:
        trace = "erreur fatale au démarrage de main" if core == "plante" else "core admin en route"
        assert trace in sortie and "Fin de son journal" in sortie
    assert time.monotonic() - debut < 60


def _node_du_core() -> str | None:
    node = os.environ.get("ELPIS_NODE") or shutil.which("node") or "node"
    try:
        v = subprocess.run([node, "-v"], capture_output=True, text=True, timeout=30).stdout.strip()
    except OSError:
        return None
    m = re.fullmatch(r"v24\.(\d+)\.\d+", v)
    return node if m and int(m[1]) >= 9 else None


@pytest.mark.skipif(not (DIST / "exploitation.mjs").is_file() or _node_du_core() is None,
                    reason="bundle du core non construit (npm run build) ou Node 24.9+ absent")
def test_doctor_interroge_le_core(racine):
    shutil.rmtree(racine / "apps/core/dist")
    (racine / "apps/core/dist").symlink_to(DIST)
    r = _elpis(racine, "doctor", node=_node_du_core(), timeout=300)
    sortie = r.stdout + r.stderr
    assert re.search(r"Node\.js du core v24\.\d+\.\d+ \(", sortie), sortie
    assert re.search(r"module natif du core : better-sqlite3 \d+\.\d+\.\d+, SQLite", sortie), sortie
    assert "bundle du core : NON (construit pour d'autres sources" in sortie
    # « db info » (core) ouvre la base avant ce contrôle, comme le faisait la version Python : fichier vide, base neuve.
    # Bundle construit avant la commande db (dist plus ancien que les sources) : base non ouverte, donc absente.
    assert "base de données joignable" in sortie
    if "base de données joignable : NON" in sortie:
        assert "base vue par le core : base absente : créée au premier démarrage" in sortie
    else:
        assert "base vue par le core : base neuve : schéma créé au premier démarrage" in sortie


RELANCE = REPO / "deploy" / "node" / "relance.sh"
CODE_REDEMARRAGE = 75

FAUX_CORE_RELANCABLE = """#!/bin/bash
[ "$1" = -v ] && { echo v24.21.0; exit 0; }
case " $* " in *" --familles-relayees "*) echo git; exit 0 ;; esac
echo "demarrage $APP_MODE $$"
trap 'echo "HUP $APP_MODE"; exit 75' HUP
trap 'echo "TERM $APP_MODE"; exit 0' TERM
while :; do sleep 0.1; done
"""

FAUX_FILS = """#!/bin/bash
echo "demarrage $$" >> "$TRACE"
n=$(grep -c demarrage "$TRACE")
trap 'echo "HUP" >> "$TRACE"; exit 75' HUP
trap 'echo "TERM" >> "$TRACE"; exit ${SORTIE_TERM:-0}' TERM
[ -n "${PETIT_FILS:-}" ] && { sleep 60 >/dev/null 2>&1 & echo $! > "$PETIT_FILS"; }
codes=($CODES)
[ -n "${codes[$((n - 1))]:-}" ] && { sleep 0.2; exit "${codes[$((n - 1))]}"; }
while :; do sleep 0.1; done
"""


def _attendre(condition, delai: float = 30.0, pas: float = 0.1) -> None:
    fin = time.monotonic() + delai
    while not condition():
        assert time.monotonic() < fin, "délai dépassé"
        time.sleep(pas)


def _relance(tmp_path: Path, codes: str = "", **env) -> tuple[subprocess.Popen, Path]:
    """relance.sh sur un faux fils, détaché comme sous ./elpis start (groupe propre, signaux de groupe)."""
    trace = tmp_path / "trace"
    trace.write_text("", encoding="utf-8")
    fils = _executable(tmp_path / "faux-fils", FAUX_FILS)
    e = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "TRACE": str(trace), "CODES": codes,
         "ELPIS_PAUSE_RELANCE": "0.2", **env}
    return subprocess.Popen(["bash", str(RELANCE), str(fils)], env=e, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True), trace


def _evenements(trace: Path) -> list[str]:
    return [ligne.split()[0] for ligne in trace.read_text().splitlines()]


def _fin(w: subprocess.Popen) -> None:
    if w.poll() is None:
        try:
            os.killpg(w.pid, 9)
        except ProcessLookupError:
            pass
    w.communicate(timeout=30)


@pytest.mark.parametrize("codes,attendu,lancements", [
    ("75 75 0", 0, 3),                   # redémarrages demandés puis sortie propre
    ("75 7", 7, 2),                      # un autre code après un redémarrage : rendu tel quel
    ("1", 1, 1),                         # panne : pas de relance
    ("0", 0, 1),                         # sortie propre : pas de relance
])
def test_relance_seulement_sur_le_code_de_redemarrage(tmp_path, codes, attendu, lancements):
    w, trace = _relance(tmp_path, codes)
    try:
        sortie, _ = w.communicate(timeout=60)
        assert w.returncode == attendu, sortie
        assert _evenements(trace) == ["demarrage"] * lancements
        assert sortie.count("demande son redémarrage") == lancements - 1
        assert sortie.count("pas de relance") == 1
    finally:
        _fin(w)


def test_relance_sans_commande():
    r = subprocess.run(["bash", str(RELANCE)], capture_output=True, text=True, timeout=30)
    assert r.returncode == 2 and "usage" in r.stderr


@pytest.mark.parametrize("sortie_term,attendu", [(0, 0), (1, 1), (CODE_REDEMARRAGE, 0)])
def test_arret_demande_ne_relance_pas_et_n_arrive_qu_une_fois(tmp_path, sortie_term, attendu):
    """SIGTERM de groupe (comme ./elpis stop) : le fils le reçoit une fois ; même sortie 75, pas de relance."""
    w, trace = _relance(tmp_path, SORTIE_TERM=str(sortie_term))
    try:
        _attendre(lambda: _evenements(trace) == ["demarrage"])
        time.sleep(0.3)
        os.killpg(w.pid, 15)
        sortie, _ = w.communicate(timeout=30)
        assert w.returncode == attendu, sortie
        time.sleep(1.0)
        assert _evenements(trace) == ["demarrage", "TERM"]
    finally:
        _fin(w)


def test_redemarrage_demande_relance_puis_arret_demande_ne_relance_plus(tmp_path):
    w, trace = _relance(tmp_path)
    try:
        _attendre(lambda: _evenements(trace) == ["demarrage"])
        time.sleep(0.3)
        os.killpg(w.pid, 1)                                  # SIGHUP : le fils sort en 75
        _attendre(lambda: _evenements(trace) == ["demarrage", "HUP", "demarrage"])
        assert w.poll() is None
        time.sleep(0.3)
        os.killpg(w.pid, 15)
        w.communicate(timeout=30)
        assert w.returncode == 0
        time.sleep(1.0)
        assert _evenements(trace) == ["demarrage", "HUP", "demarrage", "TERM"]
    finally:
        _fin(w)


def test_hup_ne_vise_que_le_core_pas_ses_enfants(tmp_path):
    """Un SIGHUP manuel au lanceur arrive au core seul, comme le SIGHUP que le core s'envoie : ses enfants ne le reçoivent pas."""
    petit = tmp_path / "petit-fils"
    w, trace = _relance(tmp_path, PETIT_FILS=str(petit))
    try:
        _attendre(lambda: petit.exists() and petit.read_text().strip() != "")
        pid_petit = int(petit.read_text())
        os.kill(w.pid, 1)
        _attendre(lambda: _evenements(trace) == ["demarrage", "HUP", "demarrage"])
        os.kill(pid_petit, 0)                                # toujours vivant
        os.kill(w.pid, 15)
        w.communicate(timeout=30)
        assert w.returncode == 0
    finally:
        _fin(w)
        try:
            os.kill(int(petit.read_text()), 9)
        except (OSError, ValueError):
            pass


@pytest.mark.skipif(shutil.which("setpriv") is None, reason="setpriv (util-linux) absent")
def test_lanceur_tue_de_force_le_core_recoit_sigterm(tmp_path):
    """Le lanceur meurt par SIGKILL (OOM…) : le core est arrêté proprement au lieu de rester orphelin."""
    w, trace = _relance(tmp_path)
    try:
        _attendre(lambda: _evenements(trace) == ["demarrage"])
        time.sleep(0.3)
        os.kill(w.pid, 9)
        _attendre(lambda: _evenements(trace) == ["demarrage", "TERM"])
        time.sleep(0.5)
        assert _evenements(trace) == ["demarrage", "TERM"]
    finally:
        _fin(w)


def test_arret_pendant_la_pause_de_relance(tmp_path):
    w, trace = _relance(tmp_path, "75", ELPIS_PAUSE_RELANCE="30")
    try:
        _attendre(lambda: (tmp_path / "trace").read_text().count("demarrage") == 1)
        time.sleep(1.0)                                      # le fils est sorti en 75, le lanceur attend
        debut = time.monotonic()
        os.kill(w.pid, 15)                                   # le lanceur seul : son sleep doit être interrompu
        w.communicate(timeout=30)
        assert w.returncode == 0 and time.monotonic() - debut < 10
        assert _evenements(trace) == ["demarrage"]
    finally:
        _fin(w)


def test_start_sans_relance_sh_refuse(racine):
    (racine / "deploy/node/relance.sh").unlink()
    r = _elpis(racine, "start", node=_faux_node(racine))
    assert r.returncode != 0 and "relance.sh absent" in r.stderr, r.stderr
    assert list((racine / "user_db/run").glob("*.pid")) == []


def _lancer_elpis(racine: Path, tmp_path: Path, commande: str, **extra) -> subprocess.CompletedProcess:
    bin_ = tmp_path / "faux-bin"
    bin_.mkdir(exist_ok=True)
    _executable(bin_ / "curl", FAUX_CURL)
    node = _executable(racine / "faux-core", FAUX_CORE_RELANCABLE)
    env = {"PATH": f"{bin_}:{os.environ.get('PATH', '/usr/bin:/bin')}", "HOME": str(racine), "LANG": "C.UTF-8",
           "ELPIS_NODE": str(node), "ELPIS_ATTENTE_SANTE": "20", "ELPIS_PAUSE_RELANCE": "0.2", **extra}
    return subprocess.run(["bash", str(racine / "elpis"), commande], env=env, capture_output=True, text=True,
                          timeout=120, cwd=str(racine), stdin=subprocess.DEVNULL)


def test_start_relance_main_apres_un_redemarrage_et_stop_ne_relance_plus(racine, tmp_path):
    """Hors systemd : un redémarrage demandé (SIGHUP, sortie 75) relance main seul ; ./elpis stop arrête tout pour de bon."""
    journal = {nom: racine / "logs" / f"{nom}.log" for nom in ("main", "admin")}
    def lancements(nom: str) -> int:
        return journal[nom].read_text().count(f"demarrage {nom} ") if journal[nom].exists() else 0
    try:
        r = _lancer_elpis(racine, tmp_path, "start")
        assert r.returncode == 0, r.stdout + r.stderr
        pid_main = int((racine / "user_db/run/main.pid").read_text())
        pid_admin = int((racine / "user_db/run/admin.pid").read_text())
        assert (lancements("main"), lancements("admin")) == (1, 1)
        os.kill(pid_main, 1)                                 # ce que fait le core pour « Redémarrer »
        _attendre(lambda: lancements("main") == 2)
        assert "HUP main" in journal["main"].read_text()
        assert (racine / "user_db/run/main.pid").read_text().strip() == str(pid_main)
        os.kill(pid_main, 0)
        assert lancements("admin") == 1
        r = _lancer_elpis(racine, tmp_path, "stop")
        assert r.returncode == 0, r.stderr
        for pid in (pid_main, pid_admin):
            with pytest.raises(ProcessLookupError):
                os.kill(pid, 0)
        time.sleep(1.5)
        assert (lancements("main"), lancements("admin")) == (2, 1)
        assert "TERM main" in journal["main"].read_text() and "TERM admin" in journal["admin"].read_text()
        assert not list((racine / "user_db/run").glob("*.pid"))
    finally:
        _lancer_elpis(racine, tmp_path, "stop")
