// SPDX-License-Identifier: MIT
/** apps/core/test/boucle/aides.ts — lecture des sorties résumées des vecteurs de la boucle (valeur en clair ou empreinte de sa forme JSON). */
import { createHash } from "node:crypto";
import { expect } from "vitest";

import { pyJsonDumps } from "@elpis/commun";

export type Resume = { valeur: unknown } | { empreinte: string; taille: number } | { erreur: string };

/** Même résumé que les générateurs Python : la valeur si sa forme JSON ASCII est courte, sinon son empreinte. */
export function comparerResume(obtenu: unknown, attendu: Resume, contexte: string): void {
  if ("valeur" in attendu) {
    expect(obtenu, contexte).toEqual(attendu.valeur);
    return;
  }
  if ("erreur" in attendu) throw new Error(`${contexte} : erreur attendue ${attendu.erreur}`);
  const forme = pyJsonDumps(obtenu, { ensureAscii: true, separators: [",", ":"] });
  expect(forme.length, contexte).toBe(attendu.taille);
  expect(createHash("sha256").update(forme, "ascii").digest("hex").slice(0, 16), contexte).toBe(
    attendu.empreinte,
  );
}

/** `{"$rep": [c, n]}` des générateurs (chaîne d'un seul caractère répété) → la chaîne, récursivement. */
export function deplier(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(deplier);
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    const rep = o["$rep"];
    if (Object.keys(o).length === 1 && Array.isArray(rep)) return String(rep[0]).repeat(Number(rep[1]));
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, deplier(x)]));
  }
  return v;
}
