// SPDX-License-Identifier: MIT
/** packages/outils-mcp/test/vecteurs.ts — lecture des vecteurs Python : `{"$f": repr}` → FlottantPy, `{"$i": texte}` → bigint. */
import { readFileSync } from "node:fs";

import { FlottantPy } from "@elpis/commun";

export function detaguer(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(detaguer);
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const cles = Object.keys(o);
    if (cles.length === 1 && cles[0] === "$f")
      return new FlottantPy(Number(String(o["$f"]).replace("inf", "Infinity")));
    if (cles.length === 1 && cles[0] === "$i") return BigInt(String(o["$i"]));
    return Object.fromEntries(cles.map((k) => [k, detaguer(o[k])]));
  }
  return v;
}

/** Valeur TS comparable au vecteur : FlottantPy et bigint retagués. */
export function taguer(v: unknown): unknown {
  if (v instanceof FlottantPy) return { $f: v.valeur };
  if (typeof v === "bigint") return { $i: v.toString() };
  if (Array.isArray(v)) return v.map(taguer);
  if (v !== null && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, taguer(x)]));
  return v;
}

export function lireVecteurs<T>(nom: string): T {
  return JSON.parse(readFileSync(new URL(`./vecteurs/${nom}.json`, import.meta.url), "utf-8")) as T;
}
