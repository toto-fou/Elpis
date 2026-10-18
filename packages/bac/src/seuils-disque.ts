// SPDX-License-Identifier: MIT
/** packages/bac/src/seuils-disque.ts — seuils de remplissage du bac (section `executors.disk`, harnais N-08) : alerte et refus en pourcentage, défauts, bornes, lecture vivante. */
import { estDict, getPy, HttpError, intPy, ouPy } from "@elpis/commun";
import { configView } from "@elpis/config";

export interface SeuilsDisque {
  readonly warn_pct: number;
  readonly refuse_pct: number;
}

export const DEFAUTS_DISQUE: SeuilsDisque = { warn_pct: 85, refuse_pct: 97 };

/** Bornes du formulaire de la console, reprises par le serveur ; l'alerte reste sous le refus. */
export const BORNES_DISQUE: Readonly<Record<keyof SeuilsDisque, readonly [number, number]>> = {
  warn_pct: [10, 99],
  refuse_pct: [11, 100],
};

const CLES = Object.keys(DEFAUTS_DISQUE) as (keyof SeuilsDisque)[];

/** Section validée pour config.json : entiers bornés, défaut pour une clé absente, alerte sous le refus ; 400 sinon. */
export function assainirSeuilsDisque(brut: unknown): SeuilsDisque {
  if (!estDict(brut)) throw new HttpError(400, "disk doit être un objet");
  const out: Record<string, number> = {};
  for (const cle of CLES) {
    let v: number;
    try {
      v = intPy(getPy(brut, cle, DEFAUTS_DISQUE[cle]));
    } catch {
      throw new HttpError(400, `disk.${cle} doit être un entier`);
    }
    const [bas, haut] = BORNES_DISQUE[cle];
    if (v < bas || v > haut) throw new HttpError(400, `disk.${cle} doit être entre ${bas} et ${haut}`);
    out[cle] = v;
  }
  if ((out["warn_pct"] ?? 0) >= (out["refuse_pct"] ?? 0))
    throw new HttpError(400, "disk.warn_pct doit être inférieur à disk.refuse_pct");
  return out as unknown as SeuilsDisque;
}

/** Valeurs effectives d'une section lue : clé illisible ou hors bornes → son défaut ; alerte au niveau du refus ou au-dessus → les deux défauts. */
export function seuilsDisqueDepuis(brut: unknown): SeuilsDisque {
  const src = estDict(brut) ? brut : {};
  const out: Record<string, number> = {};
  for (const cle of CLES) {
    let v: number;
    try {
      v = intPy(getPy(src, cle, DEFAUTS_DISQUE[cle]));
    } catch {
      v = DEFAUTS_DISQUE[cle];
    }
    const [bas, haut] = BORNES_DISQUE[cle];
    out[cle] = v < bas || v > haut ? DEFAUTS_DISQUE[cle] : v;
  }
  return (out["warn_pct"] ?? 0) < (out["refuse_pct"] ?? 0)
    ? (out as unknown as SeuilsDisque)
    : DEFAUTS_DISQUE;
}

/** Seuils en vigueur, relus dans la vue vivante de config.json ; config illisible → défauts. */
export function seuilsDisque(): SeuilsDisque {
  try {
    return seuilsDisqueDepuis(getPy(ouPy(getPy(configView(), "executors"), {}), "disk"));
  } catch {
    return DEFAUTS_DISQUE;
  }
}
