# SPDX-License-Identifier: MIT
"""Agent de la sandbox (L4) : opérations, bornes, et client de l'hôte —
démarrage à la demande, socket piégé, faux agent, relance d'une autre
version (2026-09-29). L'agent tourne ici dans un thread, à la place du
conteneur ; un essai lance le script seul, comme dans le conteneur."""
from __future__ import annotations

import ast
import asyncio
import hashlib
import os
import socket
import socketserver
import subprocess
import sys
import threading
import time
import types
from pathlib import Path

import httpx
import pytest

from shared_infra.sandbox import agent_client as AC
from shared_infra.sandbox.agent import server as S
from shared_infra.sandbox.agent_client import AgentClient, AgentError


class _Sandbox:
    """``UserSandbox`` réduite à ce que le client utilise ; ``start_agent``
    lance l'agent dans un thread."""

    def __init__(self, racine: Path) -> None:
        self.sandbox_path = racine / "work"
        self.sandbox_path.mkdir(parents=True)
        (racine / AC.AGENT_RUN_DIR).mkdir()
        self.socket = racine / AC.AGENT_RUN_DIR / "agent.sock"
        self.running, self.demarrages, self.remplacements, self.serveurs = True, 0, 0, []

    async def ensure_running(self):
        return types.SimpleNamespace(running=self.running)

    async def start_agent(self, replace: bool = False) -> None:
        self.demarrages += 1
        self.remplacements += replace
        srv = S.servir(str(self.sandbox_path), str(self.socket))
        fil = threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.05},
                               daemon=True)
        fil.start()
        self.serveurs.append((srv, fil))

    def arreter(self) -> None:
        for srv, fil in self.serveurs:
            srv.shutdown()
            fil.join(5)
            srv.server_close()
        self.serveurs.clear()


@pytest.fixture
def sb(tmp_path):
    s = _Sandbox(tmp_path)
    yield s
    s.arreter()


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _refus(coro) -> AgentError:
    with pytest.raises(AgentError) as e:
        asyncio.run(coro)
    return e.value


def test_syntaxe_python_39():
    """L'agent tourne sous le python3 de l'image : rien après 3.9."""
    ast.parse(Path(S.__file__).read_text(encoding="utf-8"), feature_version=(3, 9))


def test_operations_de_bout_en_bout(sb):
    c = AgentClient(sb)

    async def scenario():
        h = await c.hello()                              # démarre l'agent
        assert h["version"] == S.VERSION and sb.demarrages == 1
        r = await c.write("dir/a.txt", b"bonjour", parents=True)
        assert r["created"] and r["sha256"] == _sha(b"bonjour") and r["size"] == 7
        lu = await c.read("dir/a.txt")
        assert lu.data == b"bonjour" and lu.stat["size"] == 7
        assert (await c.read("/work/dir/a.txt", offset=3, length=2)).data == b"jo"
        (e,) = await c.stat(["dir/a.txt"], hash=True)
        assert e["kind"] == "file" and e["sha256"] == r["sha256"]
        assert (await c.stat(["absent"]))[0]["kind"] == "missing"
        liste = await c.list("", depth=5)
        assert {x["path"] for x in liste.entries} == {"dir", "dir/a.txt"}
        assert not liste.truncated
        await c.fsop("copy", src="dir", dst="copie")
        await c.fsop("rename", src="copie/a.txt", dst="b.txt")
        await c.fsop("remove", path="dir", recursive=True)
        await c.fsop("mkdir", path="x/y")
        liste = await c.list("", depth=5)
        assert {x["path"] for x in liste.entries} == {"copie", "b.txt", "x", "x/y"}
    asyncio.run(scenario())
    assert sb.demarrages == 1                            # un seul agent pour tout


def test_preconditions_et_droits(sb):
    c = AgentClient(sb)

    async def scenario():
        await c.write("f", b"v1")
        e = await _attendre_refus(c.write("f", b"x", if_absent=True))
        assert (e.code, e.status) == ("exists", 412)
        e = await _attendre_refus(c.write("f", b"x", if_sha256="0" * 64))
        assert e.code == "changed" and e.data["sha256"] == _sha(b"v1")
        await c.write("f", b"v2", if_sha256=_sha(b"v1"))
        mtime = (await c.stat(["f"]))[0]["mtime_ns"]
        await _attendre_refus(c.write("f", b"v3", if_mtime_ns=mtime - 1))
        await c.write("f", b"v3", if_mtime_ns=mtime)
        await c.write("f", b"m", mode="0640")
        assert (await c.stat(["f"]))[0]["mode"] == 0o640
        await c.write("f", b"garde le mode")
        assert (await c.stat(["f"]))[0]["mode"] == 0o640
        os.chmod(sb.sandbox_path / "f", 0o4755)
        await c.write("f", b"sans setuid")                # « garder » : jamais de bit spécial
        assert (await c.stat(["f"]))[0]["mode"] == 0o755
        e = await _attendre_refus(c.fsop("chmod", path="f"))
        assert (e.code, e.status) == ("bad_request", 400)
        await c.fsop("chmod", path="f", mode=0o644)       # entier : tel quel
        assert (await c.stat(["f"]))[0]["mode"] == 0o644
        await c.fsop("chmod", path="f", mode="4750")      # chaîne octale, sans setuid
        assert (await c.stat(["f"]))[0]["mode"] == 0o750
    asyncio.run(scenario())
    assert os.listdir(sb.sandbox_path) == ["f"]          # aucun fichier provisoire laissé


async def _attendre_refus(coro) -> AgentError:
    with pytest.raises(AgentError) as e:
        await coro
    return e.value


def test_une_seule_ecriture_conditionnelle_gagne(sb, monkeypatch):
    """Écritures conditionnelles concurrentes : le contenu s'écrit hors
    verrou (fsync ralenti ici pour qu'elles se chevauchent), la vérification
    et le remplacement sous verrou — une seule gagne."""
    vrai_fsync = S.os.fsync

    def fsync_lent(fd):
        time.sleep(0.02)
        vrai_fsync(fd)
    monkeypatch.setattr(S.os, "fsync", fsync_lent)
    c = AgentClient(sb)

    async def scenario():
        await c.write("f", b"base")
        essais = await asyncio.gather(
            *(c.write("f", f"v{i}".encode(), if_sha256=_sha(b"base")) for i in range(8)),
            return_exceptions=True)
        gagnants = [r for r in essais if not isinstance(r, Exception)]
        assert len(gagnants) == 1
        assert all(isinstance(r, AgentError) and r.code == "changed"
                   for r in essais if isinstance(r, Exception))
    asyncio.run(scenario())


@pytest.mark.parametrize("chemin", ["..", "a/../../x", "/etc/passwd", "a\x00b", "/workx",
                                    "nom-\udcff"])
def test_chemins_refuses(sb, chemin):
    for appel in (AgentClient(sb).read(chemin), AgentClient(sb).fsop("mkdir", path=chemin)):
        e = _refus(appel)
        assert e.code == "bad_path" and e.status in (0, 400)   # 0 : refusé dès le client


def test_noms_particuliers(sb):
    (sb.sandbox_path / "a").mkdir()
    (sb.sandbox_path / "a" / "b").write_bytes(b"sous-dossier")
    (sb.sandbox_path / "a\\b").write_bytes(b"antislash")  # « \ » : un caractère ordinaire
    os.close(os.open(os.fsencode(sb.sandbox_path) + b"/non-utf8-\xff", os.O_CREAT | os.O_WRONLY))
    long = "l" * 250
    c = AgentClient(sb)

    async def scenario():
        assert (await c.read("a\\b")).data == b"antislash"
        assert (await c.read("a/b")).data == b"sous-dossier"
        await c.write(long, b"nom long")                 # le provisoire reste court
        assert (sb.sandbox_path / long).read_bytes() == b"nom long"
        liste = await c.list("")
        assert {x["path"] for x in liste.entries} == {"a", "a\\b", long}
    asyncio.run(scenario())


def test_liens(sb):
    (sb.sandbox_path / "cible").mkdir()
    (sb.sandbox_path / "cible" / "f").write_bytes(b"dedans")
    os.symlink("cible", sb.sandbox_path / "lien")
    c = AgentClient(sb)

    async def scenario():
        assert (await c.read("lien/f")).data == b"dedans"          # suivi pour lire
        await c.write("lien/g", b"par le lien")                      # et pour écrire
        assert (sb.sandbox_path / "cible" / "g").read_bytes() == b"par le lien"
        entrees = {x["path"]: x["kind"] for x in (await c.list("", depth=5)).entries}
        assert entrees["lien"] == "link" and "lien/f" not in entrees  # pas de descente
        await c.fsop("copy", src="lien", dst="lien2")
        assert os.readlink(sb.sandbox_path / "lien2") == "cible"     # copié tel quel
        await c.fsop("copy", src="lien", dst="copie", follow=True)   # copié depuis la cible
        assert not os.path.islink(sb.sandbox_path / "copie")
        assert (sb.sandbox_path / "copie" / "f").exists()
        e = await _attendre_refus(c.fsop("copy", src="lien", dst="cible/x", follow=True))
        assert e.code == "inside"                        # la cible contiendrait sa copie
        await c.fsop("remove", path="lien", recursive=True)          # le lien seul
        assert (sb.sandbox_path / "cible" / "f").exists()
        (e,) = await c.stat(["lien2"])
        assert e["link"] and e["target"] == "cible" and e["kind"] == "dir"
    asyncio.run(scenario())


def test_ecrasement_sans_perte(sb):
    (sb.sandbox_path / "a" / "b").mkdir(parents=True)
    (sb.sandbox_path / "a" / "b" / "f").write_bytes(b"source")
    (sb.sandbox_path / "d").mkdir()
    (sb.sandbox_path / "d" / "garde").write_bytes(b"destination")
    os.mkfifo(sb.sandbox_path / "a" / "tube")            # la copie de a échouera
    c = AgentClient(sb)

    async def scenario():
        e = await _attendre_refus(c.fsop("rename", src="a/b", dst="a", overwrite=True))
        assert e.code == "inside"                        # la destination contient la source
        assert (sb.sandbox_path / "a" / "b" / "f").read_bytes() == b"source"
        await _attendre_refus(c.fsop("copy", src="a", dst="d", overwrite=True))
        assert (sb.sandbox_path / "d" / "garde").read_bytes() == b"destination"
        await c.fsop("rename", src="a/b", dst="d", overwrite=True)   # dossier remplacé
        assert os.listdir(sb.sandbox_path / "d") == ["f"]
        await c.write("x", b"x")
        e = await _attendre_refus(c.fsop("copy", src="d/f", dst="x"))
        assert (e.code, e.status) == ("exists", 409)
        await c.fsop("copy", src="d/f", dst="x", overwrite=True)     # fichier : d'un coup
        assert (sb.sandbox_path / "x").read_bytes() == b"source"
    asyncio.run(scenario())
    restes = [n for n in os.listdir(sb.sandbox_path) if n.startswith(".elpis-tmp")]
    assert restes == []


def test_lectures_bornees(sb):
    (sb.sandbox_path / "gros").write_bytes(b"x" * 1000)
    (sb.sandbox_path / "d").mkdir()
    c = AgentClient(sb)

    async def scenario():
        e = await _attendre_refus(c.read("gros", max_bytes=100))
        assert (e.code, e.status) == ("too_large", 413) and e.data["stat"]["size"] == 1000
        assert len((await c.read("gros", length=100, max_bytes=100)).data) == 100
        assert (await _attendre_refus(c.read("gros", expect_size=999))).code == "changed"
        assert (await _attendre_refus(c.read("d"))).code == "not_file"
        e = await _attendre_refus(c.read("absent"))
        assert (e.code, e.status) == ("not_found", 404)
    asyncio.run(scenario())


def test_stat_d_un_lot_partiel(sb):
    (sb.sandbox_path / "ferme").mkdir()
    (sb.sandbox_path / "ferme" / "f").write_bytes(b"")
    (sb.sandbox_path / "ok").write_bytes(b"")
    os.chmod(sb.sandbox_path / "ferme", 0)
    try:
        if os.geteuid() == 0:
            pytest.skip("root traverse tout")
        entrees = asyncio.run(AgentClient(sb).stat(["ok", "ferme/f", "../x"]))
    finally:
        os.chmod(sb.sandbox_path / "ferme", 0o755)
    assert [e["kind"] for e in entrees] == ["file", "error", "error"]
    assert [e.get("error") for e in entrees[1:]] == ["denied", "bad_path"]


def test_liste_bornee_elaguee(sb):
    for i in range(30):
        (sb.sandbox_path / f"f{i:02}").write_bytes(b"")
    (sb.sandbox_path / "node_modules" / "p").mkdir(parents=True)
    (sb.sandbox_path / ".cache").mkdir()
    c = AgentClient(sb)

    async def scenario():
        tronquee = await c.list("", max_entries=10)
        assert tronquee.truncated and len(tronquee.entries) == 10
        chemins = {x["path"] for x in (await c.list("", depth=9, hidden=False,
                                                     prune=["node_modules"])).entries}
        assert "node_modules" in chemins and "node_modules/p" not in chemins
        assert ".cache" not in chemins
        assert (await _attendre_refus(c.list("f00"))).code == "not_dir"
    asyncio.run(scenario())


def test_erreur_en_cours_de_liste(sb, monkeypatch):
    """Après l'en-tête 200, une erreur ne peut plus être une réponse : elle
    termine le flux par une ligne d'erreur."""
    def lister(self, *a, **kw):
        yield {"path": "x", "kind": "file", "size": 0, "mtime_ns": 0, "mode": 0}
        raise RuntimeError("disque parti")
    monkeypatch.setattr(S.Agent, "lister", lister)
    e = _refus(AgentClient(sb).list(""))
    assert e.code == "internal" and "disque parti" in e.message


# ── socket piégé, faux agent, relance ───────────────────────────────────────

def _ecoute(chemin: Path, reponse: bytes = b"") -> dict:
    """Faux agent : note les connexions ; répond ``reponse`` à chacune."""
    etat: dict = {"connexions": 0, "envoye": 0}

    class H(socketserver.BaseRequestHandler):
        def handle(self):
            etat["connexions"] += 1
            self.request.recv(65536)
            try:
                while reponse:
                    etat["envoye"] += self.request.send(reponse)
                    if etat["envoye"] > 200 << 20:
                        return
            except OSError:
                return

    class Srv(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
        daemon_threads = True
    srv = Srv(str(chemin), H)
    threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.05},
                     daemon=True).start()
    etat["srv"] = srv
    return etat


def test_lien_pose_a_la_place_du_socket_ne_detourne_pas(sb, tmp_path):
    """La sandbox écrit dans le dossier du socket : un lien vers un autre
    socket de l'hôte n'est jamais suivi."""
    leurre = _ecoute(tmp_path / "hote.sock")
    os.symlink(tmp_path / "hote.sock", sb.socket)
    assert asyncio.run(AgentClient(sb).hello())["version"] == S.VERSION
    assert leurre["connexions"] == 0 and not sb.socket.is_symlink()
    leurre["srv"].shutdown()


def test_fichier_ordinaire_a_la_place_du_socket(sb):
    sb.socket.write_bytes(b"pas un socket")
    assert asyncio.run(AgentClient(sb).hello())["agent"] == "elpis"
    assert sb.demarrages == 1


def test_faux_agent_bavard_borne(sb):
    """Un processus de la sandbox a pris le socket et déverse des centaines
    de Mo : l'hôte s'arrête à ses bornes, puis remplace l'imposteur."""
    tete = b"HTTP/1.1 200 OK\r\nContent-Length: 999999999\r\n\r\n"
    faux = _ecoute(sb.socket, tete + b"x" * (1 << 20))
    c = AgentClient(sb)
    debut = time.monotonic()
    assert asyncio.run(c.stat(["x"]))[0]["kind"] == "missing"
    assert time.monotonic() - debut < 15
    assert faux["envoye"] < 64 << 20                     # lu et jeté par morceaux bornés
    assert sb.remplacements == 1                         # sondé « figé » : remplacé
    faux["srv"].shutdown()


def test_autre_version_relancee_une_seule_fois(sb, monkeypatch):
    """Code mis à jour : l'agent en marche est arrêté puis relancé, une fois,
    même avec des appels concurrents. Si le nouveau n'a toujours pas la
    version attendue, on s'en contente."""
    asyncio.run(AgentClient(sb).hello())
    premier, fil = sb.serveurs[0]
    monkeypatch.setattr(AC, "_VERSION_ATTENDUE", "autre")
    c = AgentClient(sb)

    async def concurrents():
        return await asyncio.gather(*(c.stat([f"x{i}"]) for i in range(6)))
    assert len(asyncio.run(concurrents())) == 6
    fil.join(5)
    assert sb.demarrages == 2 and not fil.is_alive()     # l'ancien s'est arrêté
    asyncio.run(c.stat(["x"]))
    assert sb.demarrages == 2                            # pas de boucle de relance


def test_arret_refuse_si_deja_remplace(sb):
    asyncio.run(AgentClient(sb).hello())
    with httpx.Client(transport=httpx.HTTPTransport(uds=str(sb.socket)),
                      base_url="http://agent") as c:
        r = c.post("/v1/shutdown", json={"if_version": "ancienne"})
        assert (r.status_code, r.json()["error"]) == (409, "changed")
        assert c.get("/v1/hello").status_code == 200


def test_agent_mort_relance(sb):
    c = AgentClient(sb)
    asyncio.run(c.write("f", b"1"))
    sb.arreter()                                         # processus tué : son socket
    mort = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)  # reste, sans personne derrière
    os.unlink(sb.socket)
    mort.bind(str(sb.socket))
    mort.close()
    assert asyncio.run(c.read("f")).data == b"1"
    assert sb.demarrages == 2


def test_conteneur_arrete(sb):
    sb.running = False
    assert _refus(AgentClient(sb).hello()).code == "container_down"


def test_agent_qui_ne_demarre_pas_echec_memorise(sb, monkeypatch):
    monkeypatch.setattr(AC, "_DEMARRAGE_S", 0.3)

    async def rien(replace=False):
        sb.demarrages += 1
    monkeypatch.setattr(sb, "start_agent", rien)
    c = AgentClient(sb)
    assert _refus(c.hello()).code == "agent_unavailable"
    debut = time.monotonic()
    assert _refus(c.hello()).code == "agent_unavailable"
    assert time.monotonic() - debut < 0.2 and sb.demarrages == 1   # pas un 2e essai de 10 s


# ── protocole brut ──────────────────────────────────────────────────────────

@pytest.fixture
def brut(sb):
    asyncio.run(sb.start_agent())
    with httpx.Client(transport=httpx.HTTPTransport(uds=str(sb.socket)),
                      base_url="http://agent") as c:
        yield c


def test_refus_du_protocole(brut):
    assert brut.get("/v1/rien").json()["error"] == "unknown_route"
    r = brut.post("/v1/stat", content=b"{pas du json")
    assert (r.status_code, r.json()["error"]) == (400, "bad_request")
    r = brut.post("/v1/stat", json={"paths": ["a"], "hash_max": "beaucoup"})
    assert (r.status_code, r.json()["error"]) == (400, "bad_request")
    r = brut.put("/v1/write", params={"path": "c"}, content=iter([b"ab", b"cd"]))
    assert (r.status_code, r.json()["error"]) == (411, "length_required")
    # Corps non lu (chemin refusé avant) : la connexion est fermée, pas
    # désynchronisée.
    r = brut.put("/v1/write", params={"path": "../x"}, content=b"z" * 1000)
    assert r.status_code == 400 and r.headers["connection"] == "close"
    r = brut.put("/v1/write", params={"path": "t", "max": "3"}, content=b"trop long")
    assert (r.status_code, r.json()["error"]) == (413, "too_large")
    r = brut.put("/v1/write", params={"path": "t", "if_mtime_ns": "-5"}, content=b"x")
    assert r.json()["error"] == "changed"                # mtime négatif accepté


# ── câblage du conteneur ────────────────────────────────────────────────────

@pytest.mark.agent_reel
def test_montages_et_lancement_de_l_agent(tmp_path):
    from shared_infra.sandbox.executors._user_sandbox import SandboxAdminConfig, UserSandbox
    sbx = UserSandbox(1, "alice", tmp_path / "alice" / "work", cfg=SandboxAdminConfig.from_dict({}))
    args = sbx._build_run_args(sbx.network_profile)
    assert f"{tmp_path / 'alice' / AC.AGENT_RUN_DIR}:/run/elpis:rw" in args
    assert f"{AC.AGENT_DIR}:{AC.AGENT_MOUNT}:ro" in args
    assert any(a.startswith("elpis.agent=") for a in args)
    appels = []

    async def cli(*a, **kw):
        appels.append(a)
        return 0, b"", b""
    sbx._cli = types.SimpleNamespace(call=cli)
    asyncio.run(sbx.start_agent(replace=True))
    assert appels[0][-2:] == ("-f", f"{AC.AGENT_MOUNT}/server.py")        # l'agent figé tué
    lancement = appels[-1]
    assert lancement[:2] == ("exec", "-d")
    i = lancement.index("python3")
    assert lancement[i:i + 4] == ("python3", "-I", "-S", f"{AC.AGENT_MOUNT}/server.py")


def test_agent_autonome_une_seule_instance(tmp_path):
    """Lancé comme dans le conteneur (script seul, isolé) : un second agent
    rend la main tant que le premier tient le verrou ; après un arrêt
    demandé, un nouveau prend la suite."""
    work, run = tmp_path / "work", tmp_path / "run"
    work.mkdir()
    run.mkdir()
    sock = run / "agent.sock"
    cmd = [sys.executable, "-I", "-S", S.__file__, "--root", str(work), "--socket", str(sock)]

    def pid_qui_repond():
        for _ in range(200):
            try:
                with httpx.Client(transport=httpx.HTTPTransport(uds=str(sock)),
                                  base_url="http://a", timeout=1) as c:
                    return c.get("/v1/hello").json()["pid"]
            except (httpx.HTTPError, OSError, ValueError):
                time.sleep(0.05)
        return None

    premier = subprocess.Popen(cmd, cwd=tmp_path)
    try:
        assert pid_qui_repond() == premier.pid
        second = subprocess.run([*cmd, "--lock-wait", "0.2"], cwd=tmp_path, timeout=10)
        assert second.returncode == 0 and pid_qui_repond() == premier.pid
        with httpx.Client(transport=httpx.HTTPTransport(uds=str(sock)), base_url="http://a") as c:
            c.post("/v1/shutdown", json={})
        premier.wait(timeout=10)
        troisieme = subprocess.Popen(cmd, cwd=tmp_path)
        try:
            assert pid_qui_repond() == troisieme.pid
        finally:
            troisieme.terminate()
            troisieme.wait(timeout=10)
    finally:
        if premier.poll() is None:
            premier.kill()


def test_liens_hors_de_work_jamais_suivis(sb, tmp_path):
    """Un lien qui sort de /work n'est pas suivi : dans le conteneur il
    mènerait aux fichiers système, et l'API ne parle que de /work."""
    dehors = tmp_path / "dehors"
    dehors.mkdir()
    (dehors / "secret").write_bytes(b"hors de la sandbox")
    os.symlink(dehors, sb.sandbox_path / "sortie")
    (sb.sandbox_path / "f").write_bytes(b"dedans")
    c = AgentClient(sb)

    async def scenario():
        for appel in (c.read("sortie/secret"), c.write("sortie/x", b"x"),
                      c.fsop("mkdir", path="sortie/y"), c.list("sortie"),
                      c.fsop("rename", src="f", dst="sortie/f"),
                      c.fsop("chmod", path="sortie/secret", mode=0o777)):
            e = await _attendre_refus(appel)
            assert (e.code, e.status) == ("outside_root", 403)
        (e,) = await c.stat(["sortie"])
        assert e["link"] and e.get("outside") and "size" not in e
        await c.fsop("remove", path="sortie")            # le lien seul
    asyncio.run(scenario())
    assert (dehors / "secret").read_bytes() == b"hors de la sandbox"
    assert sorted(os.listdir(dehors)) == ["secret"] and not (sb.sandbox_path / "sortie").exists()


def test_liste_avec_exclusions_non_descendues(sb):
    (sb.sandbox_path / "node_modules" / "p").mkdir(parents=True)
    for i in range(50):
        (sb.sandbox_path / "node_modules" / "p" / f"{i}.js").write_bytes(b"")
    (sb.sandbox_path / "src").mkdir()
    (sb.sandbox_path / "src" / "a.py").write_bytes(b"")
    (sb.sandbox_path / "src" / "a.pyc").write_bytes(b"")
    c = AgentClient(sb)
    liste = asyncio.run(c.list("", depth=9, max_entries=10, exclude=["node_modules", "*.pyc"]))
    assert {x["path"] for x in liste.entries} == {"src", "src/a.py"} and not liste.truncated
    liste = asyncio.run(c.list("src", depth=9, exclude=["a.py"]))   # relatif au dossier listé
    assert {x["path"] for x in liste.entries} == {"src/a.pyc"}


def test_grep_sur_place(sb):
    (sb.sandbox_path / "a.txt").write_bytes(b"une ligne\nla CIBLE ici\r\nautre\n")
    (sb.sandbox_path / "b.bin").write_bytes(b"\x00cible binaire")
    (sb.sandbox_path / "gros.txt").write_bytes(b"cible\n" * 1000)
    c = AgentClient(sb)
    trouves, bilan = asyncio.run(c.grep(["a.txt", "b.bin", "gros.txt", "absent"], "cible",
                                        max_file_bytes=1000))
    assert trouves == [{"file": "a.txt", "line": 2, "text": "la CIBLE ici"}]
    assert (bilan["skipped_binary"], bilan["skipped_large"]) == (1, 1)
    trouves, bilan = asyncio.run(c.grep(["gros.txt"], "cible", max_hits=3))
    assert len(trouves) == 3 and bilan["hits_truncated"]
    assert asyncio.run(c.grep(["a.txt"], "cible", ignore_case=False))[0] == []
    trouves, bilan = asyncio.run(c.grep(["gros.txt", "a.txt"], "cible", files_only=True,
                                        max_hits=2))
    assert trouves == [{"file": "gros.txt"}, {"file": "a.txt"}]     # un par fichier
