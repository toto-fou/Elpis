// SPDX-License-Identifier: MIT
/** packages/rag/test/qdrant.test.ts — client Qdrant contre un faux serveur : corps des requêtes, filtres, erreurs typées, délais et abandon. */
import { afterEach, describe, expect, it } from "vitest";

import { vecteurDocument } from "../src/bm25";
import { decouperTexte } from "../src/decoupage";
import { ErreurRag } from "../src/erreurs";
import { ClientQdrant, construirePoint, filtreQdrant, lireCharge, normaliserExt } from "../src/qdrant";
import type { PointAEcrire } from "../src/qdrant";
import { idPoint } from "../src/uuid";
import { demarrerServeurFaux } from "./serveur-faux";
import type { Gestionnaire, ServeurFaux } from "./serveur-faux";

const serveurs: ServeurFaux[] = [];

async function monter(
  g: Gestionnaire,
  options: { cleApi?: string; delaiMs?: number } = {},
): Promise<{ q: ClientQdrant; s: ServeurFaux }> {
  const s = await demarrerServeurFaux(g);
  serveurs.push(s);
  return { q: new ClientQdrant({ url: `${s.url}/`, ...options }), s };
}

afterEach(async () => {
  await Promise.all(serveurs.splice(0).map((s) => s.arreter()));
});

const OK = { json: { result: true, status: "ok" } };

function point(docId: string, i: number, texte: string): PointAEcrire {
  const [passage] = decouperTexte(texte);
  if (!passage) throw new Error("passage attendu");
  return construirePoint({
    docId,
    relPath: "dossier/fiche.PDF",
    ext: ".PDF",
    passage: { ...passage, chunk_index: i },
    dense: [0.1, 0.2, 0.3],
    creux: vecteurDocument(texte),
  });
}

describe("filtreQdrant", () => {
  it("ne produit aucun filtre sans condition", () => {
    expect(filtreQdrant(undefined)).toBeUndefined();
    expect(filtreQdrant({})).toBeUndefined();
  });

  it("traduit les conditions et normalise les extensions", () => {
    expect(
      filtreQdrant({
        docIds: ["a", "b"],
        relPaths: ["x/y.pdf"],
        exts: [".PDF", "docx"],
        texte: "mot exact",
        chunkMin: 2,
        chunkMax: 9,
        exclureDocIds: ["z"],
      }),
    ).toEqual({
      must: [
        { key: "doc_id", match: { any: ["a", "b"] } },
        { key: "rel_path", match: { any: ["x/y.pdf"] } },
        { key: "ext", match: { any: ["pdf", "docx"] } },
        { key: "text", match: { text: "mot exact" } },
        { key: "chunk_index", range: { gte: 2, lte: 9 } },
      ],
      must_not: [{ key: "doc_id", match: { any: ["z"] } }],
    });
  });

  it("garde une liste vide telle quelle : elle ne retient rien, elle ne lève pas la restriction", () => {
    expect(filtreQdrant({ docIds: [] })).toEqual({ must: [{ key: "doc_id", match: { any: [] } }] });
  });

  it("compresse les indices gardés en plages contiguës", () => {
    expect(filtreQdrant(undefined, [5, 0, 1, 2, 9, 3, 3])).toEqual({
      must_not: [
        { key: "chunk_index", range: { gte: 0, lte: 3 } },
        { key: "chunk_index", range: { gte: 5, lte: 5 } },
        { key: "chunk_index", range: { gte: 9, lte: 9 } },
      ],
    });
  });
});

describe("construirePoint et lireCharge", () => {
  it("construit un point à identifiant stable avec une charge sans chemin absolu", () => {
    const p = point("doc-1", 3, "Un texte à indexer.");
    expect(p.id).toBe(idPoint("doc-1", 3));
    expect(p.charge).toMatchObject({
      doc_id: "doc-1",
      chunk_index: 3,
      rel_path: "dossier/fiche.PDF",
      ext: "pdf",
      text: "Un texte à indexer.",
    });
    expect(Object.keys(p.charge).sort()).toEqual([
      "bbox",
      "char_end",
      "char_start",
      "chunk_hash",
      "chunk_index",
      "doc_id",
      "ext",
      "heading_path",
      "page",
      "rel_path",
      "text",
    ]);
    expect(normaliserExt(" .Docx ")).toBe("docx");
  });

  it("relit une charge incomplète avec des valeurs neutres", () => {
    expect(lireCharge(undefined)).toMatchObject({ doc_id: "", chunk_index: 0, page: null, bbox: [] });
    expect(
      lireCharge({ doc_id: 4, page: 2, bbox: [{ page: 2, rects: [[1, 2, 3, 4], ["x"]] }, "n"] }),
    ).toMatchObject({
      doc_id: "",
      page: 2,
      bbox: [{ page: 2, rects: [[1, 2, 3, 4]] }],
    });
  });
});

describe("collections", () => {
  it("crée la collection avec le dense nommé, le BM25 à IDF et les cinq index", async () => {
    const { q, s } = await monter(() => OK);
    await q.creerCollection("elpis_abc", { dimension: 1024 });
    expect(s.requetes.map((r) => `${r.methode} ${r.chemin}${r.recherche}`)).toEqual([
      "PUT /collections/elpis_abc",
      "PUT /collections/elpis_abc/index?wait=true",
      "PUT /collections/elpis_abc/index?wait=true",
      "PUT /collections/elpis_abc/index?wait=true",
      "PUT /collections/elpis_abc/index?wait=true",
      "PUT /collections/elpis_abc/index?wait=true",
    ]);
    expect(s.requetes[0]?.corps).toEqual({
      vectors: { dense: { size: 1024, distance: "Cosine" } },
      sparse_vectors: { bm25: { modifier: "idf" } },
    });
    expect(s.requetes.slice(1).map((r) => (r.corps as { field_name: string }).field_name)).toEqual([
      "doc_id",
      "rel_path",
      "ext",
      "chunk_index",
      "text",
    ]);
    expect(s.requetes[4]?.corps).toEqual({ field_name: "chunk_index", field_schema: "integer" });
    expect((s.requetes[5]?.corps as { field_schema: { type: string } }).field_schema.type).toBe("text");
  });

  it("signale une collection déjà présente par collection_existe", async () => {
    const { q } = await monter(() => ({
      statut: 409,
      json: { status: { error: "Wrong input: Collection `x` already exists!" } },
    }));
    await expect(q.creerCollection("x", { dimension: 4 })).rejects.toMatchObject({
      code: "collection_existe",
      statut: 409,
    });
  });

  it("refuse une dimension invalide et un nom qui sortirait de l'URL", async () => {
    const { q, s } = await monter(() => OK);
    await expect(q.creerCollection("ok", { dimension: 0 })).rejects.toMatchObject({ code: "parametres" });
    await expect(q.supprimerCollection("../snapshots")).rejects.toMatchObject({ code: "parametres" });
    await expect(q.compter("a/b")).rejects.toMatchObject({ code: "parametres" });
    expect(s.requetes).toHaveLength(0);
  });

  it("lit la dimension et le nombre de points, et signale l'absence", async () => {
    const { q } = await monter((r) =>
      r.chemin.endsWith("/absente")
        ? { statut: 404, json: { status: { error: "Not found" } } }
        : {
            json: {
              result: {
                status: "green",
                points_count: 12,
                config: { params: { vectors: { dense: { size: 768, distance: "Cosine" } } } },
              },
            },
          },
    );
    expect(await q.infoCollection("presente")).toEqual({
      existe: true,
      dimension: 768,
      points: 12,
      statut: "green",
    });
    expect(await q.infoCollection("absente")).toMatchObject({ existe: false, dimension: null, points: 0 });
  });

  it("assurerCollection crée si besoin et refuse une autre dimension", async () => {
    let existe = false;
    const { q, s } = await monter((r) => {
      if (r.methode === "GET") {
        return existe
          ? {
              json: {
                result: {
                  status: "green",
                  points_count: 0,
                  config: { params: { vectors: { dense: { size: 8 } } } },
                },
              },
            }
          : { statut: 404, json: { status: { error: "Not found" } } };
      }
      if (r.methode === "PUT" && r.chemin === "/collections/c") existe = true;
      return OK;
    });
    expect(await q.assurerCollection("c", { dimension: 8 })).toEqual({ creee: true });
    expect(await q.assurerCollection("c", { dimension: 8 })).toEqual({ creee: false });
    await expect(q.assurerCollection("c", { dimension: 16 })).rejects.toMatchObject({
      code: "dimension_differente",
    });
    expect(s.requetes.filter((r) => r.methode === "PUT" && r.chemin === "/collections/c")).toHaveLength(1);
  });

  it("supprime la collection et rend false si elle n'existait plus (result: false ou 404)", async () => {
    const reponses = [
      OK,
      { json: { result: false, status: "ok" } },
      { statut: 404, json: { status: { error: "Not found" } } },
    ];
    let n = 0;
    const { q } = await monter(() => reponses[n++] ?? OK);
    expect(await q.supprimerCollection("c")).toBe(true);
    expect(await q.supprimerCollection("c")).toBe(false);
    expect(await q.supprimerCollection("c")).toBe(false);
  });

  it("liste les collections", async () => {
    const { q } = await monter(() => ({
      json: { result: { collections: [{ name: "a" }, { name: "b" }, { autre: 1 }] } },
    }));
    expect(await q.listerCollections()).toEqual(["a", "b"]);
  });
});

describe("écriture", () => {
  it("insère par lots avec wait=true, un vecteur dense nommé et un BM25 creux", async () => {
    const { q, s } = await monter(() => OK);
    const points = [
      point("d", 0, "Premier passage sur le contrat."),
      point("d", 1, "le la les"),
      point("d", 2, "Troisième"),
    ];
    expect(await q.inserer("elpis_c", points, { tailleLot: 2 })).toBe(3);
    expect(s.requetes.map((r) => `${r.methode} ${r.chemin}${r.recherche}`)).toEqual(
      Array(2).fill("PUT /collections/elpis_c/points?wait=true"),
    );
    const lot1 = (
      s.requetes[0]?.corps as {
        points: { id: string; vector: Record<string, unknown>; payload: { chunk_index: number } }[];
      }
    ).points;
    expect(lot1.map((p) => p.payload.chunk_index)).toEqual([0, 1]);
    expect(Object.keys(lot1[0]?.vector ?? {})).toEqual(["dense", "bm25"]);
    expect(lot1[0]?.vector["dense"]).toEqual([0.1, 0.2, 0.3]);
    expect(Object.keys(lot1[1]?.vector ?? {})).toEqual(["dense"]);
    expect(lot1[0]?.id).toBe(idPoint("d", 0));
  });

  it("ne fait aucun appel pour une liste vide", async () => {
    const { q, s } = await monter(() => OK);
    expect(await q.inserer("c", [])).toBe(0);
    expect(s.requetes).toHaveLength(0);
  });

  it("supprime les passages d'un document sauf ceux gardés", async () => {
    const { q, s } = await monter(() => OK);
    await q.supprimerDocument("c", "doc-1", { sauf: [0, 1, 2, 3] });
    expect(s.requetes[0]).toMatchObject({
      methode: "POST",
      chemin: "/collections/c/points/delete",
      recherche: "?wait=true",
    });
    expect(s.requetes[0]?.corps).toEqual({
      filter: {
        must: [{ key: "doc_id", match: { any: ["doc-1"] } }],
        must_not: [{ key: "chunk_index", range: { gte: 0, lte: 3 } }],
      },
    });
    await q.supprimerDocument("c", "doc-1");
    expect(s.requetes[1]?.corps).toEqual({
      filter: { must: [{ key: "doc_id", match: { any: ["doc-1"] } }] },
    });
    await q.supprimerDocument("c", ["doc-1", "doc-2"]);
    expect(s.requetes[2]?.corps).toEqual({
      filter: { must: [{ key: "doc_id", match: { any: ["doc-1", "doc-2"] } }] },
    });
  });

  it("traduit un refus de dimension et une erreur Qdrant en erreurs typées", async () => {
    const { q } = await monter((r) =>
      r.chemin.endsWith("/points")
        ? {
            statut: 400,
            json: { status: { error: "Wrong input: Vector dimension error: expected dim: 4, got 3" } },
          }
        : { statut: 500, texte: "boum" },
    );
    await expect(q.inserer("c", [point("d", 0, "x y")])).rejects.toMatchObject({
      code: "dimension_differente",
      statut: 400,
    });
    await expect(q.supprimerDocument("c", "d")).rejects.toMatchObject({
      code: "qdrant_http",
      statut: 500,
      message: expect.stringContaining("boum"),
    });
  });
});

describe("requêtes", () => {
  const reponse = {
    json: {
      result: {
        points: [
          {
            id: "p1",
            score: 0.9,
            payload: { doc_id: "d", chunk_index: 1, text: "Un", heading_path: "A" },
            vector: { dense: [1, 0] },
          },
          { id: "p2", score: 0.4, payload: { doc_id: "d", chunk_index: 2, text: "Deux" } },
          { sansId: true },
        ],
      },
    },
  };

  it("dense : requête sur le vecteur nommé, filtre au niveau de la requête", async () => {
    const { q, s } = await monter(() => reponse);
    const pts = await q.interroger(
      "c",
      { mode: "dense", vecteur: [1, 0] },
      { limite: 5, filtre: { docIds: ["d"] }, avecVecteur: true },
    );
    expect(s.requetes[0]?.corps).toEqual({
      query: [1, 0],
      using: "dense",
      limit: 5,
      filter: { must: [{ key: "doc_id", match: { any: ["d"] } }] },
      with_payload: true,
      with_vector: ["dense"],
    });
    expect(pts.map((p) => [p.id, p.score, p.charge.chunk_index])).toEqual([
      ["p1", 0.9, 1],
      ["p2", 0.4, 2],
    ]);
    expect(pts[0]?.vecteur).toEqual([1, 0]);
    expect(pts[1]?.vecteur).toBeUndefined();
  });

  it("creux : requête sur le vecteur bm25 ; une requête vide ne touche pas le réseau", async () => {
    const { q, s } = await monter(() => reponse);
    await q.interroger("c", { mode: "creux", creux: { indices: [3, 9], values: [1, 1] } }, { limite: 3 });
    expect(s.requetes[0]?.corps).toMatchObject({
      query: { indices: [3, 9], values: [1, 1] },
      using: "bm25",
      limit: 3,
      with_vector: false,
    });
    expect(
      await q.interroger("c", { mode: "creux", creux: { indices: [], values: [] } }, { limite: 3 }),
    ).toEqual([]);
    expect(s.requetes).toHaveLength(1);
  });

  it("mixte : deux branches avec le filtre, fusion RRF (k=60 ou réglage par défaut)", async () => {
    const { q, s } = await monter(() => reponse);
    const creux = { indices: [1], values: [1] };
    await q.interroger(
      "c",
      { mode: "mixte", vecteur: [1, 0], creux },
      { limite: 10, filtre: { exts: ["pdf"] }, prefetch: 40 },
    );
    const filtre = { must: [{ key: "ext", match: { any: ["pdf"] } }] };
    expect(s.requetes[0]?.corps).toEqual({
      prefetch: [
        { query: [1, 0], using: "dense", limit: 40, filter: filtre },
        { query: creux, using: "bm25", limit: 40, filter: filtre },
      ],
      query: { rrf: { k: 60 } },
      limit: 10,
      with_payload: true,
      with_vector: false,
    });
    await q.interroger("c", { mode: "mixte", vecteur: [1, 0], creux }, { limite: 10, fusionK: null });
    expect((s.requetes[1]?.corps as { query: unknown }).query).toEqual({ fusion: "rrf" });
  });

  it("mixte avec une requête creuse vide se réduit au dense", async () => {
    const { q, s } = await monter(() => reponse);
    await q.interroger(
      "c",
      { mode: "mixte", vecteur: [0, 1], creux: { indices: [], values: [] } },
      { limite: 4 },
    );
    expect(s.requetes[0]?.corps).toMatchObject({ query: [0, 1], using: "dense" });
    expect(s.requetes[0]?.corps).not.toHaveProperty("prefetch");
  });

  it("parcourt les passages dans l'ordre de chunk_index, page par page", async () => {
    const pages = [[0, 1, 2], [3, 4, 5], [6]];
    let n = 0;
    const { q, s } = await monter(() => ({
      json: {
        result: {
          points: (pages[n++] ?? []).map((i) => ({
            id: `p${i}`,
            payload: { doc_id: "d", chunk_index: i, text: `t${i}` },
          })),
        },
      },
    }));
    const lus: number[] = [];
    for await (const page of q.parcourirDocument("c", "d", { taillePage: 3 }))
      lus.push(...page.map((p) => p.charge.chunk_index));
    expect(lus).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(
      s.requetes.map((r) => (r.corps as { order_by: { start_from: number } }).order_by.start_from),
    ).toEqual([0, 3, 6]);
    expect(s.requetes[0]?.corps).toMatchObject({
      limit: 3,
      order_by: { key: "chunk_index", direction: "asc" },
      filter: { must: [{ key: "doc_id", match: { any: ["d"] } }] },
    });
  });

  it("compte les points avec un filtre", async () => {
    const { q, s } = await monter(() => ({ json: { result: { count: 7 } } }));
    expect(await q.compter("c", { docIds: ["d"] })).toBe(7);
    expect(s.requetes[0]?.corps).toEqual({
      exact: true,
      filter: { must: [{ key: "doc_id", match: { any: ["d"] } }] },
    });
  });
});

describe("santé, authentification, pannes", () => {
  it("rend la version quand le serveur est prêt et l'erreur sinon, sans lever", async () => {
    const { q } = await monter((r) =>
      r.chemin === "/readyz"
        ? { texte: "all shards are ready" }
        : { json: { title: "qdrant", version: "1.16.3" } },
    );
    expect(await q.sante()).toEqual({ ok: true, version: "1.16.3" });
    const { q: mort } = await monter((r) =>
      r.chemin === "/readyz" ? { statut: 503, texte: "starting" } : { json: { version: "1.16.3" } },
    );
    expect(await mort.sante()).toMatchObject({
      ok: false,
      version: "1.16.3",
      erreur: expect.stringContaining("non prêt"),
    });
    const hs = new ClientQdrant({ url: "http://127.0.0.1:1", delaiMs: 500 });
    expect(await hs.sante()).toMatchObject({ ok: false });
  });

  it("envoie la clé d'API en en-tête api-key", async () => {
    const { q, s } = await monter(() => ({ json: { result: { count: 0 } } }), { cleApi: "secret" });
    await q.compter("c");
    expect(s.requetes[0]?.entetes["api-key"]).toBe("secret");
  });

  it("rend qdrant_injoignable quand rien n'écoute", async () => {
    const q = new ClientQdrant({ url: "http://127.0.0.1:1", delaiMs: 1000 });
    await expect(q.compter("c")).rejects.toMatchObject({ code: "qdrant_injoignable" });
  });

  it("rend delai quand le serveur est trop lent", async () => {
    const { q } = await monter(() => ({ json: { result: { count: 1 } }, attenteMs: 400 }), { delaiMs: 50 });
    const e = await q.compter("c").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ErreurRag);
    expect(e).toMatchObject({ code: "delai" });
  });

  it("relance l'abandon de l'appelant tel quel", async () => {
    const { q } = await monter(() => ({ json: { result: { count: 1 } }, attenteMs: 400 }));
    const ctl = new AbortController();
    const attente = q.compter("c", undefined, ctl.signal);
    setTimeout(() => ctl.abort(new Error("stop")), 30);
    await expect(attente).rejects.toThrow("stop");
  });
});
