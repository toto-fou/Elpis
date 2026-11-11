// SPDX-License-Identifier: MIT
/** frontend/test/editor/onglets.test.ts — onglets de l'éditeur : règles pures (libellé, homonymes, épinglage, glisser-déposer) et composants OngletsEditeur / MenuOnglet (événements, observateur libéré au démontage). */
import { createApp, h, nextTick, shallowRef } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import MenuOnglet from "../../src/components/editor/MenuOnglet.vue";
import OngletsEditeur from "../../src/components/editor/OngletsEditeur.vue";
import {
  basculerEpingle,
  deplacerOnglet,
  indicesHomonymes,
  partiesLibelle,
  positionMenu,
} from "../../src/features/editor/onglets";
import type { OngletEditeur } from "../../src/features/editor/onglets";

const t = (path: string, pinned = false): OngletEditeur => ({
  path,
  name: path.split("/").pop() ?? path,
  pinned,
});
const chemins = (l: OngletEditeur[] | null): string[] => (l ?? []).map((x) => x.path);

describe("règles des onglets", () => {
  it("libellé en deux parts : extension et quatre caractères gardés", () => {
    expect(partiesLibelle("court.py")).toEqual({ head: "court.py", tail: "" });
    expect(partiesLibelle("rapport_2026_09_19.py")).toEqual({ head: "rapport_2026_0", tail: "9_19.py" });
    expect(partiesLibelle("sansextensionlongue")).toEqual({ head: "sansextensionl", tail: "ongue" });
  });

  it("homonymes : le plus court suffixe de dossier qui les distingue", () => {
    const i = indicesHomonymes([t("a/x/index.js"), t("b/x/index.js"), t("index.js"), t("seul.py")]);
    expect(i).toEqual({ "a/x/index.js": "a/x", "b/x/index.js": "b/x", "index.js": "/" });
  });

  it("épinglage : fin du groupe épinglé, puis début des autres au désépinglage", () => {
    const l = [t("p1", true), t("a"), t("b")];
    expect(chemins(basculerEpingle(l, "b"))).toEqual(["p1", "b", "a"]);
    expect(chemins(basculerEpingle(l, "p1"))).toEqual(["p1", "a", "b"]);
    expect(basculerEpingle(l, "absent")).toBeNull();
  });

  it("glisser-déposer : derrière une cible située après, borné au groupe d'épinglage", () => {
    const l = [t("p1", true), t("p2", true), t("a"), t("b"), t("c")];
    expect(chemins(deplacerOnglet(l, "a", "c"))).toEqual(["p1", "p2", "b", "c", "a"]);
    expect(chemins(deplacerOnglet(l, "c", "a"))).toEqual(["p1", "p2", "c", "a", "b"]);
    expect(chemins(deplacerOnglet(l, "p1", "c"))).toEqual(["p2", "p1", "a", "b", "c"]);
    expect(chemins(deplacerOnglet(l, "c", "p1"))).toEqual(["p1", "p2", "c", "a", "b"]);
    expect(deplacerOnglet(l, "a", "a")).toBeNull();
  });

  it("menu borné à la fenêtre", () => {
    expect(positionMenu(10, 20, 1000, 800)).toEqual({ x: 10, y: 20 });
    expect(positionMenu(990, 790, 1000, 800)).toEqual({ x: 772, y: 412 });
  });
});

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function monter(rendu: () => ReturnType<typeof h>): HTMLElement {
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: rendu });
  app.mount(hote);
  return hote;
}

describe("OngletsEditeur", () => {
  it("rend les onglets, émet activation, fermeture, menu et réordonnancement", async () => {
    const onglets = shallowRef([t("a.py"), t("dir/b.py")]);
    const evts: string[] = [];
    const hote = monter(() =>
      h(OngletsEditeur, {
        visible: true,
        onglets: onglets.value,
        actif: "a.py",
        modifies: new Set(["dir/b.py"]),
        ongletDroit: null,
        indices: {},
        caches: 0,
        debordement: false,
        metaFichier: () => ({ icon: "ph-file", color: "text-slate-400" }),
        onActiver: (p: string) => evts.push("activer:" + p),
        onBasculer: (p: string) => evts.push("basculer:" + p),
        onFermer: (p: string) => evts.push("fermer:" + p),
        onMenu: (_e: Event, p: string) => evts.push("menu:" + p),
        onReordonner: (l: OngletEditeur[]) => {
          evts.push("ordre:" + chemins(l).join(","));
          onglets.value = l;
        },
      }),
    );
    const tabs = hote.querySelectorAll<HTMLElement>('[role="tab"]');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]?.querySelector(".bg-amber-400")).not.toBeNull();
    tabs[1]?.click();
    tabs[1]?.querySelector("button")?.click();
    tabs[0]?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    tabs[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    tabs[0]?.dispatchEvent(new Event("dragstart", { bubbles: true }));
    tabs[1]?.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    tabs[1]?.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    await nextTick();
    expect(evts).toEqual([
      "activer:dir/b.py",
      "fermer:dir/b.py",
      "menu:a.py",
      "basculer:a.py",
      "ordre:dir/b.py,a.py",
    ]);
    expect(hote.querySelectorAll('[role="tab"]')[0]?.getAttribute("data-path")).toBe("dir/b.py");
  });

  it("possède son observateur de taille : 50 montages et démontages sans observateur restant", () => {
    let actifs = 0;
    class FauxRO {
      constructor(_cb: ResizeObserverCallback) {}
      observe(): void {
        actifs++;
      }
      disconnect(): void {
        actifs--;
      }
      unobserve(): void {}
    }
    vi.stubGlobal("ResizeObserver", FauxRO);
    for (let i = 0; i < 50; i++) {
      monter(() =>
        h(OngletsEditeur, {
          visible: true,
          onglets: [t("a.py")],
          actif: "a.py",
          modifies: new Set<string>(),
          ongletDroit: null,
          indices: {},
          caches: 0,
          debordement: false,
          metaFichier: () => ({ icon: "ph-file", color: "" }),
        }),
      );
      expect(actifs).toBe(1);
      app?.unmount();
      app = null;
    }
    expect(actifs).toBe(0);
  });
});

describe("MenuOnglet", () => {
  it("« Fermer » émet la fermeture puis la clôture ; les autres entrées émettent leur action seule", () => {
    const evts: string[] = [];
    const hote = monter(() =>
      h(MenuOnglet, {
        ouvert: true,
        x: 5,
        y: 6,
        chemin: "a.py",
        nbOnglets: 1,
        epingle: true,
        visionneuse: false,
        nbModifies: 0,
        onClore: () => evts.push("clore"),
        onFermer: (p: string) => evts.push("fermer:" + p),
        onLocaliser: (p: string) => evts.push("localiser:" + p),
      }),
    );
    const boutons = [...hote.querySelectorAll("button")];
    expect(boutons.map((b) => b.textContent?.trim().split("\n")[0])).toContain("Désépingler");
    expect(boutons[1]?.disabled).toBe(true);
    boutons[0]?.click();
    boutons.find((b) => b.textContent?.includes("Localiser"))?.click();
    expect(evts).toEqual(["fermer:a.py", "clore", "localiser:a.py"]);
  });
});
