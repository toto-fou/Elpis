# SPDX-License-Identifier: MIT
"""
shared_infra.scheduling.routes_cron — validation d'expression cron PARTAGÉE.

Source de vérité unique pour valider un cron 5 champs, en miroir EXACT du
matcher ``_events_bus._cron_matches`` (qui n'échoue jamais : sur un motif
illisible — token non numérique, valeur hors plage, ``*/0``, plage inversée —
il renvoie simplement False, produisant une tâche « activée » mais qui ne se
déclenche JAMAIS). Routines ET Scénarios valident via ce module pour garantir
la même rigueur (avant, les scénarios n'avaient qu'un contrôle structurel et
laissaient passer « 99 * * * * » → badge « Planifié » muet à jamais).
"""
from __future__ import annotations

from fastapi import HTTPException

# Bornes par champ, dans l'ordre attendu par ``_cron_matches`` :
# minute, heure, jour-du-mois, mois, jour-de-semaine (lun=1 … dim=7, car
# ``_cron_matches`` compare à ``now.weekday() + 1``).
_CRON_FIELD_BOUNDS = (
    ("minute", 0, 59),
    ("heure", 0, 23),
    ("jour du mois", 1, 31),
    ("mois", 1, 12),
    ("jour de semaine", 1, 7),
)


def _validate_cron_field(token: str, lo: int, hi: int, field: str) -> None:
    """Valide UN champ cron en miroir exact de la logique de ``_cron_matches``,
    en respectant la même précédence de branches (``/`` puis ``-`` puis ``,``
    puis entier nu). Lève HTTPException(400) sur tout motif que le matcher
    rejetterait silencieusement."""
    if token == "*":
        return

    def _int(s: str) -> int:
        s = s.strip()
        if not s or not (s.isdigit() or (s[0] == "-" and s[1:].isdigit())):
            raise HTTPException(400, f"Champ cron « {field} » invalide : « {token} »")
        return int(s)

    def _check_range(v: int) -> None:
        if not (lo <= v <= hi):
            raise HTTPException(
                400, f"Champ cron « {field} » hors plage [{lo}-{hi}] : {v}"
            )

    if "/" in token:
        base, _, step_s = token.partition("/")
        step = _int(step_s)
        if step < 1:
            raise HTTPException(
                400, f"Champ cron « {field} » : pas (step) doit être ≥ 1"
            )
        # ``_cron_matches`` ignore la base d'un step (``*/n`` ou ``5/n`` traités
        # pareil : seul ``val % step`` compte). On tolère ``*`` ou un entier
        # borné en base pour ne pas accepter ``foo/2``.
        if base != "*":
            _check_range(_int(base))
    elif "-" in token:
        a_s, _, b_s = token.partition("-")
        a, b = _int(a_s), _int(b_s)
        _check_range(a)
        _check_range(b)
        if a > b:
            raise HTTPException(
                400, f"Champ cron « {field} » : plage inversée {a}-{b}"
            )
    elif "," in token:
        items = [p for p in token.split(",")]
        if any(p == "" for p in items):
            raise HTTPException(400, f"Champ cron « {field} » : liste malformée")
        for p in items:
            _check_range(_int(p))
    else:
        _check_range(_int(token))


def validate_cron(expr: str) -> str:
    """Valide une expression cron 5 champs (compatible ``_cron_matches``).
    Lève HTTPException(400) si invalide. Retourne l'expression normalisée."""
    expr = (expr or "").strip()
    parts = expr.split()
    if len(parts) != 5:
        raise HTTPException(400, "Expression cron invalide (5 champs requis : min heure jour mois jour-semaine)")
    for token, (field, lo, hi) in zip(parts, _CRON_FIELD_BOUNDS):
        _validate_cron_field(token, lo, hi, field)
    return expr
