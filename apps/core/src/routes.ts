// SPDX-License-Identifier: MIT
/** apps/core/src/routes.ts — routes du core : process main ou admin, accès du core, console jamais montée dans main (montage par @elpis/http). */
import { monterFamilles as monterFamillesHttp } from "@elpis/http";
import type {
  DefinitionRoute as DefinitionRouteHttp,
  Famille as FamilleHttp,
  Gardes as GardesHttp,
  RouteMontee,
  VerificationRoute,
} from "@elpis/http";
import type { FastifyInstance } from "fastify";

import type { ModeApp } from "./mode";

export { estRouteWs } from "@elpis/http";
export type { Garde, RouteMontee, Traitement, TraitementWs } from "@elpis/http";

/** `loopback` : boucle locale ; `service` : jeton du toolhost ; `interne` : main ↔ admin, boucle locale et jeton interne. */
export type Acces = "public" | "session" | "staff" | "admin" | "loopback" | "service" | "interne";

declare module "@elpis/http" {
  /** Accès du core, vus dans `app.elpis.routes`. */
  interface AccesConnus {
    public: true;
    session: true;
    staff: true;
    admin: true;
    loopback: true;
    service: true;
    interne: true;
  }
}

export type DefinitionRoute = DefinitionRouteHttp<ModeApp, Acces>;
export type Famille = FamilleHttp<ModeApp, Acces>;
export type Gardes = GardesHttp<Acces>;

/** Route de la console : jamais dans main, sauf le canal interne de process à process. */
export function estRouteAdministration(chemin: string): boolean {
  const admin = chemin === "/api/admin" || chemin.startsWith("/api/admin/");
  return admin && !chemin.startsWith("/api/admin/internal/");
}

/** Refus de monter une route de la console dans main. */
export function verificationDuMode(mode: ModeApp): VerificationRoute<ModeApp, Acces> {
  return (famille, route) => {
    if (mode === "main" && estRouteAdministration(route.chemin)) {
      throw new Error(
        `route ${route.chemin} (${famille.nom}) : une route d'administration ne se monte pas dans main`,
      );
    }
  };
}

/** Monte les routes du mode ; la garde passe avant la lecture du corps, une route sans garde installée refuse de se monter. */
export function monterFamilles(
  app: FastifyInstance,
  mode: ModeApp,
  familles: readonly Famille[],
  gardes: Gardes,
): RouteMontee[] {
  return monterFamillesHttp(app, mode, familles, gardes, verificationDuMode(mode));
}
