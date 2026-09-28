# SPDX-License-Identifier: MIT
"""tests/llm_core/test_ctx_scale_pruning.py — étages 0/1/2 du pipeline de
réduction aux échelles 256k / 1M (2026-07-28).

Ce que ces tests verrouillent, avec du VRAI texte matérialisé :
- calibration : les constantes dérivées du n_ctx (emit cap, seuils de vague,
  réserve, budget, pré-porte) valent EXACTEMENT les littéraux attendus aux
  deux échelles — le test-sentinelle du harnais d'échelle ;
- étage 0 (``prepare_tool_result_for_model``) : cap d'émission dérivé du
  n_ctx (55 050 chars à 256k, plafond 100 000 à 1M), coupe tête+queue pour
  execute_shell/task, tête-seule sinon, diff write_file strippé, perception
  desktop compactée mais jamais amputée ;
- ``prune_old_vision_frames`` + filet ``sanitize_message_history``
  (50 000 tokens matérialisés stables, idempotent).
(L'élagage des tool_results vit désormais en fin de tour — cf.
``test_prune_marks.py``.)

Aucun réseau : fonctions PURES uniquement (aucun patch nécessaire).
"""
from __future__ import annotations

import copy
import json

from llm_core.context.budget import BUDGET
from llm_core.context import pruning as _pruning
from llm_core.context.pruning import (
    prepare_tool_result_for_model,
    prune_old_vision_frames,
    sanitize_message_history,
)

import pytest

from tests.llm_core.ctx_scale_harness import (
    CTX_1M,
    CTX_256K,
    LITERALS,
    blob,
    expected,
    image_user,
    reset_measured_ratio,
    scale_param,
    shell_round,
    tool_contents,
)


@pytest.fixture(autouse=True)
def _seed_ratio():
    """Les caps matérialisés (emit) dépendent du ratio MESURÉ (état module) :
    on repart de l'amorce 3.3 pour des littéraux déterministes."""
    reset_measured_ratio()
    yield
    reset_measured_ratio()


# ── Calibration : constantes dérivées == littéraux attendus ────────────────

@scale_param
def test_calibration_des_constantes_derivees(ctx):
    """Le test-sentinelle : si ``context_config.json`` (section ``budgets``)
    retune un ratio, C'EST LUI qui échoue en le disant — les autres tests
    consomment ``expected()`` et suivent le tuning."""
    got = expected(ctx)
    want = LITERALS[ctx]
    for key, val in want.items():
        assert got[key] == val, (
            f"constante dérivée « {key} » à ctx={ctx} : {got[key]} ≠ {val} "
            f"(littéral attendu) — budgets retunés dans context_config.json ?"
        )


# ── Étage 0 — cap d'émission ────────────────────────────────────────────────

@scale_param
def test_emit_cap_execute_shell_preserve_tete_et_queue(ctx):
    E = expected(ctx)
    content = blob(120_000, "shellcap")
    out = prepare_tool_result_for_model("execute_shell", content, ctx)
    assert len(out) <= E["emit_cap"], "la coupe d'émission doit tenir sous le cap"
    assert "<<HEAD shellcap>>" in out, "tête perdue — le contexte du run a disparu"
    assert "<<TAIL shellcap exit=0>>" in out, \
        "queue perdue — le verdict (code de sortie) est la partie décisive"
    assert "result truncated at emission, tail preserved" in out


@scale_param
def test_emit_cap_head_only_outil_generique(ctx):
    E = expected(ctx)
    cap = E["emit_cap"]
    content = blob(120_000, "readfile")
    out = prepare_tool_result_for_model("read_file", content, ctx)
    omitted = 120_000 - cap
    # Coupe tête-seule EXACTE : préfixe intact + marqueur chiffré.
    assert out == content[:cap] + f"\n…[result truncated, {omitted} chars omitted]"
    assert out.startswith("<<HEAD readfile>>")


def test_emit_cap_discrimine_les_echelles():
    """Le cœur du « pourquoi 2 échelles » à l'étage 0 : le MÊME résultat de
    60 000 chars est tronqué à 256k (cap 55 050) et passe INTACT à 1M
    (cap plafonné à 100 000)."""
    content = blob(60_000, "midsize")
    out_256k = prepare_tool_result_for_model("read_file", content, CTX_256K)
    out_1m = prepare_tool_result_for_model("read_file", content, CTX_1M)
    assert len(out_256k) < 60_000 and "result truncated" in out_256k
    assert out_1m == content, "à 1M, 60k chars < cap 100k → aucune coupe"


@scale_param
def test_write_file_diff_strippe_stats_conservees(ctx):
    diff = "".join(f"+ligne {k}\n" for k in range(200))
    content = json.dumps({"ok": True, "path": "src/app.py", "diff": diff,
                          "lines_added": 12, "lines_removed": 3})
    out = prepare_tool_result_for_model("write_file", content, ctx)
    d = json.loads(out)
    assert "diff" not in d, "le diff complet vit côté UI, pas côté modèle"
    assert d["diff_stat"] == "+12/-3 lines"
    assert "re-read the file" in d["diff_note"]
    assert d["ok"] is True and d["path"] == "src/app.py"


@scale_param
def test_desktop_elements_compactes_jamais_ampute(ctx):
    els = [{"id": k, "label": f"bouton {k}", "role": "button",
            "center": [10 * k, 20], "box": [10 * k, 20, 80, 24],
            "confidence": 0.93, "source": "uia", "depth": 4}
           for k in range(300)]
    content = json.dumps({"elements": els, "frame_token": "tok", "img_w": 1920,
                          "img_h": 1080, "sig": "s"}, ensure_ascii=False)
    out = prepare_tool_result_for_model("desktop_observe", content, ctx)
    d = json.loads(out)   # parse OK ⇒ jamais tronqué en plein JSON
    assert len(d["elements"]) == 300, "la liste d'éléments doit arriver ENTIÈRE"
    assert "frame_token" not in d and "img_w" not in d, "métadonnées de frame droppées"
    for e in d["elements"]:
        assert "box" not in e and "confidence" not in e, \
            "champs Studio (box/confidence) inutiles au modèle → droppés"
        assert e["id"] is not None and e["center"]


# ── Étage 2 — frames vision ────────────────────────────────────────────────

def test_vision_frames_2_dernieres_gardees():
    msgs = [{"role": "system", "content": "socle"}]
    for i in range(5):
        msgs.append(image_user(i))
        msgs.append({"role": "assistant", "content": f"vu {i}"})
    snapshot = copy.deepcopy(msgs)

    out = prune_old_vision_frames(msgs, keep=2)
    n_imgs = sum(
        1 for m in out if isinstance(m.get("content"), list)
        and any(b.get("type") == "image_url" for b in m["content"]
                if isinstance(b, dict))
    )
    assert n_imgs == 2, "seules les 2 dernières frames restent en base64"
    stripped = [m for m in out if isinstance(m.get("content"), list)
                and any("previous screenshot elided" in (b.get("text") or "")
                        for b in m["content"] if isinstance(b, dict))]
    assert len(stripped) == 3, "les 3 anciennes → placeholder texte"
    assert msgs == snapshot, "l'entrée ne doit jamais être mutée"


# ── Filet structurel — sanitize 200k idempotent ─────────────────────────────

def test_sanitize_filet_200k_idempotent():
    big = blob(250_000, "patho")
    msgs = [
        {"role": "assistant", "content": None,
         "tool_calls": [{"id": "c1", "type": "function",
                         "function": {"name": "execute_shell",
                                      "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": big},
    ]
    out = sanitize_message_history(msgs)
    # Repérage par RÔLE : la passe pose aussi une ancre de tâche quand
    # l'historique n'a aucun ``user`` (cf. _ensure_user_anchor).
    _tool_of = lambda ms: next(m for m in ms if m["role"] == "tool")
    c = _tool_of(out)["content"]
    from llm_core.context.tokens import tokens_to_chars_stable
    assert len(c) <= tokens_to_chars_stable(BUDGET.sanitize_tool_max_tokens), \
        "filet sanitize (50k tokens stables)"
    assert "oversized tool result" in c
    assert c.startswith("<<HEAD patho>>") and c.endswith("exit=0>>"), \
        "le filet coupe tête+queue — la conclusion survit"
    # Idempotent : une fois coupé, plus jamais retouché (byte-stable).
    out2 = sanitize_message_history(out)
    assert _tool_of(out2)["content"] == c
    # L'entrée n'est pas mutée.
    assert len(msgs[1]["content"]) == 250_000
