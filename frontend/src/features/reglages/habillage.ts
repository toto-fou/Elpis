// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/habillage.ts — habillage posé sur la page (classes du body) et dernier état connu gardé dans le navigateur, relu avant le premier rendu par le script de apps/core/src/interface/pages.ts. */
import { PREFIXE_PERSO } from "@elpis/contracts";

/** Clé du stockage local ; sa forme (`MemoireHabillage`) est celle que lit le script d'avant le premier rendu. */
export const CLE_HABILLAGE = "elpis-habillage";

export type ModeTheme = "system" | "light" | "dark";

/** Habillage tel que la page le porte. */
export interface Habillage {
  readonly id: string;
  readonly palette: string;
  readonly mode: ModeTheme;
  readonly sombre: boolean;
  /** Skin à base sombre (`darkBase`). */
  readonly base: boolean;
  /** Feuilles servies par le cœur : skin importé ou habillage personnel. */
  readonly feuilles: readonly string[];
}

/** Forme gardée dans le navigateur : id du skin, palette, mode, base sombre, feuilles servies. */
export interface MemoireHabillage {
  id: string;
  p: string;
  m: ModeTheme;
  b: boolean;
  f: string[];
}

const MOTIF_PALETTE = /^[a-z][a-z0-9_-]{1,31}$/;
const GEREES = /^elpis-(?:skin-|palette-|app-dark$|dark-surface$)/;
const MODES: readonly unknown[] = ["system", "light", "dark"];

/** Nom de classe du body pour un id de skin ; un habillage personnel n'expose jamais son id dans la classe. */
export function classeSkin(id: string): string {
  return id.startsWith(PREFIXE_PERSO) ? "perso" : id;
}

/** Dernier habillage posé dans ce navigateur ; `null` sans stockage ou valeur illisible. */
export function lireMemoire(): MemoireHabillage | null {
  try {
    const brut: unknown = JSON.parse(localStorage.getItem(CLE_HABILLAGE) ?? "null");
    if (!brut || typeof brut !== "object") return null;
    const o = brut as Record<string, unknown>;
    if (typeof o["id"] !== "string") return null;
    const f = o["f"];
    return {
      id: o["id"],
      p: typeof o["p"] === "string" ? o["p"] : "",
      m: MODES.includes(o["m"]) ? (o["m"] as ModeTheme) : "light",
      b: o["b"] === true,
      f: Array.isArray(f) ? f.filter((x): x is string => typeof x === "string") : [],
    };
  } catch {
    return null;
  }
}

/** Réglages d'apparence de départ : ceux du dernier habillage posé, sinon Elpis clair. */
export function reglagesHabillage(m: MemoireHabillage | null = lireMemoire()) {
  return {
    skin: m?.id ?? "elpis",
    skin_palette: m?.p ?? "",
    dark_mode: m?.m === "dark",
    dark_mode_auto: m?.m === "system",
  };
}

/** Classes du body d'un habillage, sans retoucher celles qui restent : aucun recalcul de style si rien ne change. */
function poserClasses(h: Habillage): void {
  const cls = document.body.classList;
  const voulues = new Set<string>();
  if (h.id) voulues.add("elpis-skin-" + classeSkin(h.id));
  if (MOTIF_PALETTE.test(h.palette)) voulues.add("elpis-palette-" + h.palette);
  if (h.sombre) voulues.add("elpis-app-dark");
  if (h.sombre || h.base) voulues.add("elpis-dark-surface");
  for (const c of Array.from(cls)) if (GEREES.test(c) && !voulues.has(c)) cls.remove(c);
  for (const c of voulues) if (!cls.contains(c)) cls.add(c);
}

/** Feuille d'un skin importé ou personnel, liée seulement pour le skin actif. */
function poserFeuille(url: string): void {
  let el = document.getElementById("elpis-plugin-skin");
  if (!url) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("link");
    el.id = "elpis-plugin-skin";
    el.setAttribute("rel", "stylesheet");
    document.head.appendChild(el);
  }
  if (el.getAttribute("href") !== url) el.setAttribute("href", url);
}

/** Pose l'habillage sur la page et le garde pour le prochain chargement (stockage refusé : rien n'est gardé). */
export function poserHabillage(h: Habillage): void {
  if (!document.body) return;
  poserClasses(h);
  poserFeuille(h.feuilles[0] ?? "");
  try {
    const m: MemoireHabillage = { id: h.id, p: h.palette, m: h.mode, b: h.base, f: [...h.feuilles] };
    localStorage.setItem(CLE_HABILLAGE, JSON.stringify(m));
  } catch {
    /* stockage indisponible */
  }
}
