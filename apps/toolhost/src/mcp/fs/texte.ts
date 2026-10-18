// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/fs/texte.ts — aides pures de fs_tools.py : texte ou binaire, encodage du BOM, conventions (fins de ligne, BOM, perte), troncature, numéros de ligne, diff unifié et statistiques +X/-Y. */
import { comparePointsDeCode, longueurPy, prefixePy, splitlinesPy, unifiedDiff } from "@elpis/commun";
import type { Dict } from "@elpis/commun";

import { compterDiff } from "../changements";
import { decoderPy, ErreurCodec } from "./codecs";
import { splitlinesGarde } from "./edition";

const TEXTE = new Set([7, 8, 9, 10, 11, 12, 13, 27]);

/** `_is_text_bytes` : pas de NUL, moins de 30 % d'octets de contrôle (≥ 128 : texte). */
export function estTexte(tete: Uint8Array): boolean {
  if (!tete.length) return true;
  if (tete.includes(0)) return false;
  let n = 0;
  for (const b of tete) if (b < 128 && !(b >= 32 && b < 127) && !TEXTE.has(b)) n++;
  return n / tete.length < 0.3;
}

function commencePar(b: Uint8Array, p: readonly number[]): boolean {
  return p.every((x, i) => b[i] === x);
}

const BOMS = [
  [0xef, 0xbb, 0xbf],
  [0xff, 0xfe],
  [0xfe, 0xff],
];

/** `_encodage` : encodage d'après la marque d'ordre des octets. */
export function encodageBom(tete: Uint8Array): string {
  if (commencePar(tete, [0xef, 0xbb, 0xbf])) return "utf-8-sig";
  if (commencePar(tete, [0xff, 0xfe, 0, 0]) || commencePar(tete, [0, 0, 0xfe, 0xff])) return "utf-32";
  if (commencePar(tete, [0xff, 0xfe]) || commencePar(tete, [0xfe, 0xff])) return "utf-16";
  return "utf-8";
}

function compterSous(t: string, s: string): number {
  return t.split(s).length - 1;
}

/** `_line_endings` : `lf`, `crlf`, `cr` ou `mixed` (`lf` sans saut). */
export function finsDeLigne(t: string): string {
  const crlf = compterSous(t, "\r\n");
  const lf = compterSous(t, "\n") - crlf;
  const cr = compterSous(t, "\r") - crlf;
  const types = (
    [
      ["lf", lf],
      ["crlf", crlf],
      ["cr", cr],
    ] as const
  )
    .filter(([, n]) => n)
    .map(([k]) => k);
  if (!types.length) return "lf";
  return types.length === 1 ? (types[0] as string) : "mixed";
}

/** `_crlf_dominant` : les CRLF sont majoritaires parmi les fins de ligne. */
export function crlfDominant(t: string): boolean {
  const crlf = compterSous(t, "\r\n");
  return crlf > 0 && crlf > compterSous(t, "\n") - crlf;
}

/** `_text_conventions` : `line_endings`, `bom`, et `lossy` si des octets ont été remplacés. */
export function conventions(brut: Uint8Array, texte: string, enc: string, explicite = false): Dict {
  const sortie: Dict = { line_endings: finsDeLigne(texte), bom: BOMS.some((b) => commencePar(brut, b)) };
  try {
    decoderPy(brut, enc, "strict");
  } catch (e) {
    if (!(e instanceof ErreurCodec)) throw e;
    sortie["lossy"] = true;
    sortie["encoding"] =
      !explicite && ["utf-8", "utf8", "utf-8-sig"].includes(enc.toLowerCase().replaceAll("_", "-"))
        ? "unknown (non-UTF-8, decoded with replacement)"
        : `${enc} (invalid bytes, decoded with replacement)`;
    sortie["encoding_hint"] =
      "Some bytes are not valid in this encoding and were shown as U+FFFD. The file is probably latin-1/cp1252: " +
      "re-read with encoding='latin-1' (or 'cp1252'). write_file refuses to overwrite it in UTF-8 unless you pass " +
      "that encoding explicitly (or delete the file first).";
  }
  return sortie;
}

/** `_trunc` : coupe à `n` points de code et dit combien a été omis. */
export function tronquer(s: string, n: number): [string, boolean] {
  return tronquerSur(s, n, longueurPy(s));
}

/** `_trunc` d'un texte de `l` points de code dont `debut` porte au moins les `n` premiers. */
export function tronquerSur(debut: string, n: number, l: number): [string, boolean] {
  if (!l || l <= n) return [debut, false];
  return [`${prefixePy(debut, n)}\n...[truncated: ${l - n} chars omitted of ${l}]`, true];
}

/** `_format_lines` : `numéro<TAB>ligne`, numéros alignés à droite. */
export function formaterLignes(lignes: readonly string[], debut: number, numeros: boolean): string {
  if (!numeros) return lignes.join("\n");
  if (!lignes.length) return "";
  const largeur = String(debut + lignes.length - 1).length;
  return lignes.map((l, i) => `${String(debut + i).padStart(largeur)}\t${l}`).join("\n");
}

/** `_line_count`. */
export function nombreLignes(s: string): number {
  if (!s) return 0;
  return compterSous(s, "\n") + (s.endsWith("\n") ? 0 : 1);
}

/** `_make_diff` : diff unifié `a/<rel>` → `b/<rel>`. */
export function faireDiff(ancien: string, nouveau: string, rel: string, n = 3): string {
  return unifiedDiff(splitlinesGarde(ancien), splitlinesGarde(nouveau), {
    fromfile: `a/${rel}`,
    tofile: `b/${rel}`,
    n,
  }).join("");
}

/** `_line_diff_stats` : (ajoutées, retirées). */
export function statsDiff(ancien: string, nouveau: string): [number, number] {
  if (ancien === nouveau) return [0, 0];
  return compterDiff(splitlinesPy(ancien), splitlinesPy(nouveau));
}

type Cle = [number, string][];

/** `_cle_parcours` : ordre d'un parcours trié, dossiers puis fichiers à chaque niveau. */
export function cleParcours(rel: string, dossier: boolean): Cle {
  const parties = rel.split("/");
  return [
    ...parties.slice(0, -1).map((x) => [2, x] as [number, string]),
    [dossier ? 0 : 1, parties[parties.length - 1] as string],
  ];
}

/** Comparaison de deux clés comme les listes de tuples Python. */
export function comparerCles(a: Cle, b: Cle): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const [x, y] = [a[i] as [number, string], b[i] as [number, string]];
    if (x[0] !== y[0]) return x[0] - y[0];
    const c = comparePointsDeCode(x[1], y[1]);
    if (c) return c;
  }
  return a.length - b.length;
}

/** `binascii.Error` ou `UnicodeEncodeError` d'un base64 refusé (message de Python). */
export class ErreurB64 extends Error {}

const ALPHABET_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** `base64.b64decode(s.encode("ascii"), validate=True)` : `a2b_base64` en mode strict de CPython 3.13. */
export function b64Strict(s: string): Buffer {
  const nonAscii = s.search(/[\u0080-\u{10ffff}]/u);
  if (nonAscii >= 0) {
    const points = Array.from(s);
    const i0 = Array.from(s.slice(0, nonAscii)).length;
    let fin = i0 + 1;
    while (fin < points.length && (points[fin]?.codePointAt(0) as number) >= 0x80) fin++;
    if (fin - i0 > 1)
      throw new ErreurB64(
        `'ascii' codec can't encode characters in position ${i0}-${fin - 1}: ordinal not in range(128)`,
      );
    const c = points[i0]?.codePointAt(0) as number;
    const r =
      c <= 0xff
        ? `\\x${c.toString(16).padStart(2, "0")}`
        : c <= 0xffff
          ? `\\u${c.toString(16).padStart(4, "0")}`
          : `\\U${c.toString(16).padStart(8, "0")}`;
    throw new ErreurB64(
      `'ascii' codec can't encode character '${r}' in position ${i0}: ordinal not in range(128)`,
    );
  }
  if (s.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(s)) return Buffer.from(s, "base64");
  if (s.startsWith("=")) throw new ErreurB64("Leading padding not allowed");
  const sortie: number[] = [];
  let quad = 0;
  let gauche = 0;
  let pads = 0;
  let remplissage = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (c === "=") {
      remplissage = true;
      if (quad === 0) throw new ErreurB64("Excess padding not allowed");
      if (quad >= 2 && quad + ++pads >= 4) {
        if (i + 1 < s.length) throw new ErreurB64("Excess data after padding");
        return Buffer.from(sortie);
      }
      continue;
    }
    const v = ALPHABET_B64.indexOf(c);
    if (v < 0) throw new ErreurB64("Only base64 data is allowed");
    if (remplissage) throw new ErreurB64("Discontinuous padding not allowed");
    pads = 0;
    if (quad === 0) {
      gauche = v;
      quad = 1;
    } else if (quad === 1) {
      sortie.push(((gauche << 2) | (v >> 4)) & 0xff);
      gauche = v & 0x0f;
      quad = 2;
    } else if (quad === 2) {
      sortie.push(((gauche << 4) | (v >> 2)) & 0xff);
      gauche = v & 0x03;
      quad = 3;
    } else {
      sortie.push(((gauche << 6) | v) & 0xff);
      quad = 0;
    }
  }
  if (quad === 1)
    throw new ErreurB64(
      `Invalid base64-encoded string: number of data characters (${Math.floor(sortie.length / 3) * 4 + 1}) cannot be 1 more than a multiple of 4`,
    );
  if (quad !== 0) throw new ErreurB64("Incorrect padding");
  return Buffer.from(sortie);
}
