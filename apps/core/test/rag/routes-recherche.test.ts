// SPDX-License-Identifier: MIT
/** apps/core/test/rag/routes-recherche.test.ts — onglet Tester (SQLite et PostgreSQL), faux embeddings et Qdrant en mémoire : passages retenus, carte des documents touchés, jetons, reclassement, repli sans embeddings, pannes, génération servie pendant une migration. */
import { CHARS_PER_TOKEN } from "@elpis/config";
import { schemaReponseRechercheRag } from "@elpis/contracts";
import type { PassageTrouveRag } from "@elpis/contracts";
import { ClientReranker, estimerJetons } from "@elpis/rag";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { appliquerPublication } from "../../src/rag/acces";
import { creerCollection } from "./aides-indexation";
import { demarrerEnvironnement, indexerDirect, json, MOTEURS, ouvrirBanc } from "./aides-routes";
import type { Banc, Environnement } from "./aides-routes";

let env: Environnement;

beforeAll(async () => {
  env = await demarrerEnvironnement();
});

afterAll(async () => {
  await env.arreter();
});

interface Erreur {
  detail: string;
  code: string;
}

interface Resultat {
  mode: string;
  reranked: boolean;
  passages: PassageTrouveRag[];
  map: {
    document_id: string;
    document_name: string;
    rel_path: string;
    chunk_count: number;
    hits: { chunk_index: number; rank: number; retained: boolean }[];
  }[];
  duration_ms: number;
  tokens: number;
  warnings: string[];
  errors: { code: string; message: string }[];
}

/** Reclassement simulé : les documents sont classés dans l'ordre inverse de leur rang d'arrivée. */
function rerankerInverse(): ClientReranker {
  return new ClientReranker({
    url: "http://rerank.test",
    fetch: async (_url, init) => {
      const { documents } = JSON.parse(String(init?.body)) as { documents: string[] };
      const results = documents.map((_, index) => ({ index, relevance_score: index / 10 }));
      return new Response(JSON.stringify({ results }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
}

describe.each(MOTEURS)("routes RAG : recherche (%s)", (moteur) => {
  let b: Banc;
  let col: string;
  let docA: string;
  let docB: string;
  const url = (id = col): string => `/api/rag/collections/${id}/recherche`;
  const chercher = async (corps: unknown, uid = b.id.alice, id = col): Promise<Resultat> => {
    const r = await b.appeler(uid, "POST", url(id), corps);
    expect(r.statut, JSON.stringify(r.corps)).toBe(200);
    return schemaReponseRechercheRag.parse(r.corps) as Resultat;
  };

  beforeEach(async () => {
    b = await ouvrirBanc(moteur, env, { reranker: () => null });
    col = await creerCollection(b.base, b.id.alice, "Contrats");
    docA = await indexerDirect(b, col, "droit/contrat.pdf", [
      {
        texte: "Le contrat est renouvelé chaque année.",
        titres: "1 › Durée",
        page: 1,
        boites: [[10, 10, 100, 30]],
      },
      { texte: "La résiliation du contrat exige un préavis de trois mois.", titres: "2 › Fin", page: 2 },
      {
        texte: "Les pénalités de retard du contrat atteignent dix pour cent.",
        titres: "3 › Pénalités",
        page: 3,
      },
      {
        texte: "Le tribunal de commerce est seul compétent pour le contrat.",
        titres: "4 › Litiges",
        page: 3,
      },
      { texte: "Les annexes du contrat listent le matériel fourni.", titres: "5 › Annexes", page: 4 },
      { texte: "Un préavis plus court est possible pour faute grave.", titres: "2 › Fin", page: 2 },
    ]);
    docB = await indexerDirect(b, col, "finance/tarifs.pdf", [
      { texte: "Les tarifs du contrat sont révisés selon l'indice annuel.", page: 1 },
      { texte: "Facturation mensuelle des services du contrat.", page: 2 },
      { texte: "Tableau des remises de volume.", page: 2 },
    ]);
  });

  afterEach(async () => {
    await b.fermer();
  });

  it("par mots : le passage qui porte les mots exacts arrive en tête, avec tous ses champs", async () => {
    const r = await chercher({ requete: "résiliation préavis", mode: "mots", limite: 3 });
    expect(r.mode).toBe("mots");
    const premier = r.passages[0] as PassageTrouveRag;
    expect(premier).toMatchObject({
      collection_id: col,
      collection_name: "Contrats",
      owner: { id: b.id.alice, username: "alice", display_name: "alice" },
      document_id: docA,
      document_name: "contrat.pdf",
      rel_path: "droit/contrat.pdf",
      chunk_index: 1,
      page: 2,
      heading_path: "2 › Fin",
      text: "La résiliation du contrat exige un préavis de trois mois.",
      boxes: [[2, 10, 10, 100, 30]],
      rank: 1,
      relevance: 1,
    });
    expect(premier.score).toBeGreaterThan(0);
    expect(r.passages.map((p) => p.rank)).toEqual(r.passages.map((_, i) => i + 1));
    expect(r.passages.every((p) => p.relevance >= 0 && p.relevance <= 1)).toBe(true);
    expect(r.duration_ms).toBeGreaterThanOrEqual(0);
    expect(r.reranked).toBe(false);
  });

  it("la carte donne, pour chaque document touché, sa longueur et les rangs trouvés, au-delà de la limite aussi", async () => {
    const r = await chercher({ requete: "contrat", mode: "mots", limite: 3 });
    expect(r.passages).toHaveLength(3);
    const retenus = new Set(r.passages.map((p) => `${p.document_id}:${p.chunk_index}`));
    expect(r.map.map((d) => [d.document_name, d.chunk_count])).toEqual(
      expect.arrayContaining([
        ["contrat.pdf", 6],
        ["tarifs.pdf", 3],
      ]),
    );
    const tout = r.map.flatMap((d) => d.hits.map((h) => ({ ...h, doc: d.document_id })));
    expect(tout.length).toBeGreaterThan(3);
    expect(tout.filter((h) => h.retained)).toHaveLength(3);
    expect(tout.every((h) => h.retained === retenus.has(`${h.doc}:${h.chunk_index}`))).toBe(true);
    expect(tout.map((h) => h.rank).sort((x, y) => x - y)).toEqual(tout.map((_, i) => i + 1));
    expect(tout.filter((h) => h.retained).every((h) => h.rank <= 3)).toBe(true);
    expect(tout.filter((h) => !h.retained).every((h) => h.rank > 3)).toBe(true);
    expect(r.map.some((d) => d.document_id === docB)).toBe(true);
    for (const d of r.map) for (const h of d.hits) expect(h.chunk_index).toBeLessThan(d.chunk_count);
  });

  it("estimation en jetons des passages retenus (rapport de l'application)", async () => {
    const r = await chercher({ requete: "préavis", mode: "mots", limite: 2 });
    const attendu = r.passages.reduce(
      (s, p) =>
        s +
        estimerJetons(p.text, CHARS_PER_TOKEN) +
        estimerJetons(p.heading_path, CHARS_PER_TOKEN) +
        estimerJetons(p.document_name, CHARS_PER_TOKEN),
      0,
    );
    expect(r.tokens).toBe(attendu);
    expect(r.tokens).toBeGreaterThan(10);
  });

  it("mixte (par défaut) et par le sens passent par les embeddings de la collection", async () => {
    env.emb.modeles.length = 0;
    const mixte = await chercher({ requete: "résiliation préavis trois mois" });
    expect(mixte.mode).toBe("mixte");
    expect(mixte.passages[0]?.chunk_index).toBe(1);
    const sens = await chercher({
      requete: "Le contrat est renouvelé chaque année.",
      mode: "sens",
      limite: 1,
    });
    expect(sens.mode).toBe("sens");
    expect(sens.passages[0]).toMatchObject({ chunk_index: 0, document_id: docA });
    expect(new Set(env.emb.modeles)).toEqual(new Set(["m1"]));
  });

  it("sans serveur d'embeddings, le mode mixte retombe sur les mots avec un avertissement lisible", async () => {
    env.emb.panne = true;
    const r = await chercher({ requete: "préavis" });
    expect(r.mode).toBe("mots");
    expect(r.passages.length).toBeGreaterThan(0);
    expect(r.warnings).toEqual(["Serveur d'embeddings indisponible : recherche par mots seulement."]);
    expect(JSON.stringify(r)).not.toContain("http://");
    const sens = await b.appeler(b.id.alice, "POST", url(), { requete: "préavis", mode: "sens" });
    expect([sens.statut, json<Erreur>(sens).code]).toEqual([503, "embeddings_indisponibles"]);
  });

  it("reclassement : ignoré avec un avertissement s'il n'est pas configuré, appliqué sinon", async () => {
    const sans = await chercher({ requete: "contrat", mode: "mots", limite: 3, reclasser: true });
    expect(sans.reranked).toBe(false);
    expect(sans.warnings).toContain("Reclassement non configuré : ordre d'origine gardé.");
    const banc = await ouvrirBanc(moteur, env, { reranker: rerankerInverse });
    try {
      const c = await creerCollection(banc.base, banc.id.alice, "Reclassées");
      await indexerDirect(banc, c, "a.pdf", [
        { texte: "contrat alpha contrat contrat contrat" },
        { texte: "contrat beta contrat contrat" },
        { texte: "contrat gamma contrat" },
        { texte: "contrat delta" },
      ]);
      const brut = schemaReponseRechercheRag.parse(
        (await banc.appeler(banc.id.alice, "POST", url(c), { requete: "contrat", mode: "mots", limite: 4 }))
          .corps,
      );
      const classe = schemaReponseRechercheRag.parse(
        (
          await banc.appeler(banc.id.alice, "POST", url(c), {
            requete: "contrat",
            mode: "mots",
            limite: 4,
            reclasser: true,
          })
        ).corps,
      );
      expect(classe.reranked).toBe(true);
      expect(classe.passages.map((p) => p.chunk_index)).toEqual(
        [...brut.passages.map((p) => p.chunk_index)].reverse(),
      );
      expect(classe.passages[0]?.relevance).toBe(1);
      expect(classe.passages.at(-1)?.relevance).toBe(0);
    } finally {
      await banc.fermer();
    }
  });

  it("un lecteur cherche dans la collection partagée ; une autre collection du propriétaire n'est jamais interrogée", async () => {
    const autre = await creerCollection(b.base, b.id.alice, "Autre");
    await indexerDirect(b, autre, "secret.pdf", [{ texte: "contrat secret du propriétaire" }]);
    await appliquerPublication(b.base, b.id.alice, col, {
      visibility: "groups",
      group_ids: [b.groupe.A],
      allow_source_open: false,
    });
    const r = await chercher({ requete: "contrat", mode: "mots", limite: 20 }, b.id.bob);
    expect(r.passages.length).toBeGreaterThan(0);
    expect(r.passages.every((p) => p.collection_id === col)).toBe(true);
    expect(r.passages.some((p) => p.document_name === "secret.pdf")).toBe(false);
    expect(r.passages[0]?.owner.username).toBe("alice");
    const refus = await b.appeler(b.id.bob, "POST", url(autre), { requete: "contrat" });
    expect(refus.statut).toBe(404);
  });

  it("génération servie : pendant une migration, la requête est vectorisée avec l'ANCIEN modèle de la collection", async () => {
    const mig = await creerCollection(b.base, b.id.alice, "Migration");
    await indexerDirect(b, mig, "m.pdf", [{ texte: "migration du modèle de contrat" }], {
      modele: "m-ancien",
    });
    env.emb.dimensions.set("m-ancien", 8);
    env.emb.modeles.length = 0;
    await b.base.run(
      "INSERT INTO rag_jobs(id, collection_id, owner_user_id, kind, status, params_json, created_at) VALUES(?, ?, ?, 'migrate', 'running', ?, 1)",
      [
        "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
        mig,
        b.id.alice,
        JSON.stringify({ generation: 1, modele: "m1", curseur: null, debut: 1 }),
      ],
    );
    const r = await chercher({ requete: "migration contrat", mode: "sens", limite: 2 }, b.id.alice, mig);
    expect(r.passages).toHaveLength(1);
    expect(new Set(env.emb.modeles)).toEqual(new Set(["m-ancien"]));
  });

  it("collection jamais indexée : liste vide avec explication ; index absent de Qdrant : erreur signalée sans panne", async () => {
    const neuve = await creerCollection(b.base, b.id.alice, "Neuve");
    const vide = await chercher({ requete: "contrat" }, b.id.alice, neuve);
    expect(vide).toMatchObject({ passages: [], map: [], tokens: 0 });
    expect(vide.warnings).toEqual(["Cette collection n'a encore aucun document indexé."]);
    const perdue = await creerCollection(b.base, b.id.alice, "Perdue");
    await b.base.run("UPDATE rag_collections SET embed_model='m1', embed_dim=8 WHERE id=?", [perdue]);
    const r = await chercher({ requete: "contrat" }, b.id.alice, perdue);
    expect(r.passages).toEqual([]);
    expect(r.errors).toEqual([
      {
        code: "collection_absente",
        message: "L'index de cette collection est absent : lancez une réindexation.",
      },
    ]);
  });

  it("Qdrant injoignable : 503 qdrant_indisponible ; RAG désactivé : 503 rag_desactive", async () => {
    b.q.panne = true;
    const r = await b.appeler(b.id.alice, "POST", url(), { requete: "contrat", mode: "mots" });
    expect([r.statut, json<Erreur>(r).code]).toEqual([503, "qdrant_indisponible"]);
    expect(json<Erreur>(r).detail).not.toMatch(/qdrant\.test|fetch/u);
    b.q.panne = false;
    env.ecrireConfig({ embed: { url: "" } });
    const off = await b.appeler(b.id.alice, "POST", url(), { requete: "contrat" });
    expect([off.statut, json<Erreur>(off).code]).toEqual([503, "rag_desactive"]);
  });

  it("les passages dont le document n'existe plus sont ignorés", async () => {
    await b.base.run("DELETE FROM rag_documents WHERE id=?", [docB]);
    const r = await chercher({ requete: "contrat", mode: "mots", limite: 20 });
    expect(r.passages.some((p) => p.document_id === docB)).toBe(false);
    expect(r.map.some((d) => d.document_id === docB)).toBe(false);
    expect(r.passages.length).toBeGreaterThan(0);
  });

  it("requêtes invalides : 400 requete_invalide", async () => {
    for (const corps of [
      {},
      { requete: "" },
      { requete: "   " },
      { requete: "x".repeat(2001) },
      { requete: "ok", mode: "flou" },
      { requete: "ok", limite: 0 },
      { requete: "ok", limite: 21 },
      { requete: "ok", limite: 2.5 },
      { requete: "ok", reclasser: "oui" },
    ]) {
      const r = await b.appeler(b.id.alice, "POST", url(), corps);
      expect([r.statut, json<Erreur>(r).code], JSON.stringify(corps).slice(0, 60)).toEqual([
        400,
        "requete_invalide",
      ]);
    }
  });
});
