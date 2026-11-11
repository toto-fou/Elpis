// SPDX-License-Identifier: MIT
/** packages/rag/test/qdrant-reel.test.ts — intégration contre un VRAI Qdrant (binaire `ELPIS_QDRANT_BIN`, port libre, stockage temporaire) ; sauté sans la variable. */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hacherToken, texteBm25, tokeniser, vecteurDocument } from "../src/bm25";
import { decouper } from "../src/decoupage";
import type { Bloc, ParamsDecoupage } from "../src/decoupage";
import { ClientEmbeddings, texteAvecContexte } from "../src/embeddings";
import { ClientQdrant, construirePoint } from "../src/qdrant";
import { rechercher } from "../src/recherche";
import type { CollectionCible } from "../src/recherche";
import { ClientReranker } from "../src/reranker";
import { demarrerServeurFaux } from "./serveur-faux";
import type { ServeurFaux } from "./serveur-faux";

const BINAIRE = process.env["ELPIS_QDRANT_BIN"];
const DIMENSION = 128;
const COL = "elpis_test_a";
const COL_B = "elpis_test_b";

const CONCEPTS: Record<string, string> = {
  resilier: "c:fin",
  resiliation: "c:fin",
  rupture: "c:fin",
  fin: "c:fin",
  abonnement: "c:fin",
  renouvellement: "c:renouv",
  reconduction: "c:renouv",
};

/** « Embedding » de test : sac de concepts haché, normalisé ; les synonymes partagent une dimension (proximité de sens sans mot commun). */
function embed(texte: string): number[] {
  const v = new Array<number>(DIMENSION).fill(0);
  for (const t of tokeniser(texte)) {
    const i = hacherToken(CONCEPTS[t] ?? t) % DIMENSION;
    v[i] = (v[i] ?? 0) + 1;
  }
  const norme = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norme);
}

/** Deux ports libres distincts (les deux écouteurs sont ouverts en même temps, puis fermés). */
async function portsLibres(): Promise<[number, number]> {
  const ecouteurs = await Promise.all(
    [0, 1].map(
      () =>
        new Promise<Server>((resolve, reject) => {
          const s = createServer();
          s.once("error", reject);
          s.listen(0, "127.0.0.1", () => resolve(s));
        }),
    ),
  );
  const [a, b] = ecouteurs.map((s) => (s.address() as { port: number }).port);
  await Promise.all(ecouteurs.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  return [a ?? 0, b ?? 0];
}

const PARAMS: Partial<ParamsDecoupage> = { caracteresParJeton: 1, tailleJetons: 70, chevauchementJetons: 0 };

const CONTRAT: Bloc[] = [
  { kind: "heading", text: "Contrat", level: 1, page: 1 },
  {
    kind: "paragraph",
    text: "Le renouvellement du contrat est automatique chaque année.",
    page: 1,
    boxes: [[10, 10, 200, 30]],
  },
  {
    kind: "paragraph",
    text: "La rupture ou la fin anticipée doit être notifiée par courrier.",
    page: 2,
    boxes: [[10, 40, 200, 60]],
  },
  { kind: "paragraph", text: "Les tarifs sont révisés selon l'indice Syntec.", page: 2 },
  { kind: "paragraph", text: "Référence ZX-4471 : annexe technique du matériel.", page: 3 },
];

const GUIDE: Bloc[] = [
  { kind: "heading", text: "Guide", level: 1 },
  { kind: "paragraph", text: "Pour mettre fin à un abonnement, ouvrez les paramètres." },
  { kind: "paragraph", text: "Le thé vert se conserve à l'abri de la lumière." },
];

describe.skipIf(!BINAIRE)("Qdrant réel", () => {
  let dossier = "";
  let processus: ChildProcess | undefined;
  let journal = "";
  let q: ClientQdrant;
  let emb: ClientEmbeddings;
  let serveurEmb: ServeurFaux;
  let serveurRerank: ServeurFaux;
  let rerank: ClientReranker;
  const A: CollectionCible<string> = { id: "a", nomQdrant: COL, meta: "A" };
  const B: CollectionCible<string> = { id: "b", nomQdrant: COL_B, meta: "B" };

  async function indexer(
    nom: string,
    docId: string,
    relPath: string,
    blocs: readonly Bloc[],
    ordre?: (n: number) => number[],
  ) {
    const passages = decouper(blocs, PARAMS);
    const textes = passages.map((p) =>
      texteAvecContexte({ document: relPath, heading_path: p.heading_path, text: p.text }),
    );
    const denses = await emb.embedder(textes);
    const points = passages.map((p, i) =>
      construirePoint({
        docId,
        relPath,
        ext: path.extname(relPath),
        passage: p,
        dense: denses[i] ?? [],
        creux: vecteurDocument(texteBm25(p)),
      }),
    );
    const rang = ordre ? ordre(points.length) : points.map((_, i) => i);
    await q.inserer(
      nom,
      rang.flatMap((i) => (points[i] ? [points[i]] : [])),
    );
    return passages;
  }

  beforeAll(async () => {
    dossier = mkdtempSync(path.join(tmpdir(), "elpis-qdrant-test-"));
    mkdirSync(path.join(dossier, "storage"));
    const [http, grpc] = await portsLibres();
    processus = spawn(BINAIRE as string, [], {
      cwd: dossier,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        QDRANT__SERVICE__HOST: "127.0.0.1",
        QDRANT__SERVICE__HTTP_PORT: String(http),
        QDRANT__SERVICE__GRPC_PORT: String(grpc),
        QDRANT__STORAGE__STORAGE_PATH: path.join(dossier, "storage"),
        QDRANT__STORAGE__SNAPSHOTS_PATH: path.join(dossier, "snapshots"),
        QDRANT__TELEMETRY_DISABLED: "true",
      },
    });
    for (const flux of [processus.stdout, processus.stderr])
      flux?.on("data", (m: Buffer) => (journal = (journal + m.toString()).slice(-4000)));
    q = new ClientQdrant({ url: `http://127.0.0.1:${http}`, delaiMs: 10_000 });
    const limite = Date.now() + 40_000;
    for (;;) {
      if (processus.exitCode !== null)
        throw new Error(`Qdrant s'est arrêté (${processus.exitCode}) : ${journal}`);
      if ((await q.sante()).ok) break;
      if (Date.now() > limite) throw new Error(`Qdrant n'est pas prêt : ${journal}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    serveurEmb = await demarrerServeurFaux((r) => {
      const { input } = r.corps as { input: string[] };
      return { json: { data: input.map((t, index) => ({ index, embedding: embed(t) })) } };
    });
    serveurRerank = await demarrerServeurFaux((r) => {
      const { documents } = r.corps as { documents: string[] };
      const liste = documents.map((d, index) => ({
        index,
        relevance_score: d.includes("courrier") ? 0.99 : 0.1,
      }));
      return { json: { results: liste.sort((a, b) => b.relevance_score - a.relevance_score) } };
    });
    emb = new ClientEmbeddings({ url: serveurEmb.url, modele: "test" });
    rerank = new ClientReranker({ url: serveurRerank.url });
  }, 90_000);

  afterAll(async () => {
    await Promise.all([serveurEmb?.arreter(), serveurRerank?.arreter()]);
    if (processus && processus.exitCode === null) {
      const fin = new Promise<void>((resolve) => processus?.once("exit", () => resolve()));
      processus.kill("SIGTERM");
      const force = setTimeout(() => processus?.kill("SIGKILL"), 10_000);
      await fin;
      clearTimeout(force);
    }
    if (dossier !== "") rmSync(dossier, { recursive: true, force: true });
  }, 30_000);

  it("répond à la santé avec la version", async () => {
    const etat = await q.sante();
    expect(etat.ok).toBe(true);
    expect(etat.version).toMatch(/^1\.16\./);
  });

  it("crée la collection : dense nommé, BM25 à IDF, index de charge utile", async () => {
    await q.creerCollection(COL, { dimension: DIMENSION });
    expect(await q.infoCollection(COL)).toEqual({
      existe: true,
      dimension: DIMENSION,
      points: 0,
      statut: "green",
    });
    await expect(q.creerCollection(COL, { dimension: DIMENSION })).rejects.toMatchObject({
      code: "collection_existe",
    });
    await expect(q.assurerCollection(COL, { dimension: 7 })).rejects.toMatchObject({
      code: "dimension_differente",
    });
    expect(await q.assurerCollection(COL, { dimension: DIMENSION })).toEqual({ creee: false });
    const brut = (await (await fetch(`${q.url}/collections/${COL}`)).json()) as {
      result: {
        config: { params: { vectors: Record<string, unknown>; sparse_vectors: Record<string, unknown> } };
        payload_schema: Record<string, { data_type: string }>;
      };
    };
    expect(brut.result.config.params.vectors).toMatchObject({
      dense: { size: DIMENSION, distance: "Cosine" },
    });
    expect(brut.result.config.params.sparse_vectors).toMatchObject({ bm25: { modifier: "idf" } });
    const types = Object.fromEntries(
      Object.entries(brut.result.payload_schema).map(([k, v]) => [k, v.data_type]),
    );
    expect(types).toEqual({
      doc_id: "keyword",
      rel_path: "keyword",
      ext: "keyword",
      chunk_index: "integer",
      text: "text",
    });
    expect(await q.listerCollections()).toContain(COL);
  });

  it("indexe deux documents puis les compte", async () => {
    const passagesContrat = await indexer(COL, "doc-contrat", "dossier/contrat.pdf", CONTRAT);
    await indexer(COL, "doc-guide", "guide.md", GUIDE);
    expect(passagesContrat.map((p) => p.chunk_index)).toEqual([0, 1, 2, 3]);
    expect(passagesContrat[0]).toMatchObject({ heading_path: "Contrat", page: 1 });
    expect(await q.compter(COL)).toBe(6);
    expect(await q.compter(COL, { docIds: ["doc-contrat"] })).toBe(4);
    expect(await q.compter(COL, { exts: ["md"] })).toBe(2);
    expect(await q.compter(COL, { exts: [".PDF"] })).toBe(4);
    expect(await q.compter(COL, { relPaths: ["guide.md"] })).toBe(2);
    expect(await q.compter(COL, { docIds: [] })).toBe(0);
  });

  it("mots : un identifiant rare est trouvé exactement, les accents sont ignorés", async () => {
    const r = await rechercher({ qdrant: q, collections: [A], requete: "ZX-4471", mode: "mots" });
    expect(r.passages[0]?.charge).toMatchObject({
      doc_id: "doc-contrat",
      chunk_index: 3,
      page: 3,
      rel_path: "dossier/contrat.pdf",
    });
    expect(r.passages).toHaveLength(1);
    const accents = await rechercher({
      qdrant: q,
      collections: [A],
      requete: "reference annexe",
      mode: "mots",
    });
    expect(accents.passages[0]?.charge.text).toContain("Référence");
  });

  it("sens : le synonyme sans mot commun est trouvé, le seuil adaptatif écarte le plus faible et le hors sujet", async () => {
    const commun = {
      qdrant: q,
      embeddings: emb,
      collections: [A],
      mode: "sens" as const,
      limite: 5,
      quasiDoublons: false as const,
    };
    const r = await rechercher({ ...commun, requete: "comment résilier" });
    expect(r.passages.map((p) => `${p.charge.doc_id}#${p.charge.chunk_index}`)).toEqual(["doc-guide#0"]);
    expect(r.passages[0]?.score).toBeGreaterThan(0.6);
    const proche = await rechercher({ ...commun, requete: "rupture fin courrier" });
    expect(proche.passages[0]?.charge).toMatchObject({ doc_id: "doc-contrat", chunk_index: 1 });
    const mots = await rechercher({ qdrant: q, collections: [A], requete: "résilier", mode: "mots" });
    expect(mots.passages).toEqual([]);
  });

  it("mixte : ce que le sens manque et ce que les mots manquent remontent ensemble", async () => {
    const r = await rechercher({
      qdrant: q,
      embeddings: emb,
      collections: [A],
      requete: "résilier ZX-4471",
      mode: "mixte",
      limite: 6,
      quasiDoublons: false,
    });
    const ids = r.passages.map((p) => `${p.charge.doc_id}#${p.charge.chunk_index}`);
    expect(ids).toContain("doc-contrat#3");
    expect(ids).toContain("doc-contrat#1");
    expect(ids).toContain("doc-guide#0");
    expect(r.mode).toBe("mixte");
    expect(r.passages.every((p, i) => p.rang === i + 1)).toBe(true);
  });

  it("filtres : par document, type, chemin, plein texte et exclusion", async () => {
    const commun = {
      qdrant: q,
      embeddings: emb,
      collections: [A],
      requete: "contrat",
      limite: 10,
      quasiDoublons: false as const,
    };
    const doc = await rechercher({ ...commun, filtres: { docIds: ["doc-guide"] } });
    expect(new Set(doc.passages.map((p) => p.charge.doc_id))).toEqual(new Set(["doc-guide"]));
    const pdf = await rechercher({ ...commun, filtres: { exts: ["pdf"] } });
    expect(pdf.passages.length).toBeGreaterThan(0);
    expect(pdf.passages.every((p) => p.charge.ext === "pdf")).toBe(true);
    const chemin = await rechercher({ ...commun, mode: "sens", filtres: { relPaths: ["guide.md"] } });
    expect(chemin.passages.every((p) => p.charge.rel_path === "guide.md")).toBe(true);
    const texte = await rechercher({
      ...commun,
      mode: "mots",
      requete: "rupture courrier",
      filtres: { texte: "Rupture anticipée" },
    });
    expect(texte.passages.map((p) => p.charge.chunk_index)).toEqual([1]);
    const sauf = await rechercher({ ...commun, filtres: { exclureDocIds: ["doc-contrat"] } });
    expect(sauf.passages.every((p) => p.charge.doc_id === "doc-guide")).toBe(true);
    const vide = await rechercher({ ...commun, filtres: { docIds: [] } });
    expect(vide.passages).toEqual([]);
  });

  it("remplace un document de façon atomique : on insère, puis on supprime les anciens passages", async () => {
    const v2: Bloc[] = [
      { kind: "heading", text: "Contrat", level: 1, page: 1 },
      { kind: "paragraph", text: "Nouvelle version : la reconduction se fait tous les deux ans.", page: 1 },
      { kind: "paragraph", text: "Les pénalités sont plafonnées à dix pour cent du montant.", page: 1 },
    ];
    const nouveaux = await indexer(COL, "doc-contrat", "dossier/contrat.pdf", v2);
    expect(nouveaux.map((p) => p.chunk_index)).toEqual([0, 1]);
    expect(await q.compter(COL, { docIds: ["doc-contrat"] })).toBe(4);
    const pendant = await rechercher({
      qdrant: q,
      collections: [A],
      requete: "reconduction",
      mode: "mots",
      filtres: { docIds: ["doc-contrat"] },
    });
    expect(pendant.passages[0]?.charge.chunk_index).toBe(0);
    await q.supprimerDocument(COL, "doc-contrat", { sauf: nouveaux.map((p) => p.chunk_index) });
    expect(await q.compter(COL, { docIds: ["doc-contrat"] })).toBe(2);
    const lus: string[] = [];
    for await (const page of q.parcourirDocument(COL, "doc-contrat"))
      lus.push(...page.map((p) => p.charge.text));
    expect(lus).toEqual(nouveaux.map((p) => p.text));
    const ancien = await rechercher({ qdrant: q, collections: [A], requete: "ZX-4471", mode: "mots" });
    expect(ancien.passages).toEqual([]);
    expect(await q.compter(COL, { docIds: ["doc-guide"] })).toBe(2);
  });

  it("parcourt un document dans l'ordre de chunk_index même inséré en désordre, page par page", async () => {
    const blocs: Bloc[] = Array.from({ length: 9 }, (_, i) => ({
      kind: "paragraph",
      text: `Paragraphe numéro ${i} avec un contenu propre ${"abcdefghi"[i]}${i}.`,
      page: 1 + (i % 3),
    }));
    const passages = await indexer(COL, "doc-long", "long.txt", blocs, (n) =>
      [5, 2, 8, 0, 7, 1, 6, 3, 4].filter((i) => i < n),
    );
    expect(passages).toHaveLength(9);
    const pages: number[][] = [];
    for await (const p of q.parcourirDocument(COL, "doc-long", { taillePage: 4 }))
      pages.push(p.map((x) => x.charge.chunk_index));
    expect(pages).toEqual([[0, 1, 2, 3], [4, 5, 6, 7], [8]]);
    const fenetre = await q.parcourir(COL, {
      filtre: { docIds: ["doc-long"], chunkMin: 3, chunkMax: 5 },
      depuis: 3,
    });
    expect(fenetre.map((x) => x.charge.chunk_index)).toEqual([3, 4, 5]);
    const reste = await q.parcourir(COL, {
      filtre: { docIds: ["doc-long"] },
      depuis: 6,
      limite: 10,
      avecVecteur: true,
    });
    expect(reste.map((x) => x.charge.chunk_index)).toEqual([6, 7, 8]);
    expect(reste[0]?.vecteur).toHaveLength(DIMENSION);
    await q.supprimerDocument(COL, "doc-long");
    expect(await q.compter(COL, { docIds: ["doc-long"] })).toBe(0);
  });

  it("accepte un passage sans token creux et un grand nombre de points en plusieurs lots", async () => {
    const points = Array.from({ length: 150 }, (_, i) =>
      construirePoint({
        docId: "doc-gros",
        relPath: "gros.txt",
        ext: "txt",
        passage: {
          text: i === 0 ? "le la les" : `passage ${i} mot${i}`,
          heading_path: "",
          page: null,
          boxes: [],
          char_start: 0,
          char_end: 1,
          chunk_index: i,
          hash: `h${i}`,
          jetons: 3,
        },
        dense: embed(`passage ${i} mot${i}`),
        creux: vecteurDocument(i === 0 ? "le la les" : `passage ${i} mot${i}`),
      }),
    );
    expect(await q.inserer(COL, points, { tailleLot: 64 })).toBe(150);
    expect(await q.compter(COL, { docIds: ["doc-gros"] })).toBe(150);
    const r = await rechercher({
      qdrant: q,
      collections: [A],
      requete: "mot77",
      mode: "mots",
      filtres: { docIds: ["doc-gros"] },
    });
    expect(r.passages[0]?.charge.chunk_index).toBe(77);
    await q.supprimerDocument(COL, "doc-gros");
    expect(await q.compter(COL)).toBe(4);
  }, 30_000);

  it("recherche dans plusieurs collections : fusion RRF, collection absente signalée, reclassement", async () => {
    await q.creerCollection(COL_B, { dimension: DIMENSION });
    await indexer(COL_B, "doc-b", "lettre.docx", [
      { kind: "paragraph", text: "La rupture du contrat part par courrier recommandé." },
    ]);
    const absente: CollectionCible<string> = { id: "c", nomQdrant: "elpis_test_absente", meta: "C" };
    const r = await rechercher({
      qdrant: q,
      embeddings: emb,
      collections: [A, B, absente],
      requete: "rupture courrier",
      limite: 5,
      quasiDoublons: false,
      reranker: { client: rerank },
    });
    expect(r.erreurs.map((e) => [e.collection.id, e.code])).toEqual([["c", "collection_absente"]]);
    expect(r.passages.length).toBeGreaterThan(1);
    expect(r.passages.every((p) => p.scoreReclassement !== undefined)).toBe(true);
    expect(r.passages[0]?.charge.text).toContain("courrier");
    expect(new Set(r.passages.map((p) => p.collection.meta))).toEqual(new Set(["A", "B"]));
    const fusion = await rechercher({
      qdrant: q,
      embeddings: emb,
      collections: [A, B],
      requete: "rupture courrier",
      limite: 5,
      quasiDoublons: false,
    });
    expect(fusion.passages.every((p) => typeof p.scoreFusion === "number")).toBe(true);
    expect(fusion.passages.map((p) => p.scoreFusion)).toEqual(
      [...fusion.passages.map((p) => p.scoreFusion)].sort((a, b) => (b ?? 0) - (a ?? 0)),
    );
  });

  it("supprime les collections", async () => {
    expect(await q.supprimerCollection(COL_B)).toBe(true);
    expect(await q.supprimerCollection(COL_B)).toBe(false);
    expect((await q.infoCollection(COL_B)).existe).toBe(false);
    const r = await rechercher({ qdrant: q, collections: [B], requete: "recherche", mode: "mots" });
    expect(r.erreurs[0]?.code).toBe("collection_absente");
    expect(await q.supprimerCollection(COL)).toBe(true);
    expect(await q.listerCollections()).not.toContain(COL);
  });
});
