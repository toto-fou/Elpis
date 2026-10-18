# SPDX-License-Identifier: MIT
# deploy/prerequis-apt.sh — lit deploy/prerequis-apt.txt et y cherche les paquets absents par dpkg-query ; sourcé par install.sh et elpis.

PREREQUIS_APT="${PREREQUIS_APT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/prerequis-apt.txt}"

# Groupes du fichier, dans l'ordre.
prerequis_groupes() { awk '/^# /{ print $2 }' "$PREREQUIS_APT"; }

# Debian 13 : les noms du fichier valent tels quels ; ailleurs, seul le socle est portable (docker-cli et les paquets t64 sont propres à Debian 13).
prerequis_debian13() { ( . "${PREREQUIS_OS_RELEASE:-/etc/os-release}" 2>/dev/null && [ "${ID:-}" = debian ] && [ "${VERSION_ID:-}" = 13 ] ); }

# Rôle d'un groupe : le texte de son en-tête après « — ».
prerequis_role() { awk -v g="$1" '/^# / && $2 == g { sub(/^# [^ ]+ — /, ""); print; exit }' "$PREREQUIS_APT"; }

# Lignes de paquets des groupes donnés (« a | b » pour des alternatives), dans l'ordre du fichier, sans doublon.
prerequis_lignes() {
    awk -v groupes=" $* " '
        /^##/ || /^[[:space:]]*$/ { next }
        /^# / { g = $2; next }
        index(groupes, " " g " ") { gsub(/^[[:space:]]+|[[:space:]]+$/, ""); gsub(/[[:space:]]*[|][[:space:]]*/, " | "); if (!vu[$0]++) print }
    ' "$PREREQUIS_APT"
}

# Lignes des groupes donnés dont aucune alternative n'est installée.
prerequis_manquants() {
    local lignes=() noms=() parts=() l a ok installes
    mapfile -t lignes < <(prerequis_lignes "$@")
    [ "${#lignes[@]}" -gt 0 ] || return 0
    for l in "${lignes[@]}"; do read -ra parts <<< "${l//|/ }"; noms+=("${parts[@]}"); done
    installes=" $(dpkg-query -W -f='${Package}\t${db:Status-Status}\n' "${noms[@]}" 2>/dev/null \
        | awk -F'\t' '$2 == "installed" { printf "%s ", $1 }')"
    for l in "${lignes[@]}"; do
        ok=0
        read -ra parts <<< "${l//|/ }"
        for a in "${parts[@]}"; do case "$installes" in *" $a "*) ok=1; break ;; esac; done
        [ "$ok" -eq 1 ] || printf '%s\n' "$l"
    done
}

# « a | b » → « a (ou b) », pour les messages.
prerequis_libelle() { local l="${1// | / ou }"; [ "$l" = "$1" ] && echo "$1" || echo "${1%% *} (ou ${l#* ou })"; }

# Commande apt qui installe les lignes données : la première alternative de chacune.
prerequis_commande() {
    local l cmd="sudo apt install --no-install-recommends"
    for l in "$@"; do cmd+=" ${l%% *}"; done
    echo "$cmd"
}
