// SPDX-License-Identifier: MIT
/** frontend/src/platform/precharge.ts — préchargement à l'intention : survol, focus ou appui sur un élément `[data-precharge="cle …"]` lance une fois le préchargeur de chaque clé. */

import { occupe } from "./repos";

const prechargeurs = new Map<string, () => unknown>();
const lances = new Set<string>();

/** Enregistre le préchargeur d'une clé. */
export function definirPrechargement(cle: string, f: () => unknown): void {
  prechargeurs.set(cle, f);
}

/** Lance le préchargeur d'une clé une fois, jamais pendant un flux ; un échec le laisse relançable. */
export function precharger(cle: string): void {
  const f = prechargeurs.get(cle);
  if (!f || lances.has(cle) || occupe()) return;
  lances.add(cle);
  void Promise.resolve()
    .then(f)
    .catch(() => lances.delete(cle));
}

function surIntention(e: Event): void {
  const cible = e.target instanceof Element ? e.target.closest("[data-precharge]") : null;
  for (const cle of cible?.getAttribute("data-precharge")?.split(/\s+/) ?? []) precharger(cle);
}

const EVENEMENTS = ["pointerover", "focusin", "pointerdown"] as const;

/** Écoute les intentions sur tout le document ; rend la fonction qui retire l'écoute. */
export function ecouterIntentions(): () => void {
  for (const t of EVENEMENTS) document.addEventListener(t, surIntention, { capture: true, passive: true });
  return () => {
    for (const t of EVENEMENTS) document.removeEventListener(t, surIntention, { capture: true });
  };
}
