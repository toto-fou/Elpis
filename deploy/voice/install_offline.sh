#!/bin/bash
# SPDX-License-Identifier: MIT
# =====================================================================
#  install_offline.sh — installe les DEUX services vocaux depuis le lot
#  vendorisé, SANS aucun accès réseau.
#
#    sudo bash deploy/voice/install_offline.sh [DEST]
#
#  DEST : /opt/elpis-voice par défaut.
#
#  Le lot (deploy/voice/offline/) est produit sur une machine connectée par
#  fetch_offline.sh, puis transporté par COPIE du dossier deploy/voice/.
#
#  Ce que la cible doit avoir : systemd. Python3 aussi, au même x.y que la
#  machine de préparation — et s'il manque (ou si son module venv manque,
#  cas courant sous Debian), le lot embarque les .deb pour l'installer.
#  Ni compilateur, ni pip en ligne, ni curl, ni accès réseau.
#
#  Options :
#    --no-stt / --no-tts   n'installer qu'un des deux services
#    --model <nom>         choisir le modèle quand le lot en embarque plusieurs
#                          (défaut : le plus petit, qui tourne partout)
#    --voice <nom>         voix Piper par défaut du service
#                          (défaut : fr_FR-siwis-medium, celle de config.json)
#    --skip-verify         ne pas vérifier les sha256 du MANIFEST
#    --lan                 écouter sur le réseau (0.0.0.0) : Elpis tourne sur
#                          une AUTRE machine. Défaut : 127.0.0.1 (Elpis ici).
#                          ELPIS_VOICE_HOST=<IP privée> pour une interface.
# =====================================================================
set -euo pipefail

DEST="/opt/elpis-voice"
AVEC_STT=1
AVEC_TTS=1
VERIFIER=1
MODELE_VOULU=""
VOIX_VOULUE=""
while [ $# -gt 0 ]; do
    case "$1" in
        --no-stt) AVEC_STT=0; shift ;;
        --no-tts) AVEC_TTS=0; shift ;;
        --skip-verify) VERIFIER=0; shift ;;
        --lan) ELPIS_VOICE_HOST=0.0.0.0; shift ;;
        --model) MODELE_VOULU="$2"; shift 2 ;;
        --voice) VOIX_VOULUE="$2"; shift 2 ;;
        -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
        -*) echo "Option inconnue : $1" >&2; exit 2 ;;
        *) DEST="$1"; shift ;;
    esac
done

ECOUTE="${ELPIS_VOICE_HOST:-127.0.0.1}"
ICI="$(cd "$(dirname "$0")" && pwd)"
LOT="$ICI/offline"

if [ ! -d "$LOT" ]; then
    echo "Lot hors-ligne absent : $LOT" >&2
    echo "Sur un poste CONNECTÉ : bash deploy/voice/fetch_offline.sh" >&2
    echo "puis transportez le dossier deploy/voice/ par copie." >&2
    exit 1
fi

echo "--- Vérification du lot ---"
if [ "$VERIFIER" = "1" ] && [ -s "$LOT/MANIFEST.txt" ]; then
    # Le MANIFEST porte les sha256 : une copie tronquée (clé USB retirée trop
    # tôt, rsync interrompu) donnerait sinon un service qui démarre puis meurt
    # sur un modèle illisible, plusieurs minutes plus tard.
    if ( cd "$LOT" && grep -v '^#' MANIFEST.txt | grep -v '^$' | sha256sum -c --quiet - ); then
        echo "  empreintes conformes"
    else
        echo "  EMPREINTES NON CONFORMES — la copie du lot est incomplète ou abîmée." >&2
        echo "  Recopiez deploy/voice/ depuis la machine de préparation." >&2
        exit 1
    fi
else
    echo "  (vérification passée)"
fi

echo "--- Utilisateur de service ---"
id -u elpis >/dev/null 2>&1 || useradd --system --home "$DEST" --shell /usr/sbin/nologin elpis
mkdir -p "$DEST/bin" "$DEST/models" "$DEST/voices" "$DEST/tts"

# ── Reconnaissance ───────────────────────────────────────────────────────────
if [ "$AVEC_STT" = "1" ]; then
    echo "--- Reconnaissance ---"
    if [ ! -x "$LOT/bin/whisper-server" ]; then
        echo "  binaire absent du lot — relancez fetch_offline.sh" >&2
        exit 1
    fi
    cp -a "$LOT/bin/." "$DEST/bin/"
    chmod 0755 "$DEST/bin/whisper-server"

    # Le binaire a été compilé AILLEURS : on vérifie qu'il tourne ICI avant de
    # déclarer l'installation réussie. Une glibc plus ancienne sur la cible se
    # verrait sinon au premier démarrage du service, sans message clair.
    if ! LD_LIBRARY_PATH="$DEST/bin" "$DEST/bin/whisper-server" --help >/dev/null 2>&1; then
        echo "  le binaire vendorisé ne démarre pas sur cette machine."
        if command -v cmake >/dev/null 2>&1 && [ -d "$LOT/src/whisper.cpp" ]; then
            echo "  recompilation depuis la source vendorisée ..."
            cmake -S "$LOT/src/whisper.cpp" -B "$DEST/build" \
                  -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON
            cmake --build "$DEST/build" --config Release -j "$(nproc)"
            for c in "$DEST/build/bin/whisper-server" "$DEST/build/bin/server"; do
                [ -x "$c" ] && install -m 0755 "$c" "$DEST/bin/whisper-server" && break
            done
            find "$DEST/build" \( -name 'libggml*.so*' -o -name 'libwhisper*.so*' \) \
                 -exec install -m 0644 {} "$DEST/bin/" \; 2>/dev/null || true
            LD_LIBRARY_PATH="$DEST/bin" "$DEST/bin/whisper-server" --help >/dev/null 2>&1 \
                || { echo "  échec : le binaire recompilé ne démarre pas non plus." >&2; exit 1; }
            echo "  recompilé sur place"
        else
            echo "  ni cmake ni source vendorisée : refaites le lot sur une machine" >&2
            echo "  de même distribution que celle-ci (cf. l'avertissement de fetch_offline.sh)." >&2
            exit 1
        fi
    else
        echo "  binaire vendorisé fonctionnel"
    fi

    cp -a "$LOT/models/." "$DEST/models/" 2>/dev/null || true
    if [ -n "$MODELE_VOULU" ]; then
        MODELE="$DEST/models/ggml-${MODELE_VOULU}.bin"
        [ -s "$MODELE" ] || { echo "  modèle absent du lot : $MODELE_VOULU" >&2
                              echo "  présents : $(cd "$DEST/models" && ls ggml-*.bin 2>/dev/null | tr '\n' ' ')" >&2
                              exit 1; }
    else
        # Le PLUS PETIT par défaut. Un lot peut en embarquer plusieurs ; sur une
        # machine dont on ne sait rien, le léger tourne partout, le gros ne
        # tourne bien qu'avec un GPU. On dit comment changer juste en dessous.
        MODELE="$(find "$DEST/models" -name 'ggml-*.bin' -printf '%s %p\n' 2>/dev/null \
                  | sort -n | head -1 | cut -d' ' -f2-)"
    fi
    [ -n "$MODELE" ] || { echo "  aucun modèle ggml-*.bin dans le lot" >&2; exit 1; }
    echo "  modèle : $(basename "$MODELE") ($(du -h "$MODELE" | cut -f1))"
    AUTRES="$(cd "$DEST/models" && ls ggml-*.bin 2>/dev/null | grep -v "^$(basename "$MODELE")$" | tr '\n' ' ')"
    [ -n "$AUTRES" ] && echo "  aussi dans le lot : $AUTRES(--model <nom-sans-ggml-ni-.bin> pour en choisir un)"

    sed -e "s#/opt/elpis-voice#$DEST#g" \
        -e "s#ggml-small-q5_1.bin#$(basename "$MODELE")#g" \
        -e "s#^Environment=WHISPER_HOST=.*#Environment=WHISPER_HOST=$ECOUTE#" \
        "$ICI/stt/elpis-whisper.service" > /etc/systemd/system/elpis-whisper.service
fi

# ── Synthèse ─────────────────────────────────────────────────────────────────
if [ "$AVEC_TTS" = "1" ]; then
    echo "--- Synthèse ---"
    install -m 0644 "$ICI/tts/tts_service.py"   "$DEST/tts/tts_service.py"
    install -m 0644 "$ICI/tts/requirements.txt" "$DEST/tts/requirements.txt"
    cp -a "$LOT/voices/." "$DEST/voices/" 2>/dev/null || true
    # La voix par défaut du service doit être celle que `config.json` demande
    # côté Elpis, sinon le service charge une voix au démarrage et l'application
    # en réclame une autre à la première phrase. Un ordre alphabétique aurait
    # suffi tant qu'il n'y avait qu'une voix ; il ne suffit plus à quatre.
    VOIX=""
    for pref in "$VOIX_VOULUE" fr_FR-siwis-medium; do
        [ -n "$pref" ] && [ -s "$DEST/voices/$pref.onnx" ] && VOIX="$pref" && break
    done
    if [ -z "$VOIX" ]; then
        VOIX="$(find "$DEST/voices" -name '*.onnx' | sort | head -1)"
        [ -n "$VOIX" ] || { echo "  aucune voix .onnx dans le lot" >&2; exit 1; }
        VOIX="$(basename "$VOIX" .onnx)"
    fi
    AUTRES_VOIX="$(cd "$DEST/voices" && ls *.onnx 2>/dev/null | sed 's/\.onnx$//' \
                   | grep -v "^$VOIX$" | tr '\n' ' ')"
    echo "  voix : $VOIX"
    [ -n "$AUTRES_VOIX" ] && echo "  aussi installées : $AUTRES_VOIX"

    # Python de la cible. Le cas courant : la machine a python3 mais PAS
    # python3-venv — ensurepip vit dans un paquet séparé sous Debian, et
    # ``python3 -m venv`` s'arrête net. Le lot embarque les .deb ; on ne s'en
    # sert que si le nécessaire manque vraiment.
    if ! command -v python3 >/dev/null 2>&1 || ! python3 -c 'import venv, ensurepip' 2>/dev/null; then
        if ls "$LOT"/debs/*.deb >/dev/null 2>&1; then
            echo "  python3/venv incomplet : installation des paquets vendorisés"
            dpkg -i "$LOT"/debs/*.deb >/dev/null 2>&1 || dpkg --configure -a >/dev/null 2>&1 || true
        fi
        command -v python3 >/dev/null 2>&1 && python3 -c 'import venv, ensurepip' 2>/dev/null || {
            echo "  python3 avec le module venv est indispensable au service de synthèse." >&2
            echo "  Sur Debian/Ubuntu : apt-get install python3 python3-venv" >&2
            echo "  (ou refaites le lot : fetch_offline.sh --docker <image> embarque les .deb)" >&2
            exit 1
        }
    fi

    [ -x "$DEST/tts/venv/bin/python" ] || python3 -m venv "$DEST/tts/venv"
    # --no-index : aucune sortie réseau, même si un index est configuré.
    if ! "$DEST/tts/venv/bin/pip" install --no-index --find-links "$LOT/wheels" \
            -r "$DEST/tts/requirements.txt" --quiet; then
        echo "  pip a refusé les roues vendorisées." >&2
        echo "  Cause la plus probable : python $("$DEST/tts/venv/bin/python" -V 2>&1 | cut -d' ' -f2)" >&2
        echo "  ici, contre une autre version sur la machine de préparation." >&2
        echo "  Refaites le lot avec le même x.y : fetch_offline.sh --python pythonX.Y" >&2
        exit 1
    fi

    if [ ! -s "$DEST/tts/token.env" ]; then
        ( umask 077; printf 'ELPIS_TTS_TOKEN=%s\n' \
            "$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')" > "$DEST/tts/token.env" )
        echo "  jeton généré : $DEST/tts/token.env"
    fi

    sed -e "s#/opt/elpis-voice#$DEST#g" -e "s#__VOIX__#$VOIX#g" \
        -e "s#^Environment=ELPIS_TTS_HOST=.*#Environment=ELPIS_TTS_HOST=$ECOUTE#" \
        "$ICI/tts/elpis-tts.service" > /etc/systemd/system/elpis-tts.service
fi

chown -R elpis:elpis "$DEST"
systemctl daemon-reload

echo
echo "Installé dans $DEST."
echo "Démarrage :"
[ "$AVEC_STT" = "1" ] && echo "    sudo systemctl enable --now elpis-whisper"
[ "$AVEC_TTS" = "1" ] && echo "    sudo systemctl enable --now elpis-tts"
echo
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$IP" ] || IP="<ip-de-cette-machine>"
case "$ECOUTE" in
    127.0.0.1) IP=127.0.0.1
               echo "Écoute locale (127.0.0.1) : Elpis doit tourner sur cette machine (--lan sinon)." ;;
    0.0.0.0)   ;;
    *)         IP="$ECOUTE" ;;
esac
echo "À saisir dans Elpis (Configuration > Connexions > Moteur vocal) :"
[ "$AVEC_STT" = "1" ] && echo "    Adresse STT : http://$IP:8090"
[ "$AVEC_TTS" = "1" ] && echo "    Adresse TTS : http://$IP:8091"
echo
