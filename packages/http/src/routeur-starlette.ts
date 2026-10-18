// SPDX-License-Identifier: MIT
/** packages/http/src/routeur-starlette.ts — route introuvable comme le routeur Starlette : 405 + Allow si seule la méthode diffère, 307 vers la forme avec ou sans barre finale, sinon 404. */
import { quotePy, stripPy } from "@elpis/commun";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { RouteMontee } from "./routes";
import { decouperCible, desechapper } from "./url";

const MANDATAIRES = ["127.0.0.1", "::1"];
const SCHEMAS_MANDATAIRE = new Set(["http", "https", "ws", "wss"]);
const PORTS_PAR_DEFAUT: Readonly<Record<string, number>> = { http: 80, https: 443, ws: 80, wss: 443 };
const SURS_LOCATION = ":/%#?=@[]!$&'()*+,;";
const FIN_DE_NOM = "(-./";

interface Motif {
  readonly regex: RegExp;
  readonly methodes: readonly string[];
  readonly montage: boolean;
}

const motifsParListe = new WeakMap<readonly RouteMontee[], readonly Motif[]>();
const AUCUNE_ROUTE: readonly RouteMontee[] = [];

/** Motif Fastify (`:x`, `:x(re)`, `*`, `::`) en expression sur le chemin décodé, comme find-my-way (pas de drapeau `u`, `^`/`$` du paramètre retirés) ; `:x?` refusé. */
export function motifVersRegex(chemin: string): RegExp {
  let source = "";
  for (let i = 0; i < chemin.length; i++) {
    const c = chemin[i] as string;
    if (c === ":" && chemin[i + 1] === ":") {
      source += ":";
      i++;
    } else if (c === ":") {
      let j = i + 1;
      while (j < chemin.length && !FIN_DE_NOM.includes(chemin[j] as string)) j++;
      if (chemin.slice(i + 1, j).includes("?"))
        throw new Error("paramètre facultatif `:x?` non pris en charge : déclarer les deux routes");
      if (chemin[j] === "(") {
        let profondeur = 0;
        let k = j;
        for (; k < chemin.length; k++) {
          if (chemin[k] === "\\") k++;
          else if (chemin[k] === "(") profondeur++;
          else if (chemin[k] === ")" && --profondeur === 0) break;
        }
        let re = chemin.slice(j + 1, k);
        if (re.startsWith("^")) re = re.slice(1);
        if (re.endsWith("$")) re = re.slice(0, -1);
        source += `(?:${re})`;
        i = k;
      } else {
        source += "[^/]+";
        i = j - 1;
      }
    } else if (c === "*") {
      source += ".*";
    } else {
      source += c.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, "s");
}

/** Routes candidates dans l'ordre d'enregistrement (motifs Starlette déclarés, sinon le motif Fastify) ; un intercepteur (relais : middleware en Python) n'y est pas. */
function motifs(routes: readonly RouteMontee[]): readonly Motif[] {
  let m = motifsParListe.get(routes);
  if (m === undefined) {
    m = routes
      .filter((r) => !r.intercepteur)
      .flatMap((r) =>
        (r.motifsStarlette ?? [motifVersRegex(r.chemin)]).map((regex) => ({
          regex,
          methodes: r.methodes,
          montage: r.montage,
        })),
      );
    motifsParListe.set(routes, m);
  }
  return m;
}

/** `scope["path"]` d'uvicorn : chemin de la cible (forme absolue comprise), décodé. */
export function cheminDecode(requete: FastifyRequest): string {
  return desechapper(decouperCible(requete.originalUrl).chemin);
}

/** `scope["scheme"]` sous uvicorn : X-Forwarded-Proto (dernière ligne, valeur admise) d'un mandataire de la boucle locale. */
function schema(requete: FastifyRequest): string {
  const socket = requete.raw.socket as { remoteAddress?: string; encrypted?: boolean } | null;
  const brut = socket?.remoteAddress ?? "";
  const pair = brut.startsWith("::ffff:") && brut.includes(".") ? brut.slice(7) : brut;
  const entete = requete.headers["x-forwarded-proto"];
  const lignes =
    (requete.raw.headersDistinct as NodeJS.Dict<string[]> | undefined)?.["x-forwarded-proto"] ??
    (entete === undefined ? undefined : [entete].flat());
  const proto = lignes === undefined ? undefined : stripPy(lignes[lignes.length - 1] ?? "");
  if (proto !== undefined && MANDATAIRES.includes(pair) && SCHEMAS_MANDATAIRE.has(proto)) return proto;
  return socket?.encrypted ? "https" : "http";
}

/** `URL(scope=…)` de Starlette puis `RedirectResponse` : en-tête Host brut (sinon l'adresse locale), chemin décodé, requête brute. */
function urlDeRedirection(requete: FastifyRequest, chemin: string, requeteBrute: string): string {
  const s = schema(requete);
  const hote = requete.raw.headers.host;
  let url: string;
  if (hote !== undefined) {
    url = `${s}://${hote}${chemin}`;
  } else {
    const local = requete.raw.socket as { localAddress?: string; localPort?: number } | null;
    const port = local?.localPort ?? 0;
    url =
      port === PORTS_PAR_DEFAUT[s]
        ? `${s}://${local?.localAddress ?? ""}${chemin}`
        : `${s}://${local?.localAddress ?? ""}:${port}${chemin}`;
  }
  if (requeteBrute) url += `?${requeteBrute}`;
  return quotePy(url, SURS_LOCATION);
}

/** Aucune route pour cette méthode et ce chemin : réponse du routeur Starlette (`Router.app` puis `not_found`) ; WebSocket : 403 ; cible hors forme origine ou app sans `elpis` : 404. */
export function routeIntrouvable(requete: FastifyRequest, reponse: FastifyReply): FastifyReply {
  if (requete.ws) return reponse.code(403).send();
  const { chemin: brut, requete: requeteBrute } = decouperCible(requete.originalUrl);
  if (!brut.startsWith("/")) return reponse.code(404).send({ detail: "Not Found" });
  const chemin = desechapper(brut);
  const candidats = motifs(
    (requete.server as Partial<Pick<FastifyInstance, "elpis">>).elpis?.routes ?? AUCUNE_ROUTE,
  );
  const partielle = candidats.find((m) => m.regex.test(chemin));
  if (partielle !== undefined && !partielle.methodes.includes(requete.method)) {
    if (partielle.montage) return reponse.code(405).send({ detail: "Method Not Allowed" });
    return reponse
      .code(405)
      .header("allow", partielle.methodes.join(", "))
      .send({ detail: "Method Not Allowed" });
  }
  if (partielle === undefined && chemin !== "/") {
    const autre = chemin.endsWith("/") ? chemin.replace(/\/+$/u, "") : `${chemin}/`;
    if (autre.startsWith("/") && candidats.some((m) => m.regex.test(autre))) {
      return reponse
        .code(307)
        .header("location", urlDeRedirection(requete, autre, requeteBrute))
        .send();
    }
  }
  return reponse.code(404).send({ detail: "Not Found" });
}

/** Décision prise dès `onRequest`, après CSRF, session et CORS, avant toute lecture du corps : route introuvable, ou cible hors forme origine (que Fastify route vers `/`). */
export function installerRouteurStarlette(app: FastifyInstance): void {
  app.addHook("onRequest", async (requete: FastifyRequest, reponse: FastifyReply) => {
    const horsOrigine = !decouperCible(requete.originalUrl).chemin.startsWith("/");
    if (requete.is404 || horsOrigine) return routeIntrouvable(requete, reponse);
    return undefined;
  });
}
