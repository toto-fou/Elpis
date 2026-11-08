# Token counters — semantics and sources of truth

Each counter in the app answers a DIFFERENT question. Mixing them up produces
"inconsistencies" that are not (e.g. the Usage tab shows more input tokens
than a chat contains — this is normal, see "submitted tokens"). This document
is the reference; the UI tooltips reuse its labels.

## Truth table

| Counter | Question | Source | Estimated? |
|---|---|---|---|
| **Context gauge** (`liveGen`, a single `kv_cache` event per LLM request) | "How many tokens did the server actually process on the last request?" | ACTUAL `usage.prompt_tokens` from the server, read in the response received at the end of the request (each iteration of the tool loop pushes one) — **nothing is estimated, nothing is emitted pre-flight**; the gauge stays hidden until a request has completed | **never** |
| **Context chip frozen per message** (`metrics.kv_cache`) | "What was the occupancy at the end of this turn?" | last actual server value of the turn, frozen at `final`; fallback `last_prompt_tokens` — also SET BY THE SERVER in the persisted metrics (`_ctx_usage_snapshot`), so it is visible after a reload | no |
| **Idle "ctx" chip + gauge re-seed** (`meta_json["ctx_usage"]`) | "Where does this chat's context stand before I resume?" (after F5 / restart) | snapshot `{used,total,pct,model,ts}` written at the end of the turn by `finalize_turn_meta`, read back by `GET /api/saved/chats/{id}` → `applyChatCtxUsage`; cleared by a manual compaction | no |
| **`metrics.last_prompt_tokens`** | "How large was the LAST prompt sent?" (= end-of-turn context) | `usage.prompt_tokens` of the last llama.cpp iteration — also exposed on the "tool limit" path (summary included); the route NEVER falls back to `input_tokens` for the tool path (cumulative ≠ occupancy, see `_kv_gauge_used_tokens`) | no |
| **`metrics.input_tokens` / `submitted_input_tokens`** | "How many tokens were SUBMITTED to the model to produce this response?" | sum of the `usage.prompt_tokens` of ALL tool loop iterations | no (actual backend usage) |
| **`metrics.thinking_tokens` / `response_tokens`** | "Of what the model GENERATED, how much is reasoning?" | end-of-turn measurement: `reasoning_tokens` declared by the backend → exact `/tokenize` (local llama.cpp) → measured ratio (see `apps/core/src/llm/jetons-raisonnement.ts`) | `thinking_tokens_estimated:true` in the 3rd case (UI: "≈") |
| **Usage tab** (`/api/usage/me`) and **admin Metrics area** | "How many tokens did I / did we submit and receive over the period, and for what?" | aggregate of `usage_events`: **one row per turn**, actual usage, `user_id` + `source` | no — and the split is ALWAYS available (see below) |
| **Compressor** (`tokens_before/after`, `compression_start.tokens`) | "Is the conversation worth compressing, and what did we gain?" | RENDERED prompt (message text) + image flat rate + fixed tools overhead (`extra_fixed_tokens`, passed by the tool loop; classic/manual route = 0); unified heuristic fallback | `tokens_estimated:true` in the stats |
| **Context budget** (`context.pruning.enforce_context_budget`) | "Does the prompt fit in n_ctx?" | exact `/tokenize` PER message (granularity to choose what to remove; image flat rate + per-message margin included), budget reduced by the fixed tools overhead (`fixed_overhead_tokens`) | internal (conservative margin) |

## Counting convention and displayed items (2026-10-03)

Elpis counts like the providers (OpenAI, Anthropic), with input normalized to
OpenAI's meaning:

- **Input** (`prompt_tokens`): everything sent to the model — system,
  history, **tool definitions**, **tool calls and their results**
  re-submitted on every call. The cache read is INCLUDED (OpenAI:
  `prompt_tokens_details.cached_tokens`; llama.cpp: `timings.cache_n`).
  Anthropic excludes it from its `input_tokens` (total input = `input_tokens +
  cache_read_input_tokens + cache_creation_input_tokens`): it is brought back
  to this meaning by `providers/anthropic._normalize_usage` (history:
  migration 0025).
- **Output** (`completion_tokens`): thinking + visible text + tool calls
  emitted by the model. **Thinking** is INCLUDED and billed as output by both
  providers (OpenAI: `completion_tokens_details.reasoning_tokens`; Anthropic:
  even when it is summarized or hidden). Elpis does not re-submit the thinking
  of previous turns: it weighs only once, in output.

Displayed items — `tokenBreakdown` on the server side
(`apps/core/src/observabilite/usage-registre.ts`), `tokenBreakdown` on the
front side (`frontend/src/utils/utils-purs.ts`):

| Item | Meaning | Computation |
|---|---|---|
| **Input** | total sent to the model | `input_tokens` |
| ↳ **Cache** | read from the prompt cache (almost free) | `cache_read_tokens` |
| ↳ **Useful** | actually computed (prefill) | `input_tokens − cache_read_tokens` |
| ↳ **Tools** | definitions, calls and results re-submitted — **estimated** at the measured ratio | `tool_tokens` (0026) |
| **Output** | total generated | `output_tokens` |
| ↳ **Thinking** | reasoning | `thinking_tokens` |
| ↳ **Response** | visible text + tool calls | `output_tokens − thinking_tokens` |

Bounds: cache and tools ≤ input, thinking ≤ output (cache and tools overlap: a
tool result read from the cache counts in both). The **created** cache
(Anthropic) is part of the useful input in the chat and the Usage tab. The
admin Metrics area splits the input in three instead: **read from the cache**
(`cache_read_tokens`), **written to the cache** (`cache_creation_tokens`,
bounded by the input left after the read) and **uncached** (the rest), the
server-side `tokenBreakdown` fields `cache`, `cache_write` and `uncached`.
No provider declares tools: `toolPromptTokens`
(`apps/core/src/contexte/tokens.ts`) estimates them on each call, with no I/O,
and `RunRecord.noteToolInput` accumulates them over the turn like the input,
bounded by the call's actual input. During prefill (reading the prompt), the
message chip shows "Prefill… N % · cache M %": N applies to the USEFUL input
(llama.cpp's `processed` starts from the share read from the cache). Single
compact format: "845", "12.3 k", "1.2 M".

## The `usage_events` registry: one turn, one row, one owner

Until the Metrics area was reworked, consumption was logged **by the caller**
in `metric_events`. Three defects followed, all observed in the code:

- **Double counting.** A tool turn was logged by the loop
  (`total_tokens`, `mode=mcp_native`) *and* by the chat route (`mode=mcp`).
  The Usage tab guarded against it (it never added total and
  input+output); the admin dashboard summed naively.
- **Blind spot.** Routines, webhooks and subagents do not go through the
  route: their consumption reached no aggregate (`task_child_tokens` was read
  by no widget). Title generation and the compressor call were not measured
  anywhere either.
- **Wrong model.** The loop tagged `LLAMA_MODEL` — a configuration constant —
  instead of the model actually targeted: every per-model breakdown was wrong
  as soon as an external connector served the turn.

The measurement is therefore done **in the loop**, once, with the context
(`source`, `user_id`, `origin_id`) set by the caller via `usageScope(...)`.
The input/output split is always known (the loop has `cumul_in`/`cumul_out`),
so the Usage tab's `estimated` flag is gone. Cache tokens are accumulated over
the turn and stored separately (`cache_read_tokens`), and INCLUDED in
`input_tokens` for all engines: llama.cpp and OpenAI-compatible engines
(`prompt_tokens_details.cached_tokens`, otherwise `timings.cache_n`) count
them there themselves; Anthropic, which adds them there, is normalized at the
source (`providers/anthropic._normalize_usage`) and its history by migration
0025.

Each row also carries the engine (`connector`: `builtin`, `conn:<id>`,
`url:<root>`) and the run (`run_id`, table `runs`): a run — chat turn,
routine run, subagent, manual compaction — groups what it consumed (tokens,
LLM time, tools, files, sandbox peaks), see
`apps/core/src/executions/registre.ts`.

A row also counts the requests of its turn whose engine **reported** its prompt
cache, even at zero (`cache_reported_calls`): Anthropic's
`cache_read_input_tokens`, `prompt_tokens_details` (OpenAI-compatible engines;
vLLM with `--enable-prompt-tokens-details`, SGLang with `--enable-cache-report`)
or llama.cpp's `timings.cache_n`. Among them, `cache_hit_calls` counts those
that read part of their input from the cache. The "Requests served by the
cache" widget (« Requêtes servies par le cache ») shows
`cache_hit_calls / cache_reported_calls`: an engine that does not report its
cache is left out rather than counted as misses. Rows written before these
columns hold 0.

## Output reads in two parts: thinking and response

`completion_tokens` is a total that **adds up three things**: reasoning, tool
calls and visible text. No local backend separates them — llama.cpp only knows
the total. On a "thinking" model, thinking can therefore account for most of a
turn's output cost without any view being able to name it: "why did this turn
cost 8,000 output tokens?" had no answer.

`apps/core/src/llm/jetons-raisonnement.ts` produces this missing figure,
**once per turn**, with an explicit order of truth (same idiom as the rest of
the counting: exact first, portable fallback):

1. **Declared** — `usage.completion_tokens_details.reasoning_tokens` (o-series,
   recent vLLM). Exact, free. In tool mode, accumulated over the iterations:
   reading only the last one would undercount everything thought before the
   tool calls.
2. **Tokenized** — `POST /tokenize` on the reasoning text, gated on
   `is_local_llamacpp` like all endpoints of the built-in engine (the local
   tokenizer would say nothing right about text produced by ANOTHER model).
3. **Estimated** — chars/token ratio measured for this model. Flagged
   (`thinking_tokens_estimated`), shown as "≈" in the UI.

**Invariant: thinking ⊆ output.** It is never a third item to add up — it is
a split. "Response" (visible text + tool calls) is derived as
`output_tokens − thinking_tokens`, and the bound is enforced at write time
(`record_usage`) so that it holds IN THE DATABASE and not only in the view that
computed it: an over-generous estimate would otherwise make the response
negative. The `input + output` totals of existing views therefore stay correct
without changes.

What makes the decomposition legitimate: reasoning **is not re-submitted**.
The tool loop does not keep `reasoning_content` in `working_messages`, and
`save_chat` strips `thinking`. These tokens therefore weigh ONLY on the output
of the turn that produced them — never on the next turn's input.

**Corollary: reasoning is NEVER counted in a context budget.** Long reasoning
takes no room from the conversation. Two places did it anyway, and both
penalized it:

- the **overflow rule** took `prompt_tokens + completion_tokens` as occupancy
  → 20 k of thinking triggered a compaction for an occupancy that would not
  exist on the next turn (see below);
- the **auto-resume** (`_think_resume.should_auto_resume`) refused when
  `last_prompt_tokens + cumulative thinking + margin ≥ n_ctx`. But the prompt
  of a resume segment ALREADY CONTAINS this reasoning: the addition counted it
  twice and put the wall at about HALF of the real window. The guard now
  applies to `window_tokens` — the occupancy measured at the end of the
  segment (`prompt + completion`), that is, what the server actually has in KV.

This last guard remains, but it no longer speaks of a "saturated context": it
is the engine's **inference window**, a physical limit (llama.cpp does not
generate beyond its n_ctx). When it is reached, resuming would cost a full
prefill for a few tokens — control goes back to the "Continue" banner. The
only other cap is a runaway guard (`LLAMA_THINK_RESUME_MAX` resumes,
`LLAMA_THINK_RESUME_TOTAL_TOKENS` = 131,072 of cumulative reasoning), not a
context constraint.

Surfaces: the "thinking" chip (brain icon) in a message's metrics line (+
detailed tooltip), Settings › Usage (split under "Output"), Admin console › Metrics
("Thinking" KPI + "Output — thinking vs response" strip). Column
`usage_events.thinking_tokens` (migration 0014) — **no backfill**: history
never carried the information and the reasoning text is not persisted. Earlier
turns count 0, and the views show "—" rather than "0 %" so as not to claim an
absence of reasoning that they cannot verify.

## Why "submitted tokens" ≠ "context occupancy"

In tool mode, each loop iteration re-submits the full history
(system + turns + tool_results): 3 iterations on a ~2,000-token prompt
= ~6,000 tokens **submitted** (what an API bills, with or without cache
discount) for a final **occupancy** of ~2,500. Both numbers are true.
The UI labels them "Submitted tokens (tool total)" and "End-of-turn context"
(tooltip of the message's metrics line).

## Exact counting: prompt RENDERED by the template

Common basis of exact counts:
`countRenderedPromptTokensExact` (`apps/core/src/contexte/tokens.ts`) asks
llama-server to RENDER the prompt exactly as for `/v1/chat/completions`
(`POST /apply-template`: special tokens `<|im_start|>`/`<|im_end|>`,
generation prompt, tool embedding) then tokenizes it with `add_special` (BOS).

**Why**: the old count summed the `/tokenize` of each message serialized as
plain text + a fixed flat rate per message. It MISSED the structure of the chat
template → it systematically undercounted system + tools (the "counters only
count the output" bias). The per-message count is now only a **portable
fallback** if `/apply-template` is absent (old llama.cpp build); image blocks
(not tokenizable) add their flat rate on top (`image_forfait_tokens`, shared
helper `_token_estimate`).

**Composition per consumer** (same bricks, assembled the same way):

- **Gauge**: NO counting — it reads the actual `usage.prompt_tokens` in the
  server response (end of request). The exact rendering is no longer used for
  display.
- **Compression gate**: exact rendering of the messages (without embedded
  tools) + image flat rate + fixed tools overhead counted separately once per
  run and passed by the tool loop (`extra_fixed_tokens`). The manual route
  passes 0 (no `tools_payload` in its context).
- **Budget fit** (`context.pruning.enforce_context_budget`): PER-message
  count — it needs message-by-message granularity to choose WHICH old turns to
  remove (+ output reserve = effective generation cap); the fixed tools
  overhead is subtracted from the budget (`fixed_overhead_tokens`). A margin of
  a few tokens per message vs the rendering (conservative, intended).
- **Single overflow rule** (harness v4, M3 — replaces the pre-gate):
  compaction starts when `occupancy ≥ usable = n_ctx − generation cap −
  buffer`. Occupancy by order of truth: ACTUAL measurement of the last call
  (`usage.prompt_tokens` **alone**) + delta of the messages that appeared since
  (measured ratio); without a measurement, an estimate at the measured ratio
  CONFIRMED by an exact count before acting (the exact occupancy is anchored —
  never a count per iteration). No percentage, no margin, no cooldown.
  **`completion_tokens` does not enter the occupancy**. Two reasons: the
  reasoning it contains is ephemeral — never re-submitted, so it weighs
  NOTHING on the working context — and its visible part is already recounted by
  the delta, the assistant message being added to `working_messages` AFTER the
  measurement.
- **Tool output pruning** (`select_prune_keys` + `apply_prune_marks`):
  selection in EXACT tokens (protected window 20 % of n_ctx + last 2 turns),
  marks persisted in `meta_json["ctx_pruned_keys"]`, rendered with a full
  marker.
  The selection ALSO runs **during** the run (cadence
  `run_profile.prune_every_iters`) and the marks are applied by `fit_context`
  on each iteration. Before, it happened only at the end of the turn and was
  rendered only on the NEXT turn: a run of several hundred iterations therefore
  never pruned anything and had only the hard budget — which DROPS whole
  messages instead of erasing recoverable outputs. Within a run, monotonicity
  relies on `already_marked` (the content of `working_messages` is still full:
  it is never mutated).
- **Task anchor** (`task_anchor_index`): the hard budget NEVER removes the last
  non-ephemeral `user` message — the request that triggered the run. It used to
  move back in the list over the tool cycles and ended up droppable: the agent
  kept its last `grep` and forgot what it had been asked. Released if it weighs
  more than 15 % of the budget (giant attachment).
- **Context window per TARGET** (`apps/core/src/llm/fenetre-contexte.ts`): on a
  remote connector, the local `/props` described another model — or nothing,
  and `ctx=0` put the whole pipeline to sleep. Resolution: connector > known
  family > `LLM_REMOTE_N_CTX` > 0 (logged). The window of an engine that
  announces it (llama.cpp, vLLM, SGLang) is never guessed from the model name:
  connector > engine > `LLM_REMOTE_N_CTX` > 0 (`qwen3*` was 131,072 even for a
  262,144 model).

## MEASURED ratio (harness v4 — no more static heuristic in decisions)

`apps/core/src/contexte/tokens.ts`: **chars/token ratio MEASURED per model**
(EWMA fed by each actual response: chars of the prompt sent ÷ billed
`prompt_tokens`; cold start 3.3, bounds [1.5, 8]). All thresholds in the app
are in TOKENS; string lengths are only MATERIALIZATIONS (`tokens_to_chars`,
emission cuts, serializer budgets) — the `tokens_to_chars_stable` variant
(frozen start value) is used for caps re-evaluated on stored content (sanitize
net, desktop floor), so that the rendering stays byte-stable. As soon as
`/tokenize` answers, the count is exact; a partially estimated count stays
flagged `tokens_estimated`. (The gauge no longer has an estimated mode at all.)

## Known special cases (accepted)

- **Thinking**: counted in the `output_tokens` of the turn that generates it,
  but stripped from the persisted history → it does NOT appear in the next
  turn's prompt. The gauge value deliberately excludes it (otherwise "4.7k at
  end of turn" vs ~800 in the next prompt); during generation, the live gauge
  shows separately the tokens generated that the last measured prompt does not
  count (those of the call it measures, then those received since:
  "131k + 49k / 262k"): they occupy the engine's cache, which can reach the
  window before the next measurement.
- **Anthropic**: its `input_tokens` counts only new tokens; it is brought back
  to the common meaning (cache included) by `_normalize_usage`, and
  `cache_read/creation_input_tokens` stay exposed separately in the metrics.
  The context gauge stays hidden for remote targets (no reliable `/tokenize`,
  local tokenizer ≠ remote tokenizer).
- **Reasoning kept (SGLang)**: disabled by default. When enabled, the thinking
  of each tool call of the turn goes back to the engine (`reasoning_content`):
  it then occupies the engine's window and counts in `payloadChars` and in the
  per-message estimate during that turn. It stays absent from the persisted
  history, hence from the next turn's prompt.
- **`prompt_n` (llama.cpp timings)**: feeds NOTHING on the context side anymore
  — with the prefix cache it counts only re-evaluated tokens (it excluded
  system + tools + cached turns). Timings are used only for throughput
  metrics.
- **Gauge = actual only, at the end of the request** (design decision): no
  more pre-flight emission (neither `/apply-template` nor heuristic; the old
  `est` flag/"≈" is gone) — a single `kv_cache` event per LLM request, built
  from the actual usage of the response. During the very first request of a
  chat (or after a manual compression), the gauge is hidden: show nothing
  rather than imagine. Content generated on turn N appears in the actual
  `prompt_tokens` of turn N+1. The occupancy is never capped to the known
  window: an actual prompt longer than the window (declared too small or
  guessed) is shown as is, live as on reload (`ctx_usage`); only the percentage
  is capped. A `notice` is sent once per turn if this window is read from the
  engine or declared on the connector; when guessed, only the log reports it.
  The KV cache capacity replaces the window only for llama.cpp (pool shared
  between requests on vLLM and SGLang).
- **Continue**: the resume re-submits the previous turn's trunk → the submitted
  tokens of the resume turn include this re-prefill (faithful to API reality).
  The message's metrics ADD its segments (`merge_continue_metrics`, `segments`
  in the tooltip): before, the resume replaced those of the truncated segment.
