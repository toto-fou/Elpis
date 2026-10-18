// SPDX-License-Identifier: MIT
/** packages/auth/src/installer.ts — crochets Fastify : CSRF puis session à l'entrée, cookie réémis ou effacé à la sortie (comme Starlette). */
import { HttpError } from "@elpis/commun";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enteteCookie, enteteEffacement, lireSession, signerSession, valeurCookie } from "./cookie";
import { estInterSite, METHODES_MUTANTES, PREFIXES_EXEMPTES_CSRF } from "./csrf";
import { maintenant } from "./garde";
import type { DependancesAuth } from "./garde";
import { Session } from "./session";

function ajouterVary(reponse: FastifyReply): void {
  const avant = String(reponse.getHeader("vary") ?? "");
  const valeurs = avant
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (!valeurs.some((v) => v.toLowerCase() === "cookie"))
    void reponse.header("vary", [...valeurs, "Cookie"].join(", "));
}

/** Point d'extension du core (`entetesFlux`) qui rejoue `onSend` avant une réponse en flux détournée ; créé par le premier venu. */
const PREPARATIONS_FLUX = "preparationsFlux";

/** Pose la garde CSRF et la session (attributs du cookie lus une fois, comme SessionMiddleware) ; avant le montage des routes. */
export function installerAuth(app: FastifyInstance, dep: DependancesAuth): void {
  const a = dep.attributsCookie();
  app.decorateRequest("session", null as unknown as Session);
  app.decorateRequest("sessionInitialeVide", true);

  app.addHook("onRequest", async (requete: FastifyRequest) => {
    if (!METHODES_MUTANTES.has(requete.method)) return;
    const url = requete.url.split("?")[0] ?? "";
    if (PREFIXES_EXEMPTES_CSRF.some((p) => url.startsWith(p))) return;
    if (!valeurCookie(requete.headers.cookie, a.cookie_name)) return;
    if (estInterSite(requete.headers, requete.host)) {
      requete.log.warn(
        `[csrf] ${requete.method} ${url} refusée — origin=${String(requete.headers.origin)} sec-fetch-site=${String(requete.headers["sec-fetch-site"])}`,
      );
      throw new HttpError(403, "Requête cross-site refusée.");
    }
  });

  app.addHook("onRequest", async (requete: FastifyRequest) => {
    const brut = valeurCookie(requete.headers.cookie, a.cookie_name);
    const donnees = brut === undefined ? null : lireSession(brut, dep.secret(), a.max_age, maintenant(dep));
    requete.session = new Session(donnees ?? {});
    requete.sessionInitialeVide = donnees === null;
  });

  const preparees = new WeakSet<FastifyRequest>();
  const preparer = (requete: FastifyRequest, reponse: FastifyReply): void => {
    const s = requete.session as Session | null;
    if (!s || preparees.has(requete)) return;
    preparees.add(requete);
    if (s.lue) ajouterVary(reponse);
    if (s.modifiee && !s.vide) {
      void reponse.header(
        "set-cookie",
        enteteCookie(a, signerSession(s.contenu(), dep.secret(), maintenant(dep))),
      );
    } else if (s.modifiee && !requete.sessionInitialeVide) {
      void reponse.header("set-cookie", enteteEffacement(a));
    }
  };
  app.addHook("onSend", async (requete: FastifyRequest, reponse: FastifyReply, charge: unknown) => {
    preparer(requete, reponse);
    return charge;
  });
  if (!app.hasDecorator(PREPARATIONS_FLUX)) app.decorate(PREPARATIONS_FLUX, [] as (typeof preparer)[]);
  app.getDecorator<(typeof preparer)[]>(PREPARATIONS_FLUX).push(preparer);
}
