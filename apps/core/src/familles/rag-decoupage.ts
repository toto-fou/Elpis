// SPDX-License-Identifier: MIT
/** apps/core/src/familles/rag-decoupage.ts — routes RAG du découpage d'un document : découpage propre (lecture, enregistrement avec réindexation), aperçu sur l'extrait gardé, liste des passages réellement indexés. */
import {
  PASSAGES_LISTE_RAG_MAX,
  schemaCorpsApercuDecoupageRag,
  schemaCorpsDecoupageDocumentRag,
  schemaRequetePassagesListeRag,
} from "@elpis/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";

import {
  apercuDecoupageRag,
  decoupageProprePublic,
  ecrireDecoupageDocumentRag,
  lireDecoupageCollectionRag,
  listerPassagesIndexesRag,
  paramsDuDecoupage,
  verifierRegexRag,
} from "../rag/decoupage";
import { ragActif } from "../rag/depot";
import { corpsValide, ErreurRouteRag, idDocument, requeteValide } from "../rag/http";
import { lireExtraitRag } from "../rag/indexeur";
import { droitSources, exigerSourcesOuvertes } from "../rag/sources";
import { DOCUMENT_A_TRAITER, documentPublic, lireDocument } from "../rag/travaux";
import type { LigneDocumentRag } from "../rag/travaux";
import type { DefinitionRoute } from "../routes";
import { collectionDeLaRequete, routeRag } from "./rag-aides";
import type { ContexteCollection, RoutesRagResolues } from "./rag-aides";

const CHEMIN = "/api/rag/collections/:collection_id/documents/:doc_id";
const LISTE_DEFAUT = 100;

/** Document du chemin dans la collection de la requête ; un document d'une autre collection est introuvable. */
async function documentDe(
  dep: RoutesRagResolues,
  req: FastifyRequest,
  c: ContexteCollection,
): Promise<LigneDocumentRag> {
  const doc = await lireDocument(dep.base, idDocument(req));
  if (doc === null || doc.collection_id !== c.id)
    throw new ErreurRouteRag(404, "document_introuvable", "Document introuvable.");
  return doc;
}

function signalDe(rep: FastifyReply): AbortSignal {
  const c = new AbortController();
  rep.raw.once("close", () => {
    if (!rep.raw.writableFinished) c.abort();
  });
  return c.signal;
}

export function routesDecoupageRag(dep: RoutesRagResolues): DefinitionRoute[] {
  const base = dep.base;
  return [
    routeRag("GET", `${CHEMIN}/decoupage`, async (req) => {
      const c = await collectionDeLaRequete(dep, req, { ecriture: true });
      const doc = await documentDe(dep, req, c);
      return { decoupage: decoupageProprePublic(c.ligne, doc) };
    }),
    routeRag("PUT", `${CHEMIN}/decoupage`, async (req) => {
      const c = await collectionDeLaRequete(dep, req, { ecriture: true });
      const doc = await documentDe(dep, req, c);
      const corps = corpsValide(req, schemaCorpsDecoupageDocumentRag);
      if (corps.decoupage !== null) verifierRegexRag(...paramsDuDecoupage(corps.decoupage));
      ecrireDecoupageDocumentRag(c.ligne.owner_user_id, c.id, doc.id, doc.sha256, corps.decoupage);
      const service = dep.service();
      let job = null;
      if (service !== null && ragActif()) {
        job = await service.reindexer(c.uid, c.id, { documents: [doc.id] });
        if (job === null && DOCUMENT_A_TRAITER.has(doc.status))
          job = (await service.travauxDu(c.uid, { actifs: true, collectionId: c.id, limite: 1 }))[0] ?? null;
      }
      return { document: documentPublic((await lireDocument(base, doc.id)) ?? doc), job };
    }),
    routeRag("POST", `${CHEMIN}/apercu-decoupage`, async (req) => {
      const c = await collectionDeLaRequete(dep, req, { ecriture: true });
      const doc = await documentDe(dep, req, c);
      const corps = corpsValide(req, schemaCorpsApercuDecoupageRag);
      verifierRegexRag(...paramsDuDecoupage(corps.decoupage));
      const extrait = lireExtraitRag(c.ligne.owner_user_id, c.id, doc.id, doc.sha256);
      if (extrait === null)
        throw new ErreurRouteRag(
          409,
          "extrait_indisponible",
          "Le texte de ce document n'est pas encore extrait : attendez la fin de son indexation.",
        );
      return apercuDecoupageRag(
        extrait.blocks,
        lireDecoupageCollectionRag(c.ligne.chunk_json),
        doc.ext,
        corps.decoupage,
      );
    }),
    routeRag("GET", `${CHEMIN}/passages/liste`, async (req, rep) => {
      const c = await collectionDeLaRequete(dep, req);
      exigerSourcesOuvertes(droitSources(c.role, c.ligne.allow_source_open));
      const doc = await documentDe(dep, req, c);
      const q = requeteValide(req, schemaRequetePassagesListeRag);
      const offset = Number(q.offset ?? 0);
      const limite = Math.min(PASSAGES_LISTE_RAG_MAX, Math.max(1, Number(q.limit ?? LISTE_DEFAUT)));
      const passages =
        offset >= doc.chunk_count
          ? []
          : await listerPassagesIndexesRag(dep.qdrant, c.ligne, doc, offset, limite, signalDe(rep));
      return { passages, total: doc.chunk_count };
    }),
  ];
}
