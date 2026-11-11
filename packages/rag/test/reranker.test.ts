// SPDX-License-Identifier: MIT
/** packages/rag/test/reranker.test.ts — client /v1/rerank : formats llama.cpp, Jina, Cohere et TEI, corps envoyé, erreurs. */
import { afterEach, describe, expect, it } from "vitest";

import { ClientReranker, lireReclassement } from "../src/reranker";
import { demarrerServeurFaux } from "./serveur-faux";
import type { Gestionnaire, ServeurFaux } from "./serveur-faux";

const serveurs: ServeurFaux[] = [];

async function monter(
  g: Gestionnaire,
  options: { cleApi?: string; delaiMs?: number; caracteresMax?: number; modele?: string } = {},
): Promise<{ c: ClientReranker; s: ServeurFaux }> {
  const s = await demarrerServeurFaux(g);
  serveurs.push(s);
  return { c: new ClientReranker({ url: `${s.url}/`, ...options }), s };
}

afterEach(async () => {
  await Promise.all(serveurs.splice(0).map((s) => s.arreter()));
});

describe("lireReclassement", () => {
  it("lit results/relevance_score (llama.cpp, Jina, Cohere), triés du meilleur au moins bon", () => {
    const json = {
      results: [
        { index: 2, relevance_score: 0.2 },
        { index: 0, relevance_score: 0.9 },
        { index: 1, relevance_score: 0.5 },
      ],
    };
    expect(lireReclassement(json, 3)).toEqual([
      { index: 0, score: 0.9 },
      { index: 1, score: 0.5 },
      { index: 2, score: 0.2 },
    ]);
  });

  it("lit la liste nue de TEI et la clé data", () => {
    expect(
      lireReclassement(
        [
          { index: 1, score: 0.4 },
          { index: 0, score: 0.8 },
        ],
        2,
      ),
    ).toEqual([
      { index: 0, score: 0.8 },
      { index: 1, score: 0.4 },
    ]);
    expect(lireReclassement({ data: [{ index: 0, relevance_score: 1 }] }, 1)).toEqual([
      { index: 0, score: 1 },
    ]);
  });

  it("ignore les entrées hors bornes ou non numériques et refuse une réponse vide", () => {
    expect(
      lireReclassement(
        {
          results: [
            { index: 5, score: 1 },
            { index: -1, score: 1 },
            { index: 0, score: "x" },
            "n",
            { index: 1, score: 0.3 },
          ],
        },
        2,
      ),
    ).toEqual([{ index: 1, score: 0.3 }]);
    expect(() => lireReclassement({ results: [] }, 2)).toThrow(
      expect.objectContaining({ code: "reranker_reponse" }),
    );
    expect(() => lireReclassement("non", 2)).toThrow(expect.objectContaining({ code: "reranker_reponse" }));
    expect(() => lireReclassement({ erreur: 1 }, 2)).toThrow(
      expect.objectContaining({ code: "reranker_reponse" }),
    );
  });

  it("départage les égalités par l'indice", () => {
    expect(
      lireReclassement(
        [
          { index: 2, score: 0.5 },
          { index: 0, score: 0.5 },
        ],
        3,
      ).map((s) => s.index),
    ).toEqual([0, 2]);
  });
});

describe("ClientReranker", () => {
  it("envoie la requête, les documents tronqués et top_n, et rend les scores", async () => {
    const { c, s } = await monter(
      () => ({
        json: {
          results: [
            { index: 1, relevance_score: 0.8 },
            { index: 0, relevance_score: 0.1 },
          ],
        },
      }),
      {
        cleApi: "k",
        caracteresMax: 10,
        modele: "mon-reranker",
      },
    );
    const sortie = await c.classer("ma question", ["a".repeat(50), "court"], { topN: 5 });
    expect(sortie).toEqual([
      { index: 1, score: 0.8 },
      { index: 0, score: 0.1 },
    ]);
    expect(s.requetes[0]).toMatchObject({ methode: "POST", chemin: "/v1/rerank" });
    expect(s.requetes[0]?.corps).toEqual({
      model: "mon-reranker",
      query: "ma question",
      documents: ["a".repeat(10), "court"],
      top_n: 2,
      return_documents: false,
    });
    expect(s.requetes[0]?.entetes["authorization"]).toBe("Bearer k");
  });

  it("utilise le modèle par défaut et ne fait aucun appel sans document", async () => {
    const { c, s } = await monter(() => ({ json: [{ index: 0, score: 1 }] }));
    expect(await c.classer("q", [])).toEqual([]);
    expect(s.requetes).toHaveLength(0);
    await c.classer("q", ["d"]);
    expect((s.requetes[0]?.corps as { model: string }).model).toBe("bge-reranker-v2-m3");
  });

  it("rend reranker_http sur une erreur HTTP et delai sur un serveur trop lent", async () => {
    const { c } = await monter(() => ({ statut: 500, texte: "modèle absent" }));
    await expect(c.classer("q", ["d"])).rejects.toMatchObject({
      code: "reranker_http",
      statut: 500,
      message: expect.stringContaining("modèle absent"),
    });
    const { c: lent } = await monter(() => ({ json: [], attenteMs: 300 }), { delaiMs: 40 });
    await expect(lent.classer("q", ["d"])).rejects.toMatchObject({ code: "delai" });
  });

  it("rend reranker_injoignable quand rien n'écoute", async () => {
    const c = new ClientReranker({ url: "http://127.0.0.1:1", delaiMs: 500 });
    await expect(c.classer("q", ["d"])).rejects.toMatchObject({ code: "reranker_injoignable" });
  });
});
