// SPDX-License-Identifier: MIT
/** apps/toolhost/src/bac/famille.ts — famille de routes du cycle de vie du bac (`/api/sandbox/me*`, `/api/sandbox/snapshots*`, suppression interne), sous jeton de service et enveloppe. */
import type { Famille } from "../app";
import type { Journal } from "../journal";
import { routesInstantanes } from "./instantanes";
import { routesInternes } from "./interne";
import { routesMe } from "./routes-me";

export interface ContexteBac {
  readonly journal: Journal;
  /** Arrêt du process : les flux NDJSON en cours se ferment. */
  readonly arret?: AbortSignal;
}

export function creerFamilleBac(ctx: ContexteBac): Famille {
  return {
    nom: "bac",
    routes: [...routesMe(ctx.journal), ...routesInstantanes(ctx.arret), ...routesInternes()],
  };
}
