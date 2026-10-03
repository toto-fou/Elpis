# SPDX-License-Identifier: MIT
"""shared_infra.image — génération d'images : configuration du moteur, droits,
magasin des images produites et routes utilisateur.

    config.py    bloc ``image`` de ``config.json`` (un seul moteur : sd-server
                 natif ou service compatible OpenAI), relu à chaud, bornes
                 appliquées à la lecture, clé API chiffrée
    access.py    qui peut générer : interrupteur d'instance, groupes autorisés,
                 cases du compte (Paramètres) et préférences par défaut
    store.py     fichiers ``user_db/generated_images/<uid>/`` + table
                 ``generated_images`` : rétention par compte, vignettes,
                 nettoyage des conversations et des comptes supprimés
    messages.py  champs « image » des messages du chat (références, demande,
                 erreur) : assainis à chaque aller-retour du client
    routes.py    ``/api/image/status`` et ``/api/images*``

Les clients des moteurs vivent dans ``llm_core/imagegen/`` ; le tour de chat
« Images » dans ``chatbot_app/turn/image.py`` ; l'outil du modèle dans
``llm_core/tools/image_tool.py`` ; la console dans
``shared_infra/routes/admin/image.py``.
"""
