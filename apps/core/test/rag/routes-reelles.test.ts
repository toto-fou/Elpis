// SPDX-License-Identifier: MIT
/** apps/core/test/rag/routes-reelles.test.ts — routes RAG contre un VRAI Qdrant (`ELPIS_QDRANT_BIN`) et le VRAI extracteur Python (`ELPIS_RAG_PY`) avec des embeddings déterministes : dépôt d'un PDF et d'un DOCX, indexation, recherche et carte, fenêtre de passages, page rendue, localisation, original ; sauté sans les variables. */
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { createGroup, setUserGroups } from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import { invalidateConfigCache, racineDepot, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { ClientQdrant } from "@elpis/rag";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deleteUserFull } from "../../src/comptes/suppression";
import { creerFamilleRag } from "../../src/familles/rag";
import { oublierSondesRag } from "../../src/rag/etat";
import { inscrireNettoyageRag } from "../../src/rag/nettoyage";
import { ServiceIndexationRag } from "../../src/rag/service";
import { TravailleurRag } from "../../src/rag/travailleur";
import { appTest } from "../aides";
import { creerCompte, demarrerFauxEmbeddings, jusqua } from "./aides-indexation";
import type { FauxEmbeddings } from "./aides-indexation";
import { corpsMultipart } from "./aides-routes";

const QDRANT = process.env["ELPIS_QDRANT_BIN"] ?? "";
const PYTHON = process.env["ELPIS_RAG_PY"] ?? "";
const ACTIF = QDRANT !== "" && PYTHON !== "" && existsSync(QDRANT) && existsSync(PYTHON);
const JETON = "jeton-routes-reelles";
const ENV = ["RAG_SERVICE_URL", "RAG_SERVICE_TOKEN", "RAG_STORE_DIR", "ELPIS_RAG_ACCESS_DIR"] as const;

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
doc = Document()
doc.add_heading("Guide de demarrage", level=1)
doc.add_paragraph("Ce guide explique comment demarrer le service de facturation.")
doc.add_heading("Installation", level=2)
doc.add_paragraph("Sauvegarde nocturne des factures sur le serveur interne.")
doc.save(str(sortie / "guide.docx"))
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

interface Doc {
  id: string;
  rel_path: string;
  status: string;
  chunk_count: number;
  pages: number | null;
}

describe.skipIf(!ACTIF)("routes RAG : Qdrant et extracteur Python réels", () => {
  let dossier = "";
  let qdrant: ChildProcess | undefined;
  let uvicorn: ChildProcess | undefined;
  let journal = "";
  let emb: FauxEmbeddings;
  let t: BaseDeTest;
  let app: FastifyInstance;
  let restaurer: () => void = () => undefined;
  let w: TravailleurRag;
  let ctrl: AbortController;
  let boucle: Promise<void> | undefined;
  let alice = 0;
  let bob = 0;
  let col = "";
  let http = 0;
  let magasin = "";
  let cache = "";
  let service: ServiceIndexationRag;
  const avant = new Map<string, string | undefined>();

  const appeler = async (uid: number, methode: string, url: string, corps?: unknown) => {
    const r = await app.inject({
      method: methode as "GET",
      url,
      headers: { "x-uid": String(uid) },
      ...(corps === undefined ? {} : { payload: corps as object }),
    });
    return { statut: r.statusCode, json: <T>(): T => r.json<T>(), brut: r.rawPayload, entetes: r.headers };
  };

  beforeAll(async () => {
    dossier = mkdtempSync(path.join(tmpdir(), "elpis-rag-routes-reel-"));
    for (const k of ENV) avant.set(k, process.env[k]);
    for (const k of ENV) delete process.env[k];
    process.env["ELPIS_RAG_ACCESS_DIR"] = path.join(dossier, "temoin");
    const [portHttp, grpc, api] = await portsLibres(3);
    http = portHttp as number;
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
    magasin = path.join(dossier, "magasin");
    cache = path.join(dossier, "cache");
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
    const q = new ClientQdrant({ url: `http://127.0.0.1:${http}`, delaiMs: 10_000 });
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
    oublierSondesRag();
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    alice = await creerCompte(t.base, "alice");
    bob = await creerCompte(t.base, "bob");
    const g = await createGroup(t.base, "Lecteurs");
    await setUserGroups(t.base, alice, [g]);
    await setUserGroups(t.base, bob, [g]);
    w = new TravailleurRag({
      base: t.base,
      meneur: { tenu: true, essayer: async () => true },
      notifier: async () => undefined,
      reglages: { tickActifMs: 50, tickInactifMs: 100, attenteMinMs: 500, attenteMaxMs: 2000 },
    });
    service = new ServiceIndexationRag({ base: t.base, travailleur: w });
    app = await appTest({
      familles: [creerFamilleRag({ base: t.base, service: () => service })],
      gardes: {
        session: (req) => {
          const v = req.headers["x-uid"];
          if (!v) throw new HttpError(401, "not logged in");
          req.utilisateur = { id: Number(v), username: null };
        },
      },
    });
    ctrl = new AbortController();
    boucle = w.demarrer(ctrl.signal);
  }, 180_000);

  afterAll(async () => {
    ctrl?.abort();
    await w?.arreter();
    await boucle;
    await app?.close();
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

  const fileVide = async (): Promise<void> =>
    jusqua(
      async () => {
        const n = await t.base.get<{ n: unknown }>(
          "SELECT COUNT(*) AS n FROM rag_jobs WHERE status IN ('queued', 'running', 'paused')",
        );
        return Number(n?.n) === 0;
      },
      `file vidée (${journal.slice(-500)})`,
      120_000,
    );

  let pdf = "";
  let docx = "";

  it("état, création, dépôt multipart d'un PDF et d'un DOCX, indexation", async () => {
    const etat = await appeler(alice, "GET", "/api/rag/etat");
    expect(
      etat.json<{ usable: boolean; extractor: { ok: boolean }; qdrant: { ok: boolean } }>(),
    ).toMatchObject({
      usable: true,
      extractor: { ok: true },
      qdrant: { ok: true },
    });
    const creation = await appeler(alice, "POST", "/api/rag/collections", { name: "Documentation" });
    col = creation.json<{ collection: { id: string } }>().collection.id;
    const m = corpsMultipart([
      { nom: "rapports/rapport.pdf", contenu: readFileSync(path.join(dossier, "docs", "rapport.pdf")) },
      { nom: "guide.docx", contenu: readFileSync(path.join(dossier, "docs", "guide.docx")) },
    ]);
    const r = await app.inject({
      method: "POST",
      url: `/api/rag/collections/${col}/documents`,
      headers: { "x-uid": String(alice), "content-type": m.contentType },
      payload: m.payload,
    });
    expect(r.statusCode, r.body).toBe(200);
    await fileVide();
    const liste = (await appeler(alice, "GET", `/api/rag/collections/${col}/documents`)).json<{
      documents: Doc[];
    }>();
    const par = new Map(liste.documents.map((d) => [d.rel_path, d]));
    expect(par.get("rapports/rapport.pdf")).toMatchObject({ status: "ready", pages: 3 });
    expect(par.get("guide.docx")).toMatchObject({ status: "ready" });
    pdf = par.get("rapports/rapport.pdf")?.id ?? "";
    docx = par.get("guide.docx")?.id ?? "";
    expect(readdirSync(path.join(dossier, "magasin", String(alice), col, "sources")).sort()).toEqual(
      [`${docx}.docx`, `${pdf}.pdf`].sort(),
    );
  }, 180_000);

  it("recherche et carte sur le vrai Qdrant : le passage des glaciers, sa page et ses rectangles", async () => {
    for (const mode of ["mots", "mixte", "sens"] as const) {
      const r = await appeler(alice, "POST", `/api/rag/collections/${col}/recherche`, {
        requete: "glaciers alpins reculent",
        mode,
        limite: 3,
      });
      expect(r.statut, mode).toBe(200);
      const res = r.json<{
        passages: { document_id: string; page: number; boxes: number[][]; text: string; rank: number }[];
        map: {
          document_id: string;
          chunk_count: number;
          hits: { chunk_index: number; retained: boolean }[];
        }[];
        mode: string;
      }>();
      expect(res.mode).toBe(mode);
      expect(res.passages[0]).toMatchObject({ document_id: pdf, page: 1, rank: 1 });
      expect(res.passages[0]?.text).toContain("glaciers alpins");
      expect(res.passages[0]?.boxes.length).toBeGreaterThan(0);
      expect(res.passages[0]?.boxes.some((b) => b[0] === 1)).toBe(true);
      expect(
        res.passages[0]?.boxes.every((b) => (b[3] ?? 0) > (b[1] ?? 0) && (b[4] ?? 0) > (b[2] ?? 0)),
      ).toBe(true);
      const carte = res.map.find((d) => d.document_id === pdf);
      expect(carte?.chunk_count).toBeGreaterThan(0);
      expect(carte?.hits.some((h) => h.retained)).toBe(true);
    }
  });

  it("fenêtre de passages : bornes, ordre et filtres tenus par Qdrant", async () => {
    const doc = (await appeler(alice, "GET", `/api/rag/collections/${col}/documents`))
      .json<{ documents: Doc[] }>()
      .documents.find((d) => d.id === pdf) as Doc;
    expect(doc.chunk_count).toBeGreaterThanOrEqual(1);
    const tout = (
      await appeler(alice, "GET", `/api/rag/collections/${col}/documents/${pdf}/passages?autour=0&n=10`)
    ).json<{ passages: { chunk_index: number }[]; chunk_count: number; restricted: boolean }>();
    expect(tout.passages.map((p) => p.chunk_index)).toEqual(
      Array.from({ length: doc.chunk_count }, (_, i) => i),
    );
    expect(tout.restricted).toBe(false);
    const un = (
      await appeler(
        alice,
        "GET",
        `/api/rag/collections/${col}/documents/${pdf}/passages?autour=${doc.chunk_count - 1}&n=0`,
      )
    ).json<{ passages: { chunk_index: number }[] }>();
    expect(un.passages.map((p) => p.chunk_index)).toEqual([doc.chunk_count - 1]);
  });

  it("page rendue (PDF et DOCX par LibreOffice), mise en cache, hors du document", async () => {
    const p1 = await appeler(alice, "GET", `/api/rag/collections/${col}/documents/${pdf}/pages/1`);
    expect(p1.statut).toBe(200);
    expect(p1.brut.toString("latin1", 0, 4)).toBe("RIFF");
    expect(p1.brut.toString("latin1", 8, 12)).toBe("WEBP");
    expect(p1.entetes).toMatchObject({
      "content-type": "image/webp",
      "x-rag-dpi": "110",
      "x-rag-pages": "3",
    });
    expect(existsSync(path.join(dossierPages(pdf), "1.webp"))).toBe(true);
    const encore = await appeler(alice, "GET", `/api/rag/collections/${col}/documents/${pdf}/pages/1`);
    expect(encore.brut.equals(p1.brut)).toBe(true);
    const hors = await appeler(alice, "GET", `/api/rag/collections/${col}/documents/${pdf}/pages/4`);
    expect([hors.statut, hors.json<{ code: string }>().code]).toEqual([404, "page_introuvable"]);
    const d1 = await appeler(alice, "GET", `/api/rag/collections/${col}/documents/${docx}/pages/1`);
    expect(d1.statut, d1.brut.toString("utf8").slice(0, 200)).toBe(200);
    expect(d1.brut.toString("latin1", 8, 12)).toBe("WEBP");
  }, 120_000);

  const dossierPages = (doc: string): string =>
    path.join(dossier, "magasin", String(alice), col, "pages", doc);

  it("localisation d'un passage du PDF : bonne page, rectangles en points", async () => {
    const r = await appeler(alice, "POST", `/api/rag/collections/${col}/documents/${pdf}/localiser`, {
      texte: "Les stations meteorologiques relevent la temperature toutes les heures.",
    });
    expect(r.statut).toBe(200);
    const loc = r.json<{ page: number; boxes: number[][]; score: number; page_width: number }>();
    expect(loc.page).toBe(2);
    expect(loc.boxes.length).toBeGreaterThan(0);
    expect(loc.boxes.every((b) => b[0] === 2)).toBe(true);
    expect(loc.score).toBeGreaterThan(0.8);
    expect(loc.page_width).toBeGreaterThan(500);
    const rien = await appeler(alice, "POST", `/api/rag/collections/${col}/documents/${pdf}/localiser`, {
      texte: "zzzzqqqq texte absent du document xxxxyyyy",
    });
    expect(rien.json<{ page: number | null }>().page).toBeNull();
  });

  it("original : octets du PDF déposé ; un lecteur n'ouvre rien tant que les sources sont fermées", async () => {
    const o = await appeler(alice, "GET", `/api/rag/collections/${col}/documents/${pdf}/original`);
    expect(o.statut).toBe(200);
    expect(o.brut.equals(readFileSync(path.join(dossier, "docs", "rapport.pdf")))).toBe(true);
    const publication = await appeler(alice, "PUT", `/api/rag/collections/${col}/publication`, {
      visibility: "groups",
      group_ids: [Number((await t.base.get<{ id: unknown }>('SELECT id FROM "groups"'))?.id)],
      allow_source_open: false,
    });
    expect(publication.statut, publication.brut.toString("utf8")).toBe(200);
    for (const suite of ["original", "pages/1"])
      expect(
        (await appeler(bob, "GET", `/api/rag/collections/${col}/documents/${pdf}/${suite}`)).statut,
      ).toBe(403);
    const passage = await appeler(
      bob,
      "GET",
      `/api/rag/collections/${col}/documents/${pdf}/passages?autour=0&n=5`,
    );
    expect(passage.json<{ passages: unknown[]; restricted: boolean }>()).toMatchObject({ restricted: true });
    expect(passage.json<{ passages: unknown[] }>().passages).toHaveLength(1);
  });

  it("suppression du compte de l'auteur : base, magasin et collections Qdrant purgés ; son lecteur ne voit plus rien", async () => {
    const retirer = inscrireNettoyageRag((uid, c) => service.nettoyerCompte(uid, c));
    try {
      const q = new ClientQdrant({ url: `http://127.0.0.1:${http}`, delaiMs: 10_000 });
      const hex = col.replace(/-/gu, "");
      expect((await q.listerCollections()).some((n) => n.startsWith(`elpis_${hex}`))).toBe(true);
      expect(readdirSync(path.join(magasin, String(alice)))).toEqual([col]);
      expect((await appeler(bob, "GET", `/api/rag/collections/${col}`)).statut).toBe(200);
      expect(await deleteUserFull(t.base, alice)).toBe(true);
      for (const table of ["rag_collections", "rag_documents", "rag_jobs", "rag_grants"]) {
        const n = await t.base.get<{ n: unknown }>(`SELECT COUNT(*) AS n FROM ${table}`);
        expect(Number(n?.n), table).toBe(0);
      }
      expect((await q.listerCollections()).filter((n) => n.startsWith(`elpis_${hex}`))).toEqual([]);
      expect(existsSync(path.join(magasin, String(alice)))).toBe(false);
      expect(existsSync(path.join(magasin, ".purges"))).toBe(false);
      for (const url of [
        `/api/rag/collections/${col}`,
        `/api/rag/collections/${col}/documents/${pdf}/passages?autour=0`,
      ])
        expect((await appeler(bob, "GET", url)).statut).toBe(404);
      const liste = await appeler(bob, "GET", "/api/rag/collections");
      expect(liste.json<{ collections: unknown[] }>().collections).toEqual([]);
      expect(existsSync(cache)).toBe(true);
    } finally {
      retirer();
    }
  });
});
