// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/composeur/premier-envoi.ts — premier envoi d'une conversation : le composeur glisse du milieu vers le bas (FLIP en transform) et l'accueil s'efface en fondu, sans rien retarder ni déplacer la mise en page. */
import { nextTick } from "vue";

import { mouvementReduit } from "../../../utils/dom";

function jeton(nom: string, defaut: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(nom).trim() || defaut;
}

// Copie figée de l'accueil, posée au même endroit dans la page : le vrai quitte le fil dans le rendu du premier message.
function figer(accueil: HTMLElement, page: HTMLElement): HTMLElement {
  const r = accueil.getBoundingClientRect();
  const p = page.getBoundingClientRect();
  const copie = accueil.cloneNode(true) as HTMLElement;
  const toiles = accueil.querySelectorAll("canvas");
  copie.querySelectorAll("canvas").forEach((c, i) => {
    const source = toiles[i];
    if (source && source.width && source.height) c.getContext("2d")?.drawImage(source, 0, 0);
  });
  copie.setAttribute("aria-hidden", "true");
  copie.inert = true;
  Object.assign(copie.style, {
    position: "absolute",
    left: `${r.left - p.left}px`,
    top: `${r.top - p.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
    minHeight: "0",
    margin: "0",
    zIndex: "20",
    pointerEvents: "none",
  });
  return copie;
}

/** À appeler avant le rendu qui pose le premier message : mesure le composeur, fige l'accueil, puis anime l'écart. */
export function glisserAuPremierEnvoi(bande: HTMLElement | null, page: HTMLElement | null): void {
  if (!bande || !page) return;
  const avant = bande.getBoundingClientRect().top;
  const accueil = page.querySelector<HTMLElement>(".elpis-welcome");
  const copie = accueil ? figer(accueil, page) : null;
  void nextTick(() => {
    const reduit = mouvementReduit();
    const duree = parseFloat(jeton("--duree", "200"));
    const fondu = {
      duration: reduit ? Math.min(duree, 150) : duree,
      easing: jeton("--courbe-fondu", "ease-out"),
    };
    if (copie) {
      page.appendChild(copie);
      const a = copie.animate([{ opacity: 1 }, { opacity: 0 }], { ...fondu, fill: "forwards" });
      void a.finished.catch(() => undefined).finally(() => copie.remove());
    }
    const ecart = avant - bande.getBoundingClientRect().top;
    if (!ecart) return;
    if (reduit) bande.animate([{ opacity: 0 }, { opacity: 1 }], fondu);
    else
      bande.animate([{ transform: `translateY(${ecart}px)` }, { transform: "none" }], {
        duration: parseFloat(jeton("--duree-longue", "260")),
        easing: jeton("--courbe-entree", "ease-out"),
      });
  });
}
