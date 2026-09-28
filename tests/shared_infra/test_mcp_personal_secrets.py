# SPDX-License-Identifier: MIT
"""
Serveurs MCP PERSO : le secret est chiffré au repos et ne repart jamais au client.

Avant, ``settings.mcp_servers`` portait le jeton en CLAIR dans
``users.settings_json`` et le renvoyait à chaque ``GET /api/settings``. La
bibliothèque partagée chiffrait déjà le sien : ces tests figent l'alignement.

Le point dur : ``saveSettings`` re-PUT le blob ENTIER à chaque changement de
préférence. Sans fusion serveur, basculer le thème effacerait tous les jetons.
"""
import importlib
import json

import pytest


@pytest.fixture()
def ms(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_ENCRYPTION_KEY", "cle-de-test-mcp-perso")
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    return importlib.import_module("shared_infra.mcp.servers")


def _srv(**over):
    d = {"id": "server_1", "name": "Wiki", "type": "http",
         "url": "http://w/mcp", "visible": True, "auth_mode": "bearer",
         "auth_secret": "jeton-secret"}
    d.update(over)
    return d


# ── 1. Chiffrement au repos ──────────────────────────────────────────────────

def test_le_secret_est_chiffre_et_absent_en_clair(ms):
    out = ms.merge_personal_mcp([], [_srv()])
    assert out[0]["key_scheme"] == "fernet"
    assert "auth_secret" not in out[0]
    assert "jeton-secret" not in json.dumps(out)


def test_la_config_resolue_reconstruit_len_tete(ms):
    stored = ms.merge_personal_mcp([], [_srv()])
    cfg = ms.personal_to_config(stored[0])
    assert cfg["authorization"] == "Bearer jeton-secret"


def test_mode_bearer_retire_un_prefixe_deja_colle(ms):
    """Coller l'en-tête entier depuis une doc ne doit pas donner
    « Bearer Bearer … ». L'espace final non plus : httpx rejette l'en-tête
    (LocalProtocolError) AVANT tout envoi."""
    stored = ms.merge_personal_mcp([], [_srv(auth_secret="  Bearer  jeton-secret  ")])
    cfg = ms.personal_to_config(stored[0])
    assert cfg["authorization"] == "Bearer jeton-secret"


def test_mode_raw_ne_prefixe_pas(ms):
    stored = ms.merge_personal_mcp([], [_srv(auth_mode="raw", auth_secret="Basic abc")])
    assert ms.personal_to_config(stored[0])["authorization"] == "Basic abc"


def test_mode_basic_reconstruit_le_couple(ms):
    stored = ms.merge_personal_mcp(
        [], [_srv(auth_mode="basic", auth_user="bot", auth_secret="pw")])
    cfg = ms.personal_to_config(stored[0])
    assert cfg["basic_auth"] == {"username": "bot", "token": "pw"}


# ── 2. « Vide = inchangé » ───────────────────────────────────────────────────

def test_secret_conserve_sur_trois_re_put_du_blob_entier(ms):
    """Le scénario réel : l'utilisateur bascule le thème trois fois. Le client
    renvoie l'entrée SANS secret (il ne l'a jamais reçu)."""
    cur = ms.merge_personal_mcp([], [_srv()])
    enc0 = cur[0]["auth_enc"]
    for _ in range(3):
        echo = {k: v for k, v in cur[0].items()
                if k not in ("auth_enc", "key_scheme")}
        cur = ms.merge_personal_mcp(cur, [echo])
    assert cur[0]["auth_enc"] == enc0
    assert ms.personal_to_config(cur[0])["authorization"] == "Bearer jeton-secret"


def test_un_nouveau_secret_remplace_lancien(ms):
    cur = ms.merge_personal_mcp([], [_srv()])
    cur = ms.merge_personal_mcp(cur, [_srv(auth_secret="nouveau")])
    assert ms.personal_to_config(cur[0])["authorization"] == "Bearer nouveau"


def test_mode_aucune_efface_meme_avec_un_secret_joint(ms):
    """Le ``v-if`` de Vue démonte l'input sans vider son modèle : le navigateur
    ré-émet le jeton tapé juste avant, avec ``auth_mode=""``. Le retrait prime."""
    cur = ms.merge_personal_mcp([], [_srv()])
    cur = ms.merge_personal_mcp(cur, [_srv(auth_mode="", auth_secret="encore-la")])
    assert cur[0]["auth_enc"] == ""
    assert "authorization" not in ms.personal_to_config(cur[0])


# ── 3. Le client ne peut pas écrire le créneau secret ────────────────────────

def test_auth_enc_fourni_par_le_client_est_ignore(ms):
    """Liste BLANCHE : sinon un client poserait key_scheme='plain' avec un
    secret en clair (downgrade), ou rejouerait un chiffré volé."""
    out = ms.merge_personal_mcp(
        [], [_srv(auth_secret="", auth_enc="chiffre-vole", key_scheme="plain")])
    assert out[0]["auth_enc"] == ""
    assert out[0]["key_scheme"] == "plain"


def test_cles_inconnues_ecartees(ms):
    out = ms.merge_personal_mcp([], [_srv(shared=True, evil="x")])
    assert "shared" not in out[0] and "evil" not in out[0]


def test_type_inconnu_retombe_sur_sse(ms):
    assert ms.merge_personal_mcp([], [_srv(type="ftp")])[0]["type"] == "sse"


def test_mode_inconnu_retombe_sur_aucune(ms):
    assert ms.merge_personal_mcp([], [_srv(auth_mode="magique")])[0]["auth_mode"] == ""


# ── 4. Vue navigateur ────────────────────────────────────────────────────────

def test_personal_public_masque_le_secret_et_pose_has_auth(ms):
    stored = ms.merge_personal_mcp([], [_srv()])[0]
    pub = ms.personal_public(stored)
    assert pub["has_auth"] is True
    assert "auth_enc" not in pub and "key_scheme" not in pub
    assert "jeton-secret" not in json.dumps(pub)


def test_personal_public_sans_auth(ms):
    stored = ms.merge_personal_mcp([], [_srv(auth_mode="", auth_secret="")])[0]
    assert ms.personal_public(stored)["has_auth"] is False


# ── 5. Legacy : entrées d'avant migration ────────────────────────────────────

def test_entree_legacy_en_clair_reste_fonctionnelle(ms):
    """Si le chiffrement était indisponible à la migration, l'entrée est restée
    en clair — elle doit continuer de se connecter."""
    legacy = {"id": "server_9", "name": "Vieux", "type": "sse",
              "url": "http://v", "authorization": "Bearer vieux"}
    assert ms.personal_to_config(legacy)["authorization"] == "Bearer vieux"


def test_entree_legacy_reprise_au_vol_par_la_fusion(ms):
    legacy = {"id": "server_9", "name": "Vieux", "type": "sse", "url": "http://v",
              "basic_auth": {"username": "u", "token": "t"}}
    out = ms.merge_personal_mcp(
        [legacy], [{"id": "server_9", "name": "Vieux", "type": "sse",
                    "url": "http://v", "auth_mode": "basic", "auth_user": "u"}])
    assert out[0]["key_scheme"] == "fernet"
    assert ms.personal_to_config(out[0])["basic_auth"]["token"] == "t"


def test_stdio_ne_recoit_jamais_den_tete(ms):
    """Un en-tête serait inerte pour stdio mais entrerait dans l'empreinte
    d'auth de la clé du pool — deux configs identiques au jeton près y
    ouvriraient deux sous-processus au lieu d'en partager un."""
    stored = ms.merge_personal_mcp([], [_srv(type="stdio", command="x")],
                                   allow_stdio=True)[0]
    cfg = ms.personal_to_config(stored, allow_stdio=True)
    assert cfg["command"] == "x" and "authorization" not in cfg


# ── 6. Résolution par id (remplace la confiance faite au client) ─────────────

def test_resolve_personal_par_id(ms):
    stored = ms.merge_personal_mcp([], [_srv()])
    cfg = ms.resolve_personal({"mcp_servers": stored}, "server_1")
    assert cfg["url"] == "http://w/mcp"
    assert cfg["authorization"] == "Bearer jeton-secret"


def test_resolve_personal_id_inconnu(ms):
    assert ms.resolve_personal({"mcp_servers": []}, "server_x") is None


# ── 7. Migration 0013 ────────────────────────────────────────────────────────

def _migrate(tmp_path, settings, name="m.db"):
    import sqlite3
    db = tmp_path / name
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE IF NOT EXISTS users "
                 "(id INTEGER PRIMARY KEY, settings_json TEXT)")
    conn.execute("DELETE FROM users")
    conn.execute("INSERT INTO users(id, settings_json) VALUES(1, ?)",
                 (json.dumps(settings),))
    conn.commit()
    mod = importlib.import_module(
        "shared_infra.db._migrations.0013_encrypt_personal_mcp_auth")
    mod.migrate(conn)
    conn.commit()
    row = conn.execute("SELECT settings_json FROM users WHERE id=1").fetchone()[0]
    conn.close()
    return json.loads(row)


def test_migration_convertit_bearer_en_jeton_nu(ms, tmp_path):
    """« Bearer x » devient le mode bearer avec le jeton NU : c'est ce qui rend
    le nouveau mode utile dès le premier démarrage."""
    out = _migrate(tmp_path, {"mcp_servers": [
        {"id": "s1", "name": "W", "type": "sse", "url": "http://w",
         "authorization": "Bearer abc"}]})
    srv = out["mcp_servers"][0]
    assert srv["auth_mode"] == "bearer"
    assert "authorization" not in srv
    assert ms.personal_to_config(srv)["authorization"] == "Bearer abc"


def test_migration_convertit_basic(ms, tmp_path):
    out = _migrate(tmp_path, {"mcp_servers": [
        {"id": "s1", "name": "J", "type": "sse", "url": "http://j",
         "basic_auth": {"username": "bot", "token": "s3"}}]})
    srv = out["mcp_servers"][0]
    assert srv["auth_mode"] == "basic" and srv["auth_user"] == "bot"
    assert "basic_auth" not in srv
    assert ms.personal_to_config(srv)["basic_auth"]["token"] == "s3"


def test_migration_garde_authorization_non_bearer_en_raw(ms, tmp_path):
    out = _migrate(tmp_path, {"mcp_servers": [
        {"id": "s1", "name": "X", "type": "sse", "url": "http://x",
         "authorization": "Token zzz"}]})
    assert out["mcp_servers"][0]["auth_mode"] == "raw"


def test_migration_idempotente(ms, tmp_path):
    settings = {"mcp_servers": [
        {"id": "s1", "name": "W", "type": "sse", "url": "http://w",
         "authorization": "Bearer abc"}]}
    once = _migrate(tmp_path, settings)
    twice = _migrate(tmp_path, once)
    assert once["mcp_servers"][0]["auth_enc"] == twice["mcp_servers"][0]["auth_enc"]


def test_migration_laisse_le_reste_intact(ms, tmp_path):
    out = _migrate(tmp_path, {"theme": "dark", "mcp_servers": [
        {"id": "s1", "name": "W", "type": "sse", "url": "http://w",
         "visible": False, "authorization": "Bearer abc"}]})
    assert out["theme"] == "dark"
    assert out["mcp_servers"][0]["visible"] is False


@pytest.fixture(autouse=True)
def _sans_garde_ssrf(monkeypatch):
    """Hôtes factices (``http://w``) : la garde SSRF des MCP perso
    (audit 2026-09-22, H7) a ses propres tests."""
    import shared_infra.mcp.servers as _srv
    monkeypatch.setattr(_srv, "personal_url_block_reason", lambda url: None)
