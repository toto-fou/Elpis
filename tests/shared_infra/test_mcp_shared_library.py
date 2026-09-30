# SPDX-License-Identifier: MIT
"""Bibliothèque MCP PARTAGÉE : store, secret jamais sérialisé, résolution
côté serveur, et visibilité par compte.

Le problème d'origine : ``settings.mcp_servers`` est une liste PAR utilisateur.
Un admin qui enregistre « Jenkins » (SSE + Basic auth) le range dans SES
settings — les autres comptes ne le voient nulle part et doivent le re-saisir,
identifiants compris. Cette table publie une fois pour tous ; chacun coche
ensuite ce qu'il veut afficher (rien par défaut).

Ce qui est verrouillé ici :
  1. le secret d'auth n'apparaît JAMAIS dans une vue publique ;
  2. il est bien restitué à la résolution host-side (URL + en-tête) ;
  3. un id inconnu / dépublié / désactivé est jeté, pas deviné ;
  4. la route de chat n'accepte une entrée ``shared:`` que si CE compte l'a
     cochée — un client modifié ne peut ni forger une URL sous une identité
     partagée, ni emprunter un serveur qu'il n'affiche pas.
"""
from __future__ import annotations

import importlib

import pytest


@pytest.fixture()
def ms(tmp_path, monkeypatch):
    """DB temporaire + migrations de la table ; renvoie le module CRUD."""
    monkeypatch.setenv("APP_ENCRYPTION_KEY", "cle-de-test-bibliotheque-mcp")
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        for mod in ("0010_mcp_shared_servers", "0015_mcp_headers_env"):
            importlib.import_module(
                f"shared_infra.db._migrations.{mod}").migrate(conn)
        conn.commit()
    import shared_infra.security.encryption as enc
    enc._reset_key_cache() if hasattr(enc, "_reset_key_cache") else None
    return importlib.import_module("shared_infra.mcp.servers")


def _jenkins(ms, **over):
    kw = dict(name="Jenkins", type="sse", url="https://ci.local/mcp-server/sse",
              auth_mode="basic", auth_user="bot", auth_secret="s3cr3t")
    kw.update(over)
    return ms.create_shared(**kw)


# ── 1. Le secret ne sort jamais ───────────────────────────────────────────────

def test_vue_publique_sans_secret(ms):
    _jenkins(ms)
    rows = ms.list_shared()
    assert len(rows) == 1
    blob = repr(rows)
    assert "s3cr3t" not in blob, "le secret a fuité dans la vue publique"
    assert rows[0]["has_auth"] is True          # présence signalée, valeur non
    assert rows[0]["id"] == "shared:1"          # id public préfixé
    assert rows[0]["shared"] is True
    # get_shared suit la même règle.
    assert "s3cr3t" not in repr(ms.get_shared(1))


def test_vue_dusage_ne_porte_ni_compte_de_service_ni_url(ms):
    """La vue d'un compte ORDINAIRE se limite à ce qui sert à cocher l'œil.
    ``auth_user`` est la moitié d'un couple Basic et ``url`` le point d'entrée
    interne : ni l'un ni l'autre n'a de raison de circuler."""
    _jenkins(ms)
    row = ms.list_shared()[0]
    assert set(row) == {"id", "name", "type", "enabled", "has_auth", "shared"}
    admin_row = ms.list_shared(admin=True)[0]
    assert admin_row["auth_user"] == "bot"
    assert admin_row["url"] == "https://ci.local/mcp-server/sse"
    assert "s3cr3t" not in repr(admin_row)      # le secret, lui, ne sort jamais


def test_vue_dusage_masque_les_entrees_desactivees(ms):
    """Une entrée dépubliée n'est pas cochable : la montrer n'exposerait qu'un
    service de plus. L'admin, qui la réactive, continue de la voir."""
    sid = _jenkins(ms)
    ms.update_shared(sid, enabled=False)
    assert ms.list_shared() == []
    assert len(ms.list_shared(admin=True)) == 1


def test_secret_chiffre_au_repos(ms, tmp_path):
    _jenkins(ms)
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        row = conn.execute(
            "SELECT auth_enc, key_scheme FROM mcp_shared_servers").fetchone()
    assert row["key_scheme"] == "fernet"
    assert "s3cr3t" not in row["auth_enc"]


# ── 2. Résolution host-side ───────────────────────────────────────────────────

def test_resolve_config_rend_len_tete_dauth(ms):
    sid = _jenkins(ms)
    cfg = ms.resolve_config(sid)
    assert cfg["url"] == "https://ci.local/mcp-server/sse"
    assert cfg["basic_auth"] == {"username": "bot", "token": "s3cr3t"}
    assert cfg["id"] == "shared:1"


def test_resolve_config_mode_raw(ms):
    sid = _jenkins(ms, auth_mode="raw", auth_user="", auth_secret="Bearer xyz")
    assert ms.resolve_config(sid)["authorization"] == "Bearer xyz"


def test_resolve_jette_inconnu_et_desactive(ms):
    sid = _jenkins(ms)
    assert ms.resolve_config(9999) is None
    ms.update_shared(sid, enabled=False)
    assert ms.resolve_config(sid) is None, "un serveur dépublié reste résolvable"


def test_resolve_many_preserve_lordre_et_ignore_le_bruit(ms):
    a = _jenkins(ms, name="A")
    b = _jenkins(ms, name="B")
    out = ms.resolve_many([ms.public_id(b), "server_1754", "shared:999",
                           ms.public_id(a), None])
    assert [c["name"] for c in out] == ["B", "A"]


def test_shared_id_ne_reconnait_que_le_prefixe(ms):
    assert ms.shared_id("shared:12") == 12
    assert ms.shared_id("server_1754") is None
    assert ms.shared_id("shared:abc") is None
    assert ms.shared_id(None) is None


# ── 3. Update partiel : le secret survit à un renommage ───────────────────────

def test_update_conserve_le_secret_quand_le_champ_est_vide(ms):
    sid = _jenkins(ms)
    ms.update_shared(sid, name="Jenkins CI", auth_secret="")
    cfg = ms.resolve_config(sid)
    assert ms.get_shared(sid)["name"] == "Jenkins CI"
    assert cfg["basic_auth"]["token"] == "s3cr3t", "renommer a effacé le token"


def test_retirer_lauth_efface_le_secret(ms):
    sid = _jenkins(ms)
    ms.update_shared(sid, auth_mode="")
    cfg = ms.resolve_config(sid)
    assert "basic_auth" not in cfg and "authorization" not in cfg
    assert ms.get_shared(sid)["has_auth"] is False


# ── 4. La route de chat : visibilité par compte, pas de forge d'URL ───────────

def _resolve_like_route(active, user_settings, ms, allow_stdio=True):
    """Réplique EXACTE de la cascade de routes/chats.py (bibliothèque MCP)."""
    visible = {str(v) for v in (user_settings.get("shared_mcp_visible") or [])}
    out = []
    for srv in active:
        cats = srv.get("filter_categories")
        if not srv.get("id"):
            if srv.get("command") == "DEFAULT_LOCAL_PYTHON":
                out.append(srv)
            continue
        rid = ms.shared_id(srv.get("id"))
        if rid is not None:
            if str(srv.get("id")) not in visible:
                continue
            cfg = ms.resolve_config(rid)
        else:
            cfg = ms.resolve_personal(user_settings, srv.get("id"), allow_stdio=allow_stdio)
        if not cfg:
            continue
        if cats is not None:
            cfg["filter_categories"] = cats
        out.append(cfg)
    return out


def test_route_resout_une_reference_partagee(ms):
    sid = _jenkins(ms)
    pid = ms.public_id(sid)
    out = _resolve_like_route(
        [{"id": pid, "name": "Jenkins", "type": "sse", "shared": True}],
        {"shared_mcp_visible": [pid]}, ms)
    assert out[0]["basic_auth"]["token"] == "s3cr3t"


def test_route_refuse_un_serveur_non_affiche_par_ce_compte(ms):
    sid = _jenkins(ms)
    out = _resolve_like_route(
        [{"id": ms.public_id(sid), "shared": True}],
        {"shared_mcp_visible": []}, ms)
    assert out == [], "un serveur non coché ne doit pas partir au modèle"


def test_route_ignore_lurl_envoyee_par_le_client(ms):
    """Le client ne fait que RÉFÉRENCER : l'URL et l'auth viennent de la base.
    Sans ça, un client modifié se fabriquerait un serveur arbitraire sous une
    identité partagée (et récupérerait le token au passage)."""
    sid = _jenkins(ms)
    pid = ms.public_id(sid)
    out = _resolve_like_route(
        [{"id": pid, "shared": True, "url": "https://attaquant.example/sse",
          "basic_auth": {"username": "x", "token": "y"}}],
        {"shared_mcp_visible": [pid]}, ms)
    assert out[0]["url"] == "https://ci.local/mcp-server/sse"
    assert out[0]["basic_auth"]["username"] == "bot"


def test_type_http_porte_lauth(ms):
    """L'en-tête a un sens sur HTTP streamable comme sur SSE — le filtre
    historique ``type != 'sse'`` l'aurait avalé."""
    sid = ms.create_shared(name="Wiki", type="http", url="http://w:4445/mcp",
                           auth_mode="bearer", auth_secret="jeton")
    cfg = ms.resolve_config(sid)
    assert cfg["type"] == "http"
    assert cfg["authorization"] == "Bearer jeton"


def test_mode_bearer_prefixe_une_seule_fois(ms):
    """Le jeton est stocké NU : coller l'en-tête entier depuis une doc ne doit
    pas produire « Bearer Bearer … »."""
    sid = ms.create_shared(name="W", type="http", url="http://w/mcp",
                           auth_mode="bearer", auth_secret="  Bearer  jeton ")
    assert ms.resolve_config(sid)["authorization"] == "Bearer jeton"


def test_bearer_sur_stdio_reste_inerte(ms):
    sid = ms.create_shared(name="L", type="stdio", command="x",
                           auth_mode="bearer", auth_secret="jeton")
    assert "authorization" not in ms.resolve_config(sid)


def test_route_resout_un_serveur_perso_depuis_les_settings(ms):
    """Un perso n'est plus recopié verbatim : sa config vient du magasin."""
    perso = {"id": "server_1754", "name": "Perso", "type": "sse", "url": "http://p"}
    out = _resolve_like_route([{"id": "server_1754"}],
                              {"mcp_servers": [perso]}, ms)
    assert out[0]["url"] == "http://p"


def test_route_ignore_une_config_perso_forgee_par_le_client(ms):
    """Cœur du correctif SSRF : l'URL et les en-têtes envoyés par le client sont
    remplacés par ceux du magasin, jamais utilisés tels quels."""
    perso = {"id": "server_1754", "name": "Perso", "type": "sse", "url": "http://p"}
    out = _resolve_like_route(
        [{"id": "server_1754", "url": "http://interne.local/admin",
          "headers": {"X-Vol": "1"}}],
        {"mcp_servers": [perso]}, ms)
    assert out[0]["url"] == "http://p"
    assert "headers" not in out[0]


def test_route_jette_un_id_perso_inconnu(ms):
    out = _resolve_like_route([{"id": "server_inexistant", "url": "http://x"}],
                              {"mcp_servers": []}, ms)
    assert out == []


def test_route_laisse_passer_les_outils_locaux(ms):
    local = {"type": "stdio", "name": "Outils Locaux",
             "command": "DEFAULT_LOCAL_PYTHON", "filter_categories": ["fs"]}
    assert _resolve_like_route([local], {}, ms) == [local]


# ── 5. Routines : la référence partagée est résolue PAR ID, pas appariée ─────

def test_routine_resout_un_serveur_partage_par_id(ms):
    """Le snapshot d'une routine ne porte qu'une RÉFÉRENCE (le navigateur n'a ni
    l'URL faisant autorité ni le secret). L'appariement historique par url/name
    ne pouvait donc rien en tirer : la config partait sans URL, donc
    injoignable. Elle est reconstruite depuis la base."""
    from shared_infra.scheduling.routines_scheduler import _rehydrate_mcp_secrets
    sid = _jenkins(ms)
    pid = ms.public_id(sid)
    snap = [{"type": "stdio", "name": "Outils Locaux",
             "command": "DEFAULT_LOCAL_PYTHON", "filter_categories": ["fs"]},
            {"id": pid, "name": "Jenkins", "type": "sse", "shared": True}]
    out = _rehydrate_mcp_secrets(snap, {"shared_mcp_visible": [pid]})
    assert out[0]["command"] == "DEFAULT_LOCAL_PYTHON"      # local intact
    assert out[1]["url"] == "https://ci.local/mcp-server/sse"
    assert out[1]["basic_auth"]["token"] == "s3cr3t"


def test_routine_jette_un_partage_depublie_ou_masque(ms):
    from shared_infra.scheduling.routines_scheduler import _rehydrate_mcp_secrets
    sid = _jenkins(ms)
    pid = ms.public_id(sid)
    snap = [{"id": pid, "name": "Jenkins", "type": "sse", "shared": True}]
    # masqué par ce compte
    assert _rehydrate_mcp_secrets(snap, {"shared_mcp_visible": []}) == []
    # dépublié côté admin
    ms.update_shared(sid, enabled=False)
    assert _rehydrate_mcp_secrets(snap, {"shared_mcp_visible": [pid]}) == []


def test_routine_conserve_lappariement_des_serveurs_perso(ms):
    """La voie historique (secret ré-injecté par url/name depuis les serveurs
    perso) n'est pas touchée par la résolution partagée."""
    from shared_infra.scheduling.routines_scheduler import _rehydrate_mcp_secrets
    snap = [{"id": "server_1754", "name": "Perso", "type": "sse", "url": "http://p"}]
    settings = {"mcp_servers": [{"id": "server_1754", "name": "Perso",
                                 "url": "http://p",
                                 "basic_auth": {"username": "u", "token": "t"}}]}
    out = _rehydrate_mcp_secrets(snap, settings)
    assert out[0]["basic_auth"]["token"] == "t"


# ── 6. Le réglage de visibilité n'accepte que des ids bien formés ─────────────

def test_la_cascade_simulee_est_bien_celle_de_la_route():
    """``_resolve_like_route`` rejoue la route ; ce pin empêche la copie de
    diverger en silence (même convention que test_enable_mcp_gate.py)."""
    from pathlib import Path
    src = (Path(__file__).resolve().parents[2] / "chatbot_app" / "routes"
           / "chats.py").read_text(encoding="utf-8")
    assert "resolve_config as _resolve_shared" in src
    assert "shared_id as _shared_id" in src
    assert "resolve_personal as _resolve_perso" in src
    assert 'if str(_srv.get("id")) not in _visible:' in src
    assert "_cfg = _resolve_shared(_rid)" in src
    # Perso résolu côté serveur, et non plus recopié depuis le payload.
    # (2026-09-20) ``allow_stdio`` : un ``stdio`` perso n'est spawné que
    # pour un administrateur plein.
    assert '_cfg = _resolve_perso(user_settings, _srv.get("id"), allow_stdio=_stdio_ok)' in src
    assert "_stdio_ok = _stdio_allowed_for(user_id)" in src
    assert "active_mcp_servers = _resolved" in src
    # Le réglage de visibilité est bien lu depuis les settings du COMPTE.
    assert '.get("shared_mcp_visible")' in src


# ── 6. Contrat HTTP : lecture pour tous, écriture admin, secret jamais rendu ──

@pytest.fixture()
def client(ms, monkeypatch):
    from fastapi import FastAPI, HTTPException
    from fastapi.testclient import TestClient

    import shared_infra.mcp.panel as routes

    who = {"admin": True}

    def _fake_require_admin(request):
        if not who["admin"]:
            raise HTTPException(403, "admin requis")
        return 1

    monkeypatch.setattr(routes, "require_user_id", lambda request: 1)
    monkeypatch.setattr(routes, "_require_admin", _fake_require_admin)
    # La route de lecture distingue la vue admin de la vue d'usage.
    monkeypatch.setattr(routes, "get_user_by_id",
                        lambda uid: {"is_admin": 1 if who["admin"] else 0})
    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app), who


def test_http_publication_puis_lecture_par_tous(client, ms):
    c, who = client
    r = c.post("/api/mcp/shared-servers", json={
        "name": "Jenkins", "type": "sse", "url": "https://ci.local/mcp-server/sse",
        "auth_mode": "basic", "auth_user": "bot", "auth_secret": "s3cr3t"})
    assert r.status_code == 200, r.text
    sid = r.json()["server"]["id"]
    assert "s3cr3t" not in r.text

    # Un compte NON admin lit la bibliothèque — c'est tout l'objet de la feature.
    who["admin"] = False
    listed = c.get("/api/mcp/shared-servers")
    assert listed.status_code == 200
    row = listed.json()["servers"][0]
    assert [s["id"] for s in listed.json()["servers"]] == [sid]
    assert "s3cr3t" not in listed.text
    assert row["has_auth"] is True
    # …mais il ne reçoit NI le compte de service NI l'URL interne : la moitié
    # d'un couple Basic et le point d'entrée exact du service n'ont rien à faire
    # chez un compte dont le seul geste est de cocher un œil.
    assert "auth_user" not in row and "url" not in row and "command" not in row
    assert "ci.local" not in listed.text
    assert listed.json()["can_publish"] is False
    # L'admin, lui, a les champs de son formulaire d'édition.
    who["admin"] = True
    arow = c.get("/api/mcp/shared-servers").json()["servers"][0]
    assert arow["auth_user"] == "bot" and arow["url"].startswith("https://ci.local")


def test_http_ecriture_reservee_a_ladmin(client):
    c, who = client
    who["admin"] = False
    body = {"name": "X", "type": "sse", "url": "http://x"}
    assert c.post("/api/mcp/shared-servers", json=body).status_code == 403
    assert c.put("/api/mcp/shared-servers/shared:1", json=body).status_code == 403
    assert c.delete("/api/mcp/shared-servers/shared:1").status_code == 403


def test_http_validation_et_404(client):
    c, _ = client
    assert c.post("/api/mcp/shared-servers",
                  json={"name": "X", "type": "sse"}).status_code == 400   # URL absente
    assert c.post("/api/mcp/shared-servers",
                  json={"name": "", "type": "sse", "url": "http://x"}).status_code == 400
    assert c.post("/api/mcp/shared-servers",
                  json={"name": "X", "type": "ftp", "url": "http://x"}).status_code == 400
    assert c.delete("/api/mcp/shared-servers/shared:999").status_code == 404


def test_les_deux_espaces_dids_ne_se_recouvrent_pas():
    """Un serveur PERSO ne peut pas squatter ``shared:<n>`` : la route de chat
    résout toujours cette forme en base, donc l'entrée perso serait remplacée
    par le serveur publié de même numéro (ou jetée). Le PUT la renomme — il ne
    rejette pas le blob entier, sinon plus aucun réglage n'est enregistrable."""
    from pathlib import Path
    src = (Path(__file__).resolve().parents[2] / "shared_infra" / "accounts"
           / "routes_settings.py").read_text(encoding="utf-8")
    assert "from shared_infra.mcp.servers import ID_PREFIX as _SHARED_PREFIX" in src
    assert '.startswith(_SHARED_PREFIX)' in src
    # Le renommage produit bien un id hors de l'espace partagé.
    from shared_infra.mcp.servers import shared_id
    assert shared_id("server_local_0_shared_1") is None


def test_settings_normalise_shared_mcp_visible():
    """PUT /api/settings : ``shared_mcp_visible`` est un choix d'AFFICHAGE —
    on n'y garde que des ids ``shared:<n>``, dédupliqués."""
    from shared_infra.mcp.servers import shared_id as _sid
    raw = ["shared:2", "shared:2", "server_1754", "", None, "shared:x", "shared:7"]
    seen = []
    for v in raw[:200]:
        s = str(v or "")
        if _sid(s) is not None and s not in seen:
            seen.append(s)
    assert seen == ["shared:2", "shared:7"]


# ── Retrait d'auth AVEC un secret encore dans le payload (audit 2026-08-08) ───
# Le champ de saisie du token est masqué par un ``v-if`` quand l'admin bascule
# sur « Aucune », mais démonter l'input ne vide PAS son modèle Vue : le
# navigateur ré-émet le token tapé juste avant, avec ``auth_mode=""``. Les deux
# branches d'``update_shared`` empilaient alors DEUX ``auth_enc=?`` dans le même
# UPDATE — SQLite tolère et garde le DERNIER, donc le token repartait chiffré en
# base sur une entrée « sans authentification », et ``has_auth`` restait vrai.

def test_retirer_lauth_efface_le_secret_meme_si_le_payload_en_porte_un(ms):
    sid = _jenkins(ms)
    # Exactement ce que poste saveSharedMcp() : auth_mode vidé, auth_secret gardé.
    ms.update_shared(sid, name="Jenkins", type="sse", url="https://j/mcp/sse",
                     command="", auth_user="bot", enabled=True,
                     auth_mode="", auth_secret="s3cr3t")

    cfg = ms.resolve_config(sid)
    assert "basic_auth" not in cfg and "authorization" not in cfg
    assert ms.get_shared(sid)["has_auth"] is False, \
        "le secret survit au retrait de l'authentification"


def test_le_secret_ne_reste_pas_dechiffrable_en_base_apres_retrait(ms):
    """Contrôle au niveau STOCKAGE : ce n'est pas seulement ``has_auth`` qui doit
    tomber — l'octet chiffré ne doit plus être en base du tout."""
    sid = _jenkins(ms)
    ms.update_shared(sid, auth_mode="", auth_secret="s3cr3t")
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        row = conn.execute("SELECT auth_mode, auth_enc, key_scheme "
                           "FROM mcp_shared_servers WHERE id=?", (sid,)).fetchone()
    assert row["auth_mode"] == ""
    assert row["auth_enc"] == "", "token toujours stocké après retrait de l'auth"
    assert ms._decode_secret(row["auth_enc"], row["key_scheme"]) == ""


@pytest.mark.sqlite_only   # set_trace_callback propre à sqlite3
def test_un_seul_auth_enc_dans_lupdate(ms, monkeypatch):
    """Cause racine : l'UPDATE ne doit jamais assigner deux fois la même colonne.
    SQLite l'accepte silencieusement (le dernier gagne) — c'est ce qui rendait le
    bug invisible autrement qu'en observant l'effet."""
    import contextlib

    from shared_infra.mcp import servers as m

    sid = _jenkins(ms)                      # créé AVANT l'instrumentation
    statements: list = []
    real_db_conn = m.db_conn

    @contextlib.contextmanager
    def _tracing():
        with real_db_conn() as conn:
            conn.set_trace_callback(statements.append)
            try:
                yield conn
            finally:
                conn.set_trace_callback(None)

    monkeypatch.setattr(m, "db_conn", _tracing)
    m.update_shared(sid, auth_mode="", auth_secret="s3cr3t")

    updates = [q for q in statements if q.strip().upper().startswith("UPDATE")]
    assert updates, "aucun UPDATE capturé"
    # ⚠ ``set_trace_callback`` restitue le SQL avec les paramètres DÉJÀ
    # substitués (``auth_enc=''``, pas ``auth_enc=?``) — compter sur le nom de
    # colonne, jamais sur le placeholder.
    assert updates[0].count("auth_enc=") == 1, \
        f"colonne auth_enc assignée plusieurs fois : {updates[0]}"
    assert updates[0].count("key_scheme=") == 1, \
        f"colonne key_scheme assignée plusieurs fois : {updates[0]}"


# ── 8. Bouton « Tester » : POST /api/mcp/test ────────────────────────────────

def test_test_messages_derreur_sont_actionnables():
    """Les transports MCP enfouissent la cause dans un ExceptionGroup ; le
    formulaire doit afficher « jeton refusé », pas une trace de task group."""
    from shared_infra.mcp.panel import _friendly_mcp_error

    class _Resp:
        def __init__(self, s): self.status_code = s

    class _HttpErr(Exception):
        def __init__(self, s): self.response = _Resp(s)

    assert "jeton" in _friendly_mcp_error(_HttpErr(401))
    assert "405" in _friendly_mcp_error(_HttpErr(405))
    # enfoui dans un groupe
    grp = BaseExceptionGroup("boom", [_HttpErr(401)])
    assert "jeton" in _friendly_mcp_error(grp)
    # préfixe du wrapper HTTP retiré (l'URL est déjà sous les yeux)
    assert _friendly_mcp_error(
        RuntimeError("MCP HTTP http://x/mcp — HTTP 404")) == "HTTP 404"
    assert "injoignable" in _friendly_mcp_error(
        RuntimeError("MCP HTTP http://x/mcp — ConnectError: nope"))


def test_test_refuse_une_config_vide(client):
    """URL manquante : 400 avec un message explicite, avant toute connexion —
    le formulaire affiche ``detail``."""
    c, _ = client
    r = c.post("/api/mcp/test", json={"shared": True, "type": "sse", "url": ""})
    assert r.status_code == 400
    assert "URL requise" in r.json()["detail"]


def test_test_dun_serveur_partage_reserve_a_ladmin(client):
    c, who = client
    who["admin"] = False
    r = c.post("/api/mcp/test", json={"shared": True, "type": "sse",
                                      "url": "http://x/sse"})
    assert r.status_code == 403, "éprouver une entrée partagée = droit d'admin"


def test_test_reporte_le_secret_stocke_quand_le_champ_est_vide(client, ms, monkeypatch):
    """Re-tester une entrée existante ne doit pas obliger à re-saisir le jeton."""
    import shared_infra.mcp.panel as routes
    sid = ms.create_shared(name="W", type="http", url="http://w/mcp",
                           auth_mode="bearer", auth_secret="jeton-stocke")
    vu = {}

    async def _fake_probe(cfg):
        vu.update(cfg)
        return {"ok": True, "tools": ["a"], "ms": 1}

    monkeypatch.setattr(routes, "_probe_mcp", _fake_probe)
    c, _ = client
    r = c.post("/api/mcp/test", json={"id": ms.public_id(sid), "shared": True,
                                      "type": "http", "url": "http://w/mcp",
                                      "auth_mode": "bearer", "auth_secret": ""})
    assert r.status_code == 200 and r.json()["ok"] is True
    assert vu["authorization"] == "Bearer jeton-stocke"


def test_test_un_nouveau_secret_saisi_prime(client, ms, monkeypatch):
    import shared_infra.mcp.panel as routes
    sid = ms.create_shared(name="W", type="http", url="http://w/mcp",
                           auth_mode="bearer", auth_secret="ancien")
    vu = {}

    async def _fake_probe(cfg):
        vu.update(cfg)
        return {"ok": True, "tools": [], "ms": 1}

    monkeypatch.setattr(routes, "_probe_mcp", _fake_probe)
    c, _ = client
    c.post("/api/mcp/test", json={"id": ms.public_id(sid), "shared": True,
                                  "type": "http", "url": "http://w/mcp",
                                  "auth_mode": "bearer", "auth_secret": "nouveau"})
    assert vu["authorization"] == "Bearer nouveau"


def test_test_dune_entree_desactivee_reste_possible(client, ms, monkeypatch):
    """``resolve_config`` ne rend que les entrées actives : le test doit passer
    par ``raw_shared``, sinon on ne peut pas diagnostiquer avant publication."""
    import shared_infra.mcp.panel as routes
    sid = ms.create_shared(name="W", type="http", url="http://w/mcp",
                           auth_mode="bearer", auth_secret="s", enabled=False)
    assert ms.resolve_config(sid) is None
    vu = {}

    async def _fake_probe(cfg):
        vu.update(cfg)
        return {"ok": True, "tools": [], "ms": 1}

    monkeypatch.setattr(routes, "_probe_mcp", _fake_probe)
    c, _ = client
    c.post("/api/mcp/test", json={"id": ms.public_id(sid), "shared": True,
                                  "type": "http", "url": "http://w/mcp",
                                  "auth_mode": "bearer"})
    assert vu["authorization"] == "Bearer s"
