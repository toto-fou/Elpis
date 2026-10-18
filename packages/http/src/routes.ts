// SPDX-License-Identifier: MIT
/** packages/http/src/routes.ts — déclaration des routes (process, accès, traitement) et montage selon le mode, génériques sur le mode et les accès. */
import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from "fastify";
import type { WebSocket } from "ws";

import { crochetBorne } from "./corps-borne";
import type { Borne } from "./corps-borne";
import { cheminDecode, motifVersRegex } from "./routeur-starlette";

declare module "fastify" {
  interface FastifyContextConfig {
    ws?: boolean;
  }
}

export type Traitement = (requete: FastifyRequest, reponse: FastifyReply) => unknown;

export type TraitementWs = (socket: WebSocket, requete: FastifyRequest) => void | Promise<void>;

export interface DefinitionRoute<M extends string = string, A extends string = string> {
  readonly methode: HTTPMethods | readonly HTTPMethods[];
  readonly chemin: string;
  readonly processus: readonly M[];
  readonly acces: A;
  readonly traiter: Traitement;
  /** WebSocket sur le même chemin (route GET seule) : l'upgrade passe par la même garde que la requête HTTP. */
  readonly ws?: TraitementWs;
  /** Chemins Starlette réels quand le motif Fastify est plus large (`{x:path}` suivi d'un suffixe) ; `[]` : route sans équivalent. */
  readonly motifsStarlette?: readonly RegExp[];
  /** Montage Starlette (statiques) : une autre méthode reçoit 405 sans `Allow`, comme StaticFiles. */
  readonly montage?: boolean;
  /** Corps propre à la route : lu en flux jusqu'à `limite` après les contrôles `avant` (sinon : plafond global du socle). */
  readonly corps?: Borne;
}

export interface Famille<M extends string = string, A extends string = string> {
  readonly nom: string;
  readonly routes: readonly DefinitionRoute<M, A>[];
  /** Contexte encapsulé propre à la famille (analyseur de corps, gestionnaire d'erreurs, crochets). */
  readonly contexte?: (app: FastifyInstance) => void | Promise<void>;
  /** Port d'un middleware ASGI (relais) : ses routes ne comptent ni pour le 405 ni pour les barres finales du routeur Starlette. */
  readonly intercepteur?: boolean;
}

export type Garde = (requete: FastifyRequest, reponse: FastifyReply) => Promise<void> | void;

export type Gardes<A extends string = string> = Readonly<Partial<Record<Exclude<A, "public">, Garde>>>;

/** Accès déclarés par les applications (`declare module "@elpis/http" { interface AccesConnus { session: true } }`) ; aucun : tout texte. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- augmentée par chaque application
export interface AccesConnus {}

/** Accès d'une route montée tel que l'application le voit (`app.elpis.routes`). */
export type AccesMonte = [keyof AccesConnus] extends [never] ? string : Extract<keyof AccesConnus, string>;

export interface RouteMontee {
  readonly famille: string;
  readonly methodes: readonly HTTPMethods[];
  readonly chemin: string;
  readonly acces: AccesMonte;
  readonly intercepteur: boolean;
  readonly motifsStarlette?: readonly RegExp[];
  readonly montage: boolean;
  /** Limite de corps propre à la route, quand elle en déclare une. */
  readonly corps?: number;
}

interface RoutePreparee {
  readonly route: DefinitionRoute<string, string>;
  readonly methodes: readonly HTTPMethods[];
  readonly garde: Garde | undefined;
}

/** `[^/]+` de Starlette : un paramètre nommé vide ne désigne aucune route (le joker `*`, lui, peut l'être). */
function parametreVide(requete: FastifyRequest): boolean {
  const params = requete.params as Record<string, string>;
  for (const nom in params) if (nom !== "*" && params[nom] === "") return true;
  return false;
}

/** Route servant aussi une WebSocket (marquée à son montage). */
export function estRouteWs(requete: FastifyRequest): boolean {
  return (requete.routeOptions.config as { ws?: unknown } | undefined)?.ws === true;
}

/** Contrôle propre à l'application, avant les autres (ex. : console jamais montée dans un process donné) ; lève pour refuser. */
export type VerificationRoute<M extends string, A extends string> = (
  famille: Famille<M, A>,
  route: DefinitionRoute<M, A>,
) => void;

function preparer<M extends string, A extends string>(
  famille: Famille<M, A>,
  route: DefinitionRoute<M, A>,
  gardes: Gardes<A>,
  verifier: VerificationRoute<M, A> | undefined,
): RoutePreparee {
  const methodes: readonly HTTPMethods[] =
    typeof route.methode === "string" ? [route.methode] : route.methode;
  verifier?.(famille, route);
  const garde =
    route.acces === "public"
      ? undefined
      : (gardes as Readonly<Record<string, Garde | undefined>>)[route.acces];
  if (route.acces !== "public" && !garde) {
    throw new Error(
      `route ${methodes.join(",")} ${route.chemin} (${famille.nom}) : garde « ${route.acces} » absente`,
    );
  }
  if (route.ws && (methodes.length !== 1 || methodes[0] !== "GET")) {
    throw new Error(
      `route ${route.chemin} (${famille.nom}) : une WebSocket se déclare sur une route GET seule`,
    );
  }
  try {
    motifVersRegex(route.chemin);
  } catch (e) {
    throw new Error(`route ${route.chemin} (${famille.nom}) : ${(e as Error).message}`, { cause: e });
  }
  return { route, methodes, garde };
}

function monter(app: FastifyInstance, { route, methodes, garde }: RoutePreparee): void {
  const traiter = route.traiter;
  const nomme = /:[^:]/.test(route.chemin.replaceAll("::", ""));
  const motifs = route.motifsStarlette;
  app.route({
    method: route.ws ? "GET" : [...methodes],
    url: route.chemin,
    ...(garde || nomme || motifs
      ? {
          onRequest: async (requete: FastifyRequest, reponse: FastifyReply) => {
            if (nomme && parametreVide(requete)) return reponse.callNotFound();
            if (motifs && !motifs.some((m) => m.test(cheminDecode(requete)))) return reponse.callNotFound();
            if (garde) await garde(requete, reponse);
            return undefined;
          },
        }
      : {}),
    ...(route.ws ? { wsHandler: route.ws, config: { ws: true } } : {}),
    ...(route.corps ? { preParsing: crochetBorne(route.corps) } : {}),
    handler: async (requete: FastifyRequest, reponse: FastifyReply) => {
      const resultat = await traiter(requete, reponse);
      return resultat === undefined && !reponse.sent && !reponse.raw.headersSent ? null : resultat;
    },
  });
}

/** Monte les routes du mode ; la garde passe avant la lecture du corps, une route sans garde installée refuse de se monter. */
export function monterFamilles<M extends string, A extends string>(
  app: FastifyInstance,
  mode: M,
  familles: readonly Famille<M, A>[],
  gardes: Gardes<A>,
  verifier?: VerificationRoute<M, A>,
): RouteMontee[] {
  const montees: RouteMontee[] = [];
  for (const famille of familles) {
    const preparees = famille.routes
      .filter((route) => route.processus.includes(mode))
      .map((route) => preparer(famille, route, gardes, verifier));
    const contexte = famille.contexte;
    if (contexte && preparees.length > 0) {
      void app.register(async (sous) => {
        await contexte(sous);
        for (const p of preparees) monter(sous, p);
      });
    } else {
      for (const p of preparees) monter(app, p);
    }
    for (const { route, methodes } of preparees) {
      montees.push({
        famille: famille.nom,
        methodes,
        chemin: route.chemin,
        acces: route.acces as AccesMonte,
        intercepteur: famille.intercepteur === true,
        ...(route.motifsStarlette ? { motifsStarlette: route.motifsStarlette } : {}),
        montage: route.montage === true,
        ...(route.corps ? { corps: route.corps.limite } : {}),
      });
    }
  }
  return montees;
}
