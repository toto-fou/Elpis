// SPDX-License-Identifier: MIT
/** apps/toolhost/src/fichiers/routes.ts — routes de fichiers de l'éditeur (sandbox/routes_files.py), hors `pv` et `preview-token` (B2-05, jeton créé par main). */
import type { DefinitionRoute } from "../app";
import { routesArchives } from "./archives";
import type { ContexteFichiers } from "./commun";
import { routesEcriture } from "./ecriture";
import { routesLecture } from "./lecture";
import { routesOutils } from "./outils";
import { routesRecherche } from "./recherche";

export function routesFichiers(ctx: ContexteFichiers): DefinitionRoute[] {
  return [
    ...routesLecture(ctx),
    ...routesEcriture(ctx),
    ...routesRecherche(ctx),
    ...routesOutils(),
    ...routesArchives(ctx),
  ];
}
