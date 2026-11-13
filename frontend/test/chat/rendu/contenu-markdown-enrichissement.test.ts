// SPDX-License-Identifier: MIT
/** frontend/test/chat/rendu/contenu-markdown-enrichissement.test.ts — ContenuMarkdown : un nouveau rendu à HTML égal ne relance pas l'enrichissement. */
import { createApp, h, nextTick, shallowRef } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import ContenuMarkdown from "../../../src/components/chat/ContenuMarkdown.vue";
import type { MessageMarkdown } from "../../../src/components/chat/ContenuMarkdown.vue";
import { enrichirBloc, enrichirBlocs } from "../../../src/features/chat/rendu/enrichissement";
import { moteurMarkdown } from "../../../src/features/chat/rendu/instance";
import type * as Enrichissement from "../../../src/features/chat/rendu/enrichissement";

vi.mock("../../../src/platform/vendor", () => ({
  ensureVendor: () => Promise.reject(new Error("Chargement impossible")),
}));

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
