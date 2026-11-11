// SPDX-License-Identifier: MIT
/** apps/core/test/rag/travailleur.test.ts — travailleur d'indexation sur SQLite et PostgreSQL avec un faux extracteur, un faux serveur d'embeddings et Qdrant en mémoire : file, équité, annulation, suspension, reprise, pannes, migration, suppressions, isolation. */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { schemaSystemeTravailRag } from "@elpis/contracts";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { assemblerTexte } from "@elpis/rag";
import type { Bloc } from "@elpis/rag";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { deleteUserFull } from "../../src/comptes/suppression";
import { RefusIndexationRag } from "../../src/rag/erreurs-indexation";
import { lireExtraitRag } from "../../src/rag/indexeur";
import { nomQdrantRag } from "../../src/rag/magasin";
import { purgesEnAttente, traiterPurgesQdrant } from "../../src/rag/qdrant";
import {
  brancherIndexationRag,
  installerServiceIndexationRag,
  serviceIndexationRag,
  ServiceIndexationRag,
} from "../../src/rag/service";
import { TravailleurRag } from "../../src/rag/travailleur";
import type { NotificationRag, ReglagesTravailleurRag } from "../../src/rag/travailleur";
import { CycleDeVie } from "../../src/cycle";
import { journalMuet } from "../aides";
import {
  blocsDuTexte,
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

function ecrireConfig(
  o: { modele?: string; concurrence?: number; par_compte?: number; embedUrl?: string } = {},
): void {
  writeFileSync(
    configJson,
    JSON.stringify({
      rag: {
        store_dir: magasin,
        service_url: ext.url,
        service_token: JETON_EXTRACTEUR,
        qdrant_url: "http://127.0.0.1:9",
        embed: { url: o.embedUrl ?? emb.url, model: o.modele ?? "m1", timeout_s: 5 },
        indexation: { concurrence: o.concurrence ?? 2, par_compte: o.par_compte ?? 1 },
      },
    }),
  );
  invalidateConfigCache();
}

beforeAll(async () => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-rag-travailleur-"));
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

describe.each(MOTEURS)("travailleur d'indexation (%s)", (moteur) => {
  let t: BaseDeTest;
  let alice: number;
  let bob: number;
  let col: string;
  let q: FauxQdrant;
  let evenements: Record<string, unknown>[];
  let notifs: NotificationRag[];
  let w: TravailleurRag;
  let service: ServiceIndexationRag;
  let ctrl: AbortController;
  let boucle: Promise<void> | null;

  function creerTravailleur(bootId?: string): void {
    w = new TravailleurRag({
      base: t.base,
      meneur: { tenu: true, essayer: async () => true },
      diffuser: (m) => void evenements.push(m),
      notifier: async (n) => void notifs.push(n),
      qdrant: () => q,
      reglages: RAPIDE,
      bootId,
    });
    service = new ServiceIndexationRag({
      base: t.base,
      diffuser: (m) => void evenements.push(m),
      travailleur: w,
      qdrant: () => q,
    });
  }

  function demarrer(): void {
    ctrl = new AbortController();
    boucle = w.demarrer(ctrl.signal);
  }

  async function arreter(): Promise<void> {
    if (boucle === null) return;
    ctrl.abort();
    await w.arreter();
    await boucle;
    boucle = null;
  }

  beforeEach(async () => {
    ext.mode = "ok";
    ext.attenteMs = 0;
    ext.demandes.length = 0;
    ext.maxGlobal = 0;
    ext.maxParCompte = 0;
    ext.fermees = 0;
    emb.panne = false;
    emb.dimensions.clear();
    emb.modeles.length = 0;
    ecrireConfig();
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    alice = await creerCompte(t.base, "alice");
    bob = await creerCompte(t.base, "bob");
    col = await creerCollection(t.base, alice, "Contrats");
    q = new FauxQdrant();
    evenements = [];
    notifs = [];
    boucle = null;
    creerTravailleur();
  });

  afterEach(async () => {
    await arreter();
    await t.fermer();
    rmSync(magasin, { recursive: true, force: true });
  });

  const doc = async (id: string): Promise<Record<string, unknown>> =>
    (await t.base.get("SELECT * FROM rag_documents WHERE id=?", [id])) ?? {};
  const travail = async (id: string): Promise<Record<string, unknown>> =>
    (await t.base.get("SELECT * FROM rag_jobs WHERE id=?", [id])) ?? {};
  const collection = async (id = col): Promise<Record<string, unknown>> =>
    (await t.base.get("SELECT * FROM rag_collections WHERE id=?", [id])) ?? {};
  const deposer = async (
    uid: number,
    c: string,
    nom: string,
    contenu: string,
  ): Promise<{ doc: string; job: string }> => {
    const r = await service.deposer(uid, c, { nom, flux: flux(contenu) });
    return { doc: r.document.id, job: r.travail?.id ?? "" };
  };
  const fileVide = async (): Promise<void> =>
    jusqua(async () => {
      const [n] = await t.base.valeurs<[unknown]>(
        "SELECT COUNT(*) FROM rag_jobs WHERE status IN ('queued', 'running', 'paused')",
      );
      return Number(n?.[0]) === 0;
    }, "plus aucun travail actif");
  const code = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return "accepte";
    } catch (e) {
      return e instanceof RefusIndexationRag ? e.code : `autre: ${String(e)}`;
    }
  };

  it("indexe de bout en bout : extrait, passages, compteurs, travail terminé, événements valides, notification", async () => {
    const texte =
      "# Contrat\n\nLe renouvellement est automatique chaque année.\n\nLa résiliation se fait par courrier.";
    const { doc: id, job } = await deposer(alice, col, "contrat.md", texte);
    demarrer();
    await jusqua(async () => (await travail(job))["status"] === "done", "travail terminé");
    const d = await doc(id);
    expect(d).toMatchObject({ status: "ready", error_code: null, rel_path: "contrat.md" });
    expect(Number(d["chunk_count"])).toBeGreaterThan(0);
    expect(String(d["chunk_params_hash"])).toMatch(/^[0-9a-f]{12}$/);
    const nom = nomQdrantRag(col, 0);
    const points = q.passages(nom, id);
    expect(points).toHaveLength(Number(d["chunk_count"]));
    expect(points[0]?.charge).toMatchObject({
      doc_id: id,
      rel_path: "contrat.md",
      ext: "md",
      chunk_index: 0,
    });
    expect(points[0]?.dense).toHaveLength(8);
    const extrait = lireExtraitRag(alice, col, id);
    expect(extrait?.text).toBe(assemblerTexte(blocsDuTexte(texte) as Bloc[]));
    for (const p of points)
      expect(extrait?.text.slice(p.charge.char_start, p.charge.char_end)).toContain(
        p.charge.text.slice(0, 20),
      );
    const c = await collection();
    expect([
      c["status"],
      c["embed_model"],
      Number(c["embed_dim"]),
      Number(c["doc_count"]),
      Number(c["chunk_count"]),
    ]).toEqual(["ready", "m1", 8, 1, points.length]);
    expect(await travail(job)).toMatchObject({ status: "done", worker_boot_id: w.bootId });
    expect([Number((await travail(job))["done"]), Number((await travail(job))["failed"])]).toEqual([1, 0]);
    expect(ext.demandes[0]).toMatchObject({
      source: `${alice}/${col}/sources/${id}.md`,
      ext: "md",
      ocr: false,
    });
    for (const e of evenements) schemaSystemeTravailRag.parse(e);
    const etats = evenements
      .map((e) => (e as { data: { document?: { status: string } } }).data.document?.status)
      .filter(Boolean);
    expect(etats).toContain("ready");
    await jusqua(() => notifs.length >= 1, "notification");
    expect(notifs).toEqual([
      {
        uid: alice,
        kind: "rag_ok",
        title: "Indexation terminée : Contrats",
        body: "1 document(s) indexé(s).",
        collectionId: col,
      },
    ]);
  });

  async function troisComptes(): Promise<{ carol: number }> {
    const carol = await creerCompte(t.base, "carol");
    const cb = await creerCollection(t.base, bob, "B");
    const cc = await creerCollection(t.base, carol, "C");
    for (let i = 0; i < 4; i++) await deposer(alice, col, `a${i}.txt`, `Alice document ${i}.`);
    for (let i = 0; i < 2; i++) await deposer(bob, cb, `b${i}.txt`, `Bob document ${i}.`);
    await deposer(carol, cc, "c0.txt", "Carol document.");
    return { carol };
  }

  async function tousFinis(): Promise<void> {
    await jusqua(async () => {
      const [n] = await t.base.valeurs<[unknown]>("SELECT COUNT(*) FROM rag_jobs WHERE status='done'");
      return Number(n?.[0]) === 3;
    }, "3 travaux finis");
  }

  it("gros document : points construits par tranches de 64, tous insérés dans l'ordre", async () => {
    const texte = Array.from(
      { length: 400 },
      (_, i) => `## Section ${i}\n\n${`Paragraphe ${i} sur le renouvellement du contrat. `.repeat(12)}`,
    ).join("\n\n");
    const { doc: id, job } = await deposer(alice, col, "gros.md", texte);
    demarrer();
    await jusqua(async () => (await travail(job))["status"] === "done", "travail terminé");
    const points = q.passages(nomQdrantRag(col, 0), id);
    expect(points.length).toBeGreaterThan(64);
    expect(points.length).toBe(Number((await doc(id))["chunk_count"]));
    expect(points.map((p) => p.charge.chunk_index).sort((a, b) => a - b)).toEqual(points.map((_, i) => i));
  });

  it("concurrence globale 2, un document à la fois par compte", async () => {
    await troisComptes();
    ext.attenteMs = 60;
    demarrer();
    await tousFinis();
    expect(ext.maxGlobal).toBe(2);
    expect(ext.maxParCompte).toBe(1);
    const [n] = await t.base.valeurs<[unknown]>("SELECT COUNT(*) FROM rag_documents WHERE status='ready'");
    expect(Number(n?.[0])).toBe(7);
  });

  it("tourniquet entre comptes : le compte le moins récemment servi passe d'abord", async () => {
    ecrireConfig({ concurrence: 1, par_compte: 1 });
    const { carol } = await troisComptes();
    demarrer();
    await tousFinis();
    expect(ext.demandes.map((d) => Number(d.source.split("/")[0]))).toEqual([
      alice,
      bob,
      carol,
      alice,
      bob,
      alice,
      alice,
    ]);
    await jusqua(() => notifs.length >= 3, "notification");
    expect(new Set(notifs.map((x) => x.uid))).toEqual(new Set([alice, bob, carol]));
  });

  it("par compte réglé à 2 : deux documents du même compte en parallèle", async () => {
    ecrireConfig({ concurrence: 3, par_compte: 2 });
    for (let i = 0; i < 4; i++) await deposer(alice, col, `a${i}.txt`, `Alice ${i}.`);
    ext.attenteMs = 80;
    demarrer();
    await jusqua(
      async () =>
        (await collection())["status"] === "ready" && Number((await collection())["chunk_count"]) >= 4,
      "fini",
    );
    expect(ext.maxParCompte).toBe(2);
  });

  it("annulation : documents en cours interrompus, passages absents, documents en échec « annulé », aucune notification", async () => {
    for (let i = 0; i < 3; i++) await deposer(alice, col, `a${i}.txt`, `Texte ${i}.`);
    ext.attenteMs = 10_000;
    demarrer();
    await jusqua(() => ext.demandes.length >= 1, "extraction commencée");
    const job = String((await t.base.get("SELECT id FROM rag_jobs"))?.["id"]);
    const r = await service.annuler(alice, job);
    expect(r.status).toBe("cancelled");
    await jusqua(() => ext.fermees >= 1, "requête d'extraction fermée");
    await jusqua(() => w.enCours === 0, "plus rien en cours");
    const lignes = await t.base.all("SELECT status, error_code, error_message FROM rag_documents");
    expect(lignes.map((l) => [l["status"], l["error_code"]])).toEqual(
      Array.from({ length: 3 }, () => ["error", "cancelled"]),
    );
    expect(String(lignes[0]?.["error_message"])).toContain("annulée");
    expect(q.collections.size).toBe(0);
    expect(notifs).toEqual([]);
    expect(await code(service.annuler(alice, job))).toBe("accepte");
    expect(await code(service.reprendre(alice, job))).toBe("travail_termine");
  });

  it("suspension puis reprise : le document en cours revient en file, rien ne part pendant la pause, puis tout finit", async () => {
    const { job } = await deposer(alice, col, "a.txt", "Premier.");
    await deposer(alice, col, "b.txt", "Second.");
    ext.attenteMs = 10_000;
    demarrer();
    await jusqua(() => ext.demandes.length === 1, "première extraction");
    expect((await service.suspendre(alice, job)).status).toBe("paused");
    await jusqua(() => w.enCours === 0, "document interrompu");
    expect(
      (await t.base.all("SELECT status FROM rag_documents ORDER BY created_at")).map((l) => l["status"]),
    ).toEqual(["pending", "pending"]);
    ext.attenteMs = 0;
    await new Promise((r) => setTimeout(r, 200));
    expect(ext.demandes).toHaveLength(1);
    expect(await code(service.suspendre(bob, job))).toBe("travail_introuvable");
    expect((await service.reprendre(alice, job)).status).toBe("queued");
    await jusqua(async () => (await travail(job))["status"] === "done", "travail terminé");
    expect([Number((await travail(job))["done"]), Number((await travail(job))["total"])]).toEqual([2, 2]);
  });

  it("reprise après un arrêt brutal : travail d'un autre démarrage repris, document « en cours » retraité", async () => {
    const { doc: id, job } = await deposer(alice, col, "a.txt", "Texte à reprendre.");
    await t.base.run("UPDATE rag_documents SET status='indexing' WHERE id=?", [id]);
    await t.base.run(
      "UPDATE rag_jobs SET status='running', worker_boot_id='ancien-demarrage', heartbeat_at=1 WHERE id=?",
      [job],
    );
    creerTravailleur("nouveau-demarrage");
    demarrer();
    await jusqua(async () => (await travail(job))["status"] === "done", "repris et terminé");
    expect((await doc(id))["status"]).toBe("ready");
    expect((await travail(job))["worker_boot_id"]).toBe("nouveau-demarrage");
  });

  it("arrêt du process : documents interrompus remis en attente, travail rendu à la file, repris par le suivant", async () => {
    const { doc: id, job } = await deposer(alice, col, "a.txt", "Texte.");
    ext.attenteMs = 10_000;
    demarrer();
    await jusqua(() => ext.demandes.length === 1, "extraction commencée");
    await jusqua(async () => Number((await travail(job))["heartbeat_at"]) > 0, "battement");
    await arreter();
    expect((await doc(id))["status"]).toBe("pending");
    expect(await travail(job)).toMatchObject({ status: "queued", worker_boot_id: null });
    ext.attenteMs = 0;
    creerTravailleur();
    demarrer();
    await jusqua(async () => (await travail(job))["status"] === "done", "repris par le suivant");
  });

  it("pannes : extracteur 503 puis embeddings 503 laissent le document en attente sans échec, puis il est indexé", async () => {
    ext.mode = "panne";
    const { doc: id, job } = await deposer(alice, col, "a.txt", "Texte patient.");
    demarrer();
    await jusqua(
      async () => (await doc(id))["error_code"] === "extractor_unavailable",
      "attente de l'extracteur",
    );
    expect((await doc(id))["status"]).toBe("pending");
    await jusqua(
      async () => String((await travail(job))["error"]).includes("Extracteur"),
      "motif d'attente du travail",
    );
    expect(Number((await travail(job))["failed"])).toBe(0);
    emb.panne = true;
    ext.mode = "ok";
    await jusqua(async () => (await doc(id))["error_code"] === "embed_unavailable", "attente des embeddings");
    expect(String((await doc(id))["error_message"])).toContain("Serveur d'embeddings injoignable");
    expect(existsSync(join(magasin, String(alice), col, "extraits", `${id}.json`))).toBe(true);
    const demandesAvant = ext.demandes.length;
    emb.panne = false;
    await jusqua(async () => (await travail(job))["status"] === "done", "indexé après retour");
    expect(await doc(id)).toMatchObject({ status: "ready", error_code: null, error_message: null });
    expect(ext.demandes.length).toBe(demandesAvant);
    expect((await travail(job))["error"]).toBeNull();
  });

  it("Qdrant injoignable : attente sans échec ; extraction gardée", async () => {
    q.panne = true;
    const { doc: id, job } = await deposer(alice, col, "a.txt", "Texte.");
    demarrer();
    await jusqua(async () => (await doc(id))["error_code"] === "qdrant_unavailable", "attente de Qdrant");
    q.panne = false;
    await jusqua(async () => (await travail(job))["status"] === "done", "indexé");
  });

  it("échecs propres au document : sans texte (message lisible), flux coupé trois fois ; le travail finit avec ses échecs", async () => {
    const { doc: vide, job } = await deposer(alice, col, "scan.txt", "NOTEXT");
    const { doc: bon } = await deposer(alice, col, "bon.txt", "Texte normal.");
    demarrer();
    await jusqua(async () => (await travail(job))["status"] === "done", "travail terminé");
    expect(await doc(vide)).toMatchObject({
      status: "error",
      error_code: "no_text",
      error_message: "Sans texte : activez l'OCR pour les documents scannés.",
    });
    expect((await doc(bon))["status"]).toBe("ready");
    expect([Number((await travail(job))["done"]), Number((await travail(job))["failed"])]).toEqual([1, 1]);
    await jusqua(() => notifs.length >= 1, "notification");
    expect(notifs[0]).toMatchObject({
      kind: "rag_error",
      title: "Indexation terminée avec 1 échec(s) : Contrats",
    });
    ext.mode = "coupe";
    const { doc: coupe, job: job2 } = await deposer(alice, col, "coupe.txt", "Coupé.");
    await jusqua(async () => (await travail(job2))["status"] === "done", "flux coupé abandonné", 20_000);
    expect(await doc(coupe)).toMatchObject({ status: "error", error_code: "internal" });
    expect(ext.demandes.filter((d) => d.source.includes(coupe))).toHaveLength(3);
  });

  it("réindexation : seulement les documents dont le découpage a changé, l'extrait est relu ; forcée ou avec réextraction", async () => {
    const a = await deposer(alice, col, "a.txt", "Alpha.");
    const b = await deposer(alice, col, "b.txt", "Bravo.");
    demarrer();
    await jusqua(async () => (await travail(a.job))["status"] === "done", "première indexation");
    expect((await doc(b.doc))["status"]).toBe("ready");
    expect(await service.reindexer(alice, col)).toBeNull();
    const n = ext.demandes.length;
    await t.base.run("UPDATE rag_collections SET chunk_json=? WHERE id=?", [
      JSON.stringify({ mode: "manuel", chunk_tokens: 128, overlap_tokens: 16 }),
      col,
    ]);
    const r = await service.reindexer(alice, col, { documents: [a.doc] });
    expect(r).toMatchObject({ kind: "reindex", total: 1 });
    await jusqua(async () => (await travail(r?.id ?? ""))["status"] === "done", "réindexé");
    expect(ext.demandes.length).toBe(n);
    const hashes = await t.base.all("SELECT chunk_params_hash FROM rag_documents ORDER BY created_at");
    expect(hashes[0]?.["chunk_params_hash"]).not.toBe(hashes[1]?.["chunk_params_hash"]);
    const tous = await service.reindexer(alice, col);
    expect(tous?.total).toBe(1);
    await jusqua(async () => (await travail(tous?.id ?? ""))["status"] === "done", "b réindexé");
    const force = await service.reindexer(alice, col, { force: true, reextraire: true });
    expect(force?.total).toBe(2);
    await jusqua(async () => (await travail(force?.id ?? ""))["status"] === "done", "forcé");
    expect(ext.demandes.length).toBe(n + 2);
    expect(await code(service.reindexer(bob, col))).toBe("collection_introuvable");
    expect(
      await code(service.reindexer(alice, col, { documents: ["0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"] })),
    ).toBe("document_introuvable");
  });

  it("migration de modèle : nouvelle génération construite pendant que l'ancienne sert, bascule, ancienne supprimée ; dépôt en attente indexé après", async () => {
    const a = await deposer(alice, col, "a.txt", "Alpha.");
    await deposer(alice, col, "b.txt", "Bravo.");
    demarrer();
    await jusqua(async () => (await travail(a.job))["status"] === "done", "indexé avec m1");
    const g0 = nomQdrantRag(col, 0);
    expect(q.documents(g0).size).toBe(2);
    emb.dimensions.set("m2", 12);
    ecrireConfig({ modele: "m2" });
    const c2 = await deposer(alice, col, "c.txt", "Charlie.");
    await jusqua(
      async () => (await collection())["embed_model"] === "m2" && (await doc(c2.doc))["status"] === "ready",
      "migré",
      20_000,
    );
    await fileVide();
    const g1 = nomQdrantRag(col, 1);
    const c = await collection();
    expect([Number(c["embed_dim"]), JSON.parse(String(c["meta_json"])).generation, c["status"]]).toEqual([
      12,
      1,
      "ready",
    ]);
    expect(q.collections.has(g0)).toBe(false);
    expect(q.supprimees).toContain(g0);
    expect(q.collections.get(g1)?.dim).toBe(12);
    expect(q.documents(g1).size).toBe(3);
    const migration = await t.base.get("SELECT * FROM rag_jobs WHERE kind='migrate'");
    expect(migration).toMatchObject({ status: "done" });
    expect([Number(migration?.["done"]), Number(migration?.["total"])]).toEqual([2, 2]);
    expect(emb.modeles.filter((m) => m === "m2").length).toBeGreaterThan(0);
    await jusqua(() => notifs.some((n) => n.title.startsWith("Migration")), "notification");
    expect(notifs.map((n) => n.title)).toContain("Migration du modèle terminée : Contrats");
    expect(await service.migrerTout()).toBe(0);
  });

  it("migration annulée : la nouvelle génération est supprimée, l'ancienne continue de servir", async () => {
    const a = await deposer(alice, col, "a.txt", "Alpha.");
    demarrer();
    await jusqua(async () => (await travail(a.job))["status"] === "done", "indexé");
    await arreter();
    emb.dimensions.set("m2", 12);
    ecrireConfig({ modele: "m2" });
    expect(await service.migrerTout()).toBe(1);
    const m = String((await t.base.get("SELECT id FROM rag_jobs WHERE kind='migrate'"))?.["id"]);
    expect((await collection())["status"]).toBe("migrating");
    q.collections.set(nomQdrantRag(col, 1), { dim: 12, points: new Map() });
    expect((await service.annuler("admin", m)).status).toBe("cancelled");
    expect(q.collections.has(nomQdrantRag(col, 1))).toBe(false);
    expect(q.documents(nomQdrantRag(col, 0)).size).toBe(1);
    expect(await collection()).toMatchObject({ status: "ready", embed_model: "m1" });
  });

  it("migration annulée pendant une panne de Qdrant puis relancée : la purge notée ne vide pas la nouvelle génération", async () => {
    const a = await deposer(alice, col, "a.txt", "Alpha.");
    demarrer();
    await jusqua(async () => (await travail(a.job))["status"] === "done", "indexé");
    emb.dimensions.set("m2", 12);
    ecrireConfig({ modele: "m2" });
    expect(await service.migrerTout()).toBe(1);
    const m = String((await t.base.get("SELECT id FROM rag_jobs WHERE kind='migrate'"))?.["id"]);
    const g1 = nomQdrantRag(col, 1);
    q.panne = true;
    expect((await service.annuler("admin", m)).status).toBe("cancelled");
    q.panne = false;
    expect(purgesEnAttente()).toEqual([`q.${g1}`]);
    expect(await service.migrerTout()).toBe(1);
    await jusqua(async () => (await collection())["embed_model"] === "m2", "migré");
    await traiterPurgesQdrant(q);
    expect(q.documents(g1).size).toBe(1);
    expect(purgesEnAttente()).toEqual([]);
  });

  it("migration : une erreur inattendue est réessayée avec délai, trois fois au plus, puis le document échoue et la bascule a lieu", async () => {
    const a = await deposer(alice, col, "a.txt", "Alpha.");
    const b = await deposer(alice, col, "b.txt", "Bravo.");
    demarrer();
    await jusqua(async () => (await travail(b.job))["status"] === "done", "indexés");
    await arreter();
    const extrait = join(magasin, String(alice), col, "extraits", `${a.doc}.json`);
    rmSync(extrait);
    mkdirSync(extrait);
    emb.dimensions.set("m2", 12);
    ecrireConfig({ modele: "m2" });
    expect(await service.migrerTout()).toBe(1);
    const n = ext.demandes.length;
    const debut = Date.now();
    creerTravailleur();
    demarrer();
    const migration = async (): Promise<Record<string, unknown>> =>
      (await t.base.get("SELECT * FROM rag_jobs WHERE kind='migrate'")) ?? {};
    await jusqua(
      async () => ext.demandes.length - n > 3 || (await migration())["status"] === "done",
      "migration finie ou essais épuisés",
    );
    expect(ext.demandes.length - n).toBe(3);
    expect(Date.now() - debut).toBeGreaterThanOrEqual(240);
    expect(await doc(a.doc)).toMatchObject({ status: "error", error_code: "internal" });
    expect(Number((await migration())["failed"])).toBe(1);
    expect((await collection())["embed_model"]).toBe("m2");
  });

  it("nouvelle version en échec ou annulée : les passages de l'ancienne version ne sont plus servis", async () => {
    const a = await deposer(alice, col, "a.txt", "Alpha.");
    const b = await deposer(alice, col, "b.txt", "Bravo.");
    demarrer();
    await jusqua(async () => (await travail(a.job))["status"] === "done", "indexés");
    const g0 = nomQdrantRag(col, 0);
    expect(q.documents(g0)).toEqual(new Set([a.doc, b.doc]));
    const a2 = await deposer(alice, col, "a.txt", "NOTEXT");
    expect(a2.doc).toBe(a.doc);
    await jusqua(async () => (await travail(a2.job))["status"] === "done", "nouvelle version en échec");
    expect(await doc(a.doc)).toMatchObject({ status: "error", error_code: "no_text" });
    expect(q.passages(g0, a.doc)).toEqual([]);
    await arreter();
    const effaces = q.effaces.length;
    const neuf = await deposer(alice, col, "c.txt", "Charlie.");
    expect((await service.annuler(alice, neuf.job)).status).toBe("cancelled");
    expect(q.effaces.length).toBe(effaces);
    const b2 = await deposer(alice, col, "b.txt", "Bravo, seconde version.");
    expect((await deposer(alice, col, "a.txt", "Alpha, troisième version.")).job).toBe(b2.job);
    expect((await deposer(alice, col, "d.txt", "Delta.")).job).toBe(b2.job);
    expect((await service.annuler(alice, b2.job)).status).toBe("cancelled");
    expect(await doc(b.doc)).toMatchObject({ status: "error", error_code: "cancelled" });
    expect(q.passages(g0, b.doc)).toEqual([]);
    expect(q.effaces.slice(effaces).map((ids) => [...ids].sort())).toEqual([[a.doc, b.doc].sort()]);
  });

  it("migration dont aucun document n'est migré : pas de bascule, l'ancienne génération reste servie", async () => {
    const a = await deposer(alice, col, "a.txt", "Alpha.");
    demarrer();
    await jusqua(async () => (await travail(a.job))["status"] === "done", "indexé");
    await arreter();
    const avant = (await collection())["embed_model"];
    const extrait = join(magasin, String(alice), col, "extraits", `${a.doc}.json`);
    rmSync(extrait);
    mkdirSync(extrait);
    emb.dimensions.set("m2", 12);
    ecrireConfig({ modele: "m2" });
    expect(await service.migrerTout()).toBe(1);
    creerTravailleur();
    demarrer();
    const migration = async (): Promise<Record<string, unknown>> =>
      (await t.base.get("SELECT * FROM rag_jobs WHERE kind='migrate'")) ?? {};
    await jusqua(
      async () => ["done", "failed"].includes(String((await migration())["status"])),
      "migration finie",
    );
    expect(await migration()).toMatchObject({ status: "failed" });
    expect((await collection())["embed_model"]).toBe(avant);
    expect(q.passages(nomQdrantRag(col, 0), a.doc).length).toBeGreaterThan(0);
    expect(q.collections.has(nomQdrantRag(col, 1))).toBe(false);
  });

  it("suppression d'un document pendant son extraction : traitement interrompu, fichiers et passages absents", async () => {
    const a = await deposer(alice, col, "a.txt", "Alpha.");
    demarrer();
    await jusqua(async () => (await travail(a.job))["status"] === "done", "indexé");
    expect(q.passages(nomQdrantRag(col, 0), a.doc).length).toBeGreaterThan(0);
    await service.supprimerDocument(alice, col, a.doc);
    expect(q.passages(nomQdrantRag(col, 0), a.doc)).toEqual([]);
    ext.attenteMs = 10_000;
    const b = await deposer(alice, col, "b.txt", "Bravo.");
    await jusqua(() => w.enCours === 1, "extraction de b");
    expect(await code(service.supprimerDocument(bob, col, b.doc))).toBe("collection_introuvable");
    await service.supprimerDocument(alice, col, b.doc);
    await jusqua(() => w.enCours === 0, "traitement interrompu");
    expect(await doc(b.doc)).toEqual({});
    expect(readdirSync(join(magasin, String(alice), col, "sources"))).toEqual([]);
    expect(readdirSync(join(magasin, String(alice), col, "extraits"))).toEqual([]);
    expect(q.documents(nomQdrantRag(col, 0)).size).toBe(0);
    expect(Number((await collection())["doc_count"])).toBe(0);
    expect(await code(service.supprimerDocument(alice, col, b.doc))).toBe("document_introuvable");
  });

  it("suppression d'une collection pendant l'indexation : travail interrompu, Qdrant de toutes générations et dossier supprimés", async () => {
    const a = await deposer(alice, col, "a.txt", "Alpha.");
    demarrer();
    await jusqua(async () => (await travail(a.job))["status"] === "done", "indexé");
    q.collections.set(nomQdrantRag(col, 3), { dim: 8, points: new Map() });
    ext.attenteMs = 10_000;
    await deposer(alice, col, "b.txt", "Bravo.");
    await jusqua(() => w.enCours === 1, "extraction en cours");
    expect(await code(service.supprimerCollection(bob, col))).toBe("collection_introuvable");
    await service.supprimerCollection(alice, col);
    await jusqua(() => w.enCours === 0, "interrompu");
    expect([...q.collections.keys()]).toEqual([]);
    expect(existsSync(join(magasin, String(alice), col))).toBe(false);
    expect(await t.base.all("SELECT id FROM rag_jobs")).toEqual([]);
  });

  it("Qdrant injoignable à la suppression : effacement noté puis rejoué", async () => {
    const a = await deposer(alice, col, "a.txt", "Alpha.");
    demarrer();
    await jusqua(async () => (await travail(a.job))["status"] === "done", "indexé");
    await arreter();
    q.panne = true;
    await service.supprimerDocument(alice, col, a.doc);
    expect(purgesEnAttente()).toEqual([`d.${col}.${a.doc}`]);
    expect(await traiterPurgesQdrant(q)).toEqual({ faites: 0, restantes: 1 });
    q.panne = false;
    expect(await traiterPurgesQdrant(q)).toEqual({ faites: 1, restantes: 0 });
    expect(q.documents(nomQdrantRag(col, 0)).size).toBe(0);
    q.panne = true;
    await service.supprimerCollection(alice, col);
    q.panne = false;
    expect(purgesEnAttente()).toEqual([`c.${col}`]);
    await traiterPurgesQdrant(q);
    expect(q.collections.size).toBe(0);
    expect(purgesEnAttente()).toEqual([]);
  });

  it("branchement et suppression d'un compte : rappel inscrit une fois, collections Qdrant et dossier du compte effacés", async () => {
    const cycle = new CycleDeVie(journalMuet);
    expect(brancherIndexationRag("admin", t.base, cycle, {}).travailleur).toBeNull();
    const principal = brancherIndexationRag("main", t.base, cycle, {
      meneur: { tenu: true, essayer: async () => true },
    });
    expect(principal.travailleur).not.toBeNull();
    expect(serviceIndexationRag()).toBe(principal);
    const a = await deposer(alice, col, "a.txt", "Alpha.");
    const b = await deposer(bob, await creerCollection(t.base, bob, "B"), "b.txt", "Bravo.");
    demarrer();
    await jusqua(
      async () => (await travail(a.job))["status"] === "done" && (await travail(b.job))["status"] === "done",
      "indexés",
    );
    await arreter();
    installerServiceIndexationRag(new ServiceIndexationRag({ base: t.base, qdrant: () => q }));
    try {
      expect(await deleteUserFull(t.base, alice)).toBe(true);
    } finally {
      installerServiceIndexationRag(null);
    }
    expect(q.collections.has(nomQdrantRag(col, 0))).toBe(false);
    expect(q.collections.size).toBe(1);
    expect(existsSync(join(magasin, String(alice)))).toBe(false);
    expect(existsSync(join(magasin, String(bob)))).toBe(true);
  });

  it("isolation : jamais d'accès d'un compte aux travaux, fichiers ou passages d'un autre", async () => {
    const cb = await creerCollection(t.base, bob, "B");
    const a = await deposer(alice, col, "a.txt", "Secret d'Alice.");
    const b = await deposer(bob, cb, "b.txt", "Note de Bob.");
    demarrer();
    await jusqua(
      async () => (await travail(a.job))["status"] === "done" && (await travail(b.job))["status"] === "done",
      "indexés",
    );
    expect((await service.travauxDu(bob)).map((x) => x.collection_id)).toEqual([cb]);
    expect((await service.travauxDu(alice)).map((x) => x.collection_id)).toEqual([col]);
    for (const f of [
      () => service.suspendre(bob, a.job),
      () => service.reprendre(bob, a.job),
      () => service.annuler(bob, a.job),
      () => service.supprimerDocument(bob, col, a.doc),
      () => service.supprimerDocument(bob, cb, a.doc),
      () => service.reindexer(bob, col),
      () => service.deposer(bob, col, { nom: "x.txt", flux: flux("x") }),
    ])
      expect(await code(f())).toMatch(/^(travail_introuvable|collection_introuvable|document_introuvable)$/);
    expect(q.documents(nomQdrantRag(col, 0))).toEqual(new Set([a.doc]));
    expect(q.documents(nomQdrantRag(cb, 0))).toEqual(new Set([b.doc]));
    expect(ext.demandes.find((d) => d.source.includes(a.doc))?.source.startsWith(`${alice}/${col}/`)).toBe(
      true,
    );
    expect(ext.demandes.find((d) => d.source.includes(b.doc))?.source.startsWith(`${bob}/${cb}/`)).toBe(true);
    expect(readdirSync(join(magasin, String(bob), cb, "sources"))).toEqual([`${b.doc}.txt`]);
    expect(
      evenements.every((e) => {
        const d = (e as { data: { user_id: number; collection_id: string } }).data;
        return (
          (d.user_id === alice && d.collection_id === col) || (d.user_id === bob && d.collection_id === cb)
        );
      }),
    ).toBe(true);
  });

  it("RAG non configuré : le travailleur ne touche pas la base et laisse la file intacte", async () => {
    const { job } = await deposer(alice, col, "a.txt", "Texte.");
    ecrireConfig({ embedUrl: "" });
    demarrer();
    await new Promise((r) => setTimeout(r, 200));
    expect(ext.demandes).toEqual([]);
    expect((await travail(job))["status"]).toBe("queued");
    expect(w.estLeader).toBe(false);
    ecrireConfig();
    w.reveiller();
    await jusqua(async () => (await travail(job))["status"] === "done", "indexé une fois configuré");
  });

  it("débit des événements : pas un message par passage, l'état final toujours transmis", async () => {
    const lignes = Array.from(
      { length: 300 },
      (_, i) => `Paragraphe ${i} avec quelques mots pour remplir le passage.`,
    ).join("\n\n");
    const { job } = await deposer(alice, col, "long.txt", lignes);
    demarrer();
    await jusqua(async () => (await travail(job))["status"] === "done", "fini");
    const n = Number((await collection())["chunk_count"]);
    expect(n).toBeGreaterThan(10);
    expect(evenements.length).toBeLessThan(10);
    const dernier = evenements.at(-1) as { data: { job: { status: string } } };
    expect(dernier.data.job.status).toBe("done");
    expect(
      readFileSync(
        join(
          magasin,
          String(alice),
          col,
          "extraits",
          `${(await t.base.get("SELECT id FROM rag_documents"))?.["id"]}.json`,
        ),
        "utf8",
      ),
    ).toContain("Paragraphe 299");
  });
});
