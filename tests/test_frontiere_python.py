# SPDX-License-Identifier: MIT
"""tests/test_frontiere_python.py — frontière du Python restant (moteur Office, RAG, configuration, agents) : aucun import vers un module disparu (core, elpis-tools, llm_core), et les points d'entrée gardés démarrent vraiment."""
from __future__ import annotations

import ast
import importlib.util
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

RACINE = Path(__file__).resolve().parents[1]
PAQUETS = ("chatbot_app", "llm_core", "server", "shared_infra", "toolhost", "elpis_office")
RACINES = sorted(str(p.relative_to(RACINE)) for d in ("office/elpis_office", "rag_app", "deploy")
                 for p in (RACINE / d).rglob("*.py")) + ["desktop-agent/server.py", "sandbox-agent/server.py"]
DISPARUS = (RACINE / "tests/frontiere_python_disparus.txt").read_text(encoding="utf-8").split()
MODULE_POINTE = re.compile(r"^(?:%s)(?:\.\w+)+(?<!\.json)(?<!\.db)$" % "|".join(PAQUETS))
SCRIPTS = ["elpis", "install.sh", "make_release.sh"] + sorted(
    str(p.relative_to(RACINE)) for p in (RACINE / "deploy").rglob("*.sh"))


def _fichier(module: str) -> Path | None:
    base = (RACINE / "office" if module.split(".")[0] == "elpis_office" else RACINE).joinpath(*module.split("."))
    for p in (base / "__init__.py", base.with_suffix(".py")):
        if p.is_file():
            return p
    return base if base.is_dir() else None


def _reexport_dynamique(arbre: ast.Module) -> bool:
    """Paquet qui réexporte ses sous-modules à l'exécution (`_SUBMODULES` + globals(), `import *`, `__getattr__`)."""
    for n in ast.walk(arbre):
        if isinstance(n, ast.ImportFrom) and any(a.name == "*" for a in n.names):
            return True
        if isinstance(n, ast.FunctionDef) and n.name == "__getattr__":
            return True
        if isinstance(n, ast.Name) and n.id in ("_SUBMODULES", "globals"):
            return True
    return False


def _nom_fourni(cible: Path, nom: str) -> bool:
    arbre = ast.parse(cible.read_text(encoding="utf-8"))
    if nom in _noms_definis(arbre):
        return True
    if not _reexport_dynamique(arbre):
        return False
    sources = {f for _, m, n in _imports(cible) for f in (_fichier(m), _fichier(f"{m}.{n}") if n else None)
               if f is not None and f.is_file() and f != cible}
    return any(nom in _noms_definis(ast.parse(f.read_text(encoding="utf-8"))) for f in sources)


def _noms_definis(arbre: ast.Module) -> set[str]:
    noms: set[str] = set()
    for n in arbre.body:
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            noms.add(n.name)
        elif isinstance(n, (ast.Assign, ast.AnnAssign)):
            cibles = n.targets if isinstance(n, ast.Assign) else [n.target]
            noms |= {c.id for t in cibles for c in (t.elts if isinstance(t, ast.Tuple) else [t]) if isinstance(c, ast.Name)}
        elif isinstance(n, (ast.Import, ast.ImportFrom)):
            noms |= {(a.asname or a.name).split(".")[0] for a in n.names}
        elif isinstance(n, (ast.If, ast.Try)):
            noms |= _noms_definis(ast.Module(body=getattr(n, "body", []) + getattr(n, "orelse", []), type_ignores=[]))
    return noms


def _module_de(chemin: Path) -> str:
    parties = list(chemin.relative_to(RACINE).with_suffix("").parts)
    if parties[0] == "office":
        parties = parties[1:]
    return ".".join(parties[:-1] if parties[-1] == "__init__" else parties)


def _imports(chemin: Path) -> list[tuple[int, str, str | None]]:
    """(ligne, module, nom importé ou None) des imports du dépôt, relatifs résolus, chaînes de modules des registres comprises."""
    arbre = ast.parse(chemin.read_text(encoding="utf-8"))
    mod = _module_de(chemin)
    paquet = mod if chemin.name == "__init__.py" else mod.rpartition(".")[0]
    out: list[tuple[int, str, str | None]] = []
    for n in ast.walk(arbre):
        if isinstance(n, ast.Import):
            out += [(n.lineno, a.name, None) for a in n.names]
        elif isinstance(n, ast.ImportFrom):
            base = paquet.split(".")[: len(paquet.split(".")) - (n.level - 1)] if n.level else []
            cible = ".".join(base + ([n.module] if n.module else [])) if n.level else (n.module or "")
            out += [(n.lineno, cible, a.name) for a in n.names]
        elif isinstance(n, ast.Constant) and isinstance(n.value, str) and MODULE_POINTE.match(n.value):
            if _fichier(n.value) or _chaine_disparue(n.value):
                out.append((n.lineno, n.value, None))
    return [x for x in out if x[1].split(".")[0] in PAQUETS]


def _chaine_disparue(chaine: str) -> bool:
    """Chaîne pointée dont le plus long préfixe existant est un paquet qui n'a ni ce sous-module ni ce nom."""
    parties = chaine.split(".")
    for i in range(len(parties) - 1, 0, -1):
        prefixe = _fichier(".".join(parties[:i]))
        if prefixe is None:
            continue
        if prefixe.is_file() and prefixe.name != "__init__.py":
            return False
        return not (prefixe.is_file() and parties[i] in _noms_definis(ast.parse(prefixe.read_text(encoding="utf-8"))))
    return False


def _fermeture() -> tuple[set[Path], list[str]]:
    vus: set[Path] = set()
    defauts: list[str] = []
    pile = [RACINE / r for r in RACINES]
    while pile:
        f = pile.pop()
        if f in vus or not f.is_file():
            continue
        vus.add(f)
        for ligne, module, nom in _imports(f):
            cible = _fichier(module)
            if cible is None:
                defauts.append(f"{f.relative_to(RACINE)}:{ligne} importe {module} (disparu)")
                continue
            parties = module.split(".")
            pile += [p for p in (_fichier(".".join(parties[:i])) for i in range(1, len(parties))) if p]
            pile.append(cible)
            if nom and nom != "*":
                sous = _fichier(f"{module}.{nom}")
                if sous is not None:
                    pile.append(sous)
                elif cible.is_file() and not _nom_fourni(cible, nom):
                    defauts.append(f"{f.relative_to(RACINE)}:{ligne} importe {nom} de {module} (absent)")
    return vus, defauts


def _modules_des_scripts(rel: str) -> list[str]:
    """Modules du dépôt lancés (``-m``) ou importés par un script shell, et modules importés juste après un ``sys.path``, introuvables."""
    texte = (RACINE / rel).read_text(encoding="utf-8")
    dossiers = [RACINE / d for d in re.findall(r"\$\{?ROOT\}?/([\w./-]+)", texte) if (RACINE / d).is_dir()]
    lignes = texte.splitlines()
    defauts = []
    for no, ligne in enumerate(lignes, 1):
        lances = [m for m in re.findall(r"\s-m\s+([\w.]+)", ligne) if m.split(".")[0] in PAQUETS]
        importes = [a or b for a, b in re.findall(r"(?:^|[\s;'\"])(?:from\s+([\w.]+)\s+import\s|import\s+([\w.]+))", ligne)]
        for mod in lances + importes:
            racine = mod.split(".")[0]
            if racine in PAQUETS:
                trouve = _fichier(mod) is not None
            elif "sys.path" not in "".join(lignes[max(0, no - 4):no]):
                continue
            else:
                trouve = racine in sys.stdlib_module_names or importlib.util.find_spec(racine) is not None or any(
                    (d / f"{racine}.py").is_file() or (d / racine).is_dir() for d in dossiers)
            if not trouve:
                defauts.append(f"{rel}:{no} vise {mod} (introuvable)")
    return defauts


def test_core_python_disparu():
    assert [d for d in DISPARUS if (RACINE / d).exists()] == []


def test_aucun_import_vers_un_module_disparu():
    vus, defauts = _fermeture()
    assert defauts == []
    assert {RACINE / "sandbox-agent/server.py", RACINE / "office/elpis_office/canal.py",
            RACINE / "office/elpis_office/ops.py"} <= vus


@pytest.mark.parametrize("script", SCRIPTS)
def test_scripts_sans_module_disparu(script):
    assert _modules_des_scripts(script) == []


def _lancer(code: str, tmp_path: Path) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("APP_", "LOCAL_MCP_", "TOOLHOST_"))}
    env.update(PYTHONPATH=os.pathsep.join([str(RACINE), str(RACINE / "office")]), PYTHONDONTWRITEBYTECODE="1", LLAMA_IP="127.0.0.1", LLAMA_PORT="1",
               APP_CONFIG_PATH=str(tmp_path / "config.json"), APP_DB_PATH=str(tmp_path / "app.db"),
               APP_DB_BACKEND="sqlite", APP_SANDBOX_DIR=str(tmp_path / "sb"), MCP_SANDBOX_ROOT=str(tmp_path / "sb"),
               APP_MCP_MANIFEST=str(tmp_path / "absent.json"), TOOLHOST_CONFIG=str(tmp_path / "absent.json"),
               ELPIS_AUDIT_DIR=str(tmp_path / "audit"), APP_FILE_HISTORY_DIR=str(tmp_path / "fh"),
               CHART_CACHE_DIR=str(tmp_path / "charts"), APP_USER_SKILLS_DIR=str(tmp_path / "skills"),
               TOOL_CATEGORIES_CACHE_PATH=str(tmp_path / "categories.json"))
    return subprocess.run([sys.executable, "-c", code], cwd=RACINE, env=env, capture_output=True, text=True,
                          timeout=300)


@pytest.mark.parametrize("code", [
    "import sys\nsys.path.insert(0, 'sandbox-agent')\nimport server\n",
    "import sys\nsys.path.insert(0, 'deploy')\nimport configure, tui, wizard\n",
    "import elpis_office, elpis_office.canal, elpis_office.word, elpis_office.powerpoint\n",
], ids=["agent-du-bac", "configuration", "moteur-office"])
def test_points_d_entree_gardes_s_importent(tmp_path, code):
    r = _lancer(code, tmp_path)
    assert r.returncode == 0, r.stderr


def test_un_module_disparu_n_est_plus_resolu_et_un_module_present_l_est():
    assert _fichier("llm_core.tools") is None and _fichier("shared_infra.config") is None
    assert _fichier("server.local_mcp_server") is None and _fichier("toolhost.service") is None
    assert _fichier("elpis_office.canal") and _fichier("elpis_office")
