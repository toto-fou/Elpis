// SPDX-License-Identifier: MIT
/** apps/core/src/familles/rag-sources.ts — routes RAG de lecture : recherche de l'onglet Tester, passages d'un document, page rendue, localisation d'un passage, original en téléchargement ; sources fermées à un lecteur sauf si le propriétaire les a ouvertes. */
import {
  FENETRE_PASSAGES_RAG_MAX,
  schemaCorpsLocalisationRag,
  schemaCorpsRechercheRag,
  schemaRequetePassagesRag,
} from "@elpis/contracts";
import { contentDisposition } from "@elpis/http";
import type { FastifyReply, FastifyRequest } from "fastify";

import { ErreurRouteRag, corpsValide, idDocument, parametre, requeteValide } from "../rag/http";
import { essayerRecherche } from "../rag/essai";
import {
  droitSources,
  exigerSourcesOuvertes,
  fenetrePassages,
  lectureRestreintePermise,
  localiserPassage,
  ouvrirOriginal,
  pageDuDocument,
} from "../rag/sources";
import type { CibleSourcesRag, DroitSources } from "../rag/sources";
import { lireDocument } from "../rag/travaux";
import type { LigneDocumentRag } from "../rag/travaux";
import type { DefinitionRoute } from "../routes";
import { collectionDeLaRequete, routeRag } from "./rag-aides";
import type { ContexteCollection, RoutesRagResolues } from "./rag-aides";

const FENETRE_DEFAUT = 3;

/** Signal annulé quand le client coupe avant la fin de la réponse. */
function signalDeLaRequete(rep: FastifyReply): AbortSignal {
  const c = new AbortController();
  rep.raw.once("close", () => {
    if (!rep.raw.writableFinished) c.abort();
  });
  return c.signal;
}

/** Document du chemin dans la collection de la requête ; un document d'une autre collection est introuvable. */
async function documentDeLaRequete(
  dep: RoutesRagResolues,
  req: FastifyRequest,
  c: ContexteCollection,
): Promise<LigneDocumentRag> {
  const doc = await lireDocument(dep.base, idDocument(req));
  if (doc === null || doc.collection_id !== c.id)
    throw new ErreurRouteRag(404, "document_introuvable", "Document introuvable.");
  return doc;
}

const cibleDe = (c: ContexteCollection): CibleSourcesRag => ({
  collectionId: c.id,
  proprietaire: c.ligne.owner_user_id,
  metaJson: c.ligne.meta_json,
});

/** Numéro de page du chemin : entier de 1 à 999999, sinon la page n'existe pas. */
function pageDuChemin(req: FastifyRequest): number {
  const brut = parametre(req, "n");
  const n = /^[1-9][0-9]{0,5}$/u.test(brut) ? Number(brut) : 0;
  if (n === 0) throw new ErreurRouteRag(404, "page_introuvable", "Cette page n'existe pas dans le document.");
  return n;
}

export function routesSourcesRag(dep: RoutesRagResolues): DefinitionRoute[] {
  const base = dep.base;
  const droitDe = (c: ContexteCollection): DroitSources => droitSources(c.role, c.ligne.allow_source_open);
  return [
    routeRag("POST", "/api/rag/collections/:collection_id/recherche", async (req, rep) => {
      const c = await collectionDeLaRequete(dep, req);
      const corps = corpsValide(req, schemaCorpsRechercheRag);
      const [auteur] = await base.valeurs<[unknown]>("SELECT username FROM users WHERE id = ?", [
        c.ligne.owner_user_id,
      ]);
      return essayerRecherche(
        { base, qdrant: dep.qdrant, embeddings: dep.embeddings, reranker: dep.reranker },
        c.id,
        { id: c.ligne.owner_user_id, username: String(auteur?.[0] ?? "") },
        corps,
        signalDeLaRequete(rep),
      );
    }),
    routeRag("GET", "/api/rag/collections/:collection_id/documents/:doc_id/passages", async (req, rep) => {
      const c = await collectionDeLaRequete(dep, req);
      const doc = await documentDeLaRequete(dep, req, c);
      const q = requeteValide(req, schemaRequetePassagesRag);
      const droit = droitDe(c);
      if (droit !== "complet" && q.autour === undefined) exigerSourcesOuvertes(droit);
      if (droit !== "complet" && !lectureRestreintePermise(c.uid, c.id))
        throw new ErreurRouteRag(
          429,
          "trop_de_requetes",
          "Trop de passages lus à la suite dans cette collection : réessayez dans une minute.",
        );
      const r = await fenetrePassages(
        { base, qdrant: dep.qdrant },
        cibleDe(c),
        doc,
        {
          autour: Number(q.autour ?? 0),
          n: Math.min(FENETRE_PASSAGES_RAG_MAX, Number(q.n ?? FENETRE_DEFAUT)),
          droit,
        },
        signalDeLaRequete(rep),
      );
      return { passages: r.passages, chunk_count: doc.chunk_count, restricted: r.restreint };
    }),
    routeRag("GET", "/api/rag/collections/:collection_id/documents/:doc_id/pages/:n", async (req, rep) => {
      const c = await collectionDeLaRequete(dep, req);
      exigerSourcesOuvertes(droitDe(c));
      const doc = await documentDeLaRequete(dep, req, c);
      const page = pageDuChemin(req);
      const etag = `"${doc.sha256.slice(0, 16)}-${page}"`;
      if (req.headers["if-none-match"] === etag)
        return rep.code(304).header("etag", etag).header("cache-control", "private, no-cache").send();
      const r = await pageDuDocument({ base, qdrant: dep.qdrant }, cibleDe(c), doc, page);
      void rep
        .header("content-type", "image/webp")
        .header("content-length", String(r.octets.length))
        .header("cache-control", "private, no-cache")
        .header("etag", etag)
        .header("x-content-type-options", "nosniff")
        .header("x-rag-dpi", String(r.dpi));
      if (r.pages !== null) void rep.header("x-rag-pages", String(r.pages));
      return rep.send(r.octets);
    }),
    routeRag("POST", "/api/rag/collections/:collection_id/documents/:doc_id/localiser", async (req, rep) => {
      const c = await collectionDeLaRequete(dep, req);
      exigerSourcesOuvertes(droitDe(c));
      const doc = await documentDeLaRequete(dep, req, c);
      const corps = corpsValide(req, schemaCorpsLocalisationRag);
      return localiserPassage(
        cibleDe(c),
        doc,
        { texte: corps.texte, page: corps.page },
        signalDeLaRequete(rep),
      );
    }),
    routeRag("GET", "/api/rag/collections/:collection_id/documents/:doc_id/original", async (req, rep) => {
      const c = await collectionDeLaRequete(dep, req);
      exigerSourcesOuvertes(droitDe(c));
      const doc = await documentDeLaRequete(dep, req, c);
      const { flux, taille } = ouvrirOriginal(cibleDe(c), doc);
      return rep
        .header("content-type", "application/octet-stream")
        .header("content-length", String(taille))
        .header("content-disposition", contentDisposition(doc.name, "attachment"))
        .header("x-content-type-options", "nosniff")
        .header("cache-control", "private, no-store")
        .send(flux);
    }),
  ];
}
