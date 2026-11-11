# SPDX-License-Identifier: MIT
# tests/rag_app/test_extracteur_ocr.py — OCR des pages sans texte via le client de vision existant (simulé).
from __future__ import annotations

import io
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from rag_app import app as A
from rag_app.ocr import client as ocr_client

from . import _extracteur_docs as docs

ENTETE = {"Authorization": "Bearer jeton-test"}
SERVICE = {"url": "http://ocr.test:1", "model": "vision", "max_side_px": 800}
GROUNDING = ("<|ref|>Titre scanné<|/ref|><|det|>[[100, 100, 600, 160]]<|/det|>\n\n"
             "Paragraphe lu par OCR, page {n}.\n")


@pytest.fixture
def client():
    return TestClient(A.app, client=("127.0.0.1", 50000))


@pytest.fixture
def ocr(monkeypatch):
    """Serveur OCR simulé : un modèle fixé, aucune connexion réseau."""
    appels: list[Image.Image] = []

    async def faux_stream(png, *, cfg, prompt=None, on_delta=None):
        appels.append(Image.open(io.BytesIO(png)))
        return GROUNDING.format(n=len(appels))

    monkeypatch.setattr(ocr_client, "stream_ocr", faux_stream)
    return appels


def _extraire(client, nom, **corps):
    if corps.get("ocr") and "ocr_service" not in corps:
        corps["ocr_service"] = SERVICE
    corps = {k: v for k, v in corps.items() if v is not None}
    rep = client.post("/api/extract", json={"source": f"sources/{nom}", "ext": ".pdf", **corps}, headers=ENTETE)
    assert rep.status_code == 200, rep.text
    lignes = [json.loads(ligne) for ligne in rep.text.splitlines()]
    return lignes[-1], lignes[:-1]


def test_ocr_lit_les_pages_sans_texte_avec_progression_et_boites_en_points(client, magasin_rag, ocr):
    docs.pdf_scan_ocr(magasin_rag / "sources" / "scan.pdf")
    final, progres = _extraire(client, "scan.pdf", ocr=True)
    assert final["type"] == "result", final
    assert final["meta"]["text_layer"] is False and final["meta"]["pages"] == 2
    assert [(b["page"], b["text"]) for b in final["blocks"]] == [
        (1, "Titre scanné"), (1, "Paragraphe lu par OCR, page 1."), (2, "Titre scanné"), (2, "Paragraphe lu par OCR, page 2.")]
    x0, y0, x1, y1 = final["blocks"][0]["boxes"][0]
    assert abs(x0 - 59.5) < 2.5 and abs(y0 - 84.2) < 2.5 and abs(x1 - 357.2) < 2.5 and abs(y1 - 134.7) < 2.5
    assert "boxes" not in final["blocks"][1]
    assert [(p["done"], p["total"]) for p in progres][-2:] == [(1, 2), (2, 2)]
    assert len(ocr) == 2 and all(max(image.size) <= 800 for image in ocr)


def test_ocr_ne_traite_que_les_pages_vides_d_un_pdf_mixte(client, magasin_rag, ocr):
    docs.pdf_mixte(magasin_rag / "sources" / "mixte.pdf")
    final, _ = _extraire(client, "mixte.pdf", ocr=True)
    assert [b["page"] for b in final["blocks"]] == [1, 2, 2]
    assert final["blocks"][0]["text"] == "Page de texte natif lisible sans OCR."
    assert len(ocr) == 1 and final["meta"]["text_layer"] is True


def test_pdf_mixte_sans_ocr_signale_les_pages_vides(client, magasin_rag):
    docs.pdf_mixte(magasin_rag / "sources" / "mixte.pdf")
    final, _ = _extraire(client, "mixte.pdf")
    assert final["type"] == "result" and [b["page"] for b in final["blocks"]] == [1]
    assert final["warnings"] == [{"code": "empty_pages", "message": "1 page(s) sans texte.", "pages": [2]}]


def test_ocr_demande_mais_non_configure(client, magasin_rag):
    docs.pdf_scan_ocr(magasin_rag / "sources" / "scan.pdf")
    docs.pdf_simple(magasin_rag / "sources" / "texte.pdf")
    final, _ = _extraire(client, "scan.pdf", ocr=True, ocr_service=None)
    assert final["type"] == "error" and final["code"] == "ocr_unavailable"
    # Un PDF qui a déjà du texte n'a pas besoin de l'OCR : pas d'erreur.
    assert _extraire(client, "texte.pdf", ocr=True, ocr_service=None)[0]["type"] == "result"
    # Texte partiel sans OCR disponible : le texte natif est rendu, les pages vides sont signalées.
    docs.pdf_mixte(magasin_rag / "sources" / "mixte.pdf")
    final, _ = _extraire(client, "mixte.pdf", ocr=True, ocr_service=None)
    assert final["type"] == "result" and [b["page"] for b in final["blocks"]] == [1]
    assert final["warnings"][0]["code"] == "ocr_unavailable" and final["warnings"][0]["pages"] == [2]


def test_ocr_serveur_en_panne_ou_page_tronquee(client, magasin_rag, ocr, monkeypatch):
    docs.pdf_scan_ocr(magasin_rag / "sources" / "scan.pdf")

    async def en_panne(png, *, cfg, prompt=None, on_delta=None):
        raise ocr_client.OcrError("Serveur OCR injoignable (ConnectError).")

    async def tronque(png, *, cfg, prompt=None, on_delta=None):
        raise ocr_client.OcrTruncated("coupé", "Texte partiel")

    monkeypatch.setattr(ocr_client, "stream_ocr", en_panne)
    final, _ = _extraire(client, "scan.pdf", ocr=True)
    assert final["type"] == "error" and final["code"] == "ocr_unavailable" and "injoignable" in final["message"]
    monkeypatch.setattr(ocr_client, "stream_ocr", tronque)
    final, _ = _extraire(client, "scan.pdf", ocr=True)
    assert final["type"] == "result" and [w["code"] for w in final["warnings"]] == ["ocr_truncated", "ocr_truncated"]
    assert final["blocks"][0]["text"] == "Texte partiel"


def test_sante_dit_que_l_ocr_est_pris_en_charge(client, magasin_rag):
    assert client.get("/api/health").json()["ocr"] is True


def test_reglages_du_core_transmis_au_client_de_vision(client, magasin_rag, monkeypatch):
    recus = []

    async def faux_stream(png, *, cfg, prompt=None, on_delta=None):
        recus.append(dict(cfg))
        return "Texte lu."

    monkeypatch.setattr(ocr_client, "stream_ocr", faux_stream)
    docs.pdf_scan_ocr(magasin_rag / "sources" / "scan.pdf")
    service = {"url": "https://vision.lan/", "model": "deepseek-ocr", "api_key": "cle-ocr", "timeout_s": 42,
               "max_side_px": 1024, "max_tokens": 4096}
    final, _ = _extraire(client, "scan.pdf", ocr=True, ocr_service=service)
    assert final["type"] == "result" and len(recus) == 2
    cfg = recus[0]
    assert cfg["endpoint_url"] == "https://vision.lan" and cfg["model"] == "deepseek-ocr" and cfg["api_key"] == "cle-ocr"
    assert cfg["timeout_sec"] == 42 and cfg["max_tokens"] == 4096 and cfg["max_side_px"] == 1024


@pytest.mark.parametrize("service", [{"url": "file:///etc/passwd"}, {"url": "http://a b"}, {"url": ""},
                                     {"url": "http://ocr.test:1", "timeout_s": 0},
                                     {"url": "http://ocr.test:1", "max_side_px": 99999}])
def test_service_ocr_invalide_refuse_sans_echo_de_la_valeur(client, magasin_rag, service):
    docs.pdf_scan_ocr(magasin_rag / "sources" / "scan.pdf")
    rep = client.post("/api/extract", json={"source": "sources/scan.pdf", "ext": ".pdf", "ocr": True,
                                            "ocr_service": {**service, "api_key": "cle-secrete"}}, headers=ENTETE)
    assert rep.status_code == 422 and "cle-secrete" not in rep.text
