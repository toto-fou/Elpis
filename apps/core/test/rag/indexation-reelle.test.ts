// SPDX-License-Identifier: MIT
/** apps/core/test/rag/indexation-reelle.test.ts — bout en bout contre un VRAI Qdrant (`ELPIS_QDRANT_BIN`) et le VRAI extracteur Python (`ELPIS_RAG_PY`, uvicorn) avec des embeddings déterministes : PDF et DOCX déposés, indexés, réindexés, remplacés, supprimés ; sauté sans les variables. */
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { invalidateConfigCache, racineDepot, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { ClientQdrant, vecteurRequete } from "@elpis/rag";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { lireExtraitRag } from "../../src/rag/indexeur";
import { nomQdrantRag } from "../../src/rag/magasin";
import { ServiceIndexationRag } from "../../src/rag/service";
import { TravailleurRag } from "../../src/rag/travailleur";
import { creerCollection, creerCompte, demarrerFauxEmbeddings, flux, jusqua } from "./aides-indexation";
import type { FauxEmbeddings } from "./aides-indexation";

const QDRANT = process.env["ELPIS_QDRANT_BIN"] ?? "";
const PYTHON = process.env["ELPIS_RAG_PY"] ?? "";
const ACTIF = QDRANT !== "" && PYTHON !== "" && existsSync(QDRANT) && existsSync(PYTHON);
const JETON = "jeton-integration-rag";
const ENV = ["RAG_SERVICE_URL", "RAG_SERVICE_TOKEN", "RAG_STORE_DIR", "ELPIS_RAG_ACCESS_DIR"] as const;

/** Documents témoins : un PDF de trois pages (titres, paragraphes) et un DOCX (titres, liste, tableau). */
const GENERATEUR = String.raw`
import sys
from pathlib import Path
from fpdf import FPDF
from docx import Document
sortie = Path(sys.argv[1])
pdf = FPDF(unit="pt", format="A4")
for p, (titre, texte) in enumerate([
    ("Rapport sur le climat", "Le rechauffement climatique accelere. Les glaciers alpins reculent chaque annee."),
    ("Mesures et donnees", "Les stations meteorologiques relevent la temperature toutes les heures."),
    ("Conclusion", "Une reduction des emissions de carbone est necessaire avant 2040."),
], start=1):
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 20)
    pdf.text(72, 100, titre)
    pdf.set_font("Helvetica", "", 11)
    pdf.set_xy(72, 130)
    pdf.multi_cell(420, 14, (texte + " ") * 6)
pdf.output(str(sortie / "rapport.pdf"))
def docx(chemin, fin):
    doc = Document()
    doc.add_heading("Guide de demarrage", level=1)
    doc.add_paragraph("Ce guide explique comment demarrer le service de facturation.")
    doc.add_heading("Installation", level=2)
    doc.add_paragraph("Premier element", style="List Bullet")
    doc.add_paragraph("Second element", style="List Bullet")
    t = doc.add_table(rows=2, cols=2)
    t.rows[0].cells[0].text, t.rows[0].cells[1].text = "port", "8000"
    t.rows[1].cells[0].text, t.rows[1].cells[1].text = "hote", "localhost"
    doc.add_paragraph(fin)
    doc.save(str(chemin))
docx(sortie / "guide.docx", "Fin du document.")
docx(sortie / "guide-v2.docx", "Nouvelle section sur la sauvegarde nocturne des factures.")
`;

async function portsLibres(n: number): Promise<number[]> {
  const ecouteurs = await Promise.all(
    Array.from(
      { length: n },
      () =>
        new Promise<Server>((resolve, reject) => {
          const s = createServer();
          s.once("error", reject);
          s.listen(0, "127.0.0.1", () => resolve(s));
        }),
    ),
  );
  const ports = ecouteurs.map((s) => (s.address() as { port: number }).port);
  await Promise.all(ecouteurs.map((s) => new Promise<void>((r) => s.close(() => r()))));
  return ports;
}

async function arreterProcessus(p: ChildProcess | undefined): Promise<void> {
  if (p === undefined || p.exitCode !== null || p.signalCode !== null) return;
  const fin = new Promise<void>((resolve) => p.once("exit", () => resolve()));
  p.kill("SIGTERM");
  const force = setTimeout(() => p.kill("SIGKILL"), 10_000);
  await fin;
  clearTimeout(force);
}

describe.skipIf(!ACTIF)("indexation réelle : Qdrant et extracteur Python", () => {
  let dossier = "";
  let qdrant: ChildProcess | undefined;
  let uvicorn: ChildProcess | undefined;
  let journal = "";
  let q: ClientQdrant;
  let emb: FauxEmbeddings;
  let t: BaseDeTest;
  let restaurer: () => void = () => undefined;
  let w: TravailleurRag;
  let service: ServiceIndexationRag;
  let ctrl: AbortController;
  let boucle: Promise<void> | undefined;
  let alice = 0;
  let col = "";
  const avant = new Map<string, string | undefined>();

  beforeAll(async () => {
    dossier = mkdtempSync(path.join(tmpdir(), "elpis-rag-reel-"));
    for (const k of ENV) avant.set(k, process.env[k]);
    for (const k of ENV) delete process.env[k];
    process.env["ELPIS_RAG_ACCESS_DIR"] = path.join(dossier, "temoin");
    const [http, grpc, api] = await portsLibres(3);
    mkdirSync(path.join(dossier, "qdrant"));
    qdrant = spawn(QDRANT, [], {
      cwd: path.join(dossier, "qdrant"),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        QDRANT__SERVICE__HOST: "127.0.0.1",
        QDRANT__SERVICE__HTTP_PORT: String(http),
        QDRANT__SERVICE__GRPC_PORT: String(grpc),
        QDRANT__STORAGE__STORAGE_PATH: path.join(dossier, "qdrant", "storage"),
        QDRANT__STORAGE__SNAPSHOTS_PATH: path.join(dossier, "qdrant", "snapshots"),
        QDRANT__TELEMETRY_DISABLED: "true",
      },
    });
    const magasin = path.join(dossier, "magasin");
    const cache = path.join(dossier, "cache");
    mkdirSync(magasin);
    mkdirSync(cache);
    cpSync(path.join(racineDepot(), "rag_app"), path.join(dossier, "rag_app"), {
      recursive: true,
      filter: (s) => !s.includes("__pycache__"),
    });
    uvicorn = spawn(PYTHON, ["-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", String(api)], {
      cwd: path.join(dossier, "rag_app"),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        RAG_STORE_DIR: magasin,
        RAG_CACHE_DIR: cache,
        RAG_SERVICE_TOKEN: JETON,
        PYTHONDONTWRITEBYTECODE: "1",
        LLAMA_IP: "127.0.0.1",
        LLAMA_PORT: "1",
      },
    });
    for (const p of [qdrant, uvicorn])
      for (const f of [p.stdout, p.stderr])
        f?.on("data", (m: Buffer) => (journal = (journal + m.toString()).slice(-6000)));
    q = new ClientQdrant({ url: `http://127.0.0.1:${http}`, delaiMs: 10_000 });
    emb = await demarrerFauxEmbeddings();
    emb.dimensions.set("bge-test", 16);
    const limite = Date.now() + 90_000;
    for (;;) {
      if (qdrant.exitCode !== null || uvicorn.exitCode !== null)
        throw new Error(`service arrêté : ${journal}`);
      let pret = (await q.sante()).ok;
      if (pret)
        pret = await fetch(`http://127.0.0.1:${api}/api/health`)
          .then((r) => r.ok)
          .catch(() => false);
      if (pret) break;
      if (Date.now() > limite) throw new Error(`services pas prêts : ${journal}`);
      await new Promise((r) => setTimeout(r, 300));
    }
    mkdirSync(path.join(dossier, "docs"));
    execFileSync(PYTHON, ["-I", "-c", GENERATEUR, path.join(dossier, "docs")], { stdio: "pipe" });
    const configJson = path.join(dossier, "config.json");
    writeFileSync(
      configJson,
      JSON.stringify({
        rag: {
          store_dir: magasin,
          service_url: `http://127.0.0.1:${api}`,
          service_token: JETON,
          qdrant_url: `http://127.0.0.1:${http}`,
          embed: { url: emb.url, model: "bge-test", timeout_s: 10 },
          indexation: { concurrence: 2, par_compte: 1 },
        },
      }),
    );
    restaurer = surchargerConfig({
      CONFIG_JSON_PATH: configJson,
      DB_PATH: path.join(dossier, "user_db", "app.db"),
    });
    invalidateConfigCache();
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    alice = await creerCompte(t.base, "alice");
    col = await creerCollection(t.base, alice, "Documentation");
    w = new TravailleurRag({
      base: t.base,
      meneur: { tenu: true, essayer: async () => true },
      notifier: async () => undefined,
      reglages: { tickActifMs: 50, tickInactifMs: 100, attenteMinMs: 500, attenteMaxMs: 2000 },
    });
    service = new ServiceIndexationRag({ base: t.base, travailleur: w });
    ctrl = new AbortController();
    boucle = w.demarrer(ctrl.signal);
  }, 180_000);

  afterAll(async () => {
    ctrl?.abort();
    await w?.arreter();
    await boucle;
    await t?.fermer();
    await emb?.arreter();
    await arreterProcessus(uvicorn);
    await arreterProcessus(qdrant);
    restaurer();
    for (const k of ENV) {
      const v = avant.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (dossier !== "") rmSync(dossier, { recursive: true, force: true });
  }, 60_000);

  const lire = async (sql: string, p: (string | number)[] = []): Promise<Record<string, unknown>> =>
    (await t.base.get(sql, p)) ?? {};
  const fileVide = async (): Promise<void> =>
    jusqua(
      async () =>
        Number(
          (await lire("SELECT COUNT(*) AS n FROM rag_jobs WHERE status IN ('queued', 'running', 'paused')"))[
            "n"
          ],
        ) === 0,
      `file vidée (${journal.slice(-500)})`,
      120_000,
    );
  const deposer = async (nom: string, fichier: string) =>
    service.deposer(alice, col, {
      nom,
      flux: flux(readFileSync(path.join(dossier, "docs", fichier)), 64 * 1024),
      dossier: true,
    });

  let pdf = "";
  let docx = "";

  it("dépose un PDF et un DOCX, les indexe : passages dans Qdrant, pages, extraits, compteurs", async () => {
    pdf = (await deposer("rapport.pdf", "rapport.pdf")).document.id;
    docx = (await deposer("manuels/guide.docx", "guide.docx")).document.id;
    await fileVide();
    const dPdf = await lire("SELECT * FROM rag_documents WHERE id=?", [pdf]);
    const dDocx = await lire("SELECT * FROM rag_documents WHERE id=?", [docx]);
    expect([dPdf["status"], dPdf["error_code"], Number(dPdf["pages"])]).toEqual(["ready", null, 3]);
    expect([dDocx["status"], dDocx["error_code"], dDocx["pages"]]).toEqual(["ready", null, null]);
    const nom = nomQdrantRag(col, 0);
    expect(await q.compter(nom, { docIds: [pdf] })).toBe(Number(dPdf["chunk_count"]));
    expect(await q.compter(nom, { docIds: [docx] })).toBe(Number(dDocx["chunk_count"]));
    const info = await q.infoCollection(nom);
    expect([info.existe, info.dimension]).toEqual([true, 16]);
    const trouves = await q.interroger(
      nom,
      { mode: "creux", creux: vecteurRequete("glaciers alpins") },
      { limite: 3 },
    );
    expect(trouves[0]?.charge).toMatchObject({ doc_id: pdf, rel_path: "rapport.pdf", ext: "pdf" });
    expect(trouves[0]?.charge.bbox[0]?.page).toBeGreaterThanOrEqual(1);
    expect(trouves[0]?.charge.bbox[0]?.rects.length).toBeGreaterThan(0);
    const extrait = lireExtraitRag(alice, col, pdf);
    expect(extrait?.text).toContain("glaciers alpins");
    const p = trouves[0]?.charge;
    expect(extrait?.text.slice(p?.char_start ?? 0, p?.char_end ?? 0)).toBe(p?.text);
    const c = await lire("SELECT * FROM rag_collections WHERE id=?", [col]);
    expect([c["status"], c["embed_model"], Number(c["embed_dim"]), Number(c["doc_count"])]).toEqual([
      "ready",
      "bge-test",
      16,
      2,
    ]);
    expect(Number(c["chunk_count"])).toBe(Number(dPdf["chunk_count"]) + Number(dDocx["chunk_count"]));
  }, 180_000);

  it("réindexe après un changement de découpage, remplace une nouvelle version, supprime document puis collection", async () => {
    const nom = nomQdrantRag(col, 0);
    const avantPdf = Number(
      (await lire("SELECT chunk_count FROM rag_documents WHERE id=?", [pdf]))["chunk_count"],
    );
    await t.base.run("UPDATE rag_collections SET chunk_json=? WHERE id=?", [
      JSON.stringify({ mode: "manuel", chunk_tokens: 64, overlap_tokens: 8 }),
      col,
    ]);
    const r = await service.reindexer(alice, col);
    expect(r?.total).toBe(2);
    await fileVide();
    const apresPdf = Number(
      (await lire("SELECT chunk_count FROM rag_documents WHERE id=?", [pdf]))["chunk_count"],
    );
    expect(apresPdf).toBeGreaterThan(avantPdf);
    expect(await q.compter(nom, { docIds: [pdf] })).toBe(apresPdf);
    const v2 = await deposer("manuels/guide.docx", "guide-v2.docx");
    expect([v2.statut, v2.document.id]).toEqual(["remplace", docx]);
    await fileVide();
    const dDocx = await lire("SELECT * FROM rag_documents WHERE id=?", [docx]);
    expect(dDocx["status"]).toBe("ready");
    expect(await q.compter(nom, { docIds: [docx] })).toBe(Number(dDocx["chunk_count"]));
    const nouveau = await q.interroger(
      nom,
      { mode: "creux", creux: vecteurRequete("sauvegarde nocturne") },
      { limite: 1 },
    );
    expect(nouveau[0]?.charge.doc_id).toBe(docx);
    await service.supprimerDocument(alice, col, pdf);
    expect(await q.compter(nom, { docIds: [pdf] })).toBe(0);
    expect(existsSync(path.join(dossier, "magasin", String(alice), col, "sources", `${pdf}.pdf`))).toBe(
      false,
    );
    await service.supprimerCollection(alice, col);
    expect((await q.infoCollection(nom)).existe).toBe(false);
    expect(existsSync(path.join(dossier, "magasin", String(alice), col))).toBe(false);
    expect((await q.listerCollections()).filter((n) => n.startsWith("elpis_"))).toEqual([]);
  }, 180_000);
});
