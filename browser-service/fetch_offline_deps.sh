#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# ============================================================================
#  fetch_offline_deps.sh — Vendore TOUT le nécessaire au browser-service dans
#                          ./offline/, pour une install 100 % HORS-LIGNE.
# ----------------------------------------------------------------------------
#  À lancer UNE FOIS, sur une machine AVEC internet, EN TANT QUE l'utilisateur
#  qui fera tourner le service (Playwright range ses navigateurs dans le
#  ~/.cache de l'utilisateur courant).
#
#  Produit (dans ./offline/) :
#    • node_modules.tar.gz   → deps npm (express/playwright/uuid) — pur JS, même-arch
#    • ms-playwright.tar.gz   → les builds navigateur EXACTS attendus par le
#                               playwright-core vendorisé (révisions lues dans
#                               browsers.json — pas de devinette) + ffmpeg
#    • apt/*.deb              → libs système du navigateur (liste autoritative
#                               via `playwright install-deps --dry-run`)
#    • MANIFEST.txt           → versions, sha256, contenu
#
#  Ensuite : copie tout le dossier browser-service/ sur la VM cible (offline)
#  et lance `./install_offline.sh` là-bas — aucun accès réseau requis.
#
#  Usage :
#    ./fetch_offline_deps.sh                      # défaut : chromium (+ffmpeg+debs)
#    ./fetch_offline_deps.sh --engine firefox     # firefox au lieu de chromium
#    ./fetch_offline_deps.sh --all                # chromium + firefox + webkit
#    ./fetch_offline_deps.sh --no-apt             # ne pas vendorer les .deb
#    ./fetch_offline_deps.sh --engine chromium --engine webkit
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
ENGINES=()
WITH_APT=1
while [ $# -gt 0 ]; do
  case "$1" in
    --engine) ENGINES+=("${2:-chromium}"); shift 2;;
    --engine=*) ENGINES+=("${1#*=}"); shift;;
    --all) ENGINES=(chromium firefox webkit); shift;;
    --no-apt) WITH_APT=0; shift;;
    -h|--help) sed -n '2,33p' "$0"; exit 0;;
    *) die "Option inconnue : $1 (voir --help)";;
  esac
done
[ ${#ENGINES[@]} -gt 0 ] || ENGINES=(chromium)          # défaut
# dédoublonnage + validation
declare -A _seen=(); _eng=()
for e in "${ENGINES[@]}"; do
  case "$e" in chromium|firefox|webkit) ;; *) die "engine invalide : $e";; esac
  [ -n "${_seen[$e]:-}" ] || { _eng+=("$e"); _seen[$e]=1; }
done
ENGINES=("${_eng[@]}")
info "moteurs à vendorer : ${ENGINES[*]}"

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

# moteur → noms de builds (tels que dans browsers.json). ffmpeg = toujours (vidéo).
json_names_for(){
  case "$1" in
    chromium) echo "chromium chromium-headless-shell ffmpeg";;
    firefox)  echo "firefox ffmpeg";;
    webkit)   echo "webkit ffmpeg";;
  esac
}
WANT_JSON=()
for e in "${ENGINES[@]}"; do for n in $(json_names_for "$e"); do WANT_JSON+=("$n"); done; done

# ── 3. s'assurer que les builds EXACTS sont dans le cache (download si absent) ─
info "Téléchargement/validation des navigateurs (${ENGINES[*]}) via Playwright…"
node "$PW_CLI" install "${ENGINES[@]}" || die "playwright install a échoué (réseau ?)."

# browsers.json → dossiers de cache exacts (chromium-1208, chromium_headless_shell-1208, …)
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

# ── 6. libs système (.deb) — liste autoritative par moteur ──────────────────
DEB_COUNT=0
if [ "$WITH_APT" -eq 1 ] && command -v apt-get >/dev/null 2>&1; then
  info "Récupération des libs système (.deb) via install-deps --dry-run…"
  declare -A PKGS=()
  for e in "${ENGINES[@]}"; do
    line="$(node "$PW_CLI" install-deps --dry-run "$e" 2>/dev/null \
            | sed -nE 's/.*--no-install-recommends (.*)"[[:space:]]*$/\1/p' || true)"
    for p in $line; do PKGS["$p"]=1; done
  done
  if [ ${#PKGS[@]} -gt 0 ]; then
    mkdir -p "$OFFLINE/apt"
    # Listes apt FRAÎCHES en espace utilisateur (sans root) : évite les 404 quand
    # les listes système pointent une version de point release déjà remplacée sur
    # le miroir (ex : libglib2.0-0t64 ~deb13u2 → ~deb13u3).
    APT_TMP="$(mktemp -d)"; mkdir -p "$APT_TMP/lists/partial" "$APT_TMP/cache/archives/partial"
    APT_OPTS=()
    if apt-get update -o Dir::State::Lists="$APT_TMP/lists" -o Dir::Cache="$APT_TMP/cache" >/dev/null 2>&1; then
      APT_OPTS=(-o Dir::State::Lists="$APT_TMP/lists" -o Dir::Cache="$APT_TMP/cache")
      info "listes apt rafraîchies (user-space)."
    else
      warn "apt-get update user-space indisponible — listes système utilisées (risque de 404 sur point release)."
    fi
    ( cd "$OFFLINE/apt" && apt-get download "${APT_OPTS[@]+"${APT_OPTS[@]}"}" "${!PKGS[@]}" ) \
      || warn "apt-get download partiel — certains .deb manquent (deps système supposées présentes sur la cible)."
    rm -rf "$APT_TMP"
    DEB_COUNT="$(find "$OFFLINE/apt" -maxdepth 1 -name '*.deb' | wc -l | tr -d ' ')"
    ok "$DEB_COUNT .deb vendorés (${#PKGS[@]} demandés)."
  else
    warn "Liste de paquets vide (install-deps --dry-run a échoué) — étape .deb sautée."
  fi
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
  echo "moteurs          : ${ENGINES[*]}"
  echo "builds           : ${WANT_DIRS[*]}"
  echo "libs .deb        : $DEB_COUNT"
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
