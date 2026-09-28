---
name: robotframework-selenium-web
description: Automatiser un parcours web avec Robot Framework et SeleniumLibrary — locators fiables (css, xpath, id), attentes explicites anti-flaky, navigateur headless, capture au point d'échec
tags: [robotframework, selenium, seleniumlibrary, web, navigateur, locators, xpath, css, headless, flaky]
---

# Automatiser un parcours web avec SeleniumLibrary

Écrit des tests web Robot Framework stables : locators robustes, attentes
explicites (jamais de `Sleep`), exécution headless pour la CI.

## Pré-requis
- `pip install robotframework-seleniumlibrary` + un navigateur et son driver
  (Chrome/chromedriver ou Firefox/geckodriver) accessibles dans le `PATH`.
- Patterns prêts à copier bundlés avec ce skill :

  ```
  skill_read_file(name="robotframework/robotframework-selenium-web",
                  path="references/selenium-patterns.robot")
  ```

## Étapes

1. **Importer et configurer les timeouts GLOBAUX** (le vrai anti-flaky) :
   ```robotframework
   *** Settings ***
   Library    SeleniumLibrary    timeout=10s    implicit_wait=0
   ```
   `timeout` s'applique à tous les keywords `Wait Until *`. Laisser
   `implicit_wait` à 0 : l'attente implicite combinée aux waits explicites
   rend les échecs lents et imprévisibles.

2. **Ouvrir le navigateur** (headless en CI) :
   ```robotframework
   Open Browser    ${URL}    headlesschrome
   # ou : Open Browser    ${URL}    chrome    options=add_argument("--window-size=1440,900")
   ```

3. **Choisir des locators robustes**, dans cet ordre de préférence :
   - `id=email` (stable par construction) ;
   - attribut dédié aux tests : `css:[data-testid="submit"]` ;
   - `css:` court ancré sur la structure proche (`css:form.login button[type=submit]`) ;
   - `xpath://button[normalize-space()="Valider"]` en DERNIER recours (texte).
   Bannir les xpath positionnels (`//div[3]/span[2]`) : ils cassent au
   premier refactor du DOM.

4. **Attendre EXPLICITEMENT avant chaque interaction** sur un élément qui
   peut apparaître/changer :
   ```robotframework
   Wait Until Element Is Visible    css:[data-testid="submit"]
   Click Button                     css:[data-testid="submit"]
   Wait Until Location Contains     /dashboard
   ```
   Jamais `Sleep` : une attente fixe est toujours soit trop courte (flaky),
   soit trop longue (suite lente).

5. **Encapsuler en keywords métier** (« Se Connecter Avec ») et garder les
   locators en `*** Variables ***` (ou un resource « page object ») : un
   changement d'UI = une seule ligne à corriger.

## Vérification
- La suite passe 3 fois d'affilée en headless (`robot -d results …`) — un
  test web qui ne passe que « souvent » est un test cassé.
- Sur échec, `log.html` embarque la capture d'écran automatique
  (`Register Keyword To Run On Failure    Capture Page Screenshot` est le
  défaut de SeleniumLibrary).

## Pièges
- Élément « not interactable » : il est dans le DOM mais pas visible/cliquable
  — attendre `Element Is Visible` (pas seulement `Page Contains Element`),
  ou scroller (`Scroll Element Into View`).
- `StaleElementReferenceException` : le DOM a été re-rendu entre la
  localisation et l'action — re-localiser via un keyword `Wait Until` juste
  avant l'action, ne jamais stocker un élément longtemps.
- iframe : aucun locator ne « voit » dedans sans `Select Frame` d'abord
  (`Unselect Frame` pour revenir).
- Headless a une taille de fenêtre minuscule par défaut → menus responsive
  différents : toujours forcer `--window-size`.
