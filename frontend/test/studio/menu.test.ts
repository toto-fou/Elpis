// SPDX-License-Identifier: MIT
/** frontend/test/studio/menu.test.ts — menu du Studio : trame annotée (jeton de séquence), éléments visibles, feuilles, plans, zoom ancré. */
import { ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { creerMenuStudio } from "../../src/features/studio/menu";
import type { ElementStudio } from "../../src/features/studio/menu";

function el(
  id: string,
  box: [number, number, number, number],
  extra: Partial<ElementStudio> = {},
): ElementStudio {
  return {
    id,
    box,
    center: [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2],
    role: "button",
    label: id,
    depth: 0,
    ...extra,
  };
}

function monter(reponses: Record<string, () => Response> = {}) {
  const urls: string[] = [];
  const toasts: string[] = [];
  const menu = creerMenuStudio(
    { currentView: ref("chat") },
    {
      showToast: (m) => void toasts.push(m),
      fetchAuth: (url) => {
        urls.push(url);
        const f = reponses[url];
        return Promise.resolve(f ? f() : new Response("", { status: 404 }));
      },
    },
  );
  return { menu, urls, toasts };
}

beforeEach(() => {
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:${++n}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.restoreAllMocks());

describe("menu du Studio", () => {
  it("charge les cibles et choisit la cible par défaut", async () => {
    const { menu } = monter({
      "/api/desktop/targets": () => Response.json({ targets: [{ name: "a" }, { name: "b", default: true }] }),
    });
    await menu.loadStudioTargets();
    expect(menu.selectedTarget.value).toBe("b");
    menu.openStudio();
    expect(menu.studioFrame.value.imageUrl).toBe("");
  });

  it("applique une trame : blob, dimensions, boîtes ; la plus récente seule écrit et l'ancien blob est révoqué", async () => {
    const { menu } = monter({
      "/img/1": () => new Response("x"),
      "/img/2": () => new Response("y"),
    });
    await menu.applyFrame({
      image_url: "/img/1",
      img_w: 100,
      img_h: 50,
      boxes: [el("a", [0, 0, 10, 10])],
      target: "vm",
      sig: "s1",
    });
    expect(menu.studioFrame.value).toMatchObject({
      imageUrl: "blob:1",
      imgW: 100,
      imgH: 50,
      target: "vm",
      sig: "s1",
    });
    expect(menu.studioLive.value).toBe(true);
    await menu.applyFrame({ image_url: "/img/2", img_w: 100, img_h: 50, boxes: [] });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:1");
    expect(menu.studioFrame.value.imageUrl).toBe("blob:2");
    menu.clearStudio();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:2");
    expect(menu.studioFrame.value.imageUrl).toBe("");
  });

  it("ne garde que les éléments dans le cadre, rend les feuilles et trie les grands cadres au fond", async () => {
    const { menu } = monter();
    menu.studioFrame.value = {
      imageUrl: "",
      imgW: 200,
      imgH: 100,
      target: "",
      ts: 0,
      boxes: [
        el("grand", [0, 0, 200, 100]),
        el("petit", [10, 10, 40, 30]),
        el("dehors", [500, 500, 600, 600]),
      ],
    };
    expect(menu.studioElements.value.map((e) => e.id)).toEqual(["grand", "petit"]);
    expect(menu.studioOverlayElements.value.map((e) => e.id)).toEqual(["grand", "petit"]);
    expect([...menu.studioLeafIds.value]).toEqual(["petit"]);
    expect(menu.studioVisibleElements.value.map((e) => e.id)).toEqual(["petit"]);
    menu.studioDensity.value = "all";
    expect(menu.studioVisibleElements.value).toHaveLength(2);
    expect(menu.isContainerBox(menu.studioElements.value[0] as ElementStudio)).toBe(true);
  });

  it("sélectionne un élément, déplie ses ancêtres et alimente l'inspecteur", async () => {
    const { menu } = monter();
    menu.studioFrame.value = {
      imageUrl: "",
      imgW: 100,
      imgH: 100,
      target: "",
      ts: 0,
      boxes: [
        el("racine", [0, 0, 100, 100], { depth: 0 }),
        el("fils", [10, 10, 50, 50], { depth: 1, name: "OK" }),
      ],
    };
    menu.collapseAllTree();
    expect(menu.treeCollapsed.value["racine"]).toBe(true);
    menu.selectStudioElement("fils", true);
    expect(menu.selectedElementId.value).toBe("fils");
    expect(menu.treeCollapsed.value["racine"]).toBeUndefined();
    expect(menu.studioInspectInfo.value?.el.id).toBe("fils");
    expect(menu.studioInspectRows.value.some((r) => r.k === "rôle")).toBe(true);
  });

  it("zoome en gardant le point visé et revient à l'ajustement", async () => {
    const { menu } = monter();
    menu.studioFrame.value = { imageUrl: "", imgW: 1000, imgH: 500, target: "", ts: 0, boxes: [] };
    menu.studioStage.value = { w: 500, h: 250 };
    expect(menu.studioViewBox.value).toBe("0 0 1000 500");
    menu.setStudioZoom(2, [500, 250]);
    expect(menu.studioZoom.value).toBe(2);
    expect(menu.studioViewBox.value).toBe("375 187.5 250 125");
    menu.panStudio(10, 0);
    expect(menu.studioViewBox.value.startsWith("385 ")).toBe(true);
    menu.setStudioZoom("fit");
    expect(menu.studioViewBox.value).toBe("0 0 1000 500");
  });

  it("filtre par plans et profondeur", async () => {
    const { menu } = monter();
    menu.studioFrame.value = {
      imageUrl: "",
      imgW: 100,
      imgH: 100,
      target: "",
      ts: 0,
      boxes: [el("a", [0, 0, 100, 100], { depth: 0 }), el("b", [10, 10, 50, 50], { depth: 3 })],
    };
    expect(menu.studioLayerActive.value).toBe(false);
    menu.setDepthMax(1);
    expect(menu.studioLayerFiltered.value.map((e) => e.id)).toEqual(["a"]);
    menu.showAllLayers();
    expect(menu.studioLayerFiltered.value).toHaveLength(2);
  });

  it("refuse une capture sans cible", async () => {
    const { menu, toasts, urls } = monter();
    await menu.captureAndAnnotate();
    expect(toasts).toEqual(["Choisis une cible"]);
    expect(urls).toHaveLength(0);
  });

  it("lit une capture annotée par l'agent et affiche la note de diagnostic", async () => {
    const { menu, toasts } = monter({
      "/api/desktop/capture": () =>
        Response.json({ ok: true, img_w: 10, img_h: 10, boxes: [], note: "annotation vision KO : x" }),
    });
    menu.selectedTarget.value = "vm";
    await menu.captureAndAnnotate();
    expect(toasts).toEqual(["annotation vision KO : x"]);
    expect(menu.studioCapturing.value).toBe(false);
  });
});
