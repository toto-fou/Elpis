# SPDX-License-Identifier: MIT
"""Correctifs issus de l'audit EN DIRECT des sous-agents (2026-08-08).

Les constats viennent d'exécutions RÉELLES du casting (explore / verify /
implement / reprise) contre le connecteur de l'utilisateur, pas d'une lecture
de code — d'où la précision des chiffres cités.

1. PRÉFLIGHT LLM — ``verify_llm_availability`` sondait ``LLAMA_URL`` EN DUR,
   quelle que soit la cible résolue. Elle est appelée en tête de CHAQUE tour :
   sur un déploiement sans moteur local (ou moteur arrêté), tout utilisateur
   basculé sur un connecteur EXTERNE voyait chacun de ses messages échouer
   instantanément sur « Serveur LLM injoignable », alors que son connecteur
   répondait. C'est le premier mur rencontré en tentant de lancer un agent.

2. ``list_files(exclude=…)`` — le motif n'était confronté qu'au chemin relatif
   COMPLET et au nom de l'entrée. ``exclude=['node_modules']`` (l'exemple
   canonique de la docstring de l'outil) n'écartait donc QUE l'entrée du
   dossier : tout son contenu passait. Un agent qui tentait de se protéger d'un
   flot de contexte n'y parvenait pas.

3. Socle d'exclusions par défaut — mesuré en direct : un ``explore`` appelant
   ``list_files(include_hidden=True)`` sans ``exclude`` a ramené 500 chemins de
   ``.venv/…/site-packages`` : +9 000 tokens de contexte en UN appel, re-facturés
   à chaque itération. L'omission est SIGNALÉE (``excluded_default``) — jamais
   silencieuse.
"""
import fnmatch

import pytest

from llm_core.tools.fs_tools import DEFAULT_DEP_EXCLUDES


# ── 1. Préflight de joignabilité : la CIBLE, pas le moteur local ─────────

@pytest.fixture
def _probe(monkeypatch):
    """Capture l'URL réellement sondée par verify_llm_availability."""
    import llm_core._health as H
    seen = {}

    class _C:
        # AUDIT 2026-08-23 — ``timeout=`` capturé : la sonde n'en passait
        # AUCUN et héritait donc des 600 s du client (toutes les autres du
        # module bornent à 3 s). Sur un moteur qui accepte le TCP sans
        # répondre, six tours vidaient le pool local.
        async def get(self, url, timeout=None):
            seen["url"] = url
            seen["timeout"] = timeout
            if seen.get("fail"):
                raise OSError("injoignable")
            return None

    client = _C()

    # ``base`` capturée : le client doit être celui de la CIBLE. Le client
    # partagé du llama-server local n'a que 6 connexions — un fournisseur
    # lent ne doit pas les consommer.
    def _client(base=None):
        seen["client_base"] = base
        return client

    monkeypatch.setattr(H, "_get_llm_client", _client)
    monkeypatch.setattr(H, "LLAMA_URL", "http://127.0.0.1:8080/v1/chat/completions")
    # AUDIT 2026-08-31 — la sonde est désormais cachée par base_url (TTL
    # court) : un succès d'un test précédent court-circuiterait la sonde du
    # suivant. Chaque test part d'un cache vide.
    H._preflight_ok_at.clear()
    return H, seen


async def test_moteur_local_sonde_llama_url(_probe, monkeypatch):
    H, seen = _probe
    from llm_core._target import LlmTarget, use_llm_target
    with use_llm_target(LlmTarget(is_default=True)):
        await H.verify_llm_availability()
    assert seen["url"].startswith("http://127.0.0.1:8080")
    assert seen["timeout"] == 3.0, "la sonde de chaque tour doit être BORNÉE"
    assert seen["client_base"] is None, "le moteur local garde son client partagé"


async def test_connecteur_externe_sonde_le_connecteur(_probe):
    """LE bug : c'est la base_url du connecteur qui doit être sondée."""
    H, seen = _probe
    from llm_core._target import LlmTarget, use_llm_target
    tgt = LlmTarget(is_default=False, base_url="https://api.moonshot.ai/v1",
                    provider_type="moonshot", model="kimi-k3")
    with use_llm_target(tgt):
        await H.verify_llm_availability()
    assert "moonshot.ai" in seen["url"], \
        "le préflight sonde toujours le moteur LOCAL : un connecteur externe " \
        "est inutilisable dès que le llama-server local est arrêté"
    assert "127.0.0.1" not in seen["url"]
    assert seen["timeout"] == 3.0
    assert seen["client_base"] and "moonshot.ai" in seen["client_base"], (
        "le préflight d'un connecteur externe emprunte encore le pool du "
        "llama-server LOCAL — un fournisseur lent y fige les chats locaux")


async def test_message_d_erreur_designe_le_bon_serveur(_probe):
    """« Serveur LLM injoignable » envoyait diagnostiquer le mauvais composant."""
    H, seen = _probe
    seen["fail"] = True
    from llm_core._target import LlmTarget, use_llm_target
    tgt = LlmTarget(is_default=False, base_url="https://api.moonshot.ai/v1")
    with use_llm_target(tgt):
        with pytest.raises(Exception) as ei:
            await H.verify_llm_availability()
    msg = str(ei.value)
    assert "onnecteur" in msg and "moonshot.ai" in msg, msg


async def test_connecteur_sans_base_url_ne_bloque_pas(_probe):
    """Rien à sonder → on laisse l'adaptateur du provider remonter l'erreur,
    bien plus précise qu'un préflight aveugle."""
    H, seen = _probe
    seen["fail"] = True
    from llm_core._target import LlmTarget, use_llm_target
    with use_llm_target(LlmTarget(is_default=False, base_url="")):
        await H.verify_llm_availability()          # ne doit PAS lever


async def test_moteur_local_injoignable_leve_toujours(_probe):
    """Non-régression : le cas historique reste inchangé."""
    H, seen = _probe
    seen["fail"] = True
    from llm_core._target import LlmTarget, use_llm_target
    with use_llm_target(LlmTarget(is_default=True)):
        with pytest.raises(Exception, match="Serveur LLM injoignable"):
            await H.verify_llm_availability()


# ── 2. exclude= doit écarter le SOUS-ARBRE ───────────────────────────────

def _excluded(rel, name, pats, include_hidden=True):
    """Réplique la logique de list_files._excluded (hors règle dotfile)."""
    segs = rel.split("/")
    for pat in pats:
        if fnmatch.fnmatch(rel, pat) or fnmatch.fnmatch(name, pat):
            return True
        if any(fnmatch.fnmatch(s, pat) for s in segs):
            return True
    return False


@pytest.mark.parametrize("rel,name", [
    ("node_modules", "node_modules"),
    ("node_modules/pkg/index.js", "index.js"),
    ("src/node_modules/a/b.js", "b.js"),
    ("app/.venv/lib/python3.11/site-packages/x.py", "x.py"),
])
def test_exclude_ecarte_tout_le_sous_arbre(rel, name):
    assert _excluded(rel, name, ["node_modules", "site-packages"]), \
        f"{rel} non exclu — exclude= ne protège que l'entrée du dossier"


def test_exclude_glob_toujours_supporte():
    assert _excluded("src/a.pyc", "a.pyc", ["*.pyc"])
    assert not _excluded("src/a.py", "a.py", ["*.pyc"])


def test_exclude_n_ecarte_pas_un_nom_partiel():
    """``node`` ne doit pas emporter ``node_modules_helper`` ni ``mynode``."""
    assert not _excluded("mynode/x.js", "x.js", ["node"])
    assert not _excluded("node_modules_helper/x.js", "x.js", ["node"])


# ── 3. Socle d'exclusions par défaut, SIGNALÉ ────────────────────────────

def test_socle_couvre_les_gouffres_a_contexte_mesures():
    for d in ("node_modules", "site-packages", ".venv", "__pycache__"):
        assert d in DEFAULT_DEP_EXCLUDES, d


def test_socle_n_exclut_pas_git():
    """``.git`` est légitimement inspecté (agent explore = historique git) et
    déjà couvert par le défaut ``include_hidden=False``."""
    assert ".git" not in DEFAULT_DEP_EXCLUDES


def test_le_socle_est_annonce_dans_la_reponse():
    """Une omission silencieuse ferait conclure au modèle que les fichiers
    n'existent pas — même faute que la troncature d'arbre non signalée."""
    import inspect
    from llm_core.tools import fs_tools
    src = inspect.getsource(fs_tools)
    i = src.index('_ok(action="list"')
    corps = src[i:i + 1200]
    assert "excluded_default" in corps
    assert "hint_excluded" in corps


def test_socle_ignore_si_l_appelant_precise_exclude():
    """Un ``exclude`` explicite doit rester la seule règle : sinon on
    ajouterait en douce des exclusions que l'appelant n'a pas demandées."""
    import inspect
    from llm_core.tools import fs_tools
    src = inspect.getsource(fs_tools)
    i = src.index("_default_excl =")
    corps = src[i:i + 400]
    assert "exclude or []" in corps and "DEFAULT_DEP_EXCLUDES" in corps
