#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# ─────────────────────────────────────────────────────────────────────
#  build_offline.sh — Build de elpis/sandbox:1.7.0
#
#  Deux modes :
#    • EN LIGNE (défaut, utilisé par ./install.sh) : télécharge les binaires
#      vendorisés, puis `docker build` avec pip sur PyPI. L'image finit dans
#      le daemon local, aucune archive n'est produite.
#    • ARCHIVE (--archive) : pré-compile les wheels (build_assets/), build
#      sans PyPI, puis exporte un .tar.gz à charger sur une machine sans
#      réseau (load_image.sh, ou l'app au premier usage).
#
#  Usage
#  -----
#    ./build_offline.sh                En ligne : image construite dans le
#                                      daemon local.
#    ./build_offline.sh --archive      Mode archive → produit le .tar.gz.
#    ./build_offline.sh --archive --load
#                                      Archive + `docker load` immédiat.
#    ./build_offline.sh --load-only    Skip le build, charge uniquement le
#                                      .tar.gz existant.
#    ./build_offline.sh --print-image  Affiche le tag de l'image et sort.
#    ./build_offline.sh --help   (-h)  Affiche cette aide.
#
#  Correctif vs version précédente
#  -------------------------------
#  L'étape "pip wheel" tournait dans `bash -c "... | tail"`, ce qui
#  masquait le code de sortie de pip (le pipe renvoyait celui de `tail`).
#  Un échec de compilation des wheels passait donc inaperçu et le build
#  continuait avec un dossier wheels vide → "No matching distribution".
#  Désormais : sortie complète affichée, et garde-fou explicite si les
#  wheels ne sont pas produites.
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

IMAGE="elpis/sandbox:1.7.0"
ARCHIVE="elpis-sandbox-1.7.0.tar.gz"
# Version mikefarah de yq (Go binary, ~5 MB). Bumper si une CVE sort.
YQ_VERSION="v4.44.3"
# Binaires DX / DB vendorisés en 1.5.0 (Go/Rust statiques). Bumper au besoin.
GH_VERSION="2.62.0"           # GitHub CLI — asset gh_${V}_linux_amd64.tar.gz
SHFMT_VERSION="v3.10.0"       # formateur shell (binaire brut)
HADOLINT_VERSION="v2.12.0"    # linter Dockerfile (binaire brut)
DUCKDB_VERSION="v1.1.3"       # base analytique embarquée — CLI (zip)
DELTA_VERSION="0.18.2"        # pager de diff git (tar.gz)
# Reverse-eng : radare2 ET upx ont été RETIRÉS de Debian bookworm (main) →
# plus d'`apt install`. On les vendorise comme gh/delta (build machine a le net).
UPX_VERSION="4.2.4"           # packer/unpacker ELF/PE — binaire statique
RADARE2_VERSION="5.9.8"       # framework de reverse — .deb self-contained (Depends: libc6)
# Version de geckodriver. DOIT suivre la série Firefox ESR embarquée :
# 0.37.0 est le driver apparié pour Firefox 140.* (0.36.0 déclenchait le
# warning de compat SeleniumLibrary "geckodriver 0.37.0 is recommended").
GECKODRIVER_VERSION="v0.37.0"
# Nombre minimum de wheels attendu (revu à la hausse en 1.5.0 : ajout des
# bundles DB-analyse — sqlglot/sqlfluff/sqlparse/alembic/pyodbc/pymssql/duckdb,
# analyse binaire — pefile/dnfile/capstone/pyelftools/oletools/yara-python/
# python-registry, et data/dev — matplotlib/scipy/pre-commit).
MIN_WHEELS=100

cd "$(dirname "$0")"

# ─── CLI parsing ─────────────────────────────────────────────────────
DO_BUILD=1
DO_LOAD=0
DO_ARCHIVE=0

usage() {
    sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            usage; exit 0 ;;
        -l|--load)
            DO_LOAD=1; DO_ARCHIVE=1; shift ;;
        --archive|--offline)
            DO_ARCHIVE=1; shift ;;
        --online)
            DO_ARCHIVE=0; shift ;;
        --print-image)
            echo "$IMAGE"; exit 0 ;;
        --load-only)
            DO_BUILD=0; DO_LOAD=1; shift ;;
        *)
            echo "✗ option inconnue : $1" >&2
            echo "  Voir : $0 --help" >&2
            exit 2 ;;
    esac
done

# Helper utilisé par --load et --load-only.
load_archive() {
    if [[ ! -f "$ARCHIVE" ]]; then
        echo "✗ Archive $ARCHIVE introuvable — impossible de charger." >&2
        echo "  Construis-la d'abord : $0 (sans --load-only)." >&2
        exit 1
    fi
    if ! command -v docker >/dev/null 2>&1; then
        echo "✗ docker absent du PATH — installe docker pour pouvoir loader." >&2
        exit 1
    fi
    echo "═══ Load de l'image dans le daemon local ═══"
    echo "    Source : $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
    # `docker load` remplace toute image ayant le même tag.
    docker load -i "$ARCHIVE"
    # Confirmation : on s'attend à voir IMAGE dans le `docker images`.
    if docker image inspect "$IMAGE" >/dev/null 2>&1; then
        echo "    ✓ $IMAGE est désormais l'image active sur ce daemon."
    else
        echo "✗ ÉCHEC : $IMAGE n'apparaît pas après load." >&2
        exit 1
    fi
}

# ─── Court-circuit pour --load-only ──────────────────────────────────
if [[ "$DO_BUILD" -eq 0 ]]; then
    load_archive
    exit 0
fi

mkdir -p build_assets/{firefox,gecko,yq,gh,shfmt,hadolint,duckdb,delta,upx,radare2}

# ─── 1. Firefox ESR ──────────────────────────────────────────────────
echo "═══ 1. Firefox ESR ═══"
if [[ ! -f build_assets/firefox/firefox-esr.tar.bz2 ]]; then
    curl -fL --retry 3 -o build_assets/firefox/firefox-esr.tar.bz2 \
        "https://download.mozilla.org/?product=firefox-esr-latest&os=linux64&lang=en-US"
fi
FFOX_FORMAT=$(file -b build_assets/firefox/firefox-esr.tar.bz2 2>/dev/null | head -c 30)
echo "    ✓ $(du -h build_assets/firefox/firefox-esr.tar.bz2 | cut -f1) ($FFOX_FORMAT)"

# ─── 2. Geckodriver ──────────────────────────────────────────────────
echo "═══ 2. Geckodriver ${GECKODRIVER_VERSION} ═══"
if [[ ! -f build_assets/gecko/geckodriver-linux64.tar.gz ]]; then
    curl -fL --retry 3 -o build_assets/gecko/geckodriver-linux64.tar.gz \
        "https://github.com/mozilla/geckodriver/releases/download/${GECKODRIVER_VERSION}/geckodriver-${GECKODRIVER_VERSION}-linux64.tar.gz"
fi
echo "    ✓ $(du -h build_assets/gecko/geckodriver-linux64.tar.gz | cut -f1)"

# ─── 2b. yq (mikefarah, Go binary) ───────────────────────────────────
echo "═══ 2b. yq $YQ_VERSION ═══"
if [[ ! -f build_assets/yq/yq-linux64 ]]; then
    curl -fL --retry 3 -o build_assets/yq/yq-linux64 \
        "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_amd64"
fi
echo "    ✓ $(du -h build_assets/yq/yq-linux64 | cut -f1)"

# ─── 2c. Binaires DX / DB vendorisés (gh, shfmt, hadolint, duckdb, delta) ─
echo "═══ 2c. Binaires DX / DB (gh $GH_VERSION · shfmt $SHFMT_VERSION · hadolint $HADOLINT_VERSION · duckdb $DUCKDB_VERSION · delta $DELTA_VERSION) ═══"

if [[ ! -f build_assets/gh/gh.tar.gz ]]; then
    curl -fL --retry 3 -o build_assets/gh/gh.tar.gz \
        "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz"
fi
if [[ ! -f build_assets/shfmt/shfmt ]]; then
    curl -fL --retry 3 -o build_assets/shfmt/shfmt \
        "https://github.com/mvdan/sh/releases/download/${SHFMT_VERSION}/shfmt_${SHFMT_VERSION}_linux_amd64"
fi
if [[ ! -f build_assets/hadolint/hadolint ]]; then
    curl -fL --retry 3 -o build_assets/hadolint/hadolint \
        "https://github.com/hadolint/hadolint/releases/download/${HADOLINT_VERSION}/hadolint-Linux-x86_64"
fi
if [[ ! -f build_assets/duckdb/duckdb_cli.zip ]]; then
    curl -fL --retry 3 -o build_assets/duckdb/duckdb_cli.zip \
        "https://github.com/duckdb/duckdb/releases/download/${DUCKDB_VERSION}/duckdb_cli-linux-amd64.zip"
fi
if [[ ! -f build_assets/delta/delta.tar.gz ]]; then
    curl -fL --retry 3 -o build_assets/delta/delta.tar.gz \
        "https://github.com/dandavison/delta/releases/download/${DELTA_VERSION}/delta-${DELTA_VERSION}-x86_64-unknown-linux-gnu.tar.gz"
fi
echo "    ✓ gh $(du -h build_assets/gh/gh.tar.gz | cut -f1) · duckdb $(du -h build_assets/duckdb/duckdb_cli.zip | cut -f1) · delta $(du -h build_assets/delta/delta.tar.gz | cut -f1)"

# ─── 2d. Reverse-eng vendorisé (radare2, upx — retirés de bookworm/main) ──
echo "═══ 2d. Reverse-eng (radare2 $RADARE2_VERSION · upx $UPX_VERSION) ═══"
# upx : archive tar.xz upstream = 1 binaire statique. On extrait juste ce binaire.
if [[ ! -f build_assets/upx/upx ]]; then
    curl -fL --retry 3 -o /tmp/upx.tar.xz \
        "https://github.com/upx/upx/releases/download/v${UPX_VERSION}/upx-${UPX_VERSION}-amd64_linux.tar.xz"
    tar -xJf /tmp/upx.tar.xz -C /tmp
    cp "/tmp/upx-${UPX_VERSION}-amd64_linux/upx" build_assets/upx/upx
    chmod +x build_assets/upx/upx
    rm -rf /tmp/upx.tar.xz "/tmp/upx-${UPX_VERSION}-amd64_linux"
fi
# radare2 : .deb officiel self-contained (Depends: libc6 seul) → dpkg -i au build.
if [[ ! -f build_assets/radare2/radare2.deb ]]; then
    curl -fL --retry 3 -o build_assets/radare2/radare2.deb \
        "https://github.com/radareorg/radare2/releases/download/${RADARE2_VERSION}/radare2_${RADARE2_VERSION}_amd64.deb"
fi
echo "    ✓ upx $(du -h build_assets/upx/upx | cut -f1) · radare2 $(du -h build_assets/radare2/radare2.deb | cut -f1)"

# ─── 3. Wheels Python ────────────────────────────────────────────────
echo "═══ 3. Wheels Python ═══"

# On repart d'un dossier wheels PROPRE. Sinon des wheels périmées d'un
# build précédent peuvent masquer un nouveau build cassé.
rm -rf build_assets/wheels
mkdir -p build_assets/wheels

cat > build_assets/requirements.txt << 'REQEOF'
# ════════════════════════════════════════════════════════════════════
#  requirements.txt — elpis/sandbox:1.7.0
#  Tout est wheel-able en cp311 / manylinux (compilé par build_offline.sh).
# ════════════════════════════════════════════════════════════════════

# ─── Robot Framework — cœur ─────────────────────────────────────────
robotframework>=7.0,<7.3
robotframework-pythonlibcore>=4.4

# ─── RF — Web / UI ──────────────────────────────────────────────────
robotframework-seleniumlibrary>=6.7,<7.0
selenium>=4.21,<5.0
# Browser (Playwright) : NON inclus par défaut — `rfbrowser init` doit
# télécharger Node + les navigateurs Playwright, incompatible airgap tel
# quel. Pour l'activer : décommenter, puis ajouter dans le Dockerfile
#   RUN rfbrowser init  (machine de build connectée).
# robotframework-browser>=18.0

# ─── RF — API / HTTP / données ──────────────────────────────────────
robotframework-requests>=0.9.7
robotframework-jsonlibrary>=0.5

# ─── RF — systèmes / infra ──────────────────────────────────────────
robotframework-sshlibrary>=3.8
robotframework-databaselibrary>=2.0
robotframework-archivelibrary>=0.4

# ─── RF — data-driven / utilitaires / debug ─────────────────────────
robotframework-datadriver>=1.11
robotframework-faker>=5.0
robotframework-retryfailed>=0.2
robotframework-debuglibrary>=2.4

# ─── RF — exécution parallèle ───────────────────────────────────────
robotframework-pabot>=2.16

# ─── RF — qualité de code (lint + format) ───────────────────────────
robotframework-robocop>=5.0,<6.0
robotframework-tidy>=4.0

# ─── HTTP / API ─────────────────────────────────────────────────────
requests>=2.32
urllib3>=2.0
httpx>=0.27
certifi
charset-normalizer
idna

# ─── Données / parsing ──────────────────────────────────────────────
PyYAML>=6.0
lxml>=5.0
beautifulsoup4>=4.12
jmespath>=1.0
jsonschema>=4.20
openpyxl>=3.1
pandas>=2.2
numpy>=1.26
tabulate>=0.9

# ─── Bases de données (drivers pour DatabaseLibrary) ────────────────
psycopg2-binary>=2.9      # PostgreSQL
PyMySQL>=1.1              # MySQL / MariaDB (pur Python)
oracledb>=2.0            # Oracle (mode thin, pas de client natif requis)

# ─── SSH / crypto / réseau ──────────────────────────────────────────
paramiko>=3.4
cryptography>=42.0
scp>=0.15

# ─── Tests / outillage ──────────────────────────────────────────────
pytest>=8.0
pytest-html>=4.1

# ─── Templating / divers ────────────────────────────────────────────
Jinja2>=3.1
python-dotenv>=1.0
rich>=13.7

# ─── Ansible (run_script avec .yml playbooks) ───────────────────────
ansible-core>=2.16

# ─── Build-time ─────────────────────────────────────────────────────
pip
setuptools
wheel

# ─── Validation de données & ORM ────────────────────────────────────
pydantic>=2.7
SQLAlchemy>=2.0
pymongo>=4.7

# ─── Manipulation de documents & Médias ─────────────────────────────
pypdf>=4.2
python-docx>=1.1
Pillow>=10.3

# ─── Documents / Médias / OCR — bundle 1.4.0 (PDF · image · docx · …) ─
# Lecture/extraction/rendu PDF avancé (texte, tables, images, pages→PNG).
PyMuPDF>=1.24          # `import fitz` — rendu + extraction texte/image rapide
pdfplumber>=0.11       # extraction texte + tables PDF (sur pdfminer.six)
pdf2image>=1.17        # PDF → images PIL (utilise poppler-utils, déjà apt)
pikepdf>=9.0           # transformation/réparation PDF (qpdf, ajouté en apt)
reportlab>=4.2         # génération de PDF
# Bureautique : PowerPoint, écriture xlsx fine, ODF (complète python-docx/openpyxl).
python-pptx>=0.6.23
XlsxWriter>=3.2
odfpy>=1.4
# OCR : extraction de texte depuis images / PDF scannés (binaire tesseract en apt).
pytesseract>=0.3.10
# Vision / traitement d'images (variante headless = sans dépendances GUI).
opencv-python-headless>=4.9

# ─── Web Asynchrone & Serveurs locaux (Mocking) ─────────────────────
aiohttp>=3.9
fastapi>=0.111
uvicorn>=0.30
requests-mock>=1.12

# ─── Utilitaires système & Scripts avancés ──────────────────────────
tenacity>=8.3
psutil>=5.9
GitPython>=3.1
watchdog>=4.0

# ─── Developer experience (REPL / HTTP / lint / types) ──────────────
ipython>=8.20
httpie>=3.2
ruff>=0.5
mypy>=1.10
black>=24.4
typer>=0.12
markdown>=3.6
pre-commit>=3.7        # hooks git (lint/format avant commit)

# ─── Data / calcul scientifique (1.5.0) ─────────────────────────────
matplotlib>=3.8        # tracé (le seul plot dispo était gnuplot)
scipy>=1.13            # calcul scientifique (complète numpy)

# ─── Bases de données — analyse DDL & migration (1.5.0) ─────────────
# Drivers pg/mysql/oracle/mongo déjà présents plus haut. On ajoute
# SQL Server + l'outillage d'ANALYSE de schéma / DDL.
pyodbc>=5.1            # ODBC (SQL Server & autres) — runtime unixodbc en apt
pymssql>=2.3          # Microsoft SQL Server (embarque FreeTDS)
duckdb>=1.1           # base analytique embarquée (lib py ; CLI = binaire 2c)
sqlglot>=25.0         # parse/transpile SQL DDL entre dialectes (analyse schéma)
sqlfluff>=3.0         # linter / formateur SQL
sqlparse>=0.5         # parsing SQL non-validant
alembic>=1.13         # migrations de schéma (avec SQLAlchemy déjà présent)

# ─── Analyse binaire Windows / PE (DLL·EXE) & reverse (1.5.0) ────────
# Binaires natifs (radare2, yara, binwalk, upx, objdump) posés en apt.
pefile>=2024.8.26     # en-têtes PE, imports/exports d'une DLL/EXE
dnfile>=0.15          # métadonnées .NET (assemblies managées)
capstone>=5.0         # moteur de désassemblage multi-architecture
pyelftools>=0.31      # complément ELF (binaires Linux)
oletools>=0.60        # analyse OLE/VBA (documents Office piégés)
yara-python>=4.5      # règles YARA depuis Python (binaire yara en apt)
python-registry>=1.3  # lecture de ruches de registre Windows (hives) — dernière version PyPI = 1.3.1


REQEOF

if [[ "$DO_ARCHIVE" -eq 1 ]]; then
    # CRITIQUE : on lance pip wheel dans un container Python 3.11 (= la version
    # de l'image Debian bookworm-slim). On utilise l'image `python:3.11`
    # COMPLÈTE (et non -slim) : elle embarque gcc/g++/make pour compiler les
    # rares packages sans wheel manylinux pré-compilée. Les .whl produites
    # restent en tag cp311.
    #
    # IMPORTANT : pas de `| tail` ici. La sortie complète de pip est affichée
    # et le code de sortie de `docker run` reflète bien celui de `pip wheel`,
    # donc `set -e` arrête le script si la compilation échoue.
    echo "    Téléchargement et compilation des wheels dans Python 3.11 (~4-6 min)…"
    if ! docker run --rm \
            -v "$(pwd)/build_assets/wheels:/wheels" \
            -v "$(pwd)/build_assets/requirements.txt:/req.txt:ro" \
            python:3.11 \
            pip wheel --wheel-dir /wheels -r /req.txt --no-cache-dir
    then
        echo ""
        echo "✗ ÉCHEC : 'pip wheel' n'a pas pu produire les wheels (voir erreur ci-dessus)."
        echo "  Cause typique : un package ne résout pas / pas de wheel compatible."
        echo "  Ajuste build_assets/requirements.txt puis relance ce script."
        exit 1
    fi

    # Garde-fou : on vérifie qu'on a bien des wheels, et notamment celle de
    # robotframework (le package que le Dockerfile installe en premier).
    WHEEL_COUNT=$(find build_assets/wheels -name "*.whl" | wc -l)
    if [[ "$WHEEL_COUNT" -lt "$MIN_WHEELS" ]]; then
        echo "✗ ÉCHEC : seulement $WHEEL_COUNT wheel(s) produite(s) (attendu ≥ $MIN_WHEELS)."
        echo "  Le dossier build_assets/wheels est incomplet — build interrompu."
        exit 1
    fi
    if ! ls build_assets/wheels/robotframework-*.whl >/dev/null 2>&1; then
        echo "✗ ÉCHEC : aucune wheel 'robotframework-*.whl' dans build_assets/wheels."
        exit 1
    fi
    echo "    ✓ $WHEEL_COUNT wheels prêtes (cp311 / linux_x86_64)"
else
    echo "    Mode en ligne : pip installera depuis PyPI pendant le docker build."
fi

# ─── 4. Build de l'image ─────────────────────────────────────────────
echo "═══ 4. Build de l'image $IMAGE ═══"
echo "    (la machine de build a internet — apt-get tournera dans le Dockerfile)"
if [[ "$DO_ARCHIVE" -eq 0 ]]; then
    docker build --build-arg PIP_ONLINE=1 -t "$IMAGE" .
    echo "✓ Image construite dans le daemon local : $IMAGE"
    exit 0
fi
docker build --build-arg PIP_ONLINE=0 -t "$IMAGE" .

# ─── 5. Export en .tar.gz ────────────────────────────────────────────
echo "═══ 5. Export en .tar.gz ═══"
docker save "$IMAGE" | gzip > "$ARCHIVE"
SIZE=$(du -h "$ARCHIVE" | cut -f1)

cat <<EOF

═════════════════════════════════════════════════════════════════════════
✓ Image construite : $IMAGE
✓ Archive offline  : $ARCHIVE ($SIZE)

Prochaine étape : copier l'archive sur la machine cible (rsync, clé USB,
paquet hors-ligne de make_release.sh) puis la charger :
  deploy/docker/sandbox/load_image.sh $ARCHIVE

Pour remplacer l'image locale tout de suite (skip la copie ci-dessus) :
  $0 --load-only
ou en un seul appel la prochaine fois :
  $0 --load
═════════════════════════════════════════════════════════════════════════
EOF

# ─── 6. (Optionnel) Load immédiat ───────────────────────────────────
if [[ "$DO_LOAD" -eq 1 ]]; then
    load_archive
fi
