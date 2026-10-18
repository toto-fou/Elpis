// SPDX-License-Identifier: MIT
/** apps/core/src/llm/ordonnanceur/python.ts — `str.strip()`, `int()`, `float()` de Python, ceux de @elpis/commun (réexports de transition). */
import { ErreurPython, floatPy, intPy } from "@elpis/commun";

export { stripPy as stripPython } from "@elpis/commun";

/** `int(texte)` ; `null` là où Python lève `ValueError`. */
export function entierPython(s: string): number | null {
  try {
    return intPy(s);
  } catch (e) {
    if (e instanceof ErreurPython) return null;
    throw e;
  }
}

/** `float(texte)` ; `null` là où Python lève `ValueError`. */
export function flottantPython(s: string): number | null {
  try {
    return floatPy(s);
  } catch (e) {
    if (e instanceof ErreurPython) return null;
    throw e;
  }
}
