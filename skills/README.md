# Skills — Procedural memory

This folder holds the **skills**: markdown procedures describing *how* to
carry out a concrete action on a software solution (deploy with Ansible,
reset Qdrant, build the MCP server, …).

It is the agent's third memory, complementary to the other two:

| Memory | Where | What |
|---|---|---|
| Factual / long-term | `apps/core/src/memoire/` (self-curated Markdown + FTS5) | facts, user profile |
| Working | `apps/core/src/outils/todo/` (todos) | steps of the current task |
| **Procedural (skills)** | **here** | **how to do X** |

Inspired by the Agent Skills pattern (Claude), applied to *procedures*.

## Organization: one skill = one folder (Agent Skill model)

The reference format is the **skill folder**: `[<domain>/]<name>/SKILL.md`
(+ bundled resources `scripts/`, `references/`, `assets/`). A skill folder
can contain nested **sub-skills** (package): their id becomes
`parent/child` and only level-0 skills appear in the injected index —
sub-skill bodies are loaded on demand via `skill_get("parent/child")`.

```
skills/
  README.md                ← this file
  _TEMPLATE.md             ← template (ignored by the loader)
  creer-un-skill/          ← skill-creation assistant (shipped)
    SKILL.md
  creer-une-routine/       ← routine-creation assistant (shipped)
    SKILL.md
  creer-un-agent/          ← personal-agent creation assistant (shipped)
    SKILL.md
  apparence/               ← personal theming assistant (shipped)
    SKILL.md               ← ask_user interview, ONE ```elpis-skin block of tokens
    references/            ← jetons.md (list, required, contrasts), exemples.md (2 valid themes)
    assets/apercu.html     ← script-free HTML/CSS mockup, rendered by the chat card to validate the theme
  learned/                 ← admin curation AIRLOCK (drafts)
  <package>/               ← example of a PACKAGE (skill folder, id "<package>")
    SKILL.md               ← domain overview + orientation table
    <sub-skill>/           ← sub-skill (id "<package>/<sub-skill>")
      SKILL.md
      scripts/run.sh       ← executable script, staged in the sandbox
      references/exemple.yml
```

The single-file **legacy** `[<domain>/]<name>.md` is still read
(backward compatibility), but every NEW creation (UI, API, `skill_save` tool)
writes the folder format. An edited legacy skill stays legacy (no silent migration).

A skill's `domain` = its first subfolder (`skills/<domain>/…`),
overridable by the `domain:` frontmatter. Case of a package placed at the root
of a domain (e.g. `skills/ansible/SKILL.md`): the path does NOT give a
domain (the skill's folder is itself at the first level) → set
`domain: ansible` explicitly in its frontmatter to keep the index
grouping.

## How it works (routing = deterministic injection)

All bodies are **never** injected into the context. On each request:

1. `discoverSkills()` (`packages/skills/src/decouverte.ts`) recursively scans the sources and
   merges them. Injection passes `include_learned=False`: `learned/` is an admin
   airlock, never injected.
2. `buildSkillsIndexBlock()` (`apps/core/src/prompts/systeme.ts`) injects a **light
   index** of level-0 skills (user+global), **grouped by domain**
   (`name — description`), bounded by `SKILLS_INDEX_MAX`, with markers:
   `· sub-skills` (package) and `· files/scripts` (bundle).
3. The model loads a body on demand via the **`skill_get(name)`** tool
   (qualified id `parent/child` for a sub-skill). **Pinned** skills
   (`/skill` in the chat, by name) are injected in full.

A skill's bundled files (global or personal) are **not mounted** in the
sandbox: the agent reads them via **`skill_read_file(name, path)`** and runs the
scripts via **`skill_run_script(name, script, args, env)`**. At run time, the
bundle is staged in an ephemeral directory outside `/work` (`$SKILL_DIR`) and the
script runs **from `/work`**: `args` paths are relative to the working folder
and outputs land there. Script code does not enter the context.

## Sources (merged, decreasing priority)

```
user    ← <user_sandbox>/skills/          (personal; written by the agent via skill_save)
learned ← skills/learned/                 (admin curation airlock — NOT injected before promotion)
global  ← skills/                         (curated, versioned — this folder, except learned/)
```

On a `name` collision, the most specific wins (`user` > `learned` > `global`).
`learned` is merged only for management (UI/API) — **never** into the prompt.
`learned` is a reserved name (refused as the name/domain of a global skill).

## SKILL.md format

```markdown
---
name: ansible-write-playbook    # == folder name (spec rule)
description: Write an idempotent Ansible playbook
tags: [ansible, playbook, idempotence]
# domain: …                     # optional: overrides the domain derived from the path
# license / compatibility / allowed-tools / metadata: …   # optional (spec)
---

# Write an idempotent Ansible playbook

## Prerequisites
…

## Steps
1. …
```

| Field | Role |
|---|---|
| `name` | **Globally unique** identifier (== folder name for a skill folder). |
| `description` | One sentence: used for matching AND for the index. **Take care with the keywords.** |
| `tags` | Additional keywords for matching (list). |
| `domain` | (optional) Overrides the domain derived from the path. |

The **markdown body** is the procedure itself. No emoji. If the skill
bundles scripts, the body references them through the execution tool
(`skill_run_script(name="<pkg>/<name>", script="scripts/x.sh", args=[…])`).

## Adding / editing a skill

1. Create `skills/[<domain>/]<my-skill>/SKILL.md` (or use the Skills UI: creation,
   `.zip` import of a package, editing — the CRUD is folder-aware).
2. No restart: `discover_skills` re-reads the disk on every request (hot reload).

Editing via the UI/API updates the `SKILL.md` **in place** (frontmatter not
managed by the form is preserved, the folder is never moved — a domain change
sets the frontmatter override). Deleting a package deletes its
sub-skills and its bundle.

## Personal skills (`skill_save`) and the admin airlock (`learned/`)

- **Agent → personal.** The agent saves a new procedure with the
  `skill_save(…, domain="ansible")` tool. The skill lands in **its sandbox**
  (`<user_sandbox>/skills/[<domain>/]<slug>/SKILL.md`, source `user`):
  routable for ITS next sessions only, never injected for another
  user (isolation — audit CRIT-1).
- **Admin → learned → global.** An admin can drop a draft in the
  `learned/` airlock (Skills UI, scope *learned*), then **promote** it to the curated
  library: `POST /api/skills/promote {"name": "<slug>"}` — the
  move preserves the domain subfolder and also works for a complete
  skill folder (bundle + sub-skills). Until promoted, a
  `learned` skill is NOT injected into the prompt.

## Configuration

Variables (env / `config.json` › `skills.*`):

| Key | Default | Role |
|---|---|---|
| `APP_SKILLS_DIR` / `skills.dir` | `skills` | Global folder. |
| `APP_SKILLS_TOP_N` / `skills.top_n` | `3` | Number of bodies injected (pins). |
| `APP_SKILLS_MIN_SCORE` / `skills.min_score` | `1.0` | Minimum lexical score. |
| `APP_SKILLS_CHAR_BUDGET` / `skills.char_budget` | `12000` | Character budget for bodies. |
| `APP_SKILLS_INDEX_MAX` / `skills.index_max` | `100` | Max entries in the index (0 = unlimited). |
