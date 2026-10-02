# Historique du cœur

Journal des décisions du cœur du harnais : pour chaque règle que le code
applique, la date et l'origine du constat, ce qui se passait avant, et la règle
retenue. Le code ne garde que le « pourquoi » actuel, au présent ; l'histoire
d'une règle vit ici et dans les messages de commit (`AGENTS.md`, « Code
Python »).

Format d'une entrée : `date — origine — constat → règle retenue (symbole)`.
Les entrées sans date consignée sont regroupées en fin de section. Les sections
portent le nom du fichier où la règle a été écrite ; la table du découpage
ci-dessous indique où le code vit aujourd'hui.

## Découpage du cœur, première étape (2026-10-01)

### Pourquoi

Deux fonctions géantes portaient le cœur. La boucle agentique tenait dans
`_run_chat_multi_mcp_impl` : 3 745 lignes, dans un `llm_core/_chat_with_tools.py`
de 7 204 lignes. Le flux de chat tenait dans le handler
`api_chat_saved_stream3` : 2 298 lignes, dans un `chatbot_app/routes/chats.py`
de 4 616 lignes, avec deux fermetures imbriquées, `gen()` (le générateur
NDJSON) et `worker()` (le tour lui-même).

Leurs étapes communiquaient par des dizaines de variables locales, lues et
réaffectées par des fermetures. Aucune étape ne se lisait seule ni ne se
testait sans faire tourner le tour entier. Les deux canaux d'exécution des
outils (natif et texte) se recopiaient en grande partie (préparation du lot,
post-traitement, anti-boucle) : une correction était souvent à faire deux
fois.

Les tests visaient les points d'accès de ces deux fichiers
(`_chat_with_tools.<nom>`, `chats.<nom>`) plutôt que le comportement. Ils
figeaient l'emplacement du code : déplacer une fonction cassait des dizaines
de tests, ou laissait un patch sans effet dans un test qui passait encore.

### Principes

- **Comportement identique.** Mêmes requêtes au moteur, mêmes événements,
  même enregistrement : le découpage ne change rien de visible.
- **Goldens d'abord.** Avant tout déplacement, la boucle et la route ont été
  figées de bout en bout, par scénario : `tests/goldens/boucle_*.json`
  (21 scénarios : un outil, lots natif et texte, appels illisibles, perdus ou
  vers un outil inconnu, troncatures, reprises, hoquet du moteur, réponses
  vides, mur d'horloge, porte de compaction, élagage en cours, erreur fatale)
  et `tests/goldens/flux_route_*.json` (10 scénarios : classique, outils, chat
  neuf, « Continuer », panne, conflit, Stop pendant l'attente ou la
  génération, run détaché, run reprenable). Aucun n'a changé pendant le
  découpage.
- **Pas de réexport de transition.** Un nom déplacé ne se lit plus dans son
  ancien module : importeurs et tests visent le module propriétaire. Seule la
  façade `llm_core` garde ses noms (instantané
  `tests/llm_core/facade_llm_core.json`), hors les alias retirés listés plus
  bas.
- **Seams.** L'orchestrateur lit dans ses globales, au début du run, la
  fonction de flux (`_llama_chat_with_tools_stream`) et la métrique d'appel
  d'outil (`_record_tool_call_metric_safe`), puis les injecte dans les
  sous-routines (`LoopDeps`) : ces deux noms se patchent sur
  `llm_core._chat_with_tools`. Tout autre nom se patche sur le module qui le
  lit (`tests/llm_core/test_seams_effectifs.py` refuse un patch sans effet).
- **Compteurs à l'orchestrateur.** `effective_iter` et `hard_iter` restent des
  entiers de la boucle. Les sous-routines rendent une issue (`LLMTurn`,
  `BatchOutcome`, reprise programmée, arrêt sur coupes en série) que la boucle
  applique. Pas de classe « boucle » : elle ne ferait que déplacer les mêmes
  variables.
- **Commentaires au présent.** Les commentaires d'audit des fichiers touchés
  sont retirés du code ; leur historique est dans les sections ci-dessous,
  sous le nom du fichier d'origine.

### Où vit le code

Boucle agentique, ancien emplacement `llm_core/_chat_with_tools.py` (chemins
du module actuel relatifs à `llm_core/`) :

| Symboles | Ancien emplacement | Module actuel |
|---|---|---|
| `run_chat_multi_mcp`, `run_chat_multi_mcp_v2`, `_run_chat_multi_mcp_wrapper`, `_record_cancelled_run_usage`, `_RUN_USAGE_ACC`, `_harness_status_line`, `_sandbox_limits_text`, `_todo_status_reminder`, `build_task_builtin_tool` ; dans `_run_chat_multi_mcp_impl` : prélude, boucle, compteurs, aiguillage de chaque tour | `_chat_with_tools.py` | `_chat_with_tools.py` (l'orchestrateur, ~1 040 lignes) |
| lecture des appels écrits en texte : `_clean_json_text`, `_strip_tool_call_markup`, `_looks_like_pure_tool_call_text`, `_recover_tool_calls_from_reasoning`, `_TOOL_MARKUP_TRACE_RE` | `_chat_with_tools.py` | `_tool_parsing.py` |
| `_result_is_tool_failure` | `_chat_with_tools.py` | `engine/result_contract.py`, sous le nom `result_is_tool_failure` |
| catalogue d'outils : `_collect_mcp_tools`, `_expand_builtin_configs`, `_apply_memory_gate`, `_tool_name`, `_MEMORY_TOOL_NAMES` | `_chat_with_tools.py` | `engine/tool_catalog.py` |
| transport d'un appel LLM : `_llama_chat_with_tools_stream`, `_resume_cut_stream`, `_keep_resumed_text`, `_fire_cancel_stream`, `_CANCEL_TASKS`, `_reasoning_guard`, `_reasoning_cap_chars`, `_publish_completion`, `_endpoint_base`, `_skipping` | `_chat_with_tools.py` | `engine/llm_stream.py` |
| un appel d'outil : `_execute_single_tool_call`, `_build_call_meta`, `_prefetch_desktop_frame`, `_ensure_local_asset`, `_tool_timeout_s`, `_tool_timeout_json`, `_TOOL_QUEUE_WAIT_S`, `_TOOL_TIMEOUT_DEFAULTS` ; décodage : `pick_tool_payload`, `_content_block_text`, `_tool_is_internal` ; métriques : `_record_tool_call_metric_safe`, `_TCM_UID_CACHE` ; enrichissement des événements : `_desktop_event_extra`, `_populate_desktop_frame`, `_files_event_extra`, `_write_event_extra`, `_changed_files_of`, `_noter_fichiers`, `_noter_attente`, `_truthy_arg`, `_SHA_RE`, `_DESKTOP_EVENT_KEYS` | `_chat_with_tools.py` | `engine/tool_dispatch.py` |
| anti-boucle : `_action_cycle_signature`, `_detect_action_cycle`, `_CYCLE_ARG_KEYS`, `_CYCLE_HARDSTOP_MAX`, et les locaux de la série (tampon, détections, `_CYCLE_DECAY_ITERS`) devenus `CycleGuard` ; appels coupés : `_handle_truncated_tool_call`, `_length_cut_is_ctx_full`, `_TRUNC_STREAK_MAX`, `_CTX_FULL_RATIO`, et les locaux de la série (`_truncated_streak`, `_ctx_saturated_stop`, `_gen_cap_stop`…) devenus `TruncationGuard` | `_chat_with_tools.py` et locaux de `_run_chat_multi_mcp_impl` | `engine/tool_dispatch.py` |
| les deux canaux d'exécution des outils : préparation du lot natif → `open_native_round` ; canal texte → `classify_text_reply`, `relaunch_unparsed_call` (avec `_MALFORMED_RETRY_MAX`, `_LOST_TOOL_CALL_NUDGE`), `open_text_round` ; exécution, post-traitement et anti-boucle communs → `run_tool_batch` (`BatchOutcome`) ; divergences entre canaux → `ChannelSpec` (`NATIF`, `TEXTE`) ; fermeture `_is_local_tool` | blocs et fermetures de `_run_chat_multi_mcp_impl` | `engine/tool_dispatch.py` |
| émission directe du contenu : fermetures `_on_content_iter`, `_flush_live_pend` et dict `_live_stream` devenus `LiveText` (`on_token`, `flush`, `emit_rest`) ; `_live_stream_rest`, `_LIVE_HOLDBACK_CHARS`, `_LIVE_MARKUP_SUSPECT_RE` | `_chat_with_tools.py` et fermetures | `engine/live_text.py` |
| état du run : `THINKING_HISTORY_MAX_CHARS`, `THINKING_HISTORY_TRUNC_MARKER`, `_clip_thinking_history`, `RUN_TOOL_HISTORY_MAX_BYTES`, `_cap_run_tool_history`, `_tool_call_args_weight`, `_tool_msg_weight`, `_content_text` ; locaux partagés (`events`, `_run_tool_history`, `_all_thinking`, cumuls d'usage, lot en cours, fenêtre de contexte, marques d'élagage…) devenus champs de `RunRecord` ; fermetures `_record_file_mutation`, `_usage_note`, `_delta_snapshot`, `_materialiser_lot_interrompu`, `_emit_partial_tool_history_snapshot`, `_guard_cancel`, `_last_run_assistant_text` devenues méthodes de `RunRecord` ; `_engine_semaphore`, `_llm_slot` devenus `engine_semaphore`, `llm_slot(ctx)` ; nouveaux : `RunContext`, `LoopDeps` | `_chat_with_tools.py`, locaux et fermetures | `engine/run.py` |
| reprises automatiques : `_resume_prefix_join` ; locaux `_think_resume_count`, `_think_resume_tokens`, `_pending_think_resume`, `_pending_resume_native_ok`, `_content_resume_count`, `_pending_content_resume` et leurs blocs devenus `ResumeState` (`take`, `restore`, `reset_chain`, `plan`) et `ResumeRequest` | `_chat_with_tools.py` et locaux | `engine/resume.py` |
| un tour LLM : le bloc de la tête d'itération à la réponse décodée devenu `call_llm` → `LLMTurn` ; locaux de mesure, compactions et séries de récupération devenus `LLMTurnState` ; `_auto_compaction_on`, `_PRUNE_EVERY_ITERS`, `_COMPACTIONS_PER_RUN_MAX`, `_FLATTEN_RESUME_NUDGE`, `_QUOTA_MARKERS`, `_llm_error_hiccup_ok`, `_unique_tool_call_ids`, `_flatten_tool_messages` | `_chat_with_tools.py` et blocs de l'impl | `engine/llm_turn.py` |
| sorties du run : réponse finale → `finish_ok` ; sortie sur limite et tour de synthèse → `finish_on_limit` ; sortie d'erreur → `finish_on_error` ; `_norm_thinking`, `_MARKUP_ONLY_REPLY`, `_MAX_STEPS_WRAPUP`, `_WRAPUP_BY_KIND` | `_chat_with_tools.py` et blocs de l'impl | `engine/run_exit.py` |
| alias retirés (pont de réexports) : `_fold_operational_block` | `_chat_with_tools.py` | `context/assembly.py` : `fold_operational_block` |
| alias retirés : `_enforce_context_budget`, `_fit_context`, `_select_prune_keys`, `_prune_old_vision_frames`, `_compact_desktop_elements`, `_prepare_tool_result_for_model`, `_DESKTOP_TOOL_RESULT_MAX_CHARS`, `_VISION_FRAME_PLACEHOLDER` | `_chat_with_tools.py` | `context/pruning.py` : `enforce_context_budget`, `fit_context`, `select_prune_keys`… (nom sans `_` initial, sauf `_VISION_FRAME_PLACEHOLDER`) |
| alias retirés : `_count_messages_tokens_per_msg` ; `_BUDGET`, `_CTX_OUTPUT_RESERVE_RATIO`, `_CTX_OUTPUT_RESERVE_MIN`, `_CTX_KEEP_RECENT` ; `_execute_tool_batch` | `_chat_with_tools.py` | `context/tokens.py` : `count_messages_tokens_per_msg` ; `context/budget.py` : `BUDGET` (`output_reserve_ratio`, `output_reserve_min`, `keep_recent_msgs`) ; `engine/tool_exec.py` : `execute_tool_batch` |

Flux de chat, ancien emplacement `chatbot_app/routes/chats.py` :

| Symboles | Ancien emplacement | Module actuel |
|---|---|---|
| `api_chat_saved_stream3`, réduit à l'enchaînement des étapes : admission, préparation, verrou de présence, recalage après une passation, `StreamingResponse` | `chats.py` | `chatbot_app/routes/chats.py` |
| `api_chat_reasoning_end`, `api_chat_cancel`, `api_task_cancel`, `api_chat_compress` (obsolète), `api_chat_generation_status`, `api_chat_active_runs`, `api_chat_run_events` | `chats.py` | `chatbot_app/routes/chat_control.py` |
| `api_chat_compression_state`, `api_chat_manual_compress` | `chats.py` | `chatbot_app/routes/chat_compression.py` |
| préparation (corps du handler) devenue `prepare_turn` → `TurnPlan`, `TurnResources`, `PersistBaseline` ; `_settings_from_cached_row`, `_stdio_allowed_for`, `_agent_mcp_configs` | `chats.py` | `chatbot_app/turn/preparation.py` |
| `gen()` et `worker()` devenus `run_turn` (le worker y reste une fermeture) ; `_cloturer_run`, `_should_detach_run`, `_generate_chat_title`, `_TITLE_PROMPT`, `_kv_gauge_used_tokens`, `_ctx_usage_snapshot` ; nouvelle fonction pure `_payload_final` | `chats.py` | `chatbot_app/turn/execution.py` |
| verrou de présence : `_acquire_gen_presence`, `_pending_gen_locks`, `_release_unclaimed_gen_lock`, `_sweep_pending_gen_locks`, `_handover_rebaseline_ok`, `_PENDING_GEN_LOCK_TTL_S`, `_PENDING_GEN_LOCK_WATCHDOG_S`, `_HANDOVER_WAIT_S` ; compactions manuelles en vol : `_manual_compressions`, `_manual_compression_fds`, `_manual_compression_active`, `_manual_compression_begin`, `_manual_compression_end` | `chats.py` | `chatbot_app/turn/admission.py` |
| pompe NDJSON et suivi de chargement : `_drain_coalesced`, `_couper_file`, `_drop_event_after_cancel`, `_cancel_engine_stream`, `_start_load_watch`, `_stop_load_watch`, `_LOAD_WATCHERS` | `chats.py` | `chatbot_app/turn/events.py` |
| enregistrement : `_persist_turn`, `_attendre_hors_annulation`, `_plan_mode_should_end` ; nouvelles fonctions pures tirées du worker : `_message_assistant`, `_message_partiel` (`MessagePartiel`), `_suffixe_question` | `chats.py` | `chatbot_app/turn/persistence.py` |
| historique client ↔ base ↔ modèle : `_normalize_client_messages`, `_expand_history_for_llm`, `_split_for_continue`, `_tronc_pour_reprise`, `_graft_stopped_turn_state`, `_merge_prev_segment_lists`, `_merge_continue_tool_history`, `_resume_instruction`, `_tool_entry_sigs`, `_metrics_for_persist`, `_task_runs_for_persist`, `_compaction_pour_message`, `_rounds_d_outils`, `_fc_clean`, `_fc_merge`, `_fc_list`, et leurs constantes (`_CLIENT_ROLES`, `_NOTICE_FIELDS`, `_GRAFT_KEYS`, `_THINK_ONLY_RE`, `_CANCEL_PLACEHOLDER`, `_RESUME_ANSWER`, `_COMPACTION_NOMBRES`, `_FC_*`) | `chats.py` | `chatbot_app/turn/history.py` |
| `_BG_TASKS`, avec `keep(task)` | `chats.py` | `chatbot_app/turn/tasks.py` |

Importeurs de production redirigés : `llm_core/tools/task_tool.py`
(`result_is_tool_failure`, importé à l'appel depuis
`engine/result_contract.py`), `shared_infra/mcp/openapi.py` (`pick_tool_payload`,
`_TOOL_QUEUE_WAIT_S`, `_tool_timeout_s`, `_tool_timeout_json`, depuis
`engine/tool_dispatch.py`), `server/app.py` (registre `_BG_TASKS` drainé à
l'arrêt : `chatbot_app.turn.tasks`), `shared_infra/routes/__init__.py`
(`_CHATBOT_ROUTE_MODULES` enregistre `chats`, `chat_control` et
`chat_compression`). La façade perd `llm_core._result_is_error` et
`llm_core._result_is_tool_failure`, remplacés par `llm_core.result_is_error`
et `llm_core.result_is_tool_failure`, ainsi que les alias du pont retiré
(`_fold_operational_block`, `_enforce_context_budget`, `_fit_context`,
`_select_prune_keys`, `_compact_desktop_elements`,
`_count_messages_tokens_per_msg`, `_DESKTOP_TOOL_RESULT_MAX_CHARS`,
`_VISION_FRAME_PLACEHOLDER`, `_BUDGET`, `_CTX_OUTPUT_RESERVE_RATIO`,
`_CTX_OUTPUT_RESERVE_MIN`, `_CTX_KEEP_RECENT`).

Cibles de patch des tests :

| Ancienne cible | Nouvelle cible |
|---|---|
| `_chat_with_tools.get_model_context_size` | `llm_core._model_info.get_model_context_size`, lu à l'appel par la boucle, la fonction de flux et `build_llama_payload` (le compresseur lit la copie de façade `llm_core.get_model_context_size`) |
| `_chat_with_tools.mcp_pool` | `llm_core._mcp_pool.mcp_pool` |
| `_chat_with_tools.LLAMA_TOOL_TIMEOUT_S`, `_tool_timeout_s`, `_ensure_local_asset`, `_extract_desktop_frame`, `_TCM_UID_CACHE` | `llm_core.engine.tool_dispatch.<nom>` |
| `_chat_with_tools._fire_cancel_stream`, `_llm_retry_pause` | `llm_core.engine.llm_stream.<nom>` |
| `_chat_with_tools._fit_context`, `_select_prune_keys`, `_count_messages_tokens_per_msg` | `llm_core.context.pruning.fit_context`, `select_prune_keys`, `count_messages_tokens_per_msg` |
| `_chat_with_tools.record_turn_usage` | `shared_infra.observability.usage_ctx.record_turn_usage` (lu à l'appel par `engine/run_exit.py` et l'enveloppe du run) |
| `_chat_with_tools._llama_chat_with_tools_stream`, `_chat_with_tools._record_tool_call_metric_safe` | inchangées : seam de la boucle (`LoopDeps.stream`, `LoopDeps.record_metric`) |
| `chats.llama_chat_stream_tokens`, `chats.run_chat_multi_mcp`, `chats.log_metric`, `chats._persist_turn`, `chats.asyncio.wait_for` | `chatbot_app.turn.execution.<nom>` |
| `chats.llama_chat` (compression manuelle) | `chatbot_app.routes.chat_compression.llama_chat` |
| `chats._HANDOVER_WAIT_S`, `chats._manual_compressions` | `chatbot_app.turn.admission.<nom>` |
| `chats.require_user_id` | le module de la route testée ; pour plusieurs routes, `tests/_routes_chat.monter_routes_chat` |
| `chats.router`, après import du seul `chats` | le routeur partagé, après `register_chatbot_routes()` (`tests/_routes_chat.py`) |

## `llm_core/_chat_with_tools.py` — boucle agentique

Historique des règles retirées des commentaires du code, une entrée par décision :
date — source — constat → règle retenue (symbole). Les entrées sans date consignée
dans le code sont regroupées à la fin, par source.

- **2026-06** — audit — tokens_used (cumul in+out) sur-comptait l'occupation en mode outils (croissance quadratique) → context_tokens additionnel = prompt+completion du dernier tour (événement iteration).
- **2026-07-12** — constat en production — dialecte XML d'appel émis hors canal natif : le parseur du serveur mange les balises ouvrantes, seules les fermantes arrivent (tour mort à 35 tokens, aucun outil exécuté) → détection sur les balises fermantes seules et relance (_TOOL_MARKUP_TRACE_RE, _LOST_TOOL_CALL_NUDGE).
- **2026-07-12** — constat « s'arrête net » — tentative d'appel perdue dans le canal reasoning : le tour mourait après la phrase d'annonce → relance native bornée (chemin texte, _LOST_TOOL_CALL_NUDGE).
- **2026-07-12** — bascule « réel seul » — la jauge de contexte n'estime plus : elle lit l'usage réel renvoyé par le serveur (événement kv_cache unique) (jauge de contexte).
- **2026-07-28** — décision de conception — clamp en nombre de messages (LLAMA_MAX_MSGS) retiré : la seule borne est le budget en tokens ; un dépassement donne un message clair (KIND_CONTEXT_OVERFLOW) plutôt qu'une amnésie silencieuse (_llama_chat_with_tools_stream).
- **2026-07-31** — audit « limites fantômes » — le tour de synthèse affirmait toujours « limite d'étapes atteinte », même après un arrêt par mur d'horloge, contexte saturé, boucle d'action ou cascade d'échecs → cause réelle d'arrêt gardée et consigne de synthèse par cause (_WRAPUP_BY_KIND, _wallclock_stop).
- **2026-07** — audit du refactor — décision : l'auto-gating par mots-clés reste non câblé (fail-ouvert) pour garder le jeu d'outils stable au sein d'un chat (cache de préfixe) (_collect_mcp_tools).
- **2026-08-01** — audit du harnais long-run — cadence d'élagage intra-run et plafond de compactions par run introduits, lus à l'import (_PRUNE_EVERY_ITERS, _COMPACTIONS_PER_RUN_MAX).
- **2026-08-01** — audit long-run — le plafond dur (cascade d'échecs) arrêtait le run sans que le modèle en ait été prévenu → annoncé dès qu'il devient la contrainte la plus proche (_harness_status_line).
- **2026-08-01** — audit long-run — la fenêtre de contexte venait du /props local même pour un connecteur distant (pipeline en veille si ctx=0) → résolue par cible (resolve_context_window) (_run_chat_multi_mcp_impl).
- **2026-08-01** — audit long-run — les budgets de récupération étaient des totaux de run jamais réarmés (deux hoquets espacés de deux heures tuaient une mission) → séries remises à zéro dès qu'une itération aboutit (_run_chat_multi_mcp_impl).
- **2026-08-01** — audit long-run — la sélection d'élagage n'avait lieu qu'en fin de tour (rendue au tour suivant) : un run de 200 itérations n'élaguait jamais → élagage intra-run (_run_prune_keys).
- **2026-08-02** — audit — un Stop ou une fermeture d'onglet laissait la dernière capture (JPEG de 100-400 Ko) dans le dict de module à vie → wrapper avec purge garantie sur tous les chemins (_run_chat_multi_mcp_wrapper).
- **2026-08-02** — audit — seul chemin de lecture des COMPRESSION_* sans resync disque : valeur oscillant selon le worker après une modification admin → reload_compression_config_from_disk avant lecture (porte de compaction).
- **2026-08-21** — audit long-run — le raisonnement de toutes les itérations s'accumulait sans borne (mégaoctets en heap, /tokenize en timeout, ligne NDJSON géante) → borne dure THINKING_HISTORY_MAX_CHARS, suffixe conservé avec marqueur (_clip_thinking_history).
- **2026-08-21** — audit long-run — une coupure par plafond en pleine rédaction terminait le tour sur « Continuer », sans effet dans une mission autonome → reprise in-run de la prose (série bornée) (_content_resume_count).
- **2026-08-21** — audit long-run — une réponse sans choices faisait un break sec : run arrêté en plein milieu avec un diagnostic faux (« budget épuisé ») → série bornée dédiée, réarmée par une réponse exploitable (le compteur de hoquets, réarmé par tout appel abouti, bouclait jusqu'au cap) (_empty_choices_streak).
- **2026-08-21** — audit long-run — une seule compaction par run (harnais v4) : passé la première, le budget dur jetait les vieux tours → plafond COMPACTIONS_PER_RUN_MAX mis à l'échelle du budget d'itérations du run (_run_compaction_max).
- **2026-08-22** — audit — la frame vision était appendée entre deux résultats d'un lot parallèle : résultat orphelin, 400 en pleine mission ou compaction tranchant entre appel et réponse → injection différée après le dernier role:tool du lot (INJECTION VISION).
- **2026-08-22** — audit — la tool_history d'un run n'était bornée par rien (dizaines de Mo poussés dans une ligne NDJSON en fin de tour) → borne RUN_TOOL_HISTORY_MAX_BYTES, tête et queue gardées, appariement id ↔ résultat préservé (_cap_run_tool_history).
- **2026-08-22** — constat en production — l'aplatissement repliait chaque résultat d'outil dans l'assistant précédent : N assistants consécutifs terminés par un assistant, refusés en 400 par les builds récents de llama-server → forme conversationnelle stricte (observations en user, jamais d'assistant final) (_flatten_tool_messages).
- **2026-08-22** — constat (2026-08-21 et 2026-08-22) — le diagnostic d'un refus 400 demandait de rejouer llm_calls.request_json à la main → corps de la réponse d'erreur capturé (_llama_chat_with_tools_stream).
- **2026-08-22** — audit — l'aplatissement de l'historique empoisonné n'était possible qu'à l'itération 0 : une mission mourait à l'itération 150 sur trois fois le même 400 → une fois par run, à toute itération, après épuisement des hoquets (_run_chat_multi_mcp_impl).
- **2026-08-23** — audit du cœur — la frame vision injectée n'avait pas le marqueur _ephemeral : prise pour un vrai tour (ancre de tâche, covered_turns sur-compté, un vrai tour jeté par frame) → _ephemeral: True (INJECTION VISION).
- **2026-08-23** — audit du cœur — _hidden_cats et _manifest_ok étaient figés avant la connexion qui peuple le registre : sur un worker froid, repli fail-open (un utilisateur n'ayant coché que « Fichiers » recevait le terminal et le contrôle d'écran) → lecture après connexion (_collect_mcp_tools).
- **2026-08-23** — audit du cœur — /v1 absent des suffixes retirés : un connecteur OpenAI-compatible construisait …/v1/v1/stream (reprise impossible, Stop sur 404 classé succès, génération jamais arrêtée) → /v1 retiré comme dans llama_caps et chats.py (_endpoint_base).
- **2026-08-23** — audit du cœur — la sonde des capacités (flux reprenable) interrogeait LLAMA_URL (moteur local) même pour un connecteur llama.cpp distant → sonde de la cible réelle (_llama_chat_with_tools_stream).
- **2026-08-23** — audit du cœur — la détection de fin silencieuse se désarmait en présence de tool_calls : une coupure au milieu des arguments exécutait l'outil avec args={} (delete_file, git_commit amputés) → détection maintenue, alignée sur le chemin d'exception (_llama_chat_with_tools_stream).
- **2026-08-23** — audit du cœur — le disjoncteur n'était jamais nourri par le chemin outils (la boucle attrape LLMFailure avant le garde) → note_transport_failure au point de levée (_llama_chat_with_tools_stream).
- **2026-08-23** — audit du cœur — la récupération d'un appel piégé dans le raisonnement s'appliquait aussi à un raisonnement tronqué (finish_reason « length ») : write_file amputé exécuté, finish_reason réécrit contournant les gardes de troncature → promotion interdite sur « length » (_llama_chat_with_tools_stream, _recover_tool_calls_from_reasoning).
- **2026-08-23** — audit du cœur — un commentaire affirmait à tort que la continuation de reprise est routée en thinking (ThinkTagSplitter(start_in_think=True)) ; depuis le passage à un prefill fermé + consigne de conclusion, elle est routée en contenu (_llama_chat_with_tools_stream, _think_resume).
- **2026-08-23** — audit du cœur — en mode « optimized », les deux compactions POSTaient hors de tout slot : un résumé de 50 s atterrissait à côté de la génération d'un autre utilisateur (préfixe KV évincé, réutilisation de 99 % à ~0) → un slot pour les quatre points d'appel LLM (_llm_slot).
- **2026-08-23** — audit du cœur — un lot annulé en cours ne laissait aucune trace (assistant.tool_calls dépilé) et « Continuer » rejouait les outils mutants déjà appliqués → matérialisation du round interrompu (_materialiser_lot_interrompu).
- **2026-08-23** — audit du cœur — la sortie d'erreur était la seule des trois à ne rien enregistrer dans le registre d'usage (un run de 3 h mort à l'itération 181 disparaissait de l'onglet Utilisation) → status « aborted » (_run_chat_multi_mcp_impl).
- **2026-08-23** — audit du cœur — le routeur de logs MCP utilisait l'id d'appel, unique seulement dans un run : la sortie du terminal d'un compte partait chez un autre → jeton de routage dédié, unique au run (_run_log_tok).
- **2026-08-23** — audit du cœur — le poids d'un message ne lisait que content : les arguments des tool_calls (54 % du contexte) étaient invisibles, le cap n'élaguait rien → arguments comptés (_tool_msg_weight).
- **2026-08-23** — audit du cœur — garde d'égalité stricte entre prose nettoyée et contenu exact : vraie à la première reprise seulement, l'espace de fin des segments 2 à 4 était perdu (affichage et continue_final_message) → test de suffixe (chemin des reprises).
- **2026-08-23** — audit du cœur — le buffer streamé (brut) court-circuitait le nettoyage : un dialecte de raisonnement inconnu (balises « thinking » à barres verticales) partait dans la bulle et en base, compté deux fois → extraction du thinking sur le buffer streamé (réponse finale).
- **2026-08-30** — audit — une purge automatique d'imports a retiré un réexport « mort » et cassé la collecte de deux fichiers de tests → réexports marqués noqa et commentés (pont de réexports context.*).
- **2026-08-30** — audit — la synthèse était émise par tranches de 12 caractères toutes les 12 ms (1 s par millier de caractères en fin de run) → un seul content_token (tour de synthèse).
- **2026-08-31** — audit de fluidité — attente en file du pool MCP sans borne propre ; le wait_for externe englobait l'attente du sémaphore (outil « expiré » sans avoir tourné, modèle poussé à re-queuer) → budget chronométré dans le pool, erreur MCPQueueSaturated distincte (_TOOL_QUEUE_WAIT_S, _execute_single_tool_call).
- **2026-08-31** — audit de fluidité — les serveurs MCP étaient connectés en série : coûts spawn/handshake/list_tools additionnés avant le premier token → connexions en parallèle, filtrage en série dans l'ordre des configs (_collect_mcp_tools).
- **2026-08-31** — audit de fluidité — un handler intégré synchrone (outils RAG) s'exécutait sur la boucle, hors de toute borne (gel de tous les flux du worker) → appel en threadpool, borné (_execute_single_tool_call).
- **2026-08-31** — audit de fluidité — le contenu du chemin outils était bufferisé puis rejoué à ~1 000 car/s : premier caractère visible à la fin de la génération → streaming direct avec fenêtre de retenue (48 caractères) et portail de markup (_live_stream_rest, _LIVE_HOLDBACK_CHARS, _LIVE_MARKUP_SUSPECT_RE).
- **2026-08-31** — audit de fluidité — rejeu tool_thinking remplacé par l'émission directe, reclassée en narration par le front au premier tool_call (_on_content_iter).
- **2026-08-31** — audit de fluidité — le sémaphore inline était acquis sans test de cible : un run sur connecteur cloud occupait l'unique slot du modèle local → sémaphore réservé aux serveurs llama.cpp (_run_chat_multi_mcp_impl).
- **2026-09-01** — audit — l'écriture du fichier de contrôle du raisonnement partait en synchrone du callback de token, puis par l'exécuteur multi-thread (deux écritures du même tour pouvaient s'inverser) → thread unique ordonné ordered_io, completion_id capturé à l'appel (_publish_completion).
- **2026-09-02** — revue des adhérences MCP — l'identité (meta) était injectée selon le préfixe du nom d'outil : un serveur externe exposant read_file/memory recevait l'identité de l'utilisateur, et un registre vide donnait « guest » → outils locaux reconnus par leur config (_is_local_tool).
- **2026-09-02** — décision de conception — les ≤48 derniers caractères de la prose restaient invisibles pendant la génération des arguments → fenêtre relâchée au premier delta d'appel (_on_tool_call_delta_iter).
- **2026-09-04** — régression — un serveur MCP externe injoignable émettait un event error, terminal côté front : tout le tour s'affichait en échec → warning (_collect_mcp_tools).
- **2026-09-11** — politique d'outil — la borne d'un outil voyage dans meta.policy.timeout_s ; _TOOL_TIMEOUT_DEFAULTS n'est plus qu'un repli (worker froid, serveur externe homonyme) (_TOOL_TIMEOUT_DEFAULTS).
- **2026-09-12** — outils portables — actifs produits par un hôte d'outils distant rapatriés par le relais (jeton de service + identité) ; id numérique de l'utilisateur transmis dans la meta (_ensure_local_asset, _build_call_meta).
- **2026-09-12** — outils portables — la sentinelle « service d'outils intégré » se développe en toutes les entrées intégrées du manifeste (_expand_builtin_configs).
- **2026-09-12** — outils portables — toute entrée intégrée du manifeste reçoit l'identité ; jamais un serveur tiers (_is_local_tool).
- **2026-09-16** — chantier multi-serveurs — gestionnaire de concurrence du serveur de la cible (LLM_SEMAPHORE pour l'intégré, gestionnaire dédié d'un connecteur llama.cpp) (_engine_semaphore).
- **2026-09-16** — audit multi-serveurs — l'arrêt d'un llama-server protégé par --api-key rendait 401 et la génération continuait → en-tête d'auth du serveur visé sur DELETE /v1/stream (_fire_cancel_stream).
- **2026-09-16** — chantier multi-serveurs — les endpoints propres à llama-server (/props, /slots) suivent le serveur de la cible (intégré ou connecteur llama.cpp) (_llama_chat_with_tools_stream).
- **2026-09-16** — audit multi-serveurs — la sonde partait sans en-tête d'auth (401 sur un llama-server protégé) → serveur de la cible (EngineRef) passé à engine_caps (_llama_chat_with_tools_stream).
- **2026-09-16** — audit multi-serveurs — la panne d'un connecteur ouvrait le circuit du modèle homonyme de l'intégré → clé du disjoncteur = serveur de la cible (_llama_chat_with_tools_stream).
- **2026-09-16** — chantier multi-serveurs — chaque serveur llama.cpp (intégré ou connecteur) a son gestionnaire ; le sémaphore inline s'applique à chacun sur le sien (_run_chat_multi_mcp_impl).
- **2026-09-21** — décision de conception — le partiel d'erreur venait de working_messages : un run sans prose renvoyait la réponse du tour précédent, un « Continuer » son propre préfixe → partiel tiré du delta du run (_run_chat_multi_mcp_impl).
- **2026-09-23** — audit de l'éditeur — git_write donnait un path relatif au dépôt, le front lisait un homonyme à la racine ; dry_run non signalé ; sha256 du contenu final ajouté pour remplacer le mtime relu (_write_event_extra).
- **2026-09-24** — audit — un outil fourni par deux serveurs était annoncé deux fois (400 chez Anthropic/OpenAI) et routé vers la dernière config → premier arrivé gagne (_collect_mcp_tools).
- **2026-09-24** — audit — même filet sur les autres points de suspension hors des try d'annulation (tête de boucle, backoffs, rapatriement des captures, fin de tour) (_guard_cancel).
- **2026-09-24** — audit; audit; audit — une annulation délivrée hors des try d'annulation (post-traitement d'un lot, backoffs, appels de compaction dans except, émission de la réponse finale, tour de synthèse) laissait le partiel sans trace des outils exécutés : « Continuer » repartait aveugle et pouvait rejouer des outils mutants → snapshot de la tool_history avant toute propagation (_guard_cancel) (_guard_cancel, _run_chat_multi_mcp_impl, réponse finale, tour de synthèse).
- **2026-09-24** — audit — une reprise morte en route rendait previous seul : partiel persisté plus court que ce que l'écran avait reçu, « Continuer » repartait de trop loin → recopie du plus long des deux, en place (_keep_resumed_text).
- **2026-09-24** — audit — le repli non-streaming remplaçait le motif de fin par « tool_calls »/« stop » : un appel coupé par le plafond partait à l'exécution avec des arguments amputés, une prose tronquée était rendue sans « Continuer » → finish_reason « length » propagé tel quel (_llama_chat_with_tools_stream).
- **2026-09-24** — audit — l'accumulateur de tool_calls n'était pas celui du sink : un retry après coupure au milieu d'un write_file rejouait les tool_call_delta (aperçu Monaco doublé) → accumulateur branché sur le sink (_llama_chat_with_tools_stream).
- **2026-09-24** — audit — même interdiction pour la coupure silencieuse ; _silent_cut était calculé après la réécriture de finish_reason et valait False → constat du silence avant la récupération (_llama_chat_with_tools_stream).
- **2026-09-24** — audit — après une coupure de transport dont la reprise échoue, le moteur continuait de générer sur un slot cru libre → DELETE /v1/stream comme sur un Stop (_llama_chat_with_tools_stream).
- **2026-09-24** — audit — une panne déterministe (401/403, quota, contexte dépassé) était rejouée trois fois comme un hoquet (12 s pour la même erreur) ; l'itération 0 n'avait droit qu'à l'aplatissement → famille de panne prise en compte, itération 0 incluse (_llm_error_hiccup_ok).
- **2026-09-24** — audit — la sentinelle affirmait « NON exécuté » pour un appel peut-être en vol au Stop : le modèle relançait tout → « exécution NON confirmée, vérifier l'état » (_materialiser_lot_interrompu).
- **2026-09-24** — passe robustesse — _extract_desktop_frame appelé avec un seul argument : TypeError avalé, trame distante jamais rapatriée → signature à trois arguments (_prefetch_desktop_frame).
- **2026-09-24** — audit — le rappel todo en second message user faisait lever les gabarits à alternance stricte (Gemma, Mistral) → fusion dans le dernier user, sur une copie (_run_chat_multi_mcp_impl).
- **2026-09-24** — audit — la demande de reprise vidée avant l'appel n'était pas restituée aux relances : réponse réécrite depuis le début (doublon), partie déjà écrite jamais en base → restitution (_run_chat_multi_mcp_impl).
- **2026-09-24** — audit — un timeout, un 503, un 429 ou un 401 aplatissaient l'historique à l'itération 0 (faux message, cache KV perdu) → aplatissement réservé aux refus de requête et pannes non classées (_run_chat_multi_mcp_impl).
- **2026-09-24** — audit — la sortie d'erreur n'avait pas les clés d'occupation : la jauge retombait sur le cumul et affichait 100 % après chaque erreur → last_prompt_tokens et submitted_input_tokens (_run_chat_multi_mcp_impl).
- **2026-09-24** — audit — les ids de repli positionnels (call_0…) se répétaient d'une itération à l'autre : élagage, résumeur et matérialisation d'un Stop prenaient la mauvaise occurrence (écriture rejouée au Continuer) → ids uniques sur tout l'historique (_unique_tool_call_ids).
- **2026-09-24** — audit — des arguments JSON invalides devenaient {} en silence : l'outil partait sur ses défauts, le modèle ne voyait jamais son erreur → args_error, outil non exécuté (chemin natif).
- **2026-09-24** — audit — une erreur externe {"error": …, "status": 404} passait pour un succès → ok: False posé sur toute enveloppe d'erreur isError (pick_tool_payload).
- **2026-09-24** — audit — une réponse réduite à rien par le nettoyage persistait le balisage brut → message de repli _MARKUP_ONLY_REPLY (réponse finale).
- **2026-09-24** — parcours prompt — le repli sur limite lisait reversed(working_messages) : réponse du tour précédent persistée comme nouvelle (plantage sur un content en liste) → travail de ce run seulement (sortie sur limite).
- **2026-09-25** — audit — ressource MCP embarquée texte perdue (« [non-text content block] ») ; str(item) rendait le repr pydantic base64 compris (une capture PNG de 300 Ko = 400 000 caractères persistés) → rendu texte dédié, repère court pour les binaires (_content_block_text, pick_tool_payload).
- **2026-09-25** — audit — l'assemblage du contexte (base, urlopen synchrone vers Playwright jusqu'à 2 s) tournait sur la boucle d'événements et gelait tous les flux du worker → asyncio.to_thread (_run_chat_multi_mcp_impl).
- **2026-09-25** — audit — le rappel todo n'existait que pour le tour courant : le préfixe KV divergeait au tour suivant (tour précédent re-préchargé) → suffixe persisté (llm_user_suffix) et rejoué à l'octet (_run_chat_multi_mcp_impl).
- **2026-09-25** — audit — un run annulé (Stop, déconnexion, sous-agent expiré) n'enregistrait pas son usage → cumul tenu par l'impl, enregistré à l'annulation (_run_chat_multi_mcp_wrapper, _RUN_USAGE_ACC).
- **2026-09-25** — audit — le message de timeout disait « appel annulé » alors que le serveur peut encore exécuter l'outil (le modèle relançait aussitôt : deux effets concurrents) → « attente abandonnée ; il peut encore s'exécuter » (_tool_timeout_json).
- **2026-09-25** — audit — les ids legacy_{iter}_{idx} se répétaient d'un tour à l'autre (élagage et résumeur sur le mauvais appel) → suffixe aléatoire pour un id déjà vu (chemin texte).
- **2026-09-25** — audit — hystérésis du budget dur : les groupes retirés à l'itération précédente le restent (enforce_context_budget, _budget_drop_floor).
- **2026-09-25** — audit — compaction automatique désactivée : la porte prenait quand même le slot LLM à chaque itération (double attente en file) → décision vérifiée avant le slot (porte de compaction).
- **2026-09-25** — audit — la synthèse retirait tools[] : préfixe divergent juste après le système, re-préremplissage complet au plus plein, deux fois → même tools[] que les itérations (tour de synthèse).
- **2026-09-26** — audit — l'interrupteur de compaction automatique, lu avant la resynchronisation, gardait une valeur périmée pour les runs sans appelant → relu du disque (_auto_compaction_on).
- **2026-09-26** — audit — un Stop pendant la génération perdait les tokens d'entrée de l'appel en vol → inflight_in dans le cumul d'usage (_on_prompt_progress).
- **2026-09-26** — audit — un rappel ajouté derrière une queue assistant (préremplissage d'une reprise) désarmait continue_final_message → pas de rappel dans ce cas (_run_chat_multi_mcp_impl).
- **2026-09-26** — audit — le rattrapage « contexte dépassé » prenait le slot même compaction automatique désactivée → même règle que la porte d'occupation (_run_chat_multi_mcp_impl).
- **2026-09-26** — audit — un échec de la mesure du raisonnement sautait l'enregistrement d'usage → mesure et enregistrement séparés (_run_chat_multi_mcp_impl).
- **2026-09-26** — audit — une exception hors des trois retours perdait l'usage des itérations déjà faites → enregistré avec status « error » (_run_chat_multi_mcp_wrapper).
- **2026-09-26** — décision de conception — champ files (fichiers modifiés de tout outil, empreintes avant/après de l'historique de session) ajouté au tool_result (_write_event_extra).
- **2026-09-26** — audit — la synthèse repartait sans le plancher du budget dur : tête de la vue changée, tout le contexte re-préchargé → drop_floor de la dernière itération (tour de synthèse).
- **2026-09-26** — audit — un appel d'outil émis pendant la synthèse la vidait → outils gardés (préfixe KV) mais tool_choice="none" (tour de synthèse).

### Sans date consignée

- audit — un appel non parsable (JSON ou balisage cassé) était streamé tel quel ; un modèle 30-129B rejouait la même erreur → diagnostic réinjecté, relances bornées (chemin texte, _malformed_retry).
- audit — jamais d'identité de compte envoyée à un serveur externe : un seul point d'injection de la meta pour les deux canaux (_build_call_meta).
- audit — les erreurs fatales ne court-circuitent pas le retry transitoire : les hoquets restent le chemin qui mène à l'aplatissement (_llm_error_hiccup_ok).
- audit — des arguments JSON valides mais non-objet faisaient lever AttributeError hors de tout try (tour tué) → {} comme le chemin legacy (chemin natif).
- audit — n_ctx figé à 0 sur un échec transitoire de /props désactivait budget et compression pour tout le run → re-sondé tant qu'il vaut 0 (_run_chat_multi_mcp_impl).
- audit — relance bornée après compaction sur « contexte dépassé » (_ctx_overflow_retries).
- audit — un builtin awaitable suspendu gelait le tour → même borne dure que le chemin MCP, avec le budget restant (deux wait_for pleins cumulaient 2× la borne) (_execute_single_tool_call).
- audit — le wrapper de délai tuait un sous-agent task encore dans son budget → TASK_CHILD_TIMEOUT_S + 60 s pour task (_tool_timeout_s).
- audit — retries bornés sur un hoquet transitoire du moteur (aucun token émis, aucun outil exécuté), en série consécutive (_llm_hiccup_streak).
- audit — budget mur d'horloge opt-in de la boucle outillée (_loop_max_s).
- audit — la garde « au moins un tour » du mur d'horloge portait sur effective_iter : un run 100 % en échec échappait au budget de temps → compteur dur (boucle while).
- audit — un petit modèle brûlait tout son budget à rejouer un cycle d'actions malgré le nudge → arrêt dur après _CYCLE_HARDSTOP_MAX cycles confirmés (_CYCLE_HARDSTOP_MAX).
- audit — le compteur de cycles cumulé sur tout le run arrêtait une mission de 3 h sur deux blocages passagers → compteur de série, oublié après 15 itérations productives sans cycle (_cycle_detections).
- audit — arrêt anti-boucle : message clair garanti même si le dernier assistant est vide (sortie sur limite).
- audit — le rappel todo refaisait un SELECT * FROM users à chaque tour pour ne garder que l'id → cache username→uid partagé avec les métriques d'outils (_todo_status_reminder).
- audit — sur une reprise de rédaction, n ne comptait pas le préfixe déjà affiché : réponse affichée en double → n inclut le préfixe (_live_stream).
- audit — la fenêtre de retenue (≤48 caractères) était perdue avant un continue de récupération (narration coupée en plein mot) → _flush_live_pend (_flush_live_pend).
- audit — itération dont des tool_call_delta sont partis sans tool_call : consommée en tête de boucle (event reset) (_delta_pending_iter).
- audit — fragments tool_call_delta streamés pour une itération sans tool_call : le front concaténait deux fois le JSON d'arguments → event reset (_delta_pending_iter).
- audit — des fragments tool_call_delta déjà poussés au front étaient rejoués par un retry → tool_calls_acc compte comme émission partielle (_llama_chat_with_tools_stream).
- audit — _tool_calls_done comptait working_messages (historique ré-expansé, rounds absorbés par compaction) : compteur faux et porte de la synthèse erronée → delta du run (_tool_calls_done).
- audit — décodage Pillow de la trame bureau sur la boucle d'événements (30-120 ms CPU) → déporté en thread par l'appelant (_populate_desktop_frame).
- audit — une sentinelle posée par un snapshot antérieur restait alors que l'outil avait terminé → remplacée par le vrai résultat (_materialiser_lot_interrompu).
- audit — prune_old_vision_frames travaillait sur une copie : les base64 des frames restaient en heap et re-parcourus à chaque itération → élagage en place (2 frames gardées) (chemin natif).
- audit — la validité de la mesure réelle se jugeait sur la longueur seule, fausse quand l'ancre user est insérée dans la passe qui retire un message → compteur dropped du budget dur lu aussi (_fit_dropped).
- audit du harnais — un 4xx (hors 408/429) était rejoué à l'identique jusqu'à épuisement des tentatives → abandon immédiat (requête invalide) (_llama_chat_with_tools_stream, _llm_error_is_fatal).
- audit du harnais — budget communiqué au modèle : points d'étape <harness_status> en append-only après les tool results (cache de préfixe préservé) (_harness_status_line).
- audit du harnais — dédoublonnage des jalons <harness_status> (sinon ré-injection à chaque tour raté et alerte « plafond dur » jamais émise) (_hs_last_status_key).
- audit long-run — un point d'étape persisté comptait pour un tour : covered_turns sur-comptait à la compaction → injection éphémère (_maybe_inject_harness_status).
- constat en production — un for range(_max_iter) consommait le budget sur les outils en échec (33 réussis + 13 échecs = budget de 50 épuisé) → deux compteurs : effective_iter (productif) et hard_iter (plafond dur) (_run_chat_multi_mcp_impl).
- correctif — activer « Navigateur » faisait disparaître tous les pw_* (gating par mots-clés) → une catégorie explicitement activée n'est jamais masquée (_collect_mcp_tools).
- correctif — un retry après émission partielle ré-émettait tout depuis zéro (contenu dupliqué) → retour du partiel, tool_calls à moitié reçus abandonnés (_llama_chat_with_tools_stream).
- correctif — seul <tool_call>…</tool_call> était retiré du contenu visible ; <function=…>…</function> restait affiché brut → les deux dialectes retirés, bloc ouvert compris (_strip_tool_call_markup).
- correctif (fuite de markup) — le partiel d'erreur pouvait porter le markup brut du fallback legacy (bulle et base) → _strip_tool_call_markup comme la réponse finale (_run_chat_multi_mcp_impl).
- correctif (fuite de markup) — du markup d'appel résiduel non exécutable s'affichait brut dans la bulle → _strip_tool_call_markup pour l'affichage et la persistance (réponse finale).
- harnais v4 — ratio chars/token mesuré sur chaque réponse réelle (coupes et deltas estimés sans I/O) (note_real_usage).
- harnais v4 — « contexte dépassé » renvoyé par le serveur ⇒ compaction puis une relance (série bornée) (_run_chat_multi_mcp_impl).
- harnais v4 — la compaction suit une seule règle d'overflow : occupation ≥ n_ctx − cap de génération − buffer (porte de compaction).
- harnais v4 — élagage de fin de tour : marques en tokens exacts persistées (prune_state) et appliquées au tour suivant (_select_prune_keys).
- observabilité des exécutions — fenêtre restante et limites réelles du conteneur ajoutées au point d'étape budget (_harness_status_line).
- refactor — sur une erreur de transport, les buffers de garde restaient vides et un retry ré-émettait tout → sink dont les listes sont les buffers de garde (_llama_chat_with_tools_stream).
- refactor — pipeline de contexte extrait vers llm_core.context ; exécution des lots partagée par les deux canaux via engine.tool_exec (~110 lignes dupliquées retirées) (context.pruning, context.assembly, engine.tool_exec).
- signalement utilisateur — le garde-fou anti-boucle (blocage du 3e appel identique par une enveloppe factice ok:false) forçait la boucle et faisait tourner le run jusqu'au plafond dur sans rien produire → retiré ; la terminaison reste garantie par la condition du while (boucle while).
- signalement utilisateur (capture) — <tool_call> orphelin laissé visible quand le modèle est coupé avant la balise de fermeture → retrait jusqu'à EOF (_strip_tool_call_markup).
- v17.20 — identité passée en MCP request meta (out-of-band) plutôt que dans les arguments visibles du modèle (_build_call_meta).
- correctif — un résultat aplati sans marque _ephemeral comptait pour un tour et devenait « la demande en cours » du budget dur → observations aplaties éphémères (_flatten_tool_messages).
- correctif — les sorties volontaires écrasaient effective_iter avec le budget (« 200/200 tours » mensonger, cause perdue) → drapeau _forced_stop, compteur vrai (_forced_stop).
- correctif — la jauge de contexte était masquée dès que la cible n'était pas le llama-server local (n_ctx d'un autre modèle) → affichée quand la fenêtre de la cible est connue (_gauge_ctx_total).
- correctif — le traitement d'un appel tronqué était dupliqué (copié-collé divergent) entre chemin natif et texte → fonction partagée (_handle_truncated_tool_call).
- correctif — la consigne de relance compacte affirmait « by the context limit », le modèle concluait parfois qu'il ne pouvait plus rien faire → formulation neutre (plafond ou fenêtre) (_handle_truncated_tool_call).
- correctif — une coupe finish=length était toujours lue « contexte saturé » (fenêtre pleine annoncée à 20 % d'occupation, compaction proposée à tort) → distinction fenêtre pleine / plafond de sortie (_length_cut_is_ctx_full).
- correctif — température figée à 0.2 sur le chemin outils → paramètres du GGUF (/props) + override de l'interface (_llama_chat_with_tools_stream).
- correctif — l'entrée de contrôle du raisonnement survivait à la fin du flux jusqu'à son TTL : « Répondre maintenant » pouvait viser un tour mort → retrait dans le finally du flux (_llama_chat_with_tools_stream).
- correctif — un flux fermé sans finish_reason était classé « stop » : un run long se terminait « proprement » en pleine mission, sans « Continuer » → flux vide retenté, flux non vide traité en partiel de transport (_llama_chat_with_tools_stream).
- correctif — les erreurs LLM remontaient le texte brut de httpx dans la bulle de chat (aucune cause, aucun geste) → LLMFailure (message actionnable, detail, kind) (_llama_chat_with_tools_stream).
- correctif — un seul hoquet toléré par run : le second, même deux heures plus tard, terminait la mission → série consécutive réarmée (_llm_hiccup_streak).
- correctif — l'écrivain de tool_call_metrics avait disparu avec l'ancien moteur agentique (onglets Observabilité/Utilisation à zéro) → la boucle outils alimente la table sur ses deux chemins (_record_tool_call_metric_safe).
- correctif — le plafond de l'override UI (littéral 500) était plus bas que ce qu'un déploiement peut configurer → plafond qui suit la config (_run_chat_multi_mcp_impl).
- correctif — sur une reprise de rédaction, le partiel ne portait que le dernier segment (la partie 1 disparaissait en base) → préfixe _pending_content_resume (_run_chat_multi_mcp_impl).
- correctif — la sortie d'erreur n'avait ni « thinking » (réflexion perdue au rechargement) ni « truncated » (aucun « Continuer » après une erreur LLM) → clés ajoutées (_run_chat_multi_mcp_impl).
- correctif — la tool_history était une capture cumulative depuis le premier message agentique : la route ré-expansait chaque bulle, contexte doublé à chaque tour (1, 7, 19, 43, 91, 187 messages…) → delta du run seul (_run_tool_history).
- correctif — la fenêtre d'une reprise du raisonnement se calculait en last_prompt_tokens + think_tokens_done (raisonnement compté deux fois, blocage à mi-fenêtre) → prompt + généré du segment (_think_resume, chemin des reprises).
- correctif — le compteur d'outils additionnait assistant.tool_calls et role=tool (« 4 outils » en haut, « 8 » dans le bandeau) → role=tool seul (_tool_calls_done).
- correctif — un pendingWrite unique côté front n'affichait que le dernier write d'un tour multi-outils → path du fichier muté dans chaque tool_result (_write_event_extra).
- correctif — une coupure par plafond en pleine rédaction était la seule sans reprise automatique (bannière « Continuer » sans effet en mission autonome) → auto-reprise de la prose (chemin des reprises).
- correctif — un log_metric("tool_call") à la préparation doublait celui de l'exécution (KPI « Appels outils / 24 h » jusqu'au double : 14 957 lignes avec status contre 12 371 sans) → une seule ligne, à l'exécution (chemin natif, engine.tool_exec).
- correctif — le canal legacy stockait les résultats en role=system, perdus inter-tours → role=tool apparié à un assistant.tool_calls synthétique (chemin texte).
- correctif — un appel vers un outil inconnu restait streamé tel quel (JSON visible dans la bulle) → purge si le texte n'est que cette tentative (chemin texte).
- correctif — isError (dont erreurs de validation pydantic) renvoyé comme payload ordinaire, classé succès ; multi-blocs : seul c[0] survivait ; structuredContent ignoré quand content est vide → erreur explicite, concaténation marquée, structuredContent rendu (pick_tool_payload).
- correctif — chaque tour outillé était compté deux fois dans le registre d'usage (boucle « mcp_native » + route « mcp ») → une ligne par tour, dans la boucle seule ; la route ouvre un usage_scope (registre d'usage).
- correctif — la métrique llm_tool_iterations loggait iteration+1 (tous les tours) → effective_iter, comme le compteur exposé (réponse finale).
- correctif — le compteur d'itérations de l'event d'erreur portait hard_iter (numérateur au-delà du dénominateur) → itérations productives (sortie d'erreur).
- correctif — filet final : une synthèse en échec sans texte accumulé rendait une bulle vide → message déterministe selon la vraie cause (le cap dur affichait « 12/200 tours ») (sortie sur limite).
- correctif — sortie sur limite : le run rendait le dernier partiel sec, souvent vide → tour de synthèse sans outils (modèle OpenCode max-steps) (tour de synthèse).
- correctif — sur limite d'outils, la jauge retombait sur le cumul des itérations (100 %, bannière « contexte presque plein » à 30 %) → occupation du dernier prompt envoyé (tour de synthèse).
- correctif — la synthèse repartait sans marques d'élagage contre un contexte plein et échouait (bulle vide) → prune_keys du run (tour de synthèse).

## `chatbot_app/routes/chats.py` — flux de chat

Historique des décisions retirées des commentaires du module, sous la forme
`date — source — constat → règle retenue (symbole)`. Les entrées sans date
viennent de commentaires qui n'en portaient pas ; elles sont regroupées en fin
de section, par thème.

### Entrées datées

- **2026-07-12** — constat en production — le `final` réécrivait `title` avec le titre tronqué à 28 caractères, qui écrasait le titre généré par le modèle dans l'en-tête et la barre latérale → le titre additif du `final` vient de `_final_title` et n'est jamais réécrit ensuite (`worker`).
- **2026-07-18** — refonte de la carte agent — la carte n'itère plus `run.tools`, mais le champ restait persisté et renvoyé à chaque tour (base et payload gonflés) → `tools` retiré des `task_runs` persistés (`_task_runs_for_persist`) ; les `task_runs` du tour interrompu sont rattachés au partiel (cartes agents évaporées au rechargement) ; le bilan final d'un sous-agent passe le filtre post-Stop (la ligne agent restait en spinner à vie) (`_drop_event_after_cancel`).
- **2026-07-24** — UX — le déroulé compact `transcript` d'un sous-agent est conservé au persist (modale « œil » après rechargement) (`_task_runs_for_persist`).
- **2026-07-25** — UX — la notice de compaction porte sa propre copie du résumé, le porteur system étant jeté par le front au rechargement (accordéon de vérification) (`api_chat_manual_compress`).
- **2026-08-01** — audit — une tâche fire-and-forget non référencée peut être collectée avant de tourner (asyncio ne garde qu'un WeakSet) : le cache de modèles n'était jamais rafraîchi → références fortes dans `_BG_TASKS`.
- **2026-08-01** — audit — le préfixe rejoué des historiques legacy cumulatifs retenait le DERNIER index vu ; les ids de repli étant déterministes, un outil idempotent rappelé à l'identique faisait sauter du travail frais ou coupait entre un `tool_calls` et son résultat (400 du fournisseur) → arrêt à la première entrée fraîche (`_expand_history_for_llm`).
- **2026-08-01** — audit — la lecture initiale du chat était entourée d'un `except` nu et silencieux : un « database is locked » désarmait la garde optimiste, effaçait le résumé de compaction et ignorait les marques d'élagage → échec tracé et marqué (`_chat_read_failed`), écriture destructrice interdite, état de compression relu au moment du persist (`api_chat_saved_stream3`, `_with_compr_state`).
- **2026-08-02** — audit — l'état « génération en cours » n'était visible qu'au travers d'un 409 (rechargement pendant une génération d'un autre onglet : rien, puis un 409 déroutant) → route `GET /api/chat/{id}/generation-status` (`api_chat_generation_status`).
- **2026-08-02** — audit — accumuler une réponse de 100 Ko en ~25 000 micro-chaînes coûtait ~30× le texte en mémoire, et `content_chunks` (chemin classique) accumulait chaque token sans jamais être lu → join périodique des accumulateurs au-delà de 512 éléments, `content_chunks` supprimé (`on_event`, `worker`).
- **2026-08-02** — bug — l'état des serveurs externes du panneau Outils vivait dans les réglages globaux et « collait » d'un chat à l'autre → mémorisé par chat (`ext:<id>` dans `meta_json["tools"]`).
- **2026-08-06** — sous-agents — un enfant reconstruit sa configuration MCP de zéro (catégories pré-cochées de son type) : couper les outils du chat ne les coupe pas chez lui → l'interrupteur « Outils externes » coupe aussi les sous-agents (`_agents_on`).
- **2026-08-22** — audit — garde « une génération par chat » : un client déconnecté avant la première itération de `gen()` laissait le fd de présence ouvert à vie (409 permanent) ; un retry après coupure réseau atterrissait sur un autre worker (deux runs sur le même chat, conflit optimiste, outils rejoués) ; un run mourant non signalé faisait répondre 409 au rejeu immédiat → verrou pris dans le handler, dernière instruction avant le flux, réservé dans `_pending_gen_locks` puis réclamé par `gen()`, balayé au TTL ; sonde précoce pour éviter de payer la préparation d'un tour refusé ; annulation publiée sur le bus par `_cloturer_run` (`_acquire_gen_presence`, `_sweep_pending_gen_locks`, `_cloturer_run`).
- **2026-08-22** — audit — la présence était libérée au bout de 10 s d'attente même si le worker tournait encore (outil long) : worker fantôme, Stop perdu, compaction concurrente, écrasement → désenregistrement à la fin RÉELLE du worker (`_cloturer_run`).
- **2026-08-22** — audit — fermeture d'onglet, veille, changement de réseau ou session expirée tuaient un tour qui avait déjà exécuté des outils → critère `tools_ran` : un tel tour est détaché, un tour de pur chat garde « fermer l'onglet arrête » (`_should_detach_run`, `on_event`).
- **2026-08-22** — audit — l'attente derrière un modèle occupé était muette et le Stop sans effet pendant cette attente ; une cible distante passait par l'ordonnanceur local → `llm_scheduling_guard` reçoit `target`, `on_wait` et `cancel_probe` ; `LLMQueueAborted` est importé au niveau module (importé dans la coroutine, il pouvait lever un `NameError` qui masquait l'erreur d'origine) (`worker`).
- **2026-08-22** — audit — un compte pouvait lancer autant de missions que de chats ouverts et monopoliser le serveur → plafond `MAX_RUNS_PER_USER` compté sur les verrous de présence (`api_chat_saved_stream3`).
- **2026-08-22** — audit — `upsert_chat` synchrone dans la coroutine : en contention WAL, la boucle dormait jusqu'à 10 s (plus de tokens, plus de SSE, Stop sans effet) → persistance en thread (`worker`).
- **2026-08-22** — audit — `tool_history` (des mégaoctets) était écrite deux fois par message, au premier niveau et dans les métriques → copie des métriques sans `tool_history` (`worker`).
- **2026-08-22** — audit — un run détaché n'était rattaché à rien : au plafond de drain, le process le tuait sans persister son partiel → tâche worker en référence forte dans `_BG_TASKS` (`gen`).
- **2026-08-23** — audit — `_cloturer_run` était enfoui dans le `finally` de `gen()`, inatteignable par les tests ; chaque tour RÉUSSI publiait un flag d'annulation (collé sur les autres workers, sonde précoce neutralisée, 12 s de passation au lieu d'un 409, spool qui grossit) → fonction de module, bloc d'annulation réservé au worker encore vivant (`_cloturer_run`).
- **2026-08-23** — audit — l'arrêt moteur sondait `engine_caps()` en plein Stop (jusqu'à 3 s) et renonçait sur capacités UNKNOWN (300 s après un timeout) : le modèle générait jusqu'au bout → aucune sonde, renonciation seulement sur preuve d'un moteur trop ancien (`_cancel_engine_stream`).
- **2026-08-23** — audit — `_CANCEL_PLACEHOLDER` concaténé devant une reprise était figé dans le contenu persisté et repartait au modèle à chaque tour → même garde côté persistance que côté vue modèle (`_tronc_pour_reprise`).
- **2026-08-23** — audit — le widget de file restait affiché après la fin du tour : `queue_cleared` dépendait d'un instantané synchrone qui ne voit ni les verrous des autres workers ni Redis (« vous êtes 1er » derrière une mission de plusieurs heures) → suivi de ce qui est réellement parti (`_file_annoncee`) et variante async `get_queue_status_for_async` (`worker`).
- **2026-08-23** — audit — `thinking` passait entier dans la copie des métriques du message (jusqu'à 400 000 caractères réécrits à chaque tour) → retiré aussi de la copie (`worker`).
- **2026-08-31** — audit — `compression-state` désérialisait et comptait tout l'historique sur la boucle à chaque changement de chat → route `def` (threadpool) ; lecture initiale du chat hors boucle (`api_chat_compression_state`, `api_chat_saved_stream3`).
- **2026-08-31** — audit — `apply_rag` synchrone (30 s de timeout) gelait tous les flux du worker → threadpool (`api_chat_saved_stream3`).
- **2026-08-31** — audit — écritures SQLite de la compression manuelle et du partiel sur la boucle, au moment où l'utilisateur attend la réaction au Stop → threadpool (`api_chat_manual_compress`, `worker`).
- **2026-09-01** — audit — le mode plan était relu par un second SELECT synchrone → dérivé de `_existing_chat` ; si cette lecture a échoué, repli sur une lecture dédiée, jamais « mode normal » par défaut (`api_chat_saved_stream3`).
- 2026-09-02 → 2026-09-04 — régression — `json` non importé dans le module : le `NameError` était avalé par un `except` large et chaque tour partait avec des réglages vides (seuls les outils externes disparaissaient) ; les tests, qui patchent `require_user_id`, ne posaient jamais `_user_row` → plus d'`except` large, JSON illisible signalé et relu en base, test dédié ; réglages lus depuis la ligne chargée par la porte de session (deux `SELECT *` synchrones) (`_settings_from_cached_row`).
- **2026-09-11** — manifeste MCP — serveurs déclarés dans `mcp.json` : canal par chat `mf:<nom>`, URL et en-têtes résolus par le manifeste ; le service d'outils intégré (entrée `toolhost`) remplace les trois serveurs synthétiques « Mémoire », « Agents », « Tâches » (`api_chat_saved_stream3`).
- **2026-09-12** — outils par outil — outils décochés un par un : canal séparé d'`active_mcp_servers` (la liste entrerait dans la clé du pool), appliqué après connexion par `deny_tool_names`.
- **2026-09-16** — audit — la question n'était persistée qu'en fin de tour : un worker mort l'emportait → écrite dès le début d'un tour reprenable, base optimiste recalée (`_persist_question`).
- **2026-09-16** — audit — plusieurs chemins voyaient le serveur intégré à la place du connecteur choisi : repli silencieux d'un connecteur invalide (bascule invisible entre serveurs homonymes), instantané de file pris avant de poser la cible, compression manuelle résumée par le modèle homonyme de l'intégré → aucun repli silencieux (409 explicite, `engine_access` appliqué dans la route), cible posée avant l'instantané, compression sur le serveur sélectionné ; arrêt moteur, « Répondre maintenant », jauge KV et appels llama-server visent le serveur de la cible (`_cancel_engine_stream`, `api_chat_reasoning_end`, `_ctx_usage_snapshot`).
- **2026-09-16** — audit — un renommage pendant la génération faisait perdre la réponse (`updated_at` bougé, toast « erreur base ») → relecture sur conflit et réécriture si les messages sont identiques (`_persist_turn`).
- **2026-09-16** — chantier « run reprenable » (décision utilisateur) — les événements du chat principal sont journalisés pour rejouer puis suivre le tour ; une déconnexion le détache, outils ou non ; `generation-status` donne de quoi se rattacher, et un journal terminé vaut « fini » même pendant la télémétrie post-final (`api_chat_saved_stream3`, `api_chat_generation_status`).
- **2026-09-20** — sécurité — un serveur MCP perso `stdio` n'est lancé que pour un administrateur plein (`_stdio_allowed_for`).
- **2026-09-21** — sécurité — l'entrée du serveur d'outils locaux était recopiée du payload (`type`/`url`/`headers` ouvraient une URL arbitraire depuis le backend) → entrée reconstruite (`api_chat_saved_stream3`).
- **2026-09-21** — RAG — un service RAG en panne donnait une réponse sans documents qui ressemblait à une réponse sourcée → événement `info` explicite (`worker`).
- **2026-09-25** — audit — corps JSON de plusieurs Mo décodé sur la boucle (tous les flux du worker gelés) → décodage en thread au-delà de 256 Ko (`api_chat_saved_stream3`).
- **2026-09-25** — audit — « Stop puis régénérer » recevait un 409 (le drapeau d'annulation met ~100 ms à atteindre un autre worker), et la passation partait d'une base optimiste périmée (question et réponse non sauvegardées) → délai de grâce de la sonde précoce, `waited_out` et recalage de la base ; le 2026-09-26, recalage limité au cas où le chat ne diffère que par le partiel du run stoppé (un drapeau périmé faisait adopter puis écraser le tour normal d'un autre onglet) (`api_chat_saved_stream3`, `_handover_rebaseline_ok`).
- **2026-09-25** — audit — `gen()` réclamait le verrou réservé après l'ouverture du journal : un client parti pendant ce premier `await` laissait un verrou orphelin (409 pendant deux minutes) → réclamation en première instruction ; filet par verrou réservé (`_PENDING_GEN_LOCK_WATCHDOG_S`) (`gen`, `_release_unclaimed_gen_lock`).
- **2026-09-25** — audit — un Stop pendant l'écriture précoce de la question s'échappait du worker sans partiel ni `final` (flux ouvert, verrou tenu) → écriture dans le `try` (`worker`).
- **2026-09-25** — audit — les cartes de sous-agents du segment tronqué se perdaient lors d'un « Continuer » (complet ou stoppé) → fusion (`_merge_prev_segment_lists`).
- **2026-09-25** — audit (moteur d'événements) — le fail-open de la garde de présence se décidait sur `is_held` : une course concluait « verrouillage indisponible » et lançait le run sans verrou → décision sur l'état du dossier de verrous (`_acquire_gen_presence`).
- **2026-09-25** — audit (moteur d'événements) — un run qui produit sans pause ne passait jamais par la revalidation de session du rejeu : une session révoquée continuait de suivre le run → contrôles avant le `continue` du rejeu (`api_chat_run_events`).
- 2026-09-25 / 2026-09-26 — audit — le suffixe `<todo_status>` fusionné aux questions n'était pas rejoué (préfixe KV divergent), y compris sur la dernière question d'un « Continuer » ; une entrée de suffixe jamais retirée rejouait un rappel jamais vu → rejeu à l'octet, entrée posée ou retirée à chaque tour, rangs supérieurs purgés (`_expand_history_for_llm`, `worker`).
- **2026-09-26** — audit — acquisition du verrou de présence sur la boucle (attente jusqu'à 3 × 2 ms) → `acquire_async` (`_acquire_gen_presence`).
- **2026-09-26** — audit — une lecture initiale du chat en échec n'était pas retentée → une relecture après 300 ms ; pas de titre généré si le titre existant est inconnu (`api_chat_saved_stream3`, `worker`).
- **2026-09-26** — audit — le travail d'outils d'un tour stoppé, persisté par le serveur mais jamais reçu par le client, disparaissait au tour suivant (outils rejouables, trace effacée) → greffe depuis la base (`_graft_stopped_turn_state`).
- **2026-09-26** — passe d'optimisation — titre généré dans le slot du chat (KV évincé, 2e tour re-prérempli) → `slot_avoid_own` ; fenêtre de coalescence portée de 15 à 25 ms (1-2 tokens agrégés seulement), agrégation des `tool_call_delta` d'un même appel ; `stat` sur la boucle avant le passage en thread de `read_lines` (`_generate_chat_title`, `_drain_coalesced`, `api_chat_run_events`).
- **2026-09-26** — fichiers modifiés — `files_changed` du message (diffs retrouvés après rechargement), état « avant » = premier outil du tour, « après » = dernier (`_fc_merge`).
- **2026-09-29** — pied des messages — le pied des tours précédents disparaissait au tour suivant → renvoyé par le client et gardé, borné (`_metrics_for_persist`).

### Entrées non datées

- Annulation et fin de tour. `task.cancel()` sans attente laissait le `finally` du worker écrire le partiel après le retour du handler (write-after-write) → attente bornée, unregister après l'attente ; la télémétrie part après le `final`, et un flux fermé dans cette fenêtre n'est pas une annulation (`final_sent`) (`_cloturer_run`). Le `final` du partiel passe le filtre post-Stop (tokens partiels perdus côté UI) (`_drop_event_after_cancel`). Une file pleine sans lecteur bloquait le worker à vie (verrou jamais rendu) → `_couper_file`. Un Stop pendant la persistance du tour complet faisait écrire un partiel en plus → `_attendre_hors_annulation`. Une exception avant le `final` du partiel fermait le flux sans `final` → `final` minimal non persisté.
- Multi-onglets. Deux onglets de chats différents s'annulaient mutuellement (flag indexé par utilisateur seul) → `chat_id` du body ; mode sans `chat_id` limité aux tâches `"__none__"` (`api_chat_cancel`). Diffusion de l'annulation d'un sous-agent hors boucle (`api_task_cancel`).
- Persistance. Seuls role+content étaient gardés : l'historique d'outils des tours précédents disparaissait dès le 3e tour → `tool_history`, `thinking`, `images`, `task_runs`, notices, `run_ids`, jalons de compaction gardés (`_normalize_client_messages`) ; le rôle `notice` est accepté dans le payload (la notice de compaction s'évaporait) (`_CLIENT_ROLES`). Une erreur de persistance faisait avorter le tour, puis un échec d'upsert donnait un `final` normal (réponse perdue au rechargement sans le dire) → persistance isolée, `persisted` et `persist_error` dans le `final`, nouvel id sur collision ; un titre renommé était remplacé par les 28 premiers caractères du 1er message → conservé ; écritures `meta_json` de fin de tour dans une seule transaction `finalize_turn_meta`, toggles non écrits quand les outils sont coupés ; `upsert_chat` du partiel sous la même garde optimiste ; `MemoryManager.shutdown` explicite.
- « Continuer ». Deux assistants consécutifs en base scindaient la réponse au rechargement → un seul message fusionné, `tool_history` delta concaténé au tronc (complet et partiel) ; consigne de reprise injectée aussi pour un assistant avec `tool_history` ; reprise depuis le raisonnement persisté (sans consigne, re-raisonnement de 5-10 min, même mur) ; placeholder d'annulation marqué `isTruncated` ; marqueurs de troncature persistés pour une limite d'outils (le bouton disparaissait au rechargement) ; `_RESUME_AFTER_THINK` demande la réponse finale (« le thinking sort du bloc »).
- Interface. `content_replace` remplace le partiel accumulé (le partiel persisté sur un Stop portait la version brute) ; pill `kv_cache` calculée avant la persistance ; message d'erreur par famille de panne avec `detail` replié (au lieu de `str(e)` brut) ; `queue_cleared` sur panne pendant l'attente ; `last_user_text` multimodal ; heartbeat `ping` du drain (flux muet pendant un outil long).
- Interrupteur « Outils externes ». Il ne masquait que le bouton et le panneau : les catégories cochées partaient toujours au modèle → appliqué côté serveur (`enable_mcp`).
- Sécurité MCP. Une entrée de serveur perso recopiée du payload permettait une SSRF à en-têtes contrôlés par tout compte authentifié → le client ne fournit qu'un id, URL et authentification viennent du magasin serveur.
- Compression. `/api/chat/compress` (déclenché par le client) concurrençait la compression serveur (résumés écrasés) → no-op déprécié ; compression manuelle sans modèle explicite → 400 « modèle inexistant » ; set local `_manual_compressions` aveugle aux autres workers → doublé d'un verrou partagé ; état de compression persistant ré-appliqué au prompt (compression re-payée à chaque tour).
- Coûts de la boucle. Initialisation de la mémoire et `embed_chart_configs` en threadpool, `log_metric` hors boucle ; registre d'usage nommé par la route (tokens de la boucle comptés deux fois), `task_child_tokens` retiré (hors de tout agrégat), `write_tps`/`llm_latency` écrits par la boucle seulement.
- Suivi de chargement. Un `pop` inconditionnel dans le `finally` d'un watcher annulé évinçait son successeur, qui courait jusqu'au timeout avec sa connexion `/models/sse` → pop conditionnel.

## `llm_core/_tool_parsing.py` — appels d'outils écrits en texte

- **2026-06** — audit — un appel d'outil détecté mais illisible n'était signalé que dans le journal : le petit modèle restait sans retour et rejouait son erreur en boucle → diagnostic exposé au niveau du module, lu par la boucle juste après l'appel et renvoyé au modèle (`LAST_PARSE_DIAGNOSTIC`).
- **2026-06** — audit — un bloc `<tool_call>` balisé qui ne se lisait ni en JSON ni en GLM-XML était ignoré en silence → journalisé (tronqué) et mémorisé pour le diagnostic (`extract_tool_calls`).
- **2026-06** — audit — un objet JSON plausible mal formé dans la prose était ignoré en silence (trois appels émis, deux exécutés) → compteur des débuts non lisibles et un journal récapitulatif par appel (`extract_tool_calls`).
- **2026-09-24** — audit — les noms d'outils étaient lus en `\w+` (outils MCP à tiret comme `resolve-library-id` jamais extraits) et les valeurs passées à `.strip()`, qui mangeait l'indentation et la fin de ligne d'un `old_string`/`content` (édition sans effet) → noms en `[\w.-]`, seul le saut de ligne de bord retiré (`extract_tool_calls`, `_strip_param_value`).

## `llm_core/engine/result_contract.py` — classement des échecs

- **2026-07-13** — correctif — les builtins RAG rendaient `{"error": …, "hint": …}` sans `ok`, compté comme un succès par la boucle et par le ledger de compression, qui portaient chacun leur copie de l'heuristique → enveloppe `ok: false` à la source, et source unique `result_is_error` partagée (boucle, ledger, alignée sur le frontend).
- sans date — mesure — `execute_shell` rendu `{"ok": false, "returncode": N}` après une commande exécutée était compté comme échec d'outil (36 % de faux échecs) → `result_is_tool_failure` distingue la commande en échec de l'outil en échec.

## `llm_core/tools/task_tool.py` — sous-agents

- **2026-07-18** — parité OpenCode — reprise par `task_id`, annulation par enfant, récursion opt-in ; un run interrompu (timeout, échec, annulation ciblée) devient reprenable depuis l'historique live reconstruit (`_store_resume_state`, `_resumable_live_history`).
- **2026-07-18** — correctif — l'ajout du record du run vivait après le `raise` du Stop parent : le run en vol disparaissait du `task_runs` persisté et la ligne agent restait en spinner puis s'évaporait au rechargement → `_record_run` appelé avant le `raise`.
- **2026-07-18** — décision — pas de teardown navigateur à la fin de l'agent `web` : les sessions pw_* appartiennent à l'utilisateur, partagées avec le parent et les autres chats.
- **2026-07-24** — UX — déroulé complet compact de l'enfant (`_chat`) pour la modale « œil », persisté dans le record (`transcript`).
- **2026-07-31** — audit « limites fantômes » — le bloc `<task_env>` finissait par « Always use absolute paths. » alors que le `<runtime_context>` du même message système dit l'inverse : l'enfant brûlait des itérations en chemins absolus rejetés → aucune règle de chemins dans `<task_env>` (`_child_env_block`).
- 2026-08-04 → 2026-08-06 — décision de conception — le casting de spécialistes à 6-9 outils nommés par agent laissait toujours manquer le geste suivant (« je n'ai pas l'outil ») → un sous-agent est un chat aux catégories pré-cochées ; seule barrière dure : `_DENY_BASE` (`_AGENTS`). Le casting intégré ayant changé (`general` retiré, `implement`/`verify`/`pr` ajoutés), un agent du compte devenu homonyme bloquait tout l'enregistrement des Paramètres en 400 → renommage plutôt que refus (`_free_agent_name`).
- **2026-08-23** — audit — l'inscription dans `_ACTIVE_CHILDREN` précédait de ~490 lignes le `try` qui porte son retrait, avec deux points de suspension gardés par `except Exception` que `CancelledError` traverse : un Stop pendant le spawn laissait une entrée fantôme qui rouvrait le flag orphelin, et les registres grossissaient pour la vie du worker → inscription au `try`.
- **2026-08-23** — audit — l'historique live de reprise empilait un assistant par appel et les résultats d'un lot parallèle dans leur ordre d'arrivée, forme refusée en 400 par llama.cpp (reprise en échec, travail partiel perdu) → vagues canoniques, un assistant puis ses `tool` dans l'ordre (`_resumable_live_history`).
- **2026-08-30** — audit — le flush de fin de run et le « filet déroulé » faisaient apparaître la réponse finale deux fois dans la modale (bloc « Résultat » et dernière entrée du déroulé) → `deja_rendu` et retrait du filet sur le chemin normal (`_flush_chat`).
- **2026-08-30** — décision — `CUSTOM_AGENTS_MAX` relevé de 10 à 30 : la liste est un catalogue de spécialistes, pas une sélection.
- **2026-08-31** — audit — scan disque et lecture du store de reprise (jusqu'à 8 Mo), `json.dumps` et écriture disque, exécutés dans la boucle d'événements → `asyncio.to_thread` (`_prune_resume_store`, `_resume_lookup`, `_store_resume_state`).
- **2026-09-11** — politique d'outil — `meta.policy.deny_for: ["subagent"]` des outils fait foi, `_DENY_BASE` reste le repli d'un registre vide ; socle de catégories des agents custom repris de `mcp.json › x-elpis.default_on` (`custom_default_categories`).
- **2026-09-21** — correctif — la boucle d'outils retourne sur un échec LLM au lieu de lever : un agent mort en route était rendu « completed » avec un rapport vide → état `failed` lu dans les métriques.
- **2026-09-24** — audit — le cache L1 du store de reprise était servi sans regarder le disque : un autre worker ayant repris l'agent, ce worker repartait d'une version périmée puis écrasait le travail récent → comparaison de l'horodatage disque (`_resume_lookup`).
- **2026-09-24** — audit — un arrêt sur une borne du harnais partait au parent sous `state="completed"` avec un message destiné à l'humain → état `incomplete` + consigne de reprise (`task_incomplete`).
- **2026-09-24** — passe robustesse — un vrai `task.cancel()` arrivé pendant que l'annulation ciblée de l'enfant est posée était traité comme un arrêt ciblé → discrimination par `cancelling()`.
- **2026-09-25** — audit — les ids `live_{step}` repartaient de 1 à chaque appel du handler (ids `tool_use` dupliqués refusés par Anthropic, élagage sur le mauvais appel) → nonce par run.
- **2026-09-25** — audit — une routine (`low`) lançait ses sous-agents en `high`, et le `_meta` des outils locaux de l'enfant n'avait pas d'`user_id` → priorité et propriétaire du parent transmis (`build_task_builtin_tool`).
- **2026-09-26** — audit — le store de reprise était muté depuis des threads sans verrou (« OrderedDict mutated during iteration », résultat d'un sous-agent terminé remplacé par une erreur) → `_RESUME_LOCK`.
- **2026-09-26** — diffs du tour — les fichiers modifiés par les outils de l'enfant rejoignent les diffs du tour parent.
- audit — les registres in-process étaient documentés « déploiement single-worker assumé » alors que l'app tourne en gunicorn multi-worker sans affinité : le ✕ par agent et la reprise `task_id` étaient silencieusement inertes hors du worker d'origine → bus d'annulation (`cancel_child`, `apply_child_cancel`) et store partagé (`_task_resume`).
- correctif — sans diffusion, le ✕ d'un agent n'agissait qu'une fois sur N workers : l'API répondait `cancelled` pendant que l'agent consommait des tokens jusqu'à son terme → application locale puis diffusion sur le bus d'annulation (`cancel_child`).
- correctif — la reprise d'un tour à l'autre répondait `unknown_task_id` hors du worker d'origine, juste après avoir proposé ce `task_id` au modèle → lecture du store partagé, le dictionnaire restant cache chaud (`_resume_lookup`).
- décision — un agent du compte homonyme d'un intégré cesse d'être une collision : c'est une surcharge, seul « task » reste réservé (`RESERVED_AGENT_NAMES`).
- correctif — une catégorie ou un serveur malformé dans les données stockées faisait échouer le PUT des réglages sur le blob entier, sans issue par l'interface → entrée sautée, liste canonique renvoyée (`validate_custom_agents`).
- correctif — l'étape affichée comptait les appels d'outils, appels ratés compris, contre un budget d'itérations (« étape 63/40 »), et le chemin de résultat renvoyait le numéro du dernier appel démarré (« étape N » bondissait à chaque résultat parallèle) → tours comptés par l'événement `iteration` de l'enfant, même unité partout (`_iters`).
- correctif — l'appariement appel ↔ résultat se faisait par nom en FIFO : sur un lot parallèle du même outil, le contenu d'un appel était enregistré sous l'id d'un autre et l'historique de reprise présentait « j'ai lu A » avec le contenu de C → appariement par `call_id`, FIFO par nom en repli (`_live_by_call`, `_live_pending`, `_match`).
- correctif — l'historique de reprise coupait au premier message agentique pour compenser une capture cumulative ; avec une `tool_history` en delta, cette coupe perdait le travail des reprises antérieures → base `child_messages` entière + delta (`_next_msgs`).
- UX — le résultat final d'un agent n'existait que dans l'historique d'outils du parent, l'humain n'en voyait que le reflet tronqué à 1500 caractères → persisté entier dans le record, borné par `TASK_RESULT_PERSIST_CAP` (`result`).
- correctif — la consommation d'un sous-agent n'entrait dans aucun agrégat d'usage → scope d'usage imbriqué rattaché au tour parent (`usage_scope("subagent")`).
- renvois corrigés : « câblé dans la route chat » → worker de `run_turn` (`chatbot_app/turn/execution.py`), builtins RAG par `chatbot_app/turn/preparation.py` ; `_delta_snapshot` → `RunRecord.delta_snapshot` ; `_run_tool_history` → `RunRecord.run_tool_history` ; renvoi à une « analyse gestion » retiré.

## `llm_core/__init__.py` — façade

- sans date — refactor — `_legacy.py` supprimé : il ne réexportait que des noms déjà atteignables par la boucle de façade.
- **2026-09-24** — passe robustesse — un symbole homonyme d'un sous-module (`_health._client`, fonction) écrasait l'attribut du sous-module : `import llm_core._client` rendait une fonction → noms des sous-modules exclus de la recopie (`_SUBMODULE_NAMES`).

## `llm_core/engine/` — sous-routines de la boucle

- sans date — refactor — les canaux natif et texte de l'exécution d'outils étaient identiques à ~85-90 % (chaque correction à faire deux fois) → ordonnancement d'un lot partagé dans `engine.tool_exec`.

## `server/app.py` — application principale

Historique des règles retirées des commentaires du module, une entrée par
décision : date — origine — constat → règle retenue (symbole). Les entrées
sans date consignée sont regroupées à la fin.

- **2026-08-01** — audit — l'abonnement ``docker events`` n'avait aucun arrêt : son thread ``daemon`` mourait sans ``finally`` et le sous-processus ``docker events`` survivait réparenté à init, un de plus à chaque recyclage de worker → ``stop_events()`` appelé au shutdown (arrêt du worker).
- **2026-08-01** — audit — la garde ``_reject_cross_site`` n'était câblée que sur le changement de mot de passe (une route mutante sur ~33) → garde CSRF globale (``CsrfGuardMiddleware``).
- **2026-08-02** — audit — détection des capacités llama-server et préchauffage du pool MCP lancés par un ``create_task`` nu : tâche collectable avant son premier ``await``, exception jamais lue, capacités (grammaire d'appel d'outils, vision) sautées en silence → ``_register_bg_task`` (référence forte, exception journalisée) (démarrage).
- **2026-08-02** — audit — un recyclage de worker affichait la bannière « redémarrage » → flux infinis évacués avec ``worker_recycling`` (reconnexion en ~1 s sur un worker sain), bannière réservée au vrai redémarrage complet ; le shell rouvert s'annonce neuf par sa frame d'accueil (arrêt du worker).
- **2026-08-02** — audit — le verrou leader n'était libéré qu'en dernière étape du shutdown : pendant tout le drain, aucun worker ne reprenait le leadership et aucune routine ne partait → ``release_cron_lock`` juste après l'arrêt des schedulers.
- **2026-08-02** — audit — seules les tâches de fond d'``_events_bus`` étaient annulées au shutdown, celles de ``routes/tools.py`` et du flux de chat abandonnées en vol → drain des registres locaux (aujourd'hui ``chatbot_app.turn.tasks._BG_TASKS``).
- **2026-08-02** — audit — cookie de session sans ``max_age`` : défaut Starlette de 14 jours glissants, cookie persistant qui survivait à la gate ``_login_ts`` (24 h) → ``max_age`` aligné sur ``security.session.max_age_sec`` (``SessionMiddleware``).
- **2026-08-02** — audit — un corps JSON malformé produisait un 500 opaque sur ~64 sites ``await request.json()`` sans garde (login inclus) → handler global ``JSONDecodeError`` → 400.
- **2026-08-30** — audit — paramètres de chemin hors bornes (``OverflowError``) et chemins que le système de fichiers refuse de nommer (ENAMETOOLONG, ELOOP, EINVAL, EILSEQ) produisaient un 500 opaque → handlers 400, limités aux errno d'entrée (les pannes serveur restent des 500).
- **2026-09-11** — outils portables — relais vers un hôte d'outils distant (``mcp.json › sandboxHosts``), middleware intérieur à la session.
- **2026-09-21** — sauvegarde distante — planificateur leader-only (``start_backup_scheduler``).
- **2026-09-22** — audit — l'aperçu de sandbox était exempté de la garde CSRF → iframe sur origine opaque (``/api/sandbox/pvs/<jeton>/``), plus d'exemption ; en-têtes de sécurité par défaut (``SecurityHeadersASGI``) ; repli 404 des références absolues-racine fondé sur le ``Referer`` retiré au profit d'une réécriture à la source (``preview_rewrite``).
- **2026-09-25** — audit — le pipeline SSE de la page Code reçoit lui aussi ``worker_recycling`` et resynchronise son état ; plus de pont ``access_logging`` → ``system_events`` : chaque worker suit le journal JSONL commun.

### Entrées non datées

- audit — deux dérivations parallèles des attributs du cookie de session (application et déconnexion) pouvaient diverger et rendre la suppression du cookie inopérante sur Chrome/Safari → source unique des attributs (``_cookie_attrs``).
- correctif — CORS désactivé (``app.cors_origins`` vide ou absent) sans le moindre journal → message explicite à chaque démarrage.
- console d'administration — « Redémarrage nécessaire » : empreinte des réglages lus au démarrage par le process principal.
- correctif — `APP_MODE` absent ou invalide valait `full`, qui montait en silence la console d'admin sur le port public dès qu'un lancement oubliait la variable → repli sur `main` (`_resolve_app_mode`).
- refactor — `APP_PROFILE` sélectionnait l'applicatif servi (chatbot ou agentic) ; l'agentic retiré (service externe), toute autre valeur est ramenée à `chatbot` (`APP_PROFILE`).
- correctif — le filet atexit terminait aveuglément tous les processus enfants, y compris ceux d'autres parties du code (aides HAR/capture, hooks de déploiement) → filtre par ligne de commande, serveurs MCP seulement (`_kill_mcp_subprocesses_sync`).
- constat — enregistré par `@app.on_event("startup")`, ignoré en silence par Starlette dès que l'app a un `lifespan`, le tailer `metric_broadcast` ne démarrait sur aucun worker (aucun journal, aucun événement, popups de redémarrage absents, KPI jamais rafraîchis) → câblé dans le `lifespan` (`start_metric_tailer`).
- correctif — `start_cron_scheduler()` ne partait qu'au premier appel HTTP de `/api/system-events` : un worker recyclé qui ne servait plus que des WebSockets `/ws/terminal` ne lançait jamais son `_local_cleanup_loop`, et ses PTY n'étaient jamais récupérés (fuite fd/RAM sur plusieurs jours) → démarrage au boot sur chaque worker (`start_cron_scheduler`).
- correctif — `shutdown_mcp_pool` était défini mais jamais câblé à l'arrêt de l'app → appelé au shutdown, après les drains (pool MCP et client httpx partagé fermés).
- décision — attributs du cookie de session lus dans `config.json › security.session` au démarrage, défauts identiques aux anciennes valeurs codées en dur (`session_cookie_attrs`).
- renvois corrigés : `routes/auth.py` → `shared_infra/accounts/routes_auth.py` ; bloc de commentaire « SessionMiddleware » replacé au-dessus de son code (il précédait le relais d'hôte d'outils).

## `shared_infra/routes/__init__.py` — composition des routes

- **2026-09-04** — rangement par famille — les endpoints quittent ``shared_infra/routes/`` et vivent avec leur sujet ; le paquet ne garde que l'ordre d'enregistrement et les mécaniques transverses.
- outils externes et observabilité — routes ``/api/tokens*`` (jetons d'outils), ``/.well-known/*`` et ``/oauth/*`` (OAuth MCP), ``/api/tools/<famille>/*`` (OpenAPI) et ``/api/runs/*`` (exécutions) ajoutées à l'ordre d'enregistrement.

## `shared_infra/desktop/routes.py` — routes du bureau distant

- **2026-08-31** — audit — le PNG complet du frame était lu sur la boucle d'événements (E/S disque bloquante dans une route `async`) → lecture en thread (`api_desktop_frame`).
- **2026-09-30** — audit — le script d'automatisation recevait le jeton elpis-remote complet (`pcr_`) pour la vision `describe=` → jeton de vision `evt_` de 12 h, valable seulement pour `/api/desktop/locate` ; `pcr_` reste accepté pour les scripts qui l'ont reçu à leur lancement (`_vision_credentials`, `api_desktop_locate`).
- **2026-10-01** — nettoyage des tests — l'import de `_base_url` de `routes_cli`, censé suivre celui de `router` pour éviter un cycle, avait été remonté par le tri automatique des imports : importer `routes_cli` (ou ce module) en premier échouait (« partially initialized module ») → import fait à l'appel dans `api_desktop_install_sh` et `api_desktop_install_ps1`.
- audit — la garde « type sans effet » n'existait que sur le rejeu : sur le chemin Studio direct, une frappe substantielle qui ne change rien à l'écran (focus non posé) passait pour un succès → `semantic_click` activé pour `type`/`paste`, et `type_no_effect` rendu en 200 + `warning` (le pas reste enregistrable) plutôt qu'en 400 générique (`api_desktop_act`).
- audit — un acte par coordonnées pouvait s'exécuter sur un écran qui avait changé depuis la capture cliquée → signature du frame cliqué (`expect_sig`) vérifiée avant l'acte ; écran périmé → 409 `stale_frame` + frame frais (`api_desktop_act`, `_frame_fields`).
- audit — la propriété d'un frame n'était connue que du processus qui l'avait produit, et un propriétaire inconnu passait en mode souple → sidecar disque partagé entre processus ; propriétaire inconnu → 404 en mode strict (`DESKTOP_FRAME_STRICT_OWNER`), le soft-pass restant une échappatoire opérateur ; les frames antérieurs sans sidecar expiraient sous le TTL (900 s), impact de déploiement quasi nul (`api_desktop_frame`, `get_desktop_frame_owner`).
- constat sur VM — dans `run.bat`, « (une seule fois) » dans un `echo` d'un bloc `if (...)` fermait le bloc : le lanceur mourait sur « ... était inattendu » avant toute installation → aucune parenthèse dans ces `echo` (`_bundle_run_bat`).
- constat — un nom de cible explicite inconnu retombait sur la cible par défaut : l'arrêt visait le `run_id` sur une autre machine → refus 400 (`api_desktop_run_automation_stop`, `_resolve_target_strict`).
- constat — le refus de « .. » était testé par sous-chaîne et rejetait les noms contenant « ... » (captures d'échec « clic-Enregistrer-sous...-menuitem » introuvables) → test par segment de chemin (`api_desktop_run_file`).
- constat — un `.html` de rapport (ou déposé dans `assets/` par un autre compte sur une cible partagée) servi en ligne s'exécutait sous l'origine de l'application avec la session de celui qui l'ouvrait → seuls images et JSON servis en ligne, le reste en téléchargement sous CSP `sandbox` sans script (`api_desktop_run_file`).
- constat — un `timeout_s` non numérique (« abc ») faisait un 500 → entier tolérant, défaut 600, borné [30, 3600] (`_int_or`, `api_desktop_run_automation_matrix`).

## `shared_infra/opencode/routes_code.py` — routes opencode

- **2026-08-02** — audit — la revalidation périodique de session était câblée sur l'endpoint orphelin `/api/pipelines/events`, jamais sur le flux de la page Code, le seul réellement ouvert : une session expirée gardait transcript et demandes de permission en direct sans limite → revalidation sur ce flux, valeurs capturées au handshake (`code_stream`, `stream_session_still_valid`).
- **2026-09-01** — audit — tout le SQLite du long-poll tournait sur la boucle (`claim_commands` = BEGIN IMMEDIATE + DELETE + 3 SELECT, ~62 fois par pull de 25 s : ~2,5 prises/s du verrou d'écriture global par CLI connectée, en concurrence directe avec la persistance des chats), de même que la lecture du jeton → tout en thread, connexion par thread réutilisée côté `store` (`code_pull`, `_final_pull_bookkeeping`, `_token_uid`).
- **2026-09-01** — audit — le battement de 15 s par page ouverte faisait son sweep (BEGIN IMMEDIATE) et 4 lectures sur la boucle, chacun sur une connexion neuve → en thread, lectures regroupées en un seul saut (`code_health`, `_health_reads`).
- **2026-09-01** — audit — l'ingest, route du flux temps réel, écrivait le store (`seen_client`, `apply_events` sur tout le lot) et balayait les tables `code_*` (4 DELETE corrélés toutes les 60 s par worker) sur la boucle → écritures et prune en thread (`code_ingest`).
- **2026-09-20** — constat — `store` fait du SQLite synchrone (busy timeout 5 s derrière le BEGIN IMMEDIATE de `claim_commands`) et 14 routes `async` l'appelaient sur la boucle : un verrou tenu gelait les SSE de tout le worker → chaque appel au magasin part en thread, transactions d'appairage comprises (`_ThreadStore`, `code_pair_start`, `code_pair_poll`, `code_pair_confirm`).
- **2026-09-25** — audit du moteur d'événements — `_stream_gen` jetait tout ce qui n'était pas `code.event` : le `session_expired` de la revalidation, la cause d'une révocation, le `worker_recycling` d'une évacuation et l'`error` « trop de flux » n'arrivaient jamais, la page voyait une fin muette et se reconnectait en boucle → types de contrôle relayés dans une enveloppe `__control` (`_STREAM_CONTROL_TYPES`, `_render_code_event`).
- **2026-09-26** — passe d'optimisation — chaque message du bus était décodé puis ré-encodé pour la page → rendu une fois par message et par client, directement sur le dict du bus (`_render_code_event`).
- **2026-09-30** — audit — le jeton opencode était gardé en clair et réaffichable (panneau « Connecter opencode ») → seule l'empreinte reste, le jeton se montre une fois (création, rotation, appairage), un jeton par poste (`_mint_token`, `_rotate_token`, `code_config`, `code_token_create`).
- **2026-09-30** — audit — l'appairage posait le jeton en clair dans `code_pairings.token` jusqu'au poll → la confirmation ne pose que le compte, le jeton est créé à la livraison (`code_pair_confirm`, `code_pair_poll`).
- **2026-10-01** — nettoyage des tests — `_base_url` et `_make_sse_response` importés au niveau du module refermaient un cycle d'import avec le paquet des routes (`routes_cli` ou `routes_events` importé en premier échouait) → importés à l'appel (`code_config`, `code_plugin_ts`, `code_plugin_js`, `code_stream`).
- constat — l'epoch n'était pas persisté : le plugin re-snapshottait à chaque redéploiement → epoch persisté (`store.get_epoch`).
- constat — l'URL de l'app passait par des variables d'environnement à exporter côté CLI → URL injectée dans le plugin servi (`code_plugin_ts`).
- signalement utilisateur — « /new ne fait rien » : les plugins v7 à v12 se contentaient du raccourci `session.new` du TUI, or opencode ne matérialise la session qu'au premier message, rien n'apparaissait dans la page → plugin v13 exigé, 409 explicite sinon (`code_new`).

# Journal ricochet — lot A

## `llm_core/_think_tokens.py` — mesure des tokens de raisonnement d'un tour

- **2026-08-21** — audit long-run — sur une mission longue, le raisonnement cumulé d'un run atteignait plusieurs mégaoctets : le `POST /tokenize` expirait sur son timeout de 5 s après avoir sérialisé le corps et empoisonné le cache LRU, pour retomber de toute façon sur l'estimation → au-delà de `TOKENIZE_MAX_CHARS`, estimation directe sans tenter l'appel exact (`measure_thinking_tokens`).
- **2026-08-23** — audit — `annotate_thinking_tokens`, sans importeur ni test, se présentait comme le raccourci des chemins classic et outils alors que les deux appelaient `measure_thinking_tokens` directement → supprimée ; point d'entrée unique (`measure_thinking_tokens`).
- **2026-09-16** — audit (cible par serveur) — `/tokenize` ne visait que le serveur intégré → il vise le serveur de la cible, la mesure exacte est gardée par `is_llamacpp` (`measure_thinking_tokens`).

## `llm_core/_target.py` — cible d'inférence résolue par requête

- **2026-09-16** — audit (cible par serveur) — les appels propres au moteur (`/props`, `/tokenize`, `/slots`, `/models`) ne valaient que pour `LLAMA_URL` → ils suivent la cible (`llm_core.engines.current_engine`) pour tout serveur llama.cpp ; `is_local_llamacpp` garde ce qui n'existe que pour l'intégré (`LlmTarget.is_llamacpp`).
- **2026-09-16** — audit — le repli sur l'intégré était silencieux, y compris sur une exception de déchiffrement : avec deux serveurs aux noms de modèles identiques, l'intégré répondait sans erreur à la place du serveur choisi → la route de chat (puis compression et routines) résout en `strict` et lève `EngineUnavailable` (`resolve_llm_target`).
- **2026-09-16** — audit — `llm.allowed_provider_types` n'était vérifié qu'à la création : retirer un fournisseur laissait servir indéfiniment les connecteurs perso déjà créés → revérifié à chaque résolution pour les connecteurs d'utilisateur, raison `provider` (`_provider_allowed`, `resolve_llm_target`).
- correctif — avant les connecteurs, le backend ne parlait qu'à un seul llama-server global (`LLAMA_URL`) → la cible est posée par requête dans un contextvar ; sans cible posée, `current_target()` rend le connecteur llama.cpp intégré (`LlmTarget`, `current_target`).

## `llm_core/memory/_builtin_provider.py` — provider de mémoire Markdown (snapshot figé par tour)

- aucune décision retirée — renvoi seul corrigé (`chats.py` → `chatbot_app/turn/preparation.py`, où le gestionnaire de mémoire est construit par requête).

## `llm_core/_think_resume.py` — primitives pures de reprise d'un raisonnement ou d'une prose coupés

- **2026-08-21** — audit long-run — seul le raisonnement coupé était repris in-run ; une réponse en prose coupée par le plafond ou par un flux interrompu finissait en `truncated` + bannière « Continuer », fatal pour une mission autonome que personne ne relance → reprise de la prose in-run en mode natif seulement (`continue_final_message`), jamais par consigne (risque de redite) (`should_auto_resume_content`, `build_content_resume_tail`, `MAX_RESUME_CONTENT_CHARS`).
- correctif — la marge de fenêtre se calculait `last_prompt_tokens + think_tokens_done`, comptant deux fois le raisonnement déjà contenu dans le prompt du segment : la reprise était refusée vers la moitié de la fenêtre réelle → occupation réelle mesurée à la fin du segment coupé (`should_auto_resume`, paramètre `window_tokens`).
- correctif — un partiel de transport (ReadTimeout, reset TCP, fin SSE sans `finish_reason`) bloquait la reprise : chaque micro-coupure réseau devenait une fin de run sur les missions longues → `partial` éligible, le retry/backoff et les plafonds bornent l'acharnement (`should_auto_resume`).

## `llm_core/context_config.py` — source unique des textes et réglages injectés au LLM

- correctif — l'estimation de tokens de la validation des budgets utilisait un ratio fixe de 0,25 token par caractère, qui divergeait des autres estimations de l'app → ratio unifié de `llm_core._token_estimate`, `budgets.tokens_per_char` restant prioritaire (`ContextConfig.est_tokens`).

## `llm_core/providers/llama_stream.py` — flux SSE reprenable de llama-server

- **2026-08-22** — vérification en conditions réelles (b10545, mode routeur) — client coupé au bout de 25 caractères : `lookup` répond `is_done:false`, la reprise rejoue le début puis la suite, `DELETE` renvoie 204 → contrat du flux reprenable retenu tel que décrit en tête de module (`resume_request`, `lookup_streams`, `cancel_stream`).
- **2026-08-23** — audit — `user_id` entrait dans la clé HMAC alors que le harnais passait le nom d'utilisateur et la route d'annulation l'identifiant numérique : le `DELETE /v1/stream` visait une session inexistante, le 404 était classé en succès, et la génération tournait jusqu'à l'EOS sur le slot GPU pendant que la bannière annonçait « annulé » → la clé ne porte que le chat, comme `shared_infra/llm/reasoning_control` (`conversation_id`).
- **2026-09-16** — audit (cible par serveur) — le signal de vie observé était mémorisé par nom de modèle seul : un ping vu sur un connecteur valait pour le modèle homonyme de l'intégré → mémoire par (serveur, modèle) (`_alive_key`).

## `llm_core/_system_prompts.py` — assemblage du message système (socle, mémoire, skills, fragments de capacité)

- **2026-09-11** — correctif (manifeste des familles MCP) — les fragments de capacité ne venaient que des tables codées : une famille nouvelle ou un serveur déclaré ne pouvait pas apporter son guide → fragments déclarés par le manifeste `mcp.json` (`x-elpis.prompt_fragments`), qui surchargent le stem d'une catégorie connue ou ajoutent celui d'une catégorie nouvelle, une catégorie d'action gardant son étage (`_manifest_fragments`, `build_capability_block`).
- refonte — chaque chat ou agent recevait un bloc `# Tool Protocols` concaténant `system_prompts/<category>.md` par catégorie d'outils active, en doublon avec les descriptions MCP et payé en tokens à chaque tour → bloc et fichiers retirés, `active_mcp_servers` accepté mais ignoré, cadrage par fragments de capacité (`assemble_system_messages`, `build_capability_block`, `list_known_categories`).
- audit — un skill de `learned/` (brouillon non promu) était injecté pour tous → découverte avec `include_learned=False` (`_build_skills_block`).
- correctif — les corps des skills pertinents étaient pré-injectés d'après le dernier message, et les skills montés dans `/work` → modèle full-pull : seuls les corps épinglés sont injectés, le reste se charge via `skill_get`, `skill_read_file`, `skill_run_script` (`_build_skills_block`).
- correctif — épingler un skill sans activer la catégorie d'outils « skill » (état par défaut) perdait silencieusement la procédure demandée → les corps épinglés sont injectés même catégorie OFF, sous l'en-tête « attachés » et sans index (`assemble_system_messages`).

## `llm_core/_llm_retry.py` — retry/backoff LLM partagé et taxonomie des pannes

- **2026-07-24** — audit du harnais — un seul retry après un sommeil fixe de 0,6 s → classification fatal/transitoire, backoff exponentiel plafonné à full jitter, attente de `/health` sur le 503 de chargement d'un modèle (`llm_error_is_fatal`, `backoff_delay`, `retry_pause`, `wait_llama_ready`).
- **2026-08-21** — audit long-run — un `ConnectError` n'ouvrait aucune attente : le backoff seul (~45 s) ne couvre pas un redémarrage de llama-server, et une mission autonome de six heures mourait sur un redémarrage de 60 s → attente de `/health` quand un appel a déjà abouti sur ce serveur, échec rapide sinon (`note_llm_success`, `_engine_was_alive`, `retry_pause`).
- **2026-09-12** — constat en production — OpenCode Zen répond 400 « OpenCode's free tier can only be used in OpenCode », un refus d'offre classé en requête invalide → motifs d'accès, famille `forbidden` (`_ACCESS_MARKERS`, `llm_error_kind`).
- **2026-09-16** — audit (cible par serveur) — l'historique des succès et la sonde `/health` ne visaient que l'intégré → tenus par serveur de la cible, l'attente valant pour tout serveur llama.cpp (`_last_success_by_engine`, `wait_llama_ready`, `retry_pause`).
- **2026-09-24** — audit — le 409 était classé fatal et abandonnait au premier essai avec « réessayer donnera le même résultat » → 408, 409 et 429 restent transitoires (`llm_error_is_fatal`).
- **2026-09-24** — audit — l'en-tête `Retry-After` n'était jamais lu : sur un 429 « Retry-After: 20 », les tentatives partaient en ~4 s et échouaient toutes → délai honoré (secondes, date HTTP ou `retry-after-ms`), borné à `_RETRY_AFTER_CAP_S` (`retry_after_seconds`, `retry_pause`).
- correctif — sans levée d'exception, un stop pendant le backoff laissait partir une tentative de plus (« le modèle repart après stop ») → attentes découpées qui lèvent `CancelledError` (`_cancel_aware_sleep`).
- correctif — un 400 « conversation trop longue » et un 400 « schéma d'outil invalide » ressortaient tous deux en « Requête LLM rejetée par le serveur : Client error '400 Bad Request' … » → taxonomie des pannes et message actionnable par famille (`llm_error_kind`, `_KIND_MESSAGES`).
- correctif — l'explication du fournisseur était jetée : un refus précis s'affichait « raison inattendue » → conseil suivi du message du fournisseur (`llm_error_user_message`, `provider_message`).
- correctif — l'erreur SSE en cours de flux et l'adaptateur Anthropic levaient des `RuntimeError` nues, classées UNKNOWN (pas de compaction sur « prompt is too long », pas de backoff sur 429/529, 401 pris pour un historique empoisonné) → erreur HTTP complète `ProviderError` (`provider_http_error`).
- aucune décision retirée — `retry_pause` : l'attente de `/health` vaut pour toute cible llama.cpp (intégré ou connecteur), pas la seule cible locale ; un récit à l'imparfait mis au conditionnel.

## `llm_core/providers/anthropic.py` — adaptateur natif de l'API Messages d'Anthropic

- **2026-08-23** — audit — le chemin classic rendait un `meta` amputé de `finish_reason`, `truncated`, `truncated_in_think` et `thinking_tokens` : une réponse Claude coupée par `max_tokens` arrivait tronquée sans bouton « Continuer », et toute la réflexion était comptée comme réponse ; la traduction du `stop_reason` n'existait que sur le point d'entrée outils → champs posés, traduction factorisée et partagée (`anthropic_chat_stream`, `_finish_from_stop_reason`).
- **2026-09-21** — correctif — un `tool_use` coupé par `max_tokens` (JSON incomplet) remontait en « tool_calls » et s'exécutait avec `{}`, la garde de troncature de la boucle n'étant jamais atteinte → « length » prime sur « tool_calls », et des arguments illisibles valent coupure (`_finish_from_stop_reason`, `_consume_stream`).
- **2026-09-24** — audit — un message sans contenu utile partait en bloc texte vide (400) → messages vides omis, rôles consécutifs identiques fusionnés, `tool_result` en tête du user (`to_anthropic_messages`, `_merge_same_roles`).
- **2026-09-24** — audit — une requête sans `tools[]` contenant des `tool_use`/`tool_result` passés était refusée (400), et les blocs `thinking` signés n'étaient pas rejoués devant les `tool_use` → appels et résultats rendus en texte quand `with_tools=False`, rejeu de `_anthropic_thinking` dans la boucle d'outils (`to_anthropic_messages`).
- **2026-09-24** — audit — `adaptive` était envoyé à tous les modèles : Haiku 4.5, Sonnet/Opus 4.5 et antérieurs répondaient 400 à chaque message avec le raisonnement activé → `enabled` + `budget_tokens` avant 4.6, pas de raisonnement avant 3.7 (`thinking_config`).
- **2026-09-24** — audit — une réponse HTTP en erreur levait une `RuntimeError` nue, classée UNKNOWN (pas de compaction, pas de backoff, 401 pris pour un historique empoisonné) → erreur typée via `provider_http_error` (`_consume_stream`).
- **2026-09-24** — passe robustesse — le chemin classic court-circuite la boucle de `llama_chat_stream_tokens` : un 429/529 « overloaded » échouait au premier essai, sans backoff, avec le JSON brut du fournisseur dans la bulle → relances tant que rien n'est streamé et que l'erreur n'est pas définitive, message final par la taxonomie commune (`anthropic_chat_stream`).

## `llm_core/_mcp_wrappers.py` — adaptateurs de transport MCP (stdio, SSE, HTTP streamable, en processus) et routage des logs

- **2026-08-21** — audit long-run — le repli « appeler, rattraper `TypeError`, rappeler » ne distinguait pas un kwarg inconnu du SDK d'un `TypeError` levé dans le corps de l'outil, et rejouait l'appel jusqu'à 3 fois : sur un outil mutant, l'effet de bord s'appliquait deux ou trois fois (« il a écrit deux fois ») → signature inspectée et mémoïsée, `TypeError` du corps remonté tel quel (`_session_supports`, `MCPStdioWrapper.call_tool`, `MCPSSEWrapper.call_tool`).
- **2026-08-22** — audit — un seul emplacement de callback de log par session, alors que les transports SSE/HTTP passent plusieurs appels de front depuis le passage du pool au sémaphore (audit du 2026-08-01) : la sortie du terminal en direct d'un utilisateur partait dans le flux d'un autre, puis le terminal devenait muet → routeur par appel (identifiant du pont shell, appel unique en vol, nom d'outil, sinon rejet) (`_LogRouter`).
- **2026-08-23** — audit — `call_id` seul n'est unique qu'au sein d'un run, et le routeur est partagé par tous les comptes du worker : deux appels concurrents se volaient l'emplacement → jeton `log_token` tiré par run en priorité, `call_id` en repli (`_log_call_token`).
- **2026-08-23** — audit — un jeton déjà enregistré était écrasé : la sortie du voisin partait chez le nouveau venu, puis le premier `unregister` coupait les deux → jeton anonyme sur collision, jeton effectif rendu à l'appelant (`_LogRouter.register`).
- **2026-08-23** — audit — depuis fastmcp 2.14, `params.data` arrive en dict `LogData` : la garde `isinstance(data, str)` rendait None pour toutes les notifications réelles et le routage par identifiant était inerte → déballage de `msg` (`_LogRouter._call_id_of`).
- **2026-08-23** — audit — session et transport se quittaient dans un même try : l'`ExceptionGroup` de la session sautait la sortie du transport, l'erreur était avalée par le pool et `server/local_mcp_server.py` restait vivant toute la vie du worker → un objet, un try (`MCPStdioWrapper.__aexit__`, `MCPSSEWrapper.__aexit__`).
- **2026-09-11** — refonte du service d'outils — la sentinelle `DEFAULT_LOCAL_PYTHON` ne lisait que la config (`LOCAL_MCP_URL`) → alias de l'entrée `role: toolhost` du manifeste `mcp.json`, synthétisé depuis la config héritée en l'absence de fichier (`_resolve_mcp_client`).
- **2026-09-11** — refonte du service d'outils — l'identifiant d'appel des sorties shell se lisait en JSON dans le message → notification structurée `{"msg", "extra"}` avec `extra.kind` et l'identifiant (`_LogRouter._call_id_of`).
- **2026-09-12** — refonte du service d'outils — une seule entrée toolhost servait toutes les familles → une entrée par famille désignée par `cfg["manifest"]`, une sentinelle nue retombant sur la première entrée toolhost (`_resolve_mcp_client`).
- **2026-09-12** — refonte du service d'outils — les familles liées au compte n'avaient pas de transport en mémoire → MCP interne de l'app servi dans le processus (`role: app`) (`MCPInProcessWrapper`, `_resolve_mcp_client`).
- **2026-09-25** — audit — seule la première page de `tools/list` était lue : un serveur qui pagine n'exposait qu'une partie de ses outils, et le modèle recevait « outil inconnu » pour les autres → pagination suivie, bornée en pages et en nombre (`_list_all_tools`, `_LIST_TOOLS_MAX_PAGES`, `_LIST_TOOLS_MAX`).
- audit — le sous-process de repli pouvait hériter d'un mode service lu dans le manifeste ou la config → `LOCAL_MCP_TRANSPORT=stdio` posé explicitement (`_resolve_mcp_client`).
- correctif — le repli stdio lançait le `python3` du PATH, parfois le python système dont les dépendances (pydantic/fastmcp) divergent du venv : l'enregistrement des outils échouait au démarrage → `sys.executable` (`_resolve_mcp_client`).
- correctif — la boucle de chat affichait la trace brute du task group sur un échec de connexion → message actionnable partagé avec le bouton « Tester » (`friendly_mcp_error`).
- évolution — l'identité de l'appelant voyage en request meta MCP, invisible du LLM ; sur un SDK sans ce kwarg l'appel part sans meta et le serveur résout « guest » (`MCPStdioWrapper.call_tool`).
- évolution — callbacks facultatifs `progress_callback` et `log_callback`, traduits en events `tool_progress` / `tool_log` (`MCPStdioWrapper.call_tool`).
- évolution — en-têtes de transport (`headers`, `authorization`, `basic_auth`) pour SSE et HTTP streamable (`_build_auth_headers`, `MCPSSEWrapper`).
## `llm_core/tools/memory_tools.py` — outils MCP de mémoire longue (`memory`, `session_search`)

- **2026-06-12** — retrait de fonctionnalité — la liste TODO de chat (todo_plan / todo_add / todo_update…, ressource et prompt MCP, routes `/api/memory/todos`, interface) vivait dans ce module → retirée en entier ; restent la mémoire longue et le rappel plein texte des sessions.
- **2026-09-02** — audit — l'identité de la mémoire était résolue par une implémentation parallèle qui ne lisait que le `meta` : un client externe authentifié comme `alice` pouvait lire/écrire la mémoire et l'historique (`session_search`) de n'importe quel compte en déclarant `_meta.username` → délégation à `_toolkit.get_username` / `get_chat_id` : jeton Bearer d'abord, puis `meta`, puis `guest` (`_identity`).
- **2026-09-11** — audit — `memory_scope` lu dans le `meta` et posé par aucun appelant (code mort) → portée fixe, celle du compte (`_MEMORY_SCOPE`).
- **2026-09-19** — retour court de l'outil mémoire — journal des écritures effectives : détail avant/après et annulation depuis le fil du chat, origine des notes dans les Réglages ; best-effort, un journal en panne ne fait pas échouer une écriture réussie (`_journal.append` dans `memory`).
- **2026-09-21** — correctif — `store` facultatif avec défaut : la grammaire llama.cpp le rangeait après les autres facultatifs, un modèle qui écrivait `content` d'abord ne pouvait plus le poser et un fait de profil partait en silence dans MEMORY.md → `store` obligatoire, même règle que todowrite (`memory`).
- correctif — une action inconnue retombait en silence sur `add` et ajoutait une entrée parasite → erreur `bad_action` (`memory`).
- aucune décision retirée — docstring publiée de `SessionMatch` corrigée (elle disait « jamais le message entier » alors que la lecture par `ref` rend le passage entier) ; étiquette « Ciblage v2 » retirée de l'en-tête du module.

## `llm_core/tools/_mcp_error_middleware.py` — conformité MCP du flag `isError`

- **2026-06-05** — revue de conformité MCP — les enveloppes `{ok:false}` de `_toolkit.err()` sont un retour normal : FastMCP les publiait avec `isError: false` et un client MCP tiers les voyait comme des succès → middleware qui ré-émet l'enveloppe en `ToolError`, enveloppe gardée comme payload texte (`OkFalseAsIsError`).

## `llm_core/tools/_models.py` — modèles Pydantic de sortie des outils MCP

- **2026-07-31** — audit — les bornes d'`ask_user` (8 questions, 12 options, 300 c) s'appliquaient en silence : le modèle croyait avoir posé 10 questions et attendait 10 réponses → champ `warning` (`AskUserResult`).
- sorties structurées — chaque outil renvoyait `Dict[str, Any]`, d'où un `outputSchema` plat, inutile au modèle → un modèle de succès Pydantic par outil, enveloppe d'erreur inchangée sur le fil (`_SuccessBase`, `ErrEnvelope`).
- aucune décision retirée — docstring publiée d'`ErrEnvelope` : étiquette interne « v17 » retirée (« Mirrors the error contract the chat frontend parses »).

## `llm_core/tools/firefox_tools.py` — outils navigateur Playwright (`pw_*`)

- **2026-08-08** — constat en mission (agent `web`) — la même notion « quel geste » portait cinq noms selon l'outil (`action`, `op`, `do`, `assertion`, `mode`), de même pour la valeur (`v`/`value`) et la cible (`target`/`selector`) : deux appels sur dix de la mission web partaient en erreur de schéma → synonymes acceptés partout, nom canonique prioritaire, rien de renommé (`_first`, `_merge_value`, `_merge_target`, `pw_verb`).
- **2026-08-08** — audit — `pw_find` documentait `selector=` sans l'avoir dans sa signature : `pw_find(selector="#x")` partait en erreur de schéma → `selector=` et `target=` convergent vers le DSL (`_merge_target`).
- **2026-08-08** — constat en mission (agent `web`) — `pw_session(action='start')` sans `url` renvoyait `ok` avec `url="about:blank"` : l'agent croyait sa session prête et inspectait une page vide → refus `url_required` qui nomme les deux sorties possibles (`session`).
- **2026-08-08** — audit — `/handle_dropdown` du service (select natif, input + autocomplete/datalist, dropdown custom, shadow DOM) n'était relié à aucun outil : un combobox à base de div obligeait à ouvrir puis cliquer l'option en devinant son sélecteur → geste `pick` (`act`).
- **2026-08-08** — audit — `pw_page(action='extract')` ne transmettait pas le sélecteur : sur une page à plusieurs tableaux, toujours le premier → `selector` transmis (`page`).
- **2026-08-08** — constat en mission (agent `web`) — `pw_page(action='text')` envoyait `"selector": null` ; le défaut JS du service (`selector = 'body'`) ne s'applique qu'à `undefined`, d'où `cannot_read_properties_of_null_reading_r`, illisible pour l'agent → clé omise quand l'appelant n'en fournit pas (`page`).
- **2026-08-23** — audit — le registre de propriété des sessions (sidecar disque cross-worker, posé la veille) n'avait qu'un consommateur, la route des captures PNG : côté outils, rien ne vérifiait à qui appartenait le `session_id` reçu du modèle, et un compte qui obtenait un identifiant (`pw_session(action='list')` le donne, avec le propriétaire et l'URL) pouvait lire et piloter la session authentifiée d'un autre → refus anticipé dans chaque `pw_*` (`_refus_session_d_autrui`).
- **2026-08-23** — audit — `pw_memory(action='sites')` publiait `cred_username` pour tous les sites connus → vue bornée au compte appelant (`list_sites_with_stats(owner=…)`).
- **2026-09-05** — audit des outils web — le `status` chaîne du service (`"success"`) heurtait un `status: int` : le client MCP rejetait la réponse (`-32602 … status must be integer`) et la capture, pourtant écrite, n'était jamais vue → sortie de capture stable, sans `status` textuel (`_screenshot_result`).
- **2026-09-05** — audit des outils web — le service savait glisser (type `drag`) mais l'outil ne l'exposait pas, et un clic simple ne déplie pas un nœud de CellTree GWT → gestes `drag`, `expand`, `collapse` (`act`).
- **2026-09-05** — audit des outils web — `pw_wait` passait `selector=` brut à `document.querySelector` : une forme DSL (`css=#finish`) levait une exception avalée par la boucle de polling et l'attente expirait, alors que `pw_expect text-contains` passait en 8 ms sur la même cible → même résolution que `pw_expect`, DSL → by_* + chaîne de repli (`wait`).
- **2026-09-05** — audit des outils web — `pw_chain` rendait ses étapes sans jamais montrer la page qui en résulte → observation attachée comme sur `pw_act` (`_finish_act`).
- **2026-09-11** — outils portables — sur un hôte d'outils distant, la boucle de chat, qui enregistrait la propriété de session, vit ailleurs → propriété posée par l'outil (`record_pw_session_owner` dans `session`).
- **2026-09-30** — correctif — un propriétaire inconnu du registre valait passe-droit → session refusée, `pw_session(action='start')` la rend ; propriétaire transmis au service navigateur à chaque requête, qui ne sert une session qu'à son propriétaire (`_PW_OWNER`, `_avec_proprietaire`).
- correctif — la liste d'outils de `CATEGORY`, tenue à la main, avait dérivé (pw_inspect/pw_locate/pw_navigate déclarés sans être enregistrés, pw_expect/pw_mock/pw_observe absents) → liste capturée à l'enregistrement (`CATEGORY`).
- regroupement — les outils de test IHM et d'observation vivaient dans `firefox_tools_extras.py`, à enregistrer à part → fusionnés dans ce module.
- correctif — `_err("x", message=…, fix=…)` levait un `TypeError` (`fix` passé deux fois à `_toolkit.err`) : un garde-fou écrit ainsi plantait au lieu de renvoyer son enveloppe → paramètres `message=` / `fix=` (`_err`).
- correctif — `/chain` ne recevait que des chaînes de sélecteur comme `role=button[name="X"]`, invalides pour `page.locator()`, qui échouaient en silence → by_* explicites + chaîne de repli (`chain`).
- correctif — le service ne recevait que des by_* : son échelle « smart » (ancêtre porteur du handler GWT/GXT, recherche dans les iframes, repli aria-label/placeholder/title) était injoignable et un locator officiel en échec rendait un 500 sec → sélecteur de repli joint à la requête (`act`).
- correctif — le service devinait si l'option choisie était une `value=` ou un libellé, 10 s de timeout au cas le plus courant (choisir par le texte affiché) → `option_label` / `option_value` explicites (`act`).

## `llm_core/engine/tool_exec.py` — exécution d'un lot d'appels d'outils

- **2026-08-21** — audit long-run — `log_metric` / `record_metric`, écritures SQLite synchrones, tournaient sur la boucle asyncio du worker à chaque appel d'outil : une écriture en contention (`busy_timeout` de 10 s, plusieurs workers en WAL) gelait tout le worker, flux SSE, heartbeats et drain compris → écritures déportées hors event loop (`_write_telemetry`).
- **2026-08-21** — audit long-run — `asyncio.gather` sans `return_exceptions` laissait tourner les frères après la première exception : sur un Stop détecté via `is_cancelled`, écritures fichier, commandes shell et commits git s'exécutaient après la fin du run → attente du premier échec, annulation et attente réelle des frères (`_gather_batch`).
- **2026-08-23** — audit — dict de résultats purement local : sur annulation réelle, les résultats des outils déjà terminés (les mutants, exécutés en premier, effet déjà appliqué) étaient perdus avec la pile et « Continuer » les rejouait → `results_out` fourni par l'appelant, rempli en place (`execute_tool_batch`).
- **2026-09-11** — notifications structurées — `extra.kind` des journaux MCP : `heartbeat` consommé sans événement, `shell_output` en événement NDJSON dédié ; sentinelle JSON gardée en repli pour un serveur sans `extra.kind` (`_log_cb`).
- **2026-09-19** — économie de jetons — la liste structurée de `todowrite` renvoyée au modèle doublait le coût en jetons de chaque mise à jour → le modèle ne voit que la forme courte (`checklist` + compteurs), la liste ne sert qu'au panneau (`todo_updated`).
- **2026-09-24** — audit — des arguments illisibles faisaient tourner l'outil avec `{}`, sur ses défauts → l'outil ne tourne pas et le modèle reçoit l'erreur (`args_error`).
- **2026-09-24** — audit — un Stop pendant l'écriture télémétrique, hors lot parallèle, ne prenait aucun snapshot alors que l'outil avait déjà tourné : « Continuer » rejouait l'écriture → snapshot avant de propager (`_exec_one`).
- **2026-09-26** — audit — les écritures télémétriques, non attendues au-delà de `_TELEMETRY_WAIT_S`, s'empilaient sous contention SQLite dans le pool par défaut, celui des outils intégrés (`to_thread`), qui attendaient un thread libre jusqu'à leur propre délai → pool dédié de 2 threads (`_telemetry_pool`).
- **2026-09-26** — optimisation — l'attente sans limite de la télémétrie retenait le résultat de l'outil, donc l'itération suivante, jusqu'à 10 s de `busy_timeout` → attente bornée (`_TELEMETRY_WAIT_S`), le thread finit seul sous `shield`.
- refactor — la harness d'exécution était copiée-collée (~110 lignes) entre le canal natif et le canal texte de `run_chat_multi_mcp`, sans callbacks progress/log côté texte → ordonnanceur unique pour les deux canaux (`execute_tool_batch`).
- correctif — un `ExceptionGroup` anyio stringifié brut ne livrait que « unhandled errors in a TaskGroup » : la cause réelle (ex. `ValidationError` sur un argument) était perdue et le modèle retentait à l'aveugle → feuilles dépliées, dédupliquées, bornées (`flatten_exception_message`).
- correctif — un `CancelledError` fui d'un cancel-scope anyio traversait les `except Exception` et terminait le run comme un Stop, et un `BaseExceptionGroup` contenant un `CancelledError` tuait le run entier → tri annulation réelle / fuite (`_real_cancellation`).
- audit — dans un lot parallèle, chaque frère annulé prenait son snapshot d'annulation (N snapshots, pris avant la fin des frères) et les exceptions des frères restaient non consultées (« Task exception was never retrieved ») → un seul snapshot après drain, toutes les exceptions consultées (`_gather_batch`).
- relecture — le compteur d'appels de l'exécution, incrémenté dans le fil de télémétrie, pouvait arriver après l'écriture finale de l'exécution, qui montrait alors 0 appel → compté dans la boucle (`add_tool_call`).
- observabilité — durée de chaque appel portée par l'event `tool_result` (`duration_ms`).

## `llm_core/engine/stream_events.py` — registre des événements du flux NDJSON

- **2026-09-29** — registre des événements — un type d'événement pouvait être émis sans lecteur, ou lu sans émetteur, sans que rien ne le signale → registre `STREAM_EVENTS` (groupes `LOOP_EVENTS`, `NOT_DISPLAYED`), vérifié par test.

## `llm_core/context/budget.py` — ratios et planchers de la fenêtre de contexte

- **2026-07** — audit — ratios de la fenêtre éparpillés en littéraux (0.18/3072 dans la boucle, 0.75 inline, 0.50/3.5 pour la compaction, tiers 0.12/0.04/0.008 et split 0.7 dans les corps de fonctions, 12000/2500/200 en module), aucun dans `context_config`, qui ne gouvernait que le wording → dataclass gelée, surchargeable à froid par la section `budgets` (`ContextBudget`, `BUDGET`).
- **2026-07-28** — harnais v4 — cap d'émission d'un résultat d'outil exprimé en caractères (8000 ch, 55k ch à 262k, plafond 100k ch) → cap en tokens dérivé du n_ctx, coupe unique à l'émission (`emit_cap_min_tokens`, `emit_cap_ratio`, `emit_cap_max_tokens`).
- **2026-08-01** — audit — `keep_recent_msgs` à 10 ne sanctuarisait que 5 cycles d'outil : le modèle perdait le contexte immédiat de ce qu'il venait de faire dès que le budget serrait → 16 (`keep_recent_msgs`).
- harnais v4 — vagues d'élagage par itération pilotées en caractères (trigger/protect/min_reclaim/level ×3.5) → élagage en fin de tour, en tokens, avec marques persistées (`pruning.select_prune_keys`).
- audit — réserve de sortie inférieure au cap de génération : finish=length en plein tool_call → réserve au moins égale au cap de génération (`reserve_tokens`).

## `llm_core/context/__init__.py` — paquet de gestion de la fenêtre de contexte

- **2026-07** — audit — la question « combien pèse ce prompt et que doit-il contenir ? » passait par ≥ 5 chemins de code avec 3 ratios différents, éparpillés dans la boucle (sous-système privé de 260 lignes), `rag_tools`, `context_config` et le compresseur → paquet `llm_core.context`, une responsabilité par module.

## Schémas de sortie publiés (`llm_core/tools/_models.py`, `llm_core/tools/memory_tools.py`)

- **2026-08-23** — audit — le mode détaché d'`execute_shell` n'avait aucune branche dans l'`outputSchema` : la validation de sortie levait après le lancement du processus, le modèle relançait un processus en double → modèle dédié (`BackgroundShellResult`).
- **2026-09-05** — audit des outils web — `status` typé entier seul rejetait `{"status": "success"}` et `{"status": "found"}` côté client MCP (capture inutilisable alors qu'elle existait) → entier ou chaîne (`PWPageResult`) ; une étape de chaîne en échec devenait une erreur de schéma `-32602` → `ok` booléen (`PWChainResult`).
- **2026-09-12** — correctif — `ref`/`table_id` requis alors que le défaut rend `table_markdown` : « Invalid structured content » côté SDK client → les deux formes valides (`GenerateTableResult`).
- **2026-09-19** — optimisation de la mémoire — la réponse d'écriture renvoyait tout le magasin, et la recherche le message entier (~14 000 caractères) → retour court (`MemorySaved`) et extrait autour des mots trouvés (`SessionMatch`).
# Journal ricochet — lot C

## `llm_core/tools/fs_tools.py` — outils fichiers MCP de la sandbox (read_file, write_file, edit_file, list_files, manage_files, code)

- **2026-06** — audit — `expected_sha256` était un check-then-write sans verrou : deux écritures concurrentes (workers gunicorn différents) lisaient le même sha puis écrivaient toutes deux, le « verrou optimiste » ne verrouillait rien → flock advisory par fichier, sidecar hors sandbox, fail-open, kill switch `FSTOOLS_FLOCK=0` ; sha re-vérifié au remplacement dans edit_file (`_optimistic_write_lock`, `_ecrire_garde`).
- **2026-07** — correctif — l'écriture encodait en `errors="replace"` : caractères non représentables substitués en silence (`?`/U+FFFD), corruption invisible → encodage strict, échec `encoding_mismatch` avec la position (`write_file`).
- **2026-07-04** — consolidation des outils — `stat_path` absorbé par list_files/read_file, `code_outline` + `code_navigate` fusionnés dans `code` : six outils (`register`).
- **2026-08-08** — audit des agents (mesuré en direct) — un sous-agent `explore` appelant list_files avec `include_hidden=True` sans `exclude` ramenait 500 chemins de `.venv/.../site-packages` : +9 000 tokens de contexte en un appel, re-facturés à chaque itération → socle d'exclusions des dossiers de dépendances, annoncé dans la réponse (`DEFAULT_DEP_EXCLUDES`, `excluded_default`).
- **2026-08-08** — correctif — le `rel` des entrées de list_files était relatif au dossier listé et menait read_file à « not_found » → `rel` relatif à la sandbox (`list_files`).
- **2026-08-23** — audit — le format porcelain de git parle depuis la racine du dépôt alors que les consommateurs indexent par dossier listé : dès qu'on listait un sous-dossier, aucune clé ne correspondait et l'annotation git disparaissait en silence → ré-ancrage par `git rev-parse --show-prefix` (`_git_status_map`).
- **2026-08-23** — audit — l'append relisait le fichier en `errors="replace"` : un fichier latin-1 / cp1252 / utf-16 était réécrit mutilé (U+FFFD), perte définitive avec `ok: true` (le durcissement de 2026-07 ne couvrait que l'encodage de sortie) → décodage strict et échec propre (`write_file`, mode append).
- **2026-08-23** — audit — pagination de list_files → reprise par identité de l'entrée du curseur dans l'ordre de page, depuis le début si elle a disparu (`list_files`).
- **2026-09-23** — audit de l'éditeur — l'éditeur et l'agent avaient chacun leur verrou : une écriture de l'agent tombée entre le contrôle et le `mv` de `/api/sandbox/save` était écrasée sans un mot ; le verrou n'était pris qu'avec `expected_sha256` → verrou commun `shared_infra.sandbox.file_lock`, pris à chaque écriture, plusieurs chemins dans un ordre stable (`_optimistic_write_lock`, `_locks_for`, `register`).
- **2026-09-23** — audit de l'éditeur — read_file rendait en silence un décodage avec remplacement et ne signalait jamais CRLF ni BOM : le modèle réécrivait ensuite en LF/UTF-8 sans BOM ou perdait les octets remplacés → champs `lossy`, `line_endings`, `bom` (`_text_conventions`).
- **2026-09-23** — audit de l'éditeur — l'écrasement complet retirait BOM et CRLF et réécrivait en UTF-8 un fichier latin-1 lu « réparé » → conventions du fichier gardées, `encoding_mismatch` sinon ; l'append garde les CRLF (`write_file`).
- **2026-09-23** — audit de l'éditeur — edit_file sur un fichier à fins de ligne mixtes passait en LF sans que le diff le montre → `normalized_line_endings` et note (`edit_file`).
- 2026-09-23 — historique de session des fichiers modifiés : chaque écriture, suppression ou déplacement réussi est noté, jamais bloquant (`_history_writer`, `_history_move`).
- **2026-09-25** — audit — read_file chargeait tout fichier texte (`read_bytes()` + décodage + `splitlines()` ≈ 4× sa taille) dans le processus d'outils partagé : un `tail` sur un journal de 2 Go le tuait → lecture en flux au-delà de `_STREAM_READ_OVER` (`_read_large_text`).
- **2026-09-25** — audit — `list_files(search_text=…)` sautait en silence les fichiers de plus de 300 Ko → lecture ligne à ligne jusqu'à 20 Mo dans l'agent, fichiers écartés comptés et signalés (`_SEARCH_MAX_BYTES`).
- **2026-09-25** — audit — lot `multi` : un `old_str` en CRLF ratait le match exact, le repli tolérant l'acceptait et le `\r\n` inséré devenait `\r\r\n` → champs texte ramenés en LF (`_norm_edit_crlf`).
- **2026-09-25** — audit — lot `multi` : les éditions par numéro de ligne s'appliquaient dans l'ordre, chacune sur le texte déjà modifié (après `delete 2-3`, un `replace 8` touchait l'ancienne ligne 10, sous `ok`) → de bas en haut, éditions par contenu ensuite, plages chevauchantes refusées (`_order_multi_edits`).
- **2026-09-25** — audit — insertion après la dernière ligne d'un fichier sans saut final : le contenu se collait à cette ligne → même garde que l'append (`_apply_one_edit`).
- **2026-09-25** — audit — `occurrence=-1` d'une ancre n'était résolu que par l'action simple, « out of range » dans `multi` → résolu dans le moteur pour tous les chemins (`_apply_one_edit`, `_resolve_anchor`).
- **2026-09-25** — audit — l'action `regex` d'edit_file héritait du défaut `count` de str_replace et ne renommait que la première occurrence → toutes par défaut, comme dans `multi` (`edit_file`).
- **2026-09-25** — audit — un motif porteur de chemin (`src//*.ts`, `/*.py`) implique la récursion (`list_files`).
- **2026-09-26** — audit — la lecture en flux faisait deux lectures complètes (empreinte, nombre de lignes) avant le moindre rendu → une passe (`_read_large_text`).
- **2026-09-26** — audit — la lecture texte coupait aussi sur un `\r` isolé (barres de progression pip/tqdm/docker) et décalait tous les numéros suivants → découpe au seul `\n`, comme `grep -n` (`_read_large_text`).
- **2026-09-26** — audit — une première ligne dépassant à elle seule le budget était rendue entière → coupée (`_read_large_text`).
- **2026-09-26** — audit — `tail` recalculait la somme à chaque `pop(0)` : quadratique, 593 s pour `tail=100000` → total courant depuis la fin (`_read_large_text`).
- **2026-09-26** — audit — `occurrence=-1` comptée par `str.count` ne voyait pas les correspondances chevauchantes (« \n\n », « -- ») → comptée par le finder (`_resolve_anchor`).
- **2026-09-26** — audit — « insert@N » + « replace N-M » : l'insertion passait d'abord et le remplacement la mangeait (INS et la ligne N perdues, sous `ok`) → éditions de plage d'abord à clé égale (`_order_multi_edits`).
- **2026-09-26** — audit — `count=-1` de l'action regex : `subn(count=-1)` ne remplaçait rien (« pattern matched 0 times ») → ramené à 0, toutes (`_apply_one_edit`).
- **2026-09-26** — audit — ancre « after » terminée par un saut de ligne : la recherche du saut suivant sautait une ligne et insérait trop bas (`_apply_one_edit`).
- **2026-09-26** — audit — action simple d'edit_file sur fichier CRLF : `replacement` s'écrivait `\r\r\n`, `anchor_str` et contextes ne correspondaient jamais → mêmes champs normalisés que `_norm_edit_crlf` (`edit_file`).
- **2026-09-26** — audit — list_files descendait dans node_modules, .venv… et épuisait `MAX_WALK` avant le projet → parcours élagué par l'agent (dossiers exclus ou cachés ni rendus ni descendus) (`list_files`).
- 2026-09-26 — entrée `files_changed` : ce que le chat relit pour afficher le diff d'un fichier touché par un outil (`_fc_entry`).
- **2026-09-29** — relecture de l'agent fichiers — prettier lit sa config (code exécuté sur l'hôte) et le `.editorconfig` du bac à sable → lancé depuis un cwd neutre, seul le nom choisit l'analyseur (`_try_format`).

- passage par l'agent de la sandbox — les outils ne lisent ni n'écrivent plus eux-mêmes dans le dossier de la sandbox : l'agent du conteneur le fait (`_espace.Espace`) ; ordre de parcours de l'ancien `os.fwalk` trié conservé, dernier écrivain gagnant conservé pour l'écrasement, black et git lancés en conséquence (cwd neutre ; `Espace.git`) (`_cle_parcours`, `_ecrire_garde`, `_try_format`, `_git_status_map`).
- correctif — `from . import code_intel` cherchait `tools/code_intel.py` et échouait toujours (`_HAS_CI=False`, « code_intel module missing ») → import depuis `FileSystemLib`.
- correctif — `MAX_LIST` ne bornait que la page renvoyée : un rglob sur un arbre énorme matérialisait tout l'arbre + un `resolve()` par entrée dans le worker hôte → borne du walk (`MAX_WALK`).
- correctif — les sites d'erreur d'édition faisaient `_err(str(e))` : le code était un slug tronqué de la prose et ne correspondait jamais aux codes documentés → code machine stable (`_edit_err`).
- catégories d'outils — le side-car `.tool_manifest.json`, son wrapper `CategorizingMCP`, la lecture du descripteur par AST et le classement par préfixe ont disparu → la catégorie voyage dans le protocole (tags + meta), registre construit à la connexion (`CATEGORY`, `llm_core._mcp_categories`).
- annotations d'outils — jeux de mots-clés par comportement : lecture seule, idempotent, mutant, destructif (`_TOOL_KW_RO`, `_TOOL_KW_IDEMP`, `_TOOL_KW_MUT`, `_TOOL_KW_DESTRUCT`).
- audit de l'éditeur — une écriture garde le mode du fichier remplacé (bits x) (`_mode_ecrit`).
- audit — edit_file restaurait les CRLF dès qu'un seul était présent : un fichier à fins mixtes voyait ses lignes LF converties, 100 changements parasites masqués par le diff → CRLF seulement si le fichier est homogène, LF sinon (`edit_file`).
- correctif — le hint d'un mode invalide de write_file renvoyait vers `mkdir`, mode qui venait d'être refusé → boucle du modèle ; ne jamais citer `mkdir` (`write_file`).
- correctif — les paramètres structurés d'edit_file arrivant JSON-encodés en chaîne levaient une ValidationError silencieuse → re-parse par `as_list` (`edit_file`).

## `llm_core/conversation_compressor.py` — compression conversationnelle (résumé structuré, état persisté, porte de compaction)

- **2026-06** — audit — un compresseur en panne (endpoint mort, timeout) était retenté à chaque itération, un appel coûteux en boucle → cooldown aussi sur échec coûteux, pré-checks gratuits exclus (`compression_was_attempted`).
- **2026-07-28** — refonte du harnais — les règles de déclenchement en tours (`trigger_after`, `every`) sont retirées → règle unique d'overflow, occupation réelle ≥ `usable`, portée par l'appelant (`ConversationCompressor.__init__`, `maybe_compress_conversation`).
- **2026-07-28** — refonte du harnais — compaction partielle vers ~60 % du seuil, les tours compressibles récents restent verbatim ; estimation au ratio chars/token mesuré, 3.3 en amorce froide (`_PARTIAL_TARGET_RATIO`, `_estimate_tokens`).
- **2026-07-28** — refonte du harnais — le résumé précédent est mis à jour (update-merge ancré) au lieu d'être régénéré ; sections Markdown « ## » attendues, balises XML encore acceptées pour les états persistés plus anciens (`ConversationCompressor.compress`).
- **2026-08-01** — audit — les nudges éphémères du harnais comptés comme tours sur-comptaient `covered_turns` : au tour suivant, `_drop_leading_turns` jetait autant de vrais tours non résumés → exclus du comptage (`_is_ephemeral`).
- **2026-08-22** — constat en production — un chat de 54 messages compacté à 29 ne contenait plus aucun `user` : les gabarits à alternance stricte (Gemma) levaient au rendu (500), le run mourait en pleine mission et le modèle avait oublié sa demande ; seul l'étage « budget dur » protégeait l'ancre (audit du 2026-08-01) → l'énoncé est ré-épinglé en tête de la fenêtre conservée (`_pin_task_anchor`, `_anchor_pin`).
- **2026-08-23** — audit — `_split_by_turn_index` comptait les nudges éphémères comme ouvertures de tour (deux par itération contre une au comptage) : la zone protégée fondait de moitié, 4 cycles d'outil gardés au lieu de 9 → exclus comme dans les autres fonctions de tour (`_split_by_turn_index`).
- **2026-08-23** — audit — la porte du compresseur comptait sans `model_id` : amorce froide 3.3 contre ratio mesuré 2.6 dans la boucle, 27 % d'écart sur la même occupation ; la boucle ouvrait la porte, le compresseur répondait « threshold_not_reached » et la boucle ancrait cette estimation comme pseudo-mesure → `model_id` passé (`maybe_compress_conversation`).
- **2026-08-31** — audit — l'indexation FTS des tours compressés ouvrait une transaction SQLite par tool/tool_call (60-100 pour 40 tours) sur la boucle, au moment où l'utilisateur attend la reprise, avec jusqu'à 10 s de `busy_timeout` par insert sous contention WAL → exécutée en threadpool (`_index_covered_turns_fts`).
- **2026-09-16** — audit (cible par serveur) — `/tokenize` suit la cible : un connecteur llama.cpp compte exactement sur son serveur, les autres cibles au ratio mesuré, flaggé estimé (`maybe_compress_conversation`).
- **2026-09-24** — audit — `kept` pouvait commencer par un assistant (coupe partielle ou bridge entre une question et sa réponse) : les gabarits stricts (Gemma, Mistral) levaient en 500 et Anthropic refuse un premier message assistant → `user` éphémère de raccord, non compté comme tour (`_pin_task_anchor`).
- **2026-09-24** — audit — le budget d'entrée par message ne bornait pas la somme → plafond total, « fenêtre de 8 k » par défaut si celle du modèle de compression est inconnue (`compute_serializer_total_budget_tokens`).
- **2026-09-24** — audit de robustesse — « avant » était compté avec le ratio du modèle de chat et « après » avec celui du modèle de compression externe : garde no-gain et sélection partielle mélangeaient deux unités → `count_model` (`ConversationCompressor.compress`).

- correctif — création du client httpx de l'endpoint dédié non atomique : deux compressions concurrentes créaient chacune un `AsyncClient` (fuite) → `asyncio.Lock`, lui-même créé sous `threading.Lock` (`_get_endpoint_client`).
- correctif — le `timeout_sec` passé à la création du client mis en cache était ignoré ensuite : une reconfiguration admin n'avait effet qu'au redémarrage → timeout par requête (`_get_endpoint_client`, `_call_external_endpoint`).
- correctif — un ratio chars/3 local faisait déclencher la porte de compression ~10 % plus tôt que le budget de contexte, et le forfait image manquait (chat multimodal sous-estimé) → heuristique unifiée de `llm_core.context.tokens` (`_estimate_tokens`).
- correctif — le résumé n'était jamais persisté : re-compression re-payée à chaque tour au-delà du seuil, cap par chat intenable → message système d'état `[COMPRESSION_META …]` persisté et ré-appliqué (`build_state_system_message`, `extract_compression_state`, `apply_persisted_state`).
- correctif — le repli tout-ou-rien d'`apply_persisted_state` renvoyait résumé + tours couverts en double à chaque requête sur un historique incohérent → drop partiel (`apply_persisted_state`).
- correctif — un porteur de résumé avalé par la tête faisait perdre tout le socle à la recompression (le filtre de `compress()` jetait le message fusionné entier) → le fold ne fusionne jamais un porteur, et `compress()` ne retire que le span du résumé (`is_summary_carrier`, `_strip_summary_span`).
- refonte de la compression — sérialiseur et artifact ledger extraits vers `llm_core.context.compression.serializer` : budget dérivé du n_ctx au lieu des coupes fixes 2000/200, contenu des outils mutants remplacé par le ledger ; indexation FTS avant destruction, sans laquelle les sorties d'outils des tours compressés étaient perdues du contexte et du rappel (`_index_covered_turns_fts`).
- audit — l'indexation FTS écrivait un commit par ligne (des centaines de prises du verrou d'écriture) → une seule transaction (`_index_covered_turns_fts`).
- correctif — un `<think>` non fermé (cap max_tokens) n'était pas retiré : le raisonnement partiel était coercé dans `<context>` et installé comme résumé → coupe de l'ouvrant orphelin jusqu'à la fin (`ConversationCompressor.compress`).
- correctif — la validation stricte du format rendait `summary_invalid_format` sur les modèles qui résument sans balises : le bouton de compression manuelle n'aboutissait jamais → contenu enveloppé dans `<context>`, la garde no-gain restant la sécurité (`ConversationCompressor.compress`).
- correctif — `tokens_saved = max(0, …)` masquait un résumé plus gros que ce qu'il remplaçait (détail perdu sans gain) → garde no-gain avec rollback (`ConversationCompressor.compress`).
- correctif — rien ne vérifiait que la compaction partielle atteignait sa cible : sur une boucle agentique, elle repartait toutes les quelques itérations pour gratter 3 k → écart mesuré et signalé (`ConversationCompressor.compress`).
- correctif — le coût d'un appel de compression via l'endpoint dédié n'était mesuré nulle part → enregistré sous le scope « compression » (`record_turn_usage`).
- correctif — en multi-worker, `POST /api/admin/compression-config` ne mettait à jour que le worker qui le recevait : les admins voyaient leurs réglages ignorés → reload de la config (cache mtime) avant chaque compression (`maybe_compress_conversation`).
- console d'administration — l'événement `compression_start` porte le seuil qui a déclenché (jetons) et le motif (`maybe_compress_conversation`).
- aucune décision retirée — sens d'origine de l'en-tête « État PERSISTANT » rétabli (la route ne sauvegarde que les messages client + la réponse : un résumé non persisté serait perdu à chaque tour) ; `compression_was_attempted` alimente le backoff `compr_fail_streak`, pas un « cooldown ».

## `shared_infra/accounts/identity.py` — enveloppe d'identité de l'hôte d'outils

- **2026-09-11** — outils portables — l'hôte d'outils (``toolhost/``) n'ouvre pas la base de l'app → identité de l'utilisateur transmise par le ``_meta`` des appels MCP et par l'en-tête signé ``X-Elpis-Identity`` (`Identity`, `sign`, `verify`, `from_meta`).
- **2026-09-22** — audit — un modérateur (``is_admin`` = 2) ne doit pas passer pour administrateur plein (``True == 1`` aussi) → ``is_admin == 1`` (`Identity.from_dict`).
- outils externes — le relais public ``/api/mcp-bridge`` ne retransmet pas le jeton du client (« token passthrough », interdit par la spécification MCP) → jeton vérifié, puis jeton de service accompagné d'une enveloppe de délégation liée à son audience (`sign_claims`, `verify_claims`, `DELEGATION_HEADER`).

## `shared_infra/accounts/routes_settings.py` — réglages par compte, avatars, mot de passe

- **2026-08-02** — audit — l'échec de suppression de l'avatar remplacé était avalé sans trace : fichier orphelin dans AVATAR_DIR, toujours servi par /avatars/{filename} (nom devinable) → échec journalisé (`api_upload_avatar`, `api_delete_avatar`).
- **2026-08-02** — audit — l'avatar d'assistant s'écrivait par lecture-modification-écriture non atomique → `merge_user_settings`, avatar remplacé lu dans la transaction (`api_upload_assistant_avatar`).
- **2026-08-02** — audit — ``sandbox_mode`` / ``network_profile_id`` étaient ré-appliqués depuis ``current`` lu hors transaction : une bascule de profil réseau concurrente était écrasée par l'ancienne valeur → clés retirées du payload (``SANDBOX_PROTECTED``).
- **2026-08-02** — audit — PUT /api/settings appliquait ``data`` sur ``current`` lu plus haut (course lecture-modif-écriture) → fusion atomique sous ``BEGIN IMMEDIATE`` (`merge_user_settings`).
- **2026-08-23** — audit — un ``reset()`` du pool MCP à chaque sauvegarde fermait aussi les MCP personnels des autres utilisateurs du worker, en pleine génération → invalidation ciblée des seuls serveurs modifiés, recyclage large réservé aux entrées sans id (`mcp_pool.invalidate`).
- **2026-08-30** — audit — ``exists()``/``is_file()`` hors du ``try`` : un nom de 256 caractères ou plus (ENAMETOOLONG) donnait un 500 sur une route publique (mesuré : 255 → 404, 256 → 500) → même ``try`` que ``resolve()``, réponse 400 (`api_get_avatar`).
- **2026-09-01** — audit — `merge_user_settings` (``BEGIN IMMEDIATE``, busy_timeout 10 s) s'exécutait sur la boucle : un écrivain long en vol gelait tout le worker sur un simple toggle → `asyncio.to_thread` (`api_put_settings`, `api_upload_assistant_avatar`).
- **2026-09-19** — éditeur — mémorisation des onglets ouverts activée par défaut (``editor_persist_tabs``).
- **2026-09-22** — audit — le modérateur (``is_admin == 2``) était traité comme un administrateur : liste des utilisateurs hors de ses groupes, modification et suppression de serveurs MCP existants → ``is_admin == 1`` seulement (`api_get_users_lite_route`, `api_put_settings`).
- **2026-09-28** — mascottes — la liste des personnages était recopiée ici, dans ``_mascotte.js`` et dans ``app-admin.js`` → registre unique ``mascottes.json`` lu par ``shared_infra.appearance.skins`` (`_mascottes`).
- correctif — la vérification de l'ancien mot de passe se contournait en omettant ``old_password`` (prise de contrôle de compte) → seul le flux ``must_change_pwd`` s'en dispense (`api_user_change_password`).
- constat — une purge automatique d'imports morts a retiré ``update_user_settings`` et cassé 47 tests qui le substituent → import gardé avec ``noqa: F401``.
- constat utilisateur — l'accueil n'était animé que sur opt-in, la case « animer quand même » n'apparaissant que si le système demandait moins de mouvement → animé par défaut, case toujours visible à côté du sélecteur de mascotte (``welcome_mascot_anime``).
- console d'administration — le skin par défaut était « elpis » en dur → défaut d'instance (`_skins.default_skin`).
- correctif — seul ``auth_secret`` était contrôlé chez un non-admin : une valeur d'en-tête ou de variable modifiait les identifiants d'un serveur existant → trois créneaux contrôlés (`_posts_a_value`).

## `shared_infra/observability/metrics/_v17_providers.py` — widgets d'observabilité des outils

- retrait du moteur agentique — les quatre providers agentiques (``subagent_usage``, ``subagent_error_rate``, ``team_rounds_distribution``, ``budget_exhaustions``) restaient vides en permanence, leurs event_types n'étant plus émis → retirés ; quatre providers outils (`register_all`).
- observabilité des outils — le tag ``status=error`` de l'event ``tool_call`` n'existait pas dans les premières versions → events sans status comptés ``ok`` (`ToolErrorRateProvider`).
- observabilité des outils — table typée ``tool_call_metrics`` (durée, statuts ``blocked`` et ``timeout``) pour le volume, la latence et les échecs ; le pare-feu d'outils et le retrait de ``metric_events`` envisagés alors n'ont pas eu lieu : les deux sources sont écrites pour chaque appel (`ToolCallVolumeProvider`, `ToolCallLatencyProvider`, `KPIToolFailuresProvider`).

## `shared_infra/routes/_state.py` — état partagé des routes (annulation, tâches de chat)

- **2026-08-22** — audit — le drain de recyclage attendait la fin des connexions HTTP : un run détaché ou une mission de plusieurs heures était coupé → compteur des runs vivants du worker, interrogé par le drain (`active_run_count`).
- **2026-08-22** — audit — le verrou de présence, déjà pris par la route dans son handler, était ré-acquis à l'enregistrement : échec, clé sans fd, jamais libérée à l'unregister → fd confié par l'appelant (`register_chat_task`, ``presence_fd``).
- **2026-09-01** — audit — la publication sur le bus d'annulation (flock bloquant sur un fichier partagé par N workers) tournait sur la boucle et pouvait la geler le temps qu'un autre worker écrive → hors boucle (`_publish_cancel`).
- audit — la publication hors boucle passait par l'exécuteur multi-thread par défaut → thread ordonné, FIFO strict, échecs journalisés (`_publish_cancel`, `submit_ordered`).
- correctif — registres clés par ``user_id`` seul : la génération d'un second onglet écrasait celle du premier (task orpheline, impossible à annuler) et un Stop annulait les deux → clé composite ``(user_id, chat_id)`` (`_active_chat_tasks`, `_cancelled_chats`).
- correctif — le flag d'annulation n'était retiré qu'au démarrage de la génération suivante sur le même chat : un chat stoppé puis abandonné le gardait indéfiniment (fuite lente) → purge à l'unregister, datée contre les échos tardifs du bus (`unregister_chat_task`, `_note_cleared`).
- correctif — flags d'annulation tenus dans un set, jamais purgés hors du worker hôte, avec des clés de routine uniques : croissance sans borne → dict daté, balayé au-delà du TTL (`_sweep_cancel_flags`).
- correctif — les gardes 409 ne voyaient pas une génération tournant dans un autre worker gunicorn : le tour finissait en conflit optimiste, non persisté → verrou de présence partagé (`is_generation_active`, `_activity_fds`).

## `shared_infra/scheduling/routines_scheduler.py` — planificateur et exécuteur des routines

- **2026-08-23** — audit — la boucle d'outils RETOURNE le partiel avec ``ended_with_error`` au lieu de lever quand l'appel LLM meurt après ses reprises ; la boucle de reprise y voyait un succès : run journalisé 'ok', notifié en succès, chaîne aval déclenchée sur un travail interrompu → run marqué en erreur avec la réponse partielle, notification d'échec, chaîne « error » (`execute_routine_run`).
- **2026-08-30** — audit — l'échéance du drain d'arrêt suivait l'horloge murale : un saut d'horloge coupait le drain avant terme (runs tués en vol, aval laissé 'running' en base) ou le prolongeait au-delà du délai d'arrêt systemd → échéance en `time.monotonic` (`drain_running_runs`).
- **2026-09-11** — politique d'outils déclarative — les outils retirés à une routine se lisent dans la politique ``meta.policy.deny_for: ["routine"]`` déclarée par les outils, ``{"ask_user"}`` restant le repli d'un registre vide (`_denied_for_routine`).
- **2026-09-16** — audit — la politique d'accès aux moteurs du propriétaire ne s'appliquait pas aux routines : la restriction se contournait en planifiant le travail → `engine_access.can_use_engine` vérifié avant le lancement, run en erreur sinon (`execute_routine_run`).
- **2026-09-17** — audit — une routine partait toujours sur le moteur intégré, quel que soit le serveur de sa fiche → cible ``connector_id`` résolue et posée dans le contexte de la tâche, suivie par tout le run (`set_llm_target`).
- **2026-09-20** — durcissement des serveurs ``stdio`` — un serveur MCP perso ``stdio`` d'une routine n'est exécuté que si son propriétaire est administrateur plein (`_rehydrate_mcp_secrets`, ``allow_stdio``).
- **2026-09-21** — audit — une entrée du snapshot MCP qui ne se résolvait en rien partait telle quelle : un ``type: "stdio"`` + ``command`` posté par n'importe quel compte s'exécutait sur l'hôte, une ``url`` interne rouvrait la SSRF fermée côté chat → le snapshot n'est qu'une liste de références, toute entrée non résolue est jetée (`_rehydrate_mcp_secrets`).
- **2026-09-21** — audit — des réglages de compte illisibles devenaient un dict vide : run sans secrets MCP, serveurs partagés, mémoire ni agents perso, et pouvant être noté « ok » → deux relectures puis échec explicite (`execute_routine_run`).
- **2026-09-21** — correctif — les sous-agents lisent eux aussi ``ended_with_error`` (le chat reçoit l'erreur par l'événement ``error`` et le partiel par ``truncated``) (`build_task_builtin_tool`).
- **2026-09-25** — audit — les sous-agents d'une routine ne cédaient pas le pas aux chats interactifs → ``priority="low"`` transmis aux sous-agents, comme pour la routine (`build_task_builtin_tool`).
- audit — le heartbeat abandonnait après N échecs consécutifs : une contention DB transitoire (``wal_checkpoint(TRUNCATE)`` sous charge) privait un run long de heartbeat → réconcilié « orphaned » vivant, faux échec et notification de succès perdue → le heartbeat continue de battre, avertissement au franchissement du seuil (`_heartbeat_loop`, `_HEARTBEAT_MAX_FAILURES`).
- correctif — la mémoire long-terme n'était pas transmise à la boucle (défaut True côté `run_chat_multi_mcp`) : une routine exposait ``memory`` / ``session_search`` malgré l'opt-out ``memory_enabled=False`` du propriétaire → même résolution que le tour de chat (`_mem_on`).
- audit — une routine minute dont un run dépassait 60 s voyait la minute suivante lancer un 2ᵉ run en parallèle (effets de bord en double) ; la garde, posée d'abord hors de la transaction d'admission, laissait deux livraisons webhook simultanées lire toutes deux count=0 (TOCTOU) → garde anti-chevauchement dans la transaction d'admission (`admit_and_insert_run`, ``overlap_fresh_after_s``).
- relecture — une routine enchaînée héritait de l'exécution (parent_id) et de la cible LLM de la routine amont → tâche lancée dans un contexte neuf (`launch_run`, ``contextvars.Context()``).
- audit — l'écriture de la métrique ``scheduler_skip`` (INSERT + flock du bus) tournait sur la boucle → `asyncio.to_thread` (`_routines_loop`).
- constat en production — un ``sleep(TICK_SECONDS)`` en tête de tick additionnait le temps de travail à la période : la phase glissait et, sans rattrapage, une minute pouvait n'être jamais observée (routine nocturne sautée sans log) → réalignement sur la frontière de minute (`_routines_loop`).
- constat en production — les minutes jamais observées (worker recyclé, machine chargée, lock repris ailleurs) étaient enjambées en silence → trou mesuré par la métrique ``scheduler_skip`` et un avertissement (`_routines_loop`).
- constat utilisateur — chaque fin de run notifiait, sans réglage : une routine minute remplissait le centre de notifications → politique ``notify_on`` et cap ``notify_keep`` (`_notify_run_end`).
- constat utilisateur — le journal affichait le raisonnement ``<think>…`` brut, tronqué à 4000 caractères en plein milieu → seule la partie visible est journalisée (`_extract_thinking`).
- correctif — une routine qui délègue n'affichait que le coût de l'orchestrateur → tokens des sous-agents ajoutés à ceux du run (``_task_usage``).
- correctif — un arrêt utilisateur était journalisé « Échec » ; une routine supprimée ou désactivée avant démarrage aussi → statuts dédiés 'cancelled' et 'skipped' (`mark_run_cancelled`, `mark_run_skipped`).
- correctif — un stop arrivé entre l'échec et la reprise filait vers ``except Exception`` : run 'error', notification d'échec et chaîne aval déclenchée pour un geste volontaire → bascule sur le chemin `CancelledError` (`execute_routine_run`).
- correctif — chaque run créait un fichier de verrou de présence distinct, purgé après 24 h seulement (1440 fichiers/jour pour une routine minute) → ``presence_lock=False`` pour la clé de run synthétique (`register_chat_task`).
- correctif — ``ask_user`` terminait une routine headless sur une question posée dans le vide → outil retiré aux routines (`_denied_for_routine`).
- correctif — sans scope d'usage, la consommation d'un run nocturne s'enregistrait en « unknown », sans propriétaire ni mode de déclenchement → `set_usage_context` en tête de run.
- correctif — au shutdown, la fermeture du transport sous les runs en vol levait une exception ordinaire → fausse notification « Routine en échec » à chaque redémarrage ; un snapshot unique des runs manquait les avals lancés pendant le drain → annulation sur snapshots successifs, AVANT `shutdown_mcp_pool` (`drain_running_runs`).
- correctif — au démarrage de la VM, l'app montait avant llama-server et le premier run échouait avec notification → run 'skipped' si le LLM est injoignable (`_llm_reachable`).
- correctif — ``auth_enc`` figurant dans ``_MCP_SECRET_KEYS``, une recopie clé à clé des secrets livrait du Fernet à `_resolve_mcp_client` → config complète déchiffrée (`personal_to_config`).

## `shared_infra/runtime/run_journal.py` — journal des événements d'un run de chat

- **2026-09-16** — audit — revenir sur une conversation qui génère encore ne montrait rien (ni bulle, ni étapes d'outils, ni bouton Stop) : le flux vivait dans la file mémoire du worker du POST, et la copie du navigateur se perdait au rechargement ou au changement de chat → journal de run sur fichier, relisible par tout worker (`RunJournal`).
- **2026-09-26** — optimisation — la fusion des tokens recopiait tout le texte accumulé à chaque token (O(n) par token) → morceaux joints une seule fois au flush (`RunJournal.append`).

## `shared_infra/sandbox/executors/_image_loader.py` — chargement de l'image sandbox

- **2026-08-02** — audit — tâche de chargement sans référence forte (collectable avant son premier await), sans TTL et ``reset_state()`` sans appelant : état LOADING éternel, spinner infini, seule issue le redémarrage du worker → référence forte (`_LOAD_TASK`), LOADING périmé requalifié en ERROR puis nouvel essai (`_LOADING_STALE_S`).
- **2026-08-02** — audit — l'attente ``blocking=True`` passait par ``async with _LOCK: pass``, verrou relâché dès le create_task : elle n'attendait rien → Event de fin de chargement (`_LOAD_DONE`), attente bornée à 330 s.
- **2026-08-02** — audit — aucune garde d'exception autour du chargement de fond (fork EAGAIN, binaire docker absent) : LOADING éternel sans erreur affichée → exception requalifiée en ERROR (`_load_in_background`).
- **2026-09-26** — audit sandbox — en ``blocking=True``, le ``docker load`` tournait dans la coroutine de l'appelant : son annulation laissait un load orphelin, LOADING jusqu'au TTL et ``_LOAD_DONE`` jamais posé → chargement toujours en tâche de fond suivie, l'appelant n'en attend que la fin (`ensure_image_loaded`).

## `shared_infra/chat/store.py` — conversations en base

- **2026-08-01** — audit — les écrivains de ``meta_json`` lisaient hors transaction puis réécrivaient le dict entier : deux écrivains concurrents (todo de l'agent, catégories du panneau Outils) s'écrasaient sans erreur ni log → lecture-modification-écriture sous ``BEGIN IMMEDIATE`` (`_merge_meta_json`).
- **2026-08-23** — audit — seul le ``thinking`` de premier niveau était retiré : celui recopié dans ``metrics`` passait en base, jusqu'à 400 000 caractères par message, y compris via ``PUT /save-messages`` → ``metrics["thinking"]`` nettoyé aussi (`upsert_chat`).
- **2026-09-01** — audit — la suppression groupée bouclait sur ``delete_chat`` (une connexion, une transaction et un fsync par chat) → une transaction, ``IN`` par tranches de 500 (`delete_chats_by_ids`, `delete_all_chats`).
- **2026-09-01** — audit — la fin de tour enchaînait jusqu'à trois ``BEGIN IMMEDIATE`` successifs sur la même ligne avant l'event ``final`` → une seule transaction (`finalize_turn_meta`).
- **2026-09-07** — jauge de contexte — occupation réelle de fin de tour persistée pour re-semer la jauge après un rechargement (`finalize_turn_meta`, `clean_ctx_usage`).
- **2026-09-12** — outils cochables un par un — exclusions enregistrées préfixées d'un tiret ; le plafond de 64 entrées tronquait en silence → 192 (`set_chat_tools`).
- **2026-09-16** — runs en fond — un run en fond s'affichait « Nouveau chat » dans la barre latérale jusqu'à sa fin → titre posé dès le début du tour, sans bump d'``updated_at`` (`set_title_if_default`).
- **2026-09-25** — audit — suffixes LLM des questions persistés et rejoués à l'identique : préfixe KV stable d'un tour à l'autre (``llm_user_suffixes``, `finalize_turn_meta`).
- **2026-09-26** — audit — après réécriture de l'historique (retry, édition, troncature), un suffixe de l'ancienne branche était rejoué au même rang (``<todo_status>`` jamais vu du modèle) → purge des suffixes de rang ≥ n (`finalize_turn_meta`, ``suffix_drop_from_rank``).
- correctif — collision de ``chat_id`` entre comptes : l'upsert n'écrivait rien et la requête répondait 200 OK → ``ValueError`` (`upsert_chat`).
- correctif — compression manuelle et génération concurrentes sur le même chat s'écrasaient à l'aveugle en multi-worker → garde optimiste (`upsert_chat`, ``expected_updated_at``).
- renommage — ``enforce_sliding_20`` gravait un 20 que le réglage ``app.max_recent_chats`` contredisait → `enforce_recent_chats_cap`.
- correctif — recherche plafonnée à 50 résultats en dur : un chat visible dans la barre latérale pouvait rester introuvable → plafond de la liste, plancher 50 (`search_chats`).
- aucune décision retirée — le « 64 » restant de l'ancien plafond de `set_chat_tools` (déjà consigné : 64 → 192) retiré.

## `shared_infra/mcp/panel.py` — routes du panneau MCP (serveurs perso, bibliothèque partagée, manifeste) et cycle de vie du pool

- **2026-08-02** — audit — le flock de pré-chauffage était gardé à vie par le premier worker : un worker recyclé ne pré-chauffait jamais (300 à 800 ms sur son premier message) et N-1 workers restaient froids dès le boot, alors que les pools MCP sont par process → verrou de sérialisation seulement, relâché après chaque pré-chauffage (`_acquire_prewarm_lock`, `_release_prewarm_lock`, `prewarm_mcp_pool`).
- **2026-09-11** — manifeste ``mcp.json`` — routes des serveurs externes déclarés et vue d'administration du manifeste (`api_mcp_manifest_servers`, `api_admin_mcp_manifest`).
- **2026-09-12** — familles d'outils (une famille = une entrée = un endpoint) — pré-chauffer la seule sentinelle nue ne remplissait que la première famille → une config par entrée intégrée (`_builtin_prewarm_cfgs`).
- **2026-09-12** — sélection d'outils un par un — la liste ``tools`` était retirée des catégories → conservée, avec nom, titre et description courte (`api_mcp_categories`).
- **2026-09-22** — audit — un modérateur (``is_admin`` = 2) recevait la vue d'administration de la bibliothèque (URL, en-têtes) et le bouton publier → test ``== 1`` (`api_list_shared_mcp_servers`).
- correctif de sécurité — l'upload de serveurs MCP était ouvert à tout compte authentifié, soit une exécution de code arbitraire pour tous → réservé aux administrateurs (`api_upload_mcp_server`).
- correctif de sécurité — le chemin relatif d'un fichier uploadé n'était pas validé (``foo/../../../etc/cron.d/x`` écrivait hors du dossier) → résolution, ``_path_inside``, 403 et nettoyage complet du dossier (`api_upload_mcp_server`).
- correctif de sécurité — la suppression d'un serveur était ouverte à tout compte (vandalisme inter-comptes) et le test ``".." in name or "/" in name`` ratait les encodages alternatifs → admin seulement, ``_path_inside`` (`api_delete_custom_mcp_server`).
- choix d'exploitation — la gestion admin du masquage par outil et de la visibilité par catégorie (``hidden_tools.json``, ``mcp_categories_overrides.json``) a été retirée → la surface d'outils se choisit côté serveur, par famille (``LOCAL_MCP_TOOL_FAMILIES``).
- correctif — le side-car ``tools/.tool_manifest.json`` a été remplacé par le registre vivant des catégories (`api_mcp_categories`, ``llm_core._mcp_categories``).
- correctif — la boucle de chat affichait la trace brute du task group au lieu d'un message lisible (« HTTP 401 ») → ``friendly_mcp_error`` partagé dans ``llm_core._mcp_wrappers`` (`_friendly_mcp_error`).
- bibliothèque MCP partagée — un serveur enregistré côté admin n'apparaissait chez aucun autre compte, qui devait le re-saisir (URL et jeton compris) → bibliothèque publiée lisible par tout compte authentifié (`api_list_shared_mcp_servers`).

## `shared_infra/config.py` — configuration d'instance (config.json + env)

- **2026-07-18** — audit — les clés des sous-agents (``llm.task.*``) étaient lues par ``llm_core._constants`` via ``getattr(config, …)`` mais absentes de ce module : seuls les fallbacks codés en dur vivaient, rien n'était réglable par déploiement → clés déclarées ici, lecture à froid (``TASK_*``).
- **2026-07-18** — longues missions — budgets des sous-agents relevés : timeout enfant 900 → 1800 s, itérations explore 15 → 25, general 25 → 40, web 20 → 30 (``TASK_CHILD_TIMEOUT_S``, ``TASK_MAX_ITERS_*``).
- **2026-07-18** — constat sur les longues sessions agentiques — un cap de 2 compressions par conversation faisait basculer trop tôt sur le budget dur, qui jette les vieux tours au lieu de les résumer → défaut 4 (``COMPRESSION_MAX_PER_CHAT``).
- **2026-07-28** — correctif — ``LLAMA_MAX_MSGS`` (clamp à 80 messages ≈ 40 rounds d'outils sur 256k) amputait silencieusement l'historique → retiré ; seule borne : le budget en tokens, dépassement signalé par ``KIND_CONTEXT_OVERFLOW``.
- **2026-07-28** — harnais — élagage des sorties d'outils par vagues à chaque itération, piloté en caractères → passe de fin de tour en tokens, active par défaut (``PRUNE_ENABLED``).
- **2026-07-29** — constat en usage — 50 itérations productives coupaient des tours légitimes bien avant la fin du travail → défaut 200 (``LLAMA_MAX_TOOL_ITERATIONS``).
- **2026-07-29** — audit — un ``LOCAL_MCP_TOKEN`` fantôme (envoyé, jamais vérifié) ne protégeait rien → retiré ; le jeton actuel est vérifié par le service (``LOCAL_MCP_TOKEN``).
- **2026-07-30** — audit — ``config.json`` (branche 2) primait toujours sur le fichier ``.session_secret`` (branche 3) ; la valeur d'exemple étant committée, la branche 3 était inatteignable et tout lancement hors ``start_*.sh`` signait les cookies de session avec une valeur publique (sessions forgeables) → un placeholder publié est traité comme absent (``_session_json_is_placeholder``).
- **2026-08-01** — audit — l'élagage n'avait lieu qu'en fin de tour : un run de plusieurs centaines d'itérations n'élaguait jamais rien et ne gardait que le budget dur → cadence d'élagage en cours de run (``PRUNE_EVERY_ITERS``).
- **2026-08-01** — audit — un TTL de reprise d'une heure faisait répondre ``unknown_task_id`` à un parent de trois heures, sur un task_id émis au début → 3600 → 21600 s (``TASK_RESUME_TTL_S``).
- **2026-08-01** — audit — les endpoints admin mutaient la constante module-level (ex. ``LLM_SCHEDULING_MODE``) en plus d'écrire ``config.json`` : seul le worker du POST appliquait le réglage, la valeur lue oscillait selon le worker → lecture sur disque à l'appel (``live_config_value``).
- **2026-08-01** — audit — attributs du cookie de session dérivés à deux endroits (boot de ``server/app.py``, logout) : après un toggle HTTPS, le logout ne supprimait pas le cookie sous Chrome/Safari → source unique (``session_cookie_attrs``).
- **2026-08-02** — audit — sans ``max_age``, ``SessionMiddleware`` appliquait le défaut Starlette (14 jours glissants) : cookie persistant, signé-valide 14 j alors que la gate ``_login_ts`` le rejetait à 24 h → ``max_age`` aligné sur ``security.session.max_age_sec`` (``session_cookie_attrs``).
- **2026-08-04** — casting de spécialistes — l'agent intégré fourre-tout ``general`` est supprimé → sa clé de budget sert de repli à celui des agents custom (``TASK_MAX_ITERS_CUSTOM``).
- **2026-08-17** — décision produit — mur de réflexion retiré → budget souple de réflexion désactivé par défaut (``LLAMA_REASONING_SOFT_BUDGET_TOKENS``).
- **2026-08-21** — audit long-run — fermer l'onglet annulait la génération, fatal à une mission autonome → option de détachement du run, désactivée par défaut (``DETACH_RUN_ON_DISCONNECT``).
- **2026-08-21** — audit long-run — 4 compressions par conversation, trop peu pour une mission autonome (passé le cap, perte silencieuse de vieux tours par le budget dur) → défaut 12 (``COMPRESSION_MAX_PER_CHAT``).
- **2026-08-21** — audit long-run — la borne haute 10 rabattait en silence un réglage légitime (20 → 10) → borne 64 (``COMPRESSION_MAX_PER_CHAT``).
- **2026-08-21** — audit long-run — 2 compactions par run, calibré pour un tour de chat → défaut 8, mis à l'échelle du budget d'itérations du run (``COMPACTIONS_PER_RUN_MAX``, ``LLMTurnState.for_run``).
- **2026-08-22** — audit — aucune borne de générations simultanées par compte : un compte pouvait rafler le débit de l'ordonnanceur (une itération des autres pour quatre des siennes) → plafond 3 par compte (``MAX_RUNS_PER_USER``).
- **2026-08-22** — vérification en direct — capacités du build b10545 de llama-server ; un champ inconnu d'un build plus ancien est ignoré sans erreur → ping SSE, progression, flux reprenable et contrôle du raisonnement envoyés partout (``LLAMA_SSE_PING_INTERVAL_S``, ``LLAMA_RETURN_PROGRESS``, ``LLAMA_RESUMABLE_STREAM``, ``LLAMA_REASONING_CONTROL``).
- **2026-08-23** — audit — les deux écrivains de ``config.json`` partageaient le temporaire fixe ``config.json.tmp`` : écritures entrelacées → ``config.json`` invalide, et fail-open de ``gunicorn_conf`` (bind ``0.0.0.0`` malgré HTTPS) → temporaire unique (``write_text_atomic``).
- **2026-08-31** — audit — ``session_messages`` (+ son miroir FTS5) était la seule table à croissance non bornée → rétention 180 j (``SESSION_MESSAGES_RETENTION_DAYS``).
- **2026-09-02** — revue des adhérences MCP — authentification du service partagé : jeton de service et jetons clients liés à un compte, vérifiés côté serveur (``LOCAL_MCP_TOKEN``, ``LOCAL_MCP_CLIENT_TOKENS``).
- **2026-09-03** — clients opencode — jetons opencode des comptes acceptés en Bearer par le service MCP ; familles exposées et cachées (``LOCAL_MCP_OPENCODE_FAMILIES``, ``LOCAL_MCP_OPENCODE_EXCLUDE_FAMILIES``).
- **2026-09-04** — rangement — ``config.json`` déplacé à la racine du dépôt, repli signalé sur ``shared_infra/config.json`` (``_resolve_config_json_path``).
- **2026-09-05** — régression en production (« MCP opencode absents au redémarrage ») — URL et jeton du service partagé n'existaient qu'en variables d'env posées par ``./elpis start`` : un redémarrage hors script rendait ``opencode.json`` sans bloc ``mcp`` → registre des serveurs MCP locaux, jeton lu dans le fichier persistant, URL dérivée (``LOCAL_MCP_SERVERS_RAW``, ``_read_local_mcp_token_file``, ``_builtin_local_mcp_url``).
- **2026-09-11** — outils portables — troisième segment des jetons clients : familles autorisées par jeton (``_parse_client_token_families``).
- **2026-09-12** — outils portables — racine du magasin mémoire séparable des sandboxes, qu'un hôte d'outils distant emporte (``MEMORY_DIR``).
- **2026-09-16** — import sandbox — un dossier trop gros s'importait à moitié avant de buter sur le quota → refus avant tout envoi au-delà d'un pourcentage de la capacité (``sandbox_import_max_pct``).
- **2026-09-22** — audit — toute cible desktop était ouverte à tout compte connecté → accès ``list`` (administrateurs + ``allowed_users``) (``_coerce_desktop_targets``).
- **2026-09-26** — chantier multi-moteurs — moteur de base sqlite / postgres / mysql (``DB_BACKEND``).
- **2026-09-27** — console d'administration — inventaire des réglages lus au démarrage, pour annoncer « Redémarrage nécessaire » (``BOOT_READ_PATHS``).
- décision d'architecture (juin 2026) — cibles desktop sans champ jeton : déploiement full local, pas d'auth inter-machine (``_coerce_desktop_targets``).
- correctif — une variable d'env positionnée mais vide écrasait silencieusement la valeur json/défaut → chaîne vide = non définie (``_as_str``).
- correctif — caps de génération réglables par env seulement → aussi par config.json (``LLAMA_MAX_TOKENS_CHAT``, ``LLAMA_MAX_TOKENS_THINKING``).
- correctif — tronquer la liste d'éléments desktop masquait des éléments utiles au modèle → plafond opt-in, 0 = liste complète (``DESKTOP_MAX_ELEMENTS``, ``DESKTOP_MAX_ELEMENTS_CHAT``).
- correctif Studio — capture d'après-action prise avant l'effet de l'action → attente d'écran stable bornée (``DESKTOP_STUDIO_ACT_SETTLE_MS``).
- harnais — plancher desktop exprimé en tokens ; à 0, la clé en caractères fait autorité (``DESKTOP_TOOL_RESULT_MAX_TOKENS``).
- correctif — propriété des frames desktop fiable cross-worker grâce au sidecar disque → propriétaire inconnu = 404 par défaut (``DESKTOP_FRAME_STRICT_OWNER``).
- correctif — purge de télémétrie faite uniquement au boot (``_run_startup_cleanup``), jamais rejouée sur un serveur qui ne redémarre pas → passe quotidienne sur le worker leader (``shared_infra/ops/maintenance.py``).
- refonte — prompts système éparpillés et codés en dur → chargés depuis ``system_prompts/*.md`` (``SYSTEM_PROMPT_*_PATH``).
- harnais — déclenchement de la compaction par pourcentage, tours, cooldown ou croissance supprimé → règle unique d'occupation ; les clés correspondantes d'un config.json existant sont inertes (``COMPACTION_*``).
- harnais — une seule compaction réussie par run (« jamais deux résumés enchaînés ») → plafond par run (``COMPACTIONS_PER_RUN_MAX``).
- audit long-run — raisonnement cumulé du run non borné (mégaoctets en heap, envoyés à /tokenize puis en une ligne NDJSON) → suffixe borné (``THINKING_HISTORY_MAX_CHARS``).
- correctif — store de reprise à 40 entrées, rempli en quelques dizaines de délégations : l'éviction FIFO tuait des reprises encore dans leur TTL → 200 (``TASK_RESUME_MAX``).
- correctif — timeout git local de 12 s, taillé pour un dépôt jouet : un gros dépôt lent devenait un « échec d'outil » → 60 s (``GIT_TOOL_TIMEOUT_S``).
- correctif — les outils fs/shell du serveur MCP retombaient sur ``./user_sandboxes`` relatif à leur CWD et écrivaient hors de l'arbo lue par le front → chemin absolu propagé (``APP_SANDBOX_DIR``).
- audit — ``UserSandbox`` remplaçait par ``-`` et tronquait à 32 : ``Jean.Dupont`` et ``Jean-Dupont`` confondus (collision de conteneur, montage croisé entre comptes) → source unique, sémantique « delete » (``safe_sandbox_name``).
- correctif — skills perso stockés dans ``<sandbox>/skills/``, destructibles par le modèle → store hors sandbox, copie de travail miroir (``USER_SKILLS_DIR``).
- correctif de sécurité — mode du fichier ``.session_secret`` jamais revérifié après création → 0600 réaffirmé à chaque lecture (``_harden_secret_file_mode``).
- correctif de sécurité — échec d'écriture du secret de session avalé en silence : chaque worker générait son propre secret, déconnexion à chaque rebond → journal CRITICAL (``_load_or_create_secret``).
- mesure de performance — ``read_config_json()`` rouvrait et reparsait ~400 Ko à chaque appel (825 µs) sur le chemin de chaque requête authentifiée → cache invalidé par ``stat`` (inode, mtime, taille) avec péremption max 1 s (``config_view``).
- correctif — le champ admin « Conversations récentes » n'agissait qu'après un redémarrage complet, et ``0`` écrit à la main signifiait « supprimer toutes les conversations » → relu à chaque appel, plancher 1 (``max_recent_chats``).
- aucune décision retirée — commentaire de `DETACH_RUN_ON_DISCONNECT` corrigé (par défaut, une déconnexion détache déjà le chat principal `resumable` et tout tour où un outil a tourné ; le réglage n'ajoute que les tours de pur chat non reprenables — studio, sessions éphémères ; lu à l'import) ; `_enforce_context_budget` → `llm_core.context.pruning.enforce_context_budget` (trois renvois) ; `CTX_IMAGE_TOKEN_COST` sert à toutes les estimations de contexte, pas au seul dernier rempart ; « quatre » orphelin (ancien défaut de `COMPRESSION_MAX_PER_CHAT`, déjà consigné) retiré ; antécédent de « elle » rétabli (secret de session) ; récit à l'imparfait du `BUILD_ID` mis au conditionnel.

## `shared_infra/observability/events_bus.py` — bus d'événements SSE, cache des modèles, tâches de fond

- **2026-08-01** — audit — un client saturé était désinscrit par ``clients.pop(q)`` : son ``listen()`` restait bloqué à vie sur ``await q.get()``, le ``finally`` ne s'exécutait jamais et les pings d'``EventSourceResponse`` masquaient la panne (ni ``onerror`` ni reconnexion), logs et notifications gelés sans signe d'erreur → on vide la moitié la plus ancienne de la queue et on ré-enfile le message, sentinelle de fermeture en dernier recours (`SystemEvents._fanout`, `_CLIENT_CLOSED`).
- **2026-08-02** — audit — une session expirée ou révoquée gardait son flux SSE ouvert indéfiniment (firehose de logs staff compris) → revalidation ``validity_check`` toutes les ``SESSION_RECHECK_SEC`` (60 s), event ``session_expired`` puis fin du flux (`SystemEvents.listen`, `PipelineEvents.listen`).
- **2026-08-02** — audit — les endpoints de révocation admin n'écrivaient qu'un timestamp : les requêtes HTTP tombaient en 401 mais les flux déjà ouverts (SSE système, SSE pipeline, shell WebSocket) restaient vivants → event ``session_revoked`` sur le bus fichier inter-workers, appliqué sur chaque worker (`apply_session_revocation`, `SystemEvents.disconnect_user`).
- **2026-08-02** — audit — un payload non sérialisable levait ``TypeError`` et tuait le flux SSE du client sans event d'erreur → message fautif abandonné, client conservé (`SystemEvents.listen`).
- **2026-08-02** — audit — un client saturé au moment d'une révocation ou d'une évacuation fermait sans apprendre la cause → la cause est ré-enfilée avant la sentinelle après vidage de la queue (`SystemEvents.disconnect_user`).
- **2026-08-02** — audit — le ``done_callback`` des tâches de fond se limitait à ``discard`` : une boucle morte (tailer, sampler, poller) disparaissait sans trace, la dégradation n'apparaissant que des jours plus tard → exception de la tâche journalisée (`_on_bg_task_done`).
- **2026-08-31** — audit — queue pleine d'un flux pipeline → perte des events les plus anciens plutôt que du client, sentinelle si le ré-enfilage échoue (`PipelineEvents._distribute_local`).
- **2026-09-16** — audit — l'inventaire du serveur intégré (``model_status``) ne part que vers les comptes qui y ont accès, résolution en cache court et fail-open (`SystemEvents._fanout`).
- **2026-09-20** — correctif — sous ``/tmp``, un ``PrivateTmp`` systemd scindait le journal fichier du bus pipeline en silence → fichier sous la racine runtime quand elle est posée (`PipelineEvents.EVENTS_FILE`).
- **2026-09-25** — audit du moteur d'événements — un ``log`` diffusé n'atteignait que le staff branché sur le worker courant, et ``SSELogHandler`` ne voyait que ce worker, créait une Task par ligne et perdait les lignes émises depuis un thread → journal JSONL commun suivi par chaque worker, handler réduit à l'historique en mémoire (`SystemEvents.broadcast`, `_staff_log_tail_loop`, `SSELogHandler`).
- **2026-09-25** — audit du moteur d'événements — le transport pipeline était décidé par worker et chaque worker n'écoutait que le sien (un worker passé en fichier et ses voisins en Redis ne s'entendaient plus ; le secours fichier d'une publication Redis ratée n'était lu par personne) → fichier toujours suivi par tous, Redis retenté périodiquement (`PipelineEvents`, `PipelineEvents._redis_retry_loop`).
- **2026-09-25** — audit du moteur d'événements — la fermeture d'un flux pipeline était muette : la page Code se reconnectait, prenait un 401 et bouclait sans écran de connexion → cause poussée avant la sentinelle (`PipelineEvents.disconnect_user`).
- **2026-09-25** — audit du moteur d'événements — après un chargement ou un déchargement, seuls les clients du worker traitant recevaient ``model_status`` (pastille et ``CURRENT_LOADED_MODELS`` périmés jusqu'à 10 s ailleurs) → événement ``model_cache_refresh`` sur le bus fichier (`refresh_models_everywhere`).
- **2026-09-25** — nettoyage — ``PipelineEventsScope`` retiré (aucune instance).
- **2026-09-26** — optimisation — un ``json.dumps`` par client et une résolution d'accès au moteur par flux → sérialisation unique et paresseuse, accès résolu une fois par compte (`SystemEvents._fanout`) ; décodage puis ré-encodage de chaque event par client sur la page Code → paramètre ``render`` (`PipelineEvents.listen`).
- optimisation — les deux sondes du moteur étaient enchaînées, et le flag vision coûtait une requête réseau (client httpx neuf, liste complète) par modèle, toutes les 10 s et par worker → sondes en parallèle, vision dérivée de l'entrée ``/v1/models`` déjà téléchargée (`_refresh_model_cache`).
- correctif — un rebind de ``CURRENT_LOADED_MODELS`` laissait les modules qui l'importent par nom sur un set vide (faux broadcasts « Modèle auto-chargé », refresh sauté après éviction) → mutation en place (`_refresh_model_cache`).
- correctif — les notifications n'étaient filtrées que côté client : tout compte authentifié recevait le user_id, le type et le compteur de non-lus des autres → filtrage par destinataire à l'enqueue (`SystemEvents._fanout`).
- correctif — ``pubsub`` non fermé au cancel ni avant un retry : chaque flap réseau fuyait une connexion Redis → fermeture systématique (`PipelineEvents._redis_subscriber`).
- correctif — la tâche du poller de modèles n'était pas référencée (collectable à chaud) et jamais annulée au shutdown → ``_register_bg_task`` (`_ensure_model_poller`).
- retrait du moteur agentique (remplacé par Flowise) — ``start_cron_scheduler`` armait aussi un ``_cron_loop`` et le polling des triggers de pipelines → seul le cleanup local par worker reste (`start_cron_scheduler`).
- passage en paquet — ``PROJECT_ROOT`` calculé par chemin relatif à ce fichier pointait au mauvais niveau → plus de calcul local (le module n'en a plus l'usage).
- déplacement — la limitation de débit du login vit dans ``shared_infra/accounts/routes_auth.py`` ; rien n'en est réexporté ici.

## `chatbot_app/routes/saved_chats.py` — historique des conversations (CRUD)

- **2026-08-31** — audit — lecture du chat complet, ``embed_chart_configs`` et upsert de ``save-messages`` tournaient sur la boucle d'événements → threads (`api_saved_save_messages`).
- **2026-08-31** — audit — l'archivage groupé faisait N POST séquentiels, chacun suivi d'un remplacement complet de la liste côté front → endpoint batch (`api_saved_archive_batch`).
- **2026-09-01** — audit — vider ou supprimer un lot bouclait sur ``delete_chat`` (un fsync par chat sous le verrou WAL, en SYNC sur la boucle pour le lot) → une transaction, en thread (`api_saved_clear_all`, `api_saved_delete_batch`).
- **2026-09-16** — audit — un ``save-messages`` reçu pendant un run avançait ``updated_at`` : la persistance finale du run tombait en conflit et la réponse (outils exécutés, tokens payés) était perdue → ignoré tant qu'une génération tient le chat (``skipped: generation_running``).
- **2026-09-21** — correctif — le report de l'état de compression omettait ``ledger_block`` et ``turns_compressed`` : ce PUT effaçait le registre d'artefacts de la compaction → mêmes champs que ``_with_compr_state`` (`api_saved_save_messages`).
- audit — les transactions SQLite synchrones de « Nouveau chat », du renommage et des outils du chat tournaient sur la boucle (gel de tous les flux du worker le temps du verrou WAL) → threads (`api_saved_new`, `api_saved_rename`, `api_saved_set_tools`).
- constat en production — une conversation supprimée pendant une génération en arrière-plan était recréée par la sauvegarde partielle suivante, même en séquentiel strict → ignorée (``skipped: absent``).
- correctif — un partiel périmé envoyé juste avant ``final`` écrasait la version complète → contenu plus court que le stocké refusé (``skipped: stale``).
- correctif — un message multimodal (content en liste) comptait 0 : le payload était toujours rejeté comme périmé → somme des parts texte, poids fixe par part non textuelle (`_content_len`).
- correctif — collision de ``chat_id`` entre comptes : 200 OK pour une sauvegarde qui n'écrivait rien → 409 (`api_saved_save_messages`).
- correctif — ``ids`` envoyé en chaîne était itéré caractère par caractère (suppressions hasardeuses) → 400 si ce n'est pas une liste (`api_saved_delete_batch`).

## `shared_infra/memory/ax/__init__.py` — façade de la mémoire d'accessibilité (AX)

- découpage — le module monolithique ``backend/ax_memory.py`` éclaté en sous-modules, surface d'import conservée à l'identique par la façade (`shared_infra.memory.ax`).
- aucune décision retirée — liste des appelants complétée (`server/app.py`, `shared_infra/memory/routes_ax.py`, noms supplémentaires de `firefox_tools.py`).

## `llm_core/_constants.py` — constantes partagées du cœur LLM

- **2026-07-13** — correctif — `manage_files`, `skill_save` et `skill_add_file`, absents des préfixes sériels, partaient dans le pool parallèle (course delete‖write possible sur un même chemin) et échappaient au ledger d'artefacts de la compression, qui lit la même liste → ajoutés (`LLAMA_TOOL_SERIAL_PREFIXES`).
- **2026-08-21** — audit long-run — filet d'auto-reprise d'une réponse en prose coupée, distinct du plafond de reprise du raisonnement : la prose n'est pas éphémère et sa reprise exige le canal natif `continue_final_message` (`LLAMA_CONTENT_RESUME_MAX`).
- **2026-08-30** — décision — budgets d'itérations des sous-agents relevés ×2 à ×2,4 (25/45/25/30/20/40 → 60/100/60/60/40/80) : le harnais parent tourne à 200 itérations et les enfants s'arrêtaient à un geste près, rendant « je n'ai pas pu terminer » au lieu d'un résultat ; mur wall-clock porté de 1800 à 3600 s dans le même geste, sans quoi le timeout aurait coupé avant le budget (`TASK_MAX_ITERS_*`, `TASK_CHILD_TIMEOUT_S`).
- **2026-09-16** — audit (cible par serveur) — le nombre de slots servant à l'`id_slot` était celui de l'intégré (`_cached_total_slots`) même pour un connecteur llama.cpp → `total_slots` du serveur de la cible, en cache par serveur (`resolve_slot_id_async`, `get_model_total_slots`).
- **2026-09-26** — passe d'optimisation — la requête annexe de titre, posée sur le slot du chat, en évinçait le KV et le tour suivant re-préremplissait tout (mesuré : 10 débuts de tour sur 42 à 0 %, ~7 500 tokens chacun, ~35 s à 210 tok/s) → slot libre autre que celui du chat, à défaut le slot du chat (`resolve_slot_id`, `avoid_own`).
- audit — deux actions d'UI (`desktop_`, `pw_`) groupées en parallel-tool-use s'exécutaient concurremment sur un même écran ou onglet (ordre non déterministe, signatures anti-cycle bruitées) → préfixes sériels ; `execute_shell` reste parallèle, démultiplexé par `call_id` (`LLAMA_TOOL_SERIAL_PREFIXES`).
- correctif — le repli de `LLAMA_MAX_TOOL_ITERATIONS` affichait 80 alors que la configuration vaut 200, faussant de 60 % toute estimation de budget faite depuis ce module → repli aligné sur `shared_infra/config.py`.
- correctif — le paramètre de réutilisation partielle du KV partait sous le nom `cache_reuse` (non reconnu, ignoré en silence par llama-server) avec la valeur 2048 prise pour un « trou max » : la réutilisation partielle n'a jamais été active, et quatre blocs inline dupliqués répétaient l'erreur → `n_cache_reuse` = 256 (taille minimale de bloc), source unique (`apply_kv_cache_params`).
- correctif — le bornage du budget de génération était dupliqué et avait divergé : le chemin classique ne bornait pas les overrides explicites → source unique des deux chemins (`clamp_generation_budget`).
- décision — plafond de sortie du chat porté de 8192 à 16384 tokens : une tâche d'ingénierie produit souvent plus de 8K tokens d'une traite (`LLAMA_MAX_TOKENS_CHAT`).
- correctif — l'affinité de slot par hash pur faisait collisionner des chats actifs bien avant de saturer les slots (éviction mutuelle du KV, mise en file derrière l'autre pendant que des slots restaient libres) → déviation vers un slot libre quand le slot préféré est occupé (`resolve_slot_id`, `busy_slots`).
- refactor — la vue des catégories d'outils était un littéral maintenu à la main, puis un instantané figé à l'import depuis un manifeste annexe : les workers importaient ce module avant que le sous-processus MCP publie ses outils, l'instantané restait vide et les écritures todo partaient vers guest/todos_default → vue vivante sur `llm_core._mcp_categories` (`_LiveToolCategories`, `TOOL_CATEGORIES`).
- refactor — constantes sorties de `backend.services._legacy` pour que les modules frères les importent sans passer par la cale de réexport ; `rag_query` gardé à `None` depuis que le chat atteint le RAG par un service HTTP/SSE (`llm_core._rag_client`) au lieu d'importer `rag_app` au chargement (`rag_query`).

## `shared_infra/desktop/routes.py`, `shared_infra/opencode/routes_code.py` — imports faits à l'appel

- aucune décision retirée (déjà consignée le 2026-10-01) — chaque import fait à l'appel de `routes_cli` ou `routes_events` porte une ligne d'explication du cycle ; renvoi `cli._base_url` → `routes_cli._base_url`.
