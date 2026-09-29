# ─────────────────────────────────────────────────────────────────────────
#  elpis/sandbox:1.7.0 — Image unique pour les containers user
#
#  Changements vs 1.6.0
#  --------------------
#   * ping sans capacité fichier : le conteneur tourne sans NET_RAW.
#
#  Changements vs 1.5.0
#  --------------------
#   * Première image construite avec l'entrypoint « réseau fin » :
#     ELPIS_ALLOWLIST_PORTS (ports TCP autorisés) et ELPIS_DNS (résolveurs)
#     sont enfin appliqués (ignorés par 1.5.0, cf. _user_sandbox.py).
#
#  Changements vs 1.4.0
#  --------------------
#  Profil « ingénierie logicielle généraliste + bases de données + analyse
#  binaire Windows ». Additions :
#   * Langages/runtimes : Java (default-jdk-headless), Rust (rustc/cargo).
#   * Toolchain C/C++ : clang, lld, autoconf, automake, libtool.
#   * Sécurité / secrets : gnupg (gpg), openssl (CLI), age.
#   * VCS / DX : git-lfs, shellcheck (apt) + binaires vendorisés
#       gh (GitHub CLI), shfmt, hadolint, delta.
#   * Bases de données :
#       - apt  : unixodbc(+dev), freetds(-bin/-dev)+tdsodbc (SQL Server),
#                default-libmysqlclient-dev (compil mysqlclient au runtime).
#       - bin  : duckdb (CLI base analytique embarquée).
#       - pip  : pyodbc, pymssql, duckdb, sqlglot, sqlfluff, sqlparse,
#                alembic (cf. build_assets/requirements.txt).
#   * Analyse binaire / reverse (PE/DLL Windows, ELF, firmware) :
#       - apt  : binutils-multiarch, yara, binwalk.
#       - bin  : radare2 (.deb self-contained), upx (statique) — tous deux
#                retirés de bookworm/main, donc vendorisés (cf. étape 3d).
#       - pip  : pefile, dnfile, capstone, pyelftools, oletools,
#                yara-python, python-registry.
#   * Data / calcul : matplotlib, scipy (pip) ; pre-commit (hooks).
#   * FIX Selenium/Firefox airgap : Selenium Manager ne téléphone plus à
#     github/plausible (ENV SE_OFFLINE + SE_AVOID_STATS) et Firefox coupe
#     toute télémétrie/MAJ/remote-settings (distribution/policies.json).
#     Avant : `Open Browser` hangait/timeoutait derrière un pare-feu DROP.
#     Mesuré : webdriver.Firefox() par défaut 12,5 s bruyant → 2,5 s propre.
#
#  Changements vs 1.3.0
#  --------------------
#   * FIX Selenium/Firefox : geckodriver 0.36.0 → 0.37.0 (driver apparié à
#     Firefox 140 ESR ; 0.36 déclenchait le warning de compat SeleniumLibrary).
#   * FIX headless : ajout de `xauth` — `xvfb-run` était installé mais NON
#     fonctionnel sans lui (« xauth command not found »), ce qui cassait tout
#     le chemin navigateur headless (Robot Framework + SeleniumLibrary).
#   * Bundle Documents/Médias/OCR (PDF · image · docx · …) :
#       - apt  : tesseract-ocr (+ eng/fra), qpdf, fonts-noto-cjk,
#                fonts-noto-color-emoji.
#       - pip  : PyMuPDF, pdfplumber, pdf2image, pikepdf, reportlab,
#                python-pptx, XlsxWriter, odfpy, pytesseract,
#                opencv-python-headless (cf. build_assets/requirements.txt).
#
#  Changements vs 1.2.0
#  --------------------
#   * Modern CLI : ripgrep, fd-find, bat, fzf, yq (binary mikefarah).
#   * Multimédia / docs : ffmpeg, imagemagick, poppler-utils, ghostscript,
#     pandoc → traitement d'images, PDF, conversion de formats riche.
#   * Office headless : libreoffice-core → conversion docx/odt/xlsx via
#     `soffice --headless --convert-to`.
#   * Plotting : gnuplot-nox.
#   * Debug : strace, ltrace, gdb.
#   * Shell utilities : tmux, screen, parallel, expect, bc, dc.
#   * Compression : zstd, p7zip-full, lz4.
#   * Réseau étendu : socat, tcpdump, mtr-tiny, iperf3.
#   * Langage : golang-go (toolchain Go complète).
#   * DB clients additionnels : redis-tools.
#   * Code-nav : universal-ctags.
#   * Python : ipython, httpie, ruff, mypy, black, watchdog, typer,
#     markdown, rich (déjà présent) — voir build_assets/requirements.txt.
#
#  Changements vs 1.1.1 (rappel)
#  -----------------------------
#   * Beaucoup plus de librairies Python (écosystème Robot Framework complet
#     + drivers DB, SSH, data, crypto…).
#   * Toolchain de build présente (build-essential, *-dev) → l'user peut
#     `pip install` une lib supplémentaire au runtime et la compiler.
#   * `sudo` installé + NOPASSWD pour l'user 10001 → plus besoin de root
#     "host" : dans SON container, l'user a les pleins pouvoirs.
#
#  Le résultat .tar.gz reste self-contained : runtime sur le serveur Elpis
#  ne nécessite AUCUN accès réseau (apt/pip ne tournent qu'au BUILD).
# ─────────────────────────────────────────────────────────────────────────

FROM debian:bookworm-slim

LABEL org.opencontainers.image.title="elpis/sandbox"
LABEL org.opencontainers.image.description="Sandbox Docker persistant par user pour Elpis"
LABEL org.opencontainers.image.version="1.7.0"

ARG DEBIAN_FRONTEND=noninteractive

# ─── 1. Packages Debian ───────────────────────────────────────────────────
#  Groupés par usage pour que ce soit lisible / éditable.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    # — base système —
    ca-certificates locales tzdata \
    bash coreutils findutils grep sed gawk diffutils \
    bzip2 xz-utils zip unzip gzip tar \
    procps psmisc lsof file tree htop \
    vim nano less \
    sudo \
    # — runtimes —
    python3 python3-pip python3-venv python3-dev \
    nodejs npm \
    golang-go \
    default-jdk-headless \
    rustc cargo \
    # — toolchain de build (pour compiler une wheel au runtime) —
    build-essential pkg-config cmake ninja-build ccache \
    clang lld autoconf automake libtool \
    libffi-dev libssl-dev zlib1g-dev \
    libxml2-dev libxslt1-dev libjpeg-dev libpq-dev \
    # — VCS / transferts / réseau —
    git git-lfs curl wget jq \
    rsync openssh-client sshpass \
    iputils-ping dnsutils netcat-openbsd telnet \
    iptables util-linux \
    socat tcpdump mtr-tiny iperf3 \
    # — sécurité / secrets —
    gnupg openssl age \
    # — clients base de données —
    sqlite3 default-mysql-client postgresql-client \
    redis-tools \
    # SQL Server / ODBC (drivers pour pyodbc & pymssql) + headers MySQL
    unixodbc unixodbc-dev freetds-bin freetds-dev tdsodbc \
    default-libmysqlclient-dev \
    # — modern CLI / quality of life —
    ripgrep fd-find bat fzf \
    universal-ctags shellcheck \
    # — analyse binaire / reverse (PE/DLL Windows, ELF, firmware) —
    # NB : radare2 + upx retirés de bookworm/main → vendorisés plus bas (étape 3d).
    binutils-multiarch yara binwalk \
    # — debug / introspection —
    strace ltrace gdb \
    # — shell utilities —
    tmux screen parallel expect bc dc time \
    # — compression supplémentaire —
    zstd p7zip-full lz4 \
    # — multimédia / documents —
    ffmpeg imagemagick \
    poppler-utils ghostscript qpdf \
    pandoc \
    gnuplot-nox \
    # — OCR (tesseract : extraction de texte images / PDF scannés) —
    tesseract-ocr tesseract-ocr-eng tesseract-ocr-fra \
    # — Office headless (soffice --convert-to) —
    libreoffice-core libreoffice-script-provider-python \
    # — Firefox / Selenium : dépendances runtime —
    libgtk-3-0 libdbus-glib-1-2 libxt6 libasound2 libpci3 libxtst6 \
    libnss3 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 \
    libgbm1 libxshmfence1 libxcb1 \
    fonts-liberation fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
    xvfb x11-utils xauth \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# Le conteneur tourne sans NET_RAW (_user_sandbox.CAPABILITIES) : la capacité
# fichier cap_net_raw de ping ferait échouer son exécution ; sans elle, ping
# passe par les sockets ICMP ordinaires que Docker ouvre à tous
# (net.ipv4.ping_group_range).
RUN setcap -r /usr/bin/ping

# Debian nomme `fd-find` → `fdfind` et `bat` → `batcat` pour éviter les
# collisions historiques. On crée les symlinks attendus pour que la
# CLI standard fonctionne (`fd`, `bat`).
RUN ln -sf /usr/bin/fdfind /usr/local/bin/fd \
 && ln -sf /usr/bin/batcat /usr/local/bin/bat

# Locales UTF-8
RUN echo "C.UTF-8 UTF-8" > /etc/locale.gen && locale-gen
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC

# ─── 2. Firefox ESR ───────────────────────────────────────────────────────
# Le fichier est nommé .tar.bz2 mais Mozilla peut servir du tar.xz selon
# la version. tar -xf auto-détecte le format (on a bzip2 + xz-utils).
COPY build_assets/firefox/firefox-esr.tar.bz2 /tmp/
RUN tar -xf /tmp/firefox-esr.tar.bz2 -C /opt/ \
 && ln -sf /opt/firefox/firefox /usr/local/bin/firefox \
 && rm /tmp/firefox-esr.tar.bz2

# Policy d'entreprise « airgap » : coupe TOUTE la télémétrie / mises à jour /
# remote-settings / safebrowsing / captive-portal de Firefox. Sans ça, chaque
# démarrage de Firefox tente des appels réseau (ads.mozilla.org, plausible.io,
# services.settings, MARS…) qui, derrière un pare-feu qui DROP, HANGENT jusqu'au
# timeout → SeleniumLibrary `Open Browser` échoue. Firefox lit ce fichier dans
# ``<install>/distribution/policies.json``. (cf. fix Selenium/airgap 1.5.0)
RUN mkdir -p /opt/firefox/distribution
COPY firefox-policies.json /opt/firefox/distribution/policies.json

# ─── 3. Geckodriver ───────────────────────────────────────────────────────
COPY build_assets/gecko/geckodriver-linux64.tar.gz /tmp/
RUN tar -xf /tmp/geckodriver-linux64.tar.gz -C /usr/local/bin/ \
 && chmod +x /usr/local/bin/geckodriver \
 && rm /tmp/geckodriver-linux64.tar.gz

# ─── 3b. yq (mikefarah, Go binary) ───────────────────────────────────────
# Le `yq` Debian (Python wrapper) est plus lent et moins ergonomique. On
# embarque le binaire Go (~5 MB) directement.
COPY build_assets/yq/yq-linux64 /usr/local/bin/yq
RUN chmod +x /usr/local/bin/yq

# ─── 3c. Binaires DX / DB vendorisés (Go/Rust statiques, cf. build_offline) ─
# Même idiome que yq : téléchargés par build_offline.sh dans build_assets/,
# puis COPYés ici. Aucun accès réseau requis au build de l'image.
#   gh       — GitHub CLI (PR/issues/releases)
#   shfmt    — formateur de scripts shell (complète shellcheck de l'apt)
#   hadolint — linter de Dockerfile
#   duckdb   — base analytique embarquée en CLI (SQL/DDL, Parquet, CSV)
#   delta    — pager de diff git lisible
COPY build_assets/shfmt/shfmt /usr/local/bin/shfmt
COPY build_assets/hadolint/hadolint /usr/local/bin/hadolint
RUN chmod +x /usr/local/bin/shfmt /usr/local/bin/hadolint

COPY build_assets/gh/gh.tar.gz /tmp/
RUN tar -xf /tmp/gh.tar.gz -C /tmp \
 && cp /tmp/gh_*/bin/gh /usr/local/bin/gh \
 && chmod +x /usr/local/bin/gh \
 && rm -rf /tmp/gh.tar.gz /tmp/gh_*

COPY build_assets/duckdb/duckdb_cli.zip /tmp/
RUN unzip -o /tmp/duckdb_cli.zip -d /usr/local/bin/ \
 && chmod +x /usr/local/bin/duckdb \
 && rm /tmp/duckdb_cli.zip

COPY build_assets/delta/delta.tar.gz /tmp/
RUN tar -xf /tmp/delta.tar.gz -C /tmp \
 && cp /tmp/delta-*/delta /usr/local/bin/delta \
 && chmod +x /usr/local/bin/delta \
 && rm -rf /tmp/delta.tar.gz /tmp/delta-*

# ─── 3d. Reverse-eng vendorisé (radare2 · upx) ────────────────────────────
# radare2 ET upx-ucl ont été RETIRÉS de Debian bookworm (main) → l'`apt install`
# de 1.4.0 échoue (« no installation candidate » / « Unable to locate »). On les
# vendorise (build_offline.sh les télécharge dans build_assets/) :
#   upx     — binaire statique upstream (aucune dépendance).
#   radare2 — .deb officiel self-contained (Depends: libc6 seul → dpkg -i suffit,
#             pas d'accès réseau ni d'index apt requis).
COPY build_assets/upx/upx /usr/local/bin/upx
RUN chmod +x /usr/local/bin/upx
COPY build_assets/radare2/radare2.deb /tmp/
RUN dpkg -i /tmp/radare2.deb \
 && rm /tmp/radare2.deb

# ─── 4. Paquets Python (cf. build_assets/requirements.txt) ─────────────────
# PIP_ONLINE=1 (build en ligne, défaut de ./install.sh) : pip lit PyPI et le
# dossier de wheels est vide. PIP_ONLINE=0 (build_offline.sh --archive) : tout
# vient des wheels pré-compilées, sans accès à PyPI.
ARG PIP_ONLINE=0
COPY build_assets/wheels /tmp/wheels/
COPY build_assets/requirements.txt /tmp/
RUN if [ "$PIP_ONLINE" = "1" ]; then \
        pip3 install --break-system-packages --no-cache-dir -r /tmp/requirements.txt; \
    else \
        pip3 install --break-system-packages --no-index \
            --find-links /tmp/wheels -r /tmp/requirements.txt; \
    fi \
 && rm -rf /tmp/wheels /tmp/requirements.txt /root/.cache

# ─── 5. User non-root + sudo ──────────────────────────────────────────────
# L'user 10001 reste le compte d'exécution par défaut, MAIS il a sudo
# NOPASSWD : dans son propre container il peut donc tout faire (apt,
# pip système, chmod, chown, monter un service…) sans avoir besoin d'un
# accès root "host". L'isolation host reste assurée par Docker (namespaces,
# seccomp, pas de socket Docker monté) — cf. _user_sandbox.py.
RUN groupadd -g 10001 elpis \
 && useradd -m -u 10001 -g 10001 -s /bin/bash elpis \
 && echo 'elpis ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/elpis \
 && chmod 0440 /etc/sudoers.d/elpis \
 && mkdir -p /work \
 && chown -R 10001:10001 /work \
 && chmod 0777 /work \
 && echo 'umask 0002' >> /etc/profile \
 && echo 'umask 0002' >> /etc/bash.bashrc

# ─── 6. Configuration runtime ─────────────────────────────────────────────
# PYTHONUSERBASE pointe DANS /work (volume monté) : un `pip install --user`
# fait par l'user au runtime persiste donc d'un container à l'autre.
ENV MOZ_HEADLESS=1 \
    MOZ_HEADLESS_WIDTH=1920 \
    MOZ_HEADLESS_HEIGHT=1080 \
    # Selenium Manager (Selenium 4) NE DOIT PAS téléphoner à github.com /
    # raw.githubusercontent.com / plausible.io pour « gérer » geckodriver :
    # en airgap ça ajoute ~10 s/ouverture et casse le navigateur derrière un
    # pare-feu qui DROP. SE_OFFLINE force l'usage du geckodriver du PATH
    # (celui vendorisé), SE_AVOID_STATS coupe la télémétrie du manager.
    SE_OFFLINE=true \
    SE_AVOID_STATS=true \
    HOME=/work \
    PYTHONUSERBASE=/work/.python-user \
    PATH="/work/.python-user/bin:/work/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
    CMD pgrep -f "sleep infinity" || exit 1

# ─── 7. Entrypoint ────────────────────────────────────────────────────────
# Le container démarre brièvement en root (config iptables si
# ELPIS_ALLOWLIST), puis bascule en UID 10001 via setpriv pour le CMD.
COPY entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh

WORKDIR /work
# Pas de "USER 10001" — l'entrypoint gère le drop de privilège lui-même.
ENTRYPOINT ["/entrypoint.sh"]
CMD ["sleep", "infinity"]
