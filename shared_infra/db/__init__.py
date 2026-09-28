# SPDX-License-Identifier: MIT
"""
shared_infra.db — la couche SQLite, et rien d'autre.

Depuis le rangement par famille (2026-09-04), ce paquet ne porte plus les
magasins métier : chaque famille range le sien avec son sujet
(``accounts/users.py``, ``chat/store.py``, ``mcp/servers.py``…). Il ne reste
ici que ce qui n'appartient à personne :

    _connection.py   le pool de connexions par thread, les PRAGMA, ``init_db``
                     et le schéma. ``db()`` est appelé depuis ~241 endroits,
                     au moins deux fois par requête authentifiée mutante et
                     une fois par appel d'outil dans la boucle du harnais.
    _migrations/     la chaîne ORDONNÉE des migrations, découverte par nom de
                     fichier et rejouée dans l'ordre. Une migration parle
                     souvent d'une famille (``0010_mcp_shared_servers``) mais
                     appartient à la SÉQUENCE : la déplacer la casserait.

  L'alias ``_legacy`` reste exporté : ``_connection.py`` s'appelait ainsi, et
  la surface d'import publique ne doit pas bouger (audit 2026-08-30, A4).
"""

# ``_connection`` porte ``db``, ``db_conn``, ``init_db``, ``log_metric``… que
# tout le dépôt importe via cette façade. Alias ``_legacy`` conservé.
from shared_infra.db import _connection as _legacy    # noqa: F401 — cœur SQLite

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
