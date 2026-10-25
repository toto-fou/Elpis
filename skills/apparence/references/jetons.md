# Design tokens (personal themes)

Only these 35 tokens are accepted. Anything else is refused. Values: `#hex` or
numeric `rgb()/rgba()/hsl()/hsla()`. Alpha is allowed ONLY on the tokens marked
(alpha); backgrounds and texts stay opaque.

## Required (light AND dark; dark-only theme: `light` only)

| Token | Role |
|---|---|
| `--app-bg` | page background behind the panels |
| `--surface` | cards, chat area, inputs |
| `--text-900` | main text and headings |
| `--text-600` | secondary text, labels |
| `--border` (alpha) | lines and outlines |
| `--accent` | main colour: primary button, focus, active mark |
| `--rail-bg` | side rail background |
| `--rail-text` | side rail text |

## Optional (derived by the server when absent)

| Token | Role |
|---|---|
| `--surface-2` .. `--surface-5` | progressively deeper panels and hovers |
| `--border-soft` (alpha) | faint separators |
| `--text-800`, `--text-700` | text steps between 900 and 600 |
| `--text-500`, `--text-400` | muted text (kept readable by the server) |
| `--accent-strong` | accent on hover / pressed |
| `--accent-fg` | text on an accent background (button label) |
| `--accent-text`, `--accent-text-strong` | accent used AS text (links, tags) |
| `--accent-surface`, `--accent-surface-2` (alpha) | tinted backgrounds |
| `--accent-border`, `--accent-ring` (alpha) | tinted outline, focus ring |
| `--prose-link` | links in answers |
| `--rail-bg-2` | second rail shade (footer, inputs) |
| `--rail-border` (alpha) | rail separators |
| `--rail-text-strong`, `--rail-muted` | rail titles / secondary text |
| `--rail-hover`, `--rail-active-bg` (alpha) | rail hover and active item |
| `--code-bg`, `--code-fg` | code blocks (shared by both modes unless set in dark) |
| `--radius` | corner radius: `0px` to `32px` (or up to `2rem`) |

Set only what the user wants to change; fewer tokens means fewer mistakes.

## Contrast checked by the server

Text pairs need 4.5:1 (foreground on background):

- `--text-900`, `--text-800`, `--text-700` and `--text-600` on `--surface`;
  `--text-900` and `--text-600` also on `--app-bg`; `--text-500` and
  `--text-400` on `--surface`.
- `--accent-text` on `--surface` and `--app-bg`; `--accent-text-strong` and
  `--prose-link` on `--surface`.
- `--accent-fg` on `--accent` and on `--accent-strong` (hover of the main button).
- `--code-fg` on `--code-bg`; `--code-inline-fg` on `--code-inline-bg`.
- `--rail-text` on `--rail-bg` and `--rail-bg-2`; `--rail-text-strong` and
  `--rail-muted` on `--rail-bg`.
- Status texts, derived by the server (you do not set them): `--ok-text`,
  `--ok-text-strong`, `--warn-text`, `--warn-text-strong`, `--danger-text` and
  `--danger-strong` on `--surface` and `--app-bg`; `--ok-fg` on `--ok`.

Interface pairs need 3:1: `--accent` on `--surface` and `--app-bg`;
`--accent-ring`, `--accent-500` and `--accent-400` (derived) on `--surface`.

## Advised ranges

- Light: `--app-bg` L 94-98 %, `--surface` white or near white, `--text-900` L < 15 %,
  `--text-600` L 30-40 %.
- Dark: `--app-bg` L 6-12 %, `--surface` L 10-16 %, `--text-900` L > 92 %,
  `--text-600` L 65-75 %.
- `--accent` readable on both `--surface` and `--app-bg`: medium lightness
  (L 35-55 % in light, 55-70 % in dark), saturated enough to stand out.
- `--rail-bg` can be deep or light, but `--rail-text` must stay 4.5:1 above it.
- `--radius`: `4px` sharp, `10px` soft (default feel), `16px` round.
