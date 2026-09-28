#!/bin/bash
# SPDX-License-Identifier: MIT
# =====================================================================
#  install_caddy.sh — Frontal TLS Elpis, 100 % côté serveur
#
#  Usage :  sudo ./install_caddy.sh [san-supplementaire ...]
#           (arguments optionnels : IP flottante, alias DNS interne, …)
#
#  Fait tout :
#    1. installe caddy — depuis les .deb vendorisés ./debs/ si présents
#       (bundle produit par fetch_caddy_debs.sh, install 100 % offline,
#       ne pose que ce qui manque sur la cible), sinon apt en ligne ;
#    2. détecte les IP de la machine (hostname -I, IPv4) + hostname ;
#    3. génère une CA locale STABLE (10 ans, jamais régénérée) et un
#       certificat serveur signé (10 ans, SANs = IPs détectées + args),
#       re-émis UNIQUEMENT si la liste de SANs change — la stabilité du
#       cert est ce qui rend l'exception navigateur « Accepter le
#       risque » définitive (1 clic par poste/port, jamais plus) ;
#    4. pose le Caddyfile catch-all (copie telle quelle, pas de sed) ;
#    5. valide et (re)démarre Caddy.
#
#  Côté client : taper l'IP (http ou https), accepter UNE fois
#  l'avertissement — terminé. Import de http://<ip>/ca.crt : optionnel,
#  seulement pour supprimer l'avertissement initial (cadenas propre).
#
#  Machine sans internet : lancez fetch_caddy_debs.sh sur un poste
#  connecté AVANT de copier le dossier — les .deb arrivent avec et ce
#  script les utilise tout seul. openssl est présent de base sur Debian.
# =====================================================================
set -euo pipefail

CADDYFILE=/etc/caddy/Caddyfile
PKI_DIR=/etc/caddy/elpis-pki
SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
TEMPLATE="$SCRIPT_DIR/Caddyfile.template"
DEBS_DIR="$SCRIPT_DIR/debs"

if [ "$(id -u)" -ne 0 ]; then
    echo "Erreur : lancez ce script avec sudo (écrit /etc/caddy + systemctl)." >&2
    exit 1
fi

# ── 1. Paquet caddy — .deb vendorisés d'abord (offline), apt en repli ─
# Les .deb sont produits par fetch_caddy_debs.sh (machine connectée) et
# voyagent avec le dossier de l'app, comme les wheels Python.
if command -v caddy >/dev/null 2>&1; then
    echo "--- caddy déjà installé : $(caddy version) ---"
elif compgen -G "$DEBS_DIR/*.deb" >/dev/null; then
    echo "--- Installation de caddy depuis les .deb vendorisés ($DEBS_DIR) ---"
    declare -a _to_install=()
    for _deb in "$DEBS_DIR"/*.deb; do
        _pkg="$(dpkg-deb -f "$_deb" Package)"
        # Une dépendance vendorisée n'est installée que si ABSENTE de la
        # cible : jamais de downgrade d'une lib de base déjà là (libc6…).
        if [ "$_pkg" = "caddy" ] || ! dpkg -s "$_pkg" >/dev/null 2>&1; then
            _to_install+=("$_deb")
        else
            echo "    $_pkg déjà présent — .deb ignoré."
        fi
    done
    dpkg -i "${_to_install[@]}" || true
    dpkg --configure -a || true
    if ! command -v caddy >/dev/null 2>&1; then
        echo "Échec de l'installation offline (voir erreurs dpkg ci-dessus)." >&2
        echo "Re-générez le bundle sur un poste connecté : fetch_caddy_debs.sh" >&2
        exit 1
    fi
    echo "--- caddy installé : $(caddy version) ---"
else
    echo "--- Aucun .deb vendorisé — installation via apt (en ligne) ---"
    if ! apt-get install -y caddy; then
        echo "Échec apt et pas de bundle offline. Sur un poste connecté :" >&2
        echo "    deploy/caddy/fetch_caddy_debs.sh    # vendorise dans deploy/caddy/debs/" >&2
        echo "puis copiez le dossier et relancez ce script." >&2
        exit 1
    fi
fi

# ── 2. SANs : IPs détectées + hostname + arguments ───────────────────
declare -a SANS=("IP:127.0.0.1" "DNS:localhost")
for ip in $(hostname -I 2>/dev/null || true); do
    if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        SANS+=("IP:$ip")
    fi
done
_hn="$(hostname 2>/dev/null || true)"
[ -n "$_hn" ] && SANS+=("DNS:$_hn")
for extra in "$@"; do
    if [[ "$extra" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        SANS+=("IP:$extra")
    else
        SANS+=("DNS:$extra")
    fi
done
# Dédoublonnage en préservant l'ordre, puis liste "IP:a,DNS:b,…"
SAN_LIST="$(printf '%s\n' "${SANS[@]}" | awk '!seen[$0]++' | paste -sd, -)"
echo "SANs du certificat : $SAN_LIST"

# ── 3. PKI locale stable ─────────────────────────────────────────────
mkdir -p "$PKI_DIR"
chmod 755 "$PKI_DIR"

# CA : générée UNE fois, jamais touchée ensuite (les postes qui l'ont
# importée ne doivent jamais la voir changer).
if [ ! -f "$PKI_DIR/ca.crt" ] || [ ! -f "$PKI_DIR/ca.key" ]; then
    echo "--- Génération de la CA locale (10 ans) ---"
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
        -keyout "$PKI_DIR/ca.key" -out "$PKI_DIR/ca.crt" -days 3650 \
        -subj "/CN=Elpis Local CA/O=Elpis" \
        -addext "basicConstraints=critical,CA:TRUE" \
        -addext "keyUsage=critical,keyCertSign,cRLSign"
else
    echo "--- CA locale existante conservée ---"
fi

# Cert serveur : ré-émis seulement si les SANs ont changé (stabilité =
# les exceptions déjà acceptées par les navigateurs restent valides).
_needs_leaf=1
if [ -f "$PKI_DIR/server.crt" ]; then
    _current="$(openssl x509 -in "$PKI_DIR/server.crt" -noout -ext subjectAltName 2>/dev/null \
        | tail -n +2 | tr -d ' \n' \
        | sed 's/IPAddress:/IP:/g')"
    _wanted="$(echo "$SAN_LIST" | tr -d ' ')"
    if [ "$_current" = "$_wanted" ]; then
        _needs_leaf=0
        echo "--- Certificat serveur existant conservé (SANs inchangés) ---"
    else
        echo "--- SANs modifiés (avant: ${_current:-aucun}) → ré-émission du certificat serveur ---"
    fi
fi
if [ "$_needs_leaf" = "1" ]; then
    echo "--- Émission du certificat serveur (10 ans) ---"
    openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
        -keyout "$PKI_DIR/server.key" -out "$PKI_DIR/server.csr" -subj "/CN=Elpis"
    printf 'subjectAltName=%s\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' \
        "$SAN_LIST" > "$PKI_DIR/ext.cnf"
    openssl x509 -req -in "$PKI_DIR/server.csr" \
        -CA "$PKI_DIR/ca.crt" -CAkey "$PKI_DIR/ca.key" -CAcreateserial \
        -days 3650 -out "$PKI_DIR/server.crt" -extfile "$PKI_DIR/ext.cnf"
    cat "$PKI_DIR/server.crt" "$PKI_DIR/ca.crt" > "$PKI_DIR/fullchain.pem"
    rm -f "$PKI_DIR/server.csr" "$PKI_DIR/ext.cnf"
fi

# Permissions : la clé serveur lisible par caddy, la clé CA root-only.
chown root:caddy "$PKI_DIR/server.key" 2>/dev/null || true
chmod 640 "$PKI_DIR/server.key"
chmod 600 "$PKI_DIR/ca.key"
chmod 644 "$PKI_DIR/ca.crt" "$PKI_DIR/server.crt" "$PKI_DIR/fullchain.pem"

# ── 4. Caddyfile (catch-all, copie sans substitution) ────────────────
if [ -f "$CADDYFILE" ]; then
    cp "$CADDYFILE" "${CADDYFILE}.bak.$(date +%Y%m%d%H%M%S)"
    echo "Backup : ${CADDYFILE}.bak.*"
fi
cp "$TEMPLATE" "$CADDYFILE"

# ── 5. Validation puis (re)démarrage ─────────────────────────────────
caddy validate --config "$CADDYFILE" --adapter caddyfile
systemctl enable --now caddy
systemctl reload caddy || systemctl restart caddy

_first_ip="$(printf '%s\n' "${SANS[@]}" | grep '^IP:' | grep -v 127.0.0.1 | head -1 | cut -d: -f2)"
_first_ip="${_first_ip:-<ip-du-serveur>}"
echo ""
echo "==============================================================="
echo "  Frontal TLS en place. Côté client : RIEN à installer."
echo "    • App principale : https://${_first_ip}/   (ou juste ${_first_ip} → redirigé)"
echo "    • Console admin  : https://${_first_ip}:8443/admin"
echo "    • UI RAG         : https://${_first_ip}:8444/"
echo ""
echo "  Première connexion : le navigateur affiche un avertissement"
echo "  (certificat local inconnu) → « Avancé » → « Accepter le risque »."
echo "  Un seul clic par poste et par port — le certificat est stable"
echo "  10 ans, l'avertissement ne reviendra pas."
echo ""
echo "  Optionnel (supprime même ce 1er avertissement) : importer"
echo "  http://${_first_ip}/ca.crt dans le navigateur (voir README.md)."
echo ""
echo "  Puis activez le mode HTTPS dans la console admin"
echo "  (Configuration → Accès HTTPS)."
echo "==============================================================="
