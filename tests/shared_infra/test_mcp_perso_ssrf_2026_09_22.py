# SPDX-License-Identifier: MIT
"""Audit 2026-09-22 (H7) : un serveur MCP perso d'un non-admin ne fait pas
émettre de requête vers la machine, le LAN ou les métadonnées cloud."""
import pytest

import shared_infra.mcp.servers as S


@pytest.fixture(autouse=True)
def _vide_cache():
    S._URL_VERDICTS.clear()


@pytest.mark.parametrize("url", [
    "http://127.0.0.1:8000/mcp", "http://localhost:8001/api", "http://169.254.169.254/",
    "http://10.168.1.10/mcp", "http://[::1]/", "file:///etc/passwd",
])
def test_ajout_url_interne_refuse(url):
    with pytest.raises(S.UrlNotAllowed):
        S.merge_personal_mcp([], [{"id": "a", "type": "http", "url": url}])
    # Admin : dispensé.
    assert S.merge_personal_mcp([], [{"id": "a", "type": "http", "url": url}],
                                allow_stdio=True)


def test_url_publique_acceptee():
    out = S.merge_personal_mcp([], [{"id": "a", "type": "sse", "url": "https://93.184.216.34/sse"}])
    assert out[0]["url"] == "https://93.184.216.34/sse"
    assert S.personal_to_config(out[0])


def test_entree_existante_reste_enregistrable_mais_jamais_connectee():
    old = [{"id": "a", "type": "http", "url": "http://127.0.0.1:8000/"}]
    out = S.merge_personal_mcp(old, [{"id": "a", "type": "http", "url": "http://127.0.0.1:8000/"}])
    assert out and S.personal_to_config(out[0]) == {}
    assert S.personal_to_config(out[0], allow_stdio=True)


def test_url_refusee_est_un_403_des_routes():
    assert issubclass(S.UrlNotAllowed, S.StdioNotAllowed)
