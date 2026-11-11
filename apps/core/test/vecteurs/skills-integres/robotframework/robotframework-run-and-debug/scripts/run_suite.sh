#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# run_suite.sh — lance une suite Robot Framework avec rapports propres,
# et (optionnel) relance uniquement les échecs puis fusionne les rapports.
#
# Usage : bash run_suite.sh <SUITE> [options robot passées telles quelles]
#   SUITE                 fichier .robot ou dossier de suites
#   options typiques      -i smoke   -e wip   -v URL_BASE:http://localhost:8080
#
# Env :
#   RESULTS_DIR   dossier de sortie (défaut : results)
#   RERUN_FAILED  1 = relancer les échecs puis fusionner via rebot --merge
#
# Sortie : exit 0 si le rapport FINAL (fusionné le cas échéant) est tout vert.
set -euo pipefail

command -v robot >/dev/null || { echo "robot introuvable (pip install robotframework)" >&2; exit 2; }
[ $# -ge 1 ] || { echo "usage: $0 <SUITE> [options robot]" >&2; exit 2; }

SUITE="$1"; shift
RESULTS_DIR="${RESULTS_DIR:-results}"
mkdir -p "$RESULTS_DIR"

# 1) Première passe — output nommé pour pouvoir relancer les échecs ensuite.
set +e
robot -d "$RESULTS_DIR" --output original.xml "$@" "$SUITE"
RC1=$?
set -e
[ $RC1 -eq 0 ] && { echo "OK : tout vert ($RESULTS_DIR/report.html)"; exit 0; }

if [ "${RERUN_FAILED:-0}" != "1" ]; then
  echo "échecs : $RC1 cas rouges — détails dans $RESULTS_DIR/log.html" >&2
  exit 1
fi

# 2) Relance des seuls cas en échec (output séparé : ne pas écraser la passe 1).
echo "relance des échecs…"
set +e
robot -d "$RESULTS_DIR" --rerunfailed "$RESULTS_DIR/original.xml" \
      --output rerun.xml "$@" "$SUITE"
set -e

# 3) Fusion : le verdict final remplace les cas relancés dans le rapport.
rebot -d "$RESULTS_DIR" --merge "$RESULTS_DIR/original.xml" "$RESULTS_DIR/rerun.xml"
RC=$?
[ $RC -eq 0 ] && echo "OK après relance : $RESULTS_DIR/report.html" \
              || echo "toujours rouge après relance ($RC cas) : $RESULTS_DIR/log.html" >&2
exit $RC
