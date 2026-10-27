# Écarts voulus entre Elpis TS et la dernière version Python

Elpis 0.1.0 (cœur en TypeScript) reprend le comportement de la dernière version Python d'Elpis (0.0.1, tag
`python-final`) : les tests rejouent ses vecteurs et les définitions d'outils publiées sont figées dans des goldens
(`packages/outils-mcp/goldens/*.json`) tirés du Python. Ce document liste les endroits où le TS s'en écarte
**volontairement** : corrections de défauts relevés lors des vérifications, durcissements, et fonctions qui
n'existent qu'en TS. Il sert à qui monte depuis la 0.0.1. Le code Python restant n'a pas été modifié, sauf l'agent
du bac (dernière section).

Les tests vivent dans le dépôt de développement des mainteneurs : les chemins `apps/*/test/`, `packages/*/test/`,
`browser-service/test/` et `tests/` cités ci-dessous y renvoient, ils ne sont pas dans le dépôt public. Chaque écart
y est déclaré dans les tests qui comparent au Python (`apps/toolhost/test/ecart-anglais-shell-git.ts`,
`apps/core/test/skills/ecart-anglais.ts`, `apps/core/test/ecart-*.ts`, les commentaires des vecteurs adaptés,
`migration-kit/vecteurs/FIGES.md`) ; un test qui rejoue un vecteur Python sans passer par ces déclarations reste
strict. Les tests différentiels qui lançaient le vrai elpis-tools sont retirés avec lui.

Pour revenir à la version Python : docs/exploitation.md, « Revenir à la version Python (tag `python-final`) ».

## Définitions d'outils publiées (goldens)

Régénérer ces goldens depuis le Python effacerait les ajouts ci-dessous : le générateur `outils_mcp_golden_shell.py`
n'est plus à rejouer pour la famille `shell`, et les entrées modifiées de `git.json`, `chart.json`, `browser.json` et `skill.json` sont à
reporter à la main.

| Golden | Outil | Écart |
|---|---|---|
| `shell.json` | `execute_shell` | paramètre `strict: bool = false` (commande lancée par `bash -euo pipefail -c`) |
| `shell.json` | `execute_shell` | paramètre `on_timeout: "kill" \| "detach_and_wake"` (défaut `kill`), dans `inputSchema`, `fonctions` et la description ; `outputSchema` inchangé |
| `shell.json` | `shell_job` | outil propre au TS (voir « Tâches de fond ») ; 89 outils = 89 du Python + `shell_job` − `ask_user` (sorti vers les intégrés du tour) |
| `skill.json` | `ask_user` | retiré du golden : l'outil est un intégré du core (voir « Skills » plus bas) ; à ne pas rétablir en régénérant |
| `git.json` | `git_commit` | paramètre `allow_secrets: bool = false` ; la description dit la recherche de secrets et que les valeurs d'exemple de documentation sont ignorées |
| `chart.json` | `chart_pie` | la description annonce 8 parts au plus (le Python disait 6, alors que son code regroupait déjà au-delà de 8) |
| `browser.json` | `pw_observe`, `pw_a11y` | la description dit que chaque sélecteur rendu désigne un seul élément ; `target_dsl` toujours en `css=` |
| `browser.json` | `pw_visual` | la description annonce `diff_regions` et `diff_bbox` (zones modifiées) |
| `browser.json` | `pw_recorder` | la description dit les secrets jamais enregistrés (variables d'environnement) et les `eval` laissées en commentaire |
| `browser.json` | `pw_memory` | `path` : transitions apprises des gestes qui naviguent, navigations directes non apprises, une étape au moins sans `from_path`, `action_target` à passer à `pw_act` |
| `browser.json` | `pw_session` | la description dit le moteur réel (Chromium par défaut, `BROWSER_ENGINE` du service) au lieu de « Firefox », et ce que rend `health` |
| `browser.json` | `pw_page` | paramètre `switch: bool = false` (`tab_new` bascule sur le nouvel onglet) dans `inputSchema`, `fonctions` et la description ; la description dit qu'un onglet ouvert par la page est ajouté sans bascule et annoncé (`opened_tab`) |
| `browser.json` | `pw_act` | paramètres `files: Optional[List[Any]] = None` (upload) et `strict: bool = false`, dans `inputSchema` et `fonctions` ; la description dit l'upload, le comptage de la cible (`element_not_found`, `matched`, `strict`, `\|nth=K`, nom entier d'abord), `selected` de select/pick et le délai commun de 8 s |
| `browser.json` | `pw_chain` | la description dit le `code` des étapes en échec, les `alternatives` et le délai commun de 8 s |

## Outils fichiers (`read_file`, `list_files`, `write_file`, `edit_file`, `manage_files`)

- **Codes d'erreur stables.** Le Python prenait pour code le début du message mis en slug (chemin ou motif
  compris). Le code est désormais un mot court sans donnée (`path_outside_sandbox`, `invalid_path`,
  `symlink_refused`, `bad_regex`, `edits_overlap`…) ; le détail reste dans `message`.
- **Hash attendu.** Un `expected_sha256` qui n'est pas un sha256 hexadécimal de 64 caractères est refusé
  (`bad_sha256`) au lieu de donner un `hash_mismatch`.
- **Type MIME d'un lien** tiré du nom de sa cible, plus de celui du lien.
- **Liens et fichiers spéciaux listés** : `list_files` montre les liens symboliques (`type: "symlink"`,
  `target` = texte du lien, `target_in_sandbox`, `broken`, qui vaut `null` quand la cible sort du bac) sans jamais les
  suivre (`recursive`, `search_text`) ; FIFO, socket et périphérique ont `type: "fifo"`, `"socket"` ou `"device"`
  (caractère ou bloc) au lieu de `file`, `"special"` pour un genre inconnu ou un agent ancien. Sans `details`, les noms restent des chaînes, décrits par `symlinks` et
  `special_files` ; `summary` les compte à part ; un `path` qui est lui-même un lien sous `/work` porte `symlink: true`
  et `target`. Le Python cachait les liens et donnait `file` aux fichiers spéciaux.
- **Plages de lecture** (`line_ranges`) : triées puis fusionnées quand elles se chevauchent, bornées au nombre de
  lignes du fichier ; chaque ajustement est décrit dans `adjusted`. Le Python rendait deux fois les lignes communes.
- **Lignes longues** coupées à 2 000 caractères à l'affichage (marqueur `…[+N chars]`, avec un `hint`) ; un
  `max_chars` supérieur au défaut rend la ligne entière.
- **Binaires** : au-delà de 4 Ko, aperçu hexadécimal des 512 premiers octets et `hint` ; le base64 complet
  s'obtient par `as_base64=true` ou une plage `offset`/`length`. Le Python rendait en base64 tout binaire de moins
  de 10 Mo.
- **Dossiers écartés par défaut** (`node_modules`…) : `excluded_default` et son conseil n'apparaissent que si un
  tel dossier a vraiment été écarté, avec un conseil exact (`exclude=[]` ne désactive pas le filtre).
- **Aides de liste** : `hint` quand un motif ne trouve rien à la profondeur 1 sans `recursive` ; `warning` quand
  `since` n'est pas compris (le filtre reste ignoré, comme avant).
- **Recherche de `list_files`** (`grep`) : le résultat porte `path`, exigé par le schéma de sortie et absent du
  Python.
- **Chemins des résultats** : chaque résultat de `code` (`definition`, `references`) et de la
  recherche de `list_files` garde `file` (relatif au `scope` ou au `path` demandé) et ajoute `rel` (relatif à la
  racine du bac, le même quel que soit le `scope`, accepté tel quel par `read_file`) et `path` (`/work/…`).
- **Dossiers `.git`** : `write_file`, `edit_file` et `manage_files` refusent d'écrire, de déplacer ou de
  supprimer dans un dossier `.git` (`path_in_git_dir`), sauf `write_file`/`edit_file` sur `.git/info/exclude` ;
  copier depuis un `.git` reste permis. Le contrôle porte aussi sur le chemin réel (liens suivis, comme
  `git_write`) : un dossier en forme de dossier git (dépôt nu `x.git/`) est refusé, et une copie ou un
  déplacement dans un dossier existant est contrôlé après l'ajout du nom.
- **Édition** : message `edit #N (index i) failed` (le Python écrivait l'index en base 0 comme un rang) ; une
  ancre ambiguë liste ses `occurrences` (5 au plus, ligne et texte) et leur `total`.
- **Suppressions** : `files_changed` résume un dossier `.git` en une entrée comptée, et regroupe par dossier
  au-delà de 10 entrées.
- **Racine** : une action sur la racine du bac elle-même est refusée (`root_refused`).
- **Contenu condensé** : `write_file` et `edit_file` refusent un champ écrit réduit (aux blancs près) au marqueur
  entier `[content elided: N chars, sha256 … — re-read the file if needed]` (`elided_content`), que le core pose à la
  place d'anciens arguments (voir « Contexte ») ; un texte qui cite ce marqueur parmi d'autres (test, doc, journal)
  s'écrit.
- **Ligne coupée recopiée** : `write_file` et `edit_file` refusent un texte dont une ligne a la forme que `read_file`
  affiche pour une ligne coupée (au moins 2 000 caractères puis `…[+N chars]` en fin de ligne) : `cut_line_marker`,
  avec un `fix` pour relire la ligne entière. Une mention courte du marqueur passe. Le Python ne coupait pas.
- **Lots de `read_file`** : un chemin refusé (hors du bac, caractère de contrôle…) donne un résultat d'erreur pour
  ce seul chemin ; le Python rendait une erreur unique et perdait les chemins valides.
- **Erreurs : phrase et correctif.** `message` ne répète jamais le code : phrase anglaise propre au
  code (avec le chemin quand il est connu), sinon le code mis en phrase ; un refus de l'agent au code non traduit
  donne son texte anglais (`Not a directory: '/work/x'.`) au lieu du code, et plus son texte français en `fix`. Les
  codes de chemin et de ligne reçoivent un `fix` propre au lieu de « Verify path & params. ». Le `fix` de `hash_mismatch` demande de relire le fichier (`read_file`) pour
  obtenir le sha256 courant, sans prétendre qu'il a changé. `copy` d'un lien sortant rend `path_outside_sandbox`.
- **Lien sortant au milieu d'un chemin** : `path_outside_sandbox` au lieu de `outside_sandbox`, avec un
  `fix` ; en lecture, liste et `code`, le message nomme le lien et sa cible
  (`Path leaves the sandbox through a symlink: 'tmp/x/link_dir_out' -> '/etc'`), ailleurs le chemin demandé.
- **Copie** : `files_changed` d'un dossier copié résume `.git/` en une entrée comptée et regroupe par dossier
  au-delà de 10 entrées, comme les suppressions.
- **`auto_format`** : `edit_file` ajoute `format: {tool, status, message}` (`applied`, `failed` ou `unavailable`)
  quand l'extension a un formateur ; le Python ne disait rien d'un formateur absent ou en échec.
- **`code`** : `references` et `definition` sans aucun fichier parcouru ajoutent un `hint` qui liste les
  extensions parcourues ; `outline` Python rend la signature fidèle (valeurs par défaut, annotations, `/`, `*`,
  type de retour ; forme Python réduite si l'en-tête n'est pas lu) et `outline` Markdown porte un `warning` sur
  un titre qui saute un niveau.
- **Langue** : les textes renvoyés au modèle sont en anglais.

## Outils shell et git

- **Codes d'erreur stables**, comme pour les fichiers : le code est la tête du message, sans chemin, motif ni nom
  de conteneur.
- **`execute_shell`**
  - `strict` et `on_timeout` (voir les goldens).
  - Sortie complète sauvée (`saved_to`, débordement automatique ou `save_stdout`) : seuls 1 500 caractères de
    tête et 2 500 de queue sont injectés, avec un `hint` vers `read_file` ; stderr a au moins le quart de ce
    budget et reprend ce que stdout n'utilise pas. Le Python injectait jusqu'à 20 000 caractères par flux.
  - Purge des journaux de l'outil (`.tool-output/`, `.bg/`) au plus une fois par heure et par compte : plus de
    7 jours, puis les plus anciens tant que l'ensemble dépasse 200 Mo. Jamais un fichier ouvert par un processus
    ni un fichier de tâche de fond, ni, pour la purge au volume, un fichier de moins d'une heure. Le Python ne
    purgeait pas.
  - Au délai dépassé, le reste du groupe de processus est tué après 5 s, ainsi que les descendants sortis du groupe
    (`timeout` intérieur, `setsid`, double fork), reconnus à la variable `ELPIS_EXEC_ID` que porte la commande ; le
    Python pouvait laisser un descendant orphelin dans le conteneur. Une commande qui finit à temps garde ses
    processus détachés.
  - Les indications sur `timeout` et `background` renvoient vers `shell_job`.
  - Sortie non textuelle (NUL, contrôles hors tabulations, retours et ESC, UTF-8 invalide : 30 % de la tête ou de la queue) : résumé (`stdout_binary`, `stdout_bytes`, hexdump des 512 premiers octets dans `stdout_preview_hex`), sortie toujours sauvée, `hint` vers `read_file(offset, length)` ; le Python l'injectait décodée telle quelle.
  - `disk_warning` quand l'usage du compte atteint le seuil d'alerte (85 % par défaut) de son quota effectif ou le volume de `/work` ce même seuil ; refus `disk_full_risk` d'un `background=true` ou d'un `on_timeout="detach_and_wake"` qui lancerait une tâche au-delà du seuil de refus (97 % par défaut). Voir « Espace disque » ; le Python n'alertait pas.
- **`files_changed`** (shell, `skill_run`, actions git) : `files_changed_note` et `files_changed_attribution: "uncertain"` (lisible par machine) quand un autre relevé du même compte a chevauché la commande (la liste peut contenir ses changements ou manquer des siens) ; sans chevauchement, ni l'un ni l'autre. Le Python attribuait sans le dire.
  Liens symboliques et fichiers spéciaux créés, supprimés ou changés y figurent aussi : `type`
  (`symlink`, `fifo`, `socket`, `device`, `special`), `target` pour un lien (son texte, jamais suivi), `old_target`
  ou `old_type` quand la cible ou le genre change ; ni empreinte ni historique de session. Un fichier remplacé par un
  lien donne deux entrées (le fichier supprimé, le lien créé). La vue du modèle les résume en
  `chemin (created, symlink -> cible)`. Le Python les ignorait.
- **`git_write`** refuse tout chemin dans un dossier git (composant `.git` ou parent qui a la forme d'un dossier
  git), liens suivis ; le Python écrivait dans `.git/`.
- **`git_commit`** cherche des secrets dans les lignes ajoutées du diff indexé (clés de fournisseurs connus, clés
  privées, affectations des fichiers `.env*`). Un secret trouvé refuse le commit (`secrets_detected`, avec des
  `findings` masqués) sauf `allow_secrets=true` ; les changements restent indexés.
  - Un en-tête de clé privée sans corps est signalé à part (`private_key_header`) ; une clé écrite sur une ligne
    (`\n` échappés d'un JSON) est une `private_key`.
  - Les valeurs d'exemple ne sont jamais signalées, c'est voulu : clés de documentation (`AKIAIOSFODNN7EXAMPLE`),
    `example`, `sample`, `dummy`, `changeme`, `xxxxxx`, `<…>`, `${…}`, modèles `.env.example`.
- **`git_action` et `git_query`** : une commande git sortie avec un code non nul rend `ok: false`, un code stable
  (`not_fast_forward`, `merge_conflict` avec `conflicts`, `unknown_ref`, sinon `<action>_failed`), un `fix`, et
  garde `cmd`, `returncode`, `stdout`, `stderr` ; le Python rendait `ok: true` avec le code de retour. Seul `grep`
  sans résultat (code 1, rien sur stderr) reste un succès. `cherry_check` d'une référence impossible à appliquer
  (inconnue, commit de fusion) est une erreur ; le Python répondait `would_apply_cleanly: true`.
- **`git_query(diff|show)`** : au-delà de 6 000 caractères, seuls le `--stat` (6 000 caractères au plus, bilan
  gardé) et le début du diff coupé sur une fin de ligne sont rendus, avec `truncated`, la taille totale et un
  `hint` ; le Python rendait 20 000 caractères coupés en pleine ligne. Un petit diff est inchangé.
- **`git_action(merge)`** refuse toute fusion quand la branche courante est protégée (même politique que
  `git_commit`), toutes stratégies et `dry_run` compris : `protected_branch`, `fix` vers `git_submit` (la fusion
  locale reste possible par le shell si l'utilisateur la demande) ; le Python fusionnait. De même,
  `git_action(pull, branch=…)` refuse de tirer une autre branche dans une branche protégée (`pull_branch`, `fix`
  vers `git_start_work`) ; un `pull` sans `branch`, ou de la branche courante, reste permis.
- **`git_abandon`** sauvegarde avant de jeter : changements non commités (indexés, non indexés, non suivis) dans un
  commit hors branche (`refs/elpis/abandoned/<branche>-<horodatage>-changes`), tête d'une branche non fusionnée à
  supprimer dans `refs/elpis/abandoned/<branche>-<horodatage>` ; le résultat liste `saved` et donne la commande
  `recover`. Une sauvegarde en échec refuse l'abandon (`abandon_not_saved`), rien n'est jeté. Le Python jetait.
- **`git_start_work`** met `branch_intent` en slug avant de le valider (`probe change` → `probe-change`) ; le
  Python refusait.
- **Contexte d'exécution** (`<runtime_context>`) : le système de fichiers du bac n'est plus dit en lecture seule
  (seul `/work` persiste) ; le bloc SHELL mentionne `shell_job` quand l'outil est offert au tour. Le bloc PATHS dit la règle appliquée : un chemin doit se résoudre sous `/work`, relatif recommandé, absolu sous `/work` accepté ; `/tmp/foo`,
  `/home/x`, `../up` refusés. Le Python disait tout chemin relatif et citait `~/file` comme refusé, alors que `~`
  vaut `/work` pour les outils fichiers et shell.
- **Langue** : les textes renvoyés au modèle sont en anglais, traduits à la frontière des outils
  (`apps/toolhost/src/mcp/anglais.ts`) ; les messages partagés avec l'interface restent en français.

## Graphiques et skills

- **Graphiques** : plus de donnée perdue, réordonnée ou mal lue sans avertissement.
  - Entonnoir : ordre d'entrée gardé, avertissement s'il n'est pas décroissant (le Python triait et calculait la
    conversion sur l'ordre trié).
  - Arbre : cycles et noms en double annoncés.
  - Calendrier : une date illisible n'écarte que sa ligne, annoncée ; la lecture JJ/MM est annoncée.
  - Barres : clés différentes entre lignes, valeurs vides, `highlight` inconnu annoncés ; un `highlight` sans
    correspondance ne grise plus rien.
  - Colonne numérique aux deux tiers, ou désignée par `y` : lue comme nombres, cellules invalides listées.
  - Jauge, progression, KPI, tendance, bougies, heatmap : dépassements, variation incalculable, tendance
    impossible et cellules manquantes avertissent.
- **Skills** : un nom inconnu propose les 3 noms les plus proches (`Closest names: …`).
- **Langue** : les textes renvoyés au modèle sont en anglais ; les routes de l'interface gardent les messages
  français (`SkillSaveError` porte les deux).
- **`ask_user` hors de la famille skill** : l'outil devient un intégré du core (`outils/integres/question.ts`), proposé
  dans tout chat dont les outils sont actifs, mode plan compris, jamais en routine ni en sous-agent. La famille
  `skill` garde quatre outils (`skill_save`, `skill_add_file`, `skill_get`, `skill_read_file`) ; schéma et
  résultat sont inchangés (le scénario `ask_user` des vecteurs est rejoué sur le nouvel outil) et la description ne cite
  plus « e.g. building a skill » (l'outil est générique) ; en revanche la
  notification MCP `ask_user: questionnaire of N question(s) displayed` n'existe plus, et la catégorie « Skills »
  ne le coupe plus.
- **`routine_save`** (propre au TS) : outil intégré du tour, sans famille MCP ; réglage `routine_tool_enabled`.

## Contexte (élagage et compression)

- **Élagage** : comme le Python, toutes les sorties au-delà de la fenêtre protégée (`prune.protect_tokens` récents)
  partent si le gain atteint `prune.min_tokens`, et la fenêtre n'est jamais entamée. Deux écarts :
  - une sortie déjà marquée est sautée au lieu d'arrêter le parcours : les plus anciennes restent candidates même
    quand les marques sont éparses (le Python s'arrêtait à la première marque, pendant le run comme au rechargement) ;
  - les sorties d'appels parallèles (un même message `assistant`) restent ensemble : si la plus récente est dans la
    fenêtre, tout le lot y reste.
- **Condensé** : une sortie effacée est remplacée par une ligne en anglais (outil, succès ou erreur, argument
  principal, taille, un ou deux faits) au lieu du marqueur fixe ; l'ancien marqueur reste reconnu.
- **Arguments condensés** : hors des 2 derniers tours, les arguments de plus de 2 000 caractères d'un ancien
  `write_file` ou `edit_file` sont condensés dans la vue du modèle (JSON valide, marqueur
  `[content elided: N chars, sha256 …]`) ; le stockage et l'historique affiché ne changent pas.
- **Indexation** : les sorties élaguées sont indexées pour `session_search` avant leur effacement ; la compression
  ne réindexe ni ces sorties ni les marqueurs (le Python indexait le marqueur lui-même). Un tour arrêté (Stop) ou en
  erreur du moteur enregistre aussi les clés déjà élaguées, qui ne sont donc ni reprises ni réindexées. Un tour
  éphémère n'indexe rien, ni à l'élagage ni à la compression (le Python indexait les tours compressés).

## Conversations

- Un tour qui finit après la suppression de sa conversation ne la recrée plus (`upsertChat` fait un UPDATE seul ;
  `store.upsert_chat` Python inchangé).
- `wake_disabled` n'apparaît dans `GET /api/saved/chats/:id` que s'il est posé sur la conversation.
- File du moteur en ordonnancement `optimized` avec outils : `queue_cleared` part quand le tour obtient son premier
  créneau (son premier appel LLM), non plus dès son admission, qui ne tient que le modèle ; le bandeau « N requête(s)
  en cours » reste donc affiché tant que le moteur est occupé (Python : effacé aussitôt après l'admission).

## Connecteurs LLM : fournisseurs cloud fermés par défaut

- **Liste des types ouverts aux comptes** (`llm.allowed_provider_types`) : elle dit les types cloud (`anthropic`,
  `openai`, `mistral`, `groq`, `openrouter`, `deepseek`, `moonshot`, `opencode`) qu'un compte **non
  administrateur** (modérateur compris) peut brancher avec sa propre clé dans Réglages › Modèles IA. Absente ou
  vide, elle n'en ouvre **aucun** ; le Python les ouvrait alors tous.
- **Comptes administrateurs** : pas concernés. Leurs connecteurs personnels gardent tous les types cloud, et les
  connecteurs partagés (Console › Modèles, tout type, y compris `llamacpp`, `vllm` et `generic`) ne changent pas.
- **Types locaux** (`llamacpp`, `vllm`, `generic`) : réservés aux connecteurs partagés, comme dans le Python ; un
  compte non administrateur s'en sert par les connecteurs que l'administrateur partage et par le moteur intégré.
- **Connecteur personnel existant d'un type fermé** : il reste en base mais n'est plus utilisé (« Ce fournisseur
  n'est plus autorisé sur cette instance. ») tant que l'administrateur n'ouvre pas son type. Réglages › Modèles IA
  ne propose que les types ouverts et dit quand aucun ne l'est.
- **Mise à jour depuis la 0.0.1** : pour garder les fournisseurs cloud des comptes, les ouvrir dans Console ›
  Modèles › Accès utilisateurs › Fournisseurs autorisés (ou `llm.allowed_provider_types` dans `config.json`).

## Moteurs vLLM et SGLang : réflexion et dialecte

Le type déclaré du moteur (`llama.engine` de `config.json`, ou type d'un connecteur) fait foi : aucun moteur ni
aucune capacité n'est deviné.

- **Réflexion lue** dans `reasoning` (seul champ de vLLM 0.31) comme dans `reasoning_content` (llama.cpp, SGLang),
  en flux et dans les réponses entières, pour tout fournisseur compatible OpenAI ; un serveur qui envoie les deux
  n'est compté qu'une fois. Le Python ne lisait que `reasoning_content` : la réflexion de vLLM n'apparaissait pas.
- **Progression et journaux d'un outil** : `tool_progress` et `tool_log` portent le `call_id` de l'appel ; l'interface
  les rattache à cette seule étape (une progression tardive d'un appel fini n'est plus affichée sous un autre), et au
  dernier appel en cours du même nom seulement quand le `call_id` manque (lots parallèles d'un même outil : la
  progression de l'un s'affichait sous l'autre).
- **Dialecte de requête** de `vllm` et de `sglang` (accepté comme `llama.engine`) : `chat_template_kwargs`
  (`enable_thinking` suit l'interrupteur Réflexion), `reasoning_effort` (puce Effort), `top_k`, `min_p` et
  `repetition_penalty` (la pénalité de répétition des réglages ; un `top_k` nul devient -1). Le Python retirait ces
  champs : la réflexion ne pouvait pas être coupée. Les fournisseurs du nuage et `generic` restent au standard.
- **Capacités** : pour ces deux moteurs, `effective-params` déclare la réflexion et l'effort (`none` à `xhigh`)
  sans `/props`, au lieu de `null` ; l'interrupteur et la puce sont offerts (sans effet sur un modèle qui ne
  raisonne pas).
- **Raisonnement conservé avec SGLang** (désactivé par défaut) : `effective-params` déclare
  `supports_preserve_reasoning` quand `/server_info` annonce un parseur de réflexion, avec
  `preserve_reasoning_default: false` ; activé, la réflexion de chaque appel d'outil du tour repart au moteur dans le
  `reasoning_content` du message assistant, sans le balisage d'appel, comptée par `tokens.ts` pendant ce tour et jamais
  enregistrée dans l'historique du chat (seul l'enregistrement de reprise d'un sous-agent, propre au TS, la garde pour
  que son préfixe reparte à l'identique). Le Python ne la rendait à aucun moteur. Dans ce cas seulement, le jalon `<harness_status>` du budget
  n'est pas un message `user` mi-tour (le gabarit retirerait la réflexion des assistants précédents) mais la fin du
  dernier résultat d'outil du lot, hors `tool_history`.
- **`</think>` orphelin** (serveur sans `--reasoning-parser`, gabarit qui ouvre `<think>` dans le prompt) : le texte
  qui le précède devient la réflexion en fin d'itération, comme dans le Python ; en plus, la bulle en direct est
  resynchronisée (`content_replace`), la narration d'un round d'outils ne garde ni la réflexion ni la balise, et le
  résumé d'un point de terminaison de compression dédié retire ce raisonnement.
- **Appels d'outils en flux** : un delta qui apporte un nouvel `id` et un nom sur un `index` dont l'appel est déjà
  nommé ouvre un appel distinct (SGLang réutilise l'index après un nom d'outil inconnu, certains parseurs mettent la
  position de l'outil dans `tools`) ; Elpis numérote les appels dans leur ordre d'ouverture et transmet ce numéro
  dans `tool_call_delta`. Le Python, comme le TS avant, fusionnait les deux appels sous un nom collé
  (`read_filelist_dir`) aux arguments invalides.

## Moteurs : profils déclarés (llama.cpp, vLLM, SGLang, générique)

Une table unique (`apps/core/src/llm/profils.ts`) décrit chaque type déclaré : adresses, capacités, métriques,
options de lancement à conseiller et dialecte (celui de la section précédente). Le Python testait `llamacpp` à la
main et traitait tout autre moteur comme un service distant sans capacité.

- **Débits sans `timings`** (vLLM, SGLang) : Elpis mesure le délai du premier jeton et la génération et en tire des
  `timings` à la forme de llama.cpp (`source: "elpis"`) : débit d'écriture de la bulle, durée de génération des
  exécutions et du journal des appels. Débit de lecture et durée de prefill seulement quand le serveur rapporte les
  jetons repris du cache (`--enable-prompt-tokens-details`, `--enable-cache-report`) : sans eux, le cache de préfixe,
  actif par défaut, ferait passer des jetons repris pour des jetons lus. Le Python n'affichait aucun débit de lecture
  pour ces moteurs et comptait le prefill dans le débit d'écriture.
- **Configuration** : `llama.engine` accepte `sglang` ; `llama.url` peut être la base du serveur (ou finir par
  `/v1`) ; `llama.api_key` (ou `LLAMA_API_KEY`) part en `Authorization: Bearer` sur chaque appel au moteur par
  défaut, n'est jamais journalisée ni rendue à la console (`********`). Le Python n'envoyait aucune clé.
- **Charge de SGLang** : délai moyen du premier jeton et débit de prefill lus sur ses métriques ; jauge KV additionnée
  entre répliques `--dp` (rangs TP comptés une fois).
- **vLLM et SGLang** : fenêtre lue sur `max_model_len`, jetons comptés exactement par leur tokenisation
  (`/tokenize`, `/v1/tokenize`, conversation rendue en un appel), cache KV et charge lus sur leurs métriques, aucun
  chargement, et plus de file d'Elpis : le moteur regroupe lui-même les requêtes (le Python les sérialisait une à
  une). `llama.max_concurrency` ne vaut plus que pour llama.cpp.
- **Fenêtre annoncée** : la fenêtre d'un moteur qui l'annonce (llama.cpp, vLLM, SGLang) n'est jamais devinée au nom
  du modèle, même moteur muet (`qwen3*` valait 131 072 même pour un modèle à 262 144) : sans fenêtre déclarée ni
  `LLM_REMOTE_N_CTX`, elle reste inconnue.
- **Sonde** au démarrage et sur « Tester » (console) : adresses du profil, version, modèle servi, contexte,
  métriques, jetons en cache, parseurs, avec l'option exacte à ajouter quand une capacité manque ; le parseur
  d'appels d'outils de SGLang est comparé au format du modèle quand son nom le permet (`qwen3_coder` pour
  Qwen3-Coder…), et une réponse vide après la réflexion alors que des outils étaient offerts est signalée. Sans
  équivalent Python.
- **Connecteurs** : type `sglang` en plus ; `?sonde=1` sur leur test. Sans `?sonde=1`, réponses inchangées.
- **Jauge de contexte** : l'occupation n'est plus bornée à la fenêtre connue (un prompt réel plus long s'affiche tel
  quel, en direct comme au rechargement) ; seul le pourcentage l'est. Un avis part une fois par tour si cette fenêtre
  est lue sur le moteur ou déclarée sur le connecteur. La jauge en direct ajoute à part les jetons générés que le
  dernier prompt mesuré ne compte pas, et la capacité du cache KV de vLLM ou SGLang ne sert plus de fenêtre.

## Console : secrets de config.json masqués

`GET /api/admin/config-file` remplace par `********` la valeur de chaque secret de `config.json`
(`CHEMINS_SECRETS_CONFIG` de `packages/contracts/src/rest/admin-config.ts`, d'où viennent `SECRETS_MASQUES` du core et la
liste du formulaire : clé du moteur, clés des embeddings et de l'OCR du RAG, jeton de l'extracteur, clés de Qdrant et de la
mémoire des agents, jetons de la voix, jeton et jetons clients du pont MCP local, secret de session, clé de chiffrement,
clé des images) ; le Python rendait le fichier tel quel. Un secret rangé dans un objet (`mcp.local_client_tokens`) a chaque
valeur masquée. `********` revenu par l'écriture du fichier ou par `PATCH /api/admin/config` garde la valeur du disque, et
les essais du formulaire (extracteur, embeddings, OCR, voix) la remplacent par le secret enregistré pour l'adresse
enregistrée seulement. Le jeton de scrape Prometheus n'est pas masqué : sa page le montre à l'administrateur.
`/api/config` d'un compte vide ces secrets d'instance et le jeton de scrape (`SECRET_PATHS`, `apps/core/src/familles/config.ts`).

## RAG intégré au core

Le RAG de la version Python (service `rag_app` avec sa console, sa collection active, `rag_config.json`, ses routes
`/api/tools/*`, l'enrichissement `rag_inline` du dernier message) est **remplacé** par le RAG intégré : collections par
compte, droits et publication, indexation, recherche et outils du chat dans le core TS (`apps/core/src/rag/`,
`docs/architecture.md`, « RAG intégré »). La mise à jour supprime l'ancien RAG sans rien importer
(`docs/exploitation.md`, « Passage au RAG intégré »).

- **Extracteur** : `rag_app` ne garde que `/api/extract`, `/api/render`, `/api/locate` et `/api/health` (jeton
  exigé sauf pour la santé, écoute sur `127.0.0.1`) ; l'ancienne console et ses routes répondent 404 (ou 405). Caddy n'a plus de
  site `:8444`.
- **Chat** : `use_rag`, `rag_collection`, `rag_search_mode`, `rag_top_k` et `rag_use_mmr` du corps de
  `POST /api/chat-saved-stream3` sont ignorés ; les collections actives vivent dans `chats.meta_json.rag`
  (`PUT /api/saved/chats/{id}/rag`). Aucun passage n'est plus injecté avant la question : l'assistant cherche par les
  outils `rag_*`, et `rag_sources` porte les passages qu'ils ont numérotés.
- **Routes** : `GET /api/rag/collections` liste les collections lisibles par le compte (plus les noms Qdrant) ;
  `GET/POST /api/admin/config-file?type=rag` répond 400 (`type=main` seul).
- **Réglage du compte** : `enable_rag` reste accepté mais n'a aucun effet ; son interrupteur a quitté Paramètres ›
  Fonctionnalités (le RAG d'un chat dépend de ses collections actives).

## Outils MCP : catégories vues par les comptes

- **Pré-chauffage** : comme le Python (`prewarm_mcp_pool`), main se connecte au démarrage à chaque entrée intégrée
  de `mcp.json` ; le registre des catégories, donc les familles visibles des comptes (Paramètres › MCP, sélecteur
  d'outils du chat), se remplit sans attendre un tour. Une entrée encore injoignable (hôte d'outils pas encore à
  l'écoute) est retentée pendant environ deux minutes au lieu d'un seul essai ; `MCP_PREWARM=0` le coupe toujours.
- **Catégorie servie par deux entrées** (`skill` : `elpis-skill` et `elpis-skill-run`) : ses outils sont l'union de
  ceux des deux. Le Python ne gardait que ceux de l'entrée listée en dernier : le panneau ne montrait qu'une partie
  des outils de la catégorie, sans pouvoir décocher les autres.

## Exploitation : retours arrière retirés

Les interrupteurs de retour arrière de la migration (`ELPIS_TOOLHOST=python`, `ELPIS_APPMCP=python`,
`ELPIS_CLI=python`) et le Python qu'ils seuls lançaient (ancien hôte d'outils, service `appmcp`, commandes
d'exploitation Python) sont retirés en 0.1.0 : core, hôte d'outils, familles du compte et `./elpis backup`, `db`,
`browser` passent toujours par Node.js. Le retour complet à la version Python passe par le tag `python-final`
(docs/exploitation.md).

## Sécurité : durcissements de l'audit de publication

- **Mots de passe** : PBKDF2-SHA256 à 600 000 itérations, au format `pbkdf2_sha256$itérations$sel$empreinte` ;
  l'empreinte historique du Python (150 000 itérations, sel dans `pass_salt`) reste acceptée et le mot de passe est
  rehaché au format courant à la connexion suivante.
- **Enveloppe d'identité** signée avec `"typ": "identite"` ; un corps qui porte une audience (`aud`, enveloppe de
  revendications) ou un autre type n'est jamais lu comme une identité. Une enveloppe sans type (hôte plus ancien)
  reste acceptée.
- **Accès aux moteurs fermé en cas d'erreur** : politiques ou connecteur illisibles = aucun serveur hors
  administrateur déclaré, `503 access_check_failed` au chat et aux images (le Python ouvrait tout).
- **Cookie de session** effacé sous une seule forme (`path=/`, `Max-Age=0`, `HttpOnly`, mêmes `SameSite` et
  `Secure` que la pose) au lieu des deux formes de Starlette.
- **Clé d'audit** mesurée après retrait des blancs : moins de 32 octets, audit sans HMAC et avertissement (le Python
  signait avec ce qui restait, même vide).
- **SQL** : les `?` des commentaires `/* */` ne sont plus pris pour des paramètres (pg8000 les numérotait).
- **Installeurs de poste** : le script servi porte l'empreinte SHA-256 (DER) de la CA ; une CA d'une autre empreinte
  est refusée et, sans empreinte, aucune CA n'est installée.
- **Erreurs du flux** : l'événement `error` d'une panne du tour ne porte plus le message brut de l'exception.
- **Feuilles de style** livrées avec un en-tête SPDX d'une ligne (empreinte, taille et ETag servis changent d'autant).

## Tâches de fond (`shell_job`), propres au TS

Le Python n'a pas d'équivalent : son mode `background` lançait un processus détaché, sans suivi ni réveil.

- **Outil `shell_job`** : `start`, `status`, `logs`, `kill`, `list` ; une tâche peut réveiller l'agent à sa fin
  ou sur un motif de sortie (`wake_on`). Il n'existe que si la famille `shell` est native. `execute_shell` avec
  `on_timeout="detach_and_wake"` convertit en tâche une commande qui dépasse son délai (champs `detached`,
  `job_id`, `wake_on`, `merged_output`, et `on_timeout_fallback` si le core refuse).
- **Réveil** : file par compte (un réveil à la fois par défaut), tour de réveil marqué dans `run_started`
  (`origin`, `wake`) ; « Ne pas me réveiller » par conversation, défaut du compte `jobs_wake` (vrai si absent).
  Un réveil en file est revérifié à son départ (« Ne pas me réveiller », défaut du compte, profondeur, quota) ;
  couper le réveil d'une conversation la retire de la file (`chat_wake` `skipped`, `reason: "wake_disabled"`).
- **Tour de réveil** : il part de la sélection d'outils COURANTE de la conversation (`meta.tools`, posée par
  `PUT /api/saved/chats/:id/tools`) et ne la réécrit jamais ; l'instantané du tour qui a lancé le job ne sert
  qu'à une conversation sans sélection enregistrée, et pour le modèle et le connecteur (aucun modèle n'est
  enregistré par conversation).
- **« Arrêter »** (`POST /api/chat/cancel`) : plus aucun réveil automatique de la conversation, même pour un
  événement arrivé ensuite ; un réveil en file est retiré (`reason: "stopped"`). Les événements attendent le
  prochain message de l'utilisateur, qui les reçoit ; tout tour qu'il lance (message ou « Continuer ») rétablit
  les réveils.
- **Livraisons sûres** : un événement remis au modèle dans un résultat d'outil n'est tenu pour livré que si la
  réponse du tour (finale ou partielle) est enregistrée ; sinon (conflit d'un autre onglet, erreur de base) il
  redevient non livré. Une livraison reste « en vol » (`delivered_in` préfixé `taken:`) jusqu'à la fin du run ;
  au redémarrage du core, celles des runs coupés redeviennent non livrées (au pire un doublon, jamais une perte).
- **Lancement non confirmé** : un événement de l'agent qui dit le job vivant (`state: "running"`) le fait passer
  de `starting` à `running` ; la confirmation tardive pose ensuite le pid. L'hôte d'outils reprend la
  confirmation pendant environ 8 min 30 (8 essais).
- **Lancement dont la réponse se perd** (délai, transport) : l'hôte relit la fiche de l'agent au lieu de déclarer
  l'échec ; job connu, il est suivi tel quel ; fiche illisible, `shell_job` rend `launch_unconfirmed` (ne pas
  relancer) et `execute_shell` détaché ne retombe pas sur l'exécution synchrone : la commande ne tourne jamais
  deux fois.
- **Numérotation de l'agent repartie plus bas** (`.bg/jobs-events.ndjson` perdu puis agent relancé) : la fin
  d'un job encore actif est acceptée malgré un `seq` déjà vu (rangée après le dernier) ; ses événements non
  terminaux de même `seq` restent refusés.
- **Chaîne de réveils** (`jobs.max_depth`, 5 par défaut) : un tour de réveil compte un cran de plus que le tour qui
  a lancé le job ; un message de l'utilisateur remet la chaîne à 0. Dans un tour de réveil, `shell_job(start)` rend
  `chain_depth` et `max_chain_depth` ; un job lancé à la limite démarre sans réveil, avec un `warning` (de même pour
  `execute_shell` détaché). L'en-tête du message de réveil donne la profondeur (`chain depth N/M`) et chaque
  `<job_event>` d'un job lancé par un réveil porte `chain_depth`. Le journal `.bg/jobs-events.ndjson` du bac porte
  aussi `chain_depth` sur chaque événement (0 pour un job lancé depuis un message de l'utilisateur).
- **Compaction** : la ligne des tâches actives (`active jobs …`) suit l'ancre épinglée ; quand la fenêtre gardée
  s'ouvre sur une question, elle est jointe à cette question dans la vue du modèle (jamais deux `user` d'affilée).
- **Interface** : puce « Tâches de fond » (visible dès le chargement : `GET /api/jobs` rend `active_total`, les
  jobs actifs de tout le compte), commande `/jobs` (`all`, `stop <id>`, `stop all`), ligne de réveil
  intégrée à la bulle de l'agent qu'elle continue (réveils et réponses regroupés à l'affichage seulement, base et
  contexte du modèle inchangés), réglages dans la console › Sandbox.
- **Core** : tables `shell_jobs` et `shell_job_events` créées au démarrage, sans migration ; routes `/api/jobs*`
  et `/api/internal/jobs*` ; événements `chat_job` et `chat_wake` ; section `jobs` de la configuration des
  exécuteurs (`GET /api/admin/executors`).
- **Hôte d'outils** : routes internes `/api/internal/jobs/watch` et `/api/internal/jobs/kill`. Un lot refusé
  pour de bon par le core (4xx hors 408 et 429 : compte supprimé) arrête la veille après 20 refus ; le core la
  reconfie s'il a encore des jobs actifs.
- **Stop pendant un appel à l'hôte d'outils intégré** : le core envoie `notifications/cancelled` (le Python n'en
  envoyait à aucun serveur ; les serveurs MCP externes restent ainsi). `execute_shell(on_timeout="detach_and_wake")`
  cesse alors d'attendre : la commande continue comme un job ordinaire, sans que son résultat soit marqué livré.
- **Conversation supprimée** : ses tâches sont arrêtées et retirées des listes (`kill_by=chat_deleted`) ; leurs
  fichiers sont purgés par le balayage de rétention, réessayé jusqu'à réussir.
- **Limites connues** : une entrée de `wake_on` est bornée à 300 caractères ; le quota horaire de réveils,
  l'état « saisie en cours » (conversations du compte seulement, entrées expirées purgées) et la suspension
  posée par « Arrêter » vivent en mémoire et repartent de zéro au redémarrage du core.

## Espace disque, propre au TS

Le Python ne regardait jamais l'espace libre.

- **Seuils** : `executors.disk.warn_pct` (85 par défaut, 10 à 99) et `executors.disk.refuse_pct` (97, 11 à 100),
  en pourcentage, alerte sous le refus ; console › Sandbox › Limites, bloc « Espace disque » ; relus à chaud par
  l'hôte d'outils. Chacun vaut pour deux mesures : usage du compte sur son quota effectif (s'il n'est pas
  illimité ; usage gardé 30 s en cache) et remplissage du volume qui porte `/work`.
- **Alerte** `disk_warning` (phrase anglaise : pourcentage, conseil, seuil de refus) au-delà du seuil d'alerte
  seulement, sur `execute_shell`, `write_file`, `edit_file`, `manage_files` (sauf suppressions) et
  `shell_job(start)`.
- **Refus** `disk_full_risk` avec un `fix` (libérer `.tool-output/`, artefacts, `manage_files(action="delete")`)
  au-delà du seuil de refus, confirmé par un usage de moins de 5 s (ou par l'usage en cache s'il dépasse déjà le seuil
  et que la mesure fraîche tarde) : `write_file` et `manage_files(copy)` (hors
  `dry_run`), `shell_job(start)`, `execute_shell(background=true)`, `execute_shell(on_timeout="detach_and_wake")`
  quand il lancerait une tâche. Jamais pour un `execute_shell` ordinaire, `edit_file` ni une suppression.
- **Mesure jamais bloquante** : une seconde au plus ; le volume (instantané) est mesuré d'abord et compte toujours ;
  quota inconnu (core injoignable), lent ou en panne : rien sur le quota.

## Outils web (navigateur)

Service `browser-service/` et famille `browser` de l'hôte d'outils. Écarts déclarés, dans les tests des
mainteneurs, par `apps/toolhost/test/interop/browser-differentiel.test.ts` (réponses de `pw_memory`, relecture d'URL après un
`back`, tables AX sans navigations directes, descriptions) et `packages/navigateur/test/ax-actions.test.ts`
(`ecartChemin`).

- **Sélecteurs uniques** (`pw_observe`, `pw_a11y`) : le Python rendait `a:has-text("edit")` pour quatre liens, ou
  `img`, `button`, `input`. Chaque sélecteur est vérifié dans la page comme Playwright le lit (racines shadow
  ouvertes percées) ; s'il désigne plusieurs éléments, un chemin `nth-of-type` depuis l'ancêtre à id unique le
  remplace. Un élément d'une racine shadow reçoit `<hôte unique> >> <sélecteur intérieur>`. `target_dsl` de `pw_observe` est toujours `css=<sélecteur>`
  (le texte brut `a:has-text(...)` n'était pas lu comme une cible). Pour `duplicate-id`, le sélecteur est celui de la
  première occurrence, avec `id` et `count`.
- **Geste qui navigue** (`/action` et étapes de `/chain` : clic, double-clic, touche) : la navigation partie dans la
  foulée est attendue jusqu'à la page d'arrivée (fenêtre de 250 ms, `PW_NAV_GRACE_MS`, arrivée bornée à 10 s) ; la
  réponse porte `url`, `url_before` et `navigated: true`. Playwright attendait déjà une soumission classique, pas une
  navigation lancée par script juste après le clic. Coût : jusqu'à 250 ms par clic qui ne navigue pas. L'attente tient
  dans le délai du client : la requête entière dure 9 s au plus depuis son arrivée (`PW_GESTURE_BUDGET_MS` ; 55 s pour
  `/chain`, `PW_CHAIN_BUDGET_MS`), geste et `wait_after` compris. Une page encore en chargement à l'échéance rend un
  succès avec l'URL courante et `nav_warning: "navigation still loading: …"`, jamais `timeout` pour un clic réussi.
- **Mémoire AX** (`pw_memory`) : les étapes de `pw_chain` qui ont changé de page sont apprises comme les gestes de
  `pw_act` (le Python n'apprenait rien de `pw_chain`). Les navigations directes (`goto`, `back`, `forward`) ne sont plus
  enregistrées comme éléments de rôle `navigation` ni comme transitions, et celles d'une base Python sont ignorées par
  `path`. Sans `from_path`, le chemin part de toute AUTRE page connue (le Python rendait un trajet vide, profondeur 0,
  dès que la page visée avait ses propres transitions). Chaque étape porte `action_target`, la cible DSL à passer à
  `pw_act` (`action_selector` est un objet `{strategy, value, …}`).
- **Recorder** (`pw_recorder`) : une saisie dans un champ secret (`type=password`, ou nom, id, `autocomplete`, libellé,
  placeholder ou cible qui évoque un mot de passe, un code à usage unique, un jeton, une clé d'API, un PIN, un
  cryptogramme) n'est jamais gardée : le script lit une variable d'environnement (`process.env.PASSWORD`,
  `Cypress.env('PASSWORD')`, Robot `Fill Secret … $PASSWORD` avec `${PASSWORD}    %{PASSWORD}`), listée dans
  `secret_variables`. Une variable par champ : `PASSWORD` au premier, `PASSWORD_2`, `PASSWORD_3`… aux suivants (ancien,
  nouveau et confirmation d'un changement de mot de passe), la même pour un champ déjà saisi. Les `eval` (`pw_page`)
  sont enregistrées mais rendues en commentaire, non rejouées (décision : un script arbitraire de la page n'est pas un
  geste d'utilisateur, il peut tricher sur l'interface ou contenir n'importe quoi) ; `notes` le dit. Le format `json`
  garde leur script (300 caractères au plus). Un script qui saisit (`.value =`, `fill(`, `type(`, `execCommand(`…) ou
  cite un secret (mot de passe, jeton, clé, session…) est gardé avec ses littéraux et la valeur affectée en `***`. Les
  URL enregistrées (`goto` et `url` de chaque événement) perdent leurs identifiants (`user:pass@`) et la valeur de
  leurs paramètres sensibles, en requête comme en fragment (`token`, `key`, `password`, `secret`, `auth`, `code`,
  `session`, `sig`…, plus les mots des champs secrets) : `***`, et `notes` demande de les remettre avant le rejeu.
- **Cibles DSL** : un `|` ne coupe la cible que devant une clé connue suivie de `=` ; `role=link|name=Docs | Produit`,
  `css=a:has-text("A | B")` et `css=[lang|=fr]` sont lus entiers (le Python coupait sur tout `|` : `text=a|b` donnait
  `text=a`). `\|` garde toujours un `|` dans la valeur ; les cibles rendues par les outils (`target_dsl` de
  `pw_observe`, `suggestions[].target`, `action_target` de `pw_memory`) l'emploient quand un nom contient `|clé=`.
- **Diff visuel** (`pw_visual`) : `diff_regions` (10 boîtes au plus, `{x, y, w, h, pixels}`, les plus fournies
  d'abord), `diff_regions_total`, `diff_regions_truncated` et `diff_bbox`, en pixels de la capture comparée.
- **Une navigation en échec ne ferme plus la session.** Juste après un `goto` vers un hôte injoignable
  (`ERR_TUNNEL_CONNECTION_FAILED`, `ERR_NAME_NOT_RESOLVED`…), la page d'erreur remplace le contexte d'exécution : la
  sonde de vie (`pingPage`) prenait ce rejet pour un crash et la requête suivante fermait la session
  (`page_crash_on_request`, puis `session_not_found`). La sonde resonde pendant une navigation ; le service rend
  `code: navigation_failed`, un message anglais sans séquences ANSI ni journal d'appel Playwright et un `fix`.
  Chromium remplace la page courante par sa page d'erreur (`chrome-error://chromewebdata/`) : `goto` revient à la
  page précédente (rechargée : une saisie non envoyée peut être perdue) et le `fix` le dit ; `url` est toujours
  l'adresse que montre l'onglet. Sans retour possible, le `fix` nomme la page d'erreur et `pw_act(action='back')`.
- **Code stable du service à tout statut** : le client reprend `code`, `error` et `fix` du service quel que soit le
  statut ; le Python ne les lisait qu'en 404 et mettait sinon le message en slug (`navigation_chou_e_vers_…`).
- **Onglets ouverts par la page** (`target=_blank`, `window.open`) : ajoutés à la session sans y basculer et annoncés
  dans la réponse de l'action (`opened_tab: {index, url, active, switch_with}`, `opened_tabs` s'il y en a plusieurs) :
  l'attente de navigation d'un geste (`PW_NAV_GRACE_MS`) laisse au popup le temps d'arriver ; plus courte qu'elle, et
  pour `/smart_click`, la réponse l'attend 150 ms au plus (`PW_POPUP_GRACE_MS`). Un onglet qui se ferme seul sort de
  la liste (`closed_tab`) et l'onglet actif passe à son voisin. `tab_close` ne change plus l'onglet actif quand on
  ferme un autre onglet.
- **Onglet actif** : `tabs`, `tab_new`, `tab_switch` et `tab_close` rendent `active` ; `tab_new` accepte `switch=true`
  (défaut inchangé : l'onglet s'ouvre en arrière-plan). Une erreur d'action sur une session à plusieurs onglets
  rappelle l'onglet actif : le service le joint à part (`tab_hint`, `active_tab`, `total_tabs`, sans toucher `error`
  dont le client tire le code) et le client l'ajoute au message ; un délai dépassé côté hôte d'outils (`pw_act`) aussi,
  lu sur `GET /sessions`, qui rend `active_tab` sans prendre le verrou de la session.
- **Résultat d'une navigation** : `goto`, `start` et `tab_new` rendent `http_status` (un 404 ou un 503 reste une
  navigation réussie), `final_url` après une redirection et `tls_warning` quand le certificat est expiré, pas encore
  valide ou auto-signé (la page se charge quand même : pas de blocage) ; `start` rend `nav_warning` si sa navigation
  a échoué.
- **`pw_session health`** : `/health` rend `sessions`, la liste des sessions du compte (comme `/sessions`), et
  `session_count`, leur nombre total ; l'ancien `sessions` entier violait le schéma de sortie publié (`Invalid
  structured content returned by tool`).
- Tests des mainteneurs : intégration avec un vrai navigateur contre des pages locales
  (`browser-service/test/session_navigation.integration.test.js` ; la garde d'adresse n'y laisse passer 127.0.0.1 que
  par un module préchargé des essais, `browser-service/test/aides/`), écarts ramenés au Python dans
  `apps/toolhost/test/interop/browser-differentiel.test.ts`.

Actions et éléments, service `browser-service/` et famille `browser` de l'hôte :

- **Upload** : `pw_act(action="upload")` prend `files` : chemins du `/work` du compte, lus par l'agent de son bac
  avec la garde des outils fichiers (`path_outside_sandbox`, `file_not_found`, `not_a_file`, `file_too_large`,
  20 Mo et 10 fichiers au plus), ou objets `{name, content_base64, mime_type?}`. Le service ne reçoit que des
  contenus : il refuse tout chemin de la machine (`invalid_files`), `files_required` sans fichier. Le Python
  plantait (`Cannot read properties of undefined (reading 'buffer')`) faute de paramètre.
- **Cible comptée avant le geste** (`/action`, `/chain`) : aucune correspondance après 2 s (`PW_NOT_FOUND_GRACE_MS`,
  ou le `timeout` explicite de l'étape, qui peut allonger cette attente) → `element_not_found` aussitôt, avec
  `suggestions` (pw_act) ou `alternatives` (pw_chain) tirées de l'instantané ARIA de la page ; plusieurs → `matched` et `warning` (premier élément), ou refus `ambiguous_target` avec les
  `candidates` et leur `ref` quand `strict=true` ; `|nth=K` dans la cible choisit l'élément. Un nom passé avec un
  rôle est cherché entier (casse ignorée) avant la sous-chaîne (`name_match`). Une seule résolution pour tous les
  outils (`pw_find`, `pw_expect`, `pw_wait`, `pw_act`, `pw_chain`, captures d'élément) : nom entier d'abord, `nth`
  compté sur la liste retenue ; une même cible désigne donc le même élément partout (`pw_find` rend `name_match`, et
  `count-*` de `pw_expect` compte la liste retenue). Délai par défaut d'un geste commun
  aux deux (8 s, `PW_ACTION_TIMEOUT_MS`), sous les 10 s du client : le Python rendait `timeout_10s`.
- **`pw_find`** : rôle ARIA effectif (celui de `getByRole`, sinon explicite ou implicite du HTML), `name`,
  `checked`, `disabled`, `expanded` ; la valeur d'une case (« on ») n'est plus le texte.
- **Frames** : chaque iframe une seule fois dans `pw_page(frames)` et `text include_frames` (le Python les listait
  deux fois).
- **`pick`** rend `selected` comme `select`.
- **Codes d'erreur stables** : code fixe court sans donnée (`navigation_failed`, `option_not_found` avec la liste
  `options`, `element_not_found`, `timeout`, `internal_error`, `unknown_action`, `unknown_condition`,
  `service_error`, `invalid_response`, sinon `browser_error`) au lieu du slug tronqué du message
  (`navigation_chou_e_vers_…`) ; le service code ses erreurs et l'hôte garde ce code et le contexte joint
  (`suggestions`, `candidates`, `options`…) quel que soit le statut. Séquences ANSI retirées des messages.
- **Chemins du serveur masqués** dans toute réponse du service : dossier du service rendu relatif
  (`screenshots/fail_….png`, `downloads/<compte>/page_….pdf`), dossier personnel en `~`.
- Tests des mainteneurs : `browser-service/test/actions_elements.integration.test.js` (Chromium, pages servies par les simulations
  de la session), `result_util.test.js`, `apps/toolhost/test/browser-actions.test.ts`, vecteurs adaptés
  (`packages/navigateur/test/client.test.ts`, `CODES_TS`) et `ecartsVoulus` du différentiel
  `apps/toolhost/test/interop/browser-differentiel.test.ts`.

## Pages web

- **CSP** posée sur `/` et `/admin` selon `security.csp` (`enforce` par défaut, `report-only`, `off`), relue sans
  redémarrage ; voir [configuration.md](configuration.md).
- **Aperçu HTML** servi par `GET /apercu-code`, avec sa propre politique (indépendante de `security.csp`).
- **Lien vers la console** (`admin_url` de `/api/public-config`, redirection de `/admin`) : quand le core n'écoute
  que la boucle locale et que la requête arrive en HTTPS par un frontal (`X-Forwarded-Proto: https`), sans URL
  publique explicite, le lien prend les ports du frontal (`security.https.admin_port`, 8443) ; le Python renvoyait
  vers le port direct 8002, injoignable depuis le réseau.

## Avatar de l'assistant et logo de l'application

- **Avatar de l'assistant** : partout le logo de l'application, chargé par l'administrateur dans Console › Instance
  › Identité › Logo (`app_info.logo_b64`), sinon le logo d'Elpis (`static/elpis-256.png`) : bulles du chat, avis de
  compaction, page Code, panneau latéral, « À propos ». Plus d'icône Phosphor pour l'agent.
- **Réglages du compte** : `assistant_icon` et `assistant_avatar` ne sont plus acceptés par `PUT /api/settings` ni
  rendus par `GET /api/settings` (les valeurs stockées restent en base, ignorées). Paramètres › Apparence ne garde
  que le nom de l'assistant.
- **`POST /api/settings/assistant-avatar`** : gardée pour l'inventaire des routes et les contrats, refusée en 403 pour
  tous ; rien n'est déposé, les fichiers `bot_<uid>_<n>.<ext>` déjà déposés sont conservés (et toujours servis).
- **Logo servi à part** : `GET /api/app-logo` (main et admin, public ; PNG, JPEG, GIF, WebP ou SVG seulement,
  `nosniff`, CSP bac à sable), à l'adresse à empreinte `app_logo_url` de `/api/public-config`.
- **Recadrage à l'import** (propre au TS) : la photo de profil et le logo passent par une fenêtre de recadrage ; le
  navigateur envoie une image carrée de 512 px (PNG s'il reste de la transparence, WebP sinon).
- Tests des mainteneurs : `apps/core/test/ecart-avatar-assistant.ts` (vecteurs des réglages rejoués avec l'écart), `comptes.test.ts`,
  `interface.test.ts`, `tests/frontend/reel/avatar-reel-verify.mjs`.

## Apparence : contraste des skins livrés et préférence d'interface

- **Jetons d'état et d'accent** relevés au contraste AA (texte 4,5:1, icônes 3:1) : vert d'Elpis (olive plus
  foncé), bouton principal et texte d'accent de Parchemin, texte d'accent de Pingouins (clair ; le sombre garde le
  rose éclairci). `GET /api/skins/<id>/skin.css` sert ces valeurs ; le reste des feuilles est inchangé.
- **Affichage du chat** (propre au TS) : `chat_workflow`, `context_display`, `thinking_display`, `footer_metrics` et
  `thread_density`, valeurs fermées (une valeur inconnue n'est pas enregistrée), préférences du compte acceptées par
  `PUT /api/settings` (pas depuis la console) ; absentes du document tant que le compte ne les a pas choisies.
  La préférence « Interface classique » (`classic_ui`) n'existe plus : la clé n'est plus écrite.
- **`hide_web_screenshots`** (propre au TS) : « Masquer les captures web » (Paramètres › Chat), même traitement ;
  cache les captures du navigateur dans le fil, l'outil continue de les prendre.
- Tests des mainteneurs : `apps/core/test/ecart-contraste-skins.ts` (vecteurs des skins rejoués avec l'écart),
  `apps/core/test/affichage-chat.test.ts`, `frontend/test/css/contraste.test.ts`.

## Sous-agents (`task`)

Le Python donnait au sous-agent des familles d'outils entières, rendait son seul texte final (`state="completed"`
même après un plafond) et exécutait les `task` d'un message l'un après l'autre. Le TS :

- **Aucune imbrication** : le Python donnait `task` à un sous-agent quand `llm.task.subagent_depth` (1 à 3) le
  permettait. Le TS ne le donne jamais, quel que soit ce réglage (lu, sans effet) : `task` est absent du manifeste
  d'un sous-agent, et un appel `task` venu d'un sous-agent est refusé par le core et par l'hôte d'outils
  (`not_available_here`).
- **Profils par type** (`packages/securite/src/sous-agent.ts`, même règle pour le manifeste du core et l'hôte
  d'outils) : `shell_job` jamais offert ; `verify` sans `write_file`, `edit_file`, `manage_files` ni git d'écriture ;
  `implement` sans `git_commit`, `git_submit`, `git_start_work`, `git_abandon` ; `execute_shell` sans les paramètres
  `on_timeout` ni `background` : rien ne doit survivre au sous-agent. `detach_and_wake` passé quand même retombe sur
  `kill` avec `on_timeout_fallback` ; `background=true` est refusé (`not_available_here`) ; le shell reste plafonné
  à 300 s. L'agent principal garde `background`.
- **Lecture seule** : seuls les outils annotés `readOnlyHint` (et les `pw_*` du seul serveur d'outils intégré, pas
  ceux d'un serveur MCP tiers) restent ; ni écriture, ni commit, ni job, ni shell. Effective = imposée par l'administrateur, OU `task(read_only=true)`, OU case du compte (si posée,
  sinon défaut de l'administrateur : `explore` et `web` vrais). Réglages : section `agents` de config.json,
  `GET/POST /api/admin/agents`, `read_only` d'une entrée de `custom_agents`.
- **Limite assumée : le shell n'est pas borné.** La lecture seule retire le shell entier : un `verify` en lecture
  seule ne lance aucun test (il décrit ce qu'il aurait lancé sous « Left open », `Status: blocked`). `writable_paths`
  ne borne que les outils de fichiers (`write_file`, `edit_file`, `manage_files`, `git_write`), pas le shell : le
  bloc le dit (`writable_paths_scope: "file_tools_only"`). Le « pas de commit » d'`implement` retire `git_commit`,
  `git_submit`, `git_start_work` et `git_abandon`, mais ne tient pas face au shell : `git commit` y reste possible
  et seule la consigne l'interdit. Le bac à sable du compte reste la vraie frontière de sécurité ; ni shell borné ni
  hook git ne sont posés.
- **Défense en profondeur** : le core porte `subagent: {type, read_only, writable_paths, id, browser_session}` dans le `_meta` des appels
  locaux (champ facultatif de l'enveloppe d'identité, absent pour un tour de premier niveau : forme signée
  inchangée) ; l'hôte d'outils refuse ce qui sort du périmètre (`read_only_subagent`, `not_available_for_subagent`,
  `not_available_here`, `path_not_writable`) avant d'exécuter l'outil, puis vérifie `writable_paths` sur le chemin
  résolu par l'agent du bac (liens internes suivis, ancien rangement `git_repos/` de `git_write`).
- **Mode fork** (propre au TS) : paramètre `context` (`fresh` par défaut, `fork`) et note 7 de la description
  publiée. Le fork reprend les messages du dernier appel du parent et son catalogue d'outils (mêmes définitions,
  même ordre) : les restrictions de l'enfant sont appliquées à l'exécution (`perimetreEnfant`), pas par le
  manifeste. Détail : [architecture](architecture.md#sous-agents-outil-task).
- **Paramètres de `task`** : `read_only`, `max_iterations` (borné par le type), `max_seconds` (arrêt propre avec
  synthèse avant la limite), `writable_paths` (préfixes du bac, appliqués par `write_file`, `edit_file`,
  `manage_files` et `git_write` ; le shell n'est pas borné, le bloc le dit : `writable_paths_scope:
  "file_tools_only"`), `output_schema` (champs exigés dans le rapport ; manquants : `status: partial`),
  `browser_session` (`isolated` par défaut : session de navigateur propre à l'enfant, fermée par le harnais ; `user` :
  celle du compte, voir [architecture](architecture.md#sous-agents-outil-task)). Définition
  publiée : note 5 (parallélisme) remplacée, note 6 (bloc du harnais) ajoutée ; déclaré dans
  `apps/core/test/outils/integres/ecart-tache.ts`.
- **Bloc du harnais** (`schemaBilanTache`) : `<task_meta>{…}</task_meta>` avant `<task_result>`, ou champ `harness`
  des enveloppes d'erreur ; aussi à l'étape finale `task_step` et dans `task_runs[]` du message. Le JSON du bloc
  n'a ni `<` ni `>` (échappés en `\u003c`, `\u003e`) et les balises `<task…>` du rapport sont neutralisées
  (`&lt;task_meta`) : le sous-agent ne peut pas imiter le bloc. Statuts `done`,
  `partial`, `blocked` (lus sur la ligne `Status:` du rapport), `budget_exhausted`, `timeout`, `unavailable`,
  `error`, `cancelled` ; appels comptés par le harnais, cumul sur les reprises (`tool_calls_total`) et budget remis à
  zéro (`budget_reset`) ; fichiers modifiés, branche, commits et PR relevés sur les résultats d'outils ; branche
  relue en fin de run quand l'agent a appelé le shell ou un outil git (N2 : une branche créée par `git checkout -b`
  au shell n'était pas vue) : un seul `git_query(action="branches")` en lecture, sur le dépôt du dernier outil git
  (`repo`), sinon le `cwd` du shell ; échec ou dépôt inconnu : valeur relevée gardée ; erreurs ;
  `remaining_work` (section « Left open », demandée par la consigne de synthèse quand un budget s'épuise, masquée
  comme le rapport) ; `budget_warnings` (`[{at, text}]` : chaque `<harness_status>` envoyé à l'agent, `at` = appels
  faits à l'envoi, N6) ; `stop_reason: "budget_wrap_up"` quand l'agent conclut de lui-même en `partial` après un
  « Wrap up » ou « LAST » sans atteindre la limite (N7 ; `budget_exhausted` reste réservé à la limite atteinte). La
  carte du chat montre « arrêt sur budget » et, dans les détails, la cause en français et les avertissements.
- **Fenêtre de fin de budget** (`harnessStatusLine`, toute boucle) : le Python envoyait « only N left. Wrap up… Do
  not start anything new » dès 5 itérations restantes, quel que soit le budget ; avec `max_iterations=10`, cet ordre
  tombait à 5/10, en même temps que le jalon de mi-parcours, et l'agent concluait à la moitié. Le TS réduit
  cette fenêtre au quart d'un budget de moins de 20 (`fenetreFinBudget` : 1 pour 4, 2 pour 10, 5 dès 20) : « Wrap up »
  ne tombe jamais avant les trois quarts ; les jalons de 50 % et 75 % gardent le texte de plan. Budgets de 20 et plus
  (défaut 100) : textes et jalons inchangés. Vecteurs Python rejoués avec l'écart déclaré
  (`apps/core/test/boucle/ecart-budget.ts`).
- **Étapes `task_step`** : chacune porte le `call_id` de l'appel `task` du parent (le chat rattache la ligne par
  lui, jamais au premier run sans id) ; un refus avant lancement (`task_unavailable`, `bad_args`, type inconnu…)
  émet une étape finale (`state: "failed"`, `child_id` vide, bloc `status: unavailable` ou `error` avec `reason`)
  qui ferme la ligne, et le run est gardé dans `task_runs[]`.
- **Parallélisme** : les `task` consécutifs d'une même réponse partent ensemble, `agents.max_parallel` à la fois (1
  à 10, défaut 3, relu à chaud, plafonné à `total_slots − 1` sur llama.cpp ; `LLAMA_TOOL_PARALLELISM` ne les bride pas) ; le bloc liste les autres runs du
  compte qui ont tourné en même temps (`overlapped_with` : sous-agents de tout chat, `chat:<id>` d'une boucle de
  premier niveau autre que la parente).
- **Fichiers modifiés sous parallélisme** (N1) : le shell relève tout le bac du compte, pas les seules écritures de
  l'agent. `files_changed` ne garde que les fichiers sûrs : écrits par les outils de fichiers ou git de l'agent
  (`write_file`, `edit_file`, `manage_files`, `git_*`), ou relevés par son shell sans qu'aucun autre run du compte
  capable d'écrire n'ait été actif pendant la commande. Les autres partent dans `files_changed_candidates`, avec
  `files_changed_attribution: "uncertain"` et `overlapped_with`. Un sous-agent en lecture seule (sans outil
  d'écriture ni shell, `explore` par défaut) a toujours `files_changed: []`. Les runs sont suivis en mémoire par le
  processus du core (`debutTrace`, `debutBoucle`, `chevauchements` de `bilan-taches.ts`) : un autre processus du
  core, le terminal, l'éditeur ou un job détaché ne sont pas vus. La carte montre les fichiers sûrs, puis les
  candidats sous « Peut-être modifiés par un autre agent ».
- **Contrôles avant lancement** : `web` sonde le service navigateur (`pw_session(action="health")`) et rend
  `task_unavailable` sans lancer l'agent ; un sous-agent `pr` voit `git_start_work` et `git_commit` refuser
  (`no_remote`) un dépôt sans `origin`, avant de brancher ou de committer.
- **Consignes et rapport** : bloc `<subagent_rules>` dans le prompt système (sous-agent, réveil impossible, délai du
  shell 120 s par défaut et 300 s au plus, 4 caractères d'un secret au plus, gabarit commun Status / Answer /
  Evidence / Changes / Left open), identique d'un appel à l'autre ; la lecture seule ou les chemins écrivables, la
  date, le budget et les champs exigés vont dans `<task_context>`, en tête du premier message user (écart au Python,
  qui les mettait dans le système : tête byte-stable, cf. [architecture](architecture.md#sous-agents-outil-task)) ;
  `verify` lance son shell avec
  `PYTHONDONTWRITEBYTECODE=1` et `PYTEST_ADDOPTS="-p no:cacheprovider"`, `implement` avec
  `PYTHONDONTWRITEBYTECODE=1` seul (N9 : plus de `__pycache__` laissé en important un module) ; le `fix` d'un délai dépassé n'oriente plus
  vers `shell_job` ; `disk_warning` retiré des résultats vus par un sous-agent ; secrets du rapport masqués par la
  recherche de `git_commit` (déplacée dans `@elpis/securite`) ; rapport rendu plafonné à 8 000 caractères, texte
  complet sauvé dans `/work/.tool-output/task-<id>.md`.
- **Persona et lecture seule** (N8) : en lecture seule, `<task_context>` dit que les outils d'écriture, de commit
  et le shell décrits par la persona ne sont pas offerts, et qu'un besoin de changement ou de commande se
  décrit sous `## Left open` avec `Status: blocked` ; les personas `implement` et `verify` renvoient à ce bloc, celle
  de `pr` ne dit plus que les outils d'écriture sont toujours dans le manifeste.
- **Réflexion des sous-agents** (propre au TS) : réglée par type
  (`agents.thinking.defaults`, `off` / `on` / `inherit`, défauts `implement` et `verify` `on`, `custom` `inherit`),
  par agent du compte (`thinking` d'une entrée de `custom_agents`, prioritaire) et la borne par
  `agents.thinking_budget_tokens` ; elle n'est effective que si le moteur l'honore (llama.cpp : gabarit du modèle ;
  vLLM et SGLang : toujours), est calculée une fois au lancement de l'enfant, et pose `preserve_reasoning` pour
  l'enfant seulement avec SGLang. Un enfant qui ne réfléchit pas perd `reasoning_effort`, `thinking_budget_tokens` et
  `preserve_reasoning` de l'agent principal. Le bilan `<task_meta>` porte `thinking` (réflexion demandée) et l'étape
  finale `think_tokens` (jetons mesurés) ; `GET /api/settings/agent-templates` rend `thinking_policy`.
- **`GET /api/settings/agent-templates`** rend en plus `read_only_default` et `read_only_forced` par modèle et
  `read_only_policy` ; les personas `system_prompts/AGENT_TASK_*.md` ne disent plus que les outils d'écriture sont
  dans le manifeste (le différentiel des réglages compare les en-têtes et la forme de cette route, plus son corps).
- Tests des mainteneurs : `apps/core/test/outils/integres/{sous-agents,taches-agents,taches-bornes,controles-taches}.test.ts`,
  `apps/core/test/boucle/{dispatch-outils,orchestrateur}.test.ts`, `apps/toolhost/test/sous-agents.test.ts`,
  `packages/securite/test/sous-agent.test.ts`, `packages/outils-mcp/test/serveur.test.ts`,
  `packages/contracts/test/core/admin-agents.test.ts`, `frontend/test/chat/coeur/coeur.test.ts`,
  `frontend/test/chat/outils/bilan-sous-agent.test.ts`,
  `tests/frontend/reel/sous-agents-reel-verify.mjs`.

## Agent du bac (Python)

L'agent du bac reste en Python. Trois exceptions à la règle « pas de correctif Python » ont été accordées :

- le git de l'agent neutralise les réglages qui lancent un programme (`core.sshCommand`, `core.editor`,
  `sequence.editor`, `gpg.program`, `gpg.ssh.program`) et passe `--no-ext-diff --no-textconv` aux commandes qui
  rendent un diff ;
- routes `/v1/jobs/*` (`start`, `status`, `kill`, `list`, `watch`) des tâches de fond ; les motifs `wake_on` sont
  évalués hors du processus de l'agent ;
- liens, fichiers spéciaux et profondeur des tâches de fond, trois points :
  - `/v1/stat` et `/v1/list` précisent un fichier spécial (`kind: "other"`, inchangé pour les hôtes qui filtrent
    sur ce genre) par `special` : `fifo`, `socket`, `char_device` ou `block_device`, lu dans `S_IFMT` de `lstat`
    (de `stat` pour un lien suivi), sans jamais ouvrir le fichier. L'hôte affiche `fifo`, `socket` et `device`.
  - `/v1/changes/begin` accepte `all_kinds` : le relevé garde aussi les liens (texte lu par `readlink` relatif au
    dossier ouvert, jamais suivis ; au-delà de 256 caractères, le début et une empreinte) et les fichiers spéciaux
    (genre seul). `/v1/changes/end` les rend avec `kind` et `before` / `after` = `{"kind"[, "target"]}` ou
    `{"state": "absent"}` ; un lien recréé avec la même cible, une FIFO recréée ne sont pas des changements. Mêmes
    bornes que les fichiers (`max_entries`, délai, `max_files`) ; sans `all_kinds` (ancien hôte), rien ne change.
  - `/v1/jobs/start` accepte `chain_depth` (profondeur du tour qui lance le job, entier de 0 à 1000) : gardée dans
    la fiche du job (elle survit à une relance de l'agent) et écrite dans chacun de ses événements de
    `.bg/jobs-events.ndjson`. Absente (ancien hôte) : aucun champ, la profondeur reste inconnue plutôt que 0.

L'agent est monté depuis le dépôt : après une mise à jour, l'hôte d'outils le relance au premier appel quand son
empreinte change.
