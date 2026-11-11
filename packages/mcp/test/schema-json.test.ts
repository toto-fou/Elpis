// SPDX-License-Identifier: MIT
/** packages/mcp/test/schema-json.test.ts — validation des sorties structurées : brouillon de `$schema`, messages, ordre et meilleure erreur de python-jsonschema (vecteurs Python). */
import { describe, expect, it } from "vitest";

import { compilerSchema, erreursSchema, meilleureErreur } from "../src";
import { lireVecteurs } from "./aides";

type Dict = Record<string, unknown>;

const CAS = lireVecteurs<{ schemas_sortie: Dict[] }>("mcp-paquet").schemas_sortie;

describe("schémas de sortie (jsonschema)", () => {
  it("couvre les mots-clés, brouillons et cas d'erreur de schéma", () => {
    expect(CAS.length).toBeGreaterThan(45);
  });

  for (const [i, c] of CAS.entries()) {
    it(`${i} ${JSON.stringify(c["schema"]).slice(0, 90)}`, () => {
      if (c["schema_invalide"]) {
        expect(() => compilerSchema(c["schema"])).toThrow();
        return;
      }
      const valider = compilerSchema(c["schema"]);
      if (c["brouillon"] === "Draft4Validator") {
        expect(valider).toBeNull();
        expect(meilleureErreur(valider, c["schema"], c["instance"])).toBeNull();
        return;
      }
      expect(erreursSchema(valider, c["schema"], c["instance"])).toEqual(c["toutes"]);
      expect(meilleureErreur(valider, c["schema"], c["instance"])).toEqual(c["meilleure"]);
    });
  }

  it("brouillon imposé (manifeste : Draft202012Validator quel que soit $schema)", () => {
    const schema = { $schema: "http://json-schema.org/draft-07/schema#", prefixItems: [{ type: "integer" }] };
    expect(erreursSchema(compilerSchema(schema, "2020-12"), schema, ["a"])).toEqual([
      { chemin: [0], message: "'a' is not of type 'integer'" },
    ]);
    expect(erreursSchema(compilerSchema(schema), schema, ["a"])).toEqual([]);
  });

  it("une compilation par schéma : même `$id` recompilable", () => {
    const schema = { $id: "https://exemple.invalid/s.json", type: "integer" };
    expect(erreursSchema(compilerSchema(schema), schema, "x")).toHaveLength(1);
    expect(erreursSchema(compilerSchema(schema), schema, "x")).toHaveLength(1);
  });
});
