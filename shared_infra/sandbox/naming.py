# SPDX-License-Identifier: MIT
"""shared_infra.sandbox.naming — noms et étiquettes Docker des conteneurs utilisateur.

Source unique du préfixe des conteneurs (``elpis-sb-<user>``) et de l'espace
de noms de leurs étiquettes (``elpis.user_id``, ``elpis.username``,
``elpis.netcfg``).
"""
from __future__ import annotations

from typing import List, Optional

CONTAINER_PREFIX = "elpis-sb-"
LABEL_NS = "elpis"


def container_name(username: str) -> str:
    """Nom du conteneur d'un utilisateur (username déjà canonisé)."""
    return f"{CONTAINER_PREFIX}{username}"


def label(key: str, value: Optional[object] = None) -> str:
    """``elpis.<key>`` ou ``elpis.<key>=<value>`` (étiquettes posées à la création)."""
    return f"{LABEL_NS}.{key}" if value is None else f"{LABEL_NS}.{key}={value}"


def label_filter(key: str, value: Optional[object] = None) -> List[str]:
    """Arguments ``--filter label=elpis.<key>[=<value>]`` d'un ``docker ps``."""
    return ["--filter", f"label={label(key, value)}"]


def label_tpl(key: str, *, ps: bool = False) -> str:
    """Gabarit Go qui lit l'étiquette ``elpis.<key>``.

    ``ps=True`` : syntaxe de ``docker ps --format`` (``.Label``) ; sinon celle
    de ``docker inspect --format`` (``.Config.Labels``)."""
    if ps:
        return f'{{{{.Label "{LABEL_NS}.{key}"}}}}'
    return f'{{{{index .Config.Labels "{LABEL_NS}.{key}"}}}}'
