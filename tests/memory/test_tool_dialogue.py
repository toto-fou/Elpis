# SPDX-License-Identifier: MIT
"""Dialogue outil ``memory`` → LLM : les enveloppes d'échec sont détectées
comme erreurs par la boucle d'outils, le scénario de récupération guidée
(no_match → closest → replace par id) converge, et le résultat reste compact
(garde anti-bruit : extraits tronqués, pas le store complet)."""
from __future__ import annotations

import json

import pytest

from llm_core.tools.memory_tools import MemoryResult


class FakeMCP:
    def __init__(self):
        self.tools = {}

    def tool(self, **kw):
        def deco(fn):
            self.tools[fn.__name__] = fn
            return fn
        return deco

    def resource(self, *a, **kw):
        return lambda fn: fn

    def prompt(self, *a, **kw):
        return lambda fn: fn


class FakeRC:
    def __init__(self, meta):
        self.meta = meta


class FakeCtx:
    def __init__(self, **meta):
        self.request_context = FakeRC(meta)

    async def info(self, *a, **k):
        pass

    async def debug(self, *a, **k):
        pass


@pytest.fixture
def memory_tool(tmp_path):
    from llm_core.tools import memory_tools
    m = FakeMCP()
    memory_tools.register(m, tmp_path)
    return m.tools["memory"], tmp_path


# ── Détection d'erreur par la boucle d'outils ────────────────────────────────

def test_result_is_error_on_soft_failure():
    from llm_core.engine.result_contract import result_is_error as _result_is_error
    bad = MemoryResult(ok=False, error="no_match",
                       message="aucune entrée ne correspond").model_dump_json()
    good = MemoryResult(ok=True, action="add").model_dump_json()
    assert _result_is_error(bad) is True
    assert _result_is_error(good) is False


def test_result_is_error_on_err_envelope():
    from llm_core.engine.result_contract import result_is_error as _result_is_error
    from llm_core.tools._models import ErrEnvelope
    env = ErrEnvelope(error="target_required", message="replace exige target",
                      fix="Passe target = l'id.").model_dump_json()
    assert _result_is_error(env) is True


# ── Scénario réel : échec guidé → correction par id → succès ────────────────

async def test_guided_recovery_no_match_then_id(memory_tool):
    memory, _ = memory_tool
    ctx = FakeCtx(username="loop", chat_id="c1")
    await memory(ctx, action="add", store="memory",
                 content="l'utilisateur préfère des réponses concises et directes")
    await memory(ctx, action="add", store="memory",
                 content="le projet cible python 3.12 et sqlite")

    # 1er essai : paraphrase (le mode d'échec réel n°1) → no_match guidé
    r1 = await memory(ctx, action="replace", store="memory",
                      target="préfère les réponse concise",
                      content="l'utilisateur préfère des réponses très concises")
    assert not r1.ok and r1.error == "no_match"
    assert r1.closest and r1.closest.startswith("[")

    # 2e essai : le modèle recopie l'id proposé par closest → succès
    eid = r1.closest.split("]")[0].lstrip("[")
    r2 = await memory(ctx, action="replace", store="memory",
                      target=f"[{eid}]",
                      content="l'utilisateur préfère des réponses très concises")
    assert r2.ok and r2.id                     # succès court : id de l'entrée écrite
    assert not hasattr(r2, "entries")          # plus de miroir du magasin en succès


# ── Garde anti-bruit : résultat compact même store plein ────────────────────

async def test_failure_payload_stays_compact_on_full_store(memory_tool, monkeypatch):
    memory, root = memory_tool
    from llm_core.tools import memory_tools
    monkeypatch.setattr(memory_tools, "_memory_limits", lambda: (2200, 1375))
    ctx = FakeCtx(username="full", chat_id="c1")
    # ~12 entrées de ~170c = store quasi plein
    total = 0
    for i in range(12):
        text = f"fait numero {i} : " + ("lorem ipsum dolor sit amet " * 6)
        text = text[:168]
        r = await memory(ctx, action="add", store="memory", content=text)
        if not r.ok:
            break
        total = len((root / "full" / "memory" / "MEMORY.md").read_text(encoding="utf-8"))
    assert total > 1500                                    # store bien rempli

    r = await memory(ctx, action="add", store="memory",
                     content="entree de trop " + "x" * 400)
    assert not r.ok and r.error == "over_limit"
    payload = json.dumps(r.model_dump(), ensure_ascii=False)
    # Compact : extraits tronqués (~120c/entrée), PAS le store complet ;
    # l'ancien comportement renvoyait les textes intégraux (> chars du store).
    assert len(payload) < 2000
    assert all(len(e) <= 100 for e in r.entries)          # extrait ≤ 60c + id/(Nc)
