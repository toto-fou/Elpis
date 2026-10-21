// SPDX-License-Identifier: MIT
/** apps/core/src/code/installeurs.ts — gabarits des installeurs OpenCode (bash, PowerShell) recopiés à l'octet de routes_cli.py, sondes HTTPS passées en GET ; substitutions : __BASE__ et __APP_URL__. */
import { sondesEnGet } from "../bureau";

export const INSTALL_SH_PYTHON = `#!/usr/bin/env bash
set -euo pipefail
# Installeur OpenCode — servi par __BASE__ (réseau local).
BASE="__BASE__"        # base des TÉLÉCHARGEMENTS (http en amorçage clair)
APP_URL="__APP_URL__"  # URL de l'app pour le plugin (https si frontal TLS)
case "$(uname -s)" in
  Linux*)  OS=linux ;;
  Darwin*) OS=macos ;;
  *) echo "OS non géré par ce script ; utilise le téléchargement direct dans l'app." >&2; exit 1 ;;
esac
BIN_DIR="\${OPENCODE_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$BIN_DIR"
# Défini ICI (et plus au moment d'écrire la config) : la CA locale y est déposée
# dès sa récupération, donc AVANT de savoir si le plugin sera installé. Elle doit
# survivre au script — c'est le fichier que le plugin épingle.
CFG_DIR="\${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
mkdir -p "$CFG_DIR"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
# ── HTTPS (frontal Caddy, cert LAN auto-signé) ──
# En amorçage clair (BASE en http, cf. deploy/caddy › @bootstrap) les
# téléchargements n'ont AUCUN TLS à gérer. La CA locale n'est récupérée que si
# un https est en jeu : l'app (APP_URL — le plugin lui parlera) et/ou les
# téléchargements eux-mêmes (BASE https = commande historique).
CURL_TLS=""
CA_FILE=""
# Récupération de la CA : deux sources, la seconde rattrape les déploiements
# SANS frontal :80 (HTTPS direct, port 80 filtré) où l'ancienne version ne
# trouvait rien et tombait sur « -k » pour de bon.
#   1. http://<hôte>/ca.crt      — publié en clair par Caddy (deploy/caddy)
#   2. <app>/api/cli/ca.crt      — servi par l'app elle-même (toujours joignable)
# Les deux sont des canaux NON authentifiés : c'est un amorçage de confiance
# (TOFU), au même niveau de risque qu'un « -k » ponctuel. La différence est
# décisive pour la suite : une fois la CA en main, TOUT ce qui parle à l'app est
# réellement vérifié — au lieu de désactiver la vérification à demeure.
ca_looks_valid() { grep -q 'BEGIN CERTIFICATE' "$1" 2>/dev/null; }
# Empreinte SHA-256 (hex, forme DER) inscrite par le serveur : seule une CA qui
# la porte est épinglée ou installée ; sans empreinte, aucune CA n'est retenue.
CA_SHA256="__CA_SHA256__"
ca_fingerprint() {
  _fp=$(openssl x509 -in "$1" -outform DER 2>/dev/null | openssl dgst -sha256 2>/dev/null | sed 's/^.*= *//') || _fp=""
  if [ -z "$_fp" ]; then
    _fp=$(awk '/BEGIN CERTIFICATE/{f=1;next} /END CERTIFICATE/{exit} f' "$1" | tr -d '\\r\\n ' | { base64 -d 2>/dev/null || base64 -D 2>/dev/null; } | { sha256sum 2>/dev/null || shasum -a 256 2>/dev/null; } | cut -d' ' -f1) || _fp=""
  fi
  printf '%s' "$_fp" | tr 'A-F' 'a-f'
}
ca_matches() { [ -n "$CA_SHA256" ] && [ "$(ca_fingerprint "$1")" = "$CA_SHA256" ]; }
CA_DST="$CFG_DIR/elpis-ca.crt"
fetch_ca() {
  _h="\${APP_URL#*://}"; _h="\${_h%%[:/]*}"
  for _u in "http://$_h/ca.crt" "$BASE/api/cli/ca.crt" "$APP_URL/api/cli/ca.crt"; do
    if curl -fsSk -m 5 "$_u" -o "$TMP/ca.crt" 2>/dev/null && ca_looks_valid "$TMP/ca.crt"; then
      if ! ca_matches "$TMP/ca.crt"; then
        echo "⚠ CA reçue de $_u refusée : empreinte SHA-256 différente de celle publiée par le serveur."
        continue
      fi
      # Emplacement DURABLE tout de suite : $TMP disparaît à la sortie du script,
      # or c'est ce chemin que le plugin épingle (\`ca_file\`) et que l'utilisateur
      # peut réutiliser (\`curl --cacert\`, git, etc.).
      cp "$TMP/ca.crt" "$CA_DST" && chmod 644 "$CA_DST" 2>/dev/null || true
      CA_FILE="$CA_DST"
      echo "CA locale récupérée ($_u) → $CA_DST"
      return 0
    fi
  done
  rm -f "$TMP/ca.crt"
  return 1
}
case "$BASE $APP_URL" in
  *https://*)
    if [ -z "$CA_SHA256" ]; then
      echo "⚠ Ce serveur ne publie pas de CA locale : aucune CA n'est récupérée ni installée dans le magasin."
    else
      fetch_ca || echo "⚠ CA locale introuvable ou non conforme à l'empreinte du serveur (ni :80, ni /api/cli/ca.crt)."
    fi ;;
esac
# ── Confiance SYSTÈME — comportement PAR DÉFAUT ──────────────────────────────
# C'est LE bon geste sur un réseau local sans Internet : l'amorçage se fait en
# clair (rien à vérifier), puis la CA de l'app est installée SUR LE POSTE. Après
# quoi \`curl\`, \`git\`, \`wget\` et le navigateur parlent à l'app en https vérifié —
# plus aucun \`-k\` nulle part, et le certificat retrouve son rôle.
# Épingler seul (ca_file) ne soigne que ce script et le plugin ; tous les autres
# outils continuaient de refuser le certificat.
# Opt-out explicite : ELPIS_TRUST_CA=n.
trust_ca_system() {
  [ -n "$CA_FILE" ] || return 1
  if [ -d /usr/local/share/ca-certificates ]; then
    _dst=/usr/local/share/ca-certificates/elpis-local-ca.crt; _upd="update-ca-certificates"
  elif [ -d /etc/pki/ca-trust/source/anchors ]; then
    _dst=/etc/pki/ca-trust/source/anchors/elpis-local-ca.crt; _upd="update-ca-trust extract"
  else
    return 1
  fi
  # ⚠ stdin de ce script EST le tube de curl : un \`sudo\` qui demande un mot de
  # passe le lirait DANS LE SCRIPT (et l'exécuterait ensuite comme du shell).
  # D'où : root direct, sinon sudo NON interactif (-n), sinon sudo branché sur
  # le terminal réel — jamais sur le tube.
  _run_priv() {
    # Les tentatives NON interactives sont muettes : on explique nous-mêmes
    # l'échec, un « cp: Permission denied » brut ne ferait qu'ajouter du bruit.
    # Le sudo interactif, lui, garde sa sortie — sinon son invite de mot de passe
    # serait invisible et l'utilisateur croirait le script figé.
    if [ "$(id -u)" = 0 ]; then "$@" 2>/dev/null; return $?; fi
    command -v sudo >/dev/null 2>&1 || return 1
    sudo -n "$@" 2>/dev/null && return 0
    ( : < /dev/tty ) 2>/dev/null || return 1
    sudo "$@" < /dev/tty
  }
  _run_priv cp "$CA_FILE" "$_dst" || return 1
  _run_priv chmod 644 "$_dst" || true
  # shellcheck disable=SC2086  # _upd peut valoir « update-ca-trust extract »
  _run_priv $_upd >/dev/null 2>&1 || return 1
  return 0
}
ca_already_trusted() {
  # Déjà dans le magasin ? Alors il n'y a rien à faire, et surtout rien à
  # demander : une ré-install sur un poste déjà configuré doit être muette.
  curl -fsS -m 5 --head "$APP_URL/api/public-config" >/dev/null 2>&1
}
if [ -n "$CA_FILE" ]; then
  WANT_TRUST=y                       # défaut : on configure le poste
  case "\${ELPIS_TRUST_CA:-}" in [nN0]*) WANT_TRUST=n ;; esac
  if ca_already_trusted; then
    echo "Certificat de $APP_URL déjà reconnu par ce poste — rien à installer."
  elif [ "$WANT_TRUST" = n ]; then
    echo "CA non ajoutée au magasin système (ELPIS_TRUST_CA=n) — elle reste épinglée pour opencode."
  elif trust_ca_system; then
    echo "CA installée dans le magasin système — https vérifié partout sur ce poste (curl, git, navigateur)."
  else
    # Échec = droits absents ou distribution non gérée. La CA est là, le geste
    # est à un pas : on donne la commande exacte plutôt qu'un simple constat.
    echo "⚠ Impossible d'installer la CA dans le magasin système (droits administrateur requis)."
    echo "  opencode et son greffon fonctionnent quand même (CA épinglée : $CA_FILE)."
    if [ -d /etc/pki/ca-trust/source/anchors ]; then
      echo "  Pour les autres outils :  sudo cp '$CA_FILE' /etc/pki/ca-trust/source/anchors/elpis-local-ca.crt && sudo update-ca-trust extract"
    else
      echo "  Pour les autres outils :  sudo cp '$CA_FILE' /usr/local/share/ca-certificates/elpis-local-ca.crt && sudo update-ca-certificates"
    fi
  fi
fi
if [ "\${BASE#https://}" != "$BASE" ]; then
  if curl -fsS -m 5 --head "$BASE/api/cli/opencode.json" >/dev/null 2>&1; then
    : # certificat vérifiable — rien à faire
  elif [ -n "$CA_FILE" ] \\
       && curl -fsS -m 5 --cacert "$CA_FILE" --head "$BASE/api/cli/opencode.json" >/dev/null 2>&1; then
    CURL_TLS="--cacert $CA_FILE"
    echo "Téléchargements https vérifiés via la CA locale."
  else
    # Deux causes bien distinctes, et l'ancien message les confondait (« CA
    # introuvable » alors qu'on venait d'en récupérer une) : une CA qui ne signe
    # PAS le certificat de l'app, c'est un autre service sur le port 80 ou une
    # PKI régénérée — pas la même consigne pour l'administrateur.
    if [ -n "$CA_FILE" ]; then
      echo "⚠ La CA récupérée ne valide PAS le certificat de $BASE (autre service sur :80, ou PKI régénérée)."
      # Ni épinglée, ni laissée sur le disque : le plugin échouerait à chaque
      # appel, et un fichier « elpis-ca.crt » erroné est un piège pour la suite.
      CA_FILE=""; rm -f "$CA_DST"
    else
      echo "⚠ Certificat https non vérifiable et aucune CA locale joignable."
    fi
    CURL_TLS="-k"
    echo "  → mode non vérifié (-k) pour cette installation."
  fi
fi
fetch()  { curl -fSL  $CURL_TLS "$@"; }
fetchq() { curl -fsSL $CURL_TLS "$@"; }
# Options TLS pour parler à l'APP (≠ base des téléchargements) : en amorçage
# clair BASE est en http donc CURL_TLS est vide, alors qu'APP_URL peut être en
# https derrière Caddy — s'en servir tel quel ferait échouer la connexion au
# compte sur un cert auto-signé.
APP_TLS=""
if [ "\${APP_URL#https://}" != "$APP_URL" ]; then
  if curl -fsS -m 5 --head "$APP_URL/api/public-config" >/dev/null 2>&1; then
    :                                             # cert vérifiable
  elif [ -n "$CA_FILE" ]; then
    APP_TLS="--cacert $CA_FILE"
  else
    APP_TLS="-k"
  fi
fi
echo "Téléchargement d'OpenCode ($OS) depuis $BASE ..."
fetch "$BASE/api/cli/bundle/$OS" -o "$TMP/opencode.bundle"
# Détecte l'archive (tar.gz / zip) ou un binaire brut.
if tar tzf "$TMP/opencode.bundle" >/dev/null 2>&1; then
  # --no-same-owner : l'archive porte l'uid/gid de la machine qui l'a fabriquée.
  # Sous root — ou dans un conteneur / espace de noms utilisateur — tar essaie
  # de le restaurer et ÉCHOUE (« Cannot change ownership »), ce qui interrompt
  # toute l'installation. Les fichiers doivent appartenir à qui installe.
  tar xzf "$TMP/opencode.bundle" -C "$TMP" --no-same-owner
elif command -v unzip >/dev/null 2>&1 && unzip -tq "$TMP/opencode.bundle" >/dev/null 2>&1; then
  unzip -q "$TMP/opencode.bundle" -d "$TMP"
else
  cp "$TMP/opencode.bundle" "$TMP/opencode"
fi
BIN="$(find "$TMP" -type f -name 'opencode' | head -n1 || true)"
[ -n "$BIN" ] || BIN="$TMP/opencode"
install -m 0755 "$BIN" "$BIN_DIR/opencode"
echo "OpenCode installé : $BIN_DIR/opencode"
# ── Config Elpis : récupérée À CHAUD depuis le serveur (modèles + endpoint courants). ──
# À défaut (offline / serveur down), repli sur le opencode.json embarqué dans l'archive.
# (CFG_DIR est défini plus haut : la CA locale y est déposée dès sa récupération.)
CFG_DST="$CFG_DIR/opencode.json"
CFG_SRC=""
if fetchq "$BASE/api/cli/opencode.json" -o "$TMP/opencode.fresh.json" 2>/dev/null; then
  CFG_SRC="$TMP/opencode.fresh.json"
  echo "Config Elpis à jour récupérée depuis $BASE."
else
  CFG_SRC="$(find "$TMP" -type f -name 'opencode.json' | head -n1 || true)"
  [ -n "$CFG_SRC" ] && echo "Config live indisponible — repli sur la config embarquée (offline)."
fi
if [ -n "$CFG_SRC" ]; then
  mkdir -p "$CFG_DIR"
  if [ -f "$CFG_DST" ]; then
    cp "$CFG_DST" "$CFG_DST.bak"
    echo "Ancienne config sauvegardée : $CFG_DST.bak"
  fi
  cp "$CFG_SRC" "$CFG_DST"
  echo "Config Elpis installée (à jour) : $CFG_DST"
fi
# ── Pré-amorçage des dépendances de plugin — LE correctif « opencode met 1 min
#    à démarrer ». Dès qu'un plugin est présent, opencode lance un \`npm install
#    @opencode-ai/plugin\` dans CHAQUE dossier de config et BLOQUE le chargement
#    des plugins dessus (config.ts › waitForDependencies). Mesuré ici : 30 s en
#    1.17.7, 71 s en 1.18.16 au premier lancement AVEC Internet — et un blocage
#    de plusieurs minutes quand le réseau ne répond pas (pare-feu qui drop), ce
#    qui est exactement le cas d'un déploiement LAN sans Internet.
#    opencode saute complètement l'install si \`node_modules\` existe ET que les
#    dépendances déclarées figurent dans le lock (core/src/npm.ts › install) :
#    trois fichiers suffisent, aucun paquet à télécharger. Vérifié réseau coupé :
#    démarrage 8,6 s au lieu de « jamais ».
seed_node_deps() {
  [ -d "$1" ] || return 0
  [ -e "$1/node_modules" ] && return 0        # déjà installé — ne rien toucher
  mkdir -p "$1/node_modules" || return 0
  [ -f "$1/package.json" ] || printf '{\\n  "dependencies": { "@opencode-ai/plugin": "%s" }\\n}\\n' "$2" > "$1/package.json"
  [ -f "$1/package-lock.json" ] || printf '{ "name": "opencode-config", "lockfileVersion": 3, "requires": true,\\n  "packages": { "": { "dependencies": { "@opencode-ai/plugin": "%s" } } } }\\n' "$2" > "$1/package-lock.json"
  echo "Dépendances de plugin pré-amorcées ($1) — démarrage immédiat hors ligne."
}
# \`|| true\` DANS le groupe : avec \`set -o pipefail\`, un binaire absent (127)
# ferait échouer tout le script sur cette simple lecture de version.
OC_VERSION="$({ "$BIN_DIR/opencode" --version 2>/dev/null || true; } | tr -d '\\r' | head -n1)"
case "$OC_VERSION" in ''|*[!0-9.]*) OC_VERSION="1.0.0" ;; esac
seed_node_deps "$CFG_DIR" "$OC_VERSION"
# ── Plugin elpis-remote (TypeScript, chargé nativement par opencode) : sessions
#    remontées/pilotables depuis la page « Code ». Choix EXPLICITE : prompt Y/n
#    (via /dev/tty — stdin est le pipe du curl), surchargé par
#    ELPIS_INSTALL_PLUGIN=y|n ; défaut = y — ce script est servi PAR l'app, donc
#    l'intention est claire. (Le jeton ne sert plus d'indice : la commande
#    d'install est désormais anonyme, l'appairage se fait après coup via
#    « /remote login ».)
PLUGIN_DIR="$CFG_DIR/plugin"
WANT_PLUGIN=""
case "\${ELPIS_INSTALL_PLUGIN:-}" in
  [yYoO1]*) WANT_PLUGIN=y ;;
  [nN0]*)   WANT_PLUGIN=n ;;
esac
if [ -z "$WANT_PLUGIN" ]; then
  DEF=y
  # ( : </dev/tty ) OUVRE réellement le tty : vrai test d'interactivité — un
  # [ -r /dev/tty ] seul est vrai même sans terminal contrôlant (cron/daemon).
  if ( : < /dev/tty ) 2>/dev/null; then
    if [ "$DEF" = y ]; then HINT="[Y/n]"; else HINT="[y/N]"; fi
    printf 'Installer le plugin elpis-remote (pilotage depuis la page Remote code) ? %s ' "$HINT" > /dev/tty 2>/dev/null || true
    read -r REPLY < /dev/tty || REPLY=""
    case "$REPLY" in
      [yYoO]*) WANT_PLUGIN=y ;;
      [nN]*)   WANT_PLUGIN=n ;;
      *)       WANT_PLUGIN=$DEF ;;
    esac
  else
    WANT_PLUGIN=$DEF
    echo "(non interactif : plugin elpis-remote = $WANT_PLUGIN — forcer avec ELPIS_INSTALL_PLUGIN=y|n)"
  fi
fi
if [ "$WANT_PLUGIN" = y ]; then
  if fetchq "$BASE/api/code/plugin.ts" -o "$TMP/elpis-remote.ts" 2>/dev/null; then
    mkdir -p "$PLUGIN_DIR"
    cp "$TMP/elpis-remote.ts" "$PLUGIN_DIR/elpis-remote.ts"
    # ère pré-TypeScript : jamais DEUX plugins chargés (opencode glob *.{ts,js})
    rm -f "$PLUGIN_DIR/elpis-remote.js" "$PLUGIN_DIR/elpis-remote.js.bak"
    echo "Plugin elpis-remote installé : $PLUGIN_DIR/elpis-remote.ts"
  else
    echo "⚠ Plugin elpis-remote non récupéré ($BASE/api/code/plugin.ts) —"
    echo "  serveur pas à jour ou fonctionnalité désactivée ; relancez ce script après mise à jour."
  fi
else
  echo "Plugin elpis-remote non installé (choix)."
  if [ -e "$PLUGIN_DIR/elpis-remote.ts" ] || [ -e "$PLUGIN_DIR/elpis-remote.js" ]; then
    rm -f "$PLUGIN_DIR/elpis-remote.ts" "$PLUGIN_DIR/elpis-remote.ts.bak" \\
          "$PLUGIN_DIR/elpis-remote.js" "$PLUGIN_DIR/elpis-remote.js.bak"
    echo "  Ancien plugin retiré ($PLUGIN_DIR) — opencode redevient 100 % local."
  fi
fi
# ── Conf elpis-remote : écrite DÈS que le plugin est installé, même SANS jeton.
#    La commande d'install est anonyme (aucun secret à copier) ; ce qu'elle pose
#    ici c'est la CIBLE (app_url) et le TLS (CA locale épinglée, sinon repli non
#    vérifié) — sans quoi le plugin se rabattrait sur « insecure » à la première
#    erreur de certificat. Le jeton arrive après, via « /remote login ».
if [ "$WANT_PLUGIN" = y ]; then
  RJSON="$CFG_DIR/elpis-remote.json"
  KEEP=false
  grep -qs '"enabled": *true' "$RJSON" 2>/dev/null && KEEP=true   # ré-install : garder l'état actif
  # Jeton : l'env s'il est fourni, sinon CELUI DÉJÀ APPAIRÉ — une ré-install ne
  # doit pas désappairer un poste qui marchait.
  TOKEN="\${ELPIS_REMOTE_TOKEN:-}"
  if [ -z "$TOKEN" ] && [ -f "$RJSON" ]; then
    TOKEN="$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$RJSON" | head -n1)"
  fi
  # ── Connexion au compte, ICI et pas dans opencode ──────────────────────────
  # L'API plugin d'opencode n'a AUCUNE primitive de saisie : un mot de passe
  # passé à /remote arriverait par la ligne de commande du TUI (affiché à
  # l'écran, conservé dans l'historique de commandes). Ce script, lui, tourne
  # dans un vrai shell : \`read -rs\` masque la frappe. On échange donc les
  # identifiants contre le jeton une bonne fois, et /remote marche ensuite seul.
  # Le mot de passe n'est JAMAIS écrit sur disque ni passé en argument.
  if [ -z "$TOKEN" ] && ( : < /dev/tty ) 2>/dev/null; then
    printf 'Connecter votre compte %s maintenant ? [Y/n] ' "$APP_URL" > /dev/tty
    read -r WANT_LOGIN < /dev/tty || WANT_LOGIN=""
    case "$WANT_LOGIN" in [nN]*) WANT_LOGIN=n ;; *) WANT_LOGIN=y ;; esac
    if [ "$WANT_LOGIN" = y ]; then
      COOKIES="$TMP/cookies.txt"
      for _try in 1 2 3; do
        printf '  Identifiant : ' > /dev/tty
        read -r LOGIN_USER < /dev/tty || LOGIN_USER=""
        printf '  Mot de passe : ' > /dev/tty
        # -s : frappe masquée. Le retour chariot n'étant pas affiché, on le pose.
        stty -echo 2>/dev/null < /dev/tty
        read -r LOGIN_PASS < /dev/tty || LOGIN_PASS=""
        stty echo 2>/dev/null < /dev/tty
        printf '\\n' > /dev/tty
        [ -n "$LOGIN_USER" ] && [ -n "$LOGIN_PASS" ] || { echo "  Identifiants vides."; continue; }
        # Les identifiants partent en corps JSON (jamais dans l'URL : elle
        # finirait dans les access logs). --data @- via stdin plutôt qu'en
        # argument : la ligne de commande curl est lisible dans \`ps\`.
        LOGIN_BODY="$(LOGIN_USER="$LOGIN_USER" LOGIN_PASS="$LOGIN_PASS" awk 'BEGIN{
          u=ENVIRON["LOGIN_USER"]; p=ENVIRON["LOGIN_PASS"];
          gsub(/\\\\/,"\\\\\\\\",u); gsub(/"/,"\\\\\\"",u);
          gsub(/\\\\/,"\\\\\\\\",p); gsub(/"/,"\\\\\\"",p);
          printf "{\\"username\\":\\"%s\\",\\"password\\":\\"%s\\"}", u, p }')"
        LOGIN_PASS=""   # plus besoin en mémoire du shell
        if printf '%s' "$LOGIN_BODY" | curl -fsS $APP_TLS -c "$COOKIES" \\
             -H 'Content-Type: application/json' --data @- \\
             "$APP_URL/api/login-lite" > /dev/null 2>&1; then
          LOGIN_BODY=""
          # Jeton DE CE POSTE, créé ici et montré une seule fois (le serveur
          # n'en garde que l'empreinte) : nommé d'après la machine, il se
          # révoque seul dans Paramètres › Connexions.
          HN="$(hostname 2>/dev/null | tr -cd 'A-Za-z0-9._-' | cut -c1-40)"
          TOKEN="$(curl -fsS $APP_TLS -b "$COOKIES" -X POST -H 'Content-Type: application/json' \\
                   --data "{\\"name\\":\\"opencode - \${HN:-poste}\\"}" "$APP_URL/api/code/token" 2>/dev/null \\
                   | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n1)"
          if [ -n "$TOKEN" ]; then
            echo "  ✓ Connecté ($LOGIN_USER) — jeton configuré."
            break
          fi
          echo "  Connexion réussie mais jeton indisponible (fonctionnalité Code désactivée ?)."
          break
        fi
        LOGIN_BODY=""
        echo "  ✗ Identifiants refusés."
      done
      rm -f "$COOKIES"
    fi
  fi
  # app_url = APP_URL (pas BASE) : l'amorçage peut être en clair alors que
  # l'app, elle, n'écoute qu'en https derrière Caddy.
  # La CA est DÉJÀ à sa place définitive ($CA_DST, posée à la récupération) —
  # ne pas la recopier ici : \`cp\` sur lui-même échouerait, et le script est en
  # \`set -e\`. On ne fait qu'écrire le chemin.
  TLS_JSON=""
  if [ -n "$CA_FILE" ]; then
    TLS_JSON=',\\n  "ca_file": "'"$CA_FILE"'"'
  elif [ "\${APP_URL#https://}" != "$APP_URL" ]; then
    TLS_JSON=',\\n  "insecure": true'
  fi
  printf '{\\n  "app_url": "%s",\\n  "token": "%s",\\n  "enabled": %s%b\\n}\\n' \\
    "$APP_URL" "$TOKEN" "$KEEP" "$TLS_JSON" > "$RJSON"
  if [ -n "$TOKEN" ]; then
    echo "Jeton elpis-remote configuré ($RJSON)."
    echo "→ Dans opencode, tapez simplement /remote pour remonter votre session dans la page « Code »."
    # ── Outils Elpis (MCP) : la config est re-récupérée AVEC le jeton du compte
    #    (vers l'APP, TLS vérifié — jamais sur l'amorçage en clair) : le serveur
    #    y ajoute le bloc \`\`mcp\`\` si son service d'outils est partagé et
    #    authentifié. Sinon (service non exposé) la config posée plus haut reste.
    if curl -fsS $APP_TLS -m 10 -H "x-elpis-token: $TOKEN" "$APP_URL/api/cli/opencode.json" \\
         -o "$TMP/opencode.user.json" 2>/dev/null && grep -q '"mcp"' "$TMP/opencode.user.json"; then
      cp "$TMP/opencode.user.json" "$CFG_DST"
      echo "Outils Elpis (MCP, au nom de \${LOGIN_USER:-votre compte}) ajoutés à $CFG_DST."
    else
      echo "Outils Elpis (MCP) non exposés par ce serveur — config opencode inchangée."
    fi
  else
    echo "Cible elpis-remote configurée ($RJSON) — pas encore de jeton."
    echo "→ Dans opencode, tapez /remote login : un code s'affiche, à saisir dans la page « Code » de l'app."
  fi
fi
# ── PATH : ajout idempotent aux fichiers rc du shell (gardé par un marqueur). ──
case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *)
    ADDED=""
    for RC in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile" "$HOME/.bash_profile"; do
      # .bashrc est créé s'il manque ; les autres ne sont touchés que s'ils existent.
      if [ ! -e "$RC" ] && [ "$RC" != "$HOME/.bashrc" ]; then continue; fi
      if grep -qs 'OPENCODE_ELPIS_PATH' "$RC" 2>/dev/null; then continue; fi
      {
        echo ''
        echo '# OPENCODE_ELPIS_PATH (installeur OpenCode)'
        echo 'case ":$PATH:" in *":'"$BIN_DIR"':"*) ;; *) export PATH="'"$BIN_DIR"':$PATH" ;; esac'
      } >> "$RC"
      ADDED="$ADDED $RC"
    done
    if [ -n "$ADDED" ]; then
      echo "PATH mis à jour dans :$ADDED"
      echo "→ Ouvrez un nouveau terminal, ou lancez : source $HOME/.bashrc"
    elif grep -qs 'OPENCODE_ELPIS_PATH' "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile" "$HOME/.bash_profile" 2>/dev/null; then
      echo "PATH déjà configuré (relance un terminal pour en profiter)."
    else
      echo "→ Ajoutez $BIN_DIR à votre PATH."
    fi
    ;;
esac
`;

export const INSTALL_PS1_PYTHON = `# Installeur OpenCode -- servi par __BASE__ (reseau local).
# NOTE : ce script doit rester 100% ASCII. PowerShell 5.1 (Win10/11) lit un
# .ps1 sans BOM en ANSI : un caractere accentue UTF-8 s'y decode en deux
# octets dont l'un peut FERMER une chaine et casser le parsing du fichier
# entier. Garde-fou cote serveur dans cli_install_ps1().
$ErrorActionPreference = 'Stop'
$Base   = '__BASE__'      # base des TELECHARGEMENTS (http en amorcage clair)
$AppUrl = '__APP_URL__'   # URL de l'app pour le plugin (https si frontal TLS)
# --- HTTPS (frontal Caddy, cert LAN auto-signe) : rien a faire tant qu'AUCUNE
# des deux URL n'est en https. En amorcage clair $Base est en http, mais $AppUrl
# peut etre en https (frontal TLS) -- et c'est LUI qu'on contacte pour connecter
# le compte : ne tester que $Base laissait cet appel echouer sur le cert.
# Si la verification echoue, on la desactive POUR CE SCRIPT
# (PS7 : SkipCertificateCheck ; PS5.1 : callback compile).
$Insecure = $false
if (($Base -like 'https://*') -or ($AppUrl -like 'https://*')) {
  if ($PSVersionTable.PSVersion.Major -lt 6) {
    # .NET Framework peut demarrer SANS TLS 1.2 alors que Caddy exige TLS >= 1.2
    # ("The underlying connection was closed") -- a activer AVANT tout appel.
    # 3072 = Tls12 (valeur numerique : l'enum manque sur les vieux .NET).
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
  }
  # Sonde l'URL https REELLEMENT en jeu (les deux si besoin).
  $ProbeUrl = if ($Base -like 'https://*') { "$Base/api/cli/opencode.json" } else { "$AppUrl/api/public-config" }
  try { Invoke-WebRequest -UseBasicParsing -Method Head -Uri $ProbeUrl -TimeoutSec 5 | Out-Null }
  catch {
    $Insecure = $true
    if ($PSVersionTable.PSVersion.Major -ge 6) {
      $PSDefaultParameterValues['Invoke-WebRequest:SkipCertificateCheck'] = $true
      # Invoke-RestMethod (lecture du jeton) est une AUTRE cmdlet : sans cette
      # 2e entree, elle repasserait par la verification et echouerait.
      $PSDefaultParameterValues['Invoke-RestMethod:SkipCertificateCheck'] = $true
    } else {
      # PAS de scriptblock { $true } : .NET peut invoquer le callback sur un
      # thread SANS runspace PowerShell -> handshake avorte ("The underlying
      # connection was closed"). Callback C# COMPILE (Add-Type) = thread-safe.
      if (-not ('ElpisTrustAll' -as [type])) {
        Add-Type 'using System.Net;public class ElpisTrustAll{public static void Go(){ServicePointManager.ServerCertificateValidationCallback=delegate{return true;};}}'
      }
      [ElpisTrustAll]::Go()
    }
    Write-Host "Certificat https non verifiable (CA locale) -- verification desactivee pour ce script."
  }
}
# --- CA locale : recuperee TOT (avant tout le reste) et proposee au magasin de
# confiance de l'utilisateur. C'est la vraie alternative a -k / SkipCertificate :
# une fois la CA approuvee, curl, git, le navigateur et opencode verifient
# reellement le certificat de l'app. Deux sources, la 2e rattrape les
# deploiements sans frontal :80 (https direct, port 80 filtre).
$CfgDir = Join-Path $env:USERPROFILE '.config\\opencode'
New-Item -ItemType Directory -Force -Path $CfgDir | Out-Null
$CaFile = $null
# Empreinte SHA-256 (hex, forme DER) inscrite par le serveur : sans elle, aucune CA n'est retenue.
$CaSha256 = '__CA_SHA256__'
function Get-ElpisCaSha256([string]$Path) {
  try {
    $c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList $Path
    $h = [System.Security.Cryptography.SHA256]::Create()
    return (($h.ComputeHash($c.RawData) | ForEach-Object { $_.ToString('x2') }) -join '')
  } catch { return '' }
}
if ((($AppUrl -like 'https://*') -or ($Base -like 'https://*')) -and (-not $CaSha256)) {
  Write-Host "Attention : ce serveur ne publie pas de CA locale -- aucune CA n'est recuperee ni installee."
} elseif (($AppUrl -like 'https://*') -or ($Base -like 'https://*')) {
  # Emplacement DURABLE tout de suite : c'est ce chemin que le greffon epingle
  # (ca_file) et que l'utilisateur peut reutiliser ensuite.
  $CaDst = Join-Path $CfgDir 'elpis-ca.crt'
  foreach ($u in @(("http://" + ([uri]$AppUrl).Host + "/ca.crt"), "$Base/api/cli/ca.crt", "$AppUrl/api/cli/ca.crt")) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $u -OutFile $CaDst -TimeoutSec 10
      if ((Get-Content $CaDst -Raw) -match 'BEGIN CERTIFICATE') {
        if ((Get-ElpisCaSha256 $CaDst) -eq $CaSha256.ToLower()) {
          $CaFile = $CaDst; Write-Host "CA locale recuperee ($u) -> $CaDst"; break
        }
        Write-Host "Attention : CA recue de $u refusee (empreinte SHA-256 differente de celle du serveur)."
      }
    } catch {}
  }
  if (-not $CaFile) {
    Remove-Item -Force -ErrorAction SilentlyContinue $CaDst
    Write-Host "Attention : CA locale introuvable ou non conforme a l'empreinte du serveur (ni :80, ni /api/cli/ca.crt)."
  }
}
# --- Confiance du poste : comportement PAR DEFAUT (opt-out ELPIS_TRUST_CA=n).
# Reseau local sans Internet : on amorce en clair, puis on installe la CA SUR LE
# POSTE. Ensuite curl, git et le navigateur parlent a l'app en https verifie --
# plus aucun -k, et le certificat retrouve son role. Cert:\\CurrentUser\\Root est
# le magasin de l'UTILISATEUR : aucun droit administrateur (Windows affiche une
# confirmation de securite, c'est normal et voulu). ---
if ($CaFile) {
  $AlreadyTrusted = $false
  try {
    Invoke-WebRequest -UseBasicParsing -Method Head -Uri "$AppUrl/api/public-config" -TimeoutSec 5 | Out-Null
    $AlreadyTrusted = $true
  } catch {}
  if ($AlreadyTrusted) {
    Write-Host "Certificat de $AppUrl deja reconnu par ce poste -- rien a installer."
  } elseif ($env:ELPIS_TRUST_CA -match '^[nN0]') {
    Write-Host "CA non ajoutee au magasin (ELPIS_TRUST_CA=n) -- elle reste epinglee pour opencode."
  } else {
    try {
      Import-Certificate -FilePath $CaFile -CertStoreLocation Cert:\\CurrentUser\\Root -ErrorAction Stop | Out-Null
      Write-Host "CA installee dans le magasin de confiance utilisateur -- https verifie partout sur ce poste."
    } catch {
      Write-Host "Attention : installation de la CA refusee ou impossible."
      Write-Host "  opencode et son greffon fonctionnent quand meme (CA epinglee : $CaFile)."
      Write-Host "  Pour les autres outils : Import-Certificate -FilePath '$CaFile' -CertStoreLocation Cert:\\CurrentUser\\Root"
    }
  }
}
$BinDir = if ($env:OPENCODE_BIN_DIR) { $env:OPENCODE_BIN_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\\opencode' }
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$Tmp = (New-Item -ItemType Directory -Force -Path (Join-Path $env:TEMP ('opencode-' + [guid]::NewGuid()))).FullName
$Bundle = Join-Path $Tmp 'opencode.zip'
Write-Host "Telechargement d'OpenCode (windows) depuis $Base ..."
Invoke-WebRequest -UseBasicParsing -Uri "$Base/api/cli/bundle/windows" -OutFile $Bundle
try { Expand-Archive -Force -Path $Bundle -DestinationPath $Tmp } catch { Copy-Item $Bundle (Join-Path $Tmp 'opencode.exe') -Force }
$Exe = Get-ChildItem -Path $Tmp -Recurse -Filter 'opencode*.exe' | Select-Object -First 1
if (-not $Exe) { $Exe = Get-Item (Join-Path $Tmp 'opencode.exe') }
Copy-Item $Exe.FullName (Join-Path $BinDir 'opencode.exe') -Force
Write-Host "OpenCode installe : $BinDir\\opencode.exe"
# --- Config Elpis : recuperee A CHAUD depuis le serveur (modeles + endpoint courants). ---
# ($CfgDir est defini plus haut : la CA y est deposee des sa recuperation.)
$CfgDst = Join-Path $CfgDir 'opencode.json'
$CfgSrc = $null
try {
  $Fresh = Join-Path $Tmp 'opencode.fresh.json'
  Invoke-WebRequest -UseBasicParsing -Uri "$Base/api/cli/opencode.json" -OutFile $Fresh
  $CfgSrc = $Fresh
  Write-Host "Config Elpis a jour recuperee depuis $Base."
} catch {
  $c = Get-ChildItem -Path $Tmp -Recurse -Filter 'opencode.json' | Select-Object -First 1
  if ($c) { $CfgSrc = $c.FullName; Write-Host "Config live indisponible -- repli sur la config embarquee (offline)." }
}
if ($CfgSrc) {
  if (Test-Path $CfgDst) { Copy-Item $CfgDst "$CfgDst.bak" -Force; Write-Host "Ancienne config sauvegardee : $CfgDst.bak" }
  Copy-Item $CfgSrc $CfgDst -Force
  Write-Host "Config Elpis installee (a jour) : $CfgDst"
}
# --- Pre-amorcage des dependances de plugin -- LE correctif "opencode met une
#     minute a demarrer". Des qu'un plugin est present, opencode lance un
#     \`npm install @opencode-ai/plugin\` dans chaque dossier de config et BLOQUE
#     le chargement des plugins dessus. Mesure : 30 s (1.17.7) a 71 s (1.18.16)
#     AVEC Internet, plusieurs minutes quand le reseau ne repond pas. opencode
#     saute l'install si node_modules existe et que le lock declare la
#     dependance : trois fichiers, zero telechargement. ---
$OcVersion = "1.0.0"
try {
  $v = (& (Join-Path $BinDir 'opencode.exe') --version 2>$null | Select-Object -First 1)
  if ($v -match '^[0-9][0-9.]*$') { $OcVersion = $v.Trim() }
} catch {}
$NodeMods = Join-Path $CfgDir 'node_modules'
if (-not (Test-Path $NodeMods)) {
  New-Item -ItemType Directory -Force -Path $NodeMods | Out-Null
  $PkgJson = Join-Path $CfgDir 'package.json'
  $LockJson = Join-Path $CfgDir 'package-lock.json'
  if (-not (Test-Path $PkgJson)) {
    '{ "dependencies": { "@opencode-ai/plugin": "' + $OcVersion + '" } }' | Set-Content -Encoding UTF8 $PkgJson
  }
  if (-not (Test-Path $LockJson)) {
    '{ "name": "opencode-config", "lockfileVersion": 3, "requires": true, "packages": { "": { "dependencies": { "@opencode-ai/plugin": "' + $OcVersion + '" } } } }' | Set-Content -Encoding UTF8 $LockJson
  }
  Write-Host "Dependances de plugin pre-amorcees -- demarrage immediat hors ligne."
}
# --- Plugin elpis-remote (TypeScript, charge nativement par opencode) : choix
#    EXPLICITE Y/n -- surcharge par ELPIS_INSTALL_PLUGIN=y|n ; defaut = y (ce
#    script est servi PAR l'app, l'intention est claire). Le jeton ne sert plus
#    d'indice : la commande d'install est anonyme, l'appairage se fait apres
#    coup via /remote login. ---
$PluginDir = Join-Path $CfgDir 'plugin'
$WantPlugin = $null
if ($env:ELPIS_INSTALL_PLUGIN) {
  $WantPlugin = ($env:ELPIS_INSTALL_PLUGIN -match '^[yYoO1]')
}
if ($null -eq $WantPlugin) {
  $Def = $true
  $Hint = if ($Def) { '[Y/n]' } else { '[y/N]' }
  try {
    $r = Read-Host "Installer le plugin elpis-remote (pilotage depuis la page Remote code) ? $Hint"
    if ($r -match '^[yYoO]') { $WantPlugin = $true }
    elseif ($r -match '^[nN]') { $WantPlugin = $false }
    else { $WantPlugin = $Def }
  } catch { $WantPlugin = $Def }
}
$OldPlugin = @('elpis-remote.js', 'elpis-remote.js.bak', 'elpis-remote.ts.bak') |
  ForEach-Object { Join-Path $PluginDir $_ }
if ($WantPlugin) {
  try {
    New-Item -ItemType Directory -Force -Path $PluginDir | Out-Null
    Invoke-WebRequest -UseBasicParsing -Uri "$Base/api/code/plugin.ts" -OutFile (Join-Path $PluginDir 'elpis-remote.ts')
    # ere pre-TypeScript : jamais DEUX plugins charges (opencode glob *.{ts,js})
    Remove-Item -Force -ErrorAction SilentlyContinue $OldPlugin
    Write-Host "Plugin elpis-remote installe : $PluginDir\\elpis-remote.ts"
  } catch {
    Write-Host "Plugin elpis-remote non installe (app injoignable ?) -- recuperable plus tard via $Base/api/code/plugin.ts"
  }
} else {
  Write-Host "Plugin elpis-remote non installe (choix)."
  $Leftover = @($OldPlugin + (Join-Path $PluginDir 'elpis-remote.ts')) | Where-Object { Test-Path $_ }
  if ($Leftover) { Remove-Item -Force $Leftover; Write-Host "  Ancien plugin retire ($PluginDir)." }
}
# --- Conf elpis-remote : ecrite DES que le plugin est installe, meme SANS jeton.
#     La commande d'install est anonyme ; ce qu'elle pose ici c'est la CIBLE
#     (app_url) et le TLS (CA locale epinglee). Le jeton arrive apres, via
#     /remote login. ---
if ($WantPlugin) {
  $RJson = Join-Path $CfgDir 'elpis-remote.json'
  $Keep = $false
  $Token = $env:ELPIS_REMOTE_TOKEN
  if (Test-Path $RJson) {
    try {
      $old = Get-Content $RJson -Raw | ConvertFrom-Json
      if ($old.enabled) { $Keep = $true }
      # Re-install : ne jamais desappairer un poste qui marchait.
      if (-not $Token -and $old.token) { $Token = $old.token }
    } catch {}
  }
  # CA locale : deja a sa place definitive ($CfgDir\\elpis-ca.crt, posee a la
  # recuperation). On ne fait que l'EPINGLER pour que le greffon (fetch Bun)
  # verifie vraiment l'app en https au lieu de se rabattre sur "insecure" --
  # Bun n'utilise PAS le magasin de Windows, l'epinglage reste indispensable
  # meme quand la CA a ete installee sur le poste.
  $CaPinned = $CaFile
  # --- Connexion au compte, ICI et pas dans opencode ---
  # L'API plugin d'opencode n'a AUCUNE primitive de saisie : un mot de passe
  # passe a /remote arriverait par la ligne de commande du TUI (affiche a
  # l'ecran, garde dans l'historique). Ce script tourne dans un vrai shell :
  # Read-Host -AsSecureString masque la frappe. Le mot de passe n'est jamais
  # ecrit sur disque, et le SecureString est efface juste apres l'envoi.
  if (-not $Token) {
    $ans = Read-Host "Connecter votre compte $AppUrl maintenant ? [Y/n]"
    if ($ans -notmatch '^[nN]') {
      $sess = New-Object Microsoft.PowerShell.Commands.WebRequestSession
      for ($i = 0; $i -lt 3; $i++) {
        $u = Read-Host "  Identifiant"
        $sec = Read-Host "  Mot de passe" -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
        try { $pw = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
        if (-not $u -or -not $pw) { Write-Host "  Identifiants vides."; continue }
        try {
          $payload = @{ username = $u; password = $pw } | ConvertTo-Json -Compress
          $pw = $null                       # plus besoin en clair
          Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$AppUrl/api/login-lite" \`
            -ContentType 'application/json' -Body $payload -WebSession $sess | Out-Null
          $payload = $null
          # Jeton DE CE POSTE, cree ici et montre une seule fois (le serveur
          # n'en garde que l'empreinte).
          $hn = ($env:COMPUTERNAME -replace '[^A-Za-z0-9._-]', '')
          if ($hn.Length -gt 40) { $hn = $hn.Substring(0, 40) }
          if (-not $hn) { $hn = 'poste' }
          $cfg = Invoke-RestMethod -Method Post -Uri "$AppUrl/api/code/token" -WebSession $sess \`
                   -ContentType 'application/json' -Body (@{ name = "opencode - $hn" } | ConvertTo-Json -Compress)
          if ($cfg.token) {
            $Token = $cfg.token
            Write-Host "  OK Connecte ($u) -- jeton configure."
            break
          }
          Write-Host "  Connexion reussie mais jeton indisponible (fonctionnalite Code desactivee ?)."
          break
        } catch {
          $pw = $null; $payload = $null
          Write-Host "  Identifiants refuses."
        }
      }
    }
  }
  # app_url = $AppUrl (PAS $Base) : l'amorcage peut etre en clair alors que
  # l'app, elle, n'ecoute qu'en https derriere Caddy.
  # token = '' (jamais $null : ConvertTo-Json ecrirait \`null\`, que le plugin
  # relit en \`undefined\` -- '' est le meme faux mais reste une chaine).
  $Conf = @{ app_url = $AppUrl; token = ''; enabled = $Keep }
  if ($Token) { $Conf.token = $Token }
  if ($CaPinned) { $Conf.ca_file = $CaPinned }                              # option tls de Bun
  elseif ($Insecure -or $AppUrl -like 'https://*') { $Conf.insecure = $true }
  $Conf | ConvertTo-Json | Set-Content -Encoding UTF8 $RJson
  if ($Token) {
    Write-Host "Jeton elpis-remote configure ($RJson)."
    Write-Host "-> Dans opencode, tapez simplement /remote pour remonter votre session dans la page Code."
    # --- Outils Elpis (MCP) : config re-recuperee AVEC le jeton du compte (bloc mcp
    #     ajoute par le serveur si son service d'outils est partage et authentifie).
    try {
      $UserCfg = Join-Path $Tmp 'opencode.user.json'
      Invoke-WebRequest -UseBasicParsing -Headers @{ 'x-elpis-token' = $Token } \`
        -Uri "$AppUrl/api/cli/opencode.json" -OutFile $UserCfg
      if ((Get-Content $UserCfg -Raw) -match '"mcp"') {
        Copy-Item $UserCfg $CfgDst -Force
        Write-Host "Outils Elpis (MCP) ajoutes a $CfgDst."
      } else {
        Write-Host "Outils Elpis (MCP) non exposes par ce serveur -- config opencode inchangee."
      }
    } catch { Write-Host "Outils Elpis (MCP) : config utilisateur non recuperee -- config opencode inchangee." }
  } else {
    Write-Host "Cible elpis-remote configuree ($RJson) -- pas encore de jeton."
    Write-Host "-> Dans opencode, tapez /remote login : un code s'affiche, a saisir dans la page Code de l'app."
  }
}
# --- PATH utilisateur (persistant, sans droits admin) -- idempotent. ---
$u = [Environment]::GetEnvironmentVariable('Path','User')
if (-not $u) { $u = '' }
if (($u -split ';') -notcontains $BinDir) {
  [Environment]::SetEnvironmentVariable('Path', ($u.TrimEnd(';') + ';' + $BinDir), 'User')
  $env:Path = $env:Path + ';' + $BinDir
  Write-Host "PATH utilisateur mis a jour. Rouvrez votre terminal pour en profiter."
} else {
  Write-Host "$BinDir est deja dans votre PATH."
}
`;

export const INSTALL_SH_TEMPLATE = sondesEnGet(INSTALL_SH_PYTHON, '--head "', '-o /dev/null "', 4);
export const INSTALL_PS1_TEMPLATE = sondesEnGet(
  INSTALL_PS1_PYTHON,
  "-Method Head -Uri",
  "-Method Get -Uri",
  2,
);
