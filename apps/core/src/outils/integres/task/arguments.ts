// SPDX-License-Identifier: MIT
/** apps/core/src/outils/integres/task/arguments.ts — lecture et validation des paramètres facultatifs d'un appel `task`. */
import type { Dict } from "../../../python";

/** Paramètres facultatifs de `task` validés ; `erreur` : refus à rendre tel quel. */
export interface ArgsTache {
  /** L'enfant reçoit le bloc « Inherited from the parent » (lancement seulement). */
  inherit: boolean;
  readOnly: boolean;
  maxSeconds: number | null;
}

/** Lecture des paramètres du parent ; message anglais de refus pour une valeur mal formée. */
export function lireArgsTache(
  args: Dict,
  o: { maxSecondsCap: number },
): ArgsTache | { erreur: string; fix: string } {
  for (const cle of ["read_only", "inherit"] as const) {
    const v = args[cle];
    if (v !== undefined && v !== null && typeof v !== "boolean")
      return { erreur: `${cle} must be a boolean`, fix: `pass ${cle}=true or omit it` };
  }
  const v = args["max_seconds"];
  const sec =
    v === undefined || v === null || v === ""
      ? null
      : typeof v === "number"
        ? v
        : typeof v === "string" && /^\d+$/u.test(v.trim())
          ? Number(v)
          : NaN;
  if (sec !== null && !(Number.isInteger(sec) && sec >= 30))
    return {
      erreur: "max_seconds must be an integer of at least 30",
      fix: `pass 30..${o.maxSecondsCap} or omit it`,
    };
  return {
    inherit: args["inherit"] === true,
    readOnly: args["read_only"] === true,
    maxSeconds: sec === null ? null : Math.min(sec, o.maxSecondsCap),
  };
}
