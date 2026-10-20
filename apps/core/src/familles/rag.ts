// SPDX-License-Identifier: MIT
/** apps/core/src/familles/rag.ts — routes du compte pour le RAG intégré (main, session) : état, collections, publication, masquage, groupes de publication, travaux d'indexation ; documents, sources et découpage dans `rag-documents.ts`, `rag-sources.ts` et `rag-decoupage.ts`. */
import {
  schemaCorpsCreationCollectionRag,
  schemaCorpsMajCollectionRag,
  schemaCorpsMasquageRag,
  schemaCorpsPublicationRag,
  schemaRequeteCollectionsRag,
  schemaRequeteTravauxRag,
} from "@elpis/contracts";

import { journal } from "../journal";
import { appliquerPublication } from "../rag/acces";
import {
  audiencePublicationRag,
  creerCollectionRag,
  groupesDePublicationRag,
  lireVueCollectionRag,
  listerCollectionsRag,
  masquerCollectionRag,
  mettreAJourCollectionRag,
} from "../rag/collections";
import { paramsDuDecoupage, verifierRegexRag } from "../rag/decoupage";
import { ragActif } from "../rag/depot";
import { etatRag } from "../rag/etat";
import { corpsValide, ErreurRouteRag, exigerDroit, idTravail, requeteValide } from "../rag/http";
import { pousserNotification } from "../notifications/envoi";
import type { Famille } from "../routes";
import { utilisateur } from "./comptes";
import { routesDecoupageRag } from "./rag-decoupage";
import { routesDocumentsRag } from "./rag-documents";
import { collectionDeLaRequete, resoudreDependancesRag, routeRag, serviceExige } from "./rag-aides";
import { routesChatRag } from "./rag-chat";
import type { DependancesFamilleRag, RoutesRagResolues } from "./rag-aides";
import { routesSourcesRag } from "./rag-sources";

export type { DependancesFamilleRag } from "./rag-aides";

const log = journal("rag");

/** Notifications d'un partage au plus par publication (une instance de quelques centaines de comptes en reste très loin). */
const NOTIFIES_MAX = 500;

const vrai = (v: string | undefined): boolean => v === "1" || v === "true";

async function vueOuIntrouvable(dep: RoutesRagResolues, uid: number, id: string) {
  const vue = await lireVueCollectionRag(dep.base, uid, id);
  if (vue === null) throw new ErreurRouteRag(404, "collection_introuvable", "Collection introuvable.");
  return vue;
}

/** Comptes qui gagnent l'accès par une publication, prévenus par une notification « X a partagé la collection Y avec vous ». */
async function prevenirDesPartages(
  dep: RoutesRagResolues,
  c: { uid: number; id: string; nom: string; auteur: string },
  avant: ReadonlySet<number>,
  apres: ReadonlySet<number>,
): Promise<number> {
  const nouveaux = [...apres].filter((u) => !avant.has(u)).slice(0, NOTIFIES_MAX);
  const titre = `${c.auteur} a partagé la collection ${c.nom} avec vous`;
  const corps = "Elle apparaît dans « Partagées avec moi » de la page RAG.";
  let n = 0;
  for (const u of nouveaux) {
    try {
      const envoi =
        dep.notifier !== undefined
          ? await dep.notifier({ uid: u, title: titre, body: corps, collectionId: c.id }).then(() => true)
          : (await pousserNotification(dep.base, u, "rag_share", titre, {
              body: corps,
              refType: "rag_collection",
              refId: c.id,
            })) !== null;
      if (envoi) n++;
    } catch (e) {
      log.warn({ err: e }, `partage de la collection ${c.id} : notification non envoyée`);
    }
  }
  return n;
}

export function creerFamilleRag(dependances: DependancesFamilleRag): Famille {
  const dep = resoudreDependancesRag(dependances);
  const base = dep.base;
  return {
    nom: "rag",
    routes: [
      routeRag("GET", "/api/rag/etat", async (req) =>
        etatRag(
          { base, service: dep.service, qdrant: dep.qdrant, sondeExtracteur: dep.sondeExtracteur },
          utilisateur(req),
        ),
      ),
      routeRag("GET", "/api/rag/collections", async (req) => {
        const uid = utilisateur(req);
        await exigerDroit(base, uid);
        const q = requeteValide(req, schemaRequeteCollectionsRag);
        return { collections: await listerCollectionsRag(base, uid, { masquees: vrai(q.masquees) }) };
      }),
      routeRag("POST", "/api/rag/collections", async (req) => {
        const uid = utilisateur(req);
        await exigerDroit(base, uid);
        const corps = corpsValide(req, schemaCorpsCreationCollectionRag);
        if (!ragActif())
          throw new ErreurRouteRag(
            503,
            "rag_desactive",
            "Le RAG est désactivé : aucun serveur d'embeddings n'est configuré.",
          );
        const id = await creerCollectionRag(base, uid, corps);
        return { collection: await vueOuIntrouvable(dep, uid, id) };
      }),
      routeRag("GET", "/api/rag/collections/:collection_id", async (req) => {
        const c = await collectionDeLaRequete(dep, req);
        return { collection: await vueOuIntrouvable(dep, c.uid, c.id) };
      }),
      routeRag("PATCH", "/api/rag/collections/:collection_id", async (req) => {
        const c = await collectionDeLaRequete(dep, req, { ecriture: true });
        const corps = corpsValide(req, schemaCorpsMajCollectionRag);
        if (corps.chunking !== undefined) verifierRegexRag(...paramsDuDecoupage(corps.chunking));
        const change = await mettreAJourCollectionRag(base, c.uid, c.id, corps);
        let job = null;
        const service = dep.service();
        if ((change.decoupage || change.ocr) && service !== null && ragActif()) {
          if (change.decoupage) job = await service.reindexer(c.uid, c.id);
          if (change.ocr) {
            const echecs = await base.valeurs<[unknown]>(
              "SELECT id FROM rag_documents WHERE collection_id = ? AND status = 'error' AND error_code IN ('no_text', 'ocr_unavailable')",
              [c.id],
            );
            if (echecs.length)
              job =
                (await service.reindexer(c.uid, c.id, {
                  documents: echecs.map(([id]) => String(id)),
                  reextraire: true,
                })) ?? job;
          }
        }
        return { collection: await vueOuIntrouvable(dep, c.uid, c.id), job };
      }),
      routeRag("DELETE", "/api/rag/collections/:collection_id", async (req) => {
        const c = await collectionDeLaRequete(dep, req, { ecriture: true });
        await serviceExige(dep).supprimerCollection(c.uid, c.id);
        return { ok: true };
      }),
      routeRag("PUT", "/api/rag/collections/:collection_id/publication", async (req) => {
        const c = await collectionDeLaRequete(dep, req, { ecriture: true });
        const corps = corpsValide(req, schemaCorpsPublicationRag);
        const [ancien] = await base.valeurs<[unknown]>(
          "SELECT visibility FROM rag_collections WHERE id = ?",
          [c.id],
        );
        const anciensGroupes = await base.valeurs<[unknown]>(
          "SELECT principal_id FROM rag_grants WHERE collection_id = ? AND principal_type = 'group'",
          [c.id],
        );
        const avant = await audiencePublicationRag(
          base,
          c.uid,
          String(ancien?.[0] ?? "private"),
          anciensGroupes.map(([g]) => Number(g)),
        );
        const p = await appliquerPublication(base, c.uid, c.id, corps);
        const apres = await audiencePublicationRag(base, c.uid, p.visibility, p.group_ids);
        const [auteur] = await base.valeurs<[unknown]>("SELECT username FROM users WHERE id = ?", [c.uid]);
        const notified = await prevenirDesPartages(
          dep,
          { uid: c.uid, id: c.id, nom: c.ligne.name, auteur: String(auteur?.[0] ?? "") },
          avant,
          apres,
        );
        return { collection: await vueOuIntrouvable(dep, c.uid, c.id), notified };
      }),
      routeRag("GET", "/api/rag/groupes-publication", async (req) => {
        const uid = utilisateur(req);
        await exigerDroit(base, uid);
        return groupesDePublicationRag(base, uid);
      }),
      routeRag("PUT", "/api/rag/collections/:collection_id/masquage", async (req) => {
        const c = await collectionDeLaRequete(dep, req);
        const corps = corpsValide(req, schemaCorpsMasquageRag);
        if (c.role !== "lecteur")
          throw new ErreurRouteRag(
            400,
            "non_masquable",
            "Vous ne pouvez masquer que les collections partagées avec vous.",
          );
        await masquerCollectionRag(base, c.uid, c.id, corps.hidden);
        return { collection: await vueOuIntrouvable(dep, c.uid, c.id) };
      }),
      ...routesDocumentsRag(dep),
      routeRag("GET", "/api/rag/travaux", async (req) => {
        const uid = utilisateur(req);
        await exigerDroit(base, uid);
        const q = requeteValide(req, schemaRequeteTravauxRag);
        const jobs = await serviceExige(dep).travauxDu(uid, {
          actifs: vrai(q.actifs),
          ...(q.collection_id === undefined ? {} : { collectionId: q.collection_id }),
          ...(q.limite === undefined ? {} : { limite: Number(q.limite) }),
        });
        return { jobs };
      }),
      ...(["suspendre", "reprendre", "annuler"] as const).map((action) =>
        routeRag("POST", `/api/rag/travaux/:job_id/${action}`, async (req) => {
          const uid = utilisateur(req);
          await exigerDroit(base, uid);
          const id = idTravail(req);
          return { job: await serviceExige(dep)[action](uid, id) };
        }),
      ),
      ...routesSourcesRag(dep),
      ...routesDecoupageRag(dep),
      ...routesChatRag(dep),
    ],
  };
}
