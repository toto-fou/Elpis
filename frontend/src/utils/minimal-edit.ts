// SPDX-License-Identifier: MIT
/** frontend/src/utils/minimal-edit.ts — édition minimale d'un modèle Monaco : une seule opération sur la fenêtre de lignes modifiée. */

export interface PlageEdition {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface EditionMinimale {
  range: PlageEdition;
  text: string;
  startLine: number;
  endLine: number;
  changed: number;
}

/** Colonne de fin d'une ligne au sens Monaco (le \r d'un CRLF n'en fait pas partie). */
function maxCol(line: string | undefined): number {
  let s = line || "";
  if (s.charCodeAt(s.length - 1) === 13) s = s.slice(0, -1);
  return s.length + 1;
}

export function compute(ancien: unknown, nouveau: unknown): EditionMinimale | null {
  const oldText = String(ancien == null ? "" : ancien);
  const newText = String(nouveau == null ? "" : nouveau);
  if (oldText === newText) return null;
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  let top = 0;
  while (top < oldLines.length && top < newLines.length && oldLines[top] === newLines[top]) top++;
  let oldBot = oldLines.length - 1;
  let newBot = newLines.length - 1;
  while (oldBot >= top && newBot >= top && oldLines[oldBot] === newLines[newBot]) {
    oldBot--;
    newBot--;
  }
  const oldEmpty = oldBot < top;
  const newEmpty = newBot < top;
  const mid = newLines.slice(top, newBot + 1).join("\n");
  let range: PlageEdition;
  let text: string;
  if (!oldEmpty && !newEmpty) {
    range = {
      startLineNumber: top + 1,
      startColumn: 1,
      endLineNumber: oldBot + 1,
      endColumn: maxCol(oldLines[oldBot]),
    };
    text = mid;
  } else if (oldEmpty) {
    if (top < oldLines.length) {
      range = { startLineNumber: top + 1, startColumn: 1, endLineNumber: top + 1, endColumn: 1 };
      text = mid + "\n";
    } else {
      const col = maxCol(oldLines[top - 1]);
      range = { startLineNumber: top, startColumn: col, endLineNumber: top, endColumn: col };
      text = "\n" + mid;
    }
  } else {
    if (oldBot + 1 < oldLines.length) {
      range = { startLineNumber: top + 1, startColumn: 1, endLineNumber: oldBot + 2, endColumn: 1 };
    } else if (top > 0) {
      range = {
        startLineNumber: top,
        startColumn: maxCol(oldLines[top - 1]),
        endLineNumber: oldBot + 1,
        endColumn: maxCol(oldLines[oldBot]),
      };
    } else {
      range = {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: oldBot + 1,
        endColumn: maxCol(oldLines[oldBot]),
      };
    }
    text = "";
  }
  const changed = newEmpty ? 0 : newBot - top + 1;
  return { range, text, startLine: top + 1, endLine: top + 1 + Math.max(0, changed - 1), changed };
}

/** Application de référence sur une chaîne (fins de ligne LF, colonnes à la Monaco). */
export function apply(
  ancien: unknown,
  edit: Pick<EditionMinimale, "range" | "text"> | null | undefined,
): string {
  const oldText = String(ancien);
  if (!edit) return oldText;
  const lines = oldText.split("\n");
  const offset = (line: number, col: number): number => {
    let o = 0;
    for (let i = 0; i < line - 1; i++) o += (lines[i] ?? "").length + 1;
    return o + (col - 1);
  };
  const r = edit.range;
  const a = offset(r.startLineNumber, r.startColumn);
  const b = offset(r.endLineNumber, r.endColumn);
  return oldText.slice(0, a) + edit.text + oldText.slice(b);
}
