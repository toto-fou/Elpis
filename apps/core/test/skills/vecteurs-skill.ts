// SPDX-License-Identifier: MIT
/** apps/core/test/skills/vecteurs-skill.ts — développement et résumé des valeurs des vecteurs Python des outils skill et ask_user. */
import { createHash } from "node:crypto";

import { FlottantPy, longueurPy } from "@elpis/commun";

type Dict = Record<string, unknown>;

/** `{"$rep": [texte, n]}`, `{"$cat": [...]}`, `{"$f": repr}` et `{"$i": texte}` des vecteurs : chaînes, flottant et entier long tels que reçus. */
export function developper(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(developper);
  if (v !== null && typeof v === "object") {
    const o = v as Dict;
    const cles = Object.keys(o);
    if (cles.length === 1 && cles[0] === "$f") return new FlottantPy(Number(o["$f"]));
    if (cles.length === 1 && cles[0] === "$i") return BigInt(String(o["$i"]));
    if (cles.length === 1 && cles[0] === "$rep") {
      const [texte, n] = o["$rep"] as [string, number];
      return texte.repeat(n);
    }
    if (cles.length === 1 && cles[0] === "$cat") return (o["$cat"] as unknown[]).map(developper).join("");
    return Object.fromEntries(cles.map((k) => [k, developper(o[k])]));
  }
  return v;
}

/** Chaîne de plus de 2 000 caractères résumée comme `_compact` du générateur. */
export function compacter(v: unknown): unknown {
  if (typeof v === "string" && longueurPy(v) > 2000)
    return {
      $long: [
        longueurPy(v),
        createHash("sha256").update(Buffer.from(v, "utf8")).digest("hex").slice(0, 16),
        Array.from(v).slice(0, 40).join(""),
      ],
    };
  if (Array.isArray(v)) return v.map(compacter);
  if (v !== null && typeof v === "object")
    return Object.fromEntries(Object.entries(v as Dict).map(([k, x]) => [k, compacter(x)]));
  return v;
}
