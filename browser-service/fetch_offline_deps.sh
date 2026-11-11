#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# ============================================================================
#  fetch_offline_deps.sh — Vendore TOUT le nécessaire au browser-service dans
#                          ./offline/, pour une install 100 % HORS-LIGNE.
# ----------------------------------------------------------------------------
#  À lancer UNE FOIS, sur une machine AVEC internet, de même architecture que
#  la cible, EN TANT QUE l'utilisateur qui fera tourner les services
#  (Playwright range ses navigateurs dans le ~/.cache de l'utilisateur
#  courant). Les bibliothèques de Chromium sont dans l'image de la sandbox,
#  où le navigateur tourne : aucun paquet apt à vendorer.
#
#  Produit (dans ./offline/) :
#    • node_modules.tar.gz   → deps npm (express/playwright/uuid) — pur JS, même-arch
#    • ms-playwright.tar.gz   → le headless shell de Chromium et ffmpeg, aux
#                               révisions EXACTES du playwright-core vendorisé
#                               (lues dans browsers.json — pas de devinette)
#    • MANIFEST.txt           → versions, sha256, contenu
#
#  Ensuite : copie tout le dossier browser-service/ sur la VM cible (offline)
#  et lance `./install_offline.sh` là-bas — aucun accès réseau requis.
#
#  Usage :
#    ./fetch_offline_deps.sh            # deps npm + headless shell + ffmpeg
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
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) sed -n '2,25p' "$0"; exit 0;;
    *) die "Option inconnue : $1 (voir --help)";;
  esac
done

OFFLINE="offline"
CACHE="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"

# ── 0. pré-requis ───────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die "node absent (Node.js >= 16 requis)."
command -v npm  >/dev/null 2>&1 || die "npm absent."
command -v tar  >/dev/null 2>&1 || die "tar absent."
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

# ── 6. MANIFEST ─────────────────────────────────────────────────────────────
sha(){ command -v sha256sum >/dev/null 2>&1 && sha256sum "$1" | cut -d' ' -f1 || echo "n/a"; }
{
  echo "browser-service — bundle offline"
  echo "généré le        : $(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo '?')"
  echo "playwright       : v$PW_VER"
  echo "node (build)     : $(node -v)"
  echo "navigateur       : headless shell de Chromium + ffmpeg"
  echo "builds           : ${WANT_DIRS[*]}"
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
