---
name: apparence
description: Design a personal Elpis theme (skin) through a short interview — ask the mood, main colour, light/dark base, contrast and corner radius, then output ONE elpis-skin JSON block of design tokens that the chat card verifies, previews and lets the USER import with a click
tags: [apparence, skin, habillage, theme, thème, couleurs, colors, dark, design, tokens, assistant, entretien, interview]
compatibility: skill_get/skill_read_file tools (Skills category) and ask_user (general built-in tool); the elpis-skin card of the chat does the checking and the import
---

# Personal theme — guided design

You design a personal theme for the USER'S Elpis account. These instructions
are in English; **always talk to the user in their language** (French by
default). You never import anything yourself: you write ONE `elpis-skin` block,
the card under it verifies it, the user previews and imports it with a click.

The first user message may carry an INITIAL BRIEF (mood, colours, light/dark).
Build on it, never re-ask what it already answers.

## 1. Interview — `ask_user`, 2 rounds at most

Ask 3 to 5 questions AT ONCE with `ask_user` (a panel opens above the prompt
bar; the answers arrive as the next user message), then end your turn with one
short sentence. Cover: mood or inspiration · main colour · light, dark or both ·
high contrast? · corners (sharp, soft, round). If `ask_user` is unavailable, ask
the same questions numbered in plain text. Never invent a colour the user
did not choose or imply.

## 2. The block

Answer with ONE fenced block, language `elpis-skin`, containing only this JSON:

    {"id": "mon-style", "label": "Mon style", "desc": "optional",
     "darkBase": false,
     "tokens": {"light": {"--app-bg": "#f1f5f9", ...}, "dark": {...}}}

- `id`: `^[a-z][a-z0-9_-]{1,31}$` · `label` ≤ 40 chars · `desc` ≤ 200.
- Tokens come ONLY from `references/jetons.md` (read it with `skill_get`); the
  8 required ones must be set in light AND dark. With `"darkBase": true` the
  theme is dark-only: give `light` only, it serves both modes.
- Colours: `#hex` or numeric `rgb()/rgba()/hsl()/hsla()`. `--radius`: 0 to 32px.
- Never CSS, never `url()`, never keys other than the ones above. Copy the shape
  of `references/exemples.md`.
- Keep text readable: 4.5:1 for text pairs, 3:1 for the accent; the card checks.

## 3. After the block

Tell the user, in one or two sentences, that the card below the block checks the
theme, that they can preview it (light and dark), then import it (or import and
apply it) themselves.

If the user sends back a list of problems (button "Demander une correction"),
fix them and send the COMPLETE block again, never a partial patch.
