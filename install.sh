#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# =============================================================================
#  install.sh — installe et configure Elpis, en une commande
# =============================================================================
#
#  Cible : Debian 12/13 ou Ubuntu 24.04. À lancer depuis le compte qui fera
#  tourner l'application (sudo est demandé dès le départ, une seule fois), ou
#  par « sudo ./install.sh » : les étapes système tournent alors en root et
#  l'application sous le compte qui a lancé sudo — jamais en root.
#  Idempotent : relancer le script ne refait que ce qui manque.
#
#  Sans option, un ASSISTANT par pages pose toutes les questions d'abord
#  (composants, base de données, LLM, accès, RAG, voix, administrateur),
#  affiche un résumé, puis installe et configure sans autre question. Une
#  réponse désactive les saisies qu'elle rend inutiles (sans Caddy, pas de
#  HTTPS ; base locale, rien à saisir ; sans droits admin, rien qui en
#  demande). Clavier : ↑↓ Espace Entrée, Tab pour changer de page.
#
#  Étapes :
#    1. prérequis système : les paquets apt de deploy/prerequis-apt.txt
#       (socle, puis les groupes des composants choisis) sont VÉRIFIÉS,
#       jamais installés ici : s'il en manque, le script s'arrête et
#       affiche la commande apt à lancer
#    2. environnement Python (venv/) : requirements*.txt
#    2 bis. core : Node.js 24 dans node/ (l'archive officielle sans npm,
#       npx ni corepack ; sommes et empreinte figées dans deploy/node/node.env)
#       et bundle apps/core/dist (paquet hors ligne, sinon npm ci + npm run
#       build avec le npm de l'archive, gardé le temps de la construction)
#    2 ter. hôte d'outils : bundle apps/toolhost/dist (même source ; depuis
#       les sources, npm ci compile node-pty : build-essential et python3)
#    3. base de données : préparée (serveur local) et TESTÉE avant la suite
#    4. service navigateur : npm ci + Chromium (Playwright), sur le Node.js
#       du core
#    5. Qdrant (base vectorielle du RAG) : binaire officiel, sha256 vérifié
#    6. image sandbox Docker : docker build (ou --pull / --offline)
#    7. facultatif : configuration de Caddy (HTTPS ; son paquet est un
#       prérequis), extras AGPL ; LibreOffice et bubblewrap vérifiés
#    8. configuration (réponses de l'assistant), puis service ou démarrage
#
#  Usage :
#    ./install.sh                     assistant (terminal interactif)
#    ./install.sh --plain             questions en lignes, sans assistant
#    ./install.sh --yes               sans question : réponses par défaut
#                                     (+ options ci-dessous), configure --yes,
#                                     pas de démarrage sauf --start/--service
#    ./install.sh --dry-run           affiche le plan, ne change rien
#
#  Composants (pré-remplissent l'assistant, ou répondent sans lui) :
#    --with-office | --no-office      LibreOffice (aperçus Word/Excel/PowerPoint)
#    --with-caddy  | --no-caddy       frontal HTTPS Caddy
#    --with-agpl   | --no-agpl        extras AGPL (PyMuPDF, pdf2docx)
#    --with-browser | --no-browser    service navigateur (Chromium)
#    --db sqlite|postgres-local|external
#                                     base de données : fichier SQLite (défaut),
#                                     PostgreSQL préparé SUR CETTE MACHINE
#                                     (paquet postgresql : prérequis apt), ou
#                                     serveur PostgreSQL existant
#    --sandbox build|pull|none        image sandbox : construite (défaut),
#                                     tirée d'un registre, ou aucune
#    --pull [IMAGE]                   = --sandbox pull (ELPIS_SANDBOX_PULL_REF)
#    --no-sandbox                     = --sandbox none
#    --offline DIR                    sans réseau, depuis le paquet produit par
#                                     make_release.sh
#    --skip-system                    sans vérifier les paquets apt (autre
#                                     système : deploy/prerequis-apt.txt)
#
#  Après l'installation :
#    --configure | --no-configure     configurer (défaut : oui)
#    --service                        installer les services systemd
#    --start                          démarrer tout de suite (./elpis start)
#    --no-start                       ni l'un ni l'autre
#    Les options de configure passent après « -- » :
#      ./install.sh --yes --service -- --llm-url http://gpu:8080 --admin-user admin
#      ./install.sh --yes --db external -- --db postgres --db-host db.lan
#      ./install.sh --yes -- --listen lan   (HTTP ouvert au réseau ; défaut :
#                                          127.0.0.1, ce serveur seulement)
#      (mots de passe : ELPIS_CFG_ADMIN_PASSWORD, ELPIS_CFG_DB_PASSWORD)
#
#  Journal complet : logs/install.log (les écrans de l'assistant n'y passent
#  pas, les mots de passe non plus).
# =============================================================================
set -uo pipefail
# « su » sans « - » garde le PATH de l'utilisateur, sans /usr/sbin ni /sbin :
# runuser, usermod… y seraient introuvables en root.
for d in /usr/local/sbin /usr/sbin /sbin; do
    case ":$PATH:" in *":$d:"*) ;; *) PATH="$PATH:$d" ;; esac
done
export PATH

ROOT="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
cd "$ROOT"
VENV="$ROOT/venv"
PYBIN="${PYTHON_BIN:-python3}"

# shellcheck source=deploy/qdrant/qdrant.env
. "$ROOT/deploy/qdrant/qdrant.env"
# shellcheck source=deploy/node/node.env
. "$ROOT/deploy/node/node.env"
# shellcheck source=deploy/prerequis-apt.sh
. "$ROOT/deploy/prerequis-apt.sh"

# ── Options ──────────────────────────────────────────────────────────────────
# Vide = pas encore décidé (question posée en mode interactif).
WITH_OFFICE=""; WITH_CADDY=""; WITH_AGPL=""; WITH_BROWSER=""
SANDBOX_MODE=""; DB_MODE=""; DO_SYSTEM=1; OFFLINE_DIR=""; PULL_REF="${ELPIS_SANDBOX_PULL_REF:-}"
ASSUME_YES=0; DRY_RUN=0; DO_CONFIGURE=""; AFTER=""; PLAIN=0   # AFTER : service | start | none
CONFIGURE_ARGS=()
while [ $# -gt 0 ]; do
    case "$1" in
        --with-office)  WITH_OFFICE=1 ;;  --no-office)  WITH_OFFICE=0 ;;
        --with-caddy)   WITH_CADDY=1 ;;   --no-caddy)   WITH_CADDY=0 ;;
        --with-agpl)    WITH_AGPL=1 ;;    --no-agpl)    WITH_AGPL=0 ;;
        --with-voice|--no-voice)
                        echo "$1 ignorée : le moteur vocal s'installe sur une machine dédiée (deploy/voice/README.md)." >&2 ;;
        --with-browser) WITH_BROWSER=1 ;; --no-browser) WITH_BROWSER=0 ;;
        --no-sandbox)   SANDBOX_MODE=none ;;
        --db)           DB_MODE="${2:?--db attend sqlite, postgres-local ou external}"; shift ;;
        --db=*)         DB_MODE="${1#*=}" ;;
        --sandbox)      SANDBOX_MODE="${2:?--sandbox attend build, pull ou none}"; shift ;;
        --sandbox=*)    SANDBOX_MODE="${1#*=}" ;;
        --pull)         SANDBOX_MODE=pull
                        if [ $# -gt 1 ] && [ "${2#-}" = "$2" ]; then PULL_REF="$2"; shift; fi ;;
        --pull=*)       SANDBOX_MODE=pull; PULL_REF="${1#*=}" ;;
        --skip-system)  DO_SYSTEM=0 ;;
        --offline)      OFFLINE_DIR="${2:?--offline attend un dossier}"; shift ;;
        --offline=*)    OFFLINE_DIR="${1#*=}" ;;
        -y|--yes)       ASSUME_YES=1 ;;
        --plain)        PLAIN=1 ;;
        --dry-run)      DRY_RUN=1 ;;
        --configure)    DO_CONFIGURE=1 ;; --no-configure) DO_CONFIGURE=0 ;;
        --service)      AFTER=service ;;
        --start)        AFTER=start ;;
        --no-start)     AFTER=none ;;
        --)             shift; CONFIGURE_ARGS=("$@"); break ;;
        -h|--help)      sed -n '3,/^#  Journal complet/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Option inconnue : $1 (voir --help)" >&2; exit 2 ;;
    esac
    shift
done
case "$SANDBOX_MODE" in ""|build|pull|none) ;; *) echo "--sandbox : build, pull ou none." >&2; exit 2 ;; esac
case "$DB_MODE" in
    ""|sqlite|postgres-local|external) ;;
    postgres|postgresql) DB_MODE=postgres-local ;;
    mariadb|mariadb-local|mysql)
        echo "--db : MariaDB/MySQL n'est plus pris en charge (sqlite, postgres-local ou external)." >&2; exit 2 ;;
    *) echo "--db : sqlite, postgres-local ou external." >&2; exit 2 ;;
esac
# Base encore réglée sur un moteur retiré (config.json, APP_DB_BACKEND) : refus avant toute modification.
DB_RETIRE="$( { printf '%s\n' "${APP_DB_BACKEND:-}"
    if [ -f "$ROOT/config.json" ] && command -v python3 >/dev/null; then
        python3 -c 'import json,sys; print((json.load(open(sys.argv[1])).get("database") or {}).get("backend") or "")' \
            "$ROOT/config.json" 2>/dev/null
    fi; } | tr -d ' ' | tr '[:upper:]' '[:lower:]' | grep -xE 'mysql|mariadb' | head -n1)"
if [ -n "$DB_RETIRE" ]; then
    echo "Base « $DB_RETIRE » : MariaDB/MySQL n'est plus pris en charge. Avec la version précédente d'Elpis, quittez-le d'abord (console › Base de données › « Revenir à SQLite », ou ./elpis db transfer puis ./elpis db use vers PostgreSQL), puis relancez l'installation (docs/exploitation.md, « Mettre à jour »)." >&2
    exit 2
fi
if [ -n "$OFFLINE_DIR" ]; then
    OFFLINE_DIR="$(cd "$OFFLINE_DIR" 2>/dev/null && pwd)" \
        || { echo "Dossier hors-ligne introuvable." >&2; exit 2; }
fi
INTERACTIVE=1
{ [ "$ASSUME_YES" -eq 1 ] || [ ! -t 0 ]; } && INTERACTIVE=0

# ── Journal ──────────────────────────────────────────────────────────────────
mkdir -p "$ROOT/logs"
if [ "$DRY_RUN" -eq 0 ]; then
    { echo; echo "===== install.sh $(date -Is) $* ====="; } >> "$ROOT/logs/install.log"
    # Tout ce qui s'affiche part aussi dans le journal. L'assistant, lui,
    # écrit sur /dev/tty : ses écrans (et les mots de passe) n'y passent pas.
    exec > >(tee -a "$ROOT/logs/install.log") 2>&1
fi
info() { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[  ok   ]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[ warn  ]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[erreur ]\033[0m %s\n' "$*" >&2; exit 1; }
WARNINGS=()
note_warn() { warn "$*"; WARNINGS+=("$*"); }
have() { command -v "$1" >/dev/null 2>&1; }

# ask_yn QUESTION DÉFAUT(0|1) → 0/1 sur stdout
ask_yn() {
    local q="$1" d="$2" hint a
    if [ "$INTERACTIVE" -eq 0 ]; then echo "$d"; return; fi
    [ "$d" -eq 1 ] && hint="O/n" || hint="o/N"
    while :; do
        read -r -p "  $q [$hint] : " a </dev/tty >&2 || a=""
        case "${a,,}" in
            "") echo "$d"; return ;;
            o|oui|y|yes) echo 1; return ;;
            n|non|no) echo 0; return ;;
        esac
    done
}
# ask_choice QUESTION DÉFAUT VAL1:LIBELLÉ1 VAL2:LIBELLÉ2 … → valeur
ask_choice() {
    local q="$1" d="$2"; shift 2
    if [ "$INTERACTIVE" -eq 0 ]; then echo "$d"; return; fi
    local i=1 di=1 opt vals=() a
    printf '  %s\n' "$q" >&2
    for opt in "$@"; do
        vals+=("${opt%%:*}")
        [ "${opt%%:*}" = "$d" ] && di=$i
        printf '    %d) %s\n' "$i" "${opt#*:}" >&2
        i=$((i+1))
    done
    while :; do
        read -r -p "  Choix [$di] : " a </dev/tty >&2 || a=""
        a="${a:-$di}"
        if [[ "$a" =~ ^[0-9]+$ ]] && [ "$a" -ge 1 ] && [ "$a" -le "${#vals[@]}" ]; then
            echo "${vals[$((a-1))]}"; return
        fi
    done
}

# Nettoyage : le fichier de réponses porte des secrets (mots de passe, clé API) ; l'archive de Node.js n'a servi qu'à cette installation.
ANSWERS=""; SUDO_KEEPALIVE=""; ELPIS_NODE_CACHE=""
cleanup() {
    [ -n "$SUDO_KEEPALIVE" ] && kill "$SUDO_KEEPALIVE" 2>/dev/null
    [ -n "$ANSWERS" ] && rm -f "$ANSWERS"
    [ -n "$ELPIS_NODE_CACHE" ] && rm -rf "$ELPIS_NODE_CACHE"
    return 0
}
trap cleanup EXIT

# =============================================================================
#  0. Système
# =============================================================================
OS_ID=""; OS_VER=""; OS_NAME="inconnu"
if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_ID="${ID:-}"; OS_VER="${VERSION_ID:-}"; OS_NAME="${PRETTY_NAME:-$OS_ID $OS_VER}"
fi
os_supported() {
    case "$OS_ID:$OS_VER" in
        debian:12|debian:13|ubuntu:24.04) return 0 ;;
    esac
    return 1
}

echo
info "=== Installation d'Elpis dans $ROOT ==="
info "Système : $OS_NAME"
if ! os_supported; then
    warn "Système non testé : Debian 12/13 et Ubuntu 24.04 sont pris en charge."
    warn "Sur un autre système, installez l'équivalent de deploy/prerequis-apt.txt, puis relancez avec --skip-system."
    if [ "$DO_SYSTEM" -eq 1 ] && [ "$(ask_yn "Continuer quand même ?" 0)" -eq 0 ]; then
        exit 1
    fi
fi

# =============================================================================
#  0 bis. Prérequis système — vérifiés, jamais installés ici
# =============================================================================
# Option d'install.sh qui retire le composant d'un groupe de deploy/prerequis-apt.txt.
option_sans() {
    case "$1" in
        sandbox) echo "--sandbox none" ;; apercus-office) echo "--no-office" ;; navigateur) echo "--no-browser" ;;
        https) echo "--no-caddy" ;; postgresql-local) echo "--db sqlite" ;;
        construction-hote) echo "--offline <paquet de cette version>" ;;
    esac
}

# Paquets apt absents des groupes donnés : liste, commande apt, puis arrêt (--dry-run : affichage seul).
verifier_prerequis() {
    [ "$DO_SYSTEM" -eq 1 ] || return 0
    if ! have dpkg-query; then
        note_warn "dpkg-query absent : prérequis système non vérifiés (deploy/prerequis-apt.txt)."
        return 0
    fi
    local manquants=() groupes=("$@") autres=() sans=() l
    if ! prerequis_debian13; then
        for l in "$@"; do [ "$l" = socle ] || autres+=("$l"); done
        groupes=(socle)
        [ "${#autres[@]}" -eq 0 ] \
            || note_warn "Noms de paquets de Debian 13 : sur $OS_NAME, seul le socle est vérifié ; installez l'équivalent des groupes ${autres[*]} (deploy/prerequis-apt.txt)."
    fi
    mapfile -t manquants < <(prerequis_manquants "${groupes[@]}")
    for l in "${groupes[@]}"; do
        [ "$l" != socle ] && [ -n "$(prerequis_manquants "$l")" ] && sans+=("$(option_sans "$l")")
    done
    if [ "${#manquants[@]}" -eq 0 ]; then
        ok "Prérequis système présents (paquets apt : ${groupes[*]})."
        return 0
    fi
    warn "Paquets système manquants (deploy/prerequis-apt.txt, groupes : ${groupes[*]}) :"
    for l in "${manquants[@]}"; do printf '    %s\n' "$(prerequis_libelle "$l")" >&2; done
    warn "Installez-les, puis relancez ./install.sh (hors ligne, apt passe par le miroir du LAN ou le support de l'OS) :"
    printf '    %s\n' "$(prerequis_commande "${manquants[@]}")" >&2
    [ "${#sans[@]}" -eq 0 ] || warn "ou relancez sans le composant concerné : ${sans[*]}"
    [ "$DRY_RUN" -eq 1 ] && return 0
    die "Prérequis système manquants : rien n'a été installé."
}
verifier_prerequis socle

# =============================================================================
#  0 ter. Droits — vérifiés AVANT toute question
# =============================================================================
# Utilisateur normal : sudo demandé maintenant, une fois, puis gardé actif
# pendant toute l'installation (la construction de l'image dure plus que les
# 15 min de vie d'un jeton sudo, et les étapes système suivantes échouaient).
# Root (sudo ./install.sh) : l'application tourne sous le compte qui a lancé
# sudo (ou ELPIS_USER, ou le propriétaire du dépôt), jamais en root.
SUDO=""; AS_ROOT=0; ADMIN_OK=0; APP_USER="$(id -un)"; APP_HOME="${HOME:-}"
if [ "$(id -u)" -eq 0 ]; then
    AS_ROOT=1; ADMIN_OK=1
    APP_USER="${ELPIS_USER:-${SUDO_USER:-}}"
    { [ -n "$APP_USER" ] && [ "$APP_USER" != root ]; } || APP_USER="$(stat -c %U "$ROOT")"
    if [ "$APP_USER" = root ] || ! id "$APP_USER" >/dev/null 2>&1; then
        die "Lancé en root sans compte pour faire tourner Elpis (le dépôt appartient à root). Clonez le dépôt avec un compte normal et lancez ./install.sh depuis ce compte, ou indiquez-le : ELPIS_USER=nom sudo ./install.sh"
    fi
    APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
    info "Lancé en root : étapes système en root, application sous « $APP_USER »."
elif have sudo; then
    if [ "$DRY_RUN" -eq 1 ]; then
        sudo -n true 2>/dev/null && ADMIN_OK=1
    else
        info "Droits administrateur : sudo est demandé maintenant, une seule fois."
        if sudo -v; then
            ADMIN_OK=1; SUDO="sudo"
            ( while kill -0 "$$" 2>/dev/null; do sudo -n -v 2>/dev/null; sleep 60; done ) &
            SUDO_KEEPALIVE=$!
        fi
    fi
fi
if [ "$ADMIN_OK" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
    if have sudo; then warn "sudo refusé : pas de droits administrateur."; else warn "sudo absent : pas de droits administrateur."; fi
    if [ "$INTERACTIVE" -eq 1 ]; then
        go=""
        if [ "$PLAIN" -eq 0 ] && have python3; then
            go="$(python3 "$ROOT/deploy/wizard.py" ask --title "Elpis — installation" \
                --question "Pas de droits administrateur (sudo $(have sudo && echo refusé || echo absent))." \
                "quit:Arrêter:relancer depuis un compte sudoer, ou sudo ./install.sh" \
                "limited:Continuer sans:Caddy, base locale et services désactivés")" \
                || go=quit
        else
            [ "$(ask_yn "Continuer SANS droits administrateur ? (Caddy, base locale et services systemd seront désactivés)" 0)" -eq 1 ] && go=limited
        fi
        [ "$go" = limited ] || die "Installation arrêtée : relancez depuis un compte autorisé à utiliser sudo, ou « sudo ./install.sh »."
    else
        needs=()
        [ "$WITH_CADDY" = 1 ] && needs+=("Caddy")
        [ "$DB_MODE" = postgres-local ] && needs+=("base locale")
        [ "$AFTER" = service ] && needs+=("services systemd")
        [ "${#needs[@]}" -eq 0 ] || die "Pas de droits administrateur, or l'installation en demande pour : ${needs[*]}. Lancez avec sudo, ou retirez ces options."
    fi
fi

# Commande d'un utilisateur, lancée sous le compte de l'application quand le
# script tourne en root (venv, Chromium, démarrage).
as_app() {
    if [ "$AS_ROOT" -eq 1 ]; then
        runuser -u "$APP_USER" -- env HOME="$APP_HOME" USER="$APP_USER" LOGNAME="$APP_USER" PATH="$PATH" "$@"
    else
        "$@"
    fi
}

# =============================================================================
#  1. Les choix : assistant par pages, questions en lignes, ou options seules
# =============================================================================
TUI=0
ANSWERS_PATH="$ROOT/user_db/run/install-answers.json"

ensure_python3() { have python3; }
preset_json() {
    python3 -c 'import json, sys
keys = ["with_office", "with_caddy", "with_agpl", "with_browser",
        "sandbox", "pull_ref", "db_mode", "after"]
print(json.dumps({k: v for k, v in zip(keys, sys.argv[1:]) if v}))' \
        "$WITH_OFFICE" "$WITH_CADDY" "$WITH_AGPL" "$WITH_BROWSER" \
        "$SANDBOX_MODE" "$PULL_REF" "$DB_MODE" "$AFTER"
}
run_wizard() {   # run_wizard [--in FICHIER] [--start PAGE] [--banner TEXTE]
    mkdir -p "$ROOT/user_db/run"
    chmod 700 "$ROOT/user_db" "$ROOT/user_db/run" 2>/dev/null
    ANSWERS="$ANSWERS_PATH"
    ELPIS_WIZ_ADMIN="$ADMIN_OK" ELPIS_WIZ_OFFLINE="$OFFLINE_DIR" ELPIS_WIZ_OS="$OS_NAME" \
    ELPIS_WIZ_PRESET="$(preset_json)" \
    ELPIS_WIZ_CONFIGURE_ARGS="$(python3 -c 'import json, sys; print(json.dumps(sys.argv[1:]))' "${CONFIGURE_ARGS[@]}")" \
        python3 "$ROOT/deploy/wizard.py" install --out "$ANSWERS" "$@"
}
load_answers() {
    eval "$(python3 "$ROOT/deploy/wizard.py" export-sh "$ANSWERS")"
}

if [ "$INTERACTIVE" -eq 1 ] && [ "$PLAIN" -eq 0 ] && ensure_python3; then
    run_wizard
    case $? in
        0) TUI=1; load_answers; DO_CONFIGURE="${DO_CONFIGURE:-1}" ;;
        1) info "Installation annulée : rien n'a été modifié."; exit 0 ;;
        *) warn "Assistant indisponible dans ce terminal : questions en lignes." ;;
    esac
fi

if [ "$TUI" -eq 0 ]; then
    if [ "$INTERACTIVE" -eq 1 ]; then
        echo
        echo "  Composants facultatifs — Entrée garde la réponse proposée."
    fi
    [ -n "$WITH_BROWSER" ] || WITH_BROWSER="$(ask_yn "Service navigateur (Chromium piloté : navigation web par l'assistant) ?" 1)"
    if [ -z "$SANDBOX_MODE" ]; then
        SANDBOX_MODE="$(ask_choice "Image sandbox Docker (terminal, exécution de code) :" build \
            "build:construire l'image ici (10 à 20 min, recommandé)" \
            "pull:la tirer d'un registre (image déjà publiée)" \
            "none:pas de sandbox")"
    fi
    if [ "$SANDBOX_MODE" = pull ] && [ -z "$PULL_REF" ]; then
        if [ "$INTERACTIVE" -eq 1 ]; then
            read -r -p "  Image à tirer (REGISTRE/IMAGE:TAG) : " PULL_REF </dev/tty || true
        fi
        [ -n "$PULL_REF" ] || die "--sandbox pull : précisez l'image (--pull REGISTRE/IMAGE:TAG ou ELPIS_SANDBOX_PULL_REF)."
    fi
    if [ -z "$DB_MODE" ]; then
        if [ -f "$ROOT/config.json" ]; then
            DB_MODE=keep                     # réinstallation : la base ne change pas
        elif [ "$ADMIN_OK" -eq 1 ]; then
            DB_MODE="$(ask_choice "Base de données :" sqlite \
                "sqlite:fichier SQLite (recommandé jusqu'à quelques dizaines d'utilisateurs)" \
                "postgres-local:PostgreSQL sur cette machine (préparé ; paquet postgresql requis)" \
                "external:serveur PostgreSQL existant (questions ensuite)")"
        else
            DB_MODE="$(ask_choice "Base de données :" sqlite \
                "sqlite:fichier SQLite (recommandé jusqu'à quelques dizaines d'utilisateurs)" \
                "external:serveur PostgreSQL existant (questions ensuite)")"
        fi
    fi
    [ -n "$WITH_OFFICE" ] || WITH_OFFICE="$(ask_yn "LibreOffice (aperçus Word, Excel, PowerPoint dans l'éditeur, ~400 Mo) ?" "$(have soffice && echo 1 || echo 0)")"
    if [ "$ADMIN_OK" -eq 1 ]; then
        [ -n "$WITH_CADDY" ]  || WITH_CADDY="$(ask_yn "Caddy (HTTPS devant l'application) ?" 0)"
    else
        WITH_CADDY=0     # sa configuration demande root
    fi
    [ -n "$WITH_AGPL" ]   || WITH_AGPL="$(ask_yn "Extras AGPL PyMuPDF/pdf2docx (conversion PDF → Word ; licence AGPL) ?" 0)"
    if [ -z "$DO_CONFIGURE" ]; then
        if [ -f "$ROOT/config.json" ]; then
            DO_CONFIGURE="$(ask_yn "Revoir la configuration (./elpis configure) ?" 0)"
        else
            DO_CONFIGURE=1
        fi
    fi
    if [ -z "$AFTER" ]; then
        if [ "$INTERACTIVE" -eq 1 ] && have systemctl && [ "$ADMIN_OK" -eq 1 ]; then
            AFTER="$(ask_choice "Démarrage d'Elpis :" service \
                "service:services systemd (démarrage au boot, recommandé — sudo)" \
                "start:lancer maintenant sans service (./elpis start)" \
                "none:plus tard")"
        else
            AFTER=none
        fi
    fi
fi
# Groupes de deploy/prerequis-apt.txt qu'exigent les composants choisis.
GROUPES_APT=(socle)
[ "$SANDBOX_MODE" != none ] && GROUPES_APT+=(sandbox)
[ "$WITH_OFFICE" -eq 1 ] && GROUPES_APT+=(apercus-office)
[ "$WITH_BROWSER" -eq 1 ] && GROUPES_APT+=(navigateur)
[ "$WITH_CADDY" -eq 1 ] && GROUPES_APT+=(https)
[ "$DB_MODE" = postgres-local ] && GROUPES_APT+=(postgresql-local)
[ -z "$OFFLINE_DIR" ] && GROUPES_APT+=(construction-hote)

yn() { [ "$1" -eq 1 ] && echo oui || echo non; }
cat <<EOF

  Récapitulatif
    droits            : $([ "$AS_ROOT" -eq 1 ] && echo "root (application sous $APP_USER)" || { [ "$ADMIN_OK" -eq 1 ] && echo "sudo" || echo "aucun"; })
    prérequis apt     : $([ "$DO_SYSTEM" -eq 1 ] && echo "vérifiés (${GROUPES_APT[*]})" || echo "non vérifiés (--skip-system)")
    Python            : venv/ + requirements-rag.txt$([ "$WITH_AGPL" -eq 1 ] && echo " + extras AGPL")
    core (Node.js)    : Node ${NODE_VERSION:-?} dans node/ + $([ -n "$OFFLINE_DIR" ] && echo "bundle du paquet hors ligne" || echo "npm ci, npm run build")
    hôte d'outils     : $([ -n "$OFFLINE_DIR" ] && echo "bundle du paquet hors ligne" || echo "construit sur place (node-pty compilé)")
    navigateur        : $(yn "$WITH_BROWSER")
    Qdrant            : $QDRANT_VERSION
    sandbox           : $SANDBOX_MODE${PULL_REF:+ ($PULL_REF)}
    base de données   : $([ "$DB_MODE" = keep ] && echo "inchangée" || echo "$DB_MODE")
    LibreOffice       : $(yn "$WITH_OFFICE")
    Caddy (HTTPS)     : $(yn "$WITH_CADDY")
    configuration     : $([ "$TUI" -eq 1 ] && echo "réponses de l'assistant" || yn "$DO_CONFIGURE")
    démarrage         : $AFTER
    source            : ${OFFLINE_DIR:-en ligne}
EOF
echo
verifier_prerequis "${GROUPES_APT[@]}"
if [ "$DRY_RUN" -eq 1 ]; then
    echo
    info "--dry-run : rien n'a été modifié."
    exit 0
fi
# L'assistant a déjà fait confirmer son résumé.
if [ "$TUI" -eq 0 ] && [ "$INTERACTIVE" -eq 1 ] && [ "$(ask_yn "Lancer l'installation ?" 1)" -eq 0 ]; then
    info "Annulé."
    exit 0
fi
# Le dépôt revient au compte de l'application — SAUF le contenu des
# sandboxes : chaque /work appartient à l'utilisateur du conteneur (seul
# l'agent y écrit) ; seuls user_sandboxes et chaque dossier de compte, sans
# récursion. Un chown -R ici rendait /work illisible en écriture à l'agent
# jusqu'au redémarrage de son conteneur.
chown_depot() {
    find "$ROOT" -path "$ROOT/user_sandboxes" -prune -o -exec chown -h "$APP_USER": {} +
    if [ -d "$ROOT/user_sandboxes" ]; then
        chown "$APP_USER": "$ROOT/user_sandboxes"
        find "$ROOT/user_sandboxes" -mindepth 1 -maxdepth 1 -type d -exec chown "$APP_USER": {} +
    fi
}
# En root : le dépôt appartient au compte de l'application (venv, Chromium,
# fichiers de configuration écrits sous ce compte).
[ "$AS_ROOT" -eq 1 ] && chown_depot

# =============================================================================
#  2. Docker — le paquet est un prérequis ; ici, son service et le groupe
# =============================================================================
configurer_docker() {
    have docker || return 0
    $SUDO systemctl enable --now docker >/dev/null 2>&1 || true
    if [ "$APP_USER" != root ] && ! id -nG "$APP_USER" | tr ' ' '\n' | grep -qx docker; then
        if $SUDO usermod -aG docker "$APP_USER"; then
            note_warn "$APP_USER ajouté au groupe docker : effectif à la prochaine connexion (les services systemd l'ont d'office)."
        fi
    fi
}

# =============================================================================
#  3. Environnement Python
# =============================================================================
install_python() {
    if [ ! -x "$VENV/bin/python" ]; then
        info "Création du venv…"
        if ! as_app "$PYBIN" -m venv "$VENV"; then
            local pyv pyp
            pyv="$("$PYBIN" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null)"
            pyp="$(command -v "$PYBIN")"
            if [ "$AS_ROOT" -eq 1 ] && ! have runuser; then
                die "Échec de création du venv : runuser introuvable (paquet util-linux)."
            elif ! "$PYBIN" -c 'import ensurepip' >/dev/null 2>&1; then
                die "Échec de création du venv : ensurepip manque à ${pyp:-$PYBIN} (Python ${pyv:-?}). Sur Debian/Ubuntu : apt install python${pyv:-3}-venv ; ou PYTHON_BIN=/usr/bin/python3 ./install.sh."
            else
                die "Échec de création du venv avec ${pyp:-$PYBIN} (Python ${pyv:-?}) : voir le message ci-dessus."
            fi
        fi
    fi
    local pip=(as_app "$VENV/bin/python" -m pip)
    local req="$ROOT/requirements-rag.txt"
    [ "$WITH_AGPL" -eq 1 ] && req="$ROOT/requirements-agpl-optional.txt"
    if [ -n "$OFFLINE_DIR" ]; then
        [ -d "$OFFLINE_DIR/wheels" ] || die "$OFFLINE_DIR/wheels absent du paquet hors-ligne."
        info "Dépendances Python depuis $OFFLINE_DIR/wheels…"
        "${pip[@]}" install --no-index --find-links "$OFFLINE_DIR/wheels" -r "$req" \
            || die "Échec pip (hors-ligne)."
    else
        "${pip[@]}" install --upgrade pip >/dev/null 2>&1 || true
        info "Dépendances Python ($(basename "$req"))…"
        "${pip[@]}" install -r "$req" || die "Échec pip."
    fi
    [ "$WITH_AGPL" -eq 1 ] && warn "Extras AGPL installés (PyMuPDF, pdf2docx) : voir requirements-agpl-optional.txt."
    ok "Environnement Python prêt."
}

# Node.js, bundles du core et de l'hôte d'outils, sous le compte de l'application (comme le venv) ; en ligne, une seule archive officielle pour toute l'installation.
install_core() {
    local o=()
    [ -n "$OFFLINE_DIR" ] && o=(--offline "$OFFLINE_DIR")
    if [ -z "$OFFLINE_DIR" ] && [ -z "$ELPIS_NODE_CACHE" ]; then
        ELPIS_NODE_CACHE="$(as_app mktemp -d "$ROOT/.node-cache.XXXXXX")" || ELPIS_NODE_CACHE=""
    fi
    as_app env ELPIS_NODE_CACHE="$ELPIS_NODE_CACHE" "$ROOT/deploy/node/installer.sh" node "${o[@]}" \
        || die "Node.js du core non installé (voir ci-dessus)."
    as_app env ELPIS_NODE_CACHE="$ELPIS_NODE_CACHE" "$ROOT/deploy/node/installer.sh" bundles "${o[@]}" \
        || die "Core ou hôte d'outils non installé (voir ci-dessus)."
    as_app env ELPIS_NODE_CACHE="$ELPIS_NODE_CACHE" "$ROOT/deploy/node/installer.sh" web "${o[@]}" \
        || die "Frontend non installé (voir ci-dessus)."
}

# =============================================================================
#  4. Base de données — préparée et TESTÉE avant les étapes longues
# =============================================================================
# Un échec n'est plus un simple avertissement suivi d'un retour discret à
# SQLite : l'installation s'arrête (--yes) ou demande quoi faire.
DB_CONFIGURE_ARGS=(); DB_ERR=""; DB_CHECK_MSG=""
db_password() {
    local f="$ROOT/user_db/.db_password"
    mkdir -p "$ROOT/user_db"
    if [ ! -s "$f" ]; then
        ( umask 077; openssl rand -hex 24 > "$f" ) || die "openssl absent : mot de passe de base non généré."
    fi
    chmod 600 "$f"
    [ "$AS_ROOT" -eq 1 ] && chown "$APP_USER": "$f"
    tr -d '\n' < "$f"
}
as_user() {   # as_user COMPTE COMMANDE… (root : runuser ; sinon sudo -u)
    local u="$1"; shift
    if [ "$(id -u)" -eq 0 ]; then runuser -u "$u" -- "$@"; else $SUDO -u "$u" "$@"; fi
}
provision_postgres() {
    have psql || { DB_ERR="PostgreSQL absent ($(prerequis_commande postgresql))"; return 1; }
    info "PostgreSQL : service, rôle et base « elpis »…"
    $SUDO systemctl enable --now postgresql >/dev/null 2>&1 || { DB_ERR="le service postgresql ne démarre pas"; return 1; }
    local pw; pw="$(db_password)"
    # Mot de passe par l'entrée standard, jamais dans la ligne de commande.
    ( cd / && as_user postgres psql -v ON_ERROR_STOP=1 -q -d postgres ) <<SQL || { DB_ERR="création du rôle ou de la base refusée par PostgreSQL"; return 1; }
SELECT 'CREATE ROLE elpis LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'elpis')\gexec
ALTER ROLE elpis LOGIN PASSWORD '$pw';
SELECT 'CREATE DATABASE elpis OWNER elpis ENCODING ''UTF8'' TEMPLATE template0'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'elpis')\gexec
SQL
    # unaccent : recherche d'historique insensible aux accents.
    ( cd / && as_user postgres psql -q -d elpis -c "CREATE EXTENSION IF NOT EXISTS unaccent SCHEMA public" ) \
        || note_warn "Extension unaccent non créée : recherche sensible aux accents."
    DB_CONFIGURE_ARGS=(--db postgres --db-host 127.0.0.1 --db-port 5432 --db-name elpis --db-user elpis)
    ok "PostgreSQL prêt (base elpis, utilisateur elpis)."
}
db_should_check() {
    case "$DB_MODE" in sqlite|keep|"") return 1 ;; esac
    [ "$TUI" -eq 1 ] && return 0
    [ "$DB_MODE" = postgres-local ] && return 0
    # Serveur existant sans assistant : testable seulement si ses réglages
    # sont donnés après « -- » (sinon configure les demande plus tard).
    printf '%s\n' "${CONFIGURE_ARGS[@]}" | grep -qx -- "--db-host"
}
db_check() {
    local out rc
    if [ "$TUI" -eq 1 ]; then
        out="$("$VENV/bin/python" "$ROOT/deploy/configure.py" --answers "$ANSWERS" --check-db 2>&1)"
    else
        out="$("$VENV/bin/python" "$ROOT/deploy/configure.py" --yes "${DB_CONFIGURE_ARGS[@]}" \
               "${CONFIGURE_ARGS[@]}" --check-db 2>&1)"
    fi
    rc=$?
    DB_CHECK_MSG="$(printf '%s\n' "$out" | tail -n 1)"
    return "$rc"
}
db_failure() {   # rend 0 pour réessayer (réglages éventuellement modifiés)
    local msg="$1" choice
    warn "Base de données : $msg"
    if [ "$INTERACTIVE" -eq 0 ]; then
        die "Base de données inutilisable : $msg. Rien n'est configuré sur une base injoignable : corrigez puis relancez, ou choisissez --db sqlite."
    fi
    if [ "$TUI" -eq 1 ]; then
        choice="$(python3 "$ROOT/deploy/wizard.py" ask --title "Elpis — base de données" \
            --question "Base inutilisable : $msg" \
            "retry:Réessayer:après correction côté serveur" \
            "edit:Modifier les réglages:retour à la page Base" \
            "sqlite:Passer à SQLite:fichier local, rien à préparer" \
            "abort:Abandonner l'installation")" || choice=abort
    else
        choice="$(ask_choice "Base inutilisable : $msg" retry \
            "retry:réessayer" "sqlite:passer à SQLite" "abort:abandonner l'installation")"
    fi
    case "$choice" in
        retry)  return 0 ;;
        edit)   run_wizard --in "$ANSWERS" --start base --banner "Base de données : $msg" \
                    || die "Installation abandonnée."
                load_answers
                return 0 ;;
        sqlite) DB_MODE=sqlite; DB_CONFIGURE_ARGS=(--db sqlite)
                [ "$TUI" -eq 1 ] && python3 "$ROOT/deploy/wizard.py" set "$ANSWERS" db_mode=sqlite
                return 0 ;;
        *)      die "Installation abandonnée (base de données)." ;;
    esac
}
setup_database() {
    while :; do
        DB_ERR=""
        case "$DB_MODE" in
            postgres-local) provision_postgres || true ;;
            sqlite)         DB_CONFIGURE_ARGS=(--db sqlite) ;;
            external)       [ "$TUI" -eq 1 ] || DB_CONFIGURE_ARGS=(--db external) ;;
        esac
        if [ -z "$DB_ERR" ] && db_should_check; then
            info "Base de données : test de connexion…"
            if db_check; then ok "Base de données : $DB_CHECK_MSG"; else DB_ERR="$DB_CHECK_MSG"; fi
        fi
        [ -z "$DB_ERR" ] && return 0
        db_failure "$DB_ERR"
    done
}

# =============================================================================
#  5 à 7. Navigateur, Qdrant, sandbox, options
# =============================================================================
# Navigateur sur le Node.js du core : hors ligne depuis le paquet (bibliothèques en prérequis apt), en ligne avec le npm de l'archive officielle, le temps de l'installation.
install_browser() {
    local bs="$ROOT/browser-service" chemin="$ROOT/node/bin:$PATH"
    [ -x "$ROOT/node/bin/node" ] || { note_warn "Node.js du core absent (node/) : service navigateur non installé."; return 0; }
    if [ -n "$OFFLINE_DIR" ]; then
        [ -d "$OFFLINE_DIR/browser" ] || { note_warn "$OFFLINE_DIR/browser absent : navigateur non installé."; return 0; }
        rm -rf "$bs/offline" && cp -a "$OFFLINE_DIR/browser" "$bs/offline"
        [ "$AS_ROOT" -eq 1 ] && chown -R "$APP_USER": "$bs/offline"
        ( cd "$bs" && as_app env PATH="$chemin" ./install_offline.sh --no-apt ) || note_warn "Installation hors-ligne du navigateur incomplète."
        return 0
    fi
    local npm_tmp rc=0
    npm_tmp="$(as_app mktemp -d "$ROOT/.node-npm.XXXXXX")" || { note_warn "Dossier temporaire impossible : navigateur non installé."; return 0; }
    info "Service navigateur : npm ci…"
    if ! as_app env ELPIS_NODE_CACHE="$ELPIS_NODE_CACHE" "$ROOT/deploy/node/installer.sh" npm "$npm_tmp" \
            || ! ( cd "$bs" && as_app env PATH="$ROOT/node/bin:$npm_tmp/bin:$PATH" npm ci --no-audit --no-fund ); then
        note_warn "npm ci a échoué (réseau ?) : navigateur indisponible."
        rm -rf "$npm_tmp"
        return 0
    fi
    rm -rf "$npm_tmp"
    info "Chromium (Playwright)…"
    ( cd "$bs" && as_app env PATH="$chemin" ./node_modules/.bin/playwright install chromium ) || rc=$?
    if [ "$rc" -eq 0 ]; then ok "Service navigateur prêt."; else note_warn "Installation de Chromium incomplète (réseau ?)."; fi
}

install_qdrant() {
    local dir="$ROOT/rag_app/qdrant" arch asset sha tgz
    mkdir -p "$dir"
    [ -f "$dir/config.yaml" ] || cp "$ROOT/deploy/qdrant/config.yaml" "$dir/config.yaml"
    if [ -x "$dir/qdrant" ] && "$dir/qdrant" --version 2>/dev/null | grep -q "$QDRANT_VERSION"; then
        ok "Qdrant $QDRANT_VERSION déjà en place."
        return 0
    fi
    arch="$(uname -m)"
    local va="QDRANT_ASSET_$arch" vs="QDRANT_SHA256_$arch"
    asset="${!va:-}"; sha="${!vs:-}"
    [ -n "$asset" ] || { note_warn "Architecture $arch non gérée : installez Qdrant à la main dans $dir/qdrant."; return 0; }
    tgz="$(mktemp)"
    if [ -n "$OFFLINE_DIR" ]; then
        cp "$OFFLINE_DIR/qdrant/$asset" "$tgz" 2>/dev/null \
            || { rm -f "$tgz"; note_warn "$OFFLINE_DIR/qdrant/$asset absent : Qdrant non installé."; return 0; }
    else
        info "Téléchargement de Qdrant $QDRANT_VERSION ($asset)…"
        curl -fsSL --retry 3 -o "$tgz" \
            "https://github.com/qdrant/qdrant/releases/download/v${QDRANT_VERSION}/${asset}" \
            || { rm -f "$tgz"; note_warn "Téléchargement de Qdrant échoué."; return 0; }
    fi
    if ! echo "$sha  $tgz" | sha256sum -c --quiet -; then
        rm -f "$tgz"; die "Somme sha256 de Qdrant invalide : archive refusée."
    fi
    tar -xzf "$tgz" -C "$dir" qdrant && chmod +x "$dir/qdrant"
    rm -f "$tgz"
    ok "Qdrant $QDRANT_VERSION installé ($dir/qdrant)."
}

install_sandbox_image() {
    local sb="$ROOT/deploy/docker/sandbox" image archive
    have docker || { note_warn "Docker absent : pas d'image sandbox (terminal et exécution de code indisponibles)."; return 0; }
    image="$("$sb/build_offline.sh" --print-image)"
    local dk=(docker)
    docker info >/dev/null 2>&1 || dk=($SUDO docker)
    if "${dk[@]}" image inspect "$image" >/dev/null 2>&1; then
        ok "Image sandbox $image déjà présente."
        return 0
    fi
    if [ -n "$OFFLINE_DIR" ]; then
        # L'archive de LA version attendue (pas la plus récente du dossier :
        # une ancienne version y serait chargée sous le mauvais nom).
        archive="$OFFLINE_DIR/sandbox/elpis-sandbox-${image##*:}.tar.gz"
        [ -f "$archive" ] || { note_warn "Archive $(basename "$archive") absente de $OFFLINE_DIR/sandbox."; return 0; }
        info "Chargement de l'image sandbox ($archive)…"
        if [ "${dk[0]}" = "docker" ]; then "$sb/load_image.sh" "$archive"; else $SUDO "$sb/load_image.sh" "$archive"; fi \
            || note_warn "Chargement de l'image sandbox échoué."
    elif [ "$SANDBOX_MODE" = pull ]; then
        [ -n "$PULL_REF" ] || die "--pull : précisez l'image (--pull REGISTRE/IMAGE:TAG ou ELPIS_SANDBOX_PULL_REF)."
        # Étiquette explicite d'une AUTRE version (ex. variable restée sur
        # l'ancienne) : ne pas la renommer en version attendue.
        local dernier="${PULL_REF##*/}"
        case "$dernier" in
            *@*) ;;                                      # empreinte : pas d'étiquette à comparer
            *:*) [ "${dernier##*:}" = "${image##*:}" ] \
                     || { note_warn "--pull $PULL_REF : version différente de ${image##*:} attendue, image non étiquetée."; return 0; } ;;
        esac
        info "Téléchargement de l'image sandbox ($PULL_REF)…"
        "${dk[@]}" pull "$PULL_REF" && "${dk[@]}" tag "$PULL_REF" "$image" \
            || note_warn "docker pull a échoué."
    else
        info "Construction de l'image sandbox $image (10 à 20 min)…"
        if [ "${dk[0]}" = "docker" ]; then "$sb/build_offline.sh"; else $SUDO "$sb/build_offline.sh"; fi \
            || note_warn "Construction de l'image sandbox échouée (relancez deploy/docker/sandbox/build_offline.sh)."
    fi
}

install_caddy() {
    # Paquet installé à part (prérequis apt, groupe https) : jamais par install_caddy.sh depuis ici.
    have caddy || { note_warn "Caddy absent : $(prerequis_commande caddy), puis relancez ./install.sh."; return 0; }
    info "Frontal HTTPS Caddy…"
    $SUDO "$ROOT/deploy/caddy/install_caddy.sh" || note_warn "Installation de Caddy incomplète."
}

# Les aperçus Office tournent dans une prison bubblewrap (Git, lui, tourne
# dans la sandbox depuis L4.4) ; la sonde est celle de l'application (@elpis/bac,
# par le core construit juste avant), comme ./elpis doctor. Ubuntu ≥ 23.10
# réserve les user namespaces aux programmes qui ont un profil AppArmor : avec
# les droits système, on en pose un pour bwrap, seulement s'il est bloqué
# (compromis : docs/configuration.md).
bwrap_ok() {
    local node="${ELPIS_NODE:-$ROOT/node/bin/node}"
    [ -x "$node" ] || node="$(command -v node || echo node)"
    as_app env ELPIS_RACINE="$ROOT" "$node" "$ROOT/apps/core/dist/exploitation.mjs" bwrap >/dev/null 2>&1
}

ensure_bwrap() {
    if ! have bwrap; then
        note_warn "bubblewrap absent : aperçus Office indisponibles (apt install bubblewrap)."
        return 0
    fi
    if bwrap_ok; then ok "bubblewrap utilisable (aperçus Office)."; return 0; fi
    if [ "$DO_SYSTEM" -eq 1 ] && [ "$ADMIN_OK" -eq 1 ] && have apparmor_parser \
            && [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ]; then
        printf '%s\n' 'abi <abi/4.0>,' 'include <tunables/global>' '' \
            'profile elpis-bwrap /usr/bin/bwrap flags=(unconfined) {' '  userns,' \
            '  include if exists <local/elpis-bwrap>' '}' \
            | $SUDO tee /etc/apparmor.d/elpis-bwrap >/dev/null \
            && $SUDO apparmor_parser -r /etc/apparmor.d/elpis-bwrap \
            && bwrap_ok && { ok "bubblewrap autorisé (profil AppArmor elpis-bwrap)."; return 0; }
    fi
    note_warn "bubblewrap bloqué (user namespaces) : aperçus Office indisponibles (./elpis doctor)."
}

check_office() {
    if have soffice && have bwrap; then ok "LibreOffice + bubblewrap présents (aperçus Office)."
    else note_warn "LibreOffice/bubblewrap absents : aperçus Office indisponibles."; fi
}

# =============================================================================
[ "$DO_SYSTEM" -eq 1 ] && [ "$ADMIN_OK" -eq 1 ] && configurer_docker
install_python
install_core
ensure_bwrap
setup_database
[ "$WITH_BROWSER" -eq 1 ] && install_browser
install_qdrant
case "$SANDBOX_MODE" in
    build|pull) install_sandbox_image ;;
esac
[ "$WITH_OFFICE" -eq 1 ] && check_office
[ "$WITH_CADDY" -eq 1 ] && install_caddy
mkdir -p "$ROOT/user_db/logs" "$ROOT/user_sandboxes" "$ROOT/logs"
chmod 700 "$ROOT/user_sandboxes"   # la racine isole les sandboxes des autres comptes de l'hôte
chmod +x "$ROOT/elpis" 2>/dev/null || true

# =============================================================================
#  8. Configuration et démarrage
# =============================================================================
if [ "$DO_CONFIGURE" = 1 ]; then
    echo
    if [ "$TUI" -eq 1 ]; then
        info "Configuration (réponses de l'assistant)…"
        "$ROOT/elpis" configure --answers "$ANSWERS" || note_warn "Configuration incomplète : relancez ./elpis configure."
    else
        info "Configuration (./elpis configure)…"
        # Choix de base d'install.sh d'abord : les options après « -- » priment.
        cfg_args=("${DB_CONFIGURE_ARGS[@]}" "${CONFIGURE_ARGS[@]}")
        # Composants absents : pas de HTTPS à proposer sans Caddy.
        if [ "$WITH_CADDY" -eq 0 ] && ! have caddy; then cfg_args=(--https off "${cfg_args[@]}"); fi
        [ "$INTERACTIVE" -eq 0 ] && cfg_args+=(--yes)
        if [ "$INTERACTIVE" -eq 1 ]; then
            "$ROOT/elpis" configure "${cfg_args[@]}" </dev/tty || note_warn "Configuration incomplète : relancez ./elpis configure."
        else
            "$ROOT/elpis" configure "${cfg_args[@]}" || note_warn "Configuration incomplète : relancez ./elpis configure."
        fi
    fi
fi
# En root : tout ce que les étapes système ont créé revient au compte de
# l'application (base SQLite, jetons, config, Qdrant, journaux), /work exclu.
[ "$AS_ROOT" -eq 1 ] && chown_depot

if [ -f "$ROOT/config.json" ]; then
    case "$AFTER" in
        service)
            info "Services systemd…"
            if [ "$ADMIN_OK" -eq 1 ]; then
                $SUDO env ELPIS_USER="$APP_USER" "$ROOT/elpis" service install \
                    || note_warn "Installation des services échouée (sudo ./elpis service install)."
            else
                note_warn "Services systemd : droits administrateur requis (sudo ./elpis service install)."
            fi
            ;;
        start)
            # Groupe docker tout juste ajouté : « sg » l'applique sans reconnexion.
            if [ "$AS_ROOT" -eq 0 ] && have sg && ! id -nG | tr ' ' '\n' | grep -qx docker \
                    && getent group docker | grep -qw "$APP_USER"; then
                sg docker -c "'$ROOT/elpis' start" || note_warn "Démarrage incomplet (./elpis status)."
            else
                as_app "$ROOT/elpis" start || note_warn "Démarrage incomplet (./elpis status)."
            fi
            ;;
    esac
else
    [ "$AFTER" != none ] && note_warn "config.json absent : lancez ./elpis configure avant de démarrer."
fi

echo
if [ "${#WARNINGS[@]}" -gt 0 ]; then
    warn "Installation terminée avec ${#WARNINGS[@]} avertissement(s) :"
    for w in "${WARNINGS[@]}"; do warn "  - $w"; done
else
    ok "Installation terminée."
fi
host="$(hostname -I 2>/dev/null | awk '{print $1}')"; host="${host:-localhost}"
# Adresse d'accès selon config.json : HTTPS (Caddy) ; sinon security.listen
# (même règle que apps/core/src/ecoute.ts : écoute locale → 127.0.0.1).
access_mode="$(python3 -c 'import json, sys
sec = json.load(open(sys.argv[1])).get("security") or {}
listen = sec.get("listen")
print("https" if (sec.get("https") or {}).get("enabled") else "0.0.0.0"
      if listen is None or str(listen).strip().lower() == "lan" else "127.0.0.1")' \
    "$ROOT/config.json" 2>/dev/null || echo "127.0.0.1")"
case "$access_mode" in
    https)     access="https://$host/   (administration : https://$host:8443/admin)" ;;
    0.0.0.0)   access="http://$host:8001/   (administration : http://$host:8002/admin)" ;;
    *)         access="http://127.0.0.1:8001/   (administration : http://127.0.0.1:8002/admin)
                  depuis ce serveur seulement (réseau : ./elpis configure --listen lan)" ;;
esac
cat <<EOF

  Accès         : $access
  Configuration : ./elpis configure        Diagnostic : ./elpis doctor
  Démarrage     : ./elpis start | stop | status | logs
  Au boot       : sudo ./elpis service install
  Journal       : logs/install.log

EOF
# Mot de passe administrateur généré : à l'écran seulement, jamais au journal.
if [ "$TUI" -eq 1 ] && [ -n "$ANSWERS" ] && [ -f "$ANSWERS" ]; then
    python3 "$ROOT/deploy/wizard.py" final-note "$ANSWERS" > /dev/tty 2>/dev/null || true
fi
