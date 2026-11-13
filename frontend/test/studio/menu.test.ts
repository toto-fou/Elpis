// SPDX-License-Identifier: MIT
/** frontend/test/studio/menu.test.ts — menu du Studio : trame annotée (jeton de séquence, attente Studio fermé), éléments visibles, plans, zoom ancré, diviseur de l'arbre. */
import { ref, watchSyncEffect } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { creerMenuStudio, glisserPoignee } from "../../src/features/studio/menu";
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

function monter(reponses: Record<string, () => Response> = {}, vue = "studio") {
  const urls: string[] = [];
  const toasts: string[] = [];
  const menu = creerMenuStudio(
    { currentView: ref(vue) },
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

  it("Studio fermé : la dernière trame attend l'ouverture, sans téléchargement ni décodage", async () => {
    const decoder = vi.fn(() => Promise.resolve({ width: 640, height: 480, close: () => undefined }));
    vi.stubGlobal("createImageBitmap", decoder);
    const { menu, urls } = monter(
      { "/img/2": () => new Response("y"), "/img/3": () => new Response("z") },
      "chat",
    );
    await menu.applyFrame({ image_url: "/img/1", img_w: 100, img_h: 50, boxes: [], target: "vm" });
    await menu.applyFrame({ image_url: "/img/2", boxes: [el("a", [0, 0, 10, 10])], target: "vm" });
    expect(urls).toEqual([]);
    expect(menu.studioFrame.value.imageUrl).toBe("");
    menu.openStudio();
    await vi.waitFor(() => expect(menu.studioFrame.value.imageUrl).toBe("blob:1"));
    expect(urls).toContain("/img/2");
    expect(urls).not.toContain("/img/1");
    expect(menu.studioFrame.value).toMatchObject({ imgW: 640, imgH: 480 });
    expect(menu.studioElements.value.map((e) => e.id)).toEqual(["a"]);
    expect(menu.studioLive.value).toBe(true);
    await menu.applyFrame({ image_url: "/img/3", img_w: 100, img_h: 50, boxes: [] });
    expect(decoder).toHaveBeenCalledTimes(1);
    expect(menu.studioFrame.value).toMatchObject({ imageUrl: "blob:2", imgW: 100, imgH: 50 });
    vi.unstubAllGlobals();
  });

  it("une trame reçue Studio fermé depuis plus de 2,5 s s'affiche sans l'indicateur LIVE ; effacer le Studio l'oublie", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { menu, urls } = monter({ "/img/1": () => new Response("x") }, "chat");
    await menu.applyFrame({ image_url: "/img/1", img_w: 100, img_h: 50, boxes: [] });
    vi.setSystemTime(Date.now() + 3000);
    menu.openStudio();
    await vi.waitFor(() => expect(menu.studioFrame.value.imageUrl).toBe("blob:1"));
    expect(menu.studioLive.value).toBe(false);
    menu.closeStudio();
    await menu.applyFrame({ image_url: "/img/1", img_w: 100, img_h: 50, boxes: [] });
    menu.clearStudio();
    menu.openStudio();
    await Promise.resolve();
    expect(urls.filter((u) => u === "/img/1")).toHaveLength(1);
    vi.useRealTimers();
  });

  it("ne garde que les éléments dans le cadre et trie les grands cadres au fond", async () => {
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

  it("glisser le diviseur de l'arbre : une largeur par image, fin au relâchement ou à la perte du pointeur", () => {
    const images: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => images.push(f));
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const { menu } = monter();
    const poignee = document.createElement("div");
    const largeurs: number[] = [];
    const arret = watchSyncEffect(() => largeurs.push(menu.studioTreeWidth.value));
    const depart = menu.studioTreeWidth.value;
    menu.studioTreeDockDragStart({
      button: 0,
      clientX: 500,
      pointerId: 1,
      currentTarget: poignee,
      preventDefault: () => undefined,
    } as unknown as PointerEvent);
    for (const x of [495, 490, 480]) poignee.dispatchEvent(new MouseEvent("pointermove", { clientX: x }));
    expect(images).toHaveLength(1);
    expect(largeurs).toEqual([depart]);
    images.shift()?.(0);
    expect(largeurs).toEqual([depart, depart + 20]);
    poignee.dispatchEvent(new MouseEvent("pointermove", { clientX: 470 }));
    poignee.dispatchEvent(new MouseEvent("lostpointercapture"));
    expect(largeurs).toEqual([depart, depart + 20, depart + 30]);
    expect(localStorage.getItem("studioTreeWidth")).toBe(String(depart + 30));
    poignee.dispatchEvent(new MouseEvent("pointermove", { clientX: 300 }));
    poignee.dispatchEvent(new MouseEvent("pointerup"));
    images.splice(0).forEach((f) => f(0));
    expect(largeurs).toHaveLength(3);
    arret();
    vi.unstubAllGlobals();
  });

  it("un autre bouton que le principal ne commence pas de glisser", () => {
    const appliquer = vi.fn();
    const poignee = document.createElement("div");
    glisserPoignee({ button: 2, currentTarget: poignee } as unknown as PointerEvent, appliquer, appliquer);
    poignee.dispatchEvent(new MouseEvent("pointermove", { clientX: 1 }));
    poignee.dispatchEvent(new MouseEvent("pointerup"));
    expect(appliquer).not.toHaveBeenCalled();
  });
});
