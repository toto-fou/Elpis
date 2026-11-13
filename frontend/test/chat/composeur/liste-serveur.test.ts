// SPDX-License-Identifier: MIT
/** frontend/test/chat/composeur/liste-serveur.test.ts — liste des menus du composeur : une lecture en échec ne la laisse pas inconnue (pas de squelette sans fin), garde l'ancienne liste ; un premier échec est relu au prochain appel. */
import { describe, expect, it } from "vitest";

import { listeServeur } from "../../../src/features/chat/composeur/liste-serveur";

describe("listeServeur", () => {
  it("lecture en échec : liste vide si inconnue (relue au prochain appel), ancienne liste gardée sinon", async () => {
    const reponses: (string[] | null | Error)[] = [null, ["a"], new Error("réseau"), ["b"]];
    let lectures = 0;
    const l = listeServeur<string>("essai:changed", async () => {
      const r = reponses[lectures++];
      if (r instanceof Error) throw r;
      return r ?? null;
    });
    expect(l.items.value).toBeNull();
    await l.charger();
    expect(l.items.value).toEqual([]);
    await l.charger();
    expect(l.items.value).toEqual(["a"]);
    await l.charger(true);
    expect(l.items.value).toEqual(["a"]);
    await l.charger(true);
    expect([l.items.value, lectures]).toEqual([["b"], 4]);
  });
});
