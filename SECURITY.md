# Security policy / Politique de sécurité

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.
Use the private vulnerability reporting of the repository hosting service
("Security" tab → "Report a vulnerability"), or contact the maintainers
privately. Include:

- the affected version or commit,
- a description of the problem and its impact,
- the steps to reproduce it (a minimal proof of concept if possible).

We aim to acknowledge a report within 7 days and to publish a fix, with
credit if you wish, once it is available.

## Signaler une faille

Merci de **ne pas ouvrir de ticket public** pour un problème de sécurité.
Utilisez le signalement privé de vulnérabilité de l'hébergeur du dépôt
(onglet « Security » → « Report a vulnerability »), ou contactez les
mainteneurs en privé, avec la version concernée, l'impact et les étapes pour
reproduire.

## Scope / Périmètre

Elpis runs code on behalf of users inside a per-user Docker sandbox. Reports
about escaping that sandbox, crossing user boundaries, authentication or
session handling, and server-side request forgery are especially welcome.
Deployments that expose the `desktop-agent` or the tool host without
authentication are outside the supported configuration.

## Threat model (summary)

Elpis trusts its administrators. Users are authenticated and isolated from one
another. The LLM agent acting for a user, and everything in that user's
sandbox, are untrusted: the agent may follow instructions found in a web page,
a document or a repository. The per-user container is the security boundary.
The service account drives Docker, which makes it close to root on the host:
run Elpis on a dedicated machine or VM. Details below, in French.

## Modèle de menace

**Acteurs**

- Administrateurs : confiance totale (comptes, connecteurs et leurs clés,
  sauvegardes).
- Utilisateurs : authentifiés, isolés entre eux (conversations, fichiers,
  sandbox, identifiants Git).
- L'agent LLM d'un utilisateur : **non fiable**. Il agit avec les droits de
  cet utilisateur et peut suivre des instructions trouvées dans une page web,
  un document ou un dépôt.
- Le contenu d'une sandbox, écrit par l'utilisateur et son agent : **non
  fiable** pour l'hôte.

**Frontières**

- Navigateur ↔ serveur : session, rôles et droits ; les aperçus de fichiers
  actifs (HTML, SVG) sont servis depuis une origine opaque.
- Utilisateur ↔ utilisateur : données filtrées par compte côté serveur ; une
  sandbox et un conteneur par compte.
- Sandbox ↔ hôte : le conteneur est la frontière (seules les capacités
  nécessaires — ni `NET_RAW`, ni `MKNOD` —, limites mémoire, CPU et
  processus, réseau par profil). Côté hôte, le contenu de
  `/work` n'est lu ou écrit que par des descripteurs qui ne suivent aucun
  lien ; Git tourne dans la sandbox, et ses opérations réseau lancées par
  Elpis passent par un relais de l'hôte qui y ajoute l'identifiant : les
  identifiants Git restent sur l'hôte.
- Serveur ↔ réseau : adresses des dépôts Git et des serveurs MCP vérifiées
  et résolues côté serveur (voir les limites ci-dessous).

**Hors périmètre**

- Un administrateur malveillant, ou une machine hôte déjà compromise.
- L'exactitude des réponses d'un modèle, les modèles et fournisseurs
  eux-mêmes.
- Un `desktop-agent` ou un hôte d'outils exposé sans authentification ; une
  instance ouverte au réseau sans HTTPS.

**Limites connues**

- Pendant une opération Git réseau lancée par Elpis (au plus sa durée), le
  relais accepte les requêtes Git venues de la sandbox pour le seul dépôt et
  le seul service de l'opération ; un push n'y modifie que les refs
  demandées, sans suppression. Le terminal de la sandbox n'a pas accès au
  relais.
- Serveur MCP distant : son adresse est vérifiée quand il est enregistré, pas
  à chaque résolution DNS.

**Responsabilités**

| Couche | Assure |
|---|---|
| Interface | échappement des contenus, aucun secret côté client, aperçus actifs isolés |
| API | authentification, rôles et droits, limites de taille et de débit des outils |
| Runtime agentique | outils autorisés par conversation, budgets, annulation |
| Sandbox | isolation par conteneur, quotas, profils réseau |
| Administration | comptes, connecteurs et leurs clés, sauvegardes |

**Configurations supportées** : Debian 12/13 ou Ubuntu 24.04 ; Docker et
`bubblewrap` de la distribution (`./elpis doctor`, aperçus Office isolés) ;
écoute locale par défaut,
HTTPS (Caddy) dès que l'instance est ouverte au réseau.

**Compte de service** : il pilote Docker ; membre du groupe `docker`, il est
de fait **proche de root** sur l'hôte. Réservez à Elpis une machine ou une VM
dédiée, et protégez le compte, `user_db/` et `backups/`. `user_sandboxes/`
lui est réservé (0700) : le root d'un conteneur peut y poser des fichiers
setuid ; un point de montage dédié `nosuid,nodev` les neutralise aussi pour
le compte de service.

**Isolation renforcée**, non couverte par nos tests :

- un runtime à noyau applicatif, gVisor (`executors.runtime = "runsc"`) :
  l'option la plus isolante pour une instance multi-utilisateurs ;
- le remappage d'UID du démon Docker (`userns-remap`) ou Docker rootless : le
  root du conteneur n'est plus root sur l'hôte. Réglages du démon, qui
  s'appliquent à tous ses conteneurs ; sur l'hôte, les fichiers de `/work`
  appartiennent alors à des UID décalés.
