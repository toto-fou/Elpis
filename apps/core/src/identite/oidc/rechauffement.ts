// SPDX-License-Identifier: MIT
/** apps/core/src/identite/oidc/rechauffement.ts — découverte des fournisseurs SSO actifs à déconnexion initiée par Elpis tenue chaude, pour que l'adresse de fin de session se construise sans appel sortant à la déconnexion. */
import { dormirMs } from "@elpis/commun";
import type { Base } from "@elpis/db";

import type { Journal } from "../../journal";
import { fournisseursActifs } from "../fournisseurs";
import { lireReglagesAuth } from "../reglages";
import type { FabriqueConfigurations } from "./configuration";

export const PERIODE_RECHAUFFEMENT_S = 55 * 60;

export interface DependancesRechauffement {
  readonly base: Base;
  readonly configurations: FabriqueConfigurations;
  readonly cookieSecure: () => boolean;
  readonly journal: Journal;
}

/** Une passe : la découverte de chaque fournisseur actif concerné est relue ; une panne est gardée en cache d'échec et ne bloque pas les autres. */
export async function rechaufferDecouvertes(dep: DependancesRechauffement): Promise<void> {
  const publicUrl = lireReglagesAuth().public_url;
  for (const f of await fournisseursActifs(dep.base, dep.cookieSecure)) {
    if (!f.logout.rp_initiated) continue;
    try {
      await dep.configurations.rechauffer(f, publicUrl);
    } catch {
      dep.journal.debug(`découverte SSO ${f.id} non réchauffée`);
    }
  }
}

/** Passe au démarrage puis périodique jusqu'à l'arrêt ; ne lève jamais. */
export async function maintenirDecouvertesChaudes(
  dep: DependancesRechauffement,
  signal: AbortSignal,
  periodeS = PERIODE_RECHAUFFEMENT_S,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await rechaufferDecouvertes(dep);
    } catch (e) {
      dep.journal.warn({ err: e }, "réchauffement des découvertes SSO en échec");
    }
    try {
      await dormirMs(periodeS * 1000, signal);
    } catch {
      return;
    }
  }
}
