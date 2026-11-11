---
name: ansible-inventory-vault
description: Organiser un inventaire Ansible (groupes, children, group_vars, host_vars) et chiffrer les secrets avec ansible-vault — create, edit, encrypt_string, rekey, vault-id
tags: [ansible, inventaire, inventory, groupes, group-vars, vault, secrets, chiffrement, yaml]
---

# Inventaire Ansible et secrets chiffrés (ansible-vault)

Structure l'inventaire par groupes avec variables séparées, et met TOUS les
secrets sous ansible-vault — jamais de mot de passe en clair dans git.

## Pré-requis
- `pip install ansible` (voir le package **ansible**).
- Un inventaire YAML commenté (groupes, children, vars) est bundlé :

  ```
  skill_read_file(name="ansible/ansible-inventory-vault",
                  path="references/inventory.example.yml")
  ```

## Étapes

1. **Inventaire YAML par groupes** (fichier `inventory.yml`) — voir la
   référence bundlée. Points clés : `children` compose des groupes de
   groupes ; `ansible_host` découple nom logique et IP ; `all: vars:` pose
   les défauts globaux.

2. **Sortir les variables dans `group_vars/` / `host_vars/`** (à côté de
   l'inventaire) — Ansible les charge automatiquement par NOM de
   groupe/hôte :
   ```
   inventory.yml
   group_vars/all.yml        # défauts pour tout le monde
   group_vars/web.yml        # spécifiques au groupe web
   host_vars/web1.yml        # spécifiques à UN hôte
   ```
   Précédence utile (du plus faible au plus fort) : `group_vars/all` →
   `group_vars/<groupe>` → `host_vars/<hôte>` → `-e` en ligne de commande.

3. **Contrôler l'inventaire résolu** :
   ```bash
   ansible-inventory -i inventory.yml --graph      # arbre des groupes
   ansible-inventory -i inventory.yml --host web1  # variables effectives d'un hôte
   ```

4. **Chiffrer les secrets** — le fichier vault est un YAML normal chiffré :
   ```bash
   ansible-vault create group_vars/all/vault.yml   # crée + ouvre l'éditeur
   ansible-vault edit   group_vars/all/vault.yml   # éditer plus tard
   ansible-vault rekey  group_vars/all/vault.yml   # changer le mot de passe
   ```
   Convention lisible : les clés vault portent un préfixe `vault_`, et les
   fichiers en clair les référencent :
   ```yaml
   # group_vars/all/vault.yml (chiffré) :  vault_db_password: "s3cret"
   # group_vars/all/vars.yml  (en clair) :  db_password: "{{ vault_db_password }}"
   ```
   Une seule valeur dans un fichier en clair :
   `ansible-vault encrypt_string 's3cret' --name 'vault_db_password'`.

5. **Fournir le mot de passe au run** :
   ```bash
   ansible-playbook site.yml --ask-vault-pass
   ansible-playbook site.yml --vault-password-file ~/.vault_pass   # CI (fichier hors git, mode 600)
   ```

## Vérification
- `ansible-inventory --graph` montre la hiérarchie attendue.
- `git grep -i password` ne remonte AUCUN secret en clair ; les fichiers
  vault commencent par `$ANSIBLE_VAULT;1.1;AES256`.
- `ansible-vault view group_vars/all/vault.yml` relit le contenu.

## Pièges
- Un hôte présent dans deux groupes hérite des DEUX `group_vars` — en cas de
  conflit, l'ordre alphabétique des groupes tranche : vérifier avec
  `ansible-inventory --host`.
- `group_vars/` doit être à côté de l'inventaire (ou du playbook) — posé
  ailleurs, il est silencieusement ignoré.
- Chiffrer tout `group_vars/all.yml` d'un bloc rend les diffs illisibles :
  préférer le duo `vars.yml` clair + `vault.yml` chiffré (étape 4).
- Le mot de passe vault dans l'historique shell : utiliser
  `--vault-password-file`, jamais `--vault-pass 'xxx'` (n'existe pas) ni un
  export d'environnement loggué.
