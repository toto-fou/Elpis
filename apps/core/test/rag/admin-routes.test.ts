// SPDX-License-Identifier: MIT
/** apps/core/test/rag/admin-routes.test.ts — console du RAG (SQLite et PostgreSQL) : droits (non-admin et modérateur refusés), aucun contenu rendu, état et essais des services, liste des collections, suppression, quotas par compte. */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { schemaReponseCollectionsAdminRag, schemaReponseEtatAdminRag } from "@elpis/contracts";
import type { CollectionAdminRag } from "@elpis/contracts";
import { configureAudit, oublierConfigurationAudit } from "@elpis/securite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ecrireReglages } from "../../src/comptes/reglages";
import { USER_SETTINGS_ALLOWED } from "../../src/comptes/reglages";
import { oublierSondesAdminRag } from "../../src/rag/admin";
import { journalMuet, lignesAuditRecentes } from "../aides";
import { ajouterConsole } from "./aides-admin";
import type { BancAdmin } from "./aides-admin";
import { demarrerFauxEmbeddings, flux } from "./aides-indexation";
import { demarrerEnvironnement, indexerDirect, json, MOTEURS, ouvrirBanc } from "./aides-routes";
import type { Environnement } from "./aides-routes";

let env: Environnement;
let dossierAudit = "";

beforeAll(async () => {
  env = await demarrerEnvironnement();
  dossierAudit = mkdtempSync(join(tmpdir(), "elpis-rag-audit-"));
  configureAudit({ auditDir: dossierAudit, hmacKeyPath: join(dossierAudit, "cle") });
});

afterAll(async () => {
  oublierConfigurationAudit();
  rmSync(dossierAudit, { recursive: true, force: true });
  await env.arreter();
});

interface Erreur {
  detail: string;
  code?: string;
}

const MARQUEUR = "SECRET-ALICE-4242";
const DOC_SECRET = "contrat-secret-alice.pdf";
const DESCRIPTION_SECRETE = "description-confidentielle-alice";
const UUID_ABSENT = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

describe.each(MOTEURS)("console RAG : routes (%s)", (moteur) => {
  let b: BancAdmin;

  beforeEach(async () => {
    oublierSondesAdminRag();
    b = await ajouterConsole(await ouvrirBanc(moteur, env));
  });

  afterEach(async () => {
    await b.fermer();
  });

  const collection = async (uid: number, nom: string): Promise<string> => {
    const r = await b.appeler(uid, "POST", "/api/rag/collections", {
      name: nom,
      description: DESCRIPTION_SECRETE,
    });
    expect(r.statut, JSON.stringify(r.corps)).toBe(200);
    return json<{ collection: { id: string } }>(r).collection.id;
  };

  describe("droits", () => {
    const CAS: readonly { nom: string; methode: string; chemin: string; corps?: unknown; admin: number }[] = [
      { nom: "état", methode: "GET", chemin: "/api/admin/rag/etat", admin: 200 },
      { nom: "essai", methode: "POST", chemin: "/api/admin/rag/essai/qdrant", corps: {}, admin: 200 },
      { nom: "collections", methode: "GET", chemin: "/api/admin/rag/collections", admin: 200 },
      {
        nom: "supprimer",
        methode: "DELETE",
        chemin: "/api/admin/rag/collections/{c}",
        corps: { name: "mauvais nom" },
        admin: 400,
      },
      { nom: "comptes", methode: "GET", chemin: "/api/admin/rag/comptes", admin: 200 },
      {
        nom: "quota",
        methode: "PUT",
        chemin: "/api/admin/rag/comptes/{u}/quota",
        corps: { storage_mb: -1 },
        admin: 400,
      },
      { nom: "réindexation", methode: "GET", chemin: "/api/admin/rag/reindexation", admin: 200 },
      { nom: "réindexer", methode: "POST", chemin: "/api/admin/rag/reindexer", corps: {}, admin: 200 },
      { nom: "travaux", methode: "GET", chemin: "/api/admin/rag/travaux", admin: 200 },
      {
        nom: "suspendre",
        methode: "POST",
        chemin: `/api/admin/rag/travaux/${UUID_ABSENT}/suspendre`,
        admin: 404,
      },
      {
        nom: "reprendre",
        methode: "POST",
        chemin: `/api/admin/rag/travaux/${UUID_ABSENT}/reprendre`,
        admin: 404,
      },
      {
        nom: "annuler",
        methode: "POST",
        chemin: `/api/admin/rag/travaux/${UUID_ABSENT}/annuler`,
        admin: 404,
      },
    ];

    it("sans session 401, un compte ordinaire, un modérateur et un propriétaire de collection 403 ; l'admin passe la garde sur chaque route", async () => {
      const c = await collection(b.id.alice, "Privée");
      const chemin = (p: string): string => p.replace("{c}", c).replace("{u}", String(b.id.alice));
      for (const cas of CAS) {
        const url = chemin(cas.chemin);
        expect((await b.appelerAdmin(null, cas.methode, url, cas.corps)).statut, `${cas.nom} anonyme`).toBe(
          401,
        );
        for (const [qui, uid] of [
          ["ordinaire", b.id.bob],
          ["propriétaire", b.id.alice],
          ["modérateur", b.moderateur],
        ] as const) {
          const r = await b.appelerAdmin(uid, cas.methode, url, cas.corps);
          expect(r.statut, `${cas.nom} ${qui}`).toBe(403);
          expect(json<Erreur>(r).detail).toBe("Admin required");
        }
        expect(
          (await b.appelerAdmin(b.id.admin, cas.methode, url, cas.corps)).statut,
          `${cas.nom} admin`,
        ).toBe(cas.admin);
      }
      const [ligne] = await b.base.valeurs<[unknown]>("SELECT COUNT(*) FROM rag_collections");
      expect(Number(ligne?.[0])).toBe(1);
    });

    it("l'admin n'a aucun accès implicite par les routes du compte : la collection privée d'autrui reste introuvable", async () => {
      const c = await collection(b.id.alice, "Privée");
      for (const [m, p] of [
        ["GET", `/api/rag/collections/${c}`],
        ["GET", `/api/rag/collections/${c}/documents`],
        ["POST", `/api/rag/collections/${c}/recherche`],
        ["DELETE", `/api/rag/collections/${c}`],
      ] as const) {
        const r = await b.appeler(b.id.admin, m, p, m === "POST" ? { requete: "x" } : undefined);
        expect(r.statut, `${m} ${p}`).toBe(404);
      }
    });
  });

  describe("aucun contenu", () => {
    it("ni document, ni passage, ni description dans aucune réponse de la console", async () => {
      const c = await collection(b.id.alice, "Dossier médical");
      await indexerDirect(b, c, DOC_SECRET, [{ texte: `${MARQUEUR} contenu du passage` }]);
      const reponses: string[] = [];
      for (const url of [
        "/api/admin/rag/etat",
        "/api/admin/rag/collections",
        `/api/admin/rag/collections?q=${MARQUEUR}`,
        "/api/admin/rag/comptes",
        "/api/admin/rag/reindexation",
        "/api/admin/rag/travaux",
      ]) {
        const r = await b.appelerAdmin(b.id.admin, "GET", url);
        expect(r.statut, url).toBe(200);
        reponses.push(r.brut.toString("utf8"));
      }
      reponses.push(
        (await b.appelerAdmin(b.id.admin, "POST", "/api/admin/rag/reindexer", { force: true })).brut.toString(
          "utf8",
        ),
      );
      const tout = reponses.join("\n");
      for (const interdit of [MARQUEUR, DOC_SECRET, DESCRIPTION_SECRETE, "contenu du passage"])
        expect(tout, interdit).not.toContain(interdit);
      const liste = schemaReponseCollectionsAdminRag.parse(
        (await b.appelerAdmin(b.id.admin, "GET", "/api/admin/rag/collections")).corps,
      );
      expect(Object.keys(liste.collections[0] ?? {}).sort()).toEqual(
        [
          "allow_source_open",
          "bytes",
          "chunk_count",
          "created_at",
          "doc_count",
          "embed_model",
          "groups",
          "id",
          "job",
          "last_indexed_at",
          "name",
          "owner",
          "status",
          "updated_at",
          "visibility",
        ].sort(),
      );
    });

    it("aucune route de la console ne sait lire un document : les chemins de contenu n'existent pas", async () => {
      const c = await collection(b.id.alice, "Privée");
      for (const [m, p] of [
        ["GET", `/api/admin/rag/collections/${c}`],
        ["GET", `/api/admin/rag/collections/${c}/documents`],
        ["GET", `/api/admin/rag/collections/${c}/passages`],
        ["POST", `/api/admin/rag/collections/${c}/recherche`],
      ] as const)
        expect([404, 405], `${m} ${p}`).toContain(
          (await b.appelerAdmin(b.id.admin, m, p, m === "POST" ? {} : undefined)).statut,
        );
    });
  });

  describe("état et essais", () => {
    it("services joints : extracteur, Qdrant, embeddings, reclassement, groupes, quotas, totaux", async () => {
      const c = await collection(b.id.alice, "Contrats");
      await indexerDirect(b, c, "a.pdf", [{ texte: "un" }]);
      env.ecrireConfig({
        groups: [b.groupe.A],
        quotas: { storage_mb: 100, collections: 3, file_mb: 5, docs_per_collection: 20 },
        indexation: { concurrence: 4, par_compte: 2 },
        reranker: { enabled: true, url: "http://reranker.test", model: "rr" },
      });
      const r = await b.appelerAdmin(b.id.admin, "GET", "/api/admin/rag/etat");
      expect(r.statut).toBe(200);
      const etat = schemaReponseEtatAdminRag.parse(r.corps);
      expect(etat).toMatchObject({
        enabled: true,
        extractor: { configured: true, ok: true, version: "test", soffice: true, ocr: true },
        qdrant: { configured: true, url: "http://qdrant.test", ok: true, version: "test" },
        embed: { configured: true, model: "m1", has_api_key: false },
        reranker: { enabled: true, url: "http://reranker.test", model: "rr" },
        groups: [b.groupe.A],
        quotas: { storage_mb: 100, collections: 3, file_mb: 5, docs_per_collection: 20 },
        indexation: { concurrence: 4, par_compte: 2, jobs: { queued: 0, running: 0, paused: 0 } },
        totals: { collections: 1, documents: 1, owners: 1 },
      });
      expect(etat.quotas_max.collections).toBeGreaterThan(1000);
    });

    it("extracteur injoignable, RAG sans embeddings : l'état le dit sans erreur HTTP", async () => {
      env.rendus.santeOk = false;
      env.ecrireConfig({ embed: { url: "" } });
      const etat = schemaReponseEtatAdminRag.parse(
        (await b.appelerAdmin(b.id.admin, "GET", "/api/admin/rag/etat")).corps,
      );
      expect(etat.enabled).toBe(false);
      expect(etat.extractor).toMatchObject({ configured: true, ok: false });
      expect(etat.extractor.error).toMatch(/500/u);
      expect(etat.embed).toMatchObject({ configured: false, url: "" });
    });

    it("essai des embeddings : dimension du serveur, formulaire prioritaire, adresse invalide ou morte ; la clé enregistrée ne part pas ailleurs", async () => {
      env.emb.dimensions.set("m1", 8);
      const ok = await b.appelerAdmin(b.id.admin, "POST", "/api/admin/rag/essai/embeddings", {});
      expect(ok.corps).toMatchObject({ ok: true, service: "embeddings", dimension: 8 });
      const autre = await b.appelerAdmin(b.id.admin, "POST", "/api/admin/rag/essai/embeddings", {
        model: "autre",
      });
      expect(autre.corps).toMatchObject({ ok: true });
      expect(env.emb.modeles).toContain("autre");
      for (const url of ["ftp://x", "pas une adresse"])
        expect(
          (await b.appelerAdmin(b.id.admin, "POST", "/api/admin/rag/essai/embeddings", { url })).corps,
        ).toMatchObject({ ok: false, service: "embeddings" });
      const morte = await b.appelerAdmin(b.id.admin, "POST", "/api/admin/rag/essai/embeddings", {
        url: "http://127.0.0.1:1",
      });
      expect(morte.corps).toMatchObject({ ok: false });
      env.ecrireConfig({ embed: { url: env.emb.url, model: "m1", api_key: "CLE-ENREGISTREE-SECRETE" } });
      const recus = env.emb.autorisations;
      recus.length = 0;
      await b.appelerAdmin(b.id.admin, "POST", "/api/admin/rag/essai/embeddings", {});
      expect(recus).toEqual(["Bearer CLE-ENREGISTREE-SECRETE"]);
      recus.length = 0;
      await b.appelerAdmin(b.id.admin, "POST", "/api/admin/rag/essai/embeddings", {
        url: `${env.emb.url}/`,
        api_key: "cle-du-formulaire",
      });
      expect(recus).toEqual(["Bearer cle-du-formulaire"]);
      // Le masque que la console renvoie pour une clé enregistrée : la vraie clé, à l'adresse enregistrée seulement.
      recus.length = 0;
      await b.appelerAdmin(b.id.admin, "POST", "/api/admin/rag/essai/embeddings", { api_key: "********" });
      await b.appelerAdmin(b.id.admin, "POST", "/api/admin/rag/essai/embeddings", {
        url: `${env.emb.url}/`,
        api_key: "********",
      });
      expect(recus).toEqual(["Bearer CLE-ENREGISTREE-SECRETE", "Bearer CLE-ENREGISTREE-SECRETE"]);
      const autreAdresse = await demarrerFauxEmbeddings();
      try {
        recus.length = 0;
        await b.appelerAdmin(b.id.admin, "POST", "/api/admin/rag/essai/embeddings", {
          url: autreAdresse.url,
          api_key: "********",
        });
        expect(recus).toEqual([]);
        expect(autreAdresse.autorisations).toEqual([""]);
      } finally {
        await autreAdresse.arreter();
      }
      for (const r of [ok, autre, morte])
        expect(r.brut.toString("utf8")).not.toContain("CLE-ENREGISTREE-SECRETE");
    });

    it("OCR : état de la configuration, essai par /v1/models, modèle absent, clé enregistrée seulement à son adresse", async () => {
      const autorisations: string[] = [];
      const serveur = createServer((req, res) => {
        autorisations.push(String(req.headers["authorization"] ?? ""));
        if (req.headers["authorization"] === "Bearer mauvaise") return void res.writeHead(401).end();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "deepseek-ocr" }, { id: "autre" }] }));
      });
      await new Promise<void>((r) => serveur.listen(0, "127.0.0.1", r));
      const url = `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`;
      try {
        let etat = schemaReponseEtatAdminRag.parse(
          (await b.appelerAdmin(b.id.admin, "GET", "/api/admin/rag/etat")).corps,
        );
        expect(etat.ocr).toEqual({ configured: false, url: "", model: "", has_api_key: false });
        expect(
          (await b.appelerAdmin(b.id.admin, "POST", "/api/admin/rag/essai/ocr", {})).corps,
        ).toMatchObject({ ok: false, service: "ocr" });
        env.ecrireConfig({ ocr: { url: `${url}/`, model: "deepseek-ocr", api_key: "CLE-OCR-SECRETE" } });
        etat = schemaReponseEtatAdminRag.parse(
          (await b.appelerAdmin(b.id.admin, "GET", "/api/admin/rag/etat")).corps,
        );
        expect(etat.ocr).toEqual({ configured: true, url, model: "deepseek-ocr", has_api_key: true });
        const ok = await b.appelerAdmin(b.id.admin, "POST", "/api/admin/rag/essai/ocr", {
          api_key: "********",
        });
        expect(ok.corps).toMatchObject({ ok: true, service: "ocr" });
        expect(autorisations.at(-1)).toBe("Bearer CLE-OCR-SECRETE");
        const absent = await b.appelerAdmin(b.id.admin, "POST", "/api/admin/rag/essai/ocr", {
          model: "inconnu",
        });
        expect(absent.corps).toMatchObject({ ok: false, service: "ocr" });
        const refus = await b.appelerAdmin(b.id.admin, "POST", "/api/admin/rag/essai/ocr", {
          api_key: "mauvaise",
        });
        expect(json<{ error: string }>(refus).error).toMatch(/401/u);
        autorisations.length = 0;
        await b.appelerAdmin(b.id.admin, "POST", "/api/admin/rag/essai/ocr", {
          url: `http://localhost:${(serveur.address() as AddressInfo).port}`,
          api_key: "********",
        });
        expect(autorisations).toEqual([""]);
        for (const r of [ok, absent, refus]) expect(r.brut.toString("utf8")).not.toContain("CLE-OCR-SECRETE");
      } finally {
        await new Promise((r) => serveur.close(r));
      }
    });

    it("essai de Qdrant et du reclassement ; service inconnu 404 ; corps invalide 400", async () => {
      expect(
        (await b.appelerAdmin(b.id.admin, "POST", "/api/admin/rag/essai/qdrant", {})).corps,
      ).toMatchObject({ ok: true, service: "qdrant", version: "test" });
      b.q.panne = true;
      expect(
        (await b.appelerAdmin(b.id.admin, "POST", "/api/admin/rag/essai/qdrant", {})).corps,
      ).toMatchObject({ ok: false, service: "qdrant" });
      expect(
        (await b.appelerAdmin(b.id.admin, "POST", "/api/admin/rag/essai/reranker", {})).corps,
      ).toMatchObject({ ok: false, service: "reranker" });
      const inconnu = await b.appelerAdmin(b.id.admin, "POST", "/api/admin/rag/essai/postgres", {});
      expect([inconnu.statut, json<Erreur>(inconnu).code]).toEqual([404, "service_inconnu"]);
      const invalide = await b.appelerAdmin(b.id.admin, "POST", "/api/admin/rag/essai/qdrant", { url: 3 });
      expect([invalide.statut, json<Erreur>(invalide).code]).toEqual([400, "requete_invalide"]);
    });
  });

  describe("collections", () => {
    it("liste de toutes les collections : auteur, taille, documents, visibilité, état, groupes, travail, dernière indexation ; filtres, tri et pages", async () => {
      const c1 = await collection(b.id.alice, "Contrats");
      const c2 = await collection(b.id.bob, "Archives");
      const c3 = await collection(b.id.carol, "Finance");
      await indexerDirect(b, c1, "a.pdf", [{ texte: "un" }, { texte: "deux" }]);
      await b.base.run(
        "UPDATE rag_documents SET bytes = 5000, indexed_at = 1700000000 WHERE collection_id = ?",
        [c1],
      );
      await b.base.run("UPDATE rag_collections SET bytes = 5000 WHERE id = ?", [c1]);
      await b.appeler(b.id.alice, "PUT", `/api/rag/collections/${c1}/publication`, {
        visibility: "groups",
        group_ids: [b.groupe.A],
        allow_source_open: true,
      });
      await b.base.run("UPDATE rag_collections SET visibility = 'all' WHERE id = ?", [c2]);
      await b.base.run(
        "INSERT INTO rag_jobs(id, collection_id, owner_user_id, kind, status, total, done, failed, created_at) VALUES(?, ?, ?, 'ingest', 'running', 4, 1, 0, 1)",
        [UUID_ABSENT, c3, b.id.carol],
      );
      await b.base.run("UPDATE rag_collections SET status = 'indexing' WHERE id = ?", [c3]);
      const lire = async (q = ""): Promise<{ collections: CollectionAdminRag[]; total: number }> => {
        const r = await b.appelerAdmin(b.id.admin, "GET", `/api/admin/rag/collections${q}`);
        expect(r.statut, JSON.stringify(r.corps)).toBe(200);
        return schemaReponseCollectionsAdminRag.parse(r.corps);
      };
      const tout = await lire();
      expect(tout.total).toBe(3);
      expect(tout.collections.map((c) => c.name)).toEqual(["Archives", "Contrats", "Finance"]);
      const contrats = tout.collections.find((c) => c.name === "Contrats");
      expect(contrats).toMatchObject({
        owner: { id: b.id.alice, username: "alice" },
        visibility: "groups",
        groups: [{ id: b.groupe.A, name: "Juristes" }],
        allow_source_open: true,
        doc_count: 1,
        chunk_count: 2,
        bytes: 5000,
        status: "ready",
        embed_model: "m1",
        last_indexed_at: 1700000000,
        job: null,
      });
      const finance = tout.collections.find((c) => c.name === "Finance");
      expect(finance).toMatchObject({
        status: "indexing",
        job: { id: UUID_ABSENT, kind: "ingest", status: "running", total: 4, done: 1, failed: 0 },
      });
      expect((await lire("?visibility=all")).collections.map((c) => c.name)).toEqual(["Archives"]);
      expect((await lire("?status=indexing")).collections.map((c) => c.name)).toEqual(["Finance"]);
      expect((await lire(`?owner_id=${b.id.alice}`)).collections.map((c) => c.name)).toEqual(["Contrats"]);
      expect((await lire("?q=CAROL")).collections.map((c) => c.name)).toEqual(["Finance"]);
      expect((await lire("?q=cont")).collections.map((c) => c.name)).toEqual(["Contrats"]);
      expect((await lire("?q=%25")).total).toBe(0);
      expect((await lire("?tri=taille")).collections[0]?.name).toBe("Contrats");
      expect((await lire("?tri=auteur")).collections.map((c) => c.owner.username)).toEqual([
        "alice",
        "bob",
        "carol",
      ]);
      const page = await lire("?limit=2&offset=2&tri=nom");
      expect([page.total, page.collections.map((c) => c.name)]).toEqual([3, ["Finance"]]);
      for (const mauvais of ["?limit=0x", "?offset=-1", "?visibility=x", "?tri=hasard", "?owner_id=0"]) {
        const r = await b.appelerAdmin(b.id.admin, "GET", `/api/admin/rag/collections${mauvais}`);
        expect([mauvais, r.statut]).toEqual([mauvais, 400]);
      }
    });
  });

  describe("suppression", () => {
    it("exige le nom exact : un nom faux ne supprime rien ; le bon supprime ligne, fichiers et Qdrant, prévient le propriétaire et les lecteurs", async () => {
      const c = await collection(b.id.alice, "Contrats");
      await b.appeler(b.id.alice, "PUT", `/api/rag/collections/${c}/publication`, {
        visibility: "groups",
        group_ids: [b.groupe.A],
        allow_source_open: false,
      });
      const r0 = await b.service.deposer(b.id.alice, c, { nom: "a.txt", flux: flux("Alpha") });
      await indexerDirect(b, c, "b.pdf", [{ texte: "deux" }]);
      const nomQ = [...b.q.collections.keys()][0] as string;
      const mauvais = await b.appelerAdmin(b.id.admin, "DELETE", `/api/admin/rag/collections/${c}`, {
        name: "contrats",
      });
      expect([mauvais.statut, json<Erreur>(mauvais).code]).toEqual([400, "nom_incorrect"]);
      expect(
        (await b.appelerAdmin(b.id.admin, "DELETE", `/api/admin/rag/collections/${c}`, { name: "" })).statut,
      ).toBe(400);
      expect(b.q.collections.has(nomQ)).toBe(true);
      const source = `${env.magasin}/${b.id.alice}/${c}/sources/${r0.document.id}.txt`;
      const { existsSync } = await import("node:fs");
      expect(existsSync(source)).toBe(true);
      b.notifications.length = 0;
      const ok = await b.appelerAdmin(b.id.admin, "DELETE", `/api/admin/rag/collections/${c}`, {
        name: "Contrats",
      });
      expect(ok.statut, JSON.stringify(ok.corps)).toBe(200);
      expect(ok.corps).toMatchObject({
        ok: true,
        deleted: { id: c, name: "Contrats", owner: { id: b.id.alice, username: "alice" } },
      });
      expect(await b.base.get("SELECT id FROM rag_collections WHERE id = ?", [c])).toBeUndefined();
      expect(await b.base.get("SELECT id FROM rag_documents WHERE collection_id = ?", [c])).toBeUndefined();
      expect(existsSync(`${env.magasin}/${b.id.alice}/${c}`)).toBe(false);
      expect(b.q.collections.has(nomQ)).toBe(false);
      const notifs = await b.base.valeurs<[unknown, unknown, unknown]>(
        "SELECT owner_user_id, kind, title FROM notifications ORDER BY id",
      );
      expect(notifs.map(([u, k]) => [Number(u), String(k)])).toEqual(
        expect.arrayContaining([
          [b.id.alice, "rag_deleted_admin"],
          [b.id.bob, "rag_share_end"],
        ]),
      );
      const encore = await b.appelerAdmin(b.id.admin, "DELETE", `/api/admin/rag/collections/${c}`, {
        name: "Contrats",
      });
      expect([encore.statut, json<Erreur>(encore).code]).toEqual([404, "collection_introuvable"]);
      expect(
        (await b.appelerAdmin(b.id.admin, "DELETE", "/api/admin/rag/collections/pas-un-uuid", { name: "x" }))
          .statut,
      ).toBe(404);
    });

    it("supprime aussi une collection dont l'indexation est en cours", async () => {
      const c = await collection(b.id.alice, "En cours");
      await b.service.deposer(b.id.alice, c, { nom: "a.txt", flux: flux("Alpha") });
      expect(
        (await b.appelerAdmin(b.id.admin, "DELETE", `/api/admin/rag/collections/${c}`, { name: "En cours" }))
          .statut,
      ).toBe(200);
      const [n] = await b.base.valeurs<[unknown]>("SELECT COUNT(*) FROM rag_jobs WHERE collection_id = ?", [
        c,
      ]);
      expect(Number(n?.[0])).toBe(0);
    });
  });

  describe("quotas par compte", () => {
    interface Compte {
      id: number;
      username: string;
      role: string;
      rag_allowed: boolean;
      usage: { storage_bytes: number; collections: number; documents: number };
      override: Record<string, number> | null;
      effective: Record<string, number>;
    }
    const comptes = async (q = ""): Promise<{ accounts: Compte[]; total: number }> => {
      const r = await b.appelerAdmin(b.id.admin, "GET", `/api/admin/rag/comptes${q}`);
      expect(r.statut, JSON.stringify(r.corps)).toBe(200);
      return json(r);
    };
    const quota = (uid: number, corps: unknown) =>
      b.appelerAdmin(b.id.admin, "PUT", `/api/admin/rag/comptes/${uid}/quota`, corps);

    it("liste les comptes avec consommation, surcharge et quotas effectifs ; rôle et droit RAG", async () => {
      const c = await collection(b.id.alice, "Contrats");
      await indexerDirect(b, c, "a.pdf", [{ texte: "un" }]);
      await b.base.run("UPDATE rag_documents SET bytes = 4096 WHERE collection_id = ?", [c]);
      env.ecrireConfig({
        groups: [b.groupe.A],
        quotas: { storage_mb: 50, collections: 4, file_mb: 7, docs_per_collection: 30 },
      });
      const r = await comptes();
      const par = new Map(r.accounts.map((a) => [a.username, a]));
      expect(par.get("alice")).toMatchObject({
        role: "user",
        rag_allowed: true,
        usage: { storage_bytes: 4096, collections: 1, documents: 1 },
        override: null,
        effective: { storage_mb: 50, collections: 4, file_mb: 7, docs_per_collection: 30 },
      });
      expect(par.get("carol")?.rag_allowed).toBe(false);
      expect(par.get("admin")).toMatchObject({ role: "admin", rag_allowed: true });
      expect(par.get("moderatrice")?.role).toBe("moderator");
      expect(r.total).toBe(6);
    });

    it("pose, modifie, retire une clé et remet à zéro la surcharge ; les valeurs de l'instance restent le repli", async () => {
      env.ecrireConfig({ quotas: { storage_mb: 50, collections: 4, file_mb: 7, docs_per_collection: 30 } });
      let r = await quota(b.id.bob, { storage_mb: 10, collections: 2 });
      expect(r.statut, JSON.stringify(r.corps)).toBe(200);
      expect(json<{ account: Compte }>(r).account).toMatchObject({
        override: { storage_mb: 10, collections: 2 },
        effective: { storage_mb: 10, collections: 2, file_mb: 7, docs_per_collection: 30 },
      });
      r = await quota(b.id.bob, { file_mb: 1, collections: null });
      expect(json<{ account: Compte }>(r).account).toMatchObject({
        override: { storage_mb: 10, file_mb: 1 },
        effective: { storage_mb: 10, collections: 4, file_mb: 1, docs_per_collection: 30 },
      });
      expect((await comptes("?seulement_surcharges=1")).accounts.map((a) => a.username)).toEqual(["bob"]);
      r = await quota(b.id.bob, { reset: true });
      expect(json<{ account: Compte }>(r).account).toMatchObject({
        override: null,
        effective: { storage_mb: 50, collections: 4, file_mb: 7, docs_per_collection: 30 },
      });
      expect((await comptes("?seulement_surcharges=1")).total).toBe(0);
      expect((await quota(b.id.bob, { storage_mb: 0 })).statut).toBe(200);
      expect(json<{ account: Compte }>(await quota(b.id.bob, {})).account.override).toEqual({
        storage_mb: 0,
      });
      expect(
        json<{ account: Compte }>(await quota(b.id.bob, { storage_mb: null })).account.override,
      ).toBeNull();
    });

    it("refuse les valeurs invalides sans rien écrire : négatif, non entier, hors borne, compte inconnu", async () => {
      for (const corps of [
        { storage_mb: -1 },
        { collections: 1.5 },
        { file_mb: "12" },
        { storage_mb: 99_999_999_999 },
      ]) {
        const r = await quota(b.id.bob, corps);
        expect([JSON.stringify(corps), r.statut, json<Erreur>(r).code]).toEqual([
          JSON.stringify(corps),
          400,
          "requete_invalide",
        ]);
      }
      const inconnu = await quota(987654, { storage_mb: 1 });
      expect([inconnu.statut, json<Erreur>(inconnu).code]).toEqual([404, "compte_introuvable"]);
      expect((await quota(b.id.bob, { storage_mb: 5 })).statut).toBe(200);
      expect((await quota(b.id.bob, { collections: 1.5 })).statut).toBe(400);
      expect((await comptes()).accounts.find((a) => a.username === "bob")?.override).toEqual({
        storage_mb: 5,
      });
      const mauvaisId = await b.appelerAdmin(b.id.admin, "PUT", "/api/admin/rag/comptes/abc/quota", {});
      expect(mauvaisId.statut).toBe(404);
    });

    it("une surcharge plus basse que l'usage n'efface rien : elle bloque seulement les nouveaux dépôts et les nouvelles collections", async () => {
      const c = await collection(b.id.alice, "Contrats");
      const d1 = await b.service.deposer(b.id.alice, c, { nom: "a.txt", flux: flux("Alpha et plus") });
      await b.base.run("UPDATE rag_documents SET bytes = 3 * 1024 * 1024 WHERE id = ?", [d1.document.id]);
      await quota(b.id.alice, { storage_mb: 1, collections: 1 });
      const compte = (await comptes()).accounts.find((a) => a.username === "alice");
      expect(compte?.usage).toMatchObject({ collections: 1, documents: 1, storage_bytes: 3 * 1024 * 1024 });
      expect(await b.base.get("SELECT id FROM rag_documents WHERE id = ?", [d1.document.id])).toBeDefined();
      const refus = async (nom: string): Promise<string> => {
        try {
          await b.service.deposer(b.id.alice, c, { nom, flux: flux("Bravo") });
          return "accepté";
        } catch (e) {
          return (e as { code?: string }).code ?? String(e);
        }
      };
      expect(await refus("b.txt")).toBe("quota_stockage");
      const nouvelle = await b.appeler(b.id.alice, "POST", "/api/rag/collections", { name: "Deux" });
      expect([nouvelle.statut, json<Erreur>(nouvelle).code]).toEqual([409, "quota_collections"]);
      await quota(b.id.alice, { reset: true });
      expect(await refus("b.txt")).toBe("accepté");
      await quota(b.id.alice, { docs_per_collection: 1 });
      expect(await refus("c.txt")).toBe("quota_documents");
    });

    it("une surcharge de taille de fichier refuse un fichier trop gros ; l'instance règle le défaut de tout le monde", async () => {
      const c = await collection(b.id.bob, "Gros");
      await quota(b.id.bob, { file_mb: 0 });
      let code = "accepté";
      try {
        await b.service.deposer(b.id.bob, c, { nom: "a.txt", flux: flux("x") });
      } catch (e) {
        code = (e as { code?: string }).code ?? "";
      }
      expect(code).toBe("fichier_trop_gros");
      env.ecrireConfig({ quotas: { collections: 1 } });
      const r = await b.appeler(b.id.dave, "POST", "/api/rag/collections", { name: "Une" });
      expect(r.statut).toBe(200);
      const r2 = await b.appeler(b.id.dave, "POST", "/api/rag/collections", { name: "Deux" });
      expect([r2.statut, json<Erreur>(r2).code]).toEqual([409, "quota_collections"]);
    });

    it("un utilisateur ne peut pas s'accorder un quota par ses propres réglages", async () => {
      expect(USER_SETTINGS_ALLOWED.has("rag_quota")).toBe(false);
      await ecrireReglages(b.base, b.id.dave, { rag_quota: { storage_mb: 9_999_999 } }, "main", journalMuet);
      const compte = (await comptes()).accounts.find((a) => a.username === "dave");
      expect(compte?.override).toBeNull();
    });
  });
  describe("audit", () => {
    it("suppression, quota et réindexation globale laissent une trace sans contenu", async () => {
      const dossier = mkdtempSync(join(tmpdir(), "elpis-rag-audit-test-"));
      configureAudit({ auditDir: dossier, hmacKeyPath: join(dossier, "cle") });
      const lues = (): {
        action: string;
        user_id: number | null;
        ip: string | null;
        details: Record<string, unknown>;
      }[] => lignesAuditRecentes({ actionPrefix: "admin.rag.", limit: 50 }) as never[];
      try {
        const c = await collection(b.id.alice, "Dossier");
        const d = await collection(b.id.alice, "Autre");
        await b.appelerAdmin(b.id.admin, "PUT", `/api/admin/rag/comptes/${b.id.bob}/quota`, { file_mb: 3 });
        await b.appelerAdmin(b.id.admin, "POST", "/api/admin/rag/reindexer", {});
        await b.appelerAdmin(b.id.admin, "DELETE", `/api/admin/rag/collections/${d}`, { name: "Autre" });
        await b.appelerAdmin(b.id.admin, "DELETE", `/api/admin/rag/collections/${c}`, { name: "faux" });
        const nouvelles = lues();
        expect(nouvelles.map((l) => l.action).sort()).toEqual([
          "admin.rag.collection.delete",
          "admin.rag.quota.set",
          "admin.rag.reindex_all",
        ]);
        expect(nouvelles.every((l) => typeof l.ip === "string")).toBe(true);
        expect(JSON.stringify(nouvelles)).not.toContain(DESCRIPTION_SECRETE);
      } finally {
        rmSync(dossier, { recursive: true, force: true });
        configureAudit({ auditDir: dossierAudit, hmacKeyPath: join(dossierAudit, "cle") });
      }
    });
  });
});
