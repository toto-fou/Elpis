# SPDX-License-Identifier: MIT
"""Routes HTTP des aperçus Office / PDF (convertisseur factice, sans LibreOffice).

Cf. docs/editor-office-preview-design-2026-09-15.md
"""
from __future__ import annotations

import asyncio
import json
import zipfile
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import shared_infra.sandbox.routes_office as ro
from shared_infra.sandbox import office_convert as oc
from shared_infra.sandbox import office_preview as op

CT_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
CT_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"


def _ooxml(path: Path, ct: str, extra: dict | None = None) -> None:
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("[Content_Types].xml", f'<Types><Override ContentType="{ct}"/></Types>')
        for k, v in (extra or {}).items():
            zf.writestr(k, v)


@pytest.fixture()
def env(tmp_path, monkeypatch):
    root = tmp_path / "users" / "alice" / "work"
    (root / "docs").mkdir(parents=True)
    _ooxml(root / "docs" / "Rapport final.docx", CT_DOCX)
    _ooxml(root / "docs" / "t.xlsx", CT_XLSX, {
        # Sans espace de noms ni relations : le lecteur doit s'en accommoder
        # (des générateurs en produisent), les feuilles suivant leur ordre.
        "xl/workbook.xml": '<workbook><sheets><sheet name="A"/>'
                           '<sheet name="B" state="hidden"/></sheets></workbook>',
        "xl/worksheets/sheet1.xml":
            '<worksheet><dimension ref="A1:B2"/><sheetData>'
            '<row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c>'
            '<c r="B1" t="inlineStr"><is><t>y</t></is></c></row>'
            '<row r="2"><c r="A2"><v>1</v></c><c r="B2"><v>2</v></c></row>'
            '</sheetData></worksheet>',
        "xl/worksheets/sheet2.xml":
            '<worksheet><dimension ref="A1:A1"/><sheetData>'
            '<row r="1"><c r="A1" t="inlineStr"><is><t>secret</t></is></c></row>'
            '</sheetData></worksheet>',
        "_rels/.rels": '<Relationships><Relationship Id="r1" '
                       'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
                       'Target="xl/workbook.xml"/></Relationships>'})
    (root / "docs" / "doc.pdf").write_bytes(b"%PDF-1.7\n1 0 obj<</Type/Page>>endobj\n%%EOF")
    (root / "docs" / "faux.pdf").write_text("<html><script>alert(1)</script></html>")
    (root / "docs" / "note.txt").write_text("x")

    monkeypatch.setenv("APP_OFFICE_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setattr(oc, "LOCK_DIR", tmp_path / "locks")
    state = {"authed": True, "feature": True, "calls": [], "mode": "ok", "delay": 0.0}

    def _auth(request):
        if not state["authed"]:
            raise HTTPException(401, "Authentification requise")
        return 7

    async def _fake_run(argv, env_, *, cwd, log_path, timeout_s):
        state["calls"].append(argv)
        if state["delay"]:
            await asyncio.sleep(state["delay"])
        out = Path(cwd) / "out"
        convert = argv[argv.index("--convert-to") + 1]
        if state["mode"] == "timeout":
            raise oc.OfficeError("timeout", 504, "Conversion trop longue (délai dépassé)")
        if state["mode"] == "nooutput":
            log_path.write_text("Error: source file could not be loaded\n")
            return 0
        assert not convert.startswith("csv:"), "la grille xlsx ne convertit plus rien"
        (out / "in.pdf").write_bytes(b"%PDF-1.7\n" + b"<</Type/Page>>\n" * 3)
        log_path.write_text("convert ok\n")
        return 0

    monkeypatch.setattr(ro, "require_user_id", _auth)
    monkeypatch.setattr(ro, "_get_work_path", lambda uid: root)
    monkeypatch.setattr(ro, "feature_enabled", lambda name, default=True: state["feature"])
    monkeypatch.setattr(oc, "soffice_bin", lambda: "/usr/lib/libreoffice/program/soffice")
    monkeypatch.setattr(oc, "lo_version_token", lambda s: "t")
    monkeypatch.setattr(oc, "isolation_mode", lambda: "bwrap")
    monkeypatch.setattr(oc, "run_soffice", _fake_run)

    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    c = TestClient(app)
    c.state = state
    c.root = root
    return c


def _prep(c, path, view=None):
    body = {"path": path}
    if view:
        body["view"] = view
    return c.post("/api/sandbox/office/prepare", json=body)


def test_docx_prepare_puis_pdf_en_cache(env):
    r = _prep(env, "docs/Rapport final.docx")
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["kind"] == "docx" and d["view"] == "pages" and d["grid"] is None
    assert d["rel"] == "docs/Rapport final.docx" and isinstance(d["mtime"], float)
    assert d["pages"]["count"] == 3 and d["pages"]["truncated"] is False
    url = d["pages"]["url"]
    assert url == f"/api/sandbox/office/pdf/{d['key']}/Rapport%20final.pdf"
    assert len(env.state["calls"]) == 1
    argv = env.state["calls"][0]
    assert "--infilter=MS Word 2007 XML" in argv
    assert any(a.startswith("pdf:writer_pdf_Export:") and "PageRange" in a for a in argv)

    again = _prep(env, "/work/docs/Rapport final.docx")
    assert again.json()["key"] == d["key"] and len(env.state["calls"]) == 1      # cache

    pdf = env.get(url)
    assert pdf.status_code == 200
    assert pdf.headers["content-type"] == "application/pdf"
    assert pdf.headers["x-content-type-options"] == "nosniff"
    assert pdf.headers["x-frame-options"] == "SAMEORIGIN"
    assert pdf.headers["content-security-policy"] == "frame-ancestors 'self'"
    assert "immutable" in pdf.headers["cache-control"]
    assert pdf.headers["content-disposition"].startswith("inline;")
    assert pdf.content.startswith(b"%PDF-")
    part = env.get(url, headers={"Range": "bytes=0-3"})
    assert part.status_code == 206 and part.content == b"%PDF"


def test_modification_du_fichier_change_la_cle(env):
    k1 = _prep(env, "docs/Rapport final.docx").json()["key"]
    p = env.root / "docs" / "Rapport final.docx"
    _ooxml(p, CT_DOCX, {"word/document.xml": "<w/>"})
    k2 = _prep(env, "docs/Rapport final.docx").json()["key"]
    assert k1 != k2 and len(env.state["calls"]) == 2


def test_pdf_natif_sans_conversion_et_faux_pdf_refuse(env):
    r = _prep(env, "docs/doc.pdf")
    assert r.status_code == 200 and env.state["calls"] == []
    assert env.get(r.json()["pages"]["url"]).content.startswith(b"%PDF-1.7")
    bad = _prep(env, "docs/faux.pdf")
    assert bad.status_code == 422 and bad.json()["detail"]["code"] == "invalid"


def test_xlsx_grille_par_defaut_puis_pages_sous_la_meme_cle(env):
    r = _prep(env, "docs/t.xlsx")
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["view"] == "grid" and d["pages"] is None
    # La grille est LUE dans le fichier : aucune conversion n'a été lancée.
    assert env.state["calls"] == []
    sheets = d["grid"]["sheets"]
    assert [(s["name"], s["hidden"], s["rows"], s["cols"]) for s in sheets] == [("A", False, 2, 2), ("B", True, 1, 1)]
    chunk = env.get(f"/api/sandbox/office/sheet/{d['key']}/0/0")
    assert chunk.status_code == 200 and chunk.json() == [["x", "y"], ["1", "2"]]
    assert "immutable" in chunk.headers["cache-control"]
    # Taille réelle annoncée avec le morceau (corrige un ``<dimension>`` absent).
    assert chunk.headers["x-office-rows"] == "2" and chunk.headers["x-office-complete"] == "1"
    assert env.get(f"/api/sandbox/office/sheet/{d['key']}/0/1").json()["detail"]["code"] == "expired"
    # Feuille masquée : lue seulement quand on la demande.
    cachee = env.get(f"/api/sandbox/office/sheet/{d['key']}/1/0")
    assert cachee.status_code == 200 and cachee.json() == [["secret"]]
    p = _prep(env, "docs/t.xlsx", "pages").json()
    assert p["key"] == d["key"] and p["has"] == {"pages": True, "grid": True}
    assert any(a.startswith("pdf:calc_pdf_Export:") for a in env.state["calls"][-1])


def test_cle_invalide_absente_ou_d_un_autre_utilisateur(env, monkeypatch):
    assert env.get("/api/sandbox/office/pdf/abc/x.pdf").status_code == 400
    r = env.get("/api/sandbox/office/pdf/" + "f" * 40 + "/x.pdf")
    assert r.status_code == 404 and r.json()["detail"]["code"] == "expired"
    key = _prep(env, "docs/doc.pdf").json()["key"]
    other_root = env.root.parent.parent / "bob" / "work"
    other_root.mkdir(parents=True)
    monkeypatch.setattr(ro, "_get_work_path", lambda uid: other_root)
    assert env.get(f"/api/sandbox/office/pdf/{key}/doc.pdf").status_code == 404


@pytest.mark.parametrize("path,status,code", [
    ("../../bob/work/x.docx", 404, "not_found"),
    ("docs/absent.docx", 404, "not_found"),
    ("docs/note.txt", 415, "unsupported"),
])
def test_erreurs_de_chemin(env, path, status, code):
    r = _prep(env, path)
    assert r.status_code == status and r.json()["detail"]["code"] == code


def test_requete_invalide(env):
    assert env.post("/api/sandbox/office/prepare", content=b"pas du json").status_code == 400
    assert env.post("/api/sandbox/office/prepare", json={"path": ""}).status_code == 400
    assert env.post("/api/sandbox/office/prepare", json={"path": "a.docx", "view": "html"}).status_code == 400


def test_drapeau_coupe_bloque_office_mais_pas_pdf(env):
    env.state["feature"] = False
    r = _prep(env, "docs/Rapport final.docx")
    assert r.status_code == 403 and r.json()["detail"]["code"] == "disabled"
    assert _prep(env, "docs/doc.pdf").status_code == 200


def test_non_authentifie(env):
    env.state["authed"] = False
    assert _prep(env, "docs/doc.pdf").status_code == 401
    assert env.get("/api/sandbox/office/pdf/" + "a" * 40 + "/x.pdf").status_code == 401


def test_soffice_absent_timeout_et_echec_silencieux(env, monkeypatch):
    monkeypatch.setattr(oc, "soffice_bin", lambda: "")
    r = _prep(env, "docs/Rapport final.docx")
    assert r.status_code == 503 and r.json()["detail"]["code"] == "soffice_missing"
    monkeypatch.setattr(oc, "soffice_bin", lambda: "/usr/lib/libreoffice/program/soffice")
    env.state["mode"] = "timeout"
    assert _prep(env, "docs/Rapport final.docx").json()["detail"]["code"] == "timeout"
    env.state["mode"] = "nooutput"                    # LibreOffice rend 0 sans rien produire
    r = _prep(env, "docs/Rapport final.docx")
    assert r.status_code == 500 and r.json()["detail"]["code"] == "failed"
    cache_user = Path(op.cache_root()) / "u" / "alice"
    assert not [p for p in cache_user.iterdir() if p.name.startswith(".tmp-")]   # dossier de travail nettoyé


def test_conversions_occupees(env, monkeypatch):
    monkeypatch.setattr(oc, "cfg", lambda k, d=None: {"wait_s": 1, "slots": 1, "slots_per_user": 1,
                                                       "timeout_s": 5}.get(k, d))
    held = oc.try_lock("slot-0")
    try:
        r = _prep(env, "docs/Rapport final.docx")
        assert r.status_code == 503 and r.json()["detail"]["code"] == "busy"
    finally:
        oc.release_lock(held)


def test_isolation_indisponible(env, monkeypatch):
    def _no():
        raise oc.OfficeError("isolation_unavailable", 503, "Isolation indisponible sur le serveur (bubblewrap)")
    monkeypatch.setattr(oc, "isolation_mode", _no)
    r = _prep(env, "docs/Rapport final.docx")
    assert r.status_code == 503 and r.json()["detail"]["code"] == "isolation_unavailable"
    assert env.state["calls"] == []


def test_demandes_simultanees_une_seule_conversion(env):
    env.state["delay"] = 0.3
    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)

    async def go():
        import httpx
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as cli:
            rs = await asyncio.gather(*[cli.post("/api/sandbox/office/prepare",
                                                 json={"path": "docs/Rapport final.docx"}) for _ in range(3)])
        return rs
    rs = asyncio.run(go())
    assert [r.status_code for r in rs] == [200, 200, 200]
    assert len({r.json()["key"] for r in rs}) == 1
    assert len(env.state["calls"]) == 1
