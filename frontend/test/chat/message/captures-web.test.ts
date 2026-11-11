// SPDX-License-Identifier: MIT
/** frontend/test/chat/message/captures-web.test.ts — captures du navigateur sous la réponse : affichées par défaut, cachées par « Masquer les captures web ». */
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

function monter(masquer: boolean | undefined): HTMLElement {
  const msg = {
    role: "assistant",
    content: "r",
    webScreenshots: [{ tool: "browser_navigate", blobUrl: "blob:capture-1" }],
  } as MessageAffiche;
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: () => h(CapturesWeb, { entry: { idx: 1, msg } }) });
  app.provide(CLE_FIL, reactive({ settings: {} }) as unknown as ContexteMessage);
  app.provide(CLE_PREFERENCES_CHAT, prefsDeroule("classic", { captures: masquer !== true }));
  app.mount(hote);
  return hote;
}

describe("CapturesWeb", () => {
  it("affiche la capture quand le réglage est absent ou désactivé", () => {
    expect(monter(undefined).querySelector("img")?.getAttribute("src")).toBe("blob:capture-1");
    app?.unmount();
    expect(monter(false).querySelector("img")?.getAttribute("src")).toBe("blob:capture-1");
  });

  it("ne rend rien quand « Masquer les captures web » est activé", () => {
    const hote = monter(true);
    expect(hote.querySelector("img")).toBeNull();
    expect(hote.textContent?.trim()).toBe("");
  });
});
