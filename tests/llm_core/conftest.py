# SPDX-License-Identifier: MIT
"""Fixtures partagées de tests/llm_core.

AUDIT 2026-08-31 (passe 2) — isolation du ratio tokens MESURÉ.
``llm_core.context.tokens._measured_ratio`` est un état module calibré en
production par ``note_real_usage`` ; plusieurs tests l'alimentent sans le
restaurer, et les tests d'ESTIMATION (test_token_estimate / test_token_parity)
supposent le ratio d'amorce 3.3. La suite complète passait par chance d'ordre
alphabétique ; toute sélection ``-k`` qui change l'ordre les faisait échouer
(vérifié : échec identique au commit 877900b — dette préexistante, pas une
régression). Chaque test repart donc du ratio qu'il a trouvé.
"""
from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _isole_ratio_tokens_mesure():
    import llm_core.context.tokens as tok
    avant = dict(tok._measured_ratio)
    yield
    tok._measured_ratio.clear()
    tok._measured_ratio.update(avant)


@pytest.fixture(autouse=True)
def _isole_historique_fichiers(tmp_path_factory, monkeypatch):
    """Audit éditeur 2026-09-23 : les outils fs de l'assistant notent chaque
    écriture dans l'historique de session (``shared_infra.sandbox.file_history``).
    Jamais dans ``user_db/file_history`` réel pendant la suite."""
    monkeypatch.setenv("APP_FILE_HISTORY_DIR",
                       str(tmp_path_factory.mktemp("file_history")))
    try:
        import llm_core.tools.fs_tools as _fs
        _fs._UID_CACHE.clear()
    except Exception:
        pass
    # Verrous d'écriture par fichier (E7, commun éditeur/agent) : hors du
    # ``.write_locks`` de la vraie sandbox quand un test ne pose pas
    # APP_SANDBOX_DIR.
    import shared_infra.sandbox.file_lock as _fl
    _base = tmp_path_factory.mktemp("write_locks")
    monkeypatch.setattr(_fl, "_locks_base", lambda: _base)
    yield
