// SPDX-License-Identifier: MIT
/** apps/core/test/boucle/texte-direct.test.ts — émission directe : suites de jetons Python rejouées (événements et état), queue nettoyée, portail. */
import "../moteur-environnement";

import { describe, expect, it } from "vitest";

import { estErreurAnnulation } from "@elpis/commun";

import { emit } from "../../src/boucle/evenements";
import { LIVE_MARKUP_SUSPECT_RE, LiveText, liveStreamRest } from "../../src/boucle/texte-direct";
import { lireVecteurs } from "../vecteurs-moteur";

type Op = ["jeton", string] | ["flush"] | ["prefixer", string] | ["purger"] | ["reste", string, boolean];
interface Suite {
  ops: Op[];
  evenements: Record<string, unknown>[];
  etat: { parts: string[]; n: number; pend: string; gated: boolean };
}

const V = lireVecteurs<{
  suites: Suite[];
  restes: [string, string, number, string | null][];
  suspects: [string, number | null][];
}>("boucle-texte");

/** Index Python (points de code) du début d'une correspondance. */
function debutPy(t: string): number | null {
  const m = LIVE_MARKUP_SUSPECT_RE.exec(t);
  return m === null ? null : Array.from(t.slice(0, m.index)).length;
}

describe("émission directe du contenu", () => {
  it.each(V.suites.map((s, i) => [i, s] as const))("suite %i", async (_i, s) => {
    const evenements: Record<string, unknown>[] = [];
    const live = new LiveText((e) => {
      evenements.push({ ...e });
    });
    for (const op of s.ops) {
      if (op[0] === "jeton") await live.onToken(op[1]);
      else if (op[0] === "flush") await live.flush();
      else if (op[0] === "prefixer") live.prefixerDejaEmis(op[1]);
      else if (op[0] === "purger") live.purger();
      else await live.emitRest(op[1], { replaceOnDivergence: op[2] });
    }
    expect(evenements).toStrictEqual(s.evenements);
    expect({ parts: live.parts, n: live.n, pend: live.pend, gated: live.gated }).toStrictEqual(s.etat);
  });

  it("queue restante (offsets en points de code, blanc de tête)", () => {
    for (const [c, r, n, attendu] of V.restes) expect(liveStreamRest(c, r, n)).toBe(attendu);
  });

  it("portail : début de la trace de balisage", () => {
    for (const [t, attendu] of V.suspects) expect(debutPy(t)).toBe(attendu);
  });

  it("émission : panne du consommateur tue, annulation propagée", async () => {
    await emit(
      () => {
        throw new Error("consommateur en panne");
      },
      { type: "info" },
    );
    await expect(
      emit(
        () => {
          throw new DOMException("arrêt", "AbortError");
        },
        { type: "info" },
      ),
    ).rejects.toSatisfy(estErreurAnnulation);
    await emit(null, { type: "info" });
  });
});
