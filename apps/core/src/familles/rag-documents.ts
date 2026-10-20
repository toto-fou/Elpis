// SPDX-License-Identifier: MIT
/** apps/core/src/familles/rag-documents.ts — routes RAG des documents d'une collection : liste, dépôt multipart en flux (fichiers tronqués refusés), import depuis le bac, suppression, réindexation. */
import {
  CHEMINS_PAR_IMPORT_RAG_MAX,
  ETATS_DOCUMENT_RAG,
  FICHIERS_PAR_DEPOT_RAG_MAX,
  PAGINATION_DOCUMENTS_RAG_MAX,
  schemaCorpsImportSandboxRag,
  schemaCorpsReindexationRag,
  schemaRequeteDocumentsRag,
} from "@elpis/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Readable } from "node:stream";

import { ragActif } from "../rag/depot";
import { RefusIndexationRag } from "../rag/erreurs-indexation";
import { corpsValide, ErreurRouteRag, idDocument, requeteValide } from "../rag/http";
import { quotasRag } from "../rag/quotas";
import { documentPublic, lireDocument, listerDocumentsRag } from "../rag/travaux";
import type { DocumentRagPublic, TravailRagPublic } from "../rag/travaux";
import type { DefinitionRoute } from "../routes";
import { collectionDeLaRequete, routeRag, serviceExige } from "./rag-aides";
import type { RoutesRagResolues } from "./rag-aides";

const MIO = 1024 * 1024;
/** Enveloppe multipart (en-têtes de parties, frontières) admise en plus des fichiers eux-mêmes. */
const MARGE_CORPS = 16 * MIO;

/** Résultat d'un fichier déposé (contrat `schemaResultatDepotRag`). */
interface ResultatDepotRag {
  name: string;
  status: "ajoute" | "remplace" | "deja_present" | "refuse";
  document?: DocumentRagPublic;
  code?: string;
  message?: string;
}
const PAGE_DEFAUT = 100;

/** Flux d'un fichier du formulaire : refuse une fin tronquée par le plafond du multipart ; une sortie anticipée ne détruit pas la requête. */
export async function* fluxDuFichier(
  fichier: Readable & { truncated?: boolean },
  plafondMo: number,
): AsyncGenerator<Uint8Array> {
  for await (const morceau of fichier.iterator({ destroyOnReturn: false })) yield morceau as Uint8Array;
  if (fichier.truncated === true)
    throw new RefusIndexationRag("fichier_trop_gros", `${plafondMo} Mo au plus.`);
}

/** Lit jusqu'à la fin ce qui reste d'un fichier refusé, pour que le formulaire passe au suivant. */
async function viderFichier(fichier: Readable): Promise<void> {
  if (fichier.readableEnded || fichier.destroyed) return;
  await new Promise<void>((resolve) => {
    fichier.once("end", resolve);
    fichier.once("close", resolve);
    fichier.once("error", () => resolve());
    fichier.resume();
  });
}

function resultat(name: string, e: RefusIndexationRag): ResultatDepotRag {
  return { name, status: "refuse", code: e.code, message: e.message };
}

/** Refus qui condamnent tout le lot (plus rien ne peut être déposé) : l'erreur remplace les résultats par fichier. */
const FATALS = new Set(["rag_desactive", "collection_introuvable", "non_proprietaire"]);

async function travailActif(
  dep: RoutesRagResolues,
  uid: number,
  collectionId: string,
): Promise<TravailRagPublic | null> {
  return (await serviceExige(dep).travauxDu(uid, { actifs: true, collectionId, limite: 1 }))[0] ?? null;
}

async function deposer(dep: RoutesRagResolues, req: FastifyRequest, rep: FastifyReply) {
  const c = await collectionDeLaRequete(dep, req, { ecriture: true });
  const service = serviceExige(dep);
  if (!ragActif())
    throw new ErreurRouteRag(
      503,
      "rag_desactive",
      "Le RAG est désactivé : aucun serveur d'embeddings n'est configuré.",
    );
  if (!req.isMultipart())
    throw new ErreurRouteRag(400, "multipart_attendu", "Envoyez les fichiers en multipart/form-data.");
  const quotas = await quotasRag(dep.base, c.uid);
  const plafondMo = quotas.file_mb;
  // Un dépôt ne dépasse jamais le stockage du compte : au-delà, refusé d'emblée, ou coupé en cours d'envoi.
  const plafondCorps = Math.max(quotas.file_mb, quotas.storage_mb) * MIO + MARGE_CORPS;
  const annonce = Number(req.headers["content-length"]);
  if (Number.isFinite(annonce) && annonce > plafondCorps)
    throw new ErreurRouteRag(
      413,
      "depot_trop_gros",
      `Envoi trop volumineux : ${Math.max(quotas.file_mb, quotas.storage_mb)} Mo au plus par dépôt.`,
    );
  const abandon = new AbortController();
  rep.raw.once("close", () => {
    if (!rep.raw.writableFinished) abandon.abort();
  });
  const socket = req.raw.socket as { bytesRead?: unknown } | undefined;
  const lus = (): number => (typeof socket?.bytesRead === "number" ? socket.bytesRead : 0);
  const lusAvant = lus();
  const garde = setInterval(() => {
    if (lus() - lusAvant <= plafondCorps) return;
    abandon.abort();
    req.raw.destroy();
  }, 200);
  const resultats: ResultatDepotRag[] = [];
  let travail: TravailRagPublic | null = null;
  let recus = 0;
  try {
    const parts = req.parts({
      limits: { fileSize: plafondMo * MIO + 1 },
      throwFileSizeLimit: false,
    } as Parameters<FastifyRequest["parts"]>[0]);
    for await (const part of parts) {
      if (part.type !== "file") continue;
      recus++;
      const nom = part.filename;
      try {
        const r = await service.deposer(
          c.uid,
          c.id,
          {
            nom,
            flux: fluxDuFichier(part.file as Readable & { truncated?: boolean }, plafondMo),
            dossier: true,
          },
          abandon.signal,
        );
        resultats.push({ name: nom, status: r.statut, document: r.document });
        if (r.travail !== null) travail = r.travail;
      } catch (e) {
        if (!(e instanceof RefusIndexationRag) || abandon.signal.aborted || FATALS.has(e.code)) throw e;
        resultats.push(resultat(nom, e));
      } finally {
        await viderFichier(part.file);
      }
    }
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (code === "FST_FILES_LIMIT")
      resultats.push({
        name: "…",
        status: "refuse",
        code: "trop_de_fichiers",
        message: `${FICHIERS_PAR_DEPOT_RAG_MAX} fichiers au plus par dépôt : envoyez les suivants dans un autre dépôt.`,
      });
    else if (e instanceof RefusIndexationRag || e instanceof ErreurRouteRag || abandon.signal.aborted)
      throw e;
    else if (typeof code === "string" && code.startsWith("FST_"))
      throw new ErreurRouteRag(400, "requete_invalide", "Envoi multipart illisible.");
    else throw e;
  } finally {
    clearInterval(garde);
  }
  if (recus === 0 && resultats.length === 0)
    throw new ErreurRouteRag(400, "aucun_fichier", "Aucun fichier dans l'envoi.");
  return { results: resultats, job: travail ?? (await travailActif(dep, c.uid, c.id)) };
}

export function routesDocumentsRag(dep: RoutesRagResolues): DefinitionRoute[] {
  const base = dep.base;
  return [
    routeRag("GET", "/api/rag/collections/:collection_id/documents", async (req) => {
      const c = await collectionDeLaRequete(dep, req);
      const q = requeteValide(req, schemaRequeteDocumentsRag);
      const etats = q.status === undefined ? undefined : q.status.split(",").filter((s) => s !== "");
      if (etats?.some((s) => !(ETATS_DOCUMENT_RAG as readonly string[]).includes(s)))
        throw new ErreurRouteRag(
          400,
          "requete_invalide",
          "Requête invalide : le champ « status » est incorrect.",
        );
      const limit = Math.min(PAGINATION_DOCUMENTS_RAG_MAX, Math.max(1, Number(q.limit ?? PAGE_DEFAUT)));
      const offset = Number(q.offset ?? 0);
      const { lignes, total } = await listerDocumentsRag(base, c.id, {
        q: q.q,
        etats,
        tri: q.tri,
        offset,
        limite: limit,
      });
      return { documents: lignes.map(documentPublic), total, offset, limit };
    }),
    routeRag("POST", "/api/rag/collections/:collection_id/documents", (req, rep) => deposer(dep, req, rep)),
    routeRag("GET", "/api/rag/collections/:collection_id/documents/:doc_id", async (req) => {
      const c = await collectionDeLaRequete(dep, req);
      const doc = await lireDocument(base, idDocument(req));
      if (doc === null || doc.collection_id !== c.id)
        throw new ErreurRouteRag(404, "document_introuvable", "Document introuvable.");
      return { document: documentPublic(doc) };
    }),
    routeRag("POST", "/api/rag/collections/:collection_id/import-sandbox", async (req, rep) => {
      const c = await collectionDeLaRequete(dep, req, { ecriture: true });
      const corps = corpsValide(req, schemaCorpsImportSandboxRag);
      if (corps.paths.length > CHEMINS_PAR_IMPORT_RAG_MAX) throw new RefusIndexationRag("trop_de_fichiers");
      const abandon = new AbortController();
      rep.raw.once("close", () => {
        if (!rep.raw.writableFinished) abandon.abort();
      });
      const service = serviceExige(dep);
      const bruts = await service.importerDepuisSandbox(c.uid, c.id, corps.paths, abandon.signal);
      const results: ResultatDepotRag[] = bruts.map((r) => ({
        name: r.chemin,
        status: r.statut,
        ...(r.document === undefined ? {} : { document: r.document }),
        ...(r.code === undefined ? {} : { code: r.code }),
        ...(r.message === undefined ? {} : { message: r.message }),
      }));
      return { results, job: await travailActif(dep, c.uid, c.id) };
    }),
    routeRag("DELETE", "/api/rag/collections/:collection_id/documents/:doc_id", async (req) => {
      const c = await collectionDeLaRequete(dep, req, { ecriture: true });
      await serviceExige(dep).supprimerDocument(c.uid, c.id, idDocument(req));
      return { ok: true };
    }),
    routeRag("POST", "/api/rag/collections/:collection_id/vider", async (req) => {
      const c = await collectionDeLaRequete(dep, req, { ecriture: true });
      const service = serviceExige(dep);
      const ids = await base.valeurs<[unknown]>(
        "SELECT id FROM rag_documents WHERE collection_id = ? ORDER BY created_at, id",
        [c.id],
      );
      let deleted = 0;
      for (const [id] of ids)
        try {
          await service.supprimerDocument(c.uid, c.id, String(id));
          deleted++;
        } catch (e) {
          if (!(e instanceof RefusIndexationRag && e.code === "document_introuvable")) throw e;
        }
      return { ok: true, deleted };
    }),
    routeRag("POST", "/api/rag/collections/:collection_id/reindexer", async (req) => {
      const c = await collectionDeLaRequete(dep, req, { ecriture: true });
      const corps = corpsValide(req, schemaCorpsReindexationRag);
      const job = await serviceExige(dep).reindexer(c.uid, c.id, {
        documents: corps.documents,
        force: corps.force,
      });
      return { job };
    }),
  ];
}
