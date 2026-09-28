#!/bin/bash
# SPDX-License-Identifier: MIT
# =====================================================================
#  fetch_caddy_debs.sh — Vendorise les .deb de Caddy dans ./debs/
#
#  À lancer UNE fois sur une machine Debian 13 AVEC internet (la VM de
#  dev convient). Produit deploy/caddy/debs/*.deb + MANIFEST.txt.
#
#  Ensuite : copiez le dossier de l'app sur la VM cible (les .deb
#  voyagent avec, comme les wheels Python) et install_caddy.sh les
#  installe tout seul, SANS réseau. S'ils manquent, install_caddy.sh
#  retombe sur apt en ligne.
#
#  Contenu : caddy + ses dépendances DIRECTES (Depends/Pre-Depends).
#  Les libs de base (libc6, passwd, …) sont vendorisées par sûreté mais
#  install_caddy.sh ne les installera que si ABSENTES de la cible —
#  jamais de downgrade d'une lib système déjà présente.
#
#  Usage : ./fetch_caddy_debs.sh
# =====================================================================
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

command -v apt-get  >/dev/null 2>&1 || { echo "apt-get requis (Debian/Ubuntu)." >&2; exit 1; }
command -v dpkg-deb >/dev/null 2>&1 || { echo "dpkg-deb requis." >&2; exit 1; }

mkdir -p debs

# Index apt frais si possible — IMPORTANT : un index périmé produit des 404
# sur les paquets remplacés depuis (le miroir ne garde que la version
# courante). Non bloquant : les 404 sur les libs de base sont tolérés plus bas.
if [ "$(id -u)" -eq 0 ]; then
    apt-get update || true
elif command -v sudo >/dev/null 2>&1; then
    if sudo -n true 2>/dev/null; then
        sudo apt-get update || true
    elif [ -t 0 ]; then
        # Terminal interactif : laisser sudo demander le mot de passe.
        sudo apt-get update || echo "[warn] apt-get update refusé — index existant utilisé."
    else
        echo "[warn] apt-get update sauté (pas de sudo non-interactif) — index existant utilisé."
    fi
fi

# caddy + dépendances directes (hors paquets virtuels <...>).
mapfile -t PKGS < <({ echo caddy
    apt-cache depends --no-recommends --no-suggests --no-conflicts \
        --no-breaks --no-replaces --no-enhances caddy \
        | awk '/^ *(Pre)?Depends:/ {print $2}' | grep -v '^<' || true
  } | sort -u)
[ "${#PKGS[@]}" -ge 1 ] || { echo "Paquet caddy introuvable dans l'index apt." >&2; exit 1; }
echo "Paquets à vendoriser : ${PKGS[*]}"

cd debs
rm -f ./*.deb

# Téléchargement paquet par paquet. Seul l'échec de CADDY est bloquant :
# une dépendance en 404 (index périmé — le miroir ne garde que la version
# courante de chaque paquet) est tolérée avec avertissement, car ces libs
# (libc6, passwd, …) sont présentes sur toute Debian fonctionnelle et
# install_caddy.sh ne pose de toute façon que ce qui MANQUE sur la cible.
# Si une dépendance manquait réellement des deux côtés, dpkg le dira
# clairement à l'install — remède : sudo apt-get update ici, puis re-run.
declare -a MISSING=()
for pkg in "${PKGS[@]}"; do
    if apt-get download "$pkg"; then
        continue
    fi
    if [ "$pkg" = "caddy" ]; then
        echo "[err ] caddy non téléchargé — bundle impossible." >&2
        echo "       Rafraîchissez l'index (sudo apt-get update) puis relancez." >&2
        exit 1
    fi
    MISSING+=("$pkg")
    echo "[warn] $pkg non téléchargé (index périmé ?) — supposé déjà présent sur la cible."
done

# MANIFEST : paquet, version, sha256 — pour tracer ce qui est embarqué.
{
    echo "# Généré par fetch_caddy_debs.sh — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    for f in *.deb; do
        printf '%-16s %-24s %s\n' \
            "$(dpkg-deb -f "$f" Package)" \
            "$(dpkg-deb -f "$f" Version)" \
            "$(sha256sum "$f" | cut -d' ' -f1)"
    done
    for m in ${MISSING[@]+"${MISSING[@]}"}; do
        echo "# NON VENDORISÉ : $m (index périmé au fetch — supposé présent sur la cible)"
    done
} > MANIFEST.txt

echo ""
echo "OK : $(ls -1 ./*.deb | wc -l) paquet(s) vendorisé(s) dans $(pwd)"
if [ "${#MISSING[@]}" -gt 0 ]; then
    echo "⚠  Dépendances non vendorisées : ${MISSING[*]}"
    echo "   (présentes d'office sur toute Debian ; pour un bundle complet :"
    echo "    sudo apt-get update puis relancez ce script)"
fi
cat MANIFEST.txt