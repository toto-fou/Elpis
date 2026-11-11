// SPDX-License-Identifier: MIT
/** packages/verrous/test/distants.test.ts — dossiers sur un système de fichiers réseau (fs-local du doctor) : vecteurs de systemes_distants rejoués. */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SYSTEMES_DISTANTS, systemesDistants } from "../src/distants";

const V = JSON.parse(readFileSync(new URL("./vecteurs/distants.json", import.meta.url), "utf-8")) as {
  montages: Record<string, string>;
  systemes: string[];
  cas: { montages: string; chemins: string[]; distants: [string, string][] }[];
};

describe("systemesDistants", () => {
  it("mêmes types de systèmes réseau que le Python", () => {
    expect([...SYSTEMES_DISTANTS].sort()).toEqual(V.systemes);
  });

  for (const c of V.cas)
    it(`${c.montages} : ${JSON.stringify(c.chemins)}`, () => {
      expect(systemesDistants(c.chemins, V.montages[c.montages])).toEqual(c.distants);
    });

  it("montages de cette machine : seuls des types réseau sont rendus", () => {
    expect(systemesDistants(["/"], undefined).every(([, fs]) => SYSTEMES_DISTANTS.has(fs))).toBe(true);
  });
});
