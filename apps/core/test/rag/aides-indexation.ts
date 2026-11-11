// SPDX-License-Identifier: MIT
/** apps/core/test/rag/aides-indexation.ts — bancs de l'indexation RAG : faux extracteur NDJSON et faux serveur d'embeddings (HTTP locaux), Qdrant en mémoire, comptes et collections, attente d'une condition. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import type { Base } from "@elpis/db";
import { ErreurRag, hacherToken, tokeniser } from "@elpis/rag";
import type { Distance, InfoCollection, PointAEcrire } from "@elpis/rag";

import { creerDossiersCollectionRag } from "../../src/rag/magasin";
import type { PortQdrantRag } from "../../src/rag/qdrant";

export const JETON_EXTRACTEUR = "jeton-extracteur-test";

/** Attend qu'une condition devienne vraie (sondée toutes les 20 ms) ; échoue au délai avec le libellé. */
export async function jusqua(
  cond: () => boolean | Promise<boolean>,
  libelle: string,
  delaiMs = 15_000,
): Promise<void> {
  const limite = Date.now() + delaiMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > limite) throw new Error(`délai dépassé : ${libelle}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function corpsJson(req: IncomingMessage): Promise<unknown> {
  const morceaux: Buffer[] = [];
  for await (const m of req) morceaux.push(m as Buffer);
  const brut = Buffer.concat(morceaux).toString("utf8");
  try {
    return JSON.parse(brut) as unknown;
  } catch {
    return null;
  }
}

async function ecouter(serveur: Server): Promise<string> {
  await new Promise<void>((resolve) => serveur.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`;
}

async function fermer(serveur: Server): Promise<void> {
  serveur.closeAllConnections();
  await new Promise<void>((resolve) => serveur.close(() => resolve()));
}

export type ModeExtracteur = "ok" | "panne" | "coupe" | "sans_resultat";

export interface FauxExtracteur {
  url: string;
  mode: ModeExtracteur;
  /** Attente avant le résultat (ms), interrompue si le client ferme. */
  attenteMs: number;
  /** Sources demandées, dans l'ordre. */
  readonly demandes: { source: string; ext: string; ocr: boolean; jeton: string }[];
  /** Requêtes en cours par compte (premier composant de la source) et maximum observé. */
  readonly actifs: Map<string, number>;
  maxGlobal: number;
  maxParCompte: number;
  /** Requêtes fermées par le client avant la fin. */
  fermees: number;
  /** Autres routes (santé, rendu, localisation) : rend vrai si la requête est traitée, avant toute lecture du corps. */
  autres?: ((req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>) | undefined;
  arreter(): Promise<void>;
}

/** Blocs d'un fichier texte du banc : une ligne « # titre » est un titre, le reste des paragraphes séparés par une ligne vide. */
export function blocsDuTexte(texte: string): unknown[] {
  return texte
    .split(/\n\s*\n/u)
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map((p) =>
      p.startsWith("# ")
        ? { kind: "heading", text: p.slice(2), level: 1, page: 1 }
        : { kind: "paragraph", text: p, page: 1, boxes: [[10, 10, 200, 30]] },
    );
}

/** Extracteur du banc : lit vraiment la source sous la racine du magasin ; « NOTEXT » donne `no_text`. */
export async function demarrerFauxExtracteur(racine: () => string): Promise<FauxExtracteur> {
  const faux: FauxExtracteur = {
    url: "",
    mode: "ok",
    attenteMs: 0,
    demandes: [],
    actifs: new Map(),
    maxGlobal: 0,
    maxParCompte: 0,
    fermees: 0,
    arreter: async () => fermer(serveur),
  };
  let global = 0;
  const traiter = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (faux.autres !== undefined && (await faux.autres(req, res))) return;
    if (req.method !== "POST" || req.url !== "/api/extract") {
      res.writeHead(404).end();
      return;
    }
    const corps = (await corpsJson(req)) as { source?: string; ext?: string; ocr?: boolean } | null;
    const jeton = String(req.headers["authorization"] ?? "");
    const source = String(corps?.source ?? "");
    faux.demandes.push({ source, ext: String(corps?.ext ?? ""), ocr: corps?.ocr === true, jeton });
    if (jeton !== `Bearer ${JETON_EXTRACTEUR}`) {
      res.writeHead(401, { "content-type": "application/json" }).end('{"detail":"Bearer token requis."}');
      return;
    }
    if (faux.mode === "panne") {
      res
        .writeHead(503, { "content-type": "application/json" })
        .end('{"detail":{"code":"not_configured","message":"x"}}');
      return;
    }
    let texte: string;
    try {
      if (source.startsWith("/") || source.split("/").includes("..")) throw new Error("hors magasin");
      texte = readFileSync(path.join(racine(), source), "utf8");
    } catch {
      res
        .writeHead(404, { "content-type": "application/json" })
        .end('{"detail":{"code":"not_found","message":"x"}}');
      return;
    }
    const compte = source.split("/")[0] ?? "";
    global++;
    faux.actifs.set(compte, (faux.actifs.get(compte) ?? 0) + 1);
    faux.maxGlobal = Math.max(faux.maxGlobal, global);
    faux.maxParCompte = Math.max(faux.maxParCompte, faux.actifs.get(compte) ?? 0);
    let ferme = false;
    res.on("close", () => {
      if (!res.writableFinished) {
        ferme = true;
        faux.fermees++;
      }
    });
    try {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ type: "progress", done: 0, total: 1 })}\n`);
      const limite = Date.now() + faux.attenteMs;
      while (Date.now() < limite && !ferme) await new Promise((r) => setTimeout(r, 10));
      if (ferme) return;
      if (faux.mode === "coupe") {
        await new Promise((r) => setTimeout(r, 30));
        res.destroy();
        return;
      }
      if (faux.mode === "sans_resultat") {
        res.end();
        return;
      }
      if (texte.startsWith("NOTEXT")) {
        res.end(
          `${JSON.stringify({ type: "error", code: "no_text", message: "Aucun texte extractible." })}\n`,
        );
        return;
      }
      const resultat = JSON.stringify({
        type: "result",
        meta: { pages: 1, title: null, text_layer: true, mime: "text/plain" },
        blocks: blocsDuTexte(texte),
        warnings: [],
      });
      const milieu = Math.floor(resultat.length / 2);
      res.write(resultat.slice(0, milieu));
      res.end(`${resultat.slice(milieu)}\n`);
    } finally {
      global--;
      faux.actifs.set(compte, (faux.actifs.get(compte) ?? 1) - 1);
    }
  };
  const serveur = createServer((req, res) => void traiter(req, res));
  faux.url = await ecouter(serveur);
  return faux;
}

/** Vecteur déterministe d'un texte (sac de mots haché, normalisé). */
export function vecteurDe(texte: string, dim: number): number[] {
  const v = new Array<number>(dim).fill(0);
  for (const t of tokeniser(texte)) {
    const i = hacherToken(t) % dim;
    v[i] = (v[i] ?? 0) + 1;
  }
  if (!v.some((x) => x !== 0)) v[0] = 1;
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}

export interface FauxEmbeddings {
  url: string;
  /** Dimension par modèle (défaut 8). */
  readonly dimensions: Map<string, number>;
  panne: boolean;
  statut: number;
  appels: number;
  readonly modeles: string[];
  /** En-tête `authorization` de chaque appel (vide si absent). */
  readonly autorisations: string[];
  arreter(): Promise<void>;
}

export async function demarrerFauxEmbeddings(): Promise<FauxEmbeddings> {
  const faux: FauxEmbeddings = {
    url: "",
    dimensions: new Map(),
    panne: false,
    statut: 503,
    appels: 0,
    modeles: [],
    autorisations: [],
    arreter: async () => fermer(serveur),
  };
  const serveur = createServer((req, res) => {
    void (async () => {
      const corps = (await corpsJson(req)) as { model?: string; input?: string[] } | null;
      faux.appels++;
      faux.autorisations.push(String(req.headers["authorization"] ?? ""));
      if (faux.panne) {
        res.writeHead(faux.statut, { "content-type": "application/json" }).end('{"error":"indisponible"}');
        return;
      }
      const modele = String(corps?.model ?? "");
      faux.modeles.push(modele);
      const dim = faux.dimensions.get(modele) ?? 8;
      const data = (corps?.input ?? []).map((t, index) => ({ index, embedding: vecteurDe(t, dim) }));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data }));
    })();
  });
  faux.url = await ecouter(serveur);
  return faux;
}

/** Qdrant en mémoire : collections, dimension, points par identifiant ; `panne` simule un serveur injoignable. */
export class FauxQdrant implements PortQdrantRag {
  readonly collections = new Map<string, { dim: number; points: Map<string, PointAEcrire> }>();
  panne = false;
  supprimees: string[] = [];
  /** Documents visés par chaque effacement de passages, dans l'ordre des appels. */
  effaces: string[][] = [];

  private verifier(): void {
    if (this.panne) throw new ErreurRag("qdrant_injoignable", "Qdrant injoignable (banc)");
  }

  private exiger(nom: string): { dim: number; points: Map<string, PointAEcrire> } {
    const c = this.collections.get(nom);
    if (c === undefined) throw new ErreurRag("collection_absente", `collection ${nom} absente`, 404);
    return c;
  }

  async listerCollections(): Promise<string[]> {
    this.verifier();
    return [...this.collections.keys()];
  }

  async infoCollection(nom: string): Promise<InfoCollection> {
    this.verifier();
    const c = this.collections.get(nom);
    return {
      existe: c !== undefined,
      dimension: c?.dim ?? null,
      points: c?.points.size ?? 0,
      statut: c ? "green" : "absente",
    };
  }

  async assurerCollection(
    nom: string,
    o: { dimension: number; distance?: Distance },
  ): Promise<{ creee: boolean }> {
    this.verifier();
    const c = this.collections.get(nom);
    if (c === undefined) {
      this.collections.set(nom, { dim: o.dimension, points: new Map() });
      return { creee: true };
    }
    if (c.dim !== o.dimension) throw new ErreurRag("dimension_differente", "dimension différente");
    return { creee: false };
  }

  async inserer(nom: string, points: readonly PointAEcrire[]): Promise<number> {
    this.verifier();
    const c = this.exiger(nom);
    for (const p of points) {
      if (p.dense.length !== c.dim) throw new ErreurRag("qdrant_http", "wrong vector dimension", 400);
      c.points.set(p.id, p);
    }
    return points.length;
  }

  async supprimerDocument(
    nom: string,
    docId: string | readonly string[],
    o: { sauf?: readonly number[] } = {},
  ): Promise<void> {
    this.verifier();
    const c = this.exiger(nom);
    const ids = typeof docId === "string" ? [docId] : [...docId];
    this.effaces.push(ids);
    const gardes = new Set(o.sauf ?? []);
    for (const [id, p] of c.points)
      if (ids.includes(p.charge.doc_id) && !gardes.has(p.charge.chunk_index)) c.points.delete(id);
  }

  async supprimerCollection(nom: string): Promise<boolean> {
    this.verifier();
    this.supprimees.push(nom);
    return this.collections.delete(nom);
  }

  /** Passages d'un document dans une collection, triés par rang. */
  passages(nom: string, docId: string): PointAEcrire[] {
    return [...(this.collections.get(nom)?.points.values() ?? [])]
      .filter((p) => p.charge.doc_id === docId)
      .sort((a, b) => a.charge.chunk_index - b.charge.chunk_index);
  }

  /** Tous les identifiants de documents présents dans une collection. */
  documents(nom: string): Set<string> {
    return new Set([...(this.collections.get(nom)?.points.values() ?? [])].map((p) => p.charge.doc_id));
  }
}

export async function creerCompte(base: Base, nom: string, admin = false): Promise<number> {
  return base.insertId(
    "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin, settings_json) VALUES(?, '', '', 1, ?, '{}')",
    [nom, admin ? 1 : 0],
  );
}

export async function creerCollection(
  base: Base,
  uid: number,
  nom: string,
  o: { visibility?: "private" | "all"; chunk?: unknown; meta?: unknown } = {},
): Promise<string> {
  const id = randomUUID();
  const t = Date.now() / 1000;
  await base.run(
    "INSERT INTO rag_collections(id, owner_user_id, name, visibility, chunk_json, meta_json, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      uid,
      nom,
      o.visibility ?? "private",
      JSON.stringify(o.chunk ?? {}),
      JSON.stringify(o.meta ?? {}),
      t,
      t,
    ],
  );
  creerDossiersCollectionRag(uid, id);
  return id;
}

/** Flux d'un texte, découpé en petits morceaux (vrai flux, plusieurs écritures). */
export async function* flux(contenu: string | Buffer, taille = 7): AsyncGenerator<Uint8Array> {
  const b = typeof contenu === "string" ? Buffer.from(contenu, "utf8") : contenu;
  for (let i = 0; i < b.length; i += taille) {
    yield b.subarray(i, i + taille);
    await Promise.resolve();
  }
}
