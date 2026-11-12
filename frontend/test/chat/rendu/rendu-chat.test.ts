// SPDX-License-Identifier: MIT
/** frontend/test/chat/rendu/rendu-chat.test.ts — rendu côté conversation : le HTML posé par les vues sans composant du chat reçoit sa coloration. */
import { createRequire } from "node:module";

import { nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { moteurMarkdown } from "../../../src/features/chat/rendu/instance";
import { creerRenduChat } from "../../../src/features/chat/rendu/rendu-chat";

vi.mock("../../../src/platform/vendor", () => ({
  ensureVendor: () => Promise.reject(new Error("Chargement impossible")),
}));

const globalHljs = window as unknown as { hljs?: unknown };

afterEach(() => {
  delete globalHljs.hljs;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("renderMarkdown du chat pour les vues sans composant", () => {
  it("le HTML rendu est celui du moteur ; son code est coloré après l'affichage, hors du rendu", () => {
    globalHljs.hljs = createRequire(import.meta.url)("@highlightjs/cdn-assets/highlight.min.js");
    const tranches: ((e: { timeRemaining(): number }) => void)[] = [];
    vi.stubGlobal("requestIdleCallback", (cb: (e: { timeRemaining(): number }) => void) => tranches.push(cb));
    const rendu = creerRenduChat(
      moteurMarkdown(),
      { ref, nextTick },
      {
        messages: ref([]),
        currentChatId: ref(null),
        user: ref(null),
        settings: ref({}),
        inputRef: ref(null),
        chatContainer: ref(null),
        currentChatTitle: ref(""),
      },
      null,
    );
    const html = rendu.renderMarkdown("```py\nx = 1\n```");
    expect(html).toBe(moteurMarkdown().renderMarkdown("```py\nx = 1\n```"));
    document.body.innerHTML = '<div class="markdown-body">' + html + "</div>";
    const code = document.querySelector("code") as HTMLElement;
    expect(code.querySelector("[class^='hljs-']")).toBeNull();
    while (tranches.length) tranches.shift()?.({ timeRemaining: () => 50 });
    expect(code.querySelector(".hljs-number")?.textContent).toBe("1");
    expect(code.textContent).toBe("x = 1");
  });
});
