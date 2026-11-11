# SPDX-License-Identifier: MIT
"""tests/sandbox/test_agent_jobs_2026_10_17.py — jobs de fond de l'agent du bac (shell_job, lot L1)."""
from __future__ import annotations

import contextlib
import json
import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import httpx
import pytest

from tests.agent_bac import S


class _Bac:
    """Agent en thread sur un socket unix court ; ``relancer`` simule un agent relancé (nouvelle version)."""

    def __init__(self) -> None:
        self.dossier = Path(tempfile.mkdtemp(prefix="jb-"))
        self.work = self.dossier / "w"
        self.work.mkdir()
        self.socket = str(self.dossier / "a.sock")
        self.ids: set = set()
        self.srv = None
        self.demarrer()

    def demarrer(self) -> None:
        self.srv = S.servir(str(self.work), self.socket)
        threading.Thread(target=self.srv.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()

    def arreter(self) -> None:
        if self.srv is not None:
            self.srv.shutdown()
            self.srv.server_close()
            self.srv = None

    def relancer(self) -> None:
        self.arreter()
        self.demarrer()

    def client(self, timeout: float = 30) -> httpx.Client:
        return httpx.Client(transport=httpx.HTTPTransport(uds=self.socket), base_url="http://agent",
                            timeout=timeout)

    def id(self) -> str:
        ident = "j-" + secrets.token_hex(4)
        self.ids.add(ident)
        return ident

    def bg(self, nom: str = "") -> Path:
        return self.work / ".bg" / nom

    def nettoyer(self) -> None:
        self.arreter()
        for pid in _pids_marques(self.ids):
            with contextlib.suppress(OSError):
                os.kill(pid, signal.SIGKILL)
        shutil.rmtree(self.dossier, ignore_errors=True)


def _pids_marques(ids) -> set:
    """Processus vivants (zombies exclus) qui portent ELPIS_JOB_ID=<un des ids>."""
    marqueurs = [b"\0ELPIS_JOB_ID=" + i.encode() + b"\0" for i in ids]
    trouves = set()
    for nom in os.listdir("/proc"):
        if not nom.isdigit():
            continue
        try:
            stat = Path(f"/proc/{nom}/stat").read_bytes()
            if stat[stat.rindex(b")") + 2:].split()[0] in (b"Z", b"X"):
                continue
            env = b"\0" + Path(f"/proc/{nom}/environ").read_bytes()
        except (OSError, ValueError):
            continue
        if any(m in env for m in marqueurs):
            trouves.add(int(nom))
    return trouves


def _trieurs() -> list:
    """Processus de regex (trieurs) lancés par l'agent de ce test, zombies exclus."""
    moi, rendu = os.getpid(), []
    for nom in os.listdir("/proc"):
        if not nom.isdigit():
            continue
        try:
            stat = Path(f"/proc/{nom}/stat").read_bytes()
            champs = stat[stat.rindex(b")") + 2:].split()
            if (int(champs[1]) == moi and champs[0] not in (b"Z", b"X")
                    and b"import base64, json, re, sys" in Path(f"/proc/{nom}/cmdline").read_bytes()):
                rendu.append(int(nom))
        except (OSError, ValueError):
            continue
    return rendu


@pytest.fixture
def bac():
    b = _Bac()
    yield b
    b.nettoyer()


def _attendre(cond, delai: float = 10.0, pas: float = 0.05):
    fin = time.monotonic() + delai
    while time.monotonic() < fin:
        v = cond()
        if v:
            return v
        time.sleep(pas)
    return cond()


def _lancer(c: httpx.Client, ident: str, commande: str, **kw) -> dict:
    r = c.post("/v1/jobs/start", json={"id": ident, "command": commande, **kw})
    assert r.status_code == 200, r.text
    return r.json()


def _veiller(c: httpx.Client, depuis: int = 0, attente: float = 10.0) -> list:
    r = c.post("/v1/jobs/watch", json={"since_seq": depuis, "wait_s": attente},
               headers={"X-Elpis-Passive": "1"}, timeout=attente + 10)
    assert r.status_code == 200, r.text
    return [json.loads(x) for x in r.text.splitlines() if x]


def _evenements(lignes: list) -> list:
    return [x for x in lignes if "seq" in x]


def _attendre_evenement(c: httpx.Client, ident: str, trigger: str, delai: float = 10.0) -> dict:
    """Premier événement ``trigger`` du job, par des watch successifs."""
    fin, depuis = time.monotonic() + delai, 0
    while time.monotonic() < fin:
        lignes = _veiller(c, depuis, min(5.0, max(0.1, fin - time.monotonic())))
        for e in _evenements(lignes):
            if e["job_id"] == ident and e["trigger"] == trigger:
                return e
        depuis = lignes[-1]["last_seq"]
    raise AssertionError(f"pas d'événement {trigger} pour {ident}")


def _collecter(c: httpx.Client, ids: set, depuis: int, delai: float = 10.0) -> dict:
    """Premier événement de chacun des ``ids`` après ``depuis``."""
    trouves: dict = {}
    fin = time.monotonic() + delai
    while set(trouves) != ids and time.monotonic() < fin:
        lignes = _veiller(c, depuis, 2)
        for e in _evenements(lignes):
            if e["job_id"] in ids:
                trouves.setdefault(e["job_id"], e)
        depuis = lignes[-1]["last_seq"]
    return trouves


def _etat(c: httpx.Client, ident: str) -> dict:
    r = c.get("/v1/jobs/status", params={"id": ident})
    assert r.status_code == 200, r.text
    return r.json()["jobs"][0]


def _tuer(c: httpx.Client, ident: str, **kw) -> httpx.Response:
    return c.post("/v1/jobs/kill", json={"id": ident, "grace_s": 2, **kw})


def _port_libre() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# ── fin, codes ──────────────────────────────────────────────────────────────

def test_jb01_exit_d_une_commande_courte_evenement_en_moins_de_5_s(bac):
    with bac.client() as c:
        ident = bac.id()
        debut = time.monotonic()
        r = _lancer(c, ident, "sleep 1; echo fini", label="court")
        assert r["state"] == "running" and r["log"] == f".bg/job-{ident}.log" and r["wake_on"] == ["exit"]
        lignes = _veiller(c, 0, 20)
        (e,) = _evenements(lignes)
        assert time.monotonic() - debut < 5
        assert (e["trigger"], e["spec"], e["state"], e["exit_code"], e["signal"]) == (
            "exit", "exit", "exited", 0, None)
        assert e["tail"] == ["fini"] and e["log_lines"] == 1 and e["log_bytes"] == 5
        assert e["duration_s"] >= 1 and e["still_running"] is False and e["seq"] == 1
        assert lignes[-1] == {"done": True, "last_seq": 1, "running": 0, "reset": False}
        fiche = json.loads(bac.bg(f"job-{ident}.json").read_text())
        assert fiche["state"] == "exited" and fiche["exit_code"] == 0 and fiche["fired"] == ["exit"]
        assert fiche["label"] == "court" and fiche["starttime"] > 0
        assert bac.bg(f"job-{ident}.exit").read_text() == "0\n"
        assert not bac.bg(f"job-{ident}.exit.tmp").exists()


def test_jb02_exit_1_et_signal_jamais_confondus_avec_un_succes(bac):
    with bac.client() as c:
        un, tue = bac.id(), bac.id()
        _lancer(c, un, "echo raté >&2; exit 1")
        _lancer(c, tue, "kill -KILL $$")
        e1 = _attendre_evenement(c, un, "exit")
        e2 = _attendre_evenement(c, tue, "exit")
        assert (e1["state"], e1["exit_code"], e1["signal"], e1["tail"]) == ("exited", 1, None, ["raté"])
        assert (e2["state"], e2["exit_code"], e2["signal"]) == ("exited", 137, "SIGKILL")
        assert _etat(c, un)["exit_code"] == 1 and _etat(c, un)["state"] == "exited"


# ── déclencheurs ────────────────────────────────────────────────────────────

def test_jb03_match_et_regex_cinq_lignes_de_contexte_le_job_continue(bac):
    with bac.client() as c:
        ident = bac.id()
        cmd = ("for i in 1 2 3 4 5 6 7 8; do echo avant$i; done; echo 'Listening on :8000'; "
               "for i in 1 2 3 4 5 6 7; do echo apres$i; done; sleep 60")
        _lancer(c, ident, cmd, wake_on=["match:Listening on", "regex:^apres[67]$"])
        e = _attendre_evenement(c, ident, "match")
        assert e["spec"] == "match:Listening on" and e["line"] == "Listening on :8000"
        assert e["context"] == [*(f"avant{i}" for i in range(4, 9)), "Listening on :8000",
                                *(f"apres{i}" for i in range(1, 6))]
        assert e["still_running"] is True and e["state"] == "running" and e["exit_code"] is None
        r = _attendre_evenement(c, ident, "regex")
        assert r["line"] == "apres6" and r["context"] == [f"apres{i}" for i in range(1, 8)]
        etat = _etat(c, ident)
        assert etat["alive"] and etat["state"] == "running"
        assert etat["fired"] == ["match:Listening on", "regex:^apres[67]$"]   # chacun une seule fois
        assert etat["last_line"] == "apres7" and etat["log_lines"] == 16
        assert [x["trigger"] for x in _evenements(_veiller(c, 0, 0))] == ["match", "regex"]
        assert _tuer(c, ident).status_code == 200


def test_jb03_match_coupe_entre_deux_lectures_et_bavardage_sans_motif(bac):
    with bac.client() as c:
        ident = bac.id()
        _lancer(c, ident, "seq 50000; printf 'Liste'; sleep 0.8; printf 'ning on\\n'; sleep 60",
                wake_on=["match:Listening on"])
        e = _attendre_evenement(c, ident, "match")
        assert e["line"] == "Listening on" and e["context"][:5] == [str(i) for i in range(49996, 50001)]
        assert e["log_lines"] == 50001
        assert _tuer(c, ident).status_code == 200


def test_jb04_port_en_ecoute_sans_rien_ecrire(bac):
    port = _port_libre()
    with bac.client() as c:
        ident = bac.id()
        prog = (f"import socket,time; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); "
                f"s.bind(('127.0.0.1', {port})); time.sleep(1); s.listen(); time.sleep(60)")
        _lancer(c, ident, f"python3 -c \"{prog}\"", wake_on=[f"port:{port}"])
        e = _attendre_evenement(c, ident, "port")
        assert e["spec"] == f"port:{port}" and e["still_running"] is True
        assert e["log_bytes"] == 0 and e["tail"] == []
        assert _tuer(c, ident).status_code == 200


def test_jb05_fichier_apparu_puis_silence(bac, monkeypatch):
    monkeypatch.setitem(S._JOBS_BORNES, "idle", (1, 3600))
    with bac.client() as c:
        ident = bac.id()
        (bac.work / "sortie").mkdir()
        _lancer(c, ident, "echo début; sleep 0.6; touch sortie/fait.txt; sleep 60",
                wake_on=["file:sortie/fait.txt", "idle:2"])
        f = _attendre_evenement(c, ident, "file")
        assert f["spec"] == "file:sortie/fait.txt" and f["still_running"] is True
        i = _attendre_evenement(c, ident, "idle")
        assert i["spec"] == "idle:2" and i["tail"] == ["début"] and i["ts"] - f["ts"] >= 1
        assert _tuer(c, ident).status_code == 200


def test_jb06_timeout_signale_le_job_toujours_actif_sans_le_tuer(bac):
    with bac.client() as c:
        ident = bac.id()
        _lancer(c, ident, "sleep 60", wake_on=["timeout:1"])
        e = _attendre_evenement(c, ident, "timeout")
        assert e["still_running"] is True and e["state"] == "running" and e["duration_s"] >= 1
        time.sleep(0.6)
        assert _etat(c, ident)["alive"] is True
        assert _tuer(c, ident).status_code == 200


# ── regex : bornes, trieur hors processus ───────────────────────────────────

def test_regex_a_trois_quantificateurs_refusee_deux_acceptes(bac):
    with bac.client() as c:
        r = c.post("/v1/jobs/start", json={"id": bac.id(), "command": "true", "wake_on": ["regex:a*b+c*"]})
        assert (r.status_code, r.json()["error"]) == (400, "bad_request")
        assert r.json()["message"] == "regex: at most 2 unbounded quantifiers (*, +, {n,})"
        r = c.post("/v1/jobs/start", json={"id": bac.id(), "command": "true", "wake_on": ["regex:("]})
        assert r.json()["message"].startswith("invalid regex: ")
        _lancer(c, bac.id(), "true", wake_on=[r"regex:\d+ failed, \d+ passed", r"regex:[*+]+\*+a{2,9}"])


def test_regex_sur_les_1024_premiers_caracteres_match_sur_4_ko(bac):
    with bac.client() as c:
        ident = bac.id()
        _lancer(c, ident, "printf '%2000s' '' | tr ' ' a; echo MARQUE; sleep 0.8; echo MARQUE; sleep 60",
                wake_on=["regex:MARQUE", "match:MARQUE"])
        m = _attendre_evenement(c, ident, "match")
        r = _attendre_evenement(c, ident, "regex")
        assert m["line"] == "a" * 199 + "…"                 # trouvé au 2 001e caractère : le littéral voit 4 Ko
        assert r["line"] == "MARQUE" and r["context"][0] == "a" * 199 + "…"   # la regex, la ligne d'après
        assert _tuer(c, ident).status_code == 200


def test_ligne_de_4_ko_et_regex_couteuse_traitee_en_temps_borne(bac):
    with bac.client() as c:
        ident = bac.id()
        debut = time.monotonic()
        _lancer(c, ident, "printf '%4096s\\n' '' | tr ' ' a; sleep 0.5; echo x; sleep 60",
                wake_on=["regex:.*.*x", "timeout:2"])
        r = _attendre_evenement(c, ident, "regex")
        assert r["line"] == "x" and time.monotonic() - debut < 4
        t = _attendre_evenement(c, ident, "timeout")
        assert t["duration_s"] < 3                            # à l'heure malgré la regex
        assert _etat(c, ident)["disarmed"] == []
        assert _tuer(c, ident).status_code == 200


def test_regex_pathologique_desarmee_sans_bloquer_le_fil_http(bac, monkeypatch):
    monkeypatch.setattr(S, "_JOBS_REGEX_MAX_S", 1.0)
    with bac.client() as c:
        ident = bac.id()
        _lancer(c, ident, "printf '%1024s\\n' '' | tr ' ' a; sleep 2.5; echo fin; exit 4",
                wake_on=["regex:(?:a|aa)*b"])                 # exponentielle sur 1 024 « a »
        assert _attendre(_trieurs)
        pire, fin = 0.0, time.monotonic() + 1.5
        while time.monotonic() < fin:                        # le trieur calcule : l'agent répond
            t = time.monotonic()
            assert c.get("/v1/hello").status_code == 200
            assert c.get("/v1/jobs/status", params={"id": ident}).status_code == 200
            pire = max(pire, time.monotonic() - t)
            time.sleep(0.02)
        assert pire < 0.5
        etat = _attendre(lambda: (lambda j: j if j["disarmed"] else None)(_etat(c, ident)), 5)
        assert etat["disarmed"] == [{"spec": "regex:(?:a|aa)*b", "reason": "regex disarmed: too slow"}]
        assert _attendre(lambda: not _trieurs(), 3)          # tué
        e = _attendre_evenement(c, ident, "exit")
        assert (e["exit_code"], e["log_lines"], e["tail"][-1]) == (4, 2, "fin")   # aucune ligne perdue
        assert json.loads(bac.bg(f"job-{ident}.json").read_text())["disarmed"] == etat["disarmed"]


def test_jb01_exit_a_l_heure_pendant_qu_un_job_deverse_50_mo_motif_arme(bac, monkeypatch):
    monkeypatch.setitem(S._JOBS_BORNES, "idle", (1, 3600))
    with bac.client() as c:
        bavard, court = bac.id(), bac.id()
        debut_bavard = time.monotonic()
        _lancer(c, bavard, "yes 'du bruit, encore du bruit' | head -c 52428800; sleep 60",
                wake_on=["match:JAMAIS", "regex:^JAMAIS[0-9]+$", "idle:2"])
        assert _attendre(lambda: _etat(c, bavard)["log_bytes"] == 52428800)
        debut = time.monotonic()
        _lancer(c, court, "sleep 1; exit 3")
        e = _attendre_evenement(c, court, "exit")
        assert e["exit_code"] == 3 and time.monotonic() - debut < 3
        i = _attendre_evenement(c, bavard, "idle")            # silence mesuré sur la taille, pas sur la lecture
        assert time.monotonic() - debut_bavard < 6 and i["still_running"] is True
        etat = _etat(c, bavard)
        assert etat["alive"] and etat["disarmed"] == [] and etat["fired"] == ["idle:2"]
        assert _trieurs()
        assert _tuer(c, bavard, purge=True).status_code == 200
        assert _attendre(lambda: not _trieurs(), 3)          # trieur tué avec le job


def test_trieurs_bornes_un_job_attend_sans_perdre_de_ligne(bac, monkeypatch):
    monkeypatch.setattr(S, "_JOBS_TRIEURS_MAX", 1)
    with bac.client() as c:
        premier, second = bac.id(), bac.id()
        _lancer(c, premier, "seq 20000; sleep 60", wake_on=["regex:^jamais$"])
        assert _attendre(lambda: _etat(c, premier)["log_lines"] == 20000)
        _lancer(c, second, "seq 3; echo TROUVE; exit 0", wake_on=["regex:^TROUVE$"])
        time.sleep(1.5)
        assert len(_trieurs()) == 1 and _etat(c, second)["fired"] == []       # en attente d'un trieur libre
        assert _tuer(c, premier).status_code == 200                           # son trieur part avec lui
        r = _attendre_evenement(c, second, "regex")
        assert r["line"] == "TROUVE" and r["context"] == ["1", "2", "3", "TROUVE"]
        assert _attendre_evenement(c, second, "exit")["log_lines"] == 4
        assert _attendre(lambda: not _trieurs(), 3)


# ── arrêt ───────────────────────────────────────────────────────────────────

def test_jb12_kill_groupe_et_processus_sortis_par_setsid(bac):
    with bac.client() as c:
        ident = bac.id()
        r = _lancer(c, ident, "sleep 300 & setsid sleep 301 & echo prêt; wait")
        _attendre(lambda: _etat(c, ident)["last_line"] == "prêt")
        avant = _attendre(lambda: (lambda p: p if len(p) >= 4 else None)(_pids_marques({ident})))
        assert avant and r["pid"] in avant
        k = _tuer(c, ident, by="user")
        assert k.status_code == 200, k.text
        k = k.json()
        assert set(avant) <= set(k["killed_pids"]) and k["state"] == "killed"
        assert k["signal"] == "SIGTERM" and k["exit_code"] == 143
        assert _attendre(lambda: not _pids_marques({ident}), 3)          # « ps » vide
        e = _attendre_evenement(c, ident, "killed")
        assert e["by"] == "user" and e["state"] == "killed" and e["still_running"] is False
        assert "prêt" in e["tail"]
        assert _etat(c, ident)["state"] == "killed"
        r = _tuer(c, ident)
        assert (r.status_code, r.json()["error"]) == (409, "job_not_running")
        r = _tuer(c, "j-" + "0" * 8)
        assert (r.status_code, r.json()["error"]) == (404, "job_not_found")


def test_kill_apres_la_fin_attrape_les_processus_restes_vivants(bac):
    with bac.client() as c:
        ident = bac.id()
        _lancer(c, ident, "setsid sleep 302 & exit 0")
        _attendre_evenement(c, ident, "exit")
        reste = _attendre(lambda: _pids_marques({ident}))
        k = _tuer(c, ident, signal="KILL")
        assert k.status_code == 200 and set(reste) <= set(k.json()["killed_pids"])
        assert k.json()["state"] == "exited"
        assert _attendre(lambda: not _pids_marques({ident}), 3)


def test_kill_apres_la_grace_le_job_qui_ignore_term_recoit_kill(bac):
    with bac.client() as c:
        ident = bac.id()
        _lancer(c, ident, "trap '' TERM; echo prêt; while :; do sleep 0.1; done")
        _attendre(lambda: _etat(c, ident)["last_line"] == "prêt")
        debut = time.monotonic()
        k = c.post("/v1/jobs/kill", json={"id": ident, "grace_s": 0.5})
        assert k.status_code == 200 and k.json()["state"] == "killed"
        assert 0.4 < time.monotonic() - debut < 5
        assert _attendre(lambda: not _pids_marques({ident}), 3)


def test_jb20_purge_retire_les_fichiers_et_oublie_le_job(bac):
    with bac.client() as c:
        vivant, fini = bac.id(), bac.id()
        _lancer(c, vivant, "echo x; sleep 60")
        _lancer(c, fini, "true")
        _attendre_evenement(c, fini, "exit")
        k = _tuer(c, vivant, by="core", purge=True)
        assert k.status_code == 200 and k.json()["state"] == "killed"
        assert _tuer(c, fini, purge=True).status_code == 200
        assert not any(p.name.startswith("job-") for p in bac.bg().iterdir())
        for ident in (vivant, fini):
            assert c.get("/v1/jobs/status", params={"id": ident}).json()["error"] == "job_not_found"
        assert c.get("/v1/jobs/list").json()["jobs"] == []
        assert not _pids_marques({vivant})


def test_purge_d_un_job_sans_fiche(bac):
    with bac.client() as c:
        ident = bac.id()
        bac.bg().mkdir()
        bac.bg(f"job-{ident}.log").write_text("reste")
        r = _tuer(c, ident)
        assert (r.status_code, r.json()["error"]) == (404, "job_not_found")
        r = _tuer(c, ident, purge=True)
        assert r.status_code == 200 and r.json()["killed_pids"] == []
        assert not bac.bg(f"job-{ident}.log").exists()


# ── reprise par un agent relancé ────────────────────────────────────────────

def test_jb13_agent_autonome_tue_le_job_survit_et_son_code_est_rattrape(bac):
    """Agent seul (``python3 -I -S``) tué par SIGKILL : sans tube, le job continue ; l'agent suivant rend son code."""
    bac.arreter()
    cmd = [sys.executable, "-I", "-S", S.__file__, "--root", str(bac.work), "--socket", bac.socket]
    agent = subprocess.Popen(cmd, cwd=bac.dossier)
    try:
        with bac.client() as c:
            assert _attendre(lambda: _repond(c))
            ident = bac.id()
            _lancer(c, ident, "echo début; sleep 2; echo fin; exit 7")
        agent.kill()
        agent.wait(10)
        assert _pids_marques({ident})                    # le job tourne sans agent
        assert _attendre(lambda: bac.bg(f"job-{ident}.exit").exists(), 10)
        agent = subprocess.Popen(cmd, cwd=bac.dossier)
        with bac.client() as c:
            assert _attendre(lambda: _repond(c))
            e = _attendre_evenement(c, ident, "exit")
            assert (e["exit_code"], e["tail"], e["state"]) == (7, ["début", "fin"], "exited")
    finally:
        agent.kill()
        agent.wait(10)


def _repond(c: httpx.Client) -> bool:
    try:
        return c.get("/v1/hello").status_code == 200
    except (httpx.HTTPError, OSError):
        return False


def test_jb13_agent_relance_vivant_repris_exit_rattrape_sinon_lost(bac):
    with bac.client() as c:
        vivant, fini, perdu, reutilise = bac.id(), bac.id(), bac.id(), bac.id()
        _lancer(c, vivant, "echo a; sleep 5; echo b; exit 5")
        _lancer(c, fini, "sleep 1.5; echo fin; exit 4")
        _lancer(c, perdu, "sleep 60")
        _lancer(c, reutilise, "sleep 60")
        _attendre(lambda: _etat(c, vivant)["last_line"] == "a")
        seq_avant = _veiller(c, 0, 0)[-1]["last_seq"]
    bac.arreter()                                        # plus d'agent : les jobs continuent
    groupe = json.loads(bac.bg(f"job-{perdu}.json").read_text())["pid"]
    os.killpg(groupe, signal.SIGKILL)                    # conteneur « redémarré » : rien d'écrit
    fiche = json.loads(bac.bg(f"job-{reutilise}.json").read_text())
    fiche["starttime"] += 1                              # même pid, autre processus
    bac.bg(f"job-{reutilise}.json").write_text(json.dumps(fiche))
    time.sleep(2)                                        # « fini » se termine sans agent
    assert bac.bg(f"job-{fini}.exit").read_text() == "4\n"
    bac.demarrer()
    with bac.client() as c:
        par_job = _collecter(c, {fini, perdu, reutilise}, seq_avant)
        assert set(par_job) == {fini, perdu, reutilise}
        assert (par_job[fini]["trigger"], par_job[fini]["exit_code"], par_job[fini]["tail"]) == ("exit", 4, ["fin"])
        assert par_job[perdu]["trigger"] == "lost" and par_job[perdu]["state"] == "lost"
        assert par_job[reutilise]["trigger"] == "lost"
        assert min(e["seq"] for e in par_job.values()) == seq_avant + 1      # seq continué
        assert _etat(c, vivant)["state"] == "running"
        e = _attendre_evenement(c, vivant, "exit")
        assert e["exit_code"] == 5 and e["tail"] == ["a", "b"] and e["log_lines"] == 2
        assert e["seq"] > max(x["seq"] for x in par_job.values())
    bac.relancer()                                       # une seconde relance : plus rien à émettre
    with bac.client() as c:
        assert _evenements(_veiller(c, e["seq"], 0)) == []
        etats = {j["id"]: j["state"] for j in c.get("/v1/jobs/list").json()["jobs"]}
        assert etats == {vivant: "exited", fini: "exited", perdu: "lost", reutilise: "lost"}
        assert {j["id"]: j["last_line"] for j in c.get("/v1/jobs/status").json()["jobs"]}[fini] == "fin"


def test_reprise_ne_redouble_pas_un_evenement_deja_emis(bac):
    """Agent mort entre l'événement et la fiche : la fiche est rattrapée, pas d'événement en double."""
    with bac.client() as c:
        ident = bac.id()
        _lancer(c, ident, "exit 2")
        _attendre_evenement(c, ident, "exit")
    bac.arreter()
    fiche = json.loads(bac.bg(f"job-{ident}.json").read_text())
    fiche.update(state="running", exit_code=None, fired=[])
    bac.bg(f"job-{ident}.json").write_text(json.dumps(fiche))
    bac.demarrer()
    with bac.client() as c:
        assert [e["seq"] for e in _evenements(_veiller(c, 0, 0))] == [1]
        assert (_etat(c, ident)["state"], _etat(c, ident)["exit_code"]) == ("exited", 2)


# ── watch ───────────────────────────────────────────────────────────────────

def test_watch_signes_de_vie_puis_bilan(bac):
    with bac.client() as c:
        debut = time.monotonic()
        lignes = _veiller(c, 0, 4.5)
        assert 4.4 < time.monotonic() - debut < 6
        assert sum(1 for x in lignes if x.get("tick")) >= 3            # première ligne, 2 s, 4 s
        assert lignes[-1] == {"done": True, "last_seq": 0, "running": 0, "reset": False}


def test_watch_reveil_immediat_et_regroupement(bac, monkeypatch):
    monkeypatch.setattr(S, "_JOBS_GROUPE_S", 1.0)       # plus qu'un tour du superviseur : regroupement sûr
    with bac.client() as c, bac.client() as c2:
        rendu: list = []
        fil = threading.Thread(target=lambda: rendu.extend(_veiller(c2, 0, 20)))
        fil.start()
        time.sleep(0.3)
        debut = time.monotonic()
        a, b = bac.id(), bac.id()
        _lancer(c, a, "true")
        _lancer(c, b, "true")
        fil.join(25)
        assert time.monotonic() - debut < 3
        assert {e["job_id"] for e in _evenements(rendu)} == {a, b}          # même tour : même réponse
        assert rendu[-1]["last_seq"] == 2


def test_watch_reset_si_le_fichier_a_ete_recree(bac):
    with bac.client() as c:
        ident = bac.id()
        _lancer(c, ident, "true")
        _attendre_evenement(c, ident, "exit")
        lignes = _veiller(c, 999, 5)
        assert lignes[-1]["reset"] is True and lignes[-1]["last_seq"] == 1
        assert [e["seq"] for e in _evenements(lignes)] == [1]           # l'appelant repart de 0
        r = c.post("/v1/jobs/watch", json={"since_seq": -1})
        assert (r.status_code, r.json()["error"]) == (400, "bad_request")


def test_fichier_d_evenements_borne_seq_continue(bac, monkeypatch):
    monkeypatch.setattr(S, "_JOBS_GARDES", 5)
    bac.relancer()                                       # mémoire de l'agent bornée à 5
    with bac.client() as c:
        ids = [bac.id() for _ in range(9)]
        for ident in ids:
            _lancer(c, ident, "true")
            _attendre_evenement(c, ident, "exit")
        lignes = bac.bg("jobs-events.ndjson").read_text().splitlines()
        assert len(lignes) <= 6 and json.loads(lignes[-1])["seq"] == 9
        assert [e["seq"] for e in _evenements(_veiller(c, 0, 0))] == [5, 6, 7, 8, 9]
    bac.relancer()
    with bac.client() as c:
        ident = bac.id()
        _lancer(c, ident, "true")
        assert _attendre_evenement(c, ident, "exit")["seq"] == 10


def test_jb11_chain_depth_dans_chaque_evenement_du_journal_meme_apres_relance(bac):
    with bac.client() as c:
        sans, avec, repris = bac.id(), bac.id(), bac.id()
        _lancer(c, sans, "true")
        _lancer(c, avec, "echo pret; sleep 0.3", chain_depth=3, wake_on=["match:pret"])
        _attendre_evenement(c, sans, "exit")
        _attendre_evenement(c, avec, "match")
        _attendre_evenement(c, avec, "exit")
        _lancer(c, repris, "sleep 1.5", chain_depth=0)
        for v in (-1, "2", True, 1.5, S._JOBS_PROFONDEUR_MAX + 1):
            r = c.post("/v1/jobs/start", json={"id": bac.id(), "command": "true", "chain_depth": v})
            assert (r.status_code, r.json()["error"]) == (400, "bad_request"), v
        assert json.loads(bac.bg(f"job-{repris}.json").read_text())["chain_depth"] == 0
    bac.relancer()                                       # fiche relue : la profondeur suit le job
    with bac.client() as c:
        _attendre_evenement(c, repris, "exit")
    par: dict = {}
    for ligne in bac.bg("jobs-events.ndjson").read_text().splitlines():
        e = json.loads(ligne)
        par.setdefault(e["job_id"], []).append(e)
    assert [("chain_depth" in e) for e in par[sans]] == [False]
    assert sorted(e["trigger"] for e in par[avec]) == ["exit", "match"]
    assert all(e["chain_depth"] == 3 for e in par[avec])
    assert [(e["trigger"], e["chain_depth"]) for e in par[repris]] == [("exit", 0)]


# ── bornes et garde-fous ────────────────────────────────────────────────────

def test_jb15_sortie_de_50_mo_evenement_borne_journal_complet(bac):
    with bac.client() as c:
        ident, ligne_longue = bac.id(), bac.id()
        _lancer(c, ident, "yes \"$(printf 'x%.0s' $(seq 300))\" | head -c 52428800")
        _lancer(c, ligne_longue, "head -c 5000000 /dev/zero | tr '\\0' y; echo; printf 'fin sans retour'")
        e = _attendre_evenement(c, ident, "exit", 30)
        assert len(json.dumps(e, separators=(",", ":"))) <= S._JOBS_EVENEMENT_MAX
        assert 0 < len(e["tail"]) <= 20 and all(len(x) <= 200 for x in e["tail"])
        assert e["log_bytes"] == 52428800 == bac.bg(f"job-{ident}.log").stat().st_size
        assert e["log_lines"] == 52428800 // 301 + 1
        f = _attendre_evenement(c, ligne_longue, "exit", 30)
        assert f["tail"][-1] == "fin sans retour" and len(f["tail"][0]) == 200 and f["log_lines"] == 2
        for j in (ident, ligne_longue):
            assert _tuer(c, j, purge=True).status_code == 200


def test_rotation_du_journal_garde_la_tete(bac, monkeypatch):
    monkeypatch.setattr(S, "_JOBS_JOURNAL_MAX", 200_000)
    monkeypatch.setattr(S, "_JOBS_JOURNAL_TETE", 1000)
    with bac.client() as c:
        ident = bac.id()
        (bac.work / "donnees").write_text("".join(f"ligne{i}\n" for i in range(1, 30001)))
        _lancer(c, ident, "sleep 0.6; cat donnees; sleep 1.5; echo après; sleep 60")
        journal = bac.bg(f"job-{ident}.log")
        assert _attendre(lambda: b"bytes dropped]" in journal.read_bytes() and b"apr" in journal.read_bytes())
        brut = journal.read_bytes()
        assert brut.startswith(b"ligne1\nligne2\n") and len(brut) < 2000
        assert b"[elpis: log truncated, " in brut and brut.count(b"truncated") == 1
        assert _attendre(lambda: _etat(c, ident)["last_line"] == "après")
        assert _tuer(c, ident).status_code == 200


def test_battement_la_fiche_reste_recente(bac, monkeypatch):
    monkeypatch.setattr(S, "_JOBS_BATTEMENT_S", 0.3)
    with bac.client() as c:
        ident = bac.id()
        _lancer(c, ident, "sleep 60")
        fiche = bac.bg(f"job-{ident}.json")
        _attendre(lambda: fiche.exists())
        vieux = time.time() - 3600
        os.utime(fiche, (vieux, vieux))
        assert _attendre(lambda: fiche.stat().st_mtime > time.time() - 60, 3)
        assert _tuer(c, ident).status_code == 200


def test_trop_de_jobs_vivants_et_id_deja_connu(bac, monkeypatch):
    monkeypatch.setattr(S, "_JOBS_VIVANTS_MAX", 2)
    with bac.client() as c:
        a, b = bac.id(), bac.id()
        _lancer(c, a, "sleep 60")
        _lancer(c, b, "sleep 60")
        r = c.post("/v1/jobs/start", json={"id": bac.id(), "command": "true"})
        assert (r.status_code, r.json()["error"], r.json()["max"]) == (429, "too_many_jobs", 2)
        r = c.post("/v1/jobs/start", json={"id": a, "command": "true"})
        assert (r.status_code, r.json()["error"]) == (409, "job_exists")
        for j in (a, b):
            assert _tuer(c, j).status_code == 200


@pytest.mark.parametrize("corps", [
    {"id": None, "command": "true"},
    {"id": "j-1234", "command": "true"},
    {"id": "j-0000000g", "command": "true"},
    {"command": ""},
    {"command": "a\x00b"},
    {"command": "true", "wake_on": "exit"},
    {"command": "true", "wake_on": ["regex:("]},
    {"command": "true", "wake_on": ["regex:(a+)+$"]},
    {"command": "true", "wake_on": ["regex:a*b+c*"]},
    {"command": "true", "wake_on": ["regex:x{2,}y{,}z*"]},
    {"command": "true", "wake_on": ["regex:.*?.+?.*?"]},
    {"command": "true", "wake_on": ["port:0"]},
    {"command": "true", "wake_on": ["port:65536"]},
    {"command": "true", "wake_on": ["idle:5"]},
    {"command": "true", "wake_on": ["timeout:0"]},
    {"command": "true", "wake_on": ["timeout:1e3"]},
    {"command": "true", "wake_on": ["match:"]},
    {"command": "true", "wake_on": ["file:"]},
    {"command": "true", "wake_on": ["foo:bar"]},
    {"command": "true", "wake_on": [f"match:{i}" for i in range(7)]},
    {"command": "true", "env": {"bad-key": "x"}},
    {"command": "true", "env": {"OK": 3}},
    {"command": "true", "env": ["A=1"]},
])
def test_requetes_refusees_400(bac, corps):
    with bac.client() as c:
        corps = {"id": bac.id(), **corps}
        r = c.post("/v1/jobs/start", json=corps)
        assert (r.status_code, r.json()["error"]) == (400, "bad_request"), r.text
    assert not bac.bg().exists() or not any(bac.bg().iterdir())


@pytest.mark.parametrize("corps", [
    {"wake_on": ["file:../../etc/passwd"]},
    {"wake_on": ["file:/etc/passwd"]},
    {"wake_on": ["file:dehors/x"]},
    {"cwd": "../.."},
    {"cwd": "/etc"},
    {"cwd": "dehors"},
])
def test_jb19_chemins_hors_de_la_racine_refuses(bac, corps):
    os.symlink("/etc", bac.work / "dehors")
    with bac.client() as c:
        r = c.post("/v1/jobs/start", json={"id": bac.id(), "command": "true", **corps})
        assert (r.status_code, r.json()["error"]) == (403, "outside_root"), r.text


def test_commande_jamais_interpolee_et_environnement(bac):
    piege = "d$(touch pwned-cwd)`touch pwned-bq`"
    (bac.work / piege).mkdir()
    with bac.client() as c:
        ident = bac.id()
        cmd = ("echo '$(id -u) $HOME'; pwd; echo \"$ELPIS_JOB_ID\"; cat; umask; "
               "touch cree; stat -c %a cree; echo \"$PERSO\"")
        _lancer(c, ident, cmd, cwd=piege, label="$(touch pwned-label)", env={"PERSO": "$(touch pwned-env)"},
                wake_on=["match:$(touch pwned-match)"])
        e = _attendre_evenement(c, ident, "exit")
        assert e["exit_code"] == 0
        assert e["tail"] == ["$(id -u) $HOME", str((bac.work / piege).resolve()), ident, "0022", "644",
                             "$(touch pwned-env)"]
        assert not list(bac.work.rglob("pwned*")) and not list(Path.cwd().glob("pwned*"))
        fiche = json.loads(bac.bg(f"job-{ident}.json").read_text())
        assert fiche["label"] == "$(touch pwned-label)" and fiche["cwd"] == piege


def test_status_et_list(bac):
    with bac.client() as c:
        ident = bac.id()
        _lancer(c, ident, "printf 'un\\ndeux\\ntrois'; sleep 60", wake_on=["timeout:3600"])
        etat = _attendre(lambda: (lambda j: j if j["log_lines"] == 3 else None)(_etat(c, ident)))
        assert etat["alive"] and etat["state"] == "running" and etat["last_line"] == "trois"
        assert etat["wake_on"] == ["exit", "timeout:3600"] and etat["fired"] == [] and etat["log_bytes"] == 13
        assert etat["ended_at"] is None and etat["runtime_s"] >= 0
        etranger = "j-" + "f" * 8
        bac.ids.add(etranger)
        bac.bg(f"job-{etranger}.json").write_text(json.dumps({"id": etranger, "state": "exited", "exit_code": 0}))
        assert [j["id"] for j in c.get("/v1/jobs/status").json()["jobs"]] == [ident]
        assert {j["id"] for j in c.get("/v1/jobs/list").json()["jobs"]} == {ident, etranger}
        assert c.get("/v1/jobs/status", params={"id": "pas-un-id"}).status_code == 400
        assert _tuer(c, ident).status_code == 200
