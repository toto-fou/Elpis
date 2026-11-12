// SPDX-License-Identifier: MIT
/** frontend/test/communs/libelle-vivant.test.ts — LibelleVivant : le texte n'existe qu'une fois pour la lecture, l'éclat est un balisage masqué aux lecteurs d'écran ; sans activité, un simple libellé. */
/* eslint-disable vue/one-component-per-file -- hôtes de montage du composant testé */
import { createApp, h, nextTick, ref } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import LibelleVivant from "../../src/components/communs/LibelleVivant.vue";

let app: App | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

async function monter(props: { texte: string; vivant?: boolean; class?: string }): Promise<HTMLElement> {
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: () => h(LibelleVivant, props) });
  app.mount(hote);
  await nextTick();
  return hote;
}

describe("LibelleVivant", () => {
  it("vivant : le texte une seule fois, l'éclat masqué aux lecteurs d'écran", async () => {
    const hote = await monter({ texte: "Réflexion…" });
    const racine = hote.querySelector(".mem-wave");
    expect(racine?.textContent).toBe("Réflexion…");
    const fenetre = racine?.querySelector(".mem-wave-fenetre");
    expect(fenetre?.getAttribute("aria-hidden")).toBe("true");
    expect(fenetre?.querySelector(".mem-wave-copie")?.getAttribute("data-texte")).toBe("Réflexion…");
    expect(hote.querySelectorAll(".mem-wave")).toHaveLength(1);
  });

  it("garde les classes de l'appelant sur le libellé", async () => {
    const hote = await monter({ texte: "Génération", class: "truncate text-[12.5px]" });
    expect([...(hote.querySelector(".mem-wave")?.classList ?? [])].sort()).toEqual(
      ["mem-wave", "text-[12.5px]", "truncate"].sort(),
    );
  });

  it("le texte suit la mise à jour de l'appelant, copie comprise", async () => {
    const hote = document.createElement("div");
    document.body.appendChild(hote);
    const texte = ref("Recherche");
    app = createApp({ render: () => h(LibelleVivant, { texte: texte.value }) });
    app.mount(hote);
    texte.value = "Lecture";
    await nextTick();
    expect(hote.querySelector(".mem-wave")?.textContent).toBe("Lecture");
    expect(hote.querySelector(".mem-wave-copie")?.getAttribute("data-texte")).toBe("Lecture");
  });

  it("sans activité : un simple libellé, ni éclat ni classe d'animation", async () => {
    const hote = await monter({ texte: "Thinking...", vivant: false, class: "font-semibold" });
    expect(hote.querySelector(".mem-wave, .mem-wave-fenetre, .mem-wave-copie")).toBeNull();
    expect(hote.innerHTML).toBe('<span class="font-semibold">Thinking...</span>');
  });
});
