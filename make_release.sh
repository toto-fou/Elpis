#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# ==============================================================================
#  make_release.sh — paquet d'installation HORS-LIGNE (à joindre à une release)
# ==============================================================================
#
#  À lancer sur une machine connectée, de même architecture et de même version
#  de Python que la cible (les roues pip en dépendent). Produit :
#
#    dist/elpis-offline-<version>-<arch>/
#      wheels/     roues Python (requirements-rag.txt, + AGPL si --with-agpl)
#      node/       runtime Node.js : l'archive officielle (sha256 de
#                  deploy/node/node.env) sans npm, npx ni corepack, à
#                  l'empreinte figée elle aussi
#      core/       bundle du core (apps/core/dist) pour cette architecture,
#                  construit et vérifié avec ce Node (module natif, /api/health)
#      toolhost/   bundle de l'hôte d'outils (apps/toolhost/dist), node-pty
#                  compilé ici pour cette architecture, vérifié de même
#                  (modules natifs, /health, arrêt propre)
#      web/        frontend construit (npm run build -w @elpis/web : frontend/dist,
#                  entrées Vite et vendor hachés, aucun CDN), installé dans
#                  frontend/dist ; le serveur n'exécute ni npm ni Vite
#      qdrant/     archive officielle de Qdrant (sha256 vérifié)
#      sandbox/    image sandbox Docker (.tar.gz), SOURCES.txt et OFFRE-SOURCES.txt
#                  (GPL : paquets, versions, archives sources, offre écrite) ;
#                  sources/ avec --with-sources
#      browser/    dépendances npm + Chromium (ses bibliothèques système sont
#                  des prérequis apt : deploy/prerequis-apt.txt)
#      LICENSE, NOTICE, THIRD_PARTY_NOTICES.md, LICENSES/, THIRD_PARTY_LICENSES/   notices d'Elpis et des composants
#      wheels/LICENCES-PYTHON.txt   licences des roues (lues dans leurs *.dist-info)
#      sbom/       SBOM CycloneDX JSON : npm (npm sbom), Python (roues), image sandbox (syft)
#      MANIFEST.txt   (+ MANIFEST.txt.asc avec --sign)
#    dist/elpis-offline-<version>-<arch>.tar   (+ .tar.asc avec --sign)
#
#  Sur la cible : ./install.sh --offline <dossier extrait>
#  Le paquet n'est JAMAIS versionné dans le dépôt (dist/ est ignoré). Aucun
#  paquet de l'OS dedans : ils sont des prérequis apt (deploy/prerequis-apt.txt,
#  miroir du LAN ou support de l'OS), Caddy compris.
#
#  Usage :
#    ./make_release.sh [VERSION] [--with-agpl] [--no-sandbox] [--no-browser]
#                      [--with-sources] [--sign]
#
#    --with-sources  télécharge les archives sources de hadolint, upx et radare2
#                    (GPL/LGPL, image sandbox) dans sandbox/sources/. Les sources
#                    des paquets Debian de l'image : apt-get source n'existe que
#                    sous Debian ; sinon https://snapshot.debian.org (versions de
#                    sandbox/SOURCES.txt), voir docs/exploitation.md.
#    --sign          signature GPG détachée (gpg --detach-sign --armor) de
#                    MANIFEST.txt et du .tar ; clé : variable ELPIS_SIGN_KEY
#                    (empreinte ou identifiant). Vérification :
#                    gpg --verify <fichier>.asc <fichier>
# ==============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
# shellcheck source=deploy/qdrant/qdrant.env
. "$ROOT/deploy/qdrant/qdrant.env"
# shellcheck source=deploy/node/node.env
. "$ROOT/deploy/node/node.env"
# shellcheck source=deploy/node/runtime.sh
. "$ROOT/deploy/node/runtime.sh"

info() { printf '\033[1;34m[release]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[  ok   ]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[erreur ]\033[0m %s\n' "$*" >&2; exit 1; }

VERSION=""; WITH_AGPL=0; WITH_SANDBOX=1; WITH_BROWSER=1; WITH_SOURCES=0; SIGN=0
while [ $# -gt 0 ]; do
    case "$1" in
        --with-agpl)  WITH_AGPL=1 ;;
        --with-caddy) echo "--with-caddy ignorée : Caddy est un prérequis apt (deploy/prerequis-apt.txt, groupe https)." >&2 ;;
        --no-sandbox) WITH_SANDBOX=0 ;;
        --no-browser) WITH_BROWSER=0 ;;
        --with-sources) WITH_SOURCES=1 ;;
        --sign)       SIGN=1 ;;
        -h|--help)    sed -n '2,/^set -euo pipefail/p' "$0" | sed '$d' | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
        [0-9]*)       VERSION="$1" ;;
        *) die "argument inconnu : $1 (--help)" ;;
    esac
    shift
done
if [ -z "$VERSION" ]; then
    VERSION="$(sed -n 's/^version *= *"\(.*\)"/\1/p' pyproject.toml 2>/dev/null | head -1)"
    VERSION="${VERSION:-0.0.0}"
fi
if [ "$SIGN" -eq 1 ]; then
    command -v gpg >/dev/null 2>&1 || die "--sign : gpg est absent du PATH."
    [ -n "${ELPIS_SIGN_KEY:-}" ] || die "--sign : définissez ELPIS_SIGN_KEY (empreinte ou identifiant de la clé GPG de signature)."
    gpg --batch --list-secret-keys "$ELPIS_SIGN_KEY" >/dev/null 2>&1 \
        || die "--sign : aucune clé secrète GPG ne correspond à ELPIS_SIGN_KEY ($ELPIS_SIGN_KEY)."
fi
ARCH="$(uname -m)"
NAME="elpis-offline-$VERSION-$ARCH"
OUT="$ROOT/dist/$NAME"
[ -e "$OUT" ] && die "$OUT existe déjà."
mkdir -p "$OUT"/{wheels,qdrant,sandbox}

PY="${PYTHON_BIN:-$ROOT/venv/bin/python}"
[ -x "$PY" ] || PY="$(command -v python3)"

# ── Fonctions : notices, licences Python, SBOM, sources GPL ─────────────────
# GPL de l'image : liste des paquets, archives sources exactes des binaires vendorisés, offre écrite (3 ans).
sources_sandbox() {
    local sb="$1" image="$2" nom licence ver url fichier
    {
        echo "Image sandbox $image : composants soumis à la GPL ou à la LGPL, et source correspondante."
        echo
        echo "== Binaires vendorisés (nom | licence | version | archive source exacte) =="
        "$sb/build_offline.sh" --print-sources
        echo
        echo "== Paquets Debian de l'image (dpkg-query -W : paquet, version) =="
        echo "Sources : apt-get source <paquet>=<version> sous Debian, ou https://snapshot.debian.org"
        if docker image inspect "$image" >/dev/null 2>&1; then
            docker run --rm --entrypoint dpkg-query "$image" -W 2>/dev/null \
                || echo "(dpkg-query indisponible dans l'image)"
        else
            echo "(image absente du démon Docker : liste non produite)"
        fi
    } > "$OUT/sandbox/SOURCES.txt"
    cat > "$OUT/sandbox/OFFRE-SOURCES.txt" <<'OFFRE'
Offre écrite de fourniture de la source correspondante / Written offer for source code

L'image sandbox d'Elpis contient des programmes sous GPL ou LGPL (hadolint, upx,
radare2, et des paquets Debian dont la liste est dans SOURCES.txt). Pendant trois
(3) ans à compter de la réception de ce paquet, toute personne qui le détient peut
obtenir, pour le coût matériel de sa fourniture (ou gratuitement par téléchargement),
la source correspondante complète de ces programmes, en la demandant au
mainteneur : toto-fou, https://github.com/toto-fou (ouvrir une issue sur le dépôt
Elpis, ou une demande privée par GitHub si elle ne doit pas être publique).
SOURCES.txt donne l'archive source exacte de chaque binaire vendorisé ; avec
--with-sources de make_release.sh, ces archives sont dans sources/.

For three (3) years from receipt of this package, anyone holding it may obtain,
for no more than the cost of physically providing it, the complete corresponding
source code of the GPL/LGPL programs it contains, by asking the maintainer
(toto-fou, https://github.com/toto-fou; open an issue on the Elpis repository,
or a private request through GitHub).
OFFRE
    if [ "$WITH_SOURCES" -eq 1 ]; then
        mkdir -p "$OUT/sandbox/sources"
        while IFS='|' read -r nom licence ver url; do
            fichier="${url##*/}"
            case "$fichier" in "$nom"*) ;; *) fichier="$nom-$fichier" ;; esac
            info "Source de $nom $ver ($licence)…"
            curl -fsSL --retry 3 -o "$OUT/sandbox/sources/$fichier" "$url" || die "Source de $nom : téléchargement échoué ($url)."
        done < <("$sb/build_offline.sh" --print-sources)
        ok "Sources GPL de l'image dans sandbox/sources/."
    fi
}

# Notices d'Elpis et des composants à la racine du paquet : le .tar circule parfois sans l'archive des sources.
copier_notices() {
    cp -a "$ROOT/LICENSE" "$ROOT/NOTICE" "$ROOT/THIRD_PARTY_NOTICES.md" "$OUT/"
    cp -a "$ROOT/LICENSES" "$OUT/LICENSES"
    cp -a "$ROOT/THIRD_PARTY_LICENSES" "$OUT/THIRD_PARTY_LICENSES"
    ok "LICENSE, NOTICE, THIRD_PARTY_NOTICES.md, LICENSES/ et THIRD_PARTY_LICENSES/ copiés à la racine du paquet."
}

# Licences et SBOM CycloneDX des roues, lus dans leurs *.dist-info ; cyclonedx-py prend la main s'il est installé.
licences_python() {
    "$PY" -I - "$OUT/wheels" "$OUT/wheels/LICENCES-PYTHON.txt" "$OUT/sbom/python.cdx.json" "$VERSION" <<'PYEOF' \
        || die "Licences des roues Python : lecture échouée."
# SPDX-License-Identifier: MIT
"""Récapitulatif des licences et SBOM CycloneDX des roues Python : licpy.py ROUES TEXTE SBOM VERSION."""
import datetime
import email.parser
import hashlib
import json
import pathlib
import re
import sys
import uuid
import zipfile

roues, texte, sbom, version = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
FICHIERS = re.compile(r"(^|/)(licen[cs]es?|copying|notice|authors)([-._][^/]*)?$", re.I)
SPDX = re.compile(r"^[A-Za-z0-9.+\-() ]+$")
filet = "=" * 78
blocs, composants = [], []
for roue in sorted(roues.glob("*.whl")):
    with zipfile.ZipFile(roue) as z:
        noms = z.namelist()
        meta_nom = next((n for n in noms if re.fullmatch(r"[^/]+\.dist-info/METADATA", n)), None)
        if meta_nom is None:
            blocs.append(f"{filet}\n{roue.name} — METADATA introuvable\n{filet}\n")
            continue
        meta = email.parser.Parser().parsestr(z.read(meta_nom).decode("utf-8", "replace"), headersonly=True)
        nom, ver = meta.get("Name", roue.name), meta.get("Version", "?")
        expression = (meta.get("License-Expression") or "").strip()
        champ = (meta.get("License") or "").strip()
        classes = [c.split("::")[-1].strip() for c in meta.get_all("Classifier", []) if c.startswith("License ::")]
        court = expression or (champ if champ and "\n" not in champ and len(champ) <= 120 else "") or " ; ".join(classes) or "inconnue (voir les fichiers)"
        dossier = meta_nom.rsplit("/", 1)[0] + "/"
        fichiers = sorted(n for n in noms if n.startswith(dossier) and not n.endswith("/") and FICHIERS.search(n[len(dossier):]))
        corps = []
        for f in fichiers:
            corps.append(f"--- {f}\n\n{z.read(f).decode('utf-8', 'replace').strip()}\n")
        if not corps and champ:
            corps.append(f"--- champ License de METADATA\n\n{champ}\n")
        blocs.append(f"{filet}\n{nom} {ver} — {court}\n{filet}\n\n" + ("\n".join(corps) or "(aucun fichier de licence dans la roue)\n"))
    composant = {
        "type": "library",
        "name": nom,
        "version": ver,
        "purl": f"pkg:pypi/{re.sub(r'[-_.]+', '-', nom).lower()}@{ver}",
        "hashes": [{"alg": "SHA-256", "content": hashlib.sha256(roue.read_bytes()).hexdigest()}],
    }
    if expression and SPDX.match(expression):
        composant["licenses"] = [{"expression": expression}]
    elif court and not court.startswith("inconnue"):
        composant["licenses"] = [{"license": {"name": court}}]
    composants.append(composant)
pathlib.Path(texte).write_text(
    "Python wheels of the Elpis offline package (wheels/): license information read from the *.dist-info of each wheel.\n"
    "Generated by make_release.sh; do not edit by hand.\n\n" + "\n".join(blocs),
    encoding="utf-8",
)
doc = {
    "bomFormat": "CycloneDX",
    "specVersion": "1.5",
    "serialNumber": f"urn:uuid:{uuid.uuid4()}",
    "version": 1,
    "metadata": {
        "timestamp": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "component": {"type": "application", "name": "elpis-offline-python-wheels", "version": version},
    },
    "components": composants,
}
pathlib.Path(sbom).write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"{len(composants)} roue(s)")
PYEOF
    ok "wheels/LICENCES-PYTHON.txt et sbom/python.cdx.json écrits."
}

# SBOM : npm (workspace, hors développement), Python (roues), image sandbox (syft).
sbom_paquet() {
    mkdir -p "$OUT/sbom"
    ( cd "$ROOT" && PATH="$NODE_ARBRE/bin:$PATH" npm sbom --sbom-format cyclonedx --omit=dev ) > "$OUT/sbom/npm.cdx.json" \
        || die "SBOM npm (npm sbom) échouée."
    ok "sbom/npm.cdx.json."
    licences_python
    if command -v cyclonedx-py >/dev/null 2>&1 && cyclonedx-py requirements "$req" --of JSON -o "$OUT/sbom/python-requirements.cdx.json" >/dev/null 2>&1; then
        ok "sbom/python-requirements.cdx.json (cyclonedx-py)."
    fi
    if [ "$WITH_SANDBOX" -eq 1 ]; then
        if command -v syft >/dev/null 2>&1; then
            for a in "$OUT"/sandbox/*.tar.gz; do
                [ -e "$a" ] || continue
                syft "docker-archive:$a" -o "cyclonedx-json=$OUT/sbom/sandbox.cdx.json" >/dev/null 2>&1 \
                    && ok "sbom/sandbox.cdx.json (syft)." || info "syft a échoué sur $(basename "$a") : SBOM de l'image sautée."
            done
        else
            info "syft absent : SBOM de l'image sandbox sautée (https://github.com/anchore/syft)."
        fi
    fi
}

# ── 1. Roues Python ──────────────────────────────────────────────────────────
req="$ROOT/requirements-rag.txt"
[ "$WITH_AGPL" -eq 1 ] && req="$ROOT/requirements-agpl-optional.txt"
info "Roues Python ($(basename "$req"), $("$PY" -V))…"
"$PY" -m pip download --dest "$OUT/wheels" -r "$req" --only-binary=:all: \
    || "$PY" -m pip download --dest "$OUT/wheels" -r "$req"
"$PY" -m pip download --dest "$OUT/wheels" pip setuptools wheel >/dev/null

# ── 2. Qdrant ────────────────────────────────────────────────────────────────
va="QDRANT_ASSET_$ARCH"; vs="QDRANT_SHA256_$ARCH"
asset="${!va:-}"; sha="${!vs:-}"
[ -n "$asset" ] || die "Qdrant : architecture $ARCH non gérée."
info "Qdrant $QDRANT_VERSION…"
curl -fsSL --retry 3 -o "$OUT/qdrant/$asset" \
    "https://github.com/qdrant/qdrant/releases/download/v${QDRANT_VERSION}/${asset}"
echo "$sha  $OUT/qdrant/$asset" | sha256sum -c --quiet - || die "sha256 de Qdrant invalide."

# ── 2 bis. Node.js et bundle du core ─────────────────────────────────────────
# Le bundle démarre avec le Node livré sur une base SQLite temporaire avant d'entrer dans le paquet.
verifier_core() {
    local node="$1" core="$2" inst port pid rc=0 sain=0
    [ -f "$core/pixels.mjs" ] && [ -f "$core/webp/dec/webp_dec.wasm" ] && [ -f "$core/webp/enc/webp_enc.wasm" ] \
        || die "Bundle du core : thread des images ou codecs WebP absents (pixels.mjs, webp/)."
    ELPIS_RACINE="$ROOT" "$node" "$core/exploitation.mjs" empreinte || die "Bundle du core : empreinte des sources."
    "$node" "$core/exploitation.mjs" natif || die "Bundle du core : module natif."
    inst="$(mktemp -d)"
    echo '{}' > "$inst/config.json"
    port="$("$node" -e 'const s = require("net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); })')"
    env -i PATH="$PATH" HOME="$inst" APP_MODE=main ELPIS_RACINE="$ROOT" APP_CONFIG_PATH="$inst/config.json" \
        APP_DB_PATH="$inst/app.db" APP_SANDBOX_DIR="$inst/sandboxes" ELPIS_AUDIT_DIR="$inst/audit" \
        ELPIS_AUDIT_KEY_PATH="$inst/audit.key" MCP_SERVERS_DIR="$inst/mcp_custom_servers" \
        BIND="127.0.0.1:$port" "$node" "$core/main.mjs" > "$inst/core.log" 2>&1 &
    pid=$!
    for _ in $(seq 1 120); do
        if curl --noproxy '*' -fsS -m 2 -o /dev/null "http://127.0.0.1:$port/api/health" 2>/dev/null; then sain=1; break; fi
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.5
    done
    kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" || rc=$?
    if [ "$sain" -ne 1 ] || [ "$rc" -ne 0 ]; then
        cat "$inst/core.log" >&2
        rm -rf "$inst"
        die "Bundle du core : démarrage ou arrêt en échec (/api/health, SIGTERM)."
    fi
    rm -rf "$inst"
    ok "Bundle du core vérifié avec Node $NODE_VERSION (module natif, /api/health, arrêt propre)."
}
# Même contrôle pour l'hôte d'outils : modules natifs (node-pty compilé pour cette architecture), /health, arrêt propre.
verifier_hote() {
    local node="$1" hote="$2" inst port pid rc=0 sain=0
    ELPIS_RACINE="$ROOT" "$node" "$hote/main.mjs" --empreinte || die "Bundle de l'hôte d'outils : empreinte des sources."
    "$node" "$hote/main.mjs" --natif || die "Bundle de l'hôte d'outils : modules natifs (node-pty, better-sqlite3)."
    inst="$(mktemp -d)"
    echo '{}' > "$inst/config.json"
    port="$("$node" -e 'const s = require("net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); })')"
    env -i PATH="$PATH" HOME="$inst" ELPIS_RACINE="$ROOT" TOOLHOST_CONFIG="$inst/absent.json" \
        APP_CONFIG_PATH="$inst/config.json" APP_DB_PATH="$inst/app.db" APP_MCP_MANIFEST="$inst/absent-mcp.json" \
        APP_SANDBOX_DIR="$inst/sb" APP_FILE_HISTORY_DIR="$inst/fh" ELPIS_AUDIT_DIR="$inst/audit" \
        LOCAL_MCP_HOST=127.0.0.1 LOCAL_MCP_PORT="$port" "$node" "$hote/main.mjs" > "$inst/hote.log" 2>&1 &
    pid=$!
    for _ in $(seq 1 120); do
        if curl --noproxy '*' -fsS -m 2 -o /dev/null "http://127.0.0.1:$port/health" 2>/dev/null; then sain=1; break; fi
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.5
    done
    kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" || rc=$?
    if [ "$sain" -ne 1 ] || [ "$rc" -ne 0 ]; then
        cat "$inst/hote.log" >&2
        rm -rf "$inst"
        die "Bundle de l'hôte d'outils : démarrage ou arrêt en échec (/health, SIGTERM)."
    fi
    rm -rf "$inst"
    ok "Bundle de l'hôte d'outils vérifié avec Node $NODE_VERSION (modules natifs, /health, arrêt propre)."
}
# Le paquet doit valoir pour le code archivé : sources du bundle (construction.json) suivies par git et sans modification.
sources_commitees() {
    local bundle="$1" libelle="$2" sources=()
    git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1 || return 0
    mapfile -t sources < <("$NODE_ARBRE/bin/node" -e 'const c = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf-8")); for (const s of c.sources) console.log(s)' "$bundle/construction.json")
    [ "${#sources[@]}" -gt 0 ] || die "construction.json du bundle ($libelle) sans liste de sources."
    { git -C "$ROOT" ls-files --error-unmatch -- "${sources[@]}" >/dev/null 2>&1 && git -C "$ROOT" diff --quiet HEAD -- "${sources[@]}"; } \
        || die "Bundle ($libelle) construit depuis des sources non commitées (git status apps packages) : sur la cible, le code archivé le ferait refuser."
}
na="NODE_ASSET_$ARCH"; ns="NODE_SHA256_$ARCH"
node_asset="${!na:-}"; node_sha="${!ns:-}"
[ -n "$node_asset" ] || die "Node.js : architecture $ARCH non gérée."
case "$ARCH" in x86_64) cible=linux-x64 ;; *) cible=linux-arm64 ;; esac
info "Node.js $NODE_VERSION…"
mkdir -p "$OUT/node"
# Archive officielle hors du paquet : son npm sert à construire le core, puis il est retiré du runtime livré.
NODE_TMP="$(mktemp -d "$ROOT/dist/.node-officiel.XXXXXX")"
trap 'rm -rf "$NODE_TMP"' EXIT
curl -fsSL --retry 3 -o "$NODE_TMP/$node_asset" "https://nodejs.org/dist/v$NODE_VERSION/$node_asset"
echo "$node_sha  $NODE_TMP/$node_asset" | sha256sum -c --quiet - || die "sha256 de Node.js invalide."
NODE_ARBRE="$NODE_TMP/${node_asset%.tar.gz}"
mkdir "$NODE_ARBRE"
tar -xzf "$NODE_TMP/$node_asset" -C "$NODE_ARBRE" --strip-components=1
info "Bundle du core ($cible : npm ci, construction)…"
( cd "$ROOT" && PATH="$NODE_ARBRE/bin:$PATH" npm ci --no-audit --no-fund \
    && PATH="$NODE_ARBRE/bin:$PATH" npm run build -w @elpis/core -- --sortie "$OUT/core" --cible "$cible" ) \
    || die "Construction du core échouée."
verifier_core "$NODE_ARBRE/bin/node" "$OUT/core"
sources_commitees "$OUT/core" core
info "Bundle de l'hôte d'outils ($cible : node-pty compilé sur cette machine)…"
( cd "$ROOT" && PATH="$NODE_ARBRE/bin:$PATH" npm run build -w @elpis/toolhost -- --sortie "$OUT/toolhost" --cible "$cible" ) \
    || die "Construction de l'hôte d'outils échouée (node-pty : build-essential et python3 requis)."
verifier_hote "$NODE_ARBRE/bin/node" "$OUT/toolhost"
sources_commitees "$OUT/toolhost" "hôte d'outils"
info "Frontend (Vite : entrées chat et console)…"
git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1 && { git -C "$ROOT" diff --quiet HEAD -- frontend package-lock.json \
    || die "Frontend construit depuis des sources non commitées (git status frontend)."; }
( cd "$ROOT" && PATH="$NODE_ARBRE/bin:$PATH" npm run build -w @elpis/web ) || die "Construction du frontend échouée."
[ -f "$ROOT/frontend/dist/.vite/manifest.json" ] || die "Frontend construit sans manifeste."
cp -a "$ROOT/frontend/dist" "$OUT/web"
ok "Frontend construit ($(du -sh "$OUT/web" | cut -f1))."

# ── 3. Image sandbox ─────────────────────────────────────────────────────────
if [ "$WITH_SANDBOX" -eq 1 ]; then
    sb="$ROOT/deploy/docker/sandbox"
    image="$("$sb/build_offline.sh" --print-image)"
    archive="$(echo "$image" | tr '/:' '--').tar.gz"
    if docker image inspect "$image" >/dev/null 2>&1; then
        info "Export de l'image $image…"
        docker save "$image" | gzip > "$OUT/sandbox/$archive"
    else
        info "Construction de l'image $image (mode archive)…"
        "$sb/build_offline.sh" --archive
        mv "$sb"/*.tar.gz "$OUT/sandbox/"
    fi
    sources_sandbox "$sb" "$image"
fi

# ── 4. Service navigateur (avec le Node.js livré et le npm de son archive) ───
if [ "$WITH_BROWSER" -eq 1 ]; then
    info "Service navigateur (npm + Chromium)…"
    ( cd "$ROOT/browser-service" && PATH="$NODE_ARBRE/bin:$PATH" ./fetch_offline_deps.sh --no-apt )
    cp -a "$ROOT/browser-service/offline" "$OUT/browser"
fi

# ── 4 bis. Notices, licences Python et SBOM (avant le retrait de npm du runtime) ──
copier_notices
sbom_paquet

# ── 5. Runtime Node.js livré : l'archive officielle sans npm, npx ni corepack ─
runtime_epurer "$NODE_ARBRE"
vr="NODE_RUNTIME_SHA256_$ARCH"
empreinte="$(runtime_empreinte "$NODE_ARBRE")"
[ "$empreinte" = "${!vr:-}" ] \
    || die "Runtime Node.js sans npm : empreinte $empreinte, différente de $vr dans deploy/node/node.env (nouvelle version de Node.js : vérifiez-la, puis figez-la)."
sed '1,/^$/d' "$ROOT/THIRD_PARTY_LICENSES/node-runtime.txt" | cmp -s - "$NODE_ARBRE/LICENSE" \
    || die "THIRD_PARTY_LICENSES/node-runtime.txt ne correspond plus au LICENSE du runtime : régénérez-le (runtime_licence de deploy/node/runtime.sh)."
tar -C "$NODE_TMP" --sort=name --owner=0 --group=0 --numeric-owner -cf - "${node_asset%.tar.gz}" \
    | gzip -n -9 > "$OUT/node/$(runtime_archive "$ARCH")"
ok "Runtime Node.js $NODE_VERSION sans npm, npx ni corepack (empreinte ${empreinte:0:12})."

# ── Manifeste + archive ──────────────────────────────────────────────────────
{
    echo "Elpis — paquet hors-ligne $VERSION ($ARCH)"
    echo "créé le : $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "python  : $("$PY" -V 2>&1)"
    echo "node    : $NODE_VERSION, $(runtime_archive "$ARCH") (sans npm ; empreinte du runtime $empreinte)"
    echo "core    : $(sed -n 's/.*"empreinte": "\([0-9a-f]*\)".*/\1/p' "$OUT/core/construction.json") (empreinte des sources)"
    echo "hôte    : $(sed -n 's/.*"empreinte": "\([0-9a-f]*\)".*/\1/p' "$OUT/toolhost/construction.json") (empreinte des sources, $cible)"
    echo "web     : $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo '?') (frontend/dist, Vite)"
    echo "agpl    : $([ "$WITH_AGPL" -eq 1 ] && echo oui || echo non)"
    echo "sbom    : sbom/ (CycloneDX JSON), licences Python : wheels/LICENCES-PYTHON.txt"
    echo "sources : $([ "$WITH_SOURCES" -eq 1 ] && echo 'sandbox/sources/ (GPL)' || echo 'sandbox/SOURCES.txt et OFFRE-SOURCES.txt (offre écrite)')"
    echo
    echo "Installation : ./install.sh --offline <ce dossier>"
    echo
    ( cd "$OUT" && find . -type f ! -name MANIFEST.txt -print0 | sort -z | xargs -0 sha256sum )
} > "$OUT/MANIFEST.txt"
signer() {
    gpg --batch --yes --local-user "$ELPIS_SIGN_KEY" --detach-sign --armor -o "$1.asc" "$1" || die "Signature GPG de $1 échouée."
    ok "Signature $(basename "$1").asc (gpg --verify $(basename "$1").asc $(basename "$1"))."
}
[ "$SIGN" -eq 1 ] && signer "$OUT/MANIFEST.txt"
tar -C "$ROOT/dist" -cf "$ROOT/dist/$NAME.tar" "$NAME"
[ "$SIGN" -eq 1 ] && signer "$ROOT/dist/$NAME.tar"
ok "Paquet prêt : dist/$NAME.tar ($(du -h "$ROOT/dist/$NAME.tar" | cut -f1))"
