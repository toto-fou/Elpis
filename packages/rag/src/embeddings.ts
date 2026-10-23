// SPDX-License-Identifier: MIT
/** packages/rag/src/embeddings.ts — client `/v1/embeddings` (OpenAI, llama.cpp) : lots, reprises sur 408/429/5xx, sonde de dimension, préfixe de contexte. */
import { ErreurRag, estAbandon } from "./erreurs";
import { appeler, dormir, estObjet, extrait, jsonOuNul, sansBarresFinales } from "./reseau";
import type { FetchRag, ReponseHttp } from "./reseau";

export interface OptionsEmbeddings {
  url: string;
  modele: string;
  cleApi?: string | undefined;
  tailleLot?: number;
  delaiMs?: number;
  reprises?: number;
  attenteBaseMs?: number;
  cacheRequetes?: number;
  fetch?: FetchRag;
  /** Attente entre deux essais (remplaçable dans les tests). */
  attendre?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface OptionsAppel {
  signal?: AbortSignal | undefined;
  reprises?: number;
  surProgres?: (faits: number, total: number) => void;
}

const LOT_DEFAUT = 32;
const DELAI_DEFAUT_MS = 60_000;
const REPRISES_DEFAUT = 3;
const REPRISES_REQUETE = 1;
const ATTENTE_BASE_MS = 1_000;
const ATTENTE_MAX_MS = 30_000;
const CACHE_DEFAUT = 256;
const NOM_CONTEXTE_MAX = 200;

function transitoire(statut: number): boolean {
  return statut === 408 || statut === 429 || (statut >= 500 && statut <= 599);
}

function nettoyerContexte(texte: string): string {
  const t = texte
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return t.length > NOM_CONTEXTE_MAX ? `${t.slice(0, NOM_CONTEXTE_MAX)}…` : t;
}

/** Préfixe de contexte d'un passage : `[Document : nom | Section : chemin des titres]` suivi d'un saut de ligne. */
export function prefixeContexte(a: { document: string; section?: string | undefined }): string {
  const doc = nettoyerContexte(a.document);
  const section = a.section ? nettoyerContexte(a.section) : "";
  return section === "" ? `[Document : ${doc}]\n` : `[Document : ${doc} | Section : ${section}]\n`;
}

/** Texte envoyé à l'embedding : le préfixe de contexte puis le texte du passage (le texte stocké reste sans préfixe). */
export function texteAvecContexte(a: { document: string; heading_path: string; text: string }): string {
  return prefixeContexte({ document: a.document, section: a.heading_path }) + a.text;
}

/** Vecteurs d'une réponse OpenAI, rangés selon `index` ; erreur si un vecteur manque ou n'est pas numérique. */
export function lireVecteurs(json: unknown, attendus: number): number[][] {
  const data = estObjet(json) ? json["data"] : undefined;
  if (!Array.isArray(data))
    throw new ErreurRag("embeddings_reponse", "réponse d'embeddings sans champ `data`");
  const sortie: (number[] | undefined)[] = new Array<number[] | undefined>(attendus).fill(undefined);
  data.forEach((e: unknown, rang) => {
    if (!estObjet(e)) return;
    const index = typeof e["index"] === "number" && Number.isInteger(e["index"]) ? e["index"] : rang;
    const v = e["embedding"];
    if (index < 0 || index >= attendus) return;
    if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "number" && Number.isFinite(x))) {
      throw new ErreurRag("embeddings_reponse", `vecteur ${index} invalide dans la réponse d'embeddings`);
    }
    sortie[index] = v as number[];
  });
  const complet: number[][] = [];
  for (const [i, v] of sortie.entries()) {
    if (!v)
      throw new ErreurRag(
        "embeddings_reponse",
        `vecteur ${i} manquant : ${attendus} attendus, ${data.length} reçus`,
      );
    complet.push(v);
  }
  const taille = complet[0]?.length ?? 0;
  if (complet.some((v) => v.length !== taille)) {
    throw new ErreurRag("embeddings_reponse", "vecteurs de dimensions différentes dans une même réponse");
  }
  return complet;
}

export class ClientEmbeddings {
  readonly modele: string;
  private readonly adresse: string;
  private readonly cleApi: string | undefined;
  private readonly tailleLot: number;
  private readonly delaiMs: number;
  private readonly reprises: number;
  private readonly attenteBaseMs: number;
  private readonly fetchImpl: FetchRag;
  private readonly attendre: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly cacheMax: number;
  private readonly cache = new Map<string, number[]>();
  private dimension: number | undefined;

  constructor(options: OptionsEmbeddings) {
    this.modele = options.modele;
    this.adresse = `${sansBarresFinales(options.url).replace(/\/v1$/, "")}/v1/embeddings`;
    this.cleApi = options.cleApi && options.cleApi !== "" ? options.cleApi : undefined;
    this.tailleLot = Math.max(1, Math.floor(options.tailleLot ?? LOT_DEFAUT));
    this.delaiMs = options.delaiMs ?? DELAI_DEFAUT_MS;
    this.reprises = Math.max(0, Math.floor(options.reprises ?? REPRISES_DEFAUT));
    this.attenteBaseMs = options.attenteBaseMs ?? ATTENTE_BASE_MS;
    this.fetchImpl = options.fetch ?? fetch;
    this.attendre = options.attendre ?? dormir;
    this.cacheMax = Math.max(0, options.cacheRequetes ?? CACHE_DEFAUT);
  }

  /** Attente avant la reprise `essai` (0 pour la première) : exponentielle, au moins `Retry-After`, plafonnée. */
  private pause(essai: number, rep?: ReponseHttp): number {
    const exponentielle = this.attenteBaseMs * 2 ** essai;
    const entete = Number(rep?.entetes.get("retry-after"));
    const imposee = Number.isFinite(entete) && entete > 0 ? entete * 1000 : 0;
    return Math.min(ATTENTE_MAX_MS, Math.max(exponentielle, imposee));
  }

  /** Un lot de textes non vides, avec reprises sur les pannes transitoires. */
  private async lot(
    textes: readonly string[],
    reprises: number,
    signal: AbortSignal | undefined,
  ): Promise<number[][]> {
    for (let essai = 0; ; essai++) {
      let rep: ReponseHttp;
      try {
        rep = await appeler({
          fetch: this.fetchImpl,
          origine: "embeddings",
          methode: "POST",
          url: this.adresse,
          corps: { model: this.modele, input: textes },
          entetes: this.cleApi ? { authorization: `Bearer ${this.cleApi}` } : {},
          signal,
          delaiMs: this.delaiMs,
        });
      } catch (e) {
        if (estAbandon(e, signal) || !(e instanceof ErreurRag) || essai >= reprises) throw e;
        await this.attendre(this.pause(essai), signal);
        continue;
      }
      if (rep.statut >= 200 && rep.statut < 300) return lireVecteurs(jsonOuNul(rep.texte), textes.length);
      if (transitoire(rep.statut) && essai < reprises) {
        await this.attendre(this.pause(essai, rep), signal);
        continue;
      }
      throw new ErreurRag(
        "embeddings_http",
        `serveur d'embeddings : HTTP ${rep.statut} : ${extrait(rep.texte)}`,
        rep.statut,
      );
    }
  }

  /** Vecteurs de `textes`, dans le même ordre ; un texte blanc donne un vecteur vide (rien n'est envoyé pour lui). */
  async embedder(textes: readonly string[], options: OptionsAppel = {}): Promise<number[][]> {
    const sortie: number[][] = textes.map(() => []);
    const utiles = textes.flatMap((t, i) => (t.trim() === "" ? [] : [i]));
    const reprises = options.reprises ?? this.reprises;
    for (let debut = 0; debut < utiles.length; debut += this.tailleLot) {
      const indices = utiles.slice(debut, debut + this.tailleLot);
      const vecteurs = await this.lot(
        indices.map((i) => textes[i] ?? ""),
        reprises,
        options.signal,
      );
      indices.forEach((i, k) => {
        sortie[i] = vecteurs[k] ?? [];
      });
      options.surProgres?.(Math.min(debut + indices.length, utiles.length), utiles.length);
    }
    return sortie;
  }

  /** Vecteur d'une requête de recherche : cache LRU, une seule reprise par défaut (le budget de la recherche est court). */
  async embedderRequete(texte: string, options: OptionsAppel = {}): Promise<number[]> {
    const cle = texte;
    const connu = this.cache.get(cle);
    if (connu) {
      this.cache.delete(cle);
      this.cache.set(cle, connu);
      return [...connu];
    }
    const [vecteur] = await this.embedder([texte], {
      ...options,
      reprises: options.reprises ?? REPRISES_REQUETE,
    });
    if (!vecteur || vecteur.length === 0)
      throw new ErreurRag("embeddings_reponse", "requête vide : aucun vecteur");
    if (this.cacheMax > 0) {
      if (this.cache.size >= this.cacheMax) this.cache.delete(this.cache.keys().next().value as string);
      this.cache.set(cle, vecteur);
    }
    return [...vecteur];
  }

  /** Dimension des vecteurs du modèle, sondée une fois par un texte d'essai. */
  async sonderDimension(options: OptionsAppel = {}): Promise<number> {
    if (this.dimension !== undefined) return this.dimension;
    const [vecteur] = await this.embedder(["dimension"], { ...options, reprises: options.reprises ?? 2 });
    if (!vecteur || vecteur.length === 0)
      throw new ErreurRag("embeddings_reponse", "sonde de dimension : aucun vecteur");
    this.dimension = vecteur.length;
    return this.dimension;
  }
}
