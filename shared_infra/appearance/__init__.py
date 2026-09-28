# SPDX-License-Identifier: MIT
"""shared_infra/appearance — l'apparence de l'instance : skins et mascottes.

Famille créée le 2026-09-28 avec les « skins plugins ». Elle réunit :

- ``skins.py`` : le registre des skins. Les skins INTÉGRÉS sont décrits par
  ``frontend/css/skins/skins.json`` (leur CSS est servi en statique) ; les
  skins IMPORTÉS ou créés depuis la console vivent dans ``SKINS_DIR``
  (``user_skins/`` par défaut), un dossier par skin (``skin.json`` + ``skin.css``
  facultatif + ``assets/``). L'état d'instance (skins activés, skin par défaut)
  est dans ``config.json`` › ``skins`` et se relit à chaque appel. Le module
  valide strictement tout ce qui entre (identifiants, jetons CSS, feuille,
  images) : un skin est du CSS servi à tous les comptes.
- le registre des mascottes (``frontend/assets/mascotte/mascottes.json``),
  source unique pour la validation du réglage ``welcome_mascot`` et pour
  l'interface.
- ``routes.py`` : ``GET /api/skins`` (skins activés, pour tout compte connecté),
  service de la feuille et des images d'un skin importé. Les routes
  d'administration sont dans ``shared_infra/routes/admin/skins.py``.

Le module de routes est importé par ``shared_infra/routes/__init__.py`` (ordre
d'enregistrement), jamais depuis ce fichier.
"""
