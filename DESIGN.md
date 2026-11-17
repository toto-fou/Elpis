# Design

Elpis's visual system: tokens, themes, typography, components and rules.
The intentions (audience, tone, principles) are in [PRODUCT.md](PRODUCT.md); this
document describes how the interface applies them, based on the code
(`frontend/css/style.css`, `frontend/css/skins/`, `frontend/src/features/reglages/apparence.ts`).

## At a glance

- **Vite build**: Vue 3 and TypeScript, components as SFCs compiled by Vite
  (`frontend/dist`); the stylesheets in `frontend/css/` are served as is.
- **Everything goes through tokens** (CSS variables) defined in `style.css`. A
  theme only redefines tokens; so does dark mode.
- **Precompiled Tailwind** (`frontend/css/style.tailwind.css`, generated); the
  common color utilities are **re-mapped to tokens**: writing
  `bg-white` or `text-slate-700` follows the theme and dark mode.
- **A single accent** (blue in the Slate theme); status colors only signal
  a state; monochrome icons.

## Tokens

Declared on `:root` (light mode), redefined under `body.elpis-app-dark` (dark
mode) and `body.elpis-dark-surface` (the light-on-dark semantic families),
then by each theme.

| Family | Tokens | Use |
|---|---|---|
| Background | `--app-bg` | page background |
| Surfaces | `--surface`, `--surface-2` … `--surface-5` | cards and panels, from lightest to densest |
| Borders | `--border`, `--border-soft`, `--table-cell-border` | outlines, separators |
| Text | `--text-900` … `--text-300`, `--text-max` | ramp from strongest to most discreet |
| Accent | `--accent`, `--accent-strong`, `--accent-500/400/300`, `--accent-fg`, `--accent-text(-strong)`, `--accent-surface(-2)`, `--accent-border`, `--accent-ring` | primary action, selection, focus |
| Success | `--ok*` | active state, success |
| Warning | `--warn*` | pending, to watch |
| Danger | `--danger-surface`, `--danger-border(-soft)`, `--danger-text`, `--danger-strong`, `--danger-icon-bg/fg` | error, destructive action |
| Admin role | `--role-admin-text/surface/border` | role badge only |
| Rail | `--rail-bg`, `--rail-bg-2`, `--rail-border`, `--rail-text(-strong)`, `--rail-muted`, `--rail-hover`, `--rail-active-bg`… | sidebars (chat and console), dark by default |
| Code | `--code-bg`, `--code-fg`, `--code-border`, `--code-header-bg/fg`, `--code-inline-*` | code blocks (dark in both modes) and inline code |
| Prose | `--prose-body`, `--prose-heading`, `--prose-strong`, `--prose-link(-hover)` | Markdown rendering of messages |
| Misc | `--toast-*`, `--hl-bg/fg`, `--scrollbar-*` | toasts (stable inverted surface), search highlight, scrollbars |
| Headings | `--font-titre` (no value on `:root`) | serif font for headings, set by the Elpis theme; read it with `var(--font-titre, inherit)` |
| Radii | `--radius` and `--radius-sm/md/lg/xl` (derived) | a theme changes `--radius`, the scale follows |

**Contrast.** The text ramp is recalibrated for AA: `--text-400`
(#64748b) and `--text-500` (#5b6a80) are darker than the native Tailwind
grays on a light surface (≥ 4.5:1). On the dark rail, use
`--rail-muted`, not the text ramp.

## Themes and dark mode

Three classes on `<body>`, set by `frontend/src/features/reglages/habillage.ts`:

| Class | Role |
|---|---|
| `elpis-skin-<id>` | the chosen theme (`frontend/css/skins/<id>/skin.css`, plus `editeur.css` for the editor) |
| `elpis-app-dark` | dark mode (a block of neutral tokens + the themes' dark variants) |
| `elpis-dark-surface` | marker "the base surface is dark": dark mode **or** a dark-based theme (`darkBase`, e.g. Emerald); all the light-on-dark re-mappings depend on it |

Theme and mode compose: `body.elpis-app-dark` (0,2,0) beats `:root`; a
theme (0,2,0, loaded after) beats `:root`; its dark variant (0,3,0) beats the
default dark.

A theme can set `--font-titre` (Elpis: Georgia); without it, the
questionnaire headings inherit the theme's font (Penguins keeps its own).

Bundled themes: **Slate** (no theme class), **Elpis** (default, palettes
**Gold** and **Clay**), **llama.cpp**, **Emerald** (dark base), **Penguins**,
**Kiki**, **Veilleuse** (dark first: a plum night, an amber lamp under the prompt
bar), **Terminal** (all monospace: ruled panels, selection in reverse video),
**Alizé** (a single sheet on a sea-air background, bundled fonts).
The setting is per user: `skin`, `skin_palette`, and the
System / Light / Dark mode (`dark_mode`, `dark_mode_auto`), in Settings;
the console's account menu offers the skins and the mode.

**Palettes.** Themes that differ only in their colors share a
structure: a palette is just a block of tokens under
`body.elpis-skin-<id>.elpis-palette-<palette>`, declared by the registry's
`palettes` field (empty id: the base tokens). The former Parchment skin became
Elpis's Clay palette; the registry's `alias` field maps accounts still on the
old identifier to it. A theme that has its own layout stays a theme.

**Personal skins.** An account can define its own skins
(`/api/skins/perso`), made of tokens only: no free-form CSS, no images.
The server accepts only an allowlist of `style.css` tokens (backgrounds,
surfaces, borders, text ramp, accent, rail, prose link, code,
`--radius`), requires the core in light and dark, derives the rest (accent
family, `--accent-fg` white or black by contrast, radius scale), rejects
any text under 4.5:1 and any interface element under 3:1, then generates the
stylesheet under `body.elpis-skin-perso` (+ `.elpis-app-dark`). Same specificity
as a bundled theme: the stylesheet loads after `style.css`.

**Settings subsections.** A loaded tab splits into a horizontal strip
of underlined tabs above the content (`sections` in `features/reglages/rail.ts`);
the last open section is remembered and the rail search leads to it.

Adding a theme: a file `frontend/css/skins/<id>/skin.css` that redefines the
tokens under `body.elpis-skin-<id>` (and `.elpis-app-dark` for dark), an
entry in the registry `frontend/css/skins/skins.json` (served by `/api/skins`), its `<link data-habillage="<id>">`
(and that of its `polices.css`, with a preload of its text font) in the inert `<template id="elpis-habillages">`
of `index.html` and `admin.html`, after `style.css`. Only the active theme's sheets are loaded: before the
first paint for the last appearance remembered by the browser (the `@habillage` script), on demand and before
the class switch otherwise. For its editor, a file
`frontend/css/skins/<id>/editeur.css`: no `<link>`, the frontend links it
on demand. Fonts stay local (no download: the application must
work offline).

**Skin-linked editor.** A skin is a folder: `skin.css` for the application, and
`editeur.css`, optional, for the editor. Its presence is enough: without it, the editor
stays classic, as with a personal skin (tokens only). The account chooses
*Follow skin* (default) or *Classic*. The base `frontend/css/editeur.css` re-maps
the classic components to `--ed-*` tokens; `editeur.css` sets them, under
`.ed2--encre` and `.ed2--papier` (the editor's "Dark theme"):

| Tokens | Role |
|---|---|
| `--ed-code-bg`, `--ed-code-fg`, `--ed-code-muted`, `--ed-code-accent` | code surface, read by the Monaco theme: plain colors |
| `--ed-plan`, `--ed-bande`, `--ed-releve`, `--ed-champ` | the planes: column and code, inset bands, menus, fields |
| `--ed-ink`, `--ed-ink-2`, `--ed-muted`, `--ed-line`, `--ed-line-soft`, `--ed-hover`, `--ed-press` | inks, rules and states |
| `--ed-select`, `--ed-select-ink`, `--ed-accent`, `--ed-accent-fg`, `--ed-ring` | selection and accent |
| `--ed-ok`, `--ed-warn`, `--ed-danger` | Git statuses, and the terminal's red, green, yellow |
| `--ed-syn-mot`, `-texte`, `-nombre`, `-com`, `-type`, `-var`, `-op` | syntax highlighting; `-op` also colors the braces |
| `--ed-ansi-rouge`, `-vert`, `-jaune`, `-bleu`, `-magenta`, `-cyan` | terminal, optional |
| `--ed-ic-dossier`, `-fichier`, `-bleu`, `-jaune`, `-orange`, `-vert` | tree icons, optional (monochrome otherwise) |
| `--ed-police`, `--ed-arbre-police`, `--ed-arbre-taille`, `--ed-arbre-hauteur`, `--ed-r`, `--ed-r-lg` | fonts, tree density, radii |

An `editeur.css` changes the appearance (colors, radii, fonts, active tab
shape, active row marker), never the position of elements or their
behavior. The contrast of the bundled skins is tested
(`frontend/test/css/contraste-editeur.test.ts`): text 4.5:1, icons 3:1.

## Typography

- Text: system stack (`-apple-system, BlinkMacSystemFont, "Segoe UI",
  Roboto, Helvetica, Arial, sans-serif`).
- Code: `"JetBrains Mono"` then system monospace fonts.
- A theme can give serif headings (Georgia, available everywhere); no
  font is downloaded.
- Hierarchy by **size and weight**, not by lighter grays or spaced-out
  small caps; table headers in normal case.

## Layers (z-index)

De facto scale, to follow so a new layer finds its place:

| Value | Layer |
|---|---|
| 40–100 | dropdown menus, floating page panels |
| 5000 | large modals (Settings, Git clone) |
| 6000 | modals above a modal (transcripts, templates, skills) |
| 7000 | generic confirmation (confirm, type, choose) |
| 7500 | group modals |
| 8000 | context menu |
| 9000+ | toasts and system alerts |

## Motion

- Durations and curves are tokens in `:root` of `style.css`, never literals in
  a named transition: `--duree-courte` (150 ms: menu exits, tool detail),
  `--duree` (200 ms: menu entries, dialogs, toasts, fades), `--duree-longue`
  (260 ms: sliding panels), `--duree-image` (16 ms, one frame: head start of
  menus); `--courbe-fondu` (`ease-out`: opacity and small offsets),
  `--courbe-entree` (menu entries, dialogs, toasts, the save bar),
  `--courbe-volet` (sliding panels).
- Animate `opacity` and `transform`, never layout properties, with one
  exception: the width of a sliding panel, and the maximum width of the blocks
  that follow it.
- Sliding panels (`.elpis-slide-panel`: history rail, console rail, MCP,
  Generation, editor) glide to their width (`--duree-longue` to open, `--duree`
  to close), and the chat column and the composer follow frame by frame: a
  width set at once reads as a jump. This is affordable because the thread is
  virtualized (measured on a long thread, CPU slowed 4 times: one or two frames
  over 25 ms per gesture, none over 50). The panel's content keeps its final
  width, clipped by the panel, so it is not laid out again while the panel
  moves; it enters with the named transition `volet` (opacity on the transition
  root, `transform` on its children; rails from the left, right panels from the
  right) and leaves the same way. The rails get their width from a CSS
  transition; a panel that is itself the transition root is driven by
  `features/communs/volet.ts`, which also hands the focus over. A panel wider
  than 550 px glides proportionally longer, up to 1.5 times (the editor on a
  wide screen: 390 ms to open, 300 ms to close): at equal duration it would move
  three to four times faster than the others. `volet.ts` writes that duration
  to `--volet-duree` on the panel, so its content's transition lasts as long.
  A block whose maximum width changes with a panel (the thread column and the
  composer when the editor opens) registers with `accompagnerVolets`: its
  maximum width glides from its width before to the rule after, on the panel's
  duration and curve, instead of changing at once and reversing the block's
  direction for one frame; a rule in percent keeps following its container, so
  another panel moving at the same time causes no jump at the end. The panel's
  content is held at its final width by the transition classes
  (`.elpis-slide-panel:is(.volet-enter-active, .volet-leave-active)`), and a
  panel's exit ends with its width animation, not with its fade. The editor
  closed from full screen retracts from the whole width, out of the flow
  (`data-volet-couvrant`), above a chat already laid out at its final width.
- Menus and small floating surfaces open and close through `<TransitionMenu>`
  (`popover` down from the anchor's top edge, `popover-up` up from its bottom
  edge, corner with `.menu-ancre-gauche` / `.menu-ancre-droite`): opacity, a
  6 px slide (`--menu-glisse`) and a 0.97 scale (`--menu-echelle`), in over
  `--duree` with `--courbe-entree`, out over `--duree-courte`. Both start one
  frame ahead (`--duree-image`; entry from `@starting-style`, never
  `-enter-from`) so the first frame after the gesture already moves; the leaving
  menu is `inert`, drops its focus and lets clicks through. A browser without
  `@starting-style` shows the menu at once and still animates its exit.
- A skin sets the duration, curve, slide and scale of menus and dialogs
  (`popover`, `modal`) by overriding these variables on the transition classes
  (Terminal: shorter, linear, no scale), never properties other than `opacity`
  and `transform`; a large decoration
  (light, gradient) has a fixed size and is placed with `transform`, so a resize
  does not repaint it.
- `prefers-reduced-motion: reduce` removes movement, not fades (dedicated
  block in `style.css`). Kept: opacity and color transitions (150 ms at most)
  and the opacity pulse of activity indicators (the spinner turns slower).
  Dropped: anything that moves, scales, resizes or rotates. A named Vue
  transition becomes an opacity fade in place, `min(its token, 150 ms)` long (its
  offsets are declared under `@media (prefers-reduced-motion: no-preference)`); a sliding
  panel takes its width at once and its content fades in place. Every new animation or named transition gets its entry in
  that block.
- The account chooses its animations (Settings › Appearance › Animations,
  `ui_motion`): follow the workstation (default), full, or reduced. Style sheets
  only ever read `prefers-reduced-motion`; when the choice contradicts the
  workstation, `platform/mouvement.ts` inverts that media feature in every
  loaded sheet (skins included) and restores it otherwise, so a sheet needs
  nothing more than the two media blocks above. Code never reads the media
  query itself: it calls `mouvementReduit()`. The code editor follows it too:
  smooth scrolling, the animated caret and the sliding search panel are off
  when motion is reduced; it reads the choice from the settings it receives,
  when its options are applied (`features/editor/instances.ts`). Limits: a
  motion rule added with `insertRule`, or a `<style>` outside `<head>`, is not
  seen (none exists); a workstation change during a session reaches the code
  editor at its next preference change.
- Drags (editor splitters): one position per frame (`parImage`); the layout
  follows through size observers, and the shell only receives the final size.

## Iconography

Phosphor (vendored font, `ph ph-<name>`), monochrome, `aria-hidden="true"`
on the icon; the accessible name is carried by the button (`aria-label`) when
it has no text.

## Components

| Prefix | Where | Examples |
|---|---|---|
| `set-*` | settings (Settings, console) | `set-input`, `set-select`, `set-textarea`, `set-switch-track`, `set-row` |
| `adm-*` | admin console | `adm-card`, `adm-rows`/`adm-row`, `adm-btn` (+ `--primary`, `--quiet`, `--icon`, `--danger`, `--warn`), `adm-seg`, `adm-pill`, `adm-table`, `adm-details` (and `--rows` for "Advanced"), `adm-savebar`, `adm-drawer`, `adm-zone`, `adm-kpi`, `adm-palette` |
| `elpis-*` | chat, editor, banners | `elpis-editor-tab`, `elpis-effect`, `elpis-banner-btn`, `elpis-slide-panel` |
| `markdown`, `code-*`, `diff-*` | message rendering | prose, code blocks, diffs |
| `toast`, `modal`, `popover` | layers | notifications, dialogs, menus |

Composition rules:

- **No card in a card**: one section = one surface; the objects of a list
  are rows, a complex object opens in a drawer or an inline editor.
- **Setting row**: short label on the left (detail in `title`), control
  sized to the data on the right, unit as a suffix.
- **Buttons**: one family; a single primary (accent) button per screen;
  destructive actions in the danger variant, confirmed.
- **Sensitive actions** at the end of the page, in a "Danger zone"
  (`adm-zone`); the irreversible ones require retyping a word
  (`openTypedConfirm`).
- **Rare settings** folded under "Advanced" (`adm-details--rows`); an object
  (connector…) is edited in a drawer (`adm-drawer`) with its own
  Save.
- **Status color only on anomaly**: "0 errors" stays neutral.

## Rules

- Never a hard-coded color in a component: a token, or a Tailwind utility
  re-mapped to a token.
- Never a color class on `<body>`: the background and text come from
  the `body` rule in `style.css`.
- After adding utility classes in a template:
  `node tools/generate_tailwind_css.mts` (parity is checked by the
  maintainers' tests).
- Check every screen in light and dark, and on at least one dark-based
  theme (Emerald).
