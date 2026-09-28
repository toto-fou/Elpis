# SPDX-License-Identifier: MIT
"""shared_infra/appearance/skins.py — registre des skins (intégrés + plugins).

Pourquoi (2026-09-28)
---------------------
La liste des skins était écrite en dur dans ``frontend/js/app-settings.js`` et
le réglage utilisateur ``skin`` acceptait n'importe quelle valeur. On veut :

- un registre UNIQUE des skins intégrés (``frontend/css/skins/skins.json``),
  lu par le serveur et servi au navigateur (``GET /api/skins``) ;
- des skins « plugins » que l'administrateur importe (zip) ou crée depuis la
  console, rangés dans ``SKINS_DIR`` (``user_skins/`` par défaut) ;
- un état d'instance : quels skins sont proposés aux comptes, lequel est le
  défaut (``config.json`` › ``skins`` : ``{"enabled": {id: bool}, "default": id}``).

Règles d'état
-------------
- Un intégré absent de ``enabled`` prend son ``enabled_by_default`` (Kiki :
  désactivé) ; un plugin absent de ``enabled`` est DÉSACTIVÉ : un import
  n'atteint aucun compte tant que l'administrateur ne l'a pas activé.
- « Ardoise » (id ``''``, style.css sans classe) et le skin par défaut sont
  toujours actifs : ils sont le repli de tout le reste.
- Le défaut est ``skins.default`` s'il désigne un skin connu, sinon « elpis ».

Format d'un plugin (``<SKINS_DIR>/<id>/``)
------------------------------------------
``skin.json`` : ``{id, label, description, version?, author?, license?,
darkBase?, swatch: [rail, fond, accent], tokens: {light: {"--x": "v"}, dark:
{...}}, css?: "skin.css", brand?: {name}}``, ``skin.css`` facultatif,
``assets/`` (png, jpg, webp, gif — jamais de SVG : ouvert directement, un SVG
exécute du script sur l'origine de l'application).

Sécurité
--------
Un skin est du CSS servi à TOUS les comptes : tout ce qui entre est validé ici
(identifiant, noms et valeurs de jetons, feuille, images par leurs octets),
à l'import comme à la création, et la feuille est revalidée à chaque rendu
(le dossier peut avoir été modifié à la main). La feuille ne peut charger
aucune ressource externe : seuls ``url(assets/…)`` et les ``data:image/…``
matriciels passent ; ``@import``, ``expression()``, ``-moz-binding``,
``behavior``, ``image-set()`` et les échappements de lettres (qui
permettraient d'écrire ``url(`` sans l'écrire) sont refusés.
"""
from __future__ import annotations

import copy
import fcntl
import hashlib
import io
import json
import logging
import os
import re
import shutil
import uuid
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from shared_infra import config as _cfg

logger = logging.getLogger("uvicorn.error")


# ─────────────────────────────────────────────────────────────────────────────
# Erreurs
# ─────────────────────────────────────────────────────────────────────────────
class SkinError(ValueError):
    """Refus lisible (message en français, rendu tel quel à l'administrateur)."""


class SkinExistsError(SkinError):
    """Un skin porte déjà cet identifiant (import ou création sans écrasement)."""


class SkinNotFoundError(SkinError):
    """Identifiant inconnu."""


# ─────────────────────────────────────────────────────────────────────────────
# Limites et motifs
# ─────────────────────────────────────────────────────────────────────────────
ID_RE = re.compile(r"^[a-z][a-z0-9_-]{1,31}$")
TOKEN_RE = re.compile(r"^--[a-z0-9-]{1,48}$")
ASSET_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(png|jpe?g|webp|gif)$", re.I)
_VERSION_RE = re.compile(r"^[0-9A-Za-z.+-]{1,20}$")
_LICENSE_RE = re.compile(r"^[A-Za-z0-9.+ ()-]{1,40}$")

MAX_TOKEN_VALUE = 200
MAX_TOKENS_PER_MODE = 300
MAX_CSS_BYTES = 256 * 1024
MAX_ASSET_BYTES = 2 * 1024 * 1024
MAX_ASSETS = 50
MAX_JSON_BYTES = 256 * 1024
MAX_EXTRA_BYTES = 64 * 1024
MAX_ZIP_BYTES = 50 * 1024 * 1024
MAX_ZIP_UNCOMPRESSED = MAX_ASSETS * MAX_ASSET_BYTES + MAX_CSS_BYTES + MAX_JSON_BYTES + 4 * MAX_EXTRA_BYTES
MAX_ZIP_FILES = MAX_ASSETS + 8

# Fichiers d'accompagnement tolérés dans un paquet (conservés, jamais servis).
EXTRA_FILES = ("README.md", "LICENSE", "LICENSE.txt", "LICENSE.md")

# Identifiant réservé : ``.elpis-skin-self`` dans une feuille désigne le skin
# lui-même (réécrit au rendu) — c'est ce qui rend un export réimportable sous
# un autre nom.
_SELF_ID = "self"
_SELF_CLASS = ".elpis-skin-" + _SELF_ID

# At-rules admises dans skin.css : aucune ne charge de ressource.
_AT_RULES_OK = frozenset({"media", "supports", "keyframes", "-webkit-keyframes",
                          "layer", "container"})

# Rayons : style.css dérive l'échelle de ``--radius`` AU POINT DE DÉCLARATION
# (``--radius-sm: calc(var(--radius) - 4px)`` dans :root). Un skin qui change
# ``--radius`` sans redéclarer l'échelle garderait les rayons d'Ardoise.
_RADIUS_DERIVES = (
    ("--radius-sm", "calc(var(--radius) - 4px)"),
    ("--radius-md", "calc(var(--radius) - 2px)"),
    ("--radius-lg", "var(--radius)"),
    ("--radius-xl", "calc(var(--radius) + 4px)"),
)

_IMAGE_EXT_TYPE = {"png": "png", "jpg": "jpeg", "jpeg": "jpeg", "webp": "webp", "gif": "gif"}
IMAGE_MIME = {"png": "image/png", "jpeg": "image/jpeg", "webp": "image/webp", "gif": "image/gif"}

_ROOT = Path(_cfg.PROJECT_ROOT)
BUILTIN_MANIFEST = _ROOT / "frontend" / "css" / "skins" / "skins.json"
BUILTIN_CSS_DIR = _ROOT / "frontend" / "css" / "skins"
MASCOTS_JSON = _ROOT / "frontend" / "assets" / "mascotte" / "mascottes.json"

# Replis si un fichier de registre est illisible : l'application doit
# démarrer et rester utilisable (Ardoise + Elpis ; les cinq mascottes).
_BUILTIN_REPLI: Tuple[dict, ...] = (
    {"id": "elpis", "label": "Elpis", "desc": "", "sw": ["#f3efe8", "#fcfbf9", "#b88a3d"],
     "builtin": True, "enabled_by_default": True},
    {"id": "", "label": "Ardoise", "desc": "", "sw": ["#0f172a", "#f8fafc", "#2563eb"],
     "builtin": True, "enabled_by_default": True},
)
_MASCOTTES_REPLI: Tuple[dict, ...] = (
    {"id": "boite_or", "label": "Coffre"},
    {"id": "flamme", "label": "Flamme"},
    {"id": "flamme_bleue", "label": "Flamme bleue", "apercu": False},
    {"id": "fantome", "label": "Fantôme"},
    {"id": "elpis", "label": "Elpis"},
)


def skins_dir() -> Path:
    """Dossier des skins importés (lu à l'appel : les tests le redirigent)."""
    return Path(_cfg.SKINS_DIR)


# ─────────────────────────────────────────────────────────────────────────────
# Petits outils
# ─────────────────────────────────────────────────────────────────────────────
def _read_json_cached(path: Path, cache: dict) -> Any:
    """JSON relu seulement si le fichier a changé (cache par process, clé =
    état du disque : aucun état partagé ne peut diverger entre workers)."""
    st = path.stat()
    key = (st.st_mtime_ns, st.st_size)
    hit = cache.get(str(path))
    if hit and hit[0] == key:
        return copy.deepcopy(hit[1])
    data = json.loads(path.read_text(encoding="utf-8"))
    cache[str(path)] = (key, data)
    return copy.deepcopy(data)


_JSON_CACHE: Dict[str, tuple] = {}


def _clean_text(v: Any, where: str, *, maxlen: int, required: bool = False) -> str:
    if v is None:
        v = ""
    if not isinstance(v, str):
        raise SkinError(f"{where} : texte attendu.")
    v = v.strip()
    if required and not v:
        raise SkinError(f"{where} : obligatoire.")
    if len(v) > maxlen:
        raise SkinError(f"{where} : {maxlen} caractères au plus.")
    if any(ord(c) < 32 or ord(c) == 127 for c in v):
        raise SkinError(f"{where} : caractère de contrôle interdit.")
    return v


def _detect_image(head: bytes) -> Optional[str]:
    """Type d'image d'après les octets (même table que les avatars)."""
    if head.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head.startswith(b"GIF87a") or head.startswith(b"GIF89a"):
        return "gif"
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    return None


def asset_type(name: str) -> str:
    """``png`` / ``jpeg`` / ``webp`` / ``gif`` d'après l'extension."""
    return _IMAGE_EXT_TYPE[name.rsplit(".", 1)[-1].lower()]


# ─────────────────────────────────────────────────────────────────────────────
# Validation : valeurs de jetons et feuille
# ─────────────────────────────────────────────────────────────────────────────
_BAD_VALUE_CHARS = frozenset(';{}<>\\')
_BAD_VALUE_WORDS = ("url(", "@", "expression", "/*", "*/", "image-set", "image(",
                    "src(", "javascript:", "element(", "cross-fade")


def check_token_value(value: Any, where: str) -> str:
    """Valeur d'un jeton CSS : une couleur, une longueur, une pile de polices…
    jamais de quoi sortir de la déclaration ni charger une ressource."""
    if not isinstance(value, str):
        raise SkinError(f"{where} : valeur texte attendue.")
    v = value.strip()
    if not v:
        raise SkinError(f"{where} : valeur vide.")
    if len(v) > MAX_TOKEN_VALUE:
        raise SkinError(f"{where} : {MAX_TOKEN_VALUE} caractères au plus.")
    if any(c in _BAD_VALUE_CHARS for c in v) or any(ord(c) < 32 or ord(c) == 127 for c in v):
        raise SkinError(f"{where} : caractère interdit (; {{ }} < > \\).")
    low = v.lower()
    for bad in _BAD_VALUE_WORDS:
        if bad in low:
            raise SkinError(f"{where} : « {bad} » interdit dans une valeur.")
    return v


def _check_tokens(raw: Any, where: str) -> Dict[str, str]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise SkinError(f"{where} : objet {{\"--jeton\": \"valeur\"}} attendu.")
    if len(raw) > MAX_TOKENS_PER_MODE:
        raise SkinError(f"{where} : {MAX_TOKENS_PER_MODE} jetons au plus.")
    out: Dict[str, str] = {}
    for k, v in raw.items():
        if not isinstance(k, str) or not TOKEN_RE.match(k):
            raise SkinError(f"{where} : nom de jeton invalide {str(k)[:60]!r} (--minuscules-chiffres-tirets).")
        out[k] = check_token_value(v, f"{where} {k}")
    return out


_URL_RE = re.compile(r"url\(\s*(['\"]?)(.*?)\1\s*\)", re.I | re.S)
_DATA_IMG_RE = re.compile(r"^data:image/(png|jpeg|webp|gif)(;base64)?,[A-Za-z0-9+/=%._-]*$", re.I)
_ASSET_REF_RE = re.compile(r"^(?:\./)?assets/([^/\\?#]+)$")
_COMMENT_RE = re.compile(r"/\*.*?\*/", re.S)


def validate_css(text: Any, asset_names: Optional[set] = None) -> str:
    """Valide une feuille de skin ; rend le texte tel quel (la réécriture des
    ``url(assets/…)`` a lieu au rendu). ``asset_names`` : images disponibles
    (None = ne pas vérifier l'existence)."""
    if text is None:
        return ""
    if not isinstance(text, str):
        raise SkinError("skin.css : texte attendu.")
    if len(text.encode("utf-8")) > MAX_CSS_BYTES:
        raise SkinError(f"skin.css : {MAX_CSS_BYTES // 1024} Ko au plus.")
    if "\x00" in text:
        raise SkinError("skin.css : octet nul interdit.")
    # Échappements : seulement pour une ponctuation (``.hover\:bg-x``,
    # ``.w-1\/2``, ``\2c `` = virgule). Un échappement qui produit une lettre
    # ou un chiffre permettrait d'écrire ``u\72l(`` — soit ``url(`` — sans
    # que la chaîne apparaisse.
    for m in re.finditer(r"\\(?:([0-9a-fA-F]{1,6})\s?|(.)|$)", text, re.S):
        if m.group(1):
            try:
                ch = chr(int(m.group(1), 16))
            except (ValueError, OverflowError):
                ch = ""
        else:
            ch = m.group(2) or ""
        if not ch or ch.isalnum() or ch in "\r\n\x00":
            raise SkinError("skin.css : échappement « \\ » autorisé seulement pour une ponctuation.")
    sans_comm = _COMMENT_RE.sub(" ", text)
    if "/*" in sans_comm:
        raise SkinError("skin.css : commentaire non refermé.")
    for source in (text.lower(), sans_comm.lower()):
        for bad, msg in (("</", "« </ » interdit"),
                         ("@import", "@import interdit"),
                         ("expression(", "expression() interdit"),
                         ("-moz-binding", "-moz-binding interdit"),
                         ("javascript:", "javascript: interdit"),
                         ("vbscript:", "vbscript: interdit"),
                         ("image-set(", "image-set() interdit"),
                         ("image(", "image() interdit"),
                         ("src(", "src() interdit"),
                         ("element(", "element() interdit"),
                         ("cross-fade(", "cross-fade() interdit")):
            if bad in source:
                raise SkinError(f"skin.css : {msg}.")
        if re.search(r"behavior\s*:", source):
            raise SkinError("skin.css : behavior interdit.")
    for m in re.finditer(r"@(-?[a-zA-Z][a-zA-Z-]*)", sans_comm):
        if m.group(1).lower() not in _AT_RULES_OK:
            raise SkinError(f"skin.css : @{m.group(1)} interdit (admis : "
                            + ", ".join("@" + a for a in sorted(_AT_RULES_OK)) + ").")
    # Chaque url( doit être une référence reconnue — on compte pour attraper
    # les formes que l'expression régulière ne reconnaîtrait pas.
    urls = list(_URL_RE.finditer(text))
    if len(urls) != text.lower().count("url("):
        raise SkinError("skin.css : url() mal formée.")
    for m in urls:
        arg = m.group(2).strip()
        if _DATA_IMG_RE.match(arg):
            continue
        a = _ASSET_REF_RE.match(arg)
        if a and ASSET_RE.match(a.group(1)):
            if asset_names is not None and a.group(1) not in asset_names:
                raise SkinError(f"skin.css : image absente du paquet : assets/{a.group(1)}.")
            continue
        raise SkinError(f"skin.css : url() refusée ({arg[:60]!r}) — seules assets/<image> "
                        "et data:image/(png|jpeg|webp|gif) sont admises.")
    return text


def _rewrite_css(text: str, skin_id: str) -> str:
    def _sub(m: "re.Match") -> str:
        arg = m.group(2).strip()
        a = _ASSET_REF_RE.match(arg)
        if a:
            return f'url("/api/skins/{skin_id}/assets/{a.group(1)}")'
        return m.group(0)
    text = _URL_RE.sub(_sub, text)
    return text.replace(_SELF_CLASS, ".elpis-skin-" + skin_id)


# ─────────────────────────────────────────────────────────────────────────────
# Validation : manifeste skin.json
# ─────────────────────────────────────────────────────────────────────────────
def _builtin_ids() -> set:
    return {s["id"] for s in builtin_skins()}


def validate_manifest(data: Any, *, has_css: bool = False) -> dict:
    """Manifeste normalisé (champs connus seulement) ou ``SkinError``."""
    if not isinstance(data, dict):
        raise SkinError("skin.json : objet JSON attendu.")
    sid = data.get("id")
    if not isinstance(sid, str) or not ID_RE.match(sid):
        raise SkinError("Identifiant invalide : 2 à 32 caractères, minuscule en tête, "
                        "puis minuscules, chiffres, - ou _.")
    if sid == _SELF_ID:
        raise SkinError("Identifiant réservé : self.")
    if sid in _builtin_ids():
        raise SkinError(f"Identifiant déjà pris par un skin intégré : {sid}.")
    out: dict = {"id": sid}
    out["label"] = _clean_text(data.get("label"), "Nom", maxlen=40, required=True)
    desc = data.get("description", data.get("desc"))
    out["description"] = _clean_text(desc, "Description", maxlen=200)
    ver = _clean_text(data.get("version"), "Version", maxlen=20)
    if ver and not _VERSION_RE.match(ver):
        raise SkinError("Version : chiffres, lettres, . + - seulement.")
    out["version"] = ver or "1.0.0"
    out["author"] = _clean_text(data.get("author"), "Auteur", maxlen=80)
    lic = _clean_text(data.get("license"), "Licence", maxlen=40)
    if lic and not _LICENSE_RE.match(lic):
        raise SkinError("Licence : identifiant SPDX attendu (ex. MIT, CC-BY-4.0).")
    out["license"] = lic
    out["darkBase"] = bool(data.get("darkBase"))
    sw = data.get("swatch", data.get("sw"))
    if not isinstance(sw, list) or len(sw) != 3:
        raise SkinError("Pastilles : trois couleurs attendues [rail, fond, accent].")
    out["swatch"] = [check_token_value(c, f"Pastille {i + 1}") for i, c in enumerate(sw)]
    for c in out["swatch"]:
        if len(c) > 60:
            raise SkinError("Pastilles : 60 caractères au plus.")
    toks = data.get("tokens") or {}
    if not isinstance(toks, dict):
        raise SkinError("tokens : objet {light, dark} attendu.")
    extra = set(toks) - {"light", "dark"}
    if extra:
        raise SkinError("tokens : seules les clés light et dark sont admises.")
    out["tokens"] = {"light": _check_tokens(toks.get("light"), "Jetons clairs"),
                     "dark": _check_tokens(toks.get("dark"), "Jetons sombres")}
    css = data.get("css")
    if css not in (None, "", "skin.css"):
        raise SkinError("css : seule la valeur « skin.css » est admise.")
    if css == "skin.css" and not has_css:
        raise SkinError("skin.json annonce skin.css, absent du paquet.")
    if has_css:
        out["css"] = "skin.css"
    brand = data.get("brand")
    if brand not in (None, {}, ""):
        if not isinstance(brand, dict):
            raise SkinError("brand : objet {name} attendu.")
        name = _clean_text(brand.get("name"), "Nom de marque", maxlen=40)
        if name:
            out["brand"] = {"name": name}
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Registres : intégrés, plugins, mascottes
# ─────────────────────────────────────────────────────────────────────────────
def builtin_skins() -> List[dict]:
    """Skins intégrés, dans l'ordre du manifeste (repli : Elpis + Ardoise)."""
    try:
        doc = _read_json_cached(BUILTIN_MANIFEST, _JSON_CACHE)
        out = []
        for s in doc.get("skins") or []:
            if not isinstance(s, dict) or not isinstance(s.get("id"), str):
                continue
            e = dict(s)
            e["builtin"] = True
            e["enabled_by_default"] = bool(s.get("enabled_by_default", True))
            out.append(e)
        if any(e["id"] == "" for e in out):
            return out
    except Exception:  # noqa: BLE001 — registre illisible : repli, jamais un 500
        logger.warning("[skins] %s illisible : repli Elpis + Ardoise", BUILTIN_MANIFEST, exc_info=True)
    return [dict(e) for e in _BUILTIN_REPLI]


def mascots_catalogue() -> List[dict]:
    """Registre des mascottes (``mascottes.json``), repli sur les cinq d'origine."""
    try:
        doc = _read_json_cached(MASCOTS_JSON, _JSON_CACHE)
        out = []
        for m in doc.get("mascottes") or []:
            if isinstance(m, dict) and isinstance(m.get("id"), str) and m["id"]:
                e = {"id": m["id"], "label": str(m.get("label") or m["id"])}
                if m.get("apercu") is False:
                    e["apercu"] = False
                out.append(e)
        if out:
            return out
    except Exception:  # noqa: BLE001 — repli, jamais un 500
        logger.warning("[skins] %s illisible : repli sur les mascottes d'origine", MASCOTS_JSON, exc_info=True)
    return [dict(m) for m in _MASCOTTES_REPLI]


def mascot_ids() -> Tuple[str, ...]:
    return tuple(m["id"] for m in mascots_catalogue())


_PLUGIN_CACHE: Dict[str, tuple] = {}


def _plugin_key(d: Path) -> tuple:
    js = d / "skin.json"
    css = d / "skin.css"
    st = js.stat()
    try:
        cst = css.stat()
        ck = (cst.st_mtime_ns, cst.st_size)
    except OSError:
        ck = None
    return (st.st_mtime_ns, st.st_size, ck)


def _load_plugin(d: Path) -> Optional[dict]:
    """Plugin validé depuis son dossier, ou None (journalisé)."""
    try:
        key = _plugin_key(d)
    except OSError:
        return None
    hit = _PLUGIN_CACHE.get(str(d))
    if hit and hit[0] == key:
        return copy.deepcopy(hit[1])
    try:
        raw = (d / "skin.json").read_bytes()
        if len(raw) > MAX_JSON_BYTES:
            raise SkinError("skin.json trop volumineux.")
        man = validate_manifest(json.loads(raw.decode("utf-8")),
                                has_css=(d / "skin.css").is_file())
        if man["id"] != d.name:
            raise SkinError(f"l'identifiant {man['id']!r} ne correspond pas au dossier.")
    except (SkinError, ValueError, OSError) as e:
        logger.warning("[skins] skin ignoré %s : %s", d, e)
        return None
    ver = hashlib.sha1(repr(key).encode()).hexdigest()[:10]
    entry = {
        "id": man["id"], "label": man["label"], "desc": man["description"],
        "darkBase": man["darkBase"], "sw": man["swatch"], "builtin": False,
        "enabled_by_default": False, "version": man["version"],
        "author": man["author"], "license": man["license"],
        "tokens": man["tokens"], "has_css": "css" in man, "rev": ver,
    }
    if "brand" in man:
        entry["brand"] = man["brand"]
    _PLUGIN_CACHE[str(d)] = (key, entry)
    return copy.deepcopy(entry)


def plugin_skins() -> List[dict]:
    root = skins_dir()
    if not root.is_dir():
        return []
    reserved = _builtin_ids() | {_SELF_ID}
    out = []
    try:
        dirs = sorted(p for p in root.iterdir() if p.is_dir())
    except OSError:
        return []
    for d in dirs:
        if not ID_RE.match(d.name) or d.name in reserved:
            continue
        e = _load_plugin(d)
        if e:
            out.append(e)
    out.sort(key=lambda e: e["label"].lower())
    return out


def _all_skins() -> Dict[str, dict]:
    out: Dict[str, dict] = {}
    for e in builtin_skins():
        out[e["id"]] = e
    for e in plugin_skins():
        out.setdefault(e["id"], e)
    return out


# ─────────────────────────────────────────────────────────────────────────────
# État d'instance (config.json › skins), relu à chaque appel
# ─────────────────────────────────────────────────────────────────────────────
def _state() -> Tuple[Dict[str, bool], Optional[str]]:
    raw = _cfg.live_config_value("skins", {}) or {}
    if not isinstance(raw, dict):
        raw = {}
    en = raw.get("enabled") if isinstance(raw.get("enabled"), dict) else {}
    d = raw.get("default")
    return {str(k): bool(v) for k, v in en.items()}, (d if isinstance(d, str) else None)


def _default_from(known: Dict[str, dict], d: Optional[str]) -> str:
    if d is not None and d in known:
        return d
    return "elpis" if "elpis" in known else ""


def default_skin() -> str:
    """Skin par défaut de l'instance : ``skins.default`` s'il existe, sinon « elpis »."""
    return _default_from(_all_skins(), _state()[1])


def _enabled_in(known: Dict[str, dict], en: Dict[str, bool], default: str, sid: str) -> bool:
    if sid == "" or sid == default:
        return sid in known
    e = known.get(sid)
    if e is None:
        return False
    if sid in en:
        return en[sid]
    return bool(e.get("enabled_by_default")) if e.get("builtin") else False


def is_enabled(skin_id: str) -> bool:
    known = _all_skins()
    en, d = _state()
    return _enabled_in(known, en, _default_from(known, d), str(skin_id))


def resolve_user_skin(value: Any) -> str:
    """Skin effectif d'un compte : sa valeur si elle est activée, sinon le défaut."""
    if value is None:
        return default_skin()
    v = str(value)
    return v if is_enabled(v) else default_skin()


def _public(e: dict) -> dict:
    out = {"id": e["id"], "label": e.get("label") or e["id"], "desc": e.get("desc") or "",
           "darkBase": bool(e.get("darkBase")), "sw": list(e.get("sw") or []),
           "builtin": bool(e.get("builtin"))}
    if e.get("brand"):
        out["brand"] = dict(e["brand"])
    if e.get("mascot"):
        out["mascot"] = e["mascot"]
    if not e.get("builtin"):
        out["css_url"] = f"/api/skins/{e['id']}/skin.css?v={e.get('rev', '')}"
    return out


def list_skins(include_disabled: bool = False) -> List[dict]:
    """Skins au format de l'interface. ``include_disabled`` (console) ajoute
    les désactivés et l'état : enabled, source, is_default, locked…"""
    known = _all_skins()
    en, d = _state()
    default = _default_from(known, d)
    out = []
    for sid, e in known.items():
        on = _enabled_in(known, en, default, sid)
        if not on and not include_disabled:
            continue
        p = _public(e)
        if include_disabled:
            p.update({
                "enabled": on, "source": "builtin" if e.get("builtin") else "plugin",
                "is_default": sid == default, "locked": sid in ("", default),
                "enabled_by_default": bool(e.get("enabled_by_default")),
                "version": e.get("version", ""), "author": e.get("author", ""),
                "license": e.get("license", ""),
            })
        out.append(p)
    return out


def skin_detail(skin_id: str) -> dict:
    """Définition complète d'un plugin (formulaire « Modifier » de la console)."""
    known = _all_skins()
    e = known.get(skin_id)
    if e is None or e.get("builtin"):
        raise SkinNotFoundError("Skin importé inconnu.")
    d = skins_dir() / skin_id
    css = ""
    if e.get("has_css"):
        try:
            css = (d / "skin.css").read_text(encoding="utf-8")
        except OSError:
            css = ""
    return {"id": e["id"], "label": e["label"], "description": e["desc"],
            "version": e["version"], "author": e["author"], "license": e["license"],
            "darkBase": e["darkBase"], "swatch": e["sw"], "tokens": e["tokens"],
            "brand": e.get("brand") or {}, "css": css, "assets": _asset_names(d)}


def _asset_names(d: Path) -> List[str]:
    a = d / "assets"
    if not a.is_dir():
        return []
    try:
        return sorted(p.name for p in a.iterdir() if p.is_file() and ASSET_RE.match(p.name))
    except OSError:
        return []


# ─────────────────────────────────────────────────────────────────────────────
# Rendu et service
# ─────────────────────────────────────────────────────────────────────────────
def _token_block(selector: str, toks: Dict[str, str]) -> str:
    lines = [f"    {k}: {v};" for k, v in toks.items()]
    if "--radius" in toks:
        lines += [f"    {k}: {v};" for k, v in _RADIUS_DERIVES if k not in toks]
    return selector + " {\n" + "\n".join(lines) + "\n}\n"


def render_css(skin_id: str) -> Optional[str]:
    """Feuille d'un skin : pour un plugin, les blocs de jetons clair/sombre
    générés, l'échelle des rayons, puis ``skin.css`` (``url(assets/…)``
    réécrites vers l'URL servie) ; pour un intégré, son fichier. None si inconnu."""
    known = _all_skins()
    e = known.get(skin_id)
    if e is None:
        return None
    if e.get("builtin"):
        if not skin_id:
            return ""
        try:
            return (BUILTIN_CSS_DIR / f"{skin_id}.css").read_text(encoding="utf-8")
        except OSError:
            return ""
    parts = [f"/* Skin « {skin_id} » — feuille générée par Elpis. */\n"]
    toks = e.get("tokens") or {}
    if toks.get("light"):
        parts.append(_token_block(f"body.elpis-skin-{skin_id}", toks["light"]))
    if toks.get("dark"):
        parts.append(_token_block(f"body.elpis-skin-{skin_id}.elpis-app-dark", toks["dark"]))
    if e.get("has_css"):
        d = skins_dir() / skin_id
        try:
            text = (d / "skin.css").read_text(encoding="utf-8")
            validate_css(text, set(_asset_names(d)))
            parts.append(_rewrite_css(text, skin_id))
        except (SkinError, OSError, UnicodeDecodeError) as exc:
            logger.warning("[skins] skin.css de %s ignorée : %s", skin_id, exc)
    return "\n".join(parts)


def asset_path(skin_id: str, name: str) -> Optional[Path]:
    """Chemin d'une image d'un plugin, ou None (nom invalide, hors dossier, absent)."""
    if not isinstance(skin_id, str) or not ID_RE.match(skin_id):
        return None
    if not isinstance(name, str) or not ASSET_RE.match(name):
        return None
    base = (skins_dir() / skin_id / "assets")
    try:
        root = base.resolve()
        p = (base / name).resolve()
        p.relative_to(root)
        return p if p.is_file() else None
    except (ValueError, OSError):
        return None


# ─────────────────────────────────────────────────────────────────────────────
# Écritures : config.json › skins
# ─────────────────────────────────────────────────────────────────────────────
def _update_config(mutator) -> None:
    """Lire-modifier-écrire de config.json sous le même verrou fichier que
    ``PATCH /api/admin/config`` (``config.json.lock``)."""
    path = Path(_cfg.CONFIG_JSON_PATH)
    lock = path.with_name(path.name + ".lock")
    with open(lock, "a") as lf:
        fcntl.flock(lf.fileno(), fcntl.LOCK_EX)
        try:
            disk: dict = {}
            if path.exists():
                try:
                    disk = json.loads(path.read_text(encoding="utf-8") or "{}")
                except json.JSONDecodeError:
                    raise SkinError("config.json est illisible : corrigez-le avant d'enregistrer.")
                if not isinstance(disk, dict):
                    disk = {}
            mutator(disk)
            _cfg.write_config_json(disk)
        finally:
            fcntl.flock(lf.fileno(), fcntl.LOCK_UN)


def _skins_section(cfg: dict) -> dict:
    sk = cfg.get("skins")
    if not isinstance(sk, dict):
        sk = {}
        cfg["skins"] = sk
    if not isinstance(sk.get("enabled"), dict):
        sk["enabled"] = {}
    return sk


def set_state(enabled: Optional[dict] = None, default: Optional[str] = None) -> None:
    """Applique ``enabled`` (fusion) et/ou ``default``. Le défaut est activé
    d'office ; désactiver Ardoise ou le défaut est refusé."""
    known = _all_skins()
    if enabled is not None and not isinstance(enabled, dict):
        raise SkinError("enabled : objet {id: booléen} attendu.")
    if default is not None and (not isinstance(default, str) or default not in known):
        raise SkinError("Skin par défaut inconnu.")
    for sid in (enabled or {}):
        if sid not in known:
            raise SkinError(f"Skin inconnu : {sid}.")

    def _mut(cfg: dict) -> None:
        sk = _skins_section(cfg)
        cur = sk.get("default")
        eff_default = default if default is not None else _default_from(known, cur if isinstance(cur, str) else None)
        for sid, v in (enabled or {}).items():
            if sid == "":
                continue
            if not bool(v) and sid == eff_default:
                raise SkinError("Le skin par défaut ne peut pas être désactivé.")
            sk["enabled"][sid] = bool(v)
        if default is not None:
            sk["default"] = default
            if default:
                sk["enabled"][default] = True

    _update_config(_mut)


def _forget_state(skin_id: str) -> None:
    def _mut(cfg: dict) -> None:
        sk = _skins_section(cfg)
        sk["enabled"].pop(skin_id, None)
    _update_config(_mut)


def _mark_disabled(skin_id: str) -> None:
    def _mut(cfg: dict) -> None:
        _skins_section(cfg)["enabled"][skin_id] = False
    _update_config(_mut)


# ─────────────────────────────────────────────────────────────────────────────
# Écritures : dossiers de plugins
# ─────────────────────────────────────────────────────────────────────────────
def _manifest_json(norm: dict) -> str:
    return json.dumps(norm, ensure_ascii=False, indent=2) + "\n"


def _write_new_dir(norm: dict, css: Optional[str], assets: Dict[str, bytes],
                   extras: Dict[str, bytes], *, overwrite: bool) -> bool:
    """Écrit le dossier complet d'un skin puis le met en place par renommage.
    Rend True si un skin existait déjà (écrasé)."""
    root = skins_dir()
    root.mkdir(parents=True, exist_ok=True)
    dest = root / norm["id"]
    existed = dest.exists()
    if existed and not overwrite:
        raise SkinExistsError(f"Un skin « {norm['id']} » existe déjà.")
    tmp = root / f".tmp-{norm['id']}-{uuid.uuid4().hex[:8]}"
    try:
        tmp.mkdir()
        (tmp / "skin.json").write_text(_manifest_json(norm), encoding="utf-8")
        if css:
            (tmp / "skin.css").write_text(css, encoding="utf-8")
        if assets:
            (tmp / "assets").mkdir()
            for name, data in assets.items():
                (tmp / "assets" / name).write_bytes(data)
        for name, data in extras.items():
            (tmp / name).write_bytes(data)
        if existed:
            old = root / f".old-{norm['id']}-{uuid.uuid4().hex[:8]}"
            os.rename(dest, old)
            os.rename(tmp, dest)
            shutil.rmtree(old, ignore_errors=True)
        else:
            os.rename(tmp, dest)
        tmp = None
    finally:
        if tmp is not None:
            shutil.rmtree(tmp, ignore_errors=True)
    return existed


def _admin_view(skin_id: str) -> dict:
    for s in list_skins(include_disabled=True):
        if s["id"] == skin_id:
            return s
    raise SkinNotFoundError("Skin inconnu.")


def import_zip(data: bytes, overwrite: bool = False) -> dict:
    """Installe un skin depuis un zip (``skin.json`` à la racine ou dans un
    dossier unique). Un nouveau skin arrive DÉSACTIVÉ ; un skin écrasé garde
    son état."""
    if not data:
        raise SkinError("Fichier vide.")
    if len(data) > MAX_ZIP_BYTES:
        raise SkinError(f"Archive trop volumineuse ({MAX_ZIP_BYTES // 1048576} Mo au plus).")
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise SkinError("Ce fichier n'est pas une archive .zip.")
    with zf:
        infos = [i for i in zf.infolist() if not i.is_dir()]
        if not infos:
            raise SkinError("Archive vide.")
        if len(infos) > MAX_ZIP_FILES:
            raise SkinError(f"Trop de fichiers ({len(infos)} > {MAX_ZIP_FILES}).")
        if sum(max(0, i.file_size) for i in infos) > MAX_ZIP_UNCOMPRESSED:
            raise SkinError("Contenu décompressé trop volumineux.")
        members: Dict[str, zipfile.ZipInfo] = {}
        for i in infos:
            arc = i.filename.replace("\\", "/")
            if "\x00" in arc or arc.startswith("/") or re.match(r"^[A-Za-z]:", arc):
                raise SkinError(f"Chemin d'archive dangereux : {arc[:80]!r}.")
            parts = [p for p in arc.split("/") if p not in ("", ".")]
            if not parts:
                continue
            if ".." in parts:
                raise SkinError(f"Chemin d'archive dangereux (zip-slip) : {arc[:80]}.")
            if parts[0] == "__MACOSX" or any(p.startswith(".") for p in parts):
                continue
            if (i.external_attr >> 16) & 0o170000 == 0o120000:
                raise SkinError(f"Lien symbolique refusé : {arc[:80]}.")
            if i.flag_bits & 0x1:
                raise SkinError("Archive chiffrée refusée.")
            members["/".join(parts)] = i
        if "skin.json" in members:
            prefix = ""
        else:
            roots = {k.split("/", 1)[0] for k in members}
            if len(roots) == 1 and (next(iter(roots)) + "/skin.json") in members:
                prefix = next(iter(roots)) + "/"
            else:
                raise SkinError("skin.json introuvable (à la racine ou dans un dossier unique).")
        manifest_raw = None
        css_raw = None
        assets: Dict[str, bytes] = {}
        extras: Dict[str, bytes] = {}
        for k, info in members.items():
            if not k.startswith(prefix):
                raise SkinError(f"Fichier hors du dossier du skin : {k[:80]}.")
            rel = k[len(prefix):]
            parts = rel.split("/")
            if rel == "skin.json":
                cap = MAX_JSON_BYTES
            elif rel == "skin.css":
                cap = MAX_CSS_BYTES
            elif rel in EXTRA_FILES:
                cap = MAX_EXTRA_BYTES
            elif len(parts) == 2 and parts[0] == "assets":
                if not ASSET_RE.match(parts[1]):
                    raise SkinError(f"Image refusée : {rel[:80]} (png, jpg, webp ou gif ; "
                                    "pas de SVG).")
                cap = MAX_ASSET_BYTES
            else:
                raise SkinError(f"Fichier non autorisé : {rel[:80]} (admis : skin.json, "
                                "skin.css, assets/*.png|jpg|webp|gif, README, LICENSE).")
            if info.file_size > cap:
                raise SkinError(f"{rel} : trop volumineux ({cap // 1024} Ko au plus).")
            blob = zf.read(info)
            if len(blob) > cap:
                raise SkinError(f"{rel} : trop volumineux ({cap // 1024} Ko au plus).")
            if rel == "skin.json":
                manifest_raw = blob
            elif rel == "skin.css":
                css_raw = blob
            elif rel in EXTRA_FILES:
                extras[rel] = blob
            else:
                assets[parts[1]] = blob
    if len(assets) > MAX_ASSETS:
        raise SkinError(f"Trop d'images ({len(assets)} > {MAX_ASSETS}).")
    for name, blob in assets.items():
        if _detect_image(blob[:16]) != asset_type(name):
            raise SkinError(f"assets/{name} : contenu non conforme à l'extension.")
    try:
        manifest = json.loads((manifest_raw or b"").decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise SkinError("skin.json : JSON invalide.")
    css_text = None
    if css_raw is not None:
        try:
            css_text = css_raw.decode("utf-8")
        except UnicodeDecodeError:
            raise SkinError("skin.css : UTF-8 attendu.")
        if isinstance(manifest, dict) and not manifest.get("css"):
            manifest["css"] = "skin.css"
        validate_css(css_text, set(assets))
    norm = validate_manifest(manifest, has_css=css_text is not None)
    existed = _write_new_dir(norm, css_text, assets, extras, overwrite=overwrite)
    if not existed:
        _mark_disabled(norm["id"])
    logger.info("[skins] skin %s importé (%d image(s))", norm["id"], len(assets))
    return _admin_view(norm["id"])


def save_from_editor(payload: Any) -> dict:
    """Création (``update`` absent) ou mise à jour d'un plugin depuis le
    formulaire de la console. Les images d'un skin existant sont conservées."""
    if not isinstance(payload, dict):
        raise SkinError("Objet JSON attendu.")
    update = bool(payload.get("update"))
    css_text = payload.get("css") or ""
    if not isinstance(css_text, str):
        raise SkinError("CSS avancé : texte attendu.")
    has_css = bool(css_text.strip())
    fields = ("id", "label", "description", "version", "author", "license",
              "darkBase", "swatch", "tokens", "brand")
    manifest = {k: payload.get(k) for k in fields}
    if has_css:
        manifest["css"] = "skin.css"
    norm = validate_manifest(manifest, has_css=has_css)
    dest = skins_dir() / norm["id"]
    if update and not dest.is_dir():
        raise SkinNotFoundError("Skin à modifier introuvable.")
    if not update:
        if dest.exists():
            raise SkinExistsError(f"Un skin « {norm['id']} » existe déjà.")
        if has_css:
            validate_css(css_text, set())
        _write_new_dir(norm, css_text if has_css else None, {}, {}, overwrite=False)
        _mark_disabled(norm["id"])
    else:
        if has_css:
            validate_css(css_text, set(_asset_names(dest)))
        _cfg.write_text_atomic(dest / "skin.json", _manifest_json(norm))
        if has_css:
            _cfg.write_text_atomic(dest / "skin.css", css_text)
        else:
            try:
                (dest / "skin.css").unlink()
            except FileNotFoundError:
                pass
    return _admin_view(norm["id"])


def delete(skin_id: str) -> None:
    """Supprime un plugin (jamais un intégré, jamais le skin par défaut)."""
    known = _all_skins()
    e = known.get(skin_id)
    if e is None:
        raise SkinNotFoundError("Skin inconnu.")
    if e.get("builtin"):
        raise SkinError("Un skin intégré ne se supprime pas : désactivez-le.")
    if skin_id == default_skin():
        raise SkinError("C'est le skin par défaut : choisissez-en un autre d'abord.")
    root = skins_dir()
    dest = root / skin_id
    old = root / f".old-{skin_id}-{uuid.uuid4().hex[:8]}"
    os.rename(dest, old)
    shutil.rmtree(old, ignore_errors=True)
    _PLUGIN_CACHE.pop(str(dest), None)
    _forget_state(skin_id)
    logger.info("[skins] skin %s supprimé", skin_id)


# ─────────────────────────────────────────────────────────────────────────────
# Export
# ─────────────────────────────────────────────────────────────────────────────
def export_zip(skin_id: str) -> Tuple[str, bytes]:
    """(nom de fichier, octets) du zip d'un skin, au format d'import.

    Un intégré s'exporte comme MODÈLE : identifiant ``<id>-perso`` (un
    intégré ne peut pas être réimporté sous son nom), ``skin.json`` généré et
    sa feuille telle quelle, sélecteurs ``.elpis-skin-<id>`` réécrits en
    ``.elpis-skin-self`` pour suivre le nouvel identifiant."""
    known = _all_skins()
    e = known.get(skin_id)
    if e is None:
        raise SkinNotFoundError("Skin inconnu.")
    buf = io.BytesIO()
    if e.get("builtin"):
        new_id = (skin_id or "ardoise") + "-perso"
        css = ""
        if skin_id:
            try:
                css = (BUILTIN_CSS_DIR / f"{skin_id}.css").read_text(encoding="utf-8")
            except OSError:
                css = ""
            css = css.replace(".elpis-skin-" + skin_id, _SELF_CLASS)
        man = {"id": new_id, "label": (e.get("label") or new_id)[:32] + " perso",
               "description": (e.get("desc") or "")[:200], "version": "1.0.0",
               "author": "", "license": "MIT", "darkBase": bool(e.get("darkBase")),
               "swatch": list(e.get("sw") or ["#0f172a", "#f8fafc", "#2563eb"]),
               "tokens": {"light": {}, "dark": {}}}
        if css:
            man["css"] = "skin.css"
        if e.get("brand"):
            man["brand"] = dict(e["brand"])
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr(f"{new_id}/skin.json", _manifest_json(man))
            if css:
                z.writestr(f"{new_id}/skin.css", css)
        return f"skin-{new_id}.zip", buf.getvalue()
    d = skins_dir() / skin_id
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name in ("skin.json", "skin.css", *EXTRA_FILES):
            p = d / name
            if p.is_file() and not p.is_symlink():
                z.write(p, f"{skin_id}/{name}")
        for name in _asset_names(d):
            p = d / "assets" / name
            if not p.is_symlink():
                z.write(p, f"{skin_id}/assets/{name}")
    return f"skin-{skin_id}.zip", buf.getvalue()
