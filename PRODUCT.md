# Product

Elpis product sheet: who it is for, what it promises, and the rules that
follow for the interface. Every screen decision (human contributor or
coding agent) refers to it; the visual system that applies it is described in
[DESIGN.md](DESIGN.md).

## Register

product

## Platform

web — desktop application in the browser (desktop first; a narrow window
next to a chat must stay usable, no mobile target).

## Users

Technical teams that host their own LLM assistant: developers,
operators, power users, and the instance administrator.

- They talk with an **agentic chat** that calls tools (files,
  shell, Git, browser, charts, memory), delegates to subagents and
  consults their documents (RAG).
- They edit code in the **built-in editor**, on a personal Docker
  sandbox with a terminal.
- They schedule **routines** and plug in their own MCP servers.
- The administrator configures the instance from the **admin console**:
  inference engines, accounts, sandbox, backups, monitoring.

Mindset: focused, task-oriented, often watching a long generation or a
running command. Working language: French for the interface,
English for the documentation.

## Product Purpose

A **fully self-hosted** LLM assistant: everything runs on the team's server,
with `llama-server` (llama.cpp) or any OpenAI-compatible engine, with no
dependency on a third-party service.

Success is measured by two things:

- the user understands the state of their work at a glance (model, context
  used, tools in progress, changed files) and moves forward without friction;
- the administrator sees on arrival what needs attention, configures a
  feature on a single screen and never loses a change.

## Brand Personality

Precise, calm, reliable. "The tool fades behind the task." An expert's
confidence, without showmanship.

Three words: **precise, calm, legible**.

## Voice & Tone

- **One language** throughout the interface, in the formal register
  (the French interface uses the formal "vous").
- **Short labels**: one or two words. No help paragraph on screen:
  the detail goes in the tooltip (`title`), the field's placeholder text or the
  documentation.
- **No emoji** in the interface. Only the signs ✓ ✗ ⚠ are tolerated.
- Consistent vocabulary: "Save" for settings, "Backup" for
  archives; "RAG" stays "RAG"; statuses in plain words ("Running",
  "Stopped"), never an internal code (`status=error`) on screen.
- Actionable error messages: what happened, then what to do.

## Anti-references

- Overloaded "AI admin" panels: spaced-out small caps above every
  section, nested cards, navigation fragmented into screens with redundant
  headers.
- Light-gray micro-typography on white (borderline contrast).
- Gamified or multicolor dashboards; decorative color.
- Flowise-style node-graph complexity.

## Design Principles

1. **A single workspace.** One coherent surface: no context jumps,
   no repeated header.
2. **Legibility before density.** Every label is earned; hierarchy comes from
   size and weight, not from lighter grays or small caps.
3. **Content is the hero.** The conversation and its live activity
   (state, tokens, tools in progress) are the content, not the decoration.
4. **Earned familiarity.** Standard product affordances; the tool
   disappears into the task.
5. **One accent, semantic color only.** Blue = action or selection;
   status colors signal an abnormal state; nothing decorative.
6. **Nothing is lost silently.** A modified screen is not left without an
   explicit choice; the irreversible requires a named (or typed)
   confirmation; whatever will only take effect on restart is announced.

## Accessibility & Inclusion

- WCAG 2.1 AA: body text ≥ 4.5:1, placeholder texts included; the token gray
  ramp is calibrated for it.
- Full keyboard navigation; visible focus; modals trap the
  Tab key and return focus on close; Esc closes the topmost
  layer.
- `prefers-reduced-motion` respected: every animation has its alternative.
- Live regions (activity, status) announced (`aria-live`); selection and
  current page exposed (`aria-selected`, `aria-current`); charts paired
  with a text summary.
