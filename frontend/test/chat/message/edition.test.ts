// SPDX-License-Identifier: MIT
/** frontend/test/chat/message/edition.test.ts — édition d'un message : captures des messages retirés libérées, pièces jointes et demande d'image gardées, confirmation du premier message (porté de `test_message_edit_blobs.js`). */
import * as Vue from "vue";
import { ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setupChatMessageEdit } from "../../../src/features/chat/message/edition";
import type { MessageEditable } from "../../../src/features/chat/message/edition";

const shot = (u: string) => ({ blobUrl: u, w: 1, h: 1 });

function monter(messages: MessageEditable[], confirmer = true) {
  const liste = ref(messages);
  const gen: number[] = [];
  const confirmations: string[] = [];
  const e = setupChatMessageEdit(
    Vue,
    { messages: liste, isStreaming: ref(false), isUserScrolling: ref(true) },
    {
      scrollToBottom() {},
      generateResponse: async () => {
        gen.push(1);
      },
      openConfirm: async (titre) => {
        confirmations.push(titre);
        return confirmer;
      },
    },
  );
  return { e, liste, gen, confirmations };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("édition d'un message", () => {
  it("révoque les captures des messages retirés, pas des autres", async () => {
    const revoquees: string[] = [];
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((u) => void revoquees.push(u));
    const { e, liste, gen } = monter([
      { role: "user", content: "q1" },
      { role: "assistant", content: "r1", webScreenshots: [shot("blob:a1")] },
      { role: "user", content: "q2" },
      { role: "assistant", content: "r2", webScreenshots: [shot("blob:a3"), shot("blob:a3b")] },
      { role: "user", content: "q3", webScreenshots: [shot("blob:u4")] },
    ]);
    e.startEditMessage(2);
    e.editMessageText.value = "q2 modifiée";
    await e.submitEditMessage(2);
    expect(revoquees.sort()).toEqual(["blob:a3", "blob:a3b", "blob:u4"]);
    const garde = liste.value[1]?.["webScreenshots"] as { blobUrl: string }[];
    expect(garde[0]?.blobUrl).toBe("blob:a1");
    expect(liste.value).toHaveLength(3);
    expect(liste.value[2]?.content).toBe("q2 modifiée");
    expect(gen).toHaveLength(1);
  });

  it("premier message : confirmation, puis pièces jointes et demande d'image gardées", async () => {
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const { e, liste, confirmations } = monter([
      { role: "user", content: "q1", images: [{ dataUrl: "d" }], image_request: { n: 2 } },
      { role: "assistant", content: "r1", webScreenshots: [shot("blob:a1")] },
    ]);
    e.startEditMessage(0);
    e.editMessageText.value = "q1 bis";
    await e.submitEditMessage(0);
    expect(confirmations).toEqual(["Modifier le premier message ?"]);
    expect(liste.value).toHaveLength(1);
    expect(liste.value[0]).toEqual({
      role: "user",
      content: "q1 bis",
      images: [{ dataUrl: "d" }],
      image_request: { n: 2 },
    });
  });

  it("premier message refusé : rien n'est tronqué, le formulaire reste ouvert", async () => {
    const { e, liste, gen } = monter(
      [
        { role: "user", content: "q1" },
        { role: "assistant", content: "r1" },
      ],
      false,
    );
    e.startEditMessage(0);
    e.editMessageText.value = "autre";
    await e.submitEditMessage(0);
    expect(liste.value).toHaveLength(2);
    expect(e.editingMessageIndex.value).toBe(0);
    expect(gen).toHaveLength(0);
  });
});
