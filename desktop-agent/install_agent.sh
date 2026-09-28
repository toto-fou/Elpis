#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# desktop-agent — installeur LINUX.
#   • hors-ligne si des wheels sont embarquées (wheels/linux/), sinon en ligne ;
#   • propose un auto-démarrage « à l'ouverture de session » (service systemd
#     UTILISATEUR — un service système ne verrait pas l'écran).
# À lancer DANS la session graphique de la machine cible. python3 requis.
#
# Non-interactif (piped) : honore DESKTOP_SERVICE=1 pour installer le service.
set -euo pipefail
cd "$(dirname "$0")"
HERE="$(pwd)"

command -v python3 >/dev/null || { echo "python3 requis (ex. sudo apt install -y python3 python3-venv)"; exit 1; }

echo "→ Environnement Python (venv) ..."
python3 -m venv .venv
# shellcheck disable=SC1091
. .venv/bin/activate
python -m pip install --quiet --upgrade pip 2>/dev/null || true

# pyautogui est installé SANS ses dépendances (--no-deps) : il déclare mouseinfo et
# pymsgbox (GPL-3.0, imports optionnels) et python3-Xlib (GPL-2.0). Ses dépendances
# utiles sont installées explicitement (python-xlib LGPL, le reste MIT/BSD).
DEPS=(fastapi "uvicorn[standard]" Pillow mss python-xlib pyscreeze pytweening pyperclip)
if ls wheels/linux/*.whl >/dev/null 2>&1; then
    echo "→ Installation HORS-LIGNE depuis wheels/linux ..."
    { python -m pip install --quiet --no-index --find-links wheels/linux "${DEPS[@]}" \
      && python -m pip install --quiet --no-index --find-links wheels/linux --no-deps -r requirements-linux-nodeps.txt; } \
        || echo "[!] des deps offline manquent → l'agent tournera en mode dégradé (observe seul)"
else
    echo "→ Installation EN LIGNE (aucune wheel embarquée — lance fetch_offline_deps.sh côté serveur pour l'offline) ..."
    { python -m pip install --quiet "${DEPS[@]}" \
      && python -m pip install --quiet --no-deps -r requirements-linux-nodeps.txt; } || true
fi
# Arbre d'accessibilité (optionnel) : paquet SYSTÈME, pas pip.
python -c "import gi" 2>/dev/null || echo "[i] AT-SPI absent (a11y optionnel) → sudo apt install -y python3-gi gir1.2-atspi-2.0"

PORT="${DESKTOP_AGENT_PORT:-8765}"

# -- Auto-démarrage (session graphique) : service systemd UTILISATEUR --
SVC="${DESKTOP_SERVICE:-}"
if [ -z "$SVC" ] && [ -t 0 ]; then
    read -r -p "Lancer l'agent automatiquement à l'ouverture de session ? [o/N] " ans
    case "$ans" in [oOyY]*) SVC=1 ;; *) SVC=0 ;; esac
fi
if [ "${SVC:-0}" = "1" ]; then
    UDIR="$HOME/.config/systemd/user"
    mkdir -p "$UDIR"
    cat > "$UDIR/desktop-agent.service" <<EOF
[Unit]
Description=desktop-agent (control agent)
After=graphical-session.target

[Service]
ExecStart=$HERE/.venv/bin/python $HERE/server.py
Environment=DESKTOP_AGENT_PORT=$PORT
# DISPLAY requis pour piloter le GUI (X11). Ajuste si ta session diffère.
Environment=DISPLAY=:0
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
    loginctl enable-linger "$USER" 2>/dev/null || true
    systemctl --user daemon-reload 2>/dev/null || true
    if systemctl --user enable --now desktop-agent.service 2>/dev/null; then
        echo "[✓] Service utilisateur activé (auto-démarrage). Logs : journalctl --user -u desktop-agent -f"
        exit 0
    fi
    echo "[!] systemd --user indisponible → lancement direct."
fi

echo "[✓] Installé. Lancement de l'agent (Ctrl-C pour arrêter)…"
exec python server.py
