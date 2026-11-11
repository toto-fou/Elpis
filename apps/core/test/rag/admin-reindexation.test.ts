// SPDX-License-Identifier: MIT
/** apps/core/test/rag/admin-reindexation.test.ts — « Réindexer toutes les collections » et travaux depuis la console (SQLite et PostgreSQL) : la console n'a pas de travailleur, elle écrit dans la base et le travailleur de main (autre instance du service) exécute ; progression lue par la console. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { schemaReponseReindexationGlobaleRag } from "@elpis/contracts";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createGroup, setUserGroups } from "@elpis/auth";

import { invaliderAccesRag } from "../../src/rag/acces";
import { nomQdrantRag } from "../../src/rag/magasin";
import { ServiceIndexationRag } from "../../src/rag/service";
import { TravailleurRag } from "../../src/rag/travailleur";
import type { ReglagesTravailleurRag } from "../../src/rag/travailleur";
import { creerAppAdminRag } from "./aides-admin";
import type { AppAdminRag } from "./aides-admin";
import {
  creerCollection,
  creerCompte,
  demarrerFauxEmbeddings,
  demarrerFauxExtracteur,
  FauxQdrant,
  flux,
  JETON_EXTRACTEUR,
  jusqua,
} from "./aides-indexation";
import type { FauxEmbeddings, FauxExtracteur } from "./aides-indexation";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const ENV = ["RAG_SERVICE_URL", "RAG_SERVICE_TOKEN", "RAG_STORE_DIR", "ELPIS_RAG_ACCESS_DIR"] as const;
const RAPIDE: Partial<ReglagesTravailleurRag> = {
  tickActifMs: 15,
  tickInactifMs: 30,
  tickDesactiveMs: 30,
  battementMs: 30,
  attenteMinMs: 80,
  attenteMaxMs: 200,
  debitEvenementsMs: 40,
  arretMs: 5_000,
};

let dossier: string;
let configJson: string;
let magasin: string;
let restaurer: () => void;
let ext: FauxExtracteur;
let emb: FauxEmbeddings;
const avant = new Map<string, string | undefined>();

function ecrireConfig(o: { modele?: string; embedUrl?: string; groupes?: number[] } = {}): void {
  writeFileSync(
    configJson,
    JSON.stringify({
      rag: {
        store_dir: magasin,
        service_url: ext.url,
        service_token: JETON_EXTRACTEUR,
        qdrant_url: "http://127.0.0.1:9",
        embed: { url: o.embedUrl ?? emb.url, model: o.modele ?? "m1", timeout_s: 5 },
        ...(o.groupes ? { groups: o.groupes } : {}),
      },
    }),
  );
  invalidateConfigCache();
}

beforeAll(async () => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-rag-reindex-"));
  configJson = join(dossier, "config.json");
  magasin = join(dossier, "magasin");
  for (const k of ENV) avant.set(k, process.env[k]);
  for (const k of ENV) delete process.env[k];
  process.env["ELPIS_RAG_ACCESS_DIR"] = join(dossier, "temoin");
  restaurer = surchargerConfig({ CONFIG_JSON_PATH: configJson, DB_PATH: join(dossier, "user_db", "app.db") });
  ext = await demarrerFauxExtracteur(() => magasin);
  emb = await demarrerFauxEmbeddings();
});

afterAll(async () => {
  await ext.arreter();
  await emb.arreter();
  restaurer();
  for (const k of ENV) {
    const v = avant.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dossier, { recursive: true, force: true });
});

describe.each(MOTEURS)("console RAG : réindexation et travaux (%s)", (moteur) => {
  let t: BaseDeTest;
  let alice: number;
  let bob: number;
  let admin: number;
  let q: FauxQdrant;
  let travailleur: TravailleurRag;
  let main: ServiceIndexationRag;
  let console: ServiceIndexationRag;
  let app: AppAdminRag;
  let ctrl: AbortController | null;
  let boucle: Promise<void> | null;

  const demarrer = (): void => {
    ctrl = new AbortController();
    boucle = travailleur.demarrer(ctrl.signal);
  };

  beforeEach(async () => {
    ext.mode = "ok";
    ext.attenteMs = 0;
    emb.panne = false;
    emb.dimensions.clear();
    emb.modeles.length = 0;
    ecrireConfig();
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    alice = await creerCompte(t.base, "alice");
    bob = await creerCompte(t.base, "bob");
    admin = await creerCompte(t.base, "root", true);
    q = new FauxQdrant();
    travailleur = new TravailleurRag({
      base: t.base,
      meneur: { tenu: true, essayer: async () => true },
      qdrant: () => q,
      reglages: RAPIDE,
    });
    main = new ServiceIndexationRag({ base: t.base, travailleur, qdrant: () => q });
    // La console : même base, aucun travailleur (comme le processus admin).
    console = new ServiceIndexationRag({ base: t.base, qdrant: () => q });
    app = await creerAppAdminRag({ base: t.base, service: () => console });
    ctrl = null;
    boucle = null;
  });

  afterEach(async () => {
    if (ctrl !== null && boucle !== null) {
      ctrl.abort();
      await travailleur.arreter();
      await boucle;
    }
    await app.fermer();
    await t.fermer();
    rmSync(magasin, { recursive: true, force: true });
  });

  const lire = async (): Promise<ReturnType<typeof schemaReponseReindexationGlobaleRag.parse>> => {
    const r = await app.appeler(admin, "GET", "/api/admin/rag/reindexation");
    expect(r.statut, JSON.stringify(r.corps)).toBe(200);
    return schemaReponseReindexationGlobaleRag.parse(r.corps);
  };
  const attendreVue = async (
    ok: (v: Awaited<ReturnType<typeof lire>>) => boolean,
    libelle: string,
    delaiMs?: number,
  ): Promise<Awaited<ReturnType<typeof lire>>> => {
    let vue = await lire();
    await jusqua(async () => ((vue = await lire()), ok(vue)), libelle, delaiMs);
    return vue;
  };
  const indexer = async (uid: number, c: string, nom: string, texte: string): Promise<void> => {
    const r = await main.deposer(uid, c, { nom, flux: flux(texte) });
    await jusqua(
      async () =>
        (await t.base.get("SELECT status FROM rag_documents WHERE id=?", [r.document.id]))?.["status"] ===
        "ready",
      `${nom} indexé`,
    );
  };

  it("droit RAG retiré à l'auteur : sa collection privée n'est ni migrée ni indexée (son texte ne part plus), sa collection publiée l'est", async () => {
    const perso = await creerCollection(t.base, alice, "Perso");
    const publiee = await creerCollection(t.base, alice, "Publiée");
    await t.base.run("UPDATE rag_collections SET visibility='all' WHERE id=?", [publiee]);
    demarrer();
    await indexer(alice, perso, "a.txt", "Alpha privé.");
    await indexer(alice, publiee, "b.txt", "Bravo publié.");
    const g = await createGroup(t.base, "Autorisés");
    await setUserGroups(t.base, bob, [g]);
    emb.dimensions.set("m2", 12);
    ecrireConfig({ modele: "m2", groupes: [g] });
    invaliderAccesRag(t.base);
    const envoyes = emb.appels;
    const lancer = await app.appeler(admin, "POST", "/api/admin/rag/reindexer", {});
    expect(lancer.corps).toMatchObject({ started: 1 });
    const modele = async (id: string): Promise<unknown> =>
      (await t.base.get("SELECT embed_model FROM rag_collections WHERE id=?", [id]))?.["embed_model"];
    await jusqua(async () => (await modele(publiee)) === "m2", "migration de la publiée finie");
    expect(await modele(perso)).toBe("m1");
    // Un travail mis en file avant le retrait du droit reste en file : rien n'est envoyé au serveur d'embeddings.
    await t.base.run(
      "INSERT INTO rag_jobs(id, collection_id, owner_user_id, kind, status, total, done, failed, params_json, created_at) VALUES(?, ?, ?, 'migrate', 'queued', 1, 0, 0, ?, ?)",
      [
        "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
        perso,
        alice,
        JSON.stringify({ modele: "m2" }),
        Date.now() / 1000,
      ],
    );
    const avantFile = emb.appels;
    await new Promise((r) => setTimeout(r, 400));
    expect(emb.appels).toBe(avantFile);
    expect(
      (
        await t.base.get("SELECT status FROM rag_jobs WHERE id=?", ["0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"])
      )?.["status"],
    ).toBe("queued");
    expect(emb.appels - envoyes).toBeGreaterThan(0);
  });

  it("changement de modèle : la console lance la migration de toutes les collections, le travailleur de main l'exécute, la progression se lit pendant et après", async () => {
    const c1 = await creerCollection(t.base, alice, "Contrats");
    const c2 = await creerCollection(t.base, bob, "Finance");
    const c3 = await creerCollection(t.base, alice, "Vide");
    demarrer();
    await indexer(alice, c1, "a.txt", "Alpha.");
    await indexer(alice, c1, "b.txt", "Bravo.");
    await indexer(bob, c2, "c.txt", "Charlie.");
    expect(await lire()).toMatchObject({
      model: "m1",
      to_migrate: 0,
      up_to_date: 2,
      empty: 1,
      by_model: [{ model: "m1", collections: 2 }],
      jobs: [],
      progress: { collections: 0, total: 0, done: 0, failed: 0 },
    });

    emb.dimensions.set("m2", 12);
    ecrireConfig({ modele: "m2" });
    expect(await lire()).toMatchObject({ model: "m2", to_migrate: 2, up_to_date: 0, empty: 1 });
    emb.panne = true;
    const lancer = await app.appeler(admin, "POST", "/api/admin/rag/reindexer", {});
    expect(lancer.statut, JSON.stringify(lancer.corps)).toBe(200);
    expect(lancer.corps).toMatchObject({ started: 2, to_migrate: 2 });
    const encours = await attendreVue(
      (v) => v.progress.total === 3 && v.jobs.length === 2,
      "migrations commencées",
    );
    expect(encours.progress).toMatchObject({ collections: 2, total: 3, done: 0 });
    expect(encours.jobs.map((j) => [j.collection_name, j.owner.username, j.kind, j.total]).sort()).toEqual([
      ["Contrats", "alice", "migrate", 2],
      ["Finance", "bob", "migrate", 1],
    ]);
    expect((await app.appeler(admin, "POST", "/api/admin/rag/reindexer", {})).corps).toMatchObject({
      started: 2,
    });
    expect(
      (await t.base.valeurs<[unknown]>("SELECT COUNT(*) FROM rag_jobs WHERE kind='migrate'"))[0]?.[0],
    ).toBe(2);

    emb.panne = false;
    const fin = await attendreVue(
      (v) => v.to_migrate === 0 && v.jobs.length === 0 && v.up_to_date === 2,
      "migrations terminées",
      30_000,
    );
    expect(fin).toMatchObject({ model: "m2", by_model: [{ model: "m2", collections: 2 }], empty: 1 });
    expect(q.collections.get(nomQdrantRag(c1, 1))?.dim).toBe(12);
    expect(q.collections.has(nomQdrantRag(c1, 0))).toBe(false);
    expect(q.documents(nomQdrantRag(c1, 1)).size).toBe(2);
    expect(q.documents(nomQdrantRag(c2, 1)).size).toBe(1);
    expect(q.collections.has(nomQdrantRag(c3, 1))).toBe(false);
    const terminees = await t.base.valeurs<[unknown, unknown, unknown]>(
      "SELECT status, done, total FROM rag_jobs WHERE kind='migrate' ORDER BY collection_id",
    );
    expect(terminees.map(([s]) => s)).toEqual(["done", "done"]);
    expect((await app.appeler(admin, "POST", "/api/admin/rag/reindexer", {})).corps).toMatchObject({
      started: 0,
      to_migrate: 0,
    });
  });

  it("« forcer » refait aussi les collections déjà au modèle configuré", async () => {
    const c1 = await creerCollection(t.base, alice, "Contrats");
    demarrer();
    await indexer(alice, c1, "a.txt", "Alpha.");
    const r = await app.appeler(admin, "POST", "/api/admin/rag/reindexer", { force: true });
    expect(r.corps).toMatchObject({ started: 1 });
    await jusqua(
      async () => (await lire()).jobs.length === 0 && q.collections.has(nomQdrantRag(c1, 1)),
      "génération 1",
    );
    expect(q.documents(nomQdrantRag(c1, 1)).size).toBe(1);
  });

  it("RAG sans serveur d'embeddings : 503 rag_desactive, rien n'est créé", async () => {
    const c1 = await creerCollection(t.base, alice, "Contrats");
    await t.base.run("UPDATE rag_collections SET embed_model = 'm0' WHERE id = ?", [c1]);
    ecrireConfig({ embedUrl: "" });
    const r = await app.appeler(admin, "POST", "/api/admin/rag/reindexer", {});
    expect([r.statut, (r.corps as { code?: string }).code]).toEqual([503, "rag_desactive"]);
    expect((await lire()).embed_configured).toBe(false);
    expect((await t.base.valeurs<[unknown]>("SELECT COUNT(*) FROM rag_jobs"))[0]?.[0]).toBe(0);
  });

  it("travaux : liste de tout le monde sans nom de document, suspendre, reprendre, annuler depuis la console ; un travail fini ne se change plus", async () => {
    const c1 = await creerCollection(t.base, alice, "Contrats");
    const c2 = await creerCollection(t.base, bob, "Finance");
    const a = await main.deposer(alice, c1, { nom: "secret-alice.txt", flux: flux("Alpha") });
    const b = await main.deposer(bob, c2, { nom: "secret-bob.txt", flux: flux("Bravo") });
    const liste = async (): Promise<
      { id: string; status: string; collection_name: string; owner: { username: string } }[]
    > =>
      ((await app.appeler(admin, "GET", "/api/admin/rag/travaux?actifs=1")).corps as { jobs: never[] }).jobs;
    const avantTout = await app.appeler(admin, "GET", "/api/admin/rag/travaux?actifs=1");
    expect(avantTout.brut.toString("utf8")).not.toContain("secret-");
    const jobs = await liste();
    expect(jobs.map((j) => [j.collection_name, j.owner.username, j.status]).sort()).toEqual([
      ["Contrats", "alice", "queued"],
      ["Finance", "bob", "queued"],
    ]);
    const idA = a.travail?.id ?? "";
    const idB = b.travail?.id ?? "";
    const act = (id: string, action: string) =>
      app.appeler(admin, "POST", `/api/admin/rag/travaux/${id}/${action}`);
    expect((await act(idA, "suspendre")).corps).toMatchObject({ job: { id: idA, status: "paused" } });
    demarrer();
    await jusqua(
      async () => (await t.base.get("SELECT status FROM rag_jobs WHERE id=?", [idB]))?.["status"] === "done",
      "travail de bob",
    );
    expect((await t.base.get("SELECT status FROM rag_jobs WHERE id=?", [idA]))?.["status"]).toBe("paused");
    expect((await liste()).map((j) => j.status)).toEqual(["paused"]);
    expect((await act(idA, "reprendre")).corps).toMatchObject({ job: { status: "queued" } });
    await jusqua(
      async () => (await t.base.get("SELECT status FROM rag_jobs WHERE id=?", [idA]))?.["status"] === "done",
      "travail d'alice",
    );
    const fini = await act(idA, "annuler");
    expect([fini.statut, (fini.corps as { code?: string }).code]).toEqual([409, "travail_termine"]);
    const absent = await act("0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", "annuler");
    expect([absent.statut, (absent.corps as { code?: string }).code]).toEqual([404, "travail_introuvable"]);
    expect((await act("pas-un-uuid", "annuler")).statut).toBe(404);
    ext.attenteMs = 10_000;
    const c = await main.deposer(alice, c1, { nom: "lent.txt", flux: flux("Lent") });
    await jusqua(() => travailleur.enCours === 1, "extraction en cours");
    expect((await act(c.travail?.id ?? "", "annuler")).corps).toMatchObject({ job: { status: "cancelled" } });
    await jusqua(() => travailleur.enCours === 0, "traitement interrompu");
    const tous = (await app.appeler(admin, "GET", "/api/admin/rag/travaux")).corps as {
      jobs: { status: string }[];
    };
    expect(tous.jobs.map((j) => j.status).sort()).toEqual(["cancelled", "done", "done"]);
  });
});
