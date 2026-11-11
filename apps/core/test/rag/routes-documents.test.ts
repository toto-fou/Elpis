// SPDX-License-Identifier: MIT
/** apps/core/test/rag/routes-documents.test.ts — routes RAG des documents (SQLite et PostgreSQL) : liste filtrée et paginée, dépôt multipart (fichiers multiples, dossiers, trop gros, tronqué, extension refusée, quotas), import depuis le bac, suppression, réindexation. */
import { existsSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";

import { schemaReponseDepotRag, schemaReponseDocumentsRag } from "@elpis/contracts";
import type { DocumentRag } from "@elpis/contracts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { appliquerPublication } from "../../src/rag/acces";
import { RefusIndexationRag } from "../../src/rag/erreurs-indexation";
import { nomQdrantRag } from "../../src/rag/magasin";
import { definirQuotaRagCompte } from "../../src/rag/quotas";
import { fluxDuFichier } from "../../src/familles/rag-documents";
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

interface Depot {
  results: { name: string; status: string; code?: string; message?: string; document?: DocumentRag }[];
  job: { id: string; total: number; status: string } | null;
}

describe("fluxDuFichier : fin tronquée par le plafond du multipart", () => {
  it("laisse passer un fichier complet et refuse un fichier tronqué", async () => {
    const complet = Object.assign(Readable.from([Buffer.from("abc"), Buffer.from("def")]), {
      truncated: false,
    });
    const morceaux: string[] = [];
    for await (const m of fluxDuFichier(complet, 1)) morceaux.push(Buffer.from(m).toString());
    expect(morceaux.join("")).toBe("abcdef");
    const tronque = Object.assign(Readable.from([Buffer.from("abc")]), { truncated: true });
    await expect(async () => {
      for await (const m of fluxDuFichier(tronque, 7)) void m;
    }).rejects.toMatchObject({ code: "fichier_trop_gros", message: expect.stringContaining("7 Mo") });
    expect(new RefusIndexationRag("fichier_trop_gros").statut).toBe(413);
  });

  it("une sortie anticipée ne détruit pas le flux du formulaire", async () => {
    const flux = Object.assign(Readable.from([Buffer.from("a"), Buffer.from("b")]), { truncated: false });
    const it = fluxDuFichier(flux, 1);
    await it.next();
    await it.return(undefined);
    expect(flux.destroyed).toBe(false);
    flux.resume();
  });
});

describe.each(MOTEURS)("routes RAG : documents (%s)", (moteur) => {
  let b: Banc;
  let col: string;
  const url = (suite = ""): string => `/api/rag/collections/${col}${suite}`;
  const sources = (): string[] => readdirSync(join(env.magasin, String(b.id.alice), col, "sources")).sort();

  beforeEach(async () => {
    b = await ouvrirBanc(moteur, env);
    col = await creerCollection(b.base, b.id.alice, "Contrats");
  });

  afterEach(async () => {
    await b.fermer();
  });

  describe("liste", () => {
    beforeEach(async () => {
      await indexerDirect(b, col, "droit/contrat-a.pdf", [
        { texte: "un" },
        { texte: "deux" },
        { texte: "trois" },
      ]);
      await indexerDirect(b, col, "droit/Contrat-B.pdf", [{ texte: "quatre" }]);
      await indexerDirect(b, col, "finance/budget_2026.xlsx", [{ texte: "cinq" }], { ext: "xlsx" });
      await indexerDirect(b, col, "notes%100.md", [{ texte: "six" }], { ext: "md" });
      await b.base.run(
        "UPDATE rag_documents SET status='error', error_code='no_text', error_message='Sans texte', chunk_count=0 WHERE rel_path=?",
        ["finance/budget_2026.xlsx"],
      );
      await b.base.run("UPDATE rag_documents SET status='indexing', bytes=900 WHERE rel_path=?", [
        "notes%100.md",
      ]);
      await b.base.run("UPDATE rag_documents SET bytes=500 WHERE rel_path=?", ["droit/Contrat-B.pdf"]);
    });

    const lister = async (q: string, uid = b.id.alice) =>
      schemaReponseDocumentsRag.parse((await b.appeler(uid, "GET", url(`/documents${q}`))).corps);

    it("tout, trié par chemin, avec le nombre de passages de chaque document", async () => {
      const r = await lister("");
      expect(r).toMatchObject({ total: 4, offset: 0, limit: 100 });
      expect(r.documents.map((d) => [d.rel_path, d.chunk_count, d.status])).toEqual([
        ["droit/Contrat-B.pdf", 1, "ready"],
        ["droit/contrat-a.pdf", 3, "ready"],
        ["finance/budget_2026.xlsx", 0, "error"],
        ["notes%100.md", 1, "indexing"],
      ]);
      expect(r.documents[2]?.error).toEqual({ code: "no_text", message: "Sans texte" });
    });

    it("filtre texte sans casse (jokers du LIKE neutralisés), filtre d'état, tri, pagination", async () => {
      expect((await lister("?q=CONTRAT")).documents.map((d) => d.name)).toEqual([
        "Contrat-B.pdf",
        "contrat-a.pdf",
      ]);
      expect((await lister("?q=%25")).documents.map((d) => d.name)).toEqual(["notes%100.md"]);
      expect((await lister("?q=_")).documents.map((d) => d.name)).toEqual(["budget_2026.xlsx"]);
      expect((await lister("?q=zzz")).total).toBe(0);
      expect((await lister("?status=error")).documents.map((d) => d.name)).toEqual(["budget_2026.xlsx"]);
      expect((await lister("?status=error,indexing")).total).toBe(2);
      expect((await lister("?tri=taille")).documents.map((d) => d.name)[0]).toBe("notes%100.md");
      const page = await lister("?limit=2&offset=1");
      expect([page.total, page.limit, page.offset, page.documents.length]).toEqual([4, 2, 1, 2]);
      expect((await lister("?limit=9999")).limit).toBe(500);
    });

    it("un document seul : ses champs, 404 pour un document d'une autre collection", async () => {
      const autre = await creerCollection(b.base, b.id.alice, "Autre");
      const ailleurs = await indexerDirect(b, autre, "x.pdf", [{ texte: "x" }]);
      const [a] = (await lister("")).documents;
      const r = await b.appeler(b.id.alice, "GET", url(`/documents/${a?.id}`));
      expect(json<{ document: DocumentRag }>(r).document).toEqual(a);
      const hors = await b.appeler(b.id.alice, "GET", url(`/documents/${ailleurs}`));
      expect([hors.statut, json<Erreur>(hors).code]).toEqual([404, "document_introuvable"]);
    });

    it("un lecteur voit la liste ; paramètres invalides : 400", async () => {
      await appliquerPublication(b.base, b.id.alice, col, {
        visibility: "groups",
        group_ids: [b.groupe.A],
        allow_source_open: false,
      });
      expect((await lister("", b.id.bob)).total).toBe(4);
      for (const q of ["?status=inconnu", "?tri=hasard", "?offset=-1", "?limit=abc", "?limit=0x1"]) {
        const r = await b.appeler(b.id.alice, "GET", url(`/documents${q}`));
        expect([r.statut, json<Erreur>(r).code], q).toEqual([400, "requete_invalide"]);
      }
      const limite = await lister("?limit=0");
      expect(limite.limit).toBe(1);
    });
  });

  describe("dépôt multipart", () => {
    const deposer = async (
      fichiers: { nom: string; contenu: string | Buffer }[],
      uid = b.id.alice,
    ): Promise<{ statut: number; depot: Depot }> => {
      const r = await b.televerser(uid, url("/documents"), fichiers);
      return { statut: r.statut, depot: json<Depot>(r) };
    };

    it("plusieurs fichiers dont un dossier et un nom accentué : un résultat par fichier, un seul travail", async () => {
      const { statut, depot } = await deposer([
        { nom: "contrat.txt", contenu: "Le contrat se renouvelle." },
        { nom: "dossier/sous/annexe é.md", contenu: "# Annexe\n\nTexte de l'annexe." },
        { nom: "résumé.txt", contenu: "Résumé." },
      ]);
      expect(statut).toBe(200);
      schemaReponseDepotRag.parse(depot);
      expect(depot.results.map((r) => [r.name, r.status])).toEqual([
        ["contrat.txt", "ajoute"],
        ["dossier/sous/annexe é.md", "ajoute"],
        ["résumé.txt", "ajoute"],
      ]);
      expect(depot.results.map((r) => r.document?.rel_path)).toEqual([
        "contrat.txt",
        "dossier/sous/annexe é.md",
        "résumé.txt",
      ]);
      expect(depot.job).toMatchObject({ total: 3, status: "queued" });
      expect(sources()).toHaveLength(3);
      const liste = json<{ documents: DocumentRag[] }>(await b.appeler(b.id.alice, "GET", url("/documents")));
      expect(liste.documents.every((d) => d.status === "pending")).toBe(true);
      const c = json<{ collection: { doc_count: number; status: string } }>(
        await b.appeler(b.id.alice, "GET", url()),
      ).collection;
      expect(c).toMatchObject({ doc_count: 3, status: "indexing" });
      expect(b.evenements.length).toBeGreaterThanOrEqual(3);
    });

    it("même contenu : « deja_present » ; même chemin, autre contenu : « remplace » sous le même identifiant", async () => {
      const a = await deposer([{ nom: "a.txt", contenu: "Version 1." }]);
      const idA = a.depot.results[0]?.document?.id;
      const copie = await deposer([{ nom: "copie.txt", contenu: "Version 1." }]);
      expect(copie.depot.results[0]).toMatchObject({ status: "deja_present", document: { id: idA } });
      const v2 = await deposer([{ nom: "a.txt", contenu: "Version 2, plus longue." }]);
      expect(v2.depot.results[0]).toMatchObject({ status: "remplace", document: { id: idA, bytes: 23 } });
      expect(sources()).toEqual([`${idA}.txt`]);
    });

    it("fichier trop gros ou tronqué : refusé avec son code, les autres passent, rien ne reste sur disque", async () => {
      await definirQuotaRagCompte(b.base, b.id.alice, { file_mb: 1 });
      const mo = 1024 * 1024;
      const { statut, depot } = await deposer([
        { nom: "avant.txt", contenu: "Avant." },
        { nom: "gros.txt", contenu: Buffer.alloc(mo + 1, 97) },
        { nom: "enorme.txt", contenu: Buffer.alloc(3 * mo, 98) },
        { nom: "apres.txt", contenu: "Après." },
      ]);
      expect(statut).toBe(200);
      expect(depot.results.map((r) => [r.name, r.status, r.code ?? null])).toEqual([
        ["avant.txt", "ajoute", null],
        ["gros.txt", "refuse", "fichier_trop_gros"],
        ["enorme.txt", "refuse", "fichier_trop_gros"],
        ["apres.txt", "ajoute", null],
      ]);
      expect(depot.results[1]?.message).toMatch(/1 Mo/u);
      expect(sources()).toHaveLength(2);
      expect(sources().some((n) => n.endsWith(".part"))).toBe(false);
      const exact = await deposer([{ nom: "pile.txt", contenu: Buffer.alloc(mo, 99) }]);
      expect(exact.depot.results[0]?.status).toBe("ajoute");
    });

    it("envoi plus gros que le stockage du compte : refusé d'emblée (413 depot_trop_gros), rien n'est écrit", async () => {
      await definirQuotaRagCompte(b.base, b.id.alice, { file_mb: 1, storage_mb: 1 });
      const mo = 1024 * 1024;
      const fichiers = Array.from({ length: 3 }, (_, i) => ({
        nom: `p${i}.txt`,
        contenu: Buffer.alloc(6 * mo, 97),
      }));
      const { statut, depot } = await deposer(fichiers);
      expect(statut).toBe(413);
      expect(depot as unknown).toMatchObject({ code: "depot_trop_gros" });
      expect(sources()).toEqual([]);
      const petit = await deposer([{ nom: "ok.txt", contenu: "dans le quota" }]);
      expect(petit.statut).toBe(200);
    });

    it("extension refusée, nom hostile ou vide : refus par fichier sans arrêter le lot", async () => {
      const { depot } = await deposer([
        { nom: "virus.exe", contenu: "MZ" },
        { nom: "../evasion.txt", contenu: "x" },
        { nom: "sans-extension", contenu: "x" },
        { nom: "bon.txt", contenu: "bon" },
      ]);
      expect(depot.results.map((r) => [r.status, r.code ?? null])).toEqual([
        ["refuse", "extension_refusee"],
        ["refuse", "nom_invalide"],
        ["refuse", "extension_refusee"],
        ["ajoute", null],
      ]);
      expect(sources()).toHaveLength(1);
    });

    it("fichier vide refusé ; quotas de documents et de stockage", async () => {
      expect((await deposer([{ nom: "vide.txt", contenu: "" }])).depot.results[0]?.code).toBe("fichier_vide");
      await definirQuotaRagCompte(b.base, b.id.alice, { docs_per_collection: 2 });
      const { depot } = await deposer([
        { nom: "1.txt", contenu: "un" },
        { nom: "2.txt", contenu: "deux" },
        { nom: "3.txt", contenu: "trois" },
      ]);
      expect(depot.results.map((r) => r.code ?? r.status)).toEqual(["ajoute", "ajoute", "quota_documents"]);
      await definirQuotaRagCompte(b.base, b.id.alice, { docs_per_collection: 100, storage_mb: 1 });
      const plein = await deposer([{ nom: "gros.txt", contenu: Buffer.alloc(1024 * 1024 + 10, 97) }]);
      expect(plein.depot.results[0]?.code).toMatch(/quota_stockage|fichier_trop_gros/u);
    });

    it("envois sans fichier, hors multipart, vers un RAG désactivé : refus d'ensemble", async () => {
      const r = await b.app.inject({
        method: "POST",
        url: url("/documents"),
        headers: { "x-uid": String(b.id.alice), "content-type": "application/json" },
        payload: "{}",
      });
      expect([r.statusCode, r.json<Erreur>().code]).toEqual([400, "multipart_attendu"]);
      const vide = await b.televerser(b.id.alice, url("/documents"), [], { note: "seulement un champ" });
      expect([vide.statut, json<Erreur>(vide).code]).toEqual([400, "aucun_fichier"]);
      env.ecrireConfig({ embed: { url: "" } });
      const off = await b.televerser(b.id.alice, url("/documents"), [{ nom: "a.txt", contenu: "x" }]);
      expect([off.statut, json<Erreur>(off).code]).toEqual([503, "rag_desactive"]);
    });

    it("le dépôt d'un lecteur est refusé avant toute écriture", async () => {
      await appliquerPublication(b.base, b.id.alice, col, {
        visibility: "groups",
        group_ids: [b.groupe.A],
        allow_source_open: true,
      });
      const r = await b.televerser(b.id.bob, url("/documents"), [{ nom: "a.txt", contenu: "x" }]);
      expect([r.statut, json<Erreur>(r).code]).toEqual([403, "lecture_seule"]);
      expect(existsSync(join(env.magasin, String(b.id.bob)))).toBe(false);
      expect(sources()).toEqual([]);
    });

    it.skipIf(moteur !== "sqlite")(
      "plus de 1000 fichiers : les premiers sont déposés, un refus clair signale le reste",
      async () => {
        const fichiers = Array.from({ length: 1003 }, (_, i) => ({ nom: `f${i}.txt`, contenu: `n${i}` }));
        await definirQuotaRagCompte(b.base, b.id.alice, { docs_per_collection: 5000 });
        const { statut, depot } = await deposer(fichiers);
        expect(statut).toBe(200);
        expect(depot.results.filter((r) => r.status === "ajoute")).toHaveLength(1000);
        expect(depot.results.at(-1)).toMatchObject({ status: "refuse", code: "trop_de_fichiers" });
      },
      60_000,
    );
  });

  describe("import depuis le bac", () => {
    let hote: ReturnType<typeof createServer>;
    let bancImport: Banc;

    beforeEach(async () => {
      hote = createServer((req, res) => {
        const u = new URL(req.url ?? "/", "http://x");
        const chemin = u.searchParams.get("path") ?? "";
        if (u.pathname !== "/api/sandbox/download") return void res.writeHead(404).end();
        if (chemin === "/work/docs/note.md")
          return void res.writeHead(200, { "content-type": "text/markdown" }).end("# Note\n\nTexte.");
        if (chemin === "dossier.pdf")
          return void res.writeHead(200, { "content-type": "application/zip" }).end("PK");
        return void res.writeHead(404, { "content-type": "application/json" }).end('{"detail":"Not found"}');
      });
      await new Promise<void>((r) => hote.listen(0, "127.0.0.1", () => r()));
      const adresse = `http://127.0.0.1:${(hote.address() as AddressInfo).port}`;
      await b.fermer();
      bancImport = await ouvrirBanc(moteur, env, {
        depot: {
          hoteSandbox: async (uid) => ({ id: "local", url: adresse, token: `jeton-${uid}`, relay: false }),
          entetesSandbox: async () => ({}),
        },
      });
      b = bancImport;
      col = await creerCollection(b.base, b.id.alice, "Import");
    });

    afterEach(async () => {
      hote.closeAllConnections();
      await new Promise<void>((r) => hote.close(() => r()));
    });

    it("fichiers déposés, refus par fichier, travail actif rendu", async () => {
      const r = await b.appeler(b.id.alice, "POST", url("/import-sandbox"), {
        paths: ["/work/docs/note.md", "dossier.pdf", "absent.txt", "outil.sh"],
      });
      expect(r.statut, JSON.stringify(r.corps)).toBe(200);
      const depot = schemaReponseDepotRag.parse(r.corps);
      expect(depot.results.map((x) => [x.name, x.status, x.code ?? null])).toEqual([
        ["/work/docs/note.md", "ajoute", null],
        ["dossier.pdf", "refuse", "dossier_refuse"],
        ["absent.txt", "refuse", "sandbox_fichier"],
        ["outil.sh", "refuse", "extension_refusee"],
      ]);
      expect(depot.results[0]?.document?.rel_path).toBe("docs/note.md");
      expect(depot.job).toMatchObject({ total: 1, status: "queued" });
    });

    it("corps invalides : liste vide, trop longue, chemin vide", async () => {
      for (const corps of [
        {},
        { paths: [] },
        { paths: [""] },
        { paths: Array.from({ length: 501 }, () => "a.txt") },
      ]) {
        const r = await b.appeler(b.id.alice, "POST", url("/import-sandbox"), corps);
        expect([r.statut, json<Erreur>(r).code]).toEqual([400, "requete_invalide"]);
      }
    });
  });

  describe("suppression et réindexation", () => {
    it("supprime un document : ligne, source, passages ; l'identifiant d'un autre document de la collection est introuvable", async () => {
      const { depot } = await (async () => {
        const r = await b.televerser(b.id.alice, url("/documents"), [{ nom: "a.txt", contenu: "Un texte." }]);
        return { depot: json<Depot>(r) };
      })();
      const id = depot.results[0]?.document?.id as string;
      expect(sources()).toEqual([`${id}.txt`]);
      const r = await b.appeler(b.id.alice, "DELETE", url(`/documents/${id}`));
      expect([r.statut, r.corps]).toEqual([200, { ok: true }]);
      expect(sources()).toEqual([]);
      const encore = await b.appeler(b.id.alice, "DELETE", url(`/documents/${id}`));
      expect([encore.statut, json<Erreur>(encore).code]).toEqual([404, "document_introuvable"]);
      const c = json<{ collection: { doc_count: number } }>(
        await b.appeler(b.id.alice, "GET", url()),
      ).collection;
      expect(c.doc_count).toBe(0);
    });

    it("vide la collection : documents, fichiers et passages partent, la collection reste", async () => {
      await b.televerser(b.id.alice, url("/documents"), [
        { nom: "a.txt", contenu: "Un." },
        { nom: "d/b.txt", contenu: "Deux." },
      ]);
      const pret = await indexerDirect(b, col, "c.pdf", [{ texte: "trois" }]);
      const nom = nomQdrantRag(col);
      expect(b.q.documents(nom).has(pret)).toBe(true);
      const r = await b.appeler(b.id.alice, "POST", url("/vider"));
      expect([r.statut, r.corps]).toEqual([200, { ok: true, deleted: 3 }]);
      expect(b.q.collections.get(nom)?.points.size).toBe(0);
      const c = json<{ collection: { doc_count: number; chunk_count: number; bytes: number } }>(
        await b.appeler(b.id.alice, "GET", url()),
      ).collection;
      expect(c).toMatchObject({ doc_count: 0, chunk_count: 0, bytes: 0 });
      expect(readdirSync(join(env.magasin, String(b.id.alice), col, "sources"))).toEqual([]);
      expect(json<{ deleted: number }>(await b.appeler(b.id.alice, "POST", url("/vider"))).deleted).toBe(0);
    });

    it("le document d'une autre collection du même compte n'est pas supprimable par ce chemin", async () => {
      const autre = await creerCollection(b.base, b.id.alice, "Autre");
      const doc = await indexerDirect(b, autre, "x.pdf", [{ texte: "x" }]);
      const r = await b.appeler(b.id.alice, "DELETE", url(`/documents/${doc}`));
      expect([r.statut, json<Erreur>(r).code]).toEqual([404, "document_introuvable"]);
      expect(await b.base.get("SELECT id FROM rag_documents WHERE id=?", [doc])).toBeDefined();
    });

    it("réindexe les documents en échec, des documents choisis ou tout (force) ; rien à faire : job nul", async () => {
      const a = await indexerDirect(b, col, "a.pdf", [{ texte: "un" }]);
      const e = await indexerDirect(b, col, "e.pdf", [{ texte: "deux" }]);
      await b.base.run("UPDATE rag_documents SET status='error', error_code='corrupt' WHERE id=?", [e]);
      await b.base.run("UPDATE rag_documents SET chunk_params_hash = (SELECT 'h') WHERE id=?", [a]);
      const vide = json<{ job: unknown }>(
        await b.appeler(b.id.alice, "POST", url("/reindexer"), { documents: [] }),
      );
      expect(vide.job).toBeNull();
      const echec = json<{ job: { id: string; kind: string; total: number } }>(
        await b.appeler(b.id.alice, "POST", url("/reindexer"), { documents: [e] }),
      );
      expect(echec.job).toMatchObject({ kind: "reindex", total: 1 });
      await b.appeler(b.id.alice, "POST", `/api/rag/travaux/${echec.job.id}/annuler`);
      const force = json<{ job: { total: number } | null }>(
        await b.appeler(b.id.alice, "POST", url("/reindexer"), { force: true }),
      );
      expect(force.job?.total).toBe(2);
      const inconnu = await b.appeler(b.id.alice, "POST", url("/reindexer"), {
        documents: ["0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"],
      });
      expect([inconnu.statut, json<Erreur>(inconnu).code]).toEqual([404, "document_introuvable"]);
      const mauvais = await b.appeler(b.id.alice, "POST", url("/reindexer"), { documents: ["x"] });
      expect([mauvais.statut, json<Erreur>(mauvais).code]).toEqual([400, "requete_invalide"]);
    });
  });
});
