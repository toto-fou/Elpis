#!/bin/bash
# SPDX-License-Identifier: MIT
# =====================================================================
#  fetch_offline.sh — prépare le LOT HORS-LIGNE du moteur vocal.
#
#  À lancer sur une machine CONNECTÉE (le poste de développement fait
#  l'affaire), puis à transporter par COPIE du dossier deploy/voice/.
#
#    bash deploy/voice/fetch_offline.sh [--model small-q5_1,large-v3-turbo-q5_0]
#                                       [--voices fr_FR-siwis-medium,fr_FR-tom-medium]
#                                       [--target cpu|cuda|vulkan|rocm]
#                                       [--python python3]
#                                       [--skip-build] [--with-debs]
#
#  Produit deploy/voice/offline/ :
#      bin/       whisper-server COMPILÉ ICI + ses bibliothèques
#      models/    ggml-<modele>.bin
#      voices/    les voix Piper (.onnx + .onnx.json)
#      wheels/    les roues Python du service de synthèse
#      debs/      python3 + python3-venv (seulement avec --with-debs)
#      src/       la source whisper.cpp (repli si le binaire ne tourne pas)
#      MANIFEST.txt
#
#  La cible n'a alors besoin d'AUCUN accès réseau, ni compilateur, ni pip.
#
#  ⚠ Le binaire est compilé ici : il doit tourner là-bas. Compilez sur une
#    machine de même distribution (ou plus ancienne) que la cible — la glibc
#    n'est pas rétro-compatible. install_offline.sh vérifie que le binaire
#    démarre et recompile depuis src/ si ce n'est pas le cas.
# =====================================================================
set -euo pipefail

# small par défaut : la cible par défaut est le CPU (--target cpu), où les
# modèles plus gros ne suivent pas le débit de la parole.
MODELE="small-q5_1"
VOIX="fr_FR-siwis-medium"
CIBLE="cpu"
PY="python3"
IMAGE=""
SANS_BUILD=0
AVEC_DEBS=0
while [ $# -gt 0 ]; do
    case "$1" in
        --model)  MODELE="$2"; shift 2 ;;
        --voices) VOIX="$2";   shift 2 ;;
        --target) CIBLE="$2";  shift 2 ;;
        --python) PY="$2";     shift 2 ;;
        # Compile et télécharge les roues DANS cette image Docker. C'est LA
        # façon de produire un lot pour une distribution différente de celle du
        # poste de préparation : la glibc n'est pas rétro-compatible, et un
        # binaire compilé sur Debian 13 ne démarre pas sur Debian 12.
        --docker) IMAGE="$2";  shift 2 ;;
        # Ne touche NI au binaire NI aux roues : n ajoute que des modeles et
        # des voix a un lot deja constitue. Indispensable quand le lot a ete
        # compile pour une autre distribution que le poste de preparation :
        # sans cela, une simple relance ecraserait le binaire Debian 12 par
        # un binaire compile ici, qui ne demarrerait pas la-bas.
        --skip-build) SANS_BUILD=1; shift ;;
        # python3 et python3-venv en .deb, pour une cible SANS depot Debian
        # local. Inutile autrement : ce sont des paquets de base, et le lot
        # n a vocation a porter que ce qui ne se trouve pas dans un depot
        # (le binaire whisper, ses libs, les roues piper/onnxruntime).
        --with-debs) AVEC_DEBS=1; shift ;;
        -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
        *) echo "Option inconnue : $1" >&2; exit 2 ;;
    esac
done

ICI="$(cd "$(dirname "$0")" && pwd)"
LOT="$ICI/offline"
WHISPER_VERSION="${WHISPER_VERSION:-master}"
HF_WHISPER="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"
HF_PIPER="https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR"

# Chemin HuggingFace de chaque voix française.
voix_chemin() {
    case "$1" in
        fr_FR-siwis-medium)  echo "siwis/medium" ;;
        fr_FR-siwis-low)     echo "siwis/low" ;;
        fr_FR-upmc-medium)   echo "upmc/medium" ;;
        fr_FR-tom-medium)    echo "tom/medium" ;;
        fr_FR-gilles-low)    echo "gilles/low" ;;
        fr_FR-mls-medium)    echo "mls/medium" ;;
        fr_FR-mls_1840-low)  echo "mls_1840/low" ;;
        *) return 1 ;;
    esac
}

# Téléchargement idempotent : .part puis renommage, pour qu'une coupure ne
# laisse jamais un fichier tronqué qui passerait pour complet.
telecharge() {
    local url="$1" dest="$2"
    if [ -s "$dest" ]; then echo "    déjà là : $(basename "$dest")"; return; fi
    echo "    $(basename "$dest")"
    curl -fL --progress-bar -o "$dest.part" "$url"
    mv "$dest.part" "$dest"
}

mkdir -p "$LOT/bin" "$LOT/models" "$LOT/voices" "$LOT/wheels" "$LOT/src"

if [ "$SANS_BUILD" = "1" ]; then
    echo "--- 1/5 + 2/5  Binaire conservé (--skip-build) ---"
    [ -x "$LOT/bin/whisper-server" ] \
        || { echo "Aucun binaire dans $LOT/bin : --skip-build n a rien a conserver." >&2; exit 1; }
    echo "    $(cat "$LOT/DISTRIBUTION" 2>/dev/null || echo 'origine inconnue')"
else

echo "--- 1/5  Source whisper.cpp ($WHISPER_VERSION) ---"
SRC="$LOT/src/whisper.cpp"
# Le conteneur de compilation tourne en root : git de l hote refuse ensuite de
# travailler dans un depot dont le proprietaire a change (« dubious ownership »).
git config --global --add safe.directory "$SRC" 2>/dev/null || true
if [ -d "$SRC/.git" ]; then
    git -C "$SRC" fetch --depth 1 origin "$WHISPER_VERSION" && git -C "$SRC" checkout -f FETCH_HEAD
else
    git clone --depth 1 --branch "$WHISPER_VERSION" https://github.com/ggml-org/whisper.cpp "$SRC" \
        || git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$SRC"
fi
git -C "$SRC" rev-parse --short HEAD > "$LOT/src/REVISION"

if [ -n "$IMAGE" ]; then
    echo "--- 2/5 + 5/5  Compilation et roues DANS $IMAGE ---"
    command -v docker >/dev/null 2>&1 || { echo "docker introuvable" >&2; exit 1; }
    docker run --rm -v "$LOT:/lot" -v "$ICI/tts:/tts:ro" \
        -e CIBLE="$CIBLE" -e UIDGID="$(id -u):$(id -g)" \
        "$IMAGE" bash -c '
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
# Le conteneur tourne en root : sans ce piege, un echec de compilation laisse
# une arborescence root sur l hote, que la relance ne peut plus effacer.
trap "chown -R $UIDGID /lot 2>/dev/null || true" EXIT
echo "  distribution du conteneur : $(. /etc/os-release && echo "$PRETTY_NAME")"
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
    build-essential cmake git ca-certificates curl python3-venv python3-pip
# -DGGML_NATIVE=OFF est OBLIGATOIRE pour un lot redistribuable : par defaut
# ggml compile en -march=native, donc pour le processeur de la machine de
# PREPARATION. Le binaire mourrait en SIGILL sur une cible plus ancienne. Et
# cela debloque aussi la compilation avec GCC 12 (Debian 12), qui refuse
# d inliner les intrinsics FMA hors du contexte -mfma explicite.
# (Pas d apostrophe dans ce bloc : il vit dans un bash -c entre quotes simples.)
FLAGS="-DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DGGML_NATIVE=OFF"
case "$CIBLE" in
    cuda)   FLAGS="$FLAGS -DGGML_CUDA=ON" ;;
    vulkan) FLAGS="$FLAGS -DGGML_VULKAN=ON" ;;
    rocm)   FLAGS="$FLAGS -DGGML_HIP=ON" ;;
esac
cmake -S /lot/src/whisper.cpp -B /lot/src/whisper.cpp/build $FLAGS >/dev/null
cmake --build /lot/src/whisper.cpp/build --config Release -j "$(nproc)" >/dev/null
for c in /lot/src/whisper.cpp/build/bin/whisper-server \
         /lot/src/whisper.cpp/build/bin/server; do
    [ -x "$c" ] && install -m 0755 "$c" /lot/bin/whisper-server && break
done
[ -x /lot/bin/whisper-server ] || { echo "whisper-server introuvable" >&2; exit 1; }
find /lot/src/whisper.cpp/build \( -name "libggml*.so*" -o -name "libwhisper*.so*" \) \
     -exec install -m 0644 {} /lot/bin/ \; 2>/dev/null || true
# Dependances HORS glibc : presentes ici parce que build-essential les tire,
# absentes dune Debian minimale et de beaucoup de serveurs nus. Le lot doit
# etre autonome : on les embarque a cote du binaire, ou LD_LIBRARY_PATH les
# trouvera. libgomp = runtime OpenMP, exige par ggml.
for extra in libgomp.so.1; do
    # sed plutot que awk : pas de $NF a echapper dans un bash -c deja entre
    # quotes simples. La sortie de ldconfig est « nom (abi) => /chemin/complet ».
    src="$(ldconfig -p | sed -n "s|.*=> \(/.*$extra\)|\1|p" | head -1)"
    if [ -n "$src" ] && [ -e "$src" ]; then
        install -m 0644 "$src" "/lot/bin/$extra" && echo "  vendorise : $extra"
    else
        echo "  ATTENTION : $extra introuvable, le lot ne sera pas autonome" >&2
    fi
done
# Les roues doivent correspondre au Python de la CIBLE : celui du conteneur EST
# celui de la distribution visée.
python3 -m pip download -q -r /tts/requirements.txt -d /lot/wheels
python3 -V > /lot/PYTHON_CIBLE
. /etc/os-release && echo "$PRETTY_NAME (glibc $(ldd --version | head -1 | grep -oE "[0-9]+\.[0-9]+$"))" > /lot/DISTRIBUTION
chown -R "$UIDGID" /lot
'
    # L image est le renseignement qui permet de REFAIRE le lot a l identique ;
    # elle n est connue que de l hote, pas du conteneur qui a ecrit le fichier.
    [ -s "$LOT/DISTRIBUTION" ] && sed -i "1s|^|$IMAGE — |" "$LOT/DISTRIBUTION"
    echo "    $(cat "$LOT/DISTRIBUTION" 2>/dev/null)"
    echo "    $(cat "$LOT/PYTHON_CIBLE" 2>/dev/null)"

    # ── Python de la cible, en paquets ──────────────────────────────────────
    # Une Debian nue n a pas python3, et celles qui l ont n ont presque jamais
    # python3-venv (ensurepip vit dans un paquet a part). Sans ces .deb, le lot
    # est autonome pour la reconnaissance et bloque net sur la synthese.
    # Conteneur NEUF a chaque fois : celui de la compilation a deja les paquets
    # installes, donc --download-only n y telechargerait rien.
    if [ "$AVEC_DEBS" = "1" ]; then
    echo "--- 2bis/5  Paquets python de la cible ---"
    docker run --rm -v "$LOT:/lot" -e UIDGID="$(id -u):$(id -g)" "$IMAGE" bash -c '
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
trap "chown -R $UIDGID /lot/debs 2>/dev/null || true" EXIT
mkdir -p /lot/debs && rm -f /lot/debs/*.deb
apt-get update -qq
apt-get install -y -qq --no-install-recommends --download-only python3 python3-venv
cp /var/cache/apt/archives/*.deb /lot/debs/
' >/dev/null 2>&1 || { echo "    ATTENTION : paquets python non recuperes" >&2; }
    echo "    $(ls "$LOT/debs"/*.deb 2>/dev/null | wc -l) paquet(s), $(du -sh "$LOT/debs" 2>/dev/null | cut -f1)"
    fi
else

echo "--- 2/5  Compilation (cible : $CIBLE) ---"
# -DGGML_NATIVE=OFF est OBLIGATOIRE pour un lot redistribuable : par defaut
# ggml compile en -march=native, donc pour le processeur de la machine de
# PREPARATION. Le binaire mourrait en SIGILL sur une cible plus ancienne. Et
# cela debloque aussi la compilation avec GCC 12 (Debian 12), qui refuse
# d inliner les intrinsics FMA hors du contexte -mfma explicite.
# (Pas d apostrophe dans ce bloc : il vit dans un bash -c entre quotes simples.)
FLAGS="-DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DGGML_NATIVE=OFF"
case "$CIBLE" in
    cpu)    ;;
    cuda)   FLAGS="$FLAGS -DGGML_CUDA=ON" ;;
    vulkan) FLAGS="$FLAGS -DGGML_VULKAN=ON" ;;
    rocm)   FLAGS="$FLAGS -DGGML_HIP=ON" ;;
    *) echo "Cible inconnue : $CIBLE (cpu|cuda|vulkan|rocm)" >&2; exit 2 ;;
esac
cmake -S "$SRC" -B "$SRC/build" $FLAGS
cmake --build "$SRC/build" --config Release -j "$(nproc)"

TROUVE=""
for c in "$SRC/build/bin/whisper-server" "$SRC/build/bin/server" \
         "$SRC/build/examples/server/whisper-server"; do
    [ -x "$c" ] && TROUVE="$c" && break
done
[ -n "$TROUVE" ] || { echo "whisper-server introuvable après compilation" >&2; exit 1; }
install -m 0755 "$TROUVE" "$LOT/bin/whisper-server"
# Les backends (BLAS, CUDA, Vulkan) sont des bibliothèques chargées
# dynamiquement À CÔTÉ du binaire : sans elles, il retombe en CPU nu.
find "$SRC/build" \( -name 'libggml*.so*' -o -name 'libwhisper*.so*' \) -exec install -m 0644 {} "$LOT/bin/" \; 2>/dev/null || true
echo "    binaire + $(find "$LOT/bin" -name '*.so*' | wc -l) bibliothèque(s)"

fi
echo "$CIBLE" > "$LOT/CIBLE"
fi

echo "--- 3/5  Modèles de reconnaissance ---"
# Liste : on embarque volontiers un gros modèle ET un léger, pour pouvoir
# retomber sur le second si la machine cible n'a pas de GPU.
IFS=',' read -ra MODELES <<< "$MODELE"
for m in "${MODELES[@]}"; do
    m="$(echo "$m" | tr -d ' ')"
    [ -n "$m" ] || continue
    telecharge "$HF_WHISPER/ggml-${m}.bin" "$LOT/models/ggml-${m}.bin"
done

echo "--- 4/5  Voix Piper ---"
IFS=',' read -ra LISTE <<< "$VOIX"
for nom in "${LISTE[@]}"; do
    nom="$(echo "$nom" | tr -d ' ')"
    if ! chemin="$(voix_chemin "$nom")"; then
        echo "    voix inconnue, ignorée : $nom" >&2
        continue
    fi
    telecharge "$HF_PIPER/$chemin/$nom.onnx"      "$LOT/voices/$nom.onnx"
    telecharge "$HF_PIPER/$chemin/$nom.onnx.json" "$LOT/voices/$nom.onnx.json"
done

if [ -z "$IMAGE" ] && [ "$SANS_BUILD" != "1" ]; then
echo "--- 5/5  Roues Python du service de synthèse ---"
# ⚠ Les roues sont liées à la version de Python ET à l'architecture. Utilisez
#   le MÊME Python mineur que la cible, sinon pip refusera de les installer.
echo "    python : $("$PY" -V 2>&1) — la cible doit avoir le même x.y"
"$PY" -m pip download -r "$ICI/tts/requirements.txt" -d "$LOT/wheels" \
    || { echo "pip download a échoué — pip est-il à jour ?" >&2; exit 1; }
fi

echo "--- MANIFEST ---"
{
    echo "# Lot hors-ligne du moteur vocal Elpis"
    echo "# produit le $(date -Iseconds) sur $(uname -srm)"
    echo "# whisper.cpp $(cat "$LOT/src/REVISION") compilé pour : $(cat "$LOT/CIBLE" 2>/dev/null || echo "$CIBLE")"
    # La provenance décrit le BINAIRE DU LOT, pas la machine qui lance le
    # script : avec --skip-build, ce sont deux distributions différentes, et
    # c est la première qui décide si le binaire démarrera sur la cible.
    if [ -s "$LOT/DISTRIBUTION" ]; then
        echo "# compilé dans : $(cat "$LOT/DISTRIBUTION")"
        echo "# python des roues : $(cat "$LOT/PYTHON_CIBLE" 2>/dev/null)"
    else
        echo "# compilé sur : $(. /etc/os-release && echo "$PRETTY_NAME")"
        echo "# python des roues : $("$PY" -V 2>&1)"
    fi
    echo
    ( cd "$LOT" && PARTIES=""
      for d in bin models voices wheels debs; do [ -d "$d" ] && PARTIES="$PARTIES $d"; done
      find $PARTIES -type f -print0 | sort -z | xargs -0 sha256sum )
} > "$LOT/MANIFEST.txt"

# ── Épreuve : le binaire DÉMARRE-T-IL dans la distribution visée ? ───────────
# Un lot qui se déclare prêt sans que personne n'ait lancé le binaire, c'est la
# panne découverte à l'installation, sur la machine du client. Deux minutes ici
# valent mieux qu'un aller-retour là-bas.
if [ -n "$IMAGE" ] && [ "$SANS_BUILD" != "1" ] && [ -x "$LOT/bin/whisper-server" ]; then
    echo "--- Épreuve dans $IMAGE ---"
    if docker run --rm -v "$LOT:/lot:ro" "$IMAGE" \
        env LD_LIBRARY_PATH=/lot/bin /lot/bin/whisper-server --help >/dev/null 2>&1; then
        echo "    le binaire démarre"
    else
        echo "    ÉCHEC : le binaire ne démarre pas dans $IMAGE." >&2
        echo "    Le lot n'est pas utilisable en l'état." >&2
        exit 1
    fi
    # Version de glibc réellement exigée : c'est ELLE qui décide si le binaire
    # tournera sur la cible, pas la distribution du conteneur.
    besoin="$(docker run --rm -v "$LOT:/lot:ro" "$IMAGE" bash -c \
        'apt-get install -y -qq binutils >/dev/null 2>&1; objdump -T /lot/bin/whisper-server 2>/dev/null \
         | grep -oE "GLIBC_[0-9]+\.[0-9]+" | sort -uV | tail -1' 2>/dev/null || true)"
    [ -n "$besoin" ] && echo "    glibc exigée : ${besoin#GLIBC_}"

    # Et l'autre moitié du lot : les roues s'installent-elles VRAIMENT, hors
    # ligne, avec le Python de la cible ? C'est le point qui casse le plus
    # souvent (décalage de version), et il ne se voit qu'à l'essai.
    if docker run --rm -v "$LOT:/lot:ro" -v "$ICI/tts:/tts:ro" "$IMAGE" bash -c '
set -e
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq --no-install-recommends python3-venv >/dev/null 2>&1
python3 -m venv /tmp/v
/tmp/v/bin/pip install --no-index --find-links /lot/wheels -r /tts/requirements.txt --quiet
/tmp/v/bin/python -c "import fastapi, uvicorn, numpy, onnxruntime, piper"
' >/dev/null 2>&1; then
        echo "    les roues s'installent hors ligne"
    else
        echo "    ÉCHEC : les roues ne s'installent pas dans $IMAGE." >&2
        echo "    Version de Python de la cible ? Roues manquantes ?" >&2
        exit 1
    fi
fi

echo
echo "Lot prêt : $LOT ($(du -sh "$LOT" | cut -f1))"
du -sh "$LOT"/bin "$LOT"/models "$LOT"/voices "$LOT"/wheels "$LOT"/debs 2>/dev/null | sed 's/^/    /'
echo
echo "Transportez le dossier deploy/voice/ tel quel, puis sur la cible :"
echo "    sudo bash deploy/voice/install_offline.sh"
