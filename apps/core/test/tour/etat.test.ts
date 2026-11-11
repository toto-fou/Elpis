// SPDX-License-Identifier: MIT
/** apps/core/test/tour/etat.test.ts — état des tours en mémoire : drapeaux d'annulation par (compte, chat), passation d'un tour, verrous de présence, complétion qui raisonne. */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearChatCancellation,
  controleRaisonnementDuProcess as ctl,
  getActiveChatTask,
  isChatCancelled,
  isGenerationActive,
  markChatCancelled,
  normChatId,
  registerChatTask,
  tachesSansChat,
  unregisterChatTask,
  verrousChat,
  viderEtatPourTests,
} from "../../src/tour/etat";

afterEach(() => {
  viderEtatPourTests();
  vi.useRealTimers();
});

describe("annulation", () => {
  it("drapeau par (compte, chat) : un Stop n'annule pas l'autre onglet ni l'autre compte", () => {
    markChatCancelled(1, "a");
    expect(isChatCancelled(1, "a")).toBe(true);
    expect(isChatCancelled(1, "b")).toBe(false);
    expect(isChatCancelled(2, "a")).toBe(false);
    expect(isChatCancelled(1)).toBe(true);
    expect(isChatCancelled(2)).toBe(false);
    clearChatCancellation(1, "a");
    expect(isChatCancelled(1, "a")).toBe(false);
  });

  it("chat absent ou vide : clé `__none__`", () => {
    expect(normChatId("")).toBe("__none__");
    expect(normChatId(null)).toBe("__none__");
    expect(normChatId(0)).toBe("__none__");
    markChatCancelled(1, "");
    expect(isChatCancelled(1, "__none__")).toBe(true);
  });

  it("sans chat : tous les tours en cours du compte, et l'effacement en masse", () => {
    registerChatTask(1, new AbortController(), "a", { presenceLock: false });
    registerChatTask(1, new AbortController(), "b", { presenceLock: false });
    registerChatTask(2, new AbortController(), "c", { presenceLock: false });
    markChatCancelled(1);
    expect([isChatCancelled(1, "a"), isChatCancelled(1, "b"), isChatCancelled(2, "c")]).toEqual([
      true,
      true,
      false,
    ]);
    clearChatCancellation(1);
    expect(isChatCancelled(1)).toBe(false);
  });

  it("au-delà de 256 drapeaux, ceux de plus d'une heure sont balayés", () => {
    vi.useFakeTimers({ now: 0 });
    markChatCancelled(9, "vieux");
    vi.setSystemTime(3601 * 1000);
    for (let i = 0; i < 255; i++) markChatCancelled(1, `c${i}`);
    expect(isChatCancelled(9, "vieux")).toBe(true);
    markChatCancelled(1, "un-de-plus");
    expect(isChatCancelled(9, "vieux")).toBe(false);
    expect(isChatCancelled(1, "c0")).toBe(true);
  });
});

describe("tours enregistrés et verrou de présence", () => {
  it("le verrou est pris à la première tâche et gardé pendant une passation", () => {
    const ancien = new AbortController();
    const nouveau = new AbortController();
    registerChatTask(1, ancien, "a");
    expect(verrousChat.isHeld("gen", 1, "a")).toBe(true);
    registerChatTask(1, nouveau, "a");
    markChatCancelled(1, "a");
    unregisterChatTask(1, "a", ancien);
    expect(getActiveChatTask(1, "a")).toBe(nouveau);
    expect(isChatCancelled(1, "a")).toBe(true);
    expect(isGenerationActive(1, "a")).toBe(true);
    unregisterChatTask(1, "a", nouveau);
    expect(getActiveChatTask(1, "a")).toBeNull();
    expect(verrousChat.isHeld("gen", 1, "a")).toBe(false);
    expect(isChatCancelled(1, "a")).toBe(false);
    expect(isGenerationActive(1, "a")).toBe(false);
  });

  it("jeton de présence fourni : repris s'il manque, rendu s'il fait doublon", () => {
    const jeton = verrousChat.acquire("gen", 1, "a");
    registerChatTask(1, new AbortController(), "a", { presenceToken: jeton });
    const doublon = verrousChat.acquire("gen", 1, "b");
    registerChatTask(1, new AbortController(), "a", { presenceToken: doublon });
    expect(verrousChat.isHeld("gen", 1, "b")).toBe(false);
    unregisterChatTask(1, "a");
    expect(verrousChat.isHeld("gen", 1, "a")).toBe(false);
  });

  it("sans chat : n'importe quel tour du compte ; tours `__none__` pour l'annulation historique", () => {
    const a = new AbortController();
    const sans = new AbortController();
    registerChatTask(1, a, "a", { presenceLock: false });
    registerChatTask(1, sans, null, { presenceLock: false });
    expect(getActiveChatTask(1)).toBe(a);
    expect(getActiveChatTask(2)).toBeNull();
    expect(tachesSansChat(1)).toEqual([sans]);
    unregisterChatTask(1, null);
    expect(tachesSansChat(1)).toEqual([]);
  });

  it("verrous : exclusifs, rendus par jeton, comptés par genre et par compte", () => {
    const a = verrousChat.acquire("gen", 1, "a");
    expect(verrousChat.acquire("GEN", 1, "a")).toBeNull();
    const b = verrousChat.acquire("gen", 1, "b");
    verrousChat.acquire("gen", 2, "a");
    verrousChat.acquire("compact", 1, "a");
    verrousChat.acquire("gén!", 1, "a");
    expect([
      verrousChat.countHeld("gen"),
      verrousChat.countHeld("gen", 1),
      verrousChat.countHeld("compact"),
    ]).toEqual([3, 2, 1]);
    expect(verrousChat.isHeld("g_n_", 1, "a")).toBe(true);
    verrousChat.release(a);
    verrousChat.release(a);
    verrousChat.release(null);
    expect(verrousChat.isHeld("gen", 1, "a")).toBe(false);
    expect(verrousChat.isHeld("gen", 1, "b")).toBe(true);
    verrousChat.release(b);
    expect(verrousChat.countHeld("gen", 1)).toBe(0);
    expect(verrousChat.isHeld("gen", 1, "")).toBe(false);
    verrousChat.acquire("", 3, "");
    expect(verrousChat.isHeld("lock", 3, null)).toBe(true);
    verrousChat.acquire("x".repeat(20), 3, "a");
    expect(verrousChat.isHeld("x".repeat(16) + "yyy", 3, "a")).toBe(true);
  });
});

describe("complétion qui raisonne", () => {
  it("par chat, périmée après 15 min, effacée en fin de raisonnement", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    ctl.noteCompletion("c", "cmpl-1", "m", "conn:3");
    ctl.noteCompletion("", "x", "m", "builtin");
    ctl.noteCompletion("d", "", "m", "builtin");
    expect(ctl.getCompletion("c")).toMatchObject({
      completion_id: "cmpl-1",
      model: "m",
      engine_key: "conn:3",
    });
    expect(ctl.getCompletion("d")).toBeNull();
    ctl.noteCompletion("e", "cmpl-2", "", "");
    expect(ctl.getCompletion("e")).toMatchObject({ model: "", engine_key: "builtin" });
    vi.setSystemTime(1_000_000 + 900_001);
    expect(ctl.getCompletion("c")).toBeNull();
    ctl.noteCompletion("f", "cmpl-3", "m", "builtin");
    ctl.clearCompletion("f");
    expect(ctl.getCompletion("f")).toBeNull();
  });
});
