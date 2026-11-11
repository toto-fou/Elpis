// SPDX-License-Identifier: MIT
/** frontend/test/css/contraste-editeur.test.ts — jetons d'éditeur de chaque skin intégré : présence du fichier, couleurs lisibles par le thème Monaco, contraste texte 4,5:1 et interface 3:1. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { analyse, rapport, SEUIL_INTERFACE, SEUIL_TEXTE, sur } from "@elpis/commun/couleurs";
import { describe, expect, it } from "vitest";

import { PALETTES, THEMES } from "./contraste";

const SKINS = join(import.meta.dirname, "../../css/skins");
const MODES = ["encre", "papier"] as const;

/** Jetons d'un mode, lus dans le fichier editeur.css du skin. */
function jetons(theme: string, mode: string): Map<string, string> {
  const p = PALETTES[theme];
  const src = readFileSync(join(SKINS, p?.skin ?? theme, "editeur.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const prefixe = p ? `\\.elpis-palette-${p.palette}\\s+` : "";
  const bloc = new RegExp(`${prefixe}\\.ed2--${mode}\\s*\\{([^}]*)\\}`).exec(src)?.[1] ?? "";
  const out = new Map<string, string>();
  for (const d of bloc.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(d[1] ?? "", (d[2] ?? "").trim());
  return out;
}

const TEXTE: readonly (readonly [string, string])[] = [
  ["--ed-ink", "--ed-plan"],
  ["--ed-ink-2", "--ed-plan"],
  ["--ed-muted", "--ed-plan"],
  ["--ed-ink", "--ed-releve"],
  ["--ed-ink-2", "--ed-bande"],
  ["--ed-muted", "--ed-bande"],
  ["--ed-ok", "--ed-plan"],
  ["--ed-warn", "--ed-plan"],
  ["--ed-danger", "--ed-plan"],
  ["--ed-accent-fg", "--ed-accent"],
  ["--ed-syn-mot", "--ed-plan"],
  ["--ed-syn-texte", "--ed-plan"],
  ["--ed-syn-nombre", "--ed-plan"],
  ["--ed-syn-com", "--ed-plan"],
  ["--ed-syn-type", "--ed-plan"],
  ["--ed-syn-var", "--ed-plan"],
  ["--ed-syn-op", "--ed-plan"],
];
const ICONES = [
  "--ed-ic-dossier",
  "--ed-ic-bleu",
  "--ed-ic-jaune",
  "--ed-ic-orange",
  "--ed-ic-vert",
  "--ed-ic-fichier",
];
const LUS_PAR_LE_THEME = [
  "--ed-code-bg",
  "--ed-code-fg",
  "--ed-code-muted",
  "--ed-code-accent",
  "--ed-syn-mot",
  "--ed-syn-texte",
  "--ed-syn-nombre",
  "--ed-syn-com",
  "--ed-syn-type",
  "--ed-syn-var",
  "--ed-syn-op",
  "--ed-ok",
  "--ed-warn",
  "--ed-danger",
];

describe("skins intégrés : éditeur lié", () => {
  it.each(THEMES)("%s a son editeur.css", (theme) => {
    expect(existsSync(join(SKINS, PALETTES[theme]?.skin ?? theme, "editeur.css"))).toBe(true);
  });
});

describe.each(THEMES.flatMap((t) => MODES.map((m) => [t, m] as const)))("éditeur %s, %s", (theme, mode) => {
  const j = jetons(theme, mode);
  const couleur = (nom: string) => {
    const c = analyse(j.get(nom));
    if (!c) throw new Error(`${nom} absent ou illisible`);
    return c;
  };

  it("les jetons lus par le thème sont des couleurs opaques simples", () => {
    for (const nom of LUS_PAR_LE_THEME) expect(couleur(nom)[3], nom).toBe(1);
    expect(j.get("--ed-code-bg")).toBe(j.get("--ed-plan"));
  });

  it.each(TEXTE)("%s sur %s : au moins 4,5:1", (fg, fond) => {
    expect(rapport(couleur(fg), couleur(fond))).toBeGreaterThanOrEqual(SEUIL_TEXTE);
  });

  it("rangée active : encre de sélection lisible sur son fond", () => {
    const fond = sur(couleur("--ed-select"), couleur("--ed-plan"));
    expect(rapport(couleur("--ed-select-ink"), fond)).toBeGreaterThanOrEqual(SEUIL_TEXTE);
  });

  it("accent et icônes de type : au moins 3:1", () => {
    expect(rapport(couleur("--ed-accent"), couleur("--ed-plan"))).toBeGreaterThanOrEqual(SEUIL_INTERFACE);
    for (const nom of ICONES)
      if (j.has(nom))
        expect(rapport(couleur(nom), couleur("--ed-plan")), nom).toBeGreaterThanOrEqual(SEUIL_INTERFACE);
  });
});
