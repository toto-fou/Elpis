# SPDX-License-Identifier: MIT
"""Harmonisation des noms d'arguments des outils navigateur (2026-08-08).

Constat de mission live : la même notion — « quel geste » — portait cinq noms
selon l'outil (``action`` / ``op`` / ``do`` / ``assertion`` / ``mode``), la
valeur deux (``v`` / ``value``), la cible deux (``target`` / ``selector``).
Un agent qui venait d'appeler ``pw_page(op=…)`` enchaînait ``pw_act(op=…)`` →
erreur de schéma, un tour perdu. Deux appels sur dix de la mission web y sont
passés. ``pw_find`` DOCUMENTAIT même un ``selector=`` qu'il n'acceptait pas.

Contrat désormais tenu, et c'est ce que ce fichier verrouille :

  1. ``action=`` est valide sur TOUS les outils qui ont un verbe ;
  2. chaque ancien nom continue de marcher, à l'identique ;
  3. quand les deux sont fournis, le nom canonique gagne — règle UNIFORME ;
  4. ``pw_verb()`` est la seule source de vérité, et les hooks du harnais
     (propriété de session, injection vision) passent par elle — sinon
     l'harmonisation les rendait aveugles.
"""
from __future__ import annotations

import inspect

import pytest

from llm_core.tools import firefox_tools as ff
from tests.llm_core._pw_harness import CTX, FakeMCP, pw, pw_env, sent  # noqa: F401

# ── 1. Le contrat déclaré colle à la signature réelle ────────────────────

def _params(tool_name: str) -> set:
    mcp = FakeMCP()
    ff.register(mcp)
    return set(inspect.signature(mcp.tools[tool_name]).parameters)


def test_table_alias_alignee_sur_les_signatures():
    """Chaque alias annoncé doit EXISTER comme paramètre : une table qui
    dérive de la signature, c'est le bug d'origine sous un autre nom."""
    for tool, aliases in ff.PW_VERB_ALIASES.items():
        params = _params(tool)
        for a in aliases:
            assert a in params, f"{tool}: alias {a!r} annoncé mais absent"


def test_action_est_accepte_partout_ou_il_y_a_un_verbe():
    for tool in ff.PW_VERB_ALIASES:
        assert "action" in _params(tool), f"{tool} n'accepte pas action="


def test_le_canonique_est_toujours_en_tete():
    """La priorité doit être la même partout : ``action`` d'abord."""
    for tool, aliases in ff.PW_VERB_ALIASES.items():
        assert aliases[0] == "action", f"{tool}: canonique = {aliases[0]!r}"


@pytest.mark.parametrize("tool", ["pw_act", "pw_page", "pw_expect"])
def test_value_et_v_coexistent(tool):
    params = _params(tool)
    assert {"v", "value"} <= params, f"{tool}: {sorted(params)}"


@pytest.mark.parametrize("tool", ["pw_find", "pw_act", "pw_page",
                                  "pw_expect", "pw_wait", "pw_visual",
                                  "pw_a11y"])
def test_target_et_selector_coexistent(tool):
    params = _params(tool)
    assert {"target", "selector"} <= params, f"{tool}: {sorted(params)}"


# ── 2. pw_verb : source de vérité unique ─────────────────────────────────

@pytest.mark.parametrize("tool,args,expected", [
    ("pw_page",    {"op": "inspect"},                   "inspect"),
    ("pw_page",    {"action": "inspect"},               "inspect"),
    ("pw_page",    {"action": "text", "op": "inspect"}, "text"),      # canonique gagne
    ("pw_act",     {"do": "click"},                     "click"),
    ("pw_act",     {"action": "click"},                 "click"),
    ("pw_expect",  {"assertion": "visible"},            "visible"),
    ("pw_observe", {"mode": "som"},                     "som"),
    ("pw_memory",  {"op": "sites"},                     "sites"),
    ("pw_session", {"action": " stop "},                "stop"),      # trimé
    ("pw_page",    {},                                  ""),
    ("pw_page",    {"op": ""},                          ""),
    ("pw_page",    {"op": None},                        ""),
    ("pw_unknown", {"action": "x"},                     "x"),         # défaut sûr
])
def test_pw_verb(tool, args, expected):
    assert ff.pw_verb(tool, args) == expected


def test_pw_verb_tolere_des_args_non_dict():
    assert ff.pw_verb("pw_page", None) == ""
    assert ff.pw_verb("pw_page", "inspect") == ""


# ── 3. Les deux noms produisent LE MÊME appel sortant ────────────────────

def test_page_text_action_ou_op(pw, sent):
    pw("pw_page")(CTX, "s1", action="text")
    pw("pw_page")(CTX, "s1", op="text")
    assert sent[0].endpoint == sent[1].endpoint == "/extract_text"
    assert sent[0].body == sent[1].body


def test_act_action_ou_do(pw, sent):
    pw("pw_act")(CTX, "s1", action="click", target="role=button|name=Go")
    pw("pw_act")(CTX, "s1", do="click", target="role=button|name=Go")
    assert sent[0].body == sent[1].body
    assert sent[0].body["type"] == "click"


def test_act_value_ou_v(pw, sent):
    pw("pw_act")(CTX, "s1", action="fill", target="label=Email", value="a@b.c")
    pw("pw_act")(CTX, "s1", action="fill", target="label=Email", v="a@b.c")
    assert sent[0].body == sent[1].body
    assert sent[0].body["text"] == "a@b.c"


def test_act_selector_ou_target(pw, sent):
    pw("pw_act")(CTX, "s1", action="click", selector="#go")
    pw("pw_act")(CTX, "s1", action="click", target="css=#go")
    assert sent[0].body == sent[1].body
    assert sent[0].body["by_css"] == "#go"


def test_expect_action_ou_assertion(pw, sent):
    pw("pw_expect")(CTX, "s1", action="visible", target="role=alert")
    pw("pw_expect")(CTX, "s1", assertion="visible", target="role=alert")
    assert sent[0].body == sent[1].body


def test_observe_action_ou_mode(pw, sent):
    pw("pw_observe")(CTX, "s1", action="som")
    pw("pw_observe")(CTX, "s1", mode="som")
    assert sent[0].params["mode"] == sent[1].params["mode"] == "som"


def test_observe_garde_son_defaut(pw, sent):
    pw("pw_observe")(CTX, "s1")
    assert sent[-1].params["mode"] == "indexed"


def test_memory_action_ou_op(monkeypatch, pw):
    """``pw_memory`` ne passe pas par ``_req`` : on vérifie le dispatch."""
    monkeypatch.setattr(ff, "_AX_ENABLED", True)
    seen = []
    import shared_infra.memory.ax as ax
    # ``owner=`` (audit 2026-08-23) : la vue est bornée au compte appelant.
    monkeypatch.setattr(ax, "list_sites_with_stats",
                        lambda **kw: seen.append(kw.get("owner")) or [])
    assert pw("pw_memory")(CTX, action="sites")["op"] == "sites"
    assert pw("pw_memory")(CTX, op="sites")["op"] == "sites"
    assert len(seen) == 2
    assert all(o is not None for o in seen), \
        "pw_memory n'a pas transmis le propriétaire : la vue divulguerait "\
        "le login enregistré par un autre compte"


# ── 4. pw_find : le ``selector=`` qui était documenté sans exister ───────

def test_find_selector_est_accepte(pw, sent):
    pw("pw_find")(CTX, "s1", selector="#hero")
    assert sent[-1].endpoint == "/locator"
    assert sent[-1].body["by_css"] == "#hero"


def test_find_selector_deja_en_dsl_reste_intact(pw, sent):
    pw("pw_find")(CTX, "s1", selector="role=button|name=Go")
    assert sent[-1].body["by_role"] == "button"
    assert sent[-1].body["by_name"] == "Go"


def test_find_target_gagne_sur_selector(pw, sent):
    pw("pw_find")(CTX, "s1", target="label=Email", selector="#ignored")
    assert sent[-1].body["by_label"] == "Email"
    assert sent[-1].body["by_css"] is None


def test_find_sans_cible_reste_un_inspect(pw, sent):
    pw("pw_find")(CTX, "s1")
    assert sent[-1].endpoint == "/smart_inspect"


# ── 5. pw_page : wait/text prennent aussi le DSL ─────────────────────────

def test_page_wait_accepte_le_dsl(pw, sent):
    pw("pw_page")(CTX, "s1", action="wait", target="css=#done")
    pw("pw_page")(CTX, "s1", action="wait", selector="#done")
    assert sent[0].body["selector"] == sent[1].body["selector"] == "#done"


def test_page_wait_sans_cible_refuse_au_lieu_dattendre_du_vide(pw, sent):
    """Avant : ``selector: ""`` partait au service, qui attendait un sélecteur
    vide jusqu'au timeout."""
    r = pw("pw_page")(CTX, "s1", action="wait")
    assert r["ok"] is False and r["error"] == "target_required"
    assert not sent


def test_page_text_accepte_le_dsl(pw, sent):
    pw("pw_page")(CTX, "s1", action="text", target="css=article")
    assert sent[-1].body["selector"] == "article"


def test_page_screenshot_accepte_selector(pw, sent):
    pw("pw_page")(CTX, "s1", action="screenshot", selector="#hero")
    assert sent[-1].endpoint == "/element_screenshot"
    assert sent[-1].body["by_css"] == "#hero"


def test_page_eval_value_ou_v(pw, sent):
    pw("pw_page")(CTX, "s1", action="eval", value="return 1")
    pw("pw_page")(CTX, "s1", action="eval", v="return 1")
    assert sent[0].body["script"] == sent[1].body["script"] == "return 1"


# ── 6. pw_a11y / pw_visual : même knob que les autres ────────────────────

def test_a11y_scope_selector_target(pw, sent):
    pw("pw_a11y")(CTX, "s1")
    pw("pw_a11y")(CTX, "s1", scope="#main")
    pw("pw_a11y")(CTX, "s1", selector="#main")
    pw("pw_a11y")(CTX, "s1", target="css=#main")
    assert [s.body["scope"] for s in sent] == ["body", "#main", "#main", "#main"]


def test_visual_target_ou_selector(pw, sent):
    pw("pw_visual")(CTX, "s1", selector="#hero")
    pw("pw_visual")(CTX, "s1", target="css=#hero")
    assert sent[0].body["selector"] == sent[1].body["selector"] == "#hero"


# ── 7. pw_chain : un step s'écrit comme un pw_act ────────────────────────

def test_chain_step_accepte_action_et_value(pw, sent):
    pw("pw_chain")(CTX, "s1", actions=[
        {"action": "fill", "target": "label=Email", "value": "a@b.c"},
        {"action": "press", "value": "Enter"},
    ])
    steps = sent[-1].body["actions"]
    assert steps[0]["type"] == "fill" and steps[0]["text"] == "a@b.c"
    assert steps[1]["type"] == "press" and steps[1]["key"] == "Enter"


def test_chain_step_legacy_do_et_v(pw, sent):
    pw("pw_chain")(CTX, "s1", actions=[
        {"do": "fill", "target": "label=Email", "v": "a@b.c"},
    ])
    assert sent[-1].body["actions"][0]["text"] == "a@b.c"


def test_chain_select_garde_value_comme_valeur_native(pw, sent):
    """``value`` est la clé NATIVE du service pour un select : la traiter
    comme un synonyme de ``v`` la ferait atterrir dans ``text``."""
    pw("pw_chain")(CTX, "s1", actions=[
        {"action": "select", "target": "label=Pays", "value": "France"},
    ])
    step = sent[-1].body["actions"][0]
    assert step["value"] == "France" and "text" not in step


# ── 8. Verbe manquant : une erreur qui NOMME le geste ────────────────────

@pytest.mark.parametrize("tool,args", [
    ("pw_act",    ("s1",)),
    ("pw_page",   ("s1",)),
    ("pw_expect", ("s1",)),
    ("pw_memory", ()),
])
def test_verbe_manquant_donne_une_erreur_actionnable(pw, sent, tool, args):
    r = pw(tool)(CTX, *args)
    assert r["ok"] is False and r["error"] == "action_required"
    assert "action=" in r["fix"]
    assert not sent, "rien ne doit partir au service"


def test_verbe_inconnu_parle_de_action_pas_de_op(pw):
    r = pw("pw_page")(CTX, "s1", action="nope")
    assert "action=" in r["message"] and "op=" not in r["message"]
    r = pw("pw_act")(CTX, "s1", action="nope")
    assert "action=" in r["message"] and "do=" not in r["message"]


# ── 9. Les hooks du harnais suivent l'harmonisation ──────────────────────

async def test_suivi_de_session_ferme_le_mapping(monkeypatch):
    """Si le registre de propriété rate un ``stop``, le mapping fuit et un
    autre user peut encore récupérer les captures de cette session."""
    from llm_core import _pw_session as ps

    await ps.register_pw_session_owner("sid-1", "alice")
    await ps._track_pw_session_ownership(
        "pw_session", {"action": "stop", "session_id": "sid-1"}, "{}", "alice")
    assert ps.get_pw_session_owner("sid-1") is None


async def test_suivi_de_session_passe_par_le_resolveur(monkeypatch):
    """Le hook ne doit PAS lire ``action`` en dur : il suit ``pw_verb``, donc
    il continuera de voir juste si le nom canonique de pw_session bouge."""
    from llm_core import _pw_session as ps

    monkeypatch.setattr(ps, "_pw_verb_of",
                        lambda tool, args: args.get("VERBE_MAISON", ""))
    await ps._track_pw_session_ownership(
        "pw_session", {"VERBE_MAISON": "start"},
        '{"session_id": "sid-2"}', "bob")
    assert ps.get_pw_session_owner("sid-2") == "bob"
    await ps.unregister_pw_session_owner("sid-2")


def test_pw_session_na_quun_seul_nom_de_verbe():
    """Contrat assumé : ``action=`` est valide PARTOUT, mais on n'ajoute pas
    les anciens noms là où ils n'ont jamais existé — sinon on réintroduit
    l'ambiguïté qu'on vient de retirer."""
    canoniques_seuls = {t for t, a in ff.PW_VERB_ALIASES.items() if a == ("action",)}
    assert canoniques_seuls == {"pw_session", "pw_mock", "pw_recorder"}
    for tool in canoniques_seuls:
        assert {"op", "do"}.isdisjoint(_params(tool))


@pytest.mark.parametrize("args,expected", [
    ({"op": "inspect"},     "inspect"),
    ({"action": "inspect"}, "inspect"),
    ({"action": "text"},    "text"),
])
def test_hook_vision_resout_le_synonyme(args, expected):
    """L'injection de capture se déclenche sur ``inspect`` — elle lisait
    ``op`` en dur, donc plus rien avec la forme désormais documentée."""
    from llm_core._pw_session import _pw_verb_of
    assert _pw_verb_of("pw_page", args) == expected


def test_chat_with_tools_passe_par_le_resolveur():
    from tests._sources import source_boucle
    src = source_boucle()
    # Le déclencheur de l'injection de capture : la décision « inspect »
    # passe par le résolveur de verbe, jamais par la clé ``op`` en dur.
    i = src.index("_is_inspect = (")
    corps = src[i:src.index("and _is_inspect:", i)]
    assert '_pw_verb_of("pw_page", final_args)' in corps
    assert 'final_args.get("op")' not in src
