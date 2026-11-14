#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# ============================================================================
#  install_offline.sh — Installe le browser-service SANS INTERNET depuis
#                       ./offline/ (généré par ./fetch_offline_deps.sh).
# ----------------------------------------------------------------------------
#  À lancer sur la VM cible, EN TANT QUE l'utilisateur qui fera tourner les
#  services. Aucun accès réseau requis. Le service et le headless shell sont
#  montés dans la sandbox de chaque compte (image elpis/sandbox, qui porte les
#  bibliothèques de Chromium) : rien ne lance Chromium sur l'hôte.
#
#  Fait (idempotent) :
#    1. extrait node_modules.tar.gz            → ./node_modules
#    2. extrait ms-playwright.tar.gz            → $HOME/.cache/ms-playwright
#                                                 (ou --browsers-path DIR)
#
#  Usage :
#    ./install_offline.sh                        # install complète
#    ./install_offline.sh --browsers-path /opt/pw  # navigateurs ailleurs que ~/.cache
# ============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"          # = browser-service/

if [ -t 1 ]; then C_B=$'\e[1m'; C_G=$'\e[32m'; C_Y=$'\e[33m'; C_R=$'\e[31m'; C_0=$'\e[0m'
else C_B=; C_G=; C_Y=; C_R=; C_0=; fi
info(){ printf '%s[install-offline]%s %s\n' "$C_B" "$C_0" "$*"; }
ok(){   printf '%s[ ok ]%s %s\n' "$C_G" "$C_0" "$*"; }
warn(){ printf '%s[warn]%s %s\n' "$C_Y" "$C_0" "$*" >&2; }
die(){  printf '%s[FAIL]%s %s\n' "$C_R" "$C_0" "$*" >&2; exit 1; }

# ── options ─────────────────────────────────────────────────────────────────
BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
while [ $# -gt 0 ]; do
  case "$1" in
    --browsers-path) BROWSERS_PATH="${2:?chemin requis}"; shift 2;;
    --browsers-path=*) BROWSERS_PATH="${1#*=}"; shift;;
    -h|--help) sed -n '2,20p' "$0"; exit 0;;
    *) die "Option inconnue : $1 (voir --help)";;
  esac
done

OFFLINE="offline"
[ -d "$OFFLINE" ] || die "Dossier $OFFLINE/ absent — lance d'abord ./fetch_offline_deps.sh (machine en ligne)."
[ -f "$OFFLINE/node_modules.tar.gz" ]  || die "$OFFLINE/node_modules.tar.gz manquant."
[ -f "$OFFLINE/ms-playwright.tar.gz" ] || die "$OFFLINE/ms-playwright.tar.gz manquant."
command -v tar  >/dev/null 2>&1 || die "tar absent."
[ -f "$OFFLINE/MANIFEST.txt" ] && { info "MANIFEST :"; sed 's/^/    /' "$OFFLINE/MANIFEST.txt" | head -9; }

# ── 1. node_modules ─────────────────────────────────────────────────────────
info "Extraction de node_modules…"
rm -rf node_modules
tar xzf "$OFFLINE/node_modules.tar.gz"
[ -d node_modules/playwright-core ] || die "Extraction node_modules incomplète."
ok "node_modules installé."

# ── 2. navigateurs Playwright ───────────────────────────────────────────────
info "Extraction des navigateurs → $BROWSERS_PATH…"
mkdir -p "$BROWSERS_PATH"
tar xzf "$OFFLINE/ms-playwright.tar.gz" -C "$BROWSERS_PATH"
ok "navigateurs en place."

# Si le chemin n'est PAS le défaut, l'hôte d'outils devra exporter PLAYWRIGHT_BROWSERS_PATH (dossier monté dans les sandboxes).
if [ "$BROWSERS_PATH" != "$HOME/.cache/ms-playwright" ]; then
  warn "navigateurs hors du cache par défaut → PLAYWRIGHT_BROWSERS_PATH=$BROWSERS_PATH dans le .env d'Elpis"
fi

cat <<EOF

${C_G}✔ Installation offline terminée.${C_0}
Le navigateur démarre dans la sandbox d'un compte à son premier outil pw_* (./elpis doctor le vérifie).
EOF
