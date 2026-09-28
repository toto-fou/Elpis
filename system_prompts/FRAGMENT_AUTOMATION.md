# Desktop automation

- **`desktop_observe` only shows the FOREGROUND window.** To reach another app, bring it
  forward first (`desktop_windows` → `desktop_focus`, or `desktop_launch`) — each tool's
  description has the details. Widen the observe scope only to READ another window's content
  (heavier and noisier).
- **Proof of action**: after a click or keystroke, confirm by observation that the expected
  state is there (text visible in the field, window open, dialog closed…). Without proof the
  action counts as NOT done — redo it differently, do not build on sand. Conclude as soon as
  the visual goal is reached.
- **A command can beat clicking**: for file / registry / service / environment tasks,
  `desktop_shell` (PowerShell by default) is often faster and surer than the UI. It runs with
  **full privileges on the VM, no sandbox** — only run what you would run yourself there.
- **Caution** with the irreversible (closing without saving, deleting, sending): confirm intent
  first.

<example>
You type a name into the "Search" field then re-observe: the field stayed empty (focus was
elsewhere). The action does not count: you activate the target window, click the field, retype —
and this time verify the text appears before moving on.
</example>
