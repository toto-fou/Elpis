// SPDX-License-Identifier: MIT
/** apps/core/test/ecart-fusion-skins.ts — écarts voulus au Python : Parchemin fondu dans Elpis (palette Argile), avec le réglage `skin_palette` et les palettes du registre ; skins Alizé, Veilleuse et Terminal, ajoutés après lui. */

/** Entrées de registre absentes des vecteurs ou retirées depuis. */
const SKINS_HORS_VECTEURS = new Set<unknown>(["parchemin", "alize", "veilleuse", "terminal"]);

/** Valeur JSON sans ce qui a changé : entrées et clés Parchemin, Alizé, Veilleuse et Terminal, palettes, description d'Elpis, `skin_palette`. */
export function sansFusion(v: unknown): unknown {
  if (Array.isArray(v))
    return v
      .filter(
        (x) => !(x !== null && typeof x === "object" && SKINS_HORS_VECTEURS.has((x as { id?: unknown }).id)),
      )
      .map(sansFusion);
  if (v === null || typeof v !== "object") return v === "parchemin" ? "elpis" : v;
  const entree = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(entree)) {
    if (SKINS_HORS_VECTEURS.has(k) || k === "palettes" || k === "skin_palette") continue;
    out[k] = k === "desc" && entree["id"] === "elpis" ? "" : sansFusion(x);
  }
  return out;
}

/** La même chose sur un résultat au format JSON. */
export function texteSansFusion(json: string): string {
  return JSON.stringify(sansFusion(JSON.parse(json)));
}

/** `config.json` attendu sans les clés Parchemin, Alizé, Veilleuse et Terminal. */
export function configSansFusion(texte: string): string {
  return texte.replace(/,?\n\s*"(?:parchemin|alize|veilleuse|terminal)": (?:true|false)/g, "");
}

/** Corps compact d'une réponse de réglages sans ce que la fusion change : `skin_palette` retiré, ancien skin ramené à sa cible. */
export function corpsSansFusion(corps: unknown): unknown {
  if (typeof corps !== "string") return corps;
  return corps.replace(/"skin_palette":"[^"]*",/g, "").replace(/"skin":"parchemin"/g, '"skin":"elpis"');
}

/** Document de réglages stocké sans ce que la fusion change. */
export function documentSansFusion(texte: string): string {
  const d = JSON.parse(texte) as Record<string, unknown>;
  delete d["skin_palette"];
  if (d["skin"] === "parchemin") d["skin"] = "elpis";
  return JSON.stringify(d);
}
