# SPDX-License-Identifier: MIT
"""llm_core/tools/_office/ops.py — lecture tolérante d'une liste d'opérations (``docx_edit`` / ``pptx_edit``).

Chaque opération est un objet ``{"op": "<nom>", …}``. On accepte le nom sous
``op``/``action``/``type``…, ses synonymes (« remplacer », « set_text »…), une
opération seule au lieu d'une liste, du JSON en chaîne ; et, si le nom manque,
on le déduit des champs présents (``find`` + ``replace`` → replace…).
"""
from __future__ import annotations

import json
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

from .._chart.normalise import Notes, fold
from .commun import OfficeError, canon, choisir

CLES_OP = ("op", "action", "type", "operation", "kind", "command", "do", "verb")


def lire_ops(raw: Any, noms: Dict[str, Iterable[str]], champs: Dict[str, Dict[str, Iterable[str]]],
             deduire: Callable[[Dict[str, Any]], Optional[str]], notes: Notes,
             exemple: List[Dict[str, Any]]) -> List[Tuple[str, Dict[str, Any]]]:
    """→ [(nom canonique, champs canoniques)] ; refus guidé si illisible."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
            notes.fix("ops given as a JSON string: parsed")
        except ValueError:
            raise OfficeError("ops must be a list of operation objects, not text",
                              fix='ops = [{"op": "...", ...}, ...]', example=exemple)
    if isinstance(raw, dict):
        if any(fold(k) == "ops" for k in raw):
            raw = next(v for k, v in raw.items() if fold(k) == "ops")
        else:
            raw = [raw]
            notes.fix("a single operation given: read as a list of one")
    if not isinstance(raw, list) or not raw:
        raise OfficeError("ops is empty: nothing to do", code="no_ops",
                          fix="ops = a list of operations, at least one", example=exemple)
    out: List[Tuple[str, Dict[str, Any]]] = []
    for i, op in enumerate(raw):
        if not isinstance(op, dict):
            raise OfficeError(f"ops[{i}] is not an object", fix='each operation is {"op": "...", ...}',
                              example=exemple)
        brut = next((op[k] for k in op if fold(k) in CLES_OP), None)
        reste = {k: v for k, v in op.items() if fold(k) not in CLES_OP}
        nom = choisir(brut, noms, notes, f"ops[{i}].op") if brut is not None else None
        if nom is None and brut is None:
            nom = deduire({fold(k): v for k, v in reste.items()})
            if nom:
                notes.fix(f"ops[{i}]: no 'op' given, read as '{nom}' from its fields")
        if nom is None:
            raise OfficeError(
                f"ops[{i}]: unknown operation '{brut}'" if brut is not None
                else f"ops[{i}]: missing 'op'",
                fix=f"op is one of: {', '.join(noms)}", example=exemple, code="unknown_op")
        out.append((nom, canon(reste, champs.get(nom, {}), notes, f"ops[{i}].")))
    return out


def requis(i: int, nom: str, champs: Dict[str, Any], cle: str, exemple: Dict[str, Any]) -> Any:
    v = champs.get(cle)
    if v is None or v == "" or v == []:
        raise OfficeError(f"ops[{i}] ({nom}): '{cle}' is required", fix=f"add '{cle}'",
                          example=[exemple], code="invalid_op")
    return v
