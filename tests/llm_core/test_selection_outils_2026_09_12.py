# SPDX-License-Identifier: MIT
"""tests/llm_core/test_selection_outils_2026_09_12.py — choisir les outils un
par un, et les éteindre pour de bon.

Deux couches, deux mécanismes, et c'est le point du fichier :

* ``tools.<nom>.enabled: false`` (configuration) est appliqué avec l'action
  NATIVE de FastMCP — ``server.disable(names=…)``. L'outil sort de
  ``tools/list`` ET son appel est refusé, pour TOUS les clients (l'app,
  opencode, la suite standalone). L'ancien filtre côté boucle de chat ne
  protégeait que l'app ;
* les cases décochées du panneau sont une donnée du CHAT : elles ne peuvent
  pas passer par ``disable()`` (l'instance est partagée par tous les chats et
  tous les utilisateurs du process, et la liste d'outils est cachée 360 s).
  Elles passent par ``deny_tool_names``, la couche de deny finale.
"""
from __future__ import annotations

import pytest
from fastmcp import FastMCP

import llm_core._chat_with_tools as cwt
import llm_core._mcp_categories as cats
import server.local_mcp_server as S
from llm_core.context_config import CTX


def _serveur():
    mcp = FastMCP("essai")

    @mcp.tool(tags={"fs"})
    def lire_essai(x: str) -> dict:
        """lit"""
        return {"ok": True}

    @mcp.tool(tags={"fs"})
    def ecrire_essai(x: str) -> dict:
        """écrit"""
        return {"ok": True}

    return mcp


async def _noms(mcp):
    t = await mcp.list_tools()
    items = list(t.values()) if isinstance(t, dict) else list(t)
    return {str(getattr(i, "name", "")) for i in items}


def _config(monkeypatch, tools: dict):
    monkeypatch.setitem(CTX._raw, "tools", tools)
    for nom in tools:
        monkeypatch.setitem(S.TOOL_FAMILY_OF, nom, "fs")


# ── Couche 1 : le kill-switch natif ──────────────────────────────────────

@pytest.mark.asyncio
async def test_outil_eteint_sort_de_la_liste(monkeypatch):
    mcp = _serveur()
    _config(monkeypatch, {"ecrire_essai": {"enabled": False}})
    assert S.apply_config_disables(mcp) == ["ecrire_essai"]
    assert await _noms(mcp) == {"lire_essai"}


@pytest.mark.asyncio
async def test_outil_eteint_ne_peut_plus_etre_appele(monkeypatch):
    """Le point de la couche native : une barrière, pas un masquage."""
    mcp = _serveur()
    _config(monkeypatch, {"ecrire_essai": {"enabled": False}})
    S.apply_config_disables(mcp)
    with pytest.raises(Exception) as e:
        await mcp.call_tool("ecrire_essai", {"x": "a"})
    assert "ecrire_essai" in str(e.value)


@pytest.mark.asyncio
async def test_un_seul_transform_et_idempotent(monkeypatch):
    """``server.disable`` EMPILE un transform rejoué à chaque ``list_tools``
    (mesuré : 2 ms à vide, 12,5 ms avec 100 transforms, sur 56 outils). Un
    appel unique, une fois par instance — sinon le coût dérive en silence."""
    mcp = _serveur()
    _config(monkeypatch, {"ecrire_essai": {"enabled": False}})
    S.apply_config_disables(mcp)
    assert len(mcp.transforms) == 1
    assert S.apply_config_disables(mcp) == []
    assert len(mcp.transforms) == 1


@pytest.mark.asyncio
async def test_rien_a_eteindre_ne_pose_aucun_transform(monkeypatch):
    mcp = _serveur()
    monkeypatch.setitem(CTX._raw, "tools", {})
    assert S.apply_config_disables(mcp) == []
    assert len(mcp.transforms) == 0
    assert await _noms(mcp) == {"lire_essai", "ecrire_essai"}


@pytest.mark.asyncio
async def test_nom_inconnu_ne_desactive_rien(monkeypatch):
    """Un nom mal orthographié ne doit pas passer pour une extinction
    effective : il ne correspond à aucun outil enregistré."""
    mcp = _serveur()
    monkeypatch.setitem(CTX._raw, "tools", {"nexiste_pas": {"enabled": False}})
    assert S.apply_config_disables(mcp) == []
    assert await _noms(mcp) == {"lire_essai", "ecrire_essai"}


def test_disabled_tools_ne_lit_que_le_false_explicite(monkeypatch):
    monkeypatch.setitem(CTX._raw, "tools", {
        "_comment": "la section porte aussi de la prose",
        "a": {"enabled": False},
        "b": {"enabled": True},
        "c": {"description": "sans clé enabled"},
    })
    assert CTX.disabled_tools() == {"a"}


# ── Le registre : de quoi rendre une case à cocher ───────────────────────

@pytest.fixture
def registre_isole(tmp_path, monkeypatch):
    """Le registre et son cache cross-worker sont des GLOBALES : un test qui
    ingère des outils réécrirait le vrai fichier de l'instance et fuiterait
    sur les tests suivants. On les remet en place à la sortie."""
    monkeypatch.setattr(cats, "_CACHE_PATH", tmp_path / "categories.json")
    avant = (cats._registry, dict(cats._sources), dict(cats._disk_cache))
    cats._registry, cats._sources = None, {}
    cats._disk_cache = {"at": 0.0, "reg": None}
    yield
    cats._registry, cats._sources, cats._disk_cache = avant[0], avant[1], avant[2]


def test_tool_info_porte_titre_description_et_lecture_seule(registre_isole):
    cats.ingest_tools([
        {"name": "read_file", "description": "  Lit   un fichier  ",
         "tags": ["fs"], "meta": {"category": {"name": "fs", "label": "Fichiers"}},
         "annotations": {"title": "Lire un fichier", "readOnlyHint": True}},
    ], source="essai-panneau")
    fiche = cats.tool_info("read_file")
    assert fiche["name"] == "read_file"
    assert fiche["title"] == "Lire un fichier"
    assert fiche["read_only"] is True
    assert fiche["description"] == "Lit un fichier"


def test_tool_info_tolere_un_outil_sans_annotation(registre_isole):
    fiche = cats.tool_info("inconnu_au_registre")
    assert fiche == {"name": "inconnu_au_registre"}


# ── Couche 2 : les cases décochées du panneau ────────────────────────────

_CAT_OF = {"read_file": "fs", "edit_file": "fs", "execute_shell": "shell",
           "todowrite": "task"}


class _Outil:
    def __init__(self, nom):
        self.name = nom
        self.description = ""
        self.inputSchema = {"type": "object"}
        self.annotations = None


class _FauxPool:
    def __init__(self, outils):
        self._outils = outils

    async def get_or_connect(self, cfg, resolve_client_fn=None):
        return object(), list(self._outils)


def _install(monkeypatch):
    monkeypatch.setattr(cats, "categorize", lambda n: _CAT_OF.get(n, "other"))
    monkeypatch.setattr(cats, "get_hidden_categories", lambda: ["task"])
    monkeypatch.setattr(cats, "manifest_source", lambda: "live")
    monkeypatch.setattr(cwt, "mcp_pool", _FauxPool([_Outil(n) for n in _CAT_OF]))


_SRV = [{"type": "stdio", "name": "Local", "command": "DEFAULT_LOCAL_PYTHON",
         "filter_categories": ["fs", "shell"]}]


async def _exposes(**kw):
    _map, payload, _h, _n = await cwt._collect_mcp_tools(_SRV, None, None, **kw)
    return {t["function"]["name"] for t in payload}


@pytest.mark.asyncio
async def test_tout_est_expose_sans_exclusion(monkeypatch):
    """Le défaut : cocher une catégorie expose TOUS ses outils."""
    _install(monkeypatch)
    assert await _exposes(memory_enabled=False) == {
        "read_file", "edit_file", "execute_shell", "todowrite"}


@pytest.mark.asyncio
async def test_un_outil_decoche_disparait_du_payload(monkeypatch):
    _install(monkeypatch)
    exposes = await _exposes(memory_enabled=False, deny_tool_names={"edit_file"})
    assert "edit_file" not in exposes
    assert "read_file" in exposes          # le reste de la catégorie demeure


@pytest.mark.asyncio
async def test_le_deny_porte_aussi_les_categories_cachees(monkeypatch):
    """``todowrite`` traverse ``filter_categories`` par conception ; seule la
    couche de deny finale peut le retirer. C'est bien celle-ci."""
    _install(monkeypatch)
    assert "todowrite" not in await _exposes(
        memory_enabled=False, deny_tool_names={"todowrite"})


# ── L'endpoint du panneau ────────────────────────────────────────────────

def test_l_endpoint_expose_les_outils_de_chaque_categorie(registre_isole, monkeypatch):
    """``/api/mcp/categories`` retirait la liste ``tools`` du descripteur : le
    panneau n'avait rien à cocher. Elle est désormais rendue, décorée."""
    from shared_infra.mcp import panel
    monkeypatch.setattr(panel, "require_user_id", lambda _r: 1)
    _CAT = {"name": "fs", "label": "Fichiers", "icon": "ph-folder"}
    cats.ingest_tools([
        {"name": "read_file", "description": "Lit", "tags": ["fs"],
         "meta": {"category": _CAT},
         "annotations": {"title": "Lire un fichier", "readOnlyHint": True}},
        {"name": "edit_file", "description": "Modifie", "tags": ["fs"],
         "meta": {"category": _CAT},
         "annotations": {"title": "Modifier un fichier", "readOnlyHint": False}},
    ], source="essai-endpoint")
    rep = panel.api_mcp_categories(object())
    fs = [c for c in rep["categories"] if c["name"] == "fs"][0]
    assert [t["name"] for t in fs["tools"]] == ["read_file", "edit_file"]
    assert fs["tools"][0]["title"] == "Lire un fichier"
    assert fs["tools"][0]["read_only"] is True
    assert fs["tools"][1]["read_only"] is False


def test_l_endpoint_n_expose_pas_les_categories_cachees(registre_isole, monkeypatch):
    """``task``/``memory`` sont des aides model-side : jamais cochables, donc
    jamais listées — sinon le panneau proposerait de retirer ``todowrite``."""
    from shared_infra.mcp import panel
    monkeypatch.setattr(panel, "require_user_id", lambda _r: 1)
    cats.ingest_tools([
        {"name": "read_file", "tags": ["fs"],
         "meta": {"category": {"name": "fs", "label": "Fichiers"}}},
        {"name": "todowrite", "tags": ["task"],
         "meta": {"category": {"name": "task", "label": "Tâches", "hidden": True}}},
    ], source="essai-endpoint")
    noms = {c["name"] for c in panel.api_mcp_categories(object())["categories"]}
    assert "fs" in noms and "task" not in noms


@pytest.mark.asyncio
async def test_une_famille_enregistree_plus_tard_est_eteinte_aussi(monkeypatch):
    """Les familles arrivent parfois en plusieurs vagues (hôte recomposé,
    tests). Un simple drapeau « déjà appliqué » aurait laissé la seconde vague
    allumée — d'où le suivi des noms réellement éteints."""
    mcp = _serveur()
    # ``TOOL_FAMILY_OF`` est peuplée À L'ENREGISTREMENT : au premier passage,
    # ``tard_essai`` n'y est pas encore — c'est un nom inconnu, pas une
    # extinction.
    monkeypatch.setitem(CTX._raw, "tools", {"ecrire_essai": {"enabled": False},
                                            "tard_essai": {"enabled": False}})
    monkeypatch.setitem(S.TOOL_FAMILY_OF, "ecrire_essai", "fs")
    assert S.apply_config_disables(mcp) == ["ecrire_essai"]

    @mcp.tool(tags={"fs"})
    def tard_essai(x: str) -> dict:
        """arrivée tardive"""
        return {"ok": True}

    monkeypatch.setitem(S.TOOL_FAMILY_OF, "tard_essai", "fs")
    assert S.apply_config_disables(mcp) == ["tard_essai"]
    assert await _noms(mcp) == {"lire_essai"}
