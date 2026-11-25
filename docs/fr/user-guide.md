# Elpis — Guide utilisateur

# Pour bien démarrer

## Bienvenue
<!-- aide: bienvenue -->

Elpis est un assistant qui ne se contente pas de répondre : il agit, dans un espace de travail qui vous est propre. Cette aide explique chaque fonctionnalité, avec une courte démonstration animée quand un geste se montre mieux qu'il ne se décrit.

### L'essentiel

1. Connectez-vous avec l'identifiant et le mot de passe remis par votre administrateur.
2. Écrivez votre demande dans la barre de saisie, puis appuyez sur `Entrée`.
3. Lisez la réponse, puis poursuivez la conversation ou cliquez sur **Nouveau chat** pour changer de sujet.

L'application s'utilise dans un navigateur. Il n'y a rien à installer sur votre poste.

### Ce que l'application sait faire

- **Converser avec un modèle de langage**, servi par votre organisation ou, si l'administrateur l'autorise, par un fournisseur externe. Voir [Le chat](#le-chat) et [Modèles et fournisseurs](#modèles-et-fournisseurs).
- **Agir avec des outils** : lire et écrire des fichiers, lancer des commandes, piloter un navigateur, tracer des graphiques, tenir une mémoire. Voir [Quand l'assistant agit](#quand-lassistant-agit) et [Les outils et le panneau MCP](#les-outils-et-le-panneau-mcp).
- **Travailler dans votre sandbox** : un espace isolé, à vous, avec vos fichiers, un éditeur de code et un terminal. Voir [La sandbox et l'éditeur de code](#la-sandbox-et-léditeur-de-code).
- **Déléguer** une partie du travail à des sous-agents. Voir [Les sous-agents](#les-sous-agents).
- **Planifier** des tâches qui s'exécutent sans vous. Voir [Les routines](#les-routines).
- **Répondre à partir de vos documents**, en citant ses sources. Voir [Vos documents (RAG)](#vos-documents-rag).

Certaines de ces fonctionnalités peuvent être absentes de votre installation : c'est l'administrateur qui les ouvre.

> **Local par défaut.** Le modèle, vos fichiers et vos conversations restent sur le serveur de votre organisation. Rien n'en sort, sauf par ce qui a été ouvert explicitement : un fournisseur de modèles externe, un outil de navigation sur le web, ou un accès réseau accordé à votre sandbox par l'administrateur.

### Se servir de cette aide

Pour ouvrir l'aide, cliquez sur votre nom en bas de la barre latérale, puis sur **Aide**. Vous pouvez aussi taper `/help` dans la barre de saisie.

- **Les sections sont à gauche.** Une seule section s'affiche à la fois. En bas de chaque section, deux liens mènent à la précédente et à la suivante.
- **L'aide s'ouvre sur l'écran où vous êtes.** Depuis une conversation, elle montre [Le chat](#le-chat) ; depuis les routines, [Les routines](#les-routines) ; avec l'éditeur ouvert, [La sandbox et l'éditeur de code](#la-sandbox-et-léditeur-de-code).
- **Le champ de recherche**, **Rechercher dans l'aide**, ne garde que les sections qui contiennent votre mot. `Entrée` ouvre la première.
- **Les démonstrations** tournent en boucle, sans son. Un clic sur une démonstration la met en pause ; un autre clic la relance. Si les animations sont réduites (ligne **Animations** de Paramètres › **Apparence** › **Thème**, ou votre poste quand elle est sur **Système**), elles attendent votre clic pour démarrer.
- Chaque section a une partie **Pour en tirer le maximum** : les raccourcis et les options que l'on découvre rarement seul.
- `Échap` ferme l'aide. Vous retrouvez l'écran tel que vous l'aviez laissé.

### Se connecter

[Saisir son identifiant et son mot de passe, puis arriver sur l'accueil](../media/aide/connexion.webm)

1. Saisissez votre **Identifiant** et votre **Mot de passe**.
2. Cliquez sur **Se connecter**, ou appuyez sur `Entrée`.
3. L'accueil s'affiche : « Bonjour », suivi de votre nom, au-dessus de la barre de saisie.

Ce qu'il faut savoir :

- **Les comptes sont créés par un administrateur**, ou à votre première connexion si votre organisation a branché ses propres comptes (voir plus bas). Il n'y a pas d'inscription libre.
- L'icône en forme d'œil, dans le champ du mot de passe, affiche ce que vous tapez.
- **Identifiant ou mot de passe incorrect** : vérifiez la saisie, les majuscules en particulier. Après plusieurs échecs, l'application demande de patienter quelques minutes.
- **Nouveau mot de passe** : si l'administrateur vous a attribué un mot de passe, l'application vous demande d'en choisir un autre à la première connexion. Saisissez-le deux fois, puis cliquez sur **Appliquer et continuer**. Les règles (longueur, majuscules, chiffres, caractères spéciaux) sont fixées par l'administrateur.
- **Personne ne peut lire votre mot de passe**, pas même un administrateur. Il peut seulement vous en attribuer un nouveau.
- **Durée de la session.** Par défaut, une session dure 24 heures : passé ce délai, l'application redemande votre identifiant et votre mot de passe. L'administrateur peut régler cette durée, et fermer vos sessions à distance.

### Se connecter avec le compte de votre organisation

Si votre administrateur a branché les comptes de votre organisation, vous vous connectez avec eux, et non avec un mot de passe créé dans Elpis.

- **Authentification unique (SSO)** : la page de connexion propose un bouton **Se connecter avec** suivi du nom du service de votre organisation. Cliquez dessus, connectez-vous là-bas comme d'habitude, et vous revenez dans Elpis connecté.
- **Compte local** : quand la page montre les boutons d'authentification unique, **Compte local** ouvre le formulaire d'un compte créé dans Elpis.
- **Votre mot de passe est géré par votre organisation.** Dans Paramètres › **Profil**, le message **Votre mot de passe est géré par votre organisation** remplace le changement de mot de passe. Changez-le ou réinitialisez-le là où votre organisation le fait.
- **Première connexion.** Si vous appartenez au groupe autorisé, votre compte est créé automatiquement ; son nom est dérivé de votre identifiant.
- **Vous aviez déjà un compte Elpis.** À votre première connexion avec le compte de votre organisation, la page de connexion vous demande **une dernière fois** votre mot de passe Elpis. Saisissez-le et cliquez sur **Relier mon compte**. Après cinq mots de passe faux, la demande est annulée : demandez à votre administrateur de la préparer de nouveau. Ensuite, vous vous connectez avec le seul compte de votre organisation, et les jetons d'API personnels et les accès d'applications que vous aviez créés sont supprimés : recréez-les si vous en avez besoin. Si votre administrateur a vérifié lui-même votre identité, la question n'est pas posée.
- **Si vous êtes refusé.** Le message **Votre compte n'est pas autorisé à utiliser Elpis** s'affiche quand vous n'appartenez pas au groupe autorisé, quand votre compte est désactivé ou quand son nom est déjà pris ; **Une vérification en deux étapes est exigée** quand votre organisation en demande une ; **Le service de connexion de votre organisation ne répond pas** quand ce service est en panne : réessayez plus tard. Une courte **Référence** peut apparaître sous le message : transmettez-la à votre administrateur.
- **Votre rôle et vos groupes** peuvent être fixés par votre organisation d'après vos groupes chez elle : ils les suivent alors à chaque connexion.
- **Si vous quittez le groupe ou votre organisation**, votre compte est désactivé à la vérification suivante : vos sessions se terminent et vos outils cessent de fonctionner. Vos conversations et vos fichiers sont conservés.

### Le menu du compte

[Le menu du compte s'ouvre d'un clic sur votre nom, en bas de la barre latérale](../media/aide/compte-menu.webm)

Cliquez sur votre nom, en bas de la barre latérale. Le menu rappelle votre nom et votre rôle, puis propose :

- **Aide** : cette aide.
- **Informations** : le nom et la version de l'application, et le moteur qui sert le modèle. Utile quand vous signalez un problème.
- **Se déconnecter** : ferme votre session sur ce navigateur.

Pour changer de photo ou de mot de passe, ouvrez Paramètres (la roue dentée, à droite de votre nom) › **Profil**. Voir [Paramètres](#paramètres).

### Pour en tirer le maximum

- `/help` ouvre l'aide sans quitter le clavier. `/settings` ouvre les paramètres, `/usage` votre consommation.
- Commencez par [Tour de l'interface](#tour-de-linterface) si vous découvrez l'application, puis par [Le chat](#le-chat).
- Une question précise ? Tapez un mot dans **Rechercher dans l'aide** plutôt que de parcourir les sections.
- Si quelque chose ne se passe pas comme prévu, voyez [En cas de problème](#en-cas-de-problème) et [Questions fréquentes](#questions-fréquentes).

## Tour de l'interface
<!-- aide: interface -->

L'application tient dans un seul écran : une barre latérale à gauche pour naviguer, la conversation au centre, la barre de saisie en bas. Les autres vues s'ouvrent à côté ou à la place de la conversation, et `Échap` vous ramène d'un cran en arrière.

[Ouvrir une conversation, un panneau, le menu Plus, réduire la barre latérale, puis revenir à un nouveau chat](../media/aide/tour-interface.webm)

### L'essentiel

1. À gauche, cliquez sur **Nouveau chat** pour partir d'une page blanche, ou sur une conversation de la liste pour la rouvrir.
2. Au centre, lisez la conversation. Son titre est en haut à gauche.
3. En bas, écrivez dans la barre de saisie et appuyez sur `Entrée`.
4. Pour ouvrir un outil de travail (**MCP**, **Sandbox**, **Routines**, **Plus**), cliquez sur son nom dans la barre latérale.

Sur un nouveau chat, la barre de saisie est au milieu de la page, sous « Bonjour » et votre nom. Elle descend en bas de l'écran dès votre premier message.

### La barre latérale

De haut en bas :

- **Le nom de l'application** et, à sa droite, le bouton **Réduire le panneau** (double chevron).
- **Nouveau chat** : ouvre une conversation vide.
- **MCP** : ouvre à droite le panneau des outils que l'assistant peut utiliser. Voir [Les outils et le panneau MCP](#les-outils-et-le-panneau-mcp).
- **Sandbox** : ouvre à droite votre espace de fichiers, avec l'éditeur de code et le terminal. Voir [La sandbox et l'éditeur de code](#la-sandbox-et-léditeur-de-code).
- **Routines** : vos tâches planifiées. Voir [Les routines](#les-routines).
- **Plus** : un sous-menu vers **RAG**, **Bibliothèque** (vos images générées), **Studio** et **Agents**.
- **Conversations** : vos conversations, de la plus récente à la plus ancienne. La loupe cherche une conversation ; l'icône voisine permet d'en cocher plusieurs. Voir [Les conversations](#les-conversations).
- **En bas** : votre nom (le menu du compte), la cloche des [Notifications](#notifications), la roue dentée des [Paramètres](#paramètres). Un bouclier s'ajoute si vous êtes administrateur ou modérateur.

Un point de couleur à droite de **MCP** ou de **Sandbox** signale que le panneau est ouvert. Un point à droite d'une conversation signale qu'une réponse y est en cours.

Les entrées **MCP** et **Sandbox** se coupent dans Paramètres › **Fonctionnalités** › **Modules**. Une entrée absente du menu **Plus** n'a pas été ouverte pour votre compte : demandez à votre administrateur.

### La conversation

- **Le titre**, en haut à gauche, est proposé par l'assistant après votre premier message. Double-cliquez dessus pour le modifier.
- **Le bouton à trois points**, en haut à droite, ouvre le menu **Conversation** : **Renommer…**, **Rechercher**, **Exporter**, **Archiver**, **Supprimer**.
- **Vos messages** sont dans un cadre ; les réponses de l'assistant suivent, sans cadre.
- **Sous chaque réponse**, une ligne discrète donne le modèle, la durée et la vitesse. Les actions (copier, régénérer) apparaissent au survol. Voir [Le chat](#le-chat).

### La barre de saisie

De gauche à droite, sous la zone de texte :

- **+** (**Plus d'actions**) : joindre un fichier, voir les partages reçus, insérer un skill, un prompt ou un gabarit, activer le mode plan, compacter la conversation.
- **Le micro**, si la dictée est disponible et activée.
- **Des puces d'état**, quand elles ont quelque chose à dire : **Mode plan**, **Tâches** avec leur avancement, la place occupée par la conversation dans la mémoire de travail du modèle.
- **Le nom du modèle** : un clic ouvre la liste des modèles et les réglages. Voir [Modèles et fournisseurs](#modèles-et-fournisseurs).
- **Le bouton d'envoi.** Pendant une réponse, il devient un bouton rouge qui l'arrête.

### Les panneaux et les pages

- **À droite de la conversation** : **MCP** et **Sandbox** ouvrent un panneau. La conversation reste visible et se resserre. Un second clic sur l'entrée de la barre latérale, ou la croix du panneau, le referme.
- **À la place de la conversation** : **Routines** et les pages du menu **Plus** occupent le centre de l'écran. `Échap` vous ramène au chat ; la page **Routines** a aussi une flèche de retour, en haut à gauche.
- **Par-dessus tout** : **Paramètres** et l'aide s'ouvrent dans une fenêtre. `Échap` ou la croix la ferme.

Ouvrir une page ne ferme pas votre conversation : vous la retrouvez telle quelle en revenant.

### Pour en tirer le maximum

- **Gagnez de la place.** **Réduire le panneau** replie la barre latérale en une colonne d'icônes : nouveau chat, recherche, MCP, Sandbox, Routines, Plus, compte, notifications, paramètres. **Ouvrir le panneau** le déplie.
- `Ctrl+Maj+O` ouvre un nouveau chat depuis n'importe quelle page, tant qu'aucune fenêtre n'est ouverte.
- `Échap` ferme d'abord ce qui est au-dessus : un menu, puis une fenêtre, puis un panneau, puis la page ouverte.
- **Survolez les icônes** : chacune affiche son nom, et son raccourci quand elle en a un.
- **Tout se fait aussi au clavier.** `Tab` passe d'un élément au suivant ; dans un menu, `↑` et `↓` choisissent, `Entrée` valide.
- **Sur un écran étroit**, la barre latérale se cache d'elle-même. Le bouton en haut à gauche de la conversation le fait revenir par-dessus.
- **Changez l'allure de l'écran** dans Paramètres › **Apparence** : thème clair ou sombre, habillage. La densité du fil et ce qui s'affiche sous les réponses se règlent dans Paramètres › **Chat** › **Affichage**. Voir [Apparence](#apparence).
- La liste complète des touches est dans [Raccourcis clavier](#raccourcis-clavier).

# Au quotidien

## Le chat
<!-- aide: chat -->

Le chat est l'écran principal : vous écrivez une demande, l'assistant répond, et la conversation garde le fil. Cette section couvre la barre de saisie et tout ce que vous pouvez faire d'un message ou d'une réponse.

[Écrire un message, l'envoyer, et voir la réponse s'écrire](../media/aide/chat-envoyer.webm)

### L'essentiel

1. Cliquez dans la barre de saisie et écrivez votre demande.
2. Appuyez sur `Entrée`, ou cliquez sur le bouton d'envoi à droite de la barre.
3. La réponse s'écrit au fur et à mesure. La conversation reçoit un titre, en haut à gauche.
4. Écrivez la suite : l'assistant tient compte de tout ce qui précède dans la conversation.

`Maj+Entrée` passe à la ligne sans envoyer. Pour changer de sujet, cliquez sur **Nouveau chat** : une conversation par sujet donne de meilleures réponses.

### Pendant que l'assistant répond

- **Un indicateur** dit ce qui se passe sous le nom de l'assistant : **En attente…** quand d'autres demandes passent avant la vôtre, **Connexion aux outils…**, **Réflexion…**, ou le nom de l'outil en cours.
- **La barre de saisie** affiche le temps écoulé, la vitesse d'écriture et la place prise par la conversation.
- **Vous pouvez déjà écrire la suite.** La zone de texte reste active : `Entrée` y passe à la ligne ; envoyez une fois la réponse terminée.
- **Rien n'est perdu si vous rechargez la page** : la réponse continue de s'écrire sur le serveur et l'affichage la rattrape.
- **Si la connexion se coupe**, l'application réessaie seule, deux fois, et l'indique : `Reconnexion (1/2)...`.

### Arrêter une réponse, puis la continuer

[Arrêter la réponse en cours, puis la reprendre avec Continuer](../media/aide/chat-arreter.webm)

1. Pendant la réponse, le bouton d'envoi devient un bouton rouge. Cliquez dessus pour arrêter.
2. Le texte déjà écrit reste en place. Dessous, un encart indique **Réponse interrompue**.
3. Cliquez sur **Continuer** : l'assistant complète la même réponse, là où elle s'était arrêtée. Il ne recommence pas.

Ce qu'il faut savoir :

- Le même encart apparaît quand une réponse est coupée parce qu'elle était trop longue. Coupée pendant la réflexion, il indique **Réflexion interrompue** : **Continuer** fait alors conclure le modèle à partir du raisonnement déjà écrit.
- Après un arrêt de votre part pendant la réflexion, avant le premier mot de la réponse, il n'y a rien à continuer : **Continuer** n'est pas proposé. Utilisez **Régénérer la réponse**.
- Si une réponse échoue, une ligne **Interrompue** en donne la cause (connexion perdue, délai dépassé, moteur occupé…) et propose **Reprendre** ou **Réessayer**. **Copier le détail** copie le message technique, utile à votre administrateur.
- Quand la cause est **contexte saturé**, la conversation est devenue trop longue pour le modèle : le bouton proposé est **Nouveau chat**. Voir [Le contexte de la conversation](#le-contexte-de-la-conversation).

### Répondre maintenant

[Couper la réflexion avec Répondre maintenant pour obtenir la réponse tout de suite](../media/aide/chat-repondre-maintenant.webm)

Certains modèles réfléchissent avant de répondre. Si la réflexion dure trop pour une question simple :

1. Pendant que **Réflexion…** est affiché, cliquez sur **Répondre maintenant**, à droite.
2. L'assistant cesse de réfléchir et écrit sa réponse à partir de ce qu'il a déjà pensé.

Le bouton n'existe que pendant la réflexion. Il disparaît dès que la réponse commence.

### Voir la réflexion

[Déplier la réflexion de l'assistant, puis la replier](../media/aide/chat-reflexion.webm)

Quand le modèle a réfléchi, un bloc **Réflexion** précède la réponse, avec le temps passé.

1. Cliquez sur **Réflexion** pour lire le raisonnement.
2. Cliquez de nouveau pour le replier.

Vous pouvez aussi l'ouvrir pendant qu'il s'écrit ; il se replie quand la réponse est terminée. La réflexion n'est pas enregistrée avec la conversation : en la rouvrant plus tard, vous retrouvez les réponses, pas le raisonnement.

### Les actions sur une réponse

[Copier une réponse, puis la régénérer](../media/aide/chat-actions-message.webm)

Passez le pointeur sur une réponse : ses actions apparaissent en bas à droite.

- **Copier la réponse** : copie le texte. L'icône devient une coche pendant un instant.
- **Détails** : la chronologie de la réponse (outils appelés, modèle, durées). `Échap` la referme.
- **Régénérer la réponse** : efface la réponse et en demande une nouvelle à la même question.
- **Lire à voix haute** : présent si la lecture vocale est disponible.

### Corriger un message et le renvoyer

[Modifier son dernier message et le renvoyer pour obtenir une nouvelle réponse](../media/aide/chat-editer.webm)

1. Passez le pointeur sur l'un de vos messages, puis cliquez sur le crayon (**Éditer et renvoyer**).
2. Corrigez le texte.
3. Cliquez sur **Envoyer**, ou appuyez sur `Ctrl+Entrée`. `Échap` annule.

La conversation repart de ce message : tout ce qui le suivait est remplacé par la nouvelle réponse. Si vous modifiez le tout premier message, l'application demande confirmation (**Modifier et régénérer**). Les fichiers joints au message d'origine restent joints.

À côté du crayon, le signet (**Sauvegarder**) enregistre votre message comme prompt réutilisable. Voir [Les prompts](#les-prompts).

### Joindre un fichier

[Joindre un fichier de son poste avec le bouton +](../media/aide/chat-fichiers.webm)

1. Cliquez sur **+**, à gauche sous la zone de texte, puis sur **Joindre un fichier**.
2. Choisissez un ou plusieurs fichiers. Chacun apparaît en vignette au-dessus de votre texte.
3. Écrivez votre demande et envoyez. Pour retirer un fichier, survolez sa vignette et cliquez sur la croix.

Vous pouvez aussi **glisser des fichiers** depuis votre poste et les déposer sur la conversation.

| Type | Limite | Ce que l'assistant reçoit |
|---|---|---|
| Texte, code | 5 Mo | Le contenu, inséré dans le message |
| Image | 15 Mo | L'image, si le modèle sait lire les images |
| Capture réseau (`.pcap`, `.pcapng`, `.cap`) | — | Refusée |

Dix fichiers au plus par message. Un fichier trop volumineux est refusé avec un message, sans bloquer les autres. Les fichiers sont lus comme du texte : pour un PDF ou un document bureautique, passez plutôt par [La sandbox et l'éditeur de code](#la-sandbox-et-léditeur-de-code) ou par [Vos documents (RAG)](#vos-documents-rag).

### Mentionner un fichier de la sandbox avec @

[Taper @ pour choisir un fichier de la sandbox et le joindre au message](../media/aide/chat-mention.webm)

1. Tapez `@` dans la barre de saisie : la liste **Insérer un fichier** montre les fichiers de votre sandbox.
2. Continuez à taper pour filtrer : `@plan`, `@src/`. La recherche porte sur le chemin entier, sans tenir compte des majuscules.
3. Choisissez avec `↑` et `↓`, validez avec `Entrée`, ou cliquez sur le fichier. `Échap` ferme la liste.
4. Le fichier apparaît en vignette, comme une pièce jointe. Son contenu part avec le message.

Les fichiers que vous avez mentionnés récemment sont en tête, sous **Récents**. Vous pouvez mentionner plusieurs fichiers dans le même message ; ils comptent dans la limite de dix.

### Les commandes /

[Taper / pour ouvrir les commandes, filtrer, puis en choisir une](../media/aide/chat-commandes.webm)

1. Tapez `/` au tout début de la barre de saisie : le menu **Commandes** s'ouvre. En cours de phrase, après une espace, `/` ouvre aussi le menu : un skill choisi s'épingle et votre texte reste en place.
2. Tapez les premières lettres pour filtrer.
3. Choisissez avec `↑` et `↓`, validez avec `Tab` ou `Entrée`, ou cliquez. `Échap` ferme le menu sans effacer votre saisie.

| Commande | Effet |
|---|---|
| `/agents` | Active ou coupe les sous-agents (`on`, `off`), ou ouvre leur page (`open`) |
| `/compact` | Résume le début de la conversation pour libérer de la place |
| `/help` | Ouvre cette aide |
| `/image` | Génère une image : `/image 16:9 x2 description` |
| `/jobs` | Liste les tâches de fond (`/jobs all` pour toutes les conversations, `/jobs stop` pour en arrêter une) |
| `/memory` | Ouvre la mémoire à long terme |
| `/plan` | Active ou coupe le mode plan (`/plan on`, `/plan off`) |
| `/prompt` | Insère un prompt sauvegardé ou reçu |
| `/rag` | Vos collections de documents : `use`, `off`, `search`, `add`, `new`, `status`, `open` |
| `/routine` | Crée une routine avec l'assistant : `/routine` suivi de votre objectif |
| `/secret` | Secrets de la conversation : `/secret`, `attach`, `detach` |
| `/settings` | Ouvre les paramètres, sur un onglet précis si vous le nommez |
| `/skills` | Parcourt vos skills et en épingle un au prochain message |
| `/template` | Insère un gabarit de prompt, après avoir rempli ses variables |
| `/usage` | Ouvre le suivi de votre consommation |

Le menu ne montre que les commandes disponibles chez vous : `/image`, `/rag`, `/secret` et `/agents` dépendent de ce que l'administrateur a ouvert. Une commande grisée n'est pas utilisable à cet instant : `/compact` demande une conversation déjà commencée, et plusieurs commandes attendent la fin de la réponse en cours.

Pour le détail : [Les sous-agents](#les-sous-agents), [Le contexte de la conversation](#le-contexte-de-la-conversation), [Quand l'assistant agit](#quand-lassistant-agit), [La mémoire](#la-mémoire), [Les prompts](#les-prompts), [Vos documents (RAG)](#vos-documents-rag), [Les routines](#les-routines), [Secrets et comptes Git](#secrets-et-comptes-git), [Les skills](#les-skills).

### La ligne sous une réponse

Sous chaque réponse terminée, une ligne discrète résume ce qu'elle a coûté. Un jeton est un morceau de mot : c'est l'unité dans laquelle le modèle compte le texte.

- **Le modèle** qui a répondu.
- **La durée** de la réponse.
- **↓** la vitesse de lecture de la conversation par le modèle et **↑** la vitesse d'écriture, en jetons par seconde.
- **Le cerveau**, suivi d'un nombre et de `tk` : les jetons passés à réfléchir.
- **cache N %** : la part de la conversation que le modèle avait déjà en mémoire, donc relue sans effort.
- **Le dernier nombre** : la place occupée par la conversation, sur la place totale dont dispose le modèle.

Laissez le pointeur sur la ligne : une infobulle détaille l'entrée (déjà en mémoire, nouvelle) et la sortie (réflexion, réponse).

### Dicter et se faire lire les réponses

Si votre administrateur a installé le moteur vocal, Paramètres › **Chat** › **Voix** propose :

| Réglage | Effet |
|---|---|
| **Dictée** | Un bouton micro s'ajoute dans la barre de saisie |
| **Réponse vocale** | Les réponses sont lues à voix haute pendant qu'elles s'écrivent |
| **Lire entre les outils** | Lit aussi ce que l'assistant annonce avant chaque appel d'outil |

**Dicter.** Cliquez sur le micro et parlez normalement. Le texte s'écrit phrase après phrase, à chaque pause. Il reste modifiable, et rien n'est envoyé à votre place : vous relisez, puis vous envoyez. `Échap` ou un nouveau clic sur le micro arrête la dictée, sans toucher à ce qui est déjà écrit.

**Écouter.** **Lire à voix haute**, sous chaque réponse terminée, lit cette réponse même si **Réponse vocale** est décochée. Un second clic, ou `Échap`, arrête la lecture. Commencer à dicter coupe aussi la voix.

Sur une tâche longue, l'assistant annonce ses étapes entre deux outils (« Je lance les tests… »). **Lire entre les outils** les lit : utile quand vous regardez ailleurs, pesant quand vous attendez la réponse.

> Le micro n'est autorisé par les navigateurs que sur une connexion sécurisée (HTTPS). Si la **Dictée** est grisée, demandez à votre administrateur.

### Pour en tirer le maximum

- **Préparez la suite pendant la réponse.** Écrivez votre prochain message sans attendre, puis envoyez-le d'un `Entrée` quand la réponse est finie.
- **Corrigez plutôt que de répéter.** Une question mal posée se rattrape mieux avec **Éditer et renvoyer** qu'avec un second message : la conversation reste courte et l'assistant n'est pas influencé par sa première réponse.
- **Régénérez pour comparer.** **Régénérer la réponse** donne une autre formulation. Changez d'abord de modèle si vous voulez un second avis. Voir [Modèles et fournisseurs](#modèles-et-fournisseurs).
- **Coupez court à une réflexion inutile** avec **Répondre maintenant**, plutôt que d'arrêter puis de relancer.
- **Le menu + mène aux mêmes fonctions que les commandes**, avec leur nom à côté : **Skills** (`/skills`), **Prompts** (`/prompt`), **Gabarits** (`/template`), **Mode plan** (`/plan`), **Compacter** (`/compact`).
- **Une commande accepte des précisions.** `/settings chat` ouvre directement l'onglet **Chat** des paramètres ; tapez une espace après la commande pour voir les valeurs possibles.
- **Pas de commande à ce nom ?** Le menu bascule sur vos skills : tapez `/` suivi du début du nom d'un skill pour l'épingler. Et un message qui commence par `/` sans correspondre à rien est simplement envoyé à l'assistant.
- **`@` suivi d'un bout de chemin** va plus vite que de chercher dans la liste : `@docs/` ne garde que ce dossier.
- **Gardez vos bonnes questions.** Le signet d'un message l'enregistre ; `/prompt` le ressort dans n'importe quelle conversation.
- **Réglez ce qui s'affiche** (réflexions, mesures sous les réponses, densité du fil) dans Paramètres › **Chat** › **Affichage** : voir [Apparence](#apparence).
- **Donnez vos consignes une fois pour toutes** dans Paramètres › **Chat** › **Conversation**, champ **Prompt système** : l'assistant les suit dans toutes vos conversations.
- **Revenez en bas d'un clic.** Si vous avez remonté le fil, le bouton **Aller en bas** vous ramène au dernier message.

### Comment ça marche

À chaque message, l'assistant relit toute la conversation : c'est ce qui lui permet de suivre le fil, et c'est pourquoi une conversation très longue finit par ralentir, puis par saturer. Voir [Le contexte de la conversation](#le-contexte-de-la-conversation) ; pour ce que montre le fil quand il utilise des outils, [Quand l'assistant agit](#quand-lassistant-agit).

## Quand l'assistant agit
<!-- aide: outils -->

Un outil est une action que l'assistant peut demander à l'application : lire un fichier, lancer une commande, chercher dans une documentation. Avec des outils, il ne se contente plus de répondre : il agit, puis vous rend compte. Le fil montre ce qu'il fait pendant qu'il le fait, et en garde la trace.

[L'assistant enchaîne deux outils, puis répond](../media/aide/chat-outils.webm)

### L'essentiel

1. Activez les outils utiles à la conversation : voir [Les outils et le panneau MCP](#les-outils-et-le-panneau-mcp).
2. Envoyez votre demande, comme d'habitude.
3. Suivez la ligne de travail, sous le nom de l'assistant. Elle nomme l'outil en cours et l'étape, par exemple « lire_page · étape 2/200 ».
4. Lisez la réponse. Le travail reste replié sur une ligne au-dessus d'elle, par exemple « La page existe, je la lis. · 2 outils ».

### Voir ce que l'assistant a fait

[Déplier le travail et ouvrir le détail d'un outil](../media/aide/chat-outils-detail.webm)

1. Cliquez sur la ligne de travail. Elle se déplie : vous lisez les phrases que l'assistant a écrites entre deux actions, et un groupe par série d'appels (« 1 outil », « 2 outils »).
2. Cliquez sur un groupe, puis sur le nom de l'outil.
3. Une carte s'ouvre. **Paramètres** montre ce que l'assistant a demandé, **Résultat** ce que l'outil a répondu. La croix la referme.

À savoir :

- Un appel en échec porte un signe rouge. Sa carte donne l'erreur à la place du résultat.
- Quand l'assistant n'a rien écrit entre ses actions, la ligne s'intitule « Travail de l'assistant ».
- Au survol d'une réponse, le bouton **Détails** ouvre la chronologie du tour : outils, modèle, durées.
- Selon les outils utilisés, la réponse porte aussi la sortie des commandes en direct (réglage **Terminal en direct**, dans Paramètres › **Chat** › **Conversation** ; éteint, la sortie reste lisible dans le détail de l'outil), la liste **Fichiers modifiés** (lignes ajoutées et retirées, diff au clic, **Télécharger**) ou les captures du navigateur. Voir [La sandbox et l'éditeur de code](#la-sandbox-et-léditeur-de-code).
- La ligne de mesures sous la réponse (modèle, durée, débit, contexte) est décrite dans [Le chat](#le-chat).

### Choisir la présentation du travail

Le réglage **Déroulé**, dans Paramètres › **Chat** › **Affichage**, change la façon dont un tour à outils s'affiche : **Classique** (par défaut), **En bloc**, **Chronologie** ou **Journal**. Voir [Apparence](#apparence).

### La liste de tâches de l'assistant

[La puce Tâches ouvre la liste tenue par l'assistant](../media/aide/chat-liste-de-taches.webm)

Pour un travail en plusieurs étapes, l'assistant tient sa propre liste de tâches. Une puce **Tâches 1/4** apparaît alors dans la barre de saisie : une tâche faite sur quatre.

1. Cliquez sur la puce. La liste **Tâches de la session** s'ouvre ; les tâches faites sont barrées.
2. Cliquez ailleurs, ou sur la croix, pour la refermer.

Au survol, la puce indique la tâche en cours. Elle appartient à la conversation, revient après un rechargement de la page, et disparaît quand tout est fait.

### Répondre à un questionnaire

[Répondre aux deux questions de l'assistant et envoyer](../media/aide/chat-questionnaire.webm)

Quand il lui manque des précisions, l'assistant peut poser plusieurs questions d'un coup. Le questionnaire s'ouvre dans la barre de saisie, à la fin de sa réponse.

1. Lisez la question (« Question 1 sur 2 ») et cliquez sur une option. Avec la mention « Plusieurs choix possibles. », vous pouvez en cocher plusieurs.
2. Pour préciser, ou pour une réponse qui n'est pas proposée, écrivez dans le champ **Autre réponse, ou une précision…**. Votre texte s'ajoute aux options cochées.
3. Cliquez sur **Suivant**. **Retour** revient à la question précédente.
4. À la dernière question, cliquez sur **Envoyer les réponses**. Elles partent en un seul message et l'assistant poursuit.

À savoir :

- Au clavier : les chiffres `1` à `9` cochent l'option du même numéro tant que le champ est vide, `Entrée` valide, `Échap` ferme.
- **Répondre librement** ferme le questionnaire sans perdre vos réponses. Une puce, par exemple **Reprendre le questionnaire · 1 sur 2**, le rouvre.
- Répondre à une seule question suffit pour envoyer.
- Le questionnaire reste disponible en mode plan. Il n'existe ni dans une routine ni pour un sous-agent.

### Demander un plan avant d'agir

[Activer le mode plan et recevoir un plan](../media/aide/chat-mode-plan.webm)

Le mode plan fait préparer un travail sans rien toucher. L'assistant peut lire et chercher, mais ses outils d'écriture sont retirés jusqu'à sa réponse.

1. Cliquez sur **+** dans la barre de saisie, puis sur **Mode plan**. Ou tapez `/plan`.
2. La puce **Mode plan** apparaît dans la barre de saisie.
3. Envoyez votre demande. L'assistant rend un plan : ce qu'il a trouvé, ce qu'il changerait, dans quel ordre, et ce qui peut mal tourner.
4. Le mode se coupe seul. Le message « Plan rendu — mode plan terminé, outils rétablis. » le confirme : votre message suivant s'exécute avec tous les outils.

À savoir :

- Pour y renoncer, cliquez sur la croix de la puce ou tapez `/plan off`. `/plan on` l'active sans risque de l'inverser.
- Le mode ne se change pas pendant qu'une réponse s'écrit.
- Sur un chat vierge, il est d'abord armé : « Mode plan armé — la conversation démarrera sans outils d'écriture. »
- En mode plan, l'assistant ne délègue pas à un sous-agent et ne crée ni image, ni routine, ni agent.

### Les tâches de fond

[Ouvrir les tâches de fond et arrêter celle qui tourne](../media/aide/chat-taches-de-fond.webm)

Une commande longue (une suite de tests, un serveur de développement) peut tourner en tâche de fond dans votre sandbox, votre espace de travail isolé. L'assistant la lance, vous rend la main, et reprend quand elle se termine.

1. Repérez la puce **1 ici** dans la barre de saisie : une tâche tourne pour cette conversation. Cliquez dessus, ou tapez `/jobs`.
2. Le volet **Tâches de fond** liste chaque tâche : son nom, son état (« en cours », « arrêté »), sa durée, et ce qui réveillera l'assistant (« fin du programme », « texte « … » », « port 8000 »).
3. **Journal** ouvre le journal de la tâche dans l'éditeur. **Arrêter** la stoppe. **Tout arrêter** stoppe toutes celles de la liste.

À savoir :

- Tant qu'il attend une tâche, l'assistant termine sa réponse par « En attente de « tests » · 0 min 02 s ». À la fin de la tâche, il reprend seul et continue la même réponse.
- Si la tâche échoue, un message « « tests » s'est arrêté : code 1 » propose **Aller au message**.
- Une tâche que vous arrêtez ne réveille pas l'assistant.
- **Toutes les conversations** montre les tâches de tout votre compte, avec un lien vers leur conversation.
- **Ne pas me réveiller dans cette conversation** : l'assistant n'est plus relancé, le résultat est joint à votre prochain message. Le réglage général est dans Paramètres › **Chat** › **Conversation** : **Me réveiller quand une tâche de fond se termine**.
- Le compteur « 1 / 3 » rappelle le nombre de tâches permis par conversation. L'administrateur fixe cette limite.
- Supprimer une conversation arrête ses tâches de fond ; la confirmation vous le rappelle.

### Générer une image

[Ouvrir le mode Images, décrire l'image et la générer](../media/aide/chat-images.webm)

La génération d'images n'apparaît que si l'administrateur a relié un moteur d'images et que votre compte y a droit.

1. Dans la barre de saisie, tapez `/image` puis `Entrée`, ou appuyez sur `Alt+I`. La barre passe en mode **Images**.
2. Réglez au besoin le format (**Carré**, **16:9**…), la taille et le nombre d'images.
3. Décrivez l'image, puis cliquez sur **Générer**.
4. Une case tient la place de l'image (« Génération · 12 s »), puis l'image arrive dans le fil.

Dans la barre du mode Images, **Portrait / paysage** retourne le format, **Enrichir** fait réécrire votre description par le modèle du chat avant l'envoi, et **Options avancées** donne, selon le moteur, **Dimensions libres**, **Graine**, **Étapes** et **À éviter**. La croix de la puce **Images**, ou `Échap` sur un champ vide, quitte le mode.

**Bibliothèque**, dans la même barre ou par **Plus** › **Bibliothèque**, réunit vos images : **Toutes** ou **Cette conversation** ; au survol, **Télécharger** ou **Supprimer**.

À savoir :

- Pendant le calcul, la case affiche « En file · 2e » ou « Génération · 12 s / ≈30 s » (≈ : durée estimée). Son bouton carré arrête la demande.
- Sous l'image : le modèle, le format, la taille, la durée, et la graine quand le moteur la donne. **Copier** copie la description. **Variantes** relance la même demande sans effacer les images. **Régénérer les images** les remplace.
- Au survol d'une image : **Modifier**, **Télécharger**, **Supprimer**. Un clic ouvre la visionneuse ; `←` et `→` passent d'une image à l'autre.
- **Modifier** prend l'image comme référence de la prochaine demande. Vous pouvez aussi joindre une image.
- Une suppression s'annule pendant 5 secondes.
- L'assistant peut créer lui-même une image pendant une réponse si **Par le modèle** est activé dans Paramètres › **Fonctionnalités** › **Images**. Vos préférences de format, de taille et de nombre s'y règlent aussi.
- Seules vos images les plus récentes sont gardées ; l'administrateur en fixe le nombre. Une image retirée affiche « Expirée ».

### Les graphiques

[Un graphique dans la réponse, passé de barres en courbe](../media/aide/chat-graphique.webm)

Avec la catégorie **Graphiques** activée pour la conversation, l'assistant trace un graphique à partir des chiffres que vous lui donnez, ou qu'il a trouvés. Le graphique s'affiche dans la réponse.

1. Demandez un graphique en donnant les valeurs, par exemple « Trace les ventes : juillet 120, août 98, septembre 143 ».
2. Sur un graphique en barres, changez sa forme avec **Barres**, **Courbe** ou **Aire**.
3. **Tableau** affiche les données, **PNG** télécharge l'image, **Agrandir** l'ouvre en grand (`Échap` pour revenir).

L'assistant choisit parmi une trentaine de types : barres, courbes, secteurs, entonnoir, diagramme de Gantt, indicateurs, tableaux.

### Pour en tirer le maximum

- Sur un travail délicat, demandez d'abord un plan avec `/plan`, relisez-le, puis répondez « vas-y » : ce message s'exécute avec tous les outils.
- `/image 16:9 x2 un phare au soleil couchant` génère directement deux images, sans ouvrir le mode Images. Le format s'écrit aussi `carré`, `portrait` ou `paysage`.
- `/jobs all` liste les tâches de fond de tout le compte. `/jobs stop all` arrête celles de la conversation, `/jobs stop` suivi d'un identifiant en arrête une.
- Pour voir chaque étape sans rien déplier, passez le **Déroulé** sur **Chronologie** ou **Journal**.
- Quand une réponse a été longue à venir, **Détails** montre où le temps est passé.
- Si un long travail s'arrête sur « Budget de tours atteint », cliquez sur **Reprendre** dans le bandeau ; pour la suite, augmentez **Tours d'outils** (menu du modèle › **Paramètres de génération…**). Le même bouton suit les autres arrêts, comme « Budget de temps atteint ».
- Un travail qui demande beaucoup de lecture se confie à un sous-agent : votre conversation ne reçoit que son rapport. Voir [Les sous-agents](#les-sous-agents).

### Comment ça marche

Un tour, c'est tout ce que fait l'assistant entre votre message et sa réponse finale :

1. L'application envoie au modèle votre message et la liste des outils actifs.
2. Le modèle demande un outil. L'application l'exécute, dans votre sandbox pour les fichiers et les commandes, et lui renvoie le résultat.
3. Le modèle recommence tant qu'il lui manque quelque chose, puis rédige sa réponse.

Chaque aller-retour est une étape. C'est ce qui permet « lis ce fichier, modifie-le, lance les tests, corrige les erreurs » en une seule demande. Le compteur « étape 2/200 » donne l'étape en cours et la limite du tour, 200 par défaut.

Quelques outils ne se cochent pas : la liste de tâches accompagne tout outil actif, le questionnaire est proposé sans rien activer, et la délégation s'ajoute quand les sous-agents sont activés.

## Le contexte de la conversation
<!-- aide: contexte -->

À chaque message, l'assistant relit toute la conversation. Il ne peut en lire qu'une quantité limitée : sa fenêtre de contexte. Une jauge vous dit où vous en êtes, et la compaction libère de la place quand la fenêtre se remplit.

[La jauge est rouge : Compacter résume l'historique ancien](../media/aide/chat-contexte.webm)

### L'essentiel

1. Regardez la jauge dans la barre de saisie, à côté du bouton **+**. « 29,8 k/32,8 k » se lit : 29 800 jetons utilisés sur une fenêtre de 32 800. Un jeton est un morceau de mot, l'unité dans laquelle le modèle compte le texte.
2. Quand elle passe au rouge, le bandeau **Contexte presque plein** apparaît au-dessus de la barre de saisie.
3. Cliquez sur **Compacter**. Le fil affiche « Compaction en cours… » et une barre de progression.
4. À la fin, la ligne « Conversation compressée » le confirme. Continuez à écrire normalement.

### Lire la jauge

- Elle apparaît après la première réponse de la conversation, et revient quand vous rouvrez celle-ci.
- Sa couleur suit le remplissage : verte, puis la couleur d'accent à partir de 65 %, ambre à partir de 75 %, rouge à partir de 90 % (forme **Jetons** ; les autres formes passent à l'ambre, avec un signe d'alerte, à 80 %).
- La même mesure figure sous chaque réponse : c'est le contexte au moment de cette réponse.
- Pendant qu'une réponse s'écrit, elle devient par exemple « 42 + 26 / 32,8 k » : ce qui a été envoyé, plus ce que l'assistant a déjà écrit, réflexion comprise.
- Au survol, elle donne les chiffres exacts et le pourcentage.
- Sa forme (jetons, bloc, pourcentage ou anneau) se choisit dans Paramètres › **Chat** › **Affichage**, réglage **Contexte** : voir [Apparence](#apparence).
- La réflexion de l'assistant compte aussi dans la fenêtre. Son affichage se règle dans [Apparence](#apparence), son niveau dans [Modèles et fournisseurs](#modèles-et-fournisseurs).

### Compacter la conversation

La compaction fait résumer les anciens échanges par le modèle. Le résumé prend leur place dans ce qui lui est envoyé ; les derniers échanges restent mot pour mot. Votre fil ne change pas : vous pouvez toujours tout relire.

Trois façons de la lancer :

- le bouton **Compacter** du bandeau **Contexte presque plein**, qui apparaît à 90 % ;
- la commande `/compact`, à tout moment ;
- le bouton **+** de la barre de saisie, puis **Compacter**.

Ce qui se passe ensuite :

- La ligne « Conversation compressée · ≈ 327 jetons » donne la taille de l'historique une fois résumé, et l'heure. **Voir le résumé** le déplie.
- Le bandeau s'efface. La jauge aussi, jusqu'à la prochaine réponse : l'ancienne mesure ne vaut plus.
- Un compteur au-dessus de la barre de saisie, par exemple « 1/12 », indique le nombre de compactions déjà faites et le maximum pour la conversation.

À savoir :

- La compaction demande une conversation déjà commencée, et aucune réponse en cours. Sinon **Compacter** est grisé.
- Sur une conversation de quelques échanges, elle ne s'applique pas : il n'y a rien à résumer.
- Le bandeau propose aussi **Nouveau chat**. Pour un nouveau sujet, repartir d'une conversation vide est souvent plus simple.

### Laisser l'application compacter seule

Par défaut, rien n'est compacté sans vous. Pour l'automatiser, ouvrez Paramètres › **Avancé** › **Compaction** (le groupe **Avancé** se déplie d'un clic) :

- **Compaction automatique** : l'assistant résume les anciens tours quand le seuil est atteint.
- **Seuil** : **Auto** (quand la fenêtre du modèle est pleine), **Pourcentage** (une part de la fenêtre, de 30 à 95 %) ou **Jetons** (un nombre de jetons de contexte).
- **Compactions max** : **Auto** (plafond fixé par l'administrateur), **Nombre** (par conversation) ou **Illimité**.

Une fois le plafond atteint, les tours les plus anciens sont retirés du contexte au lieu d'être résumés. La mention « Compression max atteinte » le signale au-dessus de la barre de saisie. La commande `/compact` reste disponible dans tous les cas.

### Pour en tirer le maximum

- Compactez avant de lancer un gros travail plutôt qu'au milieu : tapez `/compact` dès que la jauge passe à l'ambre.
- Après une compaction, ouvrez **Voir le résumé**. S'il manque un point important, redites-le dans votre message suivant.
- Changez de conversation quand vous changez de sujet : une fenêtre moins remplie laisse plus de place aux fichiers et aux résultats d'outils.
- Pour une recherche qui oblige à lire beaucoup, activez les sous-agents : la lecture remplit le contexte de l'agent, pas le vôtre. Voir [Les sous-agents](#les-sous-agents).
- Le menu du modèle, puis **Paramètres de génération…**, montre la taille de la fenêtre et la place gardée pour la réponse. **Régler** y mène au seuil de compaction.
- Les formes **Pourcentage** et **Anneau** de la jauge prennent moins de place dans la barre de saisie.

### Comment ça marche

À chaque tour, le modèle relit les consignes de l'assistant, votre mémoire et vos skills, la description des outils actifs, tout l'historique (résultats d'outils compris) et votre nouveau message. L'ensemble doit tenir dans la fenêtre de contexte, dont la taille dépend du modèle choisi. Quand elle se remplit, les anciens tours sont résumés (la compaction) ; en dernier recours, les messages les plus anciens sont retirés.

## Les conversations
<!-- aide: conversations -->

Chaque échange avec l'assistant est une conversation, gardée dans la barre latérale. Vous pouvez la retrouver, la renommer, l'archiver, l'exporter ou la supprimer.

### L'essentiel

1. Cliquez sur **Nouveau chat**, en haut de la barre latérale, ou appuyez sur `Ctrl+Maj+O`.
2. Envoyez votre premier message. La conversation est enregistrée et reçoit un titre, rédigé par le modèle.
3. Pour y revenir, cliquez sur son titre sous **Conversations**. Les conversations sont rangées par date : **Aujourd'hui**, **Hier**, **7 derniers jours**, **Plus ancien**.
4. Pour agir sur une conversation, faites un clic droit sur son titre, ou ouvrez le menu **Conversation** (les trois points en haut à droite du fil). Les deux proposent **Renommer…**, **Rechercher**, **Exporter**, **Archiver** et **Supprimer**.

Un point à droite d'un titre signale qu'une réponse est en cours dans cette conversation.

### Retrouver une conversation

[Chercher une conversation par son titre et l'ouvrir](../media/aide/conversations-rechercher.webm)

1. Cliquez sur la loupe **Rechercher un chat**, à droite de **Conversations**.
2. Tapez quelques lettres du titre. La liste **Résultats** se met à jour à chaque frappe.
3. Cliquez sur un résultat pour l'ouvrir. `Échap`, ou la croix du champ, ferme la recherche.

La recherche porte sur les titres. Pour retrouver un mot dans le texte, ouvrez la conversation et cherchez dedans.

### Chercher dans une conversation

[Chercher un mot dans la conversation ouverte](../media/aide/conversations-chercher-dans-le-fil.webm)

1. Ouvrez le menu **Conversation**, puis cliquez sur **Rechercher**.
2. Tapez le mot dans le champ **Rechercher dans la conversation...**. Il est surligné dans les messages qui le contiennent ; les autres messages s'estompent. Un compteur indique « 2 résultat(s) ».
3. `Entrée` va au résultat suivant, `Maj+Entrée` au précédent. `Échap` ferme la recherche.

Depuis le clic droit sur une autre conversation, **Rechercher** l'ouvre et affiche le champ. La recherche se ferme quand vous changez de conversation.

### Renommer

[Renommer la conversation d'un double-clic sur son titre](../media/aide/conversations-renommer.webm)

1. Double-cliquez sur le titre, en haut du fil.
2. Tapez le nouveau nom.
3. `Entrée` valide, `Échap` annule.

**Renommer…** dans le menu ouvre la fenêtre **Renommer la conversation** : tapez le nom, puis **Valider**. Dans la barre latérale, `F2` fait de même pour la conversation sélectionnée au clavier.

### Archiver

Archiver sort une conversation de la liste sans la supprimer.

1. Dans le menu de la conversation, cliquez sur **Archiver**. Elle quitte la liste aussitôt, sans confirmation.
2. Un message, par exemple « « Budget formation 2027 » archivée », propose **Annuler** pendant quelques secondes.

Les archives se retrouvent dans Paramètres › **Avancé** › **Archives**. **Restaurer** remet une conversation dans la liste, **Supprimer** l'efface définitivement. **Sélection** permet d'en cocher plusieurs, puis de les restaurer ou de les supprimer ensemble.

### Supprimer

[Supprimer une conversation par le clic droit](../media/aide/conversations-supprimer.webm)

1. Faites un clic droit sur la conversation, puis cliquez sur **Supprimer**.
2. Confirmez la question « Supprimer la conversation ? » par **Supprimer**.
3. Le message « Conversation supprimée » propose **Annuler** pendant 5 secondes. Passé ce délai, la suppression est définitive.

Si des tâches de fond tournent pour cette conversation, la confirmation vous prévient qu'elles seront arrêtées.

### Agir sur plusieurs conversations

[Cocher trois conversations et les archiver](../media/aide/conversations-selection.webm)

1. Cliquez sur **Sélectionner**, à côté de la loupe. Une case apparaît devant chaque titre.
2. Cochez les conversations. La barre latérale indique « 3 sélectionné(s) ».
3. En bas de la barre latérale, cliquez sur **Archiver (3)** ou sur **Supprimer**.

À savoir :

- L'archivage groupé s'annule depuis le message « 3 conversation(s) archivée(s) », avec **Annuler**.
- La suppression groupée demande une confirmation et ne s'annule pas : « Cette action est irréversible. »
- La croix **Terminer la sélection** quitte le mode sans rien faire.
- Pour tout effacer d'un coup : Paramètres › **Chat** › **Conversation**, **Effacer les conversations**, puis **Effacer**. Toutes les conversations actives sont supprimées ; les archives ne sont pas touchées.

### Exporter

[Ouvrir le menu Conversation et choisir un format d'export](../media/aide/conversations-exporter.webm)

1. Ouvrez le menu **Conversation**, puis cliquez sur **Exporter**.
2. Choisissez **Markdown**, **JSON**, **Texte brut** ou **PDF**.

Les trois premiers formats téléchargent un fichier. **PDF** ouvre une version imprimable dans un nouvel onglet et lance l'impression : choisissez l'enregistrement en PDF dans la fenêtre de votre navigateur.

### Le nombre de conversations gardées

L'application garde un nombre limité de conversations actives, fixé par l'administrateur. Au-delà, les plus anciennes sont supprimées. Les conversations archivées ne comptent pas dans cette limite : archiver est le moyen de garder une conversation aussi longtemps que vous le voulez.

### Pour en tirer le maximum

- Le clic droit sur un titre donne le même menu que les trois points : inutile d'ouvrir la conversation pour la renommer, l'archiver ou la supprimer.
- La recherche de la barre latérale ne lit que les titres. Donnez un titre parlant aux conversations que vous voudrez retrouver.
- Exportez en **Markdown** pour reprendre l'échange dans un document, en **JSON** pour garder aussi les mesures de chaque réponse.
- Si une conversation affiche « Cette conversation n'existe plus. », elle a été supprimée depuis un autre onglet ou un autre poste. La liste se met à jour seule.

## Les sous-agents
<!-- aide: agents -->

Sur un travail large, l'assistant peut confier une partie de la mission à un sous-agent. Le sous-agent travaille de son côté, avec ses propres outils et son propre contexte, puis rend un rapport. Votre conversation reçoit quelques paragraphes de conclusion, pas les dizaines de fichiers qu'il a fallu lire.

### L'essentiel

[Activer les sous-agents depuis la page Agents](../media/aide/agents-activer.webm)

1. Dans la barre latérale, cliquez sur **Plus**, puis sur **Agents**.
2. Activez l'interrupteur **Sous-agents**, en haut à droite. La mention passe de « Désactivés » à « Activés ».
3. Revenez au chat et faites votre demande. L'assistant décide seul de déléguer ; vous pouvez aussi le lui demander.

Les sous-agents sont désactivés par défaut. Si **Agents** n'apparaît pas dans **Plus**, ou si l'interrupteur indique « Désactivés par l'administrateur », demandez à votre administrateur.

### Suivre et arrêter un agent

[Ouvrir la fenêtre d'un agent au travail, puis lire son rapport](../media/aide/agents-suivi.webm)

Chaque délégation ajoute une ligne dans la réponse : le nom de l'agent, sa mission et son contexte en jetons.

1. Pendant que l'agent travaille, cliquez sur l'œil, **Voir le déroulé de l'agent**.
2. La fenêtre de l'agent affiche **Consigne reçue**, ce que l'assistant lui a demandé, et **Déroulé**, ses étapes en direct.
3. À la fin, elle ajoute **Bilan** (statut, nombre d'appels d'outils, durée) et **Rendu à l'assistant**, son rapport. **Copier** le copie.
4. Fermez la fenêtre. La ligne de l'agent porte maintenant son statut, et l'assistant répond à partir du rapport.

À savoir :

- Pour arrêter un agent, cliquez sur la croix **Arrêter cet agent** de sa ligne, ou sur **Arrêter** dans sa fenêtre. Seul cet agent s'arrête : l'assistant continue.
- **Détails**, sur la ligne, déplie les fichiers modifiés, les commits et les avertissements de budget.
- Le statut vient du rapport de l'agent, corrigé par ce que l'application constate : « terminé », « partiel », « bloqué », « statut inconnu », « budget épuisé », « délai dépassé », « indisponible », « erreur » ou « annulé ».
- La coche verte ne s'affiche que pour un agent « terminé ». Un agent `verify` dont les tests échouent a bien fini son travail, mais porte « vérification échouée ».
- Après la fin, l'œil reste sur la ligne quand l'agent a un déroulé à montrer.
- Relisez le travail d'un agent qui écrit avant de le tenir pour fait : le diff, ou un agent `verify`.

### La page Agents

La page présente les agents en cartes. Sous **Livrés**, cinq agents sont prêts à l'emploi :

- `explore` : explorer en lecture seule. Localiser, lire, juger, remonter l'historique Git.
- `implement` : écrire le changement dans la sandbox et le vérifier, sans commiter.
- `verify` : lancer les tests et les commandes, diagnostiquer les échecs, ne rien modifier.
- `web` : chercher sur le web en pilotant un vrai navigateur, en lecture seule.
- `pr` : brancher et commiter un travail déjà en place, puis préparer la demande de fusion.

Sur chaque carte :

- l'interrupteur **Actif** retire ou remet l'agent parmi ceux que l'assistant peut choisir ;
- une bande indique ce qu'il peut faire : **Lire**, **Modifier**, **Terminal**, **Git**, **Web** ;
- son budget est exprimé en appels d'outils, par exemple « 60 appels », suivi de « réflexion » s'il réfléchit avant d'agir.

La description des agents livrés est en anglais : c'est le texte que lit l'assistant pour choisir. Un clic sur une carte ouvre la fiche de l'agent. Vous pouvez modifier un agent livré : **Réinitialiser** reprend ensuite le modèle d'origine, **Dupliquer** en fait un agent personnel.

### Créer un agent personnel

1. Sous **Personnels**, cliquez sur **Nouvel agent**. Vous pouvez en avoir jusqu'à 30.
2. Onglet **Général** : le **Nom** (minuscules, chiffres, `-` et `_`, 32 caractères au plus), la **Description** (une ligne, en anglais, lue par l'assistant pour choisir cet agent) et le **Budget** en appels d'outils. Laissé vide, le budget prend la valeur par défaut.
3. Onglet **Outils** : les **Catégories** d'outils, et les **Serveurs MCP** auxquels l'agent se connecte, même s'ils ne sont pas actifs dans le chat.
4. Onglet **Droits** : **Fichiers**, **Réflexion** et, pour un agent qui a des outils web, **Navigateur**. Une ligne sous chaque choix dit ce qu'il change.
5. Onglet **Instructions** : le texte lu par l'agent, en anglais. **Gabarit** insère la structure des agents livrés.
6. Cliquez sur **Enregistrer**. L'agent n'existe que pour votre compte.

Vous pouvez aussi le faire rédiger. Cliquez sur **Assistant**, en haut de la page, ou sur la carte **Créer avec l'assistant** tant que vous n'avez aucun agent personnel. Donnez un nom et la mission. L'assistant pose deux séries de questions au plus, rédige la fiche, vous la montre, puis l'enregistre après votre accord. L'agent est créé désactivé : relisez-le, puis activez-le depuis la page (bouton **Ouvrir dans Agents** sous le résultat).

### Les droits d'un agent

- **Fichiers** : **Écriture** ou **Lecture seule**. En lecture seule, l'agent lit et cherche seulement : rien n'est modifié, et le terminal lui est retiré. `explore` et `web` sont livrés ainsi ; `web` garde son navigateur. La mention « Imposé par l'administrateur » signale un choix que vous ne pouvez pas changer.
- **Réflexion** : **Comme la conversation**, **Activée** ou **Désactivée**. Sans effet si le modèle ne réfléchit pas.
- **Navigateur** : en **Session privée**, l'agent navigue dans une session vide, sans vos connexions, fermée à la fin de sa mission. Avec **Ma session web**, il utilise votre session connectée et agit sur les sites comme vous. L'administrateur peut interdire ce second choix.

Deux précautions :

- Sur un serveur MCP externe, un agent en lecture seule ne peut appeler que les outils que ce serveur déclare en lecture seule. Les autres lui sont refusés.
- Aucun agent ne publie avec l'outil Git de l'application : `pr` prépare la branche et le commit, puis c'est l'assistant qui pousse, dans le chat, sous vos yeux. Cette règle ne couvre pas un serveur MCP externe capable de publier : n'attachez à un agent que des serveurs dont vous acceptez qu'il se serve seul.

### Les limites

- Un sous-agent ne délègue pas à son tour, n'a pas de liste de tâches, ne lance pas de tâche de fond et ne vous pose pas de question.
- Il démarre sans rien connaître de la conversation : l'assistant lui écrit une consigne complète.
- Un tour lance 12 agents au plus par défaut. Au plafond, l'assistant termine avec ce que ses agents ont rapporté, ou vous demande comment continuer.
- Une mission dure une heure au plus par défaut. À l'échéance, l'agent s'arrête et rend un rapport partiel, que l'assistant peut reprendre.
- Les agents lancés par un même message partent ensemble. Quand un autre agent écrivait en même temps, **Détails** le signale : certains fichiers modifiés peuvent être les siens.
- L'assistant ne délègue ni en mode plan, ni dans une routine.
- L'administrateur règle ces plafonds et peut couper les sous-agents pour tous.

### Les agents en fond

Pour une mission longue dont il n'a pas besoin tout de suite, l'assistant peut lancer un agent en fond. La ligne de l'agent porte alors « en fond ». L'assistant vous rend la main. Le rapport arrive plus tard : il rejoint le travail en cours, ou relance la conversation si l'assistant avait fini.

- Le bouton d'arrêt de la réponse ne l'arrête pas. Utilisez sa croix, ou **Arrêter** dans la liste des tâches de fond, où il porte la mention « sous-agent ».
- Le réglage **Ne pas me réveiller dans cette conversation** vaut aussi pour lui. Voir [Quand l'assistant agit](#quand-lassistant-agit).

### Pour en tirer le maximum

- `/agents on` et `/agents off` activent et coupent les sous-agents sans quitter le chat ; `/agents open` ouvre la page.
- Nommez l'agent dans votre demande quand vous savez lequel convient : « lance un agent `explore` pour trouver où est calculé le solde ».
- Ouvrez l'œil pendant le travail plutôt qu'après : vous voyez l'étape en cours et pouvez arrêter un agent qui part dans une mauvaise direction, sans perdre le reste du tour.
- Coupez l'interrupteur **Actif** des agents que vous ne voulez pas voir choisis, par exemple `web` ou `pr`.
- Un agent qui finit sur « budget épuisé » manque d'appels d'outils : augmentez son **Budget** dans l'onglet **Général**.
- Un agent personnel relié à un serveur MCP fait un bon documentaliste : il cherche dans votre wiki ou votre outil de tickets et ne rapporte que la réponse. Laissez-le en **Écriture** si les outils du serveur ne se déclarent pas en lecture seule.
- Après un agent `implement`, demandez un agent `verify` : il lance les tests sans rien modifier.
- Si vous arrêtez la réponse pendant qu'un agent travaille, **Continuer** permet à l'assistant de le reprendre là où il en était.

## Les outils et le panneau MCP
<!-- aide: mcp -->

Les outils permettent à l'assistant d'agir au lieu de seulement écrire : lire un fichier, lancer une commande, ouvrir une page web. Le panneau **MCP** règle ceux dont il dispose dans la conversation en cours. Le panneau tient son nom du protocole qui relie l'assistant à ses outils (*Model Context Protocol*).

[Ouvrir le panneau MCP, activer deux catégories, puis retirer un outil précis](../media/aide/mcp-categories.webm)

### L'essentiel

1. Cliquez sur **MCP** dans la barre latérale. Le panneau s'ouvre à droite de la conversation.
2. Sous **Internes**, activez l'interrupteur de chaque catégorie utile à votre demande.
3. Écrivez votre message. L'assistant choisit lui-même, parmi les outils actifs, ceux qu'il appelle.
4. Chaque appel figure dans sa réponse, avec ses paramètres et son résultat : voir [Quand l'assistant agit](#quand-lassistant-agit).

Les interrupteurs sont propres à chaque conversation et enregistrés avec elle. Rouvrir une conversation d'hier restitue les outils qui étaient actifs. Un nouveau chat part des catégories choisies par défaut par l'administrateur.

### Les catégories d'outils

Activer une catégorie donne à l'assistant tous ses outils.

| Catégorie | Ce que l'assistant peut faire |
|---|---|
| **Fichiers** | Lire, écrire et modifier les fichiers de votre sandbox, les lister, les déplacer, parcourir la structure d'un code |
| **Terminal** | Exécuter des commandes dans votre sandbox, y compris des tâches longues en arrière-plan |
| **Git** | Cloner un dépôt, consulter son état, créer une branche, commiter, pousser et ouvrir une demande de fusion |
| **Navigateur** | Piloter un navigateur : ouvrir une page, cliquer, remplir un formulaire, vérifier un résultat |
| **Contrôle d'écran** | Observer et piloter une machine reliée à l'application |
| **Graphiques** | Produire des graphiques et des tableaux à partir de données |
| **Documents Office** | Créer, lire et modifier des documents Word et PowerPoint, les exporter en PDF |
| **Skills** | Lire le détail d'un skill et en enregistrer de nouveaux |

La liste dépend de l'installation. Si une catégorie manque, ou si le panneau indique « Aucune catégorie d'outils active pour le moment », demandez à votre administrateur.

Quelques outils n'ont pas d'interrupteur dans le panneau :

- la liste de tâches que l'assistant tient pendant un travail long (puce **Tâches de la session**, dans la barre de saisie) ;
- la délégation à des [sous-agents](#les-sous-agents), si vous les avez activés ;
- la mémoire, qui se règle dans Paramètres › **Mémoire** (voir [La mémoire](#la-mémoire)).

### Choisir les outils d'une catégorie

Vous pouvez garder une catégorie tout en lui retirant certains outils.

1. Activez la catégorie.
2. Cliquez sur le chevron à droite de son nom (**Choisir les outils**) : la liste de ses outils se déplie.
3. Décochez ceux que l'assistant ne doit pas utiliser. Un compteur, par exemple `5/6`, s'affiche à côté du nom.
4. **Tout** les recoche tous. L'icône d'information en bout de ligne ouvre le **Détail de l'outil**.

### Les serveurs externes

Un serveur MCP externe apporte les outils d'un autre service : une forge logicielle, un wiki, une base interne. La section **Externes** du panneau liste ceux que vous avez choisi d'afficher. Chacun s'active par son interrupteur, comme une catégorie, pour la conversation en cours.

[Afficher dans le panneau un serveur publié par l'administrateur, puis l'activer](../media/aide/mcp-serveur-externe.webm)

#### Utiliser un serveur publié par l'administrateur

1. Dans la section **Externes**, cliquez sur **+** (**Gérer / ajouter un serveur**). La fenêtre **Serveurs MCP** s'ouvre.
2. À gauche, sous **Partagés**, cliquez sur le serveur.
3. Activez **Afficher dans le panneau**, puis fermez la fenêtre.
4. Le serveur figure maintenant sous **Externes**. Activez son interrupteur dans chaque conversation où vous en avez besoin.

Ses identifiants sont gérés par l'administrateur : vous n'avez rien à saisir.

#### Ajouter votre propre serveur

1. Dans la fenêtre **Serveurs MCP**, cliquez sur **Ajouter**.
2. Si votre service figure dans la ligne **Modèle** (**Jenkins**, **Wiki.js**), cliquez dessus : les champs se préremplissent.
3. Renseignez le **Nom**, le **Type** (**HTTP** ou **SSE**, selon la documentation du service) et l'**Adresse**.
4. Choisissez l'authentification dans **Auth** :
   - **Aucune** ;
   - **Jeton (Bearer)** : le jeton seul, sans le mot « Bearer » ;
   - **Basic** : un nom d'utilisateur et un mot de passe ou un jeton ;
   - **Clé d'API** : le nom de l'en-tête et sa valeur ;
   - **Authorization brut** : la valeur complète de l'en-tête.
5. Si le service demande d'autres en-têtes, ajoutez-les avec **+ En-tête**.
6. Cliquez sur **Tester**. L'application interroge le serveur sans rien enregistrer, puis affiche le nombre d'outils trouvés ou l'erreur.
7. Cliquez sur **Ajouter**. Le serveur apparaît sous **Mes serveurs** et dans la section **Externes** du panneau.

Ce qu'il faut savoir :

- Les secrets saisis sont conservés chiffrés par l'application et ne sont plus jamais affichés. À la réouverture, les champs indiquent « inchangé » : laissez-les vides pour garder la valeur, ou retapez-la pour la remplacer.
- Une adresse interne (la machine du serveur, le réseau privé de l'entreprise) est refusée à un compte ordinaire : « Adresse de serveur MCP refusée ». Ces serveurs doivent être publiés par un administrateur. Demandez-lui de le faire, puis suivez les étapes du paragraphe précédent.
- Pour modifier un serveur, choisissez-le à gauche, changez ses champs, puis **Enregistrer**. Si vous fermez avant, le bandeau **Modifications non enregistrées** propose **Abandonner** ou **Enregistrer**.
- **Supprimer** demande un second clic sur le même bouton pour confirmer.

### Pour en tirer le maximum

- Moins, c'est souvent mieux. Chaque catégorie active ajoute la description de ses outils à ce que l'assistant doit lire. Pour une question de pure rédaction, tout désactiver rend la réponse plus rapide et plus directe.
- Pour laisser l'assistant lire sans rien modifier, gardez **Fichiers** et décochez `write_file`, `edit_file` et `manage_files` dans la liste de ses outils.
- Les réglages suivent la conversation. Gardez une conversation « lecture seule » pour explorer un projet et une autre, avec **Terminal** et **Git**, pour le modifier.
- **Contrôle d'écran** : une fois la catégorie activée, la liste **Cible** choisit la machine pilotée.
- Dans la fenêtre **Serveurs MCP**, le champ **Rechercher** filtre la liste, et les flèches `↑` et `↓` passent d'un serveur à l'autre.
- Désactiver **Afficher dans le panneau** retire un serveur du panneau sans le supprimer.
- Une [routine](#les-routines) choisit ses propres outils, dans son onglet **Outils** : ceux de vos conversations ne s'y appliquent pas.
- Pour retirer tous les outils d'un coup, désactivez **MCP** dans Paramètres › **Fonctionnalités** › **Modules**. L'assistant ne peut alors plus qu'écrire, seule la mémoire reste, et l'entrée **MCP** quitte la barre latérale.
- Le panneau **MCP** et le panneau des [réglages de génération](#modèles-et-fournisseurs) occupent la même place : ouvrir l'un referme l'autre.

### Utiliser vos outils depuis une autre application

Si l'administrateur l'autorise, un éditeur de code, un assistant en ligne de commande ou un script peut utiliser les mêmes outils que vos conversations. Chaque appel s'exécute dans votre sandbox, sous votre compte.

1. Ouvrez Paramètres › **Secrets** › **Jetons MCP**, puis cliquez sur **Nouveau jeton**.
2. Donnez-lui un **Nom**, cochez les **Familles d'outils** à confier, réglez la **Durée de validité**, puis cliquez sur **Créer**. Le navigateur et le contrôle d'écran ne sont jamais cochés d'office.
3. Copiez le jeton tout de suite : il n'est montré qu'une fois.
4. Copiez le bloc de configuration proposé pour votre client. Les onglets **MCP**, **VS Code** et **opencode** servent aux clients qui parlent MCP. Les onglets **OpenAPI** et **curl** servent aux plateformes et aux scripts qui ne le parlent pas.

Un client MCP qui gère lui-même l'autorisation n'a pas besoin de jeton. À sa première connexion, il ouvre la page **Autoriser l'accès à vos outils** : cochez les familles, puis **Autoriser**. Ces accès se retirent sous **Applications autorisées**, par **Retirer l'accès**.

Sur chaque jeton, **Régénérer** remplace sa valeur et **Révoquer** le coupe ; **Tout révoquer** coupe tous vos jetons. Si l'onglet indique que les jetons d'outils sont désactivés, demandez à votre administrateur.

### Comment ça marche

Les outils de fichiers, de terminal et Git travaillent dans votre sandbox, pas sur le serveur ni dans l'espace d'un autre utilisateur : voir [La sandbox et l'éditeur de code](#la-sandbox-et-léditeur-de-code). Le déroulé d'un tour d'outils est décrit dans [Quand l'assistant agit](#quand-lassistant-agit).

## La sandbox et l'éditeur de code
<!-- aide: editeur -->

La sandbox est votre espace de travail privé sur le serveur : l'assistant y écrit, exécute et teste du code sans toucher à votre poste. L'éditeur de code vous y donne accès, à côté du chat : fichiers, onglets, Git, aperçu et snapshots.

[Ouvrir la sandbox, déplier un dossier et ouvrir un fichier](../media/aide/editeur-ouvrir.webm)

### L'essentiel

1. Cliquez sur **Sandbox** dans la barre latérale. L'éditeur s'ouvre à droite du chat.
2. Dans l'explorateur, cliquez sur un dossier pour le déplier, puis sur un fichier pour l'ouvrir dans un onglet.
3. Modifiez le fichier, puis enregistrez avec `Ctrl+S`.
4. Recliquez sur **Sandbox**, ou sur **Fermer** en haut à droite de l'éditeur, pour refermer le panneau.

Faites glisser le bord gauche de l'éditeur pour l'élargir ; **Plein écran** lui donne toute la fenêtre, `Échap` en sort. Quand l'éditeur est étroit, l'explorateur se pose sur le code et se replie dès qu'un fichier s'ouvre : le bouton **Explorateur de fichiers**, en haut à gauche, ou `Ctrl+B` le font revenir. Si l'entrée **Sandbox** manque dans la barre latérale, activez **Sandbox** dans Paramètres › **Fonctionnalités** › **Modules**.

### L'explorateur de fichiers

En tête, trois icônes changent de vue : **Fichiers**, **Git** (avec le nombre de fichiers modifiés) et **Historique**.

- **Nouveau fichier** crée un fichier. Le menu **Actions des fichiers** (« ⋯ ») réunit **Nouveau dossier**, **Importer des fichiers**, **Importer un dossier**, **Fichiers cachés**, **Localiser le fichier ouvert**, **Tout replier** et **Actualiser**.
- Un clic droit sur un fichier ou un dossier propose **Nouveau Fichier**, **Nouveau Dossier**, **Terminal ici**, **Renommer**, **Dupliquer**, **Copier le chemin**, **Télécharger** et **Supprimer** ; pour un fichier, **Joindre au chat** l'ajoute à votre prochain message.
- Glissez un fichier sur un dossier pour le déplacer. Glissez des fichiers ou des dossiers entiers depuis votre poste pour les importer, même volumineux : une barre montre la progression et permet d'annuler.
- Le champ **Rechercher...** cherche un texte dans tous les fichiers. **Contenu** et **Nom** changent de mode ; `Aa` respecte la casse, `.*` accepte une expression régulière, un filtre (`*.py`) limite la recherche.
- Dans un dépôt Git, une lettre suit chaque fichier touché : `M` modifié, `U` non suivi, `A` ajouté, `D` supprimé, `C` en conflit. Un point marque les dossiers qui contiennent des modifications.
- Quand un quota disque s'applique, la jauge en haut à droite de l'éditeur montre la part utilisée.

### Modifier et enregistrer

[Modifier un fichier puis l'enregistrer par le menu de l'éditeur](../media/aide/editeur-modifier.webm)

1. Tapez dans le code. Une pastille apparaît sur l'onglet et la barre d'état, en bas, affiche **non sauvegardé**.
2. Enregistrez avec `Ctrl+S`, ou par le menu **Plus d'actions** (« ⋯ », en haut à droite) › **Enregistrer**.
3. La pastille disparaît et la barre d'état affiche **sauvegardé**.

**Tout enregistrer** (`Ctrl+Alt+S`) enregistre tous les onglets modifiés ; fermer un onglet modifié demande d'abord s'il faut l'enregistrer. Le code est coloré selon l'extension du fichier, pour plus de trente langages, dont Robot Framework. La barre d'état indique aussi la branche Git, la position du curseur, les erreurs et avertissements du fichier (cliquez pour les lister), le langage, l'indentation, l'encodage et les fins de ligne (cliquez sur `LF` ou `CRLF` pour convertir).

### Retrouver un fichier et gérer les onglets

[Retrouver un fichier par quelques lettres de son nom avec Ctrl+P](../media/aide/editeur-ouverture-rapide.webm)

1. Appuyez sur `Ctrl+P`.
2. Tapez quelques lettres du nom. Sans saisie, les fichiers récents viennent en premier.
3. Choisissez avec les flèches et `Entrée`, ou cliquez. Le fichier s'ouvre dans un nouvel onglet.

Un clic droit sur un onglet propose **Fermer**, **Fermer les autres**, **Fermer ceux à droite**, **Tout fermer**, **Ouvrir à droite (vue scindée)**, **Copier le chemin**, **Localiser**, **Épingler**, **Joindre au chat** et **Tout enregistrer**. Glissez un onglet pour le déplacer. Quand les onglets débordent, un bouton « +N » les liste.

### Comparer et revenir en arrière

- Le bouton **Versions**, au bout du chemin du fichier, compare l'onglet avec **La sauvegarde** (ce qui est enregistré), **Le dernier commit** (dans un dépôt Git) ou **L'original** (le fichier au début de votre session). Les différences s'affichent en couleur ; recliquez sur le même choix pour revenir au code.
- La vue **Historique** de l'explorateur liste les fichiers modifiés depuis votre connexion, par vous ou par l'assistant. Dépliez un fichier : chaque version se compare à l'onglet ou s'y restaure.
- Quand l'assistant écrit un fichier, l'éditeur l'ouvre et teinte brièvement les lignes modifiées ; les réglages **Ouverture automatique** et **Surbrillance des modifications**, dans Paramètres › **Fonctionnalités** › **Éditeur**, coupent l'un ou l'autre. S'il réécrit un fichier que vous modifiez, un bandeau le signale : vos modifications sont gardées, **Comparer** les montre et **Restaurer** les reprend.
- Si un fichier ouvert change sur le disque, après une commande du terminal par exemple, un bandeau propose **Comparer**, **Recharger** ou **Écraser**.

### Les actions IA

[Faire expliquer un passage du code, puis accepter la proposition](../media/aide/editeur-ia.webm)

1. Sélectionnez les lignes concernées, puis faites un clic droit dans la sélection.
2. Sous **Actions IA**, choisissez **Expliquer ce code**, **Commenter (IA)**, **Refactoriser**, **Chercher des bugs**, **Optimiser**, **Ajouter docstring** ou **Générer des tests**.
3. La proposition s'affiche en comparaison avec votre code. Cliquez sur **Accepter** pour l'appliquer, ou sur **Rejeter**. Une proposition acceptée modifie l'onglet : enregistrez ensuite.

- **Expliquer ce code** et **Chercher des bugs** ajoutent un commentaire, **Générer des tests** ajoute les tests sous la sélection ; les autres actions réécrivent la sélection.
- **Compléter ici** (`Alt+\`) écrit la suite du code à l'endroit du curseur, sans sélection, en tenant compte de ce qui précède et de ce qui suit.
- **Demander au chat** copie la sélection dans le champ de saisie du chat, avec le chemin du fichier et les numéros de ligne : il ne reste qu'à poser votre question.
- Le même menu donne **Exécuter le fichier**, **Commenter / Décommenter**, **Formater le document**, **Aller à la définition**, **Trouver les références** et **Renommer le symbole**.

Ces actions demandent un modèle qui sait compléter du code. Si un message indique que la complétion est indisponible, demandez à votre administrateur.

### L'aperçu

[Afficher une page HTML à côté du code et la voir suivre la frappe](../media/aide/editeur-apercu.webm)

L'aperçu des pages web s'active une fois, dans Paramètres › **Fonctionnalités** › **Éditeur** › **Aperçu**.

1. Ouvrez un fichier HTML, puis **Plus d'actions** (« ⋯ ») › **Aperçu à côté**. La page s'affiche à droite du code.
2. Cliquez sur **Live** : la page s'enregistre et se recharge pendant que vous tapez. Sans **Live**, elle se recharge à chaque enregistrement.

La barre de l'aperçu permet de changer de fichier, de recharger, d'ouvrir la page dans un onglet du navigateur et de fermer. Le bouton **Web**, en haut de l'éditeur, affiche l'aperçu seul, sur toute la largeur.

Pour voir une application qui tourne dans votre sandbox, passez la source de **Fichier** à **Serveur** et saisissez son adresse : `localhost:8080`, un port seul (`8080`) ou une adresse complète (`http://localhost:5173/app`). Ce mode demande un profil réseau connecté : avec le profil isolé, l'aperçu affiche « Sandbox injoignable ».

[Afficher le rendu d'un fichier Markdown à côté de son texte](../media/aide/editeur-apercu-markdown.webm)

Pour un fichier Markdown ou SVG, **Plus d'actions** › **Aperçu Markdown** (ou **Aperçu SVG**) affiche le rendu à côté du texte, sans réglage préalable. Le rendu suit vos modifications.

### Git

[Ouvrir la vue Git et afficher les changements d'un fichier](../media/aide/editeur-git.webm)

1. Cliquez sur l'icône **Git** de l'explorateur, ou sur le nom de la branche dans la barre d'état.
2. La vue liste les fichiers **Indexés**, **Modifiés** et **Non suivis**, avec les lignes ajoutées et retirées.
3. Cliquez sur un fichier modifié : ses changements depuis le dernier commit s'affichent en couleur.

[Indexer les fichiers, faire proposer le message et valider le commit](../media/aide/editeur-git-commit.webm)

Pour enregistrer vos changements dans l'historique du dépôt :

1. Cliquez sur **Tout indexer**, ou sur le « + » d'un fichier pour n'indexer que lui.
2. Écrivez le message dans **Message de commit...**, ou cliquez sur l'étincelle du champ : l'assistant le propose d'après les changements indexés.
3. Cliquez sur **Commit**. `Ctrl+Entrée` dans le message fait de même.

| Besoin | Dans la vue Git |
|---|---|
| **Dépôt et branche** | Deux menus en tête : changer de dépôt ; changer de branche (**Locales**, **Distantes**) ou en créer une (**Nouvelle branche**) |
| **Synchroniser** | **Actualiser**, **Pull**, **Push** ; sous « ⋯ » : **Fetch**, **Pull (rebase)**, **Push (force)**, **Remote...** |
| **Fusionner** | **Merge**, avec un aperçu avant fusion, et **Rebase** ; en cas de conflit, **Mienne** ou **Leur** fichier par fichier, **Annuler** pour abandonner |
| **Mettre de côté** | **Stash** puis **Stash Pop** |
| **Historique** | « ⋯ » › **Historique** : cliquez sur un commit pour voir ses fichiers, puis sur un fichier pour le comparer |
| **Réparer** | **Annuler dernier commit** ajoute un commit qui l'annule ; **Restaurer**, sur un commit de l'historique, y ramène le dépôt par un nouveau commit |
| **Annuler** | La flèche d'un fichier modifié abandonne ses modifications, après confirmation |

Les échanges avec le serveur Git passent par vos comptes Git : aucun identifiant n'est écrit dans la sandbox, et un dépôt privé se clone sans rien saisir. Voir [Secrets et comptes Git](#secrets-et-comptes-git).

#### Ajouter un dépôt

[Ajouter un dépôt en le choisissant dans la liste d'un compte Git](../media/aide/editeur-depot.webm)

1. Dans la vue **Git**, cliquez sur **Ajouter un dépôt**. Si un dépôt existe déjà, cliquez sur son nom, puis sur **Ajouter un dépôt...**.
2. Choisissez une façon :
   - **Mes dépôts** : les dépôts d'un de vos comptes Git, dans la limite de ce à quoi il s'applique. Choisissez le **Compte** si vous en avez plusieurs, puis un dépôt. L'onglet n'apparaît que si un compte peut lister ses dépôts.
   - **Depuis une URL** : collez une URL de clonage en `http(s)`. Une URL SSH est refusée, avec la raison.
   - **Nouveau dépôt** : un dépôt vide, créé dans le dossier que vous nommez ; sans nom, à la racine de votre espace de travail.
3. Vérifiez le récapitulatif : **Dépôt** (tel qu'il a été lu), **Accès** (le compte qui servira) et **Dossier** (par défaut, le nom du dépôt).
4. Cliquez sur **Cloner**, ou sur **Initialiser** pour un dépôt neuf.

- Le compte retenu est le plus précis qui couvre le dépôt ; la fenêtre signale quand aucun ne convient ou quand son jeton est à vérifier.
- Sans compte, ou si l'accès est refusé, saisissez des identifiants sur place : si le clone réussit, ils sont enregistrés comme compte Git, et la fenêtre précise quand ils ne le sont pas. C'est aussi le cas d'un dépôt placé à la racine d'un serveur (`https://git.exemple/projet.git`), qu'aucun compte ne couvre.
- En `http://`, un compte Git ne sert que sur le réseau local ; la fenêtre signale ce qui part alors en clair.
- Vos commits sont attribués à votre compte, ceux de l'assistant à « votre compte (Elpis agent) », sur des branches `agent/…`.

### Les snapshots

Une snapshot capture tous les fichiers de votre sandbox à un instant donné. Prenez-en une avant de laisser l'assistant travailler en autonomie, ou avant une manipulation risquée.

[Créer une snapshot nommée depuis le menu de l'éditeur](../media/aide/editeur-snapshots.webm)

1. Ouvrez **Plus d'actions** (« ⋯ ») › **Snapshots**.
2. Donnez-lui un nom ; sans nom, elle porte la date et l'heure.
3. Cliquez sur **Créer une snapshot**. Elle rejoint la liste, avec son nombre de fichiers, sa taille et sa date.

[Restaurer une snapshot : les fichiers reviennent à l'état capturé](../media/aide/editeur-snapshot-restaurer.webm)

Pour y revenir, cliquez sur l'icône **Restaurer** de la snapshot, puis confirmez avec **Restaurer**. Tous les fichiers actuels sont remplacés par ceux de la snapshot, et les onglets ouverts sont fermés.

- Enregistrez ou fermez d'abord les onglets modifiés : la restauration est refusée tant qu'il en reste.
- Le compteur du panneau (« 2/10 ») rappelle le nombre de snapshots gardées, fixé par l'administrateur. Au-delà, les plus anciennes sont supprimées. La corbeille qui apparaît au survol supprime une snapshot.
- Si une restauration est interrompue, le panneau le signale : relancez-la.

### Le style de l'éditeur

L'éditeur prend le style de l'habillage, ou garde l'éditeur classique : le choix et son **Thème sombre** se règlent dans Paramètres › **Apparence** › **Éditeur** (voir [Apparence](#apparence)). La bascule se fait aussi dans l'éditeur, sans rien perdre des modifications en cours : « ⋯ » › **Éditeur classique**, puis « + » › **Éditeur du skin** pour revenir. L'éditeur classique nomme autrement quelques entrées de son menu, par exemple **Sauvegarder** ou **Snapshots de la sandbox**.

### Pour en tirer le maximum

- Les touches de l'éditeur (ouvrir un fichier, changer d'onglet, plusieurs curseurs) sont dans [Raccourcis clavier](#raccourcis-clavier) ; **Plus d'actions** › **Raccourcis** les affiche dans l'éditeur. Une palette de commandes s'ouvre avec `Ctrl+Maj+P`, et les onglets se ferment avec `Alt+W`.
- **Plus d'actions** › **Exécuter** enregistre le fichier ouvert et le lance dans le terminal (Python, JavaScript, shell, Ruby, Perl, PHP, Lua, R, Go). Pour une page HTML, il ouvre l'aperçu.
- Sélection multiple dans l'explorateur : `Ctrl`+clic ajoute un fichier, `Maj`+clic sélectionne une plage. Le clic droit propose alors **Joindre au chat**, **Télécharger (zip)** et **Supprimer**.
- Remplacer dans tous les fichiers : lancez une recherche de contenu, cliquez sur **Remplacer dans les fichiers**, saisissez le nouveau texte, puis **Aperçu**. Décochez les fichiers à épargner et cliquez sur **Remplacer**.
- Deux fichiers côte à côte : clic droit sur un onglet › **Ouvrir à droite (vue scindée)**.
- Paramètres › **Fonctionnalités** › **Éditeur** règle la police et sa taille, l'indentation, le retour à la ligne, la minimap, les numéros de ligne, la **Sauvegarde automatique** (après 30 s, 1 min ou 2 min sans frappe, ou à la perte du focus), **Suivre le fichier ouvert** et **Mémoriser les onglets**.
- Avant de confier une longue tâche à l'assistant, prenez une snapshot ou faites un commit. Ensuite, la vue **Git** ou **Historique** montre exactement ce qu'il a changé.

### Comment ça marche

Chaque compte dispose d'une sandbox isolée et persistante. Votre dossier de travail y est `/work` : l'éditeur, le terminal et les outils de l'assistant travaillent tous dans ce même dossier.

- **Dans votre sandbox, vous et l'assistant avez tous les droits** : `sudo` sans mot de passe, installation de paquets, compilation. C'est voulu : cette sandbox n'appartient qu'à vous. `sudo` est refusé sur un profil réseau limité à une liste d'adresses, ou quand votre administrateur l'a désactivé : `pip install` et `npm install -g` fonctionnent toujours (ils installent sous `/work`) ; demandez à votre administrateur les paquets système dont vous avez besoin.
- **Le serveur et les autres utilisateurs sont protégés** : la sandbox est cloisonnée, avec des limites de mémoire, de processeur et de processus.
- **Le réseau est coupé par défaut.** L'administrateur définit des profils réseau (isolé, accès complet, liste d'adresses autorisées) et vous en choisissez un, sauf s'il en impose un. Un `pip install` ou un `git clone` qui échoue en connexion refusée vient probablement de là, pas d'une panne ; l'assistant connaît l'état du réseau.
- **Un quota disque s'applique** ; la jauge de l'éditeur le montre.
- **Une sandbox inactive est arrêtée automatiquement** et redémarre à votre prochaine action. Vos fichiers ne bougent pas.

Paramètres › **Avancé** › **Sandbox** montre l'état de la sandbox, sa consommation, ses limites et le profil **Réseau**. **Redémarrer** la relance. **Détruire** la supprime sans toucher à votre dossier de travail : elle sera recréée au prochain usage. **Vider**, en bas de la page, supprime définitivement tous vos fichiers ; vos skills et votre mémoire ne sont pas concernés.

## Le terminal
<!-- aide: terminal -->

Le terminal est une vraie ligne de commande dans votre sandbox, sous l'éditeur. Servez-vous-en pour lancer des tests, installer un paquet ou vérifier ce que l'assistant a fait.

[Ouvrir le terminal sous l'éditeur](../media/aide/terminal-ouvrir.webm)

### L'essentiel

1. Ouvrez l'éditeur : **Sandbox** dans la barre latérale.
2. Cliquez sur le bouton **Terminal**, en haut à droite de l'éditeur, ou appuyez sur `` Ctrl+` `` (Ctrl et accent grave). Le panneau s'ouvre sous le code, avec un premier onglet **Terminal 1**.
3. Cliquez dans le terminal et tapez vos commandes. La sortie s'affiche en temps réel.
4. La croix à droite de la barre d'onglets, **Masquer le panneau**, replie le terminal sans l'arrêter : ce qui y tourne continue, et vous le retrouvez en rouvrant le panneau.

Si votre sandbox était arrêtée, un message de démarrage s'affiche à la première ouverture, le temps qu'elle redémarre.

### Plusieurs terminaux

[Lancer une commande, puis ouvrir un second terminal](../media/aide/terminal-commande.webm)

- Le bouton « + » de la barre d'onglets, **Nouveau terminal**, ouvre un autre terminal dans un nouvel onglet. Vous pouvez en ouvrir quatre ; un compteur apparaît à l'approche de la limite.
- Cliquez sur un onglet pour y revenir. Sa pastille est verte quand le terminal est connecté ; survolez l'onglet pour lire son état.
- Double-cliquez sur un onglet pour le renommer. `Entrée` valide, `Échap` annule.
- La croix d'un onglet, **Fermer ce terminal**, arrête ce terminal et ce qui y tourne.

### Pour en tirer le maximum

- `` Ctrl+` `` ouvre et replie le terminal sans quitter le clavier. Le menu **Plus d'actions** (« ⋯ ») › **Terminal** fait de même.
- Clic droit dans l'explorateur de fichiers › **Terminal ici** : le terminal se place directement dans ce dossier.
- **Plus d'actions** › **Exécuter** lance le fichier ouvert dans le terminal : voir [La sandbox et l'éditeur de code](#la-sandbox-et-léditeur-de-code).
- Dans la sortie, un chemin de fichier connu de l'explorateur est cliquable, comme `src/calcul.py:12` ou la ligne d'une erreur Python : il ouvre le fichier à cette ligne dans l'éditeur.
- Faites glisser le bord supérieur du panneau pour l'agrandir. Sa hauteur est retenue.
- Après une commande, l'explorateur, les onglets ouverts et la vue Git se mettent à jour seuls.
- Un terminal par tâche : un serveur de développement dans l'un, les tests dans l'autre, chacun renommé. L'aperçu en mode **Serveur** affiche ensuite l'application lancée : voir [La sandbox et l'éditeur de code](#la-sandbox-et-léditeur-de-code).
- Vous avez tous les droits dans votre sandbox : `sudo apt install …` ou `pip install …` fonctionnent, si le profil réseau le permet (`sudo` est refusé sur un profil limité à une liste d'adresses, ou quand l'administrateur l'a désactivé).

### Comment ça marche

Le terminal tourne dans votre sandbox et démarre dans votre dossier de travail. Il utilise le même utilisateur que l'éditeur et l'assistant : un fichier créé d'un côté se modifie et se supprime de l'autre. Le quota disque et le profil réseau de la sandbox s'y appliquent aussi.

- Un terminal resté inactif 30 minutes est fermé automatiquement.
- Si la connexion est coupée, l'onglet le signale et se reconnecte seul. Après un redémarrage du serveur, le terminal repart sur un nouveau shell et l'indique : le texte déjà affiché reste, les programmes en cours sont arrêtés.

## Les routines
<!-- aide: routines -->

Une routine est une tâche que l'assistant exécute sans vous : mêmes outils, mêmes skills, mais lancée par une horloge, par un autre service ou par la fin d'une autre routine. Par exemple : « chaque matin à 7 h, vérifier les mises à jour du projet et m'en faire le résumé ».

### L'essentiel

1. Cliquez sur **Routines** dans la barre latérale. La page liste vos routines à gauche et montre à droite celle que vous avez choisie.
2. Créez une routine avec **Assistant** (il vous pose les questions) ou avec **Nouvelle** (vous remplissez le formulaire).
3. Laissez-la travailler. Chaque exécution s'ajoute à son journal, sous **Exécutions**, et vous prévient par une [notification](#notifications).

### Créer une routine avec l'assistant

Le plus simple : dites ce que vous voulez automatiser.

[Lancer l'assistant depuis la page Routines, décrire l'objectif, répondre à sa première question](../media/aide/routines-assistant.webm)

1. Sur la page **Routines**, cliquez sur **Assistant**, en haut à droite. Tant que vous n'avez aucune routine, le même bouton figure aussi au centre de la page.
2. Dans la fenêtre **Créer une routine avec l'assistant**, écrivez l'**Objectif**. **Quand** et **Résultat attendu** sont facultatifs. Cliquez sur **Commencer l'entretien**.
3. Un chat s'ouvre. L'assistant pose ses questions, en deux séries au plus, dans un questionnaire : voir [Répondre à un questionnaire](#répondre-à-un-questionnaire).
4. L'assistant vous montre le brouillon complet : nom, planification, tâche. Demandez les corrections voulues, puis donnez votre accord.
5. Il enregistre la routine, toujours **En pause**. Revenez à la page **Routines**, relisez-la, puis activez-la : voir « Mettre en pause, modifier, supprimer » plus bas.

Si l'assistant rédige la routine sans pouvoir l'enregistrer, vérifiez que **Créer des routines** est activé dans Paramètres › **Fonctionnalités** › **Modules**.

### Créer une routine à la main

[Créer une routine : son nom, sa planification, sa tâche, puis « Créer »](../media/aide/routines-creer.webm)

1. Cliquez sur **Nouvelle**.
2. Onglet **Général** : donnez un **Nom**.
3. Onglet **Planification** : choisissez la fréquence. Le résumé sous la liste dit en clair ce qui sera fait, par exemple « Chaque lundi, jeudi à 09:00 ».
4. Onglet **Tâche** : écrivez la **Tâche à exécuter**.
5. Onglet **Outils** : activez les outils dont la tâche a besoin.
6. Cliquez sur **Créer**.

Le nom et la tâche sont obligatoires. Les quatre onglets contiennent :

| Onglet | Contenu |
|---|---|
| **Général** | **Nom**, interrupteur **Active**, bloc **Historique** (ce que la routine garde et ce qu'elle notifie) |
| **Planification** | Fréquence, **Webhook**, **Enchaînement** |
| **Tâche** | **Serveur** et **Modèle**, **Prompt système** (optionnel), **Tâche à exécuter**, **Mode réflexion (thinking)** |
| **Outils** | **Outils locaux** (les catégories du panneau MCP), **Serveurs externes**, **Skills attachés à la tâche** |

### Choisir quand elle se lance

- **À heure fixe.** La liste de l'onglet **Planification** propose **Toutes les X minutes**, **Toutes les heures**, **Tous les jours**, **Chaque semaine** (cochez les jours), **Chaque mois** et **Avancé (cron)**. Les heures sont celles du serveur. En mode avancé, l'expression suit le format `min heure jour mois jour-semaine`, avec lundi = 1 et dimanche = 7.
- **À la demande.** Choisissez **Aucune (manuel / webhook)** : la routine ne part que par le bouton **Exécuter** ou par un webhook.
- **Par un autre service (webhook).** Enregistrez d'abord la routine. Rouvrez-la par **Configurer**, onglet **Planification**, puis cliquez sur **Générer un jeton**. Copiez le **Jeton**, affiché une seule fois, et l'**URL**. Dans votre forge, collez l'URL et donnez le jeton comme secret du webhook. Un autre émetteur peut envoyer le jeton dans l'en-tête `X-Webhook-Token`. Les champs **Événements**, **Branche** et **Dépôt** restreignent ce qui déclenche la routine. Un même envoi reçu deux fois n'est traité qu'une fois. **Désactiver** coupe le webhook.
- **Après une autre routine.** Dans le bloc **Enchaînement**, choisissez la routine sous **Après**, puis la condition sous **Si** : **Succès**, **Échec** ou **Toujours**.

### Suivre les exécutions

[Ouvrir une exécution du journal : la raison d'un échec, puis la réponse et le fichier produit](../media/aide/routines-suivi.webm)

Dans la liste de gauche, chaque routine affiche l'état de sa dernière exécution, par exemple « Réussi · il y a 12 h », « En cours… » ou « Jamais exécutée ». À droite, **Exécutions** donne une ligne par exécution : état, déclencheur, date, durée, jetons consommés, nombre de fichiers écrits et début de la réponse.

Cliquez sur une ligne pour la déplier. Vous y trouvez :

- la réponse complète de l'assistant, ou la raison de l'échec ;
- les **Fichiers produits** : un clic ouvre le fichier dans l'éditeur ;
- le déclencheur et le détail des jetons, en entrée et en sortie.

Les états possibles sont **Réussi**, **Échec**, **En cours**, **Arrêté** (vous l'avez arrêtée), **Ignoré** (elle n'a pas été lancée : trop d'exécutions en même temps, ou routine en pause) et **Interrompu** (l'exécution n'a pas pu se terminer, par exemple parce que le serveur a redémarré).

### Lancer une routine tout de suite

[« Exécuter » lance la routine : la ligne passe de « En cours » à « Réussi », puis s'ouvre](../media/aide/routines-executer.webm)

1. Choisissez la routine, puis cliquez sur **Exécuter**.
2. Une ligne **En cours** apparaît en tête du journal. La page se rafraîchit seule.
3. À la fin, la ligne passe à **Réussi** ou **Échec**. Cliquez dessus pour lire la réponse.

Pendant l'exécution, **Arrêter** l'interrompt. Une routine en pause ne peut pas être exécutée : réactivez-la d'abord.

### Mettre en pause, modifier, supprimer

[Mettre une routine en pause : « Configurer », l'interrupteur « Active », « Enregistrer »](../media/aide/routines-pause.webm)

1. Choisissez la routine, puis cliquez sur **Configurer**.
2. Dans l'onglet **Général**, basculez l'interrupteur **Active**.
3. Cliquez sur **Enregistrer**.

Une routine en pause porte la mention **En pause** et ne part plus à l'heure prévue. Le même geste la réactive : c'est ainsi que vous mettez en service une routine créée par l'assistant.

**Configurer** sert aussi à tout modifier. Un point devant le titre signale des changements non enregistrés, et quitter le formulaire demande alors confirmation. **Supprimer**, en bas à gauche du formulaire, efface la routine et son journal après confirmation.

### Pour en tirer le maximum

- Dans le chat, la commande `/routine` suivie de votre objectif ouvre directement l'assistant de création, par exemple `/routine résumer les tickets chaque lundi`.
- Écrivez une tâche qui se suffit à elle-même. Pendant une exécution, l'assistant ne peut vous poser aucune question : dites où lire, quoi produire et où l'écrire.
- Pensez aux outils. Une routine créée à la main n'en a aucun : sans **Fichiers** ou **Terminal** dans l'onglet **Outils**, elle ne peut que rédiger un texte.
- Attachez des [skills](#les-skills) dans l'onglet **Outils** pour donner une méthode à la routine, douze au plus. Cocher un paquet embarque tous ses skills.
- Réglez le bruit dans le bloc **Historique** : **Notifications** sur **Échecs seulement** pour une routine fréquente, **Exécutions gardées** et **Notifications gardées** pour borner ce qui est conservé (0 = tout garder).
- Demandez à la routine d'écrire son résultat dans un fichier daté : vous le retrouvez sous **Fichiers produits**, exécution par exécution.
- Essayez une routine avec **Exécuter** avant de vous fier à sa planification.
- Enchaînez deux routines simples plutôt que d'en écrire une compliquée : la seconde **Après** la première, **Si** : **Succès**.
- Au survol de la réponse d'une exécution, **Copier la réponse** la place dans le presse-papiers.

### Comment ça marche

- Une routine travaille seule. Elle ne délègue pas à des sous-agents, même si vous les utilisez dans vos conversations.
- Les exécutions passent après les conversations en direct : elles leur cèdent toujours le passage.
- Une exécution qui échoue dès le départ est retentée une fois, automatiquement.
- Le nombre d'exécutions simultanées par compte est limité, et la longueur d'une chaîne de routines aussi.
- Le contenu reçu par un webhook et le résumé de la routine précédente sont remis à l'assistant comme des données, jamais comme des consignes : c'est la tâche de la routine qui dit quoi en faire.
- Le journal garde les 4 000 premiers caractères de chaque réponse.

## Vos documents (RAG)
<!-- aide: rag -->

Le RAG laisse l'assistant répondre à partir de **vos documents**, en citant ses sources. Vous rangez des documents dans une collection, vous l'activez dans un chat, et l'assistant y cherche les passages utiles avant de répondre.

> Le RAG n'apparaît que si votre administrateur l'a mis en place ; il peut le réserver à certains groupes. Si l'entrée **RAG** est absente, demandez à votre administrateur.

[Ouvrir la page RAG et créer une première collection](../media/aide/rag-collection.webm)

### L'essentiel

1. Dans la barre latérale, ouvrez **Plus**, puis **RAG**.
2. Cliquez sur **Nouvelle collection**, donnez-lui un nom, puis cliquez sur **Créer**.
3. Cliquez sur **Ajouter des documents** et choisissez vos fichiers. Attendez l'état **Prête**.
4. Cliquez sur **Discuter avec** : un chat s'ouvre, la collection déjà active.
5. Posez votre question. La réponse porte des pastilles numérotées : chacune mène au passage cité.

### Créer une collection

Une collection regroupe des documents sur un même sujet. La page RAG liste à gauche **Mes collections**, puis **Partagées avec moi**, et affiche en bas l'espace que vous occupez.

- À la première visite, la page affiche **Créez votre première collection**. Ensuite, le bouton **Nouvelle collection** se trouve en haut à droite.
- La **Description** est facultative, mais l'assistant la lit pour savoir quand chercher dans cette collection. Une phrase précise suffit.
- Vous pouvez aussi glisser des fichiers sur la page vide : la fenêtre **Nouvelle collection** s'ouvre avec un nom proposé, et les fichiers sont déposés dès que vous cliquez sur **Créer**.

### Ajouter des documents et suivre l'indexation

[Déposer des fichiers et suivre leur indexation jusqu'à l'état Prête](../media/aide/rag-documents.webm)

1. Ouvrez la collection, onglet **Documents**.
2. Cliquez sur **Ajouter des documents**, ou glissez des fichiers ou un dossier dans la zone du bas.
3. Un encadré liste chaque fichier déposé : **Ajouté**, **Déjà présent** (même contenu : il est ignoré) ou **Refusé** avec sa raison.
4. Un bandeau suit l'indexation. **Suspendre** la met en pause, **Annuler** l'arrête en gardant les documents déjà indexés.

Chaque ligne du tableau montre la bande de ses passages et son état : **En attente**, **Extraction…**, **Indexation…**, puis **Prête**. Un échec affiche sa raison, par exemple **Sans texte : activez l'OCR** ou **Protégé par un mot de passe**.

- Formats acceptés : PDF, Word (docx), PowerPoint (pptx), Excel (xlsx), HTML, Markdown, texte, CSV, JSON et YAML.
- Limites par défaut : 2 Go au total, 10 collections, 200 Mo par fichier, 2 000 documents par collection. L'administrateur peut les changer.
- **Importer depuis la sandbox** ajoute des fichiers de votre sandbox : cochez-les, puis cliquez sur **Importer**. Voir [La sandbox et l'éditeur de code](#la-sandbox-et-léditeur-de-code).
- Au survol d'une ligne, quatre icônes apparaissent : régler le découpage du document, le réindexer, ouvrir l'original, le retirer.
- **Filtrer les documents** cherche par nom ; **Tous les états** ne garde que les documents **Prêts**, **En cours**, **En attente** ou **En échec**.

### Tester une collection

[Poser une question dans l'onglet Tester et lire les passages trouvés](../media/aide/rag-tester.webm)

L'onglet **Tester** montre ce que l'assistant trouverait, sans ouvrir de chat.

1. Ouvrez l'onglet **Tester** et tapez une question, comme dans une conversation.
2. Cliquez sur **Chercher**, ou appuyez sur `Entrée`.
3. **Où se trouvent les passages** dessine une bande par document : les cases numérotées sont les passages retenus, par ordre de pertinence.
4. **Ce que l'assistant recevra** liste ces passages, les mots de votre question surlignés, avec leur coût estimé en jetons.

Trois modes de recherche : **Mixte** (le sens et les mots, par défaut), **Par le sens**, **Mots exacts**. **Passages** règle le nombre de passages retenus. **Reclasser** n'est actif que si l'administrateur a configuré cette option.

### Le menu et les réglages d'une collection

Le bouton **⋯** de l'en-tête propose **Importer depuis la sandbox**, **Ajouter un dossier…**, **Réindexer tous les documents**, **Réglages** et **Supprimer la collection…**.

L'onglet **Réglages**, réservé au propriétaire, contient :

- **Nom** et **Description** ;
- **Découpage** : la méthode (**Automatique** convient à la plupart des fichiers) et la taille des passages. Un changement demande une confirmation, puis réindexe les documents ;
- **OCR des documents scannés** : à activer pour lire les PDF sans texte. L'interrupteur reste grisé si l'administrateur n'a pas prévu cette lecture ;
- **Zone de danger** : **Vider…** supprime les documents et garde la collection ; **Supprimer…** efface tout, après saisie du nom.

### Publier une collection

[Publier une collection aux membres d'un groupe](../media/aide/rag-publier.webm)

1. Cliquez sur **Publier…**.
2. Choisissez **Groupes**, puis cochez un ou plusieurs groupes dont vous êtes membre. La fenêtre indique combien de comptes y auront accès.
3. Cliquez sur **Publier**. La pastille **Privée** de l'en-tête prend le nom du groupe.

- Les comptes qui gagnent l'accès reçoivent une notification. Ils peuvent interroger la collection, pas la modifier.
- **Ouvrir les documents sources** décide s'ils peuvent ouvrir vos fichiers d'origine. Sans cette option, ils ne voient que les passages trouvés.
- **Tous les comptes** n'est proposé qu'aux administrateurs.
- Pour dépublier, rouvrez **Publier…**, choisissez **Privée**, puis **Rendre privée**.

Une collection publiée par un autre compte apparaît sous **Partagées avec moi**, en **Lecture seule**. Vous pouvez la consulter (onglets **Documents** et **Tester**), l'utiliser avec **Discuter avec**, ou la retirer de votre liste avec **Masquer de ma liste**. **Afficher les masquées**, en bas de la liste, la fait revenir.

L'administrateur voit le nom, l'auteur et la taille de toutes les collections et peut en supprimer une. Il ne lit jamais le contenu d'une collection qui ne lui est pas ouverte.

### Interroger une collection dans le chat

[Discuter avec une collection et obtenir une réponse sourcée](../media/aide/rag-chat.webm)

**Discuter avec** ouvre un chat neuf, la collection déjà active. Les collections actives s'affichent en pastilles au-dessus de la barre de saisie ; la croix d'une pastille la retire. Sans collection active, l'assistant ne cherche dans aucun document.

Dans un chat déjà ouvert, la commande `/rag` fait le reste.

[Activer une collection dans un chat avec la commande /rag use](../media/aide/rag-commande.webm)

| Commande | Effet |
|---|---|
| `/rag use <collection>` | Interroger cette collection dans ce chat. Le menu liste les vôtres, puis celles partagées avec vous |
| `/rag off` | Ne plus interroger de collection |
| `/rag search <question>` | Montrer les passages trouvés dans le fil, sans réponse de l'assistant |
| `/rag add <collection>` | Indexer les fichiers joints, ou les fichiers de la sandbox cités avec `@`, dans une de vos collections |
| `/rag new <nom>` | Créer une collection avec les fichiers joints |
| `/rag status` | Voir les indexations en cours |
| `/rag open [collection]` | Ouvrir la page RAG |

### Lire les sources d'une réponse

[Survoler une source, puis ouvrir le document à l'endroit du passage](../media/aide/rag-sources.webm)

- Dans la réponse, chaque renvoi est une pastille numérotée. Au survol, ou au clavier, une bulle montre le document, la page, la section, la collection, l'extrait avec les mots de votre question surlignés, et la pertinence.
- Sous la réponse, le pied de sources liste les documents cités. Le lien **N passages lus, non cités** déplie ce que l'assistant a lu sans le retenir.
- **Voir dans le document** ouvre un volet à droite. **Page** montre la page réelle, le passage surligné à son emplacement ; **Texte** montre le texte extrait, avec les passages voisins.
- Dans ce volet, les flèches et les numéros passent d'une source citée à l'autre. Une bande indique où se trouvent les passages dans le document.
- Le bouton qui ouvre l'original n'apparaît que si vous y avez droit. Pour une collection partagée sans ouverture des sources, seul le passage cité est visible.

### Pour en tirer le maximum

- Soignez la **Description** : c'est elle qui dit à l'assistant quand chercher dans la collection.
- Passez par **Tester** avant de discuter. Comparez les trois modes et regardez le coût en jetons : si les bons passages ne remontent pas, reformulez la question ou revoyez le découpage.
- Répétez `/rag use` pour interroger plusieurs collections dans le même chat.
- `/rag search` vérifie ce que contiennent vos documents sans attendre une réponse rédigée.
- Depuis un chat, joignez des fichiers avec le bouton **+** (5 Mo au plus), puis lancez `/rag add` ou `/rag new` : les fichiers sont indexés sans quitter la conversation.
- Survolez la pastille d'une collection, au-dessus de la barre de saisie, pour relire sa description.
- Un document en échec se relance à part, avec son icône de réindexation : inutile de tout réindexer.

### Comment ça marche

Chaque document déposé est lu (texte, titres, tableaux, pages), puis découpé en passages. Chaque passage est indexé par son sens et par ses mots. Quand la question le demande, l'assistant cherche les passages utiles dans les collections actives, lit au besoin leurs voisins, puis répond en citant chaque passage par son numéro.

Les passages restent des **données** : l'assistant ne suit pas les consignes qu'un document contiendrait. Un passage tiré de la collection d'un autre compte porte le nom de son auteur. Quand un compte est supprimé, ses collections le sont aussi : ceux qui les lisaient sont prévenus, et les réponses déjà données gardent leurs extraits, sans pouvoir rouvrir le document.

## Les skills
<!-- aide: skills -->

Un **skill** est une procédure écrite en Markdown : *comment* faire quelque chose de concret avec vos outils à vous, par exemple déployer en préproduction ou rédiger un compte rendu d'incident. L'assistant suit la procédure au lieu d'improviser les étapes.

[Épingler un skill au prochain message avec /skills](../media/aide/skills-epingler.webm)

### L'essentiel

1. Dans la barre de saisie, tapez `/skills`, puis appuyez sur `Entrée`.
2. Choisissez un skill dans la liste. Quelques lettres suffisent à la filtrer.
3. Le skill s'affiche en pastille au-dessus de la saisie.
4. Écrivez votre demande et envoyez : l'assistant reçoit la procédure avec votre message.

L'épingle vaut pour **le prochain message** seulement. La croix de la pastille la retire avant l'envoi.

Vous n'êtes pas obligé d'épingler : l'assistant connaît la liste de vos skills et peut ouvrir de lui-même celui qui correspond à la demande. Épingler garantit qu'il part de la bonne procédure.

### Parcourir la bibliothèque

[Passer de Global à Perso et ouvrir le détail d'un skill](../media/aide/skills-bibliotheque.webm)

1. Ouvrez Paramètres (la roue dentée, en bas de la barre latérale) › **Skills**.
2. Choisissez une partie : **Global**, la bibliothèque commune à tous les comptes, ou **Perso**, vos skills.
3. Cliquez sur un skill pour ouvrir son détail : description, tags, puis le **Corps**, la procédure elle-même.
4. **← Skills** revient à la liste.

- **Filtrer les skills…** cherche dans le nom, la description, le domaine et les tags. Si le résultat se trouve dans l'autre partie, un lien l'indique et vous y mène.
- Dans le détail, **Rendu** affiche la procédure mise en forme, **Source** son texte brut.
- Un skill peut embarquer des fichiers et des scripts. Un trombone le signale ; la flèche à gauche de son nom déplie ses fichiers.
- Un skill rangé dans un domaine apparaît dans un dossier à ce nom, à déplier.

### Créer un skill

[Créer un skill personnel avec le formulaire Nouveau](../media/aide/skills-creer.webm)

1. Dans Paramètres › **Skills**, cliquez sur **Nouveau**.
2. Donnez un **Nom** court, en minuscules avec des tirets, par exemple `prise-astreinte`.
3. Remplissez la **Description** : dites quand et pourquoi utiliser ce skill.
4. Écrivez la procédure dans **Corps (markdown)** : des étapes numérotées, les commandes exactes, les pièges.
5. Cliquez sur **Créer**. Le skill apparaît dans **Perso**.

- **Domaine (optionnel)** et **Tags** servent à ranger et à retrouver vos skills.
- **Assistant** ouvre une conversation qui crée le skill avec vous : l'assistant pose les questions, rédige la procédure et l'enregistre.
- Dans le détail d'un de vos skills, **Éditer** le modifie et **Supprimer** l'efface. Les skills de **Global** ne se modifient pas depuis un compte ordinaire.

### Importer et exporter

- **Importer** accepte trois formes : **Archive .zip**, **Dossier de skill** (le fichier `SKILL.md` et ses fichiers joints) ou **Fichier SKILL.md** seul. Vous pouvez aussi glisser l'un d'eux sur l'onglet.
- **Exporter .zip**, dans le détail d'un skill, le télécharge avec ses fichiers. C'est le moyen de le passer à un collègue ou de le garder de côté.

### Les skills « Learned »

Dans **Global**, un groupe **Learned** peut apparaître. Ce sont des brouillons en attente de relecture par un administrateur. L'assistant ne s'en sert pas tant qu'ils ne sont pas validés. Seul un administrateur peut les créer, les modifier ou les faire passer dans la bibliothèque commune.

### Pour en tirer le maximum

- Le bouton **+** de la barre de saisie propose aussi **Skills**, sous **Insérer** : cochez-en plusieurs d'un coup.
- Si ce que vous tapez après `/` ne correspond à aucune commande, le menu cherche directement dans les skills : `/` suivi des premières lettres d'un nom suffit souvent à le trouver.
- Soignez la **Description** d'un skill : c'est elle que l'assistant lit pour décider de l'ouvrir. Mettez-y les mots que vous emploierez dans vos demandes.
- Un skill personnel qui porte le même nom qu'un skill de **Global** le remplace pour vous.
- Écrivez un skill dès que vous expliquez la même procédure pour la deuxième fois. Le bouton **Assistant** le fait en quelques questions.
- `/settings skills` ouvre directement la bibliothèque depuis le chat.

### Comment ça marche

Les skills sont la mémoire des procédures. Ils complètent deux autres mémoires :

| Mémoire | Contenu |
|---|---|
| [La mémoire](#la-mémoire) | Des **faits** : votre profil, votre environnement, vos décisions |
| La liste de tâches d'une conversation | Les **étapes** du travail en cours |
| **Les skills** | **Comment faire** une tâche précise |

À chaque message, l'assistant reçoit la liste de vos skills, avec leur nom et leur description. Quand une demande correspond à l'un d'eux, il peut en ouvrir le contenu avant d'agir. Il peut aussi lire les fichiers joints à un skill et lancer ses scripts. Un skill épinglé, lui, est joint d'office au message.

## La mémoire
<!-- aide: memoire -->

La mémoire long terme garde ce que l'assistant apprend de vous d'une conversation à l'autre : votre rôle, vos préférences, les faits durables de votre environnement. Vous n'avez plus à les répéter à chaque nouveau chat.

Elle est **désactivée par défaut** : rien n'est retenu tant que vous ne l'avez pas activée.

[Ouvrir la mémoire long terme avec /memory](../media/aide/memoire.webm)

### L'essentiel

1. Dans la barre de saisie, tapez `/memory`, puis appuyez sur `Entrée`. Vous pouvez aussi ouvrir Paramètres › **Mémoire**.
2. Allumez l'interrupteur **Activer la mémoire long-terme**.
3. Discutez normalement. Quand vous donnez une information durable, l'assistant la note.
4. Revenez dans **Mémoire** pour relire, corriger ou effacer ce qu'il a retenu.

La page a deux parties :

- **Profil utilisateur** : qui vous êtes, votre rôle, vos préférences, votre façon de travailler.
- **Notes** : les faits sur votre environnement, vos projets, les décisions prises.

### Ce que l'assistant retient, vu depuis le chat

[L'assistant retient un fait : la ligne Mémorisé, dépliée, permet de l'annuler](../media/aide/memoire-chat.webm)

Chaque écriture en mémoire laisse une ligne dans la réponse : **Mémorisé**, suivie de **profil utilisateur** ou de **notes projet** et du texte retenu. Selon le cas, la ligne indique aussi **Mémoire mise à jour**, **Retiré de la mémoire** ou **Mémoire réorganisée**.

1. Cliquez sur la ligne pour la déplier : vous voyez exactement ce qui a été ajouté ou retiré.
2. **Annuler** défait cette écriture.
3. **Gérer la mémoire** ouvre la page **Mémoire** des paramètres.

Vous pouvez demander une mémorisation en clair, par exemple « Retiens que l'astreinte change le lundi ». L'assistant note aussi de lui-même ce qui lui paraît durable.

### Relire et corriger

[Ajouter une entrée à la mémoire avec Éditer, puis Enregistrer](../media/aide/memoire-editer.webm)

Sous chaque entrée, une ligne indique sa date et son origine : **Paramètres** si vous l'avez écrite, ou le titre de la conversation où l'assistant l'a apprise. Ce titre est un lien vers la conversation, tant qu'elle existe.

1. Cliquez sur **Éditer**. Chaque entrée devient un champ de texte.
2. Corrigez le texte, cliquez sur **Ajouter** pour une nouvelle entrée, ou sur la corbeille pour en retirer une.
3. Cliquez sur **Enregistrer**. **Annuler** abandonne vos changements.

**Rafraîchir** relit la mémoire, par exemple après une conversation ouverte dans une autre fenêtre.

### Tout effacer

En bas de la page, **Effacer tout** supprime définitivement tout ce que l'assistant a retenu, après confirmation. Cette action est irréversible.

Désactiver l'interrupteur ne supprime rien : l'assistant cesse seulement de lire et d'écrire la mémoire.

### Pour en tirer le maximum

- Écrivez vous-même votre profil dès l'activation : votre métier, votre niveau, le ton et le format de réponse que vous préférez. Les premières réponses en tiennent compte.
- Les compteurs à droite de chaque partie, par exemple `133 / 1375`, montrent la place utilisée. Quand une partie est pleine, l'assistant doit regrouper ou retirer des notes avant d'en ajouter : la ligne affiche alors **Mémoire pleine**. Faites le tri vous-même avec **Éditer**.
- Relisez la mémoire de temps en temps. Une note fausse ou périmée oriente toutes les conversations suivantes.
- Quand la mémoire est active, l'assistant peut aussi chercher dans vos conversations passées. Demandez-lui « qu'avions-nous décidé sur le format des journaux ? ».
- Une information à retenir pour une procédure entière a plutôt sa place dans un skill : voir [Les skills](#les-skills).
- `/settings memory` ouvre la même page que `/memory`.

### Comment ça marche

L'assistant relit les deux parties de la mémoire dans toutes les conversations qui suivent. Leur taille est volontairement limitée : une mémoire qui grossit sans fin n'aide plus. C'est ce qui pousse l'assistant à regrouper ses notes au lieu de les empiler.

La mémoire est propre à votre compte. L'administrateur peut la couper pour toute l'application : si l'assistant ne retient rien alors que l'interrupteur est activé, demandez à votre administrateur.

## Les prompts
<!-- aide: prompts -->

Un prompt sauvegardé est une demande que vous réutilisez : une consigne de relecture, la trame d'un compte rendu, un modèle de courriel. Vous le gardez sous un titre et vous le réinsérez en quelques touches. Un gabarit va plus loin : c'est un prompt à trous, dont l'application vous demande les valeurs.

[Sauvegarder un prompt depuis un message, puis le réinsérer avec /prompt](../media/aide/prompts-sauvegarder.webm)

### L'essentiel

1. Dans une conversation, survolez l'un de vos messages.
2. Cliquez sur le signet **Sauvegarder**, en haut à droite du message.
3. Donnez un titre, puis cliquez sur **Valider**.
4. Plus tard, tapez `/prompt` dans la barre de saisie, puis appuyez sur `Entrée`.
5. Choisissez le prompt : son texte arrive dans la saisie.

Un prompt est toujours **inséré, jamais envoyé** : vous relisez, vous complétez, puis vous envoyez.

### Retrouver un prompt

Trois chemins mènent à vos prompts :

- **`/prompt`** liste vos prompts et ceux que vous avez reçus. Tapez quelques lettres pour filtrer sur le titre et le contenu. Le prompt choisi remplace ce qui se trouve dans la saisie.
- **Le bouton + de la barre de saisie**, puis **Prompts** sous **Insérer**. Le prompt choisi s'ajoute à la suite de ce que vous avez déjà écrit.
- Paramètres › **Prompts** affiche la liste complète, avec la date de sauvegarde.

Dans Paramètres › **Prompts** :

- Cliquez sur une ligne pour déplier le contenu entier.
- **Rechercher un titre ou un contenu…** ignore les accents : « resume » trouve « résumé ».
- Triez par **Plus récents**, **Plus anciens** ou **Titre A→Z**.
- Au survol d'une ligne, cinq boutons apparaissent : **Insérer** l'envoie dans la saisie du chat, **Copier** le met dans le presse-papier, **En faire un template** en tire un gabarit, **Partager** l'envoie à d'autres comptes, **Supprimer** l'efface.

Le contenu s'affiche tel quel. Un prompt est un texte source : son Markdown n'est pas interprété, les `#`, les `**` et les blocs de code restent visibles, et **Copier** les récupère intacts.

### Partager un prompt et lire ceux qu'on vous envoie

Pour partager :

1. Dans Paramètres › **Prompts**, survolez le prompt et cliquez sur **Partager**.
2. Dans la fenêtre **Transférer**, cochez les destinataires. Les pastilles **Groupe :** réduisent la liste à un groupe ; **Sélectionner tous les membres visibles** coche toute la liste affichée.
3. Cliquez sur **Envoyer**.

Pour lire ce que vous recevez :

1. Une pastille rouge sur le bouton **+** de la barre de saisie indique le nombre de partages reçus.
2. Cliquez sur **+**, puis sur **Partages reçus**. Chaque partage montre son titre, son expéditeur et son texte.
3. Cliquez sur un partage pour l'insérer dans la saisie.

Dans ce panneau, la corbeille d'un partage le supprime, **Sélectionner** permet d'en supprimer plusieurs, et **Vider** les supprime tous.

### Les gabarits

Un gabarit est un prompt à trous, appelé par un raccourci. Le chat les appelle **Gabarits**, la page des paramètres **Templates** : ce sont les mêmes objets.

[Insérer un gabarit avec /template et remplir ses champs](../media/aide/prompts-template.webm)

1. Tapez `/template`, puis appuyez sur `Entrée`.
2. Choisissez un gabarit dans la liste. Si vous connaissez son raccourci, tapez-le directement : `/template resume`.
3. Si le gabarit contient des champs, une fenêtre les demande. Remplissez-les.
4. Cliquez sur **Insérer**, ou appuyez sur `Entrée`. `Échap` annule.
5. Le texte complet arrive dans la saisie, sans être envoyé.

Le bouton **+** de la barre de saisie donne aussi accès aux gabarits, sous **Insérer** › **Gabarits**.

#### Créer un gabarit

1. Ouvrez Paramètres › **Prompts** › **Templates**, puis cliquez sur **Nouveau**.
2. Remplissez le **Titre** et le **Raccourci**. Le raccourci n'accepte que des minuscules, des chiffres, `-` et `_`, sans espace ; il est proposé à partir du titre.
3. Écrivez le **Contenu**, avec ses variables entre doubles accolades.
4. Vérifiez sous le contenu la ligne **Variables** : elle liste les champs reconnus.
5. Cliquez sur **Enregistrer**.

Deux raccourcis : **En faire un template**, sur la ligne d'un prompt sauvegardé, reprend son titre et son texte ; la dernière entrée du menu `/template`, **Nouveau gabarit**, ouvre le même formulaire.

#### Écrire les variables

Une variable s'écrit `{{nom}}`. Ses options se placent **après une barre verticale**, séparées par des deux-points.

| Dans le contenu | Effet |
|---|---|
| `{{client}}` | Champ de texte. Un même nom répété n'est demandé qu'une fois |
| `{{notes \| textarea}}` | Zone de plusieurs lignes |
| `{{ton \| select:options=["neutre","formel"]}}` | Liste de choix |
| `{{client \| placeholder="ex. la direction"}}` | Exemple affiché dans le champ vide |
| `{{langue \| default="français"}}` | Valeur proposée, modifiable |
| `{{client \| required}}` | Champ obligatoire |
| `{{date}}` `{{heure}}` `{{date_heure}}` `{{jour}}` `{{utilisateur}}` | Remplies automatiquement |
| `{{presse_papier}}` | Contenu du presse-papier. S'il est illisible, un champ vous demande de le coller |

Les options se combinent : `{{notes | textarea:placeholder="Collez vos notes":required}}`. Sans la barre verticale, la variable n'est pas reconnue et reste écrite telle quelle dans le texte.

Les noms anglais `{{CURRENT_DATE}}`, `{{USER_NAME}}` et `{{CLIPBOARD}}` sont aussi reconnus : un gabarit qui les emploie fonctionne tel quel.

### Pour en tirer le maximum

- Pour compléter un texte déjà commencé, passez par **+** › **Prompts** : le prompt s'ajoute à la suite. `/prompt` remplace le contenu de la saisie.
- Sauvegardez un message juste après une réponse qui vous a convenu : le signet garde la demande telle que vous l'avez envoyée.
- Dès qu'une partie d'un prompt change à chaque usage, faites-en un gabarit avec **En faire un template** et remplacez cette partie par une variable.
- Mettez `{{presse_papier}}` dans un gabarit de relecture ou de résumé : copiez le texte à traiter, lancez le gabarit, tout est prêt.
- Une liste de choix évite les fautes de frappe sur les valeurs qui reviennent : ton, langue, longueur.
- Un prompt dit **quoi** demander. Pour apprendre à l'assistant **comment** faire une tâche, écrivez plutôt un skill : voir [Les skills](#les-skills).
- `/settings prompts` ouvre la page des prompts depuis le chat.

## Le Studio
<!-- aide: studio -->

Le Studio pilote l'écran d'une autre machine, Windows ou Linux, depuis l'application. Vous voyez son écran, vous agissez sur ses boutons et ses champs, et vous en tirez des automatisations rejouables. Il sert, par exemple, à automatiser une application qui n'offre que son interface.

Le Studio a besoin d'une **machine cible**, déclarée par votre administrateur. Sans elle, la page affiche « Aucune machine cible configurée » : demandez à votre administrateur.

[Capturer l'écran d'une machine cible, puis cliquer un élément à distance](../media/aide/studio.webm)

### L'essentiel

1. Dans la barre latérale, ouvrez **Plus** puis **Studio**.
2. Choisissez la machine dans la liste **Choisir une cible…**, en haut à droite.
3. Cliquez sur **Capturer**. L'écran de la machine s'affiche ; chaque élément reconnu est encadré.
4. Cliquez un élément. Un menu propose les actions : **Clics** puis **Cliquer** envoie le clic à la machine.
5. La capture se rafraîchit : vous voyez le résultat.

Vous pouvez aussi demander l'action en français dans l'onglet **Assistant**, à droite : « ouvre le menu Fichier », « clique sur Enregistrer ».

### Simple ou Expert

Deux boutons en haut de la page règlent le niveau d'outillage.

- **Simple** : la cible, la capture, l'assistant et le script. C'est le niveau de départ.
- **Expert** : tous les outils. Les modes **Inspecter**, **Zone** et **Glisser**, les **Plans** et l'**Arbre** des éléments apparaissent.

### Capturer l'écran

- **Capturer** prend une image de la machine et relève ses éléments. Le témoin **LIVE** signale une image fraîche.
- La flèche à côté de **Capturer** ouvre **Lire (OCR)**, qui lit le texte visible, et **Vider**, qui efface la scène.
- La roue dentée ouvre les réglages de capture. **Annoter par vision** fait encadrer les éléments par le modèle de vision ; éteint, la capture s'accompagne de l'arbre d'éléments de la machine, plus rapide. **Quoi annoter ?** limite l'annotation à ce que vous décrivez. **Écran capturé / piloté** choisit l'écran quand la machine en a plusieurs.

### Agir sur un élément

Cliquez un cadre : le menu s'ouvre sur cet élément. Son nom et son rôle sont rappelés en tête.

- **Clics** : **Cliquer**, **Double-cliquer**, **Triple-cliquer**, **Clic droit**, **Clic milieu**.
- **Contrôle (fiable)** : **Cocher**, **Décocher**, **Sélectionner (liste/onglet)**, **Déplier**, **Replier**, **Définir la valeur…**. L'action passe par l'élément lui-même, pas par ses coordonnées.
- **Saisie** : **Taper…**, **Coller…**, **Copier**.
- **Touches** : les raccourcis clavier courants.
- **Souris** : **Survoler (déplacer)**, **Glisser-déposer depuis ici…**, défilement.
- **Lecture** : **Lire (OCR) la zone** et **Demander au modèle…**.

Un clic droit ailleurs sur la capture ouvre le même menu pour le point visé. Sous la capture, une barre montre l'élément choisi, ses parents et la façon dont un script le désignera.

En **Expert**, trois modes s'ajoutent près du titre : **Inspecter** pour survoler et cliquer, **Zone** pour tracer un rectangle à lire ou à soumettre au modèle, **Glisser** pour un glisser-déposer. **Plans** n'affiche que certaines fenêtres. L'**Arbre** liste tous les éléments, avec un filtre, un **Audit** des contrôles sans nom ni identifiant, et un export CSV.

### Écrire une automatisation

L'onglet **Script** transforme vos gestes en un script Python, rejouable sur la machine.

1. Ouvrez l'onglet **Script** et donnez un **Nom du script**.
2. Cliquez sur **Enregistrer**, à gauche du nom : le bouton passe en **REC**. Chaque action faite sur la capture s'écrit dans le code, au curseur.
3. Complétez avec les blocs : dans l'onglet **Script**, le menu d'un élément gagne une entrée **Script** (**Si présent…**, **Si absent…**, **Répéter**, **Attendre l'élément**, **Vérifier présent**, **Lire sa valeur (variable)**, **Note…**).
4. Cliquez sur le second **Enregistrer**, marqué d'une disquette : le script est rangé dans votre sandbox, dossier `automations`.
5. Cliquez sur **Exécuter** pour le lancer sur la machine cible. Un rapport liste chaque étape.

La flèche à côté d'**Exécuter** offre trois autres modes :

- **Essai sans action** : le script cherche chaque élément sur la machine, sans rien cliquer ni taper.
- **Exécuter avec trace** : une capture à chaque étape, à revoir dans le rapport.
- **Sur plusieurs machines** : cochez les cibles, puis **Lancer la matrice**.

Le script se télécharge seul, ou avec ce qu'il faut pour tourner hors de l'application.

### Pour en tirer le maximum

- **Composer par l'IA**, dans l'onglet **Assistant** : décrivez l'objectif. L'assistant agit pas à pas et chaque action réussie devient une ligne du script.
- Préférez **Contrôle (fiable)** aux clics quand l'élément le permet : le script retrouve une case ou une liste même si la fenêtre a bougé. Dans le script, un geste par coordonnées est le plus fragile.
- Lancez toujours un **Essai sans action** avant une vraie exécution : il révèle les éléments introuvables sans toucher à la machine.
- Laissez **Annoter par vision** éteint tant que l'application cible expose ses éléments : la capture est plus rapide. Activez-le pour une application qui n'en expose aucun.
- Dans **Quoi annoter ?**, appuyez sur `Entrée` pour capturer aussitôt avec votre description.
- Quand une étape échoue, le rapport en montre la capture. Vous pouvez demander au modèle une ligne de remplacement depuis le rapport.
- La barre du script a un aide-mémoire des instructions disponibles et un bouton pour copier le code.
- En **Expert**, lancez l'**Audit** de l'arbre avant d'automatiser une application : il liste les boutons sans nom ni identifiant, ceux qu'un script aura du mal à retrouver.

### Comment ça marche

Un petit programme de contrôle tourne sur la machine cible. Il envoie des captures et la liste des éléments de l'écran, et exécute les gestes que vous ou l'assistant demandez. Les machines que vous pouvez piloter sont choisies par votre administrateur.

Un script désigne ses éléments par leur identifiant, à défaut par leur nom et leur rôle, et en dernier recours par leurs coordonnées. Plus la désignation est précise, mieux le script résiste aux changements de l'écran.

## Notifications
<!-- aide: notifications -->

La cloche, en bas de la barre latérale, vous signale ce qui s'est terminé sans vous : une routine, l'indexation de vos documents, une collection partagée avec vous.

[Une routine se termine : le message, la pastille de la cloche, puis la routine ouverte depuis sa notification](../media/aide/notifications.webm)

### L'essentiel

1. Quand une notification arrive, un message s'affiche en bas à droite et une pastille rouge sur la cloche compte les notifications non lues.
2. Cliquez sur la cloche. La liste s'ouvre, rangée par date : **Aujourd'hui**, **Hier**, **Cette semaine**, **Plus ancien**.
3. Cliquez sur une notification pour aller à sa source. Celle d'une routine ouvre la page [Routines](#les-routines) sur cette routine et son journal.

Ouvrir la liste marque tout comme lu : la pastille disparaît.

### Ce que vous recevez

- La fin d'une [routine](#les-routines), réussie ou en échec, selon le réglage **Notifications** de cette routine.
- La fin de l'indexation d'une collection de [documents](#vos-documents-rag), une collection partagée avec vous, une collection qui n'est plus disponible.
- Pour les administrateurs et les modérateurs, le rapport d'usage quotidien.

La réponse d'une conversation que vous avez quittée pendant qu'elle s'écrivait s'annonce autrement : un message « réponse prête » avec le bouton **Ouvrir**. Elle n'est pas gardée dans la cloche.

### Gérer la liste

- Au survol d'une notification, deux boutons apparaissent : **Marquer comme non lu** (ou **Marquer comme lu**) et **Supprimer**.
- **Tout lu** marque toute la liste comme lue.
- **Effacer** vide la liste. Un message propose **Annuler** pendant quelques secondes.
- **Voir plus**, en bas d'une longue liste, charge les notifications plus anciennes.

### Pour en tirer le maximum

- Le bouton **Voir** du message d'arrivée mène droit à la source, sans passer par la cloche.
- Une routine fréquente peut noyer la liste. Dans son onglet **Général**, bloc **Historique**, réglez **Notifications** sur **Échecs seulement** ou **Aucune**, et bornez **Notifications gardées**.
- Pour être prévenu hors de l'application, activez **Notifications système** dans Paramètres › **Chat** › **Conversation**. Votre système affiche alors une notification (fin d'une routine, rapport) quand la fenêtre n'est pas au premier plan. Le réglage vaut pour ce navigateur seulement, qui vous demande son accord la première fois. Si l'interrupteur est grisé, votre navigateur ou la connexion ne le permet pas : demandez à votre administrateur.
- Quand l'onglet de l'application est en arrière-plan, son titre affiche le nombre de notifications non lues entre parenthèses.

# Réglages

## Paramètres
<!-- aide: parametres -->

Les Paramètres rassemblent les réglages de votre compte : profil, apparence, comportement du chat, fonctions actives, accès. Ils ne valent que pour vous. La plupart sont enregistrés dès que vous les changez.

[Ouvrir les Paramètres et trouver un réglage par la recherche](../media/aide/parametres-recherche.webm)

### L'essentiel

1. Cliquez sur la roue dentée **Paramètres**, en bas de la barre latérale.
2. Choisissez un onglet dans le rail de gauche. Les onglets les plus fournis se divisent en parties, dans un bandeau en haut du contenu.
3. Changez le réglage. Le message **Enregistré** confirme l'écriture ; son bouton **Annuler** remet la valeur précédente.
4. Fermez par la croix ou par `Échap`.

Les formulaires ont leur propre bouton : le mot de passe (**Mettre à jour**), la mémoire (**Enregistrer**), un secret (**Créer**), un compte Git (**Ajouter**).

### Trouver un réglage

Le champ **Rechercher** est en haut du rail.

1. Tapez un mot : `sombre`, `quota`, `jeton`, `mot de passe`.
2. Le rail ne garde que les onglets concernés.
3. Cliquez l'onglet : il s'ouvre sur la bonne partie.

La recherche ignore les accents et connaît les anciens noms des onglets. Si rien ne correspond, le rail affiche **Aucun réglage trouvé.**

### Les onglets

Le rail range les onglets en quatre groupes ; chaque onglet est détaillé dans la section indiquée.

- **Général** : **Profil** (photo et mot de passe, voir plus bas) ; **Apparence** (voir [Apparence](#apparence)) ; **Chat**, avec trois parties : **Conversation** (**Prompt système**, **Largeur** du fil, **Terminal en direct**, réveil des tâches de fond, **Notifications système**, **Effacer les conversations**), **Affichage** et **Voix** ; **Fonctionnalités**, avec **Modules**, **Images** et **Éditeur**.
- **Assistant** : **Modèles IA**, **Prompts**, **Skills** et **Mémoire**. Voir [Modèles et fournisseurs](#modèles-et-fournisseurs), [Les prompts](#les-prompts), [Les skills](#les-skills) et [La mémoire](#la-mémoire).
- **Accès** : **Secrets**, avec **Secrets web**, **Comptes Git** et **Jetons MCP**. Voir [Secrets et comptes Git](#secrets-et-comptes-git).
- **Avancé**, replié : cliquez dessus pour voir **Compaction** (voir [Le contexte de la conversation](#le-contexte-de-la-conversation)), **Sandbox** (voir [La sandbox et l'éditeur de code](#la-sandbox-et-léditeur-de-code)), **Archives** (voir [Les conversations](#les-conversations)) et **Utilisation**.

Paramètres › **Fonctionnalités** › **Modules** active ou coupe **MCP** (tous les outils de l'assistant), **Images**, **Sandbox** (le panneau de code) et **Créer des routines** (l'assistant peut enregistrer une routine, toujours en pause, après votre accord). Les parties **Images** et **Éditeur** n'apparaissent que si la fonction est disponible et active.

Paramètres › **Avancé** › **Utilisation** montre vos jetons, conversations, messages et exécutions de routines sur 1, 7, 30 ou 90 jours. Ces données sont agrégées sur place, jamais transmises à l'extérieur.

Les sous-agents n'ont pas d'onglet : ils se règlent dans la page **Agents** du menu **Plus** (voir [Les sous-agents](#les-sous-agents)). Vos serveurs MCP se gèrent dans le [panneau MCP](#les-outils-et-le-panneau-mcp).

### Profil et mot de passe

#### Changer de photo

[Changer sa photo de profil : choisir l'image, la recadrer, valider](../media/aide/parametres-profil.webm)

1. Dans **Profil**, cliquez sur **Photo** et choisissez une image.
2. La fenêtre **Recadrer la photo de profil** s'ouvre. Glissez l'image pour la déplacer. Zoomez à la molette, au curseur, ou avec `+` et `-`.
3. **Remplir** couvre tout le cadre, **Ajuster** montre l'image entière. Les deux flèches la tournent d'un quart de tour.
4. Cliquez sur **Valider**. **Annuler** ou `Échap` referme sans rien envoyer.

La photo remplace vos initiales dans le profil et en bas de la barre latérale. La corbeille à côté de **Photo** la retire.

#### Changer de mot de passe

1. Dans **Profil**, cliquez sur **Mot de passe**.
2. Saisissez le **Mot de passe actuel**, le **Nouveau mot de passe** et la **Confirmation**.
3. Cliquez sur **Mettre à jour**. Le bouton reste éteint tant que les deux saisies diffèrent.

Votre administrateur peut imposer une longueur minimale et certains caractères. Si vous avez oublié votre mot de passe, demandez-lui de le réinitialiser.

### Pour en tirer le maximum

- Tapez `/settings` dans la barre de saisie du chat pour ouvrir les Paramètres sans quitter le clavier. Ajoutez une espace : la liste propose les onglets et les parties, par exemple **Comptes Git** ou **Apparence**.
- Un changement fait par erreur se rattrape tout de suite : cliquez sur **Annuler** dans le message **Enregistré**.
- La fenêtre se rouvre sur la dernière partie consultée de chaque onglet.
- La recherche comprend l'intention, pas seulement le libellé : `photo` mène à **Profil**, `consommation` à **Utilisation**, `git` à **Secrets**.
- Le **Prompt système** et les réglages de génération valent pour toutes vos conversations. Ce que règle la partie **Conversation** est décrit avec chaque fonction : [Quand l'assistant agit](#quand-lassistant-agit) pour **Terminal en direct** et le réveil des tâches de fond, [Notifications](#notifications) pour **Notifications système**.

## Apparence
<!-- aide: apparence -->

L'apparence se règle par compte : mode clair ou sombre, habillage, animations, présentation du fil de discussion. Tout change à l'instant, sans recharger la page.

### L'essentiel

1. Ouvrez [Paramètres](#paramètres) › **Apparence** › **Thème**.
2. Choisissez le **Mode** : **Système**, **Clair** ou **Sombre**.
3. Choisissez un **Habillage** dans la liste.

Chaque choix est enregistré aussitôt. Le message **Enregistré** propose **Annuler** pour revenir en arrière.

### Mode clair, sombre ou système

[Passer du mode clair au mode sombre](../media/aide/apparence-sombre.webm)

- **Clair** et **Sombre** fixent le mode.
- **Système** suit la préférence de votre poste : si celui-ci passe en sombre le soir, l'application le suit.

Le mode s'applique au chat, à la barre latérale et aux fenêtres. L'éditeur de code a son propre thème (voir plus bas).

### Habillages

[Changer d'habillage : toute l'application suit aussitôt](../media/aide/apparence-skin.webm)

Un habillage change les couleurs, les polices et parfois la disposition : **Alizé** est clair et très aéré, **Veilleuse** est pensé pour le soir, **Terminal** affiche tout en chasse fixe.

1. Dans Paramètres › **Apparence** › **Thème**, ouvrez la liste **Habillage**.
2. Choisissez un nom : l'application change tout de suite. Une ligne sous la liste décrit l'habillage.
3. Si l'habillage propose plusieurs palettes, une liste **Couleurs** apparaît. L'habillage Elpis offre **Or** et **Argile**.

La liste montre les habillages que votre administrateur a activés, puis les vôtres. Le nom et l'image de l'assistant sont ceux de l'application : ils sont choisis par l'administrateur.

#### Mes habillages

Vous pouvez avoir vos propres habillages, visibles de vous seul (10 au plus par défaut).

1. Sous la liste, cliquez sur **Créer avec l'assistant**.
2. Décrivez l'ambiance, les couleurs et la base claire ou sombre. L'assistant pose quelques questions, puis répond par un bloc d'habillage.
3. Une carte s'affiche sous le bloc et le vérifie seule : **Valide**, ou le nombre de problèmes (contraste insuffisant, par exemple).
4. **Prévisualiser** montre une maquette en clair et en sombre. **Importer** ajoute l'habillage à votre liste, **Importer et appliquer** l'active aussi.

L'import est toujours votre clic, jamais celui de l'assistant. Il reste éteint tant qu'il y a des problèmes : **Demander une correction** les renvoie à l'assistant. Si le nom existe déjà, l'application propose de le remplacer. Dans **Mes habillages**, **Aperçu** rouvre la maquette et **Supprimer** retire l'habillage après confirmation. Cette partie est absente si votre administrateur a coupé la fonction.

### Animations

La ligne **Animations**, sous **Mode**, règle le mouvement des volets et des menus.

- **Système** suit le réglage « réduire les animations » de votre poste.
- **Complètes** : volets et menus glissent, même si le poste demande moins de mouvement.
- **Réduites** : des fondus courts, sans déplacement.

### Affichage du fil de discussion

Ces réglages sont dans Paramètres › **Chat** › **Affichage**.

- **Déroulé** : la façon de montrer le travail de l'assistant. **Classique** (par défaut) replie le travail sur une ligne et laisse la réponse en clair. **En bloc** le regroupe au-dessus de la réponse, ouvert pendant le tour. **Chronologie** montre réflexion, texte et étapes dans l'ordre. **Journal** écrit une ligne par geste, façon terminal.
- **Contexte** : la forme de la jauge de contexte. **Jetons (utilisés / fenêtre)**, **Bloc qui se remplit**, **Pourcentage** ou **Anneau**. Voir [Le contexte de la conversation](#le-contexte-de-la-conversation).
- **Réflexions** : **Repliées** (par défaut), **Dépliées** ou **Masquées**.
- **Métriques** : les chiffres sous chaque réponse. **Complètes**, **Essentielles (modèle, durée)** ou **Masquées**.
- **Densité** : **Confortable** ou **Compacte**.
- **Captures d'étape du navigateur** : une capture après chaque action de l'assistant dans son navigateur. Éteint par défaut ; les captures que l'assistant demande lui-même sont toujours affichées.

La **Largeur** du fil se règle dans Paramètres › **Chat** › **Conversation**. L'habillage llama.cpp impose sa propre largeur.

### Éditeur et mascotte

L'onglet **Apparence** a deux autres parties.

- **Éditeur** : **Selon le skin** (par défaut) donne à l'éditeur de code le style de l'habillage, **Classique** garde l'éditeur d'origine ; un habillage sans style d'éditeur garde l'éditeur classique. **Thème sombre** s'applique à l'éditeur seul, indépendamment du mode de la page.
- **Mascotte** : **Accueil d'un nouveau chat** choisit ce qui s'affiche au-dessus de la barre de saisie. **Logo** garde le logo ; un personnage de la liste l'anime. Décochez **Animer l'accueil** pour une image fixe. Un habillage qui apporte sa mascotte l'affiche tant que vous ne l'avez pas coupée. Cette partie est absente si votre administrateur a retiré les mascottes.

### Pour en tirer le maximum

- Laissez le **Mode** sur **Système** si votre poste change de thème selon l'heure : l'application suit sans réglage de votre part.
- Sur un petit écran, combinez **Densité** **Compacte** et **Métriques** **Essentielles (modèle, durée)** : plus de messages tiennent à l'écran.
- Pour suivre un raisonnement long, passez **Réflexions** sur **Dépliées** ou **Déroulé** sur **Chronologie**. Pour ne garder que les réponses, choisissez **Masquées**.
- Si votre poste réduit les animations mais que vous aimez voir les volets glisser, choisissez **Complètes** : le réglage ne vaut que pour l'application.
- Vous pouvez travailler en mode clair avec un éditeur sombre : activez **Thème sombre** dans Paramètres › **Apparence** › **Éditeur**.
- Un essai ne coûte rien : changez d'habillage, regardez, puis cliquez sur **Annuler** dans le message **Enregistré** pour retrouver le précédent.
- Tapez `/settings` dans la barre de saisie et choisissez **Apparence** pour arriver ici depuis le chat.

## Secrets et comptes Git
<!-- aide: secrets -->

Un secret est un identifiant, un mot de passe ou un jeton que vous confiez à l'application pour que l'assistant s'en serve à votre place : se connecter à un site, cloner un dépôt privé. L'assistant ne voit jamais sa valeur. Tout se gère dans [Paramètres](#paramètres) › **Secrets**.

### L'essentiel

1. Ouvrez Paramètres › **Secrets**.
2. Choisissez la partie : **Secrets web** pour vos sites, **Comptes Git** pour vos dépôts.
3. Créez le secret ou le compte. La valeur est chiffrée dès l'envoi et ne sera plus jamais affichée.
4. Pour un site, attachez le secret à la conversation avec `/secret`, puis demandez à l'assistant de s'y connecter.

L'onglet a trois parties :

- **Secrets web** : les identifiants et jetons que l'assistant utilise sur vos sites.
- **Comptes Git** : vos accès aux serveurs Git, pour cloner, pousser et ouvrir des PR.
- **Jetons MCP** : des jetons pour utiliser vos outils depuis une autre application. Voir [Utiliser vos outils depuis une autre application](#utiliser-vos-outils-depuis-une-autre-application).

Les clés de vos fournisseurs de modèles et de vos serveurs MCP se gèrent ailleurs : voir [Modèles et fournisseurs](#modèles-et-fournisseurs) et le [panneau MCP](#les-outils-et-le-panneau-mcp).

### Ajouter un secret web

[Créer un secret : nom, site, identifiant et valeur](../media/aide/secrets-ajouter.webm)

1. Dans **Secrets web**, cliquez sur **Nouveau secret**.
2. **Nom** : un nom court en minuscules, chiffres, points et tirets, par exemple `intranet-rh`. C'est lui que vous taperez dans le chat.
3. **Type** : **web-login** pour un site qui se connecte par un formulaire, **http-auth** pour un site qui ouvre la fenêtre d'identification du navigateur, **token** pour un jeton seul, sans site.
4. **Sites** : l'adresse du site, par exemple `https://rh.exemple.fr`. **Ajouter un site** en ajoute d'autres, dix au plus. Le secret ne servira que sur ces sites.
5. **Identifiant** et **Valeur** : votre nom de connexion et le mot de passe. La valeur est masquée pendant la frappe.
6. Cliquez sur **Créer**.

Le secret rejoint la liste avec son type, sa version, son identifiant, son dernier usage et ses sites. Trois boutons le suivent :

- la rotation remplace la valeur et passe à la version suivante ;
- **Modifier** change le nom, les sites, l'identifiant ou les options ;
- **Supprimer** demande un second clic sur le même bouton.

Deux réglages méritent un regard. **TLS** : **strict** exige un certificat valide ; **insecure** accepte un certificat non vérifié, à réserver à un site interne. **politique** : **sous-agents** autorise les sous-agents de la conversation à utiliser le secret (coché par défaut), **routines** autorise vos routines (décoché par défaut).

### Attacher un secret à une conversation

[Attacher un secret à la conversation avec /secret](../media/aide/secrets-conversation.webm)

L'assistant n'utilise un secret que dans les conversations où vous l'avez attaché.

1. Dans la barre de saisie, tapez `/secret` puis une espace.
2. Choisissez **attach**, puis le secret dans la liste **Secrets à attacher**.
3. Une puce `secret:intranet-rh` s'affiche au-dessus de la barre de saisie.
4. Demandez votre tâche : « Connecte-toi à l'intranet RH et relève mon solde de congés ».

L'assistant ouvre le site dans son navigateur et se connecte avec le secret, sans en connaître la valeur.

- Pour détacher, cliquez la croix de la puce, ou tapez `/secret detach` suivi du nom. `/secret detach --all` détache tout.
- `/secret` seul rappelle les secrets attachés et ceux qui sont disponibles.
- Seuls les types **web-login** et **http-auth** s'attachent, dix au plus par conversation.

### Comptes Git

[Ajouter un compte Git : URL, portée, jeton](../media/aide/secrets-git.webm)

Un compte Git donne accès à vos dépôts sur GitHub, GitLab, Bitbucket, Gitea ou Forgejo, ou sur tout autre serveur Git.

1. Dans **Comptes Git**, cliquez sur **Ajouter un compte**.
2. **URL** : collez l'adresse de votre serveur Git, d'une organisation ou d'un dépôt. Le **Type de serveur** est reconnu quand vous quittez le champ ; corrigez-le au besoin.
3. **Utiliser ce compte pour** : choisissez où le compte sert. L'URL propose les niveaux qu'elle contient : tout le serveur (`gitlab.exemple.fr`), une organisation (`gitlab.exemple.fr/atelier`) ou un seul dépôt.
4. Saisissez votre **Identifiant** si le serveur en demande un, puis le jeton créé sur votre serveur Git.
5. **Nom du compte (facultatif)** aide à distinguer deux comptes : `perso`, `robot`.
6. Cliquez sur **Ajouter**, puis sur **Tester** pour vérifier le jeton.

Ces comptes servent au panneau Git de l'éditeur et aux outils Git de l'assistant : un clonage sur un serveur privé fonctionne sans que vous tapiez d'identifiants. Voir [La sandbox et l'éditeur de code](#la-sandbox-et-léditeur-de-code).

Ce qu'il faut savoir :

- Plusieurs comptes peuvent partager un serveur. Pour un dépôt, c'est le compte le plus précis qui sert : un jeton personnel pour tout le serveur et un jeton limité à une organisation cohabitent. Deux comptes ne peuvent pas s'appliquer exactement au même endroit.
- En modifiant un compte, laissez le jeton vide pour garder l'actuel. Réduire ce à quoi le compte s'applique garde le jeton ; l'élargir, ou changer de serveur ou de type, le redemande.
- La casse du chemin est ignorée, sauf pour le type **Autre serveur Git**. Sur Bitbucket Server, collez l'adresse de clonage : son chemin commence par `scm/`.
- Un compte marqué **inactif** ne sert à aucun dépôt : modifiez-le pour choisir à quoi il s'applique.
- Un compte marqué **à vérifier** porte un jeton repris d'un ancien fichier de votre sandbox. Il ne sert pas tant que vous ne l'avez pas vérifié dans **Secrets web**, ou ressaisi ici.
- L'assistant ne peut pas recevoir de jeton dans le chat. Quand un dépôt en demande un, il vous invite à ajouter le compte ici.
- Votre administrateur peut limiter les serveurs Git que joint votre sandbox. Un compte Git sur un autre serveur est alors refusé : demandez à votre administrateur. Quand seuls vos comptes Git sont permis, un dépôt qu'aucun ne couvre est refusé tant que vous n'en ajoutez pas un.

### Pour en tirer le maximum

- Collez l'adresse complète d'une page dans **Sites** : elle est ramenée toute seule à l'adresse du site.
- Quand un mot de passe change, utilisez la rotation plutôt que de recréer le secret : son nom et ses conversations restent.
- Survolez le nom d'un secret : l'infobulle résume l'identifiant, le réglage TLS, la version, le nombre d'usages et le dernier.
- `/secret attach` accepte plusieurs noms à la suite. La liste se complète pendant la frappe.
- Sur un nouveau chat, attachez le secret avant d'écrire : il part avec votre premier message.
- Cochez **routines** sur les secrets qu'une routine planifiée doit utiliser sans vous.
- Tapez `/settings` dans la barre de saisie et choisissez **Comptes Git** pour ouvrir cette partie directement.
- Donnez un jeton large à votre compte personnel et un jeton limité à l'organisation sensible : le plus précis l'emporte, sans rien avoir à choisir à chaque dépôt.

### Comment ça marche

Les valeurs sont chiffrées dans un coffre, sur le serveur de l'application. Elles ne sont jamais écrites dans votre sandbox, jamais renvoyées à votre navigateur, jamais transmises à l'assistant.

L'assistant ne connaît d'un secret attaché que son nom, son type, ses sites et son identifiant. Au moment de la connexion, c'est l'application qui pose la valeur, et seulement vers les sites du secret. Une page piégée ou un document malveillant ne peut donc pas faire dire à l'assistant un mot de passe qu'il n'a pas.

## Modèles et fournisseurs
<!-- aide: modeles -->

Le modèle est le moteur qui écrit les réponses. Selon votre installation, vous avez le choix entre plusieurs modèles : un rapide pour les questions courantes, un plus puissant pour les tâches difficiles. Le nom du modèle en service est affiché dans la barre de saisie.

[Ouvrir la liste des modèles et en choisir un autre](../media/aide/chat-modele.webm)

### L'essentiel

1. Cliquez sur le nom du modèle, dans la barre de saisie, à gauche du bouton d'envoi.
2. Cliquez sur le modèle voulu. La liste se referme et son nom remplace l'ancien.
3. Envoyez votre message : c'est ce modèle qui répond.

Le choix vaut pour vos prochains messages, dans toutes vos conversations, et il est retenu par votre navigateur. Les réponses déjà écrites ne changent pas : la ligne sous chacune rappelle le modèle qui l'a produite.

### Lire la liste des modèles

Les modèles sont regroupés par serveur. **Serveur intégré** est le moteur installé avec l'application ; viennent ensuite les autres serveurs et les fournisseurs, ajoutés par l'administrateur ou par vous.

- **L'état du serveur**, à droite de son nom : **En ligne**, ou **Injoignable** avec un lien **Réessayer**.
- **La coche** marque le modèle en service.
- **Les pastilles** sous le nom disent ce que le modèle sait faire : **Réflexion** (il raisonne avant de répondre), **Vision** (il lit les images), et la taille de sa mémoire de travail, par exemple **32 k**. Plus elle est grande, plus la conversation peut être longue : pour un long document, préférez un modèle à grande mémoire. **Réflexion** ne s'affiche que sur le modèle en service.
- **L'état du modèle** : **Chargé** (prêt à répondre), **Disponible** (pas encore chargé : sa première réponse prendra plus de temps), **Chargement…**, ou **Échec**.
- **Les trois points** au bout de la ligne ouvrent les actions du modèle : **Fiche du modèle** pour ses caractéristiques, et, si le serveur le permet, **Charger** ou **Décharger**.

En bas de la liste, **Rafraîchir la liste** relit les modèles disponibles. Quand le serveur la communique, une jauge y montre aussi la mémoire de travail utilisée.

### Régler l'effort de réflexion

[Choisir l'effort de réflexion dans le menu du modèle](../media/aide/chat-effort.webm)

Un modèle qui réfléchit donne de meilleures réponses aux questions difficiles, mais met plus de temps. Vous réglez le dosage :

1. Ouvrez la liste des modèles.
2. Cliquez sur **Réflexion**, sous la liste.
3. Choisissez un niveau dans **Effort de réflexion** : **Auto**, **Basse**, **Moyenne**, **Élevée**.

Le niveau choisi s'affiche à droite de **Réflexion**. Les niveaux proposés sont ceux que le modèle accepte : certains modèles en offrent d'autres (**Aucune**, **Minimale**, **Très élevée**, **Maximale**), et la ligne **Réflexion** n'existe pas pour un modèle qui ne règle pas son effort. **Auto** laisse le modèle décider.

Pendant la réponse, vous suivez la réflexion et vous pouvez l'abréger avec **Répondre maintenant**. Voir [Le chat](#le-chat).

### Ajouter vos propres fournisseurs

Si l'administrateur l'autorise, vous pouvez utiliser les modèles d'un fournisseur externe (Anthropic, OpenAI et d'autres) avec votre propre clé.

1. Ouvrez Paramètres › **Modèles IA**.
2. Sous **Mes fournisseurs**, cliquez sur **Ajouter**.
3. Choisissez le **Fournisseur** et collez votre **Clé API**. **Modèle par défaut** et **Nom** sont facultatifs.
4. Cliquez sur **Ajouter**, puis sur **Tester la connexion** : le nombre de modèles trouvés s'affiche.
5. Les modèles du fournisseur apparaissent dans la liste de la barre de saisie, dans leur propre groupe.

Ce qu'il faut savoir :

- Votre clé est chiffrée, et elle n'est plus jamais affichée. Pour la changer, modifiez le fournisseur et saisissez la nouvelle.
- **Fournis par l'administrateur** liste les serveurs mis à disposition de tous. Vous n'avez rien à y régler.
- Avec un fournisseur externe, vos messages sortent du réseau de votre organisation et sont facturés sur votre compte chez ce fournisseur. La pastille **Gratuit** signale un modèle sans facturation.
- Un modèle appartient à un fournisseur : en choisissant le modèle, vous choisissez aussi le serveur qui répond. Il n'est pas possible d'envoyer par erreur une demande au mauvais fournisseur.

### Ce que décide l'administrateur

- **Les modèles proposés** et les serveurs qui les font tourner.
- **Les serveurs ouverts à votre compte.** Si la liste indique **Aucun serveur autorisé**, votre compte n'a accès à aucun modèle et l'envoi est bloqué : demandez à votre administrateur.
- **Les fournisseurs externes ouverts aux comptes.** Par défaut, aucun ne l'est. La page **Modèles IA** l'indique : « Aucun fournisseur cloud n'est ouvert aux comptes par l'administrateur ». Un fournisseur que l'administrateur referme reste enregistré chez vous, marqué **fermé par l'administrateur**, mais n'est plus utilisable.
- **Le droit de charger et de décharger** un modèle.

### Réglages de génération

Le panneau **Génération** règle la façon dont le modèle écrit : sa température, la longueur de ses réponses, sa réflexion, le nombre de tours d'outils. Sans réglage de votre part, chaque modèle garde ses propres valeurs.

[Ouvrir les paramètres de génération depuis le menu du modèle et changer la température](../media/aide/generation-reglages.webm)

1. Dans la barre de saisie, cliquez sur le nom du modèle.
2. En bas du menu, cliquez sur **Paramètres de génération…**. Le panneau s'ouvre à droite.
3. Saisissez une valeur dans le champ à modifier. Un champ vide garde la valeur du modèle, affichée en grisé.
4. Fermez le panneau : le réglage est déjà enregistré.

Vos réglages sont enregistrés sur votre compte : ils valent pour toutes vos conversations, pas seulement pour celle qui est ouverte.

Le panneau contient :

- **Contexte** : une jauge de la place utilisée dans la fenêtre du modèle. **Régler** ouvre le seuil de compaction, dans Paramètres › **Avancé** › **Compaction** (voir [Le contexte de la conversation](#le-contexte-de-la-conversation)).
- **Sortie** : **Température** (plus haut, les réponses sont plus variées) et **Longueur**. **Auto** laisse l'application choisir selon la place disponible ; **Limiter** fixe un maximum en jetons.
- **Réflexion**, si le modèle sait réfléchir : l'interrupteur **Réflexion**, l'**Effort**, le **Budget** en jetons et **Raisonnement conservé**.
- **Outils** : **Tours d'outils**, le nombre d'appels au modèle dans une même réponse quand il utilise des outils.
- **Avancé** : **Top P**, **Top K**, **Min P** et **Pénalité de répétition**.

À savoir :

- Un réglage modifié est marqué d'un point. La flèche à côté du champ, **Revenir à…**, rend à ce seul réglage la valeur du modèle.
- Le bas du panneau compte les réglages modifiés (« 1 modifié »). **Rétablir le modèle** les annule tous.
- Dans le menu du modèle, la ligne **Paramètres de génération…** rappelle ce nombre, sans ouvrir le panneau.
- Un réglage que le moteur du modèle choisi n'applique pas porte la mention « Non appliqué par… » : il est ignoré à l'envoi.
- Quand une longue tâche s'arrête sur « Budget de tours atteint », **Reprendre**, dans le bandeau, la relance ; augmentez **Tours d'outils** pour la suite.
- Ce panneau et le panneau [MCP](#les-outils-et-le-panneau-mcp) occupent la même place : ouvrir l'un referme l'autre.

### Pour en tirer le maximum

- **Adaptez le modèle à la tâche.** Un modèle léger pour reformuler ou résumer, un modèle qui réfléchit pour analyser, planifier ou écrire du code.
- **Montez l'effort pour une question difficile, baissez-le pour une tâche simple.** **Élevée** améliore les raisonnements longs ; **Basse** rend les réponses plus rapides.
- **Demandez un second avis.** Changez de modèle, puis cliquez sur **Régénérer la réponse** sous la dernière réponse : la même question est posée au nouveau modèle.
- **Beaucoup de modèles ?** Au-delà de six, un champ **Chercher un modèle** apparaît en haut de la liste. Il cherche dans le nom du modèle et dans celui du serveur.
- **Tout se fait au clavier.** Dans la liste, `↑` et `↓` passent d'un modèle à l'autre, `Entrée` choisit, `→` ouvre les actions du modèle ou le menu **Réflexion**, `Échap` referme.
- **Un modèle Disponible mais pas Chargé** répondra après un temps de chargement. Si vous en avez le droit, **Charger** le prépare pendant que vous rédigez.

### Comment ça marche

Un modèle doit être chargé en mémoire sur son serveur avant de répondre : le premier message adressé à un modèle **Disponible** est donc plus lent que les suivants. Charger et décharger pèsent sur le serveur que tous partagent, c'est pourquoi ce droit peut être réservé.

La taille de la mémoire de travail se compte en jetons, des morceaux de mots. « 32 k » signifie environ 32 000 jetons, pour l'ensemble de la conversation : vos messages, les réponses, les fichiers joints et les résultats des outils.

# Aide

## Raccourcis clavier
<!-- aide: raccourcis -->

Toute l'application se pilote au clavier. Cette page réunit les touches utiles, écran par écran. Sur macOS, remplacez `Ctrl` par `Cmd`.

### L'essentiel

Ces touches valent partout dans l'application.

| Touche | Effet |
|---|---|
| `Ctrl+Maj+O` | Nouveau chat, tant qu'aucune fenêtre n'est ouverte. Dans l'éditeur de code, cette combinaison ouvre **Aller au symbole** |
| `Échap` | Ferme, dans l'ordre : une demande de confirmation, un menu, une fenêtre, un panneau, puis la page ouverte |
| `Échap` | Arrête aussi la dictée et la lecture à voix haute |
| `Tab`, `Maj+Tab` | Passe à l'élément suivant ou précédent. Dans une fenêtre, le parcours reste dans la fenêtre |

### Dans la barre de saisie

| Touche | Effet |
|---|---|
| `Entrée` | Envoyer. Pendant une réponse, `Entrée` passe à la ligne : envoyez une fois la réponse finie |
| `Maj+Entrée` | Passer à la ligne |
| `/` au début de la saisie | Ouvrir le menu des commandes |
| `@` | Choisir un fichier de la sandbox |
| `Alt+I` | Passer en mode Images, sur l'écran du chat, si la génération d'images est disponible |
| `↑` `↓` | Parcourir le menu des commandes `/` ou la liste des fichiers `@` |
| `Entrée` | Valider la ligne choisie |
| `Tab` | Valider la commande choisie (menu `/`) |
| `Échap` | Fermer le menu sans effacer la saisie |

### Dans la conversation

| Touche | Effet |
|---|---|
| `Ctrl+Entrée` | Envoyer le message que vous êtes en train de corriger |
| `Échap` | Annuler la correction |
| Double-clic sur le titre | Renommer la conversation ; `Entrée` valide, `Échap` annule |
| `F2` | Renommer, quand le menu **Conversation** est ouvert |
| `Entrée` | Dans la recherche de la conversation : résultat suivant |
| `Maj+Entrée` | Dans la recherche de la conversation : résultat précédent |
| `←` `→` | Dans la visionneuse d'images : image précédente ou suivante |

### Dans les menus

Ces touches valent pour tous les menus : **+**, **Plus**, le menu du compte, le menu **Conversation**, la liste des modèles.

| Touche | Effet |
|---|---|
| `↑` `↓` | Ligne précédente ou suivante |
| `Début`, `Fin` | Première ou dernière ligne |
| `Entrée` ou `Espace` | Choisir |
| `→` | Ouvrir un sous-menu : **Skills**, **Prompts**, **Gabarits**, **Réflexion**, les actions d'un modèle |
| `←` ou `Échap` | Refermer le sous-menu |

### Dans l'aide

| Touche | Effet |
|---|---|
| `Entrée` | Dans **Rechercher dans l'aide** : ouvre la première section trouvée |
| `Échap` | Ferme l'aide |

### Dans l'éditeur de code

`Ctrl+/` affiche cette liste dans l'éditeur lui-même, quand le curseur n'est pas dans le code.

#### Se déplacer

| Touche | Effet |
|---|---|
| `Ctrl+P` | Ouvrir un fichier par son nom, les plus récents d'abord |
| `Ctrl+Maj+F` | Rechercher dans le contenu des fichiers |
| `Alt+L` | Montrer le fichier ouvert dans l'arbre |
| `Alt+←`, `Alt+→` | Position précédente, position suivante (sauf sur macOS) |
| `Ctrl+G` | Aller à une ligne |
| `Ctrl+Maj+O` | Aller à un symbole du fichier |
| `F12` | Aller à la définition |

#### Écrire

| Touche | Effet |
|---|---|
| `Ctrl+S` | Enregistrer le fichier |
| `Ctrl+Alt+S` | Tout enregistrer |
| `Maj+Alt+F` | Mettre en forme le document |
| `Alt+\` | Demander une complétion à l'assistant |
| `Ctrl+F` | Rechercher dans le fichier |
| `Ctrl+H` | Rechercher et remplacer |
| `Ctrl+D` | Sélectionner l'occurrence suivante (plusieurs curseurs) |
| `Alt+Clic` | Ajouter un curseur |
| `Ctrl+/` | Commenter ou décommenter la ligne, quand le curseur est dans le code |

#### Onglets, panneaux et arbre des fichiers

| Touche | Effet |
|---|---|
| `Alt+W` | Fermer l'onglet |
| `Alt+PgSuiv`, `Alt+PgPréc` | Onglet suivant, onglet précédent |
| `Ctrl+Maj+T` | Rouvrir le dernier onglet fermé |
| Clic du milieu | Fermer l'onglet |
| `Ctrl+B` | Afficher ou masquer l'arbre des fichiers |
| ``Ctrl+` `` | Afficher ou masquer le terminal |
| `Ctrl+Maj+P` | Palette de commandes de l'éditeur |
| `↑` `↓` | Dans l'arbre : ligne précédente ou suivante |
| `→` `←` | Dans l'arbre : ouvrir ou fermer le dossier |
| `Ctrl+Clic`, `Maj+Clic` | Dans l'arbre : ajouter à la sélection, sélectionner une plage |
| `F2`, `Suppr` | Dans l'arbre : renommer, supprimer |

Voir [La sandbox et l'éditeur de code](#la-sandbox-et-léditeur-de-code) et [Le terminal](#le-terminal).

### Dans la console d'administration

| Touche | Effet |
|---|---|
| `Ctrl+K` | Rechercher une page, un réglage ou une action |
| `Ctrl+S` | Enregistrer les modifications de l'écran |

### Pour en tirer le maximum

- **Survolez un bouton** : son nom s'affiche, avec son raccourci quand il en a un. C'est le moyen le plus rapide d'en apprendre de nouveaux.
- **Les commandes remplacent bien des clics.** `/settings`, `/help`, `/usage`, `/memory` ouvrent leur écran sans quitter le clavier. La liste complète est dans [Le chat](#le-chat).
- **Le menu + rappelle la commande** de chaque fonction, à droite de son nom : `/skills`, `/prompt`, `/template`, `/plan`, `/compact`.
- **`Échap` plusieurs fois de suite** vous ramène au chat depuis n'importe où, sans rien fermer d'autre que ce qui est ouvert.
- **Dans l'éditeur, les onglets se ferment avec `Alt+W`**, pas avec `Ctrl+W` : cette dernière combinaison ferme l'onglet du navigateur.
- **Pendant une réponse, écrivez la suite** : `Entrée` passe à la ligne tant que l'assistant écrit ; envoyez quand il a fini.

### Comment ça marche

Les navigateurs gardent pour eux beaucoup de combinaisons : `Ctrl+N`, `Ctrl+T`, `Ctrl+W`, `Ctrl+Tab`. Une page web ne peut pas les reprendre. L'application n'utilise donc que des combinaisons qui fonctionnent dans tous les navigateurs, ce qui explique `Ctrl+Maj+O` pour un nouveau chat et la touche `Alt` pour les onglets de l'éditeur.

## Questions fréquentes
<!-- aide: faq -->

Les questions qui reviennent le plus, avec une réponse courte et un renvoi vers la section qui détaille. Si quelque chose ne fonctionne pas, voyez plutôt [En cas de problème](#en-cas-de-problème).

### L'essentiel

#### Mes données quittent-elles mon réseau ?

Non, pas par défaut. Le modèle, vos fichiers et vos conversations restent sur le serveur de votre organisation. Trois exceptions, toutes ouvertes explicitement :

- un **fournisseur de modèles externe**, ajouté par l'administrateur ou par vous avec votre clé : vos messages lui sont alors envoyés ;
- un **outil de navigation** que l'assistant utilise pour consulter un site : c'est le serveur qui consulte le site, pas votre poste ;
- un **accès réseau** accordé à votre sandbox par l'administrateur.

#### L'assistant se trompe ou invente. Que faire ?

1. **Donnez-lui la source.** Joignez le fichier avec **+**, ou mentionnez-le avec `@` : il le lit au lieu de supposer son contenu. Voir [Le chat](#le-chat).
2. **Interrogez vos documents.** Si la question porte sur des documents internes, activez une collection avec `/rag use`. Voir [Vos documents (RAG)](#vos-documents-rag).
3. **Laissez-le vérifier.** Avec les outils activés, il peut lire un fichier ou lancer une commande plutôt que deviner. Voir [Les outils et le panneau MCP](#les-outils-et-le-panneau-mcp).
4. **Faites-le réfléchir davantage.** Dans le menu du modèle, réglez **Réflexion** sur **Élevée**. Voir [Modèles et fournisseurs](#modèles-et-fournisseurs).
5. **Corrigez la question** avec **Éditer et renvoyer** plutôt que d'ajouter un message : une réponse fausse laissée dans le fil influence les suivantes.

#### J'ai rechargé la page pendant une réponse. Est-elle perdue ?

Non. La réponse continue de s'écrire sur le serveur, et la page la rattrape en se rouvrant. Vous pouvez aussi écrire la suite pendant qu'elle s'écrit : voir [Le chat](#le-chat).

### Modèles et réponses

#### Puis-je changer de modèle en cours de conversation ?

Oui : le modèle choisi dans la barre de saisie répond à partir de votre prochain message. Voir [Modèles et fournisseurs](#modèles-et-fournisseurs), qui explique aussi pourquoi la première réponse d'un modèle **Disponible** est plus lente.

#### Le bouton Continuer n'apparaît pas, ou la réflexion d'une ancienne réponse a disparu

Après un arrêt pendant la réflexion, il n'y a rien à continuer : cliquez sur **Régénérer la réponse**. La réflexion, elle, n'est pas enregistrée avec la conversation. Voir [Le chat](#le-chat).

#### Mes réglages sont-ils conservés ?

- **L'effort de réflexion et les paramètres de génération** sont enregistrés avec votre compte : vous les retrouvez sur un autre poste.
- **Le modèle choisi** est retenu par votre navigateur : sur un autre poste, choisissez-le de nouveau.
- **Le prompt système** (Paramètres › **Chat** › **Conversation**) est permanent et vaut pour toutes vos conversations.

#### Comment savoir ce que je consomme ?

Sous chaque réponse, une ligne indique la durée, la vitesse, les jetons de réflexion et la part relue du cache. Laissez le pointeur dessus pour le détail de l'entrée et de la sortie. Pour une vue d'ensemble sur 1, 7, 30 ou 90 jours, ouvrez Paramètres › **Avancé** › **Utilisation**, ou tapez `/usage`.

### Conversations et outils

#### Une conversation a disparu

Au-delà du nombre de conversations fixé par l'administrateur, les plus anciennes sont supprimées : archivez celles que vous voulez garder. Voir [Les conversations](#les-conversations).

#### Un outil a échoué. Est-ce un bug ?

Pas forcément. Le message d'erreur d'un outil explique comment se corriger, et l'assistant le lit : il réessaie souvent seul avec le bon paramètre. Dépliez l'étape dans le fil pour voir ce qui s'est passé. Voir [Quand l'assistant agit](#quand-lassistant-agit).

#### Il me manque une commande ou une entrée de la barre latérale

Vérifiez d'abord Paramètres › **Fonctionnalités** › **Modules** : **MCP**, **Images** et **Sandbox** s'y coupent. Les autres fonctionnalités dépendent de votre installation et de vos droits : la génération d'images, les documents (RAG), les sous-agents, la voix. Une entrée encore absente n'a pas été ouverte pour votre compte : demandez à votre administrateur.

### Voix

#### Je ne vois pas le bouton micro

Trois raisons possibles, dans cet ordre : le moteur vocal n'est pas installé (demandez à votre administrateur) ; **Dictée** est décochée dans Paramètres › **Chat** › **Voix** ; ou la page n'est pas servie en connexion sécurisée (HTTPS), ce que les navigateurs exigent pour le micro.

#### La dictée écrit des phrases que je n'ai pas dites

La reconnaissance vocale invente parfois du texte sur du silence ou du bruit de fond. Rapprochez le micro ou utilisez un casque. Le texte dicté n'est jamais envoyé sans vous : relisez-le avant d'appuyer sur `Entrée`.

### Pour en tirer le maximum

- **Cherchez dans l'aide** avant de chercher dans les menus : le champ **Rechercher dans l'aide** trouve un mot dans toutes les sections.
- **Une conversation par sujet.** Un fil court donne des réponses plus justes et plus rapides qu'un fil qui mélange tout.
- **Une question que vous posez souvent** se garde avec le signet (**Sauvegarder**) de votre message, puis revient par `/prompt`. Voir [Les prompts](#les-prompts).
- **Avant de signaler un problème**, ouvrez **Informations** dans le menu du compte : la version affichée aidera votre administrateur.

## En cas de problème
<!-- aide: probleme -->

Ce que l'application affiche quand quelque chose ne va pas, ce que cela signifie et ce que vous pouvez faire. La plupart des incidents se règlent en attendant quelques secondes, en réessayant ou en ouvrant une nouvelle conversation.

### L'essentiel

1. **Lisez le message.** L'application dit la cause en quelques mots et propose le bon bouton : **Continuer**, **Reprendre**, **Réessayer** ou **Nouveau chat**.
2. **Attendez un instant, puis réessayez.** Une coupure de réseau ou un redémarrage du serveur se rétablit le plus souvent seul.
3. **Rechargez la page** si l'écran reste figé. Vos conversations sont enregistrées sur le serveur : vous ne perdez rien.
4. **Si le problème persiste, prévenez votre administrateur**, avec les éléments listés à la fin de cette section.

### Connexion et session

#### Identifiant ou mot de passe incorrect, ou Trop de tentatives

Vérifiez la saisie, en particulier les majuscules ; après plusieurs échecs, la connexion est suspendue quelques minutes. Si vous avez oublié votre mot de passe, votre administrateur peut vous en attribuer un nouveau.

#### Serveur injoignable, ou Service momentanément indisponible

Le serveur ne répond pas ou redémarre. Vérifiez votre connexion au réseau, attendez une dizaine de secondes et réessayez. Vos identifiants n'ont pas été refusés.

#### Session expirée

Votre session a atteint sa durée maximale, ou l'administrateur l'a fermée. Reconnectez-vous : vos conversations sont intactes.

#### Le serveur redémarre…

Un bandeau l'annonce pendant un redémarrage. La page se reconnecte seule ; attendez qu'il disparaisse avant d'envoyer un message.

### Pendant une réponse

#### Reconnexion (1/2)... reste affiché

La connexion avec le serveur s'est coupée. L'application réessaie deux fois. Si l'indication persiste, rechargez la page : la réponse en cours continue sur le serveur et réapparaît.

#### Réponse interrompue, ou Budget de tours atteint

**Continuer** complète une réponse arrêtée ou trop longue ; s'il n'est pas proposé, cliquez sur **Régénérer la réponse**. Un travail d'outils stoppé (« Budget de tours atteint », « Budget de temps atteint »…) se relance par **Reprendre**, dans son bandeau. Voir [Le chat](#le-chat).

#### Interrompue, suivi d'une cause

| Cause affichée | Que faire |
|---|---|
| **connexion perdue**, **serveur injoignable**, **délai dépassé** | Cliquez sur **Reprendre** (ou **Réessayer**) une fois la connexion revenue |
| **modèle en chargement** | Attendez quelques secondes, puis **Reprendre** |
| **moteur occupé**, **trop de requêtes** | D'autres demandes sont en cours : patientez, puis **Reprendre** |
| **contexte saturé** | La conversation est trop longue pour le modèle : **Nouveau chat**, ou `/compact` |
| **accès refusé**, **requête refusée** | Votre compte ou ce modèle ne permet pas cette demande : prévenez votre administrateur |
| **erreur interne** | **Reprendre** ; si l'erreur revient, cliquez sur **Copier le détail** et transmettez-le |

#### En attente… dure longtemps, ou les réponses sont très lentes

Beaucoup de personnes utilisent le modèle en même temps, ou le modèle choisi est lourd. Patientez, ou choisissez un modèle plus léger. Voir [Modèles et fournisseurs](#modèles-et-fournisseurs).

#### Aucun serveur autorisé

Votre compte n'a accès à aucun modèle, et le bouton d'envoi est bloqué. Demandez à votre administrateur.

#### Un modèle est marqué Échec, ou son serveur Injoignable

Le modèle n'a pas pu être chargé, ou son serveur ne répond pas. Cliquez sur **Réessayer** à côté du nom du serveur, ou choisissez un autre modèle. Si cela dure, prévenez votre administrateur.

#### L'assistant ne suit pas mes consignes

Un **Prompt système** trop long, ou contredit par le début de la conversation, est mal suivi. Raccourcissez-le dans Paramètres › **Chat** › **Conversation**, puis ouvrez une nouvelle conversation.

### Fichiers, outils et sandbox

#### La liste @ est vide, ou un fichier joint est refusé

La liste `@` montre les fichiers de votre sandbox : elle est vide si la sandbox n'est pas disponible. Un fichier joint est refusé au-delà des limites données dans [Joindre un fichier](#joindre-un-fichier).

#### Une commande échoue avec « connexion refusée », ou l'assistant dit qu'il n'a pas de réseau

Votre sandbox n'a que les accès réseau que son profil autorise. Quand plusieurs profils vous sont proposés, choisissez-en un autre à la ligne **Réseau** de Paramètres › **Avancé** › **Sandbox**. Sinon, demandez à votre administrateur d'ouvrir la destination.

#### L'aperçu d'un serveur affiche une erreur de connexion

Le service que vous avez lancé dans la sandbox n'écoute pas sur ce port, ou le profil réseau ne l'autorise pas. Vérifiez qu'il est bien démarré. Voir [La sandbox et l'éditeur de code](#la-sandbox-et-léditeur-de-code).

#### L'éditeur reste figé

Fermez le panneau **Sandbox**, puis rouvrez-le. Si cela ne suffit pas, rechargez la page.

#### Un serveur MCP est en erreur

Le serveur ne démarre pas ou ne répond plus. Pour un serveur que vous avez ajouté, vérifiez son adresse ; pour un serveur partagé, prévenez votre administrateur. Voir [Les outils et le panneau MCP](#les-outils-et-le-panneau-mcp).

#### Le RAG est indisponible, ou un document affiche Extracteur indisponible

Un service nécessaire à la lecture des documents est arrêté. Vos collections restent en place et l'indexation reprend d'elle-même quand le service revient. Prévenez votre administrateur.

### Voix

#### La dictée s'arrête seule

L'application l'indique : le moteur de dictée ne répond plus, ou l'onglet était masqué. Relancez la dictée d'un clic sur le micro. Si le micro n'apparaît pas du tout, voir [Questions fréquentes](#questions-fréquentes).

### Pour en tirer le maximum

- **Préférez Continuer à Régénérer** quand une réponse a été coupée : le texte déjà écrit est gardé.
- **Une conversation qui sature se soigne en amont.** `/compact` résume le début du fil ; une nouvelle conversation par sujet évite d'en arriver là. Voir [Le contexte de la conversation](#le-contexte-de-la-conversation).

### Ce qu'il faut transmettre à votre administrateur

Pour un problème qui persiste, donnez-lui de quoi retrouver l'incident :

- l'heure, et le titre de la conversation concernée ;
- ce que vous faisiez, et le message affiché ;
- le texte obtenu avec **Copier le détail**, s'il est proposé ;
- la version de l'application, lue dans **Informations** (menu du compte).

Chaque demande laisse une trace côté serveur : avec ces éléments, l'administrateur peut reconstituer précisément ce qui s'est passé.

## Console d'administration
<!-- aide: admin -->

La console règle l'application pour tous : comptes et droits, modèles et services, sandbox, sauvegardes, journaux. Elle est réservée aux administrateurs. Les modérateurs n'y voient que **Vue d'ensemble** et **Supervision**, sans le journal de sécurité.

### L'essentiel

1. Dans le chat, cliquez sur l'icône bouclier **Administration**, en bas de la barre latérale. La session est partagée : vous êtes déjà connecté.
2. La console s'ouvre sur **Vue d'ensemble**. Le bloc **À traiter** liste ce qui demande votre attention ; **Ouvrir** mène au réglage concerné.
3. Choisissez une page dans la barre latérale : six entrées, chacune dépliée en sous-pages.
4. Modifiez un réglage. Une barre apparaît en bas de page : cliquez sur **Enregistrer**.
5. **Retour au chat**, en bas de la barre latérale, vous ramène à la conversation.

### Créer un compte

[Créer un compte dans la console : identifiant et mot de passe temporaire](../media/aide/admin-comptes.webm)

1. Ouvrez **Utilisateurs & accès**, page **Comptes**.
2. Cliquez sur **Créer un compte**.
3. Dans **Nouvel utilisateur**, saisissez l'**Identifiant** et un **Mot de passe temporaire**. Choisissez le **Rôle** : **Utilisateur**, **Modérateur** ou **Administrateur**.
4. Cliquez sur **Créer**. Le compte rejoint la liste.

Transmettez le mot de passe temporaire à la personne : elle devra le changer à sa première connexion.

Sur la ligne d'un compte :

- **Modifier** déplie ses réglages. **Compte** : **Rôle** et **Groupes**. **Inférence** : les **Serveurs** autorisés (**Hérité**, **Tous** ou **Liste**) et le droit de gérer les **Modèles**. **Sandbox et machines** : le **Quota** en Mo (0 = illimité), le profil **Réseau**, les **Machines** pilotables dans le Studio et les accès par jeton. Validez par **Enregistrer**.
- La clé réinitialise le mot de passe. Le compte devra le changer à sa prochaine connexion.
- La corbeille supprime le compte, après confirmation. La console demande ensuite s'il faut garder sa sandbox.

Au-dessus de la liste, **Admins** et **Sans groupe** filtrent les comptes, et le champ **Nom ou groupe** cherche. Cochez plusieurs comptes pour les ajouter à un groupe ou les supprimer ensemble.

### Modifier un réglage et l'enregistrer

[Modifier un réglage de la console, puis l'enregistrer par la barre du bas](../media/aide/admin-enregistrer.webm)

Toutes les pages de réglages fonctionnent de la même façon. Exemple avec la règle de mot de passe :

1. Ouvrez **Utilisateurs & accès**, page **Mots de passe & sessions**.
2. Saisissez une **Longueur minimale** et cochez les **Caractères obligatoires** voulus.
3. La barre du bas compte les changements : « 2 modifications ».
4. Cliquez sur **Enregistrer**. Le message **Modifications enregistrées** confirme.

Ce qu'il faut savoir :

- Un écran, un enregistrement : rien n'est écrit tant que vous n'avez pas enregistré.
- **Voir** détaille chaque changement, ancienne et nouvelle valeur, et permet d'en **Rétablir** un seul. **Annuler** les abandonne tous.
- Quitter la page avec des changements en cours ouvre un choix : **Rester**, **Ignorer** ou **Enregistrer**.
- Si un autre administrateur a modifié la même valeur entre-temps, la console le signale. **Reprendre** garde sa valeur et enregistre vos autres changements.
- Certains réglages ne sont lus qu'au démarrage. Un bandeau **Redémarrage nécessaire** reste alors sur toutes les pages, avec le nombre de réglages en attente, un lien **Détail** et un bouton **Redémarrer**.

### Les pages de la console

- **Vue d'ensemble** : **À traiter**, l'état des **Services** avec **Tout tester**, les chiffres des **Dernières 24 h** et l'**Installation**.
- **Supervision** : **Métriques** (widgets au choix, export CSV, collecte Prometheus), **Rapport** (digest quotidien archivé, aperçu avant impression), **Activité** (onglets **Exécutions** et **Appels d'outils**, avec recherche, tri et filtres des erreurs), **Journaux** (onglet **Technique**, et onglet **Sécurité** pour les administrateurs).
- **Modèles & services** : **Inférence** (moteurs, planification des requêtes), **Compression**, **RAG**, **Vision & machines** (annotation, machines cibles du Studio), **Voix**, **Images**, **Outils MCP**, **Prompts** (prompts système par catégorie), **Secrets** (ceux de l'instance).
- **Utilisateurs & accès** : **Comptes**, **Groupes**, **Droits par défaut** (fonctionnalités, fournisseurs ouverts aux comptes), **Mots de passe & sessions**, **SSO OpenID Connect** (fournisseurs d'authentification unique, comptes à rattacher).
- **Sandbox** : **Limites & politique** (mémoire, processeur, processus, durée d'une commande, arrêt d'inactivité), **Réseau** (profils), **Hôtes d'outils**, **Conteneurs**, **Sous-agents**.
- **Système** : **Instance** (identité, écran d'accueil, page de connexion), **Apparence** (habillages proposés), **Accès HTTPS**, **Données** (sauvegarde, base de données, restauration), **Journalisation**, **Entretien** (entretien périodique, redémarrage, purge des métriques).

Les dates sont en heure locale ; survolez-les pour l'heure UTC exacte.

### Premiers réglages d'une installation

La **Vue d'ensemble** signale ce qui manque à une installation neuve. Dans l'ordre :

1. **Accès HTTPS** (**Système**) : sans lui, mots de passe et cookies circulent en clair. La bascule vérifie que les ports répondent avant de couper l'accès direct, pour ne pas vous enfermer dehors.
2. Une règle de mot de passe (**Mots de passe & sessions**) : longueur minimale et caractères obligatoires.
3. Une sauvegarde (**Système**, page **Données**) : locale, puis vers un serveur distant.
4. Un moteur (**Modèles & services**, page **Inférence**), puis les comptes et leurs groupes.

### Opérations courantes

- **Sauvegarde et restauration** (**Données**) : archive de la base (avec la mémoire des comptes), des sandboxes et des serveurs MCP ; l'historique des fichiers de l'éditeur (**Historique**) n'est pas sauvegardé ; **Sauvegarde distante** vers un autre serveur (SFTP ou rsync) ; restauration **Complète**, ou limitée à la **Base de données**, aux **Sandboxes** ou aux **Serveurs MCP**.
- **Changer de base de données** (**Données**) : **Simuler** vérifie la base cible et compte ce qui serait copié. **Migrer et basculer** suspend les écritures, copie et vérifie les données, puis redémarre l'application sur la nouvelle base. **Revenir à SQLite** fait le chemin inverse. Si le serveur de base devient injoignable : `./elpis db use sqlite` sur la machine, puis redémarrage.
- **Habillages** (**Système**, page **Apparence**) : l'interrupteur **Actif** propose un habillage aux comptes, **Définir** choisit celui par défaut. **Importer** ajoute un paquet, qui arrive désactivé. **Créer** part d'un habillage existant, avec un aperçu en direct. **Habillages personnels** autorise ou non les habillages créés par les comptes, avec un **Plafond par compte**.
- **Sessions** (**Mots de passe & sessions**) : durée de connexion, déconnexion sur inactivité, **Révoquer toutes les sessions** pour déconnecter tout le monde sauf vous.
- **Journal de sécurité** (**Supervision**, page **Journaux**, onglet **Sécurité**) : connexions, comptes, droits, réglages, sauvegardes, exports. Filtrez par période, catégorie, compte ou résultat ; **Plus ancien** remonte le temps. **Exporter** produit un fichier CSV ou JSONL, 366 jours au plus ; chaque export est lui-même journalisé. **Vérifier l'intégrité** contrôle signatures et continuité sur la période.
- **Journalisation** (**Système**) : durée de conservation du journal de sécurité (365 jours par défaut), état de la centralisation vers le syslog de l'hôte, **Écrire un événement de test**. **Geler la purge** garde tous les fichiers pendant une enquête : motif obligatoire, confirmation en tapant `GELER`, levée en tapant `LEVER`. La mise en place côté serveur se fait par `sudo ./elpis audit setup`.
- **Une sandbox sans aucune sortie** (**Sandbox**, page **Réseau**) : **Tout bloquer** coupe le réseau de la sandbox, et le navigateur piloté le suit. Les outils Git de l'assistant passent encore par le relais Git de l'hôte, qui suit la règle **Relais Git** du profil, **Tous** par défaut. Pour que rien ne sorte par le réseau, choisissez **Serveurs choisis** sans lister de serveur : la carte du profil affiche alors **Dépôts Git** refusés. Avec **Sudo** permis (**Limites & politique**), root dans une telle sandbox n'a toujours aucun réseau. Le réseau change à la prochaine utilisation de la sandbox, qui est alors recréée ; la règle Git s'applique tout de suite. Les serveurs MCP distants et les machines du Studio sont pilotés par l'application, hors de la sandbox, et suivent leurs propres réglages.

### Pour en tirer le maximum

- `Ctrl+K` ouvre la recherche de la console : pages, réglages et actions. Tapez `sauveg` et validez : **Télécharger une sauvegarde** part sans passer par les menus. Les flèches choisissent, `Entrée` ouvre.
- `Ctrl+S` enregistre la page en cours.
- Le champ **Rechercher une page**, en haut de la barre latérale, filtre la navigation. Il trouve aussi une page par le nom d'un de ses réglages.
- Dans **À traiter**, certaines lignes agissent directement : **Télécharger une sauvegarde**, **Redémarrer**.
- **Tout tester**, sur la **Vue d'ensemble**, relance la vérification de tous les services d'un coup.
- Réglez les droits par **Groupes** plutôt que compte par compte : dans un compte, **Hérité** suit les groupes.
- La lune, en bas de la barre latérale, passe la console en sombre ou en clair sans toucher aux comptes.
- Après un incident de sécurité, **Révoquer toutes les sessions** oblige chacun à se reconnecter ; la clé d'un compte lui impose en plus un nouveau mot de passe.

### Comment ça marche

La console tourne dans un processus séparé du chat : une faille côté application ne donne pas accès aux fonctions d'administration. Les réglages sont lus par l'application dès l'enregistrement, sauf ceux que le bandeau **Redémarrage nécessaire** signale.
