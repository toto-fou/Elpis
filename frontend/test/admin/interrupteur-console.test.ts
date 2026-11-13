// SPDX-License-Identifier: MIT
/** frontend/test/admin/interrupteur-console.test.ts — interrupteur de la console : attributs portés par la case, modèle lié, texte fixe ou selon l'état. */
import { createApp, h, nextTick, reactive } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import InterrupteurConsole from "../../src/components/admin/InterrupteurConsole.vue";

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

function monter(props: Record<string, unknown>): { hote: HTMLElement; etat: { actif: boolean } } {
  const etat = reactive({ actif: false });
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({
    render: () =>
      h(InterrupteurConsole, {
        ...props,
        modelValue: etat.actif,
        "onUpdate:modelValue": (v: boolean | undefined) => (etat.actif = !!v),
      }),
  });
  app.mount(hote);
  return { hote, etat };
}

describe("InterrupteurConsole", () => {
  it("id, data-field et aria-label sur la case ; un clic bascule le modèle ; texte par défaut selon l'état", async () => {
    const { hote, etat } = monter({ id: "x-on", "data-field": "config:x.on", "aria-label": "X" });
    const caseX = hote.querySelector("input")!;
    expect([caseX.id, caseX.dataset["field"], caseX.getAttribute("aria-label"), caseX.type]).toEqual([
      "x-on",
      "config:x.on",
      "X",
      "checkbox",
    ]);
    expect(hote.querySelector("label")?.hasAttribute("id")).toBe(false);
    expect(hote.textContent?.trim()).toBe("Désactivé");
    caseX.click();
    await nextTick();
    expect(etat.actif).toBe(true);
    expect(hote.textContent?.trim()).toBe("Activé");
  });

  it("textes propres à l'état, ou texte fixe", async () => {
    const a = monter({ oui: "Proposé", non: "Retiré" });
    expect(a.hote.textContent?.trim()).toBe("Retiré");
    a.etat.actif = true;
    await nextTick();
    expect(a.hote.textContent?.trim()).toBe("Proposé");
    app?.unmount();
    const b = monter({ texte: "Imposer" });
    b.etat.actif = true;
    await nextTick();
    expect(b.hote.textContent?.trim()).toBe("Imposer");
  });
});
