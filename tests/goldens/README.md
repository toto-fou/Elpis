# Goldens : entrées et sorties figées

Chaque fichier de ce dossier fige le comportement d'un scénario : ses **entrées**
(clé `entrees`) et ce que le code produit à partir d'elles. Le code Python les
rejouait jusqu'au retrait du core Python (B1-36) ; le harnais `runs` a perdu le
sien avec le Python d'elpis-tools (lot audit OSS). Tous sont figés et
rejoués par le TypeScript, qui doit produire les mêmes sorties, octet pour octet après canonicalisation
(JSON trié, indenté de deux espaces, UTF-8).

## Goldens non rejoués en TS (décision du user, E23)

Le chat n'a plus qu'un chemin en TypeScript, la boucle agentique complète : le
chemin de chat « classique » (réponse sans outils, `_chat_classic.py`) n'est
pas porté. `llama_chat_stream_tokens` reste porté pour ses autres usages (titre
d'un chat neuf, appelé avant le choix du chemin). Les goldens qui passent par le
chemin classique étaient rejoués par Python jusqu'à B1-36 et **ne sont pas rejoués en TS** :

- `boucle_*`, `payload_*`, `events_*` dont `entrees.chemin` vaut `classique`
  (aujourd'hui `payload_classic`) ;
- `flux_route_*` dont le moteur est `classique` ou `panne` (ce dernier remplace
  aussi `llama_chat_stream_tokens`) : tous sauf les `flux_route_outils*`.

`migration-kit/goldens_check.mjs` les reconnaît à leurs entrées, les liste
(`chemin_classique_e23`) et les retire des comptes d'événements et de types figés.
Avec `--rejeux <rapport JSON de vitest>` (lancé par `npm run verifier`), il prouve
que chaque autre golden est cité par un test de rejeu TS passé (les contrôles de
forme de `packages/contracts` ne comptent pas). `payload_classic` y figure comme
« E23 rejoué quand même » : son tour n'est pas rejoué, mais son payload l'est par
`apps/core/test/llm/fournisseurs/llama.test.ts` (`llama_chat_stream_tokens`).
Les comportements de route qu'ils figent (titre, conflit, continuer, détaché,
reprenable, Stop en file, Stop, panne) sont refigés sur le moteur `outils` :
`flux_route_outils_*` (11), rejoués en B1-20b.

## Format commun

Tous les goldens de ce dossier ont ce format :

- `entrees` est une clé de premier niveau. Elle porte `harnais`, le pilote de
  rejeu : `ordonnanceur`, `boucle` (fichiers `boucle_*`, `payload_*`,
  `events_*`), `flux_route`, `runs` et `rattachement`, décrits ci-dessous.
- Un golden objet garde ses clés de sortie à côté de `entrees`. Un golden dont
  la sortie est une liste prend la forme `{"entrees": …, "sortie": […]}`.
- Les entrées sont la seule source : les rejeux les lisent dans le
  fichier, ils ne les redéclarent pas ;
  le contenu de `entrees` n'est jamais modifié (seulement re-sérialisé).
- Tout ce qui varie d'une exécution à l'autre (identifiants d'appel ou de chat,
  horodatages, durées) est fixé dans `entrees` ou retiré des sorties (règles
  de chaque harnais).
- Forme canonique : `json.dumps(obj, ensure_ascii=False, indent=2,
  sort_keys=True)` de Python, suivie d'un saut de ligne ; c'est aussi la forme
  hachée par les empreintes (sans ce saut de ligne final).
- Nombres : les entrées n'ont aucun flottant à partie décimale nulle (`100`,
  jamais `100.0` ; vérifié au rejeu). Les sorties gardent l'écriture de
  Python (`1.0` reste `1.0`) : le rejeu TS compare après normalisation des
  nombres.
- Erreurs : les sorties citent une erreur sous la forme `<Nom>: <message>`
  (champ `detail`), où `<Nom>` est le nom de la classe d'exception Python que
  chaque harnais précise. Écart voulu : l'événement `error` d'une panne du tour
  ne porte plus le message brut de l'exception (`detail` : « Le détail figure
  dans le journal du serveur. »), `flux_route_outils_panne` est refigé ainsi.
- Le vocabulaire des entrées est fermé : une clé ou une valeur hors
  vocabulaire est une erreur, pas une option ignorée.

## Harnais `ordonnanceur`

Neuf fichiers (`ordonnanceur_*.json`, v9 §7 bis) : l'admission des appels au
moteur par `llm_scheduling_guard` (exclusivité de modèle, créneaux, priorités,
mode optimized, disjoncteur, annulation, politique à chaud). Un fichier peut
porter plusieurs serveurs indépendants, chacun étant un scénario. Rejeu
Python (`tests/llm_core/ordonnanceur_harness.py`) retiré en B1-36 ; rejeu TS :
`apps/core/test/ordonnanceur/`.

Variante modélisée : un seul processus, verrou d'exclusivité local (sans
Redis), chemin outils de la boucle, serveurs llama.cpp dont `/props` ne répond
pas (la politique fait foi). Les temps sont des secondes logiques à partir de
0 ; le rejeu Python fait tourner l'ordonnanceur réel dans une boucle asyncio
dont l'horloge saute au prochain minuteur, sans sommeil réel.

### Règles figées

Tout est propre à chaque serveur : deux serveurs ne se gênent jamais.

**Niveau 1 : modèle actif.**

1. Un serveur a au plus un modèle actif ; le *groupe* est l'ensemble des
   demandes admises sur ce modèle. `max_models` vaut 1 dans le vocabulaire :
   le Python n'admet qu'un modèle actif par serveur, quelle que soit cette
   valeur.
2. Une demande pour le modèle actif rejoint le groupe aussitôt, `high` comme
   `low`, même si d'autres attendent un autre modèle ; elle reste soumise aux
   créneaux (niveau 2).
3. Une demande pour un autre modèle attend que le groupe soit vide. Une `high`
   qui attend ainsi est *inscrite* jusqu'à ce qu'elle passe.
4. Quand le groupe se vide, les demandes qui attendent sont reconsidérées dans
   leur ordre d'arrivée : la première qui passe prend le serveur pour son
   modèle, puis celles qui veulent ce modèle la rejoignent (règle 2).
5. **Grâce.** Si la dernière demande sortie du groupe est une `high`, son
   modèle est *en grâce* pendant 8 s. Une demande pour le modèle en grâce
   prend le serveur aussitôt (`high` ou `low`). La grâce tombe dès qu'une
   demande prend le serveur, quel que soit son modèle. Une `high` n'est jamais
   retenue par la grâce.
6. **Portail des `low`.** Une `low` qui veut un autre modèle que le modèle
   actif ou en grâce ne passe pas tant qu'une `high` est inscrite (règle 3) ou
   qu'une grâce court sur un autre modèle. Passée le portail, elle attend
   encore que le groupe soit vide (règle 3).
7. **Plafond du portail.** 30 s après le premier instant où le portail la
   retient, le portail est levé pour cette `low`, définitivement. L'attente
   d'un autre modèle (règle 3) ne compte pas dans ces 30 s.

**Niveau 2 : créneaux du modèle (`max_concurrency`).**

8. En `classic`, une demande prend un créneau à son admission et le tient
   jusqu'à sa fin : `admis` = niveau 1 franchi et créneau pris. En
   `optimized`, `admis` = niveau 1 franchi ; chaque étape `generer` prend un
   créneau pour sa durée (`creneau`, `rend`) ; le niveau 1 reste tenu pendant
   les outils.
9. File des créneaux : `high` avant `low`, ordre d'entrée dans chaque
   priorité, jamais de préemption.
10. **Plafond des créneaux.** À chaque créneau rendu, une `low` qui attend
    dans cette file depuis plus de 30 s (strictement) passe avant les `high`
    entrées dans la file après elle. Son attente compte depuis son entrée
    dans la file : son admission au niveau 1 en `classic`, le début de
    l'étape `generer` en `optimized`.
11. **Politique à chaud** (`{"a": t, "politique": …}`) : la nouvelle
    `max_concurrency` s'applique à l'instant `t`. Une hausse sert aussitôt les
    demandes en file, dans l'ordre de la règle 9 ; une baisse ne préempte
    rien : les créneaux en trop disparaissent à mesure qu'ils sont rendus.

**Disjoncteur**, propre à chaque couple (serveur, modèle) :

12. Après 5 échecs de transport consécutifs, il s'ouvre pour 15 s : une
    demande qui *arrive* pendant ce temps est refusée aussitôt
    (`refus_disjoncteur`) ; une demande déjà en file ne l'est pas.
13. Ensuite (demi-ouvert), toutes les demandes passent ; un échec le rouvre
    aussitôt pour 15 s ; un succès le referme et remet le compte à zéro, sauf
    si un échec a été noté pendant ce tour.

**Annulation** (`{"a": t, "annuler": id}`) :

14. Elle n'agit que pendant l'attente (avant `admis`) ; sinon elle est sans
    effet. L'attente est sondée toutes les 0,25 s : l'abandon est constaté au
    premier multiple de 0,25 qui suit `a`.

### Règles de construction (vérifiées par le rejeu)

- Grille de 0,25 s : arrivées, durées d'étapes, instants de politique et
  instantanés en sont des multiples ; `annuler` n'en est jamais un, et
  tombe après l'arrivée de la demande visée. Une demande admise entre `a` et
  le multiple suivant rendrait l'annulation ambiguë : refusé.
- Une arrivée ou une politique ne tombe jamais au même instant qu'une
  libération (`fin`, `rend`, `abandon`, `echec_transport`,
  `refus_disjoncteur`) sur le même serveur.
- Arrivées simultanées : dans l'ordre de la liste `demandes` ; à un même
  instant, les actions (dans leur ordre) passent avant les arrivées.
- Chaque instantané est à au moins 1 s de toute transition, arrivée ou
  action : une implémentation événementielle, sans sondage, doit donner
  exactement les mêmes.

### Entrées

| Clé | Contenu |
|---|---|
| `serveurs` | `{nom: {"max_models": 1, "max_concurrency": n}}`, les deux clés requises |
| `mode` | `classic` (défaut) ou `optimized` (règle 8) |
| `demandes` | liste ordonnée, identifiants uniques (chaînes non vides) |
| `actions` | `{"a": t, "annuler": id}` (règle 14) ou `{"a": t, "politique": {serveur: {"max_concurrency": n}}}` (règle 11) ; défaut `[]` |
| `instantanes` | instants croissants où l'état est relevé ; défaut `[]` |

Une demande : `{"id", "arrivee", "serveur", "modele", "priorite", "etapes"}`,
`modele` chaîne non vide, `priorite` `high` (défaut) ou `low`. Étapes,
exécutées une fois la demande admise :

| Étape | Sens |
|---|---|
| `{"generer": s}` | un appel au moteur de `s` secondes (`s` > 0) |
| `{"outil": s}` | un outil de `s` secondes, sans appel au moteur |
| `{"echec_transport": true}` | dernière étape seulement : l'appel au moteur échoue au transport, immédiatement (en `optimized`, sans prendre de créneau) ; la demande se termine en erreur et le disjoncteur compte un échec |

### Sorties

- `ordre` : `"t=<instant> <id> <événement>"`, trié par instant, puis par rang de
  la demande dans `demandes`, puis dans l'ordre propre à la demande.
  L'instant est écrit comme `String(t)` en JS : entier sans décimale (`10`),
  sinon l'écriture décimale la plus courte (`3.25`). Événements : `admis`,
  `creneau` et `rend` (`optimized` seulement), `fin`, `abandon`,
  `refus_disjoncteur`, `echec_transport`.
- `instantanes` : pour chaque instant (clé `t=<instant>`), l'état déduit de
  `ordre` : les demandes arrivées réparties en `en_attente`, `en_cours`,
  `terminees` (dans l'ordre de `demandes`), plus `en_generation` (créneau
  tenu, `optimized` seulement) quand il n'est pas vide.
- Le fichier ne contient rien d'autre que `entrees`, `ordre` et `instantanes`.

## Harnais `boucle`

Un tour de la boucle outillée (`run_chat_multi_mcp`), ou, chemin `classique`
(non rejoué en TS, E23), une génération sans outils (`llama_chat_stream_tokens`), joué contre un faux
moteur qui sert des flux SSE scriptés. Fichiers `boucle_*` (tour complet),
`payload_*` (payloads envoyés) et `events_*` (suite des types d'événements).
Rejeu Python (`tests/llm_core/boucle_harness.py`) retiré en B1-36.

### Entrées

| Clé | Contenu |
|---|---|
| `chemin` | `outils` (défaut) ou `classique` (seules clés admises alors : `messages`, `appels`, `releve` = `payloads`) |
| `messages` | messages OpenAI du tour, littéraux, ou générateur `tours_shell` (ci-dessous) |
| `appels` | pour chaque requête HTTP au moteur (boucle, compaction, synthèse), dans l'ordre, ses lignes SSE ; au-delà de la liste, la dernière est resservie |
| `pannes` | `{"appel": i \| "tous", <effet>}` ; défaut `[]` |
| `outils` | liste ordonnée des outils du tour (l'ordre d'enregistrement compte) |
| `options` | réglages du tour (ci-dessous) ; défaut `{}` |
| `releve` | `tour`, `payloads` ou `types` (sorties) |

**Lignes SSE.** Chaque chaîne d'un élément de `appels` est une ligne du flux,
servie telle quelle et dans l'ordre à la lecture ligne à ligne de la réponse.
Il n'y a pas de ligne vide entre deux `data:` : chaque ligne `data:` est un
événement complet (un lecteur SSE qui attend la ligne vide les fusionnerait).

**Pannes.** `appel` compte, à partir de 0, les appels de la boucle à sa
fonction de flux : chaque itération, chaque reprise (raisonnement ou rédaction
coupée) et le tour de synthèse, y compris ceux qui passent. Le résumé d'une
compaction n'en fait pas partie : il ne prend pas d'indice de panne, mais
consomme un élément de `appels`. Un appel en panne ne part pas et ne consomme
aucun élément de `appels`. Quand plusieurs pannes visent le même appel, la
première de la liste s'applique. Effets :

- `reponse` : cet objet est rendu à la place du flux, sous la forme agrégée
  d'une réponse `chat.completion` (par exemple `{"choices": []}`) ;
- `connexion` : erreur `ConnectError` (httpx) de ce message ;
- `http` `{"statut", "corps"}` : erreur `HTTPStatusError` (httpx) de message
  `HTTP <statut>`, pour la requête `POST
  http://moteur.invalid/v1/chat/completions`, dont la réponse a ce statut et ce
  corps texte.

`appels_interceptes` relève, pour chaque appel en panne, les `messages`, les
`tools` (liste vide si aucun) et le `tool_choice` que la boucle a transmis.

**Outils.** `{"definition", "comportement", "duree_s"?, "barriere"?,
"message"?}`. Comportements, résultat sérialisé comme `json.dumps` de Python
(séparateurs `", "` et `": "`, non-ASCII gardé) : `echo` →
`{"ok": true, "echo": <arguments>}` ; `somme` → `{"ok": true, "sum": a + b}`
(argument absent, nul ou faux : 0) ; `ok` → `{"ok": true}` ; `marque` →
`{"ok": true, "marque": <x>}` ; `echec` → l'outil lève une `RuntimeError` de
texte `message` (requis pour `echec`, interdit ailleurs). `duree_s` : attente
réelle avant de répondre. `barriere` : un groupe réunit les outils déclarés avec
le même nom de barrière ; chacun ne répond qu'une fois tous les outils du groupe
lancés (ils tournent donc en parallèle ; groupe incomplet : échec après 5 s).

**Options.**

| Option | Effet |
|---|---|
| `reflexion` | `true` : mode réflexion du tour |
| `contexte` | entier positif : fenêtre du modèle de `n` jetons ; ratio caractères/jeton gelé à sa valeur d'amorce (3,3), jamais mis à jour par les usages du flux |
| `compression_du_tour` | `false` (seule valeur) : compaction désactivée pour ce tour |
| `compression` | réglages de compression figés, surcharges possibles : `COMPRESSION_ENABLED` true, `COMPRESSION_KEEP_RECENT` 2, `COMPRESSION_KEEP_BRIDGE` 1, `COMPRESSION_MAX_PER_CHAT` 5, `COMPACTION_BUFFER_TOKENS` 0, `COMPACTION_PARTIAL_TARGET_RATIO` 0,6 ; modèle et point d'accès externes vides ; pas d'indexation plein texte |
| `comptage_factice` | `true`, avec `compression` : jetons comptés par le compresseur = somme des longueurs des contenus texte // 3, au moins 1 |
| `reglages` | `{"LLAMA_TOOL_LOOP_MAX_S": s}` : mur d'horloge de la boucle |
| `categories` | `{outil: catégorie}` ; les autres outils sont `other` |

**Générateur `tours_shell`.** `{"generer": "tours_shell", "premier": p,
"nombre": n, "taille": c}` vaut, pour chaque `i` de `p` à `p + n - 1`, deux
messages : `{"role": "assistant", "content": null, "tool_calls": [{"id": "c<i>",
"type": "function", "function": {"name": "execute_shell", "arguments":
"{\"command\": \"./step_<i>.sh\"}"}}]}` puis `{"role": "tool",
"tool_call_id": "c<i>", "content": bloc(c, "shell<i>")}`. `bloc(c, l)` fait
exactement `c` caractères : `"<<HEAD l>>\n"`, puis la ligne
`"l sortie ligne deterministe " + 60 × "x" + "\n"` répétée et tronquée, puis
`"\n<<TAIL l exit=0>>"`.

**Environnement figé** (deux chemins) : fenêtre du modèle 0 (inconnue) sauf
`contexte` ; `/tokenize` indisponible partout (comptages exacts absents,
estimation) ; échantillonnage du modèle
`{}` ; slot `-1` ; pas de vision ; pas de sonde de disponibilité ; métriques
d'outils non enregistrées ; `secrets.token_hex(n)` rend 1, 2, 3… en
hexadécimal sur `2n` caractères complétés de zéros ; attentes
(`asyncio.sleep`) instantanées ; mémoires de processus vierges (ratio mesuré,
support de `continue_final_message`) ; appel avec l'utilisateur `golden`, le
chat `golden-chat`, le modèle `golden-model`, mémoire désactivée, aucun serveur
MCP. Chemin `classique` : appel avec les seuls `messages`, modèle par défaut
`local-model`.

### Sorties

- `tour` : `final` ; `evenements` et `metrics` sans les champs volatils, à toute
  profondeur (`duration`, `duration_ms`, `elapsed_ms`, `elapsed_s`, `time_ms`,
  `read_tps`, `write_tps`, `ts`, `timestamp`, `wait_ms`) ; `payloads`, les
  corps envoyés au moteur ; avec des pannes, `appels_interceptes` : pour chaque
  appel en panne, `{"messages", "tools", "tool_choice"}` transmis par la boucle.
  Une liste (`payloads` ou `appels_interceptes`) dont la forme canonique
  dépasse 60 000 caractères est remplacée, élément par élément, par
  `{"cles" (triées), "max_tokens", "outils" (noms), "messages": [{"role",
  "taille", "empreinte"}], "empreinte"}` : empreinte = 16 premiers caractères
  hexadécimaux du SHA-256 des octets UTF-8 de la forme canonique ; `taille` =
  nombre de caractères (points de code) de la forme canonique du contenu.
- `payloads` : `{"sortie": [corps envoyés au moteur]}`.
- `types` : `{"sortie": [types des événements émis, dans l'ordre]}`.

## Harnais `flux_route`

Un tour de `POST /api/chat-saved-stream3` de bout en bout, pour le compte 1
(`alice`) d'une base neuve. Rejeu Python (`tests/chatbot/flux_route_harness.py`) retiré en B1-36 ; rejeu TS :
`apps/core/test/tour/goldens-flux-route.test.ts`.
Environnement figé : mode d'ordonnancement `classic`, `/tokenize`
indisponible (estimation), contrôle des URL de serveurs personnels désactivé.

### Entrées

| Clé | Contenu |
|---|---|
| `base` | chats du compte avant le tour : `{"chat_id", "titre", "messages", "horodatage"}` |
| `reglages_compte` | réglages du compte (`enable_mcp`, `mcp_servers`) ; facultatif |
| `requete` | corps de la requête : `messages`, `chat_id`, `use_rag`, `active_mcp_servers`, `resumable`, `is_continue` |
| `moteur` | faux moteur (ci-dessous) |
| `pendant` | ce qui se passe au milieu de la réponse (ci-dessous) ; facultatif, moteur `classique`, ou `outils` dont un événement est un `content_token` ; `abandon_file`, `stop_en_file` et `pendant` s'excluent |
| `file` | état de file rapporté par `queue_status` |
| `abandon_file` | `true` : l'ordonnanceur rapporte une attente de 0,25 s puis abandonne la file, sans drapeau d'annulation |
| `stop_en_file` | l'ordonnanceur rapporte une attente de 0,25 s puis attend, en sondant le drapeau d'annulation, et abandonne la file dès qu'il est posé. Dès que le client a reçu ce `queue_status` (celui qui porte `waited_ms`) : `ce_worker`, `/api/chat/cancel` réel (drapeau puis annulation de la tâche ; l'arrêt du flux du moteur est neutralisé) ; `autre_worker`, le drapeau seul (Stop reçu par un autre worker) |
| `n_ctx` | entier positif : fenêtre du modèle |
| `releve_base_au_final` | `true` : relève la base quand le `final` arrive (`base_au_final`) ; pas avec `stop` ni `deconnexion` |

Sans `abandon_file` ni `stop_en_file`, l'ordonnanceur rapporte l'attente puis
admet. Avec `stop_en_file`, le moteur n'est jamais appelé.

Moteurs (`classique` et `panne` passent par le chemin classique : non rejoués en
TS, E23) :

- `classique` `{"raisonnement", "reponse", "usage", "titre"}` : le raisonnement
  en un jeton (si la route demande les jetons de raisonnement), la première
  moitié de la réponse (`len // 2` caractères), le moment `pendant`, la seconde
  moitié ; rend le raisonnement, la réponse et `{"finish_reason": "stop",
  "usage"}`. Un appel de titre (utilisateur `title`) rend seulement `titre`,
  avec `{"finish_reason": "stop"}`, sans jeton ni moment `pendant`.
- `panne` `{"jeton", "message"}` : émet `jeton`, puis lève une `RuntimeError`
  de texte `message`.
- `outils` `{"evenements", "final", "metrics", "titre", "panne"}` : la boucle
  émet `evenements` (chacun avec un `type`), le moment `pendant` venant juste
  après le premier `content_token`, puis rend `final` et `metrics`, ou bien,
  avec `panne` (exclusif de `final` et `metrics`), lève une `RuntimeError` de
  ce texte. Un appel de titre (utilisateur `title`) rend `titre` avec
  `{"finish_reason": "stop"}` ; sans `titre`, ou pour tout autre appel hors
  boucle, il lève une `RuntimeError` (le titre retombe alors sur le début de la
  question). Les fichiers `flux_route_outils_*` rejouent ainsi les scénarios du
  moteur `classique` (titre, conflit, continuer, détaché, reprenable, Stop en
  file, Stop pendant la génération, panne), raisonnement compris, sur le chemin
  outillé, le seul que porte le TypeScript (E23). Un run est détaché à la
  déconnexion s'il est reprenable ou si un outil a déjà tourné :
  `flux_route_outils_detache` (reprenable) émet son premier `content_token`
  avant les outils, `flux_route_outils_detache_outil` (non reprenable) après.

Moments `pendant` : `releve_base` (sortie `base_pendant_generation`) ;
`{"ecriture_concurrente": {"chat_id", "titre", "messages", "decalage_s"}}` (un
autre onglet réécrit le chat, horodaté maintenant + `decalage_s`) ; `stop` (dès
que le client a reçu un `content_token` : drapeau d'annulation puis annulation
de la tâche ; le moteur ne reprend jamais) ; `deconnexion` (dès que le client a
reçu un `content_token`, il ferme le flux ; le moteur reprend ensuite et le run
continue détaché).

### Sorties

- `evenements` (`evenements_avant_depart` pour `deconnexion` : ce que le client
  a reçu avant de partir), normalisés : sans `ping` ; jetons consécutifs d'un
  même type (`content_token`, `thinking_token`) fusionnés et réduits à
  `{"type", "text"}` ; `final` réduit à `type`, `cles` (triées), les valeurs
  présentes parmi `assistant`, `chat_id`, `thinking`, `title`, `truncated`,
  `truncated_in_think`, `tool_limit_reached`, `cancelled`, `persisted`,
  `persist_error`, `plan_mode_done`, et toujours `run_ids` (leur nombre, 0 si
  absent) et `metrics` (ses clés triées, `null` si absent) ; les autres
  événements sans `n` ni `ts`. Une panne du moteur y paraît comme
  `RuntimeError: <message>`.
- `base_apres`, `base_au_final`, `base_pendant_generation` : messages du chat
  en base, chacun réduit à `cles` (triées) et aux valeurs présentes parmi
  `role`, `content`, `thinking`, `isTruncated`, `toolLoopTruncated`,
  `cancelled` ; `null` si le chat n'existe pas.

## Harnais `runs`

L'état en base des exécutions, opération par opération, sous horloge logique :
`runs_routine_*` pour la table `editor_routine_runs` (exécutions de routines,
`shared_infra/scheduling/routines_store.py`), `runs_execution_*` pour la table
`runs` (exécutions observées, `shared_infra/observability/runs.py`). Base
neuve, comptes 1 (`alice`) et 2 (`bob`). Rejeu Python
(`tests/deploy/runs_harness.py`) retiré avec le Python d'elpis-tools ; rejeu TS :
`apps/core/test/routines/goldens-runs.test.ts`, `apps/core/test/executions/goldens-runs.test.ts`. L'horloge vaut `T0` = 1 700 000 000 (secondes
depuis l'époque) + l'instant `a` de l'opération en cours.

### Entrées

| Clé | Contenu |
|---|---|
| `table` | `routine` ou `execution` |
| `routines` | table `routine` : `{"cle", "compte", "runs_keep"?}` (`runs_keep` : entier, défaut 0 = tout garder, borné à 500), créées dans l'ordre, identifiants 1, 2, 3… |
| `operations` | `{"a": t, <opération>: {…}}`, `t` croissant |

Table `routine`. Les runs sont désignés par leur identifiant en base : 1, 2,
3… dans l'ordre de création, jamais réutilisés. Bornes de fraîcheur
inclusives : un battement vieux d'exactement `s` secondes est encore frais.

| Opération | Effet, valeur rendue |
|---|---|
| `admettre` `{"routine", "declencheur", "plafond", "boot", "chevauchement_s"?}` | admission atomique : refus (`null`) si le compte a déjà `plafond` runs `running`, ou, avec `chevauchement_s`, si la routine a un run `running` au battement vieux d'au plus `chevauchement_s` ; sinon nouveau run `running` (départ et battement à `t`), son identifiant |
| `ignorer` `{"routine", "declencheur", "raison"}` | run `skipped` terminé à `t`, durée 0, son identifiant ; `runs_keep` appliqué |
| `battement` `{"run"}` | battement à `t` si le run est `running` ; vrai si fait, faux sinon |
| `terminer` `{"run", "statut", …}` | `ok`, `error`, `skipped` ou `cancelled`, seulement depuis `running` (sinon rien, faux) ; fin à `t` ; puis `runs_keep` ; vrai |
| `reconcilier` `{"perime_s"}` | runs `running` sans battement ou au battement vieux de plus de `perime_s` → `orphaned`, fin à `t`, durée = (dernier battement, sinon départ) − départ, en ms arrondies, `error` = `reconciled: heartbeat périmé (processus arrêté ?)` ; nombre de runs |
| `purger` `{"jours"}` | suppression des runs non `running` partis il y a plus de `jours` × 86 400 s ; nombre |
| `compter` `{"routine", "frais_s"?}` | runs `running` de la routine (avec `frais_s` : au battement vieux d'au plus `frais_s`) |

Correspondance avec les colonnes : `declencheur` → `trigger`, `boot` →
`worker_boot_id`, `duree_ms` → `duration_ms`, `jetons_entree` →
`input_tokens`, `jetons_sortie` → `output_tokens`, `resume` → `summary`
(4 000 caractères au plus), `fichiers` → `files`, `plafond_outils` →
`tool_limit_reached` (0 ou 1), `erreur` (1 000 caractères) et `raison`
(500 caractères) → `error`. Champs admis par statut, absents valant 0, `""`
ou `[]` : `ok` (`duree_ms`, `jetons_entree`, `jetons_sortie`, `resume`,
`fichiers`, `plafond_outils`), `error` (les mêmes sans `plafond_outils`, plus
`erreur`) ; `skipped` (`duree_ms`, `raison`) et `cancelled` (`duree_ms`)
laissent les autres colonnes telles qu'à l'admission (`null`, `files` = `[]`,
`tool_limit_reached` = 0). `fichiers` : chaînes seulement, sans
espaces de bord, tronquées à 400 caractères, sans doublon, 40 au plus, dans
l'ordre.

`runs_keep` = `k` > 0 : après chaque transition terminale (y compris
`ignorer`), seuls les `k` runs terminés les plus récents de la routine (départ
décroissant, puis identifiant décroissant) restent ; un run `running` n'est ni
compté ni supprimé.

Table `execution`. Les exécutions sont désignées par leur `cle`, qui est aussi
leur identifiant en base ; une opération ne vise qu'une exécution ouverte.

| Opération | Effet |
|---|---|
| `ouvrir` `{"cle", "type", "compte"?, "chat"?, "routine"?, "parent"? ou "dans"?, "modele"?, "moteur"?}` | exécution `running` partie à `t`, ligne écrite. `type` parmi `chat`, `routine`, `subagent`, `compaction`, `image`. `parent` : identifiant parent donné ; `dans` : ouverte à l'intérieur de cette exécution ouverte, dont elle hérite le parent ; ni l'un ni l'autre : pas de parent |
| `usage` `{"cle", "source", "statut", "entree"?, "sortie"?, "cache_lu"?, "cache_cree"?, "reflexion"?, "outils"?, "type_erreur"?}` | jetons cumulés ; si `source` est celle du genre (`chat` : chat ; `routine` : routine ou webhook ; `subagent` : subagent ; `compaction` : compression ; `image` : aucune), le statut de ce tour devient l'issue par défaut, et un `type_erreur` non vide remplace le précédent (jamais remis à vide) |
| `appel_llm` `{"cle", "prompt_ms"?, "predicted_ms"?}` | un appel de plus, temps cumulés (`prefill_ms`, `decode_ms`) |
| `attente` `{"cle", "ms"}`, `outil` `{"cle", "categorie", "statut"}`, `fichiers` `{"cle", "chemins"}` | attente cumulée ; appel d'outil compté par catégorie (erreur si `statut` ≠ `success`) ; chemins distincts comptés |
| `issue` `{"cle", "statut", "type_erreur"?}` | issue posée si aucune ne l'est encore (la première l'emporte), fin à `t` |
| `fermer` `{"cle", "par"}` | sortie de la portée : `normale` (issue : celle posée, sinon le statut du dernier tour de la source, sinon `ok`), `annulation` (`cancelled`), `delai` (`timeout`), `erreur` (`error`), puis ligne finale écrite ; valeur rendue : nom de l'exception (`CancelledError`, `TimeoutError`, `RuntimeError`) ou `null` |
| `perdre` `{"age_max_s"}` | exécutions `running` parties il y a plus de `age_max_s` → `lost`, fin à `t` ; nombre (une exécution encore ouverte écrase `lost` par son issue à sa fermeture) |
| `purger` `{"jours"}` | suppression des exécutions parties il y a plus de `jours` × 86 400 s ; nombre |

La ligne n'est écrite qu'à `ouvrir` et `fermer` (le Python l'écrit depuis un
thread, dans l'ordre : une écriture plus ancienne ne remplace jamais une plus
récente ; le rejeu l'écrit sur place). `thinking_tokens` est plafonné à
`output_tokens` quand celui-ci est non nul ; `tool_tokens` est plafonné à
`input_tokens`. Pas d'échantillonnage de la sandbox.

### Sorties

`etapes` : pour chaque opération, `{"a", "op", "rendu", "table"}` ; `rendu` vaut
`null` pour les opérations qui ne rendent rien. `table` est la table entière
après l'opération (`routine` : par identifiant ; `execution` : par départ puis
identifiant), colonnes de la base. Instants (`started_at`, `ended_at`,
`heartbeat_at`) relatifs à `T0`, au millième, entiers quand ils le sont ;
`files` et `tool_families` décodés du JSON ; `routine_id` remplacé par la `cle`
de la routine (table `routine`).

## Harnais `rattachement`

`GET /api/chat/{id}/run/events` : un client se rattache au run d'un chat
(journal `shared_infra/runtime/run_journal.py`, verrou de génération
`chat_locks`), pour le compte 1, sous horloge logique. Rejeu Python
(`tests/chatbot/rattachement_harness.py`) retiré en B1-36 ; rejeu TS :
`apps/core/test/tour/goldens-rattachement.test.ts`.

### Entrées

`chat_id`, `plafond_octets` facultatif (taille maximale du journal, défaut
64 Mo) et `chronologie`, liste d'opérations `{"a": t, <opération>}`, `t`
croissant entre 0 et 15 :

| Opération | Effet |
|---|---|
| `ouvrir` `{"run_id", "debut"}` | ouvre le journal du run (une fois) ; `run_id` : 1 à 32 caractères alphanumériques ; première ligne : `debut`, complété de `type` = `run_started` et du `run_id` (qui l'emportent) |
| `evenement` `{…}` | événement écrit au journal |
| `fermer` `"<statut>"` | `run_end` `{"status"}` puis marque de fin |
| `marquer_fin` `true` | marque de fin SANS `run_end` (le dernier écrit du worker n'a pas abouti) |
| `effacer` `true` | le fichier du journal disparaît |
| `verrou` `"pris"` / `"rendu"` | le verrou de génération du chat est tenu / rendu, en alternance |
| `connexion` `{"run_id"?, "from"?}` | le client se connecte (une seule fois) ; `from` : premier numéro de ligne à transmettre, rejeu et direct |

Journal : chaque instant de la chronologie forme un lot, écrit à la fin de cet
instant. Dans un lot, les jetons consécutifs d'un même type (`content_token`,
`thinking_token`, et les `tool_call_delta` d'un même appel) sont fusionnés :
textes concaténés, `n` = nombre de jetons (somme des `n` déjà portés), absent
d'un jeton seul. Chaque ligne est numérotée (`_s`) à partir de 1
(`run_started`). Au-delà de `plafond_octets`, les jetons et événements de
progression ne sont plus écrits ; une ligne `journal_truncated` le signale,
une fois ; les autres événements le sont encore.

### Sorties

- `refus` `{"statut", "detail"}` : aucun run, ou `run_id` demandé autre que le
  run courant (404, `run_not_found`) ;
- sinon `flux` : les lignes reçues, dans l'ordre. Le rejeu (lignes du journal
  à partir de `from`, chacune avec son `_s`), puis `replay_done`, puis la
  suite en direct. Fin : `run_end` du journal ; `{"type": "run_end",
  "status": "unknown"}` si la marque de fin est posée sans lui ;
  `run_lost` `{"reason": "journal"}` (journal disparu) ;
  `run_lost` `{"reason": "worker"}` (verrou rendu, sans fin, pendant plus de
  3 s ; un verrou repris pendant ce délai l'annule). Un run déjà terminé à la
  connexion est rejoué jusqu'à son `run_end`, sans `replay_done`.

Les instants ne sont pas figés : ils dépendent des périodes de sondage ; le
test Python vérifie le rejeu d'un bloc à la connexion et la grâce de 3 s. Ces
goldens durent moins de 15 s : ni `ping` (après 20 s de flux) ni contrôle de
session (après 60 s) n'y paraissent.
