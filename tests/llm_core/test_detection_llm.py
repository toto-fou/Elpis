# SPDX-License-Identifier: MIT
"""Tests du chemin LLM multimodal de _detection_client (format ``llm-chat``).

Le « détecteur » est un endpoint OpenAI chat/completions (ex. llama-server +
modèle VL) : on vérifie la construction de la requête (URL normalisée, model,
image en data-URL) et la robustesse du parsing (bloc <think>, fences markdown,
clés bbox_2d/box, coordonnées pixel et normalisées) avec rescale vers le natif.
"""
from __future__ import annotations

import io
import json

import pytest

import llm_core._detection_client as D


def _png(w: int = 1280, h: int = 800) -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (w, h), "#ffffff").save(buf, format="PNG")
    return buf.getvalue()


class _Resp:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status_code = status
        self.text = json.dumps(payload)

    def json(self):
        return self._payload


def _openai(content: str) -> dict:
    return {"choices": [{"message": {"role": "assistant", "content": content}}]}


@pytest.fixture
def capture_post(monkeypatch):
    calls = {"all": []}

    def fake_post(url, json=None, headers=None, timeout=None, **kw):
        calls["url"] = url
        calls["body"] = json
        calls["timeout"] = timeout
        calls["all"].append({"url": url, "body": json})
        queue = calls.get("queue")
        if queue:
            return queue.pop(0)
        return calls.get("resp")

    monkeypatch.setattr(D.requests, "post", fake_post)
    return calls


def test_llm_chat_request_and_parsing(capture_post):
    content = (
        "<think>je réfléchis aux icônes…</think>\n"
        "```json\n"
        '[{"label": "Corbeille", "bbox_2d": [100, 200, 160, 260], "confidence": 0.9},\n'
        ' {"label": "norm", "box": [0.5, 0.5, 0.6, 0.6]}]\n'
        "```"
    )
    capture_post["resp"] = _Resp(_openai(content))

    els = D.detect(
        _png(), endpoint="http://llm:8080", fmt="llm-chat",
        model="qwen3-vl", timeout=7,
    )

    # DEUX passes par défaut : balayage par zones puis focus barre système.
    # Prompts de grounding EN ANGLAIS (VL plus fiables en anglais).
    assert len(capture_post["all"]) == 2
    assert "INTERACTIVE element" in capture_post["all"][0]["body"]["messages"][0]["content"][0]["text"]
    assert "BOTTOM edge" in capture_post["all"][1]["body"]["messages"][0]["content"][0]["text"]
    # Requête : URL normalisée + model + image data-URL + contrat JSON.
    assert capture_post["url"] == "http://llm:8080/v1/chat/completions"
    body = capture_post["body"]
    assert body["model"] == "qwen3-vl"
    assert body["temperature"] == 0
    parts = body["messages"][0]["content"]
    assert parts[0]["type"] == "text" and "JSON array" in parts[0]["text"]
    assert parts[1]["image_url"]["url"].startswith("data:image/png;base64,")

    # Parsing : 2 éléments, pixels conservés (sent == natif), normalisé → natif.
    assert len(els) == 2
    assert els[0]["label"] == "Corbeille"
    assert els[0]["box"] == [100, 200, 160, 260]
    assert els[0]["confidence"] == 0.9
    assert els[0]["source"] == "vision"
    assert els[1]["box"] == [640, 400, 768, 480]   # 0.5/0.6 × 1280/800
    assert els[1]["center"] == [704, 440]


def test_llm_chat_endpoint_variants(capture_post):
    capture_post["resp"] = _Resp(_openai("[]"))
    D.detect(_png(), endpoint="http://llm:8080/v1", fmt="llm-chat")
    assert capture_post["url"] == "http://llm:8080/v1/chat/completions"

    D.detect(_png(), endpoint="http://llm:8080/v1/chat/completions", fmt="llm-chat")
    assert capture_post["url"] == "http://llm:8080/v1/chat/completions"


def test_llm_chat_prompt_becomes_targeted_query(capture_post):
    """Un prompt (barre du Studio / vision.prompt) = recherche CIBLÉE :
    une seule passe, requête substituée dans le template, contrat JSON gardé."""
    capture_post["resp"] = _Resp(_openai('[{"label":"LoL","box":[5,5,40,40]}]'))
    els = D.detect(_png(), endpoint="http://llm:8080", fmt="llm-chat",
                   prompt="l'icône League of Legends")
    assert len(capture_post["all"]) == 1          # pas de passe barre système
    text = capture_post["all"][0]["body"]["messages"][0]["content"][0]["text"]
    assert "l'icône League of Legends" in text
    assert "{query}" not in text                  # placeholder substitué
    assert "JSON array" in text                   # le contrat n'est pas remplacé
    assert len(els) == 1 and els[0]["label"] == "LoL"


def test_prompt_files_override_and_fallback(capture_post, monkeypatch, tmp_path):
    """Les prompts vivent dans system_prompts/VISION_DETECT*.md (éditables
    dans l'admin) ; repli sur les constantes si le fichier manque."""
    import llm_core._system_prompts as SP
    monkeypatch.setattr(SP, "_SYSTEM_P_DIR", tmp_path)
    D._prompt_cache.clear()

    # Fichier présent → son contenu est utilisé tel quel.
    (tmp_path / "VISION_DETECT.md").write_text(
        "PROMPT ADMIN PERSONNALISE - JSON array {\"label\"...}", encoding="utf-8")
    capture_post["resp"] = _Resp(_openai("[]"))
    D.detect(_png(), endpoint="http://llm:8080", fmt="llm-chat", passes=1)
    text = capture_post["all"][-1]["body"]["messages"][0]["content"][0]["text"]
    assert text.startswith("PROMPT ADMIN PERSONNALISE")

    # Fichier absent → repli sur la constante embarquée.
    (tmp_path / "VISION_DETECT.md").unlink()
    D._prompt_cache.clear()
    D.detect(_png(), endpoint="http://llm:8080", fmt="llm-chat", passes=1)
    text = capture_post["all"][-1]["body"]["messages"][0]["content"][0]["text"]
    assert "INTERACTIVE element" in text


def test_llm_chat_garbage_output_returns_empty(capture_post):
    capture_post["resp"] = _Resp(_openai("Désolé, je ne vois pas d'éléments."))
    assert D.detect(_png(), endpoint="http://llm:8080", fmt="llm-chat") == []

    capture_post["resp"] = _Resp({"error": "boom"}, status=500)
    assert D.detect(_png(), endpoint="http://llm:8080", fmt="llm-chat") == []


def test_llm_chat_content_as_parts_list(capture_post):
    payload = {"choices": [{"message": {"content": [
        {"type": "text", "text": '[{"label": "OK", "box": [10, 10, 50, 50]}]'},
    ]}}]}
    capture_post["resp"] = _Resp(payload)
    els = D.detect(_png(), endpoint="http://llm:8080", fmt="llm-chat")
    assert len(els) == 1 and els[0]["label"] == "OK"


def test_classic_format_still_routes_to_detector(capture_post):
    """Régression : les formats dédiés ne passent PAS par le chemin LLM."""
    capture_post["resp"] = _Resp({"parsed_content_list": [
        {"content": "bouton", "bbox": [10, 20, 110, 60], "score": 0.8},
    ]})
    els = D.detect(_png(), endpoint="http://detector:9000/parse", fmt="omniparser")
    assert capture_post["url"] == "http://detector:9000/parse"
    assert "messages" not in (capture_post["body"] or {})
    assert len(els) == 1 and els[0]["label"] == "bouton"


def test_llm_chat_tag_fallback_qwen2_style(capture_post):
    """Le modèle ignore le contrat JSON et répond dans son format de
    grounding natif (tags spéciaux, coordonnées 0-1000) → fallback."""
    content = (
        "<|object_ref_start|>Corbeille<|object_ref_end|>"
        "<|box_start|>(100,250),(150,300)<|box_end|>\n"
        "<|object_ref_start|>Ce PC<|object_ref_end|>"
        "<|box_start|>(200,250),(250,300)<|box_end|>"
    )
    capture_post["resp"] = _Resp(_openai(content))
    els = D.detect(_png(1000, 1000), endpoint="http://llm:8080", fmt="llm-chat")
    assert [e["label"] for e in els] == ["Corbeille", "Ce PC"]
    # 0-1000 → fraction → pixels natifs (image 1000x1000 : valeurs identiques).
    assert els[0]["box"] == [100, 250, 150, 300]


def test_llm_chat_tag_fallback_ref_box_style(capture_post):
    content = '<ref>Démarrer</ref><box>(10,950),(60,995)</box>'
    capture_post["resp"] = _Resp(_openai(content))
    els = D.detect(_png(2000, 1000), endpoint="http://llm:8080", fmt="llm-chat")
    assert len(els) == 1 and els[0]["label"] == "Démarrer"
    assert els[0]["box"] == [20, 950, 120, 995]   # x ×2000, y ×1000


def test_last_error_diagnostics(capture_post):
    # 404 (ex. format détecteur dédié pointé sur un llama-server).
    capture_post["resp"] = _Resp({"error": "not found"}, status=404)
    assert D.detect(_png(), endpoint="http://llm:8080", fmt="nvidia-locate-anything") == []
    assert "HTTP 404" in D.LAST_ERROR and "LLM multimodal" in D.LAST_ERROR

    # Sortie LLM sans box.
    capture_post["resp"] = _Resp(_openai("aucune idée"))
    assert D.detect(_png(), endpoint="http://llm:8080", fmt="llm-chat") == []
    assert "aucune box" in D.LAST_ERROR

    # Succès → LAST_ERROR remis à zéro. Compat ascendante : la lecture par
    # attribut ``D.LAST_ERROR`` (PEP 562 __getattr__) donne le même résultat
    # que l'API explicite ``last_error()``.
    capture_post["resp"] = _Resp(_openai('[{"label":"OK","box":[1,1,9,9]}]'))
    assert len(D.detect(_png(), endpoint="http://llm:8080", fmt="llm-chat")) == 1
    assert D.LAST_ERROR == "" and D.last_error() == ""


def test_last_error_is_thread_local():
    """Deux threads posent leur diagnostic EN CONCURRENCE (barrière → chacun
    écrit AVANT que l'autre lise) : chaque thread relit LE SIEN, via last_error()
    ET l'attribut de compat D.LAST_ERROR. Garde-fou contre la race d'un global
    partagé (où le 2e écrasait le diagnostic du 1er)."""
    import threading

    D._set_err("")                          # un test précédent a pu poser celui du thread principal
    both_wrote = threading.Barrier(2)
    seen = {}

    def worker(name):
        D._set_err(f"diagnostic-{name}")
        both_wrote.wait(timeout=5)          # les DEUX ont écrit avant toute lecture
        seen[name] = (D.last_error(), D.LAST_ERROR)

    t1 = threading.Thread(target=worker, args=("a",))
    t2 = threading.Thread(target=worker, args=("b",))
    t1.start(); t2.start(); t1.join(); t2.join()

    assert seen["a"] == ("diagnostic-a", "diagnostic-a")
    assert seen["b"] == ("diagnostic-b", "diagnostic-b")
    # Le thread principal n'a jamais rien posé → vide, non pollué par les workers.
    assert D.last_error() == ""


def test_llm_chat_two_pass_merge_and_dedup(capture_post):
    """Passe 1 = icônes du bureau ; passe 2 = items de la barre + un doublon
    d'icône → fusion sans doublon (IoU)."""
    capture_post["queue"] = [
        _Resp(_openai('[{"label":"Edge","box":[60,50,124,140]}]')),
        _Resp(_openai('[{"label":"Edge bis","box":[62,52,126,142]},'
                      ' {"label":"Demarrer","box":[12,760,44,792]},'
                      ' {"label":"Horloge","box":[1190,765,1250,785]}]')),
    ]
    els = D.detect(_png(), endpoint="http://llm:8080", fmt="llm-chat")
    labels = [e["label"] for e in els]
    assert labels == ["Edge", "Demarrer", "Horloge"]   # le doublon IoU≈0.9 est écarté


def test_llm_chat_single_pass_honored(capture_post):
    capture_post["resp"] = _Resp(_openai('[{"label":"OK","box":[1,1,9,9]}]'))
    els = D.detect(_png(), endpoint="http://llm:8080", fmt="llm-chat", passes=1)
    assert len(capture_post["all"]) == 1
    assert len(els) == 1


def test_llm_chat_pass1_hard_failure_skips_pass2(capture_post):
    capture_post["resp"] = _Resp({"error": {"message": "boom"}}, status=500)
    assert D.detect(_png(), endpoint="http://llm:8080", fmt="llm-chat") == []
    assert len(capture_post["all"]) == 1   # pas de 2e passe après échec dur
    assert "HTTP 500" in D.LAST_ERROR


# ── OCR : read_text (lecture de texte écran) ────────────────────────────────
def test_read_text_basic(capture_post):
    capture_post["resp"] = _Resp(_openai("Ligne 1\nLigne 2"))
    txt = D.read_text(_png(), endpoint="http://llm:8080", model="qwen2.5-vl")
    body = capture_post["all"][-1]["body"]
    assert body["model"] == "qwen2.5-vl"
    # prompt OCR EN ANGLAIS (pas de contrat JSON box)
    assert "transcribe" in body["messages"][0]["content"][0]["text"].lower()
    assert body["messages"][0]["content"][1]["image_url"]["url"].startswith("data:image/png;base64,")
    assert txt == "Ligne 1\nLigne 2"


def test_read_text_strips_think_and_fence(capture_post):
    capture_post["resp"] = _Resp(_openai("<think>je lis…</think>\n```\nABC\n```"))
    assert D.read_text(_png(), endpoint="http://llm:8080") == "ABC"


def test_read_text_no_text_sentinel(capture_post):
    capture_post["resp"] = _Resp(_openai("(no text)"))
    assert D.read_text(_png(), endpoint="http://llm:8080") == ""


def test_read_text_custom_instruction(capture_post):
    capture_post["resp"] = _Resp(_openai("X"))
    D.read_text(_png(), endpoint="http://llm:8080", instruction="LIS CECI EN MAJUSCULES")
    assert capture_post["all"][-1]["body"]["messages"][0]["content"][0]["text"] == "LIS CECI EN MAJUSCULES"


def test_read_text_hard_failure(capture_post):
    capture_post["resp"] = _Resp({"error": {"message": "no mmproj"}}, status=500)
    assert D.read_text(_png(), endpoint="http://llm:8080") is None
    assert "HTTP 500" in D.LAST_ERROR and "no mmproj" in D.LAST_ERROR
