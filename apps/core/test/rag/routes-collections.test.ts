// SPDX-License-Identifier: MIT
/** apps/core/test/rag/routes-collections.test.ts — routes RAG des collections (SQLite et PostgreSQL) : état, liste, création sous quota, mise à jour, suppression, publication et notifications, groupes de publication, masquage, travaux. */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { schemaCollectionVueRag, schemaReponseEtatRag } from "@elpis/contracts";
import type { CollectionVueRag, EtatRag } from "@elpis/contracts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { appliquerPublication } from "../../src/rag/acces";
import { definirQuotaRagCompte } from "../../src/rag/quotas";

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

describe.each(MOTEURS)("routes RAG : collections (%s)", (moteur) => {
  let b: Banc;

  beforeEach(async () => {
    b = await ouvrirBanc(moteur, env);
  });

  afterEach(async () => {
    await b.fermer();
  });

  const creer = async (uid: number, name: string, description?: string): Promise<CollectionVueRag> => {
    const r = await b.appeler(uid, "POST", "/api/rag/collections", {
      name,
      ...(description === undefined ? {} : { description }),
    });
    expect(r.statut, JSON.stringify(r.corps)).toBe(200);
    return schemaCollectionVueRag.parse(json<{ collection: unknown }>(r).collection);
  };

  describe("état", () => {
    it("utilisable : services joints, quotas et utilisation du compte", async () => {
      const col = await creer(b.id.alice, "Contrats");
      await indexerDirect(b, col.id, "a.pdf", [{ texte: "un" }]);
      await b.base.run("UPDATE rag_documents SET bytes = 4096 WHERE collection_id = ?", [col.id]);
      const r = await b.appeler(b.id.alice, "GET", "/api/rag/etat");
      const etat: EtatRag = schemaReponseEtatRag.parse(r.corps);
      expect(etat).toMatchObject({
        allowed: true,
        usable: true,
        reason: null,
        can_publish_all: false,
        embed: { configured: true, model: "m1" },
        extractor: { configured: true, ok: true, ocr: false, soffice: true },
        qdrant: { configured: true, ok: true },
        reranker: { enabled: false },
        quotas: { storage_mb: 2048, collections: 10, file_mb: 200, docs_per_collection: 2000 },
        usage: { storage_bytes: 4096, collections: 1, documents: 1 },
        active_jobs: 0,
      });
      expect(json<EtatRag>(await b.appeler(b.id.admin, "GET", "/api/rag/etat")).can_publish_all).toBe(true);
      env.ecrireConfig({ ocr: { url: "http://vision.test:8090" } });
      expect(json<EtatRag>(await b.appeler(b.id.alice, "GET", "/api/rag/etat")).extractor.ocr).toBe(true);
      env.ecrireConfig();
    });

    it("raison lisible : embeddings non configurés, extracteur non configuré, injoignable, Qdrant injoignable", async () => {
      const raison = async (): Promise<string | undefined> =>
        json<EtatRag>(await b.appeler(b.id.alice, "GET", "/api/rag/etat")).reason?.code;
      env.ecrireConfig({ embed: { url: "" } });
      expect(await raison()).toBe("embeddings_non_configures");
      env.ecrireConfig({ service_url: "" });
      expect(await raison()).toBe("extracteur_non_configure");
      env.ecrireConfig();
      env.rendus.santeOk = false;
      expect(await raison()).toBe("extracteur_injoignable");
      env.rendus.santeOk = true;
      env.ecrireConfig();
      b.q.panne = true;
      expect(await raison()).toBe("qdrant_injoignable");
      const e = json<EtatRag>(await b.appeler(b.id.alice, "GET", "/api/rag/etat"));
      expect(e.usable).toBe(false);
      expect(e.reason?.message).toMatch(/Qdrant/u);
    });

    it("les sondes sont gardées quelques secondes", async () => {
      await b.appeler(b.id.alice, "GET", "/api/rag/etat");
      env.rendus.santeOk = false;
      expect(json<EtatRag>(await b.appeler(b.id.alice, "GET", "/api/rag/etat")).usable).toBe(true);
    });
  });

  describe("création", () => {
    it("crée la collection (dossiers du magasin compris) et la rend telle que la liste la montre", async () => {
      const c = await creer(b.id.alice, "  Contrats 2026  ", "Contrats fournisseurs.");
      expect(c).toMatchObject({
        name: "Contrats 2026",
        description: "Contrats fournisseurs.",
        visibility: "private",
        allow_source_open: false,
        role: "proprietaire",
        owner: { id: b.id.alice, username: "alice", display_name: "alice" },
        groups: [],
        doc_count: 0,
        chunk_count: 0,
        bytes: 0,
        status: "ready",
        embed_model: "",
        chunking: {
          methode: "auto",
          unite: "jetons",
          taille: 512,
          chevauchement: 64,
          taille_max: 1200,
          par_extension: {},
        },
        ocr: false,
        hidden: false,
      });
      for (const sous of ["sources", "extraits", "pages"])
        expect(existsSync(join(env.magasin, String(b.id.alice), c.id, sous))).toBe(true);
    });

    it("nom unique par compte, à la casse près ; un autre compte peut le reprendre", async () => {
      await creer(b.id.alice, "Contrats");
      const doublon = await b.appeler(b.id.alice, "POST", "/api/rag/collections", { name: "CONTRATS" });
      expect([doublon.statut, json<Erreur>(doublon).code]).toEqual([409, "nom_deja_pris"]);
      expect((await b.appeler(b.id.bob, "POST", "/api/rag/collections", { name: "Contrats" })).statut).toBe(
        200,
      );
    });

    it("quota de collections (réglable par compte)", async () => {
      await definirQuotaRagCompte(b.base, b.id.alice, { collections: 2 });
      await creer(b.id.alice, "Une");
      await creer(b.id.alice, "Deux");
      const r = await b.appeler(b.id.alice, "POST", "/api/rag/collections", { name: "Trois" });
      expect([r.statut, json<Erreur>(r).code]).toEqual([409, "quota_collections"]);
      expect(json<Erreur>(r).detail).toMatch(/2 collection/u);
    });

    it("créations parallèles : le quota tient", async () => {
      await definirQuotaRagCompte(b.base, b.id.alice, { collections: 3 });
      const issues = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          b.appeler(b.id.alice, "POST", "/api/rag/collections", { name: `C${i}` }),
        ),
      );
      expect(issues.filter((r) => r.statut === 200)).toHaveLength(3);
      expect(issues.filter((r) => r.statut === 409)).toHaveLength(3);
    });

    it("RAG désactivé (pas d'embeddings) : 503 rag_desactive", async () => {
      env.ecrireConfig({ embed: { url: "" } });
      const r = await b.appeler(b.id.alice, "POST", "/api/rag/collections", { name: "X" });
      expect([r.statut, json<Erreur>(r).code]).toEqual([503, "rag_desactive"]);
    });

    it("corps invalides : 400 requete_invalide sans écho de la valeur reçue", async () => {
      for (const corps of [
        {},
        { name: "" },
        { name: "   " },
        { name: "x".repeat(81) },
        { name: "a\u0000b" },
        { name: "ok", description: "y".repeat(501) },
        { name: 42 },
      ]) {
        const r = await b.appeler(b.id.alice, "POST", "/api/rag/collections", corps);
        expect([r.statut, json<Erreur>(r).code], JSON.stringify(corps)).toEqual([400, "requete_invalide"]);
        expect(json<Erreur>(r).detail).not.toContain("xxxxxxxx");
      }
      const illisible = await b.app.inject({
        method: "POST",
        url: "/api/rag/collections",
        headers: { "x-uid": String(b.id.alice), "content-type": "application/json" },
        payload: "{pas du json",
      });
      expect([illisible.statusCode, illisible.json<Erreur>().code]).toEqual([400, "requete_invalide"]);
    });
  });

  describe("liste et lecture", () => {
    it("les miennes (par nom) puis celles partagées avec moi, avec rôle, auteur et groupes seulement pour l'auteur", async () => {
      const m2 = await creer(b.id.bob, "Zèbre");
      const m1 = await creer(b.id.bob, "Abeille");
      const a1 = await creer(b.id.alice, "Contrats");
      await creer(b.id.alice, "Brouillon");
      await appliquerPublication(b.base, b.id.alice, a1.id, {
        visibility: "groups",
        group_ids: [b.groupe.A],
        allow_source_open: true,
      });
      const r = await b.appeler(b.id.bob, "GET", "/api/rag/collections");
      const { collections } = json<{ collections: CollectionVueRag[] }>(r);
      expect(collections.map((c) => [c.name, c.role])).toEqual([
        ["Abeille", "proprietaire"],
        ["Zèbre", "proprietaire"],
        ["Contrats", "lecteur"],
      ]);
      expect(collections.map((c) => c.id)).toEqual([m1.id, m2.id, a1.id]);
      const partagee = collections[2] as CollectionVueRag;
      expect(partagee).toMatchObject({
        owner: { id: b.id.alice, username: "alice" },
        visibility: "groups",
        allow_source_open: true,
        groups: [],
        hidden: false,
      });
      const chezAlice = json<{ collections: CollectionVueRag[] }>(
        await b.appeler(b.id.alice, "GET", "/api/rag/collections"),
      ).collections;
      expect(chezAlice.find((c) => c.name === "Contrats")?.groups).toEqual([
        { id: b.groupe.A, name: "Juristes", members: 2 },
      ]);
      for (const c of collections) schemaCollectionVueRag.parse(c);
    });

    it("pas de collection d'un autre groupe ni d'un autre compte privé", async () => {
      await creer(b.id.alice, "Privée");
      const pub = await creer(b.id.alice, "Publiée");
      await appliquerPublication(b.base, b.id.alice, pub.id, {
        visibility: "groups",
        group_ids: [b.groupe.A],
        allow_source_open: false,
      });
      for (const uid of [b.id.carol, b.id.admin, b.id.dave])
        expect(
          json<{ collections: unknown[] }>(await b.appeler(uid, "GET", "/api/rag/collections")).collections,
        ).toEqual([]);
    });

    it("les compteurs de la collection viennent des documents indexés", async () => {
      const c = await creer(b.id.alice, "Compteurs");
      await indexerDirect(b, c.id, "a.pdf", [{ texte: "un" }, { texte: "deux" }]);
      const lue = json<{ collection: CollectionVueRag }>(
        await b.appeler(b.id.alice, "GET", `/api/rag/collections/${c.id}`),
      ).collection;
      expect(lue).toMatchObject({ doc_count: 1, chunk_count: 2, embed_model: "m1" });
    });
  });

  describe("mise à jour", () => {
    it("nom, description, découpage avec règles par extension puis défaut, OCR", async () => {
      const c = await creer(b.id.alice, "Avant");
      const regle = {
        methode: "regex",
        valeur: "^Article",
        unite: "caracteres",
        taille: 800,
        chevauchement: 0,
        taille_max: 2000,
      };
      const chunking = {
        methode: "phrase",
        valeur: "ignorée",
        unite: "jetons",
        taille: 256,
        chevauchement: 32,
        taille_max: 1200,
        par_extension: { pdf: regle, md: { ...regle, methode: "markdown", valeur: "ignorée" } },
      };
      const r = await b.appeler(b.id.alice, "PATCH", `/api/rag/collections/${c.id}`, {
        name: "Après",
        description: "Texte\nsur deux lignes",
        chunking,
        ocr: true,
      });
      expect(r.statut, JSON.stringify(r.corps)).toBe(200);
      const apres = json<{ collection: CollectionVueRag; job: unknown }>(r);
      expect(apres.collection).toMatchObject({
        name: "Après",
        description: "Texte\nsur deux lignes",
        chunking: {
          methode: "phrase",
          unite: "jetons",
          taille: 256,
          chevauchement: 32,
          taille_max: 1200,
          par_extension: {
            md: { methode: "markdown", unite: "caracteres", taille: 800, chevauchement: 0, taille_max: 2000 },
            pdf: regle,
          },
        },
        ocr: true,
      });
      expect(apres.collection.chunking).not.toHaveProperty("valeur");
      expect(apres.collection.chunking.par_extension.md).not.toHaveProperty("valeur");
      expect(apres.job).toBeNull();
      const retour = json<{ collection: CollectionVueRag }>(
        await b.appeler(b.id.alice, "PATCH", `/api/rag/collections/${c.id}`, {
          chunking: { methode: "auto", unite: "jetons", taille: 512, chevauchement: 64, taille_max: 1200 },
        }),
      ).collection;
      expect(retour.chunking).toEqual({
        methode: "auto",
        unite: "jetons",
        taille: 512,
        chevauchement: 64,
        taille_max: 1200,
        par_extension: {},
      });
    });

    it("renommer vers un nom pris : 409 ; vers son propre nom : accepté", async () => {
      const a = await creer(b.id.alice, "Alpha");
      await creer(b.id.alice, "Beta");
      const pris = await b.appeler(b.id.alice, "PATCH", `/api/rag/collections/${a.id}`, { name: "beta" });
      expect([pris.statut, json<Erreur>(pris).code]).toEqual([409, "nom_deja_pris"]);
      expect(
        (await b.appeler(b.id.alice, "PATCH", `/api/rag/collections/${a.id}`, { name: "Alpha" })).statut,
      ).toBe(200);
    });

    it("changer le découpage lance la réindexation des documents prêts ; sans changement réel, rien", async () => {
      const c = await creer(b.id.alice, "Découpage");
      const doc = await indexerDirect(b, c.id, "a.pdf", [{ texte: "un" }]);
      const meme = json<{ job: unknown }>(
        await b.appeler(b.id.alice, "PATCH", `/api/rag/collections/${c.id}`, {
          chunking: {
            methode: "auto",
            unite: "jetons",
            taille: 512,
            chevauchement: 64,
            taille_max: 1200,
            par_extension: {},
          },
        }),
      );
      expect(meme.job).toBeNull();
      const change = json<{ job: { kind: string; total: number; status: string } | null }>(
        await b.appeler(b.id.alice, "PATCH", `/api/rag/collections/${c.id}`, {
          chunking: {
            methode: "taille",
            unite: "caracteres",
            taille: 600,
            chevauchement: 60,
            taille_max: 900,
          },
        }),
      );
      expect(change.job).toMatchObject({ kind: "reindex", total: 1, status: "queued" });
      expect((await b.base.get("SELECT status FROM rag_documents WHERE id=?", [doc]))?.["status"]).toBe(
        "pending",
      );
    });

    it("activer l'OCR relance les documents sans texte", async () => {
      const c = await creer(b.id.alice, "Scans");
      const sans = await indexerDirect(b, c.id, "scan.pdf", [{ texte: "x" }]);
      const bon = await indexerDirect(b, c.id, "bon.pdf", [{ texte: "y" }]);
      await b.base.run(
        "UPDATE rag_documents SET status='error', error_code='no_text', error_message='Sans texte', chunk_count=0 WHERE id=?",
        [sans],
      );
      const r = json<{ job: { kind: string; total: number } | null }>(
        await b.appeler(b.id.alice, "PATCH", `/api/rag/collections/${c.id}`, { ocr: true }),
      );
      expect(r.job).toMatchObject({ total: 1 });
      expect((await b.base.get("SELECT status FROM rag_documents WHERE id=?", [sans]))?.["status"]).toBe(
        "pending",
      );
      expect((await b.base.get("SELECT status FROM rag_documents WHERE id=?", [bon]))?.["status"]).toBe(
        "ready",
      );
      const encore = json<{ job: unknown }>(
        await b.appeler(b.id.alice, "PATCH", `/api/rag/collections/${c.id}`, { ocr: true }),
      );
      expect(encore.job).toBeNull();
    });

    it("découpage hors bornes ou incohérent : 400 ; regex invalide : 400 regex_invalide sans écho", async () => {
      const c = await creer(b.id.alice, "Bornes");
      const p = { methode: "taille", unite: "jetons", taille: 500, chevauchement: 50, taille_max: 900 };
      for (const chunking of [
        { mode: "manuel", chunk_tokens: 256, overlap_tokens: 32 },
        { ...p, taille: 10 },
        { ...p, chevauchement: 250 },
        { ...p, taille: 30000 },
        { ...p, taille_max: 400 },
        { ...p, methode: "bizarre" },
        { ...p, methode: "separateur" },
        { ...p, par_extension: { exe: p } },
      ]) {
        const r = await b.appeler(b.id.alice, "PATCH", `/api/rag/collections/${c.id}`, { chunking });
        expect([r.statut, json<Erreur>(r).code], JSON.stringify(chunking)).toEqual([400, "requete_invalide"]);
      }
      for (const chunking of [
        { ...p, methode: "regex", valeur: "(secret[" },
        { ...p, par_extension: { md: { ...p, methode: "regex", valeur: "(secret[" } } },
      ]) {
        const r = await b.appeler(b.id.alice, "PATCH", `/api/rag/collections/${c.id}`, { chunking });
        expect([r.statut, json<Erreur>(r).code]).toEqual([400, "regex_invalide"]);
        expect(json<Erreur>(r).detail).not.toContain("secret");
      }
      expect(
        json<{ collection: CollectionVueRag }>(
          await b.appeler(b.id.alice, "GET", `/api/rag/collections/${c.id}`),
        ).collection.chunking.methode,
      ).toBe("auto");
    });

    it("relit l'ancienne forme de `chunk_json` (auto, manuel, illisible)", async () => {
      const c = await creer(b.id.alice, "Ancienne");
      const vue = async (chunk: string): Promise<unknown> => {
        await b.base.run("UPDATE rag_collections SET chunk_json=? WHERE id=?", [chunk, c.id]);
        const col = json<{ collection: CollectionVueRag }>(
          await b.appeler(b.id.alice, "GET", `/api/rag/collections/${c.id}`),
        ).collection;
        return schemaCollectionVueRag.parse(col).chunking;
      };
      expect(await vue(JSON.stringify({ mode: "auto", chunk_tokens: 512, overlap_tokens: 64 }))).toEqual({
        methode: "auto",
        unite: "jetons",
        taille: 512,
        chevauchement: 64,
        taille_max: 1200,
        par_extension: {},
      });
      expect(await vue(JSON.stringify({ mode: "manuel", chunk_tokens: 256, overlap_tokens: 32 }))).toEqual({
        methode: "auto",
        unite: "jetons",
        taille: 256,
        chevauchement: 32,
        taille_max: 1200,
        par_extension: {},
      });
      expect(await vue(JSON.stringify({ mode: "manuel", chunk_tokens: 2048, overlap_tokens: 500 }))).toEqual({
        methode: "auto",
        unite: "jetons",
        taille: 2048,
        chevauchement: 500,
        taille_max: 2048,
        par_extension: {},
      });
      expect(
        await vue(JSON.stringify({ mode: "manuel", chunk_tokens: 128, overlap_tokens: 100 })),
      ).toMatchObject({
        taille: 128,
        chevauchement: 63,
      });
      for (const illisible of [
        "{",
        "[]",
        JSON.stringify({ mode: "manuel", chunk_tokens: 10, overlap_tokens: 0 }),
        JSON.stringify({ methode: "regex", unite: "jetons", taille: 100, chevauchement: 0, taille_max: 100 }),
      ])
        expect(await vue(illisible)).toEqual({
          methode: "auto",
          unite: "jetons",
          taille: 512,
          chevauchement: 64,
          taille_max: 1200,
          par_extension: {},
        });
    });
  });

  describe("suppression", () => {
    it("supprime la ligne, les documents, le dossier du magasin et la collection Qdrant", async () => {
      const c = await creer(b.id.alice, "À supprimer");
      await indexerDirect(b, c.id, "a.pdf", [{ texte: "un" }]);
      expect(b.q.collections.size).toBe(1);
      const r = await b.appeler(b.id.alice, "DELETE", `/api/rag/collections/${c.id}`);
      expect([r.statut, r.corps]).toEqual([200, { ok: true }]);
      expect(b.q.collections.size).toBe(0);
      expect(existsSync(join(env.magasin, String(b.id.alice), c.id))).toBe(false);
      expect(await b.base.get("SELECT id FROM rag_collections WHERE id=?", [c.id])).toBeUndefined();
      expect((await b.appeler(b.id.alice, "GET", `/api/rag/collections/${c.id}`)).statut).toBe(404);
    });
  });

  describe("publication", () => {
    const publier = (uid: number, id: string, corps: unknown) =>
      b.appeler(uid, "PUT", `/api/rag/collections/${id}/publication`, corps);

    it("un utilisateur publie aux groupes dont il est membre : les membres gagnent l'accès et sont prévenus une fois", async () => {
      const c = await creer(b.id.alice, "Contrats");
      const r = await publier(b.id.alice, c.id, {
        visibility: "groups",
        group_ids: [b.groupe.A],
        allow_source_open: false,
      });
      expect(r.statut, JSON.stringify(r.corps)).toBe(200);
      const { collection, notified } = json<{ collection: CollectionVueRag; notified: number }>(r);
      expect(notified).toBe(1);
      expect(collection).toMatchObject({
        visibility: "groups",
        groups: [{ id: b.groupe.A, name: "Juristes", members: 2 }],
      });
      expect(b.notifications).toEqual([
        {
          uid: b.id.bob,
          title: "alice a partagé la collection Contrats avec vous",
          body: expect.any(String),
          collectionId: c.id,
        },
      ]);
      expect((await b.appeler(b.id.bob, "GET", `/api/rag/collections/${c.id}`)).statut).toBe(200);
      expect((await b.appeler(b.id.carol, "GET", `/api/rag/collections/${c.id}`)).statut).toBe(404);
      const encore = await publier(b.id.alice, c.id, {
        visibility: "groups",
        group_ids: [b.groupe.A],
        allow_source_open: true,
      });
      expect(json<{ notified: number }>(encore).notified).toBe(0);
      expect(b.notifications).toHaveLength(1);
    });

    it("sans notificateur de remplacement, le partage crée une vraie notification pour chaque nouveau lecteur", async () => {
      const reel = await ouvrirBanc(moteur, env, { notifierReel: true });
      try {
        const c = json<{ collection: CollectionVueRag }>(
          await reel.appeler(reel.id.alice, "POST", "/api/rag/collections", { name: "Contrats" }),
        ).collection;
        await reel.appeler(reel.id.alice, "PUT", `/api/rag/collections/${c.id}/publication`, {
          visibility: "groups",
          group_ids: [reel.groupe.A],
          allow_source_open: false,
        });
        const lignes = await reel.base.all(
          "SELECT owner_user_id, kind, title, ref_type, ref_id FROM notifications ORDER BY id",
        );
        expect(lignes).toEqual([
          {
            owner_user_id: reel.id.bob,
            kind: "rag_share",
            title: "alice a partagé la collection Contrats avec vous",
            ref_type: "rag_collection",
            ref_id: c.id,
          },
        ]);
      } finally {
        await reel.fermer();
      }
    });

    it("une notification de partage qui échoue ne fait pas échouer la publication", async () => {
      const panne = await ouvrirBanc(moteur, env, { notifierEnEchec: true });
      try {
        const c = json<{ collection: CollectionVueRag }>(
          await panne.appeler(panne.id.alice, "POST", "/api/rag/collections", { name: "Contrats" }),
        ).collection;
        const r = await panne.appeler(panne.id.alice, "PUT", `/api/rag/collections/${c.id}/publication`, {
          visibility: "groups",
          group_ids: [panne.groupe.A],
          allow_source_open: false,
        });
        expect([r.statut, json<{ notified: number }>(r).notified]).toEqual([200, 0]);
        expect((await panne.appeler(panne.id.bob, "GET", `/api/rag/collections/${c.id}`)).statut).toBe(200);
      } finally {
        await panne.fermer();
      }
    });

    it("refus : utilisateur vers tous, groupe dont il n'est pas membre, groupe inconnu, corps invalide", async () => {
      const c = await creer(b.id.alice, "Contrats");
      const tous = await publier(b.id.alice, c.id, {
        visibility: "all",
        group_ids: [],
        allow_source_open: false,
      });
      expect([tous.statut, json<Erreur>(tous).code]).toEqual([403, "tous_reserve_admin"]);
      const etranger = await publier(b.id.alice, c.id, {
        visibility: "groups",
        group_ids: [b.groupe.B],
        allow_source_open: false,
      });
      expect([etranger.statut, json<Erreur>(etranger).code]).toEqual([403, "groupe_non_membre"]);
      const inconnu = await publier(b.id.alice, c.id, {
        visibility: "groups",
        group_ids: [9999],
        allow_source_open: false,
      });
      expect([inconnu.statut, json<Erreur>(inconnu).code]).toEqual([403, "groupe_non_membre"]);
      const vide = await publier(b.id.alice, c.id, {
        visibility: "groups",
        group_ids: [],
        allow_source_open: false,
      });
      expect([vide.statut, json<Erreur>(vide).code]).toEqual([400, "groupes_requis"]);
      for (const corps of [
        {},
        { visibility: "x", group_ids: [], allow_source_open: false },
        { visibility: "private" },
      ]) {
        const r = await publier(b.id.alice, c.id, corps);
        expect([r.statut, json<Erreur>(r).code], JSON.stringify(corps)).toEqual([400, "requete_invalide"]);
      }
      expect(b.notifications).toEqual([]);
      expect((await b.appeler(b.id.bob, "GET", `/api/rag/collections/${c.id}`)).statut).toBe(404);
    });

    it("un administrateur publie à tous les comptes (chacun est prévenu) ou à n'importe quel groupe", async () => {
      const c = await creer(b.id.admin, "Charte");
      const r = await publier(b.id.admin, c.id, {
        visibility: "all",
        group_ids: [],
        allow_source_open: false,
      });
      expect(json<{ notified: number }>(r).notified).toBe(4);
      expect(b.notifications.map((n) => n.uid).sort()).toEqual(
        [b.id.alice, b.id.bob, b.id.carol, b.id.dave].sort(),
      );
      for (const uid of [b.id.alice, b.id.carol, b.id.dave])
        expect((await b.appeler(uid, "GET", `/api/rag/collections/${c.id}`)).statut).toBe(200);
      const groupe = await publier(b.id.admin, c.id, {
        visibility: "groups",
        group_ids: [b.groupe.B],
        allow_source_open: false,
      });
      expect(groupe.statut).toBe(200);
      expect((await b.appeler(b.id.alice, "GET", `/api/rag/collections/${c.id}`)).statut).toBe(404);
      expect((await b.appeler(b.id.carol, "GET", `/api/rag/collections/${c.id}`)).statut).toBe(200);
    });

    it("les comptes sans droit RAG ne sont pas prévenus ; repasser en privé révoque aussitôt l'accès", async () => {
      const c = await creer(b.id.admin, "Charte");
      env.ecrireConfig({ groups: [b.groupe.A] });
      await publier(b.id.admin, c.id, { visibility: "all", group_ids: [], allow_source_open: false });
      expect(b.notifications.map((n) => n.uid).sort()).toEqual([b.id.alice, b.id.bob].sort());
      await publier(b.id.admin, c.id, { visibility: "private", group_ids: [], allow_source_open: false });
      expect((await b.appeler(b.id.bob, "GET", `/api/rag/collections/${c.id}`)).statut).toBe(404);
    });

    it("publication par un lecteur ou un tiers : 403 lecture_seule / 404", async () => {
      const c = await creer(b.id.alice, "Contrats");
      await publier(b.id.alice, c.id, {
        visibility: "groups",
        group_ids: [b.groupe.A],
        allow_source_open: false,
      });
      const corps = { visibility: "all", group_ids: [], allow_source_open: true };
      expect(json<Erreur>(await publier(b.id.bob, c.id, corps)).code).toBe("lecture_seule");
      expect((await publier(b.id.carol, c.id, corps)).statut).toBe(404);
    });
  });

  describe("groupes de publication", () => {
    it("un utilisateur : ses groupes avec leurs effectifs ; un administrateur : tous, et « tous les comptes »", async () => {
      const u = json<{
        groups: { id: number; name: string; members: number }[];
        can_publish_all: boolean;
        accounts: number;
      }>(await b.appeler(b.id.alice, "GET", "/api/rag/groupes-publication"));
      expect(u).toEqual({
        groups: [{ id: b.groupe.A, name: "Juristes", members: 2 }],
        can_publish_all: false,
        accounts: 5,
      });
      const a = json<typeof u>(await b.appeler(b.id.admin, "GET", "/api/rag/groupes-publication"));
      expect(a.groups.map((g) => g.name)).toEqual(["Finance", "Juristes"]);
      expect(a.can_publish_all).toBe(true);
      const dave = json<typeof u>(await b.appeler(b.id.dave, "GET", "/api/rag/groupes-publication"));
      expect(dave.groups).toEqual([]);
    });
  });

  describe("masquage", () => {
    it("masque pour soi seulement ; la liste l'exclut, ?masquees=1 le rend marqué ; ré-afficher le remet", async () => {
      const c = await creer(b.id.alice, "Contrats");
      await appliquerPublication(b.base, b.id.alice, c.id, {
        visibility: "groups",
        group_ids: [b.groupe.A],
        allow_source_open: false,
      });
      const masque = await b.appeler(b.id.bob, "PUT", `/api/rag/collections/${c.id}/masquage`, {
        hidden: true,
      });
      expect(json<{ collection: CollectionVueRag }>(masque).collection.hidden).toBe(true);
      const liste = async (uid: number, q = ""): Promise<CollectionVueRag[]> =>
        json<{ collections: CollectionVueRag[] }>(await b.appeler(uid, "GET", `/api/rag/collections${q}`))
          .collections;
      expect(await liste(b.id.bob)).toEqual([]);
      expect((await liste(b.id.bob, "?masquees=1")).map((x) => [x.name, x.hidden])).toEqual([
        ["Contrats", true],
      ]);
      expect((await liste(b.id.alice)).map((x) => x.name)).toEqual(["Contrats"]);
      expect((await b.appeler(b.id.bob, "GET", `/api/rag/collections/${c.id}`)).statut).toBe(200);
      const redonne = await b.appeler(b.id.bob, "PUT", `/api/rag/collections/${c.id}/masquage`, {
        hidden: false,
      });
      expect(json<{ collection: CollectionVueRag }>(redonne).collection.hidden).toBe(false);
      expect((await liste(b.id.bob)).map((x) => x.name)).toEqual(["Contrats"]);
    });

    it("un tiers ne peut pas masquer ce qu'il ne voit pas ; corps invalide : 400", async () => {
      const c = await creer(b.id.alice, "Contrats");
      expect(
        (await b.appeler(b.id.carol, "PUT", `/api/rag/collections/${c.id}/masquage`, { hidden: true }))
          .statut,
      ).toBe(404);
      expect(
        (await b.appeler(b.id.alice, "PUT", `/api/rag/collections/${c.id}/masquage`, { hidden: "oui" }))
          .statut,
      ).toBe(400);
    });
  });

  describe("travaux", () => {
    it("liste, suspension, reprise et annulation de mes travaux ; ceux des autres restent introuvables", async () => {
      const c = await creer(b.id.alice, "Contrats");
      const dep = await b.televerser(b.id.alice, `/api/rag/collections/${c.id}/documents`, [
        { nom: "a.txt", contenu: "Le contrat se renouvelle." },
      ]);
      const job = json<{ job: { id: string; status: string } }>(dep).job;
      expect(job.status).toBe("queued");
      const liste = json<{ jobs: { id: string }[] }>(
        await b.appeler(b.id.alice, "GET", "/api/rag/travaux?actifs=1"),
      );
      expect(liste.jobs.map((j) => j.id)).toEqual([job.id]);
      expect(
        json<{ jobs: unknown[] }>(
          await b.appeler(b.id.alice, "GET", `/api/rag/travaux?collection_id=${c.id}&limite=5`),
        ).jobs,
      ).toHaveLength(1);
      expect(json<{ jobs: unknown[] }>(await b.appeler(b.id.bob, "GET", "/api/rag/travaux")).jobs).toEqual(
        [],
      );
      const etranger = await b.appeler(b.id.bob, "POST", `/api/rag/travaux/${job.id}/annuler`);
      expect([etranger.statut, json<Erreur>(etranger).code]).toEqual([404, "travail_introuvable"]);
      const susp = await b.appeler(b.id.alice, "POST", `/api/rag/travaux/${job.id}/suspendre`);
      expect(json<{ job: { status: string } }>(susp).job.status).toBe("paused");
      const repris = await b.appeler(b.id.alice, "POST", `/api/rag/travaux/${job.id}/reprendre`);
      expect(json<{ job: { status: string } }>(repris).job.status).toBe("queued");
      const annule = await b.appeler(b.id.alice, "POST", `/api/rag/travaux/${job.id}/annuler`);
      expect(json<{ job: { status: string } }>(annule).job.status).toBe("cancelled");
      const termine = await b.appeler(b.id.alice, "POST", `/api/rag/travaux/${job.id}/reprendre`);
      expect([termine.statut, json<Erreur>(termine).code]).toEqual([409, "travail_termine"]);
      expect(
        json<{ jobs: unknown[] }>(await b.appeler(b.id.alice, "GET", "/api/rag/travaux?actifs=1")).jobs,
      ).toEqual([]);
    });

    it("un lecteur ne pilote pas le travail du propriétaire ; requête invalide : 400", async () => {
      const c = await creer(b.id.alice, "Contrats");
      await appliquerPublication(b.base, b.id.alice, c.id, {
        visibility: "groups",
        group_ids: [b.groupe.A],
        allow_source_open: false,
      });
      const dep = await b.televerser(b.id.alice, `/api/rag/collections/${c.id}/documents`, [
        { nom: "a.txt", contenu: "Texte." },
      ]);
      const id = json<{ job: { id: string } }>(dep).job.id;
      expect((await b.appeler(b.id.bob, "POST", `/api/rag/travaux/${id}/suspendre`)).statut).toBe(404);
      expect((await b.appeler(b.id.alice, "GET", "/api/rag/travaux?collection_id=x")).statut).toBe(400);
      expect((await b.appeler(b.id.alice, "GET", "/api/rag/travaux?actifs=peut-etre")).statut).toBe(400);
    });
  });

  it("une collection d'un compte créée en direct en base reste cohérente avec la liste", async () => {
    const id = await creerCollection(b.base, b.id.bob, "Directe");
    const liste = json<{ collections: CollectionVueRag[] }>(
      await b.appeler(b.id.bob, "GET", "/api/rag/collections"),
    );
    expect(liste.collections.map((c) => c.id)).toEqual([id]);
  });
});
