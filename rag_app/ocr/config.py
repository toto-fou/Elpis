# SPDX-License-Identifier: MIT
"""rag_app.ocr.config — configuration de la feature « Documents » (OCR).

Lecture À LA DEMANDE : chaque appel consulte le bloc ``ocr`` de
``rag_config.json`` — via un cache invalidé par (mtime, taille) du fichier
(passe RAG 2, 2026-09-26 : la relecture JSON complète à CHAQUE requête, gate
compris, coûtait une E/S disque sur la boucle) — priorité env ``APP_OCR_*`` > rag_config.json
> défaut. Le bloc vit dans le MÊME fichier que le reste de la config rag_app
(persisté par ``POST /api/config`` via ``engine.save_config``), mais est lu
ici indépendamment : pas de dépendance sur ``rag_engine``.

MÊME MODÈLE QUE LES AUTRES BACKENDS : l'admin renseigne l'ADRESSE (hôte/IP +
port) du serveur OCR (llama-server, vLLM… OpenAI-compatible) et l'app
DÉCOUVRE les modèles disponibles via ``GET /v1/models``
(``client.fetch_models``). L'onglet Documents propose un sélecteur parmi ces
modèles ; le choix part dans le champ ``model`` du body (routage router
llama.cpp) et chaque document mémorise le modèle qui l'a traité
(``meta.model``).

Bloc ``ocr`` de rag_config.json (UI : Connexions → OCR) ::

    "ocr": {
        "enabled": true,
        "host": "127.0.0.1", "port": 8083,
        "api_key": "",
        "prompt": "",          // vide = défaut grounding (famille DeepSeek)
        "zone_prompt": "",     // vide = « Free OCR. »
        "default_model": "",   // vide = premier modèle découvert
        "max_side_px": 1280, "max_upload_mb": 100, "max_pages": 300,
        "store_dir": "OCR_STORE",
        "collection": "ocr-documents", "auto_index": false
    }

Rétro-compat : ``ocr.endpoint_url`` (URL complète) reste accepté si
``host`` est vide.
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any, Dict

# Racine du service (dossier rag_app/) — indépendante du cwd.
BASE_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = BASE_DIR / "rag_config.json"

# Prompts par défaut de la famille DeepSeek-OCR (dont Unlimited-OCR est
# dérivé). « grounding » = le Markdown est entrelacé de balises
# <|ref|>…<|/ref|><|det|>[[x1,y1,x2,y2]]<|/det|> (coordonnées normalisées
# 0-1000) que ``client.parse_grounding`` extrait en boxes. Un modèle qui
# ignore ces balises dégrade proprement : markdown sans boxes.
_DEFAULT_PROMPT = "<|grounding|>Convert the document to markdown."
_DEFAULT_ZONE_PROMPT = "Free OCR."

_DEFAULTS: Dict[str, Any] = {
    "enabled":       True,    # la feature est native ici (pas d'opt-in admin)
    "host":          "",      # IP/hôte du serveur OCR
    "port":          8090,    # port du serveur OCR
    "endpoint_url":  "",      # alternative : URL complète (si host vide)
    "api_key":       "",
    "prompt":        _DEFAULT_PROMPT,
    "zone_prompt":   _DEFAULT_ZONE_PROMPT,
    "default_model": "",      # vide = premier modèle découvert par /v1/models
    "timeout_sec":   180,     # par page (le streaming ré-arme entre chunks)
    # Délai TOTAL d'une page (le délai ci-dessus se ré-arme à chaque chunk :
    # un serveur qui envoie des lignes vides tiendrait le slot sans fin).
    "page_deadline_sec": 900,
    # Délai total de la PRÉPARATION (conversion Word + raster des pages).
    "prepare_timeout_sec": 900,
    "max_tokens":    8192,    # plafond de génération par page
    "max_side_px":   1280,    # grand côté du raster de page (budget tokens vision)
    "max_upload_mb": 100,
    "max_pages":     300,     # au-delà : pages ignorées + meta.truncated
    "max_docs":      200,     # plafond global (service mono-tenant)
    # Quota DISQUE du store OCR (pages PNG + brut + résultats).
    # ⚠ toujours actif (la coercition interdit 0) : mettre très grand pour
    # « désactiver » en pratique.
    "max_disk_mb":   8192,
    # Pause de TRANSITION entre deux pages en live (ms) : la page finie reste
    # affichée avec ses boxes avant la bascule. 1 = quasi désactivé.
    "page_transition_ms": 800,
    # Store disque des documents (relatif à rag_app/ si non absolu).
    "store_dir":     "OCR_STORE",
    # Indexation RAG (in-process) : collection unique mono-tenant, et
    # indexation automatique en fin de reconnaissance (défaut OFF — rien
    # ne part dans le RAG sans geste explicite).
    "collection":    "ocr-documents",
    "auto_index":    False,
    # Fichier d'état SÉPARÉ pour les miroirs OCR : le startup_reembed_check
    # de la collection par défaut ne doit pas « adopter » les fichiers OCR.
    "state_file":    "rag_ocr_state.json",
}
_INT_KEYS = ("port", "timeout_sec", "page_deadline_sec",
             "prepare_timeout_sec", "max_tokens", "max_side_px",
             "max_upload_mb", "max_pages", "max_docs", "max_disk_mb",
             "page_transition_ms")
# ⚠ sans cette liste, la coercition str() rendrait un défaut booléen False
# toujours truthy ("False" est une chaîne non vide).
_BOOL_KEYS = ("enabled", "auto_index")


# Cache du bloc ``ocr`` : (clé de fichier, section). La clé = (mtime_ns,
# taille) ; toute écriture de rag_config.json (UI, édition manuelle) la change.
_CACHE_LOCK = threading.Lock()
_CACHE: list = [None, {}]


def invalidate_cache() -> None:
    """Oublie le bloc mis en cache (après une sauvegarde de la config)."""
    with _CACHE_LOCK:
        _CACHE[0] = None


def _read_section() -> Dict[str, Any]:
    try:
        st = os.stat(CONFIG_PATH)
        key = (st.st_mtime_ns, st.st_size)
    except OSError:
        key = None
    with _CACHE_LOCK:
        if key is not None and _CACHE[0] == key:
            return dict(_CACHE[1])
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except (OSError, ValueError):
        # Lecture ratée (écriture en cours, fichier absent) : le dernier bloc
        # connu reste servi plutôt que les défauts (qui rallumeraient une
        # feature désactivée ou videraient l'adresse du serveur OCR).
        with _CACHE_LOCK:
            return dict(_CACHE[1])
    section = raw.get("ocr") if isinstance(raw, dict) else None
    section = section if isinstance(section, dict) else {}
    with _CACHE_LOCK:
        _CACHE[0], _CACHE[1] = key, dict(section)
    return section


def get_ocr_config() -> Dict[str, Any]:
    """Bloc ``ocr`` effectif : env ``APP_OCR_<KEY>`` > rag_config.json > défaut.

    ``endpoint_url`` renvoyé est TOUJOURS résolu : ``http://host:port`` si un
    hôte est renseigné, sinon l'``endpoint_url`` explicite (rétro-compat).
    """
    section = _read_section()
    cfg: Dict[str, Any] = {}
    for key, default in _DEFAULTS.items():
        env_val = os.environ.get("APP_OCR_" + key.upper())
        val = env_val if env_val is not None else section.get(key, default)
        if key in _INT_KEYS:
            try:
                val = max(1, int(val))
            except (TypeError, ValueError):
                val = default
        elif key in _BOOL_KEYS:
            val = (str(val).strip().lower() in ("1", "true", "on", "yes")
                   if not isinstance(val, bool) else val)
        else:
            val = str(val if val is not None else "").strip() or default
        cfg[key] = val
    if cfg["host"]:
        cfg["endpoint_url"] = f"http://{cfg['host']}:{cfg['port']}"
    return cfg


def ocr_feature_enabled() -> bool:
    """Flag ``ocr.enabled`` — défaut ON (la feature est native au service)."""
    return bool(get_ocr_config().get("enabled"))


def apply_doc_model(cfg: Dict[str, Any], meta: Dict[str, Any]) -> Dict[str, Any]:
    """Config effective d'un document : son MODÈLE (sélecteur de la page,
    mémorisé dans meta) prime sur le défaut admin. Mutation en place + retour."""
    model = str(meta.get("model") or "").strip()
    cfg["model"] = model or cfg.get("default_model") or ""
    return cfg
