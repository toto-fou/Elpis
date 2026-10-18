// SPDX-License-Identifier: MIT
/** apps/core/src/jobs/reglages.ts — réglages des tâches de fond (section `jobs` de la configuration des exécuteurs) : défauts, bornes, lecture vivante. */
import { estDict, getPy, HttpError, intPy, ouPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { configView } from "@elpis/config";

export interface ReglagesJobs {
  readonly max_per_chat: number;
  readonly max_per_user: number;
  readonly max_depth: number;
  readonly wakes_per_hour: number;
  readonly max_runtime_h: number;
  readonly event_max_bytes: number;
  readonly wake_max_bytes: number;
  readonly wake_concurrency: number;
  readonly retention_days: number;
}

export const DEFAUTS_JOBS: ReglagesJobs = {
  max_per_chat: 3,
  max_per_user: 5,
  max_depth: 5,
  wakes_per_hour: 12,
  max_runtime_h: 24,
  event_max_bytes: 3072,
  wake_max_bytes: 8192,
  wake_concurrency: 1,
  retention_days: 7,
};

/** Bornes du formulaire de la console (L4), reprises par le serveur. */
export const BORNES_JOBS: Readonly<Record<keyof ReglagesJobs, readonly [number, number]>> = {
  max_per_chat: [1, 50],
  max_per_user: [1, 200],
  max_depth: [1, 50],
  wakes_per_hour: [1, 600],
  max_runtime_h: [1, 720],
  event_max_bytes: [256, 65536],
  wake_max_bytes: [1024, 262144],
  wake_concurrency: [1, 8],
  retention_days: [1, 365],
};

const CLES = Object.keys(DEFAUTS_JOBS) as (keyof ReglagesJobs)[];

/** Section validée pour config.json : entiers bornés, défaut pour une clé absente ; 400 hors bornes. */
export function assainirReglagesJobs(brut: unknown): ReglagesJobs {
  if (!estDict(brut)) throw new HttpError(400, "jobs doit être un objet");
  const out: Record<string, number> = {};
  for (const cle of CLES) {
    let v: number;
    try {
      v = intPy(getPy(brut, cle, DEFAUTS_JOBS[cle]));
    } catch {
      throw new HttpError(400, `jobs.${cle} doit être un entier`);
    }
    const [bas, haut] = BORNES_JOBS[cle];
    if (v < bas || v > haut) throw new HttpError(400, `jobs.${cle} doit être entre ${bas} et ${haut}`);
    out[cle] = v;
  }
  return out as unknown as ReglagesJobs;
}

/** Valeurs effectives d'une section lue : une clé illisible ou hors bornes retombe sur son défaut. */
export function reglagesJobsDepuis(brut: unknown): ReglagesJobs {
  const src: Dict = estDict(brut) ? brut : {};
  const out: Record<string, number> = {};
  for (const cle of CLES) {
    let v: number;
    try {
      v = intPy(getPy(src, cle, DEFAUTS_JOBS[cle]));
    } catch {
      v = DEFAUTS_JOBS[cle];
    }
    const [bas, haut] = BORNES_JOBS[cle];
    out[cle] = v < bas || v > haut ? DEFAUTS_JOBS[cle] : v;
  }
  return out as unknown as ReglagesJobs;
}

/** Réglages en vigueur, relus dans la vue vivante de config.json. */
export function reglagesJobs(): ReglagesJobs {
  try {
    return reglagesJobsDepuis(getPy(ouPy(getPy(configView(), "executors"), {}), "jobs"));
  } catch {
    return DEFAUTS_JOBS;
  }
}
