# desktop-agent -- relanceur Windows AUTONOME et HORS-LIGNE.
#
# Premier lancement (sans internet) :
#   1. extrait le Python embarque (python-build-standalone, dans python-win\),
#   2. cree un VRAI venv (.venv) avec ce Python,
#   3. y installe les wheels embarquees (wheels\windows\) -- aucune connexion.
# Lancements suivants : relance INSTANTANEE (le venv est reutilise tel quel).
#
# Usage :
#   run.bat                                  double-clic : prepare si besoin + lance
#   powershell -File run.ps1 -SetupOnly      prepare le venv SANS lancer
#   powershell -File run.ps1 -Background     lance sans console (pythonw)
#
# IMPORTANT -- 100% ASCII. PowerShell 5.1 (Win10/11) lit les .ps1 SANS BOM en
# ANSI : un accent / tiret long / guillemet courbe se decode en octet qui ferme
# une chaine et casse le parsing de tout le script. Pas d'accents, pas de puces.
param(
    [switch]$SetupOnly,
    [switch]$Background
)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$Here = (Get-Location).Path

$PyDir   = Join-Path $Here 'python-win'
$PyExe   = Join-Path $PyDir 'python\python.exe'
$VenvPy  = Join-Path $Here '.venv\Scripts\python.exe'
$VenvPyw = Join-Path $Here '.venv\Scripts\pythonw.exe'
$Wheels  = Join-Path $Here 'wheels\windows'
$Server  = Join-Path $Here 'server.py'

# -- 1. Python embarque : extraire l'archive standalone au 1er lancement --------
$arc = Get-ChildItem -Path $PyDir -Filter '*.tar.gz' -ErrorAction SilentlyContinue | Select-Object -First 1
if ((-not (Test-Path $PyExe)) -and $arc) {
    if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
        Write-Error "tar.exe absent (Windows 10 1803+ requis). Extrais '$($arc.Name)' a la main dans '$PyDir' (-> python\python.exe) puis relance."
        exit 1
    }
    Write-Host "-> Extraction du Python embarque (une seule fois) ..."
    & tar -xf $arc.FullName -C $PyDir          # bsdtar Windows gere le .tar.gz
}
if (-not (Test-Path $PyExe)) {
    if ($arc) {
        Write-Error "Extraction du Python embarque echouee ($PyExe absent apres tar). Verifie '$($arc.Name)'."
    } else {
        Write-Error "Python embarque absent ($PyDir vide). Genere le bundle avec fetch_offline_deps.sh (cote serveur, avec internet)."
    }
    exit 1
}

# -- 2. venv : creer si absent --------------------------------------------------
if (-not (Test-Path $VenvPy)) {
    Write-Host "-> Creation du venv ..."
    & $PyExe -m venv .venv
    if (-not (Test-Path $VenvPy)) { Write-Error "Echec de creation du venv."; exit 1 }
}

# -- 2b. deps : (re)installer TANT QUE pywinauto n'est pas importable ------------
# AUTO-REPARANT et idempotent. Couvre les cas qui laissaient pywinauto absent :
#   1. venv NEUF (1er lancement) ;
#   2. venv ANCIEN cree avant l'ajout de pywinauto (install jadis sautee) ;
#   3. pywin32 non enregistre -- les DLL pythoncom/pywintypes restent introuvables
#      dans un venv, donc 'import win32api' (et donc 'import pywinauto') echoue.
#
# IMPORTANT (PS 5.1) : python et pip ecrivent sur stderr (warnings pip, traceback
# d'un import qui echoue). Avec $ErrorActionPreference='Stop', une ecriture stderr
# d'un exe natif -- MEME redirigee vers $null -- peut lever une "NativeCommandError"
# TERMINANTE qui avorte le script : c'est l'erreur vue "lors de la verif de
# pywinauto". On bascule donc en 'Continue' pour TOUTE la section et on se fie
# uniquement a $LASTEXITCODE.
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'

function Test-PyImport([string]$mod) {
    & $VenvPy -c "import $mod" *> $null
    return ($LASTEXITCODE -eq 0)
}

# pywin32 dans un venv : poser les DLL pythoncom*/pywintypes* la ou le chargeur les
# cherche -- a cote des .pyd win32 ET dans Scripts (sur le PATH de DLL du venv).
# Methode hors-ligne, sans toucher au systeme, qui rend le postinstall inutile.
function Repair-Pywin32 {
    $site = Join-Path $Here '.venv\Lib\site-packages'
    $src  = Join-Path $site 'pywin32_system32'
    if (-not (Test-Path $src)) { return }
    foreach ($dst in @((Join-Path $site 'win32'), (Join-Path $Here '.venv\Scripts'))) {
        if (Test-Path $dst) {
            Copy-Item (Join-Path $src '*.dll') $dst -Force -ErrorAction SilentlyContinue
        }
    }
}

if (-not (Test-PyImport 'pywinauto')) {
    Write-Host "-> Installation des dependances (hors-ligne) ..."
    # pyautogui SANS ses dependances (--no-deps) : il declare mouseinfo et pymsgbox
    # (GPL-3.0, imports optionnels). Ses dependances utiles (MIT/BSD) sont explicites.
    $pkgs = @('fastapi', 'uvicorn', 'Pillow', 'mss', 'pywinauto',
              'pyscreeze', 'pytweening', 'pygetwindow', 'pyrect', 'pyperclip')
    $NoDeps = Join-Path $Here 'requirements-windows-nodeps.txt'
    if (Test-Path $Wheels) {
        # --no-index : zero reseau. pip resout TOUS les transitifs depuis wheels\windows.
        & $VenvPy -m pip install --no-index --find-links $Wheels @pkgs
        & $VenvPy -m pip install --no-index --find-links $Wheels --no-deps -r $NoDeps
    } else {
        Write-Host "   (aucune wheel embarquee -- tentative EN LIGNE ; lance fetch_offline_deps.sh pour l'offline)"
        & $VenvPy -m pip install @pkgs
        & $VenvPy -m pip install --no-deps -r $NoDeps
    }

    # pywin32 : rendre pythoncom/pywintypes importables. D'abord la methode robuste
    # (copie de DLL, hors-ligne) ; le postinstall officiel n'est qu'un dernier repli.
    if (-not (Test-PyImport 'win32api')) {
        Write-Host "-> Reparation de pywin32 (DLL dans le venv) ..."
        Repair-Pywin32
    }
    if (-not (Test-PyImport 'win32api')) {
        $pw32 = Join-Path $Here '.venv\Scripts\pywin32_postinstall.py'
        if (Test-Path $pw32) {
            Write-Host "-> Postinstall pywin32 (repli) ..."
            & $VenvPy $pw32 -install -silent
            Repair-Pywin32
        }
    }

    if (Test-PyImport 'pywinauto') {
        Write-Host "[OK] Environnement pret (pywinauto importable)."
    } else {
        Write-Host "[!] pywinauto NON importable -- mode degrade (clics OK, activation/launch limites)."
        Write-Host "    Astuce : supprime le dossier .venv puis relance pour un venv propre."
    }
}

$ErrorActionPreference = $prevEAP

if ($SetupOnly) {
    Write-Host "[OK] Pret. Double-clic sur run.bat pour demarrer l'agent."
    exit 0
}

# -- 3. Lancer l'agent ---------------------------------------------------------
$Port = if ($env:DESKTOP_AGENT_PORT) { $env:DESKTOP_AGENT_PORT } else { '8765' }
if ($Background -and (Test-Path $VenvPyw)) {
    Start-Process -FilePath $VenvPyw -ArgumentList "`"$Server`"" -WorkingDirectory $Here
    Write-Host "[OK] Agent demarre en arriere-plan (port $Port)."
} else {
    Write-Host "[OK] Demarrage de l'agent (port $Port). Ctrl-C pour arreter."
    & $VenvPy $Server
}
