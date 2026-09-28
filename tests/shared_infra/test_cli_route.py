# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_cli_route.py — distribution LAN d'OpenCode (/api/cli/*).

Couvre : rendu de l'installeur (avec l'URL LAN), 404 si binaire absent / OS inconnu,
service du bundle quand présent, et la garde du flag global ``features.opencode``.
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def cli_client(tmp_path, monkeypatch):
    import shared_infra.opencode.routes_cli as cli
    monkeypatch.setattr(cli, "_dist_dir", lambda: tmp_path)
    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app), tmp_path, cli


def test_install_sh_rendered_with_lan_url(cli_client):
    client, _dist, _cli = cli_client
    r = client.get("/api/cli/install.sh")
    assert r.status_code == 200
    assert "OpenCode" in r.text and "/api/cli/bundle/" in r.text


def test_ca_crt_served_by_the_app(cli_client, tmp_path, monkeypatch):
    """La CA locale doit être joignable SANS frontal :80.

    Caddy la publie sur ``http://<hôte>/ca.crt``, mais ce chemin n'existe que
    derrière le frontal : en HTTPS direct (ou :80 filtré) l'installeur ne
    trouvait aucune CA et se rabattait sur ``-k`` définitivement.
    """
    client, _dist, cli = cli_client
    ca = tmp_path / "ca.crt"
    ca.write_text("-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n")
    monkeypatch.setenv("ELPIS_CA_FILE", str(ca))
    r = client.get("/api/cli/ca.crt")
    assert r.status_code == 200
    assert "BEGIN CERTIFICATE" in r.text


def test_ca_crt_404_without_https_deployment(cli_client, tmp_path, monkeypatch):
    client, _dist, cli = cli_client
    monkeypatch.setenv("ELPIS_CA_FILE", str(tmp_path / "absente.crt"))
    assert client.get("/api/cli/ca.crt").status_code == 404


def test_ca_crt_stays_reachable_when_opencode_is_disabled(cli_client, tmp_path, monkeypatch):
    # Volontairement HORS du gate ``features.opencode`` : l'installeur desktop et
    # tout client LAN ont besoin de la CA même si la distribution OpenCode est
    # coupée par l'administrateur.
    client, _dist, cli = cli_client
    ca = tmp_path / "ca.crt"
    ca.write_text("-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n")
    monkeypatch.setenv("ELPIS_CA_FILE", str(ca))
    monkeypatch.setattr(cli, "feature_enabled",
                        lambda name, default=True: False if name == "opencode" else default)
    assert client.get("/api/cli/ca.crt").status_code == 200
    assert client.get("/api/cli/opencode.json").status_code == 404      # celui-ci reste gaté


def test_installers_seed_plugin_deps_and_pin_ca(cli_client):
    # Contrat des deux installeurs, vérifié sur le TEXTE servi : le trio
    # node_modules/package.json/package-lock.json (démarrage hors ligne) et la
    # récupération de la CA par les DEUX sources.
    client, _dist, _cli = cli_client
    sh = client.get("/api/cli/install.sh").text
    ps = client.get("/api/cli/install.ps1").text
    for t in (sh, ps):
        assert "package-lock.json" in t and "node_modules" in t
        assert "@opencode-ai/plugin" in t
        assert "/api/cli/ca.crt" in t          # 2e source, sans frontal :80
        assert "/ca.crt" in t                  # 1re source (Caddy :80)
    assert "update-ca-certificates" in sh and "ELPIS_TRUST_CA" in sh
    assert "Cert:\\CurrentUser\\Root" in ps
    # sudo ne doit JAMAIS lire son mot de passe dans le tube du curl
    assert "sudo -n" in sh and "< /dev/tty" in sh


def test_bundle_404_when_absent_or_unknown_os(cli_client):
    client, _dist, _cli = cli_client
    assert client.get("/api/cli/bundle/linux").status_code == 404      # rien déposé
    assert client.get("/api/cli/bundle/solaris").status_code == 404    # OS inconnu


def test_bundle_served_when_present(cli_client):
    client, dist, _cli = cli_client
    (dist / "opencode-linux.tar.gz").write_bytes(b"FAKEBINARY")
    r = client.get("/api/cli/bundle/linux")
    assert r.status_code == 200 and r.content == b"FAKEBINARY"
    # alias macos
    (dist / "opencode-macos.zip").write_bytes(b"MAC")
    assert client.get("/api/cli/bundle/mac").content == b"MAC"


def test_base_url_rejects_host_header_injection():
    # SÉCURITÉ — le Host header (request.base_url) ne doit JAMAIS contenir de
    # caractères pouvant casser les scripts install.sh/ps1 rendus (sinon RCE).
    import shared_infra.opencode.routes_cli as cli
    from fastapi import HTTPException

    class _Req:
        def __init__(self, u):
            self.base_url = u

    assert cli._base_url(_Req("http://10.168.1.5:8000/")) == "http://10.168.1.5:8000"
    assert cli._base_url(_Req("https://host.lan/")) == "https://host.lan"
    for bad in ['http://evil.com;rm -rf /', 'http://e";id;"', "http://e'; calc; '", "http://e x/", "ftp://e/"]:
        with pytest.raises(HTTPException):
            cli._base_url(_Req(bad))


def test_gated_when_opencode_disabled(cli_client, monkeypatch):
    client, dist, cli = cli_client
    # le flag est lu via cli.feature_enabled (importé dans le module)
    monkeypatch.setattr(cli, "feature_enabled",
                        lambda name, default=True: False if name == "opencode" else default)
    (dist / "opencode-linux.tar.gz").write_bytes(b"X")
    assert client.get("/api/cli/install.sh").status_code == 404
    assert client.get("/api/cli/bundle/linux").status_code == 404


# ── opencode.json généré à chaud ─────────────────────────────────────────────

def _fake_cache():
    """Cache modèles réaliste (dont un modèle vision) + serveur joignable."""
    return {
        "server_reachable": True,
        "models": ["qwen3-coder-30b", "qwen3.6-27b", "glm-4.7-flash"],
        "models_with_status": [
            {"id": "qwen3-coder-30b", "status": "loaded", "vision": False},
            {"id": "qwen3.6-27b", "status": "unloaded", "vision": True},
            {"id": "glm-4.7-flash", "status": "unloaded", "vision": False},
        ],
    }


def test_opencode_json_live(cli_client, monkeypatch):
    client, _dist, cli = cli_client
    import shared_infra.observability.events_bus as eb
    monkeypatch.setattr(cli, "_llama_base_url", lambda: "http://10.9.8.7:1234")
    monkeypatch.setattr(eb, "_model_cache", _fake_cache())
    r = client.get("/api/cli/opencode.json")
    assert r.status_code == 200
    cfg = r.json()
    prov = cfg["provider"]["elpis"]
    assert prov["npm"] == "@ai-sdk/openai-compatible"
    assert prov["options"]["baseURL"] == "http://10.9.8.7:1234/v1"   # baseURL live
    models = prov["models"]
    assert set(models) == {"qwen3-coder-30b", "qwen3.6-27b", "glm-4.7-flash"}
    assert models["qwen3-coder-30b"]["tool_call"] is True
    assert models["qwen3.6-27b"].get("attachment") is True            # vision → attachment
    assert "attachment" not in models["glm-4.7-flash"]
    assert cfg["model"] == "elpis/qwen3-coder-30b"                    # préférence config présente


def test_opencode_json_fallback_when_cache_cold(cli_client, monkeypatch):
    client, _dist, cli = cli_client
    import shared_infra.observability.events_bus as eb
    # serveur injoignable / cache vide → roster baked-in (offline), config valide
    monkeypatch.setattr(eb, "_model_cache", {"server_reachable": False, "models_with_status": []})
    r = client.get("/api/cli/opencode.json")
    assert r.status_code == 200
    cfg = r.json()
    models = cfg["provider"]["elpis"]["models"]
    assert "qwen3-coder-30b" in models
    assert models["qwen3.6-27b"].get("attachment") is True
    assert cfg["model"].startswith("elpis/")


def test_opencode_json_gated_when_disabled(cli_client, monkeypatch):
    client, _dist, cli = cli_client
    monkeypatch.setattr(cli, "feature_enabled",
                        lambda name, default=True: False if name == "opencode" else default)
    assert client.get("/api/cli/opencode.json").status_code == 404


def test_opencode_json_model_limits_from_ctx_cache(cli_client, monkeypatch):
    # les n_ctx/slot déjà sondés (cache _model_info) sont propagés en
    # limit.context — jauge ctx de la page Remote code ; jamais de sonde ici
    client, _dist, cli = cli_client
    import shared_infra.observability.events_bus as eb
    from llm_core import _model_info
    monkeypatch.setattr(eb, "_model_cache", _fake_cache())
    monkeypatch.setattr(_model_info, "_cached_context_size",
                        {"qwen3-coder-30b": 32768, "": 8192, "inconnu": 0})
    models = client.get("/api/cli/opencode.json").json()["provider"]["elpis"]["models"]
    # ⚠ `context` ET `output` : le schéma opencode exige les deux (required).
    # Avec `context` seul, opencode refuse TOUT le fichier (« Missing key
    # provider.elpis.models.<id>.limit.output ») et le provider disparaît.
    assert models["qwen3-coder-30b"]["limit"] == {"context": 32768, "output": 4096}
    # pas de valeur cachée (ou clé défaut "") → pas de limit inventée
    assert "limit" not in models["glm-4.7-flash"]
    assert "limit" not in models["qwen3.6-27b"]


def test_opencode_json_output_limit_leaves_context_usable():
    """``output`` doit rester PETIT devant ``context``.

    opencode calcule ``usable = limit.context − min(limit.output, 32000)`` pour
    décider du compactage (session/overflow.ts). Un ``output`` proche du plafond
    (32 000) sur une fenêtre de 32K ne laisse que quelques centaines de tokens
    utiles → compactage à chaque tour, session inutilisable.
    """
    from shared_infra.opencode.routes_cli import _output_limit
    for ctx in (8192, 16384, 32768, 131072, 1048576):
        out = _output_limit(ctx)
        assert 2048 <= out <= 16384
        usable = ctx - min(out, 32000)
        assert usable >= ctx * 0.7, (ctx, out, usable)


def test_pick_default_model_precedence(monkeypatch):
    import shared_infra.opencode.routes_cli as cli
    # 1) préférence config honorée si présente dans le roster
    monkeypatch.setattr(cli, "read_config_json",
                        lambda: {"opencode": {"default_model": "glm-4.7-flash"}})
    assert cli._pick_default_model(["qwen3-coder-30b", "glm-4.7-flash"], set()) == "glm-4.7-flash"
    # 2) préférence absente → 1er modèle chargé
    monkeypatch.setattr(cli, "read_config_json",
                        lambda: {"opencode": {"default_model": "absent"}})
    assert cli._pick_default_model(["a", "b", "c"], {"b"}) == "b"
    # 3) ni pref ni loaded → 1er dispo
    monkeypatch.setattr(cli, "read_config_json", lambda: {})
    assert cli._pick_default_model(["x", "y"], set()) == "x"


# ── installeurs : config à chaud + PATH auto ─────────────────────────────────

def test_install_sh_fetches_config_and_sets_path(cli_client):
    client, _dist, _cli = cli_client
    t = client.get("/api/cli/install.sh").text
    assert "/api/cli/opencode.json" in t          # récupère la config à chaud
    assert "$CFG_DST.bak" in t                     # backup avant écrasement
    assert "OPENCODE_ELPIS_PATH" in t              # marqueur idempotent PATH
    assert ".bashrc" in t                          # écrit dans les rc
    assert "existante conservée" not in t          # plus de no-clobber
    assert "__BASE__" not in t                     # placeholder bien substitué


def test_install_ps1_user_path_and_config(cli_client):
    client, _dist, _cli = cli_client
    t = client.get("/api/cli/install.ps1").text
    assert "/api/cli/opencode.json" in t
    assert "SetEnvironmentVariable('Path'" in t    # PATH utilisateur persistant
    assert ".bak" in t
    assert "__BASE__" not in t


def test_install_scripts_seed_remote_token(cli_client):
    # le jeton per-user (env ELPIS_REMOTE_TOKEN, embarqué dans la commande copiée
    # depuis le modal) est écrit dans elpis-remote.json → « /remote » suffit ensuite
    client, _dist, _cli = cli_client
    sh = client.get("/api/cli/install.sh").text
    assert "ELPIS_REMOTE_TOKEN" in sh and "elpis-remote.json" in sh
    assert "/api/code/plugin.ts" in sh             # plugin TypeScript canonique
    assert '"enabled": *true' in sh                # ré-install : préserve l'état actif
    ps1 = client.get("/api/cli/install.ps1").text
    assert "ELPIS_REMOTE_TOKEN" in ps1 and "elpis-remote.json" in ps1
    assert "/api/code/plugin.ts" in ps1


def test_install_scripts_plugin_is_optional_y_n(cli_client):
    # choix EXPLICITE : prompt y/N (tty), surchargé par ELPIS_INSTALL_PLUGIN ;
    # refus ⇒ l'ancien plugin est retiré (sinon le .js legacy continue de charger)
    client, _dist, _cli = cli_client
    sh = client.get("/api/cli/install.sh").text
    assert "ELPIS_INSTALL_PLUGIN" in sh
    assert "/dev/tty" in sh                        # stdin est le pipe du curl
    assert "[y/N]" in sh and "[Y/n]" in sh         # défaut selon présence du jeton
    # jamais DEUX plugins chargés (glob *.{ts,js}) : purge du .js legacy à l'install
    assert sh.count("elpis-remote.js") >= 2        # install (purge) + refus (retrait)
    assert 'WANT_PLUGIN=y' in sh and 'WANT_PLUGIN=n' in sh
    ps1 = client.get("/api/cli/install.ps1").text
    assert "ELPIS_INSTALL_PLUGIN" in ps1 and "Read-Host" in ps1
    assert "[y/N]" in ps1 and "[Y/n]" in ps1
    assert "elpis-remote.js" in ps1                # purge du legacy aussi côté Windows


def test_install_scripts_handle_https_self_signed(cli_client):
    # app derrière Caddy https (cert LAN auto-signé) : vérif normale → CA locale
    # épinglée (http://<hôte>/ca.crt, servi par Caddy :80) → repli non vérifié
    client, _dist, _cli = cli_client
    sh = client.get("/api/cli/install.sh").text
    assert "/ca.crt" in sh and "--cacert" in sh
    assert 'CURL_TLS="-k"' in sh                   # repli explicite, avec warning
    assert "elpis-ca.crt" in sh                    # CA propagée au plugin (conf ca_file)
    ps1 = client.get("/api/cli/install.ps1").text
    assert "SkipCertificateCheck" in ps1           # PS 7+
    # PS 5.1 : TLS 1.2 forcé AVANT le probe — sans lui, .NET Framework échoue en
    # handshake face à Caddy (« The underlying connection was closed »)
    assert "SecurityProtocol" in ps1 and "3072" in ps1
    # PS 5.1 : bypass cert par callback C# COMPILÉ — un scriptblock { $true }
    # peut être invoqué hors runspace et avorter le handshake (même erreur)
    assert "ElpisTrustAll" in ps1 and "Add-Type" in ps1
    assert "= { $true }" not in ps1
    assert "insecure" in ps1                       # propagé à elpis-remote.json


# ── Amorçage EN CLAIR (:80) : BASE ≠ APP_URL, alias courts, ASCII ────────────
# Rationale : la machine cible ne connaît pas la CA locale au moment du curl.
# Servir l'amorçage en http supprime tout contournement TLS de la COMMANDE ;
# l'URL de l'app (https) reste bakée séparément pour le plugin elpis-remote.

def test_short_aliases_serve_the_installers(cli_client):
    client, _dist, _cli = cli_client
    for short, long in (("/opencode", "/api/cli/install.sh"),
                        ("/opencode.ps1", "/api/cli/install.ps1")):
        a = client.get(short)
        b = client.get(long)
        assert a.status_code == 200
        assert a.text == b.text                       # même script, chemin court


def test_short_aliases_gated_by_feature_flag(cli_client, monkeypatch):
    client, _dist, cli = cli_client
    monkeypatch.setattr(cli, "feature_enabled",
                        lambda name, default=True: False if name == "opencode" else default)
    assert client.get("/opencode").status_code == 404
    assert client.get("/opencode.ps1").status_code == 404


def _https_on(monkeypatch, enabled=True, main_port=443):
    import shared_infra.config as cfg
    monkeypatch.setattr(cfg, "https_enabled", lambda: enabled)
    monkeypatch.setattr(cfg, "https_ports",
                        lambda: {"main": main_port, "admin": 8443, "rag": 8444})


def test_app_url_is_https_even_when_bootstrapped_in_clear(cli_client, monkeypatch):
    # Cas réel : `curl http://<ip>/opencode` (Caddy :80) alors que l'app n'est
    # joignable qu'en https. BASE (téléchargements) reste http, APP_URL — ce que
    # le plugin contactera — doit pointer le frontal TLS.
    client, _dist, _cli = cli_client
    _https_on(monkeypatch)
    sh = client.get("/opencode", headers={"host": "10.0.0.5"}).text
    assert 'BASE="http://10.0.0.5"' in sh
    assert 'APP_URL="https://10.0.0.5"' in sh          # 443 implicite
    ps1 = client.get("/opencode.ps1", headers={"host": "10.0.0.5"}).text
    assert "$Base   = 'http://10.0.0.5'" in ps1
    assert "$AppUrl = 'https://10.0.0.5'" in ps1


def test_app_url_carries_custom_https_port(cli_client, monkeypatch):
    client, _dist, _cli = cli_client
    _https_on(monkeypatch, main_port=8443)
    sh = client.get("/opencode", headers={"host": "10.0.0.5"}).text
    assert 'APP_URL="https://10.0.0.5:8443"' in sh


def test_app_url_falls_back_to_base_without_https(cli_client, monkeypatch):
    client, _dist, _cli = cli_client
    _https_on(monkeypatch, enabled=False)
    sh = client.get("/opencode", headers={"host": "10.0.0.5:8001"}).text
    assert 'BASE="http://10.0.0.5:8001"' in sh
    assert 'APP_URL="http://10.0.0.5:8001"' in sh
    # aucun https en jeu → la récupération de CA est gardée par les deux URL
    assert 'case "$BASE $APP_URL" in' in sh


def test_plugin_conf_uses_app_url_not_download_base(cli_client, monkeypatch):
    # Régression : écrire app_url=$BASE ferait taper le plugin sur http://<ip>,
    # que Caddy renvoie en 302 vers https → échec de handshake côté Bun.
    client, _dist, _cli = cli_client
    _https_on(monkeypatch)
    sh = client.get("/opencode").text
    assert '"$APP_URL" "$TOKEN"' in sh
    assert '"$BASE" "$TOKEN"' not in sh
    ps1 = client.get("/opencode.ps1").text
    assert "app_url = $AppUrl" in ps1
    assert "app_url = $Base" not in ps1
    assert "ca_file" in ps1                            # CA épinglée aussi sous Windows


def test_installers_render_no_placeholder_left(cli_client):
    client, _dist, _cli = cli_client
    for path in ("/opencode", "/opencode.ps1"):
        t = client.get(path).text
        assert "__BASE__" not in t and "__APP_URL__" not in t


def test_install_ps1_is_pure_ascii(cli_client):
    # PS 5.1 lit un .ps1 sans BOM en ANSI : un caractère accentué peut fermer
    # une chaîne et casser le parsing du fichier entier (leçon desktop-agent).
    client, _dist, _cli = cli_client
    ps1 = client.get("/api/cli/install.ps1").text
    bad = sorted({c for c in ps1 if ord(c) > 127})
    assert not bad, f"caractères non-ASCII dans install.ps1 : {bad!r}"


# ── Outils Elpis dans opencode : bloc ``mcp`` (2026-09-03) ───────────────────

def _service_partage(monkeypatch, cli, *, host="0.0.0.0", url="http://127.0.0.1:8765/mcp", token="svc"):
    import shared_infra.config as cfg
    # Familles réellement enregistrées : « inconnu » (aucun worker n'a connecté
    # le pool dans ces tests) → aucune famille n'est élaguée.
    monkeypatch.setattr(cli, "_live_families", lambda: None)
    monkeypatch.setattr(cfg, "LOCAL_MCP_URL", url)
    monkeypatch.setattr(cfg, "LOCAL_MCP_TOKEN", token)
    monkeypatch.setattr(cfg, "LOCAL_MCP_HOST", host)
    monkeypatch.setattr(cfg, "LOCAL_MCP_PORT", 8765)
    monkeypatch.setattr(cfg, "LOCAL_MCP_PUBLIC_URL", "")
    # HTTPS neutralisé PAR DÉFAUT : sans ça, ces tests lisaient le
    # ``config.json`` de la machine et changeaient de schéma d'un poste de dev à
    # l'autre. Le cas TLS a son test dédié
    # (test_opencode_json_url_suit_le_frontal_https), qui le rallume.
    monkeypatch.setattr(cfg, "https_enabled", lambda: False, raising=False)
    import shared_infra.opencode.routes_code as code
    monkeypatch.setattr(code, "_resolve_token", lambda t: 3 if t == "pcr_hugo" else None)


def test_opencode_json_une_entree_mcp_par_famille(cli_client, monkeypatch):
    """Dans opencode la bascule EST le serveur MCP : une entrée par famille,
    donc une bascule par famille. Noms et URL stables (le nom du serveur préfixe
    les noms d'outils vus par le modèle)."""
    client, _dist, cli = cli_client
    _service_partage(monkeypatch, cli)
    r = client.get("/api/cli/opencode.json", headers={"x-elpis-token": "pcr_hugo"})
    assert r.status_code == 200
    mcp = r.json()["mcp"]
    assert set(mcp) == {"elpis-git", "elpis-browser", "elpis-desktop"}
    git = mcp["elpis-git"]
    assert git["type"] == "remote" and git["enabled"] is True
    # L'URL passe par l'ORIGINE DE L'APP (relais /api/mcp-bridge), pas par
    # l'adresse propre du service : c'est ce qui la rend joignable depuis un
    # autre poste (cf. test_opencode_json_url_joignable_depuis_un_poste_distant).
    assert git["url"] == "http://testserver/api/mcp-bridge/git"
    assert git["headers"] == {"Authorization": "Bearer pcr_hugo"}
    assert mcp["elpis-browser"]["url"] == "http://testserver/api/mcp-bridge/browser"
    # fs/shell ne sont JAMAIS publiées à opencode (elles agissent sur l'hôte)
    assert not {"elpis-fs", "elpis-shell"} & set(mcp)
    # Bearer accepté aussi (même jeton)
    r2 = client.get("/api/cli/opencode.json", headers={"Authorization": "Bearer pcr_hugo"})
    assert "mcp" in r2.json()


def test_opencode_json_familles_selon_la_config(cli_client, monkeypatch):
    client, _dist, cli = cli_client
    _service_partage(monkeypatch, cli)
    import shared_infra.config as cfg
    monkeypatch.setattr(cfg, "LOCAL_MCP_OPENCODE_FAMILIES", "git,chart,fs")
    mcp = client.get("/api/cli/opencode.json", headers={"x-elpis-token": "pcr_hugo"}).json()["mcp"]
    assert set(mcp) == {"elpis-git", "elpis-chart"}          # fs reste exclue
    monkeypatch.setattr(cfg, "LOCAL_MCP_OPENCODE_FAMILIES", "")
    assert "mcp" not in client.get("/api/cli/opencode.json",
                                   headers={"x-elpis-token": "pcr_hugo"}).json()


def test_opencode_json_respecte_le_choix_du_compte(cli_client, monkeypatch):
    """La bascule du TUI d'opencode n'est pas persistée et un re-sync réécrit le
    fichier : le seul choix qui dure est celui du compte, rendu en ``enabled``."""
    client, _dist, cli = cli_client
    _service_partage(monkeypatch, cli)
    import shared_infra.accounts.users as users
    monkeypatch.setattr(users, "get_user_settings",
                        lambda uid: {"opencode_mcp_families": {"browser": False}})
    mcp = client.get("/api/cli/opencode.json", headers={"x-elpis-token": "pcr_hugo"}).json()["mcp"]
    assert mcp["elpis-browser"]["enabled"] is False          # publiée, mais éteinte
    assert mcp["elpis-git"]["enabled"] is True               # défaut : active


def test_opencode_familles_endpoint(cli_client, monkeypatch):
    client, _dist, cli = cli_client
    _service_partage(monkeypatch, cli)
    assert client.get("/api/cli/opencode/families").status_code == 401      # anonyme
    fams = client.get("/api/cli/opencode/families",
                      headers={"x-elpis-token": "pcr_hugo"}).json()["families"]
    assert [f["name"] for f in fams] == ["git", "browser", "desktop"]
    assert all(f["enabled"] is True and f["label"] for f in fams)
    assert [f["server"] for f in fams] == ["elpis-git", "elpis-browser", "elpis-desktop"]


def test_opencode_json_sans_bloc_mcp_si_anonyme_ou_jeton_inconnu(cli_client, monkeypatch):
    client, _dist, cli = cli_client
    _service_partage(monkeypatch, cli)
    assert "mcp" not in client.get("/api/cli/opencode.json").json()
    assert "mcp" not in client.get("/api/cli/opencode.json", headers={"x-elpis-token": "pcr_faux"}).json()


def test_opencode_json_sans_bloc_mcp_si_service_non_partage(cli_client, monkeypatch):
    """Sans service partagé + jeton de service, aucun client externe ne
    pourrait se connecter : on n'écrit pas un bloc mort."""
    client, _dist, cli = cli_client
    _service_partage(monkeypatch, cli, url="")                       # stdio par worker
    assert "mcp" not in client.get("/api/cli/opencode.json", headers={"x-elpis-token": "pcr_hugo"}).json()
    _service_partage(monkeypatch, cli, token="")                     # partagé mais sans auth
    assert "mcp" not in client.get("/api/cli/opencode.json", headers={"x-elpis-token": "pcr_hugo"}).json()


def test_opencode_json_url_publique_et_loopback(cli_client, monkeypatch):
    client, _dist, cli = cli_client
    import shared_infra.config as cfg
    _service_partage(monkeypatch, cli, host="127.0.0.1")
    def _url():
        return client.get("/api/cli/opencode.json",
                          headers={"x-elpis-token": "pcr_hugo"}).json()["mcp"]["elpis-git"]["url"]
    # Le bind loopback du SERVICE ne se voit plus dans l'URL publiée : le client
    # passe par l'app, qui relaie en loopback pour lui.
    assert _url() == "http://testserver/api/mcp-bridge/git"
    monkeypatch.setattr(cfg, "LOCAL_MCP_PUBLIC_URL", "http://outils.lan:9000/mcp")
    assert _url() == "http://outils.lan:9000/mcp/git"        # échappatoire explicite


def test_opencode_json_url_joignable_depuis_un_poste_distant(cli_client, monkeypatch):
    """RÉGRESSION 2026-09-04 — un opencode installé sur une AUTRE machine
    recevait ``http://127.0.0.1:8765/mcp/<famille>``. Chez lui, ``127.0.0.1``
    n'est pas le serveur : les trois entrées ``elpis-*`` s'affichaient et aucune
    ne répondait. Les tests d'alors FIGEAIENT cette URL comme attendue, donc
    aucune des passes d'audit ne pouvait la voir.

    Invariant posé ici : l'URL publiée porte l'hôte QUE LE CLIENT A CONTACTÉ, et
    ne contient jamais une adresse de loopback."""
    client, _dist, cli = cli_client
    for bind in ("127.0.0.1", "0.0.0.0", "localhost", ""):
        _service_partage(monkeypatch, cli, host=bind)
        for hote in ("10.168.1.50:8001", "elpis.lan", "10.0.0.7"):
            url = client.get("/api/cli/opencode.json",
                             headers={"x-elpis-token": "pcr_hugo", "host": hote}
                             ).json()["mcp"]["elpis-git"]["url"]
            assert hote.split(":")[0] in url, (bind, hote, url)
            assert "127.0.0.1" not in url and "localhost" not in url, (bind, hote, url)


def test_opencode_json_url_suit_le_frontal_https(cli_client, monkeypatch):
    """Derrière Caddy, l'app est en https/443 : publier une URL en clair sur un
    second port obligeait à ouvrir ET sécuriser une deuxième surface réseau.
    Le relais vit sous l'origine de l'app — donc sous le MÊME certificat."""
    client, _dist, cli = cli_client
    _service_partage(monkeypatch, cli)
    import shared_infra.config as cfg_mod
    monkeypatch.setattr(cfg_mod, "https_enabled", lambda: True, raising=False)
    monkeypatch.setattr(cfg_mod, "https_ports", lambda: {"main": 443}, raising=False)
    url = client.get("/api/cli/opencode.json",
                     headers={"x-elpis-token": "pcr_hugo", "host": "elpis.lan"}
                     ).json()["mcp"]["elpis-git"]["url"]
    assert url == "https://elpis.lan/api/mcp-bridge/git"


def test_installeurs_re_recuperent_la_config_avec_le_jeton(cli_client):
    """Après connexion, les deux installeurs redemandent ``opencode.json`` AVEC
    le jeton (en-tête ``x-elpis-token``, vers l'APP en TLS vérifié) et ne
    remplacent la config que si le bloc ``mcp`` est présent."""
    client, _dist, cli = cli_client
    sh = client.get("/api/cli/install.sh").text
    assert '-H "x-elpis-token: $TOKEN" "$APP_URL/api/cli/opencode.json"' in sh
    assert "grep -q '\"mcp\"'" in sh
    ps1 = client.get("/api/cli/install.ps1").text
    assert "'x-elpis-token' = $Token" in ps1 and '"$AppUrl/api/cli/opencode.json"' in ps1
