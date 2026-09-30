# SPDX-License-Identifier: MIT
"""tests/llm_core/test_plan_mode_read_only.py — mode LECTURE SEULE (« /plan »).

Le mode réduit la surface d'outils à ce qui est ANNOTÉ read-only dans le
protocole MCP (annotations posées à la source par ``tools/_toolkit.py``).

Le point dur est le sens du défaut : c'est une ALLOW-LIST, donc un outil dont
l'annotation manque ou est illisible doit TOMBER. Un fail-ouvert donnerait un
mode « lecture seule » qui laisse passer ``write_file`` — pire que pas de mode
du tout, puisque l'utilisateur y ferait confiance. Deux tests visent
précisément ça (``test_outil_sans_annotation_tombe``,
``test_annotations_illisibles_tombent``).

Couvre aussi : le contournement évident (une catégorie CACHÉE ne bénéficie
d'aucune exception ici), et la non-régression hors mode.
"""
from __future__ import annotations

import pytest

import llm_core._chat_with_tools as cwt
import llm_core._mcp_categories as cats

# (nom, catégorie, read-only ?) — un échantillon représentatif des vraies
# annotations : lectures fs/git, écritures fs, shell, et la catégorie cachée.
_CATALOGUE = [
    ("read_file",     "fs",    True),
    ("list_files",    "fs",    True),
    ("code",          "fs",    True),
    ("git_query",     "git",   True),
    ("write_file",    "fs",    False),
    ("edit_file",     "fs",    False),
    ("manage_files",  "fs",    False),
    ("execute_shell", "shell", False),
    ("git_commit",    "git",   False),
    ("todowrite",     "task",  False),   # catégorie CACHÉE et mutante
]
_CAT_OF = {n: c for n, c, _ in _CATALOGUE}
_RO = {n for n, _, ro in _CATALOGUE if ro}


class _ToolObj:
    """Outil vu du client MCP : annotations portées par un ATTRIBUT.

    C'est la forme réelle (modèle pydantic ``ToolAnnotations``) ; le fake
    dict-only ne prouverait rien sur ce chemin.
    """

    def __init__(self, name, read_only):
        self.name = name
        self.description = ""
        self.inputSchema = {"type": "object"}
        self.annotations = type("Ann", (), {
            "readOnlyHint": read_only, "destructiveHint": False,
            "idempotentHint": False, "openWorldHint": False,
        })()


class _FakePool:
    def __init__(self, tools):
        self._tools = tools

    async def get_or_connect(self, cfg, resolve_client_fn=None):
        return object(), list(self._tools)


def _install(monkeypatch, tools):
    monkeypatch.setattr(cats, "categorize", lambda n: _CAT_OF.get(n, "other"))
    monkeypatch.setattr(cats, "get_hidden_categories", lambda: ["task"])
    monkeypatch.setattr(cats, "manifest_source", lambda: "live")
    monkeypatch.setattr(cwt, "mcp_pool", _FakePool(tools))


_SRV = [{"type": "stdio", "name": "Local", "command": "DEFAULT_LOCAL_PYTHON",
         "filter_categories": ["fs", "shell", "git"]}]


async def _exposed(**kw):
    _map, payload, _h, _n = await cwt._collect_mcp_tools(_SRV, None, None, **kw)
    return {t["function"]["name"] for t in payload}


# ── Le helper d'annotation, isolément ────────────────────────────────────

def _ro(tool):
    from llm_core._tool_traits import tool_traits
    return tool_traits("x", tool=tool).read_only

def test_helper_lit_lattribut_camel_case():
    assert _ro(_ToolObj("read_file", True)) is True
    assert _ro(_ToolObj("write_file", False)) is False


def test_helper_lit_un_dict():
    assert _ro({"name": "x", "annotations": {"readOnlyHint": True}}) is True
    assert _ro({"name": "x", "annotations": {"readOnlyHint": False}}) is False


def test_helper_tolere_le_snake_case():
    """La forme de fil des annotations a bougé entre versions de FastMCP."""
    assert _ro({"name": "x", "annotations": {"read_only_hint": True}}) is True


def test_helper_sans_annotation_est_faux():
    """LE point du fail-fermé : pas d'annotation ⇒ pas read-only."""
    assert _ro({"name": "x"}) is False
    assert _ro({"name": "x", "annotations": None}) is False
    assert _ro(object()) is False


# ── Le filtrage réel ─────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_mode_actif_ne_garde_que_les_read_only(monkeypatch):
    _install(monkeypatch, [_ToolObj(n, ro) for n, _, ro in _CATALOGUE])
    exposed = await _exposed(memory_enabled=False, read_only=True)
    assert exposed == {n for n in _RO if _CAT_OF[n] != "task"}
    assert "write_file" not in exposed
    assert "execute_shell" not in exposed
    assert "git_commit" not in exposed


@pytest.mark.asyncio
async def test_categorie_cachee_sans_exception(monkeypatch):
    """Les catégories cachées traversent ``filter_categories`` par conception.

    Le filtre lecture seule, lui, s'applique AVANT ce bypass : ``todowrite``
    est mutant, il tombe comme les autres.
    """
    _install(monkeypatch, [_ToolObj(n, ro) for n, _, ro in _CATALOGUE])
    exposed = await _exposed(memory_enabled=False, read_only=True)
    assert "todowrite" not in exposed


@pytest.mark.asyncio
async def test_outil_sans_annotation_tombe(monkeypatch):
    """Un serveur MCP tiers qui n'annote rien ne doit pas passer en force."""
    _install(monkeypatch, [
        _ToolObj("read_file", True),
        {"name": "outil_tiers", "description": "", "inputSchema": {"type": "object"}},
    ])
    monkeypatch.setattr(cats, "categorize", lambda n: "fs")
    exposed = await _exposed(memory_enabled=False, read_only=True)
    assert exposed == {"read_file"}


@pytest.mark.asyncio
async def test_annotations_illisibles_tombent(monkeypatch):
    """Annotations présentes mais sans le hint attendu : on ne devine pas."""
    _install(monkeypatch, [
        {"name": "bizarre", "description": "", "inputSchema": {"type": "object"},
         "annotations": {"title": "Bizarre"}},
    ])
    monkeypatch.setattr(cats, "categorize", lambda n: "fs")
    assert await _exposed(memory_enabled=False, read_only=True) == set()


@pytest.mark.asyncio
async def test_hors_mode_rien_ne_change(monkeypatch):
    """Non-régression : sans le mode, la surface est celle des catégories."""
    _install(monkeypatch, [_ToolObj(n, ro) for n, _, ro in _CATALOGUE])
    exposed = await _exposed(memory_enabled=False, read_only=False)
    assert exposed == set(_CAT_OF)          # todowrite inclus (catégorie cachée)
    assert "write_file" in exposed


@pytest.mark.asyncio
async def test_defaut_est_hors_mode(monkeypatch):
    """Le paramètre est opt-in : ne rien passer ne réduit rien."""
    _install(monkeypatch, [_ToolObj(n, ro) for n, _, ro in _CATALOGUE])
    assert await _exposed(memory_enabled=False) == set(_CAT_OF)


@pytest.mark.asyncio
async def test_les_builtins_ne_sont_pas_filtres(monkeypatch):
    """Les builtins n'ont pas d'annotations : les soumettre au fail-fermé
    supprimerait le RAG, qui est de la consultation. Leur barrière est
    ``deny_tool_names`` — c'est là que la route met ``task``.
    """
    _install(monkeypatch, [_ToolObj(n, ro) for n, _, ro in _CATALOGUE])
    builtins = {
        "rag_search": {"definition": {"type": "function",
                                      "function": {"name": "rag_search"}},
                       "handler": lambda **k: None},
        "task": {"definition": {"type": "function", "function": {"name": "task"}},
                 "handler": lambda **k: None},
    }
    _map, payload, handlers, _n = await cwt._collect_mcp_tools(
        _SRV, builtins, None, memory_enabled=False, read_only=True,
        deny_tool_names={"task"},
    )
    names = {t["function"]["name"] for t in payload}
    assert "rag_search" in names          # la consultation reste
    assert "task" not in names            # le sous-agent tombe
    assert "task" not in handlers


@pytest.mark.asyncio
async def test_surface_videe_nest_pas_une_panne_de_connexion(monkeypatch):
    """Lecture seule + catégories toutes mutantes ⇒ zéro outil, ce qui est
    un CHOIX de filtrage, pas un serveur injoignable.

    Le code levait ici « Impossible de se connecter aux serveurs MCP —
    vérifiez la configuration », envoyant l'utilisateur chercher une panne
    inexistante alors que la connexion avait parfaitement réussi. Le tour
    doit simplement se faire sans outils.
    """
    _install(monkeypatch, [_ToolObj("execute_shell", False),
                           _ToolObj("write_file", False)])
    srv = [{"type": "stdio", "name": "Local", "command": "DEFAULT_LOCAL_PYTHON",
            "filter_categories": ["fs", "shell"]}]
    _map, payload, _h, connected = await cwt._collect_mcp_tools(
        srv, None, None, memory_enabled=False, read_only=True)
    assert payload == []
    assert connected                      # la connexion, elle, a bien eu lieu


@pytest.mark.asyncio
async def test_vraie_panne_de_connexion_leve_toujours(monkeypatch):
    """Non-régression de la garde : un serveur réellement injoignable doit
    continuer de lever, avec son message d'origine."""
    class _PoolKo:
        async def get_or_connect(self, cfg, resolve_client_fn=None):
            raise RuntimeError("connexion refusée")

    monkeypatch.setattr(cats, "categorize", lambda n: "fs")
    monkeypatch.setattr(cats, "get_hidden_categories", lambda: ["task"])
    monkeypatch.setattr(cats, "manifest_source", lambda: "live")
    monkeypatch.setattr(cwt, "mcp_pool", _PoolKo())
    with pytest.raises(RuntimeError, match="Impossible de se connecter"):
        await cwt._collect_mcp_tools(_SRV, None, None, memory_enabled=False)


# ── Le rappel système ────────────────────────────────────────────────────

def test_bloc_systeme_injecte_seulement_en_mode():
    from llm_core._system_prompts import assemble_system_messages
    hors = assemble_system_messages(custom_sys="Socle.", skills_enabled=False)
    dedans = assemble_system_messages(custom_sys="Socle.", skills_enabled=False,
                                      plan_mode=True)
    assert "Read-only mode" not in hors[0]["content"]
    assert "Read-only mode" in dedans[0]["content"]
    # Le détour par le shell est nommé explicitement : c'est la tentation.
    assert "shell" in dedans[0]["content"].lower()


def test_bloc_systeme_reste_dans_le_prefixe_stable():
    """Placé AVANT les corps de skills, qui sont volontairement en fin de
    message système pour ne pas invalider le préfixe mis en cache."""
    from llm_core._system_prompts import assemble_system_messages
    out = assemble_system_messages(custom_sys="Socle.", skills_enabled=False,
                                   memory_block="# Memory\nnote", plan_mode=True)
    contenu = out[0]["content"]
    assert contenu.index("Read-only mode") < contenu.index("# Memory")


def test_bloc_systeme_vient_du_fichier_dedie():
    """2026-08-16 : le texte servi vient de ``system_prompts/PLAN_MODE.md``
    (éditable à froid, gardes budget/full-EN) — pas de la constante Python.
    Marqueurs propres au fichier : la structure du livrable."""
    from llm_core._system_prompts import assemble_system_messages
    contenu = assemble_system_messages(custom_sys="Socle.", skills_enabled=False,
                                       plan_mode=True)[0]["content"]
    for marqueur in ("Deliverable", "Findings", "Risks", "ends automatically"):
        assert marqueur in contenu, marqueur


def test_bloc_systeme_repli_si_fichier_absent(monkeypatch):
    """Déploiement partiel (PLAN_MODE.md manquant) : le repli en dur reste —
    un mode lecture seule SANS rappel système serait un mode affaibli en
    silence, précisément ce que le fail-fermé du filtre interdit ailleurs."""
    import llm_core._system_prompts as sp
    orig = sp._load_fragment
    monkeypatch.setattr(sp, "_load_fragment",
                        lambda stem: "" if stem == "PLAN_MODE" else orig(stem))
    contenu = sp.assemble_system_messages(custom_sys="Socle.", skills_enabled=False,
                                          plan_mode=True)[0]["content"]
    assert "Read-only mode" in contenu
    assert "Deliver a concrete plan" in contenu     # texte du repli
