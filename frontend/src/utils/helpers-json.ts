// SPDX-License-Identifier: MIT
/** frontend/src/utils/helpers-json.ts — décodage progressif des arguments JSON d'un tool_call en cours de flux. */

export type ScalaireJson =
  | { type: "string"; value: string; endIdx: number }
  | { type: "number"; value: number; endIdx: number }
  | { type: "bool"; value: boolean; endIdx: number }
  | { type: "null"; value: null; endIdx: number };

export interface EtatChampChaine {
  complete?: boolean;
  valueStart?: number;
  cursor?: number;
}

export interface TrancheChamp {
  chunk: string;
  complete: boolean;
  found: boolean;
}

const ECHAPPEMENTS: Readonly<Record<string, string>> = {
  n: "\n",
  t: "\t",
  r: "\r",
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
};

export function makeToolStreamKey(
  chatId?: string | null,
  iter?: number | null,
  index?: number | null,
): string {
  return `${chatId || "local"}:${iter || 0}:${index || 0}`;
}

export function reEsc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Décode un échappement en `i` ; null si le buffer est coupé au milieu. */
function decoderEchappement(buf: string, i: number): { texte: string; suivant: number } | null {
  if (i + 1 >= buf.length) return null;
  const nx = buf.charAt(i + 1);
  if (nx === "u") {
    if (i + 6 > buf.length) return null;
    const code = parseInt(buf.substring(i + 2, i + 6), 16);
    return { texte: Number.isNaN(code) ? "" : String.fromCharCode(code), suivant: i + 6 };
  }
  return { texte: ECHAPPEMENTS[nx] ?? nx, suivant: i + 2 };
}

/** Scalaire JSON d'un champ, seulement une fois complètement arrivé ; undefined sinon. */
export function extractJsonScalar(buf: string, fieldName: string): ScalaireJson | undefined {
  const m = new RegExp('"' + reEsc(fieldName) + '"\\s*:\\s*').exec(buf);
  if (!m) return undefined;
  const start = m.index + m[0].length;
  if (start >= buf.length) return undefined;
  const first = buf.charAt(start);
  if (first === '"') {
    let i = start + 1;
    let out = "";
    while (i < buf.length) {
      const c = buf.charAt(i);
      if (c === "\\") {
        const esc = decoderEchappement(buf, i);
        if (!esc) return undefined;
        out += esc.texte;
        i = esc.suivant;
      } else if (c === '"') {
        return { type: "string", value: out, endIdx: i + 1 };
      } else {
        out += c;
        i++;
      }
    }
    return undefined;
  }
  if (first === "-" || (first >= "0" && first <= "9")) {
    let i = start;
    if (buf.charAt(i) === "-") i++;
    while (i < buf.length && /[0-9.eE+-]/.test(buf.charAt(i))) i++;
    if (i >= buf.length) return undefined;
    if (/[\s,}\]]/.test(buf.charAt(i))) {
      return { type: "number", value: parseFloat(buf.substring(start, i)), endIdx: i };
    }
    return undefined;
  }
  if (buf.startsWith("true", start)) return { type: "bool", value: true, endIdx: start + 4 };
  if (buf.startsWith("false", start)) return { type: "bool", value: false, endIdx: start + 5 };
  if (buf.startsWith("null", start)) return { type: "null", value: null, endIdx: start + 4 };
  return undefined;
}

/** Consomme les caractères d'un champ chaîne depuis le curseur de `state` (muté) et rend le morceau décodé. */
export function pullJsonStringField(buf: string, fieldName: string, state: EtatChampChaine): TrancheChamp {
  if (state.complete) return { chunk: "", complete: true, found: true };
  if (state.valueStart === undefined) {
    const m = new RegExp('"' + reEsc(fieldName) + '"\\s*:\\s*"').exec(buf);
    if (!m) return { chunk: "", complete: false, found: false };
    state.valueStart = m.index + m[0].length;
    state.cursor = state.valueStart;
  }
  let out = "";
  let i = state.cursor ?? state.valueStart;
  while (i < buf.length) {
    const c = buf.charAt(i);
    if (c === "\\") {
      const esc = decoderEchappement(buf, i);
      if (!esc) break;
      out += esc.texte;
      i = esc.suivant;
    } else if (c === '"') {
      state.complete = true;
      state.cursor = i + 1;
      return { chunk: out, complete: true, found: true };
    } else {
      out += c;
      i++;
    }
  }
  state.cursor = i;
  return { chunk: out, complete: false, found: true };
}

/** Fabrique historique `setupChatHelpersJson()` : les quatre helpers sous leurs anciens noms. */
export function setupChatHelpersJson() {
  return {
    _makeToolStreamKey: makeToolStreamKey,
    _reEsc: reEsc,
    _extractJsonScalar: extractJsonScalar,
    _pullJsonStringField: pullJsonStringField,
  };
}
