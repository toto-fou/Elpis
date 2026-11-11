// SPDX-License-Identifier: MIT
/** apps/core/src/familles/secrets.ts — coffre « Secrets » : routes du compte (`/api/secrets*`, main), secrets attachés à une conversation (`/api/chats/:chat_id/secrets`), secrets d'instance de la console (`/api/admin/secrets*`, admin), résolution, recherche sans valeur, déclencheur d'une session sécurisée et reprise des anciens identifiants AX pour l'hôte d'outils (`/api/internal/secrets/*`, jeton de service et enveloppe signée) ; une valeur ne sort que vers l'hôte d'outils. */
import {
  schemaCorpsCreationSecret,
  schemaCorpsDeclencheurSecret,
  schemaCorpsImportAx,
  schemaCorpsMajSecret,
  schemaCorpsResolutionSecret,
  schemaCorpsRotationSecret,
  schemaCorpsSecretsApplicables,
  schemaCorpsSecretsChat,
} from "@elpis/contracts";
import { HttpError } from "@elpis/commun";
import type { Identity } from "@elpis/securite";
import type { Base } from "@elpis/db";
import { corpsJson } from "@elpis/http";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodType } from "zod";

import { ipDeRequete } from "../journal-securite/auditer";
import type { DefinitionRoute, Famille, Traitement } from "../routes";
import {
  conversationRacine,
  detacherSurDeclencheur,
  remplacerSecretsAttaches,
  secretsAttaches,
} from "../secrets/attache";
import { ErreurSecret, refusDeCle } from "../secrets/erreurs";
import { importerLignesAx } from "../secrets/import-ax";
import {
  creerSecret,
  listerSecrets,
  modifierSecret,
  rotation,
  supprimerSecret,
  verifierSecret,
} from "../secrets/stockage";
import type { Acteur, Proprietaire } from "../secrets/stockage";
import { lireSecretPourUsage, secretsApplicables } from "../secrets/usage";
import type { ContexteUsage } from "../secrets/usage";
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

/** Acteur journalisé d'une requête : compte de la session et adresse du client. */
export function acteurDe(req: FastifyRequest): Acteur {
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

/** Conversation d'un appel d'outil : celle de l'enveloppe signée seulement (sans elle, aucune ; le coffre refuse) ; un `chat_id` du corps doit lui être égal. */
function conversation(signee: string, corps: string | null | undefined): string | null {
  if (corps && corps !== signee)
    throw new ErreurSecret(400, "secret_request_invalid", "chat_id does not match the signed identity.");
  return signee || null;
}

/** Contexte d'un appel de l'hôte d'outils : compte et conversation signés, attachement exigé ; sous-agent par l'enveloppe (le coffre le tire aussi de la conversation `racine#task-…`, et le run de routine de sa clé). */
function contexteHote(
  uid: number,
  username: string,
  identite: Identity,
  chatCorps?: string | null,
  run?: string | null,
): ContexteUsage {
  return {
    proprietaire: uid,
    acteur: { userId: uid, username, ip: null },
    exigeAttachement: true,
    chatId: conversation(identite.chat_id, chatCorps),
    run: run ?? null,
    sousAgent: identite.subagent !== undefined && identite.subagent !== null,
  };
}

/** Conversation du chemin ; une forme vide ou d'un sous-agent ressemble à une conversation inconnue. */
function chatDuChemin(req: FastifyRequest): string {
  const brut = (req.params as Record<string, unknown> | undefined)?.["chat_id"];
  const id = typeof brut === "string" ? brut : "";
  if (!id || id.length > 200 || conversationRacine(id) !== id) throw new HttpError(404, "chat not found");
  return id;
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
      route("GET", "/api/chats/:chat_id/secrets", "session", async (req) => {
        const secrets = await secretsAttaches(base, utilisateur(req), chatDuChemin(req));
        if (secrets === null) throw new HttpError(404, "chat not found");
        return { secrets };
      }),
      route("PUT", "/api/chats/:chat_id/secrets", "session", async (req) => {
        const uid = utilisateur(req);
        const chatId = chatDuChemin(req);
        const { ids } = corpsValide(req, schemaCorpsSecretsChat);
        const secrets = await remplacerSecretsAttaches(base, uid, chatId, ids, acteurDe(req), {
          strict: true,
        });
        if (secrets === null) throw new HttpError(404, "chat not found");
        return { secrets };
      }),
      ...routesProprietaire(base, "/api/admin/secrets", "admin", () => null),
      route("POST", "/api/internal/secrets/resolve", "service", async (req, rep) => {
        const { uid, username, identite } = await compteSigne(dep, req);
        const corps = corpsValide(req, schemaCorpsResolutionSecret);
        const r = await lireSecretPourUsage(
          base,
          { usage: corps.usage, cible: corps.origin, nom: corps.name ?? null },
          contexteHote(uid, username, identite, corps.chat_id, corps.run),
        );
        rep.header("cache-control", "no-store");
        return { name: r.name, username: r.username, secret: r.secret, tls: r.tls, version: r.version };
      }),
      route("POST", "/api/internal/secrets/match", "service", async (req) => {
        const { uid, username, identite } = await compteSigne(dep, req);
        const corps = corpsValide(req, schemaCorpsSecretsApplicables);
        const nom = corps.name?.trim() || null;
        return {
          secrets: await secretsApplicables(base, corps.origin, nom, contexteHote(uid, username, identite)),
        };
      }),
      route("POST", "/api/internal/secrets/tripwire", "service", async (req) => {
        const { uid, username, identite } = await compteSigne(dep, req);
        const { name } = corpsValide(req, schemaCorpsDeclencheurSecret);
        const detached = await detacherSurDeclencheur(base, uid, identite, name.trim(), {
          userId: uid,
          username,
          ip: null,
        });
        return { ok: true, detached };
      }),
      route("POST", "/api/internal/secrets/import-ax", "service", async (req) => {
        const { uid, username } = await compteSigne(dep, req);
        const { rows } = corpsValide(req, schemaCorpsImportAx);
        const results = await importerLignesAx(
          base,
          uid,
          rows,
          { userId: uid, username, ip: null },
          "toolhost",
        );
        return { ok: true, results };
      }),
    ],
  };
}
