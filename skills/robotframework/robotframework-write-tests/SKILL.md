---
name: robotframework-write-tests
description: Écrire une suite de tests Robot Framework (.robot) — sections Settings/Variables/Test Cases/Keywords, keywords maison avec arguments, resource files, Setup/Teardown, tags, templates data-driven
tags: [robotframework, robot, tests, suite, keywords, variables, resource, tags, data-driven]
---

# Écrire une suite de tests Robot Framework

Structure une suite `.robot` lisible et maintenable : cas de test courts en
langage métier, logique factorisée dans des keywords maison, données en
variables, partage via resource files.

## Pré-requis
- `pip install robotframework` (voir le package **robotframework**).
- Un exemple complet et commenté est bundlé avec ce skill — le lire avant
  d'écrire sa première suite :

  ```
  skill_read_file(name="robotframework/robotframework-write-tests",
                  path="references/suite.example.robot")
  ```

## Étapes

1. **Squelette de la suite** — quatre sections, dans cet ordre :

   ```robotframework
   *** Settings ***
   Documentation     Ce que couvre la suite, en une phrase.
   Library           Collections
   Resource          commun.resource
   Suite Setup       Préparer L'Environnement
   Test Teardown     Nettoyer Le Cas

   *** Variables ***
   ${URL_BASE}       https://app.example.com
   @{PROFILS}        admin    user    invite

   *** Test Cases ***
   Le Login Refuse Un Mot De Passe Invalide
       [Tags]    auth    smoke
       Ouvrir La Page De Login
       Se Connecter Avec    alice    mauvais-mdp
       L'Erreur Doit Contenir    identifiants invalides

   *** Keywords ***
   Se Connecter Avec
       [Arguments]    ${user}    ${mdp}
       # …étapes techniques ici, pas dans le cas de test…
   ```

2. **Un cas de test = un scénario métier court** (3 à 7 lignes). Tout détail
   technique (sélecteurs, appels HTTP, parsing) descend dans un keyword maison
   de la section `*** Keywords ***`.

3. **Factoriser entre suites** avec un *resource file* (`commun.resource`,
   même syntaxe sans section Test Cases) importé par `Resource`. Les
   bibliothèques Python maison s'importent avec `Library    mon_module.py`.

4. **Données paramétrées** : pour rejouer le même scénario avec N jeux de
   données, utiliser `[Template]` :

   ```robotframework
   Login Refusé Pour Chaque Entrée Invalide
       [Template]    Le Login Doit Échouer Avec
       alice         ${EMPTY}
       ${EMPTY}      secret
       alice'--      x
   ```

5. **Setup/Teardown** : `Suite Setup`/`Suite Teardown` (une fois),
   `Test Setup`/`Test Teardown` (chaque cas) — surchargables par cas via
   `[Setup]`/`[Teardown]`. Le teardown s'exécute MÊME si le cas échoue :
   c'est là que vivent les nettoyages.

6. **Tags** : poser des `[Tags]` (ou `Test Tags` global) dès l'écriture —
   c'est la clé du lancement sélectif (`robot -i smoke`), voir
   **robotframework-run-and-debug**.

## Vérification
- `robot --dryrun -d results suite.robot` : valide syntaxe et résolution des
  keywords sans exécuter (échoue sur keyword inconnu ou argument manquant).

## Pièges
- La séparation des arguments est DEUX espaces minimum (ou tabulation) ; un
  seul espace concatène et produit « keyword non trouvé ».
- `${var}` est une valeur scalaire, `@{list}` déplie une liste, `&{dict}` un
  dictionnaire — les confondre casse silencieusement les arguments.
- Ne pas mettre d'assertions dans le Setup : un setup qui échoue marque le cas
  en erreur sans exécuter le teardown de suite correctement.
- Nommer les keywords en langage métier (« Se Connecter Avec ») et non
  technique (« Cliquer Bouton 3 ») : la suite reste lisible par un non-dev.
