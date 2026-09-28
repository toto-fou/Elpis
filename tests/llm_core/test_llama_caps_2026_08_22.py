# SPDX-License-Identifier: MIT
"""tests/llm_core/test_llama_caps_2026_08_22.py — rétrocompatibilité moteur.

Les capacités câblées en août 2026 (flux reprenable, progression du
pré-remplissage, contrôle du raisonnement, API ``/models``, sonde sans
chargement) ont toutes été vérifiées sur llama.cpp b10545. Rien ne garantit
que le serveur en face soit celui-là.

Ce que ces tests verrouillent :

  1. la lecture du build depuis ``/props`` (``build_info``) et le mode routeur
     (``role``) — les deux seules sources, aucune devinette ;
  2. l'ASYMÉTRIE délibérée : une ROUTE exige la preuve (se tromper coûte un
     aller-retour perdu à chaque occasion), un CHAMP de corps garde le
     bénéfice du doute (llama.cpp ignore un champ inconnu sans erreur, donc
     l'envoyer ne coûte rien et le retirer coûterait une fonctionnalité) ;
  3. un build ancien retombe sur le comportement historique — c'est la
     propriété demandée : ne rien tenter qui ne puisse marcher ;
  4. le mode ROUTEUR est une preuve directe, pas une déduction : un build
     récent lancé en mono-modèle n'a pas les routes ``/models`` ;
  5. le cache a un TTL (un cache de ``/props`` SANS TTL a déjà été la racine
     de 400 intermittents, audit 2026-08-21).

Aucun réseau : ``/props`` est simulé.
"""
from __future__ import annotations

import pytest

from llm_core.providers import llama_caps as lc


@pytest.fixture(autouse=True)
def sonde_vierge():
    lc.invalidate()
    yield
    lc.invalidate()


def _props(build="b10545-a30273376", role="router"):
    """Fabrique une réponse ``/props`` et branche le client d'administration."""
    class _Resp:
        status_code = 200

        def json(self):
            d = {"build_info": build} if build is not None else {}
            if role:
                d["role"] = role
            return d

    class _Client:
        calls = 0

        async def get(self, url, timeout=None):
            _Client.calls += 1
            return _Resp()

    return _Client()


# ─────────────────────────────────────────────────────────────────────────────
#  1 — lecture du build
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("brut,attendu", [
    ("b10545-a30273376", 10545),
    ("b6120", 6120),
    ("b10545", 10545),
    ("", 0),
    (None, 0),
    ("inconnu", 0),
    (12345, 0),          # pas de préfixe « b » : illisible, pas un numéro
])
def test_lecture_du_numero_de_build(brut, attendu):
    assert lc.parse_build(brut) == attendu


# ─────────────────────────────────────────────────────────────────────────────
#  2-3 — l'asymétrie routes / champs de corps
# ─────────────────────────────────────────────────────────────────────────────
def test_moteur_non_identifie_le_partage_entre_preuve_et_doute():
    """Sonde inaboutie. Ce qui change le CONTRAT ne se tente pas ; ce qui est
    INERTE quand ce n'est pas supporté continue de partir — le retirer
    coûterait une fonctionnalité sur un moteur parfaitement capable."""
    caps = lc.UNKNOWN
    # Preuve exigée : nommer un flux engage reprise ET annulation.
    assert caps.resumable_stream is False
    # Preuve exigée, et c'est le mode routeur qui la donne.
    assert caps.models_api is False
    assert caps.models_sse is False

    # Inertes s'ils ne sont pas compris : champs de corps, paramètre d'URL,
    # et le contrôle du raisonnement (une requête par clic, refus déjà traduit
    # en repli côté client).
    assert caps.payload_return_progress is True
    assert caps.payload_sse_ping is True
    assert caps.payload_reasoning_control is True
    assert caps.reasoning_control is True
    assert caps.autoload_param is True


def test_build_ancien_tout_retombe_sur_lhistorique():
    """LA propriété demandée : un llama.cpp d'il y a six mois ne doit rien
    recevoir de neuf, ni en route ni en corps de requête."""
    caps = lc.EngineCaps(known=True, build=9000, is_router=True)
    assert caps.resumable_stream is False
    assert caps.reasoning_control is False
    assert caps.models_sse is False
    assert caps.autoload_param is False
    assert caps.payload_return_progress is False
    assert caps.payload_sse_ping is False
    assert caps.payload_reasoning_control is False
    # ``/models`` existe dès qu'il y a un routeur — c'est une preuve directe,
    # indépendante du numéro de build.
    assert caps.models_api is True


def test_build_recent_routeur_tout_est_disponible():
    caps = lc.EngineCaps(known=True, build=lc.MIN_BUILD_RESUMABLE_STREAM,
                         is_router=True)
    assert caps.resumable_stream is True
    assert caps.reasoning_control is True
    assert caps.models_api is True
    assert caps.models_sse is True
    assert caps.autoload_param is True


# ─────────────────────────────────────────────────────────────────────────────
#  4 — le routeur est une preuve, pas une déduction
# ─────────────────────────────────────────────────────────────────────────────
def test_build_recent_mono_modele_pas_dapi_de_modeles():
    """Un b10545 lancé SANS routeur n'expose ni ``/models``, ni ``/models/sse``,
    ni ``autoload``. Le déduire du numéro de build donnerait trois 404 par
    tour."""
    caps = lc.EngineCaps(known=True, build=99999, is_router=False)
    assert caps.models_api is False
    assert caps.models_sse is False
    # Ce qui ne dépend pas du routeur, lui, reste disponible.
    assert caps.resumable_stream is True
    assert caps.reasoning_control is True
    # ⚠ ``autoload`` ne dépend PAS du routeur : hors routeur il n'y a rien à
    # charger, le paramètre est simplement ignoré. L'exiger reviendrait à
    # laisser une sonde charger 27 Go dès que le mode est mal détecté.
    assert caps.autoload_param is True


# ─────────────────────────────────────────────────────────────────────────────
#  5 — sonde, cache et TTL
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_sonde_lit_props_et_met_en_cache(monkeypatch):
    import llm_core._llama_http as lh
    client = _props()
    type(client).calls = 0
    monkeypatch.setattr(lh, "_get_admin_client", lambda: client, raising=False)

    caps = await lc.engine_caps("http://x:8080/v1/chat/completions")
    assert (caps.known, caps.build, caps.is_router) == (True, 10545, True)
    assert type(client).calls == 1

    await lc.engine_caps("http://x:8080/v1/chat/completions")
    assert type(client).calls == 1, "le second appel doit sortir du cache"

    await lc.engine_caps("http://x:8080/v1/chat/completions", force=True)
    assert type(client).calls == 2, "force=True doit resonder"


@pytest.mark.asyncio
async def test_le_cache_expire(monkeypatch):
    """⚠ Un cache de /props SANS TTL a déjà été la racine de 400
    intermittents : un serveur redémarré sur un autre modèle gardait
    éternellement les capacités de l'ancien."""
    import llm_core._llama_http as lh
    client = _props()
    type(client).calls = 0
    monkeypatch.setattr(lh, "_get_admin_client", lambda: client, raising=False)
    monkeypatch.setattr(lc, "CAPS_TTL_S", 0.0)

    await lc.engine_caps("http://x:8080")
    await lc.engine_caps("http://x:8080")
    assert type(client).calls == 2


@pytest.mark.asyncio
async def test_moteur_injoignable_ne_leve_jamais(monkeypatch):
    import llm_core._llama_http as lh

    class _KO:
        async def get(self, url, timeout=None):
            raise OSError("connexion refusée")

    monkeypatch.setattr(lh, "_get_admin_client", lambda: _KO(), raising=False)
    caps = await lc.engine_caps("http://absent:9999")
    assert caps.known is False
    assert caps.resumable_stream is False


@pytest.mark.asyncio
async def test_props_sans_build_info_reste_inconnu(monkeypatch):
    """Un serveur OpenAI-compatible qui n'est pas llama.cpp répond à /props
    sans ``build_info`` : on ne doit rien lui supposer."""
    import llm_core._llama_http as lh
    monkeypatch.setattr(lh, "_get_admin_client",
                        lambda: _props(build=None, role=""), raising=False)
    caps = await lc.engine_caps("http://autre:8080")
    assert caps.known is False


@pytest.mark.asyncio
async def test_la_sonde_ne_charge_aucun_modele(monkeypatch):
    """⚠ Invariant model-select-no-autoload : ``/props`` NU ne porte pas de
    ``model=``, donc ne déclenche aucun chargement."""
    import llm_core._llama_http as lh
    vues = []

    class _C:
        async def get(self, url, timeout=None):
            vues.append(url)
            return _props().__class__ and type("R", (), {
                "status_code": 200,
                "json": lambda self: {"build_info": "b10545", "role": "router"},
            })()

    monkeypatch.setattr(lh, "_get_admin_client", lambda: _C(), raising=False)
    await lc.engine_caps("http://x:8080/v1/chat/completions")
    assert vues == ["http://x:8080/props"]
    assert "model=" not in vues[0]
