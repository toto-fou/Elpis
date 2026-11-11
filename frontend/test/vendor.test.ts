// SPDX-License-Identifier: MIT
/** frontend/test/vendor.test.ts — chargement à la demande des bibliothèques UMD : URL hachée du build, mémoïsation, nouvel essai après un échec, groupe inconnu refusé. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { definirCarteVendor, ensureVendor, urlVendor } from "../src/platform/vendor";

type Globals = Record<string, unknown>;
const w = window as unknown as Globals;

/** Les <script> ajoutés sont « chargés » au tick suivant ; `pose` simule le global posé par le bundle. */
function scriptsSimules(pose: (src: string) => void, echec = false): string[] {
  const vus: string[] = [];
  vi.spyOn(document.head, "appendChild").mockImplementation(<T extends Node>(el: T): T => {
    const s = el as unknown as HTMLScriptElement;
    vus.push(s.src);
    setTimeout(() => {
      if (echec) s.onerror?.(new Event("error"));
      else {
        pose(s.src);
        s.onload?.(new Event("load"));
      }
    }, 0);
    return el;
  });
  return vus;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ["echarts", "mermaid", "hljs"]) delete w[k];
});

describe("ensureVendor", () => {
  it("charge l'URL du build, une seule fois pour des appels concurrents", async () => {
    definirCarteVendor({
      "vendor/echarts.min.js": "http://x/assets/echarts-h.js",
      "vendor/echarts-langFR.js": "http://x/assets/fr-h.js",
    });
    const vus = scriptsSimules((src) => {
      if (src.includes("fr-h")) w["echarts"] = {};
    });
    await Promise.all([ensureVendor("echarts"), ensureVendor("echarts")]);
    expect(vus).toEqual(["http://x/assets/echarts-h.js", "http://x/assets/fr-h.js"]);
    await ensureVendor("echarts");
    expect(vus).toHaveLength(2);
  });

  it("un échec purge la mémoïsation : l'appel suivant réessaie", async () => {
    definirCarteVendor({});
    const vus = scriptsSimules(() => undefined, true);
    await expect(ensureVendor("mermaid")).rejects.toThrow(/Chargement impossible/);
    await expect(ensureVendor("mermaid")).rejects.toThrow(/Chargement impossible/);
    expect(vus).toHaveLength(2);
  });

  it("bibliothèque absente après chargement, groupe inconnu : rejet", async () => {
    scriptsSimules(() => undefined);
    await expect(ensureVendor("highlight")).rejects.toThrow(/non disponible/);
    await expect(ensureVendor("monaco")).rejects.toThrow(/Groupe vendor inconnu/);
  });

  it("clé inconnue de la carte : rendue telle quelle", () => {
    definirCarteVendor({ "vendor/chart.js": "assets/chart-h.js" });
    expect(urlVendor("static/vendor/chart.js")).toBe("assets/chart-h.js");
    expect(urlVendor("vendor/absent.js")).toBe("vendor/absent.js");
  });
});
