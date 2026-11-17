// SPDX-License-Identifier: MIT
/** apps/core/test/evenements/sse-encodage.test.ts — donnée SSE : seuls les `\n` finaux tombent, et en temps linéaire. */
import { describe, expect, it } from "vitest";

import { encoderDonneeSse } from "../../src/evenements/sse";

describe("encoderDonneeSse", () => {
  it("retire les \\n finaux seulement ; chaque ligne devient un champ data", () => {
    expect(encoderDonneeSse("a\nb\n\n\n")).toBe("data: a\r\ndata: b\r\n\r\n");
    expect(encoderDonneeSse("\n\n")).toBe("data: \r\n\r\n");
    expect(encoderDonneeSse("a\r\n")).toBe("data: a\r\ndata: \r\n\r\n");
  });

  it("une longue suite de sauts de ligne avant du texte s'encode en temps linéaire", () => {
    const debut = performance.now();
    const trame = encoderDonneeSse("\n".repeat(200_000) + "x");
    expect(performance.now() - debut).toBeLessThan(2_000);
    expect(trame.endsWith("data: x\r\n\r\n")).toBe(true);
  });
});
