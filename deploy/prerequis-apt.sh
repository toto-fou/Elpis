# SPDX-License-Identifier: MIT
# deploy/prerequis-apt.sh — lit deploy/prerequis-apt.txt, y cherche les paquets absents (dpkg-query) et ceux que proposent les dépôts (apt-cache) ; sourcé par install.sh et elpis.

PREREQUIS_APT="${PREREQUIS_APT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/prerequis-apt.txt}"

# Groupes du fichier, dans l'ordre.
prerequis_groupes() { awk '/^# /{ print $2 }' "$PREREQUIS_APT"; }

# Systèmes dont le fichier connaît les noms (Debian 12 et 13, Ubuntu 24.04) ; ailleurs, seul le socle est portable.
prerequis_os_connu() {
    ( . "${PREREQUIS_OS_RELEASE:-/etc/os-release}" 2>/dev/null
      case "${ID:-}:${VERSION_ID:-}" in debian:12|debian:13|ubuntu:24.04) exit 0 ;; *) exit 1 ;; esac )
}

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

# Paquet à installer pour chaque ligne donnée : la première alternative que proposent les dépôts apt, « !ligne » si aucune.
prerequis_choix() {
    local noms=() parts=() l a choisi dispo
    for l in "$@"; do read -ra parts <<< "${l//|/ }"; noms+=("${parts[@]}"); done
    [ "${#noms[@]}" -gt 0 ] || return 0
    dispo=" $(LC_ALL=C apt-cache policy "${noms[@]}" 2>/dev/null \
        | awk '/^[^ ].*:$/ { p = substr($0, 1, length($0) - 1) } /^  Candidate:/ && $2 != "(none)" { printf "%s ", p }')"
    for l in "$@"; do
        choisi="!$l"
        read -ra parts <<< "${l//|/ }"
        for a in "${parts[@]}"; do case "$dispo" in *" $a "*) choisi="$a"; break ;; esac; done
        printf '%s\n' "$choisi"
    done
}

# Commande apt qui installe les lignes données : l'alternative que proposent les dépôts, sinon la première (sans sudo en root).
prerequis_commande() {
    local c cmd="sudo apt install --no-install-recommends" vus=" "
    [ "$(id -u)" -ne 0 ] || cmd="${cmd#sudo }"
    while IFS= read -r c; do
        case "$c" in "!"*) c="${c#!}"; c="${c%% *}" ;; esac
        case "$vus" in *" $c "*) ;; *) vus+="$c "; cmd+=" $c" ;; esac
    done < <(prerequis_choix "$@")
    echo "$cmd"
}
