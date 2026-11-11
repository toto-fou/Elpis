// SPDX-License-Identifier: MIT
/** frontend/test/chat/rendu/apercu.test.ts — ouvrirApercu : iframe isolée, poignée de main, envoi unique du HTML, annulation. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { APERCU_PRET, ouvrirApercu, URL_APERCU } from "../../../src/features/chat/rendu/apercu";

afterEach(() => {
  document.body.innerHTML = "";
});

function cadreAvecFenetre(): { cadre: HTMLIFrameElement; poste: ReturnType<typeof vi.fn>; fenetre: Window } {
  const cadre = document.createElement("iframe");
  const poste = vi.fn();
  const fenetre = { postMessage: poste } as unknown as Window;
  Object.defineProperty(cadre, "contentWindow", { value: fenetre });
  return { cadre, poste, fenetre };
}

const message = (source: Window, data: string): void => {
  window.dispatchEvent(new MessageEvent("message", { source, data }));
};

describe("ouvrirApercu", () => {
  it("pose sandbox allow-scripts seul et la page d'aperçu", () => {
    const { cadre } = cadreAvecFenetre();
    const annuler = ouvrirApercu(cadre, "<b>x</b>");
    expect(cadre.getAttribute("sandbox")).toBe("allow-scripts");
    expect(cadre.getAttribute("src")).toBe(URL_APERCU);
    annuler();
  });

  it("envoie le HTML une seule fois, seulement à la poignée de main du cadre", () => {
    const { cadre, poste, fenetre } = cadreAvecFenetre();
    ouvrirApercu(cadre, "<i>y</i>");
    message(window, APERCU_PRET);
    message(fenetre, "autre");
    expect(poste).not.toHaveBeenCalled();
    message(fenetre, APERCU_PRET);
    message(fenetre, APERCU_PRET);
    expect(poste).toHaveBeenCalledTimes(1);
    expect(poste).toHaveBeenCalledWith("<i>y</i>", "*");
  });

  it("l'annulation retire l'écoute : plus rien n'est envoyé", () => {
    const { cadre, poste, fenetre } = cadreAvecFenetre();
    ouvrirApercu(cadre, "z")();
    message(fenetre, APERCU_PRET);
    expect(poste).not.toHaveBeenCalled();
  });
});
