// SPDX-License-Identifier: MIT
/** frontend/test/admin/champ-nombre-console.test.ts — champ numérique de la console : attributs et classes en plus portés par le champ, valeur numérique, unité affichée. */
import { createApp, h, nextTick, reactive } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import ChampNombreConsole from "../../src/components/admin/ChampNombreConsole.vue";

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

describe("ChampNombreConsole", () => {
  it("id, data-field, bornes et classe sur le champ ; saisie rendue en nombre ; unité à côté", async () => {
    const etat = reactive({ v: 512 as unknown });
    const hote = document.createElement("div");
    document.body.appendChild(hote);
    app = createApp({
      render: () =>
        h(ChampNombreConsole, {
          id: "sb-mem",
          "data-field": "exec:limits.memory_mb",
          min: "256",
          max: "65536",
          class: "font-mono",
          unite: "Mo",
          modelValue: etat.v,
          "onUpdate:modelValue": (x: unknown) => (etat.v = x),
        }),
    });
    app.mount(hote);
    const champ = hote.querySelector("input")!;
    expect([champ.id, champ.dataset["field"], champ.min, champ.max, champ.type, champ.className]).toEqual([
      "sb-mem",
      "exec:limits.memory_mb",
      "256",
      "65536",
      "number",
      "set-input adm-num font-mono",
    ]);
    expect(hote.firstElementChild?.className).toBe("flex items-center gap-2");
    expect(hote.querySelector(".adm-unit")?.textContent).toBe("Mo");
    expect(champ.value).toBe("512");
    champ.value = "1024";
    champ.dispatchEvent(new Event("input"));
    await nextTick();
    expect(etat.v).toBe(1024);
  });
});
