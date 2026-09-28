# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_config_file_ownership.py — POST /api/admin/config-file
ne doit pas écraser les sections dont il n'est pas l'auteur.

Panne de production reproduite ici
----------------------------------
L'éditeur « Config principale » charge config.json à l'ouverture de l'onglet et
le renvoie ENTIER à l'enregistrement. Le toggle HTTPS
(``POST /api/admin/security/https``) écrit, lui, ``security.https.enabled`` et
``security.session.https_only`` — sans que le formulaire déjà ouvert en sache
rien. Enchaînement vécu :

  1. toggle HTTPS → binds gunicorn rabattus sur 127.0.0.1, Caddy seul point
     d'entrée ; tout fonctionne ;
  2. un enregistrement quelconque depuis l'onglet Configuration republie la
     copie du navigateur → ``security.https.enabled`` repasse à ``false`` ;
  3. rien ne bouge tant que l'app tourne (le bind vit en mémoire) ;
  4. au redémarrage suivant, ``server/gunicorn_conf.py`` relit config.json et
     binde **0.0.0.0** : l'app répond EN CLAIR sur ses ports internes
     (8001/8002) à tout le LAN pendant que Caddy sert toujours du https, et le
     cookie ``Secure`` ne suit plus — les fonctionnalités qui supposent https
     cassent, sans le moindre signal dans la console.

Invariants posés ici :
  - les réglages À PROPRIÉTAIRE (``_OWNED_PATHS``) viennent TOUJOURS du disque,
    même quand le payload en propose explicitement un autre — c'est le seul
    régime qui couvre une copie périmée ;
  - les sections simplement écrites ailleurs (``_PRESERVE_IF_ABSENT``) sont
    restaurées quand le payload ne les porte pas, et respectées sinon ;
  - l'écriture est ATOMIQUE : un config.json tronqué ferait *fail-open* les
    confs gunicorn (donc 0.0.0.0) au prochain reload.
"""
from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# État disque de référence : instance en mode HTTPS, avec des sections posées
# par les panneaux dédiés (executors, compression, révocation globale).
_ON_DISK = {
    "app": {"name": "Elpis"},
    "security": {
        "password_policy": {"min_length": 4},
        "https": {"enabled": True, "main_port": 443,
                  "admin_port": 8443, "rag_port": 8444},
        "session": {"same_site": "lax", "https_only": True,
                    "cookie_name": "mcpwebui_session",
                    "global_min_ts": 1777148207.25},
    },
    "executors": {"runtime": "docker", "exec_user": "1000:1000"},
    "backup": {"remote": "gitea", "enabled": True},
    "llm": {"compression": {"enabled": True, "keep_recent_turns": 6},
            "scheduling_mode": "queue",
            "allowed_provider_types": ["openai", "anthropic"]},
}

# Ce que renvoie un formulaire chargé AVANT le toggle HTTPS : il « sait » que
# le https est coupé, que le cookie n'est pas Secure et qu'aucune révocation
# globale n'a eu lieu. Trois valeurs explicites, toutes périmées.
_STALE_FORM = {
    "app": {"name": "Elpis"},
    "security": {
        "password_policy": {"min_length": 4},
        "https": {"enabled": False},
        "session": {"same_site": "lax", "https_only": False,
                    "cookie_name": "mcpwebui_session",
                    "global_min_ts": 0},
    },
}


@pytest.fixture()
def client(monkeypatch, tmp_path):
    import shared_infra.routes.admin.config as adm

    p = tmp_path / "config.json"
    p.write_text(json.dumps(_ON_DISK, indent=2), encoding="utf-8")
    monkeypatch.setattr(adm, "DEFAULT_CONFIG_PATH", p, raising=False)
    monkeypatch.setattr(adm, "require_user_id", lambda request: "1", raising=False)
    monkeypatch.setattr(adm, "get_user_by_id",
                        lambda uid: {"id": 1, "is_admin": 1}, raising=False)

    app = FastAPI()
    app.include_router(adm.admin_router)
    c = TestClient(app, raise_server_exceptions=False)
    c._path = p
    return c


def _save(client, payload: dict):
    return client.post("/api/admin/config-file",
                       json={"type": "main", "content": json.dumps(payload)})


def _after(client) -> dict:
    return json.loads(client._path.read_text(encoding="utf-8"))


# ── Le cœur de la panne ──────────────────────────────────────────────────────
def test_stale_form_cannot_disable_https_mode(client):
    """LE test de non-régression : un formulaire périmé ne rouvre pas les binds."""
    assert _save(client, _STALE_FORM).status_code == 200
    https = _after(client)["security"]["https"]
    assert https["enabled"] is True
    # Les ports du frontal survivent aussi : la garde anti-lockout du toggle et
    # la synthèse d'URLs publiques les lisent.
    assert (https["main_port"], https["admin_port"], https["rag_port"]) == (443, 8443, 8444)


def test_stale_form_cannot_clear_secure_cookie_flag(client):
    """``https_only`` est dérivé du toggle : le remettre à false enverrait le
    cookie de session en clair."""
    assert _save(client, _STALE_FORM).status_code == 200
    assert _after(client)["security"]["session"]["https_only"] is True


def test_stale_form_cannot_rewind_global_revocation(client):
    """Faire reculer ``global_min_ts`` RÉ-AUTORISE toutes les sessions qu'un
    admin venait de révoquer — une révocation ne doit pas s'annuler par une
    sauvegarde de formulaire."""
    assert _save(client, _STALE_FORM).status_code == 200
    assert _after(client)["security"]["session"]["global_min_ts"] == 1777148207.25


def test_form_still_writes_what_it_owns(client):
    """Le régime de propriété ne gèle QUE les chemins listés : le reste du
    formulaire s'enregistre normalement (sinon l'onglet ne servirait plus)."""
    payload = json.loads(json.dumps(_STALE_FORM))
    payload["app"]["name"] = "Elpis LAN"
    payload["security"]["password_policy"]["min_length"] = 12
    payload["security"]["session"]["cookie_name"] = "elpis_session"
    assert _save(client, payload).status_code == 200
    after = _after(client)
    assert after["app"]["name"] == "Elpis LAN"
    assert after["security"]["password_policy"]["min_length"] == 12
    assert after["security"]["session"]["cookie_name"] == "elpis_session"


def test_https_mode_cannot_be_enabled_from_the_raw_editor(client, tmp_path):
    """Corollaire assumé : activer le HTTPS par l'éditeur brut sauterait la
    garde anti-lockout du toggle (qui vérifie que Caddy écoute AVANT d'écrire).
    L'éditeur ne fait donc bouger le mode dans AUCUN sens."""
    client._path.write_text(json.dumps({
        "security": {"https": {"enabled": False}},
    }), encoding="utf-8")
    assert _save(client, {"security": {"https": {"enabled": True}}}).status_code == 200
    assert _after(client)["security"]["https"]["enabled"] is False


def test_fresh_instance_lets_the_form_seed_defaults(client):
    """Instance neuve : rien n'a jamais été écrit par le propriétaire. Le
    formulaire doit alors pouvoir poser ses défauts, sinon l'onglet Cookies &
    sessions ne pourrait jamais rien enregistrer."""
    client._path.write_text(json.dumps({"app": {"name": "Elpis"}}), encoding="utf-8")
    payload = {"app": {"name": "Elpis"},
               "security": {"session": {"https_only": False, "global_min_ts": 0}}}
    assert _save(client, payload).status_code == 200
    sess = _after(client)["security"]["session"]
    assert sess["https_only"] is False and sess["global_min_ts"] == 0


# ── Sections « préservées si absentes » ──────────────────────────────────────
@pytest.mark.parametrize("path,expected", [
    (("executors",), {"runtime": "docker", "exec_user": "1000:1000"}),
    (("backup",), {"remote": "gitea", "enabled": True}),
    (("llm", "compression"), {"enabled": True, "keep_recent_turns": 6}),
    (("llm", "scheduling_mode"), "queue"),
    (("llm", "allowed_provider_types"), ["openai", "anthropic"]),
])
def test_sections_written_elsewhere_survive_a_form_save(client, path, expected):
    """Le formulaire ne connaît pas ces sections (panneaux dédiés) : les
    omettre ne doit pas les effacer. C'est le bug historique « trigger_after
    reset à chaque redémarrage », élargi aux sections oubliées de la liste."""
    assert _save(client, _STALE_FORM).status_code == 200
    node = _after(client)
    for key in path:
        assert key in node, f"{'.'.join(path)} effacée par la sauvegarde"
        node = node[key]
    assert node == expected


def test_explicit_payload_wins_for_preserved_sections(client):
    """Régime « préserver si absent » : quand l'admin édite VRAIMENT la section,
    sa valeur passe (contrairement aux chemins à propriétaire)."""
    payload = json.loads(json.dumps(_STALE_FORM))
    payload["executors"] = {"runtime": "podman"}
    payload["llm"] = {"scheduling_mode": "direct"}
    assert _save(client, payload).status_code == 200
    after = _after(client)
    assert after["executors"] == {"runtime": "podman"}
    assert after["llm"]["scheduling_mode"] == "direct"
    # …et les autres sections llm absentes du payload restent préservées.
    assert after["llm"]["compression"] == {"enabled": True, "keep_recent_turns": 6}


def test_non_dict_llm_in_payload_does_not_break_the_merge(client):
    """Payload hostile / malformé : ``llm`` scalaire. La greffe doit rester
    possible au lieu de lever (l'ancien code partait en fallback « écriture
    telle quelle », c'est-à-dire sans aucune protection)."""
    payload = json.loads(json.dumps(_STALE_FORM))
    payload["llm"] = "oops"
    assert _save(client, payload).status_code == 200
    after = _after(client)
    assert after["llm"]["compression"] == {"enabled": True, "keep_recent_turns": 6}
    assert after["security"]["https"]["enabled"] is True


# ── Écriture ─────────────────────────────────────────────────────────────────
def test_write_is_atomic_and_leaves_no_temp_file(client, tmp_path):
    """tmp + rename : aucun lecteur ne peut observer un config.json tronqué.
    Les confs gunicorn *fail-open* sur JSON illisible → un fichier à moitié
    écrit les ferait binder 0.0.0.0 en plein mode HTTPS."""
    assert _save(client, _STALE_FORM).status_code == 200
    leftovers = [p.name for p in tmp_path.iterdir() if p.name.endswith(".tmp")]
    assert leftovers == []
    # Le fichier reste du JSON valide et complet.
    assert _after(client)["app"]["name"] == "Elpis"


def test_backup_copy_is_still_made(client, tmp_path):
    assert _save(client, _STALE_FORM).status_code == 200
    bak = tmp_path / "config.json.bak"
    assert bak.exists()
    assert json.loads(bak.read_text(encoding="utf-8")) == _ON_DISK


def test_invalid_json_is_refused_before_touching_the_file(client):
    before = client._path.read_text(encoding="utf-8")
    r = client.post("/api/admin/config-file",
                    json={"type": "main", "content": "{not json"})
    assert r.status_code == 400
    assert client._path.read_text(encoding="utf-8") == before
