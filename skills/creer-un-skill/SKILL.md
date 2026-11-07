---
name: creer-un-skill
description: Create a new skill through a guided interview — ask grouped, numbered questions (trigger, exact steps, commands, pitfalls, files to bundle), then draft the skill (kebab-case name, keyword-rich description, markdown procedure), save it with skill_save and verify it with skill_get
tags: [skill, skills, creation, assistant, entretien, interview, procedure, scripts, documentation, capitalisation]
compatibility: skill_save/skill_add_file/skill_get tools (Skills category); ask_user is a general built-in tool
---

# Create a skill — guided interview

You turn the USER'S know-how into a reusable skill: short interview, then
draft, save, verify. These instructions are in English; **always talk to the
user in their language** (French by default). The skill itself is read by
models, so **write its description and body in English**, whatever the user's
language; keep the user's material verbatim (commands, paths, values, error
messages, UI labels). UI labels below are in English, followed by the French
label in « »: name the one of the user's interface.

The first user message normally carries an INITIAL BRIEF (subject, goal,
domain, scripts yes/no). Build on it — never re-ask what it already answers.
Draft nothing until step 1 is complete.

## 1. Interview — `ask_user` questionnaire (preferred)

**Ask several questions AT ONCE with the `ask_user` tool**: an interactive
panel opens above the user's prompt bar (one question at a time, clickable
options + free-text field) and their combined answers arrive as the NEXT
user message. Write the questions and options in the user's language, then
end your turn with ONE short sentence inviting the user to answer below —
never repeat the questions in text.

Example call (in English here; write the questions and options in the user's
language):

    ask_user(questions=[
      {"q": "In which situation should this skill be used?",
       "options": ["Deployment", "Incident diagnosis", "Scheduled maintenance"],
       "multi": true},
      {"q": "Show the exact command you type to start the operation",
       "options": []},
      {"q": "Which prerequisites (access, env variables, tools)?",
       "options": ["None", "Token/credentials", "VPN"], "multi": true}
    ])

If the `ask_user` tool is unavailable, fall back to the SAME questions
grouped and numbered in plain text, in the user's language, e.g.:

    To scope the skill, answer these three points (number your answers):
    1. In which situation should this skill be used? (deployment,
       incident diagnosis, scheduled maintenance, other)
    2. Show the exact command you type to start the operation.
    3. Which prerequisites (access, env variables, tools)? (none,
       token/credentials, VPN, other)

Rules:
- 3 to 6 questions per round, **ONE round of questions per turn**; number
  them so the user can answer point by point.
- **2 rounds maximum**: round 1 = the core (trigger, expected outcome, exact
  steps, prerequisites); round 2 = ADVANCED follow-ups derived from the
  answers (pitfalls, error cases, exact values, files/scripts to bundle).
  Then move on to drafting — at most one micro-question for a last detail.
- Demand CONCRETE material: real copy-pasted commands, real paths, URLs,
  exact values — never vague descriptions. **Never invent a command or a
  value**: if the user cannot provide one, put an explicit placeholder in the
  draft (e.g. `<HOST>`) and say so.

Coverage checklist across the whole interview (skip whatever the brief
already answers): trigger · expected outcome · exact steps · prerequisites ·
pitfalls & checks · files/scripts to bundle · domain.

## 2. Drafting (propose, get approval)

- `name`: short kebab-case slug (lowercase, digits, hyphens — e.g.
  `reset-qdrant`).
- `description`: ONE keyword-rich sentence in English — the model picks
  skills from it; name the task with precise verbs and nouns.
- `tags`: a few keywords in English AND in the user's language: the skill
  search of the interface matches them.
- Body: self-contained, concrete markdown in English —
  `## Goal` · `## Prerequisites` · `## Steps` (exact commands) ·
  `## Verification` · `## Pitfalls`.
- **Show the COMPLETE draft and get explicit approval BEFORE saving.** After
  corrections, re-show only what changed.

## 3. Saving

1. `skill_save(name, description, body, tags, domain)` — the skill is
   written to the user's protected personal store (the copy visible in the
   sandbox under `skills/<slug>/` is only a disposable working mirror).
2. Bundled files: AFTER skill_save, add each file with
   `skill_add_file(name=<slug>, path="scripts/<file>", content=…)`.
   ⚠ NEVER use `write_file` for this: the sandbox copy is regenerated from
   the store — anything written there directly is lost. In the body,
   reference bundled files by RELATIVE path (`scripts/<file>`): at use time,
   `skill_get` tells where to read/run them.
3. If the `skill_save` tool is unavailable: output the full SKILL.md
   (frontmatter + body) in a code block, for the user to paste into
   **Settings → Skills** (« Paramètres → Skills »), "New" button (« Nouveau »).

## 4. Verify and hand over

- Re-read with `skill_get(<slug>)`; fix and re-save if anything is off
  (wrong slug → save under the correct name, then tell the user to delete
  the bad one from Settings → Skills).
- Tell the user (in their language): the skill lives in **Settings →
  Skills** (« Paramètres → Skills », personal scope), can be pinned in any
  chat via `/<slug>`, can be attached to a **Routine**, and an admin can
  promote it to the shared global library.
