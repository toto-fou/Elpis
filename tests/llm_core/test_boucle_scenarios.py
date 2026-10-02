# SPDX-License-Identifier: MIT
"""tests/llm_core/test_boucle_scenarios.py — goldens complets de la boucle
outillée (``run_chat_multi_mcp``), un par scénario.

Les goldens historiques ne figent que le payload du chemin natif et la
séquence des TYPES d'événements, à fenêtre inconnue. Ceux-ci figent, pour
chaque scénario, tout ce qu'un découpage de la boucle pourrait altérer sans
bruit :

- le texte final rendu ;
- les événements émis, champ par champ (durées et débits retirés) ;
- les ``metrics`` du tour (même assainissement) ;
- les payloads envoyés au moteur, en entier — ou, pour les scénarios à
  l'échelle dont l'historique pèse des centaines de kilo-octets, leur
  empreinte (rôles, empreinte de chaque message, empreinte globale).

Chaque scénario passe par la VRAIE fonction de flux (faux client HTTP du
harnais) ; les pannes de moteur (réponse vide, hoquet, requête refusée,
dépassement de contexte) sont injectées en enveloppant cette fonction, le
reste de l'appel restant réel.

Régénération volontaire, à faire relire : ``GOLDEN_UPDATE=1
venv/bin/pytest tests/llm_core/test_boucle_scenarios.py`` (seuls les fichiers
``tests/goldens/boucle_*.json`` sont réécrits).
"""
from __future__ import annotations

import json
import time
from typing import Any, Dict, List

import httpx

from tests.llm_core.ctx_scale_harness import (
    CTX_256K,
    compression_cfg,
    patch_fake_tokenize,
    shell_round,
    sse_final_scaled,
    sse_tool_call_scaled,
)
from tests.llm_core.goldens_harness import (
    builtin_tools,
    erreur_http,
    figer_tour,
    jouer_tour,
    sse_final,
    sse_script,
    sse_text,
    sse_tool_call,
)

SOCLE = "SOCLE SCÉNARIOS — identité de test stable, ne pas reformuler."


def _types(evenements: List[Dict[str, Any]]) -> List[str]:
    return [e.get("type") for e in evenements if isinstance(e, dict)]


async def _jouer(monkeypatch, scripts: List[List[str]], **kw):
    return await jouer_tour(monkeypatch, scripts, socle=SOCLE, **kw)


def _historique_outille() -> List[Dict[str, Any]]:
    """Conversation dont un tour précédent a appelé un outil : matière de
    l'aplatissement de l'historique."""
    return [
        {"role": "system", "content": SOCLE},
        {"role": "user", "content": "Premier tour : appelle zeta_echo."},
        {"role": "assistant", "content": None, "tool_calls": [{
            "id": "ancien_1", "type": "function",
            "function": {"name": "zeta_echo", "arguments": '{"msg": "avant"}'}}]},
        {"role": "tool", "tool_call_id": "ancien_1",
         "content": '{"ok": true, "echo": {"msg": "avant"}}'},
        {"role": "assistant", "content": "Fait au tour précédent."},
        {"role": "user", "content": "Continue."},
    ]


# ── Canaux d'appel ─────────────────────────────────────────────────────────

async def test_natif_un_outil(monkeypatch):
    fake, ev, final, m = await _jouer(monkeypatch, [
        sse_tool_call("zeta_echo", '{"msg": "ping"}'),
        sse_final("Voilà, c'est fait."),
    ])
    assert final == "Voilà, c'est fait." and len(fake.payloads) == 2
    assert _types(ev).count("tool_result") == 1
    figer_tour("natif_un_outil", fake, ev, final, m)


async def test_texte_un_outil(monkeypatch):
    fake, ev, final, m = await _jouer(monkeypatch, [
        sse_text('<tool_call>\n{"name": "zeta_echo", "arguments": {"msg": "x"}}\n</tool_call>'),
        sse_final("Fini via le canal texte."),
    ])
    assert final == "Fini via le canal texte."
    assert _types(ev).count("tool_result") == 1
    figer_tour("texte_un_outil", fake, ev, final, m)


async def test_texte_outil_inconnu_purge(monkeypatch):
    """Appel en texte vers un outil inexistant, sans prose autour : le JSON
    est retiré du flux final au lieu d'être affiché."""
    fake, ev, final, m = await _jouer(monkeypatch, [
        sse_text('{"name": "outil_fantome", "arguments": {"x": 1}}'),
        sse_final("Réponse après la tentative."),
    ])
    assert "outil_fantome" not in final
    assert "tool_result" not in _types(ev)
    figer_tour("texte_outil_inconnu_purge", fake, ev, final, m)


async def test_a1_appel_texte_malforme_puis_reponse(monkeypatch):
    fake, ev, final, m = await _jouer(monkeypatch, [
        sse_text('<tool_call>{"name": "zeta_echo", "arguments": {broken}</tool_call>'),
        sse_final("Réparé."),
    ])
    assert final == "Réparé." and len(fake.payloads) == 2
    # Le diagnostic de format est renvoyé au modèle au 2e appel.
    assert fake.payloads[1]["messages"][-1]["role"] == "user"
    figer_tour("a1_appel_texte_malforme", fake, ev, final, m)


async def test_a1bis_appel_perdu_dans_le_raisonnement(monkeypatch):
    fake, ev, final, m = await _jouer(monkeypatch, [
        sse_script(raisonnement="Je vais écrire le fichier.\n</parameter>\n</function>\n</tool_call>"),
        sse_final("Réponse finale en texte."),
    ])
    assert final == "Réponse finale en texte." and len(fake.payloads) == 2
    assert "NO tool call" in fake.payloads[1]["messages"][-1]["content"]
    figer_tour("a1bis_appel_perdu", fake, ev, final, m)


# ── Troncatures ────────────────────────────────────────────────────────────

def _coupe(prompt_tokens: int, completion_tokens: int = 50) -> List[str]:
    return sse_script(appel={"name": "zeta_echo", "arguments": '{"msg": "tron'},
                finish="length", prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens)


async def test_troncature_plafond_generation_puis_synthese(monkeypatch):
    """Un outil abouti, puis trois appels coupés par ``finish=length`` sans
    fenêtre connue : sortie forcée « plafond de génération », tour de
    synthèse sans outils."""
    fake, ev, final, m = await _jouer(monkeypatch, [
        sse_tool_call("zeta_echo", '{"msg": "ok"}'),
        _coupe(200), _coupe(210), _coupe(220),
        sse_final("Synthèse après coupures."),
    ])
    assert final.startswith("Synthèse après coupures.")
    limite = [e for e in ev if e.get("type") == "tool_limit"]
    assert limite and limite[0]["stop_reason"] == "gen_cap"
    assert fake.payloads[-1].get("tool_choice") == "none"
    figer_tour("troncature_plafond_generation", fake, ev, final, m)


async def test_troncature_fenetre_pleine_puis_synthese(monkeypatch):
    """Même chose, fenêtre connue (256k) et pleine à chaque coupure :
    sortie « contexte saturé »."""
    fake, ev, final, m = await _jouer(monkeypatch, [
        sse_tool_call_scaled("zeta_echo", '{"msg": "ok"}', "e1",
                             prompt_tokens=200_000),
        _coupe(255_000, 4_000), _coupe(256_000, 4_000), _coupe(257_000, 4_000),
        sse_final_scaled("Synthèse fenêtre pleine.", prompt_tokens=200_000),
    ], ctx=CTX_256K, compression_enabled=False)
    limite = [e for e in ev if e.get("type") == "tool_limit"]
    assert limite and limite[0]["stop_reason"] == "ctx_saturated"
    figer_tour("troncature_fenetre_pleine", fake, ev, final, m)


def _coupe_texte(prompt_tokens: int) -> List[str]:
    """Appel écrit en TEXTE (dialecte ``<function=…>``) coupé en plein
    argument : le bloc resté ouvert est quand même lu (regex ancrée sur la
    fin du texte), avec un argument incomplet."""
    return sse_script(contenu=("Je lance l'outil.\n<function=zeta_echo>\n"
                               "<parameter=msg>\ntexte coup"),
                      finish="length", prompt_tokens=prompt_tokens,
                      completion_tokens=50)


async def test_troncature_appel_texte(monkeypatch):
    """Canal texte : un appel coupé par ``finish=length`` n'est pas exécuté
    (la prose reste, le modèle est invité à réémettre un appel compact) ; un
    appel lu ensuite remet la série de coupes à zéro ; trois coupes
    d'affilée font sortir la boucle « plafond de génération », tour de
    synthèse sans outils."""
    fake, ev, final, m = await _jouer(monkeypatch, [
        _coupe_texte(200),
        sse_text('<tool_call>\n{"name": "zeta_echo", "arguments": {"msg": "court"}}\n</tool_call>'),
        _coupe_texte(210), _coupe_texte(220), _coupe_texte(230),
        sse_final("Synthèse après coupures en texte."),
    ])
    assert final.startswith("Synthèse après coupures en texte.")
    assert len(fake.payloads) == 6, "la série repart de zéro après l'appel lu"
    resultats = [e for e in ev if e.get("type") == "tool_result"]
    assert [e["name"] for e in resultats] == ["zeta_echo"]
    assert json.loads(resultats[0]["result"])["echo"] == {"msg": "court"}
    limite = [e for e in ev if e.get("type") == "tool_limit"]
    assert limite and limite[0]["stop_reason"] == "gen_cap"
    assert fake.payloads[-1].get("tool_choice") == "none"
    figer_tour("troncature_texte", fake, ev, final, m)


async def test_troncature_coupure_silencieuse(monkeypatch):
    """Flux fermé sans ``finish_reason`` pendant l'émission d'un appel : les
    arguments sont incomplets, l'appel n'est jamais exécuté."""
    fake, ev, final, m = await _jouer(monkeypatch, [
        sse_script(contenu="Je lance l'outil. ",
             appel={"name": "zeta_echo", "arguments": '{"msg": "coup'},
             finish=None),
        sse_final("Reprise après la coupure."),
    ])
    assert "tool_result" not in _types(ev)
    figer_tour("troncature_coupure_silencieuse", fake, ev, final, m)


# ── Reprises automatiques ──────────────────────────────────────────────────

async def test_reprise_du_raisonnement(monkeypatch):
    fake, ev, final, m = await _jouer(monkeypatch, [
        sse_script(raisonnement="Je pèse les options une par une avant de répondre.",
             finish="length", prompt_tokens=300, completion_tokens=900),
        sse_script(raisonnement=" Conclusion : la deuxième.",
             contenu="La deuxième option.", prompt_tokens=1_200),
    ], thinking_mode=True)
    assert final == "La deuxième option." and len(fake.payloads) == 2
    figer_tour("reprise_raisonnement", fake, ev, final, m)


async def test_reprise_de_la_redaction(monkeypatch):
    fake, ev, final, m = await _jouer(monkeypatch, [
        sse_script(contenu="Première partie de la réponse, ",
             finish="length", prompt_tokens=300, completion_tokens=900),
        sse_script(contenu="puis la seconde partie.", prompt_tokens=1_200),
    ])
    assert len(fake.payloads) == 2
    figer_tour("reprise_redaction", fake, ev, final, m)


# ── Pannes du moteur ───────────────────────────────────────────────────────

async def test_reponse_vide_puis_reponse(monkeypatch):
    fake, ev, final, m = await _jouer(
        monkeypatch, [sse_final("Réponse après une enveloppe vide.")],
        panne=lambda i, kw: {"choices": []} if i == 0 else None)
    assert final == "Réponse après une enveloppe vide."
    assert any(e.get("type") == "info" for e in ev)
    figer_tour("reponse_vide_puis_reponse", fake, ev, final, m)


async def test_reponses_vides_en_serie_arret(monkeypatch):
    fake, ev, final, m = await _jouer(
        monkeypatch, [sse_final("jamais servi")],
        panne=lambda i, kw: {"choices": []})
    limite = [e for e in ev if e.get("type") == "tool_limit"]
    assert limite and limite[0]["stop_reason"] == "empty_choices"
    figer_tour("reponses_vides_arret", fake, ev, final, m)


async def test_hoquet_moteur_puis_reponse(monkeypatch):
    def _panne(i, kw):
        if i == 0:
            raise httpx.ConnectError("connexion refusée")
        return None

    fake, ev, final, m = await _jouer(
        monkeypatch, [sse_final("Réponse après le hoquet.")], panne=_panne)
    assert final == "Réponse après le hoquet."
    figer_tour("hoquet_moteur", fake, ev, final, m)


async def test_aplatissement_a_l_iteration_0(monkeypatch):
    def _panne(i, kw):
        if i == 0:
            raise erreur_http(400, '{"error": {"message": "invalid tool history"}}')
        return None

    fake, ev, final, m = await _jouer(
        monkeypatch, [sse_final("Réponse après aplatissement.")],
        messages=_historique_outille(), panne=_panne)
    assert final == "Réponse après aplatissement."
    roles = [x["role"] for x in fake.payloads[0]["messages"]]
    assert "tool" not in roles, "l'historique outillé est aplati en texte"
    figer_tour("aplatissement_iteration_0", fake, ev, final, m)


async def test_erreur_fatale(monkeypatch):
    def _panne(i, kw):
        raise erreur_http(401, '{"error": {"message": "clé refusée"}}')

    fake, ev, final, m = await _jouer(
        monkeypatch, [sse_final("jamais servi")], panne=_panne)
    assert "error" in _types(ev)
    figer_tour("erreur_fatale", fake, ev, final, m)


async def test_mur_d_horloge_puis_synthese(monkeypatch):
    from shared_infra import config as cfg

    monkeypatch.setattr(cfg, "LLAMA_TOOL_LOOP_MAX_S", 0.2)

    def _lent(args):
        time.sleep(0.3)
        return json.dumps({"ok": True, "echo": args})

    outils = builtin_tools()
    outils["zeta_echo"] = {**outils["zeta_echo"], "handler": _lent}
    fake, ev, final, m = await _jouer(monkeypatch, [
        sse_tool_call("zeta_echo", '{"msg": "long"}'),
        sse_final("Synthèse au mur d'horloge."),
    ], builtin=outils)
    limite = [e for e in ev if e.get("type") == "tool_limit"]
    assert limite and limite[0]["stop_reason"] == "wallclock"
    figer_tour("mur_horloge", fake, ev, final, m)


# ── À l'échelle (256k) : compaction et élagage pendant le run ─────────────

def _preambule_pour_compaction() -> List[Dict[str, Any]]:
    msgs: List[Dict[str, Any]] = [{"role": "system", "content": SOCLE}]
    for i in range(4):
        msgs.append({"role": "user", "content": f"question {i} " + "q" * 400})
        msgs.append({"role": "assistant", "content": f"reponse {i} " + "r" * 400})
    msgs.append({"role": "user", "content": "continue le travail outillé"})
    return msgs


async def test_echelle_porte_de_compaction(monkeypatch):
    compression_cfg(monkeypatch)
    patch_fake_tokenize(monkeypatch)
    fake, ev, final, m = await _jouer(monkeypatch, [
        sse_tool_call_scaled("zeta_echo", '{"msg": "avant"}', "e1",
                             prompt_tokens=230_000),
        sse_final("<context>resume scripte — faits conserves.</context>"),
        sse_final_scaled("Terminé après compaction.", prompt_tokens=90_000),
    ], ctx=CTX_256K, messages=_preambule_pour_compaction())
    assert final == "Terminé après compaction." and len(fake.payloads) == 3
    assert "compression_start" in _types(ev)
    figer_tour("echelle_porte_compaction", fake, ev, final, m)


async def test_echelle_depassement_compaction_relance(monkeypatch):
    compression_cfg(monkeypatch)
    patch_fake_tokenize(monkeypatch)

    def _panne(i, kw):
        if i == 0:
            raise erreur_http(
                400, '{"error": {"message": "the request exceeds the available context size"}}')
        return None

    fake, ev, final, m = await _jouer(monkeypatch, [
        sse_final("<context>resume apres depassement.</context>"),
        sse_final_scaled("Terminé après dépassement.", prompt_tokens=80_000),
    ], ctx=CTX_256K, messages=_preambule_pour_compaction(), panne=_panne)
    assert final == "Terminé après dépassement."
    assert "compression_start" in _types(ev)
    figer_tour("echelle_depassement_compaction", fake, ev, final, m)


async def test_echelle_elagage_pendant_le_run(monkeypatch):
    compression_cfg(monkeypatch, COMPRESSION_ENABLED=False)
    msgs: List[Dict[str, Any]] = [
        {"role": "system", "content": SOCLE},
        {"role": "user", "content": "reprends la longue tache"},
    ]
    for i in range(24):
        msgs += shell_round(i, 30_000)
    fake, ev, final, m = await _jouer(monkeypatch, [
        sse_tool_call_scaled("zeta_echo", '{"msg": "a"}', "e1",
                             prompt_tokens=150_000),
        sse_final_scaled("Fini.", prompt_tokens=152_000),
    ], ctx=CTX_256K, messages=msgs)
    assert final == "Fini."
    assert "prune_state" in _types(ev)
    figer_tour("echelle_elagage_en_cours", fake, ev, final, m)
