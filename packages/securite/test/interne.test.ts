// SPDX-License-Identifier: MIT
/** packages/securite/test/interne.test.ts — jeton interne : valeurs de référence calculées par `hmac.new(…, sha256)` de Python. */
import { describe, expect, it } from "vitest";

import { CONTEXTE_JETON_INTERNE, jetonInterne } from "../src/index";

describe("jetonInterne", () => {
  it("HMAC-SHA256 du secret sur « elpis.interne.v1 », en hexadécimal (références Python)", () => {
    expect(CONTEXTE_JETON_INTERNE).toBe("elpis.interne.v1");
    expect(jetonInterne("secret-de-test")).toBe(
      "c4a7f5a93eba49ca180aac514167a2b6a4ba2687595660dbda8a4eba7dd66335",
    );
    expect(jetonInterne("é😀 clé de session")).toBe(
      "093769e1fce05e29c601a0506d0b39a13113c2c7bf607a0ed3caf7e3622ac9e7",
    );
    expect(jetonInterne("0".repeat(64))).toBe(
      "db67d19656b98da53a1353dff2929c995ac07d4674648752ffe36151d4ec25b0",
    );
    expect(jetonInterne("a")).toBe("ca2545a11a9308eb0163416dffd277ee0e91590d9f12e4749edd96e685c584b8");
  });

  it("secret vide : aucun jeton ; secrets différents : jetons différents", () => {
    expect(jetonInterne("")).toBe("");
    expect(jetonInterne("x")).not.toBe(jetonInterne("y"));
    expect(jetonInterne("x")).toMatch(/^[0-9a-f]{64}$/u);
  });
});
