// SPDX-License-Identifier: MIT
/** packages/mcp/src/outils.ts — dict, itération et texte à la Python pour le paquet MCP. */
import { reprPy, texteOu } from "@elpis/commun";

export {
  copieDict,
  ErreurCle,
  estDict,
  isdigitPy,
  iterExige as iterer,
  lire,
  nomTypePy as nomType,
  poserCle as poser,
  texteNet,
} from "@elpis/commun";
export type { Dict } from "@elpis/commun";

/** `str(x or "")`. */
export function texte(v: unknown): string {
  return texteOu(v, "");
}

/** Valeur nulle au sens de Python (`None`) : `null` ou absente. */
export function estNul(v: unknown): v is null | undefined {
  return v === null || v === undefined;
}

/** `{x!r}` dans une f-string. */
export const repr = reprPy;
