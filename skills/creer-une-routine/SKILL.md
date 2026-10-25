---
name: creer-une-routine
description: Create a scheduled routine through a short guided interview — ask grouped questions (goal, frequency, tools, output and notifications), draft the routine (name, 5-field cron, self-contained task prompt, skills to attach), then save it PAUSED with routine_save for the user to review and switch on from Routines
tags: [routine, routines, cron, planification, schedule, automation, assistant, entretien, interview, notifications]
compatibility: routine_save and ask_user, general built-in tools of the chat (no category; routine_save can be switched off in Settings > Features)
---

# Create a routine — guided interview

You turn the USER'S recurring need into a scheduled routine: short interview,
draft, approval, save. These instructions are in English; **always talk to the
user in their language** (French by default), and **write the routine itself —
name and prompts — in the user's language too**.

The first user message normally carries an INITIAL BRIEF (goal, when, expected
result). Build on it — never re-ask what it already answers. Draft nothing
until the interview is complete.

## 1. Interview — `ask_user` questionnaire

Ask several questions AT ONCE with the `ask_user` tool (an interactive panel
opens above the prompt bar; the combined answers arrive as the NEXT user
message). Write questions and options in the user's language, then end your
turn with ONE short sentence inviting the user to answer — never repeat the
questions in text.

    ask_user(questions=[
      {"q": "Que doit faire la routine à chaque exécution ?", "options": []},
      {"q": "À quelle fréquence ?",
       "options": ["Tous les jours", "Chaque semaine", "Chaque mois", "Autre"]},
      {"q": "De quels outils a-t-elle besoin ?",
       "options": ["Navigateur / web", "Fichiers", "Aucun"], "multi": true},
      {"q": "Quelle sortie et quelles notifications ?",
       "options": ["Notifier à chaque exécution", "Seulement en cas d'erreur", "Jamais"]}
    ])

If `ask_user` is unavailable, ask the same questions numbered in plain text.

Rules:
- 3 to 5 questions per round, **2 rounds maximum**; the second round only for
  what the first answers left unclear (exact time, exact sources, format of the
  result). Then draft.
- Cover: goal · frequency and time of day · tools needed · expected output ·
  notifications.
- **Never invent a value** (URL, path, address): ask, or leave an explicit
  placeholder and say so.

## 2. Drafting

- `name`: short, readable (e.g. `Veille hebdo`).
- `cron_expr`: 5 fields `minute hour day-of-month month day-of-week`.
  **Day-of-week is 1-7 with Monday = 1** (Sunday = 7; 0 is NOT Sunday).
  Examples: `0 7 * * *` every day at 07:00 · `30 8 * * 1` every Monday at
  08:30 · `0 18 * * 1-5` weekdays at 18:00 · `0 9 1 * *` the 1st of each month
  at 09:00. Convert the user's wording to cron yourself and show it in plain
  words next to the expression.
- `task_prompt`: what the routine receives at each run. It MUST be
  **SELF-CONTAINED**: the run has no conversation, cannot call `ask_user` and
  cannot ask the user anything. State the goal, the exact sources, the steps,
  the output format and what to do when something is missing or fails.
- `skills`: names of existing skills worth attaching, chosen from the skills
  index you already have (12 at most). Attach only skills that exist.
- `tool_categories`: only the categories the task really needs; leave empty when none.
  Valid values: `browser`, `chart`, `desktop`, `fs`, `git`, `memory`, `office`,
  `shell`, `skill`. An unknown category is refused: the tool error lists the
  valid values.
- `notify_on`: `all`, `error` or `none`, from the user's answer.
- `system_prompt` and `thinking_mode`: only if the user asked for them.
- **Show the COMPLETE draft (name, schedule in words and cron, task prompt,
  skills, tools, notifications) and get explicit approval BEFORE saving.**
  After corrections, re-show only what changed.

## 3. Saving

Call `routine_save(name, task_prompt, cron_expr, ...)` only after explicit
approval. If it returns an error, read the message, fix the argument and retry
once; if it still fails, explain the problem to the user.

## 4. Hand over

Tell the user (in their language): the routine was created **paused** — nothing
runs yet; they review it and switch it on from the **Routines** page, where
they can also edit the schedule, run it once with "run now" and read its
history.
