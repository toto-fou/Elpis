# SPDX-License-Identifier: MIT
"""
tests/shared_infra/test_audit_couche_entree_2026_08_23.py — audit du cœur
2026-08-23, couche d'entrée du harnais.

Trois défauts, trois propriétés :

  A. DÉCHARGEMENT — ``POST /api/llm/models/unload`` était la seule opération de
     cycle de vie sans protection : tout utilisateur authentifié pouvait
     arracher le modèle sous la génération d'un autre. Le garde-fou apparent
     (``wait_for_slots_idle``) ne protège pas : en mode routeur il rend True à
     la première sonde (pas de champ ``slots_processing``), et un run agentique
     tient l'exclusivité pendant ses exécutions d'outils sans occuper de slot.

  B. AUDIT — une vingtaine d'appels à ``audit_event`` lisaient
     ``request.state.user_id`` / ``.username`` que RIEN ne posait : toutes les
     actions d'administration étaient journalisées à ``user_id: null``, donc
     invisibles au filtre par opérateur du lecteur d'audit.

  C. BOUCLE D'ÉVÉNEMENTS — ``list_collections`` / ``ping`` sont synchrones
     (``httpx.Client``) et étaient appelées telles quelles dans des
     ``async def`` : la boucle — donc tous les flux du worker — figeait le
     temps de l'aller-retour, jusqu'à 3 s (30 s pour le test d'intégration).
     S'y ajoutait le reparsage d'un ``config.json`` de ~400 Ko, jusqu'à trois
     fois par requête.
"""
from __future__ import annotations

import asyncio
import json
import time

import pytest


# ── A. Le déchargement refuse quand une génération tient le modèle ───────────

class _RequeteFactice:
    def __init__(self, corps: dict):
        self._corps = corps
        self.session = {"user_id": 1}

    async def json(self):
        return self._corps


@pytest.fixture
def _route_llm(monkeypatch):
    from shared_infra.llm import routes as R

    monkeypatch.setattr(R, "require_user_id", lambda req: 1)
    monkeypatch.setattr(R, "get_user_by_id", lambda uid: {"username": "bob"})

    async def _diffuse(_ev):
        return None
    monkeypatch.setattr(R.system_events, "broadcast", _diffuse)
    return R


async def test_le_dechargement_est_refuse_pendant_une_generation(_route_llm, monkeypatch):
    R = _route_llm
    decharge = []

    async def _instantane():
        return {"current_model": "qwen3-80b", "active_count": 1,
                "is_idle": False, "high_waiting": 0,
                "grace_model": None, "grace_remaining": 0.0}
    monkeypatch.setattr(R.MODEL_EXCLUSIVITY, "snapshot_async", _instantane)

    async def _decharge(mid):
        decharge.append(mid)
        return {"ok": True}
    monkeypatch.setattr(R, "unload_llm_model", _decharge)

    rep = await R.api_llm_unload_model(_RequeteFactice({"model_id": "qwen3-80b"}))
    corps = json.loads(bytes(rep.body).decode("utf-8"))

    assert corps["ok"] is False
    assert corps["busy_model"] == "qwen3-80b"
    assert decharge == [], "le modèle a été déchargé sous une génération en cours"


async def test_le_dechargement_passe_quand_rien_ne_tourne(_route_llm, monkeypatch):
    R = _route_llm
    decharge = []

    async def _instantane():
        return {"current_model": None, "active_count": 0, "is_idle": True,
                "high_waiting": 0, "grace_model": None, "grace_remaining": 0.0}
    monkeypatch.setattr(R.MODEL_EXCLUSIVITY, "snapshot_async", _instantane)

    async def _inactif(**_k):
        return True
    monkeypatch.setattr(R, "wait_for_slots_idle", _inactif)

    async def _decharge(mid):
        decharge.append(mid)
        return {"ok": True}
    monkeypatch.setattr(R, "unload_llm_model", _decharge)
    monkeypatch.setattr(R, "_set_loaded_model_cache", lambda *_a: None)

    async def _refresh():
        return None
    monkeypatch.setattr(R, "_refresh_model_cache", _refresh)
    monkeypatch.setattr(R, "log_metric", lambda *a, **k: None)

    rep = await R.api_llm_unload_model(_RequeteFactice({"model_id": "qwen3-80b"}))
    corps = json.loads(bytes(rep.body).decode("utf-8"))

    assert corps["ok"] is True
    assert decharge == ["qwen3-80b"]


async def test_force_reste_possible(_route_llm, monkeypatch):
    """Un modèle coincé derrière un run fantôme doit rester déchargeable —
    sinon la garde crée un cul-de-sac."""
    R = _route_llm
    decharge = []

    async def _instantane():
        raise AssertionError("force ne doit même pas consulter le verrou")
    monkeypatch.setattr(R.MODEL_EXCLUSIVITY, "snapshot_async", _instantane)

    async def _inactif(**_k):
        return True
    monkeypatch.setattr(R, "wait_for_slots_idle", _inactif)

    async def _decharge(mid):
        decharge.append(mid)
        return {"ok": False, "error": "moteur muet"}
    monkeypatch.setattr(R, "unload_llm_model", _decharge)

    await R.api_llm_unload_model(
        _RequeteFactice({"model_id": "qwen3-80b", "force": True}))
    assert decharge == ["qwen3-80b"]


# ── B. Le journal d'audit sait QUI ───────────────────────────────────────────

def test_la_porte_d_authentification_pose_l_operateur(monkeypatch):
    """Toutes les routes d'administration passent par ``require_user_id``
    (directement ou via ``_require_admin``) : c'est le seul endroit à corriger,
    et il a déjà la ligne d'utilisateur en main."""
    from shared_infra.security import deps

    class _Req:
        def __init__(self):
            self.session = {"user_id": 42}
            self.url = type("U", (), {"path": "/api/admin/executors"})()

            class _State:
                pass
            self.state = _State()

    monkeypatch.setattr(deps, "_session_validity_checks", lambda r, u: True)
    monkeypatch.setattr("shared_infra.accounts.users.get_user_by_id",
                        lambda uid: {"must_change_pwd": 0, "username": "chantal"})

    req = _Req()
    assert deps.require_user_id(req) == 42
    assert getattr(req.state, "user_id", None) == 42, \
        "audit_event journaliserait user_id: null"
    assert getattr(req.state, "username", None) == "chantal"


def test_l_operateur_est_pose_meme_si_la_ligne_utilisateur_manque(monkeypatch):
    """Base incohérente ou lecture en échec : l'identifiant reste connu (il
    vient de la session), seul le nom manque. On ne doit pas lever."""
    from shared_infra.security import deps

    class _Req:
        def __init__(self):
            self.session = {"user_id": 42}
            self.url = type("U", (), {"path": "/x"})()

            class _State:
                pass
            self.state = _State()

    monkeypatch.setattr(deps, "_session_validity_checks", lambda r, u: True)

    def _boum(uid):
        raise RuntimeError("base indisponible")
    monkeypatch.setattr("shared_infra.accounts.users.get_user_by_id", _boum)

    req = _Req()
    assert deps.require_user_id(req) == 42
    assert req.state.user_id == 42
    assert req.state.username is None


# ── C. Rien de bloquant sur la boucle d'événements ───────────────────────────

async def test_la_route_des_collections_ne_fige_pas_la_boucle(monkeypatch):
    """Un rag_app qui accepte sans répondre consommait le plafond de 3 s SUR
    LA BOUCLE : tous les flux de tous les utilisateurs du worker gelaient."""
    from shared_infra.routes import tools as T
    import llm_core._rag_client as RC

    monkeypatch.setattr(T, "require_user_id", lambda req: 1)

    def _lent(timeout=3.0):
        time.sleep(0.5)                 # exactement ce que fait httpx.Client
        return ["exigences"]
    monkeypatch.setattr(RC, "list_collections", _lent)

    battements = 0

    async def _coeur():
        nonlocal battements
        while True:
            await asyncio.sleep(0.02)
            battements += 1

    pouls = asyncio.create_task(_coeur())
    try:
        rep = await T.api_get_rag_collections(object())
    finally:
        pouls.cancel()

    assert rep == {"collections": ["exigences"]}
    assert battements >= 10, (
        f"boucle figée pendant l'appel RAG : {battements} battements en 0,5 s "
        "(≈25 attendus)")


def test_la_section_rag_est_memoisee(tmp_path, monkeypatch):
    """Jusqu'à trois lectures par requête RAG (url, jeton, délai), chacune
    reparsant le ``config.json`` entier — ~400 Ko sur l'instance réelle."""
    import llm_core._rag_client as RC

    fichier = tmp_path / "config.json"
    fichier.write_text(json.dumps(
        {"rag": {"service_url": "http://a"}, "bourrage": ["x"] * 20000}),
        encoding="utf-8")
    monkeypatch.setattr("shared_infra.config.CONFIG_JSON_PATH", str(fichier))
    RC._SECTION_RAG_CACHE = None

    lectures = {"n": 0}
    vrai_open = open

    def _compte(chemin, *a, **k):
        if str(chemin) == str(fichier):
            lectures["n"] += 1
        return vrai_open(chemin, *a, **k)
    monkeypatch.setattr("builtins.open", _compte)

    for _ in range(10):
        assert RC._read_rag_section()["service_url"] == "http://a"
    assert lectures["n"] == 1, \
        f"le fichier a été reparsé {lectures['n']} fois au lieu d'une"

    # …et une modification est bien vue.
    fichier.write_text(json.dumps({"rag": {"service_url": "http://b"}}),
                       encoding="utf-8")
    assert RC._read_rag_section()["service_url"] == "http://b"
    assert lectures["n"] == 2


def test_la_section_rag_memoisee_n_est_pas_partagee_en_ecriture(tmp_path, monkeypatch):
    """Le cache rend une copie : un appelant qui mute son résultat ne doit pas
    empoisonner les suivants."""
    import llm_core._rag_client as RC

    fichier = tmp_path / "config.json"
    fichier.write_text(json.dumps({"rag": {"service_url": "http://a"}}),
                       encoding="utf-8")
    monkeypatch.setattr("shared_infra.config.CONFIG_JSON_PATH", str(fichier))
    RC._SECTION_RAG_CACHE = None

    premier = RC._read_rag_section()
    premier["service_url"] = "SABOTÉ"
    assert RC._read_rag_section()["service_url"] == "http://a"
