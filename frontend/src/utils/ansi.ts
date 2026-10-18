// SPDX-License-Identifier: MIT
/** frontend/src/utils/ansi.ts — rendu ANSI minimal (SGR seul) de la sortie shell en HTML sûr, \r résolus. */

interface EtatSgr {
  fg: number | null;
  bold: boolean;
  dim: boolean;
}

const ECHAPPEMENT_HTML: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

/* eslint-disable no-control-regex */
const RE_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const RE_CSI = /\x1b\[[0-9;?]*[A-LN-Za-ln-z]/g;
const RE_MISC = /\x1b[@-Z\\-_]/g;
const RE_CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f]/g;
const RE_SGR = /\x1b\[([0-9;]*)m/g;
/* eslint-enable no-control-regex */

export function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"]/g, (c) => ECHAPPEMENT_HTML[c] ?? c);
}

function stripNonSgr(s: string): string {
  return s.replace(RE_OSC, "").replace(RE_CSI, "").replace(RE_MISC, "").replace(RE_CTRL, "");
}

/** Chaque segment après `\r` écrase le début de la ligne accumulée. */
function resolveCarriage(line: string): string {
  const segs = line.split("\r");
  if (segs.length === 1) return line;
  let acc = "";
  for (const s of segs) {
    if (!s) continue;
    acc = s.length >= acc.length ? s : s + acc.slice(s.length);
  }
  return acc;
}

function applySgrCodes(state: EtatSgr, paramStr: string): void {
  const parts = paramStr === "" ? ["0"] : paramStr.split(";");
  for (const part of parts) {
    const n = parseInt(part || "0", 10);
    if (Number.isNaN(n)) continue;
    if (n === 0) {
      state.fg = null;
      state.bold = false;
      state.dim = false;
    } else if (n === 1) state.bold = true;
    else if (n === 2) state.dim = true;
    else if (n === 22) {
      state.bold = false;
      state.dim = false;
    } else if (n === 39) state.fg = null;
    else if (n >= 30 && n <= 37) state.fg = n - 30;
    else if (n >= 90 && n <= 97) state.fg = n - 90 + 8;
  }
}

function spanOpen(state: EtatSgr): string {
  const cls: string[] = [];
  if (state.fg !== null) cls.push("sh-fg-" + state.fg);
  if (state.bold) cls.push("sh-b");
  if (state.dim) cls.push("sh-d");
  return cls.length ? `<span class="${cls.join(" ")}">` : "";
}

/** Sortie brute d'un shell (ANSI, \r, \n) en HTML échappé avec spans de couleur. */
export function ansiToHtml(text: unknown): string {
  if (text == null || text === "") return "";
  const lines = stripNonSgr(String(text)).split("\n");
  const state: EtatSgr = { fg: null, bold: false, dim: false };
  const out: string[] = [];
  for (const brute of lines) {
    const line = resolveCarriage(brute);
    let html = "";
    let last = 0;
    let open = spanOpen(state);
    if (open) html += open;
    RE_SGR.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RE_SGR.exec(line)) !== null) {
      html += escapeHtml(line.slice(last, m.index));
      if (open) html += "</span>";
      applySgrCodes(state, m[1] ?? "");
      open = spanOpen(state);
      if (open) html += open;
      last = m.index + m[0].length;
    }
    html += escapeHtml(line.slice(last));
    if (open) html += "</span>";
    out.push(html);
  }
  return out.join("\n");
}
