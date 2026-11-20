// SPDX-License-Identifier: MIT
/** apps/core/test/identite/ancre.test.ts — l'ancre d'une identité porte l'émetteur exact du fournisseur, jamais normalisé. */
import { describe, expect, it } from "vitest";

import { ancreIdentite } from "../../src/identite/ancre";
import { validerFournisseur } from "../../src/identite/reglages";
import { oidcValide } from "./aides";

describe("ancre d'identité", () => {
  it("SSO : l'émetteur exact, jamais normalisé", () => {
    const f = validerFournisseur(oidcValide({ issuer: "https://SSO.exemple.lan/Realms/A" }));
    expect(ancreIdentite(f)).toBe("oidc:https://SSO.exemple.lan/Realms/A");
  });
});
