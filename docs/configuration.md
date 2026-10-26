# Elpis — Installation et configuration

> Architecture interne : [architecture.md](architecture.md).
> Guide utilisateur : [guide-utilisateur.md](guide-utilisateur.md).

## Sommaire

- [Prérequis](#prérequis)
- [Installation](#installation)
- [Démarrage](#démarrage)
- [Configuration](#configuration)
  - [Fichier `config.json`](#fichier-configjson)
  - [RAG](#rag-rag)
  - [Fournisseurs cloud des comptes](#fournisseurs-cloud-des-comptes-llmallowed_provider_types)
  - [Variables d'environnement](#variables-denvironnement)
  - [`context_config.json` — textes injectés au LLM](#context_configjson--textes-injectés-au-llm)
  - [Priorité de résolution et hot-reload](#priorité-de-résolution-et-hot-reload)
- [Multi-process : séparation main / admin](#multi-process--séparation-main--admin)
- [Process du core](#process-du-core)
- [HTTPS : frontal Caddy](#https--frontal-caddy)
- [Tracing et debug multi-utilisateur](#tracing-et-debug-multi-utilisateur)

---

## Prérequis

- **Système** : Debian 12/13 ou Ubuntu 24.04 (amd64).
- **Docker** : la sandbox par utilisateur (outils shell, terminal, éditeur)
  tourne dans un conteneur.
- **Un moteur d'inférence** : `llama-server` (llama.cpp) ou tout serveur
  compatible OpenAI (vLLM, TGI, Ollama, LM Studio), ou un fournisseur distant
  (connecteurs OpenAI-compatibles, Anthropic).
- **Paquets système** : ceux de
  [deploy/prerequis-apt.txt](../deploy/prerequis-apt.txt) (socle, plus un
  groupe par composant), qu'`install.sh` installe par apt (sudo) ;
  `--no-apt` les vérifie seulement, commandes apt :
  [exploitation.md](exploitation.md#prérequis-système-paquets-apt).
- `install.sh` installe le reste : le venv Python et ses dépendances, Node.js
  24 sans npm dans `node/` (core et service navigateur) et le bundle du core
  (`apps/core/dist`), Qdrant (RAG), Chromium, image sandbox.

### Moteur d'inférence

Conçu pour `llama-server` en **mode routeur** (plusieurs modèles, plusieurs
slots), **vLLM** et **SGLang** : le type déclaré dans `llama.engine` fait foi et
Elpis en utilise toutes les adresses et capacités (voir
[Moteur d'inférence déclaré](#moteur-dinférence-déclaré-llamaengine)). D'autres
moteurs OpenAI-compatibles (TGI, Ollama, LM Studio) fonctionnent en `generic` —
voir [Cibles d'inférence](architecture.md#cibles-dinférence-et-fournisseurs).

> **Version minimale recommandée** : une version incluant le parser tool-calls
> XML GLM (chercher `arg_key` / `arg_value` dans `common/chat-auto-parser.h`).

> **Routeur et chargement des modèles.** Elpis ne charge un modèle qu'à
> l'envoi d'un message (ou par le bouton Charger) : ses lectures d'information
> (`/props`, `/slots`, `/metrics`) passent `autoload=false` et ne nomment que le
> modèle chargé. La jauge KV et les métriques exigent des modèles lancés avec
> `--metrics` (sinon le serveur répond 501 ; Elpis cesse alors de demander
> pendant 5 minutes).

> **`--jinja` est requis pour le tool-calling natif.** Sans ce flag, le modèle
> ne peut pas émettre de `tool_calls` structurés et « free-forme » ses appels en
> texte. Symptôme : du markup (`<tool_call>`, `<function=write_file>`) apparaît
> dans la bulle de réponse. Le backend nettoie ce markup à l'affichage
> (`_strip_tool_call_markup`), donc il ne fuit plus visuellement, mais le
> tool-calling **reste dégradé**. Diagnostic : la ligne `markup d'appel d'outil
> nettoyé du flux final` dans les logs backend.

```bash
git clone https://github.com/ggml-org/llama.cpp && cd llama.cpp
cmake -B build                     # CPU
cmake -B build -DGGML_CUDA=ON      # CUDA
cmake --build build --config Release -j$(nproc)
```

### Aperçus Office de l'éditeur (optionnel)

docx et pptx s'affichent dans l'éditeur après conversion par LibreOffice
**sur l'hôte**, dans une prison `bubblewrap` sans réseau ni fichiers de l'hôte.
Les PDF n'ont besoin de rien, et les xlsx sont lus directement en flux
(`apps/toolhost/src/office/xlsx.ts`) : LibreOffice ne sert qu'à la vue
« Pages » d'un tableur. Un document lourd affiche ses premières pages tout de
suite, puis le document complet quand la conversion est terminée.

Installation : `./install.sh --with-office`.

- Ubuntu 24.04 restreint les user namespaces non privilégiés
  (`kernel.apparmor_restrict_unprivileged_userns`) : si `bwrap` est bloqué,
  l'installeur pose le profil AppArmor `/etc/apparmor.d/elpis-bwrap` ; sinon
  l'aperçu répond « Isolation indisponible ».
- Réglages : `config.json › office_preview` (`isolation` `auto`|`none`,
  `timeout_s`, `slots`, `max_mb`, `max_pages`, `xlsx_max_rows`, `cache_mb`…) ;
  interrupteur admin « Aperçu Office » (`features.office_preview`). Cache :
  `user_sandboxes/.office-cache` (élagué par la maintenance).

### Git d'une sandbox

Les commandes Git des outils de l'agent et du panneau Git de l'éditeur
tournent dans le conteneur de l'utilisateur, par son agent et sous son UID :
ce qu'un dépôt fait exécuter reste dans la sandbox (les hooks restent
désactivés pour ces commandes). Les opérations réseau lancées par Elpis
(`clone`, `fetch`, `pull`, `push`, `ls-remote` ; `https` et `http`
seulement) passent par le relais de l'hôte, y compris avec un profil réseau
isolé : un ticket par opération, le seul dépôt de l'opération joignable,
l'identifiant du connecteur Git ajouté par l'hôte (jamais dans la sandbox),
la garde anti-SSRF refaite à chaque requête et, au push de l'éditeur, seules
les refs que `git push` mettrait à jour d'après la configuration du dépôt,
sans suppression, sans mise à jour forcée non demandée ni réécriture d'une
étiquette existante (l'assistant ne pousse que sa branche). Un refus du
relais est rendu en 409, avec son motif ; un rejet de l'amont (en retard) en
400. Identifiants saisis : envoyés après un 401 de l'amont sur la découverte
(`info/refs`) ; un amont qui ne les demande qu'au `POST` n'est pas pris en
charge.

Le relais écoute sur `user_sandboxes/.elpis-relay/<pid>.sock` (un socket par
processus de l'app), dossier monté en lecture seule dans les conteneurs : une
connexion sans ticket valide est fermée sans rien relayer. Pendant une
opération, tout processus de la sandbox peut passer par l'écoute locale de
l'agent, mais seulement vers le dépôt, le service et les refs du ticket.

Certificats TLS : le magasin du système (`/etc/ssl`, `SSL_CERT_FILE`,
`SSL_CERT_DIR`), plus `GIT_SSL_CAINFO` / `GIT_SSL_CAPATH` s'ils sont définis
pour le service. **Aucun proxy** : le relais joint l'amont directement
(variables `*_PROXY` ignorées). Une redirection de l'amont est refusée, avec
l'adresse vers laquelle corriger l'URL du remote. Un remote `http://` passe
en clair, identifiant du connecteur compris : préférer `https://`.

Mise à jour depuis une version où Git tournait sur l'hôte : la configuration
Git du compte de service (`http.sslCAInfo` de `/etc/gitconfig`, `http.proxy`,
`http.extraHeader`) ne s'applique plus au réseau Git. Une CA interne se
déclare dans le magasin du système ou par `GIT_SSL_CAINFO` dans
l'environnement du service.

Ubuntu ≥ 23.10 réserve les user namespaces aux programmes munis d'un profil
AppArmor. Si `bwrap` est bloqué, l'installeur (sauf `--skip-system`) pose
`/etc/apparmor.d/elpis-bwrap`. Compromis : ce profil vaut pour tout compte
de la machine qui lance `bwrap`, et rouvre donc pour lui la surface du noyau que
la restriction réduit. Le retirer (`apparmor_parser -R`, puis supprimer le
fichier) désactive la prison des aperçus Office.

---

## Installation

```bash
git clone https://github.com/toto-fou/Elpis.git elpis && cd elpis    # 1
./install.sh                                   # 2 : questions, installation, configuration, démarrage
```

`install.sh` est **guidé** : il détecte le système (Debian 12/13, Ubuntu
24.04), vérifie les droits AVANT toute question, ouvre l'assistant par pages
(`deploy/wizard.py`, bibliothèque standard Python seule : il tourne avant le
venv), installe, configure avec les réponses de l'assistant, puis démarre
(services systemd ou `./elpis start`). Il est idempotent : le relancer ne
refait que ce qui manque, et l'assistant reprend alors la configuration en
place. Tout est journalisé dans `logs/install.log`, sauf les écrans de
l'assistant et les mots de passe (écrits sur le terminal seulement).
`./install.sh --dry-run` affiche le plan sans rien faire.

**Droits.** Depuis un compte normal : `sudo -v` au lancement (une seule
saisie), jeton entretenu pendant toute l'installation. Sans sudo : on arrête,
ou on continue sans rien de ce qui demande root (Caddy, base locale,
services). Par `sudo ./install.sh` : les
étapes système en root, l'application (venv, Chromium, configuration,
démarrage) sous le compte qui a lancé sudo (`SUDO_USER`, ou `ELPIS_USER`, ou
le propriétaire du dépôt) — jamais en root.

**Assistant.** ↑↓ se déplacer, Espace cocher ou choisir, Entrée valider et
avancer, 1-9 choix direct, Tab / Maj+Tab changer de page, Échap quitter sans
rien modifier. Une réponse désactive les saisies qu'elle rend inutiles (avec
la raison affichée) ; une valeur devenue impossible reprend la première
valeur possible (Caddy décoché : HTTPS repasse à « HTTP direct »). Les
adresses LLM et d'embeddings sont sondées (`GET /v1/models`) et le modèle se
choisit dans la liste annoncée. Réponses dans `user_db/run/install-answers.json`
(0600, secrets compris), supprimé à la fin. `--plain` garde les questions en
lignes ; sans terminal (ou `TERM=dumb`), elles aussi.

**Base de données.** Préparée (serveur local) et testée juste après le venv,
avant les étapes longues. Échec : `--yes` s'arrête (rien n'est configuré sur
une base injoignable) ; en interactif, choix entre réessayer, modifier les
réglages (retour à la page Base), passer à SQLite ou abandonner.

| Question (option qui y répond) | Défaut | Effet |
|---|---|---|
| Service navigateur (`--with-browser`, `--no-browser`) | oui | `npm ci` + Chromium (Playwright) |
| Image sandbox (`--sandbox build\|pull\|none`, `--pull IMAGE`) | build | `docker build` de `deploy/docker/sandbox/`, ou `docker pull` + étiquette |
| Base de données (`--db sqlite\|postgres-local\|external`) | sqlite (1re fois ; inchangée ensuite) | voir [Base de données](#base-de-données) |
| LibreOffice (`--with-office`, `--no-office`) | oui s'il est déjà installé | aperçus docx/xlsx/pptx (LibreOffice nogui + bubblewrap, installés par apt) |
| Caddy (`--with-caddy`, `--no-caddy`) | non | frontal HTTPS (paquet `caddy` installé par apt, puis configuré par install.sh ; voir [HTTPS](#https--frontal-caddy)) |
| Extras AGPL (`--with-agpl`, `--no-agpl`) | non | PyMuPDF et pdf2docx |
| Configuration (`--configure`, `--no-configure`) | oui (1re fois) | `./elpis configure` |
| Démarrage (`--service`, `--start`, `--no-start`) | service | `sudo ./elpis service install` ou `./elpis start` |

`--yes` supprime toutes les questions (défauts + options) ; les options de
`./elpis configure` se passent après `--` (en mode assistant, elles
pré-remplissent les pages) :

```bash
ELPIS_CFG_ADMIN_PASSWORD='…' ./install.sh --yes --with-caddy --service -- \
    --llm-url http://gpu.example.lan:8080 --https local --embed-url http://gpu.example.lan:8081
```

Dépendances Python : `requirements.txt` (cœur), `requirements-rag.txt`
(extracteur du RAG), `requirements-agpl-optional.txt` (optionnel, AGPL, plus
utilisé),
`requirements-dev.txt` (tests). Hors-ligne : `./install.sh --offline <dir>`
avec le paquet produit par `make_release.sh` (voir
[exploitation.md](exploitation.md#installer-un-serveur-hors-ligne)).

### `./elpis configure`

Sans option, dans un terminal : le même assistant par pages (sans la page
Composants), pré-rempli avec la configuration en place, puis application
sans question. Avec des options (`--yes`, `--llm-url`…) ou sans terminal :
`deploy/configure.py` directement, questions en lignes. Relancer `configure`
ne régénère aucun secret (`--force` repart de `config.example.json`).
`--answers FICHIER` applique les réponses de l'assistant ; `--check-db` teste
seulement la connexion à la base retenue.

| Étape | Questions | Écrit dans |
|---|---|---|
| 1. LLM | type (llama.cpp, vLLM, SGLang, autre OpenAI-compatible) ; adresse, dont le port suit le type tant qu'aucune adresse n'est saisie (8080, 8000, 30000) ; clé API facultative (`--api-key` du serveur, saisie masquée) ; sonde `GET /v1/models` avec la clé en Bearer (401 : « clé refusée »), jamais `/props?model=` qui chargerait un modèle ; modèle choisi dans la liste annoncée ; drapeaux de lancement conseillés pour vLLM et SGLang | `config.json › llama` : `engine`, `url` (base du serveur), `api_key`, `model` ; seules les valeurs changées sont réécrites |
| 2. Cloud | fournisseur (Anthropic, OpenAI, Mistral, Groq, OpenRouter, DeepSeek, Moonshot), clé API masquée, modèle | connecteur **partagé** en base, clé chiffrée (Fernet) |
| 3. Accès | HTTPS : non / certificat local (`install_caddy.sh`) / domaine public Let's Encrypt (`Caddyfile.acme.template`) ; sans HTTPS, écoute (`--listen local\|lan` : ce serveur seulement ou réseau local, voir [Écoute](#écoute-securitylisten)) ; nom d'hôte d'accès ; ports déjà occupés signalés | `security.https`, `security.listen`, `.env` (`MAIN_PUBLIC_URL`, `ADMIN_PUBLIC_URL`) |
| 4. RAG | activation, serveur d'embeddings (sondé) et modèle, reranker, OCR vision | `config.json › rag` (`embed`, `reranker`, `ocr`), voir [RAG](#rag-rag) |
| 5. Sandbox | image Docker (présence vérifiée), mémoire par sandbox | `executors` |
| 6. Voix | activation, URL whisper-server et elpis-tts (locales si installées, jeton repris) | `voice` |
| 7. Base de données | moteur (SQLite, PostgreSQL), hôte, port, base, utilisateur, mot de passe (masqué), TLS ; connexion testée ; copie des données d'une base SQLite existante vers une base vide | `config.json › database`, `user_db/.db_password` (0600) |
| 8. Admin | nom et mot de passe (masqué, confirmé, 8 caractères min. ; vide = généré, à changer à la 1re connexion) ; si des comptes existent : changement de mot de passe proposé | base `user_db/app.db` |

Secrets générés (fichiers 0600) : `app.session_secret`,
`user_db/.local_mcp_token` (hôte d'outils, référencé par `mcp.json`),
`user_db/.rag_service_token`. Chaque réponse peut être donnée par option
(`./elpis configure --help`) ou variable `ELPIS_CFG_*` (`ELPIS_CFG_ENGINE`,
`ELPIS_CFG_LLM_URL`, `ELPIS_CFG_LLM_API_KEY`, `ELPIS_CFG_CLOUD_API_KEY`,
`ELPIS_CFG_ADMIN_PASSWORD`…) ; `--yes` ne pose aucune question. Les secrets
passent par ces variables (l'assistant les transmet ainsi) : une option comme
`--llm-api-key` se voit dans la liste des processus. Aucune clé n'apparaît
dans le résumé, les journaux (`logs/install.log` les masque) ni `export-sh`.

Une configuration existante reste valide telle quelle : sans `engine`
(llama.cpp), avec `ip` et `port` seuls, ou avec une URL complète
`…/v1/chat/completions`. `configure` n'y réécrit que ce qui change ; une
nouvelle adresse est écrite en base du serveur (`url`).

### Base de données

SQLite (fichier `user_db/app.db`) reste le défaut et suffit jusqu'à quelques
dizaines d'utilisateurs. PostgreSQL se justifie pour une base managée
existante, des sauvegardes point-in-time, de la réplication ou de la BI sur
les tables de télémétrie. Pilote Python pur, sous licence permissive :
pg8000 (BSD-3) ; le serveur vient des dépôts de l'OS et n'est jamais livré
avec Elpis. MariaDB/MySQL n'est plus pris en charge (voir
[exploitation](exploitation.md#mettre-à-jour) pour en sortir).

| Choix d'`install.sh` | Ce qui est fait |
|---|---|
| `sqlite` | rien à installer |
| `postgres-local` | paquet `postgresql`, rôle et base `elpis` (UTF-8, `template0`), extension `unaccent`, mot de passe aléatoire dans `user_db/.db_password` |
| `external` | questions de `./elpis configure` : hôte, port, base, utilisateur, mot de passe, TLS d'un serveur PostgreSQL |

Hors ligne (`--offline`), aucun serveur de base n'est dans le paquet : seuls
`sqlite`, `external` ou un serveur déjà installé sont possibles.

Section `database` de `config.json` (chaque clé peut être imposée par une
variable, qui prime) :

| Clé | Variable | Défaut |
|---|---|---|
| `backend` | `APP_DB_BACKEND` | `sqlite` (ou `postgres`) |
| `host`, `port` | `APP_DB_HOST`, `APP_DB_PORT` | `127.0.0.1`, 5432 |
| `name`, `user` | `APP_DB_NAME`, `APP_DB_USER` | `elpis` |
| `tls` | `APP_DB_TLS` | `off` (`require`, `verify`) |
| `pool_max`, `timeout` | `APP_DB_POOL_MAX`, `APP_DB_TIMEOUT` | 8 connexions par process, 60 s |
| — (mot de passe) | `APP_DB_PASSWORD` | fichier `user_db/.db_password` (0600), jamais dans `config.json` |
| `generation` | — | écrite par la bascule depuis l'administration |
| `pending` | — | cible enregistrée par « Enregistrer » sans bascule (mot de passe dans `user_db/.db_password.pending`) ; la base active n'en est pas modifiée, la bascule l'applique puis l'efface |

Au premier démarrage, une base vide reçoit le schéma complet ; une base
existante reçoit ses tables et colonnes manquantes puis ses migrations en
attente. Une base PostgreSQL naît toujours de ce schéma :
les migrations qu'il contient y sont inscrites sans être rejouées. Un seul process à la fois pose le schéma (verrou fichier), les
workers peuvent donc démarrer ensemble.

Exploitation (`./elpis db …`, servi par le core : `apps/core/dist/exploitation.mjs db …`) :

```bash
./elpis db info                                   # moteur, version, taille, schéma, pool
./elpis db check postgres://elpis@db.lan:5432/elpis
./elpis db transfer --to postgres://elpis@db.lan:5432/elpis --dry-run
./elpis db transfer --to postgres://elpis@db.lan:5432/elpis   # copie vers une base VIDE
./elpis db use sqlite                             # porte de sortie si le serveur tombe
```

Mot de passe : `--password-env NOM_DE_VARIABLE` ou saisie masquée. Le
transfert copie les tables dans l'ordre des clés étrangères, écarte et compte
les lignes orphelines, recale les identités, vérifie comptes et empreintes et
écrit un rapport JSON. Depuis la console, la page **Base de données** fait la
même chose en « Migrer et basculer » (écritures suspendues pendant la copie,
redémarrage automatique) et propose « Revenir à SQLite ».

Sauvegarde : hors SQLite, la sauvegarde « base » produit un instantané SQLite
(restaurable partout). `.db_password` (et `.db_password.pending`) n'est ni
sauvegardé ni restauré. Pour
restaurer la base d'un moteur serveur : revenir à SQLite, restaurer, puis
migrer.

`configure` est, avec le toggle de la console admin, le seul écrivain de
`security.https` : il le fait à l'installation, puis configure Caddy dans la
foulée. Si Elpis tourne déjà, redémarrez-le ensuite (`./elpis restart` ou
`sudo systemctl restart elpis.target`).

---

## Démarrage

### Mode manuel

```bash
./elpis start      # démarre tous les services
./elpis status     # état
./elpis logs       # journaux
./elpis stop
./elpis doctor     # diagnostic de l'installation
```

`start` enchaîne : Qdrant (6333) → RAG (8000) → hôte
d'outils MCP (8765) → main (8001) → admin (8002) → service navigateur (3000) ;
les outils du compte sont servis par main lui-même. Main et admin
écoutent selon [`security.listen`](#écoute-securitylisten) (`127.0.0.1` derrière
Caddy dans tous les cas) ; l'extracteur du RAG et Qdrant n'écoutent qu'en local.

### Écoute (`security.listen`)

Hors HTTPS, adresse d'écoute de main (8001) et admin (8002) :

| Situation | Écoute |
|---|---|
| HTTPS actif | `127.0.0.1` (Caddy est le frontal ; le réglage est sans objet) |
| `config.json` absent ou illisible | `127.0.0.1` |
| `"listen": "local"` (défaut d'une installation neuve) | `127.0.0.1` : ce serveur seulement |
| `"listen": "lan"` | `0.0.0.0` : ports ouverts **en clair** au réseau |
| clé absente d'une config existante | `0.0.0.0` (installations d'avant le réglage, inchangées) |
| variable `BIND` | prioritaire (break-glass) |

Règle unique : `apps/core/src/ecoute.ts` (core), lue par
`./elpis › _bind_default` pour son message de démarrage. L'extracteur du RAG
écoute sur `127.0.0.1` quel que soit ce réglage (`RAG_HOST` pour un core sur
une autre machine). Écrivains : `./elpis configure` (question
« Accès » de la page Accès, `--listen local|lan`, `ELPIS_CFG_LISTEN`) et
Console admin › Sécurité › Accès HTTPS › Écoute (redémarre l'application ;
« local » n'y est accepté que depuis la machine elle-même, pour ne pas se
couper l'accès). L'éditeur brut ne le réécrit pas (`_OWNED_PATHS`).
Réinstallation : la valeur en place (ou son absence) est conservée.

### Politique de sécurité du contenu (`security.csp`)

Les pages de l'application (`/` du chat, `/` et `/admin` de la console)
portent un en-tête de politique de sécurité du contenu (CSP) : scripts de
l'origine seulement, aucun script en ligne ni évalué, aucun objet embarqué, pas
d'encadrement par un autre site (`apps/core/src/interface/pages.ts ›
POLITIQUE_CSP`). Réglage de repli, relu à chaque page (sans redémarrage) :

| Valeur | Effet |
|---|---|
| `"enforce"` (défaut, clé absente ou valeur inconnue) | `Content-Security-Policy` : la politique est appliquée |
| `"report-only"` | `Content-Security-Policy-Report-Only` : les violations sont signalées dans la console du navigateur, rien n'est bloqué |
| `"off"` | politique retirée (repli d'urgence si une extension du navigateur ou un mandataire réécrit les pages) ; reste l'en-tête commun à toutes les réponses, `frame-ancestors 'self'` |

```json
{ "security": { "csp": "report-only" } }
```

Les aperçus du bac, l'aperçu HTML des blocs de code du chat (`/apercu-code`) et
l'écran de consentement OAuth gardent leur propre politique, indépendante de ce
réglage.

### Mode production (systemd)

```bash
sudo ./elpis service install    # ou : service remove ; ./elpis service print pour voir les unités
```

- Une unité par service (`elpis-qdrant`, `elpis-rag`, `elpis-toolhost`,
  `elpis-main`, `elpis-admin`, `elpis-browser`), regroupées sous
  `elpis.target`, démarrées au boot, relancées en cas d'échec, journaux dans
  journald (`./elpis logs main -f`).
- Utilisateur des services : celui qui lance `sudo` (proposé, modifiable ;
  `ELPIS_USER=nom` sans question). Il doit pouvoir lire le dépôt ; il est
  ajouté au groupe `docker`.
- `elpis.target` entraîne aussi Caddy quand HTTPS est actif, et les services
  vocaux locaux (`elpis-whisper`, `elpis-tts`) quand ils sont installés.
- `.env` est lu par chaque unité (`EnvironmentFile`) ; il l'emporte sur les
  valeurs par défaut des unités.

### Lancement minimal

```bash
export APP_SESSION_SECRET="$(cat user_db/.session_secret)"
ELPIS_RACINE=$PWD APP_MODE=main node/bin/node apps/core/dist/main.mjs
```

> **Secret de session.** Ordre : `APP_SESSION_SECRET` > `config.json ›
> app.session_secret` > `user_db/.session_secret` (créé en 0600 sous verrou
> `fcntl` au premier démarrage, et re-durci à 0600 à chaque boot). Les
> placeholders publiés (`mysecretsessiontomodify`, `changeme`, …) sont **traités
> comme absents** — sans quoi l'exemple commité aurait servi de clé de
> signature. Un secret faible ou court (< 32 c.) déclenche un avertissement
> `[CRITICAL]` au boot.

---

## Configuration

### Fichier `config.json`

`config.json`, **à la racine du dépôt** (chemin surchargeable par
`APP_CONFIG_PATH`), est la configuration d'instance. Il n'est **pas versionné** :
le dépôt ne contient qu'un exemple.

> Il vivait autrefois dans `shared_infra/`. Une installation qui ne
> l'a pas encore déplacé continue de fonctionner — `shared_infra/config.py` se
> replie sur l'ancien emplacement en l'affichant au démarrage. Ce repli est
> transitoire : sans lui, un fichier introuvable serait lu comme `{}` **sans
> erreur**, et l'instance repartirait avec un secret de session neuf (sessions
> invalidées), sans TLS et sans clé Qdrant.

Sections :

| Section | Contenu |
|---|---|
| `llama` | `engine`, `url` (base du serveur) ou `ip`/`port`, `api_key`, `model`, timeouts, retries, `max_concurrency`, `max_models`, `n_ctx`, `max_tool_iterations`, `tool_timeout_s`, `thinking_budget_tokens`, `max_tokens_chat`/`max_tokens_thinking`, `thinking_output_uncapped`, `think_resume_max`/`think_resume_total_tokens` |
| `mcp` | `tools_cache_ttl_sec`, `servers_dir`, `local_url`/`local_host`/`local_port`/`local_transport` |
| `app` | `db_path`, `session_secret`, `max_recent_chats`, `sandbox_dir`, `enable_model_selector`, `sandbox_quota_mb`, `max_upload_mb`, chemins `system_prompts.*` |
| `llm` | `scheduling_mode`, `compression.*`, `compaction.*`, `prune.*`, `task.*` (sous-agents), `debug.*`, `allowed_provider_types`, `ctx_image_token_cost` |
| `agents` | Sous-agents (`task`), propre au TS, relu à chaud et écrit par `POST /api/admin/agents` seulement (Console › Sandbox › Sous-agents ; l'éditeur brut et les écritures champ par champ ne l'écrivent pas) : `read_only.defaults.<type>` (lecture seule par défaut ; `explore` vrai, les autres faux), `read_only.forced.<type>` (imposée : ni le compte ni l'agent principal ne la lèvent ; faux par défaut), `max_parallel` (sous-agents d'un même tour lancés ensemble, 1 à 10, défaut 3 ; sur llama.cpp, plafonné à `total_slots − 1` pour laisser un slot au parent, cf. [Sous-agents](architecture.md#sous-agents-outil-task)). Types : `explore`, `implement`, `verify`, `web`, `pr` et `custom` (tous les agents personnels). Lecture seule effective = imposée, OU demandée par `task(read_only=true)`, OU case du compte (si posée, sinon défaut). Une valeur illisible ou hors bornes retombe sur son défaut |
| `memory` | `enabled`, `memory_char_limit`, `user_char_limit` |
| `skills` | `dir`, `user_dir`, `top_n`, `min_score`, `char_budget`, `index_max` |
| `executors` | `image` (image tierce seulement ; sans elle, celle de la version), `limits.*`, `exec_user`, `force_user_docker`, `idle_kill_hours`, `runtime`, `extra_run_args`, `network_profiles[]`, `jobs.*` (tâches de fond), `disk.warn_pct` / `disk.refuse_pct` (espace disque des bacs en %, 85 et 97 par défaut, relus à chaud : alerte des outils qui écrivent, puis refus des écritures et des nouvelles tâches ; Console › Sandbox › Limites) |
| `security` | `password_policy.*`, `session.*` (cookie, `max_age_sec`, `same_site`, `https_only`, `global_min_ts`), `https.*` (`enabled`, ports, `ca_file`), `listen` (`local` \| `lan`, voir [Écoute](#écoute-securitylisten)), `csp` (`enforce` \| `report-only` \| `off`, voir [CSP](#politique-de-sécurité-du-contenu-securitycsp)) — ⚠ `https.*` + `listen` + `session.https_only` + `session.global_min_ts` appartiennent à leurs endpoints, l'éditeur brut ne les écrit pas |
| `vision` / `desktop` | Endpoint d'annotation, format, modèle, passes ; cibles desktop, scopes, budgets |
| `rag` | Extracteur, magasin, Qdrant, embeddings, reclassement, OCR, groupes, quotas, indexation : voir [RAG](#rag-rag) |
| `maintenance` | Rétentions, heure de passe, digest quotidien |
| `features` | Flags globaux (`opencode`, `office_preview`) |
| `welcome` / `app_info` / `login_page` | Branding (édité depuis la console admin) ; `app_info.logo_b64` est le logo de l'application et l'avatar de l'assistant pour tous les comptes |
| `skins` | `dir` (dossier des skins importés ou créés, défaut `user_skins`, surchargeable par `APP_SKINS_DIR`, lu au démarrage), `enabled` (`{id: booléen}`, relu à chaud : un intégré absent prend sa valeur de `frontend/css/skins/skins.json`, Kiki désactivé ; un skin importé absent est désactivé ; Ardoise et le skin par défaut restent actifs), `default` (défaut `elpis` : skin des comptes sans choix ou dont le skin a été désactivé). Réglé depuis Console › Système › Apparence ; le dossier est inclus dans les sauvegardes complètes |
| `voice` | Moteur vocal — `enabled`, puis deux sous-blocs indépendants : `stt.*` (adresse, `format` parmi `whisper.cpp`/`openai`/`llama-audio`, langue, vocabulaire, `logprob_min`, plafonds) et `tts.*` (adresse, `format`, voix, vitesse, plafonds). Coercition et bornes dans `apps/core/src/voix/config.ts`, relues à CHAQUE appel |
| `image` | Génération d'images — `enabled`, `provider` (`sdcpp` \| `openai`), `url`, `model`, `verify`, `ca_pem`, `timeout_sec`, `max_concurrent`, `max_n`, `max_side`, `default_side`, `size_policy` (`free` \| `fixed`) + `sizes`, `edit_mode` (`init` \| `ref`), `keep_per_user`, `groups`, `tool_max_calls`, `enhance_enabled`. ⚠ `api_key_enc` appartient à `PUT /api/admin/image/key` : l'éditeur brut ne l'écrit pas. Voir [Génération d'images](#génération-dimages) |

### RAG (`rag`)

Relue à chaque appel par le core (`packages/config/src/rag.ts`) : un
changement s'applique sans redémarrage. Console › Modèles & services › RAG
l'écrit champ par champ ; `./elpis configure` (page RAG) pose l'adresse et le
modèle des embeddings, le reclassement et l'OCR. Sans `embed.url`, le RAG est
désactivé (la page RAG le dit, aucune indexation).

```json
"rag": {
  "service_url": "http://127.0.0.1:8000",
  "qdrant_url": "http://127.0.0.1:6333",
  "embed": { "url": "http://gpu.lan:8081", "model": "bge-m3", "api_key": "", "batch": 32, "timeout_s": 60 },
  "reranker": { "enabled": false, "url": "", "model": "bge-reranker-v2-m3" },
  "ocr": { "url": "", "model": "", "api_key": "", "timeout_s": 180, "max_side_px": 1280, "max_tokens": 8192 },
  "groups": [],
  "quotas": { "storage_mb": 2048, "collections": 10, "file_mb": 200, "docs_per_collection": 2000 },
  "indexation": { "concurrence": 2, "par_compte": 1 }
}
```

| Clé | Rôle | Défaut |
|---|---|---|
| `service_url` | Extracteur `rag_app` (variable `RAG_SERVICE_URL` prioritaire) | `http://127.0.0.1:8000` |
| `service_token` | Jeton de l'extracteur ; sans lui, `RAG_SERVICE_TOKEN` puis `user_db/.rag_service_token` (écrit par `./elpis configure`, lu aussi par l'extracteur) | — |
| `store_dir` | Magasin des fichiers (`RAG_STORE_DIR` prioritaire) : originaux, extraits, pages rendues, par compte et par collection ; `./elpis` donne le même dossier à l'extracteur | `<dossier de la base>/rag` (`user_db/rag`) |
| `qdrant_url` | Qdrant, local et sans clé (`./elpis` le lance sur `127.0.0.1:6333`) | `http://127.0.0.1:6333` |
| `embed.*` | Serveur d'embeddings compatible OpenAI (`/v1/embeddings`), modèle, clé, taille des lots (1 à 512), délai (1 à 600 s). Changer de modèle lance la réindexation de toutes les collections (console) | modèle `bge-m3` |
| `reranker.*` | Reclassement facultatif (`/v1/rerank`) | désactivé |
| `ocr.*` | Modèle de vision compatible OpenAI qui lit les pages scannées (format « grounding » de la famille DeepSeek-OCR) ; `url` vide = pas d'OCR. Le core envoie ces réglages à l'extracteur à chaque extraction d'une collection où l'OCR est activé | désactivé |
| `groups` | Identifiants des groupes qui ont le droit RAG ; vide = tous les comptes ; l'admin l'a toujours | `[]` |
| `quotas.*` | Par compte : stockage (Mo), collections, taille d'un fichier (Mo), documents par collection ; une surcharge par compte (Console › RAG › Quotas par compte, `settings_json.rag_quota`) remplace clé par clé | 2048, 10, 200, 2000 |
| `indexation.*` | Documents indexés en même temps sur l'instance (1 à 16) et par compte (au plus `concurrence`) | 2, 1 |

Une valeur illisible ou hors bornes retombe sur son défaut.

- **Droits.** Le compte qui crée une collection en est le propriétaire et le
  seul à la modifier. Il la publie aux groupes dont il est membre ; seul un
  admin publie à « Tous les comptes ». Les comptes qui la lisent (lecteurs)
  cherchent dedans et voient les passages ; ils n'ouvrent l'original que si le
  propriétaire l'a permis. La publication garde sa valeur si son auteur quitte
  le groupe ou perd le droit RAG, jusqu'à la suppression de son compte. L'admin
  voit les métadonnées de toutes les collections et peut en supprimer une ; il
  ne lit jamais le contenu d'une collection qui ne lui est pas ouverte.
- **Secrets.** `embed.api_key`, `ocr.api_key` et `service_token` sont masqués
  (`********`) dans la console et l'éditeur brut, absents des journaux et des
  copies de configuration des comptes (`user_db/configs/`).
- **Extracteur.** Ses propres réglages (délais, mémoire, tailles, isolation
  `RAG_ISOLATION`) sont des variables d'environnement :
  [`rag_app/README.md`](../rag_app/README.md). `RAG_EXTRACT_TIMEOUT_S` sert aussi
  au délai du core. Il écoute sur `127.0.0.1:8000` (`RAG_HOST` pour un core sur
  une autre machine, qui doit alors voir le même magasin).
- **Ancien RAG.** Les réglages d'embeddings, de reclassement et d'OCR de
  `rag_app/rag_config.json` ont été repris une fois dans `rag.*`, sans écraser
  une valeur déjà posée, à la mise à jour qui a supprimé l'ancien RAG
  ([exploitation.md](exploitation.md#passage-au-rag-intégré)).

### Moteur d'inférence déclaré (`llama.engine`)

Le type écrit dans `config.json` fait foi : Elpis n'essaie pas de deviner le
moteur. Il applique le profil du type déclaré (une table unique,
`apps/core/src/llm/profils.ts`) : adresses, capacités, métriques et options de
lancement conseillées. Une adresse attendue qui ne répond pas est signalée
(journal du démarrage, Console › Inférence › Capacités) sans changer de
comportement.

```json
"llama": {
  "engine": "vllm",
  "url": "http://gpu.lan:8000",
  "api_key": "",
  "model": "Qwen/Qwen3-8B"
}
```

- **`engine`** : `llamacpp` (alias `llama.cpp`, `llama-cpp`, `llama`), `vllm`,
  `sglang` ou `generic` (alias `openai`, `tgi`, `ollama`, `lmstudio` ; toute
  autre valeur vaut `generic`). Pris en compte au redémarrage.
- **`url`** : la base du serveur (`http://hôte:port`) ; une adresse qui finit par
  `/v1` ou `/v1/chat/completions` est acceptée et normalisée. Sans `url`,
  `ip` et `port` donnent `http://ip:port`. Les configurations existantes
  (URL complète) continuent de marcher.
- **`api_key`** : facultative, la valeur de `--api-key` du serveur, envoyée en
  `Authorization: Bearer` sur chaque appel au moteur par défaut (`LLAMA_API_KEY`
  la remplace). Elle n'est jamais renvoyée à l'interface : la console affiche
  `********` et l'éditeur brut la garde quand ce masque revient tel quel ; un
  champ vidé la retire. Elle n'apparaît dans aucun journal.
- **`model`** : pour vLLM, un nom servi (`--served-model-name`, sinon le chemin
  du modèle) ; vLLM refuse un autre nom, la sonde le signale.

Ce que fait chaque profil :

| | llama.cpp | vLLM 0.31 | SGLang 0.5.21 | generic |
|---|---|---|---|---|
| Santé | `/health` | `/health` | `/health` | `/v1/models` |
| Version | `/props` (`build_info`) | `/version` | `/server_info` | — |
| Contexte | `/props` (par slot) | `max_model_len` de `/v1/models` | `max_model_len` de `/v1/models` | déclaré ou deviné |
| Jetons exacts | `/apply-template` puis `/tokenize` | `/tokenize` (`messages` en un appel) | `/v1/tokenize` (`messages` en un appel) | estimés |
| Métriques | `/metrics` (`--metrics`) | `/metrics` (`vllm:*`) | `/metrics` (`--enable-metrics`) | — |
| Cache KV de la jauge | `llamacpp:kv_cache_tokens` ÷ `n_ctx_total` | `vllm:kv_cache_usage_perc` × blocs de `vllm:cache_config_info` | `sglang:kv_used_tokens` ÷ `sglang:max_total_num_tokens` (répliques `--dp` additionnées, rangs TP comptés une fois ; sinon `sglang:token_usage` et `max_total_num_tokens` de `/server_info`) | — |
| Prefill du moteur (charge) | — | délai du premier jeton (`vllm:time_to_first_token_seconds`) | délai du premier jeton (`sglang:time_to_first_token_seconds`), débit de prefill (`sglang:realtime_tokens_total{mode="prefill_compute"}`) | — |
| Jetons repris du cache | `usage.prompt_tokens_details` ou `timings.cache_n` | `usage.prompt_tokens_details.cached_tokens` (`--enable-prompt-tokens-details`) | idem (`--enable-cache-report`) | si fourni |
| Concurrence | file d'Elpis (slots) | lots continus du moteur | lots continus du moteur | requêtes en parallèle |
| Débits d'un appel (bulle) | `timings` du flux | mesurés par Elpis : génération = après le premier jeton ; lecture (prefill = délai du premier jeton, file du moteur comprise) seulement avec les jetons en cache rapportés (`--enable-prompt-tokens-details`) | idem (`--enable-cache-report`) | — |
| Charger / décharger | mode routeur | non (modèle choisi au lancement) | non | non |

Avec vLLM et SGLang, les requêtes partent en parallèle : le moteur les
regroupe lui-même (`--max-num-seqs`, `--max-running-requests`) et
`llama.max_concurrency` ne s'applique qu'à llama.cpp. Le sélecteur de modèle du
chat n'affiche ni « Charger » ni « Décharger » ; la jauge du cache KV et la
ligne de charge (requêtes en cours et en attente, débit, débit de prefill,
délai du premier jeton, cache de préfixe) viennent des métriques du moteur. Le
délai du premier jeton est la moyenne des requêtes finies entre deux lectures ;
sans requête nouvelle, la dernière moyenne reste affichée.

Lancements conseillés (options vérifiées dans le code de ces versions) :

```bash
# vLLM 0.31 — le cache de préfixe est actif par défaut ; ne pas passer --disable-log-stats (métriques)
vllm serve Qwen/Qwen3-8B --host 0.0.0.0 --port 8000 \
  --max-model-len 32768 \
  --reasoning-parser qwen3 \
  --enable-auto-tool-choice --tool-call-parser hermes \
  --enable-prompt-tokens-details \
  --api-key "$CLE"

# SGLang 0.5.21
python -m sglang.launch_server --model-path Qwen/Qwen3-8B --host 0.0.0.0 --port 30000 \
  --context-length 32768 \
  --reasoning-parser qwen3 \
  --tool-call-parser qwen25 \
  --enable-metrics --enable-cache-report \
  --api-key "$CLE"
```

- **Réflexion** : sans `--reasoning-parser`, la réflexion d'un modèle qui
  réfléchit arrive dans la réponse. Noms : `qwen3`, `deepseek_r1`,
  `openai_gptoss` (vLLM) ; `qwen3`, `deepseek-r1`, `gpt-oss` (SGLang).
- **Raisonnement conservé** (SGLang, désactivé par défaut) : l'interrupteur des
  réglages de génération est offert quand le serveur a un `--reasoning-parser`.
  Activé, la réflexion de chaque appel d'outil du tour est rendue au moteur
  (`reasoning_content` du message assistant) ; le gabarit du modèle décide de ce
  qu'il garde (Qwen3, GLM-4.5/4.6, MiniMax-M2 : la réflexion qui suit la
  dernière question). Le prompt d'un tour d'outils s'allonge d'autant, et la
  question suivante recalcule les appels d'outils de ce tour : cette réflexion
  n'est jamais enregistrée dans l'historique. vLLM ne la reçoit pas.
- **Outils** : sans parseur d'appels d'outils, le modèle ne peut pas appeler les
  outils d'Elpis : `--enable-auto-tool-choice --tool-call-parser hermes`
  (vLLM, Qwen ; `llama3_json` pour Llama) ou `--tool-call-parser qwen25`
  (SGLang ; `llama3` pour Llama). Le parseur suit le format d'appel du modèle,
  pas seulement sa famille ; noms SGLang : `qwen25` (Qwen2.5, Qwen3 : JSON dans
  `<tool_call>`), `qwen3_coder` (Qwen3-Coder et modèles au format XML
  `<function=…>`), `glm45` (GLM-4.5, 4.6), `glm47`, `kimi_k2`, `minimax-m2`,
  `gpt-oss`. Un parseur inadapté avale les appels ou les livre en texte ; la
  sonde le signale quand le nom du modèle le permet. Une réponse vide après la
  réflexion alors que des outils étaient offerts peut venir du parseur d'outils
  ou du parseur de réflexion.
- **Clé d'API** : la `--api-key` de vLLM ne protège que `/v1/*` (`/tokenize`,
  `/metrics`, `/version` restent ouverts) ; celle de SGLang tout sauf
  `/health`, `/ready` et `/metrics`. Gardez ces serveurs sur un réseau fermé.
- **Port** : sur la machine d'Elpis, le port 8000 est celui de l'extracteur du RAG ;
  lancez vLLM ailleurs ou sur un autre port (`--port`). L'assistant et
  `configure` le signalent.

L'installeur (`./install.sh`, `./elpis configure`) propose ces quatre types,
la clé et le port par défaut de chacun ; sa note finale et `./elpis doctor`
rappellent ces drapeaux pour vLLM et SGLang. `./elpis doctor` sonde aussi
`GET /v1/models` avec la clé (« clé refusée » sur un 401) et, si `main` tourne,
affiche la dernière sonde du core (lignes `[moteur]` de son journal, depuis le
dernier démarrage).

**Sonde.** Au démarrage, le process `main` sonde le moteur déclaré et écrit une
ligne de résumé (`[moteur] vLLM 0.31.0 sur http://…, modèle …, contexte …
jetons, métriques oui, tokenisation exacte oui, concurrence gérée par le
moteur`), puis chaque option manquante avec le drapeau exact à ajouter. Console ›
Inférence › Capacités affiche le même rapport ; « Tester » le refait, avec une
réponse d'un jeton pour vérifier le détail des jetons en cache de vLLM. Pendant
le chat, une réflexion reçue en balises, des appels d'outils reçus en texte, une
réponse vide après la réflexion alors que des outils étaient offerts ou une
réponse de vLLM sans `prompt_tokens_details` ajoutent le conseil
correspondant (journal et console), une fois par moteur. Le test d'un connecteur
`llamacpp`, `vllm` ou `sglang` montre le même rapport.

**Connecteurs.** Les types `vllm` et `sglang` (préréglages « vLLM (local) » et
« SGLang (local) ») utilisent le même profil que le moteur par défaut ; leur
adresse est la base du serveur suivie de `/v1`.

### Fournisseurs cloud des comptes (`llm.allowed_provider_types`)

Un compte branche un fournisseur cloud avec sa propre clé dans Réglages › Modèles
IA. `llm.allowed_provider_types` liste les types que les comptes **non
administrateurs** (modérateurs compris) peuvent y choisir : `anthropic`, `openai`,
`mistral`, `groq`, `openrouter`, `deepseek`, `moonshot`, `opencode`.

- **Absente, vide ou illisible : aucun** (défaut depuis la 0.1.0 ; avant, tous
  les types cloud étaient ouverts). Une instance hors ligne ne laisse ainsi partir
  aucune donnée vers un service cloud sans décision de l'administrateur.
- Les comptes **administrateurs** ne sont pas concernés : leurs connecteurs
  personnels gardent tous les types cloud, et les connecteurs partagés
  (Console › Modèles, y compris `llamacpp`, `vllm` et `generic`) ne changent pas.
- Les types locaux (`llamacpp`, `vllm`, `generic`) restent réservés aux connecteurs
  partagés : un compte non administrateur s'en sert par les serveurs que
  l'administrateur partage et par le moteur intégré.
- La liste est relue à chaque création et à chaque génération : un connecteur
  personnel d'un type fermé reste en base, marqué « fermé par l'administrateur »
  dans les Réglages, mais n'est plus utilisable (« Ce fournisseur n'est plus
  autorisé sur cette instance. ») tant que son type n'est pas rouvert.

Réglage : Console › Modèles › Accès utilisateurs › Fournisseurs autorisés, ou à
la main :

```json
{ "llm": { "allowed_provider_types": ["anthropic", "mistral"] } }
```

**Mise à jour depuis la 0.0.1** : sans cette clé, les connecteurs cloud
personnels des comptes non administrateurs cessent de servir après la mise à
jour ; cochez les types à garder dans la console.

Chaque utilisateur a en plus ses réglages en base (`users.settings_json`) ;

`user_db/configs/{user_id}.json` conserve une copie personnelle de la config
d'application.

> **Flags de fonctionnalités GLOBAUX** (`config.json › features`) : lus par
> `feature_enabled(name)` (défaut `true` si absent), **relus sur disque à chaque
> appel** (donc multi-worker-safe et sans redémarrage), exposés au front par
> `GET /api/public-config`, et **gardés côté backend** (404). Aujourd'hui :
> `opencode` et `office_preview`. Le front reçoit aussi `agents` (dérivé de `llm.task.enabled`),
> l'interrupteur maître des sous-agents, ainsi que `voice_stt` et `voice_tts`
> (dérivés de `voice.enabled` **et** de la présence d'une adresse). Ces deux-là
> sont en défaut **OFF strict** : contrairement aux autres, une fonction qui
> ouvre le micro ou sort du son ne s'active pas par rétro-compatibilité.

### Variables d'environnement

Toute valeur de `config.json` peut être surchargée par l'environnement, qui est
**toujours prioritaire**. Une variable positionnée mais **vide** est traitée
comme absente.

#### Inférence

| Variable | Clé JSON | Défaut | Description |
|---|---|---|---|
| `LLAMA_IP` | `llama.ip` | `127.0.0.1` | Adresse du moteur |
| `LLAMA_PORT` | `llama.port` | `8080` | Port |
| `LLAMA_URL` | `llama.url` | dérivée | Base du serveur (`/v1` ou `/v1/chat/completions` acceptés) — prioritaire sur IP/PORT |
| `LLAMA_API_KEY` | `llama.api_key` | vide | Clé du moteur par défaut (`Authorization: Bearer`), jamais affichée |
| `LLAMA_MODEL` | `llama.model` | `local-model` | Modèle par défaut |
| `LLAMA_ENGINE` | `llama.engine` | `llamacpp` | `llamacpp` \| `vllm` \| `sglang` \| `generic` (le type déclaré fait foi) |
| `LLAMA_TIMEOUT_SEC` | `llama.timeout_sec` | `600` | Timeout requête |
| `LLAMA_RETRIES` | `llama.retries` | `3` | Tentatives |
| `LLAMA_RETRY_BACKOFF_SEC` | `llama.retry_backoff_sec` | `0.6` | Base du backoff |
| `LLAMA_RETRY_BACKOFF_CAP_S` | `llama.retry_backoff_cap_s` | `15` | Plafond full-jitter |
| `LLAMA_LOADING_WAIT_S` | `llama.loading_wait_s` | `90` | Attente « modèle en chargement » (503 → sonde `/health`) |
| `LLAMA_MAX_CONCURRENCY` | `llama.max_concurrency` | `4` | llama.cpp : repli si `/props.total_slots` indisponible (vLLM et SGLang regroupent eux-mêmes les requêtes) |
| `ELPIS_LLM_SLOTS_DIR` | — | `/tmp/elpis_llm_slots` | Créneaux du llama-server communs à tous les process (un fichier verrouillé par créneau) ; doit appartenir au compte du service |
| `LLAMA_MAX_MODELS` | `llama.max_models` | `1` | Modèles simultanés côté serveur |
| `LLAMA_MAX_TOOL_ITERATIONS` | `llama.max_tool_iterations` | `200` | Itérations **productives** max par tour |
| `LLAMA_TOOL_TIMEOUT_S` | `llama.tool_timeout_s` | `300` | Borne dure par appel d'outil |
| `LLAMA_TOOL_LOOP_MAX_S` | `llama.tool_loop_max_s` | `0` (off) | Budget mur d'horloge d'un tour outillé |
| `LLAMA_THINKING_BUDGET_TOKENS` | `llama.thinking_budget_tokens` | `8192` | Budget de réflexion (chat simple ; clampé `[512..131072]`, alias llama.cpp `reasoning_budget_tokens`) |
| `LLAMA_MAX_TOKENS_CHAT` | `llama.max_tokens_chat` | `16384` | Cap théorique de génération (mode chat) |
| `LLAMA_MAX_TOKENS_THINKING` | `llama.max_tokens_thinking` | `24576` | Cap théorique (mode thinking) — sert surtout la **réserve de prompt** depuis `thinking_output_uncapped` |
| `LLAMA_THINKING_OUTPUT_UNCAPPED` | `llama.thinking_output_uncapped` | `true` | Mode thinking **local** : aucun `max_tokens` envoyé (raisonnements longs non coupés ; aligné Open WebUI / webui llama.cpp) |
| `LLAMA_THINK_RESUME_MAX` | `llama.think_resume_max` | `6` | Auto-reprises max d'un raisonnement coupé (`finish=length` en plein `<think>`) par appel LLM ; `0` = off |
| `LLAMA_THINK_RESUME_TOTAL_TOKENS` | `llama.think_resume_total_tokens` | `131072` | Budget total de thinking cumulé par chaînage d'auto-reprises |

> ⚠️ `LLAMA_MAX_MSGS` a été **retiré**. Le clamp en *nombre* de
> messages amputait silencieusement l'historique. La seule borne est désormais
> le budget en **tokens** ; au-delà, le serveur répond « contexte dépassé »
> (`KIND_CONTEXT_OVERFLOW`) avec un message utilisateur clair.

#### Contexte, compaction, élagage

| Variable | Clé JSON | Défaut | Description |
|---|---|---|---|
| `APP_COMPACTION_BUFFER_TOKENS` | `llm.compaction.buffer_tokens` | `0` (auto) | Marge sous le plafond (`min(20k, 10 % n_ctx)`) |
| `APP_COMPACTION_PARTIAL_TARGET_RATIO` | `llm.compaction.partial_target_ratio` | `0.6` | Cible d'une compaction partielle |
| `APP_COMPACTIONS_PER_RUN_MAX` | `llm.compaction.per_run_max` | `8` | Compactions réussies par run (plancher mis à l'échelle du budget d'itérations) |
| `APP_COMPRESSION_MODEL` | `llm.compression.external_model` | — | Modèle dédié au résumé |
| `APP_COMPRESSION_ENDPOINT_URL` | `llm.compression.endpoint_url` | — | Endpoint dédié (path OpenAI complété) |
| `APP_COMPRESSION_ENDPOINT_MODEL` | `llm.compression.endpoint_model` | — | Modèle sur cet endpoint |
| `APP_COMPRESSION_ENDPOINT_TIMEOUT_SEC` | … | `120` | Timeout |
| `APP_COMPRESSION_MAX_PER_CHAT` | `llm.compression.max_per_chat` | `12` | Cap dur (auto **et** manuelles) ; `0` = illimité |
| `APP_PRUNE_PROTECT_TOKENS` | `llm.prune.protect_tokens` | `0` (auto 20 % n_ctx) | Fenêtre récente jamais élaguée |
| `APP_PRUNE_MIN_TOKENS` | `llm.prune.min_tokens` | `0` (auto) | Gain minimal pour acter une passe |
| `APP_PRUNE_EVERY_ITERS` | `llm.prune.every_iters` | `10` | Cadence d'élagage **pendant** un run (0 = fin de tour) |
| `APP_CTX_IMAGE_TOKEN_COST` | `llm.ctx_image_token_cost` | `1500` | Coût forfaitaire d'une image (surestime volontairement) |

> **Clés inertes.** `trigger_after_turns`, `compress_every`, `pct_of_ctx`,
> `cooldown_iters`, `min_growth_tokens` traînent dans d'anciens `config.json` :
> plus aucun lecteur. Le déclenchement de compaction est une **règle unique
> d'occupation** — quand le prompt réel atteint `usable = n_ctx − cap de
> génération − buffer`. Ne pas les documenter comme des leviers.

#### Sous-agents

| Variable | Clé JSON | Défaut |
|---|---|---|
| `APP_TASK_CHILD_TIMEOUT_S` | `llm.task.child_timeout_s` | `3600` |
| `APP_TASK_SUBAGENT_DEPTH` | `llm.task.subagent_depth` | `1` — **sans effet** en TS : un sous-agent ne lance jamais de sous-agent (lu pour la compatibilité de `config.json`) |
| `APP_TASK_RESUME_TTL_S` | `llm.task.resume_ttl_s` | `21600` |
| `APP_TASK_RESUME_MAX` | `llm.task.resume_max` | `200` |
| `APP_TASK_MAX_ITERS_EXPLORE` / `_IMPLEMENT` / `_VERIFY` / `_WEB` / `_PR` | `llm.task.max_iters.*` | `60` / `100` / `60` / `60` / `40` |
| `APP_TASK_MAX_ITERS_CUSTOM` | `llm.task.max_iters.custom` | valeur de `_GENERAL` |
| `APP_TASK_MAX_ITERS_GENERAL` | `llm.task.max_iters.general` | `80` (repli des agents personnalisés) |
| — | `llm.task.enabled` | `true` (interrupteur maître) |

#### Application

| Variable | Clé JSON | Défaut | Description |
|---|---|---|---|
| `APP_CONFIG_PATH` | — | `config.json` (racine) | Chemin de la config |
| `APP_CONTEXT_CONFIG` | — | `shared_infra/context_config.json` | Textes LLM |
| `APP_DB_PATH` | `app.db_path` | `user_db/app.db` | Fichier SQLite (moteur par défaut) |
| `APP_SESSION_SECRET` | `app.session_secret` | `user_db/.session_secret` | Signature des sessions |
| `APP_MAX_RECENT_CHATS` | `app.max_recent_chats` | `100` | Conversations actives max — **destructif** au-delà (cf. plus bas) ; relu à chaud |
| `APP_SANDBOX_DIR` | `app.sandbox_dir` | `user_sandboxes` | Racine des sandboxes (propagée en absolu) |
| `APP_SKILLS_DIR` / `APP_USER_SKILLS_DIR` | `skills.dir` / `skills.user_dir` | `skills` / `user_skills` | Stores de skills |
| `APP_SKINS_DIR` | `skins.dir` | `user_skins` | Skins importés ou créés depuis la console (un sous-dossier `<id>/` par skin) |
| `APP_MAX_UPLOAD_MB` | `app.max_upload_mb` | `50` | Plafond par fichier uploadé |
| `APP_BUILD_ID` | — | auto | Cache-busting des assets |
| `APP_MODE` | — | `main` | `main` \| `admin` \| `full` (absent ou invalide → `main`) |
| `APP_SERVICE` | — | `main` | Tag de logs (`./elpis start` le pose par service) |
| `ADMIN_PUBLIC_URL` / `MAIN_PUBLIC_URL` | — | — | URLs externes (réécriture localhost automatique) |
| `APP_LLM_SCHEDULING` | `llm.scheduling_mode` | `auto` | `auto` \| `classic` \| `optimized` |
| `APP_GIT_TOOL_TIMEOUT_S` | `tools.git.timeout_s` | `60` | Commandes Git locales |
| `APP_*_RETENTION_DAYS` | `maintenance.*_retention_days` | 90 à 400 selon la table | Rétentions (`0` = pas de purge) ; celle de `usage_events` vaut aussi pour les exécutions (`runs`) |
| `APP_MAINTENANCE_HOUR` | `maintenance.hour` | `6` | Heure de la passe quotidienne |

#### Serveur MCP local

**Manifeste `mcp.json`.** Les serveurs d'outils par défaut se
déclarent dans `mcp.json` à la racine (format `mcpServers` des clients MCP +
bloc `x-elpis` par entrée : rôle, familles, `default_on`, familles publiées à
opencode, commande stdio exportée). Schéma : `docs/schemas/mcp.schema.json`. Chargeur :
`packages/mcp/src/manifeste.ts`. Sans fichier, le manifeste est synthétisé depuis
les variables ci-dessous (comportement hérité). Avec un fichier, `LOCAL_MCP_URL`,
`LOCAL_MCP_TOKEN`, `LOCAL_MCP_TOOL_FAMILIES` et `LOCAL_MCP_OPENCODE_FAMILIES`
restent des SURCHARGES. Console admin → Connexions →
« Outils par défaut » : état des entrées + Recharger (`POST /api/admin/mcp/manifest/reload`,
sans redémarrage). Les serveurs `x-elpis.role: external` apparaissent dans le
panneau MCP (bloc « Déclarés », état per-chat `mf:<nom>`).

**Un serveur = une entrée = un endpoint.** `mcp.json` déclare UNE
entrée par famille d'outils, chacune avec son endpoint : `elpis-git` →
`http://<hôte>:8765/mcp/git`. Retirer l'entrée (ou `"enabled": false`) retire ses
outils du chat, sans toucher à aucune autre liste. L'hôte sert les trois
transports en parallèle pour chaque famille :

| transport | endpoint |
|---|---|
| HTTP streamable | `…:8765/mcp/<famille>` |
| SSE | `…:8765/sse/<famille>` (messages sur `/messages/`) |
| stdio | `node apps/toolhost/dist/main.mjs --stdio --families <famille>` |

Sans segment de famille, `/mcp` et `/sse` servent toutes les familles
enregistrées. L'app joint toujours l'hôte en réseau : elle ne lance jamais de
sous-process stdio, et un hôte arrêté rend les outils indisponibles (message
dans le journal ; `./elpis doctor` le signale). La commande stdio d'une entrée
`role: toolhost` (`x-elpis.fallback`, dérivée par défaut :
`<node> apps/toolhost/dist/main.mjs --stdio --families <ses familles>`, `"fallback": false`
pour la retirer) ne sert qu'à l'export vers un applicatif tiers. En stdio, l'hôte
sert lui-même ses familles natives, sans jeton ni port : le client est un process
local de confiance, le compte est le `_meta.username` de chaque appel (`guest`
sans lui), comme `python -m toolhost --stdio` ; aucune famille servie : refus (code 2).
Une entrée par famille, comme `mcp.example.json`. L'export signale dans `omis` (et la console
dans son message) les entrées sans le transport demandé ; en SSE, il demande à l'hôte
(`/manifest`, jeton de service et enveloppe de l'administrateur) quelles familles le
servent et omet celles qui ne le servent pas (hôte muet : rien n'est retiré). Les familles liées au compte (`chart`, `memory`,
`skill`, `todo`) sont des entrées `role: app` `type: inprocess` (sans URL) servies
par main lui-même : elles écrivent dans la base et les dossiers de l'app ;
`/api/mcp-bridge/<famille>` les sert directement et l'hôte d'outils ne les
enregistre pas. `./elpis configure`, `start` et `upgrade` retirent les URL
`http://127.0.0.1:8766/...` de l'ancien service `appmcp` d'un `mcp.json` existant (URL
distantes gardées), et `./elpis doctor` signale celles qui restent. L'origine et le jeton de l'hôte vivent
dans `toolHosts` (alias de `sandboxHosts`), avec un bloc `serve`
(`host`/`port`/`transports`). `relay: true` (posé par défaut, ajouté aux
`mcp.json` existants par `./elpis configure`) fait relayer par main, même en
loopback, `/api/sandbox/*`, `/api/terminal/*`, `/ws/terminal*`, les captures
(`/api/playwright/screenshot/*`) et les trames (`/api/desktop/frame/*`) vers
l'hôte, avec son jeton et l'identité signée de la session : main ne sert plus
ces routes lui-même. À la connexion, main ouvre aussi la session d'historique
des fichiers du compte sur l'hôte (`POST /internal/file-history/session`, mêmes
jeton et identité), là où l'éditeur et l'assistant notent leurs écritures :
3 s d'attente au plus ; en cas d'échec, la connexion passe, un avertissement
est journalisé et la session précédente continue. Hôte en loopback arrêté ou
relais inactif : la session s'ouvre sur place (même disque). Export prêt à
coller dans un autre applicatif :
Console admin → Connexions → « Outils par défaut » → Exporter, ou
`GET /api/admin/mcp/manifest/export?transport=http|sse|stdio&with_token=1`, ou
`GET /manifest?transport=…` sur l'hôte.

⚠ En transport stdio, la sortie standard EST le canal JSON-RPC : tout
diagnostic du service part sur `stderr`.

**Jetons personnels.** Chaque compte crée ses jetons dans Paramètres ›
Connexions ; seule leur empreinte SHA-256 est gardée (jeton montré une fois,
régénérable). Trois types : `pcr_` (opencode : greffon, `opencode.json`, relais
MCP), `ept_` (outils : relais MCP et façade OpenAPI, familles cochées ∩
politique, expiration) et `evt_` (vision d'une automatisation de bureau, 12 h,
seulement `/api/desktop/locate`, créé automatiquement, 20 au plus par compte,
masqué de la liste). Politique `mcp.tokens.*`, relue à chaud : `tools_enabled`
(vrai), `tools_families` (`fs,shell,git,desktop,browser,skill_run`),
`max_days` (90 ; 0 = sans limite), `max_per_user` (20, jetons opencode et
outils valides). Révoquer les sessions d'un compte, réinitialiser ou changer
son mot de passe révoque aussi tous ses jetons et ses applications OAuth ;
l'administrateur voit et coupe ces accès depuis la fiche du compte.
`GET /api/code/config` ne renvoie plus de jeton : l'installeur et l'appairage
en créent un.

**Façade OpenAPI.** Les familles du service partagé qui ont un
point d'accès externe (`fs`, `shell`, `git`, `desktop`, `browser`, `skill_run`)
sont aussi servies en
OpenAPI 3.1 sous l'origine de l'app : `GET /api/tools/<famille>/openapi.json`
(générée depuis `tools/list`, cache 60 s) et `POST /api/tools/<famille>/<outil>`.
Authentification par jeton d'outils `ept_` seul ; portée = familles du jeton ∩
`mcp.tokens.tools_families` ; `mcp.tokens.tools_enabled: false` coupe la façade
(404). L'appel part avec le jeton de SERVICE et l'identité du propriétaire du
jeton dans le `_meta` MCP, avec le délai propre à l'outil ; au plus 4 appels
simultanés par compte et par worker (429). Code :
`apps/core/src/outils/openapi.ts`, `apps/core/src/familles/openapi.ts`.

**Conformité MCP.** Le service d'outils suit la spécification
MCP (révisions 2024-11-05 à 2025-11-25, transport HTTP streamable), vérifiée par
un banc qui fait parler les clients de référence (SDK officiel et FastMCP) au
relais : `initialize` pour chaque version (version d'Elpis dans `serverInfo`,
`tools.listChanged: false` — aucune notification de liste n'est émise),
`tools/list` paginé (`nextCursor`, `LOCAL_MCP_LIST_PAGE_SIZE`, 100 par défaut,
de quoi tenir un endpoint de famille en une page), outils nommés, titrés,
annotés (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`),
`inputSchema`/`outputSchema` en JSON Schema, `structuredContent` conforme à
`outputSchema`. Un échec d'outil — arguments invalides compris — est un résultat
`isError` ; un outil inconnu, éteint ou hors des familles du client est une
erreur JSON-RPC `-32602` (même réponse dans les trois cas). Transport : le relais
public `/api/mcp-bridge[/<famille>]` ne sert que l'HTTP streamable, refuse une
`MCP-Protocol-Version` inconnue (400) et contrôle `Origin` (403) comme le service
d'outils : un en-tête absent (clients natifs) passe, sinon l'origine doit figurer
dans `mcp.allowed_origins` (relue à chaud, motif `scheme://hôte:*` accepté),
`app.cors_origins` ou `LOCAL_MCP_ALLOWED_ORIGINS` (jamais déduite de l'en-tête
`Host`, relais compris). Le relais ne retransmet jamais le jeton du client : il le vérifie
(`apps/core/src/familles/pont-mcp.ts`) puis présente au service un
jeton de DÉLÉGATION `dlg_…` (`packages/mcp/src/delegation.ts`) — enveloppe HMAC
signée avec le jeton de service, d'audience `elpis-mcp`, valable ±60 s, qui porte
le compte, le type de client et ses familles. Le service en tire les restrictions
qu'aurait eues le jeton du client, jamais la confiance de l'app ; un service qui
ne connaît pas `dlg_` le refuse (401). Un jeton personnel présenté directement au
service (client local sur la boucle locale) reste accepté.

**Autorisation OAuth 2.1 des clients MCP.** Elpis est son propre serveur
d'autorisation (spécification MCP « Authorization » 2025-11-25) :
`/.well-known/oauth-protected-resource[/api/mcp-bridge[/<famille>]]` (RFC 9728 :
la ressource annoncée est celle du chemin demandé, `<origine>/api/mcp-bridge`
ou `<origine>/api/mcp-bridge/<famille>` — un jeton obtenu pour une famille y
est borné ; portées `tools` et `tools:<famille>`), `/.well-known/oauth-authorization-server` (RFC 8414),
`/oauth/register` (RFC 7591, redirections limitées à `http://127.0.0.1|localhost|[::1]`
et `https://`), `/oauth/authorize` (session Elpis puis écran de consentement,
code + PKCE S256 obligatoire, `resource` RFC 8707 obligatoire), `/oauth/token`
(code ou rafraîchissement avec rotation), `/oauth/revoke` (RFC 7009). Les clients
décrits par un document https (CIMD) sont acceptés quand le document est
joignable (garde SSRF commune, connexion à l'adresse vérifiée, document récupéré
seulement pour un compte connecté). Tant qu'un client enregistré de lui-même
n'a été autorisé par personne, une demande en erreur s'affiche sur place,
sans redirection vers son adresse de retour. Le relais répond `401` avec
`WWW-Authenticate: Bearer resource_metadata="…"` (et `scope="tools:<famille>"` sur
un point d'accès de famille), et `403 insufficient_scope` pour une famille non
accordée. Jetons opaques en empreinte SHA-256 (`eoa_` accès, `eor_`
rafraîchissement ; un rafraîchissement ou un code rejoué révoque toute
l'autorisation), tables de la migration 0023, familles toujours bornées par
`mcp.tokens.tools_enabled` / `tools_families`. Politique `mcp.oauth.*`, relue à
chaud : `enabled` (vrai), `dcr_enabled` (vrai), `access_ttl_s` (3600),
`refresh_days` (30, borné par `mcp.tokens.max_days`). Console › Outils MCP :
réglages et clients enregistrés (suppression) ; Paramètres › Connexions :
applications autorisées par le compte (retrait).

**Politique d'exécution et événements live.** Chaque outil
porte ``meta.policy`` (``timeout_s``, ``serial``, ``replay_safe``, ``prune``,
``deny_for``) via ``_toolkit.tool_kw_*(…, **policy)`` / ``with_policy`` ; le
harnais la lit à la connexion (``_mcp_categories.tool_policy``) et n'utilise
les anciennes listes par nom qu'en repli (serveur externe, registre vide). Le
terminal en direct voyage en notifications MCP **structurées**
(``ctx.log(…, logger_name="elpis.shell", extra={"kind": "shell_output", …})``,
corrélées par ``log_token``/``call_id`` dans ``extra``) ; la sentinelle JSON
``__shell_output__`` n'est plus qu'un repli. Un **battement**
(``extra.kind: heartbeat``, toutes les ``ELPIS_TOOL_HEARTBEAT_S`` s, défaut 15,
0 = off) garde vivant le flux HTTP d'un ``tools/call`` long (shell, scripts de
skills, ``pw_wait``, ``desktop_wait``) ; le client le consomme sans événement.
``skill_run_script`` streame sa sortie comme ``execute_shell``.

**Hôte d'outils déportable.** L'hôte d'outils (``apps/toolhost``, bundle Node
``apps/toolhost/dist/main.mjs``) = le service MCP + l'API sandbox (``/api/sandbox/*``, git, cycle de vie, instantanés),
le terminal (``/api/terminal/*``, ``/ws/terminal*``) et les actifs (captures,
trames) sur UN port, derrière le jeton de service et une enveloppe d'identité
signée (``X-Elpis-Identity``, ``packages/securite/src/identite.ts``). Mode local :
``./elpis start`` le lance en loopback, l'app sert ses routeurs en direct
(aucun relais). Mode distant : ``mcp.json › sandboxHosts.<id>.url`` hors loopback
(ou ``relay: true``) → le relais du core (``apps/core/src/relais/``) relaie ces
chemins tels quels vers l'hôte (HTTP + WebSocket), fabrique l'enveloppe depuis la
session (jamais depuis un en-tête du navigateur), pousse le miroir des skills
(``POST /api/sandbox/skills-mirror``), rapatrie captures/trames pour la vision et
ouvre au login la session d'historique des fichiers (``POST /internal/file-history/session``).
Avec un ``toolhost.json`` (hôte distant), l'hôte n'ouvre pas ``app.db`` : identité par enveloppe/``_meta``
(``IdentityCapture``), rappels ``/api/internal/*`` (introspection des jetons
``pcr_``, identité, identifiants git ; pour la famille ``desktop`` servie par l'hôte TS :
notification de fin d'automatisation et mémoire des ancres, compte tiré de
l'enveloppe d'identité signée) avec le jeton de service, base LOCALE
(``toolhost.json › db_path``) pour ses sessions de terminal et la mémoire AX.
Familles liées au COMPTE (``memory``, ``todo``, ``chart``, ``skill`` = bibliothèque)
= entrées ``role: app`` du manifeste, servies par main, jamais par un hôte
distant (elles écrivent dans sa base) ; ``skill_run``
(exécution dans le sandbox) reste sur l'hôte. Déploiement :
``deploy/toolhost/`` (``install_toolhost.sh``, ``toolhost.example.json``,
``elpis-toolhost.service``,
``Caddyfile.toolhost``), schéma
``docs/schemas/toolhost.schema.json``. ``toolhost.json › bind.host`` vaut
``127.0.0.1`` dans l'exemple : l'app joint l'hôte par ``Caddyfile.toolhost``
(TLS, ``reverse_proxy 127.0.0.1:8765``). Sans ce frontal, ``0.0.0.0`` (ou l'IP
privée) est nécessaire, port filtré à l'hôte Elpis. ``app.memory_dir`` / ``APP_MEMORY_DIR`` :
racine du magasin mémoire (défaut : racine des sandboxes).

**Hôte d'outils TypeScript.** Le service ``toolhost`` de
``./elpis`` (unité ``elpis-toolhost``) est le bundle Node ``apps/toolhost/dist/main.mjs`` ;
il lit ``toolhost.json`` et les variables ``LOCAL_MCP_*`` / ``TOOLHOST_*`` (schéma
vérifié au démarrage, écarts journalisés, jamais bloquants) et, après un ``SIGHUP``,
s'arrête proprement puis sort en 75 pour être relancé, comme le core. Il sert
lui-même les familles de ``families`` portées en TypeScript (``browser``,
``desktop``, ``fs``, ``git``, ``office``, ``shell``, ``skill_run``) : ``/mcp/<famille>`` et ``/sse/<famille>`` de ces familles, mêmes
jetons, portée et délégation ; ``/health`` et ``/manifest`` les agrègent. Pour ne pas
servir une famille, la retirer de ``families``. L'ancienne clé ``familles_natives`` est
ignorée avec un avertissement (elpis-tools n'existe plus) ; ``./elpis doctor`` affiche
les familles servies (``main.mjs --familles-natives``).
Famille ``office`` native : l'hôte lance un worker Python partagé (``python -m elpis_office``
depuis ``office/``, relancé à l'appel suivant s'il disparaît) qui construit les documents Word et
PowerPoint en mémoire ; les fichiers du bac, l'historique, le verrou de l'éditeur, les graphiques
du cache du core, LibreOffice (``office_preview``) et le rendu ECharts sont faits par l'hôte.
``ELPIS_OFFICE_PARALLELE`` borne les appels simultanés du worker (8 par défaut).
Famille ``skill_run`` native : les skills du compte sont lus dans son magasin protégé
(``skills.user_dir``, hôte local) ou, à défaut, dans le miroir
``<sandbox_dir>/<compte>/skills`` que l'app pousse après chaque modification (hôte
distant) ; un ancien magasin laissé sur un hôte distant par le Python prime sur le
miroir : le supprimer.
Famille ``git`` native : le réseau (clone, fetch, pull, push) passe par le relais
authentifiant, le jeton d'un Connecteur Git n'est donné qu'à l'hôte exact du dépôt ;
``git_submit`` pousse la branche d'agent puis demande la PR au core
(``POST /api/internal/git/pr``, compte de l'enveloppe signée) qui résout le
connecteur, garde son ``api_base`` et appelle l'API de PR : le jeton de cette API
ne quitte pas le core. Core injoignable après le push : erreur
``pr_service_unavailable`` (branche poussée, PR à rouvrir) ; ``git_set_credential``
et le jeton saisi au clone sont enregistrés par le core
(``credential_store_unavailable`` s'il ne répond pas). Avec cette famille native,
un outil de l'agent ne crée de connecteur que pour un hôte (port compris) déjà
enregistré par le compte ou par un administrateur : sinon ``host_not_registered``,
le connecteur s'ajoute dans Réglages → Connecteurs Git ; il ne met à jour que les
connecteurs qu'il a créés (``auto``), jamais un connecteur saisi dans Réglages ou
importé (``connector_exists``) ; un ancien
``.git-credentials.json`` du bac suit la même règle (gardé si un hôte est refusé) ;
le clone de l'éditeur n'a pas cette limite.
``TOOLHOST_APP_URL`` pointe vers le core local (``http://127.0.0.1:8001``, posé par
``./elpis`` sauf valeur déjà dans l'environnement) : sans URL du core, les rappels
``/api/internal/*`` sont inactifs (``shell_job`` répond ``not_available_here``,
identifiants git, PR, quota et notifications sont ignorés). Une requête MCP qu'aucune
famille native ne prend répond 503 (``/sse`` n'est servi que si ``sse`` figure dans
``bind.transports``). ``mcp_upstream`` et ``mcp_upstream_sse`` (ou
``TOOLHOST_MCP_UPSTREAM[_SSE]``), qui désignaient elpis-tools, sont ignorés avec un
avertissement : le service ``tools`` n'existe plus, ``./elpis service install`` et
``install_toolhost.sh`` retirent son unité. Le core ouvre une connexion MCP par
famille (``/mcp/<famille>``) vers une entrée ``toolhost`` à plusieurs familles et
fusionne leurs outils dans l'ordre canonique ; une famille coupée est rouverte seule,
une famille injoignable est retirée sans priver les autres et relistée 15 s plus tard.
L'ancien hôte Python (``python -m toolhost``) n'existe plus depuis la 0.1.0 :
``ELPIS_TOOLHOST=python`` dans ``.env`` est ignoré (``./elpis doctor`` le signale).
**Construction** : ``npm run build`` (core et hôte) ; node-pty, sans binaire Linux
précompilé, est compilé par ``npm ci`` (build-essential, python3 : groupe apt
``construction-hote``) ; le paquet hors ligne de ``make_release.sh`` contient le
bundle de l'hôte pour son architecture (``toolhost/``). ``./elpis doctor`` vérifie
le bundle (``main.mjs --empreinte``, ``--natif``) et l'import du moteur Office.

**Plusieurs hôtes d'outils.** ``mcp.json › sandboxHosts`` peut
déclarer N hôtes ; ``placement.strategy`` = ``single`` (tout le monde sur
``placement.host``) ou ``by_user`` (table ``sandbox_placements`` : un compte est
affecté à sa première utilisation à l'hôte le moins chargé, puis y reste —
sandbox, terminal et outils sur le même hôte). Console admin → Sandbox →
« Hôtes d'outils » : santé de chaque hôte (``/health``), comptes affectés,
réaffectation et MIGRATION d'un compte (``/api/sandbox/export`` de l'ancien
hôte → ``/api/sandbox/import`` sur le nouveau → réaffectation ; un instantané
du ``/work`` remplacé est pris d'abord, l'import est refusé s'il ne peut
l'être). Routes :
``GET /api/admin/toolhosts``, ``POST /api/admin/toolhosts/placements/{uid}``
(``{host_id}``), ``…/migrate``, ``DELETE …``. Ajouter un hôte = une entrée
``sandboxHosts`` dans ``mcp.json`` + ``toolhost.json`` sur la machine.
Supprimer un compte avec son bac (``DELETE /api/admin/users/{id}?delete_sandbox=true``)
supprime aussi celui d'un hôte distant, par la route interne
``POST /api/internal/sandbox/delete`` de cet hôte (enveloppe signée, jamais relayée),
avant le dossier local ; un profil réseau imposé détruit le conteneur sur l'hôte du compte.
Toute suppression de compte appelle aussi ``POST /api/internal/account/purge`` sur
chaque hôte déclaré (même enveloppe signée) : les identifiants de sites de la mémoire AX
du compte sont retirés de la base de l'hôte. Un hôte injoignable ou sans jeton est
signalé dans ``hosts_purge_errors`` de la réponse et au journal : ses identifiants
restent alors à retirer avant de recréer un compte du même nom.


| Variable | Défaut | Description |
|---|---|---|
| `MCP_TOOLS_CACHE_TTL_SEC` | `360` | TTL du cache `list_tools` |
| `MCP_SERVERS_DIR` | `../mcp_custom_servers` | Serveurs uploadés |
| `LOCAL_MCP_URL` | dérivée (`http://127.0.0.1:8765/mcp`) | Adresse de l'hôte d'outils (`…/mcp` = HTTP streamable, `…/sse` = SSE) ; l'app ne le lance jamais en sous-process |
| `LOCAL_MCP_HOST` / `LOCAL_MCP_PORT` / `LOCAL_MCP_TRANSPORT` | `127.0.0.1` / `8765` / `sse` | Utilisés **par** le serveur en mode service (`./elpis start` : `streamable-http`) |

| `LOCAL_MCP_TOKEN` | — | Jeton de **service** de l'app (Bearer, **vérifié** côté serveur sur SSE/HTTP) ; `./elpis configure` le génère dans `user_db/.local_mcp_token` |
| `LOCAL_MCP_CLIENT_TOKENS` | — | Jetons de **clients externes** configurés à la main, chacun lié à un compte : `tok1:alice,tok2:bob` (toutes les familles) |
| `LOCAL_MCP_TOOL_FAMILIES` | `all` | Familles enregistrées : `fs,shell,git` ou `all,-desktop,-browser` |
| `MCP_TOOL_MAX_CONCURRENT` | `48` | Appels d'outils simultanés sur le service, tous comptes confondus (`0` = sans plafond) |
| `MCP_TOOL_MAX_CONCURRENT_PER_USER` | `12` | Appels simultanés d'un même compte (`0` = sans plafond) ; un appel sans identité ne compte que dans le total |
| `MCP_TOOL_QUEUE_WAIT_S` | `30` | Attente maximale d'une place ; au-delà (ou file pleine : deux fois le plafond total, et pas plus d'appels en attente par compte que son plafond) l'outil répond par une erreur lisible par le modèle. Courte exprès : un appel abandonné par l'app (Stop) mais encore en file s'exécuterait à sa place |
| `MCP_TOOL_THREADS` | `64` | Threads du service pour les outils synchrones et ses routes HTTP (défaut anyio : 40) ; garder 8 threads de plus que `MCP_TOOL_MAX_CONCURRENT` |
| `LOCAL_MCP_LIST_PAGE_SIZE` | `100` | Outils par page de `tools/list` (pagination par `cursor`) |
| `LOCAL_MCP_ALLOWED_ORIGINS` | *(vide)* | Origines de navigateur autorisées en plus de `mcp.allowed_origins` et `app.cors_origins` (séparées par des virgules, `scheme://hôte:*` accepté) |
| `LOCAL_MCP_OPENCODE_FAMILIES` | `git,browser,desktop` | Familles **publiées** à opencode, une **entrée MCP (= une bascule) par famille** → `…/mcp/<famille>`. Liste d'inclusion : une famille ajoutée plus tard doit être nommée pour apparaître |
| `LOCAL_MCP_OPENCODE_EXCLUDE_FAMILIES` | `fs,shell,office,skill_run` | Familles **toujours refusées** aux clients opencode (jeton elpis-remote `pcr_…`, accepté en Bearer) — opencode a ses propres outils fichiers/shell ; ces familles agissent sur la sandbox de l'hôte |
| `LOCAL_MCP_PUBLIC_URL` | — | URL du service telle que les postes la joignent (bloc `mcp` d'`opencode.json`) ; vide → hôte de l'app + `LOCAL_MCP_PORT` |
| `TOOL_TEXT_BUDGET` / `TOOL_LIST_BUDGET` | `6000` / `50` | Budgets de sortie des outils (caractères d'un texte / éléments d'une liste paginée) |

> **Auth MCP.** Dès qu'un jeton est configuré, le service partagé
> exige `Authorization: Bearer …` (FastMCP `StaticTokenVerifier`). Le jeton de
> service laisse le `meta` (username/chat_id) faire autorité ; un jeton client
> impose l'identité du compte qui lui est lié. **Sans aucun jeton, le serveur
> refuse de se lier hors loopback.** Clients externes (opencode : `type: "remote"`,
> URL `…/mcp`, en-tête Bearer).

#### Services satellites

| Variable | Défaut | Description |
|---|---|---|
| `PLAYWRIGHT_API_URL` | `http://localhost:3000` | Service navigateur (côté app) |
| `FIREFOX_SERVICE_PORT` | `3000` | Port d'écoute du service navigateur |
| `PW_STATE_MAX_AGE_D` | `30` | Jours de conservation d'un état sauvegardé du navigateur (`save_state`) après son enregistrement ou son rattachement, même s'il sert ; `0` = jamais supprimé. Lu au démarrage du service navigateur (`.env`). Les états d'avant la 0.0.1, sans compte, ne sont jamais purgés : voir [exploitation.md](exploitation.md#mettre-à-jour) |
| `PW_ARTIFACT_MAX_AGE_H` | `24` | Heures de conservation des téléchargements, HAR, vidéos et traces du navigateur ; `0` = jamais supprimés |
| `PLAYWRIGHT_HEADLESS` / `PLAYWRIGHT_TIMEOUT` / `PLAYWRIGHT_VISION` | `true` / `10` (s) / `false` | Options Playwright |
| `APP_VISION_ENDPOINT_URL` / `APP_VISION_FORMAT` / `APP_VISION_MODEL` | — / `omniparser` / — | Endpoint d'annotation visuelle |
| `APP_VISION_PASSES` / `APP_VISION_TIMEOUT_SEC` / `APP_VISION_PROMPT` | `2` (1-3) / `30` (5-300) / — | Passes, timeout, prompt d'annotation |
| `APP_DESKTOP_*` | voir `config.py` | Agents de contrôle : timeouts, scope d'observation, format de capture, plafonds |
| `DESKTOP_AGENT_TOKEN` | — | Jeton envoyé aux agents de bureau (`Authorization: Bearer`) quand la machine n'a pas son propre `agent_token` (`desktop.targets[].agent_token`, Console › Connexions › Machines, rechargé à chaud). Côté machine pilotée : `DESKTOP_AGENT_TOKEN` ou `agent_token.txt`, généré par l'installation de l'agent ; sans jeton ni fichier, l'agent génère `agent_token.txt` au démarrage et écrit le jeton dans son journal ; `DESKTOP_AGENT_INSECURE=1` le fait démarrer sans jeton. Le jeton est visible des administrateurs dans la console (champ masqué à la saisie seulement) |
| `OPENCODE_DIST_DIR` | `cli_dist/` | Binaires OpenCode servis sur le LAN |

#### Résilience et verrous

| Variable | Défaut | Description |
|---|---|---|
| `LLM_BREAKER` | `1` | Disjoncteur LLM (`0` = désactivé) |
| `LLM_BREAKER_FAILS` | `5` | Échecs transport consécutifs avant ouverture |
| `LLM_BREAKER_COOLDOWN_S` | `15` | Durée du fail-fast |
| `SKILLS_FILELOCK` | `1` | Verrou de fichier entre processus (`elpis.verrou.v1.1`) des écritures skills |
| `ROUTINES_PER_USER_CAP` | `5` | Runs simultanés par utilisateur |
| `ROUTINES_RUN_MAX_ATTEMPTS` / `_RETRY_BACKOFF_S` | `2` / `3.0` | Reprise bornée d'un run |
| `PTY_MAX_PER_USER` | dérivé | Terminaux par utilisateur |

### Navigateur piloté : destinations autorisées

Le service navigateur (`browser-service/`, outils `pw_*`) ne joint que des
adresses `http` et `https` (plus `about:blank`). Tout son trafic — navigation,
redirections, sous-ressources, WebSocket — passe par un relais local qui
résout lui-même chaque nom et ne se connecte qu'à l'adresse qu'il a jugée.
Sont refusés : la boucle locale, le lien-local (dont les adresses de
métadonnées), les adresses propres à l'hôte Elpis et les réseaux de
conteneurs. Le réseau local est autorisé par défaut (intranet). Liste
blanche facultative, relue à chaud : `browser.url_allowlist` dans
`config.json` (ou `BROWSER_URL_ALLOWLIST`, séparée par des virgules ou des
espaces) — hôtes exacts, `*.domaine`, adresses IP ou blocs CIDR ; posée, elle
restreint le RÉSEAU LOCAL aux hôtes et réseaux qu'elle nomme (les
destinations publiques restent joignables, les refus ci-dessus restent
absolus). Les sessions, états sauvegardés,
téléchargements et références visuelles sont rangés par compte ; au plus 3
sessions par compte (`BROWSER_MAX_SESSIONS_PER_OWNER`) et 10 en tout, une
nouvelle session ne ferme jamais celle d'un autre compte.

⚠ **Mise à jour** : une automatisation qui naviguait vers `localhost`,
l'adresse de l'hôte ou un conteneur local est désormais refusée.

### Génération d'images

Un seul moteur, réglé dans Console › Modèles & services › Images
(`config.json › image`, relu à chaud) :

| Moteur | API | File et arrêt |
|---|---|---|
| `sdcpp` | `sd-server` de stable-diffusion.cpp, `/sdcpp/v1` (`capabilities`, `img_gen`, `jobs/{id}`) | file de sd-server, position affichée ; Stop annule un job en file, un job déjà lancé est abandonné et son résultat ignoré |
| `openai` | `POST /v1/images/generations` et `/v1/images/edits` (LocalAI, sd-server en dialecte OpenAI, gpt-image…) | `max_concurrent` générations à la fois, tous workers confondus (verrous fichier dans le répertoire d'exécution) |

- **Un modèle par processus** côté sd-server : changer de modèle, c'est
  changer d'adresse. « Tester » lit les limites annoncées (`capabilities`).
- **Tailles** : `free` = largeur × hauteur au multiple de 64, plus grand côté
  ≤ `max_side` ; `fixed` = liste fermée `sizes` (modèles OpenAI, défaut
  1024x1024, 1536x1024, 1024x1536). sd-server est toujours en `free`, et
  `max_concurrent` ne vaut que pour un service OpenAI.
- **TLS** : magasin de certificats du système, plus l'autorité collée dans
  `ca_pem` (PKI interne). `verify: false` ne sert qu'aux essais.
- **Clé API** : chiffrée (Fernet) dans `api_key_enc`, écrite par
  `PUT /api/admin/image/key`, jamais renvoyée. Elle est liée à l'adresse du
  moteur (schéma, hôte et port) : après un changement d'adresse vers une
  autre machine, ressaisissez-la (la console l'indique). Un test vers une
  autre adresse n'utilise que la clé saisie dans le formulaire.
- **Accès** : `enabled` et une adresse ; `groups` (ids, vide = tout le monde,
  administrateurs toujours autorisés) est vérifié à chaque tour et à chaque
  appel de l'outil `generate_image`. Chaque compte peut ensuite couper
  « Images » et « Images par le modèle » dans ses Paramètres.
- **Outil du modèle** : au plus `tool_max_calls` appels et `max_n` images par
  tour, refusé en mode plan.
- **Stockage** : `user_db/generated_images/<compte>/` (dossier de la base),
  chemins relatifs en base, vignettes WebP ; les `keep_per_user` images les
  plus récentes de chaque compte sont gardées (jamais moins que le lot qui
  vient d'être produit). Supprimer une conversation ou un compte supprime ses
  images ; les images d'une session éphémère sont gardées un jour. La
  maintenance quotidienne balaie les fichiers orphelins, les lignes dont le
  fichier a disparu, et applique la rétention à tous les comptes. Les images
  sont comprises dans `./elpis backup` (portées `full` et `db`), avec
  `user_db/` ou à part si la base est ailleurs.
- ⚠ **Plusieurs hôtes** sur une même base PostgreSQL : chaque fichier
  reste sur l'hôte qui l'a écrit.

### `context_config.json` — textes injectés au LLM

Objectif : **aucun texte destiné au modèle ne doit être un littéral Python
figé**. `shared_infra/context_config.json` centralise préfixes, en-têtes,
séparateurs, catalogue d'erreurs et budgets. Chargé une fois au boot.

Conventions :

```jsonc
"clé": ""                    // vide → l'appelant garde son fallback (comportement historique)
"clé": {"file": "x.md"}      // contenu lu au boot
"clé": {"inline": "..."}     // texte inline
"clé": "texte"               // texte direct
// clé absente               → fallback de l'appelant
```

Sections : `budgets`, `tools.<nom>.enabled` (kill-switch par outil),
`system_prompt`, `assembly`, `skills`, `memory`, `compression`, `context`,
`vision`, `result_formatting`, `model_profiles`, `errors` (surcharge
`message`/`fix` par code d'erreur d'outil).

> ⚠️ `tool_gating.gated` (masquage de catégories par mots-clés) est **inerte** :
> son unique appelant ne passe jamais `keywords_text`, parce qu'un jeu d'outils
> variant au fil des messages invaliderait le prefix-cache KV. La fonction est
> testée mais non branchée ; un avertissement est émis au boot si la map est non
> vide. Seul `tools.<nom>.enabled` est câblé.

### Priorité de résolution et hot-reload

1. Variable d'environnement (si définie et **non vide**)
2. Valeur dans `config.json`
3. Défaut codé dans `config.py`

Les chemins relatifs sont résolus depuis `PROJECT_ROOT`.

**Trois classes de réglages**, à ne pas confondre :

| Classe | Mécanisme | Exemples |
|---|---|---|
| **Figé à l'import** | Constante module-level de `config.py` | Budgets de sous-agents, timeouts LLM, limites de skills |
| **Relu à chaque appel** | Helper qui lit le fichier | `feature_enabled()`, `https_enabled()`, `https_ports()`, `session_cookie_attrs()`, `max_recent_chats()`, `live_config_value()` |
| **Hot-reload avec cache mtime** | `reload_*_from_disk()` | `COMPRESSION_*`/`PRUNE_*`, `VISION_*`/`DESKTOP_*`, `MEMORY_*` |

> ⚠️ **Piège multi-worker.** Muter une constante module-level depuis un endpoint
> admin ne change l'état que du worker qui a reçu le POST. Pour tout réglage
> modifiable depuis l'admin et lu en cours d'exécution, utiliser
> `live_config_value()` (source de vérité = le fichier) ou un
> `reload_*_from_disk()`.

[↑ Sommaire](#sommaire)

---

## Multi-process : séparation main / admin

| Aspect | main (8001) | admin (8002) |
|---|---|---|
| Routes montées | Tout sauf `/api/admin/*` et `/admin` | `/api/admin/*`, auth, system-events, public-config, changement de mot de passe, `/admin` |
| User Linux | non privilégié | non privilégié, jamais root |
| Surface HTTP | large | réduite |
| Schedulers | routines, maintenance, sauvegardes, sampler | sampler uniquement |
| Prewarm MCP | oui | non (première ouverture d'onglet paie ~500 ms) |
| Cookie | scopé HOST — valide sur les deux ports | idem |

Le core monte ses familles de routes selon `APP_MODE` (absent ou invalide :
`main`). L'isolation est faite **au montage** : en `APP_MODE=main`, les routes
d'administration n'entrent jamais dans la table de routage.

Les cookies étant scopés HOST (pas port), une session créée sur `:8001` vaut sur
`:8002` — à condition que les deux process partagent `APP_SESSION_SECRET`.

Le bouton « Admin » du front redirige vers `ADMIN_PUBLIC_URL` ; « Quitter
l'admin » vers `MAIN_PUBLIC_URL` (lus depuis `/api/public-config`, avec
réécriture automatique des `localhost` pour un client distant).

---

## Process du core

Le core TypeScript tourne en **un process par mode** (`apps/core/dist/main.mjs` :
`APP_MODE=main` sur 8001, `APP_MODE=admin` sur 8002), sans workers : les confs
Gunicorn et `uvicorn_worker.py` sont retirées avec le Python du core.
`SIGTERM`, `SIGINT` et `SIGHUP` déclenchent un arrêt gracieux (générations en
cours jusqu'à 300 s) ; après un `SIGHUP`, le process sort en 75 pour être
relancé par `./elpis` ou systemd. L'adresse d'écoute suit la règle d'[Écoute](#écoute-securitylisten)
(`BIND` prioritaire).

---

## HTTPS : frontal Caddy

Voir [`deploy/caddy/README.md`](../deploy/caddy/README.md) pour le détail.

```
navigateur ──https──▶ Caddy (même hôte, catch-all) ──http 127.0.0.1──▶ services
   :443  ────────────────────────────────────────▶ 127.0.0.1:8001  (main)
   :8443 ────────────────────────────────────────▶ 127.0.0.1:8002  (admin)
   :80   ─ redirige 302 vers https + sert /ca.crt
         └ EXCEPTION @bootstrap : installeurs servis EN CLAIR ─▶ :8001
```

Points de conception :

- **PKI openssl stable 10 ans**, pas `tls internal` de Caddy (qui fait tourner
  ses certs toutes les 12 h → l'avertissement navigateur reviendrait sans cesse).
- **Sites catch-all** : n'importe quelle IP/nom joignant la machine fonctionne.
  Main et admin partagent le hostname (ports différents) → le cookie host-scopé
  reste partagé.
- Caddy tourne **en permanence** ; la bascule HTTPS ↔ HTTP direct se fait depuis
  la console admin, qui écrit `security.https.enabled` puis redémarre le core
  (`SIGHUP`, relance par `./elpis` ou systemd), qui relit le flag au démarrage. Une **garde
  anti-lockout** sonde les ports avant de couper l'accès direct.
- `@bootstrap` : les routes d'installation restent en clair sur `:80` — la
  machine cible ne connaît pas encore la CA. Voir
  [Distribution CLI](architecture.md#distribution-cli--opencode-lan).

### `security.https` appartient au toggle, à personne d'autre

Le bind (`127.0.0.1` en mode HTTPS) est l'unique barrière : `security.https`,
`session.https_only` et `session.global_min_ts` appartiennent à leur endpoint,
et l'éditeur « Config principale » ne les réécrit jamais
(`apps/core/src/admin/config.ts › OWNED_PATHS`), sans quoi une copie
périmée du formulaire rouvrirait le bind public au redémarrage suivant.

À savoir :

- On **n'active pas** le HTTPS depuis l'éditeur brut — seul le toggle sonde
  Caddy avant d'écrire (garde anti-lockout).
- L'**extracteur du RAG (`:8000`)** n'a pas de site Caddy : il écoute sur
  `127.0.0.1` quel que soit le toggle (`RAG_HOST` pour un core sur une autre
  machine). Après une mise à jour, `sudo deploy/caddy/install_caddy.sh` retire
  l'ancien site `:8444`.

---

## Tracing et debug multi-utilisateur

Chaque requête LLM reçoit un identifiant tracé `[LLM_REQ xxxxxxxx]`.

| Événement | Format |
|---|---|
| Début (chat simple) | `[LLM_REQ a1b2c3d4] START user='alice' model='GLM-4.7' thinking=… msgs=12 prompt_chars=3421 …` |
| Début (appel outillé) | `[LLM_REQ a1b2c3d4] START_TOOLS user='alice' model='GLM-4.7' n_tools=15 msgs=12 prompt_chars=…` |
| Slot | `[LLM_REQ a1b2c3d4] SLOT=2 assigné (user='alice')` (si le serveur expose `id_slot`) |
| Fin (chat simple) | `[LLM_REQ a1b2c3d4] END user='alice' content_chars=… thinking_chars=… in_tok=1849 out_tok=425 resumes=0` |
| Fin (appel outillé) | `[LLM_REQ a1b2c3d4] END_TOOLS user='alice' n_tool_calls=2 content_chars=… in_tok=… out_tok=… finish=tool_calls` |
| Échec d'une tentative | `[LLM_REQ a1b2c3d4] attempt=1 failed: …` |
| Annulation | `[LLM_REQ a1b2c3d4] CANCEL mid-stream → fermeture stream` |

`stream_options.include_usage: true` est ajouté automatiquement aux requêtes
streaming — sans quoi `in_tok`/`out_tok` restent à 0.

```bash
./elpis logs main -f | grep a1b2c3d4         # une requête
./elpis logs main -f | grep "user='alice'"   # un utilisateur
```

**Trafic LLM.** Si `llm.debug.enabled` (défaut `true`), chaque échange
app ↔ moteur (requête + réponse, hors thinking) est journalisé dans la table
`llm_calls` (ring borné, payloads plafonnés) et consultable par l'API
d'administration (`GET /api/admin/llm-traffic`) ; la console n'a pas de vue
dédiée.

**Journaux en direct.** Console admin → 300 dernières entrées (ring buffer
serveur) puis flux SSE. `GET /api/admin/logs/recent` + `GET /api/system-events`.

[↑ Sommaire](#sommaire)

---
