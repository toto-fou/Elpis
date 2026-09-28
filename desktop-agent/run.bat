@echo off
REM desktop-agent -- relance facile (double-clic). Delegue a run.ps1 qui, au
REM premier lancement, extrait le Python embarque + cree le venv hors-ligne,
REM puis lance l'agent. Les lancements suivants sont instantanes.
REM Variable optionnelle : set DESKTOP_AGENT_PORT=8765
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" %*
