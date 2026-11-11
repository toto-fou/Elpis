// SPDX-License-Identifier: MIT
/** packages/rag/test/recherche.test.ts — recherche multi-collections avec des clients à fetch simulé : modes, RRF, erreurs par collection, quasi-doublons, seuil, reclassement, budget. */
import { describe, expect, it } from "vitest";

import { ClientEmbeddings } from "../src/embeddings";
import { ClientQdrant } from "../src/qdrant";
import { cosinus, fusionnerRrf, rechercher, retirerQuasiDoublons, seuilAdaptatif } from "../src/recherche";
import type { CollectionCible, ParamsRecherche } from "../src/recherche";
import { ClientReranker } from "../src/reranker";

interface Appel {
  url: string;
  corps: Record<string, unknown>;
}

interface PointSimule {
  id: string;
  score: number;
  text: string;
  vecteur?: number[];
}

type Sortie = PointSimule[] | { statut: number; message: string } | { lent: number };

function reponse(statut: number, json: unknown): Response {
  return new Response(JSON.stringify(json), {
    status: statut,
    headers: { "content-type": "application/json" },
  });
}

function attendre(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason as unknown)), {
      once: true,
    });
  });
}

/** Qdrant simulé : réponse par collection, appels enregistrés, pic de requêtes simultanées. */
function fauxQdrant(sorties: Record<string, Sortie>): {
  client: ClientQdrant;
  appels: Appel[];
  pic: () => number;
} {
  const appels: Appel[] = [];
  let enCours = 0;
  let pic = 0;
  const fetchSimule = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    const corps = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    appels.push({ url: u, corps });
    enCours++;
    pic = Math.max(pic, enCours);
    try {
      const nom = /\/collections\/([^/]+)\/points\/query/.exec(u)?.[1] ?? "";
      const sortie = sorties[nom] ?? [];
      if (!Array.isArray(sortie)) {
        if ("lent" in sortie) {
          await attendre(sortie.lent, init?.signal);
          return reponse(200, { result: { points: [] } });
        }
        return reponse(sortie.statut, { status: { error: sortie.message } });
      }
      await attendre(5, init?.signal);
      const avecVecteurs = JSON.stringify(corps["with_vector"]) !== "false";
      return reponse(200, {
        result: {
          points: sortie.map((p) => ({
            id: p.id,
            score: p.score,
            payload: { doc_id: `doc-${p.id}`, chunk_index: 0, text: p.text },
            ...(avecVecteurs && p.vecteur ? { vector: { dense: p.vecteur } } : {}),
          })),
        },
      });
    } finally {
      enCours--;
    }
  };
  return {
    client: new ClientQdrant({ url: "http://qdrant.test", fetch: fetchSimule }),
    appels,
    pic: () => pic,
  };
}

function fauxEmbeddings(options: { echec?: number } = {}): { client: ClientEmbeddings; appels: string[] } {
  const appels: string[] = [];
  const fetchSimule = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const { input } = JSON.parse(String(init?.body)) as { input: string[] };
    appels.push(...input);
    if (options.echec) return Promise.resolve(reponse(options.echec, { error: "indisponible" }));
    return Promise.resolve(
      reponse(200, { data: input.map((_, index) => ({ index, embedding: [1, 0, 0] })) }),
    );
  };
  return {
    client: new ClientEmbeddings({
      url: "http://embed.test",
      modele: "m",
      fetch: fetchSimule,
      reprises: 0,
      attendre: () => Promise.resolve(),
    }),
    appels,
  };
}

function pt(id: string, score: number, text = `texte ${id}${id}${id}`, vecteur?: number[]): PointSimule {
  return vecteur ? { id, score, text, vecteur } : { id, score, text };
}

const A: CollectionCible<{ nom: string }> = { id: "ca", nomQdrant: "elpis_a", meta: { nom: "Alice" } };
const B: CollectionCible<{ nom: string }> = { id: "cb", nomQdrant: "elpis_b", meta: { nom: "Bob" } };

function base(
  q: ClientQdrant,
  e: ClientEmbeddings | undefined,
  plus: Partial<ParamsRecherche<{ nom: string }>> = {},
): ParamsRecherche<{ nom: string }> {
  return { qdrant: q, embeddings: e, collections: [A], requete: "renouvellement du contrat", ...plus };
}

describe("fonctions pures", () => {
  it("seuilAdaptatif : max(base, 0,6 × meilleur) sauf scores groupés", () => {
    expect(seuilAdaptatif([], 0.25)).toBe(0.25);
    expect(seuilAdaptatif([0.8, 0.3, 0.2], 0.25)).toBeCloseTo(0.48, 12);
    expect(seuilAdaptatif([0.3, 0.2, 0.1], 0.25)).toBe(0.25);
    expect(seuilAdaptatif([0.55, 0.54, 0.53], 0.25)).toBe(0.25);
    expect(seuilAdaptatif([0.9, 0.1], 0.6)).toBeCloseTo(0.6, 12);
  });

  it("cosinus : 1 pour des vecteurs colinéaires, 0 pour orthogonaux, nul ou de tailles différentes", () => {
    expect(cosinus([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
    expect(cosinus([1, 0], [0, 1])).toBe(0);
    expect(cosinus([0, 0], [1, 1])).toBe(0);
    expect(cosinus([1], [1, 2])).toBe(0);
  });

  it("fusionnerRrf : somme de 1/(k+rang), égalités par meilleur rang puis par liste", () => {
    const r = fusionnerRrf(
      [
        ["a", "b", "c"],
        ["b", "d"],
      ],
      (x) => x,
      60,
    );
    expect(r.map((x) => x.item)).toEqual(["b", "a", "d", "c"]);
    expect(r[0]?.score).toBeCloseTo(1 / 62 + 1 / 61, 12);
    const disjoint = fusionnerRrf(
      [
        ["a1", "a2"],
        ["b1", "b2"],
      ],
      (x) => x,
    );
    expect(disjoint.map((x) => x.item)).toEqual(["a1", "b1", "a2", "b2"]);
  });

  it("retirerQuasiDoublons : vecteurs denses si présents, mots sinon, premier gardé", () => {
    const items = [
      { charge: { text: "alpha" }, vecteur: [1, 0] },
      { charge: { text: "beta" }, vecteur: [0.99, 0.05] },
      { charge: { text: "gamma" }, vecteur: [0, 1] },
    ];
    expect(retirerQuasiDoublons(items).map((x) => x.charge.text)).toEqual(["alpha", "gamma"]);
    expect(retirerQuasiDoublons(items, 0.9999).map((x) => x.charge.text)).toEqual(["alpha", "beta", "gamma"]);
    const autresDimensions = [
      { charge: { text: "Le renouvellement du contrat est automatique chaque année." }, vecteur: [1, 0] },
      { charge: { text: "Le renouvellement du contrat est automatique chaque année." }, vecteur: [1, 0, 0] },
    ];
    expect(retirerQuasiDoublons(autresDimensions)).toHaveLength(1);
    const textes = [
      { charge: { text: "Le renouvellement du contrat est automatique chaque année." } },
      { charge: { text: "Le renouvellement du contrat est automatique chaque année !" } },
      { charge: { text: "Tout autre sujet sans rapport avec la précédente phrase." } },
    ];
    expect(retirerQuasiDoublons(textes)).toHaveLength(2);
  });
});

describe("modes et une collection", () => {
  it("mixte : un embedding, une requête à deux branches, passages numérotés avec la méta de la collection", async () => {
    const q = fauxQdrant({ elpis_a: [pt("p1", 0.03), pt("p2", 0.02), pt("p3", 0.01)] });
    const e = fauxEmbeddings();
    const r = await rechercher(base(q.client, e.client, { limite: 2 }));
    expect(e.appels).toEqual(["renouvellement du contrat"]);
    expect(q.appels).toHaveLength(1);
    const corps = q.appels[0]?.corps as { prefetch: { using: string }[]; query: unknown; limit: number };
    expect(corps.prefetch.map((b) => b.using)).toEqual(["dense", "bm25"]);
    expect(corps.query).toEqual({ rrf: { k: 60 } });
    expect(corps.limit).toBe(20);
    expect(r.mode).toBe("mixte");
    expect(r.passages.map((p) => [p.rang, p.idPoint, p.collection.meta?.nom])).toEqual([
      [1, "p1", "Alice"],
      [2, "p2", "Alice"],
    ]);
    expect(r.passages[0]).toMatchObject({ score: 0.03, charge: { text: "texte p1p1p1" } });
    expect(r.passages[0]).not.toHaveProperty("vecteur");
    expect(r.passages[0]).not.toHaveProperty("scoreFusion");
    expect(r.erreurs).toEqual([]);
    expect(r.avertissements).toEqual([]);
  });

  it("sens : requête dense seule et seuil adaptatif sur les cosinus", async () => {
    const q = fauxQdrant({ elpis_a: [pt("p1", 0.8), pt("p2", 0.7), pt("p3", 0.3), pt("p4", 0.2)] });
    const e = fauxEmbeddings();
    const r = await rechercher(base(q.client, e.client, { mode: "sens", limite: 10 }));
    expect(q.appels[0]?.corps).toMatchObject({ using: "dense", query: [1, 0, 0] });
    expect(r.passages.map((p) => p.idPoint)).toEqual(["p1", "p2"]);
    const base2 = await rechercher(base(q.client, e.client, { mode: "sens", limite: 10, seuilBase: 0.1 }));
    expect(base2.passages.map((p) => p.idPoint)).toEqual(["p1", "p2"]);
    const plat = fauxQdrant({ elpis_a: [pt("p1", 0.35), pt("p2", 0.34), pt("p3", 0.3)] });
    const r3 = await rechercher(base(plat.client, e.client, { mode: "sens" }));
    expect(r3.passages).toHaveLength(3);
  });

  it("mots : requête creuse sans aucun embedding, et sans client d'embeddings", async () => {
    const q = fauxQdrant({ elpis_a: [pt("p1", 4.2)] });
    const r = await rechercher(base(q.client, undefined, { mode: "mots" }));
    expect(q.appels[0]?.corps).toMatchObject({
      using: "bm25",
      query: { indices: expect.any(Array), values: [1, 1] },
    });
    expect(r.mode).toBe("mots");
    expect(r.passages).toHaveLength(1);
  });

  it("exige un client d'embeddings hors du mode mots", async () => {
    const q = fauxQdrant({});
    await expect(rechercher(base(q.client, undefined, { mode: "mixte" }))).rejects.toMatchObject({
      code: "parametres",
    });
  });

  it("mixte : si l'embedding échoue, repasse en mots avec un avertissement ; sens : une erreur par collection", async () => {
    const q = fauxQdrant({ elpis_a: [pt("p1", 1)] });
    const e = fauxEmbeddings({ echec: 503 });
    const r = await rechercher(base(q.client, e.client));
    expect(r.mode).toBe("mots");
    expect(r.passages).toHaveLength(1);
    expect(r.avertissements).toHaveLength(1);
    expect(r.avertissements[0]).toContain("embeddings indisponibles");
    expect(q.appels[0]?.corps).toMatchObject({ using: "bm25" });
    const sens = await rechercher(base(q.client, e.client, { mode: "sens" }));
    expect(sens.passages).toEqual([]);
    expect(sens.mode).toBe("sens");
    expect(sens.erreurs).toEqual([
      expect.objectContaining({ collection: expect.objectContaining({ id: "ca" }), code: "embeddings_http" }),
    ]);
    expect(q.appels).toHaveLength(1);
  });

  it("un client d'embeddings propre à une collection : un vecteur par client, repli par collection", async () => {
    const q = fauxQdrant({ elpis_a: [pt("a1", 1)], elpis_b: [pt("b1", 1)] });
    const bon = fauxEmbeddings();
    const autre = fauxEmbeddings();
    const hs = fauxEmbeddings({ echec: 500 });
    const r = await rechercher(
      base(q.client, bon.client, { collections: [A, { ...B, embeddings: autre.client }], mode: "sens" }),
    );
    expect(bon.appels).toHaveLength(1);
    expect(autre.appels).toHaveLength(1);
    expect(r.passages.map((x) => x.idPoint).sort()).toEqual(["a1", "b1"]);
    const mixte = await rechercher(
      base(q.client, bon.client, { collections: [A, { ...B, embeddings: hs.client }], mode: "mixte" }),
    );
    expect(mixte.mode).toBe("mixte");
    expect(mixte.avertissements).toHaveLength(1);
    const corps = q.appels.slice(-2).map((a) => a.corps);
    expect(corps.map((c) => ("prefetch" in c ? "mixte" : c["using"]))).toEqual(["mixte", "bm25"]);
    const partiel = await rechercher(
      base(q.client, bon.client, { collections: [A, { ...B, embeddings: hs.client }], mode: "sens" }),
    );
    expect(partiel.passages.map((x) => x.idPoint)).toEqual(["a1"]);
    expect(partiel.erreurs.map((x) => x.collection.id)).toEqual(["cb"]);
  });

  it("rend un résultat vide sans appel pour une requête vide ou sans collection", async () => {
    const q = fauxQdrant({});
    const e = fauxEmbeddings();
    expect((await rechercher(base(q.client, e.client, { requete: "   " }))).passages).toEqual([]);
    expect((await rechercher(base(q.client, e.client, { collections: [] }))).passages).toEqual([]);
    expect(q.appels).toHaveLength(0);
    expect(e.appels).toHaveLength(0);
  });

  it("transmet les filtres communs, ceux d'une collection les remplacent, et demande les vecteurs pour les quasi-doublons", async () => {
    const q = fauxQdrant({});
    const e = fauxEmbeddings();
    await rechercher(
      base(q.client, e.client, {
        collections: [A, { ...B, filtre: { docIds: ["x"] } }],
        filtres: { exts: ["pdf"] },
        mode: "sens",
      }),
    );
    const filtres = q.appels.map((a) => a.corps["filter"]);
    expect(filtres).toEqual([
      { must: [{ key: "ext", match: { any: ["pdf"] } }] },
      { must: [{ key: "doc_id", match: { any: ["x"] } }] },
    ]);
    expect(q.appels.every((a) => JSON.stringify(a.corps["with_vector"]) === '["dense"]')).toBe(true);
    await rechercher(base(q.client, e.client, { mode: "sens", quasiDoublons: false }));
    expect(q.appels[2]?.corps["with_vector"]).toBe(false);
  });
});

describe("plusieurs collections", () => {
  it("interroge les collections en parallèle avec un seul embedding et fusionne par RRF (k=60)", async () => {
    const q = fauxQdrant({
      elpis_a: [pt("a1", 0.9), pt("a2", 0.8), pt("a3", 0.7)],
      elpis_b: [pt("b1", 5), pt("b2", 4)],
    });
    const e = fauxEmbeddings();
    const r = await rechercher(base(q.client, e.client, { collections: [A, B], limite: 10, mode: "mots" }));
    expect(q.pic()).toBe(2);
    expect(r.passages.map((p) => p.idPoint)).toEqual(["a1", "b1", "a2", "b2", "a3"]);
    expect(r.passages.map((p) => p.collection.meta?.nom)).toEqual(["Alice", "Bob", "Alice", "Bob", "Alice"]);
    expect(r.passages[1]?.scoreFusion).toBeCloseTo(1 / 61, 12);
    expect(r.passages[1]?.score).toBe(5);
    const mixte = await rechercher(base(q.client, e.client, { collections: [A, B] }));
    expect(e.appels).toEqual(["renouvellement du contrat"]);
    expect(mixte.passages).toHaveLength(5);
  });

  it("signale la collection en erreur sans casser les autres", async () => {
    const q = fauxQdrant({
      elpis_a: [pt("a1", 1)],
      elpis_b: { statut: 404, message: "Not found: Collection `elpis_b` doesn't exist!" },
    });
    const r = await rechercher(base(q.client, undefined, { collections: [A, B], mode: "mots" }));
    expect(r.passages.map((p) => p.idPoint)).toEqual(["a1"]);
    expect(r.erreurs).toHaveLength(1);
    expect(r.erreurs[0]).toMatchObject({
      collection: { id: "cb" },
      code: "collection_absente",
      message: expect.stringContaining("doesn't exist"),
    });
  });

  it("rend toutes les erreurs et aucun passage quand toutes les collections échouent", async () => {
    const q = fauxQdrant({
      elpis_a: { statut: 500, message: "boum" },
      elpis_b: { statut: 500, message: "boum" },
    });
    const r = await rechercher(base(q.client, undefined, { collections: [A, B], mode: "mots" }));
    expect(r.passages).toEqual([]);
    expect(r.erreurs.map((x) => x.code)).toEqual(["qdrant_http", "qdrant_http"]);
  });
});

describe("quasi-doublons, reclassement, budget", () => {
  it("retire les quasi-doublons avant de limiter, sauf si c'est désactivé", async () => {
    const q = fauxQdrant({
      elpis_a: [pt("p1", 3, "a", [1, 0]), pt("p2", 2, "b", [0.99, 0.02]), pt("p3", 1, "c", [0, 1])],
    });
    const e = fauxEmbeddings();
    const r = await rechercher(base(q.client, e.client, { limite: 3 }));
    expect(r.passages.map((p) => p.idPoint)).toEqual(["p1", "p3"]);
    const tout = await rechercher(base(q.client, e.client, { limite: 3, quasiDoublons: false }));
    expect(tout.passages).toHaveLength(3);
    const seuil = await rechercher(base(q.client, e.client, { limite: 3, quasiDoublons: { seuil: 0.9999 } }));
    expect(seuil.passages).toHaveLength(3);
    const gardes = await rechercher(base(q.client, e.client, { limite: 1, garderVecteurs: true }));
    expect(gardes.passages[0]?.vecteur).toEqual([1, 0]);
  });

  function fauxReranker(scores: Record<string, number> | "erreur" | "vide"): {
    client: ClientReranker;
    appels: { documents: string[]; top_n: number }[];
  } {
    const appels: { documents: string[]; top_n: number }[] = [];
    const fetchSimule = (_u: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const corps = JSON.parse(String(init?.body)) as { documents: string[]; top_n: number };
      appels.push(corps);
      if (scores === "erreur") return Promise.resolve(reponse(500, { error: "hs" }));
      if (scores === "vide") return Promise.resolve(reponse(200, { results: [] }));
      const liste = corps.documents.map((d, index) => ({ index, relevance_score: scores[d] ?? 0 }));
      return Promise.resolve(
        reponse(200, {
          results: liste.sort((a, b) => b.relevance_score - a.relevance_score).slice(0, corps.top_n),
        }),
      );
    };
    return { client: new ClientReranker({ url: "http://rerank.test", fetch: fetchSimule }), appels };
  }

  it("reclasse les candidats et rend les meilleurs avec leur score de reclassement", async () => {
    const q = fauxQdrant({ elpis_a: [pt("p1", 3, "un"), pt("p2", 2, "deux"), pt("p3", 1, "trois")] });
    const e = fauxEmbeddings();
    const rr = fauxReranker({ trois: 0.9, un: 0.5, deux: 0.1 });
    const r = await rechercher(base(q.client, e.client, { limite: 2, reranker: { client: rr.client } }));
    expect(rr.appels[0]).toMatchObject({ documents: ["un", "deux", "trois"], top_n: 2 });
    expect(r.passages.map((p) => [p.idPoint, p.scoreReclassement, p.rang])).toEqual([
      ["p3", 0.9, 1],
      ["p1", 0.5, 2],
    ]);
    expect(r.passages[0]?.score).toBe(1);
    const minimum = await rechercher(
      base(q.client, e.client, { limite: 3, reranker: { client: rr.client, scoreMin: 0.4 } }),
    );
    expect(minimum.passages.map((p) => p.idPoint)).toEqual(["p3", "p1"]);
  });

  it("garde l'ordre d'origine, avec un avertissement, si le reclassement échoue ou si tout est sous le minimum", async () => {
    const q = fauxQdrant({ elpis_a: [pt("p1", 3, "un"), pt("p2", 2, "deux")] });
    const e = fauxEmbeddings();
    const hs = await rechercher(
      base(q.client, e.client, { reranker: { client: fauxReranker("erreur").client } }),
    );
    expect(hs.passages.map((p) => p.idPoint)).toEqual(["p1", "p2"]);
    expect(hs.avertissements[0]).toContain("reclassement indisponible");
    const vide = await rechercher(
      base(q.client, e.client, { reranker: { client: fauxReranker("vide").client } }),
    );
    expect(vide.avertissements).toHaveLength(1);
    const bas = await rechercher(
      base(q.client, e.client, {
        reranker: { client: fauxReranker({ un: 0.1, deux: 0.2 }).client, scoreMin: 0.9 },
      }),
    );
    expect(bas.passages.map((p) => p.idPoint)).toEqual(["p1", "p2"]);
    expect(bas.avertissements[0]).toContain("sous le minimum");
  });

  it("ne reclasse pas un seul candidat", async () => {
    const q = fauxQdrant({ elpis_a: [pt("p1", 3, "un")] });
    const rr = fauxReranker({});
    await rechercher(base(q.client, fauxEmbeddings().client, { reranker: { client: rr.client } }));
    expect(rr.appels).toHaveLength(0);
  });

  it("respecte le budget de temps : la collection lente est en erreur, les autres répondent", async () => {
    const q = fauxQdrant({ elpis_a: [pt("a1", 1)], elpis_b: { lent: 20_000 } });
    const debut = Date.now();
    const r = await rechercher(
      base(q.client, undefined, { collections: [A, B], mode: "mots", budgetMs: 600 }),
    );
    expect(Date.now() - debut).toBeLessThan(2000);
    expect(r.passages.map((p) => p.idPoint)).toEqual(["a1"]);
    expect(r.erreurs).toEqual([
      expect.objectContaining({ collection: expect.objectContaining({ id: "cb" }), code: "delai" }),
    ]);
  });

  it("signale delai par collection quand le budget expire pendant l'embedding en mode sens", async () => {
    const q = fauxQdrant({});
    const lent = new ClientEmbeddings({
      url: "http://embed.test",
      modele: "m",
      reprises: 0,
      fetch: async (_u, init) => {
        await attendre(5000, init?.signal);
        return reponse(200, {});
      },
    });
    const r = await rechercher(base(q.client, lent, { mode: "sens", budgetMs: 100 }));
    expect(r.passages).toEqual([]);
    expect(r.erreurs.map((e) => e.code)).toEqual(["delai"]);
    expect(q.appels).toHaveLength(0);
  });

  it("relance l'abandon de l'appelant", async () => {
    const q = fauxQdrant({ elpis_a: { lent: 5000 } });
    const ctl = new AbortController();
    const attente = rechercher(base(q.client, undefined, { mode: "mots", signal: ctl.signal }));
    setTimeout(() => ctl.abort(new Error("stop")), 50);
    await expect(attente).rejects.toThrow("stop");
  });
});
