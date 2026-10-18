// SPDX-License-Identifier: MIT
/** apps/core/src/familles/openapi.ts — routes de la façade OpenAPI (mcp/routes_openapi.py) : spec d'une famille et appel d'un outil, par jeton d'outils seul. */
import { politique, resoudreJeton, toucherJeton } from "@elpis/auth";
import type { DependancesJetons, JetonResolu } from "@elpis/auth";
import {
  ErreurJsonPy,
  ErreurLecturePy,
  estDict,
  HttpError,
  lowerPy,
  pyJsonLoads,
  pyJsonLoadsOctets,
  rstripPy,
  stripPy,
  texteJsonPy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { Journal } from "../journal";
import {
  buildSpec,
  callTool,
  EXPOSABLE_FAMILIES,
  FamilyUnavailable,
  familyTools,
  OPENAPI_PREFIX,
  ServiceSaturated,
  validationErrors,
} from "../outils/openapi";
import type { PoolOutils } from "../outils/openapi";
import type { Famille } from "../routes";
import { urlAppStricte } from "./oauth";
import { premiereValeur } from "./pont-mcp";
import { corpsLu, installerCorpsBorne, reponseJsonPy } from "@elpis/http";

/** Appels simultanés par compte, comptés dans ce process (le service d'outils garde sa propre file bornée). */
export const MAX_CONCURRENT_PER_USER = 4;
const DEFI = { "WWW-Authenticate": "Bearer" };
const CORPS_MAX = 8 * 1024 * 1024;
const BLANCS_ASCII = new Set([0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d]);

export interface DependancesOpenapi {
  readonly jetons: DependancesJetons;
  readonly journal: Journal;
  readonly pool?: PoolOutils;
}

/** `Authorization: Bearer …` seul : ni cookie de session ni `x-elpis-token`. */
function bearer(requete: FastifyRequest): string {
  const auth = stripPy(premiereValeur(requete, "authorization") ?? "");
  return lowerPy(auth).startsWith("bearer ") ? stripPy(auth.slice(7)) : "";
}

/** Origine publique de l'app ; un Host non reconnu donne une URL relative, valide en OpenAPI 3.1. */
function urlServeur(requete: FastifyRequest, family: string): string {
  let base: string;
  try {
    base = rstripPy(urlAppStricte(requete), "/");
  } catch {
    base = "";
  }
  return `${base}${OPENAPI_PREFIX}/${family}`;
}

export function creerFamilleOpenapi(dep: DependancesOpenapi): Famille {
  const enVol = new Map<number, number>();
  const appels = new WeakMap<FastifyRequest, { info: JetonResolu; outil: Dict }>();

  /** Jeton d'outils résolu ; façade coupée ou famille hors portée : 404, comme une famille inconnue (aucun oracle). */
  async function autoriser(requete: FastifyRequest, family: string): Promise<JetonResolu> {
    let pol: ReturnType<typeof politique> | null;
    try {
      pol = politique(dep.jetons.config());
    } catch (e) {
      dep.journal.warn({ err: e }, "politique des jetons illisible");
      pol = null;
    }
    if (!pol?.tools_enabled) throw new HttpError(404, "Not Found");
    const jeton = bearer(requete);
    if (!jeton) throw new HttpError(401, "Jeton d'outils requis (Authorization: Bearer ept_…).", DEFI);
    let info: JetonResolu | null = null;
    if (jeton.startsWith("ept_")) {
      try {
        info = await resoudreJeton(dep.jetons, jeton, ["tools"]);
      } catch (e) {
        dep.journal.warn({ err: e }, "résolution du jeton en échec");
        throw new HttpError(503, "Vérification du jeton indisponible.");
      }
    }
    if (!info) throw new HttpError(401, "Jeton d'outils invalide, expiré ou révoqué.", DEFI);
    const fams = info.families;
    const permises = EXPOSABLE_FAMILIES.filter((f) => pol.tools_families.includes(f) && fams.includes(f));
    if (!permises.includes(family)) throw new HttpError(404, "Famille d'outils inconnue.");
    await toucherJeton(dep.jetons, info.id, null).catch((e: unknown) => {
      dep.journal.debug({ err: e }, "last_used_at non mis à jour");
    });
    return info;
  }

  async function outilsOu502(family: string): Promise<Awaited<ReturnType<typeof familyTools>>> {
    try {
      return await familyTools(family, dep.pool);
    } catch (e) {
      if (e instanceof FamilyUnavailable) throw new HttpError(502, "Le service d'outils ne répond pas.");
      throw e;
    }
  }

  /** Jeton, famille et outil vérifiés avant la lecture du corps, comme routes_openapi.py. */
  async function preparerAppel(requete: FastifyRequest): Promise<void> {
    const { family, tool } = requete.params as { family: string; tool: string };
    const info = await autoriser(requete, family);
    const outil = (await outilsOu502(family)).find((t) => t["name"] === tool);
    if (outil === undefined) throw new HttpError(404, "Outil inconnu.");
    appels.set(requete, { info, outil });
  }

  /** Arguments de l'outil (octets reçus, 8 Mio au plus) : vide = `{}`, JSON illisible ou autre chose qu'un objet = 422. */
  function argumentsDe(requete: FastifyRequest): Record<string, unknown> {
    const brut = corpsLu(requete);
    let args: unknown = {};
    if (brut.some((o) => !BLANCS_ASCII.has(o))) {
      try {
        pyJsonLoadsOctets(brut);
        args = pyJsonLoads(texteJsonPy(brut), { mode: "natif" });
      } catch (e) {
        if (e instanceof ErreurJsonPy || (e instanceof ErreurLecturePy && e.nature !== "RecursionError"))
          throw new HttpError(422, "Corps JSON invalide.");
        throw e;
      }
    }
    if (!estDict(args))
      throw new HttpError(422, "Le corps doit être un objet JSON (les arguments de l'outil).");
    return args;
  }

  return {
    nom: "openapi",
    contexte: (app) => {
      installerCorpsBorne(app, (req) =>
        req.method === "POST" && req.routeOptions.url === `${OPENAPI_PREFIX}/:family/:tool`
          ? { limite: CORPS_MAX, avant: preparerAppel }
          : null,
      );
    },
    routes: [
      {
        methode: "GET",
        chemin: `${OPENAPI_PREFIX}/:family/openapi.json`,
        processus: ["main"],
        acces: "public",
        traiter: async (req, rep) => {
          const { family } = req.params as { family: string };
          await autoriser(req, family);
          const outils = await outilsOu502(family);
          return reponseJsonPy(rep, buildSpec(family, outils, urlServeur(req, family)), {
            "Cache-Control": "no-store",
          });
        },
      },
      {
        methode: "POST",
        chemin: `${OPENAPI_PREFIX}/:family/:tool`,
        processus: ["main"],
        acces: "public",
        traiter: async (req: FastifyRequest, rep: FastifyReply) => {
          const { family } = req.params as { family: string };
          if (!appels.has(req)) await preparerAppel(req);
          const { info, outil } = appels.get(req) as { info: JetonResolu; outil: Dict };
          const args = argumentsDe(req);
          const erreurs = validationErrors(outil, args);
          if (erreurs.length > 0)
            return reponseJsonPy(rep.code(422), {
              detail: "Arguments non conformes au schéma de l'outil.",
              errors: erreurs,
            });
          const uid = info.user_id;
          if ((enVol.get(uid) ?? 0) >= MAX_CONCURRENT_PER_USER)
            throw new HttpError(429, `Trop d'appels simultanés (max ${MAX_CONCURRENT_PER_USER}).`, {
              "Retry-After": "5",
            });
          enVol.set(uid, (enVol.get(uid) ?? 0) + 1);
          let corps: unknown;
          try {
            corps = await callTool(family, outil, args, { username: info.username, userId: uid }, dep.pool);
          } catch (e) {
            if (e instanceof ServiceSaturated)
              throw new HttpError(429, "Service d'outils saturé : l'outil n'a pas été exécuté.", {
                "Retry-After": "10",
              });
            if (e instanceof FamilyUnavailable)
              throw new HttpError(502, "Le service d'outils ne répond pas.");
            throw e;
          } finally {
            const n = (enVol.get(uid) ?? 1) - 1;
            if (n > 0) enVol.set(uid, n);
            else enVol.delete(uid);
          }
          return reponseJsonPy(rep, corps, { "Cache-Control": "no-store" });
        },
      },
    ],
  };
}
