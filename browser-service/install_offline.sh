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
#    3. installe les libs système offline/apt/*.deb ABSENTES (dpkg -i, sudo), et
#       celles qu'un paquet posé épingle (=) à une autre version que l'installée ;
#       arrêt avant dpkg s'il fallait rétrograder ou casser un paquet installé,
#       arrêt après si dpkg --audit signale un paquet non configuré
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
    -h|--help) sed -n '2,25p' "$0"; exit 0;;
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

# ── 3. libs système (.deb) : absentes, et versions épinglées par les paquets posés ─
# Dépendances à version exacte (=) d'un .deb : « paquet version » par ligne.
epingles(){ { dpkg-deb -f "$1" Pre-Depends Depends | sed -E 's/^(Pre-)?Depends:[[:space:]]*/, /' | tr -d '\n'; echo; } | tr ',' '\n' \
              | sed -nE 's/^[[:space:]]*([a-z0-9][a-z0-9.+-]*)(:[a-z0-9]+)?[[:space:]]*\(=[[:space:]]*([^)[:space:]]+)[[:space:]]*\).*$/\1 \3/p'; }
# Version installée d'un paquet, vide s'il ne l'est pas.
installee(){ [ "$(dpkg-query -W -f='${db:Status-Status}' "$1" 2>/dev/null)" = installed ] && dpkg-query -W -f='${Version}' "$1"; }
if [ "$WITH_APT" -eq 1 ] && [ -d "$OFFLINE/apt" ] && ls "$OFFLINE/apt"/*.deb >/dev/null 2>&1; then
  SUDO=""; [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"
  if command -v dpkg >/dev/null 2>&1; then
    CONSEIL="refaites le paquet hors ligne sur la même version de Debian (point release) que cette machine, ou installez le groupe « navigateur » de deploy/prerequis-apt.txt depuis le miroir du LAN"
    declare -A FICHIER=() VERSION=() POSER=()
    for deb in "$OFFLINE"/apt/*.deb; do
      p="$(dpkg-deb -f "$deb" Package)"; FICHIER[$p]="$deb"; VERSION[$p]="$(dpkg-deb -f "$deb" Version)"
      [ -n "$(installee "$p" || true)" ] || POSER[$p]=1
    done
    # Un paquet posé épingle (=) un paquet vendoré à sa version, installé à une autre : celui-ci est posé aussi.
    ajout=1
    while [ "$ajout" -eq 1 ]; do
      ajout=0
      for p in "${!POSER[@]}"; do
        while read -r d v; do
          [ -n "${FICHIER[$d]:-}" ] && [ -z "${POSER[$d]:-}" ] && [ "${VERSION[$d]}" = "$v" ] || continue
          [ "$(installee "$d" || true)" = "$v" ] && continue
          POSER[$d]=1; ajout=1
        done < <(epingles "${FICHIER[$p]}")
      done
    done
    # Refus avant toute modification : version antérieure, épinglage (=) impossible, paquet installé qui épingle la version remplacée.
    REFUS=(); REMPLACES=()
    for p in "${!POSER[@]}"; do
      a="$(installee "$p" || true)"
      if [ -n "$a" ]; then
        REMPLACES+=("$p=${VERSION[$p]}")
        if dpkg --compare-versions "${VERSION[$p]}" lt "$a"; then REFUS+=("$p installé en $a : le paquet hors ligne apporte ${VERSION[$p]}, plus ancien"); fi
      fi
      while read -r d v; do
        if [ -n "${POSER[$d]:-}" ]; then [ "${VERSION[$d]}" = "$v" ] && continue
        else [ "$(installee "$d" || true)" = "$v" ] && continue; fi
        REFUS+=("$p demande $d (= $v)")
      done < <(epingles "${FICHIER[$p]}")
    done
    if [ ${#REMPLACES[@]} -gt 0 ]; then
      mapfile -t -O "${#REFUS[@]}" REFUS < <(dpkg-query -W -f='${db:Status-Status}\t${Package}\t${Pre-Depends}, ${Depends}\n' 2>/dev/null \
        | awk -F'\t' -v rempl="${REMPLACES[*]}" -v poser=" ${!POSER[*]} " '
            BEGIN { n = split(rempl, r, " "); for (i = 1; i <= n; i++) { k = index(r[i], "="); v[substr(r[i], 1, k - 1)] = substr(r[i], k + 1) } }
            $1 == "installed" && index(poser, " " $2 " ") == 0 {
              m = split($3, d, ",")
              for (i = 1; i <= m; i++) if (match(d[i], /^[ \t]*[a-z0-9][a-z0-9.+-]*(:[a-z0-9]+)?[ \t]*\(=[ \t]*[^) \t]+/)) {
                e = substr(d[i], RSTART, RLENGTH); nom = e; sub(/^[ \t]*/, "", nom); sub(/[: \t(].*/, "", nom); ver = e; sub(/.*\(=[ \t]*/, "", ver)
                if ((nom in v) && v[nom] != ver) print $2 " épingle " nom " (= " ver "), que le paquet hors ligne remplacerait par " v[nom]
              } }')
    fi
    if [ ${#REFUS[@]} -gt 0 ]; then
      printf '    %s\n' "${REFUS[@]}" >&2
      die "Libs système non installées, rien n'a été modifié : $CONSEIL."
    fi
    if [ ${#POSER[@]} -eq 0 ]; then
      ok "libs système déjà présentes."
    else
      A_POSER=(); for p in "${!POSER[@]}"; do A_POSER+=("${FICHIER[$p]}"); done
      info "Installation de ${#A_POSER[@]} paquet(s) (dpkg -i) : absents, ou à la version qu'épingle un paquet posé…"
      rc=0; $SUDO dpkg -i "${A_POSER[@]}" || rc=$?
      AUDIT="$(dpkg --audit 2>&1 || true)"
      if [ "$rc" -ne 0 ] || [ -n "$AUDIT" ]; then
        [ -z "$AUDIT" ] || printf '%s\n' "$AUDIT" | sed 's/^/    /' >&2
        die "dpkg (code $rc) a laissé des paquets non configurés : $CONSEIL."
      fi
      ok "libs système installées (dpkg --audit sans anomalie)."
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
