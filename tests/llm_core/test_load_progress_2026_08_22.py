# SPDX-License-Identifier: MIT
"""tests/llm_core/test_load_progress_2026_08_22.py — progression RÉELLE du
chargement d'un modèle.

Le widget de file annonçait « Chargement de X… » avec une barre ANIMÉE sur une
durée estimée : une invention, qui finissait figée à 100 % pendant que le
modèle montait encore en VRAM. llama.cpp branche pourtant le vrai callback de
chargement et pousse un échantillon toutes les 200 ms sur ``/models/sse``.

Les lignes rejouées ci-dessous sont une CAPTURE RÉELLE (2026-08-22, routeur
b10545, chargement d'un 27B puis d'un 9B) — pas une reconstitution : c'est ce
qui garantit qu'on lit la vraie forme, y compris ses irrégularités.

Ce que ces tests verrouillent :

  1. la progression est rapportée telle quelle (0-100, étape nommée) et
     ``watch_load`` rend ``True`` sur ``loaded`` ;
  2. ⚠ **aucun instantané n'est émis à la connexion** — un abonnement ouvert
     alors que le modèle est DÉJÀ chargé n'entendrait rien, jamais. La
     re-vérification après ouverture ferme cette course ;
  3. un moteur sans ``/models/sse`` (trop ancien, ou hors routeur) rend
     ``None`` SANS ouvrir de connexion : l'appelant garde son estimation ;
  4. un échec de chargement rend ``False`` ;
  5. la progression de TÉLÉCHARGEMENT (octets, par fichier) est agrégée — un
     premier usage commence par récupérer le GGUF, et « chargement » y serait
     un mensonge de plusieurs minutes ;
  6. les événements d'un AUTRE modèle sont ignorés.

Aucun réseau : le flux est rejoué.
"""
from __future__ import annotations

import pytest

from llm_core.providers import llama_caps as lc
from llm_core.providers import llama_models as lm

MODELE = "Qwen3.8-27B-long"

#: Capture réelle, abrégée (36 échantillons à l'origine, monotones de 0 à 100).
CAPTURE = [
    'data: {"model":"Qwen3.8-27B-long","event":"model_status","data":{"status":"loading"}}',
    '',
    'data: {"model":"Qwen3.8-27B-long","event":"status_change","data":{"status":"loading","progress":{"stages":["text_model"],"current":"text_model","value":0.0}}}',
    '',
    'data: {"model":"Qwen3.8-27B-long","event":"status_change","data":{"status":"loading","progress":{"stages":["text_model"],"current":"text_model","value":0.4222}}}',
    '',
    'data: {"model":"Qwen3.8-27B-long","event":"status_change","data":{"status":"loading","progress":{"stages":["text_model"],"current":"text_model","value":0.958681046962738}}}',
    '',
    'data: {"model":"Qwen3.8-27B-long","event":"status_change","data":{"status":"loading","progress":{"stages":["text_model"],"current":"text_model","value":1.0}}}',
    '',
    'data: {"model":"Qwen3.8-27B-long","event":"status_change","data":{"status":"loaded","info":{"id":"Qwen3.8-27B-long","meta":{"n_ctx":65536,"n_params":27320697856}}}}',
    '',
]


class _Resp:
    def __init__(self, lignes, status=200):
        self._lignes = lignes
        self.status_code = status

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def aiter_lines(self):
        for l in self._lignes:
            yield l


class _Client:
    def __init__(self, lignes, status=200):
        self._lignes, self._status = lignes, status
        self.ouvertures = 0
        self.fermetures = 0

    # Client DÉDIÉ (audit 2026-08-23) : ``watch_load`` le referme lui-même —
    # sinon chaque suivi laisserait une connexion derrière lui.
    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        self.fermetures += 1
        return False

    def stream(self, method, url, **kw):
        self.ouvertures += 1
        return _Resp(self._lignes, self._status)


@pytest.fixture()
def moteur(monkeypatch):
    """Routeur récent, modèle pas encore chargé, flux rejoué."""
    import llm_core._llama_http as lh

    recent = lc.EngineCaps(known=True, build=lc.MIN_BUILD_MODELS_SSE,
                           is_router=True)

    async def _caps(base_url="", force=False):
        return recent

    monkeypatch.setattr(lc, "engine_caps", _caps, raising=True)

    async def _pas_charge(model, base_url="", *, force=False):
        return False

    monkeypatch.setattr(lm, "is_loaded", _pas_charge, raising=True)

    def _installer(lignes, status=200):
        # AUDIT 2026-08-23 — ``watch_load`` n'emprunte plus le client admin
        # PARTAGÉ (8 connexions, partagées avec /props, /tokenize et
        # /apply-template) : un flux de 600 s y saturait le pool et faisait
        # tomber tout le monitoring en PoolTimeout. Il ouvre un client dédié
        # via ``_new_sse_client`` — c'est donc lui qu'on remplace ici.
        c = _Client(lignes, status)
        monkeypatch.setattr(lm, "_new_sse_client", lambda _t: c, raising=True)
        return c

    return _installer


# ─────────────────────────────────────────────────────────────────────────────
#  1 — la progression réelle remonte
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_la_progression_reelle_remonte_puis_charge(moteur):
    moteur(CAPTURE)
    vus = []

    async def on_prog(stage, pct, stages):
        vus.append((stage, pct, tuple(stages)))

    res = await lm.watch_load(MODELE, "http://x:8080", on_prog)
    assert res is True

    pcts = [p for _s, p, _st in vus if p is not None]
    assert pcts == sorted(pcts), "la progression doit être monotone"
    assert pcts[0] == 0.0 and pcts[-1] == 100.0
    assert all(s == "text_model" for s, p, _ in vus if p is not None)
    assert vus[-1][2] == ("text_model",)


@pytest.mark.asyncio
async def test_letape_sans_pourcentage_est_toleree(moteur):
    """⚠ Le premier message d'état ne porte PAS de ``value`` ; une variante
    émise à l'entrée de l'étape mmproj non plus (clé ``stage`` au singulier).
    Un lecteur qui l'exigerait planterait au tout premier événement."""
    moteur([
        'data: {"model":"M","event":"model_status","data":{"status":"loading"}}',
        'data: {"model":"M","event":"status_change","data":{"status":"loading","progress":{"stage":"mmproj_model"}}}',
        'data: {"model":"M","event":"status_change","data":{"status":"loaded","info":{}}}',
    ])
    vus = []

    async def on_prog(stage, pct, stages):
        vus.append((stage, pct))

    assert await lm.watch_load("M", "http://x:8080", on_prog) is True
    assert ("", None) in vus or ("mmproj_model", None) in vus


# ─────────────────────────────────────────────────────────────────────────────
#  2 — la course de l'abonnement tardif
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_modele_deja_charge_rend_true_sans_attendre(moteur, monkeypatch):
    """⚠ Le flux n'émet AUCUN instantané à la connexion : sans cette
    re-vérification, on attendrait jusqu'au délai un événement qui ne viendra
    jamais."""
    vus_force = []

    async def _deja(model, base_url="", *, force=False):
        vus_force.append(force)
        return True

    monkeypatch.setattr(lm, "is_loaded", _deja, raising=True)
    # Flux VIDE : rien à consommer, et pourtant la réponse doit être immédiate.
    moteur([])
    assert await lm.watch_load(MODELE, "http://x:8080", None) is True
    # AUDIT 2026-08-23 — la re-vérification doit contourner le cache de 3 s de
    # ``model_statuses`` : plusieurs suivis lancés en rafale lisaient sinon un
    # inventaire périmé, rataient la course et tenaient leur connexion
    # jusqu'au délai complet.
    assert vus_force == [True], vus_force


# ─────────────────────────────────────────────────────────────────────────────
#  3 — rétrocompatibilité : rien à tenter
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_moteur_ancien_aucune_connexion_ouverte(monkeypatch):
    import llm_core._llama_http as lh

    async def _vieux(base_url="", force=False):
        return lc.EngineCaps(known=True, build=9000, is_router=True)

    monkeypatch.setattr(lc, "engine_caps", _vieux, raising=True)
    c = _Client(CAPTURE)
    monkeypatch.setattr(lh, "_get_admin_client", lambda: c, raising=False)

    assert await lm.watch_load(MODELE, "http://x:8080", None) is None
    assert c.ouvertures == 0, (
        "un moteur sans /models/sse ne doit pas être sollicité — l'appelant "
        "retombe sur son estimation")


@pytest.mark.asyncio
async def test_hors_routeur_aucun_suivi(monkeypatch):
    import llm_core._llama_http as lh

    async def _mono(base_url="", force=False):
        return lc.EngineCaps(known=True, build=99999, is_router=False)

    monkeypatch.setattr(lc, "engine_caps", _mono, raising=True)
    c = _Client(CAPTURE)
    monkeypatch.setattr(lh, "_get_admin_client", lambda: c, raising=False)
    assert await lm.watch_load(MODELE, "http://x:8080", None) is None
    assert c.ouvertures == 0


# ─────────────────────────────────────────────────────────────────────────────
#  4-6 — échec, téléchargement, autre modèle
# ─────────────────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_chargement_echoue_rend_false(moteur):
    moteur([
        'data: {"model":"M","event":"status_change","data":{"status":"loading","progress":{"stages":["text_model"],"current":"text_model","value":0.3}}}',
        'data: {"model":"M","event":"status_change","data":{"status":"unloaded","exit_code":1}}',
    ])
    assert await lm.watch_load("M", "http://x:8080", None) is False


@pytest.mark.asyncio
async def test_le_telechargement_est_agrege_et_nomme(moteur):
    """Plusieurs fichiers en vol : c'est la somme des octets qui fait sens,
    pas le dernier fichier vu."""
    moteur([
        'data: {"model":"M","event":"download_progress","data":{"progress":{"a.gguf":{"done":50,"total":100},"b.gguf":{"done":50,"total":100}}}}',
        'data: {"model":"M","event":"status_change","data":{"status":"loaded","info":{}}}',
    ])
    vus = []

    async def on_prog(stage, pct, stages):
        vus.append((stage, pct))

    assert await lm.watch_load("M", "http://x:8080", on_prog) is True
    assert vus[0] == ("download", 50.0)


def test_agregation_du_telechargement_sans_total():
    """Total inconnu ⇒ pas de pourcentage inventé."""
    assert lm._download_pct({"a": {"done": 5, "total": 0}}) is None
    assert lm._download_pct({}) is None
    assert lm._download_pct(None) is None
    assert lm._download_pct({"a": {"done": 1, "total": 4}}) == 0.25


@pytest.mark.asyncio
async def test_les_evenements_dun_autre_modele_sont_ignores(moteur):
    """Le canal est GLOBAL : un chargement déclenché par un autre utilisateur
    ne doit pas piloter notre barre."""
    moteur([
        'data: {"model":"AUTRE","event":"status_change","data":{"status":"loading","progress":{"stages":["text_model"],"current":"text_model","value":0.9}}}',
        'data: {"model":"AUTRE","event":"status_change","data":{"status":"loaded","info":{}}}',
        'data: {"model":"M","event":"status_change","data":{"status":"loading","progress":{"stages":["text_model"],"current":"text_model","value":0.1}}}',
        'data: {"model":"M","event":"status_change","data":{"status":"loaded","info":{}}}',
    ])
    vus = []

    async def on_prog(stage, pct, stages):
        vus.append(pct)

    assert await lm.watch_load("M", "http://x:8080", on_prog) is True
    assert vus == [10.0], "seuls les événements de NOTRE modèle comptent"
