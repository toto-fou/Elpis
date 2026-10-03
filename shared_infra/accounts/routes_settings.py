# SPDX-License-Identifier: MIT
"""
shared_infra.accounts.routes_settings — Per-user settings, avatars, password
change, and user-list lite query.

Endpoints
---------
Avatars (user-uploaded)
- POST   /api/settings/avatar             — upload personal avatar (max 5 MB)
- DELETE /api/settings/avatar             — drop personal avatar
- POST   /api/settings/assistant-avatar   — upload custom assistant avatar
- GET    /avatars/{filename}              — serve any avatar file by name

Settings document (per-user JSON blob)
- GET    /api/settings                    — load + augment with defaults +
                                             sandbox-path + enable_model_selector
- PUT    /api/settings                    — patch (allow-listed keys only) +
                                             invalidate MCP pool if mcp_servers
                                             changed; non-admins cannot remove
                                             or mutate existing MCP servers
                                             (only add / toggle ``visible``)

User account ops
- POST   /api/users/change-password       — self-service or
                                             must_change_pwd flow
- GET    /api/users/lite                  — minimal user list visible to me
                                             (admins see all, others restricted
                                             by group membership)

Security notes
--------------
- Avatar uploads validate the file content via its magic bytes (not the
  client-supplied ``Content-Type``); the on-disk extension is chosen from
  the detected type only, never from the client.
- ``PUT /api/settings`` applies an allow-list before persisting, so a
  malicious or buggy client cannot store arbitrary keys in a user's
  settings JSON that might later be reflected by another view.
- Avatar deletion resolves the candidate path under ``AVATAR_DIR`` and
  refuses to act on anything that escapes that directory.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time

from fastapi import File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from llm_core._mcp_pool import mcp_pool
from shared_infra.accounts.groups import (
    get_user_groups,
)
from shared_infra.accounts.passwd import run_password_op
from shared_infra.accounts.users import (
    bump_session_min_ts,
    get_user_by_id,
    get_user_settings,
    get_username_by_id,
    get_users_lite,
    merge_user_settings,
    reset_user_password,
    update_user_avatar,
    # ⚠ NE PAS RETIRER ``update_user_settings`` : la suite de tests fait
    # ``monkeypatch.setattr(<ce module>, "update_user_settings", …)`` pour
    # isoler les écritures de réglages. Cet import n'est utilisé nulle part
    # dans le fichier — ruff le voit donc mort, mais le retirer casse en bloc
    # tous les tests qui le substituent.
    update_user_settings,  # noqa: F401
    verify_user,
)
from shared_infra.appearance import skins as _skins
from shared_infra.config import SANDBOX_DIR, read_config_json
from shared_infra.db import db
from shared_infra.routes._legacy import AVATAR_DIR, validate_password
from shared_infra.routes._state import router
from shared_infra.security.deps import require_user_id

logger = logging.getLogger("uvicorn.error")

_IMAGE_TYPE_TO_EXT = {
    "jpeg": ".jpg",
    "png":  ".png",
    "gif":  ".gif",
    "webp": ".webp",
}

_USER_SETTINGS_ALLOWED = frozenset({
    "mcp_servers",
    # Bibliothèque MCP PARTAGÉE : ids (``shared:<n>``) que CE compte a choisi
    # d'afficher dans son panneau Outils. La liste des serveurs, elle, vit en
    # base (table ``mcp_shared_servers``) — ici on ne stocke qu'un choix
    # d'affichage, jamais une URL ni un secret.
    "shared_mcp_visible",
    "active_mcp_url",
    "system_prompt",
    "assistant_name",
    "assistant_icon",
    "assistant_avatar",
    "enable_editor",
    "enable_preview",
    "enable_mcp",
    "enable_rag",
    "enable_model_selector",
    "enable_charts",
    "sandbox_path_display",
    "editor_ratio",
    "editor_dark_mode",
    "dark_mode",
    # Mode sombre SUIVI DU SYSTÈME (prefers-color-scheme) : quand il vaut
    # true, ``dark_mode`` est ignoré. Choix « Système · Clair · Sombre ».
    "dark_mode_auto",
    "auto_open_editor_on_write",
    "editor_font_size",
    "editor_font_family",
    "editor_tab_size",
    "editor_insert_spaces",
    "editor_word_wrap",
    "editor_minimap",
    "editor_line_numbers",
    "editor_edit_highlight",
    "editor_auto_save",
    "editor_persist_tabs",   # mémoriser les onglets ouverts (localStorage) — défaut ON
    "editor_follow_active",  # l'arbre suit le fichier ouvert (« Localiser » auto) — défaut OFF
    "chat_width",
    "sandbox_mode",
    "network_profile_id",
    "thinking_mode",
    "rag_collection",
    "rag_search_mode",
    "rag_use_mmr",
    "rag_top_k",
    "use_rag",
    "active_mcp_ids",
    "selected_model",
    "ui_lang",
    "ui_theme",
    "skin",
    "welcome_mascot",   # mascotte du bloc d'accueil — défaut « boite_or » (le coffre)
    "welcome_mascot_anime",  # animer l'accueil MALGRÉ prefers-reduced-motion
    "memory_enabled",   # toggle Mémoire long-terme (Hermes) — per-user, défaut OFF
    "hide_thinking",    # masquer les blocs thinking dans le chat
    "agents_enabled",   # toggle Sous-agents (outil ``task``) — per-user, défaut OFF
    "custom_agents",    # définitions d'agents custom (liste, validée au PUT)
    # opencode : familles d'outils activées, ``{famille: bool}``. Une entrée
    # MCP par famille est publiée dans ``opencode.json`` ; la bascule du TUI
    # d'opencode n'étant PAS persistée (connect/disconnect en mémoire) et un
    # re-sync réécrivant le fichier, c'est ici que le choix survit.
    "opencode_mcp_families",
    "live_shell_enabled",  # Terminal en direct dans le chat — per-user, défaut ON
    # Moteur vocal, deux bascules distinctes : dicter et se faire lire ne se
    # décident pas ensemble — on dicte souvent en silence, et on écoute
    # souvent sans parler. Toutes deux défaut OFF (ouvrir le micro ou sortir
    # du son ne s'active jamais tout seul) et toutes deux soumises aux
    # drapeaux d'instance ``features.voice_stt`` / ``voice_tts``.
    "voice_input_enabled",  # Dictée : micro -> zone de saisie
    "voice_reply_enabled",  # Réponse vocale : lecture automatique des réponses
    # Lire AUSSI ce que l'assistant dit entre deux appels d'outils. Séparé de
    # ``voice_reply_enabled`` : sur une mission longue, la narration d'étapes
    # est utile à qui regarde ailleurs, et insupportable à qui attend la
    # réponse. Sans effet si la réponse vocale est coupée.
    "voice_reply_tools_enabled",
    "compression_enabled",  # Compaction AUTOMATIQUE — per-user, défaut OFF
    "compression_threshold_pct",     # Seuil de compaction en % de la fenêtre — 0 = auto
    "compression_threshold_tokens",  # …ou en tokens (prime sur le %) — 0 = auto
    "compression_max_rounds",        # Compactions max par conversation — 0 = auto, -1 = illimité
    # Génération d'images : entrée « Images » du chat et outil du modèle
    # (cochées par défaut, sans effet tant que le moteur n'est pas proposé à
    # ce compte), préférences du composeur (format, taille, nombre, enrichir).
    "image_enabled",
    "image_tool_enabled",
    "image_prefs",
})

# Les personnages de ``frontend/assets/mascotte`` : registre UNIQUE
# ``mascottes.json``, lu par ``shared_infra.appearance.skins`` — aucune copie
# de la liste ici ni côté interface. Repli sur les cinq d'origine si le
# fichier est illisible. Lu À L'APPEL : un personnage ajouté au registre est
# accepté sans redémarrage.

def _mascottes() -> tuple:
    return _skins.mascot_ids()


def _reglage_mascottes():
    """(allumees, actives, defaut) tels que l'admin les a réglés.

    Le jeu au-dessus reste la LISTE CLOSE de ce qui existe — un id hors de
    cette liste rendrait une boîte vide sans rien dire. L'admin, lui, choisit
    ce qu'il PUBLIE là-dedans, et laquelle arrive par défaut.

    Repli sur tout-actif : une configuration antérieure à ce réglage, ou un
    admin qui aurait tout décoché, ne doit pas priver les comptes de leur
    mascotte — l'écran retomberait sur le logo sans explication.

    ``mascottes_on`` À FAUX COUPE TOUT, et c'est un interrupteur SÉPARÉ de la
    liste. Une liste vide veut dire « rien n'a jamais été réglé » — d'où le
    repli ci-dessus ; « aucune mascotte, volontairement » est une DÉCISION,
    celle d'un déploiement public qui ne veut qu'un visuel générique.
    Confondre les deux rendrait le repli indistinguable du choix.
    """
    try:
        sc = ((read_config_json() or {}).get("welcome") or {}).get("scene") or {}
    except Exception:
        sc = {}
    if sc.get("mascottes_on") is False:
        return False, [], ""
    toutes = _mascottes()
    actives = [m for m in (sc.get("mascottes_actives") or []) if m in toutes]
    if not actives:
        actives = list(toutes)
    defaut = sc.get("mascotte_defaut")
    if defaut not in actives:
        defaut = "" if defaut == "" else actives[0]
    return True, actives, defaut


def _detect_image_type(head: bytes) -> str | None:
    """Detect the image format from the first bytes of a file.

    Replaces ``imghdr.what`` (removed in Python 3.13). Returns one of
    ``"jpeg"`` / ``"png"`` / ``"gif"`` / ``"webp"`` when the bytes match
    the expected magic signature, ``None`` otherwise.

    Signatures:
      - JPEG : ``FF D8 FF``
      - PNG  : ``89 50 4E 47 0D 0A 1A 0A``
      - GIF  : ``GIF87a`` or ``GIF89a``
      - WEBP : ``RIFF .... WEBP`` (12-byte RIFF container header)
    """
    if not head or len(head) < 4:
        return None
    if head.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head.startswith(b"GIF87a") or head.startswith(b"GIF89a"):
        return "gif"
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    return None


async def _read_and_validate_image(file: UploadFile) -> str:
    """Read the first chunk of an upload and verify it is a real image.

    Returns the detected extension (".jpg" / ".png" / ".gif" / ".webp").
    Raises HTTPException(400) when the bytes do not match a supported
    image format. Resets the underlying stream so the caller can still
    stream the full file to disk.
    """
    head = await file.read(64)
    try:
        await file.seek(0)
    except Exception:
        try:
            file.file.seek(0)
        except Exception:
            pass
    detected = _detect_image_type(head)
    ext = _IMAGE_TYPE_TO_EXT.get(detected or "")
    if not ext:
        raise HTTPException(400, "Fichier image invalide (signature non reconnue).")
    return ext

def _safe_unlink_in_avatar_dir(name: str) -> None:
    """Delete *name* inside AVATAR_DIR only if it resolves under it."""
    if not name or not isinstance(name, str):
        return
    try:
        base = AVATAR_DIR.resolve()
        candidate = (AVATAR_DIR / name).resolve()
        try:
            candidate.relative_to(base)
        except ValueError:
            return
        if candidate.exists() and candidate.is_file():
            candidate.unlink()
    except Exception:
        pass

@router.post("/api/settings/avatar")
async def api_upload_avatar(request: Request, file: UploadFile = File(...)):
    uid = require_user_id(request)
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(400, "Le fichier doit être une image")
    ext = await _read_and_validate_image(file)
    filename = f"{uid}_{int(time.time())}{ext}"
    AVATAR_DIR.mkdir(parents=True, exist_ok=True)
    file_path = AVATAR_DIR / filename
    from shared_infra.config import MAX_AVATAR_BYTES
    from shared_infra.files.uploads import save_upload_bounded
    await save_upload_bounded(file, file_path, MAX_AVATAR_BYTES)
    try:
        prev_row = get_user_by_id(uid)
        prev = prev_row["avatar"] if prev_row and "avatar" in prev_row.keys() else None
        if prev and prev != filename:
            _safe_unlink_in_avatar_dir(prev)
    except Exception:
        # Best-effort assumé (le nouvel avatar est déjà en place), mais
        # JOURNALISÉ : un échec (DB verrouillée) laisse un fichier orphelin
        # dans AVATAR_DIR, et /avatars/{filename} étant devinable, l'avatar
        # remplacé y reste récupérable — il faut en garder la trace.
        logger.warning("[avatar] suppression de l'ancien avatar échouée "
                       "(uid=%s) — fichier orphelin dans AVATAR_DIR",
                       uid, exc_info=True)
    update_user_avatar(uid, filename)
    return {"ok": True, "avatar": filename}

@router.delete("/api/settings/avatar")
async def api_delete_avatar(request: Request):
    uid = require_user_id(request)
    try:
        row = get_user_by_id(uid)
        current = row["avatar"] if row and "avatar" in row.keys() else None
        if current:
            _safe_unlink_in_avatar_dir(current)
    except Exception:
        # Comme à l'upload : succès renvoyé quand même (la référence DB est
        # bien effacée) mais l'échec du unlink est journalisé.
        logger.warning("[avatar] suppression du fichier avatar échouée "
                       "(uid=%s) — fichier orphelin dans AVATAR_DIR",
                       uid, exc_info=True)
    update_user_avatar(uid, None)
    return {"ok": True}

@router.post("/api/settings/assistant-avatar")
async def api_upload_assistant_avatar(request: Request, file: UploadFile = File(...)):
    uid = require_user_id(request)
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(400, "Le fichier doit être une image")
    ext = await _read_and_validate_image(file)
    filename = f"bot_{uid}_{int(time.time())}{ext}"
    AVATAR_DIR.mkdir(parents=True, exist_ok=True)
    file_path = AVATAR_DIR / filename
    from shared_infra.config import MAX_AVATAR_BYTES
    from shared_infra.files.uploads import save_upload_bounded
    await save_upload_bounded(file, file_path, MAX_AVATAR_BYTES)
    # Écriture atomique ; l'avatar remplacé est lu DEPUIS la transaction pour
    # l'unlink hors verrou.
    _prev_box = {}
    def _set_avatar(s):
        _prev_box["prev"] = s.get("assistant_avatar")
        s["assistant_avatar"] = filename
    await asyncio.to_thread(merge_user_settings, uid, _set_avatar)   # BEGIN IMMEDIATE : hors boucle
    prev = _prev_box.get("prev")
    if prev and prev != filename:
        _safe_unlink_in_avatar_dir(prev)
    return {"ok": True, "avatar": filename}

@router.get("/avatars/{filename}")
def api_get_avatar(filename: str):
    if not filename or any(ch in filename for ch in ("..", "/", "\\", "\x00")):
        raise HTTPException(400, "Invalid filename")
    # ``is_file()`` reste DANS le ``try`` : un nom de 256 caractères ou plus
    # (la limite d'un segment ext4) lui fait lever ``OSError`` ENAMETOOLONG,
    # soit un 500 sur une route PUBLIQUE (255 → 404, 256 → 500). Il touche le
    # système de fichiers exactement comme ``resolve()`` et relève du même
    # ``try``, qui rend le bon 400.
    try:
        base = AVATAR_DIR.resolve()
        path = (AVATAR_DIR / filename).resolve()
        path.relative_to(base)
        exists = path.is_file()
    except (ValueError, OSError):
        raise HTTPException(400, "Invalid filename")
    if not exists:
        raise HTTPException(404, "Avatar not found")
    return FileResponse(path)

def _reject_cross_site(request: Request) -> None:
    """Refuse une requête de changement de mot de passe forgée cross-site.

    Défense CSRF en profondeur, vérifiée côté serveur uniquement (aucun jeton
    transverse côté SPA). On s'appuie sur des en-têtes que le navigateur pose
    automatiquement et qu'une page tierce ne peut pas falsifier :

      - ``Sec-Fetch-Site`` : un ``fetch`` même-origine émet ``same-origin`` ;
        toute valeur ``cross-site`` / ``same-site`` est rejetée.
      - À défaut (navigateur ancien sans Fetch-Metadata), on compare l'hôte de
        ``Origin`` à celui de l'hôte de la requête ; un ``Origin`` présent et
        divergent est rejeté.

    Un ``Origin``/``Sec-Fetch-Site`` absent (clients non-navigateur, ex. CLI)
    est toléré : ces appels ne sont pas exploitables via le navigateur de la
    victime, qui est le vecteur CSRF visé ici.
    """
    sec_fetch_site = (request.headers.get("sec-fetch-site") or "").strip().lower()
    if sec_fetch_site:
        if sec_fetch_site not in ("same-origin", "none"):
            raise HTTPException(403, "Requête cross-site refusée.")
        return
    origin = (request.headers.get("origin") or "").strip()
    if origin and origin.lower() != "null":
        from urllib.parse import urlparse
        try:
            origin_host = urlparse(origin).netloc.lower()
        except Exception:
            origin_host = ""
        host = (request.headers.get("host") or request.url.netloc or "").strip().lower()
        if not origin_host or origin_host != host:
            raise HTTPException(403, "Requête cross-site refusée.")


@router.post("/api/users/change-password")
async def api_user_change_password(request: Request):
    uid = require_user_id(request)
    # Défense CSRF en profondeur (cf. _reject_cross_site). NB : un durcissement
    # plus large (jeton anti-CSRF double-submit, SameSite=strict sur le cookie
    # de session) serait pertinent mais relève d'un changement transverse hors
    # périmètre de cet endpoint ; à traiter globalement côté SessionMiddleware.
    _reject_cross_site(request)
    data = await request.json()
    new_password = data.get("new_password")
    old_password = data.get("old_password")
    if not new_password:
        raise HTTPException(400, "Mot de passe requis")

    me = get_user_by_id(uid)
    if not me:
        raise HTTPException(404, "Utilisateur non trouvé")

    # Prise de contrôle de compte : la vérification de l'ancien mot de passe
    # ne doit JAMAIS être contournable en omettant ``old_password``.
    # Seul le flux de changement forcé (``must_change_pwd=1``, l'utilisateur
    # vient de s'authentifier avec son mot de passe courant) est autorisé à
    # définir un nouveau mot de passe sans fournir l'ancien.
    must_change = bool(me["must_change_pwd"]) if "must_change_pwd" in me.keys() else False
    if not old_password:
        if not must_change:
            raise HTTPException(400, "Ancien mot de passe requis")
    else:
        # Deux PBKDF2 à 150 k itérations dans ce handler ``async`` (vérification
        # puis re-hachage) = 174 ms de boucle figée pour tout le monde. Déportés
        # sur le pool dédié — cf. ``shared_infra.accounts.passwd.run_password_op``.
        if not await run_password_op(verify_user, me["username"], old_password):
            raise HTTPException(400, "Ancien mot de passe incorrect")

    validate_password(new_password)
    await run_password_op(reset_user_password, uid, new_password)

    # SECURITY — un changement de mot de passe doit invalider TOUTES les
    # sessions existantes de l'utilisateur (une session volée ou encore active
    # ne doit PAS survivre au changement). On lève l'époque de révocation
    # par-user (session_min_ts ; cf. deps.require_user_id étape 3 +
    # admin/security.py revoke-user), puis on ré-estampille la session COURANTE
    # pour que l'utilisateur qui vient de changer son mot de passe reste
    # connecté sur CET appareil (comportement « déconnecter les autres
    # appareils »). _now identique pour les deux → login_ts == session_min_ts
    # (la garde est un strict ``<`` donc l'égalité passe).
    _now = time.time()
    bump_session_min_ts(uid, _now)
    request.session["_login_ts"] = _now
    # Les jetons personnels et applications OAuth tombent aussi : un accès
    # obtenu avant le changement ne doit pas y survivre (à recréer depuis
    # Paramètres › Connexions).
    from shared_infra.accounts.tokens import revoke_all_access
    await asyncio.to_thread(revoke_all_access, uid)

    conn = db()
    cur = conn.cursor()
    try:
        cur.execute("UPDATE users SET must_change_pwd=0 WHERE id=?", (uid,))
        conn.commit()
    finally:
        conn.close()

    return {"ok": True}

@router.get("/api/users/lite")
def api_get_users_lite_route(request: Request):
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    # Seul l'admin PLEIN (1) voit hors de ses groupes ; le modérateur (2)
    # reste dans son périmètre comme un utilisateur.
    is_admin = bool(me and me["is_admin"] == 1)
    users = get_users_lite(uid, respect_groups=not is_admin)
    my_groups = get_user_groups(uid)
    return {"users": users, "my_groups": my_groups}

@router.get("/api/settings/agent-templates")
def api_agent_templates(request: Request):
    """Les agents intégrés tels que livrés (persona entière, catégories,
    budget) : ce que l'onglet Agents pré-remplit quand on ouvre un modèle. Une
    surcharge ne stocke que les écarts par rapport à ceci (``custom_agents``,
    validé au PUT par ``validate_custom_agents``)."""
    require_user_id(request)
    from llm_core.tools.task_tool import agent_templates
    return {"templates": agent_templates()}


# Seules clés que le processus admin accepte en écriture (voir api_put_settings).
_ADMIN_PORT_SETTINGS = frozenset({"skin", "dark_mode", "dark_mode_auto"})


@router.get("/api/settings")
def api_get_settings(request: Request):
    uid = require_user_id(request)
    saved = get_user_settings(uid)
    defaults = {
        "mcp_servers": [],
        # Vide = la bibliothèque partagée est CACHÉE de l'interface principale
        # tant que l'utilisateur n'a rien coché (demande explicite : on publie
        # pour tous, chacun n'affiche que ce qui l'intéresse).
        "shared_mcp_visible": [],
        "active_mcp_url": "",
        "system_prompt": "",
        "assistant_name": "Elpis",
        "assistant_icon": "ph-robot",
        "assistant_avatar": "",
        "editor_dark_mode": True,
        "dark_mode": False,
        "dark_mode_auto": False,
        # Défaut d'INSTANCE (console › Apparence), jamais un skin en dur.
        "skin": _skins.default_skin(),
        # Mascotte du bloc « nouveau chat ». Le coffre par défaut : Elpis est
        # ce qui reste au fond de la jarre de Pandore, c'est le personnage du
        # sujet. "" retombe sur le logo configuré par l'admin (welcomeConfig).
        # La valeur est écrasée juste après par le réglage d'admin : elle n'est
        # là que pour le cas où la configuration serait illisible.
        "welcome_mascot": "boite_or",
        # L'accueil est animé PAR DÉFAUT, y compris quand le système demande
        # ``prefers-reduced-motion: reduce`` : beaucoup ont ce réglage sans le
        # savoir (défaut de plusieurs bureaux, et de tout poste où l'on a coupé
        # les effets visuels). Ne pas suivre le système par défaut : ils
        # verraient une image fixe, avec pour seul remède une case à deviner.
        #
        # Le choix reste ENTIER : la case vit à côté du sélecteur de mascotte,
        # toujours visible, et la décocher rend l'accueil à l'arrêt.
        "welcome_mascot_anime": True,
        "auto_open_editor_on_write": True,
        "editor_font_size": 14,
        "editor_font_family": "JetBrains Mono",
        "editor_tab_size": 4,
        "editor_insert_spaces": True,
        "editor_word_wrap": "off",
        "editor_minimap": False,
        "editor_line_numbers": True,
        "editor_edit_highlight": True,
        "editor_auto_save": "off",
        "editor_persist_tabs": True,    # mémorisation des onglets — défaut ON
        "editor_follow_active": False,  # l'arbre suit le fichier ouvert — opt-in
        "memory_enabled": False,   # Mémoire long-terme (Hermes) — opt-in
        "hide_thinking": False,
        "agents_enabled": False,   # Sous-agents (outil ``task``) — opt-in
        "custom_agents": [],       # agents custom (façon OpenCode /agent)
        "live_shell_enabled": True,  # Terminal en direct — affichage, défaut ON
        # Compaction AUTOMATIQUE de la conversation : opt-in. OFF = seul
        # /compact (manuel) compacte — l'utilisateur garde la main.
        "compression_enabled": False,
        # « Contexte max avant compaction », au choix en % de la fenêtre du
        # modèle (même unité que la jauge live du composeur) ou en nombre de
        # tokens — les tokens priment quand les deux sont posés, et l'interface
        # n'en écrit jamais deux (choisir une unité efface l'autre). 0 des deux
        # côtés = auto : on compacte quand la fenêtre est pleine (plafond
        # technique). Le défaut d'instance
        # admin (``llm.compaction.threshold_*``) prend le relais côté chat
        # quand les deux valent 0 — il n'est pas recopié ici, sinon un
        # changement admin n'atteindrait plus les comptes déjà migrés.
        "compression_threshold_pct": 0,
        "compression_threshold_tokens": 0,
        # Nombre maximal de compactions pour UNE conversation (automatiques et
        # /compact confondus). 0 = auto : le plafond d'instance
        # (``llm.compression.max_per_chat``) s'applique. -1 =
        # illimité — nécessaire aux missions de plusieurs heures, où un seul
        # tour peut franchir le seuil dix fois ou plus ; le cap atteint, la
        # compaction s'arrête et il ne reste que le budget dur, qui JETTE les
        # vieux tours au lieu de les résumer.
        "compression_max_rounds": 0,
        # Outils externes (panneau Outils + serveurs MCP). Fail-open : bien des
        # comptes n'ont jamais enregistré cette clé, un défaut à false leur
        # retirerait les outils sans qu'ils aient ouvert ce réglage. Seul un
        # false EXPLICITE coupe — appliqué au tour de chat par
        # ``chatbot_app/turn/preparation.py`` (``_mcp_on``).
        "enable_mcp": True,
        # Moteur vocal — opt-in strict, comme ``memory_enabled`` et
        # ``agents_enabled``. Le front miroite ces défauts dans
        # ``loadSettingsData()`` : les deux doivent rester alignés, sinon la
        # valeur affichée dépend de qui du GET ou du PUT a parlé en premier.
        "voice_input_enabled": False,
        "voice_reply_enabled": False,
        "voice_reply_tools_enabled": False,
        # Images : cochées par défaut, l'administrateur décide de l'offre.
        "image_enabled": True,
        "image_tool_enabled": True,
    }
    allumees, actives, defaut_admin = _reglage_mascottes()
    defaults["welcome_mascot"] = defaut_admin
    for k, v in defaults.items():
        if k not in saved:
            saved[k] = v
    # Une mascotte DÉSACTIVÉE depuis que le compte l'a choisie retombe sur le
    # défaut d'admin, jamais sur une boîte vide.
    if saved.get("welcome_mascot") and saved["welcome_mascot"] not in actives:
        saved["welcome_mascot"] = defaut_admin
    saved["mascottes_actives"] = actives
    # Le registre des personnages voyage avec les réglages : l'interface n'a
    # pas sa propre copie de la liste (libellés compris).
    saved["mascottes_catalogue"] = _skins.mascots_catalogue()
    # Un skin DÉSACTIVÉ (ou supprimé) depuis que le compte l'a choisi retombe
    # sur le défaut d'instance — même politique que la mascotte.
    saved["skin"] = _skins.resolve_user_skin(saved.get("skin"))
    # L'interrupteur voyage AVEC les réglages, calculé serveur : le client n'a
    # pas à relire config.json ni à deviner qu'une liste vide veut dire
    # « coupé ». Sans lui, l'interface afficherait un sélecteur d'une seule
    # ligne, qu'on prend pour une panne.
    saved["mascottes_on"] = allumees
    username = get_username_by_id(uid) or "guest"
    safe_name = "".join([c for c in username if c.isalnum() or c in ('-', '_')])
    try:
        sandbox_path = (SANDBOX_DIR / safe_name).resolve()
        display_path = str(sandbox_path)
    except Exception:
        display_path = "Error path"
    saved["sandbox_path_display"] = display_path

    try:
        glob_cfg = read_config_json() or {}
        saved["enable_model_selector"] = bool(glob_cfg.get("app", {}).get("enable_model_selector", False))
    except Exception:
        saved["enable_model_selector"] = False

    # Images, calculé ici : moteur proposé à CE compte (instance + groupes),
    # puis la case du compte. Préférences ramenées aux limites du moteur.
    from shared_infra.image import access as _img_access
    from shared_infra.image.config import get_image_config as _img_cfg
    _cfg_img = _img_cfg()
    saved["image_ready"] = _img_access.ready_for(uid, _cfg_img)
    saved["image_available"] = saved["image_ready"] and saved.get("image_enabled") is not False
    saved["image_prefs"] = _img_access.clean_prefs(saved.get("image_prefs"), _cfg_img)

    # Les secrets MCP perso ne repartent JAMAIS vers le navigateur : il ne reçoit
    # que ``has_auth``, comme pour la bibliothèque partagée. Le formulaire
    # d'édition affiche « inchangé » et n'envoie un secret que si l'on en tape un.
    if isinstance(saved.get("mcp_servers"), list):
        from shared_infra.mcp.servers import personal_public as _pp
        saved["mcp_servers"] = [_pp(s) for s in saved["mcp_servers"]
                                if isinstance(s, dict)]

    return JSONResponse(saved, headers={"Cache-Control": "no-cache"})

@router.put("/api/settings")
async def api_put_settings(request: Request):
    uid = require_user_id(request)
    raw = await request.json()
    if not isinstance(raw, dict):
        raise HTTPException(400, "Le payload doit être un objet JSON.")

    data = {k: v for k, v in raw.items() if k in _USER_SETTINGS_ALLOWED}
    # Processus admin (APP_MODE=admin) : la console n'écrit que l'apparence
    # (menu « Compte et apparence », Ctrl+K). Le reste des préférences —
    # serveurs MCP, agents… — reste l'affaire du port principal.
    if os.environ.get("APP_MODE") == "admin":
        extra = sorted(k for k in data if k not in _ADMIN_PORT_SETTINGS)
        if extra:
            raise HTTPException(403, "Préférence non modifiable depuis la console : " + ", ".join(extra))

    SANDBOX_PROTECTED = ("sandbox_mode", "network_profile_id")
    current = get_user_settings(uid) or {}
    # Ces clés ne se modifient QUE via /api/sandbox/me : RETIRÉES du payload,
    # ``merge_user_settings`` ne les touche jamais et elles gardent leur valeur
    # DB. Ne pas ré-appliquer ``current[k]`` : ``current`` est lu HORS
    # transaction, une bascule de profil réseau concurrente (autre onglet)
    # serait écrasée par la valeur précédente.
    for k in SANDBOX_PROTECTED:
        data.pop(k, None)

    # Sous-agents : coercition stricte du toggle + validation/normalisation des
    # agents custom (source de vérité UNIQUE : llm_core.tools.task_tool —
    # mêmes contraintes que la map effective de la factory). Idempotent : le
    # bouton Enregistrer global re-PUT une liste déjà canonique sans friction.
    if "agents_enabled" in data:
        data["agents_enabled"] = bool(data["agents_enabled"])
    if "dark_mode_auto" in data:
        data["dark_mode_auto"] = bool(data["dark_mode_auto"])
    if "opencode_mcp_families" in data:
        # Normalisation stricte : dict {famille CONNUE: bool}. Un payload d'un
        # autre type est ignoré (clé retirée) plutôt que stocké tel quel — il
        # finirait dans un ``opencode.json`` servi à un poste.
        from shared_infra.mcp.families import FAMILY_NAMES as _FAMS
        raw_fams = data.get("opencode_mcp_families")
        if isinstance(raw_fams, dict):
            data["opencode_mcp_families"] = {
                str(k): bool(v) for k, v in raw_fams.items() if str(k) in _FAMS}
        else:
            data.pop("opencode_mcp_families", None)
    if "live_shell_enabled" in data:
        data["live_shell_enabled"] = bool(data["live_shell_enabled"])
    for _cle_image in ("image_enabled", "image_tool_enabled"):
        if _cle_image in data:
            data[_cle_image] = bool(data[_cle_image])
    if "image_prefs" in data:
        from shared_infra.image.access import clean_prefs
        data["image_prefs"] = clean_prefs(data["image_prefs"])
    for _cle_voix in ("voice_input_enabled", "voice_reply_enabled",
                      "voice_reply_tools_enabled"):
        if _cle_voix in data:
            data[_cle_voix] = bool(data[_cle_voix])
    if "compression_enabled" in data:
        data["compression_enabled"] = bool(data["compression_enabled"])
    if ("compression_threshold_pct" in data
            or "compression_threshold_tokens" in data):
        # Source UNIQUE de la coercition (0 = auto, sinon [30, 100] pour le %
        # et [2048, 4M] pour les tokens) : les mêmes fonctions servent au chat
        # et au défaut d'instance, donc un réglage donne le même chiffre
        # partout. Valeur illisible → 0, jamais un 400 : un blob rejeté rendrait
        # TOUS les réglages non enregistrables (même politique que
        # custom_agents / mascotte).
        from llm_core.context.compaction_gate import clamp_threshold_pct, clamp_threshold_tokens
        if "compression_threshold_pct" in data:
            data["compression_threshold_pct"] = clamp_threshold_pct(
                data["compression_threshold_pct"])
        if "compression_threshold_tokens" in data:
            data["compression_threshold_tokens"] = clamp_threshold_tokens(
                data["compression_threshold_tokens"])
        # Les deux unités sont EXCLUSIVES : poser l'une efface l'autre. Sans
        # ça, un compte passé de « 70 % » à « 80k » garderait un 70 % fantôme
        # qui ressortirait au moment où il repasse le seuil en tokens à 0 —
        # « auto » lui rendrait alors un pourcentage qu'il croyait oublié.
        # Le côté NON envoyé est celui qu'on efface (le client n'envoie que
        # l'unité choisie), et seule une valeur RÉELLEMENT posée efface.
        if data.get("compression_threshold_tokens"):
            data["compression_threshold_pct"] = 0
        elif data.get("compression_threshold_pct"):
            data["compression_threshold_tokens"] = 0

    if "compression_max_rounds" in data:
        # Même source unique de coercition que le seuil : 0 = auto, -1 =
        # illimité, sinon borné à MAX_ROUNDS_MAX. Valeur illisible → 0 (auto),
        # jamais un 400 — un blob rejeté rendrait TOUS les réglages non
        # enregistrables.
        from llm_core.context.compaction_gate import clamp_max_rounds
        data["compression_max_rounds"] = clamp_max_rounds(
            data["compression_max_rounds"])

    if "skin" in data:
        # Jeu FERMÉ lui aussi : seuls les skins activés par l'administrateur.
        # Valeur inconnue ou désactivée → défaut d'instance, jamais un 400 (un
        # blob rejeté rendrait TOUS les réglages non enregistrables).
        data["skin"] = _skins.resolve_user_skin(data["skin"])
    if "welcome_mascot_anime" in data:
        data["welcome_mascot_anime"] = bool(data["welcome_mascot_anime"])
    if "welcome_mascot" in data:
        # Jeu FERMÉ : la valeur part telle quelle dans ``data-perso``, et la
        # feuille générée n'a de règle que pour ces cinq-là — un id inconnu
        # rendrait une boîte vide sans rien dire. "" est légitime : c'est le
        # repli sur le logo configuré par l'admin.
        _, actives, _ = _reglage_mascottes()
        data["welcome_mascot"] = (
            str(data["welcome_mascot"] or "")
            if str(data["welcome_mascot"] or "") in actives else "")
    if "custom_agents" in data:
        from llm_core.tools.task_tool import validate_custom_agents
        try:
            data["custom_agents"] = validate_custom_agents(data["custom_agents"])
        except ValueError as e:
            raise HTTPException(400, str(e))

    if "shared_mcp_visible" in data:
        # Simple choix d'AFFICHAGE : on ne garde que des ids ``shared:<n>``
        # bien formés (dédupliqués, bornés). Un id qui ne correspond à rien
        # est inerte — la bibliothèque évolue indépendamment des comptes.
        from shared_infra.mcp.servers import shared_id as _sid
        seen: list = []
        for v in (data.get("shared_mcp_visible") or [])[:200]:
            s = str(v or "")
            if _sid(s) is not None and s not in seen:
                seen.append(s)
        data["shared_mcp_visible"] = seen

    if "mcp_servers" in data:
        # Les deux espaces d'ids ne doivent PAS se recouvrir : ``shared:<n>``
        # appartient à la bibliothèque publiée, et la route de chat résout
        # TOUJOURS un id de cette forme en base (en ignorant ce que le client a
        # posé). Un serveur perso portant un tel id serait donc silencieusement
        # remplacé par le serveur partagé de même numéro — ou jeté. On le
        # renomme au lieu de refuser le PUT : un blob rejeté rendrait TOUS les
        # réglages non enregistrables (même raisonnement que les noms d'agents).
        from shared_infra.mcp.servers import ID_PREFIX as _SHARED_PREFIX
        for _i, _s in enumerate(data.get("mcp_servers") or []):
            if isinstance(_s, dict) and str(_s.get("id") or "").startswith(_SHARED_PREFIX):
                _s["id"] = f"server_local_{_i}_{str(_s['id']).replace(':', '_')}"
                logger.warning("[settings] id de serveur MCP perso dans l'espace "
                               "partagé — renommé en %s", _s["id"])

        old_settings = current
        old_list = old_settings.get("mcp_servers", []) or []
        raw_new_list = data.get("mcp_servers", []) or []

        me = get_user_by_id(uid)
        # ``== 1`` : un modérateur (2) n'a pas le droit de modifier/supprimer
        # un serveur MCP existant.
        is_admin = bool(me and me["is_admin"] == 1)

        # Un non-admin ne peut pas se donner d'auth sur un serveur existant :
        # le secret ne transite jamais vers le navigateur, il n'apparaît donc
        # pas dans le diff plus bas — sans ce contrôle, la règle « modification
        # réservée aux administrateurs » ne couvrirait pas les identifiants.
        if not is_admin:
            _old_ids = {str(s.get("id")) for s in old_list
                        if isinstance(s, dict) and s.get("id")}
            def _posts_a_value(_s: dict) -> bool:
                """Le payload porte-t-il un secret NEUF ? ``auth_secret``, mais
                aussi une valeur d'en-tête ou de variable : ce sont trois
                créneaux du même ordre, et n'en contrôler qu'un laisserait
                passer une modification d'identifiants par la porte à côté."""
                if str(_s.get("auth_secret") or ""):
                    return True
                for _k in ("headers", "env"):
                    for _p in (_s.get(_k) or []):
                        if isinstance(_p, dict) and str(_p.get("value") or ""):
                            return True
                return False

            for _s in raw_new_list:
                if (isinstance(_s, dict) and str(_s.get("id")) in _old_ids
                        and _posts_a_value(_s)):
                    raise HTTPException(
                        403, "Modification de serveur MCP réservée aux administrateurs.")

        # Fusion AVANT le diff : le secret n'est jamais peuplé depuis les octets
        # du client, et « vide = inchangé » évite que le re-PUT du blob entier
        # (chaque changement de préférence) n'efface tous les jetons.
        from shared_infra.mcp.servers import StdioNotAllowed as _StdioNotAllowed, merge_personal_mcp as _merge
        from shared_infra.security.encryption import EncryptionUnavailable
        # ``stdio`` = commande exécutée sur l'HÔTE : administrateur PLEIN
        # seulement (is_admin == 1, pas le modérateur), cf. StdioNotAllowed.
        _stdio_ok = bool(me and me["is_admin"] == 1)
        try:
            new_list = _merge(old_list, raw_new_list, allow_stdio=_stdio_ok)
        except _StdioNotAllowed as exc:
            raise HTTPException(403, str(exc))
        except EncryptionUnavailable:
            raise HTTPException(
                503, "Chiffrement indisponible : impossible d'enregistrer un "
                     "secret MCP. Configurez app.encryption_key.")
        data["mcp_servers"] = new_list

        if not is_admin:
            old_by_id = {s.get("id"): s for s in old_list if s.get("id")}
            new_by_id = {s.get("id"): s for s in new_list if s.get("id")}
            removed = set(old_by_id.keys()) - set(new_by_id.keys())
            if removed:
                raise HTTPException(403, "Suppression de serveur MCP réservée aux administrateurs.")
            # ``auth_enc``/``key_scheme`` sortent du diff : ils sont posés par la
            # fusion côté serveur, pas par le client. Les comparer ferait échouer
            # toute sauvegarde dès qu'une entrée legacy est reprise au vol.
            # ``authorization``/``basic_auth`` : clés LEGACY encore présentes sur
            # une entrée non migrée, que la fusion remplace par ``auth_enc``.
            # Sans les exclure, la reprise au vol déclencherait un 403.
            # ``headers_enc``/``env_enc``/``extra_scheme`` : posés par la fusion
            # côté serveur, jamais par le client — même raisonnement que
            # ``auth_enc``. ``headers`` : clé LEGACY (dict d'en-têtes en clair)
            # que la fusion migre vers le créneau chiffré et RETIRE de
            # l'entrée ; sans l'exclure, la première sauvegarde qui suit la
            # migration déclencherait un 403 chez tout non-admin.
            mutable_keys = {"visible", "auth_enc", "key_scheme",
                            "has_auth", "auth_secret",
                            "authorization", "basic_auth",
                            "headers", "headers_enc", "env", "env_enc",
                            "extra_scheme"}
            for sid, old_s in old_by_id.items():
                new_s = new_by_id.get(sid)
                if not new_s:
                    continue
                all_keys = set(old_s.keys()) | set(new_s.keys())
                for k in all_keys - mutable_keys:
                    if old_s.get(k) != new_s.get(k):
                        raise HTTPException(403, "Modification de serveur MCP réservée aux administrateurs.")

        old_mcp = json.dumps(old_list, sort_keys=True)
        new_mcp = json.dumps(new_list, sort_keys=True)
        if old_mcp != new_mcp:
            # Invalidation CIBLÉE : seuls les serveurs dont la définition a
            # changé sont invalidés. Ne pas ``reset()`` tout le pool : il
            # fermerait aussi les MCP personnels des AUTRES utilisateurs du
            # worker, et sauvegarder ses propres réglages couperait la
            # connexion de son voisin en pleine génération. (L'entrée des
            # outils locaux est protégée dans ``reset`` lui-même : elle ne
            # dépend d'aucune configuration utilisateur.)
            try:
                from shared_infra.mcp.servers import personal_to_config
                _old_by_id = {str(s.get("id")): s for s in old_list
                              if isinstance(s, dict) and s.get("id")}
                _new_by_id = {str(s.get("id")): s for s in new_list
                              if isinstance(s, dict) and s.get("id")}
                _sans_id = (len(_old_by_id) != len(old_list)
                            or len(_new_by_id) != len(new_list))
                if _sans_id:
                    # Entrée legacy sans identifiant : on ne sait pas apparier,
                    # on retombe sur le recyclage large (persistantes gardées).
                    await mcp_pool.reset()
                    logger.info("[MCP_POOL] Pool reset (entrée MCP sans id).")
                else:
                    _touches = [
                        sid for sid in set(_old_by_id) | set(_new_by_id)
                        if json.dumps(_old_by_id.get(sid), sort_keys=True)
                        != json.dumps(_new_by_id.get(sid), sort_keys=True)]
                    _fermees = 0
                    for sid in _touches:
                        # L'ancienne ET la nouvelle définition : si l'URL ou la
                        # commande a changé, la clé de pool change avec elle et
                        # l'ancienne connexion resterait sinon ouverte.
                        for _src in (_old_by_id.get(sid), _new_by_id.get(sid)):
                            if not _src:
                                continue
                            # Clé de pool seulement (aucune exécution) : une
                            # entrée stdio doit aussi être invalidée.
                            _cfg = personal_to_config(_src, allow_stdio=True)
                            if _cfg:
                                await mcp_pool.invalidate(_cfg)
                                _fermees += 1
                    logger.info(
                        "[MCP_POOL] %d serveur(s) MCP modifié(s) → %d clé(s) "
                        "invalidée(s) ; les autres connexions du worker sont "
                        "conservées.", len(_touches), _fermees)
            except Exception as e:
                logger.warning(f"[MCP_POOL] Erreur invalidation pool: {e}")
    # Persistance NON destructive : on FUSIONNE les clés reçues dans les réglages
    # existants au lieu de tout remplacer. Un PUT partiel (ex. le toggle mémoire
    # enregistré seul dès qu'on le bascule) ne doit JAMAIS effacer les autres
    # réglages. Fusion ATOMIQUE : ``merge_user_settings`` relit sous
    # ``BEGIN IMMEDIATE`` et applique ``data`` sur l'état FRAIS (et non sur
    # ``current`` lu plus haut) — pas de course lecture-modif-écriture.
    # BEGIN IMMEDIATE = attente bornée par busy_timeout (10 s) : hors boucle,
    # sinon un écrivain long en vol gèle tout le worker sur un simple toggle.
    await asyncio.to_thread(merge_user_settings, uid, lambda s: s.update(data))
    return {"ok": True}
