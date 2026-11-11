// SPDX-License-Identifier: MIT
/** frontend/test/chat/affichage.test.ts — libellés des mentions du tour (sources RAG, chargement du modèle). */
import { describe, expect, it } from "vitest";

import { fusionnerSourcesRag, libelleChargementModele, sourcesRag } from "../../src/features/chat/affichage";

const source = (n: number, doc: string) => ({ n, passage: { document_name: doc } });

describe("mentions du tour", () => {
  it("sources RAG : documents des passages, sans vide ni doublon ; autre chose qu'une liste → aucun", () => {
    expect(
      sourcesRag([source(1, "a.pdf"), source(2, " b.md "), source(3, "a.pdf"), source(4, ""), 7]),
    ).toEqual(["a.pdf", "b.md"]);
    expect(sourcesRag("a.pdf")).toEqual([]);
    expect(sourcesRag(undefined)).toEqual([]);
  });

  it("sources d'un message complétées par un événement : un numéro gardé une fois", () => {
    expect(fusionnerSourcesRag([source(1, "a"), source(2, "b")], [source(2, "c"), source(3, "d")])).toEqual([
      source(1, "a"),
      source(2, "c"),
      source(3, "d"),
    ]);
    expect(fusionnerSourcesRag(null, [source(1, "a")])).toEqual([source(1, "a")]);
  });

  it("chargement du modèle : étape, rang et pourcentage borné", () => {
    expect(libelleChargementModele(null)).toBe("");
    expect(libelleChargementModele({ model: "m" })).toBe("Chargement du modèle…");
    expect(libelleChargementModele({ stage: "download", pct: 35, stages: ["download"] })).toBe(
      "Téléchargement du modèle · 35 %",
    );
    expect(
      libelleChargementModele({ stage: "mmproj_model", pct: 61.6, stages: ["text_model", "mmproj_model"] }),
    ).toBe("Chargement du module vision (2/2) · 62 %");
    expect(libelleChargementModele({ stage: "autre", pct: 140 })).toBe("Chargement du modèle · 100 %");
  });
});
