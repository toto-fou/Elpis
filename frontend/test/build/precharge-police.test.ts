// SPDX-License-Identifier: MIT
/** frontend/test/build/precharge-police.test.ts — la police des icônes est préchargée à l'URL exacte que style.css demande, sur les pages telles que le core les sert (réécriture des `?v=` des vendor comprise) ; celle d'un habillage, à une URL que sa feuille polices.css demande. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Pages } from "../../../apps/core/src/interface/pages";

const FRONTEND = join(import.meta.dirname, "..", "..");
const FEUILLE = "vendor/src/regular/style.css";

/** URL de la police telle que la feuille Phosphor la demande, résolue contre l'URL (avec `?v=`) de la feuille. */
function policeDemandeeParLaFeuille(urlFeuille: URL): string {
  const css = readFileSync(join(FRONTEND, FEUILLE), "utf8");
  const src = /src:\s*url\("([^"]+\.woff2)"\)/u.exec(css);
  expect(src, "première source de @font-face").not.toBeNull();
  return new URL(src![1]!, urlFeuille).href;
}

describe.each([
  ["index.html", "http://elpis.test/"],
  ["admin.html", "http://elpis.test/admin"],
])("%s servie par le core", (page, adressePage) => {
  const html = new Pages(FRONTEND, "BUILD-TEST").rendre(page);
  const modele = /<template id="elpis-habillages">([\s\S]*?)<\/template>/u.exec(html)?.[1] ?? "";
  const balises = [...html.replace(modele, "").matchAll(/<link\b[^>]*>/gu)].map((m) => m[0]);

  it("une seule précharge, de la police woff2, en mode anonyme (celui des polices)", () => {
    const precharges = balises.filter((b) => /\brel="preload"/u.test(b));
    expect(precharges).toHaveLength(1);
    expect(precharges[0]).toMatch(/\bas="font"/u);
    expect(precharges[0]).toMatch(/\btype="font\/woff2"/u);
    expect(precharges[0]).toMatch(/\bcrossorigin\b/u);
  });

  it("habillages : la police préchargée d'un skin est l'une de celles que demande sa feuille polices.css", () => {
    const precharges = [...modele.matchAll(/<link\b[^>]*rel="preload"[^>]*>/gu)].map((m) => m[0]);
    expect(precharges.length).toBeGreaterThan(0);
    for (const b of precharges) {
      const href = /\bhref="([^"]+)"/u.exec(b)![1]!;
      const skin = /\bdata-habillage="([^"]+)"/u.exec(b)![1]!;
      expect(b).toMatch(/\bas="font"[^>]*\btype="font\/woff2"[^>]*\bcrossorigin\b/u);
      const css = readFileSync(join(FRONTEND, "css/skins", skin, "polices.css"), "utf8");
      const demandees = [...css.matchAll(/url\("([^"]+)"\)/gu)].map(
        (m) => new URL(m[1]!, new URL(`static/css/skins/${skin}/polices.css`, adressePage)).href,
      );
      expect(demandees).toContain(new URL(href, adressePage).href);
    }
  });

  it("l'URL préchargée est exactement celle que la feuille demande", () => {
    const precharge = balises.find((b) => /\brel="preload"/u.test(b))!;
    const feuille = balises.find((b) => /\brel="stylesheet"[^>]*regular\/style\.css/u.test(b))!;
    const href = (b: string): string => /\bhref="([^"]+)"/u.exec(b)![1]!;
    const base = new URL(adressePage);
    expect(new URL(href(precharge), base).href).toBe(
      policeDemandeeParLaFeuille(new URL(href(feuille), base)),
    );
  });
});
