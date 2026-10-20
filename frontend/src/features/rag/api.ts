// SPDX-License-Identifier: MIT
/** frontend/src/features/rag/api.ts — accès REST de la page RAG (`/api/rag/*`, arbre du bac) : réponses validées par les schémas des contrats, échecs réduits à un code stable et un message. */
import {
  schemaOk,
  schemaReponseArbreBac,
  schemaReponseCollectionRag,
  schemaReponseApercuDecoupageRag,
  schemaReponseCollectionsRag,
  schemaReponseDepotRag,
  schemaReponseDecoupageDocumentRag,
  schemaReponseDocumentRag,
  schemaReponseDocumentsRag,
  schemaReponseEtatRag,
  schemaReponseGroupesPublicationRag,
  schemaReponseLectureDecoupageDocumentRag,
  schemaReponseLocalisationRag,
  schemaReponseMajCollectionRag,
  schemaReponsePassagesDocumentRag,
  schemaReponsePassagesListeRag,
  schemaReponsePublicationRag,
  schemaReponseRechercheRag,
  schemaReponseReindexationRag,
  schemaReponseTravailRag,
  schemaReponseTravauxRag,
  schemaReponseViderRag,
} from "@elpis/contracts";
import type {
  CollectionVueRag,
  DecoupageDocumentRag,
  DecoupageRag,
  DemandePublicationRag,
  DocumentRag,
  EtatRag,
  ModeRechercheRag,
  NoeudArbre,
  ResultatDepotRag,
  TravailRag,
} from "@elpis/contracts";
import type { ZodType } from "zod";

import type { ClientHttp } from "../../platform/http/client";
import { messageErreur } from "../../platform/http/resultat";
import type { ApiResult } from "../../platform/http/resultat";

/** Issue d'un appel : la valeur validée, ou l'échec avec le code stable du serveur (`{detail, code}`) et son message. */
export type ResultatRag<T> = { ok: true; valeur: T } | { ok: false; code: string | null; message: string };

export interface PageDocuments {
  documents: DocumentRag[];
  total: number;
}

export interface CorpsMajCollection {
  name?: string;
  description?: string;
  chunking?: DecoupageRag;
  ocr?: boolean;
}

export interface BilanDepotApi {
  results: ResultatDepotRag[];
  job: TravailRag | null;
}

export interface GroupesPublication {
  groups: { id: number; name: string; members: number }[];
  can_publish_all: boolean;
  accounts: number;
}

export type RechercheRag = (typeof schemaReponseRechercheRag)["_output"];
export type PassagesDocumentRag = (typeof schemaReponsePassagesDocumentRag)["_output"];
export type LocalisationRag = (typeof schemaReponseLocalisationRag)["_output"];
export type ArbreBac = (typeof schemaReponseArbreBac)["_output"];
export type ApercuDecoupageRag = (typeof schemaReponseApercuDecoupageRag)["_output"];
export type ReponseDecoupageDocumentRag = (typeof schemaReponseDecoupageDocumentRag)["_output"];
export type PassagesListeRag = (typeof schemaReponsePassagesListeRag)["_output"];

function codeDe(brut: unknown): string | null {
  if (typeof brut !== "object" || brut === null) return null;
  const code = (brut as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function issue<T>(r: ApiResult<T>): ResultatRag<T> {
  if (r.type === "ok") return { ok: true, valeur: r.valeur };
  const code = "erreur" in r ? codeDe(r.erreur.brut) : null;
  const message = r.type === "invalide" ? "Réponse du serveur inattendue" : messageErreur(r);
  return { ok: false, code, message };
}

const JSON_ENTETES = { "Content-Type": "application/json" };

export interface ApiRag {
  etat(): Promise<ResultatRag<EtatRag>>;
  collections(): Promise<ResultatRag<CollectionVueRag[]>>;
  collection(id: string): Promise<ResultatRag<CollectionVueRag>>;
  creer(name: string, description: string): Promise<ResultatRag<CollectionVueRag>>;
  maj(
    id: string,
    corps: CorpsMajCollection,
  ): Promise<ResultatRag<{ collection: CollectionVueRag; job: TravailRag | null }>>;
  supprimer(id: string): Promise<ResultatRag<unknown>>;
  publier(
    id: string,
    corps: DemandePublicationRag,
  ): Promise<ResultatRag<{ collection: CollectionVueRag; notified: number }>>;
  groupesPublication(): Promise<ResultatRag<GroupesPublication>>;
  masquer(id: string, hidden: boolean): Promise<ResultatRag<CollectionVueRag>>;
  documents(id: string, offset: number, limit: number): Promise<ResultatRag<PageDocuments>>;
  deposer(id: string, corps: FormData): Promise<ResultatRag<BilanDepotApi>>;
  importerBac(id: string, paths: string[]): Promise<ResultatRag<BilanDepotApi>>;
  supprimerDocument(id: string, docId: string): Promise<ResultatRag<unknown>>;
  vider(id: string): Promise<ResultatRag<{ deleted: number }>>;
  reindexer(
    id: string,
    documents?: string[],
    force?: boolean,
  ): Promise<ResultatRag<{ job: TravailRag | null }>>;
  travaux(actifs: boolean): Promise<ResultatRag<TravailRag[]>>;
  agirTravail(id: string, action: "suspendre" | "reprendre" | "annuler"): Promise<ResultatRag<TravailRag>>;
  rechercher(
    id: string,
    corps: { requete: string; mode: ModeRechercheRag; limite: number; reclasser: boolean },
  ): Promise<ResultatRag<RechercheRag>>;
  arbreBac(): Promise<ResultatRag<ArbreBac>>;
  urlOriginal(id: string, docId: string): string;
  /** Un document (pages, nombre de passages) : lisible par tout lecteur de la collection. */
  document(id: string, docId: string): Promise<ResultatRag<DocumentRag>>;
  /** Fenêtre de passages autour du passage `autour` ; un lecteur sans ouverture ne reçoit que celui-là. */
  passages(
    id: string,
    docId: string,
    autour: number,
    voisins?: number,
  ): Promise<ResultatRag<PassagesDocumentRag>>;
  /** Retrouve un passage dans le rendu du document : page et rectangles. */
  localiser(id: string, docId: string, texte: string, page?: number): Promise<ResultatRag<LocalisationRag>>;
  urlPage(id: string, docId: string, page: number): string;
  /** Passages que donnerait un découpage de document (propriétaire) : rien n'est écrit. */
  apercuDecoupage(
    id: string,
    docId: string,
    decoupage: DecoupageDocumentRag,
  ): Promise<ResultatRag<ApercuDecoupageRag>>;
  /** Découpage propre du document (propriétaire) ; `null` : il suit sa collection. */
  decoupageDocument(id: string, docId: string): Promise<ResultatRag<DecoupageDocumentRag | null>>;
  /** Fixe le découpage du document (`null` : celui de la collection) et le met en réindexation. */
  appliquerDecoupage(
    id: string,
    docId: string,
    decoupage: DecoupageDocumentRag | null,
  ): Promise<ResultatRag<ReponseDecoupageDocumentRag>>;
  /** Passages réellement indexés d'un document, par page. */
  passagesListe(
    id: string,
    docId: string,
    offset: number,
    limit: number,
  ): Promise<ResultatRag<PassagesListeRag>>;
}

export function creerApiRag(http: ClientHttp): ApiRag {
  const seg = (id: string): string => encodeURIComponent(id);
  const lire = <T>(url: string, schema: ZodType<T>) => http.requete(url, {}, { schema });
  const envoyer = <T>(methode: string, url: string, schema: ZodType<T>, corps?: unknown) =>
    http.requete(
      url,
      corps === undefined
        ? { method: methode }
        : { method: methode, headers: JSON_ENTETES, body: JSON.stringify(corps) },
      { schema },
    );
  const base = (id: string): string => `/api/rag/collections/${seg(id)}`;
  return {
    async etat() {
      return issue(await lire("/api/rag/etat", schemaReponseEtatRag));
    },
    async collections() {
      const r = issue(await lire("/api/rag/collections?masquees=1", schemaReponseCollectionsRag));
      return r.ok ? { ok: true, valeur: r.valeur.collections } : r;
    },
    async collection(id) {
      const r = issue(await lire(base(id), schemaReponseCollectionRag));
      return r.ok ? { ok: true, valeur: r.valeur.collection } : r;
    },
    async creer(name, description) {
      const corps = description.trim() === "" ? { name } : { name, description };
      const r = issue(await envoyer("POST", "/api/rag/collections", schemaReponseCollectionRag, corps));
      return r.ok ? { ok: true, valeur: r.valeur.collection } : r;
    },
    async maj(id, corps) {
      return issue(await envoyer("PATCH", base(id), schemaReponseMajCollectionRag, corps));
    },
    async supprimer(id) {
      return issue(await envoyer("DELETE", base(id), schemaOk));
    },
    async publier(id, corps) {
      return issue(await envoyer("PUT", `${base(id)}/publication`, schemaReponsePublicationRag, corps));
    },
    async groupesPublication() {
      return issue(await lire("/api/rag/groupes-publication", schemaReponseGroupesPublicationRag));
    },
    async masquer(id, hidden) {
      const r = issue(await envoyer("PUT", `${base(id)}/masquage`, schemaReponseCollectionRag, { hidden }));
      return r.ok ? { ok: true, valeur: r.valeur.collection } : r;
    },
    async documents(id, offset, limit) {
      const r = issue(
        await lire(`${base(id)}/documents?offset=${offset}&limit=${limit}`, schemaReponseDocumentsRag),
      );
      return r.ok ? { ok: true, valeur: { documents: r.valeur.documents, total: r.valeur.total } } : r;
    },
    async deposer(id, corps) {
      const r = issue(
        await http.requete(
          `${base(id)}/documents`,
          { method: "POST", body: corps },
          { schema: schemaReponseDepotRag },
        ),
      );
      return r;
    },
    async importerBac(id, paths) {
      return issue(await envoyer("POST", `${base(id)}/import-sandbox`, schemaReponseDepotRag, { paths }));
    },
    async supprimerDocument(id, docId) {
      return issue(await envoyer("DELETE", `${base(id)}/documents/${seg(docId)}`, schemaOk));
    },
    async vider(id) {
      return issue(await envoyer("POST", `${base(id)}/vider`, schemaReponseViderRag));
    },
    async reindexer(id, documents, force) {
      const corps: { documents?: string[]; force?: boolean } = {};
      if (documents !== undefined) corps.documents = documents;
      if (force !== undefined) corps.force = force;
      return issue(await envoyer("POST", `${base(id)}/reindexer`, schemaReponseReindexationRag, corps));
    },
    async travaux(actifs) {
      const r = issue(await lire(`/api/rag/travaux${actifs ? "?actifs=1" : ""}`, schemaReponseTravauxRag));
      return r.ok ? { ok: true, valeur: r.valeur.jobs } : r;
    },
    async agirTravail(id, action) {
      const r = issue(
        await envoyer("POST", `/api/rag/travaux/${seg(id)}/${action}`, schemaReponseTravailRag),
      );
      return r.ok ? { ok: true, valeur: r.valeur.job } : r;
    },
    async rechercher(id, corps) {
      return issue(await envoyer("POST", `${base(id)}/recherche`, schemaReponseRechercheRag, corps));
    },
    async arbreBac() {
      return issue(await lire("/api/sandbox/tree", schemaReponseArbreBac));
    },
    urlOriginal(id, docId) {
      return `${base(id)}/documents/${seg(docId)}/original`;
    },
    async document(id, docId) {
      const r = issue(await lire(`${base(id)}/documents/${seg(docId)}`, schemaReponseDocumentRag));
      return r.ok ? { ok: true, valeur: r.valeur.document } : r;
    },
    async passages(id, docId, autour, voisins) {
      const n = voisins === undefined ? "" : `&n=${voisins}`;
      return issue(
        await lire(
          `${base(id)}/documents/${seg(docId)}/passages?autour=${autour}${n}`,
          schemaReponsePassagesDocumentRag,
        ),
      );
    },
    async localiser(id, docId, texte, page) {
      const corps = page === undefined ? { texte } : { texte, page };
      return issue(
        await envoyer(
          "POST",
          `${base(id)}/documents/${seg(docId)}/localiser`,
          schemaReponseLocalisationRag,
          corps,
        ),
      );
    },
    urlPage(id, docId, page) {
      return `${base(id)}/documents/${seg(docId)}/pages/${page}`;
    },
    async decoupageDocument(id, docId) {
      const r = issue(
        await lire(`${base(id)}/documents/${seg(docId)}/decoupage`, schemaReponseLectureDecoupageDocumentRag),
      );
      return r.ok ? { ok: true, valeur: r.valeur.decoupage } : r;
    },
    async apercuDecoupage(id, docId, decoupage) {
      return issue(
        await envoyer(
          "POST",
          `${base(id)}/documents/${seg(docId)}/apercu-decoupage`,
          schemaReponseApercuDecoupageRag,
          { decoupage },
        ),
      );
    },
    async appliquerDecoupage(id, docId, decoupage) {
      return issue(
        await envoyer(
          "PUT",
          `${base(id)}/documents/${seg(docId)}/decoupage`,
          schemaReponseDecoupageDocumentRag,
          { decoupage },
        ),
      );
    },
    async passagesListe(id, docId, offset, limit) {
      return issue(
        await lire(
          `${base(id)}/documents/${seg(docId)}/passages/liste?offset=${offset}&limit=${limit}`,
          schemaReponsePassagesListeRag,
        ),
      );
    },
  };
}

export type { NoeudArbre };
