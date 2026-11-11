// SPDX-License-Identifier: MIT
/** frontend/test/chat/evenements.test.ts — décodage des événements : le chemin rapide des deltas de texte rend le même verdict que le schéma Zod. */
import { schemaEvenementFlux } from "@elpis/contracts";
import { describe, expect, it } from "vitest";

import { decoderEvenement } from "../../src/features/chat/evenements";

const CHARGES: readonly unknown[] = [
  { text: "a" },
  { text: "" },
  { text: "a", n: 3 },
  { text: "a", n: 0, _s: 12 },
  { text: "a", n: 1.5 },
  { text: "a", n: "2" },
  { text: "a", n: null },
  { text: "a", n: Number.MAX_SAFE_INTEGER + 1 },
  { text: "a", _s: -1 },
  { text: 3 },
  { text: null },
  {},
  { text: "a", extra: 1 },
  { text: "a", chat_id: "c" },
  JSON.parse('{"text":"a","__proto__":{"x":1}}'),
];

describe("decoderEvenement", () => {
  for (const type of ["content_token", "thinking_token"] as const) {
    it(`${type} : même verdict que schemaEvenementFlux sur chaque forme`, () => {
      for (const charge of CHARGES) {
        const brut = { type, ...(charge as object) };
        const attendu = schemaEvenementFlux.safeParse(brut).success ? "valide" : "hors_contrat";
        const d = decoderEvenement(brut);
        expect(d.statut, JSON.stringify(brut)).toBe(attendu);
        if (d.statut === "valide") expect(d.ev).toEqual(schemaEvenementFlux.parse(brut));
      }
    });
  }

  it("les autres types passent toujours par le schéma", () => {
    expect(decoderEvenement({ type: "tool_call", text: "a" }).statut).toBe("hors_contrat");
    expect(decoderEvenement({ type: "nouveau", text: "a" }).statut).toBe("inconnu");
  });
});
