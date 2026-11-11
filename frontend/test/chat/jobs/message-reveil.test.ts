// SPDX-License-Identifier: MIT
/** frontend/test/chat/jobs/message-reveil.test.ts — branche de MessageChat sur origin « job_wake » : rien d'affiché dans le fil (le réveil rejoint la bulle de l'agent). */
import { createApp, h, reactive } from "vue";
import type { App, VNode } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import MessageChat from "../../../src/components/chat/message/MessageChat.vue";
import { CLE_FIL, CLE_LISTE } from "../../../src/features/chat/page/domaines";
import type {
  ContexteListe,
  ContexteMessage,
  MessageAffiche,
} from "../../../src/features/chat/message/types";
import { REVEIL } from "./outils-jobs";

let app: App | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

const TEXTE =
  '[Automatic wake-up: background job event(s).]\n<job_event id="j-3f2a1c9e" label="pytest">\n<b>x</b>\n</job_event>';

function monter(rendu: () => VNode, ctx?: ContexteMessage): HTMLElement {
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: rendu });
  if (ctx) {
    app.provide(CLE_FIL, ctx);
    app.provide(CLE_LISTE, ctx as ContexteListe);
  }
  app.mount(hote);
  return hote;
}

function contexte(): ContexteMessage {
  const etat = reactive({
    settings: { assistant_name: "Elpis" },
    user: { username: "alice", avatar: null },
    skinCourant: {},
    nomMarque: "Elpis",
    lastAssistantIdx: 5,
    isStreaming: false,
    editingMessageIndex: null,
    editMessageText: "",
    messageSearchQ: "",
    messageSearchActive: false,
    compressionStatus: null,
  });
  const neutres: Record<string, unknown> = {
    pipelineFor: () => ({ show: false }),
    segGroupsFor: () => [],
    effectLinesFor: () => [],
    diffFilesFor: () => [],
    hasDiffFiles: () => false,
    isDiffEditorEnabled: () => false,
    isImageMessage: () => false,
    statusPhase: () => null,
    thinkingTokensOf: () => 0,
    cachePctOf: () => 0,
    metricsTooltip: () => "",
    toolLimitLabel: () => "",
  };
  return new Proxy(etat, {
    get: (c, k: string) =>
      k in c ? (c as Record<string, unknown>)[k] : k in neutres ? neutres[k] : () => undefined,
  }) as unknown as ContexteMessage;
}

describe("MessageChat : origin job_wake", () => {
  it("message de réveil : rien d'affiché (élément masqué, sans texte)", () => {
    const msg: MessageAffiche = { role: "user", content: TEXTE, origin: "job_wake", wake: REVEIL };
    const hote = monter(() => h(MessageChat, { entry: { idx: 3, msg } }), contexte());
    const el = hote.querySelector<HTMLElement>("[data-vs-idx='3']");
    expect(el?.hidden).toBe(true);
    expect(el?.textContent).toBe("");
    expect(hote.querySelector(".elpis-msg-user")).toBeNull();
  });

  it("message utilisateur ordinaire : bulle inchangée", () => {
    const msg: MessageAffiche = { role: "user", content: "Bonjour" };
    const hote = monter(() => h(MessageChat, { entry: { idx: 0, msg } }), contexte());
    expect(hote.querySelector(".elpis-msg-user")).not.toBeNull();
    expect(hote.querySelector("[data-wake-line]")).toBeNull();
  });
});
