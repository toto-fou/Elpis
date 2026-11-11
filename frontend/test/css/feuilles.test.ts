// SPDX-License-Identifier: MIT
/** frontend/test/css/feuilles.test.ts — feuilles écrites à la main : aucun commentaire refermé par mégarde (un chemin en « *\/ »), accolades équilibrées ; le navigateur avalerait sinon les règles suivantes. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

const CSS = join(import.meta.dirname, "../../css");
const SKINS = readdirSync(join(CSS, "skins"), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) =>
    readdirSync(join(CSS, "skins", d.name))
      .filter((f) => f.endsWith(".css"))
      .map((f) => join("skins", d.name, f)),
  );
const FEUILLES = ["style.css", "editeur.css", ...SKINS];

describe("feuilles CSS", () => {
  it("couvre les feuilles des skins", () => {
    expect(SKINS).toContain(join("skins", "elpis", "skin.css"));
    expect(SKINS).toContain(join("skins", "ardoise", "editeur.css"));
  });

  it.each(FEUILLES)("%s : commentaires fermés une seule fois, accolades équilibrées", (nom) => {
    const sans = readFileSync(join(CSS, nom), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(sans).not.toContain("*/");
    expect(sans).not.toContain("/*");
    expect(sans.split("{").length).toBe(sans.split("}").length);
  });

  it.each(SKINS)("%s : chaque url() mène à un fichier livré, jamais à un serveur", (nom) => {
    const sans = readFileSync(join(CSS, nom), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of sans.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
      const cible = m[1] ?? "";
      if (cible.startsWith("data:")) continue;
      expect(cible, nom).not.toMatch(/^(?:[a-z]+:)?\/\//i);
      expect(existsSync(join(CSS, dirname(nom), cible)), `${nom} : ${cible}`).toBe(true);
    }
  });

  it.each(SKINS.filter((n) => !n.endsWith("polices.css")))(
    "%s : aucune police ici, un export doit se réimporter",
    (nom) => {
      expect(readFileSync(join(CSS, nom), "utf8")).not.toContain("@font-face");
    },
  );

  it("le garde-fou voit un chemin qui referme un commentaire", () => {
    const sans = "/* skins/*/skin.css reste */ a{}".replace(/\/\*[\s\S]*?\*\//g, "");
    expect(sans).toContain("*/");
  });
});
