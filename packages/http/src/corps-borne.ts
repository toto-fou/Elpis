// SPDX-License-Identifier: MIT
/** packages/http/src/corps-borne.ts — corps lu en flux avant tout analyseur, borné, après les contrôles que Python fait avant de le lire. */
import { Readable } from "node:stream";

import { HttpError } from "@elpis/commun";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export interface Borne {
  readonly limite: number;
  readonly message?: string;
  /** Contrôles faits avant toute lecture ; `false` : corps ignoré, longueur annoncée comprise (la réponse se décide sans lui). */
  readonly avant?: (
    requete: FastifyRequest,
    reponse: FastifyReply,
  ) => Promise<boolean | void> | boolean | void;
}

const lus = new WeakMap<FastifyRequest, Buffer>();

/** Octets reçus tels quels, multipart compris ; hors crochet, le corps lu par l'analyseur commun. */
export function corpsLu(requete: FastifyRequest): Buffer {
  return lus.get(requete) ?? requete.corpsBrut;
}

/** Flux rendu à Fastify ; `recu` = octets annoncés quand le corps est ignoré (ils seront jetés, pas lus). */
function fluxDe(octets: Buffer, recu = octets.length): Readable {
  const flux = Readable.from([octets], { objectMode: false }) as Readable & {
    receivedEncodedLength?: number;
  };
  flux.receivedEncodedLength = recu;
  return flux;
}

/** Crochet `preParsing` d'une borne : contrôles `avant`, longueur annoncée trop grande refusée sans lecture, flux coupé dès la limite dépassée. */
export function crochetBorne(
  borne: Borne,
): (requete: FastifyRequest, reponse: FastifyReply, charge: AsyncIterable<unknown>) => Promise<Readable> {
  return async (requete, reponse, charge) => {
    const brute = requete.headers["content-length"];
    const annonce = brute !== undefined && /^\d+$/u.test(brute) ? Number(brute) : null;
    if ((await borne.avant?.(requete, reponse)) === false) {
      lus.set(requete, Buffer.alloc(0));
      delete requete.headers["content-length"];
      return fluxDe(Buffer.alloc(0), annonce ?? 0);
    }
    const trop = (): HttpError => new HttpError(413, borne.message ?? "Corps trop volumineux.");
    if (annonce !== null && annonce > borne.limite) throw trop();
    const morceaux: Buffer[] = [];
    let total = 0;
    for await (const m of charge) {
      const octets = Buffer.isBuffer(m) ? m : Buffer.from(m as string);
      total += octets.length;
      if (total > borne.limite) throw trop();
      morceaux.push(octets);
    }
    const tout = Buffer.concat(morceaux);
    lus.set(requete, tout);
    return fluxDe(tout);
  };
}

/** Crochet `preParsing` d'un contexte de famille : la borne choisie par requête (`null` : corps laissé à l'analyseur commun). */
export function installerCorpsBorne(
  app: FastifyInstance,
  choisir: (requete: FastifyRequest) => Borne | null,
): void {
  app.addHook("preParsing", async (requete, reponse, charge) => {
    const borne = choisir(requete);
    return borne === null ? charge : crochetBorne(borne)(requete, reponse, charge);
  });
}
