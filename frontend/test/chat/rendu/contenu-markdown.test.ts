// SPDX-License-Identifier: MIT
/** frontend/test/chat/rendu/contenu-markdown.test.ts — composant ContenuMarkdown : blocs figés conservés pendant le flux, rendu final, recherche, purification. */
import { createApp, h, nextTick, shallowRef } from "vue";
import type { App, VNode } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import ContenuMarkdown from "../../../src/components/chat/ContenuMarkdown.vue";
import NarrationVivante from "../../../src/components/chat/NarrationVivante.vue";
import type { BlocRendu, MessageMarkdown } from "../../../src/components/chat/ContenuMarkdown.vue";
import { moteurMarkdown } from "../../../src/features/chat/rendu/instance";

let app: App | null = null;
const clics: MouseEvent[] = [];

afterEach(() => {
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

/** Reproduit le patch d'app-chat.js : blocs figés rendus une fois, bloc actif re-rendu. */
function flux(precedent: MessageMarkdown, texte: string): MessageMarkdown {
  const m = moteurMarkdown();
  const p = precedent as MessageMarkdown & { _s?: { scanPos: number; fence: boolean; blockStart: number } };
  const s = p._s ?? { scanPos: 0, fence: false, blockStart: 0 };
  const r = m.scanStreamBlocks(texte, s.scanPos, s.fence, s.blockStart);
  let blocs = p._mdBlocks ?? null;
  if (r.blocks.length) {
    const suite: BlocRendu[] = [...(blocs ?? [])];
    for (const b of r.blocks) suite.push({ i: suite.length, html: m.renderStreamBlock(b) });
    blocs = suite;
  }
  const actif = m.injecterCaret(m.renderStreamingActive(texte.slice(r.blockStart)));
  return {
    ...p,
    content: texte,
    isStreaming: true,
    _mdBlocks: blocs,
    _mdActiveHtml: actif,
    _s: r,
  } as MessageMarkdown;
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
    etat.value = {
      _ppBlocks: [{ i: 0, html: m.renderStreamBlock("Je lis **a.py**.") }],
      _ppActiveHtml: m.renderStreamingActive("Puis"),
    };
    await nextTick();
    expect(racine.querySelector("strong")?.textContent).toBe("a.py");
    expect(racine.textContent).toContain("Puis");
    expect(racine.querySelector(".elpis-stream-caret")).toBeNull();
    racine.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(clics.length).toBe(1);
  });
});
