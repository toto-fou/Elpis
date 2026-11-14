// SPDX-License-Identifier: MIT
/** frontend/test/racine/defilement-colle.test.ts — fil collé en bas : un contenu qui grandit sans défilement (enrichissement, image) le garde collé ; remonté par l'utilisateur, il ne bouge pas ; pendant un battement du flux, l'observateur de taille laisse faire. */
import { nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { creerDefilementChat } from "../../src/app/racine/defilement";
import { marquerBattement } from "../../src/utils/battement";

/** Conteneur défilant minimal : scrollTop borné comme dans un navigateur. */
function conteneur(hauteur: number) {
  let haut = 0;
  const ecoutes = new Map<string, (e?: unknown) => void>();
  const el = {
    scrollHeight: hauteur,
    clientHeight: 600,
    firstElementChild: null,
    get scrollTop() {
      return haut;
    },
    set scrollTop(v: number) {
      haut = Math.max(0, Math.min(v, el.scrollHeight - el.clientHeight));
    },
    addEventListener: (type: string, f: (e?: unknown) => void) => ecoutes.set(type, f),
    removeEventListener: () => undefined,
    defiler(v: number) {
      el.scrollTop = v;
      ecoutes.get("scroll")?.();
    },
    appuyer(cible: unknown) {
      ecoutes.get("pointerdown")?.({ target: cible });
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
  const suivis = { n: 0 };
  const api = creerDefilementChat({
    conteneur: () => elRef.value as HTMLElement | null,
    isUserScrolling,
    onChatScroll: () => suivis.n++,
  });
  elRef.value = el;
  await nextTick();
  return { el, cible: elRef.value, isUserScrolling, verrouiller: api.verrouillerDefilementAuto, suivis };
}

afterEach(() => {
  marquerBattement(false);
  vi.unstubAllGlobals();
  rappel = null;
});

describe("fil collé en bas", () => {
  it("un contenu qui grandit sous un fil collé le garde collé", async () => {
    const { el } = await monter(2000);
    el.defiler(1400);
    el.scrollHeight = 2033;
    rappel?.();
    expect(el.scrollTop).toBe(1433);
  });

  it("pendant un battement du flux, l'observateur ne touche pas au défilement ; ensuite il reprend son rôle", async () => {
    const { el } = await monter(2000);
    el.defiler(1400);
    el.scrollHeight = 2033;
    marquerBattement(true);
    rappel?.();
    expect(el.scrollTop).toBe(1400);
    marquerBattement(false);
    rappel?.();
    expect(el.scrollTop).toBe(1433);
  });

  it("barre de défilement tirée vers le haut pendant le verrou d'un flux : le suivi est coupé ; un défilement programmé ne l'est pas", async () => {
    const { el, cible, isUserScrolling, verrouiller } = await monter(3000);
    el.defiler(2400);
    verrouiller();
    el.defiler(2000);
    expect(isUserScrolling.value).toBe(false);
    el.defiler(2400);
    el.appuyer(cible);
    el.defiler(2100);
    expect(isUserScrolling.value).toBe(true);
    isUserScrolling.value = false;
    el.defiler(2400);
    el.appuyer({});
    el.defiler(2100);
    expect(isUserScrolling.value).toBe(false);
  });

  it("geste de l'utilisateur pendant le verrou : la fenêtre virtuelle suit ; un défilement programmé ne la relance pas", async () => {
    const { el, isUserScrolling, verrouiller, suivis } = await monter(3000);
    el.defiler(2400);
    verrouiller();
    const avant = suivis.n;
    el.defiler(2300);
    expect(suivis.n).toBe(avant);
    isUserScrolling.value = true;
    el.defiler(2000);
    expect(suivis.n).toBe(avant + 1);
  });

  it("relâchement perdu : un mouvement du pointeur sans bouton enfoncé rend la barre", async () => {
    const { el, cible, isUserScrolling, verrouiller } = await monter(3000);
    el.defiler(2400);
    verrouiller();
    el.appuyer(cible);
    window.dispatchEvent(Object.assign(new Event("pointermove"), { buttons: 1 }));
    el.defiler(2300);
    expect(isUserScrolling.value).toBe(true);
    isUserScrolling.value = false;
    el.defiler(2400);
    window.dispatchEvent(Object.assign(new Event("pointermove"), { buttons: 0 }));
    el.defiler(2100);
    expect(isUserScrolling.value).toBe(false);
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
