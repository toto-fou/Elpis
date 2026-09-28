# SPDX-License-Identifier: MIT
"""Retrait de ``net_admin`` du bounding set des ``docker exec`` (2026-08-30).

Un process créé par ``docker exec`` NE DESCEND PAS de PID 1 : il reçoit le
bounding set du CONTENEUR, qui contient ``net_admin`` en mode
``allowlist_ip`` (``--cap-add NET_ADMIN``). Combiné à ``sudo`` NOPASSWD, un
``sudo iptables -F OUTPUT`` lancé depuis n'importe quel outil de l'agent — ou
depuis le terminal — effaçait l'allowlist du profil réseau. Le
``setpriv --bounding-set=-net_admin`` de l'entrypoint ne protégeait que PID 1.

Mesuré sur ``elpis/sandbox:1.5.0`` avant correctif ::

    CapBnd PID 1              = 00000000a80425fb   (net_admin retiré)
    CapBnd d'un `docker exec` = 00000000a80435fb   (net_admin PRÉSENT)
    sudo iptables -F OUTPUT   → rc=0, chaîne OUTPUT vidée

Après correctif : rc=4 (« Permission denied »), règles intactes.
"""
import pytest

from shared_infra.sandbox.executors import _privdrop
from shared_infra.sandbox.executors._user_sandbox import (
    UserSandbox, SandboxAdminConfig, SandboxStatus,
)
from shared_infra.terminal.pty import (
    _build_pty_docker_cmd, _PTY_EXEC_USER, _PTY_PRIVDROP_WRAP,
)

SETPRIV = ["setpriv", "--reuid=10001", "--regid=10001",
           "--init-groups", "--bounding-set=-net_admin", "--"]


@pytest.fixture(autouse=True)
def _clean_cache():
    """Le verdict est un cache de module : chaque test repart à zéro."""
    _privdrop._PROBED.clear()
    yield
    _privdrop._PROBED.clear()


# ── Le helper pur ─────────────────────────────────────────────────────────

def test_privdrop_argv_reprend_les_options_de_lentrypoint():
    # setpriv (util-linux) attend les noms SANS préfixe ``cap_`` — avec, il
    # répond « unknown capability ».
    assert _privdrop.privdrop_argv("10001:10001") == SETPRIV


@pytest.mark.parametrize("bad", ["", "10001", "10001:10001; rm -rf /",
                                 "-oProxyCommand=x:0", "10001:"])
def test_privdrop_argv_refuse_un_exec_user_inattendu(bad):
    # On ne bâtit pas d'argv setpriv à partir d'une valeur de config
    # non reconnue : on ne fait rien plutôt que n'importe quoi.
    assert _privdrop.privdrop_argv(bad) is None
    assert _privdrop.probe_argv("c", bad) is None


def test_probe_argv_entre_en_root_et_teste_la_chaine_complete():
    assert _privdrop.probe_argv("elpis-sb-alice", "10001:10001") == [
        "exec", "--user", "0:0", "elpis-sb-alice", *SETPRIV, "true"]


def test_resolve_rend_la_forme_historique_tant_que_le_verdict_est_inconnu():
    # Fail-open explicite : au pire un exec passe sans le retrait, jamais
    # un exec cassé.
    assert _privdrop.resolve("c", "10001:10001") == ("10001:10001", [])


def test_resolve_bascule_en_root_setpriv_apres_un_verdict_positif():
    _privdrop.remember("c", "10001:10001", True)
    assert _privdrop.resolve("c", "10001:10001") == ("0:0", SETPRIV)


def test_resolve_reste_historique_apres_un_verdict_negatif():
    _privdrop.remember("c", "10001:10001", False)
    assert _privdrop.resolve("c", "10001:10001") == ("10001:10001", [])


def test_forget_ne_purge_que_le_conteneur_vise():
    _privdrop.remember("c1", "10001:10001", True)
    _privdrop.remember("c2", "10001:10001", True)
    _privdrop.forget("c1")
    assert _privdrop.cached("c1", "10001:10001") is None
    assert _privdrop.cached("c2", "10001:10001") is True


# ── UserSandbox.exec ──────────────────────────────────────────────────────

def _stub_sandbox(monkeypatch, tmp_path, *, probe_rc: int):
    """Sandbox dont la sonde répond ``probe_rc`` et dont l'exec réel est
    capturé au lieu d'être lancé."""
    cfg = SandboxAdminConfig.from_dict({})
    sb = UserSandbox(1, "alice", tmp_path, cfg=cfg, network_profile_id="isolated")
    seen = {"probes": [], "args": None}

    async def _fake_ensure_running():
        return SandboxStatus(running=True, exists=True,
                             container_name=sb.container_name)

    async def _fake_call(*args, **kw):
        seen["probes"].append(list(args))
        return probe_rc, b"", b""

    class _FakeProc:
        returncode = 0
        # L'exécuteur lit la sortie par pompes (AUDIT 2026-09-25) : flux
        # absents = rien à lire.
        stdin = stdout = stderr = None

        async def communicate(self, input=None):
            return b"", b""

        async def wait(self):
            return 0

    async def _fake_subprocess(bin_, *args, **kw):
        seen["args"] = list(args)
        return _FakeProc()

    monkeypatch.setattr(sb, "ensure_running", _fake_ensure_running)
    monkeypatch.setattr(sb._cli, "call", _fake_call)
    import shared_infra.sandbox.executors._user_sandbox as us
    monkeypatch.setattr(us.asyncio, "create_subprocess_exec", _fake_subprocess)
    return sb, seen


@pytest.mark.asyncio
async def test_exec_entre_en_root_et_retire_net_admin(tmp_path, monkeypatch):
    sb, seen = _stub_sandbox(monkeypatch, tmp_path, probe_rc=0)
    await sb.exec(["echo", "hi"])
    args = seen["args"]

    # docker exec entre en root…
    assert args[:4] == ["exec", "--user", "0:0", "--workdir"]
    # …et setpriv redescend immédiatement avant le shell de l'appelant,
    # après le nom du conteneur (donc dans le conteneur, pas côté hôte).
    i = args.index(sb.container_name)
    assert args[i + 1:i + 1 + len(SETPRIV)] == SETPRIV
    assert args[i + 1 + len(SETPRIV)] == "sh"
    # La commande de l'appelant est intacte, et le wrapper umask/timeout aussi.
    assert args[-2:] == ["echo", "hi"]
    assert any("umask 0000" in a for a in args)


@pytest.mark.asyncio
async def test_exec_retombe_sur_la_forme_historique_si_setpriv_absent(
        tmp_path, monkeypatch):
    # Image tierce sans util-linux : on ne casse pas l'exec. Ces images-là
    # n'ont pas non plus l'entrypoint Elpis, donc elles ne filtraient rien.
    sb, seen = _stub_sandbox(monkeypatch, tmp_path, probe_rc=127)
    await sb.exec(["echo", "hi"])
    args = seen["args"]
    assert args[:3] == ["exec", "--user", "10001:10001"]
    assert "setpriv" not in args
    assert args[-2:] == ["echo", "hi"]


@pytest.mark.asyncio
async def test_la_sonde_ne_tourne_quune_fois_par_conteneur(tmp_path, monkeypatch):
    sb, seen = _stub_sandbox(monkeypatch, tmp_path, probe_rc=0)
    await sb.exec(["true"])
    await sb.exec(["true"])
    await sb.exec(["true"])
    probes = [p for p in seen["probes"] if "setpriv" in p]
    assert len(probes) == 1


@pytest.mark.asyncio
async def test_stop_et_destroy_purgent_le_verdict(tmp_path, monkeypatch):
    # Le conteneur suivant portera peut-être une AUTRE image : un verdict
    # gardé s'appliquerait à l'aveugle.
    sb, seen = _stub_sandbox(monkeypatch, tmp_path, probe_rc=0)
    await sb.exec(["true"])
    assert _privdrop.cached(sb.container_name, "10001:10001") is True
    await sb.stop()
    assert _privdrop.cached(sb.container_name, "10001:10001") is None

    await sb.exec(["true"])
    assert _privdrop.cached(sb.container_name, "10001:10001") is True
    await sb.destroy()
    assert _privdrop.cached(sb.container_name, "10001:10001") is None


@pytest.mark.asyncio
async def test_exec_user_admin_0_0_est_honore_et_perd_quand_meme_net_admin(
        tmp_path, monkeypatch):
    # Un admin qui demande root garde root — mais ne peut plus toucher au
    # netfilter, ce qui est tout l'objet du correctif.
    cfg = SandboxAdminConfig.from_dict({"exec_user": "0:0"})
    sb = UserSandbox(1, "alice", tmp_path, cfg=cfg, network_profile_id="isolated")
    seen = {"args": None}

    async def _fake_ensure_running():
        return SandboxStatus(running=True, exists=True,
                             container_name=sb.container_name)

    async def _fake_call(*args, **kw):
        return 0, b"", b""

    class _FakeProc:
        returncode = 0
        # L'exécuteur lit la sortie par pompes (AUDIT 2026-09-25) : flux
        # absents = rien à lire.
        stdin = stdout = stderr = None

        async def communicate(self, input=None):
            return b"", b""

        async def wait(self):
            return 0

    async def _fake_subprocess(bin_, *args, **kw):
        seen["args"] = list(args)
        return _FakeProc()

    monkeypatch.setattr(sb, "ensure_running", _fake_ensure_running)
    monkeypatch.setattr(sb._cli, "call", _fake_call)
    import shared_infra.sandbox.executors._user_sandbox as us
    monkeypatch.setattr(us.asyncio, "create_subprocess_exec", _fake_subprocess)

    await sb.exec(["id"])
    args = seen["args"]
    i = args.index(sb.container_name)
    assert args[i + 1:i + 7] == [
        "setpriv", "--reuid=0", "--regid=0",
        "--init-groups", "--bounding-set=-net_admin", "--"]


# ── Terminal (PTY) ────────────────────────────────────────────────────────

def test_pty_historique_tant_que_la_sonde_na_pas_conclu():
    cmd = _build_pty_docker_cmd("elpis-sb-alice")
    assert cmd[:5] == ["docker", "exec", "-it", "--user", "10001:10001"]
    assert "setpriv" not in cmd


def test_pty_entre_en_root_puis_chown_le_pts_puis_retire_net_admin():
    _privdrop.remember("elpis-sb-alice", _PTY_EXEC_USER, True)
    cmd = _build_pty_docker_cmd("elpis-sb-alice")
    assert cmd[:5] == ["docker", "exec", "-it", "--user", "0:0"]
    i = cmd.index("elpis-sb-alice")
    tail = cmd[i + 1:]
    # docker crée le pts en root:tty quand l'exec entre en root ; sans ce
    # chown, tmux/screen (qui ROUVRENT /dev/pts/N par son nom) échouent une
    # fois redescendus sur l'UID cible.
    assert tail[:4] == ["/bin/sh", "-c", _PTY_PRIVDROP_WRAP, "--"]
    assert tail[4] == "10001"
    assert tail[5:5 + len(SETPRIV)] == SETPRIV
    # Le bootstrap d'origine est passé en POSITIONNEL : aucun re-quoting.
    assert tail[5 + len(SETPRIV):5 + len(SETPRIV) + 2] == ["/bin/sh", "-c"]
    assert "exec /bin/bash" in tail[-1]


def test_pty_reste_historique_sur_verdict_negatif():
    _privdrop.remember("elpis-sb-alice", _PTY_EXEC_USER, False)
    cmd = _build_pty_docker_cmd("elpis-sb-alice")
    assert cmd[:5] == ["docker", "exec", "-it", "--user", "10001:10001"]
    assert cmd[-3:-1] == ["/bin/sh", "-c"]
