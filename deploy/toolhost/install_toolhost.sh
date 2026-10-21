#!/bin/bash
# SPDX-License-Identifier: MIT
# =====================================================================
#  install_toolhost.sh — installe l'hôte d'outils Elpis sur une machine
#  DÉDIÉE (VM, serveur) : Node.js et bundle de l'hôte TS, venv du moteur Office
#  (worker Python de l'hôte), image sandbox, jeton, toolhost.json, unité
#  systemd elpis-toolhost. À lancer DEPUIS une copie du dépôt.
#
#    sudo bash deploy/toolhost/install_toolhost.sh /opt/elpis toolhost.example.lan
#
#  Ce que la machine doit avoir : python3 (3.11+), docker (l'utilisateur
#  `elpis` dans le groupe docker). Sans réseau : OFFLINE_DIR=<paquet extrait>
#  (paquet hors-ligne de make_release.sh, même architecture : node/, toolhost/,
#  wheels/). Bundle construit sur place (sans paquet) : build-essential et
#  python3 (npm ci compile node-pty), accès au registre npm.
#  Aperçus Office de l'éditeur (optionnel) : le relais transfère /api/sandbox/*
#  ici, la conversion tourne donc sur CETTE machine —
#  apt install libreoffice-writer-nogui libreoffice-calc-nogui
#  libreoffice-impress-nogui bubblewrap fonts-crosextra-carlito.
# =====================================================================
set -euo pipefail
DEST="${1:-/opt/elpis}"
HOSTNAME_TLS="${2:-}"
SRC="$(cd "$(dirname "$0")/../.." && pwd)"

# Copie du dépôt SRC vers DEST : configuration de la machine (toolhost.json, Caddyfile.toolhost), runtime node/, données et dépendances gardés.
copier_depot() {
    rsync -a --delete --exclude 'user_db' --exclude 'user_sandboxes' --exclude '.git' \
          --exclude 'venv' --exclude 'node_modules' \
          --exclude '/toolhost.json' --exclude '/Caddyfile.toolhost' --exclude '/node' "$1/" "$2/"
}

echo "--- Copie du dépôt vers $DEST ---"
mkdir -p "$DEST"
copier_depot "$SRC" "$DEST"
mkdir -p "$DEST/user_db" "$DEST/../user_sandboxes"

echo "--- Environnement Python (roues hors-ligne si présentes) ---"
cd "$DEST"
python3 -m venv venv
WHEELS_DIR="${WHEELS_DIR:-${OFFLINE_DIR:+$OFFLINE_DIR/wheels}}"
if [ -n "${WHEELS_DIR:-}" ]; then
    venv/bin/pip install --no-index --find-links "$WHEELS_DIR" -r requirements.txt
else
    venv/bin/pip install -r requirements.txt
fi

echo "--- Node.js et bundle de l'hôte d'outils TS ---"
o=()
[ -n "${OFFLINE_DIR:-}" ] && o=(--offline "$OFFLINE_DIR")
bash deploy/node/installer.sh node "${o[@]}"
bash deploy/node/installer.sh hote "${o[@]}"

echo "--- Image sandbox ---"
IMAGE="$(deploy/docker/sandbox/build_offline.sh --print-image)"
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "  $IMAGE déjà présente."
elif [ -n "${SANDBOX_ARCHIVE:-}" ]; then
    bash deploy/docker/sandbox/load_image.sh "$SANDBOX_ARCHIVE"
else
    bash deploy/docker/sandbox/build_offline.sh \
        || echo "  (image non construite — relancez deploy/docker/sandbox/build_offline.sh)"
fi

echo "--- Jeton de service ---"
if [ ! -s user_db/.local_mcp_token ]; then
    ( umask 077; python3 -c 'import secrets; print(secrets.token_urlsafe(32))' > user_db/.local_mcp_token )
    echo "  jeton généré : user_db/.local_mcp_token — à recopier dans le mcp.json de l'APP (\${file:…})"
fi

echo "--- toolhost.json ---"
if [ ! -f toolhost.json ]; then
    cp deploy/toolhost/toolhost.example.json toolhost.json
    echo "  toolhost.json créé depuis l'exemple : renseignez app_url, bind, familles."
    echo "  bind.host = 127.0.0.1 (derrière Caddyfile.toolhost) ; sans frontal TLS :"
    echo "  IP privée ou 0.0.0.0, port 8765 filtré à l'hôte Elpis."
fi

if [ -n "$HOSTNAME_TLS" ]; then
    sed "s/toolhost.example.lan/$HOSTNAME_TLS/" deploy/toolhost/Caddyfile.toolhost > "$DEST/Caddyfile.toolhost"
    echo "  Caddyfile.toolhost prêt pour $HOSTNAME_TLS (caddy run --config Caddyfile.toolhost)"
fi

echo "--- Unités systemd ---"
sed "s#/opt/elpis#$DEST#g" deploy/toolhost/elpis-toolhost.service > /etc/systemd/system/elpis-toolhost.service
# Unité d'une version précédente : elpis-tools n'existe plus.
systemctl disable --now elpis-tools.service 2>/dev/null || true
rm -f /etc/systemd/system/elpis-tools.service
systemctl daemon-reload
systemctl enable elpis-toolhost.service
echo "  systemctl start elpis-toolhost   puis   curl http://127.0.0.1:8765/health"
