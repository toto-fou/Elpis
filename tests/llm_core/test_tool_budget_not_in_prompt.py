# SPDX-License-Identifier: MIT
"""Le budget d'outils ne doit JAMAIS entrer dans le prompt système (2026-07-29).

Deux invariants distincts, souvent confondus :

1. Le prompt système décrit le MÉCANISME (« le harnais peut injecter des notes
   `<harness_status>` ») mais ne porte AUCUNE valeur : ni le budget
   d'itérations, ni le cap dur, ni un compte d'outils. Une valeur figée y
   serait fausse dès qu'un chat la surcharge (sampling_override), et surtout
   elle changerait la tête système à chaque run.
2. Conséquence directe et vérifiable : le prompt système est BYTE-STABLE quand
   le budget change. C'est ce qui préserve le prefix-cache KV — une tête qui
   varie invalide le cache à chaque tour et re-facture tout le prefill.

Le budget est bien communiqué au modèle, mais par le FLUX (``<harness_status>``
posé après les tool results, aux jalons seulement), jamais par la tête.
"""
from __future__ import annotations

import re

import pytest

import llm_core._constants as _C
import shared_infra.config as _cfg
from llm_core._chat_with_tools import _harness_status_line
from llm_core.context.assembly import assemble_operational_context

# Surfaces et fragments dérivent du registre des catégories : le vrai.
pytestmark = pytest.mark.usefixtures("real_tool_registry")

_TOOLS = ["read_file", "write_file", "execute_shell", "git_query",
          "pw_act", "task", "memory"]


def _system_head(tools=_TOOLS) -> str:
    out = assemble_operational_context(
        [{"role": "user", "content": "salut"}],
        allowed_tool_names=tools, username="alice",
    )
    return "\n\n".join(m["content"] for m in out if m.get("role") == "system")


@pytest.fixture
def _budget(monkeypatch):
    """Pose un budget d'itérations sur les DEUX sources (config + miroir)."""
    def _set(n: int):
        monkeypatch.setattr(_cfg, "LLAMA_MAX_TOOL_ITERATIONS", n, raising=False)
        monkeypatch.setattr(_C, "LLAMA_MAX_TOOL_ITERATIONS", n, raising=False)
    return _set


def test_system_prompt_ne_contient_aucune_valeur_de_budget(_budget):
    _budget(137)
    head = _system_head()
    assert head, "prompt système vide — le test ne vérifierait rien"
    for needle in ("137", "274", "max_tool_iterations",
                   "LLAMA_MAX_TOOL_ITERATIONS"):
        assert needle not in head, f"{needle!r} a fuité dans le prompt système"


def test_system_prompt_byte_stable_quand_le_budget_change(_budget):
    """L'invariant qui compte pour le prefix-cache : deux budgets différents
    doivent produire exactement les mêmes octets."""
    _budget(200)
    a = _system_head()
    _budget(137)
    b = _system_head()
    assert a == b


def test_system_prompt_byte_stable_quel_que_soit_l_ordre_des_outils():
    """Le manifeste est trié : le même SET d'outils donne les mêmes octets,
    quel que soit l'ordre d'exposition (sinon cache invalidé sans raison)."""
    assert _system_head(_TOOLS) == _system_head(list(reversed(_TOOLS)))


def test_system_prompt_decrit_le_mecanisme_sans_le_chiffrer():
    """Le modèle doit savoir LIRE `<harness_status>` — sans qu'un nombre y soit."""
    head = _system_head()
    assert "harness_status" in head


def test_le_budget_passe_par_le_flux_aux_jalons_seulement():
    """Contre-partie : la valeur EXISTE bien, mais dans un message du flux,
    et seulement aux jalons (50 %, 75 %, 5 dernières) — pas à chaque tour."""
    assert _harness_status_line(7, 200) is None          # hors jalon : silence
    mid = _harness_status_line(100, 200)                 # 50 %
    assert mid and "100/200" in mid and mid.startswith("<harness_status>")
    last = _harness_status_line(199, 200)                # dernière itération
    assert last and "LAST iteration" in last
    # Jamais émis au-delà du budget (la sortie de boucle prend le relais).
    assert _harness_status_line(200, 200) is None
    assert _harness_status_line(0, 200) is None


def test_manifeste_liste_des_noms_pas_des_comptes():
    """Le manifeste d'outils énumère des NOMS ; il n'annonce pas « N outils »
    (un compte deviendrait faux dès qu'une catégorie est décochée)."""
    head = _system_head()
    assert "# Active tools" in head
    for name in _TOOLS:
        assert name in head
    seg = head.split("# Active tools", 1)[1].split("---", 1)[0]
    assert not re.search(r"\b\d+\s+tools?\b", seg)
