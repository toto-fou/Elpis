# SPDX-License-Identifier: MIT
"""
Admin config-file & compression-config endpoints.

Auto-extracted from the former monolithic ``backend/routes/admin.py``.
The endpoint bodies are byte-for-byte identical to the originals.
"""
from __future__ import annotations

import asyncio
import fcntl
import json
import logging
import re
import shutil
from pathlib import Path
from typing import Any

from fastapi import HTTPException, Request
from fastapi.responses import (
    JSONResponse,
)

from shared_infra.config import (
    CONFIG_JSON_PATH, read_config_json, write_config_json,
)
from shared_infra.accounts.users import (
    get_user_by_id,
)
from shared_infra.security.deps import require_user_id

# Helpers shared with _legacy. Single source of truth.
from shared_infra.routes._legacy import (
    DEFAULT_CONFIG_PATH,
)

# Routers — owned by ``_state``. We import them so endpoint decorators
# below register on the SAME singleton router instances mounted by
# ``app.py`` / ``admin_app.py``.
from shared_infra.routes.admin._state import admin_router

logger = logging.getLogger("uvicorn.error")


@admin_router.get("/api/admin/compression-config")
def api_admin_compression_get(request: Request):
    """Retourne la config actuelle de la compression conversationnelle.

    Champs exposés :
      - enabled, trigger_after_turns, compress_every,
        keep_recent_turns, keep_bridge_turns  (seuils turn-based)
      - external_model                        (modèle alternatif, même serveur)
      - endpoint_url, endpoint_model, endpoint_timeout_sec
        (serveur llama.cpp DÉDIÉ pour la compression — recommandé)
      - pct_of_ctx                            (seuil tokens, 0 = désactivé)
      - cooldown_iters                        (anti-spam boucle tool-calling)
      - max_per_chat                          (cap dur compressions/chat, 0 = illimité)
      - min_growth_tokens                     (croissance min. du contexte entre 2 compressions)
    """
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] not in (1, 2):
        raise HTTPException(403, "Staff required")
    from shared_infra import config as _cfg
    # Multi-worker safety : resync avec le disque avant de lire les globals.
    # Un autre worker a peut-être écrit config.json depuis le dernier reload
    # de CELUI-CI — sans resync, on renverrait un snapshot périmé et l'admin
    # verrait les anciennes valeurs à chaque refresh.
    try:
        _cfg.reload_compression_config_from_disk()
    except Exception as _e:
        logger.warning(f"[admin] reload_compression_config_from_disk échoué : {_e}")
    return JSONResponse({
        "enabled":                _cfg.COMPRESSION_ENABLED,
        "keep_recent_turns":      _cfg.COMPRESSION_KEEP_RECENT,
        "keep_bridge_turns":      _cfg.COMPRESSION_KEEP_BRIDGE,
        "external_model":         _cfg.COMPRESSION_EXTERNAL_MODEL,
        "endpoint_url":           _cfg.COMPRESSION_ENDPOINT_URL,
        "endpoint_model":         _cfg.COMPRESSION_ENDPOINT_MODEL,
        "endpoint_timeout_sec":   _cfg.COMPRESSION_ENDPOINT_TIMEOUT_SEC,
        "max_per_chat":           _cfg.COMPRESSION_MAX_PER_CHAT,
        # Harnais v4 (M3) : règle unique d'overflow — seuls réglages restants.
        "buffer_tokens":          _cfg.COMPACTION_BUFFER_TOKENS,
        "partial_target_ratio":   _cfg.COMPACTION_PARTIAL_TARGET_RATIO,
        "threshold_pct":          _cfg.COMPACTION_THRESHOLD_PCT,
        "threshold_tokens":       _cfg.COMPACTION_THRESHOLD_TOKENS,
    }, headers={"Cache-Control": "no-cache"})


@admin_router.post("/api/admin/compression-config")
async def api_admin_compression_set(request: Request):
    """Met à jour la config de compression. Hot-reload en mémoire + persistance
    dans config.json sous ``llm.compression.{...}``.

    Body attendu (tous optionnels — seuls les champs présents sont mis à jour) :
        {
          "enabled":              bool,
          "keep_recent_turns":    int 2-50,
          "keep_bridge_turns":    int 0-20,
          "external_model":       str    (vide = utiliser modèle courant
                                          du serveur principal),
          "endpoint_url":         str    (ex: "http://llm.example.lan:8081"
                                          ou URL complète — on complète
                                          le path OpenAI si besoin. Vide
                                          = pas d'endpoint dédié),
          "endpoint_model":       str    (nom du modèle sur l'endpoint
                                          dédié, ignoré si endpoint_url vide),
          "endpoint_timeout_sec": int 10-600,
          "max_per_chat":         int 0-10  (cap dur par conversation,
                                          0 = illimité),
          "buffer_tokens":        int ≥ 0  (marge sous n_ctx − gen_cap ;
                                          0 = auto min(20k, 10 % n_ctx)),
          "partial_target_ratio": float 0.2-0.9  (cible de la compaction
                                          partielle, fraction de usable),
          "threshold_pct":        int 0 ou 30-100,
          "threshold_tokens":     int 0 ou 2048-4000000
                                         (DÉFAUT D'INSTANCE du « contexte max
                                          avant compaction », au choix en % de
                                          la fenêtre ou en tokens — les tokens
                                          priment. 0 des deux côtés = auto,
                                          c.-à-d. le plafond technique, le
                                          comportement historique. Un compte
                                          qui règle son propre seuil prime
                                          EN BLOC dessus.)
        }
    """
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    # Audit 2026-09-22, H6 : écriture de config d'instance (dont
    # ``endpoint_url``, où partirait tout l'historique compacté) → admin
    # seul. Le modérateur garde la lecture (GET ci-dessus).
    if not me or me["is_admin"] != 1:
        raise HTTPException(403, "Admin required")
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "JSON body requis")

    # Validation bornes (cohérente avec backend/config.py)
    def _bounded(val, lo, hi, default):
        try:
            v = int(val)
        except (TypeError, ValueError):
            return default
        return max(lo, min(hi, v))

    def _bounded_float(val, lo, hi, default):
        try:
            v = float(val)
        except (TypeError, ValueError):
            return default
        return max(lo, min(hi, v))

    from shared_infra import config as _cfg
    # Multi-worker safety : resync depuis le disque AVANT d'appliquer les
    # nouvelles valeurs du body. Sans ça, si worker A a écrit trigger=30
    # et que le user envoie ensuite un POST pour changer cooldown=5 qui
    # atterrit sur worker B, worker B partirait de SA mémoire (trigger=20,
    # valeur d'origine), écrirait {trigger=20, cooldown=5} et écraserait
    # la modif de worker A sur disque.
    try:
        _cfg.reload_compression_config_from_disk()
    except Exception as _e:
        logger.warning(f"[admin] reload avant POST échoué : {_e}")
    _cfg.COMPRESSION_ENABLED       = bool(body.get("enabled", _cfg.COMPRESSION_ENABLED))
    _cfg.COMPRESSION_KEEP_RECENT   = _bounded(body.get("keep_recent_turns"),    2, 50,  _cfg.COMPRESSION_KEEP_RECENT)
    _cfg.COMPRESSION_KEEP_BRIDGE   = _bounded(body.get("keep_bridge_turns"),    0, 20,  _cfg.COMPRESSION_KEEP_BRIDGE)
    _ext = (body.get("external_model") or "").strip()
    _cfg.COMPRESSION_EXTERNAL_MODEL = _ext

    # ── Nouveaux champs : endpoint dédié ──────────────────────────────────
    _ep_url = (body.get("endpoint_url") or "").strip()
    if _ep_url:
        # Normalise le path OpenAI comme dans config.py
        _lower = _ep_url.lower()
        if "/v1/chat/completions" not in _lower and "/chat/completions" not in _lower:
            _ep_url = _ep_url.rstrip("/") + "/v1/chat/completions"
    _cfg.COMPRESSION_ENDPOINT_URL    = _ep_url
    _cfg.COMPRESSION_ENDPOINT_MODEL  = (body.get("endpoint_model") or "").strip()
    _cfg.COMPRESSION_ENDPOINT_TIMEOUT_SEC = _bounded(
        body.get("endpoint_timeout_sec"), 10, 600, _cfg.COMPRESSION_ENDPOINT_TIMEOUT_SEC
    )
    _cfg.COMPRESSION_MAX_PER_CHAT    = _bounded(
        body.get("max_per_chat"), 0, 10, _cfg.COMPRESSION_MAX_PER_CHAT
    )
    _cfg.COMPACTION_BUFFER_TOKENS    = max(0, _bounded(
        body.get("buffer_tokens"), 0, 1_000_000, _cfg.COMPACTION_BUFFER_TOKENS
    ))
    _cfg.COMPACTION_PARTIAL_TARGET_RATIO = _bounded_float(
        body.get("partial_target_ratio"), 0.2, 0.9,
        _cfg.COMPACTION_PARTIAL_TARGET_RATIO
    )
    # Seuil : 0 (auto) est une VALEUR, pas un « non renseigné » — on ne peut
    # donc pas le borner à [30, 100] comme les autres. Clé absente = on garde
    # la valeur courante ; 0 explicite = retour à l'auto.
    if "threshold_pct" in body:
        _thr_in = _bounded(body.get("threshold_pct"), 0, 100,
                           _cfg.COMPACTION_THRESHOLD_PCT)
        _cfg.COMPACTION_THRESHOLD_PCT = 0 if _thr_in <= 0 else max(30, _thr_in)
    if "threshold_tokens" in body:
        _tok_in = _bounded(body.get("threshold_tokens"), 0, 4_000_000,
                           _cfg.COMPACTION_THRESHOLD_TOKENS)
        _cfg.COMPACTION_THRESHOLD_TOKENS = 0 if _tok_in <= 0 else max(2_048, _tok_in)

    # ── Changement d'endpoint → fermer l'ancien client HTTP si ouvert ─────
    # Force la recréation au prochain appel avec le nouveau timeout/URL.
    try:
        from llm_core.conversation_compressor import close_endpoint_client
        await close_endpoint_client()
    except Exception:
        pass

    # ── Persistance dans config.json ─────────────────────────────────────
    # FIX BUG MAJEUR : l'ancien code construisait à la main un chemin avec
    # `os.path.dirname(...)` × 3, ce qui remontait de 3 niveaux depuis
    # backend/routes/_legacy.py → aboutissait à {project_root}/config.json.
    # MAIS config.py lit depuis BACKEND_DIR/config.json (ou APP_CONFIG_PATH).
    # Résultat : l'admin écrivait dans un FICHIER FANTÔME jamais relu au
    # démarrage. À chaque redémarrage la conf repartait aux valeurs par
    # défaut → c'est le bug "refresh a chaque redémarrage" rapporté.
    #
    # Correctif : on utilise read_config_json / write_config_json importés
    # depuis backend.config. Ces helpers pointent tous les deux sur
    # CONFIG_JSON_PATH (la même variable que celle lue par config.py au
    # démarrage) et effectuent l'écriture de manière atomique (tmp + rename)
    # pour éviter toute corruption en cas de crash pendant l'écriture.
    try:
        cfg_data = read_config_json()
        llm_section = cfg_data.setdefault("llm", {})
        comp_section = llm_section.setdefault("compression", {})
        comp_section.update({
            "enabled":              _cfg.COMPRESSION_ENABLED,
            "keep_recent_turns":    _cfg.COMPRESSION_KEEP_RECENT,
            "keep_bridge_turns":    _cfg.COMPRESSION_KEEP_BRIDGE,
            "external_model":       _cfg.COMPRESSION_EXTERNAL_MODEL,
            "endpoint_url":         _cfg.COMPRESSION_ENDPOINT_URL,
            "endpoint_model":       _cfg.COMPRESSION_ENDPOINT_MODEL,
            "endpoint_timeout_sec": _cfg.COMPRESSION_ENDPOINT_TIMEOUT_SEC,
            "max_per_chat":         _cfg.COMPRESSION_MAX_PER_CHAT,
        })
        for _dead in ("trigger_after_turns", "compress_every", "pct_of_ctx",
                      "cooldown_iters", "min_growth_tokens"):
            comp_section.pop(_dead, None)
        compaction_section = llm_section.setdefault("compaction", {})
        compaction_section.update({
            "buffer_tokens":        _cfg.COMPACTION_BUFFER_TOKENS,
            "partial_target_ratio": _cfg.COMPACTION_PARTIAL_TARGET_RATIO,
            "threshold_pct":        _cfg.COMPACTION_THRESHOLD_PCT,
            "threshold_tokens":     _cfg.COMPACTION_THRESHOLD_TOKENS,
        })
        write_config_json(cfg_data)
        # Synchronise le mtime cache de CE worker avec le fichier qu'il
        # vient d'écrire. Sans ça, au prochain reload_compression_config_-
        # from_disk() appelé sur ce même worker, l'écart de mtime serait
        # toujours positif (puisque le mtime cache d'avant l'écriture est
        # < mtime actuel du fichier) et on rechargerait les valeurs qu'on
        # vient juste de poser — no-op mais superflu. Cosmétique.
        try:
            _cfg._compression_config_mtime = CONFIG_JSON_PATH.stat().st_mtime
        except Exception:
            pass
    except Exception as e:
        logger.warning(f"[admin] persist compression_config échoué : {e}")

    # MÊME forme que le GET. Ce bloc référençait encore cinq attributs retirés
    # par le harnais v4/M3 (COMPRESSION_TRIGGER_AFTER, _EVERY, _PCT_OF_CTX,
    # _COOLDOWN_ITERS, _MIN_GROWTH_TOKENS) : chaque POST levait donc une
    # AttributeError → HTTP 500, APRÈS que config.json a été écrit et les
    # globals mis à jour. L'admin voyait « Enregistrement échoué » alors que
    # sa configuration ÉTAIT enregistrée — et rejouait ou éditait le JSON à la
    # main par-dessus. (Le GET, lui, avait bien été nettoyé.)
    return JSONResponse({
        "enabled":              _cfg.COMPRESSION_ENABLED,
        "keep_recent_turns":    _cfg.COMPRESSION_KEEP_RECENT,
        "keep_bridge_turns":    _cfg.COMPRESSION_KEEP_BRIDGE,
        "external_model":       _cfg.COMPRESSION_EXTERNAL_MODEL,
        "endpoint_url":         _cfg.COMPRESSION_ENDPOINT_URL,
        "endpoint_model":       _cfg.COMPRESSION_ENDPOINT_MODEL,
        "endpoint_timeout_sec": _cfg.COMPRESSION_ENDPOINT_TIMEOUT_SEC,
        "max_per_chat":         _cfg.COMPRESSION_MAX_PER_CHAT,
        # Harnais v4 (M3) : règle unique d'overflow — seuls réglages restants.
        "buffer_tokens":        _cfg.COMPACTION_BUFFER_TOKENS,
        "partial_target_ratio": _cfg.COMPACTION_PARTIAL_TARGET_RATIO,
        "threshold_pct":        _cfg.COMPACTION_THRESHOLD_PCT,
        "threshold_tokens":     _cfg.COMPACTION_THRESHOLD_TOKENS,
    })


# ─────────────────────────────────────────────────────────────────────────────
#  PROPRIÉTÉ DES SECTIONS DE config.json
# ─────────────────────────────────────────────────────────────────────────────
# L'éditeur « Config principale » de la console charge config.json à l'ouverture
# de l'onglet et le renvoie ENTIER à l'enregistrement. Tout ce qu'un endpoint
# spécialisé a écrit entre-temps est donc réécrit avec la copie qu'avait le
# navigateur — un écrasement silencieux, jamais signalé à l'opérateur.
#
# Deux régimes, selon qui est l'auteur légitime du réglage :
#
#  • ``_OWNED_PATHS`` — un SEUL endpoint en est l'auteur, et il porte des
#    garanties que le formulaire n'a pas. La valeur du disque gagne TOUJOURS,
#    même quand le payload en propose explicitement une autre : c'est la seule
#    règle qui couvre le cas qui a cassé la prod — un formulaire ouvert AVANT
#    le toggle HTTPS, donc porteur d'un « https désactivé » explicite et périmé.
#    Enchaînement vécu : toggle HTTPS → binds gunicorn en 127.0.0.1, Caddy seul
#    point d'entrée ; puis un enregistrement quelconque depuis l'onglet
#    Configuration remettait ``security.https.enabled=false`` ; rien ne bougeait
#    tant que l'app tournait, et au redémarrage suivant gunicorn rebindait
#    0.0.0.0 → l'app répondait EN CLAIR sur ses ports internes (8001/8002) à
#    tout le LAN, pendant que Caddy servait toujours du https. Le cookie
#    ``Secure`` ne suivant plus, les fonctionnalités qui supposent https
#    cassaient sans que la console ne montre quoi que ce soit.
#    Corollaire voulu : on n'ACTIVE pas le HTTPS par l'éditeur brut — la
#    bascule doit passer par le toggle, qui sonde Caddy avant d'écrire (garde
#    anti-lockout).
#
#  • ``_PRESERVE_IF_ABSENT`` — sections qu'un admin peut légitimement éditer à
#    la main. On ne les restaure que si le payload ne les porte pas (ou les
#    porte vides) : comportement historique, élargi aux sections qui avaient
#    été oubliées (``executors``, ``backup``, ``llm.allowed_provider_types``).
_OWNED_PATHS: tuple[tuple[str, ...], ...] = (
    # Mode d'accès HTTPS — auteur : POST /api/admin/security/https.
    ("security", "https"),
    # Cookie Secure — dérivé du même toggle, écrit dans la même transaction.
    ("security", "session", "https_only"),
    # Écoute hors HTTPS (local/lan) — auteur : POST /api/admin/security/listen
    # (garde anti-verrouillage) ou ./elpis configure.
    ("security", "listen"),
    # Époque de révocation globale — auteur : POST …/sessions/revoke-all.
    # La faire reculer RÉ-AUTORISE toutes les sessions révoquées.
    ("security", "session", "global_min_ts"),
    # Moteur de base de données — auteur : /api/admin/database/* (bascule
    # vérifiée, génération). Réécrit à la main, il couperait l'accès à la base.
    ("database",),
)

_PRESERVE_IF_ABSENT: tuple[tuple[str, ...], ...] = (
    ("llm", "compression"),          # POST /api/admin/compression-config
    ("llm", "scheduling_mode"),      # POST /api/admin/llm-scheduling-mode
    ("llm", "allowed_provider_types"),  # POST /api/admin/llm-connectors/…
    ("executors",),                  # POST /api/admin/executors
    ("backup",),                     # shared_infra/ops/backup_remote.py
    ("skins",),                      # /api/admin/skins (Console › Apparence)
)


def _dig(node: Any, path: tuple[str, ...]):
    """``(trouvé, valeur)`` pour un chemin pointé dans un dict imbriqué."""
    cur = node
    for key in path:
        if not isinstance(cur, dict) or key not in cur:
            return False, None
        cur = cur[key]
    return True, cur


def _plant(node: dict, path: tuple[str, ...], value: Any) -> None:
    """Écrit ``value`` au chemin donné, en créant les dicts manquants.

    Un nœud intermédiaire de type inattendu (le payload a mis une chaîne là où
    on attend un objet) est remplacé : on ne peut pas greffer dessus.
    """
    cur = node
    for key in path[:-1]:
        nxt = cur.get(key)
        if not isinstance(nxt, dict):
            nxt = {}
            cur[key] = nxt
        cur = nxt
    cur[path[-1]] = value


def _apply_section_ownership(incoming: dict, on_disk: dict) -> list[str]:
    """Ré-injecte dans ``incoming`` les sections dont il n'est pas l'auteur.

    Modifie ``incoming`` sur place. Renvoie la liste des chemins restaurés,
    pour le journal — un écrasement évité doit rester visible à l'exploitation.
    """
    restored: list[str] = []

    for path in _OWNED_PATHS:
        found_disk, disk_val = _dig(on_disk, path)
        if not found_disk:
            # Jamais écrit par son propriétaire : le payload fait foi (c'est
            # le cas d'une instance neuve, où le formulaire pose les défauts).
            continue
        found_in, in_val = _dig(incoming, path)
        if found_in and in_val == disk_val:
            continue
        _plant(incoming, path, disk_val)
        restored.append(".".join(path))

    for path in _PRESERVE_IF_ABSENT:
        found_disk, disk_val = _dig(on_disk, path)
        if not found_disk or disk_val in (None, {}, [], ""):
            continue
        found_in, in_val = _dig(incoming, path)
        if found_in and in_val not in (None, {}, [], ""):
            continue  # le payload la porte explicitement → on respecte
        _plant(incoming, path, disk_val)
        restored.append(".".join(path))

    return restored


@admin_router.get("/api/admin/config-file")
def api_admin_get_config_file(request: Request, type: str):
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] != 1: raise HTTPException(403, "Admin required")
    target_path = None
    if type == "main": target_path = DEFAULT_CONFIG_PATH
    else: raise HTTPException(400, "Unknown config type")
    if not target_path.exists(): return {"content": "{}"}
    try:
        content = target_path.read_text(encoding="utf-8")
        return {"content": content}
    except Exception as e: raise HTTPException(500, f"Error reading file: {str(e)}")


@admin_router.post("/api/admin/config-file")
async def api_admin_save_config_file(request: Request):
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] != 1: raise HTTPException(403, "Admin required")
    data = await request.json()
    ctype = data.get("type")
    content = data.get("content")
    try:
        parsed_incoming = json.loads(content)
    except json.JSONDecodeError: raise HTTPException(400, "Syntaxe JSON invalide.")
    if not isinstance(parsed_incoming, dict):
        raise HTTPException(400, "Le contenu doit être un objet JSON.")
    target_path = None
    if ctype == "main": target_path = DEFAULT_CONFIG_PATH
    else: raise HTTPException(400, "Unknown config type")

    # ─────────────────────────────────────────────────────────────────
    # PROPRIÉTÉ des sections écrites par les routes spécialisées
    # ─────────────────────────────────────────────────────────────────
    # Le formulaire « Config principale » charge configForm à l'ouverture de
    # l'onglet et le renvoie ENTIER : il réécrit donc, avec une copie
    # potentiellement périmée, tout ce qu'un panneau dédié a posé entre-temps.
    # Le détail des deux régimes (disque prioritaire vs préservation si absent)
    # et le scénario de panne qui les motive sont documentés sur
    # ``_OWNED_PATHS`` / ``_PRESERVE_IF_ABSENT``.
    try:
        current_on_disk = {}
        if target_path.exists():
            try:
                current_on_disk = json.loads(target_path.read_text(encoding="utf-8"))
                if not isinstance(current_on_disk, dict):
                    current_on_disk = {}
            except Exception:
                current_on_disk = {}

        # ``llm`` de type inattendu dans le payload : on le remplace, sinon
        # les greffes ci-dessous n'auraient nulle part où se poser.
        if "llm" in parsed_incoming and not isinstance(parsed_incoming["llm"], dict):
            parsed_incoming["llm"] = {}

        restored = _apply_section_ownership(parsed_incoming, current_on_disk)
        if restored:
            logger.info(
                "[admin] save config-file : %d section(s) restaurée(s) depuis le "
                "disque (le formulaire en portait une copie périmée) : %s",
                len(restored), ", ".join(restored),
            )

        # Ne pas introduire une clé "llm": {} vide si personne n'en veut.
        if parsed_incoming.get("llm") == {}:
            parsed_incoming.pop("llm", None)

        # Regénère le content avec les sections restaurées
        content = json.dumps(parsed_incoming, ensure_ascii=False, indent=2)
    except HTTPException:
        raise
    except Exception as _merge_err:
        # En cas de pépin inattendu, on continue avec le content original
        # pour ne pas bloquer la sauvegarde (le vieux comportement reste
        # fonctionnel, juste sans la protection).
        logger.warning(
            "[admin] save config-file : merge propriété échoué (%s) — "
            "écriture du payload tel quel en fallback",
            str(_merge_err)[:200],
        )

    try:
        if target_path.exists():
            bak = target_path.with_suffix(".json.bak")
            await asyncio.to_thread(shutil.copy, target_path, bak)
        # Écriture ATOMIQUE (tmp + rename), comme ``write_config_json``. Un
        # ``write_text`` direct tronque le fichier avant de le réécrire : une
        # coupure — ou simplement un master gunicorn qui relit sa conf pendant
        # ce laps — voyait un JSON invalide. Or les confs gunicorn *fail-open*
        # sur config illisible (pour ne jamais se verrouiller au boot) : elles
        # auraient donc rebindé 0.0.0.0 en mode HTTPS. Le rename est atomique,
        # aucun lecteur ne peut plus observer d'état intermédiaire.
        await asyncio.to_thread(_write_text_atomic, target_path, content)
        return {"ok": True}
    except Exception as e: raise HTTPException(500, f"Error writing file: {str(e)}")


# ─────────────────────────────────────────────────────────────────────────────
#  PATCH /api/admin/config — n'écrire QUE les champs modifiés (refonte 2026-09-27)
# ─────────────────────────────────────────────────────────────────────────────
# Le POST historique renvoie config.json ENTIER : une copie chargée à
# l'ouverture de l'écran réécrit tout ce qu'un autre écran a posé entre-temps.
# ``_OWNED_PATHS`` / ``_PRESERVE_IF_ABSENT`` rattrapaient les cas connus, pas
# les autres — un jeton de collecte révoqué (``metrics.scrape_token``) ou le
# rapport quotidien automatique (``maintenance.daily_digest_enabled``)
# revenaient ainsi à leur ancienne valeur.
#
# Ici chaque écran n'envoie que ses champs : ``{"changes": [{path, to, from |
# from_absent}]}``. ``from`` est la valeur LUE SUR DISQUE au chargement de
# l'écran (pas celle d'un défaut rempli côté client) : si le disque a changé
# depuis, rien n'est écrit et la réponse 409 nomme les champs en conflit avec
# leur valeur actuelle — l'écran propose alors de les recharger, ou d'écraser
# (``force``). Un chemin qui touche une zone POSSÉDÉE par un autre endpoint
# (``_OWNED_PATHS``) est refusé en 400 avec un message, au lieu d'être ignoré
# en silence comme le faisait le POST.
_PATCH_PATH_RE = re.compile(r"^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){0,7}$")
_PATCH_MAX_CHANGES = 200


def _touches_owned(parts: tuple[str, ...]) -> bool:
    """Le chemin EST une zone possédée, est DEDANS, ou la CONTIENT (écrire le
    parent écraserait la zone)."""
    for owned in _OWNED_PATHS:
        n = min(len(owned), len(parts))
        if owned[:n] == parts[:n]:
            return True
    return False


def _same_value(a: Any, b: Any) -> bool:
    """Égalité de valeurs JSON ; 1 et 1.0 sont égaux, True et 1 ne le sont pas."""
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a is b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return float(a) == float(b)
    return (json.dumps(a, sort_keys=True, ensure_ascii=False)
            == json.dumps(b, sort_keys=True, ensure_ascii=False))


def _remove_path(node: dict, parts: tuple[str, ...]) -> None:
    cur = node
    for key in parts[:-1]:
        cur = cur.get(key) if isinstance(cur, dict) else None
        if not isinstance(cur, dict):
            return
    cur.pop(parts[-1], None)


@admin_router.patch("/api/admin/config")
async def api_admin_patch_config(request: Request):
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] != 1:
        raise HTTPException(403, "Admin required")
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(400, "Le contenu doit être un objet JSON.")
    changes = body.get("changes")
    force = bool(body.get("force"))
    if not isinstance(changes, list) or not changes:
        raise HTTPException(400, "Aucune modification à enregistrer.")
    if len(changes) > _PATCH_MAX_CHANGES:
        raise HTTPException(400, "Trop de modifications en une fois.")

    parsed: list[tuple[tuple[str, ...], dict]] = []
    for c in changes:
        if not isinstance(c, dict):
            raise HTTPException(400, "Modification mal formée.")
        path = c.get("path")
        if not isinstance(path, str) or not _PATCH_PATH_RE.match(path):
            raise HTTPException(400, f"Chemin de réglage invalide : {path!r}")
        if "to" not in c and not c.get("delete"):
            raise HTTPException(400, f"Valeur manquante pour {path}.")
        parsed.append((tuple(path.split(".")), c))

    owned = [".".join(p) for p, _ in parsed if _touches_owned(p)]
    if owned:
        return JSONResponse(status_code=400, content={
            "detail": "Réglé par un autre écran : " + ", ".join(owned) + ".",
            "paths": owned,
        })

    target = DEFAULT_CONFIG_PATH
    lock_path = target.with_name(target.name + ".lock")

    def _apply():
        # Verrou fichier : deux enregistrements (deux workers, deux onglets)
        # ne font pas leur lire-modifier-écrire en même temps.
        with open(lock_path, "a") as lf:
            fcntl.flock(lf.fileno(), fcntl.LOCK_EX)
            try:
                disk: dict = {}
                if target.exists():
                    try:
                        disk = json.loads(target.read_text(encoding="utf-8") or "{}")
                    except json.JSONDecodeError:
                        return ("unreadable", None)
                    if not isinstance(disk, dict):
                        disk = {}
                if not force:
                    conflicts = []
                    for parts, c in parsed:
                        found, cur = _dig(disk, parts)
                        if c.get("from_absent"):
                            if found:
                                conflicts.append({"path": ".".join(parts), "current": cur})
                        elif "from" in c:
                            if not found or not _same_value(cur, c["from"]):
                                conflicts.append({"path": ".".join(parts),
                                                  "current": cur if found else None,
                                                  "absent": not found})
                    if conflicts:
                        return ("conflict", conflicts)
                for parts, c in parsed:
                    if c.get("delete"):
                        _remove_path(disk, parts)
                    else:
                        _plant(disk, parts, c["to"])
                if target.exists():
                    shutil.copy(target, target.with_suffix(".json.bak"))
                _write_text_atomic(target, json.dumps(disk, ensure_ascii=False, indent=2))
                return ("ok", len(parsed))
            finally:
                fcntl.flock(lf.fileno(), fcntl.LOCK_UN)

    status, info = await asyncio.to_thread(_apply)
    if status == "unreadable":
        raise HTTPException(500, "config.json est illisible : corrigez-le avant d'enregistrer.")
    if status == "conflict":
        return JSONResponse(status_code=409, content={
            "detail": "Modifié ailleurs entre-temps.",
            "conflicts": info,
        })
    try:
        from shared_infra.config import invalidate_config_cache
        invalidate_config_cache()
    except Exception:
        pass
    logger.info("[admin] config PATCH%s : %d champ(s) — %s", " (forcé)" if force else "",
                info, ", ".join(".".join(p) for p, _ in parsed)[:400])
    return {"ok": True, "applied": info}


def _write_text_atomic(path: Path, content: str) -> None:
    """Second écrivain de ``config.json`` — il partageait avec le premier un
    nom de temporaire FIXE (audit 2026-08-23). Les deux passent désormais par
    le MÊME helper, à temporaire unique."""
    from shared_infra.config import write_text_atomic
    write_text_atomic(path, content)
