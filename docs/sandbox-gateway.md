# Passerelle sandbox — outils locaux et conteneur utilisateur

Comment les *outils locaux* du LLM agissent sur la sandbox d'un utilisateur :
ce qui est livré, et ce qui reste une proposition.

## Deux chemins d'accès

Les effets des outils atteignent le conteneur Docker de l'utilisateur
(`elpis-sb-<user>`, `/work` monté depuis l'hôte) par deux chemins :

| Appelant | Chemin | Frontière |
|---|---|---|
| `execute_shell`, terminal, routes d'écriture de l'éditeur | `docker exec` | noyau / conteneur |
| `fs_tools`, lectures de l'éditeur | direct sur l'hôte (`os`, `shutil`) | résolution de chemin sous la racine de la sandbox, puis ouverture par descripteurs sans suivre de lien |
| `git_tools`, routes Git de l'éditeur | `git` sur l'hôte dans une prison `bwrap` | la prison ne voit que la zone de travail de l'utilisateur |

Côté hôte, la sûreté repose donc sur la résolution de chemin, les accès par
descripteurs et, pour git, sur la prison et le durcissement de sa
configuration. L'hôte et le conteneur (UID 10001) partageant le même
volume, les fichiers écrits par l'hôte sont élargis en écriture (`0o666` /
`0o777`) pour rester modifiables depuis le conteneur.

## Composants livrés

| Composant | Fichier | Rôle |
|---|---|---|
| Résolution de chemin (`resolve_under`, `write_beneath`) | `shared_infra/sandbox/paths.py` | refuse `..`, NUL, préfixe voisin, lien symbolique sortant ; écriture composant par composant (`O_NOFOLLOW`) |
| Durcissement git (`hardened_git_env`, `repo_refusal`) | `shared_infra/sandbox/git_env.py` | `GIT_TERMINAL_PROMPT=0`, hooks désactivés (`core.hooksPath=/dev/null`), dépôt refusé si sa config déclare une commande |
| Prison des git hôte (`run_host_git`) | `shared_infra/sandbox/git_env.py`, `bwrap.py` | seule la zone de travail montée ; réseau pour le seul transfert (extraction et fusion hors réseau) ; `executors.git_isolation` |
| Table de politique `OP_BACKEND` | `shared_infra/sandbox/policy.py` | choix hôte / conteneur par opération, défaut `host` |
| Cache de disponibilité (`ReadinessCache`) | `shared_infra/sandbox/executors/_readiness.py` | état « conteneur démarré » alimenté par `docker events` |
| Profil d'exécution durci (optionnel) | `shared_infra/sandbox/executors/_user_sandbox.py` (`_build_run_args`) | `executors.runtime` (ex. gVisor `runsc`) et `executors.extra_run_args`, vides par défaut |

## Table `OP_BACKEND`

`opération → host | agent`, surchargée par `SANDBOX_GATEWAY_<OP>=agent|host`
(`<OP>` = nom en majuscules, `.` → `_`). Une valeur non reconnue est ignorée
avec un avertissement. Toutes les opérations valent `host` par défaut.

| Opération | Effet de `agent` aujourd'hui |
|---|---|
| `fs.write` | plus d'élargissement des droits (`0o644`, pas de `0o777`) : un seul UID possède `/work` |
| `git.network` | clone / fetch / push exécutés dans le conteneur (`docker exec`, UID 10001) sous le profil réseau de l'utilisateur ; profil isolé → erreur `network_isolated` ; identifiants (askpass) refusés → `credentials_not_supported_in_container` |
| `fs.read`, `fs.list`, `fs.grep`, `fs.stat`, `git.read`, `exec.shell`, `snapshot` | aucun : déclarées dans la table, sans lecteur dans le code |

## Non livré (proposition)

Un agent résident dans le conteneur, joint par un socket authentifié monté
depuis l'hôte, ferait du conteneur la frontière unique de toutes les
opérations (lecture, écriture, git, exec, instantanés). Il n'existe pas dans
le code : les opérations `agent` ci-dessus passent par `docker exec`, et le
répertoire `.sandboxd` n'est plus qu'un nom réservé dans `paths.py`.

## Tests

`tests/shared_infra/` : `test_sandbox_paths.py`, `test_git_env.py`,
`test_readiness_cache.py`, `test_sandbox_policy.py`, `test_run_args.py`,
`test_sandbox_exec_recovery.py` ; `tests/llm_core/test_fs_path_helpers.py`.
