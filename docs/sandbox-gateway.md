# Passerelle sandbox — l'agent du conteneur et le relais Git

Comment Elpis agit sur la sandbox d'un utilisateur : le conteneur est la
frontière. Toute opération de l'agent s'exécute dans la sandbox de
l'utilisateur : l'hôte lui demande ce qu'il faut faire et ne touche jamais
lui-même au contenu de `/work`, hors des exceptions ci-dessous.

## Chemins d'accès

| Appelant | Chemin | Frontière |
|---|---|---|
| `execute_shell`, terminal | `docker exec`, UID 10001 | noyau / conteneur |
| outils fichiers ; éditeur (arbre, lecture, écriture, recherche, aperçus, imports) | agent du conteneur | conteneur |
| outils Git, panneau Git de l'éditeur | agent du conteneur (`git`) | conteneur |
| réseau Git lancé par Elpis (`clone`, `fetch`, `pull`, `push`, `ls-remote`) | agent, puis relais de l'hôte | ticket par opération |
| téléchargements, export et import, instantanés, sauvegarde et restauration | agent du conteneur (`archive`, `extract`) | conteneur |

Un seul UID écrit dans `/work`, celui du conteneur (10001 par défaut) :
fichiers 0644, dossiers 0755 (agent, commandes et terminal en umask 0022).
Au démarrage, le root du conteneur rend `/work` à cet UID en 0755, et une
fois par compte tout l'arbre hérité de l'ancien élargissement (0666 / 0777,
fichiers à l'UID de l'app) : `chown -R`, `chmod -R go-w`
(`UserSandbox._reconcile_work_modes`).

Exceptions de l'hôte, toutes hors du contenu des fichiers :

- `du` pour le quota : métadonnées seules, liens non suivis ;
- suppression d'un compte : `rmtree` par descripteurs ; ce qui appartient à
  l'UID du conteneur est d'abord effacé par son root
  (`UserSandbox.purge`) ;
- création de `P/work` et migration d'une ancienne arborescence
  (`ensure_work_subdir`), avant tout usage du conteneur.

Les parties de `P` qui appartiennent à l'hôte (miroir des skills, mémoire,
dépôt des instantanés — hors du montage) sont parcourues par descripteurs,
sans suivre de lien (`shared_infra/sandbox/paths.py`).

## L'agent

- `shared_infra/sandbox/agent/server.py` : bibliothèque standard,
  Python ≥ 3.9. Code monté en lecture seule (`/opt/elpis/agent`), lancé à la
  demande par `docker exec -d` sous l'UID du conteneur, sans capacités, et
  relancé si sa version (empreinte du fichier) diffère de celle de
  l'application.
- Canal : HTTP/1.1 sur `/run/elpis/agent.sock` (sur l'hôte :
  `<utilisateur>/.elpis-agent/agent.sock`). L'hôte ouvre le socket sans
  suivre de lien et tient toute réponse pour non fiable : tailles et délais
  bornés, jamais un chemin de l'hôte tiré d'une réponse
  (`shared_infra/sandbox/agent_client.py`).
- Appel passif (sondages de l'éditeur) : ne redémarre pas un conteneur
  arrêté et ne compte pas comme une activité de la sandbox.
- API `/v1` : `hello`, `stat`, `read`, `list`, `grep`, `readmany`, `write`,
  `append`, `fsop` (`mkdir`, `remove`, `rename`, `copy`, `chmod`, `clear`,
  `du`), `changes/begin` et `changes/end`, `archive`, `extract`, `git`,
  `shutdown` ; le détail est en tête de `server.py`.

## Git

- `git` tourne dans le conteneur (`shared_infra/sandbox/git_ops.py`) : UID de
  la sandbox, `HOME=/work` ; pour les commandes d'Elpis, ni hooks, ni
  moniteur, ni signature, ni invite d'identifiants ; identité par défaut
  « Elpis », que la configuration de l'utilisateur remplace.
- Réseau (`shared_infra/sandbox/git_relay.py`) :
  - chaque processus de l'app écoute sur
    `user_sandboxes/.elpis-relay/<pid>.sock`, dossier monté en lecture
    seule sur `/run/elpis-relay` ;
  - une opération réseau d'Elpis reçoit un ticket (jeton aléatoire gardé
    en mémoire par le processus qui le délivre) : compte, dépôt amont,
    service Git, refs permises au push, échéance ; il est révoqué en fin
    d'opération ;
  - pour la durée de la commande, l'agent ouvre `127.0.0.1:<port>` dans le
    conteneur et relaie chaque connexion vers ce socket, précédée d'une
    ligne qui porte le ticket ; `git` y est dirigé par
    `url.<relais>.insteadOf` (l'URL du remote ne change pas) ;
  - le relais n'accepte que le protocole Git « smart HTTP » du dépôt du
    ticket, filtre les en-têtes, ajoute l'identifiant du connecteur (un
    identifiant saisi, lui, n'est envoyé qu'après un 401 de l'amont), refait
    la garde anti-SSRF et joint l'amont sans proxy, en TLS pour un remote
    `https://` (un remote `http://` passe en clair) ; une redirection de
    l'amont est refusée ; au push, il lit les commandes et refuse une ref
    hors du ticket ou une suppression. Les refs du ticket d'un push de
    l'éditeur sont celles que donne `git push --dry-run --porcelain` ;
  - la sortie de Git et `FETCH_HEAD` reprennent l'URL d'origine ; `pull` =
    `fetch` par le relais, puis fusion dans le conteneur.
- Le socket du relais est joignable depuis toutes les sandboxes : une
  connexion sans ticket valide est fermée (5 s pour le présenter, 64
  connexions au plus). Pendant une opération, l'écoute locale de l'agent est
  joignable par tout processus de la sandbox, pour le seul dépôt, service
  et refs du ticket. Hors opération, le terminal n'a que le réseau de son
  profil.

## Archives : ce qu'il faut savoir

- Restauration d'un instantané et import d'une archive : une ancienne entrée
  que l'agent ne peut pas effacer (dossier d'un autre propriétaire) est mise
  de côté sous `<nom>.elpis-ancien-<hex>` ; une nouvelle entrée qui ne trouve
  pas sa place l'est sous `<nom>.elpis-restaure-<hex>`. Rien n'est perdu ;
  l'interface signale le nombre d'entrées à vérifier.
- Avant un import, un instantané de `/work` est pris (« Avant import du
  … », hors de `/work`, restaurable depuis l'éditeur) ; s'il ne peut l'être
  (trop volumineux, opération en cours), l'import est refusé et `/work` reste
  intact. Comme tout instantané, il peut faire retirer le plus ancien au-delà
  du nombre gardé par compte.
- Une restauration demande l'espace de l'instantané en plus de `/work`
  (extraction, puis échange) ; faute de place : 507, `/work` intact.
- Téléchargement ou export en flux : six heures au plus ; un client qui ne
  lit plus rien pendant dix minutes est coupé.
- Sauvegarde admin : une sandbox arrêtée est démarrée pour la lecture de son
  `/work`, qui ne compte pas comme une activité, puis arrêtée de nouveau. Si
  le `/work` d'un compte ne peut être lu (Docker arrêté, image absente), la
  sauvegarde est nommée `…_incomplet.zip` et n'est comptée comme réussie ni
  par la console, ni par l'envoi distant, ni par `./elpis backup` (code 1).
- L'historique d'un fichier (éditeur) se lit par l'agent : il démarre le
  conteneur au besoin.

## Tests

`tests/shared_infra/` : `test_agent_sandbox_2026_09_29.py` (agent et
client), `test_git_relais_2026_09_29.py` (git et relais de bout en bout,
avec `git http-backend`), `test_relecture_editeur_agent_2026_09_29.py`,
`test_adversarial_sandbox_2026_09_29.py`, `test_archives_agent_2026_09_29.py`,
`test_frontiere_interception_2026_09_30.py` (aucun accès de l'hôte à
`/work` pendant les parcours), `test_frontiere_agent_2026_09_30.py`,
`test_sandbox_paths.py`, `test_run_args.py` ;
`tests/sandbox/test_git_routes_agent_2026_09_29.py` (routes Git de
l'éditeur), `tests/llm_core/test_git_network_backend.py` (outils Git par le
relais), `tests/llm_core/test_relecture_agent_fichiers_2026_09_29.py`.
