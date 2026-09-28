---
name: ansible
description: Automatisation Ansible — écrire un playbook idempotent (tâches, handlers, rôles), organiser inventaire et variables de groupe, chiffrer les secrets avec ansible-vault, tester à blanc et déboguer un run (check, diff, verbose, limit, tags)
tags: [ansible, playbook, inventaire, vault, idempotence, ssh, devops, configuration, deploiement]
domain: ansible
compatibility: ansible-core 2.12+ (pip install ansible) + accès SSH aux hôtes cibles
---

# Ansible — package de procédures d'automatisation

Package des procédures Ansible. Chaque opération est un sous-skill autonome :
charger UNIQUEMENT celui qui correspond à la tâche, via `skill_get`.

| Sous-skill (`skill_get("ansible/…")`) | Quand l'utiliser |
|---|---|
| `ansible/ansible-write-playbook` | écrire ou structurer un playbook : tâches idempotentes, handlers, variables, rôles |
| `ansible/ansible-inventory-vault` | organiser l'inventaire (groupes, group_vars) et chiffrer les secrets avec ansible-vault |
| `ansible/ansible-debug-runs` | tester à blanc (check + diff), exécuter en ciblant (limit, tags) et diagnostiquer un run qui échoue |

## Pré-requis communs

- Installation et vérification :

  ```bash
  pip install ansible          # méta-paquet (ansible-core + collections)
  ansible --version
  ```

- Accès SSH par clé aux hôtes cibles (`ssh user@hote` doit fonctionner sans
  mot de passe interactif), Python présent sur les cibles.
- Test de connectivité de base :

  ```bash
  ansible all -i inventory.yml -m ping
  ```

## Ordre typique

Poser l'inventaire et les variables (`ansible-inventory-vault`) → écrire le
playbook (`ansible-write-playbook`) → le valider à blanc puis l'exécuter et
déboguer (`ansible-debug-runs`). Règle d'or transversale : un playbook se
rejoue N fois sans rien casser (idempotence) — viser `changed=0` au 2e run.
