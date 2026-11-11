// SPDX-License-Identifier: MIT
/** frontend/test/reglages/aide.test.ts — aide à la demande des Paramètres : ligne repliée, bouton accessible, aucun texte sous 12 px. */
import { createApp, h, nextTick } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import AideOnglet from "../../src/components/reglages/AideOnglet.vue";

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

const sources = import.meta.glob("../../src/components/reglages/**/*.vue", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("aide des Paramètres", () => {
  it("la ligne d'aide est repliée puis se déplie au bouton", async () => {
    const racine = document.createElement("div");
    document.body.appendChild(racine);
    app = createApp({ render: () => h(AideOnglet, { titre: "Mémoire" }, () => "Une ligne.") });
    app.mount(racine);
    const bouton = racine.querySelector<HTMLButtonElement>("[data-aide-bouton]")!;
    const ligne = racine.querySelector<HTMLElement>("[data-aide-ligne]")!;
    expect(bouton.getAttribute("aria-expanded")).toBe("false");
    expect(ligne.style.display).toBe("none");
    expect(bouton.getAttribute("aria-controls")).toBe(ligne.id);
    bouton.click();
    await nextTick();
    expect(bouton.getAttribute("aria-expanded")).toBe("true");
    expect(ligne.style.display).not.toBe("none");
  });

  it("aucun texte sous 12 px dans les composants des Paramètres", () => {
    const fautifs = Object.entries(sources)
      .filter(([, texte]) => /text-\[(?:[0-9]|1[01])(?:\.\d+)?px\]/.test(texte))
      .map(([chemin]) => chemin);
    expect(fautifs).toEqual([]);
  });

  it("la fenêtre n'a ni bloc dans son titre ni icône lue par les lecteurs d'écran", () => {
    const [, source = ""] = Object.entries(sources).find(([c]) => c.endsWith("/ModaleReglages.vue")) ?? [];
    expect(/<h2[^>]*>(?:(?!<\/h2>)[\s\S])*<div/.test(source)).toBe(false);
    const icones = source.match(/<i\b[^>]*>/g) ?? [];
    expect(icones.length).toBeGreaterThan(0);
    expect(icones.filter((i) => !i.includes("aria-hidden"))).toEqual([]);
  });
});
