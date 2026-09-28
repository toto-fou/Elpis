# SPDX-License-Identifier: MIT
"""rag_app.ocr.client — client HTTP du modèle OCR + parseur grounding.

Le modèle est servi derrière un endpoint OpenAI-compatible (llama-server,
vLLM, SGLang…) : POST ``/v1/chat/completions`` avec un content multimodal
[{text: prompt}, {image_url: data-URL PNG}] — même wire que
``llm_core._detection_client.read_text``, mais en STREAMING (le texte
reconnu alimente la vue live page par page).

Format « grounding » de la famille DeepSeek-OCR / Unlimited-OCR : le Markdown
est entrelacé de balises ::

    <|ref|>texte<|/ref|><|det|>[[x1, y1, x2, y2]]<|/det|>

coordonnées normalisées 0-1000 (origine haut-gauche). ``parse_grounding``
extrait les boxes (converties en pixels page) et rend le Markdown nettoyé ;
:class:`StreamSanitizer` fait le même nettoyage incrémentalement pour le
live (retient un éventuel tag incomplet en fin de flux au lieu de
l'afficher). Un modèle sans grounding dégrade proprement : aucun tag →
texte inchangé, zéro box.
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import re
from typing import Awaitable, Callable, Dict, List, Optional, Tuple

import httpx

from ._common import OcrError


class OcrTruncated(OcrError):
    """Page coupée par le plafond de génération (``finish_reason=length``).

    ``raw`` porte le texte reçu : il est conservé (utile) mais la page est
    signalée tronquée — relancer à l'identique redonnerait la même coupe."""

    def __init__(self, message: str, raw: str):
        super().__init__(message)
        self.raw = raw


# Erreurs réseau/protocole httpx à traduire en OcrError lisible. ``InvalidURL``
# (hôte mal saisi) et ``StreamError`` ne dérivent pas de ``HTTPError`` : elles
# ressortaient en « Erreur interne ».
_NET_ERRORS = (httpx.HTTPError, httpx.InvalidURL, httpx.StreamError)


def _client(timeout) -> httpx.AsyncClient:
    """Fabrique de client HTTP (point d'injection des tests)."""
    return httpx.AsyncClient(timeout=timeout)


# Un seul appel au modèle à la fois : le serveur OCR n'a qu'un slot GPU. La
# lecture de ZONE (synchrone, à la demande) passait à côté du job en cours —
# sur un serveur mono-slot, l'un ou l'autre finissait en délai dépassé.
_GPU_SLOT: list = [None]


def gpu_slot() -> asyncio.Semaphore:
    """Sémaphore du slot GPU (créé paresseusement dans la boucle courante)."""
    sem = _GPU_SLOT[0]
    if sem is None:
        sem = _GPU_SLOT[0] = asyncio.Semaphore(1)
    return sem

# ─────────────────────────────────────────────────────────────────────────────
#  Parseur grounding
# ─────────────────────────────────────────────────────────────────────────────
_TAG_RE = re.compile(
    r"<\|ref\|>(.*?)<\|/ref\|>\s*<\|det\|>(.*?)<\|/det\|>", re.DOTALL)
# Jetons isolés à purger du rendu : balises grounding orphelines, MAIS AUSSI
# tout token de contrôle rendu quand llama-server tourne avec ``--special``.
# ⚠ Le tokenizer DeepSeek/Unlimited écrit certains tokens avec des barres
# PLEINE-CHASSE (U+FF5C) : ``<｜end▁of▁sentence｜>`` — la classe [|｜] couvre
# les deux. Les balises APPARIÉES sont consommées avant par les parseurs.
_STRAY_RE = re.compile(r"<[|｜]/?[A-Za-z0-9_▁\-. :]{1,40}[|｜]>")
# Format --special observé en réel (sonde 2026-07-21) : le label ET les
# coordonnées sont DANS la paire det, le contenu suit la fermeture :
#     <|det|>table [50, 230, 928, 766]<|/det|><table>…
_DET_BLOCK_RE = re.compile(
    r"<\|det\|>\s*([A-Za-z_][A-Za-z0-9_-]{0,24})?\s?"
    r"\[(\d{1,4}), ?(\d{1,4}), ?(\d{1,4}), ?(\d{1,4})\]\s*<\|/det\|>")
# Format « PLAT » constaté en réel avec Unlimited-OCR derrière llama-server :
# les tokens spéciaux (<|ref|>, <|det|>, séparateurs de cellules) sont AVALÉS
# par le serveur (non rendus) et chaque élément arrive comme
#     label [x1, y1, x2, y2]contenu…        (coordonnées normalisées 0-1000)
# en début de ligne. On extrait la box, on retire le préfixe du rendu.
_PLAIN_RE = re.compile(
    r"(?:(?<=\n)|\A)([A-Za-z_][A-Za-z0-9_-]{0,24}) "
    r"\[(\d{1,4}), ?(\d{1,4}), ?(\d{1,4}), ?(\d{1,4})\]")
# Fin de flux potentiellement en train d'écrire un préfixe plat → à retenir.
_PLAIN_HOLD_RE = re.compile(
    r"(?:^|\n)([A-Za-z_][A-Za-z0-9_-]{0,24}(?: (?:\[[\d, ]{0,24})?)?)\Z")

# Au-delà de ce volume retenu sans fermeture de tag, on considère que ce
# n'était PAS un tag (le modèle a émis un « <| » littéral) et on relâche.
_HOLD_MAX = 4000


def _parse_det(raw: str) -> List[List[int]]:
    """``[[x1, y1, x2, y2], …]`` (0-1000) — liste vide si illisible."""
    try:
        data = json.loads(raw.strip())
    except ValueError:
        return []
    if isinstance(data, list) and len(data) == 4 and all(
            isinstance(v, (int, float)) for v in data):
        data = [data]   # tolérance : box unique non imbriquée
    out = []
    if isinstance(data, list):
        for item in data:
            if (isinstance(item, list) and len(item) == 4
                    and all(isinstance(v, (int, float)) for v in item)):
                out.append([float(v) for v in item])
    return out


def _scale_box(x1: float, y1: float, x2: float, y2: float,
               page_w: int, page_h: int) -> Optional[List[int]]:
    """0-1000 → pixels page ; None si la box est dégénérée/hors bornes."""
    if not (0 <= x1 < x2 <= 1010 and 0 <= y1 < y2 <= 1010):
        return None
    return [round(x1 / 1000 * page_w), round(y1 / 1000 * page_h),
            round(x2 / 1000 * page_w), round(y2 / 1000 * page_h)]


def _extract_prefixes(md: str, regex: "re.Pattern[str]",
                      page_w: int, page_h: int) -> Tuple[str, List[Dict]]:
    """Extrait des éléments « préfixe (label+coords) puis contenu » : retire
    le préfixe du markdown, garde le contenu, tooltip = début du contenu
    (repli : le label). Utilisé par les formats PLAT et det-block."""
    boxes: List[Dict] = []
    out: List[str] = []
    pos = 0
    for m in regex.finditer(md):
        box = _scale_box(*(float(m.group(i)) for i in range(2, 6)),
                         page_w, page_h)
        if box is None:
            continue
        eol = md.find("\n", m.end())
        snippet = md[m.end(): eol if eol != -1 else len(md)]
        snippet = re.sub(r"<[^>]{1,40}>", " ", snippet)
        snippet = _STRAY_RE.sub("", snippet).strip()
        boxes.append({"text": (snippet or (m.group(1) or "zone"))[:200],
                      "box": box})
        out.append(md[pos:m.start()])
        pos = m.end()
    out.append(md[pos:])
    return "".join(out), boxes


def parse_grounding(raw: str, page_w: int, page_h: int
                    ) -> Tuple[str, List[Dict]]:
    """Markdown nettoyé + boxes en PIXELS page depuis la sortie grounding.

    Trois formats reconnus (cumulables) :
    - DeepSeek classique ``<|ref|>label<|/ref|><|det|>[[…]]<|/det|>`` ;
    - det-block (--special, sondé en réel 2026-07-21)
      ``<|det|>label [x1, y1, x2, y2]<|/det|>contenu`` ;
    - PLAT (tokens spéciaux avalés, serveur sans --special)
      ``label [x1, y1, x2, y2]contenu``.
    """
    boxes: List[Dict] = []

    def _repl(m: "re.Match[str]") -> str:
        label = m.group(1).strip()
        for x1, y1, x2, y2 in _parse_det(m.group(2)):
            box = _scale_box(x1, y1, x2, y2, page_w, page_h)
            if box is not None:
                boxes.append({"text": label[:200], "box": box})
        return label

    md = _TAG_RE.sub(_repl, raw or "")
    md, det_boxes = _extract_prefixes(md, _DET_BLOCK_RE, page_w, page_h)
    boxes.extend(det_boxes)
    md = _STRAY_RE.sub("", md)
    md, plain_boxes = _extract_prefixes(md, _PLAIN_RE, page_w, page_h)
    boxes.extend(plain_boxes)
    return md.strip(), boxes


def stable_prefix_len(raw: str) -> int:
    """Longueur du préfixe de ``raw`` dont le nettoyage ne changera plus.

    Balaye les ouvertures « <| » (et « <｜ » pleine-chasse) : un jeton sans
    fermeture, ou un bloc ``<|ref|>``/``<|det|>`` sans son ``<|/det|>``,
    rend la suite instable (le tag peut encore se compléter). Garde-fou
    ``_HOLD_MAX`` : un « <| » littéral jamais fermé ne bloque pas le live.
    """
    pos = 0
    n = len(raw)
    while True:
        a, b = raw.find("<|", pos), raw.find("<｜", pos)
        i = a if b == -1 else (b if a == -1 else min(a, b))
        if i == -1:
            return n
        ja, jb = raw.find("|>", i + 2), raw.find("｜>", i + 2)
        closes = [x for x in (ja, jb) if x != -1]
        if not closes:
            return n if n - i > _HOLD_MAX else i
        j = min(closes)
        tok = raw[i:j + 2].replace("｜", "|")
        if tok in ("<|ref|>", "<|det|>"):
            # bloc apparié : instable tant que <|/det|> n'est pas arrivé
            k = raw.find("<|/det|>", j + 2)
            if k == -1:
                return n if n - i > _HOLD_MAX else i
            pos = k + len("<|/det|>")
        else:
            pos = j + 2


def _clean_text(raw: str) -> str:
    """Nettoyage SANS extraction de boxes (affichage live) : balises DeepSeek,
    blocs det (--special) et préfixes plats ``label [coords]`` retirés."""
    text = _TAG_RE.sub(lambda m: m.group(1).strip(), raw)
    text = _DET_BLOCK_RE.sub("", text)
    text = _STRAY_RE.sub("", text)
    return _PLAIN_RE.sub("", text)


class StreamSanitizer:
    """Nettoyage incrémental du flux grounding pour l'affichage live.

    ``feed(chunk)`` retourne le texte PROPRE nouvellement émissible (souvent
    vide pendant qu'un tag se complète) ; ``flush()`` vide le reliquat en fin
    de flux. Le nettoyage n'est appliqué qu'au préfixe STABLE du brut, donc
    ce qui a été émis ne change jamais rétroactivement.
    """

    def __init__(self) -> None:
        self._raw = ""
        self._emitted = 0

    def feed(self, chunk: str) -> str:
        self._raw += chunk or ""
        stable = stable_prefix_len(self._raw)
        # Un « < » terminal peut devenir « <| »/« <｜ » au chunk suivant : le
        # retenir un instant — émis trop tôt, il décalerait tout le flux
        # (le garde anti-ré-émission interdit de le reprendre).
        if stable == len(self._raw) and self._raw.endswith("<"):
            stable -= 1
        # Retenir aussi un éventuel préfixe PLAT en cours d'écriture en fin
        # de flux (« table [141, 8 » ) — sinon il s'afficherait puis
        # « disparaîtrait » au nettoyage suivant. Un simple mot en début de
        # ligne n'est retenu qu'un instant : le premier caractère qui casse
        # le motif le libère.
        m = _PLAIN_HOLD_RE.search(self._raw[:stable])
        if m and stable - m.start(1) <= 40:
            stable = m.start(1)
        clean = _clean_text(self._raw[:stable])
        # Ne jamais ré-émettre : si le point stable a reculé (retenue), on
        # n'avance simplement pas.
        out = clean[self._emitted:] if len(clean) > self._emitted else ""
        self._emitted = max(self._emitted, len(clean))
        return out

    def flush(self) -> str:
        clean = _clean_text(self._raw)
        out = clean[self._emitted:]
        self._emitted = len(clean)
        return out


# ─────────────────────────────────────────────────────────────────────────────
#  Appels HTTP
# ─────────────────────────────────────────────────────────────────────────────
def _chat_url(endpoint: str) -> str:
    """Tolère une URL de base (http://host:8090), .../v1 ou l'URL complète."""
    url = (endpoint or "").rstrip("/")
    if "/chat/completions" in url:
        return url
    if url.endswith("/v1"):
        return url + "/chat/completions"
    return url + "/v1/chat/completions"


def _models_url(endpoint: str) -> str:
    url = (endpoint or "").rstrip("/")
    if url.endswith("/chat/completions"):
        url = url[: -len("/chat/completions")]
    if url.endswith("/v1"):
        return url + "/models"
    return url + "/v1/models"


def _parse_models_payload(payload: Dict) -> List[Dict[str, str]]:
    """Modèles depuis ``/v1/models`` — tolère les variantes serveur.

    Retourne ``[{id, state}]`` : OpenAI/llama-server ``{"data": [{"id": …}]}``
    (le ROUTEUR llama.cpp ajoute ``status.value`` : loaded / unloaded /
    loading) ; certains serveurs exposent ``{"models": [str | {…}]}``.
    ``state`` vaut ``""`` quand le serveur ne publie pas d'état (serveur
    mono-modèle : le modèle est de fait chargé). Ordre préservé, doublons
    retirés.
    """
    items = payload.get("data")
    if not isinstance(items, list):
        items = payload.get("models")
    out: List[Dict[str, str]] = []
    seen = set()
    for item in items if isinstance(items, list) else []:
        state = ""
        if isinstance(item, str):
            mid = item
        elif isinstance(item, dict):
            mid = str(item.get("id") or item.get("name") or item.get("model") or "")
            status = item.get("status")
            if isinstance(status, dict):
                state = str(status.get("value") or "").strip().lower()
            elif isinstance(status, str):
                state = status.strip().lower()
        else:
            continue
        mid = mid.strip()
        if mid and mid not in seen:
            seen.add(mid)
            out.append({"id": mid, "state": state})
    return out


async def fetch_models(cfg: Dict) -> List[Dict[str, str]]:
    """Découvre les modèles du serveur OCR (comme le sélecteur llama principal).

    Retourne ``[{id, state}]`` (cf. :func:`_parse_models_payload`).
    :raises OcrError: serveur injoignable / réponse inattendue.
    """
    endpoint = cfg.get("endpoint_url") or ""
    if not endpoint:
        raise OcrError("Serveur OCR non configuré (adresse + port).")
    try:
        async with _client(5.0) as client:
            resp = await client.get(_models_url(endpoint),
                                    headers=_headers(cfg.get("api_key") or ""))
    except _NET_ERRORS as e:
        raise OcrError(f"Serveur OCR injoignable ({e.__class__.__name__}).")
    if resp.status_code != 200:
        raise OcrError(f"Serveur OCR → HTTP {resp.status_code}.")
    try:
        payload = resp.json()
    except ValueError:
        raise OcrError("Réponse /v1/models illisible.")
    return _parse_models_payload(payload if isinstance(payload, dict) else {})


async def ensure_model(cfg: Dict) -> Dict:
    """Garantit un ``cfg["model"]`` non vide avant un appel au modèle.

    Un llama-server en mode ROUTEUR refuse un body sans ``model``
    (« missing model name in request ») ; quand ni le document ni
    ``default_model`` n'en fournissent, on DÉCOUVRE les modèles et on
    choisit : un modèle déjà chargé (state ``loaded``, zéro délai) sinon
    le premier découvert. Best-effort : serveur muet/injoignable ⇒ cfg
    inchangé, l'appel suivant remonte l'erreur serveur telle quelle.
    Mutation en place + retour (patron ``apply_doc_model``).
    """
    if cfg.get("model"):
        return cfg
    try:
        models = await fetch_models(cfg)
    except OcrError:
        return cfg
    if models:
        loaded = next((m["id"] for m in models
                       if (m.get("state") or "") == "loaded"), "")
        cfg["model"] = loaded or models[0]["id"]
    return cfg


async def _lifecycle_post(cfg: Dict, action: str, model: str) -> None:
    """POST ``/models/{load|unload}`` du ROUTEUR llama-server (repli ``/v1/…``).

    Même wire que le serveur llama principal (``llm_core._model_lifecycle``).
    :raises OcrError: refus ou serveur injoignable.
    """
    endpoint = (cfg.get("endpoint_url") or "").rstrip("/")
    if not endpoint:
        raise OcrError("Serveur OCR non configuré.")
    if not model:
        raise OcrError("Modèle requis.")
    base = endpoint[: -len("/v1")] if endpoint.endswith("/v1") else endpoint
    body = {"model": model}
    headers = _headers(cfg.get("api_key") or "")
    # load = jusqu'à 3 min (chargement GGUF) ; unload = rapide.
    timeout = httpx.Timeout(10.0, read=180.0 if action == "load" else 30.0)
    last = None
    try:
        async with _client(timeout) as client:
            for path in (f"{base}/models/{action}", f"{base}/v1/models/{action}"):
                last = await client.post(path, json=body, headers=headers)
                if last.status_code in (200, 201, 204):
                    return
                if last.status_code != 404:
                    break
    except _NET_ERRORS as e:
        raise OcrError(f"Serveur OCR injoignable ({e.__class__.__name__}).")
    detail = ""
    try:
        err = (last.json() or {}).get("error") if last is not None else None
        detail = (err.get("message") if isinstance(err, dict) else str(err or "")).strip()
    except (ValueError, AttributeError):
        pass
    raise OcrError(
        f"{'Chargement' if action == 'load' else 'Déchargement'} refusé "
        f"(HTTP {last.status_code if last is not None else '?'}"
        + (f" : {detail[:160]}" if detail else "")
        + ") — serveur en mode routeur requis.")


async def load_model(cfg: Dict, model: str) -> None:
    await _lifecycle_post(cfg, "load", model)


async def unload_model(cfg: Dict, model: str) -> None:
    await _lifecycle_post(cfg, "unload", model)


def _body(png_bytes: bytes, prompt: str, model: str,
          max_tokens: int, stream: bool) -> Dict:
    data_url = "data:image/png;base64," + base64.b64encode(png_bytes).decode()
    body: Dict = {
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": data_url}},
            ],
        }],
        # Recommandations de la famille DeepSeek-OCR : sampling déterministe.
        "temperature": 0,
        "max_tokens": int(max_tokens),
        "stream": bool(stream),
    }
    if model:
        body["model"] = model
    return body


def _headers(api_key: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {api_key}"} if api_key else {}


async def _raise_http(resp: httpx.Response) -> None:
    detail = ""
    try:
        payload = json.loads(await resp.aread())
        err = payload.get("error")
        detail = (err.get("message") if isinstance(err, dict)
                  else str(err or "")).strip()
    except (ValueError, AttributeError):
        pass
    raise OcrError(f"Endpoint OCR → HTTP {resp.status_code}"
                   + (f" : {detail[:200]}" if detail else ""))


async def stream_ocr(png_bytes: bytes, *, cfg: Dict,
                     prompt: Optional[str] = None,
                     on_delta: Optional[Callable[[str], Awaitable[None]]] = None,
                     ) -> str:
    """OCR d'une image en streaming. Retourne le texte BRUT complet
    (balises grounding comprises) ; ``on_delta`` reçoit chaque delta brut.

    Un flux n'est accepté comme COMPLET que s'il se termine proprement
    (``[DONE]`` ou un ``finish_reason``). Sinon (serveur tombé, proxy coupé),
    une erreur transmise DANS le flux, ou ``finish_reason=length`` : exception
    — la page n'est jamais enregistrée « faite » sur un texte partiel.
    Délai TOTAL par page ``page_deadline_sec`` (le délai de lecture se
    ré-arme à chaque chunk).

    :raises OcrTruncated: plafond de génération atteint (``.raw`` = texte reçu).
    :raises OcrError: tout autre échec.
    """
    endpoint = cfg.get("endpoint_url") or ""
    if not endpoint:
        raise OcrError("Serveur OCR non configuré (Connexions → OCR).")
    body = _body(png_bytes, prompt or cfg.get("prompt") or "",
                 cfg.get("model") or "", cfg.get("max_tokens") or 8192, True)
    timeout = httpx.Timeout(30.0, read=float(cfg.get("timeout_sec") or 180))
    deadline = float(cfg.get("page_deadline_sec") or 900)
    state = {"raw": "", "done": False, "finish": ""}

    async def _consume() -> None:
        async with _client(timeout) as client:
            async with client.stream("POST", _chat_url(endpoint), json=body,
                                     headers=_headers(cfg.get("api_key") or "")
                                     ) as resp:
                if resp.status_code != 200:
                    await _raise_http(resp)
                async for line in resp.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if payload == "[DONE]":
                        state["done"] = True
                        break
                    try:
                        obj = json.loads(payload)
                    except ValueError:
                        continue
                    if not isinstance(obj, dict):
                        continue
                    err = obj.get("error")
                    if err:
                        msg = (err.get("message") if isinstance(err, dict)
                               else str(err)).strip()
                        raise OcrError("Erreur du serveur OCR en cours de "
                                       f"lecture : {msg[:200] or 'inconnue'}")
                    try:
                        choice = (obj.get("choices") or [{}])[0] or {}
                        delta = (choice.get("delta") or {}).get("content") or ""
                        finish = choice.get("finish_reason") or ""
                    except (AttributeError, IndexError, TypeError):
                        continue
                    if finish:
                        state["finish"] = str(finish)
                    if delta:
                        state["raw"] += delta
                        if on_delta is not None:
                            await on_delta(delta)

    try:
        await asyncio.wait_for(_consume(), timeout=deadline)
    except OcrError:
        raise
    except asyncio.TimeoutError:
        raise OcrError(f"Lecture de la page trop longue (plus de {int(deadline)} s).")
    except _NET_ERRORS as e:
        raise OcrError(f"Endpoint OCR injoignable ({e.__class__.__name__}).")
    raw = state["raw"]
    if state["finish"] == "length":
        raise OcrTruncated("Texte coupé : plafond de génération (max_tokens) "
                           "atteint sur cette page.", raw)
    if not state["done"] and not state["finish"]:
        raise OcrError("Flux OCR interrompu avant la fin (serveur arrêté ou "
                       "connexion coupée) — relancez.")
    return raw


def _crop_zone_png(png_path, bbox: List[int]) -> bytes:
    """Crop PNG d'une zone (Pillow, SYNCHRONE — à appeler depuis un thread)."""
    try:
        from PIL import Image  # import tardif (optionnel au boot)
    except ImportError:
        raise OcrError("Pillow absent du serveur — lecture de zone impossible.")
    try:
        with Image.open(png_path) as im:
            x1, y1, x2, y2 = [int(v) for v in bbox]
            x1, x2 = sorted((max(0, min(x1, im.width)), max(0, min(x2, im.width))))
            y1, y2 = sorted((max(0, min(y1, im.height)), max(0, min(y2, im.height))))
            if x2 - x1 < 4 or y2 - y1 < 4:
                raise OcrError("Zone trop petite.")
            buf = io.BytesIO()
            im.crop((x1, y1, x2, y2)).save(buf, format="PNG")
    except OSError:
        # Aperçu absent (préparation en cours, document supprimé) ou illisible.
        raise OcrError("Image de la page indisponible — attendez la fin de la "
                       "préparation.")
    return buf.getvalue()


async def ocr_zone(png_path, bbox: List[int], *, cfg: Dict) -> str:
    """OCR d'une ZONE d'une page (crop Pillow) — réponse nettoyée, non live."""
    png = await asyncio.to_thread(_crop_zone_png, png_path, bbox)
    try:
        raw = await stream_ocr(png, cfg=cfg,
                               prompt=cfg.get("zone_prompt") or "Free OCR.")
    except OcrTruncated as e:
        raw = e.raw          # zone : le texte reçu reste utile tel quel
    return _clean_text(raw).strip()
