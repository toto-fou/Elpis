#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# profile_hotspots.sh — profile un script Python avec cProfile et affiche le
# top des fonctions les plus coûteuses. Le profil brut est conservé pour une
# analyse fine ultérieure (pstats, snakeviz…).
#
# Usage : bash profile_hotspots.sh <SCRIPT.py> [-- args du script...]
#
# Env :
#   TOP    nombre de lignes affichées         (défaut : 20)
#   SORT   cumulative | tottime | ncalls      (défaut : cumulative)
#   OUT    fichier de profil brut             (défaut : profile.out)
#
# Lecture : en `cumulative`, la première fonction DE VOTRE code dans le top
# est presque toujours le point à optimiser ; `tottime` montre qui brûle
# réellement le CPU (temps propre, sans les appels internes).
set -euo pipefail

command -v python3 >/dev/null || { echo "python3 introuvable" >&2; exit 2; }
[ $# -ge 1 ] || { echo "usage: $0 <SCRIPT.py> [-- args...]" >&2; exit 2; }

SCRIPT="$1"; shift
[ "${1:-}" = "--" ] && shift
[ -f "$SCRIPT" ] || { echo "script introuvable : $SCRIPT" >&2; exit 2; }

TOP="${TOP:-20}"
SORT="${SORT:-cumulative}"
OUT="${OUT:-profile.out}"

echo "── profiling de $SCRIPT (tri : $SORT) ──"
python3 -m cProfile -o "$OUT" "$SCRIPT" "$@"

python3 - "$OUT" "$SORT" "$TOP" <<'PYEOF'
import sys
import pstats

out, sort, top = sys.argv[1], sys.argv[2], int(sys.argv[3])
st = pstats.Stats(out)
st.sort_stats(sort).print_stats(top)
print(f"profil brut conservé : {out}")
print("analyse fine :  python3 -c \"import pstats; "
      f"pstats.Stats('{out}').sort_stats('tottime').print_callers(10)\"")
PYEOF
