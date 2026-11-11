// SPDX-License-Identifier: MIT
/** frontend/test/editor/theme-editeur.test.ts — thème de l'éditeur lié au skin : lecture des couleurs calculées, hex Monaco, mélange, contraste, couleurs de l'éditeur et du terminal, thème posé par nom. */
import { describe, expect, it, vi } from "vitest";

import {
  appliquerThemeElpis,
  contraste,
  couleursMonaco,
  lireCouleur,
  lireJetons,
  melanger,
  themeTerminal,
  THEME_ENCRE,
  THEME_PAPIER,
  versHex,
} from "../../src/features/editor/theme-editeur";

const HEX_MONACO = /^#[0-9a-f]{6}([0-9a-f]{2})?$/;

describe("couleurs calculées", () => {
  it("lit #rgb, #rrggbb, #rrggbbaa, rgb(), rgba() et la syntaxe à barre", () => {
    expect(lireCouleur("#fff")).toEqual([255, 255, 255, 1]);
    expect(lireCouleur(" #1f1b17 ")).toEqual([31, 27, 23, 1]);
    expect(lireCouleur("#00000080")?.[3]).toBeCloseTo(0.502, 2);
    expect(lireCouleur("rgb(184, 138, 61)")).toEqual([184, 138, 61, 1]);
    expect(lireCouleur("rgba(184, 138, 61, 0.22)")).toEqual([184, 138, 61, 0.22]);
    expect(lireCouleur("rgb(15 23 42 / 18%)")).toEqual([15, 23, 42, 0.18]);
    expect(lireCouleur("var(--x)")).toBeNull();
    expect(lireCouleur("")).toBeNull();
  });

  it("écrit l'alpha seulement quand la couleur est translucide", () => {
    expect(versHex([255, 0, 0, 1])).toBe("#ff0000");
    expect(versHex([255, 0, 0, 1], 0.5)).toBe("#ff000080");
    expect(versHex([300, -4, 10.4, 1])).toBe("#ff000a");
  });

  it("mélange et contraste WCAG", () => {
    expect(melanger([0, 0, 0, 1], [255, 255, 255, 1], 0.5)).toEqual([127.5, 127.5, 127.5, 1]);
    expect(contraste([0, 0, 0, 1], [255, 255, 255, 1])).toBeCloseTo(21, 0);
    expect(contraste([255, 255, 255, 1], [255, 255, 255, 1])).toBeCloseTo(1, 5);
  });

  it("jeton illisible ou transparent : valeur sûre ; fond translucide posé sur noir ou blanc", () => {
    const vide = lireJetons(() => "", true);
    expect(vide.fond).toEqual([13, 17, 23, 1]);
    const translucide = lireJetons((n) => (n === "--ed-code-bg" ? "rgba(255, 255, 255, 0.5)" : ""), false);
    expect(translucide.fond).toEqual([255, 255, 255, 1]);
  });
});

describe("jetons du skin", () => {
  const lire =
    (table: Record<string, string>) =>
    (n: string): string =>
      table[n] ?? "";

  it("syntaxe : une règle par jeton posé, commentaires en italique ; rien sans jeton", () => {
    expect(lireJetons(() => "", true).syntaxe).toEqual([]);
    const { syntaxe } = lireJetons(
      lire({ "--ed-syn-mot": "#d8ad62", "--ed-syn-com": "rgb(139, 130, 117)" }),
      true,
    );
    expect(syntaxe).toContainEqual({ token: "keyword", foreground: "d8ad62" });
    expect(syntaxe).toContainEqual({ token: "comment", foreground: "8b8275", fontStyle: "italic" });
    expect(syntaxe.some((r) => r.token === "string")).toBe(false);
  });

  it("accolades : couleur du jeton des opérateurs, sinon celles de Monaco", () => {
    const sans = couleursMonaco(
      lireJetons(() => "", true),
      true,
    );
    expect(sans["editorBracketHighlight.foreground1"]).toBeUndefined();
    const avec = couleursMonaco(lireJetons(lire({ "--ed-syn-op": "#b5ad9f" }), true), true);
    expect(avec["editorBracketHighlight.foreground1"]).toBe("#b5ad9f");
    expect(avec["editorBracketHighlight.foreground6"]).toBe("#b5ad9f");
  });

  it("terminal : --ed-ansi-* puis statuts du skin, sinon la palette par défaut", () => {
    const defaut = themeTerminal(
      lireJetons(() => "", true),
      true,
    );
    expect(defaut.red).toBe("#f47067");
    const statuts = themeTerminal(
      lireJetons(lire({ "--ed-danger": "#e8917f", "--ed-ok": "#9cc08a" }), true),
      true,
    );
    expect(statuts.red).toBe("#e8917f");
    expect(statuts.green).toBe("#9cc08a");
    expect(statuts.blue).toBe(defaut.blue);
    const ansi = themeTerminal(
      lireJetons(
        lire({ "--ed-danger": "#e8917f", "--ed-ansi-rouge": "#ff0000", "--ed-ansi-bleu": "#0000ff" }),
        false,
      ),
      false,
    );
    expect(ansi.red).toBe("#ff0000");
    expect(ansi.blue).toBe("#0000ff");
  });
});

describe("thèmes", () => {
  const jetons = lireJetons(
    (n) =>
      ({
        "--ed-code-bg": "#1f1b17",
        "--ed-code-fg": "#e8e1d5",
        "--ed-code-muted": "#a69a88",
        "--ed-code-accent": "#b88a3d",
        "--ok-text": "#15803d",
        "--danger-text": "#b91c1c",
      })[n] ?? "",
    true,
  );

  it("Monaco : toutes les couleurs en hex valide, fond et marge sur la surface de code", () => {
    const c = couleursMonaco(jetons, true);
    expect(c["editor.background"]).toBe("#1f1b17");
    expect(c["editorGutter.background"]).toBe("#1f1b17");
    expect(c["editor.foreground"]).toBe("#e8e1d5");
    for (const [cle, v] of Object.entries(c)) expect(v, cle).toMatch(HEX_MONACO);
  });

  it("le texte du code reste lisible sur sa surface (AA)", () => {
    expect(contraste(jetons.texte, jetons.fond)).toBeGreaterThanOrEqual(4.5);
  });

  it("terminal : surface du code et les seize couleurs ANSI, en encre comme en papier", () => {
    for (const sombre of [true, false]) {
      const t = themeTerminal(jetons, sombre);
      expect(t.background).toBe("#1f1b17");
      for (const k of ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"]) {
        expect(t[k as keyof typeof t], k).toMatch(HEX_MONACO);
        const vif = "bright" + k.charAt(0).toUpperCase() + k.slice(1);
        expect(t[vif as keyof typeof t], vif).toMatch(HEX_MONACO);
      }
    }
  });

  it("encre ou papier selon la surface réelle, pas seulement selon le réglage", () => {
    const monaco = { editor: { defineTheme: vi.fn(), setTheme: vi.fn() } };
    const racine = document.createElement("div");
    document.body.appendChild(racine);
    racine.style.setProperty("--ed-code-bg", "#ffffff");
    appliquerThemeElpis(monaco, racine, false);
    expect(monaco.editor.defineTheme).toHaveBeenCalledWith(
      THEME_PAPIER,
      expect.objectContaining({ base: "vs", inherit: true }),
    );
    expect(monaco.editor.setTheme).toHaveBeenLastCalledWith(THEME_PAPIER);
    racine.style.setProperty("--ed-code-bg", "#1f1b17");
    appliquerThemeElpis(monaco, racine, true);
    expect(monaco.editor.defineTheme).toHaveBeenLastCalledWith(
      THEME_ENCRE,
      expect.objectContaining({ base: "vs-dark" }),
    );
    expect(monaco.editor.setTheme).toHaveBeenLastCalledWith(THEME_ENCRE);
    // Papier sur une page en mode sombre : la surface est sombre, le thème suit.
    appliquerThemeElpis(monaco, racine, false);
    expect(monaco.editor.setTheme).toHaveBeenLastCalledWith(THEME_ENCRE);
    racine.remove();
  });

  it("jetons inchangés : le thème n'est pas redéfini (Monaco garde sa feuille), seulement reposé ; un jeton changé le redéfinit", () => {
    const monaco = { editor: { defineTheme: vi.fn(), setTheme: vi.fn() } };
    const racine = document.createElement("div");
    document.body.appendChild(racine);
    racine.style.setProperty("--ed-code-bg", "#1f1b17");
    appliquerThemeElpis(monaco, racine, true);
    appliquerThemeElpis(monaco, racine, true);
    expect(monaco.editor.defineTheme).toHaveBeenCalledTimes(1);
    expect(monaco.editor.setTheme).toHaveBeenCalledTimes(2);
    expect(monaco.editor.setTheme).toHaveBeenLastCalledWith(THEME_ENCRE);
    racine.style.setProperty("--ed-code-bg", "#101418");
    appliquerThemeElpis(monaco, racine, true);
    expect(monaco.editor.defineTheme).toHaveBeenCalledTimes(2);
    racine.remove();
  });
});
