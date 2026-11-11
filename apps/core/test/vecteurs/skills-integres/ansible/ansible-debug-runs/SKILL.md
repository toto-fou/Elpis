---
name: ansible-debug-runs
description: Tester un playbook Ansible à blanc puis l'exécuter en confiance — syntax-check, check plus diff, ciblage limit et tags, verbose, register et debug, diagnostic des erreurs courantes (unreachable, sudo, interpreter)
tags: [ansible, debug, check, diff, dry-run, limit, tags, verbose, unreachable, erreurs]
---

# Tester à blanc et déboguer un run Ansible

Valide un playbook sans toucher aux machines, l'exécute en ciblant précisément,
et isole la cause d'une tâche qui échoue.

## Pré-requis
- Un playbook et un inventaire fonctionnels (voir le package **ansible**).

## Voie rapide — script bundlé

```
skill_run_script(name="ansible/ansible-debug-runs", script="scripts/safe_run.sh",
                 args=["site.yml", "inventory.yml"])
skill_run_script(name="ansible/ansible-debug-runs", script="scripts/safe_run.sh",
                 args=["site.yml", "inventory.yml", "--limit", "web"],
                 env={"APPLY": "1"})
```

Le script s'exécute depuis `/work` : les chemins passés dans `args` sont
relatifs à ton dossier de travail. Il enchaîne syntax-check → run à blanc
`--check --diff` → et n'exécute RÉELLEMENT (`env={"APPLY": "1"}`) que si le
dry-run passe. Les options supplémentaires (`--limit`, `--tags`, `-e`…) sont
relayées telles quelles.

## Étapes (manuel)

1. **Valider la syntaxe** (rapide, aucun accès aux hôtes) :
   ```bash
   ansible-playbook --syntax-check site.yml
   ```

2. **Run à blanc avec diff** — montre ce qui CHANGERAIT, fichier par fichier :
   ```bash
   ansible-playbook -i inventory.yml site.yml --check --diff
   ```
   Limite connue : les tâches `command`/`shell` ne sont pas simulées (elles
   sont sautées en check, sauf `check_mode: false`), et une tâche qui dépend
   du résultat d'une précédente sautée peut échouer à tort.

3. **Cibler l'exécution** au lieu de tout rejouer :
   ```bash
   ansible-playbook -i inventory.yml site.yml --limit web1        # un hôte/groupe
   ansible-playbook -i inventory.yml site.yml --tags config       # tâches taguées
   ansible-playbook -i inventory.yml site.yml --start-at-task "Config nginx à jour"
   ansible-playbook -i inventory.yml site.yml --step              # confirmation tâche par tâche
   ```

4. **Voir ce qu'une tâche produit** — `register` + `debug` :
   ```yaml
   - name: Version applicative déployée
     ansible.builtin.command: /opt/app/bin/version
     register: app_version
     changed_when: false
   - ansible.builtin.debug:
       var: app_version.stdout
   ```

5. **Monter la verbosité quand ça échoue** : `-v` (résultats), `-vvv`
   (connexions + arguments réels des modules). Le JSON d'erreur du module se
   lit en bas du bloc rouge (`msg`, `stderr`, `rc`).

## Diagnostic des erreurs courantes

| Symptôme | Cause / geste |
|---|---|
| `UNREACHABLE` | SSH : tester `ansible <hôte> -i inv -m ping`, vérifier `ansible_host`, la clé, l'utilisateur (`ansible_user`) |
| `Missing sudo password` | `become: true` sans NOPASSWD → lancer avec `-K` (demande le mot de passe sudo) |
| `/usr/bin/python: not found` | poser `ansible_python_interpreter: /usr/bin/python3` dans l'inventaire |
| `Permission denied` sur une tâche | `become: true` manquant au play ou à la tâche |
| Handler jamais exécuté | aucune tâche `changed` ne l'a notifié — normal en check, ou tâche non idempotente à revoir |

## Vérification
- Le dry-run `--check --diff` ne liste QUE les changements attendus.
- Le run réel se termine `failed=0 unreachable=0`, et un SECOND run affiche
  `changed=0` (idempotence).

## Pièges
- `--limit` ne restreint que les hôtes, pas les tâches ; `--tags` l'inverse —
  les combiner pour un correctif chirurgical.
- `--check` sur un playbook jamais appliqué peut échouer à tort (dépendances
  entre tâches sautées) : ne pas conclure « cassé » sans lire QUELLE tâche.
- `-vvv` logge les arguments réels des modules : ne pas coller la sortie dans
  un ticket sans en retirer les secrets éventuels.
