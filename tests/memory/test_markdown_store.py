# SPDX-License-Identifier: MIT
"""Tests du MarkdownStore : parsing §, limites, ciblage par id/extrait normalisé,
rewrite, sanitisation du délimiteur, verrou borné, rendu avec ids."""
from __future__ import annotations

import fcntl
import os
from pathlib import Path

import pytest

from llm_core.memory import MarkdownStore, parse_entries
from llm_core.memory._markdown_store import (
    StoreBusyError,
    _resolve_target,
    compute_entry_id,
    entry_ids,
    normalize_for_match,
    sanitize_entry_text,
)


def _store(tmp_path: Path, limit: int = 200) -> MarkdownStore:
    return MarkdownStore(tmp_path / "MEMORY.md", limit, label="MEMORY.md")


# ── Parsing ───────────────────────────────────────────────────────────────────

def test_parse_entries_splits_on_delim():
    raw = "premier\n§\ndeuxieme ligne1\ndeuxieme ligne2\n§\ntroisieme"
    assert parse_entries(raw) == ["premier", "deuxieme ligne1\ndeuxieme ligne2", "troisieme"]


def test_parse_entries_empty():
    assert parse_entries("") == []
    assert parse_entries("   \n  ") == []


# ── add ───────────────────────────────────────────────────────────────────────

def test_add_and_roundtrip(tmp_path):
    s = _store(tmp_path)
    r = s.add("fact A")
    assert r.ok and r.n_entries == 1
    r2 = s.add("fact B")
    assert r2.ok and r2.n_entries == 2
    # Relecture depuis disque
    assert _store(tmp_path).entries() == ["fact A", "fact B"]


def test_add_over_limit_is_rejected(tmp_path):
    s = _store(tmp_path, limit=20)
    assert s.add("123456789012345").ok            # 15 chars, ok
    r = s.add("another entry that is too long")    # dépasse 20
    assert not r.ok
    assert r.error_code == "over_limit"
    assert "limit" in (r.error or "")
    # Rien n'a été écrit : toujours une seule entrée
    assert _store(tmp_path, limit=20).entries() == ["123456789012345"]


def test_add_empty_rejected(tmp_path):
    r = _store(tmp_path).add("   ")
    assert not r.ok and r.error_code == "empty_content"


def test_add_identical_is_idempotent(tmp_path):
    s = _store(tmp_path)
    assert s.add("fact unique").ok
    r = s.add("fact unique")
    assert r.ok and r.n_entries == 1              # pas de doublon (ids ambigus sinon)
    assert _store(tmp_path).entries() == ["fact unique"]


# ── ids ───────────────────────────────────────────────────────────────────────

def test_entry_id_stable_and_hex():
    a = compute_entry_id("user likes python")
    assert a == compute_entry_id("user likes python")          # déterministe
    assert a != compute_entry_id("user likes rust")
    assert len(a) == 4 and all(c in "0123456789abcdef" for c in a)


def test_entry_ids_extend_only_collisions(monkeypatch):
    import llm_core.memory._markdown_store as mod

    def fake(text, length=4):
        return ("coll" if length <= 4 else "coll" + text)[:length]

    monkeypatch.setattr(mod, "compute_entry_id", fake)
    ids = mod.entry_ids(["x", "y"])
    assert ids == ["collx", "colly"]              # allongés jusqu'à unicité
    assert len(set(ids)) == 2


def test_entry_ids_recomputed_after_replace(tmp_path):
    s = _store(tmp_path)
    s.add("alpha entry")
    r = s.replace("alpha", "alpha edited")
    assert r.ok
    assert r.entry_ids == [compute_entry_id("alpha edited")]


# ── normalize_for_match ──────────────────────────────────────────────────────

def test_normalize_casefold_and_whitespace():
    assert normalize_for_match("  Python\n  EST\tSuper  ") == "python est super"


def test_normalize_strips_border_ellipses():
    assert normalize_for_match("…préférences de codage...") == "préférences de codage"
    # ellipse INTERNE conservée
    assert "…" in normalize_for_match("a … b")


def test_normalize_nfc():
    # e + combining acute (NFD) ≡ é (NFC)
    assert normalize_for_match("café") == normalize_for_match("café")


# ── Résolution de cible ──────────────────────────────────────────────────────

def test_resolve_by_bracketed_id():
    entries = ["user likes python", "project uses sqlite"]
    eid = entry_ids(entries)[1]
    r = _resolve_target(entries, f"[{eid}]")
    assert r.index == 1 and r.matched_by == "id"


def test_resolve_bracketed_id_wins_over_stale_text():
    entries = ["user likes python", "project uses sqlite"]
    eid = entry_ids(entries)[0]
    # texte accolé périmé/faux : l'id gagne quand il existe
    r = _resolve_target(entries, f"[{eid}] texte totalement périmé")
    assert r.index == 0 and r.matched_by == "id"


def test_resolve_stale_bracket_falls_back_to_text():
    entries = ["user likes python", "project uses sqlite"]
    r = _resolve_target(entries, "[ffff] uses sqlite")
    assert r.index == 1 and r.matched_by == "substring"


def test_resolve_unknown_bracket_alone_is_no_match():
    entries = ["user likes python"]
    r = _resolve_target(entries, "[ffff]")
    assert r.index is None and not r.candidates and r.closest_index is None


def test_resolve_by_bare_id():
    entries = ["user likes python", "project uses sqlite"]
    eid = entry_ids(entries)[0]
    r = _resolve_target(entries, eid)
    assert r.index == 0 and r.matched_by == "id"


def test_resolve_normalized_substring_case_and_newlines():
    entries = ["Préférences de codage Python :\n- indentation 4 espaces", "autre"]
    r = _resolve_target(entries, "préférences de codage python : - indentation")
    assert r.index == 0 and r.matched_by == "substring"


def test_resolve_ambiguous_lists_candidates():
    entries = ["apple one", "apple two"]
    r = _resolve_target(entries, "apple")
    assert r.index is None and r.candidates == [0, 1]


def test_resolve_no_match_gives_closest():
    entries = ["l'utilisateur préfère des réponses concises et directes", "note courte"]
    # paraphrase partielle : aucune sous-chaîne exacte, mais un long segment commun
    r = _resolve_target(entries, "préfère des réponses concises svp")
    assert r.index is None
    assert r.closest_index == 0 and r.closest_score >= 0.6


def test_resolve_multiline_target_with_delim_no_crash():
    entries = ["fact one", "fact two"]
    r = _resolve_target(entries, "quelque chose\n§\nd'autre")
    assert r.index is None  # no_match propre, pas d'exception


# ── replace / remove ─────────────────────────────────────────────────────────

def test_replace_unique(tmp_path):
    s = _store(tmp_path)
    s.add("user likes python")
    s.add("project uses sqlite")
    r = s.replace("python", "user likes python AND rust")
    assert r.ok
    assert _store(tmp_path).entries() == ["user likes python AND rust", "project uses sqlite"]


def test_replace_by_id(tmp_path):
    s = _store(tmp_path)
    s.add("user likes python")
    s.add("project uses sqlite")
    eid = entry_ids(s.entries())[0]
    r = s.replace(f"[{eid}]", "user likes rust")
    assert r.ok
    assert _store(tmp_path).entries()[0] == "user likes rust"


def test_replace_ambiguous_rejected(tmp_path):
    s = _store(tmp_path)
    s.add("apple one")
    s.add("apple two")
    r = s.replace("apple", "merged")
    assert not r.ok and r.error_code == "ambiguous"
    assert r.candidate_indexes == [0, 1]
    # inchangé
    assert _store(tmp_path).entries() == ["apple one", "apple two"]


def test_replace_no_match_rejected_with_closest(tmp_path):
    s = _store(tmp_path)
    s.add("l'utilisateur préfère des réponses concises")
    r = s.replace("préfère les réponses concises", "x")
    assert not r.ok and r.error_code == "no_match"
    assert r.closest_index == 0


def test_remove_unique(tmp_path):
    s = _store(tmp_path)
    s.add("keep me")
    s.add("delete me")
    r = s.remove("delete")
    assert r.ok
    assert _store(tmp_path).entries() == ["keep me"]


def test_remove_by_id(tmp_path):
    s = _store(tmp_path)
    s.add("keep me")
    s.add("delete me")
    eid = entry_ids(s.entries())[1]
    r = s.remove(eid)                              # id nu, sans crochets
    assert r.ok
    assert _store(tmp_path).entries() == ["keep me"]


def test_remove_ambiguous_rejected(tmp_path):
    s = _store(tmp_path)
    s.add("dog one")
    s.add("dog two")
    r = s.remove("dog")
    assert not r.ok and r.error_code == "ambiguous"


# ── rewrite ──────────────────────────────────────────────────────────────────

def test_rewrite_splits_on_dashes(tmp_path):
    s = _store(tmp_path)
    s.add("old one")
    s.add("old two")
    r = s.rewrite("nouveau fait A\n---\nnouveau fait B\nsur deux lignes\n---\nfait C")
    assert r.ok and r.n_entries == 3
    assert _store(tmp_path).entries() == [
        "nouveau fait A", "nouveau fait B\nsur deux lignes", "fait C"]


def test_rewrite_splits_on_delim_too(tmp_path):
    s = _store(tmp_path)
    r = s.rewrite("un\n§\ndeux")
    assert r.ok and r.n_entries == 2


def test_rewrite_empty_rejected_state_intact(tmp_path):
    s = _store(tmp_path)
    s.add("précieux")
    r = s.rewrite("   \n---\n  ")
    assert not r.ok and r.error_code == "empty_content"
    assert _store(tmp_path).entries() == ["précieux"]


def test_rewrite_over_limit_rejected_state_intact(tmp_path):
    s = _store(tmp_path, limit=20)
    s.add("court")
    r = s.rewrite("x" * 50)
    assert not r.ok and r.error_code == "over_limit"
    assert r.chars == 5                            # stats de l'état COURANT
    assert _store(tmp_path, limit=20).entries() == ["court"]


# ── Sanitisation du délimiteur interne ───────────────────────────────────────

def test_sanitize_entry_text_escapes_bare_delim_line():
    assert sanitize_entry_text("a\n§\nb") == "a\n\\§\nb"
    # § inline (pas seul sur sa ligne) : conservé tel quel
    assert sanitize_entry_text("code § section") == "code § section"


def test_add_with_internal_delim_roundtrips_as_one_entry(tmp_path):
    s = _store(tmp_path)
    r = s.add("ligne 1\n§\nligne 2")
    assert r.ok and r.n_entries == 1
    got = _store(tmp_path).entries()
    assert len(got) == 1 and "ligne 1" in got[0] and "ligne 2" in got[0]


def test_rewrite_sanitizes_internal_delim(tmp_path):
    s = _store(tmp_path)
    r = s.rewrite("un fait\navec \\§ déjà échappé\n---\nautre")
    assert r.ok and r.n_entries == 2


# ── Verrou borné ─────────────────────────────────────────────────────────────

def test_locked_store_raises_store_busy(tmp_path):
    s = MarkdownStore(tmp_path / "MEMORY.md", 200, label="MEMORY.md",
                      lock_timeout_s=0.3)
    s.add("fact")
    lock_path = s.path.with_suffix(s.path.suffix + ".lock")
    fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)             # verrou tenu par un autre fd
        with pytest.raises(StoreBusyError):
            s.add("autre fait")
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)
    # après libération, l'écriture repasse
    assert s.add("autre fait").ok


# ── Rendu ────────────────────────────────────────────────────────────────────

def test_render_block_empty_is_empty(tmp_path):
    assert _store(tmp_path).render_block() == ""


def test_render_block_has_header_usage_and_entries(tmp_path):
    s = _store(tmp_path, limit=100)
    s.add("alpha")
    s.add("beta")
    block = _store(tmp_path, limit=100).render_block()
    assert "MEMORY.md" in block
    assert "chars" in block and "%" in block
    assert "alpha" in block and "beta" in block
    assert "§" in block


def test_render_block_prefixes_ids_on_first_line_only(tmp_path):
    s = _store(tmp_path, limit=200)
    s.add("ligne un\nligne deux")
    block = _store(tmp_path, limit=200).render_block()
    eid = entry_ids(["ligne un\nligne deux"])[0]
    assert f"[{eid}] ligne un" in block
    # la 2e ligne de l'entrée n'est PAS préfixée
    assert "\nligne deux" in block and f"[{eid}] ligne deux" not in block


def test_render_block_header_template_override(tmp_path, monkeypatch):
    import llm_core.context_config as ctx_mod
    monkeypatch.setattr(
        ctx_mod.CTX, "override",
        lambda path, fallback="": "## {label}" if path == "memory.header_template" else fallback)
    s = _store(tmp_path, limit=100)
    s.add("alpha")
    block = _store(tmp_path, limit=100).render_block()
    assert block.splitlines()[0] == "## MEMORY.md"  # télémétrie retirée
    assert "alpha" in block


def test_usage_pct(tmp_path):
    s = _store(tmp_path, limit=10)
    s.add("12345")  # 5 chars
    assert _store(tmp_path, limit=10).usage_pct() == 50.0


# ── Fichier illisible : la mutation AVORTE (jamais d'écrasement) ───────────────

def test_add_sur_fichier_illisible_avorte_sans_ecraser(tmp_path):
    """Régression perte de données : un fichier non-UTF8 (corruption / I/O)
    faisait retourner ``entries()`` = [] → le prochain add écrivait [nouveau]
    et écrasait TOUT en silence (ok=True). Désormais add AVORTE (read_failed)
    et les octets existants sont préservés."""
    s = _store(tmp_path, limit=100_000)
    s.add("fait un")
    s.add("fait deux")
    p = tmp_path / "MEMORY.md"
    p.write_bytes(p.read_bytes() + b"\n## \xff\xfe binaire\n")   # non-UTF8

    disk_before = p.read_bytes()
    r = s.add("nouveau fait")
    assert r.ok is False and r.error_code == "read_failed"
    assert p.read_bytes() == disk_before          # AUCUNE écriture
    assert b"nouveau fait" not in p.read_bytes()


def test_replace_remove_sur_fichier_illisible_avortent(tmp_path):
    s = _store(tmp_path, limit=100_000)
    s.add("fait un")
    p = tmp_path / "MEMORY.md"
    p.write_bytes(p.read_bytes() + b"\n## \xff\xfe\n")
    before = p.read_bytes()
    assert s.replace("fait un", "x").error_code == "read_failed"
    assert s.remove("fait un").error_code == "read_failed"
    assert p.read_bytes() == before               # rien touché


def test_rewrite_repare_un_store_corrompu(tmp_path):
    """rewrite REMPLACE tout par le contenu fourni → chemin de récupération :
    il DOIT réussir même sur un fichier illisible (ne pas le bloquer)."""
    s = _store(tmp_path, limit=100_000)
    s.add("ancien")
    p = tmp_path / "MEMORY.md"
    p.write_bytes(p.read_bytes() + b"\n## \xff\xfe\n")
    r = s.rewrite("repare A\n---\nrepare B")
    assert r.ok is True and r.n_entries == 2
    assert [e for e in _store(tmp_path, limit=100_000).entries()] == ["repare A", "repare B"]


def test_add_sur_fichier_absent_reste_legitime(tmp_path):
    """Fichier ABSENT ≠ illisible : c'est un store vide légitime, add réussit."""
    s = _store(tmp_path, limit=100_000)
    r = s.add("premier fait")
    assert r.ok is True and r.n_entries == 1
