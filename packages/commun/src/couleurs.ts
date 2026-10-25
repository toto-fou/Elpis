// SPDX-License-Identifier: MIT
/** packages/commun/src/couleurs.ts — lecture des couleurs CSS (hex, rgb, hsl, oklch), composition alpha, luminance, rapport de contraste WCAG et paires de texte exigées. */

export type Rgba = [number, number, number, number];

const borne = (v: number, bas: number, haut: number): number => Math.min(haut, Math.max(bas, v));

function oklch(l: number, ch: number, h: number, a: number): Rgba {
  const hr = (h * Math.PI) / 180;
  const A = ch * Math.cos(hr);
  const B = ch * Math.sin(hr);
  const l_ = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m_ = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s_ = (l - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  const g = (v: number) =>
    Math.round(255 * borne(v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055, 0, 1));
  return [g(lin[0] ?? 0), g(lin[1] ?? 0), g(lin[2] ?? 0), a];
}

function hsl(h: number, s: number, l: number, a: number): Rgba {
  const k = (n: number) => (n + h / 30) % 12;
  const m = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - m * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return [f(0), f(8), f(4), a];
}

const alphaDe = (s: string | undefined): number => {
  if (s === undefined || s === "") return 1;
  return borne(s.endsWith("%") ? Number.parseFloat(s) / 100 : Number(s), 0, 1);
};

/** Couleur CSS en [r, g, b, alpha] (0–255, 0–1) ; `null` si la forme n'est pas lue. */
export function analyse(c: string | undefined): Rgba | null {
  if (!c) return null;
  const h = /^#([0-9a-f]{3,8})$/i.exec(c);
  if (h) {
    let s = h[1] ?? "";
    if (s.length <= 4) s = [...s].map((x) => x + x).join("");
    const n = (i: number) => parseInt(s.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), s.length === 8 ? n(6) / 255 : 1];
  }
  const o = /^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/i.exec(c);
  if (o) return oklch(Number(o[1]), Number(o[2]), Number(o[3]), o[4] === undefined ? 1 : Number(o[4]));
  const r = /^rgba?\(([^)]+)\)$/i.exec(c);
  if (r) {
    const p = (r[1] ?? "").trim().split(/[\s,/]+/);
    const canal = (x: string | undefined): number =>
      x?.endsWith("%") ? (Number.parseFloat(x) / 100) * 255 : Number(x ?? 0);
    return [canal(p[0]), canal(p[1]), canal(p[2]), alphaDe(p[3])];
  }
  const t = /^hsla?\(([^)]+)\)$/i.exec(c);
  if (t) {
    const p = (t[1] ?? "").trim().split(/[\s,/]+/);
    const teinte = ((Number.parseFloat(p[0] ?? "0") % 360) + 360) % 360 || 0;
    return hsl(
      teinte,
      borne(Number.parseFloat(p[1] ?? "0"), 0, 100) / 100,
      borne(Number.parseFloat(p[2] ?? "0"), 0, 100) / 100,
      alphaDe(p[3]),
    );
  }
  return null;
}

/** Couleur `fg` posée sur `fond` (alpha composé), opaque. */
export function sur(fg: Rgba, fond: Rgba): Rgba {
  const a = fg[3];
  return [0, 1, 2].map((i) => (fg[i] ?? 0) * a + (fond[i] ?? 0) * (1 - a)).concat([1]) as Rgba;
}

/** Luminance relative WCAG. */
export function luminance([r, g, b]: Rgba): number {
  const f = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** Rapport de contraste WCAG entre deux couleurs opaques. */
export function rapport(a: Rgba, b: Rgba): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Mélange : `part` (0–1) de `a`, le reste de `b`, canal par canal (alpha compris). */
export function melanger(a: Rgba, b: Rgba, part: number): Rgba {
  return [0, 1, 2, 3].map((i) => (a[i] ?? 0) * part + (b[i] ?? 0) * (1 - part)) as Rgba;
}

/** `#rrggbb` si opaque, sinon `rgba(r, g, b, a)`. */
export function versCss(c: Rgba): string {
  const [r, g, b] = c.slice(0, 3).map((v) => Math.round(borne(v, 0, 255)));
  if (c[3] >= 1) return `#${[r, g, b].map((v) => (v ?? 0).toString(16).padStart(2, "0")).join("")}`;
  return `rgba(${r}, ${g}, ${b}, ${Math.round(borne(c[3], 0, 1) * 1000) / 1000})`;
}

export const SEUIL_TEXTE = 4.5;
export const SEUIL_INTERFACE = 3;

/** Paires [texte, fond] de jetons exigées à 4,5:1 dans chaque thème livré et dans un habillage personnel. */
export const PAIRES_TEXTE: readonly (readonly [string, string])[] = [
  ["--ok-text", "--surface"],
  ["--ok-text-strong", "--surface"],
  ["--warn-text", "--surface"],
  ["--warn-text-strong", "--surface"],
  ["--danger-text", "--surface"],
  ["--text-400", "--surface"],
  ["--text-500", "--surface"],
  ["--accent-text", "--surface"],
  ["--accent-text", "--app-bg"],
  ["--accent-text-strong", "--surface"],
  ["--accent-fg", "--accent"],
  ["--ok-fg", "--ok"],
];
