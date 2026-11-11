// SPDX-License-Identifier: MIT
/** frontend/test/chat/page/jauge-contexte.test.ts — jauge de contexte du composeur sous ses trois formes : bloc qui se remplit, pourcentage seul, anneau ; alerte au seuil, mètre accessible. */
import { createApp, h } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import JaugeContexte from "../../../src/components/chat/page/JaugeContexte.vue";
import { SEUIL_CONTEXTE } from "../../../src/features/chat/page/puces";
import type { AffichageContexte } from "../../../src/features/reglages/affichage-chat";

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

function monter(forme: AffichageContexte, pct: number, etroit = false): HTMLElement {
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  const contexte = { pct, part: pct / 100, titre: `${pct} % du contexte` };
  app = createApp({ render: () => h(JaugeContexte, { contexte, forme, etroit }) });
  app.mount(hote);
  return hote.querySelector("[data-puce-contexte]") as HTMLElement;
}
const visible = (el: HTMLElement): string =>
  [...el.querySelectorAll("span:not(.sr-only)")]
    .map((s) => s.textContent?.trim() ?? "")
    .filter(Boolean)
    .join(" ");

describe("JaugeContexte", () => {
  it("bloc : le remplissage suit la part (6 % au moins dès qu'un jeton occupe), « Contexte » visible sauf rangée étroite", () => {
    const j = monter("fill", 42);
    expect(j.getAttribute("role")).toBe("meter");
    expect(j.getAttribute("aria-valuenow")).toBe("42");
    expect(j.getAttribute("title")).toBe("42 % du contexte");
    expect((j.querySelector("[data-jauge-contexte]") as HTMLElement).style.width).toBe("42%");
    expect(visible(j)).toBe("Contexte 42 %");
    app?.unmount();
    expect((monter("fill", 1).querySelector("[data-jauge-contexte]") as HTMLElement).style.width).toBe("6%");
    app?.unmount();
    expect((monter("fill", 0).querySelector("[data-jauge-contexte]") as HTMLElement).style.width).toBe("0%");
    app?.unmount();
    expect(visible(monter("fill", 42, true))).toBe("42 %");
  });

  it("pourcentage : le nombre seul", () => {
    const j = monter("percent", 42);
    expect(j.querySelector("[data-jauge-contexte]")).toBeNull();
    expect(visible(j)).toBe("42 %");
  });

  it("anneau : un arc proportionnel à la part", () => {
    const j = monter("ring", 25);
    const arc = j.querySelector("svg .arc") as SVGCircleElement;
    const [plein, tour] = (arc.getAttribute("stroke-dasharray") ?? "").split(" ").map(Number);
    expect(plein! / tour!).toBeCloseTo(0.25, 2);
    expect(visible(j)).toBe("25 %");
  });

  it("au seuil d'alerte : signe ⚠ et classe d'alerte, quelle que soit la forme", () => {
    for (const forme of ["fill", "percent", "ring"] as const) {
      const sous = monter(forme, SEUIL_CONTEXTE - 1);
      expect(sous.classList.contains("is-alerte")).toBe(false);
      expect(sous.querySelector(".ph-warning")).toBeNull();
      app?.unmount();
      const au = monter(forme, SEUIL_CONTEXTE);
      expect(au.classList.contains("is-alerte")).toBe(true);
      expect(au.querySelector(".ph-warning")).not.toBeNull();
      app?.unmount();
      app = null;
    }
  });
});
