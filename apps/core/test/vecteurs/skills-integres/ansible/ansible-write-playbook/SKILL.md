---
name: ansible-write-playbook
description: Écrire un playbook Ansible idempotent — structure plays/tâches, modules plutôt que shell, handlers avec notify, variables et templates Jinja2, découpage en rôles
tags: [ansible, playbook, taches, handlers, roles, idempotence, jinja2, modules, yaml]
---

# Écrire un playbook Ansible idempotent

Structure un playbook rejouable à volonté : modules déclaratifs, handlers pour
les redémarrages, variables séparées du code, rôles quand ça grossit.

## Pré-requis
- `pip install ansible` + inventaire fonctionnel (voir le package **ansible**
  et **ansible-inventory-vault**).
- Un playbook complet et commenté est bundlé avec ce skill :

  ```
  skill_read_file(name="ansible/ansible-write-playbook",
                  path="references/playbook.example.yml")
  ```

## Étapes

1. **Squelette d'un play** — cible, élévation, variables, tâches :

   ```yaml
   - name: Déployer le service web
     hosts: web
     become: true                # sudo sur la cible
     vars:
       app_port: 8080
     tasks:
       - name: Paquet nginx présent
         ansible.builtin.apt:
           name: nginx
           state: present
   ```

2. **Toujours un module dédié, jamais `shell` si un module existe**
   (`apt`/`dnf`, `copy`, `template`, `file`, `service`, `user`, `git`,
   `lineinfile`…). Les modules sont idempotents par construction : ils ne
   rapportent `changed` que s'ils ont réellement modifié l'état.

3. **Si `shell`/`command` est inévitable**, le rendre idempotent :
   ```yaml
   - name: Initialiser la base
     ansible.builtin.command: /opt/app/init-db.sh
     args:
       creates: /var/lib/app/.initialized   # ne relance pas si le fichier existe
   ```
   (`creates:`/`removes:`, ou `changed_when:`/`failed_when:` sur un test.)

4. **Handlers = actions déclenchées seulement si quelque chose a changé**
   (typiquement un restart) :
   ```yaml
   tasks:
     - name: Config nginx à jour
       ansible.builtin.template:
         src: nginx.conf.j2
         dest: /etc/nginx/nginx.conf
       notify: Recharger nginx
   handlers:
     - name: Recharger nginx
       ansible.builtin.service: { name: nginx, state: reloaded }
   ```
   Un handler s'exécute UNE fois en fin de play, même notifié dix fois.

5. **Variables** : au play (`vars:`), en fichiers (`vars_files:`), ou par
   groupe/hôte (`group_vars/`, `host_vars/` — voir
   **ansible-inventory-vault**). Dans les templates Jinja2 : `{{ app_port }}`.

6. **Passer en rôles** dès qu'un play dépasse ~15 tâches ou se réutilise :
   ```
   roles/webserver/{tasks,handlers,templates,defaults}/main.yml
   ```
   puis dans le playbook : `roles: [webserver]`. `ansible-galaxy init
   roles/webserver` génère le squelette.

## Vérification
- `ansible-playbook --syntax-check site.yml` passe.
- Premier run : les tâches attendues sont `changed` ; **2e run immédiat :
  `changed=0`** — c'est LE critère d'idempotence.

## Pièges
- `shell: systemctl restart x` à chaque run = restart à chaque run (jamais
  idempotent) : c'est exactement le rôle d'un handler.
- Oublier `become: true` → erreurs de permission sur apt/service/fichiers
  système ; le poser au play, pas tâche par tâche.
- `template` sans `validate:` sur une config critique peut casser le service :
  `validate: nginx -t -c %s` teste AVANT de remplacer.
- YAML : les valeurs avec `{{ var }}` en début de valeur doivent être quotées
  (`name: "{{ app_user }}"`), sinon erreur de parsing.
