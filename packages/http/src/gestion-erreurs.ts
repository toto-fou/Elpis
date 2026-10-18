// SPDX-License-Identifier: MIT
/** packages/http/src/gestion-erreurs.ts — erreurs vers réponses : `{"detail"}`, 422, 400 (dont l'OverflowError de server/app.py), et 500 en texte brut comme Starlette. */
import { estErreurPython, reprPy } from "@elpis/commun";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { Journal } from "./journal";
import { ENTETES_SECURITE } from "./entetes";
import { ErreurValidation, HttpError } from "./erreurs";
import { routeIntrouvable } from "./routeur-starlette";

// Seuls ces errno décrivent une entrée que le système de fichiers refuse : le reste est une panne (500).
const CODES_ENTREE_INVALIDE = new Set(["ENAMETOOLONG", "ELOOP", "EINVAL", "EILSEQ"]);
const ENTETES_GARDES = new Set(ENTETES_SECURITE.map(([nom]) => nom));

function champ(erreur: unknown, nom: "code" | "statusCode" | "message"): unknown {
  return erreur !== null && typeof erreur === "object" ? (erreur as Record<string, unknown>)[nom] : undefined;
}

/** Une réponse d'erreur repart de zéro comme sous Starlette : seuls restent les en-têtes de sécurité et de CORS. */
function viderEntetes(reponse: FastifyReply): void {
  for (const nom of Object.keys(reponse.getHeaders())) {
    if (!ENTETES_GARDES.has(nom) && !nom.startsWith("access-control-") && nom !== "vary")
      reponse.removeHeader(nom);
  }
}

/** Chemin de la requête sans sa chaîne de requête : un paramètre (jeton…) n'entre jamais au journal. */
export function cheminJournal(requete: FastifyRequest): string {
  const i = requete.url.indexOf("?");
  return i < 0 ? requete.url : requete.url.slice(0, i);
}

/** Exception inattendue d'une requête (le 500 de ServerErrorMiddleware), lue par le journal d'accès. */
export const erreursInattendues = new WeakMap<FastifyRequest, unknown>();

/** Réponse d'un chemin sans route (défaut : routeur Starlette). */
export type Introuvable = (requete: FastifyRequest, reponse: FastifyReply) => FastifyReply;

export function installerGestionErreurs(
  app: FastifyInstance,
  journal: Journal,
  introuvable: Introuvable = routeIntrouvable,
): void {
  app.setNotFoundHandler((requete: FastifyRequest, reponse: FastifyReply) => {
    void introuvable(requete, reponse);
  });

  app.setErrorHandler((erreur: unknown, requete: FastifyRequest, reponse: FastifyReply) => {
    viderEntetes(reponse);
    if (erreur instanceof HttpError && erreur.statusCode >= 400 && erreur.statusCode <= 599) {
      if (erreur.entetes) void reponse.headers(erreur.entetes);
      return reponse.code(erreur.statusCode).send({ detail: erreur.detail });
    }
    if (erreur instanceof ErreurValidation) return reponse.code(422).send({ detail: erreur.erreurs });
    if (estErreurPython(erreur, "OverflowError")) {
      journal.warn(
        `[400] paramètre hors bornes sur ${cheminJournal(requete)} : OverflowError(${reprPy(erreur.message)})`,
      );
      return reponse.code(400).send({ detail: "Paramètre hors bornes." });
    }
    const code = champ(erreur, "code");
    const statut = champ(erreur, "statusCode");
    const message = String(champ(erreur, "message") ?? "");
    if (typeof code === "string" && CODES_ENTREE_INVALIDE.has(code)) {
      journal.warn(`[400] chemin inutilisable sur ${cheminJournal(requete)} : ${message}`);
      return reponse.code(400).send({ detail: "Chemin ou nom de fichier invalide." });
    }
    if (
      typeof code === "string" &&
      code.startsWith("FST_") &&
      typeof statut === "number" &&
      statut >= 400 &&
      statut < 500
    ) {
      return reponse.code(statut).send({ detail: message });
    }
    erreursInattendues.set(requete, erreur);
    journal.error({ err: erreur }, `500 sur ${requete.method} ${cheminJournal(requete)}`);
    return reponse.code(500).type("text/plain; charset=utf-8").send("Internal Server Error");
  });
}
