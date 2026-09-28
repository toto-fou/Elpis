# SPDX-License-Identifier: MIT
"""toolhost — l'hôte d'outils Elpis (2026-09-11, P4).

Unité DÉPORTABLE : service MCP (familles fs/shell/git/skill_run/browser/desktop)
+ API sandbox (fichiers, git, cycle de vie, instantanés) + terminal (PTY) +
actifs (captures, trames) + ``/health`` + ``/manifest``, dans UN processus,
derrière un jeton de service et une enveloppe d'identité signée fournie par
l'app. Il n'ouvre jamais la base de l'app : son état propre (sessions de
terminal, mémoire AX du navigateur, audit) vit dans SA base locale.

Lancement : ``python -m toolhost`` (lit ``toolhost.json``, cf. ``toolhost/config.py``).
Mode local = même code, sur la même machine, en loopback — c'est ce que lance
``./elpis start``.
"""
