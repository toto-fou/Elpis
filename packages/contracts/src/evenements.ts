// SPDX-License-Identifier: MIT
/** packages/contracts/src/evenements.ts — charges utiles des 46 événements du flux NDJSON, relevées chez leurs émetteurs Python. */
import { z } from "zod";

import { schemaMetaOutils } from "./rest/chats";
import { schemaOrigineTour, schemaResumeReveil } from "./rest/jobs";
import { schemaSourceCiteeRag } from "./rest/rag";
import type { StreamEventType } from "./stream-events.gen";

const entier = z.number().int();
const texte = { text: z.string() };
const dict = z.record(z.string(), z.unknown());
const outil = z.literal("tool");

function ev<T extends StreamEventType, S extends z.ZodRawShape>(type: T, forme: S) {
  return z.strictObject({ type: z.literal(type), ...forme, _s: entier.optional() });
}

export const schemaFichierModifie = z.strictObject({
  path: z.string(),
  change: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
  added: entier.optional(),
  removed: entier.optional(),
  from: z.string().optional(),
});
export type FichierModifie = z.infer<typeof schemaFichierModifie>;

export const schemaImageRef = z.strictObject({
  id: z.string(),
  url: z.string(),
  thumb_url: z.string(),
  width: entier,
  height: entier,
  mime: z.string(),
  seed: entier.optional(),
});
export type ImageRef = z.infer<typeof schemaImageRef>;

const erreurImage = {
  code: z.enum(["engine", "invalid", "busy", "cancelled", "too_large", "unavailable", "timeout", "refused"]),
  message: z.string(),
  retryable: z.boolean(),
};

/** Issue d'un sous-agent : la déclaration de sa ligne `Status:` (`done`, `partial`, `blocked`, ou `unknown` s'il n'en a pas écrit de lisible) corrigée par les limites que le harnais constate (`budget_exhausted`, `timeout`, `unavailable`, `error`, `cancelled`). */
export const STATUTS_TACHE = [
  "done",
  "partial",
  "blocked",
  "unknown",
  "budget_exhausted",
  "timeout",
  "unavailable",
  "error",
  "cancelled",
] as const;
export type StatutTache = (typeof STATUTS_TACHE)[number];

/** Issue d'une vérification (agent `verify`) déclarée sur la ligne `Verdict:` de tête de son rapport ; `Status` dit seulement si le travail est fait. */
export const VERDICTS_TACHE = ["pass", "fail", "inconclusive"] as const;
export type VerdictTache = (typeof VERDICTS_TACHE)[number];

export const schemaFichierTache = z.strictObject({
  path: z.string(),
  change: z.string(),
  added: entier.optional(),
  removed: entier.optional(),
});
export type FichierTache = z.infer<typeof schemaFichierTache>;

/** Bloc de métadonnées du harnais joint au résultat de `task` (`<task_meta>`), à l'étape finale et au run persisté. */
export const schemaBilanTache = z.strictObject({
  /** Légende des champs pour le modèle, en tête du premier `<task_meta>` de la conversation seulement (jamais dans l'étape finale ni le run persisté). */
  legend: z.string().optional(),
  status: z.enum(STATUTS_TACHE),
  stop_reason: z.string().optional(),
  /** Appels d'outils de ce lancement, puis cumulés sur les reprises par `task_id`. */
  tool_calls: entier,
  tool_calls_total: entier,
  /** Points d'étape `<harness_status>` envoyés à l'agent : appels faits à l'envoi (`at`), texte sans balises. */
  budget_warnings: z.array(z.strictObject({ at: entier, text: z.string() })).optional(),
  iterations: entier,
  resumed: z.boolean(),
  duration_s: z.number(),
  /** Attente avant la place au moteur (s), depuis l'appel `task` : l'échéance de `max_seconds` compte `queued_s + duration_s` ; absent sur les anciens runs et les refus. */
  queued_s: z.number().optional(),
  /** Fichiers écrits par les outils de fichiers ou git de l'agent, ou relevés par son shell. */
  files_changed: z.array(schemaFichierTache),
  /** Un autre run du compte qui peut écrire a tourné pendant celui-ci : `files_changed` peut contenir ses fichiers. */
  concurrent: z.literal(true).optional(),
  git: z.strictObject({
    branch: z.string().optional(),
    commits: z.array(z.string()),
    /** Index git changé par `git_action` (stage, unstage, stash, stash_pop, merge) : le relevé des fichiers ne le voit pas. */
    index_changed: z.literal(true).optional(),
    /** Chemins passés à `git_action(stage)` (`.` : toutes les modifications) ; un `unstage` peut en avoir retiré. */
    staged: z.array(z.string()).optional(),
  }),
  errors: entier,
  read_only: z.boolean(),
  remaining_work: z.string().optional(),
  /** Ligne `Verdict:` de tête d'un rapport `verify` (`fail` : un test ou une commande a échoué, même si le travail est `done`) ; absent si l'agent n'en a pas écrit de lisible. */
  verdict: z.enum(VERDICTS_TACHE).optional(),
  report_chars: entier,
  /** Rapport plus long que le plafond : texte complet sauvé dans le bac à ce chemin. */
  report_saved_to: z.string().optional(),
  secrets_masked: entier.optional(),
});
export type BilanTache = z.infer<typeof schemaBilanTache>;

const etapeCommune = {
  child_id: z.string(),
  agent: z.string(),
  /** Appel `task` du parent (TS, toujours posé) : la ligne du chat s'y rattache ; `child_id` vide : refus avant lancement. */
  call_id: z.string().nullable().optional(),
};
const etapeOutil = {
  step: entier,
  max_steps: entier,
  calls: entier,
  tool: z.string().nullable(),
  tokens: entier,
};

/** Consommation rapportée par le moteur (TS) : entrée (part en cache comprise), sortie (réflexion comprise), part en cache, réflexion. */
const consoEtape = {
  input_tokens: entier,
  output_tokens: entier,
  cache_tokens: entier.optional(),
  think_tokens: entier.optional(),
};

const taskStep = z.discriminatedUnion("status", [
  /** `background` : lancé en fond (`task(background=true)`), il survit au tour (TS). */
  ev("task_step", {
    ...etapeCommune,
    status: z.literal("spawned"),
    resumed: z.boolean(),
    depth: entier,
    background: z.literal(true).optional(),
  }),
  /** `tokens` : occupation du contexte de l'enfant ; la consommation cumulée suit chaque requête ; `started` : l'enfant a sa place au moteur, son horloge part (TS). */
  ev("task_step", {
    ...etapeCommune,
    status: z.literal("tick"),
    started: z.literal(true).optional(),
    tokens: entier,
    ...consoEtape,
    input_tokens: entier.optional(),
    output_tokens: entier.optional(),
  }),
  ev("task_step", { ...etapeCommune, status: z.literal("text"), text: z.string() }),
  /** Message du parent remis à l'enfant en fond (`task_send`), avant sa requête suivante au moteur. */
  ev("task_step", { ...etapeCommune, status: z.literal("parent"), text: z.string() }),
  ev("task_step", { ...etapeCommune, status: z.literal("running"), ...etapeOutil, args_preview: z.string() }),
  ev("task_step", {
    ...etapeCommune,
    status: z.enum(["done", "error"]),
    ...etapeOutil,
    result_preview: z.string(),
    files: z.array(schemaFichierModifie).optional(),
  }),
  ev("task_step", {
    ...etapeCommune,
    status: z.literal("final"),
    state: z.enum(["completed", "failed", "incomplete", "cancelled", "timeout"]),
    steps_total: entier,
    context_tokens: entier,
    ...consoEtape,
    /** Jetons de réflexion mesurés (ou estimés) de l'enfant ; absent sur les anciens runs. */
    think_tokens: entier.optional(),
    duration_ms: entier,
    transcript: z.array(
      z.union([
        z.strictObject({ text: z.string() }),
        z.strictObject({ parent: z.string() }),
        z.strictObject({
          tool: z.string(),
          call_id: z.string().nullable(),
          args_preview: z.string(),
          status: z.string(),
          result_preview: z.string(),
        }),
      ]),
    ),
    result: z.string(),
    harness: schemaBilanTache.optional(),
  }),
]);

const cheminCompression = z.enum(["endpoint", "external_model", "self"]);

export const SCHEMAS_EVENEMENTS = {
  mode: ev("mode", { ...texte, kind: z.literal("image").optional() }),
  iteration: ev("iteration", { n: entier, max: entier, tokens_used: entier, context_tokens: entier }),
  thinking: ev("thinking", texte),
  thinking_token: ev("thinking_token", { ...texte, n: entier.optional() }),
  thinking_content: ev("thinking_content", texte),
  content_token: ev("content_token", { ...texte, n: entier.optional() }),
  content_replace: ev("content_replace", texte),
  tool_call: ev("tool_call", {
    name: z.string(),
    args: dict,
    call_id: z.string(),
    internal: z.literal(true).optional(),
  }),
  tool_call_delta: ev("tool_call_delta", {
    index: entier,
    iter: entier,
    name_delta: z.string().optional(),
    args_delta: z.string().optional(),
    reset: z.literal(true).optional(),
  }),
  tool_result: ev("tool_result", {
    name: z.string(),
    call_id: z.string(),
    result: z.string(),
    duration_ms: entier.nullable(),
    desktop: z.strictObject({ sig: z.string().optional(), elements: z.array(dict).optional() }).optional(),
    files: z.array(schemaFichierModifie).optional(),
    path: z.string().optional(),
    dry_run: z.literal(true).optional(),
    sha256: z.string().optional(),
    internal: z.literal(true).optional(),
    screenshot_url: z.string().optional(),
    screenshot_step: z.union([entier, z.string()]).optional(),
    screenshot_session: z.string().optional(),
  }),
  tool_progress: ev("tool_progress", {
    name: z.string(),
    call_id: z.string().optional(),
    progress: z.number(),
    total: z.number().nullable(),
    message: z.string(),
  }),
  tool_log: ev("tool_log", {
    name: z.string(),
    call_id: z.string().optional(),
    level: z.string(),
    logger: z.string(),
    message: z.string(),
  }),
  tool_state: ev("tool_state", {
    name: z.string(),
    call_id: z.string(),
    state: z.enum(["waiting", "running", "done"]),
    duration_ms: entier.optional(),
  }),
  tool_limit: ev("tool_limit", {
    iterations: entier,
    effective_iterations: entier,
    hard_iterations: entier,
    hard_iterations_max: entier,
    max_iterations: entier,
    tool_calls_done: entier,
    reason: z.enum(["empty_choices", "max_iter_reached"]),
    limit_kind: z.enum(["hard", "effective"]),
    stop_reason: z.enum([
      "steps",
      "hard",
      "wallclock",
      "wrap_up",
      "ctx_saturated",
      "gen_cap",
      "cycle",
      "empty_choices",
    ]),
  }),
  tool_history_partial: ev("tool_history_partial", { tool_history: z.array(dict) }),
  shell_output: ev("shell_output", {
    name: z.string(),
    call_id: z.string().nullable(),
    stream: z.enum(["stdout", "stderr"]).optional(),
    chunk: z.string().optional(),
    seq: entier,
    done: z.boolean(),
    returncode: entier.optional(),
    duration_ms: entier.optional(),
    timed_out: z.boolean().optional(),
    bytes_total: entier.optional(),
    live_truncated: z.boolean().optional(),
  }),
  task_step: taskStep,
  todo_updated: ev("todo_updated", {
    todos: z.array(z.strictObject({ content: z.string(), status: z.string(), priority: z.string() })),
    remaining: entier.nullable(),
  }),
  annotation_frame: ev("annotation_frame", {
    image_url: z.string(),
    img_w: entier,
    img_h: entier,
    boxes: z.array(dict),
    target: z.string(),
    sig: z.string(),
    ts: entier,
  }),
  prompt_progress: ev("prompt_progress", {
    total: entier,
    processed: entier,
    cache: entier,
    time_ms: entier,
    iter: entier,
  }),
  kv_cache: ev("kv_cache", { used: entier, total: entier, pct: entier }),
  compression_start: ev("compression_start", {
    external: z.boolean(),
    path: cheminCompression,
    model: z.string(),
    turns: entier,
    tokens: entier,
    ctx_size: entier,
    threshold: entier,
    reason: z.enum(["manual", "overflow", "threshold"]),
  }),
  compression_done: ev("compression_done", { external: z.boolean(), path: cheminCompression, stats: dict }),
  compression_capped: ev("compression_capped", { round: entier, max: entier }),
  compression_state: ev("compression_state", {
    round: entier,
    covered_turns: entier,
    summary_xml: z.string(),
    turns_compressed: entier,
    ledger_block: z.string(),
  }),
  prune_state: ev("prune_state", { keys: z.array(z.string()) }),
  llm_user_suffix: ev("llm_user_suffix", texte),
  queue_status: ev("queue_status", {
    kind: z.enum(["waiting", "loading", "ready"]),
    model: z.string().optional(),
    loaded: z.string().nullable().optional(),
    position: entier.optional(),
    active: entier.optional(),
    est_ms: entier.optional(),
    waited_ms: entier.optional(),
    stage: z.string().optional(),
    stages: z.array(z.string()).optional(),
    progress_pct: z.number().optional(),
  }),
  queue_cleared: ev("queue_cleared", {}),
  rag_sources: ev("rag_sources", { sources: z.array(schemaSourceCiteeRag) }),
  image_progress: ev("image_progress", {
    state: z.string(),
    queue_position: entier.nullable(),
    elapsed_s: z.number(),
    eta_s: z.number().nullable(),
    pct: z.number().nullable(),
    pct_real: z.boolean(),
    width: entier,
    height: entier,
    n: entier,
    source: outil.optional(),
    preview: z.string().optional(),
  }),
  image: ev("image", { items: z.array(schemaImageRef), prompt: z.string(), source: outil.optional() }),
  image_prompt: ev("image_prompt", texte),
  image_error: ev("image_error", { ...erreurImage, source: outil.optional() }),
  info: ev("info", texte),
  notice: ev("notice", { level: z.literal("warn"), message: z.string() }),
  warning: ev("warning", texte),
  error: ev("error", {
    ...texte,
    detail: z.string().optional(),
    kind: z
      .enum([
        "context_overflow",
        "invalid_request",
        "forbidden",
        "rate_limited",
        "loading",
        "unreachable",
        "timeout",
        "unknown",
      ])
      .optional(),
    iteration: z.string().optional(),
    hard_iteration: z.string().optional(),
  }),
  log: ev("log", { message: z.string(), level: z.string() }),
  final: ev("final", {
    assistant: z.string(),
    chat_id: z.string(),
    run_ids: z.array(z.string()),
    metrics: dict.nullable(),
    thinking: z.string().optional(),
    tool_limit_reached: z.boolean().optional(),
    truncated: z.boolean().optional(),
    truncated_in_think: z.boolean().optional(),
    persisted: z.boolean(),
    persist_error: z.string().optional(),
    cancelled: z.boolean().optional(),
    title: z.string().optional(),
    files_changed: z.array(schemaFichierModifie).optional(),
    compactions: z.array(dict).optional(),
    pruned: entier.optional(),
    tool_images: z.array(schemaImageRef).optional(),
    rag_sources: z.array(schemaSourceCiteeRag).optional(),
    tool_meta: schemaMetaOutils.optional(),
    plan_mode_done: z.literal(true).optional(),
    generated_images: z.array(schemaImageRef).optional(),
    image: z.literal(true).optional(),
    revised_prompt: z.string().optional(),
    image_meta: dict.optional(),
    image_error: z.strictObject(erreurImage).optional(),
  }),
  ping: ev("ping", {}),
  run_started: ev("run_started", {
    run_id: z.string(),
    chat_id: z.string(),
    engine_key: z.string(),
    model: z.string(),
    is_continue: z.boolean(),
    base_count: entier,
    user_message: z.string(),
    image_request: dict.optional(),
    origin: schemaOrigineTour.optional(),
    wake: schemaResumeReveil.optional(),
  }),
  replay_done: ev("replay_done", {}),
  run_end: ev("run_end", { status: z.enum(["done", "error", "cancelled", "unknown"]) }),
  run_lost: ev("run_lost", { reason: z.enum(["journal", "worker"]) }),
  journal_truncated: ev("journal_truncated", {}),
  session_expired: ev("session_expired", {}),
} satisfies Record<StreamEventType, z.ZodType>;

export const schemaEvenementFlux = z.discriminatedUnion("type", [
  ...(Object.values(SCHEMAS_EVENEMENTS) as [
    (typeof SCHEMAS_EVENEMENTS)[StreamEventType],
    ...(typeof SCHEMAS_EVENEMENTS)[StreamEventType][],
  ]),
]);

export type EvenementFlux = {
  [T in StreamEventType]: z.infer<(typeof SCHEMAS_EVENEMENTS)[T]>;
}[StreamEventType];
export type EvenementDe<T extends StreamEventType> = z.infer<(typeof SCHEMAS_EVENEMENTS)[T]>;

/** Émis dans le process et interceptés par le tour : jamais sur le fil ni dans le journal. */
export const EVENEMENTS_INTERNES: ReadonlySet<StreamEventType> = new Set<StreamEventType>([
  "tool_history_partial",
  "llm_user_suffix",
  "prune_state",
  "compression_state",
]);
