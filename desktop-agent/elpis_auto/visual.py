# SPDX-License-Identifier: MIT
"""elpis_auto.visual — replis VISUELS d'une cible.

  • ``locate_template(png, chemin_vignette)`` : la vignette découpée dans la
    capture à l'enregistrement est retrouvée dans l'écran courant par
    corrélation croisée NORMALISÉE (niveaux de gris, multi-échelle 0,8–1,25),
    en local, sans serveur. Exige Pillow + numpy (dans requirements.txt).
  • ``locate_describe(png, description)`` : la vision d'Elpis
    (``POST {ELPIS_URL}/api/desktop/locate``) situe « le bouton vert d'exécution ».
    Exige ELPIS_URL (+ ELPIS_TOKEN) — c'est le cas ``needs=["vision"]``.

Les deux rendent ``{"rect": (x, y, w, h), "score": s}`` ou None.
"""
from __future__ import annotations

import io
import json
import os
from typing import Any, Dict, Optional

SCALES = (1.0, 0.9, 1.1, 0.8, 1.25)
THRESHOLD = 0.85


def _gray(png: bytes):
    import numpy as np
    from PIL import Image
    im = Image.open(io.BytesIO(png)).convert("L")
    return np.asarray(im, dtype=np.float64), im.size


def _ncc(screen, tpl):
    """Corrélation croisée normalisée (Lewis 1995) par FFT + tables de sommes.
    Rend la carte des scores (H-h+1, W-w+1)."""
    import numpy as np
    H, W = screen.shape
    h, w = tpl.shape
    if h > H or w > W or h < 4 or w < 4:
        return None
    t = tpl - tpl.mean()
    tn = float(np.sqrt((t * t).sum()))
    if tn < 1e-6:
        return None
    # corrélation brute par FFT
    fs = np.fft.rfft2(screen, s=(H + h - 1, W + w - 1))
    ft = np.fft.rfft2(t[::-1, ::-1], s=(H + h - 1, W + w - 1))
    corr = np.fft.irfft2(fs * ft, s=(H + h - 1, W + w - 1))[h - 1:H, w - 1:W]
    # normalisation locale : somme et somme des carrés sous la fenêtre — en float64 :
    # en float32, les tables cumulées d'un écran 1920×1080 perdaient la précision
    # loin du coin haut-gauche (score d'une copie EXACTE : 1.0 en (10,10), 0.24 au centre).
    ones = np.ones((h, w), dtype=np.float64)
    s1 = np.cumsum(np.cumsum(np.pad(screen, ((1, 0), (1, 0))), 0), 1)
    s2 = np.cumsum(np.cumsum(np.pad(screen * screen, ((1, 0), (1, 0))), 0), 1)
    win_sum = s1[h:, w:] - s1[:-h, w:] - s1[h:, :-w] + s1[:-h, :-w]
    win_sq = s2[h:, w:] - s2[:-h, w:] - s2[h:, :-w] + s2[:-h, :-w]
    n = float(h * w)
    var = win_sq - (win_sum * win_sum) / n
    var[var < 1e-6] = np.inf
    del ones
    return corr / (np.sqrt(var) * tn)


def locate_template(png: bytes, template_path: str) -> Optional[Dict[str, Any]]:
    """Meilleure occurrence de la vignette dans la capture, ou None sous le seuil."""
    if not os.path.isfile(template_path):
        return None
    try:
        import numpy as np
        from PIL import Image
    except ImportError as e:                  # numpy absent : le repli visuel n'est pas disponible
        raise RuntimeError(f"repli image indisponible ({e}) : pip install numpy Pillow")
    screen, _ = _gray(png)
    tpl_im = Image.open(template_path).convert("L")
    best: Optional[Dict[str, Any]] = None
    for sc in SCALES:
        w, h = max(4, int(round(tpl_im.width * sc))), max(4, int(round(tpl_im.height * sc)))
        tpl = np.asarray(tpl_im.resize((w, h)), dtype=np.float64)
        m = _ncc(screen, tpl)
        if m is None:
            continue
        idx = int(np.argmax(m))
        y, x = divmod(idx, m.shape[1])
        score = float(m[y, x])
        if best is None or score > best["score"]:
            best = {"rect": (int(x), int(y), int(w), int(h)), "score": round(score, 4), "scale": sc}
        if score >= 0.97:
            break
    if best is None or best["score"] < THRESHOLD:
        return None
    return best


def locate_describe(png: bytes, describe: str, timeout: float = 30.0) -> Optional[Dict[str, Any]]:
    """La vision d'Elpis situe ``describe`` dans la capture (rect en px écran)."""
    base = (os.environ.get("ELPIS_URL") or "").rstrip("/")
    if not base:
        raise RuntimeError("describe= exige la vision d'Elpis : définis ELPIS_URL (et ELPIS_TOKEN)")
    import base64
    import urllib.request
    body = json.dumps({"image_b64": base64.b64encode(png).decode("ascii"), "describe": str(describe)}).encode("utf-8")
    req = urllib.request.Request(base + "/api/desktop/locate", data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    tok = os.environ.get("ELPIS_TOKEN") or ""
    if tok:
        req.add_header("Authorization", "Bearer " + tok)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read().decode("utf-8") or "{}")
    box = data.get("box")
    if not data.get("ok") or not box or len(box) < 4:
        return None
    x1, y1, x2, y2 = [int(v) for v in box[:4]]
    return {"rect": (x1, y1, x2 - x1, y2 - y1), "score": float(data.get("confidence") or 0)}
