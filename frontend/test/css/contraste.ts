// SPDX-License-Identifier: MIT
/** frontend/test/css/contraste.ts — résolution des jetons CSS par thème et calcul des rapports de contraste WCAG. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { analyse, rapport, sur } from "@elpis/commun/couleurs";

const CSS = join(import.meta.dirname, "../../css");
export const THEMES = [
  "ardoise",
  "elpis",
  "argile",
  "llamacpp",
  "emeraude",
  "pingouins",
  "kiki",
  "alize",
] as const;
/** Thèmes portés par une palette : skin qui les héberge et classe de palette. */
export const PALETTES: Readonly<Record<string, { skin: string; palette: string }>> = {
  argile: { skin: "elpis", palette: "argile" },
};
const SOMBRE_DE_BASE = new Set(["emeraude"]);

type Bloc = { sel: string; decl: Map<string, string> };

function blocs(fichier: string): Bloc[] {
  const src = readFileSync(join(CSS, fichier), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Bloc[] = [];
  for (const m of src.matchAll(/(?:^|(?<=\}))\s*([^{}@]+)\{([^{}]*)\}/g)) {
    const decl = new Map<string, string>();
    for (const d of (m[2] ?? "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
      decl.set(d[1] ?? "", (d[2] ?? "").trim());
    if (decl.size) out.push({ sel: (m[1] ?? "").trim(), decl });
  }
  return out;
}

function jetons(theme: string, sombre: boolean): Map<string, string> {
  const tout = new Map<string, string>();
  const pose = (b: Bloc[], sels: string[]) => {
    for (const x of b) if (sels.includes(x.sel)) for (const [k, v] of x.decl) tout.set(k, v);
  };
  const base = blocs("style.css");
  const darkSurface = sombre || SOMBRE_DE_BASE.has(theme);
  pose(base, [":root"]);
  if (sombre) pose(base, ["body.elpis-app-dark"]);
  if (darkSurface) pose(base, ["body.elpis-dark-surface"]);
  const p = PALETTES[theme];
  const skin = p?.skin ?? theme;
  if (skin !== "ardoise") {
    const sk = blocs(`skins/${skin}/skin.css`);
    pose(sk, [`body.elpis-skin-${skin}`]);
    if (sombre) pose(sk, [`body.elpis-skin-${skin}.elpis-app-dark`]);
    if (p) {
      pose(sk, [`body.elpis-skin-${skin}.elpis-palette-${p.palette}`]);
      if (sombre) pose(sk, [`body.elpis-skin-${skin}.elpis-palette-${p.palette}.elpis-app-dark`]);
    }
  }
  return tout;
}

export function resous(theme: string, sombre: boolean): (nom: string) => string | undefined {
  const j = jetons(theme, sombre);
  const val = (nom: string, prof = 0): string | undefined => {
    const v = j.get(nom);
    if (v === undefined || prof > 8) return undefined;
    const m = /^var\((--[\w-]+)(?:\s*,\s*([^)]+))?\)$/.exec(v);
    return m ? (val(m[1] ?? "", prof + 1) ?? m[2]?.trim()) : v;
  };
  return (nom) => val(nom);
}

export function mesure(theme: string, sombre: boolean, fg: string, fond: string): number | null {
  const r = resous(theme, sombre);
  const f = analyse(r(fond));
  const t = analyse(r(fg));
  if (!f || !t) return null;
  return rapport(sur(t, f), f);
}
