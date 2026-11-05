// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/theme-editeur.ts — thème Monaco et terminal de l'éditeur lié au skin, tirés des jetons calculés de son editeur.css (encre ou papier). */
import type { ITheme } from "@xterm/xterm";

export type Rgba = readonly [number, number, number, number];

const HEX = /^#([0-9a-f]{3,8})$/i;
const RGB = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i;

/** Couleur CSS calculée (#rgb, #rrggbb, #rrggbbaa, rgb(), rgba()) ; `null` si illisible. */
export function lireCouleur(brut: string): Rgba | null {
  const c = brut.trim();
  const h = HEX.exec(c);
  if (h) {
    let x = h[1] ?? "";
    if (x.length === 3 || x.length === 4) x = [...x].map((ch) => ch + ch).join("");
    if (x.length !== 6 && x.length !== 8) return null;
    const n = (i: number): number => parseInt(x.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), x.length === 8 ? n(6) / 255 : 1];
  }
  const m = RGB.exec(c);
  if (!m) return null;
  const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return [Number(m[1]), Number(m[2]), Number(m[3]), Math.max(0, Math.min(1, a))];
}

const deux = (v: number): string =>
  Math.round(Math.max(0, Math.min(255, v)))
    .toString(16)
    .padStart(2, "0");

/** Hex Monaco : #rrggbb, ou #rrggbbaa quand la couleur est translucide. */
export function versHex(c: Rgba, alpha = c[3]): string {
  const base = "#" + deux(c[0]) + deux(c[1]) + deux(c[2]);
  return alpha >= 1 ? base : base + deux(alpha * 255);
}

/** `a` posé sur `fond` à l'opacité `t` (couleur opaque). */
export function melanger(fond: Rgba, a: Rgba, t: number): Rgba {
  return [fond[0] + (a[0] - fond[0]) * t, fond[1] + (a[1] - fond[1]) * t, fond[2] + (a[2] - fond[2]) * t, 1];
}

/** Luminance relative WCAG. */
export function luminance(c: Rgba): number {
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

export function contraste(a: Rgba, b: Rgba): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** Règle de coloration de Monaco (`foreground` sans #). */
export interface RegleSyntaxe {
  token: string;
  foreground: string;
  fontStyle?: string;
}

/** Palette ANSI posée par le skin : couleurs absentes = palette par défaut du terminal. */
export type PaletteAnsi = Partial<Record<"red" | "green" | "yellow" | "blue" | "magenta" | "cyan", Rgba>>;

/** Jetons lus pour le thème : surface de code, encre, discret, accent, succès, danger, syntaxe, accolades, ANSI. */
export interface JetonsCode {
  fond: Rgba;
  texte: Rgba;
  discret: Rgba;
  accent: Rgba;
  ok: Rgba;
  danger: Rgba;
  syntaxe: RegleSyntaxe[];
  accolade: Rgba | null;
  ansi: PaletteAnsi;
}

const SYNTAXE: readonly (readonly [token: string, jeton: string, style?: string])[] = [
  ["keyword", "--ed-syn-mot"],
  ["storage", "--ed-syn-mot"],
  ["tag", "--ed-syn-mot"],
  ["string", "--ed-syn-texte"],
  ["attribute.value", "--ed-syn-texte"],
  ["number", "--ed-syn-nombre"],
  ["regexp", "--ed-syn-nombre"],
  ["constant", "--ed-syn-nombre"],
  ["comment", "--ed-syn-com", "italic"],
  ["type", "--ed-syn-type"],
  ["attribute.name", "--ed-syn-type"],
  ["identifier", "--ed-syn-var"],
  ["variable", "--ed-syn-var"],
  ["delimiter", "--ed-syn-op"],
  ["operator", "--ed-syn-op"],
];

const ANSI: readonly (readonly [couleur: keyof PaletteAnsi, jeton: string, repli?: string])[] = [
  ["red", "--ed-ansi-rouge", "--ed-danger"],
  ["green", "--ed-ansi-vert", "--ed-ok"],
  ["yellow", "--ed-ansi-jaune", "--ed-warn"],
  ["blue", "--ed-ansi-bleu"],
  ["magenta", "--ed-ansi-magenta"],
  ["cyan", "--ed-ansi-cyan"],
];

const NOIR: Rgba = [0, 0, 0, 1];
const BLANC: Rgba = [255, 255, 255, 1];

/** Jetons lus sur l'élément racine de l'éditeur ; un jeton illisible prend une valeur sûre. */
export function lireJetons(lire: (nom: string) => string, sombre: boolean): JetonsCode {
  const ou = (nom: string, repli: Rgba): Rgba => {
    const c = lireCouleur(lire(nom));
    return c && c[3] > 0 ? c : repli;
  };
  const fond = ou("--ed-code-bg", sombre ? [13, 17, 23, 1] : BLANC);
  const fondOpaque: Rgba = fond[3] < 1 ? melanger(sombre ? NOIR : BLANC, fond, fond[3]) : fond;
  const facultatif = (nom: string): Rgba | null => {
    const c = lireCouleur(lire(nom));
    return c && c[3] > 0 ? c : null;
  };
  const syntaxe: RegleSyntaxe[] = [];
  for (const [token, jeton, fontStyle] of SYNTAXE) {
    const c = facultatif(jeton);
    if (c) syntaxe.push({ token, foreground: versHex(c, 1).slice(1), ...(fontStyle ? { fontStyle } : {}) });
  }
  const ansi: PaletteAnsi = {};
  for (const [couleur, jeton, repli] of ANSI) {
    const c = facultatif(jeton) ?? (repli ? facultatif(repli) : null);
    if (c) ansi[couleur] = c;
  }
  return {
    fond: fondOpaque,
    texte: ou("--ed-code-fg", sombre ? [201, 209, 217, 1] : [30, 41, 59, 1]),
    discret: ou("--ed-code-muted", sombre ? [139, 148, 158, 1] : [100, 116, 139, 1]),
    accent: ou("--ed-code-accent", [37, 99, 235, 1]),
    ok: ou("--ok-text", [22, 163, 74, 1]),
    danger: ou("--danger-text", [220, 38, 38, 1]),
    syntaxe,
    accolade: facultatif("--ed-syn-op"),
    ansi,
  };
}

/** Couleurs de l'éditeur Monaco (thème hérité de vs / vs-dark : la coloration syntaxique reste la sienne). */
export function couleursMonaco(j: JetonsCode, sombre: boolean): Record<string, string> {
  const f = j.fond;
  const t = j.texte;
  const releve = melanger(f, t, sombre ? 0.06 : 0.035);
  const ligne = (a: number): string => versHex(t, a);
  const accolades: Record<string, string> = {};
  if (j.accolade)
    for (const i of [1, 2, 3, 4, 5, 6])
      accolades[`editorBracketHighlight.foreground${i}`] = versHex(j.accolade, 1);
  return {
    ...accolades,
    "editorUnnecessaryCode.opacity": "#000000b8",
    "editor.background": versHex(f),
    "editor.foreground": versHex(t),
    "editorGutter.background": versHex(f),
    "editorLineNumber.foreground": versHex(j.discret, 0.75),
    "editorLineNumber.activeForeground": versHex(t),
    "editor.lineHighlightBackground": ligne(sombre ? 0.045 : 0.035),
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": versHex(j.accent, sombre ? 0.34 : 0.22),
    "editor.inactiveSelectionBackground": versHex(j.accent, sombre ? 0.18 : 0.12),
    "editor.selectionHighlightBackground": versHex(j.accent, 0.14),
    "editor.wordHighlightBackground": versHex(j.accent, 0.12),
    "editor.findMatchHighlightBackground": versHex(j.accent, 0.22),
    "editorCursor.foreground": versHex(sombre ? melanger(j.accent, BLANC, 0.25) : j.accent),
    "editorIndentGuide.background1": ligne(0.08),
    "editorIndentGuide.activeBackground1": ligne(0.22),
    "editorWhitespace.foreground": ligne(0.16),
    "editorRuler.foreground": ligne(0.08),
    "editorBracketMatch.background": versHex(j.accent, 0.16),
    "editorBracketMatch.border": versHex(j.accent, 0.5),
    "editorWidget.background": versHex(releve),
    "editorWidget.border": ligne(0.12),
    "editorSuggestWidget.background": versHex(releve),
    "editorSuggestWidget.border": ligne(0.12),
    "editorSuggestWidget.selectedBackground": versHex(j.accent, sombre ? 0.3 : 0.16),
    "editorHoverWidget.background": versHex(releve),
    "editorHoverWidget.border": ligne(0.12),
    "editorStickyScroll.background": versHex(f),
    "editorStickyScrollHover.background": versHex(releve),
    "input.background": versHex(f),
    "input.border": ligne(0.16),
    focusBorder: versHex(j.accent, 0.7),
    "scrollbar.shadow": "#00000000",
    "scrollbarSlider.background": ligne(0.1),
    "scrollbarSlider.hoverBackground": ligne(0.18),
    "scrollbarSlider.activeBackground": ligne(0.26),
    "minimap.background": versHex(f),
    "diffEditor.insertedTextBackground": versHex(j.ok, sombre ? 0.22 : 0.16),
    "diffEditor.removedTextBackground": versHex(j.danger, sombre ? 0.22 : 0.14),
    "diffEditor.insertedLineBackground": versHex(j.ok, sombre ? 0.1 : 0.08),
    "diffEditor.removedLineBackground": versHex(j.danger, sombre ? 0.1 : 0.07),
    "diffEditorGutter.insertedLineBackground": versHex(j.ok, 0.16),
    "diffEditorGutter.removedLineBackground": versHex(j.danger, 0.16),
    "diffEditor.diagonalFill": ligne(0.08),
  };
}

/** Couleurs du terminal (xterm) : même surface que le code, palette ANSI lisible sur encre comme sur papier, surchargée par le skin. */
export function themeTerminal(j: JetonsCode, sombre: boolean): ITheme {
  const f = versHex(j.fond);
  const duSkin: ITheme = {};
  for (const [couleur, c] of Object.entries(j.ansi)) duSkin[couleur as keyof PaletteAnsi] = versHex(c, 1);
  const commun = {
    background: f,
    foreground: versHex(j.texte),
    cursor: versHex(sombre ? melanger(j.accent, BLANC, 0.25) : j.accent),
    cursorAccent: f,
    selectionBackground: versHex(j.accent, sombre ? 0.38 : 0.24),
  };
  if (sombre)
    return {
      ...commun,
      black: f,
      red: "#f47067",
      green: "#7fbf7f",
      yellow: "#d9b66f",
      blue: "#6cb6ff",
      magenta: "#d2a8ff",
      cyan: "#56c7c0",
      white: versHex(j.texte),
      brightBlack: versHex(j.discret),
      brightRed: "#ff8f87",
      brightGreen: "#9bd89b",
      brightYellow: "#ecc98a",
      brightBlue: "#94cbff",
      brightMagenta: "#e2c5ff",
      brightCyan: "#7fdcd5",
      brightWhite: "#f4f1ea",
      ...duSkin,
    };
  return {
    ...commun,
    black: "#24292f",
    red: "#b42318",
    green: "#1f7a3a",
    yellow: "#8a5a00",
    blue: "#1f5fbf",
    magenta: "#8239b8",
    cyan: "#0f6f73",
    white: "#5b6470",
    brightBlack: versHex(j.discret),
    brightRed: "#c93a2c",
    brightGreen: "#26874a",
    brightYellow: "#9a6700",
    brightBlue: "#2f6fd1",
    brightMagenta: "#9446c9",
    brightCyan: "#12807f",
    brightWhite: "#1f2328",
    ...duSkin,
  };
}

export const THEME_ENCRE = "elpis-encre";
export const THEME_PAPIER = "elpis-papier";

interface MonacoThemes {
  editor: {
    defineTheme(
      nom: string,
      t: {
        base: "vs" | "vs-dark";
        inherit: boolean;
        rules: RegleSyntaxe[];
        colors: Record<string, string>;
      },
    ): void;
    setTheme(nom: string): void;
  };
}

/** Jetons lus sur `racine` ; sombre selon la surface réelle (papier sur une page en mode sombre, thème à base sombre). */
export function jetonsDe(racine: Element, sombreDemande: boolean): { j: JetonsCode; sombre: boolean } {
  const style = getComputedStyle(racine);
  const j = lireJetons((n) => style.getPropertyValue(n), sombreDemande);
  return { j, sombre: luminance(j.fond) < 0.18 };
}

/** Définit et pose le thème de l'éditeur lié au skin depuis les jetons de `racine` ; renvoie le thème du terminal. */
export function appliquerThemeElpis(monaco: MonacoThemes, racine: Element, sombreDemande: boolean): ITheme {
  const { j, sombre } = jetonsDe(racine, sombreDemande);
  const nom = sombre ? THEME_ENCRE : THEME_PAPIER;
  monaco.editor.defineTheme(nom, {
    base: sombre ? "vs-dark" : "vs",
    inherit: true,
    rules: j.syntaxe,
    colors: couleursMonaco(j, sombre),
  });
  monaco.editor.setTheme(nom);
  return themeTerminal(j, sombre);
}
