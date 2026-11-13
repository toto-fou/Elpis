// SPDX-License-Identifier: MIT
/** frontend/test/chat/composeur/premier-envoi.test.ts — premier envoi : le composeur glisse de l'écart mesuré en transform (fondu de 150 ms en mouvement réduit), l'accueil laisse une copie qui s'efface puis disparaît. */
import { nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { glisserAuPremierEnvoi } from "../../../src/features/chat/composeur/premier-envoi";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function poser(reduit: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (q: string) => ({ matches: reduit && q.includes("reduce") }) as MediaQueryList,
  );
  const page = document.createElement("main");
  page.innerHTML = '<div class="elpis-welcome"><h2>Bonjour</h2></div><div class="bande"></div>';
  document.body.appendChild(page);
  const bande = page.querySelector(".bande") as HTMLElement;
  let haut = 396;
  vi.spyOn(bande, "getBoundingClientRect").mockImplementation(() => ({ top: haut }) as DOMRect);
  const appels: { el: string; images: Keyframe[]; options: KeyframeAnimationOptions }[] = [];
  const animer = function (this: HTMLElement, images: Keyframe[], options: KeyframeAnimationOptions) {
    appels.push({ el: this.className, images, options });
    return { finished: Promise.resolve() } as unknown as Animation;
  };
  vi.spyOn(HTMLElement.prototype, "animate").mockImplementation(animer as HTMLElement["animate"]);
  return { page, bande, appels, descendre: () => (haut = 786) };
}

describe("premier envoi", () => {
  it("le composeur glisse de l'écart mesuré avant le rendu ; l'accueil s'efface sans occuper le fil", async () => {
    const { page, bande, appels, descendre } = poser(false);
    glisserAuPremierEnvoi(bande, page);
    page.querySelector(".elpis-welcome")?.remove();
    descendre();
    await nextTick();
    const copie = page.querySelector(".elpis-welcome") as HTMLElement;
    expect(copie.getAttribute("aria-hidden")).toBe("true");
    expect(copie.style.position).toBe("absolute");
    expect(appels.map((a) => [a.el, a.images])).toEqual([
      ["elpis-welcome", [{ opacity: 1 }, { opacity: 0 }]],
      ["bande", [{ transform: "translateY(-390px)" }, { transform: "none" }]],
    ]);
    expect(appels[1]?.options.duration).toBe(260);
    await Promise.resolve();
    await Promise.resolve();
    expect(page.querySelector(".elpis-welcome")).toBeNull();
  });

  it("mouvement réduit : un fondu de 150 ms au plus, aucun déplacement", async () => {
    const { page, bande, appels, descendre } = poser(true);
    glisserAuPremierEnvoi(bande, page);
    descendre();
    await nextTick();
    expect(appels.map((a) => [a.el, a.images, a.options.duration])).toEqual([
      ["elpis-welcome", [{ opacity: 1 }, { opacity: 0 }], 150],
      ["bande", [{ opacity: 0 }, { opacity: 1 }], 150],
    ]);
  });
});
