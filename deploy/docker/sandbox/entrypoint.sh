#!/bin/sh
# SPDX-License-Identifier: MIT
# entrypoint.sh — Entrypoint du container elpis/sandbox
#
# Phase 1 (ROOT, brèves millisecondes) :
#   Si la variable ELPIS_ALLOWLIST contient des IPs/CIDRs, on configure
#   iptables OUTPUT pour ne laisser passer QUE ces destinations.
#
# Phase 2 :
#   On bascule en UID 10001 (non-root) via setpriv et on exec le CMD.
#
# Note sécurité (vs 1.1.1)
# ------------------------
#   L'image 1.2.0 est volontairement plus permissive : l'user 10001 a
#   `sudo` NOPASSWD et le container ne tourne plus en --read-only ni en
#   no-new-privileges (cf. _user_sandbox.py). Concrètement, à l'intérieur
#   de SON container, l'user/le LLM peut tout faire (chmod +x, apt, pip
#   système, lancer un service…). L'isolation qui compte reste en place :
#     - pas de socket Docker monté (pas d'évasion DinD),
#     - seccomp + AppArmor par défaut de Docker actifs,
#     - 1 container par user, volume /work cloisonné,
#     - réseau coupé sauf profil explicite,
#     - limites mémoire / CPU / PIDs.
#   iptables est figé après le drop : on retire explicitement net_admin
#   du BOUNDING SET via ``setpriv --bounding-set=-net_admin`` (voir plus
#   bas). Sans ce retrait, l'user — qui a sudo NOPASSWD — pouvait faire
#   ``sudo iptables -F`` (root réacquiert les caps du bounding set) et casser
#   l'allowlist. Une fois net_admin hors du bounding set, même root ne peut
#   plus modifier le netfilter du netns. (cf. audit CRIT-2)
#
# Variables d'environnement attendues (optionnelles) :
#   ELPIS_ALLOWLIST       - liste d'IPs/CIDRs séparés par espaces.
#                           Ex: "10.1.2.3 10.0.0.0/24"
#   ELPIS_ALLOWLIST_PORTS - liste de ports TCP séparés par virgules
#                           (ex "443,80"). Si non vide, chaque entrée de
#                           l'allowlist n'est ACCEPTée QUE sur ces dports
#                           TCP (au lieu de tous ports/protocoles).
#   ELPIS_DNS             - IPs de résolveurs séparées par espaces :
#                           ACCEPTées sur 53/udp+tcp quelle que soit la
#                           restriction de ports (le host passe aussi
#                           --dns au conteneur).
#   ELPIS_DEBUG           - si "1", trace les commandes iptables sur stdout
#

set -eu

log() { printf '[entrypoint] %s\n' "$*" >&2; }

# ─── Configuration iptables ──────────────────────────────────────────
ELPIS_DEBUG="${ELPIS_DEBUG:-0}"

if [ -n "${ELPIS_ALLOWLIST:-}" ]; then
    log "Allowlist détectée : $ELPIS_ALLOWLIST"

    if ! command -v iptables >/dev/null 2>&1; then
        log "ERREUR : iptables non installé dans l'image"
        exit 64
    fi

    # Test rapide que iptables fonctionne (cap NET_ADMIN OK ?)
    if ! iptables -L OUTPUT -n >/dev/null 2>&1; then
        log "ERREUR : iptables refuse de tourner. Le container manque --cap-add=NET_ADMIN ?"
        exit 65
    fi

    [ "${ELPIS_DEBUG:-0}" = "1" ] && set -x

    # Loopback OK (sinon des trucs comme curl localhost cassent)
    iptables -A OUTPUT -o lo -j ACCEPT

    # Connexions retour (RELATED, ESTABLISHED)
    iptables -A OUTPUT -m state --state RELATED,ESTABLISHED -j ACCEPT

    # Résolveurs DNS explicites : port 53 uniquement, AVANT la boucle
    # allowlist (indépendant de la restriction de ports ci-dessous).
    for ip in ${ELPIS_DNS:-}; do
        case "$ip" in
            -*|*\;*|*\&*|*\|*)
                log "AVERTISSEMENT : entrée DNS suspecte ignorée : $ip"
                continue ;;
        esac
        iptables -A OUTPUT -d "$ip" -p udp --dport 53 -j ACCEPT
        iptables -A OUTPUT -d "$ip" -p tcp --dport 53 -j ACCEPT
    done

    # Restriction de ports TCP optionnelle (ELPIS_ALLOWLIST_PORTS, csv).
    # Tokens non numériques ignorés avec warning (défense en profondeur —
    # le host valide déjà 1..65535 côté admin).
    ports=""
    if [ -n "${ELPIS_ALLOWLIST_PORTS:-}" ]; then
        for p in $(printf '%s' "$ELPIS_ALLOWLIST_PORTS" | tr ',' ' '); do
            case "$p" in
                ''|*[!0-9]*)
                    log "AVERTISSEMENT : port suspect ignoré : $p"
                    continue ;;
            esac
            ports="$ports $p"
        done
    fi

    # ACCEPT pour chaque IP/CIDR de l'allowlist — tous ports/protocoles par
    # défaut, restreint aux dports TCP listés si $ports est non vide.
    count=0
    for ip in $ELPIS_ALLOWLIST; do
        case "$ip" in
            -*|*\;*|*\&*|*\|*)
                log "AVERTISSEMENT : entrée allowlist suspecte ignorée : $ip"
                continue ;;
        esac
        if [ -n "$ports" ]; then
            for p in $ports; do
                iptables -A OUTPUT -d "$ip" -p tcp --dport "$p" -j ACCEPT
            done
        else
            iptables -A OUTPUT -d "$ip" -j ACCEPT
        fi
        count=$((count + 1))
    done
    [ -n "$ports" ] && log "Restriction ports TCP :$ports"

    # REJECT (avec icmp host-unreachable pour clarté côté app)
    iptables -A OUTPUT -j REJECT --reject-with icmp-host-unreachable

    # ─── IPv6 : tout bloquer sauf loopback/established ────────────────
    # L'allowlist est strictement IPv4/CIDR. Sans règles ip6tables, tout le
    # trafic IPv6 sortait SANS filtre (bridge Docker IPv6, resolver AAAA…) →
    # contournement complet de l'allowlist (audit CRIT-3). On REJECT donc
    # tout l'egress IPv6 par défaut. (Pour autoriser de l'IPv6, il faudrait
    # étendre ELPIS_ALLOWLIST + ces règles — non supporté pour l'instant.)
    if command -v ip6tables >/dev/null 2>&1 && ip6tables -L OUTPUT -n >/dev/null 2>&1; then
        ip6tables -A OUTPUT -o lo -j ACCEPT
        ip6tables -A OUTPUT -m state --state RELATED,ESTABLISHED -j ACCEPT
        ip6tables -A OUTPUT -j REJECT --reject-with icmp6-adm-prohibited
        log "IPv6 egress bloqué (allowlist IPv4 uniquement)"
    else
        log "AVERTISSEMENT : ip6tables indisponible — IPv6 non filtré"
    fi

    set +x
    log "Allowlist appliquée : $count IP(s) autorisée(s)"
else
    log "Pas d'allowlist (ELPIS_ALLOWLIST vide) — réseau tel quel"
fi

# ─── Préparation du HOME persistant ──────────────────────────────────
# /work est le volume monté. On garantit que le user-site pip y existe
# (PYTHONUSERBASE=/work/.python-user) pour qu'un `pip install --user`
# fait par l'user survive aux recréations de container.
#
# IMPORTANT — ownership et perms :
# Le volume /work est partagé avec le host (process app) qui peut écrire
# avec un UID différent de 10001 (typiquement le user `elpis` côté host).
# Si on ne fait rien, les fichiers créés côté host arrivent en 0644 owned
# par le host UID → le container ne peut pas les modifier. À l'inverse,
# les fichiers créés côté container arrivent en 0644 owned par 10001 →
# le host ne peut pas les modifier non plus.
#
# Notre stratégie cross-UID :
#   1. chown -R 10001:10001 /work au boot (best-effort — peut échouer
#      sur des fichiers root-owned hérités, on continue quand même).
#   2. chmod 0777 sur /work lui-même → n'importe quel UID peut créer.
#   3. umask 0002 dans /etc/profile + /etc/bash.bashrc → les shells
#      interactifs lancés via `docker exec sh -c "..."` héritent (l'app
#      wrap aussi chaque exec avec un `umask 0002` explicite, en
#      ceinture-et-bretelles).
#   4. fs_tools côté host chmod 0666/0777 chaque fichier/dir qu'il écrit.
# Résultat : volume pleinement cross-writable dans les deux sens.
mkdir -p /work/.python-user /work/.local/bin /work/.npm-global 2>/dev/null || true

# Best-effort chown : si /work contient des centaines de Mo le -R peut
# prendre quelques secondes — c'est OK, c'est au boot du container et
# c'est amorti par le `sleep infinity`.
chown -R 10001:10001 /work 2>/dev/null || true
chmod 0777 /work 2>/dev/null || true

# Umask permissif pour tous les shells lancés via `docker exec`.
# /etc/profile est lu par `sh -l`, /etc/bash.bashrc par bash interactif.
# L'app force déjà `umask 0002` autour de chaque exec ; ceci couvre les
# cas où un utilisateur ouvre un PTY directement (Terminal panel).
if ! grep -q '^umask 0002' /etc/profile 2>/dev/null; then
    echo 'umask 0002' >> /etc/profile
fi
if [ -f /etc/bash.bashrc ] && ! grep -q '^umask 0002' /etc/bash.bashrc; then
    echo 'umask 0002' >> /etc/bash.bashrc
fi

# ─── Drop privilèges et exec CMD ─────────────────────────────────────
# On bascule en UID 10001. L'user garde `sudo` (NOPASSWD) s'il a besoin
# de repasser root ponctuellement dans le container.
#
# SÉCURITÉ (audit CRIT-2) : on RETIRE cap_net_admin du bounding set. Sans ça,
# comme le container reçoit --cap-add=NET_ADMIN (mode allowlist_ip) et que
# l'user a sudo NOPASSWD, un simple ``sudo iptables -F OUTPUT`` regagnait
# NET_ADMIN (root réacquiert les caps du bounding set) et effaçait l'allowlist.
# En le retirant du bounding set, MÊME root (via sudo) ne peut plus toucher au
# netfilter → l'allowlist devient inviolable depuis l'intérieur. On garde
# sudo et les autres caps (modèle « permissif dans le container » voulu), et
# net_raw reste présent pour que ``ping`` fonctionne vers les IPs autorisées.
# Retirer une cap absente du bounding set (modes none/bridge) est sans effet.
log "Drop privilege → UID 10001 (sudo NOPASSWD, sans net_admin)"
umask 0002
# NB: setpriv (util-linux) attend les noms de capability SANS préfixe « cap_ »
# (``net_admin``, pas ``cap_net_admin`` — ce dernier donne « unknown capability »).
exec setpriv --reuid=10001 --regid=10001 --init-groups \
     --bounding-set=-net_admin -- "$@"
