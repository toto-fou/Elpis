# SPDX-License-Identifier: MIT
"""Navigateur (2026-09-30) : destinations autorisées côté Python (refus
anticipé, même politique que browser-service/url_guard.js), propriétaire
transmis au service à chaque requête, isolation entre deux comptes, plus de
passe-droit pour une session inconnue."""
from __future__ import annotations

import ipaddress

import pytest

from shared_infra.security.browser_url import browser_url_block_reason, pw_owner

HOTE = ({ipaddress.ip_address("192.168.50.10"), ipaddress.ip_address("172.17.0.1")},
        [ipaddress.ip_network("172.17.0.0/16")])


def _res(table):
    def r(nom):
        if nom not in table:
            raise OSError("introuvable")
        return table[nom]
    return r


def motif(url, allowlist=(), table=None):
    return browser_url_block_reason(url, allowlist=list(allowlist), hote=HOTE,
                                    resolve=_res(table or {}))


# ── Destinations ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("url", [
    "file:///etc/passwd", "ftp://exemple.org/", "chrome://settings", "javascript:alert(1)",
    "http://127.0.0.1:8001/", "http://2130706433/", "http://[::1]/", "http://0.0.0.0:3000/",
    "http://169.254.169.254/latest/meta-data/", "http://localhost:8765/", "http://app.localhost/",
    "http://192.168.50.10/", "http://172.17.0.5/", "",
])
def test_destinations_refusees(url):
    assert motif(url)


def test_destinations_permises():
    assert motif("about:blank") is None
    assert motif("https://93.184.216.34/") is None
    assert motif("http://192.168.50.54:8080/") is None            # réseau local (D-A1)
    assert motif("https://user:pw@93.184.216.34/") is None        # authentification HTTP


def test_un_nom_est_juge_sur_ses_adresses():
    t = {"nas.lan": ["192.168.50.20"], "piege.example": ["93.184.216.34", "127.0.0.1"]}
    assert motif("http://nas.lan/", table=t) is None
    assert motif("http://piege.example/", table=t)
    assert motif("http://introuvable.example/", table=t) is None   # le navigateur échouera seul


def test_liste_blanche_du_reseau_local():
    t = {"nas.lan": ["192.168.50.20"], "autre.lan": ["192.168.1.21"], "wiki.corp": ["10.9.9.9"],
         "public.example": ["93.184.216.34"]}
    lb = ["nas.lan", "*.corp", "10.1.0.0/16"]
    assert motif("http://nas.lan/", lb, t) is None
    assert motif("http://wiki.corp/", lb, t) is None
    assert motif("http://10.1.2.3/", lb, t) is None
    assert "liste autorisée" in motif("http://autre.lan/", lb, t)
    assert motif("https://public.example/", lb, t) is None
    assert motif("http://127.0.0.1/", ["127.0.0.0/8"], t)          # jamais la boucle locale


def test_liste_blanche_lue_a_chaud(monkeypatch):
    import shared_infra.config as C
    monkeypatch.setattr(C, "live_config_value",
                        lambda p, d=None: ["nas.lan"] if p == "browser.url_allowlist" else d)
    assert browser_url_block_reason("http://10.0.0.8/", hote=HOTE, resolve=_res({}))


# ── Propriétaire ─────────────────────────────────────────────────────────────

def test_proprietaire_injectif_et_sur():
    assert pw_owner("alice") == "alice"
    assert pw_owner("") == "guest" == pw_owner(None)
    assert pw_owner("rené") != pw_owner("ren")
    assert pw_owner("rené").startswith("u_") and pw_owner("rené") == pw_owner("rené")
    assert pw_owner("a b") != pw_owner("ab")


class _Resp:
    status_code = 200

    def json(self):
        return {"ok": True}


def test_le_proprietaire_part_avec_chaque_requete(monkeypatch):
    from llm_core.tools import firefox_tools as F
    vus = []
    monkeypatch.setattr(F.requests, "post", lambda url, json=None, timeout=None: vus.append(("POST", json)) or _Resp())
    monkeypatch.setattr(F.requests, "get", lambda url, params=None, timeout=None: vus.append(("GET", params)) or _Resp())
    monkeypatch.setattr("llm_core._pw_session.get_pw_session_owner", lambda sid: "rené")

    def appel():
        assert F._refus_session_d_autrui("S1", "rené") is None
        F._req("POST", "/action", json={"session_id": "S1"})
        F._req("GET", "/list_tabs", params={"session_id": "S1"})
        F._req_status("GET", "/wait_for_dynamic", params={"session_id": "S1"})

    import contextvars
    contextvars.copy_context().run(appel)
    o = pw_owner("rené")
    assert vus == [("POST", {"session_id": "S1", "owner": o}),
                   ("GET", {"session_id": "S1", "owner": o}),
                   ("GET", {"session_id": "S1", "owner": o})]
    # Hors d'un appel d'outil (contexte vierge), rien n'est ajouté.
    vus.clear()
    contextvars.Context().run(F._req, "GET", "/health")
    assert vus == [("GET", {})] or vus == [("GET", None)]


def test_isolation_entre_deux_comptes(monkeypatch):
    from llm_core.tools import firefox_tools as F
    monkeypatch.setattr("llm_core._pw_session.get_pw_session_owner",
                        lambda sid: {"S_ALICE": "alice", "S_BOB": "bob"}.get(sid))
    assert F._refus_session_d_autrui("S_ALICE", "alice") is None
    assert F._refus_session_d_autrui("S_BOB", "alice")["ok"] is False
    assert F._refus_session_d_autrui("S_INCONNUE", "alice")["ok"] is False


def test_start_refuse_une_adresse_interdite_sans_appeler_le_service(monkeypatch):
    from llm_core.tools import firefox_tools as F
    from tests.llm_core._pw_harness import CTX, FakeMCP
    mcp = FakeMCP()
    F.register(mcp)
    appels = []
    monkeypatch.setattr(F, "_req", lambda *a, **k: appels.append(a) or {"ok": True})
    monkeypatch.setattr(F, "_AX_ENABLED", False)
    for url in ("file:///etc/passwd", "http://127.0.0.1:8001/"):
        r = mcp.tools["pw_session"](CTX, "start", url=url)
        assert r["ok"] is False and "politique du navigateur" in r["message"]
    monkeypatch.setattr("llm_core._pw_session.get_pw_session_owner", lambda sid: "guest")
    r = mcp.tools["pw_act"](CTX, "S1", action="goto", url="http://169.254.169.254/")
    assert r["ok"] is False
    assert appels == []


def test_detection_ax_transmet_le_proprietaire(monkeypatch):
    import urllib.request

    from shared_infra.memory.ax.detection import detect_session_url
    msgs = [{"role": "tool", "content": '{"session_id":"abcdef12"}'}]
    demandes = []

    class _R:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b'{"url": "https://exemple.org/"}'

    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout=None: demandes.append(req.full_url) or _R())
    assert detect_session_url(msgs) is None and demandes == []          # sans compte : rien
    assert detect_session_url(msgs, owner="alice") == "https://exemple.org/"
    assert "owner=alice" in demandes[0] and "session_id=abcdef12" in demandes[0]
