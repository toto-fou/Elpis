---
name: skill-name
description: One sentence describing the action — take care with the keywords (used for matching)
tags: [software, domain, keyword]
---

# Procedure title

<!--
A skill = one actionable procedure. Conventions:
  - REFERENCE FORMAT: a FOLDER `[<domain>/]<name>/SKILL.md` (name == folder),
    with its bundled resources (`scripts/`, `references/`, `assets/`) — see
    skills/README.md. This single-file template is still accepted (legacy).
  - description: dense in keywords (this is what triggers injection).
  - body: concrete steps, exact commands, real paths. Bundled scripts
    are referenced through the execution tool
    (`skill_run_script(name="<pkg>/<name>", script="scripts/x.sh", args=[…])`).
  - stay self-contained: do not assume the reader already knows the context.
  - target a SINGLE action; if the procedure branches, make a PACKAGE
    (overview SKILL.md + nested sub-skills, loaded via skill_get("pkg/child")).
This file (_TEMPLATE.md) is ignored by the loader.
-->

## Prerequisites
- …

## Steps
1. …
2. …

## Verification
- How to tell it succeeded.

## Pitfalls
- Frequent mistakes and how to avoid them.
