// SPDX-License-Identifier: MIT
/** frontend/test/chat/coeur/cache-conversation.test.ts — part de l'entrée relue du cache sur la conversation ouverte (pied du menu des modèles, vLLM et SGLang). */
import { describe, expect, it } from "vitest";

import { cacheConversationDe } from "../../../src/features/chat/coeur/formats";
import type { MessageChat } from "../../../src/features/chat/coeur/types";

const assistant = (model: string, entree: number, lu: number): MessageChat => ({
  role: "assistant",
  metrics: { model, input_tokens: entree, cache_read_input_tokens: lu },
});

describe("cache relu sur la conversation", () => {
  it("somme des messages assistant du modèle choisi, tous les modèles sans choix", () => {
    const fil: MessageChat[] = [
      { role: "user", content: "q", metrics: { input_tokens: 999, cache_read_input_tokens: 999 } },
      assistant("qwen", 1000, 0),
      assistant("qwen", 3000, 2000),
      assistant("llama", 1000, 1000),
      { role: "assistant", content: "sans mesure" },
    ];
    expect(cacheConversationDe(fil, "qwen")).toEqual({ lu: 2000, entree: 4000, pct: 50 });
    expect(cacheConversationDe(fil, "")).toEqual({ lu: 3000, entree: 5000, pct: 60 });
  });

  it("null sans jeton relu ou sans message mesuré", () => {
    expect(cacheConversationDe([assistant("qwen", 1000, 0)], "qwen")).toBeNull();
    expect(cacheConversationDe([assistant("llama", 1000, 500)], "qwen")).toBeNull();
    expect(cacheConversationDe([], "")).toBeNull();
  });
});
