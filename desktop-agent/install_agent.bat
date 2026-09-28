@echo off
REM desktop-agent -- installeur (double-clic). Passe par -ExecutionPolicy Bypass
REM pour eviter le blocage des .ps1 non signes : sur une machine en Restricted /
REM AllSigned / RemoteSigned (defaut Windows), lancer install_agent.ps1 a la main
REM echoue "meme en admin". Ce wrapper contourne la policy pour CE lancement
REM uniquement (rien de permanent n'est modifie sur la machine).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install_agent.ps1" %*
echo.
pause
