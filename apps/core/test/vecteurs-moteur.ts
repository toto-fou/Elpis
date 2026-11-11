// SPDX-License-Identifier: MIT
/** apps/core/test/vecteurs-moteur.ts — lecture des vecteurs Python du moteur : flottants non finis, erreurs et appels. */
import { readFileSync } from "node:fs";
import { expect } from "vitest";

import type { ErreurPython } from "@elpis/commun";

export function lireVecteurs<T>(nom: string): T {
  return JSON.parse(readFileSync(new URL(`./vecteurs/${nom}.json`, import.meta.url), "utf-8")) as T;
}

/** `{"$flottant": "nan" | "inf" | "-inf"}` (JSON n'a pas ces valeurs) rendu en nombre, récursivement. */
export function decoder(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decoder);
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    if (Object.keys(o).length === 1 && typeof o["$flottant"] === "string") {
      return { nan: Number.NaN, inf: Infinity, "-inf": -Infinity }[o["$flottant"]];
    }
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, decoder(x)]));
  }
  return v;
}

/** Classe Python → `type` d'`ErreurPython` (UnicodeEncodeError est une ValueError). */
const TYPES: Readonly<Record<string, string>> = {
  ValueError: "ValueError",
  UnicodeEncodeError: "ValueError",
  TypeError: "TypeError",
  OverflowError: "OverflowError",
  AttributeError: "AttributeError",
};

export type Attendu = { valeur: unknown } | { erreur: string };

/** Rejoue `f` et compare à `{valeur}` ou `{erreur}` du vecteur Python (le `type` suffit : un import neuf recrée la classe). */
export function rejouer(f: () => unknown, attendu: Attendu, contexte: string): void {
  if ("erreur" in attendu) {
    let levee: unknown = null;
    try {
      f();
    } catch (e) {
      levee = e;
    }
    expect(levee, contexte).toBeInstanceOf(Error);
    expect((levee as ErreurPython).type, contexte).toBe(TYPES[attendu.erreur] ?? attendu.erreur);
    return;
  }
  expect(f(), contexte).toEqual(decoder(attendu.valeur));
}
