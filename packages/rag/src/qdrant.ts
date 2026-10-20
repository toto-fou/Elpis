// SPDX-License-Identifier: MIT
/** packages/rag/src/qdrant.ts — client REST minimal de Qdrant 1.16 : collection dense + BM25 creux, écriture, remplacement par document, requêtes, parcours. */
import type { VecteurCreux } from "./bm25";
import type { BoitesPage, Passage } from "./decoupage";
import { ErreurRag } from "./erreurs";
import type { CodeErreurRag } from "./erreurs";
import { appeler, estObjet, extrait, jsonOuNul } from "./reseau";
import type { FetchRag, ReponseHttp } from "./reseau";
import { idPoint } from "./uuid";

export const VECTEUR_DENSE = "dense";
export const VECTEUR_CREUX = "bm25";

export type Distance = "Cosine" | "Dot" | "Euclid";

export interface OptionsQdrant {
  url: string;
  cleApi?: string | undefined;
  delaiMs?: number;
  delaiEcritureMs?: number;
  fetch?: FetchRag;
}

/** Charge utile d'un passage (§2.2 du plan) : aucun chemin absolu. */
export interface ChargeUtile {
  doc_id: string;
  chunk_index: number;
  text: string;
  heading_path: string;
  page: number | null;
  bbox: BoitesPage[];
  char_start: number;
  char_end: number;
  rel_path: string;
  ext: string;
  chunk_hash: string;
}

export interface PointAEcrire {
  id: string;
  dense: readonly number[];
  creux: VecteurCreux;
  charge: ChargeUtile;
}

export interface PointTrouve {
  id: string;
  score: number;
  charge: ChargeUtile;
  vecteur?: number[];
}

/** Filtre sur la charge utile ; une liste vide ne retient aucun point (jamais « sans restriction »). */
export interface FiltreRag {
  docIds?: readonly string[];
  relPaths?: readonly string[];
  exts?: readonly string[];
  exclureDocIds?: readonly string[];
  texte?: string;
  chunkMin?: number;
  chunkMax?: number;
}

export type RequeteQdrant =
  | { mode: "dense"; vecteur: readonly number[] }
  | { mode: "creux"; creux: VecteurCreux }
  | { mode: "mixte"; vecteur: readonly number[]; creux: VecteurCreux };

export interface OptionsRequete {
  limite: number;
  filtre?: FiltreRag | undefined;
  avecVecteur?: boolean;
  /** Candidats pris dans chaque branche avant la fusion (mode mixte) ; au moins `limite`. */
  prefetch?: number;
  /** Constante k de la fusion RRF de Qdrant (60 par défaut) ; `null` : réglage par défaut de Qdrant. */
  fusionK?: number | null;
  signal?: AbortSignal | undefined;
}

export interface InfoCollection {
  existe: boolean;
  dimension: number | null;
  points: number;
  statut: string;
}

export interface EtatQdrant {
  ok: boolean;
  version?: string;
  erreur?: string;
}

type FiltreQdrant = Record<string, unknown>;

const NOM_COLLECTION = /^[A-Za-z0-9_-]{1,255}$/;
const DELAI_LECTURE_MS = 15_000;
const DELAI_ECRITURE_MS = 60_000;
const LOT_POINTS = 64;
const PAGE_PARCOURS = 256;
const PREFETCH_DEFAUT = 50;
const FUSION_K_DEFAUT = 60;

/** Normalise une extension pour la charge utile : minuscules, sans point. */
export function normaliserExt(ext: string): string {
  return ext.trim().replace(/^\./, "").toLowerCase();
}

/** Point à écrire pour un passage ; l'identifiant dépend de `docId` et de `chunk_index` seulement. */
export function construirePoint(a: {
  docId: string;
  relPath: string;
  ext: string;
  passage: Passage;
  dense: readonly number[];
  creux: VecteurCreux;
}): PointAEcrire {
  const p = a.passage;
  return {
    id: idPoint(a.docId, p.chunk_index),
    dense: a.dense,
    creux: a.creux,
    charge: {
      doc_id: a.docId,
      chunk_index: p.chunk_index,
      text: p.text,
      heading_path: p.heading_path,
      page: p.page,
      bbox: p.boxes,
      char_start: p.char_start,
      char_end: p.char_end,
      rel_path: a.relPath,
      ext: normaliserExt(a.ext),
      chunk_hash: p.hash,
    },
  };
}

function texteDe(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function entierDe(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function bboxDe(v: unknown): BoitesPage[] {
  if (!Array.isArray(v)) return [];
  const sortie: BoitesPage[] = [];
  for (const e of v) {
    if (!estObjet(e) || typeof e["page"] !== "number" || !Array.isArray(e["rects"])) continue;
    const rects = e["rects"].filter(
      (r): r is [number, number, number, number] =>
        Array.isArray(r) && r.length === 4 && r.every((x) => typeof x === "number"),
    );
    sortie.push({ page: e["page"], rects });
  }
  return sortie;
}

/** Charge utile lue d'une réponse Qdrant, avec des valeurs neutres pour les champs absents. */
export function lireCharge(brut: unknown): ChargeUtile {
  const o = estObjet(brut) ? brut : {};
  return {
    doc_id: texteDe(o["doc_id"]),
    chunk_index: entierDe(o["chunk_index"]),
    text: texteDe(o["text"]),
    heading_path: texteDe(o["heading_path"]),
    page: typeof o["page"] === "number" ? o["page"] : null,
    bbox: bboxDe(o["bbox"]),
    char_start: entierDe(o["char_start"]),
    char_end: entierDe(o["char_end"]),
    rel_path: texteDe(o["rel_path"]),
    ext: texteDe(o["ext"]),
    chunk_hash: texteDe(o["chunk_hash"]),
  };
}

/** Filtre Qdrant d'un `FiltreRag` (`undefined` si aucune condition). */
export function filtreQdrant(f: FiltreRag | undefined, sauf?: readonly number[]): FiltreQdrant | undefined {
  if (!f && sauf === undefined) return undefined;
  const must: unknown[] = [];
  const mustNot: unknown[] = [];
  const parmi = (cle: string, valeurs: readonly string[]): unknown => ({
    key: cle,
    match: { any: [...valeurs] },
  });
  if (f?.docIds) must.push(parmi("doc_id", f.docIds));
  if (f?.relPaths) must.push(parmi("rel_path", f.relPaths));
  if (f?.exts) must.push(parmi("ext", f.exts.map(normaliserExt)));
  if (f?.texte !== undefined && f.texte.trim() !== "") must.push({ key: "text", match: { text: f.texte } });
  if (f?.chunkMin !== undefined || f?.chunkMax !== undefined) {
    const range: Record<string, number> = {};
    if (f.chunkMin !== undefined) range["gte"] = f.chunkMin;
    if (f.chunkMax !== undefined) range["lte"] = f.chunkMax;
    must.push({ key: "chunk_index", range });
  }
  if (f?.exclureDocIds && f.exclureDocIds.length > 0) mustNot.push(parmi("doc_id", f.exclureDocIds));
  if (sauf !== undefined) mustNot.push(...plages(sauf));
  if (must.length === 0 && mustNot.length === 0) return undefined;
  const filtre: FiltreQdrant = {};
  if (must.length > 0) filtre["must"] = must;
  if (mustNot.length > 0) filtre["must_not"] = mustNot;
  return filtre;
}

/** Conditions `range` couvrant exactement les indices donnés (plages contiguës fusionnées). */
function plages(indices: readonly number[]): unknown[] {
  const tries = [...new Set(indices)].filter(Number.isInteger).sort((a, b) => a - b);
  const sortie: unknown[] = [];
  let debut: number | undefined;
  let fin = 0;
  for (const i of tries) {
    if (debut !== undefined && i === fin + 1) {
      fin = i;
      continue;
    }
    if (debut !== undefined) sortie.push({ key: "chunk_index", range: { gte: debut, lte: fin } });
    debut = i;
    fin = i;
  }
  if (debut !== undefined) sortie.push({ key: "chunk_index", range: { gte: debut, lte: fin } });
  return sortie;
}

function messageQdrant(rep: ReponseHttp): string {
  const json = jsonOuNul(rep.texte);
  if (estObjet(json) && estObjet(json["status"]) && typeof json["status"]["error"] === "string") {
    return json["status"]["error"];
  }
  return extrait(rep.texte) || `HTTP ${rep.statut}`;
}

function codeHttp(rep: ReponseHttp, message: string): CodeErreurRag {
  if (rep.statut === 404) return "collection_absente";
  if (rep.statut === 409) return "collection_existe";
  if (rep.statut === 400 && /dimension/i.test(message)) return "dimension_differente";
  return "qdrant_http";
}

function nomValide(nom: string): string {
  if (!NOM_COLLECTION.test(nom))
    throw new ErreurRag("parametres", `nom de collection Qdrant invalide : ${nom.slice(0, 80)}`);
  return nom;
}

function vecteurDense(brut: unknown): number[] | undefined {
  if (!estObjet(brut)) return undefined;
  const v = brut[VECTEUR_DENSE];
  return Array.isArray(v) && v.every((x) => typeof x === "number") ? (v as number[]) : undefined;
}

function pointsDe(json: unknown): PointTrouve[] {
  const resultat = estObjet(json) ? json["result"] : undefined;
  const liste = Array.isArray(resultat)
    ? resultat
    : estObjet(resultat) && Array.isArray(resultat["points"])
      ? resultat["points"]
      : [];
  const sortie: PointTrouve[] = [];
  for (const e of liste as unknown[]) {
    if (!estObjet(e) || (typeof e["id"] !== "string" && typeof e["id"] !== "number")) continue;
    const point: PointTrouve = {
      id: String(e["id"]),
      score: typeof e["score"] === "number" ? e["score"] : 0,
      charge: lireCharge(e["payload"]),
    };
    const v = vecteurDense(e["vector"]);
    if (v) point.vecteur = v;
    sortie.push(point);
  }
  return sortie;
}

export class ClientQdrant {
  readonly url: string;
  private readonly cleApi: string | undefined;
  private readonly delaiMs: number;
  private readonly delaiEcritureMs: number;
  private readonly fetchImpl: FetchRag;

  constructor(options: OptionsQdrant) {
    this.url = options.url.replace(/\/+$/, "");
    this.cleApi = options.cleApi && options.cleApi !== "" ? options.cleApi : undefined;
    this.delaiMs = options.delaiMs ?? DELAI_LECTURE_MS;
    this.delaiEcritureMs = options.delaiEcritureMs ?? DELAI_ECRITURE_MS;
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async appel(
    methode: "GET" | "POST" | "PUT" | "DELETE",
    chemin: string,
    corps: unknown,
    signal: AbortSignal | undefined,
    ecriture = false,
  ): Promise<ReponseHttp> {
    return appeler({
      fetch: this.fetchImpl,
      origine: "qdrant",
      methode,
      url: `${this.url}${chemin}`,
      corps,
      entetes: this.cleApi ? { "api-key": this.cleApi } : {},
      signal,
      delaiMs: ecriture ? this.delaiEcritureMs : this.delaiMs,
    });
  }

  /** Réponse 2xx lue en JSON ; toute autre réponse est une `ErreurRag` au message de Qdrant. */
  private async exiger(rep: ReponseHttp, action: string): Promise<unknown> {
    if (rep.statut >= 200 && rep.statut < 300) return jsonOuNul(rep.texte);
    const message = messageQdrant(rep);
    throw new ErreurRag(
      codeHttp(rep, message),
      `Qdrant : ${action} refusé (HTTP ${rep.statut}) : ${message}`,
      rep.statut,
    );
  }

  /** Version et état de préparation du serveur ; ne lève jamais. */
  async sante(signal?: AbortSignal): Promise<EtatQdrant> {
    try {
      const [racine, pret] = await Promise.all([
        this.appel("GET", "/", undefined, signal),
        this.appel("GET", "/readyz", undefined, signal),
      ]);
      const json = jsonOuNul(racine.texte);
      const version = estObjet(json) && typeof json["version"] === "string" ? json["version"] : undefined;
      if (racine.statut !== 200) return { ok: false, erreur: `HTTP ${racine.statut}` };
      if (pret.statut !== 200)
        return { ok: false, ...(version ? { version } : {}), erreur: `non prêt : ${extrait(pret.texte)}` };
      return { ok: true, ...(version ? { version } : {}) };
    } catch (e) {
      if (signal?.aborted) throw e;
      return { ok: false, erreur: e instanceof Error ? e.message : String(e) };
    }
  }

  async listerCollections(signal?: AbortSignal): Promise<string[]> {
    const json = await this.exiger(
      await this.appel("GET", "/collections", undefined, signal),
      "liste des collections",
    );
    const r = estObjet(json) && estObjet(json["result"]) ? json["result"]["collections"] : undefined;
    if (!Array.isArray(r)) return [];
    return r.flatMap((c) => (estObjet(c) && typeof c["name"] === "string" ? [c["name"]] : []));
  }

  async infoCollection(nom: string, signal?: AbortSignal): Promise<InfoCollection> {
    const rep = await this.appel("GET", `/collections/${nomValide(nom)}`, undefined, signal);
    if (rep.statut === 404) return { existe: false, dimension: null, points: 0, statut: "absente" };
    const json = await this.exiger(rep, "lecture de la collection");
    const r = estObjet(json) && estObjet(json["result"]) ? json["result"] : {};
    const params = estObjet(r["config"]) && estObjet(r["config"]["params"]) ? r["config"]["params"] : {};
    const vecteurs = estObjet(params["vectors"]) ? params["vectors"] : {};
    const dense = estObjet(vecteurs[VECTEUR_DENSE]) ? vecteurs[VECTEUR_DENSE] : {};
    return {
      existe: true,
      dimension: typeof dense["size"] === "number" ? dense["size"] : null,
      points: typeof r["points_count"] === "number" ? r["points_count"] : 0,
      statut: typeof r["status"] === "string" ? r["status"] : "inconnu",
    };
  }

  /** Crée la collection (vecteur dense nommé + BM25 creux à IDF) et ses index de charge utile ; `collection_existe` si elle existe déjà. */
  async creerCollection(
    nom: string,
    options: { dimension: number; distance?: Distance },
    signal?: AbortSignal,
  ): Promise<void> {
    if (!Number.isInteger(options.dimension) || options.dimension < 1) {
      throw new ErreurRag("parametres", `dimension de vecteur invalide : ${options.dimension}`);
    }
    const corps = {
      vectors: { [VECTEUR_DENSE]: { size: options.dimension, distance: options.distance ?? "Cosine" } },
      sparse_vectors: { [VECTEUR_CREUX]: { modifier: "idf" } },
    };
    await this.exiger(
      await this.appel("PUT", `/collections/${nomValide(nom)}`, corps, signal, true),
      "création de la collection",
    );
    await this.creerIndex(nom, signal);
  }

  /** Crée la collection si elle manque ; si elle existe, vérifie la dimension et complète les index. */
  async assurerCollection(
    nom: string,
    options: { dimension: number; distance?: Distance },
    signal?: AbortSignal,
  ): Promise<{ creee: boolean }> {
    const info = await this.infoCollection(nom, signal);
    if (!info.existe) {
      await this.creerCollection(nom, options, signal);
      return { creee: true };
    }
    if (info.dimension !== options.dimension) {
      throw new ErreurRag(
        "dimension_differente",
        `la collection ${nom} a des vecteurs de dimension ${info.dimension ?? "?"}, pas ${options.dimension}`,
      );
    }
    await this.creerIndex(nom, signal);
    return { creee: false };
  }

  /** Index de charge utile : `doc_id`, `rel_path`, `ext` (mot-clé), `chunk_index` (entier), `text` (plein texte). */
  async creerIndex(nom: string, signal?: AbortSignal): Promise<void> {
    const index: [string, unknown][] = [
      ["doc_id", "keyword"],
      ["rel_path", "keyword"],
      ["ext", "keyword"],
      ["chunk_index", "integer"],
      [
        "text",
        {
          type: "text",
          tokenizer: "word",
          min_token_len: 2,
          max_token_len: 40,
          lowercase: true,
          ascii_folding: true,
        },
      ],
    ];
    for (const [champ, schema] of index) {
      const rep = await this.appel(
        "PUT",
        `/collections/${nomValide(nom)}/index?wait=true`,
        { field_name: champ, field_schema: schema },
        signal,
        true,
      );
      await this.exiger(rep, `index ${champ}`);
    }
  }

  /** Supprime la collection ; `false` si elle n'existait pas (Qdrant répond 200 avec `result: false`). */
  async supprimerCollection(nom: string, signal?: AbortSignal): Promise<boolean> {
    const rep = await this.appel(
      "DELETE",
      `/collections/${nomValide(nom)}?timeout=60`,
      undefined,
      signal,
      true,
    );
    if (rep.statut === 404) return false;
    const json = await this.exiger(rep, "suppression de la collection");
    return !(estObjet(json) && json["result"] === false);
  }

  /** Écrit les points (wait=true) par lots ; un point de même identifiant est remplacé en entier. */
  async inserer(
    nom: string,
    points: readonly PointAEcrire[],
    options: { tailleLot?: number; signal?: AbortSignal } = {},
  ): Promise<number> {
    const lot = Math.max(1, options.tailleLot ?? LOT_POINTS);
    for (let i = 0; i < points.length; i += lot) {
      const corps = { points: points.slice(i, i + lot).map(versApi) };
      const rep = await this.appel(
        "PUT",
        `/collections/${nomValide(nom)}/points?wait=true`,
        corps,
        options.signal,
        true,
      );
      await this.exiger(rep, "écriture des passages");
    }
    return points.length;
  }

  /** Supprime les passages d'un document, sauf ceux dont le `chunk_index` est dans `sauf` (remplacement : on insère puis on supprime les anciens). */
  async supprimerDocument(
    nom: string,
    docId: string,
    options: { sauf?: readonly number[]; signal?: AbortSignal } = {},
  ): Promise<void> {
    const filtre = filtreQdrant({ docIds: [docId] }, options.sauf);
    const rep = await this.appel(
      "POST",
      `/collections/${nomValide(nom)}/points/delete?wait=true`,
      { filter: filtre },
      options.signal,
      true,
    );
    await this.exiger(rep, "suppression des passages");
  }

  async compter(nom: string, filtre?: FiltreRag, signal?: AbortSignal): Promise<number> {
    const corps: Record<string, unknown> = { exact: true };
    const f = filtreQdrant(filtre);
    if (f) corps["filter"] = f;
    const json = await this.exiger(
      await this.appel("POST", `/collections/${nomValide(nom)}/points/count`, corps, signal),
      "comptage",
    );
    const r = estObjet(json) && estObjet(json["result"]) ? json["result"]["count"] : undefined;
    return typeof r === "number" ? r : 0;
  }

  /** Requête dense, creuse ou mixte (`prefetch` + fusion RRF) ; en mixte, une requête creuse vide se réduit au dense. */
  async interroger(nom: string, requete: RequeteQdrant, options: OptionsRequete): Promise<PointTrouve[]> {
    const limite = Math.max(1, Math.floor(options.limite));
    const filtre = filtreQdrant(options.filtre);
    const branche = (query: unknown, using: string, pre: number): Record<string, unknown> => ({
      query,
      using,
      limit: pre,
      ...(filtre ? { filter: filtre } : {}),
    });
    const sortie: Record<string, unknown> = {
      limit: limite,
      with_payload: true,
      with_vector: options.avecVecteur === true ? [VECTEUR_DENSE] : false,
    };
    const creuxVide = (c: VecteurCreux): boolean => c.indices.length === 0;
    if (requete.mode === "creux") {
      if (creuxVide(requete.creux)) return [];
      Object.assign(sortie, branche(requete.creux, VECTEUR_CREUX, limite));
    } else if (requete.mode === "dense" || creuxVide(requete.creux)) {
      Object.assign(sortie, branche([...requete.vecteur], VECTEUR_DENSE, limite));
    } else {
      const pre = Math.max(limite, options.prefetch ?? PREFETCH_DEFAUT);
      const k = options.fusionK === undefined ? FUSION_K_DEFAUT : options.fusionK;
      sortie["prefetch"] = [
        branche([...requete.vecteur], VECTEUR_DENSE, pre),
        branche(requete.creux, VECTEUR_CREUX, pre),
      ];
      sortie["query"] = k === null ? { fusion: "rrf" } : { rrf: { k } };
    }
    const json = await this.exiger(
      await this.appel("POST", `/collections/${nomValide(nom)}/points/query`, sortie, options.signal),
      "requête",
    );
    return pointsDe(json);
  }

  /** Une page de passages triés par `chunk_index` croissant, à partir de `depuis` (inclus). */
  async parcourir(
    nom: string,
    options: {
      filtre?: FiltreRag;
      limite?: number;
      depuis?: number;
      avecVecteur?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<PointTrouve[]> {
    const ordre: Record<string, unknown> = { key: "chunk_index", direction: "asc" };
    if (options.depuis !== undefined) ordre["start_from"] = options.depuis;
    const corps: Record<string, unknown> = {
      limit: Math.max(1, options.limite ?? PAGE_PARCOURS),
      order_by: ordre,
      with_payload: true,
      with_vector: options.avecVecteur === true ? [VECTEUR_DENSE] : false,
    };
    const f = filtreQdrant(options.filtre);
    if (f) corps["filter"] = f;
    const json = await this.exiger(
      await this.appel("POST", `/collections/${nomValide(nom)}/points/scroll`, corps, options.signal),
      "parcours",
    );
    return pointsDe(json);
  }

  /** Tous les passages d'un document dans l'ordre de `chunk_index`, page par page. */
  async *parcourirDocument(
    nom: string,
    docId: string,
    options: {
      taillePage?: number;
      depuis?: number;
      jusqua?: number;
      avecVecteur?: boolean;
      signal?: AbortSignal;
    } = {},
  ): AsyncGenerator<PointTrouve[]> {
    const taille = Math.max(1, options.taillePage ?? PAGE_PARCOURS);
    let depuis = options.depuis ?? 0;
    for (;;) {
      const filtre: FiltreRag = {
        docIds: [docId],
        ...(options.jusqua !== undefined ? { chunkMax: options.jusqua } : {}),
      };
      const page = await this.parcourir(nom, {
        filtre,
        limite: taille,
        depuis,
        ...(options.avecVecteur ? { avecVecteur: true } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (page.length === 0) return;
      yield page;
      const dernier = page[page.length - 1];
      if (page.length < taille || !dernier) return;
      depuis = dernier.charge.chunk_index + 1;
    }
  }
}

function versApi(p: PointAEcrire): Record<string, unknown> {
  const vecteur: Record<string, unknown> = { [VECTEUR_DENSE]: [...p.dense] };
  if (p.creux.indices.length > 0)
    vecteur[VECTEUR_CREUX] = { indices: p.creux.indices, values: p.creux.values };
  return { id: p.id, vector: vecteur, payload: p.charge };
}
