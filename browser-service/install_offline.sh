#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# ============================================================================
#  install_offline.sh — Installe le browser-service SANS INTERNET depuis
#                       ./offline/ (généré par ./fetch_offline_deps.sh).
# ----------------------------------------------------------------------------
#  À lancer sur la VM cible, EN TANT QUE l'utilisateur qui fera tourner le
#  service. Aucun accès réseau requis.
#
#  Fait (idempotent) :
#    1. extrait node_modules.tar.gz            → ./node_modules
#    2. extrait ms-playwright.tar.gz            → $HOME/.cache/ms-playwright
#                                                 (ou --browsers-path DIR)
#    3. installe les libs système offline/apt/*.deb ABSENTES (dpkg -i, sudo) :
#       un paquet déjà installé reste tel quel, quelle que soit sa version
#    4. smoke-test : le headless shell de Chromium démarre VRAIMENT (--no-sandbox)
#
#  Usage :
#    ./install_offline.sh                        # install complète
#    ./install_offline.sh --no-apt               # ne pas toucher dpkg (libs déjà là)
#    ./install_offline.sh --browsers-path /opt/pw  # navigateurs ailleurs que ~/.cache
#    ./install_offline.sh --skip-smoke           # ne pas lancer le smoke-test
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
WITH_APT=1
SKIP_SMOKE=0
BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
while [ $# -gt 0 ]; do
  case "$1" in
    --no-apt) WITH_APT=0; shift;;
    --skip-smoke) SKIP_SMOKE=1; shift;;
    --browsers-path) BROWSERS_PATH="${2:?chemin requis}"; shift 2;;
    --browsers-path=*) BROWSERS_PATH="${1#*=}"; shift;;
    -h|--help) sed -n '2,23p' "$0"; exit 0;;
    *) die "Option inconnue : $1 (voir --help)";;
  esac
done

OFFLINE="offline"
[ -d "$OFFLINE" ] || die "Dossier $OFFLINE/ absent — lance d'abord ./fetch_offline_deps.sh (machine en ligne)."
[ -f "$OFFLINE/node_modules.tar.gz" ]  || die "$OFFLINE/node_modules.tar.gz manquant."
[ -f "$OFFLINE/ms-playwright.tar.gz" ] || die "$OFFLINE/ms-playwright.tar.gz manquant."
command -v node >/dev/null 2>&1 || die "node absent (Node.js >= 16 requis sur la cible)."
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

# Si le chemin n'est PAS le défaut, le service devra exporter PLAYWRIGHT_BROWSERS_PATH.
EXPORT_HINT=""
DEFAULT_CACHE="$HOME/.cache/ms-playwright"
if [ "$BROWSERS_PATH" != "$DEFAULT_CACHE" ]; then
  EXPORT_HINT="PLAYWRIGHT_BROWSERS_PATH=$BROWSERS_PATH "
  warn "navigateurs hors du cache par défaut → lance le service avec PLAYWRIGHT_BROWSERS_PATH=$BROWSERS_PATH"
fi

# ── 3. libs système (.deb) absentes de la cible ─────────────────────────────
if [ "$WITH_APT" -eq 1 ] && [ -d "$OFFLINE/apt" ] && ls "$OFFLINE/apt"/*.deb >/dev/null 2>&1; then
  SUDO=""; [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"
  if command -v dpkg >/dev/null 2>&1; then
    A_POSER=()
    for deb in "$OFFLINE"/apt/*.deb; do
      paquet="$(dpkg-deb -f "$deb" Package)"
      [ "$(dpkg-query -W -f='${db:Status-Status}' "$paquet" 2>/dev/null)" = installed ] || A_POSER+=("$deb")
    done
    if [ ${#A_POSER[@]} -eq 0 ]; then
      ok "libs système déjà présentes."
    else
      info "Installation de ${#A_POSER[@]} paquet(s) absent(s) (dpkg -i)…"
      if $SUDO dpkg -i "${A_POSER[@]}"; then
        ok "libs système installées."
      else
        warn "dpkg a signalé des soucis (paquet d'une autre version de Debian ?) — le smoke-test tranchera."
      fi
    fi
  else
    warn "dpkg absent — étape libs système sautée."
  fi
elif [ "$WITH_APT" -eq 1 ]; then
  info "Pas de .deb vendorés (ou --no-apt) — libs système supposées déjà présentes."
fi

# ── 4. smoke-test : le navigateur démarre-t-il VRAIMENT ? ───────────────────
if [ "$SKIP_SMOKE" -eq 1 ]; then
  warn "--skip-smoke : smoke-test sauté."
else
  info "Smoke-test : lancement du headless shell de Chromium…"
  PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_PATH" node -e "
const pw = require('./node_modules/playwright');
(async () => {
  const b = await pw.chromium.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const p = await b.newPage();
  await p.goto('about:blank');
  await b.close();
  console.log('SMOKE_OK');
})().catch(e => { console.error('SMOKE_FAIL', e.message); process.exit(1); });
" || die "Smoke-test KO — libs système manquantes ? (réessaie sans --no-apt, ou installe le groupe « navigateur » de deploy/prerequis-apt.txt)."
  ok "Smoke-test réussi — headless shell de Chromium opérationnel."
fi

cat <<EOF

${C_G}✔ Installation offline terminée.${C_0}

DÉMARRER LE SERVICE :
  cd "$(pwd)" && ${EXPORT_HINT}node server.js
  # le backend Python parle au service via PLAYWRIGHT_API_URL (défaut http://localhost:3000)
EOF
