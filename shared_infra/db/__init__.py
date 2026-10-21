# SPDX-License-Identifier: MIT
"""shared_infra/db — couche SQLite et PostgreSQL : pool, ``init_db``, schéma de référence, migrations, transfert entre moteurs."""

# ``_connection`` porte ``db``, ``db_conn``, ``init_db``, ``log_metric``… que
# tout le dépôt importe via cette façade. Alias ``_legacy`` conservé.
from typing import TYPE_CHECKING

from shared_infra.db import _connection as _legacy  # noqa: F401 — cœur SQLite

if TYPE_CHECKING:          # le ré-export dynamique ci-dessous, vu du typage
    from shared_infra.db._connection import *  # noqa: F403

_SUBMODULES = (_legacy,)

# Ré-export fidèle : les noms préfixés d'un underscore sont inclus
# DÉLIBÉRÉMENT (un appelant historique doit continuer de marcher).
for _mod in _SUBMODULES:
    for _name in dir(_mod):
        if _name.startswith("__"):
            continue
        globals()[_name] = getattr(_mod, _name)

try:
    del _mod, _name
except NameError:
    pass
