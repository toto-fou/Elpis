# SPDX-License-Identifier: MIT
"""Fin de l'élargissement des droits (L4.6) : un seul UID écrit dans /work —
modes gardés à la réécriture, 0644 pour un fichier neuf, ``chmod +x`` sans
bit d'écriture ajouté."""
from llm_core.tools import fs_tools


def test_mode_ecrit_garde_le_mode():
    assert fs_tools._mode_ecrit({"kind": "missing"}) is None      # défaut de l'agent : 0644
    assert fs_tools._mode_ecrit({"kind": "file", "mode": 0o600}) == "600"
    assert fs_tools._mode_ecrit({"kind": "file", "mode": 0o755}) == "755"


def test_executable_mode_comme_chmod_plus_x():
    assert fs_tools._executable_mode(0o644) & 0o777 == 0o755
    assert fs_tools._executable_mode(0o600) & 0o777 == 0o711
