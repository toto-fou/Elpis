# SPDX-License-Identifier: MIT
# tools/desktop_tools.py
"""
Desktop / remote-VM control MCP — computer-use tools.

Drives a small control-agent installed on a target machine (Windows via
pywinauto, Linux via AT-SPI) over HTTP, exactly the way ``firefox_tools`` drives
the Playwright sidecar. Combined with a dedicated detection endpoint (the
"annotation model"), the model can SEE a screen as annotated UI elements and ACT
on them.

Tools
  desktop_session    list configured targets / ping one (read-only)
  desktop_screenshot raw screenshot of a target (read-only)
  desktop_observe    screenshot → detection endpoint ⊕ a11y tree → annotated
                     element list with stable ids (read-only)
  desktop_act        click/type/key/scroll/move/drag by element id, by a
                     natural-language target, or by raw x,y (mutating)
  desktop_inspect    raw accessibility tree of a target (read-only)

Coordinates are always NATIVE screenshot pixels end-to-end (the detection client
rescales for us), so an ``element_id`` from ``desktop_observe`` clicks the right
place. Targets are resolved BY NAME from the admin registry — a model never
supplies a URL (SSRF guard), mirroring the Playwright screenshot route.
"""
from __future__ import annotations

import base64
import json
import io
import logging
import os
import secrets
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests
from fastmcp import Context, FastMCP

from ._toolkit import with_policy, Heartbeat  # politique par outil (P2), battement (P3)
from ._toolkit import (
    ok, err, get_username,
    tool_kw_openworld, tool_kw_mutating,
)

import shared_infra.config as _cfg
from llm_core._detection_client import detect, read_text as _ocr
from llm_core._desktop_session import (
    desktop_frame_path, ensure_screens_dir, prune_frames, register_desktop_frame_owner,
    register_desktop_observation, resolve_element, _resolve_element_impl,
    assign_stable_ids, set_screen_dims, get_screen_dims, validate_point,
    ambiguous_query_candidates,
)

logger = logging.getLogger("uvicorn.error")

# ── Category descriptor (auto-discovered via tags/meta, like browser) ─────────
CATEGORY = {
    "name":  "desktop",          # internal id (tool prefix desktop_*) — unchanged
    "label": "Contrôle d'écran",  # user-facing label in the MCP tools panel
    "icon":  "ph-desktop",
    "color": "teal",
}
_TOOL_KW_OW_RO  = tool_kw_openworld(CATEGORY, read_only=True, serial=True, prune="desktop")
_TOOL_KW_OW_MUT = tool_kw_mutating(CATEGORY, open_world=True, serial=True, prune="desktop")


# ── Target resolution + agent transport ──────────────────────────────────────
def _resolve_target(name: str, username: str = "") -> Optional[Dict[str, Any]]:
    """Fresh target dict from the admin registry (hot-reloaded). Priorité :
    ``name`` explicite > cible ACTIVE choisie par l'utilisateur (sélecteur UI) >
    cible ``default`` de la config. None si rien n'est configuré."""
    try:
        _cfg.reload_desktop_config_from_disk()
    except Exception:
        pass
    if not name and username:
        try:
            from llm_core._desktop_session import get_active_target
            name = get_active_target(username) or ""
        except Exception:
            name = ""
    # Accès par machine (audit 2026-09-22, M2) : seules les cibles permises à
    # ce compte sont candidates — un nom interdit se comporte comme inconnu,
    # et le défaut retombe sur la première machine permise.
    from shared_infra.desktop.access import allowed_targets
    targets = allowed_targets(_cfg.get_desktop_targets(reload=False), username)
    if name:
        for t in targets:
            if t.get("name") == name:
                return t
    for t in targets:
        if t.get("default"):
            return t
    return targets[0] if targets else None


def _resolve_target_strict(name: str, username: str = "") -> Optional[Dict[str, Any]]:
    """Comme :func:`_resolve_target`, mais un NOM explicite doit désigner cette
    cible : un nom inconnu (« vm-tset ») retombait sur la cible par défaut — un
    script mutant partait sur une autre machine, étiqueté du nom demandé."""
    tgt = _resolve_target(name, username)
    name = str(name or "").strip()
    if tgt and name and str(tgt.get("name") or "") != name:
        return None
    return tgt


def _unknown_target_err(name: str) -> Dict[str, Any]:
    if not str(name or "").strip():
        return _no_target_err()
    return err("no_target", f"cible inconnue : « {name} »",
               fix="use a target name from Admin → Vision & Desktop (exact spelling)",
               retryable=False)


def _no_target_err() -> Dict[str, Any]:
    return err(
        "no_target",
        "no desktop control target is configured",
        fix="add one in Admin → Vision & Desktop (name, OS, agent URL)",
        next_action="ask the user to configure a target, then retry",
    )


def _agent_err_message(resp: Any) -> Optional[str]:
    """Extrait le message d'erreur d'une réponse agent, quel que soit le format :
    FastAPI ``HTTPException`` → ``{"detail": …}`` ; nos err() → ``{"error": …}``.
    Sans ça, un 501/4xx perdait son vrai motif."""
    try:
        b = resp.json()
    except Exception:
        return None
    if not isinstance(b, dict):
        return None
    for k in ("detail", "error", "message"):
        v = b.get(k)
        if isinstance(v, str) and v.strip():
            return v
    return None


# Session HTTP RÉUTILISÉE (keep-alive) vers le control-agent : un pool de connexions
# évite le handshake TCP à CHAQUE appel — or une seule action LLM en enchaîne 3-5
# (observe = screenshot+ui_tree ; clic = element+observe). Sur un lien VM/LAN, la
# latence de connexion domine → gain net. Thread-safe pour des requêtes indépendantes.
# max_retries=0 : on conserve la sémantique d'erreur existante (_agent_req renvoie
# un err() retryable, le client borne déjà l'attente).
_AGENT_SESSION = requests.Session()
try:
    _agent_adapter = requests.adapters.HTTPAdapter(pool_connections=8, pool_maxsize=16, max_retries=0)
    _AGENT_SESSION.mount("http://", _agent_adapter)
    _AGENT_SESSION.mount("https://", _agent_adapter)
except Exception:  # pragma: no cover
    pass


# Endpoints agent IDEMPOTENTS (lecture pure) → rejouables sur erreur RÉSEAU.
# TOUT le reste est MUTANT (click/type/key/scroll/move/drag/invoke/set_value/
# launch/window_action/clipboard_set/run_command/select_monitor) et ne DOIT
# JAMAIS être rejoué automatiquement (⚠ /element = action sémantique = MUTANT).
_RETRY_ON_CONN = frozenset({
    "/health", "/monitors", "/screenshot", "/ui_tree",
    "/windows", "/clipboard_get", "/wait_window", "/wait_element",
})
# Sur ReadTimeout, on NE rejoue PAS les /wait_* : un timeout de lecture signifie
# qu'on a déjà attendu ~timeout_ms côté agent — rejouer doublerait l'attente. Un
# ConnectionError (connexion jamais établie/reset) reste rejouable pour eux.
_RETRY_ON_TIMEOUT = _RETRY_ON_CONN - {"/wait_window", "/wait_element"}


def _agent_req(target: Dict[str, Any], endpoint: str,
               payload: Optional[Dict[str, Any]] = None,
               method: str = "POST", timeout: Optional[int] = None) -> Dict[str, Any]:
    """Call the control-agent. Returns its JSON, or a harmonized err().

    Courte RETRANSMISSION transport (config ``desktop.transport_retries``) sur
    erreur RÉSEAU pour les endpoints IDEMPOTENTS uniquement : un paquet LAN perdu
    sur un /ui_tree échouait sans re-tentative — coûteux sur un rejeu de 500 pas.
    Les endpoints mutants gardent leur unique essai (jamais de double action)."""
    url = target["agent_url"].rstrip("/") + endpoint
    t = timeout if timeout is not None else _cfg.DESKTOP_AGENT_TIMEOUT_SEC
    retries = _cfg.DESKTOP_TRANSPORT_RETRIES
    # Déploiement full local — pas d'auth inter-machine (décision 2026-06 :
    # une couche token ajouterait de la complexité sans menace correspondante).
    attempt = 0
    # Échéance du CLIENT transmise à l'agent : une op encore en FILE quand on a
    # abandonné (agent_timeout ici) n'est plus exécutée là-bas — sans ça, un clic
    # en attente derrière un /wait_window partait APRÈS l'erreur, et le réessai
    # de l'appelant cliquait une 2e fois.
    headers = {"X-Elpis-Timeout": str(t)}
    while True:
        try:
            if method == "GET":
                resp = _AGENT_SESSION.get(url, timeout=t, headers=headers)
            else:
                resp = _AGENT_SESSION.post(url, json=(payload or {}), timeout=t, headers=headers)
            break
        except requests.exceptions.ConnectionError:
            if attempt < retries and endpoint in _RETRY_ON_CONN:
                attempt += 1
                time.sleep(0.3 * attempt)
                continue
            return err("agent_unreachable",
                       f"control-agent for '{target['name']}' is unreachable at {target['agent_url']}",
                       fix="check the agent is running on the target and agent_url/port are correct",
                       retryable=True)
        except requests.exceptions.Timeout:
            if attempt < retries and endpoint in _RETRY_ON_TIMEOUT:
                attempt += 1
                time.sleep(0.3 * attempt)
                continue
            return err("agent_timeout", f"control-agent for '{target['name']}' timed out after {t}s",
                       fix="the target may be busy; retry, or raise desktop.agent_timeout_sec", retryable=True)
        except Exception as e:  # pragma: no cover
            return err("agent_error", str(e))

    if resp.status_code == 501:
        # FastAPI HTTPException sérialise le motif sous « detail » (pas « error ») :
        # sans le lire, on perdait le vrai message (« launch not available on this
        # session » = méthode non implémentée → agent VM obsolète) au profit d'un
        # texte générique. On lit detail/error/message.
        _m = _agent_err_message(resp)
        return err("agent_unsupported", _m or "the agent cannot perform this on the target",
                   fix=("this op may be unavailable on the target's session (e.g. Wayland "
                        "input blocked), OR the control-agent on the VM is OUTDATED and does "
                        "not implement this op yet — redeploy desktop-agent and restart it"),
                   endpoint=endpoint)
    if resp.status_code == 503:
        # Agent OCCUPÉ (worker UIA sérialisé saturé, ou op figée) — voir le worker
        # côté desktop-agent. C'est une RÉPONSE HTTP, pas une erreur transport :
        # surtout NE PAS rejouer (retryable=False), fail-fast pour que l'appelant
        # (rejeu/chat) remonte proprement au lieu d'insister sur un agent bloqué.
        _m = _agent_err_message(resp)
        return err("agent_busy", _m or "the control-agent is busy or an operation is stuck",
                   fix="wait for the current op to finish, or restart the agent on the VM (run.bat)",
                   endpoint=endpoint, retryable=False)
    if resp.status_code != 200:
        _msg = _agent_err_message(resp)
        return err("agent_http_error", _msg or f"control-agent returned {resp.status_code}",
                   status=resp.status_code)
    try:
        data = resp.json()
    except ValueError:
        return err("agent_bad_response", "control-agent returned non-JSON")
    if isinstance(data, dict) and data.get("ok") is False and data.get("error"):
        return err("agent_op_failed", str(data.get("error")))
    return data if isinstance(data, dict) else {"ok": True, "result": data}


# ── Image helpers ─────────────────────────────────────────────────────────────
def _strip_data_url(s: str) -> str:
    if isinstance(s, str) and s.startswith("data:") and "," in s:
        return s.split(",", 1)[1]
    return s


def _png_size(png: bytes) -> Tuple[int, int]:
    try:
        from PIL import Image
        with Image.open(io.BytesIO(png)) as im:
            return int(im.width), int(im.height)
    except Exception:
        return 0, 0


def _frame_sig(png: bytes) -> str:
    """Signature perceptuelle (dHash 64 bits → hex) du frame. Tolérante au bruit
    (curseur, horloge) via la distance de Hamming entre signatures. Sert à
    l'enregistrement de scénarios à détecter l'EFFET d'une action (l'écran a-t-il
    changé ?) et les ALLERS-RETOURS d'état (un état qui réapparaît = boucle)."""
    try:
        from PIL import Image
        with Image.open(io.BytesIO(png)) as im:
            px = im.convert("L").resize((9, 8)).tobytes()   # 72 octets (9×8), 1/px
        bits = 0
        for row in range(8):
            base = row * 9
            for col in range(8):
                bits = (bits << 1) | (1 if px[base + col] > px[base + col + 1] else 0)
        return format(bits, "016x")
    except Exception:
        return ""


def _ham_hex(a: str, b: str) -> int:
    """Distance de Hamming entre deux signatures dHash hex (64 bits). Renvoie 64
    (« totalement différent ») si l'une manque ou si les longueurs diffèrent —
    prudent : on ne conclut jamais « identique » par défaut."""
    if not a or not b or len(a) != len(b):
        return 64
    try:
        return bin(int(a, 16) ^ int(b, 16)).count("1")
    except ValueError:
        return 64


# Mémo des détections VISION par cible : si l'écran n'a pas bougé (même dHash)
# depuis < TTL, on RÉUTILISE les boxes vision (l'op la plus CHÈRE) au lieu de
# relancer le modèle d'annotation. L'arbre a11y ET le frame restent TOUJOURS frais
# → aucune incidence sur le rejeu (qui s'appuie sur l'a11y), juste moins de compute.
_SIG_SAME_OBS = 2
_VISION_MEMO: Dict[str, Dict[str, Any]] = {}
_VISION_MEMO_TTL_S = float(os.environ.get("DESKTOP_VISION_MEMO_TTL_S", "1.5") or 1.5)

# P4 — memo des détections CIBLÉES (``prompt=``), clé = (cible, prompt). Une même
# requête ciblée répétée sur écran figé (retries d'un pas : jusqu'à 5 ; self-heal
# jusqu'à 10/run) repayait 0,5-2 s de vision à chaque fois. TTL un peu plus long
# (couvre le backoff retry 600 ms×n). Gaté par signature dHash + purgé post-action.
_VISION_PROMPT_MEMO: Dict[Any, Dict[str, Any]] = {}
_VISION_PROMPT_MEMO_TTL_S = float(os.environ.get("DESKTOP_VISION_PROMPT_MEMO_TTL_S", "3.0") or 3.0)

# Memo de l'ARBRE a11y, clé = signature dHash de la capture. Les boucles d'attente
# (wait_element/value/state/count, _resolve_anchor) ré-observent toutes les ~600 ms ;
# tant que l'écran ne bouge pas (même dHash) re-marcher tout l'arbre (/ui_tree +
# BuildUpdatedCache ~400 nœuds) est du gaspillage. Sûr car gaté par signature ET
# invalidé après toute action mutante (act_core). TTL court ; 0 = désactivé.
_A11Y_MEMO: Dict[str, Dict[str, Any]] = {}
_A11Y_MEMO_TTL_S = float(os.environ.get("DESKTOP_A11Y_MEMO_TTL_S", "1.0") or 0)


_MEMO_CAP = 64                   # R5 : cap de sécurité (cardinalité déjà bornée par
                                 # le registre de cibles, mais on ne retient pas des
                                 # entrées EXPIRÉES à vie — arbres de ~400 nœuds).
_UI_TREE_MAX_NODES = 400         # plafond de nœuds demandé à /ui_tree (observe + sonde)


def _norm_scope(scope: str) -> str:
    """Normalise le scope d'observation : "" → défaut config ``DESKTOP_OBSERVE_SCOPE``,
    valeur inconnue → ``focus``. Partagé par observe_core et probe_tree_core."""
    scope = (str(scope or "").strip().lower()
             or str(getattr(_cfg, "DESKTOP_OBSERVE_SCOPE", "focus") or "focus"))
    return scope if scope in ("focus", "monitor", "desktop") else "focus"


def _memo_put(d: Dict[Any, Dict[str, Any]], key: Any, rec: Dict[str, Any],
              ttl: float, cap: int = _MEMO_CAP) -> None:
    """Écrit ``rec`` dans le memo ``d`` puis, si le cap est dépassé, purge d'abord
    les entrées franchement expirées (``ts`` > ttl×4) puis éjecte les plus vieilles
    par ``ts``. Borne l'occupation sans LRU sophistiqué. ``rec`` porte le plus grand
    ``ts`` (on vient de l'écrire) → jamais candidat à l'éviction."""
    d[key] = rec
    if len(d) <= cap:
        return
    if ttl > 0:
        now = time.time()
        for k in [k for k, v in d.items() if (now - v.get("ts", 0)) > ttl * 4]:
            d.pop(k, None)
    if len(d) > cap:
        for k in sorted(d, key=lambda k: d[k].get("ts", 0))[:len(d) - cap]:
            d.pop(k, None)


def _invalidate_a11y_memo(target: str) -> None:
    """À appeler après une action mutante : l'arbre a pu changer sans que le dHash
    bouge assez (flip d'état à pixels quasi identiques) → on force une re-lecture."""
    _A11Y_MEMO.pop(target, None)
    # Le memo est désormais clé par "<cible>::<scope>" → purger TOUTES les variantes
    # de scope de cette cible (sinon un arbre focus périmé survivrait à une action).
    for k in [k for k in _A11Y_MEMO if k.startswith(target + "::")]:
        _A11Y_MEMO.pop(k, None)
    # P4 — même logique pour les memos vision (générique + ciblés par prompt).
    _VISION_MEMO.pop(target, None)
    for k in [k for k in _VISION_PROMPT_MEMO if isinstance(k, tuple) and k[0] == target]:
        _VISION_PROMPT_MEMO.pop(k, None)


def _grab(target: Dict[str, Any], fmt: Optional[str] = None) -> Any:
    """Screenshot a target → (img_bytes, width, height) or an err() dict.

    ``fmt`` pilote le format demandé à l'agent (défaut config, souvent PNG). Passer
    ``fmt="png"`` FORCE le PNG (chemin OCR : petit texte). Un agent non redéployé
    ignore le champ ``format`` → PNG. La RETRANSMISSION transitoire (portail de
    capture momentanément injoignable après l'ouverture d'une app) est gérée en
    amont par ``_agent_req`` (/screenshot idempotent, ``desktop.transport_retries``)."""
    _fmt = (fmt or getattr(_cfg, "DESKTOP_SCREENSHOT_FORMAT", "png") or "png")
    # ``quality`` toujours joint : l'agent l'ignore hors JPEG (aucun coût à l'envoyer).
    _payload = {"format": _fmt, "quality": int(getattr(_cfg, "DESKTOP_SCREENSHOT_QUALITY", 85))}
    shot = _agent_req(target, "/screenshot", _payload)
    if isinstance(shot, dict) and shot.get("error"):
        return shot
    img = shot.get("image") or shot.get("image_b64") or shot.get("png")
    if not img:
        return err("no_screenshot", "control-agent did not return an image",
                   fix="check the agent's screenshot backend (Wayland may need grim/portal)")
    try:
        png = base64.b64decode(_strip_data_url(img))
    except Exception:
        return err("bad_screenshot", "control-agent image was not valid base64")
    w = int(shot.get("width") or 0)
    h = int(shot.get("height") or 0)
    if not w or not h:
        w, h = _png_size(png)
    return png, w, h


def _save_frame(png: bytes, owner: str) -> str:
    """Persist a frame to the shared screens dir; return its opaque token.

    ``owner`` (username) enregistre la propriété (R9) — mémoire + sidecar disque via
    ``register_desktop_frame_owner`` : REQUIS car sous ``DESKTOP_FRAME_STRICT_OWNER``
    une frame sans propriétaire est inservable (404). Threadé depuis les cores
    (observe/act/launch/wait) qui ont tous ``username``."""
    token = secrets.token_urlsafe(16)
    ensure_screens_dir()
    try:
        with open(desktop_frame_path(token), "wb") as f:
            f.write(png)
    except Exception as e:
        logger.warning("[desktop] frame save failed: %s", e)
    if owner:
        register_desktop_frame_owner(token, owner)
    prune_frames()  # age out stale frames (served repeatably, not one-shot)
    return token


def grab_core(username: str, target: str = "") -> Dict[str, Any]:
    """Capture brute → signature dHash, SANS détection (ni vision ni arbre a11y).
    C'est la sonde la MOINS CHÈRE (un screenshot, zéro modèle) — utilisée par les
    attentes du rejeu pour savoir si l'écran a fini de bouger (stabilisation)."""
    tgt = _resolve_target(target, username)
    if not tgt:
        return _no_target_err()
    grabbed = _grab(tgt)
    if isinstance(grabbed, dict):
        return grabbed
    png, w, h = grabbed
    set_screen_dims(username, tgt["name"], w, h)   # borne les coords d'action
    return ok(target=tgt["name"], img_w=w, img_h=h, sig=_frame_sig(png))


def _element_importance(e: Dict[str, Any]) -> int:
    """Score d'« actionnabilité » d'un élément perçu, pour la troncature B2.
    Priorité à ce qu'un modèle TEXTE peut réellement utiliser : ``auto_id``
    (ops sémantiques fiables, poids fort) > libellé (adressable par requête) ;
    bonus vision (comble les apps sans a11y). Le décor anonyme score 0 et tombe
    en premier sous le cap ``max_elements``."""
    score = 0
    if str(e.get("auto_id") or "").strip():
        score += 3
    if str(e.get("label") or e.get("name") or "").strip():
        score += 2
    if e.get("source") != "a11y":      # vision/merged : comble les trous (canvas)
        score += 1
    return score


def observe_core(username: str, target: str = "", prompt: str = "",
                 use_vision: bool = True, use_tree: bool = True,
                 max_elements: int = 0, scope: str = "",
                 persist_frame: bool = True, max_nodes: int = 0) -> Dict[str, Any]:
    """Screenshot → detection ⊕ a11y tree → annotated elements (ok()/err()).

    ``max_elements=0`` (défaut) = LISTE COMPLÈTE (chat, Studio ET rejeu) : tronquer
    masquait des éléments à détecter/résoudre. >0 = plafond importance-aware (opt-in).

    ``max_nodes`` (0 = ``_UI_TREE_MAX_NODES``) : plafond de nœuds demandé à l'agent
    pour l'arbre a11y. Le chat garde le défaut (budget de tokens) ; le Studio, qui
    doit descendre jusqu'aux feuilles de ce que l'humain voit, en demande plus.
    L'agent parcourt en pré-ordre borné : plafond atteint = feuilles MANQUANTES,
    signalé par ``tree_capped`` (+ note) plutôt que tu.

    ``scope`` ∈ focus|monitor|desktop ("" → défaut config ``DESKTOP_OBSERVE_SCOPE``) :
    focus = SEULE la fenêtre au premier plan (défaut, le moins bruité).

    Shared by the ``desktop_observe`` tool AND ``POST /api/desktop/capture`` so
    both produce identical frames + element ids. Caches the observation under
    ``username`` for ``desktop_act`` to resolve element ids."""
    tgt = _resolve_target(target, username)
    if not tgt:
        return _no_target_err()
    scope = _norm_scope(scope)
    grabbed = _grab(tgt)
    if isinstance(grabbed, dict):
        return grabbed
    png, w, h = grabbed
    _sig = _frame_sig(png)

    a11y: List[Dict[str, Any]] = []
    _mx = int(max_nodes or 0) or _UI_TREE_MAX_NODES
    _tree_capped = False
    if use_tree:
        # scope-aware ET cap-aware : un arbre focus ne doit PAS être servi pour une
        # requête desktop, ni un arbre à 400 nœuds pour le Studio qui en veut 2000.
        _memo_key = f"{tgt['name']}::{scope}" + (f"::{_mx}" if _mx != _UI_TREE_MAX_NODES else "")
        memo = _A11Y_MEMO.get(_memo_key)
        if (_A11Y_MEMO_TTL_S > 0 and memo
                and (time.time() - memo["ts"]) < _A11Y_MEMO_TTL_S
                and _ham_hex(memo["sig"], _sig) <= _SIG_SAME_OBS):
            a11y = memo["elements"]          # écran figé < TTL → réutilise l'arbre (0 /ui_tree)
        else:
            _body = {"max_nodes": _mx, "scope": scope}
            if _mx > _UI_TREE_MAX_NODES:
                # Au-delà du défaut, l'éventail par nœud (80 enfants) tronquerait
                # encore les listes longues : on l'élargit avec le plafond. Un
                # agent ancien ignore la clé.
                _body["fanout"] = max(80, min(400, _mx // 5))
            tree = _agent_req(tgt, "/ui_tree", _body)
            if isinstance(tree, dict) and not tree.get("error"):
                els = tree.get("elements")
                if isinstance(els, list):
                    a11y = els
            _memo_put(_A11Y_MEMO, _memo_key,
                      {"sig": _sig, "elements": a11y, "ts": time.time()}, _A11Y_MEMO_TTL_S)
        _tree_capped = len(a11y) >= _mx > 0

    vision: List[Dict[str, Any]] = []
    vision_err = ""
    # GATING vision (Windows/UIA) : la détection vision est un FILET pour les
    # surfaces sans a11y (canvas, jeux, vues custom). Quand l'arbre a11y est déjà
    # fourni ET qu'aucun grounding explicite (``prompt``) n'est demandé, on SAUTE
    # les 2 passes coûteuses — UIA seul suffit sur la majorité des apps. Réglable
    # (VISION_A11Y_SKIP_MIN, 0 = toujours appeler la vision).
    _skip_min = int(getattr(_cfg, "VISION_A11Y_SKIP_MIN", 12) or 0)
    _a11y_rich = _skip_min > 0 and not prompt and len(a11y) >= _skip_min
    if use_vision and _cfg.VISION_ENDPOINT_URL and not _a11y_rich:
        # Memo générique (sans prompt) OU ciblé (P4, clé (cible,prompt)) — même
        # gating dHash. Un hit évite un aller-retour vision de 0,5-2 s. On choisit
        # le memo/clé/ttl/cap UNE fois (lookup et store partagent le même triplet).
        _md, _mk, _mttl, _mcap = (
            (_VISION_PROMPT_MEMO, (tgt["name"], prompt), _VISION_PROMPT_MEMO_TTL_S, 32)
            if prompt else
            (_VISION_MEMO, tgt["name"], _VISION_MEMO_TTL_S, _MEMO_CAP))
        _pm = _md.get(_mk)
        if (_mttl > 0 and _pm
                and (time.time() - _pm["ts"]) < _mttl
                and _ham_hex(_pm["sig"], _sig) <= _SIG_SAME_OBS):
            vision = _pm["vision"]           # écran inchangé < TTL → réutilise les boxes
        else:
            vision = detect(
                png,
                endpoint=_cfg.VISION_ENDPOINT_URL,
                fmt=_cfg.VISION_FORMAT,
                prompt=(prompt or _cfg.VISION_PROMPT),
                model=getattr(_cfg, "VISION_MODEL", ""),
                response_map=_cfg.VISION_RESPONSE_MAP,
                timeout=_cfg.VISION_TIMEOUT_SEC,
                native_w=w, native_h=h,
                passes=getattr(_cfg, "VISION_PASSES", 2),
            )
            if vision:
                _memo_put(_md, _mk, {"sig": _sig, "vision": vision, "ts": time.time()},
                          _mttl, cap=_mcap)
        if not vision:
            # Échec/0 box : remonter le diagnostic à la SURFACE (note → toast
            # Studio + retour d'outil) au lieu d'un warning de log invisible.
            from llm_core import _detection_client as _dc
            vision_err = _dc.last_error() or "0 élément renvoyé"

    elements = _merge_elements(a11y, vision)
    _total_elements = len(elements)
    _truncated = False
    if isinstance(max_elements, int) and 0 < max_elements < len(elements):
        # Troncature IMPORTANCE-AWARE (B2) : l'arbre a11y d'un bureau réel dépasse
        # facilement le cap (ui_tree max_nodes=400). On garde d'abord ce qui est
        # ACTIONNABLE pour un modèle TEXTE — auto_id (ops sémantiques fiables,
        # poids fort) puis libellé (adressable par requête) — puis les annotations
        # vision (comblent les apps sans a11y / canvas), et on coupe en DERNIER le
        # décor anonyme (séparateurs, panneaux sans nom). L'ancien tri (vision
        # d'abord, a11y en remplissage) coupait justement les boutons a11y nommés
        # mais sans auto_id quand la vision était bavarde. Tri STABLE → l'ordre de
        # lecture (arbre) est conservé à importance égale.
        elements = sorted(elements, key=_element_importance, reverse=True)[:max_elements]
        _truncated = True

    # persist_frame=False (boucles d'attente du rejeu) : on SAUTE l'écriture disque
    # du PNG + le prune_frames (scan de dossier) — inutiles pour une sonde qui ne
    # fait que résoudre/vérifier. register/stable_ids/dims restent (resolve en a besoin).
    token = _save_frame(png, owner=username) if persist_frame else None
    # Ids STABLES inter-observations (réutilise el_N par runtime_id/auto_id) AVANT
    # d'écraser le cache → tue l'index drift entre la capture et l'action.
    elements = assign_stable_ids(username, tgt["name"], elements)
    register_desktop_observation(username, tgt["name"], elements)
    set_screen_dims(username, tgt["name"], w, h)   # borne les coords d'action

    # Filet : dimensions non nulles. Selon l'agent, _grab() peut renvoyer
    # w/h=0 — or sans dimensions le SVG du Studio met un viewBox 0 0 1 1 et
    # les cadres d'annotation tombent hors champ (seule l'image s'affiche).
    if (not w or not h):
        w2, h2 = _png_size(png)
        w, h = (w or w2), (h or h2)

    note = None
    if not elements and not _cfg.VISION_ENDPOINT_URL and not a11y:
        note = ("no detection endpoint configured and no accessibility tree — "
                "set an endpoint in Admin → Vision & Desktop, or act by raw x,y")
    elif vision_err:
        note = f"annotation vision KO : {vision_err}"
    if _truncated:
        # T2-D : dire au modèle qu'il manque des éléments (sinon il croit l'écran
        # complet et n'affine jamais). Les ``max_elements`` les plus actionnables
        # sont gardés (tri importance) — pour le reste : prompt= ciblé ou scroll.
        _tnote = (f"{_total_elements} elements detected, {len(elements)} shown "
                  f"(most actionable) — narrow with prompt= or scroll")
        note = f"{note} · {_tnote}" if note else _tnote
    if _tree_capped:
        _cnote = f"arbre a11y tronqué à {len(a11y)} nœuds (plafond atteint) : des éléments profonds peuvent manquer"
        note = f"{note} · {_cnote}" if note else _cnote
    return ok(target=tgt["name"], img_w=w, img_h=h, sig=_sig,
              count=len(elements), total=_total_elements, truncated=_truncated,
              elements=elements, frame_token=token,
              vision_used=bool(vision), tree_used=bool(a11y), note=note,
              tree_nodes=len(a11y), tree_capped=_tree_capped)


# ─────────────────────────────────────────────────────────────────────────────
# Exécution d'un script d'automatisation SUR la cible (agent dans la session
# interactive) : dépôt du .py (+ lib/, assets/), lancement, suivi, rapport.
def _slug_auto(name: str) -> str:
    """Nom de fichier d'un script — MÊME règle que le Studio (``_slug`` de
    _studio_automation.js) : accents repliés, minuscules, ``[^a-z0-9]+`` → ``-``,
    60 caractères. Avant, ``_`` gardé et accents non repliés : l'outil cherchait
    ``automations/r-glages.py`` quand le Studio avait enregistré ``reglages.py``."""
    import re as _re
    import unicodedata as _ud
    s = _ud.normalize("NFD", str(name or ""))
    s = _re.sub(r"[̀-ͯ]", "", s).lower()
    s = _re.sub(r"[^a-z0-9]+", "-", s)
    s = _re.sub(r"^-+|-+$", "", s)[:60]
    return s or "automatisation"


# Modules que le runtime (ou l'agent) importe sur la VM, hors bibliothèque standard.
_AGENT_IMPORT_NAMES = frozenset({
    "elpis_auto", "backends", "normalize", "lib", "server", "sitecustomize", "usercustomize",
    "numpy", "mss", "pyautogui", "pywinauto", "comtypes", "fastapi", "uvicorn", "starlette",
    "pydantic", "anyio", "requests", "httpx", "psutil", "win32api", "win32con", "win32gui",
    "win32ui", "pythoncom", "pywintypes", "gi",
})


def _agent_slug(name: str) -> str:
    """Nom du fichier DÉPOSÉ sur l'agent : le slug du Studio, suffixé ``-script``
    quand il masquerait un module (``csv``, ``json``, ``numpy``…). Le script est
    lancé depuis ``automations/`` : un ``csv.py`` y était importé À LA PLACE du
    module par toute exécution suivante, de n'importe quel compte (avec son jeton)."""
    slug = _slug_auto(name)
    names = set(getattr(sys, "stdlib_module_names", ()) or ()) | _AGENT_IMPORT_NAMES
    if slug.isidentifier() and slug in names:
        return slug + "-script"
    return slug


def push_automation_core(username: str, target: str, name: str, code: str,
                         libs: Optional[Dict[str, str]] = None,
                         assets: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """Dépose le script et ses annexes dans ``automations/`` de l'agent. Un dépôt
    d'annexe refusé (413, nom de fichier Windows invalide) est RENDU dans
    ``push_errors`` — il passait en silence et le repli ``image=`` n'avait rien."""
    tgt = _resolve_target_strict(target, username)
    if not tgt:
        return _unknown_target_err(target)
    slug = _agent_slug(name)
    r = _agent_req(tgt, "/put_file", {"path": f"{slug}.py", "content": str(code or "")})
    if not isinstance(r, dict) or r.get("error"):
        return r if isinstance(r, dict) else err("agent_error", "dépôt du script impossible")
    push_errors: List[Dict[str, Any]] = []

    def _put(rel: str, payload: Dict[str, Any]) -> None:
        pr = _agent_req(tgt, "/put_file", payload)
        if not isinstance(pr, dict) or pr.get("error"):
            pr = pr if isinstance(pr, dict) else {}
            push_errors.append({"path": rel, "error": pr.get("error") or "agent_error",
                                "message": pr.get("message") or "dépôt refusé"})

    for rel, text in (libs or {}).items():
        if isinstance(text, str) and str(rel).startswith("lib/") and ".." not in str(rel):
            _put(str(rel), {"path": str(rel), "content": text})
    for rel, b64 in (assets or {}).items():
        if isinstance(b64, str) and str(rel).startswith("assets/") and ".." not in str(rel):
            _put(str(rel), {"path": str(rel), "content_b64": b64})
    return ok(target=tgt["name"], name=slug, push_errors=push_errors)


def start_automation_core(username: str, target: str, name: str, *, dry_run: bool = False,
                          trace: bool = False, repeat: int = 0, args: Optional[List[str]] = None,
                          elpis_url: str = "", elpis_token: str = "") -> Dict[str, Any]:
    tgt = _resolve_target_strict(target, username)
    if not tgt:
        return _unknown_target_err(target)
    body: Dict[str, Any] = {"name": _agent_slug(name), "dry_run": bool(dry_run), "trace": bool(trace),
                            "repeat": int(repeat or 0), "args": list(args or [])}
    if elpis_url:
        body["elpis_url"] = elpis_url
    if elpis_token:
        body["elpis_token"] = elpis_token
    r = _agent_req(tgt, "/run_script", body)
    if not isinstance(r, dict) or r.get("error"):
        return r if isinstance(r, dict) else err("agent_error", "lancement impossible")
    return ok(target=tgt["name"], run_id=r.get("run_id"), name=body["name"])


def automation_status_core(username: str, target: str, run_id: str, with_report: bool = True) -> Dict[str, Any]:
    """État d'une exécution ; une fois finie, le rapport JSON est joint (``report``)."""
    tgt = _resolve_target_strict(target, username)
    if not tgt:
        return _unknown_target_err(target)
    from urllib.parse import quote
    r = _agent_req(tgt, f"/run_status?run_id={quote(str(run_id))}&log_tail=80", method="GET")
    if not isinstance(r, dict) or r.get("error"):
        return r if isinstance(r, dict) else err("agent_error", "état inconnu")
    out = dict(r)
    out["target"] = tgt["name"]
    if with_report and not r.get("running") and r.get("report_dir"):
        f = _agent_req(tgt, f"/get_file?path={quote(str(r['report_dir']).rstrip('/') + '/rapport.json')}", method="GET")
        if isinstance(f, dict) and f.get("content_b64"):
            import base64 as _b64
            try:
                out["report"] = json.loads(_b64.b64decode(f["content_b64"]).decode("utf-8"))
            except Exception:
                out["report"] = None
    return out


def automation_file_core(username: str, target: str, path: str) -> Dict[str, Any]:
    tgt = _resolve_target_strict(target, username)
    if not tgt:
        return _unknown_target_err(target)
    from urllib.parse import quote
    return _agent_req(tgt, f"/get_file?path={quote(str(path))}", method="GET")


def _clamp_timeout_s(v: Any, default: int = 600) -> int:
    """Budget d'exécution PAR CIBLE, borné [30, 3600] ; ``"abc"`` → défaut (jamais un 500)."""
    try:
        n = int(float(v)) if v not in (None, "") else int(default)
    except (TypeError, ValueError):
        n = int(default)
    return max(30, min(3600, n))


# Plafond du harnais pour ``desktop_run_automation`` et budget de la matrice qu'il
# lance (marge pour les dépôts, le rapport et la notification).
_RUN_AUTOMATION_TOOL_CEILING_S = 3700.0
_RUN_AUTOMATION_BUDGET_S = 3600.0

# Sondages d'état ratés À LA SUITE avant d'abandonner le suivi d'une cible : un
# 502 ou un délai réseau passager ne vaut pas « ÉCHEC » (le script continuait, seul).
_STATUS_ERRORS_MAX = 8


def run_automation_core(username: str, targets: List[str], name: str, code: str, *,
                        dry_run: bool = False, trace: bool = False, timeout_s: int = 600,
                        libs: Optional[Dict[str, str]] = None, assets: Optional[Dict[str, str]] = None,
                        poll_s: float = 1.5, notify_user_id: Optional[int] = None,
                        elpis_url: str = "", elpis_token: str = "",
                        total_budget_s: Optional[float] = None) -> Dict[str, Any]:
    """Matrice : le MÊME script sur N cibles, en séquence, jusqu'au bout de chacune
    (borne ``timeout_s`` par cible, comptée APRÈS le dépôt) ; résultats agrégés ;
    notification de fin. ``total_budget_s`` : plafond de toute la matrice (outil
    borné par le harnais) — une cible en cours y est arrêtée, les suivantes sautées.
    ``elpis_url``/``elpis_token`` : la vision d'Elpis pour ``describe=`` (comme
    l'exécution simple — sans eux chaque ``describe=`` attendait puis échouait)."""
    timeout_s = _clamp_timeout_s(timeout_s)
    t0 = time.time()
    results = []
    for target in [t for t in (targets or []) if str(t or "").strip()]:
        begin = time.time()
        if total_budget_s is not None and begin - t0 >= float(total_budget_s):
            results.append({"target": target, "ok": False, "error": "skipped",
                            "message": f"plafond de la matrice atteint ({int(total_budget_s)} s)"})
            continue
        p = push_automation_core(username, target, name, code, libs, assets)
        if p.get("error"):
            results.append({"target": target, "ok": False, "error": p.get("error"), "message": p.get("message")})
            continue
        st = start_automation_core(username, target, name, dry_run=dry_run, trace=trace,
                                   elpis_url=elpis_url, elpis_token=elpis_token)
        if st.get("error"):
            results.append({"target": target, "ok": False, "error": st.get("error"), "message": st.get("message"),
                            "push_errors": p.get("push_errors") or []})
            continue
        run_id = st.get("run_id")
        # Le budget court à partir du LANCEMENT : le dépôt (libs, vignettes) n'est pas
        # du temps d'exécution du script.
        started = time.time()
        deadline = started + float(timeout_s)
        if total_budget_s is not None:
            deadline = min(deadline, t0 + float(total_budget_s))
        last: Dict[str, Any] = {}
        last_err: Dict[str, Any] = {}
        errors = 0
        stop_reason = ""
        while True:
            if time.time() >= deadline:
                stop_reason = "timeout"
                break
            cur = automation_status_core(username, target, run_id)
            if cur.get("error"):
                errors += 1
                last_err = cur
                # 404 « exécution inconnue » = l'agent a redémarré : inutile d'insister.
                if cur.get("status") == 404 or errors >= _STATUS_ERRORS_MAX:
                    stop_reason = "status_lost"
                    break
                time.sleep(min(15.0, poll_s * (2 ** (errors - 1))))
                continue
            errors = 0
            last = cur
            if not cur.get("running"):
                break
            time.sleep(poll_s)
        if stop_reason:
            tgt = _resolve_target_strict(target, username)
            if tgt:
                _agent_req(tgt, "/run_stop", {"run_id": run_id})
            if stop_reason == "timeout":
                last = {"error": "timeout", "message": f"exécution interrompue après {int(deadline - started)} s", "running": False}
            else:
                last = {"error": "status_lost", "running": False,
                        "message": "suivi perdu (" + str(last_err.get("message") or last_err.get("error") or "état inconnu") + ") — exécution arrêtée"}
        rep = last.get("report") or {}
        results.append({"target": target, "run_id": run_id, "ok": (last.get("code") == 0),
                        "code": last.get("code"), "summary": rep.get("summary") or last.get("summary") or last.get("message") or "",
                        "steps_ok": rep.get("ok"), "steps_failed": rep.get("failed"), "healed": len(rep.get("healed") or []),
                        "report_dir": last.get("report_dir", ""), "duration_s": round(time.time() - begin, 1),
                        "error": last.get("error"), "push_errors": p.get("push_errors") or []})
    n_ok = sum(1 for r in results if r.get("ok"))
    doc = ok(name=_agent_slug(name), targets=len(results), ok_count=n_ok, results=results,
             timeout_s=timeout_s, summary=f"{n_ok}/{len(results)} cible(s) réussie(s)")
    if notify_user_id:
        try:
            from shared_infra.notifications.store import create_notification
            body = "\n".join(f"{r['target']} : {'OK' if r.get('ok') else 'ÉCHEC'} — {r.get('summary') or r.get('message') or ''}" for r in results)
            create_notification(int(notify_user_id), "automation", f"Automatisation « {_agent_slug(name)} » : {doc['summary']}", body[:4000], "automation", None)
        except Exception:                     # noqa: BLE001 — la notification est un bonus
            pass
    return doc


def _load_sandbox_automation(username: str, name: str) -> str:
    """``automations/<slug>.py`` de la sandbox de l'utilisateur (sur l'hôte), ou ''."""
    try:
        from shared_infra.accounts.users import get_user
        from shared_infra.routes._helpers import _get_work_path
        row = get_user(username)
        if row is None:
            return ""
        p = (Path(_get_work_path(int(row["id"]))) / "automations" / f"{_slug_auto(name)}.py").resolve()
        if p.is_file():
            return p.read_text(encoding="utf-8")
    except Exception:                         # noqa: BLE001 — pas de sandbox ici : le code doit être fourni
        return ""
    return ""


def _chat_element_cap() -> int:
    """Plafond d'éléments du chemin CHAT (P10, hot-reloadable). L'opt-in
    ``DESKTOP_MAX_ELEMENTS_CHAT`` (>0) prime ; sinon le défaut ``DESKTOP_MAX_ELEMENTS``
    (0 = liste complète, lean v3). Le REJEU n'utilise pas ceci (liste complète)."""
    chat = int(getattr(_cfg, "DESKTOP_MAX_ELEMENTS_CHAT", 0) or 0)
    return chat if chat > 0 else int(getattr(_cfg, "DESKTOP_MAX_ELEMENTS", 0) or 0)


def probe_tree_core(username: str, target: str = "", scope: str = "",
                    max_nodes: int = 0) -> Dict[str, Any]:
    """Sonde a11y ARBRE-SEUL : ``/ui_tree`` → merge + ids stables + enregistrement,
    SANS screenshot (``_grab``), SANS vision, SANS frame disque, SANS memo dHash.

    Les boucles d'attente du rejeu (wait_element/value/state/count, _resolve_anchor)
    n'ont besoin que de l'arbre a11y pour résoudre/vérifier — pas de l'image. Or
    ``observe_core`` faisait UN screenshot (PNG 1-3 Mo b64/LAN) à CHAQUE poll juste
    pour le dHash de gating du memo : pur gaspillage pour une sonde. Ici on lit
    directement l'arbre (la lecture EST la sonde), moins cher que ce screenshot.
    Mêmes éléments/ids que ``observe_core`` → ``resolve_element`` inchangé."""
    tgt = _resolve_target(target, username)
    if not tgt:
        return _no_target_err()
    scope = _norm_scope(scope)
    _mx = int(max_nodes or 0) or _UI_TREE_MAX_NODES     # le Studio en demande plus (cf. observe_core)
    _body: Dict[str, Any] = {"max_nodes": _mx, "scope": scope}
    if _mx > _UI_TREE_MAX_NODES:
        _body["fanout"] = max(80, min(400, _mx // 5))
    tree = _agent_req(tgt, "/ui_tree", _body)
    if isinstance(tree, dict) and tree.get("error"):
        return tree
    a11y = tree.get("elements") if isinstance(tree, dict) else None
    a11y = a11y if isinstance(a11y, list) else []
    w = int((tree or {}).get("width") or 0)
    h = int((tree or {}).get("height") or 0)
    elements = _merge_elements(a11y, [])
    elements = assign_stable_ids(username, tgt["name"], elements)
    register_desktop_observation(username, tgt["name"], elements)
    if w and h:
        set_screen_dims(username, tgt["name"], w, h)
    return ok(target=tgt["name"], img_w=w, img_h=h, count=len(elements),
              elements=elements, tree_used=bool(a11y), frame_token=None,
              tree_nodes=len(a11y), tree_capped=(len(a11y) >= _mx > 0))


def _crop_for_region(png: bytes, box, pad: int = 6):
    """Recadre le PNG sur ``box`` (+marge) pour un OCR ciblé. Le crop est SANS
    risque ici : on ne renvoie aucune coordonnée (que du texte), donc le piège
    de décalage du grounding ne s'applique pas. Retourne les octets PNG du crop
    ou le PNG d'origine si le crop échoue."""
    try:
        from PIL import Image
        import io as _io
        with Image.open(_io.BytesIO(png)) as im:
            W, H = im.width, im.height
            x1 = max(0, int(box[0]) - pad); y1 = max(0, int(box[1]) - pad)
            x2 = min(W, int(box[2]) + pad); y2 = min(H, int(box[3]) + pad)
            if x2 - x1 < 4 or y2 - y1 < 4:
                return png
            out = _io.BytesIO()
            im.crop((x1, y1, x2, y2)).save(out, format="PNG")
            return out.getvalue()
    except Exception:
        return png


def read_text_core(username: str, target: str = "", query: str = "",
                   element_id: str = "", region=None) -> Dict[str, Any]:
    """OCR : lit le texte affiché à l'écran (journal, étiquettes canvas, champs)
    que l'arbre d'accessibilité n'expose pas. Région optionnelle pour cibler :
    ``region`` ([x1,y1,x2,y2]) > ``element_id`` (box de la dernière observation)
    > ``query`` (localisée par le détecteur) > plein écran."""
    if not _cfg.VISION_ENDPOINT_URL:
        return err("no_vision_endpoint",
                   "no annotation/vision endpoint configured",
                   fix="set a multimodal LLM endpoint in Admin → Vision & Desktop")
    tgt = _resolve_target(target, username)
    if not tgt:
        return _no_target_err()
    grabbed = _grab(tgt, fmt="png")     # OCR : petit texte → PNG forcé (fidélité)
    if isinstance(grabbed, dict):
        return grabbed
    png, w, h = grabbed

    # Détermine la zone à lire (sinon plein écran).
    box = None
    region_label = "plein écran"
    if isinstance(region, (list, tuple)) and len(region) >= 4:
        box = [float(region[0]), float(region[1]), float(region[2]), float(region[3])]
        region_label = "zone fournie"
    elif element_id:
        el = resolve_element(username, tgt["name"], element_id=element_id)
        if el and isinstance(el.get("box"), (list, tuple)):
            box = el["box"]; region_label = el.get("label") or element_id
    elif query:
        # Localiser la zone via le détecteur (1ʳᵉ box) avant de lire.
        found = detect(png, endpoint=_cfg.VISION_ENDPOINT_URL, fmt=_cfg.VISION_FORMAT,
                       prompt=query, model=getattr(_cfg, "VISION_MODEL", ""),
                       response_map=_cfg.VISION_RESPONSE_MAP,
                       timeout=_cfg.VISION_TIMEOUT_SEC, native_w=w, native_h=h, passes=1)
        if found and isinstance(found[0].get("box"), (list, tuple)):
            box = found[0]["box"]; region_label = found[0].get("label") or query

    ocr_png = _crop_for_region(png, box) if box else png
    from llm_core import _detection_client as _dc
    txt = _ocr(ocr_png, endpoint=_cfg.VISION_ENDPOINT_URL,
               model=getattr(_cfg, "VISION_MODEL", ""),
               instruction=_dc._prompt_text("VISION_READ"),
               timeout=_cfg.VISION_TIMEOUT_SEC)
    if txt is None:
        return err("read_failed", f"lecture du texte KO : {_dc.last_error() or '?'}",
                   fix="check the vision endpoint (is the multimodal model reachable?)")
    return ok(target=tgt["name"], region=region_label,
              box=[int(b) for b in box] if box else None,
              text=txt, chars=len(txt))


# ── Vision ⊕ a11y merge ───────────────────────────────────────────────────────
def _iou(a: List[float], b: List[float]) -> float:
    ax1, ay1, ax2, ay2 = a[0], a[1], a[2], a[3]
    bx1, by1, bx2, by2 = b[0], b[1], b[2], b[3]
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def _action_hint(role: Any, patterns: Any) -> str:
    """Indice d'action PRIMAIRE compact (1 mot) pour guider un modèle TEXTE vers
    la bonne op sans deviner parmi 12 verbes. Dérivé des control patterns UIA (+
    rôle a11y en repli). Remplace l'exposition brute de ``patterns`` (retirée par
    la compaction côté chat → T1-A). Vide ⇒ un simple ``op="click"`` suffit : le
    moteur re-résout et click_input le contrôle réel (toggle/select naturels).
    Le seul cas où le verbe DIFFÈRE du clic est ``set`` (champ éditable ⇒
    ``op="set_value"`` avec ``text=``)."""
    p = {str(x).strip().lower() for x in (patterns or [])}
    r = str(role or "").strip().lower()
    if "toggle" in p or r in ("checkbox", "togglebutton", "switch"):
        return "toggle"
    if "selectionitem" in p or r in ("listitem", "tabitem", "radiobutton", "menuitemradio"):
        return "select"
    if "expandcollapse" in p and r in ("combobox", "menuitem", "treeitem", "splitbutton", "button"):
        return "expand"
    if "value" in p and r in ("edit", "textbox", "document", "spinner", "spinbutton", "slider", "combobox"):
        return "set"
    return ""


def _merge_elements(a11y: List[Dict[str, Any]], vision: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Merge accessibility-tree nodes (semantics) with vision detections
    (coverage) into one id-stamped element list. a11y wins on overlap; vision
    fills gaps (canvas / no-a11y apps)."""
    merged: List[Dict[str, Any]] = []
    for e in a11y or []:
        rect = e.get("rect") or e.get("box")
        if not isinstance(rect, (list, tuple)) or len(rect) < 4:
            continue
        if e.get("box") and not e.get("rect"):
            box = [float(rect[0]), float(rect[1]), float(rect[2]), float(rect[3])]
        else:  # rect = x,y,w,h
            box = [float(rect[0]), float(rect[1]), float(rect[0]) + float(rect[2]), float(rect[1]) + float(rect[3])]
        if box[2] - box[0] < 2 or box[3] - box[1] < 2:
            continue
        merged.append({
            "box": box,
            "role": str(e.get("role") or ""),
            "name": str(e.get("name") or ""),
            "auto_id": str(e.get("auto_id") or ""),     # identité STABLE (UIA/AT-SPI)
            "runtime_id": str(e.get("runtime_id") or ""),  # identité intra-session (anti-drift)
            "class_name": str(e.get("class_name") or ""),  # désambiguïsation collisions
            "depth": int(e.get("depth") or 0),          # profondeur dans l'arbre UIA
            "value": e.get("value"),
            "states": e.get("states") or [],
            "patterns": e.get("patterns") or [],        # control patterns dispo (toggle/value…)
            "source": "a11y",
            "confidence": 1.0,
        })

    used = set()
    for i, v in enumerate(vision or []):
        vb = v.get("box")
        if not isinstance(vb, (list, tuple)) or len(vb) < 4:
            continue
        best, best_iou = None, 0.0
        for o in merged:
            j = _iou([float(x) for x in vb], o["box"])
            if j > best_iou:
                best, best_iou = o, j
        if best is not None and best_iou >= 0.55:
            best["source"] = "merged"
            if not best.get("name"):
                best["name"] = str(v.get("label") or "")
                best["name_from_vision"] = True     # LECTURE de la vision, pas le nom UIA
            best["confidence"] = max(float(best.get("confidence") or 0), float(v.get("confidence") or 0))
            used.add(i)

    for i, v in enumerate(vision or []):
        if i in used:
            continue
        vb = v.get("box")
        if not isinstance(vb, (list, tuple)) or len(vb) < 4:
            continue
        merged.append({
            "box": [float(x) for x in vb[:4]],
            "role": "",
            "name": str(v.get("label") or ""),
            "auto_id": "",                              # vision pure = pas d'identité a11y
            "runtime_id": "",
            "class_name": "",
            "depth": 0,                                 # hors arbre UIA → racine
            "value": None,
            "states": [],
            "patterns": [],
            "source": "vision",
            "confidence": float(v.get("confidence") or 0),
        })

    out: List[Dict[str, Any]] = []
    for k, e in enumerate(merged, 1):
        b = e["box"]
        label = e.get("name") or e.get("role") or "element"
        rec = {
            "id": f"el_{k}",                            # provisoire : assign_stable_ids le ré-ancre
            "label": label,
            "role": e.get("role", ""),
            "auto_id": e.get("auto_id", ""),            # ancre stable pour le rejeu UIA
            "runtime_id": e.get("runtime_id", ""),      # identité intra-session (anti-drift)
            "class_name": e.get("class_name", ""),      # désambiguïsation des collisions de label
            "depth": int(e.get("depth") or 0),          # profondeur arbre UIA (vue hiérarchique)
            "box": [int(round(b[0])), int(round(b[1])), int(round(b[2])), int(round(b[3]))],
            "center": [int(round((b[0] + b[2]) / 2)), int(round((b[1] + b[3]) / 2))],
            "value": e.get("value"),
            "states": e.get("states") or [],
            "patterns": e.get("patterns") or [],        # control patterns dispo (guide l'action sémantique)
            "do": _action_hint(e.get("role"), e.get("patterns")),  # T1-A : verbe primaire (1 mot) pour le modèle texte
            "source": e.get("source"),
            "confidence": round(float(e.get("confidence") or 0), 3),
        }
        if not e.get("name") or e.get("name_from_vision"):
            # Le libellé est FABRIQUÉ depuis le rôle (« group », « pane ») : il ne
            # nomme rien et ne doit pas servir de cible (name="group" ne retrouve
            # aucun contrôle). Marqué plutôt que vidé : le modèle texte et les
            # anciens lecteurs gardent un libellé, le Studio sait qu'il est creux.
            # Idem d'un libellé LU par la vision sur un contrôle sans nom UIA
            # (« icône enregistrer ») : l'arbre de la VM ne le porte pas, un
            # ``name="icône enregistrer"`` attendait tout le délai avant son repli.
            rec["unnamed"] = True
            if e.get("name_from_vision"):
                rec["label_source"] = "vision"
        out.append(rec)
    return out


# Ops SÉMANTIQUES : l'agent re-cible un contrôle par auto_id/name AU MOMENT d'agir
# et l'actionne via son control pattern UIA (Toggle/SelectionItem/ExpandCollapse/
# Value/ScrollItem/Invoke) → bien plus fiable qu'un clic en coordonnées et capable
# d'agir hors-écran. element_id/query → auto_id (re-résolution live, anti-drift).
_SEMANTIC_OPS = ("invoke", "set_value", "toggle", "check", "uncheck",
                 "select", "expand", "collapse", "scroll_into_view")
_ELEMENT_OPS = ("toggle", "check", "uncheck", "select", "expand", "collapse",
                "scroll_into_view")


# ─────────────────────────────────────────────────────────────────────────────
def act_core(username: str, target: str = "", *, op: str,
             element_id: str = "", query: str = "", auto_id: str = "",
             name: str = "", control_type: str = "",
             x: Optional[int] = None, y: Optional[int] = None,
             x2: Optional[int] = None, y2: Optional[int] = None,
             text: str = "", keys: str = "", button: str = "left",
             clicks: int = 1, dy: int = 0, modifiers: str = "",
             settle_ms: int = 0,
             observe_after: bool = True,
             semantic_click: bool = False,
             expect_sig: str = "",
             return_elements: bool = False) -> Dict[str, Any]:
    """Perform ONE action on ``target`` (or the user's active target if empty).

    Shared by the ``desktop_act`` tool AND ``POST /api/desktop/act`` (Studio
    click-to-act) AND the scenario replay executor, so chat-driven, direct-click
    and replayed actions all take the EXACT same path. Resolution order:
    explicit x,y → element_id/query (from the cached observation) → error."""
    tgt = _resolve_target(target, username)
    if not tgt:
        return _no_target_err()
    op = (op or "").strip().lower()

    # T2-F — requête textuelle ambiguë (chemin chat) : plusieurs éléments au MÊME
    # libellé exact, sans ancre pour trancher → demander un element_id précis
    # plutôt que de viser au hasard. element_id/auto_id/x,y explicites priment ;
    # gardé au chemin chat (semantic_click) → Studio/rejeu intacts.
    if semantic_click and query and not (element_id or auto_id) and x is None and y is None:
        _amb = ambiguous_query_candidates(username, tgt["name"], query)
        if _amb:
            return err("need_disambiguation",
                       f"« {query} » correspond à {len(_amb)} éléments distincts",
                       candidates=[{"id": e.get("id"),
                                    "label": e.get("label") or e.get("name") or "",
                                    "role": e.get("role") or ""} for e in _amb[:8]],
                       fix="pass the exact element_id from a desktop_observe",
                       next_action='desktop_act(op="%s", element_id="el_N")' % (op or "click"))

    point: Optional[Tuple[int, int]] = None
    resolved_el: Optional[Dict[str, Any]] = None   # élément résolu → auto_id/name pour le clic sémantique
    resolved_by = ""     # A2 — COMMENT la cible a été déterminée (feedback modèle)
    if x is not None and y is not None:
        point = (int(x), int(y))
        resolved_by = "coords"
    elif op in _SEMANTIC_OPS:
        # L'AGENT re-résout le contrôle (auto_id/name) au moment d'agir → pas de
        # dépendance au cache d'observation (par-worker). x,y = repli explicite.
        # (Les ops sémantiques enrichissent auto_id/name depuis element_id/query
        # dans leur branche de dispatch — pas d'erreur ``element_not_found`` ici.)
        point = None
    elif element_id or query or auto_id:
        el, resolved_by = _resolve_element_impl(
            username, tgt["name"], element_id=(element_id or None),
            query=(query or None), auto_id=(auto_id or None))
        if not el:
            return err("element_not_found",
                       f"no observed element matches id='{element_id}' query='{query}'",
                       fix="call desktop_observe first, then pass an id from its result",
                       next_action="desktop_observe(target=...)")
        resolved_el = el
        c = el.get("center") or []
        if len(c) >= 2:
            point = (int(c[0]), int(c[1]))

    needs_point = op in ("click", "left_click", "double_click", "right_click",
                         "triple_click", "middle_click", "move", "drag")
    if needs_point and not point:
        return err("need_point", f"'{op}' needs element_id, query, or x,y",
                   fix="pass element_id from desktop_observe, or explicit x,y",
                   next_action="desktop_observe()")

    # Borne les coordonnées contre la dernière capture connue : un point FRANCHEMENT
    # hors-écran (coords brutes périmées après resize/déplacement, ou hallucination)
    # cliquerait dans le vide / sur le mauvais écran → erreur explicite plutôt que
    # silencieuse. Les points issus d'un élément résolu sont déjà dans le cadre.
    if point is not None:
        vp = validate_point(point, get_screen_dims(username, tgt["name"]))
        if vp is None:
            return err("point_out_of_bounds",
                       f"({point[0]},{point[1]}) is outside the captured screen",
                       fix="re-observe (the screen may have moved/resized), then act on an element id")
        point = vp

    # R8 — garde de FRAÎCHEUR (actes directs Studio par coordonnées) : cliquer aux
    # coords AFFICHÉES contre un frame périmé (écran déplacé/redimensionné entre la
    # capture et le clic) vise le mauvais contrôle sans erreur (validate_point ne
    # rejette que le HORS-écran franc). Si l'appelant fournit ``expect_sig`` (la
    # signature du frame qu'il a cliqué) ET qu'on a résolu par coords, on compare
    # une capture fraîche ; au-delà du seuil → stale_frame + frame frais (le Studio
    # rafraîchit, l'utilisateur reclique). Opt-in strict : chat/rejeu ne le passent
    # jamais. Seuil large (horloge/curseur = 1-2 bits) ; 0 = désactivé.
    _stale_ham = int(getattr(_cfg, "DESKTOP_STALE_FRAME_HAM", 10) or 0)
    if expect_sig and resolved_by == "coords" and needs_point and _stale_ham > 0:
        _cur = _grab(tgt)
        if not isinstance(_cur, dict):
            _cur_png, _cw, _ch = _cur
            _cur_sig = _frame_sig(_cur_png)
            if _cur_sig and _ham_hex(_cur_sig, expect_sig) >= _stale_ham:
                return err("stale_frame",
                           "l'écran a changé depuis la capture affichée — la cible a "
                           "peut-être bougé ; le stage a été rafraîchi, vise à nouveau",
                           fix="re-click the element on the refreshed capture",
                           target=tgt["name"], frame_token=_save_frame(_cur_png, owner=username),
                           sig=_cur_sig, img_w=_cw, img_h=_ch)

    # T-FX (faux succès de saisie) : une frappe `type`/`paste` SUBSTANTIELLE (code,
    # multi-ligne, ou longue) DOIT changer l'écran. On capture une signature AVANT
    # pour la comparer APRÈS (chemin chat) ; si rien n'a bougé, les frappes n'ont
    # pas atterri (zone non focalisée / fenêtre en arrière-plan) → on refusera le
    # succès muet plus bas. Borné aux saisies visibles substantielles (un court
    # texte peut ne pas bouger le dHash 8×8 → on ne risque pas de faux négatif).
    _before_sig = ""
    if semantic_click and op in ("type", "paste") and ("\n" in text or len(text) >= 24):
        _gb = _grab(tgt)
        if not isinstance(_gb, dict):
            _before_sig = _frame_sig(_gb[0])

    copied_text = None
    if op == "invoke":
        # Action SÉMANTIQUE : l'agent re-résout le contrôle par auto_id (+ name/
        # control_type) et l'actionne via son pattern Invoke ; x,y = repli coords.
        if not (auto_id or name or point):
            return err("need_target", "invoke needs auto_id/name or x,y",
                       fix="pass auto_id from desktop_observe, or explicit x,y",
                       next_action="desktop_observe()")
        body = {"auto_id": auto_id, "name": name, "control_type": control_type,
                "button": button, "clicks": int(clicks or 1)}
        if point is not None:
            body["x"], body["y"] = point[0], point[1]
        r = _agent_req(tgt, "/invoke", body)
    elif op == "set_value":
        if not text:
            return err("need_text", "set_value needs `text`", fix='pass text="..."')
        aid, nm, ct = auto_id, name, control_type
        sv_point = point
        if not (aid or nm) and (element_id or query):
            el, resolved_by = _resolve_element_impl(
                username, tgt["name"], element_id=(element_id or None),
                query=(query or None))
            if el:
                aid = str(el.get("auto_id") or "")
                # Libellé FABRIQUÉ (rôle recopié, ``unnamed``) ou LU par la vision : ce
                # n'est pas un nom UIA — l'envoyer faisait échouer la re-résolution
                # (« contrôle introuvable ») ; le point, lui, départage.
                if not (el.get("unnamed") or el.get("label_source") == "vision"):
                    nm = str(el.get("label") or el.get("name") or "")
                ct = str(el.get("role") or "")
                c = el.get("center") or []
                if sv_point is None and len(c) >= 2:
                    sv_point = (int(c[0]), int(c[1]))
        if not (aid or nm or sv_point):
            return err("need_target", "set_value needs auto_id/name or element_id/query",
                       fix="pass auto_id or an element_id from desktop_observe",
                       next_action="desktop_observe()")
        sv_body: Dict[str, Any] = {"auto_id": aid, "name": nm, "control_type": ct, "text": text}
        if sv_point is not None:
            sv_body["x"], sv_body["y"] = int(sv_point[0]), int(sv_point[1])
        r = _agent_req(tgt, "/set_value", sv_body)
    elif op in ("click", "left_click", "double_click", "right_click",
                "triple_click", "middle_click"):
        # T1-C — auto-routage SÉMANTIQUE du clic simple gauche (chemin chat) : au
        # lieu d'un clic sur des coordonnées potentiellement périmées, l'agent
        # re-résout le contrôle par auto_id/name AU MOMENT d'agir puis le
        # click_input (survit aux petits décalages d'UI, agit hors-écran ; un vrai
        # clic toggle/sélectionne/invoke naturellement). Repli coords (x,y) inclus.
        # Hors clic-simple-gauche, sans élément résolu, ou hors chemin chat
        # (Studio/rejeu : semantic_click=False) → /click littéral, inchangé.
        _aid = str((resolved_el or {}).get("auto_id") or "")
        _nm = str((resolved_el or {}).get("label") or (resolved_el or {}).get("name") or "")
        _simple_left = op in ("click", "left_click") and button == "left" and int(clicks or 1) == 1
        if semantic_click and _simple_left and (_aid or _nm):
            body = {"action": "click", "auto_id": _aid, "name": _nm,
                    "control_type": str((resolved_el or {}).get("role") or ""),
                    "button": "left", "clicks": 1}
            if point is not None:
                body["x"], body["y"] = point[0], point[1]
            r = _agent_req(tgt, "/element", body)
        else:
            btn = ("right" if op == "right_click"
                   else "middle" if op == "middle_click" else button)
            clk = (3 if op == "triple_click"
                   else 2 if op == "double_click" else int(clicks or 1))
            r = _agent_req(tgt, "/click", {"x": point[0], "y": point[1], "button": btn,
                                           "clicks": clk, "modifiers": modifiers})
    elif op == "type":
        if not text:
            return err("need_text", "type needs `text`", fix="pass text=\"...\"")
        r = _agent_req(tgt, "/type", {"text": text})
    elif op in ("key", "hotkey", "press"):
        combo = keys or text
        if not combo:
            return err("need_keys", "key needs `keys`", fix='pass keys="ctrl+s" or keys="enter"')
        r = _agent_req(tgt, "/key", {"keys": combo})
    elif op == "paste":
        if text:
            r = _agent_req(tgt, "/clipboard_set", {"text": text})
            if isinstance(r, dict) and r.get("error"):
                return r
        r = _agent_req(tgt, "/key", {"keys": "ctrl+v"})
    elif op == "copy":
        r = _agent_req(tgt, "/key", {"keys": "ctrl+c"})
        if not (isinstance(r, dict) and r.get("error")):
            cb = _agent_req(tgt, "/clipboard_get", {})
            if isinstance(cb, dict) and not cb.get("error"):
                copied_text = cb.get("text", "")
    elif op == "scroll":
        px, py = (point if point else (None, None))
        r = _agent_req(tgt, "/scroll", {"x": px, "y": py, "dy": int(dy or 0)})
    elif op == "move":
        r = _agent_req(tgt, "/move", {"x": point[0], "y": point[1]})
    elif op == "drag":
        if x2 is None or y2 is None:
            return err("need_drag_end", "drag needs x2,y2 (end point)",
                       fix="pass x2,y2; start comes from element_id/query/x,y")
        r = _agent_req(tgt, "/drag", {"x1": point[0], "y1": point[1], "x2": int(x2),
                                      "y2": int(y2), "modifiers": modifiers})
    elif op in _ELEMENT_OPS:
        # Action SÉMANTIQUE par pattern (toggle/select/expand/collapse/
        # scroll_into_view). On enrichit auto_id/name/control_type depuis
        # element_id/query (re-résolution → l'agent re-cible en live), + un point
        # de repli. L'agent choisit le BON pattern UIA, repli clic-coords sinon.
        aid, nm, ct, pt = auto_id, name, control_type, point
        if element_id or query or auto_id:
            el, resolved_by = _resolve_element_impl(
                username, tgt["name"], element_id=(element_id or None),
                query=(query or None), auto_id=(auto_id or None))
            if el:
                aid = aid or str(el.get("auto_id") or "")
                nm = nm or str(el.get("label") or el.get("name") or "")
                ct = ct or str(el.get("role") or "")
                if pt is None:
                    c = el.get("center") or []
                    if len(c) >= 2:
                        pt = (int(c[0]), int(c[1]))
        if not (aid or nm or pt):
            return err("need_target", f"'{op}' needs element_id/query/auto_id or x,y",
                       fix="pass an id from desktop_observe, or explicit x,y",
                       next_action="desktop_observe()")
        body = {"action": op, "auto_id": aid, "name": nm, "control_type": ct,
                "text": text, "button": button, "clicks": int(clicks or 1)}
        if pt is not None:
            body["x"], body["y"] = pt[0], pt[1]
        r = _agent_req(tgt, "/element", body)
    else:
        return err("bad_op", f"unknown op '{op}'",
                   valid_choices=["click", "double_click", "triple_click", "right_click",
                                  "middle_click", "invoke", "set_value", "toggle", "check",
                                  "uncheck", "select", "expand", "collapse", "scroll_into_view",
                                  "type", "key", "paste", "copy", "scroll", "move", "drag"])

    if isinstance(r, dict) and r.get("error"):
        # A3 — un échec d'op SÉMANTIQUE (pattern UIA indisponible sur ce contrôle,
        # ou cible non re-résolue côté agent) n'apprend rien au modèle tel quel.
        # On greffe un repli ACTIONNABLE (sauf si l'agent a déjà fourni un fix).
        if op in _SEMANTIC_OPS and not r.get("fix"):
            r = {**r,
                 "fix": ("ce contrôle n'expose peut-être pas ce pattern — réessaie "
                         "en clic simple op=\"click\" sur son element_id, ou "
                         "desktop_observe puis cible par auto_id"),
                 "next_action": "desktop_observe()"}
        return r

    _invalidate_a11y_memo(tgt["name"])   # l'action a pu muter l'arbre → memo périmé

    result: Dict[str, Any] = {"op": op, "target": tgt["name"]}
    if point:
        result["point"] = [point[0], point[1]]
    # Position ACTUELLE du curseur : l'agent la joint à CHAQUE action (y compris
    # type/key qui ne bougent pas la souris) → le modèle sait toujours où est le
    # pointeur, dans le MÊME repère que les ``center`` d'éléments. (Demande user.)
    if isinstance(r, dict) and r.get("cursor") is not None:
        result["mouse"] = r["cursor"]
    if copied_text is not None:
        result["text"] = copied_text
    if isinstance(r, dict) and r.get("method"):
        result["method"] = r["method"]   # invoke|click_input|coords|type… (exécution AGENT)
        # T3-H — une op SÉMANTIQUE (ou un clic auto-routé) retombée en clic-
        # coordonnées = pas de control pattern a11y sur cette cible/élément
        # (typiquement Linux/AT-SPI, ou élément issu de la vision). On le SIGNALE
        # (un clic-coords est plus fragile : ne survit pas à un déplacement d'UI)
        # au lieu de le masquer derrière un succès muet.
        if r["method"] == "coords" and (op in _SEMANTIC_OPS
                                        or (semantic_click and op in ("click", "left_click"))):
            result["note"] = ("actionné en clic-coordonnées (pas de control pattern "
                              "a11y sur cette cible — p.ex. Linux/AT-SPI ou élément vision)")
    if resolved_by:
        # A2 — COMMENT le client a ciblé l'élément (cache_pin|exact_label|substring|
        # auto_id|runtime_id|element_id|coords). Complémentaire de ``method`` : dit
        # au modèle si son clic a visé une ancre stable ou un substring fragile.
        result["resolved_by"] = resolved_by

    # Settle intelligent (chemin chatbot live) : laisse l'UI se STABILISER après
    # une action mutante avant de capturer → le modèle voit l'écran APRÈS effet
    # (dialogue ouvert, page chargée), pas un instantané pré-transition. Borné
    # (fast-fail) + court-circuité dès que l'écran est figé (dHash). settle_ms=0
    # (défaut — ex. le rejeu, qui fait son propre check_expect) → désactivé.
    if settle_ms and settle_ms > 0 and op != "copy":
        try:
            from llm_core._desktop_replay import wait_stable as _wait_stable
            # P5 — settle ADAPTATIF (chemin chat) : quiet/poll courts (config) → sur
            # un écran déjà stable (cas majoritaire post-frappe), on rend la main
            # bien avant le plafond ``settle_ms`` ; ce dernier reste la borne haute
            # pour un écran qui bouge (animation/chargement).
            result["settle_ms"] = _wait_stable(
                username, tgt["name"], timeout_ms=int(settle_ms),
                quiet_ms=int(getattr(_cfg, "DESKTOP_ACT_SETTLE_QUIET_MS", 350)),
                poll_ms=int(getattr(_cfg, "DESKTOP_ACT_SETTLE_POLL_MS", 200)))
        except Exception:
            pass

    # Post-action : montrer l'écran APRÈS effet.
    #  • Chemin CHAT (return_elements) → on renvoie une OBSERVATION COMPACTE
    #    (éléments frais, ids ré-ancrés, arbre a11y SANS vision = rapide) pour que
    #    le modèle ENCHAÎNE directement sans un desktop_observe séparé (T1-B :
    #    supprime le round-trip observe→act→observe, boucle ÷2 pour un modèle texte).
    #  • Chemin STUDIO/REJEU (return_elements=False) → frame seule, INCHANGÉ.
    if return_elements and op != "copy":
        obs = observe_core(username, tgt["name"], use_vision=False, use_tree=True,
                           max_elements=_chat_element_cap())
        if isinstance(obs, dict) and not obs.get("error"):
            for _k in ("elements", "count", "total", "truncated",
                       "frame_token", "img_w", "img_h", "sig"):
                if _k in obs:
                    result[_k] = obs[_k]
    elif observe_after:
        # Fresh post-action frame for the Studio (screenshot only — fast).
        grabbed = _grab(tgt)
        if not isinstance(grabbed, dict):
            png, w, h = grabbed
            result["frame_token"] = _save_frame(png, owner=username)
            result["img_w"], result["img_h"] = w, h
            result["sig"] = _frame_sig(png)

    # T-FX — faux succès de saisie : la frappe a été émise mais l'écran est
    # RIGOUREUSEMENT identique à l'avant-frappe → elle n'a pas atterri (mauvais
    # focus / fenêtre en arrière-plan). On NE renvoie PAS un succès muet : le
    # modèle doit cliquer dans le champ (ou viser set_value) puis réessayer.
    if _before_sig and result.get("sig") and _ham_hex(_before_sig, result["sig"]) == 0:
        return err("type_no_effect",
                   "le texte a été émis mais l'écran n'a pas changé — la frappe n'a "
                   "probablement pas atterri (zone de saisie non focalisée ou fenêtre "
                   "en arrière-plan)",
                   fix=("clique d'abord dans la zone de saisie (desktop_act op=\"click\" "
                        "sur son element_id), ou cible le champ par op=\"set_value\", "
                        "puis réessaie"),
                   next_action="desktop_observe()", target=tgt["name"],
                   frame_token=result.get("frame_token"), sig=result.get("sig"),
                   img_w=result.get("img_w"), img_h=result.get("img_h"))
    return ok(**result)


# ── Résolution de nom d'application (chemin amical → cible lançable) ─────────
# Sans ça, « lance la calculatrice » envoyait « calculatrice » brut à
# ShellExecute → SE_ERR_FILE_NOT_FOUND → 501 « non supporté » (alors que l'appli
# existe, c'est juste le NOM qui n'est pas résolu). On mappe les noms courants
# (FR + EN, accents pliés) vers leur exécutable/URI canonique côté Windows.
# Calculatrice → calc.exe : calc.exe est sur le chemin de recherche ShellExecute
# de tout Win10/11 ET c'est lui qui active le handler enregistré (UWP) → la cible
# la plus fiable, sans coder en dur un AUMID spécifique à l'édition.
_ALIAS_MAP_WIN: Dict[str, str] = {
    "calc": "calc.exe", "calculator": "calc.exe", "calculatrice": "calc.exe",
    "notepad": "notepad.exe", "bloc-notes": "notepad.exe", "bloc notes": "notepad.exe",
    "blocnotes": "notepad.exe",
    "paint": "mspaint.exe", "dessin": "mspaint.exe",
    "wordpad": "write.exe", "write": "write.exe",
    "explorer": "explorer.exe", "explorateur": "explorer.exe",
    "explorateur de fichiers": "explorer.exe", "files": "explorer.exe",
    "cmd": "cmd.exe", "invite de commandes": "cmd.exe", "command prompt": "cmd.exe",
    "powershell": "powershell.exe", "terminal": "wt.exe",
    "settings": "ms-settings:", "parametres": "ms-settings:", "reglages": "ms-settings:",
    "control panel": "control.exe", "panneau de configuration": "control.exe",
    "task manager": "taskmgr.exe", "gestionnaire des taches": "taskmgr.exe",
    "regedit": "regedit.exe", "registry editor": "regedit.exe",
    "editeur du registre": "regedit.exe",
    "character map": "charmap.exe", "table des caracteres": "charmap.exe",
    "snipping tool": "snippingtool.exe", "outil capture": "snippingtool.exe",
    "store": "ms-windows-store:", "microsoft store": "ms-windows-store:",
    "edge": "msedge.exe", "navigateur": "msedge.exe",
    "device manager": "devmgmt.msc", "gestionnaire de peripheriques": "devmgmt.msc",
    "services": "services.msc",
    "disk management": "diskmgmt.msc", "gestion des disques": "diskmgmt.msc",
    "photos": "ms-photos:",
}
_WIN_LAUNCHABLE_EXT = (".exe", ".lnk", ".bat", ".cmd", ".msc", ".cpl", ".com")


def _norm_app_name(app: str) -> str:
    """Normalise un nom d'appli pour le lookup : minuscule, accents pliés
    (NFKD + dépouillé des diacritiques), espaces internes compactés."""
    import unicodedata
    s = unicodedata.normalize("NFKD", str(app or "").strip().casefold())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return " ".join(s.split())


def _resolve_app_target(app: str, os_name: str) -> Tuple[str, str]:
    """Résout un nom d'appli amical vers une cible lançable. Renvoie
    ``(cible, note)`` (note vide si inchangé). PURE/total : ne lève jamais.

    Windows : alias FR/EN connu → exécutable/URI canonique ; sinon si la chaîne
    ressemble déjà à un chemin/URI/exe (séparateur, extension connue, ou schéma
    ``xxx:``) → inchangée ; sinon on ajoute ``.exe`` (laisse App Paths/System32
    résoudre notepad.exe, regedit.exe…). Linux/autre : inchangé (Popen direct)."""
    raw = str(app or "").strip()
    if (os_name or "").strip().lower() != "windows":
        return raw, ""
    key = _norm_app_name(raw)
    if key in _ALIAS_MAP_WIN:
        canon = _ALIAS_MAP_WIN[key]
        return canon, ("" if canon == raw else f"« {raw} » → {canon}")
    low = raw.lower()
    looks_resolvable = (
        "\\" in raw or "/" in raw or ":" in raw       # chemin ou URI/protocole
        or low.endswith(_WIN_LAUNCHABLE_EXT)
    )
    if looks_resolvable or not raw:
        return raw, ""
    return raw + ".exe", f"« {raw} » → {raw}.exe"


def launch_core(username: str, target: str = "", *, app: str = "", args: str = "",
                timeout_ms: int = 15000) -> Dict[str, Any]:
    """Lance un programme/raccourci sur la cible et ATTEND son initialisation
    (WaitForInputIdle + nouvelle fenêtre prête, côté agent) — synchro FIABLE des
    temps de chargement. Renvoie la fenêtre apparue + un frame frais."""
    tgt = _resolve_target(target, username)
    if not tgt:
        return _no_target_err()
    if not app:
        return err("need_app", "launch needs `app` (chemin/raccourci/uri)")
    # Résout un nom amical (« calculatrice » → calc.exe) AVANT l'appel agent. Le
    # résolveur est pur/total mais on garde un filet : toute anomalie → on passe
    # l'app telle quelle plutôt que d'échouer.
    try:
        resolved, _note = _resolve_app_target(app, str(tgt.get("os", "")))
    except Exception:
        resolved, _note = app, ""
    to = max(1000, int(timeout_ms or 15000))
    # Le HTTP doit survivre à l'attente côté agent → timeout = attente + marge.
    r = _agent_req(tgt, "/launch", {"target": resolved, "args": args, "timeout_ms": to},
                   # L'agent attend la nouvelle fenêtre (≤ to) PUIS WaitForInputIdle (≤ to),
                   # budget ``2*to + 10`` : à ``to + 5`` on rendait agent_timeout pendant
                   # que le lancement continuait, et le réessai ouvrait une 2e instance.
                   timeout=max(20, 2 * to // 1000 + 15))
    if isinstance(r, dict) and r.get("error"):
        return r
    out: Dict[str, Any] = {"target": tgt["name"], "requested_app": app}
    if resolved != app:
        out["resolved"] = resolved
    for k in ("launched", "found", "title", "class_name", "auto_id", "interaction_state"):
        if isinstance(r, dict) and k in r:
            out[k] = r[k]
    if isinstance(r, dict) and r.get("error_detail"):
        out["error_detail"] = r["error_detail"]
    # Lancé mais aucune fenêtre neuve détectée (appli déjà ouverte, ou activation
    # lente côté UWP) → résultat SUCCÈS mais explicite + piste de synchro, plutôt
    # qu'un statut ambigu. Le modèle enchaîne sur desktop_wait/observe.
    if out.get("found") is False:
        out["hint"] = ("lancé mais aucune nouvelle fenêtre détectée dans %d ms — "
                       "l'appli est peut-être déjà ouverte ou son activation est "
                       "lente ; confirme avec desktop_wait(kind=\"window_ready\", "
                       "title_re=…) ou desktop_observe." % to)
    grabbed = _grab(tgt)              # frame frais pour le stage du Studio
    if not isinstance(grabbed, dict):
        png, w, h = grabbed
        out["frame_token"] = _save_frame(png, owner=username)
        out["img_w"], out["img_h"] = w, h
        out["sig"] = _frame_sig(png)
    return ok(**out)


def run_command_core(username: str, target: str = "", *, command: str = "",
                     shell: str = "powershell", cwd: str = "",
                     timeout_sec: int = 120, max_output: int = 20000) -> Dict[str, Any]:
    """Exécute une commande sur la cible (PowerShell par défaut sous Windows, bash
    sous Linux) via l'agent — façon execute_shell mais SUR LA VM. Renvoie le MÊME
    contrat que execute_shell : {ok, cmd, cwd, returncode, stdout, stderr,
    truncated, duration_ms, executor}. ``ok = (returncode == 0)`` — un code non nul
    n'est PAS une erreur d'enveloppe (le modèle raisonne sur stdout/stderr).

    ⚠ Aucune isolation conteneur ici (contrairement au sandbox Docker d'execute_shell)
    → privilège complet sur la VM. Métadonnées d'abord, stdout/stderr en DERNIER pour
    survivre au cap d'émission de la boucle."""
    tgt = _resolve_target(target, username)
    if not tgt:
        return _no_target_err()
    cmd = str(command or "")
    if not cmd.strip():
        return err("need_command", "run_command needs a non-empty `command`")
    to = max(1, min(600, int(timeout_sec or 120)))
    mx = max(0, int(max_output or 0))
    # Le HTTP doit survivre à l'exécution côté agent → timeout client = durée + marge.
    r = _agent_req(tgt, "/run_command",
                   {"command": cmd, "shell": shell, "cwd": cwd,
                    "timeout_ms": to * 1000, "max_output": mx},
                   timeout=to + 30)
    if isinstance(r, dict) and r.get("error"):
        return r
    r = r if isinstance(r, dict) else {}
    rc = int(r.get("returncode", -1))
    sh = str(r.get("shell") or shell)
    out: Dict[str, Any] = {
        "ok": rc == 0,
        "cmd": cmd,
        "cwd": cwd,
        "returncode": rc,
        "truncated": bool(r.get("truncated")),
        "duration_ms": int(r.get("duration_ms", 0)),
        "executor": "desktop.%s.%s" % (tgt["name"], sh),
    }
    if r.get("timed_out"):
        out["ok"] = False
        out["error"] = "timeout"
        out["hint"] = ("exceeded timeout_sec=%ds on %s; narrow the command or raise "
                       "timeout_sec" % (to, tgt["name"]))
    # stdout/stderr EN DERNIER (cf. contrat execute_shell : le cap coupe la queue JSON).
    out["stdout"] = str(r.get("stdout", ""))
    out["stderr"] = str(r.get("stderr", ""))
    return out


def wait_window_core(username: str, target: str = "", *, title_re: str = "",
                     auto_id: str = "", class_name: str = "", ready: bool = True,
                     timeout_ms: int = 15000) -> Dict[str, Any]:
    """Attend (côté agent, via UIA) qu'une fenêtre matche ET soit PRÊTE à
    l'interaction (ReadyForUserInteraction). Renvoie ``{found, interaction_state,
    title, auto_id}`` — synchro fiable « la fenêtre est apparue et utilisable »."""
    tgt = _resolve_target(target, username)
    if not tgt:
        return _no_target_err()
    if not (title_re or auto_id or class_name):
        return err("need_matcher", "wait_window needs title_re/auto_id/class_name")
    to = max(1000, int(timeout_ms or 15000))
    r = _agent_req(tgt, "/wait_window",
                   {"title_re": title_re, "auto_id": auto_id, "class_name": class_name,
                    "ready": bool(ready), "timeout_ms": to},
                   timeout=max(20, to // 1000 + 5))
    if isinstance(r, dict) and r.get("error"):
        return r
    return ok(target=tgt["name"], found=bool(r.get("found")),
              interaction_state=r.get("interaction_state") or "",
              title=r.get("title") or "", auto_id=r.get("auto_id") or "")


def wait_core(username: str, target: str = "", *, kind: str = "stable",
              query: str = "", text: str = "", value: str = "", state: str = "",
              role: str = "", auto_id: str = "", title_re: str = "",
              op: str = "==", count: int = 0, match: bool = False,
              timeout_ms: int = 8000) -> Dict[str, Any]:
    """Attend qu'une CONDITION d'UI soit vraie avant de continuer — la synchro
    fiable des automatisations longues (mêmes attentes étagées que le rejeu de
    scénarios : dHash → a11y → OCR → UIA). ``kind`` ∈ element|element_gone|text|
    text_gone|value|value_gone|state|count|stable|window_ready. Renvoie
    ``{satisfied, waited_ms, detail}`` + un frame frais."""
    tgt = _resolve_target(target, username)
    if not tgt:
        return _no_target_err()
    kind = (kind or "stable").strip().lower()
    expect: Dict[str, Any] = {"kind": kind, "match": bool(match)}
    if kind in ("element", "element_gone"):
        expect["query"] = query
    elif kind in ("text", "text_gone"):
        expect["query"] = text or query
    elif kind in ("value", "value_gone"):
        expect["query"] = query
        expect["expected"] = value
    elif kind == "state":
        expect["query"] = query
        expect["state"] = state
    elif kind == "count":
        expect["query"] = query
        expect["role"] = role
        expect["op"] = op
        expect["count"] = count
    elif kind == "window_ready":
        expect["query"] = title_re or query
        expect["anchor"] = {"auto_id": auto_id}
    # 'stable' (et inconnu) : aucun champ requis.
    try:
        from llm_core._desktop_replay import check_expect   # lazy → évite le cycle
        ok2, waited, detail = check_expect(username, tgt["name"], expect, int(timeout_ms or 8000))
    except Exception as e:
        return err("wait_failed", f"wait '{kind}' failed: {e}")
    out: Dict[str, Any] = {"target": tgt["name"], "kind": kind,
                           "satisfied": bool(ok2), "waited_ms": int(waited),
                           "detail": detail}
    grabbed = _grab(tgt)
    if not isinstance(grabbed, dict):
        png, w, h = grabbed
        out["frame_token"] = _save_frame(png, owner=username)
        out["img_w"], out["img_h"] = w, h
        out["sig"] = _frame_sig(png)
    return ok(**out)


def list_monitors_core(username: str, target: str = "") -> Dict[str, Any]:
    """Liste les écrans de la cible (mss) + l'écran capturé courant (sélecteur Studio)."""
    tgt = _resolve_target(target, username)
    if not tgt:
        return _no_target_err()
    r = _agent_req(tgt, "/monitors", method="GET", timeout=8)
    if isinstance(r, dict) and r.get("error"):
        return r
    return ok(target=tgt["name"], monitors=r.get("monitors") or [], selected=r.get("selected", 1))


def select_monitor_core(username: str, target: str = "", monitor: int = 1) -> Dict[str, Any]:
    """Choisit l'écran capturé/piloté sur la cible (persistant côté agent)."""
    tgt = _resolve_target(target, username)
    if not tgt:
        return _no_target_err()
    try:
        idx = int(monitor)
    except (TypeError, ValueError):
        idx = 1
    r = _agent_req(tgt, "/select_monitor", {"monitor": idx})
    if isinstance(r, dict) and r.get("error"):
        return r
    return ok(target=tgt["name"], selected=r.get("selected", idx))


def list_windows_core(username: str, target: str = "") -> Dict[str, Any]:
    """Fenêtres top-level de la cible (titre + état + premier plan) — surface LÉGÈRE
    pour atteindre/basculer une autre appli sans payer son sous-arbre."""
    tgt = _resolve_target(target, username)
    if not tgt:
        return _no_target_err()
    r = _agent_req(tgt, "/windows", method="GET")
    if isinstance(r, dict) and r.get("error"):
        return r
    out = []
    for w in (r.get("windows") if isinstance(r, dict) else None) or []:
        if not isinstance(w, dict):
            continue
        out.append({"id": str(w.get("hwnd")), "title": w.get("title") or "",
                    "state": w.get("state") or "normal",
                    "is_foreground": bool(w.get("is_foreground"))})
    return ok(target=tgt["name"], windows=out, count=len(out))


def window_action_core(username: str, target: str = "", action: str = "activate",
                       window_id: str = "") -> Dict[str, Any]:
    """Agit sur une fenêtre par id (= hwnd) : activate|focus|minimize|maximize|
    restore|close. Invalide le memo a11y (l'agencement a changé)."""
    tgt = _resolve_target(target, username)
    if not tgt:
        return _no_target_err()
    try:
        hwnd = int(str(window_id).strip() or 0)
    except (TypeError, ValueError):
        hwnd = 0
    if not hwnd:
        return err("bad_window", "window_id (hwnd) requis — lister via desktop_windows")
    r = _agent_req(tgt, "/window_action", {"action": str(action or "activate"), "hwnd": hwnd})
    if isinstance(r, dict) and r.get("error"):
        return r
    _invalidate_a11y_memo(tgt["name"])
    extra = {k: r[k] for k in ("method", "foregrounded", "note")
             if isinstance(r, dict) and r.get(k) is not None}
    return ok(target=tgt["name"], action=str(action or "activate"), window_id=str(hwnd), **extra)


def register(mcp: FastMCP) -> None:
    """Register the desktop control tools. Called by local_mcp_server."""

    # NOTE — pas de paramètre ``target`` sur les outils : la machine cible est
    # DÉTERMINISTE, choisie par l'utilisateur dans l'UI (cible active persistée
    # via /api/desktop/active-target). _resolve_target("", username) la résout
    # tout seul. L'exposer ferait perdre des tours au modèle à « trouver la
    # session ». Le Studio (UI), lui, passe une cible explicite aux *_core.

    @mcp.tool(**_TOOL_KW_OW_RO, name="desktop_session")
    def session(ctx: Context, action: str = "ping") -> Dict[str, Any]:
        """Check the desktop control target (the one the user selected in the UI).

        You never choose the machine — it's fixed by the user. Use this only to
        confirm the agent is reachable before acting, or to list what's wired.

        action  "ping" (default) → health of the active target; "list" → all configured targets (info only).
        """
        action = (action or "ping").strip().lower()
        try:
            _cfg.reload_desktop_config_from_disk()
        except Exception:
            pass
        if action == "list":
            from shared_infra.desktop.access import allowed_targets
            targets = allowed_targets(_cfg.get_desktop_targets(reload=False), get_username(ctx))
            listed = [{"name": t["name"], "os": t.get("os", "linux"),
                       "default": bool(t.get("default"))} for t in targets]
            return ok(targets=listed, count=len(listed)) if listed else _no_target_err()
        tgt = _resolve_target("", get_username(ctx))
        if not tgt:
            return _no_target_err()
        health = _agent_req(tgt, "/health", method="GET", timeout=8)
        if isinstance(health, dict) and health.get("error"):
            return err("agent_down", f"'{tgt['name']}' did not answer",
                       target=tgt["name"], detail=health.get("message"))
        return ok(target=tgt["name"], healthy=True, agent=health)

    # B3 — défini mais enregistré CONDITIONNELLEMENT (voir fin de register) :
    # redondant avec desktop_observe pour le modèle, masqué par défaut.
    def screenshot(ctx: Context) -> Dict[str, Any]:
        """Capture the current screen of the active target (no analysis).

        Use for a quick look. To get clickable element ids, use desktop_observe
        instead. The image streams to the Annotation Studio; you get a token,
        not the raw bytes.
        """
        # AUDIT 2026-08-23 — ``username`` n'existait dans AUCUNE portée :
        # ni paramètre (la closure ne reçoit que ``ctx``), ni local, ni global
        # du module. Python le résolvait en global à l'exécution et levait
        # ``NameError`` — APRÈS ``_grab()``, donc la capture était réellement
        # prise sur la VM puis perdue. L'outil était inutilisable à 100 % dès
        # qu'un exploitant posait ``APP_DESKTOP_EXPOSE_RAW_TOOLS=1``. Toutes
        # les autres fonctions du fichier reçoivent ``username`` en paramètre ;
        # seule cette closure avait été recopiée sans adapter la source du nom.
        _username = get_username(ctx)
        tgt = _resolve_target("", _username)
        if not tgt:
            return _no_target_err()
        grabbed = _grab(tgt)
        if isinstance(grabbed, dict):
            return grabbed
        png, w, h = grabbed
        token = _save_frame(png, owner=_username)
        return ok(target=tgt["name"], img_w=w, img_h=h, frame_token=token, sig=_frame_sig(png))

    @mcp.tool(**_TOOL_KW_OW_RO, name="desktop_observe")
    def observe(ctx: Context, prompt: str = "",
                use_vision: bool = True, use_tree: bool = True,
                max_elements: int = -1,     # -1 = défaut config (P10, hot-reloadable)
                scope: str = "") -> Dict[str, Any]:
        """Capture the screen and return ANNOTATED UI elements to act on.

        The most useful tool: screenshots the active target, reads the
        accessibility tree (and/or the detection model), and returns elements as
        {id, label, role, center, auto_id, value, states, do}. Pass an element's
        `id` to desktop_act. `do` hints the primary action: do="set" ⇒
        op="set_value"; otherwise op="click" does the right thing. If `truncated`
        is true, only the most actionable elements are shown — narrow with
        `prompt` or scroll.

        Loop: desktop_launch → desktop_observe → desktop_act (which RETURNS the
        updated elements, so you rarely re-observe between actions) → use
        desktop_wait to block on an expected effect (window/element/text/value).

        Example: desktop_observe(prompt="the blue Login button")

        prompt        optional grounding hint for the detection model — describe
                      the element(s) to find. Write it in ENGLISH: the grounding
                      model locates most accurately from English descriptions, even
                      when the UI itself is in another language.
        use_vision    run the detection endpoint (default true).
        use_tree      read the accessibility tree (default true).
        max_elements  -1 (default) = server config (usually the full list); an
                      explicit 0 = full list; >0 caps it (most actionable kept).
        scope         "focus" (default) = the FOREGROUND window only; "monitor" =
                      all windows on the captured screen; "desktop" = all screens.
                      Widen ONLY to read another window's content (heavier/noisier);
                      to merely switch apps use desktop_windows + desktop_focus.
        """
        # -1 (défaut) → plafond config du chemin chat (P10) ; une valeur explicite
        # du modèle prime toujours.
        _me = _chat_element_cap() if max_elements < 0 else max_elements
        return observe_core(get_username(ctx), "", prompt,
                            use_vision=use_vision, use_tree=use_tree,
                            max_elements=_me, scope=scope)

    # B3 — défini mais enregistré CONDITIONNELLEMENT (voir fin de register) :
    # redondant avec desktop_observe(use_vision=False), masqué par défaut.
    def inspect(ctx: Context, max_nodes: int = 300) -> Dict[str, Any]:
        """Return the raw accessibility tree of the active target (no detection).

        Use when you need roles/names/values directly from the OS (pywinauto /
        AT-SPI). For clickable element ids overlaid on the screen, prefer
        desktop_observe.

        max_nodes  cap (default 300).
        """
        tgt = _resolve_target("", get_username(ctx))
        if not tgt:
            return _no_target_err()
        tree = _agent_req(tgt, "/ui_tree", {"max_nodes": int(max_nodes or 300)})
        if isinstance(tree, dict) and tree.get("error"):
            return tree
        els = tree.get("elements") if isinstance(tree, dict) else None
        return ok(target=tgt["name"], count=len(els or []), elements=(els or []),
                  width=tree.get("width"), height=tree.get("height"))

    @mcp.tool(**_TOOL_KW_OW_RO, name="desktop_read")
    def read(ctx: Context, query: str = "",
             element_id: str = "", region: Optional[List[int]] = None) -> Dict[str, Any]:
        """Read (OCR) the TEXT shown on the active target's screen — what the
        accessibility tree does NOT expose: a log panel, labels drawn on a
        canvas/map, a field's content. Uses the vision model.
        Returns {text, region, box}.

        Scope the read (most precise first):
          region      [x1,y1,x2,y2] pixel box to read.
          element_id  read inside an element from a prior desktop_observe.
          query       locate the area first, then read it. Write it in ENGLISH
                      (most accurate for the grounding model), e.g. "the log panel".
          (none)      read the whole screen.

        Examples:
          desktop_read(query="the events log")
          desktop_read(element_id="el_7")
        """
        return read_text_core(get_username(ctx), "", query=query,
                              element_id=element_id, region=region)

    @mcp.tool(**_TOOL_KW_OW_MUT, name="desktop_clipboard")
    def clipboard(ctx: Context, action: str = "get", text: str = "") -> Dict[str, Any]:
        """Read or write the active target's clipboard.

        action="get" → {text} the current clipboard content.
        action="set" → put `text` on the clipboard (then paste with
        desktop_act(op="paste"), or it's available for the app to use).

        For typing into a field, op="paste" is usually better than type:
        reliable for long or unicode text. To READ a field's exact value,
        select it then desktop_act(op="copy").
        """
        tgt = _resolve_target("", get_username(ctx))
        if not tgt:
            return _no_target_err()
        action = (action or "get").strip().lower()
        if action == "set":
            r = _agent_req(tgt, "/clipboard_set", {"text": text})
            if isinstance(r, dict) and r.get("error"):
                return r
            return ok(target=tgt["name"], chars=len(text or ""))
        r = _agent_req(tgt, "/clipboard_get", {})
        if isinstance(r, dict) and r.get("error"):
            return r
        txt = r.get("text", "") if isinstance(r, dict) else ""
        return ok(target=tgt["name"], text=txt, chars=len(txt))

    @mcp.tool(**_TOOL_KW_OW_MUT, name="desktop_act")
    def act(ctx: Context, op: str,
            element_id: str = "", query: str = "",
            x: Optional[int] = None, y: Optional[int] = None,
            x2: Optional[int] = None, y2: Optional[int] = None,
            text: str = "", keys: str = "", button: str = "left",
            clicks: int = 1, dy: int = 0, modifiers: str = "",
            settle_ms: int = 1000,
            observe_after: bool = True) -> Dict[str, Any]:
        """Perform ONE action on the active target, then return the UPDATED screen.

        Target an element by `element_id` (from desktop_observe) — preferred — or
        by `query` (its label), or by raw `x`,`y` (last resort). The result
        carries a FRESH element list, so chain actions WITHOUT re-observing each
        time. `resolved_by` tells you how the target was hit.

        op:
          click         click the element — a checkbox toggles, a list item
                        selects, a button activates, automatically (the agent
                        re-resolves the control live, so it survives small shifts)
          set_value     set a field's value (text=…) — use when an element's do="set"
          type          type text at the keyboard focus (text=…)
          key           press a key/combo (keys="ctrl+s", keys="enter")
          paste         paste text (text=…; better than type for long/accented)
          scroll        wheel at the element/point (dy>0 up / dy<0 down)
          double_click | right_click   click variants
          drag          from the element/x,y to x2,y2

        Examples:
          desktop_act(op="click", element_id="el_4")
          desktop_act(op="set_value", element_id="el_3", text="42")
          desktop_act(op="key", keys="ctrl+s")

        button left|right · clicks count · modifiers e.g. "ctrl+shift" ·
        settle_ms wait for the screen to settle after acting (default 1000;
        0=off; for a precise sync use desktop_wait) · observe_after attach the
        updated screen + elements (default true).
        """
        # Thin wrapper : la logique vit dans ``act_core`` (partagée avec
        # POST /api/desktop/act et le rejeu). Le modèle n'a pas de cible explicite
        # → cible active ("").  Chemin CHAT : semantic_click (clic re-résolu live +
        # désambiguïsation d'une query ambiguë) + return_elements (rendre l'écran
        # frais pour enchaîner sans desktop_observe). return_elements SUIT
        # observe_after — si le modèle coupe l'observation, on n'observe pas non plus.
        return act_core(
            get_username(ctx), "", op=op, element_id=element_id, query=query,
            x=x, y=y, x2=x2, y2=y2, text=text, keys=keys, button=button,
            clicks=clicks, dy=dy, modifiers=modifiers, settle_ms=settle_ms,
            observe_after=observe_after,
            semantic_click=True, return_elements=observe_after,
        )

    @mcp.tool(**_TOOL_KW_OW_RO, name="desktop_wait")
    def wait(ctx: Context, kind: str = "stable",
             query: str = "", text: str = "", value: str = "", state: str = "",
             role: str = "", auto_id: str = "", title_re: str = "",
             op: str = "==", count: int = 0, match: bool = False,
             timeout_ms: int = 8000) -> Dict[str, Any]:
        """Wait until a UI condition holds before continuing — reliable sync for
        long automations (same staged waits as scenario replay: dHash → a11y →
        OCR → UIA). Prefer this over a blind sleep or re-screenshot loop.

        kind:
          stable          screen stopped changing (default; e.g. after a click)
          element         an element matching `query` (label) is present
          element_gone    it has disappeared (spinner/dialog closed)
          text            on-screen text contains `text` (OCR-backed)
          text_gone       that text is gone
          value           the field `query` has value `value` (substring; regex if match=true)
          value_gone      that value is gone
          state           element `query` has a11y `state` (checked/enabled/selected…)
          count           number of elements matching `query`/`role` satisfies `op count`
          window_ready    a window matching `title_re`/`auto_id` is open AND ready (UIA)

        Examples:
          desktop_wait(kind="window_ready", title_re="Notepad")
          desktop_wait(kind="element", query="Save", timeout_ms=10000)
          desktop_wait(kind="text_gone", text="Loading")
          desktop_wait(kind="value", query="Total", value="42")
        Returns {satisfied, waited_ms, detail} + a fresh frame.
        """
        with Heartbeat(ctx):
            return wait_core(
                get_username(ctx), "", kind=kind, query=query, text=text, value=value,
                state=state, role=role, auto_id=auto_id, title_re=title_re, op=op,
                count=count, match=match, timeout_ms=timeout_ms,
            )

    @mcp.tool(**_TOOL_KW_OW_MUT, name="desktop_launch")
    def launch(ctx: Context, app: str, args: str = "",
               timeout_ms: int = 15000) -> Dict[str, Any]:
        """Launch a program/shortcut on the active target AND wait until it is
        initialised (WaitForInputIdle + its new window ready) — reliable handling
        of load times, instead of clicking blindly and hoping. Returns the window
        that appeared (title/auto_id/interaction_state) + a fresh frame.

        app   a common app NAME ("calculatrice", "calculator", "notepad",
              "bloc-notes", "paramètres"…), an executable ("notepad.exe"), a path
              ("C:\\\\app\\\\x.lnk"), or a URI ("https://…", "ms-settings:"). Friendly
              names (FR/EN) are resolved automatically on Windows.
        args  optional command-line arguments.
        Examples:
          desktop_launch(app="calculatrice")     # → calc.exe
          desktop_launch(app="notepad.exe")
          desktop_launch(app="explorer.exe", args="C:\\\\Users")
        """
        return launch_core(get_username(ctx), "", app=app, args=args,
                           timeout_ms=timeout_ms)

    @mcp.tool(**with_policy(_TOOL_KW_OW_MUT, timeout_s=_RUN_AUTOMATION_TOOL_CEILING_S), name="desktop_run_automation")
    def run_automation(ctx: Context, name: str, code: str = "", targets: str = "",
                       dry_run: bool = False, trace: bool = False, timeout_s: int = 600) -> Dict[str, Any]:
        """Run an elpis_auto automation script (written in the Studio) ON one or
        several target machines, sequentially, and return the aggregated results
        (per target: ok, code, summary, steps ok/failed, healed targets). The
        script is pushed to each agent (which runs inside the user's interactive
        session) and executed there with ``python -m elpis_auto``.

        name       script name (slug) — used as the file name on the target.
        code       the full Python script (from the Studio). If empty, the script
                   saved as automations/<name>.py in the user's sandbox is used.
        targets    comma-separated target names ("" = the active/default target).
        dry_run    resolve every target without sending any input (préflight).
        trace      screenshot + tree excerpt per step (viewer in rapport.html).
        timeout_s  per-target bound, 30..3600 (default 600 s); lowered so that all
                   targets fit in the tool's one-hour ceiling (see ``note``).
        A notification summarises the run when it ends — usable from a routine.
        """
        username = get_username(ctx)
        src = str(code or "")
        if not src.strip():
            src = _load_sandbox_automation(username, name)
        if not src.strip():
            return err("no_code", f"script vide : passe ``code`` ou enregistre automations/{_slug_auto(name)}.py dans la sandbox")
        tl = [t.strip() for t in str(targets or "").split(",") if t.strip()] or [""]
        uid = None
        try:
            from shared_infra.accounts.users import get_user
            row = get_user(username)
            uid = int(row["id"]) if row is not None else None
        except Exception:
            uid = None
        # L'outil est coupé par le harnais à _RUN_AUTOMATION_TOOL_CEILING_S : la boucle
        # continuait alors seule (le modèle, lu « relance », en démarrait une 2e). Le
        # budget par cible est ramené pour que TOUTE la matrice tienne sous le plafond.
        per_target = _clamp_timeout_s(timeout_s)
        fit = max(30, int(_RUN_AUTOMATION_BUDGET_S // max(1, len(tl))))
        note = ""
        if per_target > fit:
            note = (f"budget par cible ramené de {per_target} s à {fit} s "
                    f"(plafond de l'outil {int(_RUN_AUTOMATION_BUDGET_S)} s pour {len(tl)} cible(s))")
            per_target = fit
        doc = run_automation_core(username, tl, name, src, dry_run=bool(dry_run), trace=bool(trace),
                                  timeout_s=per_target, notify_user_id=uid,
                                  total_budget_s=_RUN_AUTOMATION_BUDGET_S)
        if note and isinstance(doc, dict):
            doc["note"] = note
        return doc

    # desktop_shell — exécution de commande sur la VM (façon execute_shell).
    # ON PAR DÉFAUT (comme execute_shell). Masquable par l'opérateur via
    # DESKTOP_DISABLE_SHELL (côté hôte chatbot) ; l'exécution est en plus bloquable
    # côté agent (même env sur la VM) → 501.
    if not getattr(_cfg, "DESKTOP_DISABLE_SHELL", False):
        @mcp.tool(**with_policy(_TOOL_KW_OW_MUT, timeout_s=610.0), name="desktop_shell")
        def run_shell(ctx: Context, command: str, shell: str = "powershell",
                      cwd: str = "", timeout_sec: int = 120,
                      max_output: int = 20000) -> Dict[str, Any]:
            """Run a shell command ON the desktop target (default: PowerShell) — like
            execute_shell, but on the VM. Returns {ok, returncode, stdout, stderr,
            truncated, duration_ms}; ok is (returncode == 0), a non-zero code is a
            normal result to reason about, not an error.

            Use this for scripted / file / registry / service / environment tasks that
            are far faster and more reliable than clicking through the UI (read a file,
            list processes, set a registry value, query env). For genuine UI work,
            prefer the targeted tools (desktop_observe / desktop_act).

            command      the command/script to run.
            shell        powershell (default) | pwsh | cmd  (use bash on a Linux target).
            cwd          working directory on the target (optional).
            timeout_sec  1..600, default 120. On timeout: returncode 124, ok=False.
            max_output   per-stream char cap, tail-kept (the END is preserved). There
                         is NO file spill on the VM — for huge output, narrow the
                         command or redirect to a file on the target.

            ⚠ SECURITY: runs with FULL privileges on the VM — there is NO sandbox here
            (unlike execute_shell's Docker isolation). Only run what you would run
            yourself on that machine; confirm before anything destructive.

            Examples:
              desktop_shell(command="Get-Process | Select-Object -First 5 Name,Id")
              desktop_shell(command="Get-Content C:\\\\path\\\\file.txt -TotalCount 40")
              desktop_shell(command="ls -la /tmp", shell="bash")   # Linux target
            """
            return run_command_core(get_username(ctx), "", command=command,
                                    shell=shell, cwd=cwd, timeout_sec=timeout_sec,
                                    max_output=max_output)

    @mcp.tool(**_TOOL_KW_OW_RO, name="desktop_windows")
    def windows(ctx: Context) -> Dict[str, Any]:
        """List the OPEN top-level windows on the active target — title, state
        (normal|minimized|maximized) and which one is in front. Cheap: no subtree.

        desktop_observe shows ONLY the foreground window. To reach another app:
        list windows here, then desktop_focus(action="activate", window_id=…) to
        bring it to the front (or minimize/maximize/restore/close it); or
        desktop_launch to start a new one.

        Returns {windows:[{id, title, state, is_foreground}], count}.
        """
        return list_windows_core(get_username(ctx), "")

    @mcp.tool(**_TOOL_KW_OW_MUT, name="desktop_focus")
    def focus(ctx: Context, action: str = "activate", window_id: str = "") -> Dict[str, Any]:
        """Act on a top-level window by `window_id` (from desktop_windows): bring it
        to the front or change its state. After activating, the foreground changes,
        so a following desktop_observe shows THAT window.

        action     activate|focus (bring to front), minimize, maximize, restore, close.
        window_id  the window's id from desktop_windows.

        Example: desktop_focus(action="activate", window_id="13310")
        """
        return window_action_core(get_username(ctx), "", action=action, window_id=window_id)

    # ── B3 : surface d'outils LEAN pour les modèles 30-129B ──────────────────
    # desktop_screenshot (capture brute) et desktop_inspect (arbre a11y brut) font
    # DOUBLON avec desktop_observe (arbre + annotations + ids stables). On ne les
    # expose PAS au modèle par défaut : moins de schéma en contexte, moins de
    # mauvais choix d'outil par les petits modèles. Le Studio ne les utilise pas
    # (routes HTTP /api/desktop/*). Réactivables à froid via DESKTOP_EXPOSE_RAW_TOOLS
    # (les fonctions restent définies et appelables in-process).
    if getattr(_cfg, "DESKTOP_EXPOSE_RAW_TOOLS", False):
        mcp.tool(**_TOOL_KW_OW_RO, name="desktop_screenshot")(screenshot)
        mcp.tool(**_TOOL_KW_OW_RO, name="desktop_inspect")(inspect)
