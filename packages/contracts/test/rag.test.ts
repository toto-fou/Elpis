// SPDX-License-Identifier: MIT
/** packages/contracts/test/rag.test.ts — contrats du RAG intégré : collection, document, travail, passage, sources, publication, réglage d'un chat, événement `rag_job`. */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CODES_REFUS_RAG,
  CONTRATS_REST,
  contratDe,
  DECOUPAGE_RAG_DEFAUT,
  decoderEvenementSysteme,
  EXTENSIONS_RAG,
  RE_UUID_RAG,
  REGLAGE_RAG_CHAT_DEFAUT,
  schemaCollectionRag,
  schemaCorpsCreationCollectionRag,
  schemaCorpsMajCollectionRag,
  schemaCorpsPublicationRag,
  schemaDecoupageDocumentRag,
  schemaDecoupageRag,
  schemaParamsDecoupageRag,
  schemaPassageListeRag,
  schemaDocumentRag,
  schemaPassageRag,
  schemaCorpsNouveauChat,
  schemaCorpsRagChat,
  schemaReglageRagChat,
  schemaReponseRagChat,
  schemaSourcesMessageRag,
  schemaTravailRag,
  schemaUuidRag,
  schemasJson,
  TYPES_EVENEMENTS_SYSTEME,
} from "../src";
import type { CollectionRag, DocumentRag, PassageRag, TravailRag } from "../src";
import { SCHEMAS_EVENEMENTS } from "../src/evenements";
import * as rag from "../src/rest/rag";

const C = "3f9a1c2e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
const D = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const J = "aa1b2c3d-4e5f-4a6b-bc7d-9e0f1a2b3c4d";

const COLLECTION: CollectionRag = {
  id: C,
  name: "Contrats 2026",
  description: "Contrats fournisseurs.\nCherche ici pour les échéances.",
  visibility: "groups",
  allow_source_open: false,
  owner: { id: 3, username: "alice", display_name: "alice" },
  role: "lecteur",
  groups: [{ id: 2, name: "Juristes", members: 5 }],
  doc_count: 12,
  chunk_count: 340,
  bytes: 12_582_912,
  status: "indexing",
  embed_model: "bge-m3",
  chunking: DECOUPAGE_RAG_DEFAUT,
  ocr: false,
  created_at: 1_791_331_200,
  updated_at: 1_791_331_803.5,
};

const DOCUMENT: DocumentRag = {
  id: D,
  collection_id: C,
  rel_path: "fournisseurs/acme.pdf",
  name: "acme.pdf",
  ext: "pdf",
  bytes: 734_003,
  pages: 18,
  chunk_count: 0,
  status: "error",
  error: { code: "no_text", message: "Sans texte : activez l'OCR" },
  created_at: 1_791_331_200,
  indexed_at: null,
};

const TRAVAIL: TravailRag = {
  id: J,
  collection_id: C,
  kind: "ingest",
  status: "running",
  total: 12,
  done: 4,
  failed: 1,
  error: null,
  created_at: 1_791_331_200,
  finished_at: null,
};

const PASSAGE: PassageRag = {
  collection_id: C,
  collection_name: "Contrats 2026",
  owner: { id: 3, username: "alice", display_name: "alice" },
  document_id: D,
  document_name: "acme.pdf",
  rel_path: "fournisseurs/acme.pdf",
  chunk_index: 7,
  page: 3,
  heading_path: "3 › 3.2 Renouvellement",
  text: "Le contrat est renouvelé par tacite reconduction.",
  score: 0.83,
  boxes: [
    [3, 72, 140.5, 523, 188],
    [4, 72, 60, 300, 75],
  ],
};

describe("identifiants et listes", () => {
  it("uuid v4 en minuscules seulement : majuscules, autre version, accolades et chemins refusés", () => {
    expect(RE_UUID_RAG.test(randomUUID())).toBe(true);
    for (const v of [
      C.toUpperCase(),
      "3f9a1c2e-5b7d-1e8f-9a0b-1c2d3e4f5a6b",
      `{${C}}`,
      `${C}/..`,
      "",
      " " + C,
    ])
      expect(schemaUuidRag.safeParse(v).success, v).toBe(false);
  });

  it("extensions en minuscules sans point ; codes de refus uniques", () => {
    for (const e of EXTENSIONS_RAG) expect(e).toMatch(/^[a-z0-9]+$/u);
    expect(new Set(EXTENSIONS_RAG).size).toBe(EXTENSIONS_RAG.length);
    expect(new Set(CODES_REFUS_RAG).size).toBe(CODES_REFUS_RAG.length);
  });
});

describe("collection", () => {
  it("forme complète acceptée ; rôle, visibilité et état fermés", () => {
    expect(schemaCollectionRag.parse(COLLECTION)).toEqual(COLLECTION);
    for (const [cle, v] of [
      ["role", "admin"],
      ["visibility", "public"],
      ["status", "deleting"],
      ["id", "elpis_abc"],
      ["name", ""],
      ["name", "x".repeat(81)],
      ["description", "x".repeat(501)],
      ["bytes", -1],
    ] as const)
      expect(schemaCollectionRag.safeParse({ ...COLLECTION, [cle]: v }).success, cle).toBe(false);
  });

  it("création : nom débarrassé des blancs, 1 à 80 caractères, sans contrôle ; description multiligne", () => {
    expect(schemaCorpsCreationCollectionRag.parse({ name: "  Contrats  " })).toEqual({ name: "Contrats" });
    for (const name of ["   ", "a\u0000b", "a\nb", "a\u0085b", "x".repeat(81)])
      expect(schemaCorpsCreationCollectionRag.safeParse({ name }).success, JSON.stringify(name)).toBe(false);
    expect(schemaCorpsCreationCollectionRag.safeParse({ name: "a", description: "l1\nl2" }).success).toBe(
      true,
    );
    expect(schemaCorpsCreationCollectionRag.safeParse({ name: "a", description: "l1\tl2" }).success).toBe(
      false,
    );
    expect(schemaCorpsMajCollectionRag.parse({})).toEqual({});
  });

  it("découpage : bornes et chevauchement inférieur à la taille", () => {
    expect(schemaDecoupageRag.parse(DECOUPAGE_RAG_DEFAUT)).toEqual(DECOUPAGE_RAG_DEFAUT);
    const p = { methode: "taille", unite: "caracteres", taille: 800, chevauchement: 100, taille_max: 1600 };
    expect(schemaParamsDecoupageRag.parse(p)).toEqual(p);
    const { par_extension: _, ...sansRegles } = DECOUPAGE_RAG_DEFAUT;
    expect(schemaDecoupageRag.parse(sansRegles)).toEqual(DECOUPAGE_RAG_DEFAUT);
    expect(
      schemaDecoupageRag.parse({ ...sansRegles, par_extension: { md: { ...p, methode: "markdown" } } }),
    ).toMatchObject({ par_extension: { md: { methode: "markdown" } } });
    for (const d of [
      { mode: "manuel", chunk_tokens: 512, overlap_tokens: 64 },
      { ...p, taille: 19 },
      { ...p, taille: 20001 },
      { ...p, chevauchement: 400 },
      { ...p, taille_max: 799 },
      { ...p, methode: "libre" },
      { ...p, unite: "mots" },
      { ...p, methode: "regex" },
      { ...p, methode: "separateur", valeur: "" },
      { ...p, methode: "separateur", valeur: "x".repeat(201) },
      { ...p, par_extension: { exe: p } },
      { ...p, par_extension: { md: { ...p, chevauchement: 400 } } },
    ])
      expect(schemaDecoupageRag.safeParse(d).success, JSON.stringify(d)).toBe(false);
    expect(schemaDecoupageDocumentRag.parse({})).toEqual({ redecoupes: [] });
    expect(
      schemaDecoupageDocumentRag.safeParse({
        redecoupes: [
          { index: 1, params: p },
          { index: 1, params: p },
        ],
      }).success,
    ).toBe(false);
    expect(
      schemaDecoupageDocumentRag.safeParse({
        redecoupes: Array.from({ length: 501 }, (_, index) => ({ index, params: p })),
      }).success,
    ).toBe(false);
    expect(
      schemaPassageListeRag.safeParse({
        index: 0,
        texte: "a",
        caracteres: 1,
        jetons: 1,
        page: null,
        section: null,
        redecoupe_de: null,
      }).success,
    ).toBe(true);
  });
});

describe("document, travail, passage, sources", () => {
  it("document : extension de la liste, état fermé, erreur {code, message} ou null", () => {
    expect(schemaDocumentRag.parse(DOCUMENT)).toEqual(DOCUMENT);
    expect(schemaDocumentRag.safeParse({ ...DOCUMENT, ext: "exe" }).success).toBe(false);
    expect(schemaDocumentRag.safeParse({ ...DOCUMENT, ext: ".pdf" }).success).toBe(false);
    expect(schemaDocumentRag.safeParse({ ...DOCUMENT, status: "done" }).success).toBe(false);
    expect(schemaDocumentRag.safeParse({ ...DOCUMENT, error: "no_text" }).success).toBe(false);
  });

  it("travail : genres et états fermés", () => {
    expect(schemaTravailRag.parse(TRAVAIL)).toEqual(TRAVAIL);
    expect(schemaTravailRag.safeParse({ ...TRAVAIL, kind: "delete" }).success).toBe(false);
    expect(schemaTravailRag.safeParse({ ...TRAVAIL, status: "ok" }).success).toBe(false);
  });

  it("passage : boîtes `[page, x0, y0, x1, y1]`, page à partir de 1", () => {
    expect(schemaPassageRag.parse(PASSAGE)).toEqual(PASSAGE);
    expect(schemaPassageRag.safeParse({ ...PASSAGE, boxes: [[72, 140, 523, 188]] }).success).toBe(false);
    expect(schemaPassageRag.safeParse({ ...PASSAGE, boxes: [[0, 1, 2, 3, 4]] }).success).toBe(false);
    expect(schemaPassageRag.safeParse({ ...PASSAGE, page: 0 }).success).toBe(false);
  });

  it("sources du message : numéro, passage, cité ou lu seulement, requête, rang et pertinence", () => {
    const sources = [
      { n: 1, passage: PASSAGE, cited: true, query: "échéance", rank: 1, relevance: 1 },
      {
        n: 2,
        passage: { ...PASSAGE, chunk_index: 8, page: null, boxes: [] },
        cited: false,
        query: null,
        rank: null,
        relevance: null,
      },
    ];
    expect(schemaSourcesMessageRag.parse(sources)).toEqual(sources);
    const une = sources[0]!;
    for (const faux of [
      { ...une, n: 0 },
      { ...une, rank: 0 },
      { ...une, relevance: 1.5 },
      { n: 3, passage: PASSAGE, cited: true },
    ])
      expect(schemaSourcesMessageRag.safeParse([faux]).success, JSON.stringify(faux).slice(0, 60)).toBe(
        false,
      );
    expect(schemaSourcesMessageRag.safeParse(Array.from({ length: 201 }, () => une)).success).toBe(false);
    const ev = { type: "rag_sources", sources };
    expect(SCHEMAS_EVENEMENTS.rag_sources.parse(ev)).toEqual(ev);
    expect(SCHEMAS_EVENEMENTS.rag_sources.safeParse({ type: "rag_sources", text: "a.pdf" }).success).toBe(
      false,
    );
  });
});

describe("publication et réglage d'un chat", () => {
  it("publication : visibilité fermée, au plus 50 groupes positifs", () => {
    const ok = { visibility: "groups", group_ids: [2, 5], allow_source_open: true };
    expect(schemaCorpsPublicationRag.parse(ok)).toEqual(ok);
    for (const d of [
      { ...ok, visibility: "public" },
      { ...ok, group_ids: [0] },
      { ...ok, group_ids: Array.from({ length: 51 }, (_, i) => i + 1) },
      { visibility: "private", allow_source_open: false },
    ])
      expect(schemaCorpsPublicationRag.safeParse(d).success, JSON.stringify(d).slice(0, 60)).toBe(false);
  });

  it("réglage RAG d'un chat : uuid uniques, 10 au plus, mode et top_k bornés", () => {
    expect(schemaReglageRagChat.parse(REGLAGE_RAG_CHAT_DEFAUT)).toEqual(REGLAGE_RAG_CHAT_DEFAUT);
    expect(schemaReglageRagChat.parse({ collections: [C, D], mode: "mots", top_k: 50 }).collections).toEqual([
      C,
      D,
    ]);
    for (const r of [
      { collections: [C, C], mode: "mixte", top_k: 8 },
      { collections: ["documents"], mode: "mixte", top_k: 8 },
      { collections: Array.from({ length: 11 }, () => randomUUID()), mode: "mixte", top_k: 8 },
      { collections: [], mode: "hybride", top_k: 8 },
      { collections: [], mode: "sens", top_k: 0 },
      { collections: [], mode: "sens", top_k: 51 },
    ])
      expect(schemaReglageRagChat.safeParse(r).success, JSON.stringify(r).slice(0, 60)).toBe(false);
  });

  it("collections actives d'un chat : corps du PUT, création d'un chat, chat relu", () => {
    expect(schemaCorpsRagChat.parse({ collections: [C] })).toEqual({ collections: [C] });
    expect(schemaCorpsRagChat.parse({ collections: [], mode: "mots", top_k: 3 }).mode).toBe("mots");
    for (const r of [{}, { collections: [C, C] }, { collections: ["x"] }, { collections: [C], top_k: 0 }])
      expect(schemaCorpsRagChat.safeParse(r).success, JSON.stringify(r)).toBe(false);
    expect(schemaReponseRagChat.parse({ ok: true, rag: REGLAGE_RAG_CHAT_DEFAUT }).rag.collections).toEqual(
      [],
    );
    expect(schemaCorpsNouveauChat.parse({ plan_mode: false, rag_collections: [C] }).rag_collections).toEqual([
      C,
    ]);
    expect(schemaCorpsNouveauChat.safeParse({ rag_collections: ["x"] }).success).toBe(false);
    expect(contratDe("PUT", `/api/saved/chats/abc/rag`)?.corps).toBe(schemaCorpsRagChat);
  });
});

describe("événement système rag_job", () => {
  it("inscrit au registre, décodé avec ou sans document, refusé sans user_id", () => {
    expect(TYPES_EVENEMENTS_SYSTEME).toContain("rag_job");
    const ev = { type: "rag_job", data: { user_id: 3, collection_id: C, job: TRAVAIL, document: DOCUMENT } };
    expect(decoderEvenementSysteme(JSON.stringify(ev))).toEqual({ statut: "ok", evenement: ev });
    const sans = { type: "rag_job", data: { user_id: 3, collection_id: C, job: TRAVAIL } };
    expect(decoderEvenementSysteme(JSON.stringify(sans)).statut).toBe("ok");
    const anonyme = { type: "rag_job", data: { collection_id: C, job: TRAVAIL } };
    expect(decoderEvenementSysteme(JSON.stringify(anonyme)).statut).toBe("invalide");
  });

  it("schéma JSON de l'événement système exportable", () => {
    expect(JSON.stringify(schemasJson()["evenement-systeme"])).toContain("rag_job");
  });

  it("chaque schéma RAG se traduit en schéma JSON, en entrée comme en sortie (registre des routes)", () => {
    const schemas = Object.entries(rag as Record<string, unknown>).filter(
      (e): e is [string, z.ZodType] => e[1] instanceof z.ZodType,
    );
    expect(schemas.length).toBeGreaterThan(20);
    for (const [nom, schema] of schemas)
      for (const io of ["input", "output"] as const)
        expect(() => z.toJSONSchema(schema, { io }), `${nom} ${io}`).not.toThrow();
  });
});

describe("routes REST du compte", () => {
  const UUID = "3f9a1c2e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";

  it("codes d'erreur : ceux des droits y sont, sans doublon, en minuscules", () => {
    for (const c of CODES_REFUS_RAG) expect(rag.CODES_ERREUR_ROUTES_RAG).toContain(c);
    expect(new Set(rag.CODES_ERREUR_ROUTES_RAG).size).toBe(rag.CODES_ERREUR_ROUTES_RAG.length);
    for (const c of rag.CODES_ERREUR_ROUTES_RAG) expect(c).toMatch(/^[a-z_]+$/u);
    expect(rag.schemaErreurRouteRag.safeParse({ detail: "Collection introuvable.", code: "x" }).success).toBe(
      true,
    );
    expect(rag.schemaErreurRouteRag.safeParse({ detail: "sans code" }).success).toBe(false);
  });

  it("recherche : requête de 1 à 2000 caractères, mode et limite bornés, reclassement booléen", () => {
    const ok = rag.schemaCorpsRechercheRag;
    expect(ok.parse({ requete: "  contrat  " })).toEqual({ requete: "contrat" });
    expect(ok.safeParse({ requete: "x", mode: "mots", limite: 20, reclasser: true }).success).toBe(true);
    for (const mauvais of [
      {},
      { requete: "  " },
      { requete: "x".repeat(2001) },
      { requete: "x", mode: "flou" },
      { requete: "x", limite: 0 },
      { requete: "x", limite: 21 },
      { requete: "x", reclasser: 1 },
    ])
      expect(ok.safeParse(mauvais).success, JSON.stringify(mauvais).slice(0, 40)).toBe(false);
  });

  it("requêtes en chaîne de requête : nombres décimaux courts, états libres, tri fermé", () => {
    const d = rag.schemaRequeteDocumentsRag;
    expect(
      d.safeParse({ q: "x", status: "pending,ready", tri: "recent", offset: "20", limit: "100" }).success,
    ).toBe(true);
    for (const mauvais of [{ tri: "hasard" }, { offset: "-1" }, { limit: "12345" }, { limit: "1e3" }])
      expect(d.safeParse(mauvais).success).toBe(false);
    expect(
      rag.schemaRequeteTravauxRag.safeParse({ actifs: "1", collection_id: UUID, limite: "20" }).success,
    ).toBe(true);
    expect(rag.schemaRequeteTravauxRag.safeParse({ collection_id: "x" }).success).toBe(false);
    expect(rag.schemaRequeteCollectionsRag.safeParse({ masquees: "1" }).success).toBe(true);
    expect(rag.schemaRequeteCollectionsRag.safeParse({ masquees: "oui" }).success).toBe(false);
  });

  it("import du bac : 1 à 500 chemins non vides ; réindexation : uuid ; localisation : texte de 1 à 20000", () => {
    expect(rag.schemaCorpsImportSandboxRag.safeParse({ paths: ["/work/a.pdf"] }).success).toBe(true);
    expect(rag.schemaCorpsImportSandboxRag.safeParse({ paths: [] }).success).toBe(false);
    expect(rag.schemaCorpsImportSandboxRag.safeParse({ paths: [""] }).success).toBe(false);
    expect(rag.schemaCorpsReindexationRag.safeParse({ documents: [UUID], force: true }).success).toBe(true);
    expect(rag.schemaCorpsReindexationRag.safeParse({ documents: ["x"] }).success).toBe(false);
    expect(rag.schemaCorpsLocalisationRag.safeParse({ texte: "x", page: 2 }).success).toBe(true);
    expect(rag.schemaCorpsLocalisationRag.safeParse({ texte: "x", page: 0 }).success).toBe(false);
    expect(rag.schemaCorpsLocalisationRag.safeParse({ texte: "x".repeat(20_001) }).success).toBe(false);
    expect(rag.schemaCorpsMasquageRag.safeParse({ hidden: true }).success).toBe(true);
    expect(rag.schemaCorpsMasquageRag.safeParse({ hidden: "oui" }).success).toBe(false);
  });

  it("collection vue : la collection du contrat plus le masquage ; passage trouvé : rang et pertinence de 0 à 1", () => {
    expect(rag.schemaCollectionVueRag.safeParse({ ...COLLECTION, hidden: false }).success).toBe(true);
    expect(rag.schemaCollectionVueRag.safeParse(COLLECTION).success).toBe(false);
    const passage = { ...PASSAGE, rank: 1, relevance: 0.5 };
    expect(rag.schemaPassageTrouveRag.safeParse(passage).success).toBe(true);
    expect(rag.schemaPassageTrouveRag.safeParse({ ...passage, relevance: 1.2 }).success).toBe(false);
    expect(rag.schemaPassageTrouveRag.safeParse({ ...passage, rank: 0 }).success).toBe(false);
  });

  it("registre : chaque route du domaine rag a sa réponse, les corps JSON à leur schéma", () => {
    const routes = CONTRATS_REST.filter((r) => r.domaine === "rag");
    expect(routes).toHaveLength(23);
    expect(routes.every((r) => r.reponse !== null)).toBe(true);
    const corps = routes.filter((r) => r.corps !== undefined).map((r) => `${r.methode} ${r.chemin}`);
    expect(corps).toContain("POST /api/rag/collections/:collection_id/recherche");
    expect(corps).toContain("PUT /api/rag/collections/:collection_id/publication");
    expect(corps).not.toContain("POST /api/rag/collections/:collection_id/documents");
  });
});
