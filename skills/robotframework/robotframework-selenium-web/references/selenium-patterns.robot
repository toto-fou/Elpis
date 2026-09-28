*** Settings ***
Documentation     Patterns SeleniumLibrary prêts à copier : timeouts globaux,
...               headless, locators robustes, attentes explicites, page object
...               minimal en keywords. Ce fichier est une référence, pas une
...               suite à lancer telle quelle (l'URL est fictive).
Library           SeleniumLibrary    timeout=10s    implicit_wait=0
Suite Teardown    Close All Browsers

*** Variables ***
${URL}                    https://app.example.com/login
${BROWSER}                headlesschrome
# Locators centralisés (mini « page object ») : 1 changement d'UI = 1 ligne.
${CHAMP_EMAIL}            id=email
${CHAMP_MDP}              css:[data-testid="password"]
${BOUTON_LOGIN}           css:form.login button[type=submit]
${BANNIERE_ERREUR}        css:[role="alert"]

*** Test Cases ***
Parcours Nominal De Login
    Ouvrir L'Application
    Se Connecter Avec    alice    s3cret
    Wait Until Location Contains    /dashboard
    Wait Until Element Is Visible   css:[data-testid="user-menu"]

Erreur Visible Sur Mauvais Mot De Passe
    Ouvrir L'Application
    Se Connecter Avec    alice    mauvais-mdp
    Wait Until Element Is Visible    ${BANNIERE_ERREUR}
    Element Should Contain           ${BANNIERE_ERREUR}    identifiants invalides

*** Keywords ***
Ouvrir L'Application
    [Documentation]    Taille de fenêtre FORCÉE : headless démarre minuscule.
    Open Browser    ${URL}    ${BROWSER}
    ...    options=add_argument("--window-size=1440,900")
    Wait Until Element Is Visible    ${CHAMP_EMAIL}

Se Connecter Avec
    [Arguments]    ${user}    ${mdp}
    [Documentation]    Attendre AVANT chaque interaction — jamais de Sleep.
    Wait Until Element Is Visible    ${CHAMP_EMAIL}
    Input Text                       ${CHAMP_EMAIL}    ${user}
    Input Password                   ${CHAMP_MDP}      ${mdp}
    Click Button                     ${BOUTON_LOGIN}

Travailler Dans Une Iframe
    [Documentation]    Aucun locator ne voit dans une iframe sans Select Frame.
    Select Frame     css:iframe#editeur
    Input Text       css:.zone-texte    contenu
    Unselect Frame
