---
name: creer-un-skill
description: Create a new skill through a guided interview — ask grouped, numbered questions (trigger, exact steps, commands, pitfalls, files to bundle), then draft the skill (kebab-case name, keyword-rich description, markdown procedure), save it with skill_save and verify it with skill_get
tags: [skill, skills, creation, assistant, entretien, interview, procedure, scripts, documentation, capitalisation]
compatibility: skill_save/skill_add_file/skill_get tools (Skills category)
---

# Create a skill — guided interview

You turn the USER'S know-how into a reusable skill: short interview, then
draft, save, verify. These instructions are in English; **always talk to the
user in their language** (French by default), and **write the skill itself —
name, description, body — in the user's language too**: it is their content,
and their future requests will be matched against its words.

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

Example call (questions in French, like the conversation):

    ask_user(questions=[
      {"q": "Dans quelle situation ce skill doit-il servir ?",
       "options": ["Déploiement", "Diagnostic d'incident", "Maintenance planifiée"],
       "multi": true},
      {"q": "Montre la commande exacte que tu tapes pour lancer l'opération",
       "options": []},
      {"q": "Quels pré-requis (accès, variables d'env, outils) ?",
       "options": ["Aucun", "Token/credentials", "VPN"], "multi": true}
    ])

If the `ask_user` tool is unavailable, fall back to the SAME questions
grouped and numbered in plain text, e.g.:

    Pour cadrer le skill, réponds à ces trois points (numérote tes réponses) :
    1. Dans quelle situation ce skill doit-il servir ? (déploiement,
       diagnostic d'incident, maintenance planifiée, autre)
    2. Montre la commande exacte que tu tapes pour lancer l'opération.
    3. Quels pré-requis (accès, variables d'env, outils) ? (aucun,
       token/credentials, VPN, autre)

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
- `description`: ONE keyword-rich sentence in the user's language — it is
  what future requests will be matched against; use the exact verbs and
  nouns the user would type.
- Body: self-contained, concrete markdown in the user's language —
  `## Objectif` · `## Pré-requis` · `## Étapes` (exact commands) ·
  `## Vérification` · `## Pièges`.
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
   **Paramètres → Skills** (« Nouveau » button).

## 4. Verify and hand over

- Re-read with `skill_get(<slug>)`; fix and re-save if anything is off
  (wrong slug → save under the correct name, then tell the user to delete
  the bad one from Paramètres → Skills).
- Tell the user (in their language): the skill lives in **Paramètres →
  Skills** (personal scope), can be pinned in any chat via `/<slug>`, can be
  attached to a **Routine**, and an admin can promote it to the shared
  global library.
