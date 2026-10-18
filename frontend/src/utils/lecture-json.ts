// SPDX-License-Identifier: MIT
/** frontend/src/utils/lecture-json.ts — lecture défensive d'un JSON reçu en `unknown` : accès typés avec repli, sans exception. */

import type { ZodType } from "zod";

export type Objet = Record<string, unknown>;

export const estObjet = (v: unknown): v is Objet => typeof v === "object" && v !== null && !Array.isArray(v);

/** L'objet, ou un objet vide. */
export const objet = (v: unknown): Objet => (estObjet(v) ? v : {});

/** Le tableau, ou un tableau vide. */
export const liste = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Les éléments objets d'un tableau. */
export const listeObjets = (v: unknown): Objet[] => liste(v).filter(estObjet);

export const texte = (v: unknown, repli = ""): string => (typeof v === "string" ? v : repli);

export const nombre = (v: unknown, repli = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : repli;

export const booleen = (v: unknown, repli = false): boolean => (typeof v === "boolean" ? v : repli);

/** Corps JSON d'une réponse, `null` s'il est absent ou illisible. */
export async function corpsJson(res: Response | null): Promise<unknown> {
  if (!res) return null;
  try {
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

/** Texte du champ `detail` d'un corps d'erreur, ou `repli`. */
export function detailErreur(corps: unknown, repli = ""): string {
  const d = objet(corps)["detail"];
  return typeof d === "string" ? d : repli;
}

/** Corps JSON d'une réponse validé par un schéma ; `null` si la réponse manque, est en échec ou ne correspond pas. */
export async function lireSchema<T>(res: Response | null, schema: ZodType<T>): Promise<T | null> {
  if (!res || !res.ok) return null;
  const lu = schema.safeParse(await corpsJson(res));
  return lu.success ? lu.data : null;
}
