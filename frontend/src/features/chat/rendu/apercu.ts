// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/rendu/apercu.ts — aperçu HTML isolé : iframe à origine opaque vers /apercu-code, poignée de main puis envoi unique du HTML (blocs HTML du chat et aperçu d'habillage). */

// Document d'aperçu servi par le core avec sa propre CSP (un srcdoc hériterait de celle de la page).
export const URL_APERCU = "/apercu-code";
export const APERCU_PRET = "elpis-apercu-pret";

/** Branche `cadre` sur la page d'aperçu et lui envoie `html` une fois prête ; rend la fonction d'annulation. */
export function ouvrirApercu(cadre: HTMLIFrameElement, html: string): () => void {
  cadre.setAttribute("sandbox", "allow-scripts");
  // Origine opaque (sans allow-same-origin) : le HTML part vers « * » et seulement à l'amorce de ce cadre.
  const ecoute = (e: MessageEvent): void => {
    if (!cadre.contentWindow || e.source !== cadre.contentWindow || e.data !== APERCU_PRET) return;
    window.removeEventListener("message", ecoute);
    cadre.contentWindow.postMessage(html, "*");
  };
  window.addEventListener("message", ecoute);
  cadre.src = URL_APERCU;
  return () => window.removeEventListener("message", ecoute);
}
