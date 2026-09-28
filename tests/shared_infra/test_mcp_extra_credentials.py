# SPDX-License-Identifier: MIT
"""Créneaux d'identifiants SUPPLÉMENTAIRES d'un connecteur MCP.

Le problème d'origine : un serveur ne portait qu'UN créneau d'authentification,
et il visait toujours ``Authorization``. Or beaucoup de services en demandent
deux — un jeton de transport (« Bearer ») ET une clé applicative dans un
en-tête propre. Le seul chemin existant était la clé ``headers`` de la config
perso, à moitié câblée : lue par le transport, absente de l'interface, stockée
EN CLAIR et RENVOYÉE au navigateur à chaque GET.

Symétriquement, un serveur ``stdio`` n'avait aucun moyen de recevoir ses
variables d'environnement — la façon dont se configure la majorité des serveurs
MCP npm/npx.

Ce qui est verrouillé ici :
  1. aucune valeur (en-tête ou variable) ne repart vers le navigateur ;
  2. elles sont chiffrées au repos, comme le secret principal ;
  3. « vide = inchangé » fonctionne PAR NOM, donc ``saveSettings`` — qui re-PUT
     le blob entier à chaque préférence — n'efface rien ;
  4. les noms réservés au transport (``Host``, ``PYTHONPATH``…) sont refusés ;
  5. un créneau n'existe que sur son transport (en-têtes en HTTP/SSE,
     variables en stdio) ;
  6. deux connecteurs qui ne diffèrent QUE par ces valeurs n'ont pas la même
     clé de pool — sans quoi le second réutiliserait la session du premier.
"""
from __future__ import annotations

import importlib
import json

import pytest


@pytest.fixture()
def ms(tmp_path, monkeypatch):
    """DB temporaire + migrations de la table partagée ; module CRUD."""
    monkeypatch.setenv("APP_ENCRYPTION_KEY", "cle-de-test-creneaux-mcp")
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        for mod in ("0010_mcp_shared_servers", "0015_mcp_headers_env"):
            importlib.import_module(
                f"shared_infra.db._migrations.{mod}").migrate(conn)
        conn.commit()
    return importlib.import_module("shared_infra.mcp.servers")


def _wiki(ms, **over):
    """Le cas qui a motivé la fonctionnalité : Bearer pour le serveur MCP,
    clé d'API pour le wiki derrière."""
    srv = dict(id="server_1", name="Wiki", type="http",
               url="http://wiki.local:4445/mcp",
               auth_mode="bearer", auth_secret="MCP-BEARER",
               headers=[{"name": "X-API-Key", "value": "WIKI-KEY"}])
    srv.update(over)
    return ms.merge_personal_mcp([], [srv])


# ── 1. Le navigateur ne relit aucune valeur ──────────────────────────────────

def test_la_vue_publique_ne_porte_aucune_valeur(ms):
    stored = _wiki(ms)[0]
    pub = ms.personal_public(stored)
    assert pub["headers"] == [{"name": "X-API-Key", "value": "",
                               "has_value": True}]
    blob = json.dumps(pub)
    assert "WIKI-KEY" not in blob and "MCP-BEARER" not in blob


def test_la_cle_headers_en_clair_ne_repart_plus(ms):
    """RÉGRESSION — ``headers`` était recopiée telle quelle par la liste
    blanche du client, donc stockée en clair ET renvoyée au navigateur."""
    legacy = {"id": "server_legacy", "name": "W", "type": "http", "url": "u",
              "headers": {"X-Api-Token": "EN-CLAIR"}}
    pub = ms.personal_public(legacy)
    assert pub["headers"] == [{"name": "X-Api-Token", "value": "",
                               "has_value": True}]
    assert "EN-CLAIR" not in json.dumps(pub)


def test_les_valeurs_sont_chiffrees_au_repos(ms):
    stored = _wiki(ms)[0]
    assert "WIKI-KEY" not in json.dumps(stored)
    assert stored["extra_scheme"] == "fernet"
    assert stored["headers_enc"]


# ── 2. La connexion reçoit bien les deux identifiants ────────────────────────

def test_bearer_et_cle_dapi_coexistent(ms):
    cfg = ms.personal_to_config(_wiki(ms)[0])
    assert cfg["authorization"] == "Bearer MCP-BEARER"
    assert cfg["headers"] == {"X-API-Key": "WIKI-KEY"}


def test_une_entree_legacy_en_clair_reste_fonctionnelle(ms):
    """Tant qu'une sauvegarde ne l'a pas migrée, l'ancienne forme doit
    continuer d'ouvrir la connexion — sinon la mise à jour coupe l'accès."""
    legacy = {"id": "s", "name": "W", "type": "http", "url": "u",
              "headers": {"X-Api-Token": "EN-CLAIR"}}
    assert ms.personal_to_config(legacy)["headers"] == {"X-Api-Token": "EN-CLAIR"}


def test_une_sauvegarde_migre_le_legacy_vers_le_creneau_chiffre(ms):
    legacy = {"id": "s", "name": "W", "type": "http", "url": "u",
              "headers": {"X-Api-Token": "EN-CLAIR"}}
    # Le client renvoie la vue publique : nom seul, valeur vide.
    after = ms.merge_personal_mcp(
        [legacy],
        [{"id": "s", "name": "W", "type": "http", "url": "u",
          "headers": [{"name": "X-Api-Token", "value": ""}]}])[0]
    assert "headers" not in after
    assert "EN-CLAIR" not in json.dumps(after)
    assert ms.personal_to_config(after)["headers"] == {"X-Api-Token": "EN-CLAIR"}


# ── 3. « Vide = inchangé », par nom ──────────────────────────────────────────

def test_le_reenregistrement_ne_perd_pas_les_valeurs(ms):
    """``saveSettings`` re-PUT le blob ENTIER à chaque changement de
    préférence : un aller-retour ne doit rien effacer."""
    stored = _wiki(ms)
    pub = ms.personal_public(stored[0])
    echo = {k: pub[k] for k in ("id", "name", "type", "url", "auth_mode")}
    echo["headers"] = pub["headers"]
    again = ms.merge_personal_mcp(stored, [echo])
    cfg = ms.personal_to_config(again[0])
    assert cfg["headers"] == {"X-API-Key": "WIKI-KEY"}
    assert cfg["authorization"] == "Bearer MCP-BEARER"


def test_une_valeur_saisie_remplace_la_stockee(ms):
    stored = _wiki(ms)
    again = ms.merge_personal_mcp(stored, [{
        "id": "server_1", "name": "Wiki", "type": "http", "url": "u",
        "headers": [{"name": "X-API-Key", "value": "NOUVELLE"}]}])
    assert ms.personal_to_config(again[0])["headers"] == {"X-API-Key": "NOUVELLE"}


def test_renommer_un_entete_ne_transporte_pas_lancien_secret(ms):
    stored = _wiki(ms)
    again = ms.merge_personal_mcp(stored, [{
        "id": "server_1", "name": "Wiki", "type": "http", "url": "u",
        "headers": [{"name": "X-Autre", "value": ""}]}])
    # Le créneau existe (la ligne reste affichée) mais reste VIDE, donc n'est
    # pas expédié : un nom différent est un autre créneau.
    assert "headers" not in ms.personal_to_config(again[0])


def test_une_liste_vide_retire_tout(ms):
    stored = _wiki(ms)
    again = ms.merge_personal_mcp(stored, [{
        "id": "server_1", "name": "Wiki", "type": "http", "url": "u",
        "headers": []}])
    assert "headers" not in ms.personal_to_config(again[0])


def test_la_cle_absente_laisse_en_place(ms):
    """Un client d'une version antérieure n'envoie pas ``headers`` : il ne
    doit pas effacer ce qu'il ne sait pas afficher."""
    stored = _wiki(ms)
    again = ms.merge_personal_mcp(stored, [{
        "id": "server_1", "name": "Wiki", "type": "http", "url": "u"}])
    assert ms.personal_to_config(again[0])["headers"] == {"X-API-Key": "WIKI-KEY"}


# ── 4. Noms refusés ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("name", ["Host", "content-length", "Transfer-Encoding",
                                  "mauvais nom", "avec:deuxpoints", ""])
def test_les_entetes_reserves_ou_malformes_sont_jetes(ms, name):
    out = ms.merge_personal_mcp([], [{
        "id": "s", "name": "W", "type": "http", "url": "u",
        "headers": [{"name": name, "value": "x"}]}])
    assert "headers" not in ms.personal_to_config(out[0])


@pytest.mark.parametrize("name", ["PYTHONPATH", "NODE_PATH", "APP_SANDBOX_DIR",
                                  "2START", "avec-tiret"])
def test_les_variables_reservees_ou_malformees_sont_jetees(ms, name):
    out = ms.merge_personal_mcp([], [{
        "id": "s", "name": "W", "type": "stdio", "command": "npx x",
        "env": [{"name": name, "value": "x"}]}], allow_stdio=True)
    assert "env" not in ms.personal_to_config(out[0], allow_stdio=True)


def test_le_nombre_de_paires_est_borne(ms):
    out = ms.merge_personal_mcp([], [{
        "id": "s", "name": "W", "type": "http", "url": "u",
        "headers": [{"name": f"X-H{i}", "value": "v"} for i in range(60)]}])
    assert len(ms.personal_to_config(out[0])["headers"]) == ms.MAX_PAIRS


# ── 5. Un créneau n'existe que sur son transport ─────────────────────────────

def test_les_entetes_ne_survivent_pas_a_un_passage_en_stdio(ms):
    stored = _wiki(ms)
    again = ms.merge_personal_mcp(stored, [{
        "id": "server_1", "name": "Wiki", "type": "stdio",
        "command": "npx -y wikijs-mcp"}], allow_stdio=True)
    cfg = ms.personal_to_config(again[0], allow_stdio=True)
    assert "headers" not in cfg and "env" not in cfg
    assert again[0]["headers_enc"] == ""


def test_les_variables_ne_survivent_pas_a_un_passage_en_http(ms):
    stored = ms.merge_personal_mcp([], [{
        "id": "s", "name": "W", "type": "stdio", "command": "npx x",
        "env": [{"name": "WIKIJS_TOKEN", "value": "T"}]}], allow_stdio=True)
    assert ms.personal_to_config(stored[0], allow_stdio=True)["env"] == {"WIKIJS_TOKEN": "T"}
    again = ms.merge_personal_mcp(stored, [{
        "id": "s", "name": "W", "type": "http", "url": "u"}])
    assert "env" not in ms.personal_to_config(again[0])


# ── 6. Mode « clé d'API » ────────────────────────────────────────────────────

def test_mode_header_pose_len_tete_nomme(ms):
    out = ms.merge_personal_mcp([], [{
        "id": "s", "name": "W", "type": "sse", "url": "u",
        "auth_mode": "header", "auth_user": "X-Api-Token",
        "auth_secret": "K"}])
    cfg = ms.personal_to_config(out[0])
    assert cfg["headers"] == {"X-Api-Token": "K"}
    assert "authorization" not in cfg


def test_mode_header_sans_nom_prend_le_defaut(ms):
    out = ms.merge_personal_mcp([], [{
        "id": "s", "name": "W", "type": "sse", "url": "u",
        "auth_mode": "header", "auth_user": "", "auth_secret": "K"}])
    assert ms.personal_to_config(out[0])["headers"] == {ms.DEFAULT_HEADER_NAME: "K"}


def test_mode_header_avec_nom_invalide_retire_lauth(ms):
    """Plutôt qu'expédier le jeton sous un nom que l'utilisateur n'a pas
    demandé : le badge « auth » disparaît, la faute est visible."""
    out = ms.merge_personal_mcp([], [{
        "id": "s", "name": "W", "type": "sse", "url": "u",
        "auth_mode": "header", "auth_user": "Ho st", "auth_secret": "K"}])
    assert out[0]["auth_mode"] == ""
    assert out[0]["auth_enc"] == ""
    assert "headers" not in ms.personal_to_config(out[0])


def test_le_mode_dauth_prime_sur_la_liste(ms):
    """Un seul en-tête gagne, et c'est celui dont la valeur est masquée par
    ``has_auth`` — une seule règle à retenir dans les deux sens."""
    out = ms.merge_personal_mcp([], [{
        "id": "s", "name": "W", "type": "sse", "url": "u",
        "auth_mode": "header", "auth_user": "X-API-Key", "auth_secret": "DUMODE",
        "headers": [{"name": "X-API-Key", "value": "DELALISTE"}]}])
    assert ms.personal_to_config(out[0])["headers"] == {"X-API-Key": "DUMODE"}


# ── 7. Bibliothèque partagée ─────────────────────────────────────────────────

def test_partage_publie_et_resout_les_deux_identifiants(ms):
    rid = ms.create_shared(name="Wiki", type="http", url="http://w/mcp",
                           auth_mode="bearer", auth_secret="B",
                           headers=[{"name": "X-API-Key", "value": "K"}])
    cfg = ms.resolve_config(rid)
    assert cfg["authorization"] == "Bearer B"
    assert cfg["headers"] == {"X-API-Key": "K"}


def test_partage_vue_admin_sans_valeur(ms):
    rid = ms.create_shared(name="Wiki", type="http", url="http://w/mcp",
                           headers=[{"name": "X-API-Key", "value": "SECRET-KEY"}])
    admin = ms.get_shared(rid, admin=True)
    assert admin["headers"] == [{"name": "X-API-Key", "value": "",
                                 "has_value": True}]
    assert "SECRET-KEY" not in json.dumps(admin)
    # Vue d'usage (compte ordinaire) : rien de tout cela.
    assert "headers" not in ms.get_shared(rid)


def test_partage_update_reporte_la_valeur_stockee(ms):
    rid = ms.create_shared(name="Wiki", type="http", url="http://w/mcp",
                           headers=[{"name": "X-API-Key", "value": "K"}])
    ms.update_shared(rid, name="Wiki 2",
                     headers=[{"name": "X-API-Key", "value": ""}])
    assert ms.resolve_config(rid)["headers"] == {"X-API-Key": "K"}


def test_partage_update_retire_un_entete(ms):
    rid = ms.create_shared(name="Wiki", type="http", url="http://w/mcp",
                           headers=[{"name": "X-API-Key", "value": "K"}])
    ms.update_shared(rid, headers=[])
    assert "headers" not in ms.resolve_config(rid)


def test_partage_variables_sur_stdio(ms):
    rid = ms.create_shared(name="W", type="stdio", command="npx -y wikijs-mcp",
                           env=[{"name": "WIKIJS_TOKEN", "value": "T"}])
    assert ms.resolve_config(rid)["env"] == {"WIKIJS_TOKEN": "T"}


def test_le_bouton_tester_partage_reporte_les_valeurs_stockees(ms):
    """Chemin distinct : ``/api/mcp/test`` fusionne la ligne BRUTE de la table
    avec le formulaire via ``merge_personal_mcp``. Les deux magasins portent
    les mêmes noms de champs — c'est ce qui rend la réutilisation correcte."""
    from shared_infra.mcp.panel import _shared_payload
    rid = ms.create_shared(name="Wiki", type="http", url="http://w/mcp",
                           auth_mode="bearer", auth_secret="BEAR",
                           headers=[{"name": "X-API-Key", "value": "KEY"}])
    p = _shared_payload({"name": "Wiki", "type": "http", "url": "http://w/mcp",
                         "auth_mode": "bearer", "auth_secret": "",
                         "headers": [{"name": "X-API-Key", "value": ""}]})
    stored = ms.raw_shared(rid)
    merged = ms.merge_personal_mcp([{**stored, "id": "t"}], [{**p, "id": "t"}])
    cfg = ms.personal_to_config(merged[0])
    assert cfg["authorization"] == "Bearer BEAR"
    assert cfg["headers"] == {"X-API-Key": "KEY"}


def test_payload_partage_refuse_un_nom_reserve():
    from fastapi import HTTPException
    from shared_infra.mcp.panel import _shared_payload
    with pytest.raises(HTTPException) as e:
        _shared_payload({"name": "X", "type": "http", "url": "http://x/mcp",
                         "headers": [{"name": "Host", "value": "evil"}]})
    assert e.value.status_code == 400


def test_payload_partage_refuse_un_nom_dentete_dauth_invalide():
    from fastapi import HTTPException
    from shared_infra.mcp.panel import _shared_payload
    with pytest.raises(HTTPException) as e:
        _shared_payload({"name": "X", "type": "http", "url": "http://x/mcp",
                         "auth_mode": "header", "auth_user": "Ho st",
                         "auth_secret": "K"})
    assert e.value.status_code == 400


def test_payload_partage_accepte_le_mode_header():
    from shared_infra.mcp.panel import _shared_payload
    p = _shared_payload({"name": "X", "type": "http", "url": "http://x/mcp",
                         "auth_mode": "header", "auth_secret": "K"})
    assert p["auth_mode"] == "header" and p["auth_user"] == "X-API-Key"


# ── 8. Transport ─────────────────────────────────────────────────────────────

def test_une_valeur_vide_nest_pas_expediee():
    """Un créneau ouvert mais jamais rempli est en attente de saisie, pas un
    en-tête à envoyer vide (httpx refuse, et beaucoup de serveurs rejettent)."""
    from llm_core._mcp_wrappers import _build_auth_headers
    assert _build_auth_headers({"headers": {"X-A": "", "X-B": "v"}}) == {"X-B": "v"}


def test_la_forme_au_repos_est_acceptee_par_le_transport():
    """Un instantané de routine conserve la forme ``[{name, value}]``."""
    from llm_core._mcp_wrappers import _build_auth_headers
    assert _build_auth_headers(
        {"headers": [{"name": "X-A", "value": "v"}]}) == {"X-A": "v"}


def test_le_wrapper_stdio_pose_les_variables(tmp_path):
    from llm_core._mcp_wrappers import MCPStdioWrapper
    w = MCPStdioWrapper("python3", [], cwd=str(tmp_path),
                        extra_env={"WIKIJS_TOKEN": "T", "PYTHONPATH": "/evil"})
    assert w.params.env["WIKIJS_TOKEN"] == "T"
    # Seconde barrière : PYTHONPATH est calculé par le wrapper.
    assert "/evil" not in w.params.env["PYTHONPATH"]


def test_deux_env_distincts_ne_partagent_pas_le_pool():
    """Sans ``env`` dans l'empreinte, deux connecteurs de même commande mais
    de comptes différents auraient partagé UN sous-processus — donc les
    identifiants du premier arrivé."""
    from llm_core._mcp_pool import MCPConnectionPool as P
    base = {"type": "stdio", "command": "npx -y wikijs-mcp", "name": "W"}
    k1 = P._make_key({**base, "env": {"WIKIJS_TOKEN": "A"}})
    k2 = P._make_key({**base, "env": {"WIKIJS_TOKEN": "B"}})
    assert k1 != k2


def test_deux_entetes_distincts_ne_partagent_pas_le_pool():
    from llm_core._mcp_pool import MCPConnectionPool as P
    base = {"type": "http", "url": "http://w/mcp"}
    assert (P._make_key({**base, "headers": {"X-API-Key": "A"}})
            != P._make_key({**base, "headers": {"X-API-Key": "B"}}))


# ── 9. Instantané de routine ─────────────────────────────────────────────────

def test_le_snapshot_de_routine_ne_fige_aucune_valeur(ms):
    """Le snapshot doit rester une RÉFÉRENCE : figer un chiffré gèlerait la
    rotation, figer un clair le diffuserait."""
    from shared_infra.scheduling.routines_store import _MCP_SECRET_KEYS
    stored = ms.merge_personal_mcp([], [{
        "id": "s", "name": "W", "type": "stdio", "command": "npx x",
        "env": [{"name": "WIKIJS_TOKEN", "value": "T"}]}], allow_stdio=True)[0]
    clean = {k: v for k, v in stored.items() if k not in _MCP_SECRET_KEYS}
    assert "T" not in json.dumps(clean)
    for k in ("headers_enc", "env_enc", "extra_scheme", "env", "headers"):
        assert k not in clean


@pytest.fixture(autouse=True)
def _sans_garde_ssrf(monkeypatch):
    """Hôtes factices (``http://w``) : la garde SSRF des MCP perso
    (audit 2026-09-22, H7) a ses propres tests."""
    import shared_infra.mcp.servers as _srv
    monkeypatch.setattr(_srv, "personal_url_block_reason", lambda url: None)
