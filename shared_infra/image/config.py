# SPDX-License-Identifier: MIT
"""Configuration du moteur d'images — défauts, bornes, lecture à chaud.

Même doctrine que ``shared_infra/voice/config.py`` : ``get_image_config()``
relit ``config.json`` (par ``config_view()``) à chaque appel, pour qu'un réglage
de la console s'applique dans TOUS les workers sans redémarrage, et les bornes
sont appliquées ici, à la lecture — l'enregistrement champ par champ de la
console écrit les valeurs telles quelles.

Un seul moteur actif, de l'un de deux types :

  * ``sdcpp``  — ``sd-server`` de stable-diffusion.cpp, API native
                 ``/sdcpp/v1`` (file d'attente, annulation, limites annoncées) ;
  * ``openai`` — tout service compatible ``POST /v1/images/generations``
                 (gpt-image, LocalAI, sd-server en dialecte OpenAI…).

La clé API n'est JAMAIS en clair dans ``config.json`` : ``api_key_enc`` porte le
jeton Fernet écrit par ``PUT /api/admin/image/key`` (:func:`write_api_key`),
déchiffré ici côté hôte seulement. Aucune route ne la renvoie. Elle est
scellée avec l'ORIGINE du moteur (``schéma://hôte:port``) : changer l'adresse
vers une autre machine la rend inutilisable, il faut la ressaisir
(:func:`seal_api_key`, :func:`api_key`).

sd-server tient sa propre file et accepte toute taille au multiple de 64 :
pour lui, ``max_concurrent`` et la liste de tailles fixes ne s'appliquent pas
(:func:`get_image_config` les neutralise).
"""
from __future__ import annotations

import fcntl
import json
import math
import re
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlsplit

from shared_infra.config import config_view

PROVIDERS = ("sdcpp", "openai")
# Édition d'une image (sd-server) : « init » = img2img (image de départ +
# force), « ref » = image de référence (modèles d'édition : FLUX.2 klein,
# Qwen-Image-Edit). Le dialecte OpenAI passe toujours par /v1/images/edits.
EDIT_MODES = ("init", "ref")
# Tailles : « free » = largeur × hauteur au multiple de 64 (modèles de
# diffusion) ; « fixed » = liste fermée (gpt-image, dall-e).
SIZE_POLICIES = ("free", "fixed")

IMAGE_DEFAULTS: Dict[str, Any] = {
    # Défaut OFF : rien ne part vers une machine tant que l'administrateur n'a
    # pas renseigné une adresse ET coché la case.
    "enabled": False,
    "provider": "sdcpp",
    "url": "",
    "model": "",
    "api_key_enc": "",
    # Vérification TLS : magasin du système (PKI interne) + ``ca_pem``.
    "verify": True,
    "ca_pem": "",
    "timeout_sec": 180,
    # Générations simultanées vers un service compatible OpenAI, tous workers
    # confondus ; sd-server tient sa propre file.
    "max_concurrent": 1,
    "max_n": 4,
    # Plus grand côté qu'un utilisateur peut demander, et côté proposé.
    "max_side": 2048,
    "default_side": 1024,
    "size_policy": "free",
    "sizes": [],
    "edit_mode": "init",
    "keep_per_user": 50,
    # Groupes autorisés (ids) ; vide = tout le monde.
    "groups": [],
    # Appels de l'outil ``generate_image`` par tour du modèle.
    "tool_max_calls": 4,
    # « Enrichir » (description réécrite par le modèle du chat) proposé.
    "enhance_enabled": True,
}

_BORNES: Dict[str, Tuple[int, int]] = {
    "timeout_sec": (10, 1800),
    "max_concurrent": (1, 8),
    "max_n": (1, 8),
    "max_side": (256, 4096),
    "default_side": (256, 4096),
    "keep_per_user": (1, 1000),
    "tool_max_calls": (1, 20),
}

SIZE_RE = re.compile(r"^(\d{2,4})x(\d{2,4})$")
SIZE_MIN, SIZE_MAX = 64, 4096
SIZE_STEP = 64          # multiple exigé en pratique par les modèles de diffusion

# Formats proposés (largeur:hauteur) ; l'interface en montre cinq et un bouton
# d'orientation, le serveur accepte les deux sens.
RATIOS = ("1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "21:9", "9:21")
_ALIAS = {"square": "1:1", "portrait": "2:3", "landscape": "3:2"}
# Tailles (plus grand côté) proposées, filtrées par ``max_side``.
SIDES = (512, 768, 1024, 1280, 1536, 2048)
# Tailles d'un service OpenAI quand l'administrateur n'en donne pas.
_FIXED_SIZES_DEFAUT = ("1024x1024", "1536x1024", "1024x1536")
_DALLE3 = re.compile(r"^dall-e-3", re.I)
_CA_MAX = 64 * 1024


def _texte(valeur: Any, defaut: str) -> str:
    if valeur is None:          # ``str(None)`` vaudrait « None »
        return defaut
    v = str(valeur).strip()
    return v or defaut


def _booleen(valeur: Any, defaut: bool) -> bool:
    if valeur is None:
        return defaut
    if isinstance(valeur, bool):
        return valeur
    t = str(valeur).strip().lower()
    if not t:
        return defaut
    return t not in ("false", "0", "non", "no", "off")


def _entier(cle: str, valeur: Any, defaut: int) -> int:
    bas, haut = _BORNES[cle]
    try:
        f = float(valeur)
        v = int(f) if math.isfinite(f) else int(defaut)
    except (TypeError, ValueError, OverflowError):
        v = int(defaut)
    return max(bas, min(haut, v))


def parse_size(size: Any) -> Optional[Tuple[int, int]]:
    """``"1024x768"`` → ``(1024, 768)`` ; ``None`` si la forme est invalide."""
    m = SIZE_RE.match(str(size or "").strip().lower())
    if not m:
        return None
    w, h = int(m.group(1)), int(m.group(2))
    if not (SIZE_MIN <= w <= SIZE_MAX and SIZE_MIN <= h <= SIZE_MAX):
        return None
    return w, h


def round_step(v: float) -> int:
    return max(SIZE_STEP, int(round(v / SIZE_STEP)) * SIZE_STEP)


def size_for_ratio(ratio: str, long_side: int) -> Tuple[int, int]:
    """``("16:9", 1024)`` → ``(1024, 576)`` ; ratio inconnu → carré."""
    ratio = _ALIAS.get(str(ratio or "").strip().lower(), str(ratio or "").strip())
    try:
        a, b = (float(x) for x in ratio.split(":", 1))
        if a <= 0 or b <= 0:
            raise ValueError
    except (ValueError, TypeError):
        a, b = 1.0, 1.0
    if a >= b:
        return round_step(long_side), round_step(long_side * b / a)
    return round_step(long_side * a / b), round_step(long_side)


def _groupes(valeur: Any) -> List[int]:
    if not isinstance(valeur, list):
        return []
    out: List[int] = []
    for v in valeur[:200]:
        try:
            g = int(v)
        except (TypeError, ValueError):
            continue
        if g > 0 and g not in out:
            out.append(g)
    return out


def _tailles(valeur: Any) -> List[str]:
    if not isinstance(valeur, list):
        return []
    out: List[str] = []
    for v in valeur[:20]:
        wh = parse_size(v)
        if wh and f"{wh[0]}x{wh[1]}" not in out:
            out.append(f"{wh[0]}x{wh[1]}")
    return out


def get_image_config() -> Dict[str, Any]:
    """Configuration coercée (défauts + bornes), fraîche du disque.

    ``enabled`` est strict (``is True``). ``api_key_enc`` est rendu tel quel :
    seul :func:`api_key` le déchiffre, et aucune route ne le renvoie.
    """
    brut = (config_view() or {}).get("image") or {}
    if not isinstance(brut, dict):
        brut = {}
    d = IMAGE_DEFAULTS
    provider = _texte(brut.get("provider"), d["provider"]).lower()
    if provider not in PROVIDERS:
        provider = d["provider"]
    edit_mode = _texte(brut.get("edit_mode"), d["edit_mode"]).lower()
    if edit_mode not in EDIT_MODES:
        edit_mode = d["edit_mode"]
    policy = _texte(brut.get("size_policy"), d["size_policy"]).lower()
    if policy not in SIZE_POLICIES:
        policy = d["size_policy"]
    if provider == "sdcpp":
        policy = "free"
    max_side = _entier("max_side", brut.get("max_side"), d["max_side"])
    ca = str(brut.get("ca_pem") or "").strip()
    return {
        "enabled": brut.get("enabled") is True,
        "provider": provider,
        # L'adresse ne vient QUE d'ici, jamais du navigateur.
        "url": _texte(brut.get("url"), "").rstrip("/"),
        "model": _texte(brut.get("model"), ""),
        "api_key_enc": str(brut.get("api_key_enc") or "").strip(),
        "verify": _booleen(brut.get("verify"), d["verify"]),
        "ca_pem": ca if len(ca) <= _CA_MAX else "",
        "timeout_sec": _entier("timeout_sec", brut.get("timeout_sec"), d["timeout_sec"]),
        "max_concurrent": (_entier("max_concurrent", brut.get("max_concurrent"),
                                   d["max_concurrent"]) if provider == "openai" else 1),
        "max_n": _entier("max_n", brut.get("max_n"), d["max_n"]),
        "max_side": max_side,
        "default_side": min(max_side, _entier("default_side", brut.get("default_side"),
                                              d["default_side"])),
        "size_policy": policy,
        "sizes": _tailles(brut.get("sizes")) or (list(_FIXED_SIZES_DEFAUT)
                                                 if policy == "fixed" else []),
        "edit_mode": edit_mode,
        "keep_per_user": _entier("keep_per_user", brut.get("keep_per_user"),
                                 d["keep_per_user"]),
        "groups": _groupes(brut.get("groups")),
        "tool_max_calls": _entier("tool_max_calls", brut.get("tool_max_calls"),
                                  d["tool_max_calls"]),
        "enhance_enabled": _booleen(brut.get("enhance_enabled"), d["enhance_enabled"]),
    }


def engine_origin(url: Any) -> str:
    """``schéma://hôte:port`` d'une adresse (port par défaut explicite,
    minuscules) ; ``""`` si ce n'est pas une adresse http(s)."""
    try:
        parts = urlsplit(str(url or "").strip())
        scheme = (parts.scheme or "").lower()
        host = (parts.hostname or "").lower()
        port = parts.port or {"http": 80, "https": 443}.get(scheme)
    except ValueError:
        return ""
    if scheme not in ("http", "https") or not host or not port:
        return ""
    return f"{scheme}://{host}:{port}"


def seal_api_key(key: str, url: str) -> str:
    """Contenu à chiffrer : la clé et l'origine du moteur auquel elle est
    destinée."""
    return json.dumps({"k": key, "o": engine_origin(url)}, ensure_ascii=False)


def _sealed(cfg: Dict[str, Any]) -> Optional[Dict[str, str]]:
    enc = str(cfg.get("api_key_enc") or "")
    if not enc:
        return None
    from shared_infra.security.encryption import decrypt
    try:
        data = json.loads(decrypt(enc) or "null")
    except ValueError:
        return None
    if not isinstance(data, dict) or not isinstance(data.get("k"), str) \
            or not isinstance(data.get("o"), str):
        return None
    return {"k": data["k"], "o": data["o"]}


def api_key(cfg: Dict[str, Any]) -> str:
    """Clé API en clair (côté hôte seulement) pour l'adresse de ``cfg`` ;
    ``""`` si absente, illisible, ou scellée pour une autre origine."""
    sealed = _sealed(cfg)
    if not sealed or not sealed["o"] or sealed["o"] != engine_origin(cfg.get("url")):
        return ""
    return sealed["k"]


def key_state(cfg: Dict[str, Any]) -> Dict[str, bool]:
    """``has_key`` : une clé utilisable pour l'adresse enregistrée ;
    ``stale`` : une clé existe, mais pour une autre adresse (à ressaisir)."""
    usable = bool(api_key(cfg))
    return {"has_key": usable, "stale": bool(cfg.get("api_key_enc")) and not usable}


def image_ready(cfg: Optional[Dict[str, Any]] = None) -> bool:
    """Le moteur est activé ET a une adresse : ce que l'instance peut proposer.

    Une adresse vide vaut « éteint » : sans elle, l'entrée existerait sans
    aboutir nulle part.
    """
    cfg = cfg or get_image_config()
    return bool(cfg.get("enabled") and cfg.get("url"))


def features(cfg: Dict[str, Any]) -> Dict[str, bool]:
    """Ce que le moteur configuré comprend : l'interface n'offre que ça."""
    sd = cfg.get("provider") == "sdcpp"
    return {"seed": sd, "negative": sd, "steps": sd,
            "strength": sd and cfg.get("edit_mode") == "init", "edit": True}


def effective_max_n(cfg: Dict[str, Any]) -> int:
    """Nombre d'images par demande : borne de l'administrateur, et 1 pour
    dall-e-3 qui refuse ``n > 1``."""
    if cfg.get("provider") == "openai" and _DALLE3.match(cfg.get("model") or ""):
        return 1
    return int(cfg.get("max_n") or 1)


def sides_for(cfg: Dict[str, Any]) -> List[int]:
    return [s for s in SIDES if s <= cfg["max_side"]] or [cfg["max_side"]]


def public_status(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Ce que le navigateur a le droit de savoir : ni adresse, ni clé."""
    return {
        "provider": cfg["provider"],
        "model": cfg["model"],
        "ratios": list(RATIOS),
        "sides": sides_for(cfg),
        "default_side": cfg["default_side"],
        "max_side": cfg["max_side"],
        "step": SIZE_STEP,
        "max_n": effective_max_n(cfg),
        "size_policy": cfg["size_policy"],
        "sizes": list(cfg["sizes"]) if cfg["size_policy"] == "fixed" else [],
        "features": features(cfg),
        "enhance_enabled": cfg["enhance_enabled"],
        "keep_per_user": cfg["keep_per_user"],
    }


def write_api_key(enc: str) -> None:
    """Écrit ``image.api_key_enc`` sous le verrou de ``config.json`` (le même
    que l'enregistrement champ par champ de la console)."""
    from shared_infra.config import CONFIG_JSON_PATH, read_config_json, write_config_json
    lock_path = CONFIG_JSON_PATH.with_name(CONFIG_JSON_PATH.name + ".lock")
    with open(lock_path, "a") as lf:
        fcntl.flock(lf.fileno(), fcntl.LOCK_EX)
        try:
            cfg = read_config_json()
            section = cfg.get("image")
            if not isinstance(section, dict):
                section = cfg["image"] = {}
            section["api_key_enc"] = enc
            write_config_json(cfg)
        finally:
            fcntl.flock(lf.fileno(), fcntl.LOCK_UN)
