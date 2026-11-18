// SPDX-License-Identifier: MIT
/** apps/core/src/familles/chat.ts — génération d'un tour de chat en flux NDJSON : ouverture commune au tour « Images » et au réveilleur des jobs (`tour/ouverture.ts`), puis le tour (chatbot_app/routes/chats.py). */
import { revaliderFlux } from "@elpis/auth";
import type { DependancesAuth } from "@elpis/auth";
import { estDict, HttpError, pyJsonLoads, texteJsonPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { DefinitionRoute, Famille } from "../routes";
import { runTurn } from "../tour/execution";
import { ligneNdjson } from "../tour/ndjson";
import { imageTurn } from "../tour/image";
import { admettreTour, ouvrirTour } from "../tour/ouverture";
import type { DependancesOuverture } from "../tour/ouverture";
import { utilisateur } from "./comptes";
import { ouvrirFlux } from "@elpis/http";

export { admettreTour, ouvrirTour } from "../tour/ouverture";
export type { TourOuvert } from "../tour/ouverture";

export const REVALIDATION_CHAT_MS = 60_000;

export interface DependancesChat extends DependancesOuverture {
  readonly auth?: DependancesAuth;
  readonly revalidationMs?: number;
  readonly arret?: AbortSignal | undefined;
}

/** Corps JSON du tour : vide = `{}` ; illisible ou pas un objet → 400 `invalid_json`. */
export function corpsDuTour(octets: Uint8Array): Dict {
  let data: unknown;
  try {
    data = octets.length ? pyJsonLoads(texteJsonPy(octets)) : {};
  } catch {
    throw new HttpError(400, "invalid_json");
  }
  if (!estDict(data)) throw new HttpError(400, "invalid_json");
  return data;
}

async function streamer(dep: DependancesChat, req: FastifyRequest, rep: FastifyReply): Promise<void> {
  const uid = utilisateur(req);
  const data = corpsDuTour(req.corpsBrut);
  if (data["image_gen"] !== null && data["image_gen"] !== undefined)
    return imageTurn(dep, rep, data, uid, await admettreTour(dep, uid, data));
  const tour = await ouvrirTour(dep, uid, data);
  const sortie = ouvrirFlux(rep, { "content-type": "application/x-ndjson; charset=utf-8" }, dep.arret);
  const coupure = new AbortController();
  const arretSurveillance = surveillerSession(dep, uid, req, async () => {
    await sortie.ecrire(ligneNdjson({ type: "session_expired" }));
    coupure.abort();
  });
  try {
    const signal = AbortSignal.any([sortie.signal, coupure.signal]);
    for await (const ev of runTurn({ base: dep.base }, tour.plan, tour.res, tour.base, signal))
      await sortie.ecrire(ligneNdjson(ev));
  } finally {
    arretSurveillance();
    sortie.fermer();
  }
}

/** Revalide la session toutes les `revalidationMs` ; session perdue → `surPerte` une fois ; panne transitoire = flux gardé ; renvoie l'arrêt de la minuterie. */
export function surveillerSession(
  dep: DependancesChat,
  uid: number,
  req: FastifyRequest,
  surPerte: () => Promise<void>,
): () => void {
  const auth = dep.auth;
  if (!auth) return () => undefined;
  const loginTs = req.session.get("_login_ts");
  const sid = req.session.get("_sid");
  let enCours = false;
  let fini = false;
  const minuterie = setInterval(() => {
    if (enCours || fini) return;
    enCours = true;
    void (async () => {
      try {
        if (await revaliderFlux(auth, uid, loginTs, sid)) return;
      } catch {
        return;
      } finally {
        enCours = false;
      }
      fini = true;
      clearInterval(minuterie);
      await surPerte().catch(() => undefined);
    })();
  }, dep.revalidationMs ?? REVALIDATION_CHAT_MS);
  minuterie.unref();
  return () => {
    fini = true;
    clearInterval(minuterie);
  };
}

export function creerFamilleChat(dep: DependancesChat): Famille {
  const route: DefinitionRoute = {
    methode: "POST",
    chemin: "/api/chat-saved-stream3",
    processus: ["main"],
    acces: "session",
    traiter: (req, rep) => streamer(dep, req, rep),
  };
  return { nom: "chat", routes: [route] };
}
