// SPDX-License-Identifier: MIT
/** frontend/test/chat/message/captures-web.test.ts — captures du navigateur sous la réponse : celles du message toujours affichées (historique compris), rien sans capture. */
import { createApp, h, reactive } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import CapturesWeb from "../../../src/components/chat/message/CapturesWeb.vue";
import type { ContexteMessage, MessageAffiche } from "../../../src/features/chat/message/types";
import { CLE_FIL } from "../../../src/features/chat/page/domaines";
import { CLE_PREFERENCES_CHAT } from "../../../src/features/reglages/affichage-chat";
import { prefsDeroule } from "../preferences";

let app: App | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

function monter(captures: MessageAffiche["webScreenshots"]): HTMLElement {
  const msg = { role: "assistant", content: "r", webScreenshots: captures } as MessageAffiche;
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: () => h(CapturesWeb, { entry: { idx: 1, msg } }) });
  app.provide(CLE_FIL, reactive({ settings: { hide_web_screenshots: true } }) as unknown as ContexteMessage);
  app.provide(CLE_PREFERENCES_CHAT, prefsDeroule("classic"));
  app.mount(hote);
  return hote;
}

describe("CapturesWeb", () => {
  it("affiche les captures du message, même avec l'ancien « Masquer les captures web »", () => {
    const hote = monter([
      { tool: "browser_navigate", blobUrl: "blob:capture-1" },
    ] as MessageAffiche["webScreenshots"]);
    expect(hote.querySelector("img")?.getAttribute("src")).toBe("blob:capture-1");
  });

  it("ne rend rien pour un message sans capture (captures d'étape éteintes)", () => {
    for (const caps of [undefined, []]) {
      const hote = monter(caps);
      expect(hote.querySelector("img")).toBeNull();
      expect(hote.textContent?.trim()).toBe("");
      app?.unmount();
      app = null;
    }
  });
});
