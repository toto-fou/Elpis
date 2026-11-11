// SPDX-License-Identifier: MIT
/** apps/core/test/rag/aides-routes.ts — banc des routes RAG : app Fastify avec garde de session par en-tête, comptes et groupes, faux extracteur (santé, rendu, localisation), faux embeddings, Qdrant en mémoire servi en REST, dépôt multipart, index direct de passages. */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGroup, setUserGroups } from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import type { Base } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import {
  ClientQdrant,
  construirePoint,
  empreinteTexte,
  texteBm25,
  vecteurDocument,
  VECTEUR_CREUX,
  VECTEUR_DENSE,
} from "@elpis/rag";
import type { ClientReranker, FetchRag, Passage, PointAEcrire } from "@elpis/rag";
import type { FastifyInstance } from "fastify";

import { creerFamilleRag } from "../../src/familles/rag";
import type { DependancesDepotRag } from "../../src/rag/depot";
import { oublierSondesRag } from "../../src/rag/etat";
import { ServiceIndexationRag } from "../../src/rag/service";
import type { TravailleurRag } from "../../src/rag/travailleur";
import { nomQdrantCollectionRag, rafraichirCollection } from "../../src/rag/travaux";
import { appTest } from "../aides";
import {
  creerCollection,
  creerCompte,
  demarrerFauxEmbeddings,
  demarrerFauxExtracteur,
  FauxQdrant,
  JETON_EXTRACTEUR,
  vecteurDe,
} from "./aides-indexation";
import type { FauxEmbeddings, FauxExtracteur } from "./aides-indexation";

export const DIM = 8;
export const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const ENV = ["RAG_SERVICE_URL", "RAG_SERVICE_TOKEN", "RAG_STORE_DIR", "ELPIS_RAG_ACCESS_DIR"] as const;

export interface RendusExtracteur {
  /** Rendus demandés (`/api/render`) et localisations (`/api/locate`), dans l'ordre. */
  readonly rendus: { source: string; ext: string; page: number; dpi: number; jeton: string }[];
  readonly localisations: { source: string; ext: string; text: string; page_hint: number | null }[];
  /** `ok` ; `panne` (503) ; `illisible` (422). */
  modeRendu: "ok" | "panne" | "illisible";
  /** Nombre de pages du faux document. */
  pages: number;
  santeOk: boolean;
}

export interface Environnement {
  readonly dossier: string;
  readonly magasin: string;
  readonly ext: FauxExtracteur;
  readonly emb: FauxEmbeddings;
  readonly rendus: RendusExtracteur;
  ecrireConfig(rag?: Record<string, unknown>): void;
  arreter(): Promise<void>;
}

/** WebP minimal valide pour le test : en-tête RIFF/WEBP puis un contenu quelconque. */
export function faussePage(page: number): Buffer {
  const charge = Buffer.from(`VP8 page ${page}`, "latin1");
  const tete = Buffer.alloc(12);
  tete.write("RIFF", 0, "latin1");
  tete.writeUInt32LE(4 + charge.length, 4);
  tete.write("WEBP", 8, "latin1");
  return Buffer.concat([tete, charge]);
}

async function corps(req: IncomingMessage): Promise<Record<string, unknown>> {
  const morceaux: Buffer[] = [];
  for await (const m of req) morceaux.push(m as Buffer);
  try {
    return JSON.parse(Buffer.concat(morceaux).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function jsonRep(res: ServerResponse, statut: number, valeur: unknown): void {
  res.writeHead(statut, { "content-type": "application/json" }).end(JSON.stringify(valeur));
}

/** Faux extracteur (extraction du banc de L3, plus santé, rendu et localisation) et faux embeddings, config et environnement d'un fichier de tests. */
export async function demarrerEnvironnement(): Promise<Environnement> {
  const dossier = mkdtempSync(join(tmpdir(), "elpis-rag-routes-"));
  const configJson = join(dossier, "config.json");
  const magasin = join(dossier, "magasin");
  const avant = new Map<string, string | undefined>();
  for (const k of ENV) avant.set(k, process.env[k]);
  for (const k of ENV) delete process.env[k];
  process.env["ELPIS_RAG_ACCESS_DIR"] = join(dossier, "temoin");
  const restaurerConfig = surchargerConfig({
    CONFIG_JSON_PATH: configJson,
    DB_PATH: join(dossier, "user_db", "app.db"),
  });
  const ext = await demarrerFauxExtracteur(() => magasin);
  const emb = await demarrerFauxEmbeddings();
  const rendus: RendusExtracteur = {
    rendus: [],
    localisations: [],
    modeRendu: "ok",
    pages: 3,
    santeOk: true,
  };
  ext.autres = async (req, res) => {
    const jeton = String(req.headers["authorization"] ?? "");
    if (req.method === "GET" && req.url === "/api/health") {
      if (!rendus.santeOk) res.writeHead(500).end();
      else jsonRep(res, 200, { ok: true, version: "test", soffice: true, ocr: true });
      return true;
    }
    if (req.method === "POST" && req.url === "/api/render") {
      const c = await corps(req);
      rendus.rendus.push({
        source: String(c["source"]),
        ext: String(c["ext"]),
        page: Number(c["page"]),
        dpi: Number(c["dpi"]),
        jeton,
      });
      if (rendus.modeRendu === "panne")
        jsonRep(res, 503, { detail: { code: "not_configured", message: "x" } });
      else if (rendus.modeRendu === "illisible")
        jsonRep(res, 422, { detail: { code: "corrupt", message: "illisible" } });
      else if (Number(c["page"]) > rendus.pages)
        jsonRep(res, 404, { detail: { code: "page_out_of_range", message: "x" } });
      else
        res
          .writeHead(200, {
            "content-type": "image/webp",
            "x-rag-pages": String(rendus.pages),
            "x-rag-page-width": "595.28",
            "x-rag-page-height": "841.89",
          })
          .end(faussePage(Number(c["page"])));
      return true;
    }
    if (req.method === "POST" && req.url === "/api/locate") {
      const c = await corps(req);
      const hint = typeof c["page_hint"] === "number" ? c["page_hint"] : null;
      rendus.localisations.push({
        source: String(c["source"]),
        ext: String(c["ext"]),
        text: String(c["text"]),
        page_hint: hint,
      });
      if (String(c["text"]).includes("INTROUVABLE"))
        jsonRep(res, 200, { page: null, boxes: [], score: 0, page_width: null, page_height: null });
      else
        jsonRep(res, 200, {
          page: hint ?? 2,
          boxes: [
            [10, 20, 110, 40],
            [10, 44, 90, 60],
          ],
          score: 1,
          page_width: 595.28,
          page_height: 841.89,
        });
      return true;
    }
    return false;
  };
  const ecrireConfig = (rag: Record<string, unknown> = {}): void => {
    writeFileSync(
      configJson,
      JSON.stringify({
        rag: {
          store_dir: magasin,
          service_url: ext.url,
          service_token: JETON_EXTRACTEUR,
          qdrant_url: "http://qdrant.test",
          embed: { url: emb.url, model: "m1", timeout_s: 5 },
          ...rag,
        },
      }),
    );
    invalidateConfigCache();
    oublierSondesRag();
  };
  ecrireConfig();
  return {
    dossier,
    magasin,
    ext,
    emb,
    rendus,
    ecrireConfig,
    arreter: async () => {
      await fermerBasePartagee();
      await ext.arreter();
      await emb.arreter();
      restaurerConfig();
      invalidateConfigCache();
      for (const k of ENV) {
        const v = avant.get(k);
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dossier, { recursive: true, force: true });
    },
  };
}

function reponseJson(statut: number, valeur: unknown): Response {
  return new Response(JSON.stringify(valeur), {
    status: statut,
    headers: { "content-type": "application/json" },
  });
}

interface Condition {
  key?: string;
  match?: { any?: unknown[] };
  range?: { gte?: number; lte?: number };
}

function filtreAccepte(p: PointAEcrire, filtre: unknown): boolean {
  const f = (filtre ?? {}) as { must?: Condition[]; must_not?: Condition[] };
  const valeur = (c: Condition): unknown => (p.charge as unknown as Record<string, unknown>)[c.key ?? ""];
  const ok = (c: Condition): boolean => {
    if (c.match?.any !== undefined) return c.match.any.includes(valeur(c));
    if (c.range !== undefined) {
      const v = Number(valeur(c));
      return v >= (c.range.gte ?? -Infinity) && v <= (c.range.lte ?? Infinity);
    }
    return true;
  };
  return (f.must ?? []).every(ok) && !(f.must_not ?? []).some(ok);
}

const cosinus = (a: readonly number[], b: readonly number[]): number =>
  a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);

function produitCreux(
  q: { indices: number[]; values: number[] },
  p: { indices: number[]; values: number[] },
): number {
  let s = 0;
  q.indices.forEach((ind, i) => {
    const j = p.indices.indexOf(ind);
    if (j >= 0) s += (q.values[i] ?? 0) * (p.values[j] ?? 0);
  });
  return s;
}

/** Qdrant REST (requête, parcours, santé, informations) servi par la mémoire de `FauxQdrant`, au format que `ClientQdrant` envoie. */
export function fetchQdrantFaux(q: FauxQdrant): FetchRag {
  return async (url, init) => {
    const u = new URL(String(url));
    const corpsReq = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (q.panne) throw new TypeError("fetch failed");
    if (u.pathname === "/" || u.pathname === "/readyz")
      return reponseJson(200, { title: "qdrant", version: "test" });
    const m = /^\/collections\/([^/]+)(?:\/points\/(query|scroll))?$/u.exec(u.pathname);
    if (m === null) return reponseJson(404, { status: { error: "Not found" } });
    const nom = m[1] as string;
    const c = q.collections.get(nom);
    if (c === undefined) return reponseJson(404, { status: { error: "Not found" } });
    if (m[2] === undefined)
      return reponseJson(200, {
        result: {
          status: "green",
          points_count: c.points.size,
          config: { params: { vectors: { [VECTEUR_DENSE]: { size: c.dim } } } },
        },
      });
    const limite = Number(corpsReq["limit"] ?? 10);
    const sortie = (p: PointAEcrire, score: number): unknown => ({
      id: p.id,
      score,
      payload: p.charge,
      ...(JSON.stringify(corpsReq["with_vector"]) === "false"
        ? {}
        : { vector: { [VECTEUR_DENSE]: [...p.dense] } }),
    });
    const retenus = [...c.points.values()].filter((p) => filtreAccepte(p, corpsReq["filter"]));
    if (m[2] === "scroll") {
      const debut = Number((corpsReq["order_by"] as { start_from?: number } | undefined)?.start_from ?? 0);
      const tries = retenus
        .filter((p) => p.charge.chunk_index >= debut)
        .sort((a, b) => a.charge.chunk_index - b.charge.chunk_index)
        .slice(0, limite);
      return reponseJson(200, { result: { points: tries.map((p) => sortie(p, 0)) } });
    }
    const classer = (cond: { query: unknown; using: string; limit: number }, filtre: unknown) =>
      [...c.points.values()]
        .filter((p) => filtreAccepte(p, filtre))
        .map((p) => ({
          p,
          score:
            cond.using === VECTEUR_DENSE
              ? cosinus(cond.query as number[], p.dense)
              : produitCreux(cond.query as { indices: number[]; values: number[] }, p.creux),
        }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, cond.limit);
    if (Array.isArray(corpsReq["prefetch"])) {
      const k = Number((corpsReq["query"] as { rrf?: { k?: number } }).rrf?.k ?? 60);
      const branches = (
        corpsReq["prefetch"] as { query: unknown; using: string; limit: number; filter?: unknown }[]
      ).map((b) => classer(b, b.filter));
      const fusion = new Map<string, { p: PointAEcrire; score: number }>();
      for (const liste of branches)
        liste.forEach((x, i) => {
          const e = fusion.get(x.p.id) ?? { p: x.p, score: 0 };
          e.score += 1 / (k + i + 1);
          fusion.set(x.p.id, e);
        });
      const tries = [...fusion.values()].sort((a, b) => b.score - a.score).slice(0, limite);
      return reponseJson(200, { result: { points: tries.map((x) => sortie(x.p, x.score)) } });
    }
    const tries = classer(
      { query: corpsReq["query"], using: String(corpsReq["using"]), limit: limite },
      corpsReq["filter"],
    );
    return reponseJson(200, { result: { points: tries.map((x) => sortie(x.p, x.score)) } });
  };
}

let pgPartagee: BaseDeTest | null = null;

/** SQLite : une base neuve par banc (peu coûteux). PostgreSQL : un seul schéma par fichier de tests, vidé par DELETE entre deux bancs (créer ou tronquer 54 tables par test fait attendre longtemps le `CHECKPOINT` du serveur partagé). */
async function baseDuBanc(moteur: "sqlite" | "postgres"): Promise<BaseDeTest> {
  if (moteur === "sqlite") {
    const t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    return t;
  }
  if (pgPartagee === null) {
    pgPartagee = ouvrirBaseDeTest("postgres");
    await initialiserBase(pgPartagee.base);
    return pgPartagee;
  }
  for (const table of ["notifications", "rag_collections", "users", '"groups"'])
    await pgPartagee.base.run(`DELETE FROM ${table}`);
  return pgPartagee;
}

/** Ferme le schéma PostgreSQL partagé du fichier de tests (à appeler en fin de fichier). */
export async function fermerBasePartagee(): Promise<void> {
  const t = pgPartagee;
  pgPartagee = null;
  await t?.fermer();
}

export interface FichierMultipart {
  readonly nom: string;
  readonly contenu: Buffer | string;
  /** Nom de champ (défaut `files`). */
  readonly champ?: string;
}

/** Corps multipart/form-data (noms de fichiers en UTF-8 brut, comme les navigateurs) et son en-tête `content-type`. */
export function corpsMultipart(
  fichiers: readonly FichierMultipart[],
  champs: Record<string, string> = {},
): { payload: Buffer; contentType: string } {
  const frontiere = "----banc-rag-frontiere";
  const morceaux: Buffer[] = [];
  for (const [nom, valeur] of Object.entries(champs))
    morceaux.push(
      Buffer.from(
        `--${frontiere}\r\nContent-Disposition: form-data; name="${nom}"\r\n\r\n${valeur}\r\n`,
        "utf8",
      ),
    );
  for (const f of fichiers)
    morceaux.push(
      Buffer.from(
        `--${frontiere}\r\nContent-Disposition: form-data; name="${f.champ ?? "files"}"; filename="${f.nom}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        "utf8",
      ),
      typeof f.contenu === "string" ? Buffer.from(f.contenu, "utf8") : f.contenu,
      Buffer.from("\r\n", "utf8"),
    );
  morceaux.push(Buffer.from(`--${frontiere}--\r\n`, "utf8"));
  return { payload: Buffer.concat(morceaux), contentType: `multipart/form-data; boundary=${frontiere}` };
}

export interface Reponse {
  statut: number;
  corps: unknown;
  entetes: Record<string, string | string[] | number | undefined>;
  brut: Buffer;
}

/** Corps JSON d'une réponse, typé par le test qui sait ce qu'il attend. */
export function json<T>(r: Reponse): T {
  return r.corps as T;
}

export interface Banc {
  readonly t: BaseDeTest;
  readonly base: Base;
  readonly app: FastifyInstance;
  readonly q: FauxQdrant;
  readonly service: ServiceIndexationRag;
  readonly env: Environnement;
  /** Événements `rag_job` diffusés et notifications de partage. */
  readonly evenements: Record<string, unknown>[];
  readonly notifications: { uid: number; title: string; body: string; collectionId: string }[];
  readonly id: Record<"alice" | "bob" | "carol" | "dave" | "admin", number>;
  readonly groupe: Record<"A" | "B", number>;
  appeler(uid: number | null, methode: string, url: string, corps?: unknown): Promise<Reponse>;
  televerser(
    uid: number,
    url: string,
    fichiers: readonly FichierMultipart[],
    champs?: Record<string, string>,
  ): Promise<Reponse>;
  fermer(): Promise<void>;
}

export interface OptionsBanc {
  /** Vrai : le notificateur de partage lève une erreur. */
  readonly notifierEnEchec?: boolean | undefined;
  /** Reclassement injecté (sinon celui de `rag.reranker`, absent par défaut). */
  readonly reranker?: (() => ClientReranker | null) | undefined;
  /** Vrai : les partages passent par le vrai centre de notifications (table `notifications`). */
  readonly notifierReel?: boolean | undefined;
  /** Dépendances du dépôt remplacées (hôte du bac à sable…). */
  readonly depot?: Partial<DependancesDepotRag> | undefined;
  readonly travailleur?:
    ((base: Base, q: FauxQdrant, evenements: Record<string, unknown>[]) => TravailleurRag) | undefined;
}

/** Banc complet sur un moteur : comptes (alice et bob dans A, carol dans B, dave seul, admin), routes montées, service d'indexation sans travailleur. */
export async function ouvrirBanc(
  moteur: "sqlite" | "postgres",
  env: Environnement,
  options: OptionsBanc = {},
): Promise<Banc> {
  env.ecrireConfig();
  env.ext.mode = "ok";
  env.rendus.rendus.length = 0;
  env.rendus.localisations.length = 0;
  env.rendus.modeRendu = "ok";
  env.rendus.santeOk = true;
  env.emb.panne = false;
  env.emb.dimensions.clear();
  const t = await baseDuBanc(moteur);
  const id = {
    alice: await creerCompte(t.base, "alice"),
    bob: await creerCompte(t.base, "bob"),
    carol: await creerCompte(t.base, "carol"),
    dave: await creerCompte(t.base, "dave"),
    admin: await creerCompte(t.base, "admin", true),
  };
  const groupe = { A: await createGroup(t.base, "Juristes"), B: await createGroup(t.base, "Finance") };
  await setUserGroups(t.base, id.alice, [groupe.A]);
  await setUserGroups(t.base, id.bob, [groupe.A]);
  await setUserGroups(t.base, id.carol, [groupe.B]);
  const q = new FauxQdrant();
  const evenements: Record<string, unknown>[] = [];
  const notifications: Banc["notifications"] = [];
  const travailleur = options.travailleur?.(t.base, q, evenements) ?? null;
  const service = new ServiceIndexationRag({
    base: t.base,
    diffuser: (m) => void evenements.push(m),
    qdrant: () => q,
    travailleur,
    hoteSandbox: async () => null,
    ...options.depot,
  });
  const clientQdrant = new ClientQdrant({ url: "http://qdrant.test", fetch: fetchQdrantFaux(q) });
  const app = await appTest({
    familles: [
      creerFamilleRag({
        base: t.base,
        service: () => service,
        qdrant: () => clientQdrant,
        ...(options.reranker ? { reranker: options.reranker } : {}),
        ...(options.notifierReel
          ? {}
          : {
              notifier: async (n) => {
                if (options.notifierEnEchec) throw new Error("notification en panne");
                notifications.push(n);
              },
            }),
      }),
    ],
    gardes: {
      session: (req) => {
        const v = req.headers["x-uid"];
        if (!v) throw new HttpError(401, "not logged in");
        req.utilisateur = { id: Number(v), username: null };
      },
    },
  });
  const requete = async (
    uid: number | null,
    methode: string,
    url: string,
    payload?: Buffer | object,
    contentType?: string,
  ): Promise<Reponse> => {
    const r = await app.inject({
      method: methode as "GET",
      url,
      headers: {
        ...(uid === null ? {} : { "x-uid": String(uid) }),
        ...(contentType === undefined ? {} : { "content-type": contentType }),
      },
      ...(payload === undefined ? {} : { payload }),
    });
    let corps: unknown = null;
    if (String(r.headers["content-type"] ?? "").startsWith("application/json")) corps = r.json();
    return { statut: r.statusCode, corps, entetes: r.headers, brut: r.rawPayload };
  };
  return {
    t,
    base: t.base,
    app,
    q,
    service,
    env,
    evenements,
    notifications,
    id,
    groupe,
    appeler: (uid, methode, url, corps) => requete(uid, methode, url, corps as object | undefined),
    televerser: (uid, url, fichiers, champs) => {
      const m = corpsMultipart(fichiers, champs);
      return requete(uid, "POST", url, m.payload, m.contentType);
    },
    fermer: async () => {
      await app.close();
      if (moteur === "sqlite") await t.fermer();
      rmSync(env.magasin, { recursive: true, force: true });
    },
  };
}

export interface PassageDirect {
  readonly texte: string;
  readonly titres?: string;
  readonly page?: number | null;
  readonly boites?: [number, number, number, number][];
}

/** Document « prêt » dont les passages sont écrits directement dans le Qdrant du banc (mêmes vecteurs que le faux serveur d'embeddings). */
export async function indexerDirect(
  b: Banc,
  collectionId: string,
  rel: string,
  passages: readonly PassageDirect[],
  o: { ext?: string; sha?: string; modele?: string } = {},
): Promise<string> {
  const docId = randomUUID();
  const ext = o.ext ?? "pdf";
  const t = Date.now() / 1000;
  const nom = rel.split("/").at(-1) as string;
  await b.base.run(
    "INSERT INTO rag_documents(id, collection_id, rel_path, name, ext, bytes, sha256, pages, chunk_count, status, chunk_params_hash, created_at, indexed_at) " +
      "VALUES(?, ?, ?, ?, ?, 100, ?, ?, ?, 'ready', '', ?, ?)",
    [
      docId,
      collectionId,
      rel,
      nom,
      ext,
      o.sha ?? randomUUID().replaceAll("-", "").padEnd(64, "0"),
      3,
      passages.length,
      t,
      t,
    ],
  );
  const modele = o.modele ?? "m1";
  await b.base.run("UPDATE rag_collections SET embed_model=?, embed_dim=? WHERE id=?", [
    modele,
    DIM,
    collectionId,
  ]);
  const [meta] = await b.base.valeurs<[unknown]>("SELECT meta_json FROM rag_collections WHERE id=?", [
    collectionId,
  ]);
  const nomQ = nomQdrantCollectionRag(collectionId, meta?.[0]);
  await b.q.assurerCollection(nomQ, { dimension: DIM });
  const points = passages.map((p, i) => {
    const passage: Passage = {
      text: p.texte,
      heading_path: p.titres ?? "",
      page: p.page === undefined ? 1 : p.page,
      boxes: (p.boites ?? [[10, 10, 100, 30]]).length
        ? [
            {
              page: p.page === undefined || p.page === null ? 1 : p.page,
              rects: p.boites ?? [[10, 10, 100, 30]],
            },
          ]
        : [],
      char_start: i * 100,
      char_end: i * 100 + p.texte.length,
      chunk_index: i,
      hash: empreinteTexte(p.texte),
      jetons: Math.ceil(p.texte.length / 3.3),
    };
    return construirePoint({
      docId,
      relPath: rel,
      ext,
      passage,
      dense: vecteurDe(p.texte, DIM),
      creux: vecteurDocument(texteBm25({ heading_path: passage.heading_path, text: p.texte })),
    });
  });
  await b.q.inserer(nomQ, points);
  await rafraichirCollection(b.base, collectionId);
  return docId;
}

export { creerCollection, VECTEUR_CREUX };
