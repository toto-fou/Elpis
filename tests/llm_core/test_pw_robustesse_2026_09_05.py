# SPDX-License-Identifier: MIT
"""Audit tools web 2026-09-05 — robustesse classique + GWT (non-régression).

Les correctifs du 03/09 (rapport ``rapport_heroku_challenge.md`` §6) ont été
perdus par un retour de version le 04/09 : ce fichier les verrouille pour de
bon, SANS service Node ni navigateur.

Trois familles :
  A. contrat de schéma — un payload tel que le service le rend doit passer le
     schéma de sortie ``Union[<PWModel>, ErrEnvelope]`` (c'est ce que le
     client MCP valide : ``-32602 … status must be integer`` était la trace
     d'un ``status: int`` trop strict) ;
  B. couche Python (banc ``_pw_harness``) — capture normalisée, attente
     unifiée avec pw_expect, chaîne observée, drag/expand, réseau, dialogues ;
  C. source du service — les marqueurs des correctifs sont présents.
"""
from __future__ import annotations

import pathlib
from typing import Any, Dict, Union

import jsonschema
import pytest
from pydantic import TypeAdapter

from llm_core.tools import firefox_tools as ff
from llm_core.tools import _models as M
from tests.llm_core._pw_harness import CTX, FakeMCP, pw, pw_env, sent  # noqa: F401

ROOT = pathlib.Path(__file__).resolve().parents[2]


def _schema_errors(model, payload: Dict[str, Any]):
    schema = TypeAdapter(Union[model, M.ErrEnvelope]).json_schema()
    return [e.message for e in jsonschema.Draft202012Validator(schema).iter_errors(payload)]


# ══ A. Contrat de schéma : ce que le service rend passe le schéma ═══════════

@pytest.mark.parametrize("model,payload", [
    # pw_page(screenshot) — cause du -32602 : status CHAÎNE
    (M.PWPageResult, {"status": "success", "screenshot": "shot_s_1.png", "screenshot_step": 3}),
    (M.PWPageResult, {"ok": True, "action": "screenshot", "screenshot": "shot_s_1.png",
                      "screenshot_url": "/api/playwright/screenshot/shot_s_1.png",
                      "screenshot_step": 3, "full_page": False}),
    (M.PWPageResult, {"status": "found", "screenshot_step": 4}),                       # wait
    (M.PWPageResult, {"status": "success", "tab_index": 1, "url": "u", "title": "t"}),  # tab_new
    (M.PWPageResult, {"status": "closed", "remaining_tabs": 1}),                       # tab_close
    (M.PWPageResult, {"status": "success", "file": "p.pdf", "path": "/x/p.pdf"}),      # pdf
    (M.PWPageResult, {"status": 200, "url": "u"}),                                     # nav (int gardé)
    (M.PWPageResult, {"logs": [], "count": 0, "total": 0, "by_host": {}, "prioritized": False, "page_url": "u"}),
    # inspect enrichi : contenu shadow + scrollables toujours présent (retest 2)
    (M.PWPageResult, {"url": "u", "candidates_total": 3,
                      "omitted": {"offscreen": 0, "hidden": 0, "too_small": 1, "over_max": 0},
                      "interactives": [{"idx": 0, "type": "shadow-content", "in_shadow": True,
                                        "name": "My default text", "shadow_host": "my-paragraph"}],
                      "scrollables": [], "shadow_hosts": 2,
                      "shadow": [{"host": "my-paragraph", "text": "My default text", "interactive": 0}]}),
    # pw_chain : une étape en échec = ok:false ORDINAIRE, pas une enveloppe d'erreur
    (M.PWChainResult, {"ok": False, "total": 2, "executed": 1, "failed": 1,
                       "results": [{"step": 0, "action": "click", "success": False, "error": "x"}],
                       "page_after": {"interactives": []}}),
    (M.PWChainResult, {"ok": True, "total": 3, "executed": 3, "failed": 0, "results": [], "screenshot_step": 9}),
    # pw_act enrichi
    (M.PWActResult, {"status": "success", "strategy": "by_official",
                     "resolved_selector": "page.getByRole('link', { name: /Login/i }).first()",
                     "attempts": [{"via": "official", "ok": True, "ms": 12}], "url": "u",
                     "selected": {"value": "2", "label": "Option 2", "index": 2}, "expanded": False,
                     "ancestors": [], "screenshot_step": 1, "page_after": {"interactives": []}}),
    (M.PWActResult, {"status": "success", "strategy": "container-scroll", "direction": "down", "amount": 800,
                     "scroll": {"x": 0, "y": 0, "max_y": 0}, "container": {"selector": "div.gwt-ScrollPanel", "top": 85, "max": 100}}),
    # pw_find : TTL du ref
    (M.PWFindResult, {"count": 1, "total": 1, "matches": [{"tag": "a", "ref": "loc_x", "visible": True}],
                      "ref_ttl_s": 300, "ref_reusable": True, "usage_hint": "…", "screenshot_step": 2}),
    # pw_wait : timeout ordinaire avec polled_value
    (M.PWWaitResult, {"ok": False, "mode": "condition", "condition": "text_contains", "status": "timeout",
                      "selector": "#finish", "session_id": "s", "timed_out": True, "via": "official",
                      "polled_value": {"count": 1, "text": "", "attr": None, "visible": True},
                      "elapsed_ms": 15000, "hint": "…"}),
    (M.PWWaitResult, {"ok": True, "mode": "condition", "condition": "text_contains", "status": "matched",
                      "selector": "#finish", "session_id": "s", "elapsed_ms": 3034, "via": "official",
                      "polled_value": {"count": 1, "text": "Hello World!"}, "text": "Hello World!"}),
    # pw_visual : causes d'échec séparées
    (M.PWVisualResult, {"ok": True, "name": "x", "passed": False, "threshold": 0.01, "pixel_diff_failed": True,
                        "size_mismatch": False, "fail_reason": "pixel_diff", "diff_ratio": 0.057,
                        "diff_pixels": 119245, "compared": {"w": 1920, "h": 1080},
                        "dims": {"baseline": {"w": 1920, "h": 1080}, "current": {"w": 1920, "h": 1080}},
                        "screenshot_url": "/s/c.png", "baseline_url": "/s/b.png", "diff_url": "/s/d.png"}),
    (M.PWVisualResult, {"ok": True, "name": "x", "baseline_created": True, "passed": True,
                        "size_mismatch": False, "pixel_diff_failed": False, "fail_reason": None, "message": "m"}),
    (M.PWVisualResult, {"ok": True, "name": "x", "passed": False, "size_mismatch": True, "pixel_diff_failed": None,
                        "fail_reason": "size_mismatch", "dims": {}, "screenshot_url": "/s/c.png", "message": "m"}),
    # pw_a11y : preuve du checker
    (M.PWA11yResult, {"ok": True, "scope": "body", "violations": [], "total": 45, "truncated": False,
                      "by_impact": {"serious": 45}, "by_rule": {"color-contrast": 45},
                      "rules_run": ["image-alt", "label", "control-name", "duplicate-id", "html-lang",
                                    "heading-order", "tabindex", "color-contrast"],
                      "contrast_sampled": 49, "contrast_capped": False, "passed": False}),
    # autres outils, forme service inchangée
    (M.PWExpectResult, {"pass": True, "assertion": "text-contains", "expected": "x", "actual": "y",
                        "duration_ms": 8, "screenshot_step": 3}),
    (M.PWObserveResult, {"mode": "som", "url": "u", "items": [], "screenshot": "view_s.png", "diff": None,
                         "count": 0, "candidates_total": 2, "omitted": {"offscreen": 0, "hidden": 0,
                         "too_small": 1, "over_max": 0}, "shadow_hosts": 1}),
    (M.PWMockResult, {"status": "added", "id": "mock_x", "mocks_count": 1}),
    (M.PWRecorderResult, {"format": "json", "count": 13, "script": "[]"}),
    (M.PWSessionResult, {"status": "started", "session_id": "s", "url": "u", "title": "t"}),
])
def test_payload_service_passe_le_schema_de_sortie(model, payload):
    assert _schema_errors(model, payload) == []


def test_enveloppe_d_erreur_passe_toujours():
    assert _schema_errors(M.PWPageResult, {"ok": False, "error": "not_found", "message": "m"}) == []


# ══ B. Couche Python ═════════════════════════════════════════════════════════

def _tools():
    mcp = FakeMCP()
    ff.register(mcp)
    return mcp.tools


class _Clock:
    def __init__(self, step=0.5):
        self.t, self.step, self.slept = 1000.0, step, []

    def monotonic(self):
        self.t += self.step
        return self.t

    def sleep(self, s):
        self.slept.append(s)
        self.t += s


# ── screenshot : contrat stable, URL applicative ─────────────────────────
def test_screenshot_normalise_la_reponse_du_service(monkeypatch):
    calls = []

    def fake_req(method, endpoint, json=None, params=None, timeout=None):
        calls.append((endpoint, dict(json or {})))
        return {"status": "success", "screenshot": "shot_s1_17.png", "screenshot_step": 7}

    monkeypatch.setattr(ff, "_req", fake_req)
    page = _tools()["pw_page"]
    r = page(CTX, "s1", action="screenshot")
    assert calls[0][0] == "/screenshot" and calls[0][1]["full_page"] is False
    assert r["ok"] is True and r["action"] == "screenshot"
    assert r["screenshot"] == "shot_s1_17.png"
    assert r["screenshot_url"] == "/api/playwright/screenshot/shot_s1_17.png"
    assert r["screenshot_step"] == 7
    assert "status" not in r          # plus de chaîne qui heurte le schéma
    assert _schema_errors(M.PWPageResult, r) == []

    # cible → capture rognée, cible rappelée dans le résultat
    calls.clear()
    r2 = page(CTX, "s1", action="screenshot", target="role=dialog")
    assert calls[0][0] == "/element_screenshot" and calls[0][1]["by_role"] == "dialog"
    assert r2["target"] == "role=dialog"
    # selector= brut est accepté comme synonyme (enveloppé en css=)
    calls.clear()
    page(CTX, "s1", action="screenshot", selector="#panel")
    assert calls[0][0] == "/element_screenshot" and calls[0][1]["by_css"] == "#panel"


def test_screenshot_erreur_du_service_passe_telle_quelle(monkeypatch):
    monkeypatch.setattr(ff, "_req", lambda *a, **k: {"ok": False, "error": "session_not_found"})
    r = _tools()["pw_page"](CTX, "s1", action="screenshot")
    assert r["ok"] is False and r["error"] == "session_not_found"


def test_le_proxy_relaie_les_captures_shot_():
    """La route applicative n'acceptait que step_/live_/smart_/view_ : une
    screenshot_url vers shot_… aurait fait 400."""
    src = (ROOT / "shared_infra" / "routes" / "tools.py").read_text(encoding="utf-8")
    assert "(?:step|shot)_" in src


# ── pw_wait : même cible que pw_expect ───────────────────────────────────
def test_wait_aplatit_le_dsl_et_envoie_les_by_star(monkeypatch):
    monkeypatch.setattr(ff, "time", _Clock())
    seen = []

    def fake_status(method, endpoint, json=None, params=None, timeout=None):
        seen.append(dict(json))
        return 200, {"status": "matched", "text": "Hello World!", "via": "official",
                     "polled_value": {"count": 1, "text": "Hello World!"}}

    monkeypatch.setattr(ff, "_req_status", fake_status)
    wait = _tools()["pw_wait"]
    # Le cas du rapport : selector= en forme DSL (`css=#finish`)
    r = wait(CTX, session_id="s1", selector="css=#finish", condition="text_contains",
             expected_text="Hello World!")
    assert r["ok"] is True and r["status"] == "matched"
    assert seen[0]["selector"] == "#finish"          # plus jamais 'css=#finish' brut
    assert seen[0]["by_css"] == "#finish"            # résolution officielle, comme /expect
    assert r["via"] == "official" and r["text"] == "Hello World!"
    assert r["polled_value"]["text"] == "Hello World!"
    # role+name : inexprimable en sélecteur, mais by_role/by_name partent
    seen.clear()
    wait(CTX, session_id="s1", target="role=status|name=Done", condition="visible")
    assert seen[0]["by_role"] == "status" and seen[0]["by_name"] == "Done"
    assert seen[0]["selector"] == "Done"


def test_wait_timeout_rend_polled_value_et_repasse_la_baseline(monkeypatch):
    monkeypatch.setattr(ff, "time", _Clock(step=0.5))
    seen = []

    def fake_status(method, endpoint, json=None, params=None, timeout=None):
        seen.append(dict(json))
        return 408, {"error": "not yet", "via": "official",
                     "polled_value": {"count": 1, "text": "Loading…", "attr": None, "visible": True},
                     "baseline": {"count": 1, "text": "Loading…", "attr": None, "visible": True}}

    monkeypatch.setattr(ff, "_req_status", fake_status)
    r = _tools()["pw_wait"](CTX, session_id="s1", selector="#finish", condition="text_changes",
                            max_wait_s=2)
    assert r["ok"] is False and r["timed_out"] is True
    assert r["polled_value"]["text"] == "Loading…"
    assert r["via"] == "official"
    assert "polled_value" in r["hint"]
    # 1re tranche sans baseline, les suivantes avec celle du service
    assert "baseline" not in seen[0]
    assert len(seen) >= 2 and seen[1]["baseline"]["text"] == "Loading…"


def test_wait_condition_inconnue_refusee(monkeypatch):
    monkeypatch.setattr(ff, "time", _Clock())
    monkeypatch.setattr(ff, "_req_status", lambda *a, **k: (200, {}))
    r = _tools()["pw_wait"](CTX, session_id="s1", selector="#x", condition="gone")
    assert r.get("error") and "attached" in r["fix"]


def test_wait_attached_est_une_condition(monkeypatch):
    monkeypatch.setattr(ff, "time", _Clock())
    seen = []
    monkeypatch.setattr(ff, "_req_status",
                        lambda m, e, json=None, **k: (seen.append(json), (200, {"status": "attached"}))[1])
    r = _tools()["pw_wait"](CTX, session_id="s1", selector="#x", condition="attached")
    assert r["ok"] is True and seen[0]["condition"] == "attached"


# ── pw_chain : page_after ────────────────────────────────────────────────
def test_chain_attache_page_after(monkeypatch):
    calls = []

    def fake_req(method, endpoint, json=None, params=None, timeout=None):
        calls.append(endpoint)
        if endpoint == "/chain":
            return {"ok": False, "total": 1, "executed": 1, "failed": 1,
                    "results": [{"step": 0, "action": "click", "success": False, "error": "nope"}]}
        if endpoint == "/smart_inspect":
            return {"interactives": [{"idx": 0}], "url": "u", "candidates_total": 1}
        raise AssertionError(endpoint)

    monkeypatch.setattr(ff, "_req", fake_req)
    chain = _tools()["pw_chain"]
    r = chain(CTX, "s1", actions=[{"action": "click", "target": "text=Go"}])
    # même sur ok:false (étape échouée) on montre la page — c'est là qu'on en a besoin
    assert r["ok"] is False and r["page_after"]["url"] == "u"
    assert calls == ["/chain", "/smart_inspect"]
    assert _schema_errors(M.PWChainResult, r) == []
    calls.clear()
    chain(CTX, "s1", actions=[{"action": "click", "target": "text=Go"}], observe=False)
    assert calls == ["/chain"]


# ── pw_act : drag / expand / collapse ────────────────────────────────────
def test_act_drag_envoie_source_et_destination(pw, sent):
    r = pw("pw_act")(CTX, "s1", action="drag", target="css=#column-a", to="css=#column-b")
    body = sent[-1].body
    assert body["type"] == "drag"
    assert body["by_css"] == "#column-a" and body["selector"] == "#column-a"
    assert body["to"] == {"by_css": "#column-b"} and body["target_selector"] == "#column-b"
    assert r.get("error") is None
    # destination DSL role+name → by_* seulement (pas de chaîne exprimable)
    pw("pw_act")(CTX, "s1", action="drag", target="text=A", to="role=listitem|name=Trash")
    assert sent[-1].body["to"] == {"by_role": "listitem", "by_name": "Trash"}
    assert sent[-1].body["target_selector"] == "Trash"


def test_act_drag_sans_destination_ni_decalage_est_refuse(pw, sent):
    n = len(sent)
    r = pw("pw_act")(CTX, "s1", action="drag", target="css=#a")
    assert r["ok"] is False and r["error"] == "drag_destination_required"
    assert len(sent) == n
    # un décalage suffit
    pw("pw_act")(CTX, "s1", action="drag", target="css=#a", direction="right", amount=300)
    assert sent[-1].body["type"] == "drag" and sent[-1].body["direction"] == "right"


def test_act_expand_et_collapse(pw, sent):
    pw("pw_act")(CTX, "s1", action="expand", target="role=treeitem|name=Tables")
    b = sent[-1].body
    assert b["type"] == "expand" and b["by_role"] == "treeitem" and b["by_name"] == "Tables"
    assert b["selector"] == "Tables"
    pw("pw_act")(CTX, "s1", action="collapse", target="css=#node")
    assert sent[-1].body["type"] == "collapse"


def test_les_nouvelles_actions_sont_citees_en_cas_d_erreur(pw):
    r = pw("pw_act")(CTX, "s1", action="nawak")
    for a in ("drag", "expand", "collapse"):
        assert a in r["fix"]


# ── pw_page : network, inspect, text ─────────────────────────────────────
def test_page_network_transmet_plafond_et_filtre(pw, sent):
    pw("pw_page")(CTX, "s1", action="network")
    assert sent[-1].endpoint == "/network" and sent[-1].params["last"] == 50
    assert "filter" not in sent[-1].params
    pw("pw_page")(CTX, "s1", action="network", max=100, value="herokuapp")
    assert sent[-1].params["last"] == 100 and sent[-1].params["filter"] == "herokuapp"


def test_page_inspect_pierce_shadow_par_defaut(pw, sent):
    pw("pw_page")(CTX, "s1", action="inspect")
    assert "pierce_shadow" not in sent[-1].params          # défaut serveur = true
    pw("pw_page")(CTX, "s1", action="inspect", pierce_shadow=False)
    assert sent[-1].params["pierce_shadow"] == "false"
    pw("pw_observe")(CTX, "s1", pierce_shadow=False)
    assert sent[-1].params["pierce_shadow"] == "false"
    pw("pw_page")(CTX, "s1", action="text", pierce_shadow=False)
    assert sent[-1].body["pierce_shadow"] is False


# ── pw_dialog : politique collante ───────────────────────────────────────
def test_dialog_sticky_est_transmis(pw, sent):
    pw("pw_dialog")(CTX, "s1", action="dismiss", sticky=True)
    assert sent[-1].body["sticky"] is True and sent[-1].body["action"] == "dismiss"
    pw("pw_dialog")(CTX, "s1")
    assert sent[-1].body["action"] == "status" and sent[-1].body["sticky"] is False


# ══ C. Source du service : les correctifs sont là ════════════════════════════

def _server_src() -> str:
    return (ROOT / "browser-service" / "server.js").read_text(encoding="utf-8")


def _code_only(js: str) -> str:
    return "\n".join(l for l in js.splitlines() if not l.lstrip().startswith("//"))


@pytest.mark.parametrize("marker", [
    "ref_ttl_s", "ref_reusable",                       # pw_find
    "resolved_selector", "attempts:",                  # pw_act
    "polled_value", "baseline",                        # pw_wait
    "default_when_unarmed", "last_policy", "history",  # pw_dialog
    "by_rule", "rules_run", "contrast_sampled",        # pw_a11y
    "pixel_diff_failed", "fail_reason",                # pw_visual
    "candidates_total", "omitted",                     # inspect
    "shadow_hosts", "pierceShadow",                    # shadow DOM
    "_shadowContent", "shadow-content",                # contenu shadow non interactif (retest 2)
    "compactConsole(",                                 # console (×N)
    "summarizeNetwork(", "same_origin",                # network
    "expandTreeItem(", "performDrag(", "html5DragDrop(",
    "container-scroll",                                # scroll GWT
    '[draggable="true"]',
    "selectOptionArg(e, 'playwright')",                # recorder
])
def test_marqueur_present_dans_le_service(marker):
    assert marker in _code_only(_server_src()), marker


def test_wait_for_dynamic_ne_passe_plus_par_querySelector():
    src = _server_src()
    i = src.index("app.post('/wait_for_dynamic'")
    j = src.index("app.post('/dispatch_event'")
    corps = _code_only(src[i:j])
    assert "document.querySelector(" not in corps
    assert "locatorFromParams(" in corps and "smartResolveLocator(" in corps
    assert "waitFor({ state: condition" in corps


def test_recorder_ne_falsifie_plus_le_select():
    src = _server_src()
    assert "selectOption('${escape(e.value)}')" not in src
    assert "select('${escape(e.value)}')" not in src
    # /action journalise l'option réellement choisie, sur les DEUX chemins
    assert src.count("option_label: selectedOption.label") == 1
    assert src.count("option_label: picked.label") == 1


def test_le_journal_reseau_couvre_les_documents_et_chaque_onglet():
    src = _code_only(_server_src())
    assert "const NET_TYPES = new Set(['document', 'xhr', 'fetch'])" in src
    assert src.count("attachPageLoggers(") >= 4     # définition + start + réutilisation + new_tab


def test_maxy_ne_peut_plus_etre_negatif():
    src = _code_only(_server_src())
    assert "maxY: document.body.scrollHeight - window.innerHeight" not in src
    assert "const maxY = Math.max(0," in src


def test_scrollables_toujours_present_dans_inspect():
    """Retest 2 (2026-09-05) — ``scrollables`` était OMIS quand vide, rendant
    « aucun conteneur » indistinguable de « pas implémenté ». Il est désormais
    TOUJOURS renvoyé (tableau, vide si aucun) ; seul le HINT est conditionnel."""
    src = _server_src()
    i = src.index("candidates_total: _allCandidates.length, omitted,")
    corps = src[i:i + 400]
    assert "\n                     scrollables,\n" in corps        # inconditionnel
    assert "scrollables.length ? { scrollables_hint" in corps       # hint conditionnel


def test_contenu_shadow_non_interactif_liste():
    """Retest 2 — un shadow root qui ne porte que du TEXTE est listé
    (``shadow-content``, ``in_shadow``) + résumé ``shadow`` par hôte."""
    src = _code_only(_server_src())
    assert "type: 'shadow-content'" in src
    assert "in_shadow: true" in src
    assert "const shadow = _shadowContent" in src
