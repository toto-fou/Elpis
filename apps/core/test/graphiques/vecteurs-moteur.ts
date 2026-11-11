// SPDX-License-Identifier: MIT
/** apps/core/test/graphiques/vecteurs-moteur.ts — vecteurs du moteur de graphiques générés par le Python et aides de comparaison. */
import { readFileSync } from "node:fs";

import { FlottantPy, pyJsonDumps, pyJsonLoads } from "@elpis/commun";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const V = pyJsonLoads(
  readFileSync(new URL("../vecteurs/graphiques-moteur.json", import.meta.url), "utf-8"),
) as any;

/** Écriture canonique de comparaison : types Python (`1` ≠ `1.0`) et ordre des clés conservés. */
export function ecrit(v: unknown): string {
  return pyJsonDumps(v, { ensureAscii: false });
}

/** Première différence entre deux textes, avec le contexte. */
export function difference(obtenu: string, attendu: string): string {
  let i = 0;
  while (i < obtenu.length && i < attendu.length && obtenu[i] === attendu[i]) i++;
  return `à ${i}\n  TS : …${obtenu.slice(Math.max(0, i - 80), i + 100)}\n  PY : …${attendu.slice(Math.max(0, i - 80), i + 100)}`;
}

/** Valeur numérique d'un nombre lu par `pyJsonLoads`. */
export function nombre(v: unknown): number {
  if (v instanceof FlottantPy) return v.valeur;
  if (typeof v === "bigint") return Number(v);
  return v as number;
}

/** Heure figée du trait « aujourd'hui » du Gantt, en heure murale locale du process. */
export function maintenant(): Date {
  const [a, m, j, h, mi, s, us] = V.maintenant as number[];
  return new Date(a ?? 0, (m ?? 1) - 1, j, h, mi, s, (us ?? 0) / 1000);
}

/** Avertissements ajoutés après le Python (harnais B-18, B-24 à B-27) : retirés avant comparaison aux vecteurs. */
const ECARTS_VOULUS = [
  /^rows do not all have the same keys/,
  /^\d+ empty or non-numeric value\(s\) in /,
  /^highlight not found/,
  /^\d+ node\(s\) not drawn/,
  /^duplicate node name/,
  /^'.*' is mostly numeric/,
  /^stages are not decreasing/,
  /^value exceeds max/,
  /^done exceeds total/,
  /^previous = 0 for/,
  /^trend needs at least 3/,
  /^trend on prices needs at least 5/,
  /^\d+ cell\(s\) missing/,
  /^\d+ row\(s\) skipped, unreadable date/,
];

/** Écart voulu au Python : les avertissements ci-dessus sont ignorés, tout le reste reste comparé. */
export function sansEcartsVoulus<T>(v: T, garderVide = false): T {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
  const o = { ...(v as Record<string, unknown>) };
  const f = o["fixes"];
  if (Array.isArray(f)) {
    const reste = f.filter(
      (m) => !(typeof m === "string" && /^dates written .* read as DD\/MM\/YYYY/.test(m)),
    );
    if (reste.length > 0 || garderVide) o["fixes"] = reste;
    else delete o["fixes"];
  }
  const w = o["warnings"];
  if (Array.isArray(w)) {
    const reste = w.filter((m) => !(typeof m === "string" && ECARTS_VOULUS.some((r) => r.test(m))));
    if (reste.length > 0 || garderVide) o["warnings"] = reste;
    else delete o["warnings"];
  }
  return o as T;
}
