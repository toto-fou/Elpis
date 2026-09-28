# SPDX-License-Identifier: MIT
"""Store protégé des skills perso (hors sandbox) + miroir de travail.

Le store réel (``USER_SKILLS_DIR/<user>/``) est hors de portée des outils
fs/shell du modèle ; la sandbox ne contient qu'une COPIE (``<sandbox>/skills``)
régénérée à chaque écriture et auto-réparée par ``skill_get``. On couvre :
migration douce de l'ancien emplacement, sync du miroir, ajout contrôlé de
fichiers groupés (``add_user_skill_file`` + outil ``skill_add_file``).
"""
from __future__ import annotations

import pytest

import llm_core.skills as s


# ── Faux MCP / Context (même pattern que test_skill_get_tool.py) ────────────
class FakeMCP:
    def __init__(self):
        self.tools = {}

    def tool(self, **kw):
        def deco(fn):
            self.tools[fn.__name__] = fn
            return fn
        return deco

    def resource(self, *a, **k):
        return lambda fn: fn

    def prompt(self, *a, **k):
        return lambda fn: fn


class FakeRC:
    def __init__(self, meta):
        self.meta = meta


class FakeCtx:
    def __init__(self, **meta):
        self.request_context = FakeRC(meta)

    async def info(self, *a, **k):
        pass

    async def debug(self, *a, **k):
        pass


def _mk_store_skill(store, slug, body="BODY", files=None):
    d = store / slug
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text(
        f"---\nname: {slug}\ndescription: d\n---\n\n{body}\n", encoding="utf-8")
    for rel, content in (files or {}).items():
        p = d / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
    return d


# ── Migration douce ──────────────────────────────────────────────────────────

def test_ensure_migrates_legacy_sandbox_skills(tmp_path):
    sandbox = tmp_path / "sandboxes" / "alice"
    legacy = sandbox / "skills"
    _mk_store_skill(legacy, "mon-skill", files={"scripts/run.sh": "echo ok\n"})
    store = tmp_path / "user_skills" / "alice"

    out = s.ensure_user_skills_store(store, sandbox)
    assert out == store
    # Déplacé (pas copié) vers le store…
    assert (store / "mon-skill" / "SKILL.md").is_file()
    assert (store / "mon-skill" / "scripts" / "run.sh").is_file()
    # …et le miroir sandbox recréé immédiatement (transparent pour l'agent).
    assert (sandbox / "skills" / "mon-skill" / "scripts" / "run.sh").is_file()


def test_ensure_noop_when_store_exists(tmp_path):
    sandbox = tmp_path / "sb" / "alice"
    _mk_store_skill(sandbox / "skills", "vieux")          # reliquat sandbox
    store = tmp_path / "store" / "alice"
    _mk_store_skill(store, "actuel")
    s.ensure_user_skills_store(store, sandbox)
    # Le store existant PRIME : pas d'écrasement par le reliquat sandbox.
    assert (store / "actuel").is_dir()
    assert not (store / "vieux").exists()
    assert (sandbox / "skills" / "vieux").is_dir()        # reliquat intact (copie)


def test_ensure_idempotent_without_legacy(tmp_path):
    store = tmp_path / "store" / "alice"
    assert s.ensure_user_skills_store(store, None) == store
    assert s.ensure_user_skills_store(store, tmp_path / "nope") == store


# ── Miroir sandbox ───────────────────────────────────────────────────────────

def test_sync_mirror_copies_and_self_heals(tmp_path):
    store = tmp_path / "store" / "alice"
    sandbox = tmp_path / "sb" / "alice"
    sandbox.mkdir(parents=True)
    _mk_store_skill(store, "proc", files={"scripts/x.sh": "echo x\n"})

    mirror = s.sync_user_skills_mirror(store, sandbox)
    assert mirror == sandbox / "skills"
    assert (mirror / "proc" / "scripts" / "x.sh").read_text() == "echo x\n"

    # Le modèle saccage la copie (rm -rf) → resync = self-heal, store intact.
    import shutil
    shutil.rmtree(mirror)
    assert s.sync_user_skills_mirror(store, sandbox) == mirror
    assert (mirror / "proc" / "SKILL.md").is_file()
    assert (store / "proc" / "SKILL.md").is_file()

    # Une modif directe du miroir n'atteint JAMAIS le store et est écrasée.
    (mirror / "proc" / "SKILL.md").write_text("CORROMPU", encoding="utf-8")
    s.sync_user_skills_mirror(store, sandbox)
    assert "CORROMPU" not in (mirror / "proc" / "SKILL.md").read_text()


def test_sync_mirror_removed_when_store_empty(tmp_path):
    store = tmp_path / "store" / "alice"
    store.mkdir(parents=True)                              # vide
    sandbox = tmp_path / "sb" / "alice"
    (sandbox / "skills" / "fantome").mkdir(parents=True)
    s.sync_user_skills_mirror(store, sandbox)
    assert not (sandbox / "skills").exists()
    assert s.sync_user_skills_mirror(store, None) is None  # pas de sandbox → no-op


# ── find_user_skill_dir / add_user_skill_file ───────────────────────────────

def test_find_user_skill_dir_qualified(tmp_path):
    store = tmp_path / "store"
    _mk_store_skill(store, "pkg")
    _mk_store_skill(store, "pkg/child")
    assert s.find_user_skill_dir(store, "pkg") == store / "pkg"
    assert s.find_user_skill_dir(store, "pkg/child") == store / "pkg" / "child"
    assert s.find_user_skill_dir(store, "child") == store / "pkg" / "child"
    assert s.find_user_skill_dir(store, "ghost") is None


def test_add_user_skill_file_ok(tmp_path):
    store = tmp_path / "store"
    _mk_store_skill(store, "proc")
    p = s.add_user_skill_file(store, "proc", "scripts/run.sh", "echo ok\n")
    assert p == store / "proc" / "scripts" / "run.sh"
    assert p.read_text() == "echo ok\n"


def test_add_user_skill_file_rejections(tmp_path, monkeypatch):
    store = tmp_path / "store"
    _mk_store_skill(store, "proc")
    with pytest.raises(s.SkillSaveError):                  # traversal
        s.add_user_skill_file(store, "proc", "../evil.sh", "x")
    with pytest.raises(s.SkillSaveError):                  # segment caché
        s.add_user_skill_file(store, "proc", ".env", "x")
    with pytest.raises(s.SkillSaveError):                  # SKILL.md réservé
        s.add_user_skill_file(store, "proc", "SKILL.md", "x")
    with pytest.raises(s.SkillSaveError):                  # contenu vide
        s.add_user_skill_file(store, "proc", "scripts/a.sh", "")
    monkeypatch.setattr(s, "SKILL_FILE_MAX_BYTES", 4)
    with pytest.raises(s.SkillSaveError):                  # cap taille
        s.add_user_skill_file(store, "proc", "scripts/a.sh", "trop gros")
    with pytest.raises(s.SkillSaveError):                  # skill inexistant
        s.add_user_skill_file(store, "ghost", "scripts/a.sh", "x")


# ── Outils MCP (chemin réel des closures register) ──────────────────────────

@pytest.fixture
def tools_env(tmp_path, monkeypatch):
    g = tmp_path / "skills"
    (g / "learned").mkdir(parents=True)
    monkeypatch.setattr(s, "_global_skills_root", lambda: g)
    monkeypatch.setattr(s, "_learned_skills_root", lambda: g / "learned")
    monkeypatch.setenv("APP_SANDBOX_DIR", str(tmp_path / "sandboxes"))
    monkeypatch.setenv("APP_USER_SKILLS_DIR", str(tmp_path / "user_skills"))
    (tmp_path / "sandboxes").mkdir()
    from llm_core.tools import skill_tools
    m = FakeMCP()
    skill_tools.register(m)
    return m.tools, tmp_path


def _is_err(r):
    return r.__class__.__name__ == "ErrEnvelope"


async def test_skill_save_writes_store_and_mirror(tools_env):
    tools, root = tools_env
    r = await tools["skill_save"](FakeCtx(username="alice"), name="ma-proc",
                                  description="d", body="## Étapes\n1. go",
                                  tags=None, domain=None)
    assert not _is_err(r)
    store_md = root / "user_skills" / "alice" / "ma-proc" / "SKILL.md"
    mirror_md = root / "sandboxes" / "alice" / "skills" / "ma-proc" / "SKILL.md"
    assert store_md.is_file()                  # vérité : store protégé
    assert mirror_md.is_file()                 # copie de travail sandbox


async def test_skill_add_file_tool_and_mirror(tools_env):
    tools, root = tools_env
    await tools["skill_save"](FakeCtx(username="alice"), name="ma-proc",
                              description="d", body="B",
                              tags=None, domain=None)
    r = await tools["skill_add_file"](FakeCtx(username="alice"), name="ma-proc",
                                      path="scripts/run.sh", content="echo ok\n")
    assert not _is_err(r)
    assert (root / "user_skills" / "alice" / "ma-proc" / "scripts" / "run.sh").is_file()
    assert (root / "sandboxes" / "alice" / "skills" / "ma-proc" / "scripts" / "run.sh").is_file()
    # Rejets : traversal + skill manquant.
    r2 = await tools["skill_add_file"](FakeCtx(username="alice"), name="ma-proc",
                                       path="../evil", content="x")
    assert _is_err(r2)
    r3 = await tools["skill_add_file"](FakeCtx(username="alice"), name="ghost",
                                       path="scripts/x", content="x")
    assert _is_err(r3)


@pytest.mark.parametrize("domaine", [None, "qdrant"])
async def test_le_chemin_de_la_note_est_resoluble(tools_env, domaine):
    """AUDIT 2026-08-23 — LE constat : ``skill_add_file`` annonçait un chemin
    relatif au STORE (donc préfixé ``[<domaine>/]<slug>/``) alors que
    ``skill_read_file`` et ``skill_run_script`` résolvent SOUS ``skill_dir``.
    Le préfixe était compté deux fois et le chemin n'existait jamais : le
    modèle suivait la consigne qu'on venait de lui donner et récoltait
    ``skill_file_not_found``.

    Ce test enchaîne les deux appels, exactement comme le modèle."""
    import re as _re
    tools, _root = tools_env
    ctx = FakeCtx(username="alice")
    await tools["skill_save"](ctx, name="reset-qdrant", description="d",
                              body="B", tags=None, domain=domaine)
    r = await tools["skill_add_file"](ctx, name="reset-qdrant",
                                      path="scripts/run.sh", content="echo ok\n")
    assert not _is_err(r)

    # Le chemin que la note DICTE au modèle.
    m = _re.search(r"skill_read_file\('reset-qdrant', '([^']+)'\)", r.note)
    assert m, r.note
    chemin_dicte = m.group(1)

    lu = await tools["skill_read_file"](ctx, name="reset-qdrant",
                                        path=chemin_dicte)
    assert not _is_err(lu), (
        f"le chemin dicté par skill_add_file ({chemin_dicte!r}) est refusé "
        f"par skill_read_file : {lu}")

    # …et c'est bien celui que ``skill_get`` publie dans ``files``.
    infos = await tools["skill_get"](ctx, name="reset-qdrant")
    assert chemin_dicte in (infos.files or []), \
        f"{chemin_dicte!r} absent de files={infos.files!r}"


async def test_skill_get_reads_store_not_mirror(tools_env):
    # Les skills ne sont plus montés dans /work : skill_get sert le corps depuis
    # le STORE protégé, indépendamment du miroir sandbox (désormais inutile et
    # plus régénéré ici). sandbox_path est toujours None.
    tools, root = tools_env
    await tools["skill_save"](FakeCtx(username="alice"), name="ma-proc",
                              description="d", body="B",
                              tags=None, domain=None)
    mirror = root / "sandboxes" / "alice" / "skills"
    import shutil
    shutil.rmtree(mirror, ignore_errors=True)   # le miroir n'est plus pertinent
    r = await tools["skill_get"](FakeCtx(username="alice"), name="ma-proc")
    assert not _is_err(r) and r.source == "user"
    assert r.body == "B"                        # servi depuis le store protégé
    assert r.sandbox_path is None               # skills hors du filesystem


async def test_skill_read_file_reads_bundled(tools_env):
    """skill_read_file : lit un fichier bundlé depuis le STORE (skills hors
    /work) + containment (refuse ../) + introuvable."""
    tools, _ = tools_env
    await tools["skill_save"](FakeCtx(username="alice"), name="pkg",
                              description="d", body="B", tags=None, domain=None)
    await tools["skill_add_file"](FakeCtx(username="alice"), name="pkg",
                                  path="references/notes.md", content="HELLO-REF")
    r = await tools["skill_read_file"](FakeCtx(username="alice"), name="pkg",
                                       path="references/notes.md")
    assert not _is_err(r)
    assert r.content == "HELLO-REF" and r.path == "references/notes.md"
    # containment : ../ refusé
    r2 = await tools["skill_read_file"](FakeCtx(username="alice"), name="pkg",
                                        path="../evil")
    assert _is_err(r2)
    # fichier inexistant
    r3 = await tools["skill_read_file"](FakeCtx(username="alice"), name="pkg",
                                        path="references/missing.md")
    assert _is_err(r3) and r3.error == "skill_file_not_found"
    # skill inconnu
    r4 = await tools["skill_read_file"](FakeCtx(username="alice"), name="nope",
                                        path="x")
    assert _is_err(r4) and r4.error == "skill_not_found"


async def test_skill_run_script_validation(tools_env):
    """skill_run_script : chemins de validation SANS Docker (extension non
    supportée / script introuvable / ../ / skill inconnu)."""
    tools, _ = tools_env
    await tools["skill_save"](FakeCtx(username="alice"), name="pkg",
                              description="d", body="B", tags=None, domain=None)
    await tools["skill_add_file"](FakeCtx(username="alice"), name="pkg",
                                  path="data/blob.bin", content="x")
    # extension non supportée → rejet AVANT tout exec conteneur
    r = await tools["skill_run_script"](FakeCtx(username="alice"), name="pkg",
                                        script="data/blob.bin", args=None,
                                        timeout_sec=None)
    assert _is_err(r) and r.error == "skill_run_unsupported"
    # script introuvable
    r2 = await tools["skill_run_script"](FakeCtx(username="alice"), name="pkg",
                                         script="scripts/missing.py", args=None,
                                         timeout_sec=None)
    assert _is_err(r2) and r2.error == "skill_script_not_found"
    # containment ../
    r3 = await tools["skill_run_script"](FakeCtx(username="alice"), name="pkg",
                                         script="../evil.py", args=None,
                                         timeout_sec=None)
    assert _is_err(r3) and r3.error == "skill_run_rejected"
    # skill inconnu
    r4 = await tools["skill_run_script"](FakeCtx(username="alice"), name="nope",
                                         script="scripts/run.py", args=None,
                                         timeout_sec=None)
    assert _is_err(r4) and r4.error == "skill_not_found"


async def test_skill_run_script_rb_unsupported(tools_env):
    # #2 : ruby n'est pas dans l'image → .rb retiré de _SKILL_INTERP → rejet
    # propre (skill_run_unsupported) au lieu d'un rc 127 opaque. (Avant exec.)
    tools, _ = tools_env
    await tools["skill_save"](FakeCtx(username="alice"), name="pkg",
                              description="d", body="B", tags=None, domain=None)
    await tools["skill_add_file"](FakeCtx(username="alice"), name="pkg",
                                  path="scripts/x.rb", content="puts 1")
    r = await tools["skill_run_script"](FakeCtx(username="alice"), name="pkg",
                                        script="scripts/x.rb", args=None, timeout_sec=None)
    assert _is_err(r) and r.error == "skill_run_unsupported"


async def test_skill_run_script_ok_reflects_returncode(tools_env, monkeypatch):
    # #4 : ok reflète rc (==0) — comme execute_shell ; un script crashé n'est
    # PAS un succès. On mocke le bridge (pas de Docker).
    tools, _ = tools_env
    await tools["skill_save"](FakeCtx(username="alice"), name="pkg",
                              description="d", body="B", tags=None, domain=None)
    await tools["skill_add_file"](FakeCtx(username="alice"), name="pkg",
                                  path="scripts/run.py", content="print(1)")
    import llm_core.tools._exec_bridge as br

    monkeypatch.setattr(br, "run_shell_via_executor", lambda **kw: {
        "returncode": 1, "stdout": "", "stderr": "boom", "truncated": False, "ok": False})
    r = await tools["skill_run_script"](FakeCtx(username="alice"), name="pkg",
                                        script="scripts/run.py", args=None, timeout_sec=None)
    assert not _is_err(r)
    assert r.ok is False and r.returncode == 1 and "boom" in r.stderr

    monkeypatch.setattr(br, "run_shell_via_executor", lambda **kw: {
        "returncode": 0, "stdout": "ok", "stderr": "", "truncated": False, "ok": True})
    r2 = await tools["skill_run_script"](FakeCtx(username="alice"), name="pkg",
                                         script="scripts/run.py", args=None, timeout_sec=None)
    assert r2.ok is True and r2.returncode == 0


async def test_skill_run_script_runs_from_work(tools_env, monkeypatch):
    """Bug « fichiers sandbox en paramètres » : le runner doit exécuter le
    script DEPUIS /work (les chemins relatifs d'`args` résolvent dans le
    dossier de travail, les sorties y survivent au trap de nettoyage), en
    adressant le script en absolu dans le staging ($d/$r, $SKILL_DIR posé)."""
    tools, _ = tools_env
    await tools["skill_save"](FakeCtx(username="alice"), name="pkg",
                              description="d", body="B", tags=None, domain=None)
    await tools["skill_add_file"](FakeCtx(username="alice"), name="pkg",
                                  path="scripts/run.sh", content="echo hi")
    import llm_core.tools._exec_bridge as br

    captured = {}

    def fake_run(**kw):
        captured.update(kw)
        return {"returncode": 0, "stdout": "", "stderr": "",
                "truncated": False, "ok": True}

    monkeypatch.setattr(br, "run_shell_via_executor", fake_run)
    r = await tools["skill_run_script"](FakeCtx(username="alice"), name="pkg",
                                        script="scripts/run.sh",
                                        args=["src/x.py", "tests/"],
                                        env={"APPLY": "1"}, timeout_sec=None)
    assert not _is_err(r)
    tokens = captured["tokens"]
    runner = tokens[2]
    assert "cd /work" in runner, "le script doit tourner depuis /work"
    assert 'cd "$d" || exit 94' not in runner, "l'ancrage sur le staging est le bug"
    assert '"$d/$r"' in runner and 'SKILL_DIR="$d"' in runner
    # ["bash", "-c", runner, "skill_run", interp, rel, *args]
    assert tokens[4:6] == ["bash", "scripts/run.sh"]
    assert tokens[6:] == ["src/x.py", "tests/"]
    assert captured["env_extra"] == {"APPLY": "1"}


async def test_skill_run_script_env_rejected(tools_env, monkeypatch):
    """env : UPPER_SNAKE_CASE seulement ; PATH/LD_*/clé minuscule → rejet
    AVANT tout exec conteneur (la plomberie du wrapper reste intacte)."""
    tools, _ = tools_env
    await tools["skill_save"](FakeCtx(username="alice"), name="pkg",
                              description="d", body="B", tags=None, domain=None)
    await tools["skill_add_file"](FakeCtx(username="alice"), name="pkg",
                                  path="scripts/run.sh", content="echo hi")
    import llm_core.tools._exec_bridge as br

    def boom(**kw):                                  # pragma: no cover
        raise AssertionError("exec ne doit pas être atteint")

    monkeypatch.setattr(br, "run_shell_via_executor", boom)
    for bad in ({"PATH": "/tmp"}, {"LD_PRELOAD": "x"}, {"minuscule": "1"},
                {"SKILL_DIR": "/evil"},
                {f"K{i}": "v" for i in range(17)}):
        r = await tools["skill_run_script"](FakeCtx(username="alice"), name="pkg",
                                            script="scripts/run.sh", args=None,
                                            env=bad, timeout_sec=None)
        assert _is_err(r) and r.error == "skill_run_rejected", f"env={bad!r}"


async def test_skill_read_file_legacy_no_sibling_fallback(tools_env):
    # #10 : un skill legacy mono-fichier (skill_dir=None) ne doit PAS retomber
    # sur spec.path.parent (dossier de domaine partagé → fichiers voisins).
    tools, root = tools_env
    g = root / "skills"
    (g / "legacy-proc.md").write_text(
        "---\nname: legacy-proc\ndescription: d\n---\n\nBODY\n", encoding="utf-8")
    (g / "secret-sibling.md").write_text("TOP SECRET", encoding="utf-8")
    r = await tools["skill_read_file"](FakeCtx(username="alice"),
                                       name="legacy-proc", path="secret-sibling.md")
    assert _is_err(r) and r.error == "skill_no_files"


async def test_ask_user_tool_validates(tools_env):
    """ask_user (restauré 2026-07-19) : normalise (caps, q requis) et renvoie
    count ; rejette le vide. Non-bloquant : le résultat oriente le modèle, le
    panneau est rendu par le front sur l'événement tool_call."""
    from llm_core.tools._models import AskUserResult, __all__ as _models_all
    assert "AskUserResult" in _models_all
    tools, _root = tools_env
    r = await tools["ask_user"](FakeCtx(username="alice"), questions=[
        {"q": "Quel déclencheur ?", "options": ["Déploiement", "Incident"], "multi": True},
        {"question": "Commande exacte ?", "options": []},
        {"q": "   "},                       # vide → écarté
        "pas-un-dict",                      # ignoré
    ])
    assert not _is_err(r)
    assert isinstance(r, AskUserResult)
    assert r.count == 2 and r.displayed is True
    assert "End your turn" in r.note        # consigne anti-répétition (EN)

    r2 = await tools["ask_user"](FakeCtx(username="alice"), questions=[])
    assert _is_err(r2) and r2.error == "ask_user_rejected"
