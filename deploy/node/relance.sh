#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# deploy/node/relance.sh — lance une commande du core et la relance quand elle sort avec le code de redémarrage (75), sinon rend son code.
set -u

CODE_REDEMARRAGE=75
PAUSE_RELANCE="${ELPIS_PAUSE_RELANCE:-1}"
[ "$#" -gt 0 ] || { echo "usage : relance.sh COMMANDE [ARGUMENT…]" >&2; exit 2; }

fils=""; arret=0; interrompu=0

# Transmet le signal reçu au fils, une seule fois (HUP au core seul, TERM et INT à son groupe) ; TERM et INT empêchent toute relance.
transmettre() {
    interrompu=1
    [ "$1" = HUP ] || arret=1
    [ -n "$fils" ] || return 0
    if [ "$1" = HUP ]; then kill -s HUP "$fils" 2>/dev/null || true; return 0; fi
    kill -s "$1" -- "-$fils" 2>/dev/null || kill -s "$1" "$fils" 2>/dev/null || true
}
trap 'transmettre TERM' TERM
trap 'transmettre INT' INT
trap 'transmettre HUP' HUP

# Si le lanceur meurt de force (SIGKILL), le core reçoit SIGTERM au lieu de rester orphelin.
mort_du_pere=()
command -v setpriv >/dev/null 2>&1 && mort_du_pere=(setpriv --pdeathsig TERM)

rc=0
while [ "$arret" -eq 0 ]; do
    # Le fils a son propre groupe : le signal de groupe adressé au lanceur ne l'atteint qu'une fois, par transmettre.
    ( exec setsid ${mort_du_pere[@]+"${mort_du_pere[@]}"} "$@" ) &
    fils=$!
    [ "$arret" -eq 0 ] || transmettre TERM
    while :; do
        interrompu=0
        wait "$fils"; rc=$?
        [ "$interrompu" -eq 1 ] || break
    done
    fils=""
    [ "$rc" -eq "$CODE_REDEMARRAGE" ] && [ "$arret" -eq 0 ] || break
    echo "[relance] $(date '+%F %T') le core demande son redémarrage (code $rc) : relance dans ${PAUSE_RELANCE} s" >&2
    sleep "$PAUSE_RELANCE" & pause=$!
    wait "$pause" 2>/dev/null || true
    kill "$pause" 2>/dev/null || true
done
[ "$arret" -eq 1 ] && [ "$rc" -eq "$CODE_REDEMARRAGE" ] && rc=0
echo "[relance] $(date '+%F %T') le core s'est arrêté (code $rc, arrêt demandé : $arret) : pas de relance" >&2
exit "$rc"
