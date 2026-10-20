// SPDX-License-Identifier: MIT
/** apps/core/src/rag/http.ts — aides HTTP des routes RAG : erreurs `{detail, code}`, validation zod, droit RAG du compte, identifiants de chemin. */
import { HttpError } from "@elpis/commun";
import { corpsJson } from "@elpis/http";
import { ErreurRag } from "@elpis/rag";
import type { Executeur } from "@elpis/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodType } from "zod";

import { droitRag, RefusRag } from "./acces";
import { RefusIndexationRag } from "./erreurs-indexation";
import { estUuidRag } from "./magasin";

/** Refus d'une route RAG : statut HTTP, code stable et message lisible en français (sans détail interne). */
export class ErreurRouteRag extends Error {
  override name = "ErreurRouteRag";
  readonly statut: number;
  readonly code: string;
  constructor(statut: number, code: string, message: string) {
    super(message);
    this.statut = statut;
    this.code = code;
  }
}

export const MESSAGE_LECTURE_SEULE = "Collection en lecture seule : seul son propriétaire peut la modifier.";
export const MESSAGE_SOURCES_FERMEES =
  "Le propriétaire n'a pas ouvert les documents sources de cette collection.";

/** Corps d'erreur commun des routes RAG. */
export function corpsErreur(code: string, detail: string): { detail: string; code: string } {
  return { detail, code };
}

/** Message court du premier défaut d'un schéma zod : le chemin du champ, jamais la valeur reçue. */
function messageValidation(e: { issues: readonly { path: readonly PropertyKey[] }[] }): string {
  const chemin = e.issues[0]?.path.map(String).join(".") ?? "";
  return chemin === "" ? "Requête invalide." : `Requête invalide : le champ « ${chemin} » est incorrect.`;
}

/** Valeur validée par le schéma, sinon 400 `requete_invalide`. */
export function analyser<T>(schema: ZodType<T>, valeur: unknown): T {
  const r = schema.safeParse(valeur);
  if (!r.success) throw new ErreurRouteRag(400, "requete_invalide", messageValidation(r.error));
  return r.data;
}

/** Corps JSON de la requête validé par `schema` ; un corps illisible ou absent donne 400 `requete_invalide`. */
export function corpsValide<T>(req: FastifyRequest, schema: ZodType<T>): T {
  let brut: unknown;
  try {
    brut = corpsJson(req);
  } catch (e) {
    if (e instanceof HttpError) throw new ErreurRouteRag(400, "requete_invalide", "Corps JSON invalide.");
    throw e;
  }
  return analyser(schema, brut);
}

/** Chaîne de requête validée par `schema` (valeurs en texte). */
export function requeteValide<T>(req: FastifyRequest, schema: ZodType<T>): T {
  return analyser(schema, req.query);
}

/** Paramètre de chemin ; absent ou autre chose qu'un texte : chaîne vide (aucun identifiant ne l'accepte). */
export function parametre(req: FastifyRequest, nom: string): string {
  const v = (req.params as Record<string, unknown> | undefined)?.[nom];
  return typeof v === "string" ? v : "";
}

/** Identifiant de collection du chemin ; une forme invalide ressemble à une collection inconnue (404). */
export function idCollection(req: FastifyRequest): string {
  const id = parametre(req, "collection_id");
  if (!estUuidRag(id)) throw new ErreurRouteRag(404, "collection_introuvable", "Collection introuvable.");
  return id;
}

export function idDocument(req: FastifyRequest): string {
  const id = parametre(req, "doc_id");
  if (!estUuidRag(id)) throw new ErreurRouteRag(404, "document_introuvable", "Document introuvable.");
  return id;
}

export function idTravail(req: FastifyRequest): string {
  const id = parametre(req, "job_id");
  if (!estUuidRag(id))
    throw new ErreurRouteRag(404, "travail_introuvable", "Travail d'indexation introuvable.");
  return id;
}

/** Le compte a le droit RAG, sinon 403 `rag_interdit` (rendu avant toute recherche d'une collection). */
export async function exigerDroit(x: Executeur, uid: number): Promise<void> {
  if (!(await droitRag(x, uid)))
    throw new ErreurRouteRag(403, "rag_interdit", "Le RAG n'est pas ouvert à votre compte.");
}

/** Refus de route qui répond à un code d'erreur du moteur (`ErreurRag`) : service en panne, jamais de détail interne. */
export function erreurDeCodeRag(code: string): ErreurRouteRag {
  if (code.startsWith("qdrant_") || code === "collection_absente")
    return new ErreurRouteRag(
      503,
      "qdrant_indisponible",
      "La base vectorielle est momentanément indisponible.",
    );
  if (code.startsWith("embeddings_"))
    return new ErreurRouteRag(
      503,
      "embeddings_indisponibles",
      "Le serveur d'embeddings est momentanément indisponible.",
    );
  return new ErreurRouteRag(503, "recherche_impossible", "La recherche n'a pas pu aboutir.");
}

/** Erreur d'un module RAG rendue en réponse `{detail, code}` ; `null` si elle n'est pas de ce domaine (panne à laisser monter). */
export function reponseDErreur(
  e: unknown,
): { statut: number; corps: { detail: string; code: string } } | null {
  if (e instanceof ErreurRouteRag) return { statut: e.statut, corps: corpsErreur(e.code, e.message) };
  if (e instanceof RefusRag) return { statut: e.statut, corps: corpsErreur(e.code, e.message) };
  if (e instanceof RefusIndexationRag) {
    if (e.code === "non_proprietaire")
      return { statut: 403, corps: corpsErreur("lecture_seule", MESSAGE_LECTURE_SEULE) };
    return { statut: e.statut, corps: corpsErreur(e.code, e.message) };
  }
  if (e instanceof ErreurRag) {
    const r = erreurDeCodeRag(e.code);
    return { statut: r.statut, corps: corpsErreur(r.code, r.message) };
  }
  return null;
}

export type TraitementRag = (req: FastifyRequest, rep: FastifyReply) => unknown;

/** Enveloppe d'une route RAG : les refus du domaine deviennent `{detail, code}` avec leur statut, le reste remonte. */
export function avecErreursRag(traiter: TraitementRag): TraitementRag {
  return async (req, rep) => {
    try {
      return await traiter(req, rep);
    } catch (e) {
      const r = reponseDErreur(e);
      if (r === null || rep.sent) throw e;
      return rep.code(r.statut).send(r.corps);
    }
  };
}
