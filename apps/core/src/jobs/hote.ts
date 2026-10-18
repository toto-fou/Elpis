// SPDX-License-Identifier: MIT
/** apps/core/src/jobs/hote.ts — appels à l'hôte d'outils du compte (placement `sandboxHostFor`, jeton de service et enveloppe signée, chemin d'`appelerHote`) : arrêt des jobs, veille confiée. */
import { getUsernameById } from "@elpis/auth";
import { estDict } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import type { Base } from "@elpis/db";

import { appelerHote } from "../admin/pilote-bac";
import { sandboxHostFor } from "../relais/hotes";

const DELAI_ARRET_S = 30;

export type ParArret = "user" | "core";

/** Arrêt de jobs d'un compte et veille de ses jobs actifs ; lève si l'hôte est absent ou refuse. */
export interface PortHoteJobs {
  tuer(uid: number, jobIds: readonly string[], par: ParArret, purge: boolean): Promise<Dict[]>;
  /** `POST /api/internal/jobs/watch` : l'hôte (re)démarre la veille du compte (idempotent) ; rend `watching`. */
  veiller(uid: number, jobIds: readonly string[], sinceSeq: number): Promise<boolean>;
}

export class HoteIndisponible extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HoteIndisponible";
  }
}

/** Hôte du placement du compte (local compris), lu sans l'affecter. */
export function hoteJobsParDefaut(base: Base): PortHoteJobs {
  const appeler = async (uid: number, chemin: string, json: Dict): Promise<unknown> => {
    const hote = await sandboxHostFor(uid, false);
    if (hote === null) throw new HoteIndisponible("aucun hôte d'outils déclaré");
    const nom = (await getUsernameById(base, uid)) || `user_${uid}`;
    return appelerHote(hote, uid, nom, "POST", chemin, { json, delaiS: DELAI_ARRET_S });
  };
  return {
    async tuer(uid, jobIds, par, purge) {
      if (!jobIds.length) return [];
      const r = await appeler(uid, "/api/internal/jobs/kill", { job_ids: [...jobIds], by: par, purge });
      const resultats = estDict(r) && Array.isArray(r["results"]) ? (r["results"] as unknown[]) : [];
      return resultats.filter(estDict);
    },
    async veiller(uid, jobIds, sinceSeq) {
      const r = await appeler(uid, "/api/internal/jobs/watch", { job_ids: [...jobIds], since_seq: sinceSeq });
      return estDict(r) && r["watching"] === true;
    },
  };
}
