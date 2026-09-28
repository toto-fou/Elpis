# SPDX-License-Identifier: MIT
"""tests/llm_core/test_diffs_outils_2026_09_26.py — audit « un diff dans tous
les cas » (2026-09-26), côté serveur.

- historique : une modification faite HORS historique entre deux écritures
  devient une version « other » (le blob « avant » existe toujours) ;
- relevé des commandes (``_work_changes``) : créé / modifié / supprimé, avant
  relu du cache, jamais à travers un lien, noté dans l'historique ;
- ``manage_files`` : ``files_changed`` pour suppression, copie de dossier,
  déplacement ;
- (côté chat : test_diffs_chat_2026_09_26.py).
"""
from __future__ import annotations

import hashlib
import os
import time

import pytest

import llm_core.tools.fs_tools as F
import shared_infra.sandbox.file_history as H
from llm_core.tools import _work_changes as WC

pytestmark = pytest.mark.skipif(os.name != "posix", reason="POSIX")

UID = 4343


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


@pytest.fixture()
def hist(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_FILE_HISTORY_DIR", str(tmp_path / "_hist"))
    H.start_session(UID)
    return tmp_path


# ── Historique ───────────────────────────────────────────────────────────────

def test_modification_externe_gardee_comme_version(hist):
    H.record_write(UID, "a.py", b"v0", b"v1", "assistant")
    # « sed -i » entre deux écritures : l'avant de la 2e n'est pas v1.
    H.record_write(UID, "a.py", b"v1-shell", b"v2", "assistant")
    ent = H.file_entry(UID, "a.py")
    srcs = [(v["sha"], v["source"]) for v in ent["versions"]]
    assert srcs == [(_sha(b"v1"), "assistant"), (_sha(b"v1-shell"), "other"),
                    (_sha(b"v2"), "assistant")]
    assert H.get_blob(UID, _sha(b"v1-shell")) == b"v1-shell"


def test_avant_inconnu_marque(hist):
    H.record_write(UID, "b.txt", H.UNKNOWN, b"x", "shell")
    ent = H.file_entry(UID, "b.txt")
    assert ent["original"].get("unknown") and ent["original"]["sha"] is None
    assert H.sha_of(H.UNKNOWN) is None and H.sha_of(None) is None
    assert H.sha_of(b"x") == _sha(b"x")


# ── Relevé des commandes ─────────────────────────────────────────────────────

def test_releve_cree_modifie_supprime(hist):
    root = hist / "work"
    (root / "src").mkdir(parents=True)
    (root / "src" / "m.py").write_bytes(b"a\nb\n")
    (root / "old.txt").write_bytes(b"bye\n")
    (root / "node_modules").mkdir()
    with WC.WorkChanges(UID, "u", root, "shell") as wc:
        (root / "src" / "m.py").write_bytes(b"a\nB\nc\n")
        (root / "old.txt").unlink()
        (root / "new.txt").write_bytes(b"hi\n")
        (root / "node_modules" / "x.js").write_bytes(b"ignored")
    by = {e["path"]: e for e in wc.changes}
    assert set(by) == {"/work/src/m.py", "/work/old.txt", "/work/new.txt"}
    m = by["/work/src/m.py"]
    assert m["change"] == "modified" and m["old_sha256"] == _sha(b"a\nb\n")
    assert (m["lines_added"], m["lines_removed"]) == (2, 1)
    assert by["/work/old.txt"]["change"] == "deleted"
    assert by["/work/new.txt"]["change"] == "created" and by["/work/new.txt"]["old_sha256"] is None
    # L'historique garde avant ET après : le chat peut relire les deux.
    assert H.get_blob(UID, _sha(b"a\nb\n")) == b"a\nb\n"
    assert H.get_blob(UID, _sha(b"a\nB\nc\n")) == b"a\nB\nc\n"
    assert H.file_entry(UID, "src/m.py")["versions"][-1]["source"] == "shell"


def test_releve_contenu_identique_ignore(hist):
    root = hist / "w2"
    root.mkdir()
    f = root / "t.txt"
    f.write_bytes(b"same")
    with WC.WorkChanges(UID, "u2", root) as wc:
        os.utime(f, ns=(1, 1))                        # touché, pas modifié
    assert wc.changes == []


def test_releve_ne_suit_pas_un_lien(hist, tmp_path):
    root = hist / "w3"
    root.mkdir()
    secret = tmp_path / "secret.txt"
    secret.write_bytes(b"host secret")
    (root / "d").mkdir()
    (root / "d" / "f.txt").write_bytes(b"x")
    with WC.WorkChanges(UID, "u3", root) as wc:
        # Le « conteneur » remplace le dossier par un lien vers l'hôte.
        (root / "d" / "f.txt").unlink()
        (root / "d").rmdir()
        os.symlink(tmp_path, root / "d")
    assert all("secret" not in e["path"] for e in wc.changes)
    assert H.get_blob(UID, _sha(b"host secret")) is None


def test_avant_inconnu_si_non_releve(hist, monkeypatch):
    root = hist / "w4"
    root.mkdir()
    (root / "gros.txt").write_bytes(b"0" * 100)
    monkeypatch.setattr(WC, "KEEP_FILE_MAX", 10)      # trop gros pour être gardé
    with WC.WorkChanges(UID, "u4", root) as wc:
        time.sleep(0.05)          # horodatage du noyau à gros grain (même taille)
        (root / "gros.txt").write_bytes(b"1" * 100)
    (e,) = wc.changes
    assert e["change"] == "modified" and e["old_sha256"] is None
    assert e["new_sha256"] == _sha(b"1" * 100)


# ── manage_files ─────────────────────────────────────────────────────────────

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
    monkeypatch.setenv("APP_SANDBOX_DIR", str(tmp_path))
    monkeypatch.setenv("APP_FILE_HISTORY_DIR", str(tmp_path / "_hist"))
    monkeypatch.setattr(F, "_history_uid", lambda username: UID)
    monkeypatch.setattr(F, "use_agent", lambda *_a, **_k: False)
    mcp = _FakeMCP()
    F.register(mcp, tmp_path)
    work = tmp_path / "guest" / "work"
    work.mkdir(parents=True, exist_ok=True)
    return mcp.tools, work


def test_manage_files_decrit_les_fichiers(fs):
    t, w = fs
    (w / "d").mkdir()
    (w / "d" / "a.txt").write_bytes(b"A")
    r = t["manage_files"](None, action="copy", path="d", dest="e")
    assert r["ok"], r
    assert {(e["path"], e["change"]) for e in r["files_changed"]} == {("/work/e/a.txt", "created")}
    r = t["manage_files"](None, action="move", path="e/a.txt", dest="f.txt")
    assert r["files_changed"] == [{"path": "/work/f.txt", "change": "moved", "from": "/work/e/a.txt"}]
    r = t["manage_files"](None, action="delete", path="d", recursive=True)
    (e,) = r["files_changed"]
    assert e["change"] == "deleted" and e["old_sha256"] == _sha(b"A")
    assert H.get_blob(UID, _sha(b"A")) == b"A"
