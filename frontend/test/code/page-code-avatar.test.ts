// SPDX-License-Identifier: MIT
/** frontend/test/code/page-code-avatar.test.ts — page Code : l'avatar de l'assistant (messages et attente de la CLI) est le logo de l'application, sans icône Phosphor. */
import { createApp, h, reactive } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import PageCode from "../../src/components/code/PageCode.vue";
import { CLE_CODE } from "../../src/features/code/domaine";
import type { DomaineCode } from "../../src/features/code/domaine";

let app: App | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

/** Domaine minimal : valeurs données, fonctions neutres pour le reste. */
function domaine(valeurs: Record<string, unknown>): DomaineCode {
  const cible = reactive({ ...valeurs });
  return new Proxy(cible, {
    get(c, cle: string) {
      if (cle in c) return (c as Record<string, unknown>)[cle];
      return () => "";
    },
  }) as unknown as DomaineCode;
}

describe("PageCode : avatar de l'assistant", () => {
  it("message de l'assistant et attente de la CLI : logo de l'application", () => {
    const LOGO = "/api/app-logo?v=0123456789abcdef";
    const hote = document.createElement("div");
    document.body.appendChild(hote);
    app = createApp({ render: () => h(PageCode) });
    app.provide(
      CLE_CODE,
      domaine({
        currentView: "code",
        codeAvailable: true,
        codeActiveId: "s1",
        codeSessions: [],
        activeSession: null,
        codeCtx: null,
        codeAgentShow: false,
        codePluginStale: false,
        codeLoading: false,
        codeMessages: [{ id: "m1", role: "assistant", parts: [], info: {}, _rev: 0 }],
        codeLiveIdx: -1,
        codeBusyActive: true,
        codeUi: {},
        codeNow: 0,
        settings: { chat_width: 70, assistant_icon: "ph-cat", assistant_avatar: "bot_1_2.png" },
        logoApp: LOGO,
        user: { avatar: null },
      }),
    );
    app.mount(hote);
    const avatars = [...hote.querySelectorAll("img[data-avatar-assistant]")].map((i) =>
      i.getAttribute("src"),
    );
    expect(avatars).toEqual([LOGO, LOGO]);
    expect(hote.innerHTML).not.toContain("bot_1_2.png");
    expect(hote.querySelector(".ph-cat")).toBeNull();
  });

  it("ligne de sous-agent et carte de l'outil task : logo de l'application, pas d'icône robot", () => {
    const LOGO = "/api/app-logo?v=0123456789abcdef";
    const hote = document.createElement("div");
    document.body.appendChild(hote);
    app = createApp({ render: () => h(PageCode) });
    app.provide(
      CLE_CODE,
      domaine({
        currentView: "code",
        codeAvailable: true,
        codeActiveId: "s1",
        codeSessions: [],
        activeSession: null,
        codeCtx: null,
        codeAgentShow: false,
        codePluginStale: false,
        codeLoading: false,
        codeMessages: [{ id: "m1", role: "assistant", parts: [], info: {}, _rev: 0 }],
        codeLiveIdx: -1,
        codeBusyActive: false,
        codeUi: { tool: {} },
        codePrompt: "",
        codeNow: 0,
        settings: { chat_width: 70 },
        logoApp: LOGO,
        user: { avatar: null },
        codeSteps: () => [
          { kind: "subtask", id: "a", agent: "explore", desc: "lire", prompt: "", model: "" },
          {
            kind: "tool",
            id: "b",
            tool: "task",
            status: "completed",
            running: false,
            error: false,
            icon: "ph-robot",
            subject: "",
            metric: "",
            metricTone: "",
            todos: null,
            input: null,
            output: "",
          },
        ],
      }),
    );
    app.mount(hote);
    const logos = [...hote.querySelectorAll("img[data-logo-sous-agent]")].map((i) => i.getAttribute("src"));
    expect(logos).toEqual([LOGO, LOGO]);
    expect(hote.querySelector(".ph-robot")).toBeNull();
  });
});
