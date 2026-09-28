# SPDX-License-Identifier: MIT
"""Dates locales portables (chantier multi-moteurs, lot A).

SQLite convertit un epoch en heure locale avec ``'localtime'`` ; PostgreSQL et
MySQL reçoivent à la place l'epoch décalé PAR MORCEAUX (``CASE`` sur les
transitions d'heure du process). On vérifie :

* que la branche SQLite rend exactement le SQL d'avant ;
* que l'arithmétique des morceaux — la même qui tourne en PG/MySQL —
  reproduit ``'localtime'`` de part et d'autre d'un changement d'heure.
"""
import sqlite3
import time

import pytest

from shared_infra.db import _dialect as D

# Europe/Paris, 2026 : passage à l'heure d'été le 29/03 à 01:00 UTC, retour à
# l'heure d'hiver le 25/10 à 01:00 UTC.
ETE_2026 = 1774746000
HIVER_2026 = 1792890000


@pytest.fixture
def paris(monkeypatch):
    monkeypatch.setenv("TZ", "Europe/Paris")
    time.tzset()
    D._OFFSET_CACHE.clear()
    yield
    monkeypatch.undo()
    time.tzset()
    D._OFFSET_CACHE.clear()


def test_branche_sqlite_identique_a_avant():
    assert D.local_strftime("%H:00", "created_at", dialect="sqlite") == \
        "strftime('%H:00', datetime(created_at,'unixepoch','localtime'))"
    assert D.local_part_int("%w", "ts", dialect="sqlite") == \
        "CAST(strftime('%w', datetime(ts,'unixepoch','localtime')) AS INTEGER)"
    assert D.local_datetime("ts", dialect="sqlite") == "datetime(ts,'unixepoch','localtime')"
    assert D.utc_strftime("%Y-%m-%d", "ts + ?", dialect="sqlite") == \
        "strftime('%Y-%m-%d', datetime(ts + ?, 'unixepoch'))"


def test_transitions_detectees(paris):
    bornes = [b for b, _ in D._offset_segments(now=ETE_2026 + 30 * 86400)[:-1]]
    assert ETE_2026 in bornes and HIVER_2026 in bornes


@pytest.mark.parametrize("ts", [
    ETE_2026 - 3601, ETE_2026 - 1, ETE_2026, ETE_2026 + 3600,
    HIVER_2026 - 3601, HIVER_2026 - 1, HIVER_2026, HIVER_2026 + 1, HIVER_2026 + 7200,
])
def test_decalage_par_morceaux_egale_localtime(paris, ts):
    """L'expression des moteurs serveur, évaluée ici par SQLite en UTC, doit
    tomber sur la même heure locale que ``'localtime'``."""
    D._offset_segments(now=ETE_2026 + 30 * 86400)     # fenêtre couvrant 2026
    c = sqlite3.connect(":memory:")
    attendu = c.execute(
        "SELECT strftime('%Y-%m-%d %H:%M', datetime(?,'unixepoch','localtime'))", (ts,)).fetchone()[0]
    obtenu = c.execute(
        f"SELECT strftime('%Y-%m-%d %H:%M', datetime(x + {D.local_offset_sql('x')},'unixepoch')) "
        "FROM (SELECT ? AS x)", (ts,)).fetchone()[0]
    assert obtenu == attendu


@pytest.mark.parametrize("fmt,pg,my", [
    ("%H:00", "HH24:00", "%H:00"),
    ("%d/%m %Hh", 'DD/MM HH24"h"', "%d/%m %Hh"),
    ("%Y-%m-%d %H:%M:%S", "YYYY-MM-DD HH24:MI:SS", "%Y-%m-%d %H:%i:%s"),
])
def test_formats_traduits(fmt, pg, my):
    assert f"'{pg}'" in D.utc_strftime(fmt, "x", dialect="postgres")
    assert f"'{my}'" in D.utc_strftime(fmt, "x", dialect="mysql")


def test_format_refuse_une_directive_inconnue():
    with pytest.raises(ValueError):
        D.local_strftime("%j", "ts")
    with pytest.raises(ValueError):
        D.local_strftime("%H' OR 1=1 --", "ts")
