// SPDX-License-Identifier: MIT
/** frontend/test/racine/defilement-colle.test.ts — fil collé en bas : un contenu qui grandit sans défilement (enrichissement, image) le garde collé ; remonté par l'utilisateur, il ne bouge pas. */
import { nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { creerDefilementChat } from "../../src/app/racine/defilement";

/** Conteneur défilant minimal : scrollTop borné comme dans un navigateur. */
function conteneur(hauteur: number) {
  let haut = 0;
  const ecoutes = new Map<string, () => void>();
  const el = {
    scrollHeight: hauteur,
    clientHeight: 600,
    style: { scrollBehavior: "" },
    firstElementChild: null,
    get scrollTop() {
      return haut;
    },
    set scrollTop(v: number) {
      haut = Math.max(0, Math.min(v, el.scrollHeight - el.clientHeight));
    },
    addEventListener: (type: string, f: () => void) => ecoutes.set(type, f),
    removeEventListener: () => undefined,
    defiler(v: number) {
      el.scrollTop = v;
      ecoutes.get("scroll")?.();
    },
  };
  return el;
}

let rappel: (() => void) | null = null;

async function monter(hauteur: number) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(f: () => void) {
        rappel = f;
      }
      observe(): void {}
      disconnect(): void {}
    },
  );
  const el = conteneur(hauteur);
  const isUserScrolling = ref(false);
  const elRef = ref<unknown>(null);
  creerDefilementChat({ conteneur: () => elRef.value as HTMLElement | null, isUserScrolling });
  elRef.value = el;
  await nextTick();
  return { el, isUserScrolling };
}

afterEach(() => {
  vi.unstubAllGlobals();
  rappel = null;
});

describe("fil collé en bas", () => {
  it("un contenu qui grandit sous un fil collé le garde collé, en saut instantané", async () => {
    const { el } = await monter(2000);
    el.defiler(1400);
    el.style.scrollBehavior = "smooth";
    el.scrollHeight = 2033;
    rappel?.();
    expect(el.scrollTop).toBe(1433);
    expect(el.style.scrollBehavior).toBe("smooth");
  });

  it("remonté par l'utilisateur, le fil ne bouge pas quand le contenu grandit", async () => {
    const { el, isUserScrolling } = await monter(2000);
    el.defiler(800);
    isUserScrolling.value = true;
    el.scrollHeight = 2033;
    rappel?.();
    expect(el.scrollTop).toBe(800);
  });

  it("à quelques pixels du bas sans geste en cours, le fil n'est pas recollé s'il n'était pas collé", async () => {
    const { el } = await monter(2000);
    el.defiler(1390);
    el.scrollHeight = 2033;
    rappel?.();
    expect(el.scrollTop).toBe(1390);
  });
});
