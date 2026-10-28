# Journal des modifications

Les changements notables d'Elpis, du plus récent au plus ancien. Format inspiré
de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) ; numéros de version
selon [SemVer](https://semver.org/lang/fr/).

## Non publié

### Ajouté

- **Procédures du navigateur (arbres de comportement).** Une procédure est un arbre
  JSON versionné (`seq`, `sel`, `if`, `act`, `login`, `retry`, `wait_ms`) que le nouvel outil
  `pw_run` rejoue **sans appeler le modèle** entre les gestes : cibles sémantiques essayées dans
  l'ordre, postconditions `expect`, confirmation (`confirm`, reprise par `approval` après le bouton du chat), connexion
  par `pw_login`, budget (60 gestes, 200 s), annulation, arrêt sans rejeu d'un clic ou d'une
  touche dont l'issue est incertaine. `pw_procedure` liste, lit, enregistre (validation Zod :
  pas de `css=`/`xpath=`, `goto` limité à l'origine, paramètre `creds` réservé à `login`,
  profondeur et taille bornées) et supprime. Tables `ax_procedures` et `ax_procedure_runs`
  (migration `0029_procedures_ax`), purgées avec le compte. `chaineVersSeq` convertit des
  étapes `pw_chain` réussies en procédure (base de l'apprentissage, étape suivante).
  Un clic ou une touche qui a agi n'est jamais rejoué (`retry`, `click`, `press`, `confirm` et `login`
  incompatibles), l'accord ne vaut que pour l'attente enregistrée (nœud, version et empreinte de l'arbre),
  l'origine est vérifiée par le service juste avant chaque geste, `wait_for` est obligatoire dans `login`.
- **Réparation des procédures par le modèle.** Un échec sans effet constaté avant l'action (cible introuvable ou
  ambiguë, élément disparu, option absente, lecture fausse) rend dans `failed_at.repair` le nœud, son intention (nouveau
  champ `note`), les cibles essayées et un instantané compact de la page (candidats sémantiques, aucune valeur de
  champ, contenu présenté comme non fiable) avec un `repair_id` à usage unique. `pw_procedure(action='repair')` valide le
  nœud de remplacement (même origine, aucun login nouveau, `confirm` conservé, `goto` limités aux chemins de l'arbre,
  15 nœuds), enregistre la version suivante (`parent_version`, `repaired_path`, migration `0031_reparation_procedures`)
  et `pw_run(..., resume=repair_id)` reprend au nœud réparé sans rejouer ce qui précède. Au plus 2 réparations par
  exécution et 1 par nœud ; un échec après un geste à effet non confirmé par un `expect` n'est jamais réparable ; un geste
  nouveau, un `goto` remplacé par une autre URL ou une cible changée qui déclenche l'une des gardes (anti-rejeu,
  élargissement de la cible, historique) reçoit `confirm: "once"` (accord demandé jusqu'à une première exécution réussie, approbation
  stockée dans `ax_procedure_approvals`, migration `0032`), un `confirm: true` reste permanent ; les échecs ambigus, `acted_unconfirmed`, `origin_changed` et `login_*` ne sont jamais réparables.
- **Accord humain des gestes sensibles de procédure.** Un geste sous `confirm` ne reprend plus sur un
  `confirmed=[chemin]` fourni par le modèle (retiré, `confirmed_removed`) : `pw_run` crée côté serveur une demande
  d'accord (table `ax_procedure_demandes`, migration `0033`, 15 min, usage unique, liée au compte, à la conversation, à la
  session, à la procédure, à la version, au nœud, à la page et à l'**empreinte du geste après substitution des
  paramètres** : l'accord pour `to=alice` ne couvre pas `to=mallory`). Le chat affiche une carte « Confirmer » (geste,
  cibles, adresse visée, page, premier passage d'un geste réparé) avec Approuver / Refuser ; la décision passe par une route
  de session du compte (`/api/procedures/approbations/:id/decision`), jamais par un outil, puis un message automatique
  « Approuvé : … » relance le modèle, qui rappelle `pw_run(..., approval=<id>)`. L'hôte consomme l'accord par le canal
  interne signé. Les gestes `confirm: "once"` ne sont validés qu'après un accord humain consommé **et** un geste réussi.
  `pw_procedure(save)` ne peut ni retirer ni affaiblir un `confirm` de la dernière version, `delete` refuse une procédure
  qui en porte. Routines et sous-agents s'arrêtent à `needs_confirmation` (demande visible, personne d'autre ne peut approuver).
  La garde de similarité devient un élargissement : un mot de plus de 3 lettres ou un nombre absent de l'ancienne cible
  (« Payer » → « Payer express ») demande `confirm: "once"`. Le moteur résout ses cibles par nom accessible **exact**
  (« Payer » ne clique plus « Payer express ») ; le `pw_act` du modèle ne change pas.
- **`pw_login`** : avec `wait_for`, la connexion n'est réussie que si la cible apparaît avant la fin du budget
  (40 s) ; sinon `login_not_confirmed`. Le clic de soumission n'attend plus la navigation (une page suivante
  lente ne donne plus `login_timeout`).
- **Procédures** : le geste agit sur une poignée figée après contrôle de l'origine (redirection différée sans
  effet), `fill`/`select`/`check`/`uncheck` ne sont plus rejouables (`retry` n'admet que `goto`, `wait`, `hover`),
  l'accord est lié à la page d'arrêt, le compteur de versions ne recule jamais.

### Sécurité

- **Coffre d'identifiants et commande `/creds`.** Les mots de passe de sites ne
  sont plus stockés en clair ni transmis comme arguments d'outil. Chaque compte a
  un coffre chiffré (Fernet) dont les entrées sont liées à une origine exacte ;
  `/creds` donne à l'assistant, pour une conversation, un jeton `⟦creds:…⟧`
  (30 min, 5 usages) que le nouvel outil `pw_login` et `pw_session` (`creds=`) échangent
  avec le core contre la valeur, uniquement pour un champ dont le frame est sur l'origine
  du jeton. L'assistant ne saisit jamais un secret par un geste (`secret=` de `pw_act` et
  `pw_chain` est retiré) : `pw_login` pré-contrôle les champs sans valeur, résout le jeton,
  remplit, valide, attend puis **remplace les documents** qui ont reçu le secret (navigation
  GET, jamais un rechargement ; échec fermé : page puis session fermées) en une requête, sans rendre
  la main au modèle ni servir d'autre requête de la session entre-temps. Les résultats d'outils sont
  nettoyés des valeurs résolues. `pw_login` n'existe que dans une **session
  sécurisée** (`pw_session(action='start', secure=true)`, ou `creds=`), décidée à
  l'ouverture : navigateur dédié (presse-papiers isolé), toujours neuf (erreur si le quota
  est atteint, rien n'est fermé), routes en liste blanche, copier-coller et glisser
  refusés, requêtes vers une autre origine interrompues si le certificat est toléré, certificats vérifiés (sauf « Certificat non vérifié accepté » sur l'entrée,
  qui exige le mot de passe, signalé dans chaque réponse), sans `eval`, interception,
  `pw_mock`, `poll_until`, `dispatch_event`, trace, HAR, vidéo, PDF, état sauvegardé
  ni enregistreur, avec des cibles sémantiques seulement (pas de CSS ni de XPath),
  des champs mot de passe jamais lus et masqués sur toutes les captures, un journal
  réseau sans corps de requête. Le champ est contrôlé (visible, unique, type réel,
  frame de l'origine) par un pré-contrôle sans valeur avant que le jeton ne soit
  résolu ; le type est revérifié après la saisie.
  La requête qui porte le secret, exécutée par le service, passe par le relais filtrant
  (adresse jugée et épinglée par le relais, refus rendu `blocked`) ; un `stop` pendant la
  connexion ferme la session sans attendre ; la connexion finit toujours (post-traitement
  compris, 62 s au plus) avant l'échéance de 75 s de l'hôte d'outils.
- **Identifiants HTTP du navigateur liés à une origine.** `httpCredentials`
  porte toujours `origin` : plus d'envoi à un serveur tiers qui répondrait 401.
- **Mémoire AX : plus d'identifiants.** `pw_session` n'injecte ni n'enregistre plus
  d'identifiants par « site normalisé » (qui fusionnait les IP privées d'un même
  port) et l'indice du prompt ne cite plus l'identifiant. Les instantanés du
  service navigateur ne renvoient plus la valeur d'un champ `type=password`.

### Pour l'exploitant

- **Migration `0027_coffre_identifiants`.** Les lignes de `ax_credentials` sont
  chiffrées au démarrage du core dans le coffre du compte, sans origine et « à
  confirmer » (inutilisables avant confirmation dans Paramètres › Coffre), puis la
  table est supprimée ; un hôte d'outils à base séparée supprime la sienne (mots de
  passe à ressaisir). `0028_coffre_certificat` ajoute le drapeau de certificat. L'API `/api/ax/*` n'expose plus d'identifiants
  (`DELETE /api/ax/sites/{site}/credentials` et `include_credentials` retirés) ;
  l'administrateur ne gère pas le coffre des comptes.
- **Habillages personnels : `skins.user_custom` et `skins.user_max`.** Actifs
  par défaut, 10 par compte, réglables dans la console (Apparence). Rangés dans
  `SKINS_DIR/_comptes/<id>/`, inclus dans les sauvegardes, effacés avec le
  compte ; visibles et applicables par leur seul propriétaire.
- **Outils intégrés `routine_save` et `ask_user`.** `routine_save` (réglage du
  compte « Créer des routines », actif par défaut) crée une routine en pause avec
  les mêmes contrôles que l'API ; il est absent en mode plan, dans le Studio, les
  routines et les sous-agents. `ask_user` quitte la famille MCP `skill` et
  devient un outil intégré du tour : un client MCP externe de la famille
  `skill` ne le voit plus.
- **Skills livrés : les assistants seulement.** Les paquets génériques ansible,
  python et robotframework ne sont plus livrés ; la bibliothèque intégrée garde
  les skills d'assistant (création de skill). Un compte ou un administrateur
  qui s'en servait les réimporte comme skills personnels ou globaux.
- **Suppression d'un compte : données rangées par nom effacées.** Ses skills
  personnelles (et leur copie dans le bac), sa mémoire, son cache de
  graphiques et ses identifiants de sites enregistrés dans la base du core
  sont effacés, même quand son bac est conservé, pour qu'un compte recréé
  sous le même nom n'en hérite pas.
- **Service navigateur : Playwright 1.64** (Chromium 156, révision 1248). Le
  Chromium de la version précédente ne convient plus : relancez `./install.sh`
  (réseau requis) ou, hors ligne, installez le paquet hors ligne de la nouvelle
  version (`make_release.sh` y place le Chromium attendu). Les paquets apt
  requis ne changent pas.
- **Formulaires : taille totale bornée.** Un envoi multipart (avatar,
  transcription, extraction de texte, import de skills, restauration…) est
  refusé (413, connexion fermée) quand ses parties réunies dépassent le
  plafond du corps (100 Mo), augmenté du plafond par fichier propre à la
  route. Le dépôt d'un serveur MCP par l'administrateur, fait en une seule
  requête, garde son plafond par fichier (`APP_MAX_UPLOAD_MB`) sans total.

- **Suppression d'un compte : identifiants de sites purgés sur les hôtes
  d'outils.** La console appelle la route interne
  `POST /api/internal/account/purge` de chaque hôte d'outils déclaré, dont la
  base peut être distincte de celle du core : mettez à jour les hôtes distants
  avec le core. Un hôte qui n'a pas pu être purgé est signalé par la console.

### Interface

- **Questionnaire de l'assistant dans la barre de saisie.** Les questions
  `ask_user` s'affichent dans la carte du composeur : options en lignes avec
  leur touche (1 à 9), rond pour un choix, case pour plusieurs, la zone de
  saisie comme réponse libre. Entrée pour avancer, Échap pour fermer, puce
  « Reprendre le questionnaire » ; le brouillon en cours est mis de côté puis
  rendu. « + » et dictée restent disponibles.
- **Habillages personnels.** Paramètres › Apparence › « Mes habillages » : chaque
  compte crée ses habillages avec l'assistant (skill `apparence`). Le modèle
  propose un bloc de jetons ; une carte le vérifie, un aperçu isolé le montre en
  clair et en sombre avec ses contrastes, et l'import reste un clic de
  l'utilisateur. Jetons seulement (aucun CSS), contraste AA exigé.
- **Assistant de routine.** Bouton « Assistant » de la page Routines et commande
  `/routine` : le modèle mène un court entretien, puis crée la routine avec
  l'outil intégré `routine_save`, toujours en pause ; on la relit et l'active
  depuis Routines. Cadrage, lanceur et bouton « Assistant » sont communs aux
  assistants (skill, routine).
- **Paramètres revus.** Rail en quatre groupes avec recherche ; chaque réglage
  s'enregistre à la modification, avec Annuler ; aide d'une ligne à la
  demande ; texte d'au moins 12 px et contraste AA dans tous les thèmes.
- **Console d'administration.** Navigation dépliée avec recherche des pages,
  Images et Voix en sous-onglets, tableau des comptes avec tri, filtres et
  actions groupées ; un échec de chargement n'est plus lu comme une liste vide.
- **Composeur.** Rangée courte avec puces d'état, « + » en catalogue, un seul
  menu « Conversation », menu du compte dans le pied du volet ; Annuler après
  un archivage, confirmation avant une suppression.
- **Fil du tour.** Réflexion, texte et étapes de chaque appel du modèle à leur
  place ; sous-agents en lignes, avec un volet (consigne, déroulé, bilan,
  rendu) ; tâches de fond dans le fil, et la réponse reprend au réveil dans la
  même bulle. Le rechargement montre ce que le direct montrait.
- **Affichage du chat au choix** (Paramètres › Chat › Affichage) : déroulé
  du tour (Classique par défaut, En bloc, Chronologie, Journal), contexte
  (jetons utilisés / fenêtre par défaut, bloc, pourcentage, anneau),
  réflexions, métriques du pied et densité. L'option « Interface classique »
  disparaît : la nouvelle disposition est la seule.
- **Captures web à la demande**, rattachées à leur étape ; réglage « Masquer
  les captures web ».
- **Graphiques** tracés seulement dans la réponse finale ; un graphique
  qu'elle ne cite pas s'affiche à sa suite.
- **Bibliothèque** : « Plus › Bibliothèque » ouvre directement les images
  générées du compte.
- **Menu du modèle** épuré ; réglages de génération en sections nommées.

### Moteurs vLLM et SGLang

- **Appels d'outils multiples : plus d'étape fantôme.** Quand SGLang réutilise
  le numéro d'un appel (nom d'outil inconnu au milieu d'un lot, parseurs qui
  numérotent par outil), deux appels ne fusionnent plus en un nom collé
  (« read_filelist_dir ») aux arguments invalides. La progression et les
  journaux d'un outil lancé plusieurs fois en parallèle s'affichent sous le bon
  appel, et le statut « Appel d'outil » donne la taille des arguments reçus.
  Rechargez les onglets ouverts après la mise à jour.
- **Parseur d'appels d'outils.** La documentation donne le parseur SGLang de
  chaque format (`qwen25`, `qwen3_coder` pour Qwen3-Coder, `glm45`, `glm47`,
  `kimi_k2`…) ; la sonde signale un parseur qui ne correspond pas au modèle
  servi, et une réponse vide après la réflexion alors que des outils étaient
  offerts (parseur d'outils ou de réflexion à vérifier).
- **Débits d'un appel.** Pour vLLM et SGLang, qui ne rendent pas de `timings`,
  Elpis mesure le délai du premier jeton et la génération : le débit
  d'écriture n'inclut plus le prefill, et le débit de lecture s'affiche quand
  le serveur rapporte les jetons repris du cache
  (`--enable-prompt-tokens-details`, `--enable-cache-report`).
- **Charge de SGLang.** La ligne de charge ajoute le débit de prefill et le
  délai du premier jeton (`--enable-metrics`) ; la jauge KV additionne les
  répliques `--dp`.
- **Jauge de contexte fidèle.** L'occupation n'est plus bornée à la fenêtre
  connue (un prompt réel plus long s'affichait « 131k / 131k »), en direct
  comme après rechargement ; un avis signale le dépassement quand la fenêtre
  vient du moteur ou du connecteur. Pendant la génération, les jetons reçus
  depuis la dernière mesure s'affichent à part. Un moteur qui annonce sa
  fenêtre n'est plus deviné au nom du modèle : s'il ne l'annonce pas, la
  compaction reste inactive (avertissement au journal).
- **Raisonnement conservé avec SGLang**, désactivé par défaut : l'interrupteur
  des réglages de génération est offert quand le serveur a un
  `--reasoning-parser`. Activé, la réflexion de chaque appel d'outil du tour
  repart au moteur, comme l'attendent les gabarits Qwen3, GLM-4.5/4.6 et
  MiniMax-M2 ; le prompt d'un tour d'outils s'allonge d'autant et la question
  suivante recalcule ces appels. Cette réflexion n'est jamais enregistrée.

## 0.1.1 — 2026-10-22

**Moteurs vLLM et SGLang.** Le type de moteur écrit dans `config.json`
(`llama.engine`) fait foi : Elpis applique le profil de ce moteur (adresses,
capacités, métriques, dialecte de requête) au lieu de traiter tout ce qui
n'est pas llama.cpp comme un service OpenAI-compatible sans capacité. La
réflexion des modèles servis par vLLM ou SGLang s'affiche dans le chat. Les
anciens `config.json` marchent tels quels. Détail : docs/configuration.md,
« Moteur d'inférence déclaré ».

**RAG intégré.** Le RAG passe dans le core : chaque compte range ses
documents dans des collections, les publie à ses groupes ou à tous les
comptes, et les interroge depuis le chat, sources citées à l'appui. Seule la
lecture des documents reste en Python, dans l'extracteur `rag_app`.

### Pour l'exploitant

- **Agent de bureau : jeton obligatoire.** L'agent exige
  `Authorization: Bearer <jeton>`, refuse toute requête portant un en-tête
  `Origin` et tout corps qui n'est pas `application/json`. Sur chaque machine
  pilotée, relancez l'installation (`install_agent.sh`, `run.bat` ou `run.ps1`) :
  elle génère `agent_token.txt` et affiche le jeton, à saisir dans Console ›
  Connexions › Machines (champ « Jeton ») ou, pour toutes les machines, dans la
  variable `DESKTOP_AGENT_TOKEN` du service d'outils. Un agent mis à jour sans
  réinstallation génère `agent_token.txt` à son démarrage et écrit le jeton dans
  son journal (`journalctl --user -u desktop-agent`). `DESKTOP_AGENT_INSECURE=1`
  (déconseillé) démarre sans jeton. Ses dépendances sont figées (`==`).
- **`.env` lu comme des données.** `./elpis` lit chaque ligne `CLE=VALEUR`
  (clé en majuscules, chiffres et `_`) sans l'exécuter : `$VAR` et `$(…)` ne
  sont plus développés. Vérifiez vos `.env` s'ils en contenaient.
- **Liste blanche IP du bac.** En profil réseau `allowlist_ip`, une commande, le
  terminal ou l'agent du bac sont refusés si `setpriv` ne peut pas retirer
  `net_admin`. L'image du bac doit fournir `setpriv` (util-linux) et
  `exec_user` doit être de la forme `uid:gid`.
- **Installeurs de poste.** Ils vérifient l'empreinte SHA-256 de la CA locale
  publiée par le serveur avant de l'épingler ou de l'installer. Si
  `ELPIS_CA_FILE` ou `security.https.ca_file` ne désigne pas la CA réellement
  servie, le script la refuse ; sans CA lisible côté serveur, rien n'est installé.
- **`./elpis configure`** refuse un domaine ou une adresse Let's Encrypt
  invalides.
- **Paquet hors ligne.** Notices et licences à la racine,
  `wheels/LICENCES-PYTHON.txt`, `sbom/` (CycloneDX), `sandbox/SOURCES.txt` et
  offre écrite pour les composants GPL ; options `--with-sources` et `--sign`
  (clé : `ELPIS_SIGN_KEY`). Détail : docs/exploitation.md.
- **Mots de passe** : un retour à une version antérieure rend illisibles les
  comptes déjà rehachés (réinitialiser leur mot de passe).

- **Python allégé.** Les modules Python des familles `shell`, `git`, `memory`,
  `skill`, `todo`, `browser` et `desktop`, la mémoire et les skills de
  `llm_core`, le stockage des conversations, les notifications et le contrôle
  d'écran de `shared_infra` partent, ils n'étaient plus appelés. Les familles du
  compte (`chart`, `memory`, `skill`, `todo`) sont servies par main d'après `mcp.json` : sans ce fichier (`./elpis configure`
  l'écrit), l'hôte d'outils ne les sert plus non plus, et le dit au démarrage.
  `--stdio` refuse (code 2) quand aucune famille demandée n'est servie.
- **Moteur Office dans `office/`.** Le moteur des documents Word et PowerPoint
  (`office/elpis_office/`, anciennement `llm_core/tools/_office` et `_chart`)
  est un paquet Python autonome, avec ses dépendances dans
  `office/requirements.txt` (incluses par `requirements.txt`).
- **Office servi par l'hôte d'outils.** La famille `office` rejoint les familles
  portées en TypeScript : l'hôte lance un worker
  Python (`python -m elpis_office`) pour construire les documents, et fait
  lui-même la lecture et l'écriture des fichiers du bac (écriture gardée,
  historique, verrou de l'éditeur), les graphiques, l'export PDF et le rendu
  ECharts. Même contrat d'outils, mêmes erreurs. `./elpis doctor` vérifie les
  dépendances du moteur. `ELPIS_OFFICE_PARALLELE` borne les appels simultanés
  du worker.
- **elpis-tools retiré.** Le service `tools` (port 8767, `--elpis-tools`,
  `server/local_mcp_server.py`), `llm_core/` (hors `imagegen/`) et les modules
  de `shared_infra` que seul il appelait partent, ainsi que le relais de l'hôte
  d'outils vers lui. `mcp_upstream`, `mcp_upstream_sse` et
  `TOOLHOST_MCP_UPSTREAM[_SSE]` sont ignorés avec un avertissement, l'unité
  `elpis-tools` est retirée par `./elpis service install` et
  `install_toolhost.sh`. Sous systemd, relancer `sudo ./elpis service install`
  après `./elpis upgrade`. `--familles-relayees` (aucune famille) et
  `--elpis-tools` (sort aussitôt) restent acceptés pour qu'un ancien `./elpis`
  ou une ancienne unité n'y lance pas un second hôte. `familles_natives` de
  `toolhost.json` est ignoré avec un avertissement : l'hôte sert toute famille
  portée en TypeScript de `families` (un hôte distant installé depuis l'ancien
  exemple, dont la liste omettait `office`, sert donc Office après la mise à
  jour : `office/requirements.txt` doit être installé dans son venv, ce que
  `install_toolhost.sh` fait) ; pour ne pas servir une famille, la retirer de
  `families`. Le réglage `mcp.server_cmd`, que rien n'utilisait, quitte la
  console. `requirements.txt` ne garde que ce que le Python restant importe.
- **Python sans appelant retiré.** `llm_core/imagegen/` et `shared_infra/image/`,
  `shared_infra/mcp/`, `git/`, `accounts/tokens.py`, `llm/engine_access.py`,
  `runtime/runtime_dir.py`, `security/browser_url.py`, `memory/store.py` et le
  code de la mémoire AX hors mise à niveau des anciennes tables partent : seule
  `delete_user_full`, que rien n'appelait (la suppression d'un compte est dans
  le core TypeScript), les atteignait. `psutil` et `jsonschema` quittent
  `requirements.txt`.
- **Python : réglages et fonctions sans lecteur retirés.** `shared_infra/config.py`
  ne garde que `config.json` (lecture en cache, écriture atomique) et les
  réglages de la base ; les quelque 150 autres réglages, que seuls lisaient des
  modules déjà retirés, partent, ainsi que la création du secret de session à
  l'import (le core TypeScript et `./elpis configure` s'en chargent), l'assistant
  de bascule de base de `ops/` (porté dans le core), les fonctions de comptes,
  de connecteurs et de dialecte SQL sans appelant, et `env_compat`.
- **`llama.engine` : `vllm` et `sglang`.** Valeurs admises : `llamacpp`
  (défaut ; alias `llama.cpp`, `llama-cpp`, `llama`), `vllm`, `sglang` et
  `generic` (alias `openai`, `tgi`, `ollama`, `lmstudio` ; toute autre
  valeur vaut `generic`). Aucun moteur n'est deviné. Pris en compte au
  redémarrage ; variable `LLAMA_ENGINE`.
- **`llama.url` : la base du serveur** (`http://hôte:port`). Une adresse
  qui finit par `/v1` ou `/v1/chat/completions` reste acceptée et
  normalisée ; sans `url`, `ip` et `port` servent comme avant.
- **`llama.api_key`** (facultative, `LLAMA_API_KEY` prioritaire) : la valeur
  de `--api-key` du serveur, envoyée en `Authorization: Bearer` sur chaque
  appel au moteur par défaut. Elle n'apparaît dans aucun journal, n'est
  jamais recopiée dans la configuration d'un compte et la console ne la
  rend jamais : `********` à l'écran et dans l'éditeur brut, valeur du disque
  gardée quand ce masque revient, « clé modifiée » dans le détail des
  modifications.
- **Sonde du moteur et conseils de lancement.** Au démarrage, `main` sonde
  le moteur déclaré et journalise une ligne `[moteur]` (version, modèle
  servi, contexte, métriques, tokenisation exacte, concurrence), puis chaque
  option manquante avec le drapeau exact : `--reasoning-parser`,
  `--enable-auto-tool-choice --tool-call-parser`,
  `--enable-prompt-tokens-details` (vLLM), `--enable-cache-report` et
  `--enable-metrics` (SGLang), clé refusée, modèle non servi. Console ›
  Inférence › Capacités montre le même rapport, et « Tester » le refait.
  Pendant le chat, une réflexion reçue en balises, des appels d'outils reçus
  en texte ou des jetons en cache non rapportés ajoutent leur conseil, une
  fois par moteur.
- **Concurrence** : vLLM et SGLang regroupent eux-mêmes les requêtes
  (`--max-num-seqs`, `--max-running-requests`) ; Elpis ne les met plus en
  file, ni pour le moteur par défaut ni pour un connecteur (fin du « une
  requête à la fois » d'un connecteur vLLM au champ « Requêtes » vide).
  `llama.max_concurrency` ne s'applique qu'à llama.cpp.
- **Connecteurs `sglang`** : préréglage « SGLang (local) », réservé aux
  connecteurs partagés comme `vllm`. Les connecteurs `vllm` et `sglang`
  suivent le même profil que le moteur par défaut (contexte, jetons exacts,
  métriques, pas de file) ; leur test peut joindre le rapport de la sonde.
- **Installeur** (`./install.sh`, `./elpis configure`) : type SGLang ; port
  par défaut qui suit le type tant qu'aucune adresse n'est saisie (8080,
  8000, 30000 ; le 8000 local, aussi celui du service RAG, est signalé) ;
  clé API facultative, saisie masquée (`--llm-api-key`,
  `ELPIS_CFG_LLM_API_KEY`), écrite sous `llama.api_key` ; nouvelle adresse
  écrite en base du serveur, seules les valeurs changées sont réécrites.
  La note finale rappelle les drapeaux conseillés pour vLLM et SGLang, et
  `logs/install.log` comme le plan `--dry-run` masquent désormais les
  valeurs de `--llm-api-key`, `--cloud-api-key` et `--admin-password`.
- **`./elpis doctor`** sonde `GET /v1/models` avec la clé (« clé refusée
  (HTTP 401) » le cas échéant), rappelle les drapeaux conseillés pour vLLM
  et SGLang et, si `main` tourne, affiche sa dernière sonde du moteur (lignes
  `[moteur]` du journal, depuis le dernier démarrage).
- **L'ancien RAG est supprimé à la mise à jour, sans import** : collections
  Qdrant qui ne sont pas `elpis_*`, `rag_app/DATA/`, `rag_app/OCR_STORE/`,
  `rag_config.json`, `rag_state.json`, `rag_ocr_state.json`,
  `rag_traces.json`. Avant la mise à jour : `./elpis backup full`, et une copie
  de `rag_app/DATA/` pour garder ces documents (ils n'ont jamais été dans les
  archives). Les réglages d'embeddings, de reclassement et d'OCR passent dans
  `config.json › rag`. Procédure : docs/exploitation.md, « Passage au RAG
  intégré » (`./install.sh --yes --service` ; après un `./elpis upgrade`,
  `sudo apt install bubblewrap` puis `sudo ./elpis service install`).
- **Configuration** dans `config.json › rag`, relue à chaud : magasin,
  Qdrant, embeddings, reclassement, OCR, groupes autorisés, quotas par compte,
  indexation (docs/configuration.md, « RAG »). La console (Modèles & services ›
  RAG) teste les services, règle droits et quotas, liste toutes les
  collections sans en montrer le contenu, relance la réindexation après un
  changement de modèle d'embedding et suit les travaux.
- **Extracteur** : même service `elpis-rag` et même port 8000, en local
  seulement ; ses analyses et LibreOffice tournent dans une prison bubblewrap
  (le paquet rejoint le socle des prérequis). Caddy n'a plus de site `:8444`
  (`sudo deploy/caddy/install_caddy.sh` le retire d'une installation
  existante).
- `./elpis doctor` vérifie l'extracteur et son isolation, le magasin partagé
  et le jeton, Qdrant, le serveur d'embeddings et l'OCR.
- **Sauvegardes** : le magasin `user_db/rag` (documents et textes extraits)
  entre dans l'archive complète ; ni le cache de l'extracteur ni l'index
  Qdrant, que la réindexation de la console reconstruit après une
  restauration sur une autre machine.
- **Suppression d'un compte** : ses collections, ses fichiers et ses vecteurs
  disparaissent ; les comptes qui lisaient ses publications sont prévenus.

### Pour l'utilisateur

- **PowerPoint : supprimer puis ajouter des diapositives.** `pptx_edit` ne
  produit plus de fichier que PowerPoint propose de réparer (une diapositive
  écrite deux fois dans le paquet) après une suppression suivie d'un ajout ; les
  liens internes vers une diapositive supprimée sont retirés des autres.
- **Réflexion visible avec vLLM et SGLang.** La réflexion envoyée par vLLM
  (champ `reasoning`) s'affiche dans son bloc, en direct, comme celle de
  SGLang et de llama.cpp. L'interrupteur Réflexion et le choix de l'effort
  sont offerts sur ces moteurs, et la réflexion se coupe vraiment quand
  l'interrupteur est éteint (`enable_thinking` envoyé au gabarit). `top_k`,
  `min_p` et la pénalité de répétition sont transmis au lieu d'être retirés.
- **Serveur lancé sans `--reasoning-parser`** : la réflexion d'un modèle qui
  n'écrit que `</think>` s'affiche d'abord dans la réponse, puis passe dans
  son bloc à la fin de l'étape, dans la bulle comme dans le message
  enregistré.
- **Sélecteur de modèle selon le moteur** : ni « Charger » ni « Décharger »
  sur vLLM et SGLang ; contexte lu sur le moteur (`max_model_len`), jauge du
  cache KV et ligne de charge (requêtes en cours et en attente, débit, cache
  de préfixe), aussi pour un connecteur vLLM ou SGLang ; pied « En ligne ·
  vLLM ».
- **Barre de saisie : le nom du modèle seul.** Le serveur (vLLM, SGLang,
  connecteur…) n'y est plus accolé : les sections du menu le montrent déjà,
  et il reste dans l'infobulle.
- **Page RAG** (barre latérale, sous-menu « Plus ») : collections, dépôt de
  fichiers et de dossiers, import depuis la sandbox, progression de
  l'indexation, onglet Tester (passages que l'assistant recevrait), réglages
  (description lue par l'assistant, découpage, OCR des documents scannés).
- **Publication** : privée, groupes dont on est membre, ou tous les comptes
  (administrateurs) ; ouverture des documents sources au choix ; les lecteurs
  cherchent sans rien modifier et peuvent masquer une collection de leur liste.
- **Chat** : collections actives en pastilles au-dessus de la saisie,
  « Discuter avec », commande `/rag` (`use`, `off`, `search`, `add`, `new`,
  `status`, `open`), outils `rag_search`, `rag_read`, `rag_list` et
  `rag_index`. Les renvois deviennent des pastilles numérotées, avec une bulle,
  un pied de sources et une visionneuse (page réelle avec le passage surligné,
  texte extrait, original si le propriétaire l'a permis).
- Le panneau « Sources RAG » de la saisie et l'interrupteur RAG des
  Paramètres disparaissent.
- **Barre latérale** : RAG, Studio et Remote code rangés dans le sous-menu
  « Plus » ; liste des chats plus nette (titres sur toute la largeur, section
  « Conversations » avec recherche et sélection), coins arrondis côté chat.
- **Nouveau chat** : zone de saisie sur deux lignes. Panneau MCP : la section
  « Locaux » devient « Internes ».

### Sécurité

- Un contrôle d'accès aux moteurs (chat, compression, routines) qui échoue
  refuse l'accès (503 au chat) au lieu de l'accorder ; des politiques
  illisibles ne donnent plus accès à tous les serveurs.
- Mots de passe hachés en PBKDF2-SHA256 à 600 000 itérations, au format
  `pbkdf2_sha256$600000$sel$empreinte` ; les anciens hachages restent valides
  et sont rehachés à la connexion.
- Enveloppe d'identité interne typée ; un corps portant une audience est
  refusé (un hôte d'outils distant plus ancien reste accepté).
- Le plafond `MAX_RUNS_PER_USER` est recontrôlé à la prise du verrou ; l'erreur
  de flux ne renvoie plus le message d'exception brut.
- L'agent de la sandbox refuse un `Content-Length` invalide (400) et limite les
  connexions simultanées (503).
- Le style en ligne du HTML rendu dans les messages est limité à des
  propriétés de présentation (le SVG est inchangé).
- Cookie de session effacé avec `HttpOnly` et `Max-Age=0` ; clé HMAC d'audit
  mesurée après retrait des blancs.
- Droits vérifiés par une seule fonction pour chaque route et chaque outil ;
  une collection invisible répond 404 ; l'administrateur ne lit jamais une
  collection qui ne lui est pas ouverte.
- Passages, noms et descriptions neutralisés avant d'atteindre le modèle
  (balises, jetons de rôle) ; les passages d'un autre compte portent son nom.
- Dépôts bornés par le quota de stockage du compte ; lectures passage par
  passage plafonnées pour un lecteur qui n'a pas accès aux sources.
- Secrets de `config.json` : une seule liste pour le masque du serveur et de
  la console, clé de l'OCR et jetons clients du pont MCP compris.
- Dépendances aux failles connues mises à jour : Vue 3.5.44 (XSS du rendu
  serveur), Mermaid 11.17.2, DOMPurify 3.4.17, pypdf 6.21.2, Pillow 13.0.0,
  cryptography 50.0.2 et starlette 1.3.1 ; `npm audit` et `pip-audit` ne
  signalent plus de faille haute.

### Conformité

- `CODE_OF_CONDUCT.md`, `AUTHORS`, `TRADEMARKS.md`, `REUSE.toml`, DCO
  (`git commit -s`) et politique sur le code assisté par IA dans
  `CONTRIBUTING.md`.
- CI : Dependabot, CodeQL, jobs `audit` et `reuse` non bloquants, actions
  épinglées par SHA.
- Textes de licence des composants tiers déplacés dans `THIRD_PARTY_LICENSES/` ;
  `LICENSES/` ne garde que les licences SPDX du projet (conformité REUSE 3.3).

## 0.1.0 — 2026-10-18

**Le core d'Elpis est réécrit en TypeScript.** L'application (main), la
console d'administration et l'hôte d'outils tournent sur Node.js 24, avec la
même API, la même base et les mêmes fichiers de configuration que la 0.0.1.
L'interface est en TypeScript et en composants Vue précompilés, sans
compilateur Vue au chargement, sous une politique de sécurité du contenu
(CSP). Restent en Python : le service RAG, elpis-tools (documents Word et
PowerPoint), l'agent des sandboxes, l'agent de bureau Windows et l'assistant
d'installation (`./elpis configure`). Les écarts de comportement voulus avec
la version Python sont listés dans docs/ecarts-python.md.

### Pour l'exploitant

- **Node.js 24 installé par Elpis.** `install.sh` place le runtime officiel
  Node.js 24.21 dans `node/` (somme SHA-256 figée dans
  `deploy/node/node.env`, sans npm) et construit les bundles du core
  (`apps/core/dist`), de l'hôte d'outils (`apps/toolhost/dist`) et du
  frontend. Sans paquet hors ligne, la construction demande `build-essential`
  et `python3` (groupe apt `construction-hote`). Le paquet hors ligne de
  `make_release.sh` contient le runtime et les bundles construits pour son
  architecture.
- **Mise à jour depuis la 0.0.1** : pas par `./elpis upgrade`, dont le
  script de la 0.0.1 relance le core Python retiré et sort en erreur (service
  arrêté). Commit de départ noté (`git rev-parse --short HEAD`),
  `./elpis backup full`, services arrêtés (`sudo systemctl stop elpis.target`
  ou `./elpis stop`), `git pull --ff-only`, puis
  `./install.sh --yes --service` (`--start` sans systemd ; hors ligne,
  `--offline <paquet>`), qui garde `config.json`, `.env` et la base, et
  `./elpis doctor`. Détail : docs/exploitation.md, « Mettre à jour ».
- **Une connexion à refaire.** Le cookie de session change de format : celui
  de la 0.0.1 est ignoré sans erreur (page de connexion), une connexion
  suffit ; de même au retour vers la version Python. Jetons d'API et
  d'opencode et accès OAuth restent valides.
- **Services** : `tools` (elpis-tools, `127.0.0.1:8767`) rejoint `qdrant`,
  `rag`, `toolhost`, `main`, `admin` et `browser` ; plus de gunicorn.
  Après la mise à jour, `sudo ./elpis service install` réécrit les unités.
- **Fournisseurs cloud fermés par défaut aux comptes non administrateurs.**
  Sans `llm.allowed_provider_types`, ces comptes ne branchent plus de
  fournisseur cloud avec leur propre clé, et leurs connecteurs cloud
  personnels cessent de servir. Les connecteurs partagés et ceux des
  administrateurs ne changent pas. Pour garder l'ancien comportement :
  Console › Modèles › Accès utilisateurs › Fournisseurs autorisés.
- **Retour à la version Python** : tag `python-final`, procédure dans
  docs/exploitation.md, « Revenir à la version Python (tag `python-final`) ».

### Changements

- **Le core Python est retiré.** main et admin ne tournent plus que sur le
  core TypeScript (`apps/core/dist/main.mjs`) : `server/app.py`,
  `admin_app.py`, les confs Gunicorn, `chatbot_app/` et le moteur Python
  (boucle, contexte, ordonnancement, routes) sont supprimés, `gunicorn` quitte
  `requirements.txt`. L'ancien hôte d'outils Python (`python -m toolhost`) et
  les routes Python de la sandbox, du terminal et du bureau partent aussi ;
  `ELPIS_TOOLHOST=python` et `ELPIS_CLI=python` dans `.env` sont ignorés
  (`./elpis doctor` le signale).
- **Familles d'outils natives par défaut** : sans clé `familles_natives`
  dans `toolhost.json` (ou sans ce fichier), l'hôte d'outils Node.js sert
  lui-même toutes les familles portées en TypeScript (browser, desktop, fs,
  git, shell, skill_run) ; elpis-tools ne garde que les autres (office). Une
  liste explicite, même vide, est respectée : une famille portée qui n'y
  figure pas est relayée à elpis-tools. `./elpis doctor` affiche les
  familles natives effectives.
- **Commandes d'exploitation par le core Node.js.** `./elpis backup`,
  `./elpis db`, `./elpis browser`, la sauvegarde de `./elpis upgrade` et les
  contrôles de `./elpis doctor` (base joignable, verrous de fichiers,
  bubblewrap, serveur LLM, états du navigateur) passent par
  `apps/core/dist/exploitation.mjs` ; options, sorties et codes de sortie
  inchangés. La sauvegarde de la console et l'envoi distant planifié lisent
  le `/work` des comptes par l'agent de leur sandbox. Détail :
  docs/exploitation.md.
- **L'hôte d'outils est le bundle Node.js (`apps/toolhost`).** `./elpis`,
  les unités systemd et le déploiement distant (`deploy/toolhost/`) lancent
  `apps/toolhost/dist/main.mjs` au lieu de `python -m toolhost`. Les familles
  d'outils encore en Python lui sont servies par elpis-tools (service
  `tools`, `127.0.0.1:8767`). Construction : node-pty est compilé par
  `npm ci` (build-essential, python3), le paquet hors ligne contient le bundle
  de l'hôte pour son architecture. **Mise à jour** : après
  `./elpis upgrade`, `sudo ./elpis service install` (unités `elpis-tools` et
  hôte Node.js) ; hôte distant : relancer `install_toolhost.sh` (deux unités).
- **Les outils liés au compte (mémoire, tâches, skills, graphiques) sont
  servis par main lui-même** : l'hôte d'outils ne les sert plus, et
  `/api/mcp-bridge/<famille>` les sert directement. `mcp.example.json` les
  déclare en entrées `inprocess`. Les familles relayées ne sont plus servies
  en SSE (`mcp_upstream_sse` non lancé) : l'export SSE de la console les
  signale omises. Détail : docs/exploitation.md.
- **Connecteurs LLM : fournisseurs cloud fermés par défaut aux comptes non
  administrateurs** (`llm.allowed_provider_types` absente ou vide = aucun ;
  la 0.0.1 les ouvrait tous). Les administrateurs ne sont pas soumis à la
  liste, les types locaux restent réservés aux connecteurs partagés.
  Réglages › Modèles IA ne propose que les types ouverts et marque « fermé
  par l'administrateur » un connecteur existant d'un type fermé. Détail :
  docs/configuration.md, « Fournisseurs cloud des comptes ».
- **Identifiants git posés par l'agent** (famille `git` native de l'hôte
  d'outils) : `git_set_credential` et `git_clone` avec identifiant
  n'enregistrent un connecteur que pour un hôte (port compris) déjà présent
  dans les Connecteurs Git du compte ou d'un administrateur ; sinon l'agent
  reçoit `host_not_registered` et demande d'ajouter le connecteur dans
  Réglages → Connecteurs Git. Ils ne mettent à jour que les connecteurs créés
  automatiquement (`auto`), jamais un connecteur saisi dans Réglages ou importé
  (`connector_exists`). Un ancien `.git-credentials.json` du bac suit la
  même règle (le fichier est gardé si un hôte est refusé). Le clone de
  l'éditeur n'est pas concerné.

### Ajouts

- **Documents Word et PowerPoint de la sandbox : sept outils.** Famille
  `office` : `docx_create`, `docx_read`, `docx_edit`, `pptx_create`,
  `pptx_read`, `pptx_edit`, `office_export` (PDF).
  - Les fichiers sont lus et écrits dans `/work`, par l'agent de la sandbox,
    avec l'écriture gardée de `write_file` (historique, verrou de l'éditeur) ;
    ils apparaissent dans la carte des fichiers modifiés et s'ouvrent dans
    l'éditeur avec l'aperçu Office. Chemin cadré : extension imposée et
    corrigée, nom nettoyé, un fichier existant est remplacé (version
    précédente dans l'historique).
  - Word : contenu en Markdown, plus `!id` (graphique), encadrés
    `> [!NOTE]`, `[TOC]`, `\newpage` ; page de garde, sommaire, en-tête,
    pied, numéros de page, filigrane, modèle .dotx de la sandbox.
    PowerPoint : 14 mises en page composées (titre, chiffres clés,
    graphique, chronologie, processus, comparaison…), thèmes, modèle .potx.
  - Modifications par lot en un appel (remplacer, remplir des `{{champs}}`,
    réécrire, insérer après un titre, cellules et lignes de tableau,
    diapos ajoutées, déplacées, dupliquées, notes) ; les numéros se réfèrent
    au fichier tel qu'il était avant l'appel.
  - Graphiques mutualisés avec les outils `chart_*` : natifs et éditables
    quand Word et PowerPoint ont l'équivalent, sinon image ECharts rendue
    côté serveur (Node + LibreOffice isolé).
  - Lecture tolérante (synonymes français, casse), corrections renvoyées au
    modèle, refus guidés et garde-fou anti-boucle, comme les graphiques.
  - Moteurs repris des serveurs MCP docx-mcp et pptx-mcp (MIT), sans état,
    sans réseau, sans Jinja ni matplotlib. Nouvelles dépendances :
    python-pptx (MIT), XlsxWriter (BSD-2-Clause).
  - Installation existante : `./elpis configure`, `./elpis start` et
    `./elpis upgrade` ajoutent à `mcp.json` toute famille de
    `mcp.example.json` qui y manque (`elpis-office` ici), sur le modèle de
    ses entrées d'hôte d'outils (même hôte, même port, mêmes en-têtes) ; une
    famille éteinte, renommée ou exclue reste telle quelle, et
    `./elpis doctor` signale une famille absente.
- **Graphiques : un outil par type, rendu Apache ECharts.** Les quatre outils
  Chart.js et `generate_table` sont remplacés par 30 outils `chart_<type>`
  (barres, courbes, aires, flux, radar, cascade, secteurs, anneau, rose,
  treemap, sunburst, entonnoir, histogramme, boîtes à moustaches, nuage,
  bulles, carte de chaleur, calendrier, coordonnées parallèles, sankey,
  cordes, réseau, arbre, Gantt, chandeliers, jauge, progression, indicateurs,
  tableau).
  - Le modèle donne un tableau de lignes ; les colonnes sont reconnues et le
    serveur construit séries, matrices, nœuds, quartiles et classes. Les
    valeurs finies sont des `enum` (imposés par la grammaire de llama.cpp) ;
    la lecture reste tolérante (casse, synonymes, « 1 234,5 € », CSV,
    colonnes mal nommées) et chaque correction est renvoyée au modèle.
  - Un appel identique à un appel déjà refusé dans la conversation reçoit un
    refus explicite (« ne le renvoie pas tel quel »).
  - Cartes : zoom des longues séries, tableau des données, PNG, agrandir,
    bascule barres / courbe / aire, thème sombre ; ECharts (1,1 Mo) est chargé
    au premier graphique.
  - Banc ornith-1.5-9B (14 demandes × 2) : 28/28 graphiques justes au premier
    appel, contre 16/28 avec les outils précédents.

### Autres changements

- **Base de données : MariaDB/MySQL n'est plus pris en charge** ; SQLite et
  PostgreSQL restent. Le pilote PyMySQL, le choix `--db mariadb-local`
  d'`install.sh` et l'option MariaDB/MySQL de l'assistant, de
  `./elpis configure` et de la console sont retirés. Une instance encore sur
  ce moteur refuse de démarrer, au lieu de repartir sur un fichier SQLite
  vide. **Mise à jour** : en sortir avant, avec la version en place
  (Console › Base de données › « Revenir à SQLite », ou « Migrer et
  basculer » vers PostgreSQL). Détail : docs/exploitation.md, « Mettre à
  jour ».
- **Pièces jointes : les captures réseau (`.pcap`, `.pcapng`, `.cap`) ne sont
  plus analysées.** La route `POST /api/tools/parse-file` et la dépendance
  `dpkt` sont retirées ; une capture déposée dans le chat est refusée avec un
  message.
- **Hôte d'outils : service requis, relais partout.** L'application joint
  toujours l'hôte d'outils en réseau et ne lance plus
  de sous-process stdio du serveur d'outils ; hôte arrêté = outils
  indisponibles (`./elpis doctor` le signale). `relay: true` est posé par
  défaut dans `mcp.json › sandboxHosts` : main relaie vers l'hôte la sandbox,
  le terminal, les captures et les trames, même sur la même machine.
  **Mise à jour** : `./elpis configure` ajoute le relais à un `mcp.json`
  existant. Détail : docs/exploitation.md, « Mettre à jour ».
- **Verrous de fichiers partagés entre processus : nouveau format.** Mémoire
  (`MEMORY.md.lock`, `USER.md.lock`, `.journal.jsonl.lock`), skills
  (`.skills_write.lock`), historique des fichiers, cycle de vie et migration
  `/work` des sandboxes, pose du schéma de la base et nettoyage au démarrage,
  création du secret de session et de la clé de chiffrement : le `flock`
  laisse la place à un fichier créé en exclusif qui porte le PID, la
  machine et l'heure de prise (protocole `elpis.verrou.v1.1`, commun au core
  TypeScript et au Python restant). Le fichier n'existe que pendant la prise ; les anciens
  fichiers vides sont repris à la première écriture ; le verrou d'un
  processus tué est repris aussitôt sur la même machine (ou après un
  redémarrage), sinon après sa péremption (2 min ; les opérations longues,
  comme le cycle de vie des sandboxes ou la pose du schéma, la prolongent
  tant qu'elles travaillent). Une attente de plus de 30 s est journalisée
  avec le détenteur du verrou. Les dossiers de données doivent être sur un
  disque local : `./elpis doctor` signale un NFS ou un CIFS.
  **Mise à jour** : redémarrer ensemble les services d'une même machine
  (`./elpis upgrade` le fait).
- Les graphiques enregistrés avant cette version (configurations Chart.js) ne
  sont plus tracés : la carte invite à les redemander. Chart.js reste utilisé
  par le tableau de bord de la console.
- **Navigateur : états sauvegardés d'avant la 0.0.1 (rupture non signalée
  dans ses notes).** La 0.0.1 range les états de
  `pw_session(action='save_state')` (cookies, stockage local) par compte,
  sous `browser-service/cookies/state_<propriétaire>__<id>.json`. Ses notes
  ne disent pas que les états existants, `state_<id>.json`, ne se rechargent
  plus, ni qu'un état est supprimé 30 jours après son enregistrement, même
  s'il sert (`PW_STATE_MAX_AGE_D`, `0` = jamais). Cette purge a pu effacer
  les plus anciens, et la sauvegarde d'Elpis n'emporte pas ce dossier. Le
  service ne rattache jamais de lui-même un état sans compte : n'importe quel
  compte qui connaîtrait son identifiant obtiendrait la session connectée
  d'un autre.
  **Mise à jour** : `./elpis browser states` liste les états sans compte
  restants (identifiant, date, sites) ; `./elpis browser migrate-states
  COMPTE ID…` rattache ceux d'un compte Elpis (`--all` : tous, s'ils sont
  tous à lui) ; le même `load_state_id` les recharge ensuite pendant 30
  jours. Détail : docs/exploitation.md, « Mettre à jour ».

### Corrections

- **Réinstallation d'un hôte d'outils distant** : `install_toolhost.sh`
  relancé depuis une autre copie du dépôt effaçait `toolhost.json`,
  `Caddyfile.toolhost` et le runtime `node/` de la machine (copie en
  `rsync --delete`). Ils sont maintenant gardés.
- **Historique des fichiers avec un hôte d'outils distant** : la connexion
  ouvre la nouvelle session d'historique sur l'hôte, là où l'éditeur et
  l'assistant notent leurs écritures. Elle était ouverte sur la machine de
  l'application : la session du compte sur l'hôte n'était jamais renouvelée.
  **Mise à jour** : mettre aussi à jour l'hôte d'outils distant ; un hôte
  plus ancien répond 404 (avertissement au journal à chaque connexion,
  session non renouvelée).
- **Relais vers l'hôte d'outils** : l'URL amont est construite depuis le
  chemin brut de la requête ; les segments `..` et les séparateurs encodés
  sont refusés. Les aperçus (`/api/sandbox/pv/…`, `/pvs/…`) relayés portent
  l'identité de leur jeton ; le code de fermeture d'un terminal (session
  expirée, session inconnue) arrive au navigateur.
- **Profil réseau imposé avec un hôte d'outils distant** : l'application
  transmet à l'hôte, dans l'enveloppe d'identité, le profil imposé par
  l'administrateur. Le panneau du bac à sable l'affiche et verrouille le
  sélecteur, et l'hôte refuse tout autre profil, même quand il a sa propre
  base. **Mise à jour** : mettre aussi à jour l'hôte d'outils distant ; un
  hôte plus ancien ignore l'imposition transmise et garde sa base.
- **Ordonnanceur LLM : priorités et routines.**
  - Sur un même modèle, un chat passe avant une routine qui attend un
    créneau. Une routine qui attend depuis plus de 30 s reprend son rang
    d'arrivée.
  - Une routine retenue par la grâce d'un chat (8 s après chaque message)
    passe au plus 30 s après son premier blocage, même sous un flux continu
    de messages. Elle ne subit plus une seconde grâce une fois passée.
  - Un réglage de connecteur modifié à chaud (`max_concurrency`,
    `max_models`) sert les demandes déjà en attente, dans l'ordre de la file
    (chats d'abord).
- **Complétion de l'éditeur (`/api/llm/infill`)** : elle passe par
  l'ordonnanceur complet et ne fait plus changer de modèle sous un chat ou
  une routine.
  - Au-delà de 20 s d'attente, elle répond « Modèle occupé par une autre
    génération — réessayez plus tard. ».
  - Serveur jugé hors service (disjoncteur ouvert) : réponse `ok: false`
    avec l'explication, au lieu d'une erreur 500. Ses échecs de connexion
    comptent pour le disjoncteur.
- **Studio** : quitter le Studio sans action en cours n'affiche plus « Arrêt
  demandé — l'action en cours sur la VM se termine » ; le message reste
  quand une action était réellement en cours.
- **Navigateur** : `pw_session(action='start')` avec le `load_state_id` d'un
  état introuvable ou sans compte rend l'explication du service (comment le
  rattacher, durée de conservation) au lieu de « Session not found », même
  quand le compte a déjà une session ouverte ; un état demandé sur une
  session réutilisée est signalé comme non chargé (`state_loaded: false`).
  Une référence d'élément périmée ou une option de liste introuvable ne sont
  plus présentées comme une session introuvable. Les états sans compte ne
  sont plus purgés ; le service les signale à son démarrage et
  `./elpis doctor` les compte.

## 0.0.1 — 2026-10-04

Première version publiée : chat agentique (outils, sous-agents, mémoire long
terme, skills, serveurs MCP), éditeur de code avec sandbox Docker par
utilisateur et terminal, routines, service RAG, console d'administration ;
installation et configuration interactives en deux commandes.

### Ajouts

- **Tokens par type, partout, au sens des fournisseurs (OpenAI, Anthropic)** :
  l'entrée contient le cache (relu) et la part des outils (définitions, appels
  et résultats re-soumis, estimée), la sortie contient la réflexion.
  - Réglages › Utilisation : une barre par type — Entrée, Cache, Outils,
    Sortie, Réflexion — et une barre par origine.
  - Chat : « cache N % » sur la ligne du message ; infobulle « Entrée … · cache
    … · utile … · outils ≈ … » / « Sortie … · réflexion … · réponse … ».
    Pendant la lecture du prompt, « Prefill… N % · cache M % »
    remplace « Réflexion… N % », sur l'entrée utile, aussi sans outils et sur
    « Continuer ». « Continuer » additionne les segments.
  - Détails d'une réponse : tuiles Entrée et Sortie, prefill + génération.
  - Console : détail de « Tokens consommés », « Cache de prompt » affiché par
    défaut, frise « Entrée — cache vs utile », barres par modèle et par
    utilisateur, colonnes Entrée / Sortie et prefill + génération dans
    Exécutions, cache dans le rapport quotidien.
  - Entrée Anthropic ramenée au sens commun (cache compris, migration 0025
    pour l'historique) ; part des outils enregistrée par tour et par
    exécution (migration 0026) ; un seul format de nombres (« 12,3 k »).

- **Génération d'images** (migration 0024) : un moteur réglé dans la console
  (Modèles & services › Images) — `sd-server` de stable-diffusion.cpp (file,
  annulation) ou service compatible OpenAI —, ouvert à tous ou à des groupes.
  Mode Images du composeur (menu +, Alt+I, `/image`) : format, taille, nombre,
  description enrichie, graine, édition d'une image ; une case par image avec
  file et temps écoulé, Stop ; carte de résultat (modèle, durée, graine,
  Variantes, Copier), visionneuse, suppression annulable, galerie
  personnelle ; préférences par compte côté serveur ; outil `generate_image`
  du modèle (plafond par tour, refusé en mode plan) ; tours d'images dans
  Supervision › Exécutions. Clé API chiffrée, TLS sur le magasin du système
  plus une autorité collée, générations simultanées limitées sur tous les
  workers, rétention par compte, images supprimées avec leur conversation ou
  leur compte.

- **Exécutions** (base, migration 0021) : une ligne par tour de chat, run de
  routine, sous-agent ou compaction manuelle — jetons (dont cache et
  réflexion), temps LLM (pré-remplissage, décodage, attente du moteur),
  appels d'outils par famille et erreurs, fichiers modifiés, pics CPU/RAM de
  la sandbox, statut ; les lignes d'usage et d'appels d'outils y sont
  rattachées. Compteurs fiabilisés : moteur sur chaque ligne d'usage, cache
  KV de llama.cpp, appels d'outils avec identifiant, début, code de sortie,
  tailles et statuts `timeout` / `blocked`. Export CSV avec la réflexion.
- **« Détails » d'une réponse** : chronologie de l'exécution qui l'a produite
  (tours du modèle, appels d'outils avec argument principal et extrait du
  résultat, sous-agents, compactions), export JSON aux secrets masqués ;
  réservé au compte propriétaire.
- **Supervision › Exécutions** (console) : coût en ressources par compte
  (jetons, temps du modèle, attente, outils, fichiers, pics de la sandbox),
  liste filtrable des exécutions ; chronologie de n'importe quel compte pour
  l'administrateur. Widgets « Attente d'un créneau LLM » et « Réutilisation
  du cache KV » dans Métriques.
- **Supervision d'un tour** : durée de chaque outil, budget d'itérations
  (« tour n/max »), sous-agent « En attente » avant son lancement, motif et
  seuil d'une compaction, pas « compression du contexte » restitué au
  rechargement, sorties d'outils retirées du contexte comptées. Le modèle
  reçoit aussi le contexte restant et les limites de la sandbox à ses points
  d'étape.
- **Outils externes conformes à la norme MCP** : les familles d'outils de la
  sandbox (`fs`, `shell`, `git`, `browser`, `desktop`, `skill_run`) se
  branchent sur tout client MCP par `<origine>/api/mcp-bridge[/<famille>]`
  (HTTP streamable, révisions 2024-11-05 à 2025-11-25, pagination,
  annotations, `outputSchema` / `structuredContent`, échec d'outil en
  `isError`, outil inconnu ou hors portée en erreur `-32602`).
  Authentification par jeton personnel ou **OAuth 2.1** : le client n'a
  besoin que de l'URL (découverte RFC 9728 / RFC 8414, enregistrement
  dynamique RFC 7591 — activé par défaut, `mcp.oauth.dcr_enabled` —,
  documents de client, PKCE S256, `resource` RFC 8707, rotation et révocation
  des jetons), écran de consentement Elpis par familles. Migration 0023.
- **Paramètres › Connexions** : jetons personnels nommés (opencode, outils),
  portée par familles et expiration, montrés une seule fois puis
  régénérables, avec les blocs de configuration à copier (MCP générique,
  VS Code, opencode, OpenAPI, curl) ; applications OAuth autorisées,
  révocables. Politique `mcp.tokens.*` et `mcp.oauth.*` dans Console ›
  Outils MCP ; accès par jeton d'un compte visibles et révocables depuis sa
  fiche (Console › Comptes).
- **Façade OpenAPI** : `GET /api/tools/<famille>/openapi.json` (OpenAPI 3.1
  générée depuis `tools/list`) et `POST /api/tools/<famille>/<outil>`, pour
  les clients qui ne parlent pas MCP ; même jeton, mêmes familles.
- **Base de données multi-moteurs** : PostgreSQL et MariaDB/MySQL en plus de
  SQLite ; pool de connexions unique, SQL portable et schéma de référence ;
  adaptateurs serveur et suite de tests sur quatre moteurs ; transfert entre
  moteurs, commandes `./elpis db info | check | transfer | use` et page « Base
  de données » de la console ; choix de la base à l'installation.
- **Installeur par pages** : `./install.sh` pose toutes ses questions dans un
  assistant en terminal, vérifie les droits d'emblée, prépare et teste la base
  avant de continuer.
- **Console d'administration refondue** : six entrées par fonction et
  page d'arrivée « Vue d'ensemble » (ce qui demande l'attention, état des
  services, dernières 24 h) ; enregistrement par écran, champ par champ
  (`PATCH /api/admin/config`, conflits signalés), garde de sortie et Ctrl+S ;
  bandeau « Redémarrage nécessaire » ; recherche Ctrl+K ; la console suit les
  thèmes et le mode sombre (mode « Système »).
- **Skins plugins** : page Console › Système › Apparence pour activer ou
  désactiver chaque skin, choisir le skin par défaut, créer un skin depuis un
  modèle (couleurs claires et sombres, aperçu en direct), importer ou exporter
  un zip. Les skins importés vivent hors du code (`user_skins/`, inclus dans
  les sauvegardes complètes). Registres uniques `skins.json` et
  `mascottes.json`. Le skin Kiki est désactivé par défaut.
- **Écoute réseau explicite** (`security.listen`) : l'installeur demande
  « ce serveur seulement » ou « réseau local » ; une installation neuve
  écoute en local par défaut.
- **Intégration continue** (GitHub Actions) : lint (Ruff), typage (mypy),
  suite complète sur SQLite (Python 3.11 et 3.13), PostgreSQL 17 et
  MariaDB 11.4, tests front compris.
- **Exploitation** : `./elpis backup` (archive de la console, écrite dans
  `backups/`) et `./elpis upgrade` (sauvegarde, `git pull --ff-only`,
  dépendances, redémarrage, diagnostic) ;
  [docs/exploitation.md](docs/exploitation.md) (retour arrière, sauvegardes,
  supervision, compatibilité), [ROADMAP.md](ROADMAP.md), modèle de menace
  dans [SECURITY.md](SECURITY.md).

### Modifications

- **Créneaux du moteur LLM communs à tous les process** : un créneau du
  llama-server (`-np`) est désormais un fichier verrouillé partagé par les
  workers et la console (`ELPIS_LLM_SLOTS_DIR`). Avant, chaque worker gardait
  sa part (`créneaux ÷ workers`, au moins 1) : sept workers lançaient sept
  générations sur quatre créneaux, trois workers en laissaient un inutilisé.
  Un chat passe toujours avant une tâche de fond, y compris d'un worker à
  l'autre.
- **Workers Gunicorn** : par défaut `min(4, cœurs − 1)` au-delà de 2 cœurs
  (`APP_WORKERS` l'impose toujours) ; une machine de 32 cœurs lançait 31
  workers.
- **Service d'outils** : appels simultanés plafonnés au total
  (`MCP_TOOL_MAX_CONCURRENT`, 48) et par compte
  (`MCP_TOOL_MAX_CONCURRENT_PER_USER`, 12), attente bornée
  (`MCP_TOOL_QUEUE_WAIT_S`, 30 s) puis erreur lisible par le modèle ; pool de
  threads réglable (`MCP_TOOL_THREADS`, 64 au lieu de 40). Des commandes
  longues d'un seul compte ne figent plus le service pour les autres.
- **Installation** : `install.sh` et son assistant ne proposent plus
  d'installer le moteur vocal (whisper.cpp + Piper) sur la machine d'Elpis ;
  il se déploie à part avec `deploy/voice/`, et la page « Voix » de
  l'assistant demande les adresses des deux services. `--with-voice` et
  `--no-voice` sont ignorées avec un avertissement.
- **Agent de la sandbox** : un agent HTTP (bibliothèque standard) tourne dans
  chaque conteneur, démarré à la demande, pour que l'hôte n'accède plus
  lui-même au contenu de `/work`. Son code est monté en lecture seule et suit
  la version de l'application : aucune reconstruction d'image pour le faire
  évoluer. Nouveaux montages : les conteneurs existants sont recréés.
- **Licence MIT** : Elpis passe de la licence Apache-2.0 à la licence MIT
  (`LICENSE`, `NOTICE`, en-têtes SPDX, `pyproject.toml`). Les textes de licence
  des composants vendorisés sont reproduits dans `LICENSES/`.
- **Documentation recentrée sur le harnais** : le guide utilisateur, la doc
  développeur et le panneau Sampling n'expliquent plus le fonctionnement
  général d'un LLM ; ils décrivent ce que fait l'application autour du modèle.
  Guide, doc développeur et configuration alignés sur le code actuel.
- **Harnais LLM** : flux et transport, boucle d'outils, gestion du contexte,
  pool MCP et sous-agents, route de chat et bouton « Continuer » ; audit en
  quatre passes : requêtes Anthropic/OpenAI, identifiants d'appel, relances et
  raisonnement, robustesse et code mort, écritures sans suivre de lien et cache
  KV stable, comptage de contexte et télémétrie, client RAG.
- **Découpage du cœur** : la boucle agentique et le flux de chat sont rangés en
  modules, sans changement de comportement. L'orchestrateur de la boucle
  (`llm_core/_chat_with_tools.py`) garde les compteurs et l'aiguillage de
  chaque tour ; le tour LLM, l'exécution des appels d'outils (un seul noyau
  pour les appels natifs et les appels écrits en texte), les reprises et les
  sorties du run vivent dans `llm_core/engine/`. La route du flux de chat
  n'enchaîne plus que des étapes : préparation, exécution, enregistrement et
  historique du tour sont dans `chatbot_app/turn/`, l'annulation et la
  compression manuelle dans leurs propres modules de routes.
- **Tests** : la suite s'isole de l'instance (configuration absente, moteur
  LLM injoignable, données de l'instance et journaux dans un dossier
  temporaire : elle n'écrit plus dans `user_db/` ni `user_sandboxes/`) et
  donne le même résultat dans la copie de travail, un
  worktree et la CI : un `config.json` local ne provoque plus de faux échec.
  Goldens complets de la boucle et du flux de chat, scénario par scénario ;
  gardes contre un patch sans effet, un import fait à l'appel qui vise un nom
  disparu, une erreur de code avalée par `swallow` et le retour de traces
  d'audit dans les commentaires. Le test de l'installeur lit la sortie du
  pseudo-terminal jusqu'au bout.
- **Moteur d'événements** : bus fichier sans perte, flux revalidés,
  contre-pression du terminal.
- **Contrats du harnais** : une seule source décide si un outil est sériel,
  rejouable, en lecture seule ou mutant (politique et annotations déclarées
  par le serveur, replis prudents sinon) ; le résumé de compression suit
  cette déclaration et ne compte plus les outils de lecture (Git, navigateur)
  parmi les modifications. Registre unique des événements du flux de chat,
  vérifié contre l'interface, la route et le journal d'exécution ; les
  événements que plus rien n'émet (`delta`, `tool_thinking`) sont retirés de
  l'interface.
- **Chat** : diffs relus dans l'historique ; carte « Fichiers modifiés »
  affichée quand l'éditeur est désactivé.
- **Ancien nom du projet** : compatibilité retirée (conteneurs, étiquettes,
  image, variables d'environnement, greffon opencode) ; les anciens conteneurs
  de sandbox d'avant le renommage sont à supprimer à la main.

### Sécurité

- **Frontière hôte ↔ sandbox** : toute opération sur `/work` (outils
  fichiers, éditeur, historique, aperçus, téléchargements, export et
  import, instantanés, sauvegardes) s'exécute dans le conteneur de
  l'utilisateur, par un agent lancé à la demande sous son UID ; l'hôte ne
  lit ni n'écrit plus `/work`.
- **Fin des droits élargis** : un seul UID, celui du conteneur, écrit dans
  `/work` — fichiers 0644, dossiers 0755 au lieu de 0666 / 0777. Les
  sandboxes existantes sont remises en ordre à leur prochain démarrage
  (`chown -R`, `chmod -R go-w` par le root du conteneur, une fois par
  compte).
- **Git dans la sandbox** : les commandes Git des outils et du panneau Git
  de l'éditeur tournent dans le conteneur de l'utilisateur, par son agent.
  Leurs opérations réseau passent par un relais authentifiant de l'hôte :
  un ticket par opération, seul le dépôt de l'opération joignable,
  identifiant du connecteur ajouté par l'hôte (jamais dans la sandbox),
  push limité aux branches demandées ; `https` et `http` seulement (`ssh`
  et `git://` retirés). Fonctionne avec un profil réseau isolé.
  `bubblewrap` (aperçus Office) devient un paquet de base —
  **installations existantes : `apt install bubblewrap`** (`./elpis
  doctor`) ; sur Ubuntu, l'installeur pose un profil AppArmor s'il est
  bloqué.
- **Conteneurs** : seules les capacités nécessaires (`--cap-drop ALL`, puis
  celles qu'exigent l'entrypoint, sudo et apt) : plus de `NET_RAW`,
  `SETFCAP`, `SYS_CHROOT` ni `MKNOD`. Image `elpis/sandbox:1.7.0` (`ping`
  sans capacité fichier), construite par `./install.sh`. Les conteneurs
  existants sont recréés à leur prochain usage (label `elpis.spec`, ou image
  changée) : ce qui y avait été installé hors de `/work` est perdu.
  **L'image 1.7.0 est obligatoire** : sans elle, les conteneurs existants ne
  sont pas recréés et fichiers, éditeur et Git des sandboxes sont
  indisponibles (message explicite) ; `./elpis upgrade` la charge depuis son
  archive ou la construit. Conteneurs lancés avec `--init` (processus
  orphelins récoltés). Le dossier `user_sandboxes/` est réservé au compte de
  service (0700) ; `./install.sh` ne change plus le propriétaire du contenu
  des sandboxes.
- **Politique Git d'un dépôt** : `.git-tool-policy.json` ne peut plus que
  renforcer les protections par défaut.
- **Navigateur piloté** : destinations limitées à `http` / `https` ; la
  boucle locale, le lien-local, les adresses de l'hôte et ses réseaux de
  conteneurs sont refusés, y compris après une redirection ou pour une
  sous-ressource (relais local qui juge l'adresse résolue) ; réseau local
  autorisé, restreint au besoin par `browser.url_allowlist`
  (docs/configuration.md). Sessions, états sauvegardés, téléchargements et
  références visuelles rangés par compte ; service relancé après une panne.
  **Mise à jour** : une automatisation qui visait `localhost`, l'adresse de
  l'hôte ou un conteneur local est désormais refusée.
- **Jetons en empreinte** (migration 0022) : les jetons `pcr_` (opencode),
  `ept_` (outils) et `evt_` (vision d'une automatisation, limité à la
  localisation à l'écran) ne sont plus gardés qu'en empreinte SHA-256 et ne
  se réaffichent plus ; `GET /api/code/config` ne rend plus de jeton.
  Les postes opencode déjà appairés restent valides. Révoquer les sessions
  d'un compte, réinitialiser ou changer son mot de passe révoque aussi ses
  jetons et ses applications OAuth. **Retour arrière** : l'ancienne version
  ne retrouve pas les jetons convertis (ré-appairer opencode).
- **Relais MCP** : il ne retransmet plus le jeton du client au service
  d'outils (jeton de délégation signé), contrôle l'en-tête `Origin` et
  refuse une `MCP-Protocol-Version` inconnue.

### Corrections et sécurité

- **Bascule de base interrompue** (process de la console tué pendant la
  copie) : les écritures ne répondent plus 503 indéfiniment, la tâche
  apparaît « interrompue » et « Migrer » peut être relancé tout de suite.
  Une copie ou une vérification en échec vide la base cible, qui était
  vierge au départ : la nouvelle tentative n'est plus refusée (« cible non
  vide »). Pendant une bascule, une configuration illisible bloque les
  écritures au lieu de les laisser passer.
- **Installation vers PostgreSQL / MariaDB** : si la copie des données
  SQLite échoue, Elpis reste sur SQLite (données intactes) et la nouvelle
  base est gardée en attente dans la console › Base de données ; avant, le
  schéma y était créé quand même et la copie ne pouvait plus être relancée.
- **Console › Métriques** : l'export Prometheus et l'export CSV rendent
  leur connexion à la base même en cas d'erreur (sur PostgreSQL / MariaDB,
  chaque fuite retirait une connexion au pool jusqu'au redémarrage).
- **Changement de modèle avec un llama-server routeur** (une instance à la
  fois) : choisir un autre modèle dans un chat rechargeait l'ancien, avec
  des erreurs 500 côté llama. Trois causes, corrigées :
  - la sélection revenait d'elle-même sur le modèle chargé au
    rafraîchissement de la liste ; elle est désormais gardée jusqu'à l'envoi,
    et un modèle dont le chargement a échoué est signalé dans le sélecteur ;
  - la sonde des capacités interrogeait le modèle par défaut de la
    configuration, et le chargeait ; elle n'interroge plus que le modèle
    chargé, sans jamais en charger un ;
  - le panneau Sampling et les propriétés d'un modèle lisaient `/props` en
    chargeant le modèle ; ces lectures passent `autoload=false`, et un
    modèle non lu ne laisse plus de capacités fausses en cache.
  `/metrics` et `/slots` nomment le modèle chargé (fin des 400 « model name
  is missing ») ; la jauge KV demande des modèles lancés avec `--metrics`.
- **Cycles d'import** : importer en premier
  `shared_infra/opencode/routes_cli.py`,
  `shared_infra/observability/routes_events.py` ou
  `shared_infra/desktop/routes.py` échouait (« partially initialized
  module ») : des imports de niveau module refermaient un cycle avec le
  paquet des routes. Ils sont faits à l'appel, dans
  `shared_infra/desktop/routes.py` et `shared_infra/opencode/routes_code.py`.
- **Image de sandbox** : la console n'inscrit plus l'image livrée dans
  `config.json`. Une instance dont l'onglet Sandbox avait été enregistré
  restait figée sur l'image de l'époque ; seule une image tierce y est
  désormais conservée.
- **Installeur** : root via `su` sans tiret (runuser introuvable, faux
  « python3-venv ? »), client Docker sur Debian 13, mot de passe admin généré
  jamais écrit dans le journal.
- **Agent desktop** : plus aucune dépendance GPL (pyautogui sans ses
  dépendances optionnelles GPL, python-xlib LGPL).
- **Console admin** : skin et mode sombre lus et enregistrés depuis le
  processus admin (plus de 404) ; sauvegarde et restauration affichent
  « Compression en cours… » / « Restauration en cours… » avec une roue et le
  temps écoulé au lieu d'un « 0 o » figé.
- **Socle** : droits de la base, `APP_MODE`, sauvegarde et restauration sûres,
  documentation de sécurité.
- **RAG** : requêtes fiables sur collections hybrides, import borné, file OCR
  robuste ; passe de robustesse complète — cœur, recherche, OCR, console.
- **Sandbox** : archives sur disque et bornées, cycle de vie fiable, copie sans
  lien.
- **Base de données** : sur PostgreSQL et MariaDB/MySQL, les migrations du
  schéma de référence ne sont plus rejouées au démarrage d'une base non vierge
  (elles échouaient à chaque démarrage) ; « Enregistrer » de la page Base ne
  modifie plus la base active (cible rangée à part jusqu'à la bascule) ; la
  vérification d'un transfert ne dépend plus de la collation du serveur.
- **Métriques llama.cpp** : les noms publiés (`llamacpp:…`) sont reconnus ;
  avant un chargement ou un déchargement de modèle, l'attente des créneaux au
  repos voit de nouveau les requêtes en cours quand `/health` ne répond pas.
- **Chat** : le pied d'un message (modèle, durée, débits) reste affiché après
  les tours suivants ; il disparaissait au tour suivant.
- **Outils** : une réponse qui n'est qu'un appel écrit en texte vers un outil
  inexistant relance le modèle (deux fois au plus, en lui nommant l'outil) au
  lieu de finir sur une réponse vide.
- **Compaction** (chat sans outils, réflexion active) : la porte réserve le
  même plafond de génération que le budget de contexte.
- **Git** : l'ancien fichier d'identifiants importé
  (`.git-credentials.json.imported`) est supprimé de la sandbox.
- **Audit** : les révocations de sessions (toutes, ou d'un compte) sont
  inscrites au journal d'audit.
- **Console** : après un conflit (« Modifié ailleurs entre-temps »),
  « Reprendre la valeur du serveur » enregistre les autres modifications de
  la page au lieu de signaler un échec ; l'URL complète du moteur local suit
  de nouveau l'hôte et le port modifiés.
- **Journal d'exécution** : le plafond `llm.run_journal_max_mb` est appliqué
  (il était ignoré, 64 Mo toujours).
- **Prompts système** : deux enregistrements simultanés d'une même catégorie
  aboutissent tous deux.
- **Sauvegardes** : l'archive complète inclut le magasin des skills
  personnels (absent jusqu'ici, donc perdu à la restauration) ; journaux et
  fichiers PID ne sont plus ni sauvegardés ni restaurés ; une sauvegarde
  sans la base n'est plus comptée comme récente.
- **Sandbox** : les parcours de l'agent (listage, relevé des fichiers
  modifiés, taille) n'entrent jamais dans un lien, même apparu pendant le
  parcours ; la matrice adversariale se rejoue contre le vrai conteneur
  (`docs/sandbox-gateway.md`, « Tests »).
