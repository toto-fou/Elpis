// SPDX-License-Identifier: MIT
/** packages/mcp/test/securite-origine.test.ts — l'en-tête `Origin` se normalise sans retour arrière et une valeur démesurée est refusée d'emblée. */
import "./environnement";

import { beforeAll, describe, expect, it } from "vitest";

import { stripPy } from "@elpis/commun";

import { familleNette } from "../../../apps/core/src/familles/pont-mcp";
import { originAllowed } from "../src";

const AUTORISEE = "https://app.example:8443";

beforeAll(() => {
  process.env["LOCAL_MCP_ALLOWED_ORIGINS"] = `${AUTORISEE}/, http://lan.example:*`;
});

describe("originAllowed", () => {
  it("garde les règles habituelles", () => {
    expect(originAllowed(null)).toBe(true);
    expect(originAllowed(undefined)).toBe(true);
    expect(originAllowed("   ")).toBe(true);
    expect(originAllowed(AUTORISEE)).toBe(true);
    expect(originAllowed(`${AUTORISEE}/`)).toBe(true);
    expect(originAllowed(`  ${AUTORISEE.toUpperCase()}/// `)).toBe(true);
    expect(originAllowed("http://lan.example:9000")).toBe(true);
    expect(originAllowed("http://lan.example:abc")).toBe(false);
    expect(originAllowed("https://autre.example")).toBe(false);
    expect(originAllowed("null")).toBe(false);
    expect(originAllowed("app.example")).toBe(false);
  });

  it("retire les barres finales jusqu'à la limite de longueur", () => {
    expect(originAllowed(AUTORISEE + "/".repeat(2048 - AUTORISEE.length))).toBe(true);
  });

  it("refuse une origine démesurée même si elle se normaliserait en origine autorisée", () => {
    expect(originAllowed(AUTORISEE + "/".repeat(2049 - AUTORISEE.length))).toBe(false);
    expect(originAllowed(AUTORISEE + "/".repeat(50_000))).toBe(false);
  });

  it("ne bloque pas sur une longue suite de barres suivie d'un autre caractère", () => {
    const debut = performance.now();
    expect(originAllowed(`https://a${"/".repeat(100_000)}x`)).toBe(false);
    expect(originAllowed(`https://a${"/".repeat(2000)}x`)).toBe(false);
    expect(performance.now() - debut).toBeLessThan(1000);
  });
});

describe("familleNette", () => {
  it.each(["shell", "/shell/", "  //shell//  ", "", "   ", "///", "a/b", "/a//b/", " / a / ", "é/😀/"])(
    "donne le même résultat que l'ancienne regex : %j",
    (valeur) => {
      expect(familleNette(valeur)).toBe(stripPy(valeur).replace(/^\/+|\/+$/gu, ""));
    },
  );

  it("ne bloque pas sur une longue suite de barres au milieu du segment", () => {
    const valeur = `a${"/".repeat(100_000)}x`;
    const debut = performance.now();
    const sortie = familleNette(valeur);
    expect(performance.now() - debut).toBeLessThan(1000);
    expect(sortie === valeur).toBe(true);
  });
});
