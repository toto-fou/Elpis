# SPDX-License-Identifier: MIT
"""tests/conftest.py — isolation des ressources RÉELLES de la machine.

La base SQLite de production (``user_db/app.db``) en fait partie : une
quinzaine de tests ouvrent une connexion sans rediriger ``DB_PATH``, et le
framework de migrations s'exécute alors sur les données réelles. C'était
inoffensif tant que les migrations ne touchaient qu'au SCHÉMA ; la première
migration de DONNÉES dont le résultat dépend de la clé de chiffrement
(``0013_encrypt_personal_mcp_auth``) a suffi à re-chiffrer de vrais secrets
utilisateur avec une clé de test posée par un autre module de la suite. On
redirige donc la base une fois pour toutes.

Trois mécanismes cross-worker écrivent également hors de l'arborescence du
projet :
``shared_infra.runtime.cancel_bus`` (bus d'annulation), ``shared_infra.runtime.chat_locks``
(présence génération/compaction) et ``llm_core.tools._task_resume`` (reprise
``task_id``). Sans redirection, la suite déposerait des fichiers dans le spool
RÉEL de la machine — et un test tenant un verrou de présence pourrait faire
répondre 409 à une application en cours d'exécution sur le même poste.

Portée session, autouse : les tests qui veulent un dossier par-test gardent
leur propre ``monkeypatch`` (il prime).
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest


# ── Moteur de base de la suite (2026-09-26, chantier multi-moteurs) ──────────
# Par défaut SQLite. Avec ``APP_DB_BACKEND=postgres|mysql`` (+ ``APP_DB_*`` et
# ``ELPIS_TEST_DB=1``), toute la suite tourne sur un serveur jetable : chaque
# ``DB_PATH`` de test y reçoit son propre schéma / sa propre base
# (``_connection._test_schema``). Les tests qui manipulent SQLite lui-même —
# fichier, PRAGMA, ``sqlite_master``, DDL SQLite brut — portent le marqueur
# ``sqlite_only`` et sont alors ignorés.
def pytest_configure(config):
    config.addinivalue_line(
        "markers", "sqlite_only: test propre au moteur SQLite (fichier, PRAGMA, sqlite_master…)")
    config.addinivalue_line(
        "markers", "agent_reel: vrais ensure_running / start_agent (pas d'agent en thread)")


@pytest.fixture(autouse=True, scope="session")
def _ddl_des_fixtures_sur_serveur():
    """Sur un moteur serveur, le DDL SQLite écrit à la main par les fixtures
    est traduit (cf. ``tests/_ddl_fixtures.py``) ; sans effet en SQLite."""
    backend = (os.environ.get("APP_DB_BACKEND") or "sqlite").strip().lower()
    if backend in ("", "sqlite"):
        yield
        return
    from shared_infra.db import _server
    from tests._ddl_fixtures import explicit_id_table, index_if_not_exists, resync_identity, translate
    run, run_many = _server.ServerConnection._run, _server.ServerConnection._run_many

    def _apres(self, sql):
        table = self.dialect == "postgres" and explicit_id_table(sql)
        if table:
            resync_identity(self, table)

    def _run(self, cur, sql, params):
        try:
            run(self, cur, translate(sql, self.dialect), params)
        except Exception as exc:
            if not (self.dialect == "mysql" and index_if_not_exists(sql)
                    and "Duplicate key name" in str(exc)):
                raise
        _apres(self, sql)

    def _run_many(self, cur, sql, seq):
        run_many(self, cur, translate(sql, self.dialect), seq)
        _apres(self, sql)

    _server.ServerConnection._run, _server.ServerConnection._run_many = _run, _run_many
    # Migrations HISTORIQUES rejouées par des fixtures : écrites pour SQLite
    # (une base serveur naît du schéma de référence et les tamponne). Sur une
    # connexion serveur, ``migrate()`` pose à la place, depuis ``_schema``, les
    # tables que la migration crée.
    import importlib
    import re as _re

    from shared_infra.db import _migrations, _schema
    from shared_infra.db._dialect import SQLITE, dialect_of

    def _remplace(mod):
        origin = mod.migrate
        src = Path(mod.__file__).read_text(encoding="utf-8")
        tables = [t for t in dict.fromkeys(_re.findall(
            r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[\"`]?(\w+)", src, _re.I))
            if t in _schema.TABLES_BY_NAME]

        def migrate(conn, *a, **k):
            if dialect_of(conn) == SQLITE:
                return origin(conn, *a, **k)
            _schema.ensure_tables(conn, tables)
            if "session_messages" in tables:
                _schema.ensure_fts(conn)
        return migrate

    for name in _migrations._discover():
        mod = importlib.import_module(f"shared_infra.db._migrations.{name}")
        if hasattr(mod, "migrate"):
            mod.migrate = _remplace(mod)
    # La base PAR DÉFAUT (``user_db/app.db`` en SQLite, peuplée par l'usage) :
    # des tests qui ne redirigent pas ``DB_PATH`` comptent sur son schéma.
    from shared_infra.db._connection import init_db
    init_db()
    yield
    _server.ServerConnection._run, _server.ServerConnection._run_many = run, run_many


_SCHEMAS_DU_MODULE: list = []


@pytest.fixture(autouse=True, scope="module")
def _schemas_de_test_supprimes():
    """Sur un moteur serveur, chaque base de test (fichier temporaire en
    SQLite) est un schéma PG / une base MySQL sur un serveur en tmpfs : sans
    ménage, des centaines s'accumulent en mémoire au fil de la suite. Ceux d'un
    ``DB_PATH`` temporaire sont supprimés à la fin de chaque module (les
    fixtures de module qui s'en servent sont alors terminées)."""
    backend = (os.environ.get("APP_DB_BACKEND") or "sqlite").strip().lower()
    if backend in ("", "sqlite") or not os.environ.get("ELPIS_TEST_DB"):
        yield
        return
    import tempfile

    from shared_infra.db import _connection as C
    ensure = C._ensure_test_schema

    def _suivi(settings):
        if str(C.DB_PATH).startswith(tempfile.gettempdir()):
            _SCHEMAS_DU_MODULE.append(dict(settings))
        ensure(settings)

    C._ensure_test_schema = _suivi
    try:
        yield
    finally:
        C._ensure_test_schema = ensure
        if _SCHEMAS_DU_MODULE:
            C.reset_pool()
            # Jamais celui du DB_PATH courant : un module qui l'a posé sans
            # monkeypatch (fuite) le laisse aux suivants.
            done = {C._test_schema()}
            for st in _SCHEMAS_DU_MODULE:
                if st["schema"] in done:
                    continue
                done.add(st["schema"])
                try:
                    conn = C.connect_server(dict(st, schema=None))
                    try:
                        conn.execute(f'DROP SCHEMA IF EXISTS "{st["schema"]}" CASCADE'
                                     if st["backend"] == "postgres"
                                     else f'DROP DATABASE IF EXISTS "{st["schema"]}"')
                    finally:
                        conn.hard_close()
                except Exception:
                    pass
            _SCHEMAS_DU_MODULE.clear()


def pytest_collection_modifyitems(config, items):
    backend = (os.environ.get("APP_DB_BACKEND") or "sqlite").strip().lower()
    if backend in ("", "sqlite"):
        return
    skip = pytest.mark.skip(reason=f"propre à SQLite (suite lancée sur {backend})")
    for item in items:
        if item.get_closest_marker("sqlite_only"):
            item.add_marker(skip)


@pytest.fixture(autouse=True, scope="session")
def _isolate_mcp_manifest(tmp_path_factory):
    """(2026-09-11) Le dépôt embarque un ``mcp.json`` de référence. La suite
    tourne par défaut SANS fichier (manifeste synthétisé depuis la config
    héritée) : les tests qui posent ``cfg.LOCAL_MCP_*`` par monkeypatch gardent
    ainsi leur sens, et le fichier réel n'influence jamais un test. Les tests
    du manifeste pointent ``APP_MCP_MANIFEST`` sur leur propre fichier."""
    import os
    absent = str(tmp_path_factory.mktemp("mcp") / "absent-mcp.json")
    prev = os.environ.get("APP_MCP_MANIFEST")
    os.environ["APP_MCP_MANIFEST"] = absent
    try:
        from shared_infra.mcp import manifest as _mf
        _mf.reload()
    except Exception:
        pass
    yield
    if prev is None:
        os.environ.pop("APP_MCP_MANIFEST", None)
    else:
        os.environ["APP_MCP_MANIFEST"] = prev


@pytest.fixture(autouse=True, scope="session")
def _isolate_real_db(tmp_path_factory):
    """Jamais la base de production, quel que soit le test.

    ``_legacy`` importe ``DB_PATH`` comme global de module (l. 13) et le relit
    à chaque ouverture : patcher les deux références suffit. Le pool de
    connexions est indexé par ``(pid, str(DB_PATH))``, donc le changement de
    chemin donne naturellement un pool neuf. Les tests qui redirigent
    eux-mêmes ``DB_PATH`` gardent la main (leur monkeypatch prime)."""
    path = str(tmp_path_factory.mktemp("db") / "app.db")
    import shared_infra.config as _config
    import shared_infra.db._connection as _legacy

    _config.DB_PATH = path
    _legacy.DB_PATH = path
    # Schéma complet : plusieurs tests supposaient les tables présentes et ne
    # passaient que parce qu'ils tombaient sur la base RÉELLE, déjà migrée.
    try:
        _legacy.init_db()
    except Exception:
        pass
    yield


@pytest.fixture(autouse=True, scope="session")
def _isolate_shared_spools(tmp_path_factory):
    base = tmp_path_factory.mktemp("spools")
    from llm_core.tools import _task_resume
    from shared_infra.runtime import cancel_bus, chat_locks

    chat_locks.LOCK_DIR = base / "locks"
    _task_resume.STORE_DIR = base / "resume"
    cancel_bus.CANCEL_FILE = base / "cancel.jsonl"
    # Le verrou de leader des routines a rejoint la racine commune
    # (audit 2026-08-22, D8) : il doit être redirigé comme les trois autres,
    # sinon la suite prend le leadership du cron sur le poste de l'exécutant.
    try:
        from shared_infra.scheduling import cron_lock
        cron_lock._LOCK_PATH = base / "cron.lock"
    except Exception:
        pass
    # Aperçus Office (2026-09-15) : verrous flock et cache de conversion hors
    # de /tmp/elpis_office_locks et de user_sandboxes/.office-cache réels.
    import os as _os
    _os.environ["APP_OFFICE_CACHE_DIR"] = str(base / "office-cache")
    try:
        from shared_infra.sandbox import office_convert
        office_convert.LOCK_DIR = base / "office_locks"
    except Exception:
        pass
    # Journaux de run du chat (2026-09-16) : jamais dans /tmp/elpis_chat_runs
    # réel (un test qui y écrirait ferait apparaître des runs « en cours »).
    try:
        from shared_infra.runtime import run_journal
        run_journal.RUN_DIR = base / "chat_runs"
    except Exception:
        pass
    # Racine commune : pointée sur le dossier temporaire pour que tout module
    # important ``runtime_dir`` APRÈS ce point retombe aussi dans le bac à sable.
    try:
        from shared_infra.runtime import runtime_dir
        runtime_dir.RUNTIME_DIR = base / "runtime"
        runtime_dir._verified = False
    except Exception:
        pass
    yield


@pytest.fixture(autouse=True, scope="session")
def _git_hote_selon_le_poste():
    """Git hôte (2026-09-29) : la suite tourne dans la prison bwrap quand le
    poste la permet ; sinon (CI sans user namespaces), en mode ``none``, comme
    l'y mettrait l'opérateur. Les tests de la prison sont alors sautés."""
    from shared_infra.sandbox import bwrap, git_env
    if bwrap.probe():
        yield
        return
    orig = git_env.git_isolation
    git_env.git_isolation = lambda: "none"
    yield
    git_env.git_isolation = orig


@pytest.fixture(autouse=True)
def _reset_tokenize_backoff():
    """Le disjoncteur de ``/tokenize`` (OPTIM 2026-09-26) est un état de
    module : un test au serveur injoignable ne doit pas couper le comptage
    exact du test suivant."""
    from llm_core import _llama_http
    from llm_core.context import tokens as _tok
    _llama_http._TOKENIZE_DOWN_UNTIL.clear()
    _tok._SHORT_TOKEN_MEMO.clear()
    yield
    _llama_http._TOKENIZE_DOWN_UNTIL.clear()
    _tok._SHORT_TOKEN_MEMO.clear()


@pytest.fixture(scope="session")
def _real_tool_list():
    """Liste d'outils du vrai service MCP (toutes les familles disponibles),
    construite en processus : ce que le pool ingère quand une instance se
    connecte."""
    import asyncio

    from fastmcp import Client, FastMCP

    import server.local_mcp_server as S
    target = FastMCP("registre-des-tests")
    S.register_families_on(target, [name for name, _module, _root in S.TOOL_FAMILIES])

    async def _list():
        async with Client(target) as client:
            return await client.list_tools()
    return asyncio.run(_list())


@pytest.fixture
def real_tool_registry(_real_tool_list, tmp_path, monkeypatch):
    """Registre des catégories peuplé depuis le vrai service. Un checkout neuf
    (la CI) n'a pas le cache qu'écrit une instance en marche : sans lui, tout
    outil tombe dans « other » et les tests de prompt ne vérifient rien.
    Globales et cache cross-worker isolés, restaurés à la sortie."""
    from llm_core import _mcp_categories as cats
    monkeypatch.setattr(cats, "_CACHE_PATH", tmp_path / "categories.json")
    avant = (cats._registry, dict(cats._sources), dict(cats._disk_cache))
    cats._registry, cats._sources = None, {}
    cats._disk_cache = {"at": 0.0, "reg": None}
    cats.ingest_tools(_real_tool_list, source="tests")
    yield cats
    cats._registry, cats._sources, cats._disk_cache = avant


@pytest.fixture(autouse=True)
def agent_en_thread(request):
    """Toute la suite : les sandboxes sont servies par un agent en thread, ni
    Docker ni conteneur (L4) — aucun test ne crée de conteneur par mégarde.
    ``ensure_running`` répond « en marche », ``start_agent`` lance l'agent
    sur ``P/work``. Le socket est lié dans un dossier court (un chemin de
    socket unix tient en 108 octets) puis lié en dur à sa place,
    ``P/.elpis-agent/agent.sock``. Marqueur ``agent_reel`` : les vraies
    méthodes (un test de leur argv, Docker simulé par le test). Sans
    ``monkeypatch`` : demandé ici, il changerait l'ordre de démontage des
    fixtures de chaque test."""
    if request.node.get_closest_marker("agent_reel"):
        yield []
        return
    import contextlib
    import shutil
    import tempfile
    import threading

    from shared_infra.sandbox.agent import server as agent_server
    from shared_infra.sandbox.agent_client import AGENT_RUN_DIR
    from shared_infra.sandbox.executors import _user_sandbox as us

    court: list = []
    serveurs: list = []

    async def en_marche(self):
        return us.SandboxStatus(exists=True, running=True, container_name=self.container_name)

    async def demarrer(self, replace=False):
        if not court:
            court.append(tempfile.mkdtemp(prefix="ag-"))
        cible = Path(self.sandbox_path).parent / AGENT_RUN_DIR / "agent.sock"
        cible.parent.mkdir(parents=True, exist_ok=True)
        lie = os.path.join(court[0], str(len(serveurs)))
        srv = agent_server.servir(str(self.sandbox_path), lie)
        with contextlib.suppress(FileNotFoundError):
            cible.unlink()
        os.link(lie, cible)
        fil = threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.05},
                               daemon=True)
        fil.start()
        serveurs.append((srv, fil))

    vrais = (us.UserSandbox.ensure_running, us.UserSandbox.start_agent)
    us.UserSandbox.ensure_running, us.UserSandbox.start_agent = en_marche, demarrer
    us.reset_user_sandbox_cache()                        # une sandbox par test : pas de chemin périmé
    try:
        yield serveurs
    finally:
        us.UserSandbox.ensure_running, us.UserSandbox.start_agent = vrais
        for srv, fil in serveurs:
            srv.shutdown()
            fil.join(5)
            srv.server_close()
        us.reset_user_sandbox_cache()
        for d in court:
            shutil.rmtree(d, ignore_errors=True)


def editeur_sur_agent(monkeypatch, root, username="alice"):
    """Branche ``exec_bridge`` sur une sandbox de racine ``root`` servie par
    l'agent en thread ; rend la liste des écritures demandées à l'agent
    (``(opération, chemin)``) pour vérifier qu'un refus n'a rien écrit."""
    import shared_infra.sandbox.exec_bridge as xb
    from shared_infra.sandbox import agent_client as AC
    from shared_infra.sandbox.executors import get_user_sandbox
    sb = get_user_sandbox(1, username, root)
    monkeypatch.setattr(xb, "_get_sandbox_for_user", lambda uid: sb)
    ops: list = []
    for nom in ("write", "append", "fsop"):
        vrai = getattr(AC.AgentClient, nom)

        async def espion(self, *a, _vrai=vrai, _nom=nom, **k):
            if not (_nom == "fsop" and a and a[0] == "du"):      # lecture seule
                ops.append((_nom, a[0] if a else k.get("path")))
            return await _vrai(self, *a, **k)
        monkeypatch.setattr(AC.AgentClient, nom, espion)
    return ops


def arbre_editeur(monkeypatch, root, include_hidden=False):
    """Réponse JSON de ``GET /api/sandbox/tree`` pour la sandbox de racine
    ``root`` (agent en thread)."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    import shared_infra.sandbox.routes_files as sf
    editeur_sur_agent(monkeypatch, root)
    monkeypatch.setattr(sf, "require_user_id", lambda r: 1)
    monkeypatch.setattr(sf, "_get_work_path", lambda uid: root)
    app = FastAPI()
    app.include_router(sf.router)
    r = TestClient(app).get("/api/sandbox/tree", params={"include_hidden": include_hidden})
    assert r.status_code == 200, r.text
    return r.json()
