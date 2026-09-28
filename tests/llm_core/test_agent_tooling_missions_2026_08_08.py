# SPDX-License-Identifier: MIT
"""Défauts d'outillage trouvés en faisant tourner les agents `pr` et `web`
sur de vraies missions longues (2026-08-08).

Les trois constats viennent d'exécutions réelles via le pont LLM local — pas
d'une relecture. Chacun BLOQUAIT l'agent indépendamment de la qualité du
raisonnement, ce qui est précisément ce qu'on voulait écarter.

1. `git_inspect` parsait le porcelain avec `line.partition(" ")`, alors que le
   format est à COLONNES FIXES. Sur une modification non indexée (` M fichier`,
   le cas le plus courant) : chemin corrompu (« M src/parser.py ») et compteurs
   staged/unstaged à 0 — l'agent partait d'un état faux, et la persona de `pr`
   fait de `git_inspect` son « always your first call ».

2. `list_files(details=True)` sur un SOUS-DOSSIER construisait `path` avec le
   dossier listé pour base au lieu de la racine sandbox : un fichier réel en
   `/work/a/b/out.bin` était annoncé `/work/out.bin`. Réinjecté dans
   `read_file`, ce chemin donne « not_found ».

3. `pw_page(op="text")` envoyait `selector: null` ; le service déclare son
   défaut en déstructuration JS (`const { selector = 'body' }`), qui ne
   s'applique qu'à `undefined`. Le service explosait sur `text.replace` d'un
   `null`. Comme `op="extract"` ne sait extraire que des TABLEAUX, plus aucune
   primitive ne permettait de lire le texte d'un élément.
"""
import fnmatch

import pytest

from tests.llm_core._pw_harness import CTX as _CTX, pw, pw_env, sent  # noqa: F401


# ── 1. porcelain à colonnes fixes ────────────────────────────────────────

def _parse(line):
    """Réplique la logique corrigée de git_inspect."""
    xy = line[:2]
    path = line[3:].strip().strip('"')
    if " -> " in path:
        path = path.split(" -> ", 1)[1].strip().strip('"')
    staged = int(xy[0] not in (" ", "?"))
    unstaged = int(len(xy) >= 2 and xy[1] not in (" ", "?"))
    untracked = int(xy == "??")
    return xy, path, staged, unstaged, untracked


@pytest.mark.parametrize("line,xy,path,st,un,unt", [
    (" M src/parser.py", " M", "src/parser.py", 0, 1, 0),   # LE cas qui cassait
    ("M  src/parser.py", "M ", "src/parser.py", 1, 0, 0),
    ("MM src/parser.py", "MM", "src/parser.py", 1, 1, 0),
    (" D vieux.py",      " D", "vieux.py",      0, 1, 0),
    ("A  neuf.py",       "A ", "neuf.py",       1, 0, 0),
    ("?? .env.local",    "??", ".env.local",    0, 0, 1),
    ("?? build/",        "??", "build/",        0, 0, 1),
])
def test_porcelain_colonnes_fixes(line, xy, path, st, un, unt):
    assert _parse(line) == (xy, path, st, un, unt)


def test_renommage_garde_la_cible():
    assert _parse("R  old.py -> new.py")[1] == "new.py"


def test_chemin_avec_espaces():
    """Le chemin ne doit jamais etre tronqué au premier espace."""
    assert _parse(" M mon dossier/mon fichier.py")[1] == "mon dossier/mon fichier.py"


def test_git_inspect_utilise_bien_les_colonnes():
    import inspect
    from llm_core.tools import git_tools
    src = inspect.getsource(git_tools)
    i = src.index("Dirty state via porcelain")
    corps = src[i:i + 2500]
    code = "\n".join(l for l in corps.splitlines() if not l.lstrip().startswith("#"))
    assert "line[:2]" in code and "line[3:]" in code
    assert 'line.partition(" ")' not in code, \
        "retour au découpage au premier espace : les modifications non " \
        "indexées seront de nouveau invisibles"


# ── 2. list_files : path réutilisable ────────────────────────────────────

def test_stat_recoit_la_racine_sandbox_pas_le_dossier_liste():
    import inspect
    from llm_core.tools import fs_tools
    src = inspect.getsource(fs_tools)
    i = src.index("if details:")
    corps = src[i:i + 1400]
    code = "\n".join(l for l in corps.splitlines() if not l.lstrip().startswith("#"))
    assert "_stat(c, sb)" in code, \
        "la base repasse au dossier listé : les chemins renvoyés par un " \
        "listing de sous-dossier redeviennent inutilisables"
    assert "_stat(c, root)" not in code


def test_to_container_est_bien_relatif_a_la_sandbox(tmp_path):
    """Le contrat de _stat : `path` doit être réutilisable tel quel."""
    from llm_core.tools.fs_tools import _stat
    sb = tmp_path
    sub = tmp_path / "a" / "b"
    sub.mkdir(parents=True)
    f = sub / "out.bin"
    f.write_text("x")
    d = _stat(f, sb)
    assert d["path"] == "/work/a/b/out.bin", d["path"]
    assert d["rel"] == "a/b/out.bin", d["rel"]


# ── 3. pw_page(op="text") : ne jamais envoyer selector=null ───────────────
#
# Ces trois-là sont vérifiés EN EXÉCUTANT l'outil, pas en relisant sa source :
# la première version de ces tests grepait le code, et a laissé passer un
# ``TypeError`` (double ``fix=``) dans le garde-fou ``url_required`` — le
# refus plantait au lieu de renvoyer son enveloppe.

def test_op_text_omet_la_cle_selector_quand_vide(pw, sent):
    """`null` ne déclenche PAS le défaut JS `= 'body'` — seule l'absence de
    clé le fait. C'est la différence entre lire la page et un 500."""
    pw("pw_page")(_CTX, "s1", action="text")
    assert "selector" not in sent[-1].body, sent[-1].body


def test_op_text_transmet_un_selecteur_explicite(pw, sent):
    pw("pw_page")(_CTX, "s1", action="text", selector="#main")
    assert sent[-1].body["selector"] == "#main"


# ── pw_session(start) sans url : refus explicite ─────────────────────────

def test_start_sans_url_est_refuse(pw, sent):
    """`url` est documenté « Required », mais l'appel passait et rendait une
    session `about:blank`."""
    r = pw("pw_session")(_CTX, "start")
    assert r["ok"] is False and r["error"] == "url_required"
    assert not sent, "aucun appel ne doit partir au service"
    # Le refus doit NOMMER la sortie : goto existe bien (pw_act), le message
    # d'origine prétendait le contraire.
    assert "goto" in r["fix"]


def test_start_avec_url_passe(pw, sent):
    pw("pw_session")(_CTX, "start", url="https://x.test/")
    assert sent[-1].endpoint == "/start"
    assert sent[-1].body["url"] == "https://x.test/"
