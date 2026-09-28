# desktop-agent -- installeur WINDOWS (preparation HORS-LIGNE + auto-demarrage).
#   - prepare l'environnement via run.ps1 : Python embarque (standalone) + VRAI
#     venv + wheels embarquees, SANS aucune connexion internet ;
#   - propose une tache planifiee "a l'ouverture de session" (session interactive
#     = pilotage GUI possible ; un service Windows session-0 verrait un ecran noir).
# A lancer dans la session de l'utilisateur. Non-interactif : DESKTOP_SERVICE=1.
#
# NOTE encodage : 100% ASCII obligatoire. PowerShell 5.1 lit les .ps1 sans BOM en
# ANSI ; un accent / tiret long casse le parsing. Pas d'accents, pas de puces.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$Here = (Get-Location).Path

Write-Host "-> Preparation hors-ligne (Python embarque + venv + dependances) ..."
& powershell -NoProfile -ExecutionPolicy Bypass -File "$Here\run.ps1" -SetupOnly
if ($LASTEXITCODE -ne 0) { Write-Error "La preparation a echoue (voir messages ci-dessus)."; exit 1 }

$Port = if ($env:DESKTOP_AGENT_PORT) { $env:DESKTOP_AGENT_PORT } else { '8765' }

# -- Auto-demarrage : tache planifiee ONLOGON (session interactive) --
$Svc = $env:DESKTOP_SERVICE
if (-not $Svc -and [Environment]::UserInteractive) {
    $ans = Read-Host "Lancer l'agent automatiquement a l'ouverture de session ? [o/N]"
    if ($ans -match '^[oOyY]') { $Svc = '1' } else { $Svc = '0' }
}
if ($Svc -eq '1') {
    $tr = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$Here\run.ps1`" -Background"
    schtasks /Create /TN "desktop-agent" /SC ONLOGON /RL LIMITED /TR $tr /F | Out-Null
    Write-Host "[OK] Tache 'desktop-agent' creee (demarre a chaque ouverture de session)."
    schtasks /Run /TN "desktop-agent" | Out-Null
    Write-Host "[OK] Agent demarre en arriere-plan (port $Port)."
} else {
    Write-Host "[OK] Installe. Double-clic sur run.bat pour (re)lancer l'agent (port $Port)."
}
