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

Three classes on `<body>`, set by `frontend/src/features/reglages/apparence.ts`:

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
bar). The setting is per user: `skin`, `skin_palette`, and the
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
entry in the registry `frontend/css/skins/skins.json` (served by `/api/skins`), the `<link>` in `index.html` and
`admin.html` after `style.css`. For its editor, a file
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

- Transitions of 150 to 260 ms; entrances in `ease-out`, sliding panels in
  `cubic-bezier(0.4, 0, 0.2, 1)` (`.elpis-slide-panel`, 260 ms).
- Animate `opacity` and `transform`; avoid layout properties
  (accepted exception: the width of sliding panels).
- A skin sets the duration and curve of menus and dialogs (`popover`, `modal`),
  never properties other than `opacity` and `transform`; a large decoration
  (light, gradient) has a fixed size and is placed with `transform`, so a resize
  does not repaint it.
- `prefers-reduced-motion: reduce` turns off non-essential animations
  (dedicated block in `style.css`); every new animation provides its
  alternative (fade or instant change).

## Iconography

Phosphor (vendored font, `ph ph-<name>`), monochrome, `aria-hidden="true"`
on the icon; the accessible name is carried by the button (`aria-label`) when
it has no text.

## Components

| Prefix | Where | Examples |
|---|---|---|
| `set-*` | settings (Settings, console) | `set-input`, `set-select`, `set-textarea`, `set-switch-track`, `set-row` |
| `adm-*` | admin console | `adm-card`, `adm-rows`/`adm-row`, `adm-btn` (+ `--primary`, `--quiet`, `--icon`, `--danger`, `--warn`), `adm-seg`, `adm-pill`, `adm-table`, `adm-details` (and `--rows` for "Advanced"), `adm-savebar`, `adm-drawer`, `adm-zone`, `adm-kpi`, `adm-palette` |
| `elpis-*` | chat, editor, banners | `elpis-editor-tab`, `elpis-code-diff`, `elpis-effect`, `elpis-banner-btn`, `elpis-slide-panel` |
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
  `node tools/generate_tailwind_css.mjs` (parity is checked by the
  maintainers' tests).
- Check every screen in light and dark, and on at least one dark-based
  theme (Emerald).
