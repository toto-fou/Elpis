@echo off
rem run-script.bat mon_script.py [--param=valeur ...]
rem Execute un script d'automatisation genere par le Studio, avec le Python de
rem l'agent (.venv cree par run.bat au premier lancement). Code de sortie :
rem 0 ok, 1 verification echouee, 2 erreur d'execution.
setlocal
set HERE=%~dp0
if not exist "%HERE%.venv\Scripts\python.exe" (
    echo Le venv de l'agent est absent : lance d'abord run.bat une fois.
    exit /b 2
)
"%HERE%.venv\Scripts\python.exe" -m elpis_auto %*
exit /b %ERRORLEVEL%
