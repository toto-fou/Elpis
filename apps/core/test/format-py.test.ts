// SPDX-License-Identifier: MIT
/** apps/core/test/format-py.test.ts — `str.format` de Python : 2 511 couples valeur × spécification et gabarits, vecteurs Python. */
import { describe, expect, it } from "vitest";

import { ErreurFormat, FlottantPy, formatValeur, formatValeursPy as formatPy } from "@elpis/commun";
import type { ValeurFormat } from "@elpis/commun";

import { lireVecteurs } from "./vecteurs-moteur";

type Attendu = { valeur: string } | { erreur: string };

interface Vecteurs {
  specs: ({ entree: unknown; nom: string; spec: string } & Attendu)[];
  gabarits: ({ gabarit: string; valeurs: Record<string, unknown> } & Attendu)[];
}

const v = lireVecteurs<Vecteurs>("format-py");
const NON_FINIS: Readonly<Record<string, number>> = { inf: Infinity, "-inf": -Infinity, nan: Number.NaN };

function decoder(x: unknown): ValeurFormat {
  if (typeof x === "object" && x !== null) {
    const o = x as Record<string, string>;
    if ("$float" in o) return new FlottantPy(NON_FINIS[o["$float"] ?? ""] ?? Number(o["$float"]));
    if ("$int" in o) return BigInt(o["$int"] ?? "0");
  }
  return x as ValeurFormat;
}

function rejouer(f: () => string, attendu: Attendu, contexte: string): void {
  if ("valeur" in attendu) {
    expect(f(), contexte).toBe(attendu.valeur);
    return;
  }
  let levee: unknown = null;
  try {
    f();
  } catch (e) {
    levee = e;
  }
  expect(levee, contexte).toBeInstanceOf(ErreurFormat);
  expect((levee as ErreurFormat).type, contexte).toBe(attendu.erreur);
}

describe("format(valeur, spec) — vecteurs Python", () => {
  it("rejoue chaque couple valeur × spécification (sortie ou type d'erreur)", () => {
    for (const cas of v.specs)
      rejouer(
        () => formatValeur(decoder(cas.entree), cas.spec),
        cas,
        `${cas.nom} ${JSON.stringify(cas.spec)}`,
      );
  });
});

describe("gabarit.format(**champs) — vecteurs Python", () => {
  it("champs nommés, accolades doublées, conversions, spécifications imbriquées et erreurs", () => {
    for (const cas of v.gabarits) {
      const champs = Object.fromEntries(Object.entries(cas.valeurs).map(([k, x]) => [k, decoder(x)]));
      rejouer(() => formatPy(cas.gabarit, champs), cas, JSON.stringify(cas.gabarit));
    }
  });
});

describe("grandes largeurs", () => {
  it("zéros de tête groupés en temps linéaire (gabarit d'en-tête réglé par l'admin)", () => {
    const debut = performance.now();
    const r = formatValeur(1234567, "0200000,d");
    expect(performance.now() - debut).toBeLessThan(1000);
    expect(r.length).toBeGreaterThanOrEqual(200000);
    expect(r.length).toBeLessThanOrEqual(200001);
    expect(r.endsWith(",001,234,567")).toBe(true);
    expect(r.replaceAll(",", "").length).toBe(Math.ceil((r.length * 3) / 4));
  });
});
