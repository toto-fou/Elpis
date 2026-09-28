# SPDX-License-Identifier: MIT
"""tests/llm_core/test_fs_tools_editeur_2026_09_23.py — audit éditeur
2026-09-23, côté outils fs de l'assistant.

- E18 : le mode existant est conservé (un script 0755 reste exécutable) ;
- E16 : read_file signale line_endings / bom / lossy ; write_file garde BOM
  et CRLF et refuse d'écraser un fichier non UTF-8 ;
- E33 : edit_file sur un fichier à EOL mixtes le dit ;
- E7  : chaque écriture prend le verrou PARTAGÉ avec l'éditeur
  (``shared_infra.sandbox.file_lock.file_write_lock``) ;
- historique de session : write/edit/delete/move notés, jamais un dry_run ;
- E10/E19 : champs ``path`` / ``dry_run`` / ``sha256`` de l'événement UI.
"""
from __future__ import annotations

import json
import os
import stat
import threading
import time

import pytest

import llm_core.tools.fs_tools as F
import shared_infra.sandbox.file_history as H
import shared_infra.sandbox.file_lock as FL

pytestmark = pytest.mark.skipif(os.name != "posix", reason="modes/flock = POSIX")

UID = 4242


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


def _mode(p):
    return stat.S_IMODE(os.stat(p).st_mode)


# ── E18 ───────────────────────────────────────────────────────────────────

def test_write_file_keeps_exec_bit(fs):
    t, w = fs
    f = w / "run.sh"
    f.write_text("#!/bin/sh\necho 1\n")
    os.chmod(f, 0o755)
    r = t["write_file"](None, path="run.sh", content="#!/bin/sh\necho 2\n")
    assert r["ok"], r
    m = _mode(f)
    assert m & 0o111 == 0o111, oct(m)            # toujours exécutable
    assert m & 0o666 == 0o666, oct(m)            # élargi cross-UID


def test_edit_file_keeps_exec_bit(fs):
    t, w = fs
    f = w / "run.sh"
    f.write_text("#!/bin/sh\necho 1\n")
    os.chmod(f, 0o750)
    r = t["edit_file"](None, path="run.sh", action="str_replace",
                       old_str="echo 1", new_str="echo 2")
    assert r["ok"], r
    assert _mode(f) & 0o100
    assert f.read_text() == "#!/bin/sh\necho 2\n"


def test_new_file_is_cross_writable(fs):
    t, w = fs
    r = t["write_file"](None, path="n.txt", content="x\n")
    assert r["ok"], r
    assert _mode(w / "n.txt") == 0o666


# ── E16 : read_file ───────────────────────────────────────────────────────

@pytest.mark.parametrize("data,eol", [
    (b"a\r\nb\r\n", "crlf"),
    (b"a\nb\n", "lf"),
    (b"a\rb\r", "cr"),
    (b"a\r\nb\nc\n", "mixed"),
])
def test_read_file_line_endings(fs, data, eol):
    t, w = fs
    (w / "f.txt").write_bytes(data)
    r = t["read_file"](None, path="f.txt")
    assert r["ok"], r
    assert r["line_endings"] == eol
    assert r["bom"] is False
    assert not r.get("lossy")


def test_read_file_bom(fs):
    t, w = fs
    (w / "b.csv").write_bytes(b"\xef\xbb\xbfa;b\r\n1;2\r\n")
    r = t["read_file"](None, path="b.csv")
    assert r["bom"] is True and r["line_endings"] == "crlf"


def test_read_file_lossy_latin1(fs):
    t, w = fs
    (w / "l.txt").write_bytes("caf\xe9 cr\xe8me\n".encode("latin-1"))
    r = t["read_file"](None, path="l.txt")
    assert r["ok"], r
    assert r["lossy"] is True
    assert "utf-8" not in r["encoding"].lower().split(" ")[0]
    assert "latin-1" in r["encoding_hint"]
    # Relu avec le bon encodage : plus de perte.
    r2 = t["read_file"](None, path="l.txt", encoding="latin-1")
    assert not r2.get("lossy") and "café" in r2["content"]


# ── E16 : write_file ──────────────────────────────────────────────────────

def test_write_file_keeps_bom_and_crlf(fs):
    t, w = fs
    f = w / "d.csv"
    f.write_bytes(b"\xef\xbb\xbfa;b\r\n1;2\r\n")
    r = t["write_file"](None, path="d.csv", content="a;b\n3;4\n")
    assert r["ok"], r
    assert f.read_bytes() == b"\xef\xbb\xbfa;b\r\n3;4\r\n"
    assert r["bom"] is True and r["line_endings"] == "crlf"
    assert r["new_sha256"] == F._sha256_bytes(f.read_bytes())


def test_write_file_lf_file_stays_lf(fs):
    t, w = fs
    f = w / "u.txt"
    f.write_bytes(b"a\nb\n")
    r = t["write_file"](None, path="u.txt", content="c\nd\n")
    assert r["ok"] and f.read_bytes() == b"c\nd\n"
    assert "line_endings" not in r and "bom" not in r


def test_write_file_refuses_latin1_overwrite(fs):
    t, w = fs
    f = w / "l.txt"
    orig = "caf\xe9\n".encode("latin-1")
    f.write_bytes(orig)
    r = t["write_file"](None, path="l.txt", content="café\n")
    assert r["ok"] is False
    assert "encoding" in json.dumps(r)
    assert f.read_bytes() == orig                 # rien écrit
    # Encodage explicite : accepté, et le fichier reste en latin-1.
    r2 = t["write_file"](None, path="l.txt", content="thé\n", encoding="latin-1")
    assert r2["ok"], r2
    assert f.read_bytes() == "thé\n".encode("latin-1")


# ── E33 ───────────────────────────────────────────────────────────────────

def test_edit_file_mixed_eol_says_normalized(fs):
    t, w = fs
    f = w / "m.txt"
    f.write_bytes(b"a\r\nb\nc\n")
    r = t["edit_file"](None, path="m.txt", action="str_replace", old_str="b", new_str="B")
    assert r["ok"], r
    assert r["normalized_line_endings"] is True
    assert r["line_endings"] == "lf"
    assert "normalized to LF" in r["note"]
    assert f.read_bytes() == b"a\nB\nc\n"


def test_edit_file_pure_crlf_not_flagged(fs):
    t, w = fs
    f = w / "c.txt"
    f.write_bytes(b"a\r\nb\r\n")
    r = t["edit_file"](None, path="c.txt", action="str_replace", old_str="b", new_str="B")
    assert r["ok"] and r["line_endings"] == "crlf"
    assert "normalized_line_endings" not in r
    assert f.read_bytes() == b"a\r\nB\r\n"


# ── Historique de session ─────────────────────────────────────────────────

def _entry(rel):
    return H.file_entry(UID, rel)


def test_history_write_edit_delete(fs):
    t, w = fs
    (w / "h.txt").write_text("v0\n")
    assert t["write_file"](None, path="h.txt", content="v1\n")["ok"]
    assert t["edit_file"](None, path="h.txt", action="str_replace",
                          old_str="v1", new_str="v2")["ok"]
    e = _entry("h.txt")
    assert e["original"]["exists"] is True
    assert H.get_blob(UID, e["original"]["sha"]) == b"v0\n"
    assert [H.get_blob(UID, v["sha"]) for v in e["versions"]] == [b"v1\n", b"v2\n"]
    assert all(v["source"] == "assistant" for v in e["versions"])
    assert t["manage_files"](None, action="delete", path="h.txt")["ok"]
    e = _entry("h.txt")
    assert e["versions"][-1]["exists"] is False


def test_history_new_file_and_b64(fs):
    t, w = fs
    import base64
    assert t["write_file"](None, path="d/n.bin", mode="b64",
                           b64=base64.b64encode(b"\x00\x01").decode())["ok"]
    e = _entry("d/n.bin")
    assert e["original"]["exists"] is False
    assert H.get_blob(UID, e["versions"][-1]["sha"]) == b"\x00\x01"


def test_history_move(fs):
    t, w = fs
    (w / "a.txt").write_text("x\n")
    assert t["write_file"](None, path="a.txt", content="y\n")["ok"]
    assert t["manage_files"](None, action="move", path="a.txt", dest="b.txt")["ok"]
    assert _entry("a.txt") is None
    e = _entry("b.txt")
    assert e and e.get("moved_from") == "a.txt"


def test_history_not_recorded_for_dry_run(fs):
    t, w = fs
    (w / "k.txt").write_text("k0\n")
    assert t["write_file"](None, path="k.txt", content="k1\n", dry_run=True)["ok"]
    assert t["edit_file"](None, path="k.txt", action="str_replace",
                          old_str="k0", new_str="k2", dry_run=True)["ok"]
    assert t["manage_files"](None, action="delete", path="k.txt", dry_run=True)["ok"]
    assert (w / "k.txt").read_text() == "k0\n"
    assert _entry("k.txt") is None


def test_history_skipped_without_uid(fs, monkeypatch):
    t, w = fs
    monkeypatch.setattr(F, "_history_uid", lambda username: None)
    assert t["write_file"](None, path="z.txt", content="z\n")["ok"]
    assert _entry("z.txt") is None


# ── E7 : verrou partagé avec l'éditeur ────────────────────────────────────

def test_agent_writes_take_shared_file_lock(fs, monkeypatch):
    t, w = fs
    (w / "s.txt").write_text("s0\n")
    seen = []
    real = FL.file_write_lock

    def spy(path, timeout_s=3.0):
        seen.append(str(path))
        return real(path, timeout_s=timeout_s)
    monkeypatch.setattr(FL, "file_write_lock", spy)
    target = os.path.realpath(w / "s.txt")
    assert t["write_file"](None, path="s.txt", content="s1\n")["ok"]
    assert t["write_file"](None, path="s.txt", content="more\n", mode="append")["ok"]
    assert t["edit_file"](None, path="s.txt", action="str_replace",
                          old_str="s1", new_str="s2")["ok"]
    assert t["manage_files"](None, action="delete", path="s.txt")["ok"]
    assert seen.count(target) == 4, seen


def test_agent_write_waits_for_editor_lock(fs):
    """L'éditeur tient le verrou : l'écriture de l'agent attend sa libération."""
    t, w = fs
    f = w / "e.txt"
    f.write_text("e0\n")
    released = threading.Event()

    def editor():
        with FL.file_write_lock(os.path.realpath(f)) as got:
            assert got
            time.sleep(0.4)
            f.write_text("editor\n")
            released.set()
    th = threading.Thread(target=editor)
    th.start()
    time.sleep(0.05)
    r = t["write_file"](None, path="e.txt", content="agent\n")
    th.join()
    assert released.is_set()
    assert r["ok"], r
    assert f.read_text() == "agent\n"          # écrite APRÈS l'éditeur


def test_edit_refused_when_file_changed_under_it(fs, monkeypatch):
    """Un enregistrement de l'éditeur tombé entre la lecture et l'écriture
    d'edit_file n'est plus écrasé : refus ``concurrent_modification``."""
    t, w = fs
    f = w / "c.txt"
    f.write_text("base\n")
    real = F._guarded_write

    def racy(p, expected, fn, **kw):
        f.write_text("editor save\n")            # l'éditeur passe entre-temps
        return real(p, expected, fn, **kw)
    monkeypatch.setattr(F, "_guarded_write", racy)
    r = t["edit_file"](None, path="c.txt", action="str_replace",
                       old_str="base", new_str="agent")
    assert r["ok"] is False and "concurrent_modification" in json.dumps(r)
    assert f.read_text() == "editor save\n"


# ── E10 / E19 : champs de l'événement UI ──────────────────────────────────

def test_event_extra_git_write_path_is_sandbox_relative():
    from llm_core._chat_with_tools import _write_event_extra
    ex = _write_event_extra("git_write", {"repo": "proj", "path": "src/a.py"},
                            json.dumps({"ok": True, "path": "src/a.py"}))
    assert ex["path"] == "proj/src/a.py"
    ex = _write_event_extra("elpis-git_git_write", {"repo": "/work/p/", "path": "./b.py"}, "{}")
    assert ex["path"] == "p/b.py"


def test_event_extra_dry_run_and_sha():
    from llm_core._chat_with_tools import _write_event_extra
    sha = "a" * 64
    ex = _write_event_extra("edit_file", {"path": "x.py", "dry_run": True},
                            json.dumps({"ok": True, "new_sha256": sha}))
    assert ex == {"path": "x.py", "dry_run": True}
    ex = _write_event_extra("write_file", {"path": "x.py"},
                            json.dumps({"ok": True, "new_sha256": "b" * 64,
                                        "next_expected_sha256": sha}))
    assert ex == {"path": "x.py", "sha256": sha}
    ex = _write_event_extra("write_file", {"path": "x.py"},
                            json.dumps({"ok": False, "error": "hash_mismatch"}))
    assert ex == {"path": "x.py"}
    assert _write_event_extra("read_file", {"path": "x.py"}, "{}") == {}
