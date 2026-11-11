// SPDX-License-Identifier: MIT
/** frontend/test/racine/session-onglet.test.ts — reprise après rechargement de l'onglet : méta des étapes, captures du navigateur et erreur du tour gardés, méta illisible écarté. */
import { ref } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import { creerSessionOnglet } from "../../src/app/racine/session-onglet";
import type { MessageChat } from "../../src/features/chat/coeur/types";

afterEach(() => sessionStorage.clear());

const HISTORIQUE = [
  {
    role: "assistant",
    content: "",
    tool_calls: [
      { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
    ],
  },
  { role: "tool", tool_call_id: "c1", content: "ok" },
];

function monter(messages: MessageChat[]) {
  const dep = {
    user: ref({ id: 7 }),
    messages: ref<MessageChat[]>(messages),
    currentChatId: ref<string | null>("chat-1"),
    fetchAuth: () => Promise.resolve(null),
    chat: () => null,
  };
  return { dep, s: creerSessionOnglet(dep as never) };
}

describe("instantané de l'onglet", () => {
  it("garde la durée des étapes et l'erreur du tour", () => {
    const msg = {
      role: "assistant",
      content: "partiel",
      tool_history: HISTORIQUE,
      tool_meta: { steps: { c1: { ms: 1200, state: "stopped" } } },
      isError: true,
      errorMessage: "Serveur injoignable",
      errorDetail: "ECONNREFUSED",
      errorKind: "network",
    } as unknown as MessageChat;
    const { dep, s } = monter([{ role: "user", content: "Lis a.ts" } as MessageChat, msg]);
    s.sauverSession();
    dep.messages.value = [];
    s.restaurerSession();
    const repris = dep.messages.value[1] as MessageChat;
    expect(repris.tool_meta).toEqual({ steps: { c1: { ms: 1200, state: "stopped" } } });
    expect(repris).toMatchObject({
      errorMessage: "Serveur injoignable",
      errorDetail: "ECONNREFUSED",
      errorKind: "network",
    });
    expect(repris.toolSteps?.length).toBe(1);
  });

  it("relit les captures du navigateur sur le serveur, rattachées à leur étape", () => {
    const msg = {
      role: "assistant",
      content: "fin",
      tool_history: HISTORIQUE,
      tool_meta: { steps: { c1: { shot: "/api/playwright/screenshot/s1/1.png", shot_step: 1 } } },
      webScreenshots: [{ blobUrl: "blob:perdu", stepIdx: 0 }],
    } as unknown as MessageChat;
    const { dep, s } = monter([msg]);
    s.sauverSession();
    dep.messages.value = [];
    s.restaurerSession();
    expect(dep.messages.value[0]?.webScreenshots).toEqual([
      expect.objectContaining({
        serverUrl: "/api/playwright/screenshot/s1/1.png",
        blobUrl: null,
        stepIdx: 0,
      }),
    ]);
  });

  it("écarte un méta qui ne respecte pas le contrat", () => {
    const msg = {
      role: "assistant",
      content: "fin",
      tool_history: HISTORIQUE,
      tool_meta: { steps: { c1: { shot: "https://ailleurs.example/x.png" } } },
    } as unknown as MessageChat;
    const { dep, s } = monter([msg]);
    s.sauverSession();
    dep.messages.value = [];
    s.restaurerSession();
    expect(dep.messages.value[0]?.tool_meta).toBeUndefined();
  });
});
