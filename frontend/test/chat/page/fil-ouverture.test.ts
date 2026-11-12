// SPDX-License-Identifier: MIT
/** frontend/test/chat/page/fil-ouverture.test.ts — fil de conversation : inerte et occupé tant qu'une autre conversation s'ouvre, normal sinon. */
import type { InjectionKey } from "vue";
import { nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import FilConversation from "../../../src/components/chat/page/FilConversation.vue";
import { CLE_CONVERSATION } from "../../../src/features/chat/page/domaines";
import { demonter, etat, monter } from "./montage";

const { bouchon } = vi.hoisted(() => ({
  bouchon: async (nom: string) => {
    const { defineComponent, h } = await import("vue");
    return { default: defineComponent({ name: nom, render: () => h("div", { "data-bouchon": nom }) }) };
  },
}));
vi.mock("../../../src/components/chat/liste/ListeMessages.vue", () => bouchon("ListeMessages"));
vi.mock("../../../src/components/chat/page/AccueilChat.vue", () => bouchon("AccueilChat"));
vi.mock("../../../src/components/chat/page/RechercheMessages.vue", () => bouchon("RechercheMessages"));

afterEach(demonter);

describe("fil de conversation pendant l'ouverture d'une autre", () => {
  it("inerte et occupé tant que la conversation s'ouvre, rendu à la normale ensuite", async () => {
    const conv = etat({
      messages: [{ role: "user" }],
      showEditor: false,
      settings: { chat_width: 70 },
      messageSearchActive: false,
      chatBottomPad: 0,
      chatEnOuverture: null,
    });
    const hote = monter(FilConversation, [[CLE_CONVERSATION as InjectionKey<object>, conv]]);
    const fil = hote.firstElementChild as HTMLElement;
    expect(fil.hasAttribute("inert")).toBe(false);
    expect(fil.hasAttribute("aria-busy")).toBe(false);
    conv.chatEnOuverture = "c2";
    await nextTick();
    expect(fil.hasAttribute("inert")).toBe(true);
    expect(fil.getAttribute("aria-busy")).toBe("true");
    conv.chatEnOuverture = null;
    await nextTick();
    expect(fil.hasAttribute("inert")).toBe(false);
    expect(fil.hasAttribute("aria-busy")).toBe(false);
  });
});
