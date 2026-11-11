// SPDX-License-Identifier: MIT
/** frontend/test/chat/rendu/contenu-markdown-enrichissement.test.ts — ContenuMarkdown : un nouveau rendu à HTML égal ne relance pas l'enrichissement. */
import { createApp, h, nextTick, shallowRef } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import ContenuMarkdown from "../../../src/components/chat/ContenuMarkdown.vue";
import type { MessageMarkdown } from "../../../src/components/chat/ContenuMarkdown.vue";
import { enrichirBlocs } from "../../../src/features/chat/rendu/enrichissement";
import type * as Enrichissement from "../../../src/features/chat/rendu/enrichissement";

vi.mock("../../../src/features/chat/rendu/enrichissement", async (origine) => {
  const m = await origine<typeof Enrichissement>();
  return { ...m, enrichirBlocs: vi.fn(m.enrichirBlocs) };
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
});
