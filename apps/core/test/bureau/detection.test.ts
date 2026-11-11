// SPDX-License-Identifier: MIT
/** apps/core/test/bureau/detection.test.ts — prompts VISION_*.md éditables (relus à chaud, fins de ligne de Python) et capture réduite avant l'envoi. */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import { detect, DETECT_MAX_WIDTH, extractJsonArray, LLM_READ_PROMPT, promptText } from "../../src/bureau";
import type { RequetePost } from "../../src/bureau";
import { dimensionsImage } from "@elpis/images";
import { png } from "../images/fabrique";

const racine = process.env["ELPIS_RACINE"];
afterEach(() => {
  if (racine === undefined) delete process.env["ELPIS_RACINE"];
  else process.env["ELPIS_RACINE"] = racine;
});

describe("prompts éditables", () => {
  it("fins de ligne CRLF lues comme Python (\\n), relecture quand la date change, repli si vide", () => {
    const d = mkdtempSync(join(tmpdir(), "elpis-prompts-"));
    onTestFinished(() => rmSync(d, { recursive: true, force: true }));
    mkdirSync(join(d, "system_prompts"));
    process.env["ELPIS_RACINE"] = d;
    const fichier = join(d, "system_prompts", "VISION_READ.md");
    writeFileSync(fichier, "  Ligne 1\r\nLigne 2\rLigne 3\n\n");
    expect(promptText("VISION_READ")).toBe("Ligne 1\nLigne 2\nLigne 3");
    writeFileSync(fichier, "Autre");
    utimesSync(fichier, 1_000_000, 1_000_000);
    expect(promptText("VISION_READ")).toBe("Autre");
    writeFileSync(fichier, " \n");
    utimesSync(fichier, 2_000_000, 2_000_000);
    expect(promptText("VISION_READ")).toBe(LLM_READ_PROMPT);
    expect(promptText("INCONNU")).toBe("");
  });
});

describe("capture envoyée au détecteur", () => {
  it(`plus large que ${DETECT_MAX_WIDTH} px : réduite, boîtes ramenées en pixels natifs`, async () => {
    const large = png(3840, 2160, [255, 255, 255, 255]);
    const vues: RequetePost[] = [];
    const r = await detect(large, {
      endpoint: "http://det/x",
      poster: async (q) => {
        vues.push(q);
        return {
          statut: 200,
          corps: Buffer.from('{"elements": [{"box": [960, 540, 1920, 1080]}]}'),
          typeContenu: "application/json",
        };
      },
    });
    expect(r.elements[0]?.box).toEqual([1920, 1080, 3840, 2160]);
    const corps = JSON.parse(Buffer.from(vues[0]?.corps ?? []).toString("utf-8")) as { image: string };
    const envoye = Buffer.from(corps.image.split(",")[1] ?? "", "base64");
    expect(dimensionsImage(envoye)).toEqual([1920, 1080]);
  });
});

describe("tableau JSON d'une réponse de LLM", () => {
  it("blocs <think> retirés comme avant, longue suite de <think> non fermés en temps linéaire", () => {
    expect(extractJsonArray('<think>[9]</think> ```json\n[{"a": 1}]\n```')).toEqual([{ a: 1 }]);
    expect(extractJsonArray("<think>x</think>[1]<think>y</think>")).toEqual([1]);
    expect(extractJsonArray("<think>[1]")).toEqual([1]);
    const debut = performance.now();
    expect(extractJsonArray("<think>".repeat(40_000) + "[1, 2]")).toEqual([1, 2]);
    expect(performance.now() - debut).toBeLessThan(1000);
  });
});
