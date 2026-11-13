// SPDX-License-Identifier: MIT
/** frontend/test/chat/rendu/contenu-markdown-enrichissement.test.ts — ContenuMarkdown : un nouveau rendu à HTML égal ne relance pas l'enrichissement ; pendant le flux, seuls les blocs qui viennent d'être figés vont à la coloration. */
import { createApp, h, nextTick, shallowRef } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import ContenuMarkdown from "../../../src/components/chat/ContenuMarkdown.vue";
import type { MessageMarkdown } from "../../../src/components/chat/ContenuMarkdown.vue";
import { planifierColoration } from "../../../src/features/chat/rendu/coloration";
import type * as Coloration from "../../../src/features/chat/rendu/coloration";
import { enrichirBloc, enrichirBlocs } from "../../../src/features/chat/rendu/enrichissement";
import { moteurMarkdown } from "../../../src/features/chat/rendu/instance";
import type * as Enrichissement from "../../../src/features/chat/rendu/enrichissement";
import type { AffichageBlocs } from "../../../src/features/chat/rendu/porteur-flux";

vi.mock("../../../src/platform/vendor", () => ({
  ensureVendor: () => Promise.reject(new Error("Chargement impossible")),
}));

vi.mock("../../../src/features/chat/rendu/coloration", async (origine) => {
  const m = await origine<typeof Coloration>();
  return { ...m, planifierColoration: vi.fn() };
});

vi.mock("../../../src/features/chat/rendu/enrichissement", async (origine) => {
  const m = await origine<typeof Enrichissement>();
  return { ...m, enrichirBlocs: vi.fn(m.enrichirBlocs), enrichirBloc: vi.fn(m.enrichirBloc) };
});

let app: App | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

describe("ContenuMarkdown — enrichissement", () => {
  it("relancé quand le HTML ou la racine change, jamais à HTML et racine égaux", async () => {
    const appels = vi.mocked(enrichirBlocs);
    const etat = shallowRef<MessageMarkdown>({ content: "a", isStreaming: true, _mdActiveHtml: "<p>a</p>" });
    const hote = document.createElement("div");
    document.body.appendChild(hote);
    app = createApp({ render: () => h(ContenuMarkdown, { msg: etat.value }) });
    app.mount(hote);
    appels.mockClear();

    etat.value = { content: "```js\nx\n```", isStreaming: false };
    await nextTick();
    expect(appels).toHaveBeenCalledTimes(1);
    const pre = hote.querySelector("pre");
    expect(pre?.getAttribute("data-cb-done")).not.toBeNull();

    for (let i = 0; i < 5; i++) {
      etat.value = { content: "```js\nx\n```", isStreaming: false };
      await nextTick();
    }
    expect(appels).toHaveBeenCalledTimes(1);
    expect(hote.querySelector("pre")).toBe(pre);

    etat.value = { content: "```js\ny\n```", isStreaming: false };
    await nextTick();
    expect(appels).toHaveBeenCalledTimes(2);
    expect(hote.querySelector("pre")?.getAttribute("data-cb-done")).not.toBeNull();
  });

  it("blocs gardés : seuls ceux qui portent un bloc spécial sont parcourus", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>';
    const texte = "Un.\n\n```svg\n" + svg + "\n```\n\nVoir un renvoi.\n\n```py\nx = 1\n```\n\nFin.\n";
    const r = moteurMarkdown().terminerFlux(texte, null);
    const appels = vi.mocked(enrichirBloc);
    appels.mockClear();
    const hote = document.createElement("div");
    document.body.appendChild(hote);
    const msg: MessageMarkdown = {
      content: texte,
      isStreaming: false,
      _mdBlocks: r?.etat.blocs ?? [],
      _mdFlux: r?.etat ?? null,
    };
    app = createApp({ render: () => h(ContenuMarkdown, { msg }) });
    app.mount(hote);
    await vi.waitFor(() => expect(appels).toHaveBeenCalled());
    const blocs = [...(hote.firstElementChild?.children ?? [])];
    expect(appels.mock.calls.map(([b]) => blocs.indexOf(b as Element))).toEqual([1]);
  });
});

describe("ContenuMarkdown — flux", () => {
  it("seuls les blocs qui viennent d'être figés vont à la coloration ; aucun parcours tant que le flux dure", async () => {
    const m = moteurMarkdown();
    const coloration = vi.mocked(planifierColoration);
    const parcours = vi.mocked(enrichirBloc);
    const texte = "Un.\n\n```py\nx = 1\n```\n\nDeux.\n\n```js\ny\n```\n\nTrois en cours";
    const etats = [texte.indexOf("Deux") + 2, texte.length].map((n) =>
      m.avancerFlux(texte.slice(0, n), null),
    );
    const vue = (k: number): AffichageBlocs => ({
      blocs: etats[k]?.etat.blocs ?? [],
      actif: etats[k]?.actifHtml ?? "",
    });
    const corps = shallowRef(vue(0));
    const hote = document.createElement("div");
    document.body.appendChild(hote);
    coloration.mockClear();
    parcours.mockClear();
    app = createApp({
      render: () => h(ContenuMarkdown, { msg: { content: "x", isStreaming: true, _flux: { corps } } }),
    });
    app.mount(hote);
    const racine = hote.firstElementChild as HTMLElement;
    const rangs = (): number[] =>
      coloration.mock.calls.map(([b]) => [...racine.children].indexOf(b as Element));
    expect(etats.map((e) => e.etat.blocs.length)).toEqual([2, 4]);
    expect(rangs()).toEqual([0, 1]);
    corps.value = { blocs: corps.value.blocs, actif: corps.value.actif + "<p>!</p>" };
    await nextTick();
    expect(rangs()).toEqual([0, 1]);
    corps.value = vue(1);
    await nextTick();
    expect(rangs()).toEqual([0, 1, 2, 3]);
    corps.value = { blocs: corps.value.blocs, actif: "<p>Trois en cours, encore</p>" };
    await nextTick();
    expect(rangs()).toEqual([0, 1, 2, 3]);
    expect(parcours).not.toHaveBeenCalled();
  });
});
