// SPDX-License-Identifier: MIT
/** frontend/test/editor/redimension.test.ts — glissements de l'éditeur : une position par image, aucune mise en page synchrone pendant le geste, mise en page et ajustement au relâchement. */
import { ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parImage, setupEditorResize } from "../../src/features/editor/redimension";

let images: Array<() => void> = [];
beforeEach(() => {
  images = [];
  vi.stubGlobal("requestAnimationFrame", (f: () => void) => images.push(f));
  vi.stubGlobal("cancelAnimationFrame", (n: number) => {
    images[n - 1] = () => undefined;
  });
});
afterEach(() => {
  document.dispatchEvent(new MouseEvent("mouseup"));
  vi.unstubAllGlobals();
});

const image = (): void => {
  const file = images;
  images = [];
  for (const f of file) f();
};

function monde() {
  const terminalHeight = ref(200);
  const explorerWidth = ref(240);
  const layout = vi.fn();
  const fit = vi.fn();
  const r = setupEditorResize(
    {
      terminalHeight,
      explorerWidth,
      settings: ref({ editor_ratio: 50 }) as never,
      monacoRef: { instance: { layout } },
    },
    { ajustement: () => ({ fit }) },
  );
  return { r, terminalHeight, explorerWidth, layout, fit };
}

const bouger = (axe: "clientX" | "clientY", valeurs: number[]): void => {
  for (const v of valeurs) document.dispatchEvent(new MouseEvent("mousemove", { [axe]: v }));
};

describe("parImage", () => {
  it("garde la dernière position de l'image et l'applique une seule fois", () => {
    const vu: number[] = [];
    const p = parImage((x) => vu.push(x));
    p.pousser(1);
    p.pousser(2);
    p.pousser(3);
    expect(vu).toEqual([]);
    image();
    expect(vu).toEqual([3]);
    image();
    expect(vu).toEqual([3]);
  });

  it("vider applique tout de suite la position en attente, sans la rejouer à l'image suivante", () => {
    const vu: number[] = [];
    const p = parImage((x) => vu.push(x));
    p.pousser(5);
    p.vider();
    image();
    p.vider();
    expect(vu).toEqual([5]);
  });
});

describe("glissements de l'éditeur", () => {
  it("terminal : hauteur posée à l'image, ni mise en page ni ajustement pendant le geste, une fois chacun au relâchement", () => {
    const m = monde();
    m.r.terminalResizeStart(new MouseEvent("mousedown", { clientY: 500 }));
    bouger("clientY", [490, 480, 470, 460]);
    expect(m.terminalHeight.value).toBe(200);
    expect(m.layout).not.toHaveBeenCalled();
    expect(m.fit).not.toHaveBeenCalled();
    image();
    expect(m.terminalHeight.value).toBe(240);
    bouger("clientY", [455]);
    document.dispatchEvent(new MouseEvent("mouseup"));
    expect(m.terminalHeight.value).toBe(245);
    expect(m.layout).toHaveBeenCalledTimes(1);
    expect(m.fit).toHaveBeenCalledTimes(1);
  });

  it("terminal : hauteur bornée entre 120 et 600 px", () => {
    const m = monde();
    m.r.terminalResizeStart(new MouseEvent("mousedown", { clientY: 500 }));
    bouger("clientY", [-900]);
    image();
    expect(m.terminalHeight.value).toBe(600);
    bouger("clientY", [900]);
    image();
    expect(m.terminalHeight.value).toBe(120);
  });

  it("explorateur : largeur posée à l'image, mise en page au relâchement seulement", () => {
    const m = monde();
    m.r.explorerResizeStart(new MouseEvent("mousedown", { clientX: 300 }));
    bouger("clientX", [310, 330, 360]);
    expect(m.explorerWidth.value).toBe(240);
    image();
    expect(m.explorerWidth.value).toBe(300);
    expect(m.layout).not.toHaveBeenCalled();
    document.dispatchEvent(new MouseEvent("mouseup"));
    expect(m.layout).toHaveBeenCalledTimes(1);
  });
});
