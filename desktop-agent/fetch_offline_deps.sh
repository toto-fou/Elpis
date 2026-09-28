#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Pré-télécharge (UNE fois, avec internet, CÔTÉ SERVEUR) tout le nécessaire à un
# déploiement 100 % HORS-LIGNE du desktop-agent sur une VM sans internet :
#
#   • Windows (cible principale) :
#       - un Python COMPLET et relocatable (python-build-standalone, qui — contrairement
#         à l'« embeddable » — embarque `venv` + `pip` + `ensurepip`) → python-win/ ;
#       - TOUTES les wheels cp311/win_amd64, y compris `pyautogui` & ses dépendances
#         permissives (sans mouseinfo/pymsgbox, GPL) : pur-python mais SANS wheel
#         publiée → on en CONSTRUIT des wheels universelles
#         (`py3-none-any`, valides sur Windows) ici, avec internet.
#   • Linux (best-effort) : wheels cp311 manylinux (AT-SPI reste un paquet système).
#
# Ces artefacts s'embarquent dans le bundle (« Télécharger le client »). La VM
# installe ensuite SANS internet : run.bat → vrai venv hors-ligne depuis wheels/.
#
#   DESKTOP_PYVER     : version Python cible des wheels        (def 3.11)
#   DESKTOP_PBS_TAG   : tag du release python-build-standalone (def 20260610)
#   DESKTOP_PBS_PYFULL: version exacte du Python standalone     (def 3.11.15)
#   DESKTOP_PBS_URL   : URL complète (override) de l'archive standalone Windows
set -euo pipefail
cd "$(dirname "$0")"

PYVER="${DESKTOP_PYVER:-3.11}"
PBS_TAG="${DESKTOP_PBS_TAG:-20260610}"
PBS_PYFULL="${DESKTOP_PBS_PYFULL:-3.11.15}"
PBS_URL="${DESKTOP_PBS_URL:-https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/cpython-${PBS_PYFULL}+${PBS_TAG}-x86_64-pc-windows-msvc-install_only.tar.gz}"
PIP="${PIP:-python3 -m pip}"

# Paquets DIRECTS ; pip résout les transitifs depuis le même dossier à l'install.
# Binaires (ont des wheels win_amd64). comtypes/pywin32 = deps win32-only de
# pywinauto, SAUTÉES en cross-download (marqueurs sys_platform) → on les FORCE.
WIN_BINARY=(fastapi uvicorn Pillow mss pywinauto comtypes pywin32 colorama numpy)
# Pur-python SANS wheel publiée : pyautogui + ses dépendances PERMISSIVES. pyautogui
# s'installe en --no-deps (requirements-*-nodeps.txt) : mouseinfo et pymsgbox
# (GPL-3.0, imports optionnels) ne sont ni construits ni livrés.
WIN_PUREPY=(pyautogui==0.9.54 pyscreeze pygetwindow pyrect pytweening pyperclip)
LINUX_PKGS=(fastapi "uvicorn[standard]" Pillow mss numpy python-xlib)
# Linux : python-xlib (LGPL-2.1+, wheel publiée) remplace python3-Xlib (GPL-2.0).
LINUX_PUREPY=(pyautogui==0.9.54 pyscreeze pytweening pyperclip)

echo "==> Wheels Windows (cp${PYVER//./}/win_amd64) → wheels/windows ..."
rm -rf wheels/windows && mkdir -p wheels/windows
$PIP download --only-binary=:all: --platform win_amd64 \
    --python-version "$PYVER" --implementation cp -d wheels/windows "${WIN_BINARY[@]}"
# Build des wheels pur-python ICI (avec internet) → installables offline ensuite.
$PIP wheel --no-deps -w wheels/windows "${WIN_PUREPY[@]}"
echo "    $(ls wheels/windows | wc -l) wheels prêtes."

# Auto-vérif : la FERMETURE transitive (marqueurs évalués pour Windows cp311) est-elle
# complète ? Échoue au build plutôt que de livrer un bundle qui casse offline.
echo "==> Vérification de la fermeture offline Windows ..."
python3 - <<'PYCHK' || { echo "[X] Fermeture Windows INCOMPLETE → ajoute le(s) paquet(s) ci-dessus à WIN_BINARY/WIN_PUREPY."; exit 1; }
import glob, zipfile, sys
try:
    from packaging.requirements import Requirement
    from packaging.utils import canonicalize_name
except Exception:
    print("    (packaging absent — vérif sautée)"); sys.exit(0)
WIN = {'os_name':'nt','sys_platform':'win32','platform_system':'Windows','platform_machine':'AMD64',
       'platform_release':'10','python_version':'3.11','python_full_version':'3.11.15',
       'platform_python_implementation':'CPython','implementation_name':'cpython','implementation_version':'3.11.15'}
present, metas = {}, {}
for whl in glob.glob('wheels/windows/*.whl'):
    z = zipfile.ZipFile(whl); m = [n for n in z.namelist() if n.endswith('.dist-info/METADATA')][0]
    md = z.read(m).decode('utf-8', 'replace')
    nm = canonicalize_name(m.split('.dist-info')[0].rsplit('/', 1)[-1].rsplit('-', 1)[0])
    present[nm] = 1
    metas[nm] = [l[14:].strip() for l in md.splitlines() if l.startswith('Requires-Dist:')]
ROOTS = ['fastapi','uvicorn','Pillow','mss','pywinauto','pyscreeze','pytweening','pygetwindow','pyrect','pyperclip']
NODEPS = ['pyautogui']          # installé en --no-deps : ses Requires-Dist (GPL) ne sont PAS suivis
GPL = {'mouseinfo', 'pymsgbox', 'python3-xlib'}
bad = sorted(n for n in present if n in GPL)
if bad: print("    GPL dans wheels/windows :", bad); sys.exit(1)
seen, missing, stack = set(NODEPS), [n for n in NODEPS if n not in present], [canonicalize_name(r) for r in ROOTS]
while stack:
    n = stack.pop()
    if n in seen: continue
    seen.add(n)
    if n not in present: missing.append(n); continue
    for rd in metas.get(n, []):
        try: req = Requirement(rd)
        except Exception: continue
        if req.marker and not req.marker.evaluate({**WIN, 'extra': ''}): continue
        stack.append(canonicalize_name(req.name))
if missing: print("    MANQUANTS:", sorted(set(missing))); sys.exit(1)
print("    [OK] %d paquets, fermeture transitive complete." % len(seen))
PYCHK

echo "==> Python embarqué Windows ($PBS_PYFULL, standalone full + venv) → python-win/ ..."
rm -rf python-win && mkdir -p python-win
if curl -fSL --retry 3 "$PBS_URL" -o python-win/python-standalone.tar.gz; then
    echo "    OK ($(du -h python-win/python-standalone.tar.gz | cut -f1)) — extrait au 1er run par run.ps1."
else
    echo "[!] standalone non récupéré ($PBS_URL) → Windows retombera sur le python système."
    rmdir python-win 2>/dev/null || true
fi

echo "==> Wheels Linux (best-effort ; AT-SPI = paquet système) → wheels/linux ..."
rm -rf wheels/linux && mkdir -p wheels/linux
$PIP download --only-binary=:all: --platform manylinux2014_x86_64 \
    --python-version "$PYVER" --implementation cp -d wheels/linux "${LINUX_PKGS[@]}" \
  || echo "[!] des wheels Linux manquent (PyGObject = paquet système, normal)."
$PIP wheel --no-deps -w wheels/linux "${LINUX_PUREPY[@]}" \
  || echo "[!] wheels pur-python Linux (pyautogui…) non construites → input X11 absent hors ligne."

echo "[✓] Deps offline prêtes. Régénère le bundle pour les y inclure."
