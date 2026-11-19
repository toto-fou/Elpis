// SPDX-License-Identifier: MIT
/** apps/core/test/identite/annuaire/dn.test.ts — la comparaison de DN ignore la casse et les blancs autour des séparateurs, jamais le contenu. */
import { describe, expect, it } from "vitest";

import { dnNormalise, memeDn } from "../../../src/identite/annuaire/dn";

describe("DN normalisé", () => {
  it("même DN écrit autrement : égaux", () => {
    expect(memeDn("uid=svc,cn=users,dc=exemple,dc=lan", "UID=svc , cn=Users,DC=exemple, dc=lan")).toBe(true);
  });

  it("DN voisin ou virgule échappée : différents", () => {
    expect(memeDn("uid=svc,dc=x", "uid=svc2,dc=x")).toBe(false);
    expect(memeDn("cn=a\\,b,dc=x", "cn=a,b,dc=x")).toBe(false);
    expect(dnNormalise("cn=A\\, B , dc=X")).toBe("cn=a\\, b,dc=x");
  });
});
