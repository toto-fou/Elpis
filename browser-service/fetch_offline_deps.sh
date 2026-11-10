#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# ============================================================================
#  fetch_offline_deps.sh — Vendore TOUT le nécessaire au browser-service dans
#                          ./offline/, pour une install 100 % HORS-LIGNE.
# ----------------------------------------------------------------------------
#  À lancer UNE FOIS, sur une machine AVEC internet, de même architecture et de
#  même version de Debian que la cible, EN TANT QUE l'utilisateur qui fera
#  tourner le service (Playwright range ses navigateurs dans le ~/.cache de
#  l'utilisateur courant).
#
#  Produit (dans ./offline/) :
#    • node_modules.tar.gz   → deps npm (express/playwright/uuid) — pur JS, même-arch
#    • ms-playwright.tar.gz   → le headless shell de Chromium et ffmpeg, aux
#                               révisions EXACTES du playwright-core vendorisé
#                               (lues dans browsers.json — pas de devinette)
#    • apt/*.deb              → libs système du headless shell : groupe
#                               « navigateur » de deploy/prerequis-apt.txt et
#                               ses dépendances absentes d'une Debian minimale
#                               (debootstrap minbase)
#    • MANIFEST.txt           → versions, sha256, contenu
#
#  Ensuite : copie tout le dossier browser-service/ sur la VM cible (offline)
#  et lance `./install_offline.sh` là-bas — aucun accès réseau requis.
#
#  Usage :
#    ./fetch_offline_deps.sh            # headless shell + ffmpeg + .deb
#    ./fetch_offline_deps.sh --no-apt   # sans les .deb (prérequis apt de la cible)
# ============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"          # = browser-service/

# ── couleurs ────────────────────────────────────────────────────────────────
if [ -t 1 ]; then C_B=$'\e[1m'; C_G=$'\e[32m'; C_Y=$'\e[33m'; C_R=$'\e[31m'; C_0=$'\e[0m'
else C_B=; C_G=; C_Y=; C_R=; C_0=; fi
info(){ printf '%s[fetch-offline]%s %s\n' "$C_B" "$C_0" "$*"; }
ok(){   printf '%s[ ok ]%s %s\n' "$C_G" "$C_0" "$*"; }
warn(){ printf '%s[warn]%s %s\n' "$C_Y" "$C_0" "$*" >&2; }
die(){  printf '%s[FAIL]%s %s\n' "$C_R" "$C_0" "$*" >&2; exit 1; }

# ── options ─────────────────────────────────────────────────────────────────
WITH_APT=1
while [ $# -gt 0 ]; do
  case "$1" in
    --no-apt) WITH_APT=0; shift;;
    -h|--help) sed -n '2,29p' "$0"; exit 0;;
    *) die "Option inconnue : $1 (voir --help)";;
  esac
done

OFFLINE="offline"
CACHE="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
PREREQUIS_SH="../deploy/prerequis-apt.sh"

# ── 0. pré-requis ───────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die "node absent (Node.js >= 16 requis)."
command -v npm  >/dev/null 2>&1 || die "npm absent."
command -v tar  >/dev/null 2>&1 || die "tar absent."
if [ "$WITH_APT" -eq 1 ] && command -v apt-get >/dev/null 2>&1; then
  [ -f "$PREREQUIS_SH" ] || die "$PREREQUIS_SH absent : lancez ce script depuis le dépôt Elpis (ou --no-apt)."
fi
info "node $(node -v) / npm $(npm -v)"
rm -rf "$OFFLINE"; mkdir -p "$OFFLINE"

# ── 1. deps npm (sans postinstall : on gère les navigateurs nous-mêmes) ──────
info "Installation des deps npm (npm ci, sans download navigateur)…"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
if [ -f package-lock.json ]; then
  npm ci || npm install || die "npm ci/install a échoué."
else
  npm install || die "npm install a échoué."
fi
ok "node_modules prêt."

# ── 2. localiser le CLI Playwright LOCAL + lire les révisions EXACTES ────────
PW_CLI=""
for c in node_modules/playwright/cli.js node_modules/playwright-core/cli.js; do
  [ -f "$c" ] && { PW_CLI="$c"; break; }
done
[ -n "$PW_CLI" ] || die "CLI Playwright introuvable après npm install."
PW_VER="$(node -e "process.stdout.write(require('./node_modules/playwright-core/package.json').version)")"
info "Playwright v$PW_VER (CLI: $PW_CLI)"

# builds vendorés (noms de browsers.json) : le headless shell de Chromium, et ffmpeg pour la vidéo.
WANT_JSON=(chromium-headless-shell ffmpeg)

# ── 3. s'assurer que les builds EXACTS sont dans le cache (download si absent) ─
info "Téléchargement/validation du headless shell de Chromium et de ffmpeg via Playwright…"
node "$PW_CLI" install --only-shell chromium || die "playwright install a échoué (réseau ?)."

# browsers.json → dossiers de cache exacts (chromium_headless_shell-1248, ffmpeg-1013, …)
mapfile -t WANT_DIRS < <(node -e '
const j = require("./node_modules/playwright-core/browsers.json");
const want = new Set(process.argv.slice(1));
const out = [];
for (const b of j.browsers) if (want.has(b.name)) out.push(b.name.replace(/-/g,"_") + "-" + b.revision);
console.log([...new Set(out)].join("\n"));
' "${WANT_JSON[@]}")
[ ${#WANT_DIRS[@]} -gt 0 ] || die "Aucune révision résolue depuis browsers.json."
info "Builds ciblés : ${WANT_DIRS[*]}"

# vérifier la présence physique de chaque build dans le cache
MISSING=0
for d in "${WANT_DIRS[@]}"; do
  if [ -d "$CACHE/$d" ] && [ -f "$CACHE/$d/INSTALLATION_COMPLETE" ]; then
    ok "présent : $d"
  else
    warn "MANQUANT ou incomplet dans le cache : $CACHE/$d"; MISSING=1
  fi
done
[ "$MISSING" -eq 0 ] || die "Des builds manquent — relance avec internet (playwright install)."

# ── 4. archive node_modules (pur JS → portable même-arch) ───────────────────
info "Archive node_modules → $OFFLINE/node_modules.tar.gz…"
tar czf "$OFFLINE/node_modules.tar.gz" node_modules
ok "node_modules.tar.gz ($(du -h "$OFFLINE/node_modules.tar.gz" | cut -f1))"

# ── 5. archive des builds navigateur (préserve markers/symlinks/exécutables) ─
info "Archive des navigateurs → $OFFLINE/ms-playwright.tar.gz…"
tar czf "$OFFLINE/ms-playwright.tar.gz" -C "$CACHE" "${WANT_DIRS[@]}"
ok "ms-playwright.tar.gz ($(du -h "$OFFLINE/ms-playwright.tar.gz" | cut -f1))"

# ── 6. libs système (.deb) : groupe « navigateur » de deploy/prerequis-apt.txt ─
DEB_COUNT=0
DEB_OS=""
if [ "$WITH_APT" -eq 1 ] && command -v apt-get >/dev/null 2>&1; then
  # shellcheck source=../deploy/prerequis-apt.sh
  . "$PREREQUIS_SH"
  DEB_OS="$(. /etc/os-release 2>/dev/null && echo "${ID:-?} ${VERSION_ID:-?}")" || DEB_OS="?"
  info "Libs système (.deb) du headless shell ($DEB_OS)…"
  mkdir -p "$OFFLINE/apt"
  # Listes apt FRAÎCHES en espace utilisateur (sans root) : évite les 404 quand
  # les listes système pointent une version de point release déjà remplacée sur
  # le miroir (ex : libglib2.0-0t64 ~deb13u2 → ~deb13u3).
  APT_TMP="$(mktemp -d)"; mkdir -p "$APT_TMP/lists/partial" "$APT_TMP/cache/archives/partial"
  printf 'Dir::State::Lists "%s/lists";\nDir::Cache "%s/cache";\n' "$APT_TMP" "$APT_TMP" > "$APT_TMP/apt.conf"
  if APT_CONFIG="$APT_TMP/apt.conf" apt-get update >/dev/null 2>&1; then
    export APT_CONFIG="$APT_TMP/apt.conf"
    info "listes apt rafraîchies (user-space)."
  else
    warn "apt-get update user-space indisponible — listes système utilisées (risque de 404 sur point release)."
  fi
  # « a | b » : le nom que proposent les dépôts de cette version (t64 sur Debian 13, sans sur Debian 12).
  mapfile -t LIGNES < <(prerequis_lignes navigateur)
  [ ${#LIGNES[@]} -gt 0 ] || die "Groupe « navigateur » absent de deploy/prerequis-apt.txt."
  mapfile -t CHOIX < <(prerequis_choix "${LIGNES[@]}")
  [ ${#CHOIX[@]} -eq ${#LIGNES[@]} ] || die "apt-cache policy a échoué sur le groupe « navigateur »."
  for c in "${CHOIX[@]}"; do
    case "$c" in "!"*) die "Absent des dépôts apt : ${c#!}";; esac
  done
  # Paquets qu'apt poserait sur une Debian vide (statut dpkg vide) pour installer les arguments.
  simuler(){ apt-get -s -o Dir::State::status=/dev/null -o Debug::NoLocking=1 install --no-install-recommends "$@" 2>/dev/null \
               | awk '/^Inst /{ print $2 }' | sort -u; }
  # Debian minimale (debootstrap minbase) : paquets de priorité required, apt et leurs dépendances, présents partout.
  mapfile -t REQUIS < <(apt-cache dumpavail 2>/dev/null \
    | awk -v RS= '/\nPriority: required/ { if (match($0, /^Package: [^\n]+/)) print substr($0, 10, RLENGTH - 9) }' | sort -u)
  [ ${#REQUIS[@]} -gt 0 ] || die "apt-cache dumpavail ne liste aucun paquet de priorité required."
  mapfile -t PAQUETS < <(comm -23 <(simuler "${CHOIX[@]}") <(simuler "${REQUIS[@]}" apt))
  [ ${#PAQUETS[@]} -gt 0 ] || die "apt ne résout pas les dépendances de : ${CHOIX[*]}"
  ( cd "$OFFLINE/apt" && apt-get download "${PAQUETS[@]}" ) \
    || warn "apt-get download partiel — certains .deb manquent."
  unset APT_CONFIG
  rm -rf "$APT_TMP"
  DEB_COUNT="$(find "$OFFLINE/apt" -maxdepth 1 -name '*.deb' | wc -l | tr -d ' ')"
  ok "$DEB_COUNT .deb vendorés sur ${#PAQUETS[@]} demandés (${CHOIX[*]} et leurs dépendances)."
elif [ "$WITH_APT" -eq 1 ]; then
  warn "apt-get absent — étape .deb sautée (cible non-Debian ?)."
fi

# ── 7. MANIFEST ─────────────────────────────────────────────────────────────
sha(){ command -v sha256sum >/dev/null 2>&1 && sha256sum "$1" | cut -d' ' -f1 || echo "n/a"; }
{
  echo "browser-service — bundle offline"
  echo "généré le        : $(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo '?')"
  echo "playwright       : v$PW_VER"
  echo "node (build)     : $(node -v)"
  echo "navigateur       : headless shell de Chromium + ffmpeg"
  echo "builds           : ${WANT_DIRS[*]}"
  echo "libs .deb        : $DEB_COUNT${DEB_OS:+ ($DEB_OS)}"
  echo "arch             : $(uname -m)"
  echo ""
  echo "sha256:"
  echo "  node_modules.tar.gz   $(sha "$OFFLINE/node_modules.tar.gz")"
  echo "  ms-playwright.tar.gz  $(sha "$OFFLINE/ms-playwright.tar.gz")"
} > "$OFFLINE/MANIFEST.txt"

cat <<EOF

${C_G}✔ Bundle offline prêt dans $(pwd)/$OFFLINE${C_0}
$(du -sh "$OFFLINE" | cut -f1) au total.

PORTAGE :
  1. Copie tout le dossier browser-service/ (offline/ inclus) sur la VM cible.
  2. Sur la cible, SANS internet :  ./install_offline.sh
EOF
