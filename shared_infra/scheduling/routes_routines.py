# SPDX-License-Identifier: MIT
"""
shared_infra.scheduling.routes_routines — API des routines planifiées (tâches récurrentes).

Endpoints (tous owner-gated via ``require_user_id`` + filtre ``owner_user_id`` —
un user ne voit jamais les routines d'un autre : 404, pas 403) :

- GET    /api/routines                  — liste mes routines
- POST   /api/routines                  — créer une routine
- GET    /api/routines/{id}             — détail d'une de mes routines
- PUT    /api/routines/{id}             — modifier
- POST   /api/routines/{id}/enable      — (ré)activer
- POST   /api/routines/{id}/disable     — désactiver
- DELETE /api/routines/{id}             — supprimer (CASCADE → runs)
- POST   /api/routines/{id}/run-now     — lancer immédiatement (in-process)
- GET    /api/routines/{id}/runs        — journal des exécutions
- POST   /api/routines/{id}/runs/{run_id}/stop — arrêter un run EN COURS
- POST   /api/routines/{id}/webhook/rotate  — (ré)génère le token + active
- POST   /api/routines/{id}/webhook/disable — coupe le déclencheur webhook
- POST   /api/routines/{id}/webhook/filter  — filtre events/branch/repo

Webhook : la livraison publique vit dans ``shared_infra.scheduling.routes_webhooks``
(``POST /api/webhooks/routines/{id}``, auth = HMAC du corps brut OU token).
Le token n'est renvoyé qu'UNE fois, par ``rotate`` — jamais par les GET.

Enchaînement « à la Jenkins » : ``trigger_after_id`` + ``trigger_after_on``
(ok | error | always) — la routine se lance après une AUTRE routine du même
utilisateur (validé par ``_validate_trigger_after`` ; cycles coupés à
l'exécution par ``CHAIN_MAX_DEPTH``). Champs portés par POST/PUT standard.

``cron_expr`` peut être VIDE (= aucune planification : déclenchement manuel,
webhook ou enchaînement) — ``_cron_matches("")`` est structurellement False,
le scheduler ne peut pas tirer une routine sans cron.

Les secrets MCP (auth/headers/token…) ne sont JAMAIS persistés dans la routine
(strippés côté DB) ; ils sont re-résolus depuis les settings user à l'exécution.

Champ ``skills`` : liste d'ids de skills (qualifiés ``pkg/child`` ou noms)
attachés à la routine — leurs corps sont injectés dans le system prompt du run
(l'agent headless n'a ni index ni ``skill_get``). Seuls les ids sont persistés ;
les corps sont résolus frais à chaque exécution.

Champ ``agents_enabled`` : opt-in PAR ROUTINE de l'outil ``task`` (sous-agents),
défaut OFF. Volontairement indépendant du toggle de chat ``agents_enabled`` des
settings : un run headless qui délègue ouvre des boucles agentiques que personne
ne regarde, ça se décide routine par routine (onglet Agents de l'éditeur).

Historique par routine (2026-09-08) : ``runs_keep`` (nb d'exécutions terminées
conservées au journal, 0 = toutes), ``notify_on`` (``all`` | ``error`` |
``none`` — quels runs poussent une notification dans le centre de
notifications) et ``notify_keep`` (nb de notifications conservées pour cette
routine, 0 = pas de cap dédié). Validés par ``_validate_history``.
"""
from __future__ import annotations

from typing import Any, Dict, List

from fastapi import HTTPException, Request

from shared_infra.routes._state import router

# Validation cron FACTORISÉE dans ``_cron`` (partagée avec les Scénarios, en
# miroir exact de ``_cron_matches``). Re-exportée ici sous ``_validate_cron``
# pour les appelants internes et les tests existants
# (``from shared_infra.scheduling.routes_routines import _validate_cron``).
from shared_infra.scheduling.routes_cron import (  # noqa: E402
    validate_cron as _validate_cron,
)
from shared_infra.scheduling.routines_store import (
    KEEP_MAX,
    NOTIFY_ON_VALUES,
    create_routine,
    delete_routine,
    get_routine,
    get_run,
    list_routines,
    list_runs,
    set_routine_enabled,
    update_routine,
)
from shared_infra.security.deps import require_user_id

# Nb max de skills attachables à une routine : leurs corps sont injectés
# ENTIERS dans le system prompt du run (borné par SKILLS_CHAR_BUDGET) — au-delà,
# le prompt se dilue et la sélection perd son sens.
_SKILLS_MAX = 12

# Borne des prompts persistés : ``list_enabled_routines()`` relit TOUTES les
# routines actives à chaque tick du leader (60 s) — un dump de 20 Mo collé en
# task_prompt serait désérialisé chaque minute, à vie.
_PROMPT_MAX = 200_000


async def _json_dict(request: Request) -> Dict[str, Any]:
    """Corps JSON → dict, ou 400. Sans ça, un corps ``[]`` / ``"abc"`` filait
    en AttributeError → 500."""
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(400, "corps JSON invalide")
    if not isinstance(data, dict):
        raise HTTPException(400, "objet JSON attendu")
    return data


def _req_str(data: Dict[str, Any], key: str, *, max_len: int = 0) -> str:
    """Champ texte optionnel typé : None → "", str → str (bornée), autre → 400
    (``{"name": 123}`` levait AttributeError sur ``.strip()`` → 500)."""
    v = data.get(key)
    if v is None:
        return ""
    if not isinstance(v, str):
        raise HTTPException(400, f"{key} doit être une chaîne")
    if max_len and len(v) > max_len:
        raise HTTPException(400, f"{key} trop long (max {max_len} caractères)")
    return v


def _known_skill_ids(user_id: int) -> Any:
    """Ids/noms des skills sélectionnables par cet utilisateur.

    Même résolution que l'injection au run (``build_attached_skills_block``) :
    user + global, learned exclu ; on accepte l'id qualifié ET le nom nu.
    Retourne ``None`` si la découverte est indisponible (fail-open : on accepte
    la sauvegarde, le runner ignorera les ids inconnus)."""
    try:
        from llm_core._system_prompts import _user_skills_dir
        from llm_core.skills import discover_skills
        specs = discover_skills(_user_skills_dir(user_id), include_learned=False)
    except Exception:
        return None
    ids = set()
    for sp in specs:
        ids.add(getattr(sp, "id", "") or sp.name)
        ids.add(sp.name)
    return ids


def _validate_skills(data: Dict[str, Any], user_id: int) -> list:
    """Valide/normalise ``data["skills"]`` : liste de strings non vides,
    dédupliquée, ≤ ``_SKILLS_MAX``, ids connus (si la découverte répond)."""
    raw = data.get("skills")
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise HTTPException(400, "skills doit être une liste d'identifiants")
    out: list = []
    for s in raw:
        if not isinstance(s, str) or not s.strip():
            raise HTTPException(400, "skills : identifiants (strings) non vides attendus")
        s = s.strip()
        if len(s) > 200:
            raise HTTPException(400, "skills : identifiant trop long")
        if s not in out:
            out.append(s)
    if len(out) > _SKILLS_MAX:
        raise HTTPException(400, f"skills : maximum {_SKILLS_MAX} skills par routine")
    known = _known_skill_ids(user_id)
    if known is not None:
        unknown = [s for s in out if s not in known]
        if unknown:
            raise HTTPException(400, "Skill introuvable : " + ", ".join(unknown))
    return out


def _mcp_refs(mcp: Any) -> List[Dict[str, Any]]:
    """Snapshot MCP d'une routine réduit à des RÉFÉRENCES (2026-09-21).

    Outils locaux → sentinelle reconstruite ; serveur perso ou partagé → id,
    nom, type ; entrée du manifeste → son nom. Ni ``command``, ni ``url``
    utilisable, ni en-têtes : le scheduler résout tout côté serveur et jette
    ce qui ne se résout pas. Une entrée sans id garde ``name``/``url`` pour
    l'appariement des snapshots anciens — jamais pour se connecter."""
    if not isinstance(mcp, list):
        raise HTTPException(400, "mcp_servers doit être une liste")
    from shared_infra.mcp.servers import client_builtin_ref
    out: List[Dict[str, Any]] = []
    for raw in mcp[:64]:
        if not isinstance(raw, dict):
            continue
        ref = client_builtin_ref(raw)
        if ref is not None:
            out.append(ref)
            continue
        entry: Dict[str, Any] = {}
        if raw.get("id"):
            entry["id"] = str(raw["id"])[:120]
            if raw.get("shared"):
                entry["shared"] = True
        elif raw.get("manifest"):
            entry["manifest"] = str(raw["manifest"])[:120]
            if isinstance(raw.get("filter_categories"), list):
                entry["filter_categories"] = [
                    c for c in raw["filter_categories"] if isinstance(c, str)][:64]
        elif raw.get("url") or raw.get("name"):
            if raw.get("url"):
                entry["url"] = str(raw["url"])[:2000]
        else:
            continue
        if raw.get("name"):
            entry["name"] = str(raw["name"])[:120]
        if isinstance(raw.get("type"), str):
            entry["type"] = raw["type"][:16]
        out.append(entry)
    return out


def _validate_history(data: Dict[str, Any]) -> Dict[str, Any]:
    """Politique d'historique : ne renvoie QUE les clés présentes dans ``data``
    (PUT partiel = champ absent inchangé).

    ``runs_keep`` / ``notify_keep`` : entier 0..KEEP_MAX (0 = tous ; ``null``
    et ``""`` valent 0 — le champ vidé dans le formulaire). ``notify_on`` :
    ``all`` | ``error`` | ``none``. Une valeur d'un autre type → 400, jamais
    un arrondi silencieux (``true`` → 1, ``2.7`` → 2)."""
    out: Dict[str, Any] = {}
    for k in ("runs_keep", "notify_keep"):
        if k not in data:
            continue
        v = data.get(k)
        if v is None or v == "":
            v = 0
        if isinstance(v, bool) or not isinstance(v, (int, str)):
            raise HTTPException(400, f"{k} : entier attendu")
        try:
            n = int(str(v).strip())
        except ValueError:
            raise HTTPException(400, f"{k} : entier attendu")
        if n < 0 or n > KEEP_MAX:
            raise HTTPException(400, f"{k} : entre 0 (tous) et {KEEP_MAX}")
        out[k] = n
    if "notify_on" in data:
        v = data.get("notify_on")
        v = "all" if v is None else v
        if not isinstance(v, str):
            raise HTTPException(400, "notify_on invalide (all | error | none)")
        v = v.strip().lower()
        if v not in NOTIFY_ON_VALUES:
            raise HTTPException(400, "notify_on invalide (all | error | none)")
        out["notify_on"] = v
    return out


def _validate_trigger_after(data: Dict[str, Any], user_id: int,
                            routine_id: "int | None" = None):
    """Enchaînement « à la Jenkins » : (trigger_after_id, trigger_after_on).

    La routine amont doit exister ET appartenir au même utilisateur ; une
    routine ne peut pas s'enchaîner après elle-même. Les cycles indirects
    (A→B→A) ne sont pas détectés ici — coupés à l'exécution par
    ``CHAIN_MAX_DEPTH``."""
    raw = data.get("trigger_after_id")
    after_id = None
    if raw not in (None, "", 0, "0"):
        try:
            after_id = int(raw)
        except (TypeError, ValueError):
            raise HTTPException(400, "trigger_after_id invalide")
        if routine_id is not None and int(routine_id) == after_id:
            raise HTTPException(400, "Une routine ne peut pas s'enchaîner après elle-même")
        if not get_routine(after_id, user_id):
            raise HTTPException(404, "Routine amont introuvable")
    on = str(data.get("trigger_after_on") or "ok").strip().lower()
    if on not in ("ok", "error", "always"):
        raise HTTPException(400, "trigger_after_on invalide (ok | error | always)")
    return after_id, on


def _validate_connector(data: Dict[str, Any], user_id: int) -> "int | None":
    """Serveur d'inférence de la routine (2026-09-17, M5) : ``None`` = intégré.

    Le couple (connecteur, modèle) est atomique — une routine qui vise un
    second serveur doit y aller vraiment, jamais retomber en silence sur
    l'intégré. On vérifie donc ICI que le connecteur est visible du
    propriétaire, actif, et que sa politique d'accès le lui ouvre."""
    raw = data.get("connector_id")
    if raw in (None, "", 0, "0"):
        return None
    try:
        cid = int(raw)
    except (TypeError, ValueError):
        raise HTTPException(400, "connector_id invalide")
    from llm_core._target import EngineUnavailable, resolve_llm_target
    try:
        resolve_llm_target(user_id, cid, None, strict=True, touch=False)
    except EngineUnavailable as eu:
        raise HTTPException(400, eu.message)
    from shared_infra.llm import engine_access as _ea
    try:
        ouvert = _ea.can_use_engine(user_id, _ea.connector_key(cid))
    except Exception:                                           # noqa: BLE001
        ouvert = True                   # fail-open documenté dans engine_access
    if not ouvert:
        raise HTTPException(403, "Ce serveur ne vous est pas ouvert.")
    return cid


def _routine_payload(data: Dict[str, Any], user_id: int) -> Dict[str, Any]:
    """Extrait/normalise les champs d'une routine depuis le body JSON."""
    name = _req_str(data, "name").strip()
    if not name:
        raise HTTPException(400, "Nom requis")
    raw_cron = (_req_str(data, "cron_expr") or _req_str(data, "cron")).strip()
    cron_expr = _validate_cron(raw_cron) if raw_cron else ""
    mcp = data.get("mcp_servers")
    if mcp is None:
        mcp = data.get("active_mcp_servers") or []
    mcp = _mcp_refs(mcp)
    after_id, after_on = _validate_trigger_after(data, user_id)
    history = _validate_history(data)
    return {
        "name": name[:200],
        "cron_expr": cron_expr,
        "model": (_req_str(data, "model", max_len=200) or None),
        "connector_id": _validate_connector(data, user_id),
        "system_prompt": _req_str(data, "system_prompt", max_len=_PROMPT_MAX),
        "task_prompt": _req_str(data, "task_prompt", max_len=_PROMPT_MAX),
        "mcp_servers": mcp,
        "skills": _validate_skills(data, user_id),
        "thinking_mode": bool(data.get("thinking_mode")),
        "enabled": bool(data.get("enabled", True)),
        "trigger_after_id": after_id,
        "trigger_after_on": after_on,
        # Sous-agents : opt-in PAR ROUTINE (onglet Agents), défaut OFF. Jamais
        # dérivé du toggle de chat — un run headless qui délègue est une
        # décision propre à la routine.
        "agents_enabled": bool(data.get("agents_enabled")),
        "runs_keep": history.get("runs_keep", 0),
        "notify_on": history.get("notify_on", "all"),
        "notify_keep": history.get("notify_keep", 0),
    }


@router.get("/api/routines")
def api_list_routines(request: Request):
    uid = require_user_id(request)
    return {"items": list_routines(uid)}


@router.post("/api/routines")
async def api_create_routine(request: Request):
    uid = require_user_id(request)
    data = await _json_dict(request)
    p = _routine_payload(data, uid)
    rid = create_routine(
        uid, name=p["name"], cron_expr=p["cron_expr"], model=p["model"],
        system_prompt=p["system_prompt"], task_prompt=p["task_prompt"],
        mcp_servers=p["mcp_servers"], skills=p["skills"],
        connector_id=p["connector_id"],
        thinking_mode=p["thinking_mode"], enabled=p["enabled"],
        trigger_after_id=p["trigger_after_id"],
        trigger_after_on=p["trigger_after_on"],
        agents_enabled=p["agents_enabled"],
        runs_keep=p["runs_keep"], notify_on=p["notify_on"],
        notify_keep=p["notify_keep"],
    )
    return {"id": rid, "ok": True}


@router.get("/api/routines/{routine_id}")
def api_get_routine(routine_id: int, request: Request):
    uid = require_user_id(request)
    r = get_routine(routine_id, uid)
    if not r:
        raise HTTPException(404, "Routine introuvable")
    return r


@router.put("/api/routines/{routine_id}")
async def api_update_routine(routine_id: int, request: Request):
    uid = require_user_id(request)
    data = await _json_dict(request)
    fields: Dict[str, Any] = {}
    if "name" in data:
        nm = _req_str(data, "name").strip()
        if not nm:
            raise HTTPException(400, "Nom requis")
        fields["name"] = nm[:200]
    if "cron_expr" in data or "cron" in data:
        raw_cron = (_req_str(data, "cron_expr") or _req_str(data, "cron")).strip()
        fields["cron_expr"] = _validate_cron(raw_cron) if raw_cron else ""
    if "system_prompt" in data:
        fields["system_prompt"] = _req_str(data, "system_prompt", max_len=_PROMPT_MAX)
    if "task_prompt" in data:
        fields["task_prompt"] = _req_str(data, "task_prompt", max_len=_PROMPT_MAX)
    if "model" in data:
        fields["model"] = _req_str(data, "model", max_len=200)
    if "connector_id" in data:
        fields["connector_id"] = _validate_connector(data, uid)
    for k in ("thinking_mode", "enabled", "agents_enabled"):
        if k in data:
            fields[k] = bool(data[k])
    # Normalisation « modèle par défaut » : le select envoie "" ou null —
    # on stocke NULL (cohérent avec _routine_payload à la création).
    if "model" in fields and not fields["model"]:
        fields["model"] = None
    if "mcp_servers" in data or "active_mcp_servers" in data:
        mcp = data.get("mcp_servers")
        if mcp is None:
            mcp = data.get("active_mcp_servers") or []
        fields["mcp_servers"] = _mcp_refs(mcp)
    if "trigger_after_id" in data or "trigger_after_on" in data:
        after_id, after_on = _validate_trigger_after(data, uid, routine_id=routine_id)
        if "trigger_after_id" in data:
            fields["trigger_after_id"] = after_id
        if "trigger_after_on" in data:
            fields["trigger_after_on"] = after_on
    if "skills" in data:
        fields["skills"] = _validate_skills(data, uid)
    fields.update(_validate_history(data))
    if not update_routine(routine_id, uid, **fields):
        raise HTTPException(404, "Routine introuvable")
    return {"ok": True}


@router.post("/api/routines/{routine_id}/enable")
def api_enable_routine(routine_id: int, request: Request):
    uid = require_user_id(request)
    if not set_routine_enabled(routine_id, uid, True):
        raise HTTPException(404, "Routine introuvable")
    return {"ok": True, "enabled": True}


@router.post("/api/routines/{routine_id}/disable")
def api_disable_routine(routine_id: int, request: Request):
    uid = require_user_id(request)
    if not set_routine_enabled(routine_id, uid, False):
        raise HTTPException(404, "Routine introuvable")
    return {"ok": True, "enabled": False}


@router.delete("/api/routines/{routine_id}")
def api_delete_routine(routine_id: int, request: Request):
    uid = require_user_id(request)
    if not delete_routine(routine_id, uid):
        raise HTTPException(404, "Routine introuvable")
    return {"ok": True}


@router.post("/api/routines/{routine_id}/run-now")
async def api_run_now(routine_id: int, request: Request):
    uid = require_user_id(request)
    r = get_routine(routine_id, uid)
    if not r:
        raise HTTPException(404, "Routine introuvable")
    # Routine désactivée : refus explicite plutôt qu'un run admis puis
    # requalifié — le journal montrait une ligne parasite pour un clic
    # qui ne pouvait pas aboutir.
    if not r.get("enabled"):
        raise HTTPException(400, "Routine désactivée — réactivez-la pour l'exécuter")
    # Exécution in-process sur CE worker (indépendant du leader) ; le cap reste
    # correct car l'admission DB est globale (BEGIN IMMEDIATE).
    from shared_infra.scheduling.routines_scheduler import launch_run
    run_id = await launch_run(r, trigger="manual")
    if run_id is None:
        # La VRAIE raison (cap user vs anti-chevauchement F10) vient du run
        # 'skipped' que launch_run vient de journaliser — le libellé codé en
        # dur affichait « cap atteint » alors qu'un simple run était déjà en
        # cours pour cette routine.
        reason = "cap de runs simultanés atteint"
        try:
            items = list_runs(routine_id, uid, limit=1)
            if items and items[0].get("status") == "skipped" and items[0].get("error"):
                reason = str(items[0]["error"])
        except Exception:
            pass
        return {"ok": False, "skipped": True, "reason": reason}
    return {"ok": True, "run_id": run_id}


@router.get("/api/routines/{routine_id}/runs")
def api_list_routine_runs(routine_id: int, request: Request, limit: int = 50, offset: int = 0):
    uid = require_user_id(request)
    if not get_routine(routine_id, uid):
        raise HTTPException(404, "Routine introuvable")
    return {"items": list_runs(routine_id, uid, limit=limit, offset=offset)}


@router.post("/api/routines/{routine_id}/runs/{run_id}/stop")
def api_stop_routine_run(routine_id: int, run_id: int, request: Request):
    """Arrête un run EN COURS. L'arrêt est coopératif + ``task.cancel()`` :

    le worker qui exécute le run est imprévisible (leader cron pour les runs
    planifiés, worker récepteur pour run-now) → ``mark_chat_cancelled`` pose le
    flag local ET diffuse sur cancel_bus ; le tailer du worker hébergeur trouve
    la task enregistrée sous la clé synthétique et la cancel. Réponse
    optimiste ``stopping: true`` : la transition de statut apparaît au
    prochain poll du journal (un outil long peut retarder l'arrêt effectif).
    """
    uid = require_user_id(request)
    if not get_routine(routine_id, uid):
        raise HTTPException(404, "Routine introuvable")
    run = get_run(run_id, uid)
    if not run or int(run.get("routine_id") or 0) != int(routine_id):
        raise HTTPException(404, "Run introuvable")
    if run.get("status") != "running":
        return {"ok": True, "stopping": False, "status": run.get("status")}

    # Run au heartbeat PÉRIMÉ : le worker porteur est probablement mort — la
    # diffusion cancel_bus ne trouverait personne, le run resterait « En
    # cours » jusqu'à 5 min puis passerait 'orphaned' (« Interrompu ») alors
    # que l'utilisateur a explicitement demandé l'arrêt. Transition directe.
    import time as _t

    from shared_infra.routes._state import get_active_chat_task, mark_chat_cancelled
    from shared_infra.scheduling.routines_scheduler import ORPHAN_STALE_AFTER_S, run_chat_key
    hb = run.get("heartbeat_at")
    if hb is None or (_t.time() - float(hb)) > ORPHAN_STALE_AFTER_S:
        from shared_infra.scheduling.routines_store import mark_run_cancelled
        started = float(run.get("started_at") or _t.time())
        dur = int(max(0.0, (float(hb) if hb is not None else started) - started) * 1000)
        marked = mark_run_cancelled(run_id, duration_ms=dur)
        return {"ok": True, "stopping": False,
                "status": "cancelled" if marked else run.get("status")}

    key = run_chat_key(routine_id, run_id)
    mark_chat_cancelled(uid, key)
    # Si le run vit dans CE worker, cancel direct — sans attendre l'écho du
    # bus (~100 ms). Même geste que POST /api/chat/cancel.
    task = get_active_chat_task(uid, key)
    if task is not None and not task.done():
        task.cancel()
    return {"ok": True, "stopping": True}


# ── Déclencheur webhook (la livraison publique vit dans routes/webhooks.py) ──

# Noms d'événements LIBRES : l'émetteur n'est pas forcément une forge Git
# (supervision, CI, script…). On borne juste la forme — minuscules, chiffres
# et séparateurs usuels — pour rester comparable au header/champ ``event``
# normalisé côté livraison (lui aussi lowercasé).
import re as _re_wh

_WEBHOOK_EVENT_RE = _re_wh.compile(r"^[a-z0-9][a-z0-9_.:-]{0,63}$")
_WEBHOOK_EVENTS_MAX = 16


@router.post("/api/routines/{routine_id}/webhook/rotate")
def api_routine_webhook_rotate(routine_id: int, request: Request):
    """(Ré)génère le secret HMAC et ACTIVE le déclencheur. Seul endroit où le
    secret circule — à coller dans la config du hook Gitea avec l'URL."""
    uid = require_user_id(request)
    if not get_routine(routine_id, uid):
        raise HTTPException(404, "Routine introuvable")
    import secrets as _secrets
    secret = _secrets.token_hex(32)
    from shared_infra.scheduling.routines_store import set_routine_webhook
    # rowcount vérifié : routine supprimée entre le GET et l'UPDATE →
    # l'utilisateur copiait un secret qui n'existait nulle part.
    if not set_routine_webhook(routine_id, uid, enabled=True, secret=secret):
        raise HTTPException(404, "Routine introuvable")
    return {"ok": True, "secret": secret,
            "path": f"/api/webhooks/routines/{int(routine_id)}"}


@router.post("/api/routines/{routine_id}/webhook/disable")
def api_routine_webhook_disable(routine_id: int, request: Request):
    """Coupe le déclencheur (le secret est conservé : une ré-activation via
    rotate en régénère un de toute façon)."""
    uid = require_user_id(request)
    if not get_routine(routine_id, uid):
        raise HTTPException(404, "Routine introuvable")
    from shared_infra.scheduling.routines_store import set_routine_webhook
    if not set_routine_webhook(routine_id, uid, enabled=False):
        raise HTTPException(404, "Routine introuvable")
    return {"ok": True, "webhook_enabled": False}


def _validate_webhook_filter(data: Dict[str, Any]) -> Dict[str, Any]:
    events = data.get("events") or []
    if not isinstance(events, list):
        raise HTTPException(400, "events doit être une liste")
    norm_events: list = []
    for e in events:
        e = str(e).strip().lower()
        if not e:
            continue
        if not _WEBHOOK_EVENT_RE.match(e):
            raise HTTPException(400, f"event invalide : {e!r} (minuscules, "
                                     "chiffres, . _ : - ; 64 car. max)")
        if e not in norm_events:
            norm_events.append(e)
    if len(norm_events) > _WEBHOOK_EVENTS_MAX:
        raise HTTPException(400, f"trop d'events (max {_WEBHOOK_EVENTS_MAX})")
    branch = str(data.get("branch") or "").strip()[:200]
    repo = str(data.get("repo") or "").strip()[:200]
    return {"events": norm_events, "branch": branch, "repo": repo}


@router.post("/api/routines/{routine_id}/webhook/filter")
async def api_routine_webhook_filter(routine_id: int, request: Request):
    """Filtre de livraison : events (liste), branch, repo (owner/name).
    Champs vides = pas de filtre sur cet axe."""
    uid = require_user_id(request)
    if not get_routine(routine_id, uid):
        raise HTTPException(404, "Routine introuvable")
    flt = _validate_webhook_filter(await _json_dict(request))
    from shared_infra.scheduling.routines_store import set_routine_webhook
    if not set_routine_webhook(routine_id, uid, filter=flt):
        raise HTTPException(404, "Routine introuvable")
    return {"ok": True, "webhook_filter": flt}


