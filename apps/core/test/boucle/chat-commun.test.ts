// SPDX-License-Identifier: MIT
/** apps/core/test/boucle/chat-commun.test.ts — aides reprises du chemin classique : raisonnement dans le texte, system unique, refus 4xx. */
import "../moteur-environnement";

import { describe, expect, it } from "vitest";

import {
  coalesceSystemMessages,
  extractThinking,
  http4xx,
  splitOrphanThinkClose,
} from "../../src/boucle/chat-commun";
import { HTTPStatusError, ReponseHttp } from "../../src/llm/client-http";
import { providerHttpError } from "../../src/llm/reprises";
import { lireVecteurs } from "../vecteurs-moteur";

const V = lireVecteurs<{
  extraction: [string, [string, string], [string, string], [string, string] | null][];
  fusion: [unknown[], unknown[], boolean][];
}>("boucle-chat-commun");

describe("aides reprises du chemin classique", () => {
  it("raisonnement dans le texte (avec et sans troncature), fermante orpheline", () => {
    for (const [t, normal, tronque, orpheline] of V.extraction) {
      expect(extractThinking(t), t).toStrictEqual(normal);
      expect(extractThinking(t, { truncated: true }), t).toStrictEqual(tronque);
      expect(splitOrphanThinkClose(t), t).toStrictEqual(orpheline);
    }
  });

  it("un seul system en tête ; liste conforme rendue telle quelle", () => {
    for (const [liste, attendu, inchangee] of V.fusion) {
      const sortie = coalesceSystemMessages(liste);
      expect(sortie).toStrictEqual(attendu);
      expect(sortie === liste).toBe(inchangee);
    }
  });

  it("refus 4xx définitif", () => {
    const refus = (code: number): HTTPStatusError =>
      new HTTPStatusError(`HTTP ${code}`, {
        request: { method: "POST", url: "http://m/v1/chat/completions" },
        response: new ReponseHttp({
          statusCode: code,
          request: { method: "POST", url: "http://m/v1/chat/completions" },
        }),
      });
    expect([400, 404, 499].map((c) => http4xx(refus(c)))).toEqual([true, true, true]);
    expect([408, 429, 500, 399].map((c) => http4xx(refus(c)))).toEqual([false, false, false, false]);
    expect(http4xx(providerHttpError(400, "refus dans le flux"))).toBe(false);
    expect(http4xx(new Error("x"))).toBe(false);
  });
});
