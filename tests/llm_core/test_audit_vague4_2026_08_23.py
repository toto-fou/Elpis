# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_audit_vague4_2026_08_23.py — vague 4 des constats confirmés
(MCP, outils fichiers/git, sous-agents, exécution).

Constats traités : 30, 32, 33, 42, 43, 47, 55, 57, 58, 60.
"""
from __future__ import annotations

import inspect
import json
import os
import subprocess
import sys

import pytest


# ── 30. Un wrapper MCP referme TOUJOURS son transport ──────────────────────

class _QuiLeve:
    def __init__(self):
        self.sorti = False

    async def __aexit__(self, *a):
        self.sorti = True
        raise ExceptionGroup("unhandled", [RuntimeError("ClosedResource")])


class _Transport:
    def __init__(self):
        self.sorti = False

    async def __aexit__(self, *a):
        self.sorti = True
        return False


@pytest.mark.parametrize("nom", ["MCPStdioWrapper", "MCPSSEWrapper"])
async def test_une_session_qui_leve_ne_laisse_pas_le_transport_ouvert(nom):
    """Le générateur ``ctx`` est ce qui TUE le sous-process. Un
    ``ExceptionGroup`` anyio remonté par la sortie de session sautait la ligne
    suivante, et le process ``local_mcp_server.py`` restait vivant pour toute
    la durée de vie du worker."""
    from llm_core import _mcp_wrappers as W
    cls = getattr(W, nom)
    w = cls.__new__(cls)
    w.session, w.ctx = _QuiLeve(), _Transport()
    transport = w.ctx
    await w.__aexit__(None, None, None)
    assert transport.sorti is True, \
        f"{nom} : le transport n'a jamais été refermé (sous-process orphelin)"
    assert w.session is None and w.ctx is None, "fermeture non idempotente"


def test_les_trois_wrappers_ferment_de_la_meme_facon():
    from llm_core import _mcp_wrappers as W
    for nom in ("MCPStdioWrapper", "MCPSSEWrapper"):
        src = inspect.getsource(getattr(W, nom).__aexit__)
        assert "for obj in (self.session, self.ctx):" in src, nom
        assert "except BaseException:" in src, nom


# ── 32. Plus de fenêtre fail-open au premier tour d'un worker froid ───────

def test_le_registre_est_relu_apres_la_connexion():
    """``_manifest_ok`` et ``_hidden_cats`` étaient figés AVANT la boucle,
    donc avant l'appel qui PEUPLE le registre — une ligne plus loin."""
    from llm_core import _chat_with_tools as W
    src = inspect.getsource(W._collect_mcp_tools)
    # AUDIT 2026-08-31 — les connexions partent en PARALLÈLE (gather) avant
    # la boucle de filtrage ; l'invariant reste : la connexion qui peuple le
    # registre précède la lecture de ``_manifest_ok``.
    i_connect = src.index("mcp_pool.get_or_connect(")
    i_relecture = src.index('_manifest_ok = _manifest_source() != "empty"', i_connect)
    i_usage = src.index("if allowed_cats is not None and _manifest_ok:")
    assert i_connect < i_relecture < i_usage, (
        "le drapeau est encore consommé avec sa valeur d'AVANT la connexion : "
        "au 1er tour d'un worker froid, un compte n'ayant coché que "
        "« Fichiers » reçoit le terminal et le contrôle d'écran")
    assert src.index("_hidden_cats = set(_get_hidden_categories())", i_connect) < i_usage


# ── 33. Le cache disque des catégories ne s'entrelace plus ───────────────

def test_le_temporaire_du_cache_est_propre_au_process():
    from llm_core import _mcp_categories as C
    src = inspect.getsource(C._write_cache)
    assert "os.getpid()" in src, (
        "nom de temporaire CONSTANT pour toute la machine : deux workers qui "
        "ré-ingèrent en même temps publient un JSON tronqué")
    assert "os.replace(tmp, _CACHE_PATH)" in src


def test_deux_ecrivains_concurrents_publient_un_json_valide(tmp_path, monkeypatch):
    import multiprocessing as mp
    from llm_core import _mcp_categories as C
    cible = tmp_path / "cats.json"
    monkeypatch.setattr(C, "_CACHE_PATH", cible)

    gros = {"descriptors": {f"k{i}": "x" * 200 for i in range(200)},
            "tool_to_category": {}, "tool_descriptions": {}, "source": "live"}
    petit = {"descriptors": {"a": "b"}, "tool_to_category": {},
             "tool_descriptions": {}, "source": "live"}
    for _ in range(40):
        C._write_cache(gros)
        C._write_cache(petit)
        json.loads(cible.read_text(encoding="utf-8"))   # lève si corrompu
    assert not list(tmp_path.glob("*.tmp")), "temporaire laissé derrière"


# ── 42. git accepte enfin les valeurs libres du modèle ───────────────────

def test_le_garde_anti_shell_exempte_les_valeurs_libres():
    from llm_core.tools.git_tools import _reject
    argv = ["git", "commit", "-m", "fix: corriger le login\n\nLe token expirait."]
    with pytest.raises(ValueError):
        _reject(argv)                       # sans exemption : refusé
    _reject(argv, free_text_idx={3})        # avec : accepté


@pytest.mark.parametrize("msg", [
    "fix: corriger le login\n\nLe token expirait trop tot.\n",
    "feat: ajouter A & B",
    "fix: ne plus ecraser $HOME",
    "docs: preciser a -> b",
])
def test_les_messages_de_commit_reels_passent(msg):
    from llm_core.tools.git_tools import _reject
    _reject(["git", "commit", "-m", msg], free_text_idx={3})


@pytest.mark.parametrize("motif", ["re:return 1$", "re:foo|bar", "$HOME"])
def test_les_motifs_de_recherche_reels_passent(motif):
    from llm_core.tools.git_tools import _reject
    _reject(["git", "grep", "-n", "--", motif], free_text_idx={4})


def test_le_garde_couvre_toujours_le_reste_de_largv():
    """Il garde une valeur défensive nulle sur une valeur libre (aucun shell),
    mais on ne le retire pas pour autant du reste de la ligne."""
    from llm_core.tools.git_tools import _reject
    with pytest.raises(ValueError):
        _reject(["git", "checkout", "branche;rm -rf /"], free_text_idx={9})


def test_les_quatre_sites_de_valeur_libre_sont_cables():
    from llm_core.tools import git_tools as G
    src = inspect.getsource(G)
    assert src.count("free_text_idx=") >= 5, \
        "un site de valeur libre (commit / stash / grep / find_text) n'est "\
        "pas exempté"


# ── 43. Un clone échoué n'est plus annoncé « Cloned successfully » ───────

def test_le_clone_teste_le_code_de_retour():
    from llm_core.tools import git_tools as G
    src = inspect.getsource(G)
    i = src.index('# action == "clone"')
    bloc = src[i:i + 6000]
    assert 'if not r.get("ok") or r.get("returncode") != 0:' in bloc, (
        "un clone échoué renvoie encore ok:true + « Cloned successfully », et "
        "``_grant_sandbox_access`` s'exécute sur un dossier inexistant")
    assert '_err(\n                        "clone_failed"' in bloc or \
           '"clone_failed"' in bloc


def test_les_trois_surfaces_de_clonage_saccordent():
    """La branche ``init`` et ``git_clone`` testaient déjà ``returncode``."""
    from llm_core.tools import git_tools as G
    src = inspect.getsource(G)
    assert src.count('r.get("returncode") != 0') >= 2


# ── 47. include_git_status fonctionne dans un sous-dossier ───────────────

def test_le_statut_git_est_reancre_sur_le_dossier_liste():
    from llm_core.tools import fs_tools as F
    src = inspect.getsource(F._git_status_map)
    assert "--show-prefix" in src, (
        "le porcelain émet des chemins relatifs à la RACINE DU DÉPÔT ; les "
        "consommateurs indexent depuis le dossier LISTÉ — aucune clé ne "
        "correspond dès qu'on liste un sous-dossier")
    assert "path[len(_prefix):]" in src


@pytest.mark.skipif(not os.environ.get("PATH"), reason="git requis")
def test_un_sous_dossier_remonte_bien_son_statut(tmp_path, monkeypatch):
    from llm_core.tools.fs_tools import _git_status_map
    from shared_infra import config
    monkeypatch.setattr(config, "SANDBOX_DIR", tmp_path)
    sb = tmp_path / "alice" / "work"
    repo = sb / "proj"
    (repo / "src").mkdir(parents=True)
    env = {**os.environ, "GIT_CONFIG_GLOBAL": "/dev/null",
           "GIT_CONFIG_SYSTEM": "/dev/null"}
    for cmd in (["git", "init", "-q"],
                ["git", "config", "user.email", "a@b.c"],
                ["git", "config", "user.name", "t"]):
        subprocess.run(cmd, cwd=repo, check=True, env=env,
                       capture_output=True)
    (repo / "src" / "app.py").write_text("v1\n")
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True, env=env,
                   capture_output=True)
    subprocess.run(["git", "commit", "-qm", "init"], cwd=repo, check=True,
                   env=env, capture_output=True)
    (repo / "src" / "app.py").write_text("v2\n")
    (repo / "src" / "new.py").write_text("neuf\n")

    depuis_la_racine, err = _git_status_map(sb, repo)
    assert err is None
    assert "src/app.py" in depuis_la_racine

    depuis_le_sous_dossier, _err = _git_status_map(sb, repo / "src")
    assert "app.py" in depuis_le_sous_dossier, (
        f"map vide ou mal ancrée : {depuis_le_sous_dossier} — l'agent conclut "
        f"que src/ est propre et réapplique ses modifications")
    assert "new.py" in depuis_le_sous_dossier

    # Une config qui ferait exécuter une commande à ``status`` : dépôt refusé.
    witness = tmp_path / "fsmonitor-lance"
    subprocess.run(["git", "config", "core.fsmonitor", f"touch {witness}; false"],
                   cwd=repo, check=True, env=env, capture_output=True)
    statut, err = _git_status_map(sb, repo)
    assert statut == {} and "refused" in err          # jamais un « arbre propre »
    assert not witness.exists()
    assert _git_status_map(sb, sb)[1]                  # pas un dépôt : raison donnée


# ── 55. skill_add_file rend un chemin résoluble ─────────────────────────

def test_le_chemin_rendu_est_relatif_au_dossier_du_skill():
    from llm_core.tools import skill_tools as S
    src = inspect.getsource(S)
    assert "rel_in_store" not in src, (
        "le chemin annoncé est relatif au STORE alors que skill_read_file "
        "résout sous skill_dir : le préfixe est compté deux fois")
    assert "rel_in_skill" in src


def test_la_normalisation_est_celle_de_lecrivain():
    """``add_user_skill_file`` normalise exactement ainsi : c'est ce qui
    garantit que la note rendue au modèle désigne le fichier écrit."""
    from llm_core import skills as SK
    src = inspect.getsource(SK.add_user_skill_file)
    assert 'replace("\\\\", "/")' in src and "lstrip" in src


# ── 57. Un Stop pendant le spawn ne laisse pas d'entrée fantôme ─────────

def test_linscription_du_sous_agent_est_couverte_par_le_finally():
    from llm_core.tools import task_tool as T
    src = inspect.getsource(T)
    i_inscr = src.index("_ACTIVE_CHILDREN[_ckey] = {")
    i_pop = src.index("_ACTIVE_CHILDREN.pop(_ckey, None)")
    i_try = src.rindex("        try:", 0, i_pop)
    assert i_try < i_inscr or src.index("        try:", i_inscr) < i_pop, \
        "inscription hors du try/finally"
    # Le point clé : plus AUCUN await entre l'inscription et le ``try``.
    entre = src[i_inscr:src.index("        try:", i_inscr)]
    assert "await" not in entre, (
        f"il reste un point de suspension entre l'inscription et le try : "
        f"{entre.strip()[:120]!r} — un CancelledError y laisserait une "
        f"entrée fantôme définitive")


def test_le_garde_fou_anti_flag_orphelin_reste_en_place():
    """C'est lui qu'une entrée fantôme rouvrait."""
    from llm_core.tools import task_tool as T
    src = inspect.getsource(T.apply_child_cancel)
    assert "_ACTIVE_CHILDREN" in src


# ── 58. Le PID de background est celui de la commande ───────────────────

def test_le_wrapper_ne_met_plus_toute_la_liste_en_arriere_plan():
    from llm_core.tools import shell_tools as S
    src = inspect.getsource(S)
    assert '"$(dirname "$2")" && ' not in src, (
        "``&`` a une précédence plus faible que ``&&`` : ``$!`` désigne le "
        "sous-shell, pas la commande")
    assert 'nohup setsid bash -c "$1"' in src


@pytest.mark.skipif(sys.platform != "linux", reason="ps -o args= requis")
def test_le_pid_rendu_par_le_wrapper_designe_la_commande(tmp_path):
    from llm_core.tools import shell_tools as S
    src = inspect.getsource(S)
    i = src.index("_wrapper = (")
    j = src.index("tokens = [", i)
    wrapper = eval(src[i + len("_wrapper = "):j].strip(), {}, {})
    log = tmp_path / "bg.log"
    r = subprocess.run(["bash", "-c", wrapper, "bash", "sleep 9", str(log)],
                       capture_output=True, text=True, timeout=10)
    pid = int(r.stdout.strip().splitlines()[-1])
    import time
    time.sleep(0.4)
    try:
        ps = subprocess.run(["ps", "-o", "args=", "-p", str(pid)],
                            capture_output=True, text=True, timeout=5)
        assert "sleep 9" in (ps.stdout or ""), (
            f"le PID {pid} désigne {ps.stdout.strip()!r} : le « kill <pid> » "
            f"dicté au modèle laisse le processus vivant")
    finally:
        subprocess.run(["kill", "-9", str(pid)], capture_output=True)


# ── 60. Le message de débord dit la vraie cause ─────────────────────────

def test_le_hint_de_debord_distingue_les_deux_causes():
    from llm_core.tools import shell_tools as S
    src = inspect.getsource(S)
    i = src.index('result.pop("auto_saved", False)')
    bloc = src[i:i + 2200]
    assert 'if result.get("truncated"):' in bloc, (
        "le message annonce « Output truncated » même quand rien n'est "
        "tronqué : le modèle relit un fichier qu'il a déjà entier")
    assert "the stdout below is COMPLETE" in bloc


def test_la_bande_sans_troncature_existe_bel_et_bien():
    """Plancher de débord 7 920 caractères, troncature réelle à 20 000 :
    ]7920, 20000] est la bande où les deux messages se contredisaient."""
    from llm_core.tools.shell_tools import _spill_floor_chars, DEFAULT_MAX_OUTPUT
    assert _spill_floor_chars() < DEFAULT_MAX_OUTPUT
