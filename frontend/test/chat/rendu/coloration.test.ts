// SPDX-License-Identifier: MIT
/** frontend/test/chat/rendu/coloration.test.ts — coloration différée des blocs de code : langue connue, détection bornée, cache, blocs détachés, une tranche par bloc, blocs visibles d'abord, chargement paresseux. */
import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as Coloration from "../../../src/features/chat/rendu/coloration";
import type { Coloreur } from "../../../src/features/chat/rendu/coloration";
import { habillerBlocsCode } from "../../../src/features/chat/rendu/habillage-code";

const vendor = vi.hoisted(() => ({ ensureVendor: vi.fn() }));
vi.mock("../../../src/platform/vendor", () => vendor);

const hljsReel = createRequire(import.meta.url)("@highlightjs/cdn-assets/highlight.min.js") as Coloreur & {
  listLanguages(): string[];
};
type Module = typeof Coloration;
type Tranche = (echeance: { timeRemaining(): number; didTimeout: boolean }) => void;

const globalHljs = window as unknown as { hljs?: unknown };
let coloration: Module;
let tranches: Tranche[] = [];
let espion: { highlight: ReturnType<typeof vi.fn>; highlightAuto: ReturnType<typeof vi.fn> };

function sourceDe(lang: string, texte: string): string {
  const echappe = texte.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return habillerBlocsCode(
    `<pre><code class="hljs${lang ? " language-" + lang : ""}">${echappe}</code></pre>`,
  );
}

function bloc(lang: string, texte: string, parent: HTMLElement = document.body): HTMLElement {
  const hote = document.createElement("div");
  hote.className = "markdown-body";
  hote.innerHTML = sourceDe(lang, texte);
  parent.appendChild(hote);
  return hote.querySelector("code") as HTMLElement;
}

/** Appels de highlight.js qui colorent un texte (hors compilation d'une grammaire sur texte vide). */
function reels(): unknown[][] {
  return espion.highlight.mock.calls.filter(([code]) => code !== "");
}

async function tranche(tempsLibre = 50): Promise<void> {
  const prochaine = tranches.shift();
  if (!prochaine) throw new Error("aucune tranche planifiée");
  prochaine({ timeRemaining: () => tempsLibre, didTimeout: false });
  await Promise.resolve();
}

beforeEach(async () => {
  vi.resetModules();
  tranches = [];
  vendor.ensureVendor.mockReset();
  espion = {
    highlight: vi.fn((code: string, o: { language: string }) => hljsReel.highlight(code, o)),
    highlightAuto: vi.fn((code: string, sous?: readonly string[]) => hljsReel.highlightAuto(code, sous)),
  };
  globalHljs.hljs = { getLanguage: (n: string) => hljsReel.getLanguage(n), ...espion };
  vi.stubGlobal("requestIdleCallback", (cb: Tranche) => tranches.push(cb));
  coloration = await import("../../../src/features/chat/rendu/coloration");
});

afterEach(() => {
  delete globalHljs.hljs;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("langue connue", () => {
  it("colore après l'affichage, texte et classes inchangés, une seule fois", async () => {
    const code = bloc("python", "def f(x):\n    return x * 2  # double\n");
    const avant = code.className;
    expect(code.querySelector("[class^='hljs-']")).toBeNull();
    coloration.planifierColoration(document.body);
    expect(code.querySelector("[class^='hljs-']")).toBeNull();
    await tranche();
    expect(code.querySelector(".hljs-keyword")?.textContent).toBe("def");
    expect(code.textContent).toBe("def f(x):\n    return x * 2  # double\n");
    expect(code.className).toBe(avant);
    expect(reels()).toHaveLength(1);
    expect(reels()[0]?.[1]).toEqual({ language: "python" });
    expect(espion.highlightAuto).not.toHaveBeenCalled();
    coloration.planifierColoration(document.body);
    expect(tranches.length).toBe(0);
    expect(reels()).toHaveLength(1);
  });

  it("le HTML coloré est celui de highlight.js, échappements compris", async () => {
    const texte = '<div class="a">&amp;</div>';
    const code = bloc("html", texte);
    coloration.planifierColoration(document.body);
    await tranche();
    const attendu = document.createElement("code");
    attendu.innerHTML = hljsReel.highlight(texte, { language: "html" }).value;
    expect(code.innerHTML).toBe(attendu.innerHTML);
    expect(code.textContent).toBe(texte);
  });

  it("langue en majuscules : reconnue", async () => {
    const code = bloc("Python", "import os\n");
    coloration.planifierColoration(document.body);
    await tranche();
    expect(reels()[0]?.[1]).toEqual({ language: "python" });
    expect(code.querySelector(".hljs-keyword")).not.toBeNull();
  });
});

describe("sans langue ou langue inconnue : détection bornée", () => {
  it("liste courte sous le seuil, langues toutes enregistrées dans la distribution livrée", async () => {
    const enregistrees = new Set(hljsReel.listLanguages());
    expect(enregistrees.size).toBe(36);
    for (const l of coloration.LANGUES_AUTO) expect(enregistrees.has(l), l).toBe(true);
    expect(coloration.LANGUES_AUTO.length).toBeLessThanOrEqual(12);
    const code = bloc("", "import json\nprint(json.dumps({'a': 1}))\n");
    coloration.planifierColoration(document.body);
    await tranche();
    expect(reels()).toHaveLength(0);
    expect(espion.highlightAuto).toHaveBeenCalledTimes(1);
    expect(espion.highlightAuto.mock.calls[0]?.[1]).toBe(coloration.LANGUES_AUTO);
    expect(code.querySelector("[class^='hljs-']")).not.toBeNull();
  });

  it("langue inconnue : même détection", async () => {
    expect(hljsReel.getLanguage("zzz")).toBeUndefined();
    bloc("zzz", "[serveur]\nport = 80\n");
    coloration.planifierColoration(document.body);
    await tranche();
    expect(espion.highlightAuto).toHaveBeenCalledTimes(1);
  });

  it("au-dessus du seuil : texte simple, aucun appel au coloreur", async () => {
    const long = "ligne de journal sans intérêt\n".repeat(Math.ceil(coloration.AUTO_MAX / 29) + 2);
    expect(long.length).toBeGreaterThan(coloration.AUTO_MAX);
    const code = bloc("", long);
    const avant = code.innerHTML;
    coloration.planifierColoration(document.body);
    await tranche();
    expect(espion.highlightAuto).not.toHaveBeenCalled();
    expect(reels()).toHaveLength(0);
    expect(code.innerHTML).toBe(avant);
    coloration.planifierColoration(document.body);
    expect(tranches.length).toBe(0);
  });

  it("juste sous le seuil : détecté", async () => {
    bloc("", "x".repeat(coloration.AUTO_MAX));
    coloration.planifierColoration(document.body);
    await tranche();
    expect(espion.highlightAuto).toHaveBeenCalledTimes(1);
  });

  it("une langue connue très longue reste colorée jusqu'au plafond absolu, au-delà elle est laissée", async () => {
    const moyen = bloc("json", '{"a": 1}\n'.repeat(1000));
    const enorme = bloc("json", "1\n".repeat(coloration.TEXTE_MAX));
    coloration.planifierColoration(document.body);
    await tranche();
    expect(moyen.querySelector("[class^='hljs-']")).not.toBeNull();
    expect(enorme.querySelector("[class^='hljs-']")).toBeNull();
    expect(reels()).toHaveLength(1);
  });
});

describe("cache langue + texte", () => {
  it("un même bloc rouvert n'est pas recoloré", async () => {
    const texte = "SELECT 1;\n";
    const a = bloc("sql", texte);
    coloration.planifierColoration(document.body);
    await tranche();
    expect(reels()).toHaveLength(1);
    const html = a.innerHTML;
    document.body.innerHTML = "";
    const b = bloc("sql", texte);
    coloration.planifierColoration(document.body);
    await tranche();
    expect(reels()).toHaveLength(1);
    expect(b.innerHTML).toBe(html);
  });

  it("clé = langue + texte : autre langue ou autre texte, nouveau calcul ; le résultat « texte simple » est retenu aussi", async () => {
    bloc("sql", "SELECT 1;\n");
    bloc("sql", "SELECT 2;\n");
    bloc("bash", "SELECT 1;\n");
    coloration.planifierColoration(document.body);
    await tranche();
    expect(reels()).toHaveLength(3);
    const nu = "x".repeat(coloration.AUTO_MAX + 1);
    for (let i = 0; i < 2; i++) {
      document.body.innerHTML = "";
      bloc("", nu);
      coloration.planifierColoration(document.body);
      await tranche();
    }
    expect(espion.highlightAuto).not.toHaveBeenCalled();
  });

  it("borné : les plus anciennes entrées sortent", async () => {
    for (let i = 0; i < 160; i++) {
      document.body.innerHTML = "";
      bloc("sql", `SELECT ${i};\n`);
      coloration.planifierColoration(document.body);
      await tranche();
    }
    expect(reels()).toHaveLength(160);
    document.body.innerHTML = "";
    bloc("sql", "SELECT 0;\n");
    coloration.planifierColoration(document.body);
    await tranche();
    expect(reels()).toHaveLength(161);
    document.body.innerHTML = "";
    bloc("sql", "SELECT 159;\n");
    coloration.planifierColoration(document.body);
    await tranche();
    expect(reels()).toHaveLength(161);
  });
});

describe("blocs écartés", () => {
  it("bloc détaché du document avant sa tranche : ni coloré ni calculé", async () => {
    const code = bloc("python", "x = 1\n");
    coloration.planifierColoration(document.body);
    code.closest(".markdown-body")?.remove();
    await tranche();
    expect(reels()).toHaveLength(0);
    expect(code.querySelector("[class^='hljs-']")).toBeNull();
  });

  it("bloc dont la recherche a posé des surlignages : laissé tel quel (ils seraient effacés)", async () => {
    const code = bloc("python", "x = 1\n");
    code.innerHTML = 'x = <mark class="elpis-search-hl">1</mark>\n';
    coloration.planifierColoration(document.body);
    await tranche();
    expect(reels()).toHaveLength(0);
    expect(code.querySelector("mark")).not.toBeNull();
  });

  it("langues spéciales et blocs de repli : jamais dans la file", () => {
    const hote = document.createElement("div");
    hote.className = "markdown-body";
    hote.innerHTML =
      habillerBlocsCode('<pre><code class="hljs language-mermaid">a --&gt; b</code></pre>') +
      '<div class="code-wrapper"><pre><code class="language-py">x</code></pre></div>';
    document.body.appendChild(hote);
    coloration.planifierColoration(document.body);
    expect(tranches.length).toBe(0);
  });

  it("le caret de flux d'un bloc figé survit à la coloration", async () => {
    const code = bloc("python", "x = 1");
    code.insertAdjacentHTML("beforeend", '<span class="elpis-stream-caret"></span>');
    coloration.planifierColoration(document.body);
    await tranche();
    expect(code.querySelector(".hljs-number")).not.toBeNull();
    expect(code.lastElementChild?.className).toBe("elpis-stream-caret");
  });
});

describe("tranches de temps libre", () => {
  it("sans temps libre : une unité de travail par tranche (compilation d'une grammaire, puis un bloc), la suivante planifiée tant qu'il en reste", async () => {
    const codes = ["a = 1", "b = 2", "c = 3"].map((t) => bloc("python", t));
    coloration.planifierColoration(document.body);
    expect(tranches.length).toBe(1);
    const colores = () => codes.filter((c) => c.hasAttribute("data-hl")).length;
    await tranche(0);
    expect(colores()).toBe(0);
    expect(tranches.length).toBe(1);
    await tranche(0);
    expect(colores()).toBe(1);
    await tranche(0);
    expect(colores()).toBe(2);
    await tranche(0);
    expect(colores()).toBe(3);
    expect(tranches.length).toBe(0);
  });

  it("grammaires compilées une par tranche avant la détection automatique, jamais deux dans une tranche sans temps libre", async () => {
    const code = bloc("", "import json\nprint(json.dumps({}))\n");
    coloration.planifierColoration(document.body);
    let tranchesUtilisees = 0;
    while (!code.hasAttribute("data-hl")) {
      const avant = espion.highlight.mock.calls.length;
      await tranche(0);
      tranchesUtilisees++;
      expect(
        espion.highlight.mock.calls.length - avant + espion.highlightAuto.mock.calls.length,
      ).toBeLessThanOrEqual(1);
      expect(tranchesUtilisees).toBeLessThanOrEqual(coloration.LANGUES_AUTO.length + 1);
    }
    expect(tranchesUtilisees).toBe(coloration.LANGUES_AUTO.length + 1);
    const compilees = espion.highlight.mock.calls
      .filter(([c]) => c === "")
      .map(([, o]) => (o as { language: string }).language);
    expect(compilees).toEqual([...coloration.LANGUES_AUTO]);
    expect(espion.highlightAuto).toHaveBeenCalledTimes(1);
  });

  it("une grammaire déjà compilée n'est pas recompilée", async () => {
    bloc("python", "a = 1");
    bloc("python", "b = 2");
    coloration.planifierColoration(document.body);
    await tranche();
    expect(espion.highlight.mock.calls.filter(([c]) => c === "")).toHaveLength(1);
    expect(reels()).toHaveLength(2);
  });

  it("avec du temps libre : plusieurs blocs dans la même tranche", async () => {
    for (const t of ["a = 1", "b = 2", "c = 3"]) bloc("python", t);
    coloration.planifierColoration(document.body);
    await tranche(50);
    expect(reels()).toHaveLength(3);
    expect(tranches.length).toBe(0);
  });

  it("blocs visibles d'abord à l'ouverture d'une conversation", async () => {
    const codes = ["a = 1", "b = 2", "c = 3"].map((t) => bloc("python", t));
    codes[0]!.getBoundingClientRect = () => ({ top: -2000, bottom: -1900 }) as DOMRect;
    codes[1]!.getBoundingClientRect = () => ({ top: 3000, bottom: 3100 }) as DOMRect;
    codes[2]!.getBoundingClientRect = () => ({ top: 100, bottom: 200 }) as DOMRect;
    coloration.planifierColoration(document.body);
    await tranche(0);
    await tranche(0);
    expect(codes[2]!.hasAttribute("data-hl")).toBe(true);
    expect(codes[0]!.hasAttribute("data-hl")).toBe(false);
    await tranche(0);
    expect(codes[0]!.hasAttribute("data-hl")).toBe(true);
    expect(codes[1]!.hasAttribute("data-hl")).toBe(false);
    await tranche(0);
    expect(codes[1]!.hasAttribute("data-hl")).toBe(true);
  });

  it("sans requestIdleCallback : repli sur un délai", async () => {
    vi.stubGlobal("requestIdleCallback", undefined);
    vi.useFakeTimers();
    try {
      const code = bloc("python", "x = 1");
      coloration.planifierColoration(document.body);
      expect(code.hasAttribute("data-hl")).toBe(false);
      await vi.advanceTimersByTimeAsync(40);
      expect(code.hasAttribute("data-hl")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("balayage de la page : un seul passage planifié pour tous les appels, une fois le HTML posé", async () => {
    const code = bloc("python", "x = 1");
    coloration.planifierBalayage();
    coloration.planifierBalayage();
    expect(tranches.length).toBe(1);
    await tranche();
    expect(tranches.length).toBe(1);
    await tranche();
    expect(code.hasAttribute("data-hl")).toBe(true);
  });
});

describe("highlight.js chargé à la demande", () => {
  it("le code reste lisible tant que la bibliothèque n'est pas là, puis se colore", async () => {
    delete globalHljs.hljs;
    let charge: () => void = () => {};
    vendor.ensureVendor.mockImplementation(() => new Promise<void>((r) => (charge = r)));
    const code = bloc("python", "def f():\n    pass\n");
    coloration.planifierColoration(document.body);
    await tranche();
    expect(vendor.ensureVendor).toHaveBeenCalledWith("highlight");
    expect(code.textContent).toBe("def f():\n    pass\n");
    expect(code.querySelector("[class^='hljs-']")).toBeNull();
    expect(tranches.length).toBe(0);
    expect(vendor.ensureVendor).toHaveBeenCalledTimes(1);
    globalHljs.hljs = { getLanguage: (n: string) => hljsReel.getLanguage(n), ...espion };
    charge();
    await Promise.resolve();
    await Promise.resolve();
    await tranche();
    expect(code.querySelector(".hljs-keyword")?.textContent).toBe("def");
  });

  it("chargement refusé : le code reste lisible et la file est vidée", async () => {
    delete globalHljs.hljs;
    vendor.ensureVendor.mockRejectedValue(new Error("hors ligne"));
    const code = bloc("python", "x = 1");
    coloration.planifierColoration(document.body);
    await tranche();
    await Promise.resolve();
    await Promise.resolve();
    expect(tranches.length).toBe(0);
    expect(code.textContent).toBe("x = 1");
    expect(code.querySelector("[class^='hljs-']")).toBeNull();
  });

  it("erreur du coloreur : bloc laissé en texte simple, jamais d'exception", async () => {
    globalHljs.hljs = {
      getLanguage: () => true,
      highlight: () => {
        throw new Error("grammaire");
      },
      highlightAuto: () => {
        throw new Error("grammaire");
      },
    };
    const code = bloc("python", "x = 1");
    coloration.planifierColoration(document.body);
    await tranche();
    expect(code.textContent).toBe("x = 1");
    expect(code.hasAttribute("data-hl")).toBe(true);
  });
});
