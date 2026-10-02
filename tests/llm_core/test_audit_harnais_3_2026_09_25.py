# SPDX-License-Identifier: MIT
"""AUDIT 2026-09-25 (3e passe du cœur du harnais) — tests de non-régression.
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

import llm_core.tools.fs_tools as fs_tools
from llm_core import _model_info


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
    base.mkdir()
    monkeypatch.setenv("APP_SANDBOX_DIR", str(base))
    mcp = _FakeMCP()
    fs_tools.register(mcp, base)
    work = base / "guest" / "work"
    work.mkdir(parents=True, exist_ok=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    return mcp.tools, work, outside


# ── Écritures sous la racine : aucun lien suivi ─────────────────────────────

def test_write_beneath_remplace_un_lien_au_lieu_de_le_suivre(tmp_path):
    from shared_infra.sandbox.paths import write_beneath
    root = tmp_path / "root"
    root.mkdir()
    cible = tmp_path / "hors.txt"
    cible.write_text("intact")
    (root / "out.txt").symlink_to(cible)
    write_beneath(root, "out.txt", b"nouveau")
    assert cible.read_text() == "intact"
    assert not (root / "out.txt").is_symlink()
    assert (root / "out.txt").read_bytes() == b"nouveau"


def test_write_beneath_refuse_un_dossier_intermediaire_lien(tmp_path):
    from shared_infra.sandbox.paths import SandboxPathError, write_beneath
    root = tmp_path / "root"
    root.mkdir()
    ailleurs = tmp_path / "ailleurs"
    ailleurs.mkdir()
    (root / "d").symlink_to(ailleurs, target_is_directory=True)
    with pytest.raises(SandboxPathError):
        write_beneath(root, "d/x.txt", b"x")
    assert not (ailleurs / "x.txt").exists()


def test_write_beneath_refuse_absolu_et_remontee(tmp_path):
    from shared_infra.sandbox.paths import SandboxPathError, write_beneath
    root = tmp_path / "root"
    root.mkdir()
    for bad in ("/etc/x", "../x", "a/../../x"):
        with pytest.raises(SandboxPathError):
            write_beneath(root, bad, b"x")


def test_write_beneath_conserve_le_mode_du_fichier_remplace(tmp_path):
    from shared_infra.sandbox.paths import write_beneath
    root = tmp_path / "root"
    root.mkdir()
    f = root / "run.sh"
    f.write_text("a")
    os.chmod(f, 0o755)
    write_beneath(root, "run.sh", b"b")
    assert (f.stat().st_mode & 0o777) == 0o755


def test_sortie_shell_sauvegardee_ne_suit_pas_un_lien(tmp_path, monkeypatch):
    from llm_core.tools._exec_bridge import _write_output_file, sandbox_for
    from shared_infra.sandbox.agent_client import AgentError
    base = tmp_path / "sandboxes"
    root = base / "guest" / "work"
    root.mkdir(parents=True)
    monkeypatch.setenv("APP_SANDBOX_DIR", str(base))
    cible = tmp_path / "hors.txt"
    cible.write_text("intact")
    # Le lien apparaît APRÈS la validation du chemin (pendant la commande).
    (root / "out.txt").symlink_to(cible)
    with pytest.raises(AgentError):
        _write_output_file(sandbox_for("guest", root), "out.txt", b"sortie")
    assert cible.read_text() == "intact"


def test_backup_de_write_file_ne_suit_pas_un_lien(fs):
    tools, work, outside = fs
    cible = outside / "hors.txt"
    cible.write_text("intact")
    assert tools["write_file"](None, path="x.py", content="v1\n")["ok"]
    (work / "x.py.bak").symlink_to(cible)
    assert tools["write_file"](None, path="x.py", content="v2\n", backup=True)["ok"]
    assert cible.read_text() == "intact"
    assert (work / "x.py.bak").read_text() == "v1\n"
    assert (work / "x.py").read_text() == "v2\n"


def test_git_write_atomique_temporaire_imprevisible(tmp_path, monkeypatch):
    from llm_core.tools._espace import Espace
    from llm_core.tools.git_tools import _write_atomic
    base = tmp_path / "sandboxes"
    work = base / "guest" / "work"
    work.mkdir(parents=True)
    monkeypatch.setenv("APP_SANDBOX_DIR", str(base))
    p = work / "f.txt"
    p.write_text("a")
    os.chmod(p, 0o644)
    # L'ancien nom prévisible, occupé par un lien, n'est plus utilisé.
    cible = tmp_path / "hors.txt"
    cible.write_text("intact")
    os.chmod(cible, 0o600)
    (work / f"f.txt.{os.getpid()}.tmp").symlink_to(cible)
    _write_atomic(Espace("guest", work), work, "f.txt", "b", 10_000)
    assert p.read_text() == "b"
    assert cible.read_text() == "intact"
    assert (cible.stat().st_mode & 0o777) == 0o600


# ── manage_files : sémantique du shell, pas d'effacement implicite ─────────

def test_move_vers_un_dossier_existant_va_dedans(fs):
    tools, work, _ = fs
    (work / "docs").mkdir()
    (work / "docs" / "un.md").write_text("1")
    (work / "notes.txt").write_text("n")
    r = tools["manage_files"](None, action="move", path="notes.txt", dest="docs")
    assert r["ok"], r
    assert (work / "docs" / "un.md").read_text() == "1"      # docs/ intact
    assert (work / "docs" / "notes.txt").read_text() == "n"


def test_copy_de_dossier_vers_un_dossier_existant_va_dedans(fs):
    tools, work, _ = fs
    (work / "src").mkdir()
    (work / "src" / "a.py").write_text("a")
    (work / "dst").mkdir()
    (work / "dst" / "keep.py").write_text("k")
    r = tools["manage_files"](None, action="copy", path="src", dest="dst")
    assert r["ok"], r
    assert (work / "dst" / "keep.py").read_text() == "k"
    assert (work / "dst" / "src" / "a.py").read_text() == "a"


def test_remplacer_un_dossier_existant_est_refuse(fs):
    tools, work, _ = fs
    (work / "a").mkdir()
    (work / "a" / "f").write_text("1")
    (work / "b").mkdir()
    (work / "b" / "a").mkdir()
    (work / "b" / "a" / "g").write_text("2")
    r = tools["manage_files"](None, action="move", path="a", dest="b")
    assert not r.get("ok") and "directory" in str(r).lower()
    assert (work / "b" / "a" / "g").read_text() == "2"
    assert (work / "a" / "f").read_text() == "1"


def test_copie_dans_son_propre_sous_dossier_refusee(fs):
    tools, work, _ = fs
    (work / "d" / "sub").mkdir(parents=True)
    r = tools["manage_files"](None, action="copy", path="d", dest="d/sub")
    assert not r.get("ok")


def test_copie_de_fichier_ne_suit_pas_un_lien_de_destination(fs):
    tools, work, outside = fs
    cible = outside / "hors.txt"
    cible.write_text("intact")
    (work / "p.py").write_text("contenu")
    (work / "d").mkdir()
    (work / "d" / "p.py").symlink_to(cible)
    r = tools["manage_files"](None, action="copy", path="p.py", dest="d")
    assert r["ok"], r
    assert cible.read_text() == "intact"
    assert (work / "d" / "p.py").read_text() == "contenu"


def test_delete_d_un_lien_retire_le_lien_pas_la_cible(fs):
    tools, work, _ = fs
    (work / "reel").mkdir()
    (work / "reel" / "f.txt").write_text("1")
    (work / "lien").symlink_to(work / "reel", target_is_directory=True)
    r = tools["manage_files"](None, action="delete", path="lien", recursive=True)
    assert r["ok"], r
    assert not os.path.lexists(work / "lien")
    assert (work / "reel" / "f.txt").read_text() == "1"


def test_delete_d_un_lien_vers_l_exterieur_possible(fs):
    tools, work, outside = fs
    cible = outside / "hors.txt"
    cible.write_text("intact")
    (work / "l").symlink_to(cible)
    r = tools["manage_files"](None, action="delete", path="l")
    assert r["ok"], r
    assert not os.path.lexists(work / "l")
    assert cible.read_text() == "intact"


def test_move_d_un_lien_deplace_le_lien(fs):
    tools, work, _ = fs
    (work / "reel.txt").write_text("1")
    (work / "l").symlink_to(work / "reel.txt")
    (work / "d").mkdir()
    r = tools["manage_files"](None, action="move", path="l", dest="d")
    assert r["ok"], r
    assert (work / "d" / "l").is_symlink()
    assert (work / "reel.txt").read_text() == "1"



def test_batch_delete_d_un_lien_retire_le_lien_pas_la_cible(fs):
    tools, work, _ = fs
    (work / "reel").mkdir()
    (work / "reel" / "f.txt").write_text("1")
    (work / "lien").symlink_to(work / "reel", target_is_directory=True)
    r = tools["manage_files"](None, action="batch_delete", paths=["lien"], dry_run=True)
    assert r["plan"][0]["type"] == "symlink"
    r = tools["manage_files"](None, action="batch_delete", paths=["lien"])
    assert r["ok"] and r["count"] == 1 and "files_changed" not in r, r
    assert not os.path.lexists(work / "lien")
    assert (work / "reel" / "f.txt").read_text() == "1"


def test_copie_d_un_lien_copie_sa_cible(fs):
    tools, work, _ = fs
    (work / "reel.txt").write_text("contenu")
    (work / "l").symlink_to("reel.txt")
    r = tools["manage_files"](None, action="copy", path="l", dest="copie.txt")
    assert r["ok"], r
    assert not (work / "copie.txt").is_symlink()
    assert (work / "copie.txt").read_text() == "contenu"


def test_copie_d_un_dossier_dans_lui_meme_par_un_lien_refusee(fs):
    tools, work, _ = fs
    (work / "d" / "sous").mkdir(parents=True)
    (work / "raccourci").symlink_to(work / "d" / "sous", target_is_directory=True)
    r = tools["manage_files"](None, action="copy", path="d", dest="raccourci/copie")
    assert r["ok"] is False and r["error"] == "dest_inside_source", r
    assert sorted(os.listdir(work / "d" / "sous")) == []


def test_chemins_entre_guillemets_et_caracteres_de_controle(fs):
    tools, work, _ = fs
    (work / "a.txt").write_text("x")
    assert tools["read_file"](None, path='"a.txt"')["ok"]
    r = tools["manage_files"](None, action="copy", path="'a.txt'", dest='"b.txt"')
    assert r["ok"] and (work / "b.txt").read_text() == "x", r
    r = tools["manage_files"](None, action="mkdir", path="x\x01y")
    assert r["ok"] is False and r["error"] == "control_character_in_path", r

# ── edit_file : moteur d'édition ────────────────────────────────────────────

def test_multi_numeros_de_ligne_du_fichier_lu(fs):
    tools, work, _ = fs
    (work / "f.txt").write_text("".join(f"L{i}\n" for i in range(1, 11)))
    r = tools["edit_file"](None, path="f.txt", action="multi", edits=[
        {"action": "delete", "start_line": 2, "end_line": 3},
        {"action": "replace", "start_line": 8, "end_line": 8, "content": "EIGHT"},
    ])
    assert r["ok"], r
    lignes = (work / "f.txt").read_text().splitlines()
    assert "EIGHT" in lignes and "L8" not in lignes
    assert "L10" in lignes and "L2" not in lignes and "L3" not in lignes


def test_multi_plages_chevauchantes_refusees(fs):
    tools, work, _ = fs
    (work / "f.txt").write_text("".join(f"L{i}\n" for i in range(1, 11)))
    r = tools["edit_file"](None, path="f.txt", action="multi", edits=[
        {"action": "delete", "start_line": 2, "end_line": 5},
        {"action": "replace", "start_line": 4, "end_line": 6, "content": "X"},
    ])
    assert not r.get("ok")
    assert (work / "f.txt").read_text().startswith("L1\nL2\n")


def test_multi_crlf_normalise_chaque_edition(fs):
    tools, work, _ = fs
    (work / "w.txt").write_bytes(b"x\r\na\r\nb\r\ny\r\n")
    r = tools["edit_file"](None, path="w.txt", action="multi", edits=[
        {"action": "str_replace", "old_str": "a\r\nb", "new_str": "A\r\nB"},
    ])
    assert r["ok"], r
    assert (work / "w.txt").read_bytes() == b"x\r\nA\r\nB\r\ny\r\n"


def test_multi_anchor_derniere_occurrence(fs):
    tools, work, _ = fs
    (work / "m.py").write_text("import a\nimport b\n\nx = 1\n")
    r = tools["edit_file"](None, path="m.py", action="multi", edits=[
        {"action": "anchor", "anchor_re": "^import ", "position": "after",
         "occurrence": -1, "content": "import c"},
    ])
    assert r["ok"], r
    assert (work / "m.py").read_text() == "import a\nimport b\nimport c\n\nx = 1\n"


def test_insert_apres_la_derniere_ligne_sans_saut_final(fs):
    tools, work, _ = fs
    (work / "s.py").write_text("a = 1\nb = 2")
    r = tools["edit_file"](None, path="s.py", action="insert", start_line=3,
                           content="c = 3")
    assert r["ok"], r
    assert (work / "s.py").read_text() == "a = 1\nb = 2\nc = 3\n"


def test_regex_remplace_toutes_les_occurrences_par_defaut(fs):
    tools, work, _ = fs
    (work / "r.py").write_text("old_name(1)\nold_name(2)\nold_name(3)\n")
    r = tools["edit_file"](None, path="r.py", action="regex",
                           pattern=r"\bold_name\b", replacement="new_name")
    assert r["ok"], r
    assert "old_name" not in (work / "r.py").read_text()


def test_str_replace_reste_unitaire_par_defaut(fs):
    tools, work, _ = fs
    (work / "u.py").write_text("x = 1\ny = 2\n")
    r = tools["edit_file"](None, path="u.py", action="str_replace",
                           old_str="x = 1", new_str="x = 10")
    assert r["ok"], r
    assert (work / "u.py").read_text() == "x = 10\ny = 2\n"


# ── read_file : gros fichier lu en flux ─────────────────────────────────────

def test_read_file_gros_fichier_en_flux(fs, monkeypatch):
    tools, work, _ = fs
    monkeypatch.setattr(fs_tools, "_STREAM_READ_OVER", 1000)
    (work / "big.log").write_text("".join(
        f"ligne {i}{' ERREUR' if i == 150 else ''}\n" for i in range(1, 301)))
    r = tools["read_file"](None, path="big.log", tail=2)
    assert r["ok"] and r.get("streamed") and r["total_lines"] == 300
    assert r["content"].splitlines()[-1].endswith("ligne 300")
    r = tools["read_file"](None, path="big.log", grep="ERREUR", grep_context=1)
    assert r["matches"] == 1 and "150:ligne 150 ERREUR" in r["content"]
    assert "149-ligne 149" in r["content"] and "151-ligne 151" in r["content"]
    r = tools["read_file"](None, path="big.log", start_line=10, end_line=11)
    assert r["content"].splitlines() == ["10\tligne 10", "11\tligne 11"]
    r = tools["read_file"](None, path="big.log", format="json")
    assert not r.get("ok")


# ── list_files / code : recherches complètes et globs usuels ───────────────

def test_glob_double_etoile():
    g = fs_tools._glob_match
    assert g("main.py", "**/*.py") and g("pkg/mod.py", "**/*.py")
    assert g("src/x.ts", "src/**/*.ts") and g("src/a/b/x.ts", "src/**/*.ts")
    assert not g("lib/x.ts", "src/**/*.ts")
    assert g("pkg/mod.py", "*.py")                  # motif sans / : le nom
    assert not g("src/a/b.ts", "src/*.ts")          # * ne franchit pas /


def test_list_files_glob_recursif_implicite(fs):
    tools, work, _ = fs
    (work / "main.py").write_text("x")
    (work / "pkg").mkdir()
    (work / "pkg" / "mod.py").write_text("y")
    r = tools["list_files"](None, path=".", pattern="**/*.py")
    noms = {str(i.get("path") if isinstance(i, dict) else i) for i in r["items"]}
    assert any(n.endswith("main.py") for n in noms), r
    assert any(n.endswith("mod.py") for n in noms), r


def test_recherche_signale_les_fichiers_ecartes(fs, monkeypatch):
    tools, work, _ = fs
    monkeypatch.setattr(fs_tools, "_SEARCH_MAX_BYTES", 100)
    (work / "gros.py").write_text("aiguille\n" + "x" * 500)
    (work / "petit.py").write_text("rien\naiguille ici\n")
    (work / "bin.dat").write_bytes(b"\x00\x01aiguille")
    r = tools["list_files"](None, path=".", search_text="aiguille")
    assert r["count"] == 1 and r["hits"][0]["file"] == "petit.py"
    assert r.get("skipped_large") == 1 and r.get("skipped_binary") == 1
    assert "hint" in r


def test_recherche_ne_descend_pas_les_dossiers_exclus(fs):
    tools, work, _ = fs
    (work / "node_modules" / "p").mkdir(parents=True)
    (work / "node_modules" / "p" / "i.js").write_text("aiguille")
    (work / "src").mkdir()
    (work / "src" / "a.js").write_text("aiguille")
    r = tools["list_files"](None, path=".", search_text="aiguille")
    assert [h["file"] for h in r["hits"]] == ["src/a.js"]


def test_code_definition_ignore_les_dependances(fs):
    tools, work, _ = fs
    if not getattr(fs_tools, "_HAS_CI", False):
        pytest.skip("code_intel indisponible")
    (work / ".venv" / "lib").mkdir(parents=True)
    (work / ".venv" / "lib" / "dep.py").write_text("def handler():\n    pass\n")
    (work / "node_modules").mkdir()
    (work / "node_modules" / "dep.py").write_text("def handler():\n    pass\n")
    (work / "app.py").write_text("def handler():\n    return 1\n")
    r = tools["code"](None, action="definition", symbol="handler")
    assert r["ok"], r
    fichiers = [m.get("file") or m.get("path") for m in r.get("matches", [])]
    assert fichiers and all("node_modules" not in str(f) and ".venv" not in str(f)
                            for f in fichiers), fichiers


# ── Budget dur : hystérésis (préfixe KV stable d'une itération à l'autre) ──

def _tc(cid, name="read_file"):
    return {"id": cid, "type": "function", "function": {"name": name, "arguments": "{}"}}


def _cycles(n):
    msgs = [{"role": "system", "content": "SYS"}, {"role": "user", "content": "mission"}]
    for i in range(n):
        msgs += [{"role": "assistant", "content": None, "tool_calls": [_tc(f"c{i}")]},
                 {"role": "tool", "tool_call_id": f"c{i}", "content": f"obs {i}"}]
    return msgs


async def test_budget_dur_hysteresis_prefixe_stable(monkeypatch):
    from llm_core.context import pruning as P

    async def _counts(messages, model_id=None):
        return [100] * len(messages)
    monkeypatch.setattr(P, "count_messages_tokens_per_msg", _counts)
    budget = 3_000
    overhead = 100_000 - P.BUDGET.reserve_tokens(100_000, 0) - budget

    st1: dict = {}
    out1 = await P.enforce_context_budget(
        _cycles(20), 100_000, model_id="m", gen_cap_tokens=0,
        fixed_overhead_tokens=overhead, stats_out=st1)
    # Retrait jusqu'au filigrane bas (75 % du budget), pas au ras du budget.
    assert 100 * len(out1) <= int(budget * P._DROP_LOW_WATERMARK)
    k = st1["drop_floor"]
    assert k > 0

    # Itération suivante : un cycle de plus. Le plancher garde EXACTEMENT les
    # mêmes retraits — le début de la vue (donc le préfixe KV) ne bouge pas.
    st2: dict = {}
    out2 = await P.enforce_context_budget(
        _cycles(21), 100_000, model_id="m", gen_cap_tokens=0,
        fixed_overhead_tokens=overhead, stats_out=st2, drop_floor=k)
    assert st2["drop_floor"] == k
    assert out2[:len(out1)] == out1


async def test_budget_dur_sans_depassement_rend_tout(monkeypatch):
    from llm_core.context import pruning as P

    async def _counts(messages, model_id=None):
        return [10] * len(messages)
    monkeypatch.setattr(P, "count_messages_tokens_per_msg", _counts)
    st: dict = {}
    msgs = _cycles(3)
    out = await P.enforce_context_budget(msgs, 100_000, model_id="m",
                                         gen_cap_tokens=0, stats_out=st,
                                         drop_floor=2)
    assert out == msgs and st["drop_floor"] == 0


# ── Rappel <todo_status> rejoué à l'octet (préfixe KV stable entre tours) ──

def test_suffixe_rejoue_a_l_identique_sauf_sur_la_derniere_question():
    from chatbot_app.turn.history import _expand_history_for_llm
    from llm_core.context.pruning import merge_user_suffix, user_suffix_sig
    rappel = "<todo_status>1 open task</todo_status>"
    hist = [
        {"role": "user", "content": "ok"},
        {"role": "assistant", "content": "fait"},
        {"role": "user", "content": "ok"},            # même texte, autre rang
        {"role": "assistant", "content": "suite"},
        {"role": "user", "content": "ok"},            # question EN COURS
    ]
    # Le tour 2 (rang 1) avait reçu le rappel.
    suffixes = {user_suffix_sig(1, "ok"): rappel}
    out = _expand_history_for_llm(hist, user_suffixes=suffixes)
    users = [m["content"] for m in out if m["role"] == "user"]
    assert users[0] == "ok"                                  # rang 0 : intact
    assert users[1] == merge_user_suffix("ok", rappel)       # rejoué à l'octet
    assert users[2] == "ok"                                  # tour en cours
    # Même règle que la boucle (fusion unique).
    assert users[1] == "ok\n\n" + rappel


def test_suffixe_sur_contenu_multimodal():
    from llm_core.context.pruning import merge_user_suffix
    c = [{"type": "text", "text": "vois"}, {"type": "image_url", "image_url": {"url": "x"}}]
    assert merge_user_suffix(c, "R")[-1] == {"type": "text", "text": "R"}
    assert merge_user_suffix(c, "R")[:2] == c


def test_suffixes_persistes_et_bornes(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    from shared_infra.db._connection import init_db
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "t.db"))
    legacy.reset_pool()
    init_db()
    from shared_infra.accounts.users import create_user
    from shared_infra.chat.store import finalize_turn_meta, get_chat, upsert_chat
    uid = create_user("sfx", "pw-sfx-12345")
    upsert_chat(uid, "c1", "t", [{"role": "user", "content": "q"}], 1.0)
    for i in range(45):
        assert finalize_turn_meta(uid, "c1", None, None, False,
                                  user_suffixes={f"{i}:abc": f"R{i}"})
    s = get_chat(uid, "c1")["llm_user_suffixes"]
    assert len(s) == 40 and s["44:abc"] == "R44" and "0:abc" not in s
    legacy.reset_pool()


async def test_la_boucle_emet_le_suffixe_du_rappel(monkeypatch):
    import llm_core._chat_with_tools as W
    events = []

    async def _on(ev):
        events.append(ev)

    monkeypatch.setattr(W, "_todo_status_reminder", lambda u, c: "<todo_status>X</todo_status>")

    async def _fake_stream(messages, tools_payload, **kw):
        assert messages[-1]["content"].endswith("<todo_status>X</todo_status>")
        return {"choices": [{"finish_reason": "stop",
                             "message": {"role": "assistant", "content": "ok"}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 2}}

    async def _anoop(*a, **k):
        return None

    async def _avision(*a, **k):
        return False

    async def _actx(*a, **k):
        return 0

    monkeypatch.setattr(W, "verify_llm_availability", _anoop)
    monkeypatch.setattr(W, "_model_supports_vision", _avision)
    monkeypatch.setattr(_model_info, "get_model_context_size", _actx)
    monkeypatch.setattr(W, "_llama_chat_with_tools_stream", _fake_stream)

    async def _todo(args):
        return {"ok": True}
    await W.run_chat_multi_mcp(
        [{"role": "user", "content": "go"}], [], on_event=_on, username="u",
        chat_id="c-sfx",
        builtin_tools={"todowrite": {"definition": {"type": "function", "function": {
            "name": "todowrite", "parameters": {"type": "object"}}}, "handler": _todo}})
    sfx = [e for e in events if e.get("type") == "llm_user_suffix"]
    assert sfx and sfx[0]["text"] == "<todo_status>X</todo_status>"
