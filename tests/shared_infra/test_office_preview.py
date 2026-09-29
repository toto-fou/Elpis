# SPDX-License-Identifier: MIT
"""Logique des aperçus Office / PDF de l'éditeur (sans LibreOffice).

Couvre l'ouverture SÛRE de la source (liens, FIFO, traversée, taille), la clé
de cache, le snapshot par descripteur, les contrôles OOXML (bombe, type,
chiffré), la grille CSV → morceaux, la publication et l'élagage.
Cf. docs/editor-office-preview-design-2026-09-15.md
"""
from __future__ import annotations

import json
import os
import time
import zipfile
from pathlib import Path

import pytest

from shared_infra.sandbox import office_convert as oc, office_preview as op
from shared_infra.sandbox.office_convert import OfficeError

CT = {
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
}


def make_ooxml(path: Path, kind: str, extra: dict | None = None, content_types: str | None = None) -> Path:
    types = content_types if content_types is not None else (
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        f'<Override PartName="/main.xml" ContentType="{CT[kind]}"/></Types>')
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", types)
        for name, data in (extra or {}).items():
            zf.writestr(name, data)
    return path


def mini_xlsx(path: Path, feuilles, *, date1904: bool = False, styles: str | None = None) -> Path:
    """Classeur .xlsx minimal mais RÉEL (relations, chaînes partagées, styles).

    ``feuilles`` : liste de ``(nom, lignes, options)``. ``lignes`` est soit une
    liste de listes de textes, soit — avec ``options["raw"]`` — une liste de
    ``(numéro, [(colonne, type, valeur)])`` pour poser des trous et des styles.
    """
    sst: list = []

    def si(txt: str) -> int:
        if txt not in sst:
            sst.append(txt)
        return sst.index(txt)

    parts: dict = {}
    noms = []
    for i, (nom, lignes, opts) in enumerate(feuilles, start=1):
        corps = []
        if opts.get("raw"):
            for numero, cells in lignes:
                out = []
                for col, typ, val in cells:
                    if typ == "s":
                        out.append(f'<c r="{col}{numero}" t="s"><v>{si(val)}</v></c>')
                    elif typ == "inline":
                        out.append(f'<c r="{col}{numero}" t="inlineStr"><is><t>{val}</t></is></c>')
                    else:
                        style = f' s="{typ}"' if isinstance(typ, int) else ""
                        out.append(f'<c r="{col}{numero}"{style}><v>{val}</v></c>')
                corps.append(f'<row r="{numero}">' + "".join(out) + "</row>")
        else:
            for n, row in enumerate(lignes, start=1):
                cells = "".join(
                    f'<c r="{chr(65 + c)}{n}" t="s"><v>{si(str(v))}</v></c>'
                    for c, v in enumerate(row))
                corps.append(f'<row r="{n}">{cells}</row>')
        dim = f'<dimension ref="{opts["dimension"]}"/>' if opts.get("dimension") else ""
        parts[f"xl/worksheets/sheet{i}.xml"] = (
            '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            + dim + "<sheetData>" + "".join(corps) + "</sheetData></worksheet>")
        etat = ' state="hidden"' if opts.get("hidden") else ""
        noms.append(f'<sheet name="{nom}" sheetId="{i}" r:id="rId{i}"{etat}/>')

    pr = '<workbookPr date1904="1"/>' if date1904 else ""
    parts["xl/workbook.xml"] = (
        '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
        ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + pr + "<sheets>" + "".join(noms) + "</sheets></workbook>")
    parts["xl/_rels/workbook.xml.rels"] = (
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + "".join(f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>'
                  for i in range(1, len(feuilles) + 1))
        + "</Relationships>")
    parts["_rels/.rels"] = (
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rIdW" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
    parts["xl/sharedStrings.xml"] = (
        '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + "".join(f"<si><t>{t}</t></si>" for t in sst) + "</sst>")
    parts["xl/styles.xml"] = styles or (
        '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>'
        '<cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="4"/></cellXfs></styleSheet>')
    return make_ooxml(path, "xlsx", extra=parts)


@pytest.fixture()
def sb(tmp_path):
    root = tmp_path / "alice" / "work"
    (root / "docs").mkdir(parents=True)
    (tmp_path / "secret.docx").write_bytes(b"PK\x03\x04secret")
    return root


# ─────────────────────────────────────────────────────────────────────────────
#  Ouverture de la source
# ─────────────────────────────────────────────────────────────────────────────
def test_open_source_ok_et_chemin_canonique(sb):
    make_ooxml(sb / "docs" / "a.docx", "docx")
    src = op.open_source(sb, "/work/docs/a.docx")
    try:
        assert src.rel == "docs/a.docx" and src.kind == "docx" and src.ext == ".docx"
        assert src.st.st_size == (sb / "docs" / "a.docx").stat().st_size
    finally:
        src.close()


@pytest.mark.parametrize("p", ["../secret.docx", "docs/../../secret.docx", "docs/a\x00.docx", "", "absent.docx"])
def test_open_source_refuse_hors_sandbox_ou_absent(sb, p):
    with pytest.raises(OfficeError) as e:
        op.open_source(sb, p)
    assert e.value.code == "not_found" and e.value.status == 404


def test_open_source_lien_vers_l_exterieur(sb, tmp_path):
    os.symlink(tmp_path / "secret.docx", sb / "docs" / "lien.docx")
    with pytest.raises(OfficeError) as e:
        op.open_source(sb, "docs/lien.docx")
    assert e.value.code == "not_found"


def test_open_source_dossier_intermediaire_lien_sortant(sb, tmp_path):
    outside = tmp_path / "ailleurs"
    outside.mkdir()
    make_ooxml(outside / "b.docx", "docx")
    os.symlink(outside, sb / "evasion")
    with pytest.raises(OfficeError):
        op.open_source(sb, "evasion/b.docx")


def test_open_source_fifo_ne_bloque_pas(sb):
    os.mkfifo(sb / "docs" / "tube.docx")
    t0 = time.monotonic()
    with pytest.raises(OfficeError) as e:
        op.open_source(sb, "docs/tube.docx")
    assert e.value.code == "not_found"
    assert time.monotonic() - t0 < 2


def test_open_source_dossier_et_extension(sb):
    (sb / "docs" / "d.docx").mkdir()
    with pytest.raises(OfficeError) as e:
        op.open_source(sb, "docs/d.docx")
    assert e.value.code == "not_found"
    (sb / "docs" / "x.txt").write_text("x")
    with pytest.raises(OfficeError) as e:
        op.open_source(sb, "docs/x.txt")
    assert e.value.code == "unsupported" and e.value.status == 415


def test_open_source_taille_max(sb, monkeypatch):
    (sb / "docs" / "gros.pdf").write_bytes(b"%PDF-" + b"0" * (2 * 1024 * 1024))
    monkeypatch.setattr(oc, "cfg", lambda k, d=None: {"docx": 1, "pdf": 1} if k == "max_mb" else d)
    with pytest.raises(OfficeError) as e:
        op.open_source(sb, "docs/gros.pdf")
    assert e.value.code == "too_large" and e.value.status == 413


def test_cache_key_change_avec_chaque_composante(sb):
    f = sb / "docs" / "a.pdf"
    f.write_bytes(b"%PDF-1.4 x")
    st = os.stat(f)
    base = op.cache_key(1, "docs/a.pdf", st, "v")
    assert len(base) == 40 and op.KEY_RE.match(base)
    assert op.cache_key(2, "docs/a.pdf", st, "v") != base
    assert op.cache_key(1, "docs/b.pdf", st, "v") != base
    assert op.cache_key(1, "docs/a.pdf", st, "w") != base
    os.utime(f, ns=(st.st_atime_ns, st.st_mtime_ns + 1))
    assert op.cache_key(1, "docs/a.pdf", os.stat(f), "v") != base
    f.write_bytes(b"%PDF-1.4 xy")
    assert op.cache_key(1, "docs/a.pdf", os.stat(f), "v") != base


def test_snapshot_par_descripteur_et_fichier_qui_bouge(sb, tmp_path):
    f = sb / "docs" / "a.pdf"
    f.write_bytes(b"%PDF-1.4 contenu")
    src = op.open_source(sb, "docs/a.pdf")
    try:
        # Le nom est remplacé après l'ouverture : le snapshot lit l'ANCIEN inode.
        os.replace(tmp_path / "secret.docx", f)
        op.snapshot_to(src, tmp_path / "copie.pdf")
        assert (tmp_path / "copie.pdf").read_bytes() == b"%PDF-1.4 contenu"
    finally:
        src.close()
    g = sb / "docs" / "b.pdf"
    g.write_bytes(b"%PDF-1.4 debut")
    src = op.open_source(sb, "docs/b.pdf")
    try:
        with open(g, "ab") as h:
            h.write(b" suite")                    # même inode, taille qui change
        with pytest.raises(OfficeError) as e:
            op.snapshot_to(src, tmp_path / "copie2.pdf")
        assert e.value.code == "changed" and e.value.status == 409
    finally:
        src.close()


# ─────────────────────────────────────────────────────────────────────────────
#  Contrôles de contenu
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("kind", ["docx", "pptx", "xlsx"])
def test_check_ooxml_valide(tmp_path, kind):
    op.check_ooxml(make_ooxml(tmp_path / f"a.{kind}", kind), kind)


def test_check_ooxml_mauvaise_famille(tmp_path):
    p = make_ooxml(tmp_path / "a.docx", "pptx")      # un pptx renommé en .docx
    with pytest.raises(OfficeError) as e:
        op.check_ooxml(p, "docx")
    assert e.value.code == "invalid" and e.value.status == 422


def test_check_ooxml_chiffre_ou_ancien_format(tmp_path):
    p = tmp_path / "a.docx"
    p.write_bytes(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 64)
    with pytest.raises(OfficeError) as e:
        op.check_ooxml(p, "docx")
    assert e.value.code == "encrypted"


@pytest.mark.parametrize("data", [b"<html>pas un zip</html>", b"PK\x03\x04tronque"])
def test_check_ooxml_pas_une_archive(tmp_path, data):
    p = tmp_path / "a.xlsx"
    p.write_bytes(data)
    with pytest.raises(OfficeError) as e:
        op.check_ooxml(p, "xlsx")
    assert e.value.code == "invalid"


def test_check_ooxml_doctype_refuse(tmp_path):
    types = ('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "boom">]>'
             f'<Types><Override ContentType="{CT["docx"]}"/></Types>')
    p = make_ooxml(tmp_path / "a.docx", "docx", content_types=types)
    with pytest.raises(OfficeError):
        op.check_ooxml(p, "docx")


def test_check_ooxml_trop_de_membres(tmp_path, monkeypatch):
    monkeypatch.setattr(op, "ZIP_MAX_MEMBERS", 5)
    p = make_ooxml(tmp_path / "a.docx", "docx", extra={f"f{i}.xml": "x" for i in range(10)})
    with pytest.raises(OfficeError):
        op.check_ooxml(p, "docx")


def test_check_ooxml_bombe_par_ratio(tmp_path, monkeypatch):
    monkeypatch.setattr(op, "ZIP_RATIO_FROM", 1024)
    p = make_ooxml(tmp_path / "a.docx", "docx", extra={"bombe.xml": "0" * 1_000_000})
    with pytest.raises(OfficeError):
        op.check_ooxml(p, "docx")


def test_check_ooxml_nom_de_membre_dangereux(tmp_path):
    p = make_ooxml(tmp_path / "a.docx", "docx", extra={"../evasion.xml": "x"})
    with pytest.raises(OfficeError):
        op.check_ooxml(p, "docx")


def test_check_pdf(tmp_path):
    ok = tmp_path / "a.pdf"
    ok.write_bytes(b"\n\n%PDF-1.7\n")
    op.check_pdf(ok)
    bad = tmp_path / "b.pdf"
    bad.write_bytes(b"<html><script>alert(1)</script></html>")
    with pytest.raises(OfficeError) as e:
        op.check_pdf(bad)
    assert e.value.code == "invalid"


# ─────────────────────────────────────────────────────────────────────────────
#  Grille xlsx : squelette et construction à la demande (lecture en flux)
# ─────────────────────────────────────────────────────────────────────────────
def test_squelette_lit_la_taille_sans_lire_les_lignes(tmp_path):
    """``<dimension>`` vit dans les premiers octets : la grille est dimensionnée
    avant qu'une seule ligne n'ait été lue (c'est ce qui rend l'ouverture d'un
    classeur de 50 Mo instantanée)."""
    p = mini_xlsx(tmp_path / "a.xlsx", [
        ("Un", [["a", "b"], ["c", "d"]], {"dimension": "A1:B2"}),
        ("Caché", [["x"]], {"hidden": True}),
    ])
    grid, sources = op.xlsx_skeleton(p)
    assert [s["name"] for s in grid["sheets"]] == ["Un", "Caché"]
    assert grid["sheets"][0]["rows"] == 2 and grid["sheets"][0]["cols"] == 2
    assert grid["sheets"][1]["hidden"] is True
    assert sources[0]["no_dim"] is False and grid["truncated"] is False


def test_squelette_sans_dimension_compte_les_lignes_par_balayage(tmp_path):
    """Sans ``<dimension>``, la taille est comptée en BALAYANT les octets (une
    fraction du coût d'une lecture) : la grille est dimensionnée juste, tout de
    suite, au lieu d'afficher une feuille tronquée."""
    p = mini_xlsx(tmp_path / "b.xlsx", [("S", [["a"], ["b"], ["c"]], {})])
    grid, sources = op.xlsx_skeleton(p)
    # La taille est connue : pas besoin de lire la feuille à la préparation.
    assert grid["sheets"][0]["rows"] == 3 and sources[0]["no_dim"] is False


def test_squelette_trop_de_feuilles(tmp_path, monkeypatch):
    monkeypatch.setattr(op, "GRID_MAX_SHEETS", 2)
    p = mini_xlsx(tmp_path / "c.xlsx", [(n, [["x"]], {}) for n in ("a", "b", "c")])
    grid, _ = op.xlsx_skeleton(p)
    assert len(grid["sheets"]) == 2 and grid["truncated"] is True


def test_construction_morceaux_numeros_de_document_et_largeurs(tmp_path, monkeypatch):
    """Les lignes gardent leur NUMÉRO de tableur : la ligne 4 est à l'indice 3,
    les lignes absentes restent vides (Excel n'écrit pas les lignes vides)."""
    monkeypatch.setattr(op, "CHUNK_ROWS", 2)
    p = mini_xlsx(tmp_path / "d.xlsx", [("S", [
        (1, [("A", "s", "Nom"), ("C", "s", "Valeur")]),
        (4, [("A", "s", "fin")]),
    ], {"dimension": "A1:C4", "raw": True})])
    grid, sources = op.xlsx_skeleton(p)
    stats = op.build_xlsx_sheet(p, tmp_path / "g", sources[0], 0)
    assert stats["rows"] == 4 and stats["cols"] == 3 and stats["chunks"] == 2
    rows = []
    for i in range(stats["chunks"]):
        rows += json.loads((tmp_path / "g" / "s0" / f"c{i}.json").read_text())
    assert rows == [["Nom", "", "Valeur"], [], [], ["fin"]]
    assert stats["widths"] == [6, 6, 6] and stats["complete"] is True


def test_construction_respecte_les_plafonds(tmp_path, monkeypatch):
    monkeypatch.setattr(op, "GRID_CELL_CHARS", 4)
    monkeypatch.setattr(op, "GRID_MAX_COLS", 2)
    p = mini_xlsx(tmp_path / "e.xlsx", [("S", [["abcdefgh", "b", "c"], ["1", "2", "3"],
                                               ["4", "5", "6"]], {"dimension": "A1:C3"})])
    grid, sources = op.xlsx_skeleton(p)
    stats = op.build_xlsx_sheet(p, tmp_path / "g", sources[0], 0, max_rows=2)
    assert stats["rows"] == 2 and stats["truncated"] is True and stats["cols"] == 2
    assert json.loads((tmp_path / "g" / "s0" / "c0.json").read_text())[0] == ["abcd…", "b"]


def test_construction_bornee_par_le_budget_doctets(tmp_path):
    p = mini_xlsx(tmp_path / "f.xlsx", [("S", [[f"ligne{i}"] for i in range(50)],
                                         {"dimension": "A1:A50"})])
    grid, sources = op.xlsx_skeleton(p)
    stats = op.build_xlsx_sheet(p, tmp_path / "g", sources[0], 0, budget=10)
    assert stats["truncated"] is True and stats["rows"] < 50


# ─────────────────────────────────────────────────────────────────────────────
#  Cache : racine, publication, élagage
# ─────────────────────────────────────────────────────────────────────────────
def test_cache_root_0700_et_refus_si_pas_a_nous(tmp_path, monkeypatch):
    root = tmp_path / "cache"
    monkeypatch.setenv("APP_OFFICE_CACHE_DIR", str(root))
    assert op.cache_root() == root
    assert (root.stat().st_mode & 0o777) == 0o700
    os.chmod(root, 0o777)
    op.cache_root()
    assert (root.stat().st_mode & 0o777) == 0o700                 # droits réparés
    monkeypatch.setattr(op.os, "geteuid", lambda: os.getuid() + 12345)
    with pytest.raises(OfficeError):
        op.cache_root()


def test_publication_puis_ajout_de_vue(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_OFFICE_CACHE_DIR", str(tmp_path / "cache"))
    key = "a" * 40
    d = op.user_cache_dir("alice") / key
    job = op._new_job_dir("alice", key)
    (job / "grid").mkdir()
    manifest = {"v": 1, "key": key, "rel": "x.xlsx", "kind": "xlsx", "size": 1, "mtime": 1.0,
                "grid": {"chunk": 200, "sheets": []}}
    op._publish(job, d, manifest, ["grid"])
    assert op.read_manifest(d)["grid"] and op.pdf_file("alice", key) is None
    job2 = op._new_job_dir("alice", key)
    (job2 / op.PDF_NAME).write_bytes(b"%PDF-1.4")
    m2 = dict(op.read_manifest(d), pages={"count": 1, "truncated": False})
    op._publish(job2, d, m2, [op.PDF_NAME])
    assert op.pdf_file("alice", key) == d / op.PDF_NAME
    payload = op._payload(op.read_manifest(d), "pages")
    assert payload["pages"]["url"] == f"/api/sandbox/office/pdf/{key}/x.pdf"
    assert payload["has"] == {"pages": True, "grid": True} and payload["grid"] is None


def test_key_dir_refuse_une_cle_forgee(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_OFFICE_CACHE_DIR", str(tmp_path / "cache"))
    for bad in ("../" + "a" * 37, "A" * 40, "a" * 39, ""):
        with pytest.raises(OfficeError):
            op.key_dir("alice", bad)
    with pytest.raises(OfficeError):
        op.user_cache_dir("../bob")


def _fake_entry(user_dir: Path, key: str, size: int, used: float) -> Path:
    d = user_dir / key
    d.mkdir(parents=True)
    (d / op.MANIFEST).write_text("{}")
    (d / op.PDF_NAME).write_bytes(b"0" * size)
    os.utime(d / op.MANIFEST, (used, used))
    return d


def test_prune_user_ttl_plafond_verrou_et_tmp(tmp_path, monkeypatch):
    monkeypatch.setattr(oc, "LOCK_DIR", tmp_path / "locks")
    ud = tmp_path / "u" / "alice"
    now = time.time()
    old = _fake_entry(ud, "1" * 40, 10, now - 10 * 86400)          # expiré
    held = _fake_entry(ud, "2" * 40, 10, now - 10 * 86400)         # expiré mais verrouillé
    a = _fake_entry(ud, "3" * 40, 400, now - 300)
    b = _fake_entry(ud, "4" * 40, 400, now - 100)
    tmpd = ud / (".tmp-" + "5" * 40 + "-abcd")
    tmpd.mkdir()
    os.utime(tmpd, (now - 7200, now - 7200))
    fd = oc.try_lock("key-" + "2" * 40)
    try:
        op.prune_user(ud, cap_bytes=500, ttl_s=86400.0, now=now)
    finally:
        oc.release_lock(fd)
    assert not old.exists() and held.exists() and not tmpd.exists()
    assert not a.exists() and b.exists()                            # plafond : le plus ancien part
