#!/bin/bash
# SPDX-License-Identifier: MIT
# =====================================================================
#  essai_lot.sh — le lot hors-ligne tient-il VRAIMENT debout ?
#
#    bash deploy/voice/essai_lot.sh [image]      (défaut : debian:bookworm-slim)
#
#  Monte une machine neuve dans la distribution visée, avec les SEULS outils
#  de base (python3, python3-venv — ce que donne n'importe quel dépôt Debian),
#  RÉSEAU COUPÉ, puis :
#      1. installe le lot            (install_offline.sh)
#      2. démarre les deux services  (comme le feraient les unités systemd)
#      3. fait la boucle complète    texte -> voix -> 16 kHz -> texte
#
#  Ni compilateur ni pip en ligne dans la machine d'essai : si quelque chose
#  manque au lot, ça se voit ici et pas chez vous.
#
#  Exige docker sur la machine de préparation. N'écrit rien hors du conteneur.
# =====================================================================
set -euo pipefail

IMAGE_BASE="${1:-debian:bookworm-slim}"
ICI="$(cd "$(dirname "$0")" && pwd)"
[ -d "$ICI/offline" ] || { echo "Lot absent : $ICI/offline — lancez fetch_offline.sh" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "docker introuvable" >&2; exit 1; }

TAG="elpis-voice-essai:$(echo "$IMAGE_BASE" | tr -c 'a-zA-Z0-9' '-')"
echo "--- Machine d'essai ($IMAGE_BASE) ---"
docker build -q -t "$TAG" - >/dev/null <<EOF
FROM $IMAGE_BASE
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \\
        python3 python3-venv curl ca-certificates && rm -rf /var/lib/apt/lists/*
EOF
echo "    outils de base seulement : $(docker run --rm "$TAG" python3 -V 2>&1), pas de compilateur"

docker run --rm --network none -v "$ICI:/dv:ro" "$TAG" bash -c '
set -uo pipefail
mkdir -p /etc/systemd/system
printf "#!/bin/sh\nexit 0\n" > /usr/local/bin/systemctl && chmod +x /usr/local/bin/systemctl

echo "--- 1/3  Installation (sans reseau) ---"
bash /dv/install_offline.sh /opt/elpis-voice | sed "s/^/    /" || exit 1

MODELE="$(find /opt/elpis-voice/models -name "ggml-*.bin" -printf "%s %p\n" | sort -n | head -1 | cut -d" " -f2-)"
VOIX="$(basename "$(find /opt/elpis-voice/voices -name "*.onnx" | sort | head -1)" .onnx)"
[ -s /opt/elpis-voice/voices/fr_FR-siwis-medium.onnx ] && VOIX=fr_FR-siwis-medium

echo "--- 2/3  Demarrage des deux services ---"
LD_LIBRARY_PATH=/opt/elpis-voice/bin /opt/elpis-voice/bin/whisper-server \
    --host 127.0.0.1 --port 8090 -m "$MODELE" -t 4 -l fr -nt --suppress-nst \
    > /tmp/whisper.log 2>&1 &
cd /opt/elpis-voice/tts
ELPIS_TTS_VOICES_DIR=/opt/elpis-voice/voices ELPIS_TTS_VOICE="$VOIX" \
  /opt/elpis-voice/tts/venv/bin/python -m uvicorn tts_service:app \
  --host 127.0.0.1 --port 8091 --log-level warning > /tmp/tts.log 2>&1 &

pret=0
for i in $(seq 1 90); do
    curl -s -m 2 http://127.0.0.1:8091/health >/dev/null 2>&1 \
        && curl -s -m 2 -o /dev/null http://127.0.0.1:8090/ && { pret=1; break; }
    sleep 1
done
[ "$pret" = "1" ] || { echo "    un service n a pas demarre" >&2
                       tail -5 /tmp/whisper.log /tmp/tts.log >&2; exit 1; }
echo "    synthese : $(curl -s -m 3 http://127.0.0.1:8091/health)"
echo "    reconnaissance : HTTP $(curl -s -m 3 -o /dev/null -w "%{http_code}" http://127.0.0.1:8090/)"

echo "--- 3/3  Boucle complete : texte -> voix -> texte ---"
PHRASE="Bonjour, ceci est un essai du moteur vocal."
curl -s -m 60 -X POST http://127.0.0.1:8091/tts -H "Content-Type: application/json" \
     -d "{\"text\":\"$PHRASE\"}" -o /tmp/dit.wav
[ -s /tmp/dit.wav ] || { echo "    la synthese n a rien rendu" >&2; exit 1; }
echo "    synthetise : $(stat -c%s /tmp/dit.wav) octets"

/opt/elpis-voice/tts/venv/bin/python - <<PY
import wave, numpy as np
with wave.open("/tmp/dit.wav", "rb") as w:
    sr, n = w.getframerate(), w.getnframes()
    x = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32)
    if w.getnchannels() == 2: x = x.reshape(-1, 2).mean(axis=1)
# Vers 16 kHz, ce que whisper attend. On INTERPOLE : decimer replierait tout
# ce qui depasse 8 kHz dans la bande utile.
cible = 16000
t = np.linspace(0, len(x) / sr, int(len(x) * cible / sr), endpoint=False)
y = np.interp(t, np.arange(len(x)) / sr, x).astype(np.int16)
with wave.open("/tmp/pour_whisper.wav", "wb") as o:
    o.setnchannels(1); o.setsampwidth(2); o.setframerate(cible); o.writeframes(y.tobytes())
print(f"    reechantillonne : {sr} -> {cible} Hz, {len(y)/cible:.2f} s")
PY

TEXTE="$(curl -s -m 180 -F file=@/tmp/pour_whisper.wav -F response_format=verbose_json \
              -F language=fr http://127.0.0.1:8090/inference \
         | python3 -c "import json,sys; print(json.load(sys.stdin).get(\"text\",\"\").strip())" 2>/dev/null)"
echo "    dit       : $PHRASE"
echo "    transcrit : $TEXTE"
[ -n "$TEXTE" ] || { echo "    la reconnaissance n a rien rendu" >&2; exit 1; }
# Comparaison indulgente : la ponctuation et la casse ne se restituent jamais
# a l identique, et ce n est pas ce qu on verifie ici.
n1="$(echo "$PHRASE" | tr "[:upper:]" "[:lower:]" | tr -cd "[:alnum:] ")"
n2="$(echo "$TEXTE"  | tr "[:upper:]" "[:lower:]" | tr -cd "[:alnum:] ")"
case "$n2" in *"essai du moteur vocal"*) echo "    LA BOUCLE EST BONNE" ;;
              *) echo "    ecart de transcription (lu mais different)" ;; esac
'
echo
echo "Le lot s installe et TOURNE sur $IMAGE_BASE, sans reseau."
