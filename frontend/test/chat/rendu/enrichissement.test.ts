// SPDX-License-Identifier: MIT
/** frontend/test/chat/rendu/enrichissement.test.ts — passe d'enrichissement : blocs de code, SVG purifié, repli Mermaid, références de graphique, propriété du composant, clic, export. */
import { createApp, h, nextTick, shallowRef } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import ContenuMarkdown from "../../../src/components/chat/ContenuMarkdown.vue";

// Poste hors ligne : aucune bibliothèque chargée à la demande n'arrive, les replis s'affichent.
vi.mock("../../../src/platform/vendor", () => ({
  ensureVendor: () => Promise.reject(new Error("Chargement impossible")),
}));
import type { MessageMarkdown } from "../../../src/components/chat/ContenuMarkdown.vue";
import { exporterConversation } from "../../../src/features/chat/export";
import {
  ATTRIBUT_COMPOSANT,
  ATTRIBUT_SANS_GRAPHIQUES,
  clicMarkdown,
  configurerEnrichissement,
  enrichirBlocs,
} from "../../../src/features/chat/rendu/enrichissement";
import DOMPurify from "dompurify";

import { sanitizeSvg } from "../../../src/features/chat/rendu/svg";
import type { PurifySvg } from "../../../src/features/chat/rendu/svg";

let app: App | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

function corps(html: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "markdown-body";
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

describe("enrichirBlocs", () => {
  it("bloc de code : en-tête de langue, Copier, Aperçu HTML ; idempotent", () => {
    const el = corps(
      '<pre><code class="language-html">&lt;b&gt;x&lt;/b&gt;</code></pre><pre><code>y</code></pre>',
    );
    enrichirBlocs(el);
    enrichirBlocs(el);
    const wrappers = el.querySelectorAll(".code-wrapper");
    expect(wrappers.length).toBe(2);
    expect(wrappers[0]?.querySelector(".code-header span")?.textContent).toBe("HTML");
    expect(wrappers[1]?.querySelector(".code-header span")?.textContent).toBe("CODE");
    expect(wrappers[0]?.querySelectorAll(".code-actions button").length).toBe(2);
    expect(el.querySelectorAll("pre[data-cb-done]").length).toBe(2);
    const apercu = wrappers[0]?.querySelector<HTMLButtonElement>(".code-actions button");
    apercu?.click();
    const iframe = wrappers[0]?.querySelector("iframe");
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(wrappers[0]?.querySelector<HTMLElement>("pre")?.style.display).toBe("none");
  });

  it("SVG : charge active retirée, sinon repli en code", () => {
    const el = corps(
      '<pre><code class="language-svg">&lt;svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;rect/&gt;&lt;/svg&gt;</code></pre>',
    );
    enrichirBlocs(el);
    const rendu = el.querySelector(".svg-render");
    expect(rendu).not.toBeNull();
    expect(rendu?.querySelector("script")).toBeNull();
    expect(rendu?.innerHTML).not.toMatch(/onload/i);
    expect(sanitizeSvg("<div>x</div>", DOMPurify as unknown as PurifySvg)).toBeNull();
    expect(sanitizeSvg("<svg></svg>", null)).toBeNull();
  });

  it("Mermaid dont le chargement échoue : bloc de code étiqueté", async () => {
    const el = corps('<pre><code class="language-mermaid">graph TD; A--&gt;B</code></pre>');
    enrichirBlocs(el);
    await vi.waitFor(() => expect(el.querySelector(".code-header span")?.textContent).toBe("MERMAID"));
  });

  it("référence de graphique : chargée par le client branché, erreur affichée sans moteur", async () => {
    const appels: string[] = [];
    configurerEnrichissement({
      fetch: (url) => {
        appels.push(url);
        return Promise.resolve(new Response(JSON.stringify({ ok: false, detail: "absent" })));
      },
      chatCourant: () => "c1",
    });
    const el = corps("<p>Voir !0123456789ab ici</p>");
    enrichirBlocs(el);
    expect(appels).toEqual(["/api/charts/0123456789ab?chat_id=c1"]);
    await vi.waitFor(() => expect(el.querySelector(".chart-render-error")).not.toBeNull());
    expect(el.textContent).toContain("absent");
  });

  it("hors réponse finale (zone sans graphiques) : une mention à la place, aucun chargement", () => {
    const appels: string[] = [];
    configurerEnrichissement({
      fetch: (url) => {
        appels.push(url);
        return Promise.resolve(new Response("{}"));
      },
      chatCourant: () => "c1",
    });
    const zone = document.createElement("div");
    zone.setAttribute(ATTRIBUT_SANS_GRAPHIQUES, "");
    zone.innerHTML =
      '<div class="markdown-body"><p>Voir !0123456789ab ici</p><p><code>!0123456789ac</code></p>' +
      '<pre><code class="language-chart-ref">!0123456789ad</code></pre></div>';
    document.body.appendChild(zone);
    enrichirBlocs(zone);
    expect(appels).toEqual([]);
    expect(zone.querySelector(".chart-ref-holder, .chart-render, .chart-render-error")).toBeNull();
    expect([...zone.querySelectorAll("[data-renvoi-graphique]")].map((n) => n.textContent)).toEqual([
      "graphique dans la réponse",
      "graphique dans la réponse",
      "graphique dans la réponse",
    ]);
    expect(zone.textContent).not.toContain("0123456789a");
  });

  it("passe historique : les corps possédés par un composant sont sautés", () => {
    const hote = document.createElement("div");
    hote.innerHTML =
      '<div class="markdown-body" ' +
      ATTRIBUT_COMPOSANT +
      '><pre><code>a</code></pre></div><div class="markdown-body"><pre><code>b</code></pre></div>';
    document.body.appendChild(hote);
    enrichirBlocs(hote, true);
    expect(hote.querySelectorAll(".code-wrapper").length).toBe(1);
    expect(hote.querySelector("[" + ATTRIBUT_COMPOSANT + "] .code-wrapper")).toBeNull();
  });
});

describe("ContenuMarkdown enrichit son propre corps", () => {
  it("après mise à jour (fin du flux) seulement, et garde l'enrichissement à HTML égal", async () => {
    const etat = shallowRef<MessageMarkdown>({ content: "```py\nx\n```", isStreaming: true, _mdBlocks: [] });
    const hote = document.createElement("div");
    document.body.appendChild(hote);
    app = createApp({ render: () => h(ContenuMarkdown, { msg: etat.value }) });
    app.mount(hote);
    expect(hote.querySelector(".code-wrapper")).toBeNull();
    etat.value = { content: "```py\nx\n```", isStreaming: false };
    await nextTick();
    const wrapper = hote.querySelector(".code-wrapper");
    expect(wrapper).not.toBeNull();
    expect(hote.firstElementChild?.hasAttribute(ATTRIBUT_COMPOSANT)).toBe(true);
    etat.value = { content: "```py\nx\n```", isStreaming: false };
    await nextTick();
    expect(hote.querySelector(".code-wrapper")).toBe(wrapper);
  });
});

describe("clic et export", () => {
  it("chemin cliquable vers l'éditeur, ancre interne vers son titre", () => {
    const el = corps(
      '<p><code class="elpis-path-link">src/a.py:12</code> <a href="#mon-titre">lien</a></p><h2>Mon titre</h2>',
    );
    const ouverts: unknown[] = [];
    const actions = {
      ouvrirDansEditeur: (p: string, l?: number | null) => ouverts.push([p, l]),
      analyserChemin: (t: string) => ({ path: t.split(":")[0] ?? "", line: Number(t.split(":")[1]) }),
    };
    const code = el.querySelector("code") as HTMLElement;
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "target", { value: code });
    clicMarkdown(ev, actions);
    expect(ouverts).toEqual([["src/a.py", 12]]);
    const h2 = el.querySelector("h2") as HTMLElement;
    const vu = vi.fn();
    h2.scrollIntoView = vu;
    const ev2 = new MouseEvent("click", { bubbles: true, cancelable: true });
    Object.defineProperty(ev2, "target", { value: el.querySelector("a") });
    clicMarkdown(ev2, actions);
    expect(ev2.defaultPrevented).toBe(true);
    expect(vu).toHaveBeenCalled();
  });

  it("export Markdown : un fichier nommé d'après le chat", () => {
    const blobs: Blob[] = [];
    const creer = vi.spyOn(URL, "createObjectURL").mockImplementation((b) => {
      blobs.push(b as Blob);
      return "blob:x";
    });
    const noms: string[] = [];
    const clic = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      noms.push(this.download);
    });
    exporterConversation("md", {
      messages: [
        { role: "user", content: "Bonjour" },
        { role: "assistant", content: "Salut" },
      ],
      titre: "Essai",
      chatId: "c9",
      utilisateur: "alice",
      assistant: "Elpis",
    });
    expect(noms).toEqual(["chat_c9.md"]);
    expect(blobs[0]?.type).toBe("text/markdown");
    creer.mockRestore();
    clic.mockRestore();
  });
});
