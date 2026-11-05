// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/feuille-skin.ts — feuille editeur.css du skin actif : liée à la demande, l'ancienne retirée une fois la nouvelle chargée. */

const ID = "elpis-skin-editeur";
let derniere = 0;

/** Pose la feuille `url` (vide : la retire) ; se résout quand ses jetons sont en place, même en cas d'échec. */
export function chargerFeuilleEditeur(url: string): Promise<void> {
  const numero = ++derniere;
  return new Promise((fin) => {
    if (typeof document === "undefined") return fin();
    const ancienne = document.getElementById(ID);
    if (!url) {
      ancienne?.remove();
      return fin();
    }
    if (ancienne?.getAttribute("href") === url) return fin();
    const lien = document.createElement("link");
    lien.setAttribute("rel", "stylesheet");
    lien.setAttribute("href", url);
    const fini = (): void => {
      if (numero === derniere) {
        ancienne?.remove();
        lien.id = ID;
      } else lien.remove();
      fin();
    };
    lien.onload = fini;
    lien.onerror = fini;
    document.head.appendChild(lien);
  });
}
