// SPDX-License-Identifier: MIT
/** frontend/test/chat/rendu/contenu-markdown.test.ts — composant ContenuMarkdown : blocs figés conservés pendant le flux, rendu final, recherche, purification. */
import { createRequire } from "node:module";

import { createApp, h, nextTick, shallowRef } from "vue";
import type { App, VNode } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ContenuMarkdown from "../../../src/components/chat/ContenuMarkdown.vue";
import NarrationVivante from "../../../src/components/chat/NarrationVivante.vue";
import type { MessageMarkdown } from "../../../src/components/chat/ContenuMarkdown.vue";
import type { EtatFlux } from "../../../src/features/chat/rendu/flux-blocs";
import { moteurMarkdown } from "../../../src/features/chat/rendu/instance";

vi.mock("../../../src/platform/vendor", () => ({
  ensureVendor: () => Promise.reject(new Error("Chargement impossible")),
}));

let app: App | null = null;
const copies: string[] = [];

beforeEach(() => {
  copies.length = 0;
  vi.stubGlobal("navigator", {
    clipboard: { writeText: (t: string) => Promise.resolve(void copies.push(t)) },
  });
  vi.stubGlobal("isSecureContext", true);
});
const clics: MouseEvent[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  app?.unmount();
  app = null;
  clics.length = 0;
  document.body.innerHTML = "";
});

function monterRendu(rendu: () => VNode): HTMLElement {
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: rendu });
  app.mount(hote);
  return hote;
}

function monter(msg: MessageMarkdown, recherche = "") {
  const etat = shallowRef(msg);
  const q = shallowRef(recherche);
  const hote = monterRendu(() =>
    h(ContenuMarkdown, {
      msg: etat.value,
      recherche: q.value,
      onClickMarkdown: (e: MouseEvent) => clics.push(e),
    }),
  );
  return { hote, etat, q };
}

/** Reproduit le patch du battement : blocs figés rendus une fois par la découpe, bloc actif re-rendu. */
function flux(precedent: MessageMarkdown, texte: string): MessageMarkdown {
  const m = moteurMarkdown();
  const r = m.avancerFlux(texte, (precedent._mdFlux as EtatFlux | null | undefined) ?? null);
  return {
    ...precedent,
    content: texte,
    isStreaming: true,
    _mdBlocks: r.etat.blocs.length ? r.etat.blocs : null,
    _mdActiveHtml: m.injecterCaret(r.actifHtml),
    _mdFlux: r.etat,
  };
}

/** Reproduit la fin de tour : le bloc actif est figé, le message garde ses blocs. */
function fin(precedent: MessageMarkdown, texte: string): MessageMarkdown {
  const r = moteurMarkdown().terminerFlux(texte, (precedent._mdFlux as EtatFlux | null | undefined) ?? null);
  if (!r) throw new Error("le texte garde ses blocs");
  return { content: texte, isStreaming: false, _mdBlocks: r.etat.blocs, _mdActiveHtml: "", _mdFlux: r.etat };
}

describe("ContenuMarkdown", () => {
  it("flux : les blocs figés gardent leur nœud DOM, seul le bloc actif change", async () => {
    let msg = flux({}, "Premier paragraphe.\n\nDeu");
    const { hote, etat } = monter(msg);
    const racine = hote.firstElementChild as HTMLElement;
    expect(racine.getAttribute("aria-busy")).toBe("true");
    expect(racine.className).toBe("markdown-body bg-transparent");
    const premier = racine.firstElementChild;
    expect(premier?.innerHTML).toContain("<p>Premier paragraphe.</p>");
    expect(racine.querySelector(".elpis-stream-caret")).not.toBeNull();
    msg = flux(msg, "Premier paragraphe.\n\nDeuxième en cours");
    etat.value = msg;
    await nextTick();
    expect(racine.firstElementChild).toBe(premier);
    expect(racine.textContent).toContain("Deuxième en cours");
    msg = flux(msg, "Premier paragraphe.\n\nDeuxième fini.\n\n");
    etat.value = msg;
    await nextTick();
    expect(racine.firstElementChild).toBe(premier);
    expect(racine.children.length).toBe(2);
    const caret = racine.querySelector("span.elpis-stream-caret");
    expect(caret?.parentElement?.tagName).toBe("P");
    expect(caret?.parentElement?.textContent).toBe("Deuxième fini.");
  });

  it("flux : bloc de code habillé dès le premier caractère, Copier lit le texte courant, bloc figé identique au rendu final", async () => {
    let msg = flux({}, "Avant\n\n```py\nx = 1");
    const { hote, etat } = monter(msg);
    const racine = hote.firstElementChild as HTMLElement;
    expect(racine.querySelector(".code-wrapper > .code-header span")?.textContent).toBe("PY");
    racine.querySelector<HTMLElement>(".copy-btn")?.click();
    await vi.waitFor(() => expect(copies).toEqual(["x = 1"]));
    msg = flux(msg, "Avant\n\n```py\nx = 1\ny = 2");
    etat.value = msg;
    await nextTick();
    racine.querySelector<HTMLElement>(".copy-btn")?.click();
    await vi.waitFor(() => expect(copies).toEqual(["x = 1", "x = 1\ny = 2"]));
    expect(clics.length).toBe(2);
    msg = flux(msg, "Avant\n\n```py\nx = 1\ny = 2\n```\n\nSuite");
    etat.value = msg;
    await nextTick();
    const fige = racine.children[1] as HTMLElement;
    const final = moteurMarkdown().renderMarkdown("```py\nx = 1\ny = 2\n```");
    expect(fige.innerHTML.trim()).toBe(final.trim());
    etat.value = { content: "Avant\n\n```py\nx = 1\ny = 2\n```\n\nSuite", isStreaming: false };
    await nextTick();
    const termine = hote.firstElementChild as HTMLElement;
    expect(termine.querySelector(".code-wrapper")?.outerHTML).toBe(
      fige.querySelector(".code-wrapper")?.outerHTML,
    );
  });

  it("flux : la fence active n'est pas colorée, elle l'est dès qu'elle est figée, puis le corps entier à la fin", async () => {
    await new Promise((r) => setTimeout(r, 60));
    const hl = createRequire(import.meta.url)("@highlightjs/cdn-assets/highlight.min.js");
    (window as unknown as { hljs?: unknown }).hljs = hl;
    const tranches: ((e: { timeRemaining(): number }) => void)[] = [];
    vi.stubGlobal("requestIdleCallback", (cb: (e: { timeRemaining(): number }) => void) => tranches.push(cb));
    const vider = (): void => {
      while (tranches.length) tranches.shift()?.({ timeRemaining: () => 50 });
    };
    try {
      let msg = flux({}, "Avant\n\n```py\nx = 1");
      const { hote, etat } = monter(msg);
      const racine = hote.firstElementChild as HTMLElement;
      vider();
      expect(racine.querySelector("[class^='hljs-']")).toBeNull();
      msg = flux(msg, "Avant\n\n```py\nx = 1\ny = 2");
      etat.value = msg;
      await nextTick();
      expect(tranches.length).toBe(0);
      msg = flux(msg, "Avant\n\n```py\nx = 1\ny = 2\n```\n\nSuite");
      etat.value = msg;
      await nextTick();
      expect(tranches.length).toBe(1);
      vider();
      const fige = racine.children[1] as HTMLElement;
      expect(fige.querySelectorAll(".hljs-number").length).toBe(2);
      expect(fige.querySelector("code")?.textContent).toBe("x = 1\ny = 2");
      msg = flux(msg, "Avant\n\n```py\nx = 1\ny = 2\n```\n\nSuite encore");
      etat.value = msg;
      await nextTick();
      expect(tranches.length).toBe(0);
      expect(racine.children[1]).toBe(fige);
      expect(fige.querySelectorAll(".hljs-number").length).toBe(2);
      etat.value = { content: "Avant\n\n```py\nx = 1\ny = 2\n```\n\nSuite encore", isStreaming: false };
      await nextTick();
      vider();
      vider();
      expect((hote.firstElementChild as HTMLElement).querySelectorAll(".hljs-number").length).toBe(2);
    } finally {
      delete (window as unknown as { hljs?: unknown }).hljs;
    }
  });

  it("rendu final : HTML complet, clic transmis, mutation de post-traitement conservée", async () => {
    const { hote, etat } = monter({ content: "# Titre\n\n```js\nx\n```", isStreaming: false });
    const racine = hote.firstElementChild as HTMLElement;
    expect(racine.hasAttribute("aria-busy")).toBe(false);
    expect(racine.querySelector("h1")?.textContent).toBe("Titre");
    racine.querySelector("pre")?.setAttribute("data-copier", "1");
    racine.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(clics.length).toBe(1);
    etat.value = { content: "# Titre\n\n```js\nx\n```", isStreaming: false };
    await nextTick();
    expect(racine.querySelector("pre")?.getAttribute("data-copier")).toBe("1");
  });

  it("narration de segment : classes du parent ajoutées à la racine", () => {
    const hote = monterRendu(() =>
      h(ContenuMarkdown, { class: "markdown-body--worklog mb-1.5", msg: { content: "Je lis *a.py*." } }),
    );
    const racine = hote.firstElementChild as HTMLElement;
    expect(racine.className.split(" ").sort()).toEqual(
      ["bg-transparent", "markdown-body", "markdown-body--worklog", "mb-1.5"].sort(),
    );
    expect(racine.querySelector("em")?.textContent).toBe("a.py");
  });

  it("displayContent prime et la recherche surligne", async () => {
    const { hote, q } = monter({ content: "brut", displayContent: "Bonjour le monde", isStreaming: false });
    expect(hote.textContent).toContain("Bonjour le monde");
    q.value = "monde";
    await nextTick();
    expect(hote.querySelector("mark.elpis-search-hl")?.textContent).toBe("monde");
  });

  it("aucune charge XSS n'atteint le DOM, partiel comme final", async () => {
    const charge =
      'x <img src=x onerror="alert(1)"> <svg onload="alert(1)"><script>alert(1)</script></svg> [a](javascript:alert(1))';
    const msg = flux({}, charge + "\n\n" + charge);
    const { hote, etat } = monter(msg);
    const verifier = () => {
      expect(hote.querySelector("script")).toBeNull();
      expect(hote.innerHTML).not.toMatch(/onerror|onload|javascript:/i);
    };
    verifier();
    etat.value = { content: charge, isStreaming: false };
    await nextTick();
    verifier();
  });
});

describe("ContenuMarkdown : fin du flux sans reconstruction", () => {
  const TEXTE =
    "Premier paragraphe.\n\n## Titre\n\n- a\n- b\n\n```py\nx = 1\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nDernier paragraphe";

  it("les nœuds des blocs figés sont les mêmes objets avant et après la fin, comme la racine", async () => {
    const msg = flux({}, TEXTE);
    const { hote, etat } = monter(msg);
    const racine = hote.firstElementChild as HTMLElement;
    const avant = [...racine.children];
    const pre = racine.querySelector("pre");
    expect(avant.length).toBeGreaterThan(4);
    expect(racine.getAttribute("aria-busy")).toBe("true");
    expect(racine.querySelector(".elpis-stream-caret")).not.toBeNull();
    etat.value = fin(msg, TEXTE + " fini.\n");
    await nextTick();
    expect(hote.firstElementChild).toBe(racine);
    const apres = [...racine.children];
    expect(apres.length).toBeGreaterThanOrEqual(avant.length);
    avant.forEach((n, i) => expect(apres[i], `bloc ${i}`).toBe(n));
    expect(racine.querySelector("pre")).toBe(pre);
    expect(racine.hasAttribute("aria-busy")).toBe(false);
    expect(racine.querySelector(".elpis-stream-caret")).toBeNull();
    expect(racine.textContent).toContain("Dernier paragraphe fini.");
    const corps = [...racine.children].map((c) => c.innerHTML).join("");
    expect(corps.replace(/>\s+</g, "><").trim()).toBe(
      moteurMarkdown()
        .renderMarkdown(TEXTE + " fini.\n")
        .replace(/>\s+</g, "><")
        .trim(),
    );
  });

  it("le texte final plus court ou différent garde les blocs de tête et affiche le texte final", async () => {
    const msg = flux({}, "Un.\n\nDeux.\n\nTrois en cours");
    const { hote, etat } = monter(msg);
    const racine = hote.firstElementChild as HTMLElement;
    const premier = racine.children[0];
    const final = "Un.\n\nDeux modifié.\n\nQuatre.\n";
    etat.value = fin(msg, final);
    await nextTick();
    expect(racine.children[0]).toBe(premier);
    expect(racine.textContent).toContain("Deux modifié.");
    expect(racine.textContent).not.toContain("Trois");
    expect(racine.textContent).toContain("Quatre.");
    expect(racine.hasAttribute("aria-busy")).toBe(false);
  });

  it("un message dont le texte ne correspond plus à ses blocs repasse au rendu complet", async () => {
    const msg = fin(flux({}, "Un.\n\nDeux."), "Un.\n\nDeux.");
    const { hote, etat } = monter(msg);
    expect(hote.firstElementChild?.children.length).toBe(2);
    etat.value = { ...msg, content: "Autre texte." };
    await nextTick();
    expect(hote.textContent).toBe("Autre texte.\n");
    expect(hote.firstElementChild?.children.length).toBe(1);
  });

  it("recherche : les blocs gardés sont surlignés sans être reconstruits", async () => {
    const msg = fin(flux({}, "Un monde.\n\nDeux mondes."), "Un monde.\n\nDeux mondes.");
    const { hote, q } = monter(msg);
    const racine = hote.firstElementChild as HTMLElement;
    const blocs = [...racine.children];
    q.value = "monde";
    await nextTick();
    expect(racine.querySelectorAll("mark.elpis-search-hl").length).toBe(2);
    expect([...racine.children]).toEqual(blocs);
    q.value = "";
    await nextTick();
    expect(racine.querySelector("mark")).toBeNull();
  });

  it("à la fin, les blocs spéciaux sont enrichis en place, sans toucher aux autres blocs", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>';
    const texte = "Avant.\n\n```svg\n" + svg + "\n```\n\nAprès";
    const msg = flux({}, texte);
    const { hote, etat } = monter(msg);
    const racine = hote.firstElementChild as HTMLElement;
    const avant = racine.children[0];
    expect(racine.querySelector(".svg-render")).toBeNull();
    etat.value = fin(msg, texte + ".\n");
    await nextTick();
    expect(racine.children[0]).toBe(avant);
    expect(racine.querySelector(".svg-render svg")).not.toBeNull();
    expect(hote.firstElementChild).toBe(racine);
  });

  it("une définition de lien qui arrive pendant le flux réécrit les blocs concernés", async () => {
    let msg = flux({}, "Voir [la doc][d].\n\nUn paragraphe.\n\nFin");
    const { hote, etat } = monter(msg);
    const racine = hote.firstElementChild as HTMLElement;
    expect(racine.querySelector("a")).toBeNull();
    msg = flux(msg, "Voir [la doc][d].\n\nUn paragraphe.\n\n[d]: https://exemple.test/doc\n\nFin");
    etat.value = msg;
    await nextTick();
    expect(racine.querySelector("a")?.getAttribute("href")).toBe("https://exemple.test/doc");
  });
});

describe("NarrationVivante", () => {
  it("texte brut échappé tant qu'aucun bloc, puis blocs figés et bloc actif", async () => {
    const etat = shallowRef<Record<string, unknown>>({
      _pendingPreContent: '<img src=x onerror="alert(1)"> brut',
    });
    const hote = monterRendu(() =>
      h(NarrationVivante, { msg: etat.value, onClickMarkdown: (e: MouseEvent) => clics.push(e) }),
    );
    const racine = hote.firstElementChild as HTMLElement;
    expect(racine.hasAttribute("data-live-narration")).toBe(true);
    expect(racine.getAttribute("aria-busy")).toBe("true");
    expect(racine.querySelector("img")).toBeNull();
    expect(racine.querySelector("span.whitespace-pre-wrap")?.textContent).toContain("<img");
    const m = moteurMarkdown();
    const r = m.avancerFlux("Je lis **a.py**.\n\nPuis", null);
    etat.value = { _ppBlocks: [...r.etat.blocs], _ppActiveHtml: r.actifHtml };
    await nextTick();
    expect(racine.querySelector("strong")?.textContent).toBe("a.py");
    expect(racine.textContent).toContain("Puis");
    expect(racine.querySelector(".elpis-stream-caret")).toBeNull();
    racine.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(clics.length).toBe(1);
  });
});
