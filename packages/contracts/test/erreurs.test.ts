// SPDX-License-Identifier: MIT
/** packages/contracts/test/erreurs.test.ts — les formes d'erreur décrivent les réponses réelles de FastAPI (vecteurs Python). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { schemaEmplacement, schemaErreur422, schemaErreurApi } from "../src/erreurs";

interface Cas {
  nom: string;
  statut: number;
  corps: unknown;
}

const { cas } = JSON.parse(readFileSync(new URL("./vecteurs/erreurs.json", import.meta.url), "utf-8")) as {
  cas: Cas[];
};
const erreurs = cas.filter((c) => c.statut >= 400);
const validations = erreurs.filter(
  (c) => Array.isArray((c.corps as { detail?: unknown }).detail) && c.statut === 422,
);

describe("erreurs HTTP", () => {
  it("couvre les 422 et les autres codes", () => {
    expect(validations.length).toBeGreaterThanOrEqual(5);
    expect(erreurs.filter((c) => c.statut !== 422).length).toBeGreaterThanOrEqual(5);
  });

  it.each(erreurs.map((c) => [c.nom, c] as const))("%s a la forme {detail}", (_nom, c) => {
    expect(schemaErreurApi.safeParse(c.corps).success).toBe(true);
  });

  it.each(validations.map((c) => [c.nom, c] as const))("%s est un 422 de Pydantic", (_nom, c) => {
    const r = schemaErreur422.safeParse(c.corps);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    for (const e of r.data?.detail ?? []) expect(schemaEmplacement.safeParse(e.loc[0]).success).toBe(true);
  });

  it("garde les champs supplémentaires et distingue un 422 levé à la main", () => {
    const champs = cas.find((c) => c.nom === "champs_supplementaires");
    expect(schemaErreurApi.parse(champs?.corps)).toHaveProperty("conflicts");
    const texte = cas.find((c) => c.nom === "http_422_texte");
    expect(texte?.statut).toBe(422);
    expect(schemaErreurApi.safeParse(texte?.corps).success).toBe(true);
    expect(schemaErreur422.safeParse(texte?.corps).success).toBe(false);
  });

  it("refuse un 422 sans msg", () => {
    expect(
      schemaErreur422.safeParse({ detail: [{ type: "missing", loc: ["body"], input: null }] }).success,
    ).toBe(false);
  });
});
