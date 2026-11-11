# SPDX-License-Identifier: MIT
"""tests/deploy/test_installation_hors_ligne_core.py — runtime Node.js sans npm, bundles du core et de l'hôte d'outils installés sans réseau : sommes et empreinte figées, idempotence, refus, récapitulatif."""
from __future__ import annotations

import hashlib
import io
import os
import platform
import re
import shutil
import subprocess
import tarfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
ARCH = platform.machine()
CIBLE = {"x86_64": "linux-x64", "aarch64": "linux-arm64"}.get(ARCH, "")
pytestmark = pytest.mark.skipif(not CIBLE, reason=f"architecture {ARCH} sans archive Node.js")


LICENCE_OFFICIELLE = '''Node.js is licensed for use as follows:

"""
Copyright Node.js contributors. All rights reserved.
"""

The externally maintained libraries used by Node.js are:

- Acorn, located at deps/acorn, is licensed as follows:
  """
    MIT License
  """

- corepack, located at deps/corepack, is licensed as follows:
  """
    Corepack, MIT
  """

- minimatch, located at deps/minimatch, is licensed as follows:
  """
    The Blue Oak Model License
  """

- npm, located at deps/npm, is licensed as follows:
  """
    The Artistic License 2.0
  """

- HdrHistogram, located at deps/histogram, is licensed as follows:
  """
    The code was released to the public domain, as explained at
    http://creativecommons.org/publicdomain/zero/1.0/

    For users who wish to consume it under the "BSD" license rather than CC0.

    -----------------------------------------------------------------------------
    ** Beginning of "BSD 2-Clause License" text. **

     Copyright (c) 2012 Gil Tene
     BSD 2-Clause terms.
  """

- zlib, located at deps/zlib, is licensed as follows:
  """
    zlib License
  """
'''

LICENCE_EPUREE = '''Node.js is licensed for use as follows:

"""
Copyright Node.js contributors. All rights reserved.
"""

The externally maintained libraries used by Node.js are:

- Acorn, located at deps/acorn, is licensed as follows:
  """
    MIT License
  """

- minimatch, located at deps/minimatch, is licensed as follows:
  """
    The Blue Oak Model License
  """

- HdrHistogram, located at deps/histogram, is used under its BSD 2-Clause License option:
  """
     Copyright (c) 2012 Gil Tene
     BSD 2-Clause terms.
  """

- zlib, located at deps/zlib, is licensed as follows:
  """
    zlib License
  """
'''


def _runtime_sh(script: str) -> str:
    r = subprocess.run(["bash", "-c", f'. "{REPO}/deploy/node/runtime.sh"; {script}'], capture_output=True,
                       text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    return r.stdout


def _arbre_officiel(racine: Path, version: str) -> Path:
    a = racine / f"node-v{version}-{CIBLE}"
    for d in ("bin", "include/node", "lib/node_modules/npm/bin", "lib/node_modules/corepack/dist"):
        (a / d).mkdir(parents=True)
    (a / "bin/node").write_text(f'#!/bin/sh\n[ "$1" = -v ] && echo v{version}\n', encoding="utf-8")
    (a / "lib/node_modules/npm/bin/npm-cli.js").write_text('#!/bin/sh\necho "npm $*"\n', encoding="utf-8")
    (a / "lib/node_modules/npm/bin/npx-cli.js").write_text('#!/bin/sh\necho "npx $*"\n', encoding="utf-8")
    (a / "lib/node_modules/corepack/dist/corepack.js").write_text("// corepack\n", encoding="utf-8")
    for f in ("bin/node", "lib/node_modules/npm/bin/npm-cli.js", "lib/node_modules/npm/bin/npx-cli.js"):
        (a / f).chmod(0o755)
    (a / "bin/npm").symlink_to("../lib/node_modules/npm/bin/npm-cli.js")
    (a / "bin/npx").symlink_to("../lib/node_modules/npm/bin/npx-cli.js")
    (a / "bin/corepack").symlink_to("../lib/node_modules/corepack/dist/corepack.js")
    (a / "include/node/node.h").write_text("/* en-tête */\n", encoding="utf-8")
    (a / "LICENSE").write_text(LICENCE_OFFICIELLE, encoding="utf-8")
    return a


def _tar(arbre: Path, sortie: Path) -> str:
    sortie.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(sortie, "w:gz") as tar:
        tar.add(arbre, arcname=arbre.name)
    return hashlib.sha256(sortie.read_bytes()).hexdigest()


def _version(tmp_path: Path, version: str) -> dict[str, str]:
    officiel = _arbre_officiel(tmp_path / f"officiel-{version}", version)
    asset = f"{officiel.name}.tar.gz"
    somme = _tar(officiel, tmp_path / "telechargements" / asset)
    epure = tmp_path / f"epure-{version}" / officiel.name
    shutil.copytree(officiel, epure, symlinks=True)
    _runtime_sh(f'runtime_epurer "{epure}"')
    return {"version": version, "asset": asset, "somme": somme, "epure": str(epure),
            "empreinte": _runtime_sh(f'runtime_empreinte "{epure}"').strip()}


def _paquet_node(paquet: Path, v: dict[str, str]) -> Path:
    archive = paquet / "node" / v["asset"].replace(".tar.gz", "-sans-npm.tar.gz")
    _tar(Path(v["epure"]), archive)
    return archive


@pytest.fixture
def depot(tmp_path):
    r = tmp_path / "elpis"
    (r / "deploy/node").mkdir(parents=True)
    for f in ("installer.sh", "node.env", "runtime.sh"):
        shutil.copy2(REPO / "deploy/node" / f, r / "deploy/node" / f)
    return r


def _node_env(depot: Path, v: dict[str, str], **autres: str) -> None:
    valeurs = {"NODE_VERSION": v["version"], "NODE_MIN": "24.9.0", f"NODE_ASSET_{ARCH}": v["asset"],
               f"NODE_SHA256_{ARCH}": v["somme"], f"NODE_RUNTIME_SHA256_{ARCH}": v["empreinte"], **autres}
    (depot / "deploy/node/node.env").write_text("".join(f"{k}={val}\n" for k, val in valeurs.items()),
                                                encoding="utf-8")


def _installer(depot: Path, *args: str, **env: str) -> subprocess.CompletedProcess:
    environ = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(depot), **env}
    return subprocess.run(["bash", str(depot / "deploy/node/installer.sh"), *args], env=environ,
                          capture_output=True, text=True, timeout=120)


def _faux_curl(tmp_path: Path) -> str:
    b = tmp_path / "faux-bin"
    b.mkdir(exist_ok=True)
    (b / "curl").write_text(f'#!/bin/sh\necho "$*" >> "{tmp_path}/telechargements.log"\n'
                            f'while [ "$1" != -o ]; do shift; done\n'
                            f'cp "{tmp_path}/telechargements/$(basename "$3")" "$2"\n', encoding="utf-8")
    (b / "curl").chmod(0o755)
    return f"{b}:{os.environ.get('PATH', '/usr/bin:/bin')}"


def _restes(depot: Path) -> list[str]:
    return sorted(p.name for p in depot.iterdir() if p.name.startswith(".node-") or ".construction-" in p.name)


def test_licence_du_runtime_sans_npm_ni_corepack():
    assert _runtime_sh(f"runtime_licence <<'FIN'\n{LICENCE_OFFICIELLE}FIN\n") == LICENCE_EPUREE
    livree = (REPO / "THIRD_PARTY_LICENSES/node-runtime.txt").read_text(encoding="utf-8")
    assert _runtime_sh(f"runtime_licence < '{REPO / 'THIRD_PARTY_LICENSES/node-runtime.txt'}'") == livree
    texte = livree.split("\n\n", 1)[1]
    assert not re.search(r"artistic|creativecommons|\bcc0\b|cc-by|deps/npm|deps/corepack", texte, re.I)
    for section in ("- ICU, located at deps/icu-small,", "- minimatch, located at deps/minimatch,",
                    "- HdrHistogram, located at deps/histogram, is used under its BSD 2-Clause License option:"):
        assert section in texte


def test_runtime_epure_et_empreinte(tmp_path):
    a = _arbre_officiel(tmp_path, "24.21.0")
    _runtime_sh(f'runtime_epurer "{a}"')
    assert sorted(str(p.relative_to(a)) for p in a.rglob("*")) == [
        "LICENSE", "bin", "bin/node", "include", "include/node", "include/node/node.h"]
    assert (a / "LICENSE").read_text(encoding="utf-8") == LICENCE_EPUREE
    empreinte = _runtime_sh(f'runtime_empreinte "{a}"').strip()
    assert re.fullmatch(r"[0-9a-f]{64}", empreinte)
    copie = tmp_path / "copie"
    shutil.copytree(a, copie, symlinks=True)
    (copie / "LICENSE").chmod(0o600)
    assert _runtime_sh(f'runtime_empreinte "{copie}"').strip() == empreinte
    (copie / "include/node/node.h").chmod(0o755)
    assert _runtime_sh(f'runtime_empreinte "{copie}"').strip() != empreinte
    (copie / "include/node/node.h").chmod(0o644)
    (copie / "bin/npm").symlink_to("node")
    assert _runtime_sh(f'runtime_empreinte "{copie}"').strip() != empreinte


def test_node_installe_depuis_le_paquet_puis_rien_a_refaire(depot, tmp_path):
    v = _version(tmp_path, "24.21.0")
    paquet = tmp_path / "paquet"
    _paquet_node(paquet, v)
    _node_env(depot, v)
    r = _installer(depot, "node", "--offline", str(paquet))
    assert r.returncode == 0, r.stderr
    assert subprocess.run([depot / "node/bin/node", "-v"], capture_output=True, text=True).stdout == "v24.21.0\n"
    assert "sans npm, empreinte vérifiée" in r.stdout and _restes(depot) == []
    assert not (depot / "node/bin/npm").exists() and not (depot / "node/lib").exists()
    assert (depot / "node").stat().st_mode & 0o777 == 0o755
    r = _installer(depot, "node", "--offline", str(paquet))
    assert r.returncode == 0 and "déjà en place" in r.stdout


def test_node_en_ligne_epure_l_archive_officielle(depot, tmp_path):
    v = _version(tmp_path, "24.21.0")
    _node_env(depot, v)
    r = _installer(depot, "node", PATH=_faux_curl(tmp_path))
    assert r.returncode == 0, r.stderr
    assert sorted(p.name for p in (depot / "node").iterdir()) == ["LICENSE", "bin", "include"]
    assert sorted(p.name for p in (depot / "node/bin").iterdir()) == ["node"]
    assert (depot / "node/LICENSE").read_text(encoding="utf-8") == LICENCE_EPUREE and _restes(depot) == []


def test_node_remplace_un_runtime_avec_npm(depot, tmp_path):
    ancien = _arbre_officiel(tmp_path / "ancien", "24.9.0")
    shutil.copytree(ancien, depot / "node", symlinks=True)
    v = _version(tmp_path, "24.21.0")
    paquet = tmp_path / "paquet"
    _paquet_node(paquet, v)
    _node_env(depot, v)
    r = _installer(depot, "node", "--offline", str(paquet))
    assert r.returncode == 0, r.stderr
    assert subprocess.run([depot / "node/bin/node", "-v"], capture_output=True, text=True).stdout == "v24.21.0\n"
    assert not (depot / "node/bin/npm").exists() and _restes(depot) == []


def test_node_refuse_un_runtime_ou_une_archive_alteres_sans_rien_toucher(depot, tmp_path):
    v = _version(tmp_path, "24.21.0")
    paquet = tmp_path / "paquet"
    archive = _paquet_node(paquet, v)
    _node_env(depot, v, **{f"NODE_RUNTIME_SHA256_{ARCH}": "0" * 64})
    r = _installer(depot, "node", "--offline", str(paquet))
    assert r.returncode == 1 and "empreinte diffère" in r.stderr
    assert not (depot / "node").exists() and _restes(depot) == []
    _node_env(depot, v, **{f"NODE_SHA256_{ARCH}": "0" * 64})
    r = _installer(depot, "node", PATH=_faux_curl(tmp_path))
    assert r.returncode == 1 and "SHA-256" in r.stderr and "refusée" in r.stderr
    assert not (depot / "node").exists() and _restes(depot) == []
    _node_env(depot, v)
    archive.unlink()
    r = _installer(depot, "node", "--offline", str(paquet))
    assert r.returncode == 1 and "absent" in r.stderr and _restes(depot) == []


def test_une_seule_archive_telechargee_par_installation(depot, tmp_path):
    v = _version(tmp_path, "24.21.0")
    _node_env(depot, v)
    cache = depot / ".node-cache.essai"
    cache.mkdir()
    env = {"PATH": _faux_curl(tmp_path), "ELPIS_NODE_CACHE": str(cache)}
    assert _installer(depot, "node", **env).returncode == 0
    for dossier in (".node-npm.core", ".node-npm.navigateur"):
        r = _installer(depot, "npm", str(depot / dossier), **env)
        assert r.returncode == 0 and (depot / dossier / "bin/npm").exists(), r.stderr
    assert len((tmp_path / "telechargements.log").read_text().splitlines()) == 1
    (cache / v["asset"]).write_bytes(b"abime")                 # copie altérée : retéléchargée, jamais utilisée
    assert _installer(depot, "npm", str(depot / ".node-npm.3"), **env).returncode == 0
    assert len((tmp_path / "telechargements.log").read_text().splitlines()) == 2


def test_npm_temporaire_tire_de_l_archive_officielle(depot, tmp_path):
    v = _version(tmp_path, "24.21.0")
    _node_env(depot, v)
    cible = depot / ".node-npm.essai"
    r = _installer(depot, "npm", str(cible), PATH=_faux_curl(tmp_path))
    assert r.returncode == 0, r.stderr
    assert sorted(p.name for p in (cible / "bin").iterdir()) == ["npm", "npx"]
    assert subprocess.run([cible / "bin/npm", "ci"], capture_output=True, text=True).stdout == "npm ci\n"
    assert not list(cible.glob(".archive.*")) and not (cible / "lib/node_modules/corepack").exists()


FAUX_NODE = """#!/bin/sh
case "$1" in
    -v) echo v24.21.0 ;;
    *) case "$2" in
           empreinte|--empreinte) [ "${FAUX_EMPREINTE:-ok}" = ok ] && echo "à jour des sources (abc)" || { echo "construit pour d'autres sources (abc ≠ def)"; exit 1; } ;;
           natif|--natif) case "${FAUX_NATIF:-ok}" in
                      ok) echo "better-sqlite3 13.0.3, SQLite 3.53.4 (faux)" ;;
                      message) echo "module natif inutilisable pour linux-x64"; exit 1 ;;
                      *) kill -BUS $$ ;;
                  esac ;;
       esac ;;
esac
"""


def _paquet_core(paquet: Path, empreinte: str) -> None:
    core = paquet / "core"
    for d in ("node_modules/better-sqlite3", "webp/dec", "webp/enc"):
        (core / d).mkdir(parents=True)
    for nom in ("main.mjs", "exploitation.mjs", "pixels.mjs", "webp/dec/webp_dec.wasm", "webp/enc/webp_enc.wasm"):
        (core / nom).write_text(f"// {empreinte}\n", encoding="utf-8")
    (core / "construction.json").write_text(f'{{"empreinte": "{empreinte}"}}\n', encoding="utf-8")


def test_core_installe_depuis_le_paquet_verifie_et_idempotent(depot, tmp_path):
    node = depot / "faux-node"
    node.write_text(FAUX_NODE, encoding="utf-8")
    node.chmod(0o755)
    paquet = tmp_path / "paquet"
    _paquet_core(paquet, "aaa")
    r = _installer(depot, "core", "--offline", str(paquet), ELPIS_NODE=str(node))
    assert r.returncode == 0, r.stderr
    dist = depot / "apps/core/dist"
    assert (dist / "construction.json").read_text() == '{"empreinte": "aaa"}\n'
    assert "installé depuis le paquet hors ligne (apps/core/dist) : better-sqlite3 13.0.3" in r.stdout
    r = _installer(depot, "core", "--offline", str(paquet), ELPIS_NODE=str(node))
    assert r.returncode == 0 and "déjà en place" in r.stdout
    assert sorted(p.name for p in (depot / "apps/core").iterdir()) == ["dist"]


def test_core_d_une_autre_version_refuse_et_ancien_garde(depot, tmp_path):
    node = depot / "faux-node"
    node.write_text(FAUX_NODE, encoding="utf-8")
    node.chmod(0o755)
    premier, second = tmp_path / "premier", tmp_path / "second"
    _paquet_core(premier, "aaa")
    _paquet_core(second, "bbb")
    assert _installer(depot, "core", "--offline", str(premier), ELPIS_NODE=str(node)).returncode == 0
    r = _installer(depot, "core", "--offline", str(second), ELPIS_NODE=str(node), FAUX_EMPREINTE="non")
    assert r.returncode == 1 and "autre version que ce dépôt" in r.stderr
    assert (depot / "apps/core/dist/construction.json").read_text() == '{"empreinte": "aaa"}\n'
    assert sorted(p.name for p in (depot / "apps/core").iterdir()) == ["dist"]


@pytest.mark.parametrize("panne,motif", [("message", "module natif inutilisable pour linux-x64"),
                                         ("signal", "contrôle interrompu (code 135)")])
def test_core_au_module_natif_inutilisable_refuse_avec_son_motif(depot, tmp_path, panne, motif):
    node = depot / "faux-node"
    node.write_text(FAUX_NODE, encoding="utf-8")
    node.chmod(0o755)
    paquet = tmp_path / "paquet"
    _paquet_core(paquet, "aaa")
    r = _installer(depot, "core", "--offline", str(paquet), ELPIS_NODE=str(node), FAUX_NATIF=panne)
    assert r.returncode == 1 and f"refusé (module natif : {motif})" in r.stderr, r.stderr
    assert not (depot / "apps/core/dist").exists()
    assert sorted(p.name for p in (depot / "apps/core").iterdir()) == []


@pytest.mark.parametrize("manquant", ["pixels.mjs", "webp/dec/webp_dec.wasm"])
def test_core_sans_thread_des_images_refuse(depot, tmp_path, manquant):
    node = depot / "faux-node"
    node.write_text(FAUX_NODE, encoding="utf-8")
    node.chmod(0o755)
    paquet = tmp_path / "paquet"
    _paquet_core(paquet, "aaa")
    (paquet / "core" / manquant).unlink()
    r = _installer(depot, "core", "--offline", str(paquet), ELPIS_NODE=str(node))
    assert r.returncode == 1 and "refusé (thread des images ou codecs WebP absents" in r.stderr, r.stderr
    assert not (depot / "apps/core/dist").exists()


def test_core_abime_repare_par_une_relance(depot, tmp_path):
    node = depot / "faux-node"
    node.write_text(FAUX_NODE, encoding="utf-8")
    node.chmod(0o755)
    paquet = tmp_path / "paquet"
    _paquet_core(paquet, "aaa")
    assert _installer(depot, "core", "--offline", str(paquet), ELPIS_NODE=str(node)).returncode == 0
    (depot / "apps/core/dist/exploitation.mjs").unlink()
    r = _installer(depot, "core", "--offline", str(paquet), ELPIS_NODE=str(node))
    assert r.returncode == 0 and "installé depuis le paquet" in r.stdout, r.stderr
    assert (depot / "apps/core/dist/exploitation.mjs").is_file()


def _paquet_hote(paquet: Path, empreinte: str) -> None:
    hote = paquet / "toolhost"
    (hote / "node_modules/node-pty/build/Release").mkdir(parents=True)
    (hote / "main.mjs").write_text(f"// {empreinte}\n", encoding="utf-8")
    (hote / "construction.json").write_text(f'{{"empreinte": "{empreinte}"}}\n', encoding="utf-8")


def _faux_node(depot: Path) -> Path:
    node = depot / "faux-node"
    node.write_text(FAUX_NODE, encoding="utf-8")
    node.chmod(0o755)
    return node


def test_hote_installe_depuis_le_paquet_verifie_et_idempotent(depot, tmp_path):
    node = _faux_node(depot)
    paquet = tmp_path / "paquet"
    _paquet_hote(paquet, "aaa")
    r = _installer(depot, "hote", "--offline", str(paquet), ELPIS_NODE=str(node))
    assert r.returncode == 0, r.stderr
    assert (depot / "apps/toolhost/dist/construction.json").read_text() == '{"empreinte": "aaa"}\n'
    assert "Hôte d'outils installé depuis le paquet hors ligne (apps/toolhost/dist) : better-sqlite3" in r.stdout
    r = _installer(depot, "hote", "--offline", str(paquet), ELPIS_NODE=str(node))
    assert r.returncode == 0 and "déjà en place" in r.stdout
    assert sorted(p.name for p in (depot / "apps/toolhost").iterdir()) == ["dist"]


@pytest.mark.parametrize("panne,motif", [("message", "module natif inutilisable pour linux-x64"),
                                         ("signal", "contrôle interrompu (code 135)")])
def test_hote_aux_modules_natifs_inutilisables_refuse_et_ancien_garde(depot, tmp_path, panne, motif):
    node = _faux_node(depot)
    premier, second = tmp_path / "premier", tmp_path / "second"
    _paquet_hote(premier, "aaa")
    _paquet_hote(second, "bbb")
    assert _installer(depot, "hote", "--offline", str(premier), ELPIS_NODE=str(node)).returncode == 0
    r = _installer(depot, "hote", "--offline", str(second), ELPIS_NODE=str(node), FAUX_NATIF=panne)
    assert r.returncode == 1 and f"(Hôte d'outils) refusé (modules natifs : {motif})" in r.stderr, r.stderr
    assert (depot / "apps/toolhost/dist/construction.json").read_text() == '{"empreinte": "aaa"}\n'
    assert sorted(p.name for p in (depot / "apps/toolhost").iterdir()) == ["dist"]


def test_bundles_installe_le_core_puis_l_hote(depot, tmp_path):
    node = _faux_node(depot)
    paquet = tmp_path / "paquet"
    _paquet_core(paquet, "aaa")
    _paquet_hote(paquet, "bbb")
    r = _installer(depot, "bundles", "--offline", str(paquet), ELPIS_NODE=str(node))
    assert r.returncode == 0, r.stderr
    assert r.stdout.index("Core installé") < r.stdout.index("Hôte d'outils installé")
    assert (depot / "apps/toolhost/dist/main.mjs").is_file() and (depot / "apps/core/dist/main.mjs").is_file()


def test_paquet_sans_hote(depot, tmp_path):
    (tmp_path / "paquet").mkdir()
    r = _installer(depot, "hote", "--offline", str(tmp_path / "paquet"), ELPIS_NODE="/bin/false")
    assert r.returncode == 1 and "antérieur à l'hôte d'outils Node" in r.stderr


def test_paquet_sans_core(depot, tmp_path):
    (tmp_path / "paquet").mkdir()
    r = _installer(depot, "core", "--offline", str(tmp_path / "paquet"), ELPIS_NODE="/bin/false")
    assert r.returncode == 1 and "antérieur au core Node" in r.stderr


@pytest.mark.parametrize("hors_ligne", [False, True])
def test_recapitulatif_d_install(tmp_path, hors_ligne):
    args = ["--offline", str(tmp_path)] if hors_ligne else []
    r = subprocess.run(["bash", str(REPO / "install.sh"), "--dry-run", "--yes", *args], capture_output=True,
                       text=True, timeout=60, cwd=str(REPO), stdin=subprocess.DEVNULL)
    assert r.returncode == 0 or "l'installation réelle s'arrêterait" in r.stderr, r.stderr   # sudo, paquets apt de cet hôte
    version = re.search(r"^NODE_VERSION=(\S+)$", (REPO / "deploy/node/node.env").read_text(), re.M)[1]
    attendu = "bundle du paquet hors ligne" if hors_ligne else "npm ci, npm run build"
    assert re.search(rf"core \(Node\.js\)\s+: Node {re.escape(version)} dans node/ \+ {attendu}", r.stdout), r.stdout
    hote = "bundle du paquet hors ligne" if hors_ligne else "construit sur place \\(node-pty compilé\\)"
    assert re.search(rf"hôte d'outils\s+: {hote}", r.stdout), r.stdout


@pytest.mark.parametrize("script,attendus", [
    ("install.sh", ["--offline DIR", "ELPIS_CFG_ADMIN_PASSWORD,", "ELPIS_CFG_DB_PASSWORD,", "Node.js 24 dans node/"]),
    ("make_release.sh", ["Usage :", "[--no-sandbox] [--no-browser]", "core/       bundle du core",
                         "toolhost/   bundle de l'hôte d'outils"]),
])
def test_aide_complete(script, attendus):
    r = subprocess.run(["bash", str(REPO / script), "--help"], capture_output=True, text=True, timeout=60,
                       cwd=str(REPO), stdin=subprocess.DEVNULL)
    assert r.returncode == 0 and all(a in r.stdout for a in attendus), r.stdout


def test_node_env_fige_des_sommes_valides():
    vals = dict(l.split("=", 1) for l in (REPO / "deploy/node/node.env").read_text().splitlines()
                if "=" in l and not l.startswith("#"))
    assert re.fullmatch(r"24\.\d+\.\d+", vals["NODE_VERSION"]) and re.fullmatch(r"24\.\d+\.\d+", vals["NODE_MIN"])
    for arch, cible in (("x86_64", "linux-x64"), ("aarch64", "linux-arm64")):
        assert vals[f"NODE_ASSET_{arch}"] == f"node-v{vals['NODE_VERSION']}-{cible}.tar.gz"
        assert re.fullmatch(r"[0-9a-f]{64}", vals[f"NODE_SHA256_{arch}"])
        assert re.fullmatch(r"[0-9a-f]{64}", vals[f"NODE_RUNTIME_SHA256_{arch}"])
    assert subprocess.run(["git", "check-ignore", "-q", "node/bin/node"], cwd=str(REPO)).returncode == 0
    assert subprocess.run(["git", "check-ignore", "-q", "deploy/node/node.env"], cwd=str(REPO)).returncode == 1
