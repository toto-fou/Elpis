// SPDX-License-Identifier: MIT
/** frontend/test/rag/renvois.test.ts — renvois [n] d'une réponse rendue : pastilles posées sur le DOM, jamais dans le code, les liens ni les blocs de code ; renvoi inconnu discret et sans lien ; mise à jour quand les sources arrivent. */
import { describe, expect, it } from "vitest";

import { pastilleDe, poserPastilles } from "../../src/features/rag/renvois";
import { source } from "./aides-sources";

function rendu(html: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "markdown-body";
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

const connues = new Map([
  [1, source(1)],
  [2, source(2)],
]);
const resoudre = (n: number) => connues.get(n) ?? null;

describe("pastilles de renvois", () => {
  it("[1] devient un bouton numéroté qui porte son libellé accessible", () => {
    const el = rendu("<p>Générez la demande [1] puis signez [2].</p>");
    expect(poserPastilles(el, resoudre)).toBe(2);
    const boutons = [...el.querySelectorAll<HTMLButtonElement>("button.rag-cite")];
    expect(boutons.map((b) => b.textContent)).toEqual(["1", "2"]);
    expect(boutons[0]?.getAttribute("aria-label")).toBe("Source 1 : procedure-vpn-ipsec-sites.docx, page 7");
    expect(boutons[0]?.getAttribute("aria-haspopup")).toBe("dialog");
    expect(el.textContent).toBe("Générez la demande 1 puis signez 2.");
  });

  it("une liste et une plage donnent une pastille par numéro", () => {
    const el = rendu("<p>Voir [1, 2] et [2-2].</p>");
    poserPastilles(el, resoudre);
    expect([...el.querySelectorAll("button.rag-cite")].map((b) => b.textContent)).toEqual(["1", "2", "2"]);
  });

  it("jamais dans le code, un bloc de code, un lien, un bouton ni une formule", () => {
    const el = rendu(
      '<p>Du texte [1].</p><p><code>tab[1]</code></p><pre><code>x = a[1]</code></pre><p><a href="https://exemple.fr">lien [1]</a></p><p><button>bouton [1]</button></p><span class="katex">[1]</span>',
    );
    expect(poserPastilles(el, resoudre)).toBe(1);
    expect(el.querySelectorAll("button.rag-cite")).toHaveLength(1);
    expect(el.querySelector("code")?.textContent).toBe("tab[1]");
    expect(el.querySelector("pre")?.textContent).toBe("x = a[1]");
    expect(el.querySelector("a")?.textContent).toBe("lien [1]");
    expect(el.querySelector(".katex")?.textContent).toBe("[1]");
  });

  it("un renvoi sans source est discret, sans lien ni bouton, avec son explication", () => {
    const el = rendu("<p>Un renvoi perdu [9].</p>");
    poserPastilles(el, resoudre);
    expect(el.querySelector("button")).toBeNull();
    const inconnu = el.querySelector<HTMLElement>(".rag-cite-inconnu");
    expect(inconnu?.textContent).toBe("[9]");
    expect(inconnu?.hasAttribute("data-rag-inconnu")).toBe(true);
    expect(inconnu?.title).toMatch(/aucun passage lu/);
    expect(pastilleDe(inconnu ?? null)).toBeNull();
  });

  it("un second passage ne double rien, et les sources qui arrivent après transforment un renvoi inconnu", () => {
    const el = rendu("<p>Réponse [3].</p>");
    const dynamique = new Map(connues);
    const r = (n: number) => dynamique.get(n) ?? null;
    poserPastilles(el, r);
    expect(el.querySelectorAll(".rag-cite-inconnu")).toHaveLength(1);
    expect(poserPastilles(el, r)).toBe(0);
    dynamique.set(3, source(3, { document: "notes.md", page: null, section: "Intro" }));
    poserPastilles(el, r);
    expect(el.querySelector(".rag-cite-inconnu")).toBeNull();
    const b = el.querySelector("button.rag-cite");
    expect(b?.textContent).toBe("3");
    expect(b?.getAttribute("aria-label")).toBe("Source 3 : notes.md, Intro");
    expect(el.querySelectorAll("button.rag-cite")).toHaveLength(1);
  });

  it("pastilleDe retrouve la pastille depuis un enfant", () => {
    const el = rendu("<p>[1]</p>");
    poserPastilles(el, resoudre);
    const b = el.querySelector<HTMLElement>("button.rag-cite");
    expect(pastilleDe(b)).toEqual({ n: 1, el: b });
    expect(pastilleDe(el.querySelector("p"))).toBeNull();
    expect(pastilleDe(null)).toBeNull();
  });
});
