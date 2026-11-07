# Chat turn flow

`POST /api/chat-saved-stream3` (`apps/core/src/familles/chat.ts`) generates a turn as an NDJSON stream. The route
only chains steps:

1. admission (`admettreTour` from `apps/core/src/tour/ouverture.ts`, helpers in `apps/core/src/tour/admission.ts`):
   409 if a manual compression or a generation is already running on the conversation;
2. preparation (`apps/core/src/tour/preparation.ts`);
3. presence lock, database resync after a handover, lock reservation;
4. the turn (`apps/core/src/tour/execution.ts`), pumped by `apps/core/src/tour/evenements.ts`.

The background-task waker (`apps/core/src/jobs/service.ts`) also opens turns, through the same
`ouvrirTour`: wake message with role `user` (`origin: "job_wake"`), `data` built on the server side, resumable
run consumed without a client, at most `wake_concurrency` (1) at a time per account.

A body that carries `image_gen` is an "Images" turn (`apps/core/src/tour/image.ts`), after the same guards. The
other chat routes:

- `apps/core/src/familles/chat-controle.ts`: Stop, state, attaching to a run through
  `apps/core/src/tour/suivi-run.ts`;
- `apps/core/src/familles/chat-compression.ts`: manual compression.

## Invariants to keep in any rework

- **One turn at a time per conversation**: in-memory presence lock, a single main process
  (`apps/core/src/tour/etat.ts`). A compaction or a generation already running returns 409.
- **Presence lock never lost**: any exception between taking it and opening the stream releases it. It is
  then reserved until the turn claims it, and a safety net releases it if nobody claims it. If lost, it
  would return 409 on this chat until restart.
- **MCP server addresses**: resolved on the server side at preparation, never taken from the client.
- **Cancellation**: through the turn's AbortSignal (Stop: flag, controller abandoned, engine session stopped),
  never through system events (verified by the maintainers' tests). The partial is saved. The signal
  reaches the tool host (`notifications/cancelled`): the foreground shell command is killed there in the
  container (see "Subagents" in `docs/architecture.md`); a disconnected client whose run detaches
  abandons nothing.
- **Disconnected client**: the run detaches if it is resumable (`resumable`), if a tool has already run or if
  `llm.detach_run_on_disconnect` is active; otherwise it stops, saving the partial. A Stop always stops it.
  You re-attach with `GET /api/chat/{id}/run/events`, including after a restart
  (`apps/core/src/tour/journal-run.ts`).
- **Optimistic saving** on `updated_at` (`apps/core/src/tour/persistance.ts`): a conflict is reported, nothing
  is overwritten. Persistence precedes `kv_cache` and `final`.
- **NDJSON stream types**: registry `packages/contracts/src/stream-events.gen.ts`.
- **RAG and prefix cache** (`apps/core/src/rag/chat.ts`, `apps/core/src/rag/outils-chat.ts`): the system head never
  depends on the active collections (`rag_*` tools and `FRAGMENT_RAG` are static; only 0 → 1 and 1 → 0 collections
  change the tool list); the `<rag_context>` block is a suffix of the question of the turn where the selection changes,
  saved in `llm_user_suffixes` and replayed identically; passages arrive only through tool results,
  numbered once and for all; the message's sources (`rag_sources`) never go back to the model.
- **Tools-only path**: the classic no-tools path from the Python version is not carried over.

## Event order of a turn

Order fixed by the maintainers' `flux_route_outils_*` test scenarios (development repository), which also re-read
this block: each scenario must conform to it, step after step, with no going back. A line gives a step and its
types; `<boucle>` stands for the other loop events
(`LOOP_EVENTS` in the registry): a type named in the block is allowed only at its steps.

```ordre-du-flux
1 mode
2 queue_status thinking
3 queue_cleared
4 mode <boucle>
5 kv_cache error
6 final
```

1. **`mode`**: active MCP servers and/or "Documents" (RAG collections active in the chat).
2. **Waiting for the engine**:
   - `queue_status` if the engine is not ready;
   - `thinking` "Waiting…" if the request has to wait for a server slot;
   - more `queue_status` events during the wait.
3. **`queue_cleared`**: only if a `queue_status` was sent.
4. **Loop**: `mode` "Tools ready…", then the loop events (`tool_call`, `tool_result`, tokens,
   compression, `rag_sources` after a `rag_*` tool that numbered passages…).
5. **End of work**: `kv_cache` if context occupancy could be measured; `error` on failure.
6. **`final`**: answer, metrics, `persisted` and `rag_sources` (the message's sources, `cited` set from the
   answer), then end of stream.

What can be interleaved, and the variants:

- **`ping`**: at any time, when the stream is idle.
- **`title`**: once, after `mode` and before `final`, as soon as the model's title of a new chat arrives and
  is saved (not sent if the chat was renamed meanwhile or the stream already ended).
- **Model loading**: the tracking (`evenements.ts`) republishes `queue_status` at each step, then emits its own
  `queue_cleared`, anywhere as long as loading lasts.
- **Failure**: `error`, then a partial `final`.
- **Stop during the wait**: a partial `final` (scenarios `flux_route_outils_stop_file*`).
- **Stop during generation**: no more events, except the partial `final` and a subagent's `task_step` `status=final`
  (terminal state of its row). The `tool_history_partial` snapshot returns, for the in-flight `task` call, the
  `task_cancelled` with its `task_id` rather than the sentinel (the tool puts it in the partial batch:
  `AppelIntegre.rendreSiAnnule`), without changing the order or types of events.
