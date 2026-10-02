# SPDX-License-Identifier: MIT
"""chatbot_app.turn — un tour de chat, hors de la couche HTTP.

- ``admission``   : verrou de présence (une génération à la fois par
                    conversation) et compactions manuelles en vol ;
- ``preparation`` : ``prepare_turn`` → ``TurnPlan``, ``TurnResources``,
                    ``PersistBaseline`` ;
- ``execution``   : ``run_turn`` (générateur NDJSON) et son worker ;
- ``events``      : pompe NDJSON vers le client, suivi de chargement ;
- ``persistence`` : enregistrement optimiste du tour et de ses métadonnées ;
- ``history``     : historique client ↔ base ↔ modèle, « Continuer » ;
- ``tasks``       : références fortes des tâches de fond.

Les routes qui s'en servent sont dans ``chatbot_app.routes`` ; ce paquet ne
les importe jamais.
"""
