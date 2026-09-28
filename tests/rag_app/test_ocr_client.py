# SPDX-License-Identifier: MIT
"""tests/rag_app/test_ocr_client.py — parseur grounding + sanitizer live.

Pur (aucun réseau) : le format grounding de la famille DeepSeek-OCR /
Unlimited-OCR (``<|ref|>…<|/ref|><|det|>[[x1,y1,x2,y2]]<|/det|>``, coordonnées
0-1000) doit produire des boxes en pixels page et un Markdown nettoyé, y
compris en émission INCRÉMENTALE (le live ne doit jamais afficher un tag
partiel, ni retenir indéfiniment un « <| » littéral).
"""
from __future__ import annotations

import pytest

from rag_app.ocr import client


# ─────────────────────────────────────────────────────────────────────────────
#  parse_grounding
# ─────────────────────────────────────────────────────────────────────────────
def test_parse_grounding_basic():
    raw = "# Titre\n<|ref|>Tableau 1<|/ref|><|det|>[[100, 200, 500, 400]]<|/det|>\nsuite"
    md, boxes = client.parse_grounding(raw, 1000, 2000)
    assert md == "# Titre\nTableau 1\nsuite"
    assert boxes == [{"text": "Tableau 1", "box": [100, 400, 500, 800]}]


def test_parse_grounding_multi_boxes_et_jetons_isoles():
    raw = ("<|grounding|>Avant <|ref|>x<|/ref|><|det|>[[0,0,1000,1000],"
           "[500,500,600,600]]<|/det|> après <|det|>")
    md, boxes = client.parse_grounding(raw, 100, 100)
    assert md == "Avant x après"
    assert [b["box"] for b in boxes] == [[0, 0, 100, 100], [50, 50, 60, 60]]


def test_parse_grounding_det_illisible_garde_le_texte():
    raw = "a <|ref|>label<|/ref|><|det|>pas du json<|/det|> b"
    md, boxes = client.parse_grounding(raw, 100, 100)
    assert md == "a label b"
    assert boxes == []


def test_parse_grounding_sans_tags():
    md, boxes = client.parse_grounding("du markdown | avec des pipes", 10, 10)
    assert md == "du markdown | avec des pipes"
    assert boxes == []


def test_tokens_de_controle_purges():
    # Avec --special, llama-server rend les tokens de contrôle : ils ne
    # doivent jamais atteindre le rendu ni le live.
    raw = "texte utile<|end▁of▁sentence|> suite<|image_pad|>fin"
    md, _ = client.parse_grounding(raw, 10, 10)
    assert md == "texte utile suitefin"
    s = client.StreamSanitizer()
    out = s.feed(raw) + s.flush()
    assert "<|" not in out


def test_parse_det_box_unique_non_imbriquee():
    assert client._parse_det("[1, 2, 3, 4]") == [[1.0, 2.0, 3.0, 4.0]]


# ─────────────────────────────────────────────────────────────────────────────
#  StreamSanitizer / stable_prefix_len
# ─────────────────────────────────────────────────────────────────────────────
def test_sanitizer_tag_coupe_en_plein_stream():
    s = client.StreamSanitizer()
    out = s.feed("Bonjour <|re")
    out += s.feed("f|>label<|/ref|><|det|>[[1,2,3,4]]")
    out += s.feed("<|/det|> fin")
    out += s.flush()
    assert out == "Bonjour label fin"


# ─────────────────────────────────────────────────────────────────────────────
#  Format PLAT (réel : Unlimited-OCR derrière llama-server sans --special)
# ─────────────────────────────────────────────────────────────────────────────
_REAL = ("table [141, 88, 849, 126]<table>YoY Growth+18.5%</table>\n"
         "footer [143, 942, 813, 957]This sample DOCX file.")


def test_parse_grounding_format_plat_reel():
    md, boxes = client.parse_grounding(_REAL, 905, 1280)
    assert len(boxes) == 2
    assert boxes[0]["box"] == [128, 113, 768, 161]      # 0-1000 → px page
    assert boxes[0]["text"].startswith("YoY Growth")     # tooltip = contenu
    assert boxes[1]["text"].startswith("This sample")
    # préfixes retirés, contenu conservé
    assert md.startswith("<table>YoY") and "[143," not in md and "\nfooter" not in md


def test_parse_plain_garde_fous():
    # coordonnées dégénérées (x2 ≤ x1) ou hors bornes → pas de box, texte intact
    md, boxes = client.parse_grounding("bad [500, 100, 400, 200]x", 100, 100)
    assert boxes == [] and md == "bad [500, 100, 400, 200]x"
    # pas en début de ligne → pas un élément
    md2, boxes2 = client.parse_grounding("voir table [1, 2, 3, 4] p.9", 100, 100)
    assert boxes2 == [] and "table [1, 2, 3, 4]" in md2


_SPECIAL = ('<|det|>text [55, 72, 225, 117]<|/det|>Rapport de mesure\n'
            '<|det|>table [50, 230, 928, 766]<|/det|>'
            '<table><tr><td>Ref</td><td>Valeur</td></tr></table>'
            '<｜end▁of▁sentence｜>')


def test_parse_grounding_det_block_special():
    """Format --special sondé en réel : ``<|det|>label [coords]<|/det|>contenu``
    + token EOS en barres PLEINE-CHASSE (U+FF5C)."""
    md, boxes = client.parse_grounding(_SPECIAL, 520, 260)
    assert len(boxes) == 2
    assert boxes[0]["text"] == "Rapport de mesure"
    assert boxes[1]["box"] == [26, 60, 483, 199]
    assert "<|" not in md and "｜" not in md
    assert md == ("Rapport de mesure\n"
                  "<table><tr><td>Ref</td><td>Valeur</td></tr></table>")


def test_sanitizer_det_block_en_flux():
    """Le live ne fuit ni det, ni coords, ni EOS — quel que soit le découpage
    en chunks (y compris le « < » terminal d'un token à cheval)."""
    expected = "Rapport de mesure\n<table><tr><td>Ref</td><td>Valeur</td></tr></table>"
    for size in (1, 3, 7):
        s = client.StreamSanitizer()
        out = "".join(s.feed(_SPECIAL[i:i + size])
                      for i in range(0, len(_SPECIAL), size)) + s.flush()
        assert out == expected, (size, out[:60])


def test_sanitizer_format_plat_en_flux():
    """Char par char : les préfixes ``label [coords]`` ne fuient jamais à
    l'écran, le contenu passe intégralement."""
    s = client.StreamSanitizer()
    out = ""
    for ch in _REAL:
        out += s.feed(ch)
    out += s.flush()
    assert out == "<table>YoY Growth+18.5%</table>\nThis sample DOCX file."


def test_sanitizer_flux_sans_tags_passe_tel_quel():
    s = client.StreamSanitizer()
    assert s.feed("abc") + s.feed("def") + s.flush() == "abcdef"


def test_sanitizer_pipe_litteral_relache_apres_garde_fou():
    s = client.StreamSanitizer()
    s.feed("x <|")
    # un « <| » jamais fermé ne bloque pas le live indéfiniment
    out = s.feed("y" * (client._HOLD_MAX + 10))
    assert "y" * 100 in out


def test_stable_prefix_len():
    assert client.stable_prefix_len("abc") == 3
    assert client.stable_prefix_len("abc<|") == 3
    assert client.stable_prefix_len("abc<|ref|>x") == 3          # bloc ouvert
    assert client.stable_prefix_len("a<|grounding|>b") == 15     # jeton fermé
    full = "a<|ref|>x<|/ref|><|det|>[[1,2,3,4]]<|/det|>b"
    assert client.stable_prefix_len(full) == len(full)


# ─────────────────────────────────────────────────────────────────────────────
#  URL chat/completions
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("endpoint,expected", [
    ("http://h:8090", "http://h:8090/v1/chat/completions"),
    ("http://h:8090/", "http://h:8090/v1/chat/completions"),
    ("http://h:8090/v1", "http://h:8090/v1/chat/completions"),
    ("http://h:8090/v1/chat/completions", "http://h:8090/v1/chat/completions"),
])
def test_chat_url(endpoint, expected):
    assert client._chat_url(endpoint) == expected


async def test_stream_ocr_sans_endpoint():
    with pytest.raises(client.OcrError):
        await client.stream_ocr(b"png", cfg={"endpoint_url": ""})


# ─────────────────────────────────────────────────────────────────────────────
#  Découverte des modèles (/v1/models)
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("endpoint,expected", [
    ("http://h:8090", "http://h:8090/v1/models"),
    ("http://h:8090/v1", "http://h:8090/v1/models"),
    ("http://h:8090/v1/chat/completions", "http://h:8090/v1/models"),
])
def test_models_url(endpoint, expected):
    assert client._models_url(endpoint) == expected


def test_parse_models_payload():
    # Forme OpenAI/llama-server ROUTEUR : status.value = état du modèle
    assert client._parse_models_payload(
        {"data": [{"id": "a", "status": {"value": "Loaded"}},
                  {"id": "b", "status": {"value": "unloaded"}},
                  {"id": "a"}]}) == [
        {"id": "a", "state": "loaded"}, {"id": "b", "state": "unloaded"}]
    # Variantes : strings / dicts name|model → state vide (mono-modèle)
    assert client._parse_models_payload(
        {"models": ["x", {"name": "y"}, {"model": "z", "status": "loading"}]}) == [
        {"id": "x", "state": ""}, {"id": "y", "state": ""},
        {"id": "z", "state": "loading"}]
    assert client._parse_models_payload({}) == []
    assert client._parse_models_payload({"data": "pas une liste"}) == []


async def test_lifecycle_sans_endpoint():
    with pytest.raises(client.OcrError):
        await client.load_model({"endpoint_url": ""}, "m")
    with pytest.raises(client.OcrError):
        await client.unload_model({"endpoint_url": "http://h:1"}, "")


async def test_fetch_models_sans_endpoint():
    with pytest.raises(client.OcrError):
        await client.fetch_models({"endpoint_url": ""})


# ─────────────────────────────────────────────────────────────────────────────
#  ensure_model — résolution auto quand ni doc ni default_model n'en donnent
#  (un routeur llama-server refuse un body sans model :
#   « missing model name in request »)
# ─────────────────────────────────────────────────────────────────────────────
async def test_ensure_model_deja_renseigne(monkeypatch):
    """Modèle déjà présent : AUCUNE découverte (pas d'appel réseau)."""
    async def _boom(cfg):
        raise AssertionError("fetch_models ne doit pas être appelé")
    monkeypatch.setattr(client, "fetch_models", _boom)
    cfg = {"model": "deja-la", "endpoint_url": "http://h:1"}
    assert (await client.ensure_model(cfg))["model"] == "deja-la"


async def test_ensure_model_prefere_le_charge(monkeypatch):
    """Sans modèle : découverte → priorité au modèle state=loaded."""
    async def _models(cfg):
        return [{"id": "froid", "state": "unloaded"},
                {"id": "chaud", "state": "loaded"}]
    monkeypatch.setattr(client, "fetch_models", _models)
    cfg = {"model": "", "endpoint_url": "http://h:1"}
    assert (await client.ensure_model(cfg))["model"] == "chaud"


async def test_ensure_model_repli_premier(monkeypatch):
    """Aucun modèle chargé (ou états non publiés) : premier découvert."""
    async def _models(cfg):
        return [{"id": "seul", "state": ""}]
    monkeypatch.setattr(client, "fetch_models", _models)
    cfg = {"model": "", "endpoint_url": "http://h:1"}
    assert (await client.ensure_model(cfg))["model"] == "seul"


async def test_ensure_model_best_effort(monkeypatch):
    """Serveur injoignable ou liste vide : cfg INCHANGÉ (l'appel suivant
    remontera l'erreur serveur telle quelle)."""
    async def _down(cfg):
        raise client.OcrError("injoignable")
    monkeypatch.setattr(client, "fetch_models", _down)
    cfg = {"model": "", "endpoint_url": "http://h:1"}
    assert (await client.ensure_model(cfg))["model"] == ""

    async def _vide(cfg):
        return []
    monkeypatch.setattr(client, "fetch_models", _vide)
    assert (await client.ensure_model(cfg))["model"] == ""
