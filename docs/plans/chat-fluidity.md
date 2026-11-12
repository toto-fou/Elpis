# Plan — smooth chat streaming and animations

Status: **to do**. Audience: the coding agent that implements it. Read
[AGENTS.md](../../AGENTS.md) first: its conventions and invariants apply
to every step below.

Goal: make the chat feel as fluid as Open WebUI or Qwen Chat while a
response streams in (text that flows, steady stick-to-bottom scrolling,
cheap animations), without changing the server, the NDJSON protocol or
the stream reducer.

All paths below are relative to `frontend/src/` unless they start with
`frontend/` or the repository root. Line numbers are those of the commit
this plan was written on; rely on the function names if they drift.

---

## 0. Current state (what makes it jerky)

Measured by reading the code, not yet profiled. Confirm with step 0.

| #   | Where                                                                                                                                                                               | What happens today                                                                                                                                          | Effect                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | `features/chat/coeur/rendu-flux.ts:11` `RENDU_ACTIF_MS = 110`                                                                                                                       | The block being written (active block) is re-rendered at most every 110 ms.                                                                                 | ~9 visual updates/s: text appears in chunks of words.                                                                                                |
| B   | `rendu-flux.ts:12-13` `FENETRE_LISSAGE_MS = 350`, `LISSAGE_MIN = 24`; `smoothTake()`                                                                                                | Received text is held in `f.streamBuf` and revealed over up to 350 ms, at least 24 chars at a time.                                                         | Added latency, visible jumps.                                                                                                                        |
| C   | `rendu-flux.ts:37` `streamFlushDelay()`; `streamFlushTick()` (`setTimeout` 40 / 80 / 120 ms)                                                                                        | Body flush on `setTimeout`, not aligned with frames; slower as the text grows.                                                                              | 25 fps at best, 8 fps after 64 KB.                                                                                                                   |
| D   | `features/chat/coeur/vue-flux.ts:73` (`setInterval` 100 ms, thinking), `vue-flux.ts:115` (`setInterval` 40 ms, tool narration `_pp`), `rendu-flux.ts:13` `SHELL_FLUSH_MS = 120`     | Three more independent timers, each patching the message.                                                                                                   | Several Vue updates per frame, out of phase.                                                                                                         |
| E   | `components/chat/page/FilConversation.vue:23` class `scroll-smooth`; `rendu-flux.ts:88` `scheduleStreamScroll()` writes `scrollTop` without disabling it                            | Every flush starts a smooth-scroll animation that the next flush interrupts.                                                                                | The view chases the text and trembles.                                                                                                               |
| F   | `app/racine/defilement.ts:64` `ResizeObserver` also sticks to bottom (with `scrollBehavior = "auto"`)                                                                               | Stick-to-bottom is done twice, by two mechanisms with different behavior.                                                                                   | Conflicting scroll writes.                                                                                                                           |
| G   | `features/chat/liste/defilement-virtuel.ts:92` `mesurer()` reads `offsetHeight` of every rendered message; called from a `ResizeObserver` (`:368`) and from every scroll event      | While the last message grows, measurements run every frame, interleaved with scroll writes.                                                                 | Forced layouts (layout thrashing).                                                                                                                   |
| H   | `rendu-flux.ts` `patch()`, `streamFlushTick()`: `m[i] = Object.assign({}, cur, …)`; `messages` is a deep `ref` (`app/racine/racine.ts:604`)                                         | The whole message object is replaced at every flush.                                                                                                        | Every `computed` of the message (`features/chat/message/tour-affiche.ts`: tool steps, captures, memory lines…) is re-evaluated; the list re-renders. |
| I   | `components/chat/ContenuMarkdown.vue` template: `v-html="actif"`                                                                                                                    | The whole active block's `innerHTML` is replaced at every render; the caret is injected in the HTML (`features/chat/rendu/markdown.ts:74` `injecterCaret`). | Caret blink restarts, text selection is lost, more DOM work.                                                                                         |
| J   | `components/chat/page/PageChat.vue:106` composer card `bg-white/90 backdrop-blur-xl` (24 px blur) floating over the scrolling thread                                                | The blur behind the composer is recomputed every frame the thread scrolls.                                                                                  | Costly on laptops and weak GPUs.                                                                                                                     |
| K   | `frontend/css/style.css:457` `mem-wave-sweep`, `:4912` `elpis-mcp-fil` (animate `background-position`), `:4632` `.elpis-img-tile__wash` (`filter: blur(22px)` on an animated layer) | Infinite animations on non-composited properties.                                                                                                           | Repaint every frame while visible.                                                                                                                   |
| L   | `PageChat.vue:65,77` `transition-all duration-300`; ~20 `transition-all` in `components/`                                                                                           | Transitions on every property, including layout ones.                                                                                                       | Unexpected layout animations.                                                                                                                        |

What is already good and must be kept: finished blocks are rendered once
and frozen (`scanStreamBlocks` / `renderStreamBlock`), virtual scrolling,
enrichment after the stream (`planifierEnrichissement`, `requestIdleCallback`),
`flush_interval -1` in the Caddy templates.

---

## Rules for the whole plan

- Do **not** touch the server, the NDJSON event order, `EvenementFlux` or the
  stream reducer. Only the display pipeline changes.
- Every stop / end path must keep working: the timers listed in D are cleared
  in `features/chat/coeur/runs.ts:240-247, 500-507`,
  `features/chat/coeur/generation.ts:360-367, 484-503`,
  `features/chat/coeur/vue-flux.ts:81-84, 587-590`. If a timer is replaced,
  replace it in **all** those places (search `thinkFlushTimer`,
  `preContentFlushTimer`, `streamFlushTimer`, `shellFlushTimer` and the
  state type in `features/chat/coeur/etat.ts:216-260`).
- Keep the voice hooks: `l.voix().onAssistantStream(content)` and
  `onAssistantToolStream(complet)` must still receive the growing text.
- Keep `isUserScrolling` semantics (`app/racine/defilement.ts`): when the user
  scrolls up, nothing pulls them back down.
- `prefers-reduced-motion`: every new transition or animation is also declared
  in the reduced-motion block of `frontend/css/style.css`; use
  `mouvementReduit()` (`utils/dom.ts:4`) in TS.
- Code style: SPDX header, French comments, at most one line per function, no
  audit trail; strict TS, no `enum`; no floating promises.
- After adding or removing Tailwind classes: `node tools/generate_tailwind_css.mjs`.
  Never a class name composed at runtime.
- After every step: `npm run typecheck && npm run lint && npm run build`
  (and `npm run format:check`). The repository has no test suite: verify by
  hand (section 7) and describe what you tried in the commit body.
- One commit per step, French message, subject `Chat : …`, body in bullets.

---

## Step 0 — Baseline measurement (no code change)

1. Build and run the app (see AGENTS.md, "Manual launch").
2. Chrome DevTools > Performance, CPU 4x slowdown, record while a long answer
   streams (ask for ~3,000 words with a code block, a table and a list; also
   one turn with several tool calls).
3. Write down: dropped frames, long tasks (> 50 ms), total time in
   Recalculate Style / Layout / Paint, and the "token received → visible"
   delay (log `performance.now()` in the NDJSON reader and in the
   `onUpdated` of `ContenuMarkdown.vue`, temporary, not committed).
4. Keep the profiles; compare after each step.

---

## Step 1 — One render beat per frame (main gain)

Files: `features/chat/coeur/rendu-flux.ts`, `features/chat/coeur/vue-flux.ts`,
`features/chat/coeur/etat.ts`, plus the stop paths listed above.

1. Replace the body `setTimeout` loop (`armStreamFlush` / `streamFlushTick` /
   `streamFlushDelay`) by a single `requestAnimationFrame` loop
   (`battement`), armed when there is pending work and stopped when every
   buffer is empty and nothing is dirty. When the tab is hidden, rAF pauses:
   on `visibilitychange` back to visible, flush everything at once.
2. In that same frame, in this order: thinking buffer (`flushThinkBuf`),
   tool narration (`flushPreContentBuf`), body (`streamBuf`), shell output
   (`flushShellPend`), then **one** scroll write (step 2). Remove the
   `setInterval` of `vue-flux.ts:73` and `:115` and the `SHELL_FLUSH_MS`
   timeout; keep the shell output capped (`SHELL_MAX`) and coalesced, but it
   may stay at a lower cadence (every 4th frame) because it can be large.
3. Active block: remove the fixed `RENDU_ACTIF_MS`. Re-render it in every
   frame where its text changed. Adaptive budget: measure the render time; if
   it exceeds ~6 ms, skip the next frame(s) proportionally (keep the
   `liveRenderDirty` / `catchUpRender` mechanism for the catch-up).
4. Smoothing: `FENETRE_LISSAGE_MS` → ~80–100 ms, `LISSAGE_MIN` → 2–4 chars,
   `dt` taken from the rAF timestamp. Keep the UTF-16 surrogate guard of
   `smoothTake`. Do not cut inside a Markdown token if cheap to avoid (e.g.
   prefer stopping after a space when one is within the next few chars).
5. Very long texts: keep a guard equivalent to `streamFlushDelay` but on the
   **active block** length (what is actually re-parsed), not on the whole
   message: finished blocks are not re-rendered anyway.
6. End of stream / Stop: everything left in the buffers is flushed
   synchronously (existing `force` paths), then the loop stops.

Acceptance: token → visible ≤ 50 ms on a normal answer; one Vue update of
the streaming message per frame at most; no regression on Stop, on errors,
on regenerate, on tool-heavy turns, on thinking models.

Commit: `Chat : rendu du flux sur requestAnimationFrame`.

---

## Step 2 — Clean stick-to-bottom scrolling

Files: `components/chat/page/FilConversation.vue`,
`features/chat/coeur/rendu-flux.ts`, `app/racine/defilement.ts`,
`features/chat/liste/defilement-virtuel.ts`.

1. Remove `scroll-smooth` from the container (`FilConversation.vue:23`).
   Smooth scrolling is applied only for deliberate jumps
   (`scrollToMessage`, the "go down" button `BoutonBas.vue`, search results):
   pass `behavior: "smooth"` explicitly there (or `"auto"` if
   `mouvementReduit()`), and drop the `scrollBehavior` save/restore hacks
   that only existed because of the class (`rendu-flux.ts:110-116, 129-133`,
   `defilement.ts:64-70`).
2. A single owner for stick-to-bottom during the stream: the render beat of
   step 1 writes `scrollTop = scrollHeight` once, at the end of the frame,
   after Vue has patched (do the write in the beat after `await nextTick()`,
   or schedule the Vue flush with `flush: "sync"` semantics — choose one and
   document it in one line). The `ResizeObserver` of `defilement.ts` stays
   for the non-stream cases (images loading, panels opening) but does
   nothing while a stream beat is active.
3. Virtual list: while streaming, `mesurer()` measures only the streaming
   message (its index is known: `streamIdx`), not every `[data-vs-idx]`;
   other heights do not change. Do not call `recalculer()` from scroll events
   caused by our own scroll writes (the `_lockAutoScroll` lock already
   exists: reuse it).
4. Never read a layout property (`offsetHeight`, `scrollHeight`,
   `getBoundingClientRect`) after a DOM write in the same frame except the
   final `scrollHeight` of point 2. Group reads first, writes last.
5. Optional: `overflow-anchor: none` on the thread while stuck to the
   bottom, `auto` otherwise, so that an image above does not shift the view
   when the user has scrolled up.

Acceptance: in the Performance profile, no purple "Layout" forced by
script inside the stream frames (except one per frame at most); scrolling up
during a stream stops the follow immediately and nothing pulls back;
"go down" button scrolls smoothly (or instantly with reduced motion).

Commit: `Chat : défilement du flux sans lissage concurrent`.

---

## Step 3 — Less Vue and DOM work per frame

Do steps 1–2 first and re-measure; do this step if frames still exceed
~10 ms on long answers.

1. **Streaming state outside the message object.** Today every flush
   replaces the whole message (H). Move the fast-changing display fields
   (`content` during the stream, `_mdBlocks`, `_mdActiveHtml`, `_pp*`,
   `thinking` during the stream) into a small dedicated reactive object
   (e.g. a `shallowRef` per streaming turn, provided through the chat domain
   injection, see `features/chat/page/domaines.ts`). `ContenuMarkdown.vue`
   and the thinking / narration components read it while `isStreaming`;
   at the end of the stream, write the final values into the message once.
   The message object is then replaced only on structural events (tool
   step added, status change), not on every token.
   Check every consumer of those fields (`grep -rn "_mdBlocks\|_mdActiveHtml\|_ppBlocks\|_pendingPreContent" frontend/src`).
2. **Targeted DOM update of the active block.** Replace
   `v-html="actif"` by a small function that keeps the top-level child nodes
   whose HTML did not change and replaces only from the first differing
   child (parse the new HTML in a `<template>` element; it is already
   sanitized by the Markdown engine). Usually only the last paragraph
   changes. No new dependency unless necessary (if one is added: permissive
   license, exact version, `THIRD_PARTY_NOTICES.md`).
3. **Caret in CSS.** Replace `injecterCaret` (regex on every render) by a
   CSS rule on the streaming container, e.g.
   `.markdown-body[aria-busy="true"] > :last-child::after` (adapt for lists,
   code blocks and tables; keep `injecterCaret` as fallback only where CSS
   cannot reach). The caret is then never recreated and its blink is
   continuous. Respect reduced motion (`style.css:4097`).
4. **Finished messages off-screen.** `content-visibility: auto` with
   `contain-intrinsic-size: auto 400px` on finished message bodies (not on
   the streaming one). Check it does not break the virtual list height
   measurement, search highlighting, or `scrollToMessage`.

Acceptance: during a long stream, scripting time per frame divided by ~2
compared with the end of step 2; a selection made in a finished block of
the streaming message survives the next tokens.

Commits: one per sub-point, e.g. `Chat : état du flux hors de l'objet message`.

---

## Step 4 — Smooth and cheap animations

Files: `frontend/css/style.css`, SFCs listed below, `DESIGN.md`.

1. **Text appearance.** Fade-in of newly frozen blocks: `opacity` 0 → 1 in
   ~120 ms, ease-out, only on blocks appended during the stream (not on the
   whole message, not per word). Disabled with reduced motion.
2. **Motion tokens.** Add CSS variables in `style.css` and document them in
   `DESIGN.md`: durations `--duree-courte: 120ms`, `--duree: 200ms`,
   `--duree-longue: 300ms`; one easing `--courbe: cubic-bezier(.2,.8,.2,1)`.
   Use them in the named transitions (`modal`, `popover`, `popover-up`,
   `toast`, `model-load`) and in the new ones.
3. **Only `transform` and `opacity`.**
   - Replace `transition-all` with explicit properties in the chat
     (`components/chat/page/PageChat.vue:65,77`, `BoutonBas.vue`,
     `NotificationsPied.vue`, `EpinglesComposeur.vue`, `PiecesJointes.vue`,
     `BarreLaterale.vue`, `ModaleOpenCode.vue`, `CapturesWeb.vue`) and then
     in the editor pages (`grep -rln transition-all frontend/src`).
   - The composer moving from the middle (`top-[44dvh]`) to the bottom
     (`bottom-6`) animates `top`/`bottom`: animate a `transform` instead
     (FLIP: measure, apply the final position, translate from the old one).
   - The chat column `max-width` change (`FilConversation.vue:24-28`,
     `PageChat.vue:77-80`) should not be transitioned at all, or via
     `transform: scaleX` on a wrapper; never a `width`/`max-width` transition.
   - `elpis-mcp-fil` (`style.css:4912-4914`): move the gradient onto a
     pseudo-element and animate `transform: translateX(…)`.
   - `mem-wave-sweep` (`style.css:457-462`, `background-clip: text`):
     keep only while visible and short, or replace with an opacity pulse.
   - `.elpis-img-tile__wash` (`style.css:4626-4633`): the blur filter on an
     animated layer is acceptable only if it is promoted
     (`will-change: transform`) and small; otherwise pre-blur with a radial
     gradient and no `filter`.
4. **Backdrop blur.** Remove `backdrop-blur-xl` from the composer card
   (`PageChat.vue:106`): use an opaque surface token (e.g. `bg-white` and its
   dark equivalent) plus a soft gradient mask above it so the text fades
   under the composer. Keep `backdrop-blur` only on modals and the mobile
   sidebar overlay, which do not sit on top of a scrolling, changing area.
   Check dark mode and every skin.
5. **Thinking / tool steps.** Opening and closing of the "reasoning" and
   tool-step panels: animate with `grid-template-rows: 0fr → 1fr` or a
   measured-height transform, not `max-height` with a large value.
6. Every new named transition: declared in CSS **and** in the
   `prefers-reduced-motion` block (AGENTS.md rule).

Acceptance: no "Paint" every frame while idle or while streaming plain text
(Rendering > Paint flashing); animations at 60 fps with CPU 4x slowdown.

Commits: `Chat : jetons de mouvement et transitions composées`,
`Chat : composeur sans flou d'arrière-plan`.

---

## Step 5 — Enrichment without hitches

Files: `features/chat/rendu/enrichissement.ts`, `features/chat/rendu/graphiques.ts`,
`components/chat/ContenuMarkdown.vue`.

1. When the stream ends, the full message is re-rendered and enriched
   (code highlighting, Mermaid, charts, SVG). Split that work: one block per
   `requestIdleCallback` slice (`timeout` ~200 ms), visible blocks first
   (`IntersectionObserver`), instead of all at once.
2. Make the switch from the streaming DOM to the final DOM invisible: same
   HTML structure, so no jump; if highlighting changes line heights, fix it in
   CSS (same font and line-height for plain and highlighted code).
3. Reserve the height of charts and diagrams before they render
   (placeholder with the expected aspect ratio) so they do not push the page.
4. Optional, only if profiles still show long tasks on very long answers:
   parse the Markdown of finished blocks in a Web Worker (sanitization must
   still happen with DOMPurify on the main thread, or in the worker with the
   same configuration: check `features/chat/rendu/purification.ts`).

Acceptance: no long task > 50 ms at the end of a long answer with code
and a Mermaid diagram.

Commit: `Chat : enrichissement découpé par tranches`.

---

## 7. Manual verification checklist (after each step)

- Long answer (> 50,000 chars), streamed: fluid, caret continuous, no jumps.
- Answer with a big code block, a table, a nested list, a Mermaid diagram, a
  chart, an image.
- Thinking model (reasoning panel) and a tool-heavy turn (narration, shell
  output, sub-agent).
- Scroll up during the stream: follow stops at once; "go down" button
  resumes it.
- Stop in the middle of a stream; regenerate; edit and resend; switch chat
  during a stream; background tab then back.
- RAG answer with `[n]` references (pastilles still placed and clickable).
- Message search highlighting; `scrollToMessage` from the history.
- Dark mode, every skin, mobile width (375 px), reduced motion enabled.
- Voice mode still speaks the streamed text.
- Chrome and Firefox (Firefox handles `content-visibility` and smooth
  scrolling differently).

Record before / after numbers from step 0 in each commit body.
