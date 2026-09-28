---
name: nom-du-skill
description: Une phrase décrivant l'action — soigne les mots-clés (sert au matching)
tags: [logiciel, domaine, mot-clé]
---

# Titre de la procédure

<!--
Un skill = une procédure actionnable. Conventions :
  - FORMAT DE RÉFÉRENCE : un DOSSIER `[<domaine>/]<name>/SKILL.md` (name == dossier),
    avec ses ressources bundlées (`scripts/`, `references/`, `assets/`) — voir le
    package `ansible/` en exemple. Ce gabarit mono-fichier reste accepté (legacy).
  - description : dense en mots-clés (c'est ce qui déclenche l'injection).
  - corps : étapes concrètes, commandes exactes, chemins réels. Les scripts
    bundlés se référencent via l'outil d'exécution
    (`skill_run_script(name="<pkg>/<name>", script="scripts/x.sh", args=[…])`).
  - reste autonome : ne suppose pas que le lecteur connaît déjà le contexte.
  - cible une SEULE action ; si la procédure se ramifie, fais un PACKAGE
    (SKILL.md d'aperçu + sous-skills imbriqués, chargés via skill_get("pkg/enfant")).
Ce fichier (_TEMPLATE.md) est ignoré par le loader.
-->

## Pré-requis
- …

## Étapes
1. …
2. …

## Vérification
- Comment savoir que c'est réussi.

## Pièges
- Erreurs fréquentes et comment les éviter.
