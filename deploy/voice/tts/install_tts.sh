#!/bin/bash
# SPDX-License-Identifier: MIT
# =====================================================================
#  install_tts.sh — installe le service de synthèse vocale Elpis.
#
#    sudo bash deploy/voice/tts/install_tts.sh [VOIX]
#
#  Ce qu'il faut sur la machine : python3.11+ et de quoi sortir sur Internet
#  pour pip et la voix (sinon, déposez le dossier wheels/ et la voix à la main).
#
#  Aucune carte son n'est requise : le service ne joue rien, il rend du WAV.
#
#  ELPIS_VOICE_HOST : adresse d'écoute (défaut 127.0.0.1, Elpis sur cette
#  machine ; IP privée ou 0.0.0.0 si Elpis tourne ailleurs).
# =====================================================================
set -euo pipefail

DEST="${DEST:-/opt/elpis-voice}"
VOIX="${1:-fr_FR-siwis-medium}"
SRC="$(cd "$(dirname "$0")" && pwd)"

echo "--- Utilisateur de service ---"
id -u elpis >/dev/null 2>&1 || useradd --system --home "$DEST" --shell /usr/sbin/nologin elpis
mkdir -p "$DEST/voices" "$DEST/tts"

echo "--- Code du service ---"
install -m 0644 "$SRC/tts_service.py"  "$DEST/tts/tts_service.py"
install -m 0644 "$SRC/requirements.txt" "$DEST/tts/requirements.txt"

echo "--- Environnement Python ---"
if [ ! -x "$DEST/tts/venv/bin/python" ]; then
    python3 -m venv "$DEST/tts/venv"
fi
if [ -d "$SRC/wheels" ]; then
    "$DEST/tts/venv/bin/pip" install --no-index --find-links "$SRC/wheels" -r "$DEST/tts/requirements.txt"
else
    "$DEST/tts/venv/bin/pip" install --upgrade pip
    "$DEST/tts/venv/bin/pip" install -r "$DEST/tts/requirements.txt"
fi

echo "--- Voix ---"
DEST="$DEST" bash "$SRC/fetch_voices.sh" "$VOIX"

echo "--- Jeton de service ---"
if [ ! -s "$DEST/tts/token.env" ]; then
    ( umask 077; printf 'ELPIS_TTS_TOKEN=%s\n' \
        "$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')" > "$DEST/tts/token.env" )
    echo "  jeton généré : $DEST/tts/token.env"
    echo "  à recopier dans la console admin d'Elpis (Connexions > Moteur vocal > Jeton)."
    echo "  Laissez le champ vide côté Elpis si vous préférez un service ouvert sur le LAN :"
    echo "  dans ce cas, supprimez $DEST/tts/token.env et redémarrez le service."
fi

echo "--- Unité systemd ---"
sed -e "s#/opt/elpis-voice#$DEST#g" \
    -e "s#__VOIX__#$VOIX#g" \
    -e "s#^Environment=ELPIS_TTS_HOST=.*#Environment=ELPIS_TTS_HOST=${ELPIS_VOICE_HOST:-127.0.0.1}#" \
    "$SRC/elpis-tts.service" > /etc/systemd/system/elpis-tts.service
systemctl daemon-reload

chown -R elpis:elpis "$DEST"

echo
echo "Installé. Démarrage :"
echo "    sudo systemctl enable --now elpis-tts"
echo "    curl -s http://localhost:8091/health"
