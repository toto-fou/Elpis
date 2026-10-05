# SPDX-License-Identifier: MIT
"""États du navigateur enregistrés avant la 0.0.1 (``state_<id>.json``, sans
propriétaire) : ``./elpis browser states`` les liste, ``./elpis browser
migrate-states COMPTE ID…|--all`` les rattache au compte, sous le propriétaire
que transmettent les outils (même ``load_state_id`` ensuite) ; l'outil
``pw_session`` rend l'explication du service au lieu de « Session not found »."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from shared_infra.ops.browser_states import main

RACINE = Path(__file__).resolve().parents[2]
ID1 = "0a1b2c3d-1111-2222-3333-444455556666"
ID2 = "9f8e7d6c-5555-6666-7777-888899990000"
IL_Y_A_UN_AN = time.time() - 365 * 86400


def _etat(dossier, nom, *, domaines=(), origines=(), mtime=IL_Y_A_UN_AN):
    chemin = dossier / nom
    chemin.write_text(json.dumps({
        "cookies": [{"name": "jeton", "value": f"SECRET-{d}", "domain": d, "path": "/"} for d in domaines],
        "origins": [{"origin": o, "localStorage": [{"name": "k", "value": "SECRET"}]} for o in origines],
    }), encoding="utf-8")
    os.utime(chemin, (mtime, mtime))
    return chemin


@pytest.fixture
def cookies(tmp_path, monkeypatch):
    comptes = {"alice", "rené", "jean dupont"}
    monkeypatch.setattr("shared_infra.accounts.users.get_user",
                        lambda u: {"username": u} if u in comptes else None)
    d = tmp_path / "cookies"
    d.mkdir()
    return d


def _lancer(capsys, *args):
    code = main(list(args))
    sortie = capsys.readouterr()
    return code, sortie.out, sortie.err


def test_rattache_tous_les_etats_sans_compte(cookies, capsys):
    _etat(cookies, f"state_{ID1}.json", domaines=[".intranet.lan"])
    _etat(cookies, f"state_{ID2}.json")
    autre = _etat(cookies, f"state_bob__{ID1}.json")
    note = _etat(cookies, "notes.txt")
    avant = time.time() - 5

    code, out, err = _lancer(capsys, "migrate-states", "alice", "--all", "--dir", str(cookies))

    assert (code, err) == (0, "")
    for i in (ID1, ID2):
        nouveau = cookies / f"state_alice__{i}.json"
        assert nouveau.is_file() and not (cookies / f"state_{i}.json").exists()
        # Date remise à zéro : la purge des 30 jours ne l'efface pas aussitôt.
        assert nouveau.stat().st_mtime >= avant
    assert "SECRET-.intranet.lan" in (cookies / f"state_alice__{ID1}.json").read_text()
    assert autre.stat().st_mtime == pytest.approx(IL_Y_A_UN_AN)
    assert note.exists()
    assert "intranet.lan" in out                       # ce qui est remis au compte
    assert "2 état(s) rattaché(s) au compte alice" in out and "pendant 30 jours" in out


@pytest.mark.parametrize("compte", ["alice", "rené", "jean dupont"], ids=["canonique", "accent", "espace"])
def test_meme_proprietaire_que_l_outil(cookies, capsys, monkeypatch, compte):
    """Le nom du fichier rattaché est celui que ``pw_session(start)`` cherchera
    pour ce compte (nom assaini par ``get_username``, puis ``pw_owner``)."""
    from llm_core.tools import firefox_tools as F
    from tests.llm_core._pw_harness import FakeMCP
    mcp = FakeMCP()
    F.register(mcp)
    monkeypatch.setattr(F, "_AX_ENABLED", False)
    monkeypatch.setattr(F, "_refus_url", lambda url: None)
    envoyes = []
    monkeypatch.setattr(F.requests, "post", lambda url, json=None, timeout=None:
                        envoyes.append(json) or _Reponse(404, {"error": "x", "code": "state_not_found"}))
    ctx = SimpleNamespace(request_context=SimpleNamespace(meta={"username": compte}))
    mcp.tools["pw_session"](ctx, "start", url="https://exemple.org/", load_state_id=ID1)
    owner = envoyes[0]["owner"]

    _etat(cookies, f"state_{ID1}.json")
    code, _, _ = _lancer(capsys, "migrate-states", compte, ID1, "--dir", str(cookies))
    assert code == 0
    assert (cookies / f"state_{owner}__{ID1}.json").is_file()


def test_seulement_les_identifiants_donnes(cookies, capsys):
    _etat(cookies, f"state_{ID1}.json")
    _etat(cookies, f"state_{ID2}.json")
    code, out, err = _lancer(capsys, "migrate-states", "alice", ID2, ID2, "inconnu-0000", "../x",
                             "--dir", str(cookies))
    assert code == 1
    assert (cookies / f"state_alice__{ID2}.json").is_file()
    assert (cookies / f"state_{ID1}.json").is_file()
    assert out.count(f"state_{ID2}.json →") == 1 and "déjà rattaché" not in out
    assert "inconnu-0000 : aucun état sans compte" in err
    assert "../x : identifiant invalide" in err


@pytest.mark.parametrize("args", [[], [ID1, "--all"]], ids=["ni-id-ni-all", "id-et-all"])
def test_tous_seulement_sur_demande_explicite(cookies, capsys, args):
    ancien = _etat(cookies, f"state_{ID1}.json")
    code, _, err = _lancer(capsys, "migrate-states", "alice", *args, "--dir", str(cookies))
    assert code == 2 and ancien.is_file() and "--all" in err


@pytest.mark.parametrize("compte", ["", "  ", "é"], ids=["vide", "espaces", "sans-caractere-sur"])
def test_jamais_rattache_a_l_identite_anonyme(cookies, capsys, compte):
    """« é » se réduit à « guest » chez les outils : l'identité de tout appel
    sans compte."""
    ancien = _etat(cookies, f"state_{ID1}.json")
    code, _, _ = _lancer(capsys, "migrate-states", compte, ID1, "--no-check", "--dir", str(cookies))
    assert code == 2 and ancien.is_file()
    assert not list(cookies.glob("state_*__*.json"))


def test_jamais_d_ecrasement(cookies, capsys):
    ancien = _etat(cookies, f"state_{ID1}.json", domaines=["ancien.example"])
    _etat(cookies, f"state_alice__{ID1}.json", domaines=["actuel.example"])
    code, _, err = _lancer(capsys, "migrate-states", "alice", ID1, "--dir", str(cookies))
    assert code == 1 and "existe déjà" in err
    assert ancien.is_file()
    assert "actuel.example" in (cookies / f"state_alice__{ID1}.json").read_text()


def test_relancer_apres_rattachement_ne_fait_rien(cookies, capsys):
    _etat(cookies, f"state_{ID1}.json")
    assert _lancer(capsys, "migrate-states", "alice", ID1, "--dir", str(cookies))[0] == 0
    code, out, err = _lancer(capsys, "migrate-states", "alice", ID1, "--dir", str(cookies))
    assert (code, err) == (0, "")
    assert "déjà rattaché" in out


def test_essai_ne_touche_a_rien(cookies, capsys):
    ancien = _etat(cookies, f"state_{ID1}.json")
    code, out, _ = _lancer(capsys, "migrate-states", "alice", "--all", "--dry-run", "--dir", str(cookies))
    assert code == 0
    assert ancien.is_file() and ancien.stat().st_mtime == pytest.approx(IL_Y_A_UN_AN)
    assert not (cookies / f"state_alice__{ID1}.json").exists()
    assert f"state_{ID1}.json → state_alice__{ID1}.json" in out and "rien n'a été renommé" in out


def test_compte_verifie_dans_la_base(cookies, capsys, monkeypatch):
    ancien = _etat(cookies, f"state_{ID1}.json")
    code, _, err = _lancer(capsys, "migrate-states", "alcie", ID1, "--dir", str(cookies))
    assert code == 2 and "Compte Elpis inconnu" in err and ancien.is_file()

    def base_tombee(u):
        raise ConnectionError("refusée")

    monkeypatch.setattr("shared_infra.accounts.users.get_user", base_tombee)
    code, _, err = _lancer(capsys, "migrate-states", "alice", ID1, "--dir", str(cookies))
    assert code == 2 and "ConnectionError" in err and "--no-check" in err and ancien.is_file()

    code, out, _ = _lancer(capsys, "migrate-states", "alice", ID1, "--no-check", "--dir", str(cookies))
    assert code == 0 and (cookies / f"state_alice__{ID1}.json").is_file()
    assert "compte non vérifié" in out


def test_un_renommage_refuse_n_arrete_pas_les_autres(cookies, capsys, monkeypatch):
    bloque = _etat(cookies, f"state_{ID1}.json")
    _etat(cookies, f"state_{ID2}.json")
    vrai_rename = os.rename

    def rename(src, dst):
        if Path(src) == bloque:
            raise PermissionError(13, "Permission denied")
        vrai_rename(src, dst)

    monkeypatch.setattr(os, "rename", rename)
    code, _, err = _lancer(capsys, "migrate-states", "alice", "--all", "--dir", str(cookies))
    assert code == 1 and f"{ID1} : Permission denied" in err
    assert (cookies / f"state_alice__{ID2}.json").is_file()
    # L'état resté sous l'ancien nom garde sa date d'origine (indice du compte).
    assert bloque.is_file() and bloque.stat().st_mtime == pytest.approx(IL_Y_A_UN_AN)


def test_duree_de_conservation_annoncee(cookies, capsys, monkeypatch):
    _etat(cookies, f"state_{ID1}.json")
    monkeypatch.setenv("PW_STATE_MAX_AGE_D", "0")
    code, out, _ = _lancer(capsys, "migrate-states", "alice", ID1, "--dir", str(cookies))
    assert code == 0 and "sans limite de durée" in out


def test_liste_les_sites_sans_les_valeurs(cookies, capsys):
    _etat(cookies, f"state_{ID1}.json", domaines=[".intranet.lan", "github.com"],
          origines=["https://wiki.corp:8443"])
    (cookies / f"state_{ID2}.json").write_text("pas du json", encoding="utf-8")
    (cookies / "state_0f0f0f0f-aaaa.json").write_text('{"cookies": 5, "origins": "x"}', encoding="utf-8")
    _etat(cookies, f"state_alice__{ID1}.json", domaines=["rattache.example"])

    code, out, _ = _lancer(capsys, "states", "--dir", str(cookies))

    assert code == 0
    assert "3 état(s)" in out
    assert ID1 in out and "github.com, intranet.lan, wiki.corp" in out
    assert "illisible" in out and "(aucun site)" in out
    assert "SECRET" not in out and "rattache.example" not in out
    assert "rm " in out                                # comment se défaire d'un état
    assert _lancer(capsys, "states", "--count", "--dir", str(cookies))[1] == "3\n"


def test_dossier_absent_ou_illisible(tmp_path, capsys):
    assert _lancer(capsys, "states", "--count", "--dir", str(tmp_path / "absent"))[1] == "0\n"
    fichier = tmp_path / "fichier"
    fichier.write_text("x")
    code, _, err = _lancer(capsys, "states", "--dir", str(fichier))
    assert code == 2 and str(fichier) in err
    code, _, err = _lancer(capsys, "migrate-states", "alice", ID1, "--no-check",
                           "--dir", str(tmp_path / "absent"))
    assert code == 2 and "Dossier introuvable" in err


def test_point_d_entree_du_module(cookies):
    """``./elpis browser`` et la ligne de ``./elpis doctor`` passent par
    ``python -m`` : code de sortie et sortie de ``--count``."""
    _etat(cookies, f"state_{ID1}.json")
    module = [sys.executable, "-m", "shared_infra.ops.browser_states"]
    r = subprocess.run([*module, "states", "--count", "--dir", str(cookies)],
                       cwd=RACINE, capture_output=True, text=True, timeout=60)
    assert (r.returncode, r.stdout) == (0, "1\n"), r.stderr
    r = subprocess.run([*module, "migrate-states", "alice", "inconnu-0000", "--no-check",
                        "--dir", str(cookies)], cwd=RACINE, capture_output=True, text=True, timeout=60)
    assert r.returncode == 1, r.stderr


# ── Outil pw_session : l'explication du service arrive au modèle ─────────────

class _Reponse:
    def __init__(self, status, corps):
        self.status_code, self._corps, self.text = status, corps, str(corps)

    def json(self):
        if isinstance(self._corps, str):
            raise ValueError("pas du JSON")
        return self._corps


def _start_avec(monkeypatch, reponse):
    from llm_core.tools import firefox_tools as F
    from tests.llm_core._pw_harness import CTX, FakeMCP
    mcp = FakeMCP()
    F.register(mcp)
    monkeypatch.setattr(F, "_AX_ENABLED", False)
    monkeypatch.setattr(F, "_refus_url", lambda url: None)
    envoyes = []
    monkeypatch.setattr(F.requests, "post",
                        lambda url, json=None, timeout=None: envoyes.append((url, json)) or reponse)
    r = mcp.tools["pw_session"](CTX, "start", url="https://exemple.org/", load_state_id=ID1)
    assert envoyes and envoyes[0][0].endswith("/start") and envoyes[0][1]["load_state_id"] == ID1
    return r


def test_start_rend_la_marche_a_suivre_pour_un_etat_sans_compte(monkeypatch):
    corps = {"error": "État sauvegardé avant la version 0.0.1 d'Elpis : …", "code": "legacy_state",
             "fix": f"./elpis browser migrate-states <compte> {ID1} …"}
    r = _start_avec(monkeypatch, _Reponse(404, corps))
    assert r["ok"] is False and r["error"] == "legacy_state"
    assert r["message"] == corps["error"] and r["fix"] == corps["fix"]


@pytest.mark.parametrize("corps", [{"error": "Session introuvable."}, "pas du JSON", ["liste"]],
                         ids=["sans-code", "non-json", "non-objet"])
def test_un_404_sans_code_reste_session_introuvable(monkeypatch, corps):
    r = _start_avec(monkeypatch, _Reponse(404, corps))
    assert r["ok"] is False and r["error"] == "session_not_found"


def test_les_autres_erreurs_gardent_le_message_du_service(monkeypatch):
    r = _start_avec(monkeypatch, _Reponse(502, {"error": "Navigation échouée vers https://exemple.org/"}))
    assert r["ok"] is False and r["message"] == "Navigation échouée vers https://exemple.org/"
    r = _start_avec(monkeypatch, _Reponse(500, "<html>panne</html>"))
    assert r["message"] == "Playwright error (500)" and r["fix"] == "<html>panne</html>"
