# _TEMPLATE — how to write Elpis's system prompts

> Reference file (read-only through the admin API). Never injected into a chat: it documents
> the architecture and the method. Assembly happens in two layers.

---

## Two-layer architecture

**1. Base — `CHATBOT_SYSTEM.md` (ALWAYS present).**
Identity, method, principles, style. It must be true whether tools are active OR NOT.
**Golden rule: the base NEVER assumes a sandbox, tools "you have", or action.**
A session can be purely conversational (chat-only): in that case the base is the only
prompt. Any statement "you work in a sandbox / you edit files" would be false and
misleading there.

**2. Capability fragments — `FRAGMENT_*.md` (CONDITIONAL).**
Injected automatically, and only when the matching capability is active, by
`buildCapabilityBlock()` (`apps/core/src/prompts/systeme.ts`), from the turn's tool categories. Two tiers:

- **Action** — sandbox / agentic framing. `FRAGMENT_TOOLS` as soon as an action category is present,
  + a specialized fragment depending on the category. Also drives `<runtime_context>` (fs/shell/git).
- **Content** — "soft" capabilities (charts, memory, RAG). Injected INDEPENDENTLY (even without an
  action category) → they pull in NEITHER `FRAGMENT_TOOLS` NOR `<runtime_context>`, only their own guide.

| File | Tier | Injected when | Role |
|---|---|---|---|
| `FRAGMENT_TOOLS.md` | action | ≥1 **action** category (`fs/shell/git/desktop/browser`) | "you can act", sandbox, reversible/destructive stance |
| `FRAGMENT_CODE.md` | action | `fs` / `shell` / `git` | software engineering discipline |
| `FRAGMENT_AUTOMATION.md` | action | `desktop` | desktop automation |
| `FRAGMENT_WEB.md` | action | `browser` | web browsing |
| `FRAGMENT_CHART.md` | content | `chart` (one tool per type: `chart_bar`, `chart_heatmap`, `chart_gantt`… `chart_table`) | charts & tables rendered by the UI (ECharts) |
| `FRAGMENT_OFFICE.md` | content | `office` (`docx_create/read/edit`, `pptx_create/read/edit`, `xlsx_read`, `office_export`) | sandbox Word / PowerPoint / Excel files |
| `FRAGMENT_OFFICE_CHART.md` | content | `office` **and** `chart` | charts in Office files through `!id` |
| `FRAGMENT_MEMORY.md` | content | `memory` (`memory`/`session_search`) | long-term memory: what / where to save |
| `FRAGMENT_RAG.md` | content | `rag_*` tools (builtins → synthesized `rag` category) | document knowledge base |

The `<runtime_context>` (sandbox) blocks, `# Mémoire (instantané)`, the skills index and `AX memory`
are also conditional and injected by the backend — do not copy them into a prompt.

---

## Prompt skeleton (base or fragment)
```
# Identity / Title
{Who / what, concrete. For the base: tool-agnostic.}

# Method / Principles
{3–5 POSITIVE rules ("do X"), each with its implicit why.}

# Style
{Language, tone, structure, length depending on complexity.}

# Examples
{1–3 mini-examples <example>…</example>, varied and short.}
```

## Method reminders (Anthropic & OpenAI guides, adapted to a small local model)
- **Agnostic base**: no capability assumption in the always-present part (see golden rule).
- **Anchor in reality**: describe the product and the real capabilities, not generalities.
- **Positive framing**: say what to DO; if a prohibition is needed, explain why.
- **Do not duplicate**: tool parameters/capabilities are in their descriptions and in
  `<runtime_context>` — do not repeat them.
- **No over-specification or contradiction**: shorter = better followed, especially on a small model.
- **No imposed chain-of-thought**: give the goal and the success criterion, not a
  verbose "think step by step".

## Conventions of the "rich" pass (2026-07)
- **Worked examples**: each fragment carries 1–3 BEHAVIORAL `<example>` blocks — scenario
  in prose, parameters quoted inline (`action="replace"`, `target="[a1f4]"`) — NEVER the wire
  markup of a call (`<tool_call>`, call JSON): it would leak into the bubbles.
- **Unified error protocol**: tools fail with `error` (stable code) + `message` (FR)
  + `fix` (corrective action); fragments teach "apply the fix, never an identical
  retry, 2 failures on the same target → change strategy" and an explicit stop condition.
- **Test-bounded budgets**: `tests/llm_core/test_capability_fragments.py` locks a character
  ceiling per file (no drift allowed), the absence of wire markup and the absence of emoji.
