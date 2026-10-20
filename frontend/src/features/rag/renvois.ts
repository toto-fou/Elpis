// SPDX-License-Identifier: MIT
/** frontend/src/features/rag/renvois.ts — renvois [n] d'une réponse rendue : pastilles numérotées (ou renvoi inconnu, discret et sans lien) posées après coup sur le DOM, sans toucher au code, aux liens ni aux blocs de code. */
import type { SourceCiteeRag } from "@elpis/contracts";

import { decouperRenvois, libelleAccessibleSource } from "./sources-affichage";

/** Ce qu'un message de l'assistant offre à ses renvois : résolution d'un numéro et gestes sur la pastille. */
export interface RenvoisMessage {
  resoudre(n: number): SourceCiteeRag | null;
  /** Pointeur ou focus sur une pastille : la bulle s'ouvre après un court délai. */
  survol(n: number, ancre: HTMLElement): void;
  /** Pointeur ou focus qui quitte une pastille : la bulle se ferme après un court délai. */
  sortie(): void;
  ouvrir(n: number, ancre: HTMLElement): void;
  /** Numéro de la source dont la bulle ou la visionneuse est ouverte : sa pastille est pleine. */
  courante(): number | null;
}

export type Resolveur = (n: number) => SourceCiteeRag | null;

// Un renvoi ne se pose jamais dans du code, un lien, un bouton ou une formule.
const IGNORES =
  "code, pre, a, kbd, samp, script, style, button, svg, math, textarea, .katex, .mermaid, .rag-cite, .rag-cite-inconnu";

const TITRE_INCONNU = "Renvoi sans source : aucun passage lu ne porte ce numéro.";

function creerBouton(doc: Document, n: number, s: SourceCiteeRag): HTMLElement {
  const b = doc.createElement("button");
  b.type = "button";
  b.className = "rag-cite";
  b.dataset["ragN"] = String(n);
  b.setAttribute("aria-haspopup", "dialog");
  b.setAttribute("aria-label", libelleAccessibleSource(s));
  b.textContent = String(n);
  return b;
}

function creerInconnu(doc: Document, n: number): HTMLElement {
  const e = doc.createElement("span");
  e.className = "rag-cite-inconnu";
  e.dataset["ragN"] = String(n);
  e.dataset["ragInconnu"] = "";
  e.title = TITRE_INCONNU;
  e.textContent = `[${n}]`;
  return e;
}

function pastille(doc: Document, n: number, s: SourceCiteeRag | null): HTMLElement {
  return s === null ? creerInconnu(doc, n) : creerBouton(doc, n, s);
}

/** Rend vrai si `el` est une pastille cliquable (renvoi connu). */
export function estPastille(el: Element | null): el is HTMLElement {
  return el !== null && el.hasAttribute("data-rag-n") && !el.hasAttribute("data-rag-inconnu");
}

/** Numéro porté par la pastille la plus proche de `cible`, avec son élément ; `null` hors pastille ou pour un renvoi inconnu. */
export function pastilleDe(cible: EventTarget | null): { n: number; el: HTMLElement } | null {
  const el = cible instanceof Element ? cible.closest("[data-rag-n]") : null;
  if (!estPastille(el)) return null;
  const n = Number(el.dataset["ragN"]);
  return Number.isInteger(n) ? { n, el } : null;
}

function noeudsTexte(racine: HTMLElement): Text[] {
  const doc = racine.ownerDocument;
  const marcheur = doc.createTreeWalker(racine, 4 /* NodeFilter.SHOW_TEXT */);
  const sortie: Text[] = [];
  for (let n = marcheur.nextNode(); n !== null; n = marcheur.nextNode()) {
    const t = n as Text;
    if (!t.data.includes("[")) continue;
    if (t.parentElement?.closest(IGNORES) != null) continue;
    sortie.push(t);
  }
  return sortie;
}

/** Pose les pastilles d'un rendu (une fois par nouveau texte) puis met à jour celles qui existent : un renvoi devenu connu, ou inconnu, change de forme. Rend le nombre de renvois posés. */
export function poserPastilles(racine: HTMLElement, resoudre: Resolveur): number {
  const doc = racine.ownerDocument;
  let poses = 0;
  for (const t of noeudsTexte(racine)) {
    const morceaux = decouperRenvois(t.data);
    if (!morceaux.some((m) => "renvois" in m)) continue;
    const fragment = doc.createDocumentFragment();
    for (const m of morceaux) {
      if ("texte" in m) fragment.append(doc.createTextNode(m.texte));
      else
        for (const n of m.renvois) {
          fragment.append(pastille(doc, n, resoudre(n)));
          poses++;
        }
    }
    t.replaceWith(fragment);
  }
  for (const el of racine.querySelectorAll<HTMLElement>("[data-rag-n]")) {
    const n = Number(el.dataset["ragN"]);
    const s = resoudre(n);
    const connu = !el.hasAttribute("data-rag-inconnu");
    if (connu !== (s !== null)) el.replaceWith(pastille(doc, n, s));
    else if (s !== null) el.setAttribute("aria-label", libelleAccessibleSource(s));
  }
  return poses;
}
