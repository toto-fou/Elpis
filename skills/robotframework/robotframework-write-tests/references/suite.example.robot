*** Settings ***
Documentation     Suite d'exemple commentée : login d'une application web.
...               Montre les 4 sections, les keywords maison, les variables,
...               le data-driven ([Template]) et les setup/teardown.
Library           Collections
Library           String
Suite Setup       Préparer La Suite
Suite Teardown    Nettoyer La Suite
Test Tags         login

*** Variables ***
${URL_BASE}       https://app.example.com
${UTILISATEUR}    alice
${MDP_VALIDE}     s3cret
# Liste (@) et dictionnaire (&) — se déplient avec @{...} / &{...}
@{ROLES}          admin    user    invite
&{ENTETES}        Content-Type=application/json    Accept=application/json

*** Test Cases ***
Le Login Accepte Des Identifiants Valides
    [Documentation]    Cas nominal — le détail technique vit dans les keywords.
    [Tags]    smoke
    Se Connecter Avec    ${UTILISATEUR}    ${MDP_VALIDE}
    La Session Doit Être Ouverte

Le Login Refuse Un Mot De Passe Invalide
    Se Connecter Avec    ${UTILISATEUR}    mauvais-mdp
    L'Erreur Doit Contenir    identifiants invalides

Le Login Échoue Pour Chaque Entrée Invalide
    [Documentation]    Data-driven : un scénario, N jeux de données.
    [Template]    Le Login Doit Échouer Avec
    ${EMPTY}      ${MDP_VALIDE}
    ${UTILISATEUR}    ${EMPTY}
    alice'--      x

*** Keywords ***
Préparer La Suite
    [Documentation]    Exécuté UNE fois avant tous les cas.
    Log    Démarrage des tests sur ${URL_BASE}

Nettoyer La Suite
    Log    Fin de la suite — nettoyage global.

Se Connecter Avec
    [Arguments]    ${user}    ${mdp}
    [Documentation]    Keyword métier : cache le détail (UI ou API) aux cas.
    Log    Connexion de ${user}
    Set Test Variable    ${DERNIER_USER}    ${user}
    Set Test Variable    ${DERNIER_MDP}     ${mdp}

La Session Doit Être Ouverte
    Should Be Equal    ${DERNIER_MDP}    ${MDP_VALIDE}

L'Erreur Doit Contenir
    [Arguments]    ${fragment}
    Should Not Be Equal    ${DERNIER_MDP}    ${MDP_VALIDE}
    Log    Erreur attendue contenant « ${fragment} »

Le Login Doit Échouer Avec
    [Arguments]    ${user}    ${mdp}
    Se Connecter Avec    ${user}    ${mdp}
    Run Keyword And Expect Error    *    La Session Doit Être Ouverte
