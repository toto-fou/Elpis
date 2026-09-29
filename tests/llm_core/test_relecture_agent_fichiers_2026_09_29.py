# SPDX-License-Identifier: MIT
"""Relecture de L4.2 (outils fichiers par l'agent de la sandbox) : tests de
non-régression des points relevés."""
from __future__ import annotations

import os

import pytest

import llm_core.tools.fs_tools as fs_tools
from llm_core.tools._espace import Espace
from shared_infra.sandbox import agent_client as AC
from shared_infra.sandbox.agent import server as S
from shared_infra.sandbox.agent_client import AgentError


class _FakeMCP:
    def __init__(self):
        self.tools = {}

    def tool(self, **kw):
        def deco(fn):
            self.tools[fn.__name__] = fn
            return fn
        return deco


@pytest.fixture()
def fs(tmp_path, monkeypatch):
    base = tmp_path / "sandboxes"
    work = base / "guest" / "work"
    work.mkdir(parents=True)
    monkeypatch.setenv("APP_SANDBOX_DIR", str(base))
    mcp = _FakeMCP()
    fs_tools.register(mcp, base)
    return mcp.tools, work


def test_sauvegarde_jamais_sur_un_dossier_et_depuis_la_cible(fs):
    tools, work = fs
    (work / "notes.txt").write_text("v1")
    (work / "notes.txt.bak").mkdir()
    (work / "notes.txt.bak" / "precieux.txt").write_text("garde")
    r = tools["write_file"](None, path="notes.txt", content="v2", backup=True)
    assert r["ok"] is False and r["error"] == "backup_is_directory", r
    assert (work / "notes.txt.bak" / "precieux.txt").read_text() == "garde"
    assert (work / "notes.txt").read_text() == "v1"
    # Un lien : la sauvegarde est une copie de sa cible, pas un second lien.
    (work / "reel.txt").write_text("v1")
    (work / "lien.txt").symlink_to("reel.txt")
    assert tools["write_file"](None, path="lien.txt", content="v2", backup=True)["ok"]
    assert not (work / "lien.txt.bak").is_symlink()
    assert (work / "lien.txt.bak").read_text() == "v1" and (work / "reel.txt").read_text() == "v2"


def test_dossier_apparu_pendant_un_deplacement(fs, monkeypatch):
    tools, work = fs
    (work / "a.txt").write_text("a")
    vrai = Espace.stat

    def stat_puis_dossier(self, rel, **kw):
        e = vrai(self, rel, **kw)
        if rel == "out" and not (work / "out").exists():
            (work / "out").mkdir()
            (work / "out" / "precieux.txt").write_text("garde")
        return e
    monkeypatch.setattr(Espace, "stat", stat_puis_dossier)
    r = tools["manage_files"](None, action="move", path="a.txt", dest="out")
    assert r["ok"] is False and r["error"] == "dest_is_directory", r
    assert (work / "out" / "precieux.txt").read_text() == "garde"
    assert (work / "a.txt").read_text() == "a"


def test_batch_delete_chemins_imbriques_et_doublons(fs):
    tools, work = fs
    (work / "d").mkdir()
    (work / "d" / "f.txt").write_text("f")
    (work / "g.txt").write_text("g")
    r = tools["manage_files"](None, action="batch_delete", recursive=True,
                              paths=["d", "d/f.txt", "g.txt", "./g.txt"])
    assert r["ok"] and r["deleted"] == ["/work/d", "/work/g.txt"], r
    assert not (work / "d").exists() and not (work / "g.txt").exists()


def test_recherche_par_lots(fs, monkeypatch):
    tools, work = fs
    monkeypatch.setattr(fs_tools, "_GREP_LOT", 3)
    for i in range(10):
        (work / f"f{i}.txt").write_text("cible\n" if i % 2 else "rien\n")
    r = tools["list_files"](None, path=".", search_text="cible")
    assert r["ok"] and sorted(h["file"] for h in r["hits"]) == [f"f{i}.txt" for i in (1, 3, 5, 7, 9)], r


def test_ecriture_sur_gros_fichier_sans_le_relire(fs, monkeypatch):
    tools, work = fs
    monkeypatch.setattr(fs_tools, "_CONTENU_MAX", 16)
    monkeypatch.setattr(fs_tools, "_HASH_MAX", 16)      # précondition par le mtime
    (work / "gros.bin").write_bytes(b"0" * 100)
    lus = []
    vrai = AC.AgentClient.read

    async def espion(self, path, **kw):
        lus.append((path, kw.get("max_bytes")))
        return await vrai(self, path, **kw)
    monkeypatch.setattr(AC.AgentClient, "read", espion)
    r = tools["write_file"](None, path="gros.bin", mode="b64", b64="QUJD")
    assert r["ok"], r
    assert (work / "gros.bin").read_bytes() == b"ABC"
    assert all(m is not None and m <= 16 for _p, m in lus), lus
    r = tools["write_file"](None, path="gros.bin", content="x", mode="append")
    assert r["ok"] is True, r                           # 3 octets : relu, ajouté
    (work / "gros.bin").write_bytes(b"0" * 100)
    r = tools["write_file"](None, path="gros.bin", content="x", mode="append")
    assert r["ok"] is False and r["error"] == "too_large", r


def test_copie_elargie_en_mode_hote(fs, monkeypatch):
    tools, work = fs
    monkeypatch.setattr(fs_tools, "use_agent", lambda op: False)
    (work / "d").mkdir()
    (work / "d" / "f").write_text("x")
    os.chmod(work / "d" / "f", 0o644)
    os.chmod(work / "d", 0o755)
    assert tools["manage_files"](None, action="copy", path="d", dest="e")["ok"]
    assert (work / "e").stat().st_mode & 0o777 == 0o777
    assert (work / "e" / "f").stat().st_mode & 0o777 == 0o666


def test_ecriture_a_travers_un_lien_pendant(fs):
    tools, work = fs
    (work / "config.json").symlink_to("config.local.json")
    r = tools["write_file"](None, path="config.json", content="{}")
    assert r["ok"], r
    assert (work / "config.local.json").read_text() == "{}"


def test_arborescence_profonde(fs):
    tools, work = fs
    d = work
    for i in range(70):
        d = d / f"n{i}"
    d.mkdir(parents=True)
    (d / "fond.py").write_text("x = 1\n")
    r = tools["list_files"](None, path=".", pattern="**/*.py", recursive=True)
    assert r["ok"] and [i.rsplit("/", 1)[-1] for i in r["items"]] == ["fond.py"], r
    r = tools["list_files"](None, path=".", search_text="x = 1")
    assert r["ok"] and len(r["hits"]) == 1, r


def test_code_lit_les_candidats_en_une_requete(fs, monkeypatch):
    tools, work = fs
    for i in range(30):
        (work / f"m{i}.py").write_text(f"def path_join():\n    return {i}\n" if i < 20 else "x = 1\n")
    appels = []
    monkeypatch.setattr(AC.AgentClient, "read",
                        lambda self, *a, **k: appels.append(a) or (_ for _ in ()).throw(AssertionError))
    r = tools["code"](None, action="definition", symbol="path_join")
    assert r["ok"] and r["count"] == 20 and not appels, r


def test_delai_total_d_une_operation(tmp_path, monkeypatch):
    import time as _t
    base = tmp_path / "sandboxes"
    work = base / "guest" / "work"
    work.mkdir(parents=True)
    monkeypatch.setenv("APP_SANDBOX_DIR", str(base))
    monkeypatch.setattr(AC, "_DELAI_TOTAL_S", 0.3)
    esp = Espace("guest", work)
    esp.stat("")                                        # agent démarré
    vrai = S.Agent.stat_lot
    monkeypatch.setattr(S.Agent, "stat_lot", lambda self, *a: _t.sleep(1) or vrai(self, *a))
    with pytest.raises(AgentError) as e:
        esp.stat("x")
    assert e.value.code == "timeout"


def test_liste_refuse_un_chemin_hors_de_la_base(tmp_path, monkeypatch):
    base = tmp_path / "sandboxes"
    work = base / "guest" / "work"
    (work / "d").mkdir(parents=True)
    monkeypatch.setenv("APP_SANDBOX_DIR", str(base))

    def faux(self, rel, *a, **k):
        yield {"path": "/etc/passwd", "kind": "file", "size": 1, "mtime_ns": 0, "mode": 0}
        yield {"done": True, "truncated": False, "errors": 0}
    monkeypatch.setattr(S.Agent, "lister", faux)
    with pytest.raises(AgentError) as e:
        Espace("guest", work).lister("d")
    assert e.value.code == "bad_response"
    # Les outils ne construisent alors aucun chemin hôte à partir de la réponse.
    assert fs_tools._instantane_agent(Espace("guest", work), work, "d", {"kind": "dir"}) == []


@pytest.fixture()
def git(tmp_path, monkeypatch):
    import llm_core.tools.git_tools as git_tools
    monkeypatch.setenv("APP_SANDBOX_DIR", str(tmp_path))
    monkeypatch.setattr(git_tools, "_grant_sandbox_access", lambda *a, **k: None)
    mcp = _FakeMCP()
    git_tools.register(mcp, tmp_path)
    work = tmp_path / "guest" / "work"
    work.mkdir(parents=True, exist_ok=True)
    return mcp.tools, work


def _d(r):
    return r if isinstance(r, dict) else r.model_dump()


def test_git_write_a_travers_un_lien_garde_l_historique(git):
    tools, work = git
    assert _d(tools["git_action"](None, repo="proj", action="init")).get("ok")
    (work / "proj" / "reel.txt").write_text("a\n")
    (work / "proj" / "lien.txt").symlink_to("reel.txt")
    r = _d(tools["git_write"](None, repo="proj", action="replace", path="lien.txt",
                              find="a", replace="b"))
    assert r.get("ok"), r
    (fc,) = r["files_changed"]
    assert fc["change"] == "modified" and fc["old_sha256"] and fc["new_sha256"], fc
    assert (work / "proj" / "reel.txt").read_text() == "b\n"


def test_politique_de_branches_jamais_assouplie_si_illisible(git, monkeypatch):
    import llm_core.tools.git_tools as G
    tools, work = git
    assert _d(tools["git_action"](None, repo="proj", action="init")).get("ok")
    rp = work / "proj"
    assert G._load_repo_policy("guest", work, rp)["protected_branches"]   # défauts
    (rp / ".git-tool-policy.json").write_text('{"protected_branches": ["keep-me"]}')
    assert "keep-me" in G._load_repo_policy("guest", work, rp)["protected_branches"]

    async def injoignable(self, *a, **k):
        raise AgentError("agent_unavailable", "test")
    monkeypatch.setattr(AC.AgentClient, "read", injoignable)
    with pytest.raises(ValueError, match="policy_unreadable"):
        G._load_repo_policy("guest", work, rp)
