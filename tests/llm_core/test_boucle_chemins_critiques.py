# SPDX-License-Identifier: MIT
"""tests/llm_core/test_boucle_chemins_critiques.py — chemins de la boucle
outillée qu'aucun autre test n'exerçait de bout en bout.

- Variante « optimized » (``run_chat_multi_mcp_v2``) : le sémaphore du moteur
  est pris autour de CHAQUE appel au moteur (boucle, compactions, synthèse)
  et rendu pendant l'exécution des outils.
- Annulation PENDANT un lot d'outils, canal natif et canal texte : le partiel
  émis porte le vrai résultat de l'outil terminé et une sentinelle pour
  l'outil resté en vol, sans rompre l'appariement appel ↔ résultat.
- Stop pendant le tour de synthèse de fin, et pendant l'émission du reste de
  la réponse finale : le partiel est émis avant que l'annulation remonte.
- Exécution d'un lot, par canal : outils sûrs en parallèle, outil mutant
  seul, échec d'un outil rendu au modèle, résultats dans l'ordre du modèle.

Tout est hermétique (faux client HTTP, cf. ``goldens_harness``). Les lots
par canal sont aussi figés en goldens complets (``tests/goldens/boucle_lot_*``,
régénération : ``GOLDEN_UPDATE=1``).
"""
from __future__ import annotations

import asyncio
import json
import threading
from contextlib import asynccontextmanager
from typing import Any, Dict, List

import pytest

from tests.llm_core.ctx_scale_harness import (
    CTX_256K,
    compression_cfg,
    patch_fake_tokenize,
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

SOCLE = "SOCLE CHEMINS CRITIQUES — identité de test stable."

# Vraie ``asyncio.sleep``, capturée à l'import : ``jouer_tour`` remplace
# ``asyncio.sleep`` par un sommeil instantané (backoffs de la boucle). Les
# attentes du TEST lui-même doivent rester de vraies attentes, sinon elles
# deviennent de simples tours de boucle et la fenêtre laissée à l'outil
# rapide (exécuté dans un thread) dépend de la charge de la machine.
_vrai_sleep = asyncio.sleep

_SENTINELLE = "interrompu par l'utilisateur"


def _types(evenements: List[Dict[str, Any]]) -> List[str]:
    return [e.get("type") for e in evenements if isinstance(e, dict)]


def _coupe() -> List[str]:
    return sse_script(appel={"name": "zeta_echo", "arguments": '{"msg": "tron'},
                      finish="length", prompt_tokens=200, completion_tokens=50)


# ── Variante « optimized » : sémaphore inline ──────────────────────────────

class _SemaphoreCompteur:
    """Gestionnaire de concurrence factice : compte prises et libérations,
    et dit à tout instant s'il est tenu."""

    def __init__(self) -> None:
        self.prises: List[Any] = []
        self.liberations = 0
        self.tenu = 0

    def acquire_for(self, model, priority: str = "high"):
        sem = self

        @asynccontextmanager
        async def _cm():
            sem.prises.append((model, priority))
            sem.tenu += 1
            try:
                yield
            finally:
                sem.tenu -= 1
                sem.liberations += 1

        return _cm()


def _semaphore_inline(monkeypatch) -> _SemaphoreCompteur:
    import llm_core._scheduling._engines as _eng

    sem = _SemaphoreCompteur()
    _reel = _eng.scheduling_for
    monkeypatch.setattr(_eng, "scheduling_for", lambda engine: (_reel(engine)[0], sem))
    return sem


def _outils_observant(sem: _SemaphoreCompteur, vu: List[int]) -> Dict[str, Any]:
    outils = builtin_tools()

    def _echo(args):
        vu.append(sem.tenu)
        return json.dumps({"ok": True, "echo": args})

    outils["zeta_echo"] = {**outils["zeta_echo"], "handler": _echo}
    return outils


async def test_v2_semaphore_pris_par_appel_et_rendu_pendant_les_outils(monkeypatch):
    sem = _semaphore_inline(monkeypatch)
    vu: List[int] = []
    fake, ev, final, _m = await jouer_tour(monkeypatch, [
        sse_tool_call("zeta_echo", '{"msg": "ping"}'),
        sse_final("Fini en mode optimisé."),
    ], socle=SOCLE, builtin=_outils_observant(sem, vu), v2=True, priority="low")
    assert final == "Fini en mode optimisé."
    assert sem.prises == [("golden-model", "low")] * 2, "une prise par appel au moteur"
    assert sem.liberations == 2 and sem.tenu == 0
    assert vu == [0], "le sémaphore est rendu pendant l'exécution de l'outil"


async def test_v2_semaphore_couvre_le_tour_de_synthese(monkeypatch):
    sem = _semaphore_inline(monkeypatch)
    vu: List[int] = []
    fake, ev, final, _m = await jouer_tour(monkeypatch, [
        sse_tool_call("zeta_echo", '{"msg": "ok"}'),
        _coupe(), _coupe(), _coupe(),
        sse_final("Synthèse optimisée."),
    ], socle=SOCLE, builtin=_outils_observant(sem, vu), v2=True)
    assert final.startswith("Synthèse optimisée.")
    assert len(sem.prises) == 5, "4 appels de boucle + la synthèse"
    assert sem.liberations == 5 and sem.tenu == 0 and vu == [0]


async def test_v2_semaphore_couvre_les_compactions(monkeypatch):
    """Porte de compaction puis rattrapage d'un dépassement : chaque appel au
    moteur — résumés compris — passe par le sémaphore."""
    compression_cfg(monkeypatch)
    patch_fake_tokenize(monkeypatch)
    sem = _semaphore_inline(monkeypatch)
    msgs: List[Dict[str, Any]] = [{"role": "system", "content": SOCLE}]
    for i in range(4):
        msgs.append({"role": "user", "content": f"question {i} " + "q" * 400})
        msgs.append({"role": "assistant", "content": f"reponse {i} " + "r" * 400})
    msgs.append({"role": "user", "content": "continue"})

    def _panne(i, kw):
        if i == 0:
            raise erreur_http(
                400, '{"error": {"message": "the request exceeds the available context size"}}')
        return None

    fake, ev, final, _m = await jouer_tour(monkeypatch, [
        sse_final("<context>resume apres depassement — faits conserves.</context>"),
        sse_final("Terminé."),
    ], socle=SOCLE, messages=msgs, ctx=CTX_256K, panne=_panne, v2=True)
    assert final == "Terminé."
    assert "compression_start" in _types(ev)
    # appel en échec + résumé du rattrapage + appel relancé
    assert len(sem.prises) == 3 and sem.liberations == 3 and sem.tenu == 0


# ── Annulation pendant un lot d'outils ─────────────────────────────────────

def _outils_lot_interrompu(demarre: asyncio.Event, fini: threading.Event) -> Dict[str, Any]:
    outils = builtin_tools()

    def _rapide(args):
        fini.set()
        return json.dumps({"ok": True, "rapide": True})

    async def _bloque():
        demarre.set()
        await asyncio.Event().wait()

    def _lent(args):
        return _bloque()

    outils["zeta_echo"] = {**outils["zeta_echo"], "handler": _rapide}
    outils["alpha_add"] = {**outils["alpha_add"], "handler": _lent}
    return outils


async def _annuler_pendant_le_lot(monkeypatch, premier_script: List[str]) -> List[Dict[str, Any]]:
    """Lance le tour, attend que l'outil rapide ait rendu son résultat et que
    l'outil lent soit en vol, puis annule la tâche (Stop). Renvoie les
    événements émis."""
    demarre, fini = asyncio.Event(), threading.Event()
    evenements: List[Dict[str, Any]] = []

    async def _cb(ev):
        evenements.append(ev)

    tache = asyncio.ensure_future(jouer_tour(
        monkeypatch, [premier_script, sse_final("jamais atteint")],
        socle=SOCLE, builtin=_outils_lot_interrompu(demarre, fini), on_event=_cb))
    await asyncio.wait_for(demarre.wait(), timeout=10)
    await asyncio.to_thread(fini.wait, 10)
    assert fini.is_set(), "l'outil rapide doit avoir rendu son résultat"
    await _vrai_sleep(0.05)         # le résultat rejoint le lot en cours
    tache.cancel()
    with pytest.raises(asyncio.CancelledError):
        await tache
    return evenements


def _dernier_partiel(evenements: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    partiels = [e for e in evenements if e.get("type") == "tool_history_partial"]
    assert partiels, "un partiel doit être émis avant que l'annulation remonte"
    return partiels[-1]["tool_history"]


def _verifier_partiel_lot(historique: List[Dict[str, Any]]) -> None:
    assistant = [m for m in historique if m.get("role") == "assistant" and m.get("tool_calls")]
    assert len(assistant) == 1
    ids = [tc["id"] for tc in assistant[0]["tool_calls"]]
    noms = [tc["function"]["name"] for tc in assistant[0]["tool_calls"]]
    assert noms == ["zeta_echo", "alpha_add"]
    resultats = {m["tool_call_id"]: m["content"] for m in historique if m.get("role") == "tool"}
    assert set(resultats) == set(ids), "chaque appel a son message tool (appariement complet)"
    assert json.loads(resultats[ids[0]]) == {"ok": True, "rapide": True}
    assert _SENTINELLE in resultats[ids[1]]


async def test_annulation_pendant_un_lot_canal_natif(monkeypatch):
    evenements = await _annuler_pendant_le_lot(monkeypatch, sse_script(appels=[
        {"name": "zeta_echo", "arguments": '{"msg": "vite"}'},
        {"name": "alpha_add", "arguments": '{"a": 1, "b": 2}'},
    ], finish="tool_calls"))
    assert _types(evenements).count("tool_call") == 2
    assert "tool_result" not in _types(evenements), "le post-traitement du lot n'a pas eu lieu"
    _verifier_partiel_lot(_dernier_partiel(evenements))


async def test_annulation_pendant_un_lot_canal_texte(monkeypatch):
    texte = ('<tool_call>\n{"name": "zeta_echo", "arguments": {"msg": "vite"}}\n</tool_call>\n'
             '<tool_call>\n{"name": "alpha_add", "arguments": {"a": 1, "b": 2}}\n</tool_call>')
    evenements = await _annuler_pendant_le_lot(monkeypatch, sse_text(texte))
    assert _types(evenements).count("tool_call") == 2
    assert "tool_result" not in _types(evenements)
    _verifier_partiel_lot(_dernier_partiel(evenements))


# ── Stop pendant la synthèse de fin et pendant le reste de la réponse ──────

async def test_stop_pendant_le_tour_de_synthese(monkeypatch):
    evenements: List[Dict[str, Any]] = []

    async def _cb(ev):
        evenements.append(ev)

    def _panne(i, kw):
        if kw.get("tool_choice") == "none":
            raise asyncio.CancelledError()
        return None

    with pytest.raises(asyncio.CancelledError):
        await jouer_tour(monkeypatch, [
            sse_tool_call("zeta_echo", '{"msg": "ok"}'),
            _coupe(), _coupe(), _coupe(),
            sse_final("jamais atteint"),
        ], socle=SOCLE, panne=_panne, on_event=_cb)
    assert "tool_limit" in _types(evenements)
    historique = _dernier_partiel(evenements)
    resultats = [m for m in historique if m.get("role") == "tool"]
    assert len(resultats) == 1 and json.loads(resultats[0]["content"])["ok"] is True


async def test_stop_pendant_l_emission_du_reste_final(monkeypatch):
    """La réponse courte reste entièrement dans la fenêtre de retenue : elle
    part en fin de tour. Un Stop à ce moment précis doit encore émettre le
    partiel des outils du run."""
    evenements: List[Dict[str, Any]] = []
    etat = {"outil_vu": False, "stoppe": False}

    async def _cb(ev):
        evenements.append(ev)
        if ev.get("type") == "tool_result":
            etat["outil_vu"] = True
        elif (ev.get("type") in ("content_token", "content_replace")
              and etat["outil_vu"] and not etat["stoppe"]):
            etat["stoppe"] = True
            raise asyncio.CancelledError()

    with pytest.raises(asyncio.CancelledError):
        await jouer_tour(monkeypatch, [
            sse_tool_call("zeta_echo", '{"msg": "ok"}'),
            sse_final("Courte réponse."),
        ], socle=SOCLE, on_event=_cb)
    assert etat["stoppe"]
    historique = _dernier_partiel(evenements)
    assert [m["role"] for m in historique] == ["assistant", "tool"]


# ── Exécution d'un lot, par canal ──────────────────────────────────────────

def _outils_lot(trace: Dict[str, Any]) -> Dict[str, Any]:
    """Deux outils sûrs qui ne finissent QUE s'ils tournent ensemble (une
    barrière de 2), un outil mutant (préfixe ``sandbox_``) qui note combien
    d'outils tournaient avec lui, un outil qui échoue."""
    outils = builtin_tools()
    barriere = threading.Barrier(2, timeout=5)
    verrou = threading.Lock()
    actifs = [0]

    def _suivi(nom, fn):
        def _h(args):
            with verrou:
                actifs[0] += 1
                trace.setdefault("ordre", []).append(nom)
            try:
                return fn(args)
            finally:
                with verrou:
                    actifs[0] -= 1
        return _h

    def _echo(args):
        barriere.wait()
        return json.dumps({"ok": True, "echo": args})

    def _add(args):
        barriere.wait()
        return json.dumps({"ok": True, "sum": (args.get("a") or 0) + (args.get("b") or 0)})

    def _marque(args):
        trace["actifs_pendant_mutant"] = actifs[0]
        return json.dumps({"ok": True, "marque": args.get("x")})

    def _echec(args):
        raise RuntimeError("panne simulée de l'outil")

    def _def(nom, props):
        return {"type": "function", "function": {
            "name": nom, "description": f"Outil de test {nom}.",
            "parameters": {"type": "object", "properties": props}}}

    outils["zeta_echo"] = {**outils["zeta_echo"], "handler": _suivi("zeta_echo", _echo)}
    outils["alpha_add"] = {**outils["alpha_add"], "handler": _suivi("alpha_add", _add)}
    outils["sandbox_marque"] = {"definition": _def("sandbox_marque", {"x": {"type": "string"}}),
                                "handler": _suivi("sandbox_marque", _marque)}
    outils["outil_en_echec"] = {"definition": _def("outil_en_echec", {}),
                                "handler": _suivi("outil_en_echec", _echec)}
    return outils


_LOT = [
    ("zeta_echo", '{"msg": "a"}'),
    ("alpha_add", '{"a": 2, "b": 3}'),
    ("sandbox_marque", '{"x": "m"}'),
    ("outil_en_echec", "{}"),
]


def _verifier_lot(fake, evenements, final, trace) -> None:
    assert final == "Lot traité."
    resultats = [e for e in evenements if e.get("type") == "tool_result"]
    assert [e["name"] for e in resultats] == [n for n, _ in _LOT], "ordre du modèle"
    assert json.loads(resultats[1]["result"])["sum"] == 5
    assert trace["actifs_pendant_mutant"] == 1, "l'outil mutant tourne seul"
    assert "panne simulée" in resultats[3]["result"]
    roles = [m["role"] for m in fake.payloads[1]["messages"]]
    assert roles[-4:] == ["tool"] * 4, "les 4 résultats sont rendus au modèle"


async def test_lot_canal_natif(monkeypatch):
    trace: Dict[str, Any] = {}
    fake, ev, final, m = await jouer_tour(monkeypatch, [
        sse_script(appels=[{"name": n, "arguments": a} for n, a in _LOT],
                   finish="tool_calls"),
        sse_final("Lot traité."),
    ], socle=SOCLE, builtin=_outils_lot(trace))
    _verifier_lot(fake, ev, final, trace)
    figer_tour("lot_natif", fake, ev, final, m)


async def test_lot_canal_texte(monkeypatch):
    trace: Dict[str, Any] = {}
    texte = "\n".join(
        f'<tool_call>\n{{"name": "{n}", "arguments": {a}}}\n</tool_call>' for n, a in _LOT)
    fake, ev, final, m = await jouer_tour(monkeypatch, [
        sse_text(texte),
        sse_final("Lot traité."),
    ], socle=SOCLE, builtin=_outils_lot(trace))
    _verifier_lot(fake, ev, final, trace)
    figer_tour("lot_texte", fake, ev, final, m)


# ── Annulation : l'outil en vol finit malgré le Stop ───────────────────────

async def test_annulation_outil_en_vol_qui_finit_quand_meme(monkeypatch):
    """L'outil lent reçoit l'annulation mais termine son effet et rend son
    résultat : le partiel doit porter ce VRAI résultat, pas la sentinelle
    « interrompu » (sinon « Continuer » le rejouerait)."""
    demarre, fini = asyncio.Event(), threading.Event()
    evenements: List[Dict[str, Any]] = []

    async def _cb(ev):
        evenements.append(ev)

    outils = builtin_tools()

    def _rapide(args):
        fini.set()
        return json.dumps({"ok": True, "rapide": True})

    async def _termine_malgre_stop():
        demarre.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            pass
        return json.dumps({"ok": True, "tardif": True})

    outils["zeta_echo"] = {**outils["zeta_echo"], "handler": _rapide}
    outils["alpha_add"] = {**outils["alpha_add"], "handler": lambda args: _termine_malgre_stop()}
    tache = asyncio.ensure_future(jouer_tour(monkeypatch, [
        sse_script(appels=[
            {"name": "zeta_echo", "arguments": '{"msg": "vite"}'},
            {"name": "alpha_add", "arguments": '{"a": 1, "b": 2}'},
        ], finish="tool_calls"),
        sse_final("jamais atteint"),
    ], socle=SOCLE, builtin=outils, on_event=_cb))
    await asyncio.wait_for(demarre.wait(), timeout=10)
    await asyncio.to_thread(fini.wait, 10)
    assert fini.is_set(), "l'outil rapide doit avoir rendu son résultat"
    await _vrai_sleep(0.05)         # le résultat rejoint le lot en cours
    tache.cancel()
    with pytest.raises(asyncio.CancelledError):
        await tache
    historique = _dernier_partiel(evenements)
    resultats = {m["tool_call_id"]: m["content"] for m in historique if m.get("role") == "tool"}
    assert set(resultats) == {"call_1", "call_2"}
    assert json.loads(resultats["call_1"]) == {"ok": True, "rapide": True}
    assert json.loads(resultats["call_2"]) == {"ok": True, "tardif": True}, \
        "le résultat réel de l'outil terminé remplace la sentinelle"
