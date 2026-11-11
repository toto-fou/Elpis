// SPDX-License-Identifier: MIT
/** packages/securite/test/base64.test.ts — décodage tolérant : rejoue `base64.urlsafe_b64decode`. */
import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { urlsafeB64Decode, urlsafeB64Encode, urlsafeB64EncodeSansRembourrage } from "../src/base64";
import { attendu, essai, vecteurs } from "./aides";

describe("vecteurs Python de urlsafe_b64decode", () => {
  it("couvre les cas écrits à la main et les tirages", () => {
    expect(vecteurs.base64.length).toBeGreaterThan(150);
  });

  for (const [i, cas] of vecteurs.base64.entries()) {
    it(`${i} ${JSON.stringify(cas.entree)}`, () => {
      expect(essai(() => urlsafeB64Decode(cas.entree).toString("hex"))).toEqual(attendu(cas));
    });
  }
});

describe("base64 hors vecteurs", () => {
  it("relit ce qu'il écrit, avec ou sans rembourrage", () => {
    for (let n = 0; n < 40; n++) {
      const octets = randomBytes(n);
      expect(urlsafeB64Decode(urlsafeB64Encode(octets))).toEqual(octets);
      const sans = urlsafeB64EncodeSansRembourrage(octets);
      expect(sans).not.toContain("=");
      expect(urlsafeB64Decode(sans + "=".repeat((4 - (sans.length % 4)) % 4))).toEqual(octets);
    }
  });

  it("encode en alphabet URL avec `=` comme urlsafe_b64encode", () => {
    expect(urlsafeB64Encode(Buffer.from([0xfb, 0xff]))).toBe("-_8=");
    expect(urlsafeB64Encode(Buffer.alloc(0))).toBe("");
  });

  it("décode aussi des octets, en ignorant ceux hors alphabet", () => {
    expect(urlsafeB64Decode(Buffer.from([0x51, 0xff, 0x51, 0x3d, 0x3d])).toString("hex")).toBe("41");
  });

  it("encode une vue partielle sans déborder sur son tampon", () => {
    const tampon = Buffer.from("xxABCxx");
    expect(urlsafeB64Encode(tampon.subarray(2, 5))).toBe("QUJD");
    expect(urlsafeB64EncodeSansRembourrage(new Uint8Array(tampon.buffer, tampon.byteOffset + 2, 2))).toBe(
      "QUI",
    );
  });
});
