# SPDX-License-Identifier: MIT
"""
tests/shared_infra/test_routines_cron.py — matching cron + validation.

Le scheduler des routines réutilise ``_cron_matches`` de ``_events_bus`` et la
route valide via ``_validate_cron``.
"""
from __future__ import annotations

from datetime import datetime

import pytest
from fastapi import HTTPException

from shared_infra.observability.events_bus import _cron_matches
from shared_infra.scheduling.routes_routines import _validate_cron


def test_cron_every_minute():
    assert _cron_matches("* * * * *", datetime(2026, 6, 4, 10, 0)) is True


def test_cron_exact_hour_minute():
    assert _cron_matches("0 9 * * *", datetime(2026, 6, 4, 9, 0)) is True
    assert _cron_matches("0 9 * * *", datetime(2026, 6, 4, 10, 0)) is False


def test_cron_step():
    assert _cron_matches("*/30 * * * *", datetime(2026, 6, 4, 10, 0)) is True
    assert _cron_matches("*/30 * * * *", datetime(2026, 6, 4, 10, 30)) is True
    assert _cron_matches("*/30 * * * *", datetime(2026, 6, 4, 10, 15)) is False


def test_cron_range_and_list():
    assert _cron_matches("0-5 * * * *", datetime(2026, 6, 4, 10, 3)) is True
    assert _cron_matches("0-5 * * * *", datetime(2026, 6, 4, 10, 6)) is False
    assert _cron_matches("0 9,18 * * *", datetime(2026, 6, 4, 18, 0)) is True
    assert _cron_matches("0 9,18 * * *", datetime(2026, 6, 4, 12, 0)) is False


def test_validate_cron_ok():
    assert _validate_cron(" 0 9 * * * ") == "0 9 * * *"


def test_validate_cron_rejects_wrong_field_count():
    for bad in ("* * * *", "* * * * * *", "", "garbage"):
        with pytest.raises(HTTPException) as ei:
            _validate_cron(bad)
        assert ei.value.status_code == 400
