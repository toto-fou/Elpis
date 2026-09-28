# SPDX-License-Identifier: MIT
"""
llm_core._detection_client — client for the image-annotation backend.

The "annotation model" is either a DEDICATED detection service (OmniParser,
Florence-2, Grounding-DINO, NVIDIA LocateAnything…) or — format ``llm-chat`` —
a MULTIMODAL LLM derrière un endpoint OpenAI-compatible (/v1/chat/completions,
ex. llama-server avec un modèle VL) à qui on demande les boxes en JSON strict.
This module is the single place that:

  • POSTs a screenshot to the configured endpoint (``vision.*`` config), and
  • normalizes wildly different response shapes into ONE element schema:

        {"label": str, "box": [x1, y1, x2, y2],   # NATIVE screenshot pixels
         "center": [cx, cy], "confidence": float, "source": "vision"}

Coordinate space is the #1 correctness risk of the whole feature: a detection
runs on whatever pixels we POST, but a *click* happens in the agent's NATIVE
screenshot pixels. So every box is rescaled back to native here, and the rest of
the pipeline only ever sees native pixels.

Sync by design (uses ``requests``) so it composes with the sync MCP tools in
``desktop_tools.py`` exactly like ``firefox_tools._req``.

Endpoints differ. Named ``format`` values ship sensible defaults; anything
exotic is handled by ``format="custom"`` + ``vision.response_map`` (dotted
paths). On a parse miss we log the top-level keys + a small sample so an
operator can fill ``response_map`` without reading this file.
"""
from __future__ import annotations

import base64
import io
import logging
import os
import re
import threading
from typing import Any, Dict, List, Optional, Tuple

import requests

logger = logging.getLogger("uvicorn.error")

# Dernière erreur de détection (diagnostic) — remise à zéro à chaque detect().
# Lue par observe_core pour remonter une note VISIBLE (Studio/outil) au lieu
# d'un échec silencieux ([] + warning dans les logs que personne ne lit).
#
# ⚠ THREAD-LOCAL : detect()/_ocr() tournent en CONCURRENCE (threadpool web des
# routes capture + threads du serveur MCP + threads de rejeu). Un global partagé
# faisait qu'une erreur d'un thread s'affichait dans le toast d'un AUTRE thread
# (race). Chaque thread a désormais SON diagnostic ; comme detect()/_ocr() sont
# synchrones et lus juste après l'appel sur le MÊME thread, c'est correct.
_TLS = threading.local()


def _set_err(msg: str) -> None:
    _TLS.err = msg


def last_error() -> str:
    """Diagnostic de la dernière détection SUR CE THREAD (« » si aucun)."""
    return getattr(_TLS, "err", "") or ""


def __getattr__(name: str) -> str:
    # PEP 562 : compat ascendante pour les lecteurs par ``getattr(_dc,
    # "LAST_ERROR", "")`` ou ``D.LAST_ERROR`` — désormais résolus par thread.
    # (Invoqué UNIQUEMENT quand l'attribut module n'existe pas, i.e. plus de
    # global ``LAST_ERROR`` — les lectures internes passent par last_error().)
    if name == "LAST_ERROR":
        return last_error()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

# Largest width we POST to the detector. Detection wants detail, so this is
# generous (a downscale only kicks in for very large / 4K screenshots). Boxes
# returned in pixel space are rescaled from this back to native.
_DETECT_MAX_WIDTH = max(320, int(os.environ.get("APP_DETECT_MAX_WIDTH", "1920") or 1920))


# ── Format presets ───────────────────────────────────────────────────────────
# Each preset tells the parser where to look. ``items`` = candidate keys whose
# value is a list of element dicts (style 1). ``box``/``label``/``score`` =
# candidate field names inside each element. ``box_format`` ∈ xyxy|xywh|cxcywh.
# ``coords`` ∈ auto|norm|pixel (auto = guess from magnitude). For "parallel
# array" responses (Florence-2: ``{bboxes:[...], labels:[...]}``) the parser
# falls back to zipping ``arrays`` keys.
_PRESETS: Dict[str, Dict[str, Any]] = {
    "omniparser": {
        "items":  ["parsed_content_list", "elements", "items", "data", "result"],
        "box":    ["bbox", "box", "bounding_box", "coordinates"],
        "label":  ["content", "label", "text", "type", "name"],
        "score":  ["score", "confidence", "prob", "probability"],
        "arrays": {"box": ["bboxes", "boxes"], "label": ["labels", "contents"], "score": ["scores", "logits"]},
        "box_format": "xyxy", "coords": "auto",
    },
    "florence": {
        "items":  ["detections", "items", "data"],
        "box":    ["bbox", "box"],
        "label":  ["label", "text", "content"],
        "score":  ["score", "confidence"],
        "arrays": {"box": ["bboxes", "boxes"], "label": ["labels"], "score": ["scores"]},
        "box_format": "xyxy", "coords": "pixel",
    },
    "grounding-dino": {
        "items":  ["detections", "predictions", "objects", "data"],
        "box":    ["box", "bbox", "xyxy"],
        "label":  ["label", "phrase", "text", "name"],
        "score":  ["score", "confidence", "logit"],
        "arrays": {"box": ["boxes", "bboxes"], "label": ["labels", "phrases"], "score": ["scores", "logits"]},
        "box_format": "xyxy", "coords": "auto",
    },
    # Best-effort default for NVIDIA "LocateAnything" style servers. The exact
    # wire shape may need a small response_map tweak — see module docstring.
    "nvidia-locate-anything": {
        "items":  ["detections", "objects", "results", "boxes", "data"],
        "box":    ["bbox", "box", "rect", "xyxy"],
        "label":  ["label", "name", "class", "category", "text"],
        "score":  ["score", "confidence", "prob"],
        "arrays": {"box": ["boxes", "bboxes"], "label": ["labels", "classes", "names"], "score": ["scores", "confidences"]},
        "box_format": "xyxy", "coords": "auto",
    },
}
# Aliases so the admin dropdown values map cleanly.
_PRESETS["nvidia"] = _PRESETS["nvidia-locate-anything"]
_PRESETS["locate-anything"] = _PRESETS["nvidia-locate-anything"]
_PRESETS["florence-2"] = _PRESETS["florence"]
_PRESETS["groundingdino"] = _PRESETS["grounding-dino"]

# Formats routed to the multimodal-LLM path (OpenAI chat/completions) instead
# of a dedicated detector.
_LLM_FORMATS = {"llm-chat", "llm", "openai-chat", "vlm"}

# Contrat JSON imposé au LLM multimodal. Les coordonnées sont demandées en
# PIXELS de l'image envoyée (les VL type Qwen-VL répondent nativement en
# pixels absolus de l'image d'entrée) ; le parsing tolère aussi du normalisé
# 0-1 (coords "auto"). Le hint opérateur (vision.prompt) est AJOUTÉ comme
# focus, jamais substitué — sinon le contrat JSON saute.
#
# DEUX PASSES plein-écran (validé en live sur Qwen2.5-VL-3B) :
#   1. balayage par zones — trouve la grille d'icônes + l'horloge ;
#   2. focus barre système — seul moyen d'obtenir les petits items de la
#      taskbar (démarrer, icônes épinglées 32px sans étiquette).
# NE PAS recadrer la barre dans une image séparée : l'aspect extrême
# (~20:1) casse le mapping de coordonnées du modèle (décalages ~150 px
# mesurés) ; en plein écran les coordonnées restent justes au pixel près.
# Les prompts de grounding sont en ANGLAIS : les VL (Qwen-VL & dérivés type
# LocateAnything) sont entraînés massivement en anglais → instructions plus
# fiables, moins de dérive, coordonnées plus justes. Les LABELS restent le vrai
# texte visible (langue de l'UI) — c'est ce que le modèle doit rendre, pas ce
# qu'on lui demande. Un texte identique vit dans system_prompts/VISION_*.md
# (éditable en admin) ; ces constantes sont le REPLI.
_LLM_BASE_PROMPT = (
    "You are a UI grounding engine. Detect every distinct INTERACTIVE element "
    "visible in this screenshot — buttons, icons, text fields, checkboxes, menu "
    "items, list rows, taskbar items, and the clock. Give each one its OWN box "
    "and its real visible label; include small and unlabeled icons. Do NOT return "
    "whole regions or containers (no single box for a desktop area, a window, or "
    "the taskbar) — box the individual widgets inside them. Never invent a regular "
    "grid and never repeat the same element. Return ONLY a JSON array (no prose, "
    "no markdown fence) where each item is "
    '{"label": "<short name>", "box": [x1, y1, x2, y2]} '
    "with INTEGER PIXEL coordinates relative to this exact image (origin at the "
    "top-left, x to the right, y downward, x1<x2, y1<y2). Use each element's real "
    "visible text as its label, in whatever language it appears on screen."
)
_LLM_EDGE_PROMPT = (
    "You are a UI grounding engine. In this desktop screenshot, list ONLY the "
    "individual items inside the bar along the BOTTOM edge of the screen: the "
    "launcher/Start button, EVERY application icon (including small unlabeled "
    "colored squares), each notification-area (system tray) icon, and the clock. "
    "Do NOT return the bar itself. Return ONLY a JSON array of "
    '{"label": "<short name>", "box": [x1, y1, x2, y2]} '
    "with INTEGER PIXEL coordinates relative to this exact image (origin at the "
    "top-left)."
)
_LLM_QUERY_PROMPT = (
    # Pièges VL 3B-Q4 (Qwen2.5-VL), tous validés live — garder ce prompt NU :
    #  - « If nothing matches, return [] » → [] systématique (porte de sortie) ;
    #  - « look at PIXELS / colored square / not in any accessibility tree » →
    #    le modèle HALLUCINE une grille « Red/Green/Blue Button » et perd les
    #    vrais labels. Le modèle regarde l'image de toute façon : inutile (et
    #    nuisible) de le lui dire. Court + anti-grille = labels réels, stable.
    # {query} = la demande formulée par le modèle appelant (attendue EN ANGLAIS,
    # cf. desktop_observe/desktop_read) ; substituée par .replace (PAS .format,
    # le template contient des accolades JSON).
    "You are a UI grounding engine. Find and box every element that matches this "
    "request: {query}. Box ONLY elements that are ACTUALLY VISIBLE in the image; "
    "never invent a regular grid and never repeat the same element. Use each "
    "element's real visible label. Return ONLY a JSON array (no prose, no markdown "
    "fence) where each item is "
    '{"label": "<short name>", "box": [x1, y1, x2, y2]} '
    "with INTEGER PIXEL coordinates relative to this exact image (origin at the "
    "top-left, x1<x2, y1<y2)."
)

_LLM_READ_PROMPT = (
    # OCR par le VL : lire le texte affiché à l'écran (journal, étiquettes
    # sur canvas, champs…) que l'arbre d'accessibilité n'expose pas. Pas de
    # box ici, juste la transcription brute dans l'ordre de lecture. Sentinelle
    # « (no text) » — alignée avec la vérification dans read_text().
    "Read and transcribe ALL the visible text in this image, exactly as shown, "
    "preserving the reading order and line breaks. Do not translate, summarize, or "
    "add any comment. If there is no readable text, reply exactly: (no text)."
)

# ── Prompts éditables (Admin → System prompts) ──────────────────────────────
# Les prompts vision vivent dans system_prompts/VISION_*.md (même mécanique
# que CHATBOT_SYSTEM.md : visibles et éditables dans l'admin, rechargés à
# chaud via mtime). Les constantes ci-dessus servent de REPLI si un fichier
# est supprimé ou vidé.
_PROMPT_FILES = {
    "VISION_DETECT":       _LLM_BASE_PROMPT,
    "VISION_DETECT_EDGE":  _LLM_EDGE_PROMPT,
    "VISION_DETECT_QUERY": _LLM_QUERY_PROMPT,
    "VISION_READ":         _LLM_READ_PROMPT,
}
_prompt_cache: Dict[str, Tuple[float, str]] = {}


def _prompt_text(category: str) -> str:
    """Contenu du fichier system_prompts/<category>.md (cache mtime),
    repli sur la constante embarquée si absent/vide/illisible."""
    fallback = _PROMPT_FILES.get(category, "")
    try:
        from llm_core._system_prompts import _SYSTEM_P_DIR
        p = _SYSTEM_P_DIR / f"{category}.md"
        mtime = p.stat().st_mtime
        cached = _prompt_cache.get(category)
        if cached and cached[0] == mtime:
            return cached[1]
        text = p.read_text(encoding="utf-8").strip()
        if not text:
            return fallback
        _prompt_cache[category] = (mtime, text)
        return text
    except OSError:
        return fallback
    except Exception:  # import/runtime inattendu — ne jamais casser la détection
        return fallback


def _native_size(png_bytes: bytes) -> Tuple[int, int]:
    try:
        from PIL import Image
        with Image.open(io.BytesIO(png_bytes)) as im:
            return int(im.width), int(im.height)
    except Exception:
        return 0, 0


def _maybe_downscale(png_bytes: bytes, native_w: int) -> Tuple[bytes, int]:
    """Downscale to _DETECT_MAX_WIDTH if wider. Returns (bytes, sent_width)."""
    if native_w <= _DETECT_MAX_WIDTH or native_w <= 0:
        return png_bytes, (native_w or 0)
    try:
        from PIL import Image
        with Image.open(io.BytesIO(png_bytes)) as im:
            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            ratio = _DETECT_MAX_WIDTH / im.width
            im = im.resize((_DETECT_MAX_WIDTH, max(1, int(im.height * ratio))), Image.LANCZOS)
            out = io.BytesIO()
            im.save(out, format="PNG", optimize=True)
            return out.getvalue(), _DETECT_MAX_WIDTH
    except Exception as e:
        logger.debug("[detect] downscale skipped: %s", e)
        return png_bytes, native_w


def _sniff_mime(data: bytes) -> str:
    """MIME d'après les magic bytes (JPEG ``\\xff\\xd8`` sinon PNG). L'hôte peut
    envoyer du JPEG (config screenshot) : servir le bon type au modèle VL."""
    if isinstance(data, (bytes, bytearray)) and data[:2] == b"\xff\xd8":
        return "image/jpeg"
    return "image/png"


def _data_url(img_bytes: bytes) -> str:
    return ("data:" + _sniff_mime(img_bytes) + ";base64,"
            + base64.b64encode(img_bytes).decode("ascii"))


def _get_first(obj: Any, names: List[str]) -> Any:
    if isinstance(obj, dict):
        for n in names:
            if n in obj and obj[n] is not None:
                return obj[n]
    return None


def _find_list_of_dicts(payload: Any, keys: List[str], _depth: int = 0) -> Optional[List[dict]]:
    """Locate a list of element dicts under one of ``keys``. Unwraps single-key
    wrapper dicts (Florence ``{"<OD>": {...}}``). Searches ≤3 levels deep."""
    if _depth > 3 or payload is None:
        return None
    if isinstance(payload, list):
        return payload if (payload and isinstance(payload[0], dict)) else None
    if isinstance(payload, dict):
        for k in keys:
            v = payload.get(k)
            if isinstance(v, list) and v and isinstance(v[0], dict):
                return v
        # Florence task-keyed wrapper: descend single-key dict values.
        for v in payload.values():
            if isinstance(v, (dict, list)):
                found = _find_list_of_dicts(v, keys, _depth + 1)
                if found:
                    return found
    return None


def _find_array(payload: Any, keys: List[str], _depth: int = 0) -> Optional[list]:
    if _depth > 3 or payload is None:
        return None
    if isinstance(payload, dict):
        for k in keys:
            v = payload.get(k)
            if isinstance(v, list):
                return v
        for v in payload.values():
            if isinstance(v, (dict, list)):
                found = _find_array(v, keys, _depth + 1)
                if found is not None:
                    return found
    return None


def _coerce_box(raw: Any) -> Optional[List[float]]:
    if isinstance(raw, dict):
        # {x1,y1,x2,y2} or {x,y,w,h} or {left,top,right,bottom}
        for keyset in (("x1", "y1", "x2", "y2"), ("left", "top", "right", "bottom"),
                       ("x", "y", "w", "h"), ("x", "y", "width", "height")):
            if all(k in raw for k in keyset):
                return [float(raw[k]) for k in keyset]
        return None
    if isinstance(raw, (list, tuple)) and len(raw) >= 4:
        try:
            return [float(v) for v in raw[:4]]
        except (TypeError, ValueError):
            return None
    return None


def _to_xyxy_native(box: List[float], box_format: str, coords: str,
                    sent_w: int, sent_h: int, native_w: int, native_h: int) -> Optional[List[int]]:
    a, b, c, d = box[0], box[1], box[2], box[3]
    if box_format == "xywh":
        x1, y1, x2, y2 = a, b, a + c, b + d
    elif box_format == "cxcywh":
        x1, y1, x2, y2 = a - c / 2.0, b - d / 2.0, a + c / 2.0, b + d / 2.0
    else:  # xyxy
        x1, y1, x2, y2 = a, b, c, d

    is_norm = (coords == "norm") or (coords == "auto" and max(abs(x1), abs(y1), abs(x2), abs(y2)) <= 1.5)
    if is_norm:
        if native_w <= 0 or native_h <= 0:
            return None
        x1, x2 = x1 * native_w, x2 * native_w
        y1, y2 = y1 * native_h, y2 * native_h
    else:
        # pixel coords are in the SENT image space → rescale to native
        if sent_w and native_w and sent_w != native_w:
            sx = native_w / float(sent_w)
            sy = native_h / float(sent_h or sent_w)
            x1, x2, y1, y2 = x1 * sx, x2 * sx, y1 * sy, y2 * sy

    x1, x2 = sorted((x1, x2))
    y1, y2 = sorted((y1, y2))
    if native_w:
        x1, x2 = max(0, min(native_w, x1)), max(0, min(native_w, x2))
    if native_h:
        y1, y2 = max(0, min(native_h, y1)), max(0, min(native_h, y2))
    if x2 - x1 < 1 or y2 - y1 < 1:
        return None
    return [int(round(x1)), int(round(y1)), int(round(x2)), int(round(y2))]


def _label_of(item: dict, keys: List[str]) -> str:
    v = _get_first(item, keys)
    if isinstance(v, dict):
        v = v.get("text") or v.get("name") or v.get("label")
    return str(v).strip() if v is not None else "element"


def _score_of(item: dict, keys: List[str]) -> float:
    v = _get_first(item, keys)
    try:
        return round(float(v), 3)
    except (TypeError, ValueError):
        return 0.0


def _chat_completions_url(endpoint: str) -> str:
    """Tolère une URL de base (http://host:8080), .../v1 ou l'URL complète."""
    url = (endpoint or "").rstrip("/")
    if "/chat/completions" in url:
        return url
    if url.endswith("/v1"):
        return url + "/chat/completions"
    return url + "/v1/chat/completions"


def read_text(
    png_bytes: bytes,
    *,
    endpoint: str,
    model: str = "",
    instruction: str = "",
    auth_header: str = "Authorization",
    auth_token: str = "",
    timeout: int = 60,
) -> Optional[str]:
    """OCR par LLM multimodal : transcrit le texte VISIBLE dans l'image (ou un
    crop). Retourne la chaîne lue (``""`` si « (no text) »), ou ``None`` sur
    échec dur (``LAST_ERROR`` posé). Utilisé pour lire ce que l'arbre
    d'accessibilité n'expose pas (journal, canvas, étiquettes)."""
    _set_err("")
    if not endpoint or not png_bytes:
        _set_err("endpoint vision non configuré")
        return None
    url = _chat_completions_url(endpoint)
    instr = (instruction or "").strip() or _LLM_READ_PROMPT
    headers = {auth_header: auth_token} if (auth_token and auth_header) else {}
    body: Dict[str, Any] = {
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": instr},
                {"type": "image_url", "image_url": {"url": _data_url(png_bytes)}},
            ],
        }],
        "temperature": 0,
        "max_tokens": 2000,
        "stream": False,
    }
    if model:
        body["model"] = model
    try:
        resp = requests.post(url, json=body, headers=headers, timeout=timeout)
    except requests.exceptions.RequestException as e:
        logger.warning("[read/llm] request to %s failed: %s", url, e)
        _set_err(f"endpoint LLM injoignable ({e.__class__.__name__})")
        return None
    if resp.status_code != 200:
        detail = ""
        try:
            err = resp.json().get("error")
            detail = (err.get("message") if isinstance(err, dict) else str(err or "")).strip()
        except (ValueError, AttributeError):
            detail = (resp.text or "").strip()[:160]
        _set_err(f"endpoint LLM → HTTP {resp.status_code}" + (f" : {detail[:200]}" if detail else ""))
        return None
    try:
        content = resp.json()["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError):
        _set_err("réponse LLM inattendue (pas un chat/completions ?)")
        return None
    if isinstance(content, list):
        content = " ".join(p.get("text", "") for p in content if isinstance(p, dict))
    content = re.sub(r"<think>.*?</think>", "", str(content), flags=re.DOTALL).strip()
    # Dé-fencer un éventuel bloc markdown ```…```
    if content.startswith("```"):
        content = re.sub(r"^```[a-zA-Z]*\n?|\n?```$", "", content).strip()
    if content == "(no text)":
        return ""
    return content


def _extract_json_array(text: str) -> Optional[list]:
    """Extrait le tableau JSON d'une réponse LLM : tolère un bloc <think>,
    des fences markdown et du texte autour du tableau."""
    import json
    if not isinstance(text, str) or not text.strip():
        return None
    # Modèles "reasoning" : retirer le bloc de réflexion.
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)
    # Fences ```json ... ``` (on garde l'intérieur).
    text = re.sub(r"```(?:json)?", "", text)
    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end <= start:
        return None
    try:
        parsed = json.loads(text[start:end + 1])
    except ValueError:
        return None
    return parsed if isinstance(parsed, list) else None


# Sorties de grounding NATIVES des VL (quand le modèle ignore le contrat JSON
# et répond dans son format d'entraînement). Coordonnées 0-1000 normalisées
# (convention Qwen-VL / dérivés type LocateAnything).
#   Qwen2-VL  : <|object_ref_start|>label<|object_ref_end|>
#               <|box_start|>(x1,y1),(x2,y2)<|box_end|>
#   Qwen-VL   : <ref>label</ref><box>(x1,y1),(x2,y2)</box>
_NUM = r"(\d+(?:\.\d+)?)"
_PAIR = rf"\(?\s*{_NUM}\s*,\s*{_NUM}\s*\)?"
_TAG_PATTERNS = [
    re.compile(
        r"(?:<\|object_ref_start\|>(?P<label>.*?)<\|object_ref_end\|>\s*)?"
        rf"<\|box_start\|>\s*{_PAIR}\s*,\s*{_PAIR}\s*<\|box_end\|>",
        re.DOTALL),
    re.compile(
        r"(?:<ref>(?P<label>.*?)</ref>\s*)?"
        rf"<box>\s*{_PAIR}\s*,\s*{_PAIR}\s*</box>",
        re.DOTALL),
]


def _extract_tag_items(text: str) -> List[dict]:
    """Fallback : parse les boxes taguées (0-1000) → items {label, box} avec
    box ramenée en FRACTION 0-1 (le rescale 'norm' fait le reste)."""
    if not isinstance(text, str) or not text:
        return []
    items: List[dict] = []
    for pat in _TAG_PATTERNS:
        for m in pat.finditer(text):
            try:
                x1, y1, x2, y2 = (float(m.group(i)) / 1000.0 for i in range(2, 6))
            except (TypeError, ValueError):
                continue
            label = (m.group("label") or "").strip() or "element"
            items.append({"label": label, "box": [x1, y1, x2, y2]})
        if items:
            break
    return items


def _llm_pass(
    png_bytes: bytes,
    instruction: str,
    *,
    url: str,
    model: str,
    headers: Dict[str, str],
    timeout: int,
    sent_w: int,
    sent_h: int,
    native_w: int,
    native_h: int,
) -> Optional[List[Dict[str, Any]]]:
    """UNE requête chat/completions → éléments en pixels NATIFS.
    ``None`` = échec dur (LAST_ERROR posé) ; ``[]`` = réponse sans box."""
    body: Dict[str, Any] = {
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": instruction},
                {"type": "image_url", "image_url": {"url": _data_url(png_bytes)}},
            ],
        }],
        "temperature": 0,
        "max_tokens": 3000,
        "stream": False,
    }
    if model:
        body["model"] = model

    try:
        resp = requests.post(url, json=body, headers=headers, timeout=timeout)
    except requests.exceptions.RequestException as e:
        logger.warning("[detect/llm] request to %s failed: %s", url, e)
        _set_err(f"endpoint LLM injoignable ({e.__class__.__name__})")
        return None
    if resp.status_code != 200:
        logger.warning("[detect/llm] %s returned %s: %s", url, resp.status_code, (resp.text or "")[:300])
        # Remonter le message d'erreur du serveur tel quel (ex. llama.cpp :
        # « image input is not supported - … provide the mmproj ») — c'est
        # souvent LE diagnostic actionnable.
        detail = ""
        try:
            err = resp.json().get("error")
            detail = (err.get("message") if isinstance(err, dict) else str(err or "")).strip()
        except (ValueError, AttributeError):
            detail = (resp.text or "").strip()[:160]
        _set_err(f"endpoint LLM → HTTP {resp.status_code}" + (f" : {detail[:200]}" if detail else ""))
        return None
    try:
        payload = resp.json()
        content = payload["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError):
        logger.warning("[detect/llm] unexpected response shape from %s: %s", url, (resp.text or "")[:300])
        _set_err("réponse LLM inattendue (pas un chat/completions ?)")
        return None
    # Certains serveurs renvoient le content en liste de parts.
    if isinstance(content, list):
        content = " ".join(p.get("text", "") for p in content if isinstance(p, dict))

    # 1. Contrat JSON ; 2. fallback : format de grounding natif du modèle
    #    (tags <box> 0-1000, convention Qwen-VL/LocateAnything).
    norm_items: List[dict] = []
    items = _extract_json_array(content)
    if not items:
        norm_items = _extract_tag_items(content)
    if not items and not norm_items:
        logger.info("[detect/llm] no boxes in this pass (model=%s). Sample=%s",
                    model or "?", str(content)[:200])
        return []

    elements: List[Dict[str, Any]] = []
    for it in (items or []):
        if not isinstance(it, dict):
            continue
        raw_box = _coerce_box(_get_first(it, ["box", "bbox", "bbox_2d", "box_2d", "coordinates"]))
        if not raw_box:
            continue
        # Pixels de l'image ENVOYÉE par contrat de prompt ; "auto" tolère du
        # normalisé 0-1. Rescale vers le natif dans tous les cas.
        xyxy = _to_xyxy_native(raw_box, "xyxy", "auto", sent_w, sent_h, native_w, native_h)
        if not xyxy:
            continue
        elements.append({
            "label": _label_of(it, ["label", "name", "text", "content"]),
            "box": xyxy,
            "center": [(xyxy[0] + xyxy[2]) // 2, (xyxy[1] + xyxy[3]) // 2],
            "confidence": _score_of(it, ["confidence", "score"]),
            "source": "vision",
        })
    for it in norm_items:
        xyxy = _to_xyxy_native(it["box"], "xyxy", "norm", sent_w, sent_h, native_w, native_h)
        if not xyxy:
            continue
        elements.append({
            "label": it["label"],
            "box": xyxy,
            "center": [(xyxy[0] + xyxy[2]) // 2, (xyxy[1] + xyxy[3]) // 2],
            "confidence": 0.0,
            "source": "vision",
        })
    return elements


def _iou_xyxy(a: List[int], b: List[int]) -> float:
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    if inter <= 0:
        return 0.0
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0


def _detect_llm(
    png_bytes: bytes,
    *,
    endpoint: str,
    model: str,
    prompt: str,
    headers: Dict[str, str],
    timeout: int,
    sent_w: int,
    sent_h: int,
    native_w: int,
    native_h: int,
    passes: int = 2,
) -> List[Dict[str, Any]]:
    """Détection par LLM MULTIMODAL (OpenAI chat/completions, ex. llama-server
    + modèle VL), en DEUX passes plein-écran fusionnées (IoU) :
    balayage par zones puis focus barre système — les petits items de la
    taskbar n'apparaissent qu'avec la 2e passe (validé live, Qwen2.5-VL-3B).
    Même schéma de sortie que les détecteurs dédiés."""
    url = _chat_completions_url(endpoint)
    common = dict(url=url, model=model, headers=headers, timeout=timeout,
                  sent_w=sent_w, sent_h=sent_h, native_w=native_w, native_h=native_h)

    query = (prompt or "").strip()
    if query:
        # Requête CIBLÉE (barre de prompt du Studio, ou vision.prompt) : le
        # modèle annote CE QUI EST DEMANDÉ — y compris des éléments absents
        # de l'arbre d'accessibilité — en une seule passe. Substitution par
        # .replace (PAS .format : le template contient des accolades JSON).
        tmpl = _prompt_text("VISION_DETECT_QUERY")
        if "{query}" in tmpl:
            instr = tmpl.replace("{query}", query)
        else:                      # placeholder édité/perdu côté admin
            instr = tmpl + f"\nRequest: {query}"
        first = _llm_pass(png_bytes, instr, **common)
        if first is None:
            return []
        elements = first
    else:
        # Balayage EXHAUSTIF en 1-2 passes (cf. en-tête).
        first = _llm_pass(png_bytes, _prompt_text("VISION_DETECT"), **common)
        if first is None:
            return []      # échec dur (LAST_ERROR posé) — inutile d'insister
        elements = first
        if passes >= 2:
            second = _llm_pass(png_bytes, _prompt_text("VISION_DETECT_EDGE"), **common)
            if second:
                for el in second:
                    if all(_iou_xyxy(el["box"], kept["box"]) < 0.5 for kept in elements):
                        elements.append(el)

    if elements:
        _set_err("")        # une passe a pu se plaindre, le bilan est bon
        logger.info("[detect/llm] %s → %d elements (native %dx%d, %d passe(s))",
                    url, len(elements), native_w, native_h, max(1, passes))
    elif not last_error():
        logger.warning("[detect/llm] 0 box exploitable depuis %s", url)
        _set_err("le modèle n'a renvoyé aucune box exploitable (ni JSON, ni tags <box>)")
    return elements


def detect(
    png_bytes: bytes,
    *,
    endpoint: str,
    fmt: str = "omniparser",
    prompt: str = "",
    model: str = "",
    auth_header: str = "Authorization",
    auth_token: str = "",
    response_map: Optional[Dict[str, Any]] = None,
    timeout: int = 30,
    native_w: int = 0,
    native_h: int = 0,
    passes: int = 2,
) -> List[Dict[str, Any]]:
    """POST a screenshot to the detection endpoint; return normalized elements
    in NATIVE pixel space. Returns ``[]`` on any failure (never raises) —
    ``LAST_ERROR`` porte alors le diagnostic pour l'appelant."""
    _set_err("")
    if not endpoint or not png_bytes:
        return []
    if not native_w or not native_h:
        native_w, native_h = _native_size(png_bytes)

    sent_bytes, sent_w = _maybe_downscale(png_bytes, native_w)
    sent_h = int(native_h * (sent_w / native_w)) if (native_w and sent_w) else native_h
    headers = {auth_header: auth_token} if (auth_token and auth_header) else {}

    # Détection par LLM multimodal (OpenAI chat/completions) — chemin séparé :
    # le « détecteur » est un modèle VL générique, pas un service spécialisé.
    if (fmt or "").strip().lower() in _LLM_FORMATS:
        return _detect_llm(
            sent_bytes, endpoint=endpoint, model=model, prompt=prompt,
            headers=headers, timeout=timeout,
            sent_w=sent_w, sent_h=sent_h, native_w=native_w, native_h=native_h,
            passes=passes,
        )

    spec = dict(_PRESETS.get((fmt or "").strip().lower(), _PRESETS["omniparser"]))
    if response_map and isinstance(response_map, dict):
        spec.update(response_map)  # operator override wins (items/box/label/score/box_format/coords/request_mode/image_field)

    request_mode = str(spec.get("request_mode", "json")).lower()
    image_field = str(spec.get("image_field", "image"))

    try:
        if request_mode == "multipart":
            files = {spec.get("file_field", "file"): ("screenshot.png", sent_bytes, "image/png")}
            data = {"prompt": prompt} if prompt else {}
            resp = requests.post(endpoint, files=files, data=data, headers=headers, timeout=timeout)
        else:
            body: Dict[str, Any] = {image_field: _data_url(sent_bytes)}
            if prompt:
                body["prompt"] = prompt
                body["text"] = prompt  # some servers use "text"
            resp = requests.post(endpoint, json=body, headers=headers, timeout=timeout)
    except requests.exceptions.RequestException as e:
        logger.warning("[detect] request to %s failed: %s", endpoint, e)
        _set_err(f"endpoint injoignable ({e.__class__.__name__})")
        return []

    if resp.status_code != 200:
        logger.warning("[detect] endpoint %s returned %s: %s", endpoint, resp.status_code, (resp.text or "")[:300])
        _set_err(f"endpoint → HTTP {resp.status_code} — un serveur llama.cpp se configure avec le format « LLM multimodal », pas un format détecteur dédié")
        return []
    try:
        payload = resp.json()
    except ValueError:
        logger.warning("[detect] non-JSON response from %s", endpoint)
        _set_err("réponse non-JSON de l'endpoint")
        return []

    box_format = str(spec.get("box_format", "xyxy")).lower()
    coords = str(spec.get("coords", "auto")).lower()
    elements: List[Dict[str, Any]] = []

    items = _find_list_of_dicts(payload, list(spec.get("items", [])))
    if items:
        for it in items:
            raw_box = _coerce_box(_get_first(it, list(spec.get("box", []))))
            if not raw_box:
                continue
            xyxy = _to_xyxy_native(raw_box, box_format, coords, sent_w, sent_h, native_w, native_h)
            if not xyxy:
                continue
            elements.append({
                "label": _label_of(it, list(spec.get("label", []))),
                "box": xyxy,
                "center": [(xyxy[0] + xyxy[2]) // 2, (xyxy[1] + xyxy[3]) // 2],
                "confidence": _score_of(it, list(spec.get("score", []))),
                "source": "vision",
            })
    else:
        # Parallel-array style (Florence: bboxes/labels/scores).
        arr = spec.get("arrays", {}) or {}
        boxes = _find_array(payload, list(arr.get("box", []))) or []
        labels = _find_array(payload, list(arr.get("label", []))) or []
        scores = _find_array(payload, list(arr.get("score", []))) or []
        for i, raw in enumerate(boxes):
            raw_box = _coerce_box(raw)
            if not raw_box:
                continue
            xyxy = _to_xyxy_native(raw_box, box_format, coords, sent_w, sent_h, native_w, native_h)
            if not xyxy:
                continue
            lab = labels[i] if i < len(labels) else "element"
            elements.append({
                "label": str(lab).strip() if lab is not None else "element",
                "box": xyxy,
                "center": [(xyxy[0] + xyxy[2]) // 2, (xyxy[1] + xyxy[3]) // 2],
                "confidence": (round(float(scores[i]), 3) if i < len(scores) and _is_num(scores[i]) else 0.0),
                "source": "vision",
            })

    if not elements:
        _keys = list(payload.keys()) if isinstance(payload, dict) else type(payload).__name__
        logger.warning("[detect] no boxes parsed from %s (format=%s). Top-level=%s sample=%s",
                       endpoint, fmt, _keys, str(payload)[:300])
        _set_err(f"réponse 200 mais aucune box parsée (format={fmt}, clés={_keys}) — voir vision.response_map")
    else:
        logger.info("[detect] %s → %d elements (native %dx%d)", endpoint, len(elements), native_w, native_h)
    return elements


def _is_num(v: Any) -> bool:
    try:
        float(v)
        return True
    except (TypeError, ValueError):
        return False
