# SPDX-License-Identifier: MIT
# deploy/node/runtime.sh — runtime Node.js livré : l'archive officielle sans npm, npx ni corepack, et son empreinte ; sourcé par installer.sh, make_release.sh et elpis.

# Nom de l'archive du runtime livré, dans le paquet hors ligne (node/).
runtime_archive() { local va="NODE_ASSET_$1"; [ -n "${!va:-}" ] && echo "${!va%.tar.gz}-sans-npm.tar.gz"; }

# LICENSE de l'archive (entrée standard) sans les sections de npm et corepack ; HdrHistogram sous son option BSD-2-Clause.
runtime_licence() {
    awk '
        /^- .*, located at .*, is licensed as follows:$/ {
            saute = ($0 ~ /, located at deps\/(npm|corepack), /)
            histo = ($0 ~ /, located at deps\/histogram, /)
            coupe = 0
            if (histo) { print "- HdrHistogram, located at deps/histogram, is used under its BSD 2-Clause License option:"; next }
        }
        saute { next }
        histo && coupe == 0 && /^  """$/ { print; coupe = 1; next }
        histo && coupe == 1 { if ($0 ~ /Beginning of "BSD 2-Clause License" text/) coupe = 2; next }
        histo && coupe == 2 && /^[[:space:]]*$/ { coupe = 3; next }
        { print }
    '
}

# Retire npm, npx et corepack d'une archive officielle extraite ; son LICENSE ne garde que ce qui reste.
runtime_epurer() {
    rm -rf "$1/lib/node_modules/npm" "$1/lib/node_modules/corepack" "$1/bin/npm" "$1/bin/npx" "$1/bin/corepack"
    rmdir "$1/lib/node_modules" "$1/lib" 2>/dev/null || true
    runtime_licence < "$1/LICENSE" > "$1/LICENSE.epure" && mv "$1/LICENSE.epure" "$1/LICENSE" && chmod 644 "$1/LICENSE"
}

# Empreinte d'un runtime : SHA-256 de la liste triée de ses contenus, de ses exécutables et de ses liens.
runtime_empreinte() {
    [ -d "$1" ] || return 1
    ( cd "$1" && {
        find . -type f -print0 | LC_ALL=C sort -z | xargs -0r sha256sum
        find . -type f -perm -u+x | LC_ALL=C sort | sed 's/^/x /'
        find . -type l -printf 'l %p -> %l\n' | LC_ALL=C sort
    } ) | sha256sum | cut -d' ' -f1
}
