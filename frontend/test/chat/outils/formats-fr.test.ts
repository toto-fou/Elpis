// SPDX-License-Identifier: MIT
/** frontend/test/chat/outils/formats-fr.test.ts — formats du fil en français (« 12,3 k », « 1,2 s », jetons). */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { fmtKvCache, fmtTokens, fmtToolMs, metricsTooltip } from "../../../src/features/chat/coeur/formats";
import { fmtCompression, fmtDuree, fmtTokensCourt } from "../../../src/features/chat/outils/format";

describe("formats en français", () => {
  it("durées : virgule décimale sous 10 s, puis secondes, minutes, heures", () => {
    expect([50, 400, 1250, 3000, 18_400, 82_000, 7_503_000].map(fmtDuree)).toEqual([
      "< 0,1 s",
      "0,4 s",
      "1,2 s",
      "3 s",
      "18 s",
      "1 min 22 s",
      "2 h 05 min",
    ]);
    expect(fmtToolMs(1250)).toBe("1,2 s");
  });

  it("jetons : « 12,3 k », « 1,2 M », même format partout", () => {
    expect([fmtTokens(12_300), fmtTokensCourt(12_300), fmtTokens(1_234_567), fmtTokens(845)]).toEqual([
      "12,3 k",
      "12,3 k",
      "1,2 M",
      "845",
    ]);
    expect(fmtKvCache({ kv_cache: { used: 12_300, total: 32_768 } })).toBe("12,3 k/32,8 k");
    expect(fmtCompression({ tokens_before: 31_000, tokens_after: 9000, tokens_saved: 22_000 })).toBe(
      "31 k → 9 k jetons (−71 %)",
    );
    expect(
      metricsTooltip({ model: "m", input_tokens: 10, read_tps: 45, output_tokens: 5, write_tps: 30 }),
    ).toContain("45 jetons/s");
  });
});

describe("cibles des sous-agents (déroulé Classique)", () => {
  it("l'œil et le ✕ font au moins 24 px", () => {
    const css = fs.readFileSync(path.resolve(import.meta.dirname, "../../../css/style.css"), "utf8");
    for (const sel of [".task-run-eye", ".task-run-cancel"]) {
      const bloc = css.slice(css.indexOf(sel + " {"), css.indexOf("}", css.indexOf(sel + " {")));
      expect(bloc).toMatch(/width:\s*24px/);
      expect(bloc).toMatch(/height:\s*24px/);
    }
  });
});
