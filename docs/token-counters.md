# Compteurs de tokens — sémantique et sources de vérité

Chaque compteur de l'app répond à une question DIFFÉRENTE. Les confondre
donne des « incohérences » qui n'en sont pas (ex : l'onglet Utilisation
affiche plus de tokens d'entrée qu'un chat n'en contient — normal, voir
« tokens soumis »). Ce document est la référence ; les tooltips UI en
reprennent les libellés.

## Table de vérité

| Compteur | Question | Source | Estimation ? |
|---|---|---|---|
| **Jauge ctx** (`liveGen`, event `kv_cache` unique par requête LLM) | « Combien de tokens le serveur a-t-il réellement traités à la dernière requête ? » | `usage.prompt_tokens` RÉEL du serveur, lu dans la réponse reçue en fin de requête (chaque itération de la boucle outils en pousse un) — **rien n'est estimé, rien n'est émis en pré-vol** ; jauge masquée tant qu'aucune requête n'a abouti | **jamais** |
| **Pill contexte figée par message** (`metrics.kv_cache`) | « Quelle était l'occupation à la fin de ce tour ? » | dernier réel serveur du tour figé au `final` ; fallback `last_prompt_tokens` — aussi POSÉE PAR LE SERVEUR dans les métriques persistées (`_ctx_usage_snapshot`), donc visible après rechargement | non |
| **Puce « ctx » au repos + re-seed de la jauge** (`meta_json["ctx_usage"]`) | « Où en est le contexte de ce chat avant de reprendre ? » (après F5 / redémarrage) | snapshot `{used,total,pct,model,ts}` écrit en fin de tour par `finalize_turn_meta`, relu par `GET /api/saved/chats/{id}` → `applyChatCtxUsage` ; effacé par une compaction manuelle | non |
| **`metrics.last_prompt_tokens`** | « Quelle taille faisait le DERNIER prompt envoyé ? » (= contexte fin de tour) | `usage.prompt_tokens` de la dernière itération llama.cpp — exposé aussi sur le chemin « limite d'outils » (synthèse comprise) ; la route ne retombe JAMAIS sur `input_tokens` pour le chemin outils (cumul ≠ occupation, cf. `_kv_gauge_used_tokens`) | non |
| **`metrics.input_tokens` / `submitted_input_tokens`** | « Combien de tokens ont été SOUMIS au modèle pour produire cette réponse ? » | somme des `usage.prompt_tokens` de TOUTES les itérations du tool loop | non (usage réel backend) |
| **`metrics.thinking_tokens` / `response_tokens`** | « Sur ce que le modèle a GÉNÉRÉ, quelle part est du raisonnement ? » | mesure de fin de tour : `reasoning_tokens` déclaré par le backend → `/tokenize` exact (llama.cpp local) → ratio mesuré (cf. `llm_core/_think_tokens.py`) | `thinking_tokens_estimated:true` sur le 3ᵉ cas (UI : « ≈ ») |
| **Onglet Utilisation** (`/api/usage/me`) et **zone Métriques admin** | « Combien de tokens ai-je / avons-nous soumis et reçus sur la période, et pour quoi ? » | agrégat `usage_events` : **une ligne par tour**, usage réel, `user_id` + `source` | non — et le split est TOUJOURS disponible (cf. ci-dessous) |
| **Compresseur** (`tokens_before/after`, `compression_start.tokens`) | « La conversation vaut-elle la peine d'être compressée, et qu'a-t-on gagné ? » | prompt RENDU (texte des messages) + forfait image + surcoût fixe tools (`extra_fixed_tokens`, passé par la boucle outils ; classic/route manuelle = 0) ; fallback heuristique unifiée | `tokens_estimated:true` dans les stats |
| **Budget de contexte** (`_enforce_context_budget`) | « Le prompt tient-il dans n_ctx ? » | `/tokenize` exact PAR message (granularité pour choisir quoi retirer ; forfait image + marge/msg inclus), budget réduit du surcoût fixe tools (`fixed_overhead_tokens`) | interne (marge conservatrice) |

## Le registre `usage_events` : un tour, une ligne, un propriétaire

Jusqu'à la refonte de la zone Métriques, la consommation était journalisée
**par l'appelant** dans `metric_events`. Trois défauts en découlaient, tous
constatés dans le code :

- **Double comptage.** Un tour outillé était journalisé par la boucle
  (`total_tokens`, `mode=mcp_native`) *et* par la route de chat (`mode=mcp`).
  L'onglet Utilisation s'en protégeait (il n'additionnait jamais total et
  input+output) ; le tableau de bord admin, lui, sommait naïvement.
- **Angle mort.** Routines, webhooks et sous-agents ne passent pas par la
  route : leur consommation n'atteignait aucun agrégat (`task_child_tokens`
  n'était lu par aucun widget). La génération de titre et l'appel du
  compresseur n'étaient mesurés nulle part non plus.
- **Modèle faux.** La boucle taguait `LLAMA_MODEL` — une constante de
  configuration — au lieu du modèle réellement ciblé : toute répartition par
  modèle mentait dès qu'un connecteur externe servait le tour.

La mesure est donc faite **dans la boucle**, une seule fois, avec le contexte
(`source`, `user_id`, `origin_id`) posé par l'appelant via `usage_scope(...)`.
Le split entrée/sortie est toujours connu (la boucle a `cumul_in`/`cumul_out`),
donc le flag `estimated` de l'onglet Utilisation a disparu. Les tokens de cache
Anthropic sont cumulés sur le tour et stockés à part — ils ne sont PAS inclus
dans `input_tokens`.

## La sortie se lit en deux : réflexion et réponse

`completion_tokens` est un total qui **additionne trois choses** : le
raisonnement, les appels d'outils et le texte visible. Aucun backend local ne
les sépare — llama.cpp ne connaît que le total. Sur un modèle « thinking », la
réflexion peut donc représenter l'essentiel du coût de sortie d'un tour sans
qu'aucune vue ne puisse le nommer : « pourquoi ce tour a-t-il coûté 8 000
tokens de sortie ? » n'avait pas de réponse.

`llm_core/_think_tokens.py` produit ce chiffre manquant, **une fois par tour**,
avec un ordre de vérité explicite (même idiome que le reste des comptages :
exact d'abord, repli portable) :

1. **Déclaré** — `usage.completion_tokens_details.reasoning_tokens` (o-series,
   vLLM récents). Exact, gratuit. En mode outils, cumulé sur les itérations :
   ne lire que la dernière sous-compterait tout ce qui a été pensé avant les
   appels d'outils.
2. **Tokenisé** — `POST /tokenize` sur le texte du raisonnement, gaté sur
   `is_local_llamacpp` comme tous les endpoints du moteur intégré (le tokenizer
   local ne dirait rien de juste du texte produit par un AUTRE modèle).
3. **Estimé** — ratio chars/token mesuré pour ce modèle. Signalé
   (`thinking_tokens_estimated`), affiché « ≈ » dans l'UI.

**Invariant : réflexion ⊆ sortie.** Ce n'est jamais un troisième poste à
additionner — c'est une découpe. « Réponse » (texte visible + appels d'outils)
se dérive par `output_tokens − thinking_tokens`, et la borne est posée à
l'écriture (`record_usage`) pour qu'elle soit vraie EN BASE et pas seulement
dans la vue qui l'a calculée : une estimation trop généreuse rendrait sinon la
réponse négative. Les totaux `input + output` des vues existantes restent donc
justes sans modification.

Ce qui rend la décomposition légitime : le raisonnement **n'est pas
re-soumis**. La boucle outils ne garde pas `reasoning_content` dans
`working_messages`, et `save_chat` strippe `thinking`. Ces tokens ne pèsent
donc QUE sur la sortie du tour où ils ont été produits — jamais sur l'entrée du
tour suivant.

**Corollaire : le raisonnement ne se compte JAMAIS dans un budget de contexte.**
Un raisonnement long ne prive la conversation d'aucune place. Deux endroits le
faisaient pourtant, et tous deux le sanctionnaient :

- la **règle d'overflow** prenait `prompt_tokens + completion_tokens` comme
  occupation → 20 k de réflexion déclenchaient une compaction pour une
  occupation qui n'existerait pas au tour suivant (cf. plus bas) ;
- l'**auto-reprise** (`_think_resume.should_auto_resume`) refusait quand
  `last_prompt_tokens + thinking cumulé + marge ≥ n_ctx`. Or le prompt d'un
  segment de reprise CONTIENT déjà ce raisonnement : l'addition le comptait
  deux fois et posait le mur vers la MOITIÉ de la fenêtre réelle. La garde
  porte désormais sur `window_tokens` — l'occupation mesurée en fin de segment
  (`prompt + completion`), c'est-à-dire ce que le serveur a réellement en KV.

Cette dernière garde reste, mais elle ne parle plus de « contexte saturé » :
c'est la **fenêtre d'inférence** du moteur, une limite physique (llama.cpp ne
génère pas au-delà de son n_ctx). Quand elle est atteinte, reprendre coûterait
un prefill complet pour quelques tokens — on rend la main à la bannière
« Continuer ». Le seul autre plafond est un garde-fou anti-emballement
(`LLAMA_THINK_RESUME_MAX` reprises, `LLAMA_THINK_RESUME_TOTAL_TOKENS` = 131 072
de raisonnement cumulé), pas une contrainte de contexte.

Surfaces : puce « réflexion » (icône cerveau) de la ligne métriques d'un message (+ infobulle détaillée),
Réglages → Utilisation (découpe sous « Sortie »), Administration → Métriques
(KPI « Réflexion » + frise « Sortie — réflexion vs réponse »). Colonne
`usage_events.thinking_tokens` (migration 0014) — **pas de backfill** :
l'historique n'a jamais porté l'information et le texte du raisonnement n'est
pas persisté. Les tours antérieurs comptent 0, et les vues disent « — » plutôt
que « 0 % » pour ne pas affirmer une absence de raisonnement qu'elles ne
peuvent pas constater.

## Pourquoi « tokens soumis » ≠ « occupation du contexte »

En mode outils, chaque itération de la boucle re-soumet l'historique complet
(system + tours + tool_results) : 3 itérations sur un prompt de ~2 000 tokens
= ~6 000 tokens **soumis** (c'est ce que facture une API, avec ou sans remise
cache) pour une **occupation** finale de ~2 500. Les deux nombres sont vrais.
L'UI les étiquette « Tokens soumis (cumul outils) » et « Contexte fin de
tour » (tooltip de la ligne métriques du message).

## Comptage exact : prompt RENDU par le template

Base commune des comptages exacts :
`count_rendered_prompt_tokens_exact` (`llm_core/_llama_http.py`) demande à
llama-server de RENDRE le prompt exactement comme pour `/v1/chat/completions`
(`POST /apply-template` : tokens spéciaux `<|im_start|>`/`<|im_end|>`, prompt
de génération, embedding des tools) puis le tokenise avec `add_special` (BOS).

**Pourquoi** : l'ancien comptage sommait le `/tokenize` de chaque message
sérialisé en texte brut + un forfait fixe/message. Il RATAIT la structure du
chat template → sous-comptait system + tools de façon systématique (biais
« les compteurs ne comptent que l'output »). Le comptage par message ne sert
plus que de **fallback portable** si `/apply-template` est absent (vieux build
llama.cpp) ; les blocs image (non tokenisables) ajoutent leur forfait par-dessus
(`image_forfait_tokens`, helper partagé `_token_estimate`).

**Composition par consommateur** (mêmes briques, assemblées pareil) :

- **Jauge** : AUCUN comptage — elle lit `usage.prompt_tokens` réel dans la
  réponse du serveur (fin de requête). Le rendu exact ne sert plus à
  l'affichage.
- **Porte de compression** : rendu exact des messages (sans tools embarqués)
  + forfait image + surcoût fixe tools compté séparément une fois par run et
  passé par la boucle outils (`extra_fixed_tokens`). La route manuelle passe
  0 (pas de `tools_payload` dans son contexte).
- **Fit budget** (`_enforce_context_budget`) : comptage PAR message — il lui
  faut la granularité message-par-message pour choisir QUELS anciens tours
  retirer (+ réserve de sortie = cap de génération effectif) ; le surcoût
  fixe tools est soustrait du budget (`fixed_overhead_tokens`). Marge de
  quelques tokens/message vs le rendu (conservatrice, voulue).
- **Règle unique d'overflow** (harnais v4, M3 — remplace la pré-porte) :
  la compaction part quand `occupation ≥ usable = n_ctx − cap de génération
  − buffer`. Occupation par ordre de vérité : mesure RÉELLE du dernier appel
  (`usage.prompt_tokens` **seul**) + delta des messages apparus depuis
  (ratio mesuré) ; sans mesure, estimation au ratio mesuré CONFIRMÉE par un
  comptage exact avant d'agir (l'occupation exacte est ancrée — jamais un
  comptage par itération). Ni pourcentage, ni marge, ni cooldown.
  **`completion_tokens` n'entre pas dans l'occupation**. Deux raisons : le raisonnement qu'il contient
  est éphémère — jamais re-soumis, donc il ne pèse RIEN sur le contexte de
  travail — et sa part visible est déjà recomptée par le delta, le message
  assistant étant ajouté à `working_messages` APRÈS la mesure.
- **Élagage des sorties d'outils** (`select_prune_keys` + `apply_prune_marks`) :
  sélection en tokens EXACTS (fenêtre protégée 20 % du n_ctx + 2 derniers
  tours), marques persistées dans `meta_json["ctx_pruned_keys"]`, rendu par
  marqueur plein.
  La sélection tourne AUSSI **pendant** le run (cadence
  `run_profile.prune_every_iters`) et les marques sont appliquées par
  `fit_context` à chaque itération. Avant, elle n'avait lieu qu'en fin de tour
  et n'était rendue qu'au tour SUIVANT : un run de plusieurs centaines
  d'itérations n'élaguait donc jamais rien et n'avait plus que le budget dur —
  qui JETTE des messages entiers au lieu d'effacer des sorties récupérables.
  Intra-run, la monotonie s'appuie sur `already_marked` (le contenu de
  `working_messages` est encore plein : on ne le mute jamais).
- **Ancre de tâche** (`task_anchor_index`) : le budget dur ne retire JAMAIS le
  dernier `user` non éphémère — la demande qui a déclenché le run. Elle reculait
  dans la liste au fil des cycles d'outils et finissait droppable : l'agent
  gardait son dernier `grep` et avait oublié ce qu'on lui demandait. Relâchée
  si elle pèse > 15 % du budget (pièce jointe géante).
- **Fenêtre de contexte par CIBLE** (`llm_core/_ctx_window.py`) : sur connecteur
  distant, le `/props` local décrivait un autre modèle — ou rien, et `ctx=0`
  mettait tout le pipeline en veille. Résolution : connecteur > famille connue >
  `LLM_REMOTE_N_CTX` > 0 (tracé).

## Ratio MESURÉ (harnais v4 — plus d'heuristique statique dans les décisions)

`llm_core/context/tokens.py` : ratio **chars/token MESURÉ par modèle** (EWMA
alimentée par chaque réponse réelle : chars du prompt envoyé ÷
`prompt_tokens` facturés ; amorce froide 3,3, bornes [1.5, 8]). Tous les
seuils de l'app sont en TOKENS ; les longueurs de chaîne ne sont plus que
des MATÉRIALISATIONS (`tokens_to_chars`, coupes d'émission, budgets du
sérialiseur) — la variante `tokens_to_chars_stable` (amorce figée) sert aux
caps ré-évalués sur du contenu stocké (filet sanitize, plancher desktop),
pour que le rendu reste byte-stable. Dès que `/tokenize` répond, le compte
est exact ; un compte partiellement estimé reste flaggé `tokens_estimated`.
(La jauge, elle, n'a plus de mode estimé du tout.)

## Cas particuliers connus (assumés)

- **Thinking** : compté dans `output_tokens` du tour qui le génère, mais
  strippé de l'historique persisté → il n'apparaît PAS dans le prompt du
  tour suivant. La jauge l'exclut volontairement (sinon « 4,7k en fin de
  tour » vs ~800 au prompt suivant).
- **Anthropic** : `input_tokens` ne compte que les tokens neufs ;
  `cache_read/creation_input_tokens` sont exposés séparément dans les
  metrics (« Cache : X lus / Y créés » dans le tooltip). La jauge de
  contexte reste masquée pour les cibles distantes (pas de `/tokenize`
  fiable, tokenizer local ≠ tokenizer distant).
- **`prompt_n` (timings llama.cpp)** : n'alimente PLUS rien côté contexte —
  avec le prefix-cache il ne compte que les tokens réévalués (excluait
  system + tools + tours cachés). Les timings ne servent qu'aux métriques
  de débit.
- **Jauge = réel seul, en fin de requête** (décision de conception) : plus
  aucune émission pré-vol (ni `/apply-template` ni heuristique, l'ancien
  flag `est`/« ≈ » a disparu) — un event `kv_cache` unique par requête LLM,
  construit depuis l'usage réel de la réponse. Pendant la toute première
  requête d'un chat (ou après une compression manuelle), la jauge est
  masquée : afficher rien plutôt qu'imaginer. Le contenu généré au tour N
  apparaît dans le `prompt_tokens` réel du tour N+1.
- **Continue** : la reprise re-soumet le tronc du tour précédent → les
  tokens soumis du tour de reprise incluent ce re-prefill (fidèle à la
  réalité API) ; il n'est pas compté deux fois à l'affichage.
