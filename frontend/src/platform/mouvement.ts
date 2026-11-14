// SPDX-License-Identifier: MIT
/** frontend/src/platform/mouvement.ts — animations de l'interface : choix du compte (suivre le poste, complètes, réduites) appliqué au code et aux feuilles de style, gardé dans le navigateur pour le prochain chargement. */

export type ChoixMouvement = "system" | "full" | "reduced";

/** Clé du stockage local : dernier choix appliqué dans ce navigateur (absente : suivre le poste). */
export const CLE_MOUVEMENT = "elpis-mouvement";
const REQUETE = "(prefers-reduced-motion: reduce)";
const MOTIF = /\(\s*prefers-reduced-motion\s*(?::\s*(reduce|no-preference)\s*)?\)/g;

let choix: ChoixMouvement = "system";
let source: typeof window.matchMedia | undefined;
let poste: MediaQueryList | null = null;
// Règles inversées et leur texte d'origine : références fortes, une règle relue garde ainsi son identité.
const origines = new Map<CSSMediaRule, string>();
let vues = new WeakSet<CSSStyleSheet>();
let veille: MutationObserver | null = null;

/** Choix lu d'un réglage ou du stockage ; toute autre valeur suit le poste. */
export function lireChoixMouvement(v: unknown): ChoixMouvement {
  return v === "full" || v === "reduced" ? v : "system";
}

/** Préférence « réduire les animations » du poste ; la liste de requête est gardée (lue à chaque image du glissé du fil). */
function posteReduit(): boolean {
  try {
    if (window.matchMedia !== source) {
      poste?.removeEventListener?.("change", appliquer);
      source = window.matchMedia;
      poste = window.matchMedia(REQUETE);
      poste.addEventListener?.("change", appliquer);
    }
    return !!poste?.matches;
  } catch {
    return false;
  }
}

/** Mouvement réduit pour ce choix : celui du compte, sinon la préférence du poste. */
export function mouvementReduitPour(c: ChoixMouvement): boolean {
  return c === "system" ? posteReduit() : c === "reduced";
}

/** Mouvement réduit en vigueur sur la page. */
export function mouvementReduit(): boolean {
  return mouvementReduitPour(choix);
}

/** Choix gardé par ce navigateur : posé dès le chargement, les réglages du compte le confirment. */
export function choixMouvementMemorise(): ChoixMouvement {
  try {
    return lireChoixMouvement(localStorage.getItem(CLE_MOUVEMENT));
  } catch {
    return "system";
  }
}

/** Inverse la préférence de mouvement lue par les requêtes média de ces règles, groupes et règles imbriquées compris. */
function inverser(regles: CSSRuleList): void {
  for (const r of Array.from(regles)) {
    if (r instanceof CSSMediaRule && !origines.has(r)) {
      const texte = r.media.mediaText;
      if (texte.includes("prefers-reduced-motion")) {
        origines.set(r, texte);
        r.media.mediaText = texte.replace(
          MOTIF,
          (_, v) => `(prefers-reduced-motion: ${v === "no-preference" ? "reduce" : "no-preference"})`,
        );
      }
    }
    const filles = (r as Partial<CSSGroupingRule>).cssRules;
    if (filles?.length) inverser(filles);
  }
}

/** Feuille chargée après coup (skin, page à la demande) : inversée à son tour. */
function surChargement(e: Event): void {
  if (e.target instanceof HTMLLinkElement) appliquer();
}

/** Met les feuilles d'accord avec le choix : inversées quand il contredit le poste (les feuilles ne lisent que lui), rétablies sinon. */
function appliquer(): void {
  if (typeof document === "undefined") return;
  if (choix === "system" || (choix === "reduced") === posteReduit()) {
    for (const [regle, texte] of origines) regle.media.mediaText = texte;
    origines.clear();
    vues = new WeakSet();
    veille?.disconnect();
    veille = null;
    document.removeEventListener("load", surChargement, true);
    return;
  }
  for (const f of Array.from(document.styleSheets)) {
    if (vues.has(f)) continue;
    vues.add(f);
    try {
      inverser(f.cssRules);
    } catch {
      /* feuille d'une autre origine : illisible */
    }
  }
  if (veille) return;
  veille = new MutationObserver(appliquer);
  veille.observe(document.head, { childList: true, subtree: true, characterData: true });
  document.addEventListener("load", surChargement, true);
}

/** Applique le choix du compte et le garde pour le prochain chargement de la page. */
export function definirMouvement(v: unknown): void {
  choix = lireChoixMouvement(v);
  try {
    if (choix === "system") localStorage.removeItem(CLE_MOUVEMENT);
    else localStorage.setItem(CLE_MOUVEMENT, choix);
  } catch {
    /* stockage indisponible */
  }
  appliquer();
}
