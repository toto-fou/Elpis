#!/bin/sh
# SPDX-License-Identifier: MIT
# sandbox-agent/demarrage.sh — démarrage du conteneur d'un compte : filtre réseau selon ELPIS_NET_MODE (liste blanche, ou plages refusées d'un profil ouvert), puis abandon des privilèges et commande.
set -euf
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
# Étape root sous un environnement propre : seuls PATH et les variables du filtre passent (une variable de l'image ou de l'administrateur ne détourne ni iptables ni ses bibliothèques).
if [ "${1:-}" != "--environnement-propre" ]; then
    exec env -i PATH="$PATH" ELPIS_NET_MODE="${ELPIS_NET_MODE:-}" ELPIS_ALLOWLIST="${ELPIS_ALLOWLIST:-}" \
        ELPIS_ALLOWLIST_PORTS="${ELPIS_ALLOWLIST_PORTS:-}" ELPIS_DNS="${ELPIS_DNS:-}" ELPIS_BLOCKED="${ELPIS_BLOCKED:-}" \
        /bin/sh "$0" --environnement-propre "$@"
fi
shift

log() { printf '[demarrage] %s\n' "$*" >&2; }

# Adresse IPv4 ou réseau IPv4 à préfixe décimal, octets sans zéro de tête : toute autre entrée est ignorée.
ipv4() {
    case "$1" in ''|*[!0-9./]*|*/*/*) return 1 ;; esac
    case "$1" in
        */*) case "${1#*/}" in ''|*[!0-9]*|???*) return 1 ;; esac; [ "${1#*/}" -le 32 ] || return 1 ;;
    esac
    ifs=$IFS; IFS=.; set -- ${1%%/*}; IFS=$ifs
    [ "$#" -eq 4 ] || return 1
    for o in "$@"; do
        case "$o" in ''|0?*|????*) return 1 ;; esac
        [ "$o" -le 255 ] || return 1
    done
    return 0
}

mode="${ELPIS_NET_MODE:-}"
# Sans mode explicite, une liste non vide vaut liste blanche.
if [ -z "$mode" ] && [ -n "${ELPIS_ALLOWLIST:-}" ]; then mode=allowlist; fi

case "$mode" in
    allowlist|blocklist)
        # Tout refuser d'abord : un échec en cours de route laisse le réseau fermé.
        iptables -P OUTPUT DROP
        v6=1
        if ! ip6tables -P OUTPUT DROP 2>/dev/null; then
            # IPv6 présent mais non filtrable : arrêt ; noyau sans IPv6 : rien à filtrer.
            if [ -e /proc/net/if_inet6 ]; then log "ip6tables indisponible : IPv6 non filtrable"; exit 65; fi
            v6=0
        fi
        # Liste de refus : chaque plage doit se lire, sinon arrêt (une plage ignorée resterait ouverte).
        refus=""
        if [ "$mode" = blocklist ]; then
            for net in ${ELPIS_BLOCKED:-}; do
                if ! ipv4 "$net"; then log "plage refusée illisible : $net"; exit 65; fi
                refus="$refus $net"
            done
            if [ -z "$refus" ]; then log "liste de refus vide"; exit 65; fi
        fi
        # Ports TCP par paquets de 15 (limite de multiport).
        paquets=""; paquet=""; n=0
        for p in $(printf '%s' "${ELPIS_ALLOWLIST_PORTS:-}" | tr ',' ' '); do
            case "$p" in ''|*[!0-9]*|??????*) log "port ignoré : $p"; continue ;; esac
            if [ "$p" -lt 1 ] || [ "$p" -gt 65535 ]; then log "port ignoré : $p"; continue; fi
            paquet="${paquet:+$paquet,}$p"; n=$((n + 1))
            if [ "$n" -eq 15 ]; then paquets="$paquets $paquet"; paquet=""; n=0; fi
        done
        if [ -n "$paquet" ]; then paquets="$paquets $paquet"; fi
        # Des ports demandés dont aucun n'est valide : aucune destination, plutôt que tous les ports.
        destinations="${ELPIS_ALLOWLIST:-}"
        if [ -n "${ELPIS_ALLOWLIST_PORTS:-}" ] && [ -z "$paquets" ]; then
            log "aucun port valide : aucune destination ouverte"
            destinations=""
        fi
        # Règles posées en une fois : tout ou rien.
        {
            echo '*filter'
            echo ':INPUT ACCEPT [0:0]'
            echo ':FORWARD ACCEPT [0:0]'
            echo ':OUTPUT DROP [0:0]'
            echo '-A OUTPUT -o lo -j ACCEPT'
            echo '-A OUTPUT -m state --state RELATED,ESTABLISHED -j ACCEPT'
            for ip in ${ELPIS_DNS:-}; do
                if ! ipv4 "$ip"; then log "résolveur ignoré : $ip"; continue; fi
                echo "-A OUTPUT -d $ip -p udp --dport 53 -j ACCEPT"
                echo "-A OUTPUT -d $ip -p tcp --dport 53 -j ACCEPT"
            done
            if [ "$mode" = blocklist ]; then
                for net in $refus; do echo "-A OUTPUT -d $net -j REJECT --reject-with icmp-host-unreachable"; done
                echo '-A OUTPUT -j ACCEPT'
            else
                for ip in $destinations; do
                    if ! ipv4 "$ip"; then log "destination ignorée : $ip"; continue; fi
                    if [ -n "$paquets" ]; then
                        for q in $paquets; do echo "-A OUTPUT -d $ip -p tcp -m multiport --dports $q -j ACCEPT"; done
                    else
                        echo "-A OUTPUT -d $ip -j ACCEPT"
                    fi
                done
                echo '-A OUTPUT -j REJECT --reject-with icmp-host-unreachable'
            fi
            echo 'COMMIT'
        } | iptables-restore
        if [ "$v6" -eq 1 ]; then
            ip6tables -A OUTPUT -o lo -j ACCEPT
            ip6tables -A OUTPUT -m state --state RELATED,ESTABLISHED -j ACCEPT
            ip6tables -A OUTPUT -j REJECT --reject-with icmp6-adm-prohibited
        fi
        if [ "$mode" = blocklist ]; then log "protections appliquées"; else log "liste blanche appliquée"; fi
        ;;
    ''|open)
        log "réseau du profil, sans filtre"
        ;;
    *)
        log "mode réseau inconnu : $mode"
        exit 64
        ;;
esac

# Dossiers du compte créés sous son UID : root ne suit aucun lien posé dans /work ; la commande écrit dans /dev/null, pas dans le journal du conteneur.
exec setpriv --reuid=10001 --regid=10001 --clear-groups --bounding-set=-net_admin -- \
    /bin/sh -c 'mkdir -p /work/.python-user /work/.local/bin /work/.npm-global 2>/dev/null; exec "$@" >/dev/null 2>&1' demarrage "$@"
