// SPDX-License-Identifier: MIT
/** apps/core/src/familles/secrets.ts — coffre « Secrets » : routes du compte (`/api/secrets*`, main), secrets d'instance de la console (`/api/admin/secrets*`, admin), résolution pour l'hôte d'outils (`/api/internal/secrets/resolve`, jeton de service et enveloppe signée) ; une valeur ne sort que vers l'hôte d'outils. */
import {
  schemaCorpsCreationSecret,
  schemaCorpsMajSecret,
  schemaCorpsResolutionSecret,
  schemaCorpsRotationSecret,
} from "@elpis/contracts";
import { HttpError } from "@elpis/commun";
import type { Base } from "@elpis/db";
import { corpsJson } from "@elpis/http";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodType } from "zod";

import { ipDeRequete } from "../journal-securite/auditer";
import type { DefinitionRoute, Famille, Traitement } from "../routes";
import { ErreurSecret, refusDeCle } from "../secrets/erreurs";
import {
  creerSecret,
  listerSecrets,
  modifierSecret,
  rotation,
  supprimerSecret,
  verifierSecret,
} from "../secrets/stockage";
import type { Acteur, Proprietaire } from "../secrets/stockage";
import { lireSecretPourUsage } from "../secrets/usage";
import { utilisateur } from "./comptes";
import { compteSigne } from "./interne-toolhost";
import type { DependancesInterne } from "./interne-toolhost";

export interface DependancesSecrets {
  readonly base: Base;
  readonly auth: DependancesInterne["auth"];
}

/** Corps validé par le contrat ; le message ne cite que le champ fautif, jamais une valeur reçue. */
function corpsValide<T>(req: FastifyRequest, schema: ZodType<T>): T {
  let brut: unknown;
  try {
    brut = corpsJson(req);
  } catch (e) {
    if (e instanceof HttpError) throw new ErreurSecret(400, "secret_request_invalid", "Invalid JSON body.");
    throw e;
  }
  const r = schema.safeParse(brut);
  if (r.success) return r.data;
  const champ = r.error.issues[0]?.path.map(String).join(".") ?? "";
  throw new ErreurSecret(
    400,
    "secret_request_invalid",
    champ ? `Invalid request: field '${champ}' is incorrect.` : "Invalid request.",
  );
}

/** Identifiant du chemin ; une forme invalide ressemble à un secret inconnu. */
function idSecret(req: FastifyRequest): number {
  const brut = (req.params as Record<string, unknown> | undefined)?.["secret_id"];
  const id = typeof brut === "string" && /^[1-9]\d{0,15}$/u.test(brut) ? Number(brut) : 0;
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new ErreurSecret(404, "secret_unknown", "Secret not found.");
  return id;
}

function acteurDe(req: FastifyRequest): Acteur {
  return {
    userId: req.utilisateur?.id ?? null,
    username: req.utilisateur?.username ?? null,
    ip: ipDeRequete(req),
  };
}

/** Refus du coffre rendus `{detail, code}` avec leur statut ; le reste remonte. */
function avecErreurs(traiter: Traitement): Traitement {
  return async (req: FastifyRequest, rep: FastifyReply) => {
    try {
      return await traiter(req, rep);
    } catch (e) {
      const r = refusDeCle(e);
      if (r === null || rep.sent) throw e;
      return rep.code(r.statut).send({ detail: r.message, code: r.code });
    }
  };
}

function route(
  methode: DefinitionRoute["methode"],
  chemin: string,
  acces: "session" | "admin" | "service",
  traiter: Traitement,
): DefinitionRoute {
  return {
    methode,
    chemin,
    processus: acces === "admin" ? ["admin"] : ["main"],
    acces,
    traiter: avecErreurs(traiter),
  };
}

/** Routes d'un propriétaire : le compte de la session, ou l'instance (`null`) pour la console. */
function routesProprietaire(
  base: Base,
  prefixe: string,
  acces: "session" | "admin",
  proprietaire: (req: FastifyRequest) => Proprietaire,
): DefinitionRoute[] {
  return [
    route("GET", prefixe, acces, async (req) => ({ secrets: await listerSecrets(base, proprietaire(req)) })),
    route("POST", `${prefixe}/:secret_id/rotate`, acces, async (req) => {
      const p = proprietaire(req);
      const { value } = corpsValide(req, schemaCorpsRotationSecret);
      return { secret: await rotation(base, p, idSecret(req), value, acteurDe(req)) };
    }),
    route("DELETE", `${prefixe}/:secret_id`, acces, async (req) => {
      await supprimerSecret(base, proprietaire(req), idSecret(req), acteurDe(req));
      return { ok: true };
    }),
  ];
}

/** Conversation de la résolution : celle de l'enveloppe signée ; celle du corps seulement si l'enveloppe n'en porte pas, refusée si elle diffère. */
function conversation(signee: string, corps: string | null | undefined): string | null {
  if (!signee) return corps || null;
  if (corps && corps !== signee)
    throw new ErreurSecret(400, "secret_request_invalid", "chat_id does not match the signed identity.");
  return signee;
}

export function creerFamilleSecrets(dep: DependancesSecrets): Famille {
  const base = dep.base;
  return {
    nom: "secrets",
    routes: [
      ...routesProprietaire(base, "/api/secrets", "session", utilisateur),
      route("POST", "/api/secrets", "session", async (req) => {
        const uid = utilisateur(req);
        const corps = corpsValide(req, schemaCorpsCreationSecret);
        return { secret: await creerSecret(base, uid, corps, acteurDe(req)) };
      }),
      route("PUT", "/api/secrets/:secret_id", "session", async (req) => {
        const uid = utilisateur(req);
        const corps = corpsValide(req, schemaCorpsMajSecret);
        return { secret: await modifierSecret(base, uid, idSecret(req), corps, acteurDe(req)) };
      }),
      route("POST", "/api/secrets/:secret_id/verify", "session", async (req) => {
        const uid = utilisateur(req);
        return { secret: await verifierSecret(base, uid, idSecret(req), acteurDe(req)) };
      }),
      ...routesProprietaire(base, "/api/admin/secrets", "admin", () => null),
      route("POST", "/api/internal/secrets/resolve", "service", async (req, rep) => {
        const { uid, username, identite } = await compteSigne(dep, req);
        const corps = corpsValide(req, schemaCorpsResolutionSecret);
        const r = await lireSecretPourUsage(
          base,
          { usage: corps.usage, cible: corps.origin, nom: corps.name ?? null },
          {
            proprietaire: uid,
            acteur: { userId: uid, username, ip: null },
            chatId: conversation(identite.chat_id, corps.chat_id),
            run: corps.run ?? null,
            sousAgent: identite.subagent !== undefined && identite.subagent !== null,
          },
        );
        rep.header("cache-control", "no-store");
        return { name: r.name, username: r.username, secret: r.secret, tls: r.tls, version: r.version };
      }),
    ],
  };
}
