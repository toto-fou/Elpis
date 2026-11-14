// SPDX-License-Identifier: MIT
/** frontend/test/chat/coeur/hauteur-composeur.test.ts — hauteur de la colonne du composeur : lue par l'observateur après la mise en page, jamais au montage. */
import { effectScope, nextTick } from "vue";
import { afterEach, expect, it, vi } from "vitest";

import { creerEtatChat } from "../../../src/features/chat/coeur/etat";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("le montage du composeur ne lit pas sa hauteur ; l'observateur la donne, la fin du fil s'y cale", async () => {
  let lectures = 0;
  let notifier: (() => void) | null = null;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        notifier = cb;
      }
      observe(): void {}
      disconnect(): void {}
    },
  );
  const portee = effectScope();
  const e = portee.run(() => creerEtatChat())!;
  const colonne = document.createElement("div");
  Object.defineProperty(colonne, "offsetHeight", {
    get: () => {
      lectures++;
      return 140;
    },
  });
  e.composeColRef.value = colonne;
  await nextTick();
  expect(lectures).toBe(0);
  expect(e.chatBottomPad.value).toBe(128);
  notifier!();
  expect(e.composerHeight.value).toBe(140);
  expect(e.chatBottomPad.value).toBe(180);
  e.composeColRef.value = null;
  await nextTick();
  expect(e.composerHeight.value).toBe(0);
  portee.stop();
});
